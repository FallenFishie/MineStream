// GIF -> CC:Tweaked monitor frames.
// Decodes an animated GIF, resizes it to a monitor's character grid and
// dithers it to ComputerCraft's 16-colour palette, ready for mon.blit().
const { parseGIF, decompressFrames } = require('gifuct-js');
const { UA } = require('./resolve-media');

// ComputerCraft's 16 colours (hex char order used by blit: 0..f)
const PALETTE = [
  [0xf0, 0xf0, 0xf0], [0xf2, 0xb2, 0x33], [0xe5, 0x7f, 0xd8], [0x99, 0xb2, 0xf2],
  [0xde, 0xde, 0x6c], [0x7f, 0xcc, 0x19], [0xf2, 0xb2, 0xcc], [0x4c, 0x4c, 0x4c],
  [0x99, 0x99, 0x99], [0x4c, 0x99, 0xb2], [0xb2, 0x67, 0xb2], [0x33, 0x61, 0x9c],
  [0x7f, 0x66, 0x4c], [0x57, 0xa6, 0x4e], [0xcc, 0x4c, 0x4c], [0x19, 0x19, 0x19],
];
const HEX = '0123456789abcdef';

// 8x8 Bayer matrix for ordered dithering (looks smoother than none on tiny grids)
const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
];

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_DIM = 1600;
const cache = new Map();          // "url@wxh" -> { status, frames, ... }
let chain = Promise.resolve();    // serialise decode work (CPU-bound)

async function downloadGif(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: new URL(url).origin + '/' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`GIF host said ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('GIF is too big for monitor duty (>25MB).');
    return buf;
  } finally {
    clearTimeout(t);
  }
}

function decodeFrames(buf) {
  const gif = parseGIF(buf);
  const W = gif.lsd.width, H = gif.lsd.height;
  if (W > MAX_DIM || H > MAX_DIM) throw new Error('GIF resolution is too big.');
  const all = decompressFrames(gif, true);
  if (!all.length) throw new Error('GIF has no frames.');
  // RAM guard: don't composite absurd GIFs
  const maxFrames = Math.max(20, Math.min(400, Math.floor(80e6 / (W * H * 4))));
  const frames = all.slice(0, maxFrames);

  const canvas = new Uint8ClampedArray(W * H * 4);
  let saved = null;
  const out = [];
  for (const f of frames) {
    if (f.disposalType === 3) saved = canvas.slice();
    const { left, top, width, height } = f.dims;
    const p = f.patch;
    for (let y = 0; y < height; y++) {
      const cy = top + y;
      if (cy < 0 || cy >= H) continue;
      for (let x = 0; x < width; x++) {
        const cx = left + x;
        if (cx < 0 || cx >= W) continue;
        const si = (y * width + x) * 4;
        const di = (cy * W + cx) * 4;
        const a = p[si + 3];
        if (a === 0) continue;
        if (a === 255) {
          canvas[di] = p[si]; canvas[di + 1] = p[si + 1]; canvas[di + 2] = p[si + 2];
        } else {
          canvas[di] = (p[si] * a + canvas[di] * (255 - a)) / 255;
          canvas[di + 1] = (p[si + 1] * a + canvas[di + 1] * (255 - a)) / 255;
          canvas[di + 2] = (p[si + 2] * a + canvas[di + 2] * (255 - a)) / 255;
        }
        canvas[di + 3] = 255;
      }
    }
    out.push({ rgba: canvas.slice(), delay: Math.min(250, Math.max(30, f.delay || 100)) });
    if (f.disposalType === 2) {
      for (let y = top; y < Math.min(H, top + height); y++)
        for (let x = left; x < Math.min(W, left + width); x++) {
          const di = (y * W + x) * 4;
          canvas[di] = canvas[di + 1] = canvas[di + 2] = canvas[di + 3] = 0;
        }
    } else if (f.disposalType === 3 && saved) {
      canvas.set(saved);
    }
  }
  return { W, H, frames: out };
}

// Area-average resize (RGBA over black) -> compact RGB
function resize(frame, W, H, w, h) {
  const out = new Float32Array(w * h * 3);
  for (let dy = 0; dy < h; dy++) {
    const y0 = (dy * H) / h, y1 = ((dy + 1) * H) / h;
    for (let dx = 0; dx < w; dx++) {
      const x0 = (dx * W) / w, x1 = ((dx + 1) * W) / w;
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = Math.floor(y0); y < Math.min(H, Math.ceil(y1)); y++) {
        for (let x = Math.floor(x0); x < Math.min(W, Math.ceil(x1)); x++) {
          const i = (y * W + x) * 4;
          const a = frame[i + 3] / 255;
          r += frame[i] * a; g += frame[i + 1] * a; b += frame[i + 2] * a; n++;
        }
      }
      const o = (dy * w + dx) * 3;
      if (n) { out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; }
    }
  }
  return out;
}

function nearest(r, g, b) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < 16; i++) {
    const p = PALETTE[i];
    const dr = r - p[0], dg = g - p[1], db = b - p[2];
    const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Dither + run-length-encode one frame into blit-able lines: "a12,f40,..."
function ditherToLines(img, w, h) {
  const hex = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const t = (BAYER[y & 7][x & 7] / 64 - 0.5) * 42;
      hex[y * w + x] = nearest(img[i] + t, img[i + 1] + t, img[i + 2] + t);
    }
  }
  const lines = [];
  for (let y = 0; y < h; y++) {
    const parts = [];
    let run = 1;
    for (let x = 1; x <= w; x++) {
      if (x < w && hex[y * w + x] === hex[y * w + x - 1]) run++;
      else {
        parts.push(HEX[hex[y * w + x - 1]] + run);
        run = 1;
      }
    }
    lines.push(parts.join(','));
  }
  return lines;
}

async function build(url, w, h) {
  const buf = await downloadGif(url);
  const { W, H, frames } = decodeFrames(buf);
  const built = frames.map((f) => ({ lines: ditherToLines(resize(f.rgba, W, H, w, h), w, h), delay: f.delay }));
  // cumulative timeline so every client shows the same broadcast position
  const timeline = [];
  let acc = 0;
  for (const f of built) { acc += f.delay; timeline.push(acc); }
  return { status: 'ready', w, h, url, frames: built, timeline, total: acc };
}

function ensure(url, kind, w, h) {
  if (kind === 'video') return { status: 'video' };
  const key = `${url}@${w}x${h}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = { status: 'building', w, h, url };
    cache.set(key, entry);
    chain = chain
      .then(() => build(url, w, h))
      .then((res) => Object.assign(entry, res, { status: 'ready' }))
      .catch((e) => { entry.status = 'error'; entry.error = e.message; })
      .then(() => {
        // keep the cache small
        while (cache.size > 6) cache.delete(cache.keys().next().value);
      });
  }
  return entry;
}

function frameIndexAt(entry, elapsedMs) {
  if (!entry.frames || !entry.frames.length) return 0;
  const t = ((elapsedMs % entry.total) + entry.total) % entry.total;
  const tl = entry.timeline;
  let lo = 0, hi = tl.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tl[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

module.exports = { ensure, frameIndexAt };
