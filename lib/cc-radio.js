// "Radio" — decodes a direct audio link (wav / mp3 / ogg-vorbis) to 48kHz mono
// 8-bit PCM and streams it to CC:Tweaked speakers in sync.
// (Spotify audio itself is DRM-locked, so speakers take radio links; the
// Spotify title + progress still show on the monitor overlay.)
const crypto = require('crypto');
const { UA } = require('./resolve-media');

const CHUNK = 8192;            // samples per websocket chunk (~0.17s @48kHz)
const MAX_BYTES = 30 * 1024 * 1024;
const MAX_MS = 20 * 60 * 1000; // 20 minutes of audio max

let current = null; // { title, by, pcm: Int8Array, len, startedAt }
const listeners = new Set();

function status() {
  if (!current) return { playing: false };
  return {
    playing: true,
    title: current.title,
    by: current.by,
    startedAt: current.startedAt,
    durationMs: Math.round((current.len / 48000) * 1000),
  };
}
function emit() {
  const s = status();
  for (const fn of listeners) { try { fn(s); } catch {} }
}
function onChange(fn) { listeners.add(fn); }

function titleFromUrl(u) {
  try {
    const p = decodeURIComponent(new URL(u).pathname);
    const last = p.split('/').pop() || 'radio';
    return last.replace(/\.[a-z0-9]+$/i, '').replace(/[-_+]+/g, ' ').slice(0, 70) || 'radio';
  } catch {
    return 'radio';
  }
}

async function download(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: new URL(url).origin + '/' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`audio host said ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('audio file too big (>30MB)');
    return buf;
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------ decoders

function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let fmt = null, data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    }
    off += 8 + size + (size % 2);
    if (fmt && data) break;
  }
  if (!fmt || !data) throw new Error('WAV is missing fmt/data chunks');
  const { channels, sampleRate, bits, format } = fmt;
  const frames = Math.floor(data.length / (channels * (bits / 8)));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * (bits / 8);
      let v;
      if (bits === 8) v = (data[o] - 128) / 128;
      else if (bits === 16) v = data.readInt16LE(o) / 32768;
      else if (bits === 24) v = (((data[o + 2] << 24) | (data[o + 1] << 16) | (data[o] << 8)) >> 8) / 8388608;
      else if (bits === 32 && format === 3) v = data.readFloatLE(o);
      else if (bits === 32) v = data.readInt32LE(o) / 2147483648;
      else throw new Error(`unsupported WAV bit depth: ${bits}`);
      acc += v;
    }
    mono[i] = acc / channels;
  }
  return { samples: mono, sampleRate };
}

async function decodeMp3(buf) {
  const { MPEGDecoder } = require('mpg123-decoder');
  const dec = new MPEGDecoder();
  await dec.ready;
  try {
    const res = dec.decode(new Uint8Array(buf));
    if (!res.samplesDecoded) throw new Error('could not decode that mp3');
    return mixAndRate(res.channelData, res.sampleRate);
  } finally {
    dec.free();
  }
}

async function decodeOgg(buf) {
  const { OggVorbisDecoder } = require('@wasm-audio-decoders/ogg-vorbis');
  const dec = new OggVorbisDecoder();
  await dec.ready;
  try {
    const res = dec.decode(new Uint8Array(buf));
    if (!res.samplesDecoded) throw new Error('could not decode that ogg');
    return mixAndRate(res.channelData, res.sampleRate);
  } finally {
    dec.free();
  }
}

function mixAndRate(channelData, sampleRate) {
  const chs = channelData.length;
  if (!chs) throw new Error('no audio channels found');
  const n = channelData[0].length;
  let mono;
  if (chs === 1) mono = channelData[0];
  else {
    mono = new Float32Array(n);
    for (let c = 0; c < chs; c++) {
      const ch = channelData[c];
      for (let i = 0; i < n; i++) mono[i] += ch[i];
    }
    for (let i = 0; i < n; i++) mono[i] /= chs;
  }
  return { samples: mono, sampleRate };
}

function resampleTo48k(f32, sampleRate) {
  if (sampleRate === 48000) return f32;
  const n = Math.floor((f32.length * 48000) / sampleRate);
  const out = new Float32Array(n);
  const ratio = f32.length / n;
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const a = f32[i0] || 0;
    const b = f32[Math.min(i0 + 1, f32.length - 1)] || 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function toInt8(f32) {
  let peak = 0;
  for (let i = 0; i < f32.length; i++) { const a = Math.abs(f32[i]); if (a > peak) peak = a; }
  const gain = peak > 0.01 ? Math.min(4, 0.95 / peak) : 1;
  const out = new Int8Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    let v = f32[i] * gain;
    if (v > 1) v = 1; else if (v < -1) v = -1;
    out[i] = Math.round(v * 127);
  }
  return out;
}

async function decodeAny(buf, url) {
  const head = buf.subarray(0, 12);
  const isWav = head.toString('ascii', 0, 4) === 'RIFF';
  const isOgg = head.toString('ascii', 0, 4) === 'OggS';
  const isMp3 =
    (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) ||
    (head.toString('ascii', 0, 3) === 'ID3');
  let decoded;
  if (isWav) decoded = decodeWav(buf);
  else if (isOgg) decoded = await decodeOgg(buf);
  else if (isMp3) decoded = await decodeMp3(buf);
  else {
    // sniff by extension, then give up
    if (/\.ogg(\?|#|$)/i.test(url)) decoded = await decodeOgg(buf);
    else if (/\.mp3(\?|#|$)/i.test(url)) decoded = await decodeMp3(buf);
    else if (/\.wav(\?|#|$)/i.test(url)) decoded = decodeWav(buf);
    else throw new Error('unsupported audio — use a direct .wav / .mp3 / .ogg link');
  }
  return { samples: resampleTo48k(decoded.samples, decoded.sampleRate) };
}

// ------------------------------------------------------------ public API

async function start(url, by) {
  stop();
  const buf = await download(url);
  const { samples } = await decodeAny(buf, url);
  const maxSamples = Math.floor((MAX_MS / 1000) * 48000);
  let pcm;
  if (samples.length > maxSamples) {
    pcm = toInt8(samples.subarray(0, maxSamples));
  } else {
    pcm = toInt8(samples);
  }
  if (pcm.length < 48000) throw new Error('audio is too short');
  current = {
    id: crypto.randomBytes(4).toString('hex'),
    title: titleFromUrl(url),
    by: (by || 'Anonymous').slice(0, 24),
    pcm,
    len: pcm.length,
    startedAt: Date.now() + 3500, // small lead-in so speakers can buffer
    url,
  };
  emit();
  return status();
}

function stop() {
  if (!current) return;
  current = null;
  emit();
}

// housekeeping: clear finished radios
setInterval(() => {
  if (current && Date.now() - current.startedAt > (current.len / 48000) * 1000 + 4000) stop();
}, 1000);

function currentChunkIndex() {
  if (!current) return -1;
  const s = (Date.now() - current.startedAt) * 48; // samples elapsed
  return Math.floor(s / CHUNK);
}

function chunkBase64(i) {
  if (!current) return null;
  const start = i * CHUNK;
  if (start < 0 || start >= current.len) return null;
  const n = Math.min(CHUNK, current.len - start);
  return Buffer.from(current.pcm.buffer, current.pcm.byteOffset + start, n).toString('base64');
}

module.exports = { start, stop, status, onChange, currentChunkIndex, chunkBase64 };
