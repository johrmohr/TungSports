// World builder for "Krishiv's Palace" (browser only), theme 'castle': the
// dark lava fortress that closes the Krishiv Cup. Dispatched by worlds.js.
// Same contract as world.js ({ sun, hemi, root, update, dispose,
// getGroundHeight, landmarks, stats, quality }) plus
//
//   world.hazards = createHazards(track)   // hazards.js: { update(dt), check(kart) → null | 'crush' | 'fire', ... }
//
// The app advances the hazard clock (hazards.update(dt) with the race) and
// applies the effects; this kit only draws the hazards at hazards.time (if
// nobody drives the clock, e.g. on a dev page, world.update advances it).
//
// What makes it the palace (counter-clockwise lap):
//   * the Ash Causeway across a grey ash plain (dead trees, broken pillars),
//     a kicker off the moat's stone lip onto the timber-and-iron Drawbridge
//     over the lava moat, lava falls pouring from the façade;
//   * the Gatehouse: twin towers, a raised portcullis, a giant shield with
//     the crowned "K" over the arch;
//   * the torch-lit, roofed Crusher Hall (faceless iron-banded crushers),
//     the stair turns down into the Flame Gallery cavern (flame arms swing
//     from pillars at the road edges, lava channels and falls beyond),
//     the Spiral Climb round the Flame Tower and its giant brazier, the
//     crenellated Rampart Run (a row of three crushers under a stone
//     gantry), the Rampart Leap through the doorway into the Throne Hall
//     (red carpet, pillars, chandeliers), the giant empty golden throne at
//     the Throne Turn, the Geyser Stairs and the back gate;
//   * v5 (SPEC §16.1, notes/v5-track-palace.md): the FORGE WING standing in
//     a lava lake — the Forge hall (furnaces, crucible, reversing conveyor
//     belts), the Anvil courtyard (giant anvil + trip hammer), the Lavafall
//     Tunnel (lava curtains from ceiling slots) — and the FINALE: the Geyser
//     Stairs (four geysers), the vaulted Banquet Hall (feast tables, stained
//     glass, swinging chandeliers) and the Portcullis Run (gate leaves that
//     slam down in turn). Rooms: world-palace-rooms.js; moving set pieces +
//     audio cues: world-palace-setpieces.js / world-palace-sounds.js;
//     textures: world-palace-textures.js; shared helpers: world-palace-kit.js;
//   * a red-purple volcanic sky, a smoking volcano, lava rivers, embers.
// Original design: no existing characters, faces or emblems; the crowned-K
// banners, shield and throne carry the identity.
//
// Quality 'low' (split-screen): no shadow map, coarser terrain, fewer
// props / embers, no crucible / sparks / beacons / splash crowns / goblets.
// Budget at 'high': ≤ 120 draw calls, ≤ 280k triangles (measured ≤ 108 / 256k).

import * as THREE from 'three';
import { makeRng, clamp, lerp, smoothstep } from './utils.js';
import * as TX from './textures.js';
import { createHazards, hazardState, HAZARD_TUNE } from './hazards.js';
import {
  C, LAVA, HALL_H, THRONE_H, hallWall, merlons, hallRoof, roundTower, squareTower, lavaFall, torch, banner,
  worldUVBox, rectCorners,
} from './world-palace-kit.js';
import * as PTX from './world-palace-textures.js';
import { buildForge, buildAnvil, buildLavafallTunnel, buildBanquetHall, buildPortcullisRun } from './world-palace-rooms.js';
import { buildSetPieces } from './world-palace-setpieces.js';
import {
  createWorldContext, buildSky, buildLights, createTrackTextures, buildRoad, buildStartLine, buildWalls,
  buildBoostPads, buildRamps, buildTurnSigns, buildGantry, buildFlags, mountainGeometry, lumpy,
  addInstancedSet, finishWorld, createTerrainField, terrainGeometry, trackStrip, sRange, regionBuckets,
  place, paint, faceColors, mixHex, place_m4, addMerged, fbm, hash2,
  tris, box, quad, cyl, ball, cone, mergeParts, segByName, arcCenter, zonesByType, inType,
  makeNearest, makeLoopInside, makeRoadHeightField, roadDecal, decalMaterial, buildPuffs,
} from './world.js';

// ------------------------------------------------------------------ layout

function palaceLayout(track) {
  const Z = zonesByType(track);
  const seg = (name) => segByName(track, name);
  const centre = (name) => { const sg = seg(name); return sg ? arcCenter(track, sg.index) : null; };
  const b = track.bounds;
  const gates = (Z.gate || []).slice().sort((a, c) => a.s0 - c.s0);
  return {
    Z, seg,
    bridge: (Z.bridge || [])[0] || null,
    hall: (Z.hall || [])[0] || null,
    lava: (Z.lava || [])[0] || null,
    tower: centre('Spiral Climb'),
    throne: centre('Throne Turn'),
    gateTurn: centre('Gate Turn'),
    frontGate: gates[0] || null, backGate: gates[1] || null,
    center: { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 },
  };
}

// Lava areas as soft masks: the moat crossing under the drawbridge (and a
// lava river leaving it west), a lava lake between the ramparts and the
// Flame Gallery, the channel outside the gallery, the Flame Tower's pool, a
// pool in the south bailey and two rivers out on the ash plain. Masks are
// kept off the track corridors by the caller (minE).
function lavaAreas(track, L, inside) {
  const bx = L.bridge ? track.frameAt((L.bridge.s0 + L.bridge.s1) / 2) : { x: 0, z: 89 };
  const mz = bx.z, mx = bx.x;
  const segDist = (x, z, pts) => {
    let best = Infinity;
    for (let k = 0; k < pts.length - 1; k++) {
      const [x0, z0] = pts[k], [x1, z1] = pts[k + 1];
      const ex = x1 - x0, ez = z1 - z0, l2 = ex * ex + ez * ez;
      const t = clamp(((x - x0) * ex + (z - z0) * ez) / l2, 0, 1);
      best = Math.min(best, Math.hypot(x - x0 - ex * t, z - z0 - ez * t));
    }
    return best;
  };
  const river1 = [[mx - 90, mz], [mx - 170, mz + 60], [mx - 300, mz + 110], [mx - 520, mz + 240], [mx - 900, mz + 330]];
  const river2 = [[300, -40], [380, -120], [470, -150], [700, -320]];
  const lakeBox = (x, z, x0, x1, z0, z1, soft) => {
    const dx = Math.max(x0 - x, x - x1, 0), dz = Math.max(z0 - z, z - z1, 0);
    return 1 - smoothstep(Math.hypot(dx, dz) / soft);
  };
  const T = L.tower;
  const gal = L.lava ? { a: track.frameAt(L.lava.s0), b: track.frameAt(L.lava.s1) } : null;
  // v5: the forge wing juts out into a lava lake (outside the loop: not the anvil courtyard)
  const fg = L.seg('The Forge'), lf = L.seg('Lavafall Tunnel');
  let wing = null;
  if (fg && lf) {
    const pts = [track.frameAt(fg.s0), track.frameAt(fg.s1), track.frameAt(lf.s0), track.frameAt(lf.s1)];
    wing = { x0: Math.min(...pts.map((p) => p.x)) - 62, x1: Math.max(...pts.map((p) => p.x)) + 62, z0: Math.min(...pts.map((p) => p.z)) - 14, z1: Math.max(...pts.map((p) => p.z)) + 75 };
  }
  return (x, z) => {
    let m = 0;
    // the moat: a band across the drawbridge, from the west plain to the throne hall
    const wob = Math.sin(x * 0.06) * 3 + Math.sin(x * 0.17 + 1) * 1.5;
    m = Math.max(m, lakeBox(x, z, mx - 95, mx + 112, mz - 22 + wob, mz + 22 - wob * 0.5, 4));
    m = Math.max(m, 1 - smoothstep((segDist(x, z, river1) - 12 - Math.sin(x * 0.03) * 4) / 4));
    m = Math.max(m, 1 - smoothstep((segDist(x, z, river2) - 9) / 4));
    if (gal) {
      // outside the gallery (beyond its right wall) and the lake inside
      const dir = { x: gal.b.x - gal.a.x, z: gal.b.z - gal.a.z };
      const len = Math.hypot(dir.x, dir.z) || 1;
      const ax = (x - gal.a.x) * dir.x / len + (z - gal.a.z) * dir.z / len;       // along the gallery
      const lat = (x - gal.a.x) * gal.a.right.x + (z - gal.a.z) * gal.a.right.z;  // + = outside (right)
      if (ax > -20 && ax < len + 4) m = Math.max(m, 1 - smoothstep((Math.abs(lat - 30) - 7) / 3));
      if (ax > -40 && ax < len * 0.55) m = Math.max(m, 1 - smoothstep((Math.abs(lat + 36) - 12) / 4));
    }
    if (T) m = Math.max(m, 1 - smoothstep((Math.hypot(x - T.x, z - T.z) - 16.5) / 2.5));
    if (wing && !inside(x, z)) {
      const wob = Math.sin(x * 0.05 + 2) * 6 + Math.sin(z * 0.07) * 4;
      m = Math.max(m, lakeBox(x, z, wing.x0 + wob, wing.x1 - wob, wing.z0, wing.z1 + wob, 14));
    }
    // south bailey pool (inside the loop, west of the throne hall)
    m = Math.max(m, 1 - smoothstep((Math.hypot(x - 62, z - 2) - 20 - Math.sin(Math.atan2(z - 2, x - 62) * 3) * 3) / 3));
    return m;
  };
}

// ------------------------------------------------------------------ terrain

// The ash plain (gentle dunes, rising into dark hills far out), the
// fortress ground inside the loop (paved courtyards at road level, the
// lake hollow inside the ramparts), cavern rock rising outside the Flame
// Gallery, lava areas carved below the lava surface.
function palaceNatural(track, L, lavaAt, inside) {
  const road = makeRoadHeightField(track, 3, 900);
  const C0 = L.center;
  const gal = L.lava ? { a: track.frameAt(L.lava.s0), b: track.frameAt(L.lava.s1) } : null;
  return (x, z, minE) => {
    const r = road(x, z);
    let h;
    if (inside(x, z)) {
      h = Math.min(r.h - 0.3, 3.2);
    } else {
      h = 1.1 + (fbm(x * 0.02 + 4, z * 0.02 - 1, 3) - 0.5) * 2.2;
      const rc = Math.hypot(x - C0.x, z - C0.z);
      h += 80 * smoothstep((rc - 420) / 600) * Math.max(0, fbm(x * 0.004 + 7.3, z * 0.004 + 2.1, 4) - 0.28) * 1.7;
      h = lerp(r.h - 0.4, h, smoothstep((r.d - 20) / 30));
    }
    // cavern rock beyond the Flame Gallery's outer lava channel
    if (gal) {
      const dx = gal.b.x - gal.a.x, dz = gal.b.z - gal.a.z, len = Math.hypot(dx, dz) || 1;
      const ax = (x - gal.a.x) * dx / len + (z - gal.a.z) * dz / len;
      const lat = (x - gal.a.x) * gal.a.right.x + (z - gal.a.z) * gal.a.right.z;
      const along = smoothstep((ax + 40) / 25) * smoothstep((len - 12 - ax) / 25);   // fades out before both ends (the forge wing at the east end)
      // a craggy ridge (not a table top): up over 16 m beyond the channel, down again by ~120 m out
      const prof = smoothstep((lat - 38) / 16) * (1 - smoothstep((lat - 70) / 50));
      if (along > 0 && prof > 0) h = Math.max(h, 2 + 30 * along * prof * (0.45 + 0.9 * fbm(x * 0.035 + 3, z * 0.035, 3)));
    }
    const m = lavaAt(x, z) * smoothstep((minE - 1.5) / 3);
    if (m > 0) h = lerp(h, LAVA - 1.6, m);
    return h;
  };
}

function palaceTerrainColor(track, L, lavaAt, inside) {
  const cA = new THREE.Color(C.ash), cAL = new THREE.Color(C.ashLight), cAD = new THREE.Color(C.ashDark);
  const cRust = new THREE.Color(C.rust), cBas = new THREE.Color(C.basalt), cSc = new THREE.Color(C.scorched);
  const cGlow = new THREE.Color(0xc0461a), cPave = new THREE.Color(0x4a4448), tmp = new THREE.Color();
  return (c, x, z, h, slope) => {
    const n1 = fbm(x * 0.03, z * 0.03, 3), n2 = fbm(x * 0.009 + 4, z * 0.009 - 9, 3);
    c.copy(cA).lerp(cAL, smoothstep((n1 - 0.45) / 0.25) * 0.6).lerp(cAD, smoothstep((0.4 - n1) / 0.2) * 0.6);
    c.lerp(cRust, smoothstep((n2 - 0.55) / 0.2) * 0.5);
    if (inside(x, z) && h > 0.5) c.lerp(cPave, 0.55);
    c.lerp(tmp.copy(cBas).lerp(cSc, n1), smoothstep((slope - 0.5) / 0.4));
    // glowing banks next to lava
    const near = smoothstep((LAVA + 2.2 - h) / 2.2);
    if (near > 0) c.lerp(cGlow, near * 0.8);
  };
}

// ------------------------------------------------------------------ lava

// The lava surface: one big plane under the world (terrain above the lava
// level hides it), a crusted glowing map scrolling slowly, pulsing.
function buildLava(ctx, center, lavaTex) {
  const size = 3200;
  const g = new THREE.PlaneGeometry(size, size, 1, 1).rotateX(-Math.PI / 2);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + center.x) / 36, (p.getZ(i) + center.z) / 36);
  g.translate(center.x, LAVA, center.z);
  const mat = new THREE.MeshBasicMaterial({ map: lavaTex, toneMapped: false, fog: true });
  const mesh = ctx.add(new THREE.Mesh(g, mat), { name: 'Lava' });
  mesh.renderOrder = -5;
  ctx.animators.push((dt, t) => {
    lavaTex.offset.set((t * 0.012) % 1, (t * 0.02) % 1);
    const k = 0.9 + 0.1 * Math.sin(t * 1.7);
    mat.color.setRGB(k, k * 0.96, k * 0.9);
  });
  return mesh;
}

// ------------------------------------------------------------------ landmarks

// The Gatehouse: twin square towers flanking the road, a deep arch wall over
// it (pointed opening wall to wall), the raised portcullis in the arch, the
// giant crowned-K shield above, torches. Also used (smaller) for the back gate.
function buildGate(ctx, field, s, B, glow, emblems, { scale = 1, shield = true, towerH = 24 } = {}) {
  const { track } = ctx;
  const f = track.frameAt(s);
  const P = (lat, along = 0) => ({ x: f.x + f.right.x * lat + f.tangent.x * along, z: f.z + f.right.z * lat + f.tangent.z * along });
  const TW = 11 * scale;
  let span = Math.max(f.wallL, f.wallR);
  for (let d = -TW / 2 - 1; d <= TW / 2 + 1; d += 1) { const g = track.frameAt(s + d); span = Math.max(span, g.wallL, g.wallR); }
  const parts = [];
  for (const side of [-1, 1]) {
    const lat = side * (span + TW / 2 + 0.6);
    const p = P(lat);
    const g = Math.min(f.y, field.surfaceHeight(p.x, p.z)) - 2;
    squareTower(parts, p.x, g, p.z, TW, towerH * scale + (f.y - g), f.yaw, { roofCol: C.slate });
    ctx.prop('gateTower', p.x, p.z, TW * 0.5);
    for (const [u, v] of rectCorners(p.x, p.z, f.yaw, TW / 2, TW / 2)) ctx.prop('gateTower', u, v, 0.4);
    ctx.exclusions.push([p.x, p.z, TW * 0.8]);
    // torches on the tower faces toward the road
    for (const along of [-TW / 2 - 0.3]) {
      const q = P(side * (span + 1.2), along);
      torch(parts, glow, q.x, f.y + 3.4, q.z, f.yaw + Math.PI, f.y);
    }
  }
  // the arch wall: spans tower to tower above the road (opening wall to wall, pointed)
  const W = (span + 0.6) * 2, H = 13 * scale, D = 5 * scale;
  // one outline round the opening (a U), so the pointed arch never gets
  // triangulated shut
  const ow = span + 0.02, spring = 7.5 * scale;
  const shape = new THREE.Shape();
  shape.moveTo(-W / 2, -0.4); shape.lineTo(-ow, -0.4); shape.lineTo(-ow, spring);
  shape.quadraticCurveTo(-ow * 0.55, spring + ow * 0.7, 0, spring + ow * 0.62);
  shape.quadraticCurveTo(ow * 0.55, spring + ow * 0.7, ow, spring);
  shape.lineTo(ow, -0.4); shape.lineTo(W / 2, -0.4); shape.lineTo(W / 2, H + 3); shape.lineTo(-W / 2, H + 3); shape.lineTo(-W / 2, -0.4);
  const arch = new THREE.ExtrudeGeometry(shape, { depth: D, bevelEnabled: false, curveSegments: 8 });
  arch.translate(0, 0, -D / 2);
  arch.rotateY(Math.PI);                // local +x = right of the road after the yaw turn below
  place(arch, f.x, f.y, f.z, f.yaw);
  B.stone.push(paint(arch, C.stone));
  // merlons on the arch wall top + a gold trim band
  for (let k = -Math.floor(W / 2.4) / 2; k <= Math.floor(W / 2.4) / 2; k++) {
    const p = P(k * 2.4);
    parts.push(box(1.1, 1.2, D * 0.3, p.x, f.y + H + 3.6, p.z, C.stoneDark, f.yaw));
  }
  {
    const p = P(0, -D / 2 - 0.05);
    parts.push(box(W, 0.35, 0.12, p.x, f.y + H + 2.5, p.z, C.gold, f.yaw));
  }
  // raised portcullis: iron grid in the top of the opening
  {
    const pc = [];
    const gw = ow * 2 - 0.4, top = spring + ow * 0.6, bot = spring + 0.9;   // raised into the arch head
    for (let x = -gw / 2; x <= gw / 2 + 0.01; x += 1.1) pc.push(box(0.22, top - bot, 0.22, x, (top + bot) / 2, 0, C.iron));
    for (let y = bot + 0.3; y < top; y += 1.3) pc.push(box(gw, 0.2, 0.18, 0, y, 0, C.iron));
    for (let x = -gw / 2; x <= gw / 2 + 0.01; x += 1.1) pc.push(cone(0.18, 0.7, 4, x, bot - 0.35, 0, C.ironLight, 0, Math.PI));
    const g = mergeParts(pc);
    place(g, f.x + f.tangent.x * (D / 2 - 0.6), f.y, f.z + f.tangent.z * (D / 2 - 0.6), f.yaw);
    parts.push(g);
  }
  // the crowned-K shield over the arch, facing the oncoming karts
  if (shield) {
    const SW = 7.5 * scale, SH = 8.6 * scale;
    const p = P(0, -D / 2 - 0.2);
    const g = new THREE.PlaneGeometry(SW, SH);
    place(g, p.x, f.y + spring + ow * 0.62 + SH / 2 + 0.6, p.z, f.yaw + Math.PI);
    emblems.shield.push(g);
    const back = box(SW * 0.96, SH * 0.96, 0.4, p.x + f.tangent.x * 0.25, f.y + spring + ow * 0.62 + SH / 2 + 0.6, p.z + f.tangent.z * 0.25, C.goldDark, f.yaw);
    parts.push(back);
  }
  for (const g of parts) B.struct.push(g);
  ctx.landmarks.push({ name: 'gatehouse', x: f.x, z: f.z, r: span + TW, h: towerH * scale + 8 });
}
// The façade along the moat's far bank (crenellated curtain wall west and
// east of the gatehouse) with lava falls pouring from spouts into the moat,
// and the curtain wall between the causeway and the south bailey.
function buildCurtainWalls(ctx, field, L, B, falls, glow, emblems) {
  const { track } = ctx;
  if (!L.frontGate || !L.bridge) return;
  const fg = track.frameAt(L.frontGate.s0 + 2);
  const zF = fg.z + 4;                                 // façade line (just beyond the moat)
  const wallRun = (x0, z0, x1, z1, h, T = 5, spouts = 0) => {
    const len = Math.hypot(x1 - x0, z1 - z0), yaw = Math.atan2(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 20));
    for (let k = 0; k < n; k++) {
      const a = k / n, b = (k + 1) / n;
      const xa = lerp(x0, x1, a), za = lerp(z0, z1, a), xb = lerp(x0, x1, b), zb = lerp(z0, z1, b);
      const xm = (xa + xb) / 2, zm = (za + zb) / 2, l = len / n;
      const g = Math.min(field.surfaceHeight(xa, za), field.surfaceHeight(xb, zb), field.surfaceHeight(xm, zm), LAVA) - 1;
      const top = Math.max(field.surfaceHeight(xm, zm), 2) + h;
      const wall = box(T, top - g, l + 0.3, xm, (top + g) / 2, zm, C.stone, yaw);
      worldUVBox(wall, 4);
      B.stone.push(wall);
      for (let t = 0.5; t < l; t += 2.6) {
        const q = lerp(0, 1, t / l);
        const x = lerp(xa, xb, q), z = lerp(za, zb, q);
        B.struct.push(box(T * 0.3, 1.3, 1.2, x, top + 0.65, z, C.stoneDark, yaw));
      }
      B.struct.push(box(T + 0.6, 0.35, l + 0.3, xm, top - 2.2, zm, C.goldDark, yaw));
      for (let p = 0; p < 6; p++) ctx.prop('curtain', lerp(xa, xb, p / 5), lerp(za, zb, p / 5), T / 2);
    }
    // lava spouts + falls (facing -normal = toward the moat)
    const nx = Math.cos(yaw), nz = -Math.sin(yaw);       // local +x of the run
    for (let k = 0; k < spouts; k++) {
      const q = (k + 0.5) / spouts, x = lerp(x0, x1, q), z = lerp(z0, z1, q);
      const top = Math.max(field.surfaceHeight(x, z), 2) + h - 4;
      const ox = x - nx * (T / 2 + 0.1), oz = z - nz * (T / 2 + 0.1);
      lavaFall(falls, ox, oz, top, LAVA - 0.3, -nx, -nz, 3.2);
      B.struct.push(box(2.6, 1.6, 1.4, ox - nx * 0.4, top + 0.3, oz - nz * 0.4, C.goldDark, yaw));
      glow.push(paint(place(new THREE.CircleGeometry(1.2, 10), ox - nx * 1.15, top + 0.2, oz - nz * 1.15, Math.atan2(-nx, -nz)), C.lavaGlow));
    }
    return { len, yaw };
  };
  const wx = fg.wallR + 12 + 0.6;   // beyond the gate towers
  // west of the gatehouse (outside) and east (inside, up to the throne hall)
  wallRun(fg.x - 70, zF, fg.x - wx, zF, 16, 5, 2);
  wallRun(fg.x + wx, zF, fg.x + 108, zF, 16, 5, 3);
  // banners on the façade facing the causeway
  for (const x of [fg.x - 40, fg.x - 24, fg.x + 26, fg.x + 50, fg.x + 80]) banner(emblems, x, Math.max(field.surfaceHeight(x, zF), 2) + 10.5, zF - 2.65, Math.PI);
  // curtain wall between the causeway (inside) and the south bailey
  const home = L.seg('Home Straight'), cz = L.seg('Ash Causeway');
  if (home && cz) {
    const a = track.frameAt(home.s0 + 8), b = track.frameAt(cz.s1 - 4);
    const off = Math.max(a.wallL, b.wallL) + 6.5;
    wallRun(a.x + a.right.x * -off, a.z + a.right.z * -off, b.x + b.right.x * -off, b.z + b.right.z * -off, 11, 4, 0);
  }
}
// The drawbridge: iron-banded plank decal wall to wall, a deck slab with an
// iron fascia, chains from the gate towers down to the deck edge, and
// massive stone piers down into the lava.
function buildDrawbridge(ctx, field, L, B, decals) {
  const { track } = ctx;
  const Zb = L.bridge;
  if (!Zb) return null;
  const s0 = Zb.s0, s1 = Zb.s1;
  decals.push(roadDecal(ctx, s0 + 7.5, s1, { latA: (f) => -(f.wallL + 0.5), latB: (f) => f.wallR + 0.5, tile: 4, uSpan: 8 }));
  const sl = sRange(s0, s1, 1);
  B.struct.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => { o.lat = c ? -(f.wallL + 0.6) : f.wallR + 0.6; o.dy = -1.1; }), C.wood));
  for (const side of [-1, 1]) {
    B.struct.push(paint(trackStrip(track, sl, 2, (f, s, c, o) => {
      const wall = side > 0 ? f.wallR : f.wallL;
      const upper = side > 0 ? c === 0 : c === 1;
      o.lat = side * (wall + 0.6); o.dy = upper ? 0.02 : -1.1;
    }), C.iron));
  }
  // stone piers every ~20 m into the lava
  for (let s = s0 + 14; s < s1 - 6; s += 20) {
    const f = track.frameAt(s);
    for (const side of [-1, 1]) {
      const lat = side * ((side > 0 ? f.wallR : f.wallL) - 3);
      const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
      const pier = box(4, f.y - 1.1 - (LAVA - 4), 4, x, (f.y - 1.1 + LAVA - 4) / 2, z, C.stoneDark, f.yaw);
      worldUVBox(pier, 4);
      B.stone.push(pier);
    }
  }
  // chains from the gate towers' faces to the deck edges at the far end
  const fg = track.frameAt(s1 + 1);
  const fe = track.frameAt(s0 + (s1 - s0) * 0.35);
  for (const side of [-1, 1]) {
    const latG = side * (Math.max(fg.wallL, fg.wallR) + 0.8), latE = side * ((side > 0 ? fe.wallR : fe.wallL) + 0.3);
    const A = new THREE.Vector3(fg.x + fg.right.x * latG, fg.y + 11, fg.z + fg.right.z * latG);
    const E = new THREE.Vector3(fe.x + fe.right.x * latE, fe.y + 0.5, fe.z + fe.right.z * latE);
    const n = Math.ceil(A.distanceTo(E) / 0.7);
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const p = new THREE.Vector3().lerpVectors(A, E, t);
      p.y -= Math.sin(Math.PI * t) * 1.2;
      B.struct.push(paint(place(new THREE.TorusGeometry(0.28, 0.08, 4, 6), p.x, p.y, p.z, fe.yaw + (k % 2 ? Math.PI / 2 : 0), 0.6), C.ironLight));
    }
    ctx.prop('chainAnchor', E.x, E.z, 0.0);
  }
  return [s0, s1];
}

// The Crusher Hall / Throne Hall / stair & gallery walls, roofs, pillars,
// torches and banners. Returns the roofed ranges (for road shading).
function buildHalls(ctx, field, L, B, glow, emblems) {
  const { track } = ctx;
  const Z = L.Z;
  const roofed = [];
  const wallFor = (z, H, { roof = 0, torches = true, banners = true, skipOuter = null } = {}) => {
    const len = track.forwardDistance(z.s0, z.s1);
    const s0 = z.s0, s1 = z.s0 + len;
    for (const side of [-1, 1]) {
      if (skipOuter && side === skipOuter.side) {
        hallWall(ctx, B.stone, s0, skipOuter.s0, side, { H });
        hallWall(ctx, B.stone, skipOuter.s1, s1, side, { H });
      } else hallWall(ctx, B.stone, s0, s1, side, { H });
      merlons(ctx, B.struct, s0, s1, side, { y: H, h: 1.3, w: 1.2, gap: 2.8, T: 1.6 });
    }
    if (roof) {
      hallRoof(ctx, B.roof, s0, s1, roof); roofed.push([s0, s1]);
      // roof landmarks: the title flyover (main.js AttractCam) rises over them
      for (let s = s0; s <= s1; s += 16) {
        const f = track.frameAt(s);
        ctx.landmarks.push({ name: 'hallRoof', x: f.x, z: f.z, r: Math.max(f.wallL, f.wallR) + 2, h: f.y + roof + 2 });
      }
    }
    for (let s = s0 + 5; s < s1 - 3; s += 11) {
      const f = track.frameAt(s);
      for (const side of [-1, 1]) {
        if (skipOuter && side === skipOuter.side && s > skipOuter.s0 - 3 && s < skipOuter.s1 + 3) continue;
        const wall = side > 0 ? f.wallR : f.wallL;
        const lat = side * (wall - 0.05);
        const x = f.x + f.right.x * lat, zz = f.z + f.right.z * lat;
        // pilaster (embedded half in the wall) + torch / banner alternating
        const pl = side * (wall + 0.35);
        B.struct.push(box(1.2, H - 1.15, 0.8, f.x + f.right.x * pl, f.y + 1.15 + (H - 1.15) / 2, f.z + f.right.z * pl, C.stoneDark, f.yaw + Math.PI / 2));
        const k = Math.round((s - s0) / 11) % 2;
        const inward = f.yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
        if (k === 0 && torches) torch(B.struct, glow, x - f.right.x * side * 0.3, f.y + 4.2, zz - f.right.z * side * 0.3, inward, f.y);
        else if (banners) banner(emblems, x - f.right.x * side * 0.08, f.y + Math.min(H - 4, 8.5), zz - f.right.z * side * 0.08, inward + Math.PI, 2.6, 5.2);
      }
    }
  };
  if (L.hall) wallFor(L.hall, HALL_H + 1, { roof: HALL_H });
  for (const z of Z.stairs || []) wallFor(z, 9, { banners: false });
  for (const z of Z.throne || []) {
    const turn = L.seg('Throne Turn');
    const skip = turn ? { side: 1, s0: turn.s0 - 6, s1: Math.min(z.s1, turn.s1) } : null;
    wallFor(z, THRONE_H + 1, { roof: THRONE_H, skipOuter: skip });
  }
  return roofed;
}

// Flame Gallery cavern: low lava-stone barriers (atlas), lava falls on the
// rock beyond the outer channel, glowing spouts.
function buildGalleryFalls(ctx, field, L, falls) {
  const { track } = ctx;
  if (!L.lava) return;
  const len = track.forwardDistance(L.lava.s0, L.lava.s1);
  for (let k = 0; k < 4; k++) {
    const s = L.lava.s0 + len * (0.15 + k * 0.23), f = track.frameAt(s);
    // walk outward to the cavern face
    let lat = f.wallR + 28, top = -Infinity, x = 0, z = 0;
    for (let l = f.wallR + 24; l < f.wallR + 60; l += 1) {
      const px = f.x + f.right.x * l, pz = f.z + f.right.z * l, h = field.surfaceHeight(px, pz);
      if (h > 12) { lat = l; top = h; x = px; z = pz; break; }
    }
    if (top < 8) continue;
    lavaFall(falls, x - f.right.x * 0.6, z - f.right.z * 0.6, top - 0.5, LAVA - 0.3, -f.right.x, -f.right.z, 4 + (k % 2) * 2);
  }
}

// The Flame Tower inside the Spiral Climb: a round basalt tower rising from
// the lava pool with a giant gold brazier and fire on top.
function buildFlameTower(ctx, field, L, B, glow, fires) {
  const T = L.tower;
  if (!T) return;
  const g = LAVA - 2, r = 8.5, h = 32;
  const parts = [];
  roundTower(parts, T.x, g, T.z, r, h, { roof: false, color: C.basalt });
  for (const y of [8, 16, 24]) parts.push(cyl(r * 1.04, r * 1.04, 0.5, 12, T.x, g + y, T.z, C.goldDark));
  // brazier: bowl on a stem
  const top = g + h + 1.2;
  parts.push(cyl(2.5, 3.5, 3, 10, T.x, top + 1.5, T.z, C.goldDark));
  parts.push(paint(place(new THREE.LatheGeometry([[0, 0], [4.5, 0.3], [6.5, 2.6], [6.8, 3.4], [6.2, 3.4], [4.2, 1.2], [0, 1.0]].map(([a, b]) => new THREE.Vector2(a, b)), 14), T.x, top + 3, T.z), C.gold));
  for (const p of parts) B.struct.push(p);
  fires.push({ x: T.x, y: top + 6.2, z: T.z, s: 4.2 });
  // glowing slits
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2, y = g + 6 + (k % 3) * 8;
    glow.push(paint(place(new THREE.PlaneGeometry(0.7, 2.2), T.x + Math.sin(a) * (r * 1.06 + 0.05), y, T.z + Math.cos(a) * (r * 1.06 + 0.05), a), C.lavaGlow));
  }
  ctx.prop('flameTower', T.x, T.z, r * 1.12);
  ctx.landmarks.push({ name: 'flameTower', x: T.x, z: T.z, r: r * 1.2, h: h + 12 });
}

// The keep in the north bailey and corner towers round the fortress.
function buildKeep(ctx, field, L, B, emblems) {
  const { track } = ctx;
  const parts = [];
  const hall = L.hall ? track.frameAt(L.hall.s0 + 50) : null;
  if (hall && L.frontGate) {
    const fg = track.frameAt(L.frontGate.s0);
    const kx = (fg.x + 30 + hall.x) / 2 + 22, kz = (fg.z + 8 + hall.z - hall.wallL) / 2 + 2;
    if (field.wallClearance(kx, kz) > 13) {
      const g = field.surfaceHeight(kx, kz) - 1;
      squareTower(parts, kx, g, kz, 18, 30, 0.05, { roofCol: C.slate });
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) roundTower(parts, kx + ox * 9.4, g, kz + oz * 9.4, 2.6, 34, { roofCol: C.red });
      for (let k = 0; k < 4; k++) {
        const a = 0.05 + (k * Math.PI) / 2;
        banner(emblems, kx + Math.sin(a) * 9.15, g + 22, kz + Math.cos(a) * 9.15, a, 3.2, 6.4);
      }
      ctx.prop('keep', kx, kz, 12.5);
      ctx.exclusions.push([kx, kz, 16]);
      ctx.landmarks.push({ name: 'keep', x: kx, z: kz, r: 13, h: 46 });
      ctx.flagSpots.push([kx, g + 49, kz, 0, true]);
    }
  }
  for (const p of parts) B.struct.push(p);
}

// The giant empty golden throne outside the Throne Turn (seen through the
// colonnade), on a stepped dais, crowned K on its back, braziers.
function buildThrone(ctx, field, L, B, glow, emblems, fires) {
  const { track } = ctx;
  const turn = L.seg('Throne Turn');
  if (!turn || !L.throne) return;
  const mid = track.frameAt((turn.s0 + turn.s1) / 2 - 6);
  let ox = mid.x - L.throne.x, oz = mid.z - L.throne.z;
  const ol = Math.hypot(ox, oz); ox /= ol; oz /= ol;
  const dist = L.throne.r + mid.wallR + 16;
  const x = L.throne.x + ox * dist, z = L.throne.z + oz * dist;
  const hallF = track.frameAt(turn.s0 - 50);
  const yaw = Math.atan2(hallF.x - x, hallF.z - z);
  const g = mid.y;
  const parts = [];
  // dais
  for (let k = 0; k < 4; k++) parts.push(box(22 - k * 3, 0.6, 20 - k * 3, 0, g + 0.3 + k * 0.6, 0, k % 2 ? C.stoneDark : C.stone));
  const s = g + 2.4;
  // legs, seat, cushion, arms, back
  for (const [lx, lz] of [[-4.6, -3.6], [4.6, -3.6], [-4.6, 3.6], [4.6, 3.6]]) parts.push(box(1.2, 4, 1.2, lx, s + 2, lz, C.gold));
  parts.push(box(11, 1.6, 9, 0, s + 4.6, 0, C.gold));
  parts.push(box(9.6, 1.0, 7.4, 0, s + 5.8, 0.3, C.carpet));
  for (const sx of [-1, 1]) {
    parts.push(box(1.4, 3.2, 8.4, sx * 5.2, s + 7.0, 0.2, C.gold));
    parts.push(ball(1.0, sx * 5.2, s + 8.8, 4.1, C.goldDark, 1, 1, 1, 1));
  }
  parts.push(box(11, 14, 1.6, 0, s + 12.2, -3.9, C.gold));
  parts.push(box(9, 11.5, 0.5, 0, s + 11.8, -3.0, C.carpet));
  for (const sx of [-1, 0, 1]) parts.push(cone(1.0 - Math.abs(sx) * 0.25, 3.2 - Math.abs(sx) * 0.8, 6, sx * 4.2, s + 20.6 - Math.abs(sx) * 0.8, -3.9, C.gold));
  for (const sx of [-1, 1]) parts.push(ball(0.8, sx * 5.4, s + 19.4, -3.9, C.gold));
  const geo = mergeParts(parts);
  place(geo, x, 0, z, yaw);
  B.struct.push(geo);
  // the emblem on the back (facing the karts)
  {
    const eg = new THREE.PlaneGeometry(7.2, 7.2);
    eg.translate(0, s + 12.6, -2.72);
    place(eg, x, 0, z, yaw);
    emblems.square.push(eg);
  }
  // braziers either side of the dais
  for (const sx of [-1, 1]) {
    const bx = x + Math.cos(yaw) * sx * 13.5, bz = z - Math.sin(yaw) * sx * 13.5;
    if (field.wallClearance(bx, bz) < 2.5) continue;
    B.struct.push(cyl(0.5, 0.8, 3.6, 8, bx, g + 1.8, bz, C.iron));
    B.struct.push(paint(place(new THREE.LatheGeometry([[0, 0], [1.4, 0.2], [2.0, 1.2], [1.7, 1.3], [0, 0.5]].map(([a, b]) => new THREE.Vector2(a, b)), 10), bx, g + 3.6, bz), C.gold));
    fires.push({ x: bx, y: g + 5.2, z: bz, s: 1.2 });
    ctx.prop('brazier', bx, bz, 2.0);
  }
  for (const [u, v] of rectCorners(x, z, yaw, 11, 10)) ctx.prop('throne', u, v, 0.5);
  ctx.prop('throne', x, z, 9);
  ctx.landmarks.push({ name: 'throne', x, z, r: 11, h: 24 });
  // colonnade along the open outer side of the turn
  for (let s2 = turn.s0 - 4; s2 < Math.min(turn.s1, (L.Z.throne || [{ s1: turn.s1 }])[0].s1) + 0.01; s2 += 6) {
    const f = track.frameAt(s2), lat = f.wallR + 1.15;
    const px = f.x + f.right.x * lat, pz = f.z + f.right.z * lat;
    B.struct.push(cyl(0.9, 1.05, THRONE_H + 0.2, 10, px, f.y + (THRONE_H + 0.2) / 2, pz, C.stone));
    B.struct.push(box(2.4, 1.0, 2.4, px, f.y + 0.5, pz, C.stoneDark, f.yaw));
    B.struct.push(box(2.4, 1.0, 2.4, px, f.y + THRONE_H - 0.3, pz, C.stoneDark, f.yaw));
    ctx.prop('column', px, pz, 1.05);
  }
}

// Chandeliers over the Throne Hall road: iron rings with candle flames.
function buildChandeliers(ctx, L, B, glow) {
  const { track } = ctx;
  for (const z of L.Z.throne || []) {
    const len = track.forwardDistance(z.s0, z.s1);
    for (let d = 40; d < len - 20; d += 24) {
      const f = track.frameAt(z.s0 + d), y = f.y + THRONE_H - 6;
      B.struct.push(cyl(0.05, 0.05, 5.5, 4, f.x, y + 2.9, f.z, C.iron));
      B.struct.push(paint(new THREE.TorusGeometry(2.2, 0.14, 4, 16).rotateX(Math.PI / 2).translate(f.x, y, f.z), C.gold));
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2, x = f.x + Math.cos(a) * 2.2, zz = f.z + Math.sin(a) * 2.2;
        B.struct.push(cyl(0.1, 0.1, 0.5, 4, x, y + 0.35, zz, 0xf2ead0));
        glow.push(paint(place(new THREE.ConeGeometry(0.12, 0.35, 5), x, y + 0.78, zz), C.flameHot));
      }
    }
  }
}

// The ramparts: merlons on both parapets, the castle wall faces down to the
// ground on the outside, banner poles; the spiral's outer curtain wall.
function buildRamparts(ctx, field, L, B, emblems) {
  const { track } = ctx;
  const ranges = [];
  for (const type of ['rampart', 'tower']) {
    for (const z of L.Z[type] || []) {
      const len = track.forwardDistance(z.s0, z.s1);
      const s0 = z.s0, s1 = z.s0 + len;
      ranges.push([s0, s1]);
      for (const side of [-1, 1]) {
        if (type === 'tower' && side < 0) {
          merlons(ctx, B.struct, s0, s1, side, { y: 1.15, h: 0.8, w: 1.0, gap: 3.0, T: 0.5 });
          continue;
        }
        merlons(ctx, B.struct, s0, s1, side, { y: 1.15, h: 1.1, w: 1.1, gap: 2.4, T: 0.6 });
        // castle wall face from the barrier down to the ground (outside)
        B.stone.push(paint(trackStrip(track, sRange(s0, s1, 2), 2, (f, s, c, o) => {
          const wall = side > 0 ? f.wallR : f.wallL;
          const upper = side > 0 ? c === 0 : c === 1;
          o.lat = side * (wall + 0.5);
          if (upper) { o.dy = -0.1; o.u = s / 4; o.v = f.y / 4; } else { o.y = LAVA - 1; o.dy = 0; o.u = s / 4; o.v = (LAVA - 1) / 4; }
        }), C.stone));
      }
      // banner poles on the outer parapet
      for (let s = s0 + 10; s < s1 - 5; s += 22) {
        const f = track.frameAt(s);
        const lat = (f.wallR + 1.2);
        const x = f.x + f.right.x * lat, zz = f.z + f.right.z * lat;
        if (field.wallClearance(x, zz) < 0.4) continue;
        B.struct.push(cyl(0.1, 0.12, 9, 5, x, f.y + 4.5, zz, C.iron));
        banner(emblems, x - f.tangent.x * 1.3, f.y + 6.6, zz - f.tangent.z * 1.3, f.yaw + Math.PI / 2, 2.2, 4.4);
        ctx.prop('pole', x, zz, 0.12);
      }
    }
  }
  return ranges;
}

// Decoration of the outer causeway: broken pillars, braziers, dead trees
// (spots), and a back-gate.
function buildCauseway(ctx, field, L, B, fires, deadSpots, rockSpots, rng) {
  const { track, Q } = ctx;
  for (const z of L.Z.causeway || []) {
    const len = track.forwardDistance(z.s0, z.s1);
    for (let d = 6; d < len - 4; d += 14) {
      const s = z.s0 + d, f = track.frameAt(s);
      for (const side of [-1, 1]) {
        const lat = side * ((side > 0 ? f.wallR : f.wallL) + 3.2);
        const x = f.x + f.right.x * lat, zz = f.z + f.right.z * lat;
        if (field.wallClearance(x, zz) < 2.4 || ctx.exclusions.some(([ex, ez, er]) => Math.hypot(x - ex, zz - ez) < er)) continue;
        const g = field.surfaceHeight(x, zz);
        if ((Math.round(d / 14) + (side > 0 ? 1 : 0)) % 2) {
          const h = lerp(3, 7.5, rng());
          B.struct.push(box(2.2, 0.6, 2.2, x, g + 0.2, zz, C.stoneDark, rng()));
          B.struct.push(cyl(0.75, 0.85, h, 8, x, g + h / 2 + 0.4, zz, C.stone, 0, (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.08));
          ctx.prop('pillar', x, zz, 1.5);
        } else {
          B.struct.push(cyl(0.3, 0.45, 2.8, 6, x, g + 1.4, zz, C.iron));
          B.struct.push(paint(place(new THREE.LatheGeometry([[0, 0], [1.0, 0.15], [1.3, 0.8], [1.1, 0.9], [0, 0.4]].map(([a, b]) => new THREE.Vector2(a, b)), 8), x, g + 2.8, zz), C.goldDark));
          fires.push({ x, y: g + 3.9, z: zz, s: 0.9 });
          ctx.prop('brazier', x, zz, 1.3);
        }
        ctx.exclusions.push([x, zz, 2.6]);
      }
    }
  }
  // dead trees + rocks over the ash plain
  const b = track.bounds;
  const n = Math.round(110 * Q.veg);
  for (let k = 0, tries = 0; deadSpots.length < n && tries < n * 40; tries++) {
    const x = lerp(b.minX - 260, b.maxX + 260, rng()), z = lerp(b.minZ - 260, b.maxZ + 260, rng());
    const clr = field.wallClearance(x, z), g = field.surfaceHeight(x, z);
    if (clr < 6 || g < LAVA + 0.8 || ctx.exclusions.some(([ex, ez, er]) => Math.hypot(x - ex, z - ez) < er + 2)) continue;
    deadSpots.push([x, g - 0.2, z, rng() * 6.28, lerp(0.7, 1.4, rng()), clr, 1.2]);
  }
  for (let k = 0, tries = 0; rockSpots.length < Math.round(140 * Q.veg) && tries < 6000; tries++) {
    const x = lerp(b.minX - 300, b.maxX + 300, rng()), z = lerp(b.minZ - 300, b.maxZ + 300, rng());
    const clr = field.wallClearance(x, z);
    if (clr < 4) continue;
    const sc = lerp(0.6, 3.2, rng() * rng());
    rockSpots.push([x, field.surfaceHeight(x, z) - 0.4 * sc, z, rng() * 6.28, sc, clr, 1.4 * sc]);
  }
}

// The south bailey: an obelisk island in the lava pool, spiked iron
// railings, barracks blocks, braziers.
function buildBailey(ctx, field, L, B, fires, emblems) {
  const x = 62, z = 2;
  if (field.wallClearance(x, z) < 20) return;
  const parts = [];
  parts.push(cyl(5.5, 7, 2.5, 10, x, LAVA + 0.4, z, C.basalt));
  parts.push(box(3.2, 1.2, 3.2, x, LAVA + 2.2, z, C.stoneDark));
  parts.push(paint(place(new THREE.CylinderGeometry(0.6, 1.5, 22, 4), x, LAVA + 13.6, z, Math.PI / 4), C.basalt));
  parts.push(cone(0.9, 2.4, 4, x, LAVA + 25.8, z, C.gold, Math.PI / 4));
  for (const p of parts) B.struct.push(p);
  ctx.prop('obelisk', x, z, 7);
  ctx.landmarks.push({ name: 'obelisk', x, z, r: 7, h: 28 });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4, bx = x + Math.cos(a) * 26, bz = z + Math.sin(a) * 26;
    if (field.wallClearance(bx, bz) < 4) continue;
    const g = field.surfaceHeight(bx, bz);
    B.struct.push(cyl(0.4, 0.6, 3.2, 6, bx, g + 1.6, bz, C.iron));
    B.struct.push(paint(place(new THREE.LatheGeometry([[0, 0], [1.2, 0.15], [1.6, 1.0], [1.3, 1.1], [0, 0.5]].map(([a2, b2]) => new THREE.Vector2(a2, b2)), 8), bx, g + 3.2, bz), C.goldDark));
    fires.push({ x: bx, y: g + 4.5, z: bz, s: 1.0 });
    ctx.prop('brazier', bx, bz, 1.6);
  }
}

// Volcano on the skyline (glowing crater + lava streaks) and dark hills.
function buildSkyline(ctx, L, glow, smoke) {
  const rng = makeRng(666);
  const geos = [];
  const { x: cx, z: cz } = L.center;
  const vx = cx + 260, vz = cz + 1150, vh = 420;
  geos.push(mountainGeometry(vx, vz, 560, vh, 14, (t, ny, y) => (t > 0.86 ? 0x5a2a1a : mixHex(0x2a2228, 0x3a3034, hash2(Math.round(y), 3)))));
  // crater glow + lava streaks down the flank facing the palace
  glow.push(paint(place(new THREE.CylinderGeometry(70, 70, 4, 14), vx, vh - 14 - 4, vz), 0xff6a1a));
  for (let k = 0; k < 5; k++) {
    const a = Math.PI + (k - 2) * 0.22 + (rng() - 0.5) * 0.1;
    const pts = [];
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const r = lerp(60, 470, t), y = lerp(vh - 18, -10, Math.pow(t, 0.9)) + 3;
      pts.push(new THREE.Vector3(vx + Math.sin(a + Math.sin(t * 6 + k) * 0.05) * r, y, vz + Math.cos(a + Math.sin(t * 6 + k) * 0.05) * r));
    }
    glow.push(paint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 14, 6 + k % 2 * 3, 4), 0xff5a10));
  }
  smoke.push([vx, vh, vz, 60, 0.2]);
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2 + (rng() - 0.5) * 0.2;
    const r = lerp(700, 1000, rng()), h = lerp(60, 170, rng());
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    if (Math.hypot(x - vx, z - vz) < 600) continue;
    geos.push(mountainGeometry(x, z, h * lerp(2.2, 3.0, rng()), h, 8, (t, ny, y) => (ny < 0.5 ? mixHex(0x221c22, 0x2c2428, hash2(Math.round(y), 5)) : mixHex(0x3a3034, 0x4a3a36, hash2(Math.round(y * 2), 9)))));
  }
  addMerged(ctx, geos, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), { name: 'Volcano' });
  ctx.landmarks.push({ name: 'volcano', x: vx, z: vz, r: 560, h: vh });
}

// Fires (braziers, the tower brazier): flickering flame clusters, one
// instanced draw call. Each = { x, y, z, s }.
function buildFires(ctx, fires) {
  if (!fires.length) return;
  const parts = [];
  for (const [ox, oz, r, h, col] of [[0, 0, 0.9, 2.6, C.flame], [0.5, 0.3, 0.55, 1.8, C.flameHot], [-0.5, -0.2, 0.6, 2.0, C.ember], [0.1, -0.5, 0.45, 1.5, C.flameHot]]) {
    parts.push(paint(place(new THREE.ConeGeometry(r, h, 6), ox, h / 2, oz), col));
  }
  const g = mergeParts(parts);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true });
  const inst = new THREE.InstancedMesh(g, mat, fires.length);
  inst.frustumCulled = false;
  const m4 = new THREE.Matrix4();
  const upd = (t) => {
    fires.forEach((f, i) => {
      const k = 1 + 0.12 * Math.sin(t * 11 + i * 1.7) + 0.08 * Math.sin(t * 23 + i);
      place_m4(m4, f.x, f.y - 0.4 * f.s, f.z, t * 0.8 + i, f.s * (2 - k), f.s * k, f.s * (2 - k));
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
  };
  upd(0);
  ctx.add(inst, { name: 'Fires' });
  ctx.animators.push((dt, t) => upd(t));
  ctx.stats.instances.fires = fires.length;
}

// Embers drifting up around the focus (one Points draw call).
function buildEmbers(ctx) {
  const n = ctx.Q.veg >= 1 ? 260 : 110;
  const pos = new Float32Array(n * 3), seed = new Float32Array(n * 3);
  const rng = makeRng(31);
  for (let i = 0; i < n; i++) { seed[i * 3] = rng(); seed[i * 3 + 1] = rng(); seed[i * 3 + 2] = rng(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xff8a2a, map: ctx.glowTex || null, size: 0.55, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  ctx.add(pts, { name: 'Embers' });
  const R = 60;
  ctx.animators.push((dt, t, camera) => {
    const cx = camera ? camera.position.x : 0, cy = camera ? camera.position.y : 5, cz = camera ? camera.position.z : 0;
    for (let i = 0; i < n; i++) {
      const a = seed[i * 3], b = seed[i * 3 + 1], c = seed[i * 3 + 2];
      const life = (t * (0.05 + c * 0.05) + a) % 1;
      // a fixed world grid cell around the camera keeps embers in place as it moves
      const gx = Math.floor(cx / (2 * R)) * 2 * R, gz = Math.floor(cz / (2 * R)) * 2 * R;
      let x = gx + a * 2 * R + Math.sin(t * 0.7 + i) * 1.5, z = gz + b * 2 * R + Math.cos(t * 0.6 + i) * 1.5;
      if (x - cx > R) x -= 2 * R; else if (cx - x > R) x += 2 * R;
      if (z - cz > R) z -= 2 * R; else if (cz - z > R) z += 2 * R;
      pos[i * 3] = x; pos[i * 3 + 1] = cy - 8 + life * 30; pos[i * 3 + 2] = z;
    }
    g.attributes.position.needsUpdate = true;
  });
}

// ------------------------------------------------------------------ hazards (drawn)

// Crushers (instanced blocks + chains + growing shadow squares + slam dust),
// flame arms (pivot pillars + instanced fireballs), geysers (vents + jets).
function buildHazardViews(ctx, field, L, hz, B, glow) {
  const { track } = ctx;
  const list = hz.list;
  const crushers = list.filter((h) => h.type === 'crusher');
  const arms = list.filter((h) => h.type === 'flamearm');
  const geysers = list.filter((h) => h.type === 'geyser');
  const CT = HAZARD_TUNE.crusher;
  const updaters = [];

  // ---- crushers: a 7 × 4.2 × 7 unit block, scaled per hazard size
  if (crushers.length) {
    const S = 1, Hc = CT.height;
    const parts = [box(S, Hc, S, 0, Hc / 2, 0, 0x9a94a0)];
    worldUVBox(parts[0], 1);
    for (const y of [0.7, Hc - 0.7]) parts.push(box(S + 0.02, 0.35, S + 0.02, 0, y, 0, C.iron));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(box(0.12, Hc + 0.02, 0.12, sx * S / 2, Hc / 2, sz * S / 2, C.iron));
    parts.push(box(S * 0.96, 0.06, S * 0.96, 0, 0.0, 0, 0x2a1c18));                   // scorched underside
    // studs on the four faces (two rows)
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2, nx = Math.sin(a), nz = Math.cos(a), tx = Math.cos(a), tz = -Math.sin(a);
      for (const y of [1.6, 2.6]) for (const t of [-0.3, 0, 0.3]) parts.push(box(0.08, 0.08, 0.04, nx * (S / 2 + 0.02) + tx * t * S, y, nz * (S / 2 + 0.02) + tz * t * S, C.ironLight, a));
    }
    const blockG = mergeParts(parts);
    const blockMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: B.stoneTex });
    const blocks = new THREE.InstancedMesh(blockG, blockMat, crushers.length);
    blocks.frustumCulled = false;
    ctx.add(blocks, { cast: true, receive: true, name: 'Crushers' });
    const chainG = paint(new THREE.CylinderGeometry(0.16, 0.16, 1, 5).translate(0, 0.5, 0), C.ironLight);
    const chains = new THREE.InstancedMesh(chainG, ctx.M.structure, crushers.length * 2);
    chains.frustumCulled = false;
    ctx.add(chains, { cast: false, name: 'CrusherChains' });
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const shadows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shadowMat, crushers.length);
    shadows.frustumCulled = false;
    ctx.add(shadows, { name: 'CrusherShadows' });
    // anchors: the hall ceiling or a stone gantry over the road
    const anchorY = crushers.map((h) => {
      const f = track.frameAt(h.s);
      const roofed = inType(track, L.Z, 'hall', h.s);
      return f.y + (roofed ? HALL_H : CT.hover + CT.height + 4.5);
    });
    const gantries = new Set();
    crushers.forEach((h, i) => {
      if (inType(track, L.Z, 'hall', h.s)) return;
      const key = Math.round(h.s);
      if (gantries.has(key)) return;
      gantries.add(key);
      const f = track.frameAt(h.s);
      const top = anchorY[i];
      for (const side of [-1, 1]) {
        const lat = side * ((side > 0 ? f.wallR : f.wallL) + 1.9);
        const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
        const g = Math.min(f.y, field.surfaceHeight(x, z)) - 2;
        const p = box(2.6, top + 1.5 - g, 3.2, x, (top + 1.5 + g) / 2, z, C.stone, f.yaw);
        worldUVBox(p, 4);
        B.stone.push(p);
        ctx.prop('gantry', x, z, 1.7);
      }
      const W = f.wallL + f.wallR + 6;
      const beam = box(W, 2.6, 3.4, f.x + f.right.x * (f.wallR - f.wallL) / 2, top + 1.3, f.z + f.right.z * (f.wallR - f.wallL) / 2, C.stone, f.yaw);
      worldUVBox(beam, 4);
      B.stone.push(beam);
      B.struct.push(box(W + 0.4, 0.4, 3.6, f.x + f.right.x * (f.wallR - f.wallL) / 2, top + 2.8, f.z + f.right.z * (f.wallR - f.wallL) / 2, C.gold, f.yaw));
    });
    const dust = [];
    const m4 = new THREE.Matrix4();
    updaters.push((t) => {
      crushers.forEach((h, i) => {
        const st = hazardState(h, t);
        let jx = 0, jz = 0;
        if (st.shaking) { jx = Math.sin(t * 61 + i) * 0.12; jz = Math.cos(t * 53 + i * 2) * 0.12; }
        const f = track.frameAt(h.s);
        const sc = h.size;
        const y = f.y + st.bottom;
        place_m4(m4, h.x + jx, y, h.z + jz, f.yaw, sc, 1, sc);
        blocks.setMatrixAt(i, m4);
        const top = y + CT.height, len = Math.max(0.01, anchorY[i] - top);
        for (const k of [0, 1]) {
          const off = (k ? 1 : -1) * sc * 0.25;
          place_m4(m4, h.x + f.right.x * off + jx, top, h.z + f.right.z * off + jz, 0, 1, len, 1);
          chains.setMatrixAt(i * 2 + k, m4);
        }
        // the shadow square grows as the block comes down
        const near = 1 - clamp(st.bottom / CT.hover, 0, 1);
        const ss = sc * lerp(0.55, 1.05, near) * (st.shaking ? 1.06 : 1);
        place_m4(m4, h.x, f.y + 0.03, h.z, f.yaw, ss, 1, ss);
        shadows.setMatrixAt(i, m4);
      });
      blocks.instanceMatrix.needsUpdate = true;
      chains.instanceMatrix.needsUpdate = true;
      shadows.instanceMatrix.needsUpdate = true;
    });
    for (const h of crushers) dust.push(h);
    ctx.stats.instances.crushers = crushers.length;
  }

  // ---- flame arms: pivot pillars (static), fireball chains (instanced)
  if (arms.length) {
    const FT = HAZARD_TUNE.flamearm;
    const BALLS = 7;
    for (const h of arms) {
      const f = track.frameAt(h.s);
      B.struct.push(cyl(FT.pillarRadius, FT.pillarRadius * 1.15, FT.pillarHeight + 0.6, 10, h.x, f.y + (FT.pillarHeight + 0.6) / 2 - 0.3, h.z, C.stone));
      B.struct.push(cyl(FT.pillarRadius * 1.2, FT.pillarRadius * 1.2, 0.3, 10, h.x, f.y + FT.pillarHeight + 0.15, h.z, C.gold));
      B.struct.push(ball(0.5, h.x, f.y + FT.height, h.z, C.iron));
      // (the pivot pillars stand in the off-road strip on purpose: touching one is a 'fire' hit, not a wall)
    }
    const fb = mergeParts([ball(1, 0, 0, 0, C.flame, 1, 1, 1, 1), ball(0.62, 0, 0.1, 0, C.flameHot, 1, 1, 1, 1)]);
    const fbMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true });
    const balls = new THREE.InstancedMesh(fb, fbMat, arms.length * BALLS);
    balls.frustumCulled = false;
    ctx.add(balls, { name: 'FlameArms' });
    const rodG = paint(new THREE.BoxGeometry(1, 0.14, 0.14).translate(0.5, 0, 0), C.iron);
    const rods = new THREE.InstancedMesh(rodG, ctx.M.structure, arms.length);
    rods.frustumCulled = false;
    ctx.add(rods, { name: 'FlameArmRods' });
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p3 = new THREE.Vector3(), s3 = new THREE.Vector3();
    updaters.push((t) => {
      arms.forEach((h, i) => {
        const st = hazardState(h, t);
        const f = track.frameAt(h.s);
        // arm direction in world space: angle from the tangent toward the right
        const dx = f.tangent.x * Math.cos(st.angle) + f.right.x * Math.sin(st.angle);
        const dz = f.tangent.z * Math.cos(st.angle) + f.right.z * Math.sin(st.angle);
        const y = f.y + FT.height;
        for (let k = 0; k < BALLS; k++) {
          const r = ((k + 1) / BALLS) * h.length;
          const fl = 0.5 + 0.08 * Math.sin(t * 17 + k * 2.1 + i);
          place_m4(m4, h.x + dx * r, y, h.z + dz * r, t * 3 + k, fl, fl, fl);
          balls.setMatrixAt(i * BALLS + k, m4);
        }
        e.set(0, Math.atan2(dx, dz) - Math.PI / 2, 0, 'YXZ');
        rods.setMatrixAt(i, m4.compose(p3.set(h.x, y, h.z), q.setFromEuler(e), s3.set(h.length, 1, 1)));
      });
      balls.instanceMatrix.needsUpdate = true;
      rods.instanceMatrix.needsUpdate = true;
    });
    ctx.stats.instances.flameArms = arms.length;
  }

  // ---- geysers: crusted vent rings on the road, glowing pools, jets
  if (geysers.length) {
    for (const h of geysers) {
      const f = track.frameAt(h.s);
      B.struct.push(paint(place(new THREE.RingGeometry(h.radius * 0.75, h.radius * 1.15, 14).rotateX(-Math.PI / 2), h.x, f.y + 0.06, h.z), 0x1a1214));
    }
    const ventMat = new THREE.MeshBasicMaterial({ color: 0xff6a1a, toneMapped: false, fog: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const vents = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2), ventMat, geysers.length);
    vents.frustumCulled = false;
    ctx.add(vents, { name: 'GeyserVents' });
    // a tapering lava fountain: glowing core, hot shell, a spray crown of
    // droplets at the top and a splash ring at the foot (unit height 1)
    const jetParts = [
      paint(new THREE.CylinderGeometry(0.32, 1.0, 1, 10, 1, true).translate(0, 0.5, 0), C.ember),
      paint(new THREE.CylinderGeometry(0.16, 0.55, 1.02, 8, 1, true).translate(0, 0.5, 0), C.flameHot),
      paint(new THREE.IcosahedronGeometry(0.42, 0).scale(1, 0.12, 1).translate(0, 1.0, 0), C.flame),
    ];
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2, r = 0.55 + (k % 2) * 0.25;
      jetParts.push(paint(new THREE.IcosahedronGeometry(0.16 + (k % 3) * 0.05, 0).scale(1, 0.12, 1).translate(Math.cos(a) * r, 0.9 + (k % 3) * 0.05, Math.sin(a) * r), k % 2 ? C.flame : C.flameHot));
    }
    jetParts.push(paint(new THREE.TorusGeometry(1.05, 0.22, 4, 12).rotateX(Math.PI / 2).scale(1, 0.05, 1), C.ember));
    const jetG = mergeParts(jetParts);
    const jetMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true, side: THREE.DoubleSide });
    const jets = new THREE.InstancedMesh(jetG, jetMat, geysers.length);
    jets.frustumCulled = false;
    ctx.add(jets, { name: 'GeyserJets' });
    const m4 = new THREE.Matrix4();
    const GT = HAZARD_TUNE.geyser;
    updaters.push((t) => {
      geysers.forEach((h, i) => {
        const st = hazardState(h, t);
        const f = track.frameAt(h.s);
        const pulse = st.bubbling ? 0.75 + 0.25 * Math.sin(t * 22 + i) : st.erupting ? 1.0 : 0.55;
        place_m4(m4, h.x, f.y + 0.04, h.z, 0, h.radius * 0.78 * pulse, 1, h.radius * 0.78 * pulse);
        vents.setMatrixAt(i, m4);
        const hgt = st.erupting ? GT.jetHeight * st.jet + 0.01 : st.bubbling ? 0.6 + 0.4 * Math.abs(Math.sin(t * 9 + i)) : 0.001;
        const w = (st.erupting ? h.radius * 0.95 : h.radius * 0.5) * (1 + 0.06 * Math.sin(t * 19 + i));
        place_m4(m4, h.x, f.y, h.z, t * 2, w, hgt, w);
        jets.setMatrixAt(i, m4);
      });
      vents.instanceMatrix.needsUpdate = true;
      jets.instanceMatrix.needsUpdate = true;
    });
    ctx.stats.instances.geysers = geysers.length;
  }

  // drawn at hz.time; tick the clock ourselves only if nobody else does
  ctx.animators.push((dt, time) => {
    if (!hz.driven) hz.time += dt;
    for (const u of updaters) u(hz.time);
  });
  for (const u of updaters) u(hz.time);
}

// ------------------------------------------------------------------ vegetation / rocks

function buildPalaceProps(ctx, deadSpots, rockSpots, rng) {
  const dead = mergeParts([
    paint(place(new THREE.CylinderGeometry(0.16, 0.34, 5, 5, 1, true), 0, 2.5, 0, 0, 0, 0.06), 0x231d1e),
    paint(place(new THREE.CylinderGeometry(0.06, 0.13, 2.6, 4, 1, true), 0.8, 4.4, 0, 0, 0, -0.7), 0x231d1e),
    paint(place(new THREE.CylinderGeometry(0.05, 0.11, 2.2, 4, 1, true), -0.7, 3.8, 0.3, 0, 0.3, 0.8), 0x231d1e),
    paint(place(new THREE.CylinderGeometry(0.04, 0.09, 1.8, 4, 1, true), 0.2, 5.6, -0.5, 0, -0.6, 0.2), 0x231d1e),
  ]);
  const rock = paint(lumpy(new THREE.DodecahedronGeometry(1.0, 0), 0.4, 1.2, 0.8, 1, 3), 0x2e2a2e);
  addInstancedSet(ctx, 'DeadTrees', dead, deadSpots, rng, { near: 25, tint: [0.8, 1.2] });
  addInstancedSet(ctx, 'Rocks', rock, rockSpots, rng, { near: 0, tints: [0x3a3438, 0x2a2628, 0x4a3a34], tint: [0.85, 1.15] });
}

// ------------------------------------------------------------------ buildPalaceWorld

export function buildPalaceWorld(scene, track, opts = {}) {
  const ctx = createWorldContext(scene, track, opts);
  const { Q } = ctx, sp = track.spacing;
  const L = palaceLayout(track);
  const rng = makeRng(666);
  const hz = createHazards(track);
  const inside = makeLoopInside(track, 6);
  const lavaAt = lavaAreas(track, L, inside);

  // A dim, warm sun high over the fortress (readable halls and ramparts),
  // a strong red-purple fill from the lava glow below.
  const sunDir = new THREE.Vector3(-0.28, 0.86, -0.42).normalize();
  buildSky(ctx, { sunDir, top: C.skyTop, horizon: C.skyHorizon, bottom: C.skyBottom, sunColor: 0xff9a5a, fogColor: 0x6e2a1a, fogNear: 220, fogFar: 1450 });
  const { sun, hemi, follow } = buildLights(ctx, { sunDir, sunColor: C.sun, sunIntensity: 2.4, hemiSky: C.hemiSky, hemiGround: C.hemiGround, hemiIntensity: 2.0 });
  const a = ctx.maxAniso;
  const T = createTrackTextures(ctx, {
    road: PTX.createPalaceRoadTexture({ aniso: a, size: Q.veg >= 1 ? 2048 : 1024 }),
    wall: TX.createCastleWallAtlasTexture({ aniso: a }),
    banner: { bg: ['#2a0a0e', '#120406'], outline: '#5a0a10' },
    curbColors: ['#8a1a1a', '#d9a52c'],
  });
  const stoneTex = ctx.tex(TX.createStoneBlockTexture({ aniso: a, seed: 109 }));
  const lavaTex = ctx.tex(TX.createLavaTexture({ aniso: a }));
  const fallTex = ctx.tex(TX.createLavaFallTexture({ aniso: a }));
  const glowTex = ctx.tex(TX.createGlowTexture());
  ctx.glowTex = glowTex;
  const M = {
    stone: new THREE.MeshLambertMaterial({ map: stoneTex, vertexColors: true }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true }),
    falls: new THREE.MeshBasicMaterial({ map: fallTex, toneMapped: false, fog: true, side: THREE.DoubleSide }),
    splats: new THREE.MeshBasicMaterial({ map: glowTex, color: 0xff7a2a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    banner: new THREE.MeshLambertMaterial({ map: ctx.tex(TX.createCrownKTexture({ shape: 'banner', aniso: a })), alphaTest: 0.5, side: THREE.DoubleSide }),
    shield: new THREE.MeshLambertMaterial({ map: ctx.tex(TX.createCrownKTexture({ shape: 'shield', size: 512, aniso: a })), alphaTest: 0.5, emissive: 0x2a1004 }),
    square: new THREE.MeshLambertMaterial({ map: ctx.tex(TX.createCrownKTexture({ shape: 'square', aniso: a })), emissive: 0x2a1004 }),
    planks: decalMaterial({ map: ctx.tex(TX.createPlankTexture({ aniso: a, base: [120, 80, 52], planks: 8, iron: true, seed: 96 })) }),
    carpet: decalMaterial({ color: C.carpet, roughness: 0.95 }),
    steps: decalMaterial({ color: 0x0e0c10, transparent: true, opacity: 0.55 }),
  };
  // v5 materials: lava-cracked basalt (pulsing emissive cracks), forge plates,
  // tunnel grates, banquet marble, hazard lines, stained glass
  const lavaStone = PTX.createLavaStoneTextures({ aniso: a });
  ctx.tex(lavaStone.map); ctx.tex(lavaStone.glow);
  M.lavaStone = new THREE.MeshLambertMaterial({ map: lavaStone.map, emissiveMap: lavaStone.glow, emissive: 0xff5a14, emissiveIntensity: 1.0, vertexColors: true });
  M.plates = decalMaterial({ map: ctx.tex(PTX.createIronPlateTexture({ aniso: a })), roughness: 0.55, metalness: 0.35 });
  M.grates = new THREE.MeshBasicMaterial({ map: ctx.tex(PTX.createGrateTexture({ aniso: a })), toneMapped: false, fog: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  M.marble = decalMaterial({ map: ctx.tex(PTX.createMarbleTexture({ aniso: a })), color: 0xb4acb0, roughness: 0.32, metalness: 0.05 });
  M.hazard = decalMaterial({ map: T.hazard, roughness: 0.7 });
  M.windows = new THREE.MeshBasicMaterial({ map: ctx.tex(PTX.createStainedGlassTexture()), toneMapped: false, fog: true, side: THREE.DoubleSide });
  const PT = { belt: PTX.createBeltTextures({ aniso: a }) };
  ctx.tex(PT.belt.map); ctx.tex(PT.belt.glow);

  // terrain: fortress ground, ash plain, lava hollows; steep castle walls
  // under the elevated spiral / ramparts / throne hall entrance
  const Z = L.Z;
  const isType = (type, s) => inType(track, Z, type, s);
  const field = createTerrainField(track, Q.terrainCell, {
    natural: palaceNatural(track, L, lavaAt, inside),
    signedDist: () => 1,
    extent: 1700,
    sections: (tr, { bridge, fillL, fillR, shL, shR }) => {
      for (let i = 0; i < tr.N; i++) {
        const s = i * sp;
        if (L.bridge) {
          const d0 = tr.forwardDistance(L.bridge.s0 + 6, s), len = tr.forwardDistance(L.bridge.s0 + 6, L.bridge.s1);
          if (d0 <= len) bridge[i] = smoothstep(Math.min(d0, len - d0) / 4);
        }
        if (isType('tower', s) || isType('rampart', s) || (isType('throne', s) && tr.py[i] > 4.5) || tr.py[i] > 4) {
          fillL[i] = fillR[i] = 7; shL[i] = shR[i] = 1.0;
        }
      }
    },
    bridgeFloor: () => LAVA - 2,
  });
  ctx.add(new THREE.Mesh(terrainGeometry(field, palaceTerrainColor(track, L, lavaAt, inside)),
    new THREE.MeshLambertMaterial({ vertexColors: true, map: T.detail, flatShading: true })), { receive: true, name: 'Terrain' });
  buildLava(ctx, L.center, lavaTex);

  // road: flagstones; darker under the roofs; ash / flagstone strips
  const B = {
    stone: regionBuckets(ctx, M.stone, { name: 'Castle', cell: 260 }),
    struct: regionBuckets(ctx, ctx.M.structure, { name: 'CastleProps', cell: 260 }),
    roof: regionBuckets(ctx, ctx.M.structure, { name: 'Roofs', cell: 600, cast: false }),
    lavaStone: regionBuckets(ctx, M.lavaStone, { name: 'LavaStone', cell: 600 }),
    stoneTex,
  };
  const glow = [], falls = [], decals = [], carpet = [], steps = [], fires = [], smoke = [];
  glow.splats = [];
  const emblems = { banner: [], shield: [], square: [] };
  const roofed = buildHalls(ctx, field, L, B, glow, emblems);
  // v5 rooms (world-palace-rooms.js): the forge wing, the Banquet Hall, the Portcullis Run
  const v5decals = { plates: [], grates: [], marble: [], hazard: [] }, windows = [];
  const P = { ctx, track, field, L, B, glow, falls, fires, smoke, emblems, decals: v5decals, windows, M, T, PT };
  const forgeAnim = buildForge(P, hz);
  buildLavafallTunnel(P, hz);
  buildBanquetHall(P, hz);
  buildPortcullisRun(P, hz);
  const anvilAnim = buildAnvil(P);
  for (const type of ['forge', 'lavafall', 'banquet']) for (const z of Z[type] || []) roofed.push([z.s0, z.s0 + track.forwardDistance(z.s0, z.s1)]);
  const roofShade = (s) => {
    let k = 1;
    for (const [s0, s1] of roofed) {
      const d = track.forwardDistance(s0, s), len = track.forwardDistance(s0, s1);
      if (d <= len) k = Math.min(k, 1 - 0.25 * smoothstep(Math.min(d, len - d) / 6));
    }
    return k;
  };
  buildRoad(ctx, T, {
    offroadColor: (s) => (isType('bridge', s) ? C.wood : isType('causeway', s) ? 0x5a5458 : 0x4a4550),
    shade: roofShade,
    roadRoughness: 0.8,
  });
  buildStartLine(ctx, T);
  buildWalls(ctx, T, (i, side) => {
    const s = i * sp;
    if (isType('bridge', s)) return 'chain';
    if (isType('lava', s) || isType('lavafall', s)) return 'lava';
    if (isType('hall', s) || isType('throne', s) || isType('banquet', s)) return 'banner';
    return 'parapet';
  }, {
    parapet: { band: TX.CASTLE_WALL_BANDS.parapet, h: 1.15 },
    banner: { band: TX.CASTLE_WALL_BANDS.banner, h: 1.15 },
    chain: { band: TX.CASTLE_WALL_BANDS.chain, h: 1.15 },
    lava: { band: TX.CASTLE_WALL_BANDS.lava, h: 1.0 },
  });
  buildBoostPads(ctx, T);
  buildRamps(ctx, T);
  buildTurnSigns(ctx, T, { postColor: 0x2a2630, skip: (s) => isType('hall', s) || isType('throne', s) || isType('stairs', s) || isType('forge', s) || isType('lavafall', s) || isType('banquet', s) });
  buildGantry(ctx, T, { pillarA: C.basalt, pillarB: C.goldDark, base: C.stoneDark, beam: 0x2a2228, frame: 0x5a0a10 });

  // decals: drawbridge planks, the throne hall's red carpet, stair edges
  const deckRange = buildDrawbridge(ctx, field, L, B, decals);
  for (const z of Z.throne || []) {
    const r = track.ramps[1];
    const s0 = r ? Math.max(z.s0, r.s1 + 24) : z.s0;
    carpet.push(roadDecal(ctx, s0, z.s1 + 12, { latA: () => -2.4, latB: () => 2.4, tile: 4, dy: 0.014 }));
    for (const side of [-1, 1]) carpet.push(roadDecal(ctx, s0, z.s1 + 12, { latA: () => side * 2.4 - 0.22, latB: () => side * 2.4 + 0.22, tile: 4, dy: 0.016 }));
  }
  for (const z of Z.stairs || []) {
    const len = track.forwardDistance(z.s0, z.s1);
    for (let d = 3; d < len - 1; d += 3.4) steps.push(roadDecal(ctx, z.s0 + d, z.s0 + d + 0.35, { tile: 1, step: 0.35, dy: 0.013 }));
  }

  // landmarks
  if (L.frontGate) buildGate(ctx, field, L.frontGate.s0 + (track.forwardDistance(L.frontGate.s0, L.frontGate.s1)) * 0.45, B, glow, emblems, { scale: 1, shield: true, towerH: 22 });
  // the back gate: out of the Back Gate Turn onto the Home Straight (v5: the Portcullis Run has its own gate arches)
  { const bg = L.seg('Back Gate Turn'); if (bg) buildGate(ctx, field, bg.s1 + 3, B, glow, emblems, { scale: 0.78, shield: false, towerH: 15 }); }
  buildCurtainWalls(ctx, field, L, B, falls, glow, emblems);
  buildGalleryFalls(ctx, field, L, falls);
  buildFlameTower(ctx, field, L, B, glow, fires);
  buildKeep(ctx, field, L, B, emblems);
  buildThrone(ctx, field, L, B, glow, emblems, fires);
  buildChandeliers(ctx, L, B, glow);
  const elevated = buildRamparts(ctx, field, L, B, emblems);
  buildBailey(ctx, field, L, B, fires, emblems);
  // Rampart Leap doorway: an arch wall across the road at the throne hall entrance
  {
    const r = track.ramps[1];
    if (r) {
      const f = track.frameAt(r.s0 - 3), W = f.wallL + f.wallR + 3.2, H = 13, latC = (f.wallR - f.wallL) / 2;
      const P = (along) => [f.x + f.right.x * latC + f.tangent.x * along, f.z + f.right.z * latC + f.tangent.z * along];
      const [x, z] = P(0);
      const lintel = box(W, THRONE_H + 2 - H, 3, x, f.y + (H + THRONE_H + 2) / 2, z, C.stone, f.yaw);
      worldUVBox(lintel, 4);
      B.stone.push(lintel);
      B.struct.push(box(W + 0.4, 0.4, 3.4, x, f.y + H, z, C.gold, f.yaw));
      banner(emblems, x - f.tangent.x * 1.6, f.y + H + 2.4, z - f.tangent.z * 1.6, f.yaw + Math.PI, 3.0, 6.0);
    }
  }
  // causeway decoration, dead trees, rocks
  const deadSpots = [], rockSpots = [];
  buildCauseway(ctx, field, L, B, fires, deadSpots, rockSpots, rng);
  buildHazardViews(ctx, field, L, hz, B, glow);
  // v5 set pieces (world-palace-setpieces.js), drawn at the same hazard clock
  const views = buildSetPieces(P, hz);
  ctx.animators.push(() => views.update(hz.time));
  views.update(hz.time);
  if (forgeAnim) ctx.animators.push(forgeAnim);
  if (anvilAnim) ctx.animators.push(anvilAnim);
  ctx.animators.push((dt, t) => { M.lavaStone.emissiveIntensity = 0.8 + 0.2 * Math.sin(t * 1.4) + 0.08 * Math.sin(t * 5.3); });
  buildSkyline(ctx, L, glow, smoke);

  // flags (red / black / gold) at the start
  for (const s of [-24, 26]) {
    const f = track.frameAt(s);
    for (const side of [-1, 1]) {
      const lat = side * ((side > 0 ? f.wallR : f.wallL) + 1.2);
      const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
      if (field.wallClearance(x, z) > 0.6) ctx.flagSpots.push([x, field.surfaceHeight(x, z) - 0.05, z, f.yaw, true]);
    }
  }

  B.stone.flush();
  B.struct.flush();
  B.roof.flush();
  B.lavaStone.flush();
  if (!addMerged(ctx, v5decals.plates, M.plates, { receive: true, name: 'ForgePlates' })) M.plates.dispose();
  if (!addMerged(ctx, v5decals.grates, M.grates, { name: 'TunnelGrates' })) M.grates.dispose();
  if (!addMerged(ctx, v5decals.marble, M.marble, { receive: true, name: 'BanquetFloor' })) M.marble.dispose();
  if (!addMerged(ctx, v5decals.hazard, M.hazard, { receive: true, name: 'HazardLines' })) M.hazard.dispose();
  if (!addMerged(ctx, windows, M.windows, { name: 'StainedGlass' })) M.windows.dispose();
  if (!addMerged(ctx, glow.splats, M.splats, { name: 'TorchLight' })) M.splats.dispose();
  if (!addMerged(ctx, glow, M.glow, { name: 'Glow' })) M.glow.dispose();
  else ctx.animators.push((dt, t) => { const k = 0.85 + 0.1 * Math.sin(t * 13) + 0.05 * Math.sin(t * 31); M.glow.color.setRGB(k, k, k); });
  if (!addMerged(ctx, falls, M.falls, { name: 'LavaFalls' })) M.falls.dispose();
  else ctx.animators.push((dt, t) => { fallTex.offset.set(0, (-t * 0.35) % 1); });
  for (const [key, list] of Object.entries(emblems)) {
    if (!addMerged(ctx, list.map((g) => paint(g, null)), M[key], { name: `Emblem_${key}` })) M[key].dispose();
  }
  if (!addMerged(ctx, decals, M.planks, { receive: true, name: 'Drawbridge' })) M.planks.dispose();
  if (!addMerged(ctx, carpet, M.carpet, { receive: true, name: 'Carpet' })) M.carpet.dispose();
  if (!addMerged(ctx, steps, M.steps, { name: 'StairEdges' })) M.steps.dispose();
  buildFires(ctx, fires);
  buildPuffs(ctx, smoke, { light: 0x5a4a4a, dark: 0x2a2224, rise: 3, rate: 0.03, name: 'Smoke', per: 6 });
  buildFlags(ctx, ctx.flagSpots, [0x9c1420, 0x1a1418, 0xd9a52c]);
  buildPalaceProps(ctx, deadSpots, rockSpots, rng);
  buildEmbers(ctx);

  ctx.stats.bridges = [...(deckRange ? [deckRange] : []), ...elevated].map(([s0, s1]) => [+s0.toFixed(1), +s1.toFixed(1)]);
  ctx.stats.hazards = hz.list.length;
  const world = finishWorld(ctx, {
    sun, hemi, follow,
    getGroundHeight: (x, z) => field.surfaceHeight(x, z),
    extra: { hazards: hz, lavaLevel: LAVA },
  });
  const disposeWorld = world.dispose;
  world.dispose = () => { views.dispose(); disposeWorld(); };
  return world;
}
