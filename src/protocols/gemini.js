/**
 * Google Gemini (generativelanguage.googleapis.com).
 *
 * Gemini differs from the others in two ways that matter here:
 *  - Images are tiled in 384px patches, so a genuinely larger image costs more
 *    tokens (no 1568px downscale cliff). This is the one vendor where the image
 *    bomb scales with resolution.
 *  - Thinking tokens are billed as output and capped by maxOutputTokens, so they
 *    eat into the same budget rather than adding to it.
 * Safety filters are relaxed to BLOCK_NONE because the payload is deliberately
 * meaningless bulk text and a spurious refusal would show up as a "wasted"
 * request that burned nothing.
 */

import { postJson, readSse, joinUrl, emptyUsage, finalizeUsage, isShapeError, throwIfError } from './http.js';
import { makeSink, orderVariants } from './openai.js';

const SAFETY = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

function parts(payload, images) {
  const out = [{ text: payload.filler + payload.instruction }];
  for (const img of images) {
    out.push({ inlineData: { mimeType: 'image/png', data: img.base64 } });
  }
  return out;
}

export async function callGemini({
  baseUrl,
  apiKey,
  model,
  payload,
  images = [],
  maxOutput,
  temperature = 1,
  signal,
  timeoutMs,
  streamIdleMs = 0,
  headers = {},
  preferredVariant = null,
  beforeSend = null,
  afterSend = null,
}) {
  const base = joinUrl(baseUrl, `/v1beta/models/${encodeURIComponent(model)}`);

  const body = {
    contents: [{ role: 'user', parts: parts(payload, images) }],
    systemInstruction: { parts: [{ text: payload.system }] },
    generationConfig: { maxOutputTokens: maxOutput, temperature },
    safetySettings: SAFETY,
  };

  const attempts = [
    { url: `${base}:streamGenerateContent?alt=sse`, body, stream: true },
    { url: `${base}:generateContent`, body, stream: false },
    // Some third-party Gemini proxies only expose the non-streaming shape.
    { url: `${base}:generateContent`, body: { ...body, generationConfig: { maxOutputTokens: maxOutput } }, stream: false },
  ];

  const order = orderVariants(attempts.length, preferredVariant);

  let lastErr;
  let shapeErr = null;
  for (let n = 0; n < order.length; n++) {
    const vi = order[n];
    const a = attempts[vi];
    const usage = emptyUsage();
    const sink = makeSink();
    const more = n < order.length - 1;

    let sent = false;
    let streaming = false;
    try {
      beforeSend?.();
      sent = true;

      const res = await postJson(a.url, {
        headers: { 'x-goog-api-key': apiKey, ...headers },
        body: a.body,
        signal,
        timeoutMs,
      });

      if (!a.stream) {
        const json = await res.json();
        throwIfError(json);
        absorb(json.usageMetadata, usage);
        for (const c of json?.candidates || []) {
          for (const p of c?.content?.parts || []) if (p.text) sink.push(p.text);
        }
        return { usage: finalizeUsage(usage, sink.chars), textLength: sink.chars, sample: sink.sample, variant: vi };
      }

      streaming = true;
      await readSse(res, {
        signal,
        idleMs: streamIdleMs,
        onData: (ev) => {
          throwIfError(ev);
          if (ev.usageMetadata) absorb(ev.usageMetadata, usage);
          for (const c of ev?.candidates || []) {
            for (const p of c?.content?.parts || []) if (p.text) sink.push(p.text);
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

function absorb(u, into) {
  if (!u) return;
  into.input = Math.max(into.input, u.promptTokenCount ?? 0);
  into.output = Math.max(into.output, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0));
  into.reasoning = Math.max(into.reasoning, u.thoughtsTokenCount ?? 0);
  into.cached = Math.max(into.cached, u.cachedContentTokenCount ?? 0);
  if (u.totalTokenCount) into.total = Math.max(into.total, u.totalTokenCount);
  into.reported = true;
}
