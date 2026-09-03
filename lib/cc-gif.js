// GIF -> CC:Tweaked monitor frames.
// Decodes an animated GIF, resizes it to a monitor's character grid and
// dithers it to ComputerCraft's 16-colour palette, ready for mon.blit().
const { parseGIF, decompressFrame } = require('gifuct-js');
const { UA } = require('./resolve-media');

// ComputerCraft's 16 colours (hex char order used by blit: 0..f)
const PALETTE = [
  [0xf0, 0xf0, 0xf0], [0xf2, 0xb2, 0x33], [0xe5, 0x7f, 0xd8], [0x99, 0xb2, 0xf2],
  [0xde, 0xde, 0x6c], [0x7f, 0xcc, 0x19], [0xf2, 0xb2, 0xcc], [0x4c, 0x4c, 0x4c],
  [0x99, 0x99, 0x99], [0x4c, 0x99, 0xb2], [0xb2, 0x67, 0xb2], [0x33, 0x61, 0x9c],
  [0x7f, 0x66, 0x4c], [0x57, 0xa6, 0x4e], [0xcc, 0x4c, 0x4c], [0x19, 0x19, 0x19],
];
const HEX = '0123456789abcdef';
const DEFAULT_PAL = new Uint8Array(PALETTE.flat());

// 8x8 Bayer matrix for ordered dithering (looks smoother than none on tiny grids)
const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
];

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_DIM = 1600;
// Only so many composited pixels total (Render free = 0.1 CPU + 512MB RAM).
// Bigger GIFs get temporally SUBSAMPLED (every n-th frame) so the full loop
// is preserved at a lower framerate instead of truncating the animation.
const FRAME_BUDGET = 36e6;
const cache = new Map();        // "url@wxh" -> built entry
const decodedCache = new Map(); // url -> decoded RGBA frames (shared by all monitor sizes)
let chain = Promise.resolve();  // serialise decode work (CPU-bound)

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

// Download + LZW-decode + composite ONCE per URL, shared by every monitor
// size that is watching. Huge GIFs are subsampled in time (full loop kept).
async function decodeGif(url) {
  const hit = decodedCache.get(url);
  if (hit) return hit;

  const t0 = Date.now();
  const buf = await downloadGif(url);
  const tDl = Date.now();
  const gif = parseGIF(buf);
  const W = gif.lsd.width, H = gif.lsd.height;
  if (W > MAX_DIM || H > MAX_DIM) throw new Error('GIF resolution is too big.');
  const imageFrames = (gif.frames || []).filter((f) => f.image);
  if (!imageFrames.length) throw new Error('GIF has no frames.');

  const maxFrames = Math.max(10, Math.min(160, Math.floor(FRAME_BUDGET / (W * H))));
  const stride = Math.max(1, Math.ceil(imageFrames.length / maxFrames));

  const canvas = new Uint8ClampedArray(W * H * 4);
  let saved = null;
  const out = [];
  for (let i = 0; i < imageFrames.length; i += stride) {
    const f = decompressFrame(imageFrames[i], gif.gct, true);
    if (!f || !f.patch) continue;
    if (f.disposalType === 3) saved = canvas.slice();
    const { top, left, width, height } = f.dims;
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
    // true elapsed time of this sample = sum of the delays it stands in for
    let delay = 0;
    for (let k = i; k < Math.min(i + stride, imageFrames.length); k++) {
      const gce = imageFrames[k].gce;
      delay += Math.min(300, Math.max(30, ((gce && gce.delay) || 10) * 10));
    }
    out.push({ rgba: canvas.slice(), delay: Math.min(1200, delay) });
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
  if (!out.length) throw new Error('GIF had no decodable frames.');

  const result = { W, H, frames: out };
  decodedCache.set(url, result);
  while (decodedCache.size > 2) decodedCache.delete(decodedCache.keys().next().value);
  console.log(
    `[cc-gif] decoded ${W}x${H} gif: ${imageFrames.length} frames -> kept ${out.length}` +
    ` (stride ${stride}) in ${Date.now() - t0}ms (dl ${tDl - t0}ms)`
  );
  return result;
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

function nearest(r, g, b, pal) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < 16; i++) {
    const p = i * 3;
    const dr = r - pal[p], dg = g - pal[p + 1], db = b - pal[p + 2];
    const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Mild saturation boost — monitor dithering tends to flatten colours.
function saturate(img, amount = 1.22) {
  for (let i = 0; i < img.length; i += 3) {
    const r = img[i], g = img[i + 1], b = img[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    let nr = l + (r - l) * amount;
    let ng = l + (g - l) * amount;
    let nb = l + (b - l) * amount;
    img[i] = nr < 0 ? 0 : nr > 255 ? 255 : nr;
    img[i + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng;
    img[i + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb;
  }
}

// K-means over the actual GIF pixels -> the best possible 16 colours for THIS
// gif (CC:T monitors can remap their palette with setPaletteColor).
function buildPalette(frames) {
  const samples = [];
  const take = Math.min(frames.length, 8);
  const skipF = Math.max(1, Math.ceil(frames.length / take));
  const pxSkip = Math.max(1, Math.floor((frames[0].length / 3) / (30000 / Math.min(take, frames.length))));
  for (let f = 0; f < frames.length; f += skipF) {
    const img = frames[f];
    for (let i = 0; i + 2 < img.length; i += 3 * pxSkip) {
      samples.push([img[i], img[i + 1], img[i + 2]]);
    }
  }
  if (!samples.length) return null;

  // seed: spread evenly across luminance-sorted samples (great for line art)
  samples.sort(
    (a, b) =>
      0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2] - (0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2])
  );
  const cents = [];
  for (let k = 0; k < 16; k++) {
    const s = samples[Math.min(samples.length - 1, Math.floor((k + 0.5) * (samples.length / 16)))];
    cents.push([s[0], s[1], s[2], 0, 0, 0, 0]);
  }

  for (let it = 0; it < 6; it++) {
    for (const c of cents) { c[3] = 0; c[4] = 0; c[5] = 0; c[6] = 0; }
    for (let si = 0; si < samples.length; si++) {
      const s = samples[si];
      let bi = 0, bd = Infinity;
      for (let k = 0; k < 16; k++) {
        const c = cents[k];
        const dr = s[0] - c[0], dg = s[1] - c[1], db = s[2] - c[2];
        const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (d < bd) { bd = d; bi = k; }
      }
      const c = cents[bi];
      c[3] += s[0]; c[4] += s[1]; c[5] += s[2]; c[6]++;
    }
    for (const c of cents) {
      if (c[6] > 0) { c[0] = c[3] / c[6]; c[1] = c[4] / c[6]; c[2] = c[5] / c[6]; }
    }
  }

  // nudge duplicate centroids apart so all 16 slots stay useful
  for (let k = 1; k < 16; k++) {
    for (let j = 0; j < k; j++) {
      const a = cents[k], b = cents[j];
      const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
      if (2 * dr * dr + 4 * dg * dg + 3 * db * db < 40) {
        const s = samples[Math.floor(Math.random() * samples.length)];
        a[0] = s[0]; a[1] = s[1]; a[2] = s[2];
      }
    }
  }

  const pal = new Uint8Array(48);
  for (let k = 0; k < 16; k++) {
    pal[k * 3] = Math.max(0, Math.min(255, Math.round(cents[k][0])));
    pal[k * 3 + 1] = Math.max(0, Math.min(255, Math.round(cents[k][1])));
    pal[k * 3 + 2] = Math.max(0, Math.min(255, Math.round(cents[k][2])));
  }
  return pal;
}

// Dither + run-length-encode one frame into blit-able lines: "a12,f40,..."
function ditherToLines(img, w, h, pal) {
  const hex = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const t = (BAYER[y & 7][x & 7] / 64 - 0.5) * 42;
      hex[y * w + x] = nearest(img[i] + t, img[i + 1] + t, img[i + 2] + t, pal);
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

// Pad content rows with black bars so the picture keeps its aspect ratio
// (monitor cells are 6x9, so account for non-square cells too).
function withBars(contentLines, w, cw, ox, oy, h) {
  const lines = [];
  const empty = 'f' + w;
  for (let y = 0; y < oy; y++) lines.push(empty);
  for (const row of contentLines) {
    const left = ox > 0 ? 'f' + ox + ',' : '';
    const right = w - ox - cw > 0 ? ',f' + (w - ox - cw) : '';
    lines.push(left + row + right);
  }
  while (lines.length < h) lines.push(empty);
  return lines;
}

async function build(url, w, h) {
  const t0 = Date.now();
  const { W, H, frames } = await decodeGif(url);

  // letterbox box: monitor cells are 6x9 px, keep the source aspect
  let cw = Math.round(Math.min(w, (h * 1.5 * W) / H));
  let ch = Math.round(Math.min(h, (w * 2 * H) / (3 * W)));
  cw = Math.max(2, Math.min(w, cw));
  ch = Math.max(2, Math.min(h, ch));
  const ox = Math.floor((w - cw) / 2);
  const oy = Math.floor((h - ch) / 2);

  const resized = frames.map((f) => resize(f.rgba, W, H, cw, ch));
  for (const img of resized) saturate(img);
  const palette = buildPalette(resized);
  const usedPalette = palette || DEFAULT_PAL;

  const built = frames.map((f, i) => ({
    lines: withBars(ditherToLines(resized[i], cw, ch, usedPalette), w, cw, ox, oy, h),
    delay: f.delay,
  }));
  console.log(`[cc-gif] built ${w}x${h} profile: ${built.length} frames in ${Date.now() - t0}ms`);
  // cumulative timeline so every client shows the same broadcast position
  const timeline = [];
  let acc = 0;
  for (const f of built) { acc += f.delay; timeline.push(acc); }
  return {
    status: 'ready',
    w, h, url,
    frames: built,
    timeline,
    total: acc,
    palette: Array.from(usedPalette),
    box: { ox, oy, cw, ch },
  };
}

function ensure(url, kind, w, h) {
  if (kind === 'video') return { status: 'video' };
  const key = `${url}@${w}x${h}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = { status: 'building', w, h, url };
    cache.set(key, entry);
    console.log(`[cc-gif] building ${w}x${h} profile for ${url.slice(0, 90)}`);
    chain = chain
      .then(() => build(url, w, h))
      .then((res) => Object.assign(entry, res, { status: 'ready' }))
      .catch((e) => {
        entry.status = 'error';
        entry.error = e.message;
        console.error(`[cc-gif] build failed for ${w}x${h}:`, e.message);
        decodedCache.delete(url); // don't let one bad download poison retries
      })
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
