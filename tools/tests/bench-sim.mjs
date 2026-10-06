// MIRRORFALL — raw simulation throughput benchmark.

import { compileLevel } from '../../sim/level.js';
import { makeContext, createWorld, step, cloneWorld, G_STATUS, G_TICK } from '../../sim/world.js';
import { Rng } from '../../sim/rng.js';
import { LOOP_TICKS, ST_RUNNING } from '../../sim/constants.js';
import { levelPool } from './levelpool.mjs';

const pool = await levelPool();
console.log('Sim-Benchmark (ohne Hashing, ohne Events)');
for (const def of pool) {
  const ctx = makeContext(compileLevel(def));
  const rng = new Rng(5);
  const runs = Array.from({ length: 5 }, () => {
    const a = new Uint8Array(LOOP_TICKS);
    for (let t = 0; t < LOOP_TICKS; t += 20) a.fill(rng.chance(1, 4) ? 0 : 1 << rng.int(4), t, t + 20);
    return a;
  });
  const inp = new Uint8Array(5);
  let ticks = 0, clones = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 600) {
    const w = createWorld(ctx, 5, []);
    while (w.s[G_STATUS] === ST_RUNNING) {
      const t = w.s[G_TICK];
      for (let j = 0; j < 5; j++) inp[j] = runs[j][t];
      step(w, inp);
      ticks++;
      if ((t & 7) === 0) { cloneWorld(w); clones++; }
    }
  }
  const dt = performance.now() - t0;
  console.log(`  ${def.id.padEnd(10)} ${(ticks / dt * 1000 / 1e6).toFixed(2)} M Ticks/s  (${(dt * 1000 / ticks).toFixed(2)} µs/Tick, 5 Läufer, ${ctx.L.guards.length} Wachen, Zustand ${ctx.lay.size} int32)`);
}
