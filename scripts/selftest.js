/**
 * Self-test. No network, no API key.
 *
 * Spins up a mock endpoint that speaks all three protocols, points the real
 * engine at it, and checks the things that would silently break in production:
 * usage accounting, quota convergence, abort behaviour, and cache-busting.
 *
 *   node scripts/selftest.js
 */

import http from 'node:http';
import assert from 'node:assert/strict';

import { makeBlockPng, makeImagePool, estimateImageTokens } from '../src/images.js';
import { buildPayload, makeFiller, estimateTokens, makeNonce } from '../src/prompts.js';
import { Burner } from '../src/engine.js';
import { estimateCostUsd } from '../src/config.js';
import { renderReport } from '../src/report.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
}

/* ── mock vendor ──────────────────────────────────────────────────────────── */

const MOCK_USAGE = { input: 1200, output: 2400 };
let flakyHits = 0;
/** Total HTTP calls the mock actually received, across every test. */
let wireHits = 0;

function startMock() {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '';
    let raw = '';
    for await (const c of req) raw += c;
    if (url.includes('/chat/completions') || url.includes('/messages') || url.includes('streamGenerateContent')) {
      wireHits++;
    }

    if (url.startsWith('/v1/chat/completions')) {
      const body = JSON.parse(raw);
      const maxOut = body.max_completion_tokens ?? body.max_tokens ?? 100;

      // Dead account: the run should end cleanly with "account drained", not
      // look like a crash.
      if (body.model === 'drain-model') {
        res.writeHead(402, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Insufficient quota: your credit balance is 0' } }));
      }

      // Permanently broken upstream, for the cooldown governor.
      if (body.model === 'broken-model') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
      }

      // Fails twice then works, for retry accounting.
      if (body.model === 'flaky-model') {
        flakyHits++;
        if (flakyHits <= 2) {
          res.writeHead(503, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'temporarily unavailable' } }));
        }
      }

      // Reports the *actual* size of what we sent, so tests can catch the engine
      // silently inflating a small request into a 25k-token one.
      if (body.model === 'echo-model') {
        const txt = JSON.stringify(body.messages || []);
        const inTok = estimateTokens(txt);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: inTok, completion_tokens: 100, total_tokens: inTok + 100 },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // Streams text but omits usage entirely — the engine must not treat the
      // missing input count as free.
      if (body.model === 'plain-model') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(4000) } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // CRLF-framed SSE, as some proxies emit.
      if (body.model === 'crlf-model') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\r\n\r\n`);
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 600, total_tokens: 1100 } })}\r\n\r\n`,
        );
        res.write('data: [DONE]\r\n\r\n');
        return res.end();
      }

      // A fussy model that rejects oversized completions, to exercise the
      // engine's ability to shrink its own numbers instead of failing forever.
      if (body.model === 'picky-model' && maxOut > 4000) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'max_tokens is too large for this model' } }));
      }
      const out = Math.min(maxOut, MOCK_USAGE.output);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < 3; i++) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(20) } }] })}\n\n`);
      }
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: MOCK_USAGE.input, completion_tokens: out, total_tokens: MOCK_USAGE.input + out },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    if (url.startsWith('/v1/messages')) {
      const body = JSON.parse(raw);
      const out = Math.min(body.max_tokens ?? 100, MOCK_USAGE.output);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: MOCK_USAGE.input, output_tokens: 1 } } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: out } })}\n\n`);
      res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      return res.end();
    }

    if (url.includes(':streamGenerateContent')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: {
            promptTokenCount: MOCK_USAGE.input,
            candidatesTokenCount: MOCK_USAGE.output,
            totalTokenCount: MOCK_USAGE.input + MOCK_USAGE.output,
          },
        })}\n\n`,
      );
      return res.end();
    }

    res.writeHead(404).end('nope');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ── unit-ish tests ───────────────────────────────────────────────────────── */

test('PNG has valid signature and IHDR', () => {
  const img = makeBlockPng(512, 512, { seed: 42 });
  assert.equal(img.buffer.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(img.width, 512);
  assert.equal(img.height, 512);
  assert.ok(img.bytes > 100, 'png should not be empty');
});

test('a big flat image stays small on disk', () => {
  const img = makeBlockPng(1536, 1536, { seed: 7 });
  // The whole point: billed by pixels, uploaded as bytes.
  assert.ok(img.bytes < 1_500_000, `expected <1.5MB, got ${(img.bytes / 1024).toFixed(0)}KB`);
});

test('image pool yields distinct images', () => {
  const pool = makeImagePool(3, 256);
  assert.equal(pool.length, 3);
  const hashes = new Set(pool.map((p) => p.base64.slice(0, 256)));
  assert.equal(hashes.size, 3);
});

test('image token estimates are per-protocol', () => {
  const claude = estimateImageTokens('anthropic-messages', 1536, 1536);
  const gemini = estimateImageTokens('gemini-generate', 1536, 1536);
  assert.ok(claude > 2000 && claude < 4000, `claude ~3300, got ${claude}`);
  assert.ok(gemini > claude, 'gemini tiles without downscaling, so it should cost more');
});

test('filler hits its token target within 10%', () => {
  const target = 20000;
  const text = makeFiller(target);
  const got = estimateTokens(text);
  assert.ok(Math.abs(got - target) / target < 0.1, `target ${target}, got ${got}`);
});

test('nonces never repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(makeNonce());
  assert.equal(seen.size, 500);
});

test('payload head is random across calls (cache busting)', () => {
  const heads = new Set();
  for (let i = 0; i < 50; i++) {
    const p = buildPayload({ fillerTokens: 0, outputBias: 'max' });
    heads.add(p.system.slice(0, 200));
  }
  assert.equal(heads.size, 50);
});

test('cost estimate uses per-1M pricing', () => {
  const model = { price: { in: 5, out: 30, currency: 'USD' } };
  const usd = estimateCostUsd(model, { input: 1_000_000, output: 1_000_000 });
  assert.equal(Math.round(usd), 35);
});

test('report renders totals and escapes untrusted strings', () => {
  const html = renderReport({
    snapshot: {
      total: 1234567, input: 800000, output: 434567, cached: 0, costUsd: 12.34,
      requests: 40, ok: 39, failed: 1, retries: 2, degraded: 1, recovered: 0,
      elapsedMs: 65000, stopReason: 'token target reached', permits: 4,
      peakInflight: 6, latency: { p50: 900, p90: 2000, p99: 3000 },
      config: { concurrency: 8 }, estimateOnly: 0,
    },
    timeline: [
      { t: 0, total: 0, cost: 0, rate: 0, req: 0 },
      { t: 1000, total: 600000, cost: 6, rate: 600, req: 20 },
      { t: 2000, total: 1234567, cost: 12.34, rate: 631, req: 40 },
    ],
    logs: [{ at: Date.now(), level: 'ok', msg: '+6,600 tok' }],
    model: { id: 'test-model', ctx: 100000, maxOut: 8000, price: { in: 1, out: 2, currency: 'USD' } },
    provider: { id: 'x', label: '<script>alert(1)</script>', baseUrl: 'https://x' },
    startedAt: Date.now() - 65000,
    endedAt: Date.now(),
  });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('1,234,567'), 'totals should be formatted');
  assert.ok(html.includes('达到 token 目标'), 'stop reason should be translated');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'provider label must be escaped');
  assert.ok(html.includes('&lt;script&gt;'));
});

/* ── engine integration ───────────────────────────────────────────────────── */

function cfgFor(port, overrides = {}) {
  return {
    providerId: 'mock',
    protocol: 'openai-chat',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'test',
    modelId: 'mock-model',
    model: { id: 'mock-model', ctx: 200000, maxOut: 8000, price: { in: 1, out: 2, currency: 'USD' }, vision: true },
    strategy: 'max-output',
    concurrency: 4,
    limitTokens: 60000,
    limitUsd: Infinity,
    limitRequests: Infinity,
    limitDurationMs: 30000,
    contextFill: 0.2,
    imageShare: 0.6,
    imageCount: 0,
    imageSize: 512,
    maxImagesPerRequest: 0,
    shortOutput: false,
    effort: null,
    thinkingBudget: 0,
    requestTimeoutMs: 10000,
    streamIdleMs: 10000,
    maxRetries: 2,
    dryRun: false,
    ...overrides,
  };
}

async function main() {
  const { server, port } = await startMock();

  await testAsync('engine converges on a token target', async () => {
    const b = new Burner(cfgFor(port, { limitTokens: 60000 }));
    const snap = await b.run();
    // Mock reports 1200 in + up to 2400 out per request; we must land near 60k,
    // never more than one in-flight request over.
    assert.ok(snap.total > 45_000, `too few tokens: ${snap.total}`);
    assert.ok(snap.total < 60000 + 4000, `overshot badly: ${snap.total}`);
    assert.equal(snap.failed, 0);
  });

  await testAsync('money ceiling is respected within one in-flight wave', async () => {
    const b = new Burner(
      cfgFor(port, {
        limitTokens: Infinity,
        limitUsd: 0.02,
        limitDurationMs: 20000,
        model: { id: 'm', ctx: 200000, maxOut: 8000, price: { in: 5, out: 30, currency: 'USD' }, vision: true },
      }),
    );
    const snap = await b.run();
    // The mock reports a fixed 1200/2400 usage regardless of how small the
    // request was, which no real vendor does — so allow one wave of overshoot.
    assert.ok(snap.costUsd <= 0.02 * 1.8, `spent ${snap.costUsd} against a 0.02 cap`);
    assert.ok(snap.ok > 0);
  });

  await testAsync('request cap stops the run', async () => {
    const b = new Burner(cfgFor(port, { limitTokens: Infinity, limitRequests: 5, limitDurationMs: 20000 }));
    const snap = await b.run();
    assert.equal(snap.requests, 5);
  });

  await testAsync('stop() halts in-flight workers', async () => {
    const b = new Burner(cfgFor(port, { limitTokens: Infinity, limitDurationMs: 60000, limitUsd: Infinity }));
    const p = b.run();
    await new Promise((r) => setTimeout(r, 400));
    b.stop('test stop');
    const snap = await p;
    assert.equal(snap.state, 'done');
    assert.match(String(snap.stopReason), /test stop/);
  });

  await testAsync('anthropic protocol parses usage', async () => {
    const b = new Burner(
      cfgFor(port, { protocol: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, limitRequests: 3 }),
    );
    const snap = await b.run();
    assert.equal(snap.ok, 3);
    assert.ok(snap.input >= 3600, `input should be 1200×3, got ${snap.input}`);
    // Output can be slightly under 2400/request when the planner trims
    // max_tokens to stay inside a quota — that is the intended behaviour.
    assert.ok(snap.output >= 5000, `output should be near 7200, got ${snap.output}`);
  });

  await testAsync('gemini protocol parses usage', async () => {
    const b = new Burner(
      cfgFor(port, { protocol: 'gemini-generate', baseUrl: `http://127.0.0.1:${port}`, limitRequests: 2 }),
    );
    const snap = await b.run();
    assert.equal(snap.ok, 2);
    assert.ok(snap.total >= 7200, `expected ≥7200, got ${snap.total}`);
  });

  await testAsync('oversized max_tokens is adapted, not retried forever', async () => {
    const b = new Burner(cfgFor(port, { modelId: 'picky-model', limitRequests: 4 }));
    const snap = await b.run();
    assert.ok(snap.ok > 0, 'should recover after shrinking max_tokens');
    assert.ok(b.logs.some((l) => /adjusting to provider limits/.test(l.msg)));
  });

  await testAsync('empty account ends the run as "drained", not as an error', async () => {
    const b = new Burner(cfgFor(port, { modelId: 'drain-model', limitTokens: Infinity, limitRequests: 500 }));
    const snap = await b.run();
    assert.equal(snap.stopReason, 'account drained');
    assert.ok(snap.elapsedMs < 8000, 'should give up quickly rather than retry a dead account');
  });

  await testAsync('transient 5xx is retried and eventually succeeds', async () => {
    flakyHits = 0;
    // The call ceiling counts wire calls now, so two failed attempts plus one
    // success needs room for three.
    const b = new Burner(cfgFor(port, { modelId: 'flaky-model', limitRequests: 6, maxRetries: 2 }));
    const snap = await b.run();
    assert.ok(snap.retries >= 2, `expected retries, got ${snap.retries}`);
    assert.ok(snap.ok >= 1, 'should recover after the flaky window');
  });

  await testAsync('repeated failures shrink concurrency instead of hammering', async () => {
    const b = new Burner(cfgFor(port, { modelId: 'broken-model', concurrency: 4, limitRequests: 6, maxRetries: 0 }));
    await b.run();
    assert.ok(b.stats.degraded > 0, 'governor should have cooled down');
    assert.ok(b.permits < 4, `permits should shrink, got ${b.permits}`);
  });

  await testAsync('timeline is sampled and monotonic', async () => {
    const b = new Burner(cfgFor(port, { limitTokens: 40000, limitDurationMs: 20000 }));
    await b.run();
    assert.ok(b.timeline.length > 0, 'report needs at least one point');
    const last = b.timeline[b.timeline.length - 1];
    assert.ok(last.total > 0);
    assert.ok(last.t >= 0);
  });

  await testAsync('a small quota does not get inflated by the filler cache', async () => {
    const b = new Burner(
      cfgFor(port, { modelId: 'echo-model', limitTokens: 20000, limitRequests: 3, concurrency: 1, contextFill: 0.2 }),
    );
    const snap = await b.run();
    assert.ok(snap.ok > 0);
    const avgInput = snap.input / snap.ok;
    // The plan wants ~16k input per request; the cache bucket is 25k. Before the
    // trim, every request shipped 25k+ and blew the target.
    assert.ok(avgInput < 20000, `input per request should stay near plan, got ${Math.round(avgInput)}`);
    assert.ok(snap.total < 30000, `total should stay near the 20k target, got ${snap.total}`);
  });

  await testAsync('missing usage still charges the input we sent', async () => {
    const b = new Burner(
      cfgFor(port, { modelId: 'plain-model', limitTokens: 400000, limitRequests: 2, concurrency: 1 }),
    );
    const snap = await b.run();
    assert.ok(snap.ok > 0);
    assert.ok(snap.input > 1000, `input must not be zero when usage is absent, got ${snap.input}`);
    assert.ok(snap.costUsd > 0, 'cost must not be zero when usage is absent');
    assert.ok(snap.estimateOnly > 0, 'should be flagged as estimated');
  });

  await testAsync('retries cannot exceed the request ceiling', async () => {
    flakyHits = 0;
    wireHits = 0;
    const b = new Burner(cfgFor(port, { modelId: 'flaky-model', limitRequests: 1, maxRetries: 3 }));
    await b.run();
    assert.equal(wireHits, 1, `upstream must see 1 call, saw ${wireHits}`);
  });

  await testAsync('CRLF-framed streams are parsed', async () => {
    const b = new Burner(cfgFor(port, { modelId: 'crlf-model', limitRequests: 2 }));
    const snap = await b.run();
    assert.equal(snap.ok, 2);
    assert.ok(snap.input >= 1000, `expected 500×2 input, got ${snap.input}`);
  });

  await testAsync('dry run sends nothing and reports a plan', async () => {
    const b = new Burner(cfgFor(port, { dryRun: true, limitRequests: 1 }));
    const snap = await b.run();
    assert.equal(snap.requests, 0);
    assert.ok(b.logs.some((l) => /DRY RUN/.test(l.msg)));
  });

  server.close();

  /* ── report ── */
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  console.log('');
  let failed = 0;
  for (const [ok, name, err] of results) {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${pad(name, 52)} ${ok ? '' : err}`);
    if (!ok) failed++;
  }
  console.log(`\n  ${results.length - failed}/${results.length} passed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
