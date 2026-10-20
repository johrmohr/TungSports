// Krishiv's Palace v5 rooms (browser only, SPEC §16.1, notes/v5-track-palace.md):
// the static architecture of the forge wing (the Forge hall with furnaces,
// chimneys and the crucible on its overhead rail; the Anvil courtyard with
// the giant anvil and the trip hammer; the arched Lavafall Tunnel with its
// ceiling slots and floor grates), the vaulted Banquet Hall (raised feast
// daises with long tables, stained glass, pivot beams for the chandeliers)
// and the Portcullis Run (two gate arches, hazard lines). The moving set
// pieces themselves are drawn by world-palace-setpieces.js.
//
// Every builder takes the palace build context P = { ctx, track, field, L,
// B (region buckets: stone, lavaStone, struct, roof), glow, falls, fires,
// smoke, emblems, decals { plates, grates, marble, hazard }, windows, M, T }
// and returns animators / info where it has any. Geometry is merged into the
// shared buckets (draw calls stay within the §16.1 budget).

import * as THREE from 'three';
import { lerp, smoothstep, makeRng } from './utils.js';
import {
  place, paint, mixHex, trackStrip, sRange, box, cyl, ball, mergeParts, roadDecal, segIndex, arcCenter,
} from './world.js';
import { C, LAVA, hallWall, merlons, hallRoof, squareTower, banner, torch, lavaFall, worldUVBox } from './world-palace-kit.js';
import { PALACE_SOUNDS } from './world-palace-sounds.js';
import { bus } from './bus.js';

export const FORGE_H = 12;        // Forge hall ceiling above the road
export const TUNNEL_H = 10;       // Lavafall Tunnel ceiling
export const BANQUET_H = 22;      // Banquet Hall vault (the chandelier pivots hang at 20 m)
export const DAIS = 7;            // banquet dais depth beyond the wall line (m)
export const GATE_BEAM = [6.9, 12.9];   // portcullis arch beam, bottom / top above the road

const zoneRange = (track, z) => [z.s0, z.s0 + track.forwardDistance(z.s0, z.s1)];
const wallAt = (f, side) => (side > 0 ? f.wallR : f.wallL);

// A wall whose inner face is at lat(f) (side ±1), from `base` to `H` above the
// road, its top and its outer face down to `bottom` (absolute y).
function sideWall(ctx, bucket, s0, s1, side, lat, { H, base = 1.15, T = 1.6, bottom = -4, color = C.stone, step = 2 }) {
  const { track } = ctx;
  const sl = sRange(s0, s1, step);
  const uv = (o, s, y) => { o.u = s / 4; o.v = y / 4; };
  bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
    const upper = side > 0 ? c === 1 : c === 0;
    o.lat = side * lat(f); o.dy = upper ? H : base; uv(o, s, o.dy);
  }), color));
  bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
    const outer = side > 0 ? c === 1 : c === 0;
    o.lat = side * (lat(f) + (outer ? T : 0)); o.dy = H; uv(o, s, o.lat);
  }), mixHex(color, 0x000000, 0.15)));
  bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
    const upper = side > 0 ? c === 0 : c === 1;
    o.lat = side * (lat(f) + T);
    if (upper) { o.dy = H; uv(o, s, f.y + H); } else { o.y = bottom; o.dy = 0; uv(o, s, bottom); }
  }), mixHex(color, 0x000000, 0.1)));
}

// A flat floor strip between lat a(f) and b(f) (a < b) at `dy` above the road.
function floorStrip(ctx, bucket, s0, s1, a, b, dy, color, tile = 4) {
  bucket.push(paint(trackStrip(ctx.track, sRange(s0, s1, 2), 2, (f, s, c, o) => {
    o.lat = c ? b(f) : a(f); o.dy = dy; o.u = o.lat / tile; o.v = s / tile;
  }), color));
}

// A lava trickle hugging a wall face (falls material: v scrolls), from y0 up to y1, facing yaw.
function wallTrickle(x, z, y0, y1, yaw, w) {
  const h = y1 - y0;
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * h / 6);
  return paint(place(g, x, y0 + h / 2, z, yaw), null);
}

// A pitched roof over the corridor: eaves `eave` m above the road at lateral
// -halfL(f) / +halfR(f), the ridge `rise` m higher over the centre line,
// gable triangles at both ends (bucket: merged, painted).
function pitchedRoof(ctx, bucket, s0, s1, eave, rise, halfL, halfR, color, gable = color) {
  const { track } = ctx;
  const sl = sRange(s0, s1, 2);
  const mid = (f) => (halfR(f) - halfL(f)) / 2;
  bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => { o.lat = c ? mid(f) : -halfL(f); o.dy = c ? eave + rise : eave; o.u = s / 4; o.v = o.lat / 4; }), color));
  bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => { o.lat = c ? halfR(f) : mid(f); o.dy = c ? eave : eave + rise; o.u = s / 4; o.v = o.lat / 4; }), mixHex(color, 0x000000, 0.18)));
  for (const [s, dir] of [[s0, -1], [s1, 1]]) {
    const f = track.frameAt(s);
    const P = (lat, dy) => [f.x + f.right.x * lat, f.y + dy, f.z + f.right.z * lat];
    const a = P(-halfL(f), eave), b = P(halfR(f), eave), c = P(mid(f), eave + rise);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(dir > 0 ? [...a, ...b, ...c] : [...b, ...a, ...c], 3));
    g.computeVertexNormals();
    bucket.push(paint(g, gable));
  }
}

// Lava spouts on the outer face of a hall wall (side ±1), pouring into the lava below.
function outerFalls(P, s0, s1, side, top, n) {
  const { track, B, falls, glow } = P;
  for (let k = 0; k < n; k++) {
    const s = s0 + ((k + 0.5) / n) * (s1 - s0), f = track.frameAt(s);
    const w = wallAt(f, side) + 1.6 + 0.05;
    const x = f.x + f.right.x * side * w, z = f.z + f.right.z * side * w;
    lavaFall(falls, x, z, f.y + top, LAVA - 0.3, f.right.x * side, f.right.z * side, 2.6 + (k % 2));
    B.struct.push(box(2.4, 1.4, 1.2, x + f.right.x * side * 0.5, f.y + top + 0.2, z + f.right.z * side * 0.5, C.goldDark, f.yaw));
    glow.push(paint(place(new THREE.CircleGeometry(1.0, 10), x + f.right.x * side * 1.12, f.y + top + 0.1, z + f.right.z * side * 1.12, Math.atan2(f.right.x * side, f.right.z * side)), C.lavaGlow));
  }
}

// A lintel (end wall over the road) at s, spanning the corridor between y0 and y1 above the road.
function lintel(ctx, bucket, s, y0, y1, { depth = 2, extra = 1.6, color = C.stone } = {}) {
  const f = ctx.track.frameAt(s);
  const W = f.wallL + f.wallR + extra * 2, latC = (f.wallR - f.wallL) / 2;
  const g = box(W, y1 - y0, depth, f.x + f.right.x * latC, f.y + (y0 + y1) / 2, f.z + f.right.z * latC, color, f.yaw);
  worldUVBox(g, 4);
  bucket.push(g);
}

// ------------------------------------------------------------------ the Forge

/**
 * The Forge hall (zone 'forge'): lava-cracked basalt walls, a slate roof, a
 * lintel at each end, furnaces along both walls (glowing mouths, flames, light
 * pools), chimney stacks with smoke, iron floor plates (wall to wall, except
 * the conveyor belts), and the crucible gliding on its rail overhead.
 * Returns an animator for the crucible.
 */
export function buildForge(P, hz) {
  const { ctx, track, L, B, glow, fires, smoke, decals } = P;
  const z = (L.Z.forge || [])[0];
  if (!z) return null;
  const [s0, s1] = zoneRange(track, z);
  for (const side of [-1, 1]) hallWall(ctx, B.lavaStone, s0, s1, side, { H: FORGE_H + 1, bottom: -3, color: 0xb4acb4 });
  hallRoof(ctx, B.roof, s0, s1, FORGE_H, { beams: 7, color: 0x2a2630, beam: C.iron });
  // the pitched slate roof and a glowing lantern (vent) along its ridge
  const eave = FORGE_H + 1.25, rise = 5;
  pitchedRoof(ctx, B.roof, s0, s1, eave, rise, (f) => f.wallL + 2.3, (f) => f.wallR + 2.3, 0x3a3240, 0x2e2834);
  const lr0 = s0 + 6, lr1 = s1 - 6, lsl = sRange(lr0, lr1, 2), ridge = eave + rise;
  glow.push(paint(trackStrip(track, lsl, 2, (f, s, c, o) => { o.lat = -1.6; o.dy = c ? ridge + 1.4 : ridge - 0.3; }), C.lavaGlow));     // faces left
  glow.push(paint(trackStrip(track, lsl, 2, (f, s, c, o) => { o.lat = 1.6; o.dy = c ? ridge - 0.3 : ridge + 1.4; }), C.lavaGlow));      // faces right
  B.roof.push(paint(trackStrip(track, lsl, 2, (f, s, c, o) => { o.lat = c ? 2.4 : -2.4; o.dy = ridge + 1.5; }), 0x2a2430));
  for (let s = lr0; s <= lr1 + 0.01; s += 4) { const f = track.frameAt(s); B.struct.push(box(3.6, 1.8, 0.3, f.x, f.y + ridge + 0.6, f.z, C.iron, f.yaw)); }
  lintel(ctx, B.lavaStone, s0 + 1, FORGE_H - 3.5, FORGE_H + 1);
  lintel(ctx, B.lavaStone, s1 - 1, FORGE_H - 3.5, FORGE_H + 1);
  const fs = L.seg('The Forge');
  if (fs) outerFalls(P, fs.s0 + 4, fs.s1 - 4, 1, FORGE_H - 2.5, 3);         // the outer (right) wall stands in the lava lake
  for (let s = s0; s <= s1; s += 16) {
    const f = track.frameAt(s);
    ctx.landmarks.push({ name: 'forgeRoof', x: f.x, z: f.z, r: Math.max(f.wallL, f.wallR) + 2, h: f.y + FORGE_H + 2 });
  }
  // the belts' stretch (iron plates elsewhere)
  const belts = hz.list.filter((h) => h.type === 'belt');
  const b0 = belts.length ? Math.min(...belts.map((h) => h.s)) : s1, b1 = belts.length ? Math.max(...belts.map((h) => h.s + h.len)) : s1;
  const plate = (a, b) => { if (b - a > 0.5) decals.plates.push(roadDecal(ctx, a, b, { latA: (f) => -(f.wallL + 0.5), latB: (f) => f.wallR + 0.5, tile: 4, uSpan: 4, dy: 0.013 })); };
  plate(s0, b0 - 1.2);
  plate(b1 + 1.2, s1);
  // furnaces in the walls (mouths face the road) + light pools on the floor
  const mouth = (() => {
    const sh = new THREE.Shape();
    sh.moveTo(-1.5, 0); sh.lineTo(1.5, 0); sh.lineTo(1.5, 1.9); sh.quadraticCurveTo(1.5, 3.1, 0, 3.2); sh.quadraticCurveTo(-1.5, 3.1, -1.5, 1.9); sh.closePath();
    return sh;
  })();
  let k = 0;
  for (let s = s0 + 10; s < s1 - 6; s += 13, k++) {
    const f = track.frameAt(s);
    for (const side of [-1, 1]) {
      if ((k + (side > 0 ? 1 : 0)) % 2) continue;             // alternate sides
      const w = wallAt(f, side), inward = f.yaw + (side > 0 ? Math.PI / 2 : -Math.PI / 2);   // planes facing the road
      const at = (lat, along = 0) => ({ x: f.x + f.right.x * side * lat + f.tangent.x * along, z: f.z + f.right.z * side * lat + f.tangent.z * along });
      const m = at(w - 0.07);
      glow.push(paint(place(new THREE.ShapeGeometry(mouth, 6), m.x, f.y + 1.3, m.z, inward), C.lavaGlow));
      const m2 = at(w - 0.1);
      glow.push(paint(place(new THREE.PlaneGeometry(2.0, 1.2), m2.x, f.y + 1.95, m2.z, inward), C.flameHot));
      // brick hood + iron door frame
      const hd = at(w - 0.25);
      B.struct.push(box(4.4, 0.7, 0.5, hd.x, f.y + 4.9, hd.z, C.stoneDark, inward));
      for (const a of [-1.75, 1.75]) { const q = at(w - 0.18, a); B.struct.push(box(0.35, 3.6, 0.36, q.x, f.y + 3.0, q.z, C.iron, inward)); }
      const sill = at(w - 0.3);
      B.struct.push(box(3.8, 0.3, 0.6, sill.x, f.y + 1.25, sill.z, C.iron, inward));
      const fl = at(w - 0.55);
      fires.push({ x: fl.x, y: f.y + 1.55, z: fl.z, s: 0.55 });
      if (glow.splats) {
        const pool = at(w - 3.2);
        glow.splats.push(place(new THREE.PlaneGeometry(7, 7).rotateX(-Math.PI / 2), pool.x, f.y + 0.07, pool.z));
      }
      // chimney stack above the roof
      if (k % 3 === 0) {
        const ch = at(w + 1.6);
        const g = box(3, 9, 3, ch.x, f.y + FORGE_H + 1 + 4.5, ch.z, C.basalt, f.yaw);
        worldUVBox(g, 4); B.lavaStone.push(g);
        B.struct.push(box(3.6, 0.6, 3.6, ch.x, f.y + FORGE_H + 10.2, ch.z, C.iron, f.yaw));
        glow.push(paint(place(new THREE.PlaneGeometry(2.4, 2.4).rotateX(-Math.PI / 2), ch.x, f.y + FORGE_H + 10.55, ch.z), C.ember));
        smoke.push([ch.x, f.y + FORGE_H + 11, ch.z, 1.6, 0.6]);
      }
    }
  }
  // wall torches between the furnaces
  for (let s = s0 + 16.5, j = 0; s < s1 - 6; s += 13, j++) {
    const f = track.frameAt(s);
    for (const side of [-1, 1]) {
      if ((j + (side > 0 ? 0 : 1)) % 2) continue;
      const w = wallAt(f, side) - 0.3, x = f.x + f.right.x * side * w, zz = f.z + f.right.z * side * w;
      torch(B.struct, glow, x, f.y + 4.4, zz, f.yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2), f.y);
    }
  }
  // hanging chains and hooks between the roof beams
  for (let s = s0 + 7; s < s1 - 4; s += 9) {
    const f = track.frameAt(s);
    for (const lat of [-7.5, 7.5]) {
      const x = f.x + f.right.x * lat, zz = f.z + f.right.z * lat, len = 3 + ((s * 7) % 3);
      B.struct.push(cyl(0.06, 0.06, len, 4, x, f.y + FORGE_H - len / 2, zz, C.ironLight));
      B.struct.push(paint(new THREE.TorusGeometry(0.35, 0.08, 4, 8, Math.PI * 1.4).rotateZ(Math.PI * 0.8).translate(x, f.y + FORGE_H - len - 0.3, zz), C.ironLight));
    }
  }
  // the crucible: a trolley on a rail under the roof (rail = an I-beam along
  // the hall's centre line), carrying a glowing bucket back and forth
  const r0 = Math.max(s0 + 4, b0 - 8), r1 = Math.min(s1 - 4, b1 + 8);
  B.struct.push(paint(trackStrip(track, sRange(r0, r1, 2), 2, (f, s, c, o) => { o.lat = c ? 0.5 : -0.5; o.dy = FORGE_H - 1.0; }), C.iron));
  B.struct.push(paint(trackStrip(track, sRange(r0, r1, 2), 2, (f, s, c, o) => { o.lat = c ? -0.5 : 0.5; o.dy = FORGE_H - 1.0; }), C.iron));
  const parts = [
    box(2.2, 0.8, 1.6, 0, -0.6, 0, C.iron),                                              // trolley
    cyl(0.08, 0.08, 3.2, 4, -0.7, -2.6, 0, C.ironLight), cyl(0.08, 0.08, 3.2, 4, 0.7, -2.6, 0, C.ironLight),
    paint(new THREE.TorusGeometry(1.75, 0.12, 4, 14, Math.PI).rotateZ(Math.PI).translate(0, -3.9, 0), C.ironLight),   // bail
    cyl(1.75, 1.25, 2.4, 12, 0, -5.4, 0, 0x3a3a42),                                     // bucket
    cyl(1.85, 1.85, 0.25, 12, 0, -4.3, 0, C.goldDark),                                  // rim
  ];
  if (ctx.Q.veg < 1) { parts.forEach((g) => g.dispose()); return null; }      // 'low' (split screen): no crucible (2 draw calls)
  const crucible = new THREE.Mesh(mergeParts(parts), ctx.M.structure);
  const molten = new THREE.Mesh(paint(new THREE.CircleGeometry(1.62, 12).rotateX(-Math.PI / 2).translate(0, -4.25, 0), C.ember), P.M.glow);
  ctx.add(crucible, { cast: true, name: 'Crucible' });
  crucible.add(molten);
  const travel = track.forwardDistance(r0 + 3, r1 - 3);
  const pos = (t) => {
    const u = 0.5 - 0.5 * Math.cos((t / 22) * Math.PI * 2);                         // 22 s round trip, easing at the ends
    const f = track.frameAt(r0 + 3 + travel * u);
    crucible.position.set(f.x, f.y + FORGE_H - 0.6, f.z);
    crucible.rotation.y = f.yaw;
  };
  pos(0);
  ctx.landmarks.push({ name: 'forge', x: track.frameAt((s0 + s1) / 2).x, z: track.frameAt((s0 + s1) / 2).z, r: 20, h: FORGE_H + 12 });
  return (dt, t) => pos(t);
}

// ------------------------------------------------------------------ the Anvil

/**
 * The Anvil courtyard inside the Anvil Hairpin: a giant iron anvil on a stone
 * plinth, a hot billet on its face, and a water-driven trip hammer whose helve
 * pivots on a timber frame in the courtyard between the Forge and the Lavafall
 * Tunnel; it lifts and strikes every 2 s (sparks, a clang). Decoration only,
 * well beyond the walls. Returns an animator.
 */
export function buildAnvil(P) {
  const { ctx, track, L, B, glow, fires } = P;
  const idx = segIndex(track, 'Anvil Hairpin');
  const c = idx >= 0 ? arcCenter(track, idx) : null;
  const forge = L.seg('The Forge');
  if (!c || !forge) return null;
  const fF = track.frameAt(forge.s1 - 1);
  const ax = -fF.tangent.x, az = -fF.tangent.z;                // from the anvil into the courtyard (toward the hammer)
  const yaw = Math.atan2(ax, az);                              // local +z = toward the hammer
  const g0 = c.y - 0.6;
  const K = 1.45;                                              // a giant's anvil: everything below is drawn at K x
  const P0 = (lx, ly, lz) => ({ x: c.x + (Math.cos(yaw) * lx + Math.sin(yaw) * lz) * K, y: g0 + ly * K, z: c.z + (-Math.sin(yaw) * lx + Math.cos(yaw) * lz) * K });
  const parts = [];
  // plinth (stepped), anvil foot / waist / face / horn / heel
  parts.push(box(13, 1.6, 9, 0, 0.2, 0, C.stoneDark), box(11, 1.0, 7.4, 0, 1.5, 0, C.stone));
  parts.push(box(7.5, 1.2, 4.6, 0, 2.6, 0, C.iron), box(4.2, 2.0, 2.8, 0, 4.2, 0, C.iron));
  parts.push(box(9.4, 1.4, 3.8, 0.6, 5.9, 0, 0x45454e), box(9.6, 0.12, 3.9, 0.6, 6.65, 0, C.ironLight));
  parts.push(paint(place(new THREE.ConeGeometry(1.5, 4.6, 10), -6.3, 6.0, 0, 0, 0, Math.PI / 2), 0x45454e));
  parts.push(box(1.6, 1.0, 3.0, 5.6, 6.0, 0, 0x3a3a42));
  // trip-hammer frame: two timber posts + braces, axle bearings, the cam wheel at the tail
  const PZ = 12.5, PY = 9.6;
  for (const sx of [-2.6, 2.6]) {
    parts.push(box(1.0, PY + 1.2, 1.0, sx, (PY + 1.2) / 2 - 0.4, PZ, C.wood));
    parts.push(box(0.5, 6, 0.5, sx, 3.2, PZ + 2.2, C.wood, 0, -0.55));
    parts.push(box(0.5, 6, 0.5, sx, 3.2, PZ - 2.2, C.wood, 0, 0.55));
    parts.push(cyl(0.6, 0.6, 0.6, 8, sx, PY, PZ, C.iron, 0, 0, Math.PI / 2));
  }
  parts.push(cyl(3.2, 3.2, 0.7, 14, 0, 4.0, PZ + 5.6, C.wood, 0, 0, Math.PI / 2));
  parts.push(cyl(0.4, 0.4, 6.4, 6, 0, 4.0, PZ + 5.6, C.iron, 0, 0, Math.PI / 2));
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; parts.push(box(0.45, 2.6, 0.45, 0, 4.0 + Math.sin(a) * 3.3, PZ + 5.6 + Math.cos(a) * 3.3, C.iron, 0, -a)); }
  parts.push(box(1.6, 4.0, 1.4, 0, 2.0, PZ + 5.6, C.stoneDark));
  // a water trough (quench) beside the plinth, and a heap of hammered ingots
  parts.push(box(2.2, 1.2, 5, -5.0, 0.6, 8.0, C.wood), box(1.8, 0.1, 4.6, -5.0, 1.15, 8.0, 0x3a5a7a));
  for (let k = 0; k < 5; k++) parts.push(box(1.3, 0.35, 0.5, 6.5 + (k % 2) * 0.3, 0.2 + Math.floor(k / 2) * 0.36, 4 + (k % 3) * 0.6, 0x6a5a4a, k * 0.4));
  const geo = mergeParts(parts);
  place(geo, c.x, g0, c.z, yaw, 0, 0, K, K, K);
  B.struct.push(geo);
  // the hot billet on the face (glow) and a forge brazier next to the plinth
  const bl = P0(0, 6.75, 0);
  glow.push(paint(place(new THREE.BoxGeometry(2.4 * K, 0.5 * K, 1.6 * K), bl.x, bl.y, bl.z, yaw), C.ember));
  const br = P0(5.4, 1.0, 5.6);
  B.struct.push(cyl(0.9 * K, 1.3 * K, 2.0 * K, 10, br.x, g0 + 1.0 * K, br.z, C.iron));
  fires.push({ x: br.x, y: g0 + 2.4 * K, z: br.z, s: 1.0 * K });
  for (const [lx, lz, r] of [[0, 0, 7.5], [0, PZ, 3.2], [0, PZ + 5.6, 3.4], [-5.0, 8.0, 2.0]]) { const q = P0(lx, 0, lz); ctx.prop('anvil', q.x, q.z, r * K); }
  ctx.landmarks.push({ name: 'anvil', x: c.x, z: c.z, r: 9 * K, h: 14 * K });
  // the helve + head (moving), pivot-local: +z toward the anvil is -z here
  const hp = [
    box(1.0, 1.0, 16.5, 0, 0, -PZ / 2 + 1.8, C.wood),                                // helve: pivot → over the anvil, tail behind
    box(1.2, 0.3, 1.2, 0, 0.6, -PZ + 0.1, C.iron), box(1.25, 0.3, 1.25, 0, 0, -6, C.iron),   // iron bands
    box(2.6, 2.8, 2.6, 0, -1.2, -PZ, 0x2e2e34),                                        // head (rests on the billet)
    box(2.7, 0.3, 2.7, 0, 0.1, -PZ, C.ironLight), box(2.2, 0.25, 2.2, 0, -2.6, -PZ, C.ironLight),
    box(0.9, 0.9, 1.4, 0, 0, 4.2, C.iron),                                             // tail tappet
  ];
  const helve = new THREE.Mesh(mergeParts(hp), ctx.M.structure);
  const piv = P0(0, PY, PZ);
  helve.position.set(piv.x, piv.y, piv.z);
  helve.scale.setScalar(K);
  ctx.add(helve, { cast: true, name: 'TripHammer' });
  // sparks (one Points draw call, 'high' only): a burst from the billet at each strike
  const NS = ctx.Q.veg >= 1 ? 56 : 0;
  const sp = new Float32Array(NS * 3), vel = [];
  const rng = makeRng(77);
  for (let i = 0; i < NS; i++) {
    const a = rng() * Math.PI * 2, up = lerp(0.35, 1.0, rng()), v = lerp(5, 13, rng());
    vel.push([Math.cos(a) * v * (1 - up * 0.5), up * v, Math.sin(a) * v * (1 - up * 0.5), lerp(0.4, 0.9, rng())]);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  if (NS) {
    const sparks = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffb040, map: ctx.glowTex || null, size: 0.5, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true }));
    sparks.frustumCulled = false;
    ctx.add(sparks, { name: 'AnvilSparks' });
  }
  const PERIOD = 2.0, LIFT = 0.70, DROP = 0.76, MAXA = 0.40;
  const aOf = (p) => (p < LIFT ? MAXA * smoothstep(p / LIFT) : p < DROP ? MAXA * (1 - ((p - LIFT) / (DROP - LIFT)) ** 2) : 0);
  let lastStrike = null;
  const tmp = { x: 0, y: 0, z: 0 };
  const sndPos = { x: bl.x, y: bl.y, z: bl.z };
  return (dt, t) => {
    const x = t / PERIOD, p = x - Math.floor(x);
    helve.rotation.set(aOf(p), yaw, 0, 'YXZ');                                      // + = head up
    const tau = ((p - DROP + 1) % 1) * PERIOD;                                           // s since the last strike
    for (let i = 0; i < NS; i++) {
      const [vx, vy, vz, life] = vel[i];
      const tt = tau < life ? tau : -1;
      if (tt < 0) { sp[i * 3 + 1] = -999; continue; }
      tmp.x = bl.x + vx * tt; tmp.y = bl.y + 0.4 + vy * tt - 9 * tt * tt; tmp.z = bl.z + vz * tt;
      sp[i * 3] = tmp.x; sp[i * 3 + 1] = tmp.y; sp[i * 3 + 2] = tmp.z;
    }
    if (NS) sg.attributes.position.needsUpdate = true;
    const n = Math.floor(x - DROP);
    if (lastStrike === null) lastStrike = n;
    else if (n !== lastStrike) { lastStrike = n; bus.emit('item:sfx', { name: PALACE_SOUNDS.anvil, position: sndPos, volume: 0.9 }); }
  };
}

// ------------------------------------------------------------------ the Lavafall Tunnel

/**
 * The Lavafall Tunnel (zone 'lavafall'): lava-cracked walls, a low vault with
 * ribs (pilasters + beams), glowing ceiling slots over each lava curtain, iron
 * floor grates glowing beneath them, and lava trickling down the walls into
 * gutters.
 */
export function buildLavafallTunnel(P, hz) {
  const { ctx, track, L, B, glow, falls, decals } = P;
  const z = (L.Z.lavafall || [])[0];
  if (!z) return;
  const [s0, s1] = zoneRange(track, z);
  for (const side of [-1, 1]) hallWall(ctx, B.lavaStone, s0, s1, side, { H: TUNNEL_H + 1, bottom: -3, color: 0xb4acb4 });
  hallRoof(ctx, B.roof, s0, s1, TUNNEL_H, { beams: 100, color: 0x24202a });
  lintel(ctx, B.lavaStone, s0 + 1, TUNNEL_H - 3, TUNNEL_H + 1.4, { depth: 2.4 });
  lintel(ctx, B.lavaStone, s1 - 1, TUNNEL_H - 3, TUNNEL_H + 1.4, { depth: 2.4 });
  outerFalls(P, s0 + 6, s1 - 6, 1, TUNNEL_H - 1.5, 3);
  for (let s = s0; s <= s1; s += 16) {
    const f = track.frameAt(s);
    ctx.landmarks.push({ name: 'tunnelRoof', x: f.x, z: f.z, r: Math.max(f.wallL, f.wallR) + 2, h: f.y + TUNNEL_H + 2 });
  }
  const curtains = hz.list.filter((h) => h.type === 'curtain');
  const nearCurtain = (s) => curtains.some((h) => Math.abs(track.deltaS(h.s, s)) < 4);
  // ribs: pilasters + a heavy beam with corbels every 8 m (not over the slots)
  for (let s = s0 + 4; s < s1 - 2; s += 8) {
    if (nearCurtain(s)) continue;
    const f = track.frameAt(s);
    const W = f.wallL + f.wallR + 1.2, latC = (f.wallR - f.wallL) / 2;
    const bx = f.x + f.right.x * latC, bz = f.z + f.right.z * latC;
    B.struct.push(box(W, 1.3, 1.4, bx, f.y + TUNNEL_H - 0.65, bz, C.stoneDark, f.yaw));
    for (const side of [-1, 1]) {
      const w = wallAt(f, side), q = { x: f.x + f.right.x * side * (w + 0.3), z: f.z + f.right.z * side * (w + 0.3) };
      B.struct.push(box(1.4, TUNNEL_H - 1.15, 1.0, q.x, f.y + 1.15 + (TUNNEL_H - 1.15) / 2, q.z, C.stoneDark, f.yaw + Math.PI / 2));
      const cb = { x: f.x + f.right.x * side * (w - 0.6), z: f.z + f.right.z * side * (w - 0.6) };
      B.struct.push(box(1.3, 1.1, 1.2, cb.x, f.y + TUNNEL_H - 1.6, cb.z, C.stone, f.yaw, 0, side * 0.5));
    }
  }
  // ceiling slots (dark recess + glowing lips) and floor grates under every curtain
  for (const h of curtains) {
    const f = track.frameAt(h.s);
    const a = Math.max(h.latA, -(f.wallL + 0.4)), b = Math.min(h.latB, f.wallR + 0.4);
    const latC = (a + b) / 2, W = b - a;
    const q = { x: f.x + f.right.x * latC, z: f.z + f.right.z * latC };
    B.struct.push(box(W + 0.8, 0.5, 2.6, q.x, f.y + TUNNEL_H - 0.2, q.z, C.iron, f.yaw));
    glow.push(paint(place(new THREE.PlaneGeometry(W, 1.7).rotateX(Math.PI / 2), q.x, f.y + TUNNEL_H - 0.47, q.z, f.yaw), C.lavaGlow));
    for (const lip of [-1, 1]) {
      const l = { x: q.x + f.tangent.x * lip * 1.0, z: q.z + f.tangent.z * lip * 1.0 };
      glow.push(paint(place(new THREE.BoxGeometry(W, 0.12, 0.12), l.x, f.y + TUNNEL_H - 0.5, l.z, f.yaw), C.flame));
    }
    decals.grates.push(roadDecal(ctx, h.s - 1.6, h.s + 1.6, { latA: () => a, latB: () => b, tile: 3.2, uSpan: 3.2, dy: 0.014, step: 0.8 }));
  }
  // lava trickles down the walls into glowing gutters (offroad side), clear of the slots
  for (let s = s0 + 8; s < s1 - 6; s += 11) {
    if (nearCurtain(s)) continue;
    const f = track.frameAt(s);
    for (const side of [-1, 1]) {
      if (((s - s0) / 11 + (side > 0 ? 1 : 0)) % 2 < 1) continue;
      const w = wallAt(f, side), x = f.x + f.right.x * side * (w - 0.05), zz = f.z + f.right.z * side * (w - 0.05);
      falls.push(wallTrickle(x, zz, f.y + 0.1, f.y + TUNNEL_H - 1.4, f.yaw + (side > 0 ? Math.PI / 2 : -Math.PI / 2), 1.3));
      const gq = { x: f.x + f.right.x * side * (w - 0.6), z: f.z + f.right.z * side * (w - 0.6) };
      glow.push(paint(place(new THREE.PlaneGeometry(2.6, 1.1).rotateX(-Math.PI / 2), gq.x, f.y + 0.05, gq.z, f.yaw + Math.PI / 2), C.lavaGlow));
    }
  }
}

// ------------------------------------------------------------------ the Banquet Hall

/**
 * The Banquet Hall (zone 'banquet'): a vaulted hall whose side walls stand
 * DAIS m beyond the barriers; between them, raised feast daises with long
 * tables (cloths, benches, candelabra, goblets), stained-glass windows high
 * on the walls, crowned-K banners, a marble floor (wall to wall) and the
 * pivot beams the chandeliers swing from. Returns the hall's [s0, s1].
 */
export function buildBanquetHall(P, hz) {
  const { ctx, track, L, B, glow, emblems, decals, windows } = P;
  const z = (L.Z.banquet || [])[0];
  if (!z) return null;
  const [s0, s1] = zoneRange(track, z);
  const H = BANQUET_H;
  for (const side of [-1, 1]) {
    // dais top (stone) and the hall wall beyond it
    floorStrip(ctx, B.stone, s0, s1, (f) => (side > 0 ? f.wallR + 0.45 : -(f.wallL + DAIS)), (f) => (side > 0 ? f.wallR + DAIS : -(f.wallL + 0.45)), 1.15, C.stoneWarm);
    sideWall(ctx, B.stone, s0, s1, side, (f) => wallAt(f, side) + DAIS, { H: H + 1, base: 1.15, bottom: -3 });
  }
  pitchedRoof(ctx, B.roof, s0, s1, H + 1.45, 8, (f) => f.wallL + DAIS + 2.2, (f) => f.wallR + DAIS + 2.2, 0x4a2a30, C.stone);
  // the vault: underside + top slab, transverse ribs every 8 m
  const sl = sRange(s0, s1, 2), T0 = 1.6;
  B.roof.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => { o.lat = c ? -(f.wallL + DAIS + T0) : f.wallR + DAIS + T0; o.dy = H; }), 0x2a2432));
  B.roof.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => { o.lat = c ? f.wallR + DAIS + T0 + 0.4 : -(f.wallL + DAIS + T0 + 0.4); o.dy = H + 1.4; }), C.slate));
  for (let s = s0 + 4; s < s1 - 2; s += 8) {
    const f = track.frameAt(s), W = f.wallL + f.wallR + 2 * DAIS + 2 * T0, latC = (f.wallR - f.wallL) / 2;
    B.struct.push(box(W, 1.1, 0.9, f.x + f.right.x * latC, f.y + H - 0.55, f.z + f.right.z * latC, C.wood, f.yaw));
    ctx.landmarks.push({ name: 'banquetRoof', x: f.x, z: f.z, r: Math.max(f.wallL, f.wallR) + DAIS, h: f.y + H + 2 });
  }
  lintel(ctx, B.stone, s0 + 1, 10, H + 1.4, { depth: 2.4, extra: DAIS + T0 });
  lintel(ctx, B.stone, s1 - 1, 10, H + 1.4, { depth: 2.4, extra: DAIS + T0 });
  {
    // the crowned-K shield over the entrance, facing the karts coming off the Geyser Stairs
    const f = track.frameAt(s0 + 1), latC = (f.wallR - f.wallL) / 2;
    const g = new THREE.PlaneGeometry(5.2, 6.0);
    place(g, f.x + f.right.x * latC - f.tangent.x * 1.27, f.y + 16.2, f.z + f.right.z * latC - f.tangent.z * 1.27, f.yaw + Math.PI);
    emblems.shield.push(g);
    for (const side of [-1, 1]) banner(emblems, f.x + f.right.x * (latC + side * 7) - f.tangent.x * 1.25, f.y + 16, f.z + f.right.z * (latC + side * 7) - f.tangent.z * 1.25, f.yaw + Math.PI, 2.4, 4.8);
  }
  // stained-glass windows + banners on the inner faces of the hall walls
  let k = 0;
  for (let s = s0 + 6; s < s1 - 4; s += 7, k++) {
    const f = track.frameAt(s);
    for (const side of [-1, 1]) {
      const w = wallAt(f, side) + DAIS - 0.06, inward = f.yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2), face = inward + Math.PI;
      const q = { x: f.x + f.right.x * side * w, z: f.z + f.right.z * side * w };
      if (k % 2 === 0) {
        windows.push(paint(place(new THREE.PlaneGeometry(3.2, 6.4), q.x, f.y + 13.2, q.z, face), null));
        B.struct.push(box(3.9, 0.4, 0.4, q.x, f.y + 9.9, q.z, C.stoneDark, face));
        if (glow.splats) {
          // coloured light falling across the dais
          const d = { x: f.x + f.right.x * side * (w - 3.4), z: f.z + f.right.z * side * (w - 3.4) };
          glow.splats.push(place(new THREE.PlaneGeometry(4.5, 5).rotateX(-Math.PI / 2), d.x, f.y + 1.2, d.z, f.yaw));
        }
      } else banner(emblems, q.x - f.right.x * side * 0.05, f.y + 12.5, q.z - f.right.z * side * 0.05, inward + Math.PI, 2.6, 5.2);
    }
  }
  // the feast tables along the hall straight (two per side, a gap in the middle)
  const hall = L.seg('Banquet Hall');
  if (hall) {
    const len = hall.s1 - hall.s0, mid = (hall.s0 + hall.s1) / 2, fm = track.frameAt(mid);
    for (const side of [-1, 1]) {
      for (const half of [-1, 1]) {
        const tl = len / 2 - 6, sc = mid + half * (tl / 2 + 2.2);
        const f = track.frameAt(sc);
        const lat = side * (wallAt(f, side) + DAIS * 0.5);
        const at = (dl, along = 0) => ({ x: f.x + f.right.x * (lat + side * dl) + f.tangent.x * along, z: f.z + f.right.z * (lat + side * dl) + f.tangent.z * along });
        const top = f.y + 1.15 + 0.95;
        const q = at(0);
        const parts = [
          box(1.9, 0.14, tl, 0, 0, 0, C.wood),
          box(2.05, 0.04, tl + 0.1, 0, 0.09, 0, 0xe8e0cc),                                  // cloth
          box(0.7, 0.05, tl + 0.12, 0, 0.12, 0, C.carpet),                                  // runner
        ];
        for (const a of [-tl / 2 + 0.6, -tl / 6, tl / 6, tl / 2 - 0.6]) for (const sx of [-0.75, 0.75]) parts.push(box(0.16, 0.95, 0.16, sx, -0.5, a, C.wood));
        for (const sx of [-1.55, 1.55]) parts.push(box(0.55, 0.12, tl - 1, sx, -0.5, 0, C.wood), box(0.12, 0.45, tl - 1, sx, -0.75, 0, C.wood));
        for (let a = -tl / 2 + 1; ctx.Q.veg >= 1 && a < tl / 2 - 0.5; a += 1.25) {
          for (const sx of [-0.55, 0.55]) {
            parts.push(cyl(0.09, 0.05, 0.28, 6, sx, 0.28, a, C.gold), cyl(0.2, 0.2, 0.03, 8, sx * 1.15, 0.13, a + 0.35, 0xf2ead8));
          }
        }
        for (let a = -tl / 2 + 2.5; a < tl / 2 - 1; a += 5) {
          parts.push(cyl(0.05, 0.12, 0.9, 6, 0, 0.55, a, C.gold), box(0.9, 0.06, 0.06, 0, 0.98, a, C.gold));
          for (const cx of [-0.42, 0, 0.42]) {
            parts.push(cyl(0.05, 0.05, 0.3, 5, cx, 1.15, a, 0xf2ead0));
            const fl = { x: q.x + f.right.x * (-cx) + f.tangent.x * a, z: q.z + f.right.z * (-cx) + f.tangent.z * a };
            glow.push(paint(place(new THREE.ConeGeometry(0.07, 0.24, 5), fl.x, top + 1.42, fl.z), C.flameHot));
          }
          // roast on a platter
          parts.push(cyl(0.45, 0.45, 0.04, 10, 0, 0.13, a + 2.5, C.goldDark), ball(0.32, 0, 0.32, a + 2.5, 0x8a4a22, 1.4, 0.8, 1));
        }
        const geo = mergeParts(parts);
        place(geo, q.x, top, q.z, f.yaw);
        B.struct.push(geo);
      }
    }
    ctx.landmarks.push({ name: 'banquet', x: fm.x, z: fm.z, r: fm.wallL + DAIS + 2, h: fm.y + H + 2 });
  }
  // pivot beams (the chandeliers' swing axles) across the hall + gold trim
  for (const h of hz.list.filter((x) => x.type === 'chandelier')) {
    const f = track.frameAt(h.s), W = f.wallL + f.wallR + 2 * DAIS + 2 * T0, latC = (f.wallR - f.wallL) / 2;
    const bx = f.x + f.right.x * latC, bz = f.z + f.right.z * latC;
    B.struct.push(box(W, 1.2, 1.3, bx, f.y + h.pivot + 0.6, bz, C.wood, f.yaw));
    B.struct.push(box(W + 0.1, 0.18, 1.4, bx, f.y + h.pivot + 0.05, bz, C.gold, f.yaw));
    const pv = { x: h.x, z: h.z };
    B.struct.push(cyl(0.45, 0.45, 1.6, 8, pv.x, f.y + h.pivot, pv.z, C.iron, f.yaw, Math.PI / 2));
  }
  decals.marble.push(roadDecal(ctx, s0, s1, { latA: (f) => -(f.wallL + 0.5), latB: (f) => f.wallR + 0.5, tile: 4, uSpan: 4, dy: 0.013 }));
  return [s0, s1];
}

// ------------------------------------------------------------------ the Portcullis Run

/**
 * The Portcullis Run (zone 'portcullis'): crenellated curtain walls along the
 * run, and for every gate a stone arch (two square towers beyond the walls, a
 * deep beam over the road with the leaves' slot, winch drums on top), plus a
 * yellow / black hazard line on the floor under the gate. Returns the gates
 * [{ s, f }] (for the leaf views).
 */
export function buildPortcullisRun(P, hz) {
  const { ctx, track, L, B, decals } = P;
  const z = (L.Z.portcullis || [])[0];
  const leaves = hz.list.filter((h) => h.type === 'portcullis');
  if (!leaves.length) return [];
  if (z) {
    const [s0, s1] = zoneRange(track, z);
    for (const side of [-1, 1]) {
      hallWall(ctx, B.stone, s0, s1, side, { H: 7, bottom: -3 });
      merlons(ctx, B.struct, s0, s1, side, { y: 7, h: 1.3, w: 1.2, gap: 2.6, T: 1.6 });
    }
  }
  const gates = [];
  for (const h of leaves) if (!gates.some((g) => Math.abs(track.deltaS(g.s, h.s)) < 1)) gates.push({ s: h.s });
  const [yb, yt] = GATE_BEAM;
  for (const g of gates) {
    const f = track.frameAt(g.s);
    g.f = f;
    const parts = [];
    for (const side of [-1, 1]) {
      const lat = side * (wallAt(f, side) + 3.0);
      const x = f.x + f.right.x * lat, zz = f.z + f.right.z * lat;
      const gy = f.y - 3;
      squareTower(parts, x, gy, zz, 5.0, yt + 3 + 3.5, f.yaw, { roofCol: C.slate });
      ctx.prop('gateTower', x, zz, 2.9);
    }
    for (const p of parts) B.struct.push(p);
    const W = f.wallL + f.wallR + 6.0 + 1.0, latC = (f.wallR - f.wallL) / 2;
    const bx = f.x + f.right.x * latC, bz = f.z + f.right.z * latC;
    const beam = box(W, yt - yb, 3.2, bx, f.y + (yb + yt) / 2, bz, C.stone, f.yaw);
    worldUVBox(beam, 4);
    B.stone.push(beam);
    B.struct.push(box(W + 0.3, 0.35, 3.5, bx, f.y + yb + 0.2, bz, C.goldDark, f.yaw));            // trim
    B.struct.push(box(W - 6.5, 0.12, 0.5, bx, f.y + yb - 0.02, bz, 0x08060a, f.yaw));              // the slot
    for (let k = -3; k <= 3; k++) {                                                              // machicolations
      const q = { x: bx + f.right.x * k * 3.6, z: bz + f.right.z * k * 3.6 };
      B.struct.push(box(1.2, 1.4, 3.6, q.x, f.y + yt + 0.7, q.z, C.stoneDark, f.yaw));
    }
    for (const side of [-1, 1]) {                                                                // winch drums
      const q = { x: bx + f.right.x * side * 5.5 + f.tangent.x * 0.4, z: bz + f.right.z * side * 5.5 + f.tangent.z * 0.4 };
      B.struct.push(cyl(0.9, 0.9, 3.4, 10, q.x, f.y + yt + 1.0, q.z, C.wood, f.yaw + Math.PI / 2, 0, Math.PI / 2));
      B.struct.push(cyl(0.95, 0.95, 0.2, 10, q.x + f.right.x * 1.7, f.y + yt + 1.0, q.z + f.right.z * 1.7, C.iron, f.yaw + Math.PI / 2, 0, Math.PI / 2));
    }
    ctx.landmarks.push({ name: 'gateArch', x: bx, z: bz, r: W / 2, h: f.y + yt + 4 });
    // the crowned-K shield over the middle of the beam, facing the oncoming karts
    const sh = new THREE.PlaneGeometry(3.4, 3.9);
    place(sh, bx - f.tangent.x * 1.66, f.y + (yb + yt) / 2 + 0.9, bz - f.tangent.z * 1.66, f.yaw + Math.PI);
    P.emblems.shield.push(sh);
    decals.hazard.push(roadDecal(ctx, g.s - 0.55, g.s + 0.55, { latA: (ff) => -(ff.wallL + 0.5), latB: (ff) => ff.wallR + 0.5, tile: 1.1, uSpan: 1.6, dy: 0.015, step: 0.55 }));
  }
  return gates;
}
