/**
 * Anthropic Messages API.
 *
 * Notes that matter for this tool:
 *  - Prompt caching is strictly opt-in via `cache_control` markers. We never
 *    emit them, so every request is a guaranteed full-price cache miss. That is
 *    the one vendor where "avoid the cache" needs no effort at all.
 *  - `thinking` tokens are billed as *output* and count against max_tokens, so
 *    turning thinking on is pure profit for a burn tool — but the budget must be
 *    strictly smaller than max_tokens, hence the clamping below.
 *  - Recent Claude models reject non-default temperature/top_p/top_k, so we
 *    simply do not send sampling parameters.
 */

import { postJson, readSse, joinUrl, ApiError, emptyUsage, finalizeUsage } from './http.js';

function buildContent(payload, images) {
  const blocks = [];
  for (const img of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: img.base64 },
    });
  }
  blocks.push({ type: 'text', text: payload.filler + payload.instruction });
  return blocks;
}

export async function callAnthropic({
  baseUrl,
  apiKey,
  model,
  payload,
  images = [],
  maxOutput,
  thinkingBudget = 0,
  signal,
  timeoutMs,
  headers = {},
}) {
  const url = joinUrl(baseUrl, '/v1/messages');
  const messages = [{ role: 'user', content: buildContent(payload, images) }];

  const variants = [];
  if (thinkingBudget > 1024) {
    variants.push({
      model,
      max_tokens: maxOutput,
      system: payload.system,
      messages,
      thinking: { type: 'enabled', budget_tokens: Math.min(thinkingBudget, maxOutput - 1024) },
      stream: true,
    });
  }
  variants.push({ model, max_tokens: maxOutput, system: payload.system, messages, stream: true });
  variants.push({ model, max_tokens: maxOutput, system: payload.system, messages, stream: false });

  let lastErr;
  for (let i = 0; i < variants.length; i++) {
    const body = variants[i];
    const usage = emptyUsage();
    const chunks = [];
    try {
      const res = await postJson(url, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...headers,
        },
        body,
        signal,
        timeoutMs,
      });

      if (body.stream === false) {
        const json = await res.json();
        usage.input = json?.usage?.input_tokens || 0;
        usage.output = json?.usage?.output_tokens || 0;
        usage.cached = json?.usage?.cache_read_input_tokens || 0;
        usage.reported = !!json?.usage;
        for (const b of json?.content || []) if (b.type === 'text') chunks.push(b.text);
        const text = chunks.join('');
        return { usage: finalizeUsage(usage, text), text, variant: i };
      }

      let thinkingChars = 0;
      await readSse(res, {
        signal,
        onData: (ev) => {
          if (ev.type === 'message_start') {
            const u = ev.message?.usage;
            if (u) {
              usage.input = u.input_tokens || 0;
              usage.cached = u.cache_read_input_tokens || 0;
              usage.reported = true;
            }
          } else if (ev.type === 'message_delta') {
            const u = ev.usage;
            if (u) {
              // output_tokens is cumulative, not a delta.
              if (typeof u.output_tokens === 'number') usage.output = u.output_tokens;
              usage.reported = true;
            }
          } else if (ev.type === 'content_block_delta') {
            const d = ev.delta;
            if (d?.type === 'text_delta') chunks.push(d.text);
            else if (d?.type === 'thinking_delta') {
              const t = d.thinking || '';
              chunks.push(t);
              thinkingChars += t.length;
            }
          }
        },
      });

      if (thinkingChars) usage.reasoning = Math.ceil(thinkingChars / 3.6);
      const text = chunks.join('');
      return { usage: finalizeUsage(usage, text), text, variant: i };
    } catch (err) {
      lastErr = err;
      const shape = err instanceof ApiError && (err.status === 400 || err.status === 422);
      if (shape && i < variants.length - 1) continue;
      throw err;
    }
  }
  throw lastErr;
}
