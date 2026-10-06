// MIRRORFALL — CPU cost of one rendered frame, measured in Node (no GPU):
// simulation tick(s) + event handling + view model + sprite/instance building
// + light packing — i.e. all JavaScript work the browser does per frame,
// without the GL driver. Runs the bot solution of level 12 (3 ghosts, guard,
// camera, platform) in playback mode through the real GameSession.

import { CAMPAIGN } from '../../levels/campaign.js';
import { BOT_SOLUTIONS } from '../../levels/botsolutions.js';
import { decodeReplay } from '../../sim/replay.js';
import { GameSession } from '../../ui/game.js';
import { RendererGL } from '../../render/renderer-gl.js';
import { palette } from '../../render/palette.js';
import { TIERS } from '../../render/quality.js';

globalThis.performance ??= { now: () => Date.now() };
const pal = palette(false);
// Renderer stand-in: real CPU-side sprite + light packing, no GL calls.
const fake = Object.create(RendererGL.prototype);
Object.assign(fake, { spriteData: new Float32Array(2048 * 12), lightData: { A: new Float32Array(96), B: new Float32Array(96), C: new Float32Array(96), D: new Float32Array(96) }, tier: TIERS.high, pal });
let sprites = 0, lights = 0;
const renderer = {
  kind: 'bench', setLevel() {}, spawn() {},
  render(v, fx) { sprites = fake.buildSprites(v, fx); lights = fake.packLights(v); },
};
const hud = { setLevel() {}, loopStart() {}, banner() {}, clearBanner() {}, update() {} };
const audio = { sfx() {}, music: null };
const input = { mask: () => 0, takeCommands: () => [], takeAnyPress: () => true, clearHeld() {}, fastForward: () => false };

for (const lvl of [12, 11, 8]) {
  const def = CAMPAIGN[lvl - 1];
  const { runs } = decodeReplay(BOT_SOLUTIONS[def.id]);
  const s = new GameSession({ def, renderer, audio, input, hud, settings: { shake: true }, playback: { runs }, onEvent() {} });
  const times = [];
  for (let f = 0; f < 6000 && !s.resultShown; f++) {
    const t0 = performance.now();
    s.update(1 / 60);
    s.render(1 / 60);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.floor(times.length * p)].toFixed(3);
  console.log(`  L${lvl} ${def.name.padEnd(16)} ${times.length} Frames  CPU/Frame p50 ${q(0.5)} ms  p95 ${q(0.95)} ms  p99 ${q(0.99)} ms  max ${times[times.length - 1].toFixed(2)} ms  (${sprites} Sprites, ${lights} Lichter)`);
}
