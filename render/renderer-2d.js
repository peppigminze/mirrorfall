// MIRRORFALL — Canvas2D fallback renderer.
// Used when WebGL2 is unavailable. Same view model as the WebGL renderer:
// scene → light layer (ambient + gradients, guard/camera cones ray-cast on the
// CPU against the occupancy grid) multiplied on top → emissive additive layer.

import { GRID_W, GRID_H, TILE_PX } from '../sim/constants.js';
import { WORLD_W, WORLD_H, occupancy, cameraFit } from './view.js';
import { SH, GHOST_SHAPES, CH_SHAPES, rgbCss } from './palette.js';

export function drawGlyph(g, shape, x, y, r) {
  g.beginPath();
  switch (shape) {
    case SH.CIRCLE: g.arc(x, y, r, 0, Math.PI * 2); break;
    case SH.RING: g.arc(x, y, r, 0, Math.PI * 2); g.moveTo(x + r * 0.55, y); g.arc(x, y, r * 0.55, 0, Math.PI * 2, true); break;
    case SH.TRIANGLE: g.moveTo(x, y - r); g.lineTo(x + r * 0.95, y + r * 0.7); g.lineTo(x - r * 0.95, y + r * 0.7); g.closePath(); break;
    case SH.SQUARE: g.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6); break;
    case SH.DIAMOND: g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); break;
    case SH.STAR:
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r;
        const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
        if (k) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.closePath(); break;
    case SH.HEXAGON:
      for (let k = 0; k < 6; k++) {
        const a = k * Math.PI / 3, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (k) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.closePath(); break;
    case SH.CROSS: {
      const w = r * 0.38;
      g.rect(x - r, y - w, r * 2, w * 2); g.rect(x - w, y - r, w * 2, r * 2); break;
    }
    default: g.arc(x, y, r, 0, Math.PI * 2);
  }
}

export class Renderer2D {
  constructor(canvas) {
    this.kind = 'canvas2d';
    this.canvas = canvas;
    this.g = canvas.getContext('2d', { alpha: false });
    this.light = document.createElement('canvas');
    this.lg = this.light.getContext('2d');
    this.particles = [];
    this.occ = null;
    this.occKey = null;
    this.quality = 'low';
  }
  resize(w, h, dpr) {
    const s = Math.min(dpr, 1.5);
    this.canvas.width = Math.max(1, Math.round(w * s));
    this.canvas.height = Math.max(1, Math.round(h * s));
    this.light.width = Math.ceil(WORLD_W / 2); this.light.height = Math.ceil(WORLD_H / 2);
    this.pxPerCss = s;
  }
  setLevel(L, ctx, pal) {
    this.L = L; this.ctx = ctx; this.pal = pal;
    this.occKey = null;
    // Pre-render static floor/walls.
    const c = document.createElement('canvas');
    c.width = WORLD_W; c.height = WORLD_H;
    const g = c.getContext('2d');
    g.fillStyle = '#05060c'; g.fillRect(0, 0, WORLD_W, WORLD_H);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = L.tile[y * GRID_W + x], px = x * TILE_PX, py = y * TILE_PX;
        if (t === 1) {
          g.fillStyle = '#0b0e1a'; g.fillRect(px, py, TILE_PX, TILE_PX);
        } else if (t === 2) {
          g.fillStyle = '#020207'; g.fillRect(px, py, TILE_PX, TILE_PX);
          g.fillStyle = 'rgba(120,140,255,0.25)';
          for (let k = 0; k < 3; k++) g.fillRect(px + ((x * 7 + y * 13 + k * 11) % 28) + 2, py + ((x * 5 + y * 3 + k * 17) % 28) + 2, 1, 1);
        } else {
          g.fillStyle = (x + y) % 2 ? '#1a2135' : '#182033'; g.fillRect(px, py, TILE_PX, TILE_PX);
          g.strokeStyle = 'rgba(120,150,220,0.08)'; g.strokeRect(px + 0.5, py + 0.5, TILE_PX - 1, TILE_PX - 1);
        }
      }
    }
    // Neon rim along wall edges.
    g.lineWidth = 2;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        if (L.tile[y * GRID_W + x] !== 1) continue;
        const px = x * TILE_PX, py = y * TILE_PX;
        const open = (xx, yy) => xx >= 0 && yy >= 0 && xx < GRID_W && yy < GRID_H && L.tile[yy * GRID_W + xx] !== 1;
        g.strokeStyle = 'rgba(190,140,255,0.8)';
        g.beginPath();
        if (open(x, y - 1)) { g.moveTo(px, py + 1); g.lineTo(px + TILE_PX, py + 1); }
        if (open(x, y + 1)) { g.moveTo(px, py + TILE_PX - 1); g.lineTo(px + TILE_PX, py + TILE_PX - 1); }
        if (open(x - 1, y)) { g.moveTo(px + 1, py); g.lineTo(px + 1, py + TILE_PX); }
        if (open(x + 1, y)) { g.moveTo(px + TILE_PX - 1, py); g.lineTo(px + TILE_PX - 1, py + TILE_PX); }
        g.stroke();
      }
    }
    this.staticLayer = c;
  }

  /** Ray-cast a cone against the occupancy grid (tile DDA, small steps). */
  conePoly(x, y, ang, half, range) {
    const pts = [[x, y]];
    const n = 28;
    for (let k = 0; k <= n; k++) {
      const a = ang - half + (2 * half * k) / n;
      const dx = Math.cos(a), dy = Math.sin(a);
      let d = 0;
      for (; d < range; d += 4) {
        const tx = Math.floor((x + dx * d) / TILE_PX), ty = Math.floor((y + dy * d) / TILE_PX);
        if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) break;
        if (d > 18 && this.occ[ty * GRID_W + tx]) break;
      }
      pts.push([x + dx * d, y + dy * d]);
    }
    return pts;
  }

  spawn(kind, x, y, color, n = 12) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, s = 30 + Math.random() * 120;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.6, age: 0, color, size: 1.5 + Math.random() * 2 });
    }
    if (this.particles.length > 400) this.particles.splice(0, this.particles.length - 400);
  }

  render(v, fx) {
    const g = this.g, L = this.L, pal = this.pal;
    const cur = fx.state;
    const key = v.occupancyKey;
    if (key !== this.occKey) { this.occ = occupancy(L, cur, this.ctx.lay); this.occKey = key; }

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000'; g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const cam = cameraFit(this.canvas.width, this.canvas.height, this.pxPerCss, fx.cam, fx.insets);
    this.scale = cam.scale; this.ox = cam.offX; this.oy = cam.offY;
    this.offX = this.ox; this.offY = this.oy;
    const sc = this.scale;
    g.setTransform(sc, 0, 0, sc, this.ox + (fx.shakeX || 0) * sc, this.oy + (fx.shakeY || 0) * sc);
    g.drawImage(this.staticLayer, 0, 0);

    // --- objects (albedo) ---
    for (const P of v.plates) {
      g.fillStyle = P.pressed ? rgbCss(pal.channel[P.ch], 0.9) : 'rgba(40,50,70,1)';
      g.fillRect(P.x - 12, P.y - 12, 24, 24);
      g.fillStyle = P.pressed ? '#fff' : rgbCss(pal.channel[P.ch], 0.9);
      drawGlyph(g, CH_SHAPES[P.ch], P.x, P.y - 2, 5); g.fill();
      for (let k = 0; k <= P.ch; k++) g.fillRect(P.x - P.ch * 1.6 + k * 3.2 - 1, P.y + 7, 2, 2);
    }
    for (const S of v.switches) {
      g.fillStyle = '#2a3350'; g.fillRect(S.x - 10, S.y - 10, 20, 20);
      g.strokeStyle = rgbCss(pal.channel[S.ch]); g.lineWidth = 3;
      g.beginPath(); g.moveTo(S.x, S.y + 6); g.lineTo(S.x + (S.on ? 7 : -7), S.y - 8); g.stroke();
      g.fillStyle = rgbCss(pal.channel[S.ch]); drawGlyph(g, CH_SHAPES[S.ch], S.x, S.y + 6, 4); g.fill();
    }
    for (const D of v.doors) {
      const c = pal.channel[D.ch], o = D.open;
      g.fillStyle = rgbCss([c[0] * 0.5, c[1] * 0.5, c[2] * 0.5], 1);
      const w = 32 * (1 - o) / 2;
      if (D.horiz) { g.fillRect(D.x - 16, D.y - 6, w, 12); g.fillRect(D.x + 16 - w, D.y - 6, w, 12); }
      else { g.fillRect(D.x - 6, D.y - 16, 12, w); g.fillRect(D.x - 6, D.y + 16 - w, 12, w); }
      g.fillStyle = rgbCss(c); drawGlyph(g, CH_SHAPES[D.ch], D.x, D.y, 5); g.fill();
      if (D.inv) { g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(D.x - 8, D.y - 8, 16, 16); }
    }
    if (v.vault) {
      for (const c of v.vault.cells) {
        g.fillStyle = `rgba(80,130,190,${1 - v.vault.open * 0.85})`; g.fillRect(c.x - 15, c.y - 15, 30, 30);
        g.strokeStyle = '#9fe0ff'; g.lineWidth = 2;
        g.beginPath(); g.arc(c.x, c.y, 9, 0, Math.PI * 2 * Math.max(v.vault.prog, v.vault.open)); g.stroke();
      }
    }
    for (const T of v.terminals) {
      g.fillStyle = T.held ? '#3fe8d0' : '#2a4870'; g.fillRect(T.x - 11, T.y - 9, 22, 18);
      g.fillStyle = '#071018'; g.fillRect(T.x - 7, T.y - 5, 14, 8);
    }
    for (const Pf of v.platforms) {
      g.fillStyle = '#3b4560'; g.fillRect(Pf.x - 15, Pf.y - 15, 30, 30);
      g.strokeStyle = '#8ab4ff'; g.lineWidth = 2; g.strokeRect(Pf.x - 13, Pf.y - 13, 26, 26);
    }
    for (const e of v.exits) {
      g.strokeStyle = rgbCss(pal.exit); g.lineWidth = 2; g.strokeRect(e.x - 13, e.y - 13, 26, 26);
      g.beginPath(); g.moveTo(e.x - 6, e.y + 4); g.lineTo(e.x, e.y - 5); g.lineTo(e.x + 6, e.y + 4); g.stroke();
    }

    // --- light layer ---
    const lg = this.lg, LW = this.light.width, LH = this.light.height;
    lg.setTransform(1, 0, 0, 1, 0, 0);
    lg.globalCompositeOperation = 'source-over';
    lg.fillStyle = 'rgb(92,96,128)'; lg.fillRect(0, 0, LW, LH);
    lg.setTransform(LW / WORLD_W, 0, 0, LH / WORLD_H, 0, 0);
    lg.globalCompositeOperation = 'lighter';
    for (const l of v.lights) {
      const col = l.color, it = Math.min(1, l.intensity);
      if (l.type === 1) {
        const ang = Math.atan2(l.dy, l.dx), half = Math.acos(l.cosO);
        const poly = this.conePoly(l.x, l.y, ang, half, l.r);
        const gr = lg.createRadialGradient(l.x, l.y, 4, l.x, l.y, l.r);
        gr.addColorStop(0, rgbCss(col, 0.95 * it)); gr.addColorStop(1, rgbCss(col, 0.25 * it));
        lg.fillStyle = gr; lg.beginPath();
        poly.forEach(([px, py], k) => (k ? lg.lineTo(px, py) : lg.moveTo(px, py)));
        lg.closePath(); lg.fill();
      } else if (l.type === 0) {
        const gr = lg.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
        gr.addColorStop(0, rgbCss(col, 0.8 * it)); gr.addColorStop(1, rgbCss(col, 0));
        lg.fillStyle = gr; lg.fillRect(l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
      } else {
        lg.strokeStyle = rgbCss(col, 0.35 * it); lg.lineWidth = 28; lg.lineCap = 'round';
        lg.beginPath(); lg.moveTo(l.x, l.y); lg.lineTo(l.x2, l.y2); lg.stroke();
      }
    }
    g.globalCompositeOperation = 'multiply';
    g.drawImage(this.light, 0, 0, WORLD_W, WORLD_H);
    g.globalCompositeOperation = 'source-over';

    // --- emissive layer ---
    g.globalCompositeOperation = 'lighter';
    for (const Z of v.lasers) {
      if (!Z.on && Z.warn <= 0) continue;
      g.strokeStyle = Z.on ? rgbCss(pal.laser, 0.95) : rgbCss(pal.laser, 0.25 * Z.warn);
      g.lineWidth = Z.on ? 3 : 1; g.setLineDash(Z.on ? [] : [4, 6]);
      g.beginPath(); g.moveTo(Z.x0, Z.y0); g.lineTo(Z.x1, Z.y1); g.stroke();
      g.setLineDash([]);
    }
    for (const n of v.neon) {
      g.strokeStyle = rgbCss(n.color, 0.9); g.lineWidth = 3;
      g.beginPath(); g.moveTo(n.x - n.ax, n.y - n.ay); g.lineTo(n.x + n.ax, n.y + n.ay); g.stroke();
    }
    for (const C of v.coins) { g.fillStyle = rgbCss(pal.coin); g.beginPath(); g.arc(C.x, C.y, 5, 0, 7); g.fill(); }
    for (const t of v.thrown) { g.fillStyle = rgbCss(pal.coin, t.landed ? 0.6 : 1); g.beginPath(); g.arc(t.x, t.y - t.h, 4, 0, 7); g.fill(); }
    if (v.loot) {
      g.fillStyle = rgbCss(pal.loot); drawGlyph(g, SH.DIAMOND, v.loot.x, v.loot.y, v.loot.carriedBy >= 0 ? 6 : 9); g.fill();
    }
    g.globalCompositeOperation = 'source-over';

    // --- characters ---
    for (const tr of fx.trails || []) {
      const c = pal.ghost[tr.i];
      g.fillStyle = rgbCss(c, 0.25 * tr.a); g.beginPath(); g.arc(tr.x, tr.y, 9, 0, 7); g.fill();
    }
    for (const G of v.guards) {
      g.fillStyle = G.alert > 0 ? `rgb(${200 + 55 * G.alert},120,90)` : '#c9a77c';
      g.beginPath(); g.arc(G.x, G.y, 11, 0, 7); g.fill();
      g.strokeStyle = '#2a1a10'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(G.x, G.y); g.lineTo(G.x + Math.cos(G.ang) * 12, G.y + Math.sin(G.ang) * 12); g.stroke();
      if (G.alert > 0 || G.curious) {
        g.fillStyle = G.alert > 0 ? rgbCss(pal.alarm) : '#ffd84a'; g.font = 'bold 14px sans-serif'; g.textAlign = 'center';
        g.fillText(G.alert > 0 ? '!' : '?', G.x, G.y - 16);
      }
    }
    for (const Cm of v.cameras) {
      g.fillStyle = Cm.on ? '#d0d6e8' : '#555b6e'; g.beginPath(); g.arc(Cm.x, Cm.y, 8, 0, 7); g.fill();
      g.strokeStyle = Cm.on ? rgbCss(pal.camera) : '#333'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(Cm.x, Cm.y); g.lineTo(Cm.x + Math.cos(Cm.ang) * 12, Cm.y + Math.sin(Cm.ang) * 12); g.stroke();
    }
    for (const r of v.runners) {
      if (!r.alive && !r.live) continue;
      const c = pal.ghost[r.i];
      const ghost = !r.live;
      g.globalAlpha = ghost ? 0.62 : 1;
      g.fillStyle = rgbCss(c, ghost ? 0.5 : 1);
      g.beginPath(); g.arc(r.x, r.y, 10, 0, 7); g.fill();
      g.fillStyle = '#0a0c14'; drawGlyph(g, GHOST_SHAPES[r.i], r.x, r.y, 5); g.fill();
      if (r.live && r.alive) {
        g.fillStyle = '#fff';
        g.beginPath(); const by = r.y - 22 + Math.sin(v.time * 4) * 2; g.moveTo(r.x - 5, by - 4); g.lineTo(r.x + 5, by - 4); g.lineTo(r.x, by + 3); g.closePath(); g.fill();
      }
      g.strokeStyle = rgbCss(c); g.lineWidth = 2;
      g.beginPath(); g.arc(r.x, r.y, 12, r.face - 0.6, r.face + 0.6); g.stroke();
      if (r.susp > 0) {
        g.strokeStyle = rgbCss(pal.alarm); g.lineWidth = 3;
        g.beginPath(); g.arc(r.x, r.y, 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, r.susp)); g.stroke();
      }
      g.globalAlpha = 1;
      if (fx.paradoxRunner === r.i) {
        g.strokeStyle = rgbCss(pal.alarm); g.lineWidth = 3;
        g.beginPath(); g.arc(r.x, r.y, 18 + 4 * Math.sin(v.time * 20), 0, 7); g.stroke();
      }
    }

    // --- particles ---
    g.globalCompositeOperation = 'lighter';
    const dt = fx.dt || 0.016;
    for (let k = this.particles.length - 1; k >= 0; k--) {
      const p = this.particles[k];
      p.age += dt;
      if (p.age > p.life) { this.particles.splice(k, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.94; p.vy *= 0.94;
      g.fillStyle = rgbCss(p.color, 1 - p.age / p.life);
      g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    g.globalCompositeOperation = 'source-over';

    // --- post: rewind tint / flash ---
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (fx.rewind > 0) {
      g.fillStyle = `rgba(40,200,255,${0.18 * fx.rewind})`; g.fillRect(0, 0, this.canvas.width, this.canvas.height);
      g.fillStyle = `rgba(0,0,0,${0.25 * fx.rewind})`;
      for (let y = 0; y < this.canvas.height; y += 4) g.fillRect(0, y, this.canvas.width, 1);
    }
    if (fx.flash > 0) { g.fillStyle = `rgba(${fx.flashColor || '255,40,60'},${fx.flash * 0.35})`; g.fillRect(0, 0, this.canvas.width, this.canvas.height); }
    // vignette
    const vg = g.createRadialGradient(this.canvas.width / 2, this.canvas.height / 2, this.canvas.height * 0.35, this.canvas.width / 2, this.canvas.height / 2, this.canvas.height * 0.9);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vg; g.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
  destroy() {}
}
