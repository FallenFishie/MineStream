# 📺 MineStream

A little Minecraft-flavoured web TV **in full colour**, with two ways to watch:

1. **The web TV** — anyone opens the site, pastes a GIF link (Klipy, Tenor, Giphy, Imgur pages or direct `.gif`/`.mp4` links) and it goes on air for everyone, looping. Plus a proper Spotify panel: full playlists, clickable tracks, live progress bar, volume, shuffle/repeat — and even *Play on this TV* (this browser tab becomes a Spotify speaker).
2. **The in-game TV (CC: Tweaked)** — a Lua program runs on a ComputerCraft **computer** and puts the GIF TV on your **monitors** (dithered to CC's 16 colours, streamed live over websockets) and plays **radio** audio through **speakers**. Spotify title + progress show on the monitor overlay.

No YouTube anywhere, as requested. 🚫▶️

---

## Quick start (local)

```bash
npm install
npm start
# open http://localhost:3000
```

Spotify is optional — everything else works without it.

## Deploy to Render (free tier works!)

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Web Service**, pick the repo.
3. Settings:
   - **Environment**: `Node`
   - **Build command**: `npm install`
   - **Start command**: `node server.js`
   - **Instance type**: Free ✅ (no database, no native deps, no puppeteer)
4. (Optional, for Spotify) Add environment variables `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` (see below).

> Free instances sleep when idle. The first load after a nap takes ~30s to wake. Everything (GIF on air, gallery, Spotify login) survives naps and restarts.

## Spotify setup (optional)

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → **Create app**.
   - Name: anything (`MineStream`).
   - **Redirect URI**: `https://YOUR-APP.onrender.com/api/spotify/callback` (and `http://localhost:3000/api/spotify/callback` for local testing).
   - Which API/SDKs in use: **Web API** + **Web Playback SDK**.
2. Copy the **Client ID** and **Client Secret** into your env vars (`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`) or a local `.env` file:
   ```
   SPOTIFY_CLIENT_ID=...
   SPOTIFY_CLIENT_SECRET=...
   ```
3. On the site: **Login with Spotify**. Done — everyone watching sees and controls the music.

**Who can do what:**
| Account | See now-playing + playlists | Play/pause/seek/volume | "Play on this TV" |
|---|---|---|---|
| Premium | ✅ | ✅ | ✅ |
| Free | ✅ | ❌ (Spotify blocks it) | ❌ |

**Drop any of these into the Spotify box:** playlist link (full track list shows, click any song to play it), album link, or a single track link.

---

## CC: Tweaked — the in-game TV 🖥️

### What you need
- A **computer** (advanced not required), a **monitor** (bigger = better picture — e.g. 5×3 to 8×5 blocks) and optionally a **speaker**, all adjacent to the computer.
- CC: Tweaked for Minecraft 1.19.2+ (older versions can still show the picture, but `speaker` radio needs CC:T 1.100+ for `playAudio`).

### Set it up
1. On the in-game computer, run (using *your* server URL):
   ```
   wget run https://your-app.onrender.com/cc/minestream.lua
   ```
   It asks for the server URL the first time (pre-filled with the right one if you downloaded it from your server), saves it, connects, and the monitor lights up.
2. Make it permanent: `wget https://your-app.onrender.com/cc/minestream.lua startup` then reboot, or copy it into your world's `computercraft/computer/<id>/startup.lua`.

### Controls (in-game)
| Key | Action |
|---|---|
| `Q` | quit |
| `-` / `=` | speaker volume down / up |

### Handy settings
```
set minestream.server "https://your-app.onrender.com"
set minestream.scale 0.5      -- smaller monitor text = sharper picture
set minestream.overlay false  -- hide the music ticker bar
set minestream.volume 2       -- speaker volume (0–3)
```

### How it works
- Every connected computer/monitor gets the **same broadcast** — the server paces GIF frames in real time and streams them as run-length-encoded 16-colour lines that the client slaps onto the monitor with `blit()` (fast!).
- **Monitors: GIFs only.** Videos (mp4) stay web-only — CC can't decode those. The monitor will tell you so.
- **Speakers** play the *radio*: paste a direct `.mp3` / `.wav` / `.ogg` link in the web UI's CC panel and everyone's in-game speakers play it in sync (decoded server-side to 48 kHz PCM, streamed in chunks). Spotify *audio* is DRM-locked by Spotify itself, so in-game you get its title + progress bar on the monitor, and the actual sound from the web TV / Spotify apps.

---

## Web UI extras
- **TV only** link — a screen-only view for a fullscreen browser or an OBS browser source.
- **Auto-rotate** — loop through the whole gallery automatically (adjustable seconds).
- **CRT toggle** — optional scanlines.
- **Activity log** — who put what on air.
- Everyone on the page sees the same GIF at the same time (websockets), and the in-game monitors match too.

## Files
```
server.js              web server, APIs, websocket sync
lib/state.js           JSON-file persistence (data/state.json)
lib/resolve-media.js   turns any GIF page link into a direct media URL
lib/spotify.js         Spotify OAuth + API + playback control
lib/cc-hub.js          websocket hub for CC:Tweaked computers (/cc)
lib/cc-gif.js          GIF → 16-colour dithered monitor frames
lib/cc-radio.js        audio → 48kHz PCM chunks for CC speakers
public/cc/minestream.lua   the in-game client
public/…               the web UI
```
