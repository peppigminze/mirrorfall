// MIRRORFALL — GLSL ES 3.00 shader sources.
// Conventions: world space in pixels (960×544, y down). Full-screen passes get
// vUV (0..1, y DOWN); FBO textures are sampled at vec2(vUV.x, 1.0 - vUV.y).

export const MAX_LIGHTS = 24;

const COMMON = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
`;

export const FULLSCREEN_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- floor/walls
export const FLOOR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform vec2 uRes;        // target size in px
uniform float uScale;     // world px → target px
uniform vec2 uOff;        // target px offset of world origin
uniform float uTime;
uniform sampler2D uTiles; // 30x17 RGBA8: r=tile type, g=object, b=channel, a=variation
uniform sampler2D uSdf;
uniform vec3 uAccA, uAccB;
uniform float uEnc;
layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oEmis;
${COMMON}
float sdf(vec2 w) { return (texture(uSdf, w / vec2(960.0, 544.0)).r - 0.5) * 128.0; }
int tileAt(ivec2 t) {
  if (t.x < 0 || t.y < 0 || t.x >= 30 || t.y >= 17) return 1;
  return int(texelFetch(uTiles, t, 0).r * 255.0 + 0.5);
}
void main() {
  vec2 px = vUV * uRes;
  vec2 w = (px - uOff) / uScale;
  if (w.x < 0.0 || w.y < 0.0 || w.x >= 960.0 || w.y >= 544.0) { oAlbedo = vec4(0.0, 0.0, 0.0, 1.0); oEmis = vec4(0.0); return; }
  ivec2 t = ivec2(floor(w / 32.0));
  vec4 tile = texelFetch(uTiles, t, 0);
  int type = int(tile.r * 255.0 + 0.5);
  float variation = tile.a;
  vec2 f = fract(w / 32.0);
  float d = sdf(w);
  vec3 alb; vec3 emis = vec3(0.0);
  if (type == 1 || type == 3 || type == 4) {
    // Wall roof (doors/vault get their own sprites; under them: a dark slot).
    if (type != 1) {
      alb = vec3(0.02, 0.025, 0.04);
    } else {
      float n = vnoise(w * 0.09) * 0.5 + vnoise(w * 0.31) * 0.25;
      float diag = step(0.5, fract((w.x + w.y) / 9.0)) * 0.012;
      alb = vec3(0.022, 0.026, 0.045) + n * 0.02 + diag;
      // thin neon trim on the inner edge of the wall boundary
      float rim = smoothstep(-3.4, -1.6, d) * (1.0 - smoothstep(-0.9, 0.4, d));
      float halo = smoothstep(-12.0, -1.0, d) * 0.12;
      float side = smoothstep(0.35, 0.65, vnoise(w * 0.006 + vec2(3.1, 7.7)));
      vec3 neon = mix(uAccA, uAccB, side);
      float flick = 0.9 + 0.1 * sin(uTime * 1.7 + variation * 30.0);
      // occasional dim segments make the trim feel like real tubes
      float seg = 0.55 + 0.45 * step(0.18, hash12(floor(w / 40.0)));
      emis = neon * (rim * 0.95 * seg + halo * 0.25) * flick;
      alb += neon * halo * 0.15;
    }
  } else if (type == 2) {
    // Chasm: deep void with drifting dust and parallax stars.
    vec2 q = w * 0.5 + vec2(uTime * 3.0, uTime * 1.3);
    float stars = step(0.985, hash12(floor(q))) * (0.4 + 0.6 * hash12(floor(q) + 7.0));
    float stars2 = step(0.992, hash12(floor(w * 0.25 + vec2(uTime * 1.2, 0.0)))) * 0.5;
    float fog = vnoise(w * 0.03 + vec2(uTime * 0.05, 0.0));
    alb = vec3(0.0, 0.0, 0.008);
    emis = vec3(0.35, 0.45, 1.0) * (stars * 0.7 + stars2 * 0.35) + vec3(0.06, 0.03, 0.14) * fog * 0.6;
    // lip shadow below a floor edge (depth cue)
    int up = tileAt(t + ivec2(0, -1));
    if (up != 2) emis *= smoothstep(0.0, 0.6, f.y);
    if (up != 2 && up != 1) alb += vec3(0.05, 0.06, 0.09) * (1.0 - smoothstep(0.0, 0.22, f.y));
  } else {
    // Floor: polished tiles, seams, per-tile variation, contact shadows near walls.
    float checker = mod(float(t.x + t.y), 2.0);
    vec3 base = mix(vec3(0.060, 0.072, 0.115), vec3(0.068, 0.080, 0.128), checker);
    base *= 0.9 + 0.2 * variation;
    float seam = smoothstep(0.0, 0.035, min(min(f.x, f.y), min(1.0 - f.x, 1.0 - f.y)));
    float n = vnoise(w * 0.22) * 0.03 + hash12(floor(w)) * 0.012;
    float ao = mix(0.45, 1.0, smoothstep(0.0, 20.0, d));
    alb = (base + n) * mix(0.55, 1.0, seam) * ao;
    // fine engraved diagonal on every 4th tile
    if (mod(float(t.x * 3 + t.y * 5), 7.0) < 1.0) alb += vec3(0.012, 0.016, 0.03) * step(0.85, fract((f.x - f.y) * 4.0));
  }
  oAlbedo = vec4(alb, 1.0);
  oEmis = vec4(emis * uEnc, 1.0);
}`;

// --------------------------------------------------------------- sprites
export const SPRITE_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;            // unit quad -1..1
layout(location = 1) in vec4 aPosSize;           // x, y, sx, sy (half size, world px)
layout(location = 2) in vec4 aColor;             // rgba (linear)
layout(location = 3) in vec4 aParam;             // rot, shape, emis, param
uniform vec2 uRes; uniform float uScale; uniform vec2 uOff;
out vec2 vLocal; out vec2 vHalf; out vec4 vColor; out vec4 vParam;
void main() {
  float c = cos(aParam.x), s = sin(aParam.x);
  vec2 loc = aCorner * (aPosSize.zw + 2.0);       // +2 px margin for antialiasing/glow
  vec2 wpos = aPosSize.xy + vec2(c * loc.x - s * loc.y, s * loc.x + c * loc.y);
  vec2 px = wpos * uScale + uOff;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
  vLocal = loc; vHalf = aPosSize.zw; vColor = aColor; vParam = aParam;
}`;

export const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 vLocal; in vec2 vHalf; in vec4 vColor; in vec4 vParam;
uniform float uScale; uniform float uTime; uniform float uEnc;
layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oEmis;
const float PI = 3.14159265;
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdTri(vec2 p, float r) {
  const float k = 1.7320508;
  p.y = -p.y + r * 0.25;
  p.x = abs(p.x) - r * 0.866;
  p.y = p.y + r * 0.866 / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r * 0.866, 0.0);
  return -length(p) * sign(p.y);
}
float sdStar(vec2 p, float r) {
  float a = atan(p.x, -p.y), seg = 2.0 * PI / 5.0;
  a = mod(a + seg * 0.5, seg) - seg * 0.5;
  vec2 q = length(p) * vec2(cos(a), abs(sin(a)));
  vec2 A = vec2(r, 0.0), B = vec2(r * 0.42 * cos(seg * 0.5), r * 0.42 * sin(seg * 0.5));
  vec2 e = B - A, w = q - A;
  float h = clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
  float d = length(w - e * h);
  float s = e.x * w.y - e.y * w.x;
  return s > 0.0 ? -d : d;
}
float sdHex(vec2 p, float r) { const vec3 k = vec3(-0.866025404, 0.5, 0.577350269); p = abs(p); p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy; p -= vec2(clamp(p.x, -k.z * r, k.z * r), r); return length(p) * sign(p.y); }
float sdCross(vec2 p, float r) { p = abs(p); float w = r * 0.36; return min(sdBox(p, vec2(r, w), 1.0), sdBox(p, vec2(w, r), 1.0)); }
float glyph(int sh, vec2 p, float r) {
  if (sh == 0) return length(p) - r;
  if (sh == 1) return sdTri(p, r * 1.05);
  if (sh == 2) return sdBox(p, vec2(r * 0.82), r * 0.15);
  if (sh == 3) { vec2 q = abs(p); return (q.x + q.y - r) * 0.7071; }
  if (sh == 4) return sdStar(p, r * 1.1);
  if (sh == 5) return sdHex(p.yx, r * 0.9);
  if (sh == 6) return sdCross(p, r);
  if (sh == 7) return abs(length(p) - r * 0.72) - r * 0.28;
  return length(p) - r;
}
void main() {
  int sh = int(vParam.y + 0.5);
  float emisK = vParam.z;
  float prm = vParam.w;
  vec2 p = vLocal;
  float aa = 1.0 / uScale;
  float d; float glow = 0.0;
  if (sh < 8) d = glyph(sh, p, vHalf.x);
  else if (sh == 30) d = length(p) - vHalf.x;                                   // disc
  else if (sh == 31) d = abs(length(p) - vHalf.x + prm * 0.5) - prm * 0.5;      // annulus (thickness prm)
  else if (sh == 32) d = sdBox(p, vHalf, prm);                                  // rounded box
  else if (sh == 33) {                                                          // soft glow
    float r = length(p / vHalf);
    float a = exp(-r * r * 3.2) * (1.0 - smoothstep(0.85, 1.0, r));
    vec3 c = vColor.rgb * a * vColor.a;
    oAlbedo = vec4(0.0); oEmis = vec4(c * uEnc, 0.0);
    return;
  } else if (sh == 34) {                                                        // capsule beam along x
    vec2 q = vec2(max(abs(p.x) - (vHalf.x - vHalf.y), 0.0), p.y);
    float r = length(q);
    float core = 1.0 - smoothstep(vHalf.y * 0.18, vHalf.y * 0.32, r);
    float halo = exp(-r * r / (vHalf.y * vHalf.y) * 4.0);
    float flick = 0.85 + 0.15 * sin(uTime * 60.0 + p.x * 0.3);
    vec3 c = vColor.rgb * (core * 2.4 + halo * 0.9) * flick * vColor.a;
    oAlbedo = vec4(0.0); oEmis = vec4(c * uEnc, 0.0);
    return;
  } else if (sh == 35) {                                                        // arc (prm = half angle)
    float a = atan(p.y, p.x);
    d = max(abs(length(p) - vHalf.x * 0.85) - vHalf.x * 0.15, abs(a) - prm);
  } else if (sh == 36) {                                                        // dashed ring (progress prm 0..1)
    float a = atan(p.y, p.x) + PI * 0.5; if (a < 0.0) a += 2.0 * PI;
    d = abs(length(p) - vHalf.x * 0.85) - vHalf.x * 0.12;
    if (a > prm * 2.0 * PI) d = max(d, 0.6);
  } else if (sh == 38) {                                                        // box outline (thickness prm)
    d = abs(sdBox(p, vHalf - prm * 0.5, 3.0)) - prm * 0.5;
  } else if (sh == 37) {                                                        // hatched pad (pressure plate)
    d = sdBox(p, vHalf, 4.0);
    float hatch = step(0.5, fract((p.x + p.y) / 6.0));
    if (d < 0.0 && d > -3.0) hatch = 1.0;
    float cov = clamp(0.5 - d / aa, 0.0, 1.0);
    vec3 c = vColor.rgb * (0.55 + 0.45 * hatch);
    oAlbedo = vec4(c * (1.0 - emisK) * cov * vColor.a, cov * vColor.a);
    oEmis = vec4(c * emisK * cov * vColor.a * uEnc, cov * vColor.a);
    return;
  } else d = length(p) - vHalf.x;
  float cov = clamp(0.5 - d / aa, 0.0, 1.0) * vColor.a;
  if (cov <= 0.002) discard;
  oAlbedo = vec4(vColor.rgb * (1.0 - emisK) * cov, cov);
  oEmis = vec4(vColor.rgb * emisK * 1.6 * cov * uEnc, cov);
}`;

// --------------------------------------------------------------- particles
export const PARTICLE_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aP0V;      // x, y, vx, vy
layout(location = 2) in vec4 aTimes;    // t0, life, size, drag
layout(location = 3) in vec4 aColor;    // rgb, gravity
uniform vec2 uRes; uniform float uScale; uniform vec2 uOff; uniform float uTime;
out vec2 vC; out vec3 vColor; out float vFade;
void main() {
  float age = uTime - aTimes.x;
  if (age < 0.0 || age > aTimes.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vC = vec2(0.0); vColor = vec3(0.0); vFade = 0.0; return; }
  float drag = max(aTimes.w, 0.001);
  vec2 pos = aP0V.xy + aP0V.zw * (1.0 - exp(-drag * age)) / drag + vec2(0.0, 0.5 * aColor.w * age * age);
  float u = age / aTimes.y;
  float size = aTimes.z * (1.0 - u * 0.6);
  vec2 px = (pos + aCorner * size) * uScale + uOff;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
  vC = aCorner; vColor = aColor.rgb; vFade = (1.0 - u) * (1.0 - u);
}`;

export const PARTICLE_FS = `#version 300 es
precision mediump float;
in vec2 vC; in vec3 vColor; in float vFade;
uniform float uEnc;
layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oEmis;
void main() {
  float r = length(vC);
  float a = exp(-r * r * 3.5) * vFade;
  if (a < 0.003) discard;
  oAlbedo = vec4(0.0);
  oEmis = vec4(vColor * a * 2.2 * uEnc, 0.0);
}`;

// --------------------------------------------------------------- lighting
export const LIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform vec2 uRes; uniform float uScale; uniform vec2 uOff;
uniform sampler2D uSdf;
uniform vec4 uLA[${MAX_LIGHTS}];  // x, y, radius, type (0 point, 1 cone, 2 line)
uniform vec4 uLB[${MAX_LIGHTS}];  // r, g, b, intensity
uniform vec4 uLC[${MAX_LIGHTS}];  // cone: dx, dy, cosOuter, cosInner | line: x2, y2, 0, 0
uniform vec4 uLD[${MAX_LIGHTS}];  // shadow (0/1), cone edge strength, 0, 0
uniform int uLN;
uniform int uSteps;
uniform vec3 uAmbient;
uniform float uHatch;
uniform float uTime;
uniform float uEnc;
out vec4 oLight;
float sdf(vec2 w) { return (texture(uSdf, w / vec2(960.0, 544.0)).r - 0.5) * 128.0; }
float softShadow(vec2 p, vec2 l) {
  vec2 dv = l - p; float dist = length(dv);
  if (dist < 2.0) return 1.0;
  vec2 dir = dv / dist;
  float res = 1.0, t = 2.5;
  for (int i = 0; i < 48; i++) {
    if (i >= uSteps || t >= dist - 7.0) break;
    float h = sdf(p + dir * t);
    if (h < 0.15) return 0.0;
    res = min(res, 9.0 * h / t);
    t += max(h * 0.9, 2.5);
  }
  return smoothstep(0.0, 1.0, res);
}
void main() {
  vec2 px = vUV * uRes;
  vec2 w = (px - uOff) / uScale;
  float dHere = sdf(w);
  float inWall = 1.0 - smoothstep(-1.5, 0.5, dHere);
  vec3 light = uAmbient;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLN) break;
    vec4 A = uLA[i]; vec4 B = uLB[i]; vec4 C = uLC[i]; vec4 D = uLD[i];
    int type = int(A.w + 0.5);
    vec2 lp = A.xy;
    float att, mask = 1.0;
    if (type == 2) {
      vec2 ab = C.xy - A.xy;
      float h = clamp(dot(w - A.xy, ab) / max(dot(ab, ab), 1e-3), 0.0, 1.0);
      lp = A.xy + ab * h;
    }
    vec2 dv = w - lp; float d = length(dv);
    if (d > A.z) continue;
    if (type == 1) {
      float c = dot(dv / max(d, 1e-3), C.xy);
      mask = smoothstep(C.z, C.w, c);
      // flat, readable cone up to its exact range, plus a bright rim line
      att = (1.0 - smoothstep(A.z - 10.0, A.z, d)) * (0.55 + 0.45 * (1.0 - d / A.z));
      float edge = (1.0 - smoothstep(0.0, 0.010, abs(c - C.z))) * step(16.0, d);
      float arc = (1.0 - smoothstep(0.0, 3.5, abs(d - (A.z - 10.0)))) * mask;
      mask = mask * (1.0 - uHatch * 0.35 * step(0.5, fract((w.x + w.y) / 9.0))) + (edge + arc * 0.6) * D.y * 0.6;
      mask += smoothstep(26.0, 0.0, d) * 0.4;   // small spill around the lamp
    } else {
      float x = 1.0 - d / A.z;
      att = x * x;
    }
    if (att * mask <= 0.002) continue;
    float sh = 1.0;
    if (D.x > 0.5) sh = softShadow(w, lp);
    float wallK = mix(1.0, 0.18, inWall);
    light += B.rgb * B.w * att * mask * sh * wallK;
  }
  oLight = vec4(light * uEnc, 1.0);
}`;

// --------------------------------------------------------------- composite
export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uAlbedo, uEmis, uLight;
uniform float uEnc;
out vec4 oColor;
void main() {
  vec2 uv = vec2(vUV.x, 1.0 - vUV.y);
  vec3 alb = texture(uAlbedo, uv).rgb;
  vec3 em = texture(uEmis, uv).rgb / uEnc;
  vec3 li = texture(uLight, uv).rgb / uEnc;
  vec3 c = alb * li * 2.2 + em;
  oColor = vec4(c * uEnc, 1.0);
}`;

// --------------------------------------------------------------- bloom
export const BLOOM_PREFILTER_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uThreshold;
out vec4 o;
vec3 tap(vec2 uv) { return texture(uSrc, uv).rgb; }
void main() {
  vec2 uv = vec2(vUV.x, 1.0 - vUV.y);
  vec3 c = (tap(uv + uTexel * vec2(-1, -1)) + tap(uv + uTexel * vec2(1, -1)) + tap(uv + uTexel * vec2(-1, 1)) + tap(uv + uTexel * vec2(1, 1))) * 0.25;
  float br = max(c.r, max(c.g, c.b));
  float knee = uThreshold * 0.5;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  o = vec4(c * contrib, 1.0);
}`;

export const BLOOM_DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc; uniform vec2 uTexel;
out vec4 o;
vec3 t(vec2 uv) { return texture(uSrc, uv).rgb; }
void main() {
  vec2 uv = vec2(vUV.x, 1.0 - vUV.y);
  vec2 d = uTexel;
  vec3 a = t(uv + d * vec2(-2, -2)), b = t(uv + d * vec2(0, -2)), c = t(uv + d * vec2(2, -2));
  vec3 e = t(uv + d * vec2(-2, 0)), f = t(uv), g = t(uv + d * vec2(2, 0));
  vec3 h = t(uv + d * vec2(-2, 2)), i = t(uv + d * vec2(0, 2)), j = t(uv + d * vec2(2, 2));
  vec3 k = t(uv + d * vec2(-1, -1)), l = t(uv + d * vec2(1, -1)), m = t(uv + d * vec2(-1, 1)), n = t(uv + d * vec2(1, 1));
  vec3 res = f * 0.125 + (a + c + h + j) * 0.03125 + (b + e + g + i) * 0.0625 + (k + l + m + n) * 0.125;
  o = vec4(res, 1.0);
}`;

export const BLOOM_UP_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uRadius;
out vec4 o;
vec3 t(vec2 uv) { return texture(uSrc, uv).rgb; }
void main() {
  vec2 uv = vec2(vUV.x, 1.0 - vUV.y);
  vec2 d = uTexel * uRadius;
  vec3 s = t(uv) * 4.0;
  s += (t(uv + vec2(-d.x, 0)) + t(uv + vec2(d.x, 0)) + t(uv + vec2(0, -d.y)) + t(uv + vec2(0, d.y))) * 2.0;
  s += t(uv + vec2(-d.x, -d.y)) + t(uv + vec2(d.x, -d.y)) + t(uv + vec2(-d.x, d.y)) + t(uv + vec2(d.x, d.y));
  o = vec4(s / 16.0, 1.0);
}`;

// --------------------------------------------------------------- final
export const FINAL_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uHdr, uBloom;
uniform vec2 uRes;
uniform float uTime, uBloomStr, uExposure, uChroma, uScan, uGrain, uVignette, uGlitch, uRewind, uFlash, uDesat, uWin, uFade, uEnc;
uniform vec3 uFlashCol;
out vec4 oColor;
${COMMON}
vec3 aces(vec3 x) { const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14; return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0); }
void main() {
  vec2 suv = vUV;
  // paradox glitch: horizontal slice displacement
  if (uGlitch > 0.0) {
    float row = floor(suv.y * 38.0);
    float n = hash12(vec2(row, floor(uTime * 24.0)));
    if (n < uGlitch * 0.45) suv.x += (hash12(vec2(row, 3.7 + floor(uTime * 24.0))) - 0.5) * 0.09 * uGlitch;
  }
  // rewind: VHS wobble + tracking band
  if (uRewind > 0.0) {
    suv.x += uRewind * 0.0045 * sin(suv.y * 90.0 + uTime * 40.0);
    float band = smoothstep(0.03, 0.0, abs(fract(suv.y * 0.7 - uTime * 0.9) - 0.5));
    suv.x += band * uRewind * 0.02;
  }
  vec2 uv = vec2(suv.x, 1.0 - suv.y);
  vec2 dir = uv - 0.5;
  float ca = uChroma * (0.0025 + 0.010 * uRewind + 0.02 * uGlitch);
  vec3 col;
  col.r = texture(uHdr, uv + dir * ca).r + texture(uBloom, uv + dir * ca).r * uBloomStr;
  col.g = texture(uHdr, uv).g + texture(uBloom, uv).g * uBloomStr;
  col.b = texture(uHdr, uv - dir * ca).b + texture(uBloom, uv - dir * ca).b * uBloomStr;
  col *= uExposure / uEnc;
  col = aces(col);
  // grade: cool shadows, warm highlights, desaturation for rewind / pause
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(l), clamp(uDesat + uRewind * 0.55, 0.0, 1.0));
  col += vec3(-0.01, 0.0, 0.02) * (1.0 - l) + uRewind * vec3(-0.03, 0.05, 0.09);
  col = mix(col, col * vec3(1.06, 1.02, 0.94), uWin * 0.5);
  if (uGlitch > 0.6 && hash12(vec2(floor(uTime * 18.0), 1.0)) < 0.25) col = vec3(1.0) - col;
  // scanlines
  float scan = 0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159 * 0.5);
  col *= 1.0 - (uScan * 0.12 + uRewind * 0.3) * scan;
  // vignette
  float v = smoothstep(0.95, 0.3, length(dir * vec2(1.0, 0.9)));
  col *= mix(1.0, v, uVignette);
  // film grain (luminance-weighted)
  float g = hash12(gl_FragCoord.xy + fract(uTime * 7.3) * 113.0) - 0.5;
  col += g * uGrain * (0.6 + 0.4 * (1.0 - l));
  col = mix(col, uFlashCol, uFlash * 0.38);
  col *= uFade;
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  oColor = vec4(col, 1.0);
}`;
