/**
 * Deterministic-ish PNG factory.
 *
 * Why hand-roll a PNG encoder instead of pulling a canvas dependency?
 *
 *   1. The project is zero-dependency on purpose. `npm i && npm start`, no
 *      native build chain, no 40 MB of transitive packages to audit before you
 *      hand a tool your API key.
 *   2. Vision billing is a function of *pixels*, not of file size. A 1536×1536
 *      image made of large flat colour blocks compresses to tens of kilobytes
 *      but is billed identically to a 3 MB photograph. That asymmetry is the
 *      whole trick behind the "image bomb": maximum billed tokens per byte
 *      uploaded.
 *   3. Every generated image is unique (random palette + random block grid),
 *      which also helps defeat prefix caching.
 */

import zlib from 'node:zlib';
import crypto from 'node:crypto';

/* ── CRC32 (PNG spec) ─────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ── PRNG ─────────────────────────────────────────────────────────────────── */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── Generator ────────────────────────────────────────────────────────────── */

/**
 * Build an RGB PNG of `width` × `height` made of flat colour blocks.
 *
 * Colour blocks keep the scanlines highly compressible (the `Up` filter turns
 * most bytes into zeros inside a block row) while still being visually
 * distinct per image — no two runs share a palette.
 *
 * @returns {{buffer: Buffer, base64: string, dataUrl: string, width: number, height: number, bytes: number}}
 */
export function makeBlockPng(width, height, { seed = crypto.randomInt(2 ** 31), block = 0 } = {}) {
  const w = Math.max(64, Math.min(4096, Math.floor(width)));
  const h = Math.max(64, Math.min(4096, Math.floor(height)));
  const rand = mulberry32(seed);

  const blockPx = block > 0 ? block : Math.max(16, Math.round(Math.max(w, h) / 24));
  const cols = Math.ceil(w / blockPx);
  const rows = Math.ceil(h / blockPx);

  // A "theme" hue keeps each image coherent; per-block jitter keeps it unique.
  const hueShift = Math.floor(rand() * 360);
  const palette = new Uint8Array(cols * rows * 3);
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = (ry * cols + cx) * 3;
      const v = rand();
      // Cheap HSL-ish ramp: warm/cool bands with noise on top.
      const band = (ry / rows) * 0.55 + (cx / cols) * 0.35;
      palette[i] = Math.floor(255 * Math.min(1, 0.25 + band * 0.8 + v * 0.25));
      palette[i + 1] = Math.floor(255 * Math.min(1, 0.15 + (1 - band) * 0.5 + rand() * 0.3));
      palette[i + 2] = Math.floor(
        255 * Math.min(1, 0.2 + (Math.sin((hueShift + cx * 9 + ry * 5) * 0.017) + 1) * 0.3 + rand() * 0.2),
      );
    }
  }

  const stride = w * 3 + 1; // +1 for the per-scanline filter byte
  const raw = Buffer.alloc(stride * h);

  // The Up filter subtracts the *previous scanline's original bytes*. Reading
  // them back out of `raw` would read the already-filtered deltas — which is a
  // bug that survives decoding (the image still opens) but corrupts every block
  // into horizontal stripes and roughly triples the file size. Keep a clean copy.
  let prevRow = Buffer.alloc(w * 3);
  let curRow = Buffer.alloc(w * 3);

  for (let y = 0; y < h; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 2; // filter: Up (each byte minus the byte directly above)
    const by = Math.min(rows - 1, (y / blockPx) | 0);
    const first = y === 0;

    for (let x = 0; x < w; x++) {
      const bx = Math.min(cols - 1, (x / blockPx) | 0);
      const pi = (by * cols + bx) * 3;
      const o = rowStart + 1 + x * 3;
      const p = x * 3;

      const r = palette[pi];
      const g = palette[pi + 1];
      const b = palette[pi + 2];

      if (first) {
        raw[o] = r;
        raw[o + 1] = g;
        raw[o + 2] = b;
      } else {
        raw[o] = (r - prevRow[p]) & 0xff;
        raw[o + 1] = (g - prevRow[p + 1]) & 0xff;
        raw[o + 2] = (b - prevRow[p + 2]) & 0xff;
      }

      curRow[p] = r;
      curRow[p + 1] = g;
      curRow[p + 2] = b;
    }

    const swap = prevRow;
    prevRow = curRow;
    curRow = swap;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const png = Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  const base64 = png.toString('base64');
  return {
    buffer: png,
    base64,
    dataUrl: `data:image/png;base64,${base64}`,
    width: w,
    height: h,
    bytes: png.length,
  };
}

/**
 * Build a pool of distinct images. Images are reused across requests within a
 * short window (regenerating a 2048² PNG per request would burn CPU, not
 * tokens) — prefix caching is already defeated by the random text nonce, and
 * the pool is rotated periodically anyway.
 */
export function makeImagePool(count, size, { seedBase = crypto.randomInt(2 ** 31) } = {}) {
  const n = Math.max(0, Math.min(32, Math.floor(count)));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(makeBlockPng(size, size, { seed: (seedBase + i * 7919) >>> 0 }));
  }
  return out;
}

/**
 * Same thing, but yields to the event loop between images.
 *
 * Encoding a 4096² PNG is ~300 ms of solid synchronous work, so a pool of them
 * froze the HTTP thread for over a second: /api/run/stop and the run's own
 * deadline could not be served during that window. Interleaving setImmediate
 * costs nothing and makes the tool answer immediately.
 *
 * @param {(done: number, total: number) => void} [onProgress]
 * @param {AbortSignal} [signal] stop early if the run is cancelled
 */
export async function makeImagePoolAsync(count, size, { seedBase = crypto.randomInt(2 ** 31), onProgress, signal } = {}) {
  const n = Math.max(0, Math.min(32, Math.floor(count)));
  const out = [];
  for (let i = 0; i < n; i++) {
    if (signal?.aborted) break;
    // Let queued I/O (a stop request, a status poll) run first.
    await new Promise((r) => setImmediate(r));
    out.push(makeBlockPng(size, size, { seed: (seedBase + i * 7919) >>> 0 }));
    onProgress?.(i + 1, n);
  }
  return out;
}

/* ── Token estimation for images ──────────────────────────────────────────── */

/**
 * Rough billed-token estimate for one image, per provider family.
 * These are the documented *approximations*; treat them as ±30%.
 */
export function estimateImageTokens(protocol, width, height, { detail = 'high' } = {}) {
  const w = width;
  const h = height;

  if (protocol === 'anthropic-messages') {
    // Downscaled so the long edge is 1568px, then ≈ pixels / 750.
    const scale = Math.min(1, 1568 / Math.max(w, h));
    return Math.ceil((w * scale * h * scale) / 750);
  }

  if (protocol === 'gemini-generate') {
    // Tiled into 384px patches, ~258 tokens per patch, plus a small base.
    const patches = Math.ceil(w / 384) * Math.ceil(h / 384);
    return Math.min(12000, 258 * patches);
  }

  // OpenAI-style: fit inside 2048, shortest side inside 768, then 512px tiles.
  const s = Math.min(1, 2048 / Math.max(w, h), 768 / Math.min(w, h));
  const sw = w * s;
  const sh = h * s;
  if (detail === 'low') return 85;
  const tiles = Math.ceil(sw / 512) * Math.ceil(sh / 512);
  return 85 + 170 * tiles;
}
