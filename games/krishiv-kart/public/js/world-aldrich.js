// World builder for "Aldrich Park" (browser only), theme 'campus' (SPEC §15.3,
// §16.1). Dispatched by worlds.js. Same contract as world.js / world-monte.js:
// { sun, hemi, root, update, dispose, getGroundHeight, landmarks, stats,
// quality } plus
//
//   world.hazards = createHazards(track)   // hazards.js → hazards/campus.js (cyclists, ducks, sprinklers)
//
// The app advances the hazard clock with the race and applies the effects; this
// kit draws the set pieces at hazards.time (and ticks the clock itself only when
// nobody drives it, e.g. on the dev page) and rings their telegraph sounds
// (bike bells, quacks, sprinkler ticks) through the 'item:sfx' bus event.
//
// Built from the real place (notes/research-v5-aldrich.md, world-aldrich-data.js:
// OpenStreetMap © OpenStreetMap contributors, ODbL; USGS 3DEP lidar):
//   * the ground is the lidar terrain: the park's bowl falling north to the
//     swale, the Ring Mall rolling round it, the Engineering Service Road
//     passing 8 m under the Ring's Engineering Bridge;
//   * every building of the campus core is its real OSM footprint extruded to
//     its real (or estimated) height — 1960s precast with deep window hoods,
//     the postmodern infill, the glass library — generic, no names or logos;
//   * 900 mapped trees (eucalyptus on the old park edges, sycamores and oaks
//     to the east, jacarandas on the Ring) plus the mapped groves, lawns,
//     gardens, plazas, parking lots, the un-driven half of the Ring Mall and
//     the web of footways, lamps, benches and bike racks at their real spots;
//   * landmarks: the Infinity Fountain (a figure-eight loop splashing into a
//     shallow blue pool), the Rock Garden on the central knoll (mossy boulders,
//     a blank plaque, a citrus tree), the four robed figures of the sculpture
//     garden, the Humanities Bridge arch, the flagpoles at the gateway, the
//     campus radio mast, the Alumni Grove plaque;
//   * the set pieces: bike crossings painted on the Ring, the mallard pair,
//     pop-up impact sprinklers on the gravel spine; the dry creek under the
//     Arroyo Jump; rabbits on the lawns;
//   * far away: the San Joaquin Hills to the south, a business-park skyline.
//
// Quality 'low' (split-screen): no shadow map, coarser terrain, fewer trees /
// props. Budget at 'high': ≤ 120 draw calls, ≤ 280k triangles.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, clamp, lerp, smoothstep } from './utils.js';
import { createHazards } from './hazards.js';
import { CAMPUS_TUNE, cyclistRider } from './hazards/campus.js';
import { bus } from './bus.js';
import { registerSound, SYNTH } from './audio.js';
import {
  createWorldContext, buildSky, buildLights, createTrackTextures, buildRoad, buildStartLine, buildWalls,
  buildBoostPads, buildRamps, buildTurnSigns, buildGantry, buildClouds, mountainGeometry, lumpy,
  addInstancedSet, finishWorld, createTerrainField, terrainGeometry, trackStrip, sRange, regionBuckets,
  place, paint, faceColors, mixHex, place_m4, addMerged, fbm, hash2,
  box, cyl, ball, cone, mergeParts, zonesByType, inType, zoneInterior, roadDecal, decalMaterial,
} from './world.js';
import * as AT from './world-aldrich-textures.js';
import {
  ALDRICH_BUILDINGS, ALDRICH_POINTS, ALDRICH_AREAS, ALDRICH_WAYS, ALDRICH_TERRAIN, ALDRICH_LANDMARKS,
} from './world-aldrich-data.js';

// ------------------------------------------------------------------ palette

const C = {
  skyTop: 0x3f8edf, skyHorizon: 0xd9e9f1, skyBottom: 0xcde0e6,
  sun: 0xfff1d8, hemiSky: 0xdcebff, hemiGround: 0x8f9a60,
  lawn: 0x6fb648, lawnAlt: 0x86c452, lawnDeep: 0x56a03e, meadow: 0x9cc25a, dryGrass: 0xc8b878, chaparral: 0x8f9a5a,
  litter: 0x9a8a62, mulch: 0x7d6446, soil: 0xa88a60, garden: 0x4f9a3c, shrub: 0x7f9c52,
  plaza: 0xd8cfbe, parking: 0x6e6f72, pitch: 0x5fb94a, sand: 0xd6c39a, rock: 0xa49a8a,
  concrete: 0xdcd5c4, concreteDark: 0xa9a294, fascia: 0xf0ede4, rail: 0xf6f6f1, roof: 0x8d8a83, roofDark: 0x6f6c66,
  terracotta: 0xb9603a, steel: 0x5b6670, timber: 0x9a6a40, timberDark: 0x6e4a2c, bronze: 0x6f5a3c, stone: 0xa8a39a,
  eucTrunk: 0xe1d9c8, eucLeaf: 0x87aa92, oak: 0x5a9a42, sycamore: 0x7fb24e, jacaranda: 0xb898dc, pine: 0x3e7a45,
  fig: 0x3f7a3a, citrus: 0x4f8f3c, trunk: 0x6b4a32,
};
// facade tints per role (vertex colour × the atlas)
const ROLE_STYLE = {
  library: ['glass', [0xe8e4dc, 0xd9d6cf]], study: ['glass', [0xe2ddd2]],
  modern: ['modern', [0xf1e6d2, 0xe8d3b6, 0xd9c3a4, 0xc9d3d8, 0xefe2cc, 0xe6c9ae]],
  retail: ['modern', [0xefe1c8]], greenhouse: ['glass', [0xeef3f0]], parking: ['modern', [0xd6d2ca]],
};
const HOOD_TINTS = [0xf0e8d8, 0xe9dcc2, 0xe2d2b4, 0xf3ede2, 0xe6d8bf, 0xead6b6];
const FLOOR = 3.8, BAY = 4.0;

// ------------------------------------------------------------------ layout

function aldrichLayout(track) {
  const Z = zonesByType(track);
  const sections = (track.def.sections || []).map((o) => ({ name: o.name, s0: track.sOfKey(o, '0'), s1: track.sOfKey(o, '1') }));
  const sec = (name) => sections.find((x) => x.name === name) || null;
  const is = (type, s) => inType(track, Z, type, s);
  const hazDefs = track.def.hazards || [];
  const crossings = hazDefs.filter((d) => d.type === 'cyclist').map((d) => track.sOfKey(d));
  // the Arroyo Jump (the full-width kicker in the arroyo zone; the other is the Ecology Sweep side hop)
  const ramp = track.ramps.find((r) => r.fullWidth && is('arroyo', r.s0)) || track.ramps.find((r) => r.fullWidth) || null;
  return { Z, sections, sec, is, crossings, ramp };
}
const inCrossing = (L, track, s, half = 3.0) => L.crossings.some((c) => Math.abs(track.deltaS(c, s)) < half);

// ------------------------------------------------------------------ area raster (OSM areas + paths)

// A 2 m raster over the data window: the OSM area kind under each cell (for
// terrain colours and planting) and the cells within ~2 m of a mapped path.
const AREA_CODE = { none: 0, grass: 1, garden: 2, shrub: 3, wood: 4, pitch: 5, track: 6, parking: 7, plaza: 8, pool: 9, water: 9 };
const AREA_ORDER = ['grass', 'garden', 'shrub', 'wood', 'pitch', 'track', 'parking', 'plaza', 'pool', 'water'];
function buildAreaRaster() {
  const X0 = -480, Z0 = -480, CELL = 2, N = 480;
  const kind = new Uint8Array(N * N), path = new Uint8Array(N * N);
  const fillPoly = (poly, code) => {
    let zMin = Infinity, zMax = -Infinity;
    for (const [, z] of poly) { zMin = Math.min(zMin, z); zMax = Math.max(zMax, z); }
    const j0 = Math.max(0, Math.floor((zMin - Z0) / CELL)), j1 = Math.min(N - 1, Math.ceil((zMax - Z0) / CELL));
    const xs = [];
    for (let j = j0; j <= j1; j++) {
      const z = Z0 + (j + 0.5) * CELL;
      xs.length = 0;
      for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
        const [xi, zi] = poly[i], [xk, zk] = poly[k];
        if ((zi > z) !== (zk > z)) xs.push(xi + ((z - zi) / (zk - zi)) * (xk - xi));
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil((xs[q] - X0) / CELL - 0.5)), i1 = Math.min(N - 1, Math.floor((xs[q + 1] - X0) / CELL - 0.5));
        for (let i = i0; i <= i1; i++) kind[j * N + i] = code;
      }
    }
  };
  for (const k of AREA_ORDER) for (const a of ALDRICH_AREAS) if (a.k === k) fillPoly(a.p, AREA_CODE[k] || 0);
  for (const w of ALDRICH_WAYS) {
    if (w.l < 0) continue;
    const half = w.c === 'road' ? 6 : w.c === 'service' ? 3.5 : 2;
    for (let k = 0; k < w.p.length - 1; k++) {
      const [x0, z0] = w.p[k], [x1, z1] = w.p[k + 1];
      const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(len / 1));
      for (let t = 0; t <= n; t++) {
        const x = x0 + ((x1 - x0) * t) / n, z = z0 + ((z1 - z0) * t) / n;
        const r = Math.ceil(half / CELL);
        const ci = Math.floor((x - X0) / CELL), cj = Math.floor((z - Z0) / CELL);
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
          const i = ci + di, j = cj + dj;
          if (i >= 0 && j >= 0 && i < N && j < N) path[j * N + i] = 1;
        }
      }
    }
  }
  const at = (arr) => (x, z) => {
    const i = Math.floor((x - X0) / CELL), j = Math.floor((z - Z0) / CELL);
    return i >= 0 && j >= 0 && i < N && j < N ? arr[j * N + i] : 0;
  };
  return { kindAt: at(kind), pathAt: at(path), inside: (x, z) => x > X0 && z > Z0 && x < X0 + N * CELL && z < Z0 + N * CELL };
}

// ------------------------------------------------------------------ lidar terrain

// The USGS lidar samples (park grid, Ring Mall profile, bands at r 205 / 320
// about the Ring centre) interpolated into a continuous ground; far out it
// settles into gentle suburb, with the San Joaquin Hills rising to the south.
function makeLidar() {
  const T = ALDRICH_TERRAIN, G = T.parkGrid;
  const RR = [259, 258, 254, 253, 258, 264, 271, 276, 281, 279, 275, 270, 265, 260, 256, 250, 254, 258, 262, 266, 267, 268, 270, 270, 271, 270, 270, 269, 270, 270, 270, 269, 267, 264, 263, 261];
  const RC = ALDRICH_LANDMARKS.ringCentre;
  const grid = (x, z) => {
    const fx = (x + 150) / 20, fz = (z + 150) / 20;
    const i0 = Math.floor(fx), j0 = Math.floor(fz), tx = fx - i0, tz = fz - j0;
    let sw = 0, sh = 0;
    for (let k = 0; k < 4; k++) {
      const di = k & 1, dj = k >> 1, i = i0 + di, j = j0 + dj;
      if (i < 0 || j < 0 || i > 15 || j > 15) continue;
      const v = G[j][i];
      if (v === null || v === undefined) continue;
      const w = (di ? tx : 1 - tx) * (dj ? tz : 1 - tz);
      sw += w; sh += w * v;
    }
    return sw > 0.08 ? sh / sw : NaN;
  };
  const circ = (arr, step, b) => {
    const f = b / step, i0 = Math.floor(f), t = f - i0, n = arr.length;
    return lerp(arr[((i0 % n) + n) % n], arr[(((i0 + 1) % n) + n) % n], t);
  };
  // the park edge profile (grid at ~135 m from the Ring centre) per 5° of bearing
  const EDGE = [];
  for (let b = 0; b < 360; b += 5) {
    const t = (b * Math.PI) / 180;
    let h = NaN;
    for (let r = 135; r > 60 && !Number.isFinite(h); r -= 5) h = grid(RC.x + r * Math.sin(t), RC.z - r * Math.cos(t));
    EDGE.push(Number.isFinite(h) ? h : 8);
  }
  const far = T.band320.reduce((a, v) => a + v, 0) / T.band320.length;
  return (x, z) => {
    const dx = x - RC.x, dz = z - RC.z, r = Math.hypot(dx, dz);
    const b = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
    const hEdge = circ(EDGE, 5, b), y205 = circ(T.band205, 10, b), rr = circ(RR, 10, b), yRing = circ(T.ringY, 3, b), y320 = circ(T.band320, 10, b);
    let h;
    if (r <= 205) h = lerp(hEdge, y205, smoothstep((r - 135) / 70));
    else if (r <= rr) h = lerp(y205, yRing, (r - 205) / (rr - 205));
    else if (r <= 320) h = lerp(yRing, y320, (r - rr) / (320 - rr));
    else h = lerp(y320, far, smoothstep((r - 320) / 420));
    if (r < 150) {
      const g = grid(x, z);
      if (Number.isFinite(g)) h = lerp(g, h, smoothstep((r - 120) / 30));
    }
    return h;
  };
}

// The Engineering Service Road cut under the Engineering Bridge: bottom at the
// lidar's 26 m a.s.l. under the deck, ramping up to grade both ways.
function serviceCut(x, z) {
  const B = ALDRICH_LANDMARKS.engineeringBridge;
  const [a, b] = B.serviceRoad;
  let tx = b[0] - a[0], tz = b[1] - a[1];
  const l = Math.hypot(tx, tz); tx /= l; tz /= l;
  const along = (x - B.x) * tx + (z - B.z) * tz, perp = Math.abs(-(x - B.x) * tz + (z - B.z) * tx);
  if (perp > 40 || Math.abs(along) > 140) return Infinity;
  const bottom = 9.1 + Math.max(0, Math.abs(along) - 18) * (along < 0 ? 0.11 : 0.05);
  return bottom + Math.max(0, perp - 4) * 0.95;
}

// ------------------------------------------------------------------ terrain

function creekPath(track, L) {
  if (!L.ramp) return null;
  // the dry creek drains across the spine just past the jump's lip, toward the north-gate swale
  const s = L.ramp.s1 + 9, f = track.frameAt(s);
  const P = (along, lat) => [f.x + f.tangent.x * along + f.right.x * lat, f.z + f.tangent.z * along + f.right.z * lat];
  const ctl = [P(-26, -70), P(-12, -42), P(-3, -18), P(0, 0), P(4, 18), P(14, 40), P(30, 64)];
  const pts = [];
  for (let k = 0; k < ctl.length - 1; k++) {
    const p0 = ctl[Math.max(0, k - 1)], p1 = ctl[k], p2 = ctl[k + 1], p3 = ctl[Math.min(ctl.length - 1, k + 2)];
    for (let j = 0; j < 8; j++) {
      const t = j / 8, t2 = t * t, t3 = t2 * t;
      const cr = (q0, q1, q2, q3) => 0.5 * (2 * q1 + (-q0 + q2) * t + (2 * q0 - 5 * q1 + 4 * q2 - q3) * t2 + (-q0 + 3 * q1 - 3 * q2 + q3) * t3);
      pts.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  pts.push(ctl[ctl.length - 1]);
  const res = { d: 0, t: 0 };
  const total = pts.length - 1;
  const query = (x, z) => {
    let best = Infinity, bt = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const [x0, z0] = pts[k], [x1, z1] = pts[k + 1];
      const ex = x1 - x0, ez = z1 - z0, l2 = ex * ex + ez * ez;
      const t = l2 > 0 ? clamp(((x - x0) * ex + (z - z0) * ez) / l2, 0, 1) : 0;
      const dx = x - (x0 + ex * t), dz = z - (z0 + ez * t), d = dx * dx + dz * dz;
      if (d < best) { best = d; bt = (k + t) / total; }
    }
    res.d = Math.sqrt(best); res.t = bt;
    return res;
  };
  return { pts, query, s };
}

function aldrichNatural(lidar, creek) {
  const K = ALDRICH_LANDMARKS.knoll;
  return (x, z) => {
    let h = lidar(x, z);
    // the central knoll (the Rock Garden mound) stands ~2.5 m above the meadow
    const dk = Math.hypot(x - K.x, z - K.z);
    if (dk < 30) h += 2.4 * (1 - smoothstep((dk - 6) / 24));
    // the service road cut
    const sc = serviceCut(x, z);
    if (sc < h) h = sc;
    // the dry creek bed
    if (creek) {
      const q = creek.query(x, z);
      if (q.d < 7) h -= 1.1 * (1 - smoothstep((q.d - 1.6) / 5.4)) * smoothstep(q.t / 0.08) * smoothstep((1 - q.t) / 0.08);
    }
    // gentle ground noise (lawns are never perfectly flat), suburbs and the San Joaquin Hills far south
    h += (fbm(x * 0.03 + 3.1, z * 0.03 - 7.7, 2) - 0.5) * 0.5;
    const r = Math.hypot(x, z);
    if (r > 650) {
      const south = smoothstep((z - 300) / 700) * smoothstep(1 - Math.abs(x + 150) / 1600);
      h += smoothstep((r - 650) / 900) * (12 + 140 * south * Math.max(0, fbm(x * 0.0035 + 2.2, z * 0.0035 - 1.4, 4) - 0.25));
    }
    return h;
  };
}

function aldrichTerrainColor(raster, creek, field) {
  const col = (h) => new THREE.Color(h);
  const cL = col(C.lawn), cA = col(C.lawnAlt), cD = col(C.lawnDeep), cM = col(C.meadow), cDry = col(C.dryGrass), cChap = col(C.chaparral);
  const cLit = col(C.litter), cMul = col(C.mulch), cGar = col(C.garden), cShr = col(C.shrub), cPla = col(C.plaza);
  const cPark = col(C.parking), cPit = col(C.pitch), cSand = col(C.sand), cRock = col(C.rock), cSoil = col(C.soil), cWater = col(0x6cc4dc), cTrack = col(0xb5583a);
  const tmp = new THREE.Color();
  return (c, x, z, h, slope) => {
    const n1 = fbm(x * 0.035, z * 0.035, 3), n2 = fbm(x * 0.009 + 4, z * 0.009 - 9, 3);
    const k = raster.inside(x, z) ? raster.kindAt(x, z) : -1;
    const r = Math.hypot(x, z);
    // default ground: the park's lawns inside the Inner Ring, campus lawns / ground cover around, dry hills far out
    c.copy(cL).lerp(cA, smoothstep((n1 - 0.35) / 0.3)).lerp(cD, smoothstep((0.42 - n1) / 0.2) * 0.4);
    if (k <= 0) {
      if (r > 150) c.lerp(tmp.copy(cM).lerp(cMul, 0.25), smoothstep((n2 - 0.45) / 0.2) * 0.55);
      if (k < 0 || r > 430) {
        // beyond the mapped core: a patchwork of dry grass, chaparral, tree cover and suburb roofs
        const n3 = fbm(x * 0.004 - 2, z * 0.004 + 5, 3), n4 = fbm(x * 0.015 + 9, z * 0.015 - 4, 2);
        tmp.copy(cDry).lerp(cChap, smoothstep((n2 - 0.4) / 0.3)).lerp(cD, smoothstep((n3 - 0.6) / 0.12) * 0.4);
        if (n4 > 0.62 && n3 < 0.5) tmp.lerp(cPla, 0.45);
        c.lerp(tmp, smoothstep((r - 330) / 230) * 0.9);
      }
    } else if (k === AREA_CODE.garden) c.copy(cGar).lerp(cMul, smoothstep((n1 - 0.55) / 0.2) * 0.5);
    else if (k === AREA_CODE.shrub) c.copy(cShr).lerp(cMul, smoothstep((n1 - 0.4) / 0.3) * 0.6);
    else if (k === AREA_CODE.wood) c.copy(cLit).lerp(cGar, smoothstep((n1 - 0.45) / 0.3) * 0.5);
    else if (k === AREA_CODE.pitch) c.copy(cPit).lerp(cA, ((Math.floor(x / 6) + Math.floor(z / 6)) & 1) * 0.25);
    else if (k === AREA_CODE.parking || k === AREA_CODE.track) c.copy(k === AREA_CODE.track ? cTrack : cPark).multiplyScalar(0.95 + n1 * 0.1);
    else if (k === AREA_CODE.plaza) c.copy(cPla).multiplyScalar(0.94 + n1 * 0.1);
    else if (k === AREA_CODE.pool) c.copy(cWater);
    // worn earth along the mapped paths' edges (desire lines)
    if (k >= 0 && k <= AREA_CODE.grass && raster.pathAt(x, z)) c.lerp(cSoil, 0.18);
    // the dry creek: sand and cobbles
    if (creek) {
      const q = creek.query(x, z);
      if (q.d < 5) c.lerp(tmp.copy(cSand).lerp(cRock, smoothstep((n1 - 0.5) / 0.2) * 0.6), (1 - smoothstep((q.d - 1.8) / 3.2)) * smoothstep(q.t / 0.06) * smoothstep((1 - q.t) / 0.06));
    }
    c.lerp(cSoil, smoothstep((slope - 0.55) / 0.4) * 0.6);
    c.lerp(cRock, smoothstep((slope - 1.0) / 0.5) * 0.7);
  };
}

// ------------------------------------------------------------------ clipping helpers

// Push a footprint / prop point out of the drivable corridor (wall + margin) of
// its nearest track section. Returns [x, z].
function pushOut(track, field, x, z, margin, proj) {
  if (field.wallClearance(x, z) >= margin) return [x, z];
  track.project({ x, z }, -1, proj);
  const side = proj.lateral >= 0 ? 1 : -1;
  const lat = side * ((side > 0 ? proj.wallR : proj.wallL) + margin);
  const p = track.pointAt(proj.s, lat);
  return [p.x, p.z];
}
function polyArea(P) { let A = 0; for (let i = 0; i < P.length; i++) { const [x1, z1] = P[i], [x2, z2] = P[(i + 1) % P.length]; A += x1 * z2 - x2 * z1; } return A / 2; }
function densify(P, step) {
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}
function simplifyClosed(P, eps) {
  if (P.length < 4) return P;
  const keep = new Uint8Array(P.length);
  const dp = (i0, i1) => {
    const a = P[i0], b = P[i1 % P.length];
    let best = -1, bi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const p = P[i], ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez || 1e-9;
      const t = clamp(((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / l2, 0, 1);
      const d = Math.hypot(p[0] - a[0] - ex * t, p[1] - a[1] - ez * t);
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) { keep[bi] = 1; dp(i0, bi); dp(bi, i1); }
  };
  // split at the point farthest from P[0]
  let far = 0, fd = -1;
  for (let i = 1; i < P.length; i++) { const d = Math.hypot(P[i][0] - P[0][0], P[i][1] - P[0][1]); if (d > fd) { fd = d; far = i; } }
  keep[0] = 1; keep[far] = 1;
  dp(0, far); dp(far, P.length);
  return P.filter((_, i) => keep[i]);
}

// ------------------------------------------------------------------ buildings

// A footprint extruded on its podium: plinth band (structure), facade walls
// (atlas: one quad per window bay, v per storey), a parapet and a flat roof
// with mechanical penthouses. Returns { facade: [geo], struct: [geo] }.
function buildingGeometry(poly, gBase, g0, H, style, tint, rng) {
  const st = AT.FACADE_STYLES[style] ?? 0;
  const u0 = st / 3 + 0.006, u1 = (st + 1) / 3 - 0.006;
  const fpos = [], fuv = [], fcol = [], fidx = [];
  const spos = [], scol = [], sidx = [];
  const tc = new THREE.Color(tint), sc = new THREE.Color();
  const floors = Math.max(1, Math.round(H / FLOOR)), fh = H / floors, top = g0 + H;
  const quad = (pos, idx, col, color, ax, az, bx, bz, ya, yb, uvs) => {
    const k = pos.length / 3;
    pos.push(ax, ya, az, bx, ya, bz, bx, yb, bz, ax, yb, az);
    if (uvs) uvs.push(...uvs.cur);
    for (let i = 0; i < 4; i++) col.push(color.r, color.g, color.b);
    idx.push(k, k + 2, k + 1, k, k + 3, k + 2);           // outward for a CCW (x, z) polygon
  };
  sc.set(mixHex(tint, 0x8a8478, 0.55));
  const plinth = sc.clone(), par = new THREE.Color(mixHex(tint, 0xffffff, 0.3));
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) continue;
    quad(spos, sidx, scol, plinth, ax, az, bx, bz, gBase, g0);
    const nb = Math.max(1, Math.round(len / BAY));
    for (let b = 0; b < nb; b++) {
      const t0 = b / nb, t1 = (b + 1) / nb;
      const cx0 = ax + (bx - ax) * t0, cz0 = az + (bz - az) * t0, cx1 = ax + (bx - ax) * t1, cz1 = az + (bz - az) * t1;
      fuv.cur = [u0, 0, u1, 0, u1, floors, u0, floors];
      quad(fpos, fidx, fcol, tc, cx0, cz0, cx1, cz1, g0, top, fuv);
    }
    // parapet: outer band, cap, inner face (inset 0.35 m)
    quad(spos, sidx, scol, par, ax, az, bx, bz, top, top + 0.9);
  }
  // roof + parapet cap / inner face from an inset outline
  const inset = poly.map((p, i) => {
    const a = poly[(i - 1 + poly.length) % poly.length], b = poly[(i + 1) % poly.length];
    let n1x = p[1] - a[1], n1z = -(p[0] - a[0]); const l1 = Math.hypot(n1x, n1z) || 1; n1x /= l1; n1z /= l1;
    let n2x = b[1] - p[1], n2z = -(b[0] - p[0]); const l2 = Math.hypot(n2x, n2z) || 1; n2x /= l2; n2z /= l2;
    let nx = n1x + n2x, nz = n1z + n2z; const ln = Math.hypot(nx, nz) || 1; nx /= ln; nz /= ln;
    const cosHalf = Math.max(0.35, nx * n1x + nz * n1z);
    return [p[0] - (nx * 0.35) / cosHalf, p[1] - (nz * 0.35) / cosHalf];
  });
  const roofCol = new THREE.Color(rng() < 0.5 ? C.roof : C.roofDark);
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length], [cx, cz] = inset[(i + 1) % poly.length], [dx, dz] = inset[i];
    let k = spos.length / 3;
    spos.push(ax, top + 0.9, az, bx, top + 0.9, bz, cx, top + 0.9, cz, dx, top + 0.9, dz);
    for (let j = 0; j < 4; j++) scol.push(par.r, par.g, par.b);
    sidx.push(k, k + 2, k + 1, k, k + 3, k + 2);
    k = spos.length / 3;                                      // inner face (faces inward)
    spos.push(dx, top, dz, cx, top, cz, cx, top + 0.9, cz, dx, top + 0.9, dz);
    for (let j = 0; j < 4; j++) scol.push(par.r * 0.85, par.g * 0.85, par.b * 0.85);
    sidx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  }
  {
    const contour = inset.map(([x, z]) => new THREE.Vector2(x, z));
    const tri = THREE.ShapeUtils.triangulateShape(contour, []);
    const k0 = spos.length / 3;
    for (const [x, z] of inset) { spos.push(x, top + 0.05, z); scol.push(roofCol.r, roofCol.g, roofCol.b); }
    for (const [a, b, c] of tri) {
      const A = inset[a], B = inset[b], Cc = inset[c];
      const ny = (B[1] - A[1]) * (Cc[0] - A[0]) - (B[0] - A[0]) * (Cc[1] - A[1]);
      if (ny > 0) sidx.push(k0 + a, k0 + b, k0 + c); else sidx.push(k0 + a, k0 + c, k0 + b);
    }
  }
  const mk = (pos, idx, col, uv) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv || new Array((pos.length / 3) * 2).fill(0), 2));
    g.setIndex(idx);
    const ng = g.toNonIndexed();          // flat walls: per-face normals
    g.dispose();
    ng.computeVertexNormals();
    return paint(ng, null);
  };
  const out = { facade: [mk(fpos, fidx, fcol, fuv)], struct: [mk(spos, sidx, scol)] };
  // mechanical penthouses on the bigger roofs
  const A = polyArea(poly);
  if (A > 500) {
    let cx = 0, cz = 0; for (const [x, z] of poly) { cx += x; cz += z; } cx /= poly.length; cz /= poly.length;
    if (pointInPoly(poly, cx, cz)) {
      const w = clamp(Math.sqrt(A) * 0.22, 4, 14);
      out.struct.push(box(w, 2.6, w * 0.7, cx, top + 1.3, cz, mixHex(tint, 0x9a958c, 0.5), rng() * Math.PI));
      if (A > 1500) out.struct.push(box(w * 0.5, 1.4, w * 0.4, cx + w * 0.6, top + 0.7, cz + w * 0.3, 0xb7b3ab, rng() * 3));
    }
  }
  return out;
}
function pointInPoly(P, x, z) {
  let inn = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, zi] = P[i], [xj, zj] = P[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inn = !inn;
  }
  return inn;
}

function buildCampusBuildings(ctx, field, B, rng) {
  const { track } = ctx;
  const proj = {};
  let built = 0, dropped = 0, trimmed = 0;
  const footprints = [];
  ALDRICH_BUILDINGS.forEach((b, bi) => {
    const A0 = polyArea(b.p);
    let poly = densify(b.p, 2.0);
    let moved = 0;
    poly = poly.map(([x, z]) => {
      const q = pushOut(track, field, x, z, 1.4, proj);
      if (q[0] !== x || q[1] !== z) moved++;
      return q;
    });
    if (moved) { trimmed++; poly = simplifyClosed(poly, 0.35); } else poly = simplifyClosed(poly, 0.05);
    const A1 = polyArea(poly);
    if (!(A1 > 0.55 * A0) || poly.length < 3 || poly.some(([x, z]) => field.wallClearance(x, z) < 0.6)) { dropped++; return; }
    let gMin = Infinity, gMax = -Infinity;
    for (const [x, z] of densify(poly, 4)) { const g = field.surfaceHeight(x, z); gMin = Math.min(gMin, g); gMax = Math.max(gMax, g); }
    const [style, tints] = ROLE_STYLE[b.r] || ['hood', HOOD_TINTS];
    const tint = tints[Math.floor(hash2(bi * 13 + 7, bi * 31) * tints.length) % tints.length];
    const g0 = Math.min(gMax + 0.3, gMin + 6);
    const geo = buildingGeometry(poly, gMin - 1.6, g0, b.h, style, tint, rng);
    const near = Math.min(...poly.map(([x, z]) => field.wallClearance(x, z))) < 60;
    for (const g of geo.facade) (near ? B.facade : B.farFacade).push(g);
    for (const g of geo.struct) (near ? B.struct : B.farStruct).push(g);
    for (const [x, z] of densify(poly, 3)) if (field.wallClearance(x, z) < 12) ctx.prop('building', x, z, 0.3);
    let cx = 0, cz = 0; for (const [x, z] of poly) { cx += x; cz += z; } cx /= poly.length; cz /= poly.length;
    if (near) ctx.landmarks.push({ name: 'building', x: cx, z: cz, r: Math.sqrt(Math.abs(A1)) / 2, h: b.h + (g0 - gMin) });
    footprints.push({ poly, top: g0 + b.h, x: cx, z: cz });
    built++;
  });
  ctx.stats.buildings = { built, dropped, trimmed };
  return footprints;
}

// ------------------------------------------------------------------ scenery paths (ribbons on the terrain)

function ribbon(field, pts, width, clearance, y, opts = {}) {
  // returns arrays of strips (split where the race corridor covers the path)
  const strips = [];
  let cur = null;
  const dense = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const [x0, z0] = pts[k], [x1, z1] = pts[k + 1], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (opts.step || 3)));
    for (let t = 0; t < n; t++) dense.push([x0 + ((x1 - x0) * t) / n, z0 + ((z1 - z0) * t) / n]);
  }
  dense.push(pts[pts.length - 1]);
  for (let i = 0; i < dense.length; i++) {
    const [x, z] = dense[i];
    const a = dense[Math.max(0, i - 1)], b = dense[Math.min(dense.length - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    const nx = -tz, nz = tx, hw = width / 2;
    const ok = field.wallClearance(x + nx * hw, z + nz * hw) > clearance && field.wallClearance(x - nx * hw, z - nz * hw) > clearance;
    if (!ok) { if (cur && cur.length > 1) strips.push(cur); cur = null; continue; }
    if (!cur) cur = [];
    cur.push([x, z, nx, nz]);
  }
  if (cur && cur.length > 1) strips.push(cur);
  const geos = [];
  for (const s of strips) {
    const pos = [], uv = [], idx = [];
    let v = 0;
    for (let i = 0; i < s.length; i++) {
      const [x, z, nx, nz] = s[i];
      if (i) v += Math.hypot(x - s[i - 1][0], z - s[i - 1][1]) / (opts.tile || 4);
      for (const side of [-1, 1]) {
        const px = x + nx * side * width / 2, pz = z + nz * side * width / 2;
        pos.push(px, y(px, pz), pz);
        uv.push(opts.uSpan ? (side < 0 ? 0 : width / opts.uSpan) : side < 0 ? 0 : 1, v);
      }
      if (i) { const k = (i - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // faces must point up: flip if needed
    const n = g.attributes.normal;
    if (n.count && n.getY(0) < 0) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.computeVertexNormals(); }
    geos.push(paint(g, opts.color ?? 0xffffff));
  }
  return geos;
}

function buildSceneryPaths(ctx, field, M) {
  const y = (x, z) => field.surfaceHeight(x, z) + 0.07;
  const pav = [], asph = [], dirt = [], ring = [];
  // the un-driven half of the Ring Mall: a 14 m walkway with brick edges (as the driven half)
  const RC = ALDRICH_LANDMARKS.ringCentre;
  const ringAt = (bdeg) => {
    const RR = [259, 258, 254, 253, 258, 264, 271, 276, 281, 279, 275, 270, 265, 260, 256, 250, 254, 258, 262, 266, 267, 268, 270, 270, 271, 270, 270, 269, 270, 270, 270, 269, 267, 264, 263, 261];
    const f = bdeg / 10, i0 = Math.floor(f), t = f - i0, r = lerp(RR[((i0 % 36) + 36) % 36], RR[(((i0 + 1) % 36) + 36) % 36], t);
    const a = (bdeg * Math.PI) / 180;
    return [RC.x + r * Math.sin(a), RC.z - r * Math.cos(a)];
  };
  const ringPts = [];
  for (let b = 150; b <= 380; b += 2) ringPts.push(ringAt(b));
  ring.push(...ribbon(field, ringPts, 14, 0.4, y, { tile: 16, color: 0xffffff }));
  const nearRing = (x, z) => { const r = Math.hypot(x - RC.x, z - RC.z); return Math.abs(r - 265) < 14; };
  for (const w of ALDRICH_WAYS) {
    if (w.l < 0) continue;
    // ways on the drawn Ring Mall band are covered by it
    if (w.p.every(([x, z]) => nearRing(x, z)) && w.c !== 'service' && w.c !== 'road') continue;
    const width = w.c === 'road' ? 9 : w.c === 'service' ? 5.5 : w.c === 'cycle' ? 3.6 : w.c === 'steps' ? 3 : 2.6;
    const color = w.c === 'steps' ? 0xc8beac : w.s === 'gravel' ? 0xd6c49a : 0xffffff;
    const target = w.c === 'road' || w.c === 'service' || w.s === 'asphalt' ? asph : w.s === 'dirt' ? dirt : pav;
    target.push(...ribbon(field, w.p, width, 0.3, y, { tile: 4, step: 4, color: w.c === 'cycle' && w.s === 'asphalt' ? 0xdddddd : color }));
  }
  const n0 = addMerged(ctx, ring, M.ringWalk, { receive: true, name: 'RingMallWest' });
  const n1 = addMerged(ctx, pav, M.paver, { receive: true, name: 'Footways' });
  const n2 = addMerged(ctx, asph, M.asphaltPath, { receive: true, name: 'ServiceRoads' });
  const n3 = addMerged(ctx, dirt, M.dirtPath, { receive: true, name: 'DirtPaths' });
  ctx.stats.paths = { ring: ring.length, paved: pav.length, asphalt: asph.length, dirt: dirt.length, drawn: [n0, n1, n2, n3].filter(Boolean).length };
}

// ------------------------------------------------------------------ road surfaces (zone decals)

function buildRoadSurfaces(ctx, L, M) {
  const { track } = ctx;
  const asphalt = [], gravel = [], dirt = [], crossing = [], ford = [];
  const S = (name) => L.sec(name);
  const span = (a, b, list, tile) => { if (a && b !== null) list.push(roadDecal(ctx, a, b, { tile, step: 1, dy: 0.014 })); };
  // Inner Ring + north corridor: asphalt bike path; West Gate path: dirt; Meadow Spine: gravel
  const pv = S('Parkview Corner'), wg = S('West Gate'), wgp = S('West Gate Path'), hub = S('Meadow Hub'), spine = S('Meadow Spine'), ng = S('North Gate'), arch = S('Arch Corner');
  if (pv && wgp) span(pv.s0 + 6, wgp.s0, asphalt, 12);
  if (ng && arch) span(ng.s0, arch.s1 - 18, asphalt, 12);
  if (wgp) span(wgp.s0, wgp.s1 + 4, dirt, 10);
  if (hub && spine) span(hub.s0 + 4, ng ? ng.s0 : spine.s1, gravel, 10);
  // bike crossings at the service roads
  for (const s of L.crossings) crossing.push(roadDecal(ctx, s - 2.8, s + 2.8, { tile: 5.6, step: 0.5, dy: 0.018, uSpan: 8 }));
  // the cobbled ford of the dry creek across the spine
  if (L.ramp) ford.push(roadDecal(ctx, L.ramp.s1 + 6.5, L.ramp.s1 + 11.5, { tile: 5, step: 0.5, dy: 0.02, uSpan: 5 }));
  addMerged(ctx, asphalt, M.bikeway, { receive: true, name: 'BikewaySurface' });
  addMerged(ctx, gravel, M.gravel, { receive: true, name: 'GravelSurface' });
  addMerged(ctx, dirt, M.dirt, { receive: true, name: 'DirtSurface' });
  addMerged(ctx, crossing, M.crossing, { receive: true, name: 'BikeCrossings' });
  addMerged(ctx, ford, M.ford, { receive: true, name: 'CreekFord' });
}

// ------------------------------------------------------------------ the Engineering Bridge

// The Ring Mall's bridge over the Engineering Service Road: a concrete deck
// slab under the whole corridor, white fascias, heavy white railings whose
// inner faces are the wall lines, two pier walls beside the cut.
function buildEngineeringBridge(ctx, field, L, B) {
  const { track } = ctx;
  const z = (L.Z.bridge || [])[0];
  if (!z) return null;
  const s0 = z.s0 - 3, s1 = z.s1 + 3;
  const sl = sRange(s0, s1, 1);
  const D = 1.3;
  B.struct.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => { o.lat = c ? -(f.wallL + 0.6) : f.wallR + 0.6; o.dy = -D; }), C.concreteDark));
  for (const side of [-1, 1]) {
    B.struct.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
      const wall = side > 0 ? f.wallR : f.wallL, upper = side > 0 ? c === 0 : c === 1;
      o.lat = side * (wall + 0.6); o.dy = upper ? 0.62 : -D;
    }), C.fascia));
    // parapet upstand (inner face = wall line) + top + railing posts / tubes
    B.struct.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
      const wall = side > 0 ? f.wallR : f.wallL, upper = side > 0 ? c === 1 : c === 0;
      o.lat = side * wall; o.dy = upper ? 0.62 : -0.05;
    }), C.concrete));
    B.struct.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
      const wall = side > 0 ? f.wallR : f.wallL;
      o.lat = side * (wall + (side > 0 ? (c ? 0.6 : 0) : (c ? 0 : 0.6))); o.dy = 0.62;
    }), C.concrete));
    for (const [yy, hh] of [[1.12, 0.12], [0.86, 0.06]]) {
      B.struct.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
        const wall = side > 0 ? f.wallR : f.wallL;
        o.lat = side * (wall + 0.25 + (side > 0 ? (c ? hh : 0) : (c ? 0 : hh))); o.dy = yy + hh;
      }), C.rail));
      for (const face of [0, 1]) {
        B.struct.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
          const wall = side > 0 ? f.wallR : f.wallL;
          const inner = face === 0, upper = (side > 0) === inner ? c === 1 : c === 0;
          o.lat = side * (wall + 0.25 + (inner ? 0 : hh)); o.dy = upper ? yy + hh : yy;
        }), C.rail));
      }
    }
    for (let s = s0 + 1; s < s1; s += 2.2) {
      const f = track.frameAt(s), wall = side > 0 ? f.wallR : f.wallL, lat = side * (wall + 0.3);
      B.struct.push(box(0.1, 0.6, 0.1, f.x + f.right.x * lat, f.y + 0.92, f.z + f.right.z * lat, C.rail, f.yaw));
    }
  }
  // pier walls beside the service-road cut (find the deepest ground under the deck)
  let sDeep = (z.s0 + z.s1) / 2, gDeep = Infinity;
  for (let s = z.s0; s <= z.s1; s += 1) { const f = track.frameAt(s); const g = field.surfaceHeight(f.x, f.z); if (g < gDeep) { gDeep = g; sDeep = s; } }
  for (const ds of [-8.5, 8.5]) {
    const s = sDeep + ds, f = track.frameAt(s);
    const g = Math.min(...[-1, 0, 1].map((k) => { const lat = k * (k < 0 ? f.wallL : f.wallR); return field.surfaceHeight(f.x + f.right.x * lat, f.z + f.right.z * lat); }));
    const hgt = f.y - D - g + 0.8;
    if (hgt < 1) continue;
    const w = f.wallL + f.wallR - 1;
    const p = box(w, hgt, 1.4, f.x + f.right.x * (f.wallR - f.wallL) / 2, f.y - D - hgt / 2 + 0.05, f.z + f.right.z * (f.wallR - f.wallL) / 2, C.concrete, f.yaw);
    B.struct.push(p);
  }
  ctx.landmarks.push({ name: 'engineeringBridge', x: ALDRICH_LANDMARKS.engineeringBridge.x, z: ALDRICH_LANDMARKS.engineeringBridge.z, r: 6, h: 2 });
  return [s0, s1];
}

// ------------------------------------------------------------------ landmarks

// The Infinity Fountain: a round shallow blue pool, the plaza ring, a
// stainless figure-eight loop with water splashing from it.
function buildInfinityFountain(ctx, field, B, M, anim) {
  const F = ALDRICH_LANDMARKS.infinityFountain;
  const clr = field.wallClearance(F.x, F.z);          // the basin sits just behind the plaza verge's seat wall
  if (clr < F.r + 0.5) return;
  const g = field.surfaceHeight(F.x, F.z);
  const R = F.r, PR = clamp(clr - 0.4, R + 0.6, R + 4.5);
  B.struct.push(paint(place(new THREE.CylinderGeometry(PR, PR + 0.3, 0.3, 32), F.x, g - 0.05, F.z), C.plaza));
  B.struct.push(paint(place(new THREE.LatheGeometry([[R - 0.3, 0.1], [R, 0.1], [R + 0.05, 0.62], [R + 0.5, 0.62], [R + 0.55, 0.1]].map(([r, h]) => new THREE.Vector2(r, h)), 40), F.x, g, F.z), C.concrete));
  const pool = new THREE.Mesh(new THREE.CircleGeometry(R, 40).rotateX(-Math.PI / 2).translate(F.x, g + 0.42, F.z), M.pool);
  ctx.add(pool, { receive: true, name: 'FountainPool' });
  // the figure-eight (lemniscate) loop of stainless tube, standing in the pool
  const curve = new THREE.Curve();
  curve.getPoint = (t, out = new THREE.Vector3()) => {
    const a = t * Math.PI * 2, d = 1 + Math.sin(a) ** 2;
    return out.set((2.6 * Math.cos(a)) / d, 1.25 + (1.2 * Math.sin(a) * Math.cos(a)) / d * 1.6 + 0.35 * Math.sin(a * 2 + 0.6), 0.45 * Math.sin(a));
  };
  const tube = new THREE.TubeGeometry(curve, 96, 0.17, 8, true);
  const mat = new THREE.MeshStandardMaterial({ color: 0xe8eef2, metalness: 0.25, roughness: 0.3, emissive: 0x20262c });
  const loop = new THREE.Mesh(tube, mat);
  loop.position.set(F.x, g + 0.35, F.z);
  loop.rotation.y = 0.7;
  ctx.add(loop, { cast: true, receive: true, name: 'InfinityLoop' });
  for (const sx of [-1.3, 1.3]) B.struct.push(cyl(0.12, 0.16, 0.9, 6, F.x + Math.cos(0.7) * sx, g + 0.6, F.z - Math.sin(0.7) * sx, C.steel));
  // water sheets splashing off the loop (animated scale)
  const jetG = mergeParts([...Array(6)].map((_, k) => {
    const a = (k / 6) * Math.PI * 2;
    return paint(place(new THREE.ConeGeometry(0.22, 1.4, 6, 1, true), Math.cos(a) * 1.6, 1.0, Math.sin(a) * 0.4, 0, 0, Math.cos(a) * 0.5), 0xd8f2ff);
  }));
  const jets = new THREE.Mesh(jetG, M.water);
  jets.position.set(F.x, g + 0.4, F.z); jets.rotation.y = 0.7;
  ctx.add(jets, { name: 'FountainSplash' });
  anim.push((t) => { const k = 1 + 0.12 * Math.sin(t * 7.3); jets.scale.set(1, k, 1); M.pool.map.offset.set(t * 0.03, t * 0.02); });
  ctx.prop('fountain', F.x, F.z, R + 0.6);
  ctx.exclusions.push([F.x, F.z, PR + 1]);
  ctx.landmarks.push({ name: 'infinityFountain', x: F.x, z: F.z, r: R, h: 3.4 });
}

// The Rock Garden on the central knoll: mossy boulders, a citrus tree and a
// blank plaque on a mossy rock (the park's original centre point).
function buildRockGarden(ctx, field, B, rocks, citrus, rng) {
  const R = ALDRICH_LANDMARKS.rockGarden, K = ALDRICH_LANDMARKS.knoll;
  for (let k = 0; k < 16; k++) {
    const a = rng() * Math.PI * 2, r = (k < 6 ? 2 : 4) + rng() * (k < 6 ? 4 : 10);
    const x = R.x + Math.cos(a) * r, z = R.z + Math.sin(a) * r;
    if (field.wallClearance(x, z) < 3) continue;
    rocks.push([x, field.surfaceHeight(x, z) - 0.35, z, rng() * 6.28, k < 5 ? lerp(1.8, 2.6, rng()) : lerp(0.8, 1.6, rng()), field.wallClearance(x, z), 1.6]);
  }
  const pa = 0.4, px = R.x + Math.cos(pa) * 3.2, pz = R.z + Math.sin(pa) * 3.2, pg = field.surfaceHeight(px, pz);
  B.struct.push(paint(lumpy(new THREE.DodecahedronGeometry(1.1, 0), 0.3, 1.3, 0.7, 1, 11).translate(px, pg + 0.2, pz), 0x7f8a6a));
  B.struct.push(box(0.8, 0.5, 0.06, px, pg + 0.75, pz + 0.05, 0xb48a3a, pa, -0.5));
  citrus.push([R.x - 3, field.surfaceHeight(R.x - 3, R.z + 2) - 0.1, R.z + 2, 0.3, 1, 30, 2]);
  ctx.exclusions.push([R.x, R.z, 6]);
  ctx.landmarks.push({ name: 'rockGarden', x: K.x, z: K.z, r: 8, h: 3 });
}

// The sculpture garden below the Humanities Bridge: four generic robed figures
// (two seated, two standing) in patinated bronze on stone plinths, blank plaques.
function buildStatues(ctx, field, B) {
  const { track } = ctx;
  const proj = {};
  ALDRICH_LANDMARKS.statues.forEach(([x0, z0], k) => {
    const [x, z] = pushOut(track, field, x0, z0, 1.8, proj);
    const g = field.surfaceHeight(x, z);
    const seated = k === 0 || k === 2;
    const parts = [box(1.5, 1.0, 1.5, 0, 0.45, 0, C.stone), box(1.7, 0.12, 1.7, 0, 0.98, 0, 0xc2bdb2), box(0.6, 0.3, 0.04, 0, 0.55, 0.77, 0xb48a3a)];
    const br = C.bronze, br2 = 0x56704e;   // bronze with a green patina
    if (seated) {
      parts.push(box(0.9, 0.45, 0.8, 0, 1.3, -0.05, C.stone));                               // rock seat
      parts.push(paint(place(new THREE.ConeGeometry(0.62, 1.1, 8), 0, 1.95, 0.05), br));       // robe
      parts.push(box(0.7, 0.32, 0.6, 0, 1.6, 0.35, br));                                      // lap
      parts.push(ball(0.22, 0, 2.62, 0.05, br2, 1, 1.1, 1, 1));                               // head
      parts.push(cyl(0.05, 0.09, 0.34, 6, 0.32, 2.05, 0.35, br2, 0, 0, -0.6));                // a raised arm (cup / hand)
    } else {
      parts.push(paint(place(new THREE.ConeGeometry(0.55, 2.0, 8), 0, 2.0, 0), br));
      parts.push(cyl(0.28, 0.34, 0.5, 8, 0, 3.1, 0, br));
      parts.push(ball(0.22, 0, 3.55, 0, br2, 1, 1.1, 1, 1));
      parts.push(cyl(0.06, 0.08, 0.7, 6, 0.38, 2.75, 0.12, br2, 0, 0, -0.35));
      if (k === 1) parts.push(ball(0.28, 0.46, 2.45, 0.22, 0x5a8a3a, 1, 0.7, 1));             // holding herbs
      else parts.push(cyl(0.05, 0.05, 2.1, 5, -0.45, 1.95, 0, 0x4a3a28));                      // a staff
    }
    const geo = mergeParts(parts);
    const f = track.frameAt(track.project({ x, z }, -1, proj).s);
    place(geo, x, g - 0.05, z, Math.atan2(-f.right.x, -f.right.z) + (k - 1.5) * 0.25);
    B.struct.push(geo);
    ctx.prop('statue', x, z, 1.0);
    ctx.exclusions.push([x, z, 2.2]);
  });
}

// The Humanities Bridge: the Ring Mall carried over the north bike tunnel on
// an embankment — two concrete portals with a dark arched opening, the
// walkway deck on top with white railings.
function buildHumanitiesArch(ctx, field, B) {
  const H0 = ALDRICH_LANDMARKS.humanitiesArch;
  const Lh = 22, open = 5.2, oh = 3.6;
  // the race line's Arch Corner passes just east of it: keep the portals behind the wall (shift west / narrow if needed)
  let H = null, W = 16;
  for (const [dx, w] of [[0, 16], [-3, 14], [-5, 12], [-7, 10], [-9, 9]]) {
    const x = H0.x + dx, z = H0.z;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [1, 0], [0, -1], [0, 1]].map(([a, b]) => [x + (a * w) / 2, z + (b * Lh) / 2]);
    if (pts.every(([px, pz]) => field.wallClearance(px, pz) > 0.8)) { H = { x, z }; W = w; break; }
  }
  if (!H) return;
  const top = field.surfaceHeight(H.x - W / 2 - 3, H.z) + 0.3;   // the walkway level beside it (west, away from the race road)
  const gN = field.surfaceHeight(H.x, H.z - 13), gS = field.surfaceHeight(H.x, H.z + 13);
  const base = Math.min(gN, gS, top - 4.2);
  // portal faces (shape with an arched hole), extruded 0.8 m
  const shape = new THREE.Shape();
  shape.moveTo(-W / 2, 0); shape.lineTo(W / 2, 0); shape.lineTo(W / 2, top - base + 0.9); shape.lineTo(-W / 2, top - base + 0.9); shape.lineTo(-W / 2, 0);
  const hole = new THREE.Path();
  hole.moveTo(-open / 2, 0.01); hole.lineTo(open / 2, 0.01); hole.lineTo(open / 2, oh - open / 2);
  hole.absarc(0, oh - open / 2, open / 2, 0, Math.PI, false); hole.lineTo(-open / 2, 0.01);
  shape.holes.push(hole);
  for (const dz of [-Lh / 2, Lh / 2]) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.8, bevelEnabled: false, curveSegments: 10 });
    g.translate(0, 0, -0.4);
    B.struct.push(paint(place(g, H.x, base, H.z + dz), C.concrete));
    // tunnel darkness behind the opening
    B.struct.push(paint(place(new THREE.PlaneGeometry(open, oh), H.x, base + oh / 2, H.z + dz - Math.sign(dz) * 1.2, dz < 0 ? 0 : Math.PI), 0x1c1a18));
    // white railing on top of the portal
    B.struct.push(box(W, 0.12, 0.12, H.x, top + 1.05, H.z + dz, C.rail));
    for (let x = -W / 2; x <= W / 2; x += 2) B.struct.push(box(0.1, 0.9, 0.1, H.x + x, top + 0.55, H.z + dz, C.rail));
  }
  // side walls of the tunnel embankment and the walkway deck over it
  for (const sx of [-1, 1]) B.struct.push(box(0.8, top - base + 0.2, Lh, H.x + sx * (W / 2 - 0.4), base + (top - base) / 2, H.z, C.concrete));
  B.struct.push(box(W, 0.4, Lh, H.x, top - 0.1, H.z, C.plaza));
  ctx.prop('arch', H.x, H.z, W / 2);
  ctx.exclusions.push([H.x, H.z, 16]);
  ctx.landmarks.push({ name: 'humanitiesArch', x: H.x, z: H.z, r: W / 2, h: top - base + 1 });
}

// Flagpoles at the administration gateway (a national and a state flag), the
// campus radio mast (lattice) and the Alumni Grove plaque.
function buildGatewayLandmarks(ctx, field, B, M, anim) {
  const flags = ALDRICH_LANDMARKS.flagpoles;
  const proj = {};
  const cloths = [];
  flags.forEach(([x0, z0], k) => {
    const [x, z] = pushOut(ctx.track, field, x0, z0, 1.5, proj);
    const g = field.surfaceHeight(x, z);
    B.struct.push(cyl(0.08, 0.13, 12, 6, x, g + 6, z, 0xe8e8e8));
    B.struct.push(ball(0.16, x, g + 12.1, z, 0xd8b040));
    B.struct.push(cyl(0.9, 1.1, 0.4, 10, x, g + 0.1, z, C.concrete));
    const cl = new THREE.PlaneGeometry(3.2, 1.8, 10, 1);
    const uv = cl.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, (k ? 0.5 : 0) + uv.getX(i) * 0.5);
    cl.translate(1.6, 0, 0);
    cloths.push({ geo: cl, x, y: g + 11, z });
    ctx.prop('flag', x, z, 0.2);
  });
  if (cloths.length) {
    const geos = cloths.map(({ geo, x, y, z }) => place(geo, x, y, z, 2.2));
    const mesh = new THREE.Mesh(mergeGeometries(geos), M.flag);
    geos.forEach((g) => g.dispose());
    ctx.add(mesh, { cast: true, name: 'GatewayFlags' });
  }
  // radio mast
  {
    const R = ALDRICH_LANDMARKS.radioMast;
    if (field.wallClearance(R.x, R.z) > 4) {
      const g = field.surfaceHeight(R.x, R.z);
      const parts = [];
      for (const [ox, oz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) parts.push(box(0.12, R.h, 0.12, ox, R.h / 2, oz, 0xd04a2a));
      for (let y = 1.5; y < R.h; y += 1.5) { parts.push(box(1.3, 0.06, 0.06, 0, y, -0.6, 0xe8e8e8)); parts.push(box(1.3, 0.06, 0.06, 0, y, 0.6, 0xe8e8e8)); parts.push(box(0.06, 0.06, 1.3, -0.6, y, 0, 0xe8e8e8)); parts.push(box(0.06, 0.06, 1.3, 0.6, y, 0, 0xe8e8e8)); }
      parts.push(ball(0.25, 0, R.h + 0.3, 0, 0xff3020));
      const geo = mergeParts(parts);
      B.struct.push(place(geo, R.x, g, R.z, 0.3));
      ctx.landmarks.push({ name: 'radioMast', x: R.x, z: R.z, r: 1.2, h: R.h });
    }
  }
  // Alumni Grove plaque (a low boulder with a bronze plate)
  {
    const P = ALDRICH_LANDMARKS.alumniGrovePlaque;
    const [x, z] = pushOut(ctx.track, field, P.x, P.z, 1.5, proj);
    const g = field.surfaceHeight(x, z);
    B.struct.push(paint(lumpy(new THREE.DodecahedronGeometry(0.8, 0), 0.3, 1.4, 0.6, 1, 5).translate(x, g + 0.15, z), 0x9a9284));
    B.struct.push(box(0.7, 0.45, 0.05, x, g + 0.55, z + 0.45, 0xa8803a, 0, -0.5));
    ctx.prop('plaque', x, z, 0.9);
  }
}

// ------------------------------------------------------------------ street furniture (OSM points)

function buildFurniture(ctx, field, L, rng) {
  const { track, Q } = ctx;
  const proj = {};
  const keep = (x, z, r, step) => field.wallClearance(x, z) > r + 0.3 && (Q.veg >= 1 || hash2(Math.round(x * 3), Math.round(z * 3)) < step);
  const spot = (x, z, yawFn) => [x, field.surfaceHeight(x, z) - 0.03, z, yawFn ? yawFn(x, z) : rng() * 6.28, 1];
  const faceTrack = (x, z) => { track.project({ x, z }, -1, proj); return proj.yaw + (proj.lateral > 0 ? -Math.PI / 2 : Math.PI / 2); };
  const P = ALDRICH_POINTS;
  // campus lamps: a dark-bronze pole with an acorn globe
  const lampG = mergeParts([cyl(0.07, 0.11, 4.2, 5, 0, 2.1, 0, 0x3b3a36), cyl(0.18, 0.22, 0.35, 5, 0, 0.17, 0, 0x3b3a36), ball(0.32, 0, 4.55, 0, 0xfff6d8, 1, 1.25, 1, 0), cone(0.2, 0.3, 5, 0, 4.98, 0, 0x3b3a36)]);
  const lamps = P.lamp.filter(([x, z]) => keep(x, z, 0.4, 0.6)).map(([x, z]) => spot(x, z));
  // the Ring Mall's own lamp line on the driven half: every ~26 m behind the park-side hedge
  for (const z of [...(L.Z.ring || []), ...(L.Z.plaza || [])]) {
    const len = track.forwardDistance(z.s0, z.s1);
    for (let d = 8; d < len; d += 26) {
      const f = track.frameAt(z.s0 + d), lat = f.wallR + 1.6, x = f.x + f.right.x * lat, zz = f.z + f.right.z * lat;
      if (field.wallClearance(x, zz) > 0.9 && !lamps.some((l) => Math.hypot(l[0] - x, l[2] - zz) < 10)) lamps.push(spot(x, zz));
    }
  }
  const benchG = mergeParts([box(1.9, 0.08, 0.5, 0, 0.46, 0, C.timber), box(1.9, 0.42, 0.07, 0, 0.76, -0.24, C.timber, 0, -0.12), box(0.08, 0.46, 0.5, -0.8, 0.23, 0, 0x3b3a36), box(0.08, 0.46, 0.5, 0.8, 0.23, 0, 0x3b3a36)]);
  const benches = P.bench.filter(([x, z]) => keep(x, z, 1.0, 0.6)).map(([x, z]) => spot(x, z, faceTrack));
  const rackParts = [];
  for (let k = 0; k < 3; k++) rackParts.push(paint(place(new THREE.TorusGeometry(0.42, 0.045, 3, 6, Math.PI), (k - 1) * 0.9, 0, 0, Math.PI / 2), 0x8a9098));
  const rackG = mergeParts(rackParts);
  const racks = P.bike.filter(([x, z]) => keep(x, z, 2.0, 0.5)).map(([x, z]) => spot(x, z, faceTrack));
  // a few parked bikes at the racks (students' bikes, bright frames)
  const picnicG = mergeParts([box(2.0, 0.08, 0.9, 0, 0.75, 0, C.timber), box(2.0, 0.06, 0.32, 0, 0.45, 0.62, C.timber), box(2.0, 0.06, 0.32, 0, 0.45, -0.62, C.timber), box(0.08, 0.74, 1.6, -0.75, 0.37, 0, C.timberDark, 0, 0.0), box(0.08, 0.74, 1.6, 0.75, 0.37, 0, C.timberDark)]);
  const picnics = P.picnic.filter(([x, z]) => keep(x, z, 1.3, 1)).map(([x, z]) => spot(x, z));
  const binG = mergeParts([cyl(0.28, 0.25, 0.9, 8, 0, 0.45, 0, 0x4a5a4e), cyl(0.3, 0.3, 0.06, 8, 0, 0.92, 0, 0x2f3a32)]);
  const bins = [...P.waste, ...P.water].filter(([x, z]) => keep(x, z, 0.4, 0.6)).map(([x, z]) => spot(x, z));
  const artG = mergeParts([box(1.2, 0.6, 1.2, 0, 0.3, 0, C.stone), paint(place(new THREE.TorusKnotGeometry(0.7, 0.18, 40, 6), 0, 1.7, 0), 0x8a5a3a)]);
  const art = P.art.filter(([x, z]) => keep(x, z, 1.0, 1)).map(([x, z]) => spot(x, z));
  const sets = [['Lamps', lampG, lamps, 0.25, 0], ['Benches', benchG, benches, 1.0, 0], ['BikeRacks', rackG, racks, 1.8, 0], ['PicnicTables', picnicG, picnics, 1.1, 0], ['Bins', binG, bins, 0.3, 0], ['Sculptures', artG, art, 0.8, 0]];
  for (const [name, geo, spots, r] of sets) {
    if (!spots.length) { geo.dispose(); continue; }
    const inst = new THREE.InstancedMesh(geo, ctx.M.structure, spots.length);
    const m4 = new THREE.Matrix4();
    spots.forEach(([x, y, z, yaw, sc], i) => { inst.setMatrixAt(i, place_m4(m4, x, y, z, yaw, sc, sc, sc)); ctx.prop(name.toLowerCase(), x, z, r); });
    inst.computeBoundingSphere();
    ctx.add(inst, { cast: name === 'Lamps' || name === 'Sculptures', receive: false, name });
    ctx.stats.instances[name.toLowerCase()] = spots.length;
  }
}

// ------------------------------------------------------------------ vegetation

function treeGeometries() {
  const euc = mergeParts([
    paint(place(new THREE.CylinderGeometry(0.22, 0.45, 15, 5, 1, true), 0.2, 7.5, 0, 0, 0, -0.03), C.eucTrunk),
    paint(place(new THREE.CylinderGeometry(0.1, 0.17, 6, 4, 1, true), -1.3, 12.6, 0.4, 0, 0.25, 0.55), C.eucTrunk),
    paint(lumpy(new THREE.IcosahedronGeometry(4.0, 0), 0.34, 1.25, 0.62, 1.1, 3).translate(0.6, 16.8, 0), C.eucLeaf),
    paint(lumpy(new THREE.IcosahedronGeometry(3.0, 0), 0.34, 1.2, 0.7, 1.05, 7).translate(-2.8, 14.4, 0.9), mixHex(C.eucLeaf, 0x9fbf9e, 0.4)),
    paint(lumpy(new THREE.IcosahedronGeometry(2.4, 0), 0.34, 1.1, 0.75, 1.0, 11).translate(1.6, 19.6, -0.8), mixHex(C.eucLeaf, 0x6f9a80, 0.3)),
  ]);
  const oak = mergeParts([
    paint(place(new THREE.CylinderGeometry(0.3, 0.5, 3.2, 5, 1, true), 0, 1.6, 0), C.trunk),
    paint(lumpy(new THREE.IcosahedronGeometry(3.8, 0), 0.22, 1.25, 0.75, 1.15, 5).translate(0, 5.0, 0), C.oak),
    paint(lumpy(new THREE.IcosahedronGeometry(2.4, 0), 0.25, 1.1, 0.8, 1.1, 9).translate(1.9, 4.3, 1.0), mixHex(C.oak, 0x7ab85a, 0.4)),
  ]);
  const syc = mergeParts([
    paint(place(new THREE.CylinderGeometry(0.22, 0.36, 6.5, 6, 1, true), 0, 3.2, 0, 0, 0, 0.06), 0xe8e0d0),
    paint(lumpy(new THREE.IcosahedronGeometry(3.0, 0), 0.25, 1.05, 0.85, 1.0, 4).translate(0.3, 8, 0), C.sycamore),
    paint(lumpy(new THREE.IcosahedronGeometry(2.2, 0), 0.25, 1.0, 0.9, 1.0, 8).translate(-1.5, 6.6, 0.8), mixHex(C.sycamore, 0x9cc85c, 0.35)),
  ]);
  const jac = mergeParts([
    paint(place(new THREE.CylinderGeometry(0.16, 0.3, 4, 5, 1, true), 0, 2, 0, 0, 0, 0.1), 0x7a6450),
    paint(lumpy(new THREE.IcosahedronGeometry(2.2, 0), 0.35, 1.25, 0.8, 1.15, 6).translate(0.9, 5.6, 0.3), C.jacaranda),
    paint(lumpy(new THREE.IcosahedronGeometry(2.0, 0), 0.35, 1.2, 0.8, 1.1, 2).translate(-1.3, 5.0, -0.4), mixHex(C.jacaranda, 0xd0b8f0, 0.3)),
    paint(lumpy(new THREE.IcosahedronGeometry(1.5, 0), 0.35, 1.1, 0.8, 1.1, 9).translate(0, 4.3, 1.2), mixHex(C.jacaranda, 0x8fbf6a, 0.45)),
  ]);
  const pine = mergeParts([
    cyl(0.22, 0.36, 3.0, 5, 0, 1.5, 0, C.trunk),
    paint(lumpy(new THREE.ConeGeometry(3.0, 6.0, 7).translate(0, 5.0, 0), 0.12, 1, 1, 1, 3), C.pine),
    paint(lumpy(new THREE.ConeGeometry(2.2, 5.0, 7).translate(0, 8.0, 0), 0.12, 1, 1, 1, 7), mixHex(C.pine, 0x4f9a52, 0.3)),
  ]);
  const fig = mergeParts([
    paint(place(new THREE.CylinderGeometry(0.5, 0.9, 3, 7, 1, true), 0, 1.5, 0), 0x8a7d6a),
    paint(lumpy(new THREE.IcosahedronGeometry(5.2, 1), 0.15, 1.35, 0.6, 1.3, 4).translate(0, 5.6, 0), C.fig),
  ]);
  const citrus = mergeParts([
    paint(place(new THREE.CylinderGeometry(0.12, 0.2, 1.4, 5, 1, true), 0, 0.7, 0), C.trunk),
    paint(lumpy(new THREE.IcosahedronGeometry(1.6, 1), 0.15, 1.1, 0.9, 1.1, 3).translate(0, 2.2, 0), C.citrus),
    ...[[0.9, 2.4, 0.9], [-1.0, 2.0, 0.4], [0.2, 3.2, -0.9], [1.1, 1.8, -0.5], [-0.5, 2.9, 1.0]].map(([x, y, z]) => paint(new THREE.IcosahedronGeometry(0.16, 0).translate(x, y, z), 0xf2b020)),
  ]);
  const bush = mergeParts([
    paint(lumpy(new THREE.IcosahedronGeometry(1.0, 0), 0.3, 1.25, 0.8, 1.25, 5).translate(0, 0.45, 0), 0x5aa847),
    paint(lumpy(new THREE.IcosahedronGeometry(0.72, 0), 0.3, 1.2, 0.85, 1.2, 9).translate(0.75, 0.35, 0.35), 0x7cc24a),
  ]);
  const rose = mergeParts([
    paint(lumpy(new THREE.IcosahedronGeometry(0.7, 0), 0.3, 1.3, 0.7, 1.3, 6).translate(0, 0.4, 0), 0x4f8f3e),
    ...[[0.3, 0.75, 0.2], [-0.35, 0.7, 0.1], [0.05, 0.85, -0.35], [0.4, 0.65, -0.3], [-0.2, 0.78, 0.4]].map(([x, y, z], i) => paint(new THREE.IcosahedronGeometry(0.14, 0).translate(x, y, z), [0xe8445a, 0xf4c0d0, 0xf0a020, 0xe8445a, 0xffffff][i])),
  ]);
  const rock = paint(lumpy(new THREE.DodecahedronGeometry(1.0, 0), 0.35, 1.2, 0.72, 1, 3), 0xb0ad9c);
  return { euc, oak, syc, jac, pine, fig, citrus, bush, rose, rock };
}

// Species by place: eucalyptus on the park's old edges (west / north) and as
// windbreaks, young sycamores / oaks to the east (the 2025 replanting),
// jacarandas on the Ring Mall, a few pines, the big fig near the centre.
function speciesAt(x, z, h) {
  const rO = Math.hypot(x, z);
  if (rO < 150) {
    if (rO < 45 && h < 0.08) return 'fig';
    if (rO > 85 && (x < -30 || z < -70)) return h < 0.7 ? 'euc' : h < 0.85 ? 'oak' : 'syc';
    if (x > 40) return h < 0.45 ? 'syc' : h < 0.85 ? 'oak' : 'jac';
    return h < 0.35 ? 'oak' : h < 0.6 ? 'syc' : h < 0.78 ? 'euc' : h < 0.92 ? 'jac' : 'pine';
  }
  const rR = Math.hypot(x - 12.7, z - 1.9);
  if (Math.abs(rR - 265) < 30) return h < 0.3 ? 'jac' : h < 0.55 ? 'syc' : h < 0.78 ? 'euc' : h < 0.9 ? 'oak' : 'pine';
  return h < 0.4 ? 'euc' : h < 0.6 ? 'pine' : h < 0.8 ? 'syc' : 'oak';
}
const CANOPY = { euc: 4.2, oak: 4.0, syc: 3.2, jac: 3.4, pine: 3.0, fig: 6.0 };

function buildVegetation(ctx, field, raster, footprints, extra, rng) {
  const { Q } = ctx;
  const G = treeGeometries();
  const lists = { euc: [], oak: [], syc: [], jac: [], pine: [], fig: [] };
  const inBuilding = (x, z, r) => footprints.some((b) => Math.abs(b.x - x) < 80 && Math.abs(b.z - z) < 80 && (pointInPoly(b.poly, x, z) || b.poly.some(([px, pz]) => Math.hypot(px - x, pz - z) < r)));
  const inExcl = (x, z, r) => ctx.exclusions.some(([ex, ez, er]) => (x - ex) ** 2 + (z - ez) ** 2 < (er + r * 0.4) ** 2);
  const add = (x, z, sp, scl) => {
    const R = CANOPY[sp] * scl;
    const clr = field.wallClearance(x, z);
    if (!(clr > R * 0.55 + 0.6)) return false;
    if (inExcl(x, z, R) || inBuilding(x, z, R * 0.6)) return false;
    lists[sp].push([x, field.surfaceHeight(x, z) - 0.2, z, rng() * Math.PI * 2, scl, clr, 1.0]);
    return true;
  };
  // the mapped trees
  const keepFrac = Q.veg >= 1 ? 1 : 0.5;
  for (const [x, z] of ALDRICH_POINTS.tree) {
    const h = hash2(Math.round(x * 2) + 1000, Math.round(z * 2) - 3000);
    if (h > keepFrac && Math.hypot(x, z) > 160) continue;
    if (Math.hypot(x - 12.7, z - 1.9) > 330 && h > 0.5) continue;
    const sp = speciesAt(x, z, hash2(Math.round(x * 2) + 77, Math.round(z * 2) + 13));
    add(x, z, sp, lerp(sp === 'euc' ? 0.85 : 0.8, sp === 'euc' ? 1.35 : 1.2, hash2(Math.round(x * 7), Math.round(z * 7))));
  }
  // groves on the mapped woods + the park's urban forest on its lawns (away from paths and the open meadows)
  const step = Q.veg >= 1 ? 7.5 : 11;
  for (let z = -470; z < 470; z += step) {
    for (let x = -470; x < 470; x += step) {
      const jx = x + (hash2(x, z) - 0.5) * step * 0.8, jz = z + (hash2(z + 7, x - 3) - 0.5) * step * 0.8;
      const k = raster.kindAt(jx, jz);
      const rO = Math.hypot(jx, jz);
      let p = 0;
      if (k === AREA_CODE.wood) p = 0.45;
      else if (k === AREA_CODE.grass && rO < 150) p = rO > 95 ? 0.09 : 0.03;        // the park's edge belt is wooded, the centre open
      else if (k === AREA_CODE.grass) p = 0.035;
      else if (k === 0 && rO > 330 && rO < 470) p = 0.025;
      if (!p || raster.pathAt(jx, jz) || hash2(Math.round(jx * 5), Math.round(jz * 5)) > p) continue;
      const sp = speciesAt(jx, jz, hash2(Math.round(jx) + 5, Math.round(jz) - 9));
      add(jx, jz, sp, lerp(0.8, 1.2, hash2(Math.round(jx * 3), Math.round(jz * 3))));
    }
  }
  // the Ring Mall's shade-tree avenue: jacarandas and sycamores on both sides behind the barriers
  if (extra.ringZones) {
    for (const zr of extra.ringZones) {
      const len = ctx.track.forwardDistance(zr.s0, zr.s1);
      for (let d = 6; d < len; d += Q.veg >= 1 ? 13 : 22) {
        const f = ctx.track.frameAt(zr.s0 + d);
        for (const side of [-1, 1]) {
          const lat = side * ((side > 0 ? f.wallR : f.wallL) + lerp(3.5, 5.5, hash2(Math.round(d), side + 5)));
          const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
          if (raster.pathAt(x, z) && hash2(Math.round(x), Math.round(z)) < 0.5) continue;
          add(x, z, (Math.floor(d / 13) + (side > 0 ? 1 : 0)) % 3 === 0 ? 'jac' : 'syc', lerp(0.85, 1.1, hash2(Math.round(x * 3), Math.round(z * 3))));
        }
      }
    }
  }
  // shrubs and roses in the gardens / shrub beds, low hedging along the plazas
  const bushes = [], roses = [], rocks = [...extra.rocks];
  for (let z = -440; z < 440; z += Q.veg >= 1 ? 7 : 9) {
    for (let x = -440; x < 440; x += Q.veg >= 1 ? 7 : 9) {
      const jx = x + (hash2(x + 1, z) - 0.5) * 3, jz = z + (hash2(z, x + 1) - 0.5) * 3;
      const k = raster.kindAt(jx, jz);
      if (k !== AREA_CODE.garden && k !== AREA_CODE.shrub) continue;
      if (raster.pathAt(jx, jz) || hash2(Math.round(jx * 3), Math.round(jz * 3)) > 0.5) continue;
      const clr = field.wallClearance(jx, jz);
      if (clr < 1.5 || inExcl(jx, jz, 1) || inBuilding(jx, jz, 1)) continue;
      const spot = [jx, field.surfaceHeight(jx, jz) - 0.1, jz, rng() * 6.28, lerp(0.7, 1.25, rng()), clr, 1.2];
      (k === AREA_CODE.garden && hash2(Math.round(jx), Math.round(jz)) < 0.35 ? roses : bushes).push(spot);
    }
  }
  // creek boulders
  if (extra.creek) {
    for (let k = 0; k < extra.creek.pts.length; k += 2) {
      const [cx, cz] = extra.creek.pts[k];
      for (let j = 0; j < 2; j++) {
        const x = cx + (rng() - 0.5) * 5, z = cz + (rng() - 0.5) * 5, sc = lerp(0.35, 1.0, rng());
        if (field.wallClearance(x, z) < 1.4 * sc + 0.8) continue;
        rocks.push([x, field.surfaceHeight(x, z) - 0.3, z, rng() * 6.28, sc, field.wallClearance(x, z), 1.3 * sc]);
      }
    }
  }
  addInstancedSet(ctx, 'Eucalyptus', G.euc, lists.euc, rng, { near: 30, stretch: [0.85, 1.2] });
  addInstancedSet(ctx, 'Oaks', G.oak, lists.oak, rng, { near: 30 });
  addInstancedSet(ctx, 'Sycamores', G.syc, lists.syc, rng, { near: 0 });
  addInstancedSet(ctx, 'Jacarandas', G.jac, lists.jac, rng, { near: 0, tints: [0xffffff, 0xf0e8ff, 0xe8f0ff] });
  addInstancedSet(ctx, 'Pines', G.pine, lists.pine, rng, { near: 0 });
  addInstancedSet(ctx, 'Figs', G.fig, lists.fig, rng, { near: 0 });
  addInstancedSet(ctx, 'Citrus', G.citrus, extra.citrus, rng, { near: 0, tint: [0.95, 1.05] });
  addInstancedSet(ctx, 'Shrubs', G.bush, bushes, rng, { near: 0, tints: [0xffffff, 0xffffff, 0xfff2c0, 0xe0f0d0], tint: [0.85, 1.12] });
  addInstancedSet(ctx, 'Roses', G.rose, roses, rng, { near: 0 });
  addInstancedSet(ctx, 'Rocks', G.rock, rocks, rng, { near: 0, tints: [0x9a9a86, 0x8a9a7a, 0xa8a090], tint: [0.85, 1.1] });
  ctx.stats.trees = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length]));
}

// Rabbits on the lawns (the campus' most noted wildlife): one animated InstancedMesh.
function buildRabbits(ctx, field, raster, rng) {
  const n = ctx.Q.veg >= 1 ? 18 : 8;
  const body = mergeParts([
    ball(0.22, 0, 0.22, 0, 0xb59c84, 1.0, 0.85, 1.35), ball(0.14, 0, 0.36, 0.26, 0xb59c84, 1, 1, 1.1),
    box(0.05, 0.22, 0.03, -0.05, 0.56, 0.24, 0xc9b39c, 0, 0.2, -0.15), box(0.05, 0.22, 0.03, 0.05, 0.56, 0.24, 0xc9b39c, 0, 0.2, 0.15),
    ball(0.07, 0, 0.26, -0.3, 0xfafafa),
  ]);
  const bunnies = [];
  for (let tries = 0; bunnies.length < n && tries < n * 80; tries++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 140, x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (raster.kindAt(x, z) !== AREA_CODE.grass || field.wallClearance(x, z) < 6 || raster.pathAt(x, z)) continue;
    bunnies.push({ x, z, yaw: rng() * 6.28, ph: rng() * 10, sp: lerp(0.6, 1.2, rng()), hx: x, hz: z, cur: 0 });
  }
  if (!bunnies.length) { body.dispose(); return; }
  const inst = new THREE.InstancedMesh(body, ctx.M.veg, bunnies.length);
  inst.frustumCulled = false;
  const m4 = new THREE.Matrix4();
  const update = (time, dt) => {
    for (let i = 0; i < bunnies.length; i++) {
      const r = bunnies[i], t = time * r.sp + r.ph, cyc = t % 4;
      let hop = 0;
      if (cyc < 1.2) {
        hop = Math.sin(((cyc / 0.4) % 1) * Math.PI) * 0.35;
        const yaw = r.yaw + Math.sin(Math.floor(t / 4) * 1.7) * 1.2;
        const nx = r.x + Math.sin(yaw) * 2.2 * dt, nz = r.z + Math.cos(yaw) * 2.2 * dt;
        if (Math.hypot(nx - r.hx, nz - r.hz) < 8 && field.wallClearance(nx, nz) > 4) { r.x = nx; r.z = nz; }
        r.cur = yaw;
      }
      inst.setMatrixAt(i, place_m4(m4, r.x, field.surfaceHeight(r.x, r.z) + hop, r.z, r.cur, 1, 1, 1));
    }
    inst.instanceMatrix.needsUpdate = true;
  };
  update(0, 0);
  ctx.add(inst, { name: 'Rabbits' });
  ctx.animators.push((dt, time) => { if (dt > 0) update(time, dt); });
  ctx.stats.instances.rabbits = bunnies.length;
}

// ------------------------------------------------------------------ far scenery

function buildFarScenery(ctx, rng) {
  const geos = [];
  // the San Joaquin Hills to the south / south-west (golden grass, chaparral), bearing 140°-250°
  for (let k = 0; k < 16; k++) {
    const b = ((lerp(140, 250, k / 15) + (rng() - 0.5) * 6) * Math.PI) / 180;
    const r = lerp(1450, 1720, rng()), h = lerp(70, 130, rng());
    const x = Math.sin(b) * r, z = -Math.cos(b) * r;
    geos.push(mountainGeometry(x, z, h * lerp(3.0, 4.2, rng()), h, 9, (t, ny, y) => (t > 0.65 ? mixHex(0x8d9a5a, 0x7d8c50, hash2(Math.round(y), 1)) : ny < 0.5 ? mixHex(0xc2b47a, 0xb0a46c, hash2(Math.round(y * 2), 5)) : mixHex(0xcdbd80, 0x9fae66, hash2(Math.round(y * 3), 9) * 0.6))));
  }
  // low hazy ridges far round the rest of the horizon
  for (let k = 0; k < 12; k++) {
    const b = (k / 12) * Math.PI * 2 + (rng() - 0.5) * 0.2;
    if (-Math.cos(b) > 0.4) continue;                                  // not in front of the southern hills
    const r = lerp(1550, 1750, rng()), h = lerp(40, 90, rng());
    geos.push(mountainGeometry(Math.sin(b) * r, -Math.cos(b) * r, h * 5, h, 8, (t, ny, y) => mixHex(0x9fadbd, 0xb4bfca, hash2(Math.round(y), 7))));
  }
  // a business-park skyline to the north-west
  for (let k = 0; k < 12; k++) {
    const x = -520 + (rng() - 0.5) * 320, z = -1050 + (rng() - 0.5) * 200;
    const w = lerp(18, 34, rng()), h = lerp(30, 85, rng());
    geos.push(box(w, h, w * lerp(0.7, 1.1, rng()), x, h / 2 - 2, z, [0x8fb3c9, 0xa7c4d6, 0xc9d6de, 0x7ea0b8][k % 4], rng()));
  }
  addMerged(ctx, geos, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), { name: 'FarScenery' });
}

// Beyond the mapped core: low campus / residential blocks and tree clumps in a
// ring 420-760 m out so the horizon is never empty (two instanced draw calls).
function buildOuterCampus(ctx, field, rng) {
  const blockG = mergeParts([box(1, 1, 1, 0, 0.5, 0, 0xffffff), box(1.06, 0.06, 1.06, 0, 1.0, 0, 0xc8c2b6)]);
  const blocks = [], clumps = [];
  for (let k = 0; k < (ctx.Q.veg >= 1 ? 150 : 70); k++) {
    const a = rng() * Math.PI * 2, r = lerp(430, 760, Math.sqrt(rng()));
    const x = 12.7 + Math.cos(a) * r, z = 1.9 + Math.sin(a) * r;
    if (field.wallClearance(x, z) < 30) continue;
    if (rng() < 0.55) blocks.push({ x, z, w: lerp(14, 40, rng()), d: lerp(10, 28, rng()), h: lerp(6, 16, rng()), yaw: a + (rng() < 0.5 ? 0 : Math.PI / 2) });
    else clumps.push([x, field.surfaceHeight(x, z) - 0.5, z, rng() * 6, lerp(1.4, 2.4, rng()), 100, 6]);
  }
  if (blocks.length) {
    const inst = new THREE.InstancedMesh(blockG, ctx.M.structure, blocks.length);
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    blocks.forEach((b, i) => {
      const g = field.surfaceHeight(b.x, b.z) - 0.5;
      inst.setMatrixAt(i, place_m4(m4, b.x, g, b.z, b.yaw, b.w, b.h, b.d));
      inst.setColorAt(i, col.set(HOOD_TINTS[i % HOOD_TINTS.length]));
    });
    inst.computeBoundingSphere();
    ctx.add(inst, { name: 'OuterBlocks' });
  } else blockG.dispose();
  const clumpG = mergeParts([paint(lumpy(new THREE.IcosahedronGeometry(3.2, 0), 0.3, 1.6, 0.8, 1.3, 3).translate(0, 3.4, 0), 0x5f9a4a), paint(lumpy(new THREE.IcosahedronGeometry(2.4, 0), 0.3, 1.2, 1.0, 1.2, 8).translate(2.6, 2.6, 1.0), 0x7aa058)]);
  addInstancedSet(ctx, 'OuterTrees', clumpG, clumps, rng, { near: 0 });
}

// ------------------------------------------------------------------ set pieces (drawn)

// Telegraph sounds of the set pieces (registered once; played by main.js via 'item:sfx').
let _soundsRegistered = false;
function registerCampusSounds() {
  if (_soundsRegistered) return;
  _soundsRegistered = true;
  try {
    registerSound('aldrichBell', (ac, out, o) => {
      const { t, p } = SYNTH.opt(ac, o);
      SYNTH.bell(ac, out, t, 2350 * p, 0.12, 0.45);
      SYNTH.bell(ac, out, t + 0.16, 2350 * p, 0.12, 0.5);
      return 0.7;
    }, 1.2);
    registerSound('aldrichQuack', (ac, out, o) => {
      const { t, p } = SYNTH.opt(ac, o);
      for (let k = 0; k < 2; k++) SYNTH.blip(ac, out, t + k * 0.2, { type: 'sawtooth', f0: 520 * p, f1: 330 * p, glide: 0.12, dur: 0.15, peak: 0.14, lp: 1500, Q: 6 });
      return 0.45;
    }, 1.3);
    registerSound('aldrichSprinkler', (ac, out, o) => {
      const { t } = SYNTH.opt(ac, o);
      for (let k = 0; k < 4; k++) SYNTH.hiss(ac, out, t + k * 0.11, { type: 'bandpass', f0: 4200, Q: 2.5, dur: 0.05, peak: 0.16 });
      SYNTH.hiss(ac, out, t + 0.45, { type: 'highpass', f0: 2500, dur: 0.6, peak: 0.08, attack: 0.1 });
      return 1.1;
    }, 1.1);
  } catch (err) { console.warn('[world-aldrich] sounds unavailable', err); }
}

function buildSetPieces(ctx, field, L, hz, B) {
  const { track } = ctx;
  const list = hz.list;
  const cyclists = list.filter((h) => h.type === 'cyclist');
  const duckSets = list.filter((h) => h.type === 'ducks');
  const sprinklers = list.filter((h) => h.type === 'sprinkler');
  const updaters = [];
  const m4 = new THREE.Matrix4();
  const sfx = (name, x, y, z, volume = 1) => { if (hz.driven) bus.emit('item:sfx', { name, position: { x, y, z }, volume }); };

  // ---- bike crossings: bollards at the wall gaps, riders (bike + skin parts / clothes / boards)
  if (cyclists.length) {
    for (const h of cyclists) {
      const f = track.frameAt(h.s);
      for (const side of [-1, 1]) {
        for (const ds of [-3.4, 3.4]) {
          const ff = track.frameAt(h.s + ds), lat = side * ((side > 0 ? ff.wallR : ff.wallL) + 0.25);
          const x = ff.x + ff.right.x * lat, z = ff.z + ff.right.z * lat;
          B.struct.push(cyl(0.13, 0.15, 0.95, 8, x, ff.y + 0.45, z, 0x4a4a48));
          B.struct.push(cyl(0.155, 0.155, 0.12, 8, x, ff.y + 0.75, z, 0xf2c230));
          ctx.prop('bollard', x, z, 0.15);
        }
      }
      void f;
    }
    const wheel = (z) => paint(place(new THREE.TorusGeometry(0.34, 0.045, 5, 12), 0, 0.36, z, Math.PI / 2), 0x222222);
    const bikeG = mergeParts([
      wheel(-0.52), wheel(0.52),
      box(0.05, 0.05, 0.75, 0, 0.62, -0.05, 0x2f6fd0, 0, 0.35), box(0.05, 0.05, 0.62, 0, 0.5, 0.25, 0x2f6fd0, 0, -0.6),
      box(0.05, 0.42, 0.05, 0.1, 0.62, 0.0, 0x2f6fd0), box(0.5, 0.05, 0.05, 0, 1.0, 0.48, 0x333333), box(0.16, 0.05, 0.22, 0, 0.9, -0.2, 0x222222),
      // skin + shoes + helmet (not instance-coloured)
      ball(0.13, 0, 1.68, 0.12, 0xd9a882), paint(new THREE.SphereGeometry(0.15, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1.72, 0.12), 0xf0f0f0),
      box(0.1, 0.08, 0.2, 0.12, 0.4, 0.05, 0x222222), box(0.1, 0.08, 0.2, -0.12, 0.62, -0.05, 0x222222),
      box(0.07, 0.07, 0.45, 0.2, 1.22, 0.32, 0xd9a882, 0, -0.5), box(0.07, 0.07, 0.45, -0.2, 1.22, 0.32, 0xd9a882, 0, -0.5),
    ]);
    // rider clothes: shirt + shorts + backpack (white: instance colour)
    const clothG = mergeParts([
      box(0.4, 0.55, 0.26, 0, 1.3, 0.02, 0xffffff, 0, 0.35), box(0.36, 0.2, 0.3, 0, 0.98, -0.12, 0x9ab0c8),
      box(0.12, 0.42, 0.12, 0.12, 0.7, 0.05, 0x9ab0c8, 0, 0.5), box(0.12, 0.42, 0.12, -0.12, 0.75, -0.05, 0x9ab0c8, 0, -0.2),
      box(0.34, 0.4, 0.18, 0, 1.35, -0.2, 0x404850, 0, 0.35),
    ]);
    // the skater: board + standing rider
    const skaterG = mergeParts([
      box(0.24, 0.04, 0.85, 0, 0.12, 0, 0x8a5a30), ...[-0.3, 0.3].map((z) => box(0.26, 0.06, 0.06, 0, 0.05, z, 0x222222)),
      box(0.13, 0.75, 0.13, 0.13, 0.55, 0.15, 0x3a4a6a), box(0.13, 0.75, 0.13, -0.13, 0.55, -0.15, 0x3a4a6a),
      box(0.42, 0.6, 0.26, 0, 1.25, 0, 0xffffff), ball(0.13, 0, 1.7, 0, 0xc89878), box(0.08, 0.5, 0.08, 0.3, 1.2, 0, 0xc89878, 0, 0, 0.6), box(0.08, 0.5, 0.08, -0.3, 1.2, 0, 0xc89878, 0, 0, -0.6),
    ]);
    const bellG = paint(new THREE.ConeGeometry(0.16, 0.22, 8, 1).translate(0, 0, 0), 0xffd028);
    const nR = cyclists.reduce((a, h) => a + h.riders, 0);
    const bikes = new THREE.InstancedMesh(bikeG, ctx.M.structure, nR), cloth = new THREE.InstancedMesh(clothG, ctx.M.structure, nR);
    const skaters = new THREE.InstancedMesh(skaterG, ctx.M.structure, nR), bells = new THREE.InstancedMesh(bellG, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), nR);
    for (const m of [bikes, cloth, skaters, bells]) { m.frustumCulled = false; }
    ctx.add(bikes, { cast: true, name: 'Cyclists' }); ctx.add(cloth, { cast: true, name: 'CyclistClothes' }); ctx.add(skaters, { cast: true, name: 'Skaters' }); ctx.add(bells, { name: 'BikeBells' });
    const shirts = [0xe84a5f, 0x2f7ad0, 0xf2b43a, 0x3fbf7a, 0x8a5cd0, 0xffffff, 0xff8a3a, 0x40c0d0];
    const col = new THREE.Color();
    for (let i = 0; i < nR; i++) { cloth.setColorAt(i, col.set(shirts[i % shirts.length])); skaters.setColorAt(i, col.set(shirts[(i + 3) % shirts.length])); }
    const prevMode = new Map();
    const tmp = {};
    updaters.push((t) => {
      let i = 0;
      for (const h of cyclists) {
        const f = track.frameAt(h.s);
        for (let k = 0; k < h.riders; k++, i++) {
          const rd = cyclistRider(h, k, t, tmp);
          const key = h.index * 8 + k, was = prevMode.get(key);
          prevMode.set(key, rd.mode);
          const visible = rd.mode !== 'gone' || rd.tau - (CAMPUS_TUNE.cyclist.bell + h.rideTime) < CAMPUS_TUNE.cyclist.ride;
          const x = f.x + f.right.x * rd.lat + f.tangent.x * rd.along, z = f.z + f.right.z * rd.lat + f.tangent.z * rd.along;
          const g = Math.abs(rd.lat) < Math.min(f.wallL, f.wallR) + 0.2 ? f.y : field.surfaceHeight(x, z);
          const yaw = Math.atan2(f.right.x * rd.dir, f.right.z * rd.dir);
          const s = visible ? 1.12 : 0.0001;
          const bob = rd.mode === 'ride' ? Math.sin(t * 9 + k) * 0.03 : 0;
          const lean = rd.mode === 'bell' ? 0.12 : 0;
          if (rd.skater) {
            place_m4(m4, x, g + bob, z, yaw, s, s, s); skaters.setMatrixAt(i, m4);
            place_m4(m4, x, g, z, yaw, 0.0001, 0.0001, 0.0001); bikes.setMatrixAt(i, m4); cloth.setMatrixAt(i, m4);
          } else {
            m4.makeRotationFromEuler(new THREE.Euler(0, yaw, lean, 'YXZ')).scale(new THREE.Vector3(s, s, s)).setPosition(x, g + bob, z);
            bikes.setMatrixAt(i, m4); cloth.setMatrixAt(i, m4);
            place_m4(m4, x, g, z, yaw, 0.0001, 0.0001, 0.0001); skaters.setMatrixAt(i, m4);
          }
          const ring = rd.mode === 'bell' ? 1 + 0.25 * Math.abs(Math.sin(t * 18)) : 0.0001;
          place_m4(m4, x, g + 2.25 + (rd.mode === 'bell' ? Math.sin(t * 9) * 0.05 : 0), z, t * 6, ring, ring, ring); bells.setMatrixAt(i, m4);
          if (rd.mode === 'bell' && was && was !== 'bell') sfx('aldrichBell', x, g + 1.5, z, 1);
        }
      }
      for (const m of [bikes, cloth, skaters, bells]) m.instanceMatrix.needsUpdate = true;
    });
    ctx.stats.instances.cyclists = nR;
  }

  // ---- ducks: a green-headed drake and a brown hen, waddling
  if (duckSets.length) {
    const S = 1.9;          // game scale (readable at speed)
    const duck = (body, head, breast) => mergeParts([
      ball(0.3 * S, 0, 0.32 * S, 0, body, 0.85, 0.62, 1.25),
      ball(0.22 * S, 0, 0.36 * S, 0.22 * S, breast, 0.9, 0.85, 0.8),
      ball(0.15 * S, 0, 0.62 * S, 0.3 * S, head, 1, 1.05, 1.1),
      box(0.09 * S, 0.05 * S, 0.17 * S, 0, 0.6 * S, 0.47 * S, 0xe8b830),
      box(0.12 * S, 0.06 * S, 0.06 * S, 0, 0.5 * S, 0.25 * S, head === 0x2a7a3a ? 0xf6f6f2 : head),
      paint(place(new THREE.ConeGeometry(0.12 * S, 0.22 * S, 5), 0, 0.42 * S, -0.38 * S, 0, -1.9), body),
      box(0.05 * S, 0.2 * S, 0.05 * S, 0.08 * S, 0.1 * S, 0.02, 0xe89a30), box(0.05 * S, 0.2 * S, 0.05 * S, -0.08 * S, 0.1 * S, 0.02, 0xe89a30),
      ...[-1, 1].map((sx) => ball(0.2 * S, sx * 0.17 * S, 0.36 * S, -0.04, head === 0x2a7a3a ? 0x7a7f86 : 0x7a5a3a, 0.3, 0.5, 1.0)),
    ]);
    const drakeM = new THREE.Mesh(duck(0xb8bcc0, 0x2a7a3a, 0x7a4a30), ctx.M.structure);
    const henM = new THREE.Mesh(duck(0x9a7a52, 0x8a6a46, 0xa88a62), ctx.M.structure);
    for (const m of [drakeM, henM]) { m.matrixAutoUpdate = false; m.frustumCulled = false; ctx.add(m, { cast: true, name: 'Ducks' }); }
    const prev = new Map();
    updaters.push((t) => {
      const h = duckSets[0];
      const st = hz.stateAt(h, t);
      const f = track.frameAt(h.s);
      const D = CAMPUS_TUNE.ducks;
      const walk = st.dir !== 0;
      const face = walk ? Math.atan2(f.right.x * st.dir, f.right.z * st.dir) : Math.atan2(f.tangent.x, f.tangent.z) + Math.sin(t * 0.7) * 0.6;
      const pair = [[drakeM, st.lead, 0], [henM, st.hen, D.stagger]];
      pair.forEach(([m, lat, along], k) => {
        const x = f.x + f.right.x * lat + f.tangent.x * along, z = f.z + f.right.z * lat + f.tangent.z * along;
        const wob = walk ? Math.sin(t * 11 + k * 1.7) * 0.18 : Math.sin(t * 2 + k) * 0.05;
        const bob = walk ? Math.abs(Math.sin(t * 11 + k * 1.7)) * 0.05 : 0;
        m.matrix.makeRotationFromEuler(new THREE.Euler(0, face + (walk ? 0 : k * 0.8), wob, 'YXZ')).setPosition(x, f.y + bob, z);
      });
      const was = prev.get(h);
      prev.set(h, st.mode);
      if (was && was !== st.mode && (st.mode === 'out' || st.mode === 'back')) sfx('aldrichQuack', f.x + f.right.x * st.lead, f.y + 0.5, f.z + f.right.z * st.lead, 1);
    });
  }

  // ---- sprinklers: brass impact heads on risers, the jet of droplets, mist
  if (sprinklers.length) {
    const headG = mergeParts([
      cyl(0.09, 0.09, 0.75, 6, 0, 0.37, 0, 0x2a2a2a), cyl(0.17, 0.13, 0.22, 8, 0, 0.8, 0, 0xd0a840),
      box(0.07, 0.07, 0.5, 0, 0.92, 0.18, 0xd0a840, 0, -0.35), box(0.12, 0.1, 0.1, 0, 0.98, 0.4, 0x2a2a2a), cyl(0.3, 0.34, 0.1, 10, 0, 0.0, 0, 0x2f5a2a),
    ]);
    // (the heads stand on the verge inside the walls on purpose — a hazard, not a prop: no ctx.prop)
    const heads = new THREE.InstancedMesh(headG, ctx.M.structure, sprinklers.length);
    heads.frustumCulled = false;
    ctx.add(heads, { cast: true, name: 'SprinklerHeads' });
    const SEG = 12, DROPS = 14;
    const segG = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true).rotateX(Math.PI / 2);
    const waterMat = new THREE.MeshBasicMaterial({ color: 0xdff3ff, transparent: true, opacity: 0.62, depthWrite: false, toneMapped: false, fog: true, side: THREE.DoubleSide });
    const streams = new THREE.InstancedMesh(segG, waterMat, sprinklers.length * SEG);
    const drops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), waterMat, sprinklers.length * DROPS);
    for (const m of [streams, drops]) { m.frustumCulled = false; ctx.add(m, { name: 'SprinklerJets' }); }
    const qa = new THREE.Quaternion(), va = new THREE.Vector3(), vb = new THREE.Vector3(), vs = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1);
    const jetPt = (h, f, st, u, out) => {
      const r = h.reach * u, lat = h.lateral + st.dl * r, along = st.da * r;
      return out.set(f.x + f.right.x * lat + f.tangent.x * along, f.y + 0.85 + 2.6 * u * (1 - u) * 1.6 - 0.5 * u, f.z + f.right.z * lat + f.tangent.z * along);
    };
    const prevOn = new Map();
    updaters.push((t) => {
      sprinklers.forEach((h, i) => {
        const st = hz.stateAt(h, t);
        const f = track.frameAt(h.s);
        const hx = f.x + f.right.x * h.lateral, hzz = f.z + f.right.z * h.lateral;
        const riseY = -0.55 + 0.55 * st.rise;
        place_m4(m4, hx, f.y + riseY, hzz, Math.atan2(f.right.x * st.dl + f.tangent.x * st.da, f.right.z * st.dl + f.tangent.z * st.da), 1, 1, 1);
        heads.setMatrixAt(i, m4);
        for (let k = 0; k < SEG; k++) {
          if (st.on) {
            jetPt(h, f, st, k / SEG, va); jetPt(h, f, st, (k + 1) / SEG, vb);
            const len = va.distanceTo(vb), r = 0.12 + 0.08 * (k / SEG) + 0.02 * Math.sin(t * 30 + k);
            vs.subVectors(vb, va).normalize(); qa.setFromUnitVectors(Z, vs);
            m4.compose(va.add(vb).multiplyScalar(0.5), qa, vb.set(r, r, len * 1.05));
          } else m4.makeScale(0.0001, 0.0001, 0.0001);
          streams.setMatrixAt(i * SEG + k, m4);
        }
        for (let k = 0; k < DROPS; k++) {
          let sc = 0.0001;
          if (st.on) {
            const u = 0.78 + 0.3 * (((k + 0.5) / DROPS + t * 1.9) % 1);
            jetPt(h, f, st, Math.min(1.06, u), va);
            va.x += Math.sin(k * 3.1 + t * 7) * 0.5; va.z += Math.cos(k * 2.3 + t * 6) * 0.5; va.y -= (u - 0.78) * 2.2;
            sc = 0.18 + 0.14 * Math.sin(k * 7 + t * 20) ** 2;
          } else if (st.rise > 0.2 && k < 6) {             // telegraph: the head spits as it pops up
            const u = ((k + 0.5) / 6 + t * 2.5) % 1;
            va.set(hx + Math.sin(k * 2.3) * u * 0.8, f.y + 0.8 + u * 0.9, hzz + Math.cos(k * 2.3) * u * 0.8);
            sc = 0.1 * (1 - u) + 0.04;
          } else va.set(hx, f.y, hzz);
          place_m4(m4, va.x, va.y, va.z, k, sc, sc, sc);
          drops.setMatrixAt(i * DROPS + k, m4);
        }
        const was = prevOn.get(h);
        prevOn.set(h, st.rise > 0.05);
        if (st.rise > 0.05 && was === false) sfx('aldrichSprinkler', hx, f.y + 0.5, hzz, 1);
      });
      heads.instanceMatrix.needsUpdate = true;
      streams.instanceMatrix.needsUpdate = true;
      drops.instanceMatrix.needsUpdate = true;
    });
  }

  // drawn at hz.time; tick the clock ourselves only if nobody else does
  ctx.animators.push((dt) => {
    if (!hz.driven) hz.time += dt;
    for (const u of updaters) u(hz.time);
  });
  for (const u of updaters) u(hz.time);
}

// ------------------------------------------------------------------ buildAldrichWorld

export function buildAldrichWorld(scene, track, opts = {}) {
  const ctx = createWorldContext(scene, track, opts);
  const { Q } = ctx, sp = track.spacing;
  const L = aldrichLayout(track);
  const rng = makeRng(1965);
  const hz = createHazards(track);
  registerCampusSounds();
  const raster = buildAreaRaster();
  const lidar = makeLidar();
  const creek = creekPath(track, L);

  // Southern California sun ~55° high from the south-east: kart shadows fall
  // beside the karts on the Gateway Plaza straight.
  const sunDir = new THREE.Vector3(0.42, 0.8, 0.43).normalize();
  buildSky(ctx, { sunDir, top: C.skyTop, horizon: C.skyHorizon, bottom: C.skyBottom, sunColor: 0xfff2d6, fogNear: 320, fogFar: 1800 });
  const { sun, hemi, follow } = buildLights(ctx, { sunDir, sunColor: C.sun, sunIntensity: 2.65, hemiSky: C.hemiSky, hemiGround: C.hemiGround, hemiIntensity: 1.35 });
  const a = ctx.maxAniso;
  const T = createTrackTextures(ctx, {
    road: AT.createRingMallTexture({ aniso: a }),
    wall: AT.createAldrichWallAtlasTexture({ aniso: a }),
    banner: { bg: ['#2f8a55', '#1c5c36'], outline: '#0f3a1a' },
    curbColors: ['#b9603a', '#efe9dc'],
  });
  const tex = (t) => ctx.tex(t);
  const M = {
    facade: new THREE.MeshLambertMaterial({ map: tex(AT.createFacadeAtlasTexture({ aniso: a })), vertexColors: true }),
    bikeway: decalMaterial({ map: tex(AT.createBikewayTexture({ aniso: a })) }),
    gravel: decalMaterial({ map: tex(AT.createGravelTexture({ aniso: a })), roughness: 0.95 }),
    dirt: decalMaterial({ map: tex(AT.createPathDirtTexture({ aniso: a })), roughness: 0.95 }),
    crossing: decalMaterial({ map: tex(AT.createBikeCrossingTexture({ aniso: a })), transparent: true, depthWrite: false, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    ford: decalMaterial({ map: tex(AT.createGravelTexture({ aniso: a, seed: 41 })), color: 0x9a948a, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    ringWalk: decalMaterial({ map: T.road }),
    paver: decalMaterial({ map: tex(AT.createPaverTexture({ aniso: a })), vertexColors: true }),
    asphaltPath: decalMaterial({ map: tex(AT.createBikewayTexture({ aniso: a, seed: 307, lines: false })), vertexColors: true }),
    dirtPath: decalMaterial({ map: tex(AT.createPathDirtTexture({ aniso: a, seed: 61 })), vertexColors: true }),
    pool: new THREE.MeshLambertMaterial({ map: tex(AT.createPoolTexture({ aniso: a })), emissive: 0x0b3a50 }),
    water: new THREE.MeshBasicMaterial({ color: 0xe0f6ff, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }),
    flag: new THREE.MeshLambertMaterial({ map: tex(AT.createFlagsTexture({ aniso: a })), side: THREE.DoubleSide }),
  };
  M.pool.map.wrapS = M.pool.map.wrapT = THREE.RepeatWrapping;
  M.flag.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ctx.timeUniform;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      float fw = uv.x < 0.5 ? uv.x * 2.0 : (uv.x - 0.5) * 2.0;
      transformed.z += sin(uTime * 6.0 - position.x * 1.9) * 0.22 * fw;`);
  };
  M.flag.customProgramCacheKey = () => 'aldrich-flag';
  const detail = tex(AT.createLawnDetailTexture({ aniso: a }));

  // terrain: the lidar ground; the Engineering Bridge deck lets the service-road cut show under it
  const bridgeZ = (L.Z.bridge || [])[0];
  const field = createTerrainField(track, Q.terrainCell * 1.3, {
    natural: aldrichNatural(lidar, creek),
    signedDist: () => 1,
    extent: 1600,
    sections: (tr, { bridge, fillL, fillR }) => {
      for (let i = 0; i < tr.N; i++) {
        const s = i * sp;
        if (bridgeZ) bridge[i] = Math.max(bridge[i], zoneInterior(tr, bridgeZ, s, 7));
        fillL[i] = 0.45; fillR[i] = 0.45;
      }
    },
    bridgeFloor: (y0) => y0 - 1.5,
  });
  ctx.add(new THREE.Mesh(terrainGeometry(field, aldrichTerrainColor(raster, creek, field), 7),
    new THREE.MeshLambertMaterial({ vertexColors: true, map: detail })), { receive: true, name: 'Terrain' });

  // road: Ring Mall walkway texture everywhere, zone surfaces as decals
  const is = L.is;
  buildRoad(ctx, T, {
    offroadColor: (s, side) => {
      if (is('bridge', s)) return C.concrete;
      if (side < 0 && (is('ring', s) || is('plaza', s) || is('fountain', s))) return C.plaza;
      if (is('dirt', s) || is('arroyo', s)) return mixHex(C.lawn, C.soil, 0.35);
      if (is('grove', s)) return mixHex(C.lawn, C.litter, 0.3);
      return C.lawn;
    },
    roadRoughness: 0.9,
  });
  buildRoadSurfaces(ctx, L, M);
  buildStartLine(ctx, T);

  const BAND = AT.ALDRICH_WALL_BANDS;
  buildWalls(ctx, T, (i, side) => {
    const s = i * sp;
    if (is('bridge', s)) return 'none';
    if (inCrossing(L, track, s)) return 'none';
    if (is('ring', s) || is('plaza', s)) {
      if (side < 0) return track.offL[i] <= 3.05 ? 'rail' : 'seat';
      return 'hedge';
    }
    if (is('fountain', s) && side < 0) return 'seat';
    if (is('arch', s)) return side < 0 ? 'rail' : 'hedge';
    if (is('sculpture', s)) return side < 0 ? 'seat' : 'hedge';
    if (is('grove', s)) return side < 0 ? 'seat' : 'hedge';
    if (is('innerRing', s)) return side < 0 ? 'hedge' : 'timber';
    return 'timber';
  }, {
    rail: { band: BAND.rail, h: 1.05 },
    hedge: { band: BAND.hedge, h: 1.15 },
    seat: { band: BAND.seat, h: 0.62 },
    timber: { band: BAND.timber, h: 0.95 },
  });
  buildBoostPads(ctx, T);
  buildRamps(ctx, T);
  buildTurnSigns(ctx, T, { skip: (s) => is('bridge', s) || is('ring', s), postColor: 0xc8c2b4 });
  buildGantry(ctx, T, { pillarA: C.terracotta, pillarB: C.concrete, base: C.concreteDark, beam: 0x6b6f74, frame: 0x1e5a32 });

  const B = {
    struct: regionBuckets(ctx, ctx.M.structure, { name: 'Campus', cell: 270 }),
    facade: regionBuckets(ctx, M.facade, { name: 'Facades', cell: 270 }),
    farStruct: regionBuckets(ctx, ctx.M.structure, { name: 'CampusFar', cell: 900, cast: false, receive: false }),
    farFacade: regionBuckets(ctx, M.facade, { name: 'FacadesFar', cell: 900, cast: false, receive: false }),
  };
  const anim = [];
  const extra = { rocks: [], citrus: [], creek, ringZones: [...(L.Z.ring || []), ...(L.Z.plaza || [])] };
  const bridgeRange = buildEngineeringBridge(ctx, field, L, B);
  buildInfinityFountain(ctx, field, B, M, anim);
  buildRockGarden(ctx, field, B, extra.rocks, extra.citrus, rng);
  buildStatues(ctx, field, B);
  buildHumanitiesArch(ctx, field, B);
  buildGatewayLandmarks(ctx, field, B, M, anim);
  const footprints = buildCampusBuildings(ctx, field, B, rng);
  buildSetPieces(ctx, field, L, hz, B);
  for (const bk of Object.values(B)) bk.flush();
  buildSceneryPaths(ctx, field, M);
  buildFurniture(ctx, field, L, rng);
  buildVegetation(ctx, field, raster, footprints, extra, rng);
  buildRabbits(ctx, field, raster, rng);
  buildOuterCampus(ctx, field, rng);
  buildFarScenery(ctx, makeRng(313));
  buildClouds(ctx, { center: { x: 12.7, z: 1.9 }, sunDir, count: Math.round(Q.clouds * 0.5) });
  ctx.animators.push((dt, time) => { for (const f of anim) f(time); });

  if (bridgeRange) ctx.stats.bridges = [bridgeRange.map((v) => +v.toFixed(1))];
  ctx.stats.hazards = hz.list.length;
  return finishWorld(ctx, {
    sun, hemi, follow,
    getGroundHeight: (x, z) => field.surfaceHeight(x, z),
    extra: { hazards: hz },
  });
}
