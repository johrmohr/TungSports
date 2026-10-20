// World builder for "Monte Mozzarella" (browser only), the sunny Italian
// hill town of track 2. Dispatched by worlds.js for theme 'hilltown'.
//
//   import { buildWorld } from './worlds.js';
//   const world = buildWorld(scene, track, { renderer, quality: 'high' });
//   world.update(dt, focusPosition, camera);   // every frame
//   world.dispose();
//
// Same contract as world.js (Breezy Bay): { sun, hemi, root, update,
// dispose, getGroundHeight, landmarks, stats, quality, hazards }. Built from the
// shared world kit (world.js): road ribbon at physics height, curbs,
// off-road strips, barriers exactly at wallL / wallR, start line + grid,
// gantry, boost pads, kicker, turn signs, sky, follow shadow, clouds.
//
// What makes it Monte (counter-clockwise lap, v5 layout of 1438 m):
//   * the cobbled piazza (fan-pattern setts): start gantry with a giant
//     pizza and the "KRISHIV KART" banner, café umbrellas, lamp posts, the
//     fountain inside the Fontana Turn;
//   * Via Vespa: scooter traffic riding with the racers out of / into arched
//     alley passages (sottoportici), the scooter shop, scooter-lane marks;
//   * the gelato esses + Laundry Lane: terracotta-roofed pastel houses (one
//     town atlas: roof tiles, stucco, painted shuttered windows / doors /
//     shop fronts), laundry lines overhead, giant gelato cones;
//   * the switchback (Tornante Uno + Due) with roadside shrines, the striped
//     campanile on the summit;
//   * Piazza Alta: the dancing fountain jets in the paving, a church facade,
//     café tables, cypresses on the open edge;
//   * the Belvedere terrace (telescopes, benches), the two-tier stone
//     aqueduct across a green valley with a stream (slab deck, dash pad +
//     kicker);
//   * the Cheese Run: the hillside dairy with its chutes, cheese wheels
//     rolling across the road and on down the hill; vineyards and cypress rows;
//   * the covered Espresso Works (herringbone brick) with giant stovetop
//     coffee pots puffing steam, and the pizza oven glowing inside the final
//     turn; pictogram warning signs before every set piece;
//   * a hill town of houses inside the loop, rolling hills on the horizon.
// The set pieces (hazards/hilltown.js) are drawn by world-monte-setpieces.js
// from world.hazards (= createHazards(track)) at its clock; the extra canvas
// textures live in world-monte-textures.js. Landmark positions come from the
// track itself (arc centres, zones, hazards), so layout edits keep every
// prop in place.
//
// Quality 'low' (split-screen): no shadow map, coarser terrain, fewer
// houses / trees / vines / clouds. Budget at 'high': ≤ 120 draw calls,
// ≤ 280k triangles (static props merged per region, repeats instanced).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, clamp, lerp, smoothstep } from './utils.js';
import * as TX from './textures.js';
import * as MT from './world-monte-textures.js';
import * as SP from './world-monte-setpieces.js';
import { createHazards } from './hazards.js';
import { HILLTOWN_TUNE } from './hazards/hilltown.js';
import {
  createWorldContext, buildSky, buildLights, createTrackTextures, buildRoad, buildStartLine, buildWalls,
  buildBoostPads, buildRamps, buildTurnSigns, buildGantry, buildFlags, buildClouds, mountainGeometry, lumpy,
  addInstancedSet, finishWorld, createTerrainField, terrainGeometry, trackStrip, sRange, inZone, zoneInterior, regionBuckets,
  place, paint, faceColors, mixHex, place_m4, addMerged, fbm, hash2,
} from './world.js';

// ------------------------------------------------------------------ palette

const C = {
  skyTop: 0x3a90e8, skyHorizon: 0xd6eaf3, skyBottom: 0xd2e3e6,
  sun: 0xfff0d4, hemiSky: 0xdcebff, hemiGround: 0xa08f5e,
  grass: 0x86c24d, grassAlt: 0xa5cf56, grassDeep: 0x5fa944, grassDry: 0xd2c674, lush: 0x56ae49,
  rock: 0xd8c8a4, rockDark: 0xb3a081, soil: 0xb08c5a, farLand: 0x9fc06e,
  stone: 0xe9d9b8, stoneWarm: 0xdcc199, stoneDark: 0xb9a587,
  cream: 0xf6ecd6, trim: 0xfaf3e3,
  roofs: [0xc65a39, 0xb94f33, 0xd26c44, 0xab4830, 0xc76442],
  walls: [0xf3d3a0, 0xf2c3a0, 0xf7e3b3, 0xebb19b, 0xf4d1c6, 0xe0e3bc, 0xf7edd9, 0xeab584, 0xf1caa9, 0xf5dc8f],
  shutters: [0x3d7b4f, 0x2f6aa0, 0x6e8f3a, 0x8a5634, 0x4a8f8a],
  window: 0x2a3340, door: 0x6b4428,
  cypress: 0x2f6a3c, pine: 0x4f8a3e, olive: 0x93a862, vine: 0x5c9c3a, bush: 0x5aa847, trunk: 0x7a5232,
  water: 0x58c6e4, pot: 0xc9cdd4, potDark: 0x46403c, brick: 0xb44e31, brickDark: 0x8e3a24,
  bronze: 0xc0903a, towerA: 0xf5f0e4, towerB: 0x41705e, glow: 0xffa53a,
};

// Pick a palette entry from a hash.
const pickCol = (arr, h) => arr[Math.floor(h * arr.length) % arr.length];

// ------------------------------------------------------------------ layout from the track

// Centre of a turtle arc segment (inside of the turn).
function arcCenter(track, index) {
  const seg = track.def.segments[index], s = track.segments[index];
  const f = track.frameAt((s.s0 + s.s1) / 2);
  const side = seg.dir === 'left' ? -1 : 1;
  return { x: f.x + f.right.x * side * seg.radius, z: f.z + f.right.z * side * seg.radius, y: f.y, r: seg.radius };
}
const segIndex = (track, name) => track.def.segments.findIndex((sg) => sg.name === name);

// Everything world-monte needs to know about the layout, derived once.
function monteLayout(track) {
  const zones = {};
  for (const z of track.zones) (zones[z.type] = zones[z.type] || []).push(z);
  const center = (name, fallback) => { const i = segIndex(track, name); return i >= 0 ? arcCenter(track, i) : fallback; };
  const bridge = (zones.bridge || [])[0] || null;
  const f0 = track.frameAt(0);
  // Aqueduct valley: crosses the bridge at its middle, perpendicular to it.
  let valley = null;
  if (bridge) {
    const m = track.frameAt((bridge.s0 + bridge.s1) / 2);
    const len = track.forwardDistance(bridge.s0, bridge.s1);
    valley = { x: m.x, z: m.z, y: m.y, ax: m.right.x, az: m.right.z, nx: m.tangent.x, nz: m.tangent.z, half: len / 2 };
  }
  // Piazza Alta: the paved square on the inside (left) of the summit straight
  let alta = null;
  const ai = segIndex(track, 'Piazza Alta');
  if (ai >= 0) {
    const sg = track.segments[ai], fa = track.frameAt(sg.s0);
    alta = {
      s0: sg.s0, s1: sg.s1, y: fa.y, side: -1,
      x: fa.x, z: fa.z, tx: fa.tangent.x, tz: fa.tangent.z, rx: fa.right.x, rz: fa.right.z,
      a0: 2, a1: sg.s1 - sg.s0 - 3,                  // along the straight
      l0: fa.wallL + 0.6, l1: fa.wallL + 40,          // distance left of the centreline
    };
    alta.sC = (sg.s0 + sg.s1) / 2;
  }
  const seg = (name) => { const i = segIndex(track, name); return i >= 0 ? track.segments[i] : null; };
  return {
    zones, bridge, valley, alta,
    start: { x: f0.x, z: f0.z, tx: f0.tangent.x, tz: f0.tangent.z, rx: f0.right.x, rz: f0.right.z },
    fountain: center('Fontana Turn', null),
    tower: center('Campanile Curve', null),
    oven: center('Pizza Oven Turn', null),
    belvedere: seg('Belvedere Turn'),
    tornanti: ['Tornante Uno', 'Tornante Due'].map((n) => { const i = segIndex(track, n); return i >= 0 ? { seg: track.segments[i], dir: track.def.segments[i].dir } : null; }).filter(Boolean),
    tunnel: (zones.tunnel || [])[0] || null,
  };
}

// Piazza Alta paving in its own frame: 1 on the paving (+1 m), 0 beyond `blend` m.
function altaMask(A, x, z, blend = 8) {
  if (!A) return 0;
  const dx = x - A.x, dz = z - A.z;
  const a = dx * A.tx + dz * A.tz, l = -(dx * A.rx + dz * A.rz);       // l: metres LEFT of the centreline
  const ea = Math.max(A.a0 - a, a - A.a1, 0), el = Math.max(A.l0 - l, l - A.l1, 0);
  return 1 - smoothstep((Math.hypot(ea, el) - 1) / blend);
}

// Piazza paving footprint in the start frame: along the straight (a) and
// lateral (l, + = right of the driving direction = away from the loop).
const PIAZZA = { a0: -42, a1: 114, l0: -22, l1: 58 };
const FOUNTAIN_PLAZA_R = 13;

// ------------------------------------------------------------------ terrain

// Aqueduct valley: floor height and stream meander along the valley axis.
const valleyFloor = (V, along) => V.y - 13.8 - 0.035 * Math.max(0, along - 8);
const valleyMeander = (along) => Math.sin(along * 0.045) * 4;

// Natural ground of the hill town: a smooth surface through the road
// heights (so the town reads as one hill), the old town's crown inside the
// loop, land falling away outside it into rolling countryside, the green
// valley under the aqueduct (its floor descending away from the loop), a
// level patio for the pizza oven and the flat piazza. The track corridor
// itself is pinned / cut / filled by the kit (createTerrainField).
function monteNatural(track, L) {
  const step = 3, M = Math.floor(track.N / step);
  const sx = new Float64Array(M), sz = new Float64Array(M), sy = new Float64Array(M);
  for (let k = 0; k < M; k++) { const i = k * step; sx[k] = track.px[i]; sz[k] = track.pz[i]; sy[k] = track.py[i]; }
  // loop polygon (for "inside the loop")
  const PS = 6, PM = Math.floor(track.N / PS);
  const lx = new Float64Array(PM), lz = new Float64Array(PM);
  for (let k = 0; k < PM; k++) { lx[k] = track.px[k * PS]; lz[k] = track.pz[k * PS]; }
  const inside = (x, z) => {
    let inn = false;
    for (let i = 0, j = PM - 1; i < PM; j = i++) {
      if ((lz[i] > z) !== (lz[j] > z) && x < ((lx[j] - lx[i]) * (z - lz[i])) / (lz[j] - lz[i]) + lx[i]) inn = !inn;
    }
    return inn;
  };
  const b = track.bounds, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const st = L.start, V = L.valley, F = L.fountain, O = L.oven;
  // piazza mask: 1 on the paving (+1 m), 0 beyond 11 m
  // (short 3 m blend on the loop side, where a retaining wall holds the town's hill)
  const piazzaMask = (x, z) => {
    const dx = x - st.x, dz = z - st.z;
    const a = dx * st.tx + dz * st.tz, l = dx * st.rx + dz * st.rz;
    const ea = Math.max(PIAZZA.a0 - a, a - PIAZZA.a1, 0), el = Math.max(PIAZZA.l0 - l, l - PIAZZA.l1, 0);
    const blend = l < PIAZZA.l0 && ea === 0 ? 3 : 10;
    let m = 1 - smoothstep((Math.hypot(ea, el) - 1) / blend);
    if (F) m = Math.max(m, 1 - smoothstep((Math.hypot(x - F.x, z - F.z) - FOUNTAIN_PLAZA_R - 1) / 10));
    return Math.max(m, altaMask(L.alta, x, z));
  };
  const natural = (x, z) => {
    let sw = 0, sh = 0, dmin2 = Infinity;
    for (let k = 0; k < M; k++) {
      const dx = x - sx[k], dz = z - sz[k], d2 = dx * dx + dz * dz;
      const w = 1 / (d2 + 900);
      sw += w; sh += w * sy[k];
      if (d2 < dmin2) dmin2 = d2;
    }
    const dmin = Math.sqrt(dmin2);
    let h = sh / sw;
    if (inside(x, z)) {
      // the old town climbs a hill in the middle of the loop
      h += 7.5 * smoothstep((dmin - 6) / 50) + (fbm(x * 0.03, z * 0.03, 2) - 0.5) * 1.6 * smoothstep((dmin - 12) / 20);
    } else {
      // the town sits on a hill: land falls away, then rolling hills rise far out
      h -= Math.min(30, 0.1 * Math.max(0, dmin - 24));
      const rc = Math.hypot(x - cx, z - cz);
      const amp = 70 * smoothstep((rc - 330) / 700);
      h += amp * Math.max(0, fbm(x * 0.0045 + 2.3, z * 0.0045 - 5.1, 4) - 0.32) * 1.8;
      h += (fbm(x * 0.02, z * 0.02, 2) - 0.5) * 2.0 * smoothstep((dmin - 20) / 30);
    }
    // the aqueduct valley
    if (V) {
      const dx = x - V.x, dz = z - V.z;
      const along = dx * V.ax + dz * V.az;          // along the valley (+ = away from the loop)
      const across = dx * V.nx + dz * V.nz;         // along the bridge, from its middle
      const floor = valleyFloor(V, along);
      const rise = (h - floor) * smoothstep((Math.abs(across - valleyMeander(along)) - 8) / (V.half - 6));
      const wx = smoothstep((along + 70) / 50);     // fades out inside the loop
      h = lerp(h, Math.min(h, floor + rise), wx);
    }
    // a low patio for the pizza oven, level with the final turn
    if (O) {
      const w = 1 - smoothstep((Math.hypot(x - O.x, z - O.z) - 15) / 8);
      if (w > 0) h = lerp(h, O.y - 0.15, w);
    }
    // the flat piazza (paving sits at -0.06, terrain just under it)
    let pm = 0;
    {
      const dx = x - st.x, dz = z - st.z;
      const a = dx * st.tx + dz * st.tz, l = dx * st.rx + dz * st.rz;
      const ea = Math.max(PIAZZA.a0 - a, a - PIAZZA.a1, 0), el = Math.max(PIAZZA.l0 - l, l - PIAZZA.l1, 0);
      pm = 1 - smoothstep((Math.hypot(ea, el) - 1) / (l < PIAZZA.l0 && ea === 0 ? 3 : 10));
      if (F) pm = Math.max(pm, 1 - smoothstep((Math.hypot(x - F.x, z - F.z) - FOUNTAIN_PLAZA_R - 1) / 10));
    }
    if (pm > 0) h = lerp(h, -0.45, pm);
    // Piazza Alta on the summit (paving at the road height - 0.06)
    const am = altaMask(L.alta, x, z);
    if (am > 0) h = lerp(h, L.alta.y - 0.45, am);
    return h;
  };
  return { natural, inside, piazzaMask };
}

const FIELD = [0xe0c565, 0xc2d36a, 0x6fae4a, 0xb9b45c];   // wheat, young green, deep green, olive-gold

// Terrain colours: warm Tuscan greens with golden dry patches, lush valley
// floor, limestone on steep faces, browner soil under the vineyards.
function monteTerrainColor(track, L, vineyardAt, inside) {
  const cG = new THREE.Color(C.grass), cA = new THREE.Color(C.grassAlt), cD = new THREE.Color(C.grassDeep);
  const cDry = new THREE.Color(C.grassDry), cLush = new THREE.Color(C.lush), cSoil = new THREE.Color(C.soil);
  const cR = new THREE.Color(C.rock), cRD = new THREE.Color(C.rockDark), cFar = new THREE.Color(C.farLand);
  const tmp = new THREE.Color();
  const V = L.valley, b = track.bounds, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  return (c, x, z, h, slope) => {
    const n1 = fbm(x * 0.024, z * 0.024, 3), n2 = fbm(x * 0.007 + 4, z * 0.007 - 9, 3);
    c.copy(cG).lerp(cA, smoothstep((n1 - 0.35) / 0.35));
    c.lerp(cD, smoothstep((0.42 - n1) / 0.2) * 0.5);
    c.lerp(cDry, smoothstep((n2 - 0.58) / 0.14) * 0.6);
    if (V) {
      const along = (x - V.x) * V.ax + (z - V.z) * V.az, across = Math.abs((x - V.x) * V.nx + (z - V.z) * V.nz);
      const floor = valleyFloor(V, along);
      c.lerp(cLush, smoothstep((floor + 3.5 - h) / 3) * smoothstep((V.half + 10 - across) / 12) * 0.8);
    }
    // Tuscan patchwork: rotated field plots in greens, gold and olive
    if (!inside(x, z)) {
      const u = x * 0.81 + z * 0.59, v = -x * 0.59 + z * 0.81;
      const fi = Math.floor(u / 58), fj = Math.floor(v / 41);
      const hsh = hash2(fi, fj);
      const edge = Math.min(Math.abs(u / 58 - fi - 0.5), Math.abs(v / 41 - fj - 0.5));
      const plot = hsh < 0.22 ? FIELD[0] : hsh < 0.4 ? FIELD[1] : hsh < 0.55 ? FIELD[2] : hsh < 0.68 ? FIELD[3] : null;
      if (plot) c.lerp(tmp.set(plot), 0.62 * smoothstep((0.47 - edge) / 0.04));
    }
    const vy = vineyardAt(x, z);
    if (vy > 0) c.lerp(tmp.copy(cSoil).lerp(cA, 0.35 + 0.3 * n1), vy * 0.55);
    c.lerp(cFar, smoothstep((Math.hypot(x - cx, z - cz) - 500) / 700) * 0.6);
    c.lerp(tmp.copy(cR).lerp(cRD, n1), smoothstep((slope - 0.55) / 0.5));
  };
}

// ------------------------------------------------------------------ geometry helpers

// Triangle soup (counter-clockwise from outside) -> painted geometry.
function tris(arr, color) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  g.computeVertexNormals();
  return paint(g, color);
}
// Box / quad (+z facing) centred at (x, y, z), turned by ry, painted.
const box = (w, h, d, x, y, z, color, ry = 0, rx = 0, rz = 0) => paint(place(new THREE.BoxGeometry(w, h, d), x, y, z, ry, rx, rz), color);
const quad = (w, h, x, y, z, color, ry = 0) => paint(place(new THREE.PlaneGeometry(w, h), x, y, z, ry), color);
const cyl = (rt, rb, h, seg, x, y, z, color, ry = 0, rx = 0, rz = 0, open = false) =>
  paint(place(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), x, y, z, ry, rx, rz), color);
const ball = (r, x, y, z, color, sx = 1, sy = 1, sz = 1, detail = 0) =>
  paint(place(new THREE.IcosahedronGeometry(r, detail), x, y, z, 0, 0, 0, sx, sy, sz), color);

// Gable roof, ridge along local x, eaves at y = 0, overhang o. Returns
// [slopes, gable ends] (the gable triangles take the wall colour).
function gableRoof(w, d, h, o, roofCol, gableCol) {
  const x0 = -w / 2 - o, x1 = w / 2 + o, z0 = -d / 2 - o, z1 = d / 2 + o;
  const slopes = tris([
    x0, 0, z1, x1, 0, z1, x1, h, 0, x0, 0, z1, x1, h, 0, x0, h, 0,
    x1, 0, z0, x0, 0, z0, x0, h, 0, x1, 0, z0, x0, h, 0, x1, h, 0,
  ], roofCol);
  const hw = w / 2, hd = d / 2, hh = h * (hd / (hd + o));
  const gables = tris([hw, 0, hd, hw, 0, -hd, hw, hh, 0, -hw, 0, -hd, -hw, 0, hd, -hw, hh, 0], gableCol);
  return [slopes, gables];
}
// Hip roof (ridge along local x when w > d).
function hipRoof(w, d, h, o, col) {
  const x0 = -w / 2 - o, x1 = w / 2 + o, z0 = -d / 2 - o, z1 = d / 2 + o;
  const r = Math.max(0.01, (w - d) / 2);
  return tris([
    x0, 0, z1, x1, 0, z1, r, h, 0, x0, 0, z1, r, h, 0, -r, h, 0,
    x1, 0, z0, x0, 0, z0, -r, h, 0, x1, 0, z0, -r, h, 0, r, h, 0,
    x1, 0, z1, x1, 0, z0, r, h, 0,
    x0, 0, z0, x0, 0, z1, -r, h, 0,
  ], col);
}
// Colour the faces of a non-indexed geometry in stripes along local x.
function stripeX(geo, a, b, width) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position, n = pos.count, arr = new Float32Array(n * 3);
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  for (let i = 0; i < n; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const c = Math.floor(cx / width + 1000) % 2 ? ca : cb;
    for (let k = 0; k < 3; k++) { arr[(i + k) * 3] = c.r; arr[(i + k) * 3 + 1] = c.g; arr[(i + k) * 3 + 2] = c.b; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return paint(g, null);
}
// Merge parts into one geometry (disposing them).
function mergeParts(parts) {
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

// ------------------------------------------------------------------ houses

const FLOOR_H = 3.1;
const TA = MT.TOWN_ATLAS;

const { uvRect, uvWhite, uvStucco, uvRoof } = MT;

// A pastel house with a terracotta-tiled roof (town atlas), painted windows
// with shutters (front = local +z, facing the street; optionally the back
// too), a door or a shop front with a striped awning, sometimes a balcony,
// flower boxes and a chimney. Built in the house frame (x along the facade,
// absolute y), then turned by `yaw` and moved to (X, Z). gFront = ground at
// the front door. Every part carries town-atlas UVs (plain parts: white).
function houseGeometry(rng, { X, Z, yaw, w, d, gBase, gFront, floors, shop = false, back = true, wallCol, roofCol }) {
  const parts = [];
  const top = gFront + floors * FLOOR_H + 0.45;
  const H = top - gBase;
  parts.push(uvStucco(box(w, H, d, 0, gBase + H / 2, 0, wallCol), gBase, top));
  parts.push(box(w + 0.3, 0.26, d + 0.3, 0, top - 0.13, 0, mixHex(wallCol, C.trim, 0.6)));   // cornice
  const rh = d * (0.2 + rng() * 0.07);
  if (rng() < 0.62) {
    const [slopes, gables] = gableRoof(w, d, rh, 0.42, roofCol, wallCol);
    parts.push(uvRoof(slopes, rh).translate(0, top, 0), uvStucco(gables, -2, rh + 2).translate(0, top, 0));
  } else parts.push(uvRoof(hipRoof(w, d, rh, 0.42, roofCol), rh).translate(0, top, 0));
  if (rng() < 0.55) {
    const cx = (rng() - 0.5) * w * 0.6, cz = (rng() - 0.5) * d * 0.3;
    parts.push(box(0.6, 1.9, 0.6, cx, top + rh * 0.7, cz, mixHex(wallCol, 0x8a6a50, 0.35)));
  }
  const shutter = Math.floor(rng() * MT.SHUTTERS.length) % MT.SHUTTERS.length;
  const cols = Math.max(1, Math.floor((w - 0.6) / 2.35));
  const pitch = w / cols;
  const doorK = Math.floor(rng() * cols);
  const door = TA.DOORS[Math.floor(rng() * TA.DOORS.length) % TA.DOORS.length];
  const balconyFloor = floors >= 2 && rng() < 0.4 ? 1 + Math.floor(rng() * (floors - 1)) : -1;
  for (const face of back ? [1, -1] : [1]) {
    const zf = face * (d / 2 + 0.06), ry = face > 0 ? 0 : Math.PI;
    const out = (dz) => face * (d / 2 + dz);
    for (let fl = 0; fl < floors; fl++) {
      const yc = gFront + fl * FLOOR_H + 1.75;
      for (let k = 0; k < cols; k++) {
        const xc = -w / 2 + pitch * (k + 0.5);
        if (fl === 0 && face > 0 && shop) {
          if (k === doorK) parts.push(uvRect(quad(1.15, 2.25, xc, gFront + 1.12, zf, 0xffffff, ry), TA.cell(door, 'door')));
          else parts.push(uvRect(quad(pitch - 0.6, 2.0, xc, gFront + 1.3, zf, 0xffffff, ry), TA.cell(TA.SHOP[k % 2], 'shop')));
          continue;
        }
        if (fl === 0 && k === doorK && face > 0) {
          parts.push(uvRect(quad(1.15, 2.25, xc, gFront + 1.12, zf, 0xffffff, ry), TA.cell(door, 'door')));
          continue;
        }
        const closed = rng() < 0.22;
        parts.push(uvRect(quad(1.9, 1.5, xc, yc, zf, 0xffffff, ry), TA.cell((closed ? TA.CLOSED : TA.OPEN) + shutter)));
        if (fl > 0 && fl !== balconyFloor && rng() < 0.25) {
          parts.push(box(1.05, 0.34, 0.32, xc, yc - 0.8, out(0.16), rng() < 0.5 ? 0xe8475f : 0xf28ab8));
        }
      }
      if (fl === balconyFloor) {
        const bw = Math.min(w - 1, pitch * 1.6);
        parts.push(box(bw, 0.16, 1.0, 0, yc - 0.86, out(0.5), C.trim));
        parts.push(box(bw, 0.75, 0.06, 0, yc - 0.42, out(0.98), 0x2e3436));
        parts.push(box(bw - 0.3, 0.3, 0.3, 0, yc - 0.3, out(0.85), 0xe8475f));
      }
    }
  }
  if (shop) {
    // striped awning over the shop front
    const aw = new THREE.BoxGeometry(w - 0.8, 0.1, 1.0, Math.max(2, Math.round((w - 0.8) / 0.55)), 1, 1);
    const col = pickCol([0xe8475f, 0x3d8f5a, 0x2f7ad0, 0xf2a03a], rng());
    parts.push(place(stripeX(aw, col, 0xfff6e8, 0.55), 0, gFront + 2.85, d / 2 + 0.5, 0, 0.32));
  }
  for (const g of parts) if (!MT.hasAtlas(g)) uvWhite(g);
  const g = mergeParts(parts);
  place(g, X, 0, Z, yaw);
  MT.markAtlas(g);
  return g;
}

// 2-D oriented rectangles for house footprints: local x axis (c, -s),
// local z axis (s, c) after a yaw turn (matches place()).
function rect(x, z, yaw, hw, hd) { return { x, z, c: Math.cos(yaw), s: Math.sin(yaw), hw, hd, r: Math.hypot(hw, hd) }; }
function rectsOverlap(a, b, m) {
  const dx = b.x - a.x, dz = b.z - a.z;
  if (dx * dx + dz * dz > (a.r + b.r + m) ** 2) return false;
  const axes = [[a.c, -a.s], [a.s, a.c], [b.c, -b.s], [b.s, b.c]];
  for (const [ax, az] of axes) {
    const ra = a.hw * Math.abs(a.c * ax - a.s * az) + a.hd * Math.abs(a.s * ax + a.c * az);
    const rb = b.hw * Math.abs(b.c * ax - b.s * az) + b.hd * Math.abs(b.s * ax + b.c * az);
    if (Math.abs(dx * ax + dz * az) > ra + rb + m) return false;
  }
  return true;
}
// Points around a rect's outline (corners + every ~1.5 m), in world space.
function rectOutline(rc, step = 1.5) {
  const pts = [];
  const lx = [rc.c, -rc.s], lz = [rc.s, rc.c];
  const P = (u, v) => pts.push([rc.x + lx[0] * u + lz[0] * v, rc.z + lx[1] * u + lz[1] * v]);
  const nu = Math.max(1, Math.ceil((rc.hw * 2) / step)), nv = Math.max(1, Math.ceil((rc.hd * 2) / step));
  for (let i = 0; i <= nu; i++) { const u = -rc.hw + (2 * rc.hw * i) / nu; P(u, rc.hd); P(u, -rc.hd); }
  for (let j = 1; j < nv; j++) { const v = -rc.hd + (2 * rc.hd * j) / nv; P(rc.hw, v); P(-rc.hw, v); }
  return pts;
}
// Distance from a point to a rect (0 inside).
function rectDistance(rc, x, z) {
  const dx = x - rc.x, dz = z - rc.z;
  const u = dx * rc.c - dz * rc.s, v = dx * rc.s + dz * rc.c;
  return Math.hypot(Math.max(0, Math.abs(u) - rc.hw), Math.max(0, Math.abs(v) - rc.hd));
}

// The town: keeps every house footprint, checks track clearance, overlaps,
// exclusions and ground, and builds the geometry into the region buckets.
function createTown(ctx, field, bucket, rng) {
  const houses = [];
  const EAVE = 0.45;                     // roof overhang beyond the footprint
  const CLEAR = 0.5 + EAVE + 0.2;        // wall thickness + overhang + margin
  const fits = (rc, { slopeMax = 3.2 } = {}) => {
    for (const h of houses) if (rectsOverlap(rc, h.rect, 1.2)) return false;
    for (const [ex, ez, er] of ctx.exclusions) if (rectDistance(rc, ex, ez) < er) return false;
    // the centre's clearance bounds the whole outline's (1-Lipschitz)
    const cc = field.wallClearance(rc.x, rc.z);
    if (cc < CLEAR) return false;
    const exact = cc < rc.r + CLEAR;
    let gMin = Infinity, gMax = -Infinity;
    for (const [px, pz] of rectOutline(rc)) {
      if (exact && field.wallClearance(px, pz) < CLEAR) return false;
      const g = field.surfaceHeight(px, pz);
      gMin = Math.min(gMin, g); gMax = Math.max(gMax, g);
    }
    if (gMax - gMin > slopeMax) return false;
    return { gMin, gMax };
  };
  // facing = unit vector (fx, fz) the front looks along.
  function add(x, z, fx, fz, w, d, floors, { shop = false, back = true, slopeMax, frontGround = null } = {}) {
    const yaw = Math.atan2(fx, fz);
    const rc = rect(x, z, yaw, w / 2, d / 2);
    const ok = fits(rc, { slopeMax });
    if (!ok) return null;
    const gFront = frontGround !== null ? frontGround : field.surfaceHeight(x + fx * d / 2, z + fz * d / 2);
    const wallCol = pickCol(C.walls, rng()), roofCol = pickCol(C.roofs, rng());
    bucket.push(houseGeometry(rng, { X: x, Z: z, yaw, w, d, gBase: ok.gMin - 0.7, gFront, floors, shop, back, wallCol, roofCol }));
    const top = gFront + floors * FLOOR_H + 0.45;
    const h = { rect: rc, x, z, fx, fz, w, d, top, gFront };
    houses.push(h);
    for (const [px, pz] of rectOutline(rc, 1.0)) ctx.prop('house', px, pz, EAVE);
    return h;
  }
  return { houses, add, fits };
}

// Where the houses go: street rows facing the road through the piazza,
// village, hairpin and summit; the piazza's own frontage; a dense hill town
// inside the loop and on the near outskirts; a few farmhouses further out.
// Returns the street houses (laundry-line anchors).
function layoutTown(ctx, field, L, town, rng, nat, nearest) {
  const { track, Q } = ctx;
  const street = [];
  // Row along the street beyond the wall line (front = facing the road).
  const streetRow = (sA, sB, side, { depth = [7, 9.5], width = [6.2, 9.5], floors = [2, 3], setback = 1.2, shops = 0.2 } = {}) => {
    let s = sA;
    while (s < sB) {
      const w = lerp(width[0], width[1], rng()), d = lerp(depth[0], depth[1], rng());
      const fl = floors[0] + Math.floor(rng() * (floors[1] - floors[0] + 1));
      const f = track.frameAt(s + w / 2);
      const wall = side > 0 ? f.wallR : f.wallL;
      const k = 1 - f.curvature * side * (wall + setback + d / 2);   // arc-length ratio at the house line
      if (k < 0.35) { s += 2; continue; }
      let h = null;
      for (let t = 0; t < 4 && !h; t++) {
        const off = wall + setback + t * 0.9 + d / 2;
        const x = f.x + f.right.x * side * off, z = f.z + f.right.z * side * off;
        // back windows only where the back looks over the town (inside the loop)
        const back = nat.inside(x + f.right.x * side * d, z + f.right.z * side * d);
        h = town.add(x, z, -f.right.x * side, -f.right.z * side, w, d, fl,
          { shop: rng() < shops, frontGround: f.y - 0.25, back, slopeMax: 9 });
      }
      if (h) { street.push({ s: track.wrapS(s + w / 2), side, h }); s += (w + 0.2 + rng() * 0.6) / k; }
      else s += 1.5;
    }
  };
  const segS = (name) => track.segments[segIndex(track, name)];
  const S = (name, a = 0) => segS(name).s0 + a;
  const E = (name, a = 0) => segS(name).s1 + a;

  // piazza frontage (start frame: a along the straight, l to the right = away from the loop)
  const st = L.start;
  const P = (a, l) => [st.x + st.tx * a + st.rx * l, st.z + st.tz * a + st.rz * l];
  for (let a = PIAZZA.a0 + 2; a < PIAZZA.a1 - 4;) {
    const w = lerp(7, 10, rng()), d = lerp(8, 10, rng());
    const [x, z] = P(a + w / 2, PIAZZA.l1 - 8 + d / 2);
    const h = town.add(x, z, -st.rx, -st.rz, w, d, 3 + (rng() < 0.4 ? 1 : 0), { shop: rng() < 0.55, frontGround: -0.06 });
    a += h ? w + 0.25 : 1.5;
  }
  for (const [aEdge, dir] of [[PIAZZA.a0, 1], [PIAZZA.a1, -1]]) {
    for (let l = 18; l < PIAZZA.l1 - 6;) {
      const w = lerp(7, 9.5, rng()), d = lerp(8, 9.5, rng());
      const [x, z] = P(aEdge - dir * d / 2, l + w / 2);
      const h = town.add(x, z, st.tx * dir, st.tz * dir, w, d, 3, { shop: rng() < 0.4, frontGround: -0.06 });
      l += h ? w + 0.25 : 1.5;
    }
  }

  // street rows
  streetRow(S('Fontana Turn', 4), E('Fontana Turn'), 1, { floors: [3, 3] });
  streetRow(S('Via Vespa'), S('Laundry Lane'), 1, { shops: 0.4 });
  streetRow(S('Via Vespa'), S('Laundry Lane'), -1, { shops: 0.4 });
  streetRow(S('Laundry Lane'), E('Bakery Row'), 1, { floors: [3, 3], shops: 0.2 });
  streetRow(S('Laundry Lane'), E('Bakery Row'), -1, { floors: [3, 3], shops: 0.2 });
  streetRow(S('Tornante Uno', 4), E('Tornante Uno', -4), 1, { setback: 2.6, floors: [2, 2] });
  streetRow(S('Tornante Due', 4), E('Tornante Due', -4), -1, { setback: 2.6, floors: [2, 2] });
  streetRow(S('Campanile Climb', 6), E('Campanile Climb'), 1, { floors: [2, 3] });
  streetRow(S('Campanile Climb', 6), E('Campanile Climb', -10), -1, { floors: [2, 2] });
  streetRow(S('Campanile Curve', 2), E('Campanile Curve'), -1, { floors: [2, 2] });
  streetRow(S('Espresso Chicane A'), E('Espresso Chicane B'), -1, { floors: [2, 2] });
  streetRow(S('Pizza Oven Turn', 4), E('Pizza Oven Turn', -2), 1, { floors: [3, 3], shops: 0.3 });

  // hill town inside the loop + near outskirts: houses face the nearest road
  const townZones = new Set(['piazza', 'village', 'hairpin', 'summit']);
  const b = track.bounds;
  const G = 13.5;
  const dens = Q.veg >= 1 ? 1 : 0.55;
  for (let gx = b.minX - 70; gx < b.maxX + 70; gx += G) {
    for (let gz = b.minZ - 70; gz < b.maxZ + 70; gz += G) {
      const x = gx + (rng() - 0.5) * 6, z = gz + (rng() - 0.5) * 6;
      const nr = nearest(x, z);
      const zone = zoneTypeAt(track, nr.s);
      let p;
      // the old town crowds the streets; deeper in, gardens and olive terraces open up
      if (nat.inside(x, z)) p = 0.9 * (0.3 + 0.7 * smoothstep((78 - nr.d) / 30));
      else p = townZones.has(zone) ? smoothstep((50 - nr.d) / 24) * 0.85 : 0;
      if (zone === 'vineyard' || zone === 'bridge' || zone === 'dairy' || nat.piazzaMask(x, z) > 0.05) p = 0;
      if (rng() > p * dens) continue;
      const w = lerp(6.5, 10, rng()), d = lerp(6.5, 9, rng());
      let fx = track.px[nr.i] - x, fz = track.pz[nr.i] - z;
      const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      town.add(x, z, fx, fz, w, d, 2 + (rng() < 0.45 ? 1 : 0), { back: nr.d < 44, slopeMax: 3.6 });
    }
  }
  // farmhouses out in the countryside
  for (let k = 0, n = 0; k < 160 && n < 6; k++) {
    const a = rng() * Math.PI * 2, r = lerp(150, 320, rng());
    const x = (b.minX + b.maxX) / 2 + Math.cos(a) * r, z = (b.minZ + b.maxZ) / 2 + Math.sin(a) * r;
    if (nat.inside(x, z) || nearest(x, z).d < 60) continue;
    if (town.add(x, z, Math.cos(a + 2), Math.sin(a + 2), lerp(10, 13, rng()), lerp(8, 10, rng()), 2, { slopeMax: 2.5 })) n++;
  }
  return street;
}

// Zone type at arc length s (first match), '' outside every zone.
function zoneTypeAt(track, s) {
  for (const z of track.zones) if (inZone(track, z, s)) return z.type;
  return '';
}

// Laundry lines strung across the village street between facing houses,
// high above the karts (lowest shirt hem ≥ 5.5 m over the road).
function buildLaundry(ctx, street, bucket, rng) {
  const { track } = ctx;
  const left = street.filter((h) => h.side < 0), right = street.filter((h) => h.side > 0);
  const zone = track.zones.find((z) => z.type === 'village');
  const shirtCols = [0xffffff, 0xff5a5f, 0x4aa3ff, 0xffd23f, 0x5ad37a, 0xff8fc8, 0xffffff, 0xb07cff, 0xff9a3c];
  const up = new THREE.Vector3(0, 1, 0), P0 = new THREE.Vector3(), P1 = new THREE.Vector3(), mid = new THREE.Vector3(), m4 = new THREE.Matrix4();
  let lastS = -1e9, count = 0;
  for (const hl of left) {
    if (!zone || !inZone(track, zone, hl.s) || hl.s - lastS < 17) continue;
    const hr = right.find((h) => Math.abs(track.deltaS(h.s, hl.s)) < 3.5);
    if (!hr) continue;
    const road = track.frameAt(hl.s).y;
    const y = road + 7.4;                       // lowest hem ≈ road + 5.7
    if (Math.min(hl.h.top, hr.h.top) < y + 0.7) continue;
    const A = [hl.h.x + hl.h.fx * (hl.h.d / 2 + 0.1), hl.h.z + hl.h.fz * (hl.h.d / 2 + 0.1)];
    const B = [hr.h.x + hr.h.fx * (hr.h.d / 2 + 0.1), hr.h.z + hr.h.fz * (hr.h.d / 2 + 0.1)];
    const span = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const sag = Math.min(0.95, span * 0.04);
    const at = (t, out) => out.set(lerp(A[0], B[0], t), y - sag * 4 * t * (1 - t), lerp(A[1], B[1], t));
    const SEG = 6;
    for (let k = 0; k < SEG; k++) {
      at(k / SEG, P0); at((k + 1) / SEG, P1);
      mid.addVectors(P0, P1).multiplyScalar(0.5);
      const g = new THREE.BoxGeometry(0.05, 0.05, P0.distanceTo(P1) + 0.02);
      g.applyMatrix4(m4.lookAt(P0, P1, up)).translate(mid.x, mid.y, mid.z);
      bucket.push(paint(g, 0xf2f2f2));
    }
    const yaw = Math.atan2(B[0] - A[0], B[1] - A[1]) + Math.PI / 2;
    for (let t = 0.12; t < 0.9; t += lerp(0.07, 0.11, rng()) * (14 / Math.max(10, span))) {
      at(t, P0);
      const kind = rng();
      const col = pickCol(shirtCols, rng());
      if (kind < 0.6) {   // shirt with sleeves
        bucket.push(paint(place(new THREE.BoxGeometry(0.62, 0.7, 0.04), P0.x, P0.y - 0.36, P0.z, yaw), col));
        bucket.push(paint(place(new THREE.BoxGeometry(1.0, 0.22, 0.04), P0.x, P0.y - 0.13, P0.z, yaw), col));
      } else if (kind < 0.85) {   // trousers
        bucket.push(paint(place(new THREE.BoxGeometry(0.5, 0.18, 0.04), P0.x, P0.y - 0.1, P0.z, yaw), col));
        for (const sx of [-0.13, 0.13]) bucket.push(paint(place(new THREE.BoxGeometry(0.22, 0.75, 0.04), P0.x + Math.cos(yaw) * sx, P0.y - 0.55, P0.z - Math.sin(yaw) * sx, yaw), col));
      } else {   // towel
        bucket.push(paint(place(new THREE.BoxGeometry(0.75, 0.9, 0.03), P0.x, P0.y - 0.45, P0.z, yaw), col));
      }
    }
    lastS = hl.s; count++;
  }
  ctx.stats.instances.laundryLines = count;
}

// ------------------------------------------------------------------ landmarks

// Giant pizza on top of the start gantry, facing the grid (kit gantry extra).
function gantryPizza(parts, P, span, f) {
  const [x, y, z] = P(0, 13.2, -0.1);
  const yaw = f.yaw + Math.PI;            // disc faces the oncoming karts (-tangent)
  const R = 2.7;
  // stand
  parts.push(box(0.5, 2.6, 0.5, ...P(-1.2, 10.6, 0.45), 0x2c2f36, f.yaw));
  parts.push(box(0.5, 2.6, 0.5, ...P(1.2, 10.6, 0.45), 0x2c2f36, f.yaw));
  // crust, sauce, cheese (stacked discs, axis along the track)
  parts.push(cyl(R, R, 0.42, 20, x, y, z, 0xd99a4e, yaw, Math.PI / 2));
  parts.push(cyl(R * 0.86, R * 0.86, 0.46, 20, x, y, z, 0xd8432c, yaw, Math.PI / 2));
  parts.push(cyl(R * 0.8, R * 0.8, 0.5, 14, x, y, z, 0xfbe39a, yaw, Math.PI / 2));
  // pepperoni + basil, on both faces
  const tx = Math.sin(f.yaw), tz = Math.cos(f.yaw), rx = Math.cos(f.yaw), rz = -Math.sin(f.yaw);
  const tops = [[0.9, 0.6], [-1.0, 0.8], [0.2, -1.2], [-0.6, -0.4], [1.3, -0.5], [-1.4, -0.3], [0.4, 1.5]];
  tops.forEach(([u, v], i) => {
    for (const face of [-1, 1]) {
      const off = face * 0.27;
      const px = x + rx * u + tx * off, py = y + v, pz = z + rz * u + tz * off;
      if (i % 3 === 2) parts.push(box(0.5, 0.3, 0.06, px, py, pz, 0x3f9a3a, f.yaw, 0, 0.6));
      else parts.push(cyl(0.38, 0.38, 0.06, 10, px, py, pz, 0xb32a22, f.yaw, Math.PI / 2));
    }
  });
}

// Fountain in the middle of the Fontana Turn: stone basin, two bowls,
// a mozzarella ball on top and four arcing jets.
function buildFountain(ctx, F, bucket, water) {
  const parts = [];
  const g0 = -0.06;
  const x = F.x, z = F.z;
  const lathe = (pts, seg, col, y) => paint(place(new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(r, h)), seg), x, y, z), col);
  parts.push(lathe([[0, 0], [5.6, 0], [5.6, 0.95], [5.2, 1.0], [4.95, 0.95], [4.95, 0.5], [0, 0.5]], 24, C.stone, g0));
  parts.push(cyl(0.55, 0.8, 2.7, 10, x, g0 + 1.85, z, C.stoneWarm));
  parts.push(lathe([[0.4, 0], [1.4, 0.25], [2.3, 0.55], [2.35, 0.75], [2.1, 0.72], [0, 0.6]], 16, C.stone, g0 + 3.1));
  parts.push(cyl(0.3, 0.45, 1.3, 8, x, g0 + 4.3, z, C.stoneWarm));
  parts.push(lathe([[0.25, 0], [0.9, 0.2], [1.2, 0.42], [1.05, 0.4], [0, 0.32]], 12, C.stone, g0 + 4.9));
  parts.push(ball(0.55, x, g0 + 5.85, z, 0xfbf8ee, 1, 0.92, 1, 1));
  for (const p of parts) bucket.push(p);
  // water: basin, upper bowl, jets
  water.push(paint(place(new THREE.CircleGeometry(4.98, 24).rotateX(-Math.PI / 2), x, g0 + 0.78, z), C.water));
  water.push(paint(place(new THREE.CircleGeometry(2.08, 16).rotateX(-Math.PI / 2), x, g0 + 3.835, z), C.water));
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4, ca = Math.cos(a), sa = Math.sin(a);
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(x + ca * 2.2, g0 + 3.75, z + sa * 2.2),
      new THREE.Vector3(x + ca * 3.6, g0 + 3.9, z + sa * 3.6),
      new THREE.Vector3(x + ca * 4.1, g0 + 0.8, z + sa * 4.1));
    water.push(paint(new THREE.TubeGeometry(curve, 8, 0.1, 5), 0xbfeefa));
  }
  ctx.prop('fountain', x, z, 5.6);
  ctx.exclusions.push([x, z, 7]);
  ctx.landmarks.push({ name: 'fountain', x, z, r: 5.6, h: 7 });
}

// Retaining wall along the piazza's loop side: holds the old town's hill
// above the paving, stepped to the terrain behind it.
function buildPiazzaWall(ctx, field, L, stone) {
  const st = L.start, F = L.fountain;
  const yaw = Math.atan2(st.tx, st.tz);
  const P = (aa, ll) => [st.x + st.tx * aa + st.rx * ll, st.z + st.tz * aa + st.rz * ll];
  const l = PIAZZA.l0 - 0.35;
  for (let a = PIAZZA.a0; a < PIAZZA.a1 - 0.5; a += 4) {
    const am = a + 2;
    const [x, z] = P(am, l);
    if (F && Math.hypot(x - F.x, z - F.z) < FOUNTAIN_PLAZA_R + 2.5) continue;
    // the turns at both ends of the piazza cross this line: keep clear of the road
    if ([-2, 0, 2].some((da) => field.wallClearance(...P(am + da, l)) < 1.2)) continue;
    const top = Math.max(0.9, field.surfaceHeight(...P(am, l - 3)) + 0.35);
    stone.push(paint(place(new THREE.BoxGeometry(0.7, top + 0.9, 4.02), x, (top - 0.9) / 2, z, yaw), C.stoneWarm));
    stone.push(paint(place(new THREE.BoxGeometry(0.95, 0.22, 4.02), x, top + 0.11, z, yaw), C.stone));
    for (const da of [-1.5, 0, 1.5]) ctx.prop('piazzaWall', ...P(am + da, l), 0.48);
    ctx.exclusions.push([x, z, 2.6]);
  }
}

// Café tables with striped umbrellas on the piazza's west side.
function buildCafe(ctx, L, bucket, rng) {
  const st = L.start;
  const P = (a, l) => [st.x + st.tx * a + st.rx * l, st.z + st.tz * a + st.rz * l];
  const canopyCols = [0xe8475f, 0x3d8f5a, 0x2f7ad0, 0xf2a03a];
  let n = 0;
  for (let a = -30; a < 100; a += 8.5) {
    for (const l of [24.5, 30.5]) {
      if (ctx.Q.veg < 1 && (n % 2)) { n++; continue; }
      const [x, z] = P(a + (l > 25 ? 4 : 0) + (rng() - 0.5) * 1.5, l + (rng() - 0.5) * 1.2);
      const col = canopyCols[Math.floor(a / 8.5 + 4) % canopyCols.length];
      const canopy = new THREE.ConeGeometry(1.9, 0.75, 8, 1).toNonIndexed();
      faceColors(canopy, (y, ny, fi) => (fi % 2 ? 0xfff6e8 : col));
      bucket.push(paint(place(canopy, x, 2.75, z, rng()), null));
      bucket.push(cyl(0.05, 0.05, 2.8, 5, x, 1.35, z, 0xeeeeee));
      bucket.push(cyl(0.55, 0.55, 0.06, 10, x, 0.72, z, 0xf7f7f2));
      bucket.push(cyl(0.06, 0.06, 0.7, 5, x, 0.36, z, 0x2e3436));
      for (const k of [0, 1]) {
        const ca = rng() * 6.28, cx = x + Math.cos(ca) * 0.95, cz = z + Math.sin(ca) * 0.95;
        bucket.push(box(0.45, 0.45, 0.45, cx, 0.22, cz, k ? 0x3d6fb0 : 0xc25a3a, ca));
        bucket.push(box(0.45, 0.5, 0.08, cx + Math.cos(ca) * 0.2, 0.7, cz + Math.sin(ca) * 0.2, k ? 0x3d6fb0 : 0xc25a3a, Math.PI / 2 - ca));
      }
      ctx.prop('umbrella', x, z, 1.9);
      ctx.exclusions.push([x, z, 2.4]);
      n++;
    }
  }
  ctx.stats.instances.cafeTables = n;
}

// Giant gelato cones on pedestals along Via Gelato + a bread loaf by the bakery.
function buildFoodProps(ctx, field, bucket, rng) {
  const { track } = ctx;
  const scoopCols = [0xb7d98b, 0xf49ab0, 0xfff1c8, 0x8a5233, 0xffd166, 0xc9a7f2];
  const at = (s, side, extra) => {
    const f = track.frameAt(s);
    const wall = side > 0 ? f.wallR : f.wallL;
    const lat = side * (wall + extra);
    return { x: f.x + f.right.x * lat, z: f.z + f.right.z * lat, y: f.y, yaw: f.yaw };
  };
  const es = track.segments[segIndex(track, 'Gelato Esses A')], ll = track.segments[segIndex(track, 'Laundry Lane')];
  const spots = [[es.s0 + 6, 1], [es.s0 + 28, -1], [ll.s0 + 14, 1], [ll.s0 + 46, -1]];
  for (const [s, side] of spots) {
    const p = at(s, side, 2.1), sc = lerp(0.9, 1.15, rng());
    const g = field.surfaceHeight(p.x, p.z);
    const parts = [];
    parts.push(box(1.6, 0.8, 1.6, 0, 0.4, 0, C.cream));
    parts.push(cyl(1.05, 0.12, 3.0, 9, 0, 2.3, 0, 0xd9a15c));   // waffle cone (tip down)
    const n = 2 + (rng() < 0.6 ? 1 : 0);
    for (let k = 0; k < n; k++) parts.push(ball(1.0 - k * 0.12, (k % 2 ? 0.25 : -0.2), 4.05 + k * 1.05, 0, pickCol(scoopCols, rng()), 1, 0.9, 1, 1));
    parts.push(ball(0.28, 0.1, 4.05 + n * 1.05 - 0.2, 0, 0xe8344e, 1, 1, 1, 1));
    const geo = mergeParts(parts);
    geo.scale(sc, sc, sc);
    place(geo, p.x, g - 0.05, p.z, rng() * 6.28);
    bucket.push(geo);
    ctx.prop('gelato', p.x, p.z, 1.15 * sc);
    ctx.exclusions.push([p.x, p.z, 2.0]);
  }
  // bread loaf on a stand by Bakery Row
  const bak = track.segments[segIndex(track, 'Bakery Row')];
  {
    const p = at(bak.s0 + 22, -1, 2.3), g = field.surfaceHeight(p.x, p.z);
    const parts = [box(1.8, 1.0, 1.4, 0, 0.5, 0, 0x9a6a3c)];
    const loaf = lumpy(new THREE.IcosahedronGeometry(1.0, 1), 0.12, 1.9, 0.75, 0.95, 4);
    parts.push(paint(loaf.translate(0, 1.6, 0), 0xd9963f));
    for (let k = -1; k <= 1; k++) parts.push(box(0.12, 0.08, 1.3, k * 0.6, 2.26, 0, 0xf2d29b, 0, 0, 0.5));
    const geo = mergeParts(parts);
    place(geo, p.x, g - 0.05, p.z, p.yaw);
    bucket.push(geo);
    ctx.prop('bread', p.x, p.z, 1.9);
    ctx.exclusions.push([p.x, p.z, 2.4]);
  }
}

// Striped campanile on the summit (inside the Campanile Curve): stone
// plinth, white / green marble bands, clock faces, an open belfry with a
// bronze bell, terracotta spire.
function buildCampanile(ctx, field, at, bucket, stone) {
  const x = at.x, z = at.z;
  const W = 6.6;
  let g0 = Infinity;
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) g0 = Math.min(g0, field.surfaceHeight(x + dx * 4.5, z + dz * 4.5));
  g0 -= 0.3;
  const parts = [];
  const plinthTop = g0 + 3.0;
  stone.push(paint(place(new THREE.BoxGeometry(W + 1.6, plinthTop - g0 + 1.5, W + 1.6), x, (plinthTop + g0 - 1.5) / 2, z), C.stoneWarm));
  stone.push(paint(place(new THREE.BoxGeometry(W + 2.2, 0.4, W + 2.2), x, plinthTop + 0.2, z), C.stone));
  const shaftTop = plinthTop + 24;
  const BAND = 1.5;
  for (let y = plinthTop + 0.4, k = 0; y < shaftTop - 0.01; y += BAND, k++) {
    const h = Math.min(BAND, shaftTop - y);
    parts.push(box(W, h, W, x, y + h / 2, z, k % 2 ? C.towerB : C.towerA));
  }
  // clock faces (all four sides)
  const cy = shaftTop - 4.2;
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2, nx = Math.sin(a), nz = Math.cos(a);
    const px = x + nx * (W / 2 + 0.06), pz = z + nz * (W / 2 + 0.06);
    parts.push(paint(place(new THREE.CircleGeometry(1.75, 20), px, cy, pz, a), 0x2d3a45));
    parts.push(paint(place(new THREE.CircleGeometry(1.5, 20), px + nx * 0.03, cy, pz + nz * 0.03, a), 0xfaf6ea));
    parts.push(box(0.16, 1.1, 0.05, px + nx * 0.07, cy + 0.45, pz + nz * 0.07, 0x22262c, a));
    parts.push(box(0.16, 0.8, 0.05, px + nx * 0.08 + Math.cos(a) * 0.32, cy - 0.12, pz + nz * 0.08 - Math.sin(a) * 0.32, 0x22262c, a, 0, -1.2));
  }
  // belfry: floor, four corner piers with arches, roof slab, bell
  const bf = shaftTop, BH = 6.4;
  parts.push(box(W + 0.5, 0.45, W + 0.5, x, bf + 0.22, z, C.towerA));
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    parts.push(box(1.45, BH, 1.45, x + dx * (W / 2 - 0.72), bf + 0.45 + BH / 2, z + dz * (W / 2 - 0.72), C.towerA));
  }
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2, nx = Math.sin(a), nz = Math.cos(a);
    // lintel band over each opening + a low sill
    parts.push(box(W, 1.2, 0.6, x + nx * (W / 2 - 0.3), bf + 0.45 + BH - 0.6, z + nz * (W / 2 - 0.3), C.towerB, a));
    parts.push(box(W - 2.9, 0.9, 0.35, x + nx * (W / 2 - 0.4), bf + 0.9, z + nz * (W / 2 - 0.4), C.towerA, a));   // sill
  }
  parts.push(box(W + 0.7, 0.5, W + 0.7, x, bf + 0.45 + BH + 0.25, z, C.towerA));
  // bell
  parts.push(paint(place(new THREE.LatheGeometry([[0, 1.6], [0.55, 1.55], [0.75, 1.0], [0.95, 0.25], [1.25, 0], [1.1, -0.05], [0, 0.1]].map(([r, h]) => new THREE.Vector2(r, h)), 12), x, bf + 2.3, z), C.bronze));
  parts.push(box(0.25, 0.9, 0.25, x, bf + 4.3, z, 0x4a3a2a));
  // spire
  const sp = bf + 0.45 + BH + 0.5;
  parts.push(paint(place(new THREE.ConeGeometry(W * 0.78, 7.5, 4, 1), x, sp + 3.75, z, Math.PI / 4), C.roofs[0]));
  parts.push(ball(0.45, x, sp + 7.7, z, 0xe8c25a, 1, 1, 1, 1));
  parts.push(cyl(0.06, 0.06, 1.6, 4, x, sp + 8.6, z, 0x2e3436));
  for (const p of parts) bucket.push(p);
  ctx.prop('campanile', x, z, (W + 2.2) * 0.72);
  ctx.exclusions.push([x, z, 9]);
  ctx.landmarks.push({ name: 'campanile', x, z, r: 6, h: sp + 9 - g0 });
  ctx.flagSpots.push([x + 1.2, sp + 8.0, z + 1.2, 0, true]);
}

// Two-tier stone aqueduct carrying the road across the valley: one
// extruded side elevation (arches as holes) spanning the full deck width,
// cornices, and parapets whose inner faces sit exactly at wallL / wallR.
function buildAqueduct(ctx, L, stone, lamps) {
  const { track } = ctx;
  const Z = L.bridge;
  const len = track.forwardDistance(Z.s0, Z.s1);
  const f0 = track.frameAt(Z.s0);
  let wMax = 0;
  for (let s = Z.s0; s <= Z.s0 + len; s += 2) { const f = track.frameAt(s); wMax = Math.max(wMax, f.wallL, f.wallR); }
  const WEXT = wMax + 0.8;
  const floor = valleyFloor(L.valley, 0);
  const BOT = floor - 8;
  const roadY = (u) => track.frameAt(Z.s0 + u).y;
  const shape = new THREE.Shape();
  shape.moveTo(0, BOT);
  shape.lineTo(len, BOT);
  for (let u = len; u > 0.5; u -= 4) shape.lineTo(u, roadY(u) - 0.04);
  shape.lineTo(0, roadY(0) - 0.04);
  shape.lineTo(0, BOT);
  const bays = Math.max(4, Math.round(len / 10)), bay = len / bays, PW = 2.6;
  const yS1 = floor + 3.4, yC2 = floor + 9.8;
  const archHole = (a, b, yBot, ySpring) => {
    const r = (b - a) / 2, cx = (a + b) / 2;
    const h = new THREE.Path();
    h.moveTo(a, yBot);
    h.lineTo(a, ySpring);
    h.absarc(cx, ySpring, r, Math.PI, 0, true);
    h.lineTo(b, yBot);
    h.lineTo(a, yBot);
    return h;
  };
  for (let k = 0; k < bays; k++) {
    const u0 = k * bay;
    shape.holes.push(archHole(u0 + PW / 2, u0 + bay - PW / 2, BOT + 1, yS1));
    for (const q of [0.25, 0.75]) {
      const c = u0 + bay * q, hw = bay * 0.15;
      shape.holes.push(archHole(c - hw, c + hw, yC2 - 1.6, yC2));
    }
  }
  const ex = new THREE.ExtrudeGeometry(shape, { depth: WEXT * 2, bevelEnabled: false, curveSegments: 7 });
  ex.translate(0, 0, -WEXT);
  // local (u along, y, w lateral) -> world
  const T = f0.tangent, R = f0.right;
  const m = new THREE.Matrix4().set(
    T.x, 0, R.x, f0.x,
    0, 1, 0, 0,
    T.z, 0, R.z, f0.z,
    0, 0, 0, 1);
  ex.applyMatrix4(m);
  stone.push(paint(ex, C.stone));
  // cornice strips on both elevations: between the tiers and under the deck
  for (const [y, h] of [[floor + 7.7, 0.42], [roadY(len / 2) - 0.9, 0.35]]) {
    for (const w of [-WEXT, WEXT]) {
      const g = new THREE.BoxGeometry(len, h, 0.6);
      g.translate(len / 2, y, w).applyMatrix4(m);
      stone.push(paint(g, C.stoneWarm));
    }
  }
  // parapets: inner face at the wall line, coping on top
  const sList = sRange(Z.s0, Z.s0 + len, 2);
  for (const side of [-1, 1]) {
    const faces = [[[0, -0.05], [0, 0.95]], [[0, 0.95], [0.55, 0.95]], [[0.55, 0.95], [0.55, -0.05]]];
    for (const face of faces) {
      stone.push(paint(trackStrip(track, sList, 2, (f, s, c, o) => {
        const pt = side > 0 ? face[c] : face[1 - c];
        const wall = side > 0 ? f.wallR : f.wallL;
        o.lat = side * (wall + pt[0]); o.dy = pt[1];
        o.u = s; o.v = pt[1] + pt[0];
      }), C.stone));
    }
    for (let s = Z.s0 + 6; s < Z.s0 + len - 3; s += 19) {
      const f = track.frameAt(s), wall = side > 0 ? f.wallR : f.wallL, lat = side * (wall + 0.28);
      lamps.push([f.x + f.right.x * lat, f.y + 0.95, f.z + f.right.z * lat, f.yaw, 0.8]);
    }
  }
}

// Generic stovetop coffee pot (octagonal base chamber, waist, flared jug,
// faceted lid with a knob, spout, black handle), unit height ~3.8 m.
// Returns { geo, spout: [x, y, z] in local units } for steam.
function mokaPotGeometry() {
  const parts = [
    cyl(0.78, 1.0, 1.35, 8, 0, 0.675, 0, C.pot),
    cyl(0.74, 0.74, 0.16, 8, 0, 1.43, 0, mixHex(C.pot, 0x707780, 0.4)),
    cyl(1.02, 0.78, 1.65, 8, 0, 2.335, 0, C.pot),
    cyl(0.28, 1.05, 0.34, 8, 0, 3.33, 0, mixHex(C.pot, 0xffffff, 0.25)),
    ball(0.2, 0, 3.62, 0, C.potDark, 1, 0.8, 1),
    box(0.34, 0.3, 0.55, 0, 3.0, 1.12, C.pot, 0, -0.35),
    box(0.62, 0.22, 0.22, -1.25, 2.95, 0, C.potDark),
    box(0.24, 1.15, 0.26, -1.55, 2.4, 0, C.potDark, 0, 0, -0.12),
  ];
  return { geo: mergeParts(parts), spout: [0, 3.2, 1.35] };
}

// Espresso Works: the covered section (inner walls above the brick
// barrier exactly at the wall lines, ceiling with light panels, roof,
// portals with coffee-bean emblems), the factory hall with its chimney and
// giant coffee pots puffing steam.
function buildFactory(ctx, field, L, bucket, glow, steam) {
  const { track } = ctx;
  const Z = L.tunnel;
  const len = track.forwardDistance(Z.s0, Z.s1);
  const sList = sRange(Z.s0, Z.s0 + len, 1.0);
  const CEIL = 6.6, ROOF = 7.4, THICK = 1.2;
  const wallAt = (f, side) => (side > 0 ? f.wallR : f.wallL);
  const strip = (fn, col) => bucket.push(paint(trackStrip(track, sList, 2, fn), col));
  for (const side of [-1, 1]) {
    // inner face above the 0.95 m barrier: cream dado band + red stripe
    for (const [y0, y1, col] of [[0.95, 2.2, 0xefe4cc], [2.2, 2.6, 0xb8452c], [2.6, CEIL, 0xefe4cc]]) {
      strip((f, s, c, o) => { const y = side > 0 ? (c ? y1 : y0) : (c ? y0 : y1); o.lat = side * wallAt(f, side); o.dy = y; }, col);
    }
    // outer face down into the ground
    strip((f, s, c, o) => { const y = side > 0 ? (c ? -2.6 : ROOF) : (c ? ROOF : -2.6); o.lat = side * (wallAt(f, side) + THICK); o.dy = y; }, C.brick);
  }
  // ceiling (facing down) and roof (facing up)
  strip((f, s, c, o) => { o.lat = c ? -(f.wallL + 0.01) : f.wallR + 0.01; o.dy = CEIL; }, 0xd9cfbf);
  for (let s = Z.s0 + 4; s < Z.s0 + len - 2; s += 7) {
    const f = track.frameAt(s), W = f.wallL + f.wallR, latC = (f.wallR - f.wallL) / 2;
    bucket.push(box(W, 0.45, 0.5, f.x + f.right.x * latC, f.y + CEIL - 0.22, f.z + f.right.z * latC, 0x6b4a36, f.yaw));
  }
  strip((f, s, c, o) => { o.lat = c ? f.wallR + THICK + 0.3 : -(f.wallL + THICK + 0.3); o.dy = ROOF; }, 0x8f4a35);
  // ceiling light panels
  for (let s = Z.s0 + 2; s < Z.s0 + len - 1; s += 4) {
    const f = track.frameAt(s);
    for (const lat of [-3.6, 3.6]) {
      glow.push(paint(place(new THREE.PlaneGeometry(1.2, 2.4).rotateX(Math.PI / 2), f.x + f.right.x * lat, f.y + CEIL - 0.03, f.z + f.right.z * lat, f.yaw), 0xfff1c4));
    }
  }
  // portals: lintel facade, pilasters, coffee-bean emblem
  for (const [s, dir] of [[Z.s0, -1], [Z.s0 + len, 1]]) {
    const f = track.frameAt(s);
    const W = f.wallL + f.wallR + THICK * 2 + 0.6, latC = (f.wallR - f.wallL) / 2;
    const P = (lat, along) => [f.x + f.right.x * lat + f.tangent.x * along, f.z + f.right.z * lat + f.tangent.z * along];
    const [lx, lz] = P(latC, dir * 0.35);
    bucket.push(box(W, ROOF + 2.6 - CEIL, 0.9, lx, f.y + (CEIL + ROOF + 2.6) / 2, lz, C.brick, f.yaw));
    bucket.push(box(W + 0.4, 0.35, 1.1, lx, f.y + ROOF + 2.7, lz, C.cream, f.yaw));
    bucket.push(box(W, 0.3, 1.0, lx, f.y + CEIL + 0.15, lz, C.cream, f.yaw));
    for (const side of [-1, 1]) {
      const [px, pz] = P(side * (wallAt(f, side) + (THICK + 0.6) / 2), dir * 0.35);   // inner face exactly at the wall
      bucket.push(box(THICK + 0.6, ROOF + 2.6 + 2.6, 1.3, px, f.y + (ROOF + 2.6 - 2.6) / 2, pz, C.brickDark, f.yaw));
    }
    const [bx, bz] = P(latC, dir * 0.85);
    bucket.push(ball(1.6, bx, f.y + CEIL + 1.9, bz, 0x6b3e22, 1, 0.72, 0.45, 1));
    bucket.push(box(0.2, 2.1, 0.2, bx + f.tangent.x * dir * 0.62, f.y + CEIL + 1.9, bz + f.tangent.z * dir * 0.62, 0x3a2012, f.yaw, 0, 0.35));
  }
  // factory hall on the outside (right) of the covered section
  const fm = track.frameAt(Z.s0 + len / 2);
  const hallD = 22, hallL = len + 10, hallH = ROOF + 3.6;
  const hl = fm.wallR + THICK + hallD / 2 + 0.2;
  const hx = fm.x + fm.right.x * hl, hz = fm.z + fm.right.z * hl;
  let g0 = Infinity;
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    g0 = Math.min(g0, field.surfaceHeight(hx + fm.tangent.x * a * hallL / 2 + fm.right.x * b * hallD / 2, hz + fm.tangent.z * a * hallL / 2 + fm.right.z * b * hallD / 2));
  }
  g0 = Math.min(g0, fm.y) - 0.8;
  const top = fm.y + hallH;
  const hall = [box(hallD, top - g0, hallL, 0, (top + g0) / 2, 0, C.brick)];
  hall.push(box(hallD + 0.4, 0.4, hallL + 0.4, 0, top + 0.2, 0, C.cream));
  for (const g of gableRoof(hallL, hallD, 3.2, 0.5, 0x8f4a35, C.brick)) hall.push(g.translate(0, top + 0.4, 0).rotateY(Math.PI / 2));
  // big factory windows on both long sides
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 6; k++) {
      const zc = -hallL / 2 + (hallL / 6) * (k + 0.5);
      hall.push(quad(3.0, 3.4, sx * (hallD / 2 + 0.06), fm.y + 4.6, zc, 0x9fc6d8, sx > 0 ? Math.PI / 2 : -Math.PI / 2));
      hall.push(quad(3.0, 0.22, sx * (hallD / 2 + 0.11), fm.y + 4.6, zc, 0x5a3a2a, sx > 0 ? Math.PI / 2 : -Math.PI / 2));
    }
  }
  // chimney at the far corner
  hall.push(cyl(1.0, 1.35, 23, 10, hallD / 2 - 3, g0 + 11.5, hallL / 2 - 3, C.brickDark));
  for (const y of [8, 15, 21]) hall.push(cyl(1.1, 1.1, 0.5, 10, hallD / 2 - 3, g0 + y, hallL / 2 - 3, C.cream));
  const hgeo = mergeParts(hall);
  const yaw = Math.atan2(-fm.right.z, fm.right.x);    // hall local x (depth) along the frame's right
  place(hgeo, hx, 0, hz, yaw);
  bucket.push(hgeo);
  {
    // chimney top in world space (same transform as the hall)
    const lx = hallD / 2 - 3, lz = hallL / 2 - 3;
    steam.push([hx + Math.cos(yaw) * lx + Math.sin(yaw) * lz, g0 + 23.2, hz - Math.sin(yaw) * lx + Math.cos(yaw) * lz, 1.6, 0.55]);
  }
  for (const [px, pz] of rectOutline(rect(hx, hz, yaw, hallD / 2, hallL / 2), 1.5)) ctx.prop('factory', px, pz, 0.3);
  ctx.exclusions.push([hx, hz, Math.hypot(hallD, hallL) / 2 + 2]);
  ctx.landmarks.push({ name: 'factory', x: hx, z: hz, r: Math.hypot(hallD, hallL) / 2, h: 26 });

  // giant coffee pots: two on the covered section's roof, one on the hall, one on the ground
  const pot = mokaPotGeometry();
  const addPot = (x, y, z, sc, yaw) => {
    const g = pot.geo.clone();
    g.scale(sc, sc, sc);
    place(g, x, y, z, yaw);
    bucket.push(g);
    const [sx, sy, sz] = pot.spout;
    steam.push([x + (Math.sin(yaw) * sz + Math.cos(yaw) * sx) * sc, y + sy * sc, z + (Math.cos(yaw) * sz - Math.sin(yaw) * sx) * sc, sc * 0.55, 1]);
  };
  for (const [a, lat, sc] of [[0.3, -4.5, 2.1], [0.72, 4.0, 2.4]]) {
    const f = track.frameAt(Z.s0 + len * a);
    addPot(f.x + f.right.x * lat, f.y + ROOF + 0.02, f.z + f.right.z * lat, sc, f.yaw + Math.PI * 0.85);
  }
  addPot(hx - fm.tangent.x * 4, top + 0.4 + 1.2, hz - fm.tangent.z * 4, 2.6, fm.yaw + Math.PI * 1.2);
  {
    // the big ground-level pot: before the works on the outside, clear of the kit's turn signs
    const signs = ctx.stats.props.filter((p) => p[3] === 'sign');
    let f = null, x = 0, z = 0;
    for (const back of [16, 22, 10, 28, 34]) {
      const ff = track.frameAt(Z.s0 - back), lat = ff.wallR + 6.5;
      const xx = ff.x + ff.right.x * lat, zz = ff.z + ff.right.z * lat;
      if (field.wallClearance(xx, zz) > 5.5 && !signs.some(([sx, sz, r]) => Math.hypot(sx - xx, sz - zz) < r + 6)) { f = ff; x = xx; z = zz; break; }
    }
    const g = f ? field.surfaceHeight(x, z) : 0;
    if (f) {
      bucket.push(cyl(4.6, 4.9, 1.0, 12, x, g + 0.3, z, C.stone));
      addPot(x, g + 0.8, z, 3.4, f.yaw + Math.PI * 0.75);
      ctx.prop('moka', x, z, 4.9);
      ctx.exclusions.push([x, z, 6.5]);
      ctx.landmarks.push({ name: 'moka', x, z, r: 4.9, h: 14 });
    }
  }
  pot.geo.dispose();
}

// Brick pizza oven inside the final turn: stone terrace, dome, arched
// mouth with a flickering fire glow, chimney, firewood and a peel.
function buildPizzaOven(ctx, field, L, bucket, stone, steam) {
  const { track } = ctx;
  const O = L.oven;
  const seg = track.segments[segIndex(track, 'Pizza Oven Turn')];
  const mid = track.frameAt((seg.s0 + seg.s1) / 2);
  let fx = mid.x - O.x, fz = mid.z - O.z;
  const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
  const yaw = Math.atan2(fx, fz);
  // as big as the lawn allows (terrace radius + 2 m to its wall), then as
  // close to the apex as possible
  const wallGap = Math.hypot(mid.x - O.x, mid.z - O.z) - mid.wallL;
  const SC = clamp((wallGap - 2.0) / 6.9, 0.8, 1.3), TR = 6.9 * SC;
  const off = clamp(wallGap - TR - 2.0, 0, 6);
  const x = O.x + fx * off, z = O.z + fz * off;
  let g = -Infinity;
  for (let a = 0; a < 6.28; a += 0.8) g = Math.max(g, field.surfaceHeight(x + Math.cos(a) * TR * 0.9, z + Math.sin(a) * TR * 0.9));
  const top = g + 0.55;
  stone.push(paint(place(new THREE.CylinderGeometry(TR - 0.3, TR, top - g + 1.6, 18), x, (top + g - 1.6) / 2, z), C.stoneWarm));
  const parts = [];
  const dome = new THREE.SphereGeometry(4.3, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1, 0.86, 1);
  parts.push(paint(dome.translate(0, top, 0), C.brick));
  parts.push(cyl(4.45, 4.45, 0.5, 16, 0, top + 0.25, 0, C.brickDark));
  // arched mouth frame protruding from the dome front (local +z)
  const outer = new THREE.Shape();
  outer.moveTo(-1.6, 0); outer.lineTo(1.6, 0); outer.lineTo(1.6, 1.7); outer.absarc(0, 1.7, 1.6, 0, Math.PI, false); outer.lineTo(-1.6, 0);
  const hole = new THREE.Path();
  hole.moveTo(-1.0, 0); hole.lineTo(1.0, 0); hole.lineTo(1.0, 1.4); hole.absarc(0, 1.4, 1.0, 0, Math.PI, false); hole.lineTo(-1.0, 0);
  outer.holes.push(hole);
  const frame = new THREE.ExtrudeGeometry(outer, { depth: 2.0, bevelEnabled: false, curveSegments: 6 });
  parts.push(paint(frame.translate(0, top + 0.4, 2.7), C.brickDark));
  // dark throat behind the glow
  parts.push(box(2.0, 2.4, 0.2, 0, top + 1.6, 2.75, 0x2a1408));
  // chimney at the back
  parts.push(cyl(0.55, 0.7, 4.2, 8, 0, top + 4.6, -2.0, C.brickDark));
  parts.push(cyl(0.75, 0.75, 0.3, 8, 0, top + 6.75, -2.0, C.cream));
  // firewood stack + a pizza peel leaning on the terrace
  for (let r = 0; r < 3; r++) for (let k = 0; k < 4 - r; k++) {
    parts.push(cyl(0.2, 0.2, 1.6, 6, 4.4 + k * 0.42 + r * 0.21, top + 0.2 + r * 0.36, 1.2, 0x8a5a32, 0, Math.PI / 2));
  }
  parts.push(box(0.12, 2.6, 0.08, -4.6, top + 1.3, 2.0, 0xb98a55, 0, 0, 0.35));
  parts.push(cyl(0.7, 0.7, 0.06, 12, -4.15, top + 0.25, 2.25, 0xc49660, 0, 1.2));
  const geo = mergeParts(parts);
  geo.translate(0, -top, 0).scale(SC, SC, SC).translate(0, top, 0);
  place(geo, x, 0, z, yaw);
  bucket.push(geo);
  // the fire: two glowing layers in the mouth, flickering
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const fireShape = new THREE.Shape();
  fireShape.moveTo(-1.0, 0); fireShape.lineTo(1.0, 0); fireShape.lineTo(1.0, 1.4); fireShape.absarc(0, 1.4, 1.0, 0, Math.PI, false); fireShape.lineTo(-1.0, 0);
  const fire = paint(new THREE.ShapeGeometry(fireShape, 6).translate(0, top + 0.4, 3.2), C.glow);
  const flame = paint(new THREE.ShapeGeometry(fireShape, 6).scale(0.6, 0.55, 1).translate(0, top + 0.4, 3.35), 0xfff0a0);
  const fireGeo = mergeParts([fire, flame]);
  fireGeo.translate(0, -top, 0).scale(SC, SC, SC).translate(0, top, 0);
  place(fireGeo, x, 0, z, yaw);
  ctx.add(new THREE.Mesh(fireGeo, glowMat), { name: 'OvenFire' });
  ctx.animators.push((dt, time) => {
    const k = 0.82 + 0.12 * Math.sin(time * 13.0) + 0.08 * Math.sin(time * 29.0 + 1.3);
    glowMat.color.setRGB(k, k, k);
  });
  steam.push([x - fx * 2.0 * SC, top + 7.0 * SC, z - fz * 2.0 * SC, 1.3, 0.45]);
  O.x = x; O.z = z;   // (the terrain patio was levelled around the arc centre; radius covers both)
  ctx.prop('oven', x, z, TR);
  ctx.exclusions.push([x, z, TR + 1.6]);
  ctx.landmarks.push({ name: 'oven', x, z, r: TR, h: 10 });
}

// Steam / smoke puffs (one instanced draw call): each source = [x, y, z,
// size, greyness]; puffs rise, drift and swell, then shrink away.
function buildPuffs(ctx, sources) {
  const per = ctx.Q.veg >= 1 ? 5 : 3;
  const n = sources.length * per;
  if (!n) return;
  const geo = new THREE.IcosahedronGeometry(1, 1);
  faceColors(geo, (y, ny) => mixHex(0xd9dee6, 0xffffff, smoothstep((ny + 0.4) / 1.1)));
  paint(geo, null);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true });
  const inst = new THREE.InstancedMesh(geo, mat, n);
  inst.frustumCulled = false;
  const tint = new THREE.Color();
  sources.forEach((src, k) => { for (let j = 0; j < per; j++) inst.setColorAt(k * per + j, tint.setScalar(lerp(0.78, 1.0, src[4]))); });
  const m4 = new THREE.Matrix4();
  const place1 = (time) => {
    for (let k = 0; k < sources.length; k++) {
      const src = sources[k], x = src[0], y = src[1], z = src[2], size = src[3];
      for (let j = 0; j < per; j++) {
        const t = (time * 0.32 + j / per + k * 0.137) % 1;
        const sc = size * (0.35 + t * 1.4) * Math.sin(Math.PI * Math.min(1, t * 1.15));
        place_m4(m4, x + t * size * 2.2, y + t * size * 7.5, z + Math.sin(t * 6 + k) * size * 0.4, t * 3 + k, Math.max(0.001, sc), Math.max(0.001, sc * 0.85), Math.max(0.001, sc));
        inst.setMatrixAt(k * per + j, m4);
      }
    }
    inst.instanceMatrix.needsUpdate = true;
  };
  place1(0);
  ctx.add(inst, { name: 'Steam' });
  ctx.animators.push((dt, time) => place1(time));
  ctx.stats.instances.puffs = n;
}

// Street lamps (instanced): spots = [x, y, z, yaw, scale].
function buildLamps(ctx, spots) {
  if (!spots.length) return;
  const g = mergeParts([
    cyl(0.07, 0.1, 3.4, 6, 0, 1.7, 0, 0x2f4a3a),
    cyl(0.16, 0.2, 0.3, 6, 0, 0.15, 0, 0x2f4a3a),
    box(0.42, 0.55, 0.42, 0, 3.65, 0, 0xfff1b8),
    cyl(0.05, 0.34, 0.25, 4, 0, 4.05, 0, 0x2f4a3a, Math.PI / 4),
  ]);
  const inst = new THREE.InstancedMesh(g, ctx.M.structure, spots.length);
  const m4 = new THREE.Matrix4();
  spots.forEach(([x, y, z, yaw, sc], i) => {
    inst.setMatrixAt(i, place_m4(m4, x, y, z, yaw, sc, sc, sc));
    ctx.prop('lamp', x, z, 0.25 * sc);
  });
  inst.computeBoundingSphere();
  ctx.add(inst, { cast: true, name: 'Lamps' });
  ctx.stats.instances.lamps = spots.length;
}

// ------------------------------------------------------------------ vegetation

// Cypress rows along the vineyard descent and dotted over the hills,
// umbrella pines, olive groves, flowering bushes, vine rows, limestone rocks.
function buildMonteVegetation(ctx, field, L, town, nat, nearest, vineyardAt) {
  const { track, Q } = ctx;
  const rng = makeRng(4242);
  // house lookup grid (24 m cells)
  const HG = 24, hgrid = new Map();
  const hkey = (ix, iz) => ix * 73856093 ^ iz * 19349663;
  for (const h of town.houses) {
    const ix = Math.floor(h.x / HG), iz = Math.floor(h.z / HG);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const k = hkey(ix + a, iz + b);
      if (!hgrid.has(k)) hgrid.set(k, []);
      hgrid.get(k).push(h);
    }
  }
  const nearHouse = (x, z, r) => {
    const list = hgrid.get(hkey(Math.floor(x / HG), Math.floor(z / HG)));
    if (list) for (const h of list) if (rectDistance(h.rect, x, z) < r + 0.5) return true;
    return false;
  };
  const inExcl = (x, z, r) => ctx.exclusions.some(([ex, ez, er]) => (x - ex) * (x - ex) + (z - ez) * (z - ez) < (er + r * 0.5) ** 2);
  const slopeAt = (x, z) => {
    const a = field.surfaceHeight(x + 1.5, z), b = field.surfaceHeight(x - 1.5, z);
    const c = field.surfaceHeight(x, z + 1.5), d = field.surfaceHeight(x, z - 1.5);
    return Math.hypot(a - b, c - d) / 3;
  };
  const V = L.valley;
  const onStream = (x, z) => {
    if (!V) return false;
    const along = (x - V.x) * V.ax + (z - V.z) * V.az, across = (x - V.x) * V.nx + (z - V.z) * V.nz;
    return along > -50 && Math.abs(across - valleyMeander(along)) < 6.5;
  };

  // Geometry (triangles): cypress ~64, pine ~84, olive ~52, bush 40, rock 36.
  const cypress = mergeParts([
    cyl(0.14, 0.2, 1.4, 5, 0, 0.7, 0, C.trunk),
    paint(lumpy(new THREE.ConeGeometry(1.25, 4.6, 7).translate(0, 3.2, 0), 0.12, 1, 1, 1, 3), C.cypress),
    paint(lumpy(new THREE.ConeGeometry(1.0, 4.2, 7).translate(0, 5.7, 0), 0.12, 1, 1, 1, 7), mixHex(C.cypress, 0x3f8a4a, 0.3)),
    paint(lumpy(new THREE.ConeGeometry(0.62, 3.4, 6).translate(0, 8.0, 0), 0.1, 1, 1, 1, 11), mixHex(C.cypress, 0x4f9a52, 0.4)),
  ]);
  const pine = mergeParts([
    paint(place(new THREE.CylinderGeometry(0.2, 0.32, 6.6, 6, 1, true), 0.35, 3.3, 0, 0, 0, -0.1), C.trunk),
    paint(lumpy(new THREE.DodecahedronGeometry(3.2, 0), 0.2, 1, 0.36, 1, 5).translate(0.6, 6.9, 0), C.pine),
    paint(lumpy(new THREE.DodecahedronGeometry(2.0, 0), 0.2, 1, 0.4, 1, 9).translate(-1.2, 6.4, 0.9), mixHex(C.pine, 0x6aa84c, 0.35)),
  ]);
  const olive = mergeParts([
    paint(place(new THREE.CylinderGeometry(0.16, 0.3, 1.7, 5, 1, true), 0, 0.85, 0, 0, 0, 0.15), 0x8a7458),
    paint(lumpy(new THREE.IcosahedronGeometry(1.5, 0), 0.25, 1.15, 0.7, 1.1, 2).translate(0.3, 2.4, 0), C.olive),
    paint(lumpy(new THREE.IcosahedronGeometry(1.1, 0), 0.25, 1.1, 0.75, 1.1, 6).translate(-0.7, 2.1, 0.5), mixHex(C.olive, 0xb5c27a, 0.3)),
  ]);
  const bush = mergeParts([
    paint(lumpy(new THREE.IcosahedronGeometry(1.0, 0), 0.3, 1.25, 0.8, 1.25, 5).translate(0, 0.45, 0), C.bush),
    paint(lumpy(new THREE.IcosahedronGeometry(0.72, 0), 0.3, 1.2, 0.85, 1.2, 9).translate(0.75, 0.35, 0.35), mixHex(C.bush, 0x7cc24a, 0.35)),
  ]);
  const rock = paint(lumpy(new THREE.DodecahedronGeometry(1.0, 0), 0.35, 1.2, 0.72, 1, 3), C.rock);
  const R = { cypress: 1.3, pine: 3.4, olive: 2.1, bush: 1.5, rock: 1.45 };

  const spot = (x, z, type, sc, sink, extra = 1.0) => {
    const r = R[type] * sc, clr = field.wallClearance(x, z);
    if (!(clr > r + extra)) return null;
    if (nearHouse(x, z, r) || inExcl(x, z, r) || nat.piazzaMask(x, z) > 0.2) return null;
    return [x, field.surfaceHeight(x, z) - sink, z, rng() * Math.PI * 2, sc, clr, r];
  };
  const b = track.bounds, ext = 170;
  const pick = (count, accept) => {
    const out = [];
    for (let tries = 0; out.length < count && tries < count * 60; tries++) {
      const x = lerp(b.minX - ext, b.maxX + ext, rng()), z = lerp(b.minZ - ext, b.maxZ + ext, rng());
      const r = accept(x, z);
      if (r) out.push(r);
    }
    return out;
  };
  const Vg = Q.veg;

  // cypress avenue down the vineyards (both sides) + scattered cypress
  const cyp = [];
  const vz = (L.zones.vineyard || [])[0];
  if (vz) {
    const len = track.forwardDistance(vz.s0, vz.s1) + 40;
    for (const side of [-1, 1]) {
      for (let d = 4; d < len; d += Vg >= 1 ? 8.5 : 13) {
        const f = track.frameAt(vz.s0 + d), wall = side > 0 ? f.wallR : f.wallL;
        const lat = side * (wall + 3.4 + rng() * 0.8);
        const p = spot(f.x + f.right.x * lat, f.z + f.right.z * lat, 'cypress', lerp(0.95, 1.25, rng()), 0.2);
        if (p) cyp.push(p);
      }
    }
  }
  cyp.push(...pick(Math.round(140 * Vg), (x, z) => {
    if (onStream(x, z) || vineyardAt(x, z) > 0.3 || slopeAt(x, z) > 0.6) return null;
    const nr = nearest(x, z);
    if (nr.d > 230 || rng() > 0.25 + 0.75 * smoothstep((fbm(x * 0.01 + 3, z * 0.01, 2) - 0.45) / 0.15)) return null;
    return spot(x, z, 'cypress', lerp(0.8, 1.3, rng()), 0.2);
  }));
  const pines = pick(Math.round(70 * Vg), (x, z) => {
    if (onStream(x, z) || vineyardAt(x, z) > 0.2 || slopeAt(x, z) > 0.45) return null;
    if (nearest(x, z).d > 200) return null;
    return spot(x, z, 'pine', lerp(0.85, 1.25, rng()), 0.2);
  });
  const olives = pick(Math.round(110 * Vg), (x, z) => {
    const sl = slopeAt(x, z);
    if (onStream(x, z) || vineyardAt(x, z) > 0.2 || sl > 0.5 || nat.inside(x, z)) return null;
    if (nearest(x, z).d > 170 || fbm(x * 0.015 - 7, z * 0.015 + 2, 2) < 0.45) return null;
    return spot(x, z, 'olive', lerp(0.8, 1.2, rng()), 0.15);
  });
  const bushes = pick(Math.round(170 * Vg), (x, z) => {
    if (slopeAt(x, z) > 0.6) return null;
    const clr = field.wallClearance(x, z);
    if (clr > 40 && rng() < 0.7) return null;
    return spot(x, z, 'bush', lerp(0.7, 1.3, rng()), 0.1);
  });
  const rocks = pick(Math.round(80 * Vg), (x, z) => {
    if (slopeAt(x, z) < 0.3 && rng() < 0.8) return null;
    return spot(x, z, 'rock', lerp(0.7, 2.2, rng() * rng()), 0.35);
  });
  addInstancedSet(ctx, 'Cypress', cypress, cyp, rng, { near: 40, stretch: [0.85, 1.25] });
  addInstancedSet(ctx, 'Pines', pine, pines, rng, { near: 45 });
  addInstancedSet(ctx, 'Olives', olive, olives, rng, { near: 30 });
  addInstancedSet(ctx, 'Bushes', bush, bushes, rng, { near: 22, tints: [0xffffff, 0xffffff, 0xffc6e0, 0xfff0f4, 0xffd9a0], tint: [0.85, 1.15] });
  addInstancedSet(ctx, 'Rocks', rock, rocks, rng, { near: 0 });

  // vine rows: east-west rows 4.6 m apart, split into up-to-10 m segments
  // that follow the slope (one instance each)
  const vineSegs = [];
  const ROW = Vg >= 1 ? 4.6 : 7.0, STEP = 2.0;
  for (let z = b.minZ - 70; z < b.maxZ + 70; z += ROW) {
    let run = null;
    const flush = () => {
      if (run && run.x1 - run.x0 >= 3.5) {
        const x0 = run.x0, x1 = run.x1, zz = run.z;
        for (let a = x0; a < x1 - 1; a += 10) {
          const e = Math.min(x1, a + 10), mid = (a + e) / 2, l = e - a;
          const y0 = field.surfaceHeight(a, zz), y1 = field.surfaceHeight(e, zz);
          vineSegs.push([mid, (y0 + y1) / 2, zz, l, Math.atan2(y1 - y0, l)]);
          ctx.prop('vines', mid, zz, 0.6);
        }
      }
      run = null;
    };
    for (let x = b.minX - 70; x < b.maxX + 70; x += STEP) {
      const ok = vineyardAt(x, z) > 0.5 && !onStream(x, z) && field.wallClearance(x, z) > 2.6 &&
        !nearHouse(x, z, 1.2) && !inExcl(x, z, 1.0) && slopeAt(x, z) < 0.45;
      if (ok) { if (!run) run = { x0: x, x1: x, z }; else run.x1 = x; } else flush();
    }
    flush();
  }
  if (vineSegs.length) {
    const vg = new THREE.BoxGeometry(0.75, 1.15, 1, 1, 1, 3);
    {
      const p = vg.attributes.position;
      for (let i = 0; i < p.count; i++) {
        if (p.getY(i) > 0) p.setY(i, p.getY(i) + (hash2(Math.round(p.getZ(i) * 10), Math.round(p.getX(i) * 10)) - 0.5) * 0.25);
      }
      vg.computeVertexNormals();
    }
    const vineGeo = paint(vg.translate(0, 0.62, 0), C.vine);
    const inst = new THREE.InstancedMesh(vineGeo, ctx.M.veg, vineSegs.length);
    const q = new THREE.Quaternion(), e = new THREE.Euler(), p3 = new THREE.Vector3(), s3 = new THREE.Vector3(), m4 = new THREE.Matrix4(), col = new THREE.Color();
    vineSegs.forEach(([x, y, z, l, pitch], i) => {
      e.set(-pitch, Math.PI / 2, 0, 'YXZ');
      q.setFromEuler(e);
      inst.setMatrixAt(i, m4.compose(p3.set(x, y - 0.05, z), q, s3.set(1, lerp(0.9, 1.1, rng()), l)));
      inst.setColorAt(i, col.setRGB(lerp(0.9, 1.08, rng()), lerp(0.92, 1.05, rng()), lerp(0.85, 1.0, rng())));
    });
    inst.computeBoundingSphere();
    ctx.add(inst, { cast: false, receive: false, name: 'Vines' });
    ctx.stats.instances.vines = vineSegs.length;
  }
}

// ------------------------------------------------------------------ scenery

// Rolling green-gold hills around the course, hazy blue mountains behind,
// and a tiny far-off hill town on the horizon south of the piazza.
function buildHills(ctx, track) {
  const rng = makeRng(919);
  const b = track.bounds, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const geos = [];
  const hill = (x, z, r, h, seg) => geos.push(mountainGeometry(x, z, r, h, seg, (t, ny, y) => {
    if (t > 0.72) return mixHex(0x5f9443, 0x4f8439, hash2(Math.round(y), 1));
    if (ny < 0.5) return mixHex(0x7fa255, 0x6f9449, hash2(Math.round(y * 2), 5));
    return mixHex(0x8fbd58, 0xc9c266, hash2(Math.round(y * 3), 9) * 0.6);
  }));
  const far = (x, z, r, h, seg) => geos.push(mountainGeometry(x, z, r, h, seg, (t, ny, y) => {
    if (t > 0.82) return 0xd4dde6;
    if (ny < 0.5) return mixHex(0x6f86a0, 0x7a90a8, hash2(Math.round(y), 3));
    return mixHex(0x7d94ad, 0x8ea3b8, hash2(Math.round(y), 7));
  }));
  for (let k = 0; k < 30; k++) {
    const a = (k / 30) * Math.PI * 2 + (rng() - 0.5) * 0.15;
    const r = lerp(560, 900, rng()), h = lerp(40, 120, rng());
    hill(cx + Math.cos(a) * r, cz + Math.sin(a) * r, h * lerp(2.6, 3.6, rng()), h, 9);
  }
  for (let k = 0; k < 22; k++) {
    const a = (k / 22) * Math.PI * 2 + (rng() - 0.5) * 0.2;
    const r = lerp(1150, 1450, rng()), h = lerp(150, 280, rng());
    far(cx + Math.cos(a) * r, cz + Math.sin(a) * r, h * lerp(1.5, 2.1, rng()), h, 8);
  }
  // far hill town (south, ahead of the start grid)
  {
    const tx = cx - 120, tz = cz + 760, th = 75;
    hill(tx, tz, th * 2.8, th, 10);
    const top = th - 14 - 6;
    for (let k = 0; k < 14; k++) {
      const a = rng() * Math.PI * 2, d = rng() * 26;
      const w = lerp(6, 11, rng()), h = lerp(6, 11, rng());
      geos.push(box(w, h, w * 0.8, tx + Math.cos(a) * d, top + h / 2 - d * 0.25, tz + Math.sin(a) * d, pickCol(C.walls, rng()), a));
      geos.push(paint(place(new THREE.ConeGeometry(w * 0.72, 2.6, 4), tx + Math.cos(a) * d, top + h + 1.3 - d * 0.25, tz + Math.sin(a) * d, a + Math.PI / 4), C.roofs[k % C.roofs.length]));
    }
    geos.push(box(4, 26, 4, tx, top + 13, tz, C.towerA));
    geos.push(paint(place(new THREE.ConeGeometry(3.2, 5, 4), tx, top + 28.5, tz, Math.PI / 4), C.roofs[0]));
  }
  addMerged(ctx, geos, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), { name: 'Hills' });
}

// Paving slab under the piazza and a round plaza around the fountain
// (top at -0.06 m, 6 cm under the road; sides act as low kerbs).
function buildPaving(ctx, L, material) {
  const st = L.start;
  const parts = [];
  const wA = PIAZZA.a1 - PIAZZA.a0, wL = PIAZZA.l1 - PIAZZA.l0;
  const ac = (PIAZZA.a0 + PIAZZA.a1) / 2, lc = (PIAZZA.l0 + PIAZZA.l1) / 2;
  const yaw = Math.atan2(st.tx, st.tz);
  const slab = new THREE.BoxGeometry(wL, 0.9, wA);
  place(slab, st.x + st.tx * ac + st.rx * lc, -0.51, st.z + st.tz * ac + st.rz * lc, yaw);
  parts.push(slab);
  if (L.fountain) parts.push(new THREE.CylinderGeometry(FOUNTAIN_PLAZA_R, FOUNTAIN_PLAZA_R, 0.9, 40).translate(L.fountain.x, -0.51, L.fountain.z));
  const A = L.alta;
  if (A) {
    // Piazza Alta: left of the summit straight, from just past the barrier line
    const la = (A.a0 + A.a1) / 2, ll = (A.l0 + A.l1) / 2;
    const g = new THREE.BoxGeometry(A.l1 - A.l0, 0.9, A.a1 - A.a0);
    place(g, A.x + A.tx * la - A.rx * ll, A.y - 0.51, A.z + A.tz * la - A.rz * ll, Math.atan2(A.tx, A.tz));
    parts.push(g);
  }
  for (const g of parts) {
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 4, p.getZ(i) / 4);
  }
  addMerged(ctx, parts, material, { receive: true, name: 'Paving' });
}

// The stream along the valley floor (one ribbon following the meander).
function streamGeometry(field, V) {
  const rows = [];
  for (let a = -48; a <= 360; a += 4) rows.push(a);
  const cols = [-1.8, -0.6, 0.6, 1.8];
  const pos = [], idx = [];
  for (const a of rows) {
    const m = valleyMeander(a);
    for (const c of cols) {
      const x = V.x + V.ax * a + V.nx * (m + c), z = V.z + V.az * a + V.nz * (m + c);
      pos.push(x, field.surfaceHeight(x, z) + 0.14, z);
    }
  }
  const nc = cols.length;
  for (let r = 0; r < rows.length - 1; r++) for (let c = 0; c < nc - 1; c++) {
    const i = r * nc + c;
    idx.push(i, i + nc, i + 1, i + 1, i + nc, i + nc + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure the faces point up whatever the axis handedness
  if (g.attributes.normal.getY(0) < 0) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.computeVertexNormals(); }
  return paint(g, C.water);
}

// ------------------------------------------------------------------ buildMonteWorld

export function buildMonteWorld(scene, track, opts = {}) {
  const ctx = createWorldContext(scene, track, opts);
  const { Q } = ctx, sp = track.spacing;
  const L = monteLayout(track);
  const rng = makeRng(1897);
  // the course set pieces (hazards/hilltown.js): the same pure set the game and the sim run
  const hz = createHazards(track);
  SP.registerMonteSounds();

  // Warm sun ~57° high from the east (Breezy's mirror image): on the start /
  // home straights kart shadows fall beside the karts in the chase view, on
  // Laundry Lane behind them, and the piazza's west frontage is sunlit.
  const sunDir = new THREE.Vector3(0.46, 0.84, -0.22).normalize();
  buildSky(ctx, { sunDir, top: C.skyTop, horizon: C.skyHorizon, bottom: C.skyBottom, sunColor: 0xfff0d0, fogNear: 300, fogFar: 1750 });
  const { sun, hemi, follow } = buildLights(ctx, { sunDir, sunColor: C.sun, sunIntensity: 2.65, hemiSky: C.hemiSky, hemiGround: C.hemiGround, hemiIntensity: 1.4 });
  const a = ctx.maxAniso;
  const T = createTrackTextures(ctx, {
    road: TX.createCobbleTexture({ aniso: a }),
    wall: TX.createTownWallAtlasTexture({ aniso: a }),
    banner: { bg: ['#e2683c', '#a33a22'], outline: '#5a1a08' },
  });
  const stoneTex = ctx.tex(TX.createStoneBlockTexture({ aniso: a }));
  stoneTex.repeat.set(0.25, 0.25);
  const M = {
    stone: new THREE.MeshLambertMaterial({ map: stoneTex, vertexColors: true }),
    paving: new THREE.MeshLambertMaterial({ map: ctx.tex(TX.createPavingTexture({ aniso: a })), color: 0xe4d9c6 }),
    water: new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0d3f52 }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    // houses + props: terracotta tiles, stucco and painted windows from one atlas
    town: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, alphaTest: 0.5, map: ctx.tex(MT.createTownAtlasTexture({ aniso: a })) }),
  };

  // nearest centerline sample (every 2nd) -> { i, s, d }
  const NS = 2;
  const nearest = (x, z) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < track.N; i += NS) {
      const dx = x - track.px[i], dz = z - track.pz[i], d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    return { i: bi, s: bi * sp, d: Math.sqrt(bd) };
  };
  const V = L.valley;
  const vineyardAt = (x, z) => {
    const nr = nearest(x, z);
    if (zoneTypeAt(track, nr.s) !== 'vineyard') return 0;
    let w = smoothstep((52 - nr.d) / 14);
    if (V) {
      const along = (x - V.x) * V.ax + (z - V.z) * V.az, across = Math.abs((x - V.x) * V.nx + (z - V.z) * V.nz);
      if (along > -45) w *= smoothstep((across - V.half - 4) / 8);
    }
    return w;
  };

  // terrain
  const nat = monteNatural(track, L);
  // (a slightly coarser grid than the kit's: the longer v5 loop spreads the
  // terrain over a bigger core; the triangle budget goes to the set pieces)
  const field = createTerrainField(track, Q.terrainCell * 1.15, {
    natural: nat.natural,
    signedDist: () => 1,
    extent: 1800,
    sections: (tr, { bridge }) => {
      for (let i = 0; i < tr.N; i++) for (const z of tr.zones) if (z.type === 'bridge') bridge[i] = Math.max(bridge[i], zoneInterior(tr, z, i * sp, 14));
    },
    bridgeFloor: (y0) => y0 - 1.6,
  });
  ctx.add(new THREE.Mesh(terrainGeometry(field, monteTerrainColor(track, L, vineyardAt, nat.inside)),
    new THREE.MeshLambertMaterial({ vertexColors: true, map: T.detail, flatShading: true })), { receive: true, name: 'Terrain' });
  buildPaving(ctx, L, M.paving);

  // road: cobbles; stone deck strips on the aqueduct, factory floor in the
  // covered section (darkened there when there is no shadow map)
  const inType = (type, s) => (L.zones[type] || []).some((z) => inZone(track, z, s));
  const tunnelShade = (s) => {
    const z = L.tunnel;
    if (!z) return 1;
    return 1 - 0.5 * zoneInterior(track, z, s, 3);
  };
  buildRoad(ctx, T, {
    offroadColor: (s) => (inType('bridge', s) ? 0xd2c4a6 : inType('tunnel', s) ? 0xb9b1a4 : inType('piazza', s) || inType('piazza-alta', s) ? 0x94d05a : C.grass),
    shade: ctx.shadows ? null : tunnelShade,
  });
  // zone surfaces over the cobbles: fan setts in the piazzas, slabs on the
  // aqueduct, herringbone brick in the works, scooter lanes on Via Vespa
  {
    const ranges = (type) => (L.zones[type] || []).map((z) => [z.s0, z.s0 + track.forwardDistance(z.s0, z.s1)]);
    const viaVespa = track.segments[segIndex(track, 'Via Vespa')];
    // (the start line and the grid keep the plain cobbles: their marks are decals too)
    const pz = [], gridS = track.gridSlot(7).s - 3;
    for (const [s0, s1] of ranges('piazza')) {
      if (s0 < 5) pz.push([5, s1]);
      else if (s1 - s0 > 4 && s1 < gridS) pz.push([s0, Math.min(s1, gridS)]);
    }
    SP.buildRoadDecals(ctx, {
      setts: [...pz, ...ranges('piazza-alta')],
      slabs: ranges('bridge'),
      brick: ranges('tunnel').map(([s0, s1]) => [s0 - 2, s1 + 2]),
      lanes: viaVespa ? [[viaVespa.s0 + 6, viaVespa.s1 - 2]] : [],
    }, { shade: ctx.shadows ? null : tunnelShade });
  }
  buildStartLine(ctx, T);

  // barrier gaps: the scooter alleys on Via Vespa and the dairy's chute gates
  const gaps = [];
  for (const h of hz.list) {
    if (h.type === 'mover') {
      const side = Math.sign(h.lateral) || -1, Mv = HILLTOWN_TUNE.mover;
      gaps.push({ s: h.s - Mv.alley, side, half: 2.15 }, { s: h.s + h.length + Mv.alley, side, half: 2.15 });
    } else if (h.type === 'wheel') gaps.push({ s: h.s, side: h.from || -1, half: 1.4 });
  }
  const inGap = (s, side) => gaps.some((g) => g.side === side && Math.abs(track.deltaS(g.s, s)) <= g.half);

  // barriers by area
  const segOf = (i) => { let k = 0; while (k + 1 < track.segments.length && track.segments[k + 1].s0 <= i * sp) k++; return k; };
  const segName = track.segments.map((sg) => sg.name);
  buildWalls(ctx, T, (i, side) => {
    const s = i * sp;
    if (inType('bridge', s)) return 'none';                  // aqueduct parapets
    if (inGap(s, side)) return 'none';                       // alley mouths / chute gates
    if (inType('tunnel', s)) return 'brick';
    if (inType('hairpin', s)) return 'stone';                // the tornanti: dry-stone walls (no tyre stacks in town)
    if (inType('piazza', s) || inType('piazza-alta', s)) return 'balustrade';
    if (inType('village', s)) return 'stucco';
    const n = segName[segOf(i)];
    if (n === 'Fontana Turn' || n === 'Pizza Oven Turn' || n === 'Home Straight' || n === 'Piazza Straight') return 'balustrade';
    if (n === 'Belvedere Turn' && side > 0) return 'balustrade';
    return 'stone';
  }, {
    balustrade: { band: TX.TOWN_WALL_BANDS.balustrade, h: 0.95 },
    stucco: { band: TX.TOWN_WALL_BANDS.stucco, h: 0.95 },
    stone: { band: TX.TOWN_WALL_BANDS.stone, h: 0.95 },
    brick: { band: TX.TOWN_WALL_BANDS.brick, h: 0.95 },
  });
  buildBoostPads(ctx, T);
  buildRamps(ctx, T);
  const bel = L.belvedere;
  // (no turn signs inside the works / on the aqueduct / round the Belvedere terrace, nor where the
  // scooter alleys open or the factory hall stands before the pizza-oven turn)
  buildTurnSigns(ctx, T, { skip: (s) => inType('tunnel', s) || inType('tunnel', s + 12) || inType('tunnel', s - 20) || inType('bridge', s) ||
    (bel && track.forwardDistance(bel.s0 - 20, s) < bel.s1 - bel.s0 + 20) || gaps.some((g) => Math.abs(track.deltaS(g.s, s)) < g.half + 5) });
  buildGantry(ctx, T, { pillarA: 0xc8643c, pillarB: C.cream, base: C.stoneDark, beam: 0x6b4a36, frame: 0x7a2a18, extra: gantryPizza });

  // landmarks (registered as exclusions before the houses go in); every
  // geometry in the town bucket gets town-atlas UVs (plain parts: white)
  const townBucket = regionBuckets(ctx, M.town, { name: 'Town' });
  const bucket = { push(g) { if (!MT.hasAtlas(g)) uvWhite(g); townBucket.push(g); }, flush: () => townBucket.flush() };
  const stone = [], water = [], glow = [], lamps = [], steam = [];
  if (L.fountain) buildFountain(ctx, L.fountain, bucket, water);
  buildPiazzaWall(ctx, field, L, stone);
  buildCafe(ctx, L, bucket, rng);
  buildFoodProps(ctx, field, bucket, rng);
  if (L.tower) buildCampanile(ctx, field, L.tower, bucket, stone);
  if (L.bridge && L.valley) buildAqueduct(ctx, L, stone, lamps);
  if (L.tunnel) buildFactory(ctx, field, L, bucket, glow, steam);
  if (L.oven) buildPizzaOven(ctx, field, L, bucket, stone, steam);
  // v5 landmarks: the scooter alleys + shop, the dairy and its chutes, the
  // Belvedere terrace, Piazza Alta's church and café, the tornanti shrines
  const alleys = SP.buildScooterAlleys(ctx, field, hz, bucket);
  const dairy = SP.buildDairy(ctx, field, hz, bucket, stone);
  if (bel) SP.buildBelvedere(ctx, field, bel, 1, { bucket, stone, lamps });
  if (L.alta) SP.buildPiazzaAlta(ctx, field, L.alta, { bucket, stone, lamps, rng });
  SP.buildShrines(ctx, field, L.tornanti.map(({ seg, dir }) => ({ s: (seg.s0 + seg.s1) / 2, side: dir === 'left' ? 1 : -1 })), bucket);
  {
    // pictogram warnings ~50 m before each set piece
    const first = (type) => hz.list.filter((h) => h.type === type).reduce((m, h) => (m && m.s < h.s ? m : h), null);
    const warn = [['mover', 'scooter', 45], ['jet', 'fountain', 50], ['wheel', 'wheel', 50]]
      .map(([type, kind, d]) => { const h = first(type); return h ? { s: h.s - d, kind } : null; }).filter(Boolean);
    SP.buildWarningSigns(ctx, warn, bucket);
  }
  // piazza lamps just outside the balustrades
  for (const z of L.zones.piazza || []) {
    const len = track.forwardDistance(z.s0, z.s1);
    for (let d = 6; d < len - 2; d += 14) {
      const s = z.s0 + d;
      if (Math.abs(track.deltaS(s, 0)) < 6) continue;
      const f = track.frameAt(s);
      for (const side of [-1, 1]) {
        const lat = side * ((side > 0 ? f.wallR : f.wallL) + 1.2);
        const x = f.x + f.right.x * lat, zz = f.z + f.right.z * lat;
        if (ctx.exclusions.some(([ex, ez, er]) => Math.hypot(x - ex, zz - ez) < er)) continue;
        lamps.push([x, -0.06, zz, f.yaw, 1]);
        ctx.exclusions.push([x, zz, 1.0]);
      }
    }
  }
  // festive flags at the piazza corners
  {
    const st = L.start;
    for (const [aa, ll] of [[PIAZZA.a0 + 3, 21], [PIAZZA.a1 - 3, 21], [PIAZZA.a0 + 3, PIAZZA.l1 - 10], [PIAZZA.a1 - 3, PIAZZA.l1 - 10]]) {
      const x = st.x + st.tx * aa + st.rx * ll, z = st.z + st.tz * aa + st.rz * ll;
      ctx.flagSpots.push([x, -0.06, z, Math.atan2(st.tx, st.tz), true]);
    }
  }

  // the town
  const town = createTown(ctx, field, bucket, rng);
  const street = layoutTown(ctx, field, L, town, rng, nat, nearest);
  buildLaundry(ctx, street, bucket, rng);
  ctx.stats.instances.houses = town.houses.length;
  bucket.flush();
  if (V) water.push(streamGeometry(field, V));
  // (a material whose mesh ends up empty is disposed right away)
  if (!addMerged(ctx, stone, M.stone, { cast: true, receive: true, name: 'Stonework' })) M.stone.dispose();
  if (!addMerged(ctx, water, M.water, { receive: true, name: 'Water' })) M.water.dispose();
  if (!addMerged(ctx, glow, M.glow, { name: 'Lights' })) M.glow.dispose();
  buildLamps(ctx, lamps);
  buildPuffs(ctx, steam);
  buildFlags(ctx, ctx.flagSpots, [0xff3b30, 0xffcc00, 0x2f80ff, 0x34c759, 0xff9500, 0xff2d92]);

  // the moving set pieces, drawn at the hazard clock (ticked here only when
  // nobody drives it, e.g. the dev sandbox), plus their telegraph sounds
  const updaters = [
    SP.buildScooters(ctx, hz, alleys.parked),
    SP.buildFountainJets(ctx, hz),
    SP.buildCheeseWheels(ctx, field, hz, dairy),
  ].filter(Boolean);
  const audio = SP.hazardAudio(ctx, hz);
  ctx.animators.push((dt) => {
    if (!hz.driven) hz.time += dt;
    for (const u of updaters) u(hz.time);
    audio();
  });
  for (const u of updaters) u(hz.time);
  ctx.stats.hazards = hz.list.length;

  buildMonteVegetation(ctx, field, L, town, nat, nearest, vineyardAt);
  buildHills(ctx, track);
  const b = track.bounds;
  buildClouds(ctx, { center: { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 }, sunDir, count: Math.round(Q.clouds * 0.65) });

  return finishWorld(ctx, {
    sun, hemi, follow,
    getGroundHeight: (x, z) => field.surfaceHeight(x, z),
    extra: { hazards: hz },
  });
}
