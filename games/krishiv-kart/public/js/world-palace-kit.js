// Krishiv's Palace world kit: palette + castle construction helpers shared
// by world-palace.js and its room / set-piece modules (browser only).

import * as THREE from 'three';
import { lerp } from './utils.js';
import { place, paint, mixHex, trackStrip, sRange, box, cyl, ball, cone } from './world.js';

// ------------------------------------------------------------------ palette

export const C = {
  skyTop: 0x1c0c2a, skyHorizon: 0xb4441c, skyBottom: 0x5a1e12,
  sun: 0xffc896, hemiSky: 0xa486c4, hemiGround: 0xc4542a,
  ash: 0x645c60, ashLight: 0x80767a, ashDark: 0x423c40, rust: 0x7e4630, basalt: 0x3c3840, scorched: 0x4a2a1e,
  stone: 0x77717c, stoneDark: 0x55505c, stoneWarm: 0x7a6a66, gold: 0xe0ae36, goldDark: 0xa8741a,
  iron: 0x34343a, ironLight: 0x5a5a62, wood: 0x5e3e26, red: 0x9c1420, carpet: 0x8e1018,
  flame: 0xffa43a, flameHot: 0xfff0a0, ember: 0xff6a1a, lavaGlow: 0xff5a10, slate: 0x3a3440,
};
export const LAVA = -2.5;               // lava surface height (m)
export const HALL_H = 15;               // Crusher Hall ceiling above the road
export const THRONE_H = 17;             // Throne Hall ceiling above the road

// Tall wall above the barrier on one side (inner face exactly at the wall
// line), its top cap, and the outer face down to y = bottom (absolute).
export function hallWall(ctx, bucket, s0, s1, side, { H, base = 1.15, T = 1.6, bottom = -4, color = C.stone, step = 2 }) {
  const { track } = ctx;
  if (s1 - s0 < 0.5) return;
  const sl = sRange(s0, s1, step);
  const wallAt = (f) => (side > 0 ? f.wallR : f.wallL);
  const uv = (o, s, y) => { o.u = s / 4; o.v = y / 4; };
  // inner face (faces the road)
  bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
    const upper = side > 0 ? c === 1 : c === 0;
    o.lat = side * wallAt(f); o.dy = upper ? H : base; uv(o, s, o.dy);
  }), color));
  // top
  bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
    const outer = side > 0 ? c === 1 : c === 0;
    o.lat = side * (wallAt(f) + (outer ? T : 0)); o.dy = H; uv(o, s, o.lat);
  }), mixHex(color, 0x000000, 0.15)));
  // outer face (down to the ground)
  bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
    const upper = side > 0 ? c === 0 : c === 1;
    o.lat = side * (wallAt(f) + T);
    if (upper) { o.dy = H; uv(o, s, f.y + H); } else { o.y = bottom; o.dy = 0; uv(o, s, bottom); }
  }), mixHex(color, 0x000000, 0.1)));
}

// Merlons along a wall top (inner face at the wall line).
export function merlons(ctx, bucket, s0, s1, side, { y = 1.15, h = 1.0, w = 1.1, gap = 2.4, T = 0.6, color = C.stoneDark } = {}) {
  const { track } = ctx;
  for (let s = s0 + 1; s < s1 - 0.5; s += gap) {
    const f = track.frameAt(s), wall = side > 0 ? f.wallR : f.wallL;
    const lat = side * (wall + T / 2);
    bucket.push(box(w, h, T, f.x + f.right.x * lat, f.y + y + h / 2, f.z + f.right.z * lat, color, f.yaw + Math.PI / 2));
  }
}

// Roof slab over a stretch of road at H (+ cross beams).
export function hallRoof(ctx, bucket, s0, s1, H, { T = 1.6, color = C.slate, beam = C.wood, beams = 8 } = {}) {
  const { track } = ctx;
  const sl = sRange(s0, s1, 2);
  // underside (faces down: columns right -> left)
  bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => { o.lat = c ? -(f.wallL + T) : f.wallR + T; o.dy = H; o.u = s / 4; o.v = o.lat / 4; }), mixHex(color, 0x000000, 0.3)));
  bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => { o.lat = c ? f.wallR + T + 0.4 : -(f.wallL + T + 0.4); o.dy = H + 1.2; o.u = s / 4; o.v = o.lat / 4; }), color));
  for (let s = s0 + 3; s < s1 - 1; s += beams) {
    const f = track.frameAt(s), W = f.wallL + f.wallR + T * 2, latC = (f.wallR - f.wallL) / 2;
    bucket.push(box(W, 0.8, 0.7, f.x + f.right.x * latC, f.y + H - 0.4, f.z + f.right.z * latC, beam, f.yaw));
  }
}

// A round castle tower (stone shaft, crenellated top, optional cone roof).
export function roundTower(parts, x, g, z, r, h, { roof = true, color = C.stone, roofCol = C.slate, seg = 12 } = {}) {
  parts.push(cyl(r, r * 1.08, h, seg, x, g + h / 2, z, color));
  parts.push(cyl(r * 1.12, r * 1.12, 1.2, seg, x, g + h + 0.6, z, mixHex(color, 0x000000, 0.15)));
  const n = Math.max(6, Math.round(r * 2.2));
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    parts.push(box(0.9, 1.1, 0.7, x + Math.sin(a) * r * 1.05, g + h + 1.75, z + Math.cos(a) * r * 1.05, color, a));
  }
  if (roof) {
    parts.push(cone(r * 1.15, r * 1.9, seg, x, g + h + 1.2 + r * 0.95, z, roofCol));
    parts.push(ball(0.45, x, g + h + 1.3 + r * 1.9, z, C.gold));
  }
}
export function squareTower(parts, x, g, z, w, h, yaw, { color = C.stone, roof = true, roofCol = C.slate } = {}) {
  parts.push(box(w, h, w, x, g + h / 2, z, color, yaw));
  parts.push(box(w + 0.8, 1.0, w + 0.8, x, g + h + 0.5, z, mixHex(color, 0x000000, 0.15), yaw));
  const n = Math.max(3, Math.round(w / 2.2));
  for (let side = 0; side < 4; side++) {
    const a = yaw + side * Math.PI / 2, nx = Math.sin(a), nz = Math.cos(a), tx = Math.cos(a), tz = -Math.sin(a);
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n - 0.5;
      parts.push(box(1.0, 1.1, 0.7, x + nx * (w / 2 + 0.1) + tx * t * w, g + h + 1.55, z + nz * (w / 2 + 0.1) + tz * t * w, color, a));
    }
  }
  if (roof) {
    parts.push(paint(place(new THREE.ConeGeometry(w * 0.78, w * 1.1, 4), x, g + h + 1.0 + w * 0.55, z, yaw + Math.PI / 4), roofCol));
    parts.push(ball(0.5, x, g + h + 1.1 + w * 1.1, z, C.gold));
  }
}

// Lava falls: ribbons from (x, top, z) down to the lava, hugging a face that
// looks along (nx, nz); width w. Scrolling lava texture (falls material).
export function lavaFall(list, x, z, top, bottom, nx, nz, w) {
  const tx = -nz, tz = nx;
  const g = new THREE.BufferGeometry();
  const P = [], U = [];
  const rows = 6;
  for (let r = 0; r <= rows; r++) {
    const t = r / rows, y = lerp(top, bottom, t), out = 0.4 + t * 1.6;
    for (const sx of [-1, 1]) {
      P.push(x + tx * sx * w / 2 * (1 + t * 0.3) + nx * out, y, z + tz * sx * w / 2 * (1 + t * 0.3) + nz * out);
      U.push(sx > 0 ? 1 : 0, (top - y) / 6);
    }
  }
  const idx = [];
  for (let r = 0; r < rows; r++) { const a = r * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  list.push(g);
}

// A wall torch: iron bracket on the wall, a flame (glow) on top.
export function torch(parts, glow, x, y, z, yaw, groundY = null) {
  parts.push(box(0.16, 0.5, 0.5, x, y - 0.25, z, C.iron, yaw));
  parts.push(cyl(0.22, 0.12, 0.5, 6, x, y + 0.15, z, C.ironLight));
  glow.push(paint(place(new THREE.ConeGeometry(0.34, 1.1, 6), x, y + 0.85, z), C.flame));
  glow.push(paint(place(new THREE.ConeGeometry(0.2, 0.75, 6), x, y + 0.72, z), C.flameHot));
  if (glow.splats) {
    // light pool on the wall behind the flame and on the ground below it
    glow.splats.push(place(new THREE.PlaneGeometry(5.5, 6.5), x, y + 0.6, z, yaw));
    if (groundY !== null) glow.splats.push(place(new THREE.PlaneGeometry(7, 7).rotateX(-Math.PI / 2), x, groundY + 0.06, z));
  }
}

// Hanging crowned-K banner (texture quad, both faces) at a point, facing yaw.
export function banner(emblems, x, y, z, yaw, w = 2.4, h = 4.8) {
  const g = new THREE.PlaneGeometry(w, h);
  place(g, x, y, z, yaw);
  emblems.banner.push(g);
}

// Box UVs in world metres / tile (for the stone block texture).
export function worldUVBox(geo, tile) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
    if (ay > 0.7) uv.setXY(i, x / tile, z / tile);
    else if (ax > 0.7) uv.setXY(i, z / tile, y / tile);
    else uv.setXY(i, x / tile, y / tile);
  }
  return geo;
}

export function rectCorners(x, z, yaw, hw, hd) {
  const c = Math.cos(yaw), s = Math.sin(yaw), out = [];
  for (const [u, v] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [0, -hd], [0, hd], [-hw, 0], [hw, 0]]) out.push([x + c * u + s * v, z - s * u + c * v]);
  return out;
}

