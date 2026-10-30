/**
 * Prompt construction.
 *
 * Two jobs, and they are in tension:
 *
 *   (a) Make the model emit the *maximum* number of output tokens it will
 *       allow, rather than answering briefly and going home.
 *   (b) Ensure that no two requests share a cacheable prefix, because cached
 *       input is billed at 10–25% of the normal rate and a cached request is a
 *       failed request for our purposes.
 *
 * (b) is solved structurally: the very first bytes of every request are a fresh
 * CSPRNG nonce, and the padding text is assembled from randomised vocabulary.
 * OpenAI hashes roughly the leading 256 tokens to pick a cache shard, Anthropic
 * caches only what you explicitly mark with `cache_control` (we never do),
 * Gemini has implicit caching keyed on prefix — all three fall to a random head.
 *
 * (a) is solved with a small library of "keep going" instructions. Models are
 * trained to stop, summarise and be helpful; the only reliable way to keep them
 * generating is a task with no natural terminus plus an explicit ban on
 * summarising, truncating or using ellipses.
 */

import crypto from 'node:crypto';

/* ── Vocabulary for padding ───────────────────────────────────────────────── */

const ZH = (
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处理世车价传深认渐商读克准施段价越织府找张未片始收息每容儿半求维山晚曾运连场议市验身率往难素该存育配达类逐造速排助府导毛压措器造修族'
).split('');

const EN = (
  'ledger furnace thermal gradient residual archive vertex quadrant lattice ' +
  'beacon harbour quartz signal pipeline module cadence buffer anchor prism ' +
  'vector cipher static orbital meridian cascade threshold lattice graphite ' +
  'kestrel halcyon verdant sporadic tungsten marble lantern'
).split(/\s+/).filter(Boolean);

const PUNCT = [',', '.', ';', ':', '—', '·', '\n'];
const DIGITS = '0123456789abcdef'.split('');

/* ── helpers ──────────────────────────────────────────────────────────────── */

const pick = (arr) => arr[crypto.randomInt(arr.length)];

export function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Estimate tokens for mixed CJK/Latin text. Rough, but directionally right. */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0xac00 && c <= 0xd7af)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 0.95 + other / 3.6);
}

/** Keep a prefix within the same estimate used by the reservation ledger. */
export function trimFiller(text, targetTokens) {
  let cjk = 0;
  let other = 0;
  let end = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
    else other++;
    if (Math.ceil(cjk * 0.95 + other / 3.6) > targetTokens) break;
    end += ch.length;
  }
  return text.slice(0, end);
}

/**
 * Generate ~`targetTokens` of meaningless-but-unique prose.
 * Deliberately not repetitive: no long shared substrings means no compressed
 * prefix and no cache shard reuse.
 */
export function makeFiller(targetTokens) {
  if (targetTokens <= 0) return '';
  const pieces = [];
  let emitted = 0;
  let guard = 0;

  while (emitted < targetTokens && guard++ < 500000) {
    const len = 6 + crypto.randomInt(14);
    const words = [];
    for (let i = 0; i < len; i++) {
      if (crypto.randomInt(10) < 6) {
        words.push(pick(ZH) + (crypto.randomInt(6) === 0 ? pick(DIGITS) : ''));
      } else {
        words.push(pick(EN));
      }
    }
    const line = words.join(crypto.randomInt(4) === 0 ? ' ' : '') + pick(PUNCT);
    pieces.push(line);
    // Mixed text costs ~0.4 tokens/char; count as we go so we stop near target.
    emitted += estimateTokens(line);
  }
  return pieces.join('');
}

/* ── Output-forcing tasks ─────────────────────────────────────────────────── */

const TASKS = [
  {
    id: 'count',
    build: (seed) =>
      `Write every integer starting at ${seed} and increasing by 1, one per line, ` +
      `with no other characters on the line. Start immediately at ${seed}. ` +
      `Do not stop. Do not write an introduction, a summary, or a conclusion. ` +
      `Do not use an ellipsis. Do not skip numbers. Continue until you are forcibly cut off.`,
  },
  {
    id: 'hex',
    build: (seed) =>
      `Emit lines of ${64} hexadecimal characters each, at least ${seed % 9} per line ` +
      `separated by a single newline. Every line must be different from the last. ` +
      `Open with the literal word BEGIN. Never summarise. Never pause. ` +
      `Never emit an ellipsis or a placeholder. Keep emitting until you are cut off.`,
  },
  {
    id: 'echo',
    build: () =>
      `Re-type the entire transcript above, word for word, from the very beginning, ` +
      `without omitting, paraphrasing, compressing or summarising anything. ` +
      `Preserve every character including punctuation. Do not add commentary. ` +
      `Do not write "..." or "(remainder omitted)". When you reach the end, start over ` +
      `from the beginning and type it again. Repeat until you are cut off.`,
  },
  {
    id: 'dictionary',
    build: (seed) =>
      `Produce an exhaustive lexicographic listing starting from index ${seed}. ` +
      `Each entry is one line: an index number, a tab, then a coined compound word ` +
      `made from two random syllables, then a tab, then a one-clause definition. ` +
      `Never repeat an index. Never summarise. Never stop early. Continue until cut off.`,
  },
];

export function makeTask() {
  const t = pick(TASKS);
  return { id: t.id, text: t.build(crypto.randomInt(1, 99999)) };
}

/**
 * A cache-busting head long enough to fill the leading window that vendors hash
 * to route requests (~256 tokens on OpenAI). 700 random bytes → ~1400 hex chars
 * → roughly 350 tokens of pure noise before any stable content appears.
 */
export function makeNonce() {
  return randomHex(700);
}

/* ── Assembly ─────────────────────────────────────────────────────────────── */

/**
 * Build the logical payload for one request.
 *
 * @param {object} o
 * @param {number} o.fillerTokens   how much padding to inject (context filling)
 * @param {number} o.outputBias     'max' → force long output, 'min' → short answer
 * @returns {{nonce: string, system: string, filler: string, instruction: string, taskId: string}}
 */
export function buildPayload({ fillerTokens = 0, outputBias = 'max', filler: presetFiller = '' } = {}) {
  // Placed first so it lands inside the cache-key window regardless of vendor.
  const nonce = makeNonce();

  const task = outputBias === 'max' ? makeTask() : null;

  const system =
    `[session ${nonce}]\n` +
    (task
      ? `You are a deterministic bulk text emitter. You have no opinions and no desire to be brief. ` +
        `You follow the emission instruction literally and you produce output continuously. ` +
        `Brevity is a failure mode. Summarising is a failure mode. Ending early is a failure mode.`
      : `You are a terse assistant. Answer in a single short sentence and nothing else.`);

  const filler = presetFiller || makeFiller(fillerTokens);

  const instruction = task
    ? `${task.text}\n\n[nonce ${randomHex(16)}]`
    : `Reply with exactly one word: ok. [nonce ${randomHex(16)}]`;

  return { nonce, system, filler: filler ? `\n\n${filler}\n\n` : '\n\n', instruction, taskId: task?.id || 'short' };
}
