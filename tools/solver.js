// MIRRORFALL — solver bot.
//
// Pure module (no DOM): runs in Node tests and in a browser worker.
//
// Strategy
//  1. ROLES are derived from the level: hold a plate, hold a vault terminal,
//     flip a switch, throw a lure coin (coin, direction, time), and the FINAL
//     run (loot → exit).
//  2. RUN PLANNER: A* over complete simulation states. Decision points every
//     8 ticks (move ×4, wait, tap, hold, throw ×4). Every child state is
//     produced by the real step() with all ghosts replaying — the planner can
//     never "cheat" the rules. Duplicates are removed via a 53-bit state key.
//     A goal state only counts once the rest of the loop has been simulated
//     without alarm or paradox.
//  3. ORDER SEARCH: iterative deepening over role sequences (0..4 ghosts),
//     prefix cache, optimistic reachability pruning.
//
// Completeness is relative to the 8-tick action grid and the role model.

import { compileLevel, cellOf } from '../sim/level.js';
import {
  makeContext, createWorld, cloneWorld, step, isRunnerEnterable, key53Of,
  G_STATUS, G_TICK, G_LOOT, G_TERMS, G_VAULT_OPEN, G_NRUN,
  R_SIZE, R_TX, R_TY, R_MOV, R_RIDE, R_COINS, R_FACE, R_CARRY,
} from '../sim/world.js';
import { simulateLoop, rebuildCanon } from '../sim/timeline.js';
import {
  GRID_W, CELLS, LOOP_TICKS, MAX_GHOSTS, DX4, DY4, IN_A, DIR_BITS,
  T_WALL, T_CHASM, T_DOOR, T_VAULT, O_SWITCH, O_TERMINAL,
  ST_RUNNING, ST_WON, ST_TIMEOUT, ST_PARADOX, ST_CAUGHT, NOISE_RADIUS, COIN_THROW_TILES,
} from '../sim/constants.js';

export const STEP = 8;
const A_WAIT = 4, A_TAP = 5, A_HOLD = 6, A_THROW = 7;   // throws: 7..10
export const ACTION_NAMES = ['↑', '↓', '←', '→', 'warten', 'tippen', 'halten', 'wirf↑', 'wirf↓', 'wirf←', 'wirf→'];

function actionMask(a, k) {
  if (a < 4) return DIR_BITS[a];
  if (a === A_WAIT) return 0;
  if (a === A_TAP) return k === 0 ? IN_A : 0;
  if (a === A_HOLD) return IN_A;
  return k === 0 ? (IN_A | DIR_BITS[a - A_THROW]) : 0;
}

// ---------------------------------------------------------------------------
// Binary min-heap of node ids keyed by a numeric priority.
// ---------------------------------------------------------------------------
class Heap {
  constructor() { this.ids = []; this.pr = []; }
  get size() { return this.ids.length; }
  push(id, p) {
    const ids = this.ids, pr = this.pr;
    let i = ids.length;
    ids.push(id); pr.push(p);
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (pr[par] <= p) break;
      ids[i] = ids[par]; pr[i] = pr[par]; i = par;
    }
    ids[i] = id; pr[i] = p;
  }
  pop() {
    const ids = this.ids, pr = this.pr;
    const top = ids[0];
    const lastId = ids.pop(), lastP = pr.pop();
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && pr[c + 1] < pr[c]) c++;
        if (pr[c] >= lastP) break;
        ids[i] = ids[c]; pr[i] = pr[c]; i = c;
      }
      ids[i] = lastId; pr[i] = lastP;
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// Static helpers
// ---------------------------------------------------------------------------

/** BFS distance field (tiles) from `sources` over cells accepted by `pass`. */
export function distField(sources, pass) {
  const dist = new Int16Array(CELLS).fill(-1);
  const q = new Int32Array(CELLS);
  let qh = 0, qt = 0;
  for (const s of sources) { if (dist[s] < 0) { dist[s] = 0; q[qt++] = s; } }
  while (qh < qt) {
    const c = q[qh++];
    const x = c % GRID_W, y = (c / GRID_W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d], ny = y + DY4[d];
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= 17) continue;
      const n = ny * GRID_W + nx;
      if (dist[n] >= 0 || !pass(n)) continue;
      dist[n] = dist[c] + 1; q[qt++] = n;
    }
  }
  return dist;
}

/** Relaxed passability: everything but walls and non-platform chasm. */
function relaxedPass(L) {
  return (c) => {
    const t = L.tile[c];
    if (t === T_WALL) return false;
    if (t === T_CHASM) return L.platformAt[c] >= 0;
    return true;
  };
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** Derive candidate helper roles from the level. */
export function deriveRoles(L) {
  const roles = [];
  const chUsed = new Set();
  for (const d of L.doors) chUsed.add(d.ch);
  for (const z of L.lasers) if (z.ch >= 0) chUsed.add(z.ch);
  for (const c of L.cameras) if (c.ch >= 0) chUsed.add(c.ch);
  for (const p of L.platforms) if (p.ch >= 0) chUsed.add(p.ch);
  L.plates.forEach((p, i) => {
    if (chUsed.has(p.ch)) roles.push({ key: `platte${i}`, kind: 'plate', cell: p.c, label: `Platte ${i + 1} halten` });
  });
  L.switches.forEach((s, i) => {
    if (chUsed.has(s.ch)) roles.push({ key: `schalter${i}`, kind: 'switch', cell: s.c, label: `Schalter ${i + 1} umlegen` });
  });
  if (L.terminals.length === 2) {
    L.terminals.forEach((t, i) => roles.push({ key: `terminal${i}`, kind: 'terminal', cell: t.c, label: `Terminal ${i + 1} halten` }));
  }
  if (L.guards.length && L.coins.length) {
    // Lure: pick up a coin, (optionally wait), throw it from the coin tile in a
    // direction whose landing spot some guard can hear.
    const gpass = (c) => L.tile[c] !== T_WALL && L.tile[c] !== T_CHASM && L.tile[c] !== T_VAULT;
    L.coins.forEach((co, ci) => {
      for (let d = 0; d < 4; d++) {
        let land = co.c;
        for (let k = 0; k < COIN_THROW_TILES; k++) {
          const n = land + DX4[d] + DY4[d] * GRID_W;
          if (L.tile[n] === T_WALL || L.tile[n] === T_DOOR || L.tile[n] === T_VAULT) break;
          land = n;
        }
        if (land === co.c || !gpass(land)) continue;
        const df = distField([land], gpass);
        const hears = L.guards.some((g) => g.route.some((c) => df[c] >= 0 && df[c] <= NOISE_RADIUS));
        if (!hears) continue;
        for (const T of [0, 300, 600, 900, 1200]) {
          roles.push({ key: `köder${ci}${'↑↓←→'[d]}@${T}`, kind: 'lure', cell: co.c, coin: ci, dir: d, at: T,
            label: `Münze ${ci + 1} nach ${'↑↓←→'[d]} werfen (ab ${(T / 60).toFixed(0)} s)` });
        }
      }
    });
  }
  return roles;
}

// ---------------------------------------------------------------------------
// Run planner (A*)
// ---------------------------------------------------------------------------

/**
 * Plan one run of the live runner against fixed ghosts.
 * goal = { kind, cell?, ... } (role) or { kind: 'final' }.
 * Returns { inputs: Uint8Array(1800), tick, expansions } or { fail, expansions }.
 */
export function planRun(ctx, ghostRuns, ghostCanon, goal, opts = {}) {
  const L = ctx.L;
  const n = ghostRuns.length + 1, live = n - 1;
  const maxExp = opts.maxExpansions ?? 40000;
  const weight = opts.weight ?? 1;
  const lb = ctx.lay.R + live * R_SIZE;
  const pass = relaxedPass(L);

  // Heuristic distance fields.
  let dGoal = null, dLoot = null, dExit = null;
  if (goal.kind === 'final') {
    dLoot = distField([L.loot], pass);
    dExit = distField(L.exits, pass);
  } else {
    dGoal = distField([goal.cell], pass);
  }
  const lootToExit = dExit ? dExit[L.loot] : 0;
  const heur = (s) => {
    const c = s[lb + R_TY] * GRID_W + s[lb + R_TX];
    if (goal.kind === 'final') {
      const lo = s[G_LOOT];
      if (lo === live) return dExit[c] < 0 ? -1 : dExit[c] * STEP;
      if (lo !== -1) return -1;      // a ghost has the loot: impossible
      if (dLoot[c] < 0 || lootToExit < 0) return -1;
      return (dLoot[c] + lootToExit) * STEP;
    }
    if (goal.kind === 'lure' && s[ctx.lay.CS + goal.coin] === 1) return dGoal[c] < 0 ? -1 : dGoal[c] * STEP;
    return dGoal[c] < 0 ? -1 : dGoal[c] * STEP;
  };

  const inputs = new Uint8Array(n);
  const advance = (w, a) => {
    const s = w.s;
    for (let k = 0; k < STEP; k++) {
      const t = s[G_TICK];
      if (t >= LOOP_TICKS) break;
      for (let j = 0; j < live; j++) inputs[j] = ghostRuns[j][t];
      inputs[live] = actionMask(a, k);
      step(w, inputs);
      if (s[G_STATUS] !== ST_RUNNING) break;
    }
  };
  const keyOf = (s) => {
    const f = s[lb + R_FACE];
    s[lb + R_FACE] = 0;
    const k = key53Of(s);
    s[lb + R_FACE] = f;
    return k;
  };

  // Node storage.
  const states = [], parent = [], action = [];
  const seen = new Set();
  const heap = new Heap();
  const start = opts.start;    // { s, prefix, t0 } — continue from a mid-loop state
  const root = start ? { s: start.s.slice() } : createWorld(ctx, n, ghostCanon);
  states.push(root.s); parent.push(-1); action.push(-1);
  seen.add(keyOf(root.s));
  const h0 = heur(root.s);
  if (h0 < 0) return { fail: 'unreachable', expansions: 0 };
  heap.push(0, h0 * weight);

  const reconstruct = (id) => {
    const acts = [];
    for (let i = id; parent[i] >= 0; i = parent[i]) acts.push(action[i]);
    acts.reverse();
    const out = new Uint8Array(LOOP_TICKS);
    let t = 0;
    if (start) { out.set(start.prefix.subarray(0, start.t0)); t = start.t0; }
    for (const a of acts) for (let k = 0; k < STEP && t < LOOP_TICKS; k++) out[t++] = actionMask(a, k);
    return { out, t, acts };
  };

  const w = { ctx, s: null, canon: ghostCanon, recordEvents: false, events: [] };
  let expansions = 0;
  while (heap.size && expansions < maxExp) {
    const id = heap.pop();
    const s = states[id];
    states[id] = null;
    expansions++;
    w.s = s;
    const tick = s[G_TICK];

    // Goal test for helper roles (at decision points).
    if (goal.kind !== 'final' && isGoal(ctx, s, lb, goal)) {
      const { out, t, acts } = reconstruct(id);
      const tail = goal.kind === 'lure'
        ? lureTail(ctx, ghostRuns, ghostCanon, out, t, s, goal)
        : verifyTail(ctx, ghostRuns, ghostCanon, out, t, goal);
      if (tail) return { inputs: tail.inputs, tick, expansions, acts, canon: tail.canon };
    }

    const idle = s[lb + R_MOV] === -1 && s[lb + R_RIDE] === -1;
    const cell = s[lb + R_TY] * GRID_W + s[lb + R_TX];
    for (let a = 0; a <= 10; a++) {
      if (!idle && a !== A_WAIT) continue;
      if (a < 4) {
        const nc = cell + DX4[a] + DY4[a] * GRID_W;
        if (!isRunnerEnterable(w, nc)) continue;
      } else if (a === A_TAP) {
        if (L.obj[cell] !== O_SWITCH) continue;
      } else if (a === A_HOLD) {
        if (L.obj[cell] !== O_TERMINAL) continue;
      } else if (a >= A_THROW) {
        if (s[lb + R_COINS] <= 0 || L.obj[cell] === O_SWITCH || L.obj[cell] === O_TERMINAL) continue;
        if (goal.kind === 'lure') continue;          // lure throws happen in the tail
      }
      const child = { ctx, s: s.slice(), canon: ghostCanon, recordEvents: false, events: [] };
      advance(child, a);
      const cs = child.s, st = cs[G_STATUS];
      if (st === ST_WON && goal.kind === 'final' && cs[G_LOOT] === live) {
        states.push(null); parent.push(id); action.push(a);
        const cid = states.length - 1;
        const { out } = reconstruct(cid);
        const winTick = cs[G_TICK];
        out.fill(0, winTick);
        return { inputs: out, tick: winTick, expansions, acts: reconstruct(cid).acts };
      }
      if (st !== ST_RUNNING) continue;
      if (goal.kind !== 'final' && cs[G_LOOT] === live) continue;   // helpers leave the loot alone
      const hc = heur(cs);
      if (hc < 0) continue;
      if (cs[G_TICK] + hc > LOOP_TICKS) continue;
      const k = keyOf(cs);
      if (seen.has(k)) continue;
      seen.add(k);
      states.push(cs); parent.push(id); action.push(a);
      heap.push(states.length - 1, (cs[G_TICK] + hc * weight) * 64 + (hc / STEP));
    }
  }
  return { fail: heap.size ? 'budget' : 'exhausted', expansions };
}

function isGoal(ctx, s, lb, goal) {
  if (goal.kind === 'reach' && goal.notBefore && s[G_TICK] < goal.notBefore) return false;
  if (s[lb + R_MOV] !== -1 || s[lb + R_RIDE] !== -1) return false;
  const c = s[lb + R_TY] * GRID_W + s[lb + R_TX];
  if (c !== goal.cell) return false;
  if (goal.kind === 'lure') return s[lb + R_COINS] > 0 && s[ctx.lay.CS + goal.coin] === 0;
  return true;
}

/**
 * Lure tail: wait until the role's time, throw the coin, then retreat to the
 * spawn (nested A*) so the curious guard does not spot the thrower.
 */
function lureTail(ctx, ghostRuns, ghostCanon, prefix, t, s, goal) {
  const at = Math.max(t, goal.at);
  if (at >= LOOP_TICKS - 40) return null;
  const inp = prefix.slice();
  inp.fill(0, t);
  inp[at] = IN_A | DIR_BITS[goal.dir];
  // Advance a copy of the goal state through the wait and the throw.
  const n = ghostRuns.length + 1, live = n - 1;
  const w = { ctx, s: s.slice(), canon: ghostCanon, recordEvents: false, events: [] };
  const buf = new Uint8Array(n);
  while (w.s[G_TICK] <= at) {
    const tt = w.s[G_TICK];
    for (let j = 0; j < live; j++) buf[j] = ghostRuns[j][tt];
    buf[live] = inp[tt];
    step(w, buf);
    if (w.s[G_STATUS] !== ST_RUNNING) return null;
  }
  const back = planRun(ctx, ghostRuns, ghostCanon, { kind: 'reach', cell: ctx.L.spawn },
    { maxExpansions: 4000, start: { s: w.s, prefix: inp, t0: w.s[G_TICK] } });
  if (!back.inputs) return null;
  return { inputs: back.inputs, canon: back.canon };
}

/** Append the role's tail behaviour and verify the full loop (no alarm, no paradox). */
function verifyTail(ctx, ghostRuns, ghostCanon, prefix, t, goal) {
  const inp = prefix.slice();
  if (goal.kind === 'terminal') inp.fill(IN_A, t);
  else if (goal.kind === 'switch') { inp[t] = IN_A; inp.fill(0, t + 1); }
  else if (goal.kind === 'lure') {
    const at = Math.max(t, goal.at);
    if (at >= LOOP_TICKS - 20) return null;
    inp.fill(0, t);
    inp[at] = IN_A | DIR_BITS[goal.dir];
  } else inp.fill(0, t);
  const r = simulateLoop(ctx, ghostRuns, ghostCanon, inp, { recordSig: true });
  if (r.status !== ST_TIMEOUT) return null;
  return { inputs: inp, canon: r.liveSig };
}

// ---------------------------------------------------------------------------
// Optimistic reachability (cheap pruning)
// ---------------------------------------------------------------------------

/**
 * Simulate the ghosts-only world and collect which doors were ever open,
 * whether the vault was ever open / a terminal ever held. Returns a relaxed
 * passability predicate for the next (live) runner.
 */
function optimisticPass(ctx, ghostRuns, ghostCanon) {
  const L = ctx.L, lay = ctx.lay;
  const everOpen = new Uint8Array(L.doors.length);
  let vaultEver = 0, termEver = 0;
  const note = (s) => {
    for (let d = 0; d < L.doors.length; d++) if (s[lay.DR + d]) everOpen[d] = 1;
    if (s[G_VAULT_OPEN]) vaultEver = 1;
    if (s[G_TERMS]) termEver = 1;
  };
  if (ghostRuns.length === 0) {
    const w = createWorld(ctx, 1, []);
    note(w.s);
  } else {
    const k = ghostRuns.length;
    const r = simulateLoop(ctx, ghostRuns.slice(0, k - 1), ghostCanon.slice(0, k - 1), ghostRuns[k - 1], { onTick: (w) => note(w.s) });
    void r;
  }
  for (let d = 0; d < L.doors.length; d++) {
    const D = L.doors[d];
    if ((L.chHasSwitch >> D.ch) & 1) everOpen[d] = 1;
    // A plate right next to its door lets a single runner slip through.
    for (const p of L.plates) {
      if (p.ch !== D.ch) continue;
      if (Math.abs(p.x - D.x) + Math.abs(p.y - D.y) === 1) everOpen[d] = 1;
    }
  }
  const vaultOk = vaultEver || termEver;
  return (c) => {
    const t = L.tile[c];
    if (t === T_WALL) return false;
    if (t === T_CHASM) return L.platformAt[c] >= 0;
    if (t === T_DOOR) return everOpen[L.doorAt[c]] === 1;
    if (t === T_VAULT) return vaultOk;
    return true;
  };
}

function finalReachable(ctx, pass) {
  const L = ctx.L;
  const d = distField([L.spawn], pass);
  if (d[L.loot] < 0) return false;
  const e = distField([L.loot], pass);
  return L.exits.some((x) => e[x] >= 0);
}

// ---------------------------------------------------------------------------
// Order search
// ---------------------------------------------------------------------------

/**
 * Solve a level. Returns
 *  { ok, runs: Uint8Array[], roles: [label], finalTick, stats }
 */
export function solve(def, opts = {}) {
  const L = def.tile ? def : compileLevel(def);
  const ctx = makeContext(L);
  const roles = opts.roles ?? deriveRoles(L);
  const maxGhosts = Math.min(opts.maxGhosts ?? MAX_GHOSTS, MAX_GHOSTS);
  const t0 = Date.now();
  const deadline = opts.timeLimitMs ? t0 + opts.timeLimitMs : Infinity;
  const stats = { roles: roles.length, sequences: 0, plans: 0, finals: 0, expansions: 0, pruned: 0 };
  const cache = new Map();   // seq key → { runs, canon } | null
  const progress = opts.onProgress || (() => {});

  const planPrefix = (seq) => {
    const key = seq.map((r) => r.key).join('|');
    if (cache.has(key)) return cache.get(key);
    let res = null;
    if (seq.length === 0) res = { runs: [], canon: [] };
    else {
      const prev = planPrefix(seq.slice(0, -1));
      if (prev) {
        const role = seq[seq.length - 1];
        const pass = optimisticPass(ctx, prev.runs, prev.canon);
        const reach = distField([L.spawn], pass);
        if (reach[role.cell] < 0) { stats.pruned++; }
        else {
          stats.plans++;
          const p = planRun(ctx, prev.runs, prev.canon, role, { maxExpansions: opts.roleExpansions ?? 6000 });
          stats.expansions += p.expansions;
          if (p.inputs) res = { runs: [...prev.runs, p.inputs], canon: [...prev.canon, p.canon], arrive: [...(prev.arrive || []), p.tick] };
        }
      }
    }
    cache.set(key, res);
    return res;
  };

  const tryFinal = (seq) => {
    const pre = planPrefix(seq);
    if (!pre) return null;
    const pass = optimisticPass(ctx, pre.runs, pre.canon);
    if (!finalReachable(ctx, pass)) { stats.pruned++; return null; }
    stats.finals++;
    const f = planRun(ctx, pre.runs, pre.canon, { kind: 'final' }, { maxExpansions: opts.finalExpansions ?? 40000, weight: opts.weight ?? 1 });
    stats.expansions += f.expansions;
    if (!f.inputs) return null;
    return { runs: [...pre.runs, f.inputs], finalTick: f.tick, acts: f.acts, arrive: pre.arrive || [] };
  };

  let timedOut = false;
  const search = (seq, depth, used) => {
    if (Date.now() > deadline) { timedOut = true; return null; }
    if (seq.length === depth) {
      stats.sequences++;
      if (stats.sequences % 8 === 0) progress(stats);
      return tryFinal(seq);
    }
    for (let i = 0; i < roles.length; i++) {
      if (used & (1 << i)) continue;
      const r = roles[i];
      // Two lure variants of the same coin are mutually exclusive.
      if (r.kind === 'lure' && seq.some((q) => q.kind === 'lure' && q.coin === r.coin)) continue;
      const next = [...seq, r];
      if (!planPrefix(next)) continue;
      const res = search(next, depth, used | (1 << i));
      if (res) return { ...res, seq: res.seq || next };
      if (timedOut) return null;
    }
    return null;
  };

  for (let depth = opts.minGhosts ?? 0; depth <= maxGhosts; depth++) {
    const res = search([], depth, 0);
    if (res) {
      const seq = res.seq || [];
      return {
        ok: true, runs: res.runs, roles: seq.map((r) => r.label), roleKeys: seq.map((r) => r.key),
        finalTick: res.finalTick, acts: res.acts, arrive: res.arrive,
        stats: { ...stats, ms: Date.now() - t0 },
      };
    }
    if (timedOut) break;
  }
  return { ok: false, timedOut, stats: { ...stats, ms: Date.now() - t0 } };
}

/** Independently verify a list of runs: rebuild all traces; the last run must win. */
export function verifySolution(def, runs) {
  const L = def.tile ? def : compileLevel(def);
  const ctx = makeContext(L);
  const rb = rebuildCanon(ctx, runs);
  const last = rb.results[rb.results.length - 1];
  return { ok: rb.ok && last && last.status === ST_WON, failedAt: rb.failedAt, status: last?.status, tick: last?.tick, results: rb.results };
}

/**
 * Plan a given ordered list of role keys (used for the paradox proof).
 * Returns { ok, stage, reason } describing where it breaks.
 */
export function planSequence(def, roleKeys, opts = {}) {
  const L = def.tile ? def : compileLevel(def);
  const ctx = makeContext(L);
  const all = deriveRoles(L);
  const runs = [], canon = [];
  for (let i = 0; i < roleKeys.length; i++) {
    const role = all.find((r) => r.key === roleKeys[i]);
    if (!role) return { ok: false, stage: i, reason: 'unbekannte Rolle' };
    const p = planRun(ctx, runs, canon, role, { maxExpansions: opts.roleExpansions ?? 20000 });
    if (!p.inputs) return { ok: false, stage: i, reason: `Rolle „${role.label}“ nicht planbar (${p.fail})` };
    runs.push(p.inputs); canon.push(p.canon);
  }
  const f = planRun(ctx, runs, canon, { kind: 'final' }, { maxExpansions: opts.finalExpansions ?? 60000 });
  if (!f.inputs) return { ok: false, stage: roleKeys.length, reason: `Finale nicht planbar (${f.fail})` };
  return { ok: true, finalTick: f.tick };
}

export { ST_PARADOX, ST_CAUGHT, ST_WON, ST_TIMEOUT };
export { cellOf };
