/**
 * OpenAI Chat Completions and every clone of it.
 *
 * The clones are the reason this file is defensive: "OpenAI compatible" ranges
 * from a byte-identical proxy to an endpoint that rejects any field it has not
 * heard of. So instead of guessing the right parameter set we ship an ordered
 * list of variants and walk down it on 4xx, which costs at most a handful of
 * wasted calls the first time you point the tool at a new vendor.
 */

import { postJson, readSse, joinUrl, ApiError, emptyUsage, finalizeUsage } from './http.js';

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

/** Errors that mean "this request shape is wrong", not "this account is broken". */
function isShapeError(err) {
  if (!(err instanceof ApiError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  const b = String(err.body || '');
  if (/model.*(not found|does not exist|not exist|invalid)|unknown model/i.test(b)) return false;
  return true;
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
}) {
  const url = joinUrl(baseUrl, path) + extraQuery;
  const variants = buildVariants({ model, payload, images, maxOutput, effort });

  let lastErr;
  for (let i = 0; i < variants.length; i++) {
    const body = variants[i];
    const usage = emptyUsage();
    // Chunks are collected in an array rather than string-concatenated: a
    // 128K-token completion arrives as thousands of deltas and repeated `+=`
    // on a half-megabyte string is quadratic.
    const chunks = [];
    try {
      const res = await postJson(url, {
        headers: { [authHeader]: `${authPrefix}${apiKey}`, ...headers },
        body,
        signal,
        timeoutMs,
      });

      if (body.stream === false) {
        const json = await res.json();
        absorbUsage(json.usage, usage);
        const text = json?.choices?.[0]?.message?.content || '';
        usage.reported = !!json.usage;
        return { usage: finalizeUsage(usage, text), text, variant: i };
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
          if (delta?.content) chunks.push(delta.content);
          if (delta?.reasoning_content) chunks.push(delta.reasoning_content);
        },
      });

      const text = chunks.join('');
      return { usage: finalizeUsage(usage, text), text, variant: i };
    } catch (err) {
      lastErr = err;
      if (isShapeError(err) && i < variants.length - 1) continue;
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
