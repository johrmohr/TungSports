// CPU drivers. Node-safe (no DOM): used by the game and tools/sim.mjs.
//
//   const ai = new AIDriver(kart, { track, difficulty: 'normal', skill: 0.7, rng, personality });
//   // per physics substep, BEFORE items.update() and kart.update():
//   ai.update(dt, { karts, items, race, humans, hazards });   // writes kart.input
//   (hazards: the track's course hazards from hazards.js createHazards, or null)
//
// Or build the whole CPU field at once (skills spread around the difficulty's
// aiSkill, personalities per character; the engine class picks the difficulty):
//   const drivers = createAIDrivers(karts, { track, cc: 100, rng, humans });
// CPU karts drive real parts: cpuLoadout(def, setSeed) picks one of the
// racer's CPU_PRESETS (parts.js) per race set.
//
// Driving model (SPEC §8):
//   * line: track.racingLine blended with a personal offset that wanders
//     slowly, plus a smoothed "avoid" offset (hazards, karts to pass, item
//     boxes, boost pads),
//   * pure-pursuit steering at lookahead 6 m + 0.45 × speed, converted to a
//     steer value with the same speed->turn-rate curve kart.js uses,
//   * speed: lifts / brakes when the planned path ahead is tighter than the
//     kart can turn at its current speed,
//   * hop-drifts long corners (corner map pre-computed per track) for tier
//     1-3 mini-turbos, mapping the required yaw rate onto drift tightness,
//   * course hazards (Krishiv's Palace crushers / flame arms / geysers, ctx.hazards):
//     times the pass on the deterministic hazard clock and moves to an open
//     line (or lifts off) in time; each hazard is spotted with a skill-weighted
//     chance per lap, so CPUs still get caught now and then (_courseHazards),
//   * jump tricks off ramps (probability = skill),
//   * items per type (v5 plugin items: their handler's aiUse(kart, ctx), see
//     _aiUseCtx; their threats carry a `clear` distance and are dodged like
//     peels), difficulty via kart.speedMult + rubber banding vs the
//     LEADING human (vs the pack average without humans, e.g. the sim); a
//     human kart driven by an AIDriver (disconnected phone) keeps pace 1.0,
//   * stuck recovery: reverse-and-steer after 2 s, respawn after 5 s (or no
//     forward progress for a long time).

import { DIFFICULTY, DRIFT, KART } from './config.js';
import { KART_TUNE, driftTightness, driftSteerFor, driftMaxYawRate } from './kart.js';
import { CPU_PRESETS, getEngineClass } from './parts.js';
import { clamp, damp, angleDiff, smoothstep, randRange, TAU } from './utils.js';
import { getItemHandler, itemHandlers, itemSystems } from './items/registry.js';

export const AI_TUNE = {
  lookBase: 6,
  lookGain: 0.45,
  edgeMargin: 1.0,          // planned line stays this far inside the road edge
  dodgeMargin: -0.5,        // ... except when dodging (may use the curb)
  dodgeLook: 0.7,           // lookahead scale while dodging a hazard
  // speed control
  turnHeadroom: 0.93,       // use at most this fraction of the kart's turn rate before lifting
  liftSlack: 0.6,           // m/s over the corner speed before lifting
  brakeSlack: 4.5,          // m/s over the corner speed before braking
  // drifting
  driftMaxRadius: 52,       // only corners tighter than this (centerline) are drifted
  cornerCurv: 1 / 75,       // |curvature| that counts as "in a corner" for the corner map
  driftLead: 0.22,          // s: start the hop this long before the corner
  driftMinExtra: 0.35,      // s beyond tier-1 time the corner must last
  driftRelease: 0.12,       // s before the corner ends to release
  driftBiasRate: 1.6,       // 1/s: how fast a wide drift pulls the line to the inside
  pulseSkill: 0.55,         // skill from which a CPU pulses the wheel "into" wide drifts (fast charge)
  pulseHold: 0.12,          // s: shortest wheel pulse (+ sloppiness for lower skill)
  // avoidance
  hazardLook: 1.15,         // s of travel scanned for hazards (+ 8 m)
  kartLook: 16,             // m ahead considered for passing
  passGap: 2.9,             // lateral clearance when passing a kart
  sideGap: 2.5,             // lateral spacing kept from a kart alongside
  avoidRateHazard: 5.5,     // 1/s smoothing of the avoid offset when dodging
  avoidRate: 2.4,
  // course hazards (Krishiv's Palace crushers / flame arms / geysers, ctx.hazards = hazards.js)
  courseLook: 2.2,          // s of travel scanned (+ 10 m)
  courseEvery: 0.08,        // s between re-plans
  courseReach: 1.2,         // m added before / after each hazard's reach for the traversal window
  courseClear: 0.45,        // m added to the kart radius in the hit tests ...
  courseWide: 1.2,          // ... and this much more for the near-miss test (room to spare)
  courseSlack: 0.18,        // s: also clear when arriving this much earlier / later ...
  courseSlackGrow: 0.2,     // ... plus this share of the time to get there (speed changes)
  courseStep: 0.75,         // m between the lateral lines tried
  courseRow: 8,             // m: hazards this close behind the nearest one ahead are planned together
  courseMargin: 0.4,        // m the lines tried stay inside the road edge (curbs allowed)
  courseShift: 3.5,         // m/s the kart is assumed to slide sideways toward a new line
  courseLift: 0.72,         // nothing open at this speed: try arriving at this share of it (lift off)
  courseSpot: [0.75, 0.25], // chance to spot a hazard on a pass = a + b·skill (per hazard, per lap)
  // items
  bouncerMaxTurn: 0.6,      // rad (~35 deg): max road heading change from us to a bouncer target ...
  bouncerClear: 15,         // ... and this many m past it (a miss must not rebound off a corner wall)
  bunchDropGap: 6,          // s: a Banana Bunch drops a peel at least this often (sooner with a kart close behind)
  bombAhead: [12, 30],      // m: a Meatball Bomb is lobbed at a rival this far ahead ...
  bombCone: 0.44,           // ... within this bearing (rad, ~25 deg)
  bombHold: 8,              // ... or after holding it this long
  accordionHold: 15,        // s: an Accordion Blast is used after this long anyway
  beerFinishKeep: 150,      // m: no Beer Rocket this close to the finish on the final lap
  capoDodgeSkill: 0.5,      // chance (x skill) a CPU times a boost under a winding-up Capo Crusher
  // Espresso Splash on a CPU's "screen": a slow wobble, shorter look-ahead, worse hazard spotting
  inkWobble: 1.2,           // m
  inkWobbleHz: 0.5,
  inkLook: 0.7,
  inkSkill: 0.2,
  // pace
  rubberNear: 55,           // m: no rubber band inside this gap
  rubberFar: 210,           // m: full rubber band beyond this gap
  paceRate: 0.8,            // 1/s smoothing of kart.speedMult
  // extra CPU pace per difficulty on top of DIFFICULTY.aiSpeedMult (CPUs drift
  // and use boosts well, so their raw pace is trimmed to stay beatable)
  difficultyPace: { easy: 0.965, normal: 0.96, hard: 0.98 },   // hard 0.985 -> 0.98 with the drift fix (notes/drift-fix.md)
  finishedPace: 0.86,       // cruise after crossing the line
  // stuck recovery
  stuckSpeed: 2,
  stuckTime: 2,
  reverseTime: 1.1,
  respawnTime: 5,
  noProgressTime: 7,        // s without 4 m of forward progress -> respawn
};

const T = AI_TUNE;
// Multi-use items: [min, max] s between presses.
const ITEM_GAPS = { triple_toot: [0.7, 1.4], triple_bouncer: [0.6, 1.2], triple_rocket: [0.8, 1.5], triple_banana: [1.0, 2.0] };

// Per-character driving styles: lateral offset bias + wander amplitude (m),
// racing-line commitment (0 = centerline .. 1 = full racing line),
// aggression (bumping, item eagerness), drift eagerness, item smarts, pace.
export const AI_PERSONALITIES = {
  // ---- Light
  // Farfallina — dreamy and floaty, but surprisingly fierce in a scrap
  ballerina: { offset: -0.8, wander: 1.9, line: 0.92, aggression: 0.6, drift: 0.95, items: 0.8, pace: 1.0 },
  // Gufetto — polite and precise: hugs the racing line, drifts neatly
  cappuccino: { offset: 0.4, wander: 1.0, line: 1.0, aggression: 0.3, drift: 0.9, items: 0.85, pace: 1.0 },
  // Rotolino — giggly, rolls all over the road
  trippi: { offset: 1.6, wander: 2.0, line: 0.85, aggression: 0.55, drift: 0.8, items: 0.75, pace: 1.0 },
  // Criceto — snacky: darts for every item box
  chimpanzini: { offset: -1.5, wander: 1.6, line: 0.9, aggression: 0.4, drift: 0.85, items: 0.95, pace: 1.0 },
  // ---- Medium
  // Ruggero (lead) — brave and tidy, sharp drifts, smart with items, races to win
  sahur: { offset: -0.3, wander: 1.0, line: 0.97, aggression: 0.6, drift: 0.95, items: 0.95, pace: 1.0 },
  // Ronzella — zippy and chatty, buzzes around the pack
  tralalero: { offset: 0.9, wander: 1.8, line: 0.9, aggression: 0.5, drift: 0.9, items: 0.85, pace: 1.0 },
  // Pecorino — unflappable: steady lines, rarely rattled
  bananita: { offset: -1.1, wander: 0.8, line: 0.95, aggression: 0.35, drift: 0.8, items: 0.7, pace: 1.0 },
  // Pavone — show-off: drifts every corner it can
  lirili: { offset: 1.3, wander: 1.5, line: 0.88, aggression: 0.65, drift: 1.0, items: 0.8, pace: 1.0 },
  // ---- Heavy
  // Lamapisa — gentle and a bit wobbly
  patapim: { offset: 0.6, wander: 1.4, line: 0.85, aggression: 0.4, drift: 0.7, items: 0.7, pace: 1.0 },
  // Ippolino — chill, slow to start, unstoppable once rolling
  saturnita: { offset: -0.6, wander: 0.9, line: 0.8, aggression: 0.8, drift: 0.6, items: 0.65, pace: 1.0 },
  // Tricheco — loud and proud: barges through the pack
  bombardiro: { offset: 1.8, wander: 1.2, line: 0.78, aggression: 0.9, drift: 0.6, items: 0.8, pace: 1.0 },
  // Colosseo — stubborn: holds its line and shoves rivals aside
  gusini: { offset: -1.6, wander: 1.0, line: 0.75, aggression: 1.0, drift: 0.55, items: 0.7, pace: 1.0 },
};

const DEFAULT_PERSONALITY = { offset: 0, wander: 1.2, line: 0.9, aggression: 0.5, drift: 0.8, items: 0.8, pace: 1.0 };

// ------------------------------------------------------------ track analysis

// Corner map shared by all drivers on a track: for every sample the signed
// centerline curvature, the remaining length of the corner it belongs to and
// a corner id (index of the corner's first sample).
const _analysis = new WeakMap();

function analyzeTrack(track) {
  let a = _analysis.get(track);
  if (a) return a;
  const N = track.N, sp = track.spacing, curv = track.curv;
  const inCorner = (i) => Math.abs(curv[i]) > T.cornerCurv;
  const run = new Float32Array(N);
  const id = new Int32Array(N).fill(-1);
  // remaining corner length (two passes around the loop for wrap-around)
  for (let pass = 0; pass < 2; pass++) {
    for (let k = N - 1; k >= 0; k--) {
      const i = k, j = (k + 1) % N;
      if (!inCorner(i)) { run[i] = 0; continue; }
      run[i] = inCorner(j) && Math.sign(curv[j]) === Math.sign(curv[i]) ? run[j] + sp : sp;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < N; i++) {
      if (!inCorner(i)) { id[i] = -1; continue; }
      const p = (i - 1 + N) % N;
      id[i] = inCorner(p) && Math.sign(curv[p]) === Math.sign(curv[i]) && id[p] >= 0 ? id[p] : i;
    }
  }
  a = { run, id };
  _analysis.set(track, a);
  return a;
}

// Curvature (1/m, + = right turn) of the circle through three XZ points.
function curvature3(ax, az, bx, bz, cx, cz) {
  const abx = bx - ax, abz = bz - az, bcx = cx - bx, bcz = cz - bz, cax = ax - cx, caz = az - cz;
  const cross = abx * bcz - abz * bcx;          // > 0: turning left (x right, z forward => sign check below)
  const den = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(cax, caz);
  if (den < 1e-6) return 0;
  // right = (-cos yaw, 0, sin yaw): a right turn has cross > 0 in (x, z) for this convention
  return (2 * cross) / den;
}

// Deterministic 0..1 hash of two integers (hazard noticing, per-encounter dice).
function hash01(a, b) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ driver

export class AIDriver {
  constructor(kart, { track, difficulty = 'normal', skill = 0.7, rng = Math.random, personality = {} } = {}) {
    this.kart = kart;
    this.track = track || kart.track;
    this.difficulty = DIFFICULTY[difficulty] ? difficulty : 'normal';
    this.diff = DIFFICULTY[this.difficulty];
    this.skill = clamp(skill, 0.05, 1);
    this.rng = rng;
    const base = (kart.character && AI_PERSONALITIES[kart.character.id]) || DEFAULT_PERSONALITY;
    this.personality = { ...DEFAULT_PERSONALITY, ...base, ...personality };
    this.analysis = analyzeTrack(this.track);
    this.seed = (rng() * 0x7fffffff) | 0;

    const P = this.personality;
    // slow lateral wander (two incommensurate sines) + skill-dependent sloppiness
    this.wanderW1 = randRange(rng, 0.35, 0.6);
    this.wanderW2 = randRange(rng, 0.9, 1.4);
    this.wanderP1 = rng() * TAU;
    this.wanderP2 = rng() * TAU;
    this.noiseAmp = (1 - this.skill) * 1.3;
    this.noiseW = randRange(rng, 0.5, 0.9);
    this.noiseP = rng() * TAU;
    this.pace = (P.pace || 1) * (0.99 + 0.02 * this.skill) * (T.difficultyPace[this.difficulty] || 1);

    this.time = 0;
    this.offset = 0;          // personal line offset this step (m, + right)
    this.avoid = 0;           // smoothed extra offset (m)
    this.avoidUrgent = false;
    // drift state machine: 'drive' | 'hop' | 'drift'
    this.driftState = 'drive';
    this.driftDir = 0;
    this.hopTime = 0;
    this.driftCooldown = 0;
    this._cornerId = -2;
    this._cornerDrift = false;
    this.driftEntered = false;
    this.driftTime = 0;
    this.wideTime = 0;
    this.driftBias = 0;
    // items
    this.itemHold = 0;
    this.itemReaction = -1;
    this.itemGap = 0;
    // start
    this.startPressAt = null;
    // stuck
    this.stuckTime = 0;
    this.maxStuck = 0;
    this.recoverTimer = 0;
    this.recoverSteer = 0;
    this.recoverCooldown = 0;
    this.progressMark = -Infinity;
    this.noProgress = 0;
    this.respawns = 0;
    this._hasRace = false;
    // drift wheel pulses (fast charge on wide drifts) + jump tricks
    this._pwmAcc = 0;
    this._pwmHigh = false;
    this._pwmHold = 0;
    this._trickRoll = null;   // decided once per jump: try a trick?
    this._trickDone = false;
    // stats (sim)
    this.drifts = 0;
    this.tricks = 0;

    // scratch (no per-step allocations)
    this._f = {};
    this._f2 = {};
    this._pt = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
    this._pts = new Float32Array(10);
    this._yawReq = 0;
    this._alpha = 0;
    this._cWant = 0;
    this._cUrgency = 0;
    this._cHazard = false;
    this._hzCool = 0;         // course-hazard planner (ctx.hazards): re-plan timer, held choice, lift flag
    this._hzWant = 0;
    this._hzUrg = 0;
    this._hzLift = false;
  }

  // ------------------------------------------------------------- update

  update(dt, ctx = {}) {
    if (!(dt > 0)) return;
    const k = this.kart, tr = this.track, inp = k.input;
    const race = ctx.race || null;
    this._hasRace = !!race;
    this.time += dt;
    if (!k.proj || k.proj.s === undefined) { tr.project(k.position, k.hint, k.proj); k.hint = k.proj.index; }
    inp.useItem = false;

    const state = race ? race.state : 'racing';
    if (k.frozen || state === 'intro' || state === 'countdown') { this._prestart(race); return; }

    this._updatePace(dt, ctx);
    if (this.driftCooldown > 0) this.driftCooldown -= dt;
    if (this.recoverCooldown > 0) this.recoverCooldown -= dt;

    if (k.isDisabled() || k.beer) {
      // nothing to steer (spinning / tumbling, or riding a Beer Rocket: items.js
      // drives it); keep the foot down so it recovers quickly
      inp.steer = 0; inp.throttle = 1; inp.brake = 0; inp.drift = false;
      this.driftState = 'drive';
      this.stuckTime = 0;
      this._trackProgress(dt, true);
      return;
    }
    if (this._handleStuck(dt)) return;

    // ---- plan
    const v = Math.max(0, k.speed);
    const s = k.proj.s;
    this._updateOffset();
    this._updateAvoid(dt, ctx, s, v);

    // ---- pure-pursuit steering
    // shorter lookahead while dodging = sharper lateral response (and with coffee on the screen)
    const Ld = (T.lookBase + T.lookGain * v) * (this.avoidUrgent ? T.dodgeLook : 1) * (k.ink > 0 ? T.inkLook : 1);
    const sT = s + Ld;
    let latT = this._plannedLat(sT, this.avoidUrgent ? T.dodgeMargin : T.edgeMargin);
    if (this.driftState === 'drift' && this.driftBias > 0) {
      // drifting a wide corner: pull the line toward the inside so the drift has work to do
      const f = tr.frameAt(sT, this._f);
      latT += (this.driftDir * Math.max(0, f.halfWidth - T.edgeMargin) - latT) * this.driftBias;
    }
    const pt = tr.pointAt(sT, latT, this._pt);
    const dx = pt.x - k.position.x, dz = pt.z - k.position.z;
    const dist = Math.max(1, Math.hypot(dx, dz));
    // aim from the direction of travel while sliding (the nose points inside it)
    const hs = Math.hypot(k.velocity.x, k.velocity.z);
    const heading = (this.driftState === 'drift' || k.drift.active) && hs > 5 ? Math.atan2(k.velocity.x, k.velocity.z) : k.yaw;
    const alpha = angleDiff(heading, Math.atan2(dx, dz));        // + = target to the LEFT
    let yawReq = ((2 * Math.sin(alpha)) / dist) * Math.max(v, 4);  // + = turn left
    if (Math.abs(alpha) > 1.3) yawReq = Math.sign(alpha) * 10;     // way off: full lock toward the line
    this._yawReq = yawReq;
    this._alpha = alpha;
    const st = k.stats;
    const fs = this._turnFactor(v);
    let steer = clamp(-yawReq / (st.turnRate * fs), -1, 1);

    // ---- speed control from the curvature of the planned path ahead
    let throttle = 1, brake = 0;
    if (this.driftState !== 'drift' && v > 8) {
      const kap = this._pathCurvatureAhead(s, v, Ld);
      if (kap > 1e-4) {
        const vAllowed = (T.turnHeadroom * st.turnRate * fs) / kap;
        if (v > vAllowed + T.liftSlack) throttle = 0;
        if (v > vAllowed + T.brakeSlack) brake = clamp((v - vAllowed - T.brakeSlack) / 6, 0, 1);
      }
    }
    if (Math.abs(alpha) > 0.75) throttle = Math.min(throttle, 0.55);
    if (this._hzLift && this.driftState !== 'drift') throttle = 0;   // let a crusher / jet go by first
    if (Math.abs(alpha) > 1.5 && v > 9) brake = Math.max(brake, 0.5);

    // ---- drifting
    const drift = this._drift(dt, s, v, steer);
    if (drift.active) {
      steer = drift.steer;
      throttle = drift.throttle;
      brake = 0;
    }

    inp.steer = steer;
    inp.throttle = throttle;
    inp.brake = brake;
    inp.drift = drift.button || this._trick(k);
    this._trackProgress(dt, false);

    // ---- items
    this._items(dt, ctx, s, v);
  }

  // ------------------------------------------------------------ helpers

  // Jump trick (SPEC §14.3d): once per launch, with probability = skill, tap
  // DRIFT shortly after leaving the ground (not on a drift hop).
  _trick(k) {
    if (k.grounded) { this._trickRoll = null; this._trickDone = false; return false; }
    if (k.drift.hopping || k.drift.active || this.driftState !== 'drive' || this._trickDone) return false;
    if (k.airTime > DRIFT.trickWindow) return false;
    if (this._trickRoll === null) this._trickRoll = this.rng() < this.skill;
    if (!this._trickRoll || k.airTime < 0.05) return false;
    this._trickDone = true;
    this.tricks++;
    return true;
  }

  _turnFactor(v) {
    let f = Math.min(1, Math.max(v, 1) / KART_TUNE.turnRefSpeed);
    f *= 1 - KART_TUNE.highSpeedTurnLoss * clamp((v - 12) / 18, 0, 1);
    return f;
  }

  // personal offset: bias + slow wander + sloppiness (low skill) + a coffee wobble
  _updateOffset() {
    const P = this.personality, t = this.time;
    const wander = P.wander * (0.7 * Math.sin(t * this.wanderW1 + this.wanderP1) + 0.3 * Math.sin(t * this.wanderW2 + this.wanderP2));
    const noise = this.noiseAmp * Math.sin(t * this.noiseW + this.noiseP) * Math.sin(t * 0.37 + this.noiseP * 2);
    const ink = this.kart.ink > 0 ? this.kart.ink * T.inkWobble * Math.sin(t * TAU * T.inkWobbleHz + this.wanderP1) : 0;
    this.offset = P.offset + wander + noise + ink;
  }

  // Lateral the driver wants at arc length s, before avoidance.
  _baseLat(s, frame) {
    const f = frame || this.track.frameAt(s, this._f2);
    const lim = Math.max(0, f.halfWidth - T.edgeMargin);
    return clamp(this.personality.line * f.racingLine + this.offset, -lim, lim);
  }

  _plannedLat(s, margin) {
    const f = this.track.frameAt(s, this._f2);
    const lim = Math.max(0, f.halfWidth - margin);
    return clamp(this._baseLat(s, f) + this.avoid, -lim, lim);
  }

  // Max |curvature| of the planned path between ~0.5 lookahead and ~1 s beyond it.
  _pathCurvatureAhead(s, v, Ld) {
    const tr = this.track, P = this._pts;
    const a = s + Ld * 0.5;
    const span = Math.max(6, (Ld * 0.5 + v * 0.9) / 4);
    for (let i = 0; i < 5; i++) {
      const si = a + span * i;
      const p = tr.pointAt(si, this._plannedLat(si, T.edgeMargin), this._pt);
      P[i * 2] = p.x; P[i * 2 + 1] = p.z;
    }
    let kmax = 0;
    for (let i = 0; i < 3; i++) {
      const c = Math.abs(curvature3(P[i * 2], P[i * 2 + 1], P[i * 2 + 2], P[i * 2 + 3], P[i * 2 + 4], P[i * 2 + 5]));
      if (c > kmax) kmax = c;
    }
    return kmax;
  }

  // Whether this driver spots a given hazard (fixed per hazard: no flicker).
  // Big green clouds are hard to miss; peels and balls depend on skill.
  _notices(uid, type) {
    const skill = this.kart.ink > 0 ? Math.max(0.05, this.skill - T.inkSkill) : this.skill;
    const p = type === 'stink' ? 0.9 + 0.1 * skill : 0.5 + 0.48 * skill * (0.6 + 0.4 * this.personality.items);
    return hash01(uid, this.seed) < p;
  }

  // ------------------------------------------------------------ avoidance

  // Pick the most urgent reason to shift off the base line and ease the avoid
  // offset toward it: hazards > karts to pass / alongside > boost pads > item boxes.
  _updateAvoid(dt, ctx, s, v) {
    const k = this.kart, tr = this.track;
    this._cWant = 0; this._cUrgency = 0; this._cHazard = false;

    // ---- hazards (bananas, stink clouds, bouncers coming at us)
    const items = ctx.items;
    if (items) {
      const look = 8 + v * T.hazardLook;
      const threats = items.getThreatsNear(k, look + 6);
      for (let i = 0; i < threats.length; i++) {
        const t = threats[i];
        if (!t.ahead) continue;
        // hazards hit when the kart CENTER enters their radius
        let clear;
        if (t.type === 'banana') clear = t.radius + 0.95;
        else if (t.type === 'stink') clear = t.radius + 1.0;
        else if (t.type === 'bomb') clear = t.radius + 1.2;
        else if (t.type === 'bouncer') {
          // only dodge balls rolling toward us
          if (t.dirX * Math.sin(k.yaw) + t.dirZ * Math.cos(k.yaw) > -0.2) continue;
          clear = 2.8;
        } else if (t.clear > 0) {
          // v5 plugin threats (items.js entities / threats hooks): moving ones only when coming at us
          if (t.speed > 1 && t.dirX * Math.sin(k.yaw) + t.dirZ * Math.cos(k.yaw) > -0.2) continue;
          clear = t.clear;
        } else continue;
        const ds = tr.deltaS(s, t.s);
        if (ds < 0.5 || ds > look) continue;
        if (!this._notices(t.ref.uid, t.type)) continue;
        const f = tr.frameAt(t.s, this._f);
        const base = this._baseLat(t.s, f);
        const pl = clamp(base + this.avoid, -f.halfWidth, f.halfWidth);
        // needed while either the base line or the current plan would hit
        // (judging the plan alone would drop the dodge the moment it clears)
        if (Math.abs(base - t.lateral) >= clear && Math.abs(pl - t.lateral) >= clear) continue;
        const lim = f.halfWidth - T.dodgeMargin;
        let side = pl - t.lateral >= 0 ? 1 : -1;     // keep to the side we're already on
        let target = t.lateral + side * clear;
        if (Math.abs(target) > lim) {
          const alt = t.lateral - side * clear;
          target = Math.abs(alt) <= lim ? alt : clamp(target, -lim, lim);
        }
        this._consider(target - base, 2 - ds / look, true);   // always outranks karts
      }
    }

    // ---- course hazards (crushers, flame arms, lava geysers): time the pass
    const hz = ctx.hazards;
    if (hz && hz.list && hz.list.length && typeof hz.hitAt === 'function') this._courseHazards(dt, hz, s, v);
    else { this._hzLift = false; this._hzNear = false; }

    // ---- other karts: pass the ones we're catching, give room alongside
    const karts = ctx.karts;
    if (karts) {
      const myLat = k.proj.lateral, P = this.personality;
      for (let i = 0; i < karts.length; i++) {
        const o = karts[i];
        if (o === k || !o.proj || o.proj.s === undefined) continue;
        const ds = tr.deltaS(s, o.proj.s);
        if (ds < -3 || ds > T.kartLook) continue;
        const oLat = o.proj.lateral;
        const f = tr.frameAt(o.proj.s, this._f);
        const lim = f.halfWidth - T.edgeMargin;
        if (ds > 1.8) {
          const closing = v - o.speed;
          if (closing < 0.4 && ds > 6) continue;
          const pl = this._baseLat(o.proj.s, f) + this.avoid;
          const dl = pl - oLat;
          if (Math.abs(dl) >= T.passGap) continue;
          // pass on the side we already favour; flip if the road runs out
          let side = Math.abs(dl) > 0.35 ? Math.sign(dl) : (P.offset >= 0 ? 1 : -1);
          let target = oLat + side * T.passGap;
          if (Math.abs(target) > lim) { side = -side; target = clamp(oLat + side * T.passGap, -lim, lim); }
          this._consider(target - this._baseLat(o.proj.s, f), 0.85 * (1 - ds / T.kartLook) + 0.1, false);
        } else {
          const dl = myLat - oLat;
          if (Math.abs(dl) >= T.sideGap + 0.8) continue;
          // heavy, aggressive drivers lean into lighter karts; others keep a gap
          const bully = P.aggression > 0.65 && k.stats.mass > o.stats.mass + 0.15 &&
            hash01(this.seed, (this.time * 0.5) | 0) < (P.aggression - 0.5) * this.diff.itemAggression;
          const target = bully ? oLat + Math.sign(dl || 1) * 1.6 : oLat + Math.sign(dl || 1) * T.sideGap;
          if (!bully && Math.abs(dl) >= T.sideGap) continue;
          this._consider(clamp(target, -lim, lim) - this._baseLat(s), 0.6, false);
        }
      }
    }

    // ---- boost pads and (when empty-handed) item boxes, skill-weighted
    if (this._cUrgency < 0.5) {
      const plNow = this._baseLat(s) + this.avoid;
      const pads = tr.boostPads;
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        const ds = tr.deltaS(s, pad.s0);
        if (ds < 4 || ds > 45) continue;
        if (Math.abs(pad.lateral - plNow) > 4.5) continue;
        const f = tr.frameAt(pad.s0 + pad.length * 0.5, this._f);
        this._consider(pad.lateral - this._baseLat(f.s, f), 0.35 * this.skill, false);
      }
      if (items && !k.item && !k.rolling) {
        const rows = tr.itemRows;
        for (let r = 0; r < rows.length; r++) {
          const row = rows[r];
          const ds = tr.deltaS(s, row.s);
          if (ds < 6 || ds > 42) continue;
          let best = null, bd = Infinity;
          for (const b of items.boxes) {
            if (b.row !== r || !b.active) continue;
            const d = Math.abs(b.lateral - plNow);
            if (d < bd) { bd = d; best = b; }
          }
          if (best && bd > 0.6) {
            const f = tr.frameAt(row.s, this._f);
            this._consider(best.lateral - this._baseLat(row.s, f), 0.3 * this.skill * this.personality.items, false);
          }
        }
      }
    }

    // ---- v5 plugin lures (SPEC §16.2): lire to collect, a rival to bump or flatten
    if (items && items.pluginContext && this._cUrgency < 0.5 && !this._hzNear) this._pluginLures(items, s, v);

    this.avoidUrgent = this._cHazard;
    this.avoid = damp(this.avoid, this._cWant, this._cHazard ? T.avoidRateHazard : T.avoidRate, dt);
  }

  // Item plugins / systems with aiLure(pluginCtx, kart, c) → { s, lateral, urgency } | null
  // pull the planned line toward a lateral at arc length s (below hazards: urgency < 0.5
  // never outranks a dodge). c = { s, speed, skill, difficulty, aggression, plannedLat(s), baseLat(s) }.
  _pluginLures(items, s, v) {
    if (!this._lures) {
      this._lures = [...itemHandlers(), ...itemSystems()].filter(([, h]) => h && typeof h.aiLure === 'function');
      const self = this;
      this._lureCtx = { s: 0, speed: 0, skill: this.skill, difficulty: this.difficulty, aggression: 0,
        plannedLat: (x) => self._baseLat(x) + self.avoid, baseLat: (x) => self._baseLat(x) };
    }
    if (!this._lures.length) return;
    const c = this._lureCtx, k = this.kart, tr = this.track;
    c.s = s; c.speed = v; c.aggression = this.diff.itemAggression * this.personality.aggression;
    for (const [id, h] of this._lures) {
      const pc = items.pluginContext(id);
      if (!pc) continue;
      let r = null;
      try { r = h.aiLure(pc, k, c); } catch (err) {
        if (!this._aiWarned) { this._aiWarned = true; console.error(`[ai] ${id}.aiLure threw`, err); }
      }
      if (!r || !Number.isFinite(r.s) || !Number.isFinite(r.lateral)) continue;
      const f = tr.frameAt(r.s, this._f);
      const lim = f.halfWidth - T.edgeMargin;
      this._consider(clamp(r.lateral, -lim, lim) - this._baseLat(r.s, f), clamp(+r.urgency || 0.3, 0, 0.49), false);
    }
  }

  // Course hazards (SPEC §15.3, hazards.js is deterministic on the race clock):
  // over the stretch the noticed hazards ahead cover, the kart's own arrival
  // times are tested against the hazard clock on a set of lateral lines; the
  // plan moves to the open line nearest to it (reachable in time), and if no
  // line is open at this speed but one is when arriving later, the driver
  // lifts off. Each hazard is spotted with a skill-weighted chance per lap
  // (courseSpot), so CPUs still get caught now and then.
  _courseHazards(dt, hz, s, v) {
    const k = this.kart, tr = this.track;
    this._hzCool -= dt;
    if (this._hzCool > 0) { if (this._hzUrg > 0) this._consider(this._hzWant, this._hzUrg, true); return; }
    this._hzCool = T.courseEvery;
    this._hzUrg = 0;
    this._hzLift = false;
    if (k.isInvincible() || k.beer) return;               // stars / Beer Rockets plough through
    const look = 10 + v * T.courseLook;
    const near = hz.ahead(s, look);
    this._hzNear = near.length > 0;                       // (v5 plugin lures stay off near course hazards)
    if (!near.length) return;
    const spot = T.courseSpot[0] + T.courseSpot[1] * (k.ink > 0 ? Math.max(0.05, this.skill - T.inkSkill) : this.skill);
    // plan for the next row only (hazards within courseRow m of the nearest
    // one still ahead); the next row gets its own plan once this one is passed
    let first = Infinity;
    for (let i = 0; i < near.length; i++) {
      const h = near[i], ds = tr.deltaS(s, h.s);
      if (ds + h.extent + T.courseReach > 0 && ds < first) first = ds;
    }
    let a = Infinity, b = -Infinity;
    for (let i = 0; i < near.length; i++) {
      const h = near[i], ds = tr.deltaS(s, h.s);
      if (ds - first > T.courseRow || ds + h.extent + T.courseReach <= 0) continue;
      if (hash01((h.index + 1) * 7919 + (k.lap | 0), this.seed) >= spot) continue;
      a = Math.min(a, ds - h.extent - T.courseReach);
      b = Math.max(b, ds + h.extent + T.courseReach);
    }
    if (!(b > 0)) return;
    a = Math.max(0, a);
    const sm = s + (a + b) * 0.5, f = tr.frameAt(sm, this._f);
    const base = this._baseLat(sm, f);                    // own line at the hazards
    const lim = Math.max(0, f.halfWidth - T.courseMargin);
    // the avoid offset is added to the base line at the pure-pursuit point, which
    // may lie past the straight (another racing line): aim the line from there
    const Ld = (T.lookBase + T.lookGain * v) * T.dodgeLook * (k.ink > 0 ? T.inkLook : 1);
    const baseT = this._baseLat(s + Ld, tr.frameAt(s + Ld, this._fHz || (this._fHz = {})));
    const plan = clamp(baseT + this.avoid, -lim, lim);
    const r = KART.radius + T.courseClear;
    const n = Math.max(3, Math.min(14, Math.ceil((b - a) / 1.2)));
    const t0 = hz.time, lat0 = k.proj.lateral;
    // hits along the way to line `lat`: the kart slides over from where it is
    // at about courseShift m/s, arriving at speed vv
    const cost = (lat, vv, rr) => {
      let c = 0;
      const dl = lat - lat0;
      for (let j = 0; j <= n; j++) {
        const d = a + ((b - a) * j) / n, tt = d / vv, t = t0 + tt;
        const reach = T.courseShift * tt;
        const pl = Math.abs(dl) <= reach ? lat : lat0 + Math.sign(dl) * reach;
        // the arrival time is only known roughly (the kart speeds up / slows down)
        const sl = T.courseSlack + T.courseSlackGrow * tt;
        if (hz.hitAt(s + d, pl, t, 0, rr) || hz.hitAt(s + d, pl, t + sl, 0, rr) || hz.hitAt(s + d, pl, t - sl, 0, rr)) c++;
      }
      return c;
    };
    // a hit counts far more than a near miss (the wide test): lines with room
    // to spare win, since the kart only follows a line to about a metre
    const rWide = r + T.courseWide;
    const score = (lat, vv) => cost(lat, vv, r) * 64 + cost(lat, vv, rWide);
    const scan = (vv) => {
      let best = plan, bestC = score(plan, vv), bestD = 0;
      if (bestC === 0) return { lat: best, c: 0 };
      for (let lat = -lim; lat <= lim + 1e-6; lat += T.courseStep) {
        const c = score(lat, vv), d = Math.abs(lat - plan);
        if (c < bestC || (c === bestC && d < bestD)) { best = lat; bestC = c; bestD = d; }
      }
      return { lat: best, c: bestC };
    };
    const vv = Math.max(6, v);
    if (score(clamp(base, -lim, lim), vv) === 0) return;  // the own line is clear: nothing to do
    let pick = scan(vv);                                  // (a clear current plan is held)
    if (pick.c > 0 && a > 4) {
      const later = scan(vv * T.courseLift);
      if (later.c < pick.c) { pick = later; this._hzLift = true; }
    }
    this._hzWant = pick.lat - baseT;
    this._hzUrg = 2.3 - a / look;                         // outranks item hazards at the same distance
    this._consider(this._hzWant, this._hzUrg, true);
  }

  // Keep the most urgent avoidance candidate of this step.
  _consider(want, urgency, hazard) {
    if (urgency > this._cUrgency) { this._cUrgency = urgency; this._cWant = want; this._cHazard = hazard; }
  }

  // ------------------------------------------------------------- drifting

  // Returns { active, button, steer, throttle } (reused object).
  _drift(dt, s, v, steer) {
    const k = this.kart, d = k.drift, tr = this.track, A = this.analysis;
    const out = this._driftOut || (this._driftOut = { active: false, button: false, steer: 0, throttle: 1 });
    out.active = false; out.button = false; out.steer = steer; out.throttle = 1;

    if (this.driftState === 'drive') {
      if (this.driftCooldown <= 0 && k.grounded && v > Math.max(DRIFT.minSpeed, k.driftStartSpeed) + 2 && Math.abs(this._alpha) < 0.6) {
        const i = tr.indexAt(s + v * T.driftLead + 3);
        const c = tr.curv[i];
        if (Math.abs(c) > 1 / T.driftMaxRadius && A.run[i] >= v * (DRIFT.tierTimes[0] + T.driftMinExtra)) {
          const id = A.id[i];
          if (id !== this._cornerId) {
            this._cornerId = id;
            const p = clamp(0.2 + 0.8 * this.skill * this.personality.drift, 0.05, 0.97);
            this._cornerDrift = this.rng() < p;
            if (this._cornerDrift) {
              this.driftState = 'hop';
              this.driftDir = Math.sign(c);
              this.hopTime = 0;
            }
          }
        }
      }
    }

    if (this.driftState === 'hop') {
      this.hopTime += dt;
      if (d.active) {
        this.driftState = 'drift';
        this.driftEntered = false;
        this.driftTime = 0;
        this.wideTime = 0;
        this.driftBias = 0;
        this.drifts++;
      } else if (this.hopTime > 0.45 || (k.grounded && this.hopTime > 0.1)) {
        // hop never turned into a drift (too slow / landed straight): give up on this corner
        this.driftState = 'drive';
        this.driftCooldown = 0.8;
        return out;
      } else {
        out.active = true;
        out.button = true;
        out.steer = this.driftDir * Math.max(0.65, Math.abs(steer));
        return out;
      }
    }

    if (this.driftState === 'drift') {
      if (!d.active) {
        // cancelled by the kart (hit, too slow, airborne too long)
        this.driftState = 'drive';
        this.driftCooldown = 0.4;
        return out;
      }
      const st = k.stats;
      // the drift's yaw rate is turnRate x driftTightness(x), capped at |v| / driftMinRadius (kart.js)
      const need = -d.dir * this._yawReq;
      const mag = need / Math.max(0.2, st.turnRate);                 // yaw multiplier wanted
      out.steer = d.dir * driftSteerFor(mag);
      // The wheel held into the turn (steer * dir >= DRIFT.chargeIntoMin) charges
      // mini-turbos 2.5x faster, but wide corners need less turn than that:
      // skilled CPUs pulse between "in" and counter-steer with the duty cycle
      // that gives the wanted average tightness (as good players do).
      const mIn = driftTightness(DRIFT.chargeIntoMin);
      if (this.skill >= T.pulseSkill && d.tier < 3 && mag < mIn && mag > KART_TUNE.driftWide) {
        this._pwmAcc = clamp(this._pwmAcc + (mag - (this._pwmHigh ? mIn : KART_TUNE.driftWide)) * dt, -0.3, 0.3);
        this._pwmHold -= dt;
        const high = this._pwmAcc > 0;
        if (this._pwmHold <= 0 && high !== this._pwmHigh) {
          this._pwmHigh = high;
          this._pwmHold = T.pulseHold * (1 + 2 * (1 - this.skill));
        }
        out.steer = this._pwmHigh ? d.dir * DRIFT.chargeIntoMin : -d.dir;
      }
      out.throttle = need > driftMaxYawRate(st.turnRate, v) + 0.25 * st.turnRate ? 0.4 : 1;   // too tight even fully in: scrub speed
      // the hop comes slightly before the corner: only judge its end once inside
      this.driftTime += dt;
      const i0 = tr.indexAt(s);
      if (!this.driftEntered && A.run[i0] > 0 && Math.sign(tr.curv[i0]) === d.dir) this.driftEntered = true;
      const i = tr.indexAt(s + v * T.driftRelease);
      const ending = this.driftEntered
        ? A.run[i] < v * T.driftRelease || Math.sign(tr.curv[i]) !== d.dir || A.run[i] === 0
        : this.driftTime > 0.9;
      // needing barely more turn than the widest drift gives: tighten the line
      // toward the inside; still too wide with the line at the inside edge
      // (sustained) -> straighten out
      if (mag < KART_TUNE.driftWide + 0.15) this.driftBias = Math.min(1, this.driftBias + dt * T.driftBiasRate);
      else if (mag > KART_TUNE.driftTight - 0.1) this.driftBias = Math.max(0, this.driftBias - dt * T.driftBiasRate);
      if (mag < KART_TUNE.driftWide - 0.3 && this.driftTime > 0.3 && this.driftBias > 0.9) this.wideTime += dt;
      else this.wideTime = 0;
      // ...but hang on for the last moments before a mini-turbo tier
      const almost = d.tier < 3 && d.charge > DRIFT.tierTimes[d.tier] - 0.3;
      const tooWide = this.wideTime > (almost ? 0.6 : 0.2);
      if (ending || tooWide || Math.abs(this._alpha) > 1.0) {
        this.lastDriftEnd = ending ? 'end' : tooWide ? 'wide' : 'alpha';
        this.driftState = 'drive';
        this.driftCooldown = 0.35;
        return out;          // button released -> mini-turbo if charged
      }
      out.active = true;
      out.button = true;
    }
    return out;
  }

  // --------------------------------------------------------------- pace

  // CPU pace: difficulty speed x personal pace, rubber-banded against the
  // LEADING human still racing (ctx.humans, or ctx.player for one human; the
  // pack average without humans). A human kart driven by its AIDriver keeps 1.0.
  _updatePace(dt, ctx) {
    const k = this.kart, karts = ctx.karts;
    const humans = ctx.humans && ctx.humans.length ? ctx.humans : null;
    const single = humans ? null : ctx.player || null;
    let target;
    if (k.finished) target = T.finishedPace;
    else if (k === single || (humans && humans.includes(k))) target = 1;
    else {
      target = this.diff.aiSpeedMult * this.pace;
      let ref = null;
      if (single) {
        if (!single.finished) ref = single.distance;
      } else if (humans) {
        for (let i = 0; i < humans.length; i++) {
          const h = humans[i];
          if (!h.finished && (ref === null || h.distance > ref)) ref = h.distance;
        }
      } else if (karts && karts.length > 1) {
        let sum = 0, n = 0;
        for (let i = 0; i < karts.length; i++) if (!karts[i].finished) { sum += karts[i].distance; n++; }
        if (n > 1) ref = sum / n;
      }
      if (ref !== null) {
        const gap = ref - k.distance;      // + = we are behind
        const span = T.rubberFar - T.rubberNear;
        let rb = 0;
        if (gap > T.rubberNear) rb = this.diff.rubberBand * smoothstep((gap - T.rubberNear) / span);
        else if (gap < -T.rubberNear) rb = -this.diff.rubberBand * smoothstep((-gap - T.rubberNear) / span);
        target *= 1 + rb;
      }
    }
    k.speedMult = damp(k.speedMult, target, T.paceRate, dt);
  }

  // -------------------------------------------------------------- start

  // Intro / countdown: sit still, then press the throttle at a planned moment
  // (inside the start-boost window for skilled drivers; a few jump the gun).
  _prestart(race) {
    const inp = this.kart.input;
    inp.steer = 0; inp.brake = 0; inp.drift = false; inp.useItem = false;
    if (!race || race.state !== 'countdown') { inp.throttle = 0; this.startPressAt = null; return; }
    if (this.startPressAt === null) {
      const r = this.rng();
      const pBoost = clamp(0.2 + 0.75 * this.skill, 0, 0.95);
      const pStall = clamp(0.14 - 0.14 * this.skill, 0, 0.14);
      if (r < pBoost) this.startPressAt = randRange(this.rng, 0.3, 0.7);
      else if (r < pBoost + pStall) this.startPressAt = randRange(this.rng, 1.75, 2.6);
      else this.startPressAt = this.rng() < 0.5 ? randRange(this.rng, 0.0, 0.2) : randRange(this.rng, 0.8, 1.4);
    }
    inp.throttle = race.countdown <= this.startPressAt ? 1 : 0;
  }

  // -------------------------------------------------------------- stuck

  // Forward progress watchdog (needs a Race writing kart.distance).
  _trackProgress(dt, disabled) {
    const k = this.kart;
    if (!this._hasRace || k.distance > this.progressMark + 4 || k.finished) { this.progressMark = k.distance; this.noProgress = 0; }
    else if (!disabled) this.noProgress += dt;
  }

  _handleStuck(dt) {
    const k = this.kart, inp = k.input, tr = this.track;
    const hs = Math.hypot(k.velocity.x, k.velocity.z);
    if (hs < T.stuckSpeed) this.stuckTime += dt;
    else this.stuckTime = 0;
    if (this.stuckTime > this.maxStuck) this.maxStuck = this.stuckTime;

    if (this.stuckTime > T.respawnTime || this.noProgress > T.noProgressTime) {
      k.respawn();
      this.respawns++;
      this.stuckTime = 0;
      this.noProgress = 0;
      this.progressMark = k.distance;
      this.recoverTimer = 0;
      this.driftState = 'drive';
      return true;
    }
    if (this.recoverTimer > 0) {
      this.recoverTimer -= dt;
      inp.throttle = 0; inp.brake = 1; inp.drift = false; inp.steer = this.recoverSteer;
      if (this.recoverTimer <= 0) this.recoverCooldown = 1.2;
      this._trackProgress(dt, false);
      return true;
    }
    if (this.stuckTime > T.stuckTime && this.recoverCooldown <= 0) {
      // reverse while turning the nose toward the road ahead (reversing
      // inverts steering in kart.js, so steer toward the target's side)
      const f = tr.frameAt(k.proj.s + 8, this._f);
      const pt = tr.pointAt(f.s, 0, this._pt);
      const a = angleDiff(k.yaw, Math.atan2(pt.x - k.position.x, pt.z - k.position.z));
      this.recoverSteer = a >= 0 ? 1 : -1;
      this.recoverTimer = T.reverseTime;
      this.driftState = 'drive';
      inp.throttle = 0; inp.brake = 1; inp.drift = false; inp.steer = this.recoverSteer;
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------- items

  _items(dt, ctx, s, v) {
    const k = this.kart, items = ctx.items;
    if (!items || k.finished || !k.item || k.rolling) {
      this.itemHold = 0;
      this.itemReaction = -1;
      this._lastDrop = 0;
      return;
    }
    const P = this.personality, aggr = this.diff.itemAggression;
    if (this.itemReaction < 0) {
      // reaction time: skilled, eager drivers decide faster
      const base = 1.9 - 1.4 * this.skill * P.items;
      this.itemReaction = Math.max(0.25, base * (1.35 - 0.6 * aggr) * randRange(this.rng, 0.7, 1.35));
      this._aiMem = {};                       // fresh scratch memory for a plugin's aiUse
    }
    this.itemHold += dt;
    // emergencies skip the reaction time: a Capo Crusher about to slam down on us
    if (this._capoDefence(items)) { k.input.useItem = true; return; }
    if (this.itemHold < this.itemReaction + this.itemGap) return;
    this._bombBack = false;
    // v5 plugin items decide through their handler's aiUse(kart, ctx) (SPEC §16.2)
    const handler = getItemHandler(k.item);
    let use, brake = false;
    if (handler && typeof handler.aiUse === 'function') {
      let r = false;
      try { r = handler.aiUse(k, this._aiUseCtx(ctx, s, v)); } catch (err) {
        if (!this._aiWarned) { this._aiWarned = true; console.error(`[ai] ${k.item}.aiUse threw`, err); }
      }
      use = r === true || (!!r && typeof r === 'object' && r.use !== false);
      brake = !!(r && typeof r === 'object' && r.brake);
    } else use = this._shouldUse(k.item, ctx, s, v);
    if (use) {
      k.input.useItem = true;
      if (brake || (k.item === 'meatball_bomb' && this._bombBack)) k.input.brake = 1;   // brake held: dropped / thrown behind
      // multi-use items: space the next one out
      const gap = ITEM_GAPS[k.item];
      this.itemGap = gap && k.itemCount > 1 ? this.itemHold - this.itemReaction + randRange(this.rng, gap[0], gap[1]) : 0;
      if (k.item === 'triple_banana') this._lastDrop = this.itemHold;
      if (k.itemCount <= 1) this.itemGap = 0;
    }
  }

  // The context a plugin's aiUse(kart, ctx) gets (one reused object per driver).
  //   ai, kart, items, race, karts, track, hazards, s, speed, hold (s held), place, skill,
  //   aggression (difficulty itemAggression x personality aggression), personality,
  //   mem (scratch object, fresh per item pickup), plugin (the ItemSystem's PluginContext of the item, or null),
  //   straightAhead(len), kartInSights(range, width), roadTurn(len), kartAhead(),
  //   rivalAhead(near, far, cone), rivalBehind(near, far, width), threats(radius)
  _aiUseCtx(ctx, s, v) {
    const k = this.kart, race = ctx.race || null, items = ctx.items || null;
    let c = this._aiCtx;
    if (!c) {
      const self = this;
      c = this._aiCtx = {
        ai: this, kart: k, track: this.track, personality: this.personality, skill: this.skill,
        straightAhead: (len) => self._straightAhead(c.s, len),
        roadTurn: (len) => self._roadTurn(c.s, len),
        kartInSights: (range, width = 1.5) => self._kartInSights(c.karts, c.s, range, width),
        kartAhead: () => (c.race && c.race.getKartAhead ? c.race.getKartAhead(k) : null),
        // nearest rival `near`..`far` m ahead (straight-line) within `cone` rad of the nose, or null
        rivalAhead: (near, far, cone = 0.35) => {
          const fx = Math.sin(k.yaw), fz = Math.cos(k.yaw);
          let best = null, bd = Infinity;
          for (const o of c.karts) {
            if (o === k || o.finished) continue;
            const dx = o.position.x - k.position.x, dz = o.position.z - k.position.z, fwd = dx * fx + dz * fz;
            if (fwd < near || fwd > far || Math.abs(Math.atan2(dx * fz - dz * fx, fwd)) > cone) continue;
            if (fwd < bd) { bd = fwd; best = o; }
          }
          return best;
        },
        // nearest rival `near`..`far` m behind along the track within `width` m of our line, or null
        rivalBehind: (near, far, width = 3) => {
          let best = null, bd = Infinity;
          for (const o of c.karts) {
            if (o === k || o.finished || !o.proj) continue;
            const ds = self.track.deltaS(o.proj.s, c.s);
            if (ds > near && ds < far && Math.abs(o.proj.lateral - k.proj.lateral) < width && ds < bd) { bd = ds; best = o; }
          }
          return best;
        },
        threats: (radius) => (c.items && c.items.getThreatsNear ? c.items.getThreatsNear(k, radius) : []),
      };
    }
    c.items = items; c.race = race; c.karts = ctx.karts || []; c.hazards = ctx.hazards || null;
    c.s = s; c.speed = v; c.hold = this.itemHold;
    c.place = race ? race.getPlace(k) : k.place || 1;
    c.aggression = this.diff.itemAggression * this.personality.aggression;
    c.mem = this._aiMem || (this._aiMem = {});
    c.plugin = items && items.pluginContext ? items.pluginContext(k.item) : null;
    return c;
  }

  // Accordion Blast against a Capo Crusher closing in on us, or (hard CPUs,
  // skill-weighted, decided once per capo) a toot timed into its wind-up.
  _capoDefence(items) {
    const k = this.kart;
    if (!items.capoFor) return false;
    const c = items.capoFor(k);
    if (!c) return false;
    if (k.item === 'accordion' && c.locked && c.position.distanceTo(k.position) < 11) return true;
    if (k.item === 'toot' || k.item === 'triple_toot' || k.item === 'golden_toot') {
      if (c.phase !== 'windup') return false;
      if (this._dodgeCapo !== c.uid) {
        this._dodgeCapo = c.uid;
        this._dodgeRoll = this.difficulty === 'hard' && this.rng() < this.skill * T.capoDodgeSkill;
      }
      return this._dodgeRoll && c.phaseT > 0.05;
    }
    return false;
  }

  _shouldUse(item, ctx, s, v) {
    const k = this.kart, tr = this.track, race = ctx.race, karts = ctx.karts || [];
    const P = this.personality, aggr = this.diff.itemAggression;
    const hold = this.itemHold;
    const holdMax = (16 - 8 * aggr * P.aggression) * (1.2 - 0.4 * P.items);
    const place = race ? race.getPlace(k) : k.place || 1;
    switch (item) {
      case 'star':
        return true;
      case 'zap':
        if (place >= 3) return true;
        return place === 2 && hold > 3.5;
      case 'rocket': {
        const tgt = race ? race.getKartAhead(k) : null;
        if (tgt && !tgt.finished) return true;
        return hold > 25 && this._straightAhead(s, 40);
      }
      case 'bouncer':
        if (this._kartInSights(karts, s, 38, 1.5)) return true;
        return hold > holdMax && this._straightAhead(s, 50);
      case 'banana':
      case 'stink': {
        // drop when someone follows on our line (a stink cloud is big, so it
        // goes down a little earlier, which also gives the follower a chance)
        const w = item === 'stink' ? 4.5 : 2.4;
        const near = item === 'stink' ? 7 : 2;
        const far = (item === 'stink' ? 26 : 16) + 6 * aggr;
        for (const o of karts) {
          if (o === k || o.finished) continue;
          const ds = tr.deltaS(o.proj.s, s);         // + = o is behind us
          if (ds > near && ds < far && Math.abs(o.proj.lateral - k.proj.lateral) < w) return true;
        }
        if (hold > holdMax) return true;
        // free the slot right before an item row
        if (hold > 3) {
          for (const row of tr.itemRows) {
            const ds = tr.deltaS(s, row.s);
            if (ds > 4 && ds < 22) return true;
          }
        }
        return false;
      }
      case 'toot':
      case 'triple_toot':
        if (k.boostTimer > 0.15) return false;
        if (k.surface === 'offroad' && v < k.maxSpeed * 0.85) return true;
        if (v > 12 && this._straightAhead(s, 40)) return true;
        return hold > holdMax * 0.8 && v > 10 && this._straightAhead(s, 22);
      case 'golden_toot':
        // once started, keep the boost going until the window runs out
        if (k.goldenTimer > 0) return k.boostTimer < 0.2 && (v > 8 || k.surface === 'offroad');
        if (k.surface === 'offroad' && v < k.maxSpeed * 0.85) return true;
        if (v > 12 && this._straightAhead(s, 40)) return true;
        return hold > holdMax * 0.6 && v > 10;
      case 'triple_bouncer':
        if (this._kartInSights(karts, s, 38, 1.5)) return true;
        return hold > holdMax * 1.5 && this._straightAhead(s, 50);
      case 'triple_rocket': {
        const tgt = race ? race.getKartAhead(k) : null;
        if (tgt && !tgt.finished) return true;
        return hold > 25 && this._straightAhead(s, 40);
      }
      case 'triple_banana': {
        // the bunch guards our tail; a peel goes down when someone is close behind, or every few seconds
        if (hold - (this._lastDrop || 0) > T.bunchDropGap) return true;
        for (const o of karts) {
          if (o === k || o.finished || !o.proj) continue;
          const ds = tr.deltaS(o.proj.s, s);
          if (ds > 3 && ds < 12 && Math.abs(o.proj.lateral - k.proj.lateral) < 2.6) return true;
        }
        return false;
      }
      case 'capo':
        return place > 1;                     // never from the lead (it would come back for us)
      case 'espresso':
        return place > 1;
      case 'beer_rocket': {
        if (!race) return true;
        const left = race.laps * tr.length - k.distance;
        return !(k.lap >= race.laps && left < T.beerFinishKeep);
      }
      case 'meatball_bomb': {
        const fx = Math.sin(k.yaw), fz = Math.cos(k.yaw);
        const [near, far] = T.bombAhead;
        for (const o of karts) {
          if (o === k || o.finished || !o.proj) continue;
          const dx = o.position.x - k.position.x, dz = o.position.z - k.position.z;
          const fwd = dx * fx + dz * fz;
          if (fwd > near && fwd < far && Math.abs(Math.atan2(dx * fz - dz * fx, fwd)) < T.bombCone) return true;
          const ds = tr.deltaS(o.proj.s, s);
          if (hold > 2 && ds > 2 && ds < 8 && Math.abs(o.proj.lateral - k.proj.lateral) < 3) { this._bombBack = true; return true; }
        }
        return hold > T.bombHold && this._straightAhead(s, 30);
      }
      case 'accordion': {
        // a rocket locked on us about to land, or a crowd around us; else after a while
        const items = ctx.items;
        if (items) {
          const th = items.getThreatsNear(k, 12);
          for (let i = 0; i < th.length; i++) {
            const t = th[i];
            if (t.type === 'rocket' && t.targeting && t.distance < 10) return true;
            if (t.type === 'capo' && t.targeting && t.distance < 11) return true;
          }
        }
        let near = 0;
        for (const o of karts) {
          if (o === k || o.finished || o.isInvincible()) continue;
          const dx = o.position.x - k.position.x, dz = o.position.z - k.position.z;
          if (dx * dx + dz * dz < 64) near++;
        }
        if (near >= 2) return true;
        return hold > T.accordionHold;
      }
      default:
        return hold > holdMax;
    }
  }

  // No corner (|curvature| <= 1/110) along the next `len` meters.
  _straightAhead(s, len) {
    const tr = this.track;
    for (let d = 0; d <= len; d += 4) if (Math.abs(tr.curv[tr.indexAt(s + d)]) > 1 / 110) return false;
    return true;
  }

  // Largest heading change (rad) of the road between s and s + len.
  _roadTurn(s, len) {
    const tr = this.track, y0 = tr.yawArr[tr.indexAt(s)];
    let max = 0;
    for (let d = 4; d < len + 4; d += 4) {
      const a = Math.abs(angleDiff(y0, tr.yawArr[tr.indexAt(s + Math.min(d, len))]));
      if (a > max) max = a;
    }
    return max;
  }

  // A kart roughly on our heading line within `range` m (bouncer aim), ahead
  // along the road, with the road running straight to it and a little past
  // it: a ball fired across a corner (the lighthouse hairpin) hits the outer
  // wall and rebounds into the shooter and the karts behind.
  _kartInSights(karts, s, range, width) {
    const k = this.kart, tr = this.track;
    const fx = Math.sin(k.yaw), fz = Math.cos(k.yaw);
    for (const o of karts) {
      if (o === k || o.finished) continue;
      const dx = o.position.x - k.position.x, dz = o.position.z - k.position.z;
      const fwd = dx * fx + dz * fz;
      if (fwd < 4 || fwd > range) continue;
      const perp = Math.abs(dx * fz - dz * fx);
      if (perp >= width + fwd * 0.02) continue;
      const ds = tr.deltaS(s, o.proj.s);
      if (ds < 2 || ds > range + 6) continue;
      if (this._roadTurn(s, ds + T.bouncerClear) > T.bouncerMaxTurn) continue;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------- helpers

/** CPU difficulty for an engine class (50cc easy, 100cc normal, 150cc hard). */
export function difficultyForCc(cc) {
  return getEngineClass(cc).cpu;
}

// 32-bit FNV-1a hash of a string.
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * A CPU racer's kart for a race set (SPEC §14.2): one of the two
 * CPU_PRESETS of its weight class, picked from (racer id, setSeed) so it stays
 * the same for every race of a Grand Prix / VS set and changes between sets.
 */
export function cpuLoadout(def, setSeed = 0) {
  const presets = CPU_PRESETS[def && def.weightClass] || CPU_PRESETS.medium;
  const pick = hash01(hashString(String(def && def.id)), setSeed | 0) < 0.5 ? 0 : 1;
  return { ...presets[pick] };
}

/**
 * Build an AIDriver for every kart except the humans, with skills spread
 * around the difficulty's aiSkill (shuffled) and per-character personalities.
 * The difficulty comes from `difficulty`, else from the engine class `cc`.
 */
export function createAIDrivers(karts, { track, difficulty = null, cc = null, rng = Math.random, player = null, humans = null, skillSpread = 0.12 } = {}) {
  if (!difficulty) difficulty = cc !== null ? difficultyForCc(cc) : 'normal';
  const diff = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  const skip = new Set(humans || (player ? [player] : []));
  const cpus = karts.filter((k) => !skip.has(k));
  const n = cpus.length;
  const offsets = [];
  for (let i = 0; i < n; i++) offsets.push(n > 1 ? -skillSpread + (2 * skillSpread * i) / (n - 1) : 0);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = offsets[i]; offsets[i] = offsets[j]; offsets[j] = t; }
  return cpus.map((k, i) => new AIDriver(k, { track: track || k.track, difficulty, skill: clamp(diff.aiSkill + offsets[i], 0.15, 1), rng }));
}
