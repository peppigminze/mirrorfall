// MIRRORFALL — persisted settings.

const KEY = 'mirrorfall.settings.v1';

const prefersReduced = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export const DEFAULTS = {
  master: 0.8, music: 0.6, sfx: 0.85,
  colorblind: false, reducedMotion: null, shake: true,
  quality: 'auto',       // auto | low | med | high
  touch: 'auto',         // auto | on | off
  showFps: false,
  renderer: 'auto',      // auto | webgl2 | canvas2d
};

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { s = {}; }
  const out = { ...DEFAULTS, ...s };
  if (out.reducedMotion === null) out.reducedMotion = prefersReduced();
  return out;
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
