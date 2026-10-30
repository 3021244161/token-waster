/** Local HTTP contract checks; every run is dry and never contacts a provider. */
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { writeSse } from '../src/sse.js';

export async function runServerTests() {
  const results = [];
  async function check(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err.message]); }
  }
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore',
  });
  const base = 'http://127.0.0.1:' + port;
  const post = body => fetch(base + '/api/run/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: 'openai', modelId: 'fixture', apiKey: 'local-fixture', confirm: 'WASTE', dryRun: true,
      baseUrl: base + '/no-provider', concurrency: 1, contextFill: 0.2,
      model: { ctx: 4096, maxOut: 512, priceIn: 1, priceOut: 2, currency: 'USD' },
      ...body,
    }), signal: AbortSignal.timeout(3000),
  });
  const status = async () => (await fetch(base + '/api/run/status')).json();
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error('test server exited during startup');
      try { ready = (await fetch(base + '/api/bootstrap', { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'test server failed to start');
    await check('HTTP duration targets work without frontend guard translation', async () => {
      assert.equal((await post({ mode: 'time', targetValue: 120 })).status, 202);
      assert.equal((await status()).limits.ms, 120000);
    });
    await check('HTTP duration targets preserve stricter user guards', async () => {
      assert.equal((await post({ mode: 'time', targetValue: 120, guards: { maxDurationSec: 2 } })).status, 202);
      assert.equal((await status()).limits.ms, 2000);
      assert.equal((await post({ mode: 'time', targetValue: 0 })).status, 400);
    });
    await check('non-USD money targets require another independent guard', async () => {
      const body = { mode: 'usd', targetValue: 1, model: { ctx: 4096, maxOut: 512, priceIn: 1, priceOut: 2, currency: 'CNY' } };
      const rejected = await post(body);
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /时长或请求数/);
      assert.equal((await post({ ...body, guards: { maxRequests: 1 } })).status, 202);
      assert.equal((await status()).limits.requests, 1);
    });
    await check('unknown currencies are rejected instead of silently using USD', async () => {
      assert.equal((await post({ mode: 'time', targetValue: 1, model: { currency: 'XYZ' } })).status, 400);
    });
    await check('HTTP text ceiling is exposed, bounded, and preserved in status', async () => {
      assert.equal((await post({ mode: 'time', targetValue: 1, maxFillerTokens: 50000 })).status, 202);
      assert.equal((await status()).config.maxFillerTokens, 50000);
      assert.equal((await post({ mode: 'time', targetValue: 1, maxFillerTokens: 999999999 })).status, 202);
      assert.equal((await status()).config.maxFillerTokens, 2000000);
      assert.equal((await status()).wire, 0);
    });
    await check('SSE backpressure destroys the bounded stream buffer', async () => {
      const stream = new PassThrough({ highWaterMark: 8 });
      assert.equal(writeSse(stream, 'x'.repeat(32)), false);
      assert.equal(stream.destroyed, true);
    });
    await check('SSE disconnections cannot break broadcasts to other readers', async () => {
      let destroyed = false;
      assert.equal(writeSse({ write() { throw new Error('closed'); }, destroy() { destroyed = true; } }, 'event'), false);
      assert.equal(destroyed, true);
    });
    await check('healthy SSE readers keep receiving events', async () => {
      let written = '', destroyed = false;
      assert.equal(writeSse({ write(data) { written += data; return true; }, destroy() { destroyed = true; } }, 'event'), true);
      assert.equal(written, 'event');
      assert.equal(destroyed, false);
    });
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runServerTests();
  for (const [ok, name, message] of results) console.log((ok ? 'PASS ' : 'FAIL ') + name + (message ? ': ' + message : ''));
  const failures = results.filter(r => !r[0]).length;
  console.log((results.length - failures) + '/' + results.length + ' passed');
  process.exitCode = failures ? 1 : 0;
}
