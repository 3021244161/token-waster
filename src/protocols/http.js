/**
 * Small HTTP layer shared by all protocol adapters.
 * No SDKs: every vendor below accepts a JSON POST, and pulling in four SDKs
 * would mean four supply chains to trust with an API key.
 */

export class ApiError extends Error {
  constructor(status, body, url, retryAfterMs = 0) {
    super(`HTTP ${status}: ${truncate(String(body ?? ''), 400)}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
    /** true when a naive retry has a chance of succeeding */
    this.retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
    /** true when retrying anything at all is pointless (bad key, no model, no money) */
    this.fatal =
      status === 401 ||
      status === 402 ||
      status === 403 ||
      status === 404 ||
      /insufficient|quota|balance|billing|invalid[_ ]api[_ ]key/i.test(String(body ?? ''));
  }
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * POST JSON and return the raw Response. Throws ApiError for non-2xx.
 * Caller owns body consumption.
 */
export async function postJson(url, { headers = {}, body, signal, timeoutMs = 180_000 } = {}) {
  const signals = [signal, AbortSignal.timeout(timeoutMs)].filter(Boolean);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const retryAfter = Number(res.headers.get('retry-after') || 0) * 1000;
    throw new ApiError(res.status, text, url, Number.isFinite(retryAfter) ? retryAfter : 0);
  }
  return res;
}

/**
 * Consume an SSE response, invoking `onData(json)` for every `data:` payload and
 * `onRaw(text)` for everything else (some vendors emit non-JSON keepalives).
 */
export async function readSse(res, { onData, onRaw, signal } = {}) {
  if (!res.body) throw new Error('empty response body');
  const decoder = new TextDecoder();
  let buf = '';

  for await (const chunk of res.body) {
    if (signal?.aborted) break;
    buf += decoder.decode(chunk, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) {
          if (line.trim() && onRaw) onRaw(line);
          continue;
        }
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          onData?.(JSON.parse(data));
        } catch {
          onRaw?.(data);
        }
      }
    }
  }
}

/** Normalised usage record shared by every adapter. */
export function emptyUsage() {
  return { input: 0, output: 0, cached: 0, reasoning: 0, total: 0, reported: false };
}

export function finalizeUsage(u, fallbackText = '') {
  if (!u.reported && fallbackText) {
    // Only used when a vendor omits usage entirely; rough and clearly labelled.
    u.output = Math.max(u.output, Math.ceil(fallbackText.length / 3.6));
    u.total = u.input + u.output;
  }
  if (!u.total) u.total = u.input + u.output;
  return u;
}
