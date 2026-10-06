// MIRRORFALL — touch controls: dynamic virtual stick (left half of the
// screen), action button and small command buttons (right side).

import { IN_U, IN_D, IN_L, IN_R } from '../sim/constants.js';

export class TouchControls {
  constructor(root, input) {
    this.input = input;
    this.el = document.createElement('div');
    this.el.className = 'touch';
    this.el.innerHTML = `
      <div class="touch-zone" aria-hidden="true"></div>
      <div class="stick" aria-hidden="true"><div class="knob"></div></div>
      <button class="tbtn act" aria-label="Aktion">●</button>
      <div class="tcmds">
        <button class="tbtn small" data-cmd="rewind" aria-label="Jetzt zurückspulen">⟲</button>
        <button class="tbtn small" data-cmd="undo" aria-label="Letzte Schleife rückgängig">↶</button>
        <button class="tbtn small" data-cmd="ffToggle" aria-label="Zeitraffer">»</button>
        <button class="tbtn small" data-cmd="pause" aria-label="Pause">❚❚</button>
      </div>`;
    root.appendChild(this.el);
    this.zone = this.el.querySelector('.touch-zone');
    this.stick = this.el.querySelector('.stick');
    this.knob = this.el.querySelector('.knob');
    this.act = this.el.querySelector('.act');
    this.stickId = null;

    const opt = { passive: false };
    this.zone.addEventListener('touchstart', (e) => this.start(e), opt);
    this.zone.addEventListener('touchmove', (e) => this.move(e), opt);
    this.zone.addEventListener('touchend', (e) => this.end(e), opt);
    this.zone.addEventListener('touchcancel', (e) => this.end(e), opt);
    const press = (v) => (e) => { e.preventDefault(); input.touchAction = v; if (v) input.anyPress = true; input.setDevice('touch'); this.act.classList.toggle('on', v); };
    this.act.addEventListener('touchstart', press(true), opt);
    this.act.addEventListener('touchend', press(false), opt);
    this.act.addEventListener('touchcancel', press(false), opt);
    for (const b of this.el.querySelectorAll('[data-cmd]')) {
      b.addEventListener('touchstart', (e) => { e.preventDefault(); input.commands.push(b.dataset.cmd); }, opt);
      b.addEventListener('click', () => input.commands.push(b.dataset.cmd));
    }
  }
  show(v) { this.el.classList.toggle('visible', v); }
  start(e) {
    e.preventDefault();
    this.input.setDevice('touch');
    if (this.stickId !== null) return;
    const t = e.changedTouches[0];
    this.stickId = t.identifier;
    this.ox = t.clientX; this.oy = t.clientY;
    this.stick.style.left = `${this.ox}px`; this.stick.style.top = `${this.oy}px`;
    this.stick.classList.add('on');
    this.knob.style.transform = 'translate(-50%,-50%)';
  }
  move(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== this.stickId) continue;
      const dx = t.clientX - this.ox, dy = t.clientY - this.oy;
      const d = Math.hypot(dx, dy), max = 46;
      const k = d > max ? max / d : 1;
      this.knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
      let dir = 0;
      if (d > 16) dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? IN_L : IN_R) : (dy < 0 ? IN_U : IN_D);
      if (dir && dir !== this.input.touchDir) this.input.anyPress = true;
      this.input.touchDir = dir;
      // Follow the finger when pulled far (comfortable on small screens).
      if (d > max * 1.6) { this.ox = t.clientX - dx * (max * 1.6) / d; this.oy = t.clientY - dy * (max * 1.6) / d; this.stick.style.left = `${this.ox}px`; this.stick.style.top = `${this.oy}px`; }
    }
  }
  end(e) {
    for (const t of e.changedTouches) {
      if (t.identifier !== this.stickId) continue;
      this.stickId = null;
      this.input.touchDir = 0;
      this.stick.classList.remove('on');
    }
  }
}
