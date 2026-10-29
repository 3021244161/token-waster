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

function startMock() {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '';
    let raw = '';
    for await (const c of req) raw += c;

    if (url.startsWith('/v1/chat/completions')) {
      const body = JSON.parse(raw);
      const maxOut = body.max_completion_tokens ?? body.max_tokens ?? 100;
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
