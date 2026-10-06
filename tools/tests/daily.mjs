// MIRRORFALL — daily challenge test: generate and prove rooms for N
// consecutive dates. Checks: every date yields a room, the bot's solution
// re-verifies independently, generation is deterministic (same key → same room).

import { dailyChallenge, dailyKey, DAILY_SOLVER_OPTS, generateRoom, dailySeed } from '../../levels/daily.js';
import { solve, verifySolution } from '../solver.js';
import { check, summary } from './util.mjs';

const N = +(process.argv[2] || 30);
console.log(`Tagesrätsel: ${N} Daten ab 2026-10-01`);
const t0 = Date.now();
let ok = 0, ghostsHist = {}, attempts = 0, maxMs = 0;
for (let i = 0; i < N; i++) {
  const d = new Date(2026, 9, 1 + i);
  const key = dailyKey(d);
  const s0 = Date.now();
  const res = dailyChallenge(key, (def) => solve(def, DAILY_SOLVER_OPTS));
  const ms = Date.now() - s0;
  maxMs = Math.max(maxMs, ms);
  if (!check(`${key}: Raum erzeugt & bewiesen`, !!res)) continue;
  const v = verifySolution(res.def, res.solution.runs);
  check(`${key}: Bot-Lösung verifiziert`, v.ok);
  // determinism: generate the same candidate again
  const again = generateRoom((dailySeed(key) + res.attempt * 7919) >>> 0).def;
  check(`${key}: deterministisch`, JSON.stringify(again.map) === JSON.stringify(res.def.map));
  const g = res.solution.runs.length - 1;
  ghostsHist[g] = (ghostsHist[g] || 0) + 1;
  attempts += res.attempt + 1;
  ok++;
  console.log(`  ${key}  Versuch ${res.attempt + 1}  ${res.meta.zones} Zonen [${res.meta.gates.join(',')}${res.meta.vault ? ',tresor' : ''}]  Bot: ${g} Geister, ${(res.solution.finalTick / 60).toFixed(1)} s  (${ms} ms)`);
}
console.log(`  ${ok}/${N} bewiesen, Geister-Verteilung ${JSON.stringify(ghostsHist)}, Ø ${(attempts / Math.max(1, ok)).toFixed(1)} Kandidaten, max ${maxMs} ms, gesamt ${((Date.now() - t0) / 1000).toFixed(1)} s`);
summary('Daily');
