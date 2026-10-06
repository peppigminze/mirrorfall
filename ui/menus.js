// MIRRORFALL — menu screens with full keyboard (and gamepad) navigation.
// Arrow keys move focus spatially between focusable elements of the active
// screen, Enter/Space activate, Escape goes back. Range inputs keep their
// native left/right behaviour.

import { h, clear } from './dom.js';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class MenuSystem {
  constructor(root, input) {
    this.root = root;
    this.input = input;
    this.stack = [];
    this.layer = h('div.menus');
    root.appendChild(this.layer);
    this.onKey = (e) => this.key(e);
    window.addEventListener('keydown', this.onKey);
    input.navListeners.add((cmd) => this.nav(cmd));
  }
  get active() { return this.stack[this.stack.length - 1] || null; }

  /** Show a screen: { title, build(el, api), onBack, className, overlay } */
  push(screen) {
    const el = h(`section.screen${screen.className ? '.' + screen.className : ''}`, { role: 'dialog', 'aria-label': screen.title || 'Menü' });
    screen.el = el;
    if (this.active) this.active.el.classList.add('hidden');
    this.stack.push(screen);
    this.layer.appendChild(el);
    screen.build(el, this);
    this.layer.classList.toggle('overlay', !!screen.overlay);
    this.layer.classList.add('visible');
    requestAnimationFrame(() => this.focusFirst());
    return screen;
  }
  replace(screen) { this.popSilently(); return this.push(screen); }
  popSilently() {
    const s = this.stack.pop();
    if (s) { s.onClose?.(); s.el.remove(); }
  }
  pop() {
    this.popSilently();
    const a = this.active;
    if (a) {
      a.el.classList.remove('hidden');
      this.layer.classList.toggle('overlay', !!a.overlay);
      a.onShow?.();
      requestAnimationFrame(() => this.focusFirst(a.lastFocus));
    } else this.layer.classList.remove('visible');
  }
  clearAll() { while (this.stack.length) this.popSilently(); this.layer.classList.remove('visible'); }
  rebuild() {
    const a = this.active;
    if (!a) return;
    clear(a.el);
    a.build(a.el, this);
    requestAnimationFrame(() => this.focusFirst());
  }
  focusables() {
    const a = this.active;
    if (!a) return [];
    return [...a.el.querySelectorAll(FOCUSABLE)].filter((e) => e.offsetParent !== null);
  }
  focusFirst(pref) {
    const list = this.focusables();
    const target = (pref && list.includes(pref)) ? pref : (list.find((e) => e.hasAttribute('data-autofocus')) || list[0]);
    if (target) target.focus({ preventScroll: false });
  }
  key(e) {
    if (!this.active || this.suspended) return;
    const t = e.target;
    const typing = t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !/range|checkbox|radio/.test(t.type)));
    if (e.key === 'Escape') { e.preventDefault(); this.back(); return; }
    if (typing) return;
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    const dir = map[e.key];
    if (!dir) return;
    if (t && t.type === 'range' && (dir === 'left' || dir === 'right')) return;   // native slider
    if (t && t.tagName === 'SELECT') return;
    e.preventDefault();
    this.move(dir);
  }
  nav(cmd) {
    if (!this.active || this.suspended) return;
    if (cmd === 'back') return this.back();
    if (cmd === 'confirm') { const el = document.activeElement; if (el && this.active.el.contains(el)) el.click(); return; }
    const el = document.activeElement;
    if (el && el.type === 'range' && (cmd === 'left' || cmd === 'right')) {
      el.value = String(+el.value + (cmd === 'right' ? 1 : -1) * (+el.step || 1));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    this.move(cmd);
  }
  back() {
    const a = this.active;
    if (!a) return;
    if (a.onBack) a.onBack(); else if (this.stack.length > 1) this.pop();
  }
  /** Spatial navigation: nearest focusable in the requested direction. */
  move(dir) {
    const list = this.focusables();
    if (!list.length) return;
    const cur = document.activeElement;
    if (!list.includes(cur)) { list[0].focus(); return; }
    const r0 = cur.getBoundingClientRect();
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const dx = x - cx, dy = y - cy;
      let main, cross;
      if (dir === 'up') { main = -dy; cross = Math.abs(dx); }
      else if (dir === 'down') { main = dy; cross = Math.abs(dx); }
      else if (dir === 'left') { main = -dx; cross = Math.abs(dy); }
      else { main = dx; cross = Math.abs(dy); }
      if (main <= 4) continue;
      const score = main + cross * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (!best) {
      // Wrap around in list order for vertical lists.
      const i = list.indexOf(cur);
      if (dir === 'down') best = list[(i + 1) % list.length];
      else if (dir === 'up') best = list[(i - 1 + list.length) % list.length];
    }
    if (best) { best.focus(); this.active.lastFocus = best; this.onMove?.(); }
  }
}

/** Convenience builders. */
export function button(label, onClick, opts = {}) {
  const cls = (opts.cls || '').split(/[\s.]+/).filter(Boolean).map((c) => '.' + c).join('');
  return h(`button.btn${cls}`, { type: 'button', onclick: onClick, 'data-autofocus': opts.autofocus || null, 'aria-label': opts.aria || null, disabled: opts.disabled || null, title: opts.title || null }, label);
}

export function slider(label, value, onInput, opts = {}) {
  const id = 'sl-' + Math.random().toString(36).slice(2, 8);
  const out = h('output', { for: id }, Math.round(value * 100) + '%');
  const inp = h('input', { id, type: 'range', min: 0, max: 100, step: 5, value: Math.round(value * 100), 'aria-label': label });
  inp.addEventListener('input', () => { out.textContent = inp.value + '%'; onInput(+inp.value / 100); });
  void opts;
  return h('label.row', { for: id }, h('span.lab', label), inp, out);
}

export function toggle(label, value, onChange, hint = '') {
  const id = 'tg-' + Math.random().toString(36).slice(2, 8);
  const inp = h('input', { id, type: 'checkbox', role: 'switch', checked: value || null, 'aria-label': label });
  inp.addEventListener('change', () => onChange(inp.checked));
  return h('label.row.toggle', { for: id }, h('span.lab', label, hint ? h('small', hint) : null), inp, h('span.sw', { 'aria-hidden': 'true' }));
}

export function select(label, value, options, onChange) {
  const id = 'se-' + Math.random().toString(36).slice(2, 8);
  const sel = h('select', { id, 'aria-label': label }, options.map(([v, t]) => h('option', { value: v, selected: v === value || null }, t)));
  sel.addEventListener('change', () => onChange(sel.value));
  return h('label.row', { for: id }, h('span.lab', label), sel);
}
