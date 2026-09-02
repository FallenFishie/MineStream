// The CC:Tweaked hub: a raw websocket endpoint (/cc) that Lua computers
// connect to. Paces GIF frames like a broadcast (everyone sees the same
// frame), relays Spotify metadata and streams radio audio chunks.
const { WebSocketServer } = require('ws');
const { state } = require('./state');
const ccGif = require('./cc-gif');
const ccRadio = require('./cc-radio');
const spotify = require('./spotify');

const clients = new Set();
const msgCache = new Map(); // per-profile+frame message reuse

function init(server) {
  const wss = new WebSocketServer({ server, path: '/cc' });
  wss.on('connection', (ws) => {
    ws.cc = { w: 0, h: 0, audio: false, cursor: -1, lastKey: null };
    clients.add(ws);
    ws.on('message', (data) => onMessage(ws, data));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => {});
  });

  setInterval(gifTick, 100).unref();
  setInterval(audioTick, 200).unref();
  setInterval(spTick, 4000).unref();
}

function send(ws, obj) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  } catch {}
}

function broadcast(obj) {
  for (const ws of clients) send(ws, obj);
}

function ccSpotify() {
  const n = spotify.currentNow();
  if (!n || !n.track) return { has: false, playing: false };
  return {
    has: true,
    name: n.track.name,
    artists: n.track.artists,
    durationMs: n.track.durationMs,
    progressMs: n.progressMs,
    playing: !!n.isPlaying,
    at: Date.now(),
  };
}

function onMessage(ws, data) {
  let m;
  try { m = JSON.parse(String(data)); } catch { return; }
  if (m.t === 'hello') {
    ws.cc.w = Math.min(160, Math.max(2, parseInt(m.w, 10) || 7));
    ws.cc.h = Math.min(100, Math.max(2, parseInt(m.h, 10) || 5));
    ws.cc.audio = !!m.audio;
    ws.cc.cursor = -1;
    ws.cc.lastKey = null;
    send(ws, {
      t: 'welcome',
      gif: state.onAir ? { title: state.onAir.title, by: state.onAir.by } : null,
      spotify: ccSpotify(),
      radio: ccRadio.status(),
      rotation: state.rotation,
    });
  }
}

function spotifyPush() {
  const s = ccSpotify();
  if (s.has) broadcast({ t: 'sp', ...s });
}

const spTick = spotifyPush;

function cachedMessage(key, make) {
  let msg = msgCache.get(key);
  if (!msg) {
    msg = JSON.stringify(make());
    msgCache.set(key, msg);
    while (msgCache.size > 400) msgCache.delete(msgCache.keys().next().value);
  }
  return msg;
}

let ticking = false;
async function gifTick() {
  if (ticking) return;
  ticking = true;
  try {
    const gif = state.onAir;

    // group clients by monitor size so each profile is built once
    const profiles = new Map();
    for (const ws of clients) {
      if (!ws.cc.w) continue;
      const k = `${ws.cc.w}x${ws.cc.h}`;
      if (!profiles.has(k)) profiles.set(k, []);
      profiles.get(k).push(ws);
    }

    for (const [k, socks] of profiles) {
      const [w, h] = k.split('x').map(Number);
      if (!gif) {
        for (const ws of socks) {
          if (ws.cc.lastKey !== 'off') { ws.cc.lastKey = 'off'; send(ws, { t: 'off' }); }
        }
        continue;
      }
      const entry = ccGif.ensure(gif.url, gif.kind, w, h);
      if (entry.status === 'video') {
        const key = 'note:' + gif.url;
        for (const ws of socks) {
          if (ws.cc.lastKey !== key) { ws.cc.lastKey = key; send(ws, { t: 'note' }); }
        }
      } else if (entry.status === 'ready') {
        const idx = ccGif.frameIndexAt(entry, Date.now() - gif.at);
        const key = `${k}|${gif.url}|${idx}`;
        const payload = cachedMessage(key, () => ({ t: 'f', i: idx, l: entry.frames[idx].lines }));
        for (const ws of socks) {
          if (ws.cc.lastKey !== key) { ws.cc.lastKey = key; send(ws, payload); }
        }
      } else if (entry.status === 'error') {
        const key = 'err:' + gif.url;
        for (const ws of socks) {
          if (ws.cc.lastKey !== key) { ws.cc.lastKey = key; send(ws, { t: 'gife', error: entry.error }); }
        }
      } else {
        const key = 'bld:' + gif.url;
        for (const ws of socks) {
          if (ws.cc.lastKey !== key) { ws.cc.lastKey = key; send(ws, { t: 'bld' }); }
        }
      }
    }
  } finally {
    ticking = false;
  }
}

function audioTick() {
  if (!ccRadio.status().playing) {
    for (const ws of clients) ws.cc.cursor = -1;
    return;
  }
  const cur = ccRadio.currentChunkIndex();
  for (const ws of clients) {
    if (!ws.cc.audio) continue;
    if (ws.cc.cursor < 0) ws.cc.cursor = Math.max(0, cur - 2); // small backfill
    if (cur - ws.cc.cursor > 5) ws.cc.cursor = cur;            // too far behind, skip
    let burst = 0;
    while (ws.cc.cursor <= cur && burst < 8) {
      const d = ccRadio.chunkBase64(ws.cc.cursor);
      if (!d) break;
      send(ws, { t: 'a', d });
      ws.cc.cursor++;
      burst++;
    }
  }
}

module.exports = { init, broadcast, spotifyPush, clientCount: () => clients.size };
