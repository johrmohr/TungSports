// Canvas-generated textures (no image files): maple lane boards, pins,
// marbled balls, the masking-unit emblem, carpet and the approach.
import * as THREE from 'three';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

// Small deterministic PRNG so textures look the same on every load.
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

function tex(c, { repeat = [1, 1], srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

// Maple boards: `boards` strips across, wood grain running along the lane.
// One texture tile covers the full lane width and `tileLength` metres.
export function laneWood({ boards = 39, light = '#dcb57c', dark = '#b48d52', seed = 7, w = 1024, h = 1024 } = {}) {
  const [c, g] = canvas(w, h);
  const r = rng(seed);
  const bw = w / boards;
  const base = new THREE.Color(light);
  const shade = new THREE.Color(dark);
  for (let i = 0; i < boards; i++) {
    const k = 0.25 + r() * 0.5;
    const col = base.clone().lerp(shade, k * 0.55);
    g.fillStyle = `#${col.getHexString()}`;
    g.fillRect(i * bw, 0, bw + 1, h);
    // Grain streaks.
    for (let s = 0; s < 22; s++) {
      const x = i * bw + r() * bw;
      const alpha = 0.04 + r() * 0.08;
      g.strokeStyle = r() < 0.5 ? `rgba(120,80,30,${alpha})` : `rgba(255,240,200,${alpha})`;
      g.lineWidth = 0.6 + r() * 1.6;
      g.beginPath();
      g.moveTo(x, 0);
      for (let y = 0; y <= h; y += 64) g.lineTo(x + Math.sin(y * 0.01 + s) * (0.8 + r() * 1.5), y);
      g.stroke();
    }
    // Butt joints between board lengths.
    const joints = 1 + Math.floor(r() * 2);
    for (let j = 0; j < joints; j++) {
      const y = r() * h;
      g.fillStyle = 'rgba(90,60,25,0.25)';
      g.fillRect(i * bw, y, bw, 1.5);
    }
    // Seam between boards.
    g.fillStyle = 'rgba(80,50,20,0.35)';
    g.fillRect(i * bw, 0, 1, h);
  }
  return tex(c);
}

// Light approach wood, with the guide dots drawn separately as meshes.
export function approachWood(seed = 11) {
  return laneWood({ boards: 39, light: '#e2c690', dark: '#c6a46a', seed });
}

// Pin skin: glossy white with one red neck band with a zig-zag edge.
// UV v runs 0 (base) → 1 (top) linearly in height (see pinGeometry).
export function pinTexture(heights) {
  const [c, g] = canvas(256, 1024);
  g.fillStyle = '#f6f3ea';
  g.fillRect(0, 0, 256, 1024);
  // Very subtle lacquer variation.
  const r = rng(3);
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(200,190,170,${r() * 0.05})`;
    g.fillRect(r() * 256, r() * 1024, 2 + r() * 6, 2 + r() * 10);
  }
  const H = heights.total;
  const yOf = (h) => 1024 - (h / H) * 1024;
  const lo = yOf(heights.bandLow), hi = yOf(heights.bandHigh);
  const teeth = 6, amp = (lo - hi) * 0.28;
  g.fillStyle = '#d23a2a';
  g.beginPath();
  g.moveTo(0, hi);
  for (let i = 0; i <= teeth * 2; i++) g.lineTo((i / (teeth * 2)) * 256, hi + (i % 2 ? amp : 0));
  g.lineTo(256, lo);
  for (let i = teeth * 2; i >= 0; i--) g.lineTo((i / (teeth * 2)) * 256, lo - (i % 2 ? amp : 0));
  g.closePath();
  g.fill();
  const t = tex(c, { repeat: [1, 1] });
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// Glossy marbled ball in the player's colour.
export function ballTexture(hex, seed = 5) {
  const [c, g] = canvas(512, 256);
  const base = new THREE.Color(hex);
  const light = base.clone().lerp(new THREE.Color('#ffffff'), 0.35);
  const dark = base.clone().lerp(new THREE.Color('#000000'), 0.35);
  g.fillStyle = `#${base.getHexString()}`;
  g.fillRect(0, 0, 512, 256);
  const r = rng(seed);
  // Marble veins: wavy bands of light and dark.
  for (let v = 0; v < 26; v++) {
    const light1 = r() < 0.55;
    g.strokeStyle = `#${(light1 ? light : dark).getHexString()}`;
    g.globalAlpha = 0.18 + r() * 0.3;
    g.lineWidth = 4 + r() * 16;
    g.beginPath();
    const y0 = r() * 256, f = 0.01 + r() * 0.03, a = 10 + r() * 40, ph = r() * 6.28;
    for (let x = 0; x <= 512; x += 8) {
      const y = y0 + Math.sin(x * f + ph) * a + Math.sin(x * f * 2.7 + ph * 1.3) * a * 0.3;
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  return tex(c, { repeat: [1, 1] });
}

// Masking-unit emblem: chrome oval with white slats and a gold star.
export function emblemTexture() {
  const [c, g] = canvas(512, 256);
  g.clearRect(0, 0, 512, 256);
  const grd = g.createLinearGradient(0, 30, 0, 226);
  grd.addColorStop(0, '#f4f4f2');
  grd.addColorStop(0.5, '#b9bcbc');
  grd.addColorStop(1, '#e8e8e6');
  g.fillStyle = grd;
  g.beginPath();
  g.ellipse(256, 128, 230, 100, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#8f9393';
  g.lineWidth = 6;
  g.stroke();
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 5; i++) {
    const y = 70 + i * 28;
    const half = Math.sqrt(Math.max(0, 1 - ((y - 128) / 100) ** 2)) * 200;
    g.fillRect(256 - half, y, half * 2, 12);
  }
  // Gold star.
  g.fillStyle = '#ffe65a';
  g.strokeStyle = '#c89b14';
  g.lineWidth = 6;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? 34 : 78;
    g.lineTo(256 + Math.cos(a) * rr, 132 + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Olive-khaki carpet for the seating area.
export function carpetTexture() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#948d74';
  g.fillRect(0, 0, 256, 256);
  const r = rng(21);
  for (let i = 0; i < 5000; i++) {
    const v = r();
    g.fillStyle = v < 0.5 ? `rgba(70,64,48,${r() * 0.25})` : `rgba(190,182,150,${r() * 0.2})`;
    g.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2);
  }
  // A subtle diamond pattern.
  g.strokeStyle = 'rgba(120,110,80,0.25)';
  g.lineWidth = 3;
  for (let i = -256; i < 512; i += 64) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 256, 256); g.stroke();
    g.beginPath(); g.moveTo(i + 256, 0); g.lineTo(i, 256); g.stroke();
  }
  return tex(c, { repeat: [8, 4] });
}

// Ceiling panels with soft light pools.
export function ceilingTexture() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#e2c590';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(150,115,70,0.3)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 252, 252);
  const grd = g.createRadialGradient(128, 128, 10, 128, 128, 120);
  grd.addColorStop(0, 'rgba(255,248,225,0.95)');
  grd.addColorStop(0.35, 'rgba(255,240,205,0.5)');
  grd.addColorStop(1, 'rgba(255,240,205,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  return tex(c, { repeat: [12, 10] });
}

// Soft round blob shadow.
export function blobShadow() {
  const [c, g] = canvas(128, 128);
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.6, 'rgba(0,0,0,0.25)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  return t;
}

// Back-wall sign ("Bowling" in a friendly rounded style).
export function signTexture(text) {
  const [c, g] = canvas(1024, 256);
  g.fillStyle = 'rgba(0,0,0,0)';
  g.clearRect(0, 0, 1024, 256);
  g.font = '800 150px "M PLUS Rounded 1c", "Nunito", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 18;
  g.lineJoin = 'round';
  g.strokeStyle = '#ffffff';
  g.strokeText(text, 512, 132);
  g.fillStyle = '#1f8fe8';
  g.fillText(text, 512, 132);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
