/* MineStream browser-side CC builder.
   Decodes the on-air GIF with the browser's own (fast, native) image decoder,
   computes the 16-colour palette + dithered blit lines for each monitor size
   the Minecraft clients need, and uploads the finished frames to the server.
   The server never burns its tiny Render-free CPU on GIF math again. */
/* global io */

(() => {
  const socket = window.socket;
  if (!socket) return;

  const HEX = '0123456789abcdef';
  const BAYER = [
    [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
  ];
  // Must match lib/cc-gif.js
  const FRAME_BUDGET = 6e6;
  const MAX_KEPT = 80;

  const attempted = new Set(); // "url@wxh" already done/underway
  const queue = [];
  let working = false;

  const setStatus = (msg) => {
    const el = document.getElementById('cc-build-status');
    if (el) el.textContent = msg;
  };

  // ---------------------------------------------------------- math (ports)

  function boxFor(W, H, w, h) {
    let cw = Math.round(Math.min(w, (h * 1.5 * W) / H));
    let ch = Math.round(Math.min(h, (w * 2 * H) / (3 * W)));
    cw = Math.max(2, Math.min(w, cw));
    ch = Math.max(2, Math.min(h, ch));
    return { cw, ch, ox: Math.floor((w - cw) / 2), oy: Math.floor((h - ch) / 2) };
  }

  function saturate(d) {
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      d[i] = Math.max(0, Math.min(255, l + (r - l) * 1.22));
      d[i + 1] = Math.max(0, Math.min(255, l + (g - l) * 1.22));
      d[i + 2] = Math.max(0, Math.min(255, l + (b - l) * 1.22));
    }
  }

  function buildPalette(frames) {
    const samples = [];
    const take = Math.min(frames.length, 8);
    const skipF = Math.max(1, Math.ceil(frames.length / take));
    const pxSkip = Math.max(1, Math.floor((frames[0].width * frames[0].height) / (30000 / Math.min(take, frames.length))));
    for (let f = 0; f < frames.length; f += skipF) {
      const d = frames[f].data;
      const n = frames[f].width * frames[f].height;
      for (let i = 0; i < n; i += pxSkip) {
        const p = i * 4;
        samples.push([d[p], d[p + 1], d[p + 2]]);
      }
    }
    if (!samples.length) return null;

    samples.sort(
      (a, b) => 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2] - (0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2])
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
      for (const c of cents) if (c[6] > 0) { c[0] = c[3] / c[6]; c[1] = c[4] / c[6]; c[2] = c[5] / c[6]; }
    }
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
    const pal = [];
    for (let k = 0; k < 16; k++) {
      pal.push(Math.max(0, Math.min(255, Math.round(cents[k][0]))));
      pal.push(Math.max(0, Math.min(255, Math.round(cents[k][1]))));
      pal.push(Math.max(0, Math.min(255, Math.round(cents[k][2]))));
    }
    return pal;
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

  function ditherToLines(img, w, h, pal) {
    const hex = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
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
        else { parts.push(HEX[hex[y * w + x - 1]] + run); run = 1; }
      }
      lines.push(parts.join(','));
    }
    return lines;
  }

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

  // ---------------------------------------------------------- decode + build

  async function buildProfile(url, w, h) {
    const key = url + '@' + w + 'x' + h;
    attempted.add(key);

    if (typeof ImageDecoder === 'undefined') {
      throw new Error('This browser cannot decode GIF frames (needs Chrome/Edge). The server will try by itself.');
    }

    setStatus('Fetching GIF for Minecraft...');
    const r = await fetch('/api/media?u=' + encodeURIComponent(url));
    if (!r.ok) throw new Error('Could not fetch the GIF (' + r.status + ')');
    const buf = await r.arrayBuffer();

    setStatus('Decoding frames (browser power!)...');
    const dec = new ImageDecoder({ data: buf, type: 'image/gif' });
    await dec.tracks.ready;
    await dec.completed.catch(() => {});
    const track = dec.tracks.selectedTrack;
    const srcFrames = Math.max(1, track.frameCount);

    // source dimensions from the first frame
    const probe = await dec.decode({ frameIndex: 0 });
    const W = probe.image.displayWidth, H = probe.image.displayHeight;
    probe.image.close();

    const kept = Math.max(1, Math.min(MAX_KEPT, Math.floor(FRAME_BUDGET / (W * H))));
    const stride = Math.max(1, Math.ceil(srcFrames / kept));

    const box = boxFor(W, H, w, h);
    const canvas = document.createElement('canvas');
    canvas.width = box.cw; canvas.height = box.ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const frames = [];
    for (let i = 0; i < srcFrames; i += stride) {
      const { image } = await dec.decode({ frameIndex: i });
      let durMs = Math.round((image.duration || 100000) / 1000);
      durMs = Math.min(300, Math.max(30, durMs));
      // true elapsed time of this sample = the delays it stands in for
      let delay = 0;
      for (let k = i; k < Math.min(i + stride, srcFrames); k++) delay += durMs;
      delay = Math.min(1200, delay);

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, box.cw, box.ch);
      ctx.drawImage(image, 0, 0, box.cw, box.ch);
      image.close();
      const id = ctx.getImageData(0, 0, box.cw, box.ch);
      saturate(id.data);
      frames.push({ id, delay });
      setStatus(`Decoding frames... ${frames.length}/${Math.ceil(srcFrames / stride)}`);
    }
    dec.close();

    setStatus('Picking the best 16 colours...');
    const palette = buildPalette(frames.map((f) => f.id)) || [240, 240, 240, 25, 25, 25];

    setStatus('Dithering for the monitor...');
    const built = frames.map((f) => ({
      lines: withBars(ditherToLines(f.id.data, box.cw, box.ch, palette), w, box.cw, box.ox, box.oy, h),
      delay: f.delay,
    }));

    const timeline = [];
    let acc = 0;
    for (const f of built) { acc += f.delay; timeline.push(acc); }
    return {
      url, w, h,
      entry: {
        status: 'ready', w, h, url,
        frames: built,
        timeline,
        total: acc,
        palette,
        box: { ox: box.ox, oy: box.oy, cw: box.cw, ch: box.ch },
      },
    };
  }

  function upload(url, w, h, entry) {
    socket.emit('cc:profile-start', { url, w, h });
    for (let i = 0; i < entry.frames.length; i += 10) {
      socket.emit('cc:profile-part', {
        url, w, h, i,
        frames: entry.frames.slice(i, i + 10),
      });
    }
    socket.emit('cc:profile-end', {
      url, w, h,
      palette: entry.palette,
      timeline: entry.timeline,
      total: entry.total,
      box: entry.box,
    });
  }

  async function processQueue() {
    if (working) return;
    working = true;
    while (queue.length) {
      const job = queue.shift();
      const key = job.url + '@' + job.w + 'x' + job.h;
      try {
        const t0 = Date.now();
        const { url, w, h, entry } = await buildProfile(job.url, job.w, job.h);
        upload(url, w, h, entry);
        setStatus(`Minecraft frames ready in ${((Date.now() - t0) / 1000).toFixed(1)}s! Check the monitor.`);
      } catch (e) {
        console.warn('[ccbuild]', key, e.message);
        attempted.add(key); // don't retry-loop
        setStatus('Browser build failed: ' + e.message);
      }
    }
    working = false;
  }

  socket.on('cc:need', ({ url, w, h }) => {
    if (!url || !w || !h) return;
    const key = url + '@' + w + 'x' + h;
    if (attempted.has(key)) return;
    attempted.add(key);
    queue.push({ url, w, h });
    processQueue();
  });

  // manual button: ask the server which monitor sizes want the current GIF
  const btn = document.getElementById('btn-cc-build');
  if (btn) {
    btn.addEventListener('click', async () => {
      attempted.clear();
      try {
        const r = await fetch('/api/cc/need', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const j = await r.json();
        if (j.sizes && j.sizes.length) setStatus('Building for ' + j.sizes.join(', ') + '...');
        else setStatus('No Minecraft computer is connected right now.');
      } catch {
        setStatus('Could not reach the server.');
      }
    });
  }
})();
