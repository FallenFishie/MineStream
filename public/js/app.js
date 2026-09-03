/* MineStream client — GIF TV + Spotify remote. No frameworks, no build step. */
/* global io, Spotify */

const $ = (s) => document.querySelector(s);

const socket = io();
let gif = null;          // { onAir, gallery, log, rotation, viewers }
let spStatus = null;     // spotify status payload
let nowData = null;      // now playing payload
let pl = null;           // loaded playlist/album/track view
let playerDeviceId = null;
let spPlayer = null;

/* ------------------------------------------------------------ utils */

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function fmtTime(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

/* ------------------------------------------------------------ socket */

socket.on('connect', () => $('#reconnect').classList.add('hidden'));
socket.on('disconnect', () => $('#reconnect').classList.remove('hidden'));

socket.on('gif:state', (s) => {
  gif = s;
  renderGif();
  renderGallery();
  renderLog();
  renderRotation();
  const v = $('#viewers');
  if (v) v.textContent = `${s.viewers} watching`;
});

socket.on('spotify:status', (s) => {
  spStatus = s;
  renderSpStatus();
  maybeInitPlayer();
});

socket.on('spotify:now', (d) => {
  nowData = d;
  renderNow();
  updatePlayingRow();
});

/* ------------------------------------------------------------ my name */

const nameInput = $('#my-name');
nameInput.value = localStorage.getItem('ms-name') || '';
nameInput.addEventListener('input', () => {
  localStorage.setItem('ms-name', nameInput.value.trim());
});

/* ------------------------------------------------------------ the TV */

let renderedUrl = null;
let proxied = false;

function renderGif() {
  const host = $('#media-host');
  const idle = $('#idle');
  const label = $('#screen-label');
  const badge = $('#onair-badge');
  const on = gif && gif.onAir;

  idle.style.display = on ? 'none' : '';
  badge.style.visibility = on ? 'visible' : 'hidden';
  label.textContent = on ? `${on.title}${on.by ? '  •  by ' + on.by : ''}` : '';

  if (!on) {
    host.replaceChildren();
    renderedUrl = null;
    return;
  }
  if (on.url === renderedUrl) return;
  renderedUrl = on.url;
  proxied = false;
  host.replaceChildren();

  if (on.kind === 'video') {
    const v = document.createElement('video');
    v.src = on.url;
    v.autoplay = true;
    v.loop = true;
    v.muted = true;
    v.playsInline = true;
    v.onerror = () => {
      if (!proxied) {
        proxied = true;
        v.src = '/api/media?u=' + encodeURIComponent(on.url);
        v.play().catch(() => {});
      }
    };
    host.appendChild(v);
  } else {
    const i = document.createElement('img');
    i.src = on.url;
    i.alt = on.title || 'gif';
    i.onerror = () => {
      if (!proxied) {
        proxied = true;
        i.src = '/api/media?u=' + encodeURIComponent(on.url);
      }
    };
    host.appendChild(i);
  }
}

/* gif form */
$('#gif-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#gif-url');
  const url = input.value.trim();
  if (!url) return;
  const btn = $('#gif-form button');
  btn.disabled = true;
  try {
    await api('/api/gif', { method: 'POST', body: { url, by: localStorage.getItem('ms-name') || 'Anonymous' } });
    input.value = '';
    toast('On air!', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#btn-skip').addEventListener('click', () => api('/api/gif/onair', { method: 'DELETE' }).catch((e) => toast(e.message, 'error')));

$('#btn-clear-gallery').addEventListener('click', () => {
  if (!gif || !gif.gallery.length) return;
  if (confirm('Remove ALL GIFs from the loop gallery?')) {
    api('/api/gallery/clear', { method: 'POST' }).catch((e) => toast(e.message, 'error'));
  }
});

/* rotation */
function renderRotation() {
  if (!gif) return;
  $('#rotate-toggle').checked = gif.rotation.enabled;
  $('#rotate-seconds').value = gif.rotation.seconds;
}
$('#rotate-toggle').addEventListener('change', (e) => postRotation());
$('#rotate-seconds').addEventListener('change', () => postRotation());
function postRotation() {
  api('/api/rotation', {
    method: 'POST',
    body: { enabled: $('#rotate-toggle').checked, seconds: parseInt($('#rotate-seconds').value, 10) || 20 },
  }).catch((e) => toast(e.message, 'error'));
}

/* CRT toggle */
const crt = $('#crt-toggle');
crt.checked = localStorage.getItem('ms-crt') === '1';
document.body.classList.toggle('crt', crt.checked);
crt.addEventListener('change', () => {
  document.body.classList.toggle('crt', crt.checked);
  localStorage.setItem('ms-crt', crt.checked ? '1' : '0');
});

/* gallery */
function renderGallery() {
  const g = $('#gallery');
  g.replaceChildren();
  if (!gif || !gif.gallery.length) {
    const s = document.createElement('span');
    s.className = 'empty';
    s.textContent = 'Nothing here yet — paste a GIF link above!';
    g.appendChild(s);
    return;
  }
  for (const item of gif.gallery) {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.title = `${item.title} — added by ${item.by || '?'}`;

    if (item.kind === 'video') {
      const vp = document.createElement('div');
      vp.style.cssText =
        'width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#9a9a9a;font-size:34px;background:linear-gradient(135deg,#161616,#242424)';
      vp.textContent = '\u25B6';
      d.appendChild(vp);
    } else {
      const im = document.createElement('img');
      im.loading = 'lazy';
      im.alt = item.title;
      im.src = item.url;
      im.onerror = () => { im.src = '/api/media?u=' + encodeURIComponent(item.url); };
      d.appendChild(im);
    }

    if (gif.onAir && gif.onAir.url === item.url) {
      const t = document.createElement('span');
      t.className = 'onair-tag';
      t.textContent = 'ON AIR';
      d.appendChild(t);
    }

    const by = document.createElement('span');
    by.className = 'by';
    by.textContent = item.by || '?';
    d.appendChild(by);

    const rm = document.createElement('span');
    rm.className = 'rm';
    rm.textContent = '\u2715';
    rm.title = 'Remove from gallery';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      api('/api/gallery/' + item.id, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
    });
    d.appendChild(rm);

    d.addEventListener('click', () =>
      api('/api/gallery/' + item.id + '/air', { method: 'POST' }).catch((err) => toast(err.message, 'error'))
    );
    g.appendChild(d);
  }
}

function renderLog() {
  const ul = $('#log');
  ul.replaceChildren();
  for (const entry of gif.log || []) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    const dt = new Date(entry.at);
    t.textContent = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    li.appendChild(t);
    li.appendChild(document.createTextNode(entry.text));
    ul.appendChild(li);
  }
}

/* ------------------------------------------------------------ spotify */

const premium = () => !!(spStatus && spStatus.profile && spStatus.profile.product === 'premium');

function renderSpStatus() {
  if (!spStatus) return;
  $('#sp-setup').classList.toggle('hidden', !!spStatus.configured);
  $('#sp-login').classList.toggle('hidden', !(spStatus.configured && !spStatus.connected));
  $('#sp-live').classList.toggle('hidden', !spStatus.connected);

  const prof = $('#sp-profile');
  if (spStatus.connected && spStatus.profile) {
    prof.textContent = spStatus.profile.name + (premium() ? '' : ' (free: display only)');
  } else {
    prof.textContent = '';
  }
}

function renderNow() {
  if (!spStatus || !spStatus.connected) return;
  const nameEl = $('#np-name');
  const artEl = $('#np-art');
  const d = nowData;

  if (!d || !d.track) {
    nameEl.textContent = d && d.available === false ? 'Playback info unavailable' : 'Nothing playing';
    $('#np-artists').textContent = '';
    $('#np-context').textContent = '';
    artEl.src = '/img/idle.png';
    setProgress(0, 0);
    setRemote(null);
    return;
  }

  nameEl.textContent = d.track.name;
  nameEl.title = d.track.name;
  $('#np-artists').textContent = d.track.artists;
  $('#np-context').textContent =
    (d.track.album ? d.track.album + (d.device ? '  •  ' : '') : '') +
    (d.device ? '\u25B6 ' + d.device.name : '');
  if (d.track.art) artEl.src = d.track.art;

  setRemote(d);
}

function setRemote(d) {
  $('#btn-play').innerHTML = d && d.isPlaying ? '\u23F8' : '\u25B6';
  $('#btn-shuffle').classList.toggle('active', !!(d && d.shuffle));
  const rep = $('#btn-repeat');
  rep.classList.toggle('active', !!(d && d.repeat && d.repeat !== 'off'));
  rep.textContent = d && d.repeat === 'track' ? '\uD83D\uDD02' : '\uD83D\uDD01';
  if (d && typeof d.volumePercent === 'number') {
    $('#vol').value = d.volumePercent;
    $('#vol-val').textContent = d.volumePercent;
  }
}

let lastProgressSet = 0;
function setProgress(p, dur) {
  const now = Date.now();
  if (now - lastProgressSet < 400) return;
  lastProgressSet = now;
  const pct = dur > 0 ? Math.min(100, (p / dur) * 100) : 0;
  $('#progress-fill').style.width = pct.toFixed(2) + '%';
  $('#time-cur').textContent = fmtTime(p);
  $('#time-total').textContent = fmtTime(dur);
}

/* smooth interpolation between polls */
setInterval(() => {
  if (!nowData || !nowData.track) return;
  const dur = nowData.track.durationMs;
  let p = nowData.progressMs + (nowData.isPlaying ? Date.now() - nowData.updatedAt : 0);
  if (p > dur) p = dur;
  setProgress(p, dur);
}, 500);

$('#progress').addEventListener('click', (e) => {
  if (!nowData || !nowData.track) return;
  if (spStatus.connected && !premium()) return toast('Seeking needs Spotify Premium', 'error');
  const rect = e.currentTarget.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  spotifyControl('seek', { positionMs: Math.floor(frac * nowData.track.durationMs) });
});

$('#btn-play').addEventListener('click', () => {
  if (!nowData || !nowData.track) return spotifyControl('play', {});
  spotifyControl(nowData.isPlaying ? 'pause' : 'play', {});
});
$('#btn-next').addEventListener('click', () => spotifyControl('next'));
$('#btn-prev').addEventListener('click', () => spotifyControl('prev'));
$('#btn-shuffle').addEventListener('click', () =>
  spotifyControl('shuffle', { state: !(nowData && nowData.shuffle) })
);
$('#btn-repeat').addEventListener('click', () => {
  const cur = (nowData && nowData.repeat) || 'off';
  const nextMode = cur === 'off' ? 'context' : cur === 'context' ? 'track' : 'off';
  spotifyControl('repeat', { state: nextMode });
});

let volTimer = null;
$('#vol').addEventListener('input', (e) => {
  $('#vol-val').textContent = e.target.value;
  clearTimeout(volTimer);
  volTimer = setTimeout(() => spotifyControl('volume', { percent: parseInt(e.target.value, 10) }), 250);
});

$('#btn-play-here').addEventListener('click', () => {
  if (!playerDeviceId) return toast('Player not ready yet — click anywhere on the page once, then try again.', 'error');
  spotifyControl('transfer', { deviceId: playerDeviceId, play: true });
});

$('#btn-logout').addEventListener('click', () => {
  if (confirm('Disconnect Spotify from the TV?')) api('/api/spotify/logout', { method: 'POST' }).catch(() => {});
});

async function spotifyControl(action, extra = {}) {
  try {
    await api('/api/spotify/control', {
      method: 'POST',
      body: { action, by: localStorage.getItem('ms-name') || 'Anonymous', ...extra },
    });
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* spotify link -> playlist view */
$('#sp-link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#sp-link');
  const url = input.value.trim();
  if (!url) return;
  try {
    pl = await api('/api/spotify/link', { method: 'POST', body: { url } });
    input.value = '';
    renderPlaylist();
  } catch (err) {
    toast(err.message, 'error');
  }
});

function renderPlaylist() {
  const el = $('#playlist');
  if (!pl || !pl.tracks) {
    el.classList.add('hidden');
    el.replaceChildren();
    return;
  }
  el.classList.remove('hidden');
  el.replaceChildren();

  const head = document.createElement('div');
  head.className = 'pl-head';
  const img = document.createElement('img');
  img.src = pl.art || '/img/idle.png';
  img.alt = '';
  const meta = document.createElement('div');
  meta.className = 'pl-meta';
  const nm = document.createElement('div');
  nm.className = 'pl-name';
  nm.textContent = pl.name;
  nm.title = pl.name;
  const sub = document.createElement('div');
  sub.className = 'pl-sub';
  sub.textContent = `${pl.kind} by ${pl.owner} — ${pl.tracks.length}${pl.total > pl.tracks.length ? ' of ' + pl.total : ''} tracks`;
  meta.append(nm, sub);
  const playAll = document.createElement('button');
  playAll.className = 'btn small primary';
  playAll.textContent = pl.kind === 'track' ? 'Play' : 'Play all';
  playAll.addEventListener('click', () => {
    if (pl.contextUri) spotifyControl('play', { contextUri: pl.contextUri, label: pl.name });
    else spotifyControl('playTrack', { uri: pl.tracks[0].uri, label: pl.tracks[0].name });
  });
  head.append(img, meta, playAll);
  el.appendChild(head);

  pl.tracks.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'track';
    row.dataset.uri = t.uri;

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = i + 1;

    const art = document.createElement('img');
    art.loading = 'lazy';
    art.src = t.art || '/img/idle.png';
    art.alt = '';

    const m = document.createElement('div');
    m.className = 't-meta';
    const tn = document.createElement('div');
    tn.className = 't-name';
    tn.textContent = t.name;
    tn.title = t.name;
    const ta = document.createElement('div');
    ta.className = 't-artists';
    ta.textContent = t.artists;
    m.append(tn, ta);

    const dur = document.createElement('span');
    dur.className = 't-dur';
    dur.textContent = fmtTime(t.durationMs);

    row.append(idx, art, m, dur);
    row.title = 'Play "' + t.name + '"';
    row.addEventListener('click', () => {
      spotifyControl('playTrack', {
        contextUri: pl.contextUri,
        uri: t.uri,
        label: t.name,
      });
    });
    el.appendChild(row);
  });
  updatePlayingRow();
}

function updatePlayingRow() {
  if (!pl) return;
  const cur = nowData && nowData.track && nowData.track.uri;
  document.querySelectorAll('#playlist .track').forEach((row) => {
    row.classList.toggle('playing', !!cur && row.dataset.uri === cur);
  });
}

/* ------------------------------------------------------------ CC:Tweaked panel */

const ccCmd = $('#cc-cmd');
ccCmd.textContent = `wget run ${location.origin}/cc/minestream.lua`;

$('#cc-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(ccCmd.textContent);
    toast('Command copied!', 'ok');
  } catch {
    toast('Copy failed — select the text manually', 'error');
  }
});

/* radio (audio for the CC:Tweaked speakers) */
$('#radio-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#radio-url');
  const url = input.value.trim();
  if (!url) return;
  try {
    const s = await api('/api/radio', {
      method: 'POST',
      body: { url, by: localStorage.getItem('ms-name') || 'Anonymous' },
    });
    input.value = '';
    renderRadio(s);
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#radio-stop').addEventListener('click', () => api('/api/radio/stop', { method: 'POST' }).catch(() => {}));

function renderRadio(s) {
  const el = $('#radio-status');
  if (s && s.playing) {
    el.textContent = `📻 On air: "${s.title}"${s.by ? ' (by ' + s.by + ')' : ''} — playing on CC speakers`;
    el.classList.add('on');
  } else {
    el.textContent = 'Radio is off';
    el.classList.remove('on');
  }
}

socket.on('radio:state', renderRadio);

/* login result toast */
const qs = new URLSearchParams(location.search);
if (qs.get('spotify') === 'ok') {
  toast('Spotify connected!', 'ok');
  history.replaceState(null, '', '/');
} else if (qs.get('spotify') === 'error') {
  toast('Spotify login failed. Check the redirect URI in your Spotify dashboard.', 'error');
  history.replaceState(null, '', '/');
}

/* --------------------------------------------- Web Playback SDK (TV speaker) */

let sdkLoading = false;

function maybeInitPlayer() {
  const on = spStatus && spStatus.connected && premium();
  $('#btn-play-here').classList.toggle('hidden', !on);
  if (!on || spPlayer || sdkLoading) return;
  sdkLoading = true;
  window.onSpotifyWebPlaybackSDKReady = initPlayer;
  const s = document.createElement('script');
  s.src = 'https://sdk.scdn.co/spotify-player.js';
  s.onerror = () => { sdkLoading = false; };
  document.body.appendChild(s);
}

async function initPlayer() {
  try {
    const tok = await fetch('/api/spotify/token').then((r) => (r.ok ? r.json() : null));
    if (!tok || !tok.accessToken || typeof Spotify === 'undefined') return;
    spPlayer = new Spotify.Player({
      name: 'MineStream TV',
      volume: 0.7,
      getOAuthToken: (cb) => {
        fetch('/api/spotify/token')
          .then((r) => r.json())
          .then((d) => cb(d.accessToken))
          .catch(() => {});
      },
    });
    spPlayer.addListener('ready', ({ device_id }) => {
      playerDeviceId = device_id;
      $('#btn-play-here').disabled = false;
      fetch('/api/spotify/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: device_id }),
      }).catch(() => {});
      toast('This tab is now a Spotify device: "MineStream TV"', 'ok');
    });
    spPlayer.addListener('not_ready', () => {
      $('#btn-play-here').disabled = true;
    });
    for (const ev of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) {
      spPlayer.addListener(ev, (e) => console.warn('[spotify sdk]', ev, e.message));
    }
    spPlayer.connect();
  } catch (e) {
    console.warn('[spotify sdk]', e);
    sdkLoading = false;
  }
}

/* browsers block audio until a gesture happens in the tab */
document.addEventListener(
  'pointerdown',
  () => {
    if (spPlayer) {
      try {
        spPlayer.activateElement();
      } catch {}
    }
  },
  { once: true }
);
