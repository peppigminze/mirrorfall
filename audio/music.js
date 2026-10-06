// MIRRORFALL — generative, adaptive music.
//
// Everything is derived from the level seed (seeded RNG): root note, mode,
// tempo, chord progression and all rhythm/melody patterns, so every level has
// its own recognisable loop. Layers react to the game:
//   base      bass + pad + hats + kick (always)
//   tension   filter opening, denser hats, heartbeat kick, tritone drone
//   ghosts    one extra voice per recorded ghost:
//             1 triangle arpeggio · 2 square plucks · 3 FM bell · 4 sine counter-melody
// Scheduling uses a 120 ms lookahead against AudioContext.currentTime.

import { Rng } from '../sim/rng.js';

const MODES = [
  [0, 2, 3, 5, 7, 8, 10],   // aeolian
  [0, 2, 3, 5, 7, 9, 10],   // dorian
  [0, 1, 3, 5, 7, 8, 10],   // phrygian
  [0, 2, 3, 5, 7, 8, 11],   // harmonic minor
];
const PROGRESSIONS = [[0, 5, 2, 6], [0, 3, 4, 0], [0, 6, 5, 6], [0, 5, 3, 4], [0, 2, 5, 4], [0, 3, 6, 4]];
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class Music {
  constructor(engine) {
    this.e = engine;
    this.ctx = engine.ctx;
    this.out = engine.musicBus;
    this.playing = false;
    this.ghosts = 0;
    this.tension = 0;
    this.tensionSm = 0;
    this.menu = true;
    this.rewinding = false;
    this.setLevel(0xC0FFEE, 'menu');
    // Continuous tension drone.
    const ctx = this.ctx;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 500;
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.out);
    this.droneOsc = [];
  }

  setLevel(seed, id) {
    const r = new Rng(seed ^ 0x5eed);
    this.id = id;
    this.root = 36 + r.int(12);                  // C2..B2
    this.mode = MODES[r.int(MODES.length)];
    this.tempo = 84 + r.int(29);                 // 84..112 BPM
    this.prog = PROGRESSIONS[r.int(PROGRESSIONS.length)];
    this.swing = r.int(3) * 0.04;
    const pat = (n, p) => Array.from({ length: n }, (_, i) => (i === 0 ? true : r.chance(p, 100)));
    this.bassPat = pat(16, 38);
    this.hatPat = Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 1 : r.chance(45, 100) ? 0.6 : 0));
    this.pluckPat = Array.from({ length: 16 }, () => r.chance(35, 100));
    this.bellPat = Array.from({ length: 16 }, (_, i) => (i % 4 === 2 || r.chance(12, 100)));
    this.arpShape = r.pick([[0, 1, 2, 1], [0, 2, 1, 2], [0, 1, 2, 3], [2, 1, 0, 1]]);
    this.melody = Array.from({ length: 16 }, () => r.pick([0, 1, 2, 3, 4, 2, 4, 6]));
    this.step = 0;
    if (this.ctx) this.nextTime = this.ctx.currentTime + 0.1;
    this.retuneDrone();
  }

  deg(d) { const o = Math.floor(d / 7); return this.mode[((d % 7) + 7) % 7] + 12 * o; }
  chordAt(bar) { return this.prog[bar % this.prog.length]; }

  start() { this.playing = true; this.menu = false; this.nextTime = this.ctx.currentTime + 0.08; this.retuneDrone(); }
  stop() { this.playing = false; this.droneGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2); }
  setMenu(on) { this.menu = on; if (on) this.playing = true; }
  setGhosts(n) { this.ghosts = n; }
  setTension(x) { this.tension = Math.max(0, Math.min(1, x)); }
  setWin() {
    const t = this.ctx.currentTime;
    const c = this.chordAt(Math.floor(this.step / 16));
    [0, 2, 4, 7].forEach((k, i) => this.padNote(this.root + 24 + this.deg(c + k), t + i * 0.08, 2.4, 0.06));
    this.playing = false;
    setTimeout(() => { this.playing = true; }, 2600);
  }
  setRewind(on) {
    const f = this.e.musicFilter.frequency, t = this.ctx.currentTime;
    this.rewinding = on;
    f.cancelScheduledValues(t);
    f.setValueAtTime(f.value, t);
    if (on) f.exponentialRampToValueAtTime(320, t + 0.25);
    else f.exponentialRampToValueAtTime(18000, t + 0.6);
  }
  setRewindProgress() {}

  retuneDrone() {
    if (!this.ctx || !this.droneFilter) return;
    for (const o of this.droneOsc) { try { o.stop(); } catch { /* already stopped */ } }
    this.droneOsc = [];
    for (const [m, det] of [[this.root + 12, -7], [this.root + 18, 6], [this.root + 24, 3]]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(m);
      o.detune.value = det;
      o.connect(this.droneFilter);
      o.start();
      this.droneOsc.push(o);
    }
  }

  tick(dt) {
    const ctx = this.ctx;
    this.tensionSm += (this.tension - this.tensionSm) * Math.min(1, dt * 3);
    const T = this.menu ? 0 : this.tensionSm;
    this.droneGain.gain.setTargetAtTime(this.playing && !this.menu ? T * T * 0.05 : 0, ctx.currentTime, 0.3);
    this.droneFilter.frequency.setTargetAtTime(300 + T * 1400, ctx.currentTime, 0.3);
    if (!this.playing) { this.nextTime = Math.max(this.nextTime || 0, ctx.currentTime + 0.05); return; }
    const stepDur = 60 / (this.tempo * (this.menu ? 0.85 : 1)) / 4;
    if (this.nextTime < ctx.currentTime - 0.3) this.nextTime = ctx.currentTime + 0.05;   // after a stall
    while (this.nextTime < ctx.currentTime + 0.12) {
      const s = this.step % 16;
      const swing = s % 2 === 1 ? this.swing * stepDur * 2 : 0;
      this.playStep(this.step, this.nextTime + swing, stepDur, T);
      this.step++;
      this.nextTime += stepDur;
    }
  }

  playStep(step, t, sd, T) {
    const s = step % 16, bar = Math.floor(step / 16);
    const c = this.chordAt(bar);
    const rw = this.rewinding;
    // Pad: new chord each bar.
    if (s === 0) [0, 2, 4].forEach((k) => this.padNote(this.root + 24 + this.deg(c + k), t, sd * 16 * 1.05, 0.035 + T * 0.01));
    if (rw) return;
    // Bass.
    if (this.bassPat[s]) this.bassNote(this.root + this.deg(c) + (s === 8 && this.bassPat[3] ? 7 : 0), t, sd * (s % 4 === 0 ? 2.2 : 1.2), 0.14);
    // Kick: 1 and 3; heartbeat double at high tension.
    if (!this.menu) {
      if (s === 0 || s === 8) this.kick(t, 0.32 + T * 0.25);
      if (T > 0.55 && (s === 2 || s === 10)) this.kick(t, 0.18 * T);
    }
    // Hats: 8ths, plus 16ths with tension.
    const h = this.hatPat[s];
    if (h && (s % 2 === 0 || T > 0.35)) this.hat(t, (s % 4 === 0 ? 0.05 : 0.03) * (0.6 + T) * h);
    if (this.menu) return;
    // Ghost voices.
    const g = this.ghosts;
    if (g >= 1) {
      const tone = this.arpShape[s % 4] * 2;
      this.arp(this.root + 48 + this.deg(c + tone), t, sd * 0.9, 0.035);
    }
    if (g >= 2 && this.pluckPat[s]) {
      const pent = [0, 2, 4, 7, 9][(s * 3 + bar) % 5];
      this.pluck(this.root + 36 + this.deg(c) + pent, t, 0.04);
    }
    if (g >= 3 && this.bellPat[s]) this.bell(this.root + 60 + this.deg(c + (s % 8 === 2 ? 4 : 2)), t, 0.03);
    if (g >= 4 && s % 4 === 0) this.lead(this.root + 48 + this.deg(c + this.melody[(bar * 4 + s / 4) % 16]), t, sd * 3.6, 0.03);
  }

  // ------------------------------------------------------------ instruments
  env(gain, t, a, d, sus, r, peak, dur) {
    const p = gain.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.setTargetAtTime(peak * sus, t + a, d / 3);
    p.setTargetAtTime(0, t + Math.max(a, dur), r / 3);
  }
  voice(type, freq, t, dur, endPad = 0.6) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    o.connect(g);
    o.start(t);
    o.stop(t + dur + endPad);
    return { o, g };
  }
  padNote(m, t, dur, vol) {
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 700 + this.tensionSm * 1600;
    f.Q.value = 0.8;
    const g = ctx.createGain();
    f.connect(g); g.connect(this.out);
    for (const det of [-9, 8]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + dur + 1.6);
    }
    this.env(g, t, 0.45, 1.0, 0.8, 1.2, vol, dur);
  }
  bassNote(m, t, dur, vol) {
    const { o, g } = this.voice('sawtooth', mtof(m), t, dur, 0.3);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(260 + this.tensionSm * 700, t);
    f.frequency.setTargetAtTime(140, t, 0.08);
    f.Q.value = 6;
    o.disconnect(); o.connect(f); f.connect(g); g.connect(this.out);
    this.env(g, t, 0.006, 0.2, 0.45, 0.12, vol, dur);
  }
  kick(t, vol) {
    const { o, g } = this.voice('sine', 130, t, 0.25, 0.1);
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    g.connect(this.out);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  }
  hat(t, vol) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.e.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 7600;
    const g = this.ctx.createGain();
    src.connect(f); f.connect(g); g.connect(this.out);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.045);
    src.start(t, Math.random() * 1.5, 0.06);
  }
  arp(m, t, dur, vol) {
    const { g } = this.voice('triangle', mtof(m), t, dur, 0.2);
    g.connect(this.out);
    this.env(g, t, 0.004, 0.08, 0.3, 0.08, vol, dur);
  }
  pluck(m, t, vol) {
    const { o, g } = this.voice('square', mtof(m), t, 0.18, 0.15);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2600, t);
    f.frequency.exponentialRampToValueAtTime(400, t + 0.16);
    o.disconnect(); o.connect(f); f.connect(g); g.connect(this.out);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.22);
  }
  bell(m, t, vol) {
    const ctx = this.ctx, f = mtof(m);
    const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain();
    car.type = 'sine'; mod.type = 'sine';
    car.frequency.value = f; mod.frequency.value = f * 3.51;
    mg.gain.setValueAtTime(f * 2.2, t);
    mg.gain.exponentialRampToValueAtTime(1, t + 1.0);
    mod.connect(mg); mg.connect(car.frequency);
    car.connect(g); g.connect(this.out);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 1.2);
    car.start(t); mod.start(t); car.stop(t + 1.3); mod.stop(t + 1.3);
  }
  lead(m, t, dur, vol) {
    const ctx = this.ctx;
    const { o, g } = this.voice('sine', mtof(m), t, dur, 0.4);
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 5.2; lg.gain.value = 9;
    lfo.connect(lg); lg.connect(o.detune);
    lfo.start(t + 0.15); lfo.stop(t + dur + 0.4);
    g.connect(this.out);
    this.env(g, t, 0.05, 0.3, 0.7, 0.3, vol, dur);
  }
}
