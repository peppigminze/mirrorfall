// MIRRORFALL — replay format tests: RLE + binary + base64url roundtrips,
// corruption detection, and full reconstruction of the bot's solutions.

import { readFileSync } from 'node:fs';
import { encodeRLE, decodeRLE } from '../../sim/input.js';
import { encodeReplay, decodeReplay, toBase64Url, fromBase64Url, LK_CAMPAIGN } from '../../sim/replay.js';
import { Rng } from '../../sim/rng.js';
import { CAMPAIGN } from '../../levels/campaign.js';
import { verifySolution } from '../solver.js';
import { check, summary } from './util.mjs';

console.log('Replay-Tests');
const rng = new Rng(99);
// RLE roundtrip on random recordings.
let rleOk = 0;
for (let k = 0; k < 500; k++) {
  const a = new Uint8Array(1800);
  for (let t = 0; t < 1800;) { const n = 1 + rng.int(90); a.fill(rng.int(32), t, t + n); t += n; }
  const b = decodeRLE(encodeRLE(a));
  if (a.every((v, i) => v === b[i])) rleOk++;
}
check('RLE-Roundtrip 500/500', rleOk === 500, `${rleOk}`);

// Base64url roundtrip incl. all remainders.
let b64 = 0;
for (let n = 0; n < 64; n++) {
  const bytes = Uint8Array.from({ length: n }, () => rng.int(256));
  const back = fromBase64Url(toBase64Url(bytes));
  if (back.length === n && bytes.every((v, i) => v === back[i])) b64++;
}
check('Base64url-Roundtrip 64/64', b64 === 64);

// Replay roundtrip with several runs.
const runs = Array.from({ length: 4 }, () => {
  const a = new Uint8Array(1800);
  for (let t = 0; t < 1800;) { const n = 1 + rng.int(200); a.fill(rng.int(32), t, t + n); t += n; }
  return a;
});
const str = encodeReplay({ kind: LK_CAMPAIGN, ref: 7 }, runs);
const dec = decodeReplay(str);
check('Replay: Level-Referenz', dec.kind === LK_CAMPAIGN && dec.ref === 7);
check('Replay: Läufe bit-identisch', dec.runs.length === 4 && runs.every((r, k) => r.every((v, i) => v === dec.runs[k][i])));

// Corruption is detected.
let detected = 0;
for (let k = 0; k < 200; k++) {
  const body = str.slice(4).split('');
  const pos = rng.int(body.length);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let c;
  do { c = alphabet[rng.int(64)]; } while (c === body[pos]);
  body[pos] = c;
  try { decodeReplay('MF1.' + body.join('')); } catch { detected++; }
}
console.log(`  Korruption erkannt: ${detected}/200 (1-Byte-Prüfsumme: Restrisiko ≈ 1/256 je Fehler)`);
check('Replay: ≥ 97 % der Einzelzeichen-Fehler erkannt', detected >= 194, `${detected}/200`);
check('Replay: falsches Präfix abgelehnt', (() => { try { decodeReplay('XX1.AAAA'); return false; } catch { return true; } })());

// Bot solutions: decode and fully reconstruct (canonical traces → win).
try {
  const sols = JSON.parse(readFileSync(new URL('./solutions.json', import.meta.url)));
  let n = 0, lens = [];
  for (const [i, def] of CAMPAIGN.entries()) {
    const s = sols[def.id];
    if (!s) continue;
    const { runs: rr, ref } = decodeReplay(s);
    const v = verifySolution(def, rr);
    check(`Bot-Replay ${def.id}: rekonstruiert & gewonnen`, v.ok && ref === i);
    lens.push(s.length);
    n++;
  }
  console.log(`  ${n} Bot-Replays rekonstruiert; String-Länge ${Math.min(...lens)}–${Math.max(...lens)} Zeichen`);
} catch (e) {
  console.log('  (keine solutions.json — Solver-Test zuerst ausführen)', e.message);
}
summary('Replay');
