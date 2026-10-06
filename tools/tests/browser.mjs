// MIRRORFALL — browser integration tests + frame-time report (d).
//
// Needs Playwright with a Chromium build (dev tool only, NOT a dependency of
// the game; looked up in the global npm root). Without a GPU, Chromium renders
// WebGL2 through SwiftShader on the CPU — frame times from this test are a
// worst case and NOT representative of real GPUs. The CPU-side cost per frame
// (simulation + view building + draw submission) is measured separately.
//
//   node tools/tests/browser.mjs [--quick]

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { startServer } from '../serve.mjs';
import { check, summary } from './util.mjs';

const quick = process.argv.includes('--quick');
let chromium;
try {
  const root = execSync('npm root -g').toString().trim();
  chromium = createRequire(root + '/')('playwright').chromium;
} catch {
  console.log('Playwright nicht gefunden — Browser-Tests übersprungen (npm i -g playwright).');
  process.exit(0);
}

const PORT = 8000 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}/`;
const server = await startServer(PORT);
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: GL_ARGS });
const report = { note: 'Headless Chromium + SwiftShader (CPU-Rasterizer, keine GPU). GPU-Frame-Zeiten sind Worst-Case; CPU-Kosten pro Frame sind repräsentativ.', runs: [] };

async function newPage(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 740 }, ...opts });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  return page;
}
/** Run a level session headlessly by calling update() with fixed dt (no rendering). */
const DRIVE = `async ({ lvl, useBot, maxUpdates }) => {
  const { CAMPAIGN } = await import('/levels/campaign.js');
  const { BOT_SOLUTIONS } = await import('/levels/botsolutions.js');
  const { decodeReplay } = await import('/sim/replay.js');
  const app = window.mirrorfall;
  const def = CAMPAIGN[lvl - 1];
  const { runs } = decodeReplay(BOT_SOLUTIONS[def.id]);
  app.startLevel(def, { mode: 'campaign', index: lvl - 1 });
  const s = app.session;
  // Perfect "player": feeds the bot's recorded inputs through the normal loop logic.
  s.liveMask = () => (runs[s.timeline.ghostCount] || [])[s.world.s[0]] || 0;
  s.input.anyPress = true;
  let n = 0, states = new Set();
  app.paused = true;   // stop the rAF loop from also updating
  while (n < maxUpdates && !s.resultShown) {
    if (s.state === 'ready') s.input.anyPress = true;
    s.update(1 / 60); n++; states.add(s.state);
  }
  return { state: s.state, ghosts: s.timeline.ghostCount, result: s.result && { tick: s.result.tick, stars: s.result.stars, verified: s.result.verified, log: s.result.log }, updates: n, states: [...states] };
}`;

console.log('Browser-Tests');
try {
  // 1. Boot (WebGL2) + title + keyboard menu navigation.
  {
    const page = await newPage();
    await page.goto(BASE);
    await page.waitForTimeout(1500);
    const kind = await page.evaluate(() => window.mirrorfall.renderer.kind);
    check('Start: WebGL2-Renderer aktiv', kind === 'webgl2', kind);
    await page.keyboard.press('ArrowDown');
    const f1 = await page.evaluate(() => document.activeElement.textContent);
    check('Menü: Pfeiltaste bewegt Fokus', f1 === 'Tagesrätsel', f1);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const title = await page.evaluate(() => document.querySelector('.screen:not(.hidden) h2')?.textContent);
    check('Menü: Enter öffnet Kampagne', /Kampagne/.test(title || ''), title);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const back = await page.evaluate(() => !!document.querySelector('.screen.title:not(.hidden)'));
    check('Menü: Escape führt zurück', back);
    check('Start: keine Konsolenfehler', page.errors.length === 0, page.errors.join(' | '));
    await page.close();
  }

  // 2. Full gameplay loop through the real session logic (L3: two ghosts → win → results).
  {
    const page = await newPage();
    await page.goto(BASE + '?q=low');
    await page.waitForTimeout(1000);
    const r = await page.evaluate(new Function(`return (${DRIVE})`)(), { lvl: 3, useBot: true, maxUpdates: 20000 });
    check('Spiel: L3 über Session-Logik gewonnen', r.state === 'won' && r.result, JSON.stringify(r));
    check('Spiel: 2 Geister aufgenommen', r.ghosts === 2, String(r.ghosts));
    check('Spiel: Zeitlinie beim Sieg unabhängig verifiziert', r.result && r.result.verified);
    check('Spiel: Zustände bereit→spielen→zurückspulen→Flucht durchlaufen', ['ready', 'play', 'rewind', 'won'].every((x) => r.states.includes(x)), r.states.join(','));
    await page.waitForTimeout(400);
    const res = await page.evaluate(() => ({ h: document.querySelector('.screen:not(.hidden) h2')?.textContent, share: document.querySelector('.share')?.textContent }));
    check('Ergebnis: Bildschirm erscheint', res.h === 'Flucht gelungen', res.h);
    check('Ergebnis: Share-String mit Emoji-Zusammenfassung', /MIRRORFALL/.test(res.share || '') && /🟦🟦🟩/.test(res.share || ''), res.share);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mirrorfall.progress.v1') || '{}').levels?.c03);
    check('Ergebnis: Bestzeit + Replay lokal gespeichert', stored && stored.best === r.result.tick && /^MF1\./.test(stored.replay), JSON.stringify(stored));
    check('Spiel: keine Konsolenfehler', page.errors.length === 0, page.errors.join(' | '));
    await page.close();
  }

  // 3. Paradox flow: coin theft in a mini level → paradox → timeline collapses.
  {
    const page = await newPage();
    await page.goto(BASE + '?q=low');
    await page.waitForTimeout(800);
    const r = await page.evaluate(async () => {
      const app = window.mirrorfall;
      const map = ['#'.repeat(30), '#S.o....E' + '.'.repeat(20) + '#', '#$' + '#'.repeat(28)];
      while (map.length < 17) map.push('##############################');
      app.startLevel({ id: 'tp', name: 'Paradox-Test', map }, { mode: 'custom' });
      const s = app.session;
      app.paused = true;
      const script = (src) => { const a = new Uint8Array(1800); let t = 0; for (const [m, n] of src) { a.fill(m, t, t + n); t += n; } return a; };
      const ghost = script([[0, 60], [8, 16]]);     // waits, then walks over the coin
      const thief = script([[8, 16]]);              // grabs the coin first
      let phase = 0;
      s.liveMask = () => (phase === 0 ? ghost : thief)[s.world.s[0]];
      const seen = [];
      for (let k = 0; k < 6000; k++) {
        if (s.state === 'ready') s.input.anyPress = true;
        s.update(1 / 60);
        if (seen[seen.length - 1] !== s.state) seen.push(s.state);
        if (phase === 0 && s.timeline.ghostCount === 1) phase = 1;
        if (s.state === 'paradox') break;
      }
      const before = s.timeline.ghostCount;
      const banner = document.querySelector('.hud-banner .big')?.textContent, why = document.querySelector('.hud-banner .sub')?.textContent;
      for (let k = 0; k < 400 && s.state !== 'ready'; k++) s.update(1 / 60);
      return { seen, before, after: s.timeline.ghostCount, banner, why, paradoxes: s.stats.paradoxes };
    });
    check('Paradox: wird ausgelöst', r.seen.includes('paradox'), r.seen.join('→'));
    check('Paradox: Zeitlinie bricht ab Geist 1 (Geister 1 → 0)', r.before === 1 && r.after === 0, `${r.before}→${r.after}`);
    check('Paradox: Zähler erhöht', r.paradoxes === 1);
    check('Paradox: Ursache wird erklärt (Münze weg)', /findet seine Münze nicht mehr/.test(r.why || ''), r.why);
    await page.close();
  }

  // 4. Replay import + ghost race + bot playback.
  {
    const page = await newPage();
    await page.goto(BASE + '?q=low');
    await page.waitForTimeout(800);
    const code = await page.evaluate(async () => (await import('/levels/botsolutions.js')).BOT_SOLUTIONS.c09);
    await page.evaluate((c) => window.mirrorfall.showReplays(c), code);
    await page.waitForTimeout(1200);
    const info = await page.evaluate(() => document.querySelector('.screen:not(.hidden) .note')?.textContent);
    check('Replay-Import: L9-Bot-Replay als gültig erkannt', /gültig/.test(info || '') && !/ungültig/.test(info || ''), info);
    const race = await page.evaluate(async (c) => {
      const { decodeReplay } = await import('/sim/replay.js');
      const { CAMPAIGN } = await import('/levels/campaign.js');
      const { runs } = decodeReplay(c);
      const app = window.mirrorfall;
      app.startLevel(CAMPAIGN[8], { mode: 'campaign', index: 8, rival: { runs } });
      return { finish: app.session.rival && app.session.rival.finishTick };
    }, code);
    check('Ghost-Rennen: Rivale geladen (Fluchtzeit bekannt)', race.finish > 0, JSON.stringify(race));
    await page.waitForTimeout(800);
    check('Replay/Rennen: keine Konsolenfehler', page.errors.length === 0, page.errors.join(' | '));
    await page.close();
  }

  // 5. Editor: keyboard edit, export, test mode, back.
  {
    const page = await newPage();
    await page.goto(BASE + '?q=low');
    await page.waitForTimeout(800);
    await page.evaluate(() => window.mirrorfall.openEditor());
    await page.waitForTimeout(1500);
    await page.focus('.editor canvas');
    await page.keyboard.press('KeyW');
    await page.keyboard.press('Space');            // wall at cursor (5,5)
    const cell = await page.evaluate(() => window.mirrorfall.editor.def.map[5][5]);
    check('Editor: Tastatur setzt Wand', cell === '#', cell);
    await page.keyboard.press('KeyZ');
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');            // laser on left wall (0,5)
    const lasers = await page.evaluate(() => window.mirrorfall.editor.def.lasers.length);
    check('Editor: Laser an Wand platziert', lasers === 1, String(lasers));
    await page.evaluate(() => window.mirrorfall.editor.cmd('export'));
    await page.waitForTimeout(300);
    const json = await page.evaluate(() => document.querySelector('.screen:not(.hidden) textarea')?.value);
    check('Editor: JSON-Export enthält Level', /"map"/.test(json || '') && /"lasers"/.test(json || ''));
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.mirrorfall.editor.cmd('test'));
    await page.waitForTimeout(600);
    const mode = await page.evaluate(() => window.mirrorfall.current?.mode);
    check('Editor: Test-Modus startet Level', mode === 'test', mode);
    await page.evaluate(() => window.mirrorfall.exitToMenu());
    await page.waitForTimeout(400);
    const back = await page.evaluate(() => window.mirrorfall.editor.active);
    check('Editor: Rückkehr aus dem Test-Modus', back === true);
    check('Editor: keine Konsolenfehler', page.errors.length === 0, page.errors.join(' | '));
    await page.close();
  }

  // 6. Daily challenge proven in the worker.
  {
    const page = await newPage();
    await page.goto(BASE + '?q=low');
    await page.waitForTimeout(800);
    await page.evaluate(() => window.mirrorfall.showDaily());
    await page.waitForFunction(() => /Lösbarkeit bewiesen|kein beweisbar/.test(document.querySelector('.screen:not(.hidden) p')?.textContent || ''), null, { timeout: 30000 });
    const t = await page.evaluate(() => document.querySelector('.screen:not(.hidden) p').textContent);
    check('Tagesrätsel: Lösbarkeit im Browser bewiesen', /Lösbarkeit bewiesen/.test(t), t);
    await page.close();
  }

  // 7. Settings persist (colour-blind, via keyboard focus + Space).
  {
    const page = await newPage();
    await page.goto(BASE);
    await page.waitForTimeout(800);
    await page.evaluate(() => window.mirrorfall.showSettings());
    // The menu focuses its first control in a rAF callback; wait until that happened.
    await page.waitForFunction(() => document.activeElement && document.activeElement.closest('.screen'), null, { timeout: 15000 });
    await page.focus('input[aria-label="Farbenblind-Modus"]');
    const focused = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
    check('Einstellungen: Schalter per Tastatur fokussierbar', focused === 'Farbenblind-Modus', focused);
    await page.keyboard.press('Space');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mirrorfall.settings.v1') || '{}').colorblind);
    check('Einstellungen: Farbenblind-Modus per Tastatur, gespeichert', saved === true);
    await page.close();
  }

  // 8. Fallbacks: forced Canvas2D, and WebGL2 unavailable.
  {
    const page = await newPage();
    await page.goto(BASE + '?r=2d&level=5');
    await page.waitForTimeout(1500);
    const k = await page.evaluate(() => window.mirrorfall.renderer.kind);
    check('Fallback: Canvas2D erzwungen', k === 'canvas2d', k);
    check('Fallback: Canvas2D ohne Fehler', page.errors.length === 0, page.errors.join(' | '));
    await page.close();
    const p2 = await newPage();
    await p2.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...a) { return type === 'webgl2' ? null : orig.call(this, type, ...a); };
    });
    await p2.goto(BASE + '?level=2');
    await p2.waitForTimeout(1500);
    const k2 = await p2.evaluate(() => window.mirrorfall.renderer.kind);
    check('Fallback: ohne WebGL2 automatisch Canvas2D', k2 === 'canvas2d', k2);
    check('Fallback: ohne WebGL2 keine Fehler', p2.errors.length === 0, p2.errors.join(' | '));
    await p2.close();
  }

  // 9. Mobile viewport: touch controls + follow camera.
  {
    const page = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(BASE + '?level=4&q=med');
    await page.waitForTimeout(1500);
    const vis = await page.evaluate(() => getComputedStyle(document.querySelector('.touch')).display !== 'none');
    check('Mobil: Touch-Steuerung sichtbar', vis);
    const tile = await page.evaluate(() => { const r = window.mirrorfall.renderer; return r.scale * 32 / (r.canvas.width / r.canvas.clientWidth); });
    check('Mobil: Kacheln ≥ 26 CSS-px (Kamera folgt)', tile >= 25.9, tile.toFixed(1));
    await page.touchscreen.tap(330, 760);
    check('Mobil: keine Konsolenfehler', page.errors.length === 0, page.errors.join(' | '));
    await page.close();
  }

  // 10. Audio: offline render of music (all ghost layers) + every SFX.
  {
    const page = await newPage();
    await page.goto(BASE);
    const r = await page.evaluate(async () => {
      const { AudioEngine } = await import('/audio/engine.js');
      const SR = 44100, DUR = 8;
      const ctx = new OfflineAudioContext(2, SR * DUR, SR);
      const eng = new AudioEngine({ master: 0.9, music: 0.8, sfx: 0.95, reducedMotion: false });
      eng.unlock(ctx);
      const m = eng.musicImpl;
      m.setLevel(1212, 'c12'); m.start(); m.setGhosts(4); m.tensionSm = 0.85;
      const sd = 60 / m.tempo / 4;
      for (let k = 0; k * sd < DUR - 0.5; k++) m.playStep(k, 0.05 + k * sd, sd, 0.85);
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(eng.sfx_)).filter((n) => !['constructor', 'out', 'osc', 'noise', 'envGain', 't'].includes(n));
      names.forEach((n, i) => ctx.suspend(0.2 + i * 0.3).then(() => { eng.lastPlay = {}; eng.sfx(n, { x: i }); ctx.resume(); }));
      const buf = await ctx.startRendering();
      let peak = 0, sum = 0, nan = 0, cnt = 0;
      for (let ch = 0; ch < 2; ch++) for (const v of buf.getChannelData(ch)) { if (!Number.isFinite(v)) { nan++; continue; } peak = Math.max(peak, Math.abs(v)); sum += v * v; cnt++; }
      return { effects: names.length, peak, rmsDb: 20 * Math.log10(Math.sqrt(sum / cnt)), nan };
    });
    console.log(`  Audio: ${r.effects} SFX + Musik (4 Geisterstimmen) offline gerendert: Spitze ${r.peak.toFixed(3)}, RMS ${r.rmsDb.toFixed(1)} dBFS`);
    check('Audio: kein Clipping (Limiter, Spitze < 1.0)', r.peak < 1.0, String(r.peak));
    check('Audio: hörbar (RMS > −40 dBFS) und keine NaN', r.rmsDb > -40 && r.nan === 0);
    check('Audio: alle SFX ohne Fehler', page.errors.length === 0, page.errors.join(' | '));
    await page.close();
  }

  // 11. Frame-time report (d).
  {
    const dur = quick ? 3000 : 6000;
    for (const cfg of ['q=low', 'q=med', 'q=high', 'r=2d']) {
      const page = await newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(`${BASE}?${cfg}`);
      await page.waitForTimeout(800);
      await page.evaluate(async () => {
        const { CAMPAIGN } = await import('/levels/campaign.js');
        const { BOT_SOLUTIONS } = await import('/levels/botsolutions.js');
        const { decodeReplay } = await import('/sim/replay.js');
        const { runs } = decodeReplay(BOT_SOLUTIONS.c12);
        window.mirrorfall.startLevel(CAMPAIGN[11], { mode: 'campaign', index: 11, playback: { runs } });
        window.mirrorfall.quality.mode = 'fixed';   // keep the tier for the measurement
      });
      await page.waitForTimeout(1500);   // skip shader compilation / warm-up
      await page.evaluate(() => { const p = window.mirrorfall.perf; p.cpu.length = 0; p.dts.length = 0; p.frames = 0; p.sim = []; p.perTick = []; });
      await page.waitForTimeout(dur);
      const r = await page.evaluate(() => {
        const p = window.mirrorfall.perf, R = window.mirrorfall.renderer;
        const st = (a) => { const s = a.slice().sort((x, y) => x - y); const q = (f) => s[Math.min(s.length - 1, Math.floor(s.length * f))]; return { mean: a.reduce((x, y) => x + y, 0) / a.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] }; };
        return { renderer: R.kind, tier: window.mirrorfall.quality.level, px: `${R.canvas.width}x${R.canvas.height}`, frames: p.frames, dt: st(p.dts), frameJs: st(p.cpu), sim: st(p.sim), perTick: st(p.perTick || [0]) };
      });
      const f = (x) => x.toFixed(2);
      console.log(`  Frame-Zeiten ${cfg.padEnd(7)} ${r.renderer}/${r.tier} ${r.px}: Frames=${r.frames} | dt Ø ${f(r.dt.mean)} p95 ${f(r.dt.p95)} ms | Sim+Logik pro 60-Hz-Tick Ø ${f(r.perTick.mean)} p95 ${f(r.perTick.p95)} ms | Frame inkl. GL-Submit Ø ${f(r.frameJs.mean)} ms`);
      report.runs.push({ cfg, ...r });
      check(`Perf ${cfg}: Simulation+Spiellogik pro Tick < 1 ms (p95)`, r.perTick.p95 < 1, f(r.perTick.p95));
      await page.close();
    }
    writeFileSync(new URL('./perf-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  }
} finally {
  await browser.close();
  server.close();
}
summary('Browser');
