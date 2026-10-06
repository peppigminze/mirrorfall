// MIRRORFALL — local progress, best times, saved replays, editor levels.

const KEY = 'mirrorfall.progress.v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function save(d) {
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* storage unavailable */ }
}

export const store = {
  data: load(),
  level(id) { return (this.data.levels || {})[id] || null; },
  /** Record a result; returns { newBest, prevBest }. */
  recordResult(id, r, replay) {
    this.data.levels = this.data.levels || {};
    const cur = this.data.levels[id] || { stars: [false, false, false], best: 0, ghosts: 0, replay: null, wins: 0 };
    const prevBest = cur.best;
    cur.stars = cur.stars.map((s, i) => s || !!r.starFlags[i]);
    cur.wins = (cur.wins || 0) + 1;
    let newBest = false;
    if (!cur.best || r.tick < cur.best) { cur.best = r.tick; cur.ghosts = r.ghosts; cur.replay = replay; newBest = true; }
    this.data.levels[id] = cur;
    save(this.data);
    return { newBest, prevBest };
  },
  starCount(id) { const l = this.level(id); return l ? l.stars.filter(Boolean).length : 0; },
  solved(id) { return !!this.level(id); },
  editorLevels() { return this.data.editor || []; },
  saveEditorLevels(list) { this.data.editor = list; save(this.data); },
  savedReplays() { return this.data.replays || []; },
  addReplay(entry) {
    this.data.replays = [entry, ...(this.data.replays || []).filter((r) => r.code !== entry.code)].slice(0, 30);
    save(this.data);
  },
  daily(key) { return (this.data.daily || {})[key] || null; },
  recordDaily(key, r) {
    this.data.daily = this.data.daily || {};
    const cur = this.data.daily[key];
    if (!cur || r.tick < cur.tick) this.data.daily[key] = r;
    save(this.data);
  },
  reset() { this.data = {}; save(this.data); },
};
