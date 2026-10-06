// MIRRORFALL — run every Node test in sequence and print a summary.
//   node tools/tests/run-all.mjs [--quick]
// --quick reduces repetition counts (determinism 100×, fuzz 1000 runs).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const quick = process.argv.includes('--quick');
const tests = [
  ['Architekturgrenzen', 'boundaries.mjs', []],
  ['Regeln', 'rules.mjs', []],
  ['Solver (b)', 'solver.mjs', []],
  ['Replay', 'replay.mjs', []],
  ['Determinismus (a)', 'determinism.mjs', [quick ? '100' : '1000']],
  ['Fuzz (c)', 'fuzz.mjs', [quick ? '1000' : '10000']],
  ['Daily', 'daily.mjs', [quick ? '7' : '30']],
  ['Sim-Benchmark (d)', 'bench-sim.mjs', []],
  ['Frame-CPU-Benchmark (d)', 'bench-frame.mjs', []],
];
if (process.argv.includes('--browser')) tests.push(['Browser (Playwright)', 'browser.mjs', quick ? ['--quick'] : []]);
const results = [];
for (const [name, file, args] of tests) {
  const t0 = Date.now();
  console.log(`\n━━━ ${name} ━━━`);
  const r = spawnSync(process.execPath, [join(here, file), ...args], { stdio: 'inherit' });
  results.push([name, r.status === 0, ((Date.now() - t0) / 1000).toFixed(1)]);
}
console.log('\n━━━ Zusammenfassung ━━━');
for (const [name, ok, s] of results) console.log(`  ${ok ? '✔' : '✘'} ${name.padEnd(22)} ${s} s`);
if (results.some(([, ok]) => !ok)) process.exitCode = 1;
