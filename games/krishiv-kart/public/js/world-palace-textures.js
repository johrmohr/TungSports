// Procedural canvas textures for Krishiv's Palace (browser only, SPEC §16.1
// "richer per-track materials"): the palace road, basalt with glowing lava
// cracks, the Forge's riveted iron plates and conveyor belt, the Lavafall
// Tunnel's floor grates, the Banquet Hall's marble floor and stained glass.
// Seeded (utils.makeRng): identical on every load. The caller owns (and
// disposes) every texture (world.js ctx.tex()).
//
// UV conventions as textures.js: road-like strips u = across (0 = left),
// v = along the driving direction (canvas top = +v).

import * as THREE from 'three';
import { makeRng, clamp, lerp } from './utils.js';
import { tileFbm, tileNoise } from './textures.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function finish(c, { srgb = true, aniso = 1, repeat = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
// Add per-pixel noise k(i) to the RGB of a canvas.
function grain(g, size, fn) {
  const img = g.getImageData(0, 0, size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const [kr, kg, kb] = fn(i);
    d[i * 4] = clamp(d[i * 4] + kr, 0, 255); d[i * 4 + 1] = clamp(d[i * 4 + 1] + kg, 0, 255); d[i * 4 + 2] = clamp(d[i * 4 + 2] + kb, 0, 255);
  }
  g.putImageData(img, 0, 0);
}
// A jagged crack polyline from (x, y) wandering along angle a.
function crackPath(rng, x, y, a, len, step = 6) {
  const pts = [[x, y]];
  for (let d = 0; d < len; d += step) {
    a += (rng() - 0.5) * 0.9;
    x += Math.cos(a) * step; y += Math.sin(a) * step;
    pts.push([x, y]);
  }
  return pts;
}
function strokePath(g, pts) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]);
  g.stroke();
}
// Draw fn at (x, y) and its wrapped copies (tileable).
function wrap(size, fn) {
  for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) fn(ox, oy);
}

/**
 * The palace road: irregular dressed flagstones in courses (bevelled tops,
 * worn wheel tracks, soot, hairline cracks, embers glowing in a few joints),
 * cream edge lines and an amber centre dash. u across the full road, v along.
 */
export function createPalaceRoadTexture({ size = 2048, aniso = 1, seed = 1201 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  const S = size / 1024;
  g.fillStyle = '#17151a'; g.fillRect(0, 0, size, size);
  const rows = 10, rh = size / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh;
    let x = -rng() * rh;
    while (x < size) {
      const w = rh * (0.75 + rng() * 1.1);
      const v = 64 + Math.floor(rng() * 40);
      const warm = rng() < 0.25 ? 10 : 0;
      const draw = (xx) => {
        const j = 3 * S;
        g.fillStyle = `rgb(${v + 6 + warm},${v + 1},${v + 8 - warm})`;
        g.fillRect(xx + j, y + j, w - 2 * j, rh - 2 * j);
        // bevel: lit top edge, dark bottom / right edges
        g.fillStyle = 'rgba(255,240,220,0.10)'; g.fillRect(xx + j, y + j, w - 2 * j, 5 * S);
        g.fillStyle = 'rgba(255,240,220,0.05)'; g.fillRect(xx + j, y + j, 5 * S, rh - 2 * j);
        g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(xx + j, y + rh - j - 6 * S, w - 2 * j, 6 * S);
        g.fillStyle = 'rgba(0,0,0,0.14)'; g.fillRect(xx + w - j - 5 * S, y + j, 5 * S, rh - 2 * j);
      };
      draw(x); if (x + w > size) draw(x - size); if (x < 0) draw(x + size);
      x += w;
    }
  }
  // stone grain + large soot / wear variation (noise at <= 1024 px, read nearest: a 2048
  // texture builds ~4x faster and the grain is finer than a texel on screen anyway)
  const ns = Math.min(size, 1024), sh = size / ns;
  const n = tileFbm(ns, 8, 5, rng, 0.55);
  const m = tileFbm(ns, 3, 3, rng, 0.5);
  const wear = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const u = x / size;           // worn wheel tracks (lighter, smoother) at ~30 % and ~70 % across
    wear[x] = (Math.exp(-(((u - 0.3) / 0.07) ** 2)) + Math.exp(-(((u - 0.7) / 0.07) ** 2))) * 9;
  }
  grain(g, size, (i) => {
    const x = i % size, y = (i - x) / size, j = Math.floor(y / sh) * ns + Math.floor(x / sh);
    const k = (n[j] - 0.5) * 30 + (rng() - 0.5) * 9 + wear[x] - Math.max(0, m[j] - 0.55) * 70;
    return [k, k * 0.96, k * 0.92];
  });
  // hairline cracks
  g.strokeStyle = 'rgba(10,8,10,0.55)'; g.lineWidth = 1.6 * S;
  for (let k = 0; k < 70; k++) {
    const pts = crackPath(rng, rng() * size, rng() * size, rng() * Math.PI * 2, (20 + rng() * 60) * S, 5 * S);
    wrap(size, (ox, oy) => strokePath(g, pts.map(([a, b]) => [a + ox, b + oy])));
  }
  // embers glowing in a few joints
  for (let k = 0; k < 110; k++) {
    const yy = Math.floor(rng() * rows) * rh, xx = rng() * size, w = (5 + rng() * 22) * S;
    g.fillStyle = `rgba(255,${(80 + rng() * 90) | 0},20,${0.25 + rng() * 0.4})`;
    g.fillRect(xx, yy - 1.5 * S, w, 3 * S);
  }
  // painted lines: cream edges, amber centre dashes
  const line = (x0, w, col) => { g.fillStyle = col; g.fillRect(x0, 0, w, size); };
  const ew = Math.round(size * 0.012);
  line(Math.round(size * 0.016), ew, 'rgba(238,224,192,0.9)');
  line(size - Math.round(size * 0.016) - ew, ew, 'rgba(238,224,192,0.9)');
  const cw = Math.round(size * 0.009);
  for (let k = 0; k < 2; k++) {
    const y0 = Math.round(size * (k * 0.5 + 0.06)), len = Math.round(size * 0.24);
    g.fillStyle = 'rgba(255,168,58,0.85)'; g.fillRect(Math.round(size / 2 - cw / 2), y0, cw, len);
  }
  return finish(c, { aniso });
}

/**
 * Basalt blocks with jagged lava cracks: returns { map, glow } — the colour
 * map (dark blocks, the cracks already orange) and a matching emissive mask
 * (white cracks + a soft bloom round them on black) for a pulsing emissive.
 */
export function createLavaStoneTextures({ size = 512, aniso = 1, seed = 1203 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  const e = canvas(size, size), ge = e.getContext('2d');
  g.fillStyle = '#1a161c'; g.fillRect(0, 0, size, size);
  ge.fillStyle = '#000'; ge.fillRect(0, 0, size, size);
  const rows = 5, rh = size / rows;
  const joints = [];                                     // horizontal mortar runs that may glow
  for (let r = 0; r < rows; r++) {
    let x = (r % 2) * rh * 0.8;
    const x0 = x;
    while (x < x0 + size) {
      const w = rh * (1.2 + rng() * 1.0), v = 74 + rng() * 34, warm = rng() * 10;
      const draw = (xx) => {
        g.fillStyle = `rgb(${v + 6 + warm | 0},${v + 1 | 0},${v + 6 - warm | 0})`;
        g.fillRect(xx + 4, r * rh + 4, w - 8, rh - 8);
        g.fillStyle = 'rgba(255,240,230,0.10)'; g.fillRect(xx + 4, r * rh + 4, w - 8, 5);
        g.fillStyle = 'rgba(0,0,0,0.30)'; g.fillRect(xx + 4, r * rh + rh - 10, w - 8, 6);
        g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(xx + w - 9, r * rh + 4, 5, rh - 8);
      };
      draw(x % size); if ((x % size) + w > size) draw((x % size) - size);
      if (rng() < 0.22) joints.push([x % size, r * rh, w]);
      x += w;
    }
  }
  const n = tileFbm(size, 8, 4, rng, 0.55);
  const soot = tileFbm(size, 2, 3, rng, 0.5);
  grain(g, size, (i) => { const k = (n[i] - 0.5) * 30 + (rng() - 0.5) * 10 - Math.max(0, soot[i] - 0.5) * 70; return [k, k * 0.97, k * 1.02]; });
  // glowing mortar seams (a few joints carry lava)
  for (const [x, y, w] of joints) {
    wrap(size, (ox, oy) => {
      g.fillStyle = '#ff6a18'; g.fillRect(x + ox, y + oy - 2, w, 4);
      ge.fillStyle = 'rgba(255,255,255,0.35)'; ge.fillRect(x + ox, y + oy - 6, w, 12);
      ge.fillStyle = '#fff'; ge.fillRect(x + ox, y + oy - 2, w, 4);
    });
  }
  // a few jagged cracks through the blocks
  const cracks = [];
  for (let k = 0; k < 6; k++) {
    const pts = crackPath(rng, rng() * size, rng() * size, (rng() < 0.7 ? Math.PI / 2 : 0) + (rng() - 0.5) * 0.8, 70 + rng() * 120, 7);
    cracks.push(pts);
    if (rng() < 0.5) { const p = pts[Math.floor(pts.length / 2)]; cracks.push(crackPath(rng, p[0], p[1], rng() * Math.PI * 2, 20 + rng() * 40, 6)); }
  }
  for (const pts of cracks) {
    wrap(size, (ox, oy) => {
      const q = pts.map(([a, b]) => [a + ox, b + oy]);
      g.strokeStyle = 'rgba(30,8,4,0.85)'; g.lineWidth = 6; strokePath(g, q);
      g.strokeStyle = '#ff6a18'; g.lineWidth = 2.6; strokePath(g, q);
      g.strokeStyle = '#ffd27a'; g.lineWidth = 1; strokePath(g, q);
      ge.strokeStyle = 'rgba(255,255,255,0.25)'; ge.lineWidth = 10; strokePath(ge, q);
      ge.strokeStyle = '#fff'; ge.lineWidth = 2.4; strokePath(ge, q);
    });
  }
  return { map: finish(c, { aniso }), glow: finish(e, { aniso }) };
}

/** Riveted iron floor plates with a diamond tread, soot and oil stains (tile ~4 m). */
export function createIronPlateTexture({ size = 512, aniso = 1, seed = 1205 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  g.fillStyle = '#2c2b30'; g.fillRect(0, 0, size, size);
  const P = size / 2;
  for (let py = 0; py < 2; py++) for (let px = 0; px < 2; px++) {
    const x0 = px * P, y0 = py * P, v = 70 + rng() * 22;
    g.fillStyle = `rgb(${v | 0},${v - 2 | 0},${v + 4 | 0})`; g.fillRect(x0 + 3, y0 + 3, P - 6, P - 6);
    // diamond tread
    g.fillStyle = 'rgba(255,255,255,0.10)';
    for (let yy = y0 + 14; yy < y0 + P - 10; yy += 16) for (let xx = x0 + 14 + ((yy / 16) % 2) * 8; xx < x0 + P - 10; xx += 16) {
      g.save(); g.translate(xx, yy); g.rotate(((xx + yy) / 16) % 2 ? 0.8 : -0.8); g.fillRect(-5, -1.3, 10, 2.6); g.restore();
    }
    // rivets
    for (let k = 0; k < 4; k++) for (const t of [0.06, 0.94]) {
      const rx = x0 + P * lerp(0.06, 0.94, k / 3), ry = y0 + P * t;
      for (const [ax, ay] of [[rx, ry], [y0 + P * t - y0 + x0, y0 + P * lerp(0.06, 0.94, k / 3)]]) {
        g.fillStyle = '#1a191c'; g.beginPath(); g.arc(ax + 1, ay + 1, 4.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#8a8a92'; g.beginPath(); g.arc(ax, ay, 3.8, 0, Math.PI * 2); g.fill();
      }
    }
  }
  const n = tileFbm(size, 4, 4, rng, 0.55);
  grain(g, size, (i) => { const k = (n[i] - 0.5) * 34 - Math.max(0, n[i] - 0.62) * 90 + (rng() - 0.5) * 8; return [k * 1.02, k, k * 0.95]; });
  // oil / scorch stains
  for (let k = 0; k < 7; k++) {
    const x = rng() * size, y = rng() * size, r = 18 + rng() * 40;
    wrap(size, (ox, oy) => {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, 'rgba(8,6,6,0.45)'); gr.addColorStop(1, 'rgba(8,6,6,0)');
      g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    });
  }
  return finish(c, { aniso });
}

/**
 * Conveyor belt: dark ridged rubber slats with bright chevrons pointing +v
 * (forward). Grey-scale (the material colour tints it per belt state); the
 * second texture is the chevron mask for the emissive glow.
 */
export function createBeltTextures({ size = 256, aniso = 1, seed = 1207 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  const e = canvas(size, size), ge = e.getContext('2d');
  g.fillStyle = '#202024'; g.fillRect(0, 0, size, size);
  ge.fillStyle = '#000'; ge.fillRect(0, 0, size, size);
  const slats = 16, sh = size / slats;
  for (let k = 0; k < slats; k++) {
    const y = k * sh;
    g.fillStyle = '#34343a'; g.fillRect(0, y + 2, size, sh - 4);
    g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(0, y + 2, size, 2);
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, y + sh - 3, size, 3);
  }
  const n = tileNoise(size, 16, rng);
  grain(g, size, (i) => { const k = (n[i] - 0.5) * 14 + (rng() - 0.5) * 10; return [k, k, k]; });
  // chevrons (canvas top = +v = forward: the tip points up)
  const chev = (gg, col, cx, cy, w, h, t) => {
    gg.fillStyle = col;
    gg.beginPath();
    gg.moveTo(cx - w / 2, cy + h / 2); gg.lineTo(cx, cy - h / 2); gg.lineTo(cx + w / 2, cy + h / 2);
    gg.lineTo(cx + w / 2 - t, cy + h / 2); gg.lineTo(cx, cy - h / 2 + t * 1.3); gg.lineTo(cx - w / 2 + t, cy + h / 2);
    gg.closePath(); gg.fill();
  };
  for (const cy of [size * 0.25, size * 0.75]) {
    chev(g, 'rgba(60,60,64,1)', size / 2, cy, size * 0.62, size * 0.26, size * 0.09);
    chev(ge, '#fff', size / 2, cy, size * 0.62, size * 0.26, size * 0.09);
  }
  // side guide stripes
  g.fillStyle = '#4a4a50'; g.fillRect(0, 0, size * 0.04, size); g.fillRect(size * 0.96, 0, size * 0.04, size);
  return { map: finish(c, { aniso }), glow: finish(e, { aniso, srgb: false }) };
}

/** Iron floor grate over glowing lava (unlit material; u across, v along). */
export function createGrateTexture({ size = 256, aniso = 1, seed = 1209 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 4, 4, rng, 0.55);
  for (let i = 0; i < size * size; i++) {
    const h = clamp(1.1 - n[i] * 0.9, 0, 1);
    d[i * 4] = lerp(170, 255, h); d[i * 4 + 1] = lerp(40, 190, h * h); d[i * 4 + 2] = lerp(8, 60, h * h * h); d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const bars = 8, bw = size / bars;
  g.fillStyle = '#1c1a1e';
  for (let k = 0; k < bars; k++) { g.fillRect(k * bw, 0, bw * 0.32, size); g.fillRect(0, k * bw, size, bw * 0.32); }
  g.fillStyle = 'rgba(255,255,255,0.10)';
  for (let k = 0; k < bars; k++) { g.fillRect(k * bw, 0, bw * 0.08, size); g.fillRect(0, k * bw, size, bw * 0.08); }
  g.strokeStyle = '#121014'; g.lineWidth = size * 0.05; g.strokeRect(0, 0, size, size);
  return finish(c, { aniso });
}

/** Banquet floor: polished black / cream marble checker with veins and a gold inlay border (2 squares per tile). */
export function createMarbleTexture({ size = 512, aniso = 1, seed = 1211 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  const n = tileFbm(size, 6, 5, rng, 0.6);
  const img = g.createImageData(size, size), d = img.data;
  const half = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    const dark = ((x < half) !== (y < half));
    const vein = Math.max(0, 1 - Math.abs(Math.sin((x + y) * 0.02 + n[i] * 9)) * 6);
    const base = dark ? 34 : 196, k = (n[i] - 0.5) * (dark ? 26 : 30);
    const vv = dark ? vein * 70 : -vein * 60;
    d[i * 4] = clamp(base + k + vv + (dark ? 2 : 8), 0, 255);
    d[i * 4 + 1] = clamp(base + k + vv - (dark ? 2 : 2), 0, 255);
    d[i * 4 + 2] = clamp(base + k + vv + (dark ? 6 : -10), 0, 255);
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = 'rgba(200,150,50,0.9)'; g.lineWidth = 4;
  g.strokeRect(2, 2, size - 4, size - 4);
  g.beginPath(); g.moveTo(half, 0); g.lineTo(half, size); g.moveTo(0, half); g.lineTo(size, half); g.stroke();
  return finish(c, { aniso });
}

/** Stained glass (emissive, unlit): a pointed window with leaded panes in jewel colours and a crown. */
export function createStainedGlassTexture({ w = 128, h = 256, seed = 1213 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#0a0808'; g.fillRect(0, 0, w, h);
  const cols = ['#c8202c', '#2050c0', '#e0a020', '#20a060', '#8030b0', '#e05a10'];
  const arch = () => { g.beginPath(); g.moveTo(8, h - 6); g.lineTo(8, h * 0.3); g.quadraticCurveTo(8, 6, w / 2, 6); g.quadraticCurveTo(w - 8, 6, w - 8, h * 0.3); g.lineTo(w - 8, h - 6); g.closePath(); };
  g.save(); arch(); g.clip();
  const pw = w / 4, ph = h / 8;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) {
    g.fillStyle = cols[Math.floor(rng() * cols.length)];
    g.fillRect(x * pw, y * ph, pw, ph);
    g.fillStyle = `rgba(255,255,255,${0.05 + rng() * 0.15})`; g.fillRect(x * pw + 3, y * ph + 3, pw * 0.4, ph * 0.3);
  }
  // crown medallion
  g.fillStyle = '#ffd04a';
  g.beginPath(); g.arc(w / 2, h * 0.4, w * 0.26, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#9c1420';
  g.beginPath(); g.arc(w / 2, h * 0.4, w * 0.2, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffd04a';
  const cx = w / 2, cy = h * 0.4, cw = w * 0.24;
  g.beginPath(); g.moveTo(cx - cw / 2, cy + 8); g.lineTo(cx - cw / 2, cy - 6); g.lineTo(cx - cw / 4, cy); g.lineTo(cx, cy - 10); g.lineTo(cx + cw / 4, cy); g.lineTo(cx + cw / 2, cy - 6); g.lineTo(cx + cw / 2, cy + 8); g.closePath(); g.fill();
  // leading
  g.strokeStyle = '#121010'; g.lineWidth = 3;
  for (let x = 1; x < 4; x++) { g.beginPath(); g.moveTo(x * pw, 0); g.lineTo(x * pw, h); g.stroke(); }
  for (let y = 1; y < 8; y++) { g.beginPath(); g.moveTo(0, y * ph); g.lineTo(w, y * ph); g.stroke(); }
  g.restore();
  g.lineWidth = 6; g.strokeStyle = '#2a2420'; arch(); g.stroke();
  return finish(c, { repeat: false });
}
