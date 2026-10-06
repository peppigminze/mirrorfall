// MIRRORFALL — synthesized sound effects (no samples).
// Each effect builds a short-lived node graph into the SFX bus. Positional
// effects pan by the tile x coordinate.

export class SFX {
  constructor(engine) {
    this.e = engine;
    this.ctx = engine.ctx;
  }
  get t() { return this.ctx.currentTime; }

  /** Output chain: (optional pan) → sfx bus. Tracks the voice count. */
  out(vol, x, dur) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = vol;
    let node = g;
    if (typeof x === 'number' && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-0.7, Math.min(0.7, (x / 29) * 1.4 - 0.7));
      g.connect(p);
      node = p;
    }
    node.connect(this.e.sfxBus);
    this.e.voices++;
    setTimeout(() => { this.e.voices--; try { node.disconnect(); } catch { /* gone */ } }, (dur + 0.2) * 1000);
    return g;
  }
  osc(type, f0, f1, t, dur, dest, curve = 'exp') {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) {
      if (curve === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      else o.frequency.linearRampToValueAtTime(f1, t + dur);
    }
    o.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
    return o;
  }
  noise(t, dur, dest, filterType = 'bandpass', f0 = 1000, f1 = f0, q = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.e.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = filterType; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    src.connect(f); f.connect(dest);
    src.start(t, Math.random(), dur + 0.05);
    return f;
  }
  envGain(dest, t, a, peak, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + decay);
    g.connect(dest);
    return g;
  }

  // ------------------------------------------------------------------ effects
  step() {
    const t = this.t, o = this.out(0.08, undefined, 0.06);
    this.noise(t, 0.04, this.envGain(o, t, 0.002, 1, 0.04), 'bandpass', 900 + Math.random() * 600, 300, 1.5);
  }
  bump() {
    const t = this.t, o = this.out(0.15, undefined, 0.12);
    this.osc('sine', 120, 60, t, 0.1, this.envGain(o, t, 0.003, 1, 0.1));
  }
  doorOpen({ x } = {}) {
    const t = this.t, o = this.out(0.22, x, 0.5);
    this.osc('sawtooth', 160, 320, t, 0.32, this.envGain(o, t, 0.02, 0.35, 0.32), 'lin');
    this.noise(t, 0.35, this.envGain(o, t, 0.02, 0.5, 0.35), 'bandpass', 2500, 5000, 3);
    this.osc('sine', 90, 50, t + 0.32, 0.1, this.envGain(o, t + 0.32, 0.003, 1, 0.12));
  }
  doorClose({ x } = {}) {
    const t = this.t, o = this.out(0.24, x, 0.5);
    this.osc('sawtooth', 300, 150, t, 0.25, this.envGain(o, t, 0.02, 0.3, 0.25), 'lin');
    this.osc('sine', 110, 38, t + 0.24, 0.18, this.envGain(o, t + 0.24, 0.002, 1, 0.2));
    this.noise(t + 0.24, 0.08, this.envGain(o, t + 0.24, 0.002, 0.6, 0.08), 'lowpass', 800);
  }
  plate({ x } = {}) {
    const t = this.t, o = this.out(0.2, x, 0.2);
    this.osc('sine', 1900, 950, t, 0.05, this.envGain(o, t, 0.001, 0.6, 0.06));
    this.osc('sine', 140, 70, t, 0.1, this.envGain(o, t, 0.002, 0.9, 0.12));
  }
  plateOff({ x } = {}) {
    const t = this.t, o = this.out(0.1, x, 0.12);
    this.osc('sine', 1300, 1500, t, 0.04, this.envGain(o, t, 0.001, 0.5, 0.05));
  }
  switch({ x } = {}) {
    const t = this.t, o = this.out(0.22, x, 0.3);
    this.osc('square', 700, 700, t, 0.03, this.envGain(o, t, 0.001, 0.3, 0.03));
    this.osc('square', 1050, 1050, t + 0.05, 0.03, this.envGain(o, t + 0.05, 0.001, 0.3, 0.03));
    this.noise(t, 0.2, this.envGain(o, t, 0.005, 0.25, 0.2), 'highpass', 3000, 6000, 0.7);
  }
  coin({ ghost } = {}) {
    const t = this.t, o = this.out(ghost ? 0.08 : 0.2, undefined, 0.5);
    this.osc('sine', 1568, 1568, t, 0.25, this.envGain(o, t, 0.002, 0.7, 0.25));
    this.osc('sine', 2093, 2093, t + 0.07, 0.35, this.envGain(o, t + 0.07, 0.002, 0.7, 0.35));
    this.osc('sine', 4186 * 1.01, 4186, t + 0.07, 0.15, this.envGain(o, t + 0.07, 0.002, 0.15, 0.15));
  }
  throw({ ghost } = {}) {
    const t = this.t, o = this.out(ghost ? 0.06 : 0.15, undefined, 0.3);
    this.noise(t, 0.25, this.envGain(o, t, 0.05, 0.8, 0.2), 'bandpass', 600, 3500, 4);
  }
  coinLand() {
    const t = this.t, o = this.out(0.18, undefined, 0.4);
    for (const [f, d] of [[2637, 0], [3520, 0.04], [2960, 0.09]]) this.osc('sine', f, f * 0.99, t + d, 0.12, this.envGain(o, t + d, 0.001, 0.5, 0.14));
    this.noise(t, 0.05, this.envGain(o, t, 0.001, 0.4, 0.05), 'highpass', 5000);
  }
  hear() {
    const t = this.t, o = this.out(0.12, undefined, 0.4);
    this.osc('triangle', 520, 780, t, 0.12, this.envGain(o, t, 0.01, 0.6, 0.14), 'lin');
    this.osc('triangle', 780, 1040, t + 0.16, 0.14, this.envGain(o, t + 0.16, 0.01, 0.6, 0.16), 'lin');
  }
  loot() {
    const t = this.t, o = this.out(0.22, undefined, 1.2);
    [0, 4, 7, 12, 16].forEach((st, i) => {
      const f = 659 * Math.pow(2, st / 12);
      this.osc('triangle', f, f, t + i * 0.06, 0.3, this.envGain(o, t + i * 0.06, 0.003, 0.6, 0.35));
    });
    this.noise(t, 0.8, this.envGain(o, t, 0.05, 0.25, 0.8), 'highpass', 6000, 9000, 0.5);
  }
  vault() {
    const t = this.t, o = this.out(0.3, undefined, 2);
    this.osc('sawtooth', 55, 40, t, 1.2, this.envGain(o, t, 0.05, 0.5, 1.2));
    for (const d of [0.1, 0.45, 0.8]) this.osc('square', 220, 180, t + d, 0.08, this.envGain(o, t + d, 0.002, 0.4, 0.15));
    this.noise(t + 0.2, 1.2, this.envGain(o, t + 0.2, 0.3, 0.5, 1.0), 'bandpass', 300, 2400, 1);
    this.osc('sine', 880, 880, t + 1.0, 0.6, this.envGain(o, t + 1.0, 0.01, 0.3, 0.6));
  }
  alarm() {
    const t = this.t, o = this.out(0.26, undefined, 1.2);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1100; f.Q.value = 1.2;
    f.connect(o);
    const g = this.envGain(f, t, 0.01, 0.9, 1.0);
    const os = this.ctx.createOscillator();
    os.type = 'square';
    for (let k = 0; k < 6; k++) os.frequency.setValueAtTime(k % 2 ? 660 : 880, t + k * 0.16);
    os.connect(g); os.start(t); os.stop(t + 1.05);
    this.osc('sawtooth', 70, 50, t, 0.6, this.envGain(o, t, 0.005, 0.6, 0.6));
  }
  paradox() {
    const t = this.t, o = this.out(0.28, undefined, 1.8);
    // stuttering glitch bursts with random pitch steps (sample & hold)
    const os = this.ctx.createOscillator();
    os.type = 'square';
    for (let k = 0; k < 18; k++) os.frequency.setValueAtTime(80 + Math.random() * 1600, t + k * 0.035);
    const g = this.ctx.createGain();
    for (let k = 0; k < 18; k++) g.gain.setValueAtTime(Math.random() < 0.65 ? 0.35 : 0, t + k * 0.035);
    g.gain.setValueAtTime(0, t + 0.65);
    os.connect(g); g.connect(o); os.start(t); os.stop(t + 0.7);
    // reverse whoosh into a low boom
    this.noise(t, 0.6, this.envGain(o, t, 0.55, 0.7, 0.05), 'bandpass', 300, 5000, 2);
    this.osc('sine', 90, 28, t + 0.6, 0.9, this.envGain(o, t + 0.6, 0.004, 1, 0.9));
    this.osc('sawtooth', 220, 233, t + 0.6, 0.8, this.envGain(o, t + 0.6, 0.01, 0.2, 0.8), 'lin');
  }
  rewind() {
    const t = this.t, o = this.out(0.3, undefined, 1.5);
    const dur = this.e.settings.reducedMotion ? 0.45 : 1.25;
    this.noise(t, dur, this.envGain(o, t, 0.08, 0.6, dur), 'bandpass', 4200, 260, 3);
    const os = this.ctx.createOscillator();
    os.type = 'sawtooth';
    os.frequency.setValueAtTime(620, t);
    os.frequency.exponentialRampToValueAtTime(70, t + dur);
    const wob = this.ctx.createOscillator(), wg = this.ctx.createGain();
    wob.frequency.value = 9; wg.gain.value = 60;
    wob.connect(wg); wg.connect(os.detune);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 2200;
    os.connect(f); f.connect(this.envGain(o, t, 0.05, 0.25, dur));
    os.start(t); os.stop(t + dur + 0.05); wob.start(t); wob.stop(t + dur + 0.05);
  }
  undo() {
    const t = this.t, o = this.out(0.15, undefined, 0.3);
    this.osc('triangle', 900, 300, t, 0.2, this.envGain(o, t, 0.005, 0.6, 0.2));
  }
  win() {
    const t = this.t, o = this.out(0.25, undefined, 2.5);
    [0, 4, 7, 11, 14, 19].forEach((st, i) => {
      const f = 392 * Math.pow(2, st / 12);
      this.osc('triangle', f, f, t + i * 0.09, 1.2, this.envGain(o, t + i * 0.09, 0.01, 0.45, 1.3));
    });
    this.noise(t + 0.3, 1.5, this.envGain(o, t + 0.3, 0.4, 0.2, 1.2), 'highpass', 5000, 9000, 0.5);
  }
  laser({ quiet } = {}) {
    const t = this.t, o = this.out(quiet ? 0.035 : 0.08, undefined, 0.15);
    this.osc('sawtooth', 1400, 900, t, 0.08, this.envGain(o, t, 0.002, 0.6, 0.08));
  }
  platform() {
    const t = this.t, o = this.out(0.12, undefined, 0.6);
    this.osc('sine', 70, 74, t, 0.45, this.envGain(o, t, 0.05, 0.8, 0.4), 'lin');
    this.osc('triangle', 140, 150, t, 0.45, this.envGain(o, t, 0.05, 0.2, 0.4), 'lin');
  }
  spotted() {
    const t = this.t, o = this.out(0.14, undefined, 0.5);
    for (const f of [466, 494, 523]) this.osc('sawtooth', f, f * 0.98, t, 0.25, this.envGain(o, t, 0.005, 0.25, 0.3));
  }
  ui() {
    const t = this.t, o = this.out(0.08, undefined, 0.1);
    this.osc('sine', 1200, 1500, t, 0.04, this.envGain(o, t, 0.002, 0.6, 0.05));
  }
}
