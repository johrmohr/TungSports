// Lane, pins and ball as a Rapier rigid-body world. No DOM / Three.js, so the
// same code runs in the browser and in Node tuning tests:
//
//   const lane = new LanePhysics(RAPIER);           // RAPIER already init()ed
//   lane.rack();                                     // ten fresh pins
//   lane.throwBall({ x, angle, speed, spin });       // starts the roll
//   lane.step(dt);                                   // fixed 240 Hz substeps inside
//   lane.result() → { standing: [pin numbers], knocked, gutter, ... }
//
// Units: metres, kilograms, seconds. Axes: x = across the lane (+ = right as
// the bowler faces the pins), y = up, z = toward the bowler. The foul line is
// z = 0 and the head pin stands 60 ft down-lane at z = -18.288.

export const FT = 0.3048;
export const IN = 0.0254;

export const DIM = {
  laneLength: 60 * FT,                 // foul line → head pin
  laneHalfWidth: (41.5 * IN) / 2,      // 39 boards
  boards: 39,
  gutterWidth: 9.25 * IN,
  gutterDepth: 1.9 * IN,
  approachLength: 15 * FT,
  pinSpacing: 12 * IN,
  pinHeight: 15 * IN,
  pinMaxRadius: (4.766 * IN) / 2,
  pinMass: 1.588,                      // 3 lb 8 oz
  ballRadius: 0.10795,                 // 8.5 in
  ballMass: 6.8,                       // 15 lb
  deckBehindHeadPin: 34.1875 * IN,     // head pin centre → pit edge
  pitDepth: 0.35,
  pitLength: 1.1,
  arrowsAt: 15 * FT,                   // the targeting arrows (12–16 ft)
  dotsAt: 7 * FT,
};
DIM.headPinZ = -DIM.laneLength;
DIM.deckEndZ = DIM.headPinZ - DIM.deckBehindHeadPin;
DIM.gutterOuter = DIM.laneHalfWidth + DIM.gutterWidth;   // kickback / capping line
DIM.rowSpacing = DIM.pinSpacing * Math.sin(Math.PI / 3);
DIM.boardWidth = (DIM.laneHalfWidth * 2) / DIM.boards;

// Regulation pin outline as [height above the base, radius] in metres, from
// the USBC Equipment Specifications diameter table (the cap is the 1.273 in
// head arc). Used for the render lathe and the physics convex hull.
export const PIN_PROFILE = [
  [0, 0.0258], [0.0190, 0.0359], [0.0571, 0.0496], [0.0857, 0.0573], [0.1143, 0.0605], [0.1492, 0.0580],
  [0.1841, 0.0470], [0.2191, 0.0314], [0.2381, 0.0250], [0.2540, 0.0228], [0.2762, 0.0237], [0.2984, 0.0266],
  [0.3207, 0.0306], [0.3429, 0.0323], [0.3493, 0.0323], [0.3556, 0.0316], [0.3619, 0.0295], [0.3683, 0.0257],
  [0.3746, 0.0192], [0.3785, 0.0126], [0.3810, 0],
];
const PIN_COM_Y = 0.1468;              // USBC: centre of gravity 5-25/32 in above the base
const PIN_BASE_R = 0.0258;             // flat base: 2.031 in diameter
const PIN_BASE_H = 0.4 * IN;

// Pin spots, numbered 1..10. x across, z along (back rows are further away = more negative z).
export function pinSpot(n) {
  const grid = { 1: [0, 0], 2: [-1, 1], 3: [1, 1], 4: [-2, 2], 5: [0, 2], 6: [2, 2], 7: [-3, 3], 8: [-1, 3], 9: [1, 3], 10: [3, 3] };
  const [hx, row] = grid[n];
  return { x: hx * DIM.pinSpacing / 2, z: DIM.headPinZ - row * DIM.rowSpacing };
}

// Hook model (arcade, tuned against real ball motion): the ball skids through
// the oil on the front ~2/3 of the lane, then the spin bites on the dry
// back end. Lateral acceleration (m/s²) = spin × HOOK_ACCEL × ramp(distance).
export const TUNING = {
  substep: 1 / 240,
  hookAccel: 0.65,
  oilLength: 38 * FT,
  minSpeed: 3.8,          // m/s for speed = 0 (≈ 8.5 mph, the softest swing that throws)
  maxSpeed: 10.2,         // m/s for speed = 1 (≈ 23 mph, a strong full swing; 1.1 ≈ 24 mph)
  ballFriction: 0.08,
  laneFriction: 0.08,
  pinFriction: 0.3,
  pinRestitution: 0.5,      // pin–pin ≈ 0.5
  ballRestitution: 0.84,    // averaged with the pin: ball–pin ≈ 0.67 (USBC)
  settleSpeed: 0.05,      // a pin slower than this (m/s) is at rest
  standTilt: 0.94,        // cos(tilt) above which a pin counts as standing (≈ 20°)
  maxRollTime: 9,         // safety: end the roll this many seconds after release
  afterImpact: 4.5,       // max seconds to let pins fly after first contact
  settleTime: 0.45,       // pins must stay at rest this long before the count
};

export function speedToMps(speed) {
  return TUNING.minSpeed + (TUNING.maxSpeed - TUNING.minSpeed) * speed;
}

export class LanePhysics {
  constructor(RAPIER, opts = {}) {
    this.R = RAPIER;
    this.tuning = { ...TUNING, ...(opts.tuning || {}) };
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.tuning.substep;
    this.world.numSolverIterations = 8;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.pins = [];           // { n, body, collider, standing, spot }
    this.ball = null;
    this.acc = 0;
    this.time = 0;
    this.roll = null;         // current roll state
    this.onPinHit = null;     // (strength, kind) callback for audio: kind 'ball' | 'pin' | 'wall' | 'pit'
    this.colliderKind = new Map();
    this._buildLane();
    this._pinHull = this._makePinHull();
  }

  // ------------------------------------------------------------ static geometry

  _fixed(desc, kind) {
    const c = this.world.createCollider(desc);
    this.colliderKind.set(c.handle, kind);
    return c;
  }

  _buildLane() {
    const R = this.R;
    const t = this.tuning;
    const hw = DIM.laneHalfWidth;
    const laneLen = DIM.laneLength + DIM.deckBehindHeadPin;
    const zMid = (0 + DIM.deckEndZ) / 2;
    const thick = 0.1;
    // Lane bed, foul line → pit edge, as ONE slab: a seam between two colliders
    // throws a rolling ball into the air (internal-edge contact). Pins get their
    // deck grip from a Max friction combine rule instead of a separate deck.
    this._fixed(R.ColliderDesc.cuboid(hw, thick / 2, laneLen / 2).setTranslation(0, -thick / 2, zMid)
      .setFriction(t.laneFriction).setRestitution(0), 'lane');
    // Approach (behind the foul line).
    this._fixed(R.ColliderDesc.cuboid(hw + DIM.gutterWidth, thick / 2, DIM.approachLength / 2).setTranslation(0, -thick / 2, DIM.approachLength / 2)
      .setFriction(0.5), 'approach');
    // Gutters: a floor below the lane surface with a sloped inner lip, running into the pit.
    const gw = DIM.gutterWidth;
    const gd = DIM.gutterDepth;
    for (const side of [-1, 1]) {
      const cx = side * (hw + gw / 2);
      this._fixed(R.ColliderDesc.cuboid(gw / 2, thick / 2, laneLen / 2).setTranslation(cx, -gd - thick / 2, zMid)
        .setFriction(0.3).setRestitution(0.05), 'gutter');
      // Outer gutter wall / lane divider capping (low) …
      this._fixed(R.ColliderDesc.cuboid(0.03, 0.08, laneLen / 2).setTranslation(side * (DIM.gutterOuter + 0.03), 0.08 - gd, zMid)
        .setFriction(0.2).setRestitution(0.2), 'wall');
      // … and the tall kickback plates beside the pin deck.
      const kbLen = 2.2;
      this._fixed(R.ColliderDesc.cuboid(0.03, 0.4, kbLen / 2).setTranslation(side * (DIM.gutterOuter + 0.03), 0.4 - gd, DIM.deckEndZ + kbLen / 2 - 0.3)
        .setFriction(0.15).setRestitution(0.5), 'kickback');
    }
    // Pit: floor below the deck behind the tail plank, back cushion, side walls.
    const pitZ = DIM.deckEndZ - DIM.pitLength / 2;
    this._fixed(R.ColliderDesc.cuboid(DIM.gutterOuter + 0.06, thick / 2, DIM.pitLength / 2).setTranslation(0, -DIM.pitDepth - thick / 2, pitZ)
      .setFriction(0.6).setRestitution(0.05), 'pit');
    this._fixed(R.ColliderDesc.cuboid(DIM.gutterOuter + 0.06, 0.5, 0.05).setTranslation(0, 0.1, DIM.deckEndZ - DIM.pitLength - 0.05)
      .setFriction(0.8).setRestitution(0.02), 'cushion');
    for (const side of [-1, 1]) {
      this._fixed(R.ColliderDesc.cuboid(0.03, 0.5, DIM.pitLength / 2).setTranslation(side * (DIM.gutterOuter + 0.03), 0.1, pitZ)
        .setFriction(0.3).setRestitution(0.1), 'kickback');
    }
  }

  _makePinHull() {
    const pts = [];
    const seg = 12;
    for (const [h, r] of PIN_PROFILE) {
      if (h < PIN_BASE_H * 0.9) continue;             // the base cylinder covers the bottom
      if (r < 0.002) { pts.push(0, h, 0); continue; }
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        pts.push(Math.cos(a) * r, h, Math.sin(a) * r);
      }
    }
    return new Float32Array(pts);
  }

  // ------------------------------------------------------------ pins

  _removeBody(body) {
    if (body) this.world.removeRigidBody(body);
  }

  clearPins() {
    for (const p of this.pins) this._removeBody(p.body);
    this.pins = [];
  }

  _spawnPin(n, x, z, yaw = 0) {
    const R = this.R;
    const t = this.tuning;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(x, 0.0005, z)
        .setRotation(quatYaw(yaw))
        .setLinearDamping(0.05).setAngularDamping(0.25)
        .setCanSleep(true).setCcdEnabled(true),
    );
    // A flat cylinder base gives a stable contact patch on the deck (a convex
    // hull alone jitters and walks over), the hull above it is the real outline.
    const base = R.ColliderDesc.cylinder(PIN_BASE_H / 2, PIN_BASE_R).setTranslation(0, PIN_BASE_H / 2, 0)
      .setFriction(t.pinFriction).setFrictionCombineRule(R.CoefficientCombineRule.Max).setRestitution(t.pinRestitution)
      .setMassProperties(1e-4, { x: 0, y: 0, z: 0 }, { x: 1e-7, y: 1e-7, z: 1e-7 }, { w: 1, x: 0, y: 0, z: 0 });
    const baseCollider = this.world.createCollider(base, body);
    this.colliderKind.set(baseCollider.handle, 'pin');
    const desc = R.ColliderDesc.convexHull(this._pinHull)
      .setFriction(t.pinFriction).setFrictionCombineRule(R.CoefficientCombineRule.Max).setRestitution(t.pinRestitution)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS | R.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(15);
    // Mass properties: regulation weight with the centre of gravity low in the belly.
    const m = DIM.pinMass;
    const ixx = 0.01424;                 // USBC radius of gyration² 13.90 in² (transverse)
    const iyy = 0.0019;                  // about the long axis
    desc.setMassProperties(m, { x: 0, y: PIN_COM_Y, z: 0 }, { x: ixx, y: iyy, z: ixx }, { w: 1, x: 0, y: 0, z: 0 });
    const collider = this.world.createCollider(desc, body);
    this.colliderKind.set(collider.handle, 'pin');
    const pin = { n, body, collider, baseHandle: baseCollider.handle, spot: { x, z }, standing: true, hit: false };
    this.pins.push(pin);
    return pin;
  }

  // Ten fresh pins on their spots.
  rack() {
    this.clearPins();
    for (let n = 1; n <= 10; n++) {
      const s = pinSpot(n);
      this._spawnPin(n, s.x, s.z, (n * 1.7) % (Math.PI * 2));
    }
  }

  // The pinsetter after a first ball: fallen pins are swept away, standing
  // pins are lifted and set back down upright where they stood.
  respot(standingNumbers) {
    const keep = new Set(standingNumbers);
    const old = this.pins;
    this.pins = [];
    for (const p of old) {
      const pos = p.body.translation();
      this._removeBody(p.body);
      if (!keep.has(p.n)) continue;
      // A standing pin that wandered is put back where it stands (like a real pinsetter).
      this._spawnPin(p.n, pos.x, pos.z, (p.n * 1.7) % (Math.PI * 2));
    }
  }

  // ------------------------------------------------------------ ball

  removeBall() {
    if (this.ball) this._removeBody(this.ball);
    this.ball = null;
  }

  // throw: { x (m, release point across the lane), angle (rad, + = toward the
  // right), speed (0..1.4 normalized) | mps, spin (-1..1, + = hooks right→left
  // like a right-hander's hook… we use + = curves toward +x), z (release z) }
  throwBall(th) {
    const R = this.R;
    const t = this.tuning;
    this.removeBall();
    const r = DIM.ballRadius;
    const v = th.mps ?? speedToMps(th.speed ?? 0.6);
    const angle = th.angle || 0;
    const vx = Math.sin(angle) * v;
    const vz = -Math.cos(angle) * v;
    const z0 = th.z ?? -0.25;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(th.x || 0, r + 0.001, z0)
        .setLinvel(vx, 0, vz)
        // Already rolling (no initial skid loss): ω = v / r about the axis across the travel.
        .setAngvel({ x: vz / r, y: 0, z: -vx / r })
        .setLinearDamping(0.0).setAngularDamping(0.02)
        .setCcdEnabled(true).setCanSleep(false),
    );
    const desc = R.ColliderDesc.ball(r).setFriction(t.ballFriction).setRestitution(t.ballRestitution)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS | R.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(30);
    const ir = (2 / 5) * DIM.ballMass * r * r;
    desc.setMassProperties(DIM.ballMass, { x: 0, y: 0, z: 0 }, { x: ir, y: ir, z: ir }, { w: 1, x: 0, y: 0, z: 0 });
    const collider = this.world.createCollider(desc, body);
    this.colliderKind.set(collider.handle, 'ball');
    this.ball = body;
    this.ballCollider = collider;
    this.roll = {
      spin: Math.max(-1, Math.min(1, th.spin || 0)),
      t: 0,
      firstHitAt: null,
      inGutter: false,
      gutterSide: 0,
      done: false,
      releaseSpeed: v,
      maxZ: z0,
      entryAngle: null,
      hitBoard: null,
    };
    for (const p of this.pins) p.hit = false;
    return { mps: v };
  }

  // ------------------------------------------------------------ simulation

  // Advances by dt seconds in fixed substeps. Returns true while the roll is live.
  step(dt) {
    this.acc = Math.min(this.acc + dt, 0.1);
    const h = this.tuning.substep;
    while (this.acc >= h) {
      this._substep(h);
      this.acc -= h;
    }
    return !!this.roll && !this.roll.done;
  }

  _substep(h) {
    const roll = this.roll;
    const ball = this.ball;
    // The roll clock runs even after the ball has dropped out of the world.
    if (roll && !roll.done) roll.t += h;
    if (roll && ball && !roll.done) {
      const p = ball.translation();
      const v = ball.linvel();
      // Gutter: once the ball centre is past the lane edge and below the surface it stays there.
      if (!roll.inGutter && Math.abs(p.x) > DIM.laneHalfWidth + 0.01 && p.y < DIM.ballRadius - 0.01 && p.z > DIM.headPinZ + 0.15) {
        roll.inGutter = true;
        roll.gutterSide = Math.sign(p.x);
      }
      // Hook on the lane (not in the gutter, not after hitting pins).
      const dist = -p.z;
      if (!roll.inGutter && roll.firstHitAt === null && dist > 0 && p.z > DIM.headPinZ - 0.2 && Math.abs(p.x) < DIM.laneHalfWidth) {
        const ramp = hookRamp(dist / this.tuning.oilLength);
        const speed = Math.hypot(v.x, v.z);
        // Scaled by speed so the total break goes as 1/v: slower balls still hook
        // more (more time on the back end) without slow throws diving into the gutter.
        const ax = roll.spin * this.tuning.hookAccel * ramp * (speed / 7.5);
        ball.applyImpulse({ x: ax * DIM.ballMass * h, y: 0, z: 0 }, true);
      }
      // Ball in the gutter is guided straight on (real gutters are concave).
      if (roll.inGutter) {
        const tx = roll.gutterSide * (DIM.laneHalfWidth + DIM.gutterWidth / 2);
        const pull = (tx - p.x) * 30 - v.x * 6;
        ball.applyImpulse({ x: pull * DIM.ballMass * h, y: 0, z: 0 }, true);
      }
      // Entry angle near the head pin, for tuning.
      if (roll.entryAngle === null && p.z < DIM.headPinZ + 0.35) {
        roll.entryAngle = Math.atan2(v.x, -v.z) * 180 / Math.PI;
        roll.hitBoard = p.x;
      }
      // Ball lost into the pit → drop it out of the world once it is well behind the deck.
      if (p.z < DIM.deckEndZ - 0.4 || p.y < -DIM.pitDepth + 0.05) {
        if (!roll.ballInPit) roll.ballInPit = roll.t;
      }
      if (p.y < -1 || p.z < DIM.deckEndZ - DIM.pitLength - 0.5) {
        this.removeBall();
      }
    }
    this.world.step(this.eventQueue);
    this.time += h;
    this._drainEvents();
    if (roll && !roll.done) this._checkDone();
  }

  _drainEvents() {
    const kindOf = (handle) => this.colliderKind.get(handle);
    this.eventQueue.drainContactForceEvents((ev) => {
      const k1 = kindOf(ev.collider1()), k2 = kindOf(ev.collider2());
      const f = ev.totalForceMagnitude();
      const pair = [k1, k2];
      if (pair.includes('pin')) {
        const other = k1 === 'pin' ? k2 : k1;
        const kind = other === 'ball' ? 'ball' : other === 'pin' ? 'pin' : other === 'kickback' || other === 'wall' || other === 'cushion' ? 'wall' : other === 'pit' ? 'pit' : 'floor';
        if (other === 'ball' && this.roll && this.roll.firstHitAt === null) this.roll.firstHitAt = this.roll.t;
        if (this.onPinHit) this.onPinHit(f, kind);
      }
    });
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const k1 = kindOf(h1), k2 = kindOf(h2);
      if ((k1 === 'ball' && k2 === 'pin') || (k2 === 'ball' && k1 === 'pin')) {
        if (this.roll && this.roll.firstHitAt === null) this.roll.firstHitAt = this.roll.t;
        const pinHandle = k1 === 'pin' ? h1 : h2;
        const pin = this.pins.find((p) => p.collider.handle === pinHandle || p.baseHandle === pinHandle);
        if (pin) pin.hit = true;
      }
    });
  }

  // A pin counts as standing when it is upright, on the deck and inside the lane.
  pinStanding(p) {
    const pos = p.body.translation();
    const q = p.body.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);       // y component of the pin's local up axis
    return upY > this.tuning.standTilt && pos.y > -0.03 && pos.y < 0.06 && Math.abs(pos.x) < DIM.laneHalfWidth + 0.02 && pos.z > DIM.deckEndZ - 0.02;
  }

  pinsAtRest() {
    for (const p of this.pins) {
      if (p.body.isSleeping()) continue;
      if (p.body.translation().y < -0.1) continue;   // already in the pit: irrelevant
      const v = p.body.linvel(), w = p.body.angvel();
      if (Math.hypot(v.x, v.y, v.z) > this.tuning.settleSpeed || Math.hypot(w.x, w.y, w.z) > 0.35) return false;
    }
    return true;
  }

  // The roll ends once the pins have stayed at rest for a while (a pin that is
  // still rocking or sliding can fall, and must not be counted as standing).
  _checkDone() {
    const roll = this.roll;
    const t = this.tuning;
    const ball = this.ball;
    const bp = ball ? ball.translation() : null;
    const bv = ball ? ball.linvel() : null;
    const ballPastPins = !ball || bp.z < DIM.deckEndZ || bp.y < -0.2;
    const atRest = this.pinsAtRest();
    if (atRest) { if (roll.restSince === undefined || roll.restSince === null) roll.restSince = roll.t; }
    else roll.restSince = null;
    const restFor = roll.restSince === null || roll.restSince === undefined ? 0 : roll.t - roll.restSince;
    let done = false;
    if (roll.firstHitAt !== null) {
      const since = roll.t - roll.firstHitAt;
      if (since > t.afterImpact && (atRest || since > t.afterImpact + 2)) done = true;   // a rocking pin gets up to 2 s more
      else if (since > 1.4 && (ballPastPins || this._ballIdle(bp, bv)) && restFor > t.settleTime) done = true;
    } else if (ballPastPins) {
      // Missed everything (gutter ball, or rolled past): wait a moment for any wobble.
      if (!roll.passedAt) roll.passedAt = roll.t;
      if (roll.t - roll.passedAt > 0.6 && restFor > t.settleTime) done = true;
      if (roll.t - roll.passedAt > 2.0) done = true;
    } else if (this._ballIdle(bp, bv) && bp.z > DIM.headPinZ + 0.3 && restFor > t.settleTime) {
      done = true;                          // a ball that died on the lane before the pins
    }
    if (roll.t > t.maxRollTime) done = true;
    if (done) roll.done = true;
  }

  _ballIdle(bp, bv) {
    return !!bp && Math.hypot(bv.x, bv.z) < 0.15 && this.roll.t > 1.5;
  }

  // Time to show the pin-cam: the ball is close to the pins.
  ballNearPins() {
    if (!this.ball) return true;
    return this.ball.translation().z < DIM.headPinZ + 4.5;
  }

  // Result of the current roll (call when step() returns false).
  result() {
    const standing = this.pins.filter((p) => this.pinStanding(p)).map((p) => p.n);
    const roll = this.roll || {};
    return {
      standing,
      knocked: this.pins.length - standing.length,
      gutter: !!roll.inGutter && roll.firstHitAt === null,
      hitPins: roll.firstHitAt !== null,
      entryAngle: roll.entryAngle,
      hitBoard: roll.hitBoard,
      time: roll.t,
    };
  }

  // Interpolation-free transforms for rendering.
  snapshot() {
    return {
      ball: this.ball ? { p: this.ball.translation(), q: this.ball.rotation(), v: this.ball.linvel() } : null,
      pins: this.pins.map((p) => ({ n: p.n, p: p.body.translation(), q: p.body.rotation() })),
    };
  }

  dispose() {
    this.world.free();
    this.eventQueue.free();
  }
}

// 0 → 1 ramp of the hook strength along the lane: a little in the oil, full
// on the dry back end, eased so the break point looks like a real hook.
function hookRamp(f) {
  if (f <= 0) return 0.06;
  if (f < 0.55) return 0.06 + 0.10 * (f / 0.55);
  if (f < 1.0) { const u = (f - 0.55) / 0.45; return 0.16 + 0.84 * u * u * (3 - 2 * u); }
  return 1;
}

function quatYaw(a) {
  return { w: Math.cos(a / 2), x: 0, y: Math.sin(a / 2), z: 0 };
}
