#!/usr/bin/env node
/**
 * token-waster — local server.
 *
 * Design constraints, in order of priority:
 *   1. Never write an API key to disk, to a log, or into an error message.
 *   2. Never accept a run that has no hard ceiling.
 *   3. Never let another origin drive this server.
 *   4. Bind to loopback only.
 *
 * There is no auth beyond that, because there is no remote surface: this file
 * serves a UI to 127.0.0.1 and proxies to whatever endpoint you type in.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDERS, CATALOG_VERSION, getProvider, getModel } from './src/config.js';
import { Burner } from './src/engine.js';
import { callProvider } from './src/protocols/index.js';
import { renderReport } from './src/report.js';
import { writeSse } from './src/sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8791);
const HOST = '127.0.0.1';

const MAX_BODY_BYTES = 256 * 1024;
const HARD_MAX_CONCURRENCY = 32;
const HARD_MAX_REQUESTS = 20_000;
const HARD_MAX_USD = 500;
const HARD_MAX_DURATION_MS = 6 * 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/* ── run state ────────────────────────────────────────────────────────────── */

/** @type {{burner: Burner|null, sse: Set<import('node:http').ServerResponse>}} */
const state = { burner: null, sse: new Set() };
/** Guards the window between "request arrived" and "burner installed". */
let starting = false;

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of state.sse) {
    if (!writeSse(res, payload)) state.sse.delete(res);
  }
}

function attach(burner) {
  burner.on('tick', (snap) => broadcast('tick', snap));
  burner.on('log', (entry) => broadcast('log', entry));
  burner.on('done', (snap) => broadcast('done', snap));
}

/* ── validation ───────────────────────────────────────────────────────────── */

class BadRequest extends Error {
  constructor(msg) {
    super(msg);
    this.status = 400;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function validateBaseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    throw new BadRequest('baseUrl 不是合法 URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new BadRequest('baseUrl 只允许 http/https');
  }
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) {
    throw new BadRequest('明文 http 只允许指向本机（如 Ollama）。公网端点必须用 https，否则你的 API key 会裸奔。');
  }
  return u.toString().replace(/\/+$/, '');
}

function num(v, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/**
 * Turn a loose UI payload into a fully-validated Burner config.
 * Every rejection here is a guard rail the user cannot click past.
 */
function buildConfig(body) {
  const mode = ['tokens', 'usd', 'requests', 'time', 'drain'].includes(body.mode) ? body.mode : 'tokens';
  const isDrain = mode === 'drain';

  // 无忧燃尽 is the one mode whose whole purpose is to not stop, so it gets its
  // own, louder confirmation word.
  if (isDrain) {
    if (body.confirm !== 'BURN') {
      throw new BadRequest('「无忧燃尽」需要单独确认：请在确认框输入 BURN。');
    }
  } else if (body.confirm !== 'WASTE') {
    throw new BadRequest('未确认。请勾选"我明白我在花钱"并在确认框输入 WASTE。');
  }

  const provider = getProvider(body.providerId);
  if (!provider) throw new BadRequest('未知的 provider');

  const apiKey = String(body.apiKey || '').trim();
  if (!apiKey) throw new BadRequest('apiKey 不能为空（只保存在服务进程内存里，不落盘）');
  if (apiKey.length > 512) throw new BadRequest('apiKey 长得不像真的');

  const modelId = String(body.modelId || '').trim();
  if (!modelId) throw new BadRequest('modelId 不能为空');

  const baseUrl = validateBaseUrl(body.baseUrl || provider.baseUrl);

  const catalogModel = getModel(provider.id, modelId);
  const custom = body.model || {};
  const model = {
    id: modelId,
    ctx: num(custom.ctx ?? catalogModel?.ctx, 128000, { min: 4096, max: 20_000_000 }),
    maxOut: num(custom.maxOut ?? catalogModel?.maxOut, 4096, { min: 32, max: 1_000_000 }),
    price: {
      in: num(custom.priceIn ?? catalogModel?.price?.in, 0, { max: 1000 }),
      out: num(custom.priceOut ?? catalogModel?.price?.out, 0, { max: 1000 }),
      currency: String(custom.currency || catalogModel?.price?.currency || 'USD').toUpperCase(),
    },
    vision: custom.vision ?? catalogModel?.vision ?? true,
    reasoning: custom.reasoning ?? catalogModel?.reasoning ?? false,
  };

  const concurrency = num(body.concurrency, 4, { min: 1, max: HARD_MAX_CONCURRENCY });

  // ── target + guards. A run with no finite limit is refused outright.
  const targetValue = num(body.targetValue, 0, { min: 0, max: 1e12 });

  const guard = body.guards || {};
  const maxUsd = num(guard.maxUsd, 0, { min: 0, max: HARD_MAX_USD });
  const maxRequests = num(guard.maxRequests, 0, { min: 0, max: HARD_MAX_REQUESTS });
  const maxDurationSec = num(guard.maxDurationSec, 0, { min: 0, max: HARD_MAX_DURATION_MS / 1000 });
  const maxTokens = num(guard.maxTokens, 0, { min: 0, max: 1e12 });

  let limitTokens = Infinity;
  let limitUsd = Infinity;
  let limitRequests = Infinity;
  let limitDurationMs = Infinity;

  if (mode === 'tokens') limitTokens = targetValue;
  if (mode === 'usd') limitUsd = targetValue;
  if (mode === 'requests') limitRequests = targetValue;
  if (mode === 'time') {
    if (targetValue <= 0) throw new BadRequest('目标时长必须大于 0 秒');
    limitDurationMs = targetValue * 1000;
  }

  if (isDrain) {
    // 无忧燃尽 has no money or token ceiling by definition — the provider's own
    // "insufficient quota" response is what ends it. What it *does* keep is a
    // wall-clock and request-count backstop, so a provider that happily serves
    // forever (free tier, local model, forgotten PTU) cannot run until dawn.
    limitTokens = Infinity;
    limitUsd = Infinity;
    limitRequests = maxRequests > 0 ? Math.min(maxRequests, HARD_MAX_REQUESTS) : HARD_MAX_REQUESTS;
    limitDurationMs =
      maxDurationSec > 0 ? Math.min(maxDurationSec * 1000, HARD_MAX_DURATION_MS) : HARD_MAX_DURATION_MS;
  }

  // Guards always apply, whichever mode is active.
  if (!isDrain) {
    if (maxTokens > 0) limitTokens = Math.min(limitTokens, maxTokens);
    if (maxUsd > 0) limitUsd = Math.min(limitUsd, maxUsd);
    if (maxRequests > 0) limitRequests = Math.min(limitRequests, maxRequests);
    if (maxDurationSec > 0) limitDurationMs = Math.min(limitDurationMs, maxDurationSec * 1000);
  }

  // The target field and the guard fields must not have different ceilings —
  // otherwise `targetValue: 1000` reaches $1000 while the UI says the hard cap
  // is $500.
  if (Number.isFinite(limitUsd)) limitUsd = Math.min(limitUsd, HARD_MAX_USD);
  if (Number.isFinite(limitRequests)) limitRequests = Math.min(limitRequests, HARD_MAX_REQUESTS);
  if (Number.isFinite(limitDurationMs)) limitDurationMs = Math.min(limitDurationMs, HARD_MAX_DURATION_MS);

  const finite = [limitTokens, limitUsd, limitRequests, limitDurationMs].filter(Number.isFinite).length;
  if (finite === 0) {
    throw new BadRequest(
      '拒绝启动：没有任何硬上限。请至少设置一个（token 数 / 金额 / 请求数 / 时长）。这不是可以关掉的开关。',
    );
  }
  // A token or request target alone is not enough: token counts are enormous
  // numbers and a 1e12 target is effectively "run until your card declines".
  // Money and time are the two limits a person can actually reason about.
  if (!Number.isFinite(limitUsd) && !Number.isFinite(limitDurationMs)) {
    throw new BadRequest('拒绝启动：必须至少设置「最多花多少美元」或「最多跑多少秒」其中之一，给账单和时长留个兜底。');
  }
  if (mode === 'tokens' && targetValue < 1000) throw new BadRequest('目标 token 数太小，至少要 1000');

  // A zero price makes the money ceiling structurally inert: the local ledger
  // computes $0 forever, so `maxUsd` never trips while the real meter runs.
  const priceIsZero = model.price.in === 0 && model.price.out === 0;
  if (priceIsZero && !Number.isFinite(limitDurationMs) && !Number.isFinite(limitRequests)) {
    throw new BadRequest(
      '这个模型的价格是 0（未填写或确实免费），金额上限永远不会触发。请改用「最多跑多少秒」或「最多请求数」兜底。',
    );
  }

  if (!['USD', 'CNY', 'EUR'].includes(model.price.currency)) throw new BadRequest('仅支持 USD、CNY 或 EUR 计价');
  if (model.price.currency !== 'USD' && !Number.isFinite(limitDurationMs) && !Number.isFinite(limitRequests)) {
    throw new BadRequest('非美元计价使用估算汇率，请同时设置时长或请求数上限');
  }

  const strategy = ['max-output', 'image-bomb', 'mixed'].includes(body.strategy) ? body.strategy : 'max-output';

  const imageSize = num(body.imageSize, provider.imageLongEdge || 1536, { min: 256, max: 4096 });
  const imageCount = num(body.imageCount, 4, { min: 0, max: 32 });
  const maxImagesPerRequest = Math.max(0, Math.min(imageCount, provider.maxImagesPerRequest ?? 20));

  const cfg = {
    providerId: provider.id,
    providerLabel: provider.label,
    protocol: provider.protocol,
    baseUrl,
    apiVersion: provider.apiVersion,
    apiKey,
    modelId,
    model,
    strategy,
    mode,
    concurrency: isDrain && !body.concurrency ? 8 : concurrency,
    limitTokens,
    limitUsd,
    limitRequests,
    limitDurationMs,
    contextFill: num(body.contextFill, 0.25, { min: 0, max: 0.95 }),
    maxFillerTokens: Math.floor(num(body.maxFillerTokens, 250_000, { min: 1024, max: 2_000_000 })),
    imageShare: num(body.imageShare, 0.6, { min: 0, max: 0.95 }),
    imageCount: strategy === 'max-output' ? Math.min(1, imageCount) : maxImagesPerRequest,
    imageSize,
    maxImagesPerRequest,
    shortOutput: !!body.shortOutput,
    effort: ['minimal', 'low', 'medium', 'high'].includes(body.effort) ? body.effort : null,
    thinkingBudget: num(body.thinkingBudget, 0, { min: 0, max: 200000 }),
    requestTimeoutMs: num(body.requestTimeoutMs, 180000, { min: 5000, max: 900000 }),
    // A stream that goes quiet for this long is treated as dead and retried —
    // one silently stalled socket would otherwise hold a worker hostage.
    streamIdleMs: num(body.streamIdleMs, 75000, { min: 10000, max: 600000 }),
    maxRetries: num(body.maxRetries, 2, { min: 0, max: 5 }),
    dryRun: !!body.dryRun,
  };

  return cfg;
}

/* ── http helpers ─────────────────────────────────────────────────────────── */

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readJson(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) throw new BadRequest('Content-Type 必须是 application/json');
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('请求体过大');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('JSON 解析失败');
  }
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches from the page send one; curl does not
  try {
    const h = new URL(origin).hostname;
    return LOOPBACK.has(h);
  } catch {
    return false;
  }
}

/* ── routes ───────────────────────────────────────────────────────────────── */

const routes = {
  'GET /api/bootstrap': async (req, res) => {
    json(res, 200, {
      catalogVersion: CATALOG_VERSION,
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        keyHint: p.keyHint,
        consoleUrl: p.consoleUrl,
        docsUrl: p.docsUrl,
        notes: p.notes,
        limitsNote: p.limitsNote,
        maxImagesPerRequest: p.maxImagesPerRequest,
        imageLongEdge: p.imageLongEdge,
        models: p.models,
      })),
      limits: {
        maxConcurrency: HARD_MAX_CONCURRENCY,
        maxRequests: HARD_MAX_REQUESTS,
        maxUsd: HARD_MAX_USD,
        maxDurationSec: HARD_MAX_DURATION_MS / 1000,
      },
      status: state.burner ? state.burner.snapshot() : null,
    });
  },

  'POST /api/run/start': async (req, res) => {
    // The exclusivity check has to survive the `await` below. Two bodies arriving
    // in the same tick would otherwise both pass the check, the second would
    // overwrite `state.burner`, and the first run would keep burning with no way
    // to stop it from the UI.
    if (starting) return json(res, 409, { error: '另一个运行正在启动中，稍等。' });
    if (state.burner && (state.burner.state === 'running' || state.burner.state === 'stopping')) {
      return json(res, 409, { error: '已经有一次运行在进行中，先停掉它。' });
    }

    starting = true;
    let cfg;
    try {
      const body = await readJson(req);
      cfg = buildConfig(body);
    } finally {
      starting = false;
    }

    const burner = new Burner(cfg);
    state.burner = burner;
    attach(burner);

    // Fire and forget; progress is delivered over SSE.
    burner.run().catch((err) => broadcast('log', { level: 'error', msg: err.message, at: Date.now() }));

    json(res, 202, { started: true, dryRun: cfg.dryRun });
  },

  'POST /api/run/stop': async (req, res) => {
    if (!state.burner) return json(res, 200, { stopped: false, reason: 'nothing running' });
    state.burner.stop('stopped by user');
    json(res, 200, { stopped: true });
  },

  'GET /api/run/status': async (req, res) => {
    json(res, 200, state.burner ? state.burner.snapshot() : { state: 'idle' });
  },

  'GET /api/run/logs': async (req, res) => {
    json(res, 200, { logs: state.burner?.logs?.slice(-200) || [] });
  },

  /**
   * Printable run report. Served as HTML rather than a .pdf because the browser
   * already has a PDF writer with the right fonts; see src/report.js.
   * ?auto=1 opens the print dialog on load.
   */
  'GET /api/report': async (req, res) => {
    if (!state.burner) return json(res, 404, { error: '还没有可导出的运行记录' });
    const auto = /[?&]auto=1/.test(req.url || '');
    const html = renderReport(state.burner.report(), { autoPrint: auto });
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
  },

  /** Single tiny request — verifies key/model/endpoint without burning much. */
  'POST /api/probe': async (req, res) => {
    const body = await readJson(req);
    const provider = getProvider(body.providerId);
    if (!provider) throw new BadRequest('未知的 provider');
    const apiKey = String(body.apiKey || '').trim();
    if (!apiKey) throw new BadRequest('apiKey 为空');
    const baseUrl = validateBaseUrl(body.baseUrl || provider.baseUrl);

    const t0 = Date.now();
    try {
      const out = await callProvider({
        protocol: provider.protocol,
        baseUrl,
        apiKey,
        apiVersion: provider.apiVersion,
        model: String(body.modelId || '').trim(),
        payload: { system: 'Reply tersely.', filler: '\n\n', instruction: 'Say OK.' },
        images: [],
        maxOutput: 16,
        signal: AbortSignal.timeout(60_000),
        timeoutMs: 60_000,
      });
      json(res, 200, {
        ok: true,
        ms: Date.now() - t0,
        usage: out.usage,
        sample: (out.text || '').slice(0, 200),
        variant: out.variant,
      });
    } catch (err) {
      json(res, 200, {
        ok: false,
        ms: Date.now() - t0,
        status: err.status || 0,
        error: String(err.message || err).slice(0, 600),
      });
    }
  },

  'GET /api/run/stream': async (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (!writeSse(res, ': connected\n\n')) return;
    state.sse.add(res);
    req.on('close', () => state.sse.delete(res));

    if (state.burner) {
      if (!writeSse(res, `event: tick\ndata: ${JSON.stringify(state.burner.snapshot())}\n\n`)) {
        state.sse.delete(res);
        return;
      }
      for (const l of state.burner.logs.slice(-40)) {
        if (!writeSse(res, `event: log\ndata: ${JSON.stringify(l)}\n\n`)) {
          state.sse.delete(res);
          return;
        }
      }
    }
  },
};

/* ── static ───────────────────────────────────────────────────────────────── */

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  // Containment check: refuse anything that resolves outside public/.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

/* ── server ───────────────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  try {
    if (!checkOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });

    const key = `${req.method} ${new URL(req.url, 'http://x').pathname}`;
    const handler = routes[key];
    if (handler) return await handler(req, res);

    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);

    json(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err.status || 500;
    // Deliberately no stack traces to the client: request bodies contain keys.
    json(res, status, { error: String(err.message || 'internal error').slice(0, 500) });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │  token-waster — 本地运行，仅监听 127.0.0.1               │');
  console.log('  └──────────────────────────────────────────────────────────┘');
  console.log(`\n  →  ${url}\n`);
  console.log('  这不是 AI 工具。它只会烧钱，不产出任何有价值的东西。');
  console.log('  只对你自己的 key 使用。设好硬上限再启动。\n');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    state.burner?.stop('server shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
