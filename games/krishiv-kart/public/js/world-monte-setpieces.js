// Monte Mozzarella set pieces and v5 landmarks (browser only; SPEC §16.1,
// notes/research-v5-tracks.md §B2). Called by world-monte.js:
//
//   buildScooterAlleys(ctx, field, hz, town)   alley arches (sottoportici) the Via Vespa scooters
//                                              come out of / turn into, the scooter shop + parked scooters
//   buildScooters(ctx, hz)                     the riding scooters (instanced, blinkers, horn telegraph)
//   buildFountainJets(ctx, hz, T)              Piazza Alta's dancing jets: grates, bubbling domes,
//                                              ripple rings, water columns (instanced)
//   buildDairy(ctx, field, hz, bucket, stone)  the hillside dairy barn, stacked wheels, the chutes + gates
//   buildCheeseWheels(ctx, field, hz, dairy)   the rolling wheels (chute → road → over the far wall)
//   buildBelvedere / buildPiazzaAlta / buildShrines   static landmarks
//   hazardAudio(ctx, hz)                       one-shot telegraph sounds on the race clock (item:sfx bus)
//
// Every moving piece is drawn from the hazard set's own clock (hz.time) with
// the pure helpers of hazards/hilltown.js, so what you see is exactly what
// the physics, the sim and the CPUs use. Each set-piece type is one or two
// instanced draw calls (SPEC perf budget).

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './utils.js';
import {
  place, paint, mixHex, place_m4, addMerged, sRange, trackStrip, roadDecal, decalMaterial, faceColors, lumpy,
  box, quad, cyl, ball, mergeParts, gableRoof, rect, rectOutline,
} from './world.js';
import { HILLTOWN_TUNE, moverVisuals, jetState, wheelVisuals } from './hazards/hilltown.js';
import { bus } from './bus.js';
import { registerSound, SYNTH } from './audio.js';
import * as MT from './world-monte-textures.js';

const C = {
  stone: 0xe9d9b8, stoneWarm: 0xdcc199, stoneDark: 0xb9a587, cream: 0xf6ecd6, trim: 0xfaf3e3,
  roof: 0xc65a39, roofDark: 0xab4830, wood: 0x8a5a32, woodDark: 0x5e3b20, iron: 0x2e3436, bronze: 0xc0903a,
  rind: 0xe8b04a, rindDark: 0xc98a2c, paste: 0xf6dc8a, band: 0xf7f1e1, bandRed: 0xc23a2a,
  water: 0x8fd8f0, waterDeep: 0x58c6e4, foam: 0xffffff, amber: 0xffa21a,
};

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _f = {};
const pt = (track, s, lat, out = { x: 0, y: 0, z: 0 }) => {
  const f = track.frameAt(s, _f);
  out.x = f.x + f.right.x * lat; out.z = f.z + f.right.z * lat; out.y = f.y;
  return out;
};

// Flip every triangle's winding (after a mirroring transform) and recompute the normals.
function flipWinding(g) {
  const ix = g.index;
  for (let i = 0; i < ix.count; i += 3) { const a = ix.getX(i + 1); ix.setX(i + 1, ix.getX(i + 2)); ix.setX(i + 2, a); }
  ix.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ sounds (telegraphs)

let _sounds = false;
export function registerMonteSounds() {
  if (_sounds) return;
  _sounds = true;
  // scooter horn: a nasal two-tone "beep-beep" (1 s before a scooter rolls out)
  registerSound('monteHorn', (ac, out, o) => {
    const { t, p } = SYNTH.opt(ac, o);
    for (const dt of [0, 0.19]) {
      SYNTH.note(ac, out, t + dt, 392 * p, 0.13, { type: 'square', peak: 0.06, attack: 0.004, decay: 0.03, sustain: 0.9, release: 0.03, lp: 2200 });
      SYNTH.note(ac, out, t + dt, 494 * p, 0.13, { type: 'square', peak: 0.05, attack: 0.004, decay: 0.03, sustain: 0.9, release: 0.03, lp: 2200 });
    }
    return 0.36;
  }, 1.1);
  // fountain: a low gurgle while a jet bubbles (telegraph) ...
  registerSound('monteGurgle', (ac, out, o) => {
    const { t, p } = SYNTH.opt(ac, o);
    for (let k = 0; k < 5; k++) {
      SYNTH.blip(ac, out, t + k * 0.13, { type: 'sine', f0: (180 + k * 37) * p, f1: (420 + k * 25) * p, glide: 0.06, dur: 0.09, peak: 0.09 });
    }
    SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 600, f1: 1400, dur: 0.7, peak: 0.08, attack: 0.15 });
    return 0.75;
  });
  // ... and a rushing whoosh when it erupts
  registerSound('monteSplash', (ac, out, o) => {
    const { t, p } = SYNTH.opt(ac, o);
    SYNTH.hiss(ac, out, t, { type: 'bandpass', f0: 900 * p, f1: 3800 * p, sweep: 0.25, Q: 0.7, dur: 0.75, peak: 0.16, attack: 0.03 });
    SYNTH.hiss(ac, out, t + 0.05, { type: 'highpass', f0: 4000, dur: 0.6, peak: 0.06, attack: 0.05 });
    return 0.8;
  });
  // cheese wheel: a rumble as it leaves the dairy and a thump on the bank
  registerSound('monteRumble', (ac, out, o) => {
    const { t, p } = SYNTH.opt(ac, o);
    SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 220 * p, f1: 140 * p, dur: 1.6, peak: 0.16, attack: 0.25, rate: 0.5 });
    SYNTH.blip(ac, out, t, { type: 'triangle', f0: 70 * p, f1: 52 * p, dur: 1.2, peak: 0.08, attack: 0.2 });
    return 1.6;
  });
  registerSound('monteThump', (ac, out, o) => {
    const { t, p } = SYNTH.opt(ac, o);
    SYNTH.blip(ac, out, t, { type: 'sine', f0: 110 * p, f1: 42 * p, glide: 0.18, dur: 0.35, peak: 0.3 });
    SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 500, f1: 120, dur: 0.3, peak: 0.12 });
    return 0.4;
  });
}

// One-shot sounds at the set pieces' telegraph moments, from the hazard clock
// (bus 'item:sfx' → main.js plays them distance-attenuated, races only).
export function hazardAudio(ctx, hz) {
  const { track } = ctx;
  const movers = hz.list.filter((h) => h.type === 'mover');
  const jets = hz.list.filter((h) => h.type === 'jet');
  const wheels = hz.list.filter((h) => h.type === 'wheel');
  const ev = { name: '', position: { x: 0, y: 0, z: 0 }, volume: 1, pitch: 1 };
  const play = (name, s, lat, up, vol = 1, pitch = 1) => {
    const p = pt(track, s, lat, ev.position);
    p.y += up;
    ev.name = name; ev.volume = vol; ev.pitch = pitch;
    bus.emit('item:sfx', ev);
  };
  let last = hz.time;
  const crossed = (prevP, p, mark) => (prevP < mark && p >= mark) || (prevP > p && (prevP < mark || p >= mark));
  return () => {
    const t = hz.time, t0 = last;
    last = t;
    if (!(t > t0) || t - t0 > 0.5) return;            // paused, restarted or jumped: no catch-up
    for (const h of movers) {
      const M = HILLTOWN_TUNE.mover, mark = 1 - M.enter / h.period;
      const p0 = ((t0 / h.period + (h.phase || 0)) % 1 + 1) % 1, p1 = ((t / h.period + (h.phase || 0)) % 1 + 1) % 1;
      if (crossed(p0, p1, mark)) play('monteHorn', h.s - M.alley, Math.sign(h.lateral) * (Math.abs(h.lateral) + 9), 1, 0.9, h.lateral < 0 ? 1 : 1.08);
    }
    for (const h of jets) {
      for (let k = 0; k < h.lats.length; k++) {
        const ph = (x) => ((x / h.period + (h.phase || 0) + k * (h.dphase || 0)) % 1 + 1) % 1;
        const a = ph(t0), b = ph(t);
        if (crossed(a, b, HILLTOWN_TUNE.jet.bubble0)) play('monteGurgle', h.s, h.lats[k], 0.3, 0.8, 0.9 + k * 0.05);
        if (crossed(a, b, HILLTOWN_TUNE.jet.erupt0)) play('monteSplash', h.s, h.lats[k], 1.5, 0.8, 0.95 + k * 0.03);
      }
    }
    for (const h of wheels) {
      const W = HILLTOWN_TUNE.wheel;
      const n = h.count || 1;
      for (let k = 0; k < n; k++) {
        const ph = (x) => ((x / h.period + (h.phase || 0) + k / n) % 1 + 1) % 1;
        const a = ph(t0), b = ph(t);
        if (crossed(a, b, 1 - W.chute / h.period)) play('monteRumble', h.s, h.from * (h.travel / 2 + 10), 2, 0.9);
        if (crossed(a, b, 0.0001)) play('monteThump', h.s, h.from * h.travel / 2, 0.5, 1.1);
      }
    }
  };
}

// ------------------------------------------------------------------ scooters

const SCOOTER_COLS = [0x8fd3bd, 0xe8473f, 0xf3e1b0, 0x5aa7e0, 0xf2c230, 0xf08a3c, 0xb98cdf];

// Generic retro scooter + rider, local +z forward, wheels on y = 0, ~1.9 m
// long. Returns { paint (tinted per instance), plain (wheels, seat, lights),
// rider (riding scooters only) }.
function scooterGeometry() {
  const W = 0xffffff;
  const paintG = mergeParts([
    ball(0.5, 0, 0.6, -0.4, W, 0.64, 0.5, 0.95, 1),          // rounded rear cowl
    box(0.52, 0.84, 0.09, 0, 0.66, 0.56, W, 0, -0.22),        // leg shield
    box(0.4, 0.1, 0.62, 0, 0.3, 0.18, W),                     // floorboard
    ball(0.24, 0, 0.38, 0.76, W, 0.72, 0.55, 1.25),           // front mudguard
    box(0.26, 0.4, 0.2, 0, 1.0, 0.62, W, 0, -0.25),           // headset cover
  ]);
  const plain = mergeParts([
    cyl(0.2, 0.2, 0.13, 10, 0, 0.2, 0.76, 0x23262b, 0, 0, Math.PI / 2),
    cyl(0.2, 0.2, 0.16, 10, 0, 0.2, -0.64, 0x23262b, 0, 0, Math.PI / 2),
    box(0.36, 0.12, 0.62, 0, 0.92, -0.38, 0x4a3426),          // seat
    box(0.72, 0.05, 0.05, 0, 1.22, 0.56, 0xc4c8ce),           // handlebar
    ball(0.1, 0, 1.08, 0.74, 0xfff3c0, 1, 1, 0.7),            // headlight
    box(0.18, 0.08, 0.05, 0, 0.72, -0.88, 0xd62a2a),          // tail light
  ]);
  const rider = mergeParts([
    box(0.36, 0.2, 0.5, 0, 1.0, -0.2, 0x3c5a8a),              // thighs
    box(0.13, 0.5, 0.13, -0.13, 0.64, 0.12, 0x3c5a8a),        // shins
    box(0.13, 0.5, 0.13, 0.13, 0.64, 0.12, 0x3c5a8a),
    box(0.4, 0.56, 0.26, 0, 1.38, -0.28, 0xf6f2ea, 0, 0.15),  // torso
    box(0.1, 0.1, 0.8, -0.27, 1.36, 0.17, 0xf6f2ea, 0, 0.38), // arms
    box(0.1, 0.1, 0.8, 0.27, 1.36, 0.17, 0xf6f2ea, 0, 0.38),
    ball(0.18, 0, 1.8, -0.24, 0xd83a2e, 1, 0.92, 1.08, 1),    // helmet
    box(0.3, 0.1, 0.06, 0, 1.78, -0.06, 0x262a30),            // visor
  ]);
  return { paint: paintG, plain, rider };
}

// Matrix of a scooter at (s, lat) heading `heading` (rad from the tangent,
// + right) with a lean (rad, + right).
function scooterMatrix(track, s, lat, heading, lean, out) {
  const f = track.frameAt(s, _f);
  _p.set(f.x + f.right.x * lat, f.y + 0.01, f.z + f.right.z * lat);
  _e.set(0, f.yaw + heading, -lean, 'YXZ');
  _q.setFromEuler(_e);
  return out.compose(_p, _q, _s.set(1, 1, 1));
}

/**
 * The Via Vespa scooters: up to two per lane (riding / turning off / rolling
 * out), plus `parked` static ones [{ x, y, z, yaw }]. Blinkers flash while a
 * scooter turns in or out (the visual half of the horn telegraph).
 */
export function buildScooters(ctx, hz, parked = []) {
  const { track } = ctx;
  const lanes = hz.list.filter((h) => h.type === 'mover');
  if (!lanes.length && !parked.length) return;
  const geo = scooterGeometry();
  const nMove = lanes.length * 2, n = nMove + parked.length;
  const body = new THREE.InstancedMesh(geo.paint, ctx.M.structure, n);
  const rest = new THREE.InstancedMesh(geo.plain, ctx.M.structure, n);
  const riders = new THREE.InstancedMesh(geo.rider, ctx.M.structure, nMove);
  body.frustumCulled = rest.frustumCulled = riders.frustumCulled = false;
  const col = new THREE.Color();
  for (let i = 0; i < n; i++) body.setColorAt(i, col.set(SCOOTER_COLS[(i * 3 + 1) % SCOOTER_COLS.length]));
  ctx.add(body, { cast: true, name: 'Scooters' });
  ctx.add(rest, { cast: true, name: 'ScooterParts' });
  ctx.add(riders, { cast: true, name: 'ScooterRiders' });
  const blinkMat = new THREE.MeshBasicMaterial({ color: C.amber, toneMapped: false, fog: true });
  const blinkers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), blinkMat, nMove * 2);
  blinkers.frustumCulled = false;
  ctx.add(blinkers, { name: 'ScooterBlinkers' });
  // parked ones (fixed matrices after the moving slots)
  parked.forEach((p, k) => {
    place_m4(_m4, p.x, p.y, p.z, p.yaw, 1, 1, 1);
    body.setMatrixAt(nMove + k, _m4);
    rest.setMatrixAt(nMove + k, _m4);
  });
  const vis = [];
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const local = new THREE.Vector3(), blinkM = new THREE.Matrix4();
  const update = (t) => {
    let bi = 0;
    lanes.forEach((h, li) => {
      const m = moverVisuals(h, t, vis);
      for (let j = 0; j < 2; j++) {
        const idx = li * 2 + j;
        if (j >= m) {
          body.setMatrixAt(idx, hidden); rest.setMatrixAt(idx, hidden); riders.setMatrixAt(idx, hidden);
          continue;
        }
        const v = vis[j];
        const lean = v.phase === 'ride' ? -v.heading * 1.6 : v.heading * 0.35;
        scooterMatrix(track, h.s + v.along, v.lat, v.heading, lean, _m4);
        body.setMatrixAt(idx, _m4); rest.setMatrixAt(idx, _m4); riders.setMatrixAt(idx, _m4);
        // blinkers: turning in / out — the side it turns toward
        const turning = v.phase !== 'ride';
        const on = turning && Math.floor(t * 4) % 2 === 0;
        if (on) {
          const side = v.phase === 'enter' ? -Math.sign(h.lateral) : Math.sign(h.lateral);
          for (const z of [0.66, -0.9]) {
            local.set(side * 0.34, 0.95, z).applyMatrix4(_m4);
            blinkers.setMatrixAt(bi++, blinkM.makeTranslation(local.x, local.y, local.z));
          }
        }
      }
    });
    for (let i = bi; i < nMove * 2; i++) blinkers.setMatrixAt(i, hidden);
    body.instanceMatrix.needsUpdate = true;
    rest.instanceMatrix.needsUpdate = true;
    riders.instanceMatrix.needsUpdate = true;
    blinkers.instanceMatrix.needsUpdate = true;
  };
  ctx.stats.instances.scooters = n;
  return update;
}

// ------------------------------------------------------------------ alleys

// The Via Vespa alley mouths: an arched passage through a two-storey house
// (sottoportico) at the start and the end of each scooter lane, on the lane's
// side; the barrier opens between two stone bollards there (wall style
// 'none', see world-monte.js gaps). Sets h.alleyLat (the passage's centre
// lateral) on each mover so the scooters ride out of the passage. Next to the
// first entry alley on the right: the scooter shop (parts in the window, a
// round pictogram sign, three scooters parked on the pavement).
// Returns { gaps: [{ s, side, half }], parked: [{ x, y, z, yaw }] }.
export function buildScooterAlleys(ctx, field, hz, bucket) {
  const { track } = ctx;
  const M = HILLTOWN_TUNE.mover;
  const TA = MT.TOWN_ATLAS;
  const gaps = [], parked = [];
  const OPEN = 4.0, PIER = 1.3, DEPTH = 9, H = 9.4, SET = 1.2;
  const hw = OPEN / 2 + PIER;
  // local (u along the tangent, y, z away from the road) → world at (s, facade lateral)
  const toWorld = (g, f, side, lat0, y0) => {
    g.applyMatrix4(new THREE.Matrix4().set(
      f.tangent.x, 0, f.right.x * side, f.x + f.right.x * lat0,
      0, 1, 0, y0,
      f.tangent.z, 0, f.right.z * side, f.z + f.right.z * lat0,
      0, 0, 0, 1));
    if (side < 0) flipWinding(g);                        // (tangent, up, -right) is a mirrored basis
    MT.markAtlas(g);
    return g;
  };
  const windowRow = (parts, us, y, z, shutter) => {
    for (const u of us) {
      parts.push(MT.uvRect(quad(1.9, 1.5, u, y, z, 0xffffff, Math.PI), TA.cell(TA.OPEN + shutter)));
      parts.push(MT.uvWhite(box(1.05, 0.3, 0.3, u, y - 0.85, z - 0.1, 0xe8475f)));
    }
  };
  const footprint = (f, side, wall, along, width, depth, kind) => {
    const c = (d) => pt(track, f.s + along, side * (wall + SET + d));
    for (let d = 1.25; d < depth; d += 2.5) { const q = c(d); ctx.exclusions.push([q.x, q.z, Math.hypot(width / 2, 1.25) + 0.4]); }
    const q = c(depth / 2);
    // (rect(): local z = the yaw's heading = along the road, local x = across it)
    for (const [px, pz] of rectOutline(rect(q.x, q.z, f.yaw, depth / 2, width / 2), 1.0)) ctx.prop(kind, px, pz, 0.45);
  };
  let n = 0;
  for (const h of hz.list.filter((x) => x.type === 'mover')) {
    const side = Math.sign(h.lateral) || -1;
    for (const s of [h.s - M.alley, h.s + h.length + M.alley]) {
      const f = track.frameAt(s);
      f.s = s;
      const wall = side > 0 ? f.wallR : f.wallL;
      const lat0 = side * (wall + SET);                       // facade line
      h.alleyLat = wall + SET + DEPTH * 0.45;
      gaps.push({ s, side, half: OPEN / 2 + 0.15 });
      // facade shape in (u along the road, y), extruded away from the road (local z): a block with an arched tunnel
      const sh = new THREE.Shape();
      sh.moveTo(-hw, -1.2); sh.lineTo(hw, -1.2); sh.lineTo(hw, H); sh.lineTo(-hw, H); sh.lineTo(-hw, -1.2);
      const hole = new THREE.Path();
      hole.moveTo(-OPEN / 2, 0.02); hole.lineTo(OPEN / 2, 0.02); hole.lineTo(OPEN / 2, 2.6);
      hole.absarc(0, 2.6, OPEN / 2, 0, Math.PI, false); hole.lineTo(-OPEN / 2, 0.02);
      sh.holes.push(hole);
      const ex = new THREE.ExtrudeGeometry(sh, { depth: DEPTH, bevelEnabled: false, curveSegments: 10 });
      const wallCol = [0xf2c3a0, 0xf3d3a0, 0xebb19b, 0xf7e3b3][n++ % 4];
      faceColors(ex, () => wallCol);
      paint(ex, null);
      MT.uvStucco(ex, -1.2, H);
      {
        // the passage: dark, darker deeper in
        const p = ex.attributes.position, c = ex.attributes.color;
        for (let i = 0; i < p.count; i += 3) {
          const u = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3, y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
          const inside = Math.abs(u) < OPEN / 2 + 0.01 && (y < 2.6 || Math.hypot(u, y - 2.6) < OPEN / 2 + 0.01) && y < 2.6 + OPEN / 2 + 0.01;
          if (!inside) continue;
          const zc = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
          const k = lerp(0.42, 0.12, smoothstep(zc / DEPTH));
          for (let j = 0; j < 3; j++) { c.setX(i + j, c.getX(i + j) * k); c.setY(i + j, c.getY(i + j) * k); c.setZ(i + j, c.getZ(i + j) * k); }
        }
      }
      const parts = [ex];
      parts.push(MT.uvWhite(box(2 * hw + 0.3, 0.26, DEPTH + 0.3, 0, H - 0.13, DEPTH / 2, mixHex(wallCol, C.trim, 0.6))));
      windowRow(parts, [-1.9, 0, 1.9], 6.4, -0.06, n % 5);
      // stone arch ring, keystone and a lantern over the passage
      const ring = new THREE.TorusGeometry(OPEN / 2 + 0.18, 0.2, 4, 14, Math.PI).translate(0, 2.6, -0.08);
      parts.push(MT.uvWhite(paint(ring, C.stoneWarm)));
      parts.push(MT.uvWhite(box(0.6, 0.7, 0.25, 0, 2.6 + OPEN / 2 + 0.2, -0.12, C.stoneWarm)));
      parts.push(MT.uvWhite(box(0.08, 0.6, 0.6, 0, 4.3, -0.4, C.iron)));
      parts.push(MT.uvWhite(box(0.36, 0.5, 0.36, 0, 3.85, -0.7, 0xffe7a0)));
      const [slopes, gables] = gableRoof(DEPTH, 2 * hw, 1.7, 0.45, C.roof, wallCol);
      parts.push(MT.uvRoof(slopes, 1.7).rotateY(Math.PI / 2).translate(0, H, DEPTH / 2));
      parts.push(MT.uvStucco(gables, -2, 4).rotateY(Math.PI / 2).translate(0, H, DEPTH / 2));
      // a dark curtain far inside: the alley beyond reads as shade
      parts.push(MT.uvWhite(quad(OPEN, 4.6, 0, 2.3, DEPTH - 0.05, 0x161210, Math.PI)));
      bucket.push(toWorld(mergeParts(parts), f, side, lat0, f.y - 0.02));
      footprint(f, side, wall, 0, 2 * hw, DEPTH, 'alley');
      ctx.landmarks.push({ name: 'alley', x: pt(track, s, side * (wall + 5)).x, z: pt(track, s, side * (wall + 5)).z, r: hw, h: H + 2 });
      // bollards either side of the barrier gap
      for (const da of [-1, 1]) {
        const b = pt(track, s + da * (OPEN / 2 + 0.35), side * (wall + 0.36));
        bucket.push(cyl(0.22, 0.28, 0.95, 8, b.x, b.y + 0.47, b.z, C.stone));
        bucket.push(ball(0.24, b.x, b.y + 1.0, b.z, C.stoneWarm, 1, 0.6, 1));
        ctx.prop('bollard', b.x, b.z, 0.28);
      }
      // the scooter shop, right next to the first entry alley on the right
      if (side > 0 && s < h.s && !parked.length) {
        const SW = 8.0, SD = 8.5, floors = 2, top = floors * 3.1 + 0.45 + 0.4;
        const along = -(hw + SW / 2 + 0.05);
        const sp = [];
        sp.push(MT.uvStucco(box(SW, top + 1.2, SD, along, (top - 1.2) / 2, SD / 2, 0xf4d1c6), -1.2, top));
        sp.push(MT.uvWhite(box(SW + 0.3, 0.26, SD + 0.3, along, top - 0.13, SD / 2, C.trim)));
        const [rs, rg] = gableRoof(SW, SD, 2.0, 0.42, C.roof, 0xf4d1c6);
        sp.push(MT.uvRoof(rs, 2.0).translate(along, top, SD / 2), MT.uvStucco(rg, -2, 4).translate(along, top, SD / 2));
        // ground floor: a wide parts window + the workshop door; first floor: windows
        sp.push(MT.uvRect(quad(4.2, 2.1, along - 1.6, 1.3, -0.06, 0xffffff, Math.PI), TA.cell(TA.SHOP[0], 'shop')));
        sp.push(MT.uvRect(quad(1.2, 2.3, along + 2.6, 1.15, -0.06, 0xffffff, Math.PI), TA.cell(TA.DOORS[1], 'door')));
        windowRow(sp, [along - 2.2, along + 2.2], 4.85, -0.06, 1);
        // striped awning + the round sign with a scooter pictogram on a bracket
        const aw = new THREE.BoxGeometry(SW - 0.8, 0.1, 1.1, 12, 1, 1);
        sp.push(MT.uvWhite(place(stripeXLocal(aw, 0x2f7ad0, 0xfff6e8, 0.55), along, 2.85, -0.5, 0, -0.32)));
        sp.push(MT.uvWhite(box(0.08, 0.08, 1.2, along + 3.4, 4.2, -0.6, C.iron)));
        sp.push(MT.uvWhite(cyl(0.72, 0.72, 0.08, 18, along + 3.4, 3.45, -1.15, 0x2f6aa0, 0, 0, Math.PI / 2)));
        sp.push(MT.uvWhite(cyl(0.6, 0.6, 0.1, 18, along + 3.4, 3.45, -1.15, 0xfaf3e3, 0, 0, Math.PI / 2)));
        for (const [w, hh, x, y] of [[0.48, 0.1, 0, 3.32], [0.1, 0.38, 0.18, 3.55], [0.22, 0.09, 0.13, 3.72], [0.18, 0.18, -0.22, 3.22], [0.18, 0.18, 0.24, 3.22], [0.28, 0.14, -0.1, 3.46]]) {
          sp.push(MT.uvWhite(box(0.14, hh, w, along + 3.4, y, -1.15 + x, 0x2f6aa0)));
        }
        bucket.push(toWorld(mergeParts(sp), f, side, lat0, f.y - 0.25));
        footprint(f, side, wall, along, SW, SD, 'shop');
        for (let k = 0; k < 3; k++) {
          const ps = s + along - SW / 2 + 1.4 + k * 2.6;
          const fw = track.frameAt(ps), w2 = side > 0 ? fw.wallR : fw.wallL;
          const q = pt(track, ps, side * (w2 + 0.72));
          parked.push({ x: q.x, y: q.y - 0.02, z: q.z, yaw: fw.yaw + (k % 2 ? 0.08 : -0.06) });
          for (const d of [-0.55, 0.55]) { const c2 = pt(track, ps + d, side * (w2 + 0.72)); ctx.prop('scooter', c2.x, c2.z, 0.42); }
        }
      }
    }
  }
  ctx.stats.instances.alleys = gaps.length;
  return { gaps, parked };
}

// Stripes along local x on a box (an awning), vertex colours only.
function stripeXLocal(geo, a, b, width) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  faceColors(g, () => 0xffffff);
  const pos = g.attributes.position, col = g.attributes.color;
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const c = Math.floor(cx / width + 1000) % 2 ? ca : cb;
    for (let k = 0; k < 3; k++) col.setXYZ(i + k, c.r, c.g, c.b);
  }
  return paint(g, null);
}

// ------------------------------------------------------------------ fountain jets

/**
 * Piazza Alta's dancing fountain: per jet a bronze grate with a mosaic rim in
 * the paving, a bubbling dome + ripple ring while it bubbles (telegraph), a
 * water column (6 m) with a spray crown and a foam ring while it erupts.
 */
export function buildFountainJets(ctx, hz) {
  const { track } = ctx;
  const list = hz.list.filter((h) => h.type === 'jet');
  if (!list.length) return null;
  const jets = [];
  for (const h of list) h.lats.forEach((lat, k) => jets.push({ h, k, p: pt(track, h.s, lat, {}) }));
  const n = jets.length;
  // grates (one merged mesh, transparent disc texture)
  const grateTex = ctx.tex(MT.createGrateTexture({ size: ctx.Q.veg >= 1 ? 256 : 128 }));
  const discs = jets.map(({ h, p }) => {
    const g = new THREE.CircleGeometry(h.radius * 0.95, 24).rotateX(-Math.PI / 2);
    g.rotateY(track.frameAt(h.s).yaw);
    return paint(g.translate(p.x, p.y + 0.016, p.z), 0xffffff);
  });
  addMerged(ctx, discs, new THREE.MeshLambertMaterial({ map: grateTex, transparent: true, alphaTest: 0.05, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), { receive: true, name: 'JetGrates' });
  // water parts (vertex colours, unlit-ish so they read in shade)
  const waterMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x3a8fa8, emissiveIntensity: 0.6, flatShading: true });
  // unit plume (height 1, radius ~1): a widening striped water column, a white
  // core, a spray crown and droplets falling around it
  const plume = new THREE.CylinderGeometry(0.95, 0.5, 1, 14, 5, true).translate(0, 0.5, 0);
  {
    // vertical white streaks on a blue-white column, whiter toward the top
    const p = plume.attributes.position, col = new Float32Array(p.count * 3), c = new THREE.Color(), w = new THREE.Color(C.foam);
    for (let i = 0; i < p.count; i++) {
      const a = Math.atan2(p.getZ(i), p.getX(i)), y = p.getY(i);
      c.set(C.waterDeep).lerp(w, clamp(0.25 + 0.55 * y + (Math.sin(a * 7) > 0.55 ? 0.45 : 0), 0, 1));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    plume.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const colParts = [
    paint(plume, null),
    paint(new THREE.CylinderGeometry(0.4, 0.28, 1.04, 10, 1, true).translate(0, 0.5, 0), C.foam),
    paint(new THREE.SphereGeometry(1.15, 12, 6).scale(1.15, 0.5, 1.15).translate(0, 1.0, 0), C.foam),
  ];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2, r = 1.2 + (k % 2) * 0.4, y = 0.9 - (k % 3) * 0.25;
    colParts.push(paint(new THREE.SphereGeometry(0.2, 6, 4).scale(1, 1.9, 1).translate(Math.cos(a) * r, y, Math.sin(a) * r), C.foam));
  }
  const colG = mergeParts(colParts);
  // the column: smooth, slightly see-through, lit from within (reads as spray, not ice)
  const sprayMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x6cc4e0, emissiveIntensity: 0.55, transparent: true, opacity: 0.86, depthWrite: false });
  const columns = new THREE.InstancedMesh(colG, sprayMat, n);
  const domeG = paint(new THREE.SphereGeometry(0.85, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2), C.water);
  const domes = new THREE.InstancedMesh(domeG, waterMat, n);
  const ringG = paint(new THREE.TorusGeometry(1, 0.09, 4, 22).rotateX(Math.PI / 2), C.foam);
  const rings = new THREE.InstancedMesh(ringG, waterMat, n * 2);
  for (const m of [columns, domes, rings]) { m.frustumCulled = false; }
  ctx.add(columns, { cast: true, name: 'JetColumns' });
  ctx.add(domes, { name: 'JetDomes' });
  ctx.add(rings, { name: 'JetRings' });
  const J = HILLTOWN_TUNE.jet;
  const update = (t) => {
    jets.forEach(({ h, k, p }, i) => {
      const st = jetState(h, k, t);
      // column
      if (st.erupting) {
        const hgt = Math.max(0.01, J.height * st.rise);
        const w = (1 + 0.08 * Math.sin(t * 23 + i * 1.7)) * (0.75 + 0.25 * st.rise);
        place_m4(_m4, p.x, p.y, p.z, t * 3 + i, w * h.radius * 0.8, hgt, w * h.radius * 0.8);
      } else place_m4(_m4, p.x, p.y - 2, p.z, 0, 0.001, 0.001, 0.001);
      columns.setMatrixAt(i, _m4);
      // bubbling dome (rises and wobbles through the telegraph, flattens as the column fires)
      if (st.bubbling) {
        const b = st.b, wob = 1 + 0.12 * Math.sin(t * 31 + i);
        place_m4(_m4, p.x, p.y + 0.01, p.z, t * 2, h.radius * (0.6 + 0.5 * b) * wob, 0.25 + 1.0 * b * (0.75 + 0.25 * Math.sin(t * 27 + i)), h.radius * (0.6 + 0.5 * b) / wob);
      } else if (st.erupting) {
        place_m4(_m4, p.x, p.y + 0.01, p.z, 0, h.radius * 1.05, 0.25, h.radius * 1.05);
      } else {
        const idle = 0.12 + 0.04 * Math.sin(t * 4 + i);                 // a calm trickle
        place_m4(_m4, p.x, p.y + 0.005, p.z, 0, h.radius * 0.45, idle, h.radius * 0.45);
      }
      domes.setMatrixAt(i, _m4);
      // ripple ring (bubbling: expanding rings) + foam ring at the foot (erupting)
      if (st.bubbling) {
        const r = h.radius * (0.8 + ((st.b * 3) % 1) * 1.1);
        place_m4(_m4, p.x, p.y + 0.03, p.z, 0, r, 2.2, r);
      } else if (st.erupting) {
        const r = h.radius * (1.15 + 0.1 * Math.sin(t * 17 + i));
        place_m4(_m4, p.x, p.y + 0.03, p.z, 0, r, 1.6, r);
      } else place_m4(_m4, p.x, p.y - 2, p.z, 0, 0.001, 0.001, 0.001);
      rings.setMatrixAt(i, _m4);
      // the second ring: a wide splash halo while erupting
      if (st.erupting) {
        const r = h.radius * (1.6 + 0.5 * ((t * 1.7 + i * 0.3) % 1));
        place_m4(_m4, p.x, p.y + 0.025, p.z, 0, r, 0.8, r);
      } else place_m4(_m4, p.x, p.y - 2, p.z, 0, 0.001, 0.001, 0.001);
      rings.setMatrixAt(n + i, _m4);
    });
    columns.instanceMatrix.needsUpdate = true;
    domes.instanceMatrix.needsUpdate = true;
    rings.instanceMatrix.needsUpdate = true;
  };
  ctx.stats.instances.fountainJets = n;
  return update;
}

// ------------------------------------------------------------------ dairy + chutes + wheels

/**
 * The hillside dairy above the Cheese Run (left of the road): a long stone
 * barn on a level plinth with a loading porch, stacked wheels, and per wheel
 * row a wooden chute from a barn door down to a gate in the left barrier.
 * Returns { chutes: [{ h, a: {x,y,z} (door end, trough floor), b: {x,y,z} (gate lip) }], gaps: [{ s, side, half }] }.
 */
export function buildDairy(ctx, field, hz, bucket, stone) {
  const { track } = ctx;
  const rows = hz.list.filter((h) => h.type === 'wheel');
  if (!rows.length) return { chutes: [], gaps: [] };
  const from = rows[0].from || -1;
  const s0 = Math.min(...rows.map((h) => h.s)), s1 = Math.max(...rows.map((h) => h.s));
  const sMid = (s0 + s1) / 2;
  const fm = track.frameAt(sMid);
  const wallAt = (f) => (from < 0 ? f.wallL : f.wallR);
  const LEN = Math.max(24, s1 - s0 + 8), DEP = 11;
  const OFF = wallAt(fm) + 12 + DEP / 2;                 // barn centre lateral distance
  const cx = fm.x + fm.right.x * from * OFF, cz = fm.z + fm.right.z * from * OFF;
  const yaw = fm.yaw;                                       // barn local x along the road
  // level plinth: the highest ground under the footprint, at least 1.5 m over the highest gate lip
  let gMin = Infinity, gMax = -Infinity;
  const rc = rect(cx, cz, yaw + Math.PI / 2, LEN / 2, DEP / 2);
  for (const [px, pz] of rectOutline(rc, 2)) { const g = field.surfaceHeight(px, pz); gMin = Math.min(gMin, g); gMax = Math.max(gMax, g); }
  const lipY = Math.max(...rows.map((h) => track.frameAt(h.s).y)) + 1.1;
  const floor = Math.max(gMax + 0.3, lipY + 1.3);
  // world transform of the barn: local x along the tangent, local z toward the road (-from side)
  const tX = fm.tangent.x, tZ = fm.tangent.z, nX = -fm.right.x * from, nZ = -fm.right.z * from;
  const toW = (lx, ly, lz) => ({ x: cx + tX * lx + nX * lz, y: ly, z: cz + tZ * lx + nZ * lz });
  const M = new THREE.Matrix4().set(tX, 0, nX, cx, 0, 1, 0, 0, tZ, 0, nZ, cz, 0, 0, 0, 1);
  const mirrored = (tX * nZ - tZ * nX) < 0;
  const fix = (g) => {
    g.applyMatrix4(M);
    if (mirrored) flipWinding(g);
    return g;
  };
  // plinth (stone) + barn (stone walls, roof, doors, porch)
  stone.push(fix(paint(new THREE.BoxGeometry(LEN + 3, floor - gMin + 1.2, DEP + 5).translate(0, (floor + gMin - 1.2) / 2, 0.6), C.stoneWarm)));
  stone.push(fix(paint(new THREE.BoxGeometry(LEN + 3.3, 0.3, DEP + 5.3).translate(0, floor + 0.15, 0.6), C.stone)));
  // cellar doors in the plinth's road face (where it stands tall enough)
  for (let x = -LEN / 2 + 4; x <= LEN / 2 - 4 + 1e-6; x += (LEN - 8) / 3) {
    const fy = Math.max(gMin, field.surfaceHeight(toW(x, 0, DEP / 2 + 3.15).x, toW(x, 0, DEP / 2 + 3.15).z));
    if (floor - fy < 2.4) continue;
    const hh = Math.min(2.4, floor - fy - 0.5);
    stone.push(fix(paint(new THREE.BoxGeometry(1.8, hh, 0.12).translate(x, fy + hh / 2, DEP / 2 + 3.12), 0x3a2c22)));
  }
  const parts = [];
  const WH = 7.2, BARN = 0xf0d6a8;
  parts.push(MT.uvStucco(box(LEN, WH, DEP, 0, floor + WH / 2, -0.6, BARN), floor, floor + WH));
  {
    const [sl, gb] = gableRoof(LEN, DEP, 2.8, 0.55, C.roof, BARN);
    parts.push(MT.uvRoof(sl, 2.8).translate(0, floor + WH, -0.6), MT.uvStucco(gb, -2, 5).translate(0, floor + WH, -0.6));
  }
  parts.push(box(LEN + 0.3, 0.3, DEP + 0.3, 0, floor + WH - 0.15, -0.6, C.cream));
  // loading porch along the road side
  parts.push(box(LEN, 0.25, 2.4, 0, floor + 3.6, DEP / 2 + 0.6, C.roofDark, 0, 0.12));
  for (let x = -LEN / 2 + 1; x <= LEN / 2 - 1 + 1e-6; x += (LEN - 2) / 5) parts.push(box(0.3, 3.6, 0.3, x, floor + 1.8, DEP / 2 + 1.6, C.woodDark));
  // windows (upper row) + the round "wheel" emblem on the gable end (a plain cheese disc, no text)
  for (let x = -LEN / 2 + 2.5; x < LEN / 2 - 1; x += 3.4) parts.push(MT.uvRect(quad(1.9, 1.5, x, floor + 5.4, DEP / 2 - 0.6 + 0.06, 0xffffff), MT.TOWN_ATLAS.cell(MT.TOWN_ATLAS.OPEN + 3)));
  for (const sx of [-1, 1]) {
    parts.push(cyl(1.1, 1.1, 0.25, 16, sx * (LEN / 2 + 0.13), floor + WH + 0.9, -0.6, C.rind, 0, 0, Math.PI / 2));
    parts.push(cyl(0.8, 0.8, 0.3, 16, sx * (LEN / 2 + 0.13), floor + WH + 0.9, -0.6, C.paste, 0, 0, Math.PI / 2));
  }
  // stacked wheels on the porch and by the gable ends
  const stack = (x, z, n2) => { for (let k = 0; k < n2; k++) parts.push(cyl(0.9, 0.9, 0.55, 14, x, floor + 0.3 + k * 0.56, z, k % 2 ? C.rind : C.rindDark)); };
  stack(-LEN / 2 + 3.5, DEP / 2 + 0.9, 4); stack(-LEN / 2 + 5.4, DEP / 2 + 1.1, 3); stack(LEN / 2 - 3.6, DEP / 2 + 1.0, 5);
  stack(LEN / 2 + 1.0, -2, 3); stack(-LEN / 2 - 1.0, 0.5, 2);
  // hay bales
  for (const [x, z] of [[-LEN / 2 - 0.6, 3.6], [LEN / 2 + 0.8, 2.8]]) parts.push(cyl(0.7, 0.7, 1.1, 10, x, floor + 0.7, z, 0xe2c46a, 0, 0, Math.PI / 2));
  const chutes = [], gaps = [];
  for (const h of rows) {
    const fh = track.frameAt(h.s);
    const lx = h.s - sMid;                                         // along-road offset of this row's door
    // big arched door (dark) on the road side
    parts.push(box(2.6, 3.0, 0.15, lx, floor + 1.5, DEP / 2 - 0.6 + 0.04, 0x2b1d14));
    parts.push(box(3.2, 0.35, 0.3, lx, floor + 3.15, DEP / 2 - 0.6 + 0.1, C.stoneDark));
    // trough floor ends: at the door (local) and at the gate lip (world)
    const a = toW(lx, floor + 0.35, DEP / 2 - 0.6);
    const wall = wallAt(fh);
    const bLat = from * (wall + 0.25);
    const b = { x: fh.x + fh.right.x * bLat, y: fh.y + 1.1, z: fh.z + fh.right.z * bLat };
    chutes.push({ h, a, b });
    gaps.push({ s: h.s, side: from, half: 1.4 });
    // the chute: floor + two side planks, on posts
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, len = Math.hypot(dx, dy, dz), hl = Math.hypot(dx, dz);
    const cyaw = Math.atan2(dx, dz), pitch = Math.atan2(-dy, hl);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    const W = 2.0;
    const trough = mergeParts([
      box(W, 0.12, len, 0, -0.06, 0, C.wood),
      box(0.12, 0.55, len, -W / 2, 0.22, 0, C.woodDark),
      box(0.12, 0.55, len, W / 2, 0.22, 0, C.woodDark),
    ]);
    place(trough, mid.x, mid.y, mid.z, cyaw, pitch);
    bucket.push(trough);
    const nPost = Math.max(2, Math.round(hl / 3));
    for (let k = 0; k <= nPost; k++) {
      const u = k / nPost;
      const x = lerp(a.x, b.x, u), z = lerp(a.z, b.z, u), y = lerp(a.y, b.y, u);
      ctx.exclusions.push([x, z, 2.2]);
      if (field.wallClearance(x, z) < 0.3) continue;
      const g = field.surfaceHeight(x, z);
      if (y - g < 0.2) continue;
      for (const sx of [-1, 1]) {
        const px = x + Math.cos(cyaw) * sx * W / 2, pz = z - Math.sin(cyaw) * sx * W / 2;
        bucket.push(box(0.2, y - g + 0.3, 0.2, px, (y + g - 0.3) / 2, pz, C.woodDark, cyaw));
        ctx.prop('chute', px, pz, 0.2);
      }
    }
    // gate posts either side of the barrier gap
    for (const da of [-1, 1]) {
      const q = pt(track, h.s + da * 1.55, from * (wall + 0.5));
      bucket.push(box(0.5, 2.2, 0.5, q.x, q.y + 1.1, q.z, C.stone, fh.yaw));
      bucket.push(cyl(0.34, 0.34, 0.12, 10, q.x, q.y + 2.26, q.z, C.rind));
      ctx.prop('gatepost', q.x, q.z, 0.36);
    }
  }
  for (const g of parts) if (!MT.hasAtlas(g)) MT.uvWhite(g);
  const barn = mergeParts(parts);
  MT.markAtlas(barn);
  bucket.push(fix(barn));
  for (const [px, pz] of rectOutline(rect(cx + nX * 0.6, cz + nZ * 0.6, yaw + Math.PI / 2, LEN / 2 + 1.5, DEP / 2 + 2.5), 1.5)) ctx.prop('dairy', px, pz, 0.3);
  ctx.exclusions.push([cx, cz, Math.hypot(LEN, DEP) / 2 + 3]);
  ctx.landmarks.push({ name: 'dairy', x: cx, z: cz, r: LEN / 2, h: floor + WH + 3 - gMin });
  return { chutes, gaps, floor };
}

// Cheese wheels: rind + paste + a paper band (instanced; axle along the
// track tangent). Chute phase: down the trough and over the gate lip onto
// the bank; road phase: the hazard's exact lateral; downhill: a hop over the
// far barrier and on down the slope, shrinking away.
export function buildCheeseWheels(ctx, field, hz, dairy) {
  const { track } = ctx;
  const rows = hz.list.filter((h) => h.type === 'wheel');
  if (!rows.length) return null;
  const R = rows[0].radius, Wd = HILLTOWN_TUNE.wheel.width;
  const rindTex = ctx.tex(MT.createRindTexture({ size: ctx.Q.veg >= 1 ? 256 : 128 }));
  rindTex.repeat.set(3, 1);
  const parts = [
    paint(new THREE.CylinderGeometry(R, R, Wd * 0.86, 24, 1, true), C.rind),                       // tread
    paint(new THREE.CylinderGeometry(R * 1.012, R * 1.012, Wd * 0.34, 24, 1, true), C.band),         // paper band
    paint(new THREE.CylinderGeometry(R * 0.985, R, Wd * 0.07, 24, 1, true).translate(0, Wd * 0.465, 0), C.rindDark),
    paint(new THREE.CylinderGeometry(R, R * 0.985, Wd * 0.07, 24, 1, true).translate(0, -Wd * 0.465, 0), C.rindDark),
    paint(new THREE.CircleGeometry(R * 0.985, 24).rotateX(-Math.PI / 2).translate(0, Wd / 2, 0), C.paste),
    paint(new THREE.CircleGeometry(R * 0.985, 24).rotateX(Math.PI / 2).translate(0, -Wd / 2, 0), C.paste),
    paint(new THREE.RingGeometry(R * 0.55, R * 0.62, 24).rotateX(-Math.PI / 2).translate(0, Wd / 2 + 0.005, 0), C.rindDark),
    paint(new THREE.RingGeometry(R * 0.55, R * 0.62, 24).rotateX(Math.PI / 2).translate(0, -Wd / 2 - 0.005, 0), C.rindDark),
  ];
  // red stripes on the band
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    parts.push(box(0.22, Wd * 0.36, 0.04, Math.sin(a) * R * 1.02, 0, Math.cos(a) * R * 1.02, C.bandRed, a));
  }
  const geo = mergeParts(parts).rotateX(Math.PI / 2);          // axle along local z (the track tangent)
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: rindTex });
  const cap = rows.length * 3;
  const inst = new THREE.InstancedMesh(geo, mat, cap);
  inst.frustumCulled = false;
  ctx.add(inst, { cast: true, receive: true, name: 'CheeseWheels' });
  const chuteOf = new Map((dairy ? dairy.chutes : []).map((c) => [c.h, c]));
  const vis = [];
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const W = HILLTOWN_TUNE.wheel;
  const pos = { x: 0, y: 0, z: 0 };
  const update = (t) => {
    let i = 0;
    for (const h of rows) {
      const f = track.frameAt(h.s, _f);
      const yaw = f.yaw, fx = f.x, fz = f.z, rx = f.right.x, rz = f.right.z, ry = f.y;
      const m = wheelVisuals(h, t, vis);
      const ch = chuteOf.get(h);
      for (let j = 0; j < m && i < cap; j++) {
        const v = vis[j];
        let roll = 0, sc = 1, wob = 0;
        const dir = -h.from;                                 // +1: rolling toward +lateral
        if (v.phase === 'road') {
          pos.x = fx + rx * v.lat; pos.z = fz + rz * v.lat; pos.y = ry + R;
          roll = (v.tau * h.speed) / R;
          wob = 0.05 * Math.sin(t * 9 + i);
        } else if (v.phase === 'chute') {
          const u = v.u;
          const bank = { x: fx + rx * h.from * h.travel / 2, z: fz + rz * h.from * h.travel / 2, y: ry };
          if (ch) {
            const k = 0.82;                                   // the last 18 %: off the lip, down onto the bank
            if (u < k) {
              const e = u / k;
              pos.x = lerp(ch.a.x, ch.b.x, e); pos.z = lerp(ch.a.z, ch.b.z, e); pos.y = lerp(ch.a.y, ch.b.y, e) + R;
            } else {
              const e = (u - k) / (1 - k);
              pos.x = lerp(ch.b.x, bank.x, e); pos.z = lerp(ch.b.z, bank.z, e);
              pos.y = lerp(ch.b.y + R, bank.y + R, e * e) + Math.sin(e * Math.PI) * 0.25;
            }
          } else {
            pos.x = bank.x - rx * dir * (1 - u) * 12; pos.z = bank.z - rz * dir * (1 - u) * 12; pos.y = bank.y + R + (1 - u) * 3;
          }
          roll = (v.tau * h.speed * 0.9) / R;
        } else {                                               // downhill: over the far barrier and away
          const u = v.u, wall = dir > 0 ? f.wallR : f.wallL;
          const lat0 = -h.from * h.travel / 2;
          const d = u * (W.downhill * h.speed * 1.15);
          const lat = lat0 + dir * d;
          pos.x = fx + rx * lat; pos.z = fz + rz * lat;
          const ground = Math.abs(lat) > wall + 0.6 ? Math.min(ry, field.surfaceHeight(pos.x, pos.z)) : ry;
          const hop = Math.max(0, Math.sin(clamp((Math.abs(lat) - Math.abs(lat0)) / (wall + 2.2 - Math.abs(lat0)), 0, 1) * Math.PI)) * 1.5;
          pos.y = Math.max(ground, ry - 30) + R + hop;
          roll = (h.travel + d) / R;
          sc = 1 - smoothstep((u - 0.7) / 0.3);
        }
        _e.set(wob, yaw, -dir * roll, 'YXZ');
        _q.setFromEuler(_e);
        _m4.compose(_p.set(pos.x, pos.y, pos.z), _q, _s.set(Math.max(0.001, sc), Math.max(0.001, sc), Math.max(0.001, sc)));
        inst.setMatrixAt(i++, _m4);
      }
    }
    for (; i < cap; i++) inst.setMatrixAt(i, hidden);
    inst.instanceMatrix.needsUpdate = true;
  };
  // keep trees / vines out of the wheels' downhill lanes
  for (const h of rows) {
    for (let d = 0; d < W.downhill * h.speed * 1.15; d += 3) {
      const q = pt(track, h.s, -h.from * (h.travel / 2 + d));
      ctx.exclusions.push([q.x, q.z, R + 1.5]);
    }
  }
  ctx.stats.instances.cheeseWheels = cap;
  return update;
}

// ------------------------------------------------------------------ belvedere

// The Belvedere: a paved terrace on a stone retaining wall outside the turn
// (beyond the barrier), a balustrade on its outer edge, coin telescopes on
// pedestals, benches, lamps and potted cypresses.
export function buildBelvedere(ctx, field, seg, side, { bucket, stone, lamps }) {
  const { track } = ctx;
  if (!seg) return;
  const a = seg.s0 + 4, b = seg.s1 - 4, DEEP = 8.5;
  const sl = sRange(a, b, 2);
  const wallOf = (f) => (side > 0 ? f.wallR : f.wallL);
  // ground minimum under the terrace (for the retaining face)
  let gMin = Infinity;
  for (const s of sl) { const q = pt(track, s, side * (wallOf(track.frameAt(s)) + DEEP)); gMin = Math.min(gMin, field.surfaceHeight(q.x, q.z)); }
  // top (paving), outer face, end faces
  const top = trackStrip(track, sl, 2, (f, s, c, o) => {
    const k = side > 0 ? c : 1 - c;
    o.lat = side * (wallOf(f) + (k ? DEEP : 0.56)); o.dy = -0.04;
    o.u = o.lat / 3; o.v = s / 3;
  });
  stone.push(paint(top, 0xefe2c8));
  const face = trackStrip(track, sl, 2, (f, s, c, o) => {
    const upper = side > 0 ? c === 0 : c === 1;
    o.lat = side * (wallOf(f) + DEEP);
    if (upper) o.dy = -0.04; else { o.y = gMin - 1.5; o.dy = 0; }
    o.u = s / 4; o.v = upper ? 1 : 0;
  });
  stone.push(paint(face, C.stoneWarm));
  for (const s of [a, b]) {
    const f = track.frameAt(s);
    const w0 = wallOf(f) + 0.56, w1 = wallOf(f) + DEEP;
    const mid = (w0 + w1) / 2;
    const q = pt(track, s, side * mid);
    const hgt = f.y - (gMin - 1.5);
    stone.push(paint(place(new THREE.BoxGeometry(w1 - w0, hgt, 0.4), q.x, f.y - 0.04 - hgt / 2, q.z, f.yaw + Math.PI / 2), C.stoneWarm));
  }
  // balustrade on the outer edge: posts + rail
  for (const s of sRange(a, b, 1.2)) {
    const f = track.frameAt(s), q = pt(track, s, side * (wallOf(f) + DEEP - 0.25));
    bucket.push(cyl(0.11, 0.15, 0.8, 6, q.x, f.y + 0.4, q.z, C.cream));
  }
  bucket.push(paint(trackStrip(track, sRange(a, b, 2), 2, (f, s, c, o) => {
    const k = side > 0 ? c : 1 - c;
    o.lat = side * (wallOf(f) + DEEP - 0.25 + (k ? 0.2 : -0.2)); o.dy = 0.9;
  }), C.trim));
  // telescopes, benches, lamps, potted cypresses
  const items = 5;
  for (let k = 0; k < items; k++) {
    const s = lerp(a + 4, b - 4, k / (items - 1)), f = track.frameAt(s);
    const yawOut = Math.atan2(f.right.x * side, f.right.z * side);
    if (k % 2 === 0) {
      const q = pt(track, s, side * (wallOf(f) + DEEP - 1.3));
      const tg = mergeParts([
        cyl(0.16, 0.24, 1.1, 8, 0, 0.55, 0, C.iron),
        box(0.42, 0.5, 0.4, 0, 1.3, 0, 0x3f7a5a),
        cyl(0.13, 0.13, 0.75, 8, -0.1, 1.42, 0.25, 0x2a2e33, 0, Math.PI / 2 - 0.15),
        cyl(0.13, 0.13, 0.75, 8, 0.1, 1.42, 0.25, 0x2a2e33, 0, Math.PI / 2 - 0.15),
      ]);
      place(tg, q.x, f.y, q.z, yawOut);
      bucket.push(tg);
      ctx.prop('telescope', q.x, q.z, 0.4);
    } else {
      const q = pt(track, s, side * (wallOf(f) + DEEP * 0.45));
      const bench = mergeParts([box(2.0, 0.12, 0.6, 0, 0.5, 0, C.wood), box(2.0, 0.5, 0.1, 0, 0.8, -0.3, C.wood), box(0.12, 0.5, 0.5, -0.85, 0.25, 0, C.iron), box(0.12, 0.5, 0.5, 0.85, 0.25, 0, C.iron)]);
      place(bench, q.x, f.y, q.z, yawOut + Math.PI);
      bucket.push(bench);
      ctx.prop('bench', q.x, q.z, 1.05);
      const qq = pt(track, s, side * (wallOf(f) + DEEP - 0.9));
      lamps.push([qq.x, f.y, qq.z, f.yaw, 0.9]);
    }
  }
  for (const s of [a + 1.5, b - 1.5]) {
    const f = track.frameAt(s), q = pt(track, s, side * (wallOf(f) + DEEP * 0.5));
    bucket.push(cyl(0.6, 0.45, 0.8, 8, q.x, f.y + 0.4, q.z, 0xb5653a));
    bucket.push(paint(lumpy(new THREE.ConeGeometry(0.75, 4.2, 7), 0.1, 1, 1, 1, 3).translate(q.x, f.y + 2.9, q.z), 0x2f6a3c));
    ctx.prop('pot', q.x, q.z, 0.75);
  }
  // exclusions: the terrace footprint (no trees / houses on it)
  for (const s of sRange(a, b, 4)) { const q = pt(track, s, side * (wallOf(track.frameAt(s)) + DEEP / 2)); ctx.exclusions.push([q.x, q.z, DEEP / 2 + 1.2]); }
  ctx.landmarks.push({ name: 'belvedere', x: pt(track, (a + b) / 2, side * 20).x, z: pt(track, (a + b) / 2, side * 20).z, r: 6, h: 3 });
}

// ------------------------------------------------------------------ Piazza Alta

// Piazza Alta's west side (left of the road): a generic church facade facing
// the fountain jets (pediment, rose window, portal, pilasters; nave + apse
// behind), café tables under umbrellas either side of the church axis, lamps.
// The paving slab + the terrain flattening live in world-monte.js (PIAZZA_ALTA).
export function buildPiazzaAlta(ctx, field, alta, { bucket, lamps, rng }) {
  const { track } = ctx;
  if (!alta) return;
  const { sC, side, l0, l1 } = alta;
  const f = track.frameAt(sC);
  const towardRoad = { x: -f.right.x * side, z: -f.right.z * side };
  const yawFace = Math.atan2(towardRoad.x, towardRoad.z);       // facade normal → the road
  const y0 = f.y - 0.06;
  // church: facade at lateral l1 - DEPTH ... (centre line on the jets' row)
  const FW = 15, FH = 17, NAVE = 24, NW = 13;
  const latF = side * (l1 - NAVE - 3);                           // facade line
  const cxF = f.x + f.right.x * latF, czF = f.z + f.right.z * latF;
  const parts = [];
  // nave + apse behind the facade (local +z = toward the road)
  parts.push(MT.uvStucco(box(NW, FH - 4, NAVE, 0, y0 + (FH - 4) / 2, -NAVE / 2, 0xf1e4c8), y0, y0 + FH - 4));
  {
    const [sl, gb] = gableRoof(NAVE, NW, 3.6, 0.5, C.roof, 0xf1e4c8);
    parts.push(MT.uvRoof(sl, 3.6).rotateY(Math.PI / 2).translate(0, y0 + FH - 4, -NAVE / 2), MT.uvStucco(gb, -2, 6).rotateY(Math.PI / 2).translate(0, y0 + FH - 4, -NAVE / 2));
  }
  parts.push(cyl(NW / 2 - 0.5, NW / 2 - 0.5, FH - 6, 14, 0, y0 + (FH - 6) / 2, -NAVE, 0xf1e4c8));
  parts.push(paint(new THREE.ConeGeometry(NW / 2 - 0.2, 3.2, 14).translate(0, y0 + FH - 6 + 1.6, -NAVE), C.roof));
  // facade: wall, two-tone bands, pilasters, pediment, rose window, portal, steps
  parts.push(MT.uvStucco(box(FW, FH, 1.2, 0, y0 + FH / 2, 0.6, 0xf7efe0), y0, y0 + FH));
  for (const y of [6.2, 11.6]) parts.push(box(FW + 0.4, 0.45, 1.5, 0, y0 + y, 0.65, 0xd9c7a2));
  for (const x of [-FW / 2 + 0.6, -FW / 6, FW / 6, FW / 2 - 0.6]) parts.push(box(0.9, FH - 0.5, 1.5, x, y0 + (FH - 0.5) / 2, 0.75, 0xe6d6b4));
  parts.push(paint(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-FW / 2 - 0.4, 0, 1.45), new THREE.Vector3(FW / 2 + 0.4, 0, 1.45), new THREE.Vector3(0, 4.2, 1.45),
  ]).translate(0, y0 + FH, 0), 0xe6d6b4));
  parts.push(box(FW + 0.8, 0.5, 1.6, 0, y0 + FH + 0.1, 0.7, 0xd9c7a2));
  parts.push(cyl(2.0, 2.0, 0.3, 20, 0, y0 + 13.6, 1.25, 0xd9c7a2, 0, Math.PI / 2));
  parts.push(cyl(1.6, 1.6, 0.34, 16, 0, y0 + 13.6, 1.3, 0x3d6fa8, 0, Math.PI / 2));
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; parts.push(box(0.14, 3.0, 0.1, 0, y0 + 13.6, 1.5, 0xf0e2c0, 0, 0, a)); }
  parts.push(box(3.4, 5.0, 0.3, 0, y0 + 2.5, 1.25, 0x5a3822));                    // doors
  parts.push(cyl(1.9, 1.9, 0.5, 12, 0, y0 + 5.0, 1.35, 0xd9c7a2, 0, Math.PI / 2)); // lunette
  parts.push(cyl(1.5, 1.5, 0.55, 12, 0, y0 + 5.0, 1.4, 0x7a5a3a, 0, Math.PI / 2));
  for (let k = 0; k < 3; k++) parts.push(box(FW * 0.55 - k * 0.6, 0.18, 1.0, 0, y0 + 0.09 + k * 0.18, 1.7 + (2 - k) * 0.55, 0xe9dcc0));
  // small bell-gable on the ridge (two bells)
  parts.push(box(3.2, 3.2, 0.6, 0, y0 + FH + 4.2 + 1.2, -0.2, 0xf7efe0));
  for (const x of [-0.75, 0.75]) parts.push(paint(new THREE.ConeGeometry(0.45, 0.8, 10).translate(x, y0 + FH + 5.2, -0.2), C.bronze));
  for (const p2 of parts) if (!MT.hasAtlas(p2)) MT.uvWhite(p2);
  const g = mergeParts(parts);
  MT.markAtlas(g);
  place(g, cxF, 0, czF, yawFace);
  bucket.push(g);
  const rcC = rect(cxF - towardRoad.x * (NAVE / 2), czF - towardRoad.z * (NAVE / 2), yawFace, NW / 2 + 1, NAVE / 2 + 2);
  for (const [px, pz] of rectOutline(rcC, 1.5)) ctx.prop('church', px, pz, 0.6);
  ctx.exclusions.push([rcC.x, rcC.z, Math.hypot(NW, NAVE) / 2 + 3]);
  ctx.exclusions.push([cxF + towardRoad.x * 4, czF + towardRoad.z * 4, 5]);
  ctx.landmarks.push({ name: 'church', x: cxF, z: czF, r: FW / 2, h: FH + 7 });
  // café tables either side of the church axis
  const canopyCols = [0xe8475f, 0x3d8f5a, 0x2f7ad0, 0xf2a03a];
  let n = 0;
  for (let da = -48; da <= 48; da += 8) {
    if (Math.abs(da) < 12) continue;
    for (const ll of [l0 + 5, l0 + 11]) {
      if (ctx.Q.veg < 1 && n % 2) { n++; continue; }
      const q = pt(track, sC + da + (rng() - 0.5) * 2, side * (ll + (rng() - 0.5)));
      if (field.wallClearance(q.x, q.z) < 2.6) continue;
      const col = canopyCols[n % canopyCols.length];
      const canopy = new THREE.ConeGeometry(1.9, 0.75, 8, 1).toNonIndexed();
      faceColors(canopy, (yy, ny, fi) => (fi % 2 ? 0xfff6e8 : col));
      bucket.push(paint(place(canopy, q.x, y0 + 2.8, q.z, rng()), null));
      bucket.push(cyl(0.05, 0.05, 2.8, 5, q.x, y0 + 1.4, q.z, 0xeeeeee));
      bucket.push(cyl(0.55, 0.55, 0.06, 10, q.x, y0 + 0.75, q.z, 0xf7f7f2));
      bucket.push(cyl(0.06, 0.06, 0.72, 5, q.x, y0 + 0.37, q.z, 0x2e3436));
      for (const k of [0, 1]) {
        const ca = rng() * 6.28, px = q.x + Math.cos(ca) * 0.95, pz = q.z + Math.sin(ca) * 0.95;
        bucket.push(box(0.45, 0.45, 0.45, px, y0 + 0.22, pz, k ? 0x3d6fb0 : 0xc25a3a, ca));
      }
      ctx.prop('umbrella', q.x, q.z, 1.9);
      ctx.exclusions.push([q.x, q.z, 2.4]);
      n++;
    }
  }
  // lamps along both edges of the piazza
  for (let da = -54; da <= 54; da += 18) {
    for (const sd of [-1, 1]) {
      const fs = track.frameAt(sC + da);
      const lat = sd * ((sd > 0 ? fs.wallR : fs.wallL) + 1.2);
      const q = pt(track, sC + da, lat);
      if (ctx.exclusions.some(([ex, ez, er]) => Math.hypot(q.x - ex, q.z - ez) < er)) continue;
      lamps.push([q.x, fs.y - 0.06, q.z, fs.yaw, 1]);
      ctx.exclusions.push([q.x, q.z, 1.0]);
    }
  }
  // the summit's open (east) edge: potted cypresses along the barrier
  for (let da = -52; da <= 52; da += 13) {
    const fs = track.frameAt(sC + da), lat = -side * (side > 0 ? fs.wallL : fs.wallR) - side * 2.4;
    const q = pt(track, sC + da, lat);
    if (field.wallClearance(q.x, q.z) < 1.6) continue;
    bucket.push(cyl(0.7, 0.5, 0.9, 8, q.x, fs.y + 0.45, q.z, 0xb5653a));
    bucket.push(paint(lumpy(new THREE.ConeGeometry(0.9, 5.2, 7), 0.1, 1, 1, 1, 5).translate(q.x, fs.y + 3.4, q.z), 0x2f6a3c));
    ctx.prop('pot', q.x, q.z, 0.9);
    ctx.exclusions.push([q.x, q.z, 1.6]);
  }
  ctx.stats.instances.altaCafe = n;
}

// ------------------------------------------------------------------ switchback shrines

// Small roadside shrines (edicole) on the outside of both tornanti, beyond
// the barrier, facing the road: a stone pillar with an arched niche and a
// little tiled roof, flowers and candles at its foot. `spots`: [{ s, side }]
// (the bend's middle); the shrine takes the first spot near it that keeps
// clear of the kit's turn signs.
export function buildShrines(ctx, field, spots, bucket) {
  const { track } = ctx;
  let placed = 0;
  const signs = (ctx.stats.props || []).filter((p) => p[3] === 'sign');
  for (const { s: sMid, side } of spots) {
    let q = null, f = null;
    for (const ds of [0, 7, -7, 14, -14, 21, -21]) {
      f = track.frameAt(sMid + ds);
      const wall = side > 0 ? f.wallR : f.wallL;
      const c = pt(track, sMid + ds, side * (wall + 1.7), {});
      if (signs.some(([x, z, r]) => Math.hypot(x - c.x, z - c.z) < r + 2.4)) continue;
      q = c;
      break;
    }
    if (!q) continue;
    const g0 = Math.min(field.surfaceHeight(q.x, q.z), f.y - 0.2);
    const parts = [
      box(1.5, 0.5, 1.1, 0, g0 + 0.25, 0, C.stoneDark),
      box(1.2, 2.6, 0.8, 0, g0 + 0.5 + 1.3, 0, C.stone),
      box(0.7, 1.0, 0.06, 0, g0 + 2.1, 0.41, 0x2a3a5a),
      cyl(0.35, 0.35, 0.07, 12, 0, g0 + 2.6, 0.4, 0x2a3a5a, 0, Math.PI / 2),
      ball(0.18, 0, g0 + 2.05, 0.42, 0xf7f2e8, 1, 1.4, 0.6),
      box(1.0, 0.08, 0.3, 0, g0 + 1.55, 0.55, C.stoneWarm),
    ];
    for (const gg of gableRoof(1.5, 1.2, 0.55, 0.15, C.roof, C.stone)) parts.push(gg.translate(0, g0 + 3.1, 0));
    for (let k = 0; k < 5; k++) parts.push(ball(0.13, -0.38 + k * 0.19, g0 + 1.66, 0.58, k % 2 ? 0xe8475f : 0xf2a03a));
    for (const x of [-0.25, 0.25]) parts.push(cyl(0.04, 0.04, 0.22, 5, x, g0 + 1.7, 0.5, 0xfff6e0));
    for (let k = 0; k < 4; k++) parts.push(ball(0.28, -0.55 + k * 0.37, g0 + 0.62, 0.62, k % 2 ? 0x5aa847 : 0xf28ab8, 1, 0.8, 1));
    const geo = mergeParts(parts);
    const yawFace = Math.atan2(-f.right.x * side, -f.right.z * side);
    place(geo, q.x, 0, q.z, yawFace);
    bucket.push(geo);
    ctx.prop('shrine', q.x, q.z, 0.85);
    ctx.exclusions.push([q.x, q.z, 2.4]);
    placed++;
  }
  ctx.stats.instances.shrines = placed;
}

// Pictogram warning signs before the set pieces (no text): a red-bordered
// triangle on a post beyond the barrier on both sides, `kind` 'scooter' |
// 'fountain' | 'wheel' drawn in dark boxes. `at`: [{ s, kind }].
export function buildWarningSigns(ctx, at, bucket) {
  const { track } = ctx;
  const icon = (kind) => {
    const D = 0x23262b, p = [];
    if (kind === 'scooter') {
      p.push(cyl(0.11, 0.11, 0.06, 10, -0.3, 0.86, 0.07, D, 0, Math.PI / 2), cyl(0.11, 0.11, 0.06, 10, 0.3, 0.86, 0.07, D, 0, Math.PI / 2));
      p.push(box(0.62, 0.1, 0.06, 0, 0.98, 0.07, D), box(0.08, 0.34, 0.06, 0.26, 1.12, 0.07, D), box(0.22, 0.14, 0.06, -0.12, 1.08, 0.07, D), box(0.12, 0.2, 0.06, -0.1, 1.22, 0.07, D));
    } else if (kind === 'fountain') {
      p.push(box(0.6, 0.08, 0.06, 0, 0.82, 0.07, D));
      for (const x of [-0.22, 0, 0.22]) p.push(box(0.07, x ? 0.36 : 0.52, 0.06, x, x ? 1.02 : 1.1, 0.07, 0x2f6fb8));
    } else {
      p.push(cyl(0.27, 0.27, 0.06, 14, 0, 1.03, 0.07, 0xd8941e, 0, Math.PI / 2), cyl(0.17, 0.17, 0.07, 12, 0, 1.03, 0.07, 0xf6dc8a, 0, Math.PI / 2));
      p.push(box(0.5, 0.06, 0.06, -0.05, 0.74, 0.07, D, 0, 0, 0.25));
    }
    return p;
  };
  let n = 0;
  for (const { s, kind } of at) {
    for (const side of [-1, 1]) {
      const f = track.frameAt(s), wall = side > 0 ? f.wallR : f.wallL;
      const q = pt(track, s, side * (wall + 0.9));
      const parts = [cyl(0.06, 0.06, 2.4, 6, 0, 1.2, -0.04, 0x9aa0a8)];
      const tri = new THREE.CylinderGeometry(0.75, 0.75, 0.06, 3, 1).rotateX(Math.PI / 2).rotateZ(Math.PI).translate(0, 2.4 + 0.26, 0);
      parts.push(paint(tri, 0xd83a2e));
      const inner = new THREE.CylinderGeometry(0.56, 0.56, 0.08, 3, 1).rotateX(Math.PI / 2).rotateZ(Math.PI).translate(0, 2.4 + 0.22, 0.01);
      parts.push(paint(inner, 0xfaf6ee));
      for (const g of icon(kind)) parts.push(g.translate(0, 1.6, 0));
      const geo = mergeParts(parts);
      place(geo, q.x, f.y, q.z, f.yaw + Math.PI);            // facing the oncoming karts
      bucket.push(geo);
      ctx.prop('warning', q.x, q.z, 0.35);
      n++;
    }
  }
  ctx.stats.instances.warningSigns = n;
}

// ------------------------------------------------------------------ road decals

/**
 * Zone road surfaces drawn as decals over the cobbles (one draw call per
 * material): fan setts in the piazzas, slabs on the aqueduct deck,
 * herringbone brick in the Espresso Works, scooter lanes on Via Vespa.
 * `ranges`: { setts: [[s0, s1]], slabs: [[s0, s1]], brick: [[s0, s1]], lanes: [[s0, s1]] }.
 * `shade(s)` (optional) darkens covered sections when there is no shadow map.
 */
export function buildRoadDecals(ctx, ranges, { shade = null } = {}) {
  const a = ctx.maxAniso, big = ctx.Q.veg >= 1 ? 1024 : 512;
  const inset = (f) => f.halfWidth - 0.75;                    // keep the painted edge lines visible
  const make = (list, opts) => list.map(([s0, s1]) => {
    const g = roadDecal(ctx, s0, s1, { latA: (f) => -inset(f), latB: inset, ...opts });
    if (shade) {
      const p = g.attributes.position, n = p.count, col = new Float32Array(n * 3);
      const proj = {};
      for (let i = 0; i < n; i++) {
        ctx.track.project({ x: p.getX(i), y: p.getY(i), z: p.getZ(i) }, -1, proj);
        const k = shade(proj.s);
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    return g;
  });
  const out = [];
  const add = (name, list, tex, opts, matOpts = {}) => {
    if (!list || !list.length) return;
    const geos = make(list, opts);
    if (!shade) for (const g of geos) g.deleteAttribute('color');
    const mat = decalMaterial({ map: ctx.tex(tex), vertexColors: !!shade, ...matOpts });
    out.push(addMerged(ctx, geos, mat, { receive: true, name }));
  };
  add('RoadSetts', ranges.setts, MT.createFanSettTexture({ size: big, aniso: a }), { tile: 4, uSpan: 4 });
  add('RoadSlabs', ranges.slabs, MT.createSlabTexture({ size: big, aniso: a }), { tile: 4, uSpan: 4.2 });
  add('RoadBrick', ranges.brick, MT.createHerringboneTexture({ size: big, aniso: a }), { tile: 3, uSpan: 3 });
  if (ranges.lanes && ranges.lanes.length) {
    const geos = ranges.lanes.map(([s0, s1]) => roadDecal(ctx, s0, s1, { latA: (f) => -inset(f), latB: inset, tile: 12, dy: 0.016 }));
    const mat = decalMaterial({ map: ctx.tex(MT.createLaneTexture({ size: 512, aniso: a })), transparent: true, depthWrite: false, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    out.push(addMerged(ctx, geos, mat, { receive: true, name: 'RoadLanes' }));
  }
  return out;
}

export { C as SETPIECE_COLORS };
