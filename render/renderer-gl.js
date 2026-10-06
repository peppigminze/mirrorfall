// MIRRORFALL — WebGL2 renderer.
//
// Passes per frame:
//   1. scene  (MRT: albedo + emissive)  floor/walls shader, SDF sprites, GPU particles
//   2. light  (reduced resolution)      ≤24 point/cone/line lights, SDF soft shadows
//   3. composite                        albedo × light + emissive  → HDR
//   4. bloom                            prefilter → N-level 13-tap downsample → tent upsample
//   5. final                            tonemap, grade, chromatic aberration, scanlines,
//                                       vignette, grain, glitch, flash, screen shake
// Quality tiers only change uniforms and target sizes (render/quality.js).

import { program, texture, framebuffer, deleteFramebuffer, lin } from './gl.js';
import {
  FULLSCREEN_VS, FLOOR_FS, SPRITE_VS, SPRITE_FS, PARTICLE_VS, PARTICLE_FS, LIGHT_FS, COMPOSITE_FS,
  BLOOM_PREFILTER_FS, BLOOM_DOWN_FS, BLOOM_UP_FS, FINAL_FS, MAX_LIGHTS,
} from './shaders.js';
import { Particles } from './particles.js';
import { buildSdf, SDF_W, SDF_H } from './sdf.js';
import { WORLD_W, WORLD_H, occupancy, cameraFit } from './view.js';
import { TIERS } from './quality.js';
import { SH, GHOST_SHAPES, CH_SHAPES } from './palette.js';
import { GRID_W, GRID_H, TILE_PX } from '../sim/constants.js';

const SPRITE_FLOATS = 12;
const MAX_SPRITES = 2048;

export class RendererGL {
  constructor(canvas, settings) {
    this.kind = 'webgl2';
    this.canvas = canvas;
    this.settings = settings;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 nicht verfügbar');
    this.gl = gl;
    this.tier = TIERS.high;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.init(); if (this.L) this.setLevel(this.L, this.ctx, this.pal); this.resize(this.cssW, this.cssH, this.dpr); this.lost = false; });
    this.init();
  }

  init() {
    const gl = this.gl;
    this.floatOK = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.enc = this.floatOK ? 1 : 0.25;
    this.hdrFmt = this.floatOK ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    // Probe that half-float targets really work (some drivers expose the extension but fail).
    if (this.floatOK) {
      const probe = framebuffer(gl, 4, 4, this.hdrFmt, 2);
      if (!probe) { this.floatOK = false; this.enc = 0.25; this.hdrFmt = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE }; }
      else deleteFramebuffer(gl, probe);
    }
    this.progs = {
      floor: program(gl, FULLSCREEN_VS, FLOOR_FS, 'floor'),
      sprite: program(gl, SPRITE_VS, SPRITE_FS, 'sprite'),
      particle: program(gl, PARTICLE_VS, PARTICLE_FS, 'particle'),
      light: program(gl, FULLSCREEN_VS, LIGHT_FS, 'light'),
      composite: program(gl, FULLSCREEN_VS, COMPOSITE_FS, 'composite'),
      prefilter: program(gl, FULLSCREEN_VS, BLOOM_PREFILTER_FS, 'prefilter'),
      down: program(gl, FULLSCREEN_VS, BLOOM_DOWN_FS, 'down'),
      up: program(gl, FULLSCREEN_VS, BLOOM_UP_FS, 'up'),
      final: program(gl, FULLSCREEN_VS, FINAL_FS, 'final'),
    };
    // Full-screen triangle pair.
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // Sprites: unit quad corners + instance buffer.
    this.spriteData = new Float32Array(MAX_SPRITES * SPRITE_FLOATS);
    this.spriteVao = gl.createVertexArray();
    gl.bindVertexArray(this.spriteVao);
    const cb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.spriteBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.spriteData.byteLength, gl.DYNAMIC_DRAW);
    for (let a = 1; a <= 3; a++) {
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 4, gl.FLOAT, false, SPRITE_FLOATS * 4, (a - 1) * 16);
      gl.vertexAttribDivisor(a, 1);
    }
    // Particles.
    this.particles = new Particles(gl, 4096);
    this.particleVao = gl.createVertexArray();
    gl.bindVertexArray(this.particleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.particles.setupAttribs();
    gl.bindVertexArray(null);

    this.tileTex = texture(gl, GRID_W, GRID_H, { filter: gl.NEAREST });
    this.sdfTex = texture(gl, SDF_W, SDF_H, { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR });
    this.targets = null;
    this.lightData = { A: new Float32Array(MAX_LIGHTS * 4), B: new Float32Array(MAX_LIGHTS * 4), C: new Float32Array(MAX_LIGHTS * 4), D: new Float32Array(MAX_LIGHTS * 4) };
    this.time0 = performance.now();
    this.occKey = null;
  }

  setQuality(tier) {
    this.tier = tier;
    if (this.cssW) this.resize(this.cssW, this.cssH, this.dpr);
  }

  resize(w, h, dpr) {
    this.cssW = w; this.cssH = h; this.dpr = dpr;
    const gl = this.gl;
    const eff = Math.min(dpr, this.tier.maxDpr) * this.tier.resScale;
    const W = Math.max(64, Math.round(w * eff)), H = Math.max(64, Math.round(h * eff));
    this.canvas.width = W; this.canvas.height = H;
    this.W = W; this.H = H;
    this.pxPerCss = eff;
    const cam = cameraFit(W, H, eff, null);
    this.scale = cam.scale; this.offX = cam.offX; this.offY = cam.offY;
    // (Re)create render targets.
    if (this.targets) {
      for (const k of ['scene', 'light', 'hdr']) deleteFramebuffer(gl, this.targets[k]);
      for (const m of this.targets.mips) deleteFramebuffer(gl, m);
    }
    const lw = Math.max(32, Math.round(W * this.tier.lightScale)), lh = Math.max(32, Math.round(H * this.tier.lightScale));
    const t = { scene: framebuffer(gl, W, H, this.hdrFmt, 2), light: framebuffer(gl, lw, lh, this.hdrFmt), hdr: framebuffer(gl, W, H, this.hdrFmt), mips: [] };
    let mw = W >> 1, mh = H >> 1;
    for (let i = 0; i < this.tier.bloomLevels && mw >= 8 && mh >= 8; i++) {
      t.mips.push(framebuffer(gl, mw, mh, this.hdrFmt));
      mw >>= 1; mh >>= 1;
    }
    this.targets = t;
  }

  setLevel(L, ctx, pal) {
    this.L = L; this.ctx = ctx; this.pal = pal;
    const gl = this.gl;
    const data = new Uint8Array(GRID_W * GRID_H * 4);
    let h = L.seed >>> 0;
    for (let c = 0; c < GRID_W * GRID_H; c++) {
      h = (Math.imul(h ^ (h >>> 13), 0x5bd1e995) + c) >>> 0;
      data[c * 4] = L.tile[c];
      data[c * 4 + 1] = L.obj[c];
      data[c * 4 + 2] = 0;
      data[c * 4 + 3] = h & 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GRID_W, GRID_H, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.occKey = null;
    const acc = pal ? null : null;
    void acc;
  }

  spawn(kind, x, y, color, n = 12) {
    const k = this.tier.particles ?? 1;
    this.particles.emit(kind, x, y, color, Math.max(1, Math.round(n * k)), this.now(), !!this.settings.reducedMotion);
  }
  now() { return (performance.now() - this.time0) / 1000; }

  updateSdf(v, state) {
    if (v.occupancyKey === this.occKey) return;
    this.occKey = v.occupancyKey;
    const occ = occupancy(this.L, state, this.ctx.lay);
    const sdf = buildSdf(occ);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTex.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SDF_W, SDF_H, gl.RED, gl.UNSIGNED_BYTE, sdf);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  // ------------------------------------------------------------- sprites
  buildSprites(v, fx) {
    const d = this.spriteData;
    let n = 0;
    const pal = this.pal;
    const L = (c) => [lin(c[0]), lin(c[1]), lin(c[2])];
    const add = (x, y, sx, sy, col, a, shape, emis = 0, rot = 0, param = 0) => {
      if (n >= MAX_SPRITES) return;
      const o = n * SPRITE_FLOATS;
      d[o] = x; d[o + 1] = y; d[o + 2] = sx; d[o + 3] = sy;
      d[o + 4] = col[0]; d[o + 5] = col[1]; d[o + 6] = col[2]; d[o + 7] = a;
      d[o + 8] = rot; d[o + 9] = shape; d[o + 10] = emis; d[o + 11] = param;
      n++;
    };
    const t = v.time;
    const black = [0, 0, 0];
    const white = [1, 1, 1];
    const chan = pal.channel.map(L), ghost = pal.ghost.map(L);
    const exitC = L(pal.exit), lootC = L(pal.loot), coinC = L(pal.coin), alarmC = L(pal.alarm), laserC = L(pal.laser);

    // Spawn pad and exits.
    add(v.spawn.x, v.spawn.y, 13, 13, [0.25, 0.3, 0.5], 0.6, 31, 0.5, 0, 2);
    for (const e of v.exits) {
      const pulse = 0.6 + 0.4 * Math.sin(t * 3);
      add(e.x, e.y, 14, 14, exitC, 0.3, 32, 0.25, 0, 3);
      add(e.x, e.y, 14, 14, exitC, 0.9, 38, 1, 0, 2);
      for (let k = -1; k <= 1; k += 2) add(e.x + k * 9, e.y + 9, 3, 1, exitC, 0.7, 32, 1);
      add(e.x, e.y - 2 + Math.sin(t * 4) * 2, 6, 6, exitC, pulse, SH.TRIANGLE, 1);
    }
    // Plates.
    for (const P of v.plates) {
      const c = chan[P.ch];
      add(P.x, P.y, 13, 13, P.pressed ? c : [c[0] * 0.25, c[1] * 0.25, c[2] * 0.25], 1, 37, P.pressed ? 0.55 : 0.1);
      add(P.x, P.y, 5.5, 5.5, P.pressed ? white : c, 1, CH_SHAPES[P.ch], P.pressed ? 1 : 0.85);
    }
    // Switches.
    for (const S of v.switches) {
      const c = chan[S.ch];
      add(S.x, S.y, 11, 11, [0.08, 0.1, 0.16], 1, 32, 0, 0, 3);
      add(S.x, S.y, 11, 11, c, 0.8, 38, 0.6, 0, 1.5);
      const ang = S.on ? -0.6 : -2.55;
      add(S.x + Math.cos(ang) * 5, S.y + Math.sin(ang) * 5, 7, 2.5, S.on ? c : [0.6, 0.65, 0.8], 1, 34, S.on ? 1 : 0.2, ang);
      add(S.x, S.y + 6, 3.5, 3.5, c, 1, CH_SHAPES[S.ch], 1);
    }
    // Terminals + vault.
    for (const T of v.terminals) {
      add(T.x, T.y, 12, 10, [0.09, 0.13, 0.2], 1, 32, 0, 0, 3);
      const sc = T.held ? [0.2, 1, 0.8] : [0.15, 0.4, 0.9];
      add(T.x, T.y - 1, 8, 5, sc, 1, 32, T.held ? 1 : 0.6, 0, 1.5);
      if (v.vault && T.held && v.vault.prog > 0 && !v.vault.logicOpen) add(T.x, T.y, 15, 15, [0.3, 1, 0.9], 1, 36, 1, 0, v.vault.prog);
    }
    if (v.vault) {
      for (const c of v.vault.cells) {
        const o = v.vault.open;
        add(c.x, c.y, 16 * (1 - o * 0.85), 16, [0.14, 0.2, 0.3], 1, 32, 0.05, 0, 3);
        add(c.x, c.y, 11, 11, [0.5, 0.85, 1], 1 - o, 36, 0.8, t * 0.5, Math.max(v.vault.prog, 0.08));
        add(c.x, c.y, 3, 3, [0.5, 0.85, 1], 1 - o, 30, 1);
      }
    }
    // Doors: two sliding panels.
    for (const D of v.doors) {
      const c = chan[D.ch], o = D.open, len = 16 * (1 - o);
      const dark = [c[0] * 0.18 + 0.03, c[1] * 0.18 + 0.03, c[2] * 0.18 + 0.05];
      if (D.horiz) {
        if (len > 0.5) {
          add(D.x - 16 + len / 2, D.y, len / 2, 6, dark, 1, 32, 0.05, 0, 1.5);
          add(D.x + 16 - len / 2, D.y, len / 2, 6, dark, 1, 32, 0.05, 0, 1.5);
          add(D.x - 16 + len / 2, D.y, len / 2, 1.2, c, 1, 32, 1);
          add(D.x + 16 - len / 2, D.y, len / 2, 1.2, c, 1, 32, 1);
        }
      } else if (len > 0.5) {
        add(D.x, D.y - 16 + len / 2, 6, len / 2, dark, 1, 32, 0.05, 0, 1.5);
        add(D.x, D.y + 16 - len / 2, 6, len / 2, dark, 1, 32, 0.05, 0, 1.5);
        add(D.x, D.y - 16 + len / 2, 1.2, len / 2, c, 1, 32, 1);
        add(D.x, D.y + 16 - len / 2, 1.2, len / 2, c, 1, 32, 1);
      }
      add(D.x, D.y, 5, 5, c, 0.6 + 0.4 * (1 - o), CH_SHAPES[D.ch], 1);
      if (D.inv) add(D.x, D.y, 9, 9, c, 0.7, 31, 1, 0, 1.2);   // inverted door marker (ring)
    }
    // Platforms.
    for (const P of v.platforms) {
      add(P.x, P.y + 3, 16, 16, black, 0.45, 32, 0, 0, 4);
      add(P.x, P.y, 15, 15, [0.16, 0.19, 0.27], 1, 32, 0.02, 0, 3);
      add(P.x, P.y, 15, 15, [0.4, 0.6, 1], 0.9, 38, 0.9, 0, 1.4);
      for (const [dx, dy] of [[-10, -10], [10, -10], [-10, 10], [10, 10]]) add(P.x + dx, P.y + dy, 1.8, 1.8, [0.5, 0.8, 1], 1, 30, 1);
    }
    // Coins, loot, thrown coins.
    for (const C of v.coins) {
      add(C.x, C.y, 9, 9, coinC, 0.25, 33, 1);
      add(C.x, C.y, 4.5, 4.5, coinC, 1, 30, 0.7);
      add(C.x - 1.2, C.y - 1.2, 1.5, 1.5, white, 0.9, 30, 1);
    }
    for (const c of v.thrown) {
      if (!c.landed) add(c.x, c.y + 3, 4, 2.5, black, 0.4, 30, 0);
      add(c.x, c.y - c.h, 4, 4, coinC, c.landed ? 0.6 : 1, 30, 0.9);
      if (c.landed) add(c.x, c.y, 14 + 10 * (1 - c.life), 14 + 10 * (1 - c.life), coinC, 0.25 * c.life, 31, 1, 0, 1);
    }
    if (v.loot) {
      const bob = v.loot.carriedBy >= 0 ? 0 : Math.sin(t * 2.5) * 2;
      const s = v.loot.carriedBy >= 0 ? 5.5 : 8;
      add(v.loot.x, v.loot.y + bob, s * 2.6, s * 2.6, lootC, 0.5, 33, 1);
      add(v.loot.x, v.loot.y + bob, s, s, lootC, 1, SH.DIAMOND, 0.85, t * 0.6);
      add(v.loot.x - s * 0.25, v.loot.y + bob - s * 0.3, s * 0.3, s * 0.3, white, 0.9, SH.DIAMOND, 1, t * 0.6);
    }
    // Lasers.
    for (const Z of v.lasers) {
      const ex = Z.ex, ey = Z.ey;
      add(ex, ey, 6, 6, [0.12, 0.08, 0.1], 1, 32, 0, 0, 2);
      add(ex, ey, 2.5, 2.5, laserC, 1, 30, Z.on ? 1 : 0.3);
      if (Z.ch >= 0) add(ex - (Z.dir > 1 ? 0 : 0), ey, 3, 3, chan[Z.ch], 1, CH_SHAPES[Z.ch], 1);
      const mx = (Z.x0 + Z.x1) / 2, my = (Z.y0 + Z.y1) / 2;
      const len = Math.hypot(Z.x1 - Z.x0, Z.y1 - Z.y0) / 2;
      const rot = Math.atan2(Z.y1 - Z.y0, Z.x1 - Z.x0);
      if (Z.on) add(mx, my, len + 6, 6, laserC, 1, 34, 1, rot);
      else if (Z.warn > 0) add(mx, my, len + 4, 4, laserC, 0.25 * Z.warn * (0.5 + 0.5 * Math.sin(t * 40)), 34, 1, rot);
      if (fx.colorblind && Z.on) {
        for (let k = 0; k < len * 2; k += 14) add(Z.x0 + Math.cos(rot) * k, Z.y0 + Math.sin(rot) * k, 2, 2, white, 1, 30, 1);
      }
    }
    // Rewind trails.
    if (fx.trails) for (const tr of fx.trails) add(tr.x, tr.y, 13, 13, ghost[tr.i], 0.35 * tr.a, 33, 1);
    // Guards.
    for (const G of v.guards) {
      add(G.x, G.y + 3, 13, 13, black, 0.45, 30, 0);
      const coat = [0.18 + G.alert * 0.4, 0.15, 0.12];
      add(G.x, G.y, 11, 11, coat, 1, 32, 0.02, G.ang, 5);
      add(G.x - Math.cos(G.ang) * 2, G.y - Math.sin(G.ang) * 2, 6, 6, [0.55, 0.45, 0.38], 1, 30, 0);
      add(G.x + Math.cos(G.ang) * 10, G.y + Math.sin(G.ang) * 10, 2.8, 2.8, [1, 0.9, 0.7], 1, 30, 1);
      if (G.alert > 0) {
        const a = 0.6 + 0.4 * Math.sin(t * 30);
        add(G.x, G.y - 22, 2, 6, alarmC, a, 32, 1, 0, 1);
        add(G.x, G.y - 13, 2, 2, alarmC, a, 30, 1);
        add(G.x, G.y, 17, 17, alarmC, 1, 36, 1, 0, G.alert);
      } else if (G.curious) {
        add(G.x, G.y - 20, 5, 5, [1, 0.85, 0.3], 0.9, 35, 1, Math.PI * 0.75, 2.2);
        add(G.x, G.y - 12.5, 1.6, 1.6, [1, 0.85, 0.3], 0.9, 30, 1);
      }
    }
    // Cameras.
    for (const Cm of v.cameras) {
      add(Cm.x, Cm.y, 9, 9, [0.1, 0.11, 0.15], 1, 32, 0, 0, 3);
      add(Cm.x + Math.cos(Cm.ang) * 6, Cm.y + Math.sin(Cm.ang) * 6, 7, 4, [0.6, 0.62, 0.7], 1, 32, 0, Cm.ang, 2);
      add(Cm.x + Math.cos(Cm.ang) * 12, Cm.y + Math.sin(Cm.ang) * 12, 2.5, 2.5, Cm.on ? [1, 0.2, 0.15] : [0.2, 0.2, 0.2], 1, 30, Cm.on ? 1 : 0);
      if (Cm.alert > 0) add(Cm.x, Cm.y, 14, 14, alarmC, 1, 36, 1, 0, Cm.alert);
    }
    // Rival (ghost race): hollow silhouette.
    if (fx.rival) {
      add(fx.rival.x, fx.rival.y, 12, 12, white, fx.rival.done ? 0.3 : 0.75, 31, 1, 0, 1.5);
      add(fx.rival.x, fx.rival.y, 3, 3, white, 0.8, 30, 1);
    }
    // Runners.
    for (const r of v.runners) {
      const c = ghost[r.i];
      const ghostly = !r.live;
      if (!r.alive && !r.live && fx.paradoxRunner !== r.i) continue;
      const flick = ghostly ? 0.82 + 0.18 * Math.sin(t * 9 + r.i * 2) : 1;
      const alpha = ghostly ? 0.8 * flick : 1;
      add(r.x, r.y + 3, 11, 11, black, 0.45 * alpha, 30, 0);
      add(r.x, r.y, ghostly ? 20 : 26, ghostly ? 20 : 26, c, ghostly ? 0.14 : 0.22, 33, 1);
      add(r.x, r.y, 10.5, 10.5, [0.04, 0.05, 0.08], ghostly ? 0.6 : 1, 30, 0);
      add(r.x, r.y, 10.5, 10.5, c, alpha, 31, 1, 0, ghostly ? 1.8 : 2.4);
      add(r.x, r.y, ghostly ? 5.5 : 5, ghostly ? 5.5 : 5, c, alpha, GHOST_SHAPES[r.i], 1);
      add(r.x, r.y, 14.5, 14.5, c, alpha * 0.9, 35, 1, r.face, 0.55);
      if (r.carry) add(r.x, r.y - 15, 4, 4, lootC, 1, SH.DIAMOND, 1);
      for (let k = 0; k < r.coins; k++) add(r.x - 6 + k * 6, r.y + 15, 2.2, 2.2, coinC, alpha, 30, 1);
      if (r.hold) add(r.x, r.y, 18, 18, [0.3, 1, 0.9], 0.8, 31, 1, 0, 1.2);
      if (r.susp > 0 && r.alive) add(r.x, r.y, 18, 18, alarmC, 1, 36, 1, 0, Math.min(1, r.susp));
      if (fx.paradoxRunner === r.i) {
        const pr = 20 + 5 * Math.sin(t * 25);
        add(r.x, r.y, pr, pr, [1, 0.1, 0.8], 1, 31, 1, 0, 3);
        add(r.x, r.y, 34, 34, [1, 0.1, 0.8], 0.6, 33, 1);
      }
      if (fx.ready && r.live) {
        const pr = 18 + 4 * Math.sin(t * 5);
        add(r.x, r.y, pr, pr, c, 0.7, 31, 1, 0, 1.2);
      }
    }
    return n;
  }

  // ------------------------------------------------------------- lights
  packLights(v) {
    const ld = this.lightData;
    const live = v.runners.find((r) => r.live);
    const lx = live ? live.x : WORLD_W / 2, ly = live ? live.y : WORLD_H / 2;
    const scored = v.lights.map((l) => {
      let p = l.type === 1 ? 1000 : 0;
      p += l.intensity * 10;
      p -= Math.hypot(l.x - lx, l.y - ly) * 0.02;
      return [p, l];
    }).sort((a, b) => b[0] - a[0]);
    const max = Math.min(MAX_LIGHTS, this.tier.maxLights);
    let n = 0;
    for (const [, l] of scored) {
      if (n >= max) break;
      const o = n * 4;
      ld.A[o] = l.x; ld.A[o + 1] = l.y; ld.A[o + 2] = l.r; ld.A[o + 3] = l.type;
      ld.B[o] = lin(l.color[0]); ld.B[o + 1] = lin(l.color[1]); ld.B[o + 2] = lin(l.color[2]); ld.B[o + 3] = l.intensity;
      if (l.type === 1) { ld.C[o] = l.dx; ld.C[o + 1] = l.dy; ld.C[o + 2] = l.cosO; ld.C[o + 3] = l.cosI; }
      else if (l.type === 2) { ld.C[o] = l.x2; ld.C[o + 1] = l.y2; ld.C[o + 2] = 0; ld.C[o + 3] = 0; }
      ld.D[o] = l.shadow ? 1 : 0; ld.D[o + 1] = l.cone || 0; ld.D[o + 2] = 0; ld.D[o + 3] = 0;
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------- render
  drawQuad() { const gl = this.gl; gl.bindVertexArray(this.quadVao); gl.drawArrays(gl.TRIANGLES, 0, 6); }
  bindTarget(f) {
    const gl = this.gl;
    if (f) { gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb); gl.viewport(0, 0, f.w, f.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.W, this.H); }
  }
  useTex(unit, tex) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); }

  render(v, fx) {
    if (this.lost || !this.targets || !this.L) return;
    const gl = this.gl, P = this.progs, T = this.targets, tier = this.tier;
    this.updateSdf(v, fx.state);
    const time = this.now();
    const cam = cameraFit(this.W, this.H, this.pxPerCss, fx.cam, fx.insets);
    this.scale = cam.scale; this.offX = cam.offX; this.offY = cam.offY;
    const shX = (fx.shakeX || 0) * this.scale, shY = (fx.shakeY || 0) * this.scale;
    const offX = this.offX + shX, offY = this.offY + shY;
    gl.disable(gl.DEPTH_TEST);

    // 1. Scene: floor/walls.
    this.bindTarget(T.scene);
    gl.disable(gl.BLEND);
    let pr = P.floor;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u.uRes, this.W, this.H);
    gl.uniform1f(pr.u.uScale, this.scale);
    gl.uniform2f(pr.u.uOff, offX, offY);
    gl.uniform1f(pr.u.uTime, time);
    gl.uniform1f(pr.u.uEnc, this.enc);
    const acc = v.accents;
    gl.uniform3f(pr.u.uAccA, lin(acc[0][0]), lin(acc[0][1]), lin(acc[0][2]));
    gl.uniform3f(pr.u.uAccB, lin(acc[1][0]), lin(acc[1][1]), lin(acc[1][2]));
    this.useTex(0, this.tileTex.tex); gl.uniform1i(pr.u.uTiles, 0);
    this.useTex(1, this.sdfTex.tex); gl.uniform1i(pr.u.uSdf, 1);
    this.drawQuad();

    // Sprites (premultiplied alpha on both attachments).
    const ns = this.buildSprites(v, fx);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    pr = P.sprite;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u.uRes, this.W, this.H);
    gl.uniform1f(pr.u.uScale, this.scale);
    gl.uniform2f(pr.u.uOff, offX, offY);
    gl.uniform1f(pr.u.uTime, time);
    gl.uniform1f(pr.u.uEnc, this.enc);
    gl.bindVertexArray(this.spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.spriteData, 0, ns * SPRITE_FLOATS);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, ns);

    // Particles (additive into emissive; albedo untouched because alpha = 0).
    this.particles.flush();
    pr = P.particle;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u.uRes, this.W, this.H);
    gl.uniform1f(pr.u.uScale, this.scale);
    gl.uniform2f(pr.u.uOff, offX, offY);
    gl.uniform1f(pr.u.uTime, time);
    gl.uniform1f(pr.u.uEnc, this.enc);
    gl.bindVertexArray(this.particleVao);
    this.particles.draw(time);
    gl.disable(gl.BLEND);

    // 2. Lights.
    this.bindTarget(T.light);
    pr = P.light;
    gl.useProgram(pr.p);
    const nl = this.packLights(v);
    const ls = T.light.w / this.W;
    gl.uniform2f(pr.u.uRes, T.light.w, T.light.h);
    gl.uniform1f(pr.u.uScale, this.scale * ls);
    gl.uniform2f(pr.u.uOff, offX * ls, offY * ls);
    gl.uniform4fv(pr.u.uLA, this.lightData.A);
    gl.uniform4fv(pr.u.uLB, this.lightData.B);
    gl.uniform4fv(pr.u.uLC, this.lightData.C);
    gl.uniform4fv(pr.u.uLD, this.lightData.D);
    gl.uniform1i(pr.u.uLN, nl);
    gl.uniform1i(pr.u.uSteps, tier.steps);
    gl.uniform3f(pr.u.uAmbient, 0.045, 0.05, 0.08);
    gl.uniform1f(pr.u.uHatch, fx.colorblind ? 1 : 0);
    gl.uniform1f(pr.u.uTime, time);
    gl.uniform1f(pr.u.uEnc, this.enc);
    this.useTex(0, this.sdfTex.tex); gl.uniform1i(pr.u.uSdf, 0);
    this.drawQuad();

    // 3. Composite.
    this.bindTarget(T.hdr);
    pr = P.composite;
    gl.useProgram(pr.p);
    this.useTex(0, T.scene.texs[0].tex); gl.uniform1i(pr.u.uAlbedo, 0);
    this.useTex(1, T.scene.texs[1].tex); gl.uniform1i(pr.u.uEmis, 1);
    this.useTex(2, T.light.tex); gl.uniform1i(pr.u.uLight, 2);
    gl.uniform1f(pr.u.uEnc, this.enc);
    this.drawQuad();

    // 4. Bloom.
    const mips = T.mips;
    if (mips.length) {
      this.bindTarget(mips[0]);
      pr = P.prefilter;
      gl.useProgram(pr.p);
      this.useTex(0, T.hdr.tex); gl.uniform1i(pr.u.uSrc, 0);
      gl.uniform2f(pr.u.uTexel, 1 / T.hdr.w, 1 / T.hdr.h);
      gl.uniform1f(pr.u.uThreshold, 1.0 * this.enc);
      this.drawQuad();
      pr = P.down;
      gl.useProgram(pr.p);
      for (let i = 1; i < mips.length; i++) {
        this.bindTarget(mips[i]);
        this.useTex(0, mips[i - 1].tex); gl.uniform1i(pr.u.uSrc, 0);
        gl.uniform2f(pr.u.uTexel, 1 / mips[i - 1].w, 1 / mips[i - 1].h);
        this.drawQuad();
      }
      pr = P.up;
      gl.useProgram(pr.p);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = mips.length - 1; i > 0; i--) {
        this.bindTarget(mips[i - 1]);
        this.useTex(0, mips[i].tex); gl.uniform1i(pr.u.uSrc, 0);
        gl.uniform2f(pr.u.uTexel, 1 / mips[i].w, 1 / mips[i].h);
        gl.uniform1f(pr.u.uRadius, 1.0);
        this.drawQuad();
      }
      gl.disable(gl.BLEND);
    }

    // 5. Final.
    this.bindTarget(null);
    pr = P.final;
    gl.useProgram(pr.p);
    this.useTex(0, T.hdr.tex); gl.uniform1i(pr.u.uHdr, 0);
    this.useTex(1, mips.length ? mips[0].tex : T.hdr.tex); gl.uniform1i(pr.u.uBloom, 1);
    const reduced = !!fx.reducedMotion;
    gl.uniform2f(pr.u.uRes, this.W, this.H);
    gl.uniform1f(pr.u.uTime, time);
    gl.uniform1f(pr.u.uBloomStr, mips.length ? 0.42 + (fx.won || 0) * 0.3 : 0);
    gl.uniform1f(pr.u.uExposure, 1.15);
    gl.uniform1f(pr.u.uChroma, tier.chroma ? (reduced ? 0.3 : 1) : 0);
    gl.uniform1f(pr.u.uScan, 0.15);
    gl.uniform1f(pr.u.uGrain, reduced ? tier.grain * 0.5 : tier.grain);
    gl.uniform1f(pr.u.uVignette, 0.85);
    gl.uniform1f(pr.u.uGlitch, fx.glitch || 0);
    gl.uniform1f(pr.u.uRewind, reduced ? (fx.rewind || 0) * 0.4 : (fx.rewind || 0));
    gl.uniform1f(pr.u.uFlash, fx.flash || 0);
    const fc = (fx.flashColor || '255,40,60').split(',').map((x) => +x / 255);
    gl.uniform3f(pr.u.uFlashCol, fc[0], fc[1], fc[2]);
    gl.uniform1f(pr.u.uDesat, fx.ready ? 0.25 : 0);
    gl.uniform1f(pr.u.uWin, fx.won || 0);
    gl.uniform1f(pr.u.uFade, 1);
    gl.uniform1f(pr.u.uEnc, this.enc);
    this.drawQuad();
  }

  destroy() {}
}

export { TILE_PX };
