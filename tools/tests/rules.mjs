// MIRRORFALL — rule scenario tests: each test builds a tiny level, scripts
// runner inputs and asserts the exact outcome defined in DESIGN.md §2.

import { compileLevel } from '../../sim/level.js';
import { makeContext, G_STATUS, G_STATUS_ARG, G_FAIL, G_VAULT_OPEN, GD_MODE, GD_SIZE, R_SIZE, R_COINS } from '../../sim/world.js';
import { simulateLoop, rebuildCanon } from '../../sim/timeline.js';
import {
  ST_WON, ST_CAUGHT, ST_PARADOX, ST_TIMEOUT, FAIL_GUARD, FAIL_LASER, FAIL_DIVERGED,
  EV_SPOTTED, EV_CAUGHT, EV_GUARD_HEAR, GM_INVESTIGATE, EV_DOOR_CLOSE,
} from '../../sim/constants.js';
import { script, check, summary, padMap } from './util.mjs';

function lvl(rows, extra = {}) {
  return compileLevel({ id: 't', name: 't', map: padMap(rows), ...extra });
}
/** Record runs in order and play `live` against them. */
function play(L, ghosts, live, opts = {}) {
  const ctx = makeContext(L);
  const rb = rebuildCanon(ctx, ghosts);
  if (!rb.ok) return { rebuildFailed: true, rb };
  return simulateLoop(ctx, ghosts, rb.canon, live, { events: true, ...opts });
}
const ST = ['RUN', 'WON', 'CAUGHT', 'PARADOX', 'TIMEOUT'];

console.log('Regeltests');

// 1. Plate held by a ghost opens the door for the live runner.
{
  const L = lvl([
    '##########',
    '#S.a....##',
    '#######A##',
    '#E....$.##',
  ]);
  const ghost = script('R2');
  const live = script('R6 D2 L6');
  const alone = play(L, [], live);
  check('Platte: ohne Geist bleibt die Tür zu', alone.status === ST_TIMEOUT, ST[alone.status]);
  const r = play(L, [ghost], live);
  check('Platte: Geist hält Platte → Sieg', r.status === ST_WON && r.arg === 1, `${ST[r.status]} t=${r.tick}`);
}

// 2. Coin theft creates a paradox for the ghost that originally took the coin.
{
  const L = lvl(['##########', '#S.o....E#', '#$#######']);
  const ghost = script('W60 R2');
  const thief = script('R2');
  const r = play(L, [ghost], thief);
  check('Münzdiebstahl → Paradox bei Geist 0', r.status === ST_PARADOX && r.arg === 0 && r.fail === FAIL_DIVERGED,
    `${ST[r.status]} arg=${r.arg} fail=${r.fail} t=${r.tick}`);
  const late = play(L, [ghost], script('W100 R2'));
  check('Spät kommen: kein Paradox', late.status === ST_TIMEOUT, ST[late.status]);
  const coins = late.world.s[late.world.ctx.lay.R + 1 * R_SIZE + R_COINS];
  check('Spät kommen: Münze bereits weg', coins === 0, 'coins=' + coins);
}

// 3. Guard sight cone: detection after exactly 24 continuously-seen ticks.
{
  const L = lvl([
    '##############',
    '#S...........#',
    '#$..........E#',
  ], { guards: [{ route: [{ x: 12, y: 1, wait: 1, look: 'L' }] }] });
  const r = play(L, [], script('R6 W200'));
  let spotted = -1, caught = -1;
  // re-run with tick hooks to time the events
  const ctx = makeContext(L);
  simulateLoop(ctx, [], [], script('R6 W200'), {
    events: true,
    onTick: (w) => {
      for (let k = 0; k < w.events.length; k += 3) {
        if (w.events[k] === EV_SPOTTED && spotted < 0) spotted = w.s[0];
        if (w.events[k] === EV_CAUGHT && caught < 0) caught = w.s[0];
      }
    },
  });
  check('Wache: Alarm', r.status === ST_CAUGHT && r.fail === FAIL_GUARD, ST[r.status]);
  check('Wache: genau 0,4 s (24 Ticks) bis Alarm', caught - spotted === 23, `spotted=${spotted} caught=${caught}`);
  const behind = play(L, [], script('D1 W300'));
  check('Wache: außerhalb Reichweite/Kegel kein Alarm', behind.status === ST_TIMEOUT, ST[behind.status]);
}
{
  // Wall blocks line of sight.
  const L = lvl([
    '##############',
    '#S.....#.....#',
    '#$......#..E.#',
  ], { guards: [{ route: [{ x: 11, y: 1, wait: 1, look: 'L' }] }] });
  const r = play(L, [], script('R5 W300'));
  check('Wache: Wand blockiert Sicht', r.status === ST_TIMEOUT, ST[r.status]);
}

// 4. Duo vault: both terminals held simultaneously for 30 ticks.
{
  const L = lvl([
    '############',
    '#T.S.T#####',
    '###V#######',
    '###$E######',
  ]);
  const ghost = script('L2 H');
  const live = script('R2 A30 L2 D2 R1');
  const r = play(L, [ghost], live);
  check('Duo-Tresor öffnet mit Geist', r.status === ST_WON, `${ST[r.status]} t=${r.tick}`);
  check('Duo-Tresor offen', r.world.s[G_VAULT_OPEN] === 1);
  const short = play(L, [ghost], script('R2 A20 L2 D2 R1'));
  check('Duo-Tresor: 20 Ticks reichen nicht', short.status !== ST_WON, ST[short.status]);
  const solo = play(L, [], live);
  check('Duo-Tresor: allein unmöglich', solo.status !== ST_WON, ST[solo.status]);
}

// 5. Moving platform: ride across the chasm.
{
  const L = lvl(['#########', '#S$~~~.E#', '#########'], {
    platforms: [{ x0: 3, y0: 1, x1: 5, y1: 1, dwell: 60 }],
  });
  const r = play(L, [], script('R1 R1 W70 R2'));
  check('Plattform: Überfahrt gelingt', r.status === ST_WON, `${ST[r.status]} t=${r.tick}`);
  const blocked = play(L, [], script('R1 W100 R4'));
  check('Plattform: Abgrund ohne Plattform nicht betretbar', blocked.status === ST_TIMEOUT, ST[blocked.status]);
}

// 6. Laser timing.
{
  const L = lvl(['#######', '#S...E#', '#$#####'], { lasers: [{ x: 3, y: 0, dir: 'D', on: 40, off: 40, ph: 0 }] });
  // Grab loot (down), back up, cross x=3 while the beam is off (ticks 40..79).
  const bad = play(L, [], script('D1 U1 R4'));
  check('Laser: im Takt "an" → Alarm', bad.status === ST_CAUGHT && bad.fail === FAIL_LASER, ST[bad.status] + ' t=' + bad.tick);
  const good = play(L, [], script('D1 U1 W24 R4'));
  check('Laser: im Takt "aus" → Durchkommen', good.status === ST_WON, ST[good.status] + ' t=' + good.tick);
}

// 7. Switch outcome divergence: ghost toggled ON, later runner toggles first.
{
  const L = lvl(['##########', '#S.1....E#', '#$########']);
  const ghost = script('R2 W80 T');
  const r = play(L, [ghost], script('R2 T'));
  check('Schalter: verändertes Ergebnis → Paradox', r.status === ST_PARADOX && r.arg === 0, ST[r.status]);
}

// 8. Coin lure: guard hears and investigates.
{
  const L = lvl([
    '################',
    '#So............#',
    '#$............E#',
  ], { guards: [{ route: [{ x: 10, y: 2, wait: 1, look: 'D' }] }] });
  let heard = false;
  const ctx = makeContext(L);
  const r = simulateLoop(ctx, [], [], script('R1 XR W40'), {
    events: true, maxTicks: 60,
    onTick: (w) => { for (let k = 0; k < w.events.length; k += 3) if (w.events[k] === EV_GUARD_HEAR) heard = true; },
  });
  check('Köder: Wache hört Münze', heard);
  check('Köder: Wache untersucht', r.world.s[ctx.lay.GD + GD_MODE] === GM_INVESTIGATE, 'mode=' + r.world.s[ctx.lay.GD + GD_MODE]);
}

// 9. A door cannot close while a runner stands in it.
{
  const L = lvl([
    '##########',
    '#S.a...###',
    '######A###',
    '#E$...####',
  ]);
  const ghost = script('R2 W30 L2');          // holds plate briefly, then leaves
  const live = script('R5 D1 W200');          // waits inside the doorway
  const r = play(L, [ghost], live, { maxTicks: 300 });
  let closes = 0;
  const ctx = makeContext(L);
  const rb = rebuildCanon(ctx, [ghost]);
  simulateLoop(ctx, [ghost], rb.canon, live, { events: true, maxTicks: 300, onTick: (w) => {
    for (let k = 0; k < w.events.length; k += 3) if (w.events[k] === EV_DOOR_CLOSE) closes++;
  } });
  check('Tür: bleibt offen, solange belegt', closes === 0 && r.world.s[0] === 300, 'closes=' + closes);
}

summary('Regeltests');
