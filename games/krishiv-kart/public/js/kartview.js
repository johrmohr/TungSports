// Kart view (browser): renders one Kart with its character model (built from
// the racer + its kart body and wheels, painted in the racer's colors — SPEC
// §14.1), animates it from the physics state every frame (plus the racer's
// signature motion, the Steer Assist antenna and the jump-trick twirl) and
// spawns the kart's particle effects (SPEC §6).
//
//   enableKartShadowLod(renderer);  // once: karts cast their shadow with the low-detail model
//   const view = new KartView(kart, scene, effects);
//   view.update(dt, camera);        // every frame, after the physics substeps
//   view.dispose();
//
// Scene hierarchy (view.object is what goes into the scene):
//   object   kart position; heading + drift slide + spin-out; pitch to the road
//    └ pivot  at mid-kart height (+ ride height on big wheels): tumble flip, lift, wobble
//       └ model  buildKartModel() root (high or low LOD), offset back down
//          ├ body     suspension: roll in turns, squat/dive, hop/land squash
//          │   ├ chassis, driver (leans) → head (looks into turns, bobs)
//          │   ├ exhaust markers (boost flames)
//          │   └ antenna mount → Steer Assist antenna (assisted karts only)
//          └ steer pivots / wheel bones → one InstancedMesh for all 4 wheels
// Wheel spin uses each model's own wheel radii (front and rear differ, and
// Monster Wheels / Mini Rollers change both), so the tread never slides.
//
// Steer Assist (SPEC §14.3a): karts with kart.steerAssist carry a small antenna
// on the tail whose tip glows and bends toward the correction while the assist
// is working (kart.assist / kart.assistDir, smoothed over ~0.15 s).
//
// Particles (all through the shared Effects pools): drift sparks from the rear
// wheels colored by mini-turbo tier (from the kart's drift state / the boost
// event's tier), boost flames from the exhausts (tier
// colored for drift boosts, a comedic green "toot" puff for item boosts),
// grass + dirt on the off-road, smoke on spins, dizzy stars on tumbles,
// rainbow sparkles while starred, wall/bump sparks, landing dust, exhaust
// puffs while revving on the grid. Emission fades out with camera distance.
//
// Items on the kart (SPEC §15.2; state written by items.js): the Beer Rocket
// (kart.beer) — the racer chugs a giant foamy mug, then rides inside a
// mug-shaped rocket lying on its side (foam at the mouth, a nozzle at the
// bottom, a handle on top; the rainbow star tint is skipped, the invincibility
// comes from the star timer) — and Espresso Splash coffee (kart.ink): a brown
// stain on the paint + drips. Orbiting / trailing triples are drawn by items.js.
//
// v5 kart states (SPEC §16.2, kart.js §C2; item meshes are drawn by the item
// plugins themselves): the model scales with kart.sizeMult (giant / shrunk), a
// squashed kart (squashTimer) is drawn flattened, a frozen one (iceTimer) sits in
// a block of ice and cracks out on the thaw, soot (sootTimer) blackens the paint,
// a ghost (ghostTimer) is drawn see-through (cloned materials, the originals are
// untouched), and a big leap (kart:bigJump) is a pirouette over the whole flight.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildKartModel, disposeKartModel } from './characters.js';
import { DRIFT, HIT, KART } from './config.js';
import { bus } from './bus.js';
import { clamp, damp, TAU } from './utils.js';

/**
 * Extra model yaw (rad, steer convention: + turns the model left) a drifting
 * kart gets on top of its physical slip: VIEW_TUNE.driftYaw, but never more
 * than what tops the nose-vs-travel angle up to VIEW_TUNE.driftVisualMax.
 * Shared with tools/drift-probe.mjs (on-screen angle metric).
 */
export function driftSlideTarget(kart) {
  const d = kart.drift;
  if (!d.active) return 0;
  const T = VIEW_TUNE;
  const extra = Math.min(T.driftYaw, Math.max(0, T.driftVisualMax - (kart.driftSlip || 0)));
  return -d.dir * extra;
}

export const VIEW_TUNE = {
  driftYaw: 0.2,            // extra visual yaw while drifting (rad), on top of the physical slip ...
  driftVisualMax: 0.56,     // ... topped up only to this total nose-vs-travel angle (rad, ~32°): a drift never LOOKS turned round
  driftYawRate: 7,
  steerAngle: 0.42,         // max visual front-wheel angle (rad)
  steerRate: 14,
  rollGain: 0.0017,         // body roll per (yawRate * speed)
  rollMax: 0.085,
  accelPitchGain: 0.0032,   // body squat/dive per m/s^2
  accelPitchMax: 0.055,
  airPitchGain: 0.55,       // nose follows the flight path in the air
  airPitchMax: 0.4,
  pivotHeight: 0.55,        // tumble pivot above the ground (m, model space)
  squashK: 170,             // hop/land squash spring stiffness (1/s^2)
  squashC: 9,               // ... damping (1/s)
  wheelDroop: 0.07,         // wheels hang this far down while airborne (m)
  // Level of detail: past ~14 m a kart is < ~8 % of the screen width and the low
  // model looks the same, while 8 high-detail karts (10–19k triangles each, drawn
  // twice with the shadow pass) would push the start grid past the §2 400k budget.
  lodNear: 11,              // switch back to the high-detail model inside this distance
  lodFar: 14,               // switch to the low-detail model beyond this distance
  fxNear: 45,               // full particle emission inside this camera distance
  fxFar: 140,               // no particle emission beyond this distance
  blinkHz: 10,              // invulnerability blink frequency
  trickTime: 0.45,          // jump-trick twirl length (s)
  antennaLength: 0.55,      // Steer Assist antenna (m, model space)
  antennaBend: 0.5,         // max bend toward the correction (rad)
  antennaRate: 7,           // 1/s glow/bend smoothing (~0.15 s)
  // Beer Rocket rig (model space, kart faces +Z)
  beerRadius: 1.25,         // glass mug lying on its side around the kart ...
  beerLength: 3.3,
  beerAxisY: 1.33,          // ... its axis this high (bottom of the glass just above the road)
  beerLift: 0.25,           // the kart floats up onto the beer while riding
  beerGrowTime: 0.28,       // s for the rocket to pop up around the kart (and to vanish)
  inkTint: 0.6,             // coffee stain strength on the paint at full ink
};

const easeOutCubic = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
const easeOutBack = (t) => { const c1 = 1.9, c3 = c1 + 1; const u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; };
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const TIER_COLORS = DRIFT.tierColors.map((c) => new THREE.Color(c));
const WHITE = new THREE.Color(0xffffff);
const FLAME_HOT = new THREE.Color(0xff9a2a);
const TRICK_FLAME = new THREE.Color(0xffe46b);
const ANTENNA_TIP = new THREE.Color(0xffc61a);
const FLAME_END = new THREE.Color(0x7a1200);
const COFFEE = new THREE.Color(0x6b4428);
const ICE_TINT = new THREE.Color(0xbfeeff);
const ICE_GLOW = new THREE.Color(0x2a6a8a);
const SOOT = new THREE.Color(0x2a2626);
const BEER_FLAME = new THREE.Color(0xffd36b);
const BEER_FLAME_END = new THREE.Color(0xff6a00);

// Emission-rate accumulator channels.
const CH = {
  sparkL: 0, sparkR: 1, glowL: 2, glowR: 3, dustL: 4, dustR: 5, flame0: 6, flame1: 7,
  puff: 8, grass: 9, dirt: 10, smoke: 11, star: 12, zap: 13, drip: 14, foam: 15, bubble: 16, nozzle: 17, soot: 18, count: 19,
};

// ---- shadow LOD
// Karts draw their LOW-detail model into the sun's shadow map whatever they show
// on screen: the soft shadow looks the same, and a high-detail kart (10–19k
// triangles) no longer counts twice against the §2 triangle budget. three.js
// renders the shadow pass inside renderer.render(), after it has collected the
// visible objects of the main pass, so swapping the models' visibility around
// shadowMap.render() keeps the high-detail model in the picture.
const shadowLodViews = [];          // KartViews (auto LOD) that take part
let shadowLodMap = null;            // the WebGLShadowMap whose render() is wrapped

/**
 * Turn on the kart shadow LOD for a renderer (once; main.js calls it at boot).
 * @param {THREE.WebGLRenderer} renderer
 */
export function enableKartShadowLod(renderer) {
  const sm = renderer && renderer.shadowMap;
  if (!sm || typeof sm.render !== 'function' || sm === shadowLodMap) return;
  const renderShadows = sm.render;
  sm.render = function renderWithKartShadowLod(lights, scene, camera) {
    const n = shadowLodViews.length;
    for (let i = 0; i < n; i++) shadowLodViews[i]._shadowLod(true);
    try {
      renderShadows.call(this, lights, scene, camera);
    } finally {
      for (let i = 0; i < n; i++) shadowLodViews[i]._shadowLod(false);
    }
  };
  shadowLodMap = sm;
}

// Scratch vectors (module level, reused every frame — no per-frame allocations).
const _cam = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _col = new THREE.Color();
const _col2 = new THREE.Color();

export class KartView {
  /**
   * @param {Kart} kart
   * @param {THREE.Object3D} scene
   * @param {Effects|null} effects
   * @param {{ lod?: 'auto'|'high'|'low' }} [opts]
   */
  constructor(kart, scene, effects = null, opts = {}) {
    this.kart = kart;
    this.scene = scene;
    this.effects = effects;
    this.lodMode = opts.lod || 'auto';

    this.object = new THREE.Group();
    this.object.name = `kartview:${kart.id}`;
    this.object.rotation.order = 'YXZ';
    this.object.userData.kart = kart;
    this.object.userData.view = this;
    this.pivot = new THREE.Group();
    this.pivot.name = 'pivot';
    this.pivotY = VIEW_TUNE.pivotHeight;   // grows with the model's ride height (set by the first model)
    this.pivot.position.y = this.pivotY;
    this.object.add(this.pivot);

    this.models = { high: null, low: null };
    this.model = null;
    this.lod = null;
    this.paint = null;              // the kart's tint material (shared by both LODs)
    this._ownedMaterials = null;
    this._useLod(this.lodMode === 'low' ? 'low' : 'high');
    // auto LOD: the low model also exists up front — it casts the kart's shadow (shadow LOD)
    this._shadowHigh = false;       // model visibilities saved while the low one stands in
    this._shadowLow = false;
    this._foreign = false;          // split-screen: drawn low-detail in another player's view
    this._foreignHigh = false;
    if (this.lodMode === 'auto') {
      this._useLod('low');
      this._useLod('high');
      shadowLodViews.push(this);
    }

    // animation state
    this.time = Math.random() * 10;
    this.slide = 0;
    this.pitch = 0;
    this.roll = 0;
    this.accel = 0;
    this.steer = 0;
    this.lean = 0;
    this.back = 0;
    this.look = 0;
    this.droop = 0;
    this.sq = 0;
    this.sqV = 0;
    this.spinF = 0;
    this.spinR = 0;
    this._lastSpeed = kart.speed;
    this._wasGrounded = kart.grounded;
    this._lastTier = 0;
    this._tinted = false;
    this._fxNear = 1;               // particle emission scale from camera distance (0..1)
    this._dirtSide = 0;             // alternates dust puffs between the rear wheels
    this._acc = new Float32Array(CH.count);

    // trail emitters remember last frame's world positions
    this._exPrev = [new THREE.Vector3(), new THREE.Vector3()];
    this._exNow = [new THREE.Vector3(), new THREE.Vector3()];
    this._whPrev = [new THREE.Vector3(), new THREE.Vector3()];
    this._whNow = [new THREE.Vector3(), new THREE.Vector3()];
    this._trailsValid = false;
    this._boostColor = FLAME_HOT.clone();
    this._boostColor2 = FLAME_END.clone();
    this._pendingFlameBurst = 0;
    this._pendingToot = false;
    this._trickT = 0;               // jump-trick twirl time left
    this.antenna = null;            // Steer Assist antenna (built on demand)
    this._assistGlow = 0;
    this._assistBend = 0;
    this.beerRig = null;            // Beer Rocket chug mug + ride rocket (built on demand)
    this._beerGrow = 0;             // 0..1 rocket size
    this._beerTilt = 0;
    this._tumbleLen = HIT.tumbleDuration;   // length of the running tumble (a Capo slam is longer)
    // v5 kart states (header): eased flatten / ice / ghost amounts, leap pirouette
    this._flat = 0;
    this._ghost = 0;
    this._ghostOn = false;
    this._ghostMats = null;         // Map original material → see-through clone
    this._iceShell = null;          // ice block mesh (built on demand)
    this._mask = null;              // Ladro Mask: a burglar's domino mask on the driver's head (built on demand)
    this._leapT = 0;
    this._leapDur = 0;

    // reusable emit option objects
    this._o = {
      spark: { count: 0, velocity: new THREE.Vector3(), spread: 2, color: new THREE.Color(), size: 0.12, life: 0.3, radius: 0.06, stretch: 0.028, hot: 0.32, from: null },
      glow: { count: 0, velocity: new THREE.Vector3(), spread: 0.5, color: new THREE.Color(), color2: new THREE.Color(), size: 0.34, life: 0.12, radius: 0.07, from: null },
      flame: { count: 0, velocity: new THREE.Vector3(), spread: 0.9, color: new THREE.Color(), color2: new THREE.Color(), size: 0.42, life: 0.2, radius: 0.05, drag: 0, from: null },
      dust: { count: 0, velocity: new THREE.Vector3(), spread: 1.6, color: 0xe2d2ae, size: 0.45, life: 0.7, radius: 0.2, alpha: 0.5, from: null },
      grass: { count: 0, velocity: new THREE.Vector3(), spread: 2.4, radius: 0.18, size: 0.15, from: null },
      puff: { count: 0, velocity: new THREE.Vector3(), spread: 0.5, color: 0xb9bcc4, size: 0.18, life: 0.55, radius: 0.03, alpha: 0.35 },
      smoke: { count: 0, velocity: new THREE.Vector3(), spread: 1.5, size: 0.6, radius: 0.4, alpha: 0.45 },
      sparkle: { count: 0, velocity: new THREE.Vector3(), spread: 1.2, color: 'rainbow', size: 0.22, radius: 0.9, life: 0.6 },
      zap: { count: 0, velocity: new THREE.Vector3(), spread: 3.5, size: 0.3, radius: 0.75, life: 0.24 },
      burst: { count: 0, velocity: new THREE.Vector3(), spread: 4, color: 0xffd36b, size: 0.12, radius: 0.15 },
      foam: { count: 0, velocity: new THREE.Vector3(), spread: 1.4, size: 0.34, radius: 0.55, life: 0.8 },
      bubble: { count: 0, velocity: new THREE.Vector3(), spread: 0.7, size: 0.12, radius: 0.9, life: 0.5 },
      drip: { count: 0, velocity: new THREE.Vector3(), spread: 1.4, size: 0.14, radius: 0.7, life: 0.55 },
      chug: { count: 0, velocity: new THREE.Vector3(), spread: 1.6, size: 0.2, radius: 0.12, life: 0.55 },
    };

    this._offs = [
      bus.on('kart:boost', (e) => { if (e.kart === kart) this._onBoost(e); }),
      bus.on('kart:wallHit', (e) => { if (e.kart === kart) this._onWallHit(e); }),
      bus.on('kart:bump', (e) => { if (e.a === kart) this._onBump(e); }),
      bus.on('kart:land', (e) => { if (e.kart === kart) this._onLand(e); }),
      bus.on('kart:spin', (e) => { if (e.kart === kart) this._onSpin(e); }),
      bus.on('kart:tumble', (e) => { if (e.kart === kart) { this._tumbleLen = 0; this._onTumble(e); } }),
      bus.on('kart:respawn', (e) => { if (e.kart === kart) this._onRespawn(e); }),
      bus.on('kart:starStart', (e) => { if (e.kart === kart) this._onStarStart(e); }),
      bus.on('kart:trick', (e) => { if (e.kart === kart) this._onTrick(e); }),
      bus.on('kart:bigJump', (e) => { if (e.kart === kart) { this._leapDur = Math.max(0.4, (2 * (e.vy || 12)) / KART.gravity); this._leapT = this._leapDur; } }),
      bus.on('kart:thaw', (e) => { if (e.kart === kart) this._onThaw(); }),
      bus.on('kart:squash', (e) => { if (e.kart === kart) this._onSquash(); }),
    ];

    scene.add(this.object);
    this.update(0, null);
  }

  // ------------------------------------------------------------- models

  _buildModel(lod) {
    const m = buildKartModel(this.kart.character, { lod, loadout: this.kart.loadout });
    const ud = m.userData;
    if (!this.paint) {
      // the first model sets the tumble pivot (raised with the ride height on
      // big wheels) and the view takes ownership of its materials (freed in dispose)
      this.pivotY = VIEW_TUNE.pivotHeight + Math.max(0, ud.lift || 0) * (ud.kartScale || 1);
      this.paint = ud.tintMaterials[0];
      this._ownedMaterials = ud.ownedMaterials.slice();
      ud.ownedMaterials = [];
    } else {
      // Share the first model's materials so tinting covers every LOD.
      const map = new Map();
      ud.ownedMaterials.forEach((mat, i) => map.set(mat, this._ownedMaterials[i] || this.paint));
      m.traverse((o) => { if (o.isMesh && map.has(o.material)) o.material = map.get(o.material); });
      for (const mat of ud.ownedMaterials) mat.dispose();
      ud.ownedMaterials = [];
      ud.tintMaterials = [this.paint];
    }
    m.position.y = -this.pivotY;
    ud.rest = {
      headY: ud.head.position.y,
      rl: ud.wheels.rl.position.y,
      rr: ud.wheels.rr.position.y,
      fl: ud.steerPivots.fl.position.y,
      fr: ud.steerPivots.fr.position.y,
    };
    this.pivot.add(m);
    return m;
  }

  _useLod(lod) {
    if (!this.models[lod]) this.models[lod] = this._buildModel(lod);
    for (const key of ['high', 'low']) if (this.models[key]) this.models[key].visible = key === lod;
    this.model = this.models[lod];
    this.lod = lod;
    if (this.antenna) this.model.userData.antennaMount.add(this.antenna);
    if (this._mask) this._fitMask();
  }

  // Steer Assist antenna: a thin rod with a ball tip on the kart's tail (own
  // materials; the tip glows while the assist works). Built the first time the
  // kart has steerAssist on.
  _buildAntenna() {
    const L = VIEW_TUNE.antennaLength;
    const g = new THREE.Group();
    g.name = 'assistAntenna';
    const rodGeo = new THREE.CylinderGeometry(0.012, 0.018, L, 6, 1);
    rodGeo.translate(0, L / 2, 0);
    const rodMat = new THREE.MeshStandardMaterial({ color: 0x2b2d35, roughness: 0.5, metalness: 0.4 });
    const rod = new THREE.Mesh(rodGeo, rodMat);
    rod.name = 'antennaRod';
    const tipMat = new THREE.MeshStandardMaterial({ color: 0xffd84a, emissive: ANTENNA_TIP, emissiveIntensity: 0.15, roughness: 0.35 });
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.065, 12, 8), tipMat);
    tip.name = 'antennaTip';
    tip.position.y = L;
    g.add(rod, tip);
    g.userData = { rod, tip, tipMat, rodMat };
    this.antenna = g;
    this.model.userData.antennaMount.add(g);
  }

  // Root userData of the active model (body, driver, head, wheels, exhausts, ...).
  get parts() { return this.model.userData; }

  // Beer Rocket rig (own geometries + materials, built the first time this kart rides one):
  //   chug: a giant foamy mug held at the racer's mouth (tilts up while chugging)
  //   rocket: a glass mug lying on its side around the kart — foam crown at the
  //   mouth (front), thick bottom + rocket nozzle + fins at the back, handle on top.
  _buildBeerRig() {
    const T = VIEW_TUNE, R = T.beerRadius, L = T.beerLength, H = T.beerAxisY;
    const geos = [], mats = [];
    const G = (g) => { geos.push(g); return g; };
    const M = (m) => { mats.push(m); return m; };
    const glass = M(new THREE.MeshStandardMaterial({ color: 0xffd36a, transparent: true, opacity: 0.3, roughness: 0.06, metalness: 0.05, depthWrite: false, side: THREE.DoubleSide }));
    const beer = M(new THREE.MeshStandardMaterial({ color: 0xf2a516, emissive: 0x7a4300, emissiveIntensity: 0.35, transparent: true, opacity: 0.72, roughness: 0.2, depthWrite: false, side: THREE.DoubleSide }));
    const foam = M(new THREE.MeshStandardMaterial({ color: 0xfffbf0, roughness: 0.85, metalness: 0 }));
    const metal = M(new THREE.MeshStandardMaterial({ color: 0x40444f, roughness: 0.35, metalness: 0.7 }));
    const fin = M(new THREE.MeshStandardMaterial({ color: 0xe8423a, roughness: 0.45, metalness: 0.15 }));
    const glow = M(new THREE.MeshBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    const toZ = (g) => g.rotateX(Math.PI / 2);
    const rocket = new THREE.Group();
    rocket.name = 'beerRocket';
    const shell = new THREE.Mesh(G(toZ(new THREE.CylinderGeometry(R, R, L, 30, 1, true))), glass);
    shell.position.set(0, H, 0);
    // beer pooled in the bottom of the glass (a 140° sheet) and the thick glass bottom
    const pool = new THREE.Mesh(G(toZ(new THREE.CylinderGeometry(R * 0.96, R * 0.96, L * 0.97, 24, 1, true, Math.PI - 1.22, 2.44))), beer);
    pool.position.set(0, H, 0);
    const bottom = new THREE.Mesh(G(toZ(new THREE.CylinderGeometry(R, R * 0.95, 0.32, 30))), M(new THREE.MeshStandardMaterial({ color: 0xffc23a, transparent: true, opacity: 0.55, roughness: 0.1 })));
    bottom.position.set(0, H, -L / 2 - 0.1);
    // foam crown around the mouth + puffs spilling over the top (one merged mesh)
    const crown = new THREE.Group();
    crown.position.set(0, H, L / 2);
    const foamParts = [new THREE.TorusGeometry(R * 0.98, 0.26, 10, 30).toNonIndexed()];
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI * 0.15 + (i / 8) * Math.PI * 1.3;      // over the top half of the mouth
      const sc = 0.75 + ((i * 37) % 10) / 20;
      foamParts.push(new THREE.IcosahedronGeometry(0.42 * sc, 1).translate(Math.cos(a) * R * 0.92, Math.sin(a) * R * 0.92 + 0.05, 0.12 + (i % 3) * 0.08));
    }
    const foamGeo = G(mergeGeometries(foamParts, false));
    for (const g of foamParts) g.dispose();
    const foamCrown = new THREE.Mesh(foamGeo, foam);
    crown.add(foamCrown);
    const mouth = new THREE.Object3D();
    mouth.position.set(0, R * 0.7, 0.3);
    crown.add(mouth);
    // rocket end: nozzle, glow, fins
    const nozzleMesh = new THREE.Mesh(G(toZ(new THREE.CylinderGeometry(0.62, 0.95, 0.75, 20, 1, true))), metal);
    nozzleMesh.position.set(0, H, -L / 2 - 0.62);
    const nozzleGlow = new THREE.Mesh(G(new THREE.CircleGeometry(0.62, 20)), glow);
    nozzleGlow.rotation.y = Math.PI;
    nozzleGlow.position.set(0, H, -L / 2 - 0.98);
    const nozzle = new THREE.Object3D();
    nozzle.position.set(0, H, -L / 2 - 1.15);
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0); finShape.lineTo(0, 1.25); finShape.lineTo(0.85, -0.1); finShape.lineTo(0.55, -0.35); finShape.closePath();
    // a swept triangle in the YZ plane (local Y up = radially outward, +Z toward the nose)
    const finGeo = G(new THREE.ExtrudeGeometry(finShape, { depth: 0.09, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(0.045, -0.15, -0.55));
    const finParts = [];
    const fm = new THREE.Object3D();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + Math.PI / 2;
      fm.position.set(Math.cos(a) * (R - 0.05), H + Math.sin(a) * (R - 0.05), -L / 2 + 0.2);
      fm.rotation.set(0, 0, a - Math.PI / 2, 'ZYX');
      fm.updateMatrix();
      finParts.push(finGeo.clone().applyMatrix4(fm.matrix));
    }
    const fins = new THREE.Mesh(G(mergeGeometries(finParts, false)), fin);
    for (const g of finParts) g.dispose();
    // handle on top (the mug lies on its side)
    const handle = new THREE.Mesh(G(new THREE.TorusGeometry(0.62, 0.15, 8, 18, Math.PI)), glass);
    handle.rotation.y = Math.PI / 2;
    handle.position.set(0, H + R - 0.05, -0.1);
    rocket.add(shell, pool, bottom, crown, nozzleMesh, nozzleGlow, nozzle, handle, fins);
    rocket.visible = false;
    this.object.add(rocket);

    // chug mug (held at the racer's mouth)
    const chug = new THREE.Group();
    chug.name = 'beerChug';
    const mugR = 0.3, mugH = 0.62;
    const mugGlass = new THREE.Mesh(G(new THREE.CylinderGeometry(mugR, mugR * 0.92, mugH, 18, 1, true)), glass);
    const mugBeer = new THREE.Mesh(G(new THREE.CylinderGeometry(mugR * 0.93, mugR * 0.86, mugH * 0.86, 16)), beer);
    mugBeer.position.y = -mugH * 0.05;
    const mugFoam = new THREE.Mesh(G(new THREE.IcosahedronGeometry(mugR * 1.05, 1)), foam);
    mugFoam.scale.set(1, 0.55, 1);
    mugFoam.position.y = mugH / 2 + 0.04;
    const mugHandle = new THREE.Mesh(G(new THREE.TorusGeometry(0.16, 0.05, 6, 14, Math.PI)), glass);
    mugHandle.rotation.z = -Math.PI / 2;
    mugHandle.position.set(mugR + 0.02, 0, 0);
    const mugBase = new THREE.Mesh(G(new THREE.CylinderGeometry(mugR * 0.95, mugR * 0.95, 0.07, 18)), M(new THREE.MeshStandardMaterial({ color: 0xffc23a, transparent: true, opacity: 0.6, roughness: 0.1 })));
    mugBase.position.y = -mugH / 2;
    const inner = new THREE.Group();          // tilt pivot at the rim, held at the racer's mouth ...
    const body = new THREE.Group();           // ... with the mug hanging below it
    body.add(mugGlass, mugBeer, mugFoam, mugHandle, mugBase);
    body.position.y = -mugH / 2;
    inner.add(body);
    chug.add(inner);
    const lip = new THREE.Object3D();
    lip.position.y = 0.05;
    inner.add(lip);
    chug.visible = false;
    this.object.add(chug);

    this.beerRig = { rocket, crown, foamCrown, mouth, nozzle, nozzleGlow, chug, inner, lip, geos, mats };
  }

  _updateBeerRig(dt, beer, ud) {
    const B = this.beerRig, T = VIEW_TUNE, k = this.kart;
    // ---- chug: the mug rises to the mouth and tips up, the head leans back
    const chugging = !!beer && beer.phase === 'chug';
    B.chug.visible = chugging;
    if (chugging) {
      const u = clamp(beer.t / 0.7, 0, 1);
      const rise = easeOutCubic(clamp(u / 0.22, 0, 1));
      const tip = easeInOut(clamp((u - 0.18) / 0.6, 0, 1));
      // the racer's mouth in the kart's frame: just in front of the head
      ud.head.getWorldPosition(_p);
      this.object.worldToLocal(_p);
      B.chug.position.set(_p.x, _p.y + 0.02 - 0.45 * (1 - rise), _p.z + 0.3);
      B.chug.scale.setScalar(Math.max(0.01, (u < 0.9 ? rise : 1 - (u - 0.9) / 0.1) * 1.5));
      B.inner.rotation.x = -0.35 - 1.45 * tip;                  // rim at the mouth, bottom swinging up
      ud.head.rotation.x -= 0.55 * tip;                         // gulp!
      if (this.effects && dt > 0 && tip > 0.15 && this._fxNear > 0) {
        const n = this._count(CH.foam, 34 * this._fxNear, dt);
        if (n > 0) {
          B.lip.getWorldPosition(_p);
          const o = this._o.chug;
          o.count = n;
          o.velocity.set(k.velocity.x * 0.8, -0.6, k.velocity.z * 0.8);
          this.effects.emit('foam', _p, o);
        }
      }
    }
    // ---- ride: the mug-rocket around the kart (grows in, banks into turns, foam crown breathing)
    const g = this._beerGrow;
    B.rocket.visible = g > 0.001;
    if (!B.rocket.visible) return;
    const sc = g >= 1 ? 1 : Math.max(0.01, beer ? easeOutBack(g) : g);
    B.rocket.scale.set(sc, sc, sc);
    this._beerTilt = damp(this._beerTilt, beer ? clamp(-(beer.turn || 0) * 0.08, -0.35, 0.35) : 0, 6, dt);
    B.rocket.rotation.set(0, 0, this._beerTilt);
    B.rocket.position.y = Math.sin(this.time * 7) * 0.05;
    B.foamCrown.scale.set(1 + 0.05 * Math.sin(this.time * 9), 1 + 0.05 * Math.sin(this.time * 9 + 1.3), 1 + 0.12 * Math.sin(this.time * 7));
    B.nozzleGlow.scale.setScalar(0.85 + 0.25 * Math.sin(this.time * 47) + 0.1 * Math.random());
  }

  // ------------------------------------------------------------- events

  _onBoost(e) {
    if (e.source === 'drift') {
      const tier = clamp(e.tier || 1, 1, 3);
      const c = TIER_COLORS[tier] || TIER_COLORS[1];
      this._boostColor.copy(c).lerp(WHITE, 0.3);
      this._boostColor2.copy(c).multiplyScalar(0.25);
      this._pendingFlameBurst = 4 + tier * 3;
    } else if (e.source === 'trick') {
      this._boostColor.copy(TRICK_FLAME);
      this._boostColor2.copy(FLAME_HOT).multiplyScalar(0.4);
      this._pendingFlameBurst = 6;
    } else {
      this._boostColor.copy(FLAME_HOT);
      this._boostColor2.copy(FLAME_END);
      this._pendingFlameBurst = 8;
      if (e.source === 'item') this._pendingToot = true;
    }
  }

  // Jump trick (SPEC §14.3d): a quick twirl in the air + a little star burst.
  _onTrick() {
    this._trickT = VIEW_TUNE.trickTime;
    const fx = this.effects, k = this.kart;
    if (!fx || this._fxNear <= 0) return;
    const o = this._o.sparkle;
    _p.set(k.position.x, k.position.y + 0.9, k.position.z);
    o.count = Math.round(18 * this._fxNear); o.velocity.set(k.velocity.x * 0.7, 2.5, k.velocity.z * 0.7);
    o.color = 0xffe46b; o.radius = 0.7; o.size = 0.26; o.life = 0.5;
    fx.emit('sparkle', _p, o);
  }

  _onWallHit(e) {
    const fx = this.effects, k = this.kart;
    if (!fx || this._fxNear <= 0) return;
    const n = e.normal || { x: 0, z: 0 };
    const o = this._o.burst;
    // contact point on the wall side of the kart
    _p.set(k.position.x - n.x * KART.radius * 0.95, k.position.y + 0.35, k.position.z - n.z * KART.radius * 0.95);
    o.velocity.set(k.velocity.x * 0.45 + n.x * 3, 3.2, k.velocity.z * 0.45 + n.z * 3);
    o.count = Math.round((6 + 22 * (e.intensity || 0.5)) * this._fxNear);
    o.spread = 5; o.color = 0xffd36b; o.size = 0.13;
    fx.emit('spark', _p, o);
    if ((e.intensity || 0) > 0.4) {
      const s = this._o.smoke;
      s.count = 3; s.velocity.set(n.x * 1.5, 0.8, n.z * 1.5); s.size = 0.55; s.color = 0x9a9aa2; s.alpha = 0.4;
      fx.emit('smoke', _p, s);
    }
  }

  _onBump(e) {
    const fx = this.effects;
    if (!fx || this._fxNear <= 0) return;
    const a = e.a.position, b = e.b.position;
    _p.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5 + 0.45, (a.z + b.z) * 0.5);
    const o = this._o.burst;
    o.velocity.set((e.a.velocity.x + e.b.velocity.x) * 0.4, 2.5, (e.a.velocity.z + e.b.velocity.z) * 0.4);
    o.count = Math.round((5 + 16 * (e.intensity || 0.3)) * this._fxNear);
    o.spread = 5; o.color = 0xfff0b8; o.size = 0.12;
    fx.emit('spark', _p, o);
  }

  _onLand(e) {
    const fx = this.effects, k = this.kart;
    if (!fx || this._fxNear <= 0) return;
    const air = clamp(e.airTime || 0, 0, 1.2);
    const o = this._o.dust;
    _p.set(k.position.x, k.position.y + 0.15, k.position.z);
    o.velocity.set(k.velocity.x * 0.35, 0.6, k.velocity.z * 0.35);
    o.count = Math.round((5 + 12 * air) * this._fxNear);
    o.spread = 2.5 + 2 * air; o.size = 0.5; o.radius = 0.85; o.from = null;
    o.color = k.surface === 'offroad' ? 0xb79a6a : 0xe2d2ae;
    fx.emit('dust', _p, o);
    o.radius = 0.2; o.spread = 1.6;
  }

  _onSpin() {
    const fx = this.effects, k = this.kart;
    if (!fx || this._fxNear <= 0) return;
    const s = this._o.smoke;
    _p.set(k.position.x, k.position.y + 0.3, k.position.z);
    s.count = 8; s.velocity.set(k.velocity.x * 0.3, 1.0, k.velocity.z * 0.3); s.size = 0.7; s.color = 0xc8c8ce; s.alpha = 0.45;
    fx.emit('smoke', _p, s);
  }

  _onTumble() {
    const fx = this.effects, k = this.kart;
    if (!fx || this._fxNear <= 0) return;
    const o = this._o.sparkle;
    _p.set(k.position.x, k.position.y + 1.3, k.position.z);
    o.count = 14; o.velocity.set(k.velocity.x * 0.5, 2, k.velocity.z * 0.5); o.color = 0xffe14d; o.radius = 0.6; o.size = 0.3; o.life = 0.9;
    fx.emit('sparkle', _p, o);
    const s = this._o.smoke;
    s.count = 10; s.velocity.set(k.velocity.x * 0.3, 1.2, k.velocity.z * 0.3); s.size = 0.8; s.color = 0xb4b4ba; s.alpha = 0.5;
    _p.y = k.position.y + 0.4;
    fx.emit('smoke', _p, s);
  }

  _onRespawn() {
    this._trailsValid = false;
    const fx = this.effects, k = this.kart;
    if (!fx) return;
    const o = this._o.sparkle;
    _p.set(k.position.x, k.position.y + 0.7, k.position.z);
    o.count = 26; o.velocity.set(0, 1.5, 0); o.color = 0xffffff; o.radius = 1.0; o.size = 0.28; o.life = 0.8;
    fx.emit('sparkle', _p, o);
  }

  _onStarStart() {
    const fx = this.effects, k = this.kart;
    if (!fx) return;
    const o = this._o.sparkle;
    _p.set(k.position.x, k.position.y + 0.7, k.position.z);
    o.count = 40; o.velocity.set(k.velocity.x * 0.6, 2, k.velocity.z * 0.6); o.color = 'rainbow'; o.radius = 1.1; o.size = 0.3; o.life = 0.8;
    fx.emit('sparkle', _p, o);
  }

  // Integer number of particles to emit this frame for a continuous rate.
  // v5 ghost: swap every mesh's material for a see-through clone (cached per
  // original, so shared model materials are never changed), fade by this._ghost.
  _updateGhost(k) {
    const on = this._ghost > 0.02;
    if (on && !this._ghostMats) this._ghostMats = new Map();
    const alpha = 1 - 0.68 * this._ghost + 0.06 * Math.sin(this.time * 9) * this._ghost;
    const clone = (m) => {
      let c = this._ghostMats.get(m);
      if (!c) {
        c = m.clone();
        c.transparent = true;
        c.depthWrite = false;
        if (c.emissive) { c.emissive = c.emissive.clone(); }
        this._ghostMats.set(m, c);
      }
      c.opacity = alpha * (m.transparent ? m.opacity : 1);
      if (c.emissive) c.emissive.setRGB(0.16 * this._ghost, 0.12 * this._ghost, 0.32 * this._ghost);
      return c;
    };
    this.pivot.traverse((o) => {
      if ((!o.isMesh && !o.isInstancedMesh) || o === this._mask) return;
      if (on) {
        if (!o.userData._v5orig) o.userData._v5orig = o.material;
        const src = o.userData._v5orig;
        o.material = Array.isArray(src) ? src.map(clone) : clone(src);
      } else if (o.userData._v5orig) {
        o.material = o.userData._v5orig;
        delete o.userData._v5orig;
      }
    });
    this._ghostOn = on;
  }

  // v5 Ladro Mask: a black domino mask with eye holes, fitted over the front of
  // the driver's head (sized from the head's bounds, so any racer model works).
  _buildMask() {
    const s = new THREE.Shape();
    s.moveTo(-0.42, 0.02); s.quadraticCurveTo(-0.44, 0.17, -0.22, 0.16); s.quadraticCurveTo(0, 0.11, 0.22, 0.16);
    s.quadraticCurveTo(0.44, 0.17, 0.42, 0.02); s.quadraticCurveTo(0.3, -0.13, 0.12, -0.08); s.quadraticCurveTo(0, -0.02, -0.12, -0.08);
    s.quadraticCurveTo(-0.3, -0.13, -0.42, 0.02);
    for (const x of [-0.2, 0.2]) { const h = new THREE.Path(); h.absellipse(x, 0.03, 0.08, 0.055, 0, Math.PI * 2, true); s.holes.push(h); }
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: false, curveSegments: 10 });
    geo.translate(0, 0, -0.025);
    const mat = new THREE.MeshStandardMaterial({ color: 0x15121f, roughness: 0.5, emissive: 0x2a1d66, emissiveIntensity: 0.6, side: THREE.DoubleSide });
    this._mask = new THREE.Mesh(geo, mat);
    this._mask.name = 'ladro-mask';
    this._mask.renderOrder = 3;
    this._fitMask();
  }

  _fitMask() {
    const head = this.model && this.model.userData.head;
    if (!head || !this._mask) return;
    // measure the head in the kart's own frame (root at the origin, unrotated)
    const o = this.object;
    const pos = o.position.clone(), rot = o.rotation.clone(), sc = o.scale.clone();
    const piv = this.pivot.rotation.clone();
    o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1); this.pivot.rotation.set(0, 0, 0);
    o.updateMatrixWorld(true);
    if (this._mask.parent) this._mask.parent.remove(this._mask);
    const box = new THREE.Box3().setFromObject(head);
    if (box.isEmpty()) box.setFromCenterAndSize(head.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0.5, 0.5, 0.5));
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const front = new THREE.Vector3(c.x, c.y + size.y * 0.12, box.max.z + 0.03);
    head.worldToLocal(front);
    const hs = head.getWorldScale(new THREE.Vector3());
    const k = Math.max(0.35, Math.min(1.6, (size.x * 1.02) / 0.84)) / (hs.x || 1);
    this._mask.position.copy(front);
    this._mask.scale.set(k, k, k / 1.5);
    head.add(this._mask);
    o.position.copy(pos); o.rotation.copy(rot); o.scale.copy(sc); this.pivot.rotation.copy(piv);
    o.updateMatrixWorld(true);
  }

  // v5 ice: a translucent block around the kart while frozen, a crack-out on the thaw.
  _updateIce(k) {
    if (!this._iceShell) {
      const g = new THREE.BoxGeometry(2.3, 1.75, 3.2, 1, 1, 1);
      const m = new THREE.MeshStandardMaterial({ color: 0xc8f2ff, transparent: true, opacity: 0.42, roughness: 0.08, metalness: 0.1, emissive: 0x3aa0c8, emissiveIntensity: 0.25, depthWrite: false });
      this._iceShell = new THREE.Mesh(g, m);
      this._iceShell.position.y = 0.85;
      this._iceShell.renderOrder = 2;
      this.object.add(this._iceShell);
    }
    const left = k.iceTimer;
    this._iceShell.visible = left > 0;
    if (left > 0) {
      const dur = k.iceDuration || HIT.iceTime;
      const u = clamp(1 - left / dur, 0, 1);
      const pop = u < 0.12 ? 0.6 + 0.4 * easeOutBack(u / 0.12) : 1;
      this._iceShell.scale.set(pop, pop, pop);
      this._iceShell.rotation.z = left < 0.35 ? Math.sin(this.time * 60) * 0.03 : 0;   // shivers before it cracks
    }
  }

  _onThaw() {
    if (this._iceShell) this._iceShell.visible = false;
    if (!this.effects) return;
    const o = this._o.spark, k = this.kart;
    o.count = 22; o.velocity.set(k.velocity.x * 0.5, 2.5, k.velocity.z * 0.5); o.spread = 6; o.color.set(0xdff8ff);
    o.size = 0.16; o.life = 0.5; o.radius = 1.0; o.stretch = 0.02; o.from = null;
    this._v5p = this._v5p || new THREE.Vector3();
    this._v5p.copy(k.position); this._v5p.y += 0.9;
    this.effects.emit('spark', this._v5p, o);
    o.size = 0.12; o.life = 0.3; o.radius = 0.06; o.stretch = 0.028; o.spread = 2;
  }

  _onSquash() {
    if (!this.effects) return;
    const o = this._o.dust, k = this.kart;
    o.count = 16; o.velocity.set(0, 0.6, 0); o.spread = 5; o.size = 0.7; o.life = 0.7; o.radius = 1.2; o.from = null;
    this.effects.emit('dust', k.position, o);
    o.spread = 1.6; o.size = 0.45; o.radius = 0.2;
    this.sqV -= 3;
  }

  _count(ch, rate, dt) {
    const a = this._acc[ch] + rate * dt;
    const n = Math.floor(a);
    this._acc[ch] = a - n;
    return n;
  }

  // ------------------------------------------------------------- frame update

  update(dt, camera) {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    const k = this.kart, T = VIEW_TUNE, d = k.drift, v = k.velocity;
    this.time += dt;
    const speed = k.speed;
    const grounded = k.grounded;
    const disabled = k.isDisabled();

    // ---- camera distance: level of detail + particle budget
    let camDist = 0;
    if (camera) {
      camera.getWorldPosition(_cam);
      camDist = _cam.distanceTo(k.position);
      if (this.lodMode === 'auto') {
        const want = this.lod === 'high' ? (camDist > T.lodFar ? 'low' : 'high') : (camDist < T.lodNear ? 'high' : 'low');
        if (want !== this.lod) this._useLod(want);
      }
    }
    this._fxNear = camera ? clamp(1 - (camDist - T.fxNear) / (T.fxFar - T.fxNear), 0, 1) : 1;
    const ud = this.model.userData, rest = ud.rest;

    // ---- root: position, heading + drift slide + spin-out, pitch to the road
    const o = this.object;
    o.position.copy(k.position);
    this.slide = damp(this.slide, driftSlideTarget(k), T.driftYawRate, dt);
    let spin = 0;
    if (k.spinTimer > 0) {
      const dur = k.spinDuration || HIT.spinDuration;
      spin = 2 * TAU * easeOutCubic(clamp(1 - k.spinTimer / dur, 0, 1));   // two full turns
    }
    const fx = Math.sin(k.yaw), fz = Math.cos(k.yaw);
    const hs = Math.hypot(v.x, v.z);
    let wantPitch;
    if (grounded) {
      const t = k.proj && k.proj.tangent;
      const tdot = t ? fx * t.x + fz * t.z : 1;
      wantPitch = -Math.atan((k.roadSlope || 0) * tdot);
    } else {
      wantPitch = -clamp(Math.atan2(v.y, Math.max(hs, 4)) * T.airPitchGain, -T.airPitchMax, T.airPitchMax);
    }
    this.pitch = damp(this.pitch, wantPitch, grounded ? 16 : 5, dt);
    o.rotation.set(this.pitch, k.yaw + this.slide + spin, 0);
    // v5: giant / shrunk size, squashed flat
    this._flat = damp(this._flat, k.squashTimer > 0 ? 1 : 0, k.squashTimer > 0 ? 22 : 6, dt);
    const size = k.sizeMult || 1, fl = this._flat;
    o.scale.set(size * (1 + 0.35 * fl), size * (1 - 0.68 * fl), size * (1 + 0.35 * fl));

    // ---- tumble: one forward flip around the kart's middle, then a wobble
    let flip = 0, lift = 0, wobble = 0;
    if (k.tumbleTimer > 0) {
      if (k.tumbleTimer > this._tumbleLen) this._tumbleLen = k.tumbleTimer;
      const p = clamp(1 - k.tumbleTimer / Math.max(HIT.tumbleDuration, this._tumbleLen), 0, 1);
      const fp = clamp(p / 0.6, 0, 1);
      flip = TAU * easeInOut(fp);
      lift = Math.sin(fp * Math.PI) * 0.75;
      if (fp >= 1) wobble = Math.sin((p - 0.6) * 32) * 0.14 * (1 - p) / 0.4;
    }
    // jump trick: one quick twirl around the vertical axis
    let twirl = 0;
    if (this._trickT > 0) {
      this._trickT = Math.max(0, this._trickT - dt);
      twirl = TAU * easeOutCubic(1 - this._trickT / T.trickTime);
      if (this._trickT === 0) twirl = 0;
    }
    // big leap (Tarantella Jump): one pirouette over the flight
    if (this._leapT > 0) {
      this._leapT = Math.max(0, this._leapT - dt);
      twirl += TAU * easeInOut(1 - this._leapT / this._leapDur);
      if (this._leapT === 0 || k.grounded) { this._leapT = 0; }
    }
    this.pivot.rotation.set(flip, twirl, wobble);
    // Beer Rocket: the rocket pops up around the kart, which floats up onto the beer
    const beer = k.beer;
    const growTo = beer && beer.phase === 'ride' ? 1 : 0;
    this._beerGrow = growTo > this._beerGrow ? Math.min(1, this._beerGrow + dt / T.beerGrowTime) : Math.max(0, this._beerGrow - dt / T.beerGrowTime);
    this.pivot.position.y = this.pivotY + lift + T.beerLift * Math.min(1, this._beerGrow * 1.5);

    // ---- body suspension: squat/dive, roll, hop/land squash, road rumble
    if (dt > 0) this.accel = damp(this.accel, clamp((speed - this._lastSpeed) / dt, -60, 60), 8, dt);
    this._lastSpeed = speed;
    const bodyPitch = clamp(-this.accel * T.accelPitchGain, -T.accelPitchMax, T.accelPitchMax);
    const wantRoll = grounded && !disabled ? clamp(k.yawRate * speed * T.rollGain, -T.rollMax, T.rollMax) : 0;
    this.roll = damp(this.roll, wantRoll, 8, dt);
    if (this._wasGrounded && !grounded && v.y > 1) this.sqV += d.hopping ? 2.4 : 1.2;
    if (!this._wasGrounded && grounded) this.sqV -= 1.2 + 2.6 * clamp(k.lastAirTime || 0, 0, 1);
    this._wasGrounded = grounded;
    for (let rem = dt; rem > 1e-6; rem -= 1 / 120) {
      const h = Math.min(rem, 1 / 120);
      this.sqV += (-T.squashK * this.sq - T.squashC * this.sqV) * h;
      this.sq += this.sqV * h;
    }
    this.sq = clamp(this.sq, -0.28, 0.28);
    let rumble = 0;
    if (grounded) {
      const sf = clamp(Math.abs(speed) / 20, 0, 1);
      if (k.surface === 'offroad') rumble = (Math.sin(this.time * 47) + Math.sin(this.time * 31.7)) * 0.011 * sf;
      else if (k.surface === 'curb') rumble = Math.sin(this.time * 70) * 0.014 * sf;
      else if (k.frozen && k.input.throttle > 0) rumble = Math.sin(this.time * 63) * 0.012;   // revving
      else rumble = Math.sin(this.time * 55) * 0.0035 * (k.input.throttle > 0 ? 1 : 0.4);
    }
    const body = ud.body;
    body.position.y = rumble;
    body.rotation.set(bodyPitch, 0, this.roll);
    body.scale.set(1 - this.sq * 0.5, 1 + this.sq, 1 - this.sq * 0.5);

    // ---- wheels: roll with speed, steer (counter-steer while drifting), droop in the air
    const scale = ud.kartScale || 1;
    const rr = ud.wheelRadius.rear * scale, rf = ud.wheelRadius.front * scale;
    this.spinR = (this.spinR + (speed / rr) * dt) % TAU;
    this.spinF = (this.spinF + (speed / rf) * dt) % TAU;
    ud.wheels.rl.rotation.x = ud.wheels.rr.rotation.x = this.spinR;
    ud.wheels.fl.rotation.x = ud.wheels.fr.rotation.x = this.spinF;
    let wantSteer;
    if (d.active && hs > 3) {
      // front wheels point along the direction of travel (relative to the model)
      const vF = v.x * fx + v.z * fz, vR = -v.x * fz + v.z * fx;
      const travel = Math.atan2(-vR, Math.max(1, vF)) - this.slide;
      wantSteer = clamp(travel - k.steerVisual * 0.12, -0.6, 0.6);
    } else {
      wantSteer = -k.steerVisual * T.steerAngle;
    }
    this.steer = damp(this.steer, wantSteer, T.steerRate, dt);
    ud.steerPivots.fl.rotation.y = ud.steerPivots.fr.rotation.y = this.steer;
    this.droop = damp(this.droop, grounded ? 0 : 1, grounded ? 22 : 6, dt);
    const dy = -T.wheelDroop * this.droop;
    ud.wheels.rl.position.y = rest.rl + dy;
    ud.wheels.rr.position.y = rest.rr + dy;
    ud.steerPivots.fl.position.y = rest.fl + dy;
    ud.steerPivots.fr.position.y = rest.fr + dy;
    ud.syncWheels();

    // ---- driver: lean into turns, lean back on boosts, look into the corner, bob
    const wantLean = clamp(k.steerVisual * 0.14 + (d.active ? d.dir * 0.08 : 0), -0.22, 0.22) * (grounded || d.hopping ? 1 : 0.5);
    this.lean = damp(this.lean, disabled ? 0 : wantLean, 8, dt);
    this.back = damp(this.back, (k.boostTimer > 0 ? -0.13 : 0) + clamp(-this.accel * 0.003, -0.06, 0.06), 6, dt);
    ud.driver.rotation.set(this.back, 0, this.lean);
    const wantLook = clamp(-k.steerVisual * 0.32 - (d.active ? d.dir * 0.22 : 0), -0.5, 0.5);
    this.look = damp(this.look, disabled ? 0 : wantLook, 6, dt);
    const sp01 = clamp(Math.abs(speed) / 25, 0, 1);
    const bob = Math.sin(this.time * (5 + Math.abs(speed) * 0.35)) * 0.011 * (0.4 + sp01) - this.sq * 0.06;
    let headYaw = this.look, headRoll = Math.sin(this.time * 2.1) * 0.035;
    if (disabled) {                                                   // dizzy
      headYaw += Math.sin(this.time * 11) * 0.35;
      headRoll += Math.sin(this.time * 15) * 0.28;
    }
    ud.head.position.y = rest.headY + bob;
    ud.head.rotation.set(Math.sin(this.time * 1.7) * 0.03, headYaw, headRoll);
    if (ud.animate) ud.animate(this.time, k);                          // the racer's signature motion

    // ---- Steer Assist antenna: tip glows and bends toward the correction
    if (k.steerAssist && !this.antenna) this._buildAntenna();
    if (this.antenna) {
      const a = this.antenna, au = a.userData;
      a.visible = !!k.steerAssist;
      const on = k.steerAssist ? clamp(k.assist || 0, 0, 1) : 0;
      this._assistGlow = damp(this._assistGlow, on, T.antennaRate, dt);
      this._assistBend = damp(this._assistBend, on * (k.assistDir || 0), T.antennaRate, dt);
      const sp = clamp(Math.abs(speed) / 25, 0, 1);
      a.rotation.set(-0.12 - 0.25 * sp + Math.sin(this.time * 9) * 0.02 * sp, 0, this._assistBend * T.antennaBend);
      au.tipMat.emissiveIntensity = 0.15 + 2.2 * this._assistGlow;
      au.tip.scale.setScalar(1 + 0.35 * this._assistGlow);
    }

    // ---- star: rainbow hue cycling (flickers off during the last second);
    // a Beer Rocket rider is invincible through the star timer but shows the mug instead
    const paint = this.paint;
    if (k.starTimer > 0 && !beer) {
      const ending = k.starTimer < 1.2 && Math.floor(this.time * 12) % 2 === 0;
      if (ending) {
        paint.color.set(0xffffff);
        paint.emissive.set(0x000000);
      } else {
        const hue = (this.time * 2.2) % 1;
        paint.color.setHSL(hue, 0.9, 0.72);
        paint.emissive.setHSL((hue + 0.5) % 1, 1, 0.5).multiplyScalar(0.28);
      }
      this._tinted = true;
    } else if (k.iceTimer > 0) {
      // frozen solid: icy paint
      paint.color.copy(ICE_TINT);
      paint.emissive.copy(ICE_GLOW);
      this._tinted = true;
    } else if (k.ink > 0) {
      // Espresso Splash: coffee-stained paint
      paint.color.set(0xffffff).lerp(COFFEE, T.inkTint * clamp(k.ink, 0, 1));
      paint.emissive.set(0x000000);
      this._tinted = true;
    } else if (k.sootTimer > 0) {
      // Befana's soot: blackened paint
      paint.color.set(0xffffff).lerp(SOOT, 0.75);
      paint.emissive.set(0x000000);
      this._tinted = true;
    } else if (this._tinted) {
      paint.color.set(0xffffff);
      paint.emissive.set(0x000000);
      this._tinted = false;
    }

    // ---- v5: ghost (see-through clones of the materials) + the ice block
    this._ghost = damp(this._ghost, k.ghostTimer > 0 ? 1 : 0, 10, dt);
    if (this._ghost > 0.02 || this._ghostOn) this._updateGhost(k);
    if (k.ghostTimer > 0 && !this._mask) this._buildMask();
    if (this._mask) this._mask.visible = k.ghostTimer > 0;
    if (k.iceTimer > 0 || (this._iceShell && this._iceShell.visible)) this._updateIce(k);

    // ---- invulnerability blink (~10 Hz)
    const blink = k.invulnTimer > 0 && !disabled && k.starTimer <= 0;
    this.model.visible = !blink || (this.time * T.blinkHz) % 1 < 0.55;

    // ---- Beer Rocket rig (chug mug at the racer's mouth, the mug-rocket around the kart)
    if ((beer || this._beerGrow > 0) && !this.beerRig) this._buildBeerRig();
    if (this.beerRig) this._updateBeerRig(dt, beer, ud);

    // ---- particles
    o.updateMatrixWorld(true);
    if (this.effects && dt > 0 && this._fxNear > 0) this._emitEffects(dt, ud);
    else this._trailsValid = false;
    if (d.active) this._lastTier = d.tier; else this._lastTier = 0;
  }

  _emitEffects(dt, ud) {
    const fxs = this.effects, k = this.kart, d = k.drift, v = k.velocity, O = this._o;
    const near = this._fxNear;
    const grounded = k.grounded;
    const yaw = k.yaw + this.slide;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);         // visual forward
    const lx = fz, lz = -fx;                                // visual LEFT (+X in model space)
    const scale = ud.kartScale || 1;
    const rr = ud.wheelRadius.rear * scale;

    // world positions of the rear-wheel contact patches and exhaust tips
    const wn = this._whNow, wp = this._whPrev, en = this._exNow, ep = this._exPrev;
    wn[0].setFromMatrixPosition(ud.wheels.rl.matrixWorld); wn[0].y -= rr * 0.85;
    wn[1].setFromMatrixPosition(ud.wheels.rr.matrixWorld); wn[1].y -= rr * 0.85;
    const ex = ud.exhausts;
    en[0].setFromMatrixPosition(ex[0].matrixWorld);
    en[1].setFromMatrixPosition(ex[ex.length > 1 ? 1 : 0].matrixWorld);
    if (!this._trailsValid || wn[0].distanceToSquared(wp[0]) > 9) {
      for (let i = 0; i < 2; i++) { wp[i].copy(wn[i]); ep[i].copy(en[i]); }
    }

    // ---- drift sparks (rear wheels, tier colored; tier 0 = small white bits)
    if (d.active && grounded && !k.isDisabled()) {
      const tier = d.tier;
      if (tier > this._lastTier && tier > 0) {
        // tier-up pop
        const o = O.burst;
        o.color = TIER_COLORS[tier]; o.count = Math.round(14 * near); o.spread = 6; o.size = 0.14;
        for (let i = 0; i < 2; i++) {
          o.velocity.set(v.x * 0.7, 3, v.z * 0.7);
          fxs.emit('spark', wn[i], o);
        }
        const s = O.sparkle;
        s.color = TIER_COLORS[tier]; s.count = Math.round(8 * near); s.radius = 0.5; s.size = 0.3; s.life = 0.45;
        s.velocity.set(v.x * 0.8, 1.5, v.z * 0.8);
        fxs.emit('sparkle', wn[d.dir > 0 ? 0 : 1], s);
      }
      const o = O.spark;
      const g = O.glow;
      const rate = tier === 0 ? 24 : 55 + 20 * tier;
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? 1 : -1;                     // +1 = left wheel
        const n = this._count(i === 0 ? CH.sparkL : CH.sparkR, rate * near, dt);
        if (n > 0) {
          // short hot streaks spraying up/out/back, staying close to the wheel
          o.count = n;
          o.from = wp[i];
          o.velocity.set(v.x * 0.87 - fx * 1.6 + lx * side * 1.6, 2.4, v.z * 0.87 - fz * 1.6 + lz * side * 1.6);
          if (tier === 0) { o.color.set(0xfff8e8); o.size = 0.07; o.life = 0.16; o.spread = 2.2; }
          else { o.color.copy(TIER_COLORS[tier]); o.size = 0.09 + 0.012 * tier; o.life = 0.2 + 0.025 * tier; o.spread = 3.2; }
          fxs.emit('spark', wn[i], o);
        }
        if (tier > 0) {
          // flickering tier-colored plume at the back of the tire (lifted off
          // the road so the camera-facing sprite isn't half buried in it)
          const ng = this._count(i === 0 ? CH.glowL : CH.glowR, 70 * near, dt);
          if (ng > 0) {
            g.count = ng;
            _p.set(wn[i].x - fx * 0.42, wn[i].y + 0.16, wn[i].z - fz * 0.42);
            _q.set(wp[i].x - fx * 0.42, wp[i].y + 0.16, wp[i].z - fz * 0.42);
            g.from = _q;
            g.color.copy(TIER_COLORS[tier]);
            g.color2.copy(TIER_COLORS[tier]).multiplyScalar(0.75);
            g.size = 0.44 + 0.07 * tier;
            g.velocity.set(v.x * 0.97 - fx * 0.6, 0.5, v.z * 0.97 - fz * 0.6);
            fxs.emit('glow', _p, g);
          }
        } else {
          const nd = this._count(i === 0 ? CH.dustL : CH.dustR, 10 * near, dt);
          if (nd > 0) {
            const u = O.dust;
            u.count = nd; u.from = wp[i]; u.color = 0xe9e3d6; u.size = 0.3; u.alpha = 0.35; u.spread = 1;
            u.velocity.set(v.x * 0.6, 0.4, v.z * 0.6);
            fxs.emit('dust', wn[i], u);
            u.from = null; u.alpha = 0.5; u.spread = 1.6;
          }
        }
      }
    }

    // ---- boost flames from the exhausts
    if (this._pendingToot) {
      // comedic "toot": a green puff cloud out of the pipes
      this._pendingToot = false;
      // (inherits most of the kart's velocity so the cloud hangs behind the kart
      // in front of the chase camera for a moment instead of vanishing)
      const s = O.smoke;
      s.count = Math.round(14 * near); s.color = 0xa8e05a; s.size = 0.7; s.alpha = 0.6; s.spread = 2.2;
      s.velocity.set(v.x * 0.82 - fx * 2, 1.0, v.z * 0.82 - fz * 2);
      _p.copy(en[0]).add(en[1]).multiplyScalar(0.5);
      fxs.emit('stink', _p, s);
    }
    if (k.boostTimer > 0) {
      const f = O.flame;
      f.color.copy(this._boostColor);
      f.color2.copy(this._boostColor2);
      const burst = this._pendingFlameBurst;
      this._pendingFlameBurst = 0;
      for (let i = 0; i < 2; i++) {
        // drag-free and fully inherited: the flame jets stay attached to the pipes
        const n = this._count(i === 0 ? CH.flame0 : CH.flame1, 75 * near, dt) + Math.round(burst * near);
        if (n <= 0) continue;
        f.count = n;
        f.from = ep[i];
        f.size = burst > 0 ? 0.58 : 0.46;
        f.life = burst > 0 ? 0.24 : 0.19;
        f.velocity.set(v.x - fx * 7.5, v.y * 0.5 + 0.35, v.z - fz * 7.5);
        fxs.emit('flame', en[i], f);
      }
    } else {
      this._pendingFlameBurst = 0;
      // exhaust puffs: revving on the grid / pulling away slowly
      const thr = k.input.throttle || 0;
      const slow = Math.abs(k.speed) < 12;
      if (thr > 0.1 && (k.frozen || (slow && grounded))) {
        const n = this._count(CH.puff, (k.frozen ? 16 : 9) * near * thr, dt);
        if (n > 0) {
          const pf = O.puff;
          pf.count = 1;
          pf.color = k.frozen ? 0x9a9da6 : 0xc4c7ce;
          for (let j = 0; j < n; j++) {
            const e = en[j % 2];
            pf.velocity.set(v.x * 0.5 - fx * 1.4, 0.9, v.z * 0.5 - fz * 1.4);
            fxs.emit('smoke', e, pf);
          }
        }
      }
    }

    // ---- off-road: grass clippings + dirt from the rear wheels
    if (grounded && k.surface === 'offroad' && Math.abs(k.speed) > 3) {
      const sp = Math.abs(k.speed);
      const n = this._count(CH.grass, sp * 3.2 * near, dt);
      if (n > 0) {
        // clippings + dirt clods kicked up and back from both rear wheels
        const gr = O.grass;
        for (let i = 0; i < 2; i++) {
          gr.count = i === 0 ? Math.ceil(n / 2) : Math.floor(n / 2);
          if (!gr.count) continue;
          gr.from = wp[i];
          const side = i === 0 ? 1 : -1;
          gr.velocity.set(v.x * 0.45 - fx * 2.5 + lx * side * 1.2, 3.6, v.z * 0.45 - fz * 2.5 + lz * side * 1.2);
          fxs.emit('grass', wn[i], gr);
        }
      }
      const nd = this._count(CH.dirt, (4 + sp * 1.3) * near, dt);
      for (let j = 0; j < nd; j++) {
        // tan dust clouds rolling off the tires
        const u = O.dust;
        const w = (this._dirtSide = 1 - (this._dirtSide || 0));
        u.count = 1; u.from = wp[w]; u.color = 0xc9a86f; u.size = 0.62; u.alpha = 0.6; u.spread = 1.3;
        u.velocity.set(v.x * 0.4, 0.9, v.z * 0.4);
        fxs.emit('dust', wn[w], u);
        u.from = null; u.alpha = 0.5; u.spread = 1.6;
      }
    }

    // ---- spin-out tire smoke
    if (k.spinTimer > 0 && grounded) {
      const n = this._count(CH.smoke, 26 * near, dt);
      if (n > 0) {
        const s = O.smoke;
        s.count = n; s.color = 0xd0d0d6; s.size = 0.55; s.alpha = 0.4; s.spread = 1.2;
        s.velocity.set(v.x * 0.25, 0.9, v.z * 0.25);
        _p.copy(wn[0]).add(wn[1]).multiplyScalar(0.5);
        fxs.emit('smoke', _p, s);
      }
    }

    // ---- v5 soot (Befana): dark smudgy puffs trail off the sooted kart
    if (k.sootTimer > 0) {
      const n = this._count(CH.soot, 16 * near, dt);
      if (n > 0) {
        const s = O.smoke;
        s.count = n; s.color = 0x2b2626; s.size = 0.5; s.alpha = 0.55; s.spread = 0.8;
        s.velocity.set(v.x * 0.3, 1.2, v.z * 0.3);
        _p.copy(k.position); _p.y += 0.9;
        fxs.emit('smoke', _p, s);
      }
    }

    // ---- Beer Rocket: nozzle flame, foam spilling from the mouth, bubbles inside the glass
    if (this.beerRig && this._beerGrow > 0.3) {
      const B = this.beerRig, g = this._beerGrow;
      const nz = this._count(CH.nozzle, 90 * near * g, dt);
      if (nz > 0) {
        const f = O.flame;
        B.nozzle.getWorldPosition(_p);
        f.count = nz; f.from = null; f.size = 0.72; f.life = 0.2;
        f.color.copy(BEER_FLAME); f.color2.copy(BEER_FLAME_END);
        f.velocity.set(v.x - fx * 14, v.y * 0.5, v.z - fz * 14);
        fxs.emit('flame', _p, f);
      }
      const nf = this._count(CH.foam, 26 * near * g, dt);
      if (nf > 0) {
        B.mouth.getWorldPosition(_p);
        const fo = O.foam;
        fo.count = nf;
        fo.velocity.set(v.x * 0.55, 1.6, v.z * 0.55);
        fxs.emit('foam', _p, fo);
      }
      const nb = this._count(CH.bubble, 40 * near * g, dt);
      if (nb > 0) {
        _p.set(k.position.x, k.position.y + 0.6, k.position.z);
        const bu = O.bubble;
        bu.count = nb;
        bu.velocity.set(v.x * 0.97, 1.2, v.z * 0.97);
        fxs.emit('bubble', _p, bu);
      }
    }

    // ---- Golden Toot window: gold glitter streaming from the pipes
    if (k.goldenTimer > 0) {
      const n = this._count(CH.star, 32 * near, dt);
      if (n > 0) {
        const s = O.sparkle;
        s.count = n; s.color = 0xffd84a; s.radius = 0.3; s.size = 0.26; s.life = 0.55;
        s.velocity.set(v.x * 0.6 - fx * 2, 0.9, v.z * 0.6 - fz * 2);
        _p.copy(en[0]).add(en[1]).multiplyScalar(0.5);
        fxs.emit('glitter', _p, s);
      }
    }

    // ---- espresso: coffee dripping off the kart
    if (k.ink > 0.05) {
      const n = this._count(CH.drip, 16 * k.ink * near, dt);
      if (n > 0) {
        const c = O.drip;
        c.count = n;
        c.velocity.set(v.x * 0.85, 0.5, v.z * 0.85);
        _p.set(k.position.x, k.position.y + 1.05, k.position.z);
        fxs.emit('coffee', _p, c);
      }
    }

    // ---- star: rainbow sparkles trailing the kart
    if (k.starTimer > 0 && !k.beer) {
      const n = this._count(CH.star, 70 * near, dt);
      if (n > 0) {
        const s = O.sparkle;
        s.count = n; s.color = 'rainbow'; s.radius = 1.0; s.size = 0.3; s.life = 0.6;
        s.velocity.set(v.x * 0.55, 0.8, v.z * 0.55);
        _p.set(k.position.x, k.position.y + 0.65, k.position.z);
        fxs.emit('sparkle', _p, s);
      }
    }

    // ---- zapped: electric crackle
    if (k.slowTimer > 0) {
      const n = this._count(CH.zap, 26 * near, dt);
      if (n > 0) {
        const z = O.zap;
        z.count = n; z.color = (this.time * 7) % 1 < 0.5 ? 0xfff36b : 0xbfefff;
        z.velocity.set(v.x * 0.8, 0.5, v.z * 0.8);
        _p.set(k.position.x, k.position.y + 0.7, k.position.z);
        fxs.emit('zap', _p, z);
      }
    }

    for (let i = 0; i < 2; i++) { wp[i].copy(wn[i]); ep[i].copy(en[i]); }
    this._trailsValid = true;
  }

  // ------------------------------------------------------------- teardown

  // Shadow pass (enableKartShadowLod): the low model stands in for the high one.
  // Both visibilities are restored exactly (a split-screen view may be showing
  // the low model already, see setForeignView).
  _shadowLod(on) {
    const hi = this.models.high, lo = this.models.low;
    if (!hi || !lo || this.model !== hi) return;
    if (on) {
      this._shadowHigh = hi.visible;          // (blinks while invulnerable)
      this._shadowLow = lo.visible;
      lo.visible = hi.visible || lo.visible;
      hi.visible = false;
    } else {
      hi.visible = this._shadowHigh;
      lo.visible = this._shadowLow;
    }
  }

  /**
   * Split-screen (SPEC §14.6): a view that does not own this kart draws it with
   * the low-detail model. on before rendering such a view, off afterwards.
   * Visibility only (no rebuilds); the invulnerability blink carries over.
   */
  setForeignView(on) {
    const hi = this.models.high, lo = this.models.low;
    if (!hi || !lo || this.model !== hi || on === this._foreign) return;
    this._foreign = on;
    if (on) {
      this._foreignHigh = hi.visible;
      lo.visible = hi.visible;
      hi.visible = false;
    } else {
      hi.visible = this._foreignHigh;
      lo.visible = false;
    }
  }

  dispose() {
    const k = shadowLodViews.indexOf(this);
    if (k >= 0) shadowLodViews.splice(k, 1);
    for (const off of this._offs) off();
    this._offs = [];
    // v5: hand the original materials back before the model goes, then free the clones / ice
    if (this._ghostOn) { this._ghost = 0; this._updateGhost(this.kart); }
    if (this._ghostMats) { for (const c of this._ghostMats.values()) c.dispose(); this._ghostMats = null; }
    if (this._iceShell) { this._iceShell.geometry.dispose(); this._iceShell.material.dispose(); this._iceShell = null; }
    if (this._mask) { if (this._mask.parent) this._mask.parent.remove(this._mask); this._mask.geometry.dispose(); this._mask.material.dispose(); this._mask = null; }
    if (this.object.parent) this.object.parent.remove(this.object);
    for (const key of ['high', 'low']) {
      const m = this.models[key];
      if (m) disposeKartModel(m);
      this.models[key] = null;
    }
    if (this._ownedMaterials) for (const mat of this._ownedMaterials) mat.dispose();
    this._ownedMaterials = null;
    if (this.antenna) {
      const au = this.antenna.userData;
      au.rod.geometry.dispose(); au.tip.geometry.dispose();
      au.rodMat.dispose(); au.tipMat.dispose();
      this.antenna = null;
    }
    if (this.beerRig) {
      for (const g of this.beerRig.geos) g.dispose();
      for (const m of this.beerRig.mats) m.dispose();
      this.beerRig = null;
    }
    this.model = null;
  }
}
