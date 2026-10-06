// MIRRORFALL — colours and shapes.
// Every ghost and every signal channel has a colour AND a shape, so nothing
// is communicated by colour alone. The colour-blind palette (Okabe–Ito based)
// swaps the hues; shapes stay identical.

// Shape ids understood by the SDF sprite shader and the Canvas2D fallback.
export const SH = {
  CIRCLE: 0, TRIANGLE: 1, SQUARE: 2, DIAMOND: 3, STAR: 4, HEXAGON: 5, CROSS: 6, RING: 7,
  // non-glyph shapes
  BODY: 10, GUARD: 11, PAD: 12, DOOR: 13, GEM: 14, COIN: 15, LEVER: 16, BEAM: 17,
  TERMINAL: 18, EXIT: 19, VAULT: 20, CAMERA: 21, PLATFORM: 22, EMITTER: 23, GLOW: 24,
  ALERT: 25, ARROW: 26, SPAWN: 27, DOT: 28,
};

const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

const GHOSTS_NORMAL = ['#2ee6ff', '#ff3df0', '#ffb12e', '#8dff4f', '#c9b5ff'].map(hex);
const GHOSTS_CB = ['#56b4e9', '#e69f00', '#f0e442', '#009e73', '#cc79a7'].map(hex);
export const GHOST_SHAPES = [SH.CIRCLE, SH.TRIANGLE, SH.SQUARE, SH.DIAMOND, SH.STAR];
export const GHOST_NAMES = ['Kreis', 'Dreieck', 'Quadrat', 'Raute', 'Stern'];

// Channel hues deliberately avoid the ghost hues for the frequently used
// channels (0 = silver, 1 = red, 2 = green, 3 = violet); channels are also
// marked by k+1 pips, so they never depend on colour or glyph alone.
const CH_NORMAL = ['#e4eaff', '#ff4848', '#55ff8a', '#a87bff', '#ffe84a', '#4f7dff', '#ff5fae', '#3ec7ff'].map(hex);
const CH_CB = ['#ffffff', '#d55e00', '#009e73', '#cc79a7', '#f0e442', '#0072b2', '#e69f00', '#56b4e9'].map(hex);
export const CH_SHAPES = [SH.HEXAGON, SH.CROSS, SH.RING, SH.STAR, SH.TRIANGLE, SH.SQUARE, SH.DIAMOND, SH.CIRCLE];

export function palette(colorblind) {
  return {
    ghost: colorblind ? GHOSTS_CB : GHOSTS_NORMAL,
    channel: colorblind ? CH_CB : CH_NORMAL,
    guard: hex('#ffd9a0'),
    alarm: colorblind ? hex('#d55e00') : hex('#ff2a3a'),
    camera: colorblind ? hex('#e69f00') : hex('#ff5a3c'),
    laser: colorblind ? hex('#d55e00') : hex('#ff2468'),
    loot: hex('#ffd34a'),
    coin: hex('#ffcf3a'),
    exit: colorblind ? hex('#009e73') : hex('#3dff9a'),
    vault: hex('#7fd8ff'),
    floor: hex('#141a2b'),
    wall: hex('#0a0d18'),
    rimA: hex('#ff3df0'),
    rimB: hex('#2ee6ff'),
  };
}

/** Per-level neon accent colours derived from the seed (two hues). */
export function levelAccents(seed) {
  const sets = [
    ['#ff3df0', '#2ee6ff'], ['#ff6a2e', '#2ee6ff'], ['#9b5cff', '#3dffb5'],
    ['#ff2e7a', '#ffd23a'], ['#2e8bff', '#ff3df0'], ['#3dff9a', '#ff5a3c'],
  ];
  const s = sets[(seed >>> 0) % sets.length];
  return [hex(s[0]), hex(s[1])];
}

export const rgbCss = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
