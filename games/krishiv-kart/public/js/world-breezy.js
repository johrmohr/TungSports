// Breezy Bay Circuit: the v5 set pieces and landmarks (browser only; SPEC
// §16.1, notes/research-v5-tracks.md §B1 / C1-C3). world.js buildWorld builds
// the terrain, road, walls and the v3 landmarks, then calls these:
//
//   dressBreezyRoad(ctx, T, opts)         road macro variation + sand drifts (shader patch), sand
//                                         verges on the beach loop, the road-paint decal atlas
//                                         (skid marks, crab / wave / ball pictograms)
//   patchBreezyTerrain(ctx, mesh)         sandstone strata on every steep face (cliffs, notch, quay)
//   buildBreezySetPieces(ctx, field, hz)  crabs, the tide surge (sheet, offshore crest, spray),
//                                         beach balls (+ launcher and catch net), their sounds and
//                                         hit callouts; returns a disposer
//   buildBreezyLandmarks(ctx, field, geo) harbour (quay, pier, crane, boats, slipway, cottages),
//                                         the spit beacon, lagoon reeds and egrets, the Gull Gap
//                                         timber deck + surf + gulls, the causeway breakwater, the
//                                         promenade boardwalk + kiosk, the pier with the Ferris wheel
//
// Hazards are drawn from hz.time / hz.stateAt(h) (hazards/bay.js is the single
// source of truth); the kit ticks the clock only when nobody else drives it.
// Perf: every effect is one InstancedMesh or one merged / shader-animated mesh.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, clamp, lerp, smoothstep } from './utils.js';
import { bus } from './bus.js';
import { registerSound, SYNTH } from './audio.js';
import * as TX from './textures.js';
import * as BT from './world-breezy-textures.js';
import {
  WATER_LEVEL, place, paint, faceColors, mixHex, place_m4, addMerged, trackStrip, sRange, decalMaterial,
  buildTimberDeck, lumpy, box, cyl, ball, cone, mergeParts, addInstancedSet, segByName, curbWidth, gableRoof,
} from './world.js';
import { BAY_TUNE, surgeEdge } from './hazards/bay.js';

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _col = new THREE.Color();
const _f = {};

// TRS with full Euler (YXZ: yaw, pitch, roll) into m.
function compose(m, x, y, z, yaw, pitch, roll, sx, sy, sz) {
  _e.set(pitch, yaw, roll, 'YXZ');
  _q.setFromEuler(_e);
  return m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}
const zone = (track, type) => track.zones.find((z) => z.type === type) || null;
const zonesOf = (track, type) => track.zones.filter((z) => z.type === type);
const inZ = (track, z, s) => track.forwardDistance(z.s0, s) <= track.forwardDistance(z.s0, z.s1);

// ------------------------------------------------------------------ sounds (telegraphs, SPEC §16.1 A3.2)

let soundsReady = false;
function registerBaySounds() {
  if (soundsReady) return;
  soundsReady = true;
  // crab: two dry claw clacks
  registerSound('crabClack', (ac, out, o) => {
    const { t, p } = SYNTH.opt(ac, o);
    for (const dt of [0, 0.11]) {
      SYNTH.hiss(ac, out, t + dt, { type: 'bandpass', f0: 3200 * p, Q: 6, dur: 0.035, peak: 0.32 });
      SYNTH.blip(ac, out, t + dt, { type: 'square', f0: 1400 * p, f1: 900 * p, dur: 0.03, peak: 0.08 });
    }
    return 0.2;
  }, 1.2);
  // surge build: a low rumble swelling offshore
  registerSound('waveRumble', (ac, out, o) => {
    const { t, p } = SYNTH.opt(ac, o);
    SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 180 * p, f1: 520 * p, sweep: 1.4, Q: 0.8, dur: 1.5, peak: 0.42, attack: 0.9 });
    SYNTH.blip(ac, out, t, { type: 'sine', f0: 55 * p, f1: 70 * p, glide: 1.4, dur: 1.4, peak: 0.12, attack: 0.8 });
    return 1.6;
  }, 1.1);
  // surge wash: a crashing hiss
  registerSound('waveWash', (ac, out, o) => {
    const { t, p } = SYNTH.opt(ac, o);
    SYNTH.hiss(ac, out, t, { type: 'bandpass', f0: 2400 * p, f1: 600 * p, sweep: 0.9, Q: 0.6, dur: 1.0, peak: 0.45, attack: 0.02 });
    SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 400 * p, Q: 0.7, dur: 0.6, peak: 0.25 });
    return 1.0;
  }, 1.2);
  // beach ball: a rubbery boing
  registerSound('ballBoing', (ac, out, o) => {
    const { t, p } = SYNTH.opt(ac, o);
    SYNTH.blip(ac, out, t, { type: 'sine', f0: 210 * p, f1: 420 * p, glide: 0.09, dur: 0.22, peak: 0.3, vib: 30, vibRate: 22 });
    SYNTH.blip(ac, out, t, { type: 'triangle', f0: 110 * p, f1: 160 * p, dur: 0.12, peak: 0.12 });
    return 0.25;
  }, 1.2);
}

// ------------------------------------------------------------------ road dressing

/**
 * Road macro variation + sand drifts at the edges of the beach loop (a shader
 * patch on the kit's road material), sand verges on the sandy stretches, and
 * the road-paint decals. opts.sandAt(s, side) → 0..1 (side 0 = the road).
 */
export function dressBreezyRoad(ctx, T, { sandAt }) {
  const { track } = ctx;
  const road = ctx.root.getObjectByName('Road');
  const macro = ctx.tex(BT.createMacroNoiseTexture());
  const sandCol = new THREE.Color(0xeedaa6);
  if (road) {
    const g = road.geometry, n = g.attributes.position.count, cols = 5;
    const aSand = new Float32Array(n);
    for (let i = 0; i < n; i++) aSand[i] = sandAt(ctx.loopS[Math.floor(i / cols)] ?? 0, 0);
    g.setAttribute('aSand', new THREE.BufferAttribute(aSand, 1));
    const mat = road.material;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uMacro = { value: macro };
      sh.uniforms.uSandCol = { value: sandCol };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aSand;\nvarying float vSand;\nvarying vec2 vRoadUv;\nvarying vec3 vRoadW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSand = aSand; vRoadUv = uv; vRoadW = (modelMatrix * vec4(position, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uMacro;\nuniform vec3 uSandCol;\nvarying float vSand;\nvarying vec2 vRoadUv;\nvarying vec3 vRoadW;')
        .replace('#include <map_fragment>', /* glsl */`
          #include <map_fragment>
          float mac = texture2D(uMacro, vRoadW.xz / 64.0).r * 0.62 + texture2D(uMacro, vRoadW.xz / 15.0 + 0.37).r * 0.38;
          diffuseColor.rgb *= 0.9 + 0.2 * mac;                            // patched / weathered asphalt, no stamped look
          float edge = abs(vRoadUv.x * 2.0 - 1.0);
          float grit = texture2D(uMacro, vRoadW.xz / 3.5).r, lobe = texture2D(uMacro, vRoadW.xz / 11.0 + 0.6).r;
          float drift = smoothstep(0.8, 0.86, edge + (lobe - 0.5) * 0.42 + (grit - 0.5) * 0.08);   // crisp windblown drifts at the edges
          float dust = vSand * max(drift, 0.12 * smoothstep(0.5, 0.95, edge));
          diffuseColor.rgb = mix(diffuseColor.rgb, uSandCol * (0.94 + 0.12 * grit), clamp(dust, 0.0, 0.95));`);
    };
    mat.customProgramCacheKey = () => 'breezy-road';
    mat.needsUpdate = true;
  }

  // sand verges (from the curb to just past the wall) where sandAt(s, side) > 0
  const sandTex = ctx.tex(BT.createSandTexture({ aniso: ctx.maxAniso }));
  const strips = [];
  for (const side of [-1, 1]) {
    let run = null;
    const flush = () => {
      if (!run || run.s1 - run.s0 < 4) { run = null; return; }
      strips.push(trackStrip(track, sRange(run.s0, run.s1, 1), 2, (f, s, c, o) => {
        const k = side > 0 ? c : 1 - c;
        const wall = side > 0 ? f.wallR : f.wallL;
        const e = k ? wall + 0.5 : f.halfWidth + curbWidth(f, side) - 0.02;
        o.lat = side * e; o.dy = 0.018;
        o.u = o.lat / 7; o.v = s / 7;
        const a = clamp(sandAt(s, side), 0, 1);
        o.r = o.g = o.b = a;
      }, { color: true }));
      run = null;
    };
    for (let s = 0; s <= track.length; s += 2) {
      const a = sandAt(s, side);
      if (a > 0.02) { if (!run) run = { s0: Math.max(0, s - 2), s1: s }; run.s1 = s; } else flush();
    }
    flush();
  }
  if (strips.length) {
    const vm = new THREE.MeshLambertMaterial({ map: sandTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    // vertex colour = coverage: used as alpha so the sand fades in at the run ends
    vm.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 color;\nvarying float vCover;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCover = color.r;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vCover;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vCover;');
    };
    vm.customProgramCacheKey = () => 'breezy-sandverge';
    const mesh = addMerged(ctx, strips, vm, { receive: true, name: 'SandVerges' });
    if (mesh) mesh.renderOrder = 1;
  }

  // road paint: skid marks at the apexes, hazard pictograms before the set pieces
  const atlas = ctx.tex(BT.createBayDecalAtlas({ aniso: ctx.maxAniso }));
  const decals = [];
  const cellStrip = (cell, s0, s1, latA, latB, { step = 0.5, flip = false } = {}) => {
    const [u0, v0, u1, v1] = BT.BAY_DECALS[cell];
    decals.push(trackStrip(track, sRange(s0, s1, step), 2, (f, s, c, o) => {
      o.lat = c ? latB : latA; o.dy = 0.016;
      const t = (s - s0) / (s1 - s0);
      o.u = lerp(u0 + 0.004, u1 - 0.004, flip ? 1 - c : c); o.v = lerp(v0 + 0.004, v1 - 0.004, t);
    }));
  };
  // skids: the inside of Turn 1 and the Lighthouse Hairpin apex
  for (const [name, k, len] of [['Turn 1', 0.5, 16], ['Lighthouse Hairpin', 0.45, 20], ['Spit Turn A', 0.55, 14], ['Spit Turn B', 0.5, 14]]) {
    const g = segByName(track, name);
    if (!g) continue;
    const sm = g.s0 + (g.s1 - g.s0) * k, f = track.frameAt(sm);
    const inside = Math.sign(f.curvature || 1) * (f.halfWidth - 4.2);
    cellStrip('skid', sm - len / 2, sm + len / 2, inside - 2.6, inside + 2.6);
  }
  // pictograms 30-45 m before each set piece, on the approaching lane(s)
  // elongated along the road like real road markings (they read right from a kart's low eye)
  const pict = (cell, s, lats, w = 5.5, len = 11) => { for (const l of lats) cellStrip(cell, s - len / 2, s + len / 2, l - w / 2, l + w / 2); };
  const hz = (ctx.track.def.hazards || []);
  const sOf = (type) => { const d = hz.find((h) => h.type === type); return d ? track.sOfKey(d, d.u0 !== undefined || d.f0 !== undefined || d.s0 !== undefined ? '0' : '') : NaN; };
  if (Number.isFinite(sOf('crab'))) pict('crab', sOf('crab') - 26, [-4.5, 4.5]);
  if (Number.isFinite(sOf('surge'))) pict('wave', sOf('surge') - 14, [-5.5]);
  if (Number.isFinite(sOf('ball'))) pict('ball', sOf('ball') - 30, [-4.5, 4.5]);
  if (decals.length) {
    const dm = new THREE.MeshStandardMaterial({ map: atlas, transparent: true, depthWrite: false, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const mesh = addMerged(ctx, decals, dm, { receive: true, name: 'RoadPaint' });
    if (mesh) mesh.renderOrder = 2;
  }
}

// ------------------------------------------------------------------ terrain strata

/** Sandstone strata on steep terrain faces (world-space bands; one extra texture fetch). */
export function patchBreezyTerrain(ctx, mesh) {
  if (!mesh) return;
  const strata = ctx.tex(BT.createStrataTexture({ aniso: ctx.maxAniso }));
  const mat = mesh.material;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uStrata = { value: strata };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTerrW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrW = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D uStrata;\nvarying vec3 vTerrW;')
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        vec3 tn = normalize(cross(dFdx(vTerrW), dFdy(vTerrW)));
        float steep = smoothstep(0.42, 0.78, 1.0 - abs(tn.y));
        if (steep > 0.0) {
          vec2 th = normalize(vec2(-tn.z, tn.x) + vec2(1e-4, 0.0));
          vec2 suv = vec2(dot(vTerrW.xz, th) / 9.0, vTerrW.y / 8.0);
          vec3 strata = texture2D(uStrata, suv).rgb;
          diffuseColor.rgb = mix(diffuseColor.rgb, strata * mix(0.8, 1.0, smoothstep(-2.0, 2.0, vTerrW.y)), steep * 0.92);
        }`);
  };
  mat.customProgramCacheKey = () => 'breezy-terrain';
  mat.needsUpdate = true;
}

// ------------------------------------------------------------------ set pieces

/**
 * Crabs, the tide surge and the beach balls (hz = the bay hazard set; the
 * world exposes it as world.hazards). Returns dispose().
 */
export function buildBreezySetPieces(ctx, field, hz) {
  registerBaySounds();
  const updaters = [];
  const offs = [];
  const crabs = hz.list.filter((h) => h.type === 'crab');
  const surges = hz.list.filter((h) => h.type === 'surge');
  const balls = hz.list.filter((h) => h.type === 'ball');
  if (crabs.length) updaters.push(buildCrabViews(ctx, field, hz, crabs));
  if (surges.length) updaters.push(buildSurgeViews(ctx, field, hz, surges));
  if (balls.length) updaters.push(buildBallViews(ctx, field, hz, balls));

  // drawn at hz.time; tick the clock ourselves only if nobody else does
  let last = hz.time;
  ctx.animators.push((dt) => {
    if (!hz.driven) hz.time += dt;
    const t = hz.time, jumped = t < last || t - last > 0.5;     // restart / scrub: no stale sounds
    for (const u of updaters) u(t, jumped ? t : last, dt, jumped);
    last = t;
  });
  for (const u of updaters) u(hz.time, hz.time, 0);

  // hit callouts (the player's own view; main.js shows hud:flash only for humans)
  offs.push(bus.on('kart:spin', (e) => { if (e && e.cause === 'crab') bus.emit('hud:flash', { kart: e.kart, text: 'PINCHED!', color: '#ff6b3d', size: 'medium', duration: 1.0 }); }));
  offs.push(bus.on('kart:slow', (e) => { if (e && e.cause === 'surge') bus.emit('hud:flash', { kart: e.kart, text: 'SPLASH!', color: '#5fe0ff', size: 'medium', duration: 0.9 }); }));
  offs.push(bus.on('kart:knock', (e) => { if (e && e.cause === 'ball') bus.emit('hud:flash', { kart: e.kart, text: 'BOING!', color: '#ffd23a', size: 'medium', duration: 0.8 }); }));
  ctx.stats.hazards = hz.list.length;
  return () => { offs.forEach((off) => off()); offs.length = 0; };
}

const sfxAt = (name, x, y, z, volume = 1, pitch = 1) => bus.emit('item:sfx', { name, position: new THREE.Vector3(x, y, z), volume, pitch });

// ---- crabs: a big friendly sand crab, facing the oncoming karts, walking sideways
function buildCrabViews(ctx, field, hz, crabs) {
  const { track } = ctx;
  const n = crabs.length;
  const shell = 0xe8532c, shellDark = 0xc23a1f, belly = 0xf5b07a;
  // body (local: +x = the walking axis = road right, +z = toward the karts, y up)
  const bodyParts = [
    paint(lumpy(new THREE.DodecahedronGeometry(1, 1), 0.08, 1.3, 0.5, 0.95, 4).translate(0, 0.62, 0), shell),
    paint(new THREE.SphereGeometry(0.85, 10, 6, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45).scale(1.35, 0.6, 0.95).translate(0, 0.66, 0), belly),
  ];
  for (const k of [-0.55, 0, 0.55]) bodyParts.push(paint(new THREE.SphereGeometry(0.2, 6, 4).scale(1, 0.55, 1).translate(k, 1.12, -0.15 + Math.abs(k) * 0.1), shellDark));
  for (const sx of [-1, 1]) {
    bodyParts.push(paint(new THREE.CylinderGeometry(0.05, 0.06, 0.42, 5).translate(sx * 0.3, 1.25, 0.62), shellDark));      // eye stalks
    bodyParts.push(paint(new THREE.SphereGeometry(0.16, 8, 6).translate(sx * 0.3, 1.5, 0.64), 0xfafafa));
    bodyParts.push(paint(new THREE.SphereGeometry(0.08, 6, 4).translate(sx * 0.3, 1.52, 0.77), 0x111111));
  }
  bodyParts.push(paint(new THREE.TorusGeometry(0.16, 0.035, 4, 8, Math.PI).rotateZ(Math.PI).translate(0, 0.78, 0.86), 0x7a1a10));   // smile
  const bodyG = mergeParts(bodyParts);
  // claws (both, pivoting together about the shoulder line at the origin; raised = pitch up)
  const clawParts = [];
  for (const sx of [-1, 1]) {
    clawParts.push(paint(new THREE.CylinderGeometry(0.11, 0.14, 0.75, 6).rotateX(Math.PI / 2).translate(sx * 0.9, 0.05, 0.35), shell));
    clawParts.push(paint(new THREE.SphereGeometry(0.34, 8, 6).scale(0.8, 0.75, 1.15).translate(sx * 0.98, 0.1, 0.85), shell));
    clawParts.push(paint(new THREE.ConeGeometry(0.17, 0.62, 6).rotateX(Math.PI / 2).translate(sx * 0.9, 0.22, 1.25), shellDark));      // pincer top
    clawParts.push(paint(new THREE.ConeGeometry(0.13, 0.5, 6).rotateX(Math.PI / 2).translate(sx * 1.08, -0.02, 1.2), shellDark));     // pincer bottom
  }
  const clawG = mergeParts(clawParts);
  // one leg: hip at the origin, pointing +x, two segments bent down to the sand
  const legG = mergeParts([
    paint(new THREE.CylinderGeometry(0.07, 0.09, 0.8, 5).rotateZ(-Math.PI / 2 + 0.55).translate(0.34, 0.2, 0), shell),
    paint(new THREE.CylinderGeometry(0.035, 0.07, 0.85, 5).rotateZ(-0.35).translate(0.86, -0.08, 0), shellDark),
  ]);
  const mat = ctx.M.structure;
  const bodies = new THREE.InstancedMesh(bodyG, mat, n);
  const claws = new THREE.InstancedMesh(clawG, mat, n);
  const legs = new THREE.InstancedMesh(legG, mat, n * 8);
  for (const m of [bodies, claws, legs]) m.frustumCulled = false;
  ctx.add(bodies, { cast: true, receive: true, name: 'Crabs' });
  ctx.add(claws, { cast: true, name: 'CrabClaws' });
  ctx.add(legs, { cast: true, name: 'CrabLegs' });
  // sand puffs (a recycled pool)
  const PUFFS = 14 * n;
  const puffG = paint(new THREE.IcosahedronGeometry(0.3, 0), 0xe8d3a0);
  const puffs = new THREE.InstancedMesh(puffG, ctx.M.veg, PUFFS);
  puffs.frustumCulled = false;
  ctx.add(puffs, { name: 'CrabPuffs' });
  const pool = Array.from({ length: PUFFS }, () => ({ x: 0, y: -99, z: 0, age: 9, life: 0.6 }));
  let pk = 0;
  const rng = makeRng(404);
  const frames = crabs.map((h) => track.frameAt(h.s, {}));
  const prevLat = crabs.map((h) => hz.stateAt(h, hz.time).lat);
  const legPhase = crabs.map(() => 0);
  const prevClaws = crabs.map(() => 0);
  const pt = new THREE.Vector3();
  ctx.stats.instances.crabs = n;
  return (t, tPrev, dt) => {
    for (let i = 0; i < n; i++) {
      const h = crabs[i], f = frames[i], st = hz.stateAt(h, t);
      track.pointAt(h.s, st.lat, pt);
      const yaw = f.yaw + Math.PI;                       // face the karts; local +x = road right
      const moved = Math.abs(st.lat - prevLat[i]);
      prevLat[i] = st.lat;
      legPhase[i] += moved * 2.6 + dt * 0.8;
      const bob = st.walking ? 0.07 * Math.abs(Math.sin(legPhase[i] * 2)) : 0.02 * Math.sin(t * 3 + i);
      const roll = st.walking ? st.dir * 0.08 : 0;
      compose(_m4, pt.x, pt.y + bob, pt.z, yaw, 0, roll, 1, 1, 1);
      bodies.setMatrixAt(i, _m4);
      // claws: raised during the pauses (the reversal telegraph), snapping a little
      const raise = st.claws;
      const snap = raise > 0.3 ? 0.08 * Math.sin(t * 18 + i) : 0;
      const cx = pt.x - f.tangent.x * 0.55, cz = pt.z - f.tangent.z * 0.55;   // shoulder line (toward the karts)
      compose(_m4, cx, pt.y + 0.72 + bob + raise * 0.25, cz, yaw, -0.25 - raise * 0.95 + snap, roll, 1, 1, 1);
      claws.setMatrixAt(i, _m4);
      if (raise > 0.5 && prevClaws[i] <= 0.5 && t > tPrev) sfxAt('crabClack', pt.x, pt.y + 1, pt.z, 1, 1 + 0.08 * i);
      prevClaws[i] = raise;
      // legs: 4 per side, alternating gait
      const rx = f.right.x, rz = f.right.z, tx = -f.tangent.x, tz = -f.tangent.z;
      for (let side = -1, j = 0; side <= 1; side += 2) {
        for (let k = 0; k < 4; k++, j++) {
          const zk = 0.42 - k * 0.28;                    // along the body (local z)
          const ph = legPhase[i] * 3 + k * Math.PI * 0.5 + (side > 0 ? Math.PI : 0);
          const lift = st.walking ? Math.max(0, Math.sin(ph)) * 0.45 : 0.05 * Math.sin(t * 2 + k);
          const sweep = st.walking ? Math.cos(ph) * 0.3 : 0;
          const hx = pt.x + rx * side * 0.78 + tx * zk, hz2 = pt.z + rz * side * 0.78 + tz * zk;
          compose(_m4, hx, pt.y + 0.5 + bob, hz2, yaw + (side > 0 ? 0 : Math.PI) + sweep * side + (k - 1.5) * 0.28 * side, 0, lift, 1, 1, 1);
          legs.setMatrixAt(i * 8 + j, _m4);
        }
      }
      // sand puffs while walking
      if (st.walking && dt > 0 && rng() < dt * 14) {
        const pp = pool[pk++ % PUFFS], side = rng() < 0.5 ? -1 : 1;
        pp.x = pt.x + rx * side * 1.4 + tx * (rng() - 0.5); pp.z = pt.z + rz * side * 1.4 + tz * (rng() - 0.5);
        pp.y = pt.y + 0.1; pp.age = 0; pp.life = 0.45 + rng() * 0.35;
      }
    }
    for (let k = 0; k < PUFFS; k++) {
      const pp = pool[k];
      pp.age += dt;
      const u = pp.age / pp.life;
      if (u >= 1) { place_m4(_m4, 0, -99, 0, 0, 0.001, 0.001, 0.001); puffs.setMatrixAt(k, _m4); continue; }
      const sc = (0.6 + u * 1.4) * Math.sin(Math.PI * Math.min(1, u * 1.2));
      place_m4(_m4, pp.x, pp.y + u * 0.5, pp.z, u * 3, Math.max(0.001, sc), Math.max(0.001, sc * 0.7), Math.max(0.001, sc));
      puffs.setMatrixAt(k, _m4);
    }
    bodies.instanceMatrix.needsUpdate = true;
    claws.instanceMatrix.needsUpdate = true;
    legs.instanceMatrix.needsUpdate = true;
    puffs.instanceMatrix.needsUpdate = true;
  };
}

// ---- tide surge: a water sheet across the causeway from the sea edge to the
// waterline (+ foam front, wet sheen after it recedes), an offshore crest that
// rises during the build and breaks over the seawall, spray at the wall
function buildSurgeViews(ctx, field, hz, surges) {
  const { track } = ctx;
  const foam = ctx.tex(BT.createFoamTexture());
  const ups = [];
  const time = { value: 0 };
  for (const h of surges) {
    const side = h.side;
    const sA = h.s - 2, sB = h.s + h.len + 2;
    const rows = sRange(sA, sB, 1);
    const COLS = 34;
    // column laterals (side-relative "depth" dd = side * lat: from beyond the sea wall to past the max reach)
    const latAt = (f, c) => {
      const wall = side > 0 ? f.wallR : f.wallL;
      const outer = side * (wall + 2.5), inner = -side * h.hw * 0.75;
      return lerp(outer, inner, c / (COLS - 1));
    };
    const g = trackStrip(track, rows, COLS, (f, s, c, o) => {
      const lat = latAt(f, c);
      o.lat = side > 0 ? latAt(f, COLS - 1 - c) : lat;   // columns left → right
      const L = o.lat, wall = side > 0 ? f.wallR : f.wallL;
      const beyond = side * L - wall;                      // > 0 outside the seawall
      // over the wall top, then down to the sea surface outside
      o.dy = beyond < -0.2 ? 0.05 : beyond < 0.6 ? 0.95 : lerp(0.95, WATER_LEVEL - f.y + 0.05, smoothstep((beyond - 0.6) / 1.4));
      o.u = L; o.v = s - h.s;
    });
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 }, uEdge: { value: 99 }, uWetEdge: { value: 99 }, uWet: { value: 0 }, uActive: { value: 0 },
        uSide: { value: side }, uFoam: { value: null }, uDeep: { value: new THREE.Color(0x0f7fb8) }, uShallow: { value: new THREE.Color(0x3fd0d8) },
      }]),
      vertexShader: /* glsl */`
        uniform float uTime, uEdge, uActive, uSide;
        varying vec2 vUv; varying vec3 vW;
        #include <fog_pars_vertex>
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          // the wash rolls in as a swell: a raised lip just behind the waterline, ripples behind it
          float dd = uSide * (uv.x - uEdge);
          float lip = exp(-pow((dd - 0.9) / 0.9, 2.0));
          wp.y += uActive * (0.32 * lip + step(0.0, dd) * 0.05 * sin(uTime * 5.0 + wp.x * 0.9 + wp.z * 0.7));
          vW = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uEdge, uWetEdge, uWet, uActive, uSide;
        uniform sampler2D uFoam;
        uniform vec3 uDeep, uShallow;
        varying vec2 vUv; varying vec3 vW;
        #include <common>
        #include <fog_pars_fragment>
        void main() {
          float lat = vUv.x;
          float dd = uSide * (lat - uEdge);                 // > 0: on the sea side of the waterline
          float f1 = texture2D(uFoam, vW.xz * 0.11 + vec2(uTime * 0.05, -uTime * 0.21 * uSide)).a;
          float f2 = texture2D(uFoam, vW.xz * 0.23 + vec2(-uTime * 0.09, uTime * 0.13)).a;
          float wob = (f1 - 0.5) * 0.9;
          float water = uActive * smoothstep(-0.15, 0.45, dd + wob);
          float front = uActive * (1.0 - smoothstep(0.2, 2.2, dd + wob * 1.4)) * smoothstep(-0.6, 0.1, dd + wob);
          vec3 col = mix(uShallow, uDeep, smoothstep(0.8, 7.0, dd));
          float streak = smoothstep(0.35, 0.8, f2) * water;
          col = mix(col, vec3(1.0), clamp(front * 0.95 + streak * 0.3, 0.0, 1.0));
          float a = water * mix(0.68, 0.92, smoothstep(0.0, 5.0, dd)) + front * 0.35;
          // wet sheen where the last wave reached (dries out between waves)
          float wet = uWet * smoothstep(-0.4, 0.6, uSide * (lat - uWetEdge) + wob * 0.6) * (1.0 - water);
          col = mix(col, vec3(0.16, 0.2, 0.22), wet / max(a + wet, 1e-3));
          a = a + wet * 0.28;
          if (a < 0.01) discard;
          gl_FragColor = vec4(col, clamp(a, 0.0, 0.95));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      transparent: true, depthWrite: false, fog: true,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    mat.uniforms.uFoam.value = foam;
    mat.uniforms.uTime = time;
    const sheet = ctx.add(new THREE.Mesh(g, mat), { name: 'SurgeSheet' });
    sheet.renderOrder = 3;

    // the offshore crest: a long breaking wave parallel to the causeway (a straight)
    const fm = track.frameAt(h.s + h.len / 2);
    const wall = side > 0 ? fm.wallR : fm.wallL;
    const crestLen = h.len + 26;
    // across (+ = toward land), height, colour: deep back, teal face, a white curling lip, teal front face
    const prof = [[-1.6, 0, 0x14709a], [-0.7, 0.55, 0x1f9cc0], [-0.1, 0.92, 0x6fdde8], [0.25, 1.0, 0xffffff], [0.55, 0.9, 0xf2fdff], [0.45, 0.62, 0x48c6d8], [0.75, 0.25, 0x2aa9c9], [1.0, 0, 0x1a8fb5]];
    const pos = [], col = [], idx = [];
    const segs = 24;
    for (let a = 0; a <= segs; a++) {
      const along = -crestLen / 2 + (crestLen * a) / segs;
      const taper = Math.sin(Math.PI * a / segs) ** 0.5;
      for (const [acr, hgt, c] of prof) {
        // local: x = along the tangent, z = toward land (−side · right), y = height (scaled per frame)
        pos.push(along, hgt * taper, acr * (0.8 + 0.4 * taper));
        _col.set(c); col.push(_col.r, _col.g, _col.b);
      }
    }
    const P = prof.length;
    for (let a = 0; a < segs; a++) for (let k = 0; k < P - 1; k++) {
      const i0 = a * P + k, i1 = i0 + 1, i2 = i0 + P, i3 = i2 + 1;
      idx.push(i0, i2, i1, i1, i2, i3);
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    cg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    cg.setIndex(idx);
    cg.computeVertexNormals();
    const crestMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.94, side: THREE.DoubleSide, emissive: 0x0a3040 });
    const crest = ctx.add(new THREE.Mesh(cg, crestMat), { name: 'SurgeCrest' });
    crest.frustumCulled = false;
    // orientation: local x → tangent, local z → toward land (−side · right)
    const lx = new THREE.Vector3(fm.tangent.x, 0, fm.tangent.z), lz = new THREE.Vector3(-side * fm.right.x, 0, -side * fm.right.z);
    const basis = new THREE.Matrix4().makeBasis(lx, new THREE.Vector3(0, 1, 0), lz);
    crest.quaternion.setFromRotationMatrix(basis);
    const wallX = fm.x + fm.right.x * side * wall, wallZ = fm.z + fm.right.z * side * wall;

    // spray at the seawall when the wave breaks
    const SPRAY = 44;
    const sprayG = paint(new THREE.IcosahedronGeometry(0.3, 0), 0xffffff);
    const spray = new THREE.InstancedMesh(sprayG, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true }), SPRAY);
    spray.frustumCulled = false;
    ctx.add(spray, { name: 'SurgeSpray' });
    const drops = Array.from({ length: SPRAY }, () => ({ x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, age: 9, life: 1 }));
    let dk = 0;
    const rng = makeRng(77 + h.index);
    let prevPhase = '';
    ups.push((t, tPrev, dt, jumped) => {
      const st = hz.stateAt(h, t);
      time.value = t;
      mat.uniforms.uEdge.value = st.edge;
      mat.uniforms.uActive.value = st.reach > 0 ? 1 : 0;
      mat.uniforms.uWetEdge.value = surgeEdge(h, st.full);
      mat.uniforms.uWet.value = st.wet * (st.reach > 0 ? 1 : 0.85);
      // crest: rises offshore during the build, rushes in and breaks during the wash
      let dist, hgt;
      if (st.phase === 'calm') { dist = 22; hgt = 0.15 + 0.1 * Math.sin(t * 1.3); }
      else if (st.phase === 'build') { const b = smoothstep(st.build); dist = lerp(24, 6, b); hgt = lerp(0.4, 4.4, b); }
      else if (st.phase === 'wash') { const w = clamp((st.p - 0.65) / 0.05, 0, 1); dist = lerp(6, -1, w); hgt = lerp(4.4, 2.2, w); }
      else { dist = -1; hgt = Math.max(0.05, 2.2 * (1 - clamp((st.p - 0.7) / 0.1, 0, 1))); }
      crest.visible = hgt > 0.08;
      crest.position.set(wallX + fm.right.x * side * dist, WATER_LEVEL - 0.1, wallZ + fm.right.z * side * dist);
      crest.scale.set(1, Math.max(0.01, hgt), lerp(1.4, 2.6, clamp(hgt / 4.4, 0, 1)));
      // phase sounds + spray burst
      if (st.phase !== prevPhase && t > tPrev) {
        if (st.phase === 'build') sfxAt('waveRumble', wallX, fm.y + 1, wallZ, 1.1, 1);
        if (st.phase === 'wash') {
          sfxAt('waveWash', wallX, fm.y + 1, wallZ, 1.2, 1);
          for (let k = 0; k < 34; k++) {
            const d = drops[dk++ % SPRAY], a = (rng() - 0.5) * (h.len + 8);
            d.x = wallX + fm.tangent.x * a - side * fm.right.x * rng() * 0.6; d.z = wallZ + fm.tangent.z * a - side * fm.right.z * rng() * 0.6; d.y = fm.y + 0.6 + rng() * 0.5;
            const out = 1.5 + rng() * 4;
            d.vx = -side * fm.right.x * out + fm.tangent.x * (rng() - 0.5) * 2; d.vz = -side * fm.right.z * out + fm.tangent.z * (rng() - 0.5) * 2; d.vy = 3 + rng() * 5.5;
            d.age = 0; d.life = 0.55 + rng() * 0.6;
          }
        }
      }
      prevPhase = st.phase;
      if (jumped) for (const d of drops) d.age = 9;                          // scrubbed / restarted: no frozen spray
      for (let k = 0; k < SPRAY; k++) {
        const d = drops[k];
        d.age += dt;
        if (d.age >= d.life) { place_m4(_m4, 0, -99, 0, 0, 0.001, 0.001, 0.001); spray.setMatrixAt(k, _m4); continue; }
        d.vy -= 9 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        const u = d.age / d.life, sc = (0.6 + u * 2.2) * (1 - u * u);
        place_m4(_m4, d.x, d.y, d.z, k, Math.max(0.001, sc), Math.max(0.001, sc), Math.max(0.001, sc));
        spray.setMatrixAt(k, _m4);
      }
      spray.instanceMatrix.needsUpdate = true;
    });
  }
  return (t, tPrev, dt, jumped) => { for (const u of ups) u(t, tPrev, dt, jumped); };
}

// ---- beach balls: giant striped balls bouncing across the promenade from the
// beach launcher to the catch net on the town side
function buildBallViews(ctx, field, hz, list) {
  const { track } = ctx;
  const total = list.reduce((a, h) => a + (h.count || 1), 0);
  const R0 = list[0].radius;
  const g = new THREE.SphereGeometry(R0, 24, 14).toNonIndexed();
  const stripes = [0xff4b4b, 0xffffff, 0xffd23a, 0xffffff, 0x3fa7ff, 0xffffff, 0x4fd16a, 0xffffff];
  faceColors(g, () => 0xffffff);
  {
    const p = g.attributes.position, c = g.attributes.color;
    for (let i = 0; i < p.count; i += 3) {
      let ax = 0, ay = 0, az = 0;
      for (let k = 0; k < 3; k++) { ax += p.getX(i + k); ay += p.getY(i + k); az += p.getZ(i + k); }
      const lon = Math.atan2(az, ax), lat = ay / 3 / R0;
      const k = Math.floor(((lon + Math.PI) / (Math.PI * 2)) * stripes.length) % stripes.length;
      _col.set(Math.abs(lat) > 0.86 ? 0xffffff : stripes[k]);
      for (let j = 0; j < 3; j++) c.setXYZ(i + j, _col.r, _col.g, _col.b);
    }
  }
  g.computeVertexNormals();
  const bm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0 });
  const ballsMesh = new THREE.InstancedMesh(g, bm, total);
  ballsMesh.frustumCulled = false;
  ctx.add(ballsMesh, { cast: true, name: 'BeachBalls' });
  const shG = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
  const shM = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
  const shadows = new THREE.InstancedMesh(shG, shM, total);
  shadows.frustumCulled = false;
  ctx.add(shadows, { name: 'BallShadows' });
  ctx.stats.instances.beachBalls = total;
  const state = list.map((h) => ({ h, f: track.frameAt(h.s, {}), spin: new Float32Array(h.count || 1), wasDown: new Uint8Array(h.count || 1) }));
  const pt = new THREE.Vector3();
  const spinQ = new THREE.Quaternion(), baseQ = new THREE.Quaternion(), axis = new THREE.Vector3();
  return (t, tPrev, dt) => {
    let i = 0;
    for (const S of state) {
      const h = S.h, n = h.count || 1, f = S.f, tTravel = h.travel / h.speed, idle = h.period - tTravel;
      const st = hz.stateAt(h, t);
      for (let k = 0; k < n; k++, i++) {
        const b = st.balls[k];
        let lat = b.lat, bottom = b.bottom, sc = 1;
        if (!b.active) {
          const u = clamp((b.tau - tTravel) / Math.max(1e-3, idle), 0, 1);
          if (u < 0.5) { lat = -h.from * h.travel / 2 - h.from * h.speed * (b.tau - tTravel); sc = 1 - smoothstep(u / 0.5); }
          else {
            const tt = b.tau - h.period;                               // < 0: just before the next start
            lat = h.from * h.travel / 2 - h.from * h.speed * tt;
            bottom = h.bounce * Math.abs(Math.sin(Math.PI * (tt + (h.bounce0 || 0)) / h.hop));
            sc = smoothstep((u - 0.5) / 0.5);
          }
        }
        track.pointAt(h.s, lat, pt);
        const ground = Math.max(pt.y, field.surfaceHeight(pt.x, pt.z));
        const squash = bottom < 0.18 && sc > 0.9 ? 1 - (0.18 - bottom) * 1.1 : 1;
        // roll: spin about the track tangent as it crosses (sign by direction)
        S.spin[k] = (lat / (h.radius)) * -h.from;
        axis.set(f.tangent.x, 0, f.tangent.z).normalize();
        spinQ.setFromAxisAngle(axis, S.spin[k]);
        baseQ.copy(spinQ);
        _m4.compose(_p.set(pt.x, (lat === b.lat ? pt.y : ground) + bottom + h.radius * squash * sc, pt.z), baseQ, _s.set(sc * (2 - squash), Math.max(0.001, sc * squash), sc * (2 - squash)));
        ballsMesh.setMatrixAt(i, _m4);
        const sh = sc * h.radius * (1.05 - Math.min(0.5, bottom / 6));
        place_m4(_m4, pt.x, (lat === b.lat ? pt.y : ground) + 0.03, pt.z, 0, Math.max(0.001, sh), 1, Math.max(0.001, sh));
        shadows.setMatrixAt(i, _m4);
        const down = b.active && bottom < 0.12 ? 1 : 0;
        if (down && !S.wasDown[k] && t > tPrev) sfxAt('ballBoing', pt.x, pt.y + 1, pt.z, 0.8, 0.9 + 0.1 * k);
        S.wasDown[k] = down;
      }
    }
    ballsMesh.instanceMatrix.needsUpdate = true;
    shadows.instanceMatrix.needsUpdate = true;
  };
}

// ------------------------------------------------------------------ landmarks

/**
 * Static scenery of the v5 layout. geo = { notch: { s0, s1 } | null, structure: [] (painted
 * geometries merged by the caller into the shared structure bucket) }.
 */
export function buildBreezyLandmarks(ctx, field, geo) {
  const { track, Q } = ctx;
  const parts = [];                      // merged with ctx.M.structure (cast + receive)
  const rng = makeRng(2026);
  const plankParts = [];                 // plank-textured decks (boardwalk + the Gull Gap deck)
  const prop = (kind, x, z, r) => { ctx.prop(kind, x, z, r); ctx.exclusions.push([x, z, r + 1.5]); };
  const P = (s, lat, out = new THREE.Vector3()) => track.pointAt(s, lat, out);
  const wallOf = (f, side) => (side > 0 ? f.wallR : f.wallL);

  // ---- the Gull Gap: timber deck over the surf notch, surf foam below, gulls above
  if (geo.notch) {
    const { s0, s1 } = geo.notch;
    const deckParts = [];
    buildTimberDeck(ctx, field, s0, s1, { bucket: deckParts, decals: plankParts, rails: true, postStep: 4.5, beam: 0.9 });
    parts.push(...deckParts);
    // stone abutments at both ends of the deck (into the notch walls)
    for (const [s, dir] of [[s0, 1], [s1, -1]]) {
      const f = track.frameAt(s + dir * 0.8);
      const w = f.wallL + f.wallR + 1.6, top = f.y - 0.9, bot = WATER_LEVEL - 2.5;
      parts.push(paint(place(new THREE.BoxGeometry(w, top - bot, 1.6), f.x + f.right.x * (f.wallR - f.wallL) / 2, (top + bot) / 2, f.z + f.right.z * (f.wallR - f.wallL) / 2, f.yaw), 0xb08a5c));
    }
    // surf foam in the notch (animated alpha sheet on the water)
    const foamTex = ctx.tex(BT.createFoamTexture({ seed: 311 }));
    // soft-edged: RGBA vertex colours fade the sheet out toward its rim (vertexAlphas)
    const FC = 7, rowsN = sRange(s0 - 8, s1 + 8, 2);
    const fg = trackStrip(track, rowsN, FC, (f, s, c, o, r) => {
      o.lat = lerp(-(f.wallL + 14), f.wallR + 10, c / (FC - 1)); o.y = WATER_LEVEL + 0.04; o.dy = 0; o.u = o.lat / 9; o.v = s / 9;
    });
    {
      const n = fg.attributes.position.count, rgba = new Float32Array(n * 4).fill(1), R = rowsN.length;
      for (let r = 0; r < R; r++) for (let c = 0; c < FC; c++) {
        const a = Math.min(1, Math.min(r, R - 1 - r) / 3) * Math.min(1, Math.min(c, FC - 1 - c) / 1.5);
        rgba[(r * FC + c) * 4 + 3] = a;
      }
      fg.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
    }
    const fmat = new THREE.MeshBasicMaterial({ map: foamTex, vertexColors: true, transparent: true, depthWrite: false, opacity: 0.85, fog: true });
    const foamMesh = ctx.add(new THREE.Mesh(fg, fmat), { name: 'NotchSurf' });
    foamMesh.renderOrder = -5;
    ctx.animators.push((dt, time) => { foamTex.offset.set(Math.sin(time * 0.6) * 0.08, time * 0.05); fmat.opacity = 0.6 + 0.3 * Math.abs(Math.sin(time * 0.9)); });
  }
  buildGulls(ctx, geo);

  // ---- the causeway breakwater (rocks along the sea side) + the beach loop's rock pools
  const cz = zone(track, 'causeway');
  const rockSpots = [];
  if (cz) {
    for (let s = cz.s0 - 20; s < cz.s1 + 12; s += 2.2 + rng() * 1.6) {
      const f = track.frameAt(s), sc = lerp(0.8, 1.7, rng());
      const lat = -(f.wallL + 1.2 + sc * 0.9 + rng() * 2.2);
      const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
      if (field.wallClearance(x, z) < sc * 1.3 + 0.4) continue;
      rockSpots.push([x, Math.min(field.surfaceHeight(x, z), f.y - 0.3) - sc * 0.25, z, rng() * 6.28, sc, field.wallClearance(x, z), sc * 1.3]);
    }
  }
  const crab = segByName(track, 'Crab Cove');
  const pools = [];
  if (crab) {
    for (let s = crab.s0 + 4; s < crab.s1 - 4; s += 9 + rng() * 6) {
      const f = track.frameAt(s), lat = -(f.wallL + 3 + rng() * 6);
      const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat, gy = field.surfaceHeight(x, z);
      if (gy < WATER_LEVEL + 0.2 || field.wallClearance(x, z) < 2) continue;
      const r = 0.9 + rng() * 1.1;
      pools.push(paint(place(new THREE.CircleGeometry(r, 10).rotateX(-Math.PI / 2), x, gy + 0.04, z), 0x3fb4c4));
      for (let k = 0; k < 5; k++) { const a = rng() * 6.28, sc = 0.35 + rng() * 0.4; rockSpots.push([x + Math.cos(a) * (r + 0.2), gy - 0.1, z + Math.sin(a) * (r + 0.2), rng() * 6, sc, 9, sc * 1.3]); }
      // crab burrows: little dark holes with a sand rim
      const bx = x + f.tangent.x * 4, bz = z + f.tangent.z * 4, by = field.surfaceHeight(bx, bz);
      if (field.wallClearance(bx, bz) > 1.5) {
        pools.push(paint(place(new THREE.CircleGeometry(0.35, 8).rotateX(-Math.PI / 2), bx, by + 0.05, bz), 0x4a3a24));
        pools.push(paint(place(new THREE.TorusGeometry(0.42, 0.1, 4, 10).rotateX(Math.PI / 2), bx, by + 0.03, bz), 0xd9c08a));
      }
      ctx.exclusions.push([x, z, r + 1.5]);
    }
  }
  if (pools.length) addMerged(ctx, pools, new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), { receive: true, name: 'RockPools' });
  if (rockSpots.length) {
    const rock = paint(lumpy(new THREE.DodecahedronGeometry(1.0, 0), 0.35, 1.2, 0.72, 1, 3), 0x9c9284);
    addInstancedSet(ctx, 'Breakwater', rock, rockSpots, rng, { near: 30, tints: [0xffffff, 0xf2ece2, 0xe4dccf], tint: [1.05, 1.3] });
  }

  // ---- harbour (Ramp Run: the bay side is a stone quay)
  const hb = zone(track, 'harbor');
  if (hb) buildHarbour(ctx, field, hb, parts, rng);

  // ---- the spit beacon on the island inside the Spit Turn double apex
  const sa = segByName(track, 'Spit Turn A'), sb = segByName(track, 'Spit Turn B');
  if (sa && sb) {
    const fa = track.frameAt((sa.s0 + sa.s1) / 2), fb = track.frameAt((sb.s0 + sb.s1) / 2);
    const ca = { x: fa.x + fa.right.x / Math.abs(fa.curvature) * Math.sign(fa.curvature), z: fa.z + fa.right.z / Math.abs(fa.curvature) * Math.sign(fa.curvature) };
    const cb = { x: fb.x + fb.right.x / Math.abs(fb.curvature) * Math.sign(fb.curvature), z: fb.z + fb.right.z / Math.abs(fb.curvature) * Math.sign(fb.curvature) };
    const bx = (ca.x + cb.x) / 2, bz = (ca.z + cb.z) / 2, gy = field.surfaceHeight(bx, bz) - 0.1;
    parts.push(paint(place(new THREE.CylinderGeometry(1.8, 2.2, 0.8, 10), bx, gy + 0.4, bz), 0x8e8a82));
    const H = 9.5;
    for (let k = 0; k < 5; k++) {
      const y0 = 0.8 + (k / 5) * H, y1 = 0.8 + ((k + 1) / 5) * H;
      parts.push(paint(place(new THREE.CylinderGeometry(lerp(0.95, 0.6, (k + 1) / 5), lerp(0.95, 0.6, k / 5), y1 - y0, 10), bx, gy + (y0 + y1) / 2, bz), k % 2 ? 0xffffff : 0xe2312a));
    }
    parts.push(paint(place(new THREE.CylinderGeometry(1.0, 1.0, 0.2, 10), bx, gy + H + 0.9, bz), 0x30343c));
    parts.push(paint(place(new THREE.ConeGeometry(0.75, 0.9, 10), bx, gy + H + 2.3, bz), 0xe2312a));
    // a little railing gallery and a ladder
    parts.push(paint(place(new THREE.TorusGeometry(1.0, 0.04, 4, 16).rotateX(Math.PI / 2), bx, gy + H + 1.5, bz), 0x30343c));
    for (let k = 0; k < 10; k++) parts.push(paint(place(new THREE.BoxGeometry(0.5, 0.05, 0.05), bx + 0.95, gy + 1.2 + k * 0.9, bz), 0x30343c));
    const lamp = ctx.add(new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.9, 10), new THREE.MeshBasicMaterial({ color: 0xffe9a0, toneMapped: false })), { name: 'BeaconLamp' });
    lamp.position.set(bx, gy + H + 1.45, bz);
    ctx.animators.push((dt, time) => { const on = (time % 2.4) < 0.5; lamp.material.color.setHex(on ? 0xfff2b0 : 0x8a6d3a); });
    ctx.landmarks.push({ name: 'beacon', x: bx, z: bz, r: 2.2, h: gy + H + 3 });
    prop('beacon', bx, bz, 2.2);
  }

  // ---- the lagoon: reeds round the shore, egrets in the shallows
  buildLagoon(ctx, field, rng, geo.lagoon);

  // ---- promenade: boardwalk beside the beach, a kiosk; the pier with the Ferris wheel offshore
  buildPromenade(ctx, field, parts, plankParts, rng);

  if (plankParts.length) {
    const plank = ctx.tex(TX.createPlankTexture({ aniso: ctx.maxAniso, base: [176, 128, 82], planks: 8 }));
    const pm = decalMaterial({ map: plank });
    addMerged(ctx, plankParts, pm, { receive: true, name: 'Planks' });
  }
  if (parts.length) {
    // region buckets keep the shadow / view culling local
    const cells = new Map();
    for (const g of parts) {
      g.computeBoundingBox();
      const bb = g.boundingBox, key = `${Math.floor((bb.min.x + bb.max.x) / 2 / 160)},${Math.floor((bb.min.z + bb.max.z) / 2 / 160)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(g);
    }
    let k = 0;
    for (const list of cells.values()) addMerged(ctx, list, ctx.M.structure, { cast: true, receive: true, name: `BayProps${k++}` });
  }
}

// Quay coping + stone face, bollards, a pier with a crane, moored boats, the
// slipway beside the kicker, fishermen's cottages on the town side.
function buildHarbour(ctx, field, hb, parts, rng) {
  const { track, Q } = ctx;
  const s0 = hb.s0 + 8, s1 = hb.s1 - 4;
  const stone = ctx.tex(TX.createStoneBlockTexture({ aniso: ctx.maxAniso }));
  const quay = [];
  const CO = 1.95;                                     // quay edge, m beyond the wall
  // coping (flat, over the terrain lip) and the face down into the water
  quay.push(trackStrip(track, sRange(s0, s1, 1), 2, (f, s, c, o) => {
    o.lat = c ? -(f.wallL + 0.45) : -(f.wallL + CO); o.dy = 0.04; o.u = o.lat / 2; o.v = s / 2;
  }));
  quay.push(trackStrip(track, sRange(s0, s1, 1), 2, (f, s, c, o) => {
    o.lat = -(f.wallL + CO); o.dy = c ? 0.04 : WATER_LEVEL - f.y - 3.5; o.u = s / 4; o.v = c ? 1 : 0;
  }));
  addMerged(ctx, quay, new THREE.MeshLambertMaterial({ map: stone, color: 0xd9d2c4 }), { receive: true, name: 'Quay' });
  // bollards
  const bollards = [];
  for (let s = s0 + 3; s < s1 - 2; s += 9) {
    const f = track.frameAt(s), lat = -(f.wallL + CO - 0.45);
    bollards.push([f.x + f.right.x * lat, f.y, f.z + f.right.z * lat]);
  }
  if (bollards.length) {
    const bg = mergeParts([cyl(0.2, 0.24, 0.6, 8, 0, 0.3, 0, 0x2d3036), cyl(0.3, 0.3, 0.12, 8, 0, 0.65, 0, 0x2d3036)]);
    const inst = new THREE.InstancedMesh(bg, ctx.M.structure, bollards.length);
    bollards.forEach(([x, y, z], i) => { place_m4(_m4, x, y, z, 0, 1, 1, 1); inst.setMatrixAt(i, _m4); ctx.prop('bollard', x, z, 0.3); });
    ctx.add(inst, { cast: true, name: 'Bollards' });
  }
  // a short pier into the bay with a harbour crane, near the harbour's north end
  const sp = lerp(s0, s1, 0.86), fp = track.frameAt(sp);
  const pierLen = 16, pierW = 6;
  const out = (d) => -(fp.wallL + CO + d);
  const px = (d, a = 0) => fp.x + fp.right.x * out(d) + fp.tangent.x * a, pz = (d, a = 0) => fp.z + fp.right.z * out(d) + fp.tangent.z * a;
  parts.push(paint(place(new THREE.BoxGeometry(pierW, 0.5, pierLen), px(pierLen / 2), fp.y - 0.2, pz(pierLen / 2), fp.yaw + Math.PI / 2), 0xa58f72));
  for (const d of [3, 8, 13]) for (const a of [-2.4, 2.4]) parts.push(cyl(0.22, 0.22, 4, 6, px(d, a), fp.y - 2.4, pz(d, a), 0x6b5440));
  {
    const cx = px(pierLen - 4), czz = pz(pierLen - 4), y0 = fp.y;
    const yellow = 0xf2b51d;
    parts.push(box(2.4, 1.2, 2.4, cx, y0 + 0.6, czz, 0x5b5f66, fp.yaw));
    for (let k = 0; k < 6; k++) parts.push(box(1.0, 1.6, 1.0, cx, y0 + 2.0 + k * 1.6, czz, k % 2 ? yellow : 0xe2a00f, fp.yaw));
    const jy = y0 + 11.6;
    parts.push(box(1.6, 1.6, 1.8, cx, jy, czz, 0x3a3d44, fp.yaw));                                   // cab
    // jib reaching out over the water (perpendicular to the road)
    const jx = fp.right.x * -1, jz = fp.right.z * -1;
    parts.push(paint(place(new THREE.BoxGeometry(0.6, 0.6, 14), cx + jx * 6, jy + 0.9, czz + jz * 6, Math.atan2(jx, jz)), yellow));
    parts.push(paint(place(new THREE.BoxGeometry(0.6, 0.6, 4), cx - jx * 2.5, jy + 0.9, czz - jz * 2.5, Math.atan2(jx, jz)), yellow));
    parts.push(box(1.2, 1.2, 1.2, cx - jx * 4.5, jy + 0.6, czz - jz * 4.5, 0x8a8f96));              // counterweight
    parts.push(cyl(0.04, 0.04, 7, 4, cx + jx * 12, jy - 2.6, czz + jz * 12, 0x222222));
    parts.push(box(0.5, 0.5, 0.5, cx + jx * 12, jy - 6.3, czz + jz * 12, 0xe2312a));
    ctx.landmarks.push({ name: 'crane', x: cx, z: czz, r: 2, h: jy + 2 });
    ctx.prop('crane', cx, czz, 1.7);
  }
  // the slipway beside the kicker: a concrete ramp from the quay into the water
  const ramp = track.ramps[0];
  if (ramp) {
    const s = ramp.s1 + 6, f = track.frameAt(s);
    const len = 9, w = 5;
    const a = -(f.wallL + CO), x0 = f.x + f.right.x * (a - len / 2 * 0.98), z0 = f.z + f.right.z * (a - len / 2 * 0.98);
    const slip = new THREE.BoxGeometry(w, 0.4, len);
    place(slip, x0, f.y - 1.2, z0, f.yaw + Math.PI / 2, 0.26);
    parts.push(paint(slip, 0xbdb8ad));
    ctx.exclusions.push([x0, z0, 6]);
  }
  // moored fishing boats alongside the quay (bobbing)
  const boatG = mergeParts([
    paint(new THREE.BoxGeometry(2.2, 1.0, 6.5, 1, 1, 2), 0xffffff),
    box(1.6, 1.3, 1.8, 0, 1.1, -0.8, 0xf4f1e8),
    box(1.7, 0.18, 2.0, 0, 1.85, -0.8, 0x2b6fd8),
    cyl(0.06, 0.06, 4.5, 5, 0, 2.6, 0.9, 0x6b5440),
  ]);
  {
    const p = boatG.attributes.position;
    for (let i = 0; i < p.count; i++) { const z = p.getZ(i), y = p.getY(i); if (z > 2.4 && y < 0.8) p.setX(i, p.getX(i) * 0.35); if (y < 0) p.setX(i, p.getX(i) * 0.7); }
    boatG.computeVertexNormals();
  }
  const moor = [];
  for (const k of [0.1, 0.26, 0.42]) {
    const s = lerp(s0, s1, k), f = track.frameAt(s), lat = -(f.wallL + CO + 2.4);
    moor.push({ x: f.x + f.right.x * lat, z: f.z + f.right.z * lat, yaw: f.yaw + (k > 0.3 ? Math.PI : 0) });
  }
  if (moor.length) {
    const inst = new THREE.InstancedMesh(boatG, ctx.M.structure, moor.length);
    inst.frustumCulled = false;
    const hulls = [0xe2312a, 0x2b6fd8, 0x2fa65a, 0xf2b51d];
    moor.forEach((b, i) => inst.setColorAt(i, _col.set(hulls[i % hulls.length])));
    ctx.add(inst, { cast: true, name: 'FishingBoats' });
    const placeBoats = (time) => {
      moor.forEach((b, i) => { compose(_m4, b.x, WATER_LEVEL + 0.15 + Math.sin(time * 1.4 + i * 1.7) * 0.07, b.z, b.yaw, Math.sin(time * 0.9 + i) * 0.03, Math.sin(time * 1.1 + i * 2) * 0.05, 1, 1, 1); inst.setMatrixAt(i, _m4); });
      inst.instanceMatrix.needsUpdate = true;
    };
    placeBoats(0);
    ctx.animators.push((dt, time) => placeBoats(time));
    ctx.stats.instances.fishingBoats = moor.length;
  }
  // fishermen's cottages + a fish-market shed on the town side of Ramp Run
  const houseCols = [0xf6efe2, 0xfff0c4, 0xd6ecf5, 0xf7d9d0, 0xe2f0d6];
  const roofCols = [0x2f6fd0, 0xe2312a, 0x3a9a5a, 0xe8902a];
  let placed = 0;
  for (let k = 0; k < 14 && placed < (Q.veg >= 1 ? 7 : 4); k++) {
    const s = lerp(s0 + 6, s1 - 10, rng()), f = track.frameAt(s);
    const w = 5 + rng() * 2.5, d = 4.5 + rng() * 2, h = 3 + rng() * 1.6;
    const lat = f.wallR + 6 + d / 2 + rng() * 10;
    const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
    if (field.wallClearance(x, z) < Math.hypot(w, d) / 2 + 2) continue;
    if (ctx.exclusions.some(([ex, ez, er]) => Math.hypot(x - ex, z - ez) < er + Math.hypot(w, d) / 2)) continue;
    const gy = field.surfaceHeight(x, z) - 0.3;
    const yaw = f.yaw + (rng() < 0.5 ? 0 : Math.PI);
    const col = houseCols[placed % houseCols.length], roof = roofCols[placed % roofCols.length];
    parts.push(paint(place(new THREE.BoxGeometry(w, h, d), x, gy + h / 2, z, yaw), col));
    for (const rg of gableRoof(w, d, 1.6, 0.35, roof, col)) parts.push(place(rg, x, gy + h, z, yaw));
    parts.push(paint(place(new THREE.BoxGeometry(0.9, 1.7, 0.08), x + Math.sin(yaw) * (d / 2 + 0.02), gy + 0.85, z + Math.cos(yaw) * (d / 2 + 0.02), yaw), 0x6b4a2a));
    for (const sx of [-1, 1]) parts.push(paint(place(new THREE.BoxGeometry(0.8, 0.8, 0.08), x + Math.sin(yaw) * (d / 2 + 0.02) + Math.cos(yaw) * sx * w * 0.3, gy + h * 0.6, z + Math.cos(yaw) * (d / 2 + 0.02) - Math.sin(yaw) * sx * w * 0.3, yaw), 0x7cc4e8));
    ctx.exclusions.push([x, z, Math.hypot(w, d) / 2 + 2]);
    ctx.prop('cottage', x, z, Math.hypot(w, d) / 2);
    placed++;
  }
}

// Reed clumps along the lagoon shore and a few egrets wading in the shallows.
function buildLagoon(ctx, field, rng, poly) {
  const { Q } = ctx;
  if (!poly || !poly.length) return;
  const bx0 = Math.min(...poly.map((p) => p[0])) - 6, bx1 = Math.max(...poly.map((p) => p[0])) + 6;
  const bz0 = Math.min(...poly.map((p) => p[1])) - 6, bz1 = Math.max(...poly.map((p) => p[1])) + 6;
  const reedG = mergeParts([
    paint(new THREE.ConeGeometry(0.06, 2.0, 3).translate(0, 1.0, 0), 0x6f8f3a),
    paint(new THREE.ConeGeometry(0.06, 1.7, 3).translate(0.25, 0.85, 0.1).rotateZ(-0.12), 0x7ea142),
    paint(new THREE.ConeGeometry(0.06, 1.8, 3).translate(-0.2, 0.9, -0.1).rotateZ(0.1), 0x5f7f33),
    paint(new THREE.ConeGeometry(0.08, 0.4, 3).rotateX(Math.PI).translate(0.02, 2.05, 0), 0x7a5232),
  ]);
  const want = Math.round(110 * Q.veg);
  const spots = [];
  for (let k = 0; k < want * 30 && spots.length < want; k++) {
    const x = lerp(bx0, bx1, rng()), z = lerp(bz0, bz1, rng());
    const gy = field.surfaceHeight(x, z);
    if (gy < WATER_LEVEL - 0.7 || gy > WATER_LEVEL + 0.9) continue;            // the shallow fringe only
    if (field.wallClearance(x, z) < 1.5) continue;
    spots.push([x, gy - 0.1, z, rng() * 6.28, lerp(0.8, 1.3, rng()), field.wallClearance(x, z), 0.4]);
  }
  addInstancedSet(ctx, 'Reeds', reedG, spots, rng, { near: 0, tint: [0.8, 1.15] });
  // egrets: white, long-legged, standing in the shallows
  const egretG = mergeParts([
    paint(new THREE.SphereGeometry(0.32, 8, 6).scale(0.8, 0.75, 1.5).translate(0, 1.05, 0), 0xffffff),
    paint(new THREE.CylinderGeometry(0.05, 0.07, 0.65, 5).rotateX(-0.5).translate(0, 1.45, 0.38), 0xffffff),
    paint(new THREE.SphereGeometry(0.12, 6, 4).translate(0, 1.75, 0.55), 0xffffff),
    paint(new THREE.ConeGeometry(0.035, 0.35, 4).rotateX(Math.PI / 2).translate(0, 1.73, 0.8), 0xf2b51d),
    paint(new THREE.CylinderGeometry(0.018, 0.018, 0.85, 3).translate(0.08, 0.42, 0), 0x222222),
    paint(new THREE.CylinderGeometry(0.018, 0.018, 0.85, 3).translate(-0.08, 0.42, 0), 0x222222),
  ]);
  const eg = [];
  for (let k = 0; k < 400 && eg.length < (Q.veg >= 1 ? 9 : 5); k++) {
    const x = lerp(bx0 + 6, bx1 - 6, rng()), z = lerp(bz0 + 6, bz1 - 6, rng()), gy = field.surfaceHeight(x, z);
    if (gy > WATER_LEVEL - 0.1 || gy < WATER_LEVEL - 0.5) continue;
    if (eg.some((e) => Math.hypot(e[0] - x, e[2] - z) < 5)) continue;
    eg.push([x, WATER_LEVEL - 0.35, z, rng() * 6.28, lerp(0.9, 1.15, rng()), 99, 0.4]);
  }
  if (eg.length) {
    const inst = new THREE.InstancedMesh(egretG, ctx.M.structure, eg.length);
    const placeE = (time) => {
      eg.forEach(([x, y, z, yaw, sc], i) => { compose(_m4, x, y, z, yaw + Math.sin(time * 0.3 + i) * 0.4, Math.max(0, Math.sin(time * 0.7 + i * 2.1)) * 0.35, 0, sc, sc, sc); inst.setMatrixAt(i, _m4); });
      inst.instanceMatrix.needsUpdate = true;
    };
    placeE(0);
    ctx.add(inst, { name: 'Egrets' });
    ctx.animators.push((dt, time) => placeE(time));
    ctx.stats.instances.egrets = eg.length;
  }
}

// Gulls circling over the cliffs and the Gull Gap (wings flap in the vertex shader).
function buildGulls(ctx, geo) {
  const { track, Q } = ctx;
  const cl = zone(track, 'cliff');
  if (!cl) return;
  const n = Q.veg >= 1 ? 22 : 10;
  // a gull: slim body + bent "M" wings (shoulder up, wrist, dark tip), white with grey tips
  const pos = [], col = [];
  const tri = (a, b, c, ca = 1, cb = 1, cc = 1) => { pos.push(...a, ...b, ...c); col.push(ca, ca, ca * 1.02, cb, cb, cb * 1.02, cc, cc, cc * 1.02); };
  tri([0, 0.02, 0.55], [0, 0.07, -0.45], [0, -0.07, -0.1]);                   // body (vertical sliver)
  tri([0, 0, 0.55], [0.09, 0, -0.1], [-0.09, 0, -0.1]);                      // head / chest
  tri([0, 0, -0.1], [0.12, 0, -0.5], [-0.12, 0, -0.5], 0.92, 0.92, 0.92);    // tail
  for (const sx of [-1, 1]) {
    const f0 = [0, 0, 0.18], b0 = [0, 0, -0.14], f1 = [0.55 * sx, 0.2, 0.1], b1 = [0.55 * sx, 0.2, -0.16], t = [1.25 * sx, -0.02, -0.24];
    tri(f0, f1, b0); tri(b0, f1, b1); tri(f1, t, b1, 1, 0.38, 0.85);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = ctx.timeUniform;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      float gph = dot(instanceMatrix[3].xz, vec2(0.13, 0.29));
      float span = abs(position.x);
      transformed.y += sin(uTime * 7.0 + gph) * span * 0.55;`);
  };
  mat.customProgramCacheKey = () => 'breezy-gull';
  const inst = new THREE.InstancedMesh(g, mat, n);
  inst.frustumCulled = false;
  const rng = makeRng(919);
  const len = track.forwardDistance(cl.s0, cl.s1);
  const birds = Array.from({ length: n }, (_, i) => {
    const s = cl.s0 + len * rng(), f = track.frameAt(s);
    const lat = -(f.wallL + 6 + rng() * 26);
    return { cx: f.x + f.right.x * lat, cz: f.z + f.right.z * lat, y: f.y + 9 + rng() * 14, r: 6 + rng() * 14, w: (0.25 + rng() * 0.3) * (rng() < 0.5 ? -1 : 1), a: rng() * 6.28, sc: 1.1 + rng() * 0.5 };
  });
  const placeB = (dt) => {
    birds.forEach((b, i) => {
      b.a += b.w * dt;
      const x = b.cx + Math.cos(b.a) * b.r, z = b.cz + Math.sin(b.a) * b.r;
      const yaw = Math.atan2(-Math.sin(b.a) * Math.sign(b.w), Math.cos(b.a) * Math.sign(b.w));
      compose(_m4, x, b.y + Math.sin(b.a * 3) * 0.6, z, yaw, 0, -0.35 * Math.sign(b.w), b.sc, b.sc, b.sc);
      inst.setMatrixAt(i, _m4);
    });
    inst.instanceMatrix.needsUpdate = true;
  };
  placeB(0);
  ctx.add(inst, { name: 'Gulls' });
  ctx.animators.push((dt) => placeB(dt));
  ctx.stats.instances.gulls = n;
}

// Boardwalk along the beach side of the promenade + home straight, a beach
// kiosk, and the pier with the Ferris wheel out at sea.
function buildPromenade(ctx, field, parts, plankParts, rng) {
  const { track, Q } = ctx;
  const pr = zone(track, 'promenade');
  if (!pr) return;
  const L = track.length;
  const b0 = pr.s0 + 2, b1 = L - 50;                  // stops before the grandstand
  plankParts.push(trackStrip(track, sRange(b0, b1, 2), 2, (f, s, c, o) => {
    o.lat = c ? -(f.wallL + 0.5) : -(f.wallL + 4.2); o.dy = 0.12; o.u = (o.lat) / 6; o.v = s / 3;
  }));
  // boardwalk edge beam + posts
  parts.push(paint(trackStrip(track, sRange(b0, b1, 2), 2, (f, s, c, o) => { o.lat = -(f.wallL + 4.2); o.dy = c ? 0.12 : -0.45; }), 0x8a6a46));
  for (let s = b0 + 2; s < b1; s += 6) {
    const f = track.frameAt(s), lat = -(f.wallL + 4.0), x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
    parts.push(box(0.16, 1.0, 0.16, x, f.y + 0.6, z, 0x8a6a46, f.yaw));
    if (Math.round(s / 6) % 3 === 0) {                 // lamp posts
      parts.push(cyl(0.07, 0.09, 3.6, 6, x, f.y + 1.9, z, 0x2f4a3a));
      parts.push(ball(0.24, x, f.y + 3.8, z, 0xfff1b8));
    }
  }
  // a beach kiosk (striped awning) on the sand
  {
    const s = pr.s0 + 8, f = track.frameAt(s), lat = -(f.wallL + 9.5);
    const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat, gy = field.surfaceHeight(x, z) - 0.2;
    const yaw = f.yaw - Math.PI / 2;                  // counter toward the boardwalk
    parts.push(paint(place(new THREE.BoxGeometry(4.2, 2.6, 3.2), x, gy + 1.3, z, yaw), 0xfff6e6));
    parts.push(paint(place(new THREE.BoxGeometry(4.4, 0.25, 3.4), x, gy + 2.7, z, yaw), 0x2fa7d8));
    for (let k = 0; k < 6; k++) {
      const a = -1.75 + k * 0.7;
      const ax = x + Math.cos(yaw) * a + Math.sin(yaw) * 2.1, az = z - Math.sin(yaw) * a + Math.cos(yaw) * 2.1;
      parts.push(paint(place(new THREE.BoxGeometry(0.7, 0.1, 1.4), ax, gy + 2.45, az, yaw, -0.45), k % 2 ? 0xffffff : 0xff4f6a));
    }
    parts.push(paint(place(new THREE.BoxGeometry(0.5, 0.5, 0.5), x, gy + 3.1, z, yaw), 0xffd23a));
    ctx.prop('kiosk', x, z, 2.7);
    ctx.exclusions.push([x, z, 4.5]);
  }
  // the beach-ball launcher hut (left) and the catch net (right) of the promenade balls
  for (const h of (track.def.hazards || []).filter((d) => d.type === 'ball')) {
    const s = track.sOfKey(h), f = track.frameAt(s);
    const from = h.from || -1;
    const launch = from * (h.travel / 2 + 3.2), catchLat = -from * (h.travel / 2 + 3.4);
    // launcher: a striped hut with a round mouth toward the road, balls piled on the roof
    {
      const lx = f.x + f.right.x * launch, lz = f.z + f.right.z * launch, gy = field.surfaceHeight(lx, lz) - 0.15;
      const yaw = Math.atan2(-f.right.x * from, -f.right.z * from);   // faces the road
      for (let k = 0; k < 4; k++) parts.push(paint(place(new THREE.BoxGeometry(4.6, 0.8, 3.4), lx, gy + 0.4 + k * 0.8, lz, yaw), k % 2 ? 0xffffff : 0x2fa7d8));
      parts.push(paint(place(new THREE.TorusGeometry(1.15, 0.22, 6, 16), lx + Math.sin(yaw) * 1.75, gy + 1.35, lz + Math.cos(yaw) * 1.75, yaw), 0xffd23a));
      parts.push(paint(place(new THREE.CircleGeometry(1.1, 16), lx + Math.sin(yaw) * 1.72, gy + 1.35, lz + Math.cos(yaw) * 1.72, yaw), 0x1b2433));
      parts.push(paint(place(new THREE.ConeGeometry(3.6, 1.6, 4, 1).rotateY(Math.PI / 4), lx, gy + 4.0, lz, yaw), 0xff4f6a));      // roof
      parts.push(cyl(0.05, 0.05, 2.2, 4, lx, gy + 5.6, lz, 0xeeeeee));
      parts.push(paint(place(new THREE.BoxGeometry(0.04, 0.6, 1.0), lx, gy + 6.3, lz + 0.5, yaw + Math.PI / 2), 0xffd23a));    // pennant
      for (const [ox, oz, r, c] of [[-1.6, 1.2, 0.55, 0xff4b4b], [1.6, 1.2, 0.5, 0xffd23a], [-1.6, -1.2, 0.5, 0x4fd16a], [1.6, -1.2, 0.55, 0x3fa7ff]]) {
        parts.push(ball(r, lx + Math.cos(yaw) * ox + Math.sin(yaw) * oz, gy + r, lz - Math.sin(yaw) * ox + Math.cos(yaw) * oz, c, 1, 1, 1, 2));   // spare balls round the hut
      }
      ctx.prop('ballLauncher', lx, lz, 2.9);
      ctx.exclusions.push([lx, lz, 5]);
    }
    // catch net: two posts and a net between them, a bin below
    {
      const cx = f.x + f.right.x * catchLat, cz = f.z + f.right.z * catchLat, gy = field.surfaceHeight(cx, cz) - 0.1;
      for (const a of [-3, 3]) parts.push(cyl(0.12, 0.14, 4.4, 6, cx + f.tangent.x * a, gy + 2.2, cz + f.tangent.z * a, 0xe9e4da));
      parts.push(paint(place(new THREE.BoxGeometry(5.2, 1.1, 2.6), cx - f.right.x * from * 1.2, gy + 0.55, cz - f.right.z * from * 1.2, f.yaw), 0xff7a2e));
      const netG = new THREE.PlaneGeometry(6, 3.6);
      place(netG, cx, gy + 2.4, cz, f.yaw + Math.PI / 2);
      const netTex = ctx.tex(BT.createNetTexture());
      netTex.repeat.set(4, 2.4);
      const net = ctx.add(new THREE.Mesh(netG, new THREE.MeshLambertMaterial({ map: netTex, alphaTest: 0.5, side: THREE.DoubleSide })), { name: 'CatchNet' });
      net.frustumCulled = true;
      ctx.prop('catchNet', cx, cz, 0.3);
      ctx.exclusions.push([cx, cz, 4.5]);
    }
  }
  // the pier with a Ferris wheel, out in the sea east of the beach
  const s = L - 30, f = track.frameAt(s);
  const sea = (d) => [f.x + f.right.x * -(f.wallL + d), f.z + f.right.z * -(f.wallL + d)];
  const [p0x, p0z] = sea(36), [p1x, p1z] = sea(130);
  const pl = Math.hypot(p1x - p0x, p1z - p0z), pyaw = Math.atan2(p1x - p0x, p1z - p0z);
  const deckY = WATER_LEVEL + 3.2;
  parts.push(paint(place(new THREE.BoxGeometry(5, 0.45, pl), (p0x + p1x) / 2, deckY, (p0z + p1z) / 2, pyaw), 0xa98a63));
  for (let d = 4; d < pl; d += 8) for (const a of [-2.1, 2.1]) {
    const x = p0x + Math.sin(pyaw) * d + Math.cos(pyaw) * a, z = p0z + Math.cos(pyaw) * d - Math.sin(pyaw) * a;
    parts.push(cyl(0.2, 0.2, 7, 5, x, deckY - 3.4, z, 0x6b5440));
  }
  const wx = p1x - Math.sin(pyaw) * 10, wz = p1z - Math.cos(pyaw) * 10;
  const RW = 15, hubY = deckY + RW + 2.5;
  // the wheel faces the beach: its axle runs along the pier (dx, dz); its plane spans (px, pz) and up
  const dx = Math.sin(pyaw), dz = Math.cos(pyaw), qx = Math.cos(pyaw), qz = -Math.sin(pyaw);
  const up = new THREE.Vector3(0, 1, 0), look = new THREE.Matrix4(), A = new THREE.Vector3(), B = new THREE.Vector3();
  const beam = (a, b, w, color) => {
    const len = a.distanceTo(b), g = new THREE.BoxGeometry(w, w, len);
    g.applyMatrix4(look.lookAt(a, b, up)).translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    parts.push(paint(g, color));
  };
  for (const sd of [-2.2, 2.2]) for (const lean of [-1, 1]) {
    A.set(wx + qx * lean * 8 + dx * sd, deckY, wz + qz * lean * 8 + dz * sd);
    B.set(wx + dx * sd, hubY, wz + dz * sd);
    beam(A, B, 0.55, 0xe9e4da);
  }
  // the wheel (rim + spokes) rotates about the axle; the gondolas stay level
  const wheelParts = [];
  const SEG = Q.veg >= 1 ? 28 : 18;
  for (const sd of [-1.2, 1.2]) {
    wheelParts.push(paint(new THREE.TorusGeometry(RW, 0.22, 5, SEG).translate(0, 0, sd), 0xffffff));
    for (let k = 0; k < 12; k++) wheelParts.push(paint(new THREE.BoxGeometry(0.12, RW, 0.12).translate(0, RW / 2, sd).rotateZ((k / 12) * Math.PI * 2), 0xff4f6a));
  }
  wheelParts.push(paint(new THREE.CylinderGeometry(0.7, 0.7, 3.2, 10).rotateX(Math.PI / 2), 0xffd23a));
  const wheel = ctx.add(new THREE.Mesh(mergeParts(wheelParts), ctx.M.structure), { name: 'FerrisWheel' });
  wheel.position.set(wx, hubY, wz);
  wheel.rotation.order = 'YXZ';
  wheel.rotation.y = pyaw;                              // local z (the axle) → along the pier
  const NG = 12;
  const gondG = mergeParts([box(1.6, 1.4, 1.6, 0, -1.1, 0, 0xffffff), box(1.8, 0.2, 1.8, 0, -0.35, 0, 0xff4f6a), cyl(0.05, 0.05, 0.5, 4, 0, -0.1, 0, 0x555555)]);
  const gond = new THREE.InstancedMesh(gondG, ctx.M.structure, NG);
  gond.frustumCulled = false;
  const gc = [0x3fa7ff, 0xffd23a, 0x4fd16a, 0xff8c2e, 0xb06bff, 0xff6fb5];
  for (let i = 0; i < NG; i++) gond.setColorAt(i, _col.set(gc[i % gc.length]));
  ctx.add(gond, { name: 'Gondolas' });
  const placeWheel = (time) => {
    const rot = time * 0.12;
    wheel.rotation.z = rot;
    for (let i = 0; i < NG; i++) {
      const a = rot + (i / NG) * Math.PI * 2 + Math.PI / 2;
      // local x of the wheel = (qx, 0, qz) after the yaw turn; a spoke tip at angle a
      const u = Math.cos(a) * RW, v = Math.sin(a) * RW;
      place_m4(_m4, wx + qx * u, hubY + v, wz + qz * u, pyaw, 1, 1, 1);
      gond.setMatrixAt(i, _m4);
    }
    gond.instanceMatrix.needsUpdate = true;
  };
  placeWheel(0);
  ctx.animators.push((dt, time) => placeWheel(time));
  ctx.landmarks.push({ name: 'ferris', x: wx, z: wz, r: RW, h: hubY + RW });
}
