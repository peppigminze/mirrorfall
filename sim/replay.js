// MIRRORFALL — replay export / import.
// Replays contain ONLY run-length-encoded inputs plus a level reference.
// Everything else (ghost traces, outcome) is recomputed deterministically.
//
// Binary layout (then base64url, prefixed "MF1."):
//   u8 version | u8 levelKind | varint levelRef | u8 nRuns
//   per run: varint nEntries, entries: u8 (mask | len<<5) for len 1..7,
//            or u8 mask (len field 0) followed by varint len
//   u8 checksum (sum of all previous bytes * 31 mod 256 chain)

import { encodeRLE, decodeRLE } from './input.js';

export const REPLAY_PREFIX = 'MF1.';
export const LK_CAMPAIGN = 0, LK_DAILY = 1, LK_CUSTOM = 2;

function pushVarint(out, v) {
  v = v >>> 0;
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
}
function readVarint(buf, pos) {
  let v = 0, shift = 0, b;
  do {
    if (pos.i >= buf.length) throw new Error('Replay zu kurz');
    b = buf[pos.i++];
    v += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 35) throw new Error('Replay: varint zu lang');
  } while (b & 0x80);
  return v;
}
function checksum(bytes, n) {
  let c = 7;
  for (let i = 0; i < n; i++) c = (Math.imul(c, 31) + bytes[i]) & 0xff;
  return c;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function toBase64Url(bytes) {
  let s = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
  }
  return s;
}
export function fromBase64Url(str) {
  const clean = str.replace(/[^A-Za-z0-9\-_]/g, '');
  const out = [];
  let acc = 0, bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}

/**
 * Encode a replay.
 * @param ref   { kind: LK_*, ref: number }
 * @param runs  Uint8Array[] (expanded inputs); lengths[] optional (ticks used per run)
 */
export function encodeReplay(ref, runs, lengths = []) {
  const out = [1, ref.kind & 0xff];
  pushVarint(out, ref.ref);
  out.push(runs.length & 0xff);
  runs.forEach((inp, k) => {
    const rle = encodeRLE(inp, lengths[k] ?? inp.length);
    // Trailing idle is implicit (decoder pads with zeros).
    while (rle.length && rle[rle.length - 1][0] === 0) rle.pop();
    pushVarint(out, rle.length);
    for (const [m, n] of rle) {
      if (n <= 7) out.push(m | (n << 5));
      else { out.push(m); pushVarint(out, n); }
    }
  });
  out.push(checksum(out, out.length));
  return REPLAY_PREFIX + toBase64Url(Uint8Array.from(out));
}

/** Decode a replay string → { kind, ref, runs: Uint8Array[] }. Throws on corruption. */
export function decodeReplay(str) {
  const t = String(str).trim();
  if (!t.startsWith(REPLAY_PREFIX)) throw new Error('Kein MIRRORFALL-Replay (Präfix MF1. fehlt)');
  const buf = fromBase64Url(t.slice(REPLAY_PREFIX.length));
  if (buf.length < 5) throw new Error('Replay zu kurz');
  if (checksum(buf, buf.length - 1) !== buf[buf.length - 1]) throw new Error('Replay-Prüfsumme falsch');
  const pos = { i: 0 };
  const version = buf[pos.i++];
  if (version !== 1) throw new Error('Unbekannte Replay-Version ' + version);
  const kind = buf[pos.i++];
  const ref = readVarint(buf, pos);
  const nRuns = buf[pos.i++];
  if (nRuns < 1 || nRuns > 5) throw new Error('Replay: ungültige Laufanzahl');
  const runs = [];
  for (let k = 0; k < nRuns; k++) {
    const nEntries = readVarint(buf, pos);
    const pairs = [];
    for (let e = 0; e < nEntries; e++) {
      if (pos.i >= buf.length - 1) throw new Error('Replay abgeschnitten');
      const b = buf[pos.i++];
      const m = b & 31, n = b >> 5;
      pairs.push([m, n > 0 ? n : readVarint(buf, pos)]);
    }
    runs.push(decodeRLE(pairs));
  }
  if (pos.i !== buf.length - 1) throw new Error('Replay: überzählige Daten');
  return { kind, ref, runs };
}
