// MIRRORFALL — view model.
// Turns (previous state, current state, interpolation alpha) into a flat,
// renderer-agnostic description of the frame: positions in world pixels,
// smoothed angles/door animations and the list of lights. Both the WebGL2
// renderer and the Canvas2D fallback draw from this, so they always agree.
// Reads the simulation state; never writes it.

import { GRID_W, GRID_H, SU, TILE_PX, DX4, DY4, COIN_FLIGHT_TICKS, ALARM_TICKS, GM_INVESTIGATE, GM_LOOK } from '../sim/constants.js';
import {
  G_TICK, G_LOOT, G_NRUN, G_VAULT_OPEN, G_VAULT_PROG, G_TERMS, G_PLATES, G_STATUS, G_STATUS_ARG,
  R_SIZE, R_PX, R_PY, R_FACE, R_CARRY, R_COINS, R_ALIVE, R_SUSP, R_HOLD, R_MOV, R_RIDE, R_FAIL,
  GD_SIZE, GD_PX, GD_PY, GD_FACE, GD_MODE, GD_ALERT,
  CM_SIZE, CM_ANG, CM_ON, CM_ALERT, TC_SIZE, TC_STATE, TC_SX, TC_SY, TC_EC, TC_T,
  PF_SIZE, PF_PX, PF_PY,
} from '../sim/world.js';
import { DIR_COUNT } from '../sim/dirtable.js';
import { levelAccents } from './palette.js';

export const WORLD_W = GRID_W * TILE_PX;   // 960
export const WORLD_H = GRID_H * TILE_PX;   // 544
const K = TILE_PX / SU;                     // SU → px
const FACE_ANG = [-Math.PI / 2, Math.PI / 2, Math.PI, 0];   // U D L R

const lerp = (a, b, t) => a + (b - a) * t;
function angLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}
function approachAng(cur, target, maxStep) {
  let d = target - cur;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

export class ViewBuilder {
  constructor(level, ctx) {
    this.L = level;
    this.lay = ctx.lay;
    this.accents = levelAccents(level.seed);
    this.doorOpen = new Float32Array(level.doors.length).fill(-1);
    this.vaultOpen = -1;
    this.guardAng = new Float32Array(level.guards.length).fill(NaN);
    this.time = 0;
    this.neon = this.makeNeon();
  }

  /** Static decorative neon lights along walls, placed from the level seed. */
  makeNeon() {
    const L = this.L, out = [];
    let h = (L.seed * 2654435761) >>> 0;
    const rnd = () => { h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return h / 4294967296; };
    const isWall = (x, y) => x < 0 || y < 0 || x >= GRID_W || y >= GRID_H || L.tile[y * GRID_W + x] === 1;
    const cand = [];
    for (let y = 1; y < GRID_H - 1; y++) {
      for (let x = 1; x < GRID_W - 1; x++) {
        if (isWall(x, y)) continue;
        // floor tile touching a wall on exactly one side → wall-mounted strip
        const n = [isWall(x, y - 1), isWall(x, y + 1), isWall(x - 1, y), isWall(x + 1, y)];
        const cnt = n.filter(Boolean).length;
        if (cnt === 1) cand.push({ x, y, side: n.indexOf(true) });
      }
    }
    const want = Math.min(7, Math.max(3, Math.round(cand.length / 40)));
    for (let k = 0; k < want && cand.length; k++) {
      const i = Math.floor(rnd() * cand.length);
      const c = cand.splice(i, 1)[0];
      // keep strips apart
      for (let j = cand.length - 1; j >= 0; j--) if (Math.abs(cand[j].x - c.x) + Math.abs(cand[j].y - c.y) < 6) cand.splice(j, 1);
      const col = this.accents[k % 2];
      const cx = (c.x + 0.5) * TILE_PX + DX4[c.side] * 13, cy = (c.y + 0.5) * TILE_PX + DY4[c.side] * 13;
      const along = c.side < 2 ? [1, 0] : [0, 1];
      out.push({ x: cx, y: cy, ax: along[0] * 12, ay: along[1] * 12, color: col });
    }
    return out;
  }

  /**
   * Build the frame view.
   * @param prev Int32Array previous tick state (or null)
   * @param cur  Int32Array current state
   * @param alpha interpolation factor 0..1
   * @param dt   real seconds since last frame (for smoothing)
   */
  build(prev, cur, alpha, dt, opts = {}) {
    const L = this.L, lay = this.lay;
    const p = prev || cur;
    this.time += dt;
    const v = {
      time: this.time, tick: cur[G_TICK], alpha, status: cur[G_STATUS], statusArg: cur[G_STATUS_ARG],
      runners: [], guards: [], cameras: [], doors: [], lasers: [], plates: [], switches: [], coins: [],
      thrown: [], terminals: [], platforms: [], lights: [], vault: null, loot: null,
      exits: L.exits.map((c) => ({ x: (c % GRID_W + 0.5) * TILE_PX, y: ((c / GRID_W | 0) + 0.5) * TILE_PX })),
      spawn: { x: (L.spawn % GRID_W + 0.5) * TILE_PX, y: ((L.spawn / GRID_W | 0) + 0.5) * TILE_PX },
      neon: this.neon, accents: this.accents, occupancyKey: 0,
    };
    const live = cur[G_NRUN] - 1;
    const ip = (a, b) => {
      // Avoid interpolating across teleports (loop restart, platform capture glitches).
      if (Math.abs(a - b) > SU * 1.5) return b;
      return lerp(a, b, alpha);
    };

    // Runners.
    for (let i = 0; i < cur[G_NRUN]; i++) {
      const b = lay.R + i * R_SIZE;
      const x = (ip(p[b + R_PX], cur[b + R_PX]) + SU / 2) * K;
      const y = (ip(p[b + R_PY], cur[b + R_PY]) + SU / 2) * K;
      v.runners.push({
        i, x, y, face: FACE_ANG[cur[b + R_FACE]], live: i === live, alive: cur[b + R_ALIVE] === 1,
        carry: cur[b + R_CARRY] === 1, coins: cur[b + R_COINS], susp: cur[b + R_SUSP] / ALARM_TICKS,
        hold: cur[b + R_HOLD] === 1, moving: cur[b + R_MOV] !== -1 || cur[b + R_RIDE] !== -1, fail: cur[b + R_FAIL],
      });
    }

    // Guards (facing smoothed quickly so the cone never lags the rules much).
    for (let g = 0; g < L.guards.length; g++) {
      const b = lay.GD + g * GD_SIZE;
      const x = (ip(p[b + GD_PX], cur[b + GD_PX]) + SU / 2) * K;
      const y = (ip(p[b + GD_PY], cur[b + GD_PY]) + SU / 2) * K;
      const target = FACE_ANG[cur[b + GD_FACE]];
      let a = this.guardAng[g];
      a = Number.isNaN(a) || opts.snap ? target : approachAng(a, target, dt * 18);
      this.guardAng[g] = a;
      const alert = Math.min(1, cur[b + GD_ALERT] / ALARM_TICKS);
      const mode = cur[b + GD_MODE];
      v.guards.push({ x, y, ang: a, alert, mode, curious: mode === GM_INVESTIGATE || mode === GM_LOOK });
      const col = [1.0, 0.78 - 0.55 * alert, 0.45 - 0.4 * alert];
      v.lights.push({ type: 1, x, y, r: 6 * TILE_PX + 10, color: col, intensity: 0.62 + alert * 0.6, dx: Math.cos(a), dy: Math.sin(a), cosO: Math.cos(35 * Math.PI / 180), cosI: Math.cos(31 * Math.PI / 180), shadow: 1, cone: 1 + alert });
      v.lights.push({ type: 0, x, y, r: 40, color: [1, 0.8, 0.6], intensity: 0.35, shadow: 0 });
    }

    // Cameras.
    for (let k = 0; k < L.cameras.length; k++) {
      const C = L.cameras[k], b = lay.CM + k * CM_SIZE;
      const ai = lerp(p[b + CM_ANG], cur[b + CM_ANG], alpha);
      const a = (ai / DIR_COUNT) * Math.PI * 2;
      const on = cur[b + CM_ON] === 1, alert = Math.min(1, cur[b + CM_ALERT] / ALARM_TICKS);
      const x = (C.x + 0.5) * TILE_PX, y = (C.y + 0.5) * TILE_PX;
      v.cameras.push({ x, y, ang: a, on, alert });
      if (on) {
        v.lights.push({ type: 1, x: x + Math.cos(a) * 22, y: y + Math.sin(a) * 22, r: 7 * TILE_PX - 6, color: [1, 0.3 + 0.2 * (1 - alert), 0.22], intensity: 0.75 + alert * 0.6, dx: Math.cos(a), dy: Math.sin(a), cosO: Math.cos(25 * Math.PI / 180), cosI: Math.cos(21 * Math.PI / 180), shadow: 1, cone: 1 + alert });
      }
    }

    // Doors (smoothed open amount).
    let occ = 0;
    for (let d = 0; d < L.doors.length; d++) {
      const D = L.doors[d];
      const open = cur[lay.DR + d] === 1 ? 1 : 0;
      occ = (Math.imul(occ, 31) + open) | 0;
      let o = this.doorOpen[d];
      o = o < 0 || opts.snap ? open : o + Math.sign(open - o) * Math.min(Math.abs(open - o), dt * 7);
      this.doorOpen[d] = o;
      const horiz = isWallAt(L, D.x - 1, D.y) && isWallAt(L, D.x + 1, D.y);
      v.doors.push({ x: (D.x + 0.5) * TILE_PX, y: (D.y + 0.5) * TILE_PX, open: o, logicOpen: open, ch: D.ch, inv: D.inv, horiz });
    }
    v.occupancyKey = (occ * 7 + cur[G_VAULT_OPEN]) | 0;

    // Lasers.
    for (let k = 0; k < L.lasers.length; k++) {
      const Z = L.lasers[k];
      const on = cur[lay.LZ + k] === 1;
      let x = Z.x + DX4[Z.dir], y = Z.y + DY4[Z.dir], n = 0;
      while (x > 0 && y > 0 && x < GRID_W - 1 && y < GRID_H - 1) {
        const c = y * GRID_W + x, t = L.tile[c];
        if (t === 1) break;
        if (t === 3 && cur[lay.DR + L.doorAt[c]] === 0) break;
        if (t === 4 && cur[G_VAULT_OPEN] === 0) break;
        n++; x += DX4[Z.dir]; y += DY4[Z.dir];
      }
      const ex = (Z.x + 0.5) * TILE_PX + DX4[Z.dir] * 14, ey = (Z.y + 0.5) * TILE_PX + DY4[Z.dir] * 14;
      const x1 = (Z.x + 0.5 + DX4[Z.dir] * (n + 0.5)) * TILE_PX, y1 = (Z.y + 0.5 + DY4[Z.dir] * (n + 0.5)) * TILE_PX;
      // Warm-up hint: beam flickers faintly shortly before it switches on.
      let warn = 0;
      if (!on && Z.off > 0) {
        const per = Z.on + Z.off, t = (((cur[G_TICK] + Z.ph) % per) + per) % per;
        const toOn = per - t;
        if (toOn < 30) warn = 1 - toOn / 30;
      }
      v.lasers.push({ ex, ey, x0: ex, y0: ey, x1, y1, on, warn, ch: Z.ch, dir: Z.dir, n });
      if (on) v.lights.push({ type: 2, x: ex, y: ey, x2: x1, y2: y1, r: 46, color: [1, 0.12, 0.35], intensity: 1.1, shadow: 0 });
    }

    // Plates, switches, coins, terminals.
    const pressed = cur[G_PLATES];
    L.plates.forEach((P, i) => v.plates.push({ x: (P.x + 0.5) * TILE_PX, y: (P.y + 0.5) * TILE_PX, ch: P.ch, pressed: ((pressed >> i) & 1) === 1 }));
    L.switches.forEach((S, i) => v.switches.push({ x: (S.x + 0.5) * TILE_PX, y: (S.y + 0.5) * TILE_PX, ch: S.ch, on: cur[lay.SW + i] === 1 }));
    L.coins.forEach((C, i) => { if (cur[lay.CS + i] === 1) v.coins.push({ x: (C.x + 0.5) * TILE_PX, y: (C.y + 0.5) * TILE_PX }); });
    const terms = cur[G_TERMS];
    L.terminals.forEach((T, i) => {
      const x = (T.x + 0.5) * TILE_PX, y = (T.y + 0.5) * TILE_PX, held = ((terms >> i) & 1) === 1;
      v.terminals.push({ x, y, held });
      v.lights.push({ type: 0, x, y, r: 70, color: held ? [0.4, 1, 0.9] : [0.3, 0.6, 1], intensity: held ? 0.9 : 0.4, shadow: 0 });
    });
    if (L.vaultCells.length) {
      const open = cur[G_VAULT_OPEN] === 1 ? 1 : 0;
      let o = this.vaultOpen;
      o = o < 0 || opts.snap ? open : o + Math.sign(open - o) * Math.min(Math.abs(open - o), dt * 2.5);
      this.vaultOpen = o;
      v.vault = {
        cells: L.vaultCells.map((c) => ({ x: (c % GRID_W + 0.5) * TILE_PX, y: ((c / GRID_W | 0) + 0.5) * TILE_PX })),
        open: o, logicOpen: open, prog: cur[G_VAULT_PROG] / 30,
      };
    }

    // Thrown coins (arc).
    for (let k = 0; k < 4; k++) {
      const b = lay.TC + k * TC_SIZE, st = cur[b + TC_STATE];
      if (!st) continue;
      const ec = cur[b + TC_EC];
      const ex = (ec % GRID_W + 0.5) * TILE_PX, ey = ((ec / GRID_W | 0) + 0.5) * TILE_PX;
      if (st === 1) {
        const tt = (COIN_FLIGHT_TICKS - cur[b + TC_T] + alpha) / COIN_FLIGHT_TICKS;
        const sx = cur[b + TC_SX] * K, sy = cur[b + TC_SY] * K;
        v.thrown.push({ x: lerp(sx, ex, tt), y: lerp(sy, ey, tt), h: Math.sin(Math.min(1, tt) * Math.PI) * 18, landed: false });
      } else v.thrown.push({ x: ex, y: ey, h: 0, landed: true, life: cur[b + TC_T] / 180 });
    }

    // Platforms.
    for (let q = 0; q < L.platforms.length; q++) {
      const b = lay.PF + q * PF_SIZE;
      v.platforms.push({ x: (ip(p[b + PF_PX], cur[b + PF_PX]) + SU / 2) * K, y: (ip(p[b + PF_PY], cur[b + PF_PY]) + SU / 2) * K });
    }

    // Loot.
    const lo = cur[G_LOOT];
    if (lo === -1) {
      const x = (L.loot % GRID_W + 0.5) * TILE_PX, y = ((L.loot / GRID_W | 0) + 0.5) * TILE_PX;
      v.loot = { x, y, carriedBy: -1 };
      v.lights.push({ type: 0, x, y, r: 95, color: [1, 0.8, 0.3], intensity: 0.9 + 0.2 * Math.sin(this.time * 3), shadow: 1 });
    } else if (lo >= 0 && v.runners[lo]) {
      const r = v.runners[lo];
      v.loot = { x: r.x, y: r.y - 14, carriedBy: lo };
      v.lights.push({ type: 0, x: r.x, y: r.y, r: 80, color: [1, 0.8, 0.3], intensity: 0.8, shadow: 1 });
    }

    // Runner glows, exits, neon strips.
    for (const r of v.runners) {
      if (!r.alive) continue;
      v.lights.push({ type: 0, x: r.x, y: r.y, r: r.live ? 120 : 70, color: opts.ghostColors ? opts.ghostColors[r.i] : [0.6, 0.9, 1], intensity: r.live ? 0.75 : 0.4, shadow: r.live ? 1 : 0 });
    }
    for (const e of v.exits) v.lights.push({ type: 0, x: e.x, y: e.y, r: 90, color: [0.25, 1, 0.6], intensity: 0.7, shadow: 1 });
    for (const n of this.neon) v.lights.push({ type: 2, x: n.x - n.ax, y: n.y - n.ay, x2: n.x + n.ax, y2: n.y + n.ay, r: 130, color: n.color, intensity: 0.5, shadow: 1 });
    return v;
  }
}

function isWallAt(L, x, y) {
  if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return true;
  return L.tile[y * GRID_W + x] === 1;
}

/** Occupancy grid for shadows: 1 = blocks light (walls, closed doors, closed vault). */
export function occupancy(L, cur, lay) {
  const occ = new Uint8Array(GRID_W * GRID_H);
  for (let c = 0; c < occ.length; c++) {
    const t = L.tile[c];
    if (t === 1) occ[c] = 1;
    else if (t === 3) occ[c] = cur[lay.DR + L.doorAt[c]] === 1 ? 0 : 1;
    else if (t === 4) occ[c] = cur[G_VAULT_OPEN] === 1 ? 0 : 1;
  }
  return occ;
}

/**
 * Camera: fit the whole world when it is large enough on screen; otherwise
 * zoom to a minimum tile size and follow the focus point (clamped to the
 * world). Returns { scale, offX, offY } in target pixels.
 */
export function cameraFit(W, H, pxPerCss, focus) {
  const fit = Math.min(W / WORLD_W, H / WORLD_H);
  const minScale = (26 * pxPerCss) / TILE_PX;          // ≥ 26 CSS px per tile
  // never zoom further than "world height fills the screen"
  const scale = Math.max(fit, Math.min(minScale, H / WORLD_H));
  const ww = WORLD_W * scale, wh = WORLD_H * scale;
  const fx = focus ? focus.x : WORLD_W / 2, fy = focus ? focus.y : WORLD_H / 2;
  let offX = ww <= W ? (W - ww) / 2 : Math.min(0, Math.max(W - ww, W / 2 - fx * scale));
  let offY = wh <= H ? (H - wh) / 2 : Math.min(0, Math.max(H - wh, H / 2 - fy * scale));
  return { scale, offX, offY };
}
