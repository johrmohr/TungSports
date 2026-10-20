// World builder for "Laguna Beach" (browser only), theme 'beach': a sunny
// surf-town loop inspired by Laguna Beach's Main Beach. Dispatched by
// worlds.js. Same contract as world.js: { sun, hemi, root, update, dispose,
// getGroundHeight, landmarks, stats, quality } + `hazards` (the course set
// pieces of hazards/beach.js, drawn by world-laguna-setpieces.js; main.js runs
// their clock with the race).
//
// What makes it Laguna (counter-clockwise lap, the Pacific on the right
// along the coast, golden late-afternoon sun over the sea):
//   * the Coast Highway through the gallery village (start): pastel stucco
//     shops with striped awnings and generic signs (ART, SURF, CAFÉ ...),
//     palms, crosswalks, bike lanes, a crowd of cottages inside the loop;
//   * the canyon: terraced cottages low on the Hillside Climb, then dry
//     chaparral hills, eucalyptus groves and the art-festival field (white
//     tents, sculptures, a picket fence) at the Sawdust bends, a double yellow
//     centre line up to the Crest Hairpin (a bench and a lone Torrey pine);
//   * the clifftop park: lawns, palms, the rose garden, a white railing on
//     sandstone cliffs, benches and a painter's easel, the gazebo on the
//     Monument Point promontory, Bird Rock offshore;
//   * the Rockpile cove: a timber trestle bridge over a rocky inlet (jump);
//   * the bluff (ice plant) down to the tide-pool shelf: wet rock, barnacles,
//     a sea arch, starfish and anemones, BLOWHOLES spouting through the road;
//   * Main Beach: boardwalk planks, sand, SHORE-BREAK WAVES washing over the
//     beach road, the white-and-sea-blue hexagonal lifeguard tower beside the
//     tower jump (sand blown over the road), four volleyball courts with
//     players SPIKING balls onto the road, two half basketball courts at the
//     north end, a playground at the south end;
//   * Ocean Avenue, Gallery Row, painters' easels along the Forest Avenue
//     chicane, Broadway; an animated ocean with surf, sailboats, canyon hills.
// No real business names, logos or city badges; generic figures only.
// Telegraph sounds of the set pieces: world-laguna-setpieces.js (bus item:sfx).
//
// Quality 'low' (split-screen): no shadow map, coarser terrain, fewer
// houses / palms / props. Budget at 'high': ≤ 120 draw calls, ≤ 280k tris.

import * as THREE from 'three';
import { makeRng, clamp, lerp, smoothstep } from './utils.js';
import * as TX from './textures.js';
import {
  createWorldContext, buildSky, buildLights, createTrackTextures, buildRoad, buildStartLine, buildWalls,
  buildBoostPads, buildRamps, buildTurnSigns, buildGantry, buildFlags, buildClouds, mountainGeometry, lumpy,
  addInstancedSet, finishWorld, createTerrainField, terrainGeometry, sRange, regionBuckets, buildWaterSurface,
  place, paint, faceColors, mixHex, place_m4, addMerged, fbm, hash2,
  tris, box, quad, cyl, ball, cone, mergeParts, gableRoof, hipRoof, stripeX, segByName, arcCenter, zonesByType, inType,
  makeNearest, makeLoopInside, makeRoadHeightField, rect, createPlacer, buildLamps, roadDecal, decalMaterial, buildTimberDeck, trackStrip,
} from './world.js';
import { createHazards } from './hazards.js';
import { buildBeachSetPieces } from './world-laguna-setpieces.js';
import { createLagunaRoadTexture, createLagunaDecalAtlas, LAGUNA_DECALS, createPictogramAtlas, PICTO } from './world-laguna-textures.js';

// ------------------------------------------------------------------ palette

const C = {
  skyTop: 0x4b8fe0, skyHorizon: 0xffdcae, skyBottom: 0xf1cf9f,
  sun: 0xffe3bd, hemiSky: 0xd9e5ff, hemiGround: 0xbfa57c,
  grass: 0x7dbd4f, grassAlt: 0x96c95a, lawn: 0x6fb848, dry: 0xc8b874, chaparral: 0x8e9a5a, iceplant: 0x8fb25a,
  sand: 0xedd9a6, sandWet: 0xd4bd88, sandstone: 0xd9a46a, sandstoneDark: 0xb98450, rock: 0x8f8476,
  sidewalk: 0xd8d1c4, timber: 0xa8794a, timberDark: 0x6e4b2f,
  white: 0xf7f4ec, seaBlue: 0x2f8fc8, teal: 0x2a7fae, glass: 0x32526b, trim: 0xfaf6ee,
  walls: [0xf7f2e8, 0xf4e1c8, 0xf9d9c4, 0xe6efe9, 0xf6e7b8, 0xdfe9f3, 0xf2d0d8, 0xf7f7f2, 0xe9dcc8],
  roofs: [0xc2603c, 0xb4543a, 0xcf7046, 0x8a8f96, 0x6f7b88],
  awnings: [0xe8475f, 0x2f8fc8, 0x3d9a6a, 0xf2a03a, 0x1f5f8c],
  palmTrunk: 0x9c7a55, palmLeaf: 0x4f9e44, pine: 0x3f7a45, jacaranda: 0x9a7ad8, bougain: 0xd8288c,
  eucaTrunk: 0xd9d2c2, eucaBark: 0x9a8a72, eucaLeaf: 0x93ad8c, eucaLeafAlt: 0xadbf9a, sage: 0xa3ad86, festival: 0xd8c79a,
  tent: 0xfbfaf4, tentTrim: 0x2f8fc8,
};
const LEVEL = -0.3;           // sea surface (m)

// ------------------------------------------------------------------ layout

function lagunaLayout(track) {
  const Z = zonesByType(track);
  const seg = (name) => segByName(track, name);
  const centre = (name) => { const sg = seg(name); return sg ? arcCenter(track, sg.index) : null; };
  const one = (type) => (Z[type] || [])[0] || null;
  const b = track.bounds;
  return {
    Z, seg, one,
    hairpin: centre('Crest Hairpin'), heisler: centre('Heisler Turn'), oceanAve: centre('Ocean Avenue Turn'),
    beach: one('beach'), point: one('point'), bridge: one('bridge'), bluff: one('bluff'), clifftop: one('clifftop'),
    tidepools: one('tidepools'), festival: one('festival'), canyon: one('canyon'), tower: one('tower'), courts: one('courts'),
    center: { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 },
    flats: [],          // { x, z, r, h }: ground levelled for a landmark (the festival field)
    ridge: [],          // { x, z, r, h }: the chaparral ridge inside the canyon road
  };
}

// The art-festival field: a level dusty lot inside the loop beside the
// Sawdust bends, clear of every part of the road (nearest wall >= 4 m away).
function festivalField(track, L, nearest) {
  const fz = L.festival;
  if (!fz) return null;
  const R = 15;
  let best = null;
  for (let s = fz.s0 + 10; s < fz.s1 - 10; s += 4) {
    const f = track.frameAt(s);
    for (let off = R + 3; off < R + 26; off += 1.5) {
      const lat = -(f.wallL + off);
      const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
      const nr = nearest(x, z);
      const wall = Math.max(track.wl[nr.i], track.wr[nr.i]);
      if (nr.d - wall < R + 4) continue;
      const score = -Math.abs(nr.d - wall - (R + 5));
      if (!best || score > best.score) best = { x, z, r: R, h: f.y - 0.15, yaw: Math.atan2(f.tangent.x, f.tangent.z), s, score };
      break;
    }
  }
  return best;
}

// The coastline: a polyline right of the coastal stretch (sea on the right
// of its direction), from far up the coast, along the cliff lip (with the
// Monument Point promontory and the Rockpile inlet that runs under the cove
// bridge), out to the beach waterline, then on down the coast. Each vertex
// carries `cliff` (1 = sandstone cliff, 0 = sandy beach).
function coastLine(track, L) {
  const pts = [];
  const add = (x, z, cliff) => pts.push({ x, z, cliff });
  const at = (s, lat) => { const f = track.frameAt(s); return [f.x + f.right.x * lat, f.z + f.right.z * lat]; };
  const cd = L.seg('Cliff Drive');
  const sA = cd ? cd.s0 + 26 : 300;
  const beach = L.beach, br = L.bridge, pt = L.point;
  const pointS = pt ? (pt.s0 + pt.s1) / 2 - 4 : -1e9;
  const sB = beach ? beach.s1 + 8 : sA + 400;
  // Main Beach is ~40 m of sand past the road; narrower (~30 m) where the
  // shore-break waves wash up onto the beach road
  const surge = (L.hz ? L.hz.list : []).find((h) => h.type === 'surge');
  const surgeW = (s) => (surge ? smoothstep((s - (surge.s - 40)) / 30) * (1 - smoothstep((s - (surge.s + surge.len + 10)) / 30)) : 0);
  const beachLat = (f, s = 0) => f.halfWidth + lerp(40, 30, surgeW(s));
  const cliffLat = (s, f) => {
    let lip = 4.2 + 1.3 * Math.sin(s * 0.11) + 0.8 * Math.sin(s * 0.27 + 1);
    if (pt) lip += 34 * Math.exp(-(((track.deltaS(pointS, s)) / 24) ** 2));
    return f.wallR + lip;
  };
  const tp = L.tidepools;
  const beachW = (s) => (beach ? smoothstep((s - (beach.s0 - 14)) / 40) : 0);
  // the tide-pool shelf: a low rock ledge 5-8 m past the sea-side wall
  const shelf = (s) => (tp ? smoothstep((s - (tp.s0 - 30)) / 26) * (1 - smoothstep((s - (tp.s1 + 6)) / 20)) : 0);
  // far up the coast (north), coming down to the first lip point
  {
    const [x0, z0] = at(sA, cliffLat(sA, track.frameAt(sA)));
    for (const k of [12, 6, 3, 1.5, 0.6]) add(x0 - 10 * k, z0 + 110 * k, 1);
  }
  for (let s = sA; s <= sB; s += 3) {
    const f = track.frameAt(s);
    if (br && s > br.s0 + 1 && s < br.s1 - 1) {
      // the Rockpile inlet: under the bridge to beyond the inland wall
      if (!pts.inlet) {
        pts.inlet = true;
        const a = br.s0 + 4, m = (br.s0 + br.s1) / 2, e = br.s1 - 4;
        add(...at(a, f.wallR + 1), 1);
        add(...at(a + 1.5, -(track.frameAt(a).wallL + 5)), 1);
        add(...at(m, -(track.frameAt(m).wallL + 11)), 1);
        add(...at(e - 1.5, -(track.frameAt(e).wallL + 5)), 1);
        add(...at(e, track.frameAt(e).wallR + 1), 1);
      }
      continue;
    }
    const w = beachW(s), sh = shelf(s);
    const lip = lerp(cliffLat(s, f), f.wallR + 6.5 + 1.5 * Math.sin(s * 0.19), sh);
    add(...at(s, lerp(lip, beachLat(f, s), w)), (1 - w) * (1 - 0.55 * sh));
  }
  // on down the coast (south)
  {
    const f = track.frameAt(sB), [x1, z1] = at(sB, beachLat(f, sB));
    let dx = f.tangent.x * 0.6 + 0.25, dz = f.tangent.z * 0.6 - 0.9;
    const l = Math.hypot(dx, dz); dx /= l; dz /= l;
    for (const k of [20, 60, 160, 400, 1100]) add(x1 + dx * k, z1 + dz * k, 0);
  }
  // signed distance (+ land, - sea) + cliff weight of the nearest point. The
  // sign comes from a closed sea polygon (the coastline + a far-east return)
  // so it never flips where the nearest point is a polyline vertex.
  const n = pts.length;
  let east = -Infinity;
  for (const p of pts) east = Math.max(east, p.x);
  const sea = [...pts, { x: east + 4000, z: pts[n - 1].z }, { x: east + 4000, z: pts[0].z }];
  const SX = new Float64Array(sea.map((p) => p.x)), SZ = new Float64Array(sea.map((p) => p.z));
  const inSea = (x, z) => {
    let inn = false;
    for (let i = 0, j = SX.length - 1; i < SX.length; j = i++) {
      if ((SZ[i] > z) !== (SZ[j] > z) && x < ((SX[j] - SX[i]) * (z - SZ[i])) / (SZ[j] - SZ[i]) + SX[i]) inn = !inn;
    }
    return inn;
  };
  const res = { sd: 0, cliff: 1 };
  const query = (x, z) => {
    let best = Infinity, cl = 1;
    for (let k = 0; k < n - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
      const t = l2 > 0 ? clamp(((x - a.x) * ex + (z - a.z) * ez) / l2, 0, 1) : 0;
      const qx = a.x + ex * t, qz = a.z + ez * t;
      const d = (x - qx) * (x - qx) + (z - qz) * (z - qz);
      if (d < best) { best = d; cl = lerp(a.cliff, b.cliff, t); }
    }
    res.sd = (inSea(x, z) ? -1 : 1) * Math.sqrt(best); res.cliff = cl;
    return res;
  };
  return { pts, query };
}

// ------------------------------------------------------------------ terrain

// Land: a smooth surface through the road heights (the town between the
// highway and the beach), canyon hills rising inland (west); sandstone cliffs
// drop to rocky coves along the clifftop, the beach slopes gently into the
// surf; the sea floor shelves away.
function lagunaNatural(track, L, coast) {
  const road = makeRoadHeightField(track, 3, 900);
  return (x, z, minE, sd) => {
    const r = road(x, z);
    let land = r.h;
    // canyon hills inland (west of the highway / hillside)
    const west = Math.max(0, -(x + 55));
    land += Math.min(95, west * 0.34) * (0.55 + 0.9 * fbm(x * 0.009 + 3.1, z * 0.009 - 1.2, 3)) * smoothstep((r.d - 18) / 40);
    // ... and a lower chaparral ridge on the inside of the canyon road, so the
    // esses and the Sawdust bends run between hills
    let ridge = 0;
    for (const c of L.ridge) {
      const d2 = ((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z)) / (c.r * c.r);
      if (d2 < 1) ridge = Math.max(ridge, c.h * (1 - d2) * (1 - d2));
    }
    if (ridge > 0) land += ridge * (0.65 + 0.7 * fbm(x * 0.02 - 7, z * 0.02 + 2, 2)) * smoothstep((r.d - 17) / 26);
    land += (fbm(x * 0.03, z * 0.03, 2) - 0.5) * 1.4 * smoothstep((r.d - 16) / 20);
    for (const fl of L.flats) {
      const d = Math.hypot(x - fl.x, z - fl.z);
      if (d < fl.r + 16) land = lerp(land, fl.h, 1 - smoothstep((d - fl.r) / 16));
    }
    const q = coast.query(x, z), cliff = q.cliff;
    sd = q.sd;
    if (sd >= 0) {
      // sand slopes up from the waterline; far inland the land takes over
      // (also hides which coast segment happens to be nearest out there)
      const beachH = LEVEL + 0.12 + 0.052 * sd;
      return lerp(Math.min(land, beachH), land, Math.max(cliff, smoothstep((sd - 70) / 60)));
    }
    const shelf = LEVEL - 0.8 - Math.min(7, -sd * 0.12);
    const cliffSea = lerp(land, shelf, smoothstep(-sd / 3.2));
    const beachSea = Math.max(LEVEL - 9, LEVEL + 0.12 + 0.07 * sd);
    return lerp(beachSea, cliffSea, cliff);
  };
}

function lagunaTerrainColor(track, L, coast, nearest) {
  const cG = new THREE.Color(C.grass), cA = new THREE.Color(C.grassAlt), cDry = new THREE.Color(C.dry), cCh = new THREE.Color(C.chaparral);
  const cSand = new THREE.Color(C.sand), cWet = new THREE.Color(C.sandWet), cSs = new THREE.Color(C.sandstone), cSsD = new THREE.Color(C.sandstoneDark);
  const cRock = new THREE.Color(C.rock), cWalk = new THREE.Color(C.sidewalk), cSage = new THREE.Color(C.sage), cIce = new THREE.Color(C.iceplant);
  const cIceF = new THREE.Color(0xc8508f), cFest = new THREE.Color(C.festival), cShelf = new THREE.Color(0x6f675c), tmp = new THREE.Color();
  const canyon = (s) => L.canyonS && s > L.canyonS[0] && s < L.canyonS[1];
  return (c, x, z, h, slope) => {
    const n1 = fbm(x * 0.028, z * 0.028, 3), n2 = fbm(x * 0.008 + 4, z * 0.008 - 9, 3), n3 = fbm(x * 0.09 + 11, z * 0.09 - 5, 2);
    c.copy(cG).lerp(cA, smoothstep((n1 - 0.35) / 0.3));
    const q = coast.query(x, z);
    const nr = nearest(x, z);
    // dry chaparral on the far hills (and right up to the canyon road): sage,
    // olive scrub, dry grass, dark specks of shrubs
    const chap = Math.max(smoothstep((nr.d - 70) / 90) * 0.85, canyon(nr.s) ? smoothstep((nr.d - 17) / 12) * 0.95 : 0);
    if (chap > 0) {
      tmp.copy(cCh).lerp(cDry, smoothstep((n2 - 0.45) / 0.2)).lerp(cSage, smoothstep((n1 - 0.55) / 0.2) * 0.7);
      if (n3 > 0.62) tmp.multiplyScalar(0.78);
      c.lerp(tmp, chap);
    }
    // town ground near the village roads (sidewalks / gardens)
    const zt = zoneAt(track, L, nr.s);
    if ((zt === 'village' || (zt === 'hillside' && !canyon(nr.s))) && nr.d < 40) c.lerp(cWalk, smoothstep((30 - nr.d) / 10) * 0.35);
    // the festival lot: trodden dust
    for (const fl of L.flats) { const d = Math.hypot(x - fl.x, z - fl.z); if (d < fl.r + 4) c.lerp(cFest, (1 - smoothstep((d - fl.r + 2) / 6)) * (0.8 + 0.2 * n3)); }
    // ice plant carpets the bluff slopes (green with magenta flowers)
    if (zt === 'bluff' && nr.d < 60 && q.sd > 0) {
      tmp.copy(cIce).lerp(cIceF, n3 > 0.58 ? 0.55 : 0.08);
      c.lerp(tmp, smoothstep((slope - 0.12) / 0.25) * 0.9);
    }
    // sand: beaches and coves near the water
    const beachy = (1 - q.cliff) * smoothstep((40 - q.sd) / 12);
    const cove = smoothstep((LEVEL + 1.8 - h) / 1.2);
    c.lerp(tmp.copy(cSand).lerp(cWet, smoothstep((LEVEL + 0.6 - h) / 0.6)), clamp(Math.max(beachy, cove * 0.9), 0, 1));
    if (h < LEVEL - 0.3) c.copy(cWet).lerp(cRock, q.cliff * 0.5);
    // the tide-pool shelf: dark wet rock at the water's edge
    if (zt === 'tidepools' && q.sd < 9 && h < LEVEL + 2.2) c.lerp(tmp.copy(cShelf).multiplyScalar(0.85 + 0.3 * n3), 0.85);
    // sandstone cliff faces (banded), rock low down
    const face = smoothstep((slope - 0.55) / 0.45);
    if (face > 0) {
      tmp.copy(cSs).lerp(cSsD, (Math.sin(h * 2.1 + n1 * 3) * 0.5 + 0.5) * 0.7);
      if (h < LEVEL + 1.2) tmp.lerp(cRock, 0.6);
      c.lerp(tmp, face);
    }
  };
}
function zoneAt(track, L, s) {
  for (const z of track.zones) if (track.forwardDistance(z.s0, s) <= track.forwardDistance(z.s0, z.s1)) return z.type;
  return '';
}

// ------------------------------------------------------------------ buildings

const FLOOR_H = 3.2;

// A stucco shop / cottage (local frame: x along the front, +z = front).
// roof: 'tile' (red-tile hip/gable), 'flat' (parapet), 'shingle' (grey
// gable). Shops get a big window, a door and a striped awning; signs are
// returned as [w, h, x, y, z, word] for the sign atlas.
function buildingGeometry(rng, { w, d, floors, g0, gBase, wallCol, roof, shop, signWord = -1, deck = false }) {
  const parts = [], signs = [];
  const top = g0 + floors * FLOOR_H + 0.3;
  parts.push(box(w, top - gBase, d, 0, (top + gBase) / 2, 0, wallCol));
  const trim = mixHex(wallCol, C.trim, 0.55);
  if (roof === 'flat') {
    parts.push(box(w + 0.3, 0.6, d + 0.3, 0, top + 0.3, 0, trim));
    parts.push(box(w - 0.6, 0.1, d - 0.6, 0, top + 0.12, 0, 0x9a948a));
  } else {
    const rh = d * 0.28, col = roof === 'tile' ? C.roofs[Math.floor(rng() * 3)] : C.roofs[3 + Math.floor(rng() * 2)];
    const r = roof === 'tile' && rng() < 0.6 ? [hipRoof(w, d, rh, 0.5, col)] : gableRoof(w, d, rh, 0.5, col, wallCol);
    for (const g of r) parts.push(g.translate(0, top, 0));
    if (rng() < 0.4) parts.push(box(0.7, 1.8, 0.7, w * 0.3, top + rh * 0.6, -d * 0.15, 0xe8e0d0));
  }
  const zf = d / 2 + 0.05;
  const cols = Math.max(1, Math.floor((w - 0.8) / 2.6)), pitch = w / cols;
  for (let fl = 0; fl < floors; fl++) {
    const yc = g0 + fl * FLOOR_H + 1.7;
    for (let k = 0; k < cols; k++) {
      const xc = -w / 2 + pitch * (k + 0.5);
      if (fl === 0 && shop) continue;
      if (fl === 0 && k === Math.floor(cols / 2)) { parts.push(quad(1.1, 2.2, xc, g0 + 1.1, zf, 0x6b4a32)); continue; }
      parts.push(quad(1.2, 1.4, xc, yc, zf, C.glass));
      parts.push(quad(1.45, 0.16, xc, yc - 0.78, zf + 0.02, C.trim));
      // back windows
      parts.push(quad(1.1, 1.3, xc, yc, -zf, C.glass, Math.PI));
    }
  }
  if (shop) {
    // shop window + door, striped awning, sign above
    parts.push(quad(w - 2.4, 2.1, -0.6, g0 + 1.4, zf, 0x3a5a70));
    parts.push(quad(1.1, 2.3, w / 2 - 0.9, g0 + 1.15, zf, 0x7a5434));
    const aw = new THREE.BoxGeometry(w - 0.6, 0.08, 1.4, Math.max(2, Math.round((w - 0.6) / 0.6)), 1, 1);
    parts.push(place(stripeX(aw, C.awnings[Math.floor(rng() * C.awnings.length)], 0xfffaf0, 0.6), 0, g0 + 2.85, zf + 0.68, 0, 0.3));
    if (signWord >= 0) signs.push([Math.min(w - 1.5, 4.6), 0.86, 0, g0 + 3.55, zf + 0.04, signWord]);
  }
  if (deck) {
    // upper-floor deck with a white rail (cottages)
    parts.push(box(w * 0.7, 0.18, 1.6, 0, g0 + FLOOR_H, zf + 0.8, C.timber));
    parts.push(box(w * 0.7, 0.9, 0.06, 0, g0 + FLOOR_H + 0.5, zf + 1.58, C.white));
  }
  return { parts, signs, top };
}

// The town: shops along the village / Gallery Row, cottages up the
// hillside and filling the loop, a few houses up the canyon hills.
function buildTown(ctx, field, L, placer, bucket, signs, rng, nearest, inside) {
  const { track, Q } = ctx;
  let count = 0;
  const add = (x, z, fx, fz, spec) => {
    const yaw = Math.atan2(fx, fz);
    const rc = rect(x, z, yaw, spec.w / 2 + 0.5, spec.d / 2 + (spec.shop ? 1.6 : 0.5));
    const ok = placer.fits(rc, { slopeMax: spec.slopeMax || 3.5, clearance: 1.0 });
    if (!ok) return false;
    const wallCol = C.walls[Math.floor(rng() * C.walls.length)];
    const g0 = spec.frontGround !== undefined ? spec.frontGround : field.surfaceHeight(x + fx * spec.d / 2, z + fz * spec.d / 2);
    const bld = buildingGeometry(rng, { ...spec, g0, gBase: ok.gMin - 0.8, wallCol });
    for (const g of bld.parts) bucket.push(place(g, x, 0, z, yaw));
    for (const sg of bld.signs) {
      const [w, h, lx, ly, lz, word] = sg;
      const pg = new THREE.PlaneGeometry(w, h);
      const uv = pg.attributes.uv, rows = TX.SIGN_WORDS.length;
      for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - (word + 1 - uv.getY(i)) / rows);
      pg.translate(lx, ly, lz);
      signs.push(place(pg, x, 0, z, yaw));
    }
    placer.add(rc, 'house', 0.5);
    count++;
    return true;
  };
  // street rows: front = facing the road, beyond the wall line
  const row = (s0, s1, side, opts = {}) => {
    const { setback = 1.4, depth = [8, 11], width = [7, 11], floors = [2, 2], shops = 0.7, roof = null, deck = 0 } = opts;
    for (let s = s0; s < s1;) {
      const w = lerp(width[0], width[1], rng()), d = lerp(depth[0], depth[1], rng());
      const f = track.frameAt(s + w / 2);
      const wall = side > 0 ? f.wallR : f.wallL;
      const off = wall + setback + d / 2;
      const k = 1 - f.curvature * side * off;
      if (k < 0.35) { s += 2; continue; }
      const x = f.x + f.right.x * side * off, z = f.z + f.right.z * side * off;
      const shop = rng() < shops;
      const ok = add(x, z, -f.right.x * side, -f.right.z * side, {
        w, d, floors: floors[0] + Math.floor(rng() * (floors[1] - floors[0] + 1)), shop,
        roof: roof || (shop ? (rng() < 0.6 ? 'flat' : 'tile') : (rng() < 0.6 ? 'tile' : 'shingle')),
        signWord: shop ? Math.floor(rng() * TX.SIGN_WORDS.length) : -1, frontGround: f.y - 0.2, slopeMax: 6, deck: rng() < deck,
      });
      s += ok ? (w + 0.6 + rng() * 1.2) / k : 2;
    }
  };
  for (const z of L.Z.village || []) {
    const len = track.forwardDistance(z.s0, z.s1);
    for (const side of [-1, 1]) row(z.s0 + 6, z.s0 + len - 4, side, { floors: [1, 2] });
  }
  const hill = L.seg('Hillside Climb');
  if (hill) {
    row(hill.s0 + 4, hill.s1 - 6, -1, { shops: 0.15, floors: [2, 2], deck: 0.5, setback: 2.2 });
    row(hill.s0 + 4, hill.s1 - 6, 1, { shops: 0.1, floors: [1, 2], deck: 0.3, setback: 2.0 });
  }
  // cottages filling the loop (town) and climbing the hillside (west)
  const b = track.bounds, G = 15;
  const dens = Q.veg >= 1 ? 1 : 0.5;
  for (let gx = b.minX - 150; gx < b.maxX + 20; gx += G) {
    for (let gz = b.minZ - 60; gz < b.maxZ + 90; gz += G) {
      const x = gx + (rng() - 0.5) * 7, z = gz + (rng() - 0.5) * 7;
      const nr = nearest(x, z);
      const q = L.coast.query(x, z);
      if (q.sd < 25) continue;                               // keep the coast open
      const zt = zoneAt(track, L, nr.s);
      let p;
      if (inside(x, z)) p = zt === 'beach' || zt === 'shortcut' || zt === 'bluff' || zt === 'tidepools' ? 0.15 : 0.75;
      else p = x < -15 ? 0.6 * (1 - smoothstep((nr.d - 160) / 80)) : 0.35;
      if (zt === 'clifftop' || zt === 'point' || zt === 'bridge') p *= 0.15;
      // the canyon is chaparral, eucalyptus and the festival lot, not town
      if (L.canyonS && nr.s > L.canyonS[0] - 20 && nr.s < L.canyonS[1] + 10 && nr.d < 120) p *= 0.06;
      if (rng() > p * dens) continue;
      let fx = track.px[nr.i] - x, fz = track.pz[nr.i] - z;
      if (x < -60) { fx = 1; fz = 0.1; }                     // hillside houses look out to sea
      const fl = Math.hypot(fx, fz) || 1;
      add(x, z, fx / fl, fz / fl, { w: lerp(7, 11, rng()), d: lerp(7, 10, rng()), floors: 1 + (rng() < 0.55 ? 1 : 0), roof: rng() < 0.55 ? 'tile' : rng() < 0.5 ? 'flat' : 'shingle', shop: false, slopeMax: 4.5, deck: rng() < 0.35 });
    }
  }
  return count;
}

// ------------------------------------------------------------------ landmarks

// The Main Beach lifeguard tower: hexagonal, three tiers, white with
// sea-blue trim, portholes, a wraparound-window lookout with a balcony,
// a conical roof and two clock faces. Faces the sea.
function lifeguardTower(parts) {
  const W = C.white, B = C.seaBlue;
  const hex = (r, h, y, col, open = false) => paint(place(new THREE.CylinderGeometry(r, r, h, 6, 1, open), 0, y, 0, Math.PI / 6), col);
  parts.push(hex(2.7, 0.6, 0.3, 0xd9d4c8));                       // plinth
  parts.push(hex(2.2, 3.6, 2.4, W));                             // lower storey
  parts.push(hex(2.26, 0.25, 4.25, B));                          // trim band
  parts.push(hex(2.0, 2.4, 5.5, W));                             // middle storey
  parts.push(hex(3.0, 0.22, 6.8, B));                            // balcony floor
  parts.push(hex(2.95, 0.12, 7.8, W));                           // balcony rail
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
    parts.push(box(0.1, 1.0, 0.1, Math.sin(a) * 2.9, 7.3, Math.cos(a) * 2.9, W));
  }
  parts.push(hex(2.1, 2.2, 8.0, C.glass));                        // lookout glazing
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    parts.push(box(0.22, 2.2, 0.22, Math.sin(a) * 2.08, 8.0, Math.cos(a) * 2.08, W));   // mullions at the corners
  }
  parts.push(hex(2.25, 0.3, 9.2, B));
  parts.push(paint(place(new THREE.ConeGeometry(2.9, 2.4, 6), 0, 10.55, 0, Math.PI / 6), B));
  parts.push(cyl(0.08, 0.08, 2.2, 5, 0, 12.6, 0, W));
  parts.push(ball(0.22, 0, 11.8, 0, W));
  // portholes on the lower storey, door, clocks on the middle storey (front + side)
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const nx = Math.sin(a), nz = Math.cos(a), r = 2.2 * Math.cos(Math.PI / 6) + 0.03;
    if (k === 0) {
      parts.push(quad(1.0, 2.0, nx * r, 1.6, nz * r, 0x2a6f9a, a));
    } else {
      parts.push(paint(place(new THREE.CircleGeometry(0.42, 12), nx * r, 2.7, nz * r, a), B));
      parts.push(paint(place(new THREE.CircleGeometry(0.3, 12), nx * (r + 0.01), 2.7, nz * (r + 0.01), a), C.glass));
    }
    if (k === 0 || k === 1) {
      const rr = 2.0 * Math.cos(Math.PI / 6) + 0.03;
      parts.push(paint(place(new THREE.CircleGeometry(0.55, 14), nx * rr, 5.6, nz * rr, a), 0xffffff));
      parts.push(paint(place(new THREE.RingGeometry(0.5, 0.6, 14), nx * (rr + 0.01), 5.6, nz * (rr + 0.01), a), B));
      parts.push(box(0.06, 0.38, 0.02, nx * (rr + 0.02), 5.75, nz * (rr + 0.02), 0x1a1a1a, a));
      parts.push(box(0.3, 0.06, 0.02, nx * (rr + 0.02) + Math.cos(a) * 0.12, 5.6, nz * (rr + 0.02) - Math.sin(a) * 0.12, 0x1a1a1a, a));
    }
  }
  // stairs up the back to the balcony
  for (let k = 0; k < 10; k++) parts.push(box(0.5, 0.14, 1.1, -3.4 + k * 0.5, 0.45 + k * 0.66, -3.1, W));
  parts.push(box(5.4, 0.12, 0.1, -1.15, 4.0, -3.7, W, 0, 0, 0.88));
  return parts;
}

function buildBeach(ctx, field, L, bucket, rng, lamps, palms) {
  const { track } = ctx;
  const Bz = L.beach;
  if (!Bz) return;
  const len = track.forwardDistance(Bz.s0, Bz.s1);
  const P = (s, lat) => { const f = track.frameAt(s); return { x: f.x + f.right.x * lat, z: f.z + f.right.z * lat, f }; };
  // the lifeguard tower: beside the tower jump (its sand-berm kicker), just
  // past the sea-side rope fence, facing the sea
  {
    const s = L.tower ? L.tower.s0 + 7 : Bz.s0 + len * 0.55, f = track.frameAt(s);
    let lat = f.wallR + 4.2, p = P(s, lat);
    while (field.wallClearance(p.x, p.z) < 3.4 && lat < f.wallR + 12) { lat += 0.5; p = P(s, lat); }
    const g = field.surfaceHeight(p.x, p.z);
    const geo = mergeParts(lifeguardTower([]));
    place(geo, p.x, g - 0.3, p.z, Math.atan2(f.right.x, f.right.z));
    bucket.push(geo);
    ctx.prop('lifeguardTower', p.x, p.z, 3.0);
    ctx.exclusions.push([p.x, p.z, 4.5]);
    ctx.landmarks.push({ name: 'lifeguardTower', x: p.x, z: p.z, r: 3, h: 13 });
    ctx.flagSpots.push([p.x - f.right.x * 3.6, g - 0.1, p.z - f.right.z * 3.6, f.yaw, true]);
  }
  // four sand volleyball courts (nets parallel to the boardwalk); the first
  // is the spiking court of the volleyball set piece (its players: setpieces)
  const lob = (L.hz ? L.hz.list : []).find((h) => h.type === 'lob');
  const lobS = lob ? lob.s : Bz.s1 - 40;
  const surge = (L.hz ? L.hz.list : []).find((h) => h.type === 'surge');
  const wet = (s) => surge && s > surge.s - 10 && s < surge.s + surge.len + 10;
  for (const [ds, dl] of [[5, 2.6], [5, 19.5], [27, 9], [-16, 11]]) {
    const s = lobS + ds, f = track.frameAt(s);
    const lat = f.wallR + dl, p = P(s, lat);
    if (field.wallClearance(p.x, p.z) < 1.5) continue;
    const g = field.surfaceHeight(p.x, p.z);
    const parts = [];
    for (const sx of [-4.6, 4.6]) parts.push(cyl(0.07, 0.07, 2.6, 5, sx, 1.3, 0, 0xe8e8e8));
    parts.push(box(9.2, 0.1, 0.06, 0, 2.5, 0, 0xffffff));                       // top tape
    for (const y of [1.65, 1.95, 2.25]) parts.push(box(9.2, 0.025, 0.025, 0, y, 0, 0x2a2a2e));
    for (let x = -4.4; x <= 4.41; x += 0.4) parts.push(box(0.025, 0.85, 0.025, x, 2.02, 0, 0x2a2a2e));
    // court boundary ropes on the sand (16 x 8 m)
    for (const [w, d, x, z] of [[16, 0.08, 0, 4], [16, 0.08, 0, -4], [0.08, 8, 8, 0], [0.08, 8, -8, 0]]) parts.push(box(w, 0.03, d, x, 0.02, z, 0x2f8fc8));
    const geo = mergeParts(parts);
    place(geo, p.x, g - 0.05, p.z, f.yaw + Math.PI / 2);
    bucket.push(geo);
    ctx.prop('volleyball', p.x, p.z, 0.3);
    ctx.exclusions.push([p.x, p.z, 5]);
  }
  // umbrellas + towels on the sand
  const umbCols = [0xe8475f, 0x2f8fc8, 0xf2b43a, 0x3d9a6a, 0xff8ac8];
  for (let k = 0; k < (ctx.Q.veg >= 1 ? 16 : 6); k++) {
    const s = Bz.s0 + len * rng(), f = track.frameAt(s), lat = f.wallR + lerp(5, 24, rng()), p = P(s, lat);
    if (wet(s) || L.coast.query(p.x, p.z).sd < 6) continue;                  // keep the surf zone clear
    if (field.wallClearance(p.x, p.z) < 3 || ctx.exclusions.some(([ex, ez, er]) => Math.hypot(p.x - ex, p.z - ez) < er + 1)) continue;
    const g = field.surfaceHeight(p.x, p.z);
    const canopy = new THREE.ConeGeometry(1.7, 0.6, 8, 1).toNonIndexed();
    const col = umbCols[k % umbCols.length];
    faceColors(canopy, (y, ny, fi) => (fi % 2 ? 0xffffff : col));
    bucket.push(paint(place(canopy, p.x, g + 2.3, p.z, rng(), 0.12), null));
    bucket.push(cyl(0.04, 0.04, 2.3, 4, p.x, g + 1.15, p.z, 0xf0f0f0));
    bucket.push(paint(place(new THREE.PlaneGeometry(0.9, 1.8).rotateX(-Math.PI / 2), p.x + 1.2, g + 0.04, p.z + 0.5, rng() * 3), umbCols[(k + 2) % umbCols.length]));
    ctx.prop('umbrella', p.x, p.z, 0.2);
    ctx.exclusions.push([p.x, p.z, 2.2]);
  }
  // inland: two half basketball courts (north end), palms, benches, a
  // tower-shaped playground (south end)
  for (let k = 0; k < 2; k++) {
    const s = Bz.s0 + 6 + k * 17, f = track.frameAt(s), lat = -(f.wallL + 9.5), p = P(s, lat);
    if (field.wallClearance(p.x, p.z) < 8) continue;
    const g = field.surfaceHeight(p.x, p.z);
    const parts = [box(14, 0.3, 15, 0, -0.05, 0, 0x3f8f6a), box(13, 0.02, 14, 0, 0.11, 0, 0x4fa47a)];
    for (const [w, d, x, z] of [[13, 0.12, 0, 7], [0.12, 14, -6.5, 0], [0.12, 14, 6.5, 0], [5, 0.12, 0, 1.2], [0.12, 5.8, -2.5, 4.1], [0.12, 5.8, 2.5, 4.1]]) parts.push(box(w, 0.05, d, x, 0.15, z, 0xffffff));
    parts.push(paint(new THREE.TorusGeometry(2.6, 0.06, 4, 24, Math.PI).rotateX(Math.PI / 2).translate(0, 0.16, 1.2), 0xffffff));
    parts.push(cyl(0.12, 0.12, 3.6, 6, 0, 1.8, 7.6, 0x3a3f46));
    parts.push(box(1.8, 1.1, 0.08, 0, 3.4, 7.3, 0xffffff));
    parts.push(paint(new THREE.TorusGeometry(0.24, 0.03, 4, 10).rotateX(Math.PI / 2).translate(0, 3.0, 6.95), 0xf26a2a));
    const geo = mergeParts(parts);
    place(geo, p.x, g, p.z, f.yaw + Math.PI / 2);
    bucket.push(geo);
    ctx.prop('court', p.x, p.z, 7.5);
    ctx.exclusions.push([p.x, p.z, 10]);
  }
  {
    const s = Bz.s1 - 10, f = track.frameAt(s), lat = -(f.wallL + 7), p = P(s, lat);
    if (field.wallClearance(p.x, p.z) > 5) {
      const g = field.surfaceHeight(p.x, p.z);
      const mini = mergeParts(lifeguardTower([]));
      mini.scale(0.42, 0.42, 0.42);
      const parts = [mini, box(6, 0.2, 6, 0, 0.05, 0, 0xe8c27a)];
      parts.push(box(0.9, 0.08, 3.2, 1.9, 1.1, 1.4, 0xf2a03a, 0, -0.55));
      parts.push(paint(new THREE.TorusGeometry(0.9, 0.08, 5, 12, Math.PI).translate(-2.2, 0, -1.6), 0x2f8fc8));
      const geo = mergeParts(parts);
      place(geo, p.x, g, p.z, f.yaw);
      bucket.push(geo);
      ctx.prop('playground', p.x, p.z, 2.9);
      ctx.exclusions.push([p.x, p.z, 4]);
    }
  }
  for (let d = 4; d < len; d += 12) {
    const s = Bz.s0 + d, f = track.frameAt(s), lat = -(f.wallL + 2.2), p = P(s, lat);
    if (field.wallClearance(p.x, p.z) < 1.4 || ctx.exclusions.some(([ex, ez, er]) => Math.hypot(p.x - ex, p.z - ez) < er)) continue;
    const g = field.surfaceHeight(p.x, p.z);
    palms.push([p.x, g - 0.1, p.z, rng() * 6.28, lerp(0.95, 1.25, rng()), field.wallClearance(p.x, p.z), 0.5]);
    ctx.exclusions.push([p.x, p.z, 1.6]);
  }
}

// Clifftop park: benches facing the sea on the cliff lip, the painter's
// easel at the rail, rose beds, the gazebo on Monument Point.
function buildClifftop(ctx, field, L, bucket, rng, roses, palms, lamps) {
  const { track } = ctx;
  const cz = L.clifftop;
  if (!cz) return;
  const len = track.forwardDistance(cz.s0, cz.s1);
  const P = (s, lat) => { const f = track.frameAt(s); return { x: f.x + f.right.x * lat, z: f.z + f.right.z * lat, f }; };
  // gazebo on the promontory
  if (L.point) {
    const s = (L.point.s0 + L.point.s1) / 2 - 4, f = track.frameAt(s);
    let best = null;
    for (let lat = f.wallR + 9; lat < f.wallR + 30; lat += 1) {
      const p = P(s, lat);
      if (L.coast.query(p.x, p.z).sd > 6 && field.wallClearance(p.x, p.z) > 6) best = p;
    }
    if (best) {
      const g = field.surfaceHeight(best.x, best.z);
      const parts = [cyl(4.2, 4.4, 0.6, 8, 0, 0.1, 0, 0xe8e2d4)];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        parts.push(box(0.22, 2.8, 0.22, Math.sin(a) * 3.7, 1.8, Math.cos(a) * 3.7, C.white));
        if (k % 2) parts.push(box(2.6, 0.12, 0.1, Math.sin(a + Math.PI / 8) * 3.6, 1.0, Math.cos(a + Math.PI / 8) * 3.6, C.white, a + Math.PI / 8 + Math.PI / 2));
      }
      parts.push(cyl(4.1, 4.1, 0.25, 8, 0, 3.3, 0, C.white));
      parts.push(paint(place(new THREE.ConeGeometry(4.6, 2.2, 8), 0, 4.5, 0, Math.PI / 8), 0x5d7f6a));
      parts.push(ball(0.3, 0, 5.75, 0, C.white));
      const geo = mergeParts(parts);
      place(geo, best.x, g - 0.05, best.z, 0);
      bucket.push(geo);
      ctx.prop('gazebo', best.x, best.z, 4.4);
      ctx.exclusions.push([best.x, best.z, 5.5]);
      ctx.landmarks.push({ name: 'gazebo', x: best.x, z: best.z, r: 4.4, h: 6 });
    }
  }
  // benches on the lip (facing the sea) + palms + the easel
  let easel = false;
  for (let d = 6; d < len - 4; d += 15) {
    const s = cz.s0 + d, f = track.frameAt(s);
    if (L.bridge && track.forwardDistance(L.bridge.s0 - 8, s) < track.forwardDistance(L.bridge.s0 - 8, L.bridge.s1 + 8)) continue;
    const p = P(s, f.wallR + 1.6);
    const q = L.coast.query(p.x, p.z);
    if (q.sd < 1.6 || field.wallClearance(p.x, p.z) < 0.9) continue;
    const g = field.surfaceHeight(p.x, p.z);
    const yaw = Math.atan2(f.right.x, f.right.z);
    if (!easel && d > len * 0.4) {
      easel = true;
      const parts = [
        box(0.06, 1.8, 0.06, -0.35, 0.9, 0, 0x8a5a34, 0, 0.15), box(0.06, 1.8, 0.06, 0.35, 0.9, 0, 0x8a5a34, 0, 0.15),
        box(0.06, 1.7, 0.06, 0, 0.85, -0.45, 0x8a5a34, 0, -0.35), box(0.9, 0.7, 0.04, 0, 1.45, 0.08, 0xfdf8ec, 0, 0.15),
        box(0.7, 0.5, 0.02, 0, 1.45, 0.11, 0x6fb1e0, 0, 0.15), box(0.7, 0.18, 0.02, 0, 1.28, 0.12, 0xf2b46a, 0, 0.15),
      ];
      const geo = mergeParts(parts);
      place(geo, p.x, g, p.z, yaw + Math.PI);
      bucket.push(geo);
      ctx.prop('easel', p.x, p.z, 0.5);
      continue;
    }
    const parts = [box(1.9, 0.08, 0.5, 0, 0.46, 0, 0x8a5a34), box(1.9, 0.4, 0.07, 0, 0.75, -0.24, 0x8a5a34, 0, -0.15)];
    for (const sx of [-0.8, 0.8]) parts.push(box(0.08, 0.46, 0.5, sx, 0.23, 0, 0x4a4f55));
    const geo = mergeParts(parts);
    place(geo, p.x, g, p.z, yaw);
    bucket.push(geo);
    ctx.prop('bench', p.x, p.z, 1.0);
    ctx.exclusions.push([p.x, p.z, 1.3]);
  }
  // palms + lamps along the inland edge, roses in the rose garden
  const rose = L.seg('Rose Garden');
  for (let d = 3; d < len; d += 11) {
    const s = cz.s0 + d, f = track.frameAt(s);
    for (const side of [-1, 1]) {
      const lat = side * ((side > 0 ? f.wallR : f.wallL) + (side > 0 ? 2.4 : 3.0));
      const p = P(s, lat);
      if (field.wallClearance(p.x, p.z) < 1.4 || (side > 0 && L.coast.query(p.x, p.z).sd < 2.5)) continue;
      if (ctx.exclusions.some(([ex, ez, er]) => Math.hypot(p.x - ex, p.z - ez) < er)) continue;
      const g = field.surfaceHeight(p.x, p.z);
      if ((d / 11) % 3 < 1 && side < 0) lamps.push([p.x, g - 0.05, p.z, f.yaw, 1.1]);
      else palms.push([p.x, g - 0.1, p.z, rng() * 6.28, lerp(0.9, 1.3, rng()), field.wallClearance(p.x, p.z), 0.5]);
      ctx.exclusions.push([p.x, p.z, 1.5]);
    }
  }
  if (rose) {
    for (let s = rose.s0 - 6; s < rose.s1 + 6; s += 1.6) {
      for (const side of [-1, 1]) {
        const f = track.frameAt(s);
        const lat = side * ((side > 0 ? f.wallR : f.wallL) + lerp(1.2, side > 0 ? 3 : 8, rng()));
        const p = P(s, lat);
        if (field.wallClearance(p.x, p.z) < 0.9 || (side > 0 && L.coast.query(p.x, p.z).sd < 1.5)) continue;
        if (ctx.exclusions.some(([ex, ez, er]) => Math.hypot(p.x - ex, p.z - ez) < er)) continue;
        roses.push([p.x, field.surfaceHeight(p.x, p.z) - 0.05, p.z, rng() * 6.28, lerp(0.5, 0.8, rng()), field.wallClearance(p.x, p.z), 0.6]);
      }
    }
  }
}

// Bird Rock offshore + tide-pool rocks in the coves.
function buildRocks(ctx, field, L, rockSpots, bucket, rng) {
  const { track } = ctx;
  const br = L.seg('Bird Rock Bend');
  if (br) {
    const s = (br.s0 + br.s1) / 2, f = track.frameAt(s);
    let lat = f.wallR + 40, p = null;
    for (; lat < f.wallR + 110; lat += 4) {
      const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
      if (L.coast.query(x, z).sd < -26) { p = { x, z }; break; }
    }
    if (p) {
      const g = lumpy(new THREE.DodecahedronGeometry(9, 1), 0.28, 1.25, 1.05, 1.0, 21).toNonIndexed();
      faceColors(g, (y, ny) => (y > 5.5 && ny > 0.3 ? 0xf2efe6 : y > 3.5 ? mixHex(0x9a8a72, 0xcfc6b4, 0.4) : 0x7d7062));
      g.computeVertexNormals();
      bucket.push(paint(place(g, p.x, LEVEL + 1.0, p.z, 0.4), null));
      for (let k = 0; k < 4; k++) {
        const a = rng() * 6.28, r = lerp(12, 20, rng());
        const sg = lumpy(new THREE.DodecahedronGeometry(lerp(2, 3.5, rng()), 0), 0.3, 1.2, 0.8, 1, k * 7).toNonIndexed();
        faceColors(sg, (y) => (y > 1.2 ? 0xe9e4d8 : 0x7d7062));
        bucket.push(paint(place(sg, p.x + Math.cos(a) * r, LEVEL + 0.2, p.z + Math.sin(a) * r, a), null));
      }
      ctx.landmarks.push({ name: 'birdRock', x: p.x, z: p.z, r: 11, h: 12 });
    }
  }
  // tide-pool rocks along the cove shelf (below the cliffs)
  for (let k = 0; k < L.coast.pts.length - 1; k++) {
    const a = L.coast.pts[k];
    if (a.cliff < 0.6 || rng() < 0.45) continue;
    for (let j = 0; j < 2; j++) {
      const x = a.x + (rng() - 0.5) * 16, z = a.z + (rng() - 0.5) * 16;
      const q = L.coast.query(x, z);
      if (q.sd > -2 || q.sd < -24) continue;
      const sc = lerp(0.8, 2.6, rng());
      if (field.wallClearance(x, z) < sc + 0.8) continue;
      const g = field.surfaceHeight(x, z);
      rockSpots.push([x, Math.max(g, LEVEL - 1.2) - 0.2, z, rng() * 6.28, sc, 99, sc]);
    }
  }
}

// A few sailboats bobbing offshore (one instanced draw call).
function buildSailboats(ctx, L, rng) {
  const n = ctx.Q.veg >= 1 ? 7 : 3;
  const hull = mergeParts([
    paint(lumpy(new THREE.BoxGeometry(2.2, 0.9, 7, 1, 1, 3), 0.1, 1, 1, 1, 3).translate(0, 0.3, 0), 0xffffff),
    box(0.12, 9, 0.12, 0, 5, 0.6, 0xdddddd),
    tris([0, 1.2, 0.8, 0, 9.4, 0.7, 0, 1.2, 3.8, 0, 1.2, 0.8, 0, 1.2, 3.8, 0, 9.4, 0.7], 0xfdfaf0),
    tris([0, 1.2, 0.4, 0, 7.5, 0.5, 0, 1.2, -2.6, 0, 1.2, 0.4, 0, 1.2, -2.6, 0, 7.5, 0.5], 0xf2f2f2),
  ]);
  const inst = new THREE.InstancedMesh(hull, ctx.M.structure, n);
  const boats = [];
  const pts = L.coast.pts;
  for (let k = 0; k < n; k++) {
    const a = pts[Math.floor(pts.length * (0.35 + 0.5 * rng()))];
    const off = lerp(140, 420, rng());
    boats.push({ x: a.x + off * 0.97, z: a.z + (rng() - 0.5) * 200, yaw: rng() * 6.28, ph: rng() * 6 });
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p3 = new THREE.Vector3(), s3 = new THREE.Vector3(1, 1, 1);
  const upd = (t) => {
    boats.forEach((b, i) => {
      e.set(Math.sin(t * 0.9 + b.ph) * 0.05, b.yaw, Math.sin(t * 0.7 + b.ph) * 0.08, 'YXZ');
      inst.setMatrixAt(i, m4.compose(p3.set(b.x, LEVEL + Math.sin(t * 1.1 + b.ph) * 0.15, b.z), q.setFromEuler(e), s3));
    });
    inst.instanceMatrix.needsUpdate = true;
  };
  upd(0);
  inst.frustumCulled = false;
  ctx.add(inst, { name: 'Sailboats' });
  ctx.animators.push((dt, t) => upd(t));
}

// Canyon hills inland and hazy coastal ranges.
function buildHills(ctx, L) {
  const rng = makeRng(515);
  const geos = [];
  const { x: cx, z: cz } = L.center;
  const hill = (x, z, r, h, seg) => geos.push(mountainGeometry(x, z, r, h, seg, (t, ny, y) => {
    if (ny < 0.5) return mixHex(0x9a9466, 0x8a8a5c, hash2(Math.round(y * 2), 5));
    return mixHex(0xb8ad74, 0x7f965a, hash2(Math.round(y * 3), 9) * 0.8);
  }));
  const far = (x, z, r, h, seg) => geos.push(mountainGeometry(x, z, r, h, seg, (t, ny, y) => mixHex(0xb5a8b8, 0xc7b8c0, hash2(Math.round(y), 7))));
  // inland arc (west + north + south-west), none over the sea (east)
  for (let k = 0; k < 24; k++) {
    const a = Math.PI * 0.45 + (k / 24) * Math.PI * 1.1 + (rng() - 0.5) * 0.12;
    const r = lerp(520, 820, rng()), h = lerp(70, 160, rng());
    hill(cx + Math.cos(a) * r - 120, cz + Math.sin(a) * r, h * lerp(2.4, 3.2, rng()), h, 9);
  }
  for (let k = 0; k < 14; k++) {
    const a = Math.PI * 0.5 + (k / 14) * Math.PI + (rng() - 0.5) * 0.2;
    const r = lerp(1150, 1450, rng()), h = lerp(160, 280, rng());
    far(cx + Math.cos(a) * r - 200, cz + Math.sin(a) * r, h * lerp(1.8, 2.3, rng()), h, 8);
  }
  addMerged(ctx, geos, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), { name: 'Hills' });
}

// ------------------------------------------------------------------ vegetation

function palmGeometry() {
  const parts = [];
  // curved trunk: stacked tapered segments leaning over
  let x = 0, y = 0;
  for (let k = 0; k < 6; k++) {
    const h = 1.6, lean = 0.06 + k * 0.03;
    parts.push(paint(place(new THREE.CylinderGeometry(0.2 - k * 0.012, 0.24 - k * 0.012, h + 0.05, 6, 1, true), x + Math.sin(lean) * h / 2, y + h / 2, 0, 0, 0, -lean), k % 2 ? C.palmTrunk : mixHex(C.palmTrunk, 0x7a5a3a, 0.4)));
    x += Math.sin(lean) * h; y += Math.cos(lean) * h;
  }
  parts.push(ball(0.38, x, y + 0.1, 0, 0x7a6a3a));
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + 0.2;
    const len = 3.2;
    const tip = [x + Math.cos(a) * len, y - 1.0, Math.sin(a) * len], mid = [x + Math.cos(a) * len * 0.5, y + 0.7, Math.sin(a) * len * 0.5];
    const sx = -Math.sin(a) * 0.55, sz = Math.cos(a) * 0.55;
    const col = k % 2 ? C.palmLeaf : mixHex(C.palmLeaf, 0x7fbf54, 0.35);
    parts.push(tris([
      x, y + 0.2, 0, mid[0] + sx, mid[1], mid[2] + sz, mid[0] - sx, mid[1], mid[2] - sz,
      mid[0] + sx, mid[1], mid[2] + sz, tip[0], tip[1], tip[2], mid[0] - sx, mid[1], mid[2] - sz,
      x, y + 0.2, 0, mid[0] - sx, mid[1], mid[2] - sz, mid[0] + sx, mid[1], mid[2] + sz,
      mid[0] + sx, mid[1], mid[2] + sz, mid[0] - sx, mid[1], mid[2] - sz, tip[0], tip[1], tip[2],
    ], col));
  }
  return mergeParts(parts);
}

function buildLagunaVegetation(ctx, field, L, placer, nearest, inside, extra, rng) {
  const { track, Q } = ctx;
  const Vg = Q.veg;
  const palm = palmGeometry();
  const pine = mergeParts([   // Torrey pine: gnarled, wide open crown
    paint(place(new THREE.CylinderGeometry(0.3, 0.5, 5, 6, 1, true), 0.4, 2.5, 0, 0, 0, -0.15), 0x6b5038),
    paint(place(new THREE.CylinderGeometry(0.18, 0.26, 3.4, 5, 1, true), -1.2, 5.2, 0, 0, 0, 0.7), 0x6b5038),
    paint(lumpy(new THREE.IcosahedronGeometry(2.8, 0), 0.3, 1.3, 0.5, 1.1, 5).translate(1.2, 6.2, 0), C.pine),
    paint(lumpy(new THREE.IcosahedronGeometry(2.2, 0), 0.3, 1.2, 0.5, 1.1, 9).translate(-2.4, 6.4, 0.6), mixHex(C.pine, 0x5d9a5a, 0.3)),
  ]);
  const jacaranda = mergeParts([
    paint(place(new THREE.CylinderGeometry(0.2, 0.32, 3.2, 6, 1, true), 0, 1.6, 0), 0x6b4a32),
    paint(lumpy(new THREE.IcosahedronGeometry(2.6, 0), 0.28, 1.3, 0.7, 1.2, 4).translate(0, 4.4, 0), C.jacaranda),
    paint(lumpy(new THREE.IcosahedronGeometry(1.8, 0), 0.28, 1.2, 0.7, 1.2, 8).translate(1.5, 3.8, 0.8), mixHex(C.jacaranda, 0xb9a0ef, 0.4)),
  ]);
  const bougain = mergeParts([
    paint(lumpy(new THREE.IcosahedronGeometry(1.1, 0), 0.3, 1.2, 0.9, 1.2, 3).translate(0, 0.7, 0), C.bougain),
    paint(lumpy(new THREE.IcosahedronGeometry(0.8, 0), 0.3, 1.2, 0.9, 1.2, 7).translate(0.8, 0.5, 0.3), 0x4f8f3a),
  ]);
  const shrub = mergeParts([
    paint(lumpy(new THREE.IcosahedronGeometry(1.0, 0), 0.3, 1.3, 0.7, 1.3, 5).translate(0, 0.4, 0), 0x6f8f4a),
    paint(lumpy(new THREE.IcosahedronGeometry(0.7, 0), 0.3, 1.2, 0.8, 1.2, 9).translate(0.7, 0.35, 0.3), 0x8a9a56),
  ]);
  const roseG = mergeParts([
    paint(lumpy(new THREE.IcosahedronGeometry(0.7, 0), 0.3, 1.2, 0.8, 1.2, 4).translate(0, 0.5, 0), 0x4f8a3e),
    ...[[0.3, 0.95, 0.1], [-0.35, 0.9, -0.1], [0.05, 1.05, -0.35], [-0.1, 0.92, 0.38]].map(([x, y, z]) => paint(new THREE.IcosahedronGeometry(0.17, 0).translate(x, y, z), 0xffffff)),
  ]);
  const rock = paint(lumpy(new THREE.DodecahedronGeometry(1.0, 0), 0.35, 1.2, 0.72, 1, 3), C.rock);
  const inExcl = (x, z, r) => ctx.exclusions.some(([ex, ez, er]) => (x - ex) * (x - ex) + (z - ez) * (z - ez) < (er + r * 0.5) ** 2);
  const spot = (x, z, r, sc, sink, extraClr = 1.0) => {
    const rr = r * sc, clr = field.wallClearance(x, z);
    if (!(clr > rr + extraClr)) return null;
    if (placer.near(x, z, rr + 0.6) || inExcl(x, z, rr)) return null;
    if (L.coast.query(x, z).sd < 3) return null;
    return [x, field.surfaceHeight(x, z) - sink, z, rng() * Math.PI * 2, sc, clr, rr];
  };
  const b = track.bounds, ext = 220;
  const pick = (count, accept) => {
    const out = [];
    for (let tries = 0; out.length < count && tries < count * 50; tries++) {
      const x = lerp(b.minX - ext, b.maxX + ext * 0.5, rng()), z = lerp(b.minZ - ext, b.maxZ + ext, rng());
      const r = accept(x, z);
      if (r) out.push(r);
    }
    return out;
  };
  // palms: village / gallery row sidewalks + scattered in town and parks
  const palms = [...extra.palms];
  for (const z of L.Z.village || []) {
    const len = track.forwardDistance(z.s0, z.s1);
    for (let d = 8; d < len; d += Vg >= 1 ? 16 : 26) {
      for (const side of [-1, 1]) {
        const f = track.frameAt(z.s0 + d), wall = side > 0 ? f.wallR : f.wallL;
        const lat2 = side * (wall + 0.9), x2 = f.x + f.right.x * lat2, z2 = f.z + f.right.z * lat2;
        const p = spot(x2, z2, 0.5, lerp(1.0, 1.3, rng()), 0.1, 0.2);
        if (p) palms.push(p);
      }
    }
  }
  palms.push(...pick(Math.round(70 * Vg), (x, z) => (nearest(x, z).d < 120 ? spot(x, z, 0.5, lerp(0.9, 1.35, rng()), 0.1) : null)));
  const pines = pick(Math.round(28 * Vg), (x, z) => (x < -40 && nearest(x, z).d < 220 ? spot(x, z, 3.0, lerp(0.8, 1.2, rng()), 0.2) : null));
  if (L.hairpin) {   // the lone Torrey pine inside the Crest Hairpin
    const H = L.hairpin, p = spot(H.x - 2, H.z + 1, 3.0, 1.15, 0.2, 0.5);
    if (p) pines.push(p);
  }
  const jacas = pick(Math.round(40 * Vg), (x, z) => {
    const nr = nearest(x, z);
    return nr.d < 90 && (inside(x, z) || x < 0) ? spot(x, z, 2.6, lerp(0.8, 1.15, rng()), 0.2) : null;
  });
  const bougains = pick(Math.round(90 * Vg), (x, z) => (nearest(x, z).d < 60 ? spot(x, z, 1.1, lerp(0.7, 1.2, rng()), 0.1, 0.4) : null));
  const shrubs = pick(Math.round(160 * Vg), (x, z) => (x < -30 ? spot(x, z, 1.0, lerp(0.8, 1.6, rng()), 0.1) : null));
  addInstancedSet(ctx, 'Palms', palm, palms, rng, { near: 30, stretch: [0.9, 1.25] });
  addInstancedSet(ctx, 'Pines', pine, pines, rng, { near: 30 });
  addInstancedSet(ctx, 'Jacarandas', jacaranda, jacas, rng, { near: 30 });
  addInstancedSet(ctx, 'Bougainvillea', bougain, bougains, rng, { near: 18, tints: [0xffffff, 0xffe0f0, 0xffffff, 0xfff0d0], tint: [0.9, 1.1] });
  addInstancedSet(ctx, 'Shrubs', shrub, shrubs, rng, { near: 0 });
  addInstancedSet(ctx, 'Roses', roseG, extra.roses, rng, { near: 0, tints: [0xff3a5a, 0xff8ab0, 0xffffff, 0xffd23a, 0xff5a3a], tint: [0.95, 1.05] });
  addInstancedSet(ctx, 'Rocks', rock, extra.rocks, rng, { near: 0, tints: [0xd9c4a0, 0xb8a888, 0x9a8a78], tint: [0.9, 1.1] });
  addInstancedSet(ctx, 'Eucalyptus', eucalyptusGeometry(), extra.eucs || [], rng, { near: 30, tints: [0xffffff, 0xe8f0e0, 0xf4f0e6], tint: [0.9, 1.08], stretch: [0.9, 1.2] });
}

// ------------------------------------------------------------------ canyon, festival, tide pools, easels

// Eucalyptus: a tall pale trunk with bark patches leaning a little, two
// branches and loose, drooping blue-green crowns.
function eucalyptusGeometry() {
  return mergeParts([
    paint(place(new THREE.CylinderGeometry(0.22, 0.42, 9, 6, 1, true), 0.25, 4.5, 0, 0, 0, -0.06), C.eucaTrunk),
    paint(place(new THREE.CylinderGeometry(0.43, 0.45, 1.6, 6, 1, true), 0.05, 1.6, 0, 0.5, 0, -0.06), C.eucaBark),
    paint(place(new THREE.CylinderGeometry(0.1, 0.18, 4.2, 5, 1, true), -1.1, 7.6, 0.3, 0, 0.4, 0.55), C.eucaTrunk),
    paint(place(new THREE.CylinderGeometry(0.1, 0.16, 3.6, 5, 1, true), 1.5, 8.0, -0.2, 0, -0.3, -0.6), C.eucaTrunk),
    paint(lumpy(new THREE.IcosahedronGeometry(2.3, 0), 0.32, 1.1, 1.35, 1.0, 13).translate(0.6, 10.6, 0), C.eucaLeaf),
    paint(lumpy(new THREE.IcosahedronGeometry(1.8, 0), 0.32, 1.0, 1.4, 1.0, 17).translate(-2.3, 9.4, 0.6), C.eucaLeafAlt),
    paint(lumpy(new THREE.IcosahedronGeometry(1.7, 0), 0.32, 1.0, 1.4, 1.0, 19).translate(2.8, 9.6, -0.4), mixHex(C.eucaLeaf, 0x5f7a5a, 0.4)),
  ]);
}

// A white festival tent (local +z = front): four posts, a peaked roof with a
// coloured valance, a counter and a few framed pieces on the back wall.
function tentGeometry(trim, art) {
  const W = 3.6, H = 2.3, parts = [];
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) parts.push(box(0.08, H, 0.08, x * W / 2, H / 2, z * W / 2, 0xe8e8e8));
  parts.push(paint(place(new THREE.ConeGeometry(W * 0.74, 1.3, 4, 1), 0, H + 0.65, 0, Math.PI / 4), C.tent));
  for (const z of [-1, 1]) parts.push(box(W, 0.32, 0.03, 0, H - 0.14, z * W / 2, trim));
  for (const x of [-1, 1]) parts.push(box(0.03, 0.32, W, x * W / 2, H - 0.14, 0, trim));
  parts.push(box(W, H - 0.3, 0.04, 0, (H - 0.3) / 2, -W / 2 + 0.02, 0xf6f4ec));          // back wall
  parts.push(box(W * 0.8, 0.9, 0.6, 0, 0.45, W / 2 - 0.5, 0xd8c8a8));                     // counter
  art.forEach((c, k) => parts.push(box(0.75, 0.6, 0.04, -1.1 + k * 1.1, 1.45, -W / 2 + 0.07, c)));
  return mergeParts(parts);
}

function buildCanyon(ctx, field, L, bucket, rng, nearest, eucs) {
  const { track } = ctx;
  const fl = L.flats[0];
  if (fl) {
    // the festival lot: two rows of tents facing a central aisle, three
    // abstract sculptures, a white picket fence + gate toward the road
    const ca = Math.cos(fl.yaw), sa = Math.sin(fl.yaw);
    const at = (u, w) => ({ x: fl.x + sa * u + ca * w, z: fl.z + ca * u - sa * w });   // u along the road, w across
    const trims = [0xe8475f, 0x2f8fc8, 0xf2a03a, 0x3d9a6a, 0x9a6ad8, 0xff8ac8];
    const arts = [0x2f8fc8, 0xf2b43a, 0xe8475f, 0x5fb8a8, 0xfdf8ec, 0x6a4a9a, 0xff8a5a];
    for (let k = 0; k < (ctx.Q.veg >= 1 ? 10 : 6); k++) {
      const row = k % 2 ? 1 : -1, u = -10 + Math.floor(k / 2) * 5;
      const p = at(u, row * 5.2);
      const geo = tentGeometry(trims[k % trims.length], [arts[k % 7], arts[(k + 3) % 7], arts[(k + 5) % 7]]);
      place(geo, p.x, fl.h - 0.05, p.z, fl.yaw + (row > 0 ? -Math.PI / 2 : Math.PI / 2));
      bucket.push(geo);
      ctx.prop('tent', p.x, p.z, 2.6);
    }
    // sculptures: stacked tumbling cubes, a big ring on a plinth, a slab spiral
    {
      const p = at(-14, 0);
      const parts = [box(1.6, 1.6, 1.6, 0, 0.8, 0, 0xe8475f, 0.3)];
      parts.push(box(1.2, 1.2, 1.2, 0.2, 2.15, 0, 0xf2b43a, 0.9, 0.3, 0.2));
      parts.push(box(0.9, 0.9, 0.9, -0.1, 3.2, 0.1, 0x2f8fc8, 0.2, 0.6, 0.5));
      const geo = mergeParts(parts); place(geo, p.x, fl.h, p.z, 0.4); bucket.push(geo); ctx.prop('sculpture', p.x, p.z, 1.2);
    }
    {
      const p = at(14, 0);
      const parts = [box(1.8, 0.8, 1.2, 0, 0.4, 0, 0xd9d2c4), paint(new THREE.TorusGeometry(1.5, 0.28, 6, 18).translate(0, 2.35, 0), 0x3d9a6a)];
      const geo = mergeParts(parts); place(geo, p.x, fl.h, p.z, fl.yaw); bucket.push(geo); ctx.prop('sculpture', p.x, p.z, 1.6);
    }
    {
      const p = at(2, -1.5), parts = [];
      for (let k = 0; k < 7; k++) parts.push(box(2.0 - k * 0.15, 0.32, 0.6, 0, 0.2 + k * 0.42, 0, k % 2 ? 0xfdf8ec : 0xf28ab8, k * 0.42));
      const geo = mergeParts(parts); place(geo, p.x, fl.h, p.z, 0); bucket.push(geo); ctx.prop('sculpture', p.x, p.z, 1.1);
    }
    // picket fence along the road side with a gate arch (no text)
    {
      const parts = [];
      const len = fl.r * 2 + 2;
      for (let u = -len / 2; u <= len / 2; u += 0.5) parts.push(box(0.09, 0.95, 0.06, u, 0.48, 0, 0xfbfaf4));
      for (const y of [0.35, 0.78]) parts.push(box(len, 0.08, 0.05, 0, y, -0.04, 0xfbfaf4));
      for (const u of [-1.8, 1.8]) parts.push(box(0.22, 3.0, 0.22, u, 1.5, 0, 0xfbfaf4));
      parts.push(paint(new THREE.TorusGeometry(1.8, 0.12, 4, 14, Math.PI).translate(0, 3.0, 0), 0x2f8fc8));
      for (let k = 0; k < 7; k++) parts.push(box(0.5, 0.35, 0.03, -1.5 + k * 0.5, 2.6 + Math.sin((k / 6) * Math.PI) * 1.0, 0.05, trims[k % trims.length]));   // bunting flags
      const geo = mergeParts(parts);
      // the fence runs along the field's road-facing edge
      const f = track.frameAt(fl.s), towardRoad = { x: f.x - fl.x, z: f.z - fl.z }, tl = Math.hypot(towardRoad.x, towardRoad.z) || 1;
      const fx = fl.x + (towardRoad.x / tl) * (fl.r + 1), fz = fl.z + (towardRoad.z / tl) * (fl.r + 1);
      if (field.wallClearance(fx, fz) > 2) {
        place(geo, fx, fl.h - 0.05, fz, Math.atan2(towardRoad.x, towardRoad.z));
        bucket.push(geo);
        ctx.prop('fence', fx, fz, 0.2);
      }
    }
    ctx.exclusions.push([fl.x, fl.z, fl.r + 2]);
    ctx.landmarks.push({ name: 'festival', x: fl.x, z: fl.z, r: fl.r, h: 4 });
  }
  // eucalyptus groves lining the canyon road (both sides, gaps for the views)
  if (L.canyonS) {
    const [a, b] = L.canyonS;
    for (let s = a - 30; s < b + 10; s += ctx.Q.veg >= 1 ? 7 : 13) {
      if (Math.sin(s * 0.045) < -0.35) continue;                       // gaps
      const f = track.frameAt(s);
      for (const side of [-1, 1]) {
        const lat = side * ((side > 0 ? f.wallR : f.wallL) + lerp(3.5, 16, rng()));
        const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
        const clr = field.wallClearance(x, z);
        if (clr < 3.2 || ctx.exclusions.some(([ex, ez, er]) => Math.hypot(x - ex, z - ez) < er + 2)) continue;
        eucs.push([x, field.surfaceHeight(x, z) - 0.2, z, rng() * 6.28, lerp(0.85, 1.25, rng()), clr, 2.6]);
      }
    }
  }
}

// The tide-pool shelf: a sandstone sea arch off the ledge, boulders, starfish
// and anemones on the wet rock past the fence (scenery: a protected reserve).
function buildTidePools(ctx, field, L, bucket, rng) {
  const { track } = ctx;
  const tz = L.tidepools;
  if (!tz) return;
  const mid = (tz.s0 + tz.s1) / 2, f = track.frameAt(mid);
  // the arch: two lumpy pillars + a lintel, standing in the shallows
  let lat = f.wallR + 12, p = null;
  for (; lat < f.wallR + 50; lat += 1.5) {
    const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
    if (L.coast.query(x, z).sd < -7) { p = { x, z }; break; }
  }
  if (p) {
    const ss = (g, cTop, cLow) => { const q = g.toNonIndexed(); faceColors(q, (y) => (y > 3.6 ? cTop : y > 1.2 ? mixHex(cTop, cLow, 0.4) : cLow)); q.computeVertexNormals(); return paint(q, null); };
    const parts = [
      ss(lumpy(new THREE.DodecahedronGeometry(1, 1), 0.24, 2.5, 4.6, 2.4, 31).translate(-4.6, 3.6, 0), C.sandstone, 0x6e6458),
      ss(lumpy(new THREE.DodecahedronGeometry(1, 1), 0.24, 2.7, 4.2, 2.6, 37).translate(4.4, 3.3, 0.4), C.sandstone, 0x6e6458),
      ss(lumpy(new THREE.IcosahedronGeometry(1, 1), 0.2, 7.4, 1.7, 2.5, 41).translate(0, 7.6, 0.2), C.sandstoneDark, C.sandstone),
      ss(lumpy(new THREE.DodecahedronGeometry(1, 0), 0.3, 2.2, 1.2, 1.8, 43).translate(1.0, 0.2, 2.4), 0x6e6458, 0x6e6458),
    ];
    const geo = mergeParts(parts);
    place(geo, p.x, LEVEL - 1.0, p.z, Math.atan2(f.tangent.x, f.tangent.z) + 0.3);
    bucket.push(geo);
    ctx.landmarks.push({ name: 'seaArch', x: p.x, z: p.z, r: 7, h: 9 });
  }
  // starfish + anemones on the shelf between the fence and the water
  const star = (r, col) => {
    const pts = [];
    for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2, rr = k % 2 ? r * 0.42 : r; pts.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
    const arr = [];
    for (let k = 0; k < 10; k++) { const [x0, z0] = pts[k], [x1, z1] = pts[(k + 1) % 10]; arr.push(0, 0.06, 0, x1, 0.02, z1, x0, 0.02, z0); }
    return tris(arr, col);
  };
  const n = ctx.Q.veg >= 1 ? 22 : 10;
  for (let k = 0; k < n; k++) {
    const s = lerp(tz.s0 - 10, tz.s1 + 8, rng()), fs = track.frameAt(s);
    const la = fs.wallR + lerp(1.0, 7, rng());
    const x = fs.x + fs.right.x * la, z = fs.z + fs.right.z * la;
    if (L.coast.query(x, z).sd < 0.6 || field.wallClearance(x, z) < 0.6) continue;
    const g = field.surfaceHeight(x, z);
    if (k % 3) bucket.push(place(star(lerp(0.32, 0.5, rng()), [0xff7a2a, 0xa04ad0, 0xff4a6a][k % 3]), x, g + 0.02, z, rng() * 6.28));
    else bucket.push(mergeParts([cyl(0.28, 0.34, 0.16, 8, x, g + 0.08, z, 0x3fa070), cyl(0.12, 0.16, 0.06, 8, x, g + 0.19, z, 0xff5aa0)]));
  }
}

// Plein-air painters' easels along the Forest Avenue chicane (sidewalks).
function easelGeometry(sky, sand) {
  return mergeParts([
    box(0.06, 1.8, 0.06, -0.35, 0.9, 0, 0x8a5a34, 0, 0.15), box(0.06, 1.8, 0.06, 0.35, 0.9, 0, 0x8a5a34, 0, 0.15),
    box(0.06, 1.7, 0.06, 0, 0.85, -0.45, 0x8a5a34, 0, -0.35), box(0.9, 0.7, 0.04, 0, 1.45, 0.08, 0xfdf8ec, 0, 0.15),
    box(0.7, 0.5, 0.02, 0, 1.45, 0.11, sky, 0, 0.15), box(0.7, 0.18, 0.02, 0, 1.28, 0.12, sand, 0, 0.15),
  ]);
}
function buildEasels(ctx, field, L, bucket, rng) {
  const { track } = ctx;
  const a = L.seg('Forest Chicane A'), b = L.seg('Gallery Walk');
  if (!a || !b) return;
  const pal = [[0x6fb1e0, 0xf2b46a], [0x2f8fc8, 0xe8c27a], [0xf2a08a, 0x5f9ad8], [0x8fd0c8, 0xd8a85a]];
  let k = 0;
  for (let s = a.s0 + 4; s < b.s1 - 4 && k < 6; s += 13) {
    const f = track.frameAt(s), side = k % 2 ? 1 : -1;
    const lat = side * ((side > 0 ? f.wallR : f.wallL) + 1.4);
    const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
    if (field.wallClearance(x, z) < 1.0 || ctx.exclusions.some(([ex, ez, er]) => Math.hypot(x - ex, z - ez) < er)) continue;
    const geo = easelGeometry(...pal[k % pal.length]);
    place(geo, x, field.surfaceHeight(x, z), z, Math.atan2(-f.right.x * side, -f.right.z * side) + (rng() - 0.5) * 0.6);
    bucket.push(geo);
    ctx.prop('easel', x, z, 0.5);
    ctx.exclusions.push([x, z, 1.2]);
    k++;
  }
}

// Sand piled against the fences beside the tower jump (the "berm").
function buildTowerBerm(ctx, field, L, bucket) {
  const { track } = ctx;
  const r = track.ramps.find((rp) => L.tower && track.forwardDistance(L.tower.s0 - 10, rp.s0) < 20);
  if (!r) return;
  for (const side of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const s = r.s0 - 6 + k * 4.5, f = track.frameAt(s);
      const lat = side * ((side > 0 ? f.wallR : f.wallL) + 1.6 + (k % 2) * 0.8);
      const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
      if (field.wallClearance(x, z) < 1.0) continue;
      const g = lumpy(new THREE.SphereGeometry(1.6, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), 0.25, 1.4, 0.5 + (k % 2) * 0.25, 1, k + 3);
      bucket.push(paint(place(g, x, field.surfaceHeight(x, z) - 0.15, z, f.yaw), mixHex(C.sand, 0xd8b878, (k % 3) * 0.3)));
      ctx.prop('sand', x, z, 1.6);
    }
  }
}

// Warning signs (icons only) before each set piece / jump: one merged mesh.
function buildWarningSigns(ctx, field, L, hz) {
  const { track } = ctx;
  const spots = [];
  for (const h of hz.list) {
    const icon = h.type === 'surge' ? 0 : h.type === 'lob' ? 1 : 2;
    spots.push([h.s - 48, icon]);
  }
  for (const r of track.ramps) spots.push([r.s0 - 42, 3]);
  const faces = [], posts = [];
  for (const [s, icon] of spots) {
    const f = track.frameAt(s);
    const lat = -(f.wallL + 1.3);
    const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
    if (field.wallClearance(x, z) < 0.8) continue;
    const g = field.surfaceHeight(x, z);
    const yaw = f.yaw + Math.PI;          // faces the oncoming karts
    posts.push(box(0.12, 2.4, 0.12, x, g + 1.2, z, 0x8a8f96));
    const q = new THREE.PlaneGeometry(1.7, 1.7);
    const [u0, v0] = PICTO[icon], uv = q.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.5, v0 + uv.getY(i) * 0.5);
    q.rotateZ(Math.PI / 4).scale(0.72, 0.72, 1);
    faces.push(place(q, x, g + 2.75, z, yaw));
    const back = new THREE.PlaneGeometry(1.25, 1.25).rotateZ(Math.PI / 4);
    const bu = back.attributes.uv; for (let i = 0; i < bu.count; i++) bu.setXY(i, 0.02, 0.02);   // a plain grey corner of the atlas
    faces.push(place(back, x, g + 2.75, z, yaw + Math.PI));
    ctx.prop('sign', x, z, 0.3);
  }
  return { faces, posts };
}

// ------------------------------------------------------------------ painted road details (one atlas, one draw call)

function atlasStrip(ctx, name, s0, s1, latA, latB, { tile = 6, dy = 0.013, step = 1, flip = false } = {}) {
  const [u0, u1] = LAGUNA_DECALS[name];
  return trackStrip(ctx.track, sRange(s0, s1, step), 2, (f, s, c, o) => {
    o.lat = c ? latB(f, s) : latA(f, s); o.dy = dy;
    o.u = (c ? !flip : flip) ? u1 : u0; o.v = (s - s0) / tile;
  });
}

function buildLagunaDecals(ctx, L, hz) {
  const { track } = ctx;
  const out = [];
  const Lt = track.length;
  const segS = (name) => L.seg(name);
  // centre lines: dashed white through the village, double yellow on the canyon / coast road
  const vill1 = [6, segS('Coast Highway') ? segS('Coast Highway').s1 : 85];
  const vill2 = [segS('Gallery Row') ? segS('Gallery Row').s0 : 1182, Lt - 38];
  for (const [a, b] of [vill1, vill2]) out.push(atlasStrip(ctx, 'dash', a, b, () => -0.14, () => 0.14, { tile: 9, step: 2 }));
  const yA = vill1[1] + 2, br = L.bridge, tp = L.tidepools;
  const yellow = [[yA, br ? br.s0 - 1 : 750], [br ? br.s1 + 1 : 790, tp ? tp.s0 - 2 : 890]];
  for (const [a, b] of yellow) out.push(atlasStrip(ctx, 'yellow', a, b, () => -0.3, () => 0.3, { tile: 8, step: 2 }));
  // crosswalks: zebra bars across the village roads
  const crosswalk = (s) => {
    const f = track.frameAt(s);
    for (let lat = -f.halfWidth + 1.6; lat <= f.halfWidth - 1.6; lat += 1.25) {
      out.push(atlasStrip(ctx, 'cross', s, s + 3.2, () => lat - 0.32, () => lat + 0.32, { tile: 3.2, step: 0.8, dy: 0.016 }));
    }
  };
  const gal = segS('Gallery Row'), coast = segS('Coast Highway');
  if (coast) crosswalk(coast.s1 - 14);
  if (gal) { crosswalk(gal.s0 + 12); crosswalk(gal.s1 - 10); }
  // green bike lanes along Gallery Row and the Coast Highway
  for (const sg of [gal, coast]) {
    if (!sg) continue;
    const a = sg.s0 + (sg === coast ? 8 : 20), b = sg.s1 - (sg === coast ? 18 : 14);
    for (const side of [-1, 1]) {
      out.push(atlasStrip(ctx, 'bike', a, b, (f) => side * (f.halfWidth - 2.6), (f) => side * (f.halfWidth - 1.0), { tile: 14, step: 2, flip: side < 0 }));
    }
  }
  // the beach road: wind-blown sand along both edges (thick at the edge)
  const Bz = L.beach;
  if (Bz) {
    out.push(atlasStrip(ctx, 'drift', Bz.s0 - 6, Bz.s1 + 4, (f) => -f.halfWidth + 3.2, (f) => -f.halfWidth, { tile: 14, step: 2, dy: 0.018 }));
    out.push(atlasStrip(ctx, 'drift', Bz.s0 - 6, Bz.s1 + 4, (f) => f.halfWidth - 3.2, (f) => f.halfWidth, { tile: 11, step: 2, dy: 0.018 }));
    // sand on the sea-side verge (curb to fence)
    out.push(atlasStrip(ctx, 'sand', Bz.s0 + 2, Bz.s1 - 2, (f) => f.halfWidth + 1.0, (f) => f.wallR + 0.5, { tile: 9, step: 2, dy: 0.012 }));
  }
  // the tide-pool rock shelf along the sea-side verge, and the wet rock the
  // road crosses round each blowhole (irregular caps, not a rectangle)
  if (tp) out.push(atlasStrip(ctx, 'rock', tp.s0 - 6, tp.s1 + 4, (f) => f.halfWidth + 1.0, (f) => f.wallR + 0.5, { tile: 9, step: 1, dy: 0.012 }));
  const [ru0, ru1] = LAGUNA_DECALS.rock;
  for (const h of hz.list) {
    if (h.type !== 'jet') continue;
    h.lats.forEach((lat, k) => {
      const f = track.frameAt(h.s), c = track.pointAt(h.s, lat);
      const R = h.radius + 1.6, seg = 22, pos = [c.x, f.y + 0.014, c.z], uv = [(ru0 + ru1) / 2, 0.5];
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2, r = R * (0.78 + 0.22 * Math.sin(j * 2.3 + k * 1.7) * Math.cos(j * 1.1 + k));
        const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
        pos.push(x, track.frameAt(h.s + (x - c.x) * f.tangent.x + (z - c.z) * f.tangent.z).y + 0.014, z);
        uv.push(lerp(ru0, ru1, 0.5 + 0.5 * Math.cos(a) * r / (R * 1.05)), 0.5 + 0.5 * Math.sin(a) * r / 9);
      }
      const idx = [];
      for (let j = 1; j <= seg; j++) idx.push(0, j + 1, j);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      out.push(g);
    });
  }
  // ice plant on the bluff verges
  for (const z of L.Z.bluff || []) {
    for (const side of [-1, 1]) {
      out.push(atlasStrip(ctx, 'ice', z.s0 + 2, z.s1 - 2, (f) => side * (f.halfWidth + 1.0), (f) => side * ((side > 0 ? f.wallR : f.wallL) + 0.5), { tile: 7, step: 2, dy: 0.012 }));
    }
  }
  return out;
}

// ------------------------------------------------------------------ buildLagunaWorld

export function buildLagunaWorld(scene, track, opts = {}) {
  const ctx = createWorldContext(scene, track, opts);
  const { Q } = ctx, sp = track.spacing;
  const L = lagunaLayout(track);
  const hz = createHazards(track);              // hazards/beach.js (main.js runs the clock in races)
  L.hz = hz;
  L.coast = coastLine(track, L);
  const rng = makeRng(1937);
  const nearest = makeNearest(track, 2);
  const inside = makeLoopInside(track, 6);
  {
    const a = L.seg('Canyon Esses A'), b = L.seg('Canyon Climb');
    if (a && b) L.canyonS = [a.s0, b.s1];
    // the chaparral ridge inside the canyon road (between the esses and the hairpin)
    if (L.canyonS) {
      for (let s = L.canyonS[0] + 8; s <= L.canyonS[1] - 40; s += 16) {
        const f = track.frameAt(s), lat = -(f.wallL + 32);
        L.ridge.push({ x: f.x + f.right.x * lat, z: f.z + f.right.z * lat, r: 27, h: 10 + 4 * Math.sin(s * 0.05) });
      }
    }
    const fest = festivalField(track, L, nearest);
    if (fest) L.flats.push(fest);
  }

  // Late-afternoon sun low over the sea (the coast faces +x here): warm
  // light, long shadows falling inland beside the karts.
  const sunDir = new THREE.Vector3(0.8, 0.5, 0.33).normalize();
  buildSky(ctx, { sunDir, top: C.skyTop, horizon: C.skyHorizon, bottom: C.skyBottom, sunColor: 0xffe2b0, fogNear: 320, fogFar: 1800 });
  const { sun, hemi, follow } = buildLights(ctx, { sunDir, sunColor: C.sun, sunIntensity: 2.5, hemiSky: C.hemiSky, hemiGround: C.hemiGround, hemiIntensity: 1.45 });
  const a = ctx.maxAniso;
  const T = createTrackTextures(ctx, {
    road: createLagunaRoadTexture({ aniso: a, size: Q.veg >= 1 ? 1024 : 512 }),
    wall: TX.createBeachWallAtlasTexture({ aniso: a }),
    banner: { bg: ['#2f8fc8', '#1d5f8c'], outline: '#0d2f4a' },
  });
  const M = {
    planks: decalMaterial({ map: ctx.tex(TX.createPlankTexture({ aniso: a, base: [186, 150, 108], planks: 10, lines: true, seed: 92 })) }),
    trestle: decalMaterial({ map: ctx.tex(TX.createPlankTexture({ aniso: a, base: [160, 112, 70], planks: 8, seed: 94 })) }),
    signs: new THREE.MeshLambertMaterial({ map: ctx.tex(TX.createSignAtlasTexture({ aniso: a })) }),
    paint: decalMaterial({ map: ctx.tex(createLagunaDecalAtlas({ aniso: a })), transparent: true, alphaTest: 0.03 }),
    picto: new THREE.MeshLambertMaterial({ map: ctx.tex(createPictogramAtlas({ aniso: a })), side: THREE.FrontSide }),
  };

  // terrain + sea
  const Z = L.Z;
  const isType = (type, s) => inType(track, Z, type, s);
  const field = createTerrainField(track, Q.terrainCell, {
    natural: lagunaNatural(track, L, L.coast),
    signedDist: (x, z) => L.coast.query(x, z).sd,
    extent: 1900,
    sections: (tr, { bridge, fillR, shR }) => {
      for (let i = 0; i < tr.N; i++) {
        const s = i * sp;
        for (const z of Z.bridge || []) bridge[i] = Math.max(bridge[i], smoothstep(Math.min(tr.forwardDistance(z.s0, s), tr.forwardDistance(s, z.s1)) / 5) * (tr.forwardDistance(z.s0, s) <= tr.forwardDistance(z.s0, z.s1) ? 1 : 0));
        // sea side of the clifftop / bluff / shelf: the drop starts right at the lip
        if (isType('clifftop', s) || isType('bluff', s) || isType('hairpin', s) || isType('tidepools', s)) {
          const f = tr.frameAt(s);
          const p = { x: f.x + f.right.x * (f.wallR + 1), z: f.z + f.right.z * (f.wallR + 1) };
          const q = L.coast.query(p.x, p.z);
          if (q.cliff > 0.3 && q.sd < 12) { fillR[i] = 3.2; shR[i] = clamp(q.sd + 0.5, 1.2, shR[i]); }
        }
      }
    },
    bridgeFloor: () => LEVEL - 1.4,
  });
  ctx.add(new THREE.Mesh(terrainGeometry(field, lagunaTerrainColor(track, L, L.coast, nearest)),
    new THREE.MeshLambertMaterial({ vertexColors: true, map: T.detail, flatShading: true })), { receive: true, name: 'Terrain' });
  buildWaterSurface(ctx, field, sunDir, {
    level: LEVEL, shallow: 0x52d8cf, deep: 0x1c64ad, sky: 0xf6d6ae, skyTop: 0x5b97dc, foam: 0xffffff, sunColor: 0xffe0b0, deepAt: 7, foamWidth: 0.7,
  });

  // road: sun-bleached asphalt; sidewalks in the village, lawn on the
  // clifftop, sand on the beach side, timber on the cove bridge, ice plant
  // on the bluff, chaparral dust up the canyon, rock at the tide pools
  const surge = hz.list.find((h) => h.type === 'surge');
  const wet = (s) => surge && track.forwardDistance(surge.s - 12, s) <= surge.len + 24;
  const canyon = (s) => L.canyonS && s > L.canyonS[0] && s < L.canyonS[1];
  buildRoad(ctx, T, {
    offroadColor: (s, side) => {
      if (isType('bridge', s)) return C.timber;
      if (isType('beach', s)) return side > 0 ? C.sand : C.sidewalk;
      if (isType('tidepools', s)) return side > 0 ? 0x8a8070 : C.sidewalk;
      if (isType('village', s)) return C.sidewalk;
      if (isType('bluff', s)) return C.iceplant;
      if (canyon(s)) return side > 0 ? 0xbfae7e : 0xb7ab80;
      if (isType('hillside', s) && !isType('hairpin', s)) return side < 0 ? 0xc9c09a : C.sidewalk;
      return C.lawn;
    },
  });
  buildStartLine(ctx, T);
  buildWalls(ctx, T, (i, side) => {
    const s = i * sp;
    if (isType('bridge', s)) return 'none';
    if (isType('beach', s)) return side > 0 ? (wet(s) ? 'rope' : 'seawall') : 'stucco';
    if (isType('tidepools', s)) return side > 0 ? 'rope' : 'stucco';
    if (isType('clifftop', s) || isType('bluff', s)) return side > 0 ? 'railing' : 'stucco';
    if (isType('hairpin', s)) return side > 0 ? 'railing' : 'stucco';
    return 'stucco';
  }, {
    railing: { band: TX.BEACH_WALL_BANDS.railing, h: 1.05 },
    stucco: { band: TX.BEACH_WALL_BANDS.stucco, h: 1.0 },
    seawall: { band: TX.BEACH_WALL_BANDS.seawall, h: 0.75 },
    rope: { band: TX.BEACH_WALL_BANDS.rope, h: 0.9 },
  });
  buildBoostPads(ctx, T);
  buildRamps(ctx, T);
  buildTurnSigns(ctx, T, { skip: (s) => isType('bridge', s) || isType('bridge', s + 10), postColor: 0xe8e2d4 });
  buildGantry(ctx, T, { pillarA: C.seaBlue, pillarB: C.white, base: 0xd9d2c4, beam: 0x5a6a78, frame: 0x16486e });

  // boardwalk planks on the beach road, the cove trestle, painted details
  const decals = [], trestle = [];
  const structB = regionBuckets(ctx, ctx.M.structure, { name: 'Town', cell: 200 });
  const deckRanges = [];
  for (const z of Z.beach || []) decals.push(roadDecal(ctx, z.s0, z.s1, { tile: 3.2, uSpan: null }));
  for (const z of Z.bridge || []) {
    buildTimberDeck(ctx, field, z.s0, z.s1, { bucket: structB, decals: trestle, rails: true, deck: C.timber, dark: C.timberDark, postStep: 4, beam: 0.9 });
    deckRanges.push([z.s0, z.s1]);
  }
  const paintDecals = buildLagunaDecals(ctx, L, hz);

  // landmarks, then town, then plants
  const lamps = [], palms = [], roses = [], rocks = [], eucs = [];
  const placer = createPlacer(ctx, field, { clear: 1.0, gap: 1.0 });
  buildBeach(ctx, field, L, structB, rng, lamps, palms);
  buildClifftop(ctx, field, L, structB, rng, roses, palms, lamps);
  buildRocks(ctx, field, L, rocks, structB, rng);
  buildTidePools(ctx, field, L, structB, rng);
  buildCanyon(ctx, field, L, structB, rng, nearest, eucs);
  buildEasels(ctx, field, L, structB, rng);
  buildTowerBerm(ctx, field, L, structB);
  const warn = buildWarningSigns(ctx, field, L, hz);
  for (const p of warn.posts) structB.push(p);
  // lifeguard HQ inland on the bluff (generic white building with blue trim)
  if (L.bluff) {
    const s = L.bluff.s0 + 40, f = track.frameAt(s), off = f.wallL + 12;
    const x = f.x - f.right.x * off, z = f.z - f.right.z * off;
    const rc = rect(x, z, Math.atan2(f.right.x, f.right.z), 9, 6.5);
    const ok = placer.fits(rc, { slopeMax: 6, clearance: 1.2 });
    if (ok) {
      const parts = [box(16, ok.gMax - ok.gMin + 7.2, 11, 0, (ok.gMax + ok.gMin - 0.6 + 7.2) / 2 - 0.3, 0, C.white),
        box(16.4, 0.5, 11.4, 0, ok.gMax + 6.9, 0, C.seaBlue), box(15, 1.6, 0.05, 0, ok.gMax + 4.6, 5.53, C.glass), box(15, 1.6, 0.05, 0, ok.gMax + 1.6, 5.53, C.glass)];
      const geo = mergeParts(parts);
      place(geo, x, 0, z, Math.atan2(f.right.x, f.right.z));
      structB.push(geo);
      placer.add(rc, 'hq', 0.3);
    }
  }
  // viewpoint bench inside the Crest Hairpin, looking out to sea
  if (L.hairpin) {
    const H = L.hairpin, x = H.x + 3.5, z = H.z - 1;
    if (field.wallClearance(x, z) > 2) {
      const g = field.surfaceHeight(x, z);
      const parts = [box(1.9, 0.08, 0.5, 0, 0.46, 0, 0x8a5a34), box(1.9, 0.4, 0.07, 0, 0.75, -0.24, 0x8a5a34, 0, -0.15), box(0.08, 0.46, 0.5, -0.8, 0.23, 0, 0x4a4f55), box(0.08, 0.46, 0.5, 0.8, 0.23, 0, 0x4a4f55)];
      const geo = mergeParts(parts);
      place(geo, x, g, z, Math.PI / 2);
      structB.push(geo);
      ctx.prop('bench', x, z, 1.0);
      ctx.exclusions.push([x, z, 1.5]);
    }
  }
  // flags round the start
  for (const s of [-30, 24, 48]) {
    const f = track.frameAt(s);
    for (const side of [-1, 1]) {
      const lat = side * ((side > 0 ? f.wallR : f.wallL) + 1.0);
      const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
      if (field.wallClearance(x, z) > 0.5) { ctx.flagSpots.push([x, field.surfaceHeight(x, z) - 0.05, z, f.yaw, false]); }
    }
  }
  buildFlags(ctx, ctx.flagSpots, [0x2f8fc8, 0xffd23a, 0xe8475f, 0xffffff, 0x3d9a6a]);
  const signs = [];
  const houses = buildTown(ctx, field, L, placer, structB, signs, rng, nearest, inside);
  ctx.stats.instances.houses = houses;
  structB.flush();
  if (!addMerged(ctx, signs, M.signs, { name: 'Signs' })) M.signs.dispose();
  if (!addMerged(ctx, decals, M.planks, { receive: true, name: 'Boardwalk' })) M.planks.dispose();
  if (!addMerged(ctx, trestle, M.trestle, { receive: true, name: 'Trestle' })) M.trestle.dispose();
  if (!addMerged(ctx, paintDecals, M.paint, { receive: true, name: 'RoadPaint' })) M.paint.dispose();
  if (!addMerged(ctx, warn.faces, M.picto, { name: 'WarningSigns' })) M.picto.dispose();
  buildLamps(ctx, lamps, { pole: 0x3d4a52, light: 0xfff0c8 });
  buildLagunaVegetation(ctx, field, L, placer, nearest, inside, { palms, roses, rocks, eucs }, rng);
  buildSailboats(ctx, L, rng);
  buildHills(ctx, L);
  buildClouds(ctx, { center: L.center, sunDir, count: Math.round(Q.clouds * 0.6) });

  // the set pieces (hazards/beach.js), drawn at hz.time, with telegraph sounds
  const shoreLat = (s) => {
    const f = track.frameAt(s), side = 1;
    for (let lat = f.wallR; lat < f.wallR + 140; lat += 0.5) {
      const x = f.x + f.right.x * lat * side, z = f.z + f.right.z * lat * side;
      if (L.coast.query(x, z).sd < 0) return lat;
    }
    return f.wallR + 140;
  };
  buildBeachSetPieces(ctx, field, { hz, level: LEVEL, shoreLat });
  ctx.stats.hazards = hz.list.length;

  ctx.stats.bridges = deckRanges.map(([s0, s1]) => [+s0.toFixed(1), +s1.toFixed(1)]);
  return finishWorld(ctx, {
    sun, hemi, follow,
    getGroundHeight: (x, z) => field.surfaceHeight(x, z),
    extra: { waterLevel: LEVEL, hazards: hz },
  });
}
