// MIRRORFALL — tiny test helpers (no dependencies).

import { IN_U, IN_D, IN_L, IN_R, IN_A, LOOP_TICKS, MOVE_TICKS } from '../../sim/constants.js';

const DIRMASK = { U: IN_U, D: IN_D, L: IN_L, R: IN_R };

/**
 * Build a recording from a compact script:
 *   'R3'  move right 3 tiles      'W30' wait 30 ticks     'A40' hold action 40 ticks
 *   'T'   tap action (1 tick)     'XL'  throw coin left   'H'   hold action until the end
 */
export function script(src, len = LOOP_TICKS) {
  const out = new Uint8Array(len);
  let t = 0;
  let holdToEnd = false;
  for (const tok of src.trim().split(/\s+/).filter(Boolean)) {
    const op = tok[0], arg = tok.slice(1);
    if (DIRMASK[op]) {
      const n = arg ? parseInt(arg, 10) : 1;
      for (let k = 0; k < n * MOVE_TICKS && t < len; k++) out[t++] = DIRMASK[op];
    } else if (op === 'W') {
      t += parseInt(arg, 10);
    } else if (op === 'A') {
      const n = parseInt(arg, 10);
      for (let k = 0; k < n && t < len; k++) out[t++] = IN_A;
    } else if (op === 'T') {
      if (t < len) out[t++] = IN_A;
      t++;
    } else if (op === 'X') {
      if (t < len) out[t++] = IN_A | DIRMASK[arg];
      t++;
    } else if (op === 'H') {
      holdToEnd = true;
      while (t < len) out[t++] = IN_A;
    } else throw new Error('bad script token ' + tok);
  }
  void holdToEnd;
  return out;
}

let passed = 0, failed = 0;
const failures = [];
export function check(name, cond, detail = '') {
  if (cond) { passed++; }
  else { failed++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name} ${detail}`); }
  return cond;
}
export function summary(title) {
  console.log(`${title}: ${passed} bestanden, ${failed} fehlgeschlagen`);
  if (failed) { for (const f of failures) console.log('   - ' + f); process.exitCode = 1; }
  return failed === 0;
}

/** Make a level map from rows shorter than 30x17: pads with walls. */
export function padMap(rows) {
  const out = [];
  for (let y = 0; y < 17; y++) {
    const r = rows[y] ?? '';
    out.push((r + '#'.repeat(30)).slice(0, 30));
  }
  return out;
}
