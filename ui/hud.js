// MIRRORFALL — in-game HUD (DOM overlay). Updates only on change.

import { h, glyph, clear } from './dom.js';
import { GHOST_SHAPES, GHOST_NAMES, rgbCss, palette } from '../render/palette.js';
import { LOOP_TICKS, MAX_GHOSTS } from '../sim/constants.js';
import { G_TICK } from '../sim/world.js';

const HINTS = {
  keyboard: [['WASD/Pfeile', 'bewegen'], ['Leertaste', 'Aktion'], ['Q', 'jetzt zurückspulen'], ['⌫', 'Schleife rückgängig'], ['R', 'Neustart'], ['Shift', 'Zeitraffer'], ['Esc', 'Pause']],
  gamepad: [['Stick/D-Pad', 'bewegen'], ['A', 'Aktion'], ['X', 'zurückspulen'], ['Y', 'rückgängig'], ['RB', 'Zeitraffer'], ['Start', 'Pause']],
  touch: [['Stick', 'bewegen'], ['●', 'Aktion'], ['⟲', 'zurückspulen'], ['↶', 'rückgängig']],
};

export class Hud {
  constructor(root, settings) {
    this.settings = settings;
    this.el = h('div.hud', { 'aria-live': 'off' });
    this.lvl = h('div.hud-level');
    this.fill = h('div.fill');
    this.parMark = h('div.mark.par', { title: 'Par' });
    this.rivalMark = h('div.mark.rival', { title: 'Rivale' });
    this.timeText = h('div.timetext', '0.00 s');
    this.slots = h('div.hud-ghosts', { role: 'list', 'aria-label': 'Geister' });
    this.stats = h('div.hud-stats');
    this.bannerBig = h('div.big');
    this.bannerSub = h('div.sub');
    this.bannerEl = h('div.hud-banner', { role: 'status', 'aria-live': 'assertive' }, this.bannerBig, this.bannerSub);
    this.ready = h('div.hud-ready', 'Bewegen, um die Schleife zu starten');
    this.hints = h('div.hud-hints');
    this.el.append(
      h('div.hud-top', this.lvl, h('div.hud-time', h('div.timebar', this.fill, this.parMark, this.rivalMark), this.timeText), this.slots, this.stats),
      this.bannerEl, this.ready, this.hints,
    );
    root.appendChild(this.el);
    this.cache = {};
    this.setDevice('keyboard');
  }
  show(v) { this.el.classList.toggle('visible', v); }
  setDevice(d) {
    this.device = d;
    this.el.classList.toggle('touchmode', d === 'touch');
    clear(this.hints);
    for (const [k, t] of HINTS[d] || HINTS.keyboard) this.hints.append(h('span.hint', h('kbd', k), ' ', t));
  }
  setLevel(def, L) {
    clear(this.lvl);
    const num = def.id && /^c\d+$/.test(def.id) ? def.id.slice(1) : '';
    this.lvl.append(num ? h('span.num', num) : null, h('span.name', def.name || 'Level'));
    this.par = def.par || 0;
    this.parMark.style.display = this.par ? '' : 'none';
    this.parMark.style.left = `${(this.par / LOOP_TICKS) * 100}%`;
    this.cache = {};
    this.pal = palette(!!this.settings.colorblind);
  }
  loopStart(ghosts, first) {
    this.cache.ghosts = -1;
    this.ready.classList.add('visible');
    if (first) this.bannerEl.classList.remove('visible');
  }
  banner(big, sub = '', kind = 'info') {
    this.bannerBig.textContent = big;
    this.bannerSub.textContent = sub;
    this.bannerEl.className = `hud-banner visible ${kind}`;
  }
  clearBanner() { this.bannerEl.classList.remove('visible'); }
  update(session) {
    const s = session.world.s;
    const c = this.cache;
    const tick = session.state === 'rewind' ? Math.round(session.endTick * (1 - Math.min(1, session.stateT / session.rewindDur))) : s[G_TICK];
    if (c.tick !== tick) {
      c.tick = tick;
      this.fill.style.transform = `scaleX(${tick / LOOP_TICKS})`;
      this.timeText.textContent = `${(tick / 60).toFixed(2)} s`;
      this.fill.classList.toggle('late', tick > LOOP_TICKS - 300);
    }
    if (c.state !== session.state) {
      c.state = session.state;
      this.ready.classList.toggle('visible', session.state === 'ready');
      this.el.classList.toggle('rewinding', session.state === 'rewind');
    }
    const ghosts = session.timeline.ghostCount;
    if (c.ghosts !== ghosts) {
      c.ghosts = ghosts;
      clear(this.slots);
      for (let i = 0; i <= MAX_GHOSTS; i++) {
        const col = rgbCss(this.pal.ghost[i]);
        const st = i < ghosts ? 'rec' : i === ghosts ? 'live' : 'empty';
        const label = st === 'rec' ? `Geist ${i + 1} (${GHOST_NAMES[i]})` : st === 'live' ? `Aktueller Läufer (${GHOST_NAMES[i]})` : 'frei';
        this.slots.append(h(`div.slot.${st}`, { role: 'listitem', 'aria-label': label, title: label }, glyph(GHOST_SHAPES[i], col, 20, st !== 'empty')));
      }
    }
    const st = `🚨 ${session.stats.alarms}  ⧖ ${session.stats.paradoxes}${session.input.fastForward() ? '  »' : ''}`;
    if (c.stats !== st) { c.stats = st; this.stats.textContent = st; }
    const rv = session.rival && session.rival.finishTick;
    if (c.rival !== rv) {
      c.rival = rv;
      this.rivalMark.style.display = rv ? '' : 'none';
      if (rv) this.rivalMark.style.left = `${(rv / LOOP_TICKS) * 100}%`;
    }
  }
  destroy() { this.el.remove(); }
}
