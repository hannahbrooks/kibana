/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ScoutServerConfig } from '../../../../../types';
import { defaultConfig } from '../../default/stateful/base.config';
import { getAgentBuilderSmokeEisModels } from '../../agent_builder_smoke/eis_models';

// Elastic Inference Service QA base URL (Elasticsearch Cloud Connected Mode).
const EIS_QA_URL = 'https://inference.eu-west-1.aws.svc.qa.elastic.cloud';

/** A preconfigured connector for each EIS model that `target/eis_models.json` lists. */
const buildEisPreconfiguredConnectors = (): Record<string, unknown> =>
  Object.fromEntries(
    getAgentBuilderSmokeEisModels().map(({ modelId, inferenceId }) => [
      `eis-${modelId}`,
      {
        name: `EIS ${modelId}`,
        actionTypeId: '.inference',
        exposeConfig: true,
        config: { provider: 'elastic', taskType: 'chat_completion', inferenceId },
        secrets: {},
      },
    ])
  );

/**
 * Scout server config for tests that run the AlertZero workers against a real model: the
 * `alertzero` flags, plus the live EIS setup of `agent_builder_smoke`.
 *
 * Needs `target/eis_models.json` (`node scripts/discover_eis_models.js`) and, in the test, the
 * EIS CCM key in `KIBANA_EIS_CCM_API_KEY`.
 *
 * Usage:
 *   node scripts/scout.js start-server --arch stateful --domain classic --serverConfigSet alertzero_real_llm
 */
export const servers: ScoutServerConfig = {
  ...defaultConfig,
  esTestCluster: {
    ...defaultConfig.esTestCluster,
    serverArgs: [
      ...defaultConfig.esTestCluster.serverArgs,
      `xpack.inference.elastic.url=${EIS_QA_URL}`,
    ],
  },
  kbnTestServer: {
    ...defaultConfig.kbnTestServer,
    serverArgs: [
      ...defaultConfig.kbnTestServer.serverArgs,
      // The same two flags as the `alertzero` config set.
      '--xpack.security.serviceAccounts.enabled=true',
      '--server.restrictInternalApis=true',
      `--xpack.actions.preconfigured=${JSON.stringify(buildEisPreconfiguredConnectors())}`,
    ],
  },
};
