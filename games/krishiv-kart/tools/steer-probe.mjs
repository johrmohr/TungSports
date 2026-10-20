// Steering probe (SPEC §14.3e): how often does a casual phone-tilt driver hit
// the walls, with Steer Assist ON vs OFF, on every track? Plus the expert
// autopilot lap check (assist must not slow good drivers down).
//
//   node tools/steer-probe.mjs [--track <id>|all] [--cc 150] [--seeds 8] [--quick] [--where] [--v3]
//        [--set KART_TUNE.k=v,ASSIST_TUNE.k=v,pad.lock=v,pad.dead=v,pad.expo=v,pad.lpf=v,pad.knee=v,pad.cap=v]
//
// --where also prints where the casual drivers hit the walls (per track segment).
// --set overrides tuning for what-if runs (game code untouched); --v3 runs the v3
// phone curve (pad.knee=1, pad.cap=1: expo up to full authority) for A/B.
//
// Casual tilt model (after notes/research-steering-feel.md §4.2): the driver
// looks 6 m + 0.5 s ahead at half the racing line and turns the phone K degrees
// per radian of aim error (K swept over 30/45/60/90/130: people turn the wheel
// differently). Their eyes lag 0.25 s with no anticipation, the wrist 80 ms;
// 0.6 deg of 9 Hz tremor and a slow 2.5 deg wander are added. The angle then
// goes through the phone mapping (pad.js's own shapeSteer and low-pass, extracted
// from public/js/pad.js: dead zone, expo centre, soft knee into the steering lock,
// SPEC §15.1), ~40 ms of network, into the real kart. No drifting, auto-gas.
// Gates: <= 0.5 wall hits/lap with the assist ON, <= 4.5 OFF.
//
// Steering lock check (SPEC §15.1, flat plane, M2 at this class's top speed):
// the steady yaw rate at full phone tilt vs the kart's full turn authority
// (keyboard / CPU full lock, unchanged), and a large tilt step (casual wrist to
// 60° for 0.4 s, back to centre) vs a small one (10°) for this build and the v3
// curve. Gates: phone lock <= 0.85 × full authority; 60° step swing <= 0.9 × v3;
// 10° step within 5 % of v3 (small adjustments feel the same).
//
// Expert check: the karts-autopilot on identical stats (150cc, Classic +
// Standard): plain (no-drift) laps with the assist ON and OFF within +-0.3 s
// of each other and of the pre-v3 physics baseline (Breezy Bay). Drift laps
// are printed against the baseline for reference only: the v3 drift rules
// (x1.2 mini-turbos, slow charge unless the wheel is held into the turn,
// SPEC §14.3c) deliberately change them, and the assist's steering nudge can
// help the bot's drift line through a hairpin a little.
// Exit code 1 when a gate fails.

import fs from 'node:fs';
import { Kart, KART_TUNE, ASSIST_TUNE } from '../public/js/kart.js';
import { TRACK_LIST, getTrack } from '../public/js/tracks.js';
import { WEIGHT_GROUPS, statsFromRatings, getEngineClass } from '../public/js/parts.js';
import { bus } from '../public/js/bus.js';
import { clamp, damp, angleDiff, makeRng } from '../public/js/utils.js';
import { Autopilot } from '../public/dev/karts-autopilot.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; };
const QUICK = args.includes('--quick');
const WHERE = args.includes('--where');
const CC = Number(opt('cc', 150));
const CC_MULT = getEngineClass(CC).mult;
const SEEDS = Array.from({ length: Number(opt('seeds', QUICK ? 3 : 8)) }, (_, i) => i + 1);
const GAINS = QUICK ? [45, 90] : [30, 45, 60, 90, 130];
const GROUPS = QUICK ? ['M2'] : ['L1', 'M2', 'H2'];
const LAPS = 2;
const GATE = { assistOn: 0.5, assistOff: 4.5, expert: 0.3, lockShare: 0.85, step60: 0.9, step10: 0.05 };

// Pre-v3 physics (v2 kart.js, karts-autopilot, parts.js stats, 150cc) on Breezy
// Bay with the widened Bay Bridge: 2nd-lap times without drifting.
// Measured on the v3 layout (977.9 m): applied only while the course still has
// that length (v5 lengthened Breezy to 1387 m, research-v5-tracks.md D2 — the
// expert check then keeps the assist ON-vs-OFF comparison only).
const V2_PLAIN = { breezy: { L1: 32.18, L2: 31.95, M1: 31.76, M2: 31.82, H1: 31.67, H2: 31.54 } };
const V2_DRIFT = { breezy: { L1: 30.79, L2: 30.23, M1: 30.11, M2: 30.11, H1: 29.83, H2: 29.91 } };
const V2_LAYOUT_LENGTH = { breezy: 977.92 };

const CASUAL = { delay: 0.25, predict: 0, wander: 2.5, tremor: 0.6, wristTau: 0.08, net: 0.04, look: 6, lookK: 0.5, line: 0.5 };
// The phone mapping is pad.js's own: its top-level numeric constants and its
// shapeSteer() (plus any top-level helper it calls) are read from public/js/pad.js.
const PAD_SRC = fs.readFileSync(new URL('../public/js/pad.js', import.meta.url), 'utf8');
const PAD_CONSTS = {};
for (const m of PAD_SRC.matchAll(/^const ([A-Z][A-Z0-9_]*)\s*=\s*([^;\n]+);/gm)) {
  try {
    const names = Object.keys(PAD_CONSTS);
    const v = Function(...names, `"use strict"; return (${m[2]});`)(...names.map((n) => PAD_CONSTS[n]));
    if (typeof v === 'number' && Number.isFinite(v)) PAD_CONSTS[m[1]] = v;
  } catch { /* not a plain numeric constant */ }
}
for (const k of ['DEAD_ZONE_DEG', 'LOCK_DEFAULT_DEG', 'EXPO', 'STEER_LPF_RATE']) if (!(k in PAD_CONSTS)) throw new Error(`steer-probe: pad.js constant ${k} not found`);
function padFunction(name) {
  const i = PAD_SRC.indexOf(`function ${name}(`);
  if (i < 0) return null;
  for (let k = PAD_SRC.indexOf('{', i), depth = 0; k < PAD_SRC.length; k++) {
    if (PAD_SRC[k] === '{') depth++;
    else if (PAD_SRC[k] === '}' && --depth === 0) return PAD_SRC.slice(i, k + 1);
  }
  return null;
}
const SHAPE_SRC = padFunction('shapeSteer');
if (!SHAPE_SRC) throw new Error('steer-probe: shapeSteer() not found in public/js/pad.js');
const PAD_HELPERS = [];
{
  const top = [...PAD_SRC.matchAll(/^function ([A-Za-z_$][\w$]*)\(/gm)].map((x) => x[1]);
  const seen = new Set(['shapeSteer']);
  const scan = (code) => { for (const n of top) if (!seen.has(n) && new RegExp(`\\b${n}\\(`).test(code)) { seen.add(n); const h = padFunction(n); if (h) { PAD_HELPERS.push(h); scan(h); } } };
  scan(SHAPE_SRC);
}
const PAD = {
  dead: PAD_CONSTS.DEAD_ZONE_DEG, lock: PAD_CONSTS.LOCK_DEFAULT_DEG, expo: PAD_CONSTS.EXPO, lpf: PAD_CONSTS.STEER_LPF_RATE,
  knee: PAD_CONSTS.STEER_KNEE ?? 1, cap: PAD_CONSTS.STEER_CAP ?? 1,
};
for (const kv of (opt('set', '') || '').split(',').filter(Boolean)) {
  const m = kv.match(/^(KART_TUNE|ASSIST_TUNE|pad)\.([A-Za-z0-9_]+)=(.+)$/);
  if (!m) { console.error(`bad --set entry '${kv}'`); process.exit(2); }
  ({ KART_TUNE, ASSIST_TUNE, pad: PAD })[m[1]][m[2]] = Number(m[3]);
}
if (args.includes('--v3')) { PAD.knee = 1; PAD.cap = 1; }
const FR = 1 / 60;

// pad.js's shapeSteer(deg, lockDeg) with the (possibly overridden) constants.
function makeShape(over = {}) {
  const env = { ...PAD_CONSTS, DEAD_ZONE_DEG: PAD.dead, EXPO: PAD.expo, STEER_KNEE: PAD.knee, STEER_CAP: PAD.cap, ...over };
  const names = Object.keys(env);
  const body = `"use strict";\n${PAD_HELPERS.join('\n')}\nreturn (${SHAPE_SRC});`;
  const fn = Function(...names, 'clamp', 'damp', body)(...names.map((n) => env[n]), clamp, damp);
  return (deg) => fn(deg, PAD.lock);
}
const padShape = makeShape();
const padShapeV3 = makeShape({ STEER_KNEE: 1, STEER_CAP: 1 });

function probeKart(track, group, assist) {
  const g = WEIGHT_GROUPS[group];
  const character = { id: `probe-${group}`, name: group, ratings: g.ratings, weightClass: g.weightClass };
  const k = new Kart({ id: character.id, character, track, isPlayer: true, ccMult: CC_MULT, steerAssist: assist });
  k.placeOnGrid(track.gridSlot(7));
  return k;
}

// Track segment index at arc length s.
function segmentAt(track, s) {
  const a = track.segStartS;
  let i = a.length - 1;
  while (i > 0 && a[i] > s) i--;
  return i;
}

// One casual tilt run: { walls, laps: [s], done, assistTime }. Wall hits are
// tallied per track segment into `where` (if given).
function casualRun(track, group, K, seed, assist, where = null) {
  const M = CASUAL, L = track.length;
  const rng = makeRng(seed * 977 + 13);
  const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rng(); return (u - 3) / Math.sqrt(0.5); };
  const k = probeKart(track, group, assist);
  let walls = 0, t = 0, assistTime = 0;
  const off = bus.on('kart:wallHit', (e) => {
    if (e.kart !== k) return;
    walls++;
    if (where) { const i = segmentAt(track, k.proj.s); where[i] = (where[i] || 0) + 1; }
  });
  let prevS = k.proj.s, dist = track.deltaS(0, prevS), lapStart = 0;
  const laps = [];
  const hist = [];
  const netQ = [];
  let wrist = 0, wander = 0, padSteer = 0, hostSteer = 0;
  const pt = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
  while (laps.length < LAPS && t < 300) {
    const s = k.proj.s, Ld = M.look + M.lookK * Math.max(0, k.speed);
    const fi = track.indexAt(s + Ld);
    track.pointAt(s + Ld, track.racingLine[fi] * M.line, pt);
    const aim = angleDiff(k.yaw, Math.atan2(pt.x - k.position.x, pt.z - k.position.z));   // + = target LEFT
    hist.push({ t, a: aim });
    while (hist.length > 2 && hist[1].t <= t - M.delay) hist.shift();
    const seen = hist[0].a;
    const cmd = clamp(-K * seen, -75, 75);                          // wheel degrees the hands aim for
    wrist += (cmd - wrist) * (1 - Math.exp(-FR / M.wristTau));
    wander += -wander * FR + M.wander * Math.sqrt(2 * FR) * gauss();
    const deg = wrist + wander + M.tremor * Math.SQRT2 * Math.sin(2 * Math.PI * 9 * t + seed);
    padSteer = damp(padSteer, padShape(deg), PAD.lpf, FR);
    netQ.push({ t: t + M.net + rng() * 0.012, v: padSteer });
    while (netQ.length && netQ[0].t <= t) hostSteer = netQ.shift().v;
    k.input.steer = hostSteer; k.input.throttle = 1; k.input.brake = 0; k.input.drift = false;
    for (let i = 0; i < 2; i++) { k.update(FR / 2); if (k.assist > 0) assistTime += FR / 2; }
    t += FR;
    const s2 = k.proj.s;
    dist += track.deltaS(prevS, s2); prevS = s2;
    if (Math.floor(dist / L) > laps.length) { laps.push(t - lapStart); lapStart = t; }
  }
  off();
  return { walls, laps, done: laps.length >= LAPS, assistTime, t };
}

// Expert autopilot: 2nd-lap time + wall hits.
function expertRun(track, group, drift, assist) {
  const g = WEIGHT_GROUPS[group];
  const character = { id: `expert-${group}`, name: group, ratings: g.ratings, weightClass: g.weightClass };
  const k = new Kart({ id: character.id, character, track, isPlayer: true, steerAssist: assist });
  Object.assign(k.stats, statsFromRatings(g.ratings));               // 150cc, standard parts
  k.placeOnGrid(track.gridSlot(0));
  const ap = new Autopilot(k, { drift });
  const DT = 1 / 120, L = track.length;
  let t = 0, prevS = k.proj.s, dist = track.deltaS(0, prevS), lapStart = 0, walls = 0;
  const laps = [];
  const off = bus.on('kart:wallHit', (e) => { if (e.kart === k) walls++; });
  while (laps.length < 2 && t < 200) {
    ap.update(DT);
    k.update(DT);
    t += DT;
    const s = k.proj.s; dist += track.deltaS(prevS, s); prevS = s;
    if (dist >= (laps.length + 1) * L) { laps.push(t - lapStart); lapStart = t; }
  }
  off();
  return { lap: laps[1], walls, maxTier: ap.maxTier };
}

const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '  -  ');
const which = opt('track', 'all');
const ids = which === 'all' ? TRACK_LIST.map((t) => t.id) : [which];
let failed = 0;
const fail = (msg) => { failed++; console.log(`  FAIL: ${msg}`); };

// ---- steering lock (SPEC §15.1): flat plane, no walls, M2 at this class's top speed
const RAD = 180 / Math.PI;
function flatTrack() {
  const big = 1e5, N = 64;
  const v3 = (x, y, z) => ({ x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } });
  return {
    id: 'flat', N, spacing: 1, length: 1e9, ramps: [], boostPads: [],
    wr: new Float32Array(N).fill(big), wl: new Float32Array(N).fill(big),
    deltaS: (a, b) => b - a, wrapS: (x) => x, forwardDistance: (a, b) => b - a,
    project(pos, hint, out = {}) {
      Object.assign(out, { index: 0, f: 0, s: pos.z, lateral: -pos.x, centerY: 0, height: 0, onRamp: false, halfWidth: big, wallL: big, wallR: big, curvature: 0, slope: 0, yaw: 0, surface: 'road', boostPad: null });
      out.tangent = out.tangent || v3(0, 0, 1); out.right = out.right || v3(-1, 0, 0);
      return out;
    },
    frameAt(x, out = {}) { return Object.assign(out, { index: 0, s: x, yaw: 0, halfWidth: big, wallL: big, wallR: big, racingLine: 0, curvature: 0, slope: 0 }); },
    pointAt(x, lat = 0, out = v3(0, 0, 0)) { return out.set(-lat, 0, x); },
  };
}
function flatKart() {
  const tr = flatTrack(), g = WEIGHT_GROUPS.M2;
  const k = new Kart({ id: 'probe-lock', character: { id: 'probe-lock', name: 'M2', ratings: g.ratings, weightClass: g.weightClass }, track: tr, isPlayer: true, ccMult: CC_MULT });
  k.position.set(0, 0, 0); k.yaw = 0; k._resetState();
  tr.project(k.position, -1, k.proj); k.hint = 0;
  k.velocity.set(0, 0, k.stats.topSpeed);
  return k;
}
// Steady yaw rate (°/s) holding `steer` at top speed.
function steadyYaw(steer) {
  const k = flatKart();
  let acc = 0, py = k.yaw;
  for (let i = 0; i < 480; i++) {
    k.input.steer = steer; k.input.throttle = 1; k.input.drift = false; k.update(1 / 120);
    if (i >= 240) acc += angleDiff(py, k.yaw);
    py = k.yaw;
  }
  return (Math.abs(acc) / 2) * RAD;
}
// Casual wrist (first order, CASUAL.wristTau) to `deg` for 0.4 s and back: heading swing (deg).
function stepSwing(shape, deg) {
  const k = flatKart();
  let wrist = 0, padSteer = 0, t = 0, acc = 0, py = k.yaw;
  const q = [];
  while (t < 2.4) {
    const cmd = t >= 0.2 && t < 0.6 ? deg : 0;
    wrist += (cmd - wrist) * (1 - Math.exp(-FR / CASUAL.wristTau));
    padSteer = damp(padSteer, shape(wrist), PAD.lpf, FR);
    q.push({ t: t + CASUAL.net, v: Math.round(padSteer * 1000) / 1000 });
    while (q.length && q[0].t <= t + 1e-9) k.input.steer = q.shift().v;
    k.input.throttle = 1;
    for (let i = 0; i < 2; i++) k.update(FR / 2);
    acc += angleDiff(py, k.yaw); py = k.yaw;
    t += FR;
  }
  return -acc * RAD;
}
{
  const full = steadyYaw(1), lockNow = steadyYaw(padShape(PAD.lock + 10)), lockV3 = steadyYaw(padShapeV3(PAD.lock + 10));
  const st = (shape) => Object.fromEntries([10, 30, 60].map((d) => [d, stepSwing(shape, d)]));
  const sNow = st(padShape), sV3 = st(padShapeV3);
  console.log(`steering lock @${CC}cc (M2, top speed, flat): full authority (keyboard / CPU) ${full.toFixed(0)}°/s | phone at/after the ${PAD.lock}° lock: steer ${f2(padShape(PAD.lock + 10))} -> ${lockNow.toFixed(0)}°/s (v3 curve ${lockV3.toFixed(0)}°/s)`);
  console.log(`  casual tilt step (0.4 s): heading swing 10° ${f2(sNow[10])}° / 30° ${f2(sNow[30])}° / 60° ${f2(sNow[60])}°  (v3 curve: ${f2(sV3[10])}° / ${f2(sV3[30])}° / ${f2(sV3[60])}°)`);
  if (!(lockNow <= GATE.lockShare * full)) fail(`phone full lock ${lockNow.toFixed(0)}°/s > ${GATE.lockShare} × full authority ${full.toFixed(0)}°/s (no steering lock)`);
  if (!(sNow[60] <= GATE.step60 * sV3[60])) fail(`60° tilt step swings ${f2(sNow[60])}° > ${GATE.step60} × v3 ${f2(sV3[60])}°`);
  if (!(Math.abs(sNow[10] / sV3[10] - 1) <= GATE.step10)) fail(`10° tilt step ${f2(sNow[10])}° vs v3 ${f2(sV3[10])}°: small adjustments changed by more than ${GATE.step10 * 100}%`);
}

for (const id of ids) {
  const track = getTrack(id);
  console.log(`\n== ${track.name} (${id}, ${track.length.toFixed(0)} m) — casual tilt @${CC}cc, gains ${GAINS.join('/')}, ${SEEDS.length} seeds x ${LAPS} laps`);
  const where = { true: {}, false: {} };
  for (const group of GROUPS) {
    const res = {};
    for (const assist of [true, false]) {
      let walls = 0, laps = 0, lapSum = 0, nLap = 0, dnf = 0, aT = 0, T = 0;
      for (const K of GAINS) for (const seed of SEEDS) {
        const r = casualRun(track, group, K, seed, assist, where[assist]);
        walls += r.walls; laps += LAPS; aT += r.assistTime; T += r.t;
        if (!r.done) dnf++;
        for (const x of r.laps.slice(1)) { lapSum += x; nLap++; }
      }
      res[assist] = { wpl: walls / laps, lap: nLap ? lapSum / nLap : NaN, dnf, lit: (100 * aT) / T };
    }
    const on = res[true], off = res[false];
    console.log(`  ${group}: assist ON ${f2(on.wpl)} walls/lap, lap ${f2(on.lap)} s, antenna lit ${on.lit.toFixed(0)}% | OFF ${f2(off.wpl)} walls/lap, lap ${f2(off.lap)} s${on.dnf + off.dnf ? ` | DNF ${on.dnf}/${off.dnf}` : ''}`);
    if (!(on.wpl <= GATE.assistOn)) fail(`${id}/${group}: ${f2(on.wpl)} wall hits/lap with the assist ON (gate ${GATE.assistOn})`);
    if (!(off.wpl <= GATE.assistOff)) fail(`${id}/${group}: ${f2(off.wpl)} wall hits/lap with the assist OFF (gate ${GATE.assistOff})`);
    if (on.dnf + off.dnf) fail(`${id}/${group}: ${on.dnf + off.dnf} casual runs did not finish`);
  }

  if (WHERE) {
    for (const assist of [true, false]) {
      const list = Object.entries(where[assist]).sort((a, b) => b[1] - a[1])
        .map(([i, n]) => `${(track.segments[i] && track.segments[i].name) || `seg ${i}`} ${n}`);   // (path-mode tracks: derived segments)
      console.log(`  wall hits by segment, assist ${assist ? 'ON' : 'OFF'}: ${list.join(', ') || 'none'}`);
    }
  }
  console.log(`  expert autopilot (150cc stats, lap 2):`);
  for (const group of QUICK ? ['M2'] : Object.keys(WEIGHT_GROUPS)) {
    const line = [];
    for (const drift of [false, true]) {
      const a = expertRun(track, group, drift, false), b = expertRun(track, group, drift, true);
      const base = drift ? V2_DRIFT : V2_PLAIN;
      const v2 = base[id] && Math.abs(track.length - (V2_LAYOUT_LENGTH[id] ?? track.length)) < 1 ? base[id][group] : null;
      line.push(`${drift ? 'drift' : 'plain'} off ${f2(a.lap)} on ${f2(b.lap)}${v2 ? ` (v2 ${f2(v2)})` : ''} walls ${a.walls}/${b.walls} tier ${a.maxTier}/${b.maxTier}`);
      if (!drift && !(Math.abs(b.lap - a.lap) <= GATE.expert)) fail(`${id}/${group} plain: assist changes the expert lap by ${f2(b.lap - a.lap)} s`);
      if (!drift && v2 && !(Math.abs(a.lap - v2) <= GATE.expert && Math.abs(b.lap - v2) <= GATE.expert)) fail(`${id}/${group} plain: ${f2(a.lap - v2)} / ${f2(b.lap - v2)} s vs the pre-v3 physics`);
      if (a.walls || b.walls) fail(`${id}/${group} ${drift ? 'drift' : 'plain'}: expert hits walls (${a.walls}/${b.walls})`);
    }
    console.log(`    ${group}: ${line.join(' | ')}`);
  }
}
console.log(failed ? `\nSTEER PROBE: FAIL (${failed})` : '\nSTEER PROBE: PASS');
process.exit(failed ? 1 : 0);
