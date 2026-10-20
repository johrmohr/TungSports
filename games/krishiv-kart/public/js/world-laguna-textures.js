// Laguna Beach canvas textures (browser only; SPEC §16.1 "richer per-track
// materials"). Used by world-laguna.js / world-laguna-setpieces.js only, so
// the shared textures.js kit stays untouched. Every creator draws into a fresh
// canvas and returns a THREE.CanvasTexture the caller owns (ctx.tex()).
// Seeded (utils.makeRng): identical on every load.
//
//   createLagunaRoadTexture   sun-bleached coastal asphalt: warm grey aggregate,
//                             tar-sealed cracks, patch repairs, worn white edge
//                             lines, NO centre line (the kit paints those per
//                             zone with the decal atlas: dashed white in the
//                             village, double yellow up the canyon)
//   createLagunaDecalAtlas    one 2048 × 1024 atlas of vertical columns that
//                             each tile along v (LAGUNA_DECALS gives the u
//                             range of each): road paint (white / dashed /
//                             double yellow / crosswalk / green bike lane),
//                             wind-blown sand drifts (alpha), the tide-pool
//                             rock shelf, ice plant, beach sand — every painted
//                             road / verge detail of the track in ONE draw call
//   createSurfTexture         tileable surf: translucent sea-green water with
//                             foam streaks + bubbles (the wave sheet; alpha)
//   createRingTexture         the volleyball landing marker (ring + dot, alpha)
//   createPictogramAtlas      2 × 2 warning signs (icons only, no text): wave,
//                             volleyball, blowhole, tower jump

import * as THREE from 'three';
import { makeRng, clamp, lerp } from './utils.js';
import { tileFbm } from './textures.js';

const smoothstepish = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function finish(canvas, { srgb = true, repeat = true, aniso = 1, mipmaps = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = aniso;
  tex.generateMipmaps = mipmaps;
  tex.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
// a wobbly polyline that wraps vertically (seamless along v)
function crackPath(g, size, rng, x, y, len, { width = 2, color = 'rgba(30,30,32,0.55)' } = {}) {
  g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round';
  for (const oy of [-size, 0, size]) {
    let px = x, py = y + oy, a = rng() * Math.PI * 2;
    g.beginPath(); g.moveTo(px, py);
    for (let k = 0; k < len; k++) {
      a += (rng() - 0.5) * 1.2;
      px += Math.cos(a) * 9; py += Math.sin(a) * 9;
      g.lineTo(px, py);
    }
    g.stroke();
  }
}

// ------------------------------------------------------------------ road

export function createLagunaRoadTexture({ size = 1024, aniso = 1, seed = 1101 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const blot = tileFbm(size, 6, 5, rng, 0.55), fine = tileFbm(size, 64, 2, rng, 0.5);
  const base = [104, 102, 100];                                  // sun-bleached, warm
  for (let i = 0; i < size * size; i++) {
    let v = (blot[i] - 0.5) * 30 + (fine[i] - 0.5) * 18 + (rng() - 0.5) * 18;
    if (rng() < 0.014) v += 26 + rng() * 30;                     // pale aggregate
    else if (rng() < 0.012) v -= 26;                             // pits
    d[i * 4] = clamp(base[0] + v + 3, 0, 255);
    d[i * 4 + 1] = clamp(base[1] + v, 0, 255);
    d[i * 4 + 2] = clamp(base[2] + v * 0.95 - 3, 0, 255);
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // patch repairs (slightly darker, soft-edged) — kept off the edge lines
  for (let k = 0; k < 2; k++) {
    const w = size * (0.1 + rng() * 0.14), h = size * (0.08 + rng() * 0.14);
    const x = size * (0.15 + rng() * 0.7) - w / 2, y = rng() * size, a = 0.08 + rng() * 0.06;
    for (const oy of [-size, 0, size]) {
      g.fillStyle = `rgba(52,52,56,${a})`; g.fillRect(x, y + oy, w, h);
      g.strokeStyle = `rgba(30,30,32,${a * 1.2})`; g.lineWidth = 2; g.strokeRect(x, y + oy, w, h);
    }
  }
  // tar-sealed cracks
  for (let k = 0; k < 7; k++) crackPath(g, size, rng, size * (0.08 + rng() * 0.84), rng() * size, 8 + Math.floor(rng() * 14), { width: 2.5 + rng() * 1.5, color: `rgba(34,34,36,${0.22 + rng() * 0.18})` });
  // faint tyre polish in the two wheel tracks of each lane
  const grad = g.createLinearGradient(0, 0, size, 0);
  for (const [u, a] of [[0, 0], [0.18, 0.1], [0.3, 0.02], [0.42, 0.1], [0.5, 0.02], [0.58, 0.1], [0.7, 0.02], [0.82, 0.1], [1, 0]]) grad.addColorStop(u, `rgba(26,26,32,${a})`);
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  // sand dusting toward both edges (it is a beach town)
  for (const [x0, x1] of [[0, 0.1], [0.9, 1]]) {
    for (let k = 0; k < 1400; k++) {
      const u = lerp(x0, x1, rng()), edge = x0 === 0 ? 1 - u / 0.1 : (u - 0.9) / 0.1;
      if (rng() > edge) continue;
      g.fillStyle = `rgba(214,190,140,${0.25 + rng() * 0.3})`;
      g.fillRect(u * size, rng() * size, 2 + rng() * 3, 2 + rng() * 2);
    }
  }
  // worn white edge lines
  const ew = Math.round(size * 0.013);
  for (const x0 of [Math.round(size * 0.018), size - Math.round(size * 0.018) - ew]) {
    for (let y = 0; y < size; y += 2) {
      g.fillStyle = `rgba(250,249,240,${0.9 * (0.75 + rng() * 0.25)})`;
      g.fillRect(x0, y, ew, 2);
    }
  }
  return finish(c, { aniso });
}

// ------------------------------------------------------------------ decal atlas

const ATLAS_W = 2048, ATLAS_H = 1024, PAD = 4;
const COLS = [
  ['white', 32], ['dash', 32], ['yellow', 72], ['cross', 64], ['bike', 128], ['drift', 256],
  ['rock', 512], ['ice', 384], ['sand', 488],
];
/** u range [u0, u1] (inset past the padding) of each atlas column; columns tile along v. */
export const LAGUNA_DECALS = {};
{
  let x = 0;
  for (const [name, w] of COLS) {
    LAGUNA_DECALS[name] = [(x + PAD) / ATLAS_W, (x + w - PAD) / ATLAS_W, x, w];
    x += w;
  }
}

export function createLagunaDecalAtlas({ aniso = 1, seed = 1103 } = {}) {
  const rng = makeRng(seed);
  const W = ATLAS_W, H = ATLAS_H;
  const c = makeCanvas(W, H), g = c.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, W, H);
  const col = (name) => { const [, , x, w] = LAGUNA_DECALS[name]; return { x, w }; };
  const worn = (x, y, w, h, rgb, a = 0.92) => {
    for (let yy = y; yy < y + h; yy += 2) {
      g.fillStyle = `rgba(${rgb},${a * (0.72 + rng() * 0.28)})`;
      g.fillRect(x, yy, w, 2);
    }
    for (let k = 0; k < (w * h) / 90; k++) { g.clearRect(x + rng() * w, y + rng() * h, 2 + rng() * 3, 2); }
  };
  // road paint
  { const { x, w } = col('white'); worn(x, 0, w, H, '250,249,240'); }
  { const { x, w } = col('dash'); worn(x, 0, w, H * 0.5, '250,249,240'); }
  { const { x, w } = col('yellow'); const sw = Math.round(w * 0.36); worn(x, 0, sw, H, '246,196,40'); worn(x + w - sw, 0, sw, H, '246,196,40'); }
  { const { x, w } = col('cross'); worn(x, 0, w, H, '252,252,246', 0.95); }
  {
    const { x, w } = col('bike');
    g.fillStyle = 'rgba(64,158,92,0.85)'; g.fillRect(x, 0, w, H);
    for (let k = 0; k < 900; k++) { g.fillStyle = `rgba(30,90,50,${rng() * 0.25})`; g.fillRect(x + rng() * w, rng() * H, 3, 3); }
    // white bicycle pictogram once per tile (generic icon: two wheels, frame, rider dot)
    const cx = x + w / 2, cy = H * 0.5;
    g.strokeStyle = 'rgba(250,250,245,0.95)'; g.lineWidth = 6;
    g.beginPath(); g.arc(cx, cy - 70, 26, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cx, cy + 70, 26, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(cx, cy - 70); g.lineTo(cx - 10, cy); g.lineTo(cx, cy + 70); g.moveTo(cx - 10, cy); g.lineTo(cx + 16, cy - 40); g.stroke();
    g.fillStyle = 'rgba(250,250,245,0.95)'; g.beginPath(); g.arc(cx + 22, cy - 10, 9, 0, Math.PI * 2); g.fill();
  }
  // wind-blown sand drift: opaque toward the outer edge (u = 1), fraying inward
  {
    const { x, w } = col('drift');
    const n = tileFbm(256, 8, 4, rng, 0.55);
    const img = g.getImageData(x, 0, w, H), d = img.data;
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < w; xx++) {
      const u = xx / (w - 1), nv = n[((yy * 256 / H) | 0) % 256 * 256 + ((xx * 256 / w) | 0)];
      const ripple = 0.5 + 0.5 * Math.sin(yy * 0.22 + nv * 9);
      const a = clamp((u * 1.35 - 0.35 + (nv - 0.5) * 0.9) * 1.6, 0, 1);
      const i = (yy * w + xx) * 4;
      d[i] = 226 + ripple * 14; d[i + 1] = 202 + ripple * 12; d[i + 2] = 150 + ripple * 10; d[i + 3] = a * 235;
    }
    g.putImageData(img, x, 0);
  }
  // tide-pool rock shelf: dark wet sandstone with cracks, barnacles, green
  // algae, mussel clumps and small teal pools
  {
    const { x, w } = col('rock');
    const n = tileFbm(512, 6, 5, rng, 0.55), n2 = tileFbm(512, 16, 3, rng, 0.5);
    const img = g.getImageData(x, 0, w, H), d = img.data;
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < w; xx++) {
      const a = n[((yy >> 1) % 512) * 512 + xx], b = n2[((yy >> 1) % 512) * 512 + xx];
      let r = 96 + (a - 0.5) * 50 + (b - 0.5) * 14, gg = 88 + (a - 0.5) * 44 + (b - 0.5) * 12, bb = 78 + (a - 0.5) * 36 + (b - 0.5) * 10;
      if (a > 0.58) { r -= 30; gg -= 22; bb -= 14; }                        // wet hollows
      if (b > 0.66 && a < 0.55) { r = lerp(r, 70, 0.6); gg = lerp(gg, 128, 0.6); bb = lerp(bb, 60, 0.6); }   // algae
      if (a > 0.66) { const w = smoothstepish((a - 0.66) / 0.05); r = lerp(r, 60, w); gg = lerp(gg, 150, w); bb = lerp(bb, 150, w); }   // pools
      const i = (yy * w + xx) * 4;
      d[i] = clamp(r, 0, 255); d[i + 1] = clamp(gg, 0, 255); d[i + 2] = clamp(bb, 0, 255); d[i + 3] = 255;
    }
    g.putImageData(img, x, 0);
    g.save(); g.beginPath(); g.rect(x, 0, w, H); g.clip();
    for (let k = 0; k < 14; k++) crackPath(g, H, rng, x + rng() * w, rng() * H, 10 + Math.floor(rng() * 16), { width: 2 + rng() * 2, color: 'rgba(30,24,20,0.6)' });
    for (let k = 0; k < 420; k++) {                                          // barnacle clusters
      const bx = x + rng() * w, by = rng() * H, r = 1.2 + rng() * 1.6;
      g.fillStyle = 'rgba(214,208,192,0.85)'; g.beginPath(); g.arc(bx, by, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(60,54,48,0.7)'; g.beginPath(); g.arc(bx, by, r * 0.35, 0, Math.PI * 2); g.fill();
    }
    for (let k = 0; k < 90; k++) {                                           // mussel clumps
      const bx = x + rng() * w, by = rng() * H;
      for (let j = 0; j < 8; j++) { g.fillStyle = `rgba(30,32,44,${0.7 + rng() * 0.3})`; g.beginPath(); g.ellipse(bx + (rng() - 0.5) * 14, by + (rng() - 0.5) * 14, 4, 2, rng() * 3, 0, Math.PI * 2); g.fill(); }
    }
    g.restore();
  }
  // ice plant: fleshy green mats, red-tinged stems, magenta / pink flowers
  {
    const { x, w } = col('ice');
    g.fillStyle = '#5f8f3a'; g.fillRect(x, 0, w, H);
    g.save(); g.beginPath(); g.rect(x, 0, w, H); g.clip();
    for (let k = 0; k < 5200; k++) {
      const bx = x + rng() * w, by = rng() * H, len = 5 + rng() * 9, a = rng() * Math.PI * 2;
      const t = rng();
      g.strokeStyle = t < 0.15 ? 'rgba(170,70,60,0.7)' : `rgba(${(80 + rng() * 60) | 0},${(140 + rng() * 50) | 0},${(50 + rng() * 30) | 0},0.85)`;
      g.lineWidth = 3 + rng() * 2; g.lineCap = 'round';
      for (const oy of [-H, 0, H]) { g.beginPath(); g.moveTo(bx, by + oy); g.lineTo(bx + Math.cos(a) * len, by + oy + Math.sin(a) * len); g.stroke(); }
    }
    for (let k = 0; k < 900; k++) {
      const bx = x + rng() * w, by = rng() * H, r = 2.5 + rng() * 3.5;
      g.fillStyle = rng() < 0.7 ? '#e0359a' : rng() < 0.5 ? '#f27cc2' : '#f2d23a';
      for (const oy of [-H, 0, H]) { g.beginPath(); g.arc(bx, by + oy, r, 0, Math.PI * 2); g.fill(); }
    }
    g.restore();
  }
  // beach sand: wind ripples, footprints, shell bits
  {
    const { x, w } = col('sand');
    const n = tileFbm(512, 8, 4, rng, 0.55);
    const img = g.getImageData(x, 0, w, H), d = img.data;
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < w; xx++) {
      const nv = n[((yy >> 1) % 512) * 512 + ((xx * 512 / w) | 0)];
      const ripple = Math.sin(yy * 0.21 + Math.sin(xx * 0.03) * 2 + nv * 6) * 0.5 + 0.5;
      const v = (nv - 0.5) * 26 + ripple * 12 + (rng() - 0.5) * 10;
      const i = (yy * w + xx) * 4;
      d[i] = clamp(226 + v, 0, 255); d[i + 1] = clamp(204 + v, 0, 255); d[i + 2] = clamp(158 + v * 0.9, 0, 255); d[i + 3] = 255;
    }
    g.putImageData(img, x, 0);
    g.save(); g.beginPath(); g.rect(x, 0, w, H); g.clip();
    for (let k = 0; k < 26; k++) {                                            // footprint trails
      let fx = x + rng() * w, fy = rng() * H; const a = rng() * Math.PI * 2;
      for (let j = 0; j < 10; j++) {
        fx += Math.cos(a) * 16; fy += Math.sin(a) * 16;
        const side = j % 2 ? 5 : -5;
        g.fillStyle = 'rgba(150,120,80,0.28)';
        g.beginPath(); g.ellipse(fx - Math.sin(a) * side, fy + Math.cos(a) * side, 5, 3, a, 0, Math.PI * 2); g.fill();
      }
    }
    for (let k = 0; k < 500; k++) { g.fillStyle = rng() < 0.5 ? 'rgba(255,250,240,0.8)' : 'rgba(180,150,120,0.6)'; g.fillRect(x + rng() * w, rng() * H, 2 + rng() * 2, 2); }
    g.restore();
  }
  return finish(c, { aniso });
}

// ------------------------------------------------------------------ surf, ring, pictograms

export function createSurfTexture({ size = 512, aniso = 1, seed = 1105 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const n = tileFbm(size, 8, 4, rng, 0.55);
  const img = g.createImageData(size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = n[i];
    const foam = clamp((v - 0.6) * 5, 0, 1);
    d[i * 4] = lerp(150, 255, foam); d[i * 4 + 1] = lerp(225, 255, foam); d[i * 4 + 2] = lerp(220, 255, foam);
    d[i * 4 + 3] = lerp(150, 245, foam) + (v - 0.5) * 40;
  }
  g.putImageData(img, 0, 0);
  // foam streaks running across (parallel to the shore = along u) + bubbles
  for (let k = 0; k < 70; k++) {
    const y = rng() * size, x = rng() * size, len = size * (0.15 + rng() * 0.4);
    g.strokeStyle = `rgba(255,255,255,${0.35 + rng() * 0.45})`; g.lineWidth = 2 + rng() * 4;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      g.beginPath(); g.moveTo(x + ox, y + oy);
      g.bezierCurveTo(x + ox + len * 0.3, y + oy + (rng() - 0.5) * 20, x + ox + len * 0.7, y + oy + (rng() - 0.5) * 20, x + ox + len, y + oy);
      g.stroke();
    }
  }
  for (let k = 0; k < 900; k++) {
    const bx = rng() * size, by = rng() * size, r = 1 + rng() * 3;
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1;
    g.beginPath(); g.arc(bx, by, r, 0, Math.PI * 2); g.stroke();
  }
  return finish(c, { aniso });
}

export function createRingTexture({ size = 128 } = {}) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const m = size / 2;
  g.clearRect(0, 0, size, size);
  g.fillStyle = 'rgba(255,255,255,0.28)'; g.beginPath(); g.arc(m, m, size * 0.42, 0, Math.PI * 2); g.fill();   // the zone
  g.lineWidth = size * 0.11; g.strokeStyle = 'rgba(255,255,255,1)';
  g.beginPath(); g.arc(m, m, size * 0.42, 0, Math.PI * 2); g.stroke();
  g.setLineDash([size * 0.08, size * 0.06]); g.lineWidth = size * 0.05;
  g.beginPath(); g.arc(m, m, size * 0.25, 0, Math.PI * 2); g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(255,255,255,1)'; g.beginPath(); g.arc(m, m, size * 0.08, 0, Math.PI * 2); g.fill();
  return finish(c, { repeat: false });
}

/** 2 × 2 icons: [0] wave, [1] volleyball, [2] blowhole, [3] jump (u0, v0 of each cell = PICTO[k]). */
export const PICTO = [[0, 0.5], [0.5, 0.5], [0, 0], [0.5, 0]];
export function createPictogramAtlas({ size = 512, aniso = 1 } = {}) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const s = size / 2;
  const sign = (cx, cy, draw) => {
    // yellow diamond with a black border (generic warning sign shape)
    g.save(); g.translate(cx, cy);
    g.fillStyle = '#1a1a1a'; g.beginPath(); g.moveTo(0, -s * 0.48); g.lineTo(s * 0.48, 0); g.lineTo(0, s * 0.48); g.lineTo(-s * 0.48, 0); g.closePath(); g.fill();
    g.fillStyle = '#ffcf2e'; g.beginPath(); g.moveTo(0, -s * 0.43); g.lineTo(s * 0.43, 0); g.lineTo(0, s * 0.43); g.lineTo(-s * 0.43, 0); g.closePath(); g.fill();
    g.fillStyle = '#1a1a1a'; g.strokeStyle = '#1a1a1a'; g.lineWidth = s * 0.05; g.lineCap = 'round'; g.lineJoin = 'round';
    draw(s);
    g.restore();
  };
  g.fillStyle = '#e8e2d4'; g.fillRect(0, 0, size, size);
  // wave (top-left in canvas = v 0.5..1)
  sign(s / 2, s / 2, (k) => {
    g.beginPath(); g.moveTo(-k * 0.26, k * 0.12);
    g.bezierCurveTo(-k * 0.2, -k * 0.2, k * 0.12, -k * 0.24, k * 0.18, -k * 0.02);
    g.bezierCurveTo(k * 0.06, -k * 0.1, -k * 0.02, k * 0.0, k * 0.04, k * 0.08);
    g.stroke();
    g.beginPath(); g.moveTo(-k * 0.28, k * 0.2); for (let i = 0; i <= 8; i++) g.lineTo(-k * 0.28 + i * k * 0.07, k * 0.2 + (i % 2 ? -k * 0.04 : 0)); g.stroke();
  });
  // volleyball
  sign(s * 1.5, s / 2, (k) => {
    g.beginPath(); g.arc(0, -k * 0.02, k * 0.18, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(-k * 0.1, -k * 0.12, k * 0.2, 0.2, 1.5); g.stroke();
    g.beginPath(); g.arc(k * 0.12, -k * 0.08, k * 0.2, 1.8, 3.2); g.stroke();
    g.beginPath(); g.moveTo(-k * 0.26, k * 0.26); g.lineTo(k * 0.26, k * 0.26); g.stroke();
  });
  // blowhole (spout from a crack)
  sign(s / 2, s * 1.5, (k) => {
    g.beginPath(); g.moveTo(-k * 0.26, k * 0.22); g.lineTo(-k * 0.08, k * 0.2); g.lineTo(0, k * 0.24); g.lineTo(k * 0.08, k * 0.2); g.lineTo(k * 0.26, k * 0.22); g.stroke();
    for (const dx of [-0.1, 0, 0.1]) { g.beginPath(); g.moveTo(dx * k * 0.4, k * 0.16); g.quadraticCurveTo(dx * k * 1.6, -k * 0.1, dx * k * 2.2, -k * 0.24); g.stroke(); }
  });
  // jump (ramp + arc)
  sign(s * 1.5, s * 1.5, (k) => {
    g.beginPath(); g.moveTo(-k * 0.28, k * 0.22); g.lineTo(-k * 0.02, k * 0.22); g.lineTo(-k * 0.02, k * 0.06); g.closePath(); g.fill();
    g.setLineDash([k * 0.05, k * 0.04]);
    g.beginPath(); g.moveTo(-k * 0.02, k * 0.04); g.quadraticCurveTo(k * 0.1, -k * 0.3, k * 0.26, k * 0.12); g.stroke();
    g.setLineDash([]);
  });
  return finish(c, { aniso, repeat: false });
}
