// Drift probe: how does drifting (and plain steering) feel to a PHONE player?
//
//   node tools/drift-probe.mjs [--track <id>|all] [--assist on|off|both]
//        [--style s60,s80,s100,follow,panic,kbd,cruise,bot,r100,r120,efollow,kbdr,…,sNN,aNN,nNN|drift|exit|all|every]
//        [--char light,medium,heavy|all|<id>|<group>]
//        [--cc 50|100|150] [--seeds 3] [--laps 2] [--lock 42] [--min-angle 45] [--set KEY=V,KEY=V] [--v3]
//        [--kin] [--no-kin] [--flat] [--no-flat] [--no-corners] [--by-corner] [--detail] [--brief] [--json out.json]
//        [--trace run.csv] [--gate spin=10,over=30,wallsPerLap@r100:on=0.3,step60=33,...] [--quick]
//
// v4 gate (SPEC §15.1; assist ON, 100 and 150cc):
//   --assist on --gate spin=0,over=30,cxl=5,wrong=15,miss=12,mt=35,wall=5,cruiseYaw=20,step60=33,stepYaw60=78,
//     stepRatio=2.5,step10=5,exitPath6=15,exitYaw15=40,wallsPerLap@r100=0.3,wallsPerLap@r120=0.3,
//     exitIn@r100=3,exitIn@r120=3,exitOut@efollow=1
//
// Everything runs on the REAL game code: Track (tracks.js), Kart physics + Steer
// Assist (kart.js), parts.js stats, the host's PadInput (input.js), the chase
// camera's heading (camera.js) and the kart view's extra drift yaw (kartview.js
// VIEW_TUNE). The phone pipeline is public/js/pad.js's: its top-level numeric
// constants, shapeSteer() and any top-level helpers it calls are read from
// pad.js at startup (a re-tuned pad.js is picked up automatically), and its
// 60 Hz tick is mirrored exactly:
//   wheel angle θ (deg) − calibration (0: auto-centred) → shapeSteer (dead zone,
//   full lock, expo) → damp(steer, target, STEER_LPF_RATE, dt) → round 0.001 → net.
// A WARNING is printed if pad.js's tick no longer looks like that mirror.
// (Held like a wheel, pad.js's θ is the true in-plane rotation of the phone, so
// the hands' wheel angle is fed in directly.)
//
// Phone player model (one kart, auto-gas, no CPUs/items). The aim error is the
// bearing of a look-ahead point (6 m + 0.5 s, half the racing line) relative to
// the kart's nose (human.percept=1: the chase camera heading, 2: the travel
// direction). Hands act on what was seen `delay` (+30 ms display) ago with a
// little anticipation; the wrist is a 2nd-order system (overshoot from its
// damping ratio), plus 0.6° 9 Hz tremor, a slow 1.5° wander and 0.2° sensor
// noise. Phone ticks at 60 Hz with jitter; ~40 ms (+0-15 ms) network; the host
// runs 60 fps frames of 2 × 1/120 s physics substeps (main.js).
// Styles (gain K deg of wheel per rad of aim error differs per seed: 45 / 65 / 90,
// so always compare runs with the same --seeds):
//   cruise  never drifts; weaving on straights + corner tracking.
//   s60/s80/s100  phone drifter: at each corner (arcs ≥ --min-angle) the into-turn
//           tilt starts ~0.25 s before the corner, DRIFT is pressed 0-0.12 s
//           later and held to the corner end while the phone is held INTO the
//           turn at 60/80/100 % of the full-lock angle (open loop).
//   follow  drifter whose tilt follows the curve: closed loop on what it sees
//           (180 ms reaction, underdamped wrist ζ 0.45 → ~20 % overshoot).
//   panic   yanks the phone to 150 % of lock into the turn for 0.45 s, then
//           over-corrects (gain ×2.2, 250 ms reaction, ζ 0.35).
//   sNN / aNN  any other hold: NN % of the lock angle / NN degrees of tilt (e.g. s40, a25).
//   nNN     the same NN % hold into every drift corner WITHOUT pressing DRIFT (reference:
//           what the same hands do with plain steering; compare wl/lap).
//   kbd     keyboard drifter (no phone): the real Input class (input.js key ramp
//           7/s, return 10/s) with ↑ held; arrows bang-bang on the seen aim error
//           (dead band 0.05 rad, same eyes as the phone player). At each drift corner
//           it holds the arrow into the turn from the decision through the hop
//           (0.4 s), presses SPACE like the phone drifters, then in the drift
//           holds the into-turn arrow, nothing, or the counter arrow by the error.
//   bot     reference: the dev Autopilot (public/dev/karts-autopilot.js) drives
//           with perfect inputs (no phone) and drifts the corners it likes.
//   drift exits (SPEC §15.1; `exit` = r100,r120,er100,efollow,kbdr; `every` = all styles):
//   r80/r100/r120  sNN drifter whose hands keep the drift tilt 0.3 s after letting go of DRIFT
//   er100   r100 that releases 70 % into the corner;  e80/e100  s80/s100 releasing 60 % in
//   efollow `follow` releasing 60 % into the corner (the corner continues after the release)
//   kbdr    `kbd` holding the into-turn arrow through the drift and 0.25 s past the release; kbdi: no post hold
// Drifters cruise like `cruise` between corners. `all` = the classic styles + r100, r120, efollow, kbdr.
//
// Per drift (released taps < 0.15 s ignored): duration, nose rotation vs the
// road's direction change over the drift (over = nose − road at release, + =
// over-rotated into the turn; a well-held drift ends at about its slip angle),
// peak over-rotation, max slip (nose vs velocity), max nose deviation from the
// track tangent, max on-screen kart angle (model yaw incl. kartview's extra
// drift yaw vs the camera heading), spin-outs (nose > 90° off the road or moving
// backwards, drift + 1.5 s), wall hits (drift + 1 s), mini-turbo tier, cancels
// (and why), min speed, wrong-direction drifts (and whether the direction came
// from the steer at the DRIFT press or at landing), and with Steer Assist ON
// how much the assist added INTO the turn (mean (assisted − player)·dir).
// After the release (EXIT table): steer and yaw rate into the old turn at the
// release and their peak in the next second, path / nose swing into the old turn
// 0.3/0.6/1 s after it, inside drift (m), inside-edge approaches and inside /
// outside wall hits within 1 s (in% / out%). A FLAT section (before the tracks)
// runs the tilt-step and drift-exit tests on a flat plane for this build and
// the v3 baseline (see FLAT_GATES). --v3 runs everything as v3 (no knee / cap,
// no exit latch) for A/B.
// Also: a flat-plane kinematics table (real Kart, steady state), the tilt →
// yaw-rate gain, and a corner-fit table (which wheel position x = steer·dir a
// drift needs per corner, from measured ω(x)). OVERALL = mean over tracks ×
// characters per style and assist setting; --gate applies limits to it
// (keys spin over peak around wall exit cxl wrong miss screen wallsPerLap exitIn
// exitOut exitPath, mt = a minimum MT%, cruiseYaw cruiseSteer cruiseRev cruiseWalls;
// key@style and key:on|off narrow a key; flat keys step60 stepYaw60 stepRatio
// step10 exitPath6 exitYaw15) and exits 1 on failure.
//
// --set overrides tuning for what-if runs without touching game code:
//   KART_TUNE.<k>, DRIFT.<k>, KART.<k>, ASSIST_TUNE.<k>, VIEW.<k> (kartview
//   VIEW_TUNE), CAM.<k> (chase camera params), pad.lock|dead|expo|lpf,
//   human.<k> (see HUMAN below; lists as a/b/c).  e.g. --set KART_TUNE.driftTight=1.0,pad.lock=40
// --json writes { config, kinematics, corners, rows, overall, drifts } for the tuner / verifier.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Kart, KART_TUNE, ASSIST_TUNE } from '../public/js/kart.js';
import { KART, DRIFT } from '../public/js/config.js';
import { TRACK_LIST, getTrack } from '../public/js/tracks.js';
import { CHARACTERS, getCharacter } from '../public/js/characters.js';
import { WEIGHT_GROUPS, getEngineClass, DEFAULT_CC } from '../public/js/parts.js';
import { bus } from '../public/js/bus.js';
import { clamp, lerp, damp, angleDiff, makeRng } from '../public/js/utils.js';
import { ChaseCamera } from '../public/js/camera.js';
import { VIEW_TUNE, driftSlideTarget } from '../public/js/kartview.js';
import { PadInput, Input } from '../public/js/input.js';
import { Autopilot } from '../public/dev/karts-autopilot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAD = 180 / Math.PI;
const FRAME = 1 / 60;          // host frame (main.js: 2 substeps of PHYS.maxSubstep 1/120)
const SUB = 2;

// ------------------------------------------------------------------ CLI

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);
const QUICK = flag('quick');

const ALL_STYLES = ['cruise', 's60', 's80', 's100', 'follow', 'panic', 'kbd', 'bot', 'r80', 'r100', 'r120', 'er100', 'e80', 'e100', 'efollow', 'kbdr', 'kbdi'];
const DEFAULT_STYLES = ['cruise', 's60', 's80', 's100', 'follow', 'panic', 'kbd', 'bot', 'r100', 'r120', 'efollow', 'kbdr'];
const DRIFT_STYLES = ['s60', 's80', 's100', 'follow', 'panic', 'kbd'];
const EXIT_STYLES = ['r100', 'r120', 'er100', 'efollow', 'kbdr'];   // drift exits with slow hands / mid-corner releases (SPEC §15.1)
const CHAR_ALIAS = { light: 'cappuccino', medium: 'sahur', heavy: 'gusini' };   // L1 / M2 / H2

function listOpt(v, all, aliases = {}) {
  if (!v || v === 'all') return all;
  return v.split(',').flatMap((x) => aliases[x] || [x]);
}

const CFG = {
  tracks: listOpt(opt('track', 'all'), TRACK_LIST.map((t) => t.id)),
  assist: { on: [true], off: [false], both: [true, false] }[opt('assist', 'both')] || [true, false],
  styles: listOpt(opt('style', QUICK ? 's100,follow,cruise,r100' : 'all'), DEFAULT_STYLES, { drift: DRIFT_STYLES, exit: EXIT_STYLES, every: ALL_STYLES }),
  chars: listOpt(opt('char', QUICK ? 'medium' : 'all'), ['light', 'medium', 'heavy']),
  cc: Number(opt('cc', DEFAULT_CC)),
  seeds: Number(opt('seeds', QUICK ? 1 : 3)),
  laps: Number(opt('laps', 2)),
  minAngle: Number(opt('min-angle', 45)),
  kin: flag('kin') ? 'only' : flag('no-kin') ? 'no' : 'yes',
  corners: !flag('no-corners'),
  byCorner: flag('by-corner'),
  detail: flag('detail'),
  json: opt('json', null),
  trace: opt('trace', null),
  brief: flag('brief'),             // only the OVERALL table
  gate: opt('gate', null),          // pass/fail limits on the OVERALL rows + the flat steering tests (exit 1 on failure)
  flat: flag('flat') ? 'only' : flag('no-flat') ? 'no' : 'yes',   // flat-plane tilt-step + drift-exit tests (SPEC §15.1)
  v3: flag('v3'),                   // A/B baseline: the v3 phone curve (no knee / cap) and no drift-exit latch
};
for (const s of CFG.styles) if (!ALL_STYLES.includes(s) && !/^[asn]\d+$/.test(s)) { console.error(`unknown style '${s}' (${ALL_STYLES.join(', ')}, sNN = hold NN % of lock, aNN = hold NN degrees)`); process.exit(2); }
for (const t of CFG.tracks) if (!TRACK_LIST.some((x) => x.id === t)) { console.error(`unknown track '${t}'`); process.exit(2); }
const CC_MULT = getEngineClass(CFG.cc).mult;

// Resolve a --char entry: alias, character id or weight group id.
const GROUP_ALIAS = { light: 'L1', medium: 'M2', heavy: 'H2' };
function resolveChar(x) {
  const id = CHAR_ALIAS[x] || x;
  const c = CHARACTERS.find((ch) => ch.id === id);
  if (c) return { key: x, def: c };
  const group = WEIGHT_GROUPS[x] ? x : GROUP_ALIAS[x];
  if (group) {
    // the cast may change (characters.js): any racer of that weight group, else the group's stats
    const ch = CHARACTERS.find((h) => h.group === group);
    if (ch) return { key: x, def: ch };
    const g = WEIGHT_GROUPS[group];
    return { key: x, def: { id: `probe-${group}`, name: group, shortName: group, group, ratings: { ...g.ratings }, weightClass: g.weightClass } };
  }
  console.error(`unknown character '${x}'`); process.exit(2);
}
const CHARS = CFG.chars.map(resolveChar);

// ------------------------------------------------------------------ phone pipeline (pad.js)

const PAD_FILE = path.join(ROOT, 'public/js/pad.js');

function extractFunction(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  let j = src.indexOf('{', i), depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  return null;
}

function loadPadSource() {
  const src = fs.readFileSync(PAD_FILE, 'utf8');
  const consts = {};
  const re = /^const ([A-Z][A-Z0-9_]*)\s*=\s*([^;\n]+);/gm;
  let m;
  while ((m = re.exec(src))) {
    try {
      const names = Object.keys(consts);
      const v = Function(...names, `"use strict"; return (${m[2]});`)(...names.map((n) => consts[n]));
      if (typeof v === 'number' && Number.isFinite(v)) consts[m[1]] = v;
    } catch { /* not a plain numeric constant */ }
  }
  const fnSrc = extractFunction(src, 'shapeSteer');
  if (!fnSrc) throw new Error('drift-probe: shapeSteer() not found in public/js/pad.js — update the probe');
  // top-level helper functions shapeSteer calls (recursively), e.g. a new curve function
  const topFns = new Set([...src.matchAll(/^function ([A-Za-z_$][\w$]*)\(/gm)].map((x) => x[1]));
  const helpers = [], seenFns = new Set(['shapeSteer']);
  const scan = (code) => {
    for (const name of topFns) {
      if (seenFns.has(name) || !new RegExp(`\\b${name}\\(`).test(code)) continue;
      seenFns.add(name);
      const h = extractFunction(src, name);
      if (h) { helpers.push(h); scan(h); }
    }
  };
  scan(fnSrc);
  const warnings = [];
  if (!/let rate = STEER_LPF_RATE/.test(src) || !/steer = damp\(steer, steerTarget, rate, dt\)/.test(src)) warnings.push('pad.js tick low-pass changed (expected `steer = damp(steer, steerTarget, rate, dt)` with rate STEER_LPF_RATE)');
  if (!/steerTarget = now - last < SENSOR_STALE_MS \? steerFromAngle\(rawAngleDeg\)/.test(src)) warnings.push('pad.js tick no longer maps steerFromAngle(rawAngleDeg) directly');
  const sfa = extractFunction(src, 'steerFromAngle') || '';
  if (!/thetaDeg - state\.calib/.test(sfa) || !/shapeSteer\(d, settings\.lockDeg\)/.test(sfa)) warnings.push('pad.js steerFromAngle() changed');
  if (!/out\.s = state\.pageVisible \? Math\.round\(steer \* 1000\) \/ 1000/.test(src)) warnings.push('pad.js send quantization changed');
  for (const k of ['DEAD_ZONE_DEG', 'EXPO', 'STEER_LPF_RATE', 'LOCK_DEFAULT_DEG', 'STEER_KNEE', 'STEER_CAP']) if (!(k in consts)) warnings.push(`pad.js constant ${k} not found`);
  return { consts, fnSrc, helpers, warnings };
}

const PADSRC = loadPadSource();
const PAD = {
  dead: PADSRC.consts.DEAD_ZONE_DEG, expo: PADSRC.consts.EXPO, lpf: PADSRC.consts.STEER_LPF_RATE,
  lock: Number(opt('lock', PADSRC.consts.LOCK_DEFAULT_DEG)),
  knee: PADSRC.consts.STEER_KNEE ?? 1, cap: PADSRC.consts.STEER_CAP ?? 1,   // v4 soft knee + steering lock (1 / 1 = the v3 curve)
};

// ------------------------------------------------------------------ human model

const HUMAN = {
  delay: 0.2,             // s reaction (cruising), eyes -> hands
  display: 0.03,          // s render + display latency on top
  predict: 0.12,          // s of error-trend anticipation
  gains: [45, 65, 90],    // deg of wheel per rad of aim error (one per seed: people turn differently)
  percept: 0,             // heading the eyes judge against: 0 = kart nose, 1 = chase-camera heading (screen forward), 2 = travel direction
  look: 6, lookT: 0.5, line: 0.5,
  wn: 14, zeta: 0.7, maxRate: 420,    // wrist: natural freq (rad/s), damping, max deg/s
  holdZeta: 0.6,          // wrist damping for the open-loop drift holds
  tremor: 0.6, tremorHz: 9, wander: 1.5, wanderTau: 1.0, noise: 0.2,
  net: 0.04, netJitter: 0.015, tickJitter: 0.0015,
  leadT: 0.25, leadJitter: 0.08,      // drift decided this long before the corner (+- jitter) ...
  tiltLead: 0.06, tiltLeadJitter: 0.06, // ... the into-turn tilt starts then, the DRIFT press follows this much later
  releaseT: 0.08,         // ... released this long before the corner ends
  maxDeg: 75,
};
const STYLES = {
  bot: { drift: false, bot: true },   // reference: the dev Autopilot (karts-autopilot.js) drives the kart directly, no phone
  kbd: { drift: true, keyboard: true, db: 0.05, hopHold: 0.4 },   // keyboard drifter: arrow keys through the real Input ramp
  kbdr: { drift: true, keyboard: true, db: 0.05, hopHold: 0.4, kHoldIn: true, postHold: 0.25 },   // ... holding the arrow 0.25 s past the release
  kbdi: { drift: true, keyboard: true, db: 0.05, hopHold: 0.4, kHoldIn: true },                   // ... holding the into-turn arrow for the whole drift
  cruise: { drift: false },
  s60: { drift: true, hold: 0.6 },
  s80: { drift: true, hold: 0.8 },
  s100: { drift: true, hold: 1.0 },
  follow: { drift: true, follow: true, delay: 0.18, gainMult: 1.2, zeta: 0.45, wn: 12 },
  panic: { drift: true, follow: true, yank: 1.5, yankT: 0.45, delay: 0.25, predict: 0, gainMult: 2.2, zeta: 0.35, wn: 16, maxLockMult: 1.6 },
  // drift exits (SPEC §15.1): slow hands keep the drift tilt `postHold` s after letting go of DRIFT,
  // or the release comes mid-corner (`relFrac` of the arc)
  r80: { drift: true, hold: 0.8, postHold: 0.3 },
  r100: { drift: true, hold: 1.0, postHold: 0.3 },
  r120: { drift: true, hold: 1.2, postHold: 0.3 },
  er100: { drift: true, hold: 1.0, postHold: 0.3, relFrac: 0.7 },
  e80: { drift: true, hold: 0.8, relFrac: 0.6 },
  e100: { drift: true, hold: 1.0, relFrac: 0.6 },
  efollow: { drift: true, follow: true, delay: 0.18, gainMult: 1.2, zeta: 0.45, wn: 12, relFrac: 0.6 },
};

// ------------------------------------------------------------------ --set overrides

const OVERRIDE_TARGETS = { KART_TUNE, DRIFT, KART, ASSIST_TUNE, VIEW: VIEW_TUNE, pad: PAD, human: HUMAN, CAM: null };
const CAM_OVERRIDES = {};
const overrides = [];
for (const kv of (opt('set', '') || '').split(',').filter(Boolean)) {
  const m = kv.match(/^([A-Za-z_]+)\.([A-Za-z0-9_]+)=(.+)$/);
  if (!m || !(m[1] in OVERRIDE_TARGETS)) { console.error(`bad --set entry '${kv}'`); process.exit(2); }
  let v = m[3].includes('/') ? m[3].split('/').map(Number) : Number(m[3]);
  if (m[1] === 'CAM') CAM_OVERRIDES[m[2]] = v;
  else {
    const tgt = OVERRIDE_TARGETS[m[1]];
    if (!(m[2] in tgt)) console.warn(`warning: --set ${m[1]}.${m[2]} is a new key`);
    if (Array.isArray(tgt[m[2]]) && !Array.isArray(v)) v = [v];
    tgt[m[2]] = v;
  }
  overrides.push(`${m[1]}.${m[2]}=${m[3]}`);
}

if (CFG.v3) {   // --v3: the v3 phone curve (expo to full authority at the lock) and no drift-exit latch
  PAD.knee = 1; PAD.cap = 1; KART_TUNE.exitLatchTime = 0;
  overrides.push('v3 baseline (pad.knee=1, pad.cap=1, KART_TUNE.exitLatchTime=0)');
}

// shapeSteer() built from pad.js's own source with the (possibly overridden) constants.
function makeShape(over = {}) {
  const env = { ...PADSRC.consts, DEAD_ZONE_DEG: PAD.dead, EXPO: PAD.expo, STEER_KNEE: PAD.knee, STEER_CAP: PAD.cap, ...over };
  const names = Object.keys(env);
  const body = `"use strict";\n${PADSRC.helpers.join('\n')}\nreturn (${PADSRC.fnSrc});`;
  return Function(...names, 'clamp', 'lerp', 'damp', body)(...names.map((n) => env[n]), clamp, lerp, damp);
}
const shapeSteer = makeShape();

// Wheel angle (deg) a phone needs for steer value u (inverse of shapeSteer, bisection).
function tiltFor(u) {
  const a = Math.abs(u);
  if (a <= 0) return 0;
  if (shapeSteer(PAD.lock, PAD.lock) < a - 1e-9) return Infinity;
  let lo = 0, hi = PAD.lock;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (shapeSteer(mid, PAD.lock) < a) lo = mid; else hi = mid; }
  return Math.sign(u) * hi;
}

// ------------------------------------------------------------------ helpers

const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : '-');
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const pad = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
const padR = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const max = (a) => (a.length ? Math.max(...a) : NaN);
const hashStr = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

function makeGauss(rng) {
  let spare = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u <= 1e-12) u = rng();
    v = rng();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

function makeKart(track, charDef, assist) {
  const k = new Kart({ id: `probe-${charDef.id}`, character: charDef, track, isPlayer: true, ccMult: CC_MULT, steerAssist: assist });
  return k;
}

// Drift corners: arcs of at least minAngle degrees. dir in steer convention (+1 = right).
function cornersOf(track) {
  return track.segments.filter((s) => s.type === 'arc' && s.angle >= CFG.minAngle)
    .map((s) => ({ name: s.name || `seg ${s.index}`, index: s.index, s0: s.s0, s1: s.s1, dir: s.dir === 'right' ? 1 : -1, angle: s.angle, radius: s.radius }));
}

// Straight windows for the weaving metrics (skip the first 25 m after a bend, last 10 m).
function straightsOf(track) {
  return track.segments.filter((s) => s.type === 'straight' && s.s1 - s.s0 > 45).map((s) => ({ s0: s.s0 + 25, s1: s.s1 - 10, name: s.name }));
}

function segmentNameAt(track, s) {
  const a = track.segStartS;
  let i = a.length - 2;
  while (i > 0 && a[i] > s) i--;
  return track.segments[i] ? track.segments[i].name : '?';
}

// ------------------------------------------------------------------ one run

let TRACE = null;
function styleDef(name) {
  if (STYLES[name]) return STYLES[name];
  const m = name.match(/^([asn])(\d+)$/);
  if (m) return m[1] === 's' ? { drift: true, hold: Number(m[2]) / 100 } : m[1] === 'n' ? { drift: true, noButton: true, hold: Number(m[2]) / 100 } : { drift: true, holdDeg: Number(m[2]) };
  throw new Error(`unknown style ${name}`);
}

function simulate({ track, charDef, assist, style, seed, laps }) {
  const ST = styleDef(style), H = HUMAN, L = track.length;
  const rng = makeRng(hashStr(`${track.id}|${charDef.id}|${style}|${seed}|${assist}`));
  const gauss = makeGauss(rng);
  const K = H.gains[(seed - 1) % H.gains.length];
  const corners = ST.drift ? cornersOf(track) : [];
  const straights = straightsOf(track);

  const k = makeKart(track, charDef, assist);
  k.placeOnGrid(track.gridSlot(3));
  const bot = ST.bot ? new Autopilot(k, { drift: true }) : null;
  const kbd = ST.keyboard ? new Input() : null;

  // observe Steer Assist output (the real method, wrapped)
  let assistIn = 0, assistUsed = 0;
  if (assist) {
    const orig = k._assist.bind(k);
    k._assist = (u, dt) => {
      const o = orig(u, dt);
      assistUsed = o; assistIn = u;
      return o;
    };
  }

  const cam = new ChaseCamera(new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000));
  Object.assign(cam.params, CAM_OVERRIDES);
  cam.setTarget(k);
  let slide = 0;

  // ---- events
  // seq: this substep's drift starts / ends in the order they happened (a drift can
  // start and be cancelled in the same substep, e.g. landing > driftMaxHeading off the road)
  const ev = { sides: [], seq: [], walls: 0, hop: 0, hopSteer: 0, hopNow: false };
  const offs = [
    bus.on('kart:driftStart', (e) => { if (e.kart === k) ev.seq.push({ start: e.dir }); }),
    bus.on('kart:driftEnd', (e) => { if (e.kart === k) ev.seq.push({ end: { tier: e.tier, cancelled: !!e.cancelled } }); }),
    bus.on('kart:wallHit', (e) => { if (e.kart === k) { ev.walls++; ev.sides.push(Math.sign(k.proj.lateral)); } }),
    bus.on('kart:hop', (e) => { if (e.kart === k) { ev.hop++; ev.hopSteer = k.input.steer; ev.hopNow = true; } }),
  ];

  // ---- human + phone state
  const hist = new Float64Array(512), histT = new Float64Array(512);   // perceived aim error ring (per host frame)
  let hN = 0;
  let theta = 0, thetaV = 0, wander = 0;
  const tremPhase = rng() * Math.PI * 2;
  let padSteer = 0;
  let nextTick = rng() * FRAME;           // phone tick phase
  const netQ = [];                        // { t, s, d }
  let lastArrive = 0, hostSteer = 0;
  // host side: the wire record PhoneLink keeps per slot (net.js clamps s) read by the real PadInput (input.js)
  const wire = { s: 0, g: 1, b: 0, d: 0, i: 0, p: 0 };
  const padIn = new PadInput({ input: wire, active: true }, 1);
  let btn = false;                        // DRIFT held by the human (phone side)
  let mode = 'cruise', cur = null, tPress = 0, tDecide = 0, distEnd = 0, tTimeout = 0, nextCorner = 0, tReleased = -1;
  let leadNow = H.leadT + (rng() - 0.5) * 2 * H.leadJitter;   // this corner's press timing
  let lastHoldCmd = null, lastKey = 0;   // postHold styles: the drift's wheel kept after the release

  // pick the first corner ahead of the grid
  if (corners.length) {
    const s0 = k.proj.s;
    let best = 0, bd = Infinity;
    corners.forEach((c, i) => { const d = track.forwardDistance(s0, c.s0); if (d < bd) { bd = d; best = i; } });
    nextCorner = best;
  }

  // ---- metrics
  const drifts = [];        // finished drift records
  const open = [];          // records still collecting (drift active or post window)
  let rec = null;           // the active drift record
  let attempts = 0, noDrift = 0, wrongDir = 0, lapWalls = 0;
  const missed = [];        // corners where DRIFT was held but no drift started
  let wallsTotal = 0;
  const cruise = { n: 0, sq: 0, hdgSq: 0, yrSq: 0, rev: 0, time: 0, latPasses: [], cornerSq: 0, cornerN: 0, offroad: 0, frames: 0 };
  let lastSign = 0, passIdx = -1, pass = null;
  let lastDriftEndT = -10;

  // ---- lap bookkeeping
  let t = 0, prevS = k.proj.s, dist = track.deltaS(0, prevS), lapStart = 0;
  const lapTimes = [];
  let prevYaw = k.yaw, prevTrk = k.proj.yaw, cumYaw = 0, cumPath = 0, prevPath = Math.atan2(k.velocity.x, k.velocity.z);
  const maxT = laps * 160;
  const fr = {};
  const pt = new THREE.Vector3();

  // aim error the human perceives now (+ = target LEFT of the view direction)
  function perceive() {
    const s = k.proj.s, v = Math.max(0, k.speed);
    const sA = s + H.look + H.lookT * v;
    track.frameAt(sA, fr);
    track.pointAt(sA, fr.racingLine * H.line, pt);
    const bearing = Math.atan2(pt.x - k.position.x, pt.z - k.position.z);
    const hs = Math.hypot(k.velocity.x, k.velocity.z);
    const head = H.percept === 1 ? cam.heading : H.percept === 2 && hs > 3 ? Math.atan2(k.velocity.x, k.velocity.z) : k.yaw;
    return angleDiff(head, bearing);
  }

  // delayed (+ anticipated) aim error seen `delay` s ago
  function seen(delay, predict) {
    if (hN === 0) return 0;
    const tt = t - delay - H.display;
    let i = hN - 1;
    while (i > 0 && histT[i % 512] > tt && hN - i < 500) i--;
    const a = hist[i % 512];
    if (predict > 0 && i > 3) {
      const j = i - 3;
      const rate = (a - hist[j % 512]) / Math.max(1e-3, histT[i % 512] - histT[j % 512]);
      return a + clamp(rate * predict, -0.5, 0.5);
    }
    return a;
  }

  // wheel angle the hands aim for (deg, + = right)
  function command() {
    const lock = PAD.lock;
    if (ST.postHold && mode === 'cruise' && t - tReleased < ST.postHold && lastHoldCmd !== null) return lastHoldCmd;
    if (mode === 'drift' && cur) {
      if (ST.hold) return (lastHoldCmd = cur.dir * ST.hold * lock);
      if (ST.holdDeg) return cur.dir * ST.holdDeg;
      if (ST.yank && t - tDecide < ST.yankT) return cur.dir * ST.yank * lock;
      const g = K * (ST.gainMult || 1);
      const lim = ST.maxLockMult ? ST.maxLockMult * lock : H.maxDeg;
      return clamp(-g * seen(ST.delay ?? H.delay, ST.predict ?? H.predict), -lim, lim);
    }
    return clamp(-K * seen(H.delay, H.predict), -H.maxDeg, H.maxDeg);
  }

  function wristParams() {
    if (mode === 'drift') {
      if (ST.hold || ST.holdDeg) return [H.wn, H.holdZeta];
      if (ST.follow) return [ST.wn || H.wn, ST.zeta ?? H.zeta];
    }
    return [H.wn, H.zeta];
  }

  // integrate the hands from t to t1
  function hands(t1, tFrom) {
    let tt = tFrom;
    while (tt < t1 - 1e-9) {
      const h = Math.min(1 / 480, t1 - tt);
      const cmd = command();
      const [wn, z] = wristParams();
      const acc = wn * wn * (cmd - theta) - 2 * z * wn * thetaV;
      thetaV = clamp(thetaV + acc * h, -H.maxRate, H.maxRate);
      theta += thetaV * h;
      wander += (-wander / H.wanderTau) * h + H.wander * Math.sqrt((2 * h) / H.wanderTau) * gauss();
      tt += h;
    }
  }

  function phoneTick(dtTick) {
    const deg = theta + wander + H.tremor * Math.sin(2 * Math.PI * H.tremorHz * t + tremPhase) + H.noise * gauss();
    const target = shapeSteer(deg - 0, PAD.lock);          // auto-centered at the countdown: calib = 0
    padSteer = damp(padSteer, target, PAD.lpf, dtTick);
    if (Math.abs(padSteer) < 0.0005) padSteer = 0;
    const sent = Math.round(padSteer * 1000) / 1000;
    const arrive = Math.max(lastArrive, t + H.net + rng() * H.netJitter);
    lastArrive = arrive;
    netQ.push({ t: arrive, s: sent, d: btn });
  }

  function humanDecide() {
    const s = k.proj.s, v = Math.max(1, k.speed);
    if (!ST.drift || !corners.length) return;
    if (mode === 'cruise') {
      if (t - tReleased < 0.12) return;                     // the thumb needs a moment between releases and presses
      const c = corners[nextCorner];
      const fd = track.forwardDistance(s, c.s0);
      const inside = fd > L - (c.s1 - c.s0);                 // already past the corner start
      const lead = v * leadNow;
      if (fd <= lead || inside) {
        const toEnd = track.forwardDistance(s, c.s1);
        if (inside && toEnd > L / 2) { nextCorner = (nextCorner + 1) % corners.length; return; }
        // the into-turn tilt starts at the decision, the thumb presses DRIFT tiltLead later
        mode = 'drift'; cur = c; tDecide = t; tPress = t + Math.max(0, H.tiltLead + (rng() - 0.5) * 2 * H.tiltLeadJitter); btn = false; attempts++;
        distEnd = ST.relFrac ? dist + Math.max(0, toEnd - (1 - ST.relFrac) * (c.s1 - c.s0)) : dist + toEnd - v * H.releaseT;
        tTimeout = t + 1.6 * ((c.s1 - c.s0) / v) + 0.8;
        cur.attempt = { corner: c.name, t, drifted: false, dir: 0 };
      }
    } else if (mode === 'drift') {
      if (!btn && !ST.noButton && t >= tPress && dist < distEnd) btn = true;
      if (dist >= distEnd || t >= tTimeout) {
        mode = 'cruise'; btn = false; tReleased = t;
        if (!cur.attempt.drifted) { noDrift++; missed.push(cur.name); }
        cur = null;
        nextCorner = (nextCorner + 1) % corners.length;
        leadNow = H.leadT + (rng() - 0.5) * 2 * H.leadJitter;
      }
    }
  }

  function openRecord(dir) {
    const c = cur;
    const r = {
      corner: c ? c.name : segmentNameAt(track, k.proj.s), cornerDir: c ? c.dir : dir, dir, t0: t, t1: NaN,
      v0: k.speed, vmin: k.speed, nose: 0, trk: 0, maxSlip: 0, maxDev: 0, maxScreen: 0, spin: false, walls: 0,
      tier: 0, cancelled: false, cxlWhy: '', peakOver: 0, wallsPost: 0, active: true, postUntil: Infinity, wallUntil: Infinity, assistInto: 0, assistN: 0,
      devEnd: NaN, style, seed,
      // after the release (SPEC §15.1): inside / outside wall hits, path + nose swing into the old turn
      wallsIn: 0, wallsOut: 0, relT: NaN, exOverMax: 0, exOver0: 0, inLat: -1e9, inEdge: 1e9, yrPeak: -1e9,
      sw3: NaN, sw6: NaN, sw10: NaN, nw3: NaN, nw6: NaN, lat0: 0,
    };
    if (c && c.attempt) { c.attempt.drifted = true; c.attempt.dir = dir; }
    if (c && dir !== c.dir) wrongDir++;
    open.push(r);
    return r;
  }

  // ---- main loop
  let nextHost = FRAME;
  hands(0, 0);
  while (lapTimes.length < laps && t < maxT) {
    // phone ticks before the next host frame
    while (!bot && !kbd && nextTick <= nextHost) {
      hands(nextTick, t); t = nextTick;
      phoneTick(FRAME + (rng() - 0.5) * 2 * H.tickJitter);
      nextTick += FRAME + (rng() - 0.5) * 2 * H.tickJitter;
    }
    if (!bot && !kbd) hands(nextHost, t);
    t = nextHost; nextHost += FRAME;

    // ---- host frame: latest arrived input
    if (kbd) {
      // arrows from the error seen `delay` ago (+ = target left); into-turn hold through the hop
      const e = seen(H.delay, H.predict);
      let key = e > ST.db ? -1 : e < -ST.db ? 1 : 0;           // steer convention: -1 = left arrow
      if (mode === 'drift' && cur && t - tDecide < ST.hopHold) key = cur.dir;
      if (ST.kHoldIn && mode === 'drift' && cur && btn) key = cur.dir;   // holds the arrow INTO the turn for the whole drift
      if (mode === 'drift' && cur) lastKey = key;
      if (ST.postHold && mode === 'cruise' && t - tReleased < ST.postHold) key = lastKey;
      const down = new Set(['ArrowUp']);
      if (key < 0) down.add('ArrowLeft'); else if (key > 0) down.add('ArrowRight');
      if (btn) down.add('Space');
      kbd._down = down;
      kbd.update(FRAME);
      k.input.steer = kbd.steer; k.input.throttle = kbd.throttle; k.input.brake = kbd.brake; k.input.drift = kbd.drift;
    } else if (!bot) {
      while (netQ.length && netQ[0].t <= t) { const q = netQ.shift(); wire.s = clamp(q.s, -1, 1); wire.d = q.d ? 1 : 0; }
      padIn.update(FRAME);
      k.input.steer = padIn.steer; k.input.throttle = padIn.throttle; k.input.brake = padIn.brake; k.input.drift = padIn.drift;
    }

    for (let i = 0; i < SUB; i++) {
      ev.seq.length = 0; ev.hopNow = false; ev.sides.length = 0;
      const w0 = ev.walls;
      if (bot) bot.update(FRAME / SUB);
      k.update(FRAME / SUB);
      const yawStep = angleDiff(prevYaw, k.yaw); prevYaw = k.yaw; cumYaw += yawStep;
      { const vp = Math.hypot(k.velocity.x, k.velocity.z) > 2 ? Math.atan2(k.velocity.x, k.velocity.z) : prevPath; cumPath += angleDiff(prevPath, vp); prevPath = vp; }
      const trkStep = angleDiff(prevTrk, k.proj.yaw); prevTrk = k.proj.yaw;
      const newWalls = ev.walls - w0;
      wallsTotal += newWalls;
      const hs = Math.hypot(k.velocity.x, k.velocity.z);
      const velYaw = Math.atan2(k.velocity.x, k.velocity.z);
      const dev = Math.abs(angleDiff(k.proj.yaw, k.yaw));
      const along = k.velocity.x * k.proj.tangent.x + k.velocity.z * k.proj.tangent.z;
      for (let j = open.length - 1; j >= 0; j--) {
        const r = open[j];
        if (r.active) {
          r.nose += yawStep; r.trk += trkStep;
          const over = -r.cornerDir * (r.nose - r.trk);
          if (over > r.peakOver) r.peakOver = over;
          if (hs > 3) r.maxSlip = Math.max(r.maxSlip, Math.abs(angleDiff(velYaw, k.yaw)));
          r.vmin = Math.min(r.vmin, k.speed);
          if (assist) { r.assistInto += (assistUsed - assistIn) * r.dir; r.assistN++; }
        }
        if (t <= r.postUntil) {
          r.maxDev = Math.max(r.maxDev, dev);
          if (dev > Math.PI / 2 || along < -0.5) r.spin = true;
          if (r._devAt && t >= r._devAt && !Number.isFinite(r.devEnd)) r.devEnd = dev;
        }
        if (t <= r.wallUntil) {
          r.walls += newWalls;
          if (!r.active) { r.wallsPost += newWalls; for (const sd of ev.sides) { if (sd === r.cornerDir) r.wallsIn++; else r.wallsOut++; } }
        }
        if (!r.active && Number.isFinite(r.relT) && t <= r.relT + 1.0 + 1e-9) {
          // post-release window: swing INTO the old turn (degrees, + = into it)
          const dc = r.cornerDir || r.dir, dtr = t - r.relT;
          const into = -dc * angleDiff(k.proj.yaw, k.yaw) * RAD;
          r.exOverMax = Math.max(r.exOverMax, into - r.exOver0);
          r.inLat = Math.max(r.inLat, dc * k.proj.lateral - r.lat0);
          r.inEdge = Math.min(r.inEdge, k.proj.halfWidth - dc * k.proj.lateral);
          r.yrPeak = Math.max(r.yrPeak, -dc * k.yawRate * RAD);
          if (!Number.isFinite(r.sw3) && dtr >= 0.3) { r.sw3 = -dc * (cumPath - r.relPath) * RAD; r.nw3 = -dc * (cumYaw - r.relYaw) * RAD; }
          if (!Number.isFinite(r.sw6) && dtr >= 0.6) { r.sw6 = -dc * (cumPath - r.relPath) * RAD; r.nw6 = -dc * (cumYaw - r.relYaw) * RAD; }
          if (!Number.isFinite(r.sw10) && dtr >= 1.0 - 1e-9) r.sw10 = -dc * (cumPath - r.relPath) * RAD;
        }
        if (!r.active && t > r.postUntil) { open.splice(j, 1); drifts.push(r); }
      }
      for (const e of ev.seq) {
        if (e.end && rec) {
          rec.active = false; rec.t1 = t; rec.tier = e.end.tier; rec.cancelled = e.end.cancelled;
          { const dc = rec.cornerDir || rec.dir; rec.relT = t; rec.relYaw = cumYaw; rec.relPath = cumPath; rec.exOver0 = -dc * angleDiff(k.proj.yaw, k.yaw) * RAD; rec.lat0 = dc * k.proj.lateral; rec.yrRel = -dc * k.yawRate * RAD; rec.steerRel = k.input.steer * dc; }
          if (rec.cancelled) rec.cxlWhy = !k.grounded ? 'air' : k.speed < KART_TUNE.driftCancelSpeed ? (rec.walls ? 'slow+wall' : 'slow') : 'other';
          rec.postUntil = t + 1.5; rec.wallUntil = t + 1.0;
          rec._devAt = t + 0.5;
          lastDriftEndT = t;
          rec = null;
        } else if (e.start !== undefined) { rec = openRecord(e.start); rec.startAt = ev.hopNow ? 'hop' : 'land'; rec.hopSteer = ev.hopSteer; }
      }
    }

    hostSteer = k.input.steer;

    // camera + kart view (once per rendered frame)
    cam.update(FRAME);
    const d = k.drift;
    slide = damp(slide, driftSlideTarget(k), VIEW_TUNE.driftYawRate, FRAME);
    const screen = Math.abs(angleDiff(cam.heading, k.yaw + slide));
    if (rec) rec.maxScreen = Math.max(rec.maxScreen, screen);

    // perception for the hands
    hist[hN % 512] = perceive(); histT[hN % 512] = t; hN++;

    // lap progress
    const s2 = k.proj.s;
    dist += track.deltaS(prevS, s2); prevS = s2;
    if (Math.floor(dist / L) > lapTimes.length) { lapTimes.push(t - lapStart); lapStart = t; }

    humanDecide();
    if (TRACE) TRACE.push([t.toFixed(3), s2.toFixed(1), k.proj.lateral.toFixed(2), (angleDiff(k.proj.yaw, k.yaw) * RAD).toFixed(1), (angleDiff(k.proj.yaw, cam.heading) * RAD).toFixed(1), theta.toFixed(1), hostSteer.toFixed(3), k.speed.toFixed(1), d.active ? d.dir : 0, mode, (hist[(hN - 1) % 512] * RAD).toFixed(1)].join(','));

    // cruising metrics (straights, not drifting, 1.5 s after any drift)
    if (!d.active && !d.hopping && t - lastDriftEndT > 1.5 && k.speed > 8 && mode === 'cruise') {
      let si = -1;
      for (let i = 0; i < straights.length; i++) { const w = straights[i]; if (s2 >= w.s0 && s2 <= w.s1) { si = i; break; } }
      if (si >= 0) {
        const u = hostSteer;
        cruise.n++; cruise.sq += u * u; cruise.time += FRAME;
        const hd = angleDiff(k.proj.yaw, k.yaw) * RAD; cruise.hdgSq += hd * hd;
        const yr = k.yawRate * RAD; cruise.yrSq += yr * yr;
        const sg = u > 0.04 ? 1 : u < -0.04 ? -1 : 0;
        if (sg !== 0) { if (lastSign !== 0 && sg !== lastSign) cruise.rev++; lastSign = sg; }
        if (si !== passIdx || !pass) { if (pass && pass.n > 30) cruise.latPasses.push(Math.sqrt(Math.max(0, pass.sq / pass.n - (pass.sum / pass.n) ** 2))); pass = { n: 0, sum: 0, sq: 0 }; passIdx = si; }
        pass.n++; pass.sum += k.proj.lateral; pass.sq += k.proj.lateral * k.proj.lateral;
      } else if (pass) {
        if (pass.n > 30) cruise.latPasses.push(Math.sqrt(Math.max(0, pass.sq / pass.n - (pass.sum / pass.n) ** 2)));
        pass = null; passIdx = -1;
      }
      if (k.proj.curvature && Math.abs(k.proj.curvature) > 1 / 60) {
        track.frameAt(s2, fr);
        const e = k.proj.lateral - fr.racingLine * H.line;
        cruise.cornerSq += e * e; cruise.cornerN++;
      }
    }
    cruise.frames++;
    if (k.surface === 'offroad') cruise.offroad++;
  }
  // flush records still open
  for (const r of open) { if (r.active) { r.t1 = t; r.active = false; } drifts.push(r); }
  if (pass && pass.n > 30) cruise.latPasses.push(Math.sqrt(Math.max(0, pass.sq / pass.n - (pass.sum / pass.n) ** 2)));
  for (const off of offs) off();
  cam.dispose();

  for (const r of drifts) {
    r.dur = r.t1 - r.t0;
    const dirc = r.cornerDir || r.dir;
    r.noseDeg = -dirc * r.nose * RAD;          // + = rotated into the corner
    r.trkDeg = -dirc * r.trk * RAD;
    r.overDeg = r.noseDeg - r.trkDeg;
    r.maxSlipDeg = r.maxSlip * RAD; r.maxDevDeg = r.maxDev * RAD; r.maxScreenDeg = r.maxScreen * RAD;
    r.devEndDeg = r.devEnd * RAD;
    r.peakOverDeg = r.peakOver * RAD;
    r.assistInto = r.assistN ? r.assistInto / r.assistN : NaN;
    r.wrong = r.cornerDir !== r.dir;
    delete r._devAt;
  }
  return {
    lapTimes, done: lapTimes.length >= laps, t, walls: wallsTotal, drifts, attempts, noDrift, wrongDir, K, missed,
    cruise: {
      steerRms: Math.sqrt(cruise.sq / Math.max(1, cruise.n)),
      revPerS: cruise.rev / Math.max(1e-6, cruise.time),
      hdgRms: Math.sqrt(cruise.hdgSq / Math.max(1, cruise.n)),
      yawRateRms: Math.sqrt(cruise.yrSq / Math.max(1, cruise.n)),
      latSd: mean(cruise.latPasses),
      cornerErr: Math.sqrt(cruise.cornerSq / Math.max(1, cruise.cornerN)),
      offroadPct: (100 * cruise.offroad) / Math.max(1, cruise.frames),
    },
  };
}

// ------------------------------------------------------------------ flat-plane kinematics (real Kart)

function flatTrack() {
  const N = 64;
  const big = 1e5;
  const tr = {
    id: 'flat', N, spacing: 1, length: 1e9, ramps: [], boostPads: [],
    wr: new Float32Array(N).fill(big), wl: new Float32Array(N).fill(big),
    deltaS: (a, b) => b - a, wrapS: (s) => s, forwardDistance: (a, b) => b - a,
    project(pos, hint, out = {}) {
      out.index = 0; out.f = 0; out.s = pos.z; out.lateral = -pos.x;
      out.centerY = 0; out.height = 0; out.onRamp = false; out.halfWidth = big; out.wallL = big; out.wallR = big;
      out.curvature = 0; out.slope = 0; out.yaw = 0;
      out.tangent = (out.tangent || new THREE.Vector3()).set(0, 0, 1);
      out.right = (out.right || new THREE.Vector3()).set(-1, 0, 0);
      out.surface = 'road'; out.boostPad = null;
      return out;
    },
    frameAt(s, out = {}) { return Object.assign(out, { index: 0, s, yaw: 0, halfWidth: big, wallL: big, wallR: big, racingLine: 0, curvature: 0, slope: 0 }); },
    pointAt(s, lat = 0, out = new THREE.Vector3()) { return out.set(-lat, 0, s); },
  };
  return tr;
}

// Steady state at speed v: normal steering (x = steer) or a drift (x = steer · dir, dir = +1).
function steady(charDef, v, x, drift) {
  // the flat plane's road always points +z: lift the drift heading cap (a steady drift circles)
  const mh = KART_TUNE.driftMaxHeading;
  KART_TUNE.driftMaxHeading = 0;
  try { return steadyRun(charDef, v, x, drift); } finally { KART_TUNE.driftMaxHeading = mh; }
}
function steadyRun(charDef, v, x, drift) {
  const tr = flatTrack();
  const k = makeKart(tr, charDef, false);
  k.position.set(0, 0, 0); k.yaw = 0; k._resetState();
  tr.project(k.position, -1, k.proj); k.hint = 0;
  k.stats.topSpeed = v + 0.02;
  k.velocity.set(0, 0, v + 0.02);
  const dt = 1 / 120;
  let t = 0;
  k.input.throttle = 1;
  let yaw0 = 0, vel0 = 0, tm = 0, spd = 0, slip = 0, n = 0, accYaw = 0, accVel = 0, pY = 0, pV = 0;
  const T_END = 4, T_MEAS = 1.5;
  let ok = true;
  while (t < T_END) {
    if (drift) { k.input.drift = true; k.input.steer = t < 0.3 ? 1 : x; }
    else { k.input.drift = false; k.input.steer = x; }
    k.update(dt); t += dt;
    if (drift && t > 0.3 && !k.drift.active) ok = false;
    const vy = Math.atan2(k.velocity.x, k.velocity.z);
    if (t >= T_END - T_MEAS) {
      if (n === 0) { pY = k.yaw; pV = vy; }
      accYaw += angleDiff(pY, k.yaw); accVel += angleDiff(pV, vy); pY = k.yaw; pV = vy;
      spd += Math.hypot(k.velocity.x, k.velocity.z); slip += Math.abs(angleDiff(vy, k.yaw)); n++;
    }
  }
  const w = Math.abs(accYaw) / T_MEAS, wv = Math.abs(accVel) / T_MEAS, sp = spd / n;
  return { ok, yawRate: w, radius: sp / Math.max(1e-6, wv), speed: sp, slip: (slip / n) * RAD, t360: (2 * Math.PI) / Math.max(1e-6, w) };
}

function printKinematics() {
  console.log(`\n== Kinematics (flat plane, real Kart steady state @${CFG.cc}cc stats; x = steer·dir)`);
  console.log(`   drift tightness = turnRate × driftTightness(x); driftTightness(-1/0/0.5/1) = ${[-1, 0, 0.5, 1].map((x) => f2(lerp(KART_TUNE.driftWide, KART_TUNE.driftTight, Math.pow(clamp((x + 1) / 2, 0, 1), KART_TUNE.driftCurve)))).join(' / ')}`);
  const out = [];
  for (const { key, def } of CHARS) {
    const k0 = makeKart(flatTrack(), def, false);
    console.log(`  ${key} (${def.id}, handling ${k0.ratings.handling}, turnRate ${f2(k0.stats.turnRate)} rad/s, top ${f1(k0.stats.topSpeed)} m/s)`);
    console.log(`    ${padR('v m/s', 6)}| ${padR('normal full lock: v  ω°/s  R m', 31)}| ${['x=-1', 'x=0', 'x=0.5', 'x=1'].map((s) => padR(`drift ${s}: ω°/s  R m slip°`, 26)).join('| ')}| 360° at x=1`);
    for (const v of [10, 15, 20, 29]) {
      const nrm = steady(def, v, 1, false);
      const ds = [-1, 0, 0.5, 1].map((x) => steady(def, v, x, true));
      out.push({ char: key, v, normal: nrm, drift: ds });
      console.log(`    ${padR(v, 6)}| ${padR(`${f1(nrm.speed)} ${pad(f0(nrm.yawRate * RAD), 5)} ${pad(f1(nrm.radius), 6)}`, 31)}| ${ds.map((r) => padR(`${r.ok ? '' : '!'}${pad(f0(r.yawRate * RAD), 12)} ${pad(f1(r.radius), 5)} ${pad(f0(r.slip), 4)}`, 26)).join('| ')}| ${f2(ds[3].t360)} s`);
    }
  }
  // tilt sensitivity: heading rate per degree of tilt at the class top speed (normal steering)
  const ref = CHARS.find((c) => c.key === 'medium') || CHARS[0];
  const k0 = makeKart(flatTrack(), ref.def, false);
  const vt = k0.stats.topSpeed;
  const fS = Math.min(1, vt / KART_TUNE.turnRefSpeed) * (1 - KART_TUNE.highSpeedTurnLoss * clamp((vt - 12) / 18, 0, 1));
  const sens = [5, 10, 15, 20, 25, 30].map((deg) => {
    const ds = (shapeSteer(deg + 0.25, PAD.lock) - shapeSteer(deg - 0.25, PAD.lock)) / 0.5;
    return `${deg}°: steer ${f2(shapeSteer(deg, PAD.lock))} → ${f1(shapeSteer(deg, PAD.lock) * k0.stats.turnRate * fS * RAD)}°/s (gain ${f2(ds * k0.stats.turnRate * fS * RAD)}°/s per °)`;
  });
  console.log(`  phone tilt → normal yaw rate at ${f1(vt)} m/s (${ref.key}, lock ${PAD.lock}°, dead ${PAD.dead}°, expo ${PAD.expo}): ${sens.join('; ')}`);
  const dmin = KART_TUNE.driftDirMin ?? 0.2;
  console.log(`  drift direction needs |steer| > ${dmin} → tilt ≥ ${f1(tiltFor(dmin))}°; fast charge needs steer·dir ≥ ${DRIFT.chargeIntoMin} → tilt ≥ ${f1(tiltFor(DRIFT.chargeIntoMin))}° into the turn`);
  return out;
}

// Which wheel position x a drift needs for each corner, from measured ω(x) at the corner speed.
function cornerFit(track, charDef) {
  const k0 = makeKart(flatTrack(), charDef, false);
  const v = k0.stats.topSpeed * 0.95;
  const xs = []; for (let x = -1; x <= 1.0001; x += 0.1) xs.push(+x.toFixed(2));
  const om = xs.map((x) => steady(charDef, v, x, true).yawRate);
  const xFor = (w) => {
    if (w <= om[0]) return -Infinity;
    if (w >= om[om.length - 1]) return Infinity;
    for (let i = 1; i < xs.length; i++) if (om[i] >= w) return lerp(xs[i - 1], xs[i], (w - om[i - 1]) / (om[i] - om[i - 1]));
    return Infinity;
  };
  const omAt = (x) => { const i = clamp(Math.floor((x + 1) / 0.1), 0, xs.length - 2); return lerp(om[i], om[i + 1], (x - xs[i]) / 0.1); };
  const rows = [];
  const fr = {}, p = new THREE.Vector3(), q = new THREE.Vector3();
  for (const c of cornersOf(track)) {
    const len = c.s1 - c.s0, ext = Math.min(20, 0.3 * len);
    let Lp = 0, dh = 0, ph = null;
    track.frameAt(c.s0 - ext, fr); track.pointAt(c.s0 - ext, fr.racingLine, p);
    for (let s = c.s0 - ext + 1; s <= c.s1 + ext; s += 1) {
      track.frameAt(s, fr); track.pointAt(s, fr.racingLine, q);
      const dx = q.x - p.x, dz = q.z - p.z, h = Math.atan2(dx, dz);
      Lp += Math.hypot(dx, dz);
      if (ph !== null) dh += angleDiff(ph, h);
      ph = h; p.copy(q);
    }
    const Rline = Lp / Math.max(1e-6, Math.abs(dh));
    const need = v / Rline;
    const x = xFor(need);
    const xC = xFor(v / c.radius);
    const tCorner = Lp / v;
    rows.push({
      corner: c.name, dir: c.dir, angle: c.angle, R: c.radius, Rline, v, needDeg: need * RAD, x, xCenter: xC, needCenterDeg: (v / c.radius) * RAD,
      tilt: Number.isFinite(x) ? tiltFor(x) : x, tCorner,
      rot60: omAt(shapeSteer(0.6 * PAD.lock, PAD.lock)) * tCorner * RAD,
      rot100: omAt(shapeSteer(PAD.lock, PAD.lock)) * tCorner * RAD, rotNeutral: omAt(0) * tCorner * RAD,   // a phone's full tilt is the steering lock
    });
  }
  return { v, rows, om, xs };
}

function printCornerFit(track) {
  {
    const { key, def } = CHARS.find((c) => c.key === 'medium') || CHARS[0];
    const cf = cornerFit(track, def);
    console.log(`\n  corner fit (${key}, drift at ${f1(cf.v)} m/s; drift ω(x) measured: x=-1 ${f0(cf.om[0] * RAD)}°/s, x=0 ${f0(cf.om[10] * RAD)}°/s, x=1 ${f0(cf.om[20] * RAD)}°/s): x = steer·dir a drift needs for the centerline R / the racing-line radius (tilt° for the latter, − = counter-steer),`);
    console.log(`    and the road's turn vs the drift's rotation over the corner time (racing line) if held neutral / 60% / 100% tilt into the turn:`);
    console.log(`    ${padR('corner', 20)} ${pad('R', 4)} ${pad('need°/s', 8)} ${pad('x@R', 6)} ${pad('Rline', 7)} ${pad('need°/s', 8)} ${pad('x@line', 7)} ${pad('tilt°', 6)} ${pad('t s', 5)} | ${pad('road°', 5)} ${pad('x=0', 5)} ${pad('60%', 5)} ${pad('100%', 5)}`);
    const xstr = (x) => (x === -Infinity ? '<-1' : x === Infinity ? '>1' : f2(x));
    for (const r of cf.rows) {
      const ts = r.x === -Infinity ? 'out!' : r.x === Infinity ? '-' : f1(r.tilt);
      console.log(`    ${padR(r.corner, 20)} ${pad(f0(r.R), 4)} ${pad(f0(r.needCenterDeg), 8)} ${pad(xstr(r.xCenter), 6)} ${pad(f1(r.Rline), 7)} ${pad(f0(r.needDeg), 8)} ${pad(xstr(r.x), 7)} ${pad(ts, 6)} ${pad(f2(r.tCorner), 5)} | ${pad(f0(r.angle), 5)} ${pad(f0(r.rotNeutral), 5)} ${pad(f0(r.rot60), 5)} ${pad(f0(r.rot100), 5)}`);
    }
    return cf;
  }
}

// ------------------------------------------------------------------ flat-plane steering tests (SPEC §15.1)
// The phone chain above on a flat plane (no walls, no assist), medium character at
// its top speed: the hands' 2nd-order wrist (HUMAN.wn / zeta / maxRate) → pad.js
// shapeSteer → 30/s low-pass → 0.001 → 45 ms network → the real Kart (2 substeps).
//   step  the wrist goes to θ, holds 0.4 s and comes back: heading swing (deg) and
//         peak yaw rate (°/s). Big steps used to swing far harder per degree than
//         small ones (the v3 expo curve was steepest right at the lock).
//   exit  a drift held at 42° of tilt for 1.6 s, then DRIFT released while the hands
//         re-centre at once / 0.15 s / 0.3 s later, keep the tilt, or ease to 15°:
//         path swing into the old turn 0.3 / 0.6 / 1.0 s after the release arrives,
//         nose swing @0.6 s, peak yaw rate 0.15-1 s after it, lateral drift @1 s.
// Each test runs on this build and on the v3 baseline (v3 curve, no exit latch).

const FLAT_STEPS = [10, 20, 30, 40, 60];
const FLAT_HANDS = [['rc0', 0], ['rc15', 0.15], ['rc30', 0.3], ['hold', null], ['to15', 'ease']];
const FLAT_GATES = {
  step60: (f) => [f.now.step[60].swing, '60° tilt step heading swing °'],
  stepYaw60: (f) => [f.now.step[60].peak, '60° tilt step peak yaw °/s'],
  stepRatio: (f) => [f.now.step[40].swing / f.now.step[10].swing / 4, '(40° ÷ 10° step swing) ÷ 4'],
  step10: (f) => [100 * Math.abs(f.now.step[10].swing / f.base.step[10].swing - 1), '10° step swing change vs v3 %'],
  exitPath6: (f) => [f.now.exit.rc30.p6, 'drift exit, re-centre after 0.3 s: path swing @0.6 s °'],
  exitYaw15: (f) => [f.now.exit.rc15.peak, 'drift exit, re-centre after 0.15 s: peak yaw 0.15-1 s °/s'],
};

function unwrapDeg(S, key) {
  const out = []; let acc = 0, prev = S[0][key];
  for (const x of S) { acc += angleDiff(prev, x[key]); prev = x[key]; out.push(acc * RAD); }
  return out;
}

function flatChain(shape, charDef, { cmd, btn = () => false, T = 3, net = 0.045 }) {
  const tr = flatTrack();
  const k = makeKart(tr, charDef, false);
  k.position.set(0, 0, 0); k.yaw = 0; k._resetState();
  tr.project(k.position, -1, k.proj); k.hint = 0;
  k.velocity.set(0, 0, k.stats.topSpeed);
  const H = HUMAN, hd = { th: 0, v: 0 };
  let padSteer = 0, t = 0;
  const q = [], ev = [], S = [];
  const offs = [
    bus.on('kart:driftStart', (e) => { if (e.kart === k) ev.push({ t, start: e.dir }); }),
    bus.on('kart:driftEnd', (e) => { if (e.kart === k) ev.push({ t, end: e.tier }); }),
  ];
  while (t < T) {
    for (let i = 0; i < 8; i++) {          // the hands, then the phone's 60 Hz tick
      const h = FRAME / 8, c = cmd(t + i * h);
      const a = H.wn * H.wn * (c - hd.th) - 2 * H.zeta * H.wn * hd.v;
      hd.v = clamp(hd.v + a * h, -H.maxRate, H.maxRate);
      hd.th += hd.v * h;
    }
    padSteer = damp(padSteer, shape(hd.th, PAD.lock), PAD.lpf, FRAME);
    if (Math.abs(padSteer) < 0.0005) padSteer = 0;
    q.push({ t: t + net, s: Math.round(padSteer * 1000) / 1000, d: btn(t) });
    let cur = null;
    while (q.length && q[0].t <= t + 1e-9) cur = q.shift();
    if (cur) { k.input.steer = clamp(cur.s, -1, 1); k.input.drift = cur.d; }
    k.input.throttle = 1; k.input.brake = 0;
    for (let i = 0; i < SUB; i++) k.update(FRAME / SUB);
    t += FRAME;
    S.push({ t, yaw: k.yaw, path: Math.atan2(k.velocity.x, k.velocity.z), yr: k.yawRate, x: k.position.x, z: k.position.z });
  }
  for (const o of offs) o();
  return { S, ev };
}

function flatSuite(shape, charDef) {
  const step = {};
  for (const th of FLAT_STEPS) {
    const { S } = flatChain(shape, charDef, { cmd: (t) => (t >= 0.2 && t < 0.6 ? th : 0), T: 2.4 });
    const y = unwrapDeg(S, 'yaw');
    step[th] = { swing: -y[y.length - 1], peak: Math.max(...S.map((x) => -x.yr)) * RAD };   // right turn = yaw decreases
  }
  const exit = {};
  const TD = 1.6, T0 = 0.2, TH = 42, tRel = T0 + TD;
  for (const [name, mode] of FLAT_HANDS) {
    const cmd = (t) => (t < T0 - 0.15 ? 0 : t < tRel || mode === null ? TH : mode === 'ease' ? 15 : t < tRel + mode ? TH : 0);
    const { S, ev } = flatChain(shape, charDef, { cmd, btn: (t) => t >= T0 && t < tRel, T: tRel + 1.4 });
    const end = ev.find((e) => e.end !== undefined);
    if (!end) { exit[name] = null; continue; }
    const i0 = S.findIndex((x) => x.t >= end.t - 1e-9);
    const yp = unwrapDeg(S, 'path'), yn = unwrapDeg(S, 'yaw');
    const idx = (dt) => { const j = S.findIndex((x) => x.t >= S[i0].t + dt); return j < 0 ? S.length - 1 : j; };
    const at = (arr, dt) => -(arr[idx(dt)] - arr[i0]);
    let peak = -Infinity;
    for (let j = i0; j < S.length; j++) if (S[j].t >= S[i0].t + 0.15 && S[j].t <= S[i0].t + 1.0) peak = Math.max(peak, -S[j].yr * RAD);
    const j1 = idx(1.0), h0 = S[i0].path, dx = S[j1].x - S[i0].x, dz = S[j1].z - S[i0].z;
    exit[name] = { p3: at(yp, 0.3), p6: at(yp, 0.6), p10: at(yp, 1.0), n6: at(yn, 0.6), peak, lat: -(dx * Math.cos(h0) - dz * Math.sin(h0)) };
  }
  return { step, exit };
}

function runFlat() {
  const { key, def } = CHARS.find((c) => c.key === 'medium') || CHARS[0];
  const mh = KART_TUNE.driftMaxHeading, lt = KART_TUNE.exitLatchTime;
  KART_TUNE.driftMaxHeading = 0;             // the flat plane's road always points +z: a long drift circles
  let now, base;
  try {
    now = flatSuite(shapeSteer, def);
    KART_TUNE.exitLatchTime = 0;
    base = flatSuite(makeShape({ STEER_KNEE: 1, STEER_CAP: 1 }), def);
  } finally { KART_TUNE.driftMaxHeading = mh; KART_TUNE.exitLatchTime = lt; }
  console.log(`\n== Flat-plane steering (SPEC §15.1): ${key} (${def.id}) at top speed @${CFG.cc}cc, assist off, pad.js chain + 45 ms; 'v3' = v3 curve + no exit latch`);
  console.log(`  tilt step (wrist to θ for 0.4 s, back to 0): heading swing° (peak yaw °/s)          (40°÷10°)÷4`);
  console.log(`         ${FLAT_STEPS.map((x) => pad(`${x}°`, 13)).join('')}`);
  for (const [n, r] of [['now', now], ['v3', base]]) {
    console.log(`    ${padR(n, 4)} ${FLAT_STEPS.map((x) => pad(`${f1(r.step[x].swing)} (${f0(r.step[x].peak)})`, 13)).join('')}   ${f2(r.step[40].swing / r.step[10].swing / 4)}`);
  }
  console.log(`  drift exit (42° drift, release; hands re-centre at once / 0.15 / 0.3 s later, keep it, ease to 15°): path° @0.3/0.6/1 s | nose° @0.6 | peak yaw 0.15-1 s | lateral m @1 s`);
  for (const [n, r] of [['now', now], ['v3', base]]) {
    const cells = FLAT_HANDS.map(([h]) => { const e = r.exit[h]; return e ? `${h} ${f0(e.p3)}/${f0(e.p6)}/${f0(e.p10)} n${f0(e.n6)} pk${f0(e.peak)} ${f1(e.lat)}m` : `${h} no drift`; });
    console.log(`    ${padR(n, 4)} ${cells.join(' | ')}`);
  }
  return { char: key, now, base };
}

function flatGateFails(flat, gates) {
  const fails = [];
  for (const { key, v, src } of gates) {
    if (!FLAT_GATES[key]) continue;
    let val, what;
    try { [val, what] = FLAT_GATES[key](flat); } catch { val = NaN; what = key; }
    if (!(val <= v)) fails.push(`flat ${key}: ${what} ${f2(val)} > ${v} (${src})`);
  }
  return fails;
}

// ------------------------------------------------------------------ aggregate + print

function summarize(runs, style) {
  const all = runs.flatMap((r) => r.drifts).filter((d) => d.dur >= 0.15 || d.cancelled);   // drop released taps
  const ds = all.filter((d) => !d.wrong);                 // rotation stats: drifts in the corner's direction
  const laps = runs.flatMap((r) => r.lapTimes.slice(1));
  const lapCount = runs.reduce((a, r) => a + r.lapTimes.length + (r.done ? 0 : 1), 0);
  const tiers = [0, 0, 0, 0];
  for (const d of all) if (!d.cancelled) tiers[d.tier]++;
  const att = runs.reduce((a, r) => a + r.attempts, 0);
  const pct = (n, of) => (of ? (100 * n) / of : NaN);
  const why = {};
  for (const d of all) if (d.cancelled) why[d.cxlWhy] = (why[d.cxlWhy] || 0) + 1;
  return {
    style, runs: runs.length, dnf: runs.filter((r) => !r.done).length,
    lap: mean(laps), wallsPerLap: runs.reduce((a, r) => a + r.walls, 0) / Math.max(1, lapCount),
    attempts: att, drifts: all.length, noDrift: runs.reduce((a, r) => a + r.noDrift, 0), wrongDir: all.filter((d) => d.wrong).length,
    dur: mean(all.map((d) => d.dur)),
    overMean: mean(ds.map((d) => d.overDeg)), overMax: max(ds.map((d) => d.overDeg)),
    peakOverMean: mean(ds.map((d) => d.peakOverDeg)),
    aroundPct: pct(ds.filter((d) => d.peakOverDeg >= 180).length, ds.length),
    noseMean: mean(ds.map((d) => d.noseDeg)), trkMean: mean(ds.map((d) => d.trkDeg)),
    slipMean: mean(all.map((d) => d.maxSlipDeg)), slipMax: max(all.map((d) => d.maxSlipDeg)),
    devMean: mean(all.map((d) => d.maxDevDeg)), devMax: max(all.map((d) => d.maxDevDeg)),
    screenMean: mean(all.map((d) => d.maxScreenDeg)), screenMax: max(all.map((d) => d.maxScreenDeg)),
    spins: all.filter((d) => d.spin).length, spinPct: pct(all.filter((d) => d.spin).length, all.length),
    wallsPerDrift: all.length ? all.reduce((a, d) => a + d.walls, 0) / all.length : NaN,
    driftWallPct: pct(all.filter((d) => d.walls > 0).length, all.length),
    exitWallPct: pct(all.filter((d) => d.wallsPost > 0 && d.walls === d.wallsPost).length, all.length),
    cancelled: all.filter((d) => d.cancelled).length, cancelWhy: why,
    tiers, vminMean: mean(all.map((d) => d.vmin)), v0Mean: mean(all.map((d) => d.v0)),
    assistInto: mean(all.map((d) => d.assistInto).filter(Number.isFinite)),
    // after the release (SPEC §15.1)
    sw3: mean(all.map((d) => d.sw3).filter(Number.isFinite)), sw6: mean(all.map((d) => d.sw6).filter(Number.isFinite)), sw10: mean(all.map((d) => d.sw10).filter(Number.isFinite)),
    nw6: mean(all.map((d) => d.nw6).filter(Number.isFinite)), exOver: mean(all.map((d) => d.exOverMax)), inLat: mean(all.map((d) => d.inLat).filter((x) => x > -1e8)),
    steerRel: mean(all.map((d) => d.steerRel).filter(Number.isFinite)), yrRel: mean(all.map((d) => d.yrRel).filter(Number.isFinite)), yrPeak: mean(all.map((d) => d.yrPeak).filter((x) => x > -1e8)),
    exitIn: pct(all.filter((d) => d.wallsIn > 0).length, all.length), exitOut: pct(all.filter((d) => d.wallsOut > 0).length, all.length),
    edge1: pct(all.filter((d) => d.inEdge < 1.2).length, all.length),
    cruise: {
      steerRms: mean(runs.map((r) => r.cruise.steerRms)), revPerS: mean(runs.map((r) => r.cruise.revPerS)),
      hdgRms: mean(runs.map((r) => r.cruise.hdgRms)), yawRateRms: mean(runs.map((r) => r.cruise.yawRateRms)),
      latSd: mean(runs.map((r) => r.cruise.latSd).filter(Number.isFinite)), cornerErr: mean(runs.map((r) => r.cruise.cornerErr)),
      offroadPct: mean(runs.map((r) => r.cruise.offroadPct)),
    },
  };
}

const DRIFT_HDR = `    ${padR('style', 7)}${pad('lap s', 7)}${pad('wl/lap', 7)} ${pad('drf', 4)}${pad('miss', 5)}${pad('wrng', 5)}${pad('dur', 5)} ${pad('nose°', 6)}${pad('road°', 6)}${pad('over°', 6)}${pad('max', 5)}${pad('peak', 5)}${pad('360%', 5)} ${pad('slip°', 6)}${pad('max', 4)} ${pad('dev°', 5)} ${pad('scr°', 5)} ${pad('spin%', 6)}${pad('wall%', 6)} ${pad('vmin', 5)} ${padR(' tiers0/1/2/3', 14)}${pad('cxl', 4)}${pad('asIn', 6)}`;
function driftLine(r) {
  return `    ${padR(r.style, 7)}${pad(f1(r.lap), 7)}${pad(f2(r.wallsPerLap), 7)} ${pad(r.drifts, 4)}${pad(r.noDrift, 5)}${pad(r.wrongDir, 5)}${pad(f2(r.dur), 5)} ${pad(f0(r.noseMean), 6)}${pad(f0(r.trkMean), 6)}${pad(f0(r.overMean), 6)}${pad(f0(r.overMax), 5)}${pad(f0(r.peakOverMean), 5)}${pad(f0(r.aroundPct), 5)} ${pad(f0(r.slipMean), 6)}${pad(f0(r.slipMax), 4)} ${pad(f0(r.devMean), 5)} ${pad(f0(r.screenMean), 5)} ${pad(f0(r.spinPct), 6)}${pad(f0(r.driftWallPct), 6)} ${pad(f1(r.vminMean), 5)}  ${padR(r.tiers.join('/'), 13)}${pad(r.cancelled, 4)}${pad(Number.isFinite(r.assistInto) ? f2(r.assistInto) : '-', 6)}${r.dnf ? `  DNF ${r.dnf}` : ''}`;
}
const CRUISE_HDR = `    ${padR('style', 7)}${pad('lap s', 7)}${pad('wl/lap', 7)}  straights: ${pad('steerRMS', 8)}${pad('rev/s', 6)}${pad('hdgRMS°', 8)}${pad('yawRMS°/s', 10)}${pad('latSD m', 8)}   corners: ${pad('latErr m', 8)}  ${pad('offroad%', 8)}`;
function cruiseLine(r) {
  const c = r.cruise;
  return `    ${padR(r.style, 7)}${pad(f1(r.lap), 7)}${pad(f2(r.wallsPerLap), 7)}             ${pad(f2(c.steerRms), 8)}${pad(f2(c.revPerS), 6)}${pad(f1(c.hdgRms), 8)}${pad(f1(c.yawRateRms), 10)}${pad(f2(c.latSd), 8)}             ${pad(f2(c.cornerErr), 8)}  ${pad(f1(c.offroadPct), 8)}${r.dnf ? `  DNF ${r.dnf}` : ''}`;
}

// ------------------------------------------------------------------ main

let TRACE_DONE = false;
const t0 = Date.now();
console.log(`drift-probe @${CFG.cc}cc | pad.js: dead ${PAD.dead}° lock ${PAD.lock}° expo ${PAD.expo} lpf ${PAD.lpf}/s | kart: yawResponse ${KART_TUNE.yawResponse} driftWide ${KART_TUNE.driftWide} driftTight ${KART_TUNE.driftTight} driftCurve ${KART_TUNE.driftCurve} driftGrip ${KART_TUNE.driftGrip} | view driftYaw ${VIEW_TUNE.driftYaw} rad`);
if (overrides.length) console.log(`  overrides: ${overrides.join(', ')}`);
for (const w of PADSRC.warnings) console.log(`  WARNING: ${w} — the probe's phone mirror may be stale`);

const out = { config: { ...CFG, pad: PAD, human: HUMAN, overrides, padWarnings: PADSRC.warnings }, kinematics: null, corners: {}, rows: [], drifts: [] };
if (CFG.kin !== 'no') out.kinematics = printKinematics();
if (CFG.kin === 'only') { if (CFG.json) fs.writeFileSync(CFG.json, JSON.stringify(out, null, 1)); process.exit(0); }
if (CFG.flat !== 'no') out.flat = runFlat();

for (const id of CFG.flat === 'only' ? [] : CFG.tracks) {
  const track = getTrack(id);
  if (!CFG.brief) console.log(`\n== ${track.name} (${id}, ${track.length.toFixed(0)} m), ${CFG.seeds} seed(s) × ${CFG.laps} laps, drift corners: ${cornersOf(track).map((c) => c.name).join(', ')}`);
  if (CFG.corners && !CFG.brief) out.corners[id] = printCornerFit(track);
  for (const assist of CFG.assist) {
    for (const { key, def } of CHARS) {
      if (!CFG.brief) console.log(`\n  -- ${id} | assist ${assist ? 'ON' : 'OFF'} | ${key} (${def.id}, ${def.group})`);
      const rows = [];
      for (const style of CFG.styles) {
        const runs = [];
        for (let seed = 1; seed <= CFG.seeds; seed++) {
          if (CFG.trace && !TRACE_DONE) TRACE = ['t,s,lat,noseDev,camDev,thetaDeg,steer,speed,driftDir,mode,aimDeg'];
          runs.push(simulate({ track, charDef: def, assist, style, seed, laps: CFG.laps }));
          if (TRACE) { fs.writeFileSync(CFG.trace, TRACE.join('\n')); TRACE = null; TRACE_DONE = true; }
        }
        const row = summarize(runs, style);
        Object.assign(row, { track: id, assist, char: key, charId: def.id });
        rows.push(row);
        out.rows.push(row);
        for (const r of runs) for (const d of r.drifts) out.drifts.push({ track: id, assist, char: key, ...d });
        for (const r of runs) for (const c of r.missed) (out.missed || (out.missed = [])).push({ track: id, assist, char: key, style, corner: c });
        if (CFG.detail) {
          for (const r of runs) for (const d of r.drifts) {
            console.log(`      [${style} s${d.seed}] ${padR(d.corner, 20)} dir ${d.dir > 0 ? 'R' : 'L'}${d.wrong ? ' WRONG' : '      '} v0 ${f1(d.v0)} vmin ${f1(d.vmin)} dur ${f2(d.dur)} nose ${f0(d.noseDeg)}° road ${f0(d.trkDeg)}° over ${f0(d.overDeg)}° slip ${f0(d.maxSlipDeg)}° dev ${f0(d.maxDevDeg)}° scr ${f0(d.maxScreenDeg)}°${d.spin ? ' SPIN' : ''}${d.walls ? ` walls ${d.walls}` : ''} tier ${d.tier}${d.cancelled ? ' cxl' : ''}`);
          }
        }
      }
      const dr = rows.filter((r) => r.style !== 'cruise');
      const cr = rows.filter((r) => r.style === 'cruise');
      if (!CFG.brief) {
        if (dr.length) { console.log(DRIFT_HDR); for (const r of dr) console.log(driftLine(r)); }
        if (cr.length) { console.log(CRUISE_HDR); for (const r of cr) console.log(cruiseLine(r)); }
      }
      if (CFG.byCorner && dr.length) {
        const ds = out.drifts.filter((d) => d.track === id && d.assist === assist && d.char === key);
        const names = [...new Set(ds.map((d) => d.corner))];
        const ms = (out.missed || []).filter((d) => d.track === id && d.assist === assist && d.char === key);
        for (const m of ms) if (!names.includes(m.corner)) names.push(m.corner);
        console.log(`    by corner (all drift styles): corner  n  over°(mean/max)  dev°max  spin%  wall%  tier(mean)  wrong  missed`);
        for (const n of names) {
          const g = ds.filter((d) => d.corner === n);
          console.log(`      ${padR(n, 20)} ${pad(g.length, 3)} ${pad(f0(mean(g.map((d) => d.overDeg))), 6)}/${padR(f0(max(g.map((d) => d.overDeg))), 5)} ${pad(f0(max(g.map((d) => d.maxDevDeg))), 6)} ${pad(f0((100 * g.filter((d) => d.spin).length) / g.length), 6)} ${pad(f0((100 * g.filter((d) => d.walls > 0).length) / g.length), 6)} ${pad(f2(mean(g.map((d) => d.tier))), 6)} ${pad(g.filter((d) => d.wrong).length, 6)} ${pad(ms.filter((m) => m.corner === n).length, 7)}`);
        }
      }
    }
  }
}

// ---- overall: every track × character, per style and assist setting
function overallRows(rows) {
  const res = [];
  for (const assist of CFG.assist) {
    const rs = rows.filter((r) => r.assist === assist);
    for (const style of CFG.styles) {
      const g = rs.filter((r) => r.style === style);
      if (!g.length) continue;
      const sum = (f) => g.reduce((a, r) => a + f(r), 0);
      const m = (f) => mean(g.map(f).filter(Number.isFinite));
      const drf = sum((r) => r.drifts), att = sum((r) => r.attempts);
      const o = { assist, style, lap: m((r) => r.lap), wallsPerLap: m((r) => r.wallsPerLap) };
      if (style === 'cruise') {
        Object.assign(o, {
          steerRms: m((r) => r.cruise.steerRms), revPerS: m((r) => r.cruise.revPerS), hdgRms: m((r) => r.cruise.hdgRms),
          yawRateRms: m((r) => r.cruise.yawRateRms), latSd: m((r) => r.cruise.latSd), cornerErr: m((r) => r.cruise.cornerErr),
        });
      } else {
        Object.assign(o, {
          drifts: drf, wrongPct: (100 * sum((r) => r.wrongDir)) / Math.max(1, drf), missPct: (100 * sum((r) => r.noDrift)) / Math.max(1, att),
          over: m((r) => r.overMean), peak: m((r) => r.peakOverMean), aroundPct: m((r) => r.aroundPct), slip: m((r) => r.slipMean),
          screen: m((r) => r.screenMean), spinPct: m((r) => r.spinPct), wallPct: m((r) => r.driftWallPct), exitWallPct: m((r) => r.exitWallPct),
          cxlPct: (100 * sum((r) => r.cancelled)) / Math.max(1, drf), vmin: m((r) => r.vminMean),
          mtPct: (100 * sum((r) => r.tiers[1] + r.tiers[2] + r.tiers[3])) / Math.max(1, drf),
          sw3: m((r) => r.sw3), sw6: m((r) => r.sw6), sw10: m((r) => r.sw10), nw6: m((r) => r.nw6), exOver: m((r) => r.exOver), inLat: m((r) => r.inLat),
          steerRel: m((r) => r.steerRel), yrRel: m((r) => r.yrRel), yrPeak: m((r) => r.yrPeak), exitIn: m((r) => r.exitIn), exitOut: m((r) => r.exitOut), edge1: m((r) => r.edge1),
        });
      }
      res.push(o);
    }
  }
  return res;
}

if (out.rows.length) {
  out.overall = overallRows(out.rows);
  console.log(`\n== OVERALL (mean over ${CFG.tracks.join('+')} × ${CFG.chars.join('/')}; ${CFG.seeds} seed(s) × ${CFG.laps} laps each)`);
  for (const assist of CFG.assist) {
    const os = out.overall.filter((o) => o.assist === assist);
    const dr = os.filter((o) => o.style !== 'cruise');
    if (dr.length) {
      console.log(`  assist ${assist ? 'ON ' : 'OFF'} ${padR('style', 7)}${pad('lap s', 7)}${pad('wl/lap', 7)}${pad('wrng%', 6)}${pad('miss%', 6)}${pad('over°', 6)}${pad('peak', 5)}${pad('360%', 5)}${pad('slip°', 6)}${pad('scr°', 5)}${pad('spin%', 6)}${pad('wall%', 6)}${pad('exit%', 6)}${pad('cxl%', 5)}${pad('vmin', 5)}${pad('MT%', 5)}`);
      for (const o of dr) {
        console.log(`             ${padR(o.style, 7)}${pad(f1(o.lap), 7)}${pad(f2(o.wallsPerLap), 7)}${pad(f0(o.wrongPct), 6)}${pad(f0(o.missPct), 6)}${pad(f0(o.over), 6)}${pad(f0(o.peak), 5)}${pad(f0(o.aroundPct), 5)}${pad(f0(o.slip), 6)}${pad(f0(o.screen), 5)}${pad(f0(o.spinPct), 6)}${pad(f0(o.wallPct), 6)}${pad(f0(o.exitWallPct), 6)}${pad(f0(o.cxlPct), 5)}${pad(f1(o.vmin), 5)}${pad(f0(o.mtPct), 5)}`);
      }
      // after the release (SPEC §15.1): what the leftover tilt does in the first second
      console.log(`  assist ${assist ? 'ON ' : 'OFF'} EXIT   ${padR('style', 7)}${pad('steer', 6)}${pad('yaw→pk°/s', 11)}${pad('path° .3/.6/1', 15)}${pad('nose°.6', 8)}${pad('over+°', 7)}${pad('inLat m', 8)}${pad('edge%', 6)}${pad('in%', 6)}${pad('out%', 6)}`);
      for (const o of dr) {
        console.log(`             ${padR(o.style, 7)}${pad(f2(o.steerRel), 6)}${pad(`${f0(o.yrRel)}→${f0(o.yrPeak)}`, 11)}${pad(`${f0(o.sw3)}/${f0(o.sw6)}/${f0(o.sw10)}`, 15)}${pad(f1(o.nw6), 8)}${pad(f1(o.exOver), 7)}${pad(f2(o.inLat), 8)}${pad(f0(o.edge1), 6)}${pad(f1(o.exitIn), 6)}${pad(f1(o.exitOut), 6)}`);
      }
    }
    for (const o of os.filter((x) => x.style === 'cruise')) {
      console.log(`  assist ${assist ? 'ON ' : 'OFF'} cruise  lap ${f1(o.lap)} s, ${f2(o.wallsPerLap)} walls/lap | straights: steerRMS ${f2(o.steerRms)}, ${f2(o.revPerS)} reversals/s, heading RMS ${f1(o.hdgRms)}°, yaw-rate RMS ${f1(o.yawRateRms)}°/s, lateral SD ${f2(o.latSd)} m | corners: line error ${f2(o.cornerErr)} m`);
    }
  }
  console.log(`  (wrng% / miss% of drifts / corner attempts; wall% drifts with a wall hit in the drift or 1 s after, exit% only after the release; MT% drifts released with a mini-turbo; cxl% drifts cancelled by the kart)`);
  console.log(`  (EXIT: steer·dir and yaw rate into the old turn at the release → peak in the next 1 s; path / nose swing into the old turn 0.3/0.6/1 s after it; over+ extra nose-vs-road;`);
  console.log(`   inLat m moved toward the inside; edge% drifts that came within 1.2 m of the inside road edge; in% / out% drifts with an inside / outside wall hit within 1 s of the release)`);
}

// ---- optional gates on the OVERALL rows: --gate spin=10,over=45,cruiseYaw=20,mt=40 (mt = minimum)
// A key may be narrowed to one style and / or assist setting: key@style:on=v (e.g. wallsPerLap@r100:on=0.3).
// Flat-plane keys (FLAT_GATES) check the tilt-step / drift-exit tests instead.
let gateFails = 0;
if (CFG.gate) {
  const G = CFG.gate.split(',').filter(Boolean).map((kv) => {
    const [lhs, b] = kv.split('=');
    const m = lhs.match(/^([A-Za-z0-9]+)(?:@([a-z0-9]+))?(?::(on|off))?$/);
    if (!m || !Number.isFinite(Number(b))) { console.error(`bad --gate entry '${kv}'`); process.exit(2); }
    return { key: m[1], style: m[2] || null, assist: m[3] ? m[3] === 'on' : null, v: Number(b), src: kv };
  });
  const MAXK = { exit: 'exitWallPct', spin: 'spinPct', over: 'over', peak: 'peak', around: 'aroundPct', wall: 'wallPct', cxl: 'cxlPct', wrong: 'wrongPct', miss: 'missPct', screen: 'screen', wallsPerLap: 'wallsPerLap', exitIn: 'exitIn', exitOut: 'exitOut', exitPath: 'sw6' };
  const CRK = { cruiseYaw: 'yawRateRms', cruiseSteer: 'steerRms', cruiseRev: 'revPerS', cruiseWalls: 'wallsPerLap' };
  const fails = [];
  for (const o of out.overall || []) {
    for (const { key: g, style, assist, v } of G) {
      if ((style && style !== o.style) || (assist !== null && assist !== o.assist)) continue;
      // mid-corner releases (relFrac styles) charge less and press like `follow` by design: only
      // explicitly qualified mt / miss gates apply to them
      if (!style && (g === 'mt' || g === 'miss') && STYLES[o.style] && STYLES[o.style].relFrac) continue;
      if (o.style === 'cruise' && CRK[g] && o[CRK[g]] > v) fails.push(`${o.style} assist ${o.assist ? 'ON' : 'OFF'}: ${g} ${f2(o[CRK[g]])} > ${v}`);
      if (o.style !== 'cruise' && MAXK[g] && o[MAXK[g]] > v) fails.push(`${o.style} assist ${o.assist ? 'ON' : 'OFF'}: ${g} ${f1(o[MAXK[g]])} > ${v}`);
      if (o.style !== 'cruise' && g === 'mt' && o.mtPct < v) fails.push(`${o.style} assist ${o.assist ? 'ON' : 'OFF'}: mt ${f1(o.mtPct)} < ${v}`);
    }
  }
  if (out.flat) fails.push(...flatGateFails(out.flat, G));
  const unknown = G.filter((g) => !(g.key in MAXK) && !(g.key in CRK) && g.key !== 'mt' && !(g.key in FLAT_GATES));
  for (const g of unknown) fails.push(`unknown gate key '${g.key}'`);
  gateFails = fails.length;
  console.log(fails.length ? `\nGATES: FAIL (${fails.length})\n  ${fails.join('\n  ')}` : `\nGATES: PASS (${CFG.gate})`);
}

if (!CFG.brief) {
  console.log(`\nlegend: wl/lap wall hits per lap (all laps) | drf drifts started, miss corners where DRIFT was held but no drift started, wrng drifts in the wrong direction | dur s |`);
  console.log(`  nose°/road° rotation into the corner over the drift, over° = nose − road at release (mean, max), peak = mean of the max over-rotation during the drift, 360% = drifts whose peak over-rotation reached 180° (all from correct-direction drifts) |`);
  console.log(`  slip° max nose-vs-velocity angle (mean, max) | dev° max nose vs track tangent (drift + 1.5 s, mean) |`);
  console.log(`  scr° max on-screen kart angle vs camera (incl. kartview drift yaw) | spin% drifts with nose > 90° off the road or moving backwards (drift + 1.5 s) | wall% drifts with a wall hit (drift + 1 s) |`);
  console.log(`  vmin m/s min speed in the drift | tiers mini-turbo tier at release | cxl cancelled | asIn mean (assisted − player steer)·dir in drifts (+ = assist adds INTO the turn)`);
  console.log(`  cruise: steerRMS / rev/s (sign reversals of |steer|>0.04) / hdgRMS° nose vs road / yawRMS°/s / latSD m lateral std per straight pass | latErr m vs the aimed line in corners`);
}
if (CFG.json) { fs.writeFileSync(CFG.json, JSON.stringify(out, null, 1)); console.log(`wrote ${CFG.json}`); }
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(gateFails ? 1 : 0);
