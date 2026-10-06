// MIRRORFALL — level parsing, validation and compilation.
// Input: plain level JSON (see DESIGN.md §3). Output: an immutable compiled
// level with typed-array lookup grids. Pure: no DOM, no time, no randomness.

import {
  GRID_W, GRID_H, CELLS, LIMITS, DX4, DY4, DIR_NAMES,
  T_FLOOR, T_WALL, T_CHASM, T_DOOR, T_VAULT,
  O_NONE, O_SPAWN, O_EXIT, O_LOOT, O_COIN, O_PLATE, O_SWITCH, O_TERMINAL,
} from './constants.js';
import { hashString } from './rng.js';

export const cellOf = (x, y) => y * GRID_W + x;
export const cellX = (c) => c % GRID_W;
export const cellY = (c) => (c / GRID_W) | 0;
export const inBounds = (x, y) => x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;

const DOOR_CHARS = 'ABCDEFGH';
const INV_DOOR_CHARS = 'JKLMNOPQ';
const PLATE_CHARS = 'abcdefgh';
const SWITCH_CHARS = '12345678';

/** Map a direction value ('U','D','L','R' or 0..3) to 0..3, or -1. */
export function dirIndex(d) {
  if (typeof d === 'number') return d >= 0 && d < 4 ? d : -1;
  if (typeof d !== 'string') return -1;
  return DIR_NAMES.indexOf(d.toUpperCase());
}

/** Returns a list of human-readable problems (empty list = valid). */
export function validateLevel(def) {
  const errs = [];
  if (!def || typeof def !== 'object') return ['Level ist kein Objekt'];
  if (!Array.isArray(def.map) || def.map.length !== GRID_H) {
    errs.push(`map braucht ${GRID_H} Zeilen`);
    return errs;
  }
  let spawn = 0, exit = 0, loot = 0, term = 0, vault = 0;
  const counts = { plates: 0, doors: 0, switches: 0, coins: 0 };
  for (let y = 0; y < GRID_H; y++) {
    const row = def.map[y];
    if (typeof row !== 'string' || row.length !== GRID_W) {
      errs.push(`Zeile ${y} braucht ${GRID_W} Zeichen`);
      continue;
    }
    for (let x = 0; x < GRID_W; x++) {
      const ch = row[x];
      if (ch === 'S') spawn++;
      else if (ch === 'E') exit++;
      else if (ch === '$') loot++;
      else if (ch === 'T') term++;
      else if (ch === 'V') vault++;
      else if (ch === 'o') counts.coins++;
      else if (PLATE_CHARS.includes(ch)) counts.plates++;
      else if (DOOR_CHARS.includes(ch) || INV_DOOR_CHARS.includes(ch)) counts.doors++;
      else if (SWITCH_CHARS.includes(ch)) counts.switches++;
      else if (!'#.~'.includes(ch)) errs.push(`Unbekanntes Zeichen '${ch}' bei ${x},${y}`);
    }
  }
  if (spawn !== 1) errs.push('Genau ein Start (S) nötig');
  if (exit < 1) errs.push('Mindestens ein Ausgang (E) nötig');
  if (loot !== 1) errs.push('Genau eine Beute ($) nötig');
  if (term !== 0 && term !== 2) errs.push('Tresor braucht genau zwei Terminals (T)');
  if (vault > 0 && term !== 2) errs.push('Tresortür (V) ohne zwei Terminals');
  for (const k of Object.keys(counts)) {
    if (counts[k] > LIMITS[k]) errs.push(`Zu viele ${k} (max ${LIMITS[k]})`);
  }
  const lists = ['lasers', 'guards', 'cameras', 'platforms'];
  for (const k of lists) {
    if (def[k] && !Array.isArray(def[k])) errs.push(`${k} muss eine Liste sein`);
    if (def[k] && def[k].length > LIMITS[k]) errs.push(`Zu viele ${k} (max ${LIMITS[k]})`);
  }
  if (errs.length) return errs;
  const at = (x, y) => (inBounds(x, y) ? def.map[y][x] : '#');
  for (const [i, l] of (def.lasers || []).entries()) {
    if (!inBounds(l.x, l.y)) errs.push(`Laser ${i} außerhalb`);
    if (dirIndex(l.dir) < 0) errs.push(`Laser ${i}: Richtung fehlt`);
  }
  for (const [i, g] of (def.guards || []).entries()) {
    if (!Array.isArray(g.route) || g.route.length < 1) { errs.push(`Wache ${i}: Route fehlt`); continue; }
    for (const w of g.route) {
      const c = at(w.x, w.y);
      if (c === '#' || c === '~' || c === 'V') errs.push(`Wache ${i}: Wegpunkt ${w.x},${w.y} unbegehbar`);
    }
  }
  for (const [i, c] of (def.cameras || []).entries()) {
    if (!inBounds(c.x, c.y)) errs.push(`Kamera ${i} außerhalb`);
  }
  for (const [i, p] of (def.platforms || []).entries()) {
    if (p.x0 !== p.x1 && p.y0 !== p.y1) { errs.push(`Plattform ${i}: Pfad muss gerade sein`); continue; }
    const n = Math.max(Math.abs(p.x1 - p.x0), Math.abs(p.y1 - p.y0));
    if (n < 1) errs.push(`Plattform ${i}: Pfad zu kurz`);
    const sx = Math.sign(p.x1 - p.x0), sy = Math.sign(p.y1 - p.y0);
    for (let k = 0; k <= n; k++) {
      if (at(p.x0 + sx * k, p.y0 + sy * k) !== '~') { errs.push(`Plattform ${i}: Pfad muss über Abgrund (~) laufen`); break; }
    }
  }
  return errs;
}

/** Guard-walkable on the static map (doors count as walkable for routes). */
function staticGuardWalkable(tile, c) {
  const t = tile[c];
  return t === T_FLOOR || t === T_DOOR;
}

/** BFS shortest path between cells on the static guard map. Returns cells (excluding `from`). */
function staticPath(tile, from, to) {
  if (from === to) return [];
  const prev = new Int32Array(CELLS).fill(-1);
  const q = new Int32Array(CELLS);
  let qh = 0, qt = 0;
  q[qt++] = from; prev[from] = from;
  while (qh < qt) {
    const c = q[qh++];
    if (c === to) break;
    const x = cellX(c), y = cellY(c);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d], ny = y + DY4[d];
      if (!inBounds(nx, ny)) continue;
      const n = cellOf(nx, ny);
      if (prev[n] !== -1 || !staticGuardWalkable(tile, n)) continue;
      prev[n] = c; q[qt++] = n;
    }
  }
  if (prev[to] === -1) return null;
  const path = [];
  for (let c = to; c !== from; c = prev[c]) path.push(c);
  path.reverse();
  return path;
}

/**
 * Compile a level definition. Throws on invalid input.
 * The returned object is treated as immutable by the simulation.
 */
export function compileLevel(def) {
  const errs = validateLevel(def);
  if (errs.length) throw new Error('Ungültiges Level: ' + errs.join('; '));

  const tile = new Uint8Array(CELLS);
  const obj = new Uint8Array(CELLS);
  const objIdx = new Int16Array(CELLS).fill(-1);
  const doorAt = new Int16Array(CELLS).fill(-1);
  const plates = [], doors = [], switches = [], coins = [], terminals = [], vaultCells = [], exits = [];
  let spawn = -1, loot = -1;

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const c = cellOf(x, y);
      const ch = def.map[y][x];
      tile[c] = T_FLOOR;
      if (ch === '#') tile[c] = T_WALL;
      else if (ch === '~') tile[c] = T_CHASM;
      else if (ch === 'S') { obj[c] = O_SPAWN; spawn = c; }
      else if (ch === 'E') { obj[c] = O_EXIT; exits.push(c); }
      else if (ch === '$') { obj[c] = O_LOOT; loot = c; }
      else if (ch === 'o') { obj[c] = O_COIN; objIdx[c] = coins.length; coins.push({ x, y, c }); }
      else if (ch === 'T') { obj[c] = O_TERMINAL; objIdx[c] = terminals.length; terminals.push({ x, y, c }); }
      else if (ch === 'V') { tile[c] = T_VAULT; vaultCells.push(c); }
      else if (PLATE_CHARS.includes(ch)) {
        obj[c] = O_PLATE; objIdx[c] = plates.length;
        plates.push({ x, y, c, ch: PLATE_CHARS.indexOf(ch) });
      } else if (SWITCH_CHARS.includes(ch)) {
        obj[c] = O_SWITCH; objIdx[c] = switches.length;
        switches.push({ x, y, c, ch: SWITCH_CHARS.indexOf(ch) });
      } else if (DOOR_CHARS.includes(ch) || INV_DOOR_CHARS.includes(ch)) {
        const inv = INV_DOOR_CHARS.includes(ch) ? 1 : 0;
        tile[c] = T_DOOR; doorAt[c] = doors.length;
        doors.push({ x, y, c, ch: inv ? INV_DOOR_CHARS.indexOf(ch) : DOOR_CHARS.indexOf(ch), inv });
      }
    }
  }
  // The outer frame is always solid, regardless of what the map says.
  for (let x = 0; x < GRID_W; x++) { tile[cellOf(x, 0)] = T_WALL; tile[cellOf(x, GRID_H - 1)] = T_WALL; }
  for (let y = 0; y < GRID_H; y++) { tile[cellOf(0, y)] = T_WALL; tile[cellOf(GRID_W - 1, y)] = T_WALL; }

  const lasers = (def.lasers || []).map((l) => ({
    x: l.x | 0, y: l.y | 0, c: cellOf(l.x | 0, l.y | 0), dir: dirIndex(l.dir),
    on: Math.max(0, l.on ?? 60) | 0, off: Math.max(0, l.off ?? 0) | 0, ph: (l.ph ?? 0) | 0,
    ch: l.ch ?? -1, inv: l.inv ? 1 : 0,
  }));

  const guards = (def.guards || []).map((g, gi) => {
    const wps = g.route.map((w) => ({ c: cellOf(w.x, w.y), wait: Math.max(0, w.wait | 0), look: dirIndex(w.look) }));
    const route = [], waits = [], looks = [];
    if (wps.length === 1) {
      route.push(wps[0].c); waits.push(Math.max(1, wps[0].wait)); looks.push(wps[0].look);
    } else {
      for (let i = 0; i < wps.length; i++) {
        const a = wps[i], b = wps[(i + 1) % wps.length];
        const seg = staticPath(tile, a.c, b.c);
        if (!seg) throw new Error(`Wache ${gi}: Wegpunkte nicht verbunden`);
        for (let k = 0; k < seg.length; k++) {
          const isEnd = k === seg.length - 1;
          route.push(seg[k]);
          waits.push(isEnd ? b.wait : 0);
          looks.push(isEnd ? b.look : -1);
        }
      }
      if (route.length === 0) { route.push(wps[0].c); waits.push(1); looks.push(wps[0].look); }
    }
    // Start on the first waypoint, which is the last entry of the loop.
    const startIdx = route.length - 1;
    // Initial facing: towards the next route tile (or the waypoint's look dir).
    let face = wps[0].look >= 0 ? wps[0].look : 3;
    if (route.length > 1 && wps[0].look < 0) {
      const n = route[0], s = route[startIdx];
      const dx = cellX(n) - cellX(s), dy = cellY(n) - cellY(s);
      face = dy < 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
    }
    return {
      route: Int32Array.from(route), waits: Int32Array.from(waits), looks: Int8Array.from(looks),
      startIdx, startCell: route[startIdx], face, startWait: wps.length === 1 ? 0 : wps[0].wait,
    };
  });

  const cameras = (def.cameras || []).map((c) => {
    const a0 = ((c.a0 ?? -16) | 0), a1 = ((c.a1 ?? 16) | 0);
    return {
      x: c.x | 0, y: c.y | 0, c: cellOf(c.x | 0, c.y | 0),
      a0: Math.min(a0, a1), a1: Math.max(a0, a1),
      speed: Math.max(1, c.speed ?? 4) | 0, pause: Math.max(0, c.pause ?? 40) | 0,
      ch: c.ch ?? -1, inv: c.inv ? 1 : 0,
    };
  });

  const platformAt = new Int16Array(CELLS).fill(-1);
  const platforms = (def.platforms || []).map((p, pi) => {
    const n = Math.max(Math.abs(p.x1 - p.x0), Math.abs(p.y1 - p.y0));
    const sx = Math.sign(p.x1 - p.x0), sy = Math.sign(p.y1 - p.y0);
    const path = [];
    for (let k = 0; k <= n; k++) {
      const c = cellOf(p.x0 + sx * k, p.y0 + sy * k);
      path.push(c); platformAt[c] = pi;
    }
    return { path: Int32Array.from(path), dwell: Math.max(8, p.dwell ?? 60) | 0, ch: p.ch ?? -1, inv: p.inv ? 1 : 0 };
  });

  // Channel masks: which channels have anything that can drive them.
  let chHasPlate = 0, chHasSwitch = 0;
  for (const p of plates) chHasPlate |= 1 << p.ch;
  for (const s of switches) chHasSwitch |= 1 << s.ch;

  const seed = (def.seed ?? hashString(JSON.stringify(def.map))) >>> 0;
  return {
    def, id: def.id || 'custom', name: def.name || 'Unbenannt', seed, par: def.par ?? 0,
    tile, obj, objIdx, doorAt, platformAt,
    spawn, loot, exits, plates, doors, switches, coins, terminals, vaultCells,
    lasers, guards, cameras, platforms, chHasPlate, chHasSwitch,
  };
}

/** Deterministic content hash of a level definition (for replays of custom levels). */
export function levelHash(def) {
  const norm = {
    map: def.map, lasers: def.lasers || [], guards: def.guards || [],
    cameras: def.cameras || [], platforms: def.platforms || [],
  };
  return hashString(JSON.stringify(norm));
}
