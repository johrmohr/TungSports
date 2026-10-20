// World builder for "Breezy Bay Circuit" (browser only) + the shared world
// kit that every themed world uses (world-monte.js, dispatched by worlds.js).
//
//   import { buildWorld } from './worlds.js';      // picks the kit by track.theme
//   const world = buildWorld(scene, track, { renderer, quality: 'high' });
//   // every frame (once; extra split-screen views may call update(0, ...)):
//   world.update(dt, playerKart.position, camera);
//   // teardown:
//   world.dispose();
//
// Everything visual that is static to the course lives here: sky, fog,
// lights (the shadow-casting sun follows the focus position), terrain with
// embankments / cliffs / beaches, the animated bay, the road ribbon (exactly
// at physics height), curbs, off-road strips, barriers at exactly
// wallL / wallR, the arch bridge, start gantry, grid marks, boost pads,
// kicker ramps, corner signs, lighthouse, grandstands with a crowd, flags,
// instanced vegetation, distant mountains, clouds and sailboats.
// Item boxes are NOT built here (items.js owns them).
//
// Geography of the v5 layout (x right = east, z "down" = south on the map;
// notes/research-v5-tracks.md §B1; breezyCoast derives the coast from the walls):
//   * the open sea lies north of the beach loop and the cliffs, east of the
//     promenade / grandstand beach (pier + Ferris wheel) and west of the
//     lighthouse headland and the spit;
//   * the bay is the inlet between the headland and the spit: the harbour quay
//     along Ramp Run is its east shore, Crab Cove's beach its north shore, and
//     its southern arm runs under the Bay Bridge at the foot of Breezy Hill;
//   * the lagoon sits inside the Spit Turn double apex (the beacon island);
//   * the cliff road (Gull Rise → Cliff Sweep B) runs along 8 m sandstone sea
//     cliffs with a plateau behind them; the Gull Gap deck spans a surf notch.
// The v5 set pieces and landmarks are built by world-breezy.js.
//
// Quality: 'high' = one 2048 follow shadow map; 'low' (split-screen) = no
// shadow map at all (karts use blob shadows), coarser terrain, fewer props.
//
// Performance: static geometry is merged per material, repeated props use
// InstancedMesh. Budget at quality 'high': <= 120 draw calls, <= 280k tris
// (SPEC §16.1; Breezy's overview: ~106 calls, ~271k tris incl. the shadow pass).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CURB_WIDTH } from './track.js';
import { GAME_TITLE } from './config.js';
import { makeRng, clamp, lerp, smoothstep } from './utils.js';
import * as TX from './textures.js';
import { createHazards as createBayHazards } from './hazards/bay.js';
import { dressBreezyRoad, patchBreezyTerrain, buildBreezySetPieces, buildBreezyLandmarks } from './world-breezy.js';

// ------------------------------------------------------------------ constants

export const WATER_LEVEL = -1.6;           // sea surface height (m)
const SEABED = -7.5;                       // deepest terrain under the bay
const CLIFF_SLOPE = 3.2;                   // sea-cliff face steepness (m drop per m)
const CLIFF_SHOULDER = 0.9;                // flat cliff-top lip beyond the wall (m)
export const MIN_CAMERA_FAR = 1900;        // view distance the scenery is designed for
export const WALL_SKIRT = 6.0;             // barrier outer faces reach this far below the road (m)

// shadowMap 0 = the sun casts no shadows (split-screen: blob shadows instead).
const QUALITY = {
  high: { shadowMap: 2048, terrainCell: 3.5, veg: 1.0, crowd: 1.0, clouds: 16, depthTex: 1024, aniso: 8 },
  low:  { shadowMap: 0,    terrainCell: 5.5, veg: 0.45, crowd: 0.5, clouds: 9, depthTex: 512, aniso: 4 },
};

// Palette (sRGB hex). Bright, saturated, friendly.
const C = {
  skyTop: 0x3c8fe8, skyHorizon: 0xcfeafb, skyBottom: 0xb6dcf3,
  sun: 0xfff2dc, hemiSky: 0xd7ecff, hemiGround: 0x7d9a55,
  grass: 0x5cbc43, grassAlt: 0x78c94b, grassDeep: 0x46a336, meadow: 0x9fd25a,
  sand: 0xf0db9b, sandWet: 0xd8c084, rock: 0x9c9284, rockDark: 0x7b7267, seabed: 0xd3c088,
  farLand: 0x5f9f4f, concrete: 0xd4d1ca, concreteDark: 0xa9a59d, steel: 0xf05a28,
  white: 0xf7f6f2, red: 0xe5302a, blue: 0x2b6fd8, yellow: 0xffcf33, wood: 0x9a6a3c,
  trunk: 0x7a5232, pine: 0x2f8a46, leaf: 0x58b544, palmLeaf: 0x4fb04a, bush: 0x4aa83e,
  waterShallow: 0x5fe0d2, waterDeep: 0x1f7fc4, waterSky: 0xbfe6ff, foam: 0xffffff,
};

// Breezy Bay geography (v5 layout, notes/research-v5-tracks.md §B1; x right =
// east, z "down" = south on the map). The open sea lies north of the beach
// loop and the cliffs, east of the promenade / start straight and west of the
// lighthouse headland and the spit; the bay is the inlet between the headland
// and the spit (east shore: the harbour quay along Ramp Run, north shore: Crab
// Cove's beach), with its southern arm under the Bay Bridge at the foot of
// Breezy Hill. The lagoon sits inside the Spit Turn double apex.
// SEA_POLY / LAGOON_POLY are the static fallback outlines; buildWorld derives
// the exact coast from the track (breezyCoast) before the terrain is built.
const SEA_POLY = [
  [-3200, -3200], [3200, -3200], [3200, 700], [900, 560], [300, 330], [140, 215], [80, 150], [58, 100],
  [54, 60], [52, 10], [51, -40], [50, -80], [24, -105], [6, -150], [-39, -202], [-82, -226], [-130, -218],
  [-160, -200], [-184, -195], [-236, -186], [-275, -177], [-293, -138], [-293, -120], [-275, -82], [-236, -64],
  [-156, -64], [-133, -46], [-130, 40], [-154, 68], [-170, 72], [-171, 100], [-176, 108], [-253, 109],
  [-252, 99], [-250, 74], [-256, 64], [-300, 66], [-322, 88], [-340, 92], [-352, 106], [-346, 124], [-330, 130],
  [-322, 150], [-336, 178], [-392, 210], [-560, 250], [-1000, 300], [-3200, 340],
];
const LAGOON_POLY = [
  [-224, -110], [-205, -108.5], [-186, -110.5], [-171, -117], [-165, -130], [-169, -143], [-184, -150],
  [-206, -151.5], [-223, -148], [-223, -129],
];
// Raised rocky mounds: the lighthouse promontory and a little palm islet in the bay.
const ISLETS = [
  { x: -336, z: 108, r: 22, h: 3.4 },
  { x: -212, z: -12, r: 15, h: 2.2 },
];
const LIGHTHOUSE = { x: -334, z: 108 };          // (breezyCoast moves it with the hairpin)
const WORLD_CENTER = { x: -150, z: -20 };

// ------------------------------------------------------------------ small math (kit)

const _col = new THREE.Color();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _eul = new THREE.Euler();
const _p3 = new THREE.Vector3();
const _s3 = new THREE.Vector3();

export function hash2(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
}
export function fbm(x, z, octaves = 4) {
  let s = 0, a = 1, t = 0;
  for (let o = 0; o < octaves; o++) { s += vnoise(x, z) * a; t += a; a *= 0.5; x *= 2.03; z *= 2.03; }
  return s / t;
}

// Signed distance to the water outlines (sea + lagoon): + on land, - in water.
const toXZ = (poly) => ({ x: new Float64Array(poly.map((p) => p[0])), z: new Float64Array(poly.map((p) => p[1])) });
let WATER = [toXZ(SEA_POLY), toXZ(LAGOON_POLY)];
function polyDistance(P, x, z) {
  const X = P.x, Z = P.z, n = X.length;
  let inside = false, best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = X[i], zi = Z[i], xj = X[j], zj = Z[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const ex = xi - xj, ez = zi - zj, l2 = ex * ex + ez * ez;
    let t = l2 > 0 ? ((x - xj) * ex + (z - zj) * ez) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (xj + ex * t), dz = z - (zj + ez * t);
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  const d = Math.sqrt(best);
  return inside ? -d : d;
}
function coastDistance(x, z) {
  let land = Infinity;
  for (const P of WATER) {
    const d = polyDistance(P, x, z);
    if (d < 0) return d;
    if (d < land) land = d;
  }
  return land;
}

// The coast of the v5 layout, derived from the track (walls + offsets per
// stretch, by segment name) so it hugs the course exactly: returns
// { sea: [[x, z], ...], lagoon: [...], notch: { s0, s1 } } and installs it for
// coastDistance (the terrain, colours and props all read the same outline).
function breezyCoast(track) {
  const pts = [];
  const add = (x, z) => pts.push([x, z]);
  const seg = (name) => track.segments[segIndex(track, name)];
  const S = (name, k = 0) => { const g = seg(name); return g ? g.s0 + (g.s1 - g.s0) * k : NaN; };
  // points beyond the wall on one side (-1 left / +1 right) from s0 to s1 (either direction)
  const side = (s0, s1, sd, off, step = 5) => {
    const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / step));
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n, f = track.frameAt(s);
      const lat = sd * ((sd > 0 ? f.wallR : f.wallL) + off);
      add(f.x + f.right.x * lat, f.z + f.right.z * lat);
    }
  };
  const gap = track.zones.find((z) => z.type === 'gap');
  const notch = gap ? { s0: gap.s0 + 10, s1: gap.s0 + 36 } : null;
  if (!seg('Promenade') || !seg('Crab Cove') || !seg('Tide Causeway')) return null;   // not the v5 layout
  // landmarks that sit relative to the course: the lighthouse ~45 m beyond the hairpin's outer
  // wall (on its rocky promontory), the lagoon east of the spit's beacon island
  const hc = arcCenter(track, segIndex(track, 'Lighthouse Hairpin'));
  if (hc) { LIGHTHOUSE.x = hc.x - 70; LIGHTHOUSE.z = hc.z + 0.6; ISLETS[0].x = LIGHTHOUSE.x - 2; ISLETS[0].z = LIGHTHOUSE.z; }
  const ca = arcCenter(track, segIndex(track, 'Spit Turn A')), cb = arcCenter(track, segIndex(track, 'Spit Turn B'));
  const isl = ca && cb ? { x: (ca.x + cb.x) / 2, z: (ca.z + cb.z) / 2 } : { x: -236, z: -129.5 };
  const hx = hc ? hc.x : -264;
  add(-3200, -3200); add(3200, -3200); add(3200, 700);
  add(900, 560); add(300, 330); add(140, 215); add(82, 150); add(60, 100);   // the coast bends east beyond Turn 1
  add(55, 60); add(53, 10); add(52, -40); add(48, -82);                        // the promenade / grandstand beach
  side(S('Promenade'), S('Gull Gap', 1), -1, 6);                              // Cliff Sweep B
  if (notch) {                                                                 // the Gull Gap notch: surf under the deck
    side(S('Gull Gap', 1), notch.s1, -1, 5);
    side(notch.s1, notch.s1, 1, 8);
    side(notch.s0, notch.s0, 1, 8);
    side(notch.s0, S('Gull Gap'), -1, 5);
  } else side(S('Gull Gap', 1), S('Gull Gap'), -1, 5);
  side(S('Gull Gap'), S('Gull Rise'), -1, 6);                                  // cliffs: Sweep A, Cliff Road, Gull Rise
  side(S('Gull Rise'), S('Tide Causeway'), -1, -2);                            // the causeway: sea at the breakwater
  side(S('Tide Causeway'), S('Spit Turn A'), -1, 2);                           // round the spit
  side(S('Spit Turn A'), S('Crab Cove'), -1, 6);                               // Crab Cove's beach (the bay's north shore)
  side(S('Crab Cove'), S('Cove Bend'), -1, 0);                                 // the bay's north-east corner
  side(S('Cove Bend'), S('Ramp Run'), -1, -3);                                 // the harbour quay
  side(S('Ramp Run'), S('Harbor Kink') + 14, -1, 0);
  // the southern arm under the Bay Bridge, at the foot of Breezy Hill
  const b0 = track.frameAt(S('Bay Bridge', 1));
  add(b0.x - 16, b0.z - 11); add(b0.x - 17, b0.z + 16); add(b0.x - 22, b0.z + 25);
  side(S('Breezy Hill', 0.13), S('Breezy Hill', 0.9), 1, 3);
  const b1 = track.frameAt(S('Bay Bridge'));
  add(b1.x + 12, b1.z + 16); add(b1.x + 14, b1.z + 6); add(b1.x + 14, b1.z - 9); add(b1.x + 8, b1.z - 20);
  // the headland round the Lighthouse Hairpin, out to the lighthouse promontory
  side(S('Lighthouse Hairpin', 1), S('Lighthouse Hairpin', 0.66), -1, 6);
  add(LIGHTHOUSE.x + 12, LIGHTHOUSE.z - 20); add(LIGHTHOUSE.x - 6, LIGHTHOUSE.z - 16); add(LIGHTHOUSE.x - 18, LIGHTHOUSE.z - 2);
  add(LIGHTHOUSE.x - 12, LIGHTHOUSE.z + 16); add(LIGHTHOUSE.x + 4, LIGHTHOUSE.z + 22);
  add(hx - 58, 150); add(hx - 72, 178); add(hx - 128, 210); add(-560, 250); add(-1000, 300); add(-3200, 340);
  const sea = pts;
  // the lagoon inside the Spit Turn (between Crab Cove's and the causeway's inner walls), east of the island
  const lagoon = LAGOON_POLY.map((p) => [p[0] - (-236) + isl.x, p[1] - (-129.5) + isl.z]);
  WATER = [toXZ(sea), toXZ(lagoon)];
  return { sea, lagoon, notch, island: isl };
}

// Place a geometry: rotation (Euler YXZ: yaw, pitch, roll), translation, scale.
export function place(geom, x, y, z, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _eul.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_eul);
  _m4.compose(_p3.set(x, y, z), _q, _s3.set(sx, sy, sz));
  return geom.applyMatrix4(_m4);
}

// Make a geometry merge-compatible: indexed, has uv, has a color attribute
// (filled with `color` unless one exists and color is null).
export function paint(geom, color) {
  const n = geom.attributes.position.count;
  if (!geom.index) {
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!geom.attributes.normal) geom.computeVertexNormals();
  if (!geom.attributes.uv) geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (color !== null && color !== undefined) {
    _col.set(color);
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b; }
    geom.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  return geom;
}

// Color each face of a non-indexed geometry with fn(centroidY, normalY) -> hex/Color.
export function faceColors(geom, fn) {
  const pos = geom.attributes.position, n = pos.count;
  const arr = new Float32Array(n * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    nrm.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    const col = fn((a.y + b.y + c.y) / 3, nrm.y, i / 3);
    _col.set(col);
    for (let k = 0; k < 3; k++) { arr[(i + k) * 3] = _col.r; arr[(i + k) * 3 + 1] = _col.g; arr[(i + k) * 3 + 2] = _col.b; }
  }
  geom.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geom;
}

export const mixHex = (a, b, t) => _col.set(a).lerp(new THREE.Color(b), clamp(t, 0, 1)).getHex();

// Compose a TRS matrix (yaw only) into `m`.
export function place_m4(m, x, y, z, yaw, sx, sy, sz) {
  _eul.set(0, yaw, 0, 'YXZ');
  _q.setFromEuler(_eul);
  return m.compose(_p3.set(x, y, z), _q, _s3.set(sx, sy, sz));
}

// Merge `parts` (painted geometries), dispose the parts, add one mesh.
export function addMerged(ctx, parts, material, opts) {
  if (!parts.length) return null;
  const geo = mergeGeometries(parts);
  parts.forEach((g) => g.dispose());
  return ctx.add(new THREE.Mesh(geo, material), opts);
}

// Static geometry merged per region cell: the view frustum and the shadow
// pass skip far cells while a whole area stays a handful of draw calls.
// push(geometry) files a painted / merge-compatible geometry by the centre
// of its bounding box; flush() adds one mesh per cell.
export function regionBuckets(ctx, material, { cell = 120, name = 'Region', cast = true, receive = true } = {}) {
  const cells = new Map();
  return {
    push(geo) {
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const key = `${Math.floor((bb.min.x + bb.max.x) / 2 / cell)},${Math.floor((bb.min.z + bb.max.z) / 2 / cell)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(geo);
    },
    flush() {
      let k = 0;
      for (const parts of cells.values()) addMerged(ctx, parts, material, { cast, receive, name: `${name}${k++}` });
      cells.clear();
    },
  };
}

// ------------------------------------------------------------------ track strips (kit)

// Build an indexed strip following the track. `sList` = arc lengths of the
// rows; `cols` columns per row; fn(frame, s, c, o, r) sets o.lat (lateral),
// o.dy (height offset), optional o.y (absolute base height, default road
// centerline height), o.u / o.v and (with color) o.r / o.g / o.b.
// Column order must go left -> right (increasing lateral) for an upward face;
// in general the face normal is (col1 - col0) x forward.
const _frame = {};
export function trackStrip(track, sList, cols, fn, { color = false } = {}) {
  const rows = sList.length, nv = rows * cols;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const col = color ? new Float32Array(nv * 3) : null;
  const o = { lat: 0, dy: 0, y: NaN, u: 0, v: 0, r: 1, g: 1, b: 1 };
  let p = 0, q = 0;
  for (let r = 0; r < rows; r++) {
    const s = sList[r];
    track.frameAt(s, _frame);
    for (let c = 0; c < cols; c++) {
      o.y = NaN; o.dy = 0;
      fn(_frame, s, c, o, r);
      const base = Number.isNaN(o.y) ? _frame.y : o.y;
      pos[p] = _frame.x + _frame.right.x * o.lat;
      pos[p + 1] = base + o.dy;
      pos[p + 2] = _frame.z + _frame.right.z * o.lat;
      if (col) { col[p] = o.r; col[p + 1] = o.g; col[p + 2] = o.b; }
      p += 3;
      uv[q++] = o.u; uv[q++] = o.v;
    }
  }
  const idx = new (nv > 65535 ? Uint32Array : Uint16Array)((rows - 1) * (cols - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, c2 = a + cols, d = c2 + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = c2;
      idx[k++] = b; idx[k++] = d; idx[k++] = c2;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// Arc lengths from s0 to s1 (s1 may exceed L; frameAt wraps) with ~step spacing.
export function sRange(s0, s1, step) {
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  const out = new Array(n + 1);
  for (let i = 0; i <= n; i++) out[i] = s0 + ((s1 - s0) * i) / n;
  return out;
}

// Weight of arc length s inside zone z: 1 inside, falling to 0 over `soft` m outside.
export function zoneWeight(track, z, s, soft) {
  const len = track.forwardDistance(z.s0, z.s1);
  const d = track.forwardDistance(z.s0, s);
  if (d <= len) return 1;
  const out = Math.min(d - len, track.length - d);
  return 1 - smoothstep(out / soft);
}
// Weight that is 0 at the zone ends and 1 deeper than `ramp` m inside.
export function zoneInterior(track, z, s, ramp) {
  const len = track.forwardDistance(z.s0, z.s1);
  const d = track.forwardDistance(z.s0, s);
  if (d > len) return 0;
  return smoothstep(Math.min(d, len - d) / ramp);
}
export function inZone(track, z, s) {
  return track.forwardDistance(z.s0, s) <= track.forwardDistance(z.s0, z.s1);
}

// Breezy's natural ground (land, beaches, seabed, hills far from the track).
function breezyNatural(x, z, minE, sd) {
  let h;
  if (sd >= 0) {
    const rc = Math.hypot(x - WORLD_CENTER.x, z - WORLD_CENTER.z);
    const amp = lerp(9, 46, smoothstep((rc - 380) / 1000)) *
      smoothstep((minE - 18) / 95) * smoothstep((sd - 6) / 60);
    const n = fbm(x * 0.0062 + 3.1, z * 0.0062 - 1.7, 4);
    h = 0.35 * smoothstep(sd / 9) + amp * Math.max(0, n - 0.3) * 1.9;
  } else {
    h = Math.max(SEABED, -0.35 + sd * 0.2);
  }
  for (const isl of ISLETS) {
    const d = Math.hypot(x - isl.x, z - isl.z);
    if (d < isl.r) {
      const t = smoothstep((1 - d / isl.r) / 0.65);
      const bump = lerp(SEABED + 2, isl.h, t) + (fbm(x * 0.15, z * 0.15, 2) - 0.5) * 1.2 * t;
      if (bump > h) h = bump;
    }
  }
  return h;
}

// Breezy's zone shaping of the embankments: the hill's rocky face into the
// bay's southern arm, the sea cliffs (left) with the plateau behind them
// (right: a gentle fall-off instead of an embankment), the harbour quay (left:
// a stone edge straight into deep water), the causeway's breakwater shoulder
// and the Gull Gap notch (carved under the timber deck like a bridge).
function breezySections(track, { fillL, fillR, shL, shR, bridge, cliff }) {
  const N = track.N, sp = track.spacing;
  const gap = track.zones.find((z) => z.type === 'gap');
  const notch = gap ? { s0: gap.s0 + 10, s1: gap.s0 + 36 } : null;
  for (let i = 0; i < N; i++) {
    const s = i * sp;
    for (const z of track.zones) {
      if (z.type === 'bridge') bridge[i] = Math.max(bridge[i], zoneInterior(track, z, s, 14));
      else if (z.type === 'hill') fillR[i] = lerp(fillR[i], 1.9, zoneWeight(track, z, s, 14));
      else if (z.type === 'cliff') {
        const w = zoneWeight(track, z, s, 10);
        cliff[i] = Math.max(cliff[i], zoneInterior(track, z, s, 18));
        fillL[i] = lerp(fillL[i], CLIFF_SLOPE, w);
        shL[i] = lerp(shL[i], CLIFF_SHOULDER, w);
        fillR[i] = lerp(fillR[i], 0.13, w);
        shR[i] = lerp(shR[i], 7, w);
      } else if (z.type === 'harbor') {
        const w = zoneWeight(track, z, s, 8);
        cliff[i] = Math.max(cliff[i], zoneInterior(track, z, s, 8));
        fillL[i] = lerp(fillL[i], CLIFF_SLOPE, w);
        shL[i] = lerp(shL[i], 1.2, w);
      } else if (z.type === 'causeway') {
        const w = zoneWeight(track, z, s, 12);
        shL[i] = lerp(shL[i], 2.6, w);
        fillL[i] = lerp(fillL[i], 2.4, w);                 // the sea right at the breakwater
      }
    }
    if (notch) {
      const d = track.forwardDistance(notch.s0, s), len = notch.s1 - notch.s0;
      if (d <= len) bridge[i] = Math.max(bridge[i], smoothstep(Math.min(d, len - d) / 4));
    }
  }
}

// ------------------------------------------------------------------ terrain field (kit)

// Height function of the landscape. Natural ground (opts.natural) is
// combined with embankment fills / cuts from every nearby track section, and
// pinned flat just under the road surface inside each wall corridor (+ a
// shoulder) so no road section ever floats. Defaults build Breezy Bay.
//   opts.natural(x, z, minE, sd) -> ground height far from the road
//   opts.signedDist(x, z)       -> + land / - sea (kept per vertex as SD)
//   opts.sections(track, arrays) shapes fillL/fillR/shL/shR/bridge/cliff
//   opts.bridgeFloor(roadY)     -> terrain cap under bridge zones
//   opts.extent                 -> how far the geometric outer grid reaches (m)
export function createTerrainField(track, cellSize, {
  natural = breezyNatural, signedDist = coastDistance, sections: shape = breezySections,
  bridgeFloor = () => SEABED, extent = 2600,
} = {}) {
  const N = track.N;
  const { px, py, pz, rx, rz, wl, wr } = track;
  // flat shoulder beyond the walls: at least a grid cell wide, so coarse
  // grids ('low' quality) never interpolate a bank up through the road edge
  const SH = Math.max(4.0, cellSize + 0.5);
  const fillL = new Float32Array(N).fill(0.55), fillR = new Float32Array(N).fill(0.55);
  const shL = new Float32Array(N).fill(SH), shR = new Float32Array(N).fill(SH);
  const bridge = new Float32Array(N);
  const cliff = new Float32Array(N);       // sea-cliff strength (left side), 0 at the zone ends
  shape(track, { fillL, fillR, shL, shR, bridge, cliff });

  // Chunked bounding circles over the samples for fast neighbourhood queries.
  const CH = 8, nCh = Math.ceil(N / CH);
  const chX = new Float64Array(nCh), chZ = new Float64Array(nCh), chR = new Float64Array(nCh);
  for (let c = 0; c < nCh; c++) {
    const i0 = c * CH, i1 = Math.min(N, i0 + CH);
    let sx = 0, sz = 0;
    for (let i = i0; i < i1; i++) { sx += px[i]; sz += pz[i]; }
    chX[c] = sx / (i1 - i0); chZ[c] = sz / (i1 - i0);
    let r = 0;
    for (let i = i0; i < i1; i++) r = Math.max(r, Math.hypot(px[i] - chX[c], pz[i] - chZ[c]));
    chR[c] = r;
  }
  const INF_R = 75, INF_R2 = INF_R * INF_R;
  const d2 = new Float64Array(N).fill(Infinity);
  const touched = new Int32Array(N);
  const MAXS = 48;
  const secI = new Int32Array(MAXS), secE = new Float64Array(MAXS), secR = new Uint8Array(MAXS);

  // Finds every track section near (x, z): local minima of distance along the
  // sample sequence. Fills secI (sample), secE (distance beyond the wall,
  // negative inside the corridor), secR (1 = right side). Returns the count.
  function sections(x, z) {
    let nt = 0;
    for (let c = 0; c < nCh; c++) {
      const dx = x - chX[c], dz = z - chZ[c], rr = INF_R + chR[c];
      if (dx * dx + dz * dz > rr * rr) continue;
      const i1 = Math.min(N, (c + 1) * CH);
      for (let i = c * CH; i < i1; i++) {
        const ex = x - px[i], ez = z - pz[i];
        d2[i] = ex * ex + ez * ez;
        touched[nt++] = i;
      }
    }
    let ns = 0;
    for (let k = 0; k < nt; k++) {
      const i = touched[k], di = d2[i];
      if (di > INF_R2) continue;
      if (di <= d2[(i - 1 + N) % N] && di < d2[(i + 1) % N] && ns < MAXS) {
        const lat = (x - px[i]) * rx[i] + (z - pz[i]) * rz[i];
        const right = lat >= 0;
        secI[ns] = i; secR[ns] = right ? 1 : 0;
        secE[ns] = Math.abs(lat) - (right ? wr[i] : wl[i]);
        ns++;
      }
    }
    for (let k = 0; k < nt; k++) d2[touched[k]] = Infinity;
    return ns;
  }

  // Exact height (slow-ish: used to build the grid).
  function heightAt(x, z, sd = signedDist(x, z)) {
    const ns = sections(x, z);
    let minE = Infinity;
    for (let k = 0; k < ns; k++) if (secE[k] < minE) minE = secE[k];
    let h = natural(x, z, minE, sd);
    // embankment fills (raise terrain toward elevated road)
    for (let k = 0; k < ns; k++) {
      const i = secI[k], e = secE[k], right = secR[k];
      const y0 = py[i] - 0.25, b = bridge[i];
      const sh = right ? shR[i] : shL[i], sl = right ? fillR[i] : fillL[i];
      const f = y0 - b * 16 - sl * Math.max(0, e - sh);
      if (f > h) h = f;
    }
    // cuts (terrain never above the road corridor; under a bridge: its floor)
    for (let k = 0; k < ns; k++) {
      const i = secI[k], e = secE[k], right = secR[k];
      const y0 = py[i] - 0.25, b = bridge[i];
      const sh = right ? shR[i] : shL[i];
      const top = b > 0 ? lerp(y0, bridgeFloor(y0), b) : y0, slope = lerp(0.8, 1.3, b);
      const c = top + slope * Math.max(0, e - lerp(sh, 1.5, b));
      if (c < h) h = c;
    }
    // sea cliffs: the sea side of cliff sections plunges steeply to deep water
    for (let k = 0; k < ns; k++) {
      const i = secI[k];
      if (secR[k] || cliff[i] <= 0) continue;
      const drop = Math.max(SEABED, py[i] - 0.25 - CLIFF_SLOPE * Math.max(0, secE[k] - shL[i]));
      if (drop < h) h = lerp(h, drop, cliff[i]);
    }
    // pins: flat, just below the road, inside corridor + shoulder
    for (let k = 0; k < ns; k++) {
      const i = secI[k];
      if (bridge[i] > 0) continue;
      if (secE[k] <= (secR[k] ? shR[i] : shL[i])) h = py[i] - 0.25;
    }
    return h;
  }

  // Tensor-product grid: uniform cells over the course, growing geometrically outside.
  const b = track.bounds;
  const core = { x0: Math.floor(b.minX - 58), x1: Math.ceil(b.maxX + 52), z0: Math.floor(b.minZ - 60), z1: Math.ceil(b.maxZ + 56) };
  function axis(a0, a1, cell, ext) {
    const n = Math.max(2, Math.round((a1 - a0) / cell));
    const st = (a1 - a0) / n;
    const before = [], after = [];
    let step = st, p = a1;
    while (p < a1 + ext) { step *= 1.36; p += step; after.push(p); }
    step = st; p = a0;
    while (p > a0 - ext) { step *= 1.36; p -= step; before.push(p); }
    const arr = [...before.reverse()];
    for (let k = 0; k <= n; k++) arr.push(a0 + k * st);
    arr.push(...after);
    return { arr: new Float64Array(arr), i0: before.length, i1: before.length + n, step: st };
  }
  const ax = axis(core.x0, core.x1, cellSize, extent);
  const az = axis(core.z0, core.z1, cellSize, extent);
  const xs = ax.arr, zs = az.arr, nx = xs.length, nz = zs.length;
  const H = new Float32Array(nx * nz), SD = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xs[i], z = zs[j];
      const sd = signedDist(x, z);
      SD[j * nx + i] = sd;
      H[j * nx + i] = heightAt(x, z, sd);
    }
  }

  function findCell(arr, v) {
    let lo = 0, hi = arr.length - 1;
    if (v <= arr[0]) return 0;
    if (v >= arr[hi]) return hi - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid; else hi = mid; }
    return lo;
  }
  // Height of the rendered (triangulated) terrain surface at (x, z).
  function surfaceHeight(x, z) {
    const i = findCell(xs, x), j = findCell(zs, z);
    const fx = clamp((x - xs[i]) / (xs[i + 1] - xs[i]), 0, 1);
    const fz = clamp((z - zs[j]) / (zs[j + 1] - zs[j]), 0, 1);
    const h00 = H[j * nx + i], h10 = H[j * nx + i + 1], h01 = H[(j + 1) * nx + i], h11 = H[(j + 1) * nx + i + 1];
    // diagonal (i,j)-(i+1,j+1), matching the mesh triangulation
    if (fx >= fz) return h00 + (h10 - h00) * fx + (h11 - h10) * fz;
    return h00 + (h11 - h01) * fx + (h01 - h00) * fz;
  }

  // Clearance of (x, z) from the drivable corridor: min distance beyond any wall.
  function wallClearance(x, z) {
    const ns = sections(x, z);
    let minE = Infinity;
    for (let k = 0; k < ns; k++) if (secE[k] < minE) minE = secE[k];
    return minE;
  }

  return { xs, zs, nx, nz, H, SD, core, coreIdx: { i0: ax.i0, i1: ax.i1, j0: az.i0, j1: az.i1 },
    heightAt, surfaceHeight, wallClearance, bridge, cliff, fillL, fillR, shL, shR };
}

// Indexed terrain geometry for a field; colorAt(c, x, z, h, slope, sd) writes
// the vertex colour into THREE.Color c. Diagonals match field.surfaceHeight.
export function terrainGeometry(field, colorAt, uvScale = 9) {
  const { xs, zs, nx, nz, H, SD } = field;
  const nv = nx * nz;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3);
  const c = new THREE.Color();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = xs[i], z = zs[j], h = H[k];
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      uv[k * 2] = x / uvScale; uv[k * 2 + 1] = z / uvScale;
      // slope from neighbours
      const il = Math.max(0, i - 1), ir = Math.min(nx - 1, i + 1), jl = Math.max(0, j - 1), jr = Math.min(nz - 1, j + 1);
      const gx = (H[j * nx + ir] - H[j * nx + il]) / (xs[ir] - xs[il]);
      const gz = (H[jr * nx + i] - H[jl * nx + i]) / (zs[jr] - zs[jl]);
      colorAt(c, x, z, h, Math.hypot(gx, gz), SD[k]);
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let q = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c2 = a + nx, d = c2 + 1;
      idx[q++] = a; idx[q++] = d; idx[q++] = b;      // diagonal a-d (see surfaceHeight)
      idx[q++] = a; idx[q++] = c2; idx[q++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ world context (kit)

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Shared state of one world build: root group, quality settings, texture /
// animator bookkeeping, shared vertex-colour materials and the prop footprint
// log (stats.props: [x, z, r, kind] circles beside the track, verified by
// public/dev/world.html's verifyProps()).
export function createWorldContext(scene, track, { renderer = null, quality = 'high' } = {}) {
  const qName = QUALITY[quality] ? quality : 'high';
  const Q = QUALITY[qName];
  const root = new THREE.Group();
  root.name = 'World';
  scene.add(root);
  const loopS = new Array(track.N + 1);
  for (let i = 0; i <= track.N; i++) loopS[i] = i * track.spacing;
  const ctx = {
    scene, track, Q, quality: qName, root, loopS,
    t0: nowMs(),
    maxAniso: renderer ? Math.min(Q.aniso, renderer.capabilities.getMaxAnisotropy()) : 4,
    shadows: Q.shadowMap > 0,           // 'low': no shadow map at all (blob shadows)
    textures: [],                        // every texture we create (disposed in dispose())
    animators: [],                       // (dt, time, camera) callbacks run by update()
    exclusions: [],                      // [x, z, r] circles where no vegetation may grow
    flagSpots: [],                       // [x, y, z, yaw, tall?]
    landmarks: [],                       // { name, x, z, r, h } tall props (cameras keep clear)
    stats: { instances: {}, buildMs: 0, props: [], quality: qName },
    timeUniform: { value: 0 },
    prevFog: scene.fog, prevBackground: scene.background,
    M: {
      structure: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      veg: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    },
  };
  ctx.prop = (kind, x, z, r) => { ctx.stats.props.push([x, z, r, kind]); };
  ctx.tex = (t) => { ctx.textures.push(t); return t; };
  ctx.add = (obj, { cast = false, receive = false, name = '' } = {}) => {
    obj.castShadow = cast && ctx.shadows;
    obj.receiveShadow = receive && ctx.shadows;
    if (name) obj.name = name;
    root.add(obj);
    return obj;
  };
  return ctx;
}

// ------------------------------------------------------------------ sky, fog, lights (kit)

// Gradient sky dome drawn on the far plane, with a soft sun glow; sets the
// scene fog / background (restored by dispose()).
export function buildSky(ctx, { sunDir, top, horizon, bottom, sunColor = 0xfff6e0, fogColor = horizon, fogNear = 220, fogFar = 1650 }) {
  const { scene } = ctx;
  scene.fog = new THREE.Fog(fogColor, fogNear, fogFar);
  scene.background = new THREE.Color(horizon);
  ctx.fogRef = scene.fog; ctx.bgRef = scene.background;
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(top) },
      uHorizon: { value: new THREE.Color(horizon) },
      uBottom: { value: new THREE.Color(bottom) },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(sunColor) },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = vec4(p.xy, p.w * 0.99999, p.w);   // always on the far plane
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uHorizon, uBottom, uSunDir, uSunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h > 0.0
          ? mix(uHorizon, uTop, pow(smoothstep(0.0, 0.72, h), 0.75))
          : mix(uHorizon, uBottom, smoothstep(0.0, -0.2, h));
        float sd = max(dot(d, uSunDir), 0.0);
        col += uSunColor * (pow(sd, 6.0) * 0.12 + pow(sd, 90.0) * 0.45);
        col = mix(col, vec3(1.0, 0.99, 0.94), smoothstep(0.99935, 0.99965, sd));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
    toneMapped: false,
  });
  const sky = ctx.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat), { name: 'Sky' });
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  return sky;
}

// Hemisphere fill + the sun. At quality 'high' the sun casts one tight 70 m
// shadow box that follows the focus (texel-snapped); at 'low' it casts none.
export function buildLights(ctx, { sunDir, sunColor, sunIntensity = 2.7, hemiSky, hemiGround, hemiIntensity = 1.35 }) {
  const { Q, root, track } = ctx;
  const hemi = ctx.add(new THREE.HemisphereLight(hemiSky, hemiGround, hemiIntensity), { name: 'Hemi' });
  const sun = new THREE.DirectionalLight(sunColor, sunIntensity);
  sun.name = 'Sun';
  sun.castShadow = ctx.shadows;
  // The light sits SUN_DIST m up-sun of the focus and the depth range only
  // spans what can shade the box (tall props included), which keeps depth
  // precision high so the bias can stay small.
  const SHADOW_HALF = 35, SUN_DIST = 150;
  if (ctx.shadows) {
    sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
    Object.assign(sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: SUN_DIST - 90, far: SUN_DIST + 60 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.00022;      // ~3 cm over the 150 m depth range
    sun.shadow.normalBias = 0.028;   // ~0.8 texel
    sun.shadow.radius = 2.2;
  }
  root.add(sun);
  root.add(sun.target);
  // light-space basis for texel snapping (prevents shadow shimmer while moving)
  const lightRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize();
  const lightUp = new THREE.Vector3().crossVectors(sunDir, lightRight).normalize();
  const shadowTexel = (SHADOW_HALF * 2) / Math.max(1, Q.shadowMap);
  const _focus = new THREE.Vector3(), _fwd = new THREE.Vector3();
  const startPos = track.startLine.position.clone();

  // Shadow box follows the focus, pushed a little ahead along the view
  // direction so more of the visible ground gets shadows; snapped to
  // shadow-map texels to avoid shimmering edges.
  function follow(focusPosition, camera) {
    _focus.copy(focusPosition || startPos);
    if (camera) {
      camera.getWorldDirection(_fwd);
      _fwd.y = 0;
      const l = _fwd.length();
      if (l > 1e-4) _focus.addScaledVector(_fwd, 12 / l);
    }
    const a = Math.round(_focus.dot(lightRight) / shadowTexel) * shadowTexel;
    const b = Math.round(_focus.dot(lightUp) / shadowTexel) * shadowTexel;
    const c = _focus.dot(sunDir);
    _focus.copy(lightRight).multiplyScalar(a).addScaledVector(lightUp, b).addScaledVector(sunDir, c);
    sun.target.position.copy(_focus);
    sun.position.copy(_focus).addScaledVector(sunDir, SUN_DIST);
    sun.target.updateMatrixWorld();
  }
  follow(startPos, null);
  return { sun, hemi, follow };
}

// The texture set every course uses (road, curbs, grass strip, terrain
// detail, start checker, boost chevrons, ramp, wall atlas, banner, signs).
// opts.road: a road texture to use instead of asphalt; opts.banner: banner
// colour options (see textures.createBannerTexture); opts.curbColors: the
// two curb block colours (CSS, default red / white).
export function createTrackTextures(ctx, { road = null, wall = null, banner = {}, curbColors = undefined } = {}) {
  const a = ctx.maxAniso, tex = ctx.tex;
  const T = {
    road: tex(road || TX.createAsphaltTexture({ aniso: a })),
    curb: tex(TX.createCurbTexture({ aniso: a, colors: curbColors })),
    grassStrip: tex(TX.createGrassTexture({ aniso: a, stripes: true })),
    detail: tex(TX.createDetailTexture({ aniso: a })),
    checker: tex(TX.createCheckerTexture({ aniso: a })),
    chevron: tex(TX.createChevronTexture({ aniso: a })),
    hazard: tex(TX.createHazardTexture({ aniso: a })),
    rampTop: tex(TX.createRampTopTexture({ aniso: a })),
    wall: tex(wall || TX.createWallAtlasTexture({ aniso: a })),
    banner: tex(TX.createBannerTexture(GAME_TITLE, { aniso: a, ...banner })),
    sign: tex(TX.createTurnSignTexture({ aniso: a })),
  };
  T.wall.wrapT = THREE.ClampToEdgeWrapping;
  return T;
}

// ------------------------------------------------------------------ road, curbs, off-road (kit)

// Curb width on one side (narrows where the run-off is thinner than a curb).
export function curbWidth(f, side) {
  return clamp(Math.min(CURB_WIDTH, (side > 0 ? f.wallR : f.wallL) - f.halfWidth - 0.03), 0.12, CURB_WIDTH);
}

// Road ribbon exactly at physics height, beveled curbs and the off-road
// strips from the curb to just past the wall. offroadColor(s, side) -> hex
// tints the (grass-textured) strip per arc length (e.g. stone on bridges);
// shade(s) -> 0..1 optionally darkens road + strips (covered sections when
// there is no shadow map).
export function buildRoad(ctx, T, { offroadColor = () => C.grass, roadRoughness = 0.88, shade = null } = {}) {
  const { track, loopS } = ctx, L = track.length;
  const roadTile = L / Math.max(1, Math.round(L / 16));
  const curbTile = L / Math.max(1, Math.round(L / 3));
  // Five columns (u = 0, .25, .5, .75, 1): where the width changes, a
  // two-column trapezoid would kink the painted lines (affine per-triangle
  // mapping); with a vertex column on the center line it stays straight.
  const ROAD_U = [0, 0.25, 0.5, 0.75, 1];
  const road = trackStrip(track, loopS, ROAD_U.length, (f, s, c, o) => {
    o.lat = (ROAD_U[c] * 2 - 1) * f.halfWidth;
    o.u = ROAD_U[c]; o.v = s / roadTile;
    if (shade) o.r = o.g = o.b = shade(s);
  }, { color: !!shade });
  const mat = new THREE.MeshStandardMaterial({ map: T.road, roughness: roadRoughness, metalness: 0.0, vertexColors: !!shade });
  ctx.add(new THREE.Mesh(road, mat), { receive: true, name: 'Road' });

  // Curbs: beveled profile, raised 7 cm, on both edges.
  const prof = [[0, 0.004], [0.28, 0.07], [0.93, 0.07], [1.0, 0.0]];
  const curbs = [];
  for (const side of [-1, 1]) {
    curbs.push(trackStrip(track, loopS, 4, (f, s, c, o) => {
      const k = side > 0 ? c : 3 - c;
      const cw = curbWidth(f, side);
      o.lat = side * (f.halfWidth + prof[k][0] * cw);
      o.dy = prof[k][1];
      o.u = prof[k][0]; o.v = s / curbTile;
    }));
  }
  const curbMat = new THREE.MeshStandardMaterial({ map: T.curb, roughness: 0.7 });
  addMerged(ctx, curbs, curbMat, { receive: true, name: 'Curbs' });

  // Off-road strip from the curb to just past the wall.
  const cc = new THREE.Color();
  const strips = [];
  for (const side of [-1, 1]) {
    strips.push(trackStrip(track, loopS, 2, (f, s, c, o) => {
      const k = side > 0 ? c : 1 - c;
      const wall = side > 0 ? f.wallR : f.wallL;
      const e = k ? wall + 0.55 : f.halfWidth + curbWidth(f, side);
      o.lat = side * e;
      o.u = o.lat / 12; o.v = s / 12;
      cc.set(offroadColor(s, side));
      if (shade) cc.multiplyScalar(shade(s));
      o.r = cc.r; o.g = cc.g; o.b = cc.b;
    }, { color: true }));
  }
  const grassMat = new THREE.MeshLambertMaterial({ map: T.grassStrip, vertexColors: true });
  addMerged(ctx, strips, grassMat, { receive: true, name: 'Offroad' });
}

// Checkered start strip + white grid-slot brackets.
export function buildStartLine(ctx, T) {
  const { track } = ctx;
  const hwAt = (s) => track.frameAt(s).halfWidth;
  const start = trackStrip(track, [-1.1, 0, 1.1], 2, (f, s, c, o) => {
    o.lat = (c ? 1 : -1) * f.halfWidth; o.dy = 0.012;
    o.u = (o.lat + f.halfWidth) / 2.2; o.v = (s + 1.1) / 2.2;
  });
  const mat = new THREE.MeshStandardMaterial({ map: T.checker, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  ctx.add(new THREE.Mesh(start, mat), { receive: true, name: 'StartLine' });

  // white "U" brackets in front of each grid slot
  const marks = [];
  const bar = (sA, sB, latA, latB) => trackStrip(track, sRange(sA, sB, 0.5), 2, (f, s, c, o) => {
    o.lat = c ? latB : latA; o.dy = 0.012; o.u = 0; o.v = 0;
  });
  for (let i = 0; i < 8; i++) {
    const g = track.gridSlot(i);
    const sF = g.s + 1.7, sB = g.s - 1.3, l = g.lateral;
    marks.push(bar(sF - 0.25, sF, l - 1.3, l + 1.3));
    marks.push(bar(sB, sF - 0.25, l - 1.3, l - 1.1));
    marks.push(bar(sB, sF - 0.25, l + 1.1, l + 1.3));
  }
  // a thin white line just behind the checker strip
  marks.push(bar(-1.5, -1.25, -hwAt(0), hwAt(0)));
  const markMat = new THREE.MeshLambertMaterial({ color: 0xf4f4ee, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  addMerged(ctx, marks, markMat, { receive: true, name: 'GridMarks' });
}

// ------------------------------------------------------------------ walls (kit)

// Min distance of a circle (x, z, r) beyond the wall lines of the samples
// around index i0 that it overlaps along the track (negative = intrudes).
export function stackClearance(track, x, z, r, i0) {
  const N = track.N, sp = track.spacing;
  let worst = Infinity;
  for (let k = -4; k <= 4; k++) {
    const i = (i0 + k + N) % N;
    const dx = x - track.px[i], dz = z - track.pz[i];
    if (Math.abs(dx * track.tx[i] + dz * track.tz[i]) > sp * 0.5 + r) continue;
    const lat = dx * track.rx[i] + dz * track.rz[i];
    worst = Math.min(worst, Math.abs(lat) - r - (lat >= 0 ? track.wr[i] : track.wl[i]));
  }
  return worst;
}

// Barriers whose inner face is exactly at wallL / wallR. styleAt(i, side)
// names the style of sample i on side -1 (left) / +1 (right): a key of
// `bands` ({ band: atlas band index, h: height }) for a textured barrier,
// 'tires' for tyre stacks touching the wall line, or 'none' (the world
// builds its own barrier there, e.g. bridge parapets).
export function buildWalls(ctx, T, styleAt, bands) {
  const { track } = ctx, N = track.N, sp = track.spacing;
  const WALL_T = 0.5, WALL_TILE = 6, PIECE = 45;
  const tireSpots = [];   // [x, y, z, yaw] of tire stacks
  const wallMat = new THREE.MeshLambertMaterial({ map: T.wall });
  const bucket = regionBuckets(ctx, wallMat, { name: 'Walls' });
  let pieces = 0;
  for (const side of [-1, 1]) {
    // find runs of equal style starting at a style boundary
    const styles = new Array(N);
    for (let i = 0; i < N; i++) styles[i] = styleAt(i, side);
    let startI = 0;
    while (startI < N && styles[startI] === styles[(startI - 1 + N) % N]) startI++;
    if (startI >= N) startI = 0;
    let k = 0;
    while (k < N) {
      const st = styles[(startI + k) % N];
      let len = 1;
      while (k + len < N && styles[(startI + k + len) % N] === st) len++;
      const iA = startI + k, iB = startI + k + len;          // rows iA..iB inclusive
      if (st === 'tires') {
        for (let s = iA * sp + 0.5; s < iB * sp; s += 1.0) {
          const f = track.frameAt(s);
          const wall = side > 0 ? f.wallR : f.wallL;
          // Start touching the wall line, then push outward while any sample
          // the stack overlaps sees it inside the corridor (the wall line runs
          // diagonally where the run-off narrows).
          let lat = side * (wall + 0.47), x = 0, z = 0;
          for (let it = 0; it < 12; it++) {
            x = f.x + f.right.x * lat; z = f.z + f.right.z * lat;
            const clr = stackClearance(track, x, z, 0.46, f.index);
            if (clr >= 0.005) break;
            lat += side * (0.005 - clr);
          }
          tireSpots.push([x, f.y - 0.05, z, f.yaw]);
        }
      } else if (bands[st]) {
        // extend barrier runs one sample into neighbouring tire runs to hide the ends
        const ext0 = styles[(iA - 1 + N) % N] === 'tires' ? 1 : 0;
        const ext1 = styles[iB % N] === 'tires' ? 1 : 0;
        const sA = (iA - ext0) * sp, sB = (iB + ext1) * sp;
        const [v0, v1] = TX.wallBandV(bands[st].band);
        const H = bands[st].h;
        const wallAt = (f) => (side > 0 ? f.wallR : f.wallL);
        // profile for the right side: inner face (up), top (outward), outer
        // face (down: a deep skirt hides the ground falling away behind it)
        const faces = [
          [[0, -0.45], [0, H]],
          [[0, H], [WALL_T, H]],
          [[WALL_T, H], [WALL_T, -WALL_SKIRT]],
        ];
        // ≤ 45 m pieces so each region cell only holds nearby barriers
        for (let a = sA; a < sB - 1e-6; a += PIECE) {
          const sList = sRange(a, Math.min(sB, a + PIECE), sp);
          const parts = faces.map((face) => trackStrip(track, sList, 2, (f, s, c, o) => {
            const pt = side > 0 ? face[c] : face[1 - c];
            o.lat = side * (wallAt(f) + pt[0]);
            o.dy = pt[1];
            o.u = s / WALL_TILE;
            const isTop = face[0][1] === face[1][1];
            o.v = isTop ? v1 - 0.01 * (pt[0] / WALL_T) : lerp(v0, v1, clamp((pt[1] + 0.45) / (H + 0.45), 0, 1));
          }));
          bucket.push(mergeGeometries(parts));
          parts.forEach((g) => g.dispose());
          pieces++;
        }
      }
      k += len;
    }
  }
  if (pieces) bucket.flush(); else wallMat.dispose();

  // Tire stacks: three pinched tyres per stack, painted in bright colours,
  // with a dark hole on top. The stack's inner face touches the wall line.
  if (tireSpots.length) {
    const TR = 0.46, TH = 0.96;
    const tg = new THREE.CylinderGeometry(TR, TR, TH, 10, 3);
    const p = tg.attributes.position;
    const cols = new Float32Array(p.count * 3).fill(1);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (Math.abs(Math.abs(y) - TH / 6) < 0.01) { p.setX(i, x * 0.8); p.setZ(i, z * 0.8); }   // seams between tyres
      if (y > TH / 2 - 0.001 && Math.hypot(x, z) < 0.001) cols.fill(0.06, i * 3, i * 3 + 3); // tyre hole
    }
    tg.translate(0, TH / 2, 0);
    tg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    tg.computeVertexNormals();
    const inst = new THREE.InstancedMesh(tg, ctx.M.veg, tireSpots.length);
    const colors = [0xe8392f, 0xf5f5f0, 0x2f6fe0, 0xf5f5f0, 0xffc928, 0xf5f5f0];
    tireSpots.forEach(([x, y, z, yaw], i) => {
      place_m4(_m4, x, y, z, yaw + i * 0.7, 1, 1, 1);
      inst.setMatrixAt(i, _m4);
      inst.setColorAt(i, _col.set(colors[i % colors.length]));
      ctx.prop('tires', x, z, TR);
    });
    inst.computeBoundingSphere();
    ctx.add(inst, { cast: true, receive: true, name: 'TireStacks' });
    ctx.stats.instances.tires = tireSpots.length;
  }
}

// ------------------------------------------------------------------ boost pads, ramps, signs (kit)

export function buildBoostPads(ctx, T) {
  const { track } = ctx;
  if (!track.boostPads.length) return;
  const pads = track.boostPads.map((p) => trackStrip(track, sRange(p.s0, p.s1, 0.5), 2, (f, s, c, o) => {
    o.lat = c ? p.lat1 : p.lat0;
    o.y = track.pointAt(s, o.lat, _p3).y; o.dy = 0.025;
    o.u = c; o.v = (s - p.s0) / p.width;
  }));
  const padMat = new THREE.MeshBasicMaterial({ map: T.chevron, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  addMerged(ctx, pads, padMat, { receive: false, name: 'BoostPads' });
  ctx.animators.push((dt, time) => {
    T.chevron.offset.y = (T.chevron.offset.y - dt * 1.8) % 1;
    const k = 0.86 + 0.14 * Math.sin(time * 9);
    padMat.color.setRGB(k, k, k);
  });
}

// Kicker wedges: top exactly at the physics ramp height, hazard sides and a
// vertical drop face at the lip.
export function buildRamps(ctx, T) {
  const { track } = ctx;
  if (!track.ramps.length) return;
  const mid = (a, b) => a + (b - a) * 0.5;
  const tops = [], sides = [];
  for (const r of track.ramps) {
    const latBounds = (f) => (r.fullWidth ? [-f.halfWidth, f.halfWidth] : [r.lat0, r.lat1]);
    const sL = sRange(r.s0, r.s1, 0.25);
    const topY = (s, lat) => track.pointAt(s, lat, _p3).y;   // includes the ramp height (matches physics)
    tops.push(trackStrip(track, sL, 2, (f, s, c, o) => {
      const [a, b] = latBounds(f);
      o.lat = c ? b : a;
      o.y = topY(s, mid(a, b)); o.dy = 0.006;
      o.u = (o.lat - a) / 4.3; o.v = (s - r.s0) / r.length;
    }));
    // side walls (outward facing)
    for (const sideK of [0, 1]) {
      sides.push(trackStrip(track, sL, 2, (f, s, c, o) => {
        const [a, b] = latBounds(f);
        const lat = sideK ? b : a;
        const top = sideK ? c === 0 : c === 1;    // right side: top→bottom; left: bottom→top
        o.lat = lat;
        o.y = top ? topY(s, mid(a, b)) + 0.006 : f.y;
        o.u = (s - r.s0) / 1.6; o.v = top ? (o.y - f.y) / 1.6 : 0;
      }));
    }
    // vertical drop face at s1 (faces forward)
    const f = track.frameAt(r.s1);
    const [a, b] = latBounds(f);
    const yTop = topY(r.s1, mid(a, b)) + 0.006, yB = f.y;
    const P = (lat, y) => [f.x + f.right.x * lat, y, f.z + f.right.z * lat];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...P(a, yB), ...P(a, yTop), ...P(b, yB), ...P(b, yTop)], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, (yTop - yB) / 1.6, (b - a) / 1.6, 0, (b - a) / 1.6, (yTop - yB) / 1.6], 2));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    g.computeVertexNormals();
    sides.push(g);
  }
  const topMat = new THREE.MeshStandardMaterial({ map: T.rampTop, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const sideMat = new THREE.MeshStandardMaterial({ map: T.hazard, roughness: 0.6 });
  addMerged(ctx, tops, topMat, { cast: true, receive: true, name: 'RampTops' });
  addMerged(ctx, sides, sideMat, { cast: true, receive: true, name: 'RampSides' });
}

// Chevron boards on the outside of every turn tighter than R43, 1.5 m
// beyond the wall. skip(s, side) can veto a spot (e.g. where a building stands).
export function buildTurnSigns(ctx, T, { skip = null, postColor = 0x9aa0a8 } = {}) {
  const { track } = ctx, N = track.N, sp = track.spacing;
  const thr = 1 / 43;
  const curv = track.curv;
  let start = 0;
  while (start < N && Math.abs(curv[start]) > thr) start++;
  const turns = [];
  let cur = null;
  for (let k = 0; k <= N; k++) {
    const i = (start + k) % N, c = curv[i];
    const dir = Math.abs(c) > thr ? Math.sign(c) : 0;
    if (cur && (dir !== cur.dir || k === N)) { cur.iB = start + k - 1; turns.push(cur); cur = null; }
    if (!cur && dir !== 0 && k < N) cur = { dir, iA: start + k };
  }
  const spots = [];
  for (const t of turns) {
    const sA = t.iA * sp - 4, sB = t.iB * sp - 2;
    for (let s = sA; s <= sB; s += 8.5) {
      const f = track.frameAt(s);
      const side = -t.dir;                       // outside of the turn
      if (skip && skip(track.wrapS(s), side)) continue;
      const wall = side > 0 ? f.wallR : f.wallL;
      const lat = side * (wall + 1.5);
      const inward = t.dir;                      // toward the inside (+right for right turns)
      const nx = -f.tangent.x * 0.85 + f.right.x * inward * 0.5;
      const nz = -f.tangent.z * 0.85 + f.right.z * inward * 0.5;
      spots.push({ x: f.x + f.right.x * lat, y: f.y - 0.25, z: f.z + f.right.z * lat, yaw: Math.atan2(nx, nz), flip: t.dir < 0 });
      ctx.prop('sign', f.x + f.right.x * lat, f.z + f.right.z * lat, 1.0);   // board half-span across the track
      ctx.exclusions.push([f.x + f.right.x * lat, f.z + f.right.z * lat, 1.6]);
    }
  }
  if (!spots.length) return;
  const boardG = new THREE.BoxGeometry(2.3, 1.15, 0.12);
  const boardMat = new THREE.MeshLambertMaterial({ map: T.sign });
  const boards = new THREE.InstancedMesh(boardG, boardMat, spots.length);
  const postG = mergeGeometries([
    paint(new THREE.BoxGeometry(0.12, 2.0, 0.12).translate(-0.8, 1.0, -0.1), postColor),
    paint(new THREE.BoxGeometry(0.12, 2.0, 0.12).translate(0.8, 1.0, -0.1), postColor),
  ]);
  const posts = new THREE.InstancedMesh(postG, ctx.M.structure, spots.length);
  spots.forEach((sp2, i) => {
    _eul.set(0, sp2.yaw, sp2.flip ? Math.PI : 0, 'YXZ'); _q.setFromEuler(_eul);
    _m4.compose(_p3.set(sp2.x, sp2.y + 2.05, sp2.z), _q, _s3.set(1, 1, 1));
    boards.setMatrixAt(i, _m4);
    place_m4(_m4, sp2.x, sp2.y, sp2.z, sp2.yaw, 1, 1, 1);
    posts.setMatrixAt(i, _m4);
  });
  ctx.add(boards, { cast: true, receive: true, name: 'TurnSigns' });
  ctx.add(posts, { cast: true, name: 'TurnSignPosts' });
  ctx.stats.instances.signs = spots.length;
}

// ------------------------------------------------------------------ start gantry (kit)

// Start gantry over s = 0 with the title banner. The five start-light lenses
// sit at lateral k·1.6 m, 9.7 m up, 0.55 m before the line (main.js's
// StartLights draws the live lights at that spot). `extra(parts, P, span)`
// may add themed decoration (P(lat, y, along) -> [x, y, z]).
export function buildGantry(ctx, T, { pillarA = C.red, pillarB = C.white, base = C.concreteDark, beam = C.concreteDark, frame = 0x1b3f9a, extra = null } = {}) {
  const { track } = ctx;
  const f = track.frameAt(0);
  const parts = [];
  const span = Math.max(f.wallL, f.wallR) + 1.6;
  const P = (lat, y, along = 0) => [f.x + f.right.x * lat + f.tangent.x * along, f.y + y, f.z + f.right.z * lat + f.tangent.z * along];
  for (const side of [-1, 1]) {
    for (let k = 0; k < 7; k++) {
      const [x, y, z] = P(side * span, 0.75 + k * 1.45);
      parts.push(paint(place(new THREE.BoxGeometry(1.1, 1.45, 1.1), x, y - 0.25, z, f.yaw), k % 2 ? pillarB : pillarA));
      if (k === 0) ctx.prop('gantry', x, z, 0.78);
    }
    const [bx, by, bz] = P(side * span, -0.4);
    parts.push(paint(place(new THREE.BoxGeometry(1.8, 0.5, 1.8), bx, by, bz, f.yaw), base));
    const [ex, , ez] = P(side * span, 0);
    ctx.exclusions.push([ex, ez, 4]);
  }
  // truss beams above the banner
  for (const y of [9.05, 5.35]) {
    const [x, yy, z] = P(0, y);
    parts.push(paint(place(new THREE.BoxGeometry(span * 2, 0.35, 0.7), x, yy, z, f.yaw), beam));
  }
  // start light pods
  for (let k = -2; k <= 2; k++) {
    const [x, y, z] = P(k * 1.6, 9.7, -0.2);
    parts.push(paint(place(new THREE.BoxGeometry(1.1, 1.1, 0.6), x, y, z, f.yaw), 0x24242c));
    const [lx, ly, lz] = P(k * 1.6, 9.7, -0.55);
    parts.push(paint(place(new THREE.CylinderGeometry(0.34, 0.34, 0.12, 12), lx, ly, lz, f.yaw, Math.PI / 2), k === 2 ? 0x35e05a : 0xff3b30));
  }
  // banner backing frame
  {
    const [x, y, z] = P(0, 7.2);
    parts.push(paint(place(new THREE.BoxGeometry(span * 2 - 1.2, 3.4, 0.45), x, y, z, f.yaw + Math.PI), frame));
  }
  if (extra) extra(parts, P, span, f);
  addMerged(ctx, parts, ctx.M.structure, { cast: true, receive: true, name: 'Gantry' });
  // banner faces (front toward the approaching karts, back toward the grid's rear view)
  const bh = 3.1, bw = Math.min(span * 2 - 1.6, bh * 8);   // texture is 8:1
  const front = new THREE.PlaneGeometry(bw, bh);
  const back = front.clone();
  // plane faces +Z; front must face -tangent (toward oncoming karts)
  place(front, ...P(0, 7.2, -0.24), f.yaw + Math.PI);
  place(back, ...P(0, 7.2, 0.24), f.yaw);
  const bannerMat = new THREE.MeshBasicMaterial({ map: T.banner, toneMapped: false });
  addMerged(ctx, [front, back], bannerMat, { name: 'Banner' });
  return { span, frame: f };
}

// ------------------------------------------------------------------ flags, clouds, scenery (kit)

// Waving flags (instanced poles + cloths, animated in the vertex shader).
export function buildFlags(ctx, spots = ctx.flagSpots, colors = [0xff3b30, 0xffcc00, 0x2f80ff, 0x34c759, 0xff9500, 0xaf52de, 0xff2d92]) {
  const n = spots.length;
  if (!n) return;
  const poleG = paint(new THREE.CylinderGeometry(0.06, 0.08, 4.2, 6).translate(0, 2.1, 0), 0xeeeeee);
  const poles = new THREE.InstancedMesh(poleG, ctx.M.structure, n);
  const clothG = new THREE.PlaneGeometry(1.7, 1.05, 8, 1).translate(0.85, 3.6, 0);
  const clothMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  clothMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ctx.timeUniform;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      float fph = dot(instanceMatrix[3].xz, vec2(0.37, 0.23));
      float fw = clamp(position.x / 1.7, 0.0, 1.0);
      transformed.z += sin(uTime * 7.0 - position.x * 2.4 + fph) * 0.2 * fw;
      transformed.y += sin(uTime * 5.0 - position.x * 1.7 + fph) * 0.06 * fw;`);
  };
  clothMat.customProgramCacheKey = () => 'tootkart-flag';
  const cloths = new THREE.InstancedMesh(clothG, clothMat, n);
  spots.forEach(([x, y, z, yaw, tall], i) => {
    const sc = tall ? 1.35 : 1;
    place_m4(_m4, x, y, z, yaw + Math.PI * 0.5 + (i % 3) * 0.3, sc, sc, sc);
    poles.setMatrixAt(i, _m4);
    cloths.setMatrixAt(i, _m4);
    cloths.setColorAt(i, _col.set(colors[i % colors.length]));
  });
  ctx.add(poles, { cast: true, name: 'FlagPoles' });
  ctx.add(cloths, { cast: true, name: 'Flags' });
  ctx.stats.instances.flags = n;
  for (const [x, , z] of spots) { ctx.exclusions.push([x, z, 2]); ctx.prop('flag', x, z, 0.1); }
}

// Deterministic per-position lumpiness: shared corners of non-indexed
// polyhedra move together, so the jittered shapes stay crack-free.
export function lumpy(geo, amt, sx = 1, sy = 1, sz = 1, salt = 0) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + (hash2(Math.round(x * 13 + salt), Math.round(z * 11 + y * 7 - salt)) - 0.5) * amt;
    p.setXYZ(i, x * k * sx, y * k * sy, z * k * sz);
  }
  geo.computeVertexNormals();
  return geo;
}

// A jagged low-poly cone for distant mountains / hills; colorAt(t, ny, y)
// returns the face colour (t = 0 base .. 1 apex). Base sits 14 m underground.
export function mountainGeometry(x, z, radius, height, seg, colorAt) {
  const g = new THREE.ConeGeometry(radius, height, seg, 4).toNonIndexed();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const t = (vy + height / 2) / height;               // 0 base .. 1 apex
    const key = Math.round(vx * 3 + 1000) * 7919 + Math.round(vz * 3 + 1000) * 31 + Math.round(vy * 3);
    const j = 1 + (hash2(key, 17) - 0.5) * 0.36 * (1 - t * 0.6);
    p.setXYZ(i, vx * j, vy + (hash2(key, 5) - 0.5) * height * 0.06 * (1 - t), vz * j);
  }
  g.translate(x, height / 2 - 14, z);
  faceColors(g, (y, ny) => colorAt((y + 14) / height, ny, y));
  return paint(g, null);
}

// Drifting low-poly clouds (one instanced draw call).
export function buildClouds(ctx, { center, sunDir, count = ctx.Q.clouds, seed = 808, rMin = 150, rMax = 850, yMin = 95, yMax = 170, span = 900 }) {
  const rng = makeRng(seed);
  const puffs = [];
  const offs = [[0, 0, 0, 1], [1.4, -0.2, 0.3, 0.8], [-1.3, -0.25, -0.2, 0.75], [0.5, 0.45, -0.4, 0.7], [-0.4, 0.3, 0.6, 0.65], [2.4, -0.45, -0.1, 0.55], [-2.3, -0.4, 0.3, 0.5]];
  for (const [x, y, z, r] of offs) puffs.push(new THREE.IcosahedronGeometry(r * 10, 1).scale(1, 0.72, 1).translate(x * 10, y * 10, z * 10));
  const cloudG = mergeGeometries(puffs);
  puffs.forEach((g) => g.dispose());
  faceColors(cloudG, (y, ny) => mixHex(0xc9d8ea, 0xffffff, smoothstep((ny + 0.55) / 1.1)));
  // re-tint by sun direction for a soft lit look
  {
    const pos = cloudG.attributes.position, colA = cloudG.attributes.color;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
      n.subVectors(c, b).cross(e.subVectors(a, b)).normalize();
      const lit = 0.9 + 0.1 * Math.max(0, n.dot(sunDir));
      for (let k = 0; k < 3; k++) colA.setXYZ(i + k, colA.getX(i + k) * lit, colA.getY(i + k) * lit, colA.getZ(i + k) * lit);
    }
  }
  paint(cloudG, null);
  const clouds = new THREE.InstancedMesh(cloudG, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true }), count);
  clouds.frustumCulled = false;
  const cl = [];
  for (let k = 0; k < count; k++) {
    const a = rng() * Math.PI * 2, r = lerp(rMin, rMax, Math.sqrt(rng()));
    cl.push({ x: center.x + Math.cos(a) * r, z: center.z + Math.sin(a) * r, y: lerp(yMin, yMax, rng()), s: lerp(0.8, 1.9, rng()), yaw: rng() * 6.28, sp: lerp(2.5, 5, rng()) });
  }
  const placeClouds = () => {
    for (let k = 0; k < count; k++) {
      const c = cl[k];
      place_m4(_m4, c.x, c.y, c.z, c.yaw, c.s, c.s * 0.9, c.s);
      clouds.setMatrixAt(k, _m4);
    }
    clouds.instanceMatrix.needsUpdate = true;
  };
  placeClouds();
  ctx.add(clouds, { name: 'Clouds' });
  ctx.animators.push((dt) => {
    for (let k = 0; k < count; k++) {
      const c = cl[k];
      c.x += c.sp * dt;
      if (c.x > center.x + span) c.x -= span * 2;
    }
    placeClouds();
  });
}

// Instanced prop set. spots = [x, y, z, yaw, scale, wallClearance, radius].
// Instances closer than `near` m to a wall cast (and receive) shadows; the
// rest skip both, so the shadow pass only draws what can shade the course.
// tints: optional palette multiplied by a random factor in tint[0..1].
export function addInstancedSet(ctx, name, geo, spots, rng, { near = 0, tints = null, tint = [0.85, 1.12], material = ctx.M.veg, stretch = [0.9, 1.12] } = {}) {
  if (!spots.length) { geo.dispose(); return; }
  const groups = near > 0
    ? [[spots.filter((p) => p[5] < near), true, 'Near'], [spots.filter((p) => p[5] >= near), false, 'Far']]
    : [[spots, false, '']];
  for (const [list, cast, suffix] of groups) {
    if (!list.length) continue;
    const inst = new THREE.InstancedMesh(geo, material, list.length);
    for (let i = 0; i < list.length; i++) {
      const [x, y, z, yaw, sc] = list[i];
      place_m4(_m4, x, y, z, yaw, sc, sc * lerp(stretch[0], stretch[1], rng()), sc);
      inst.setMatrixAt(i, _m4);
      const t = lerp(tint[0], tint[1], rng());
      if (tints) _col.set(tints[Math.floor(rng() * tints.length)]).multiplyScalar(t);
      else _col.setRGB(t * lerp(0.95, 1.05, rng()), t, t * lerp(0.9, 1.05, rng()));
      inst.setColorAt(i, _col);
    }
    inst.computeBoundingSphere();
    ctx.add(inst, { cast, receive: cast, name: name + suffix });
  }
  for (const p of spots) ctx.prop(name.toLowerCase(), p[0], p[2], p[6]);
  ctx.stats.instances[name.toLowerCase()] = spots.length;
}

// ------------------------------------------------------------------ update / dispose (kit)

// Wraps up a build: returns the world contract
//   { sun, hemi, root, update(dt, focus, camera), dispose(), getGroundHeight,
//     stats, landmarks, quality, itemBoxAnchor, ...extra }.
export function finishWorld(ctx, { sun, hemi, follow, getGroundHeight, extra = {} }) {
  const { scene, root, animators, timeUniform } = ctx;
  let time = 0;
  function update(dt, focusPosition, camera) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    time += dt;
    timeUniform.value = time;
    if (camera && camera.isPerspectiveCamera && camera.far < MIN_CAMERA_FAR) {
      camera.far = MIN_CAMERA_FAR;
      camera.updateProjectionMatrix();
    }
    follow(focusPosition, camera);
    for (let i = 0; i < animators.length; i++) animators[i](dt, time, camera);
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    scene.remove(root);
    const mats = new Set(), geos = new Set();
    root.traverse((o) => {
      if (o.geometry) geos.add(o.geometry);
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
      if (o.isInstancedMesh) o.dispose();
    });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    Object.values(ctx.M).forEach((m) => m.dispose());
    ctx.textures.forEach((t) => t.dispose());
    sun.dispose();
    if (scene.fog && scene.fog === ctx.fogRef) scene.fog = ctx.prevFog || null;
    if (scene.background === ctx.bgRef) scene.background = ctx.prevBackground || null;
  }

  ctx.stats.buildMs = Math.round(nowMs() - ctx.t0);
  return {
    sun, hemi, root, update, dispose,
    itemBoxAnchor: null,
    quality: ctx.quality,
    /** Terrain height at (x, z) as rendered (off-track ground). */
    getGroundHeight,
    /** Tall landmarks { name, x, z, r, h } that cameras should keep clear of. */
    landmarks: ctx.landmarks,
    stats: ctx.stats,
    ...extra,
  };
}

// ------------------------------------------------------------------ prop kit (v4 worlds)
//
// Small geometry / layout helpers shared by the v4 world kits
// (world-aldrich.js, world-laguna.js, world-palace.js). Every geometry they
// return is painted (merge-compatible, see paint()).

// Triangle soup (counter-clockwise from outside) -> painted geometry.
export function tris(arr, color) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  g.computeVertexNormals();
  return paint(g, color);
}
// Box / quad (+z facing) / cylinder / icosphere centred at (x, y, z), turned
// by ry (then rx, rz), painted.
export const box = (w, h, d, x, y, z, color, ry = 0, rx = 0, rz = 0) => paint(place(new THREE.BoxGeometry(w, h, d), x, y, z, ry, rx, rz), color);
export const quad = (w, h, x, y, z, color, ry = 0, rx = 0) => paint(place(new THREE.PlaneGeometry(w, h), x, y, z, ry, rx), color);
export const cyl = (rt, rb, h, seg, x, y, z, color, ry = 0, rx = 0, rz = 0, open = false) =>
  paint(place(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), x, y, z, ry, rx, rz), color);
export const ball = (r, x, y, z, color, sx = 1, sy = 1, sz = 1, detail = 0) =>
  paint(place(new THREE.IcosahedronGeometry(r, detail), x, y, z, 0, 0, 0, sx, sy, sz), color);
export const cone = (r, h, seg, x, y, z, color, ry = 0, rx = 0, rz = 0) =>
  paint(place(new THREE.ConeGeometry(r, h, seg), x, y, z, ry, rx, rz), color);

// Merge parts into one geometry (disposing them).
export function mergeParts(parts) {
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

// Gable roof, ridge along local x, eaves at y = 0, overhang o. Returns
// [slopes, gable ends] (the gable triangles take gableCol).
export function gableRoof(w, d, h, o, roofCol, gableCol) {
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
export function hipRoof(w, d, h, o, col) {
  const x0 = -w / 2 - o, x1 = w / 2 + o, z0 = -d / 2 - o, z1 = d / 2 + o;
  const r = Math.max(0.01, (w - d) / 2);
  return tris([
    x0, 0, z1, x1, 0, z1, r, h, 0, x0, 0, z1, r, h, 0, -r, h, 0,
    x1, 0, z0, x0, 0, z0, -r, h, 0, x1, 0, z0, -r, h, 0, r, h, 0,
    x1, 0, z1, x1, 0, z0, r, h, 0,
    x0, 0, z0, x0, 0, z1, -r, h, 0,
  ], col);
}
// Colour the faces of a geometry in stripes along local x (a, b alternate).
export function stripeX(geo, a, b, width) {
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
// Planar box-mapped UVs in metres / tile (call on the local geometry before
// placing it): side faces get (horizontal, y), tops (x, z).
export function worldUV(geo, tileU = 1, tileV = tileU, offU = 0, offV = 0) {
  const p = geo.attributes.position, nrm = geo.attributes.normal;
  if (!nrm) geo.computeVertexNormals();
  const n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = x; v = z; } else if (ax >= az) { u = z * Math.sign(n.getX(i) || 1); v = y; } else { u = -x * Math.sign(n.getZ(i) || 1); v = y; }
    uv[i * 2] = u / tileU + offU; uv[i * 2 + 1] = v / tileV + offV;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

// Track layout helpers.
export const segIndex = (track, name) => track.def.segments.findIndex((sg) => sg.name === name);
export const segByName = (track, name) => track.segments[segIndex(track, name)] || null;
// Centre of a turtle arc segment (inside of the turn) + its radius.
export function arcCenter(track, index) {
  const seg = track.def.segments[index], s = track.segments[index];
  if (!seg || seg.type !== 'arc') return null;
  const f = track.frameAt((s.s0 + s.s1) / 2);
  const side = seg.dir === 'left' ? -1 : 1;
  return { x: f.x + f.right.x * side * seg.radius, z: f.z + f.right.z * side * seg.radius, y: f.y, r: seg.radius, dir: side };
}
// Zone type at arc length s (first match), '' outside every zone.
export function zoneTypeAt(track, s) {
  for (const z of track.zones) if (inZone(track, z, s)) return z.type;
  return '';
}
// { type: [zones] }
export function zonesByType(track) {
  const out = {};
  for (const z of track.zones) (out[z.type] = out[z.type] || []).push(z);
  return out;
}
// Is s inside any zone of this type?
export const inType = (track, Z, type, s) => (Z[type] || []).some((z) => inZone(track, z, s));
// Point beside the track: world position at (s, lateral), road height y + frame.
export function besideTrack(track, s, lat) {
  const f = track.frameAt(s);
  return { x: f.x + f.right.x * lat, z: f.z + f.right.z * lat, y: f.y, yaw: f.yaw, f };
}
// Nearest centreline sample (every `step`-th) -> { i, s, d }.
export function makeNearest(track, step = 2) {
  const { px, pz, N, spacing } = track;
  return (x, z) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < N; i += step) {
      const dx = x - px[i], dz = z - pz[i], d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    return { i: bi, s: bi * spacing, d: Math.sqrt(bd) };
  };
}
// Point-in-loop test against the centreline polygon.
export function makeLoopInside(track, step = 6) {
  const M = Math.floor(track.N / step);
  const lx = new Float64Array(M), lz = new Float64Array(M);
  for (let k = 0; k < M; k++) { lx[k] = track.px[k * step]; lz[k] = track.pz[k * step]; }
  return (x, z) => {
    let inn = false;
    for (let i = 0, j = M - 1; i < M; j = i++) {
      if ((lz[i] > z) !== (lz[j] > z) && x < ((lx[j] - lx[i]) * (z - lz[i])) / (lz[j] - lz[i]) + lx[i]) inn = !inn;
    }
    return inn;
  };
}
// Smooth "natural" ground through the road heights (inverse-distance
// weighting of every `step`-th sample): reads as one landscape the road
// sits in. Returns (x, z) -> { h, d } (d = distance to the nearest sample).
export function makeRoadHeightField(track, step = 3, soft = 900) {
  const M = Math.floor(track.N / step);
  const sx = new Float64Array(M), sz = new Float64Array(M), sy = new Float64Array(M);
  for (let k = 0; k < M; k++) { const i = k * step; sx[k] = track.px[i]; sz[k] = track.pz[i]; sy[k] = track.py[i]; }
  const out = { h: 0, d: 0 };
  return (x, z) => {
    let sw = 0, sh = 0, dmin2 = Infinity;
    for (let k = 0; k < M; k++) {
      const dx = x - sx[k], dz = z - sz[k], d2 = dx * dx + dz * dz;
      const w = 1 / (d2 + soft);
      sw += w; sh += w * sy[k];
      if (d2 < dmin2) dmin2 = d2;
    }
    out.h = sh / sw; out.d = Math.sqrt(dmin2);
    return out;
  };
}

// 2-D oriented rectangles (footprints): local x axis (c, -s), local z axis
// (s, c) after a yaw turn (matches place()).
export function rect(x, z, yaw, hw, hd) { return { x, z, c: Math.cos(yaw), s: Math.sin(yaw), hw, hd, r: Math.hypot(hw, hd) }; }
export function rectsOverlap(a, b, m) {
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
// Points around a rect's outline (corners + every ~step m), in world space.
export function rectOutline(rc, step = 1.5) {
  const pts = [];
  const lx = [rc.c, -rc.s], lz = [rc.s, rc.c];
  const P = (u, v) => pts.push([rc.x + lx[0] * u + lz[0] * v, rc.z + lx[1] * u + lz[1] * v]);
  const nu = Math.max(1, Math.ceil((rc.hw * 2) / step)), nv = Math.max(1, Math.ceil((rc.hd * 2) / step));
  for (let i = 0; i <= nu; i++) { const u = -rc.hw + (2 * rc.hw * i) / nu; P(u, rc.hd); P(u, -rc.hd); }
  for (let j = 1; j < nv; j++) { const v = -rc.hd + (2 * rc.hd * j) / nv; P(rc.hw, v); P(-rc.hw, v); }
  return pts;
}
// Distance from a point to a rect (0 inside).
export function rectDistance(rc, x, z) {
  const dx = x - rc.x, dz = z - rc.z;
  const u = dx * rc.c - dz * rc.s, v = dx * rc.s + dz * rc.c;
  return Math.hypot(Math.max(0, Math.abs(u) - rc.hw), Math.max(0, Math.abs(v) - rc.hd));
}
// Footprint bookkeeping for buildings: fits() checks wall clearance (via the
// terrain field), other footprints and ctx.exclusions and returns the ground
// range { gMin, gMax } under the outline (or false); add() registers the
// footprint (prop circles along its outline for verifyProps).
export function createPlacer(ctx, field, { clear = 1.2, gap = 1.2 } = {}) {
  const rects = [];
  const why = { overlap: 0, exclusion: 0, road: 0, slope: 0 };   // rejection reasons (debug stats)
  const fits = (rc, { slopeMax = 3, clearance = clear } = {}) => {
    for (const o of rects) if (rectsOverlap(rc, o, gap)) { why.overlap++; return false; }
    for (const [ex, ez, er] of ctx.exclusions) if (rectDistance(rc, ex, ez) < er) { why.exclusion++; return false; }
    const cc = field.wallClearance(rc.x, rc.z);
    if (cc < clearance) { why.road++; return false; }
    const exact = cc < rc.r + clearance;
    let gMin = Infinity, gMax = -Infinity;
    for (const [px, pz] of rectOutline(rc)) {
      if (exact && field.wallClearance(px, pz) < clearance) { why.road++; return false; }
      const g = field.surfaceHeight(px, pz);
      gMin = Math.min(gMin, g); gMax = Math.max(gMax, g);
    }
    if (gMax - gMin > slopeMax) { why.slope++; return false; }
    return { gMin, gMax };
  };
  const add = (rc, kind = 'building', eave = 0.4) => {
    rects.push(rc);
    for (const [px, pz] of rectOutline(rc, 1.0)) ctx.prop(kind, px, pz, eave);
    return rc;
  };
  const near = (x, z, r) => rects.some((o) => rectDistance(o, x, z) < r);
  return { rects, fits, add, near, why };
}

// Street lamps (instanced): spots = [x, y, z, yaw, scale].
export function buildLamps(ctx, spots, { pole = 0x2f4a3a, light = 0xfff1b8, name = 'Lamps' } = {}) {
  if (!spots.length) return null;
  const g = mergeParts([
    cyl(0.07, 0.1, 3.4, 6, 0, 1.7, 0, pole),
    cyl(0.16, 0.2, 0.3, 6, 0, 0.15, 0, pole),
    box(0.42, 0.55, 0.42, 0, 3.65, 0, light),
    cyl(0.05, 0.34, 0.25, 4, 0, 4.05, 0, pole, Math.PI / 4),
  ]);
  const inst = new THREE.InstancedMesh(g, ctx.M.structure, spots.length);
  spots.forEach(([x, y, z, yaw, sc], i) => {
    inst.setMatrixAt(i, place_m4(_m4, x, y, z, yaw, sc, sc, sc));
    ctx.prop('lamp', x, z, 0.25 * sc);
  });
  inst.computeBoundingSphere();
  ctx.add(inst, { cast: true, name });
  ctx.stats.instances.lamps = (ctx.stats.instances.lamps || 0) + spots.length;
  return inst;
}

// Rising puffs (steam / smoke / dust; one instanced draw call): each source =
// [x, y, z, size, greyness]; puffs rise, drift and swell, then shrink away.
export function buildPuffs(ctx, sources, { light = 0xffffff, dark = 0xd9dee6, rise = 7.5, rate = 0.32, name = 'Steam', per = null } = {}) {
  const k0 = per || (ctx.Q.veg >= 1 ? 5 : 3);
  const n = sources.length * k0;
  if (!n) return null;
  const geo = new THREE.IcosahedronGeometry(1, 1);
  faceColors(geo, (y, ny) => mixHex(dark, light, smoothstep((ny + 0.4) / 1.1)));
  paint(geo, null);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true });
  const inst = new THREE.InstancedMesh(geo, mat, n);
  inst.frustumCulled = false;
  const tint = new THREE.Color();
  sources.forEach((src, k) => { for (let j = 0; j < k0; j++) inst.setColorAt(k * k0 + j, tint.setScalar(lerp(0.78, 1.0, src[4]))); });
  const m4 = new THREE.Matrix4();
  const place1 = (time) => {
    for (let k = 0; k < sources.length; k++) {
      const src = sources[k], x = src[0], y = src[1], z = src[2], size = src[3];
      for (let j = 0; j < k0; j++) {
        const t = (time * rate + j / k0 + k * 0.137) % 1;
        const sc = size * (0.35 + t * 1.4) * Math.sin(Math.PI * Math.min(1, t * 1.15));
        place_m4(m4, x + t * size * 2.2, y + t * size * rise, z + Math.sin(t * 6 + k) * size * 0.4, t * 3 + k, Math.max(0.001, sc), Math.max(0.001, sc * 0.85), Math.max(0.001, sc));
        inst.setMatrixAt(k * k0 + j, m4);
      }
    }
    inst.instanceMatrix.needsUpdate = true;
  };
  place1(0);
  ctx.add(inst, { name });
  ctx.animators.push((dt, time) => place1(time));
  ctx.stats.instances[name.toLowerCase()] = n;
  return inst;
}

// A decal strip lying on the road between s0 and s1 (s1 may exceed L), from
// lateral latA(f, s) to latB(f, s), 1 cm up (polygon offset keeps it above
// the road ribbon). u = across (0..1), v = along / tile.
export function roadDecal(ctx, s0, s1, { latA = (f) => -f.halfWidth, latB = (f) => f.halfWidth, tile = 4, step = 1, dy = 0.012, uSpan = null } = {}) {
  const { track } = ctx;
  return trackStrip(track, sRange(s0, s1, step), 2, (f, s, c, o) => {
    const a = latA(f, s), b = latB(f, s);
    o.lat = c ? b : a; o.dy = dy;
    o.u = uSpan ? (o.lat - a) / uSpan : c; o.v = (s - s0) / tile;
  });
}
export const decalMaterial = (opts) => new THREE.MeshStandardMaterial({ roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...opts });

// Faces down from the wall line (inner face at wallL / wallR) to `depth` m
// below the road: the outer skin of elevated decks / ramparts / bridges.
// side -1 / +1; returns a painted geometry (u along / tile, v down).
export function wallSkin(ctx, s0, s1, side, { inset = 0.5, top = 0, bottom = -6, color = 0x888888, step = 2, tile = 6, absBottom = null } = {}) {
  const { track } = ctx;
  return paint(trackStrip(track, sRange(s0, s1, step), 2, (f, s, c, o) => {
    const wall = side > 0 ? f.wallR : f.wallL;
    const upper = side > 0 ? c === 0 : c === 1;
    o.lat = side * (wall + inset);
    if (upper) o.dy = top;
    else if (absBottom !== null) { o.y = absBottom; o.dy = 0; } else o.dy = bottom;
    o.u = s / tile; o.v = upper ? 1 : 0;
  }), color);
}

// Timber deck over a dip (footbridges, boardwalk bridges, drawbridges):
// plank decal across the whole corridor (wall to wall), a deck slab +
// fascias under the road edge, posts down to the ground every `postStep` m
// and (rails) post-and-rail railings whose inner face is exactly at the wall
// lines (use wall style 'none' there). Geometries go into `bucket`, the
// decal into `decals` (draw it with a decalMaterial plank map).
export function buildTimberDeck(ctx, field, s0, s1, {
  bucket, decals = null, rails = true, deck = 0xa8794a, dark = 0x7a5432, postStep = 5, beam = 0.75, plankTile = 3, plankSpan = 6,
  railHeights = [[1.05, 0.2], [0.55, 0.14]], postW = 0.24, postH = 1.15,
} = {}) {
  const { track } = ctx;
  if (decals) decals.push(roadDecal(ctx, s0, s1, { latA: (f) => -(f.wallL + 0.5), latB: (f) => f.wallR + 0.5, tile: plankTile, uSpan: plankSpan }));
  const sl = sRange(s0, s1, 1);
  bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => { o.lat = c ? -(f.wallL + 0.55) : f.wallR + 0.55; o.dy = -beam; }), dark));
  for (const side of [-1, 1]) {
    bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
      const wall = side > 0 ? f.wallR : f.wallL;
      const upper = side > 0 ? c === 0 : c === 1;
      o.lat = side * (wall + 0.55); o.dy = upper ? 0.02 : -beam;
    }), deck));
    for (let s = s0 + 2; s < s1 - 1; s += postStep) {
      const f = track.frameAt(s), wall = side > 0 ? f.wallR : f.wallL;
      const lat = side * (wall + 0.3), x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
      const g = field.surfaceHeight(x, z);
      if (f.y - beam - g > 0.3) bucket.push(box(0.4, f.y - beam - g + 0.4, 0.4, x, (f.y - beam + g - 0.4) / 2, z, dark, f.yaw));
      ctx.prop('deckPost', x, z, 0.0);
    }
    if (!rails) continue;
    for (let s = s0; s <= s1 + 0.01; s += 2.5) {
      const f = track.frameAt(s), wall = side > 0 ? f.wallR : f.wallL;
      const lat = side * (wall + postW / 2);
      bucket.push(box(postW, postH, postW, f.x + f.right.x * lat, f.y + postH / 2, f.z + f.right.z * lat, dark, f.yaw));
    }
    for (const [y, h] of railHeights) {
      bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
        const wall = side > 0 ? f.wallR : f.wallL;
        o.lat = side * (wall + (side > 0 ? (c ? postW : 0) : (c ? 0 : postW))); o.dy = y + h;
      }), deck));
      for (const face of [0, 1]) {
        bucket.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
          const wall = side > 0 ? f.wallR : f.wallL;
          const inner = face === 0;
          const upper = (side > 0) === inner ? c === 1 : c === 0;
          o.lat = side * (wall + (inner ? 0 : postW)); o.dy = upper ? y + h : y;
        }), deck));
      }
    }
  }
}

// =================================================================== Breezy Bay

// Terrain colours: grass with soft variation and meadow patches, beaches
// (wide sand on the beach loop, the spit and the promenade beach), salt-marsh
// greens round the lagoon, seabed, warm sandstone / rock on steep faces,
// hazier far land.
const BEACH_WIDTH = { beach: 16, spit: 30, causeway: 12, promenade: 40, grandstand: 40, cliff: 0, harbor: 2, gap: 0 };
// (x, z, sd) -> { W: m of sand inland from the coast, cliffy: 0..1 under the cliff road } by the nearest road zone.
function makeBeachWidth(track) {
  const nearest = makeNearest(track, 3);
  const zoneAt = (s) => { let t = ''; for (const zn of track.zones) if (BEACH_WIDTH[zn.type] !== undefined && inZone(track, zn, s)) t = zn.type; return t; };
  const zoneOfI = Array.from({ length: track.N }, (_, i) => zoneAt(i * track.spacing));
  const out = { W: 7, cliffy: 0 };
  return (x, z, sd) => {
    out.W = 7; out.cliffy = 0;
    if (sd < 60) {
      const nn = nearest(x, z), t = zoneOfI[nn.i];
      if (t) { out.W = BEACH_WIDTH[t]; out.cliffy = t === 'cliff' || t === 'gap' ? smoothstep((70 - nn.d) / 30) : 0; }
      if (t === 'spit' && nn.d < 30) out.W = 99;                 // the sand tip / beacon island
    }
    return out;
  };
}
function breezyTerrainColor(track) {
  const cGrass = new THREE.Color(C.grass), cAlt = new THREE.Color(C.grassAlt), cDeep = new THREE.Color(C.grassDeep);
  const cMeadow = new THREE.Color(C.meadow), cSand = new THREE.Color(C.sand), cWet = new THREE.Color(C.sandWet);
  const cRock = new THREE.Color(C.rock), cRockD = new THREE.Color(C.rockDark), cSea = new THREE.Color(C.seabed);
  const cFar = new THREE.Color(C.farLand), cMarsh = new THREE.Color(0x8fae5a), cStone = new THREE.Color(0xc9a476);
  const tmp = new THREE.Color();
  const beachW = track ? makeBeachWidth(track) : () => ({ W: 7, cliffy: 0 });
  return (c, x, z, h, slope, sd) => {
    const n1 = fbm(x * 0.022, z * 0.022, 3), n2 = fbm(x * 0.006 + 7, z * 0.006 - 3, 3);
    c.copy(cGrass).lerp(cAlt, smoothstep((n1 - 0.35) / 0.35));
    c.lerp(cDeep, smoothstep((0.42 - n1) / 0.2) * 0.6);
    c.lerp(cMeadow, smoothstep((n2 - 0.6) / 0.15) * 0.55);
    const rc = Math.hypot(x - WORLD_CENTER.x, z - WORLD_CENTER.z);
    c.lerp(cFar, smoothstep((rc - 450) / 600) * 0.7);
    // beaches: the sand reaches inland by the stretch's width (nearest road zone)
    const { W, cliffy } = beachW(x, z, sd);
    // salt marsh round the lagoon
    const lag = polyDistance(WATER[1] || WATER[0], x, z);
    if (lag > 0 && lag < 26) c.lerp(cMarsh, (1 - smoothstep((lag - 6) / 20)) * 0.6);
    const beach = Math.max(smoothstep((WATER_LEVEL + 1.35 - h) / 0.6) * smoothstep((28 - sd) / 10),
      smoothstep((W - sd) / 6) * smoothstep((2.4 - h) / 1.2));
    c.lerp(tmp.copy(cSand).lerp(cWet, smoothstep((WATER_LEVEL + 0.45 - h) / 0.6)), beach);
    // seabed
    if (h < WATER_LEVEL - 0.25) c.copy(cSea).lerp(cWet, smoothstep((WATER_LEVEL - 1 - h) / 4) * 0.5);
    // steep faces → rock (warm sandstone under the cliff road)
    const rock = smoothstep((slope - 0.5) / 0.5);
    c.lerp(tmp.copy(cRock).lerp(cRockD, n1).lerp(cStone, cliffy * 0.75), rock);
  };
}

// Animated water (kit; Breezy's bay, Laguna's Pacific): depth-tinted
// shallows, fresnel sky, glints, shore foam. The depth map comes from the
// terrain field (depth = level - ground); colours default to Breezy's.
export function buildWaterSurface(ctx, field, sunDir, {
  level = WATER_LEVEL, shallow = C.waterShallow, deep = C.waterDeep, sky = C.waterSky, skyTop = C.skyTop,
  foam = C.foam, sunColor = 0xfff4dc, size = 5600, pad = 420, deepAt = 5.5, foamWidth = 0.45,
} = {}) {
  // Water depth map (R8): covers the course plus a wide margin; the shader
  // fades to "deep" toward its border so the turquoise shallows never stop
  // along a straight line. depth = WATER_LEVEL - ground, encoded over [-1, 8] m.
  const { core } = field;
  const res = ctx.Q.depthTex;
  const rx0 = core.x0 - pad, rz0 = core.z0 - pad;
  const w = core.x1 - core.x0 + pad * 2, hgt = core.z1 - core.z0 + pad * 2;
  const data = new Uint8Array(res * res);
  for (let j = 0; j < res; j++) {
    const z = rz0 + ((j + 0.5) / res) * hgt;
    for (let i = 0; i < res; i++) {
      const x = rx0 + ((i + 0.5) / res) * w;
      const depth = level - field.surfaceHeight(x, z);
      data[j * res + i] = Math.round(clamp((depth + 1) / 9, 0, 1) * 255);
    }
  }
  const depthTex = ctx.tex(new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.UnsignedByteType));
  depthTex.magFilter = THREE.LinearFilter; depthTex.minFilter = THREE.LinearFilter;
  depthTex.needsUpdate = true;
  const waterN = ctx.tex(TX.createWaterNormalTexture());

  const waterMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uDepth: { value: null },
      uNormal: { value: null },
      uRect: { value: new THREE.Vector4(rx0, rz0, 1 / w, 1 / hgt) },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(sunColor) },
      uShallow: { value: new THREE.Color(shallow) },
      uDeep: { value: new THREE.Color(deep) },
      uSkyHorizon: { value: new THREE.Color(sky) },
      uSkyTop: { value: new THREE.Color(skyTop) },
      uFoam: { value: new THREE.Color(foam) },
      uDeepAt: { value: deepAt },
      uFoamW: { value: foamWidth },
    }]),
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform sampler2D uDepth, uNormal;
      uniform vec4 uRect;
      uniform vec3 uSunDir, uSunColor, uShallow, uDeep, uSkyHorizon, uSkyTop, uFoam;
      uniform float uDeepAt, uFoamW;
      varying vec3 vWorld;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        // depth below the surface (fades to deep toward the map border)
        vec2 duv = (vWorld.xz - uRect.xy) * uRect.zw;
        vec2 ed = min(duv, 1.0 - duv);
        float inMap = smoothstep(0.0, 0.1, min(ed.x, ed.y));
        float depth = mix(8.0, texture2D(uDepth, clamp(duv, 0.0, 1.0)).r * 9.0 - 1.0, inMap);

        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        vec2 p = vWorld.xz;
        vec4 s1 = texture2D(uNormal, p * 0.031 + vec2(uTime * 0.011, uTime * 0.007));
        vec4 s2 = texture2D(uNormal, p * 0.077 + vec2(-uTime * 0.016, uTime * 0.012));
        vec2 nxy = (s1.xy * 2.0 - 1.0) + (s2.xy * 2.0 - 1.0) * 0.7;
        // ripples calm down with distance (no aliasing / milky streaks far away)
        float rip = mix(0.36, 0.07, smoothstep(25.0, 420.0, dist));
        vec3 n = normalize(vec3(nxy.x * rip, 1.0, nxy.y * rip));

        // Sky reflection uses a heavily damped normal: a smooth fresnel
        // gradient instead of white blotches. Glints use the detailed one.
        vec3 nF = normalize(vec3(nxy.x * rip * 0.3, 1.0, nxy.y * rip * 0.3));
        float ndv = max(dot(nF, V), 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        vec3 R = reflect(-V, n);
        vec3 sky = mix(uSkyHorizon, uSkyTop, smoothstep(0.02, 0.45, reflect(-V, nF).y));
        vec3 col = mix(uShallow, uDeep, smoothstep(0.15, uDeepAt, depth));
        col *= 0.94 + 0.12 * s2.b;                       // soft swell patches
        col = mix(col, sky, clamp(fres, 0.0, 0.55));

        // sun glint + twinkling sparkles
        float rs = max(dot(R, uSunDir), 0.0);
        col += uSunColor * (pow(rs, 700.0) * 4.0 + pow(rs, 60.0) * 0.18);
        float tw = texture2D(uNormal, p * 0.23 + vec2(uTime * 0.05, -uTime * 0.04)).b;
        float twk = smoothstep(0.8, 0.88, tw * s1.b * 1.45);
        col += uSunColor * twk * (smoothstep(0.9, 0.99, rs) * 1.6 + 0.12 * (1.0 - smoothstep(60.0, 220.0, dist)));

        // shoreline foam: an animated band hugging the beaches
        float wave = sin(uTime * 1.4 - depth * 4.0 + s1.b * 5.0);
        float edge = 1.0 - smoothstep(0.0, uFoamW + 0.22 * wave, depth);
        float foam = edge * smoothstep(0.32, 0.6, s2.b + edge * 0.45);
        col = mix(col, uFoam, clamp(foam, 0.0, 1.0) * 0.92);

        float alpha = mix(0.55, 0.96, smoothstep(0.0, 3.0, depth));
        alpha = max(alpha, foam);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  waterMat.uniforms.uDepth.value = depthTex;
  waterMat.uniforms.uNormal.value = waterN;
  const cx = (core.x0 + core.x1) / 2, cz = (core.z0 + core.z1) / 2;
  const wg = new THREE.PlaneGeometry(size, size, 8, 8).rotateX(-Math.PI / 2).translate(cx, level, cz);
  const water = ctx.add(new THREE.Mesh(wg, waterMat), { name: 'Water' });
  water.renderOrder = -10;
  ctx.animators.push((dt, time) => { waterMat.uniforms.uTime.value = time; });
  return water;
}

// The Bay Bridge: deck slab, white parapets with steel rails (inner face at
// exactly wallL / wallR, so the 8.5 m + 2 m v3 deck is what physics sees),
// piers down to the seabed and two steel arches with hangers.
function buildBayBridge(ctx, bridgeZone) {
  const { track } = ctx;
  const parts = [];
  const z0 = bridgeZone.s0, z1 = bridgeZone.s1;
  const sList = sRange(z0, z1, 2.5);                 // a straight: coarse rows look the same
  const wallAt = (f, side) => (side > 0 ? f.wallR : f.wallL);
  // Deck slab (profile traversed so every face points outward).
  const deckProfile = (f) => {
    const L0 = -(f.wallL + 0.75), R0 = f.wallR + 0.75;
    return [[f.wallR + 0.45, -0.02], [R0, -0.02], [R0, -1.15], [L0, -1.15], [L0, -0.02], [-(f.wallL + 0.45), -0.02]];
  };
  const deckCols = [C.concrete, C.white, C.concreteDark, C.white, C.concrete];
  for (let seg = 0; seg < 5; seg++) {
    const g = trackStrip(track, sList, 2, (f, s, c, o) => {
      const pts = deckProfile(f), pt = pts[seg + c];
      o.lat = pt[0]; o.dy = pt[1];
    });
    parts.push(paint(g, deckCols[seg]));
  }
  // Parapets (inner face exactly at the wall), posts and two rails per side.
  const parH = 0.42, parT = 0.36;
  for (const side of [-1, 1]) {
    const faces = [[[0, -0.1], [0, parH]], [[0, parH], [parT, parH]], [[parT, parH], [parT, -0.1]]];
    for (const face of faces) {
      parts.push(paint(trackStrip(track, sList, 2, (f, s, c, o) => {
        const pt = side > 0 ? face[c] : face[1 - c];
        o.lat = side * (wallAt(f, side) + pt[0]); o.dy = pt[1];
      }), C.white));
    }
    for (const rail of [[0.78, 0.09], [1.12, 0.11]]) {
      const [ry, rt] = rail;
      const rfaces = [[[0.08, ry - rt], [0.08, ry + rt]], [[0.08, ry + rt], [0.24, ry + rt]], [[0.24, ry + rt], [0.24, ry - rt]], [[0.24, ry - rt], [0.08, ry - rt]]];
      for (const face of rfaces) {
        parts.push(paint(trackStrip(track, sList, 2, (f, s, c, o) => {
          const pt = side > 0 ? face[c] : face[1 - c];
          o.lat = side * (wallAt(f, side) + pt[0]); o.dy = pt[1];
        }), C.steel));
      }
    }
    for (let s = z0 + 1; s < z1; s += 2.5) {
      const f = track.frameAt(s), lat = side * (wallAt(f, side) + 0.16);
      parts.push(paint(place(new THREE.BoxGeometry(0.14, 0.8, 0.14), f.x + f.right.x * lat, f.y + parH + 0.4, f.z + f.right.z * lat, f.yaw), C.steel));
    }
  }
  // Piers down to the seabed + cap beams (pier pairs follow the deck width).
  const len = z1 - z0, nP = Math.max(2, Math.round(len / 19));
  for (let k = 1; k < nP; k++) {
    const s = z0 + (len * k) / nP, f = track.frameAt(s);
    const bot = SEABED - 1, top = f.y - 1.15, h = top - bot;
    const latC = (f.wallR - f.wallL) / 2, half = (f.wallL + f.wallR) / 2;
    for (const lat of [latC - half * 0.55, latC + half * 0.55]) {
      parts.push(paint(place(new THREE.CylinderGeometry(0.75, 0.9, h, 10), f.x + f.right.x * lat, bot + h / 2, f.z + f.right.z * lat), C.concrete));
    }
    const capW = f.wallL + f.wallR + 1.2;
    parts.push(paint(place(new THREE.BoxGeometry(capW, 0.9, 1.6), f.x + f.right.x * latC, top - 0.45, f.z + f.right.z * latC, f.yaw), C.concreteDark));
  }
  // Abutments at both ends.
  for (const [s, dir] of [[z0, 1], [z1, -1]]) {
    const f = track.frameAt(s + dir * 3.5);
    const w = Math.max(f.wallL, f.wallR) * 2 + 1.8, top = f.y - 1.15, bot = SEABED, h = top - bot;
    parts.push(paint(place(new THREE.BoxGeometry(w, h, 7), f.x, bot + h / 2, f.z, f.yaw), C.concreteDark));
  }
  // Two steel arches with hangers and top bracing.
  const sa = z0 + 7, sb = z1 - 7, ARCH_H = 14.5, aLatPad = 0.95;
  const archPoint = (side, t, out) => {
    const s = lerp(sa, sb, t), f = track.frameAt(s);
    const lat = side * (wallAt(f, side) + aLatPad);
    const h = ARCH_H * (1 - (2 * t - 1) * (2 * t - 1));
    return out.set(f.x + f.right.x * lat, f.y + 0.4 + h, f.z + f.right.z * lat);
  };
  const K = 44, P0 = new THREE.Vector3(), P1 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const mid = new THREE.Vector3(), look = new THREE.Matrix4();
  for (const side of [-1, 1]) {
    for (let k = 0; k < K; k++) {
      archPoint(side, k / K, P0); archPoint(side, (k + 1) / K, P1);
      const d = P1.distanceTo(P0);
      mid.addVectors(P0, P1).multiplyScalar(0.5);
      const box = new THREE.BoxGeometry(0.9, 0.9, d + 0.12);
      box.applyMatrix4(look.lookAt(P0, P1, up)).translate(mid.x, mid.y, mid.z);
      parts.push(paint(box, C.steel));
    }
    // hangers
    for (let t = 0.1; t < 0.95; t += 0.8 / 13) {
      archPoint(side, t, P0);
      const s = lerp(sa, sb, t), f = track.frameAt(s);
      const yb = f.y + parH + 0.75, h = P0.y - yb;
      if (h > 0.6) parts.push(paint(place(new THREE.CylinderGeometry(0.07, 0.07, h, 5), P0.x, yb + h / 2, P0.z), C.white));
    }
    // arch feet
    for (const t of [0, 1]) {
      archPoint(side, t, P0);
      const f = track.frameAt(lerp(sa, sb, t));
      parts.push(paint(place(new THREE.BoxGeometry(1.7, 1.6, 2.4), P0.x, f.y - 0.1, P0.z, f.yaw), C.concrete));
    }
  }
  for (const t of [0.32, 0.5, 0.68]) {
    archPoint(-1, t, P0); archPoint(1, t, P1);
    const d = P0.distanceTo(P1);
    mid.addVectors(P0, P1).multiplyScalar(0.5);
    const box = new THREE.BoxGeometry(0.5, 0.5, d);
    box.applyMatrix4(look.lookAt(P0, P1, up)).translate(mid.x, mid.y, mid.z);
    parts.push(paint(box, C.steel));
  }
  addMerged(ctx, parts, ctx.M.structure, { cast: true, receive: true, name: 'Bridge' });
}

// Grandstands with a hopping crowd beside the start / home straights.
function buildGrandstands(ctx, field) {
  const { track, Q, flagSpots, exclusions } = ctx, L = track.length;
  const parts = [];
  const crowd = [];      // [x, y, z, yaw]
  const rng = makeRng(77);
  const seatCols = [0x2f7de1, 0xffc93a, 0xff5a4e, 0x35c46a];
  const buildStand = (sA, sB, side, rows) => {
    const fa = track.frameAt(sA), fb = track.frameAt(sB);
    const sMid = (sA + sB) / 2, f = track.frameAt(sMid);
    const wall = side > 0 ? f.wallR : f.wallL;
    const latFront = side * (wall + 4.5);
    const len = Math.hypot(fb.x - fa.x, fb.z - fa.z);
    const ox = f.x + f.right.x * latFront, oz = f.z + f.right.z * latFront;
    const wx = f.right.x * side, wz = f.right.z * side;      // outward (away from the track)
    const ax2 = f.tangent.x, az2 = f.tangent.z;
    const g0 = Math.min(field.surfaceHeight(ox, oz), field.surfaceHeight(ox + wx * rows, oz + wz * rows)) - 0.6;
    const faceYaw = Math.atan2(-wx, -wz);
    const yaw = f.yaw;
    for (let k = 0; k < rows; k++) {
      const top = f.y + 0.35 + 0.55 * (k + 1);
      const h = top - g0;
      const cx = ox + wx * (k * 1.05 + 0.525), cz = oz + wz * (k * 1.05 + 0.525);
      parts.push(paint(place(new THREE.BoxGeometry(1.05, h, len), cx, g0 + h / 2, cz, yaw), seatCols[k % seatCols.length]));
      // spectators on the step
      for (let a = -len / 2 + 0.5; a < len / 2 - 0.4; a += 0.82) {
        if (rng() < 0.2) continue;
        if (Q.crowd < 1 && rng() > Q.crowd) continue;
        const j = (rng() - 0.5) * 0.25;
        crowd.push([cx + ax2 * (a + j) - wx * 0.12, top, cz + az2 * (a + j) - wz * 0.12, faceYaw + (rng() - 0.5) * 0.5]);
      }
    }
    const backD = rows * 1.05 + 0.2, roofY = f.y + 0.35 + 0.55 * rows + 3.4;
    // back wall
    {
      const cx = ox + wx * backD, cz = oz + wz * backD, h = roofY - g0;
      parts.push(paint(place(new THREE.BoxGeometry(0.4, h, len + 0.4), cx, g0 + h / 2, cz, yaw), 0xe9e4da));
    }
    // front parapet
    {
      const cx = ox - wx * 0.15, cz = oz - wz * 0.15, h = f.y + 1.2 - g0;
      parts.push(paint(place(new THREE.BoxGeometry(0.3, h, len), cx, g0 + h / 2, cz, yaw), C.blue));
    }
    // columns + striped roof
    for (let a = -len / 2; a <= len / 2 + 0.01; a += len / Math.max(1, Math.round(len / 9))) {
      const cx = ox + ax2 * a - wx * 0.1, cz = oz + az2 * a - wz * 0.1, h = roofY - g0;
      parts.push(paint(place(new THREE.BoxGeometry(0.3, h, 0.3), cx, g0 + h / 2, cz, yaw), 0xe9e4da));
      flagSpots.push([cx, roofY + 0.2, cz, f.yaw]);
    }
    const nSeg = Math.max(2, Math.round(len / 3));
    for (let k = 0; k < nSeg; k++) {
      const a = -len / 2 + (k + 0.5) * (len / nSeg);
      const cx = ox + ax2 * a + wx * (backD / 2 - 0.2), cz = oz + az2 * a + wz * (backD / 2 - 0.2);
      parts.push(paint(place(new THREE.BoxGeometry(backD + 1.2, 0.22, len / nSeg), cx, roofY, cz, yaw, 0, side * -0.06), k % 2 ? C.white : C.red));
    }
    // keep vegetation away; record the stand's footprint (front parapet is nearest the track)
    for (let a = -len / 2; a <= len / 2; a += 6) exclusions.push([ox + ax2 * a + wx * backD / 2, oz + az2 * a + wz * backD / 2, backD + 4]);
    for (let a = -len / 2; a <= len / 2 + 0.01; a += 1) ctx.prop('grandstand', ox + ax2 * a - wx * 0.15, oz + az2 * a - wz * 0.15, 0.25);
  };
  buildStand(L - 48, L - 6, -1, 7);
  buildStand(6, 48, -1, 7);
  buildStand(10, 42, 1, 5);
  addMerged(ctx, parts, ctx.M.structure, { cast: true, receive: true, name: 'Grandstands' });

  // Crowd: shirt (white vertices) takes the instance colour; heads get a
  // hashed skin tone; everyone hops in the vertex shader (no CPU cost).
  if (!crowd.length) return;
  const body = paint(new THREE.BoxGeometry(0.46, 0.62, 0.3).translate(0, 0.31, 0), 0xffffff);
  const head = paint(new THREE.OctahedronGeometry(0.2, 0).translate(0, 0.84, 0), 0xf0c8a0);
  const arms = paint(new THREE.BoxGeometry(0.66, 0.12, 0.12).translate(0, 0.58, 0.02), 0xffffff);
  const g = mergeGeometries([body, head, arms]);
  [body, head, arms].forEach((x) => x.dispose());
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ctx.timeUniform;
    // (r186: vColor is a vec4 varying; the stock chunk runs first.)
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader
      .replace('#include <color_vertex>', /* glsl */`
        #include <color_vertex>
        float hsh = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
        #if defined( USE_INSTANCING_COLOR ) && defined( USE_COLOR )
          float shirt = step(0.99, min(color.r, min(color.g, color.b)));
          vec3 skin = mix(vec3(1.0, 0.8, 0.62), vec3(0.42, 0.27, 0.16), fract(hsh * 7.31));
          vColor.rgb = mix(skin, instanceColor.rgb, shirt);
        #endif`)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        float hop = max(0.0, sin(uTime * (5.0 + hsh * 4.0) + hsh * 40.0));
        transformed.y += hop * hop * 0.24 * step(0.3, hsh);`);
  };
  mat.customProgramCacheKey = () => 'tootkart-crowd';
  const inst = new THREE.InstancedMesh(g, mat, crowd.length);
  const shirtCols = [0xff4d4d, 0xffd23f, 0x3fa7ff, 0x5ad35a, 0xff8c2e, 0xb06bff, 0xffffff, 0xff6fb5, 0x2ec4b6];
  crowd.forEach(([x, y, z, yaw], i) => {
    place_m4(_m4, x, y, z, yaw, 1, 1, 1);
    inst.setMatrixAt(i, _m4);
    inst.setColorAt(i, _col.set(shirtCols[Math.floor(rng() * shirtCols.length)]).multiplyScalar(0.985));
  });
  ctx.add(inst, { receive: false, name: 'Crowd' });
  ctx.stats.instances.crowd = crowd.length;
}

// Striped lighthouse with a keeper's cottage and two rotating light shafts.
function buildLighthouse(ctx, field) {
  const parts = [];
  const lx = LIGHTHOUSE.x, lz = LIGHTHOUSE.z;
  const g0 = field.surfaceHeight(lx, lz) - 0.4;
  parts.push(paint(place(new THREE.CylinderGeometry(4.2, 4.8, 1.6, 12), lx, g0 + 0.8, lz), 0xb7afa2));
  const bands = 6, towerH = 15, r0 = 2.7, r1 = 1.9;
  for (let k = 0; k < bands; k++) {
    const ya = (k / bands) * towerH, yb = ((k + 1) / bands) * towerH;
    const ra = lerp(r0, r1, k / bands), rb = lerp(r0, r1, (k + 1) / bands);
    parts.push(paint(place(new THREE.CylinderGeometry(rb, ra, yb - ya, 16), lx, g0 + 1.6 + (ya + yb) / 2, lz), k % 2 ? C.white : 0xe0342c));
  }
  const top = g0 + 1.6 + towerH;
  parts.push(paint(place(new THREE.CylinderGeometry(2.75, 2.75, 0.35, 16), lx, top + 0.17, lz), 0x30343c));
  parts.push(paint(place(new THREE.CylinderGeometry(2.7, 2.7, 0.75, 16, 1, true), lx, top + 0.72, lz), 0x30343c));
  parts.push(paint(place(new THREE.CylinderGeometry(1.55, 1.55, 0.3, 12), lx, top + 0.5, lz), 0x30343c));
  parts.push(paint(place(new THREE.ConeGeometry(2.0, 1.8, 12), lx, top + 3.55, lz), 0xe0342c));
  parts.push(paint(place(new THREE.SphereGeometry(0.35, 8, 6), lx, top + 4.6, lz), 0x30343c));
  // keeper's cottage
  const hx = lx + 7.5, hz = lz - 5.5, hg = field.surfaceHeight(hx, hz) - 0.3;
  parts.push(paint(place(new THREE.BoxGeometry(5.5, 3.2, 4.2), hx, hg + 1.6, hz, 0.4), C.white));
  // triangular prism roof: apex up, ridge along the cottage's local x
  const roof = new THREE.CylinderGeometry(3.3, 3.3, 6.1, 3, 1).rotateX(-Math.PI / 2).rotateY(Math.PI / 2).scale(1, 0.6, 0.8);
  parts.push(paint(place(roof, hx, hg + 3.2 + 0.99, hz, 0.4), 0x2f6fd0));
  parts.push(paint(place(new THREE.BoxGeometry(1.0, 1.9, 0.1), hx + Math.sin(0.4) * 2.12, hg + 0.95, hz + Math.cos(0.4) * 2.12, 0.4), 0x7a4f2a));
  addMerged(ctx, parts, ctx.M.structure, { cast: true, receive: true, name: 'Lighthouse' });
  // glowing lantern room
  const lantern = ctx.add(new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.45, 2.0, 12),
    new THREE.MeshBasicMaterial({ color: 0xfff3b0, toneMapped: false })), { name: 'Lantern' });
  lantern.position.set(lx, top + 1.65, lz);
  // Two rotating light shafts. Daylight-subtle: additive, fading out along
  // the shaft and toward its silhouette (so it never reads as a solid bar).
  const BEAM_LEN = 40;
  const beamG = new THREE.ConeGeometry(2.4, BEAM_LEN, 14, 1, true).rotateZ(Math.PI / 2).translate(BEAM_LEN / 2, 0, 0);
  const beamG2 = beamG.clone().rotateY(Math.PI);
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xfff0b8) }, uIntensity: { value: 0.32 } },
    vertexShader: /* glsl */`
      varying float vT;
      varying vec3 vN, vV;
      void main() {
        vT = abs(position.x) / ${BEAM_LEN.toFixed(1)};
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalMatrix * normal;
        vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uIntensity;
      varying float vT;
      varying vec3 vN, vV;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float a = uIntensity * pow(1.0 - vT, 1.8) * smoothstep(0.0, 0.06, vT) * facing * facing;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
  const beam = new THREE.Mesh(mergeGeometries([beamG, beamG2]), beamMat);
  beamG.dispose(); beamG2.dispose();
  beam.position.set(lx, top + 1.7, lz);
  beam.renderOrder = 5;
  ctx.add(beam, { name: 'LighthouseBeam' });
  ctx.animators.push((dt) => { beam.rotation.y += dt * 0.9; });
  ctx.exclusions.push([lx, lz, 10], [hx, hz, 7]);
  ctx.prop('lighthouse', lx, lz, 4.8);
  ctx.prop('cottage', hx, hz, 3.6);
  ctx.flagSpots.push([hx + 2.5, hg + 5.5, hz - 2.5, 0]);
  ctx.landmarks.push({ name: 'lighthouse', x: lx, z: lz, r: 4.8, h: top + 5 });
}

// Pines, broadleaf trees, palms by the shore, bushes and rocks (+ sea stacks).
function buildBreezyVegetation(ctx, field, beachW = null) {
  const { track, Q, exclusions } = ctx;
  const sandy = (x, z, sd) => !!beachW && sd < beachW(x, z, sd).W + 2;      // keep trees / bushes off the beaches
  const rng = makeRng(2024);
  // Geometry (triangles): pine 66, broadleaf 48, palm ~79, bush 40, rock 36.
  const pine = mergeGeometries([
    paint(new THREE.CylinderGeometry(0.22, 0.32, 1.8, 6).translate(0, 0.9, 0), C.trunk),
    paint(new THREE.ConeGeometry(2.1, 3.2, 7).translate(0, 3.0, 0), C.pine),
    paint(new THREE.ConeGeometry(1.65, 2.8, 7).translate(0, 4.6, 0), mixHex(C.pine, 0x3fa356, 0.4)),
    paint(new THREE.ConeGeometry(1.1, 2.3, 7).translate(0, 6.1, 0), mixHex(C.pine, 0x5cbf5a, 0.5)),
  ]);
  const broad = mergeGeometries([
    paint(new THREE.CylinderGeometry(0.26, 0.36, 2.6, 6, 1, true).translate(0, 1.3, 0), C.trunk),
    paint(lumpy(new THREE.DodecahedronGeometry(2.3, 0), 0.22, 1, 0.86, 1).translate(0, 4.1, 0), C.leaf),
  ]);
  const palmParts = [];
  {
    let x = 0, y = 0, lean = 0;
    for (let k = 0; k < 5; k++) {
      const h = 1.25;
      palmParts.push(paint(place(new THREE.CylinderGeometry(0.19 - k * 0.012, 0.24 - k * 0.012, h, 5, 1, true), x + Math.sin(lean) * h / 2, y + Math.cos(lean) * h / 2, 0, 0, 0, -lean), k % 2 ? 0x9b7448 : 0x8a6539));
      y += Math.cos(lean) * h; x += Math.sin(lean) * h; lean += 0.07;
    }
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      const fr = new THREE.ConeGeometry(0.42, 3.4, 3, 1, true).rotateZ(-Math.PI / 2).scale(1, 0.28, 1).translate(1.7, 0, 0).rotateZ(-0.35);
      palmParts.push(paint(place(fr, x, y + 0.1, 0, a), k % 2 ? C.palmLeaf : 0x3e9c43));
    }
    palmParts.push(paint(new THREE.OctahedronGeometry(0.34, 0).translate(x, y - 0.12, 0), 0x6b4a2a));
  }
  const palm = mergeGeometries(palmParts);
  palmParts.forEach((g) => g.dispose());
  const bush = mergeGeometries([
    paint(lumpy(new THREE.IcosahedronGeometry(1.0, 0), 0.3, 1.25, 0.8, 1.25, 5).translate(0, 0.45, 0), C.bush),
    paint(lumpy(new THREE.IcosahedronGeometry(0.72, 0), 0.3, 1.2, 0.85, 1.2, 9).translate(0.75, 0.35, 0.35), mixHex(C.bush, 0x6cc24a, 0.35)),
  ]);
  const rock = paint(lumpy(new THREE.DodecahedronGeometry(1.0, 0), 0.35, 1.2, 0.72, 1, 3), C.rock);
  // Footprint radius (m, at scale 1) used for wall clearance & verification.
  const R = { pine: 2.1, broad: 2.6, palm: 3.25, bush: 1.75, rock: 1.45 };

  const core = field.core;
  const inExcl = (x, z) => exclusions.some(([ex, ez, er]) => (x - ex) * (x - ex) + (z - ez) * (z - ez) < er * er);
  const slopeAt = (x, z) => {
    const a = field.surfaceHeight(x + 1.5, z), b = field.surfaceHeight(x - 1.5, z);
    const c2 = field.surfaceHeight(x, z + 1.5), d = field.surfaceHeight(x, z - 1.5);
    return Math.hypot(a - b, c2 - d) / 3;
  };
  const ext = 150;
  const pick = (count, accept) => {
    const out = [];
    let tries = 0;
    while (out.length < count && tries < count * 80) {
      tries++;
      const x = lerp(core.x0 - ext, core.x1 + ext, rng()), z = lerp(core.z0 - ext, core.z1 + ext, rng());
      const r = accept(x, z);
      if (r) out.push(r);
    }
    return out;
  };
  const dry = (x, z, minH) => field.surfaceHeight(x, z) > WATER_LEVEL + minH;
  const forest = (x, z) => fbm(x * 0.012 + 11, z * 0.012 - 4, 3);
  // Spot = [x, y, z, yaw, scale, wallClearance, footprintRadius]. Every prop
  // keeps its whole footprint (+1 m for barrier/tyre thickness) beyond the walls.
  const makeSpot = (x, z, type, sc, sink) => {
    const clr = field.wallClearance(x, z), r = R[type] * sc;
    if (!(clr > r + 1.0)) return null;
    // denser near the track, sparser far away
    if (rng() > lerp(1, 0.3, smoothstep((clr - 40) / 170))) return null;
    return [x, field.surfaceHeight(x, z) - sink, z, rng() * Math.PI * 2, sc, clr, r];
  };
  const treeSpots = (count, type) => pick(count, (x, z) => {
    if (!dry(x, z, 0.9) || inExcl(x, z)) return null;
    const sd = coastDistance(x, z);
    if (type === 'palm') { if (sd > 34 || sd < 1) return null; } else if (sd < 14 || sandy(x, z, sd)) return null;
    const dens = type === 'pine' ? smoothstep((forest(x, z) - 0.5) / 0.12) : smoothstep((0.58 - forest(x, z)) / 0.2) * 0.8 + 0.2;
    if (type !== 'palm' && rng() > dens) return null;
    if (slopeAt(x, z) > (type === 'palm' ? 0.35 : 0.55)) return null;
    return makeSpot(x, z, type, lerp(0.8, 1.3, rng()), 0.25);
  });
  const smallSpots = (count, type) => pick(count, (x, z) => {
    const rocky = type === 'rock';
    if (!dry(x, z, rocky ? -1.2 : 0.7) || inExcl(x, z)) return null;
    const sl = slopeAt(x, z);
    if (!rocky && (sl > 0.6 || sandy(x, z, coastDistance(x, z)))) return null;
    if (rocky && sl < 0.25 && rng() < 0.7) return null;     // prefer slopes, cliffs and shores
    const sc = rocky ? lerp(0.7, 2.6, rng() * rng()) : lerp(0.7, 1.4, rng());
    return makeSpot(x, z, type, sc, rocky ? 0.3 * sc : 0.12);
  });

  const V = Q.veg;
  const sets = {
    Pines: { geo: pine, spots: treeSpots(Math.round(240 * V), 'pine'), near: 45 },
    Trees: { geo: broad, spots: treeSpots(Math.round(200 * V), 'broad'), near: 45 },
    Palms: { geo: palm, spots: treeSpots(Math.round(80 * V), 'palm'), near: 45 },
    Bushes: { geo: bush, spots: smallSpots(Math.round(250 * V), 'bush'), near: 22, tints: [0xffffff, 0xffffff, 0xffffff, 0xffd0e8, 0xfff0a0], tint: [0.8, 1.2] },
    Rocks: { geo: rock, spots: smallSpots(Math.round(150 * V), 'rock'), near: 0 },
  };
  // The palm islet always gets a few palms.
  {
    const isl = ISLETS[1];
    for (let k = 0; k < 4; k++) {
      const a = k * 1.7 + 0.4, d = 3 + (k % 2) * 3;
      const x = isl.x + Math.cos(a) * d, z = isl.z + Math.sin(a) * d;
      if (field.surfaceHeight(x, z) > WATER_LEVEL + 0.6) sets.Palms.spots.push([x, field.surfaceHeight(x, z) - 0.25, z, a * 2, 1.1, 999, R.palm * 1.1]);
    }
  }
  // Sea stacks: boulders standing in the surf at the foot of the cliffs.
  for (const zn of track.zones) {
    if (zn.type !== 'cliff') continue;
    const len = track.forwardDistance(zn.s0, zn.s1);
    for (let d = 14; d < len - 10; d += 9 + rng() * 9) {
      const f = track.frameAt(zn.s0 + d);
      const sc = lerp(1.2, 2.6, rng()), r = R.rock * sc;
      const lat = -(f.wallL + r + 1.6 + rng() * 3.5);
      const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
      if (field.surfaceHeight(x, z) > WATER_LEVEL - 0.5 || field.wallClearance(x, z) < r + 1.0) continue;
      sets.Rocks.spots.push([x, WATER_LEVEL - 0.35 * sc + rng() * 0.4, z, rng() * 6.28, sc, field.wallClearance(x, z), r]);
    }
  }
  for (const [name, set] of Object.entries(sets)) {
    addInstancedSet(ctx, name, set.geo, set.spots, rng, { near: set.near, tints: set.tints || null, tint: set.tint || [0.85, 1.12] });
  }
}

// Beach umbrellas + towels on the promenade / grandstand beach (east of the
// home straight, between the boardwalk and the sea).
function buildUmbrellas(ctx, field) {
  const rng = makeRng(99);
  const spots = [];
  const inExcl = (x, z, r) => ctx.exclusions.some(([ex, ez, er]) => (x - ex) * (x - ex) + (z - ez) * (z - ez) < (er + r) * (er + r));
  for (let k = 0; k < 900 && spots.length < Math.round(22 * Math.max(0.6, ctx.Q.veg)); k++) {
    const x = lerp(24, 50, rng()), z = lerp(-104, 60, rng());
    const h = field.surfaceHeight(x, z);
    if (h < WATER_LEVEL + 0.45 || h > 1.6 || field.wallClearance(x, z) < 6 || inExcl(x, z, 2)) continue;
    if (spots.some(([sx, , sz]) => Math.hypot(sx - x, sz - z) < 6)) continue;
    spots.push([x, h, z]);
    ctx.prop('umbrella', x, z, 1.5);
  }
  if (!spots.length) return;
  const canopy = new THREE.ConeGeometry(1.5, 0.6, 8).toNonIndexed().translate(0, 2.35, 0);
  faceColors(canopy, (y, ny, fi) => (fi % 2 ? 0xffffff : 0xff4f6a));
  const g = mergeGeometries([paint(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 5).translate(0, 1.2, 0), 0xf2f2f2), paint(canopy, null)]);
  const towelG = paint(new THREE.BoxGeometry(0.9, 0.03, 1.8).translate(1.3, 0.04, 0.2), 0xffffff);
  const umbrellas = new THREE.InstancedMesh(g, ctx.M.structure, spots.length);
  const towels = new THREE.InstancedMesh(towelG, ctx.M.structure, spots.length);
  const tc = [0x3fa7ff, 0xffd23f, 0xff6fb5, 0x5ad35a];
  spots.forEach(([x, h, z], i) => {
    place_m4(_m4, x, h - 0.05, z, rng() * 6.28, 1, 1, 1);
    umbrellas.setMatrixAt(i, _m4); towels.setMatrixAt(i, _m4);
    umbrellas.setColorAt(i, _col.set(i % 3 === 0 ? 0xffffff : i % 3 === 1 ? 0xb8f0ff : 0xfff0a0));
    towels.setColorAt(i, _col.set(tc[i % tc.length]));
  });
  ctx.add(umbrellas, { cast: true, name: 'Umbrellas' });
  ctx.add(towels, { receive: true, name: 'Towels' });
  ctx.stats.instances.umbrellas = spots.length;
}

// Ring of mountains on the land side + islands out at sea.
function buildBreezyMountains(ctx) {
  const rng = makeRng(555);
  const geos = [];
  const cx = WORLD_CENTER.x, cz = WORLD_CENTER.z;
  const mountain = (x, z, radius, height, seg, snow) => geos.push(mountainGeometry(x, z, radius, height, seg, (t, ny, y) => {
    if (snow && t > 0.68) return 0xf4f7fb;
    if (t > 0.42 || ny < 0.45) return mixHex(0x8a8d7c, 0x6f7566, hash2(Math.round(y), 3));
    return mixHex(0x4f9a4c, 0x6db356, hash2(Math.round(y * 3), 9));
  }));
  // ring of mountains on the land side (north / east / north-west)
  for (let k = 0; k < 26; k++) {
    const a = lerp(-0.42, 2.95, k / 25) + (rng() - 0.5) * 0.12;     // radians, 0 = +x
    const r = lerp(760, 1160, rng());
    const h = lerp(110, 290, rng() * rng() + 0.15);
    mountain(cx + Math.cos(a) * r, cz + Math.sin(a) * r, h * lerp(1.2, 1.8, rng()), h, 9 + Math.floor(rng() * 3), h > 200);
    if (rng() < 0.6) {   // foothills in front
      const r2 = r - lerp(120, 220, rng()), h2 = h * lerp(0.3, 0.5, rng());
      mountain(cx + Math.cos(a + 0.06) * r2, cz + Math.sin(a + 0.06) * r2, h2 * 2.2, h2, 8, false);
    }
  }
  // islands out at sea (south / south-west)
  for (let k = 0; k < 6; k++) {
    const a = lerp(3.5, 5.3, k / 5) + (rng() - 0.5) * 0.2;
    const r = lerp(620, 1050, rng()), h = lerp(30, 90, rng());
    mountain(cx + Math.cos(a) * r, cz + Math.sin(a) * r, h * 2.6, h, 9, false);
  }
  addMerged(ctx, geos, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), { name: 'Mountains' });
}

// Sailboats circling in the bay (paths kept to deep water).
function buildSailboats(ctx, field) {
  const hull = new THREE.BoxGeometry(1.7, 0.8, 4.6, 1, 1, 2);
  {
    const p = hull.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i), y = p.getY(i);
      if (z > 1) p.setX(i, p.getX(i) * 0.08);
      if (y < 0) p.setX(i, p.getX(i) * 0.6);
    }
    hull.computeVertexNormals();
  }
  const sail = new THREE.BufferGeometry();
  sail.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.9, -1.4, 0, 6.2, 0.2, 0, 0.9, 1.5, 0, 0.9, -1.4, 0, 0.9, 1.5, 0, 6.2, 0.2], 3));
  sail.computeVertexNormals();
  const jib = new THREE.BufferGeometry();
  jib.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.9, 0.5, 0, 5.4, 0.35, 0, 0.9, 2.3, 0, 0.9, 0.5, 0, 0.9, 2.3, 0, 5.4, 0.35], 3));
  jib.computeVertexNormals();
  const boatG = mergeGeometries([
    paint(hull.translate(0, 0.1, 0), 0xffffff),
    paint(new THREE.CylinderGeometry(0.07, 0.08, 6.4, 5).translate(0, 3.3, 0.2), 0x8a6a4a),
    paint(sail, 0xffffff),
    paint(jib, 0xfff6e0),
  ]);
  hull.dispose(); sail.dispose(); jib.dispose();
  const boatMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  const candidates = [
    { cx: -192, cz: 18, rx: 18, rz: 28, sp: 0.05 },         // the bay
    { cx: -256, cz: -28, rx: 12, rz: 20, sp: -0.06 },
    { cx: -334, cz: -30, rx: 16, rz: 44, sp: 0.045 },        // the bay mouth / western sea
    { cx: -150, cz: -290, rx: 70, rz: 26, sp: 0.03 },        // north of the cliffs
    { cx: 120, cz: -30, rx: 30, rz: 70, sp: -0.035 },        // off the promenade beach
    { cx: -40, cz: -300, rx: 46, rz: 20, sp: 0.04 },
  ];
  // keep only paths that stay in deep enough water
  const boats = candidates.filter((b) => {
    for (let a = 0; a < Math.PI * 2; a += 0.2) {
      if (field.surfaceHeight(b.cx + Math.cos(a) * b.rx, b.cz + Math.sin(a) * b.rz) > WATER_LEVEL - 1.2) return false;
    }
    return true;
  });
  if (!boats.length) { boatG.dispose(); boatMat.dispose(); return; }
  const inst = new THREE.InstancedMesh(boatG, boatMat, boats.length);
  inst.frustumCulled = false;
  const bc = [0xffffff, 0xffe0e0, 0xe0f0ff, 0xfff4c8, 0xe6ffe6];
  boats.forEach((b, i) => { b.a = i * 2.1; inst.setColorAt(i, _col.set(bc[i % bc.length])); });
  const placeBoats = (time) => {
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      const x = b.cx + Math.cos(b.a) * b.rx, z = b.cz + Math.sin(b.a) * b.rz;
      // heading = derivative of the ellipse
      const dx = -Math.sin(b.a) * b.rx * Math.sign(b.sp), dz = Math.cos(b.a) * b.rz * Math.sign(b.sp);
      const yaw = Math.atan2(dx, dz);
      _eul.set(Math.sin(time * 1.3 + i) * 0.04, yaw, Math.sin(time * 0.9 + i * 2) * 0.08 + 0.1 * Math.sign(b.sp), 'YXZ');
      _q.setFromEuler(_eul);
      _m4.compose(_p3.set(x, WATER_LEVEL - 0.15 + Math.sin(time * 1.7 + i) * 0.08, z), _q, _s3.set(1.2, 1.2, 1.2));
      inst.setMatrixAt(i, _m4);
    }
    inst.instanceMatrix.needsUpdate = true;
  };
  placeBoats(0);
  ctx.add(inst, { cast: false, name: 'Boats' });
  ctx.animators.push((dt, time) => {
    for (let i = 0; i < boats.length; i++) boats[i].a += boats[i].sp * dt;
    placeBoats(time);
  });
  ctx.stats.instances.boats = boats.length;
}

// ------------------------------------------------------------------ buildWorld (Breezy Bay)

export function buildWorld(scene, track, opts = {}) {
  const ctx = createWorldContext(scene, track, opts);
  const { Q } = ctx, sp = track.spacing;
  const coast = breezyCoast(track);                     // the v5 coast (sea, lagoon, the Gull Gap notch)
  const notch = coast ? coast.notch : null;
  const inNotch = (s) => !!notch && track.forwardDistance(notch.s0, s) <= notch.s1 - notch.s0;

  // Sun ~59° high, from the side of the start/home straights (-x, slightly
  // +z): kart shadows fall beside the karts in the chase view there, and the
  // high elevation keeps them close under the karts everywhere else.
  const sunDir = new THREE.Vector3(-0.46, 0.84, 0.2).normalize();
  buildSky(ctx, { sunDir, top: C.skyTop, horizon: C.skyHorizon, bottom: C.skyBottom, fogNear: 220, fogFar: 1650 });
  const { sun, hemi, follow } = buildLights(ctx, { sunDir, sunColor: C.sun, sunIntensity: 2.7, hemiSky: C.hemiSky, hemiGround: C.hemiGround, hemiIntensity: 1.35 });
  const T = createTrackTextures(ctx);

  // terrain (+ sandstone strata on steep faces) + bay
  const field = createTerrainField(track, Q.terrainCell);
  const terrain = ctx.add(new THREE.Mesh(terrainGeometry(field, breezyTerrainColor(track)),
    new THREE.MeshLambertMaterial({ vertexColors: true, map: T.detail, flatShading: true })), { receive: true, name: 'Terrain' });
  patchBreezyTerrain(ctx, terrain);
  buildWaterSurface(ctx, field, sunDir);

  // road, curbs, off-road (concrete on the bridge deck, quay paving), start line;
  // sand verges / drifts and road paint on top (world-breezy.js)
  const Z = zonesByType(track);
  const isBridge = (s) => inType(track, Z, 'bridge', s);
  buildRoad(ctx, T, { offroadColor: (s, side) => (isBridge(s) ? C.concrete : side < 0 && inType(track, Z, 'harbor', s) ? 0xb9b3a6 : C.grass) });
  const sandAt = (s, side) => {
    let a = 0;
    for (const t of ['beach', 'spit', 'causeway']) for (const zn of Z[t] || []) a = Math.max(a, zoneWeight(track, zn, s, 14));
    for (const zn of Z.promenade || []) a = Math.max(a, (side <= 0 ? 1 : 0.35) * zoneWeight(track, zn, s, 18));
    return side === 0 ? a * 0.85 : a;
  };
  dressBreezyRoad(ctx, T, { sandAt });
  buildStartLine(ctx, T);

  // walls: style per sample & side
  const turnDir = (i) => Math.sign(track.curv[i]);
  const lastSeg = track.segments[track.segments.length - 1].s0, seg1 = track.segments[1].s0;
  buildWalls(ctx, T, (i, side) => {
    const s = i * sp;
    if (isBridge(s) || inNotch(s)) return 'none';             // bridge parapets / deck railings
    for (const z of track.zones) {
      if (!inZone(track, z, s)) continue;
      if (z.type === 'hairpin' && side === -turnDir(i)) return 'tires';
      if (z.type === 'spit' && side === 1 && track.offR[i] > 9) return 'stone';     // the beacon island
      if ((z.type === 'cliff' || z.type === 'harbor' || z.type === 'causeway') && side === -1) return 'stone';
      if ((z.type === 'beach' || z.type === 'promenade') && side === -1) return 'blue';
    }
    return s >= lastSeg || s <= seg1 ? 'blue' : 'red';
  }, {
    red: { band: TX.WALL_BANDS.redWhite, h: 0.95 },
    blue: { band: TX.WALL_BANDS.blueWhite, h: 0.95 },
    stone: { band: TX.WALL_BANDS.stone, h: 0.85 },
  });
  const bridgeZone = (Z.bridge || [])[0] || null;
  if (bridgeZone) buildBayBridge(ctx, bridgeZone);

  buildBoostPads(ctx, T);
  buildRamps(ctx, T);
  buildTurnSigns(ctx, T, { skip: (s, side) => inNotch(s) });
  buildGantry(ctx, T);
  buildGrandstands(ctx, field);
  buildLighthouse(ctx, field);

  // extra flags around Turn 1 and the hairpin, outside the walls
  for (const name of ['Turn 1 Entry', 'Turn 1', 'Lighthouse Hairpin']) {
    const seg = segByName(track, name);
    if (!seg) continue;
    for (let s = seg.s0 + 6; s < seg.s1 - 4; s += 11) {
      const f = track.frameAt(s);
      const side = -Math.sign(f.curvature || 1);
      const wall = side > 0 ? f.wallR : f.wallL;
      const lat = side * (wall + 3.2);
      ctx.flagSpots.push([f.x + f.right.x * lat, f.y - 0.25, f.z + f.right.z * lat, f.yaw, true]);
    }
  }
  buildFlags(ctx);

  // the v5 set pieces (hazards/bay.js) and landmarks (world-breezy.js)
  const hz = createBayHazards(track);
  if (notch) ctx.stats.bridges = [[notch.s0, notch.s1]];       // the Gull Gap deck (verifyGround)
  const disposeSetPieces = buildBreezySetPieces(ctx, field, hz);
  buildBreezyLandmarks(ctx, field, { notch, lagoon: coast ? coast.lagoon : null });

  buildBreezyVegetation(ctx, field, makeBeachWidth(track));
  buildUmbrellas(ctx, field);
  buildBreezyMountains(ctx);
  buildClouds(ctx, { center: WORLD_CENTER, sunDir, count: Math.round(ctx.Q.clouds * 0.75) });
  buildSailboats(ctx, field);

  const world = finishWorld(ctx, {
    sun, hemi, follow,
    getGroundHeight: (x, z) => field.surfaceHeight(x, z),
    extra: { waterLevel: WATER_LEVEL, hazards: hz },
  });
  const disposeWorld = world.dispose;
  world.dispose = () => { disposeSetPieces(); disposeWorld(); };
  return world;
}

// Node-safe internals exported for tools (no DOM needed).
export { coastDistance, breezyCoast, SEA_POLY, LAGOON_POLY, ISLETS, LIGHTHOUSE, C as BREEZY_COLORS };
