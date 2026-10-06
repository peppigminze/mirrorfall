// MIRRORFALL — unified input: keyboard, gamepad and touch.
// Produces the 5-bit mask for the live runner each tick (at most ONE
// direction bit: the most recently pressed direction that is still held)
// plus discrete commands for the game and menus.

import { IN_U, IN_D, IN_L, IN_R, IN_A } from '../sim/constants.js';

const KEY_DIR = {
  ArrowUp: IN_U, KeyW: IN_U, ArrowDown: IN_D, KeyS: IN_D,
  ArrowLeft: IN_L, KeyA: IN_L, ArrowRight: IN_R, KeyD: IN_R,
};
const KEY_ACTION = new Set(['Space', 'KeyJ', 'KeyK']);
const KEY_CMD = {
  Escape: 'pause', KeyP: 'pause', KeyQ: 'rewind', KeyE: 'rewind', Backspace: 'undo', KeyZ: 'undo',
  KeyR: 'restart', KeyF: 'ffToggle',
};

export class Input {
  constructor() {
    this.dirStack = [];            // held direction bits in press order
    this.keyAction = false;
    this.ff = false;               // fast-forward held
    this.touchDir = 0;
    this.touchAction = false;
    this.padDir = 0;
    this.padAction = false;
    this.padFF = false;
    this.commands = [];
    this.anyPress = false;          // set on any gameplay press (starts the loop)
    this.navListeners = new Set();  // menu navigation from gamepad
    this.gameActive = false;
    this.lastPadButtons = [];
    this.padConnected = false;
    this.lastDevice = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) ? 'touch' : 'keyboard';
    this.onDevice = null;

    this.onKeyDown = (e) => {
      if (e.repeat && (KEY_DIR[e.code] || KEY_ACTION.has(e.code))) { if (this.gameActive) e.preventDefault(); return; }
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      this.setDevice('keyboard');
      if (!this.gameActive) return;
      const d = KEY_DIR[e.code];
      if (d) {
        this.dirStack = this.dirStack.filter((x) => x !== d);
        this.dirStack.push(d);
        this.anyPress = true;
        e.preventDefault();
        return;
      }
      if (KEY_ACTION.has(e.code)) { this.keyAction = true; this.anyPress = true; e.preventDefault(); return; }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { this.ff = true; return; }
      const c = KEY_CMD[e.code];
      if (c) { this.commands.push(c); e.preventDefault(); }
    };
    this.onKeyUp = (e) => {
      const d = KEY_DIR[e.code];
      if (d) this.dirStack = this.dirStack.filter((x) => x !== d);
      if (KEY_ACTION.has(e.code)) this.keyAction = false;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.ff = false;
    };
    this.onBlur = () => { this.dirStack = []; this.keyAction = false; this.ff = false; };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', () => { this.padConnected = true; });
  }

  setDevice(d) {
    if (this.lastDevice !== d) { this.lastDevice = d; if (this.onDevice) this.onDevice(d); }
  }

  /** Current 5-bit mask for the live runner. */
  mask() {
    let dir = this.dirStack.length ? this.dirStack[this.dirStack.length - 1] : 0;
    if (!dir) dir = this.padDir || this.touchDir;
    const a = this.keyAction || this.padAction || this.touchAction;
    return (dir | (a ? IN_A : 0)) & 31;
  }
  fastForward() { return this.ff || this.padFF || this.ffLatched; }
  takeCommands() { const c = this.commands; this.commands = []; return c; }
  takeAnyPress() { const a = this.anyPress; this.anyPress = false; return a; }
  clearHeld() { this.dirStack = []; this.keyAction = false; this.touchAction = false; this.touchDir = 0; }

  /** Poll gamepads (call once per animation frame). */
  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) { this.padDir = 0; this.padAction = false; this.padFF = false; return; }
    const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    let dir = 0;
    if (b(12)) dir = IN_U; else if (b(13)) dir = IN_D; else if (b(14)) dir = IN_L; else if (b(15)) dir = IN_R;
    else if (Math.abs(ax) > 0.45 || Math.abs(ay) > 0.45) dir = Math.abs(ax) > Math.abs(ay) ? (ax < 0 ? IN_L : IN_R) : (ay < 0 ? IN_U : IN_D);
    const now = pad.buttons.map((x) => x.pressed);
    const edge = (i) => now[i] && !this.lastPadButtons[i];
    const prevDir = this.padDirRaw || 0;
    this.padDirRaw = dir;
    if (now.some(Boolean) || dir) this.setDevice('gamepad');
    if (this.gameActive) {
      this.padDir = dir;
      this.padAction = b(0);
      this.padFF = b(5) || b(7);
      if (dir && dir !== prevDir) this.anyPress = true;
      if (edge(0)) this.anyPress = true;
      if (edge(9) || edge(8)) this.commands.push('pause');
      if (edge(2)) this.commands.push('rewind');
      if (edge(3)) this.commands.push('undo');
      if (edge(1)) this.commands.push('pause');
    } else {
      this.padDir = 0; this.padAction = false;
      // Menu navigation (edges + simple auto-repeat on the d-pad/stick).
      const t = performance.now();
      if (dir && (dir !== prevDir || t - (this.navRepeat || 0) > 220)) {
        this.navRepeat = t;
        this.emitNav(dir === IN_U ? 'up' : dir === IN_D ? 'down' : dir === IN_L ? 'left' : 'right');
      }
      if (edge(0)) this.emitNav('confirm');
      if (edge(1) || edge(9)) this.emitNav('back');
    }
    this.lastPadButtons = now;
  }
  emitNav(cmd) { for (const f of this.navListeners) f(cmd); }
  destroy() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}
