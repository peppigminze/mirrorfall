// MIRRORFALL — audio engine (pure WebAudio, everything synthesized).
//
//   SFX voices ─→ sfxBus ─┬────────────────────────────→ master ─→ limiter ─→ out
//                         ├─→ analyser (sidechain RMS) ┐      ↑
//                         └─→ reverb send ─→ convolver ─┼──────┘
//   music voices → musicBus → musicFilter → duck ───────┘ (duck gain driven by sidechain)
//
// The AudioContext is created on the first user gesture (autoplay policies).

import { Music } from './music.js';
import { SFX } from './sfx.js';

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.music = new MusicProxy(this);
    this.voices = 0;
    this.lastPlay = {};
  }

  /** Create the graph (on the first user gesture). `injected` = e.g. an OfflineAudioContext for tests. */
  unlock(injected) {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
      return;
    }
    let ctx = injected;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch { return; }
    }
    this.ctx = ctx;
    this.offline = !!injected;
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.master = g(1);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.sfxBus = g(1);
    this.sfxBus.connect(this.master);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.sfxBus.connect(this.analyser);
    this.scBuf = new Float32Array(this.analyser.fftSize);

    this.musicBus = g(1);
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 18000;
    this.musicFilter.Q.value = 0.7;
    this.duck = g(1);
    this.musicBus.connect(this.musicFilter);
    this.musicFilter.connect(this.duck);
    this.duck.connect(this.master);

    // Procedural reverb (stereo exponentially decaying noise).
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.6, 2.4);
    this.reverbOut = g(0.32);
    this.reverb.connect(this.reverbOut);
    this.reverbOut.connect(this.master);
    this.sfxSend = g(0.35);
    this.sfxBus.connect(this.sfxSend);
    this.sfxSend.connect(this.reverb);
    this.musicSend = g(0.4);
    this.musicFilter.connect(this.musicSend);
    this.musicSend.connect(this.reverb);

    this.noise = this.makeNoise(2);
    this.sfx_ = new SFX(this);
    this.musicImpl = new Music(this);
    this.setVolumes(this.settings);
    this.music.flush();
  }

  makeNoise(seconds) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  makeImpulse(seconds, decay) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        lp += ((Math.random() * 2 - 1) - lp) * (0.35 + 0.5 * (1 - t));   // darker tail
        d[i] = lp * Math.pow(1 - t, decay) * (i < 40 ? i / 40 : 1);
      }
    }
    return b;
  }

  setVolumes(s) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.master, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(s.sfx, t, 0.03);
    this.musicBus.gain.setTargetAtTime(s.music * 0.75, t, 0.03);
  }

  /** Play a named sound effect. Rate-limited per name; voice-limited globally. */
  sfx(name, opts = {}) {
    if (!this.ctx || !this.sfx_ || (this.ctx.state !== 'running' && !this.offline)) return;
    const now = this.ctx.currentTime;
    const minGap = { step: 0.09, laser: 0.08, bump: 0.2, plateOff: 0.05, coinLand: 0.05, spotted: 0.4 }[name] ?? 0.025;
    if (now - (this.lastPlay[name] || 0) < minGap) return;
    if (this.voices > 28 && !['alarm', 'paradox', 'win', 'rewind', 'loot', 'vault'].includes(name)) return;
    this.lastPlay[name] = now;
    const fn = this.sfx_[name];
    if (fn) fn.call(this.sfx_, opts);
  }

  /** Per-frame: sidechain envelope follower + music scheduling. */
  frame(dt) {
    if (!this.ctx) return;
    // Sidechain: RMS of the SFX bus drives the music duck gain.
    this.analyser.getFloatTimeDomainData(this.scBuf);
    let sum = 0;
    for (let i = 0; i < this.scBuf.length; i++) sum += this.scBuf[i] * this.scBuf[i];
    const rms = Math.sqrt(sum / this.scBuf.length);
    const target = 1 - Math.min(0.6, rms * 3.2);
    const t = this.ctx.currentTime;
    // fast attack, slow release
    const cur = this.duck.gain.value;
    this.duck.gain.setTargetAtTime(target, t, target < cur ? 0.012 : 0.25);
    this.musicImpl?.tick(dt);
  }
}

/** Buffers music calls until the context exists, then forwards them. */
class MusicProxy {
  constructor(engine) { this.e = engine; this.pending = {}; }
  impl() { return this.e.musicImpl; }
  call(name, ...args) {
    const m = this.impl();
    if (m) m[name](...args);
    else this.pending[name] = args;
  }
  flush() { const m = this.impl(); for (const [k, a] of Object.entries(this.pending)) m[k](...a); this.pending = {}; }
  setLevel(seed, id) { this.call('setLevel', seed, id); }
  setGhosts(n) { this.call('setGhosts', n); }
  setTension(x) { const m = this.impl(); if (m) m.setTension(x); }
  setRewind(on) { this.call('setRewind', on); }
  setRewindProgress(u) { const m = this.impl(); if (m) m.setRewindProgress(u); }
  setWin() { this.call('setWin'); }
  setMenu(on) { this.call('setMenu', on); }
  start() { this.call('start'); }
  stop() { this.call('stop'); }
}
