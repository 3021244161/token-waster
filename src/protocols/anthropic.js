/**
 * Anthropic Messages API.
 *
 * Notes that matter for this tool:
 *  - Prompt caching is strictly opt-in via `cache_control` markers. We never
 *    emit them, so every request is a guaranteed full-price cache miss.
 *  - `thinking` tokens are billed as *output* and count against max_tokens, so
 *    turning thinking on is pure profit for a burn tool — but the budget must be
 *    strictly smaller than max_tokens, hence the clamping below.
 *  - Recent Claude models reject non-default temperature/top_p/top_k, so we
 *    simply do not send sampling parameters.
 *  - Output is counted, never accumulated (see openai.js for the reasoning).
 */

import { postJson, readSse, joinUrl, emptyUsage, finalizeUsage, isShapeError, throwIfError } from './http.js';
import { makeSink, orderVariants } from './openai.js';

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
  streamIdleMs = 0,
  headers = {},
  preferredVariant = null,
  beforeSend = null,
  afterSend = null,
}) {
  const url = joinUrl(baseUrl, '/v1/messages');
  const messages = [{ role: 'user', content: buildContent(payload, images) }];

  const variants = [];
  const manualBudget = Math.min(thinkingBudget, maxOutput - 1024);
  if (manualBudget >= 1024) {
    variants.push({
      model,
      max_tokens: maxOutput,
      system: payload.system,
      messages,
      thinking: { type: 'enabled', budget_tokens: manualBudget },
      stream: true,
    });
  }
  variants.push({ model, max_tokens: maxOutput, system: payload.system, messages, stream: true });
  variants.push({ model, max_tokens: maxOutput, system: payload.system, messages, stream: false });

  const order = orderVariants(variants.length, preferredVariant);

  let lastErr;
  let shapeErr = null;
  for (let n = 0; n < order.length; n++) {
    const vi = order[n];
    const body = variants[vi];
    const usage = emptyUsage();
    const sink = makeSink();
    const more = n < order.length - 1;

    let sent = false;
    let streaming = false;
    try {
      beforeSend?.();
      sent = true;

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
        throwIfError(json);
        usage.input = json?.usage?.input_tokens || 0;
        usage.output = json?.usage?.output_tokens || 0;
        usage.cached = json?.usage?.cache_read_input_tokens || 0;
        usage.reported = !!json?.usage;
        for (const b of json?.content || []) if (b.type === 'text') sink.push(b.text);
        return { usage: finalizeUsage(usage, sink.chars), textLength: sink.chars, sample: sink.sample, variant: vi };
      }

      streaming = true;
      await readSse(res, {
        signal,
        idleMs: streamIdleMs,
        onData: (ev) => {
          throwIfError(ev);
          if (ev.type === 'message_start') {
            const u = ev.message?.usage;
            if (u) {
              usage.input = u.input_tokens || 0;
              usage.output = Math.max(usage.output, u.output_tokens || 0);
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
            if (d?.type === 'text_delta') sink.push(d.text);
            else if (d?.type === 'thinking_delta') sink.push(d.thinking);
          }
        },
      });

      return { usage: finalizeUsage(usage, sink.chars), textLength: sink.chars, sample: sink.sample, variant: vi };
    } catch (err) {
      lastErr = err;
      if (streaming || err.streamFailure) {
        err.streamFailure = true;
        err.partialUsage = { ...usage };
      }
      if (err?.budgetStop) {
        if (shapeErr) throw shapeErr;
        throw err;
      }
      if (!err.streamFailure && isShapeError(err) && more) {
        shapeErr = err;
        continue;
      }
      throw err;
    } finally {
      if (sent) afterSend?.();
    }
  }
  throw lastErr;
}
