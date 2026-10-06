// MIRRORFALL — static architecture checks:
//  * sim/ imports only from sim/
//  * sim/ uses no nondeterministic or environment APIs
//  * render/ and audio/ do not import each other; nothing imports ui/ except ui/ and main.js

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, summary } from './util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(m?js)$/.test(f)) out.push(p);
  }
  return out;
}
function imports(src) {
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push(m[1] || m[2]);
  return out;
}
const topOf = (p) => relative(ROOT, p).split(/[\\/]/)[0];

console.log('Architekturgrenzen');
const files = walk(ROOT).filter((p) => !p.includes('node_modules'));
const FORBIDDEN_IN_SIM = [
  /Math\.random/, /\bDate\b/, /performance\./, /\bwindow\b/, /\bdocument\b/, /\bnavigator\b/,
  /Math\.(sin|cos|tan|atan2?|exp|log|pow|sqrt|hypot)\b/, /setTimeout|setInterval|requestAnimationFrame/,
  /localStorage/, /\bfetch\(/,
];
let simFiles = 0;
for (const f of files) {
  const rel = relative(ROOT, f);
  const top = topOf(f);
  const src = readFileSync(f, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const imp of imports(src)) {
    // Site-root URLs ('/sim/…') appear only in browser-side code strings of the
    // Playwright test (page.evaluate) — they are project files, not libraries.
    if (imp.startsWith('/') && rel.startsWith(join('tools', 'tests'))) continue;
    if (!imp.startsWith('.')) {
      // Only Node built-ins, and only in Node CLI tools (tools/**/*.mjs) — no external libraries anywhere.
      check(`${rel}: keine externen Libraries`, imp.startsWith('node:') && rel.startsWith('tools') && rel.endsWith('.mjs'), imp);
      continue;
    }
    const target = topOf(resolve(dirname(f), imp));
    if (top === 'sim') check(`${rel} → ${imp}`, target === 'sim', 'sim darf nur sim importieren');
    if (top === 'render') check(`${rel} → ${imp}`, target !== 'audio' && target !== 'ui', 'render darf weder audio noch ui importieren');
    if (top === 'audio') check(`${rel} → ${imp}`, target !== 'render' && target !== 'ui', 'audio darf weder render noch ui importieren');
    if (top === 'levels') check(`${rel} → ${imp}`, target === 'sim' || target === 'levels', 'levels nur sim/levels');
  }
  if (top === 'sim') {
    simFiles++;
    for (const re of FORBIDDEN_IN_SIM) check(`${rel}: keine ${re}`, !re.test(code));
  }
}
console.log(`  ${files.length} Dateien geprüft, davon ${simFiles} in sim/`);
summary('Grenzen');
