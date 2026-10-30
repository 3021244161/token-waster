/**
 * The furnace.
 *
 * A Burner owns one run: a pool of workers that keep issuing requests until a
 * limit trips. The non-obvious parts:
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
 *
 *  4. *Throughput is a function of health, not of the concurrency setting.* A
 *     provider that starts returning 500s does not get faster if you shout more
 *     requests at it — so permits are dynamic (see #observe). The worker count is
 *     the ceiling; the governor decides how many of them may be in flight.
 */

import { EventEmitter } from 'node:events';
import { callProvider } from './protocols/index.js';
import { buildPayload, makeFillerAsync, estimateTokens, trimFiller } from './prompts.js';
import { makeImagePoolAsync, estimateImageTokens } from './images.js';
import { estimateCostUsd } from './config.js';

const FILLER_BUCKET = 25_000; // quantise filler sizes so we can reuse cached text
const MAX_FILLER_CACHE = 6;
const MAX_TIMELINE = 2400;
const TOKEN_MARGIN = 1.05;
const COST_MARGIN = 1.15;
const MIN_OUTPUT = 32;

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
      // Every HTTP call actually made, retries and parameter-variant probing
      // included. This — not `requests` — is what the request ceiling counts,
      // otherwise a retry budget triples the real call count for free.
      wire: 0,
      retries: 0,
      degraded: 0,
      recovered: 0,
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      total: 0,
      costUsd: 0,
      inflight: 0,
      peakInflight: 0,
      activeRequests: 0,
      peakActiveRequests: 0,
      unknownUsage: 0,
      throttled: 0,
      estimateOnly: 0,
      lastError: '',
    };

    // Reservations (money/tokens promised to requests that have not returned yet)
    this.reservedTokens = 0;
    this.reservedUsd = 0;
    this.reservedRequests = 0;
    // Failed streams may already have been billed. Hold their unconfirmed
    // remainder against the budget without claiming it as measured consumption.
    this.unconfirmedTokens = 0;
    this.unconfirmedUsd = 0;

    this.limits = {
      tokens: cfg.limitTokens ?? Infinity,
      usd: cfg.limitUsd ?? Infinity,
      requests: cfg.limitRequests ?? Infinity,
      ms: cfg.limitDurationMs ?? Infinity,
    };

    this.throttleUntil = 0;
    this.consecutive429 = 0;
    this.limitAdjustments = 0;

    // Throughput governor
    this.permits = cfg.concurrency;
    /** Rolling health window (1 = success). Used to decide on recovery. */
    this.recent = [];
    this.lastRecoveryAt = 0;
    /** The parameter variant that last worked for this endpoint, or null. */
    this.variantProfile = null;
    // Requests physically on the wire. Distinct from `inflight`, which counts
    // *permits* — a worker waiting for budget still holds a permit.
    this.sending = 0;
    this.consecutiveFailures = 0;
    this.successStreak = 0;

    this.fillerCache = new Map();
    this.images = [];
    this.imgPerImage = 0;

    this.samples = [];
    this.timeline = [];
    this.latencies = [];
    this.lastSampleAt = 0;
    this.timer = null;
    this.logs = [];
  }

  /* ── public ─────────────────────────────────────────────────────────────── */

  snapshot() {
    const now = Date.now();
    const elapsedMs = this.startedAt ? (this.endedAt || now) - this.startedAt : 0;
    const s = this.stats;
    const rate = this.#rate(now);
    const attempted = s.ok + s.failed;

    return {
      state: this.state,
      stopReason: this.stopReason,
      elapsedMs,
      ...s,
      permits: this.permits,
      wire: s.wire,
      successRate: attempted ? Number((s.ok / attempted).toFixed(3)) : 1,
      latency: this.#latencyStats(),
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
        maxFillerTokens: this.cfg.maxFillerTokens ?? 250_000,
        imageCount: this.cfg.imageCount,
        imageSize: this.cfg.imageSize,
        mode: this.cfg.mode,
        mtokens: fin(this.limits.tokens),
      },
      // Committed includes unconfirmed interrupted calls as well as live ones.
      committedTokens: s.total + this.reservedTokens + this.unconfirmedTokens,
      committedUsd: s.costUsd + this.reservedUsd + this.unconfirmedUsd,
      unconfirmedTokens: this.unconfirmedTokens,
      unconfirmedUsd: this.unconfirmedUsd,
    };
  }

  /** Everything a report needs, without the API key. */
  report() {
    return {
      snapshot: this.snapshot(),
      timeline: this.timeline.slice(),
      logs: this.logs.slice(-240),
      model: {
        id: this.cfg.modelId,
        ctx: this.model.ctx,
        maxOut: this.model.maxOut,
        price: this.model.price,
      },
      provider: { id: this.cfg.providerId, label: this.cfg.providerLabel || this.cfg.providerId, baseUrl: this.cfg.baseUrl },
      startedAt: this.startedAt,
      endedAt: this.endedAt,
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
    this.lastSampleAt = this.startedAt;
    this.timer = setInterval(() => this.#tick(), 250);

    // A wall-clock deadline has to be independent of the worker loop: if every
    // worker is parked inside a slow response, nothing else would ever notice
    // that the run's time budget expired.
    if (Number.isFinite(this.limits.ms) && this.limits.ms < 2 ** 31 - 1) {
      this.deadlineTimer = setTimeout(() => this.stop('time limit reached'), this.limits.ms);
    }
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
      clearTimeout(this.deadlineTimer);
      this.#sample(true);
      this.emit('tick', this.snapshot());
      this.emit('done', this.snapshot());
    }
    return this.snapshot();
  }

  /**
   * Sleep that `stop()` can interrupt. A plain setTimeout keeps the worker (and
   * the UI, which stays in "stopping") for the full delay even after the user has
   * cancelled — up to 30 s during a rate-limit backoff.
   */
  #sleep(ms) {
    return new Promise((resolve) => {
      if (this.ac.signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        this.ac.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.ac.signal.addEventListener('abort', done, { once: true });
    });
  }

  /* ── workers ────────────────────────────────────────────────────────────── */

  async #worker(id) {
    while (!this.#shouldStop()) {
      if (!(await this.#acquire())) return;

      try {
        if (this.throttleUntil > Date.now()) {
          await this.#sleep(Math.min(5000, this.throttleUntil - Date.now()));
          if (!this.#shouldStop()) continue;
          return;
        }

        const plan = this.#plan();
        if (!plan) {
          // No plan usually means "the budget is fully reserved by requests that
          // have not come back yet" — not that we are finished. Wait for a
          // settlement to release the difference before deciding to stop.
          // The test has to be on `sending`, not `inflight`: every waiting
          // worker holds a permit, so `inflight` never drains and this would
          // deadlock the moment the budget is exhausted.
          if (this.sending > 0) {
            await this.#sleep(80);
            continue;
          }
          this.stop(this.#reasonForLimits());
          return;
        }

        // Reserve before dispatch so N workers cannot collectively blow past the cap.
        if (!this.#reservePlan(plan)) continue;

        const t0 = Date.now();
        this.sending++;
        try {
          const res = await this.#execute(plan);
          this.#settle(plan, res, Date.now() - t0);
        } catch (err) {
          this.#releasePlan(plan);
          this.#handleError(err, plan);
        } finally {
          this.sending--;
        }
      } finally {
        this.#release();
      }
    }
  }

  /**
   * Send one request, retrying transient failures.
   *
   * Retries are deliberately short (250–750ms): the whole point of this tool is
   * throughput, so a request that takes a second to retry has already cost more
   * than the failed attempt saved. 429 is excluded on purpose — that needs a
   * *global* pause, which the throttle handles, not one worker spinning.
   */
  async #execute(plan) {
    const payload = plan.payload;
    const filler = plan.fillerTokens > 0 ? await this.#fillerFor(plan.fillerTokens) : '';
    payload.filler = filler ? '\n\n' + filler + '\n\n' : '\n\n';
    const images = this.#pickImages(plan.imageCount);
    const maxAttempts = Math.max(0, this.cfg.maxRetries ?? 2);

    let lastErr;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      try {
        if (!plan.reserved && !this.#reservePlan(plan)) {
          const err = new Error('remaining budget cannot cover retry');
          err.budgetStop = true;
          throw err;
        }
        return await callProvider({
          protocol: this.cfg.protocol,
          baseUrl: this.cfg.baseUrl,
          apiKey: this.cfg.apiKey,
          model: this.cfg.modelId,
          apiVersion: this.cfg.apiVersion,
          payload,
          images,
          maxOutput: plan.maxOutput,
          effort: this.cfg.effort,
          thinkingBudget: this.cfg.shortOutput ? 0 : this.cfg.thinkingBudget,
          signal: this.ac.signal,
          timeoutMs: this.cfg.requestTimeoutMs,
          streamIdleMs: this.cfg.streamIdleMs,
          // Every variant probe and retry inside the adapter calls this, so the
          // ceiling counts real HTTP requests rather than logical calls.
          beforeSend: () => this.#reserveCall(),
          afterSend: () => { this.stats.activeRequests = Math.max(0, this.stats.activeRequests - 1); },
          preferredVariant: this.variantProfile,
        });
      } catch (err) {
        if (err.budgetStop && lastErr) throw lastErr;
        lastErr = err;
        if (err.streamFailure) {
          this.#releasePlan(plan);
          this.#accountInterrupted(plan, err.partialUsage);
        }
        if (this.ac.signal.aborted) throw err;
        if (!this.#shouldRetry(err) || attempt === maxAttempts) throw err;

        this.stats.retries++;
        const wait = this.#retryDelay(err, attempt);
        this.#log('warn', `retry ${attempt + 1}/${maxAttempts} in ${wait}ms — ${short(err.message)}`);
        await this.#sleep(wait);
        if (this.ac.signal.aborted) throw err;
      }
    }
    throw lastErr;
  }

  /** Count one real HTTP request against the call ceiling, or refuse it. */
  #reserveCall() {
    if (this.#shouldStop() || this.stats.wire >= this.limits.requests ||
        this.stats.total + this.reservedTokens + this.unconfirmedTokens > this.limits.tokens ||
        this.stats.costUsd + this.reservedUsd + this.unconfirmedUsd > this.limits.usd + 1e-12) {
      const e = new Error('request budget exhausted');
      e.budgetStop = true;
      throw e;
    }
    this.stats.wire++;
    this.stats.activeRequests++;
    this.stats.peakActiveRequests = Math.max(this.stats.peakActiveRequests, this.stats.activeRequests);
  }

  #reservePlan(plan) {
    if (this.stats.total + this.reservedTokens + this.unconfirmedTokens + plan.estTokens > this.limits.tokens ||
        this.stats.costUsd + this.reservedUsd + this.unconfirmedUsd + plan.estUsd > this.limits.usd + 1e-12) return false;
    this.reservedTokens += plan.estTokens;
    this.reservedUsd += plan.estUsd;
    this.reservedRequests++;
    plan.reserved = true;
    return true;
  }

  #releasePlan(plan) {
    if (!plan.reserved) return;
    this.reservedTokens = Math.max(0, this.reservedTokens - plan.estTokens);
    this.reservedUsd = Math.max(0, this.reservedUsd - plan.estUsd);
    this.reservedRequests = Math.max(0, this.reservedRequests - 1);
    plan.reserved = false;
  }

  #shouldRetry(err) {
    if (!err) return false;
    if (err.drained) return false; // account is empty; retrying just wastes time
    if (err.status === 429) return false; // global throttle owns this
    if (err.fatal && !err.retryable) return false; // 401/403/404 will not heal
    if (err.retryable) return true;
    return err.name === 'StallError' || err.name === 'TypeError' || err.name === 'TimeoutError';
  }

  #retryDelay(err, attempt) {
    // Honour the vendor's own Retry-After as a floor. Shortening it just buys
    // another rejection and burns the call budget twice.
    if (err.retryAfterMs) return Math.min(err.retryAfterMs, 120_000);
    return Math.round(250 * 2 ** attempt + Math.random() * 250);
  }

  /**
   * Concurrency permit. The worker count is the hard ceiling; this is the
   * throttle the governor actually moves. Acquire is atomic because there is no
   * await between the check and the increment.
   */
  async #acquire() {
    while (!this.#shouldStop()) {
      if (this.stats.inflight < this.permits) {
        this.stats.inflight++;
        this.stats.peakInflight = Math.max(this.stats.peakInflight, this.stats.inflight);
        return true;
      }
      await this.#sleep(40);
    }
    return false;
  }

  #release() {
    this.stats.inflight = Math.max(0, this.stats.inflight - 1);
  }

  /* ── planning ───────────────────────────────────────────────────────────── */

  #plan() {
    if (this.#shouldStop()) return null;

    const model = this.model;
    const ctx = Math.max(4096, model.ctx);
    const remTokens = this.limits.tokens - this.stats.total - this.reservedTokens - this.unconfirmedTokens;
    const remUsd = this.limits.usd - this.stats.costUsd - this.reservedUsd - this.unconfirmedUsd;
    if (this.stats.wire >= this.limits.requests) return null;

    // Build the fixed content once, then reserve what will actually be sent.
    // Scaling a notional 400-token overhead to zero never removes the nonce or
    // instructions from the wire. The envelope covers protocol wrappers.
    const outputBias = this.cfg.shortOutput ? 'min' : 'max';
    const payload = buildPayload({ fillerTokens: 0, outputBias });
    const overhead = estimateTokens(payload.system + '\n\n\n\n' + payload.instruction) + 64;
    const minTotal = overhead + MIN_OUTPUT;
    const minUsd = estimateCostUsd(model, { input: overhead, output: MIN_OUTPUT });
    if (Math.ceil(minTotal * TOKEN_MARGIN) > remTokens || minUsd * COST_MARGIN > remUsd) {
      this.noPlanReason = 'remaining budget below minimum request cost';
      return null;
    }

    // Keep the existing total-quantity granularity, while splitting money by
    // unoccupied slots. Reduce the slot count when only a few minimum requests
    // can fit, rather than dividing each share below the cost of a legal call.
    const affordableTokens = Number.isFinite(remTokens) ? Math.floor(remTokens / Math.ceil(minTotal * TOKEN_MARGIN)) : Infinity;
    const affordableUsd = minUsd > 0 ? Math.floor(remUsd / (minUsd * COST_MARGIN)) : Infinity;
    const slots = Math.max(1, Math.min(this.permits - this.sending, this.limits.requests - this.stats.wire, affordableTokens, affordableUsd));
    const tokenBudget = Number.isFinite(remTokens)
      ? Math.min(Math.floor(remTokens / TOKEN_MARGIN), Math.max(minTotal, Math.floor(remTokens / this.permits / TOKEN_MARGIN)))
      : Infinity;
    const moneyBudget = remUsd / slots / COST_MARGIN;

    const strategy = this.cfg.strategy;
    const wantImages = strategy === 'image-bomb' || strategy === 'mixed';
    let imageCount = 0;
    if (wantImages && this.images.length && this.imgPerImage > 0) {
      const imgShare = strategy === 'image-bomb' ? this.cfg.imageShare : Math.min(0.35, this.cfg.imageShare);
      const span = Math.min(tokenBudget, ctx);
      const byShare = Math.floor(span * imgShare / this.imgPerImage);
      const bySpace = Math.floor((span - minTotal) / this.imgPerImage);
      const imageUsd = estimateCostUsd(model, { input: this.imgPerImage });
      const byMoney = imageUsd > 0 ? Math.floor((moneyBudget - minUsd) / imageUsd) : Infinity;
      imageCount = Math.max(0, Math.min(this.images.length, this.cfg.maxImagesPerRequest, byShare, bySpace, byMoney));
    }
    const imgTokens = imageCount * this.imgPerImage;

    // Reasoning models keep a small allowance for internal work. Manual
    // thinking is disabled in input-only mode; it must not consume that reserve.
    const shortLimit = model.reasoning || this.cfg.effort ? 1024 : MIN_OUTPUT;
    const desiredOutput = Math.min(model.maxOut, this.cfg.shortOutput ? shortLimit : model.maxOut, ctx - overhead - imgTokens);
    if (desiredOutput < MIN_OUTPUT) return null;
    const desiredText = Math.max(overhead, Math.min(Math.floor((ctx - imgTokens) * this.cfg.contextFill), this.cfg.maxFillerTokens ?? 250_000));
    let fillerTokens = Math.max(0, Math.min(desiredText - overhead, ctx - imgTokens - overhead - desiredOutput));
    const extraOutput = desiredOutput - MIN_OUTPUT;
    const fixedTokens = overhead + imgTokens + MIN_OUTPUT;
    const fixedUsd = estimateCostUsd(model, { input: overhead + imgTokens, output: MIN_OUTPUT });
    const flexibleUsd = estimateCostUsd(model, { input: fillerTokens, output: extraOutput });
    const flexibleTokens = fillerTokens + extraOutput;
    const scale = Math.max(0, Math.min(
      1,
      flexibleTokens > 0 ? (tokenBudget - fixedTokens) / flexibleTokens : 1,
      flexibleUsd > 0 ? (moneyBudget - fixedUsd) / flexibleUsd : 1,
    ));
    fillerTokens = Math.floor(fillerTokens * scale);
    const maxOutput = MIN_OUTPUT + Math.floor(extraOutput * scale);

    // Reserve first; actual preparation yields to cancellation. Exact trimming
    // guarantees the generated filler never exceeds this estimate.
    const estInput = overhead + fillerTokens + imgTokens;
    const estTokens = Math.ceil((estInput + maxOutput) * TOKEN_MARGIN);
    const estUsd = estimateCostUsd(model, { input: estInput, output: maxOutput }) * COST_MARGIN;
    if (estTokens > remTokens || estUsd > remUsd + 1e-12 || estInput + maxOutput > ctx) {
      this.noPlanReason = 'remaining budget below minimum request cost';
      return null;
    }

    return { maxOutput, imageCount, fillerTokens, outputBias, payload, estInput, estOutput: maxOutput, estTokens, estUsd };
  }

  #accountInterrupted(plan, usage) {
    // Only confirmed components enter the consumption meter. The unknown
    // remainder stays committed, preventing retries from spending it twice.
    const input = usage?.reported ? usage.input || 0 : 0;
    const output = usage?.reported ? usage.output || 0 : 0;
    const total = Math.max(usage?.reported ? usage.total || 0 : 0, input + output);
    const usd = estimateCostUsd(this.model, { input, output, cached: usage?.cached || 0 });
    this.stats.input += input;
    this.stats.output += output;
    this.stats.cached += usage?.cached || 0;
    this.stats.reasoning += usage?.reasoning || 0;
    this.stats.total += total;
    this.stats.costUsd += usd;
    this.stats.unknownUsage++;
    this.unconfirmedTokens += Math.max(0, plan.estTokens - total);
    this.unconfirmedUsd += Math.max(0, plan.estUsd - usd);
    if (total || usd) this.samples.push({ t: Date.now(), tokens: total, usd, req: 0 });
  }

  #settle(plan, res, latencyMs) {
    const u = res.usage || {};
    // When the vendor omits `usage`, the adapters can only guess the output from
    // the text it received — the input side has to come from what we sent. Left
    // at zero it quietly refunded the entire prompt cost of every un-metered
    // request, which is exactly the number that matters most here.
    const inTok = u.input || (u.reported ? 0 : plan.estInput || 0);
    const outTok = u.output || 0;
    // Never let a partial reported total win over the components we actually
    // know: a vendor that reports only `completion_tokens` used to leave
    // `total` at 1 while the ledger had 2,049 input tokens.
    const actualTokens = Math.max(u.reported ? u.total || 0 : 0, inTok + outTok);
    const actualUsd = estimateCostUsd(this.model, {
      input: inTok,
      output: outTok,
      cached: u.cached || 0,
    });

    this.#releasePlan(plan);

    const s = this.stats;
    s.requests++;
    s.ok++;
    s.input += inTok;
    s.output += outTok;
    s.cached += u.cached || 0;
    s.reasoning += u.reasoning || 0;
    s.total += actualTokens;
    s.costUsd += actualUsd;
    if (!u.reported) s.estimateOnly++;

    this.samples.push({ t: Date.now(), tokens: actualTokens, usd: actualUsd, req: 1 });
    this.consecutive429 = 0;

    // Remember which parameter shape this endpoint accepted. Re-probing two known
    // bad shapes on every call means uploading the same large body three times.
    if (Number.isInteger(res.variant) && res.variant !== this.variantProfile) {
      if (this.variantProfile !== null) this.#log('info', `parameter variant → v${res.variant}`);
      this.variantProfile = res.variant;
    }

    this.#observe(true, latencyMs);

    this.#log(
      'ok',
      `+${fmt(actualTokens)} tok (in ${fmt(inTok)} / out ${fmt(outTok)}` +
        `${u.cached ? ` / cached ${fmt(u.cached)}` : ''}) · $${actualUsd.toFixed(4)} · ${latencyMs}ms · v${res.variant}`,
    );
  }

  #handleError(err, plan) {
    const s = this.stats;
    const msg = err?.message || String(err);
    // Not a failure: the worker just discovered the call ceiling from below.
    // The next #plan() returns null and the run winds down normally.
    if (err?.budgetStop) return;

    if (err?.name === 'AbortError' || this.ac.signal.aborted) {
      s.requests++;
      s.failed++;
      s.lastError = msg;
      if (this.state !== 'stopping') this.#log('warn', 'request aborted');
      return;
    }

    // A 400 that says "too many tokens" is not a broken key, it is a catalog
    // value that does not match this account's model. Shrink the offending
    // number and retry instead of burning the rest of the run on failures.
    if ((err?.status === 400 || err?.status === 422) && this.#adaptLimits(msg)) {
      this.#log('warn', `adjusting to provider limits: ctx ${this.model.ctx}, maxOut ${this.model.maxOut}`);
      return;
    }

    s.requests++;
    s.failed++;
    s.lastError = msg;
    this.#observe(false);

    if (err?.drained) {
      // 无忧燃尽 ends here, and this is a success state, not an error.
      this.stopReason = 'account drained';
      this.#log('error', `账户已燃尽 — ${short(msg, 200)}`);
      this.stop('account drained');
      return;
    }

    if (err?.status === 429) {
      this.consecutive429++;
      this.stats.throttled++;

      const hint = err.retryAfterMs || 0;
      const remaining = this.limits.ms - (Date.now() - this.startedAt);
      // Waiting past the run's own deadline is pointless: end cleanly instead of
      // sitting in a sleep that can no longer produce anything.
      if (hint > 0 && Number.isFinite(remaining) && hint >= remaining) {
        this.stop('rate limited beyond run deadline');
        return;
      }

      const backoff = hint > 0 ? hint : Math.min(30_000, 1000 * 2 ** Math.min(5, this.consecutive429 - 1));
      this.throttleUntil = Date.now() + backoff;
      this.#log('warn', `429 rate limited — backing off ${Math.round(backoff / 1000)}s`);
      return;
    }

    if (err?.fatal) {
      this.#log('error', `fatal: ${msg}`);
      this.stop(`fatal: ${msg.slice(0, 160)}`);
      return;
    }

    this.#log('error', `request failed: ${short(msg, 300)}`);
  }

  /**
   * Throughput governor.
   *
   * Two straight failures halve the permits; five in a row trip a short circuit
   * breaker. Twelve clean requests in a row buy one permit back. The point is
   * that a degraded provider makes the tool quieter, not slower-but-louder —
   * hammering a 500ing endpoint just multiplies wasted requests.
   */
  #observe(ok, latencyMs = 0) {
    this.recent.push(ok ? 1 : 0);
    if (this.recent.length > 20) this.recent.shift();

    if (ok) {
      this.consecutiveFailures = 0;
      this.successStreak++;
      if (latencyMs) {
        this.latencies.push(latencyMs);
        if (this.latencies.length > 200) this.latencies.shift();
      }

      // Recovery keys off a rolling success *rate*, not a streak. A provider that
      // fails one request in ten never produces twelve consecutive successes, so
      // a streak-based rule would leave concurrency pinned at 1 forever.
      const n = this.recent.length;
      const rate = n ? this.recent.reduce((a, b) => a + b, 0) / n : 1;
      const cooled = Date.now() - this.lastRecoveryAt > 3000;

      if (n >= 8 && rate >= 0.8 && cooled && this.permits < this.cfg.concurrency) {
        this.permits++;
        this.lastRecoveryAt = Date.now();
        this.stats.recovered++;
        this.#log('info', `recovering concurrency → ${this.permits} (success ${Math.round(rate * 100)}%)`);
      }
      return;
    }

    this.successStreak = 0;
    this.consecutiveFailures++;

    if (this.consecutiveFailures >= 2 && this.permits > 1) {
      const next = Math.max(1, Math.floor(this.permits / 2));
      if (next < this.permits) {
        this.permits = next;
        this.stats.degraded++;
        this.#log('warn', `cooling down: concurrency → ${this.permits} (${this.consecutiveFailures} straight failures)`);
      }
    }

    if (this.consecutiveFailures >= 5) {
      const pause = Math.min(15_000, 2000 * (this.consecutiveFailures - 4));
      this.throttleUntil = Math.max(this.throttleUntil, Date.now() + pause);
      this.#log('warn', `circuit open — pausing ${Math.round(pause / 1000)}s`);
    }
  }

  /**
   * Detect "your number is bigger than ours" 400s and shrink it.
   * Bounded to a handful of adjustments so a genuinely broken config still
   * surfaces as errors instead of looping forever.
   */
  #adaptLimits(msg) {
    if (this.limitAdjustments >= 6) return false;
    const m = msg.toLowerCase();

    const contextish = /context|too long|length limit|reduce the length|超过|过长/.test(m);
    const outputish = /max_tokens|max_completion_tokens|maxoutputtokens|output token|maximum.*output|输出/.test(m);

    if (contextish && this.model.ctx > 8192) {
      this.model.ctx = Math.floor(this.model.ctx * 0.5);
      this.limitAdjustments++;
      this.fillerCache.clear();
      return true;
    }
    if (outputish && this.model.maxOut > 512) {
      this.model.maxOut = Math.floor(this.model.maxOut * 0.5);
      this.limitAdjustments++;
      return true;
    }
    return false;
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
    if (s.total + this.reservedTokens + this.unconfirmedTokens >= this.limits.tokens) return 'token target reached';
    if (s.costUsd + this.reservedUsd + this.unconfirmedUsd >= this.limits.usd) return 'budget reached';
    if (s.wire >= this.limits.requests) return 'request limit reached';
    if (this.noPlanReason) return this.noPlanReason;
    return 'run complete';
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
    // Yield between images: a 4096² encode is ~300 ms of blocking CPU, so a pool
    // built in one go froze the HTTP thread and stop requests had to queue behind
    // it. Cancellation is honoured too.
    this.images = await makeImagePoolAsync(this.cfg.imageCount, size, { signal: this.ac.signal });
    if (this.images.length === 0) {
      this.#log('warn', 'image preparation cancelled');
      return;
    }
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

  async #fillerFor(tokens) {
    if (tokens <= 0) return '';

    // Bucket upwards so a 1k request can still reuse a cached 25k blob, then
    // trim to what this request actually planned. Handing over the whole bucket
    // was a 25× overshoot on small quotas — it blew both the token target and the
    // context window.
    const key = Math.max(FILLER_BUCKET, Math.ceil(tokens / FILLER_BUCKET) * FILLER_BUCKET);
    let pending = this.fillerCache.get(key);

    if (!pending) {
      pending = makeFillerAsync(key, { signal: this.ac.signal });
      this.fillerCache.set(key, pending);
      if (this.fillerCache.size > MAX_FILLER_CACHE) {
        this.fillerCache.delete(this.fillerCache.keys().next().value);
      }
    }

    return trimFiller(await pending, tokens);
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
        `  one request: input ≈ ${fmt(plan.estInput)} tok, ` +
        `max output ${fmt(plan.maxOutput)} tok, images ${plan.imageCount}\n` +
        `  cost/request ≈ $${perUsd.toFixed(4)}\n` +
        `  concurrency ${this.cfg.concurrency} → ≈ ${fmt(Math.round(perReq * this.cfg.concurrency))} tok ` +
        `and ≈ $${(perUsd * this.cfg.concurrency).toFixed(4)} in flight per wave`,
    );

    this.stats.estimateOnly = 1;
    this.state = 'done';
  }

  /* ── telemetry ──────────────────────────────────────────────────────────── */

  #tick() {
    this.#sample(false);
    this.emit('tick', this.snapshot());
  }

  /** One point per second, at most MAX_TIMELINE points (decimated when full). */
  #sample(force) {
    const now = Date.now();
    if (!force && now - this.lastSampleAt < 1000) return;
    this.lastSampleAt = now;
    if (!this.startedAt) return;

    const s = this.stats;
    this.timeline.push({
      t: now - this.startedAt,
      total: s.total,
      input: s.input,
      output: s.output,
      cost: Number(s.costUsd.toFixed(6)),
      req: s.requests,
      rate: this.#rate(now).tokensPerSec,
    });

    if (this.timeline.length > MAX_TIMELINE) {
      // Keep every other point: halves resolution, doubles the window.
      this.timeline = this.timeline.filter((_, i) => i % 2 === 0);
    }
  }

  #latencyStats() {
    if (this.latencies.length === 0) return { p50: 0, p90: 0, p99: 0, avg: 0 };
    const sorted = this.latencies.slice().sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
    return { p50: at(0.5), p90: at(0.9), p99: at(0.99), avg };
  }

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
    if (this.logs.length > 400) this.logs.shift();
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

function short(s, n = 140) {
  const t = String(s || '').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function describeLimits(l) {
  const parts = [];
  if (Number.isFinite(l.tokens)) parts.push(`${fmt(l.tokens)} tokens`);
  if (Number.isFinite(l.usd)) parts.push(`$${l.usd}`);
  if (Number.isFinite(l.requests)) parts.push(`${fmt(l.requests)} requests`);
  if (Number.isFinite(l.ms)) parts.push(`${Math.round(l.ms / 1000)}s`);
  return parts.join(' · ') || 'unlimited (not recommended)';
}
