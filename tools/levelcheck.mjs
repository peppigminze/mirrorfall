// MIRRORFALL — level design helper (Node CLI).
//   node tools/levelcheck.mjs [levelIndex|all] [--solve] [--trace]
// Prints the map with coordinates, validation results and (optionally) the
// solver's solution summary.

import { CAMPAIGN } from '../levels/campaign.js';
import { validateLevel, compileLevel } from '../sim/level.js';
import { solve, verifySolution, ACTION_NAMES } from './solver.js';

const args = process.argv.slice(2);
const which = args[0] ?? 'all';
const doSolve = args.includes('--solve');
const trace = args.includes('--trace');
const list = which === 'all' ? CAMPAIGN.map((_, i) => i) : which.split(',').map(Number);

for (const i of list) {
  const def = CAMPAIGN[i];
  console.log(`\n=== ${i + 1}. ${def.name} (${def.id}) ===`);
  console.log('    ' + Array.from({ length: 30 }, (_, x) => (x % 10)).join(''));
  def.map.forEach((r, y) => console.log(String(y).padStart(3) + ' ' + r));
  const errs = validateLevel(def);
  if (errs.length) { console.log('  FEHLER:', errs); continue; }
  const L = compileLevel(def);
  console.log(`  Elemente: ${L.plates.length} Platten, ${L.doors.length} Türen, ${L.switches.length} Schalter, ${L.coins.length} Münzen, ${L.lasers.length} Laser, ${L.guards.length} Wachen, ${L.cameras.length} Kameras, ${L.platforms.length} Plattformen, Tresor=${L.terminals.length === 2}`);
  if (doSolve) {
    const r = solve(def, { timeLimitMs: 120000 });
    if (!r.ok) { console.log('  UNGELÖST', JSON.stringify(r.stats)); continue; }
    const v = verifySolution(def, r.runs);
    console.log(`  GELÖST: ${r.runs.length - 1} Geister [${r.roles.join(', ')}], Flucht bei Tick ${r.finalTick} (${(r.finalTick / 60).toFixed(2)} s), verifiziert=${v.ok}`);
    console.log(`  Stats: ${JSON.stringify(r.stats)}`);
    if (trace) console.log('  Finale:', r.acts.map((a) => ACTION_NAMES[a]).join(' '));
  }
}
