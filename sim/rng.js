// MIRRORFALL — deterministic, seedable integer RNG and hashing.
// The simulation rules themselves need no randomness; this RNG is used by the
// daily-room generator, the music generator and the fuzz tests. Everything is
// pure 32-bit integer arithmetic (Math.imul), so results are bit-identical on
// every JS engine.

/** SplitMix32-style generator. State is a single uint32. */
export class Rng {
  constructor(seed) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  /** Next uint32. */
  nextU32() {
    let z = (this.s = (this.s + 0x9e3779b9) >>> 0);
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  }
  /** Integer in [0, n). Uses rejection-free multiply-shift (n < 2^16 keeps it exact). */
  int(n) {
    if (n <= 0) return 0;
    // 32x16 → fits in a double exactly; floor division is deterministic.
    return Math.floor((this.nextU32() / 4294967296) * n);
  }
  /** Integer in [a, b]. */
  range(a, b) { return a + this.int(b - a + 1); }
  /** true with probability num/den. */
  chance(num, den) { return this.int(den) < num; }
  pick(arr) { return arr[this.int(arr.length)]; }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  /** Fork an independent stream. */
  fork(salt) { return new Rng(hash32(this.nextU32() ^ Math.imul(salt | 0, 0x27d4eb2f))); }
}

/** 32-bit integer avalanche hash. */
export function hash32(x) {
  x = x >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** FNV-1a over an Int32Array range (each int fed as 4 bytes). */
export function fnv1a(arr, start = 0, end = arr.length, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = start; i < end; i++) {
    const v = arr[i];
    h = Math.imul(h ^ (v & 0xff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 8) & 0xff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 16) & 0xff), 0x01000193);
    h = Math.imul(h ^ (v >>> 24), 0x01000193);
  }
  return h >>> 0;
}

/**
 * Fast 53-bit key for an Int32Array (two independent 32-bit lanes folded into
 * a safe integer). Used by the solver for duplicate detection.
 */
export function key53(arr, start = 0, end = arr.length) {
  let a = 0x811c9dc5 | 0, b = 0x2545f491 | 0;
  for (let i = start; i < end; i++) {
    const v = arr[i] | 0;
    a = Math.imul(a ^ v, 0x01000193);
    a ^= a >>> 15;
    b = Math.imul(b + v, 0x5bd1e995);
    b ^= b >>> 13;
  }
  a = hash32(a); b = hash32(b);
  return (a >>> 0) * 2097152 + (b >>> 11);   // 32 + 21 bits
}

/** Hash a string to uint32 (FNV-1a over UTF-16 code units). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  }
  return hash32(h);
}
