// MIRRORFALL — application shell: renderer selection, main loop, screens.

import { h, clear, glyph, copyText, fmtTime } from './dom.js';
import { MenuSystem, button, slider, toggle, select } from './menus.js';
import { Input } from './input.js';
import { TouchControls } from './touch.js';
import { Hud } from './hud.js';
import { GameSession } from './game.js';
import { loadSettings, saveSettings } from './settings.js';
import { store } from './storage.js';
import { shareString } from './share.js';
import { CAMPAIGN } from '../levels/campaign.js';
import { BOT_SOLUTIONS } from '../levels/botsolutions.js';
import { Renderer2D } from '../render/renderer-2d.js';
import { RendererGL } from '../render/renderer-gl.js';
import { QualityController } from '../render/quality.js';
import { palette, GHOST_SHAPES, CH_SHAPES, rgbCss } from '../render/palette.js';
import { AudioEngine } from '../audio/engine.js';
import { encodeReplay, decodeReplay, LK_CAMPAIGN, LK_DAILY, LK_CUSTOM } from '../sim/replay.js';
import { levelHash, validateLevel } from '../sim/level.js';
import { rebuildCanon } from '../sim/timeline.js';
import { makeContext } from '../sim/world.js';
import { compileLevel } from '../sim/level.js';
import { ST_WON } from '../sim/constants.js';

export class App {
  constructor(root, canvas) {
    this.root = root;
    this.canvas = canvas;
    this.settings = loadSettings();
    // URL overrides for testing/benchmarks: ?q=low|med|high  ?r=2d|gl
    const q = new URLSearchParams(location.search);
    if (q.get('q')) this.settings.quality = q.get('q');
    if (q.get('r')) this.settings.renderer = q.get('r') === '2d' ? 'canvas2d' : 'webgl2';
    this.perf = { frames: 0, cpu: [], dts: [] };
    document.body.classList.toggle('reduced', !!this.settings.reducedMotion);
    this.input = new Input();
    this.audio = new AudioEngine(this.settings);
    this.renderer = this.createRenderer();
    this.quality = new QualityController(this.renderer, this.settings);
    this.hud = new Hud(root, this.settings);
    this.touch = new TouchControls(root, this.input);
    this.menus = new MenuSystem(root, this.input);
    this.menus.onMove = () => this.audio.sfx('ui');
    this.fpsEl = h('div.fps');
    this.hud.el.appendChild(this.fpsEl);
    this.input.onDevice = (d) => { this.hud.setDevice(d); this.updateTouch(); };
    this.hud.setDevice(this.input.lastDevice);
    this.session = null;
    this.attract = null;
    this.customLevels = store.editorLevels();

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    window.addEventListener('orientationchange', () => setTimeout(this.resize, 200));
    this.resize();
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.session && this.session.state === 'play') this.pause();
    });

    this.last = performance.now();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
    this.handleUrl();
  }

  createRenderer() {
    const want = this.settings.renderer;
    if (want !== 'canvas2d') {
      try {
        const r = new RendererGL(this.canvas, this.settings);
        return r;
      } catch (e) {
        console.warn('WebGL2 nicht verfügbar, nutze Canvas2D:', e.message);
        // A canvas keeps its first context type: replace it before falling back.
        const c = this.canvas.cloneNode(false);
        this.canvas.replaceWith(c);
        this.canvas = c;
      }
    }
    return new Renderer2D(this.canvas);
  }

  resize() {
    const w = window.innerWidth, hgt = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.resize(w, hgt, dpr);
    this.updateTouch();
  }

  updateTouch() {
    const t = this.settings.touch;
    const isTouch = t === 'on' || (t === 'auto' && (this.input.lastDevice === 'touch' || matchMedia('(pointer: coarse)').matches));
    this.touch.show(!!this.session && isTouch && !this.menus.active);
  }

  // ----------------------------------------------------------- main loop
  frame(now) {
    const rawDt = (now - this.last) / 1000;
    const dt = Math.min(0.25, rawDt);
    this.last = now;
    const c0 = performance.now();
    this.input.poll();
    const active = this.session || this.attract;
    let simMs = 0;
    if (this.editor && this.editor.active) this.editor.frame(dt);
    else if (active) {
      const s0 = performance.now();
      if (this.session && !this.paused) active.update(dt);
      else if (!this.session) active.update(dt);
      simMs = performance.now() - s0;
      active.render(this.paused ? 0 : dt);
    }
    this.audio.frame(dt);
    if (this.quality.sample(dt) && this.quality.changed) { this.quality.changed = false; this.resize(); }
    const perf = this.perf;
    perf.frames++;
    perf.cpu.push(performance.now() - c0); perf.dts.push(rawDt * 1000); (perf.sim = perf.sim || []).push(simMs);
    if (perf.cpu.length > 600) { perf.cpu.shift(); perf.dts.shift(); perf.sim.shift(); }
    if (this.settings.showFps) this.fpsEl.textContent = `${Math.round(this.quality.fps)} FPS · ${this.renderer.kind} · ${this.quality.level}`;
    requestAnimationFrame(this.frame);
  }

  // -------------------------------------------------------------- sessions
  makeSession(def, extra = {}) {
    return new GameSession({
      def, renderer: this.renderer, audio: this.audio, input: this.input, hud: this.hud, settings: this.settings,
      onEvent: (type, payload) => this.onGameEvent(type, payload), ...extra,
    });
  }

  startAttract() {
    // Title background: the bot replays one of its solutions, forever.
    const ids = Object.keys(BOT_SOLUTIONS).filter((id) => id >= 'c07');
    const id = ids[Math.floor(Math.random() * ids.length)] || 'c12';
    const def = CAMPAIGN.find((d) => d.id === id) || CAMPAIGN[0];
    try {
      const { runs } = decodeReplay(BOT_SOLUTIONS[id]);
      this.attract = this.makeSession(def, { playback: { runs }, attract: true });
    } catch (e) { console.warn(e); this.attract = null; }
    this.hud.show(false);
  }
  stopAttract() { if (this.attract) { this.attract.destroy(); this.attract = null; } }

  startLevel(def, opts = {}) {
    this.stopAttract();
    if (this.session) this.session.destroy();
    this.menus.clearAll();
    this.paused = false;
    this.current = { def, ...opts };
    this.session = this.makeSession(def, { rival: opts.rival || null, playback: opts.playback || null, mode: opts.mode || 'campaign' });
    this.input.gameActive = true;
    this.hud.show(true);
    this.updateTouch();
    this.audio.music?.start?.();
  }

  leaveGame() {
    if (this.session) { this.session.destroy(); this.session = null; }
    this.input.gameActive = false;
    this.paused = false;
    this.hud.show(false);
    this.updateTouch();
  }

  onGameEvent(type, payload) {
    if (type === 'pause') return this.pause();
    if (type === 'playbackDone') return this.showPlaybackDone(payload);
    if (type === 'win') return this.showResult(payload);
  }

  pause() {
    if (!this.session || this.paused) return;
    this.paused = true;
    this.input.gameActive = false;
    this.input.clearHeld();
    this.updateTouch();
    this.menus.push({
      title: 'Pause', overlay: true,
      onBack: () => this.resume(),
      build: (el) => {
        el.append(h('h2', 'Pause'), h('div.stack',
          button('Weiter', () => this.resume(), { autofocus: true, cls: 'primary' }),
          button('Level neu starten', () => { this.resume(); this.session.command('restart'); }),
          button('Einstellungen', () => this.showSettings()),
          button('Steuerung & Legende', () => this.showHelp()),
          button(this.current?.mode === 'test' ? 'Zurück zum Editor' : 'Level verlassen', () => this.exitToMenu()),
        ));
      },
    });
  }
  resume() {
    this.menus.clearAll();
    this.paused = false;
    this.input.gameActive = true;
    this.input.clearHeld();
    this.updateTouch();
  }
  exitToMenu() {
    const wasTest = this.current?.mode === 'test';
    this.leaveGame();
    this.menus.clearAll();
    if (wasTest && this.editor) { this.editor.reopen(); return; }
    if (this.current?.mode === 'daily') return this.showTitle();
    this.showTitle();
    if (this.current?.mode === 'campaign') this.showCampaign();
  }

  // ----------------------------------------------------------------- screens
  showTitle() {
    this.leaveGame();
    this.menus.clearAll();
    if (!this.attract) this.startAttract();
    this.audio.music.setLevel(0xC0FFEE, 'menu');
    this.audio.music.setMenu(true);
    this.menus.push({
      title: 'MIRRORFALL', className: 'title',
      onBack: () => {},
      build: (el) => {
        el.append(
          h('h1.logo', 'MIRRORFALL'),
          h('div.tagline', '30 Sekunden · Jede Schleife wird zum Geist'),
          h('div.stack',
            button('Kampagne', () => this.showCampaign(), { cls: 'primary', autofocus: true }),
            button('Tagesrätsel', () => this.showDaily()),
            button('Replays & Ghost-Rennen', () => this.showReplays()),
            button('Level-Editor', () => this.openEditor()),
            button('Einstellungen', () => this.showSettings()),
            button('Steuerung & Legende', () => this.showHelp()),
          ),
          h('p.note', { style: { marginTop: '18px' } }, `Renderer: ${this.renderer.kind === 'webgl2' ? 'WebGL2' : 'Canvas2D (Fallback)'}`),
        );
      },
    });
  }

  showCampaign() {
    this.menus.push({
      title: 'Kampagne',
      build: (el) => {
        const pal = palette(this.settings.colorblind);
        void pal;
        const grid = h('div.grid');
        CAMPAIGN.forEach((def, i) => {
          const rec = store.level(def.id);
          const unlocked = this.settings.unlockAll || i === 0 || store.solved(CAMPAIGN[i - 1].id) || !!rec;
          const stars = rec ? rec.stars.map((s) => (s ? '★' : '☆')).join('') : '☆☆☆';
          const card = button([
            h('span.n', String(i + 1).padStart(2, '0') + (i >= 8 ? ' · Paradox' : '')),
            h('span.t', def.name),
            h('span.stars', { 'aria-label': `${rec ? rec.stars.filter(Boolean).length : 0} von 3 Sternen` }, stars),
            h('span.best', rec ? `Best ${fmtTime(rec.best)} · Par ${fmtTime(def.par)}` : `Par ${fmtTime(def.par)}`),
          ], () => unlocked && this.startLevel(def, { mode: 'campaign', index: i }), { cls: `card${unlocked ? '' : '.locked'}${i >= 8 ? '.trap' : ''}`, disabled: !unlocked, aria: `Level ${i + 1}: ${def.name}${unlocked ? '' : ' (gesperrt)'}` });
          grid.append(card);
        });
        const total = CAMPAIGN.reduce((a, d) => a + store.starCount(d.id), 0);
        el.append(h('h2', `Kampagne · ${total}/36 ★`), grid, h('div.btnrow', button('Zurück', () => this.menus.pop())));
      },
    });
  }

  showResult(r) {
    const cur = this.current || {};
    const def = cur.def;
    const kind = cur.mode === 'daily' ? LK_DAILY : cur.mode === 'campaign' ? LK_CAMPAIGN : LK_CUSTOM;
    const ref = cur.mode === 'daily' ? cur.dailyRef : cur.mode === 'campaign' ? cur.index : levelHash(def);
    const code = encodeReplay({ kind, ref }, r.runs, r.lengths);
    let rec = { newBest: false };
    if (cur.mode === 'campaign') rec = store.recordResult(def.id, r, code);
    else if (cur.mode === 'daily') store.recordDaily(cur.dailyKey, { tick: r.tick, stars: r.starFlags, replay: code });
    if (cur.mode !== 'test') store.addReplay({ code, title: def.name, tick: r.tick, date: new Date().toISOString().slice(0, 10), kind, ref });
    const title = cur.mode === 'campaign' ? `${String(cur.index + 1).padStart(2, '0')} · ${def.name}` : cur.mode === 'daily' ? `Tagesrätsel ${cur.dailyKey}` : def.name;
    const share = shareString({ title, result: r });
    this.input.gameActive = false;
    this.updateTouch();
    this.menus.push({
      title: 'Ergebnis', overlay: true,
      onBack: () => this.exitToMenu(),
      build: (el) => {
        const stars = h('div.result-stars', { role: 'img', 'aria-label': `${r.stars} von 3 Sternen` },
          r.starFlags.map((s) => h(s ? 'span' : 'span.off', '★')));
        const next = cur.mode === 'campaign' && cur.index < CAMPAIGN.length - 1 ? CAMPAIGN[cur.index + 1] : null;
        el.append(
          h('h2', 'Flucht gelungen'), stars,
          h('dl.kv',
            h('dt', 'Zeit'), h('dd', fmtTime(r.tick) + (rec.newBest ? '  ← neue Bestzeit' : '')),
            h('dt', 'Par'), h('dd', r.par ? `${fmtTime(r.par)} ${r.starFlags[1] ? '✓' : '✗'}` : '—'),
            h('dt', 'Geister'), h('dd', String(r.ghosts)),
            h('dt', 'Alarme'), h('dd', `${r.alarms} ${r.starFlags[2] ? '✓' : '✗'}`),
            h('dt', 'Paradoxe'), h('dd', String(r.paradoxes)),
            h('dt', 'Schleifen'), h('dd', String(r.loops)),
            h('dt', 'Verifiziert'), h('dd', r.verified ? h('span.ok', 'ja — Zeitlinie deterministisch nachsimuliert') : h('span.bad', 'nein')),
          ),
          h('div.share', share),
          h('div.btnrow',
            button('Share kopieren', async () => this.toast(await copyText(share) ? 'Kopiert' : 'Kopieren nicht möglich')),
            button('Replay-Code kopieren', async () => this.toast(await copyText(code) ? `Replay kopiert (${code.length} Zeichen)` : 'Kopieren nicht möglich')),
          ),
          h('div.btnrow',
            next ? button('Nächstes Level', () => this.startLevel(next, { mode: 'campaign', index: cur.index + 1 }), { cls: 'primary', autofocus: true }) : null,
            button('Nochmal', () => this.startLevel(def, cur), { autofocus: !next }),
            cur.mode === 'campaign' && BOT_SOLUTIONS[def.id] ? button('Bot-Lösung ansehen', () => this.watchBot(def, cur)) : null,
            button(cur.mode === 'test' ? 'Zum Editor' : 'Menü', () => this.exitToMenu()),
          ),
        );
      },
    });
  }

  showPlaybackDone(r) {
    const cur = this.current || {};
    this.input.gameActive = false;
    this.updateTouch();
    this.menus.push({
      title: 'Wiedergabe', overlay: true,
      onBack: () => this.exitToMenu(),
      build: (el) => {
        el.append(h('h2', 'Wiedergabe beendet'),
          h('p', `Flucht nach ${fmtTime(r.tick)} mit ${r.ghosts} Geist${r.ghosts === 1 ? '' : 'ern'} — jede Schleife wurde aus den gespeicherten Eingaben deterministisch nachsimuliert.`),
          h('div.btnrow',
            button('Nochmal ansehen', () => this.startLevel(cur.def, cur), { autofocus: true }),
            button('Selbst spielen', () => this.startLevel(cur.def, { ...cur, playback: null }), { cls: 'primary' }),
            button(cur.mode === 'test' ? 'Zum Editor' : 'Menü', () => this.exitToMenu())));
      },
    });
  }

  watchBot(def, cur) {
    const { runs } = decodeReplay(BOT_SOLUTIONS[def.id]);
    this.startLevel(def, { ...cur, playback: { runs } });
  }

  showSettings() {
    const s = this.settings;
    const apply = () => {
      saveSettings(s);
      this.audio.setVolumes(s);
      document.body.classList.toggle('reduced', !!s.reducedMotion);
      this.quality.setMode(s.quality);
      this.resize();
    };
    this.menus.push({
      title: 'Einstellungen', overlay: !!this.session,
      build: (el) => {
        el.append(
          h('h2', 'Einstellungen'),
          slider('Gesamtlautstärke', s.master, (v) => { s.master = v; apply(); }),
          slider('Musik', s.music, (v) => { s.music = v; apply(); }),
          slider('Effekte', s.sfx, (v) => { s.sfx = v; apply(); }),
          toggle('Farbenblind-Modus', s.colorblind, (v) => { s.colorblind = v; apply(); this.toast('Gilt ab dem nächsten Levelstart'); }, 'Andere Palette + Formen/Muster statt nur Farben'),
          toggle('Reduzierte Bewegung', s.reducedMotion, (v) => { s.reducedMotion = v; apply(); }, 'Kein Wackeln, kürzere Effekte, weniger Partikel'),
          toggle('Bildschirm-Wackeln', s.shake, (v) => { s.shake = v; apply(); }),
          select('Grafikqualität', s.quality, [['auto', 'Automatisch (gemessen)'], ['low', 'Niedrig'], ['med', 'Mittel'], ['high', 'Hoch']], (v) => { s.quality = v; apply(); }),
          select('Touch-Steuerung', s.touch, [['auto', 'Automatisch'], ['on', 'Immer'], ['off', 'Aus']], (v) => { s.touch = v; apply(); this.updateTouch(); }),
          select('Renderer (Neustart)', s.renderer, [['auto', 'Automatisch'], ['webgl2', 'WebGL2'], ['canvas2d', 'Canvas2D']], (v) => { s.renderer = v; apply(); this.toast('Wird nach dem Neuladen aktiv'); }),
          toggle('FPS anzeigen', s.showFps, (v) => { s.showFps = v; apply(); }),
          toggle('Alle Level freischalten', !!s.unlockAll, (v) => { s.unlockAll = v; apply(); }),
          h('div.btnrow', button('Zurück', () => this.menus.pop(), { autofocus: false })),
        );
      },
    });
  }

  showHelp() {
    const pal = palette(this.settings.colorblind);
    const names = ['Kreis', 'Dreieck', 'Quadrat', 'Raute', 'Stern', 'Sechseck', 'Kreuz', 'Ring'];
    this.menus.push({
      title: 'Steuerung',
      build: (el) => {
        el.append(
          h('h2', 'Steuerung'),
          h('dl.kv',
            h('dt', 'Bewegen'), h('dd', 'WASD / Pfeile · Stick / D-Pad · Touch-Stick'),
            h('dt', 'Aktion'), h('dd', 'Leertaste / J · A · ● (Schalter, Terminal halten, Münze werfen)'),
            h('dt', 'Jetzt zurückspulen'), h('dd', 'Q · X · ⟲  (Rest der Schleife: stehen bleiben)'),
            h('dt', 'Schleife rückgängig'), h('dd', '⌫ / Z · Y · ↶'),
            h('dt', 'Zeitraffer'), h('dd', 'Shift halten · RB · » (umschalten: F)'),
            h('dt', 'Neustart / Pause'), h('dd', 'R · Esc / P · Start'),
          ),
          h('h2', 'Legende'),
          h('div.legend',
            ...[0, 1, 2, 3, 4].flatMap((i) => [glyph(GHOST_SHAPES[i], rgbCss(pal.ghost[i]), 20), h('span', `Läufer ${i + 1} (${names[GHOST_SHAPES[i]]})`)]),
            ...[0, 1, 2, 3].flatMap((c) => [glyph(CH_SHAPES[c], rgbCss(pal.channel[c]), 20), h('span', `Signal ${names[CH_SHAPES[c]]}: Platte/Schalter → Tür/Laser/Plattform`)]),
          ),
          h('p', 'Jede Schleife dauert 30 Sekunden. Danach spult die Zeit zurück und dein Durchlauf läuft als Geist weiter. Ändert ein späterer Durchlauf, was ein Geist erlebt hat (blockiert, entdeckt, Münze weg …), entsteht ein Zeitparadox und die Zeitlinie bricht ab diesem Geist.'),
          h('div.btnrow', button('Zurück', () => this.menus.pop(), { autofocus: true })),
        );
      },
    });
  }

  // Replays, daily and editor are implemented in ui/screens-extra.js.
  showReplays(prefill = '') { import('./screens-extra.js').then((m) => m.showReplays(this, prefill)); }
  showDaily() { import('./screens-extra.js').then((m) => m.showDaily(this)); }
  openEditor() { import('../tools/editor.js').then((m) => { this.editor = this.editor || new m.Editor(this); this.editor.open(); }); }

  /** Resolve a replay's level definition. */
  levelForReplay(kind, ref) {
    if (kind === LK_CAMPAIGN) return CAMPAIGN[ref] ? { def: CAMPAIGN[ref], mode: 'campaign', index: ref } : null;
    if (kind === LK_CUSTOM) {
      const all = [...store.editorLevels()];
      const def = all.find((d) => levelHash(d) === ref);
      return def ? { def, mode: 'custom' } : null;
    }
    return null;
  }

  /** Validate a replay against a level: returns { ok, tick }. */
  checkReplay(def, runs) {
    const ctx = makeContext(compileLevel(def));
    const rb = rebuildCanon(ctx, runs);
    const last = rb.results[rb.results.length - 1];
    return { ok: rb.ok && last.status === ST_WON, tick: last ? last.tick : 0 };
  }

  toast(text) {
    const t = h('div.toast', { role: 'status' }, text);
    this.root.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  handleUrl() {
    const q = new URLSearchParams(location.search);
    if (q.get('level')) {
      const i = +q.get('level') - 1;
      if (CAMPAIGN[i]) { this.startLevel(CAMPAIGN[i], { mode: 'campaign', index: i }); return; }
    }
    if (q.get('replay')) {
      this.showTitle();
      import('./screens-extra.js').then((m) => m.showReplays(this, q.get('replay')));
      return;
    }
    this.showTitle();
  }
}

export { validateLevel, clear };
