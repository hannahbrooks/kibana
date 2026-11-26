/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expect } from '@kbn/scout-security/api';
import type { ApiClientFixture, ApiServicesFixture, EsClient } from '@kbn/scout-security';
import type { ToolingLog } from '@kbn/tooling-log';
import { ExecutionStatus, type WorkflowExecutionDto } from '@kbn/workflows';
import {
  APPLIED_TAG,
  apiTest,
  cancelExecution,
  createWorkerServiceAccount,
  decidePendingProposal,
  deleteServiceAccount,
  deleteSpaceAlertsIndex,
  enableAlertZeroInSpace,
  FP_ALERT_COUNT,
  pollFor,
  readAlertTags,
  readBacktest,
  readRule,
  readRuleExceptionItems,
  runCleanupSteps,
  seedRuleWithFalsePositives,
  setRuleTuningWorker,
  tags,
  waitForExecution,
  waitForInvestigation,
  waitForReviewExecution,
  type RuleState,
  type SeededRule,
} from '../../../scout_alertzero/api/fixtures';
import {
  enableCcm,
  pinModelToEndpoint,
  readDiagnosis,
  resolveRealModel,
  type Diagnosis,
} from '../fixtures/real_llm';

const EIS_CCM_API_KEY_ENV = 'KIBANA_EIS_CCM_API_KEY';

/** Budget of each wait for the review: its start, its investigation and its end. */
const STEP_TIMEOUT_MS = 180_000;
/** A real model takes minutes to diagnose, and the proposal only exists after that. */
const DIAGNOSIS_TIMEOUT_MS = 15 * 60_000;
/**
 * Covers every wait at its full budget, so a slow run fails in a wait and still cleans up: the
 * alerts alias (2 minutes), three review steps, up to two decisions, the alert tags (1 minute)
 * and the cleanup.
 */
const TEST_TIMEOUT_MS = 120_000 + 3 * STEP_TIMEOUT_MS + 2 * DIAGNOSIS_TIMEOUT_MS + 60_000 + 180_000;

const RUN = Date.now();

const OVERBROAD_QUERY = 'process.name:*';

interface CaseFixtures {
  apiClient: ApiClientFixture;
  apiServices: ApiServicesFixture;
  esClient: EsClient;
  log: ToolingLog;
}

interface CaseResult {
  review: WorkflowExecutionDto;
  diagnosis: Diagnosis;
  rule: SeededRule;
  /** The rule as the detection engine has it after the review ended. */
  ruleAfter: RuleState;
  space: { apiClient: ApiClientFixture; headers: Record<string, string>; spaceId: string };
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
 *   node scripts/discover_eis_models.js
 *   node scripts/scout start-server --arch stateful --domain classic --serverConfigSet alertzero_real_llm
 *   node scripts/playwright test --config <this folder>/playwright.config.ts --project local
 */
apiTest.describe('Rule Tuning review - real model', { tag: [...tags.stateful.classic] }, () => {
  let adminHeaders: Record<string, string>;
  let inferenceId: string;

  /**
   * Sets up a space with one rule, runs the worker in it, decides the review's proposals in
   * order, and hands the outcome to `check`. Removes everything it created, whatever `check`
   * does.
   */
  const runReviewCase = async (
    { apiClient, apiServices, esClient, log }: CaseFixtures,
    {
      name,
      autonomy,
      decisions,
    }: {
      name: string;
      autonomy: 'manual' | 'assisted';
      decisions: Array<'approve' | 'dismiss'>;
    },
    check: (result: CaseResult) => Promise<void>
  ): Promise<void> => {
    const spaceId = `scout-tuning-real-llm-${RUN}-${name}`;
    const space = { apiClient, headers: adminHeaders, spaceId };
    let serviceAccountId: string | undefined;
    let reviewId: string | undefined;
    let eventsIndex: string | undefined;

    try {
      await apiServices.spaces.create({ id: spaceId, name: spaceId });
      await enableAlertZeroInSpace(space);

      await pinModelToEndpoint({ ...space, inferenceId });
      serviceAccountId = await createWorkerServiceAccount(space);
      const rule = await seedRuleWithFalsePositives({
        ...space,
        esClient,
        name: `${spaceId}-rule`,
        query: OVERBROAD_QUERY,
      });
      ({ eventsIndex } = rule);

      // Enabling the worker starts its first run, which finds the seeded rule.
      await setRuleTuningWorker({
        ...space,
        enabled: true,
        settings: { serviceAccountId, autonomy },
      });
      reviewId = await waitForReviewExecution({ ...space, timeoutMs: STEP_TIMEOUT_MS });
      const conversationId = await waitForInvestigation({
        ...space,
        executionId: reviewId,
        timeoutMs: STEP_TIMEOUT_MS,
      });
      const decidedIds: string[] = [];
      for (const decision of decisions) {
        decidedIds.push(
          await decidePendingProposal({
            ...space,
            conversationId,
            decision,
            decidedIds,
            timeoutMs: DIAGNOSIS_TIMEOUT_MS,
          })
        );
      }
      const review = await waitForExecution(
        apiClient,
        adminHeaders,
        reviewId,
        STEP_TIMEOUT_MS,
        spaceId
      );

      expect(review.status, JSON.stringify(review.error)).toBe(ExecutionStatus.COMPLETED);
      const diagnosis = readDiagnosis(review);
      log.info(
        `The model proposed change type ${diagnosis.changeType}. Backtest: ${JSON.stringify(
          readBacktest(review)
        )}`
      );
      const ruleAfter = await readRule({ ...space, id: rule.id });
      await check({ review, diagnosis, rule, ruleAfter, space });
    } finally {
      await runCleanupSteps([
        {
          name: 'cancel the review',
          run: async () => {
            if (reviewId) await cancelExecution({ ...space, executionId: reviewId });
          },
        },
        {
          name: 'disable the rule tuning worker',
          run: () => setRuleTuningWorker({ ...space, enabled: false }),
        },
        {
          name: 'delete the worker service account',
          run: async () => {
            if (serviceAccountId) {
              await deleteServiceAccount({ apiClient, headers: adminHeaders, serviceAccountId });
            }
          },
        },
        { name: `delete space ${spaceId}`, run: () => apiServices.spaces.delete(spaceId) },
        {
          name: 'delete the space alerts index',
          run: () => deleteSpaceAlertsIndex(esClient, spaceId),
        },
        {
          name: 'delete the source events',
          run: async () => {
            if (eventsIndex) {
              await esClient.indices.deleteDataStream({ name: eventsIndex }, { ignore: [404] });
            }
          },
        },
      ]);
    }
  };

  /** Waits until every alert of the rule carries `tag`, and returns the tags of each alert. */
  const waitForAlertTag = (esClient: EsClient, spaceId: string, ruleId: string, tag: string) =>
    pollFor(
      `every alert to carry ${tag}`,
      async () => {
        const found = await readAlertTags({ esClient, spaceId, ruleId });
        return found.length > 0 && found.every((alertTags) => alertTags.includes(tag))
          ? found
          : undefined;
      },
      { timeoutMs: 60_000 }
    );

  apiTest.beforeAll(async ({ samlAuth, esClient }) => {
    const apiKey = process.env[EIS_CCM_API_KEY_ENV];
    if (!apiKey) {
      throw new Error(`${EIS_CCM_API_KEY_ENV} is not set. See the comment on this test.`);
    }
    ({ inferenceId } = resolveRealModel());
    await enableCcm(esClient, apiKey);
    const { cookieHeader } = await samlAuth.asInteractiveUser('admin');
    adminHeaders = { ...cookieHeader, 'kbn-xsrf': 'true', 'x-elastic-internal-origin': 'kibana' };
  });

  apiTest(
    'assisted: approving the proposal applies the change the model chose and tags the alerts applied',
    async ({ apiClient, apiServices, esClient, log }) => {
      apiTest.setTimeout(TEST_TIMEOUT_MS);
      await runReviewCase(
        { apiClient, apiServices, esClient, log },
        { name: 'assisted-approve', autonomy: 'assisted', decisions: ['approve'] },
        async ({ diagnosis: { changeType, proposal }, rule, ruleAfter, space }) => {
          // The change types the review can apply to a query rule. Each lands on the rule in its
          // own way; a manual proposal has no action, so the rule keeps its revision.
          const landed: Record<string, () => boolean | Promise<boolean>> = {
            query: () => ruleAfter.query === proposal.proposed_query,
            exception: async () =>
              (await readRuleExceptionItems({ ...space, rule: ruleAfter })).length > 0,
            risk_score: () => ruleAfter.risk_score === proposal.proposed_risk_score,
            schedule: () => ruleAfter.interval === proposal.proposed_interval,
            manual: () => true,
          };
          const hasLanded: (() => boolean | Promise<boolean>) | undefined = landed[changeType];
          expect(
            hasLanded,
            `The model proposed an unexpected change type: ${changeType}`
          ).toBeDefined();
          expect(await hasLanded?.(), `The ${changeType} change did not land on the rule`).toBe(
            true
          );
          // An applied change is saved as one new rule version.
          expect(ruleAfter.revision).toBe(rule.revision + (changeType === 'manual' ? 0 : 1));
          const alertTags = await waitForAlertTag(
            esClient,
            space.spaceId,
            rule.ruleId,
            changeType === 'manual' ? 'detection-watch:tuning-acknowledged' : APPLIED_TAG
          );
          expect(alertTags).toHaveLength(FP_ALERT_COUNT);
        }
      );
    }
  );
});
