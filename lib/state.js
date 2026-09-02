// Tiny JSON-file persistence. Survives restarts on the same machine/instance.
// On Render free the disk is ephemeral across deploys, but state still survives
// restarts and idle spin-downs of the same instance, which is good enough.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'state.json');

const DEFAULTS = {
  onAir: null,                                   // the GIF currently on screen
  gallery: [],                                   // past GIFs (the loop pool)
  log: [],                                       // activity feed
  rotation: { enabled: false, seconds: 20 },     // auto-rotate the gallery
  spotify: { tokens: null, profile: null, deviceId: null },
};

let state;
try {
  state = { ...structuredClone(DEFAULTS), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  state.rotation = { ...DEFAULTS.rotation, ...(state.rotation || {}) };
  state.spotify = { ...DEFAULTS.spotify, ...(state.spotify || {}) };
} catch {
  state = structuredClone(DEFAULTS);
}

let timer = null;
function saveStateSoon() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error('[state] save failed:', e.message);
    }
  }, 400);
}

module.exports = { state, saveStateSoon };
