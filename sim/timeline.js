// MIRRORFALL — timeline: recorded runs, canonical traces, paradox handling.
//
// A run = one loop's worth of inputs of one runner. When run k is recorded,
// the world contained ghosts 0..k-1. The canonical trace of run k is the
// signature of runner k at every tick of THAT world. Because the simulation is
// deterministic, canonical traces can always be rebuilt from inputs alone
// (see rebuildCanon) — replays therefore only need to store inputs.

import { LOOP_TICKS, MAX_GHOSTS, ST_RUNNING, ST_WON, ST_TIMEOUT } from './constants.js';
import { createWorld, step, sigOf, makeContext, G_STATUS, G_STATUS_ARG, G_FAIL, G_TICK } from './world.js';

/** Simulate a loop. ghostInputs: Uint8Array[]; live: Uint8Array (or null = idle). */
export function simulateLoop(ctx, ghostInputs, canon, live, opts = {}) {
  const n = ghostInputs.length + 1;
  const w = createWorld(ctx, n, canon, !!opts.events);
  const inputs = new Uint8Array(n);
  const liveSig = opts.recordSig ? new Uint32Array(LOOP_TICKS) : null;
  const onTick = opts.onTick;
  const maxTicks = opts.maxTicks ?? LOOP_TICKS;
  while (w.s[G_STATUS] === ST_RUNNING && w.s[G_TICK] < maxTicks) {
    const t = w.s[G_TICK];
    for (let j = 0; j < n - 1; j++) inputs[j] = ghostInputs[j][t];
    inputs[n - 1] = live ? live[t] : 0;
    step(w, inputs);
    if (liveSig) liveSig[t] = sigOf(w, n - 1);
    if (onTick) onTick(w);
  }
  return { world: w, status: w.s[G_STATUS], arg: w.s[G_STATUS_ARG], fail: w.s[G_FAIL], tick: w.s[G_TICK], liveSig };
}

/**
 * Rebuild canonical traces for a list of recordings (in recording order).
 * Returns { ok, canon[], results[] }. The last run may end in a win; every
 * earlier run must reach the end of the loop without failure.
 */
export function rebuildCanon(ctx, runs) {
  const canon = [];
  const results = [];
  for (let k = 0; k < runs.length; k++) {
    const r = simulateLoop(ctx, runs.slice(0, k), canon, runs[k], { recordSig: true });
    results.push(r);
    const last = k === runs.length - 1;
    if (r.status === ST_TIMEOUT || (r.status === ST_RUNNING && r.tick >= LOOP_TICKS)) {
      canon.push(r.liveSig);
    } else if (last && r.status === ST_WON) {
      canon.push(r.liveSig);
    } else {
      return { ok: false, canon, results, failedAt: k };
    }
  }
  return { ok: true, canon, results };
}

/**
 * Timeline used by the game session. Keeps an undo stack of snapshots of the
 * run list (runs are immutable once recorded, so snapshots are cheap).
 */
export class Timeline {
  constructor(level) {
    this.ctx = makeContext(level);
    this.runs = [];      // [{ inputs: Uint8Array, canon: Uint32Array }]
    this.history = [];
  }
  get ghostCount() { return this.runs.length; }
  get full() { return this.runs.length >= MAX_GHOSTS; }

  /** World for a new loop (ghosts + one live runner). */
  createLoopWorld(recordEvents = true) {
    return createWorld(this.ctx, this.runs.length + 1, this.runs.map((r) => r.canon), recordEvents);
  }
  ghostInput(j, tick) { return this.runs[j].inputs[tick]; }

  pushHistory() { this.history.push(this.runs.slice()); if (this.history.length > 64) this.history.shift(); }

  /** Live run reached the loop end: becomes a ghost. */
  /** extra: optional { packed: Uint32Array, act: Int32Array } per tick (for paradox explanations). */
  commit(inputs, canon, extra = {}) {
    if (this.full) return false;
    this.pushHistory();
    this.runs.push({ inputs, canon, ...extra });
    return true;
  }
  /** Paradox at ghost j: the timeline breaks from this ghost on. */
  collapse(j) {
    this.pushHistory();
    this.runs.length = Math.min(this.runs.length, j);
  }
  undo() {
    if (!this.history.length) return false;
    this.runs = this.history.pop();
    return true;
  }
  reset() { this.pushHistory(); this.runs = []; }
}
