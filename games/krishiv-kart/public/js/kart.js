// Kart physics. Node-safe (no DOM): used by the browser game and by the
// headless simulation (tools/sim.mjs).
//
// Model (SPEC §5): each substep the horizontal velocity is split into a
// forward part vF (along the nose) and a lateral part vR. The engine, brakes
// and drag act on vF; lateral grip bleeds vR away and converts most of it
// back into vF (so turning redirects momentum instead of eating it). Steering
// sets a target yaw rate that the kart eases toward. The vertical axis is
// handled separately: grounded karts ride the road height from
// track.project(); they leave the ground when the road curves away faster
// than gravity (hill crest) or drops away (kicker ramp lip).
//
// Stats come from parts.js: final ratings = character + kart body + wheels
// (clamped 1..5) for every kart, CPUs included; the engine class (ccMult)
// scales top speed and acceleration. Human karts may run Steer Assist
// (SPEC §14.3a): invisible "assist edges" just inside the walls push the kart
// back toward the road, and a look-ahead window nudges the steering toward the
// road ahead (the player's full opposite lock always wins). Human karts also
// get a drift-exit steering latch (SPEC §15.1, exitLatch* in KART_TUNE): right
// after a drift ends the wheel's leftover push into the old turn is held back
// for ~0.6 s while the hands come back to centre. The phone's own steering lock
// (0.8 of the turn authority at full tilt) lives in pad.js; the kart's turn
// authority is unchanged (notes/research-v4-steering.md §4).
//
// Conventions: forward = (sin yaw, 0, cos yaw), right = (-cos yaw, 0, sin yaw);
// steer +1 = RIGHT, which DEcreases yaw.
//
// v5 kart-state effects (SPEC §16.2, notes/research-v5-items.md §C2; API in
// notes/v5-items-B.md). All default off, so a kart nobody touches drives
// exactly as before:
//   freeze(t, cause)  iceTimer:    disabled, slides straight (HIT.iceSlideDecel), walls still collide
//   shrink(t, cause)  shrinkTimer: sizeMult 0.55, speed x0.85, accel x0.9; still hittable; a full-size
//                                  kart running into it squashes it (resolveKartCollisions)
//   squash(t, cause)  squashTimer: flattened: speed x0.35, steering x0.6; not hittable during
//   soot(t, cause)    sootTimer:   drift cancelled at the start, items locked (itemsLocked), speed x0.94
//   ghost(t)          ghostTimer:  no kart-kart contact, not hittable, offroad-proof
//   grow(t)           megaTimer:   sizeMult 2.2 (eased), speed x1.12, not hittable (zap ends it), offroad-proof
//   bigJump(vy)       a tall leap; airImmune while it lasts (ground items miss), DRIFT in the air = trick
//   coins / potatoTimer (items side): max speed x (1 + COIN.speedPerCoin x coins), x potatoSpeedMult
//   itemSpeedMult (free max-speed factor, default 1), offroadImmune (flag, default false)

import * as THREE from 'three';
import { KART, DRIFT, HIT, BOOST, STAR, ITEM5, COIN, ITEM_IDS } from './config.js';
import { bus } from './bus.js';
import { clamp, lerp, damp, wrapAngle, angleDiff } from './utils.js';
import { sanitizeLoadout, computeRatings, offroadBonus, statsFromRatings } from './parts.js';

// Feel tuning that is private to the kart model (shared constants live in config.js).
export const KART_TUNE = {
  // steering
  turnRefSpeed: 8,          // m/s at which steering reaches full authority
  highSpeedTurnLoss: 0.2,   // fraction of turn rate lost near top speed
  yawResponse: 18,          // 1/s: how fast the yaw rate follows the stick
  airSteer: 0.45,           // turn authority while airborne (jumps)
  hopSteer: 1.0,            // turn authority during a drift hop
  // drift arc (yaw-rate multipliers of turnRate) for the wheel position
  // x = steer * dir: full counter-steer 0.13 .. neutral 0.37 .. full in 0.8,
  // eased by driftCurve. At top speed (handling 3, 100cc 26 m/s): R 105 / 37 /
  // 17 m, i.e. full in ~ normal full lock, neutral fits a 90° corner, the
  // fast-charge position (x 0.5, R 24 m) a hairpin. Classic kart-racer turn rates,
  // not the old 140°/s (SPEC §14.3c; numbers and probes in notes/drift-fix.md).
  driftWide: 0.13,
  driftTight: 0.8,
  driftCurve: 1.5,
  driftMinRadius: 10,       // m: drift yaw rate <= |v| / this, so a slowed drift never pirouettes (0 = off)
  driftSlipFade0: 25,       // deg the nose leads the direction of travel at which the drift yaw starts to fade ...
  driftSlipFade1: 35,       // ... reaching 0 here: the path has to catch up before the nose turns on (0 = off)
  driftSlipMax: 38,         // deg: hard cap on that lead (0 = off)
  driftWallEnd: 1,          // 1: a fresh wall knock > wallEventMin ends the drift (mini-turbo if charged), classic kart-racer style
  driftMaxHeading: 90,      // deg: a drift whose nose is this far off the road direction lets go (no mini-turbo; 0 = off)
  driftDirAtLanding: 1,     // 1: the drift direction is read from the wheel when the hop lands (modern kart-racer style), not at the press
  driftDirMin: 0.1,         // |steer| that picks a drift direction (about 11° of phone tilt)
  driftDirFromPlayer: 1,    // 1: that steer is the player's own wheel; Steer Assist shapes the arc but never picks the side (0 = the assisted steer)
  driftExitTime: 0.35,      // s after a drift ends in which the nose swings onto the direction of travel ...
  driftExitAlign: 16,       // ... at this rate (1/s), so a release doesn't dart the kart toward the inside,
  driftExitGrip: 6,         // ... with this lateral grip (1/s; 0 = normal grip) while it does
  driftExitRoad: 1,         // 1: ... but only while the nose points further into the old turn than the road (and never past it),
  driftExitMinTime: 0.3,    // ... after a drift of at least this long (s)
  // Drift-exit steering latch (SPEC §15.1; notes/research-v4-steering.md §5),
  // human karts only. When a drift ends the phone is still tilted hard into the
  // corner (a wrist needs 0.3-0.6 s to bring 40-55° back; a thumbstick springs
  // back in a frame or two), so normal steering would carry the turn on. For
  // exitLatchTime s the wheel's push INTO the old turn is capped by a ceiling
  // rising smoothstep from exitLatchStart to 1; counter-steer always passes.
  exitLatchTime: 0.6,       // s (0 = off)
  exitLatchStart: 0,        // ceiling at the release (0..1)
  exitLatchLook: 0.5,       // the cap only applies while the nose points at/inside the road this many s ahead
  exitLatchMinDrift: 0.3,   // s: only after a drift at least this long
  driftSpeedMult: 1.0,      // drifting keeps full speed (the reward for the risk)
  driftCancelSpeed: 6,
  driftMaxAir: 0.6,
  landDriftGrace: 0.35,     // s after landing in which steering can still pick the drift direction
  // grip (1/s decay of lateral velocity) + fraction of lateral energy kept
  grip: 10,
  driftGrip: 4.5,
  offroadGrip: 7,
  airGrip: 0.8,
  spinGrip: 3,
  gripTransfer: 0.8,
  driftTransfer: 0.985,
  // longitudinal
  accelExp: 2.4,            // accel falls off as 1 - (v/vmax)^accelExp
  accelFloor: 0.06,
  offroadAccelMult: 0.75,
  reverseAccel: 12,
  overspeedMin: 6,          // m/s^2 decel when slightly above max (boost tail)
  overspeedMax: 25,         // m/s^2 cap (entering grass at speed)
  overspeedGain: 1.2,
  slopeAccel: 7,            // m/s^2 per unit slope (uphill slows, downhill helps)
  cornerDrag: 0.07,         // decel per m/s^2 of lateral accel when steering (not drifting)
  airDrag: 0.05,
  // vertical
  hopGravityMult: 1.6,      // snappier drift hops (~0.22 s)
  landEventAir: 0.25,
  tumbleHop: 6,
  // hits
  spinDecay: 1.2,           // -> ~30% speed after a 1 s spin
  tumbleDecay: 1.535,       // -> ~10% after a 1.5 s tumble
  // walls
  wallRadius: KART.radius,
  wallBounce: 0.12,         // glancing hits slide instead of pinballing across narrow roads
  wallBounceMax: 2.5,
  wallScrub: 0.25,
  wallFreshImpact: 4,       // m/s: normal speed that counts as a new impact while touching
  wallFriction: 0.5,
  wallSlideTime: 0.3,
  wallAlign: 9,
  wallAlignTime: 0.3,
  wallEventMin: 1.5,        // m/s of normal impact speed to count as a hit
  wallEventScale: 18,
  wallCooldown: 0.3,
  // bumps: effective mass = mass x (bumpMassLow + (1 - bumpMassLow) x speed / topSpeed)
  // (x bumpBoostMass while boosting); each kart takes the other's share of the push
  bumpRestitution: 0.5,
  bumpKick: 3,
  bumpMassLow: 0.55,
  bumpBoostMass: 1.5,
  bumpEventScale: 14,
  bumpCooldown: 0.25,
  bumpSlideTime: 0.35,      // s of reduced lateral grip after a hard bump (karts get shoved)
  bumpSlideGrip: 2.5,
  starRamKick: 7,
};

const T = KART_TUNE;

/**
 * Drift arc tightness (multiplier of the kart's turn rate) for the wheel
 * position x = steer * drift dir: -1 full counter-steer .. +1 full into the turn.
 */
export function driftTightness(x) {
  return lerp(T.driftWide, T.driftTight, Math.pow(clamp((x + 1) * 0.5, 0, 1), T.driftCurve));
}

/** Inverse of driftTightness: the wheel position (steer * dir) that gives `mult`. */
export function driftSteerFor(mult) {
  const t = clamp((mult - T.driftWide) / (T.driftTight - T.driftWide), 0, 1);
  return 2 * Math.pow(t, 1 / T.driftCurve) - 1;
}

/**
 * Most yaw rate (rad/s) a drift can have at horizontal speed `speed`:
 * full into the turn, capped so the arc never gets tighter than driftMinRadius.
 */
export function driftMaxYawRate(turnRate, speed) {
  const w = turnRate * T.driftTight;
  return T.driftMinRadius > 0 ? Math.min(w, Math.abs(speed) / T.driftMinRadius) : w;
}

const DEG2RAD = Math.PI / 180;

// Steer Assist (SPEC §14.3a; derivations in notes/research-steering-feel.md).
export const ASSIST_TUNE = {
  edgeOut: 0.5,             // assist edge = min(halfWidth + edgeOut, wall - wallGap) ...
  wallGap: 1.4,             // ... (wall - wallGap while boosting / starred: grass is free then)
  range: 2.5,               // m inside the edge where the corrections fade in (w = 1 - d / range)
  push: 26,                 // m/s^2 x w^2 inward lateral acceleration
  bleed: 14,                // 1/s x w: decay of the outward lateral velocity
  rotate: 2.6,              // 1/s x w: nose eased toward the road direction (not while drifting)
  lookBase: 6,              // look-ahead distance = lookBase + lookGain x speed (m)
  lookGain: 0.6,
  inset: 0.5,               // the look-ahead window's road edges are inset this far
  fullError: 0.35,          // rad outside the window for a full-lock correction
  wrongWay: (100 * Math.PI) / 180,   // facing further off than this -> full lock toward the road
  driftLimit: 2,            // drifting: look-ahead correction gain on the arc x (it caps / raises x; 0 = player's lock wins)
  driftRotate: 1,           // drifting: edge rotation correction (x rotate), judged on the direction of travel ...
  driftNoseLead: 0.35,      // ... and on the nose beyond this lead (rad, ~20°: a drift's normal slip)
  litSteer: 0.1,            // |assisted - player steer| above this lights the antenna ...
  litEdge: 0.25,            // ... as does an edge weight above this
};

const A = ASSIST_TUNE;

// Grass grip can never exceed this max-speed multiplier, whatever the tires.
export const OFFROAD_MULT_MAX = KART.offroadMultMax;

// Scratch for the assist look-ahead (no per-step allocations).
const _aFrame = {};
const _latchFrame = {};
const _aPa = new THREE.Vector3();
const _aPb = new THREE.Vector3();

// v5 (§C2): hit causes a kart in a big leap (bigJump, Tarantella Jump) flies
// over: every item id plus the native ground causes, except the attacks that
// reach the sky (capo blast, zap, espresso, star / beer rams, the accordion).
const AIR_EXEMPT = new Set(['capo', 'zap', 'espresso', 'star', 'beer', 'beer_rocket', 'accordion', 'golden_toot']);
const AIR_BLOCK = new Set([...ITEM_IDS, 'bomb', 'coal', 'stink', 'banana'].filter((c) => !AIR_EXEMPT.has(c)));
/** Does a big leap (kart.airImmune) dodge a hit with this cause? */
export function airDodges(cause) { return AIR_BLOCK.has(cause); }

export class Kart {
  /**
   * @param {object} o
   * @param {string} [o.id]
   * @param {object} o.character          roster def (characters.js)
   * @param {Track} o.track
   * @param {boolean} [o.isPlayer=false]   a human's kart (HUD, roulette time, assist eligible)
   * @param {object|null} [o.loadout]      { body, wheels } (parts.js); sanitized here
   * @param {number} [o.ccMult=1]          engine class speed multiplier (parts.js ENGINE_CLASSES)
   * @param {boolean} [o.steerAssist=false] Steer Assist on (humans only; CPUs never)
   * @param {number|null} [o.slot=null]    player slot 1..4 (humans)
   */
  constructor({ id, character, track, isPlayer = false, loadout = null, ccMult = 1, steerAssist = false, slot = null }) {
    this.id = id ?? (character && character.id);
    this.character = character;
    this.isPlayer = isPlayer;
    this.track = track;
    this.slot = slot;
    this.name = (character && character.name) || String(this.id);
    this.shortName = (character && (character.shortName || character.name)) || this.name;
    this.cssColor = (character && character.cssColor) || '#ffffff';
    this.loadout = sanitizeLoadout(loadout);
    this.ccMult = ccMult > 0 ? ccMult : 1;
    this.ratings = computeRatings(character, this.loadout);
    this.stats = statsFromRatings(this.ratings);
    this.stats.topSpeed *= this.ccMult;
    this.stats.accel *= this.ccMult;
    this.stats.offroadMult = Math.min(OFFROAD_MULT_MAX, KART.offroadSpeedMult + offroadBonus(this.loadout));
    this.steerAssist = !!steerAssist;
    this.assist = 0;                        // Steer Assist strength this step (0..1; 0 = antenna off)
    this.assistDir = 0;                     // its direction: -1 left, +1 right (steer convention)

    this.position = new THREE.Vector3();
    this.yaw = 0;
    this.velocity = new THREE.Vector3();
    this.grounded = true;
    this.airTime = 0;
    this.lastAirTime = 0;

    this.input = { steer: 0, throttle: 0, brake: 0, drift: false, useItem: false };
    this.proj = {};
    this.hint = -1;

    this.drift = { active: false, dir: 0, charge: 0, tier: 0, hopping: false };
    this.boostTimer = 0;
    this.boostSource = null;
    this.boostMult = KART.boostSpeedMult;   // max-speed multiplier of the running boost
    this.starTimer = 0;
    this.spinTimer = 0;
    this.spinDuration = HIT.spinDuration;   // length of the current spin (for views)
    this.tumbleTimer = 0;
    this.slowTimer = 0;
    this.invulnTimer = 0;
    this.stallTimer = 0;
    this.frozen = false;
    this.speedMult = 1;
    // v5 kart-state effects (§C2; header). Timers count down in _tickTimers.
    this.itemSpeedMult = 1;                 // free max-speed factor for item plugins (default 1)
    this.offroadImmune = false;             // items side flag: grass costs nothing (potato)
    this.coins = 0;                         // lire 0..COIN.max (items/coins.js)
    this.potatoTimer = 0;                   // Hot Potato fuse left (items/hot_potato.js)
    this.iceTimer = 0; this.iceDuration = HIT.iceTime;
    this.shrinkTimer = 0;
    this.squashTimer = 0; this.squashDuration = HIT.squashTime;
    this.sootTimer = 0;
    this.ghostTimer = 0;
    this.megaTimer = 0;
    this.sizeMult = 1;                      // eased body scale: 0.55 shrunk .. 2.2 giant (collisions, views)
    this.airImmune = false;                 // in a big leap (bigJump) until it lands
    this.surface = 'road';
    this.steerVisual = 0;
    this.yawRate = 0;
    this.wallContact = 0;                   // > 0 for a moment after touching a wall

    // race bookkeeping (race.js)
    this.distance = 0; this.lap = 0; this.place = 0; this.finished = false;
    this.finishTime = null; this.lapTimes = []; this.lapStartTime = 0; this.wrongWay = false;
    // item bookkeeping (items.js)
    this.item = null; this.itemCount = 0; this.rolling = false; this.rollTimer = 0; this.rollItem = null;

    // internals
    this._driftHeld = false;
    this._driftAir = 0;
    this._landGrace = 0;
    this._padCooldown = 0;
    this._wallCooldown = 0;
    this._bumpCooldown = 0;
    this._bumpSlide = 0;
    this._wallAlignYaw = 0;
    this._wallAlignTimer = 0;
    this._exitTimer = 0;      // drift exit: nose eased onto the direction of travel
    this._exitDir = 0;        // ... of the drift that just ended
    this._driftTime = 0;      // s the current / last drift has lasted
    this._latchOn = false;    // drift-exit steering latch running (exitLatch*)
    this._latchT = 0;         // ... s since it started
    this._latchDir = 0;       // ... direction of the drift that ended (+1 right)
    this._prevSlope = 0;      // road slope (incl. ramp) under the kart last step
    this._trick = 0;          // jump boost: 0 none, 1 DRIFT pressed in the air, 2 trick done (boost on landing)
    this._moved = false;
  }

  // ------------------------------------------------------------- queries

  get speed() {
    return this.velocity.x * Math.sin(this.yaw) + this.velocity.z * Math.cos(this.yaw);
  }

  get horizontalSpeed() { return Math.hypot(this.velocity.x, this.velocity.z); }

  // Road slope dy/ds (along the track tangent) under the kart, including
  // kicker ramps. Used by views to pitch the model.
  get roadSlope() { return this._prevSlope; }

  get maxSpeed() {
    let m = this.stats.topSpeed * this.speedMult * this.stateSpeedMult;
    const star = this.starTimer > 0, boost = this.boostTimer > 0;
    if (!star && !boost && !this.isOffroadProof()) {
      if (this.surface === 'offroad') m *= this.stats.offroadMult;
      else if (this.surface === 'curb') m *= KART.curbSpeedMult;
    }
    if (boost) m *= this.boostMult;
    if (star) m *= KART.starSpeedMult;
    if (this.slowTimer > 0) m *= HIT.zapSlowMult;
    return m;
  }

  /** Speed a drift needs to start (m/s): a share of this kart's top speed. */
  get driftStartSpeed() {
    return Math.max(DRIFT.minSpeed * 0.8, (DRIFT.startSpeedFrac || 0) * this.stats.topSpeed);
  }

  /** Angle (rad) by which the nose leads the direction of travel into the drift (0 when not drifting). */
  get driftSlip() { return this._driftLead(); }

  // Angle (rad) by which the nose leads the direction of travel INTO the drift
  // (0 when slow or not drifting).
  _driftLead() {
    const v = this.velocity, d = this.drift;
    if (!d.active || Math.hypot(v.x, v.z) < 3) return 0;
    return -d.dir * angleDiff(Math.atan2(v.x, v.z), this.yaw);
  }

  // Drift yaw rate magnitude (rad/s) for the wheel position x = steer * dir:
  // the arc (turnRate x driftTightness), never tighter than driftMinRadius at
  // the current speed, faded out while the nose already leads the travel
  // direction by driftSlipFade0..1 degrees (a drift can't rotate the kart
  // round: the velocity has to keep up).
  _driftYawRate(x, aF) {
    const v = this.velocity;
    let w = this.stats.turnRate * driftTightness(x);
    if (T.driftMinRadius > 0) w = Math.min(w, Math.hypot(v.x, v.z) / T.driftMinRadius);
    else w *= Math.min(1, aF / 10);
    if (T.driftSlipFade1 > T.driftSlipFade0) {
      const lead = this._driftLead() / DEG2RAD;
      if (lead > T.driftSlipFade0) w *= clamp(1 - (lead - T.driftSlipFade0) / (T.driftSlipFade1 - T.driftSlipFade0), 0, 1);
    }
    return w;
  }

  /**
   * Max-speed factor of the v5 kart states (§C2): lire x potato x giant x shrink
   * x squash x soot x itemSpeedMult. 1 for a kart without any of them.
   */
  get stateSpeedMult() {
    let m = this.itemSpeedMult;
    if (this.coins > 0) m *= 1 + COIN.speedPerCoin * Math.min(this.coins, COIN.max);
    if (this.potatoTimer > 0) m *= ITEM5.potatoSpeedMult;
    if (this.megaTimer > 0) m *= ITEM5.mortSpeedMult;
    if (this.shrinkTimer > 0) m *= HIT.shrinkSpeedMult;
    if (this.squashTimer > 0) m *= HIT.squashSpeedMult;
    if (this.sootTimer > 0) m *= HIT.sootSpeedMult;
    return m;
  }

  /** Grass / curbs cost nothing: offroadImmune (potato), ghost or giant. */
  isOffroadProof() { return this.offroadImmune || this.ghostTimer > 0 || this.megaTimer > 0; }

  isInvincible() { return this.starTimer > 0; }
  isHittable() {
    return this.starTimer <= 0 && this.invulnTimer <= 0 && this.spinTimer <= 0 && this.tumbleTimer <= 0 &&
      this.iceTimer <= 0 && this.squashTimer <= 0 && this.ghostTimer <= 0 && this.megaTimer <= 0;
  }
  isDisabled() { return this.spinTimer > 0 || this.tumbleTimer > 0 || this.iceTimer > 0; }
  /** Items locked (Befana's soot): items.js useItem refuses. */
  get itemsLocked() { return this.sootTimer > 0; }
  /** Shrunk below full size (shrink, not a giant growing back). */
  get isShrunk() { return this.shrinkTimer > 0; }

  // ------------------------------------------------------------- control

  placeOnGrid(slot) {
    this.position.copy(slot.position);
    this.yaw = slot.yaw;
    this._resetState();
    this.hint = -1;
    this.track.project(this.position, -1, this.proj);
    this.hint = this.proj.index;
    this.position.y = this.proj.height;
    this.surface = this.proj.surface;
  }

  _resetState() {
    this.velocity.set(0, 0, 0);
    this.yawRate = 0;
    this.grounded = true;
    this.airTime = 0;
    this.lastAirTime = 0;
    const d = this.drift;
    d.active = false; d.dir = 0; d.charge = 0; d.tier = 0; d.hopping = false;
    this.boostTimer = 0; this.starTimer = 0; this.spinTimer = 0; this.tumbleTimer = 0;
    this.slowTimer = 0; this.invulnTimer = 0; this.stallTimer = 0;
    this.steerVisual = 0;
    this.wallContact = 0;
    this._driftAir = 0; this._landGrace = 0; this._padCooldown = 0;
    this._wallCooldown = 0; this._bumpCooldown = 0; this._bumpSlide = 0; this._prevSlope = 0;
    this._wallAlignTimer = 0;
    this._exitTimer = 0;
    this._latchOn = false; this._latchT = 0; this._latchDir = 0;
    this._trick = 0;
    this.boostMult = KART.boostSpeedMult;
    this.assist = 0; this.assistDir = 0;
    this._driftHeld = !!this.input.drift;
    // v5 states end on the grid / a respawn (coins and the potato are the items side's)
    this.iceTimer = 0; this.shrinkTimer = 0; this.squashTimer = 0; this.sootTimer = 0;
    if (this.ghostTimer > 0) { this.ghostTimer = 0; bus.emit('kart:ghostEnd', { kart: this }); }
    if (this.megaTimer > 0) { this.megaTimer = 0; bus.emit('kart:megaEnd', { kart: this, cause: 'reset' }); }
    this.sizeMult = 1;
    this.airImmune = false;
  }

  /**
   * Start (or extend) a boost. Overlapping boosts keep the larger multiplier
   * and the longer remaining time. Drift mini-turbos and tricks pass
   * DRIFT.boostSpeedMult; pads, Toot items and the start boost use the default.
   * `tier` (drift boosts) is forwarded in the kart:boost event.
   */
  applyBoost(duration, source = 'item', mult = KART.boostSpeedMult, tier = 0) {
    if (!(duration > 0)) return;
    this.boostMult = this.boostTimer > 0 ? Math.max(this.boostMult, mult) : mult;
    this.boostTimer = Math.max(this.boostTimer, duration);
    this.boostSource = source;
    bus.emit('kart:boost', { kart: this, source, duration, mult, tier });
  }

  /** Mini-turbo length for a drift tier (longer with more Accel stars). */
  driftBoostDuration(tier) {
    const base = DRIFT.boostDurations[tier] || 0;
    return base * (1 + DRIFT.boostAccelGain * ((this.ratings.accel || 3) - 3));
  }

  spinOut(cause = 'banana') {
    if (!this.isHittable() || (this.airImmune && airDodges(cause))) return false;
    this._beginSpin(HIT.spinDuration, cause);
    return true;
  }

  tumble(cause = 'rocket') {
    if (!this.isHittable() || (this.airImmune && airDodges(cause))) return false;
    this.tumbleTimer = HIT.tumbleDuration;
    this._cancelDrift();
    this.boostTimer = 0;
    this._trick = 0;
    if (!this.frozen) {
      this.velocity.y = Math.max(this.velocity.y, T.tumbleHop);
      this.grounded = false;
      this.airTime = 0;
    }
    bus.emit('kart:tumble', { kart: this, cause });
    return true;
  }

  zap() {
    if (this.isInvincible() || this.ghostTimer > 0) return false;
    if (this.megaTimer > 0) {
      // a giant is only cut down to size (no other penalty, §C2)
      this.megaTimer = 0;
      bus.emit('kart:megaEnd', { kart: this, cause: 'zap' });
      return false;
    }
    this.slowTimer = Math.max(this.slowTimer, HIT.zapSlowDuration);
    if (!this.isDisabled()) this._beginSpin(HIT.zapSpinDuration, 'zap');
    return true;
  }

  // ---- v5 kart-state effects (§C2). Each returns true when it took effect and
  // emits kart:<effect> { kart, cause, duration, by? }. ctx.hit (items/context.js)
  // calls freeze / shrink / squash / soot with (duration, cause) after its immunity check.

  /** Frozen solid (Granita): disabled, sliding straight, then invulnerable like a spin. */
  freeze(t = HIT.iceTime, cause = 'granita') {
    if (!this.isHittable() || (this.airImmune && airDodges(cause)) || !(t > 0)) return false;
    this.iceTimer = t;
    this.iceDuration = t;
    this._cancelDrift();
    this.boostTimer = 0;
    this._trick = 0;
    this.yawRate = 0;
    bus.emit('kart:freeze', { kart: this, cause, duration: t });
    return true;
  }

  /**
   * Shrunk (Sour Lemon, a Hot Potato pop): small, slower, still hittable. A
   * second Sour Lemon while shrunk restores the normal size (kart:unshrink).
   * `force` skips the hittable check (the potato bursting on its holder).
   */
  shrink(t = HIT.shrinkTime, cause = 'sour_lemon', force = false) {
    if (!(t > 0)) return false;
    if (!force && (!this.isHittable() || (this.airImmune && airDodges(cause)))) return false;
    if (this.shrinkTimer > 0 && cause === 'sour_lemon') {
      this.shrinkTimer = 0;
      bus.emit('kart:unshrink', { kart: this, cause });
      return true;
    }
    this.shrinkTimer = Math.max(this.shrinkTimer, t);
    bus.emit('kart:shrink', { kart: this, cause, duration: t });
    return true;
  }

  /** Back to full size at once. */
  unshrink() {
    if (!(this.shrinkTimer > 0)) return false;
    this.shrinkTimer = 0;
    bus.emit('kart:unshrink', { kart: this, cause: 'restore' });
    return true;
  }

  /**
   * Flattened (Maxi Mortadella, running over a shrunk kart): speed x0.35,
   * steering x0.6, not hittable during, invulnerable after. The items side
   * drops the held item and takes the lire (items/coins.js on kart:squash).
   */
  squash(t = HIT.squashTime, cause = 'mortadella', by = null) {
    if (!this.isHittable() || (this.airImmune && airDodges(cause)) || !(t > 0)) return false;
    this.squashTimer = t;
    this.squashDuration = t;
    this._cancelDrift();
    this.boostTimer = 0;
    this._trick = 0;
    bus.emit('kart:squash', { kart: this, cause, duration: t, by });
    return true;
  }

  /** Sooted (Befana): the drift is cancelled, items locked, a little slower. Lands on invulnerable karts too. */
  soot(t = HIT.sootTime, cause = 'befana') {
    if (this.isInvincible() || this.ghostTimer > 0 || this.megaTimer > 0 || !(t > 0)) return false;
    const fresh = !(this.sootTimer > 0);
    this.sootTimer = Math.max(this.sootTimer, t);
    if (fresh) this._cancelDrift();
    bus.emit('kart:soot', { kart: this, cause, duration: t });
    return true;
  }

  /** Ghost (Ladro Mask): intangible to karts, items and course hazards; offroad-proof. */
  ghost(t = ITEM5.ladroTime) {
    if (!(t > 0)) return false;
    const was = this.ghostTimer > 0;
    this.ghostTimer = Math.max(this.ghostTimer, t);
    if (!was) bus.emit('kart:ghostStart', { kart: this, duration: t });
    return true;
  }

  /** Giant (Maxi Mortadella): grows to ITEM5.mortScale, faster, item-proof (a zap ends it). */
  grow(t = ITEM5.mortTime) {
    if (!(t > 0)) return false;
    const was = this.megaTimer > 0;
    this.megaTimer = Math.max(this.megaTimer, t);
    this.shrinkTimer = 0;
    this.squashTimer = 0;
    if (!was) bus.emit('kart:megaStart', { kart: this, duration: t });
    return true;
  }

  /** End the giant state early (kart:megaEnd { cause }). */
  endGrow(cause = 'end') {
    if (!(this.megaTimer > 0)) return false;
    this.megaTimer = 0;
    bus.emit('kart:megaEnd', { kart: this, cause });
    return true;
  }

  /**
   * A tall leap (Tarantella Jump): vertical speed `vy`, airImmune until it
   * lands (ground items and hazards miss, airDodges). A charged drift pays out
   * first; DRIFT pressed in the air earns the trick boost on landing. False if
   * not on the ground / disabled / race-frozen.
   */
  bigJump(vy = ITEM5.jumpVy) {
    if (!this.grounded || this.frozen || this.isDisabled() || !(vy > 0)) return false;
    if (this.drift.active) this._endDrift();
    this.drift.hopping = false;
    this.velocity.y = Math.max(this.velocity.y, vy);
    this.grounded = false;
    this.airTime = 0;
    this.airImmune = true;
    this._trick = 0;
    bus.emit('kart:bigJump', { kart: this, vy });
    return true;
  }

  _beginSpin(duration, cause) {
    this.spinTimer = duration;
    this.spinDuration = duration;
    this._cancelDrift();
    this.boostTimer = 0;
    this._trick = 0;
    bus.emit('kart:spin', { kart: this, cause });
  }

  startStar(duration = STAR.duration) {
    const was = this.starTimer > 0;
    this.starTimer = Math.max(this.starTimer, duration);
    this.spinTimer = 0;
    this.tumbleTimer = 0;
    this.slowTimer = 0;
    // a star also thaws, un-flattens, restores the size and wipes the soot (v5)
    this.iceTimer = 0; this.squashTimer = 0; this.sootTimer = 0;
    if (this.shrinkTimer > 0) this.unshrink();
    if (!was) bus.emit('kart:starStart', { kart: this });
  }

  respawn() {
    const tr = this.track;
    let s = this.proj && isFinite(this.proj.s) ? this.proj.s : 0;
    if (!isFinite(s)) s = 0;
    const f = tr.frameAt(s);
    tr.pointAt(s, 0, this.position);
    this.yaw = f.yaw;
    this._resetState();
    this.invulnTimer = Math.max(this.invulnTimer, 1.5);
    this.hint = -1;
    tr.project(this.position, -1, this.proj);
    this.hint = this.proj.index;
    this.position.y = this.proj.height;
    this.surface = this.proj.surface;
    bus.emit('kart:respawn', { kart: this });
  }

  _startDrift(dir) {
    const d = this.drift;
    d.active = true;
    d.dir = dir;
    d.charge = 0;
    d.tier = 0;
    this._driftTime = 0;
    this._driftAir = 0;
    this._landGrace = 0;
    this._latchOn = false;
    bus.emit('kart:driftStart', { kart: this, dir });
  }

  // Release: mini-turbo for tier >= 1.
  _endDrift() {
    const d = this.drift;
    if (!d.active) return;
    const tier = d.tier;
    this._exitDir = d.dir;
    d.active = false; d.dir = 0; d.charge = 0; d.tier = 0;
    this._exitTimer = this._driftTime >= T.driftExitMinTime ? T.driftExitTime : 0;
    this._armExitLatch();
    if (tier >= 1) this.applyBoost(this.driftBoostDuration(tier), 'drift', DRIFT.boostSpeedMult, tier);
    bus.emit('kart:driftEnd', { kart: this, tier });
  }

  // Abort without reward (spin, too slow, too long airborne).
  _cancelDrift() {
    const d = this.drift;
    d.hopping = false;
    this._landGrace = 0;
    if (!d.active) return;
    this._exitDir = d.dir;
    d.active = false; d.dir = 0; d.charge = 0; d.tier = 0;
    this._exitTimer = this._driftTime >= T.driftExitMinTime ? T.driftExitTime : 0;
    this._armExitLatch();
    bus.emit('kart:driftEnd', { kart: this, tier: 0, cancelled: true });
  }

  // Drift-exit steering latch: starts when a human's drift of at least
  // exitLatchMinDrift ends (release, wall, too slow, cancel, the heading limit).
  _armExitLatch() {
    if (!this.isPlayer || !(T.exitLatchTime > 0) || !this._exitDir || this._driftTime < T.exitLatchMinDrift) return;
    this._latchOn = true;
    this._latchT = 0;
    this._latchDir = this._exitDir;
  }

  // Filters the player's wheel `u` while the drift-exit latch runs. Into the
  // old turn the wheel is capped at a ceiling that rises smoothstep from
  // exitLatchStart to 1 over exitLatchTime, but only while the nose points
  // at/inside where the road goes exitLatchLook s ahead (the corner is over for
  // it; if the corner continues the live tilt passes). It hands the wheel back
  // early once the player's own wheel is within the ceiling. Counter-steer
  // always passes. Runs before Steer Assist, which can still correct.
  _exitLatch(u, disabled, dt) {
    let out = u;
    const proj = this.proj;
    if (!disabled && isFinite(proj.s)) {
      const dir = this._latchDir, x = u * dir;
      const k = clamp(this._latchT / T.exitLatchTime, 0, 1);
      const ceil = T.exitLatchStart + (1 - T.exitLatchStart) * k * k * (3 - 2 * k);
      const fr = this.track.frameAt(proj.s + Math.max(4, Math.max(0, this.speed) * T.exitLatchLook), _latchFrame);
      const noseInto = -dir * angleDiff(fr.yaw, this.yaw);   // > 0: nose at/inside where the road is going
      if (noseInto > 0) {
        if (x > ceil) out = ceil * dir;                       // hold back the leftover tilt
        else this._latchOn = false;                           // wheel back within the ceiling: hand back
      }
    }
    this._latchT += dt;
    if (this._latchT >= T.exitLatchTime) this._latchOn = false;
    return out;
  }

  /** Drift-exit latch state for views / probes: null, or { t, dir } while it runs. */
  get exitLatch() { return this._latchOn ? { t: this._latchT, dir: this._latchDir } : null; }

  _tickTimers(dt) {
    if (this.boostTimer > 0) this.boostTimer = Math.max(0, this.boostTimer - dt);
    if (this.starTimer > 0) {
      this.starTimer -= dt;
      if (this.starTimer <= 0) { this.starTimer = 0; bus.emit('kart:starEnd', { kart: this }); }
    }
    if (this.spinTimer > 0) {
      this.spinTimer -= dt;
      if (this.spinTimer <= 0) {
        this.spinTimer = 0;
        if (this.tumbleTimer <= 0) this.invulnTimer = Math.max(this.invulnTimer, HIT.invulnAfterHit);
      }
    }
    if (this.tumbleTimer > 0) {
      this.tumbleTimer -= dt;
      if (this.tumbleTimer <= 0) {
        this.tumbleTimer = 0;
        if (this.spinTimer <= 0) this.invulnTimer = Math.max(this.invulnTimer, HIT.invulnAfterHit);
      }
    }
    if (this.slowTimer > 0) this.slowTimer = Math.max(0, this.slowTimer - dt);
    this._tickStates(dt);
    if (this.invulnTimer > 0 && !this.isDisabled()) this.invulnTimer = Math.max(0, this.invulnTimer - dt);
    if (this.stallTimer > 0) this.stallTimer = Math.max(0, this.stallTimer - dt);
    if (this._padCooldown > 0) this._padCooldown -= dt;
    if (this._wallCooldown > 0) this._wallCooldown -= dt;
    if (this._bumpCooldown > 0) this._bumpCooldown -= dt;
    if (this._bumpSlide > 0) this._bumpSlide -= dt;
    if (this._wallAlignTimer > 0) this._wallAlignTimer -= dt;
    if (this._exitTimer > 0) this._exitTimer -= dt;
    if (this._landGrace > 0) this._landGrace -= dt;
    if (this.wallContact > 0) this.wallContact -= dt;
  }

  // v5 state timers (§C2) + the eased size. Ice and squash end into the
  // usual after-hit grace; the giant and the ghost announce their end.
  _tickStates(dt) {
    if (this.iceTimer > 0) {
      this.iceTimer -= dt;
      if (this.iceTimer <= 0) {
        this.iceTimer = 0;
        if (this.spinTimer <= 0 && this.tumbleTimer <= 0) this.invulnTimer = Math.max(this.invulnTimer, HIT.invulnAfterHit);
        bus.emit('kart:thaw', { kart: this });
      }
    }
    if (this.squashTimer > 0) {
      this.squashTimer -= dt;
      if (this.squashTimer <= 0) { this.squashTimer = 0; this.invulnTimer = Math.max(this.invulnTimer, HIT.invulnAfterHit); }
    }
    if (this.shrinkTimer > 0) {
      this.shrinkTimer -= dt;
      if (this.shrinkTimer <= 0) { this.shrinkTimer = 0; bus.emit('kart:unshrink', { kart: this, cause: 'end' }); }
    }
    if (this.sootTimer > 0) this.sootTimer = Math.max(0, this.sootTimer - dt);
    if (this.ghostTimer > 0) {
      this.ghostTimer -= dt;
      if (this.ghostTimer <= 0) { this.ghostTimer = 0; bus.emit('kart:ghostEnd', { kart: this }); }
    }
    if (this.megaTimer > 0) {
      this.megaTimer -= dt;
      if (this.megaTimer <= 0) { this.megaTimer = 0; bus.emit('kart:megaEnd', { kart: this, cause: 'end' }); }
    }
    // size: grow to the giant over mortGrow s, back over mortShrinkBack s; shrink / restore in ~0.25 s
    const want = this.megaTimer > 0 ? ITEM5.mortScale : this.shrinkTimer > 0 ? HIT.shrinkScale : 1;
    const s = this.sizeMult;
    if (s !== want) {
      let rate;
      if (want > s) rate = s >= 1 ? (ITEM5.mortScale - 1) / ITEM5.mortGrow : (1 - HIT.shrinkScale) / 0.25;
      else rate = s > 1 ? (ITEM5.mortScale - 1) / ITEM5.mortShrinkBack : (1 - HIT.shrinkScale) / 0.25;
      this.sizeMult = want > s ? Math.min(want, s + rate * dt) : Math.max(want, s - rate * dt);
    }
  }

  /** Collision radius (m): KART.radius x the current size. */
  get radius() { return KART.radius * this.sizeMult; }

  // Slope contribution of kicker ramps at the projected point (matches track.rampHeight).
  _rampSlope(proj) {
    if (!proj.onRamp) return 0;
    const ramps = this.track.ramps;
    let best = 0, bestH = 0;
    for (let i = 0; i < ramps.length; i++) {
      const r = ramps[i];
      const d = this.track.deltaS(r.s0, proj.s);
      if (d < 0 || d > r.length) continue;
      const inside = r.fullWidth ? Math.abs(proj.lateral) <= proj.halfWidth : proj.lateral >= r.lat0 && proj.lateral <= r.lat1;
      if (!inside) continue;
      const h = (r.height * d) / r.length;
      if (h >= bestH) { bestH = h; best = r.height / r.length; }
    }
    return best;
  }

  // ---------------------------------------------------------------- step

  update(dt) {
    if (!(dt > 0)) return;
    if (dt > 0.05) dt = 0.05;
    const tr = this.track, p = this.position, v = this.velocity, inp = this.input, d = this.drift, proj = this.proj;
    this._tickTimers(dt);

    if (this.frozen) {
      v.set(0, 0, 0);
      this.yawRate = 0;
      tr.project(p, this.hint, proj);
      this.hint = proj.index;
      p.y = proj.height;
      this.grounded = true;
      this.airTime = 0;
      this.airImmune = false;
      this.surface = proj.surface;
      this._prevSlope = proj.slope;
      if (d.active || d.hopping) this._cancelDrift();
      this._latchOn = false;
      this._driftHeld = !!inp.drift;
      this._trick = 0;
      this.assist = 0; this.assistDir = 0;
      this.steerVisual = damp(this.steerVisual, clamp(+inp.steer || 0, -1, 1), 12, dt);
      return;
    }

    const disabled = this.isDisabled();
    let steer = disabled ? 0 : clamp(+inp.steer || 0, -1, 1);
    const wheel = steer;                     // the player's own wheel, before Steer Assist (and the exit latch)
    if (this._latchOn) steer = this._exitLatch(steer, disabled, dt);
    if (this.steerAssist && !disabled) steer = this._assist(steer, dt);
    else { this.assist = 0; this.assistDir = 0; }
    // what picks a drift's direction: near an edge the assist steers away from
    // it (often out of the corner), so it must not choose the side for the player
    const sideSteer = T.driftDirFromPlayer ? wheel : steer;
    const throttle = disabled || this.stallTimer > 0 ? 0 : clamp(+inp.throttle || 0, 0, 1);
    const brake = disabled ? 0 : clamp(+inp.brake || 0, 0, 1);
    const driftBtn = !disabled && !!inp.drift;
    const st = this.stats;

    // ---- drift button: hop / start / release
    const pressed = driftBtn && !this._driftHeld;
    this._driftHeld = driftBtn;
    if (pressed && this.grounded && !d.active && this.speed >= DRIFT.minSpeed) {
      v.y = DRIFT.hopVelocity;
      this.grounded = false;
      this.airTime = 0;
      d.hopping = true;
      this._latchOn = false;                 // a new DRIFT press is a new intent: the wheel is the player's again
      bus.emit('kart:hop', { kart: this });
      // as in modern kart racers the direction can wait for the landing: a phone's
      // tilt reaches the host after the thumb's press
      if (!T.driftDirAtLanding && Math.abs(sideSteer) > T.driftDirMin && this.speed >= this.driftStartSpeed) this._startDrift(Math.sign(sideSteer));
    }
    if (d.active && !driftBtn) this._endDrift();
    if (!driftBtn) this._landGrace = 0;
    // jump boost: DRIFT pressed soon after leaving a ramp / crest (not a drift hop)
    // (a big leap, bigJump, takes the trick press any time in the air)
    if (pressed && !this.grounded && !d.hopping && !d.active && this._trick === 0 && (this.airTime <= DRIFT.trickWindow || this.airImmune)) this._trick = 1;

    // ---- steering -> yaw
    let vF0 = this.speed;
    const aF = Math.abs(vF0);
    let target;
    if (d.active) {
      target = -d.dir * this._driftYawRate(steer * d.dir, aF);
    } else {
      let f = Math.min(1, aF / T.turnRefSpeed);
      f *= 1 - T.highSpeedTurnLoss * clamp((aF - 12) / 18, 0, 1);
      target = -steer * st.turnRate * f * (vF0 < -0.5 ? -1 : 1);
    }
    if (!this.grounded) target *= d.hopping ? T.hopSteer : T.airSteer;
    if (this.squashTimer > 0) target *= HIT.squashSteerMult;
    if (disabled) target = 0;
    const iced = this.iceTimer > 0;
    this.yawRate = iced ? 0 : damp(this.yawRate, target, T.yawResponse, dt);
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);
    if (d.active && T.driftSlipMax > 0) {
      // the nose never leads the travel direction by more than driftSlipMax
      const lead = this._driftLead();
      const max = T.driftSlipMax * DEG2RAD;
      if (lead > max) {
        this.yaw = wrapAngle(this.yaw + d.dir * (lead - max));
        if (this.yawRate * d.dir < 0) this.yawRate = 0;
      }
    }
    if (this._wallAlignTimer > 0 && !d.active) {
      this.yaw = wrapAngle(this.yaw + angleDiff(this.yaw, this._wallAlignYaw) * (1 - Math.exp(-T.wallAlign * dt)));
    }
    let exitAlign = false;
    if (this._exitTimer > 0 && this._wallAlignTimer <= 0 && !d.active && !disabled && this.grounded && Math.hypot(v.x, v.z) > 3) {
      // drift exit: the slip closes mostly by the nose swinging onto the
      // direction of travel (the arc the drift was following) rather than by
      // the grip snapping the kart's path onto the over-rotated nose
      const vy = Math.atan2(v.x, v.z);
      let to = angleDiff(this.yaw, vy);
      if (T.driftExitRoad && this._exitDir) {
        // only undo over-rotation: angles measured into the old turn, the road
        // direction 0; the nose comes back to the path, but not past the road
        const into = -this._exitDir;
        const nose = into * angleDiff(proj.yaw, this.yaw), path = into * angleDiff(proj.yaw, vy);
        const target = Math.max(path, 0);
        to = nose > target ? -into * (nose - target) : 0;
      }
      if (to !== 0) {
        exitAlign = true;
        this.yaw = wrapAngle(this.yaw + to * (1 - Math.exp(-T.driftExitAlign * dt)));
      }
    }

    // ---- decompose horizontal velocity on the new heading
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const rx = -fz, rz = fx;
    let vF = v.x * fx + v.z * fz;
    let vR = v.x * rx + v.z * rz;

    // ---- longitudinal
    let maxS = this.maxSpeed;
    if (d.active) maxS *= T.driftSpeedMult;
    if (iced) {
      // frozen solid: slides straight on, losing HIT.iceSlideDecel m/s every s (grounded)
      if (this.grounded) {
        const hs = Math.hypot(vF, vR);
        if (hs > 1e-6) { const k = Math.max(0, hs - HIT.iceSlideDecel * dt) / hs; vF *= k; vR *= k; }
      }
    } else if (disabled) {
      const k = Math.exp(-(this.tumbleTimer > 0 ? T.tumbleDecay : T.spinDecay) * dt);
      vF *= k; vR *= k;
    } else if (this.grounded) {
      const boosting = this.boostTimer > 0;
      const hs = Math.hypot(vF, vR);
      if (brake > 0 && vF > 0.5 && !boosting) {
        vF = Math.max(0, vF - KART.brakeDecel * brake * dt);
      } else if (brake > 0 && throttle <= 0 && !boosting) {
        // reverse
        if (vF > -KART.reverseMax) vF = Math.max(-KART.reverseMax, vF - T.reverseAccel * brake * dt);
      } else if (throttle > 0 || boosting) {
        if (vF < -0.5) {
          vF = Math.min(0, vF + KART.brakeDecel * dt);
        } else if (hs < maxS) {
          const x = hs / maxS;
          let a = st.accel * Math.max(T.accelFloor, 1 - Math.pow(x, T.accelExp)) * throttle;
          if (this.surface === 'offroad' && !boosting && this.starTimer <= 0 && !this.isOffroadProof()) a *= T.offroadAccelMult;
          if (this.shrinkTimer > 0) a *= HIT.shrinkAccelMult;
          if (boosting) a = Math.max(a, KART.boostAccel);
          const nv = vF + a * dt;
          // never exceed max with the total horizontal speed
          const lim = Math.sqrt(Math.max(0, maxS * maxS - vR * vR));
          vF = Math.max(vF, Math.min(nv, lim));
        }
      } else if (vF > 0) {
        vF = Math.max(0, vF - KART.coastDecel * dt);
      } else if (vF < 0) {
        vF = Math.min(0, vF + KART.coastDecel * dt);
      }
      // overspeed: ease back down (boost tail, entering grass)
      const hs2 = Math.hypot(vF, vR);
      if (hs2 > maxS + 1e-3) {
        const over = hs2 - maxS;
        const dec = clamp(T.overspeedMin + over * T.overspeedGain, T.overspeedMin, T.overspeedMax);
        const nh = Math.max(maxS, hs2 - dec * dt);
        const k = nh / hs2;
        vF *= k; vR *= k;
      }
      // steering scrubs a little speed (drifting doesn't: that's the reward)
      if (!d.active && !boosting) {
        const lat = Math.abs(this.yawRate * vF);
        vF -= Math.sign(vF) * Math.min(Math.abs(vF), T.cornerDrag * lat * dt);
      }
      // gravity along the slope
      const tdot = fx * proj.tangent.x + fz * proj.tangent.z;
      if (isFinite(proj.slope)) vF -= T.slopeAccel * proj.slope * tdot * dt;
    } else {
      const k = Math.exp(-T.airDrag * dt);
      vF *= k;
    }

    // ---- lateral grip (redirect most of the sideways momentum forward)
    let grip, transfer;
    if (iced) { grip = 0; transfer = 0; }
    else if (disabled) { grip = T.spinGrip; transfer = 0.3; }
    else if (!this.grounded) { grip = T.airGrip; transfer = 1; }
    else if (d.active) { grip = T.driftGrip; transfer = T.driftTransfer; }
    else if (exitAlign && T.driftExitGrip > 0) { grip = Math.min(T.driftExitGrip, this.surface === 'offroad' ? T.offroadGrip : T.grip); transfer = T.driftTransfer; }
    else if (this.surface === 'offroad') { grip = T.offroadGrip; transfer = T.gripTransfer; }
    else { grip = T.grip; transfer = T.gripTransfer; }
    if (this._bumpSlide > 0 && this.grounded) { grip = Math.min(grip, T.bumpSlideGrip); transfer = 0.2; }
    const vR2 = vR * Math.exp(-grip * dt);
    const dE = vR * vR - vR2 * vR2;
    const tr2 = transfer * clamp(Math.abs(vF) / 6, 0, 1);
    if (tr2 > 0 && dE > 0) vF = (vF >= 0 ? 1 : -1) * Math.sqrt(vF * vF + tr2 * dE);
    vR = vR2;

    v.x = fx * vF + rx * vR;
    v.z = fz * vF + rz * vR;

    // ---- integrate + project
    p.x += v.x * dt;
    p.z += v.z * dt;
    tr.project(p, this.hint, proj);
    this.hint = proj.index;

    // ---- walls
    this._collideWalls(dt, true);

    // ---- vertical
    const h = proj.height;
    const roadSlope = proj.slope + this._rampSlope(proj);
    const tAlong = v.x * proj.tangent.x + v.z * proj.tangent.z;
    const vyRoad = roadSlope * tAlong;
    if (this.grounded) {
      const vyFree = this._prevSlope * tAlong - KART.gravity * dt;
      const yFree = p.y + vyFree * dt;
      if (vyRoad < vyFree - 1e-3 || yFree > h + 0.06) {
        // the road falls away faster than gravity: launch
        this.grounded = false;
        this.airTime = 0;
        v.y = vyFree;
        p.y = Math.max(yFree, h);
      } else {
        p.y = h;
        v.y = vyRoad;
      }
    } else {
      const g = KART.gravity * (d.hopping ? T.hopGravityMult : 1);
      v.y -= g * dt;
      p.y += v.y * dt;
      this.airTime += dt;
      if (this._trick === 1 && this.airTime >= DRIFT.trickMinAir) {
        this._trick = 2;
        bus.emit('kart:trick', { kart: this });
      }
      if (p.y <= h) this._land(h, vyRoad, driftBtn, sideSteer);
    }
    this._prevSlope = roadSlope;
    this.surface = proj.surface;

    // ---- drift bookkeeping
    if (this.grounded && !d.active && driftBtn && this._landGrace > 0 && Math.abs(sideSteer) > T.driftDirMin && this.speed >= this.driftStartSpeed) {
      this._startDrift(Math.sign(sideSteer));
    }
    if (d.active) {
      this._driftTime += dt;
      if (this.grounded) {
        this._driftAir = 0;
        // full charge rate with the wheel held into the turn, slow otherwise
        d.charge += dt * (steer * d.dir >= DRIFT.chargeIntoMin ? 1 : DRIFT.chargeSlowRate);
        const maxTier = this.steerAssist ? DRIFT.assistMaxTier : 3;
        while (d.tier < maxTier && d.charge >= DRIFT.tierTimes[d.tier]) {
          d.tier++;
          bus.emit('kart:driftTier', { kart: this, tier: d.tier });
        }
      } else {
        this._driftAir += dt;
      }
      if (this.speed < T.driftCancelSpeed || this._driftAir > T.driftMaxAir || disabled) this._cancelDrift();
      else if (T.driftMaxHeading > 0 && Math.abs(angleDiff(proj.yaw, this.yaw)) > T.driftMaxHeading * DEG2RAD) {
        // turned round: the drift lets go (no mini-turbo) instead of spinning on
        this._cancelDrift();
      }
      else if (this.grounded && this.speed < DRIFT.keepSpeedFrac * st.topSpeed) {
        // too slow to keep sliding (wall, grass, braking): the drift ends, and
        // pays out a charged mini-turbo unless the player is braking (genre standard)
        if (brake > 0) this._cancelDrift(); else this._endDrift();
      }
    }

    // ---- boost pads
    if (this.grounded && proj.surface === 'boost' && this._padCooldown <= 0) {
      this._padCooldown = 0.5;
      this.applyBoost(BOOST.padDuration, 'pad');
    }

    this.steerVisual = damp(this.steerVisual, steer, 12, dt);

    // ---- safety net
    if (!(isFinite(p.x) && isFinite(p.y) && isFinite(p.z) && isFinite(v.x) && isFinite(v.y) && isFinite(v.z) && isFinite(this.yaw))) {
      this.respawn();
    } else if (p.y < h - 8) {
      this.respawn();
    }
  }

  // Steer Assist for this step (SPEC §14.3a). Runs before steering on the last
  // projection: near an assist edge it pushes the kart inward, bleeds its
  // outward slide and eases the nose along the road (grounded only); a
  // look-ahead window blends a steering correction with the player's input
  // `u`, and facing the wrong way (not drifting) forces full lock toward the
  // road. Writes
  // this.assist / this.assistDir and returns the steer to use.
  _assist(u, dt) {
    const proj = this.proj, v = this.velocity, tr = this.track;
    this.assist = 0; this.assistDir = 0;
    if (!proj.tangent) return u;
    const boosting = this.boostTimer > 0 || this.starTimer > 0;
    let edgeW = 0, edgeDir = 0;

    // ---- movement + rotation correction near the assist edges
    if (this.grounded) {
      const lat = proj.lateral, hw = proj.halfWidth;
      const eR = boosting ? proj.wallR - A.wallGap : Math.min(hw + A.edgeOut, proj.wallR - A.wallGap);
      const eL = boosting ? proj.wallL - A.wallGap : Math.min(hw + A.edgeOut, proj.wallL - A.wallGap);
      const rx = proj.right.x, rz = proj.right.z;
      for (let side = 1; side >= -1; side -= 2) {
        const dist = side > 0 ? eR - lat : eL + lat;          // kart center -> this edge (< 0: beyond it)
        if (dist >= A.range) continue;
        const w = dist <= 0 ? 1 : 1 - dist / A.range;
        const out = (v.x * rx + v.z * rz) * side;              // > 0: sliding toward this edge
        let dv = A.push * w * w * dt;
        if (out > 0) dv += out * (1 - Math.exp(-A.bleed * w * dt));
        v.x -= rx * dv * side;
        v.z -= rz * dv * side;
        if (!this.drift.active) {
          const head = angleDiff(proj.yaw, this.yaw);         // + = nose left of the road direction
          if (head * side < 0) this.yaw = wrapAngle(this.yaw - head * (1 - Math.exp(-A.rotate * w * dt)));
        } else if (A.driftRotate > 0 && Math.hypot(v.x, v.z) > 3) {
          // drifting: the nose normally leads the path into the turn, so judge
          // the direction of travel, and the nose only beyond driftNoseLead:
          // swing it away when the kart slides toward this edge or is pinned
          // against it nose-first (that would bleed its speed)
          let head = angleDiff(proj.yaw, Math.atan2(v.x, v.z));
          const nose = angleDiff(proj.yaw, this.yaw);
          if (nose * side < 0 && Math.abs(nose) - A.driftNoseLead > Math.abs(head) * (head * side < 0 ? 1 : 0)) head = nose - Math.sign(nose) * A.driftNoseLead;
          if (head * side < 0) this.yaw = wrapAngle(this.yaw - head * (1 - Math.exp(-A.rotate * A.driftRotate * w * dt)));
        }
        if (w > edgeW) { edgeW = w; edgeDir = -side; }
      }
    }

    // ---- steering-wheel correction toward the road window ahead
    let outSteer = u, forced = false;
    const fwd = this.speed;
    if (fwd > 0.5) {
      const hd = angleDiff(proj.yaw, this.yaw);
      if (Math.abs(hd) > A.wrongWay && !this.drift.active) {
        outSteer = hd > 0 ? 1 : -1;                            // nose left of the road -> steer right
        forced = true;
      } else {
        const sA = proj.s + A.lookBase + A.lookGain * fwd;
        const f = tr.frameAt(sA, _aFrame);
        const eR = (boosting ? f.wallR - A.wallGap : Math.min(f.halfWidth, f.wallR - A.wallGap)) - A.inset;
        const eL = (boosting ? f.wallL - A.wallGap : Math.min(f.halfWidth, f.wallL - A.wallGap)) - A.inset;
        tr.pointAt(sA, eR, _aPa);
        tr.pointAt(sA, -eL, _aPb);
        const p = this.position;
        const hs = Math.hypot(v.x, v.z);
        const pd = hs > 3 ? Math.atan2(v.x, v.z) : this.yaw;   // direction of travel
        const dA = angleDiff(pd, Math.atan2(_aPa.x - p.x, _aPa.z - p.z));   // > 0: right end is LEFT of us
        const dB = angleDiff(pd, Math.atan2(_aPb.x - p.x, _aPb.z - p.z));   // < 0: left end is RIGHT of us
        let c = 0;
        if (dA > 0) c = -Math.min(1, dA / A.fullError);      // heading right of the window: steer left
        else if (dB < 0) c = Math.min(1, -dB / A.fullError); // heading left of the window: steer right
        if (c !== 0 && this.drift.active && A.driftLimit > 0) {
          // drifting: the wheel only shapes the arc (x = steer * dir). The
          // correction limits it: heading inside the window caps x (wider arc),
          // heading outside raises it (tighter), up to full counter / full in.
          const d = this.drift, x = u * d.dir, cx = Math.min(1, A.driftLimit * Math.abs(c));
          const xOut = c * d.dir < 0 ? Math.min(x, 1 - 2 * cx) : Math.max(x, 2 * cx - 1);
          outSteer = xOut * d.dir;
        } else if (c !== 0) {
          if (u === 0 || Math.sign(u) === Math.sign(c)) outSteer = Math.sign(c) * Math.max(Math.abs(u), Math.abs(c));
          else outSteer = c + (Math.sign(u) - c) * Math.abs(u);   // full opposite lock always wins
        }
      }
    }

    // ---- antenna: how hard the assist is working right now
    const dSteer = Math.abs(outSteer - u);
    let strength = 0, dir = 0;
    if (edgeW > A.litEdge) { strength = edgeW; dir = edgeDir; }
    if (dSteer > A.litSteer && Math.min(1, dSteer) > strength) { strength = Math.min(1, dSteer); dir = Math.sign(outSteer - u); }
    if (forced) { strength = 1; dir = outSteer; }
    this.assist = strength;
    this.assistDir = dir;
    return outSteer;
  }

  _land(h, vyRoad, driftBtn, steer) {
    const d = this.drift;
    const air = this.airTime;
    this.position.y = h;
    this.velocity.y = vyRoad;
    this.grounded = true;
    this.lastAirTime = air;
    this.airTime = 0;
    if (this.airImmune) { this.airImmune = false; bus.emit('kart:bigJumpLand', { kart: this, airTime: air }); }
    const wasHop = d.hopping;
    d.hopping = false;
    if (air > T.landEventAir) bus.emit('kart:land', { kart: this, airTime: air });
    if (this._trick === 2 && !this.isDisabled()) this.applyBoost(DRIFT.trickBoost, 'trick', DRIFT.boostSpeedMult);
    this._trick = 0;
    if (!d.active && driftBtn && !this.isDisabled()) {
      if (Math.abs(steer) > T.driftDirMin && this.speed >= this.driftStartSpeed) this._startDrift(Math.sign(steer));
      else if (wasHop || air > 0.15) this._landGrace = T.landDriftGrace;
    }
  }

  // Keep the kart between the walls. Removes velocity into the wall, scrubs
  // speed by impact angle, adds a small bounce and steers the nose along the
  // wall so the kart slides instead of sticking.
  _collideWalls(dt, full) {
    const proj = this.proj, p = this.position, v = this.velocity, tr = this.track;
    const r = this.sizeMult > 1 ? T.wallRadius * this.sizeMult : T.wallRadius;   // a giant is wider (v5)
    const lat = proj.lateral;
    const limR = proj.wallR - r, limL = -(proj.wallL - r);
    if (lat <= limR && lat >= limL) return false;
    const side = lat > limR ? 1 : -1;
    const pen = side > 0 ? lat - limR : limL - lat;
    const rxv = proj.right.x, rzv = proj.right.z;
    p.x -= rxv * pen * side;
    p.z -= rzv * pen * side;
    proj.lateral -= pen * side;

    // inward wall normal including the wall's taper along s
    const N = tr.N, i = proj.index;
    const arr = side > 0 ? tr.wr : tr.wl;
    const dW = (arr[(i + 1) % N] - arr[(i - 1 + N) % N]) / (2 * tr.spacing);
    let nx = -side * rxv + proj.tangent.x * dW;
    let nz = -side * rzv + proj.tangent.z * dW;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;

    const vn = v.x * nx + v.z * nz;
    const touching = this.wallContact > 0;          // already in contact last step
    this.wallContact = 0.15;
    if (vn >= 0) return true;
    const impact = -vn;
    let tx = v.x - nx * vn, tz = v.z - nz * vn;      // tangential part
    let bounce = 0;
    if (full && (!touching || impact > T.wallFreshImpact)) {
      // fresh impact: scrub by impact angle + small bounce
      const hs = Math.hypot(v.x, v.z) || 1;
      const scrub = 1 - T.wallScrub * clamp(impact / hs, 0, 1);
      tx *= scrub; tz *= scrub;
      bounce = Math.min(impact * T.wallBounce, T.wallBounceMax);
      // let the kart skate along the wall while its nose swings round
      this._bumpSlide = Math.max(this._bumpSlide, T.wallSlideTime * clamp(impact / 10, 0.3, 1));
      // a real knock ends a drift (genre standard: the charged mini-turbo still
      // fires) so the nose can swing along the wall instead of pirouetting
      if (T.driftWallEnd && this.drift.active && impact > T.wallEventMin) this._endDrift();
    } else if (full) {
      // sustained sliding contact: Coulomb-style friction from the normal push
      const tl = Math.hypot(tx, tz);
      if (tl > 1e-6) {
        const k = Math.max(0, tl - T.wallFriction * impact) / tl;
        tx *= k; tz *= k;
      }
    }
    v.x = tx + nx * bounce;
    v.z = tz + nz * bounce;
    if (!full) return true;

    // ease the nose along the wall when it points into it (keeps easing for a
    // moment after a bounce so the kart doesn't drive straight back in)
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const into = fx * nx + fz * nz;
    if (into < -0.02 && !this.drift.active) {
      // wall tangent closest to the current heading (fall back to track direction)
      let wx = nz, wz = -nx;
      let dot = wx * fx + wz * fz;
      if (Math.abs(dot) < 0.2) dot = wx * proj.tangent.x + wz * proj.tangent.z;
      if (dot < 0) { wx = -wx; wz = -wz; }
      this._wallAlignYaw = Math.atan2(wx, wz);
      this._wallAlignTimer = T.wallAlignTime;
    }
    if (impact > T.wallEventMin && this._wallCooldown <= 0) {
      this._wallCooldown = T.wallCooldown;
      bus.emit('kart:wallHit', { kart: this, intensity: clamp(impact / T.wallEventScale, 0, 1), side, normal: { x: nx, z: nz } });
    }
    return true;
  }

  // Effective mass in kart-kart bumps (SPEC §14.2): heavier with speed, and
  // half again as heavy while boosting.
  bumpMass() {
    const v = clamp(this.horizontalSpeed / (this.stats.topSpeed || 1), 0, 1);
    const m = this.stats.mass * (T.bumpMassLow + (1 - T.bumpMassLow) * v) * (this.boostTimer > 0 ? T.bumpBoostMass : 1);
    return this.sizeMult === 1 ? m : m * this.sizeMult * this.sizeMult;   // v5: a giant shoves, a shrunk kart is light
  }

  // Re-clamp to the walls after an external push (kart collisions).
  constrainToTrack() {
    this.track.project(this.position, this.hint, this.proj);
    this.hint = this.proj.index;
    this._collideWalls(0, false);
  }
}

// ------------------------------------------------------------ collisions

const R2 = KART.radius * 2;
// v5: a full-size kart this fast running into a shrunk one flattens it (§C2)
const RUNOVER_SPEED = 5;

/**
 * Pairwise circle push-apart + bump impulses. Each kart takes the other's
 * share of the push (effective masses, Kart.bumpMass), so heavy, fast or
 * boosting karts shove lighter ones aside. A starred kart tumbles anyone
 * hittable it touches and is never pushed itself. Frozen karts are immovable.
 * v5: radii follow kart.sizeMult (giants / shrunk karts), ghosts (ghostTimer)
 * pass through everyone, and a full-size kart running into a shrunk one
 * squashes it (0.6 x HIT.squashTime, the shrink keeps running).
 */
export function resolveKartCollisions(karts) {
  const n = karts.length;
  for (let i = 0; i < n; i++) {
    const a = karts[i];
    if (a.ghostTimer > 0) continue;
    for (let j = i + 1; j < n; j++) {
      const b = karts[j];
      if (b.ghostTimer > 0) continue;
      const pa = a.position, pb = b.position;
      const sized = a.sizeMult !== 1 || b.sizeMult !== 1;
      const rr = sized ? KART.radius * (a.sizeMult + b.sizeMult) : R2;
      if (Math.abs(pa.y - pb.y) >= (sized ? 1.5 * Math.max(1, a.sizeMult, b.sizeMult) : 1.5)) continue;
      let nx = pb.x - pa.x, nz = pb.z - pa.z;
      const d2 = nx * nx + nz * nz;
      if (d2 >= rr * rr) continue;
      let dist = Math.sqrt(d2);
      if (dist < 1e-4) {
        // perfectly stacked: separate along a deterministic direction
        const ang = i * 2.39996 + j * 1.13;
        nx = Math.cos(ang); nz = Math.sin(ang); dist = 0;
      } else {
        nx /= dist; nz /= dist;
      }
      const pen = rr - dist;
      const starA = a.isInvincible(), starB = b.isInvincible();
      if (sized && a.isShrunk !== b.isShrunk && !starA && !starB) {
        // run over: the full-size one (not a giant: the mortadella plugin flattens on its own) squashes the small one
        const big = a.isShrunk ? b : a, small = a.isShrunk ? a : b;
        if (big.megaTimer <= 0 && big.horizontalSpeed > RUNOVER_SPEED && small.isHittable()) small.squash(HIT.squashTime * 0.6, 'runover', big);
      }

      if (starA !== starB) {
        const star = starA ? a : b, other = starA ? b : a;
        const sg = starA ? 1 : -1;            // normal points star -> other
        if (other.isHittable()) other.tumble('star');
        if (!other.frozen) {
          other.position.x += nx * sg * pen;
          other.position.z += nz * sg * pen;
          const vrel = (other.velocity.x - star.velocity.x) * nx * sg + (other.velocity.z - star.velocity.z) * nz * sg;
          if (vrel < T.starRamKick) {
            const add = T.starRamKick - vrel;
            other.velocity.x += nx * sg * add;
            other.velocity.z += nz * sg * add;
          }
          other._moved = true;
        }
        if (star._bumpCooldown <= 0 || other._bumpCooldown <= 0) {
          star._bumpCooldown = T.bumpCooldown; other._bumpCooldown = T.bumpCooldown;
          bus.emit('kart:bump', { a: star, b: other, intensity: 1 });
        }
        continue;
      }

      const ima = a.frozen ? 0 : 1 / a.bumpMass();
      const imb = b.frozen ? 0 : 1 / b.bumpMass();
      const sum = ima + imb;
      if (sum <= 0) continue;
      pa.x -= nx * pen * (ima / sum); pa.z -= nz * pen * (ima / sum);
      pb.x += nx * pen * (imb / sum); pb.z += nz * pen * (imb / sum);
      if (ima > 0) a._moved = true;
      if (imb > 0) b._moved = true;

      const vrel = (b.velocity.x - a.velocity.x) * nx + (b.velocity.z - a.velocity.z) * nz;
      if (vrel < 0) {
        const kick = T.bumpKick * clamp(-vrel / 3, 0, 1);
        const jn = (-(1 + T.bumpRestitution) * vrel + kick) / sum;
        a.velocity.x -= nx * jn * ima; a.velocity.z -= nz * jn * ima;
        b.velocity.x += nx * jn * imb; b.velocity.z += nz * jn * imb;
        const intensity = clamp(-vrel / T.bumpEventScale, 0, 1);
        if (-vrel > 2) {
          // let the shove carry: lateral grip is reduced briefly (scaled by how hard)
          const slide = T.bumpSlideTime * clamp(-vrel / 8, 0.3, 1);
          if (ima > 0) a._bumpSlide = Math.max(a._bumpSlide, slide * clamp(ima / imb, 0.4, 1));
          if (imb > 0) b._bumpSlide = Math.max(b._bumpSlide, slide * clamp(imb / ima, 0.4, 1));
        }
        if (intensity > 0.1 && a._bumpCooldown <= 0 && b._bumpCooldown <= 0) {
          a._bumpCooldown = T.bumpCooldown; b._bumpCooldown = T.bumpCooldown;
          bus.emit('kart:bump', { a, b, intensity });
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const k = karts[i];
    if (k._moved) { k._moved = false; if (!k.frozen) k.constrainToTrack(); }
  }
}
