/**
 * Protocol dispatch.
 *
 * Everything the engine knows about a vendor's wire format lives behind this
 * one function, which is why adding a provider is mostly a data edit in
 * config.js rather than a code change.
 */

import { callOpenAI } from './openai.js';
import { callAnthropic } from './anthropic.js';
import { callGemini } from './gemini.js';

export const PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generate', 'azure-openai'];

export async function callProvider(opts) {
  const { protocol } = opts;

  if (protocol === 'anthropic-messages') return callAnthropic(opts);

  if (protocol === 'gemini-generate') return callGemini(opts);

  if (protocol === 'azure-openai') {
    const apiVersion = opts.apiVersion || '2024-10-21';
    const deployment = encodeURIComponent(opts.model);
    return callOpenAI({
      ...opts,
      path: `/openai/deployments/${deployment}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
      authHeader: 'api-key',
      authPrefix: '',
    });
  }

  // 'openai-chat' and 'openai-responses' both go through the chat adapter;
  // the Responses API is intentionally not implemented yet — see README.
  return callOpenAI(opts);
}
