/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EsClient } from '@kbn/scout-security';
import type { JsonObject } from '@kbn/utility-types';
import type { WorkflowExecutionDto } from '@kbn/workflows';
import { pollFor } from '../../../scout_alertzero/api/fixtures';
import { findStepOutputObject } from '../../../scout_alertzero/api/fixtures/rule_tuning/common';

/** The EIS endpoint to test: `ALERTZERO_REAL_LLM_ENDPOINT`, or Claude Sonnet 5.5. */
export const REAL_LLM_INFERENCE_ID =
  process.env.ALERTZERO_REAL_LLM_ENDPOINT ?? '.anthropic-claude-5.5-sonnet-chat_completion';

/** Enables Cloud Connected Mode on Elasticsearch and waits until the endpoint to test exists. */
export const enableCcm = async (
  esClient: EsClient,
  apiKey: string,
  inferenceId: string
): Promise<void> => {
  await esClient.transport.request({
    method: 'PUT',
    path: '/_inference/_ccm',
    body: { api_key: apiKey },
  });
  await pollFor(
    `the EIS endpoint ${inferenceId}`,
    async () => {
      const { endpoints } = await esClient.inference.get({ inference_id: '_all' });
      return endpoints.some(({ inference_id: id }) => id === inferenceId) ? true : undefined;
    },
    { timeoutMs: 60_000, intervalMs: 3_000 }
  );
};

export interface Diagnosis {
  changeType: string;
  proposal: JsonObject;
}

/** What `diagnose_rule` proposed, read from the review's step output. */
export const readDiagnosis = (review: WorkflowExecutionDto): Diagnosis => {
  const proposal = findStepOutputObject(review, 'diagnose_rule')?.structured_output;
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) {
    throw new Error('The review has no diagnosis output');
  }
  const { change_type: changeType } = proposal;
  if (typeof changeType !== 'string') {
    throw new Error('The diagnosis has no change_type');
  }
  return { changeType, proposal };
};
