// Laguna Beach set-piece views (browser only; SPEC §16.1). Draws the course
// hazards of hazards/beach.js at hz.time / their pure state functions, so what
// the player sees is exactly what the game, the sim and the CPUs test:
//
//   jet   tide-pool blowholes: dark vents in the rock shelf; foam churns up
//         while they bubble (the telegraph, + a hiss), then a white spout
//         column with a spray crown erupts (+ a whoosh).
//   surge shore-break waves: an offshore lip swells and curls in while the foam
//         line runs up the sand (+ a rising surf roar), the water sheet washes
//         over the beach road to the waterline of the hit model, holds and
//         drains back. The sheet edge IS the hit model's waterline on the road.
//   lob   volleyball spikes: beach players at the courts, the server jumps and
//         spikes (+ a smack), the ball arcs onto the road; the landing ring
//         shrinks during the flight and turns red for the danger window; the
//         ball bounces, rolls inland and hops away over the wall.
//
// Each piece is one or two draw calls (instanced / one dynamic mesh). Sounds
// go out as bus 'item:sfx' events (main.js plays registered sounds by name,
// positional, race screen only).
//
//   buildBeachSetPieces(ctx, field, { hz, level, wallStyle }) → { stats }

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './utils.js';
import { bus } from './bus.js';
import { registerSound, SYNTH } from './audio.js';
import { paint, mergeParts, place_m4, box, ball } from './world.js';
import { jetState, surgePhase, surgeReach, surgeTide, surgeEdge, lobState, BEACH_TUNE } from './hazards/beach.js';
import { createSurfTexture, createRingTexture } from './world-laguna-textures.js';

// ------------------------------------------------------------------ sounds (synthesized, original)

let soundsReady = false;
function registerBeachSounds() {
  if (soundsReady) return;
  soundsReady = true;
  const { opt, hiss, blip } = SYNTH;
  // blowhole bubbling: a gurgling hiss that rises (0.7 s telegraph)
  registerSound('beachBubble', (ac, out, o) => {
    const { t, p } = opt(ac, o);
    hiss(ac, out, t, { type: 'bandpass', f0: 500 * p, f1: 1600 * p, sweep: 0.7, Q: 2.5, dur: 0.75, attack: 0.5, peak: 0.16 });
    for (let k = 0; k < 6; k++) blip(ac, out, t + 0.08 + k * 0.1, { type: 'sine', f0: (220 + k * 40) * p, f1: (420 + k * 50) * p, glide: 0.05, dur: 0.06, peak: 0.07 });
    return 0.8;
  }, 0.9);
  // blowhole spout: a sea-spray whoosh
  registerSound('beachSpout', (ac, out, o) => {
    const { t, p } = opt(ac, o);
    hiss(ac, out, t, { type: 'highpass', f0: 1200 * p, f1: 3400 * p, sweep: 0.2, Q: 0.7, dur: 0.9, attack: 0.02, peak: 0.24 });
    hiss(ac, out, t, { type: 'lowpass', f0: 420, Q: 0.8, dur: 0.35, peak: 0.2 });
    return 0.95;
  });
  // shore-break build: the surf roar swells for ~1.6 s
  registerSound('beachSurf', (ac, out, o) => {
    const { t, p } = opt(ac, o);
    hiss(ac, out, t, { type: 'lowpass', f0: 300 * p, f1: 1400 * p, sweep: 1.5, Q: 0.6, dur: 1.9, attack: 1.4, peak: 0.26 });
    hiss(ac, out, t + 0.6, { type: 'bandpass', f0: 2200 * p, Q: 0.7, dur: 1.2, attack: 0.9, peak: 0.08 });
    return 2.0;
  });
  // the wave crashes over the road
  registerSound('beachWash', (ac, out, o) => {
    const { t, p } = opt(ac, o);
    hiss(ac, out, t, { type: 'bandpass', f0: 1800 * p, f1: 600 * p, sweep: 0.9, Q: 0.5, dur: 1.2, attack: 0.03, peak: 0.3 });
    blip(ac, out, t, { type: 'sine', f0: 90 * p, f1: 45 * p, dur: 0.3, peak: 0.25 });
    return 1.2;
  });
  // volleyball spike: hand smack + a short whistle of the flight
  registerSound('beachSpike', (ac, out, o) => {
    const { t, p } = opt(ac, o);
    hiss(ac, out, t, { type: 'bandpass', f0: 1500 * p, Q: 1.2, dur: 0.06, peak: 0.34 });
    blip(ac, out, t, { type: 'triangle', f0: 520 * p, f1: 260 * p, dur: 0.07, peak: 0.16 });
    blip(ac, out, t + 0.05, { type: 'sine', f0: 1400 * p, f1: 900 * p, glide: 0.9, dur: 0.9, peak: 0.03 });
    return 0.95;
  });
  // the ball hits the road
  registerSound('beachBounce', (ac, out, o) => {
    const { t, p } = opt(ac, o);
    blip(ac, out, t, { type: 'sine', f0: 210 * p, f1: 90 * p, dur: 0.12, peak: 0.3 });
    hiss(ac, out, t, { type: 'lowpass', f0: 900, Q: 0.8, dur: 0.06, peak: 0.16 });
    return 0.15;
  });
}

function sfxAt(name, x, y, z, volume = 1) {
  bus.emit('item:sfx', { name, position: { x, y, z }, volume });
}

// ------------------------------------------------------------------ helpers

// A jagged flat disc (radius 1) in the XZ plane, facing up.
function jaggedDisc(seg = 18, amp = 0.22, seed = 1) {
  const pos = [0, 0, 0];
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    const r = 1 - amp * (0.5 + 0.5 * Math.sin(k * 2.7 + seed * 1.3) * Math.cos(k * 1.3 + seed));
    pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
  }
  const idx = [];
  for (let k = 1; k <= seg; k++) idx.push(0, k + 1, k);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ blowholes

function buildJets(ctx, list, field, U, emit) {
  const { track } = ctx;
  if (!list.length) return;
  const holes = [];
  for (const h of list) h.lats.forEach((lat, k) => holes.push({ h, k, p: track.pointAt(h.s, lat), f: track.frameAt(h.s) }));
  // vents + foam: one instanced jagged disc (2 per hole: the dark vent, the foam)
  const vents = new THREE.InstancedMesh(jaggedDisc(18, 0.25, 3), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, toneMapped: false }), holes.length * 2);
  vents.frustumCulled = false;
  const cDark = new THREE.Color(0x1d2a2e), cFoam = new THREE.Color(0xf4fbff);
  // the spout: a column of white spray puffs (PUFFS per hole, instanced) over a splash ring
  const PUFFS = 13, RING = 5;           // RING base puffs mark the spout's footprint, the rest stack up
  const puffG = mergeParts([
    paint(new THREE.IcosahedronGeometry(0.62, 1), 0xffffff),
    paint(new THREE.IcosahedronGeometry(0.42, 0).translate(0.5, 0.18, 0.2), 0xe6f8ff),
    paint(new THREE.IcosahedronGeometry(0.38, 0).translate(-0.45, -0.1, -0.3), 0xf2fbff),
    paint(new THREE.IcosahedronGeometry(0.34, 0).translate(0.1, 0.3, -0.5), 0xdaf3fb),
  ]);
  const spouts = new THREE.InstancedMesh(puffG, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x8fb4c0, transparent: true, opacity: 0.93, depthWrite: false }), holes.length * PUFFS);
  spouts.frustumCulled = false;
  ctx.add(vents, { name: 'BlowholeVents' });
  ctx.add(spouts, { name: 'BlowholeSpouts' });
  const m4 = new THREE.Matrix4(), st = {};
  const J = BEACH_TUNE.jet;
  const prev = holes.map(() => 'idle');
  U.push((t, dt, live) => {
    holes.forEach((o, i) => {
      jetState(o.h, t, o.k, st);
      const R = o.h.radius;
      const y = o.f.y + 0.02;
      place_m4(m4, o.p.x, y, o.p.z, o.k * 1.7, R * 0.62, 1, R * 0.62);
      vents.setMatrixAt(i * 2, m4);
      vents.setColorAt(i * 2, cDark);
      // foam: churns up while bubbling, wide while spouting
      const churn = st.bubbling ? 0.55 + 0.45 * st.foam + 0.08 * Math.sin(t * 31 + i) : st.erupting ? 1.15 : 0.0001;
      place_m4(m4, o.p.x, y + 0.012, o.p.z, t * (st.bubbling ? 2.5 : 0.6) + i, R * churn, 1, R * churn);
      vents.setMatrixAt(i * 2 + 1, m4);
      vents.setColorAt(i * 2 + 1, cFoam);
      // spray: a puffy column while spouting, a low churn of bubbles while bubbling
      const H = st.erupting ? J.spout * st.amt : st.bubbling ? 0.5 * st.foam : 0;
      for (let k = 0; k < PUFFS; k++) {
        let sc = 0.0001, py = o.f.y, jx = 0, jz = 0;
        if (k < RING) {
          // the splash ring round the vent (its footprint ~ the hit circle)
          const ang = (k / RING) * Math.PI * 2 + i, rr = R * (st.erupting ? 0.95 : 0.6);
          if (st.erupting && H > 0.05) sc = R * 0.75 * (0.8 + 0.2 * Math.sin(t * 11 + k)) * Math.min(1, st.amt * 1.5);
          else if (st.bubbling) sc = R * 0.3 * st.foam * (0.7 + 0.3 * Math.abs(Math.sin(t * 14 + k * 2)));
          jx = Math.cos(ang) * rr; jz = Math.sin(ang) * rr; py = o.f.y + 0.25;
        } else if (st.erupting && H > 0.05) {
          const u = (k - RING) / (PUFFS - RING - 1);
          sc = R * lerp(1.35, 0.95, u) * (k === PUFFS - 1 ? 1.35 : 1) * (0.88 + 0.12 * Math.sin(t * 13 + k * 2.1 + i));
          py = o.f.y + 0.6 + H * Math.pow(u, 0.9);
          jx = Math.sin(t * 9 + k * 1.7 + i) * 0.35 * u; jz = Math.cos(t * 8 + k * 2.3) * 0.35 * u;
        }
        place_m4(m4, o.p.x + jx, py, o.p.z + jz, t * 2 + k, sc, sc, sc);
        spouts.setMatrixAt(i * PUFFS + k, m4);
      }
      const ph = st.erupting ? 'erupt' : st.bubbling ? 'bubble' : 'idle';
      if (live && ph !== prev[i]) {
        if (ph === 'bubble') emit('beachBubble', o.p.x, o.f.y + 0.5, o.p.z, 0.8);
        else if (ph === 'erupt') emit('beachSpout', o.p.x, o.f.y + 2, o.p.z, 1.0);
      }
      prev[i] = ph;
    });
    vents.instanceMatrix.needsUpdate = true;
    if (vents.instanceColor) vents.instanceColor.needsUpdate = true;
    spouts.instanceMatrix.needsUpdate = true;
  });
  ctx.stats.instances.blowholes = holes.length;
}

// ------------------------------------------------------------------ shore-break waves

function buildSurges(ctx, list, field, U, emit, { level, shoreLat }) {
  const { track } = ctx;
  if (!list.length) return;
  const surfTex = ctx.tex(createSurfTexture({ aniso: ctx.maxAniso }));
  const sheetMat = new THREE.MeshBasicMaterial({
    map: surfTex, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  });
  const lipMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.92, emissive: 0x1d4a55, side: THREE.DoubleSide });
  const ROWS = [0, 0.9, 3.2, 0.5, 1.0, 1.25];   // row kinds: edge, foam, water, (mid), shore, beyond (see below)
  const NR = ROWS.length;
  const cFoam = new THREE.Color(0xffffff), cFoam2 = new THREE.Color(0xf0fcff), cWater = new THREE.Color(0x6fdcdc), cMid = new THREE.Color(0x42bccf), cDeep = new THREE.Color(0x2f9fc0);
  for (const h of list) {
    const side = h.side;
    const s0 = h.s - 18, s1 = h.s + h.len + 18, step = 1.25;
    const cols = [];
    for (let s = s0; s <= s1 + 1e-6; s += step) cols.push(s);
    const NC = cols.length;
    const pos = new Float32Array(NC * NR * 3), col = new Float32Array(NC * NR * 4), uv = new Float32Array(NC * NR * 2);
    // per column: frame + a height profile across (0.5 m steps from -hw to shore + 40)
    const frames = cols.map((s) => {
      const f = track.frameAt(s);
      const fr = { x: f.x, y: f.y, z: f.z, rx: f.right.x, rz: f.right.z, wall: side > 0 ? f.wallR : f.wallL, hw: f.halfWidth, along: track.deltaS(h.s, s) };
      fr.shore = shoreLat(s);
      fr.lat0 = -f.halfWidth - 1; fr.lat1 = fr.shore + 45;
      fr.prof = [];
      for (let lat = fr.lat0; lat <= fr.lat1 + 0.5; lat += 0.5) {
        let y;
        if (lat <= fr.wall + 0.6) y = f.y;
        else { const x = f.x + f.right.x * lat * side, z = f.z + f.right.z * lat * side; y = Math.max(field.surfaceHeight(x, z), level); }
        fr.prof.push(y);
      }
      return fr;
    });
    // the sheet fades out over its first / last columns (no hard cut in the sea)
    const endFade = cols.map((_, ci) => smoothstep(ci / 9) * smoothstep((cols.length - 1 - ci) / 9));
    const heightAt = (fr, lat) => {
      const k = clamp((lat - fr.lat0) / 0.5, 0, fr.prof.length - 1.001), i = Math.floor(k), w = k - i;
      return lerp(fr.prof[i], fr.prof[i + 1], w);
    };
    const idx = [];
    for (let c = 0; c < NC - 1; c++) for (let r = 0; r < NR - 1; r++) {
      const a = c * NR + r, b = a + 1, d = a + NR, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    const nrm = new Float32Array(NC * NR * 3);
    for (let i = 0; i < NC * NR; i++) nrm[i * 3 + 1] = 1;                 // a flat sheet: lit from above
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    const sheet = new THREE.Mesh(geo, sheetMat);
    sheet.frustumCulled = false;
    sheet.renderOrder = 2;
    ctx.add(sheet, { name: 'WaveSheet' });

    // the offshore lip: a curling profile extruded along the band (local x = along, z = toward the sea, y up)
    const L = h.len + 18, prof = [[6.5, 0, 0x2f8fb8], [3.8, 0.45, 0x3aa2c6], [1.8, 1.0, 0x55c2d6], [0.6, 1.38, 0x9fe6ea], [-0.3, 1.5, 0xffffff], [-0.85, 1.25, 0xffffff], [-0.75, 0.85, 0xdff8ff], [-0.15, 0.6, 0x7fd8e2], [0.4, 0.2, 0x3aa2c6], [0.8, 0, 0x2f8fb8]];
    const NS = 12, lp = [], lc = [], li = [];
    const cc = new THREE.Color();
    for (let k = 0; k <= NS; k++) {
      const x = -L / 2 + (L * k) / NS, taper = 1 - Math.pow(Math.abs(x) / (L / 2), 4);
      for (const [z, y, c] of prof) { lp.push(x, y * taper, z * (0.6 + 0.4 * taper)); cc.set(c); lc.push(cc.r, cc.g, cc.b); }
    }
    const P = prof.length;
    for (let k = 0; k < NS; k++) for (let j = 0; j < P - 1; j++) { const a = k * P + j, b = a + 1, d = a + P, e = d + 1; li.push(a, b, d, b, e, d); }
    const lipG = new THREE.BufferGeometry();
    lipG.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    lipG.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
    lipG.setIndex(li);
    lipG.computeVertexNormals();
    const lip = new THREE.Mesh(lipG, lipMat);
    lip.frustumCulled = false;
    lip.matrixAutoUpdate = false;
    ctx.add(lip, { name: 'WaveLip' });
    const fm = track.frameAt(h.s + h.len / 2);
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(fm.tangent.x, 0, fm.tangent.z), new THREE.Vector3(0, 1, 0), new THREE.Vector3(fm.right.x * side, 0, fm.right.z * side));
    const shoreMid = shoreLat(h.s + h.len / 2);
    const hwRoad = h.hw;
    let prevPh = '';

    // the sheet's waterline (lat measured toward the sea, i.e. lat·side) per column
    const edgeAt = (fr, t, ph, reachNow) => {
      const shore = fr.shore;
      // lapping at the shore while calm
      let e = shore + 1.5 * Math.sin(t * 1.3 + fr.along * 0.05) - 1.0;
      const inBand = fr.along >= 0 && fr.along <= h.len;
      const out = inBand ? 0 : Math.min(fr.along < 0 ? -fr.along : fr.along - h.len, 18);
      const roadEdge = hwRoad;                                 // = surgeEdge at reach 0 (side-normalised)
      if (ph.phase === 'build') e = lerp(shore, roadEdge + 0.6, smoothstep(ph.k));
      else if (ph.phase === 'wash' || ph.phase === 'hold') e = side * surgeEdge(h, reachNow);
      else if (ph.phase === 'recede') e = reachNow > 0.001 ? side * surgeEdge(h, reachNow) : lerp(roadEdge, shore, smoothstep((ph.k - 0.75) / 0.25));
      else if (ph.phase === 'calm' && ph.k < 0.3) e = lerp(roadEdge + 0.5, e, smoothstep(ph.k / 0.3));
      // outside the band the water stays off the drivable corridor (beyond the wall), tapering back
      if (!inBand) e = Math.max(e, out < 3 ? lerp(e, fr.wall + 1.2, smoothstep(out / 2.5)) : lerp(fr.wall + 1.2, shore, smoothstep((out - 3) / 12)));
      // a lively, wavy front; it only ever errs toward MORE water than the hit
      // model (the kart radius already pads the hit test by 1.1 m)
      const wob = 0.32 * (1 + Math.sin(fr.along * 0.37 + t * 2.3)) + 0.18 * (1 + Math.sin(fr.along * 0.93 - t * 3.1));
      return Math.min(e - wob, shore + 3);
    };
    // spray puffs riding the water front (white water), one instanced draw
    const NP = Math.min(40, NC);
    const puffG = mergeParts([
      paint(new THREE.IcosahedronGeometry(0.55, 0).scale(1.3, 0.7, 1), 0xffffff),
      paint(new THREE.IcosahedronGeometry(0.38, 0).translate(0.6, 0.25, 0.3), 0xeefbff),
      paint(new THREE.IcosahedronGeometry(0.32, 0).translate(-0.55, 0.2, -0.2), 0xf6fdff),
    ]);
    const puffs = new THREE.InstancedMesh(puffG, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92, depthWrite: false }), NP);
    puffs.frustumCulled = false;
    ctx.add(puffs, { name: 'WaveSpray' });
    const pm4 = new THREE.Matrix4();
    U.push((t, dt, live) => {
      const ph = surgePhase(h, t), reach = surgeReach(h, t);
      const flow = ph.phase === 'build' ? -0.6 : ph.phase === 'wash' ? -1.6 : ph.phase === 'recede' ? 0.7 : 0.15;
      surfTex.offset.y = (surfTex.offset.y + flow * dt * 0.12) % 1;
      surfTex.offset.x = (surfTex.offset.x + dt * 0.01) % 1;
      let p = 0, q = 0, c4 = 0;
      for (let ci = 0; ci < NC; ci++) {
        const fr = frames[ci];
        const e = edgeAt(fr, t, ph, reach);
        const shore = Math.max(fr.shore, e + 4);
        const lats = [e, e + 1.5, e + 3.8, lerp(e + 3.8, shore, 0.5), shore, shore + 40];
        for (let r = 0; r < NR; r++) {
          const lat = Math.max(lats[r], r ? lats[r - 1] + 0.05 : -1e9);
          const y = heightAt(fr, lat) + (r < 3 ? 0.07 : 0.05);
          pos[p++] = fr.x + fr.rx * lat * side; pos[p++] = y; pos[p++] = fr.z + fr.rz * lat * side;
          uv[q++] = (cols[ci] - s0) / 6; uv[q++] = (lat - e) / 6;
          const cc2 = r === 0 ? cFoam : r === 1 ? cFoam2 : r === 2 ? cWater : r === 3 ? cMid : cDeep;
          const a = (r === 0 ? 1 : r === 1 ? 0.96 : r === 2 ? 0.88 : r === 3 ? 0.8 : r === 4 ? 0.35 : 0) * endFade[ci];
          col[c4++] = cc2.r; col[c4++] = cc2.g; col[c4++] = cc2.b; col[c4++] = a;
        }
      }
      // spray along the front: tall during the wash, churning while it holds, low otherwise
      const hSpray = ph.phase === 'wash' ? 1.8 : ph.phase === 'build' ? 1.5 * smoothstep(ph.k * 1.5) : ph.phase === 'hold' ? 0.75 : ph.phase === 'recede' ? 0.45 * (1 - ph.k) : 0.25;
      for (let k = 0; k < NP; k++) {
        const ci = Math.min(NC - 1, Math.round((k / Math.max(1, NP - 1)) * (NC - 1)));
        const base = ci * NR * 3;
        const bob = 0.5 + 0.5 * Math.sin(t * 7 + k * 1.9);
        const sc = hSpray * (0.55 + 0.6 * bob);
        place_m4(pm4, pos[base], pos[base + 1] + 0.05, pos[base + 2], k * 0.7 + t * 0.5, 0.6 + sc * 0.6, Math.max(0.05, sc), 0.6 + sc * 0.6);
        puffs.setMatrixAt(k, pm4);
      }
      puffs.instanceMatrix.needsUpdate = true;
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
      geo.attributes.uv.needsUpdate = true;
      // the lip: offshore swell (calm) → rises + rolls in (build) → breaks (wash) → gone
      let d, sc;
      if (ph.phase === 'build') { d = lerp(shoreMid + 26, shoreMid + 1, smoothstep(ph.k)); sc = lerp(0.45, 2.1, smoothstep(ph.k * 1.25)); }
      else if (ph.phase === 'wash') { d = lerp(shoreMid + 1, shoreMid - 6, ph.k); sc = lerp(2.1, 0.15, ph.k); }
      else if (ph.phase === 'calm') { d = lerp(shoreMid + 46, shoreMid + 26, ph.k); sc = lerp(0.05, 0.45, smoothstep(ph.k)); }
      else { d = shoreMid + 46; sc = 0.001; }
      const y = level - 0.25;
      m4lip.copy(basis).scale(_s3.set(1, sc, 1));
      m4lip.setPosition(fm.x + fm.right.x * side * d, y, fm.z + fm.right.z * side * d);
      lip.matrix.copy(m4lip);
      lip.matrixWorldNeedsUpdate = true;
      lip.visible = sc > 0.02;
      if (live && ph.phase !== prevPh) {
        const sx = fm.x + fm.right.x * side * (hwRoad + 6), sz = fm.z + fm.right.z * side * (hwRoad + 6);
        if (ph.phase === 'build') emit('beachSurf', sx, fm.y + 1, sz, 1.1);
        else if (ph.phase === 'wash') emit('beachWash', sx, fm.y + 1, sz, 1.0);
      }
      prevPh = ph.phase;
    });
    ctx.stats.instances.waves = (ctx.stats.instances.waves || 0) + 1;
    ctx.stats.waveTide = [surgeTide(h, 0), surgeTide(h, 999)];
  }
}
const m4lip = new THREE.Matrix4(), _s3 = new THREE.Vector3();

// ------------------------------------------------------------------ volleyball spikes

function playerGeometry() {
  const skin = 0xc98f62, shirt = 0x2f8fc8, shorts = 0xf2f2ea;
  return mergeParts([
    box(0.22, 0.85, 0.24, -0.15, 0.43, 0, skin), box(0.22, 0.85, 0.24, 0.15, 0.43, 0, skin),     // legs
    box(0.56, 0.32, 0.32, 0, 0.98, 0, shorts),                                                   // shorts
    box(0.6, 0.62, 0.34, 0, 1.44, 0, shirt),                                                     // tank top
    box(0.16, 0.72, 0.16, -0.38, 1.98, 0.02, skin, 0, 0, 0.18), box(0.16, 0.72, 0.16, 0.38, 1.98, 0.02, skin, 0, 0, -0.18),   // arms up
    ball(0.2, 0, 1.97, 0, skin), box(0.34, 0.1, 0.36, 0, 2.12, -0.02, 0x3a2a1e),                 // head + hair
  ]);
}
function volleyballGeometry(r) {
  const g = new THREE.SphereGeometry(r, 14, 10).toNonIndexed();
  const p = g.attributes.position, colors = new Float32Array(p.count * 3), c = new THREE.Color();
  for (let i = 0; i < p.count; i += 3) {
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3, x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
    const band = Math.floor((Math.atan2(y, x) / Math.PI + 1) * 3) % 3;
    c.set(band === 0 ? 0xffd23a : band === 1 ? 0xffffff : 0x2f6fd8);
    for (let k = 0; k < 3; k++) c.toArray(colors, (i + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

function buildLobs(ctx, list, field, U, emit) {
  const { track } = ctx;
  if (!list.length) return;
  const L = BEACH_TUNE.lob;
  const ringTex = ctx.tex(createRingTexture({ size: 128 }));
  const ringMat = new THREE.MeshBasicMaterial({ map: ringTex, color: 0xff9a2a, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
  const ballMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const balls = new THREE.InstancedMesh(volleyballGeometry(0.45), ballMat, list.length);
  balls.frustumCulled = false;
  const rings = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), ringMat, list.length);
  rings.frustumCulled = false;
  const players = new THREE.InstancedMesh(playerGeometry(), ctx.M.structure, list.length * 4);
  players.frustumCulled = false;
  ctx.add(balls, { cast: true, name: 'Volleyballs' });
  ctx.add(rings, { name: 'VolleyRings' });
  ctx.add(players, { cast: true, name: 'VolleyPlayers' });
  const m4 = new THREE.Matrix4(), st = {}, cRing = new THREE.Color();
  const views = list.map((h, i) => {
    const f = track.frameAt(h.s + 4);
    const wall = h.from > 0 ? f.wallR : f.wallL;
    const sideLat = (lat) => h.from * lat;
    // the server stands at the near court, 4.5 m past the wall; three teammates / rivals idle around
    const crew = [[4.5, 4], [9.5, 1], [7.5, 9], [12.5, 6]].map(([d, a], k) => {
      const fs = track.frameAt(h.s + a), lat = sideLat(wall + d);
      const x = fs.x + fs.right.x * lat, z = fs.z + fs.right.z * lat;
      return { x, z, g: field.surfaceHeight(x, z), yaw: Math.atan2(-fs.right.x * h.from, -fs.right.z * h.from) + (k ? (k - 2) * 0.5 : 0), k };
    });
    const server = crew[0];
    ctx.exclusions.push(...crew.map((c) => [c.x, c.z, 1.2]));
    for (const c of crew) ctx.prop('player', c.x, c.z, 0.4);
    return { h, i, crew, server, lastN: null, landed: false };
  });
  U.push((t, dt, live) => {
    for (const v of views) {
      const { h, i, server } = v;
      lobState(h, t, st);
      const spot = st.spot;
      const fl = track.frameAt(h.s + spot.along);
      const land = track.pointAt(h.s + spot.along, spot.lat);
      // ball: serve point (above the server) → arc → landing spot → bounce + roll → hops away inland
      let bx, by, bz;
      const sx = server.x, sy = server.g + 2.6, sz = server.z;
      if (st.tau < h.flight) {
        const f = st.tau / h.flight;
        bx = lerp(sx, land.x, f); bz = lerp(sz, land.z, f);
        by = lerp(sy, fl.y + 0.45, f) + L.arc * 4 * f * (1 - f);
      } else {
        const after = st.tau - h.flight;
        const p = track.pointAt(h.s + spot.along, st.lat);
        bx = p.x; bz = p.z;
        if (after <= L.after) by = fl.y + 0.45 + Math.abs(Math.sin(after * Math.PI / 0.25)) * 0.9 * (1 - after / L.after);
        else {
          // pops off inland over the wall and out of play
          const k = (after - L.after) / Math.max(0.05, h.period - h.flight - L.after);
          const away = track.pointAt(h.s + spot.along, st.lat + (spot.roll ?? -1) * 26 * k);
          bx = away.x; bz = away.z; by = fl.y + 0.45 + 7 * 4 * k * (1 - k);
        }
      }
      place_m4(m4, bx, by, bz, t * 9, 1, 1, 1);
      balls.setMatrixAt(i, m4);
      // landing ring: shrinks during the flight, red + pulsing in the danger window, gone after
      const f = st.tau / h.flight;
      let rs = 0.0001;
      if (st.tau < h.flight + L.after) {
        const end = 2 * (L.radius + 1.1) / 0.84;                     // the ring's outer edge = the hit circle
        rs = st.tau < h.flight ? lerp(end * 2.2, end, smoothstep(f)) : end * (1 + 0.05 * Math.sin(t * 30));
        cRing.set(st.danger ? 0xff3322 : 0xffa22a);
      }
      place_m4(m4, land.x, fl.y + 0.03, land.z, fl.yaw, rs, 1, rs);
      rings.setMatrixAt(i, m4);
      rings.setColorAt(i, cRing);
      // players: the server jumps into the spike, the others bob
      v.crew.forEach((c, k) => {
        let y = 0;
        if (k === 0) {
          // a 0.7 s jump that peaks just before the spike (tau = 0)
          const jt = st.tau < 0.3 ? st.tau + 0.4 : h.period - st.tau < 0.4 ? 0.4 - (h.period - st.tau) : -1;
          if (jt >= 0) y = 0.9 * 4 * (jt / 0.7) * (1 - jt / 0.7);
        } else y = 0.06 * Math.abs(Math.sin(t * 2.2 + k));
        place_m4(m4, c.x, c.g + Math.max(0, y), c.z, c.yaw, 1, 1, 1);
        players.setMatrixAt(i * 4 + k, m4);
      });
      if (live && v.lastN !== null && st.n !== v.lastN) emit('beachSpike', server.x, server.g + 2.5, server.z, 0.9);
      if (live && st.tau >= h.flight && !v.landed) emit('beachBounce', land.x, fl.y + 0.5, land.z, 1.0);
      v.landed = st.tau >= h.flight;
      v.lastN = st.n;
    }
    balls.instanceMatrix.needsUpdate = true;
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    players.instanceMatrix.needsUpdate = true;
  });
  ctx.stats.instances.volleyballs = list.length;
}

// ------------------------------------------------------------------ entry

/**
 * Draw the Laguna set pieces of `hz` (hazards/beach.js set) at hz.time.
 * opts: { hz, level (sea surface y), shoreLat(s) → lateral of the waterline (sea side, m) }.
 */
export function buildBeachSetPieces(ctx, field, { hz, level, shoreLat }) {
  registerBeachSounds();
  const U = [];
  let live = false;
  const emit = (name, x, y, z, vol) => { if (live) sfxAt(name, x, y, z, vol); };
  buildJets(ctx, hz.list.filter((h) => h.type === 'jet'), field, U, emit);
  buildSurges(ctx, hz.list.filter((h) => h.type === 'surge'), field, U, emit, { level, shoreLat });
  buildLobs(ctx, hz.list.filter((h) => h.type === 'lob'), field, U, emit);
  // drawn at hz.time; tick the clock ourselves only if nobody else does (dev pages / menus).
  // Sounds only while the race drives the clock (main.js: hz.driven).
  let last = hz.time;
  ctx.animators.push((dt) => {
    if (!hz.driven) hz.time += dt;
    const t = hz.time, step = t - last;
    live = hz.driven && step > 0 && step < 0.5;
    for (const u of U) u(t, Math.max(0, Math.min(0.1, step)), live);
    last = t;
  });
  for (const u of U) u(hz.time, 0, false);
  return { count: hz.list.length };
}
