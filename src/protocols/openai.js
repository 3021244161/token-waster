/**
 * OpenAI Chat Completions and every clone of it.
 *
 * The clones are the reason this file is defensive: "OpenAI compatible" ranges
 * from a byte-identical proxy to an endpoint that rejects any field it has not
 * heard of. So instead of guessing the right parameter set we ship an ordered
 * list of variants and walk down it on 4xx.
 *
 * Two details that matter for a burn tool:
 *  - Completion text is *counted*, not accumulated. Nothing downstream reads it;
 *    keeping a megabyte of output alive per worker is pure GC pressure.
 *  - The variant that worked is returned so the scheduler can try it first next
 *    time. Re-discovering it on every request means uploading the same large body
 *    two extra times per call, which on a slow link dominates everything.
 */

import { postJson, readSse, joinUrl, emptyUsage, finalizeUsage, isShapeError } from './http.js';

const SAMPLE_CHARS = 160;

function contentParts(payload, images) {
  const parts = [{ type: 'text', text: payload.filler }];
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: 'high' } });
  }
  parts.push({ type: 'text', text: payload.instruction });
  return parts;
}

function buildVariants({ model, payload, images, maxOutput, effort }) {
  const messages = [
    { role: 'system', content: payload.system },
    { role: 'user', content: contentParts(payload, images) },
  ];

  const out = [];

  if (effort) {
    out.push({
      model,
      messages,
      max_completion_tokens: maxOutput,
      reasoning_effort: effort,
      stream: true,
      stream_options: { include_usage: true },
    });
  }

  out.push({
    model,
    messages,
    max_completion_tokens: maxOutput,
    stream: true,
    stream_options: { include_usage: true },
  });

  out.push({
    model,
    messages,
    max_tokens: maxOutput,
    stream: true,
    stream_options: { include_usage: true },
  });

  out.push({ model, messages, max_tokens: maxOutput, stream: true });
  out.push({ model, messages, max_tokens: maxOutput, stream: false });

  return out;
}

/** Try the remembered variant first, then everything else in order. */
export function orderVariants(count, preferred) {
  const order = [];
  if (Number.isInteger(preferred) && preferred >= 0 && preferred < count) order.push(preferred);
  for (let i = 0; i < count; i++) if (i !== preferred) order.push(i);
  return order;
}

/** Accumulates a bounded sample plus a character count, never the full text. */
export function makeSink() {
  let chars = 0;
  let sample = '';
  return {
    push(s) {
      if (!s) return;
      chars += s.length;
      if (sample.length < SAMPLE_CHARS) sample += s.slice(0, SAMPLE_CHARS - sample.length);
    },
    get chars() {
      return chars;
    },
    get sample() {
      return sample;
    },
  };
}

export async function callOpenAI({
  baseUrl,
  apiKey,
  model,
  payload,
  images = [],
  maxOutput,
  effort,
  signal,
  timeoutMs,
  streamIdleMs = 0,
  headers = {},
  path = '/chat/completions',
  authHeader = 'Authorization',
  authPrefix = 'Bearer ',
  extraQuery = '',
  preferredVariant = null,
  beforeSend = null,
}) {
  const url = joinUrl(baseUrl, path) + extraQuery;
  const variants = buildVariants({ model, payload, images, maxOutput, effort });
  const order = orderVariants(variants.length, preferredVariant);

  let lastErr;
  let shapeErr = null;
  for (let n = 0; n < order.length; n++) {
    const vi = order[n];
    const body = variants[vi];
    const usage = emptyUsage();
    const sink = makeSink();
    const more = n < order.length - 1;

    try {
      // Counts against the call ceiling at the only place that knows a request is
      // really leaving the machine — including variant probing.
      beforeSend?.();

      const res = await postJson(url, {
        headers: { [authHeader]: `${authPrefix}${apiKey}`, ...headers },
        body,
        signal,
        timeoutMs,
      });

      if (body.stream === false) {
        const json = await res.json();
        absorbUsage(json.usage, usage);
        sink.push(json?.choices?.[0]?.message?.content || '');
        usage.reported = !!json.usage;
        return { usage: finalizeUsage(usage, sink.chars), textLength: sink.chars, sample: sink.sample, variant: vi };
      }

      await readSse(res, {
        signal,
        idleMs: streamIdleMs,
        onData: (ev) => {
          if (ev.usage) {
            absorbUsage(ev.usage, usage);
            usage.reported = true;
          }
          const delta = ev?.choices?.[0]?.delta;
          if (delta?.content) sink.push(delta.content);
          if (delta?.reasoning_content) sink.push(delta.reasoning_content);
        },
      });

      return { usage: finalizeUsage(usage, sink.chars), textLength: sink.chars, sample: sink.sample, variant: vi };
    } catch (err) {
      lastErr = err;
      if (err?.budgetStop) {
        // Ran out of call budget mid-probe. Surface the shape error if we saw one,
        // otherwise the engine learns nothing and keeps the wrong parameters.
        if (shapeErr) throw shapeErr;
        throw err;
      }
      if (isShapeError(err) && more) {
        shapeErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function absorbUsage(u, into) {
  if (!u) return;
  into.input = Math.max(into.input, u.prompt_tokens ?? u.input_tokens ?? 0);
  into.output = Math.max(into.output, u.completion_tokens ?? u.output_tokens ?? 0);
  into.cached = Math.max(
    into.cached,
    u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0,
  );
  into.reasoning = Math.max(
    into.reasoning,
    u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0,
  );
  if (u.total_tokens) into.total = Math.max(into.total, u.total_tokens);
}
