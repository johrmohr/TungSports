// Procedural canvas textures for the world (browser only).
//
// Every creator draws into a fresh <canvas>, wraps it in a THREE.CanvasTexture
// and returns it. Nothing is cached: the caller owns the texture and must
// dispose() it (world.js tracks every texture it creates).
//
// Color textures are tagged SRGBColorSpace; data textures (normal maps) are
// left linear. Randomness is seeded (utils.makeRng) so the look is identical
// on every load.
//
// UV conventions used by world.js:
//   * road / curb / grass strip / boost pads: u = across the strip (0 = left),
//     v = along the driving direction (canvas TOP = +v = "forward" because
//     CanvasTexture.flipY is true).
//   * wall atlas: 4 horizontal bands (see WALL_BANDS), u repeats along the wall.

import * as THREE from 'three';
import { makeRng, clamp, lerp } from './utils.js';

// ------------------------------------------------------------------ helpers

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

// Tileable value noise on a size×size grid. `cells` lattice cells per tile
// (must divide nicely into the size for best results). Returns Float32Array in [0,1].
export function tileNoise(size, cells, rng) {
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells, y0 = Math.floor(fy), ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const ya = y0 % cells, yb = (y0 + 1) % cells;
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells, x0 = Math.floor(fx), tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const xa = x0 % cells, xb = (x0 + 1) % cells;
      const a = lat[ya * cells + xa], b = lat[ya * cells + xb];
      const c = lat[yb * cells + xa], d = lat[yb * cells + xb];
      out[y * size + x] = lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
    }
  }
  return out;
}

// Tileable fractal noise: sum of tileNoise octaves (normalized to [0,1]).
export function tileFbm(size, baseCells, octaves, rng, gain = 0.5) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0, cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    const n = tileNoise(size, cells, rng);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp; amp *= gain; cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// Draw a shape that wraps around the tile edges (for seamless speckles).
function wrapDraw(size, x, y, r, fn) {
  fn(x, y);
  if (x < r) fn(x + size, y); else if (x > size - r) fn(x - size, y);
  if (y < r) fn(x, y + size); else if (y > size - r) fn(x, y - size);
}

// ------------------------------------------------------------------ road

// Asphalt for the full road width: u 0..1 spans edge to edge, v tiles along
// the track (one tile = `tileMeters` meters; the caller sets UVs to match).
// White edge lines + a dashed center line are painted in.
export function createAsphaltTexture({ size = 1024, aniso = 1, seed = 11 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const blot = tileFbm(size, 8, 4, rng, 0.55);
  const base = [86, 90, 100];
  for (let i = 0; i < size * size; i++) {
    const fine = (rng() - 0.5) * 22;
    const b = (blot[i] - 0.5) * 26;
    let v = fine + b;
    if (rng() < 0.012) v += 30 + rng() * 25;        // light aggregate specks
    else if (rng() < 0.01) v -= 22;                 // dark pits
    d[i * 4] = clamp(base[0] + v, 0, 255);
    d[i * 4 + 1] = clamp(base[1] + v, 0, 255);
    d[i * 4 + 2] = clamp(base[2] + v * 1.05, 0, 255);
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);

  // Faint darker tyre-polish band down the middle third.
  const grad = g.createLinearGradient(0, 0, size, 0);
  grad.addColorStop(0.0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.3, 'rgba(20,22,30,0.10)');
  grad.addColorStop(0.5, 'rgba(20,22,30,0.04)');
  grad.addColorStop(0.7, 'rgba(20,22,30,0.10)');
  grad.addColorStop(1.0, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, size, size);

  // Edge lines (slightly worn: alpha noise).
  const line = (x0, w, alpha) => {
    for (let y = 0; y < size; y += 2) {
      g.fillStyle = `rgba(250,250,244,${alpha * (0.82 + rng() * 0.18)})`;
      g.fillRect(x0, y, w, 2);
    }
  };
  const ew = Math.round(size * 0.012);
  line(Math.round(size * 0.016), ew, 0.95);
  line(size - Math.round(size * 0.016) - ew, ew, 0.95);
  // Center dashes: 2 per tile.
  const cw = Math.round(size * 0.008);
  for (let k = 0; k < 2; k++) {
    const y0 = Math.round(size * (k * 0.5 + 0.06)), len = Math.round(size * 0.26);
    for (let y = y0; y < y0 + len; y += 2) {
      g.fillStyle = `rgba(250,248,235,${0.75 * (0.8 + rng() * 0.2)})`;
      g.fillRect(Math.round(size / 2 - cw / 2), y, cw, 2);
    }
  }
  return finish(c, { aniso });
}

// Red / white curb stripes. u across the 1 m curb, v along: one tile = one
// red + one white block.
export function createCurbTexture({ aniso = 1, colors = ['#e8322b', '#f7f5ef'] } = {}) {
  const w = 64, h = 256;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  g.fillStyle = colors[0]; g.fillRect(0, 0, w, h / 2);
  g.fillStyle = colors[1]; g.fillRect(0, h / 2, w, h / 2);
  // soft shading toward the outer edge + a thin dark inner seam
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.22)');
  grad.addColorStop(0.08, 'rgba(0,0,0,0)');
  grad.addColorStop(0.85, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.18)');
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  // block seams
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fillRect(0, 0, w, 2); g.fillRect(0, h / 2 - 1, w, 2);
  return finish(c, { aniso });
}

// Light grayscale detail with grass speckles; multiplied with vertex colors.
// `stripes` adds mowing bands along v (used by the off-road strip).
export function createGrassTexture({ size = 512, aniso = 1, stripes = false, seed = 21 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 4, 5, rng, 0.55);
  for (let y = 0; y < size; y++) {
    // mowing stripes: two bands per tile along v (canvas y)
    const band = stripes ? (y < size / 2 ? 1.0 : 0.9) : 1;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const v = (0.8 + n[i] * 0.22 + (rng() - 0.5) * 0.08) * band;
      d[i * 4] = clamp(v * 236, 0, 255);
      d[i * 4 + 1] = clamp(v * 248, 0, 255);
      d[i * 4 + 2] = clamp(v * 226, 0, 255);
      d[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // blade strokes (dark + light), wrapped so the tile is seamless
  for (let k = 0; k < size * 7; k++) {
    const x = rng() * size, y = rng() * size;
    const len = 2 + rng() * 5, ang = -Math.PI / 2 + (rng() - 0.5) * 0.9;
    const dark = rng() < 0.55;
    g.strokeStyle = dark ? `rgba(30,60,20,${0.10 + rng() * 0.12})` : `rgba(255,255,230,${0.10 + rng() * 0.12})`;
    g.lineWidth = 1;
    wrapDraw(size, x, y, 8, (px, py) => {
      g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len); g.stroke();
    });
  }
  return finish(c, { aniso });
}

// Generic soft grayscale detail noise (terrain). Values ~0.78..1.0.
export function createDetailTexture({ size = 512, aniso = 1, seed = 31 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 4, 6, rng, 0.6);
  for (let i = 0; i < size * size; i++) {
    const v = 0.78 + n[i] * 0.2 + (rng() - 0.5) * 0.06;
    d[i * 4] = clamp(v * 250, 0, 255);
    d[i * 4 + 1] = clamp(v * 252, 0, 255);
    d[i * 4 + 2] = clamp(v * 244, 0, 255);
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(c, { aniso });
}

// Packed dirt (light brown) for paths / pit areas.
export function createDirtTexture({ size = 256, aniso = 1, seed = 41 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 4, 5, rng, 0.55);
  for (let i = 0; i < size * size; i++) {
    const v = 0.75 + n[i] * 0.3 + (rng() - 0.5) * 0.12;
    d[i * 4] = clamp(v * 196, 0, 255);
    d[i * 4 + 1] = clamp(v * 158, 0, 255);
    d[i * 4 + 2] = clamp(v * 112, 0, 255);
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  for (let k = 0; k < 220; k++) {
    const x = rng() * size, y = rng() * size, r = 0.8 + rng() * 2.2;
    g.fillStyle = rng() < 0.5 ? 'rgba(90,64,40,0.35)' : 'rgba(250,230,200,0.35)';
    wrapDraw(size, x, y, 4, (px, py) => { g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill(); });
  }
  return finish(c, { aniso });
}

// Light rock detail (grayscale with cracks); tinted by vertex/instance color.
export function createRockTexture({ size = 256, aniso = 1, seed = 51 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 4, 5, rng, 0.6);
  const m = tileFbm(size, 16, 2, rng, 0.5);
  for (let i = 0; i < size * size; i++) {
    const v = 0.68 + n[i] * 0.3 + (m[i] - 0.5) * 0.12 + (rng() - 0.5) * 0.06;
    d[i * 4] = clamp(v * 240, 0, 255);
    d[i * 4 + 1] = clamp(v * 236, 0, 255);
    d[i * 4 + 2] = clamp(v * 230, 0, 255);
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = 'rgba(40,36,32,0.35)'; g.lineWidth = 1.2;
  for (let k = 0; k < 14; k++) {
    let x = rng() * size, y = rng() * size;
    g.beginPath(); g.moveTo(x, y);
    for (let j = 0; j < 6; j++) { x += (rng() - 0.5) * 30; y += rng() * 18; g.lineTo(x, y); }
    g.stroke();
  }
  return finish(c, { aniso });
}

// Black / white checker, 2×2 squares per tile (start/finish strip).
export function createCheckerTexture({ aniso = 1 } = {}) {
  const s = 128;
  const c = makeCanvas(s, s), g = c.getContext('2d');
  g.fillStyle = '#f6f6f2'; g.fillRect(0, 0, s, s);
  g.fillStyle = '#16161c'; g.fillRect(0, 0, s / 2, s / 2); g.fillRect(s / 2, s / 2, s / 2, s / 2);
  return finish(c, { aniso });
}

// Boost pad: glowing chevrons pointing toward +v, framed by orange rails.
// One tile is square; world.js scrolls texture.offset.y for animation.
export function createChevronTexture({ aniso = 1 } = {}) {
  const w = 256, h = 256;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, w, 0);
  bg.addColorStop(0, '#2a1260'); bg.addColorStop(0.5, '#3c1d8a'); bg.addColorStop(1, '#2a1260');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // two chevrons per tile (pointing up = forward)
  const chev = (yTip, color, glow) => {
    g.save();
    g.shadowColor = glow; g.shadowBlur = 18;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(w * 0.5, yTip);
    g.lineTo(w * 0.86, yTip + h * 0.25);
    g.lineTo(w * 0.86, yTip + h * 0.37);
    g.lineTo(w * 0.5, yTip + h * 0.12);
    g.lineTo(w * 0.14, yTip + h * 0.37);
    g.lineTo(w * 0.14, yTip + h * 0.25);
    g.closePath(); g.fill();
    g.restore();
  };
  for (const off of [-h, 0, h]) {   // draw wrapped copies so the tile is seamless vertically
    chev(off + h * 0.06, '#ffe14a', '#ff9a1a');
    chev(off + h * 0.56, '#ffb627', '#ff6a00');
  }
  // side rails
  g.fillStyle = '#ff7a1a'; g.fillRect(0, 0, w * 0.06, h); g.fillRect(w * 0.94, 0, w * 0.06, h);
  g.fillStyle = '#fff3a0'; g.fillRect(w * 0.06, 0, w * 0.012, h); g.fillRect(w * 0.928, 0, w * 0.012, h);
  return finish(c, { aniso });
}

// Diagonal yellow / black hazard stripes (ramp sides & lip).
export function createHazardTexture({ aniso = 1 } = {}) {
  const s = 128;
  const c = makeCanvas(s, s), g = c.getContext('2d');
  g.fillStyle = '#ffcc1a'; g.fillRect(0, 0, s, s);
  g.fillStyle = '#1b1b22';
  for (let k = -2; k < 3; k++) {
    const x = k * s / 2;
    g.beginPath();
    g.moveTo(x, s); g.lineTo(x + s / 4, s); g.lineTo(x + s / 4 + s, 0); g.lineTo(x + s, 0);
    g.closePath(); g.fill();
  }
  return finish(c, { aniso });
}

// Ramp top: bright blue deck with white grip ridges and a hazard lip at +v.
// v 0 = ramp start (road level), v 1 = lip. u repeats across the road.
export function createRampTopTexture({ aniso = 1 } = {}) {
  const w = 256, h = 512;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const bg = g.createLinearGradient(0, h, 0, 0);
  bg.addColorStop(0, '#1f7fe0'); bg.addColorStop(1, '#3fb4ff');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // grip ridges across
  for (let y = h * 0.12; y < h; y += h / 14) {
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(0, y, w, 6);
    g.fillStyle = 'rgba(0,30,80,0.25)'; g.fillRect(0, y + 6, w, 3);
  }
  // big up-arrow
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.beginPath();
  g.moveTo(w * 0.5, h * 0.18); g.lineTo(w * 0.8, h * 0.42); g.lineTo(w * 0.62, h * 0.42);
  g.lineTo(w * 0.62, h * 0.82); g.lineTo(w * 0.38, h * 0.82); g.lineTo(w * 0.38, h * 0.42); g.lineTo(w * 0.2, h * 0.42);
  g.closePath(); g.fill();
  // hazard lip band at the top (= +v, the drop edge)
  const bandH = h * 0.1;
  g.fillStyle = '#ffcc1a'; g.fillRect(0, 0, w, bandH);
  g.fillStyle = '#1b1b22';
  for (let x = -bandH; x < w + bandH; x += bandH) {
    g.beginPath(); g.moveTo(x, bandH); g.lineTo(x + bandH * 0.5, bandH); g.lineTo(x + bandH, 0); g.lineTo(x + bandH * 0.5, 0); g.closePath(); g.fill();
  }
  return finish(c, { aniso });
}

// Wall atlas: four 128 px bands stacked vertically. u repeats along the wall
// (one tile = WALL_TILE_METERS). Bands (v ranges include 6 px padding):
export const WALL_BANDS = {
  redWhite: 3,   // top band
  blueWhite: 2,
  stone: 1,
  hazard: 0,     // bottom band
};
export function wallBandV(band) {
  // returns [v0, v1] inside the band, padded to limit mip bleeding
  const v0 = band / 4, pad = 6 / 512;
  return [v0 + pad, v0 + 0.25 - pad];
}
export function createWallAtlasTexture({ aniso = 1, seed = 61 } = {}) {
  const rng = makeRng(seed);
  const w = 512, h = 512, bh = 128;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  // canvas row 0 is the TOP = v 1 → band 3 lives at canvas y 0..128
  const bandY = (band) => (3 - band) * bh;

  // red / white blocks with a top highlight
  let y = bandY(WALL_BANDS.redWhite);
  for (let k = 0; k < 4; k++) { g.fillStyle = k % 2 ? '#f7f5ef' : '#e5302a'; g.fillRect(k * w / 4, y, w / 4, bh); }
  g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(0, y, w, 14);
  g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, y + bh - 18, w, 18);

  // blue / white panels with a stylised wave logo
  y = bandY(WALL_BANDS.blueWhite);
  g.fillStyle = '#1f6fd6'; g.fillRect(0, y, w, bh);
  for (let k = 0; k < 2; k++) {
    const x0 = k * w / 2;
    g.fillStyle = '#f4f8ff'; g.fillRect(x0 + 10, y + 18, w / 2 - 20, bh - 36);
    g.strokeStyle = '#1f6fd6'; g.lineWidth = 9;
    g.beginPath();
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const px = x0 + 30 + t * (w / 2 - 60), py = y + bh / 2 + Math.sin(t * Math.PI * 3) * 16;
      if (t === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.stroke();
    g.fillStyle = '#ffcf33';
    g.beginPath(); g.arc(x0 + w / 4, y + bh / 2 - 2, 10, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(0, y + bh - 12, w, 12);

  // stone wall
  y = bandY(WALL_BANDS.stone);
  g.fillStyle = '#7d7468'; g.fillRect(0, y, w, bh);
  const rows = 4, rh = bh / rows;
  for (let r = 0; r < rows; r++) {
    let x = r % 2 ? -30 : 0;
    while (x < w) {
      const sw = 40 + rng() * 40;
      const shade = 150 + Math.floor(rng() * 50);
      g.fillStyle = `rgb(${shade + 8},${shade},${shade - 14})`;
      // draw with wrap so the band tiles seamlessly in u
      const draw = (xx) => g.fillRect(xx + 2, y + r * rh + 2, sw - 4, rh - 4);
      draw(x); if (x + sw > w) draw(x - w);
      x += sw;
    }
  }
  g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(0, y, w, 6);

  // hazard stripes
  y = bandY(WALL_BANDS.hazard);
  g.save(); g.beginPath(); g.rect(0, y, w, bh); g.clip();
  g.fillStyle = '#ffcc1a'; g.fillRect(0, y, w, bh);
  g.fillStyle = '#1b1b22';
  for (let x = -bh; x < w + bh; x += 64) {
    g.beginPath(); g.moveTo(x, y + bh); g.lineTo(x + 32, y + bh); g.lineTo(x + 32 + bh, y); g.lineTo(x + bh, y); g.closePath(); g.fill();
  }
  g.restore();
  return finish(c, { aniso });
}

// Start/finish gantry banner: "KRISHIV KART" with a checkered border. The
// title is shrunk (never stretched) to fit between the checkered end caps.
// `bg` = [top, bottom] gradient colours, `outline` = letter outline colour.
export function createBannerTexture(text = 'KRISHIV KART', { aniso = 1, bg: bgCols = ['#2b7cff', '#1546b8'], outline = '#7a1408' } = {}) {
  const w = 1024, h = 128;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, bgCols[0]); bg.addColorStop(1, bgCols[1]);
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // checkered end caps
  const sq = h / 4;
  for (const x0 of [0, w - sq * 2]) {
    for (let r = 0; r < 4; r++) for (let k = 0; k < 2; k++) {
      g.fillStyle = (r + k) % 2 ? '#111' : '#fff';
      g.fillRect(x0 + k * sq, r * sq, sq, sq);
    }
  }
  g.fillStyle = '#ffd23a'; g.fillRect(sq * 2, 0, w - sq * 4, 7); g.fillRect(sq * 2, h - 7, w - sq * 4, 7);
  const family = '"Arial Black", "Lilita One", Impact, sans-serif';
  const maxW = w - sq * 4 - 64;            // clear of the end caps, incl. the 14 px outline
  let size = 88;
  g.font = `900 ${size}px ${family}`;
  const measured = g.measureText(text).width;
  if (measured > maxW) { size = Math.max(40, Math.floor(size * maxW / measured)); g.font = `900 ${size}px ${family}`; }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 14; g.strokeStyle = outline; g.strokeText(text, w / 2, h / 2 + 4);
  const tg = g.createLinearGradient(0, 20, 0, h - 20);
  tg.addColorStop(0, '#fff27a'); tg.addColorStop(1, '#ff9b1f');
  g.fillStyle = tg; g.fillText(text, w / 2, h / 2 + 4);
  return finish(c, { aniso, repeat: false });
}

// Corner warning sign: white chevrons on red pointing RIGHT. A board rotated
// 180° about its normal shows the arrows pointing left.
export function createTurnSignTexture({ aniso = 1 } = {}) {
  const w = 256, h = 128;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#e3241c'; g.fillRect(8, 8, w - 16, h - 16);
  g.fillStyle = '#ffffff';
  for (let k = 0; k < 3; k++) {
    const x = 34 + k * 66;
    g.beginPath();
    g.moveTo(x, 22); g.lineTo(x + 26, 22); g.lineTo(x + 62, h / 2); g.lineTo(x + 26, h - 22); g.lineTo(x, h - 22); g.lineTo(x + 36, h / 2);
    g.closePath(); g.fill();
  }
  return finish(c, { aniso, repeat: false });
}

// Tileable water normal map (linear data). Built from integer-frequency sine
// sums + tile noise so it repeats seamlessly. b channel carries a foam mask.
export function createWaterNormalTexture({ size = 256, seed = 71 } = {}) {
  const rng = makeRng(seed);
  const hgt = new Float32Array(size * size);
  const n = tileFbm(size, 8, 4, rng, 0.55);
  const waves = [];
  for (let k = 0; k < 7; k++) waves.push({ fx: Math.floor(rng() * 7) - 3, fy: 1 + Math.floor(rng() * 5), ph: rng() * Math.PI * 2, a: 0.3 + rng() * 0.6 });
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = n[y * size + x] * 1.4;
    for (const w of waves) v += Math.sin(((x * w.fx + y * w.fy) / size) * Math.PI * 2 + w.ph) * w.a * 0.25;
    hgt[y * size + x] = v;
  }
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const foam = tileFbm(size, 16, 3, rng, 0.5);
  const k = 2.4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const xl = hgt[y * size + ((x - 1 + size) % size)], xr = hgt[y * size + ((x + 1) % size)];
    const yu = hgt[((y - 1 + size) % size) * size + x], yd = hgt[((y + 1) % size) * size + x];
    let nx = (xl - xr) * k, ny = (yu - yd) * k, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * size + x) * 4;
    d[i] = (nx * 0.5 + 0.5) * 255;
    d[i + 1] = (ny * 0.5 + 0.5) * 255;
    d[i + 2] = foam[y * size + x] * 255;   // foam/noise mask (not z: shader rebuilds z)
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(c, { srgb: false });
}

// ------------------------------------------------------------------ hill town (Monte Mozzarella)

// Rounded rectangle path helper.
function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Cobbled road ("sampietrini"): warm grey setts in running rows with dark
// joints. Same UV convention as the asphalt (u 0..1 across the road, one
// tile along = the caller's tile length); `lines` paints the white edge lines
// and center dashes. Rows divide the tile exactly, so v tiles seamlessly.
export function createCobbleTexture({ size = 1024, aniso = 1, seed = 81, lines = true } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  g.fillStyle = '#6b655c'; g.fillRect(0, 0, size, size);          // joints
  const blot = tileFbm(64, 4, 3, rng, 0.5);                       // large-scale tone patches
  const rows = 40, rh = size / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh;
    let x = -rng() * 20;
    while (x < size) {
      const w = 18 + rng() * 9;
      const tone = blot[(Math.floor((y / size) * 64) % 64) * 64 + (Math.floor((Math.max(0, x) / size) * 64) % 64)];
      const v = 132 + (tone - 0.5) * 24 + (rng() - 0.5) * 18;
      const warm = rng() < 0.18 ? 10 : 0;                           // a few warmer stones
      g.fillStyle = `rgb(${clamp(v + 8 + warm, 0, 255) | 0},${clamp(v + 2 + warm * 0.5, 0, 255) | 0},${clamp(v - 8, 0, 255) | 0})`;
      roundRect(g, x + 1.6, y + 1.6, w - 3.2, rh - 3.2, 4.5);
      g.fill();
      // top highlight + bottom shade (canvas top = forward)
      g.fillStyle = 'rgba(255,250,240,0.1)'; g.fillRect(x + 3, y + 2.4, w - 6, 2.4);
      g.fillStyle = 'rgba(0,0,0,0.1)'; g.fillRect(x + 3, y + rh - 5, w - 6, 2.4);
      x += w;
    }
  }
  // fine grain
  const img = g.getImageData(0, 0, size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const n = (rng() - 0.5) * 9;
    d[i * 4] = clamp(d[i * 4] + n, 0, 255); d[i * 4 + 1] = clamp(d[i * 4 + 1] + n, 0, 255); d[i * 4 + 2] = clamp(d[i * 4 + 2] + n, 0, 255);
  }
  g.putImageData(img, 0, 0);
  if (lines) {
    const line = (x0, w, alpha) => {
      for (let y = 0; y < size; y += 2) {
        g.fillStyle = `rgba(250,248,240,${alpha * (0.8 + rng() * 0.2)})`;
        g.fillRect(x0, y, w, 2);
      }
    };
    const ew = Math.round(size * 0.012);
    line(Math.round(size * 0.016), ew, 0.92);
    line(size - Math.round(size * 0.016) - ew, ew, 0.92);
    const cw = Math.round(size * 0.009);
    for (let k = 0; k < 2; k++) {
      const y0 = Math.round(size * (k * 0.5 + 0.06)), len = Math.round(size * 0.26);
      for (let y = y0; y < y0 + len; y += 2) {
        g.fillStyle = `rgba(255,246,214,${0.82 * (0.8 + rng() * 0.2)})`;
        g.fillRect(Math.round(size / 2 - cw / 2), y, cw, 2);
      }
    }
  }
  return finish(c, { aniso });
}

// Piazza paving: big travertine slabs in running bond, tileable both ways
// (one tile = 4 m when the caller uses world-metre UVs / 4).
export function createPavingTexture({ size = 512, aniso = 1, seed = 83 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  g.fillStyle = '#b8a890'; g.fillRect(0, 0, size, size);
  const rows = 8, rh = size / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh;
    let x = (r % 2) * rh * 0.6;
    const x0 = x;
    while (x < x0 + size) {
      const w = rh * (1.1 + Math.floor(rng() * 3) * 0.35);
      const v = 222 + (rng() - 0.5) * 22;
      const fill = `rgb(${v | 0},${(v - 10) | 0},${(v - 30) | 0})`;
      const draw = (xx) => { g.fillStyle = fill; g.fillRect(xx + 1.5, y + 1.5, Math.min(w, x0 + size - x) - 3, rh - 3); };
      draw(x % size); if ((x % size) + w > size) draw((x % size) - size);
      x += w;
    }
  }
  const img = g.getImageData(0, 0, size, size), d = img.data;
  const n = tileFbm(size, 8, 4, rng, 0.55);
  for (let i = 0; i < size * size; i++) {
    const k = (n[i] - 0.5) * 26 + (rng() - 0.5) * 10;
    d[i * 4] = clamp(d[i * 4] + k, 0, 255); d[i * 4 + 1] = clamp(d[i * 4 + 1] + k, 0, 255); d[i * 4 + 2] = clamp(d[i * 4 + 2] + k * 0.9, 0, 255);
  }
  g.putImageData(img, 0, 0);
  return finish(c, { aniso });
}

// Grayscale ashlar blocks (tinted by vertex colours): aqueduct, tower base,
// retaining walls. One tile = 4 × 4 blocks.
export function createStoneBlockTexture({ size = 512, aniso = 1, seed = 85 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  g.fillStyle = '#9c9890'; g.fillRect(0, 0, size, size);
  const rows = 8, rh = size / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh;
    let x = (r % 2) * rh;
    const x0 = x;
    while (x < x0 + size) {
      const w = rh * (1.6 + rng() * 0.9);
      const v = 236 + (rng() - 0.5) * 30;
      const draw = (xx) => {
        g.fillStyle = `rgb(${v | 0},${(v - 3) | 0},${(v - 8) | 0})`;
        g.fillRect(xx + 2, y + 2, w - 4, rh - 4);
        g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(xx + 2, y + 2, w - 4, 3);
        g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(xx + 2, y + rh - 6, w - 4, 4);
      };
      draw(x % size); if ((x % size) + w > size) draw((x % size) - size);
      x += w;
    }
  }
  const img = g.getImageData(0, 0, size, size), d = img.data;
  const n = tileFbm(size, 16, 3, rng, 0.5);
  for (let i = 0; i < size * size; i++) {
    const k = (n[i] - 0.5) * 24 + (rng() - 0.5) * 12;
    d[i * 4] = clamp(d[i * 4] + k, 0, 255); d[i * 4 + 1] = clamp(d[i * 4 + 1] + k, 0, 255); d[i * 4 + 2] = clamp(d[i * 4 + 2] + k, 0, 255);
  }
  g.putImageData(img, 0, 0);
  return finish(c, { aniso });
}

// Town wall atlas: same layout as the circuit atlas (4 bands of 128 px, use
// wallBandV) with hill-town barriers.
export const TOWN_WALL_BANDS = {
  balustrade: 3,   // piazza: cream stone balustrade
  stucco: 2,       // village: pastel garden wall with a terracotta coping
  stone: 1,        // retaining / vineyard dry-stone wall
  brick: 0,        // coffee factory
};
export function createTownWallAtlasTexture({ aniso = 1, seed = 87 } = {}) {
  const rng = makeRng(seed);
  const w = 512, h = 512, bh = 128;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const bandY = (band) => (3 - band) * bh;          // canvas top = v 1

  // balustrade: rail on top, plinth below, vase-shaped balusters between
  let y = bandY(TOWN_WALL_BANDS.balustrade);
  g.fillStyle = '#8f8270'; g.fillRect(0, y, w, bh);                  // shadowed gaps
  const cream = '#efe4cf';
  g.fillStyle = cream; g.fillRect(0, y, w, 26);                       // top rail
  g.fillStyle = '#d8ccb4'; g.fillRect(0, y + 22, w, 6);
  g.fillStyle = cream; g.fillRect(0, y + bh - 28, w, 28);             // plinth
  g.fillStyle = '#d8ccb4'; g.fillRect(0, y + bh - 28, w, 5);
  const nB = 16, bw = w / nB;
  for (let k = 0; k < nB; k++) {
    const cx = k * bw + bw / 2, top = y + 28, bot = y + bh - 28, hh = bot - top;
    g.fillStyle = cream;
    g.beginPath();
    g.moveTo(cx - bw * 0.22, top);
    g.lineTo(cx + bw * 0.22, top);
    g.quadraticCurveTo(cx + bw * 0.12, top + hh * 0.3, cx + bw * 0.36, top + hh * 0.62);
    g.quadraticCurveTo(cx + bw * 0.42, bot - 4, cx + bw * 0.26, bot);
    g.lineTo(cx - bw * 0.26, bot);
    g.quadraticCurveTo(cx - bw * 0.42, bot - 4, cx - bw * 0.36, top + hh * 0.62);
    g.quadraticCurveTo(cx - bw * 0.12, top + hh * 0.3, cx - bw * 0.22, top);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(120,100,70,0.25)'; g.fillRect(cx + bw * 0.12, top, bw * 0.1, hh);   // side shade
  }

  // stucco: warm ochre plaster, terracotta coping tiles along the top
  y = bandY(TOWN_WALL_BANDS.stucco);
  g.fillStyle = '#f1c98a'; g.fillRect(0, y, w, bh);
  const n = tileFbm(128, 4, 4, rng, 0.55);
  for (let yy = 0; yy < bh - 24; yy += 2) for (let x = 0; x < w; x += 2) {
    const v = n[((yy * 2) % 128) * 128 + ((x / 4) | 0) % 128];
    g.fillStyle = `rgba(${v > 0.5 ? '255,245,225' : '150,95,40'},${Math.abs(v - 0.5) * 0.25})`;
    g.fillRect(x, y + 24 + yy, 2, 2);
  }
  g.fillStyle = '#a8462a'; g.fillRect(0, y, w, 24);
  for (let x = 0; x < w; x += 16) {
    g.fillStyle = '#cf6a3e';
    g.beginPath(); g.arc(x + 8, y + 12, 8, Math.PI, 0); g.lineTo(x + 16, y + 22); g.lineTo(x, y + 22); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,220,180,0.35)'; g.fillRect(x + 4, y + 6, 4, 3);
  }
  g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, y + 24, w, 5);
  g.fillStyle = 'rgba(120,80,40,0.25)'; g.fillRect(0, y + bh - 10, w, 10);

  // stone: warm limestone blocks
  y = bandY(TOWN_WALL_BANDS.stone);
  g.fillStyle = '#857a6a'; g.fillRect(0, y, w, bh);
  const rows = 4, rh = bh / rows;
  for (let r = 0; r < rows; r++) {
    let x = r % 2 ? -30 : 0;
    while (x < w) {
      const sw = 44 + rng() * 40;
      const shade = 178 + Math.floor(rng() * 44);
      g.fillStyle = `rgb(${shade + 10},${shade},${shade - 22})`;
      const draw = (xx) => g.fillRect(xx + 2, y + r * rh + 2, sw - 4, rh - 4);
      draw(x); if (x + sw > w) draw(x - w);
      x += sw;
    }
  }
  g.fillStyle = 'rgba(255,255,255,0.2)'; g.fillRect(0, y, w, 7);

  // brick: red brick running bond with a stone cap
  y = bandY(TOWN_WALL_BANDS.brick);
  g.fillStyle = '#c9b8a2'; g.fillRect(0, y, w, bh);
  g.fillStyle = '#e6dccb'; g.fillRect(0, y, w, 16);
  const brH = (bh - 16) / 7;
  for (let r = 0; r < 7; r++) {
    const yy = y + 16 + r * brH;
    for (let x = (r % 2) * -16; x < w; x += 32) {
      const v = rng();
      g.fillStyle = v < 0.15 ? '#9c3a24' : v < 0.3 ? '#c4583a' : '#b44a2e';
      g.fillRect(x + 1.5, yy + 1.5, 29, brH - 3);
    }
  }
  return finish(c, { aniso });
}

// ------------------------------------------------------------------ v4 shared

// Wooden planks across the road (boardwalks, footbridges, drawbridges).
// u across (0..1 = one tile, the caller sets the span), v along: `planks`
// boards per tile, seams across. `iron` adds two dark iron bands along v.
export function createPlankTexture({ size = 512, aniso = 1, seed = 91, base = [168, 118, 72], planks = 8, iron = false, lines = false } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const ph = size / planks;
  for (let k = 0; k < planks; k++) {
    const y = k * ph;
    const t = 0.82 + rng() * 0.3;
    g.fillStyle = `rgb(${clamp(base[0] * t, 0, 255) | 0},${clamp(base[1] * t, 0, 255) | 0},${clamp(base[2] * t, 0, 255) | 0})`;
    g.fillRect(0, y, size, ph);
    // grain streaks along the board (across the road)
    for (let j = 0; j < 26; j++) {
      const gy = y + 2 + rng() * (ph - 4);
      g.fillStyle = rng() < 0.5 ? 'rgba(60,35,15,0.18)' : 'rgba(255,235,200,0.12)';
      g.fillRect(rng() * size * 0.5, gy, size * (0.3 + rng() * 0.7), 1 + rng() * 1.5);
    }
    // seam + highlight
    g.fillStyle = 'rgba(30,18,8,0.65)'; g.fillRect(0, y, size, 3);
    g.fillStyle = 'rgba(255,240,210,0.15)'; g.fillRect(0, y + 3, size, 2);
    // butt joints + nails
    const jx = rng() * size;
    g.fillStyle = 'rgba(30,18,8,0.55)'; g.fillRect(jx, y, 3, ph);
    g.fillStyle = 'rgba(40,40,44,0.7)';
    for (const nx of [jx - 8, jx + 10]) for (const ny of [y + ph * 0.3, y + ph * 0.7]) g.fillRect((nx + size) % size, ny, 3, 3);
  }
  if (iron) {
    for (const x0 of [0.18, 0.78]) {
      g.fillStyle = '#2a2a30'; g.fillRect(size * x0, 0, size * 0.05, size);
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(size * x0, 0, 3, size);
      g.fillStyle = '#5a5a60';
      for (let y = ph / 2; y < size; y += ph) { g.beginPath(); g.arc(size * (x0 + 0.025), y, 5, 0, Math.PI * 2); g.fill(); }
    }
  }
  if (lines) {
    g.fillStyle = 'rgba(250,246,232,0.9)';
    const ew = Math.round(size * 0.012);
    g.fillRect(Math.round(size * 0.016), 0, ew, size);
    g.fillRect(size - Math.round(size * 0.016) - ew, 0, ew, size);
  }
  return finish(c, { aniso });
}

// Generic 4-band wall atlas from band painters (canvas top = v 1; band 3 at
// the top). painters[band] = (g, y0, w, bh, rng) draws one 512 × 128 band.
function bandAtlas(painters, { aniso = 1, seed = 1 } = {}) {
  const rng = makeRng(seed);
  const w = 512, h = 512, bh = 128;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  for (let band = 0; band < 4; band++) {
    const y = (3 - band) * bh;
    g.save(); g.beginPath(); g.rect(0, y, w, bh); g.clip();
    painters[band](g, y, w, bh, rng);
    g.restore();
  }
  return finish(c, { aniso });
}
// Running-bond blocks inside a band (tileable along u).
function blocks(g, y, w, bh, rng, { rows = 4, minW = 40, varW = 40, base = 170, vary = 40, tint = [8, 0, -14], mortar = '#5e564c', top = 0 } = {}) {
  g.fillStyle = mortar; g.fillRect(0, y + top, w, bh - top);
  const rh = (bh - top) / rows;
  for (let r = 0; r < rows; r++) {
    let x = r % 2 ? -minW * 0.7 : 0;
    while (x < w) {
      const sw = minW + rng() * varW;
      const v = base + Math.floor(rng() * vary);
      g.fillStyle = `rgb(${clamp(v + tint[0], 0, 255)},${clamp(v + tint[1], 0, 255)},${clamp(v + tint[2], 0, 255)})`;
      const draw = (xx) => g.fillRect(xx + 2, y + top + r * rh + 2, sw - 4, rh - 4);
      draw(x); if (x + sw > w) draw(x - w);
      x += sw;
    }
  }
}

// ------------------------------------------------------------------ campus (Aldrich Park)

// Pale promenade concrete: big slabs with saw-cut joints, terracotta tile
// bands along both edges (the edge "lines"), a faint centre joint.
export function createConcreteRoadTexture({ size = 1024, aniso = 1, seed = 93 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const blot = tileFbm(size, 8, 4, rng, 0.55);
  for (let i = 0; i < size * size; i++) {
    const v = (blot[i] - 0.5) * 22 + (rng() - 0.5) * 14 + (rng() < 0.01 ? -16 : 0);
    d[i * 4] = clamp(170 + v, 0, 255); d[i * 4 + 1] = clamp(165 + v, 0, 255); d[i * 4 + 2] = clamp(156 + v, 0, 255); d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // slab joints: 4 slabs along per tile, 4 across
  g.fillStyle = 'rgba(70,64,56,0.32)';
  for (let k = 0; k < 4; k++) g.fillRect(0, k * size / 4, size, 2);
  for (let k = 1; k < 4; k++) g.fillRect(k * size / 4, 0, 2, size);
  g.fillStyle = 'rgba(255,252,240,0.12)';
  for (let k = 0; k < 4; k++) g.fillRect(0, k * size / 4 + 2, size, 2);
  // terracotta tile bands at the edges (5 % of the width each)
  const bw = Math.round(size * 0.05);
  for (const x0 of [0, size - bw]) {
    g.fillStyle = '#b5532f'; g.fillRect(x0, 0, bw, size);
    for (let y = 0; y < size; y += bw) {
      for (let k = 0; k < 2; k++) {
        const t = 0.85 + rng() * 0.25;
        g.fillStyle = `rgb(${(206 * t) | 0},${(98 * t) | 0},${(60 * t) | 0})`;
        g.fillRect(x0 + 2 + k * bw / 2, y + 2, bw / 2 - 4, bw - 4);
      }
    }
  }
  // thin white line inside each tile band (keeps the edge readable at speed)
  g.fillStyle = 'rgba(252,250,242,0.9)';
  g.fillRect(bw + 4, 0, Math.round(size * 0.008), size);
  g.fillRect(size - bw - 4 - Math.round(size * 0.008), 0, Math.round(size * 0.008), size);
  return finish(c, { aniso });
}

// Campus barriers (wallBandV bands): white ocean-liner railing on a concrete
// upstand, clipped hedge, rubble stone, timber post-and-rail.
export const CAMPUS_WALL_BANDS = { rail: 3, hedge: 2, stone: 1, timber: 0 };
export function createCampusWallAtlasTexture({ aniso = 1, seed = 95 } = {}) {
  const P = [];
  P[CAMPUS_WALL_BANDS.rail] = (g, y, w, bh) => {
    g.fillStyle = '#cfc8ba'; g.fillRect(0, y, w, bh);                       // concrete upstand
    g.fillStyle = '#9d968a'; g.fillRect(0, y + bh * 0.45, w, bh * 0.55);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = 0; x < w; x += 128) g.fillRect(x, y + bh * 0.45, 3, bh * 0.55);
    g.fillStyle = '#f7f7f2'; g.fillRect(0, y, w, 18);                       // heavy white top rail
    g.fillStyle = '#d9d9d2'; g.fillRect(0, y + 14, w, 5);
    g.fillStyle = '#f2f2ec';
    for (let x = 0; x < w; x += 32) g.fillRect(x + 12, y + 18, 9, bh * 0.45 - 18);   // balusters
    g.fillStyle = '#efefe8'; g.fillRect(0, y + bh * 0.3, w, 7);              // mid rail
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, y + bh - 10, w, 10);
  };
  P[CAMPUS_WALL_BANDS.hedge] = (g, y, w, bh, rng) => {
    g.fillStyle = '#2f6b2e'; g.fillRect(0, y, w, bh);
    for (let k = 0; k < 900; k++) {
      const x = rng() * w, yy = y + rng() * bh, r = 2 + rng() * 5;
      g.fillStyle = rng() < 0.5 ? `rgba(90,160,70,${0.4 + rng() * 0.4})` : `rgba(25,70,30,${0.3 + rng() * 0.4})`;
      for (const xx of [x, x - w, x + w]) { g.beginPath(); g.arc(xx, yy, r, 0, Math.PI * 2); g.fill(); }
    }
    g.fillStyle = 'rgba(200,255,170,0.18)'; g.fillRect(0, y, w, 10);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, y + bh - 14, w, 14);
  };
  P[CAMPUS_WALL_BANDS.stone] = (g, y, w, bh, rng) => {
    blocks(g, y, w, bh, rng, { rows: 3, minW: 30, varW: 50, base: 168, vary: 50, tint: [18, 8, -14], mortar: '#6b5e4e' });
    g.fillStyle = 'rgba(255,240,210,0.25)'; g.fillRect(0, y, w, 8);
  };
  P[CAMPUS_WALL_BANDS.timber] = (g, y, w, bh) => {
    g.fillStyle = '#5d7d47'; g.fillRect(0, y, w, bh);                       // foliage behind the rails
    g.fillStyle = 'rgba(30,50,20,0.4)'; g.fillRect(0, y + bh * 0.6, w, bh * 0.4);
    for (const [y0, hh] of [[0, 20], [bh * 0.42, 16]]) {
      g.fillStyle = '#9b6b3f'; g.fillRect(0, y + y0, w, hh);
      g.fillStyle = 'rgba(255,230,190,0.25)'; g.fillRect(0, y + y0, w, 3);
      g.fillStyle = 'rgba(40,20,5,0.35)'; g.fillRect(0, y + y0 + hh - 3, w, 3);
    }
    for (let x = 0; x < w; x += 128) {
      g.fillStyle = '#7d5230'; g.fillRect(x + 54, y, 20, bh);
      g.fillStyle = 'rgba(255,230,190,0.2)'; g.fillRect(x + 54, y, 4, bh);
    }
  };
  return bandAtlas(P, { aniso, seed });
}

// Building facade (one tile = one window bay × one floor): board-marked
// concrete with a deep precast window hood, dark glass with mullions.
// Grayscale-ish so vertex colours can tint it sand / ochre / white.
export function createCampusFacadeTexture({ size = 256, aniso = 1, seed = 97 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 4, 4, rng, 0.55);
  for (let i = 0; i < size * size; i++) {
    const y = Math.floor(i / size);
    const board = (Math.floor(y / 16) % 2) * 6;
    const v = 226 + (n[i] - 0.5) * 22 + (rng() - 0.5) * 8 - board;
    d[i * 4] = clamp(v, 0, 255); d[i * 4 + 1] = clamp(v - 2, 0, 255); d[i * 4 + 2] = clamp(v - 8, 0, 255); d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const x0 = size * 0.14, x1 = size * 0.86, y0 = size * 0.18, y1 = size * 0.84;
  // hood frame (lighter precast) + its cast shadow
  g.fillStyle = '#f4f2ec'; g.fillRect(x0 - 12, y0 - 14, x1 - x0 + 24, y1 - y0 + 22);
  g.fillStyle = 'rgba(40,36,30,0.55)'; g.fillRect(x0, y0, x1 - x0, 22);
  // glass
  const gl = g.createLinearGradient(0, y0, 0, y1);
  gl.addColorStop(0, '#22303e'); gl.addColorStop(0.5, '#3d5870'); gl.addColorStop(1, '#5f7f96');
  g.fillStyle = gl; g.fillRect(x0, y0 + 22, x1 - x0, y1 - y0 - 22);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.beginPath(); g.moveTo(x0 + 20, y1); g.lineTo(x0 + 60, y0 + 22); g.lineTo(x0 + 80, y0 + 22); g.lineTo(x0 + 40, y1); g.closePath(); g.fill();
  g.fillStyle = '#e8e6df';
  g.fillRect((x0 + x1) / 2 - 3, y0 + 22, 6, y1 - y0 - 22);
  g.fillRect(x0, (y0 + y1) / 2 + 10, x1 - x0, 5);
  // sill shadow + floor slab line
  g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x0 - 12, y1 + 8, x1 - x0 + 24, 6);
  g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, size - 6, size, 6);
  return finish(c, { aniso });
}

// ------------------------------------------------------------------ beach (Laguna Beach)

// Coast barriers: white cliff railing on a sandstone curb, white stucco
// garden wall with a terracotta cap, low sea wall, rope-and-post boardwalk rail.
export const BEACH_WALL_BANDS = { railing: 3, stucco: 2, seawall: 1, rope: 0 };
export function createBeachWallAtlasTexture({ aniso = 1, seed = 99 } = {}) {
  const P = [];
  P[BEACH_WALL_BANDS.railing] = (g, y, w, bh, rng) => {
    g.fillStyle = '#8fb8d0'; g.fillRect(0, y, w, bh * 0.62);                 // sea/sky glimpsed between the bars
    const sk = g.createLinearGradient(0, y, 0, y + bh * 0.62);
    sk.addColorStop(0, 'rgba(255,230,190,0.5)'); sk.addColorStop(1, 'rgba(40,110,160,0.6)');
    g.fillStyle = sk; g.fillRect(0, y, w, bh * 0.62);
    blocks(g, y, w, bh, rng, { rows: 1, minW: 50, varW: 40, base: 196, vary: 30, tint: [22, 6, -24], mortar: '#9a7a52', top: bh * 0.62 });
    g.fillStyle = '#fbfbf6'; g.fillRect(0, y, w, 14);                        // top rail
    g.fillStyle = '#d8d8d0'; g.fillRect(0, y + 11, w, 3);
    g.fillStyle = '#f6f6f0'; g.fillRect(0, y + bh * 0.33, w, 6);
    for (let x = 0; x < w; x += 24) g.fillRect(x + 9, y + 14, 6, bh * 0.62 - 14);
    for (let x = 0; x < w; x += 128) { g.fillStyle = '#ffffff'; g.fillRect(x, y, 14, bh * 0.62); }
  };
  P[BEACH_WALL_BANDS.stucco] = (g, y, w, bh, rng) => {
    g.fillStyle = '#f6f1e6'; g.fillRect(0, y, w, bh);
    const n = tileFbm(128, 4, 3, rng, 0.55);
    for (let yy = 0; yy < bh; yy += 2) for (let x = 0; x < w; x += 2) {
      const v = n[((yy * 2) % 128) * 128 + ((x / 4) | 0) % 128];
      g.fillStyle = `rgba(${v > 0.5 ? '255,255,250' : '170,150,120'},${Math.abs(v - 0.5) * 0.2})`;
      g.fillRect(x, y + yy, 2, 2);
    }
    g.fillStyle = '#b8563a'; g.fillRect(0, y, w, 20);
    for (let x = 0; x < w; x += 16) { g.fillStyle = '#d06e48'; g.beginPath(); g.arc(x + 8, y + 10, 8, Math.PI, 0); g.lineTo(x + 16, y + 18); g.lineTo(x, y + 18); g.closePath(); g.fill(); }
    // bougainvillea spilling over the wall
    for (let k = 0; k < 160; k++) {
      const x = rng() * w, yy = y + 20 + rng() * rng() * bh * 0.5, r = 2 + rng() * 4;
      g.fillStyle = rng() < 0.75 ? `rgba(214,40,140,${0.6 + rng() * 0.4})` : `rgba(60,120,50,${0.6 + rng() * 0.3})`;
      for (const xx of [x, x - w, x + w]) { g.beginPath(); g.arc(xx, yy, r, 0, Math.PI * 2); g.fill(); }
    }
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, y + bh - 10, w, 10);
  };
  P[BEACH_WALL_BANDS.seawall] = (g, y, w, bh, rng) => {
    g.fillStyle = '#e8e1d2'; g.fillRect(0, y, w, bh);
    g.fillStyle = '#2f8fc8'; g.fillRect(0, y + 18, w, 16);
    g.fillStyle = '#ffffff'; g.fillRect(0, y + 34, w, 6);
    g.fillStyle = '#f4efe2'; g.fillRect(0, y, w, 12);
    g.fillStyle = 'rgba(160,130,90,0.35)';
    for (let k = 0; k < 120; k++) g.fillRect(rng() * w, y + bh * 0.6 + rng() * bh * 0.4, 3, 2);   // sand splashes
    g.fillStyle = 'rgba(0,0,0,0.1)';
    for (let x = 0; x < w; x += 128) g.fillRect(x, y, 3, bh);
  };
  P[BEACH_WALL_BANDS.rope] = (g, y, w, bh) => {
    g.fillStyle = '#e9d6a8'; g.fillRect(0, y, w, bh);                       // sand behind
    g.fillStyle = 'rgba(200,170,110,0.5)'; g.fillRect(0, y + bh * 0.5, w, bh * 0.5);
    for (let x = 0; x < w; x += 128) {
      g.fillStyle = '#8a5a32'; g.fillRect(x + 56, y + 6, 16, bh - 6);
      g.fillStyle = '#c99a62'; g.fillRect(x + 56, y + 6, 4, bh - 6);
    }
    g.strokeStyle = '#d8c39a'; g.lineWidth = 7;
    for (const yy of [0.18, 0.5]) {
      g.beginPath();
      for (let x = -64; x <= w + 64; x += 4) {
        const t = ((x - 64) % 128 + 128) % 128 / 128;
        const py = y + bh * yy + 14 * Math.sin(t * Math.PI);
        if (x === -64) g.moveTo(x, py); else g.lineTo(x, py);
      }
      g.stroke();
    }
  };
  return bandAtlas(P, { aniso, seed });
}

// Shop sign words (one row per word; 1 × N atlas, each row 512 × 96).
export const SIGN_WORDS = ['ART', 'SURF', 'CAFÉ', 'GALLERY', 'TACOS', 'GELATO', 'BOOKS', 'BIKES'];
export function createSignAtlasTexture({ aniso = 1 } = {}) {
  const w = 512, rh = 96, h = rh * SIGN_WORDS.length;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const bgs = ['#fff4dc', '#16324f', '#f7f0e4', '#2a2a2a', '#ffd166', '#f28ab8', '#1d6e5e', '#e85d4a'];
  const fgs = ['#c2452d', '#ffd166', '#5a3a22', '#f7f7f2', '#7a2a12', '#ffffff', '#fff4dc', '#ffffff'];
  SIGN_WORDS.forEach((word, k) => {
    const y = k * rh;
    g.fillStyle = bgs[k % bgs.length]; g.fillRect(0, y, w, rh);
    g.strokeStyle = fgs[k % fgs.length]; g.lineWidth = 5; g.strokeRect(8, y + 8, w - 16, rh - 16);
    g.fillStyle = fgs[k % fgs.length];
    g.font = '900 60px "Arial Black", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(word, w / 2, y + rh / 2 + 3);
  });
  return finish(c, { aniso, repeat: false });
}

// ------------------------------------------------------------------ castle (Krishiv's Palace)

// Dark basalt flagstones with warm white edge lines and a glowing amber
// centre dash (readable in the gloom).
export function createFlagstoneTexture({ size = 1024, aniso = 1, seed = 101 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  g.fillStyle = '#1c1a1e'; g.fillRect(0, 0, size, size);
  const rows = 8, rh = size / rows;
  for (let r = 0; r < rows; r++) {
    let x = (r % 2) * -rh * 0.6;
    const y = r * rh;
    while (x < size) {
      const w = rh * (0.9 + rng() * 0.9);
      const v = 70 + Math.floor(rng() * 34);
      g.fillStyle = `rgb(${v + 4},${v},${v + 6})`;
      const draw = (xx) => { g.fillRect(xx + 3, y + 3, w - 6, rh - 6); };
      draw(x); if (x + w > size) draw(x - size);
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(x + 3, y + 3, w - 6, 4);
      x += w;
    }
  }
  const img = g.getImageData(0, 0, size, size), d = img.data;
  const n = tileFbm(size, 8, 4, rng, 0.55);
  for (let i = 0; i < size * size; i++) {
    const k = (n[i] - 0.5) * 26 + (rng() - 0.5) * 10;
    d[i * 4] = clamp(d[i * 4] + k, 0, 255); d[i * 4 + 1] = clamp(d[i * 4 + 1] + k * 0.95, 0, 255); d[i * 4 + 2] = clamp(d[i * 4 + 2] + k * 0.9, 0, 255);
  }
  g.putImageData(img, 0, 0);
  // embers in the joints
  for (let k = 0; k < 90; k++) {
    g.fillStyle = `rgba(255,${(90 + rng() * 80) | 0},20,${0.25 + rng() * 0.35})`;
    g.fillRect(rng() * size, Math.floor(rng() * rows) * rh - 1, 6 + rng() * 18, 3);
  }
  const line = (x0, w, col) => { g.fillStyle = col; g.fillRect(x0, 0, w, size); };
  const ew = Math.round(size * 0.013);
  line(Math.round(size * 0.016), ew, 'rgba(240,226,196,0.92)');
  line(size - Math.round(size * 0.016) - ew, ew, 'rgba(240,226,196,0.92)');
  const cw = Math.round(size * 0.009);
  for (let k = 0; k < 2; k++) {
    const y0 = Math.round(size * (k * 0.5 + 0.06)), len = Math.round(size * 0.24);
    g.fillStyle = 'rgba(255,170,60,0.85)'; g.fillRect(Math.round(size / 2 - cw / 2), y0, cw, len);
  }
  return finish(c, { aniso });
}

// Castle barriers: basalt parapet with a gold trim, the same with a red
// pennant band, iron chain rail on posts, glowing cracked lava stone.
export const CASTLE_WALL_BANDS = { parapet: 3, banner: 2, chain: 1, lava: 0 };
export function createCastleWallAtlasTexture({ aniso = 1, seed = 103 } = {}) {
  const P = [];
  const basalt = (g, y, w, bh, rng) => blocks(g, y, w, bh, rng, { rows: 3, minW: 46, varW: 50, base: 54, vary: 26, tint: [4, 0, 8], mortar: '#141216' });
  P[CASTLE_WALL_BANDS.parapet] = (g, y, w, bh, rng) => {
    basalt(g, y, w, bh, rng);
    g.fillStyle = '#d9a52c'; g.fillRect(0, y, w, 10);
    g.fillStyle = '#8a5e12'; g.fillRect(0, y + 10, w, 3);
    g.fillStyle = 'rgba(255,120,40,0.18)'; g.fillRect(0, y + bh - 16, w, 16);   // lava glow from below
  };
  P[CASTLE_WALL_BANDS.banner] = (g, y, w, bh, rng) => {
    basalt(g, y, w, bh, rng);
    g.fillStyle = '#d9a52c'; g.fillRect(0, y, w, 10);
    for (let x = 0; x < w; x += 128) {
      g.fillStyle = '#9c1420';
      g.beginPath(); g.moveTo(x + 40, y + 12); g.lineTo(x + 88, y + 12); g.lineTo(x + 88, y + bh - 20); g.lineTo(x + 64, y + bh - 36); g.lineTo(x + 40, y + bh - 20); g.closePath(); g.fill();
      g.fillStyle = '#e8b830';
      g.beginPath(); g.moveTo(x + 50, y + 44); g.lineTo(x + 56, y + 30); g.lineTo(x + 64, y + 40); g.lineTo(x + 72, y + 30); g.lineTo(x + 78, y + 44); g.closePath(); g.fill();
      g.font = '900 34px "Arial Black", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('K', x + 64, y + 68);
    }
  };
  P[CASTLE_WALL_BANDS.chain] = (g, y, w, bh) => {
    g.fillStyle = '#2a1410'; g.fillRect(0, y, w, bh);
    const gl = g.createLinearGradient(0, y, 0, y + bh);
    gl.addColorStop(0, 'rgba(60,20,30,1)'); gl.addColorStop(1, 'rgba(255,90,20,0.85)');
    g.fillStyle = gl; g.fillRect(0, y, w, bh);
    for (let x = 0; x < w; x += 128) { g.fillStyle = '#26262c'; g.fillRect(x + 56, y, 16, bh); g.fillStyle = '#4a4a52'; g.fillRect(x + 56, y, 4, bh); }
    g.strokeStyle = '#5c5c66'; g.lineWidth = 5;
    for (const yy of [0.12, 0.5]) {
      for (let x = 0; x < w; x += 16) {
        const t = (x % 128) / 128, py = y + bh * yy + 18 * Math.sin(t * Math.PI);
        g.beginPath(); g.ellipse(x + 8, py, 8, 5, (x / 16) % 2 ? 0.3 : -0.3, 0, Math.PI * 2); g.stroke();
      }
    }
  };
  P[CASTLE_WALL_BANDS.lava] = (g, y, w, bh, rng) => {
    g.fillStyle = '#ff7a1a'; g.fillRect(0, y, w, bh);
    blocks(g, y, w, bh, rng, { rows: 3, minW: 40, varW: 60, base: 40, vary: 24, tint: [10, 0, 0], mortar: '#ff8a20' });
    g.fillStyle = '#d9a52c'; g.fillRect(0, y, w, 8);
  };
  return bandAtlas(P, { aniso, seed });
}

// Crowned-K emblem (banners, the gate shield, the throne): a gold crown over
// a red "K" on black, gold border. `shape` 'banner' (swallow-tail) | 'shield'
// | 'square'. Transparent outside the shape.
export function createCrownKTexture({ size = 256, aniso = 1, shape = 'banner' } = {}) {
  const w = size, h = shape === 'banner' ? size * 2 : size;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  const path = () => {
    g.beginPath();
    if (shape === 'banner') {
      g.moveTo(0, 0); g.lineTo(w, 0); g.lineTo(w, h); g.lineTo(w / 2, h * 0.84); g.lineTo(0, h); g.closePath();
    } else if (shape === 'shield') {
      g.moveTo(w * 0.06, h * 0.04); g.lineTo(w * 0.94, h * 0.04); g.lineTo(w * 0.94, h * 0.5);
      g.quadraticCurveTo(w * 0.92, h * 0.86, w / 2, h * 0.98); g.quadraticCurveTo(w * 0.08, h * 0.86, w * 0.06, h * 0.5); g.closePath();
    } else g.rect(0, 0, w, h);
  };
  path(); g.fillStyle = '#d9a52c'; g.fill();
  g.save(); path(); g.clip();
  g.lineWidth = w * 0.09; g.strokeStyle = '#8a5e12'; path(); g.stroke();
  g.restore();
  // inner black field
  g.save(); path(); g.clip();
  g.fillStyle = shape === 'banner' ? '#7a0f18' : '#111015';
  const inset = w * 0.07;
  g.translate(w / 2, h / 2); g.scale(1 - (2 * inset) / w, 1 - (2 * inset) / h); g.translate(-w / 2, -h / 2);
  path(); g.fill();
  g.restore();
  const cy = shape === 'banner' ? h * 0.36 : h * 0.5;
  // crown
  g.fillStyle = '#ffd04a'; g.strokeStyle = '#8a5e12'; g.lineWidth = w * 0.015;
  const cw = w * 0.5, ch = w * 0.2, cx0 = w / 2 - cw / 2, cyTop = cy - w * 0.36;
  g.beginPath();
  g.moveTo(cx0, cyTop + ch); g.lineTo(cx0, cyTop + ch * 0.25); g.lineTo(cx0 + cw * 0.22, cyTop + ch * 0.6); g.lineTo(cx0 + cw * 0.5, cyTop);
  g.lineTo(cx0 + cw * 0.78, cyTop + ch * 0.6); g.lineTo(cx0 + cw, cyTop + ch * 0.25); g.lineTo(cx0 + cw, cyTop + ch); g.closePath();
  g.fill(); g.stroke();
  g.fillStyle = '#e8344e';
  for (const fx of [0.5, 0.15, 0.85]) { g.beginPath(); g.arc(cx0 + cw * fx, cyTop + ch * 0.72, w * 0.025, 0, Math.PI * 2); g.fill(); }
  // the K
  g.font = `900 ${Math.round(w * 0.52)}px "Arial Black", Impact, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round'; g.lineWidth = w * 0.05; g.strokeStyle = '#ffd04a';
  g.strokeText('K', w / 2, cy + w * 0.1);
  g.fillStyle = '#d4202c'; g.fillText('K', w / 2, cy + w * 0.1);
  return finish(c, { aniso, repeat: false });
}

// Lava: molten orange-yellow with drifting dark crust plates whose rims
// glow (tileable; scroll it for flow). Colour map for an unlit material.
export function createLavaTexture({ size = 256, aniso = 1, seed = 107 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 4, 5, rng, 0.55);
  const m = tileFbm(size, 8, 3, rng, 0.5);
  for (let i = 0; i < size * size; i++) {
    const v = n[i] + (m[i] - 0.5) * 0.18;
    const crust = clamp((v - 0.5) / 0.1, 0, 1);
    const rim = Math.max(0, 1 - Math.abs(v - 0.52) / 0.035);
    const hot = clamp((0.42 - v) / 0.14, 0, 1);
    let r = lerp(255, 66, crust), gg = lerp(lerp(118, 214, hot), 22, crust), b = lerp(lerp(18, 90, hot), 14, crust);
    r = clamp(r + rim * 40, 0, 255); gg = clamp(gg + rim * 120, 0, 255); b = clamp(b + rim * 20, 0, 255);
    d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(c, { aniso });
}

// Lava fall: vertical molten streaks (bright core, darker red edges), tileable;
// scroll v for the flow.
export function createLavaFallTexture({ size = 128, aniso = 1, seed = 111 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const cols = new Float32Array(size);
  const nx = tileNoise(size, 12, rng), ny = tileFbm(size, 4, 3, rng, 0.5);
  for (let x = 0; x < size; x++) cols[x] = nx[x];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    const edge = Math.abs(x / size - 0.5) * 2;                       // 0 centre .. 1 edges
    const streak = clamp(cols[x] * 0.8 + ny[(y * size + ((x * 4) % size))] * 0.4, 0, 1);
    const heat = clamp(1.1 - edge * 0.9 + (streak - 0.5) * 0.6, 0, 1);
    d[i * 4] = lerp(150, 255, heat);
    d[i * 4 + 1] = lerp(30, 220, heat * heat);
    d[i * 4 + 2] = lerp(10, 90, heat * heat * heat);
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(c, { aniso });
}

// Soft round glow (white centre fading to transparent): light pools, embers.
export function createGlowTexture({ size = 128 } = {}) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return finish(c, { repeat: false });
}
