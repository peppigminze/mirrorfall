// MIRRORFALL — signed distance field of light-blocking geometry.
// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher) on a grid
// of 8×8 px cells; recomputed only when doors/vault change. Encoded into an
// R8 texture: value = 0.5 + d/128 (d in px, + outside, − inside walls).

import { GRID_W, GRID_H, TILE_PX } from '../sim/constants.js';

export const SDF_CELL = 8;
export const SDF_W = (GRID_W * TILE_PX) / SDF_CELL;   // 120
export const SDF_H = (GRID_H * TILE_PX) / SDF_CELL;   // 68
const INF = 1e20;

function dt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) {
      const r = v[k];
      s = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r);
      if (s <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break;
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    d[q] = (q - r) * (q - r) + f[r];
  }
}

/** Squared EDT of a binary grid (src=1 are the sources). */
function edt(src, w, h) {
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = src[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
  return grid;
}

/** occupancy: Uint8Array(GRID_W*GRID_H) → Uint8Array(SDF_W*SDF_H) encoded SDF. */
export function buildSdf(occ) {
  const k = TILE_PX / SDF_CELL;
  const solid = new Uint8Array(SDF_W * SDF_H), free = new Uint8Array(SDF_W * SDF_H);
  for (let y = 0; y < SDF_H; y++) {
    for (let x = 0; x < SDF_W; x++) {
      const o = occ[((y / k) | 0) * GRID_W + ((x / k) | 0)];
      solid[y * SDF_W + x] = o; free[y * SDF_W + x] = o ? 0 : 1;
    }
  }
  const dOut = edt(solid, SDF_W, SDF_H);   // free cells → nearest solid
  const dIn = edt(free, SDF_W, SDF_H);     // solid cells → nearest free
  const out = new Uint8Array(SDF_W * SDF_H);
  for (let i = 0; i < out.length; i++) {
    const px = solid[i] ? -(Math.sqrt(dIn[i]) - 0.5) * SDF_CELL : (Math.sqrt(dOut[i]) - 0.5) * SDF_CELL;
    out[i] = Math.max(0, Math.min(255, Math.round((0.5 + px / 128) * 255)));
  }
  return out;
}
