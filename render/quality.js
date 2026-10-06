// MIRRORFALL — automatic quality selection from measured frame times.
// Quality tiers only change uniforms and render-target sizes, never game logic.

export const TIERS = {
  low: { resScale: 0.7, maxDpr: 1, lightScale: 0.3, steps: 10, maxLights: 12, bloomLevels: 3, chroma: 0, grain: 0.016, particles: 0.5 },
  med: { resScale: 0.9, maxDpr: 1.5, lightScale: 0.45, steps: 18, maxLights: 18, bloomLevels: 4, chroma: 1, grain: 0.018, particles: 0.8 },
  high: { resScale: 1.0, maxDpr: 2, lightScale: 0.6, steps: 28, maxLights: 24, bloomLevels: 5, chroma: 1, grain: 0.02, particles: 1 },
};
const ORDER = ['low', 'med', 'high'];

export class QualityController {
  constructor(renderer, settings) {
    this.renderer = renderer;
    this.settings = settings;
    this.fps = 60;
    this.window = [];
    this.windowTime = 0;
    this.lowStreak = 0;
    this.changed = false;
    this.history = [];   // [{ t, level, fps }] for the perf report
    this.elapsed = 0;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.autoStart = renderer.kind === 'canvas2d' ? 'low' : coarse ? 'med' : 'high';
    this.setMode(settings.quality);
  }
  setMode(mode) {
    this.mode = mode;
    const lvl = mode === 'auto' ? (this.level || this.autoStart) : mode;
    this.apply(lvl);
  }
  apply(level) {
    if (this.level === level) return;
    this.level = level;
    this.tier = TIERS[level];
    this.renderer.setQuality?.(this.tier, level);
    this.changed = true;
  }
  resScale() { return this.tier ? this.tier.resScale : 1; }
  /** Feed one frame's dt. Returns true when a 2-second window completed. */
  sample(dt) {
    this.elapsed += dt;
    this.window.push(dt);
    this.windowTime += dt;
    if (this.windowTime < 2) return false;
    const sorted = this.window.slice().sort((a, b) => a - b);
    const avg = this.windowTime / this.window.length;
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    this.fps = 1 / avg;
    this.history.push({ t: +this.elapsed.toFixed(1), level: this.level, fps: +this.fps.toFixed(1), p90ms: +(p90 * 1000).toFixed(1) });
    if (this.history.length > 120) this.history.shift();
    this.window = [];
    this.windowTime = 0;
    if (this.mode === 'auto' && !document.hidden) {
      // Step down after two consecutive slow windows (avg < 50 FPS or 90th percentile > 24 ms).
      if (this.fps < 50 || p90 > 0.024) this.lowStreak++; else this.lowStreak = 0;
      const i = ORDER.indexOf(this.level);
      if (this.lowStreak >= 2 && i > 0) { this.apply(ORDER[i - 1]); this.lowStreak = 0; }
    }
    return true;
  }
}
