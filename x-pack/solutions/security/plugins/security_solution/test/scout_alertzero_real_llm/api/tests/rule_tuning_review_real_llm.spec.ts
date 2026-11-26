/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { apiTest, tags } from '../../../scout_alertzero/api/fixtures';

/**
 * Sanity check of the rule tuning review on a real model: the worker finds a noisy rule, the
 * review diagnoses it on an EIS model, and approving the proposal changes the rule. Unlike
 * `scout_alertzero/api/tests/rule_tuning_review_e2e.spec.ts`, which scripts the model, it checks
 * that the flow works, not what the model proposed.
 *
 * Runs locally only, and is excluded from CI in `.buildkite/scout_ci_config.yml`:
 *   export KIBANA_EIS_CCM_API_KEY="$(vault read -field key secret/kibana-issues/dev/inference/kibana-eis-ccm)"
 *   node scripts/discover_eis_models.js
 *   node scripts/scout start-server --arch stateful --domain classic --serverConfigSet alertzero_real_llm
 *   node scripts/playwright test --config <this folder>/playwright.config.ts --project local
 */
apiTest.describe('Rule Tuning review - real model', { tag: [...tags.stateful.classic] }, () => {
  // TODO:
  // 1. Enable CCM on the Elasticsearch cluster with KIBANA_EIS_CCM_API_KEY.
  // 2. Create a space and a worker service account, and seed a rule, as `runReviewCase` does.
  // 3. Pin the AlertZero features to the preconfigured `eis-<model id>` connector.
  // 4. Enable the worker in assisted mode, approve the proposal, and check the rule and alerts.
  apiTest.fixme('assisted: the worker reviews a noisy rule on a real model', async () => {});
});
