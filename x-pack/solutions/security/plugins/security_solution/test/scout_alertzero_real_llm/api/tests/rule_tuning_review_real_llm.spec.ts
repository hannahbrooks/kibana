/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expect } from '@kbn/scout-security/api';
import type { EsClient } from '@kbn/scout-security';
import {
  APPLIED_TAG,
  apiTest,
  FP_ALERT_COUNT,
  pinModelToEndpoint,
  readBacktest,
  readRuleExceptionItems,
  runReviewCase,
  STEP_TIMEOUT_MS,
  tags,
  waitForAlertTag,
  type ReviewCaseFixtures,
  type ReviewCaseResult,
} from '../../../scout_alertzero/api/fixtures';
import {
  enableCcm,
  readDiagnosis,
  REAL_LLM_INFERENCE_ID,
  type Diagnosis,
} from '../fixtures/real_llm';

const EIS_CCM_API_KEY_ENV = 'KIBANA_EIS_CCM_API_KEY';

/** A real model takes minutes to diagnose, and the proposal only exists after that. */
const DIAGNOSIS_TIMEOUT_MS = 15 * 60_000;
/**
 * Covers every wait at its full budget, so a slow run fails in a wait and still cleans up: the
 * alerts alias (2 minutes), three review steps, up to two decisions, the alert tags (1 minute)
 * and the cleanup.
 */
const TEST_TIMEOUT_MS = 120_000 + 3 * STEP_TIMEOUT_MS + 2 * DIAGNOSIS_TIMEOUT_MS + 60_000 + 180_000;

const OVERBROAD_QUERY = 'process.name:*';

interface CaseResult extends ReviewCaseResult {
  diagnosis: Diagnosis;
}

/**
 * Sanity check of the managed rule tuning review on a real model: the worker finds a rule with
 * closed false positives, the review diagnoses it on an EIS model, and the test decides the
 * proposal the way an analyst does. Unlike `scout_alertzero/api/tests/rule_tuning_review_e2e`,
 * the model is real, so the tests check that the flow works for whatever change it proposes, not
 * which change that is.
 *
 * Local only, and excluded from CI in `.buildkite/scout_ci_config.yml`:
 *   export KIBANA_EIS_CCM_API_KEY="$(vault read -field key secret/kibana-issues/dev/inference/kibana-eis-ccm)"
 *   node scripts/scout start-server --arch stateful --domain classic --serverConfigSet alertzero_real_llm
 *   node scripts/playwright test --config <this folder>/playwright.config.ts --project local
 */
apiTest.describe('Rule Tuning review - real model', { tag: [...tags.stateful.classic] }, () => {
  let adminHeaders: Record<string, string>;

  /** `runReviewCase` on the real model, with the diagnosis of the review handed to `check`. */
  const runRealModelCase = (
    fixtures: ReviewCaseFixtures,
    {
      name,
      autonomy,
      decisions,
    }: { name: string; autonomy: 'manual' | 'assisted'; decisions: Array<'approve' | 'dismiss'> },
    check: (result: CaseResult) => Promise<void>
  ): Promise<void> =>
    runReviewCase(
      fixtures,
      {
        name: `real-${name}`,
        adminHeaders,
        query: OVERBROAD_QUERY,
        autonomy,
        decisions,
        decisionTimeoutMs: DIAGNOSIS_TIMEOUT_MS,
        setUpModel: async (space) => {
          await pinModelToEndpoint({ ...space, endpointId: REAL_LLM_INFERENCE_ID });
          return undefined;
        },
      },
      async (result) => {
        const diagnosis = readDiagnosis(result.review);
        fixtures.log.info(
          `The model proposed change type ${diagnosis.changeType}. Backtest: ${JSON.stringify(
            readBacktest(result.review)
          )}`
        );
        await check({ ...result, diagnosis });
      }
    );

  apiTest.beforeAll(async ({ samlAuth, esClient }) => {
    const apiKey = process.env[EIS_CCM_API_KEY_ENV];
    if (!apiKey) {
      throw new Error(`${EIS_CCM_API_KEY_ENV} is not set. See the comment on this test.`);
    }
    await enableCcm(esClient, apiKey, REAL_LLM_INFERENCE_ID);
    const { cookieHeader } = await samlAuth.asInteractiveUser('admin');
    adminHeaders = { ...cookieHeader, 'kbn-xsrf': 'true', 'x-elastic-internal-origin': 'kibana' };
  });

  /**
   * The change types the review can apply to a query rule each land on the rule in their own way.
   * A manual proposal has no action, so the rule keeps its revision.
   */
  const expectChangeApplied = async (
    esClient: EsClient,
    { diagnosis: { changeType, proposal }, rule, ruleAfter, space }: CaseResult
  ): Promise<void> => {
    const landed: Record<string, () => boolean | Promise<boolean>> = {
      query: () => ruleAfter.query === proposal.proposed_query,
      exception: async () =>
        (await readRuleExceptionItems({ ...space, rule: ruleAfter })).length > 0,
      risk_score: () => ruleAfter.risk_score === proposal.proposed_risk_score,
      schedule: () => ruleAfter.interval === proposal.proposed_interval,
      manual: () => true,
    };
    const hasLanded: (() => boolean | Promise<boolean>) | undefined = landed[changeType];
    expect(hasLanded, `The model proposed an unexpected change type: ${changeType}`).toBeDefined();
    expect(await hasLanded?.(), `The ${changeType} change did not land on the rule`).toBe(true);
    // An applied change is saved as one new rule version.
    expect(ruleAfter.revision).toBe(rule.revision + (changeType === 'manual' ? 0 : 1));
    const alertTags = await waitForAlertTag(
      esClient,
      space.spaceId,
      rule.ruleId,
      changeType === 'manual' ? 'detection-watch:tuning-acknowledged' : APPLIED_TAG
    );
    expect(alertTags).toHaveLength(FP_ALERT_COUNT);
  };

  apiTest(
    'assisted: approving the proposal applies the change the model chose and tags the alerts applied',
    async ({ apiClient, apiServices, esClient, samlAuth, log }) => {
      apiTest.setTimeout(TEST_TIMEOUT_MS);
      await runRealModelCase(
        { apiClient, apiServices, esClient, samlAuth, log },
        { name: 'assisted-approve', autonomy: 'assisted', decisions: ['approve'] },
        (result) => expectChangeApplied(esClient, result)
      );
    }
  );

  apiTest(
    'manual: approving the entry gate and the proposal applies the change the model chose and tags the alerts applied',
    async ({ apiClient, apiServices, esClient, samlAuth, log }) => {
      apiTest.setTimeout(TEST_TIMEOUT_MS);
      await runRealModelCase(
        { apiClient, apiServices, esClient, samlAuth, log },
        { name: 'manual-approve', autonomy: 'manual', decisions: ['approve', 'approve'] },
        (result) => expectChangeApplied(esClient, result)
      );
    }
  );
});
