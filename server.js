// MineStream — a little Minecraft-flavoured web TV.
// Looping GIFs + a proper Spotify remote, synced for everyone watching.
// Designed to run as ONE free web service on Render (no DB, no native deps).
require('./lib/load-env')();

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Readable } = require('stream');
const { Server } = require('socket.io');

const { state, saveStateSoon } = require('./lib/state');
const { resolveMedia, UA } = require('./lib/resolve-media');
const spotify = require('./lib/spotify');
const ccHub = require('./lib/cc-hub');
const ccRadio = require('./lib/cc-radio');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
spotify.init(io);
ccHub.init(server);
spotify.onNow = () => ccHub.spotifyPush();

function radioToClients(s) {
  io.emit('radio:state', s);
  ccHub.broadcast({ t: 'radio', playing: !!s.playing, title: s.title, by: s.by, startedAt: s.startedAt, durationMs: s.durationMs });
}
ccRadio.onChange(radioToClients);

app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// NOTE: this must run BEFORE express.static, otherwise the raw template file
// (with the unfilled __SERVER_URL__ placeholder) gets served instead.
app.get('/cc/minestream.lua', (req, res) => {
  const base = process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;
  const lua = fs
    .readFileSync(path.join(__dirname, 'public', 'cc', 'minestream.lua'), 'utf8')
    .replace(/__SERVER_URL__/g, base.replace(/\/+$/, ''));
  res.type('text/plain; charset=utf-8').send(lua);
});

app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

// ------------------------------------------------------------------ helpers

let viewers = 0;

function gifState() {
  return {
    onAir: state.onAir,
    gallery: state.gallery,
    log: state.log,
    rotation: state.rotation,
    viewers,
  };
}
function broadcastGif() {
  io.emit('gif:state', gifState());
}
function pushLog(text) {
  state.log.unshift({ text, at: Date.now() });
  if (state.log.length > 30) state.log.length = 30;
}
function sanitizeName(n) {
  return String(n || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 24);
}
function setOnAir(item) {
  if (state.onAir && !state.gallery.some((g) => g.url === state.onAir.url)) {
    state.gallery.unshift(state.onAir);
    if (state.gallery.length > 60) state.gallery.length = 60;
  }
  state.onAir = { ...item, at: Date.now() };
  pushLog(`${item.by || 'Someone'} put "${item.title}" on air`);
  broadcastGif();
  saveStateSoon();
}

// ------------------------------------------------------------------ GIF API

app.post('/api/gif', async (req, res) => {
  try {
    const raw = String((req.body && req.body.url) || '').trim();
    if (!raw) return res.status(400).json({ error: 'Paste a link first!' });
    const item = await resolveMedia(raw);
    item.id = crypto.randomBytes(6).toString('hex');
    item.by = sanitizeName(req.body && req.body.by) || 'Anonymous';
    item.page = raw;
    setOnAir(item);
    res.json({ ok: true, item });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not load that link.' });
  }
});

app.delete('/api/gif/onair', (req, res) => {
  const next = state.gallery.find((g) => !state.onAir || g.url !== state.onAir.url);
  if (next) {
    state.gallery = state.gallery.filter((g) => g.id !== next.id);
    state.onAir = { ...next, at: Date.now() };
  } else {
    if (state.onAir) pushLog(`"${state.onAir.title}" went off air`);
    state.onAir = null;
  }
  broadcastGif();
  saveStateSoon();
  res.json({ ok: true });
});

app.post('/api/gallery/:id/air', (req, res) => {
  const item = state.gallery.find((g) => g.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not in the gallery.' });
  setOnAir({ ...item, by: item.by });
  res.json({ ok: true });
});

app.delete('/api/gallery/:id', (req, res) => {
  state.gallery = state.gallery.filter((g) => g.id !== req.params.id);
  broadcastGif();
  saveStateSoon();
  res.json({ ok: true });
});

app.post('/api/gallery/clear', (req, res) => {
  state.gallery = [];
  pushLog('The gallery was wiped');
  broadcastGif();
  saveStateSoon();
  res.json({ ok: true });
});

app.post('/api/rotation', (req, res) => {
  const { enabled, seconds } = req.body || {};
  state.rotation.enabled = !!enabled;
  const s = parseInt(seconds, 10);
  if (s >= 5 && s <= 300) state.rotation.seconds = s;
  if (state.onAir) state.onAir.at = Date.now();
  pushLog(state.rotation.enabled ? `Auto-rotate ON (every ${state.rotation.seconds}s)` : 'Auto-rotate OFF');
  broadcastGif();
  saveStateSoon();
  res.json({ ok: true, rotation: state.rotation });
});

app.get('/api/state', (req, res) => res.json(gifState()));

// Auto-rotation loop
setInterval(() => {
  const r = state.rotation;
  if (!r.enabled || !state.onAir || !state.gallery.length) return;
  if (Date.now() - state.onAir.at < r.seconds * 1000) return;
  const pool = state.gallery.filter((g) => g.url !== state.onAir.url);
  if (!pool.length) {
    state.onAir.at = Date.now();
    saveStateSoon();
    return;
  }
  setOnAir(pool[Math.floor(Math.random() * pool.length)]);
}, 1000);

// Media proxy fallback (only for known GIF hosts, in case a CDN blocks hotlinking)
const PROXY_HOSTS = /(klipy|tenor|giphy|imgur|redd\.it|redditmedia|reddit|gfycat|redgifs|catbox\.moe|discordapp|discord\.com|imgchest|tumblr)\b/i;
app.get('/api/media', async (req, res) => {
  let url;
  try {
    url = new URL(String(req.query.u || ''));
  } catch {
    return res.status(400).end();
  }
  if (!/^https?:$/.test(url.protocol) || !PROXY_HOSTS.test(url.hostname)) return res.status(400).end();
  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: url.origin + '/' },
      redirect: 'follow',
    });
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!upstream.ok || !/^(image|video)\//.test(ct)) return res.status(502).end();
    const len = parseInt(upstream.headers.get('content-length') || '0', 10);
    if (len > 40 * 1024 * 1024) return res.status(413).end();
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    res.status(502).end();
  }
});

// --------------------------------------------------------------- Spotify API

app.get('/api/spotify/status', (req, res) => res.json(spotify.status()));

app.get('/api/spotify/login', (req, res) => {
  if (!spotify.configured()) return res.status(500).send('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first (see README).');
  const stateStr = crypto.randomBytes(16).toString('hex');
  res.cookie('ms_oauth_state', stateStr, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: 'lax' });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: spotify.SCOPES,
    redirect_uri: spotify.redirectUri(req),
    state: stateStr,
    show_dialog: 'false',
  });
  res.redirect(`${spotify.ACCOUNTS}/authorize?${params}`);
});

app.get('/api/spotify/callback', async (req, res) => {
  const { code, state: stateStr, error } = req.query;
  if (error || !code || stateStr !== req.cookies.ms_oauth_state) {
    return res.redirect('/?spotify=error');
  }
  try {
    await spotify.exchangeCode(String(code), spotify.redirectUri(req));
    const p = state.spotify.profile;
    if (p) {
      pushLog(`Spotify connected as ${p.display_name || p.id}`);
      broadcastGif();
    }
    res.redirect('/?spotify=ok');
  } catch (e) {
    console.error('[spotify] callback failed:', e.message);
    res.redirect('/?spotify=error');
  }
});

app.post('/api/spotify/logout', (req, res) => {
  state.spotify.tokens = null;
  state.spotify.profile = null;
  saveStateSoon();
  spotify.broadcastStatus();
  io.emit('spotify:now', { available: false, track: null, updatedAt: Date.now() });
  res.json({ ok: true });
});

// Short-lived access token for the in-browser player (Web Playback SDK)
app.get('/api/spotify/token', async (req, res) => {
  try {
    const access = await spotify.ensureToken();
    if (!access) return res.status(401).json({ error: 'not connected' });
    res.json({ accessToken: access });
  } catch {
    res.status(401).json({ error: 'not connected' });
  }
});

app.post('/api/spotify/device', (req, res) => {
  state.spotify.deviceId = String((req.body && req.body.deviceId) || '').slice(0, 64) || null;
  saveStateSoon();
  res.json({ ok: true });
});

app.post('/api/spotify/link', async (req, res) => {
  try {
    const link = spotify.parseLink((req.body && req.body.url) || '');
    if (!link) return res.status(400).json({ error: 'That is not a Spotify playlist/album/track link.' });
    const data = await spotify.fetchCollection(link);
    res.json(data);
  } catch (e) {
    res.status(e.status && e.status >= 400 ? e.status : 500).json({ error: e.friendly || e.message });
  }
});

app.post('/api/spotify/control', async (req, res) => {
  try {
    const { action, label, by, ...rest } = req.body || {};
    const out = await spotify.control(action, rest);
    if (action === 'playTrack' || action === 'play') {
      pushLog(`${sanitizeName(by) || 'Someone'} played ${label ? `"${label}"` : 'something'} on Spotify`);
      broadcastGif();
    }
    res.json(out);
  } catch (e) {
    res.status(e.status && e.status >= 400 ? e.status : 500).json({ error: e.friendly || e.message });
  }
});

app.get('/tv', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'tv.html')));

// ------------------------------------------------------------------ CC:Tweaked

app.post('/api/radio', async (req, res) => {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Paste a direct audio link (mp3 / wav / ogg).' });
    const s = await ccRadio.start(url, (req.body && req.body.by) || 'Anonymous');
    radioToClients(s);
    pushLog(`${sanitizeName(req.body && req.body.by) || 'Someone'} started radio: "${s.title}"`);
    broadcastGif();
    res.json({ ok: true, ...s });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not play that audio.' });
  }
});

app.post('/api/radio/stop', (req, res) => {
  ccRadio.stop();
  res.json({ ok: true });
});

// ------------------------------------------------------------------ sockets

io.on('connection', (socket) => {
  viewers++;
  io.emit('gif:state', gifState());
  socket.emit('spotify:status', spotify.status());
  socket.emit('radio:state', ccRadio.status());
  const now = spotify.currentNow();
  if (now) socket.emit('spotify:now', now);
  socket.on('disconnect', () => {
    viewers = Math.max(0, viewers - 1);
    broadcastGif();
  });
});

// ------------------------------------------------------------------ go

app.use((err, req, res, next) => {
  console.error('[server]', err.message);
  res.status(500).json({ error: 'Server hiccup. Try again!' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MineStream running on http://0.0.0.0:${PORT}`);
  console.log(`Spotify credentials: ${spotify.configured() ? 'found (login available)' : 'NOT set — Spotify panel will show setup hints'}`);
});
