// Breezy Bay Circuit canvas textures (browser only; SPEC §16.1 "richer
// per-track materials"). Same conventions as textures.js: every creator draws
// into a fresh canvas and returns a THREE texture the caller disposes
// (world.js registers them with ctx.tex). Seeded, so identical on every load.
//
//   createBayDecalAtlas()    2 × 2 road-paint atlas: tyre skids · crab · wave · beach-ball pictograms
//   createSandTexture()      wind-rippled sand for the beach-loop verges / boardwalk dunes
//   createStrataTexture()    layered sandstone for the cliff faces (v = height)
//   createFoamTexture()      white surf blotches with alpha (the notch, the surge front)
//   createMacroNoiseTexture() tileable low-frequency grey noise (linear) for road macro variation
//   createNetTexture()       a rope net with alpha (the beach-ball catch net)

import * as THREE from 'three';
import { makeRng, clamp, lerp } from './utils.js';
import { tileFbm } from './textures.js';

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

// ------------------------------------------------------------------ road paint atlas

/** Atlas cells (u0, v0, u1, v1) of createBayDecalAtlas (v up, as UVs). 4 px gutters. */
export const BAY_DECALS = {
  skid: [0.0, 0.5, 0.5, 1.0],
  crab: [0.5, 0.5, 1.0, 1.0],
  wave: [0.0, 0.0, 0.5, 0.5],
  ball: [0.5, 0.0, 1.0, 0.5],
};

// Worn road paint: draw `fn` (white, full alpha) into a cell, then erode it with noise.
function paintCell(g, x0, y0, w, h, rng, fn, { wear = 0.25 } = {}) {
  g.save();
  g.translate(x0, y0);
  g.beginPath(); g.rect(4, 4, w - 8, h - 8); g.clip();
  fn(g, w, h);
  g.restore();
  // speckled wear
  const img = g.getImageData(x0, y0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const k = 1 - wear * rng() * rng();
    d[i + 3] = Math.round(d[i + 3] * (rng() < 0.02 ? 0.35 : k));
  }
  g.putImageData(img, x0, y0);
}

export function createBayDecalAtlas({ size = 1024, aniso = 1, seed = 301 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  const H = size / 2;
  // canvas y is flipped against v: the TOP half of the canvas is v 0.5..1
  // skid marks (top-left): dark rubber arcs, soft edges, along the cell's v axis
  paintCell(g, 0, 0, H, H, rng, (gg, w, h) => {
    for (let k = 0; k < 9; k++) {
      const x = w * (0.18 + 0.64 * rng()), bend = (rng() - 0.5) * w * 0.5, wd = 5 + rng() * 9;
      gg.strokeStyle = `rgba(18,18,22,${0.35 + rng() * 0.35})`;
      gg.lineWidth = wd; gg.lineCap = 'round';
      gg.beginPath();
      gg.moveTo(x, h * (0.02 + rng() * 0.2));
      gg.quadraticCurveTo(x + bend, h * 0.5, x + bend * 0.4, h * (0.8 + rng() * 0.18));
      gg.stroke();
    }
  }, { wear: 0.5 });
  const white = 'rgba(252,250,240,0.95)';
  // crab pictogram (top-right): a big friendly crab silhouette in a road-paint diamond
  paintCell(g, H, 0, H, H, rng, (gg, w, h) => {
    gg.translate(w / 2, h / 2);
    gg.strokeStyle = white; gg.lineWidth = w * 0.045;
    gg.beginPath(); gg.moveTo(0, -h * 0.46); gg.lineTo(w * 0.46, 0); gg.lineTo(0, h * 0.46); gg.lineTo(-w * 0.46, 0); gg.closePath(); gg.stroke();
    gg.fillStyle = white;
    gg.beginPath(); gg.ellipse(0, h * 0.04, w * 0.17, h * 0.11, 0, 0, Math.PI * 2); gg.fill();          // body
    for (const sx of [-1, 1]) {
      gg.lineWidth = w * 0.03; gg.lineCap = 'round';
      for (let k = 0; k < 3; k++) {                                                                       // legs
        gg.beginPath(); gg.moveTo(sx * w * 0.12, h * (0.06 + k * 0.035));
        gg.lineTo(sx * w * 0.27, h * (0.1 + k * 0.06)); gg.lineTo(sx * w * 0.31, h * (0.18 + k * 0.05)); gg.stroke();
      }
      gg.beginPath(); gg.moveTo(sx * w * 0.12, -h * 0.02); gg.lineTo(sx * w * 0.2, -h * 0.13); gg.stroke();   // arm
      gg.beginPath(); gg.arc(sx * w * 0.22, -h * 0.2, w * 0.07, sx > 0 ? -2.4 : -0.7, sx > 0 ? 1.0 : 3.8); gg.lineTo(sx * w * 0.22, -h * 0.2); gg.fill();   // claw
      gg.beginPath(); gg.arc(sx * w * 0.05, -h * 0.1, w * 0.025, 0, Math.PI * 2); gg.fill();               // eye
    }
  });
  // wave pictogram (bottom-left): a breaking wave over a line, in the diamond
  paintCell(g, 0, H, H, H, rng, (gg, w, h) => {
    gg.translate(w / 2, h / 2);
    gg.strokeStyle = white; gg.lineWidth = w * 0.045;
    gg.beginPath(); gg.moveTo(0, -h * 0.46); gg.lineTo(w * 0.46, 0); gg.lineTo(0, h * 0.46); gg.lineTo(-w * 0.46, 0); gg.closePath(); gg.stroke();
    gg.fillStyle = white;
    gg.beginPath();
    gg.moveTo(-w * 0.27, h * 0.14);
    gg.bezierCurveTo(-w * 0.22, -h * 0.12, w * 0.02, -h * 0.26, w * 0.18, -h * 0.12);
    gg.bezierCurveTo(w * 0.05, -h * 0.14, -w * 0.02, -h * 0.02, w * 0.06, h * 0.06);
    gg.lineTo(w * 0.27, h * 0.06); gg.lineTo(w * 0.27, h * 0.14); gg.closePath(); gg.fill();
    gg.lineWidth = w * 0.03;
    for (const y of [0.22, 0.3]) { gg.beginPath(); gg.moveTo(-w * 0.24, h * y); gg.quadraticCurveTo(0, h * (y - 0.05), w * 0.24, h * y); gg.stroke(); }
  });
  // beach-ball pictogram (bottom-right): a striped ball with motion arcs
  paintCell(g, H, H, H, H, rng, (gg, w, h) => {
    gg.translate(w / 2, h / 2);
    gg.strokeStyle = white; gg.lineWidth = w * 0.045;
    gg.beginPath(); gg.moveTo(0, -h * 0.46); gg.lineTo(w * 0.46, 0); gg.lineTo(0, h * 0.46); gg.lineTo(-w * 0.46, 0); gg.closePath(); gg.stroke();
    const R = w * 0.17;
    gg.save();
    gg.beginPath(); gg.arc(0, 0, R, 0, Math.PI * 2); gg.clip();
    gg.fillStyle = white;
    for (let k = -2; k <= 2; k += 2) { gg.beginPath(); gg.ellipse(k * R * 0.42, 0, R * 0.2, R * 1.2, 0, 0, Math.PI * 2); gg.fill(); }   // stripes
    gg.restore();
    gg.lineWidth = w * 0.03;
    gg.beginPath(); gg.arc(0, 0, R, 0, Math.PI * 2); gg.stroke();
    gg.lineWidth = w * 0.022;
    for (const k of [1.35, 1.7]) { gg.beginPath(); gg.arc(0, 0, R * k, Math.PI * 0.62, Math.PI * 0.95); gg.stroke(); }   // motion arcs
  });
  return finish(c, { aniso, repeat: false });
}

// ------------------------------------------------------------------ sand

export function createSandTexture({ size = 512, aniso = 1, seed = 303, base = [236, 214, 160] } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const blot = tileFbm(size, 6, 4, rng, 0.55);
  const rip = tileFbm(size, 16, 2, rng, 0.5);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // wind ripples: bands across v, wobbling with the noise
      const r = Math.sin((y / size) * Math.PI * 2 * 22 + rip[i] * 9) * 0.5 + 0.5;
      let v = (blot[i] - 0.5) * 30 + (r - 0.5) * 14 + (rng() - 0.5) * 18;
      if (rng() < 0.01) v -= 30;                 // dark grains
      else if (rng() < 0.012) v += 22;           // shell glints
      d[i * 4] = clamp(base[0] + v, 0, 255);
      d[i * 4 + 1] = clamp(base[1] + v * 0.95, 0, 255);
      d[i * 4 + 2] = clamp(base[2] + v * 0.8, 0, 255);
      d[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return finish(c, { aniso });
}

// ------------------------------------------------------------------ cliff strata

/** Layered sandstone; u repeats along the cliff, v = height (1 tile = 8 m of rock). */
export function createStrataTexture({ size = 512, aniso = 1, seed = 305 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 8, 4, rng, 0.55);
  const wob = tileFbm(size, 4, 2, rng, 0.5);
  // band palette: ochre, cream, rust, sand, dusty pink
  const bands = [[196, 146, 92], [226, 196, 150], [170, 104, 70], [214, 170, 118], [200, 150, 128], [184, 128, 84], [230, 206, 160]];
  const nb = 13, widths = [];
  let sum = 0;
  for (let k = 0; k < nb; k++) { const w = 0.5 + rng(); widths.push(w); sum += w; }
  const edges = []; let acc = 0;
  for (let k = 0; k < nb; k++) { acc += widths[k] / sum; edges.push(acc); }
  const cols = Array.from({ length: nb }, () => bands[Math.floor(rng() * bands.length)]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      let t = (y / size + (wob[i] - 0.5) * 0.06 + 1) % 1;
      let b = 0; while (b < nb - 1 && t > edges[b]) b++;
      const col = cols[b];
      const edge = Math.min(Math.abs(t - (edges[b - 1] || 0)), Math.abs(edges[b] - t)) * size;
      let v = (n[i] - 0.5) * 46 + (rng() - 0.5) * 16 - (edge < 2 ? 26 : 0);   // dark seams between layers
      if (rng() < 0.004) v -= 40;                                            // pits
      d[i * 4] = clamp(col[0] + v, 0, 255);
      d[i * 4 + 1] = clamp(col[1] + v * 0.92, 0, 255);
      d[i * 4 + 2] = clamp(col[2] + v * 0.85, 0, 255);
      d[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // vertical cracks
  for (let k = 0; k < 14; k++) {
    const x = rng() * size;
    g.strokeStyle = `rgba(70,40,25,${0.25 + rng() * 0.25})`; g.lineWidth = 1 + rng() * 2;
    g.beginPath(); g.moveTo(x, rng() * size);
    for (let s = 0; s < 6; s++) g.lineTo(x + (rng() - 0.5) * 20, rng() * size);
    g.stroke();
  }
  return finish(c, { aniso });
}

// ------------------------------------------------------------------ foam

export function createFoamTexture({ size = 256, seed = 307 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 8, 4, rng, 0.6);
  const m = tileFbm(size, 24, 2, rng, 0.5);
  for (let i = 0; i < size * size; i++) {
    const v = n[i] * 0.7 + m[i] * 0.5;
    const a = clamp((v - 0.55) / 0.2, 0, 1);
    d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255;
    d[i * 4 + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  return finish(c, {});
}

// ------------------------------------------------------------------ macro noise (data)

/** Tileable low-frequency grey noise in R (linear colour space), 128 px. */
export function createMacroNoiseTexture({ size = 128, seed = 309 } = {}) {
  const rng = makeRng(seed);
  const n = tileFbm(size, 4, 4, rng, 0.55);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(clamp(n[i], 0, 1) * 255);
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ net

export function createNetTexture({ size = 128 } = {}) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.strokeStyle = 'rgba(245,245,235,1)'; g.lineWidth = 3;
  const k = size / 4;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(0, i * k); g.lineTo(size, i * k); g.stroke();
    g.beginPath(); g.moveTo(i * k, 0); g.lineTo(i * k, size); g.stroke();
  }
  return finish(c, {});
}
