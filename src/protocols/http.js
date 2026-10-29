/**
 * Small HTTP layer shared by all protocol adapters.
 * No SDKs: every vendor below accepts a JSON POST, and pulling in four SDKs
 * would mean four supply chains to trust with an API key.
 */

export class ApiError extends Error {
  constructor(status, body, url, retryAfterMs = 0) {
    super(`HTTP ${status}: ${describeBody(body)}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
    /** true when a naive retry has a chance of succeeding */
    this.retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
    /** retrying is pointless: bad key, missing model, no permission */
    this.fatal = status === 401 || status === 403 || status === 404;
    /** the account itself is out of money — the run is over, not broken */
    this.drained = isDrained(status, String(body ?? ''));
    if (this.drained) this.fatal = true;
  }
}

/**
 * Distinguish "this key is broke" from "this key is wrong".
 * Vendors express empty balance in wildly different ways, and only the
 * balance case should end a run gracefully instead of looking like a crash.
 */
function isDrained(status, body) {
  if (status === 402) return true;
  const b = body.toLowerCase();
  // Rate limits also contain the word "quota" — exclude those first.
  if (/rate[_ ]?limit|too many requests|rpm|tpm/.test(b)) return false;
  return /insufficient[_ ]?(quota|funds|balance)|quota (exceeded|exhausted)|exceeded your current quota|credit balance|billing|payment required|account (balance|debit)|余额不足|欠费|额度不足|账户余额|已用完/.test(
    b,
  );
}

/**
 * Build a short, safe description of an error payload.
 *
 * Never echo the raw body: vendors happily quote fragments of the request back
 * at you, and this string ends up in the UI, the log ring buffer and the exported
 * PDF. Prefer the vendor's own `message` field, scrub anything that looks like a
 * credential, and hard-cap the length.
 */
function describeBody(body) {
  const raw = String(body ?? '');
  try {
    const j = JSON.parse(raw);
    const m = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail ?? j?.msg;
    if (typeof m === 'string' && m.trim()) return scrub(m.trim()).slice(0, 280);
  } catch {
    /* not JSON — fall through */
  }
  return scrub(raw).slice(0, 240);
}

function scrub(text) {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{6,}|AIza[A-Za-z0-9_-]{10,}|xai-[A-Za-z0-9_-]{6,}|gsk_[A-Za-z0-9]{6,})/g, '***key***')
    .replace(/\s+/g, ' ');
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
 *
 * `idleMs` guards against the worst failure mode for a throughput tool: a socket
 * that stays open but stops sending. Without it one stuck request can hold a
 * worker for the full timeout while every other worker races ahead, silently
 * halving your burn rate.
 */
export async function readSse(res, { onData, onRaw, signal, idleMs = 0 } = {}) {
  if (!res.body) throw new Error('empty response body');
  const decoder = new TextDecoder();
  // A reader, not `for await`: the async iterator locks the stream, and a locked
  // stream cannot be cancelled — the idle timer had no way to break the pending
  // read, so a stalled response still held its worker until the full timeout.
  const reader = res.body.getReader();
  let buf = '';
  let stalled = false;
  let idleTimer = null;

  const armIdle = () => {
    if (!idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      reader.cancel().catch(() => {});
    }, idleMs);
  };

  armIdle();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        break;
      }
      armIdle();

      // Strip \r outright: some proxies frame events with CRLF, and looking for
      // '\n\n' alone would silently ignore the entire stream.
      buf += decoder.decode(value, { stream: true }).replace(/\r/g, '');

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
  } catch (err) {
    if (stalled) throw stallError(idleMs);
    throw err;
  } finally {
    clearTimeout(idleTimer);
  }

  if (stalled) throw stallError(idleMs);
}

function stallError(idleMs) {
  const e = new Error(`stream stalled: no data for ${Math.round(idleMs / 1000)}s`);
  e.name = 'StallError';
  e.status = 0;
  e.retryable = true; // a stalled stream is worth one more try
  return e;
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
