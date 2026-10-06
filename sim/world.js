// MIRRORFALL — the deterministic world simulation.
//
// The complete mutable state of one loop lives in ONE flat Int32Array (`w.s`).
// That makes cloning (`slice()`), hashing and fuzz-checking trivial and keeps
// the solver fast. Static level data lives in the compiled level (`ctx.L`).
//
// Rules (see DESIGN.md §2):
//  * integer-only arithmetic, fixed iteration order, no Math.random / Date
//  * one call to step() == one 60 Hz tick
//  * ghosts are real agents fed by their recorded inputs; a ghost that gets
//    caught or deviates from its canonical signature trace causes a PARADOX.

import {
  GRID_W, GRID_H, CELLS, LOOP_TICKS, MOVE_TICKS, MAX_RUNNERS, SU, HALF_SU, RUNNER_SPEED, GUARD_SPEED, PLATFORM_SPEED,
  IN_U, IN_D, IN_L, IN_R, IN_A, DX4, DY4, DIR_U, DIR_D, DIR_L, DIR_R,
  ALARM_TICKS, SUSP_DECAY, GUARD_RANGE_SU, GUARD_COS2_K, CAMERA_RANGE_SU, CAMERA_COS2_K, LOS_STEP_SU,
  MAX_COINS_CARRIED, COIN_THROW_TILES, COIN_FLIGHT_TICKS, COIN_SLOTS, COIN_LANDED_TICKS, NOISE_RADIUS,
  GUARD_LOOK_TICKS, GUARD_LOOK_TURN, VAULT_HOLD_TICKS,
  T_FLOOR, T_WALL, T_CHASM, T_DOOR, T_VAULT,
  O_EXIT, O_LOOT, O_COIN, O_PLATE, O_SWITCH, O_TERMINAL,
  ST_RUNNING, ST_WON, ST_CAUGHT, ST_PARADOX, ST_TIMEOUT,
  FAIL_GUARD, FAIL_CAMERA, FAIL_LASER, FAIL_FELL, FAIL_DIVERGED,
  GM_PATROL, GM_INVESTIGATE, GM_LOOK, GM_RETURN,
  EV_DOOR_OPEN, EV_DOOR_CLOSE, EV_PLATE_ON, EV_PLATE_OFF, EV_SWITCH, EV_COIN_PICK, EV_COIN_THROW,
  EV_COIN_LAND, EV_GUARD_HEAR, EV_LOOT_PICK, EV_VAULT_OPEN, EV_CAUGHT, EV_PARADOX, EV_WIN, EV_STEP,
  EV_LASER_ON, EV_PLATFORM_GO, EV_SPOTTED, EV_BUMP,
} from './constants.js';
import { DIR_X, DIR_Y, DIR_SCALE, DIR_COUNT } from './dirtable.js';
import { hash32, fnv1a, key53 } from './rng.js';

// ---------------------------------------------------------------------------
// State layout
// ---------------------------------------------------------------------------

// Global block.
export const G_TICK = 0, G_STATUS = 1, G_STATUS_ARG = 2, G_FAIL = 3, G_VAULT_PROG = 4,
  G_VAULT_OPEN = 5, G_LOOT = 6, G_CHANNELS = 7, G_NRUN = 8, G_LIVE = 9, G_PLATES = 10, G_TERMS = 11;
const G_SIZE = 12;

// Runner block (per runner).
export const R_PX = 0, R_PY = 1, R_TX = 2, R_TY = 3, R_MOV = 4, R_FACE = 5, R_CARRY = 6, R_COINS = 7,
  R_ALIVE = 8, R_PREVA = 9, R_SUSP = 10, R_ACT = 11, R_RIDE = 12, R_FAIL = 13, R_SEEN = 14, R_HOLD = 15;
export const R_SIZE = 16;

// Guard block.
export const GD_PX = 0, GD_PY = 1, GD_TX = 2, GD_TY = 3, GD_MOV = 4, GD_FACE = 5, GD_MODE = 6,
  GD_IDX = 7, GD_TIMER = 8, GD_TGT = 9, GD_ALERT = 10, GD_SEES = 11;
export const GD_SIZE = 12;

// Camera block.
export const CM_ANG = 0, CM_DIR = 1, CM_TIMER = 2, CM_SUB = 3, CM_ON = 4, CM_ALERT = 5;
export const CM_SIZE = 6;

// Thrown coin slots.
export const TC_STATE = 0, TC_SX = 1, TC_SY = 2, TC_EC = 3, TC_T = 4, TC_OWNER = 5;
export const TC_SIZE = 6;

// Platforms.
export const PF_IDX = 0, PF_DIR = 1, PF_MODE = 2, PF_TIMER = 3, PF_PX = 4, PF_PY = 5;
export const PF_SIZE = 6;
const PF_DWELL = 0, PF_SLIDE = 1;

/** Compute the state layout for a compiled level. */
export function makeLayout(L) {
  let o = 0;
  const lay = {};
  lay.G = o; o += G_SIZE;
  lay.R = o; o += MAX_RUNNERS * R_SIZE;
  lay.GD = o; lay.nGD = L.guards.length; o += lay.nGD * GD_SIZE;
  lay.CM = o; lay.nCM = L.cameras.length; o += lay.nCM * CM_SIZE;
  lay.DR = o; lay.nDR = L.doors.length; o += lay.nDR;
  lay.SW = o; lay.nSW = L.switches.length; o += lay.nSW;
  lay.CS = o; lay.nCS = L.coins.length; o += lay.nCS;
  lay.TC = o; o += COIN_SLOTS * TC_SIZE;
  lay.PF = o; lay.nPF = L.platforms.length; o += lay.nPF * PF_SIZE;
  lay.LZ = o; lay.nLZ = L.lasers.length; o += lay.nLZ;
  lay.size = o;
  return lay;
}

/**
 * Per-level simulation context: static data + scratch buffers.
 * Scratch buffers are only used transiently inside one step() call, so all
 * worlds of the same level may share one context (single-threaded).
 */
export function makeContext(L) {
  return {
    L,
    lay: makeLayout(L),
    dist: new Int16Array(CELLS),
    queue: new Int32Array(CELLS),
    beam: new Uint8Array(CELLS),
  };
}

/**
 * Create the initial world for a loop with `nRunners` runners
 * (runners 0..n-2 are ghosts, runner n-1 is live).
 * `canon[j]` is the canonical signature trace (Uint32Array) of ghost j.
 */
export function createWorld(ctx, nRunners, canon = [], recordEvents = false) {
  const { L, lay } = ctx;
  if (nRunners < 1 || nRunners > MAX_RUNNERS) throw new Error('bad runner count');
  const s = new Int32Array(lay.size);
  s[G_LOOT] = -1;
  s[G_NRUN] = nRunners;
  s[G_LIVE] = nRunners - 1;
  const sx = (L.spawn % GRID_W), sy = (L.spawn / GRID_W) | 0;
  for (let i = 0; i < MAX_RUNNERS; i++) {
    const b = lay.R + i * R_SIZE;
    s[b + R_PX] = sx * SU; s[b + R_PY] = sy * SU;
    s[b + R_TX] = sx; s[b + R_TY] = sy;
    s[b + R_MOV] = -1; s[b + R_FACE] = DIR_R;
    s[b + R_ALIVE] = i < nRunners ? 1 : 0;
    s[b + R_RIDE] = -1; s[b + R_SEEN] = -1;
  }
  for (let g = 0; g < lay.nGD; g++) {
    const G = L.guards[g], b = lay.GD + g * GD_SIZE;
    const c = G.startCell, x = c % GRID_W, y = (c / GRID_W) | 0;
    s[b + GD_PX] = x * SU; s[b + GD_PY] = y * SU; s[b + GD_TX] = x; s[b + GD_TY] = y;
    s[b + GD_MOV] = -1; s[b + GD_FACE] = G.face; s[b + GD_MODE] = GM_PATROL;
    s[b + GD_IDX] = G.startIdx; s[b + GD_TIMER] = G.startWait; s[b + GD_TGT] = -1; s[b + GD_SEES] = -1;
  }
  for (let k = 0; k < lay.nCM; k++) {
    const C = L.cameras[k], b = lay.CM + k * CM_SIZE;
    s[b + CM_ANG] = C.a0; s[b + CM_DIR] = 1; s[b + CM_TIMER] = C.pause; s[b + CM_ON] = 1;
  }
  for (let d = 0; d < lay.nDR; d++) s[lay.DR + d] = L.doors[d].inv;   // channels start inactive
  for (let k = 0; k < lay.nCS; k++) s[lay.CS + k] = 1;
  for (let p = 0; p < lay.nPF; p++) {
    const P = L.platforms[p], b = lay.PF + p * PF_SIZE, c = P.path[0];
    s[b + PF_IDX] = 0; s[b + PF_DIR] = 1; s[b + PF_MODE] = PF_DWELL; s[b + PF_TIMER] = P.dwell;
    s[b + PF_PX] = (c % GRID_W) * SU; s[b + PF_PY] = ((c / GRID_W) | 0) * SU;
  }
  return { ctx, s, canon, recordEvents, events: [] };
}

/** Clone a world (cheap: one typed-array copy). Events are not cloned. */
export function cloneWorld(w) {
  return { ctx: w.ctx, s: w.s.slice(), canon: w.canon, recordEvents: false, events: [] };
}

/** Deterministic 32-bit hash of the full state. */
export function hashWorld(w) { return fnv1a(w.s); }

/** 53-bit key of a raw state array (solver duplicate detection). */
export function key53Of(s) { return key53(s); }

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const centerCoord = (p) => ((p + HALF_SU) / SU) | 0;
const mixAct = (act, code) => hash32((act ^ Math.imul(code, 0x9e3779b1)) >>> 0) | 0;

/** Runner signature for paradox detection (position, loot, coins, alive, interaction hash). */
export function runnerSig(s, b) {
  const packed = (s[b + R_PX] | (s[b + R_PY] << 10) | (s[b + R_CARRY] << 20) |
    (s[b + R_COINS] << 21) | (s[b + R_ALIVE] << 23)) >>> 0;
  return hash32((packed ^ Math.imul(s[b + R_ACT], 0x85ebca6b)) >>> 0);
}

export function sigOf(w, i) { return runnerSig(w.s, w.ctx.lay.R + i * R_SIZE); }

/** Direction from an input mask, fixed priority U > D > L > R, or -1. */
export function maskDir(m) {
  if (m & IN_U) return DIR_U;
  if (m & IN_D) return DIR_D;
  if (m & IN_L) return DIR_L;
  if (m & IN_R) return DIR_R;
  return -1;
}

function emit(w, type, a, b) {
  if (w.recordEvents) w.events.push(type, a, b);
}

/** Opaque for sight, lasers and thrown coins. */
function opaque(L, s, lay, c) {
  const t = L.tile[c];
  if (t === T_WALL) return true;
  if (t === T_DOOR) return s[lay.DR + L.doorAt[c]] === 0;
  if (t === T_VAULT) return s[G_VAULT_OPEN] === 0;
  return false;
}

function guardPassable(L, s, lay, c) {
  const t = L.tile[c];
  if (t === T_FLOOR) return true;
  if (t === T_DOOR) return s[lay.DR + L.doorAt[c]] === 1;
  return false;
}

function platformPowered(P, ch) {
  if (P.ch < 0) return true;
  return (((ch >> P.ch) & 1) ^ P.inv) === 1;
}

/** Can a runner start moving into cell c? */
function runnerCanEnter(L, s, lay, c) {
  const t = L.tile[c];
  if (t === T_FLOOR) return true;
  if (t === T_WALL) return false;
  if (t === T_DOOR) return s[lay.DR + L.doorAt[c]] === 1;
  if (t === T_VAULT) return s[G_VAULT_OPEN] === 1;
  // Chasm: only onto a waiting platform that will still wait long enough.
  const p = L.platformAt[c];
  if (p < 0) return false;
  const b = lay.PF + p * PF_SIZE, P = L.platforms[p];
  if (P.path[s[b + PF_IDX]] !== c || s[b + PF_MODE] !== PF_DWELL) return false;
  if (!platformPowered(P, s[G_CHANNELS])) return true;
  return s[b + PF_TIMER] >= MOVE_TICKS;
}

function platformCarries(L, s, lay, c) {
  const p = L.platformAt[c];
  if (p < 0) return false;
  return L.platforms[p].path[s[lay.PF + p * PF_SIZE + PF_IDX]] === c;
}

/** Is any runner or guard occupying cell c (reserved target or center)? */
function occupied(L, s, lay, c) {
  const n = s[G_NRUN];
  for (let i = 0; i < n; i++) {
    const b = lay.R + i * R_SIZE;
    if (!s[b + R_ALIVE]) continue;
    if (s[b + R_TY] * GRID_W + s[b + R_TX] === c) return true;
    if (centerCoord(s[b + R_PY]) * GRID_W + centerCoord(s[b + R_PX]) === c) return true;
  }
  for (let g = 0; g < lay.nGD; g++) {
    const b = lay.GD + g * GD_SIZE;
    if (s[b + GD_TY] * GRID_W + s[b + GD_TX] === c) return true;
    if (centerCoord(s[b + GD_PY]) * GRID_W + centerCoord(s[b + GD_PX]) === c) return true;
  }
  return false;
}

/** BFS distances (in tiles) from `src` over guard-passable cells into ctx.dist (-1 = unreachable). */
function bfsGuard(ctx, s, src) {
  const { L, lay, dist, queue } = ctx;
  dist.fill(-1);
  let qh = 0, qt = 0;
  dist[src] = 0; queue[qt++] = src;
  while (qh < qt) {
    const c = queue[qh++];
    const x = c % GRID_W, d = dist[c] + 1;
    // Up, down, left, right — fixed order.
    if (c >= GRID_W) { const n = c - GRID_W; if (dist[n] < 0 && guardPassable(L, s, lay, n)) { dist[n] = d; queue[qt++] = n; } }
    if (c + GRID_W < CELLS) { const n = c + GRID_W; if (dist[n] < 0 && guardPassable(L, s, lay, n)) { dist[n] = d; queue[qt++] = n; } }
    if (x > 0) { const n = c - 1; if (dist[n] < 0 && guardPassable(L, s, lay, n)) { dist[n] = d; queue[qt++] = n; } }
    if (x < GRID_W - 1) { const n = c + 1; if (dist[n] < 0 && guardPassable(L, s, lay, n)) { dist[n] = d; queue[qt++] = n; } }
  }
}

/** Line of sight between two SU points, ignoring `skip` cell. */
function lineOfSight(L, s, lay, x0, y0, x1, y1, skip) {
  const dx = x1 - x0, dy = y1 - y0;
  const adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
  const n = (((adx > ady ? adx : ady) + LOS_STEP_SU - 1) / LOS_STEP_SU) | 0;
  for (let k = 1; k < n; k++) {
    const px = x0 + Math.trunc((dx * k) / n);
    const py = y0 + Math.trunc((dy * k) / n);
    const c = ((py / SU) | 0) * GRID_W + ((px / SU) | 0);
    if (c !== skip && opaque(L, s, lay, c)) return false;
  }
  return true;
}

/** Fail a runner (caught / fell). */
function failRunner(w, b, i, reason) {
  const s = w.s;
  if (!s[b + R_ALIVE]) return;
  s[b + R_ALIVE] = 0;
  s[b + R_FAIL] = reason;
  emit(w, EV_CAUGHT, i, reason);
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/**
 * Advance the world by exactly one tick.
 * @param w      world from createWorld()
 * @param inputs array-like of 5-bit masks, one per runner (index = runner)
 */
export function step(w, inputs) {
  const s = w.s;
  if (s[G_STATUS] !== ST_RUNNING) return;
  const ctx = w.ctx, L = ctx.L, lay = ctx.lay;
  if (w.recordEvents) w.events.length = 0;
  const tick = s[G_TICK];
  const nRun = s[G_NRUN];
  const R0 = lay.R;

  // --- 1. Plates & channels ------------------------------------------------
  let pressed = 0;
  for (let i = 0; i < nRun; i++) {
    const b = R0 + i * R_SIZE;
    if (!s[b + R_ALIVE]) continue;
    const c = centerCoord(s[b + R_PY]) * GRID_W + centerCoord(s[b + R_PX]);
    if (L.obj[c] === O_PLATE) pressed |= 1 << L.objIdx[c];
  }
  const prevPressed = s[G_PLATES];
  if (pressed !== prevPressed && w.recordEvents) {
    for (let p = 0; p < L.plates.length; p++) {
      const was = (prevPressed >> p) & 1, now = (pressed >> p) & 1;
      if (now && !was) emit(w, EV_PLATE_ON, p, 0);
      else if (was && !now) emit(w, EV_PLATE_OFF, p, 0);
    }
  }
  s[G_PLATES] = pressed;
  let ch = 0;
  for (let p = 0; p < L.plates.length; p++) if ((pressed >> p) & 1) ch |= 1 << L.plates[p].ch;
  for (let k = 0; k < lay.nSW; k++) if (s[lay.SW + k]) ch |= 1 << L.switches[k].ch;
  s[G_CHANNELS] = ch;

  // --- 2. Doors ------------------------------------------------------------
  for (let d = 0; d < lay.nDR; d++) {
    const D = L.doors[d];
    const want = ((ch >> D.ch) & 1) ^ D.inv;
    const cur = s[lay.DR + d];
    if (want && !cur) { s[lay.DR + d] = 1; emit(w, EV_DOOR_OPEN, d, 0); }
    else if (!want && cur && !occupied(L, s, lay, D.c)) { s[lay.DR + d] = 0; emit(w, EV_DOOR_CLOSE, d, 0); }
  }

  // --- 3. Platforms --------------------------------------------------------
  for (let p = 0; p < lay.nPF; p++) {
    const P = L.platforms[p], b = lay.PF + p * PF_SIZE;
    if (s[b + PF_MODE] === PF_DWELL && platformPowered(P, ch)) {
      if (s[b + PF_TIMER] > 0) s[b + PF_TIMER]--;
      else {
        let nidx = s[b + PF_IDX] + s[b + PF_DIR];
        if (nidx < 0 || nidx >= P.path.length) { s[b + PF_DIR] = -s[b + PF_DIR]; nidx = s[b + PF_IDX] + s[b + PF_DIR]; }
        const from = P.path[s[b + PF_IDX]], to = P.path[nidx];
        // Capture idle riders standing on the platform.
        for (let i = 0; i < nRun; i++) {
          const rb = R0 + i * R_SIZE;
          if (!s[rb + R_ALIVE] || s[rb + R_MOV] !== -1 || s[rb + R_RIDE] !== -1) continue;
          if (s[rb + R_TY] * GRID_W + s[rb + R_TX] !== from) continue;
          s[rb + R_RIDE] = p;
          s[rb + R_TX] = to % GRID_W; s[rb + R_TY] = (to / GRID_W) | 0;
        }
        s[b + PF_IDX] = nidx;
        s[b + PF_MODE] = PF_SLIDE;
        emit(w, EV_PLATFORM_GO, p, 0);
      }
    }
    if (s[b + PF_MODE] === PF_SLIDE) {
      const to = P.path[s[b + PF_IDX]];
      const tx = (to % GRID_W) * SU, ty = ((to / GRID_W) | 0) * SU;
      let px = s[b + PF_PX], py = s[b + PF_PY];
      px += px < tx ? PLATFORM_SPEED : px > tx ? -PLATFORM_SPEED : 0;
      py += py < ty ? PLATFORM_SPEED : py > ty ? -PLATFORM_SPEED : 0;
      s[b + PF_PX] = px; s[b + PF_PY] = py;
      const arrived = px === tx && py === ty;
      for (let i = 0; i < nRun; i++) {
        const rb = R0 + i * R_SIZE;
        if (s[rb + R_RIDE] !== p) continue;
        s[rb + R_PX] = px; s[rb + R_PY] = py;
        if (arrived) s[rb + R_RIDE] = -1;
      }
      if (arrived) {
        s[b + PF_MODE] = PF_DWELL;
        const idx = s[b + PF_IDX];
        s[b + PF_TIMER] = (idx === 0 || idx === P.path.length - 1) ? P.dwell : 0;
      }
    }
  }

  // --- 4. Runners ----------------------------------------------------------
  let winner = -1;
  let heldTerms = 0;
  for (let i = 0; i < nRun; i++) {
    const b = R0 + i * R_SIZE;
    if (!s[b + R_ALIVE]) continue;
    const m = inputs[i] & 31;
    const a = (m & IN_A) ? 1 : 0;
    const edge = a && !s[b + R_PREVA];
    s[b + R_PREVA] = a;
    s[b + R_HOLD] = 0;
    if (s[b + R_RIDE] >= 0) continue;          // riding: no control

    const idle = s[b + R_MOV] === -1;
    let acted = false;
    if (idle) {
      const cell = s[b + R_TY] * GRID_W + s[b + R_TX];
      const o = L.obj[cell];
      if (o === O_TERMINAL && a) {
        heldTerms |= 1 << L.objIdx[cell];
        s[b + R_HOLD] = 1;
        acted = true;
      } else if (edge && o === O_SWITCH) {
        const k = L.objIdx[cell];
        const v = s[lay.SW + k] ^ 1;
        s[lay.SW + k] = v;
        s[b + R_ACT] = mixAct(s[b + R_ACT], 1000 + k * 2 + v);
        emit(w, EV_SWITCH, k, v);
        acted = true;
      } else if (edge && o !== O_TERMINAL && s[b + R_COINS] > 0) {
        let d = maskDir(m);
        if (d < 0) d = s[b + R_FACE];
        s[b + R_FACE] = d;
        // Find a free coin slot.
        let slot = -1;
        for (let k = 0; k < COIN_SLOTS; k++) if (s[lay.TC + k * TC_SIZE + TC_STATE] === 0) { slot = k; break; }
        if (slot >= 0) {
          let land = cell;
          for (let k = 0; k < COIN_THROW_TILES; k++) {
            const nx = (land % GRID_W) + DX4[d], ny = ((land / GRID_W) | 0) + DY4[d];
            const nc = ny * GRID_W + nx;
            if (opaque(L, s, lay, nc)) break;
            land = nc;
          }
          const tb = lay.TC + slot * TC_SIZE;
          s[tb + TC_STATE] = 1; s[tb + TC_SX] = s[b + R_PX] + HALF_SU; s[tb + TC_SY] = s[b + R_PY] + HALF_SU;
          s[tb + TC_EC] = land; s[tb + TC_T] = COIN_FLIGHT_TICKS; s[tb + TC_OWNER] = i;
          s[b + R_COINS]--;
          s[b + R_ACT] = mixAct(s[b + R_ACT], 2000 + land);
          emit(w, EV_COIN_THROW, i, land);
          acted = true;
        }
      }
      if (!acted) {
        const d = maskDir(m);
        if (d >= 0) {
          s[b + R_FACE] = d;
          const nx = s[b + R_TX] + DX4[d], ny = s[b + R_TY] + DY4[d];
          const nc = ny * GRID_W + nx;
          if (runnerCanEnter(L, s, lay, nc)) {
            s[b + R_TX] = nx; s[b + R_TY] = ny; s[b + R_MOV] = d;
            emit(w, EV_STEP, i, nc);
          } else if (w.recordEvents && (tick & 15) === 0) {
            emit(w, EV_BUMP, i, nc);       // bumping only changes facing
          }
        }
      }
    }
    const mv = s[b + R_MOV];
    if (mv !== -1) {
      s[b + R_PX] += RUNNER_SPEED * DX4[mv];
      s[b + R_PY] += RUNNER_SPEED * DY4[mv];
      if (s[b + R_PX] === s[b + R_TX] * SU && s[b + R_PY] === s[b + R_TY] * SU) s[b + R_MOV] = -1;
    }
    // Pickups and exit at the center tile.
    const cc = centerCoord(s[b + R_PY]) * GRID_W + centerCoord(s[b + R_PX]);
    const oc = L.obj[cc];
    if (oc === O_COIN) {
      const k = L.objIdx[cc];
      if (s[lay.CS + k] === 1 && s[b + R_COINS] < MAX_COINS_CARRIED) {
        s[lay.CS + k] = 0;
        s[b + R_COINS]++;
        s[b + R_ACT] = mixAct(s[b + R_ACT], 3000 + k);
        emit(w, EV_COIN_PICK, i, k);
      }
    } else if (oc === O_LOOT) {
      if (s[G_LOOT] === -1 && !s[b + R_CARRY]) {
        s[G_LOOT] = i; s[b + R_CARRY] = 1;
        emit(w, EV_LOOT_PICK, i, 0);
      }
    } else if (oc === O_EXIT && s[b + R_CARRY] && winner < 0) {
      winner = i;
    }
  }

  // --- 5. Duo vault ---------------------------------------------------------
  s[G_TERMS] = heldTerms;
  if (L.terminals.length === 2 && !s[G_VAULT_OPEN]) {
    if (heldTerms === 3) {
      s[G_VAULT_PROG]++;
      if (s[G_VAULT_PROG] >= VAULT_HOLD_TICKS) { s[G_VAULT_OPEN] = 1; emit(w, EV_VAULT_OPEN, 0, 0); }
    } else s[G_VAULT_PROG] = 0;
  }

  // --- 6. Guards ------------------------------------------------------------
  for (let g = 0; g < lay.nGD; g++) {
    const G = L.guards[g], b = lay.GD + g * GD_SIZE;
    if (s[b + GD_MOV] === -1) {
      const cell = s[b + GD_TY] * GRID_W + s[b + GD_TX];
      const mode = s[b + GD_MODE];
      let next = -1;
      if (mode === GM_PATROL) {
        if (s[b + GD_TIMER] > 0) s[b + GD_TIMER]--;
        else if (G.route.length > 1) {
          const ni = (s[b + GD_IDX] + 1) % G.route.length;
          const nc = G.route[ni];
          if (guardPassable(L, s, lay, nc)) { s[b + GD_IDX] = ni; next = nc; }
        }
      } else if (mode === GM_INVESTIGATE || mode === GM_RETURN) {
        const tgt = mode === GM_INVESTIGATE ? s[b + GD_TGT] : G.route[s[b + GD_IDX]];
        if (cell === tgt) {
          if (mode === GM_INVESTIGATE) {
            s[b + GD_MODE] = GM_LOOK; s[b + GD_TIMER] = GUARD_LOOK_TICKS;
            // Pick up the landed coin if it is here.
            for (let k = 0; k < COIN_SLOTS; k++) {
              const tb = lay.TC + k * TC_SIZE;
              if (s[tb + TC_STATE] === 2 && s[tb + TC_EC] === cell) s[tb + TC_STATE] = 0;
            }
          } else {
            s[b + GD_MODE] = GM_PATROL; s[b + GD_TIMER] = 0;
          }
        } else {
          bfsGuard(ctx, s, tgt);
          const dist = ctx.dist, dc = dist[cell];
          if (dc > 0) {
            const x = cell % GRID_W, want = dc - 1;
            if (cell >= GRID_W && dist[cell - GRID_W] === want) next = cell - GRID_W;
            else if (cell + GRID_W < CELLS && dist[cell + GRID_W] === want) next = cell + GRID_W;
            else if (x > 0 && dist[cell - 1] === want) next = cell - 1;
            else if (x < GRID_W - 1 && dist[cell + 1] === want) next = cell + 1;
          } else if (mode === GM_INVESTIGATE) {
            s[b + GD_MODE] = GM_RETURN;     // unreachable noise → give up
          }
        }
      } else if (mode === GM_LOOK) {
        s[b + GD_TIMER]--;
        if (s[b + GD_TIMER] % GUARD_LOOK_TURN === 0) {
          // Rotate clockwise: up → right → down → left.
          const f = s[b + GD_FACE];
          s[b + GD_FACE] = f === DIR_U ? DIR_R : f === DIR_R ? DIR_D : f === DIR_D ? DIR_L : DIR_U;
        }
        if (s[b + GD_TIMER] <= 0) s[b + GD_MODE] = GM_RETURN;
      }
      if (next >= 0) {
        const nx = next % GRID_W, ny = (next / GRID_W) | 0;
        const dx = nx - s[b + GD_TX], dy = ny - s[b + GD_TY];
        const d = dy < 0 ? DIR_U : dy > 0 ? DIR_D : dx < 0 ? DIR_L : DIR_R;
        s[b + GD_TX] = nx; s[b + GD_TY] = ny; s[b + GD_MOV] = d; s[b + GD_FACE] = d;
      }
    }
    const gm = s[b + GD_MOV];
    if (gm !== -1) {
      s[b + GD_PX] += GUARD_SPEED * DX4[gm];
      s[b + GD_PY] += GUARD_SPEED * DY4[gm];
      if (s[b + GD_PX] === s[b + GD_TX] * SU && s[b + GD_PY] === s[b + GD_TY] * SU) {
        s[b + GD_MOV] = -1;
        if (s[b + GD_MODE] === GM_PATROL) {
          const idx = s[b + GD_IDX];
          s[b + GD_TIMER] = G.waits[idx];
          if (G.looks[idx] >= 0) s[b + GD_FACE] = G.looks[idx];
        }
      }
    }
  }

  // --- 7. Cameras -----------------------------------------------------------
  for (let k = 0; k < lay.nCM; k++) {
    const C = L.cameras[k], b = lay.CM + k * CM_SIZE;
    const on = C.ch < 0 ? 1 : 1 - ((((ch >> C.ch) & 1) ^ C.inv));
    s[b + CM_ON] = on;
    if (!on) continue;
    if (s[b + CM_TIMER] > 0) { s[b + CM_TIMER]--; continue; }
    if (++s[b + CM_SUB] >= C.speed) {
      s[b + CM_SUB] = 0;
      let a = s[b + CM_ANG] + s[b + CM_DIR];
      if (a >= C.a1) { a = C.a1; s[b + CM_DIR] = -1; s[b + CM_TIMER] = C.pause; }
      else if (a <= C.a0) { a = C.a0; s[b + CM_DIR] = 1; s[b + CM_TIMER] = C.pause; }
      s[b + CM_ANG] = a;
    }
  }

  // --- 8. Thrown coins & noise ---------------------------------------------
  for (let k = 0; k < COIN_SLOTS; k++) {
    const tb = lay.TC + k * TC_SIZE;
    const st = s[tb + TC_STATE];
    if (st === 1) {
      if (--s[tb + TC_T] <= 0) {
        s[tb + TC_STATE] = 2; s[tb + TC_T] = COIN_LANDED_TICKS;
        const land = s[tb + TC_EC];
        emit(w, EV_COIN_LAND, land, s[tb + TC_OWNER]);
        if (guardPassable(L, s, lay, land) && lay.nGD > 0) {
          bfsGuard(ctx, s, land);
          for (let g = 0; g < lay.nGD; g++) {
            const gb = lay.GD + g * GD_SIZE;
            const gc = s[gb + GD_TY] * GRID_W + s[gb + GD_TX];
            const d = ctx.dist[gc];
            if (d >= 0 && d <= NOISE_RADIUS) {
              s[gb + GD_MODE] = GM_INVESTIGATE; s[gb + GD_TGT] = land; s[gb + GD_TIMER] = 0;
              emit(w, EV_GUARD_HEAR, g, land);
            }
          }
        }
      }
    } else if (st === 2) {
      if (--s[tb + TC_T] <= 0) s[tb + TC_STATE] = 0;
    }
  }

  // --- 9. Detection ---------------------------------------------------------
  // Lasers: compute state and beam cells.
  const beam = ctx.beam;
  let anyBeam = false;
  for (let k = 0; k < lay.nLZ; k++) {
    const Z = L.lasers[k];
    let on = 1;
    if (Z.off > 0) {
      const per = Z.on + Z.off;
      const t = (((tick + Z.ph) % per) + per) % per;
      on = t < Z.on ? 1 : 0;
    }
    if (Z.ch >= 0 && ((((ch >> Z.ch) & 1) ^ Z.inv) === 1)) on = 0;
    if (on && !s[lay.LZ + k]) emit(w, EV_LASER_ON, k, 0);
    s[lay.LZ + k] = on;
    if (on) {
      if (!anyBeam) { beam.fill(0); anyBeam = true; }
      let x = Z.x + DX4[Z.dir], y = Z.y + DY4[Z.dir];
      while (x > 0 && y > 0 && x < GRID_W - 1 && y < GRID_H - 1) {
        const c = y * GRID_W + x;
        if (opaque(L, s, lay, c)) break;
        beam[c] = 1;
        x += DX4[Z.dir]; y += DY4[Z.dir];
      }
    }
  }
  for (let g = 0; g < lay.nGD; g++) { s[lay.GD + g * GD_SIZE + GD_ALERT] = 0; s[lay.GD + g * GD_SIZE + GD_SEES] = -1; }
  for (let k = 0; k < lay.nCM; k++) s[lay.CM + k * CM_SIZE + CM_ALERT] = 0;

  for (let i = 0; i < nRun; i++) {
    const b = R0 + i * R_SIZE;
    if (!s[b + R_ALIVE]) continue;
    const rx = s[b + R_PX] + HALF_SU, ry = s[b + R_PY] + HALF_SU;
    const rc = ((ry / SU) | 0) * GRID_W + ((rx / SU) | 0);
    if (anyBeam && beam[rc]) { failRunner(w, b, i, FAIL_LASER); continue; }
    let seenBy = -1, seenKind = 0;
    for (let g = 0; g < lay.nGD; g++) {
      const gb = lay.GD + g * GD_SIZE;
      const gx = s[gb + GD_PX] + HALF_SU, gy = s[gb + GD_PY] + HALF_SU;
      const vx = rx - gx, vy = ry - gy;
      const d2 = vx * vx + vy * vy;
      if (d2 > GUARD_RANGE_SU * GUARD_RANGE_SU) continue;
      if (d2 !== 0) {
        const f = s[gb + GD_FACE];
        const dot = vx * DX4[f] + vy * DY4[f];
        if (dot <= 0 || dot * dot * 1000 < d2 * GUARD_COS2_K) continue;
        if (!lineOfSight(L, s, lay, gx, gy, rx, ry, -1)) continue;
      }
      seenBy = g; seenKind = FAIL_GUARD;
      s[gb + GD_SEES] = i;
      break;
    }
    if (seenBy < 0) {
      for (let k = 0; k < lay.nCM; k++) {
        const C = L.cameras[k], cb = lay.CM + k * CM_SIZE;
        if (!s[cb + CM_ON]) continue;
        const cx = C.x * SU + HALF_SU, cy = C.y * SU + HALF_SU;
        const vx = rx - cx, vy = ry - cy;
        const d2 = vx * vx + vy * vy;
        if (d2 > CAMERA_RANGE_SU * CAMERA_RANGE_SU || d2 === 0) continue;
        const ai = ((s[cb + CM_ANG] % DIR_COUNT) + DIR_COUNT) % DIR_COUNT;
        const dot = vx * DIR_X[ai] + vy * DIR_Y[ai];   // exact in doubles (< 2^53)
        if (dot <= 0 || dot * dot * 1000 < d2 * CAMERA_COS2_K * DIR_SCALE * DIR_SCALE) continue;
        if (!lineOfSight(L, s, lay, cx, cy, rx, ry, C.c)) continue;
        seenBy = 100 + k; seenKind = FAIL_CAMERA;
        break;
      }
    }
    s[b + R_SEEN] = seenBy;
    if (seenBy >= 0) {
      if (s[b + R_SUSP] === 0) emit(w, EV_SPOTTED, i, seenBy);
      s[b + R_SUSP]++;
      if (seenBy < 100) {
        const gb = lay.GD + seenBy * GD_SIZE;
        if (s[b + R_SUSP] > s[gb + GD_ALERT]) s[gb + GD_ALERT] = s[b + R_SUSP];
      } else {
        const cb = lay.CM + (seenBy - 100) * CM_SIZE;
        if (s[b + R_SUSP] > s[cb + CM_ALERT]) s[cb + CM_ALERT] = s[b + R_SUSP];
      }
      if (s[b + R_SUSP] >= ALARM_TICKS) failRunner(w, b, i, seenKind);
    } else {
      const v = s[b + R_SUSP] - SUSP_DECAY;
      s[b + R_SUSP] = v > 0 ? v : 0;
    }
  }

  // --- 10. Falling ------------------------------------------------------------
  for (let i = 0; i < nRun; i++) {
    const b = R0 + i * R_SIZE;
    if (!s[b + R_ALIVE] || s[b + R_MOV] !== -1 || s[b + R_RIDE] !== -1) continue;
    const c = s[b + R_TY] * GRID_W + s[b + R_TX];
    if (L.tile[c] === T_CHASM && !platformCarries(L, s, lay, c)) failRunner(w, b, i, FAIL_FELL);
  }

  // --- 11. Paradox check & status ------------------------------------------------
  const live = nRun - 1;
  let paradox = -1;
  for (let j = 0; j < live; j++) {
    const b = R0 + j * R_SIZE;
    if (!s[b + R_ALIVE]) { paradox = j; break; }
    const cj = w.canon[j];
    if (cj && runnerSig(s, b) !== cj[tick]) {
      s[b + R_FAIL] = FAIL_DIVERGED;
      paradox = j; break;
    }
  }
  if (paradox >= 0) {
    s[G_STATUS] = ST_PARADOX; s[G_STATUS_ARG] = paradox;
    s[G_FAIL] = s[R0 + paradox * R_SIZE + R_FAIL];
    emit(w, EV_PARADOX, paradox, s[G_FAIL]);
  } else if (winner >= 0) {
    s[G_STATUS] = ST_WON; s[G_STATUS_ARG] = winner;
    emit(w, EV_WIN, winner, 0);
  } else if (!s[R0 + live * R_SIZE + R_ALIVE]) {
    s[G_STATUS] = ST_CAUGHT; s[G_STATUS_ARG] = live;
    s[G_FAIL] = s[R0 + live * R_SIZE + R_FAIL];
  } else if (tick + 1 >= LOOP_TICKS) {
    s[G_STATUS] = ST_TIMEOUT; s[G_STATUS_ARG] = live;
  }
  s[G_TICK] = tick + 1;
}

// ---------------------------------------------------------------------------
// Read-only queries (used by renderer, solver, UI) — never mutate.
// ---------------------------------------------------------------------------

export const status = (w) => w.s[G_STATUS];
export const tickOf = (w) => w.s[G_TICK];
export function runnerBase(w, i) { return w.ctx.lay.R + i * R_SIZE; }
export function runnerCell(w, i) {
  const b = runnerBase(w, i);
  return w.s[b + R_TY] * GRID_W + w.s[b + R_TX];
}
export function runnerIdle(w, i) {
  const b = runnerBase(w, i);
  return w.s[b + R_MOV] === -1 && w.s[b + R_RIDE] === -1;
}
export function doorOpen(w, d) { return w.s[w.ctx.lay.DR + d] === 1; }
export function laserOn(w, k) { return w.s[w.ctx.lay.LZ + k] === 1; }

/** Cells currently covered by active laser beams (fresh array). */
export function laserBeamCells(w, k) {
  const { L, lay } = w.ctx;
  const Z = L.lasers[k];
  const out = [];
  let x = Z.x + DX4[Z.dir], y = Z.y + DY4[Z.dir];
  while (x > 0 && y > 0 && x < GRID_W - 1 && y < GRID_H - 1) {
    const c = y * GRID_W + x;
    if (opaque(L, w.s, lay, c)) break;
    out.push(c);
    x += DX4[Z.dir]; y += DY4[Z.dir];
  }
  return out;
}

export function isOpaqueCell(w, c) { return opaque(w.ctx.L, w.s, w.ctx.lay, c); }
export function isRunnerEnterable(w, c) { return runnerCanEnter(w.ctx.L, w.s, w.ctx.lay, c); }

export { PF_DWELL, PF_SLIDE };
