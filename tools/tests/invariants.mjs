// MIRRORFALL — structural invariants of the world state (used by fuzzing).

import { GRID_W, GRID_H, SU, LOOP_TICKS, MAX_COINS_CARRIED, T_WALL, VAULT_HOLD_TICKS, COIN_SLOTS } from '../../sim/constants.js';
import {
  G_TICK, G_STATUS, G_LOOT, G_NRUN, G_VAULT_PROG,
  R_SIZE, R_PX, R_PY, R_TX, R_TY, R_MOV, R_FACE, R_CARRY, R_COINS, R_ALIVE, R_SUSP, R_RIDE,
  GD_SIZE, GD_PX, GD_PY, GD_TX, GD_TY, GD_MOV, GD_IDX, GD_MODE, GD_FACE,
  CM_SIZE, CM_ANG, TC_SIZE, TC_STATE, PF_SIZE, PF_IDX,
} from '../../sim/world.js';

/** Returns null if all invariants hold, else a description of the first violation. */
export function checkInvariants(w) {
  const s = w.s, { L, lay } = w.ctx;
  for (let i = 0; i < s.length; i++) {
    if (!Number.isInteger(s[i])) return `state[${i}] not integer`;
  }
  const tick = s[G_TICK];
  if (tick < 0 || tick > LOOP_TICKS) return 'tick out of range ' + tick;
  if (s[G_STATUS] < 0 || s[G_STATUS] > 4) return 'bad status';
  const n = s[G_NRUN];
  let carriers = 0;
  for (let i = 0; i < n; i++) {
    const b = lay.R + i * R_SIZE;
    const px = s[b + R_PX], py = s[b + R_PY], tx = s[b + R_TX], ty = s[b + R_TY];
    if (px < 0 || py < 0 || px > (GRID_W - 1) * SU || py > (GRID_H - 1) * SU) return `runner ${i} pos ${px},${py}`;
    if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return `runner ${i} tile ${tx},${ty}`;
    const mov = s[b + R_MOV];
    if (mov < -1 || mov > 3) return `runner ${i} mov ${mov}`;
    if (s[b + R_FACE] < 0 || s[b + R_FACE] > 3) return `runner ${i} face`;
    if (s[b + R_CARRY] !== 0 && s[b + R_CARRY] !== 1) return `runner ${i} carry`;
    carriers += s[b + R_CARRY];
    if (s[b + R_COINS] < 0 || s[b + R_COINS] > MAX_COINS_CARRIED) return `runner ${i} coins`;
    if (s[b + R_ALIVE] !== 0 && s[b + R_ALIVE] !== 1) return `runner ${i} alive`;
    if (s[b + R_SUSP] < 0 || s[b + R_SUSP] > 64) return `runner ${i} susp ${s[b + R_SUSP]}`;
    const ride = s[b + R_RIDE];
    if (ride < -1 || ride >= lay.nPF) return `runner ${i} ride`;
    if (s[b + R_ALIVE]) {
      if (mov === -1 && ride === -1 && (px !== tx * SU || py !== ty * SU)) return `runner ${i} idle but unaligned`;
      if (mov !== -1) {
        const dx = Math.abs(px - tx * SU), dy = Math.abs(py - ty * SU);
        if ((dx && dy) || dx > SU || dy > SU) return `runner ${i} bad move offset ${dx},${dy}`;
      }
      if (L.tile[ty * GRID_W + tx] === T_WALL) return `runner ${i} inside wall`;
    }
  }
  if (carriers > 1) return 'two loot carriers';
  const loot = s[G_LOOT];
  if (loot < -1 || loot >= n) return 'loot state ' + loot;
  if (loot >= 0 && s[lay.R + loot * R_SIZE + R_CARRY] !== 1) return 'loot owner mismatch';
  for (let g = 0; g < lay.nGD; g++) {
    const b = lay.GD + g * GD_SIZE, G = L.guards[g];
    const tx = s[b + GD_TX], ty = s[b + GD_TY];
    if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return `guard ${g} tile`;
    if (L.tile[ty * GRID_W + tx] === T_WALL) return `guard ${g} inside wall`;
    if (s[b + GD_IDX] < 0 || s[b + GD_IDX] >= G.route.length) return `guard ${g} idx`;
    if (s[b + GD_MODE] < 0 || s[b + GD_MODE] > 3) return `guard ${g} mode`;
    if (s[b + GD_FACE] < 0 || s[b + GD_FACE] > 3) return `guard ${g} face`;
    if (s[b + GD_MOV] === -1 && (s[b + GD_PX] !== tx * SU || s[b + GD_PY] !== ty * SU)) return `guard ${g} unaligned`;
  }
  for (let k = 0; k < lay.nCM; k++) {
    const a = s[lay.CM + k * CM_SIZE + CM_ANG], C = L.cameras[k];
    if (a < C.a0 || a > C.a1) return `camera ${k} angle ${a}`;
  }
  for (let d = 0; d < lay.nDR; d++) if (s[lay.DR + d] !== 0 && s[lay.DR + d] !== 1) return 'door state';
  if (s[G_VAULT_PROG] < 0 || s[G_VAULT_PROG] > VAULT_HOLD_TICKS) return 'vault progress';
  for (let k = 0; k < COIN_SLOTS; k++) {
    const st = s[lay.TC + k * TC_SIZE + TC_STATE];
    if (st < 0 || st > 2) return 'coin slot state';
  }
  for (let p = 0; p < lay.nPF; p++) {
    const idx = s[lay.PF + p * PF_SIZE + PF_IDX];
    if (idx < 0 || idx >= L.platforms[p].path.length) return `platform ${p} idx`;
  }
  return null;
}

/**
 * Wrap a world's state in a Proxy that throws on any write of a value that is
 * not a 32-bit integer (NaN, undefined, fractions, overflow) and on reads of
 * out-of-range indices. Slow — used for a sample of fuzz runs.
 */
export function guardState(w) {
  const t = w.s;
  w.s = new Proxy(t, {
    set(target, key, v) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v > 2147483647 || v < -2147483648) {
          throw new Error(`invalid write state[${key}] = ${v}`);
        }
        if (+key >= target.length) throw new Error(`out-of-range write state[${key}]`);
      }
      target[key] = v;
      return true;
    },
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key) && +key >= target.length) {
        throw new Error(`out-of-range read state[${key}]`);
      }
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return w;
}
