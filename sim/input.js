// MIRRORFALL — input recordings.
// A recording is one 5-bit mask per tick. In memory we keep the expanded
// Uint8Array (O(1) lookup during resimulation); for storage/export we use
// run-length encoding: [[mask, count], ...].

import { LOOP_TICKS } from './constants.js';

/** Expand-ready empty recording (all zero = standing still). */
export function emptyInputs(len = LOOP_TICKS) { return new Uint8Array(len); }

/** RLE-encode the first `len` masks. */
export function encodeRLE(masks, len = masks.length) {
  const out = [];
  let i = 0;
  while (i < len) {
    const m = masks[i] & 31;
    let n = 1;
    while (i + n < len && (masks[i + n] & 31) === m) n++;
    out.push([m, n]);
    i += n;
  }
  return out;
}

/** Decode RLE pairs into a recording of `total` ticks (zero-padded). */
export function decodeRLE(pairs, total = LOOP_TICKS) {
  const out = new Uint8Array(total);
  let t = 0;
  for (const [m, n] of pairs) {
    if (!(n > 0)) throw new Error('RLE: ungültige Länge');
    const end = Math.min(total, t + n);
    out.fill(m & 31, t, end);
    t += n;
    if (t >= total) break;
  }
  return out;
}

/** Number of ticks covered by an RLE list. */
export function rleLength(pairs) {
  let t = 0;
  for (const [, n] of pairs) t += n;
  return t;
}
