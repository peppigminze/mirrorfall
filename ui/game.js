// MIRRORFALL — game session controller.
// Owns one level attempt: the timeline, the current loop's world, the live
// runner's recording, loop transitions (rewind / alarm / paradox / escape),
// the visual history used for the rewind effect and the mapping from sim
// events to sound, particles and screen shake.

import { compileLevel } from '../sim/level.js';
import { Timeline, rebuildCanon } from '../sim/timeline.js';
import { createWorld, step, sigOf, G_STATUS, G_STATUS_ARG, G_FAIL, G_TICK, G_NRUN, R_SIZE, R_PX, R_PY, R_SUSP } from '../sim/world.js';
import {
  LOOP_TICKS, TICK_HZ, SU, TILE_PX, ST_RUNNING, ST_WON, ST_CAUGHT, ST_PARADOX, ST_TIMEOUT, MAX_GHOSTS, ALARM_TICKS,
  EV_DOOR_OPEN, EV_DOOR_CLOSE, EV_PLATE_ON, EV_PLATE_OFF, EV_SWITCH, EV_COIN_PICK, EV_COIN_THROW, EV_COIN_LAND,
  EV_GUARD_HEAR, EV_LOOT_PICK, EV_VAULT_OPEN, EV_CAUGHT, EV_PARADOX, EV_WIN, EV_STEP, EV_LASER_ON, EV_PLATFORM_GO,
  EV_SPOTTED, EV_BUMP, GRID_W, FAIL_GUARD, FAIL_CAMERA, FAIL_LASER, FAIL_FELL, FAIL_DIVERGED,
} from '../sim/constants.js';
import { ViewBuilder } from '../render/view.js';
import { palette } from '../render/palette.js';

const STEP_S = 1 / TICK_HZ;
const FAIL_TEXT = {
  [FAIL_GUARD]: 'von einer Wache entdeckt', [FAIL_CAMERA]: 'von einer Kamera erfasst', [FAIL_LASER]: 'Laser ausgelöst',
  [FAIL_FELL]: 'in den Abgrund gestürzt', [FAIL_DIVERGED]: 'Vergangenheit verändert',
};

export class GameSession {
  /**
   * @param o.def        level definition
   * @param o.renderer   renderer instance
   * @param o.audio      audio engine (or stub)
   * @param o.input      Input
   * @param o.hud        HUD
   * @param o.settings   settings object
   * @param o.rival      optional { runs: Uint8Array[], name } for ghost races
   * @param o.onEvent    callback(type, payload) for the app (win, pause, exit)
   */
  constructor(o) {
    Object.assign(this, o);
    this.L = compileLevel(o.def);
    this.timeline = new Timeline(this.L);
    this.ctx = this.timeline.ctx;
    this.view = new ViewBuilder(this.L, this.ctx);
    this.size = this.ctx.lay.size;
    this.history = new Int32Array(this.size * (LOOP_TICKS + 1));
    this.liveInputs = new Uint8Array(LOOP_TICKS);
    this.liveSig = new Uint32Array(LOOP_TICKS);
    this.inputsBuf = new Uint8Array(5);
    this.acc = 0;
    this.stats = { alarms: 0, paradoxes: 0, loops: 0, log: [] };
    this.fx = { trauma: 0, flash: 0, flashColor: '255,40,60', glitch: 0, rewind: 0, chroma: 0, paradoxRunner: -1, banner: null };
    this.pal = palette(!!this.settings.colorblind);
    this.renderer.setLevel(this.L, this.ctx, this.pal);
    if (!o.attract) { this.audio.music?.setLevel(this.L.seed, this.L.id); this.hud.setLevel(this.def, this.L); }
    this.silent = !!o.attract;
    if (this.silent) this.audio = { sfx() {}, music: null };
    this.setupRival();
    this.startLoop(true);
  }

  // ------------------------------------------------------------------ loops
  startLoop(first = false) {
    this.world = this.timeline.createLoopWorld(true);
    this.prevS = this.world.s.slice();
    this.history.set(this.world.s, 0);
    this.liveInputs.fill(0);
    this.liveSig.fill(0);
    this.endTick = 0;
    this.state = 'ready';
    this.input.clearHeld();
    this.input.takeAnyPress();
    this.fx.paradoxRunner = -1;
    this.view.build(null, this.world.s, 1, 0, { snap: true });
    this.audio.music?.setGhosts(this.timeline.ghostCount);
    if (this.rival) this.resetRival();
    if (!this.attract) this.hud.loopStart(this.timeline.ghostCount, first);
    if (this.playback) this.state = 'play';
  }

  /** Live mask for this tick: player input, or the recording during playback. */
  liveMask() {
    if (!this.playback) return this.input.mask();
    const run = this.playback.runs[this.timeline.ghostCount];
    return run ? run[this.world.s[G_TICK]] : 0;
  }

  /** Advance the current loop by one tick with the given live mask. */
  tickOnce(mask, quiet = false) {
    const w = this.world, s = w.s;
    const t = s[G_TICK];
    const n = s[G_NRUN], live = n - 1;
    this.liveInputs[t] = mask;
    const buf = this.inputsBuf;
    for (let j = 0; j < live; j++) buf[j] = this.timeline.ghostInput(j, t);
    buf[live] = mask;
    this.prevS.set(s);
    w.recordEvents = !quiet;
    step(w, buf);
    this.liveSig[t] = sigOf(w, live);
    this.history.set(s, (t + 1) * this.size);
    this.endTick = t + 1;
    if (!quiet) this.handleEvents(w.events, live);
    if (this.rival) this.stepRival();
    return s[G_STATUS];
  }

  finishLoop(st) {
    const s = this.world.s;
    const arg = s[G_STATUS_ARG];
    if (st === ST_WON) return this.win();
    if (st === ST_CAUGHT) {
      this.stats.alarms++;
      this.stats.log.push('alarm');
      this.state = 'caught';
      this.stateT = 0;
      this.fx.flash = 1; this.fx.flashColor = '255,30,50'; this.fx.trauma = Math.min(1, this.fx.trauma + 0.7);
      this.hud.banner('ALARM', FAIL_TEXT[s[G_FAIL]] || '', 'alarm');
      this.audio.sfx('alarm');
      return;
    }
    if (st === ST_PARADOX) {
      this.stats.paradoxes++;
      this.stats.log.push('paradox');
      this.state = 'paradox';
      this.stateT = 0;
      this.fx.paradoxRunner = arg;
      this.fx.glitch = 1; this.fx.trauma = Math.min(1, this.fx.trauma + 0.9);
      this.paradoxGhost = arg;
      this.hud.banner('ZEITPARADOX', `Geist ${arg + 1}: ${FAIL_TEXT[s[G_FAIL]] || 'Zeitlinie gebrochen'} — Zeitlinie bricht ab Geist ${arg + 1}`, 'paradox');
      this.audio.sfx('paradox');
      return;
    }
    if (st === ST_TIMEOUT) {
      const committed = this.timeline.commit(this.liveInputs.slice(), this.liveSig.slice());
      this.stats.log.push(committed ? 'ghost' : 'full');
      if (!committed) this.hud.banner('ZEITLINIE VOLL', `Maximal ${MAX_GHOSTS} Geister — ⌫ macht die letzte Schleife rückgängig`, 'info');
      this.beginRewind();
    }
  }

  /** Skip the rest of the loop: simulate the remaining ticks with idle input. */
  rewindNow() {
    if (this.state !== 'play' && this.state !== 'ready') return;
    let st = this.world.s[G_STATUS];
    while (st === ST_RUNNING) st = this.tickOnce(0, true);
    this.finishLoop(st);
  }

  beginRewind() {
    this.state = 'rewind';
    this.stateT = 0;
    this.rewindDur = this.settings.reducedMotion ? 0.45 : 1.25;
    this.audio.sfx('rewind');
    this.audio.music?.setRewind(true);
    this.stats.loops++;
  }

  win() {
    this.state = 'won';
    this.stateT = 0;
    const s = this.world.s;
    const tick = s[G_TICK];
    this.stats.log.push('win');
    const runs = [...this.timeline.runs.map((r) => r.inputs), this.liveInputs.slice()];
    const lengths = runs.map((_, k) => (k === runs.length - 1 ? tick : LOOP_TICKS));
    // Independent verification of the timeline before awarding anything.
    const verified = rebuildCanon(this.ctx, runs.map((r, k) => (k === runs.length - 1 ? r.slice(0, LOOP_TICKS) : r)));
    const par = this.def.par || 0;
    const stars = 1 + (par > 0 && tick <= par ? 1 : 0) + (this.stats.alarms === 0 ? 1 : 0);
    this.result = {
      tick, ghosts: this.timeline.ghostCount, alarms: this.stats.alarms, paradoxes: this.stats.paradoxes,
      loops: this.stats.loops + 1, stars, par, runs, lengths, log: this.stats.log.slice(), verified: verified.ok,
      starFlags: [true, par > 0 && tick <= par, this.stats.alarms === 0],
    };
    this.fx.flash = 0.8; this.fx.flashColor = '120,255,190';
    this.audio.sfx('win');
    this.audio.music?.setWin();
    if (!this.attract) this.hud.banner(this.playback ? 'WIEDERGABE ENDE' : 'FLUCHT GELUNGEN', `${(tick / 60).toFixed(2)} s`, 'win');
    const r = v => this.view.build(null, this.world.s, 1, 0).runners[v];
    const lr = r(s[G_STATUS_ARG]);
    if (lr) this.renderer.spawn('burst', lr.x, lr.y, [0.4, 1, 0.7], 60);
  }

  // ----------------------------------------------------------------- update
  update(dt) {
    dt = Math.min(dt, 0.25);
    if (!this.attract) for (const c of this.input.takeCommands()) this.command(c);
    const fx = this.fx;
    fx.trauma = Math.max(0, fx.trauma - dt * 1.4);
    fx.flash = Math.max(0, fx.flash - dt * 2.2);
    fx.glitch = Math.max(0, fx.glitch - dt * 0.9);

    switch (this.state) {
      case 'ready':
        if (this.input.takeAnyPress()) { this.state = 'play'; this.acc = 0; this.hud.clearBanner(); }
        break;
      case 'play': {
        const speed = this.playback ? (this.attract ? 1 : (this.input.fastForward() ? 4 : 1.5)) : (this.input.fastForward() ? 4 : 1);
        this.acc += dt * speed;
        let steps = 0;
        while (this.acc >= STEP_S && steps < 16) {
          this.acc -= STEP_S;
          steps++;
          const st = this.tickOnce(this.liveMask());
          if (st !== ST_RUNNING) { this.acc = 0; this.finishLoop(st); break; }
        }
        this.updateTension();
        break;
      }
      case 'caught':
      case 'paradox':
        this.stateT += dt;
        if (this.stateT > (this.state === 'paradox' ? 1.6 : 1.0) * (this.settings.reducedMotion ? 0.6 : 1)) {
          if (this.state === 'paradox') this.timeline.collapse(this.paradoxGhost);
          this.beginRewind();
        }
        break;
      case 'rewind':
        this.stateT += dt;
        if (this.stateT >= this.rewindDur) {
          this.audio.music?.setRewind(false);
          if (!this.attract) this.hud.clearBanner();
          this.startLoop();
        }
        break;
      case 'won':
        this.stateT += dt;
        if (this.playback) {
          if (this.stateT > 2.2) {
            if (this.attract) { this.timeline.runs = []; this.timeline.history = []; this.stats = { alarms: 0, paradoxes: 0, loops: 0, log: [] }; this.beginRewind(); }
            else if (!this.resultShown) { this.resultShown = true; this.onEvent('playbackDone', this.result); }
          }
        } else if (this.stateT > 1.4 && !this.resultShown) { this.resultShown = true; this.onEvent('win', this.result); }
        break;
      default: break;
    }
    if (!this.attract) this.hud.update(this);
  }

  command(c) {
    if (c === 'pause') { if (this.state !== 'won') this.onEvent('pause'); return; }
    if (c === 'ffToggle') { this.input.ffLatched = !this.input.ffLatched; return; }
    if (this.state === 'won' || this.playback) return;
    if (c === 'rewind') this.rewindNow();
    else if (c === 'undo') {
      if (this.timeline.undo()) { this.hud.banner('RÜCKGÄNGIG', 'Zeitlinie wiederhergestellt', 'info'); this.audio.sfx('undo'); this.beginRewind(); }
    } else if (c === 'restart') {
      this.timeline.reset(); this.stats = { alarms: 0, paradoxes: 0, loops: 0, log: [] };
      this.hud.banner('NEUSTART', 'Alle Geister gelöscht (⌫ stellt sie wieder her)', 'info');
      this.beginRewind();
    }
  }

  updateTension() {
    // Tension = suspicion of the live runner + proximity to guard cones.
    const s = this.world.s, lay = this.ctx.lay, live = s[G_NRUN] - 1;
    const b = lay.R + live * R_SIZE;
    const rx = s[b + R_PX], ry = s[b + R_PY];
    let near = 0;
    for (let g = 0; g < this.L.guards.length; g++) {
      const gb = lay.GD + g * 12;
      const d = Math.hypot(s[gb] - rx, s[gb + 1] - ry) / SU;
      near = Math.max(near, 1 - Math.min(1, Math.max(0, (d - 2) / 7)));
    }
    for (const C of this.L.cameras) {
      const d = Math.hypot(C.x * SU - rx, C.y * SU - ry) / SU;
      near = Math.max(near, 0.8 * (1 - Math.min(1, Math.max(0, (d - 3) / 7))));
    }
    const susp = s[b + R_SUSP] / ALARM_TICKS;
    this.tension = Math.min(1, Math.max(near * 0.7, susp * 1.2));
    this.audio.music?.setTension(this.tension);
  }

  // ------------------------------------------------------------------ events
  handleEvents(ev, live) {
    const L = this.L, R = this.renderer, A = this.audio, pal = this.pal;
    const cxy = (c) => [(c % GRID_W + 0.5) * TILE_PX, (Math.floor(c / GRID_W) + 0.5) * TILE_PX];
    const runnerXY = (i) => {
      const b = this.ctx.lay.R + i * R_SIZE, s = this.world.s;
      return [(s[b + R_PX] + SU / 2) * TILE_PX / SU, (s[b + R_PY] + SU / 2) * TILE_PX / SU];
    };
    for (let k = 0; k < ev.length; k += 3) {
      const type = ev[k], a = ev[k + 1], b = ev[k + 2];
      switch (type) {
        case EV_DOOR_OPEN: case EV_DOOR_CLOSE: {
          const D = L.doors[a];
          A.sfx(type === EV_DOOR_OPEN ? 'doorOpen' : 'doorClose', { x: D.x });
          R.spawn('spark', (D.x + 0.5) * TILE_PX, (D.y + 0.5) * TILE_PX, pal.channel[D.ch], 8);
          break;
        }
        case EV_PLATE_ON: { const P = L.plates[a]; A.sfx('plate', { x: P.x }); R.spawn('ring', (P.x + 0.5) * TILE_PX, (P.y + 0.5) * TILE_PX, pal.channel[P.ch], 10); break; }
        case EV_PLATE_OFF: A.sfx('plateOff', { x: L.plates[a].x }); break;
        case EV_SWITCH: { const S = L.switches[a]; A.sfx('switch', { x: S.x }); R.spawn('spark', (S.x + 0.5) * TILE_PX, (S.y + 0.5) * TILE_PX, pal.channel[S.ch], 14); break; }
        case EV_COIN_PICK: { const [x, y] = runnerXY(a); A.sfx('coin', { ghost: a !== live }); R.spawn('spark', x, y, pal.coin, 12); break; }
        case EV_COIN_THROW: A.sfx('throw', { ghost: a !== live }); break;
        case EV_COIN_LAND: { const [x, y] = cxy(a); A.sfx('coinLand'); R.spawn('ring', x, y, pal.coin, 16); this.fx.trauma = Math.min(1, this.fx.trauma + 0.08); break; }
        case EV_GUARD_HEAR: A.sfx('hear'); break;
        case EV_LOOT_PICK: { const [x, y] = runnerXY(a); A.sfx('loot'); R.spawn('burst', x, y, pal.loot, 40); this.fx.trauma = Math.min(1, this.fx.trauma + 0.25); break; }
        case EV_VAULT_OPEN: A.sfx('vault'); this.fx.trauma = Math.min(1, this.fx.trauma + 0.45);
          for (const c of L.vaultCells) { const [x, y] = cxy(c); R.spawn('burst', x, y, [0.5, 0.85, 1], 36); }
          break;
        case EV_CAUGHT: { const [x, y] = runnerXY(a); R.spawn('burst', x, y, pal.alarm, 40); break; }
        case EV_PARADOX: { const [x, y] = runnerXY(a); R.spawn('glitch', x, y, pal.ghost[a], 60); break; }
        case EV_STEP: if (a === live) A.sfx('step', { soft: true }); break;
        case EV_LASER_ON: if ((this.world.s[G_TICK] & 1) === 0) A.sfx('laser', { quiet: true }); break;
        case EV_PLATFORM_GO: A.sfx('platform'); break;
        case EV_SPOTTED: if (a === live) A.sfx('spotted'); break;
        case EV_BUMP: if (a === live) A.sfx('bump'); break;
        case EV_WIN: break;
        default: break;
      }
    }
  }

  // ----------------------------------------------------------------- rival
  setupRival() {
    if (!this.rival) return;
    const rb = rebuildCanon(this.ctx, this.rival.runs);
    if (!rb.ok) { this.rival = null; return; }
    this.rival.canon = rb.canon;
    const last = rb.results[rb.results.length - 1];
    this.rival.finishTick = last.tick;
  }
  resetRival() {
    const R = this.rival;
    R.world = createWorld(this.ctx, R.runs.length, R.canon.slice(0, R.runs.length - 1), false);
    R.buf = new Uint8Array(R.runs.length);
    R.prev = R.world.s.slice();
  }
  stepRival() {
    const R = this.rival, s = R.world.s;
    if (s[G_STATUS] !== ST_RUNNING) return;
    const t = s[G_TICK];
    for (let j = 0; j < R.runs.length; j++) R.buf[j] = R.runs[j][t];
    R.prev.set(s);
    step(R.world, R.buf);
  }

  // ----------------------------------------------------------------- render
  render(dt) {
    const fx = this.fx;
    let prev = this.prevS, cur = this.world.s, alpha = Math.min(1, this.acc / STEP_S);
    let trails = null;
    fx.rewind = 0;
    if (this.state === 'rewind') {
      // Play the visual history backwards (ease in/out), with trails of the "future".
      const u = Math.min(1, this.stateT / this.rewindDur);
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      const tf = (1 - e) * this.endTick;
      const t0 = Math.max(0, Math.floor(tf)), t1 = Math.min(this.endTick, t0 + 1);
      prev = this.history.subarray(t1 * this.size, (t1 + 1) * this.size);
      cur = this.history.subarray(t0 * this.size, (t0 + 1) * this.size);
      alpha = 1 - (tf - t0);
      fx.rewind = Math.sin(Math.PI * u) * 0.85 + 0.15;
      trails = [];
      const n = cur[G_NRUN], lay = this.ctx.lay;
      for (let k = 1; k <= 10; k++) {
        const tt = Math.min(this.endTick, t0 + k * 5);
        const hs = this.history.subarray(tt * this.size, (tt + 1) * this.size);
        for (let i = 0; i < n; i++) {
          const b = lay.R + i * R_SIZE;
          trails.push({ i, x: (hs[b + R_PX] + SU / 2) * TILE_PX / SU, y: (hs[b + R_PY] + SU / 2) * TILE_PX / SU, a: 1 - k / 11 });
        }
      }
      this.audio.music?.setRewindProgress?.(u);
    } else if (this.state !== 'play') alpha = 1;

    const v = this.view.build(prev, cur, alpha, dt, { ghostColors: this.pal.ghost });
    // Rival ghost (ghost race): drawn as hollow silhouettes.
    let rival = null;
    if (this.rival && this.rival.world && this.state !== 'rewind') {
      const R = this.rival, s = R.world.s, lay = this.ctx.lay;
      const i = R.runs.length - 1, b = lay.R + i * R_SIZE;
      const a = this.state === 'play' ? alpha : 1;
      const x = ((R.prev[b + R_PX] + (s[b + R_PX] - R.prev[b + R_PX]) * a) + SU / 2) * TILE_PX / SU;
      const y = ((R.prev[b + R_PY] + (s[b + R_PY] - R.prev[b + R_PY]) * a) + SU / 2) * TILE_PX / SU;
      rival = { x, y, done: s[G_STATUS] === ST_WON };
    }
    const liveR = v.runners.find((r) => r.live) || v.runners[0];
    if (liveR) {
      const k = this.cam && dt > 0 ? Math.min(1, dt * 6) : 1;
      this.cam = this.cam || { x: liveR.x, y: liveR.y };
      this.cam.x += (liveR.x - this.cam.x) * k; this.cam.y += (liveR.y - this.cam.y) * k;
    }
    const reduced = this.settings.reducedMotion;
    const shake = reduced || !this.settings.shake ? 0 : fx.trauma * fx.trauma;
    const t = v.time;
    const shakeX = shake * 9 * (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 91.7) * 0.4);
    const shakeY = shake * 9 * (Math.sin(t * 43.3 + 1.3) * 0.6 + Math.sin(t * 79.1 + 0.7) * 0.4);
    this.renderer.render(v, {
      state: cur, dt, trails, rival, shakeX, shakeY, cam: this.cam,
      rewind: fx.rewind, glitch: reduced ? fx.glitch * 0.3 : fx.glitch, flash: fx.flash, flashColor: fx.flashColor,
      paradoxRunner: fx.paradoxRunner, reducedMotion: reduced, colorblind: !!this.settings.colorblind,
      ready: this.state === 'ready', won: this.state === 'won' ? Math.min(1, this.stateT) : 0,
    });
  }

  destroy() {
    this.audio.music?.stop?.();
  }
}
