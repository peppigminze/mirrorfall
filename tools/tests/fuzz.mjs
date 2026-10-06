// MIRRORFALL — fuzz test (c):
// 10 000 random input sequences against the simulation (random level, random
// runner count, random canonical traces). Asserts: no exception, no NaN /
// non-integer / overflow writes (Proxy-guarded sample), all invariants hold.

import { compileLevel } from '../../sim/level.js';
import { makeContext, createWorld, step, G_STATUS, G_TICK } from '../../sim/world.js';
import { rebuildCanon } from '../../sim/timeline.js';
import { Rng } from '../../sim/rng.js';
import { LOOP_TICKS, ST_RUNNING } from '../../sim/constants.js';
import { check, summary } from './util.mjs';
import { checkInvariants, guardState } from './invariants.mjs';
import { levelPool } from './levelpool.mjs';

const N = +(process.argv[2] || 10000);
const pool = await levelPool({ withDaily: 8 });
const ctxs = pool.map((def) => makeContext(compileLevel(def)));

function randomInputs(rng, len) {
  const out = new Uint8Array(LOOP_TICKS);
  let t = 0;
  const style = rng.int(3);
  while (t < len) {
    let m;
    if (style === 0) m = rng.int(32);                                   // anything, incl. weird combos
    else if (style === 1) m = rng.chance(1, 5) ? 0 : 1 << rng.int(5);   // single bits
    else m = (1 << rng.int(4)) | (rng.chance(1, 3) ? 16 : 0);           // move + action
    const n = 1 + rng.int(style === 0 ? 12 : 60);
    out.fill(m, t, Math.min(len, t + n));
    t += n;
  }
  return out;
}

console.log(`Fuzz-Test: ${N} zufällige Eingabefolgen über ${pool.length} Level`);
const t0 = performance.now();
let exceptions = 0, violations = 0, ticks = 0, guarded = 0;
const statusCount = [0, 0, 0, 0, 0];
const firstProblems = [];
for (let it = 0; it < N; it++) {
  const rng = new Rng(0xF022 + it * 2654435761);
  const li = rng.int(pool.length);
  const ctx = ctxs[li];
  const nRun = 1 + rng.int(5);
  const len = 1 + rng.int(LOOP_TICKS);
  const runs = Array.from({ length: nRun }, () => randomInputs(rng, len));
  let canon = [];
  const cm = rng.int(10);
  try {
    if (cm < 3 && nRun > 1) {
      canon = rebuildCanon(ctx, runs.slice(0, nRun - 1)).canon;
    } else if (cm === 3) {
      canon = Array.from({ length: nRun - 1 }, () => {
        const a = new Uint32Array(LOOP_TICKS);
        for (let k = 0; k < LOOP_TICKS; k++) a[k] = rng.nextU32();
        return a;
      });
    }
    const w = createWorld(ctx, nRun, canon, rng.chance(1, 2));
    const isGuarded = it % 40 === 0;
    if (isGuarded) { guardState(w); guarded++; }
    const inp = new Uint8Array(nRun);
    while (w.s[G_STATUS] === ST_RUNNING && w.s[G_TICK] < len) {
      const t = w.s[G_TICK];
      for (let j = 0; j < nRun; j++) inp[j] = runs[j][t];
      step(w, inp);
      ticks++;
      if (isGuarded || (t & 15) === 0) {
        const v = checkInvariants(w);
        if (v) {
          violations++;
          if (firstProblems.length < 8) firstProblems.push(`it=${it} level=${pool[li].id} t=${t}: ${v}`);
          break;
        }
      }
    }
    statusCount[w.s[G_STATUS]]++;
  } catch (e) {
    exceptions++;
    if (firstProblems.length < 8) firstProblems.push(`it=${it} level=${pool[li].id}: ${e.stack.split('\n').slice(0, 3).join(' | ')}`);
  }
}
const dt = performance.now() - t0;
for (const p of firstProblems) console.log('  ! ' + p);
console.log(`  ${N} Läufe, ${ticks} Ticks in ${(dt / 1000).toFixed(1)} s; davon ${guarded} mit Proxy-Wächter (NaN/Overflow)`);
console.log(`  Endzustände: läuft=${statusCount[0]} Sieg=${statusCount[1]} Alarm=${statusCount[2]} Paradox=${statusCount[3]} Zeitende=${statusCount[4]}`);
check('Fuzz: keine Exceptions', exceptions === 0, `${exceptions}`);
check('Fuzz: keine Invariantenverletzung / kein NaN', violations === 0, `${violations}`);
summary('Fuzz');
