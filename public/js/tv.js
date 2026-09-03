/* MineStream TV-only view (for a fullscreen TV / OBS browser source). */
/* global io, Spotify */

const $ = (s) => document.querySelector(s);
const socket = io();

let gif = null;
let spStatus = null;
let playerDeviceId = null;
let spPlayer = null;

socket.on('connect', () => $('#reconnect').classList.add('hidden'));
socket.on('disconnect', () => $('#reconnect').classList.remove('hidden'));

socket.on('gif:state', (s) => {
  gif = s;
  renderGif();
});

socket.on('spotify:status', (s) => {
  spStatus = s;
  maybeInitPlayer();
});

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

/* If Premium is connected, this tab can also BE the speaker. */
let sdkLoading = false;
function maybeInitPlayer() {
  const on = spStatus && spStatus.connected && spStatus.profile && spStatus.profile.product === 'premium';
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
      fetch('/api/spotify/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: device_id }),
      }).catch(() => {});
    });
    for (const ev of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) {
      spPlayer.addListener(ev, (e) => console.warn('[spotify sdk]', ev, e.message));
    }
    spPlayer.connect();
  } catch (e) {
    sdkLoading = false;
  }
}

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
