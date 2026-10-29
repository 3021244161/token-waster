# 🔥 token-waster

> A deliberately wasteful load generator for your own LLM API keys.
> Concurrency, full context, max output, cache-busting, giant images — then it
> shows you the receipt.
> **It produces nothing. Every completion is discarded the moment it arrives.**

<p align="center">
  <img src="docs/screenshot.png" alt="token-waster" width="900">
</p>

---

## Read this first

This is not an AI tool. It has no use case beyond cost.

- **Whose money** — yours. You bring the API key; the bill lands on your account.
- **Output** — none. Not one token is kept.
- **Where the key goes** — into this Node process's memory. Not to disk, not to
  a log, not anywhere else. Close the process and it is gone.
- **Runaway protection** — a run with no hard ceiling is rejected by the server.
  Money, token, request and duration caps all apply simultaneously; whichever
  trips first stops everything. You cannot turn this off from the UI.
- **Don't** use this to evade a provider's quota or terms. Some vendors forbid
  automated abuse. Your account, your consequences.
- **Liability** — none. MIT, no warranty.

If you were just going to "try it quickly", close the tab instead.

---

## What it is

A load generator with one metric. You pick a model, a target and a ceiling; it
spins up N workers that each request the maximum the model will give, fills the
context with randomised noise, optionally attaches very large images, rotates a
fresh cache-busting prefix per request, and streams the running totals back to a
dashboard.

It keeps running when you close the tab (the server owns the run). Reload and it
re-attaches.

## What it is not

Not a benchmark, not a load test, not a cost-optimisation tool, and not something
you should expose to a network — it binds to `127.0.0.1` only, on the assumption
that the operator is the key's owner.

---

## Quick start

Node.js ≥ 20. **Zero dependencies**, no install step.

```bash
git clone <this-repo>
cd token-waster
node server.js
```

Then open http://127.0.0.1:8791.

1. Read the declaration, tick the box, type `WASTE`.
2. Pick a provider, paste a key, confirm the model id.
3. Hit **send one minimal request** — costs a few dozen tokens, proves the key,
   endpoint and model string are right before you commit to a real run.
4. Set a target and at least one hard ceiling.
5. Ignite.

Dry run (plan and estimate, send nothing):

```bash
curl -s localhost:8791/api/run/start -H 'content-type: application/json' -d '{
  "providerId":"openai","baseUrl":"https://api.openai.com/v1","apiKey":"sk-...",
  "modelId":"gpt-5.6-luna","strategy":"max-output","mode":"tokens","targetValue":100000,
  "concurrency":2,"confirm":"WASTE","dryRun":true,
  "guards":{"maxUsd":0.5,"maxRequests":20,"maxDurationSec":60}
}'
```

---

## The three tricks

This is the only part with any engineering in it.

### 1. Cache busting

Every vendor's prompt cache is prefix-based. OpenAI caches prompts ≥1024 tokens
and routes on a hash of roughly the first 256. Anthropic only caches blocks you
explicitly mark with `cache_control` — we never mark any. Gemini, DeepSeek and
Zhipu do implicit prefix caching.

So every request opens with ~350 tokens of CSPRNG noise. Different prefix →
different shard → guaranteed miss → nothing bills at the 10–25% cached rate.

The counterintuitive corollary: **multi-turn conversations are cheaper than
single-turn ones**, because turn two's prefix is a cache hit. That is why this
tool deliberately starts a fresh conversation for every request.

### 2. Low-entropy big images

Vision billing is a function of pixels, not bytes. A 1536×1536 PNG made of flat
colour blocks is ~60 KB and bills exactly like a 3 MB photograph.

`src/images.js` is a hand-written PNG encoder (zlib + CRC32, no canvas
dependency) that exploits this: maximum resolution, minimum entropy.

| Vendor | Image billing | ≈ per 1536² |
|---|---|---|
| Anthropic | downscale to 1568 long edge, then pixels / 750 | ≈ 3,200 tok |
| OpenAI | fit 2048/768, then 512px tiles, 85 + 170×tiles | ≈ 1,100 tok |
| Gemini | 384px patches, ~258 tok each, **no downscale** | ≈ 4,100 tok |

Anthropic's downscale means anything larger than 1568 costs upload time and
nothing else. Gemini is the opposite — resolution genuinely costs more, which
makes it the best value for the image bomb.

### 3. Closed-loop quota

With N workers in flight, "have I spent $5 yet" is unanswerable if you only
account after the response lands — by then you have overshot.

So each request reserves an estimate (tokens *and* money) before dispatch and
settles the difference against real `usage` afterwards. Reservations carry a 5%
token / 15% money margin. When the budget looks exhausted, a worker waits one
settlement round instead of exiting, because "no budget" usually just means
"budget is held by in-flight requests".

Empirically `mode: tokens` converges within ±5% of the target.

---

## Burn until empty

For when you don't want to pick a number, you just want to watch the account go to zero.

1. Fill in provider and key
2. Hit **无忧燃尽** (the red one under Ignite)
3. Type `BURN`

It switches to max-output, raises concurrency to at least 8, and keeps going until the provider
answers `insufficient quota` / `402` / a localised equivalent. That is a clean finish, not a crash
— the report's stop reason reads "account drained".

The only brakes are a 6-hour and 20,000-request backstop, hard-coded server-side, because a run
with genuinely no bound at all is refused. Nothing else will stop it.

> It won't actually blow up your card — the provider gives up first. Unless you have auto-recharge
> enabled, in which case all bets are off.

## Run report

Hit **导出一份燃烧报告** at any point (mid-run is fine). A print-styled A4 page opens and the print
dialog appears; choose "Save as PDF".

The report contains totals, a cost breakdown by token type, cumulative and instantaneous throughput
charts, run-quality metrics (stop reason, peak concurrency, 429s, cooldown events, P50/P90/P99
latency), the last 70 log lines, and a note about which numbers are estimates.

**Why not emit a .pdf directly**: a Chinese-language PDF requires an embedded CJK font — either
megabytes of font data or a headless browser, both of which break the zero-dependency promise. The
browser's own print pipeline produces the same artefact, with vector charts and selectable text.

## Staying fast when the provider misbehaves

Three things, because a degraded upstream is the main way a burn tool quietly loses throughput:

**Per-request retry.** Network errors, 5xx and stalled streams get up to 2 more attempts with
250–750 ms backoff. The goal is throughput: a retry that waits a second has already cost more than
it saves.

**Stall detection.** The real throughput killer isn't an error, it's a socket that stays open and
stops sending. One such request holds a worker until the 180 s timeout while everyone else races
ahead, and your effective rate silently halves. 75 seconds of silence now aborts and retries.

**Cooldown instead of shouting.** Two straight failures halve the concurrency permits; five trip a
2–15 s global breaker; twelve clean requests buy a permit back. Adding pressure to a 500ing endpoint
only multiplies wasted requests. The "并发" figure in the UI is the *current permit count*, not the
slider value.

---

## Providers

Three wire protocols cover everything: OpenAI Chat Completions, Anthropic
Messages, Gemini generateContent. Adding a vendor is a data edit, not a code
change.

| Provider | Protocol | Example models | Context | Max output |
|---|---|---|---|---|
| OpenAI | openai-chat | `gpt-5.6-sol` / `terra` / `luna` | 1,050,000 | 128,000 |
| Anthropic | anthropic-messages | `claude-sonnet-5-5` | 1,000,000 | 128,000 |
| Google Gemini | gemini-generate | `gemini-3-pro-preview` | 1,048,576 | 65,536 |
| DeepSeek | openai-chat | `deepseek-v4-pro` | 1,000,000 | 384,000 |
| Moonshot / Kimi | openai-chat | `kimi-k3` | 1,000,000 | 128,000 |
| Zhipu GLM | openai-chat | `glm-5.3` | 1,000,000 | 128,000 |
| Alibaba DashScope | openai-chat | `qwen3.8-max`, `qwen-long` | 1M / **10M** | 65,536 |
| Volcengine Ark | openai-chat | `doubao-seed-2.1-pro` | 256,000 | 32,768 |
| OpenRouter | openai-chat | anything upstream | upstream | upstream |
| Azure OpenAI | azure-openai | your deployment name | — | — |
| Ollama (local) | openai-chat | `qwen3:8b` | — | — |

Plus MiniMax, xAI, Groq, Mistral, SiliconFlow as templates.

> **The catalog was transcribed on 2026-10-29 and will drift.** Every field is
> editable in the UI. The engine trusts the `usage` the API returns, never our
> price table. Verify in the vendor console before spending real money.

---

## Guard rails (enforced, not suggested)

1. A run with **no finite limit** is rejected with HTTP 400 — and money or
duration must be among them. A token target alone is effectively "run until the
card declines" and is refused.
2. Hard caps: concurrency 32, $500/run, 20,000 requests/run, 6 hours/run.
3. Binds `127.0.0.1` only.
4. Cross-origin requests refused; all writes require `application/json`
   (which forces a preflight we never answer).
5. Plaintext `http://` is only accepted for loopback — a public endpoint must be
   https, or the key would travel in the clear.
6. API keys never enter logs or error messages.
7. One shared `AbortController` for every in-flight request; `Esc` stops the run.
8. 429s trigger global exponential backoff rather than hammering your quota.
9. Burn-until-empty drops the money and token ceilings but keeps the 6h / 20k-request backstop,
   and demands its own confirmation word.

## Known limitations

- **Money ceilings are estimates.** Reservation uses the price table; settlement
  uses real usage. A stale price or an under-estimated image can push you a few
  percent past the cap (one in-flight batch worth). Don't set the cap at your
  wallet's limit.
- **Output tokens can't be forced.** `max_tokens` is a ceiling. `mode: tokens`
  compensates in a loop, but the final request can still fall short.
- **Some models refuse.** "Emit integers forever" occasionally gets cut short by
  safety policy or weak instruction-following. Swap model or strategy.
- **Parameter sets are guessed by fallback**, and if a provider says "max_tokens
  too large" or "context exceeded" the engine halves the offending number and
  retries rather than failing the rest of the run. "OpenAI compatible" ranges from a
  byte-identical proxy to strict validation. The log's `v0`/`v1`/`v2` shows which
  variant finally worked.
- **No Responses API support** yet.
- **No multi-turn accumulation** — on purpose, see the caching note above.

## Self-test

```bash
node scripts/selftest.js
```

Spins up a mock vendor speaking all three protocols and drives the real engine
against it: usage accounting, quota convergence, money/request cutoffs, abort,
PNG size, prefix randomness. 25 tests, no network, no key.

## Review record

`docs/issues/` holds a 14-item review of this code from 2026-10-29 (11 of them P1), each with
repro steps, root cause, fix and acceptance criteria. All are closed, and 11 gained regression
tests. The highlights are worth reading if you plan to change the scheduler:

- the filler cache's 25k bucket made small quotas send 25× the planned input
- a vendor that omits `usage` had its entire prompt cost refunded
- retries and variant probing did not count against the request ceiling
- `for await` locks a stream, so the stall detector could not actually cancel anything
- the start-exclusivity check sat before an `await`, so two concurrent submissions both won

## Structure

```
server.js              HTTP + validation + SSE (zero dependencies)
src/config.js          provider catalog
src/engine.js          worker pool, reservation ledger, breaker, abort
src/prompts.js         random filler, output-forcing tasks, nonces
src/images.js          hand-written PNG encoder
src/protocols/         openai | anthropic | gemini + shared SSE layer
public/                vanilla HTML/CSS/JS, no build step
scripts/selftest.js    offline tests with a mock vendor
```

## License

MIT. Do what you want; don't send me the bill.
