/**
 * Bounded, loopback-only regression checks for the throughput review.
 * Text/image usage comes from the project's estimators, not a live vendor.
 * Run directly, or as part of scripts/selftest.js.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Burner } from '../src/engine.js';
import { estimateTokens, trimFiller } from '../src/prompts.js';
import { estimateImageTokens } from '../src/images.js';
import { readSse } from '../src/protocols/http.js';

export async function runThroughputTests() {
  const results = [];
  let phase = '', records = [], active = 0, peak = 0, burner;
  const timers = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const kind = phase;
    const anthropic = req.url.includes('/messages');
    const gemini = req.url.includes('GenerateContent');
    const system = anthropic ? body.system : gemini ? body.systemInstruction.parts[0].text : body.messages[0].content;
    const parts = anthropic ? body.messages[0].content : gemini ? body.contents[0].parts : body.messages[1].content;
    const text = parts.filter(p => p.text != null).map(p => p.text).join('');
    const imageCount = parts.filter(p => p.type === 'image' || p.inlineData || p.type === 'image_url').length;
    const input = estimateTokens(system + text) + imageCount * estimateImageTokens(anthropic ? 'anthropic-messages' : gemini ? 'gemini-generate' : 'openai-chat', 1536, 1536);
    const out = body.max_completion_tokens ?? body.max_tokens ?? body.generationConfig?.maxOutputTokens;
    records.push({ input, out, imageCount, thinking: body.thinking, committed: burner.snapshot().committedUsd });
    active++;
    peak = Math.max(peak, active);
    res.once('close', () => active--);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = data => res.write('data: ' + JSON.stringify(data) + '\n\n');
      if (kind === 'stream-error' || kind === 'partial-error' || kind === 'rate-error') {
        if (kind === 'partial-error') {
          event({ type: 'message_start', message: { usage: { input_tokens: 900, output_tokens: 0 } } });
          event({ type: 'message_delta', usage: { output_tokens: 10 } });
        }
        const type = kind === 'rate-error' ? 'rate_limit_error' : 'overloaded_error';
        event({ type: 'error', error: { type, message: type } });
      } else if (anthropic) {
        event({ type: 'message_start', message: { usage: { input_tokens: input } } });
        event({ type: 'message_delta', usage: { output_tokens: out } });
        event({ type: 'message_stop' });
      } else if (gemini) {
        event({ usageMetadata: { promptTokenCount: input, candidatesTokenCount: out, totalTokenCount: input + out } });
      } else {
        const output = kind === 'short' ? 1 : out;
        event({ choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });
        res.write('data: [DONE]\n\n');
      }
      res.end();
    }, 50);
    timers.add(timer);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const cfg = overrides => ({
    providerId: 'mock', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:' + port + '/v1',
    apiKey: 'local-fixture', modelId: 'fixture',
    model: { id: 'fixture', ctx: 200000, maxOut: 8000, price: { in: 1, out: 2, currency: 'USD' }, vision: true },
    strategy: 'max-output', concurrency: 8, limitTokens: Infinity, limitUsd: Infinity,
    limitRequests: 8, limitDurationMs: 4000, contextFill: 0.05, imageShare: 0.6,
    imageCount: 0, imageSize: 1536, maxImagesPerRequest: 0, shortOutput: false,
    effort: null, thinkingBudget: 0, requestTimeoutMs: 2000, streamIdleMs: 1500,
    maxRetries: 0, dryRun: false, ...overrides,
  });
  async function run(kind, overrides = {}) {
    phase = kind; records = []; active = 0; peak = 0;
    burner = new Burner(cfg(overrides));
    const snap = await burner.run();
    assert.equal(snap.activeRequests, 0);
    assert.equal(burner.reservedRequests, 0);
    assert.ok(burner.reservedTokens < 1e-8);
    assert.ok(burner.reservedUsd < 1e-10);
    return snap;
  }
  async function check(name, fn) {
    try {
      await fn();
      results.push([true, name]);
    } catch (err) {
      results.push([false, name, err.message]);
    }
  }
  try {
    await check('minimum request cost refuses an unaffordable first call', async () => {
      const s = await run('money', { concurrency: 1, limitUsd: 0.00001, limitRequests: 1 });
      assert.equal(records.length, 0);
      assert.equal(s.wire, 0);
      assert.equal(s.costUsd, 0);
      assert.match(s.stopReason, /minimum request/);
    });
    await check('small remainder cannot trigger an unbudgeted final call', async () => {
      const s = await run('money', { concurrency: 1, limitUsd: 0.001 });
      assert.ok(records.length >= 1 && records.length <= 2);
      assert.ok(s.costUsd <= 0.001);
      assert.ok(records.every(r => r.committed <= 0.001 + 1e-12));
    });
    await check('money allocation opens actual HTTP slots within the cap', async () => {
      const s = await run('money', { limitUsd: 0.01 });
      assert.ok(peak >= 6, 'actual HTTP peak: ' + peak);
      assert.ok(s.peakActiveRequests >= 6);
      assert.ok(s.costUsd <= 0.01);
      assert.ok(records.every(r => r.committed <= 0.01 + 1e-12));
    });
    await check('images consume context exactly once', async () => {
      const s = await run('image', {
        protocol: 'anthropic-messages', baseUrl: 'http://127.0.0.1:' + port,
        model: { id: 'fixture', ctx: 32768, maxOut: 4096, price: { in: 1, out: 2, currency: 'USD' }, vision: true },
        strategy: 'image-bomb', concurrency: 1, limitRequests: 1, contextFill: 0.95,
        imageCount: 4, maxImagesPerRequest: 4,
      });
      assert.equal(records[0].imageCount, 4);
      assert.ok(s.input > 27500, 'underfilled context: ' + s.input);
      assert.ok(s.input + records[0].out <= 32768);
    });
    await check('image allocation respects a small money ceiling', async () => {
      const s = await run('image', {
        strategy: 'image-bomb', concurrency: 1, limitRequests: 1, imageCount: 4,
        maxImagesPerRequest: 4, limitUsd: 0.001,
      });
      assert.equal(records[0].imageCount, 0);
      assert.ok(s.costUsd <= 0.001);
    });
    await check('input-only mode reserves and sends a small output ceiling', async () => {
      const s = await run('short', {
        shortOutput: true, contextFill: 0.25, limitTokens: 16000,
        model: { id: 'fixture', ctx: 200000, maxOut: 128000, price: { in: 1, out: 2, currency: 'USD' } },
      });
      assert.equal(records.length, 8);
      assert.ok(records.every(r => r.out === 32));
      assert.ok(s.input > 9000, 'input quantity: ' + s.input);
      assert.ok(s.total <= 16000);
    });
    await check('input-only reasoning allowance cannot enable invalid thinking', async () => {
      await run('short', {
        protocol: 'anthropic-messages', baseUrl: 'http://127.0.0.1:' + port, concurrency: 1, limitRequests: 1,
        shortOutput: true, thinkingBudget: 40000,
        model: { id: 'fixture', ctx: 200000, maxOut: 128000, reasoning: true, price: { in: 1, out: 2, currency: 'USD' } },
      });
      assert.equal(records[0].out, 1024);
      assert.equal(records[0].thinking, undefined);
    });
    for (const protocol of ['openai-chat', 'anthropic-messages', 'gemini-generate']) {
      await check(protocol + ' stream errors fail without invented usage', async () => {
        const s = await run('stream-error', {
          protocol, baseUrl: 'http://127.0.0.1:' + port + (protocol === 'openai-chat' ? '/v1' : ''),
          concurrency: 4, limitRequests: 4,
        });
        assert.equal(s.ok, 0);
        assert.equal(s.failed, 4);
        assert.equal(s.total, 0);
        assert.equal(s.costUsd, 0);
        assert.equal(s.unknownUsage, 4);
        assert.ok(s.permits < 4);
        assert.ok(s.unconfirmedUsd > 0);
      });
    }
    await check('confirmed partial usage survives a bounded stream retry', async () => {
      const s = await run('partial-error', {
        protocol: 'anthropic-messages', baseUrl: 'http://127.0.0.1:' + port,
        concurrency: 1, limitRequests: 2, limitUsd: 0.1, maxRetries: 1,
      });
      assert.equal(s.wire, 2);
      assert.equal(s.ok, 0);
      assert.equal(s.input, 1800);
      assert.equal(s.output, 20);
      assert.equal(s.total, 1820);
      assert.equal(s.unknownUsage, 2);
      assert.ok(s.committedUsd <= 0.1);
    });
    await check('unknown stream cost prevents a retry spending the same budget', async () => {
      const s = await run('stream-error', {
        concurrency: 1, limitRequests: 8, limitUsd: 0.001, maxRetries: 2,
      });
      assert.equal(s.wire, 1);
      assert.equal(s.ok, 0);
      assert.equal(s.total, 0);
      assert.ok(s.committedUsd <= 0.001 + 1e-12);
    });
    await check('stream rate limits retain the cancellable deadline', async () => {
      const started = Date.now();
      const s = await run('rate-error', { concurrency: 1, limitDurationMs: 250 });
      assert.equal(s.throttled, 1);
      assert.equal(s.ok, 0);
      assert.ok(Date.now() - started < 1000);
    });
    await check('SSE callback exceptions propagate and unlock the reader', async () => {
      const res = new Response('data: {"type":"error"}\n\n');
      await assert.rejects(readSse(res, { onData() { throw new Error('callback failure'); } }), /callback failure/);
      assert.equal(res.body.locked, false);
    });
    await check('filler trimming keeps even tiny allocations within estimate', async () => {
      for (const size of [0, 1, 4, 32, 100]) {
        const text = trimFiller('中A🙂文ledger'.repeat(100), size);
        assert.ok(estimateTokens(text) <= size);
      }
    });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runThroughputTests();
  for (const [ok, name, message] of results) console.log((ok ? 'PASS ' : 'FAIL ') + name + (message ? ': ' + message : ''));
  const failures = results.filter(r => !r[0]).length;
  console.log((results.length - failures) + '/' + results.length + ' passed');
  process.exitCode = failures ? 1 : 0;
}
