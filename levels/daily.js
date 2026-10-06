// MIRRORFALL — daily challenge room generator.
//
// Seed from the date → a room built from 3–4 zones connected by "gates":
//   plate   door that is open only while a plate (elsewhere) is held → needs a ghost
//   laser   timed laser across the gate corridor
//   guard   a patrol sweeping the zone behind the gate
//   switch  door opened permanently by a switch
//   vault   (last gate) duo vault with two far-apart terminals → needs a ghost
// Decorative pillars are added only where they keep everything connected.
// Pure: uses only the seeded RNG. Solvability is proven separately by the
// solver bot (tools/solver.js) before the room is offered (see dailyChallenge).

import { Rng, hashString } from '../sim/rng.js';
import { validateLevel } from '../sim/level.js';

const W = 30, H = 17;
const DOOR = 'ABCDEFGH', PLATE = 'abcdefgh', SWITCH = '12345678';

export function dailyKey(date = new Date()) {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
export const dailyRef = (key) => +key.replace(/-/g, '');            // 20261006
export const dailySeed = (key) => hashString('mirrorfall-daily-' + key);

/** Generate one candidate room from a seed. Returns { def, meta } (def may still be unsolvable). */
export function generateRoom(seed) {
  const r = new Rng(seed);
  const g = Array.from({ length: H }, () => Array(W).fill('#'));
  const set = (x, y, c) => { g[y][x] = c; };
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? '#' : g[y][x]);
  const nz = r.range(3, 4);
  // Zone column ranges with 1-tile walls between them.
  const inner = W - 2 - (nz - 1);
  const widths = Array(nz).fill(5);
  for (let left = inner - 5 * nz; left > 0; left--) widths[r.int(nz)]++;
  const zones = [];
  let x = 1;
  for (let i = 0; i < nz; i++) {
    const top = 1 + r.int(4), bottom = H - 2 - r.int(4);
    zones.push({ x0: x, x1: x + widths[i] - 1, y0: top, y1: Math.max(top + 5, bottom) });
    x += widths[i] + 1;
  }
  for (const z of zones) for (let yy = z.y0; yy <= z.y1; yy++) for (let xx = z.x0; xx <= z.x1; xx++) set(xx, yy, '.');

  // Gates between zone i and i+1.
  const types = [];
  for (let i = 0; i < nz - 1; i++) types.push(r.pick(['plate', 'plate', 'laser', 'guard', 'switch', 'plate', 'guard']));
  const useVault = r.chance(45, 100);
  if (!useVault && !types.includes('plate')) types[r.int(types.length)] = 'plate';
  const gates = [];
  for (let i = 0; i < nz - 1; i++) {
    const a = zones[i], b = zones[i + 1];
    const lo = Math.max(a.y0, b.y0) + 1, hi = Math.min(a.y1, b.y1) - 1;
    const gy = lo <= hi ? r.range(lo, hi) : Math.max(a.y0, b.y0);
    const gx = a.x1 + 1;
    set(gx, gy, '.');
    gates.push({ x: gx, y: gy, type: types[i], from: i, to: i + 1 });
  }
  const floorCells = (z, pred = () => true) => {
    const out = [];
    for (let yy = z.y0; yy <= z.y1; yy++) for (let xx = z.x0; xx <= z.x1; xx++) if (at(xx, yy) === '.' && pred(xx, yy)) out.push([xx, yy]);
    return out;
  };
  const nearGate = (xx, yy) => gates.some((q) => Math.abs(q.x - xx) + Math.abs(q.y - yy) <= 2);

  // Spawn, exit, loot.
  const z0 = zones[0], zl = zones[nz - 1];
  const sx = z0.x0 + r.int(Math.min(2, z0.x1 - z0.x0 + 1)), sy = r.range(z0.y0, z0.y1);
  set(sx, sy, 'S');
  const exitCand = floorCells(z0, (xx, yy) => Math.abs(xx - sx) + Math.abs(yy - sy) >= 2 && !nearGate(xx, yy));
  const [ex, ey] = r.pick(exitCand);
  set(ex, ey, 'E');

  const lasers = [], guards = [];
  let ch = 0;
  let lootX, lootY;
  if (useVault) {
    // Vault room carved inside the last zone's far side.
    const vx = zl.x1 - 2, vy = r.range(zl.y0 + 1, zl.y1 - 1);
    for (let yy = zl.y0; yy <= zl.y1; yy++) set(vx, yy, '#');
    set(vx, vy, 'V');
    lootX = zl.x1; lootY = vy;
    const t1 = r.pick(floorCells(zones[0], (xx, yy) => at(xx, yy) === '.' && !nearGate(xx, yy)));
    const others = zones.slice(1).flatMap((z) => floorCells(z, (xx, yy) => xx < vx - 1 && !nearGate(xx, yy)));
    const far = others.filter(([xx, yy]) => Math.abs(xx - t1[0]) + Math.abs(yy - t1[1]) >= 10);
    const t2 = far.length ? r.pick(far) : others.length ? r.pick(others) : [vx - 1, vy];
    set(t1[0], t1[1], 'T'); set(t2[0], t2[1], 'T');
  } else {
    const c = r.pick(floorCells(zl, (xx) => xx >= zl.x1 - 2));
    lootX = c[0]; lootY = c[1];
  }
  set(lootX, lootY, '$');

  for (const gt of gates) {
    const { x: gx, y: gy } = gt;
    if (gt.type === 'plate' || gt.type === 'switch') {
      const c = ch++ % 8;
      set(gx, gy, DOOR[c]);
      const pool = zones.slice(0, gt.from + 1).flatMap((z) => floorCells(z, (xx, yy) => Math.abs(xx - gx) + Math.abs(yy - gy) >= 4 && !nearGate(xx, yy)));
      const [px, py] = r.pick(pool);
      set(px, py, gt.type === 'plate' ? PLATE[c] : SWITCH[c]);
    } else if (gt.type === 'laser') {
      const on = r.pick([40, 48, 56]), off = r.pick([40, 48, 56, 64]);
      lasers.push({ x: gx, y: gy - 1, dir: 'D', on, off, ph: r.int(on + off) });
    } else if (gt.type === 'guard') {
      const z = zones[gt.to];
      const gxp = Math.min(z.x1 - 1, gx + 2 + r.int(2));
      guards.push({ route: [{ x: gxp, y: z.y0, wait: 20 + r.int(40), look: 'D' }, { x: gxp, y: z.y1, wait: 20 + r.int(40), look: 'U' }] });
    }
  }

  // Decorative pillars that keep everything reachable.
  const def = () => ({ id: 'daily', name: 'Tagesrätsel', seed, map: g.map((row) => row.join('')), lasers, guards, cameras: [], platforms: [] });
  const keyCells = [];
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) if (at(xx, yy) !== '#' && at(xx, yy) !== '.') keyCells.push([xx, yy]);
  for (const gd of guards) for (const w of gd.route) keyCells.push([w.x, w.y]);
  const connected = () => {
    const seen = new Set([`${sx},${sy}`]);
    const q = [[sx, sy]];
    while (q.length) {
      const [cx, cy] = q.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy, k = `${nx},${ny}`;
        if (seen.has(k) || at(nx, ny) === '#') continue;
        seen.add(k); q.push([nx, ny]);
      }
    }
    return keyCells.every(([xx, yy]) => seen.has(`${xx},${yy}`));
  };
  const pillars = r.range(3, 7);
  for (let k = 0, tries = 0; k < pillars && tries < 40; tries++) {
    const z = r.pick(zones);
    const [px, py] = r.pick(floorCells(z, (xx, yy) => !nearGate(xx, yy) && xx > z.x0 && xx < z.x1 && yy > z.y0 && yy < z.y1));
    if (at(px, py) !== '.') continue;
    set(px, py, '#');
    const guardOk = guards.every((gd) => !(gd.route[0].x === px));
    if (!guardOk || !connected()) { set(px, py, '.'); continue; }
    k++;
  }
  const d = def();
  return { def: d, meta: { zones: nz, gates: gates.map((q) => q.type), vault: useVault, valid: validateLevel(d).length === 0 } };
}

/**
 * The daily challenge: try candidate rooms (seed, seed+1, …) until the solver
 * proves one solvable needing at least one ghost. `solveFn(def)` must be a
 * deterministic solver (node budgets, no wall-clock limits).
 */
export function dailyChallenge(key, solveFn, onProgress = () => {}) {
  const base = dailySeed(key);
  for (let attempt = 0; attempt < 24; attempt++) {
    const seed = (base + attempt * 7919) >>> 0;
    const { def, meta } = generateRoom(seed);
    onProgress({ attempt, meta });
    if (!meta.valid) continue;
    def.name = `Tagesrätsel ${key}`;
    def.id = `d${dailyRef(key)}`;
    const res = solveFn(def);
    if (res && res.ok && res.runs.length >= 2 && res.finalTick <= 1700) {
      def.par = Math.ceil((res.finalTick + 120) / 30) * 30;
      return { key, attempt, def, solution: res, meta };
    }
  }
  return null;
}

/** Deterministic solver settings for the daily challenge (node budgets only). */
export const DAILY_SOLVER_OPTS = { maxGhosts: 3, roleExpansions: 5000, finalExpansions: 30000, maxSequences: 40 };
