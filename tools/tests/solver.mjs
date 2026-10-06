// MIRRORFALL — solver test (b):
//  * the bot solves all 12 campaign levels; every solution is re-verified by an
//    independent resimulation (rebuild all canonical traces, last run must win)
//  * escape time ≤ par
//  * levels 9–12: the bot proves that the wrong recording order fails —
//      1. RE-PLAN: every other role order is planned from scratch (the first
//         role additionally with arrival delays 0…1500 ticks); "trap pairs"
//         (X must be recorded before Y) are pairs whose inversion ALWAYS fails
//      2. REPLAY: the bot's recorded inputs, replayed in the wrong order,
//         break the timeline (paradox or alarm) when the canonical traces are rebuilt
// Solutions are written to tools/tests/solutions.json (replay strings).

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { CAMPAIGN } from '../../levels/campaign.js';
import { solve, verifySolution, planSequence, planRun, deriveRoles } from '../solver.js';
import { compileLevel } from '../../sim/level.js';
import { makeContext } from '../../sim/world.js';
import { rebuildCanon, simulateLoop } from '../../sim/timeline.js';
import { encodeReplay, LK_CAMPAIGN } from '../../sim/replay.js';
import { ST_PARADOX, ST_CAUGHT, ST_WON, ST_TIMEOUT } from '../../sim/constants.js';
import { check, summary } from './util.mjs';

const only = process.argv[2] ? process.argv[2].split(',').map(Number) : null;
const ST = { [ST_PARADOX]: 'PARADOX', [ST_CAUGHT]: 'ALARM', [ST_WON]: 'SIEG', [ST_TIMEOUT]: 'ZEITENDE', 0: 'LÄUFT' };
const DELAYS = [0, 150, 300, 450, 600, 750, 900, 1050, 1200, 1350, 1500];

function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((x, i) => {
    for (const p of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([x, ...p]);
  });
  return out;
}

const solutions = {};
const t0 = Date.now();
console.log('Solver-Test: Kampagne');
for (let i = 0; i < CAMPAIGN.length; i++) {
  if (only && !only.includes(i + 1)) continue;
  const def = CAMPAIGN[i];
  const r = solve(def, { timeLimitMs: 240000 });
  if (!check(`L${i + 1} ${def.name}: gelöst`, r.ok, JSON.stringify(r.stats))) continue;
  const v = verifySolution(def, r.runs);
  check(`L${i + 1}: unabhängig verifiziert`, v.ok, `failedAt=${v.failedAt} status=${v.status}`);
  const ghosts = r.runs.length - 1;
  console.log(`  L${String(i + 1).padStart(2)} ${def.name.padEnd(16)} ${ghosts} Geister  Flucht ${(r.finalTick / 60).toFixed(2).padStart(5)} s  Par ${(def.par / 60).toFixed(2)} s  ` +
    `${(r.stats.ms / 1000).toFixed(1)} s, ${r.stats.expansions} Knoten  [${r.roles.join(' → ')}]`);
  if (def.par > 0) check(`L${i + 1}: Bot-Zeit ≤ Par`, r.finalTick <= def.par, `${r.finalTick} > ${def.par}`);
  else console.log(`     (Par-Vorschlag: ${Math.ceil((r.finalTick + 90) / 30) * 30})`);
  solutions[def.id] = encodeReplay({ kind: LK_CAMPAIGN, ref: i }, r.runs, r.runs.map((_, k) => (k === r.runs.length - 1 ? r.finalTick : 1800)));

  if (i < 8) continue;
  // ---------------- Paradox-trap proof (levels 9–12) ----------------
  const keys = r.roleKeys;
  check(`L${i + 1}: Falle braucht ≥ 2 Geister`, keys.length >= 2, `${keys.length}`);
  const perms = permutations(keys.map((_, k) => k)).filter((p) => p.some((x, k) => x !== k));
  const permOk = new Map();
  for (const p of perms) {
    const order = p.map((k) => keys[k]);
    let ok = false, reason = '';
    for (const d of DELAYS) {
      const res = planSequence(def, order, { firstNotBefore: d, finalExpansions: 50000 });
      if (res.ok) { ok = true; reason = `lösbar (erste Rolle ab Tick ${d})`; break; }
      reason = res.reason;
      if (/eingesteckt|nicht planbar/.test(res.reason) && res.stage > 0) break;   // structural: delays cannot help
    }
    permOk.set(p.join(','), ok);
    console.log(`     Reihenfolge [${p.map((k) => k + 1).join(',')}]: ${ok ? 'funktioniert' : 'SCHEITERT'} — ${reason}`);
  }
  // Trap pairs: a before b in the solution, and every permutation with b before a fails.
  const traps = [];
  for (let a = 0; a < keys.length; a++) {
    for (let b = a + 1; b < keys.length; b++) {
      const inverted = perms.filter((p) => p.indexOf(b) < p.indexOf(a));
      if (inverted.length && inverted.every((p) => !permOk.get(p.join(',')))) traps.push([a, b]);
    }
  }
  check(`L${i + 1}: mindestens ein Reihenfolge-Paar erzwungen`, traps.length > 0);
  for (const [a, b] of traps) {
    console.log(`     ⇒ Falle bewiesen: „${r.roles[a]}“ MUSS vor „${r.roles[b]}“ aufgenommen werden`);
    // Replay demonstration: swap the recorded runs a and b.
    const runs = r.runs.slice();
    [runs[a], runs[b]] = [runs[b], runs[a]];
    const ctx = makeContext(compileLevel(def));
    const rb = rebuildCanon(ctx, runs);
    const last = rb.results[rb.results.length - 1];
    const broke = !rb.ok || last.status !== ST_WON;
    const where = rb.ok ? `Finale: ${ST[last.status]}` : `Lauf ${rb.failedAt + 1}: ${ST[rb.results[rb.failedAt].status]}` +
      (rb.results[rb.failedAt].status === ST_PARADOX ? ` (Geist ${rb.results[rb.failedAt].arg + 1} weicht ab)` : '');
    check(`L${i + 1}: vertauschte Aufnahme bricht die Timeline`, broke, where);
    console.log(`       Replay mit vertauschter Aufnahme (${b + 1}↔${a + 1}): ${where}`);

    // Paradox demonstration: a human records the helper first (hesitating 2 s
    // at the start), then sends a later runner to grab the coin before it.
    const role = deriveRoles(ctx.L).find((x) => x.key === keys[a]);
    if (role && role.kind === 'lure') {
      let shown = false;
      for (const hesitate of [120, 200, 300, 400]) {
        const helper = new Uint8Array(1800);
        helper.set(r.runs[b].subarray(0, 1800 - hesitate), hesitate);
        const alone = rebuildCanon(ctx, [helper]);
        if (!alone.ok) continue;
        const thief = planRun(ctx, [helper], [null], role, { maxExpansions: 20000 });
        if (!thief.inputs) continue;
        const res = simulateLoop(ctx, [helper], alone.canon, thief.inputs);
        const ok = res.status === ST_PARADOX && res.arg === 0;
        check(`L${i + 1}: Münze vor dem Helfer stehlen → Paradox`, ok, `${ST[res.status]}`);
        console.log(`       Paradox-Demo: Helfer zögert ${(hesitate / 60).toFixed(1)} s, Köder-Läufer stiehlt die Münze → ${ST[res.status]} bei Tick ${res.tick} (Geist ${res.arg + 1})`);
        shown = true;
        break;
      }
      check(`L${i + 1}: Paradox-Demo konstruierbar`, shown);
    }
  }
}
const solPath = new URL('./solutions.json', import.meta.url);
const merged = only && existsSync(solPath) ? { ...JSON.parse(readFileSync(solPath)), ...solutions } : solutions;
writeFileSync(solPath, JSON.stringify(merged, null, 2) + '\n');
console.log(`  Gesamtzeit ${((Date.now() - t0) / 1000).toFixed(1)} s; Lösungen → tools/tests/solutions.json`);
summary('Solver');
