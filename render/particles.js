// MIRRORFALL — GPU-instanced, stateless particles.
// The CPU only writes spawn records into a ring buffer (one instance per
// particle: start position, velocity, birth time, lifetime, size, drag,
// colour, gravity). The vertex shader computes the motion analytically, so
// there is no per-frame CPU work per particle.

import { lin } from './gl.js';

const FLOATS = 12;   // per instance: p0v(4) times(4) color+gravity(4)

export class Particles {
  constructor(gl, capacity = 4096) {
    this.gl = gl;
    this.cap = capacity;
    this.data = new Float32Array(capacity * FLOATS);
    this.head = 0;
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    this.seed = 1;
  }
  rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  /** Emit a preset burst. kind: spark | ring | burst | glitch | dust | trail */
  emit(kind, x, y, color, n, now, reduced) {
    if (reduced) n = Math.max(1, Math.round(n * 0.35));
    const c = [lin(color[0]), lin(color[1]), lin(color[2])];
    for (let k = 0; k < n; k++) {
      const a = this.rnd() * Math.PI * 2;
      let sp = 40 + this.rnd() * 160, life = 0.35 + this.rnd() * 0.5, size = 2 + this.rnd() * 3, drag = 3, grav = 0;
      let px = x, py = y;
      if (kind === 'ring') { sp = 120 + this.rnd() * 30; life = 0.45; size = 3; drag = 5; }
      else if (kind === 'burst') { sp = 60 + this.rnd() * 340; life = 0.5 + this.rnd() * 0.9; size = 2.5 + this.rnd() * 4.5; drag = 2.2; grav = 60; }
      else if (kind === 'glitch') { sp = 20 + this.rnd() * 260; life = 0.3 + this.rnd() * 1.1; size = 3 + this.rnd() * 6; drag = 1.5; px += (this.rnd() - 0.5) * 30; py += (this.rnd() - 0.5) * 30; }
      else if (kind === 'dust') { sp = 6 + this.rnd() * 14; life = 1.5 + this.rnd() * 2; size = 1.5 + this.rnd() * 2; drag = 0.5; grav = -6; }
      else if (kind === 'trail') { sp = 5 + this.rnd() * 10; life = 0.5; size = 5; drag = 1; }
      this.write(px, py, Math.cos(a) * sp, Math.sin(a) * sp, now, life, size, drag, c, grav);
    }
  }
  write(x, y, vx, vy, t0, life, size, drag, c, grav) {
    const i = this.head;
    const o = i * FLOATS, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = vx; d[o + 3] = vy;
    d[o + 4] = t0; d[o + 5] = life; d[o + 6] = size; d[o + 7] = drag;
    d[o + 8] = c[0]; d[o + 9] = c[1]; d[o + 10] = c[2]; d[o + 11] = grav;
    this.dirtyLo = Math.min(this.dirtyLo, i);
    this.dirtyHi = Math.max(this.dirtyHi, i);
    this.head = (i + 1) % this.cap;
    if (this.head === 0) this.flush();
  }
  flush() {
    if (this.dirtyHi < 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, this.dirtyLo * FLOATS * 4, this.data, this.dirtyLo * FLOATS, (this.dirtyHi - this.dirtyLo + 1) * FLOATS);
    this.dirtyLo = Infinity; this.dirtyHi = -1;
  }
  /** Bind instance attributes 1..3 for the particle program (VAO bound). */
  setupAttribs() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = FLOATS * 4;
    for (let a = 1; a <= 3; a++) {
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 4, gl.FLOAT, false, stride, (a - 1) * 16);
      gl.vertexAttribDivisor(a, 1);
    }
  }
}
