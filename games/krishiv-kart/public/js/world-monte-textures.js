// Monte Mozzarella canvas textures (browser only; SPEC §16.1 "richer
// per-track materials"). Same conventions as textures.js: every creator draws
// a fresh <canvas>, wraps it in a THREE.CanvasTexture (sRGB) and returns it;
// the caller owns and disposes it (world-monte.js registers them with
// ctx.tex). Randomness is seeded, so the look is identical on every load.
//
//   createFanSettTexture   "coda di pavone" fan-pattern setts (piazzas, Piazza Alta) — road decal
//   createSlabTexture      big limestone slabs with worn edge lines (aqueduct deck) — road decal
//   createHerringboneTexture  herringbone brick (the Espresso Works floor) — road decal
//   createLaneTexture      Via Vespa scooter-lane dashes + darkened wheel tracks (RGBA, transparent decal)
//   createTownAtlasTexture terracotta roof tiles / stucco / painted window, door and shop cells
//                          (the house material atlas; TOWN_ATLAS gives the layout)
//   createRindTexture      cheese-wheel rind speckle (multiplied by vertex colour)
//   createGrateTexture     bronze fountain grate with a rim (RGBA disc, the jets' vents)
//
// UVs (road decals, world.js roadDecal): u across the decal (0..1 over
// `uSpan` metres), v along (one tile = `tile` metres; canvas top = forward).

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

// Add tileable fbm tone + fine grain to the whole canvas (k = strength).
function grain(g, size, rng, { k = 22, fine = 9, cells = 8, warm = 1 } = {}) {
  const img = g.getImageData(0, 0, size, size), d = img.data;
  const n = tileFbm(size, cells, 4, rng, 0.55);
  for (let i = 0; i < size * size; i++) {
    const v = (n[i] - 0.5) * k + (rng() - 0.5) * fine;
    d[i * 4] = clamp(d[i * 4] + v * warm, 0, 255);
    d[i * 4 + 1] = clamp(d[i * 4 + 1] + v, 0, 255);
    d[i * 4 + 2] = clamp(d[i * 4 + 2] + v * 0.9, 0, 255);
  }
  g.putImageData(img, 0, 0);
}

// Draw fn(dx, dy) at every wrap offset whose shifted copy can touch the tile.
function wrap9(size, x, y, r, fn) {
  for (const ox of [-size, 0, size]) {
    if (x + ox + r < 0 || x + ox - r > size) continue;
    for (const oy of [-size, 0, size]) {
      if (y + oy + r < 0 || y + oy - r > size) continue;
      fn(ox, oy);
    }
  }
}

// ------------------------------------------------------------------ road decals

// Fan-pattern setts ("coda di pavone"): overlapping fish-scale fans of small
// grey-brown stones laid in arcs, darker joints, sun-bleached tops. Tileable;
// two fans across one tile (the caller maps one tile to ~4 m).
export function createFanSettTexture({ size = 1024, aniso = 1, seed = 301 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  g.fillStyle = '#5d5850'; g.fillRect(0, 0, size, size);
  const W = size / 2, H = W / 2, R = W * 0.62;
  const sett = Math.max(10, size / 36);                          // ~11 cm at 4 m per tile
  const rows = Math.round(size / H);
  // painter's order: lower rows first, every later scale covers the ones under it
  for (let r = rows; r >= -1; r--) {
    for (let i = -1; i <= 2; i++) {
      const cx = (i + (r & 1 ? 0.5 : 0)) * W, cy = r * H;     // fan centre (arc opens toward -y = canvas top)
      const tone = (rng() - 0.5) * 16;
      wrap9(size, cx, cy - R / 2, R, (ox, oy) => {
        const x0 = cx + ox, y0 = cy + oy;
        // the fan's joint background
        g.fillStyle = '#5a554d';
        g.beginPath(); g.moveTo(x0 - R, y0); g.arc(x0, y0, R, Math.PI, 2 * Math.PI); g.closePath(); g.fill();
        for (let rr = R - sett * 0.55; rr > sett * 0.6; rr -= sett * 1.02) {
          const n = Math.max(2, Math.round((Math.PI * rr) / sett));
          for (let k = 0; k < n; k++) {
            const a = Math.PI + ((k + 0.5) / n) * Math.PI;
            const px = x0 + Math.cos(a) * rr, py = y0 + Math.sin(a) * rr;
            const v = 128 + tone + (rng() - 0.5) * 26 + (rr / R) * 8;
            const warm = rng() < 0.2 ? 12 : 0;
            g.fillStyle = `rgb(${clamp(v + 10 + warm, 0, 255) | 0},${clamp(v + 4 + warm * 0.5, 0, 255) | 0},${clamp(v - 6, 0, 255) | 0})`;
            g.save(); g.translate(px, py); g.rotate(a + Math.PI / 2);
            const w = (Math.PI * rr / n) - 2.2, h = sett - 2.4;
            g.beginPath();
            g.moveTo(-w / 2 + 2.5, -h / 2); g.lineTo(w / 2 - 2.5, -h / 2); g.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + 2.5);
            g.lineTo(w / 2, h / 2 - 2.5); g.quadraticCurveTo(w / 2, h / 2, w / 2 - 2.5, h / 2); g.lineTo(-w / 2 + 2.5, h / 2);
            g.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - 2.5); g.lineTo(-w / 2, -h / 2 + 2.5); g.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + 2.5, -h / 2);
            g.fill();
            g.fillStyle = 'rgba(255,250,236,0.12)'; g.fillRect(-w / 2 + 2, -h / 2 + 1.5, w - 4, 2.2);
            g.restore();
          }
        }
        // a lighter stone line along the fan's rim (the arc that reads from afar)
        g.strokeStyle = 'rgba(232,222,198,0.55)'; g.lineWidth = sett * 0.55;
        g.beginPath(); g.arc(x0, y0, R - sett * 0.3, Math.PI, 2 * Math.PI); g.stroke();
      });
    }
  }
  grain(g, size, rng, { k: 20, fine: 8 });
  return finish(c, { aniso });
}

// Big limestone slabs in running bond (~1.3 x 0.8 m at 4 m per tile) with
// chamfered, darker joints, worn white edge lines at u 0.02 / 0.98 when
// `lines` (the decal spans the whole road there) and a pale centre seam.
export function createSlabTexture({ size = 1024, aniso = 1, seed = 303, lines = false } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  g.fillStyle = '#6f6556'; g.fillRect(0, 0, size, size);
  const rows = 5, rh = size / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh;
    let x = (r & 1) * rh * 0.8 - rh;
    while (x < size) {
      const w = rh * (1.25 + rng() * 0.9);
      const v = 184 + (rng() - 0.5) * 30;
      const draw = (xx) => {
        g.fillStyle = `rgb(${v | 0},${(v - 10) | 0},${(v - 30) | 0})`;
        g.fillRect(xx + 5, y + 5, w - 10, rh - 10);
        g.fillStyle = 'rgba(255,255,255,0.14)'; g.fillRect(xx + 3, y + 3, w - 6, 4);
        g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(xx + 3, y + rh - 8, w - 6, 5);
        // a crack or two
        if (rng() < 0.3) {
          g.strokeStyle = 'rgba(60,50,40,0.35)'; g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(xx + rng() * w, y + 4); g.lineTo(xx + rng() * w, y + rh * (0.4 + rng() * 0.5)); g.stroke();
        }
      };
      draw(x); if (x + w > size) draw(x - size); if (x < 0) draw(x + size);
      x += w;
    }
  }
  grain(g, size, rng, { k: 24, fine: 10 });
  if (lines) {
    const ew = Math.round(size * 0.012);
    g.fillStyle = 'rgba(248,244,232,0.85)';
    g.fillRect(Math.round(size * 0.016), 0, ew, size);
    g.fillRect(size - Math.round(size * 0.016) - ew, 0, ew, size);
  }
  return finish(c, { aniso });
}

// Herringbone brick: warm reds in the classic 2:1 staircase (H brick at
// a·(1,1) + b·(4,0), its V brick one unit below; period 4 bricks-widths both
// ways, so 16 units tile the canvas), with two soot-dark wheel tracks.
export function createHerringboneTexture({ size = 1024, aniso = 1, seed = 305 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  g.fillStyle = '#76624e'; g.fillRect(0, 0, size, size);
  const u = size / 16;
  const draw = (x, y, horiz) => {
    const v = 150 + (rng() - 0.5) * 40;
    const col = `rgb(${clamp(v + 34, 0, 255) | 0},${clamp(v - 18, 0, 255) | 0},${clamp(v - 56, 0, 255) | 0})`;
    const w = horiz ? 2 * u : u, h = horiz ? u : 2 * u;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      const X = x * u + ox, Y = y * u + oy;
      if (X > size || Y > size || X + w < 0 || Y + h < 0) continue;
      g.fillStyle = col; g.fillRect(X + 1.5, Y + 1.5, w - 3, h - 3);
      g.fillStyle = 'rgba(255,220,200,0.12)'; g.fillRect(X + 2, Y + 2, w - 4, 2);
    }
  };
  for (let a = 0; a < 16; a++) {
    for (let b = -4; b < 4; b++) {
      const x = ((a + 4 * b) % 16 + 16) % 16, y = a;
      draw(x, y, true);
      draw(x, (y + 1) % 16, false);
    }
  }
  grain(g, size, rng, { k: 26, fine: 10, warm: 1.1 });
  for (const cx of [0.27, 0.73]) {
    const grd = g.createLinearGradient((cx - 0.08) * size, 0, (cx + 0.08) * size, 0);
    grd.addColorStop(0, 'rgba(30,20,15,0)'); grd.addColorStop(0.5, 'rgba(30,20,15,0.22)'); grd.addColorStop(1, 'rgba(30,20,15,0)');
    g.fillStyle = grd; g.fillRect((cx - 0.08) * size, 0, 0.16 * size, size);
  }
  return finish(c, { aniso });
}

// Via Vespa lane marks (RGBA, drawn as a transparent road decal over the
// cobbles): two dashed yellow scooter-lane lines at u 0.3 / 0.7 with small
// scooter pictograms (a generic two-wheeler silhouette, no text) and
// darkened, oil-stained wheel tracks in each lane. One tile = 12 m along.
export function createLaneTexture({ size = 512, aniso = 1, seed = 307 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  // wheel tracks: soft dark bands in the middle of each scooter lane
  for (const cx of [0.115, 0.885]) {
    const grd = g.createLinearGradient((cx - 0.06) * size, 0, (cx + 0.06) * size, 0);
    grd.addColorStop(0, 'rgba(40,34,28,0)'); grd.addColorStop(0.5, 'rgba(40,34,28,0.28)'); grd.addColorStop(1, 'rgba(40,34,28,0)');
    g.fillStyle = grd; g.fillRect((cx - 0.06) * size, 0, 0.12 * size, size);
    for (let k = 0; k < 7; k++) {                        // oil drips
      g.fillStyle = `rgba(30,26,24,${0.12 + rng() * 0.14})`;
      g.beginPath(); g.ellipse((cx + (rng() - 0.5) * 0.06) * size, rng() * size, 4 + rng() * 9, 6 + rng() * 14, 0, 0, Math.PI * 2); g.fill();
    }
  }
  // dashed lane lines (a dash 3 m, a gap 3 m: two dashes per tile)
  const lw = Math.round(size * 0.012);
  for (const cx of [0.3, 0.7]) {
    for (let k = 0; k < 2; k++) {
      const y0 = Math.round(size * (k * 0.5 + 0.05)), len = Math.round(size * 0.25);
      g.fillStyle = 'rgba(255,206,64,0.92)'; g.fillRect(Math.round(cx * size - lw / 2), y0, lw, len);
    }
  }
  // scooter pictograms in each lane, pointing forward (canvas top)
  const icon = (cx, cy, s) => {
    g.save(); g.translate(cx, cy); g.scale(s, s);
    g.fillStyle = 'rgba(255,248,232,0.9)';
    g.beginPath(); g.arc(0, -16, 5, 0, Math.PI * 2); g.fill();              // front wheel
    g.beginPath(); g.arc(0, 16, 5, 0, Math.PI * 2); g.fill();               // back wheel
    g.fillRect(-3, -14, 6, 30);                                             // body
    g.fillRect(-9, -11, 18, 3);                                             // bars
    g.beginPath(); g.ellipse(0, 6, 6, 10, 0, 0, Math.PI * 2); g.fill();     // seat / rider blob
    g.restore();
  };
  icon(0.115 * size, size * 0.78, size / 300);
  icon(0.885 * size, size * 0.28, size / 300);
  return finish(c, { aniso });
}

// ------------------------------------------------------------------ props

/**
 * Town atlas layout (uv.y ranges; u tiles across the whole width in the roof
 * and stucco strips): roof tiles (eave → ridge), stucco, and 2 x 8 cells of
 * painted windows / doors (cell(i, kind) → [u0, v0, u1, v1] of its picture):
 *   0-4 open shutters (SHUTTERS[i]), 8-12 closed shutters, 5 / 13 / 14 doors,
 *   6 / 7 shop windows, 15 plain white (everything without a picture).
 */
export const TOWN_ATLAS = {
  roof: [0.52, 0.99], stucco: [0.285, 0.505], cells: [0.0, 0.25],
  OPEN: 0, CLOSED: 8, DOORS: [5, 13, 14], SHOP: [6, 7], WHITE: 15,
  cell(i, kind = 'win') {
    const S = 1024, cw = 128, col = i % 8, row = Math.floor(i / 8);
    const x = col * cw, y = S - (row + 1) * cw;                  // canvas px of the cell's top-left (row 0 at the bottom)
    const r = kind === 'door' ? [35, 8, 93, 120] : kind === 'shop' ? [6, 10, 122, 118] : kind === 'white' ? [40, 40, 88, 88] : [4, 16, 124, 111];
    return [(x + r[0]) / S, 1 - (y + r[3]) / S, (x + r[2]) / S, 1 - (y + r[1]) / S];
  },
};
export const SHUTTERS = ['#3d7b4f', '#2f6aa0', '#6e8f3a', '#8a5634', '#4a8f8a'];

// House material atlas (1024², multiplied by the vertex colours — the
// window / door cells are painted in full colour and drawn with white
// vertex colour; alphaTest cuts their transparent margins): rows of
// terracotta "coppi" roof tiles (u tileable), weathered stucco with a dirty
// plinth band, and the window / door / shop-front cells.
export function createTownAtlasTexture({ aniso = 1, seed = 309 } = {}) {
  const size = 1024;
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  const yOf = (v) => (1 - v) * size;                         // canvas y of a uv.y (flipY)
  // roof tiles
  {
    const y0 = yOf(TOWN_ATLAS.roof[1]) - 6, y1 = yOf(TOWN_ATLAS.roof[0]) + 6;
    const courses = 12, ch = (y1 - y0) / courses, tw = size / 24;
    g.fillStyle = '#7a7470'; g.fillRect(0, y0, size, y1 - y0);
    for (let r = 0; r < courses; r++) {
      const y = y0 + r * ch;
      for (let k = -1; k < 25; k++) {
        const x = k * tw + (r & 1) * tw * 0.5;
        const v = 236 + (rng() - 0.5) * 34;
        const grd = g.createLinearGradient(x, 0, x + tw, 0);
        grd.addColorStop(0, `rgb(${(v * 0.6) | 0},${(v * 0.58) | 0},${(v * 0.56) | 0})`);
        grd.addColorStop(0.45, `rgb(${v | 0},${(v * 0.98) | 0},${(v * 0.95) | 0})`);
        grd.addColorStop(1, `rgb(${(v * 0.55) | 0},${(v * 0.53) | 0},${(v * 0.52) | 0})`);
        g.fillStyle = grd; g.fillRect(x, y, tw, ch);
        g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x, y + ch - 4, tw, 4);
        if (rng() < 0.06) { g.fillStyle = 'rgba(80,100,50,0.35)'; g.fillRect(x + 3, y + ch * 0.45, tw - 6, ch * 0.45); }
      }
    }
  }
  // stucco
  {
    const y0 = Math.floor(yOf(TOWN_ATLAS.stucco[1])) - 4, y1 = Math.ceil(yOf(TOWN_ATLAS.stucco[0])) + 4;
    const hh = y1 - y0;
    const n = tileFbm(256, 6, 4, rng, 0.6);
    const img = g.createImageData(size, hh), d = img.data;
    for (let y = 0; y < hh; y++) {
      const plinth = y > hh * 0.88 ? 0.8 : 1;
      const streak = 1 - 0.05 * smoothDown(y / hh);
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const v = (246 + (n[((y * 2) % 256) * 256 + ((x >> 2) % 256)] - 0.5) * 30 + (rng() - 0.5) * 6) * plinth * streak;
        d[i] = clamp(v, 0, 255); d[i + 1] = clamp(v - 2, 0, 255); d[i + 2] = clamp(v - 7, 0, 255); d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, y0);
  }
  // window / door cells
  const cell = (i) => ({ x: (i % 8) * 128, y: size - (Math.floor(i / 8) + 1) * 128 });
  const slats = (x, y, w, h, col) => {
    g.fillStyle = col; g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(0,0,0,0.22)';
    for (let yy = y + 5; yy < y + h - 3; yy += 6) g.fillRect(x + 3, yy, w - 6, 2);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x + 2, y + 2, w - 4, 3);
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, w - 2, h - 2);
  };
  const glass = (x, y, w, h) => {
    g.fillStyle = '#f2ece0'; g.fillRect(x - 4, y - 4, w + 8, h + 8);                   // stone frame
    const grd = g.createLinearGradient(x, y, x + w, y + h);
    grd.addColorStop(0, '#2c3a4c'); grd.addColorStop(0.55, '#1f2a36'); grd.addColorStop(1, '#3c5068');
    g.fillStyle = grd; g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(190,220,240,0.22)'; g.beginPath(); g.moveTo(x + 4, y + h * 0.7); g.lineTo(x + w * 0.55, y + 3); g.lineTo(x + w * 0.75, y + 3); g.lineTo(x + 4, y + h * 0.95); g.fill();
    g.fillStyle = '#e9e4da'; g.fillRect(x + w / 2 - 2, y, 4, h); g.fillRect(x, y + h * 0.42, w, 4);    // panes
    g.fillStyle = 'rgba(255,240,200,0.10)'; g.fillRect(x, y, w, h);
  };
  for (let k = 0; k < 5; k++) {
    // open: glass + both shutters folded back + sill
    {
      const { x, y } = cell(TOWN_ATLAS.OPEN + k);
      g.clearRect(x, y, 128, 128);
      glass(x + 37, y + 22, 54, 82);
      slats(x + 6, y + 18, 27, 88, SHUTTERS[k]);
      slats(x + 95, y + 18, 27, 88, SHUTTERS[k]);
      g.fillStyle = '#e8e0cc'; g.fillRect(x + 30, y + 103, 68, 7);
    }
    // closed: two leaves across the opening + sill
    {
      const { x, y } = cell(TOWN_ATLAS.CLOSED + k);
      g.clearRect(x, y, 128, 128);
      slats(x + 31, y + 18, 33, 86, SHUTTERS[k]);
      slats(x + 64, y + 18, 33, 86, SHUTTERS[k]);
      g.fillStyle = '#e8e0cc'; g.fillRect(x + 28, y + 103, 72, 7);
    }
  }
  // doors: panelled wood under a stone lintel
  [[5, '#6b4428'], [13, '#2f5a3e'], [14, '#7a2e22']].forEach(([i, col]) => {
    const { x, y } = cell(i);
    g.clearRect(x, y, 128, 128);
    g.fillStyle = '#efe7d6'; g.fillRect(x + 35, y + 8, 58, 112);
    g.fillStyle = col; g.fillRect(x + 41, y + 18, 46, 102);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    for (const [px, py] of [[45, 24], [66, 24], [45, 64], [66, 64]]) g.fillRect(x + px, y + py, 17, 32);
    g.fillStyle = 'rgba(255,255,255,0.15)';
    for (const [px, py] of [[45, 24], [66, 24], [45, 64], [66, 64]]) g.fillRect(x + px, y + py, 17, 3);
    g.fillStyle = '#d8b04a'; g.beginPath(); g.arc(x + 80, y + 76, 3, 0, Math.PI * 2); g.fill();
  });
  // shop windows: big glass with goods on shelves
  [[6, '#2f3a44'], [7, '#3a2f2a']].forEach(([i, col]) => {
    const { x, y } = cell(i);
    g.clearRect(x, y, 128, 128);
    g.fillStyle = '#e9e1cf'; g.fillRect(x + 6, y + 10, 116, 108);
    g.fillStyle = col; g.fillRect(x + 12, y + 16, 104, 96);
    for (let r = 0; r < 3; r++) {
      g.fillStyle = 'rgba(230,220,200,0.6)'; g.fillRect(x + 14, y + 44 + r * 28, 100, 3);
      for (let k = 0; k < 7; k++) {
        g.fillStyle = ['#e8475f', '#f2c230', '#5aa7e0', '#8fd3bd', '#f08a3c', '#f3e1b0'][(k + r * 2 + i) % 6];
        g.fillRect(x + 17 + k * 14, y + 30 + r * 28, 9, 14);
      }
    }
    g.fillStyle = 'rgba(200,230,250,0.16)'; g.fillRect(x + 12, y + 16, 50, 96);
  });
  // plain white
  { const { x, y } = cell(TOWN_ATLAS.WHITE); g.fillStyle = '#ffffff'; g.fillRect(x, y, 128, 128); }
  const tex = finish(c, { aniso });
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
const smoothDown = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// Town-atlas UVs (world-monte-textures.js): a picture cell on a quad, the
// plain white cell, stucco box-mapping (metres / 4 along, wall height →
// the stucco strip), roof tiles (along the ridge / 6 m, eave → ridge).
// Geometries that already carry town-atlas UVs (a WeakSet, not userData:
// BufferGeometry.clone() shares userData between the clones).
const ATLAS_DONE = new WeakSet();
export const markAtlas = (g) => { ATLAS_DONE.add(g); return g; };
export const hasAtlas = (g) => ATLAS_DONE.has(g);

export function uvRect(g, [u0, v0, u1, v1]) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, lerp(u0, u1, uv.getX(i)), lerp(v0, v1, uv.getY(i)));
  ATLAS_DONE.add(g);
  return g;
}
const WHITE_UV = (() => { const [u0, v0, u1, v1] = TOWN_ATLAS.cell(TOWN_ATLAS.WHITE, 'white'); return [(u0 + u1) / 2, (v0 + v1) / 2]; })();
export function uvWhite(g) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, WHITE_UV[0], WHITE_UV[1]);
  ATLAS_DONE.add(g);
  return g;
}
export function uvStucco(g, y0, y1) {
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const h = Math.abs(n.getX(i)) > Math.abs(n.getZ(i)) ? p.getZ(i) : p.getX(i);
    const k = clamp((p.getY(i) - y0) / Math.max(0.1, y1 - y0), 0, 1);
    uv.setXY(i, h / 4, lerp(TOWN_ATLAS.stucco[0] + 0.01, TOWN_ATLAS.stucco[1] - 0.01, k));
  }
  ATLAS_DONE.add(g);
  return g;
}
export function uvRoof(g, rh) {
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + p.getZ(i) * 0.37) / 6, lerp(TOWN_ATLAS.roof[0] + 0.01, TOWN_ATLAS.roof[1] - 0.01, clamp(p.getY(i) / rh, 0, 1)));
  ATLAS_DONE.add(g);
  return g;
}


// Cheese rind: warm speckle and pores (multiplied by the wheel's vertex colours).
export function createRindTexture({ size = 256, aniso = 1, seed = 311 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  g.fillStyle = '#f4efe2'; g.fillRect(0, 0, size, size);
  grain(g, size, rng, { k: 30, fine: 14, cells: 6 });
  for (let k = 0; k < 220; k++) {
    const x = rng() * size, y = rng() * size, r = 0.8 + rng() * 2.4;
    wrap9(size, x, y, r, (ox, oy) => { g.fillStyle = `rgba(120,90,40,${0.15 + rng() * 0.25})`; g.beginPath(); g.arc(x + ox, y + oy, r, 0, Math.PI * 2); g.fill(); });
  }
  return finish(c, { aniso });
}

// Fountain vent: a bronze ring grate with radial bars on a transparent
// background (one disc per texture, clamp-to-edge).
export function createGrateTexture({ size = 256 } = {}) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const m = size / 2;
  g.clearRect(0, 0, size, size);
  // mosaic rim (blue / white tesserae)
  for (let k = 0; k < 48; k++) {
    const a0 = (k / 48) * Math.PI * 2, a1 = ((k + 0.86) / 48) * Math.PI * 2;
    g.fillStyle = k % 2 ? '#2f6fb8' : '#f2efe6';
    g.beginPath(); g.arc(m, m, m * 0.98, a0, a1); g.arc(m, m, m * 0.82, a1, a0, true); g.closePath(); g.fill();
  }
  g.fillStyle = '#9a7434'; g.beginPath(); g.arc(m, m, m * 0.8, 0, Math.PI * 2); g.fill();      // bronze ring
  g.fillStyle = '#1d2a33'; g.beginPath(); g.arc(m, m, m * 0.66, 0, Math.PI * 2); g.fill();    // dark well
  g.strokeStyle = '#b48a44'; g.lineWidth = size * 0.035;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI;
    g.beginPath(); g.moveTo(m + Math.cos(a) * m * 0.66, m + Math.sin(a) * m * 0.66); g.lineTo(m - Math.cos(a) * m * 0.66, m - Math.sin(a) * m * 0.66); g.stroke();
  }
  g.beginPath(); g.arc(m, m, m * 0.33, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#c99a4c'; g.beginPath(); g.arc(m, m, m * 0.12, 0, Math.PI * 2); g.fill();
  return finish(c, { repeat: false });
}

