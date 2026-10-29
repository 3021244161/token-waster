/**
 * The furnace.
 *
 * A Burner owns one run: a pool of workers that keep issuing requests until a
 * limit trips. Three things make it non-trivial:
 *
 *  1. *Pre-flight reservation.* With N workers in flight, "have we spent $5 yet"
 *     is only answerable if you reserve an estimate before each request and
 *     settle the difference against real `usage` afterwards. Commit-on-finish
 *     alone overshoots by up to N × request cost.
 *
 *  2. *Estimates are wrong, real usage is not.* Every number the UI shows is
 *     reconciled against what the API reported. When a vendor omits usage we
 *     fall back to character heuristics and say so.
 *
 *  3. *Stopping must be immediate.* A single AbortController is shared by every
 *     in-flight request; `stop()` aborts it, and workers unwind on their next
 *     loop check.
 */

import { EventEmitter } from 'node:events';
import { callProvider } from './protocols/index.js';
import { buildPayload, makeFiller } from './prompts.js';
import { makeImagePool, estimateImageTokens } from './images.js';
import { estimateCostUsd } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILLER_BUCKET = 25_000; // quantise filler sizes so we can reuse cached text
const MAX_FILLER_CACHE = 6;

export class Burner extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.model = cfg.model;
    this.state = 'idle';
    this.stopReason = null;

    this.ac = new AbortController();
    this.startedAt = 0;
    this.endedAt = 0;

    this.stats = {
      requests: 0,
      ok: 0,
      failed: 0,
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      total: 0,
      costUsd: 0,
      inflight: 0,
      peakInflight: 0,
      throttled: 0,
      estimateOnly: 0,
      lastError: '',
    };

    // Reservations (money/tokens promised to requests that have not returned yet)
    this.reservedTokens = 0;
    this.reservedUsd = 0;
    this.reservedRequests = 0;

    this.limits = {
      tokens: cfg.limitTokens ?? Infinity,
      usd: cfg.limitUsd ?? Infinity,
      requests: cfg.limitRequests ?? Infinity,
      ms: cfg.limitDurationMs ?? Infinity,
    };

    this.throttleUntil = 0;
    this.consecutive429 = 0;

    this.fillerCache = new Map();
    this.images = [];
    this.imgPerImage = 0;

    this.samples = [];
    this.timer = null;
    this.logs = [];
  }

  /* ── public ─────────────────────────────────────────────────────────────── */

  snapshot() {
    const now = Date.now();
    const elapsedMs = this.startedAt ? (this.endedAt || now) - this.startedAt : 0;
    const s = this.stats;
    const rate = this.#rate(now);

    return {
      state: this.state,
      stopReason: this.stopReason,
      elapsedMs,
      ...s,
      tokensPerSec: rate.tokensPerSec,
      requestsPerSec: rate.requestsPerSec,
      usdPerMin: rate.usdPerMin,
      limits: {
        tokens: fin(this.limits.tokens),
        usd: fin(this.limits.usd),
        requests: fin(this.limits.requests),
        ms: fin(this.limits.ms),
      },
      // Sent so a page reload can re-attach to the run in progress. Never
      // includes the API key — that value stays inside this process.
      config: {
        providerId: this.cfg.providerId,
        baseUrl: this.cfg.baseUrl,
        modelId: this.cfg.modelId,
        protocol: this.cfg.protocol,
        strategy: this.cfg.strategy,
        concurrency: this.cfg.concurrency,
        contextFill: this.cfg.contextFill,
        imageCount: this.cfg.imageCount,
        imageSize: this.cfg.imageSize,
        mtokens: fin(this.limits.tokens),
      },
      // Committed = settled + promised to in-flight requests.
      committedTokens: s.total + this.reservedTokens,
      committedUsd: s.costUsd + this.reservedUsd,
    };
  }

  stop(reason = 'user') {
    if (this.state === 'stopping' || this.state === 'done') return;
    this.stopReason = this.stopReason || reason;
    this.state = 'stopping';
    this.#log('warn', `stopping: ${reason}`);
    try {
      this.ac.abort();
    } catch {
      /* already aborted */
    }
  }

  async run() {
    this.state = 'running';
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.emit('tick', this.snapshot()), 250);
    this.#log('info', `target: ${describeLimits(this.limits)}`);
    this.#log('info', `model: ${this.cfg.modelId} (ctx ${this.model.ctx}, maxOut ${this.model.maxOut})`);
    this.#log('info', `strategy: ${this.cfg.strategy} · concurrency ${this.cfg.concurrency}`);

    try {
      if (this.cfg.dryRun) {
        await this.#dryRun();
      } else {
        await this.#prepareImages();
        const workers = Array.from({ length: this.cfg.concurrency }, (_, i) => this.#worker(i));
        await Promise.allSettled(workers);
      }
    } catch (err) {
      this.#log('error', `run aborted: ${err.message}`);
      this.stopReason = this.stopReason || 'error';
    } finally {
      this.endedAt = Date.now();
      this.state = 'done';
      clearInterval(this.timer);
      this.emit('tick', this.snapshot());
      this.emit('done', this.snapshot());
    }
    return this.snapshot();
  }

  /* ── workers ────────────────────────────────────────────────────────────── */

  async #worker(id) {
    while (!this.#shouldStop()) {
      if (this.throttleUntil > Date.now()) {
        await sleep(Math.min(5000, this.throttleUntil - Date.now()));
        continue;
      }

      const plan = this.#plan();
      if (!plan) {
        // No plan usually means "the budget is fully reserved by requests that
        // have not come back yet" — not that we are finished. Wait for a
        // settlement to release the difference before deciding to stop.
        if (this.stats.inflight > 0) {
          await sleep(80);
          continue;
        }
        this.stop(this.#reasonForLimits());
        return;
      }

      // Reserve before dispatch so N workers cannot collectively blow past the cap.
      this.reservedTokens += plan.estTokens;
      this.reservedUsd += plan.estUsd;
      this.reservedRequests += 1;

      const t0 = Date.now();
      this.stats.inflight++;
      this.stats.peakInflight = Math.max(this.stats.peakInflight, this.stats.inflight);

      let settled = false;
      try {
        const payload = buildPayload({
          fillerTokens: plan.fillerTokens,
          outputBias: plan.outputBias,
          filler: plan.fillerTokens > 0 ? this.#fillerFor(plan.fillerTokens) : '',
        });

        const res = await callProvider({
          protocol: this.cfg.protocol,
          baseUrl: this.cfg.baseUrl,
          apiKey: this.cfg.apiKey,
          model: this.cfg.modelId,
          apiVersion: this.cfg.apiVersion,
          payload,
          images: this.#pickImages(plan.imageCount),
          maxOutput: plan.maxOutput,
          effort: this.cfg.effort,
          thinkingBudget: this.cfg.thinkingBudget,
          signal: this.ac.signal,
          timeoutMs: this.cfg.requestTimeoutMs,
        });

        this.#settle(plan, res, Date.now() - t0);
        settled = true;
      } catch (err) {
        if (!settled) {
          this.reservedTokens -= plan.estTokens;
          this.reservedUsd -= plan.estUsd;
          this.reservedRequests -= 1;
        }
        this.#handleError(err, plan);
      } finally {
        this.stats.inflight--;
      }
    }
  }

  /* ── planning ───────────────────────────────────────────────────────────── */

  #plan() {
    if (this.#shouldStop()) return null;

    const model = this.model;
    const ctx = Math.max(4096, model.ctx);
    const remTokens = this.limits.tokens - this.stats.total - this.reservedTokens;
    const remUsd = this.limits.usd - this.stats.costUsd - this.reservedUsd;

    if (remTokens <= 512 || remUsd <= 0) return null;
    if (this.stats.requests + this.reservedRequests >= this.limits.requests) return null;

    const strategy = this.cfg.strategy;
    const wantImages = strategy === 'image-bomb' || strategy === 'mixed';

    // ── how many images fit in this request?
    let imageCount = 0;
    if (wantImages && this.images.length > 0 && this.imgPerImage > 0) {
      const imgShare = strategy === 'image-bomb' ? this.cfg.imageShare : Math.min(0.35, this.cfg.imageShare);
      const budgetForImages = Math.min(remTokens, ctx) * imgShare;
      imageCount = Math.min(
        this.images.length,
        this.cfg.maxImagesPerRequest,
        Math.max(0, Math.floor(budgetForImages / this.imgPerImage)),
      );
    }

    const imgTokens = imageCount * this.imgPerImage;

    // ── text split: fill the context, then let the model write as much as it can.
    //    Capped because filler is generated as a JS string and uploaded as JSON:
    //    a 10M-token window would mean ~24 MB of noise per request and seconds of
    //    CPU before the first byte leaves the machine.
    const ctxBudget = Math.min(ctx - imgTokens, this.cfg.maxFillerTokens ?? 250_000);
    let inputTokens = Math.floor(Math.max(0, ctxBudget) * this.cfg.contextFill);
    let maxOutput = model.maxOut;

    if (inputTokens + maxOutput + imgTokens > ctx) {
      inputTokens = Math.max(0, ctx - maxOutput - imgTokens);
    }

    // ── scale to whatever budget is left (exact-quota behaviour falls out of this)
    const wantTotal = inputTokens + maxOutput + imgTokens;
    if (wantTotal > remTokens) {
      const k = remTokens / wantTotal;
      inputTokens = Math.floor(inputTokens * k);
      maxOutput = Math.max(32, Math.floor(maxOutput * k));
    }

    // ── respect the money ceiling
    let estUsd = estimateCostUsd(model, { input: inputTokens + imgTokens, output: maxOutput });
    if (estUsd > remUsd) {
      const k = Math.max(0, remUsd / estUsd) * 0.98;
      inputTokens = Math.floor(inputTokens * k);
      maxOutput = Math.max(32, Math.floor(maxOutput * k));
      estUsd = estimateCostUsd(model, { input: inputTokens + imgTokens, output: maxOutput });
    }

    const fillerTokens = Math.max(0, inputTokens - imgTokens - 400); // ~400 for system+instruction
    const estTokens = inputTokens + maxOutput + imgTokens;

    if (maxOutput < 32) return null;

    return {
      maxOutput,
      imageCount,
      fillerTokens,
      outputBias: this.cfg.shortOutput ? 'min' : 'max',
      // Reservation carries a safety margin: if our token estimate is low (a
      // vision model billing more than the formula predicted), the overshoot is
      // absorbed here rather than showing up as an unbudgeted charge.
      estTokens: Math.round(estTokens * 1.05),
      estUsd: Math.max(0.0000001, estUsd * 1.15),
    };
  }

  #settle(plan, res, latencyMs) {
    const u = res.usage || {};
    const actualTokens = u.total || (u.input || 0) + (u.output || 0);
    const actualUsd = estimateCostUsd(this.model, {
      input: u.input || 0,
      output: u.output || 0,
      cached: u.cached || 0,
    });

    this.reservedTokens -= plan.estTokens;
    this.reservedUsd -= plan.estUsd;
    this.reservedRequests -= 1;

    const s = this.stats;
    s.requests++;
    s.ok++;
    s.input += u.input || 0;
    s.output += u.output || 0;
    s.cached += u.cached || 0;
    s.reasoning += u.reasoning || 0;
    s.total += actualTokens;
    s.costUsd += actualUsd;
    if (!u.reported) s.estimateOnly++;

    this.samples.push({ t: Date.now(), tokens: actualTokens, usd: actualUsd, req: 1 });
    this.consecutive429 = 0;

    this.#log(
      'ok',
      `+${fmt(actualTokens)} tok (in ${fmt(u.input || 0)} / out ${fmt(u.output || 0)}` +
        `${u.cached ? ` / cached ${fmt(u.cached)}` : ''}) · $${actualUsd.toFixed(4)} · ${latencyMs}ms · v${res.variant}`,
    );
  }

  #handleError(err, plan) {
    const s = this.stats;
    s.requests++;
    s.failed++;
    const msg = err?.message || String(err);
    s.lastError = msg;

    if (err?.name === 'AbortError' || this.ac.signal.aborted) {
      if (this.state !== 'stopping') this.#log('warn', 'request aborted');
      return;
    }

    if (err?.status === 429) {
      this.consecutive429++;
      this.stats.throttled++;
      const backoff = Math.min(30_000, (err.retryAfterMs || 0) || 1000 * 2 ** Math.min(5, this.consecutive429 - 1));
      this.throttleUntil = Date.now() + backoff;
      this.#log('warn', `429 rate limited — backing off ${Math.round(backoff / 1000)}s`);
      return;
    }

    if (err?.fatal) {
      this.#log('error', `fatal: ${msg}`);
      this.stop(`fatal: ${msg.slice(0, 160)}`);
      return;
    }

    this.#log('error', `request failed: ${msg.slice(0, 300)}`);
  }

  #shouldStop() {
    if (this.state === 'stopping' || this.state === 'done') return true;
    if (this.ac.signal.aborted) return true;
    if (Date.now() - this.startedAt >= this.limits.ms) {
      this.stop('time limit reached');
      return true;
    }
    return false;
  }

  #reasonForLimits() {
    const s = this.stats;
    if (s.total + this.reservedTokens >= this.limits.tokens) return 'token target reached';
    if (s.costUsd + this.reservedUsd >= this.limits.usd) return 'budget reached';
    if (s.requests + this.reservedRequests >= this.limits.requests) return 'request limit reached';
    return 'limits reached';
  }

  /* ── assets ─────────────────────────────────────────────────────────────── */

  async #prepareImages() {
    const want = this.cfg.strategy === 'image-bomb' || this.cfg.strategy === 'mixed';
    if (!want || this.model.vision === false || this.cfg.imageCount <= 0) {
      this.images = [];
      this.imgPerImage = 0;
      return;
    }

    const size = this.cfg.imageSize;
    this.images = makeImagePool(this.cfg.imageCount, size);
    this.imgPerImage = estimateImageTokens(this.cfg.protocol, size, size);
    const totalMb = (this.images.reduce((a, i) => a + i.bytes, 0) / 1048576).toFixed(2);
    this.#log(
      'info',
      `${this.images.length} images @ ${size}×${size} · ${totalMb} MB total · ≈${fmt(this.imgPerImage)} tok each`,
    );

    if (totalMb > 14) {
      this.#log('warn', 'image payload is large; some vendors cap request bodies at 20 MB — expect 413s');
    }
  }

  #pickImages(n) {
    if (n <= 0 || this.images.length === 0) return [];
    // Shuffle the first n so request bodies differ from one another.
    const pool = this.images.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, Math.min(n, pool.length));
  }

  #fillerFor(tokens) {
    const bucket = Math.round(tokens / FILLER_BUCKET) * FILLER_BUCKET;
    const key = Math.max(FILLER_BUCKET, bucket);
    const hit = this.fillerCache.get(key);
    if (hit) return hit;

    const text = makeFiller(key);
    this.fillerCache.set(key, text);
    if (this.fillerCache.size > MAX_FILLER_CACHE) {
      this.fillerCache.delete(this.fillerCache.keys().next().value);
    }
    return text;
  }

  /* ── dry run ────────────────────────────────────────────────────────────── */

  async #dryRun() {
    await this.#prepareImages();
    const plan = this.#plan();
    if (!plan) {
      this.#log('warn', 'nothing to plan');
      return;
    }
    const perReq = plan.estTokens;
    const perUsd = plan.estUsd;

    this.#log(
      'info',
      `DRY RUN — no requests will be sent.\n` +
        `  one request: input ≈ ${fmt(plan.fillerTokens + plan.imageCount * this.imgPerImage + 400)} tok, ` +
        `max output ${fmt(plan.maxOutput)} tok, images ${plan.imageCount}\n` +
        `  cost/request ≈ $${perUsd.toFixed(4)}\n` +
        `  concurrency ${this.cfg.concurrency} → ≈ ${fmt(Math.round(perReq * this.cfg.concurrency))} tok ` +
        `and ≈ $${(perUsd * this.cfg.concurrency).toFixed(4)} in flight per wave`,
    );

    this.stats.estimateOnly = 1;
    this.state = 'done';
  }

  /* ── misc ───────────────────────────────────────────────────────────────── */

  #rate(now) {
    const windowMs = 5000;
    this.samples = this.samples.filter((s) => now - s.t <= windowMs);
    const span = Math.max(1000, Math.min(windowMs, now - this.startedAt));
    const tok = this.samples.reduce((a, s) => a + s.tokens, 0);
    const usd = this.samples.reduce((a, s) => a + s.usd, 0);
    const req = this.samples.reduce((a, s) => a + s.req, 0);
    return {
      tokensPerSec: Math.round((tok / span) * 1000),
      requestsPerSec: Number(((req / span) * 1000).toFixed(2)),
      usdPerMin: Number(((usd / span) * 60000).toFixed(4)),
    };
  }

  #log(level, msg) {
    const entry = { at: Date.now(), level, msg };
    this.logs.push(entry);
    if (this.logs.length > 300) this.logs.shift();
    this.emit('log', entry);
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function fin(n) {
  return Number.isFinite(n) ? n : null;
}

function describeLimits(l) {
  const parts = [];
  if (Number.isFinite(l.tokens)) parts.push(`${fmt(l.tokens)} tokens`);
  if (Number.isFinite(l.usd)) parts.push(`$${l.usd}`);
  if (Number.isFinite(l.requests)) parts.push(`${fmt(l.requests)} requests`);
  if (Number.isFinite(l.ms)) parts.push(`${Math.round(l.ms / 1000)}s`);
  return parts.join(' · ') || 'unlimited (not recommended)';
}
