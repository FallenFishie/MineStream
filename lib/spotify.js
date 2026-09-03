// Spotify integration: OAuth (Authorization Code), token refresh, now-playing
// polling, playlist/album/track resolving and remote control with smart
// device fallback ("no active device" -> transfer to the TV or first device).
const { state, saveStateSoon } = require('./state');

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-private',
  'user-read-email',
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

let io = null;
let lastNow = null;
let onNow = null; // optional hook (used to push to CC:Tweaked clients)

function init(socketIo) {
  io = socketIo;
  setInterval(pollNow, 4000);
}

function configured() {
  return !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

function redirectUri(req) {
  const base = process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;
  return base.replace(/\/+$/, '') + '/api/spotify/callback';
}

function status() {
  const p = state.spotify.profile;
  return {
    configured: configured(),
    connected: !!(state.spotify.tokens && state.spotify.tokens.refresh),
    profile: p ? { name: p.display_name || p.id || 'Spotify user', product: p.product || 'unknown', img: (p.images && p.images[0] && p.images[0].url) || null } : null,
  };
}

function broadcastStatus() {
  if (io) io.emit('spotify:status', status());
}
function broadcastNow() {
  if (io && lastNow) io.emit('spotify:now', lastNow);
}

// ---------------------------------------------------------------- tokens

async function tokenRequest(form) {
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || `Token error (${r.status})`);
  return data;
}

async function exchangeCode(code, redirect) {
  const d = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect });
  state.spotify.tokens = { access: d.access_token, refresh: d.refresh_token, expiresAt: Date.now() + (d.expires_in - 60) * 1000 };
  saveStateSoon();
  await fetchMe();
  broadcastStatus();
}

async function ensureToken() {
  const t = state.spotify.tokens;
  if (!t) return null;
  if (t.expiresAt && Date.now() < t.expiresAt) return t.access;
  if (!t.refresh) return null;
  const d = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
  t.access = d.access_token;
  t.expiresAt = Date.now() + (d.expires_in - 60) * 1000;
  if (d.refresh_token) t.refresh = d.refresh_token;
  saveStateSoon();
  return t.access;
}

async function fetchMe() {
  const r = await api('/me');
  if (r.status === 200) {
    state.spotify.profile = r.data;
    saveStateSoon();
  }
}

// ---------------------------------------------------------------- API core

async function api(path, { method = 'GET', body = undefined, qs = undefined } = {}) {
  let access = await ensureToken();
  if (!access) {
    const err = new Error('Not connected to Spotify.');
    err.status = 401;
    throw err;
  }
  const call = async (token) => {
    const url = new URL(API + path);
    if (qs) for (const [k, v] of Object.entries(qs)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };
  let res = await call(access);
  if (res.status === 401) {
    access = await ensureToken(true);
    res = await call(access);
  }
  let data = null;
  if (res.status !== 204) data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function httpError(r, fallbackMsg) {
  const msg = r && r.data && r.data.error && (r.data.error.message || r.data.error.reason);
  const err = new Error(msg || fallbackMsg || `Spotify error (${r.status})`);
  err.status = r.status;
  if (r.status === 403) err.friendly = 'Spotify said no — controlling playback needs a Spotify Premium account.';
  if (r.status === 404) err.friendly = 'No active Spotify device found. Play something in Spotify once, or press "Play on this TV".';
  return err;
}

// ---------------------------------------------------------------- link parsing

function parseLink(s) {
  const m = String(s || '')
    .trim()
    .match(/(?:open\.spotify\.com(?:\/intl-[a-zA-Z-]+)?\/|spotify:)(playlist|album|track)[:/]([A-Za-z0-9]+)/);
  if (!m) return null;
  return { type: m[1], id: m[2] };
}

function mapTrack(t, fallbackArt) {
  const art =
    (t.album && t.album.images && t.album.images[0] && t.album.images[0].url) ||
    fallbackArt ||
    null;
  return {
    uri: t.uri,
    id: t.id,
    name: t.name || 'Unknown',
    artists: (t.artists || []).map((a) => a.name).join(', ') || 'Unknown artist',
    durationMs: t.duration_ms || 0,
    art,
    album: t.album ? t.album.name : null,
  };
}

async function fetchCollection(link) {
  if (link.type === 'track') {
    const r = await api(`/tracks/${link.id}`);
    if (r.status !== 200) throw httpError(r, 'Could not load that track.');
    const t = mapTrack(r.data);
    return { kind: 'track', name: t.name, owner: t.artists, art: t.art, total: 1, contextUri: null, tracks: [t] };
  }
  if (link.type === 'album') {
    const r = await api(`/albums/${link.id}`);
    if (r.status !== 200) throw httpError(r, 'Could not load that album.');
    const a = r.data;
    const art = a.images && a.images[0] && a.images[0].url;
    const tracks = [];
    let offset = 0;
    while (true) {
      const tr = await api(`/albums/${link.id}/tracks`, { qs: { limit: 50, offset } });
      if (tr.status !== 200) break;
      (tr.data.items || []).forEach((t) => tracks.push(mapTrack({ ...t, album: { name: a.name, images: a.images } })));
      if (!tr.data.next || tracks.length >= 500) break;
      offset += 50;
    }
    return {
      kind: 'album',
      name: a.name,
      owner: (a.artists || []).map((x) => x.name).join(', '),
      art,
      total: a.total_tracks || tracks.length,
      contextUri: a.uri,
      tracks,
    };
  }
  // playlist
  const r = await api(`/playlists/${link.id}`, { qs: { fields: 'name,images,owner(display_name),tracks(total)' } });
  if (r.status !== 200) throw httpError(r, 'Could not load that playlist (is it public?).');
  const p = r.data;
  const art = p.images && p.images[0] && p.images[0].url;
  const tracks = [];
  let offset = 0;
  while (true) {
    const tr = await api(`/playlists/${link.id}/tracks`, { qs: { limit: 50, offset, fields: 'next,items(track(uri,id,name,artists,duration_ms,album(name,images)))' } });
    if (tr.status !== 200) break;
    for (const it of tr.data.items || []) if (it.track && it.track.uri) tracks.push(mapTrack(it.track, art));
    if (!tr.data.next || tracks.length >= 500) break;
    offset += 50;
  }
  return {
    kind: 'playlist',
    name: p.name || 'Playlist',
    owner: (p.owner && (p.owner.display_name || p.owner.id)) || 'someone',
    art,
    total: (p.tracks && p.tracks.total) || tracks.length,
    contextUri: `spotify:playlist:${link.id}`,
    tracks,
  };
}

// ---------------------------------------------------------------- playback

async function getDevices() {
  const r = await api('/me/player/devices');
  return (r.data && r.data.devices) || [];
}

async function pickFallbackDevice() {
  const devices = await getDevices();
  if (!devices.length) return null;
  const remembered = state.spotify.deviceId && devices.find((d) => d.id === state.spotify.deviceId);
  return (remembered && !remembered.is_active && remembered) || devices.find((d) => d.type === 'Computer') || devices[0];
}

async function startPlayback(body) {
  let r = await api('/me/player', { method: 'PUT', body });
  if (r.status === 404) {
    const dev = await pickFallbackDevice();
    if (!dev) throw httpError(r, 'No Spotify device found.');
    await api('/me/player', { method: 'PUT', body: { device_ids: [dev.id] } });
    await new Promise((s) => setTimeout(s, 800));
    r = await api('/me/player', { method: 'PUT', body, qs: { device_id: dev.id } });
  }
  if (r.status >= 400) throw httpError(r, 'Could not start playback.');
  pollNow();
  return { ok: true };
}

async function simpleCommand(method, path, body, qs) {
  let r = await api(path, { method, body, qs });
  if (r.status === 404) {
    const dev = await pickFallbackDevice();
    if (dev) {
      await api('/me/player', { method: 'PUT', body: { device_ids: [dev.id] } });
      await new Promise((s) => setTimeout(s, 700));
      r = await api(path, { method, body, qs: { ...(qs || {}), device_id: dev.id } });
    }
  }
  if (r.status >= 400) throw httpError(r, 'Spotify rejected that command.');
  pollNow();
  return { ok: true };
}

async function control(action, opts = {}) {
  if (!configured() || !state.spotify.tokens) {
    const e = new Error('Spotify is not connected.');
    e.status = 401;
    throw e;
  }
  switch (action) {
    case 'play':
      return startPlayback(opts.contextUri || opts.uris ? toPlayBody(opts) : {});
    case 'playTrack': {
      const body = opts.contextUri
        ? { context_uri: opts.contextUri, offset: { uri: opts.uri } }
        : { uris: [opts.uri] };
      return startPlayback(body);
    }
    case 'pause':
      return simpleCommand('PUT', '/me/player/pause');
    case 'next':
      return simpleCommand('POST', '/me/player/next');
    case 'prev':
      return simpleCommand('POST', '/me/player/previous');
    case 'seek':
      return simpleCommand('PUT', '/me/player/seek', undefined, { position_ms: Math.max(0, Number(opts.positionMs) || 0) });
    case 'volume':
      return simpleCommand('PUT', '/me/player/volume', undefined, { volume_percent: Math.min(100, Math.max(0, Number(opts.percent) || 0)) });
    case 'shuffle':
      return simpleCommand('PUT', '/me/player/shuffle', undefined, { state: String(!!opts.state) });
    case 'repeat':
      return simpleCommand('PUT', '/me/player/repeat', undefined, { state: ['off', 'context', 'track'].includes(opts.state) ? opts.state : 'off' });
    case 'transfer':
      return simpleCommand('PUT', '/me/player', { device_ids: [opts.deviceId], play: opts.play !== false });
    default:
      throw new Error('Unknown action: ' + action);
  }
}

function toPlayBody(opts) {
  if (opts.contextUri) {
    const body = { context_uri: opts.contextUri };
    if (opts.offsetUri) body.offset = { uri: opts.offsetUri };
    else if (opts.offsetIndex !== undefined && opts.offsetIndex !== null) body.offset = { position: opts.offsetIndex };
    if (opts.positionMs) body.position_ms = opts.positionMs;
    return body;
  }
  const body = { uris: opts.uris };
  if (opts.positionMs) body.position_ms = opts.positionMs;
  return body;
}

// ---------------------------------------------------------------- now playing

function buildNow(d) {
  const item = d.item;
  let track = null;
  if (item) {
    const images = (item.album && item.album.images) || [];
    const art = images.find((i) => i.width <= 320 && i.width >= 60) || images[0] || null;
    track = {
      name: item.name,
      artists: (item.artists || []).map((a) => a.name).join(', '),
      art: art ? art.url : null,
      durationMs: item.duration_ms || 0,
      uri: item.uri,
      id: item.id,
      album: item.album ? item.album.name : null,
      url: item.external_urls ? item.external_urls.spotify : null,
      isEpisode: item.type === 'episode',
    };
  }
  return {
    available: true,
    track,
    progressMs: d.progress_ms || 0,
    isPlaying: !!d.is_playing,
    updatedAt: Date.now(),
    context: d.context ? { uri: d.context.uri, type: (d.context.uri.split(':')[1] || '').toLowerCase() } : null,
    shuffle: !!d.shuffle_state,
    repeat: d.repeat_state || 'off',
    volumePercent: typeof d.device && d.device.volume_percent === 'number' ? d.device.volume_percent : null,
    device: d.device ? { name: d.device.name, type: d.device.type, isActive: d.device.is_active } : null,
  };
}

async function pollNow() {
  if (!io || !state.spotify.tokens) return;
  try {
    await ensureToken();
    const r = await api('/me/player', { qs: { additional_types: 'track,episode' } });
    if (r.status === 200 && r.data) lastNow = buildNow(r.data);
    else if (r.status === 204) lastNow = { available: true, track: null, updatedAt: Date.now() };
    else if (r.status === 401) return; // token trouble, skip
    else lastNow = { available: false, updatedAt: Date.now() };
  } catch (e) {
    lastNow = { available: false, error: e.message, updatedAt: Date.now() };
  }
  broadcastNow();
  if (onNow && lastNow && lastNow.track) onNow(lastNow);
}

function currentNow() {
  return lastNow;
}

module.exports = {
  init,
  configured,
  status,
  redirectUri,
  SCOPES,
  ACCOUNTS,
  exchangeCode,
  ensureToken,
  api,
  parseLink,
  fetchCollection,
  control,
  pollNow,
  currentNow,
  broadcastStatus,
  set onNow(v) { onNow = v; },
  get onNow() { return onNow; },
};
