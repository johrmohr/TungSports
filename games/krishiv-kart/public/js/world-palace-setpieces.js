// Krishiv's Palace v5 set pieces, drawn (browser only, SPEC §16.1): the
// Forge's reversing conveyor belts, the Lavafall Tunnel's lava curtains, the
// Banquet Hall's swinging chandeliers and the Portcullis Run's gate leaves.
// Everything is drawn from the hazard set's clock (hz.time, hz.stateAt — the
// same pure functions the game, the sim and the CPUs use: hazards/castle.js),
// so what you see is exactly what hits. Telegraphs: belt lane colours +
// chevrons + amber strobes; curtain drips + a floor glow growing under the
// slot; chandelier shadows darkening on the floor as the ring comes low;
// portcullis leaves rattling / sagging, red warning lamps and a shadow band.
// Each timed piece also has an audio cue (world-palace-sounds.js, played by
// main.js through the bus `item:sfx`), and a chandelier knock shows BONK!
// (bus `hud:flash`) on the knocked human's view. No bus listeners are kept.
//
//   const views = buildSetPieces(P, hz);   // P = the palace build context (see world-palace-rooms.js)
//   views.update(t)                        // every frame at hz.time (world-palace.js animator)
//   views.dispose()                        // drop the per-frame work (the world kit's dispose calls it)

import * as THREE from 'three';
import { clamp, smoothstep } from './utils.js';
import { place, paint, place_m4, box, cyl, ball, cone, mergeParts, roadDecal, trackStrip, sRange } from './world.js';
import { C } from './world-palace-kit.js';
import { HAZARD_TUNE, chandelierPose } from './hazards/castle.js';
import { PALACE_SOUNDS, registerPalaceSounds } from './world-palace-sounds.js';
import { GATE_BEAM, TUNNEL_H } from './world-palace-rooms.js';
import { bus } from './bus.js';

const BELT_LIFT = 0.085;   // the belt surface sits just above the curbs (7 cm)

export function buildSetPieces(P, hz) {
  const { ctx, track, B } = P;
  const list = hz.list;
  const updaters = [];
  const cues = [];                       // (t) => void, sound / banner triggers on state changes
  let live = false;                      // cues sound only while the clock runs forward (not on seeks)
  const sfx = (name, pos, volume = 1) => { if (live) bus.emit('item:sfx', { name, position: pos, volume }); };
  try { registerPalaceSounds(); } catch (err) { console.warn('[palace] sounds unavailable', err && err.message); }
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e3 = new THREE.Euler(), p3 = new THREE.Vector3(), s3 = new THREE.Vector3();
  const col = new THREE.Color();

  // ---------------------------------------------------------------- belts
  const belts = list.filter((h) => h.type === 'belt');
  if (belts.length) {
    const BT = P.PT.belt;
    const groups = new Map();                                         // by startDir: centre (+1) / sides (-1)
    for (const h of belts) { const k = h.startDir || 1; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(h); }
    const TILE = 3.2;
    for (const [dir, hs] of groups) {
      const strips = [];
      for (const h of hs) {
        const f = track.frameAt(h.s);
        const a = Math.max(h.latA, -(f.wallL + 0.45)), b = Math.min(h.latB, f.wallR + 0.45);
        strips.push(trackStrip(track, sRange(h.s, h.s + h.len, 1), 2, (ff, s, c, o) => {
          o.lat = c ? b : a; o.dy = BELT_LIFT; o.u = c ? Math.max(1, Math.round((b - a) / 3.5)) : 0; o.v = (s - h.s) / TILE;
        }));
      }
      const map = BT.map.clone(), glowMap = BT.glow.clone();
      map.needsUpdate = glowMap.needsUpdate = true;
      ctx.textures.push(map, glowMap);
      const mat = new THREE.MeshLambertMaterial({ map, emissiveMap: glowMap, emissive: 0x22ff66, emissiveIntensity: 1.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const g = mergeParts(strips.map((x) => paint(x, null)));
      ctx.add(new THREE.Mesh(g, mat), { receive: true, name: dir > 0 ? 'BeltCentre' : 'BeltSides' });
      const h0 = hs[0];
      let rep = 1;
      updaters.push((t) => {
        const st = hz.stateAt(h0, t);
        if (st.dir !== 0) rep = st.dir > 0 ? 1 : -1;                  // chevrons point the way the belt runs
        map.repeat.y = glowMap.repeat.y = rep;
        const off = -rep * (st.travel / TILE);
        map.offset.y = glowMap.offset.y = off - Math.floor(off);
        if (st.dir > 0) mat.emissive.setHex(0x22ff66);
        else if (st.dir < 0) mat.emissive.setHex(0xff2a1a);
        else mat.emissive.setHex(Math.floor(t * 10) % 2 ? 0xffaa00 : 0x332200);   // amber strobe in the stops
      });
    }
    // lane dividers (raised iron rails), rollers at both ends, hazard-striped end plates
    const h = belts[0];
    const lats = [...new Set(belts.flatMap((x) => [x.latA, x.latB]))].filter((l) => {
      const f = track.frameAt(h.s);
      return l > -(f.wallL) && l < f.wallR;
    });
    for (const l of lats) {
      B.struct.push(paint(trackStrip(track, sRange(h.s, h.s + h.len, 2), 2, (f, s, c, o) => { o.lat = l + (c ? 0.16 : -0.16); o.dy = BELT_LIFT + 0.07; }), C.ironLight));
    }
    for (const sEnd of [h.s, h.s + h.len]) {
      const f = track.frameAt(sEnd), W = f.wallL + f.wallR + 0.9, latC = (f.wallR - f.wallL) / 2;
      const x = f.x + f.right.x * latC, z = f.z + f.right.z * latC;
      B.struct.push(cyl(0.22, 0.22, W, 10, x, f.y + BELT_LIFT - 0.1, z, 0x7a7a84, f.yaw, 0, Math.PI / 2));
      P.decals.hazard.push(roadDecal(ctx, sEnd - (sEnd === h.s ? 1.0 : 0), sEnd + (sEnd === h.s ? 0 : 1.0), { latA: (ff) => -(ff.wallL + 0.45), latB: (ff) => ff.wallR + 0.45, tile: 1.0, uSpan: 1.6, dy: 0.016, step: 0.5 }));
    }
    // amber beacons on both walls at both ends (one mesh, strobing in the stops)
    const bparts = [];
    const bpos = [];
    for (const sEnd of [h.s - 1, h.s + h.len + 1]) {
      const f = track.frameAt(sEnd);
      for (const side of [-1, 1]) {
        const w = side > 0 ? f.wallR : f.wallL;
        const x = f.x + f.right.x * side * (w - 0.25), z = f.z + f.right.z * side * (w - 0.25);
        B.struct.push(box(0.5, 0.5, 0.5, x, f.y + 3.6, z, C.iron, f.yaw));
        bparts.push(paint(place(new THREE.CylinderGeometry(0.26, 0.3, 0.5, 8), x, f.y + 4.1, z), 0xffaa22));
        bpos.push({ x, y: f.y + 4, z });
      }
    }
    const bmat = ctx.Q.veg >= 1 ? new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true }) : null;
    if (bmat) ctx.add(new THREE.Mesh(mergeParts(bparts), bmat), { name: 'BeltBeacons' });   // 'low': the belts' own strobe only
    else bparts.forEach((g) => g.dispose());
    let wasStopped = null;
    const clunkAt = { x: (bpos[0].x + bpos[3].x) / 2, y: bpos[0].y, z: (bpos[0].z + bpos[3].z) / 2 };
    if (bmat) {
      updaters.push((t) => {
        const st = hz.stateAt(h, t);
        const k = st.stopped ? (Math.floor(t * 10) % 2 ? 1.6 : 0.25) : 0.3;
        bmat.color.setRGB(k, k, k);
      });
    }
    cues.push((t) => {
      const st = hz.stateAt(h, t);
      if (wasStopped === false && st.stopped) sfx(PALACE_SOUNDS.beltClunk, clunkAt, 1.0);
      wasStopped = st.stopped;
    });
    ctx.stats.instances.belts = belts.length;
  }

  // ---------------------------------------------------------------- lava curtains
  const curtains = list.filter((h) => h.type === 'curtain');
  if (curtains.length) {
    const CT = HAZARD_TUNE.curtain;
    const H = TUNNEL_H - 0.5;
    const info = curtains.map((h) => {
      const f = track.frameAt(h.s);
      const a = Math.max(h.latA, -(f.wallL + 0.3)), b = Math.min(h.latB, f.wallR + 0.3);
      const latC = (a + b) / 2;
      return { h, f, W: b - a, x: f.x + f.right.x * latC, z: f.z + f.right.z * latC, y: f.y, prev: null };
    });
    // the sheet: a unit-height slab (pour falls from the slot to the floor), double-sided lava-fall material
    const sheetG = new THREE.BoxGeometry(1, 1, 1);
    const uvs = sheetG.attributes.uv;
    for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * 4, uvs.getY(i) * 1.6);   // ~3 m streaks across a 12 m curtain
    sheetG.translate(0, -0.5, 0);                                   // origin at the top (the slot)
    const sheets = new THREE.InstancedMesh(sheetG, P.M.falls, curtains.length);
    sheets.frustumCulled = false;
    ctx.add(sheets, { name: 'LavaCurtains' });
    // drips: little glowing drops falling from the slot during the warning
    const DR = 7;
    const dropG = paint(new THREE.IcosahedronGeometry(0.16, 0).scale(1, 1.8, 1), C.flame);
    const drops = new THREE.InstancedMesh(dropG, P.M.glow, curtains.length * DR);
    drops.frustumCulled = false;
    ctx.add(drops, { name: 'LavaDrips' });
    // floor glow growing under the band (additive), and the splash crown while pouring
    const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: ctx.glowTex || null, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: true, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }), curtains.length);
    pool.frustumCulled = false;
    ctx.add(pool, { name: 'CurtainGlow' });
    const splashG = paint(new THREE.TorusGeometry(0.5, 0.18, 4, 14).rotateX(Math.PI / 2).scale(1, 0.5, 1), C.flame);
    const splash = ctx.Q.veg >= 1 ? new THREE.InstancedMesh(splashG, P.M.glow, curtains.length) : null;   // 'low': no splash crowns
    if (splash) { splash.frustumCulled = false; ctx.add(splash, { name: 'CurtainSplash' }); } else splashG.dispose();
    updaters.push((t) => {
      info.forEach((c, i) => {
        const st = hz.stateAt(c.h, t);
        // sheet: grows down during the first 12 % of the pour, thins away at the end
        let top = H, bot = H, thick = 0.5;
        if (st.pouring) {
          const u = st.pour;
          bot = H * (1 - smoothstep(u / 0.12));
          if (u > 0.9) top = H * (1 - smoothstep((u - 0.9) / 0.1));        // the last of it falls away
          thick = 0.45 + 0.25 * Math.sin(t * 23 + i);
        }
        const len = Math.max(0.001, top - bot);
        place_m4(m4, c.x, c.y + top, c.z, c.f.yaw, c.W, len, st.pouring ? thick : 0.001);
        sheets.setMatrixAt(i, m4);
        // drips during the warning (and a few while pouring)
        for (let k = 0; k < DR; k++) {
          const lat = (k + 0.5) / DR - 0.5;
          const tau = ((t * 1.05 + k * 0.37) % 1) * 0.95;                // each drop falls from the slot to the floor
          const y = H - 0.4 - 10 * tau * tau;
          const vis = st.dripping && y > 0.2;
          const x = c.x + c.f.right.x * lat * c.W * 0.9, z = c.z + c.f.right.z * lat * c.W * 0.9;
          place_m4(m4, x, c.y + Math.max(0.2, y), z, 0, vis ? 1 : 0.001, vis ? 1 : 0.001, vis ? 1 : 0.001);
          drops.setMatrixAt(i * DR + k, m4);
        }
        // floor glow: dim idle, growing through the drip, full while pouring
        const gl = st.pouring ? 1 : st.dripping ? 0.25 + 0.75 * st.drip : 0.12;
        place_m4(m4, c.x, c.y + 0.06, c.z, c.f.yaw, c.W * (0.9 + 0.2 * gl), 1, 4.5 + 2 * gl);
        pool.setMatrixAt(i, m4);
        pool.setColorAt(i, col.setRGB(1.0 * gl, 0.45 * gl, 0.1 * gl));
        const sv = st.pouring && st.pour > 0.1 && st.pour < 0.95;
        if (splash) {
          place_m4(m4, c.x, c.y + 0.1, c.z, c.f.yaw, sv ? c.W * 1.05 : 0.001, sv ? 1 + 0.3 * Math.sin(t * 19 + i) : 0.001, sv ? 2.2 : 0.001);
          splash.setMatrixAt(i, m4);
        }
      });
      sheets.instanceMatrix.needsUpdate = true;
      drops.instanceMatrix.needsUpdate = true;
      pool.instanceMatrix.needsUpdate = true;
      if (pool.instanceColor) pool.instanceColor.needsUpdate = true;
      if (splash) splash.instanceMatrix.needsUpdate = true;
    });
    cues.push((t) => {
      for (const c of info) {
        const st = hz.stateAt(c.h, t);
        const now = st.pouring ? 2 : st.dripping ? 1 : 0;
        if (c.prev !== null && now !== c.prev) {
          const pos = { x: c.x, y: c.y + 2, z: c.z };
          if (now === 1) sfx(PALACE_SOUNDS.lavaDrip, pos, 0.9);
          else if (now === 2) sfx(PALACE_SOUNDS.lavaPour, pos, 1.0);
        }
        c.prev = now;
      }
    });
    ctx.stats.instances.curtains = curtains.length;
  }

  // ---------------------------------------------------------------- chandeliers
  const chands = list.filter((h) => h.type === 'chandelier');
  if (chands.length) {
    const R = chands[0].radius, Lc = chands[0].chain;
    // iron part (pivot-local: chain down -y to the crown, three short chains to the ring, the ring, spokes, candle cups)
    const iron = [
      cyl(0.09, 0.09, Lc - 2.2, 5, 0, -(Lc - 2.2) / 2, 0, C.ironLight),
      paint(new THREE.TorusGeometry(R, 0.24, 6, 24).rotateX(Math.PI / 2).translate(0, -Lc, 0), C.iron),
      paint(new THREE.TorusGeometry(R + 0.05, 0.08, 4, 24).rotateX(Math.PI / 2).translate(0, -Lc + 0.2, 0), C.gold),
      paint(new THREE.TorusGeometry(R * 0.55, 0.14, 5, 16).rotateX(Math.PI / 2).translate(0, -Lc - 0.35, 0), C.gold),
      ball(0.35, 0, -Lc + 0.1, 0, C.gold),
      cone(0.22, 0.6, 6, 0, -Lc - 0.45, 0, C.gold, 0, 0, Math.PI),
    ];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2, x = Math.cos(a) * R, z = Math.sin(a) * R;
      const len = Math.hypot(R, 2.2);
      const g = new THREE.CylinderGeometry(0.05, 0.05, len, 4);
      g.rotateX(Math.atan2(R, 2.2)).rotateY(-a + Math.PI / 2);
      iron.push(paint(g.translate(x / 2, -Lc + 1.1, z / 2), C.ironLight));
    }
    const CN = 10;
    for (let k = 0; k < CN; k++) {
      const a = (k / CN) * Math.PI * 2, x = Math.cos(a) * R, z = Math.sin(a) * R;
      iron.push(cyl(0.11, 0.11, 0.42, 5, x, -Lc + 0.28, z, 0xf2ead0));
      iron.push(box(0.08, 0.08, R * 0.9, x / 2, -Lc, z / 2, C.iron, -a + Math.PI / 2));
    }
    const ironG = mergeParts(iron);
    const flames = [
      // a fire bowl in the middle of the ring: the chandelier reads as a burning weight from far away
      paint(new THREE.CylinderGeometry(0.75, 0.35, 0.45, 10).translate(0, -Lc - 0.05, 0), C.ember),
      paint(new THREE.ConeGeometry(0.55, 1.3, 7).translate(0, -Lc + 0.75, 0), C.flame),
      paint(new THREE.ConeGeometry(0.32, 0.95, 6).translate(0.15, -Lc + 0.6, 0.1), C.flameHot),
    ];
    for (let k = 0; k < CN; k++) {
      const a = (k / CN) * Math.PI * 2;
      flames.push(paint(place(new THREE.ConeGeometry(0.12, 0.42, 5), Math.cos(a) * R, -Lc + 0.68, Math.sin(a) * R), C.flameHot));
    }
    const flameG = mergeParts(flames);
    const rings = new THREE.InstancedMesh(ironG, ctx.M.structure, chands.length);
    rings.frustumCulled = false;
    ctx.add(rings, { cast: true, name: 'Chandeliers' });
    const lights = new THREE.InstancedMesh(flameG, P.M.glow, chands.length);
    lights.frustumCulled = false;
    ctx.add(lights, { name: 'ChandelierFlames' });
    // floor shadow under the ring, darker as it comes down (the telegraph)
    const shMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.75, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5, map: ctx.glowTex || null });
    const shadows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shMat, chands.length);
    shadows.frustumCulled = false;
    ctx.add(shadows, { name: 'ChandelierShadows' });
    const pose = {};
    const info = chands.map((h) => ({ h, f: track.frameAt(h.s), lastSide: null }));
    updaters.push((t) => {
      info.forEach((c, i) => {
        const { h, f } = c;
        chandelierPose(h, t, pose);
        // pivot over (s, lateral); rotation about the track tangent: + theta swings toward the right
        p3.set(h.x, f.y + h.pivot, h.z);
        e3.set(0, f.yaw, -pose.theta, 'YXZ');      // local +x = -right, so a right swing is a negative roll
        q4.setFromEuler(e3);
        m4.compose(p3, q4, s3.set(1, 1, 1));
        rings.setMatrixAt(i, m4);
        lights.setMatrixAt(i, m4);
        const low = clamp(1 - (pose.height - 0.6) / 4.5, 0, 1);
        const sx = f.x + f.right.x * pose.lat, sz = f.z + f.right.z * pose.lat;
        const sc = R * 2.6 * (1.25 - 0.3 * low);
        place_m4(m4, sx, f.y + 0.05, sz, 0, sc, 1, sc);
        shadows.setMatrixAt(i, m4);
      });
      rings.instanceMatrix.needsUpdate = true;
      lights.instanceMatrix.needsUpdate = true;
      shadows.instanceMatrix.needsUpdate = true;
    });
    cues.push((t) => {
      for (const c of info) {
        chandelierPose(c.h, t, pose);
        const side = Math.sign(pose.theta);
        if (c.lastSide !== null && side !== c.lastSide && side !== 0) {
          const f = c.f;
          sfx(PALACE_SOUNDS.swing, { x: f.x + f.right.x * pose.lat, y: f.y + 2, z: f.z + f.right.z * pose.lat }, 0.7);
        }
        if (side !== 0) c.lastSide = side;
      }
    });
    ctx.stats.instances.chandeliers = chands.length;
  }

  // ---------------------------------------------------------------- portcullis leaves
  const leaves = list.filter((h) => h.type === 'portcullis');
  if (leaves.length) {
    const G = HAZARD_TUNE.portcullis;
    const info = leaves.map((h) => {
      const f = track.frameAt(h.s);
      const a = Math.max(h.latA, -(f.wallL + 0.5)), b = Math.min(h.latB, f.wallR + 0.5);
      const latC = (a + b) / 2;
      return { h, f, W: b - a, latC, x: f.x + f.right.x * latC, z: f.z + f.right.z * latC, prev: null };
    });
    // one leaf geometry per distinct width (both widths are 16.5 m here): bars, cross bars, spikes
    const leafGeo = (W) => {
      const parts = [], Hh = G.height, n = Math.max(3, Math.round(W / 1.05));
      for (let k = 0; k <= n; k++) {
        const x = -W / 2 + (k / n) * W;
        parts.push(box(0.2, Hh - 0.5, 0.2, x, 0.5 + (Hh - 0.5) / 2, 0, 0x2a2a30));
        parts.push(cone(0.13, 0.55, 4, x, 0.28, 0, 0x8a8a94, 0, Math.PI));
      }
      for (let y = 0.9; y < Hh; y += 1.15) parts.push(box(W, 0.16, 0.14, 0, y, 0, 0x34343c));
      parts.push(box(W, 0.35, 0.3, 0, Hh - 0.1, 0, C.iron));
      return mergeParts(parts);
    };
    const W0 = info[0].W;
    const leafG = leafGeo(W0);
    const leafMesh = new THREE.InstancedMesh(leafG, ctx.M.structure, info.length);
    leafMesh.frustumCulled = false;
    ctx.add(leafMesh, { cast: true, name: 'Portcullis' });
    // warning lamps on the beam face above each leaf (instance colour: dim / blinking / bright)
    const lampG = paint(new THREE.SphereGeometry(0.42, 10, 6).scale(1, 1, 0.6), 0xffffff);
    const lamps = new THREE.InstancedMesh(lampG, new THREE.MeshBasicMaterial({ toneMapped: false, fog: true }), info.length * 2);
    lamps.frustumCulled = false;
    ctx.add(lamps, { name: 'GateLamps' });
    // shadow band under each leaf (darkens as it comes down)
    const bandMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
    const bands = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), bandMat, info.length);
    bands.frustumCulled = false;
    ctx.add(bands, { name: 'GateShadows' });
    const [yb] = GATE_BEAM;
    for (const c of info) {
      for (const k of [0, 1]) {
        const off = (k ? 0.3 : -0.3) * c.W;
        const x = c.x + c.f.right.x * off - c.f.tangent.x * 1.62, z = c.z + c.f.right.z * off - c.f.tangent.z * 1.62;
        B.struct.push(paint(place(new THREE.TorusGeometry(0.5, 0.11, 5, 12), x, c.f.y + yb + 1.6, z, c.f.yaw), C.iron));
        B.struct.push(box(0.16, 0.9, 0.3, x, c.f.y + yb + 2.35, z, C.iron, c.f.yaw));
      }
    }
    updaters.push((t) => {
      info.forEach((c, i) => {
        const st = hz.stateAt(c.h, t);
        let jx = 0, jy = 0;
        if (st.rattling) { jx = Math.sin(t * 57 + i) * 0.05; jy = Math.sin(t * 43 + i * 1.7) * 0.06; }
        const scl = c.W / W0;
        place_m4(m4, c.x + c.f.tangent.x * jx, c.f.y + st.bottom + jy, c.z + c.f.tangent.z * jx, c.f.yaw, scl, 1, 1);
        leafMesh.setMatrixAt(i, m4);
        const blink = Math.floor(t * 8) % 2;
        const on = st.danger ? 1 : st.rattling ? (blink ? 1 : 0.15) : 0.12;
        for (const k of [0, 1]) {
          const off = (k ? 0.3 : -0.3) * c.W;
          const x = c.x + c.f.right.x * off - c.f.tangent.x * 1.7, z = c.z + c.f.right.z * off - c.f.tangent.z * 1.7;
          place_m4(m4, x, c.f.y + yb + 1.6, z, 0, 1, 1, 1);
          lamps.setMatrixAt(i * 2 + k, m4);
          lamps.setColorAt(i * 2 + k, on > 0.5 ? col.setRGB(2.4, 0.22, 0.08) : col.setRGB(0.16, 0.025, 0.02));
        }
        const near = 1 - clamp(st.bottom / G.raised, 0, 1);
        place_m4(m4, c.x, c.f.y + 0.05, c.z, c.f.yaw, c.W, 1, 0.6 + 1.6 * near);
        bands.setMatrixAt(i, m4);
      });
      leafMesh.instanceMatrix.needsUpdate = true;
      lamps.instanceMatrix.needsUpdate = true;
      if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
      bands.instanceMatrix.needsUpdate = true;
    });
    cues.push((t) => {
      for (const c of info) {
        const st = hz.stateAt(c.h, t);
        const now = st.danger ? 2 : st.rattling ? 1 : 0;
        if (c.prev !== null && now !== c.prev) {
          const pos = { x: c.x, y: c.f.y + 3, z: c.z };
          if (now === 1) sfx(PALACE_SOUNDS.gateRattle, pos, 0.9);
          else if (now === 2) sfx(PALACE_SOUNDS.gateSlam, pos, 1.1);
        }
        c.prev = now;
      }
    });
    ctx.stats.instances.portcullis = leaves.length;
  }

  // BONK! for a human knocked by a chandelier (main.js shows hud:flash banners on
  // that view only). No bus listener (the world may outlive a race): the knock
  // cooldowns hazards.js keeps in hz.fx (per kart, per hazard index) are read
  // each frame, and a fresh one on a chandelier is a knock that just happened.
  const chIdx = chands.map((h) => h.index);
  const seen = new WeakMap();
  if (chIdx.length) {
    cues.push(() => {
      const fx = hz.fx;
      if (!fx || !fx.karts) return;
      for (const [k, st] of fx.karts) {
        if (!st || !st.knock) continue;
        let last = seen.get(k);
        if (!last) seen.set(k, (last = new Map()));
        for (const i of chIdx) {
          const v = st.knock.get(i);
          if (v === undefined || v === last.get(i)) continue;
          last.set(i, v);
          if (live && k.isPlayer) bus.emit('hud:flash', { kart: k, text: 'BONK!', color: '#ffd04a', size: 'medium', duration: 0.9 });
        }
      }
    });
  }

  let lastT = null;
  return {
    update(t) {
      for (const u of updaters) u(t);
      live = lastT !== null && t > lastT && t - lastT < 0.5;
      for (const c of cues) c(t);                // (a seek just re-primes the previous states)
      live = false;
      lastT = t;
    },
    dispose() { updaters.length = 0; cues.length = 0; },
  };
}
