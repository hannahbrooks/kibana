/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  ALERTZERO_BALANCED_INFERENCE_FEATURE_ID,
  ALERTZERO_INFERENCE_PARENT_FEATURE_ID,
} from '@kbn/alertzero-common';
import type { EsClient } from '@kbn/scout-security';
import type { JsonObject } from '@kbn/utility-types';
import type { WorkflowExecutionDto } from '@kbn/workflows';
import { pollFor, spaceUrl } from '../../../scout_alertzero/api/fixtures';
import {
  expectStatus,
  findStepOutputObject,
  INTERNAL_V1_HEADERS,
  type RuleTuningSpaceArgs,
} from '../../../scout_alertzero/api/fixtures/rule_tuning/common';

const SEARCH_INFERENCE_SETTINGS_PATH = 'internal/search_inference_endpoints/settings';

interface InferenceSettings {
  data?: { features?: Array<{ feature_id: string }> };
}

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

/** Points the space's AlertZero models at an inference endpoint. */
export const pinModelToEndpoint = async ({
  apiClient,
  headers,
  spaceId,
  inferenceId,
}: RuleTuningSpaceArgs & { inferenceId: string }): Promise<void> => {
  const settingsUrl = spaceUrl(SEARCH_INFERENCE_SETTINGS_PATH, spaceId);
  const current = await apiClient.get<InferenceSettings>(settingsUrl, {
    headers: { ...headers, ...INTERNAL_V1_HEADERS },
    responseType: 'json',
  });
  expectStatus('Read the inference settings', current);
  const pinned = new Set<string>([
    ALERTZERO_INFERENCE_PARENT_FEATURE_ID,
    ALERTZERO_BALANCED_INFERENCE_FEATURE_ID,
  ]);
  const features = (current.body.data?.features ?? []).filter(
    ({ feature_id: featureId }) => !pinned.has(featureId)
  );
  const put = await apiClient.put(settingsUrl, {
    headers: { ...headers, ...INTERNAL_V1_HEADERS },
    responseType: 'json',
    body: {
      features: [
        ...features,
        ...[...pinned].map((featureId) => ({
          feature_id: featureId,
          endpoints: [{ id: inferenceId }],
        })),
      ],
    },
  });
  expectStatus('Pin the AlertZero features to the model', put);
};
