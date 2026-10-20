// KARTS physics + model test-suite (node). Uses the REAL track (Breezy Bay).
//   node tools/kart-test.mjs            (full suite)
//   node tools/kart-test.mjs --quick    (laps only)
// Covers the 12 racers (SPEC §14.1), parts stats + engine class for every
// kart (§14.2), Steer Assist, drift + trick rules (§14.3), the model contract
// of every body × wheel × driver combination and custom racers (§14.9).
// Exits non-zero when any check fails.

import * as THREE from 'three';
import { Track } from '../public/js/track.js';
import { BREEZY_V4_DEF } from './fixtures/breezy-v4-def.mjs';
import { Kart, resolveKartCollisions, KART_TUNE, OFFROAD_MULT_MAX, ASSIST_TUNE, driftTightness, driftSteerFor, driftMaxYawRate } from '../public/js/kart.js';
import {
  CHARACTERS, DEFAULT_CHARACTER_ID, getCharacter, getAllCharacters, registerCustomCharacters, buildKartModel, disposeKartModel, kartModelCacheInfo,
} from '../public/js/characters.js';
import { KART_BODIES, WHEELS, WEIGHT_GROUPS, computeRatings, statsFromRatings, getEngineClass, ENGINE_CLASSES, CPU_PRESETS } from '../public/js/parts.js';
import { parseRacerIndex } from '../public/js/glb-racers.js';
import { KART, DRIFT, HIT, BOOST } from '../public/js/config.js';
import { bus } from '../public/js/bus.js';
import { Autopilot } from '../public/dev/karts-autopilot.js';

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const DT = 1 / 120;
// The frozen v3/v4 Breezy layout (tools/fixtures/breezy-v4-def.mjs): the physics checks below
// (lap windows, crest / kicker airtime at s 355 / 692, Turn 1 / hairpin drifts, bridge rails at
// s 520) were tuned on it; v5 lengthened the live course (SPEC §16.1).
const track = new Track(BREEZY_V4_DEF);
const L = track.length;
let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (cond, msg) => { if (!cond) fail(msg); return cond; };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : String(x));
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : String(x));

// Event recorder
const events = [];
bus.on('*', (data, type) => { events.push({ type, data, t: simTime }); });
let simTime = 0;

function isBad(k) {
  const p = k.position, v = k.velocity;
  return !(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) && Number.isFinite(k.yaw));
}

// Wall clearance: >= 0 means inside the allowed band (center stays radius away from walls).
function wallMargin(k) {
  const pr = k.proj;
  return Math.min(pr.wallR - pr.lateral, pr.wallL + pr.lateral) - KART_TUNE.wallRadius;
}

function makeKart(id, slot = 0, opts = {}) {
  const k = new Kart({ id, character: getCharacter(id), track, ...opts });
  k.placeOnGrid(track.gridSlot(slot));
  return k;
}

// Drive one kart with the autopilot for `laps` laps; collect stats.
function runLaps(id, { laps = 2, drift = false, maxTime = 200 } = {}) {
  const k = makeKart(id, 0);
  const ap = new Autopilot(k, { drift });
  events.length = 0;
  simTime = 0;
  let prevS = k.proj.s;
  let distance = track.deltaS(0, prevS);
  const lapTimes = [];
  let lapStart = 0, lapIdx = 0;
  let minMargin = Infinity, nan = false, maxSpeed = 0;
  const air = [];   // {s0, s1, t}
  let airStartS = null, airT = 0;
  let offroadT = 0;
  while (simTime < maxTime && lapTimes.length < laps) {
    ap.update(DT);
    k.update(DT);
    simTime += DT;
    if (isBad(k)) { nan = true; break; }
    const s = k.proj.s;
    distance += track.deltaS(prevS, s);
    prevS = s;
    if (Math.floor(distance / L) > lapIdx - 0 && distance >= (lapIdx + 1) * L) {
      lapTimes.push(simTime - lapStart);
      lapStart = simTime;
      lapIdx++;
    }
    minMargin = Math.min(minMargin, wallMargin(k));
    maxSpeed = Math.max(maxSpeed, k.horizontalSpeed);
    if (k.surface === 'offroad') offroadT += DT;
    if (!k.grounded && !k.drift.hopping) {
      if (airStartS === null) { airStartS = s; airT = 0; }
      airT += DT;
    } else if (airStartS !== null) {
      if (airT > 0.05) air.push({ s0: airStartS, s1: s, t: airT });
      airStartS = null;
    }
  }
  const count = (type, pred = () => true) => events.filter((e) => e.type === type && e.data.kart === k && pred(e.data)).length;
  return {
    k, lapTimes, minMargin, nan, maxSpeed, air, offroadT,
    wallHits: count('kart:wallHit'),
    pads: count('kart:boost', (d) => d.source === 'pad'),
    driftBoosts: count('kart:boost', (d) => d.source === 'drift'),
    tiers: events.filter((e) => e.type === 'kart:driftTier' && e.data.kart === k).map((e) => e.data.tier),
    hops: count('kart:hop'),
    lands: events.filter((e) => e.type === 'kart:land' && e.data.kart === k).map((e) => e.data.airTime),
    maxTier: ap.maxTier,
  };
}

const airAt = (air, s) => air.filter((a) => track.deltaS(s - 25, a.s0) >= 0 && track.deltaS(a.s0, s + 25) >= 0).reduce((m, a) => Math.max(m, a.t), 0);

// ------------------------------------------------------------------ 1. laps
console.log(`== Track ${track.name}: length ${f1(L)} m, hill crest ~355, kicker ramp at ${track.ramps.map((r) => f1(r.s0)).join(',')}`);
console.log('\n== 1. Autopilot laps (2 laps each; lap 1 = standing start)');
console.log('char   | stats(top/acc/turn/mass) | no-drift L1 / L2 | drift L1 / L2 | maxV  | wall margin | walls | pads | hill air | ramp air | drift tiers');
const lapResults = {};
for (const c of CHARACTERS) {
  const a = runLaps(c.id, { drift: false });
  const b = runLaps(c.id, { drift: true });
  lapResults[c.id] = { a, b };
  const st = a.k.stats;
  console.log(`${c.id.padEnd(6)} | ${f1(st.topSpeed)}/${f1(st.accel)}/${f2(st.turnRate)}/${f2(st.mass)}`.padEnd(34) +
    ` | ${f2(a.lapTimes[0])} / ${f2(a.lapTimes[1])}`.padEnd(19) +
    ` | ${f2(b.lapTimes[0])} / ${f2(b.lapTimes[1])}`.padEnd(16) +
    ` | ${f1(Math.max(a.maxSpeed, b.maxSpeed))}`.padEnd(8) +
    ` | ${f2(Math.min(a.minMargin, b.minMargin))}`.padEnd(14) +
    ` | ${a.wallHits}/${b.wallHits}`.padEnd(8) +
    ` | ${a.pads}/${b.pads}`.padEnd(7) +
    ` | ${f2(airAt(a.air, 355))}/${f2(airAt(b.air, 355))}`.padEnd(11) +
    ` | ${f2(airAt(a.air, 692))}/${f2(airAt(b.air, 692))}`.padEnd(11) +
    ` | max ${b.maxTier}, boosts ${b.driftBoosts}`);
  for (const r of [a, b]) {
    ok(!r.nan, `${c.id}: NaN during laps`);
    ok(r.lapTimes.length === 2, `${c.id}: did not finish 2 laps (${r.lapTimes.length})`);
    ok(r.minMargin >= -0.02, `${c.id}: exceeded wall band by ${f2(-r.minMargin)} m`);
    // plain driving must land in 30-42 s; the perfect drifting bot may dip just below
    for (const t of r.lapTimes) ok(t >= (r === b ? 27.5 : 30) && t <= 42, `${c.id}: lap time ${f2(t)} outside range`);
  }
  ok(b.driftBoosts > 0, `${c.id}: no drift boosts during drift laps`);
  ok(b.lapTimes[1] < a.lapTimes[1] + 0.05, `${c.id}: drifting lap (${f2(b.lapTimes[1])}) slower than plain (${f2(a.lapTimes[1])})`);
}
{
  const flying = (id) => lapResults[id].a.lapTimes[1];
  ok(flying('bombardiro') < flying('ballerina'), 'top-speed Tricheco (H2) should beat Farfallina (L1) on a flying lap');
  ok(flying('patapim') < flying('trippi'), 'Lamapisa (H1) should beat Rotolino (L2) on a flying lap');
}
if (QUICK) { console.log(`\n${failures ? 'FAILED' : 'PASSED'} (${failures} failures)`); process.exit(failures ? 1 : 0); }

// --------------------------------------------------------- helper: straight
// Place kart at (s, lateral) heading along the track at speed.
function setAt(k, s, lateral, speed, yawOffset = 0) {
  const f = track.frameAt(s);
  track.pointAt(s, lateral, k.position);
  k.yaw = f.yaw + yawOffset;
  k._resetState();
  k.velocity.set(Math.sin(k.yaw) * speed, 0, Math.cos(k.yaw) * speed);
  k.hint = -1;
  track.project(k.position, -1, k.proj);
  k.hint = k.proj.index;
  k.position.y = k.proj.height;
  k.surface = k.proj.surface;
  k._prevSlope = k.proj.slope;
}

function step(k, n, fn) { for (let i = 0; i < n; i++) { if (fn) fn(i); k.update(DT); simTime += DT; } }

// An endless flat plane (no walls; the road always points +z) for drift kinematics.
function flatTrack() {
  const N = 64, big = 1e5;
  return {
    id: 'flat', N, spacing: 1, length: 1e9, ramps: [], boostPads: [],
    wr: new Float32Array(N).fill(big), wl: new Float32Array(N).fill(big),
    deltaS: (a, b) => b - a, wrapS: (x) => x, forwardDistance: (a, b) => b - a,
    project(pos, hint, out = {}) {
      out.index = 0; out.f = 0; out.s = pos.z; out.lateral = -pos.x;
      out.centerY = 0; out.height = 0; out.onRamp = false; out.halfWidth = big; out.wallL = big; out.wallR = big;
      out.curvature = 0; out.slope = 0; out.yaw = 0;
      out.tangent = (out.tangent || new THREE.Vector3()).set(0, 0, 1);
      out.right = (out.right || new THREE.Vector3()).set(-1, 0, 0);
      out.surface = 'road'; out.boostPad = null;
      return out;
    },
    frameAt(x, out = {}) { return Object.assign(out, { index: 0, s: x, yaw: 0, halfWidth: big, wallL: big, wallR: big, racingLine: 0, curvature: 0, slope: 0 }); },
    pointAt(x, lat = 0, out = new THREE.Vector3()) { return out.set(-lat, 0, x); },
  };
}
function flatKart(character, speed, opts = {}) {
  const tr = flatTrack();
  const k = new Kart({ id: 'flat', character, track: tr, ...opts });
  k.position.set(0, 0, 0); k.yaw = 0; k._resetState();
  tr.project(k.position, -1, k.proj); k.hint = 0;
  k.velocity.set(0, 0, speed);
  return k;
}
// Hold DRIFT with the wheel at `steer0` until the hop has landed and the drift started.
function hopIntoDrift(k, steer0 = 1, maxT = 0.6) {
  k.input.throttle = 1; k.input.drift = true; k.input.steer = steer0; k._driftHeld = false;
  for (let t = 0; t < maxT && !k.drift.active; t += DT) { k.update(DT); simTime += DT; }
  return k.drift.active;
}

// ------------------------------------------------------- 2. acceleration etc
console.log('\n== 2. Acceleration, turn radius, drift radius');
for (const c of CHARACTERS) {
  const k = makeKart(c.id, 0);
  // 0 -> 90% on the start straight
  setAt(k, 2, 0, 0);
  let t = 0;
  k.input.throttle = 1;
  while (k.speed < 0.9 * k.stats.topSpeed && t < 8) { k.update(DT); t += DT; }
  // full-lock radius at speed on an open area: measure yaw rate
  setAt(k, 5, 0, k.stats.topSpeed);
  k.input.steer = 1; k.input.throttle = 1;
  step(k, 30);
  const radius = k.horizontalSpeed / Math.abs(k.yawRate);
  // tight drift radius
  setAt(k, 5, 0, k.stats.topSpeed);
  k.input.steer = 1; k.input.throttle = 1; k.input.drift = true; k._driftHeld = false;
  step(k, 60);
  const dr = k.drift.active ? k.horizontalSpeed / Math.abs(k.yawRate) : NaN;
  const slip = Math.atan2(k.velocity.x * -Math.cos(k.yaw) + k.velocity.z * Math.sin(k.yaw), k.speed);
  console.log(`${c.id.padEnd(6)} 0-90%: ${f2(t)} s | full-lock radius @top: ${f1(radius)} m | tight drift radius: ${f1(dr)} m (slip ${f1(slip * 57.3)} deg, speed ${f1(k.horizontalSpeed)})`);
  ok(t > 1.4 && t < 4.0, `${c.id}: 0-90% time ${f2(t)} out of range`);
  ok(radius > 15 && radius < 24, `${c.id}: full-lock radius ${f1(radius)} out of 15-24`);
  // full into the turn ~ normal full lock at top speed, never tighter (notes/drift-fix.md)
  ok(dr > radius * 0.95 && dr < radius * 1.3 && dr < 24, `${c.id}: tight drift radius ${f1(dr)} vs full lock ${f1(radius)} (want 0.95-1.3x, < 24 m)`);
}

// ------------------------------------------------------------- 3. airtime
console.log('\n== 3. Airtime at the hill crest and kicker ramp');
for (const [label, sStart, lat, boost] of [['hill @top', 300, 0, false], ['hill boosted', 330, 0, true], ['ramp @top', 640, 0, false], ['ramp via pad', 672, 0, false]]) {
  const k = makeKart('sahur');
  setAt(k, sStart, lat, k.stats.topSpeed);
  k.input.throttle = 1;
  if (boost) k.applyBoost(3, 'item');
  events.length = 0;
  let maxAir = 0, landed = [];
  let maxY = -Infinity;
  for (let i = 0; i < 600; i++) {
    k.input.steer = 0;
    k.update(DT);
    if (!k.grounded) maxAir = Math.max(maxAir, k.airTime);
    maxY = Math.max(maxY, k.position.y - k.proj.height);
    if (isBad(k)) { fail(`${label}: NaN`); break; }
  }
  landed = events.filter((e) => e.type === 'kart:land').map((e) => f2(e.data.airTime));
  console.log(`${label.padEnd(13)} max air ${f2(maxAir)} s, max clearance ${f2(maxY)} m, land events [${landed.join(', ')}]`);
  if (label.startsWith('ramp')) ok(maxAir > 0.45, `${label}: kicker airtime ${f2(maxAir)} too short`);
  if (label === 'hill boosted') ok(maxAir > 0.3, `${label}: boosted hill airtime ${f2(maxAir)} too short`);
}

// --------------------------------------------------------------- 4. drift
console.log('\n== 4. Drift through Turn 1 and the hairpin (auto-drift)');
for (const [label, s0, s1] of [['Turn 1', 60, 160], ['Hairpin', 375, 470]]) {
  for (const id of ['sahur', 'bombardiro', 'cappuccino']) {
    const k = makeKart(id);
    const ap = new Autopilot(k, { drift: true });
    setAt(k, s0, track.frameAt(s0).racingLine, k.stats.topSpeed);
    events.length = 0;
    let minMargin = Infinity, t = 0;
    while (track.deltaS(k.proj.s, s1) > 0 && t < 10) { ap.update(DT); k.update(DT); t += DT; minMargin = Math.min(minMargin, wallMargin(k)); }
    const tiers = events.filter((e) => e.type === 'kart:driftTier' && e.data.kart === k).map((e) => e.data.tier);
    const boosts = events.filter((e) => e.type === 'kart:boost' && e.data.source === 'drift').map((e) => f2(e.data.duration));
    const starts = events.filter((e) => e.type === 'kart:driftStart').length;
    console.log(`${label.padEnd(8)} ${id.padEnd(6)} time ${f2(t)} s, drift starts ${starts}, tiers [${tiers.join(',')}], drift boosts [${boosts.join(', ')}], min wall margin ${f2(minMargin)}`);
    ok(starts >= 1, `${label}/${id}: drift never started`);
    // wide Turn 1 is mostly counter-steered (slow charge); the hairpin always pays out
    if (label === 'Hairpin') {
      ok(tiers.length >= 1, `${label}/${id}: no tier reached`);
      ok(boosts.length >= 1, `${label}/${id}: no boost on release`);
    }
    ok(minMargin > -0.02, `${label}/${id}: exceeded walls`);
  }
}
{
  // manual: hop without steering = just a hop, no drift
  const k = makeKart('sahur');
  setAt(k, 5, 0, 25);
  events.length = 0;
  k.input.throttle = 1; k.input.drift = true; k.input.steer = 0; k._driftHeld = false;
  step(k, 90);
  const hop = events.filter((e) => e.type === 'kart:hop').length;
  const ds = events.filter((e) => e.type === 'kart:driftStart').length;
  console.log(`hop-only: hops ${hop}, drift starts ${ds}, lastAir ${f2(k.lastAirTime)}`);
  ok(hop === 1 && ds === 0, 'hop without steering should not start a drift');
  // release, then hop + steer on landing (grace window)
  k.input.drift = false; step(k, 5);
  events.length = 0;
  k.input.drift = true; k.input.steer = 0; step(k, 10);
  k.input.steer = -1; step(k, 40);
  const ds2 = events.filter((e) => e.type === 'kart:driftStart');
  console.log(`steer-on-landing: drift starts ${ds2.length} dir ${ds2[0] && ds2[0].data.dir}`);
  ok(ds2.length === 1 && ds2[0].data.dir === -1, 'steering during hop/landing should start a left drift');
  // slow down below cancel speed
  k.input.throttle = 0; k.input.brake = 1;
  step(k, 120);
  const cancel = events.filter((e) => e.type === 'kart:driftEnd' && e.data.cancelled).length;
  console.log(`brake to stop while drifting: cancelled ${cancel}, drift active ${k.drift.active}`);
  ok(cancel === 1 && !k.drift.active, 'drift should cancel when slow');
}

// ------------------------------------------------------------- 5. offroad
console.log('\n== 5. Offroad slowdown');
{
  const k = makeKart('sahur');
  // start straight: grass from halfWidth+1 to wall; drive parallel on grass
  const f = track.frameAt(20);
  setAt(k, 20, f.halfWidth + 3.5, k.stats.topSpeed);
  k.input.throttle = 1;
  const v0 = k.horizontalSpeed;
  let t05 = 0;
  for (let i = 0; i < 240; i++) {
    k.update(DT);
    if (i === 59) t05 = k.horizontalSpeed;
  }
  console.log(`grass: start ${f1(v0)} m/s -> 0.5 s ${f1(t05)} -> 2 s ${f1(k.horizontalSpeed)} m/s (max ${f1(k.maxSpeed)}), surface ${k.surface}`);
  ok(k.surface === 'offroad', 'kart should be on offroad');
  ok(k.stats.offroadMult === KART.offroadSpeedMult, 'default kart uses the base offroad multiplier');
  ok(Math.abs(k.horizontalSpeed - k.stats.topSpeed * k.stats.offroadMult) < 1, 'offroad speed should settle at offroad max');
  ok(t05 > k.stats.topSpeed * 0.62, 'offroad slowdown should be smooth, not instant');
  // boost ignores offroad
  k.applyBoost(1.0, 'item');
  step(k, 60);
  console.log(`grass + boost: ${f1(k.horizontalSpeed)} m/s`);
  ok(k.horizontalSpeed > k.stats.topSpeed, 'boost should ignore offroad slowdown');
}

// ----------------------------------------------------------- 6. boost pad
console.log('\n== 6. Boost pads');
for (const pad of track.boostPads) {
  const k = makeKart('ballerina');
  setAt(k, pad.s0 - 12, pad.lateral, 24);
  k.input.throttle = 1;
  events.length = 0;
  let maxV = 0;
  for (let i = 0; i < 160; i++) { k.input.steer = 0; k.update(DT); maxV = Math.max(maxV, k.horizontalSpeed); }
  const b = events.filter((e) => e.type === 'kart:boost' && e.data.source === 'pad').length;
  console.log(`pad @s ${f1(pad.s0)} lat ${pad.lateral}: triggers ${b}, max speed ${f1(maxV)} (top ${f1(k.stats.topSpeed)})`);
  ok(b === 1, `pad at ${f1(pad.s0)} should trigger exactly once`);
  ok(maxV > k.stats.topSpeed * 1.2, 'pad boost should raise speed above top speed');
}

// ------------------------------------------------------- 7. spin / tumble
console.log('\n== 7. Spin / tumble / zap / star recovery');
{
  const k = makeKart('tralalero');
  setAt(k, 10, 0, k.stats.topSpeed);
  k.input.throttle = 1;
  events.length = 0;
  ok(k.spinOut('banana') === true, 'spinOut should succeed');
  ok(k.spinOut('banana') === false, 'second spinOut during spin should fail');
  const v0 = k.horizontalSpeed;
  step(k, Math.round(HIT.spinDuration / DT) - 1);
  const vEnd = k.horizontalSpeed;
  console.log(`spin: speed ${f1(v0)} -> ${f1(vEnd)} (${f1((vEnd / v0) * 100)}%), yaw kept, invuln after ${f2(k.invulnTimer)}`);
  ok(vEnd / v0 > 0.2 && vEnd / v0 < 0.4, 'spin should decay speed to ~30%');
  step(k, 3);
  ok(!k.isDisabled() && k.invulnTimer > 1.0, 'after spin: control back + invuln');
  ok(k.isHittable() === false, 'invulnerable karts are not hittable');
  step(k, Math.round(1.3 / DT));
  ok(k.isHittable(), 'hittable again after invuln');
  ok(k.speed > 15, `kart re-accelerates after spin (speed ${f1(k.speed)})`);

  setAt(k, 30, 0, k.stats.topSpeed);
  k.input.throttle = 1;
  ok(k.tumble('rocket') === true, 'tumble should succeed');
  const tv0 = k.horizontalSpeed;
  let maxH = 0;
  for (let i = 0; i < Math.round(HIT.tumbleDuration / DT) - 1; i++) { k.update(DT); maxH = Math.max(maxH, k.position.y - k.proj.height); }
  console.log(`tumble: speed ${f1(tv0)} -> ${f1(k.horizontalSpeed)} (${f1((k.horizontalSpeed / tv0) * 100)}%), hop height ${f2(maxH)} m`);
  ok(k.horizontalSpeed / tv0 < 0.18, 'tumble should decay speed to ~10%');
  ok(maxH > 0.4, 'tumble should hop');
  step(k, 5);
  ok(!k.isDisabled() && !isBad(k), 'recovered from tumble');

  setAt(k, 50, 0, k.stats.topSpeed);
  ok(k.zap() === true, 'zap works');
  console.log(`zap: spin ${f2(k.spinTimer)} slow ${f2(k.slowTimer)} max ${f1(k.maxSpeed)}`);
  ok(k.slowTimer > 0 && k.maxSpeed < k.stats.topSpeed, 'zap slows');

  setAt(k, 60, 0, 20);
  k.startStar();
  ok(k.isInvincible() && !k.isHittable() && k.spinOut() === false && k.tumble() === false, 'star blocks hits');
  step(k, Math.round(8 / DT));
  ok(!k.isInvincible(), 'star ends');
  const se = events.filter((e) => e.type === 'kart:starStart' || e.type === 'kart:starEnd').map((e) => e.type);
  ok(se.includes('kart:starStart') && se.includes('kart:starEnd'), 'star events');
  // respawn
  k.respawn();
  ok(Math.abs(k.proj.lateral) < 0.5 && !isBad(k), 'respawn on centerline');
}

// ---------------------------------------------------------- 8. collisions
console.log('\n== 8. Kart-kart collisions');
for (const n of [2, 3, 5, 8]) {
  const ks = CHARACTERS.slice(0, n).map((c) => makeKart(c.id, 0));
  for (const k of ks) setAt(k, 40, 0, 0);
  let maxV = 0, nan = false, minMargin = Infinity;
  for (let i = 0; i < 120; i++) {
    for (const k of ks) { k.input.throttle = 0; k.update(DT); }
    resolveKartCollisions(ks);
    for (const k of ks) { maxV = Math.max(maxV, k.horizontalSpeed); if (isBad(k)) nan = true; minMargin = Math.min(minMargin, wallMargin(k)); }
  }
  let minD = Infinity;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) minD = Math.min(minD, Math.hypot(ks[i].position.x - ks[j].position.x, ks[i].position.z - ks[j].position.z));
  console.log(`${n} stacked karts: min separation after 1 s ${f2(minD)} m (2R=${2 * KART.radius}), max speed ${f1(maxV)}, NaN ${nan}, wall margin ${f2(minMargin)}`);
  ok(!nan, `${n} karts: NaN`);
  ok(minD > 2 * KART.radius - 0.15, `${n} karts: still overlapping (${f2(minD)})`);
  ok(maxV < 12, `${n} karts: explosive separation speed ${f1(maxV)}`);
  ok(minMargin > -0.02, `${n} karts: pushed through a wall`);
}
{
  // heavy vs light, side by side bump at equal speeds (closing at 8 m/s)
  const duke = makeKart('bombardiro'), pip = makeKart('ballerina');
  setAt(duke, 20, -1.3, 25); setAt(pip, 20, 1.3, 25);
  const r = track.frameAt(20).right;
  duke.velocity.x = Math.sin(duke.yaw) * 25 + r.x * 4; duke.velocity.z = Math.cos(duke.yaw) * 25 + r.z * 4;
  pip.velocity.x = Math.sin(pip.yaw) * 25 - r.x * 4; pip.velocity.z = Math.cos(pip.yaw) * 25 - r.z * 4;
  events.length = 0;
  const latV = (k) => k.velocity.x * r.x + k.velocity.z * r.z;
  let after = null;
  for (let i = 0; i < 90; i++) {
    duke.update(DT); pip.update(DT); resolveKartCollisions([duke, pip]);
    if (!after && events.some((e) => e.type === 'kart:bump')) after = { d: latV(duke), p: latV(pip), ld: duke.proj.lateral, lp: pip.proj.lateral };
  }
  const bumps = events.filter((e) => e.type === 'kart:bump');
  const shoveD = after ? duke.proj.lateral - after.ld : 0, shoveP = after ? pip.proj.lateral - after.lp : 0;
  console.log(`bombardiro vs ballerina side bump: post-impact lateral vel duke ${f2(after && after.d)}, pip ${f2(after && after.p)} m/s; post-bump lateral travel duke ${f2(shoveD)} m, pip ${f2(shoveP)} m; bump events ${bumps.length} intensity ${bumps[0] ? f2(bumps[0].data.intensity) : '-'}`);
  ok(after && Math.abs(after.p) > Math.abs(after.d) * 1.5, 'heavier kart should push the lighter one more');
  ok(shoveP > 0.6 && shoveP > Math.abs(shoveD) * 2, `lighter kart should get shoved (${f2(shoveP)} m)`);
  ok(bumps.length >= 1, 'bump event emitted');
  // star ram
  const a = makeKart('cappuccino'), b = makeKart('lirili');
  setAt(a, 60, 0, 20); setAt(b, 60.8, 0.3, 10);
  a.startStar();
  for (let i = 0; i < 10; i++) { a.update(DT); b.update(DT); resolveKartCollisions([a, b]); }
  console.log(`star ram: victim tumbling ${b.tumbleTimer > 0}, star speed ${f1(a.horizontalSpeed)}`);
  ok(b.tumbleTimer > 0, 'star ram should tumble the victim');
}

// ------------------------------------------------------------- 9. walls
console.log('\n== 9. Wall impacts at 30 m/s');
for (const ang of [90, 45, 20, 8]) {
  for (const side of [1, -1]) {
    // Bay Bridge: rails 2 m outside the road edge
    const k = makeKart('patapim');
    const s = 520;
    const f = track.frameAt(s);
    const gap = 2.5;   // distance from the allowed band edge at start
    const lat = side > 0 ? f.wallR - KART_TUNE.wallRadius - gap : -(f.wallL - KART_TUNE.wallRadius - gap);
    setAt(k, s, lat, 30, -side * ang * Math.PI / 180);
    k.input.throttle = 1;
    events.length = 0;
    let minMargin = Infinity, minSpd = Infinity, maxStep = 0;
    const vtan0 = 30 * Math.cos(ang * Math.PI / 180);
    let prev = k.position.clone();
    for (let i = 0; i < 240; i++) {
      k.input.steer = 0;
      k.update(DT);
      minMargin = Math.min(minMargin, wallMargin(k));
      if (events.some((e) => e.type === 'kart:wallHit')) minSpd = Math.min(minSpd, k.horizontalSpeed);
      maxStep = Math.max(maxStep, prev.distanceTo(k.position));
      prev.copy(k.position);
    }
    const hits = events.filter((e) => e.type === 'kart:wallHit');
    const fw = Math.sin(k.yaw) * f.tangent.x + Math.cos(k.yaw) * f.tangent.z;
    console.log(`${String(ang).padStart(2)}deg ${side > 0 ? 'right' : 'left '} rail: min margin ${f2(minMargin)}, min speed after hit ${f1(minSpd)} (tangential before ${f1(vtan0)}), speed after 2 s ${f1(k.horizontalSpeed)}, heading.tangent ${f2(fw)}, hits ${hits.length} first intensity ${hits[0] ? f2(hits[0].data.intensity) : '-'}, max step ${f2(maxStep)} m`);
    ok(minMargin > -0.02, `wall ${ang}deg: tunneling / penetration ${f2(minMargin)}`);
    ok(hits.length >= 1 && hits.length <= 4, `wall ${ang}deg: unexpected hit count ${hits.length}`);
    if (ang <= 45) ok(minSpd > vtan0 * 0.45, `wall ${ang}deg: kart should slide along (min speed ${f1(minSpd)})`);
    ok(k.horizontalSpeed > (ang >= 90 ? 10 : 20), `wall ${ang}deg: kart should recover speed (speed ${f1(k.horizontalSpeed)})`);
    if (ang >= 45) ok(minSpd < 22, `wall ${ang}deg: speed should be scrubbed`);
    ok(maxStep < 1, 'no teleporting at walls');
  }
}

// ------------------------------------------------------- 10. 8-kart chaos
console.log('\n== 10. 12 autopiloted karts racing with collisions (60 s)');
{
  const ks = CHARACTERS.map((c, i) => makeKart(c.id, i));
  const aps = ks.map((k, i) => new Autopilot(k, { drift: true, offset: ((i % 3) - 1) * 2.5 }));
  let nan = false, minMargin = Infinity, maxV = 0;
  events.length = 0;
  for (let i = 0; i < 60 / DT; i++) {
    for (const ap of aps) ap.update(DT);
    for (const k of ks) k.update(DT);
    resolveKartCollisions(ks);
    for (const k of ks) { if (isBad(k)) nan = true; minMargin = Math.min(minMargin, wallMargin(k)); maxV = Math.max(maxV, k.horizontalSpeed); }
  }
  const bumps = events.filter((e) => e.type === 'kart:bump').length;
  const walls = events.filter((e) => e.type === 'kart:wallHit').length;
  console.log(`NaN ${nan}, min wall margin ${f2(minMargin)}, max speed ${f1(maxV)}, bumps ${bumps}, wall hits ${walls}`);
  ok(!nan && minMargin > -0.02 && maxV < 45, '12-kart run sane');
}

// ------------------------------------------------- 11. roster, parts, cc
console.log('\n== 11. Roster, parts stats (every kart), engine class, bumps');
{
  const ids = CHARACTERS.map((c) => c.id);
  ok(ids.join(',') === 'ballerina,cappuccino,trippi,chimpanzini,sahur,tralalero,bananita,lirili,patapim,saturnita,bombardiro,gusini', `roster grid order (${ids.join(',')})`);
  ok(DEFAULT_CHARACTER_ID === 'sahur' && getCharacter('sahur').lead === true && getCharacter('nope') === getCharacter('sahur'), 'Sahur is the lead + fallback');
  for (const c of CHARACTERS) {
    const g = WEIGHT_GROUPS[c.group];
    ok(g && c.weightClass === g.weightClass && JSON.stringify(c.ratings) === JSON.stringify(g.ratings), `${c.id}: ratings = WEIGHT_GROUPS[${c.group}]`);
    ok(/^#[0-9a-f]{6}$/.test(c.cssColor) && /^#[0-9a-f]{6}$/.test(c.accentCss) && Number.isInteger(c.color) && Number.isInteger(c.accent), `${c.id}: colors`);
    ok(c.name && c.shortName && c.shortName.length <= 12 && c.tagline && c.catchphrase, `${c.id}: names + tagline + catchphrase`);
    ok(c.kart && ['paint', 'trim', 'rim'].every((k) => Number.isInteger(c.kart[k])), `${c.id}: kart colors`);
  }
  const groups = {};
  for (const c of CHARACTERS) groups[c.group] = (groups[c.group] || 0) + 1;
  ok(Object.keys(WEIGHT_GROUPS).every((g) => groups[g] === 2), `two racers per weight group (${JSON.stringify(groups)})`);

  // final ratings = character + body + wheels (clamped) for EVERY kart, CPUs included
  const same = (a, b) => ['topSpeed', 'accel', 'turnRate', 'mass'].every((key) => Math.abs(a[key] - b[key]) < 1e-9);
  let checked = 0;
  for (const c of CHARACTERS) for (const b of KART_BODIES) for (const w of WHEELS) {
    const lo = { body: b.id, wheels: w.id };
    for (const isPlayer of [true, false]) {
      const k = new Kart({ character: c, track, isPlayer, loadout: lo });
      const want = statsFromRatings(computeRatings(c, lo));
      if (!ok(same(k.stats, want), `${c.id} ${b.id}/${w.id} ${isPlayer ? 'player' : 'cpu'}: stats from parts`)) break;
      ok(Math.abs(k.stats.offroadMult - Math.min(OFFROAD_MULT_MAX, KART.offroadSpeedMult + w.offroad)) < 1e-9, `${c.id} ${w.id}: offroadMult`);
      checked++;
    }
  }
  console.log(`stats checked for ${checked} racer x body x wheels x (player, cpu) karts`);
  const r = computeRatings(getCharacter('bombardiro'), { body: 'speedster', wheels: 'slick' });
  ok(r.speed === 5 && r.accel === 1 && r.handling === 1.5, `ratings clamp to 1..5 (${JSON.stringify(r)})`);
  for (const preset of Object.values(CPU_PRESETS).flat()) ok(KART_BODIES.some((b) => b.id === preset.body) && WHEELS.some((w) => w.id === preset.wheels), `CPU preset ${preset.body}/${preset.wheels} exists`);
  ok(new Kart({ character: getCharacter('sahur'), track, loadout: { body: 'nope', wheels: 42 } }).loadout.body === 'standard', 'invalid parts fall back to Classic + Standard');
  const named = new Kart({ character: getCharacter('lirili'), track });
  ok(named.name === 'Lirili Larila' && named.shortName === 'Lirili' && named.cssColor === '#729b58', `kart name/color from the racer (${named.name} ${named.cssColor})`);

  // engine class: top speed + accel scale, turn rate does not
  const base = new Kart({ character: getCharacter('sahur'), track });
  for (const ec of ENGINE_CLASSES) {
    const k = new Kart({ character: getCharacter('sahur'), track, ccMult: ec.mult });
    ok(Math.abs(k.stats.topSpeed - base.stats.topSpeed * ec.mult) < 1e-9 && Math.abs(k.stats.accel - base.stats.accel * ec.mult) < 1e-9 && k.stats.turnRate === base.stats.turnRate, `${ec.label}: top speed / accel x ${ec.mult}, turn rate unchanged`);
  }
  ok(getEngineClass(100).mult === 0.9 && getEngineClass(999).id === 100, 'engine class lookup (default 100cc)');

  // wheels: grass speed (players and CPUs alike)
  const grass = (k) => {
    const f = track.frameAt(20);
    setAt(k, 20, f.halfWidth + 3.5, k.stats.topSpeed);
    k.input.throttle = 1;
    for (let i = 0; i < 300; i++) k.update(DT);
    return { v: k.horizontalSpeed, surface: k.surface };
  };
  const mud = makeKart('sahur', 0, { loadout: { wheels: 'offroad' } });
  const gm = grass(mud), gs = grass(makeKart('sahur', 0, { isPlayer: true }));
  console.log(`grass settle speed: mud grippers (cpu) ${f1(gm.v)} m/s, standard ${f1(gs.v)} m/s`);
  ok(gm.surface === 'offroad' && gs.surface === 'offroad', 'grass test karts are on the grass');
  ok(Math.abs(gm.v - mud.stats.topSpeed * mud.stats.offroadMult) < 1 && gm.v > gs.v * 1.2, 'mud grippers keep much more speed on grass (CPUs too)');
  // a rocket-sled kart really is faster down the start straight
  const vmax = (k) => { setAt(k, 2, 0, 0); k.input.throttle = 1; let m = 0; for (let i = 0; i < 9 / DT; i++) { k.input.steer = 0; k.update(DT); m = Math.max(m, k.horizontalSpeed); if (k.proj.s > 150) break; } return m; };
  const vr = vmax(makeKart('sahur', 0, { loadout: { body: 'rocket' } })), vd = vmax(makeKart('sahur', 0));
  console.log(`start straight top speed: rocket sled ${f1(vr)} vs classic ${f1(vd)} m/s`);
  ok(vr > vd + 0.4, 'rocket sled reaches a higher top speed');

  // bump mass = mass x (0.55 + 0.45 x speed/top) x (boosting ? 1.5 : 1)
  const k = makeKart('gusini');
  setAt(k, 30, 0, k.stats.topSpeed * 0.5);
  const m0 = k.bumpMass();
  k.applyBoost(1, 'pad');
  const m1 = k.bumpMass();
  ok(Math.abs(m0 - k.stats.mass * (0.55 + 0.45 * 0.5)) < 0.02 && Math.abs(m1 / m0 - 1.5) < 1e-6, `bump mass ${f2(m0)} -> boosting ${f2(m1)}`);
}

// ------------------------------------------------------- 12. steer assist
console.log('\n== 12. Steer Assist (SPEC §14.3a)');
{
  // near the right edge, drifting outward: pushed back in (assist) vs not
  const edgeRun = (assist) => {
    const k = makeKart('sahur', 0, { isPlayer: true, steerAssist: assist });
    const f = track.frameAt(30);
    setAt(k, 30, f.halfWidth - 0.4, 25, -0.05);
    k.input.throttle = 1;
    let maxAssist = 0, dir = 0;
    for (let i = 0; i < 90; i++) { k.input.steer = 0; k.update(DT); if (k.assist > maxAssist) { maxAssist = k.assist; dir = k.assistDir; } }
    return { lat: k.proj.lateral, maxAssist, dir, walls: 0 };
  };
  const on = edgeRun(true), off = edgeRun(false);
  console.log(`edge drift-out after 0.75 s: lateral assist ON ${f2(on.lat)} (antenna max ${f2(on.maxAssist)}, dir ${on.dir}) | OFF ${f2(off.lat)}`);
  ok(on.lat < off.lat - 0.5, 'assist pushes the kart back from the road edge');
  ok(on.maxAssist > 0.25 && on.dir === -1, 'antenna lights and points left (toward the road)');
  ok(off.maxAssist === 0, 'no assist values without steerAssist');
  // steering-wheel correction: heading toward the right edge, hands off -> steers left;
  // full opposite lock always wins
  const k = makeKart('sahur', 0, { isPlayer: true, steerAssist: true });
  setAt(k, 30, 2, 25, -0.5);
  const c0 = k._assist(0, DT);
  setAt(k, 30, 2, 25, -0.5);
  const c1 = k._assist(1, DT);
  setAt(k, 30, 2, 25, -0.5);
  const cHalf = k._assist(-0.3, DT);
  console.log(`heading 29 deg toward the right edge: hands off -> ${f2(c0)}, full right -> ${f2(c1)}, light left -> ${f2(cHalf)}`);
  ok(c0 < -0.2, 'hands off: the assist steers back toward the road');
  ok(c1 === 1, 'full opposite lock wins');
  ok(cHalf <= -0.3 && cHalf >= -1, 'same direction: the larger correction');
  // facing the wrong way: full lock toward the track direction
  setAt(k, 30, 0, 12, Math.PI * 0.8);
  const w = k._assist(0, DT);
  ok(Math.abs(w) === 1 && k.assist === 1, `wrong way -> full lock (${w})`);
  // drift charge capped at tier 2 with the assist (assist edges moved out of
  // the way: a full-lock drift circle does not fit between them)
  const saved = { edgeOut: ASSIST_TUNE.edgeOut, wallGap: ASSIST_TUNE.wallGap, driftLimit: ASSIST_TUNE.driftLimit };
  const savedMH = KART_TUNE.driftMaxHeading;
  Object.assign(ASSIST_TUNE, { edgeOut: 100, wallGap: -100, driftLimit: 0 });
  KART_TUNE.driftMaxHeading = 0;       // (a drift circle turns round; that cap is tested in section 13b)
  const tierRun = (assist) => {
    const kk = flatKart(getCharacter('sahur'), 25, { isPlayer: true, steerAssist: assist });   // no walls in the drift circle
    kk.input.throttle = 1; kk.input.steer = 1; kk.input.drift = true; kk._driftHeld = false;
    let maxTier = 0;
    for (let i = 0; i < 4 / DT; i++) { kk.input.steer = 1; kk.update(DT); maxTier = Math.max(maxTier, kk.drift.tier); }
    return maxTier;
  };
  const tOn = tierRun(true), tOff = tierRun(false);
  Object.assign(ASSIST_TUNE, saved);
  KART_TUNE.driftMaxHeading = savedMH;
  console.log(`4 s drift, wheel held in: max tier assist ON ${tOn}, OFF ${tOff}`);
  ok(tOn === DRIFT.assistMaxTier && tOff === 3, 'assist caps the mini-turbo at tier 2');
  ok(ASSIST_TUNE.edgeOut === 0.5 && ASSIST_TUNE.wallGap === 1.4 && ASSIST_TUNE.range === 2.5 && ASSIST_TUNE.push === 26 && ASSIST_TUNE.bleed === 14 && ASSIST_TUNE.rotate === 2.6, 'assist constants per SPEC');
  ok(new Kart({ character: getCharacter('lirili'), track }).steerAssist === false, 'CPU karts never assist by default');
}

// --------------------------------------------------------- 13. drift v3
console.log('\n== 13. Drift charge, mini-turbo boosts, overlapping boosts');
{
  ok(Math.abs(driftSteerFor(driftTightness(0.37)) - 0.37) < 1e-9 && Math.abs(driftTightness(-1) - KART_TUNE.driftWide) < 1e-9 && Math.abs(driftTightness(1) - KART_TUNE.driftTight) < 1e-9, 'drift arc mapping + inverse');
  const savedMH = KART_TUNE.driftMaxHeading;
  KART_TUNE.driftMaxHeading = 0;       // long drift circles on the flat plane (cap: section 13b)
  const chargeRun = (steerInto, secs) => {
    const k = flatKart(getCharacter('sahur'), 25);
    k.input.throttle = 1; k.input.steer = 1; k.input.drift = true; k._driftHeld = false;
    let t = 0;
    for (; t < 0.6 && !k.drift.active; t += DT) step(k, 1);      // the hop picks the direction on landing
    const dir = k.drift.dir;
    step(k, Math.round((secs - t) / DT), () => { k.input.steer = dir * steerInto; });
    return k;
  };
  const fast = chargeRun(1, 1.25), slow = chargeRun(0, 1.25);
  console.log(`1.25 s of drift (incl. the hop): wheel in -> charge ${f2(fast.drift.charge)} tier ${fast.drift.tier} | neutral -> charge ${f2(slow.drift.charge)} tier ${slow.drift.tier}`);
  ok(fast.drift.tier === 1 && slow.drift.tier === 0 && Math.abs(slow.drift.charge / fast.drift.charge - DRIFT.chargeSlowRate) < 0.06, 'wheel into the turn charges 2.5x faster');
  // release at each tier: boost length by tier x accel stars, x1.2 speed, tier in the events
  for (const [id, tier] of [['sahur', 1], ['sahur', 2], ['sahur', 3], ['ballerina', 3], ['bombardiro', 3]]) {
    const k = flatKart(getCharacter(id), 26);      // open plane: the drift circle meets no wall
    hopIntoDrift(k, 1);
    const dir = k.drift.dir;
    events.length = 0;
    for (let i = 0; i < 6 / DT && k.drift.tier < tier; i++) { k.input.steer = dir; k.update(DT); }
    k.input.drift = false;
    step(k, 1);
    const b = events.find((e) => e.type === 'kart:boost' && e.data.source === 'drift');
    const end = events.find((e) => e.type === 'kart:driftEnd');
    const want = DRIFT.boostDurations[tier] * (1 + DRIFT.boostAccelGain * (k.ratings.accel - 3));
    ok(b && Math.abs(b.data.duration - want) < 1e-9 && b.data.mult === DRIFT.boostSpeedMult && b.data.tier === tier && end && end.data.tier === tier,
      `${id} tier ${tier}: boost ${b ? f2(b.data.duration) : '-'} s (want ${f2(want)}) x${b ? b.data.mult : '-'}, event tiers ${b && b.data.tier}/${end && end.data.tier}`);
  }
  KART_TUNE.driftMaxHeading = savedMH;
  // overlapping boosts keep the larger multiplier and the longer remaining time
  const k = makeKart('sahur');
  setAt(k, 5, 0, 25);
  k.applyBoost(2.4, 'drift', DRIFT.boostSpeedMult, 3);
  k.applyBoost(1.0, 'pad');
  ok(k.boostMult === KART.boostSpeedMult && Math.abs(k.boostTimer - 2.4) < 1e-9, `pad over a drift boost: x${k.boostMult} for ${f2(k.boostTimer)} s`);
  k.boostTimer = 0;
  k.applyBoost(0.6, 'drift', DRIFT.boostSpeedMult, 1);
  ok(k.boostMult === DRIFT.boostSpeedMult, 'a fresh drift boost runs at x1.2');
  const v0 = k.maxSpeed;
  ok(Math.abs(v0 - k.stats.topSpeed * DRIFT.boostSpeedMult) < 0.5, `drift boost max speed ${f1(v0)}`);
}


// ---------------------------------------------- 13b. drift arc + safety nets
console.log('\n== 13b. Drift arc, rotation budget, slip cap, low speed, walls, heading cap, landing direction, exit');
{
  const RAD = 180 / Math.PI;
  const savedMH = KART_TUNE.driftMaxHeading;
  // steady state on the open plane: yaw rate and path radius for x = steer * dir
  const steady = (character, v, x, drift) => {
    const k = flatKart(character, v);
    k.stats.topSpeed = v + 0.02;
    k.input.throttle = 1;
    if (drift) hopIntoDrift(k, 1);
    let yawAcc = 0, velAcc = 0, n = 0, spd = 0, slip = 0;
    let pY = k.yaw, pV = Math.atan2(k.velocity.x, k.velocity.z);
    for (let t = 0; t < 3; t += DT) {
      k.input.drift = drift; k.input.steer = drift ? k.drift.dir * x : x;
      k.update(DT);
      const vy = Math.atan2(k.velocity.x, k.velocity.z);
      if (t > 1.5) {
        yawAcc += Math.atan2(Math.sin(k.yaw - pY), Math.cos(k.yaw - pY)); velAcc += Math.atan2(Math.sin(vy - pV), Math.cos(vy - pV));
        spd += k.horizontalSpeed; slip += Math.abs(Math.atan2(Math.sin(vy - k.yaw), Math.cos(vy - k.yaw))); n++;
      }
      pY = k.yaw; pV = vy;
    }
    const w = Math.abs(yawAcc) / (n * DT);
    return { w, R: (spd / n) / (Math.abs(velAcc) / (n * DT)), slip: (slip / n) * RAD, active: k.drift.active };
  };
  KART_TUNE.driftMaxHeading = 0;
  const rug = getCharacter('sahur');
  const top = 29;
  const nrm = steady(rug, top, 1, false);
  const arc = [-1, 0, 0.5, 1].map((x) => steady(rug, top, x, true));
  console.log(`sahur @${top} m/s: normal full lock ${f1(nrm.w * RAD)}°/s R ${f1(nrm.R)} m | drift x=-1/0/0.5/1: ${arc.map((r) => `${f1(r.w * RAD)}°/s R ${f1(r.R)} m slip ${f1(r.slip)}°`).join(' | ')}`);
  ok(arc.every((r) => r.active), 'steady drifts stay active on the open plane');
  ok(arc[3].R >= 0.9 * nrm.R && arc[3].R <= 22, `full-in drift R ${f1(arc[3].R)} m: about normal full lock (${f1(nrm.R)} m), never tighter, <= the tightest hairpin`);
  ok(arc[2].R > arc[3].R * 1.25 && arc[1].R > arc[3].R * 1.8 && arc[0].R > arc[3].R * 4, 'the wheel widens the arc: fast-charge position > 1.25x, neutral > 1.8x, full counter > 4x the full-in radius');
  ok(arc[0].w > 0.1, 'full counter-steer still turns into the drift (never straight or reversed)');
  ok(arc[3].slip <= 25, `steady full-in slip ${f1(arc[3].slip)}° <= 25°`);
  // the best-handling kart's ceiling + rotation budget from the hop (full in)
  const best = { id: 'h5', name: 'h5', ratings: { speed: 3, accel: 3, handling: 5, weight: 3 }, weightClass: 'medium' };
  const kb = flatKart(best, top);
  kb.stats.topSpeed = top;
  kb.input.throttle = 1; kb.input.drift = true; kb.input.steer = 1; kb._driftHeld = false;
  let rot = 0, prev = kb.yaw, maxW = 0;
  const at = {};
  for (let t = 0; t < 4; t += DT) {
    kb.update(DT);
    rot += Math.abs(Math.atan2(Math.sin(kb.yaw - prev), Math.cos(kb.yaw - prev))); prev = kb.yaw;
    if (kb.drift.active) maxW = Math.max(maxW, Math.abs(kb.yawRate));
    for (const tt of [0.85, 1.8, 2.8, 3.8]) if (at[tt] === undefined && t >= tt) at[tt] = rot * RAD;
  }
  console.log(`handling 5, full in from the hop: ${Object.entries(at).map(([tt, r]) => `${tt} s ${f1(r)}°`).join(', ')}, max drift yaw rate ${f1(maxW * RAD)}°/s`);
  ok(at[0.85] <= 95 && at[1.8] <= 185 && at[2.8] <= 280 && at[3.8] <= 380 && maxW * RAD <= 110, 'rotation budget: <= 90/180/270° by blue/orange/purple, 360° no sooner than ~3.8 s, <= 110°/s');
  // low speed: the arc never gets tighter than driftMinRadius
  {
    const k = flatKart(rug, 26);
    k.stats.topSpeed = 26;
    hopIntoDrift(k, 1);
    k.speedMult = 0.55;                    // max speed 14.3 m/s (still above the 50 % keep speed): the kart slows inside the drift
    let minR = Infinity;
    for (let t = 0; t < 2.5; t += DT) { k.input.steer = k.drift.dir; k.update(DT); if (k.drift.active && t > 1.2) minR = Math.min(minR, k.horizontalSpeed / Math.abs(k.yawRate)); }
    console.log(`slowed full-in drift at ${f1(k.horizontalSpeed)} m/s: min radius ${f1(minR)} m (still drifting: ${k.drift.active})`);
    ok(k.drift.active && minR >= KART_TUNE.driftMinRadius * 0.97, `slow drift radius ${f1(minR)} m >= ${KART_TUNE.driftMinRadius} m`);
    ok(Math.abs(driftMaxYawRate(k.stats.turnRate, 12) - 12 / KART_TUNE.driftMinRadius) < 1e-9, 'driftMaxYawRate caps at v / driftMinRadius');
  }
  // too slow: the drift ends with its mini-turbo (cancelled when braking: section 4)
  {
    const k = flatKart(rug, 26);
    k.stats.topSpeed = 26;
    hopIntoDrift(k, 1);
    k.drift.charge = DRIFT.tierTimes[0] + 0.01;
    events.length = 0;
    k.input.throttle = 0;
    for (let t = 0; t < 4 && k.drift.active; t += DT) { k.input.steer = k.drift.dir; k.update(DT); }
    const end = events.find((e) => e.type === 'kart:driftEnd');
    console.log(`coasting below ${f1(DRIFT.keepSpeedFrac * 26)} m/s: drift end tier ${end && end.data.tier}, cancelled ${end && !!end.data.cancelled}, speed ${f1(k.speed)}`);
    ok(end && end.data.tier >= 1 && !end.data.cancelled && k.speed > KART_TUNE.driftCancelSpeed, 'a drift that gets too slow ends and pays its mini-turbo');
  }
  // slip cap: shove the path outward, the nose can't stay more than driftSlipMax ahead
  {
    const k = flatKart(rug, 26);
    k.stats.topSpeed = 26;
    hopIntoDrift(k, 1);
    step(k, 30, () => { k.input.steer = k.drift.dir; });
    const vy = Math.atan2(k.velocity.x, k.velocity.z) + k.drift.dir * 0.9;     // travel swung 52° outward
    const hs = k.horizontalSpeed;
    k.velocity.x = Math.sin(vy) * hs; k.velocity.z = Math.cos(vy) * hs;
    let maxLead = 0;
    for (let i = 0; i < 40; i++) { k.input.steer = k.drift.dir; k.update(DT); maxLead = Math.max(maxLead, k.driftSlip * RAD); }
    console.log(`shoved drift: max nose lead over the travel direction ${f1(maxLead)}° (cap ${KART_TUNE.driftSlipMax}°)`);
    ok(maxLead <= KART_TUNE.driftSlipMax + 0.5, 'the nose never leads the travel direction by more than driftSlipMax');
  }
  // heading cap: a drift whose nose turns more than driftMaxHeading off the road lets go
  KART_TUNE.driftMaxHeading = savedMH;
  {
    const k = flatKart(rug, 26);
    k.stats.topSpeed = 26;
    events.length = 0;
    hopIntoDrift(k, 1);
    let maxOff = 0;
    for (let t = 0; t < 3 && k.drift.active; t += DT) { k.input.steer = k.drift.dir; k.update(DT); if (k.drift.active) maxOff = Math.max(maxOff, Math.abs(k.yaw) * RAD); }
    const end = events.find((e) => e.type === 'kart:driftEnd');
    console.log(`drift held full in on an open plane: let go at ${f1(maxOff)}° off the road (cap ${savedMH}°), cancelled ${end && !!end.data.cancelled}`);
    ok(!k.drift.active && end && end.data.cancelled && maxOff <= savedMH + 2, 'a drift cannot turn the kart round: it lets go past driftMaxHeading');
  }
  // the hop reads the direction when it lands: DRIFT pressed with a stale left tilt, right before landing
  {
    const k = flatKart(rug, 26);
    k.stats.topSpeed = 26;
    events.length = 0;
    k.input.throttle = 1; k.input.drift = true; k.input.steer = -0.6; k._driftHeld = false;
    step(k, 1);
    step(k, 10, () => { k.input.steer = 0.8; });
    for (let t = 0; t < 0.5 && !k.drift.active; t += DT) step(k, 1);
    const st = events.filter((e) => e.type === 'kart:driftStart');
    console.log(`stale left tilt at the press, right on landing: drift starts ${st.length} dir ${st[0] && st[0].data.dir}`);
    ok(st.length === 1 && st[0].data.dir === 1, 'the drift direction comes from the wheel at landing');
  }
  // Steer Assist never picks the side: heading for the right edge the assist steers left, but with
  // the player's wheel still centred at landing the drift waits (land grace) and takes the player's side
  {
    const k = makeKart('sahur', 0, { isPlayer: true, steerAssist: true });
    setAt(k, 30, 2, 25, -0.5);                   // heading ~29° toward the right edge
    events.length = 0;
    k.input.throttle = 1; k.input.drift = true; k.input.steer = 0.05; k._driftHeld = false;
    let assisted = 0;
    for (let t = 0; t < 0.3 && !k.drift.active; t += DT) { step(k, 1); assisted = Math.min(assisted, k.steerVisual); }
    const early = events.filter((e) => e.type === 'kart:driftStart').length;
    for (let t = 0; t < 0.3 && !k.drift.active; t += DT) step(k, 1, () => { k.input.steer = 0.6; });
    const st = events.filter((e) => e.type === 'kart:driftStart');
    console.log(`assist steering left (${f2(assisted)}) while the wheel is centred at landing: drifts before the tilt ${early}, then dir ${st[0] && st[0].data.dir}`);
    ok(assisted < -0.1 && early === 0 && st.length === 1 && st[0].data.dir === 1, 'Steer Assist never picks the drift side: the player\'s wheel does');
  }
  // a wall knock ends the drift and fires the charged mini-turbo
  {
    const k = makeKart('sahur');
    const f = track.frameAt(30);
    setAt(k, 30, f.wallR - 4, 26, -0.45);       // heading ~26° into the right wall
    k.grounded = true;
    k._startDrift(1);
    k.drift.charge = DRIFT.tierTimes[0] + 0.01; k.drift.tier = 1;
    events.length = 0;
    k.input.throttle = 1; k.input.drift = true; k._driftHeld = true;
    for (let t = 0; t < 1.5 && k.drift.active; t += DT) { k.input.steer = 1; k.update(DT); }
    const wall = events.find((e) => e.type === 'kart:wallHit');
    const end = events.find((e) => e.type === 'kart:driftEnd');
    const boost = events.find((e) => e.type === 'kart:boost' && e.data.source === 'drift');
    console.log(`drift into the wall: wall hit ${!!wall}, drift end tier ${end && end.data.tier}, mini-turbo ${boost ? f2(boost.data.duration) : '-'} s`);
    ok(wall && end && end.data.tier === 1 && !end.data.cancelled && boost && !k.drift.active, 'a wall knock ends the drift with its mini-turbo');
  }
  // release: the slip closes mostly by the nose swinging onto the path (no dart to the inside)
  {
    const k = flatKart(rug, 26);
    k.stats.topSpeed = 26;
    hopIntoDrift(k, 1);
    step(k, 60, () => { k.input.steer = k.drift.dir; });
    const v0 = Math.atan2(k.velocity.x, k.velocity.z), y0 = k.yaw;
    k.input.drift = false;
    step(k, Math.round(0.35 / DT), () => { k.input.steer = 0; });
    const dv = Math.abs(Math.atan2(Math.sin(Math.atan2(k.velocity.x, k.velocity.z) - v0), Math.cos(Math.atan2(k.velocity.x, k.velocity.z) - v0))) * RAD;
    const dn = Math.abs(Math.atan2(Math.sin(k.yaw - y0), Math.cos(k.yaw - y0))) * RAD;
    console.log(`0.35 s after a release (wheel centred): path turned ${f1(dv)}°, nose turned ${f1(dn)}°`);
    ok(dn > dv, 'after a release the nose swings onto the path rather than the path snapping onto the nose');
  }
  // Steer Assist in a drift: heading out of the road window caps the arc (wider), the player's full lock doesn't win
  {
    const k = makeKart('sahur', 0, { isPlayer: true, steerAssist: true });
    setAt(k, 30, 0, 25, 0.75);                   // heading ~43° left of the road
    k._startDrift(-1);
    const out = k._assist(-1, DT);               // full lock into the (left) drift
    setAt(k, 30, 0, 25, 0);
    k._startDrift(-1);
    const fine = k._assist(-1, DT);
    console.log(`assist in a left drift heading off the road: full in -1 -> ${f2(out)} | heading along the road: -1 -> ${f2(fine)}`);
    ok(out > -0.2 && fine === -1, 'the assist widens a drift that heads off the road, and leaves a good one alone');
  }
  KART_TUNE.driftMaxHeading = savedMH;
}

// ------------------------------------------- 13c. drift-exit steering latch
console.log('\n== 13c. Drift-exit steering latch (SPEC §15.1): leftover tilt after a release');
{
  const RAD = 180 / Math.PI;
  const savedMH = KART_TUNE.driftMaxHeading, savedLT = KART_TUNE.exitLatchTime;
  KART_TUNE.driftMaxHeading = 0;
  const rug = getCharacter('sahur');
  const smooth = (x) => { const u = Math.min(1, Math.max(0, x)); return u * u * (3 - 2 * u); };
  // drift right at full tilt for `hold` s, release DRIFT, then the wheel follows after(t) for `secs`
  const exitRun = ({ isPlayer = true, hold = 1.0, secs = 1.0, after = () => 1, log = null } = {}) => {
    const k = flatKart(rug, 26, { isPlayer });
    k.stats.topSpeed = 26;
    hopIntoDrift(k, 1);
    const dir = k.drift.dir;
    step(k, Math.round(hold / DT), () => { k.input.steer = dir; });
    if (log) {
      const orig = k._exitLatch.bind(k);
      k._exitLatch = (u, disabled, dt) => { const t = k._latchT; const o = orig(u, disabled, dt); log.push({ t, u, o }); return o; };
    }
    k.input.drift = false;
    const yr = [];
    const p0 = Math.atan2(k.velocity.x, k.velocity.z);
    for (let i = 0, t = 0; i < Math.round(secs / DT); i++) {
      k.input.steer = dir * after(t);
      k.update(DT); simTime += DT; t += DT;
      yr.push({ t, w: -dir * k.yawRate * RAD, path: -dir * Math.atan2(Math.sin(Math.atan2(k.velocity.x, k.velocity.z) - p0), Math.cos(Math.atan2(k.velocity.x, k.velocity.z) - p0)) * RAD, latch: k.exitLatch });
    }
    return { k, dir, yr };
  };
  // full tilt kept after the release: into-turn steer held under the rising ceiling for exitLatchTime
  const log = [];
  const held = exitRun({ log });
  const capped = log.every((e) => e.o * held.dir <= KART_TUNE.exitLatchStart + (1 - KART_TUNE.exitLatchStart) * smooth(e.t / KART_TUNE.exitLatchTime) + 1e-9);
  const span = log.length ? log[log.length - 1].t : 0;
  console.log(`full tilt kept: latch ran ${f2(span)} s (${log.length} steps), steer ${log.slice(0, 13).filter((_, i) => i % 6 === 0).map((e) => f2(e.o * held.dir)).join(' -> ')} …, off after: ${held.yr[held.yr.length - 1].latch === null}`);
  ok(log.length > 0 && capped && Math.abs(log[0].o) < 1e-9, 'after a drift the leftover into-turn tilt is capped by the rising ceiling (0 at the release)');
  ok(span >= KART_TUNE.exitLatchTime - 2 * DT && span <= KART_TUNE.exitLatchTime + DT && held.yr[held.yr.length - 1].latch === null, `the latch hands the wheel back after exitLatchTime (${f2(span)} s)`);
  // and the kart stops carrying the turn on: path swing into the old corner, tilt kept, vs no latch
  const pathAt = (r, t) => r.yr[Math.round(t / DT) - 1].path;
  KART_TUNE.exitLatchTime = 0;
  const noLatch = exitRun();
  KART_TUNE.exitLatchTime = savedLT;
  console.log(`path swing into the old corner 0.3 / 0.6 s after the release, tilt kept: ${f1(pathAt(held, 0.3))}° / ${f1(pathAt(held, 0.6))}° (no latch ${f1(pathAt(noLatch, 0.3))}° / ${f1(pathAt(noLatch, 0.6))}°)`);
  ok(pathAt(held, 0.6) < 0.7 * pathAt(noLatch, 0.6) && pathAt(held, 0.3) < pathAt(noLatch, 0.3), 'the latch takes much of the leftover turn out of the exit');
  // counter-steer always passes
  const clog = [];
  exitRun({ after: () => -1, log: clog, secs: 0.3 });
  ok(clog.length === 0 || clog.every((e) => e.o === e.u), 'counter-steer passes the latch untouched');
  // re-centring within the ceiling hands the wheel back at once
  const rc = exitRun({ after: (t) => (t < 0.1 - DT / 2 ? 1 : 0), secs: 0.3 });
  const iBack = rc.yr.findIndex((x) => x.t > 0.1 + DT / 2);
  ok(rc.yr[5].latch !== null && iBack >= 0 && rc.yr[iBack].latch === null, 're-centring hands the wheel back early');
  // a new DRIFT press (hop) ends it; CPUs never get it; short drifts don't arm it; respawn clears it
  {
    const r = exitRun({ secs: 0.1 });
    const k = r.k;
    ok(k.exitLatch !== null, 'latch running 0.1 s after the release');
    k.input.drift = true;
    step(k, 1);
    ok(k.exitLatch === null && k.drift.hopping, 'a new DRIFT press (hop) ends the latch');
  }
  ok(exitRun({ isPlayer: false, secs: 0.1 }).k.exitLatch === null, 'CPU karts have no exit latch');
  ok(exitRun({ hold: 0.1, secs: 0.05 }).k.exitLatch === null, `no latch after a drift shorter than ${KART_TUNE.exitLatchMinDrift} s`);
  {
    const r = exitRun({ secs: 0.1 });
    r.k.respawn();
    ok(r.k.exitLatch === null, 'respawn clears the latch');
  }
  // road gate: only while the nose points at/inside the road ahead (corner over); else the tilt passes
  {
    const k = flatKart(rug, 26, { isPlayer: true });
    const probe = (yaw) => { k.yaw = yaw; k._latchOn = true; k._latchT = 0.1; k._latchDir = 1; return k._exitLatch(1, false, DT); };
    const inside = probe(-0.3), outside = probe(0.3);
    console.log(`0.1 s into a right-drift latch, full right tilt: nose 17° right of the road -> ${f2(inside)} | 17° left (corner continues) -> ${f2(outside)}`);
    ok(Math.abs(inside - smooth(0.1 / KART_TUNE.exitLatchTime)) < 1e-9 && outside === 1, 'the cap applies only while the nose points at/inside where the road goes');
  }
  KART_TUNE.driftMaxHeading = savedMH;
  KART_TUNE.exitLatchTime = savedLT;
}

// ------------------------------------------------------- 14. jump trick
console.log('\n== 14. Jump boost (trick) off the kicker ramp');
{
  const ramp = track.ramps[0];
  const trickRun = (pressAt, hop = false) => {
    const k = makeKart('sahur');
    setAt(k, ramp.s0 - 15, ramp.lat0 !== undefined ? (ramp.lat0 + ramp.lat1) / 2 : 0, k.stats.topSpeed);
    k.input.throttle = 1;
    events.length = 0;
    let pressed = false, t = 0;
    for (let i = 0; i < 300; i++) {
      k.input.steer = 0;
      k.input.drift = false;
      if (hop && i === 2) k.input.drift = true;
      if (!hop && !pressed && !k.grounded && k.airTime >= pressAt) { k.input.drift = true; pressed = true; }
      k.update(DT);
      t += DT;
    }
    return {
      tricks: events.filter((e) => e.type === 'kart:trick').length,
      boost: events.find((e) => e.type === 'kart:boost' && e.data.source === 'trick'),
    };
  };
  const good = trickRun(0.05), late = trickRun(0.7), hop = trickRun(0, true);
  console.log(`press at 0.05 s air: tricks ${good.tricks}, boost ${good.boost ? `${f2(good.boost.data.duration)} s x${good.boost.data.mult}` : '-'} | late (0.7 s): tricks ${late.tricks} | drift hop: tricks ${hop.tricks}`);
  ok(good.tricks === 1 && good.boost && good.boost.data.duration === DRIFT.trickBoost && good.boost.data.mult === DRIFT.boostSpeedMult, 'trick: kart:trick + 0.6 s x1.2 boost on landing');
  ok(late.tricks === 0 && !late.boost, 'no trick after the 0.5 s window');
  ok(hop.tricks === 0, 'a drift hop is not a trick');
}

// ------------------------------------------------------- 15. model contract
console.log('\n== 15. Models: every body x wheels (x LOD), every racer, custom racers');
{
  const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
  const finiteBox = (g) => g && g.boundingBox && ['x', 'y', 'z'].every((a) => Number.isFinite(g.boundingBox.min[a]) && Number.isFinite(g.boundingBox.max[a]));
  const box = new THREE.Box3();
  let built = 0, maxCalls = 0, maxCallsWhat = '', maxTris = 0, maxTrisWhat = '', maxDriver = 0, maxDriverWhat = '';
  const fake = { boostTimer: 1, starTimer: 0, speed: 25 };
  const check = (def, loadout, lod, what) => {
    const m = buildKartModel(def, { lod, loadout });
    built++;
    const ud = m.userData;
    const fail0 = failures;
    ok(ud.body && ud.driver && ud.head && ud.headMesh && ud.body.isObject3D && ud.driver.isObject3D && ud.head.isObject3D, `${what}: body/driver/head/headMesh`);
    ok(['fl', 'fr', 'rl', 'rr'].every((k) => ud.wheels[k] && ud.wheels[k].isObject3D), `${what}: wheels fl/fr/rl/rr`);
    ok(ud.steerPivots.fl && ud.steerPivots.fr && ud.steerPivots.fl.children[0] === ud.wheels.fl && ud.steerPivots.fr.children[0] === ud.wheels.fr, `${what}: front wheels hang on steer pivots`);
    ok(ud.rearWheelL === ud.wheels.rl && ud.rearWheelR === ud.wheels.rr, `${what}: rear wheel refs`);
    ok(Array.isArray(ud.exhausts) && ud.exhausts.length >= 1, `${what}: exhausts`);
    ok(ud.antennaMount && ud.antennaMount.parent === ud.body && ud.antennaMount.position.z < 0, `${what}: antenna mount on the tail`);
    ok(ud.anim && typeof ud.anim === 'object' && (ud.animate === null || typeof ud.animate === 'function'), `${what}: anim parts + animate`);
    if (ud.animate) {
      for (const t of [0, 0.5, 3.3, 7.1]) { ud.animate(t, null); ud.animate(t + 0.01, fake); }
      let finite = true;
      m.traverse((o) => { for (const v of [o.position, o.rotation, o.scale]) if (![v.x, v.y, v.z].every(Number.isFinite)) finite = false; });
      ok(finite, `${what}: animate keeps transforms finite`);
    }
    let calls = 0, tris = 0;
    const paint = ud.tintMaterials[0];
    m.traverse((o) => {
      if (!o.isMesh) return;
      calls++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
      ok(finiteBox(g), `${what}: finite geometry (${o.name})`);
      ok(o.castShadow || o.name === 'glow', `${what}: ${o.name} casts a shadow`);
      ok(o.material === paint || ud.ownedMaterials.includes(o.material) || def.custom, `${what}: ${o.name} uses the kart's materials`);
    });
    ok(paint && ud.wheelMesh.material === paint && m.getObjectByName('chassis').material === paint &&
      (def.custom && def.model ? true : m.getObjectByName('torso').material === paint && ud.headMesh.material === paint), `${what}: one tint material for chassis/driver/wheels`);
    ok(paint.userData.slotColors[1].getHex() === new THREE.Color(def.kart.paint).getHex(), `${what}: kart painted in the racer's color`);
    ok(calls <= 6, `${what}: ${calls} draw calls (budget ~6)`);
    if (calls > maxCalls) { maxCalls = calls; maxCallsWhat = what; }
    if (tris > maxTris) { maxTris = tris; maxTrisWhat = what; }
    // driver height above the seat (model space, kart scale removed)
    m.updateMatrixWorld(true);
    box.setFromObject(ud.driver);
    const above = box.max.y / ud.kartScale - ud.driver.position.y;
    if (above > maxDriver) { maxDriver = above; maxDriverWhat = what; }
    ok(above < 1.2, `${what}: driver ${f2(above)} m above the seat`);
    const wr = ud.wheelRadius, wg = ud.wheelMesh.geometry.boundingBox;
    ok(near(ud.wheels.rl.position.y, wr.rear) && near(ud.steerPivots.fl.position.y, wr.front), `${what}: wheel centers at their radius`);
    ok(near(wr.rear * ud.wheels.fl.scale.x, wr.front), `${what}: front wheels are scaled rear wheels`);
    ok(wg.max.y >= wr.rear * (lod === 'low' ? 0.94 : 0.98) - 0.002 && wg.max.y <= wr.rear + 0.012 && near(wg.min.y, -wg.max.y, 0.002), `${what}: wheel geometry radius ${f2(wg.max.y)} vs ${f2(wr.rear)}`);
    const cb = m.getObjectByName('chassis').geometry.boundingBox;
    ok(cb.min.y >= -0.005, `${what}: chassis bottom ${cb.min.y.toFixed(3)} below ground`);
    const dp = ud.driver.position;
    ok(dp.y > 0.15 && Math.abs(dp.x) < 1e-6 && dp.z > cb.min.z && dp.z < cb.max.z, `${what}: driver inside the chassis`);
    for (const e of ud.exhausts) ok(e.position.z < ud.wheels.rl.position.z && e.position.y > 0.15, `${what}: exhaust behind the rear axle`);
    disposeKartModel(m);
    disposeKartModel(m);   // idempotent
    return failures === fail0;
  };
  for (const lod of ['high', 'low']) {
    for (const b of KART_BODIES) for (const w of WHEELS) {
      check(getCharacter('ballerina'), { body: b.id, wheels: w.id }, lod, `${b.id}/${w.id}/${lod}/ballerina`);
      check(getCharacter('bombardiro'), { body: b.id, wheels: w.id }, lod, `${b.id}/${w.id}/${lod}/bombardiro`);
    }
  }
  for (const c of CHARACTERS) {
    check(c, null, 'high', `${c.id} default`);
    check(c, CPU_PRESETS[c.weightClass][1], 'low', `${c.id} cpu preset low`);
  }
  // custom .glb racers (SPEC §14.9): a stand-in "loaded" scene, 2 m tall, off center
  const scene = new THREE.Group();
  const geo = new THREE.BoxGeometry(0.6, 2, 0.5);
  let geoDisposed = false;
  geo.addEventListener('dispose', () => { geoDisposed = true; });
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  mesh.position.set(3, 5, -1);
  scene.add(mesh);
  const regs = registerCustomCharacters([
    { id: 'robo_rex', name: 'Robo Rex', weightClass: 'heavy', color: '#3FD6B2', model: scene, scale: 1, yOffset: 0, rotationY: Math.PI },
    { id: 'blobby', name: 'Blobby', weightClass: 'light', color: '#ff00aa' },
    { id: 'sahur', name: 'Impostor', weightClass: 'medium', color: '#000000' },
    { id: 'Bad Id!', name: 'Nope', weightClass: 'medium', color: '#000000' },
  ]);
  ok(regs.length === 2 && getAllCharacters().length === 14 && getCharacter('robo_rex').custom === true && getCharacter('sahur').name === 'Tung Tung Tung Sahur', `custom racers registered (${regs.map((d) => d.id)})`);
  const robo = getCharacter('robo_rex');
  ok(robo.group === 'H1' && JSON.stringify(robo.ratings) === JSON.stringify(WEIGHT_GROUPS.H1.ratings) && robo.cssColor === '#3fd6b2' && robo.kart.paint === 0x3fd6b2, 'custom racer ratings/colors from its weight class + color');
  check(robo, null, 'high', 'custom robo_rex');
  check(getCharacter('blobby'), null, 'low', 'custom blobby (no model)');
  {
    const m = buildKartModel(robo);
    const cm = m.getObjectByName('customModel');
    m.updateMatrixWorld(true);
    box.setFromObject(cm);
    const h = (box.max.y - box.min.y) / m.userData.kartScale;
    const cx = (box.max.x + box.min.x) / 2;
    console.log(`custom model seated: height ${f2(h)} m, center x ${f2(cx)}, bottom ${f2(box.min.y)}`);
    ok(cm && Math.abs(h - 1) < 0.05 && Math.abs(cx) < 0.05, 'custom model normalized to ~1.0 m and centered on the seat');
    disposeKartModel(m);
    ok(!geoDisposed, "disposing a kart leaves the custom racer's loaded geometry alone");
  }
  const parsed = parseRacerIndex([
    { id: 'Robo', name: 'Robo', file: 'robo.glb', weightClass: 'heavy', color: '#123456', scale: 2 },
    { id: 'evil', file: '../secret.glb' }, { id: 'robo', file: 'dup.glb' }, { id: 'nofile' }, { id: 'pal', file: 'pal.glb', weightClass: 'huge' },
  ], ['sahur']);
  ok(parsed.length === 2 && parsed[0].id === 'robo' && parsed[0].scale === 2 && parsed[1].weightClass === 'medium' && parsed[1].color === '#8a8f99',
    `index.json validation (${parsed.map((e) => e.id)})`);
  registerCustomCharacters([]);
  ok(getAllCharacters().length === 12 && getCharacter('robo_rex').id === 'sahur', 'registerCustomCharacters([]) clears the custom set');

  // ride height follows the wheel size
  const ride = (w) => { const m = buildKartModel(getCharacter('sahur'), { loadout: { wheels: w } }); const r = { lift: m.userData.lift, rr: m.userData.wheelRadius.rear, y: m.userData.driver.position.y }; disposeKartModel(m); return r; };
  const rs = ride('standard'), rm = ride('monster'), rt = ride('tiny');
  console.log(`ride height: standard lift ${f2(rs.lift)} seat ${f2(rs.y)} | monster lift ${f2(rm.lift)} seat ${f2(rm.y)} r ${f2(rm.rr)} | tiny lift ${f2(rt.lift)} seat ${f2(rt.y)} r ${f2(rt.rr)}`);
  ok(rs.lift === 0 && rm.lift > 0.1 && rt.lift < -0.05 && rm.y > rs.y && rt.y < rs.y && rm.rr > rs.rr && rt.rr < rs.rr, 'monster wheels raise, mini rollers lower the kart');
  const info = kartModelCacheInfo();
  console.log(`built ${built} models | max draw calls ${maxCalls} (${maxCallsWhat}) | max triangles ${maxTris} (${maxTrisWhat}) | tallest driver ${f2(maxDriver)} m (${maxDriverWhat}) | cache ${JSON.stringify(info)}`);
  ok(info.live === 0 && info.refs === 0 && info.idle <= info.idleLimit, 'all models released; idle cache bounded');
  ok(maxTris < 20000, `heaviest kart ${maxTris} triangles (8 karts must stay well under the 400k scene budget)`);
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} (${failures} failures)`);
process.exit(failures ? 1 : 0);
