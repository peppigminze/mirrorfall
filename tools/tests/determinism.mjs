// MIRRORFALL — determinism test (a):
// The same recording is simulated 1000 times from scratch (fresh compile,
// fresh context, fresh world). Every run must produce the identical per-tick
// hash chain and final hash. Additionally, clone-and-continue must match.

import { compileLevel } from '../../sim/level.js';
import { makeContext, createWorld, step, cloneWorld, hashWorld, G_STATUS, G_TICK } from '../../sim/world.js';
import { rebuildCanon } from '../../sim/timeline.js';
import { Rng, hash32 } from '../../sim/rng.js';
import { LOOP_TICKS, ST_RUNNING } from '../../sim/constants.js';
import { check, summary } from './util.mjs';
import { levelPool } from './levelpool.mjs';

const N = +(process.argv[2] || 1000);

function randomRecording(rng, len = LOOP_TICKS) {
  const out = new Uint8Array(len);
  let t = 0;
  while (t < len) {
    const m = rng.chance(1, 4) ? 0 : (1 << rng.int(4)) | (rng.chance(1, 6) ? 16 : 0);
    const n = 1 + rng.int(40);
    out.fill(m, t, Math.min(len, t + n));
    t += n;
  }
  return out;
}

function runChain(def, runs, canon) {
  const L = compileLevel(def);
  const ctx = makeContext(L);
  const w = createWorld(ctx, runs.length, canon);
  const inp = new Uint8Array(runs.length);
  let chain = 0x12345678;
  while (w.s[G_STATUS] === ST_RUNNING) {
    const t = w.s[G_TICK];
    for (let j = 0; j < runs.length; j++) inp[j] = runs[j][t];
    step(w, inp);
    chain = hash32(chain ^ hashWorld(w));
  }
  return { chain, final: hashWorld(w), ticks: w.s[G_TICK], status: w.s[G_STATUS] };
}

console.log(`Determinismus-Test: ${N} Wiederholungen je Szenario`);
const pool = await levelPool();
const scenarios = [];
// Scenario per level: 5 runners with random inputs, paradox checks off.
for (const def of pool) {
  const rng = new Rng(hash32(def.seed ?? 99));
  scenarios.push({ name: `${def.id} (5 Läufer, zufällig)`, def, runs: Array.from({ length: 5 }, () => randomRecording(rng)), canon: [] });
}
// Scenario with real canonical traces (ghosts must stay consistent).
{
  const def = pool[0];
  const rng = new Rng(7);
  const runs = [randomRecording(rng), randomRecording(rng), randomRecording(rng)];
  const ctx = makeContext(compileLevel(def));
  const rb = rebuildCanon(ctx, runs.slice(0, 2));
  scenarios.push({ name: `${def.id} (mit kanonischen Spuren)`, def, runs, canon: rb.canon });
}
// Solver solutions, if present.
try {
  const { readFileSync } = await import('node:fs');
  const sols = JSON.parse(readFileSync(new URL('./solutions.json', import.meta.url)));
  const { decodeReplay } = await import('../../sim/replay.js');
  for (const def of pool) {
    const str = sols[def.id];
    if (!str) continue;
    const { runs } = decodeReplay(str);
    const ctx = makeContext(compileLevel(def));
    const rb = rebuildCanon(ctx, runs);
    scenarios.push({ name: `${def.id} (Bot-Lösung, ${runs.length} Läufe)`, def, runs, canon: rb.canon.slice(0, runs.length - 1) });
  }
} catch { /* no solutions yet */ }

const t0 = performance.now();
let totalTicks = 0;
for (const sc of scenarios) {
  const ref = runChain(sc.def, sc.runs, sc.canon);
  let same = 0;
  for (let i = 0; i < N; i++) {
    const r = runChain(sc.def, sc.runs, sc.canon);
    totalTicks += r.ticks;
    if (r.chain === ref.chain && r.final === ref.final && r.ticks === ref.ticks) same++;
  }
  check(`${sc.name}: ${N}/${N} identisch`, same === N, `${same}/${N}`);
  console.log(`  ${sc.name.padEnd(42)} Ticks=${String(ref.ticks).padStart(4)} Kette=${ref.chain.toString(16).padStart(8, '0')} End=${ref.final.toString(16).padStart(8, '0')} → ${same}/${N} identisch`);

  // Clone-and-continue equivalence at random split points.
  const rng = new Rng(ref.chain);
  for (let k = 0; k < 5; k++) {
    const L = compileLevel(sc.def), ctx = makeContext(L);
    const w = createWorld(ctx, sc.runs.length, sc.canon);
    const inp = new Uint8Array(sc.runs.length);
    const split = rng.int(Math.max(1, ref.ticks));
    let clone = null;
    while (w.s[G_STATUS] === ST_RUNNING) {
      const t = w.s[G_TICK];
      if (t === split) clone = cloneWorld(w);
      for (let j = 0; j < sc.runs.length; j++) inp[j] = sc.runs[j][t];
      step(w, inp);
    }
    if (clone) {
      while (clone.s[G_STATUS] === ST_RUNNING) {
        const t = clone.s[G_TICK];
        for (let j = 0; j < sc.runs.length; j++) inp[j] = sc.runs[j][t];
        step(clone, inp);
      }
      check(`${sc.name}: Klon ab Tick ${split} identisch`, hashWorld(clone) === hashWorld(w));
    }
  }
}
const dt = performance.now() - t0;
console.log(`  ${totalTicks} simulierte Ticks in ${(dt / 1000).toFixed(2)} s (${Math.round(totalTicks / dt * 1000)} Ticks/s inkl. Hashing)`);
summary('Determinismus');
