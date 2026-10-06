// MIRRORFALL — tiny DOM helpers.

/** h('div.cls#id', {attrs}, ...children) */
export function h(sel, attrs, ...children) {
  const m = sel.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const GLYPH_PATHS = [
  'M12 3a9 9 0 1 0 0.01 0Z',                                   // circle
  'M12 3 21 19H3Z',                                            // triangle
  'M5 5h14v14H5Z',                                             // square
  'M12 2 22 12 12 22 2 12Z',                                   // diamond
  'M12 2l2.6 6.6 7.1.4-5.5 4.5 1.8 6.9L12 16.6 6 20.4l1.8-6.9L2.3 9l7.1-.4Z', // star
  'M12 2.5 20.5 7.3v9.4L12 21.5 3.5 16.7V7.3Z',                // hexagon
  'M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z',                             // cross
  'M12 3a9 9 0 1 0 .01 0Zm0 4.5a4.5 4.5 0 1 1-.01 0Z',          // ring
];

/** Inline SVG glyph (shape index 0..7). */
export function glyph(shape, color, size = 18, filled = true, title = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', title ? 'false' : 'true');
  if (title) { const t = document.createElementNS(SVG_NS, 'title'); t.textContent = title; svg.appendChild(t); }
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', GLYPH_PATHS[shape] || GLYPH_PATHS[0]);
  p.setAttribute('fill-rule', 'evenodd');
  if (filled) { p.setAttribute('fill', color); }
  else { p.setAttribute('fill', 'none'); p.setAttribute('stroke', color); p.setAttribute('stroke-width', '2'); }
  svg.appendChild(p);
  return svg;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }, text);
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export const fmtTime = (ticks) => (ticks / 60).toFixed(2) + ' s';
