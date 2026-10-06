// MIRRORFALL — in-game level editor.
//
// • paint tiles/objects with tools (mouse, touch or keyboard cursor)
// • place entities (lasers, guards with waypoints, cameras, platforms) and edit
//   their properties in the side panel
// • live animated preview with the real renderer (guards patrol, lasers pulse)
// • undo, save to local storage, JSON export/import, test mode, bot check

import { h, clear, glyph, copyText } from '../ui/dom.js';
import { button } from '../ui/menus.js';
import { store } from '../ui/storage.js';
import { compileLevel, validateLevel, levelHash } from '../sim/level.js';
import { makeContext, createWorld, step, G_STATUS } from '../sim/world.js';
import { GRID_W, GRID_H, TILE_PX, ST_RUNNING } from '../sim/constants.js';
import { ViewBuilder } from '../render/view.js';
import { palette, CH_SHAPES, rgbCss } from '../render/palette.js';
import { runSolverJob } from '../ui/screens-extra.js';

const DOOR = 'ABCDEFGH', INV = 'JKLMNOPQ', PLATE = 'abcdefgh', SWITCH = '12345678';
const TOOLS = [
  { id: 'wall', label: 'Wand', key: 'w' }, { id: 'floor', label: 'Boden', key: 'b' }, { id: 'chasm', label: 'Abgrund', key: 'g' },
  { id: 'spawn', label: 'Start', key: 's' }, { id: 'exit', label: 'Ausgang', key: 'x' }, { id: 'loot', label: 'Beute', key: 'l' },
  { id: 'coin', label: 'Münze', key: 'm' }, { id: 'plate', label: 'Platte', key: 'p', chan: true }, { id: 'door', label: 'Tür', key: 't', chan: true },
  { id: 'invdoor', label: 'Tür (invers)', key: 'i', chan: true }, { id: 'switch', label: 'Schalter', key: 'k', chan: true },
  { id: 'vault', label: 'Tresortür', key: 'v' }, { id: 'terminal', label: 'Terminal', key: 'n' },
  { id: 'laser', label: 'Laser (Wand)', key: 'z' }, { id: 'camera', label: 'Kamera (Wand)', key: 'c' },
  { id: 'guard', label: 'Wache/Wegpunkt', key: 'u' }, { id: 'platform', label: 'Plattform', key: 'f' },
  { id: 'select', label: 'Auswählen', key: 'a' }, { id: 'erase', label: 'Radierer', key: 'r' },
];
const DIRS = ['U', 'D', 'L', 'R'];
const DXY = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
const CAM_CENTER = { R: 0, D: 32, L: 64, U: 96 };

export function blankLevel() {
  const map = [];
  for (let y = 0; y < GRID_H; y++) {
    let row = '';
    for (let x = 0; x < GRID_W; x++) row += (x === 0 || y === 0 || x === GRID_W - 1 || y === GRID_H - 1) ? '#' : '.';
    map.push(row);
  }
  const set = (x, y, c) => { map[y] = map[y].slice(0, x) + c + map[y].slice(x + 1); };
  set(2, 8, 'S'); set(2, 10, 'E'); set(26, 8, '$');
  return { id: 'custom', name: 'Mein Level', seed: (Math.random() * 1e9) >>> 0, par: 0, map, lasers: [], guards: [], cameras: [], platforms: [] };
}

/** Lenient copy for previewing an unfinished level (drops invalid parts). */
function previewDef(def) {
  const d = JSON.parse(JSON.stringify(def));
  const count = (c) => d.map.join('').split(c).length - 1;
  if (count('T') !== 2) d.map = d.map.map((r) => r.replace(/T/g, '.').replace(/V/g, '#'));
  const at = (x, y) => d.map[y]?.[x] ?? '#';
  d.guards = d.guards.filter((g) => g.route.length && g.route.every((w) => !'#~V'.includes(at(w.x, w.y))));
  d.platforms = d.platforms.filter((p) => {
    if (p.x0 !== p.x1 && p.y0 !== p.y1) return false;
    const n = Math.max(Math.abs(p.x1 - p.x0), Math.abs(p.y1 - p.y0));
    if (n < 1) return false;
    const sx = Math.sign(p.x1 - p.x0), sy = Math.sign(p.y1 - p.y0);
    for (let k = 0; k <= n; k++) if (at(p.x0 + sx * k, p.y0 + sy * k) !== '~') return false;
    return true;
  });
  return d;
}

export class Editor {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.tool = 'wall';
    this.chan = 0;
    this.cursor = { x: 5, y: 5 };
    this.sel = null;          // { kind: 'laser'|'guard'|'camera'|'platform', i }
    this.undoStack = [];
    this.def = store.editorLevels()[0] ? JSON.parse(JSON.stringify(store.editorLevels()[0])) : blankLevel();
    this.buildDom();
  }

  // ---------------------------------------------------------------- DOM
  buildDom() {
    const root = this.app.root;
    this.el = h('div.editor', { role: 'application', 'aria-label': 'Level-Editor' });
    this.overlay = h('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'auto' }, tabindex: 0, 'aria-label': 'Editorfläche: Pfeiltasten bewegen den Cursor, Leertaste setzt, Entf radiert' });
    this.og = this.overlay.getContext('2d');
    this.nameIn = h('input', { type: 'text', 'aria-label': 'Levelname', style: { width: '160px' } });
    this.nameIn.addEventListener('input', () => { this.def.name = this.nameIn.value; });
    this.bar = h('div.bar',
      this.nameIn,
      button('Neu', () => this.cmd('new'), { cls: 'small' }),
      button('Speichern', () => this.cmd('save'), { cls: 'small' }),
      button('Laden', () => this.cmd('load'), { cls: 'small' }),
      button('Rückgängig', () => this.cmd('undo'), { cls: 'small' }),
      button('Testen', () => this.cmd('test'), { cls: 'small primary' }),
      button('Bot prüfen', () => this.cmd('solve'), { cls: 'small' }),
      button('JSON Export', () => this.cmd('export'), { cls: 'small' }),
      button('JSON Import', () => this.cmd('import'), { cls: 'small' }),
      button('Beenden', () => this.cmd('quit'), { cls: 'small' }),
    );
    this.toolsEl = h('div.tools', { role: 'toolbar', 'aria-label': 'Werkzeuge' });
    this.chanEl = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '3px', marginTop: '6px' }, role: 'group', 'aria-label': 'Signalkanal' });
    this.props = h('div.props', { 'aria-live': 'polite' });
    this.status = h('div.status', { role: 'status' });
    this.el.append(this.overlay, this.bar, this.toolsEl, this.props, this.status);
    root.appendChild(this.el);
    this.renderTools();

    const pos = (e) => {
      const r = this.overlay.getBoundingClientRect();
      const k = this.app.canvas.width / r.width;
      const R = this.app.renderer;
      const wx = ((e.clientX - r.left) * k - R.offX) / R.scale, wy = ((e.clientY - r.top) * k - R.offY) / R.scale;
      return { x: Math.floor(wx / TILE_PX), y: Math.floor(wy / TILE_PX) };
    };
    let painting = false, lastCell = '';
    this.overlay.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.overlay.focus();
      const c = pos(e);
      if (c.x < 0 || c.y < 0 || c.x >= GRID_W || c.y >= GRID_H) return;
      this.cursor = c;
      painting = true; lastCell = `${c.x},${c.y}`;
      this.pushUndo();
      this.apply(c.x, c.y, e.button === 2 ? 'erase' : this.tool, e.shiftKey);
      this.overlay.setPointerCapture(e.pointerId);
    });
    this.overlay.addEventListener('pointermove', (e) => {
      const c = pos(e);
      if (c.x < 0 || c.y < 0 || c.x >= GRID_W || c.y >= GRID_H) return;
      this.hover = c;
      if (!painting) return;
      const k = `${c.x},${c.y}`;
      if (k === lastCell) return;
      lastCell = k;
      if (['wall', 'floor', 'chasm', 'erase'].includes(this.tool) || e.buttons === 2) this.apply(c.x, c.y, e.buttons === 2 ? 'erase' : this.tool, false);
    });
    this.overlay.addEventListener('pointerup', () => { painting = false; });
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    this.overlay.addEventListener('keydown', (e) => this.key(e));
  }

  renderTools() {
    clear(this.toolsEl);
    const pal = palette(this.app.settings.colorblind);
    for (const t of TOOLS) {
      const b = button([h('kbd', t.key.toUpperCase()), ' ', t.label], () => { this.tool = t.id; this.renderTools(); this.updateStatus(); }, { cls: `${this.tool === t.id ? 'sel' : ''}`, aria: `Werkzeug ${t.label} (Taste ${t.key.toUpperCase()})` });
      if (this.tool === t.id) b.setAttribute('aria-pressed', 'true');
      this.toolsEl.append(b);
    }
    clear(this.chanEl);
    for (let c = 0; c < 8; c++) {
      const b = button(glyph(CH_SHAPES[c], rgbCss(pal.channel[c]), 16), () => { this.chan = c; this.renderTools(); }, { cls: `small${this.chan === c ? '.sel' : ''}`, aria: `Kanal ${c + 1}` });
      b.style.padding = '4px 6px';
      this.chanEl.append(b);
    }
    this.toolsEl.append(h('div.note', 'Kanal (1–8):'), this.chanEl);
  }

  // ------------------------------------------------------------- lifecycle
  open(def) {
    if (def) this.def = JSON.parse(JSON.stringify(def));
    this.app.stopAttract();
    this.app.leaveGame();
    this.app.menus.clearAll();
    this.app.menus.suspended = true;
    this.active = true;
    this.el.classList.add('visible');
    this.nameIn.value = this.def.name || '';
    this.app.audio.music.setMenu(true);
    this.rebuild();
    setTimeout(() => this.overlay.focus(), 50);
  }
  reopen() { this.open(); }
  close() {
    this.active = false;
    this.el.classList.remove('visible');
    this.app.menus.suspended = false;
    this.app.showTitle();
  }

  // --------------------------------------------------------------- editing
  grid() { return this.def.map.map((r) => r.split('')); }
  setGrid(g) { this.def.map = g.map((r) => r.join('')); }
  pushUndo() {
    this.undoStack.push(JSON.stringify(this.def));
    if (this.undoStack.length > 100) this.undoStack.shift();
  }
  apply(x, y, tool, shift) {
    const g = this.grid();
    const cur = g[y][x];
    const edge = x === 0 || y === 0 || x === GRID_W - 1 || y === GRID_H - 1;
    const setTile = (c) => {
      if (edge && c !== '#') { this.flash('Der Rand bleibt Wand.'); return false; }
      if (cur === 'S' && c !== 'S') { this.flash('Start kann nur versetzt werden.'); return false; }
      if (cur === '$' && c !== '$') { this.flash('Beute kann nur versetzt werden.'); return false; }
      if (cur === 'E' && c !== 'E' && g.flat().filter((q) => q === 'E').length <= 1) { this.flash('Mindestens ein Ausgang nötig.'); return false; }
      g[y][x] = c;
      return true;
    };
    const moveUnique = (c) => {
      if (edge) return;
      for (const row of g) for (let i = 0; i < row.length; i++) if (row[i] === c) row[i] = '.';
      g[y][x] = c;
    };
    switch (tool) {
      case 'wall': setTile('#'); break;
      case 'floor': setTile('.'); break;
      case 'chasm': setTile('~'); break;
      case 'spawn': moveUnique('S'); break;
      case 'loot': moveUnique('$'); break;
      case 'exit': setTile('E'); break;
      case 'coin': setTile('o'); break;
      case 'plate': setTile(PLATE[this.chan]); break;
      case 'door': setTile(DOOR[this.chan]); break;
      case 'invdoor': setTile(INV[this.chan]); break;
      case 'switch': setTile(SWITCH[this.chan]); break;
      case 'vault': setTile('V'); break;
      case 'terminal':
        if (g.flat().filter((q) => q === 'T').length >= 2 && cur !== 'T') { this.flash('Höchstens zwei Terminals.'); break; }
        setTile('T'); break;
      case 'laser': this.placeWallEntity('lasers', x, y, g); break;
      case 'camera': this.placeWallEntity('cameras', x, y, g); break;
      case 'guard': this.placeWaypoint(x, y, g, shift); break;
      case 'platform': this.placePlatform(x, y, g); break;
      case 'select': this.selectAt(x, y); break;
      case 'erase': this.eraseAt(x, y, g, setTile); break;
      default: break;
    }
    this.setGrid(g);
    this.rebuild();
  }
  openSide(x, y, g) {
    for (const d of DIRS) {
      const [dx, dy] = DXY[d];
      const c = g[y + dy]?.[x + dx];
      if (c && c !== '#') return d;
    }
    return null;
  }
  placeWallEntity(kind, x, y, g) {
    if (g[y][x] !== '#') { this.flash('Laser und Kameras sitzen in einer Wand neben freiem Boden.'); return; }
    const list = this.def[kind];
    const existing = list.findIndex((e) => e.x === x && e.y === y);
    if (existing >= 0) { this.sel = { kind, i: existing }; this.renderProps(); return; }
    const d = this.openSide(x, y, g);
    if (!d) { this.flash('Keine freie Seite neben dieser Wand.'); return; }
    if (kind === 'lasers') list.push({ x, y, dir: d, on: 48, off: 48, ph: 0, ch: -1 });
    else list.push({ x, y, a0: CAM_CENTER[d] - 16, a1: CAM_CENTER[d] + 16, speed: 4, pause: 30, ch: -1 });
    this.sel = { kind, i: list.length - 1 };
  }
  placeWaypoint(x, y, g, newGuard) {
    if ('#~V'.includes(g[y][x])) { this.flash('Wegpunkte nur auf begehbarem Boden.'); return; }
    let gi = this.sel && this.sel.kind === 'guards' ? this.sel.i : -1;
    if (newGuard || gi < 0) {
      this.def.guards.push({ route: [{ x, y, wait: 30 }] });
      gi = this.def.guards.length - 1;
    } else this.def.guards[gi].route.push({ x, y, wait: 0 });
    this.sel = { kind: 'guards', i: gi };
  }
  placePlatform(x, y, g) {
    if (g[y][x] !== '~') { this.flash('Plattformen fahren über Abgrund (~).'); return; }
    if (this.platStart) {
      const s = this.platStart;
      this.platStart = null;
      if (s.x !== x && s.y !== y) { this.flash('Plattform-Pfad muss gerade sein.'); return; }
      this.def.platforms.push({ x0: s.x, y0: s.y, x1: x, y1: y, dwell: 60, ch: -1 });
      this.sel = { kind: 'platforms', i: this.def.platforms.length - 1 };
    } else { this.platStart = { x, y }; this.flash('Endpunkt der Plattform wählen.'); }
  }
  selectAt(x, y) {
    const hit = (list, f) => list.findIndex(f);
    let i;
    if ((i = hit(this.def.lasers, (e) => e.x === x && e.y === y)) >= 0) this.sel = { kind: 'lasers', i };
    else if ((i = hit(this.def.cameras, (e) => e.x === x && e.y === y)) >= 0) this.sel = { kind: 'cameras', i };
    else if ((i = hit(this.def.guards, (gd) => gd.route.some((w) => w.x === x && w.y === y))) >= 0) this.sel = { kind: 'guards', i };
    else if ((i = hit(this.def.platforms, (p) => (x >= Math.min(p.x0, p.x1) && x <= Math.max(p.x0, p.x1) && y >= Math.min(p.y0, p.y1) && y <= Math.max(p.y0, p.y1)))) >= 0) this.sel = { kind: 'platforms', i };
    else this.sel = { kind: 'level' };
    this.renderProps();
  }
  eraseAt(x, y, g, setTile) {
    const rm = (kind, f) => { const i = this.def[kind].findIndex(f); if (i >= 0) { this.def[kind].splice(i, 1); this.sel = null; return true; } return false; };
    if (rm('lasers', (e) => e.x === x && e.y === y) || rm('cameras', (e) => e.x === x && e.y === y)) return;
    for (const gd of this.def.guards) {
      const k = gd.route.findIndex((w) => w.x === x && w.y === y);
      if (k >= 0) { gd.route.splice(k, 1); this.def.guards = this.def.guards.filter((q) => q.route.length); this.sel = null; return; }
    }
    if (rm('platforms', (p) => (x >= Math.min(p.x0, p.x1) && x <= Math.max(p.x0, p.x1) && y >= Math.min(p.y0, p.y1) && y <= Math.max(p.y0, p.y1)))) return;
    if (g[y][x] !== '.' && g[y][x] !== '#') setTile('.');
    else if (g[y][x] === '#' && !(x === 0 || y === 0 || x === GRID_W - 1 || y === GRID_H - 1)) setTile('.');
  }

  // ------------------------------------------------------------ properties
  renderProps() {
    clear(this.props);
    const s = this.sel;
    const num = (label, obj, key, min, max, stepv = 1) => {
      const inp = h('input', { type: 'number', min, max, step: stepv, value: obj[key] ?? 0, 'aria-label': label, style: { width: '100%' } });
      inp.addEventListener('change', () => { this.pushUndo(); obj[key] = Math.max(min, Math.min(max, +inp.value || 0)); this.rebuild(false); });
      return [h('label', label), inp];
    };
    const sel = (label, obj, key, opts) => {
      const se = h('select', { 'aria-label': label }, opts.map(([v, t]) => h('option', { value: v, selected: String(obj[key]) === String(v) || null }, t)));
      se.addEventListener('change', () => { this.pushUndo(); obj[key] = isNaN(+se.value) ? se.value : +se.value; this.rebuild(false); });
      return [h('label', label), se];
    };
    const chans = [[-1, '– keiner –'], ...Array.from({ length: 8 }, (_, c) => [c, `Kanal ${c + 1}`])];
    const del = (kind, i) => button('Löschen', () => { this.pushUndo(); this.def[kind].splice(i, 1); this.sel = null; this.rebuild(); }, { cls: 'small' });
    if (!s || s.kind === 'level') {
      this.props.append(h('strong', 'Level'), ...num('Seed (Musik/Farben)', this.def, 'seed', 0, 4294967295), ...num('Par (Ticks, 0 = keins)', this.def, 'par', 0, 1800, 30),
        h('p.note', 'Werkzeug „Auswählen" (A) auf ein Objekt klicken, um es zu bearbeiten.'));
    } else if (s.kind === 'lasers') {
      const z = this.def.lasers[s.i];
      this.props.append(h('strong', 'Laser'), ...sel('Richtung', z, 'dir', DIRS.map((d) => [d, { U: 'hoch', D: 'runter', L: 'links', R: 'rechts' }[d]])),
        ...num('An (Ticks)', z, 'on', 0, 600, 4), ...num('Aus (Ticks, 0 = dauerhaft an)', z, 'off', 0, 600, 4), ...num('Phase', z, 'ph', -600, 600, 4),
        ...sel('Abschalten durch', z, 'ch', chans), del('lasers', s.i));
    } else if (s.kind === 'cameras') {
      const c = this.def.cameras[s.i];
      this.props.append(h('strong', 'Kamera'), ...num('Winkel von (1/128 Kreis)', c, 'a0', -256, 256), ...num('Winkel bis', c, 'a1', -256, 256),
        ...num('Ticks pro Schritt', c, 'speed', 1, 30), ...num('Pause an den Enden', c, 'pause', 0, 300, 10), ...sel('Abschalten durch', c, 'ch', chans), del('cameras', s.i));
    } else if (s.kind === 'guards') {
      const gd = this.def.guards[s.i];
      this.props.append(h('strong', `Wache ${s.i + 1}`), h('p.note', 'Wegpunkte mit Werkzeug „Wache" anklicken; Shift+Klick beginnt eine neue Wache. Die Route ist ein geschlossener Rundkurs.'));
      gd.route.forEach((w, k) => {
        this.props.append(h('div.note', `Punkt ${k + 1}: ${w.x},${w.y}`), ...num('Warten (Ticks)', w, 'wait', 0, 3600, 10),
          ...sel('Blick beim Warten', w, 'look', [['', '—'], ...DIRS.map((d) => [d, d])]));
      });
      this.props.append(del('guards', s.i));
    } else if (s.kind === 'platforms') {
      const p = this.def.platforms[s.i];
      this.props.append(h('strong', 'Plattform'), ...num('Wartezeit an den Enden', p, 'dwell', 8, 600, 4), ...sel('Fährt nur bei Kanal', p, 'ch', chans),
        ...sel('Invertiert', p, 'inv', [[0, 'nein'], [1, 'ja']]), del('platforms', s.i));
    }
  }

  // --------------------------------------------------------------- preview
  rebuild(resetSel = true) {
    void resetSel;
    const errs = validateLevel(this.def);
    this.errors = errs;
    try {
      this.L = compileLevel(previewDef(this.def));
      this.ctx = makeContext(this.L);
      this.world = createWorld(this.ctx, 1, []);
      this.prev = this.world.s.slice();
      this.view = new ViewBuilder(this.L, this.ctx);
      this.app.renderer.setLevel(this.L, this.ctx, palette(this.app.settings.colorblind));
      this.acc = 0;
    } catch (e) {
      this.errors = [e.message, ...errs];
    }
    this.renderProps();
    this.updateStatus();
  }
  updateStatus() {
    const t = TOOLS.find((x) => x.id === this.tool);
    const c = this.hover || this.cursor;
    const errs = this.errors || [];
    this.status.textContent = `${t ? t.label : ''}${t && t.chan ? ` · Kanal ${this.chan + 1}` : ''} · Feld ${c.x},${c.y} · ` +
      (errs.length ? `⚠ ${errs.slice(0, 2).join(' · ')}` : '✔ Level gültig');
  }
  flash(msg) { this.app.toast(msg); }

  frame(dt) {
    if (!this.active || !this.world) return;
    // Animated preview: guards patrol, lasers pulse, cameras sweep (runner idle at the start).
    this.acc += dt;
    const inp = new Uint8Array(1);
    while (this.acc >= 1 / 60) {
      this.acc -= 1 / 60;
      this.prev.set(this.world.s);
      step(this.world, inp);
      if (this.world.s[G_STATUS] !== ST_RUNNING) { this.world = createWorld(this.ctx, 1, []); this.prev = this.world.s.slice(); }
    }
    const v = this.view.build(this.prev, this.world.s, this.acc * 60, dt, { ghostColors: palette(false).ghost });
    const narrow = window.innerWidth < 700;
    const insets = { l: narrow ? 120 : 166, r: narrow ? 168 : 236, t: 52, b: 28 };
    this.app.renderer.render(v, { state: this.world.s, dt, cam: null, insets, reducedMotion: true, colorblind: !!this.app.settings.colorblind });
    this.drawOverlay();
  }

  drawOverlay() {
    const cv = this.overlay, g = this.og, R = this.app.renderer;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    const k = cv.width / this.app.canvas.width;
    g.setTransform(R.scale * k, 0, 0, R.scale * k, R.offX * k, R.offY * k);
    // grid
    g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 1 / (R.scale * k);
    g.beginPath();
    for (let x = 0; x <= GRID_W; x++) { g.moveTo(x * TILE_PX, 0); g.lineTo(x * TILE_PX, GRID_H * TILE_PX); }
    for (let y = 0; y <= GRID_H; y++) { g.moveTo(0, y * TILE_PX); g.lineTo(GRID_W * TILE_PX, y * TILE_PX); }
    g.stroke();
    const C = (x) => (x + 0.5) * TILE_PX;
    // guard routes
    this.def.guards.forEach((gd, i) => {
      const selected = this.sel && this.sel.kind === 'guards' && this.sel.i === i;
      g.strokeStyle = selected ? 'rgba(255,232,74,0.9)' : 'rgba(255,200,140,0.55)'; g.lineWidth = 2; g.setLineDash([6, 5]);
      g.beginPath();
      gd.route.forEach((w, k2) => (k2 ? g.lineTo(C(w.x), C(w.y)) : g.moveTo(C(w.x), C(w.y))));
      if (gd.route.length > 1) g.closePath();
      g.stroke(); g.setLineDash([]);
      gd.route.forEach((w, k2) => { g.fillStyle = selected ? '#ffe84a' : '#ffc88c'; g.font = '10px sans-serif'; g.fillText(String(k2 + 1), C(w.x) + 6, C(w.y) - 6); });
    });
    // platforms
    for (const p of this.def.platforms) { g.strokeStyle = 'rgba(140,180,255,0.8)'; g.lineWidth = 2; g.beginPath(); g.moveTo(C(p.x0), C(p.y0)); g.lineTo(C(p.x1), C(p.y1)); g.stroke(); }
    if (this.platStart) { g.strokeStyle = '#8ab4ff'; g.strokeRect(this.platStart.x * TILE_PX + 2, this.platStart.y * TILE_PX + 2, TILE_PX - 4, TILE_PX - 4); }
    // laser & camera markers
    for (const z of this.def.lasers) { const [dx, dy] = DXY[z.dir]; g.strokeStyle = '#ff4a7a'; g.lineWidth = 2; g.beginPath(); g.moveTo(C(z.x), C(z.y)); g.lineTo(C(z.x) + dx * 14, C(z.y) + dy * 14); g.stroke(); }
    // selection
    if (this.sel && (this.sel.kind === 'lasers' || this.sel.kind === 'cameras')) {
      const e = this.def[this.sel.kind][this.sel.i];
      if (e) { g.strokeStyle = '#ffe84a'; g.lineWidth = 2; g.strokeRect(e.x * TILE_PX + 1, e.y * TILE_PX + 1, TILE_PX - 2, TILE_PX - 2); }
    }
    // cursor
    const c = this.cursor;
    g.strokeStyle = 'rgba(255,232,74,0.95)'; g.lineWidth = 2;
    g.strokeRect(c.x * TILE_PX + 1, c.y * TILE_PX + 1, TILE_PX - 2, TILE_PX - 2);
    if (this.hover) { g.strokeStyle = 'rgba(255,255,255,0.35)'; g.strokeRect(this.hover.x * TILE_PX + 1, this.hover.y * TILE_PX + 1, TILE_PX - 2, TILE_PX - 2); }
  }

  // --------------------------------------------------------------- input
  key(e) {
    const k = e.key;
    const mv = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[k];
    if (mv) {
      e.preventDefault();
      this.cursor = { x: Math.max(0, Math.min(GRID_W - 1, this.cursor.x + mv[0])), y: Math.max(0, Math.min(GRID_H - 1, this.cursor.y + mv[1])) };
      this.hover = null;
      if (e.shiftKey && ['wall', 'floor', 'chasm'].includes(this.tool)) { this.pushUndo(); this.apply(this.cursor.x, this.cursor.y, this.tool, false); }
      this.updateStatus();
      return;
    }
    if (k === ' ' || k === 'Enter') { e.preventDefault(); this.pushUndo(); this.apply(this.cursor.x, this.cursor.y, this.tool, e.shiftKey); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.pushUndo(); this.apply(this.cursor.x, this.cursor.y, 'erase', false); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); this.cmd('undo'); return; }
    if (k === 'Escape') { e.preventDefault(); this.cmd('quit'); return; }
    if (/^[1-8]$/.test(k)) { this.chan = +k - 1; this.renderTools(); this.updateStatus(); return; }
    const t = TOOLS.find((x) => x.key === k.toLowerCase());
    if (t && !e.ctrlKey && !e.metaKey) { this.tool = t.id; this.renderTools(); this.updateStatus(); }
  }

  // ------------------------------------------------------------- commands
  async cmd(c) {
    if (c === 'undo') { const s = this.undoStack.pop(); if (s) { this.def = JSON.parse(s); this.rebuild(); } return; }
    if (c === 'new') { this.pushUndo(); this.def = blankLevel(); this.nameIn.value = this.def.name; this.sel = null; this.rebuild(); return; }
    if (c === 'save') {
      const list = store.editorLevels().filter((d) => d.name !== this.def.name);
      list.unshift(JSON.parse(JSON.stringify(this.def)));
      store.saveEditorLevels(list.slice(0, 40));
      this.flash(`„${this.def.name}" gespeichert`);
      return;
    }
    if (c === 'load') return this.dialog('Gespeicherte Level', (box, close) => {
      const list = store.editorLevels();
      if (!list.length) box.append(h('p', 'Noch nichts gespeichert.'));
      for (const d of list) box.append(button(d.name, () => { this.def = JSON.parse(JSON.stringify(d)); this.nameIn.value = d.name; close(); this.rebuild(); }));
    });
    if (c === 'test') {
      if (this.errors && this.errors.length) { this.flash('Level ist noch ungültig: ' + this.errors[0]); return; }
      this.active = false;
      this.el.classList.remove('visible');
      this.app.menus.suspended = false;
      this.app.startLevel(JSON.parse(JSON.stringify(this.def)), { mode: 'test' });
      return;
    }
    if (c === 'solve') {
      if (this.errors && this.errors.length) { this.flash('Level ist noch ungültig: ' + this.errors[0]); return; }
      this.flash('Solver-Bot sucht eine Lösung …');
      const res = await runSolverJob({ type: 'solve', def: this.def, timeLimitMs: 25000 });
      const r = res.r;
      return this.dialog('Bot-Prüfung', (box, close) => {
        if (r.ok) {
          box.append(h('p.ok', `✔ Lösbar mit ${r.runs.length - 1} Geist(ern), Flucht nach ${(r.finalTick / 60).toFixed(2)} s.`), h('p.note', `Rollen: ${r.roles.join(' → ') || 'keine'} · ${r.stats.expansions} Suchknoten`),
            button('Par übernehmen (+2 s)', () => { this.def.par = Math.ceil((r.finalTick + 120) / 30) * 30; close(); this.rebuild(); }),
            button('Bot-Lösung ansehen', () => { close(); this.active = false; this.el.classList.remove('visible'); this.app.menus.suspended = false; this.app.startLevel(JSON.parse(JSON.stringify(this.def)), { mode: 'test', playback: { runs: r.runs } }); }));
        } else box.append(h('p.bad', r.timedOut ? 'Keine Lösung im Zeitbudget gefunden (nicht bewiesen unlösbar).' : 'Der Bot findet keine Lösung im Rollenmodell (≤ 4 Geister).'));
      });
    }
    if (c === 'export') {
      const json = JSON.stringify(this.def, null, 1);
      return this.dialog('JSON-Export', (box) => {
        const ta = h('textarea', { rows: 12, 'aria-label': 'Level als JSON' }, json);
        const blob = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        box.append(ta, h('div.btnrow',
          button('Kopieren', async () => this.flash(await copyText(json) ? 'Kopiert' : 'Kopieren nicht möglich')),
          h('a.btn', { href: blob, download: `${(this.def.name || 'level').replace(/[^\w-]+/g, '_')}.json` }, 'Herunterladen')),
          h('p.note', `Level-Hash (für Replays): ${levelHash(this.def)}`));
      });
    }
    if (c === 'import') return this.dialog('JSON-Import', (box, close) => {
      const ta = h('textarea', { rows: 10, 'aria-label': 'Level-JSON einfügen', placeholder: '{ "map": [ … ] }' });
      const msg = h('p.note');
      box.append(ta, msg, button('Importieren', () => {
        try {
          const d = JSON.parse(ta.value);
          const errs = validateLevel(d);
          if (errs.length) { msg.textContent = '⚠ ' + errs.join(' · '); return; }
          this.pushUndo();
          this.def = { name: 'Import', seed: 1, par: 0, lasers: [], guards: [], cameras: [], platforms: [], ...d };
          this.nameIn.value = this.def.name;
          close(); this.rebuild();
        } catch (e) { msg.textContent = 'JSON-Fehler: ' + e.message; }
      }));
    });
    if (c === 'quit') this.close();
  }

  dialog(title, build) {
    this.app.menus.suspended = false;
    this.app.menus.push({
      title, overlay: true,
      onBack: () => close(),
      onClose: () => { this.app.menus.suspended = true; setTimeout(() => this.overlay.focus(), 30); },
      build: (el) => {
        const box = h('div.stack');
        el.append(h('h2', title), box, h('div.btnrow', button('Schließen', () => close(), { autofocus: true })));
        build(box, close);
      },
    });
    const close = () => this.app.menus.pop();
  }
}
