// Canvas textures of the Aldrich Park world (browser only, SPEC §16.1 "richer
// per-track materials"). Seeded, so every load looks the same; the caller owns
// (and disposes) each texture (world-aldrich.js registers them with ctx.tex).
//
// UV conventions (as world.js / textures.js):
//   * road textures: u 0..1 = road edge to road edge, v along the driving
//     direction (canvas top = +v); the caller tiles v per `meters` along.
//   * facades: one tile = one window bay × one storey; tinted by vertex colour.
//   * wall atlas: 4 bands (ALDRICH_WALL_BANDS), u repeats along the wall.

import * as THREE from 'three';
import { makeRng, clamp, lerp } from './utils.js';
import { tileFbm } from './textures.js';

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function finish(c, { aniso = 1, repeat = true, srgb = true } = {}) {
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
// fill pixels from fn(x, y, i) -> [r, g, b] with a seeded noise field n (0..1)
function pixels(g, w, h, fn) {
  const img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, [r, gg, b] = fn(x, y, i);
    d[i * 4] = clamp(r, 0, 255); d[i * 4 + 1] = clamp(gg, 0, 255); d[i * 4 + 2] = clamp(b, 0, 255); d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
const wrapRect = (g, size, x, y, w, h) => { g.fillRect(x, y, w, h); if (x + w > size) g.fillRect(x - size, y, w, h); if (y + h > size) g.fillRect(x, y - size, w, h); };

// ------------------------------------------------------------------ road surfaces

/**
 * The Ring Mall walkway: pale broom-finished concrete scored in ~2.6 m squares,
 * terracotta brick bands at both edges and across the walk every tile (the
 * campus' warm clay-tile walkways), weathering stains and tyre-polished wheel
 * lines. One tile = the full road width × `along` m.
 */
export function createRingMallTexture({ size = 1024, aniso = 1, seed = 301, widthM = 21, alongM = 16 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  const n = tileFbm(size, 8, 5, rng, 0.55), m = tileFbm(size, 2, 3, rng, 0.6);
  pixels(g, size, size, (x, y, i) => {
    const broom = (Math.sin(y * 1.9 + n[i] * 9) * 0.5 + 0.5) * 5;             // broom finish across the walk
    const v = 186 + (n[i] - 0.5) * 26 + (m[i] - 0.5) * 22 + broom + (rng() - 0.5) * 12 + (rng() < 0.004 ? -26 : 0);
    return [v + 4, v, v - 9];
  });
  const pxU = size / widthM, pxV = size / alongM;
  // score lines (2.6 m grid), dark groove + light lip
  const cell = 2.625;
  g.fillStyle = 'rgba(70,62,52,0.38)';
  for (let k = 1; k * cell < widthM; k++) g.fillRect(Math.round(k * cell * pxU), 0, 2, size);
  for (let k = 0; k * cell < alongM; k++) g.fillRect(0, Math.round(k * cell * pxV), size, 2);
  g.fillStyle = 'rgba(255,250,236,0.16)';
  for (let k = 1; k * cell < widthM; k++) g.fillRect(Math.round(k * cell * pxU) + 2, 0, 1, size);
  // brick band across the walk (once per tile) and along both edges
  const brick = (x0, y0, w, h, horizontal) => {
    g.fillStyle = '#9a4a2c'; g.fillRect(x0, y0, w, h);
    const bw = horizontal ? 0.45 * pxU : 0.22 * pxU, bh = horizontal ? 0.22 * pxV : 0.45 * pxV;
    for (let yy = y0; yy < y0 + h - 1; yy += bh) {
      const row = Math.round((yy - y0) / bh);
      for (let xx = x0 - (row % 2) * bw / 2; xx < x0 + w; xx += bw) {
        const t = 0.82 + rng() * 0.3;
        g.fillStyle = `rgb(${(196 * t) | 0},${(96 * t) | 0},${(62 * t) | 0})`;
        const ax = Math.max(x0, xx + 1.5), aw = Math.min(x0 + w, xx + bw - 1.5) - ax;
        if (aw > 0) g.fillRect(ax, yy + 1.5, aw, Math.min(bh - 3, y0 + h - yy - 1.5));
      }
    }
  };
  const ew = Math.round(0.85 * pxU);
  brick(0, 0, ew, size, false);
  brick(size - ew, 0, ew, size, false);
  brick(ew, Math.round(size * 0.5 - 0.5 * pxV), size - 2 * ew, Math.round(1.0 * pxV), true);
  // white edge stripe inside the bricks (readable road edge at speed)
  g.fillStyle = 'rgba(250,248,240,0.92)';
  g.fillRect(ew + 3, 0, Math.round(0.12 * pxU), size);
  g.fillRect(size - ew - 3 - Math.round(0.12 * pxU), 0, Math.round(0.12 * pxU), size);
  // stains: drips under trees, gum spots, two tyre-polished lines
  for (let k = 0; k < 60; k++) {
    const x = rng() * size, y = rng() * size, r = 2 + rng() * 14;
    g.fillStyle = `rgba(${rng() < 0.5 ? '90,80,64' : '60,58,52'},${0.05 + rng() * 0.08})`;
    g.beginPath(); g.ellipse(x, y, r, r * (0.5 + rng()), rng() * 3, 0, Math.PI * 2); g.fill();
  }
  for (const u of [0.33, 0.67]) {
    const grd = g.createLinearGradient((u - 0.05) * size, 0, (u + 0.05) * size, 0);
    grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(0.5, 'rgba(60,56,50,0.06)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect((u - 0.05) * size, 0, 0.1 * size, size);
  }
  return finish(c, { aniso });
}

/**
 * Asphalt bike path (Inner Ring, north corridor): dark aggregate asphalt,
 * white edge lines and a dashed yellow centre line (as on the campus bikeways).
 * One tile = the road width × `alongM` m (dash 3 m, gap 3 m).
 */
export function createBikewayTexture({ size = 1024, aniso = 1, seed = 303, alongM = 12, lines = true } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  const n = tileFbm(size, 16, 4, rng, 0.5), m = tileFbm(size, 3, 3, rng, 0.6);
  pixels(g, size, size, (x, y, i) => {
    const grit = rng();
    const v = 88 + (n[i] - 0.5) * 22 + (m[i] - 0.5) * 18 + (grit < 0.05 ? 34 : grit < 0.1 ? -18 : 0);
    return [v, v + 2, v + 6];
  });
  // patch repairs
  for (let k = 0; k < 5; k++) {
    g.fillStyle = `rgba(30,32,36,${0.12 + rng() * 0.1})`;
    wrapRect(g, size, rng() * size, rng() * size, 40 + rng() * 140, 20 + rng() * 80);
  }
  if (!lines) return finish(c, { aniso });
  g.fillStyle = 'rgba(244,244,236,0.92)';
  const lw = Math.round(size * 0.012);
  g.fillRect(Math.round(size * 0.03), 0, lw, size);
  g.fillRect(size - Math.round(size * 0.03) - lw, 0, lw, size);
  g.fillStyle = 'rgba(246,196,40,0.95)';
  const dash = size * 3 / alongM;
  for (let y = 0; y < size; y += dash * 2) { g.fillRect(size / 2 - lw * 1.6, y, lw * 1.2, dash); g.fillRect(size / 2 + lw * 0.4, y, lw * 1.2, dash); }
  return finish(c, { aniso });
}

/** Decomposed-granite gravel (the Meadow Spine): tan grit, pebbles, wheel ruts. */
export function createGravelTexture({ size = 1024, aniso = 1, seed = 305 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  const n = tileFbm(size, 12, 5, rng, 0.55), m = tileFbm(size, 3, 3, rng, 0.6);
  pixels(g, size, size, (x, y, i) => {
    const u = x / size;
    const rut = Math.exp(-(((u - 0.3) / 0.05) ** 2)) + Math.exp(-(((u - 0.7) / 0.05) ** 2));
    const v = 176 + (n[i] - 0.5) * 40 + (m[i] - 0.5) * 20 + (rng() - 0.5) * 30 - rut * 14;
    return [v + 12, v - 2, v - 34];
  });
  for (let k = 0; k < 2600; k++) {
    const x = rng() * size, y = rng() * size, r = 1 + rng() * 3.2;
    const t = rng();
    g.fillStyle = t < 0.4 ? 'rgba(120,104,80,0.75)' : t < 0.8 ? 'rgba(226,212,182,0.8)' : 'rgba(150,140,130,0.8)';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // soft border grass creeping in at the edges
  for (const x0 of [0, size]) {
    const grd = g.createLinearGradient(x0, 0, x0 === 0 ? size * 0.06 : size * 0.94, 0);
    grd.addColorStop(0, 'rgba(110,140,70,0.55)'); grd.addColorStop(1, 'rgba(110,140,70,0)');
    g.fillStyle = grd; g.fillRect(x0 === 0 ? 0 : size * 0.94, 0, size * 0.06, size);
  }
  return finish(c, { aniso });
}

/** Packed earth (the unpaved West Gate path): warm dirt, cracks, ruts, leaf litter. */
export function createPathDirtTexture({ size = 1024, aniso = 1, seed = 307 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  const n = tileFbm(size, 10, 5, rng, 0.55), m = tileFbm(size, 2, 3, rng, 0.6);
  pixels(g, size, size, (x, y, i) => {
    const u = x / size;
    const rut = Math.exp(-(((u - 0.32) / 0.06) ** 2)) + Math.exp(-(((u - 0.68) / 0.06) ** 2));
    const v = 150 + (n[i] - 0.5) * 36 + (m[i] - 0.5) * 26 + (rng() - 0.5) * 14 - rut * 18;
    return [v + 20, v - 2, v - 34];
  });
  g.strokeStyle = 'rgba(80,58,36,0.35)'; g.lineWidth = 1.5;
  for (let k = 0; k < 40; k++) {
    let x = rng() * size, y = rng() * size;
    g.beginPath(); g.moveTo(x, y);
    for (let j = 0; j < 5; j++) { x += (rng() - 0.5) * 40; y += (rng() - 0.5) * 40; g.lineTo(x, y); }
    g.stroke();
  }
  for (let k = 0; k < 500; k++) {                       // eucalyptus leaves + bark strips
    const x = rng() * size, y = rng() * size;
    g.fillStyle = rng() < 0.6 ? 'rgba(120,130,90,0.6)' : 'rgba(200,180,140,0.6)';
    g.beginPath(); g.ellipse(x, y, 5 + rng() * 6, 1.5, rng() * 3.14, 0, Math.PI * 2); g.fill();
  }
  return finish(c, { aniso });
}

/** Painted bike crossing (the service-road crossings): green band with white blocks and bike pictograms. */
export function createBikeCrossingTexture({ aniso = 1 } = {}) {
  const w = 512, h = 128;
  const c = canvas(w, h), g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(46,150,84,0.92)'; g.fillRect(0, 18, w, h - 36);
  g.fillStyle = 'rgba(248,248,240,0.95)';
  for (let x = 6; x < w; x += 32) { g.fillRect(x, 4, 18, 12); g.fillRect(x, h - 16, 18, 12); }
  // bike pictograms (two wheels + frame) every 128 px
  g.strokeStyle = 'rgba(250,250,244,0.95)'; g.lineWidth = 4;
  for (let x = 64; x < w; x += 128) {
    g.beginPath(); g.arc(x - 18, 68, 13, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(x + 18, 68, 13, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(x - 18, 68); g.lineTo(x - 4, 46); g.lineTo(x + 12, 46); g.lineTo(x + 18, 68); g.moveTo(x - 4, 46); g.lineTo(x + 2, 68); g.lineTo(x - 18, 68); g.stroke();
  }
  const t = finish(c, { aniso });
  return t;
}

/**
 * Scenery footway paving (decals on the terrain: the un-driven Ring Mall,
 * plazas, footways): small sand concrete pavers, tinted per path by vertex colour.
 */
export function createPaverTexture({ size = 512, aniso = 1, seed = 309 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  const n = tileFbm(size, 8, 4, rng, 0.5);
  pixels(g, size, size, (x, y, i) => { const v = 214 + (n[i] - 0.5) * 24 + (rng() - 0.5) * 10; return [v, v - 3, v - 10]; });
  const cell = size / 8;
  g.fillStyle = 'rgba(90,80,66,0.28)';
  for (let k = 0; k < 8; k++) { g.fillRect(0, k * cell, size, 2); for (let j = 0; j < 8; j++) g.fillRect(j * cell + (k % 2) * cell / 2, k * cell, 2, cell); }
  for (let k = 0; k < 40; k++) {
    g.fillStyle = `rgba(80,70,60,${0.04 + rng() * 0.06})`;
    g.beginPath(); g.arc(rng() * size, rng() * size, 3 + rng() * 16, 0, Math.PI * 2); g.fill();
  }
  return finish(c, { aniso });
}

/**
 * Terrain detail (multiplied with the terrain's vertex colours): fine grass
 * blades and soil grain, plus faint mower stripes (one light / one dark band
 * per tile) — the park's lawns are mown in straight passes.
 */
export function createLawnDetailTexture({ size = 512, aniso = 1, seed = 311 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  const n = tileFbm(size, 16, 4, rng, 0.55);
  pixels(g, size, size, (x, y, i) => {
    const stripe = 0;
    const v = 226 + (n[i] - 0.5) * 34 + (rng() - 0.5) * 22 + stripe;
    return [v, v, v];
  });
  for (let k = 0; k < 2200; k++) {
    const x = rng() * size, y = rng() * size;
    g.strokeStyle = rng() < 0.5 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.16)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rng() - 0.5) * 3, y - 3 - rng() * 5); g.stroke();
  }
  return finish(c, { aniso });
}

// ------------------------------------------------------------------ walls

/** Campus barriers (bands, like textures.js wallBandV): rail / hedge / seat wall / timber. */
export const ALDRICH_WALL_BANDS = { rail: 3, hedge: 2, seat: 1, timber: 0 };
export function createAldrichWallAtlasTexture({ aniso = 1, seed = 313 } = {}) {
  const rng = makeRng(seed);
  const w = 512, h = 512, bh = 128;
  const c = canvas(w, h), g = c.getContext('2d');
  const band = (b, fn) => { const y = (3 - b) * bh; g.save(); g.beginPath(); g.rect(0, y, w, bh); g.clip(); fn(y); g.restore(); };
  // heavy white "ocean-liner" railing on a sand concrete upstand (the podium edges, the bridge)
  band(ALDRICH_WALL_BANDS.rail, (y) => {
    g.fillStyle = '#d9cfbd'; g.fillRect(0, y, w, bh);
    g.fillStyle = '#b8ad99'; g.fillRect(0, y + bh * 0.5, w, bh * 0.5);
    for (let x = 0; x < w; x += 64) { g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(x, y + bh * 0.5, 2, bh * 0.5); }
    g.fillStyle = '#fbfbf6'; g.fillRect(0, y, w, 20);
    g.fillStyle = '#dcdcd4'; g.fillRect(0, y + 16, w, 5);
    g.fillStyle = '#f4f4ee';
    for (let x = 0; x < w; x += 24) g.fillRect(x + 8, y + 20, 8, bh * 0.5 - 20);
    g.fillStyle = '#efefe8'; g.fillRect(0, y + bh * 0.28, w, 6);
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(0, y + bh - 10, w, 10);
  });
  // clipped hedge (privet / pittosporum)
  band(ALDRICH_WALL_BANDS.hedge, (y) => {
    g.fillStyle = '#356f30'; g.fillRect(0, y, w, bh);
    for (let k = 0; k < 1300; k++) {
      const x = rng() * w, yy = y + rng() * bh, r = 2 + rng() * 5;
      g.fillStyle = rng() < 0.55 ? `rgba(96,166,72,${0.35 + rng() * 0.4})` : `rgba(24,66,28,${0.3 + rng() * 0.4})`;
      for (const xx of [x, x - w, x + w]) { g.beginPath(); g.arc(xx, yy, r, 0, Math.PI * 2); g.fill(); }
    }
    g.fillStyle = 'rgba(210,255,170,0.18)'; g.fillRect(0, y, w, 10);
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(0, y + bh - 16, w, 16);
  });
  // seat wall: board-formed sand concrete with a terracotta tile cap
  band(ALDRICH_WALL_BANDS.seat, (y) => {
    g.fillStyle = '#d3c6ac'; g.fillRect(0, y, w, bh);
    for (let k = 0; k < 8; k++) { g.fillStyle = k % 2 ? 'rgba(255,250,236,0.08)' : 'rgba(80,70,56,0.08)'; g.fillRect(0, y + 22 + k * 13, w, 13); }
    for (let x = 0; x < w; x += 128) { g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x, y + 20, 2, bh - 20); }
    g.fillStyle = '#c9bea8'; g.fillRect(0, y, w, 20);                                         // precast cap
    for (let x = 0; x < w; x += 64) { g.fillStyle = `rgba(${226 + rng() * 14 | 0},${218 + rng() * 12 | 0},${200 + rng() * 10 | 0},1)`; g.fillRect(x + 1, y + 2, 62, 14); }
    g.fillStyle = '#a65a3a'; g.fillRect(0, y + 18, w, 5);                                       // thin tile line
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(0, y + bh - 10, w, 10);
  });
  // timber post-and-rail in front of shrubs (the park interior)
  band(ALDRICH_WALL_BANDS.timber, (y) => {
    g.fillStyle = '#5b7f45'; g.fillRect(0, y, w, bh);
    for (let k = 0; k < 500; k++) { g.fillStyle = `rgba(${40 + rng() * 60 | 0},${90 + rng() * 70 | 0},${30 + rng() * 40 | 0},0.5)`; g.beginPath(); g.arc(rng() * w, y + rng() * bh, 2 + rng() * 5, 0, 6.3); g.fill(); }
    for (const [y0, hh] of [[0, 18], [bh * 0.44, 14]]) {
      g.fillStyle = '#9c6c40'; g.fillRect(0, y + y0, w, hh);
      g.fillStyle = 'rgba(255,230,190,0.25)'; g.fillRect(0, y + y0, w, 3);
      g.fillStyle = 'rgba(40,20,5,0.35)'; g.fillRect(0, y + y0 + hh - 3, w, 3);
    }
    for (let x = 0; x < w; x += 128) { g.fillStyle = '#7b502e'; g.fillRect(x + 54, y, 18, bh); g.fillStyle = 'rgba(255,230,190,0.2)'; g.fillRect(x + 54, y, 4, bh); }
  });
  return finish(c, { aniso });
}

// ------------------------------------------------------------------ facades

/**
 * Facade atlas: three styles side by side (u thirds), each tile = one window
 * bay × one storey (v repeats per storey; world-aldrich.js maps every bay to
 * its third). Greyscale-ish, tinted per building by vertex colour.
 *   FACADE_STYLES.hood   — the 1960s campus: board-formed precast with deep
 *                          window hoods over recessed dark glass, concrete fins;
 *   FACADE_STYLES.modern — the 1990s+ infill: smooth render, punched windows,
 *                          a coloured spandrel band and a slim sun shelf;
 *   FACADE_STYLES.glass  — library / study hall: storey-high glazing between fins.
 */
export const FACADE_STYLES = { hood: 0, modern: 1, glass: 2 };
export function createFacadeAtlasTexture({ size = 256, aniso = 1, seed = 321 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size * 3, size), g = c.getContext('2d');
  const n = tileFbm(size, 4, 4, rng, 0.55);
  const img = g.createImageData(size * 3, size), d = img.data;
  for (let st = 0; st < 3; st++) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x, o = (y * size * 3 + st * size + x) * 4;
      const board = st === 0 ? (Math.floor(y / 14) % 2) * 6 : 0;
      const v = 228 + (n[i] - 0.5) * 20 + (rng() - 0.5) * 8 - board;
      d[o] = clamp(v, 0, 255); d[o + 1] = clamp(v - 2, 0, 255); d[o + 2] = clamp(v - 7, 0, 255); d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const glass = (x0, y0, x1, y1) => {
    const gl = g.createLinearGradient(0, y0, 0, y1);
    gl.addColorStop(0, '#1f2b38'); gl.addColorStop(0.55, '#3a556c'); gl.addColorStop(1, '#6a8aa2');
    g.fillStyle = gl; g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.beginPath(); g.moveTo(x0 + (x1 - x0) * 0.15, y1); g.lineTo(x0 + (x1 - x0) * 0.45, y0); g.lineTo(x0 + (x1 - x0) * 0.6, y0); g.lineTo(x0 + (x1 - x0) * 0.3, y1); g.closePath(); g.fill();
  };
  // hood: the 1960s precast — heavy vertical fins, a deep hood over each window, a spandrel band
  {
    const X = 0, sz = size;
    const fin = Math.round(sz * 0.12);
    g.fillStyle = 'rgba(255,252,244,0.55)'; g.fillRect(X, 0, fin, sz);                       // fin, lit face
    g.fillStyle = 'rgba(70,62,52,0.35)'; g.fillRect(X + fin, 0, Math.round(sz * 0.04), sz);   // fin shadow
    g.fillStyle = 'rgba(244,240,230,0.9)'; g.fillRect(X, sz * 0.8, sz, sz * 0.2);            // spandrel band
    g.fillStyle = 'rgba(80,70,58,0.3)'; g.fillRect(X, sz * 0.8, sz, 3); g.fillRect(X, sz * 0.9, sz, 2);
    const x0 = X + fin + sz * 0.06, x1 = X + sz * 0.95, y0 = sz * 0.1, y1 = sz * 0.78;
    glass(x0, y0 + sz * 0.13, x1, y1);
    const hood = g.createLinearGradient(0, y0, 0, y0 + sz * 0.16);
    hood.addColorStop(0, 'rgba(40,34,28,0.85)'); hood.addColorStop(1, 'rgba(40,34,28,0.25)');
    g.fillStyle = hood; g.fillRect(x0, y0, x1 - x0, sz * 0.16);                                // the hood's deep shadow
    g.fillStyle = '#f6f2ea'; g.fillRect(x0 - 6, y0 - 8, x1 - x0 + 12, 10);                    // hood lip
    g.fillStyle = '#e2ddd2'; g.fillRect((x0 + x1) / 2 - 3, y0 + sz * 0.13, 6, y1 - y0 - sz * 0.13);
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(x0, y1, x1 - x0, 5);                          // sill shadow
  }
  // modern
  {
    const X = size, x0 = X + size * 0.22, x1 = X + size * 0.78, y0 = size * 0.2, y1 = size * 0.72;
    g.fillStyle = 'rgba(160,70,50,0.55)'; g.fillRect(X, size * 0.78, size, size * 0.14);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x0 - 4, y0 - 4, x1 - x0 + 8, y1 - y0 + 8);
    glass(x0, y0, x1, y1);
    g.fillStyle = '#ece9e2'; g.fillRect(x0, (y0 + y1) / 2 - 2, x1 - x0, 4);
    g.fillStyle = '#f7f5f0'; g.fillRect(x0 - 10, y0 - 10, x1 - x0 + 20, 7);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x0 - 10, y0 - 3, x1 - x0 + 20, 4);
  }
  // glass
  {
    const X = size * 2;
    glass(X + size * 0.08, size * 0.06, X + size * 0.92, size * 0.9);
    g.fillStyle = '#ecebe6'; g.fillRect(X, 0, size * 0.08, size); g.fillRect(X + size * 0.92, 0, size * 0.08, size);
    g.fillStyle = '#d8d6cf'; g.fillRect(X, size * 0.9, size, size * 0.1);
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(X + size * 0.08, size * 0.5, size * 0.84, 3);
  }
  g.fillStyle = 'rgba(0,0,0,0.1)'; g.fillRect(0, size - 5, size * 3, 5);
  const t = finish(c, { aniso });
  t.wrapS = THREE.ClampToEdgeWrapping;     // u is mapped per bay inside a third; v repeats per storey
  return t;
}

// ------------------------------------------------------------------ small textures

/** Rippled pool water (the fountain basin): blue with caustic lines (animated by UV offset). */
export function createPoolTexture({ size = 256, aniso = 1, seed = 331 } = {}) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  const n = tileFbm(size, 6, 4, rng, 0.6);
  pixels(g, size, size, (x, y, i) => { const k = n[i]; const caus = Math.max(0, 1 - Math.abs(Math.sin((k * 9 + x * 0.02) * 3.1)) * 6); return [70 + caus * 120, 170 + caus * 70, 214 + caus * 40]; });
  return finish(c, { aniso });
}

/** A US flag and a simplified state flag (white field, red star, red base stripe) side by side (u 0..0.5 / 0.5..1). */
export function createFlagsTexture({ aniso = 1 } = {}) {
  const w = 512, h = 160;
  const c = canvas(w, h), g = c.getContext('2d');
  // US
  for (let k = 0; k < 13; k++) { g.fillStyle = k % 2 ? '#f6f6f2' : '#c4202e'; g.fillRect(0, (k * h) / 13, w / 2, h / 13 + 1); }
  g.fillStyle = '#23356e'; g.fillRect(0, 0, w * 0.2, h * 7 / 13);
  g.fillStyle = '#f6f6f2';
  for (let r = 0; r < 5; r++) for (let q = 0; q < 6; q++) { g.beginPath(); g.arc(8 + q * 16 + (r % 2) * 8, 8 + r * 16, 2.4, 0, 6.3); g.fill(); }
  // state flag (simplified, no emblem)
  g.fillStyle = '#f7f6f0'; g.fillRect(w / 2, 0, w / 2, h);
  g.fillStyle = '#b8282a'; g.fillRect(w / 2, h * 0.84, w / 2, h * 0.16);
  const star = (cx, cy, r) => { g.beginPath(); for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 5, rr = k % 2 ? r * 0.42 : r; g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } g.closePath(); g.fill(); };
  star(w / 2 + 34, 30, 16);
  return finish(c, { aniso, repeat: false });
}
