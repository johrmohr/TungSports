// Course hazards registry (SPEC §15.3, §16.1). Node-safe and deterministic:
// every hazard's state is a pure function of its def and the race clock, so
// the game, the headless sim, the CPU drivers (look-ahead) and the world kits
// (rendering) all agree on where the danger is.
//
//   import { createHazards, stepCourseHazards } from './hazards.js';
//   const hz = createHazards(track);        // by track.theme → hazards/<theme>.js (none / no defs → empty set)
//   // once per physics substep, after the kart collisions (main.js step, tools/sim.mjs):
//   stepCourseHazards(hz, karts, dt, live);  // clock + hits (+ knock / slow / belts), same code everywhere
//   hz.hitAt(s, lateral, t)                 // track coords, any time t (CPU look-ahead)
//
// Per theme: bay (Breezy Bay), hilltown (Monte Mozzarella), campus (Aldrich
// Park), beach (Laguna Beach), castle (Krishiv's Palace: crushers, flame arms,
// lava geysers). Each module exports createHazards(track, opts) built on
// hazards/common.js makeHazardSet (the kind contract is documented there). An
// unknown theme falls back to the castle kinds (the v4 behaviour: any track's
// def.hazards of the v4 types).
//
// The set's interface: { list, time, driven, update(dt), setTime(t), reset(t),
// stateAt(h), hitOne(h, t, along, lat, up, r), hitAt(s, lat, t, up, r),
// hitAtWorld(x, y, z, t, r), check(kart), ahead(s, dist), [pushAt(kart)],
// [softAt(s, lat, t)] }. check() / hitAt() return null, a type string ('crush',
// 'fire', ... ) or { type, effect: 'tumble' | 'spin' | 'knock' | 'slow',
// strength?, side?, lateral?, from? }; applyHazardHit maps them:
//   'crush' → kart.tumble('crush')        'fire' → kart.spinOut('fire')        (v4)
//   tumble  → kart.tumble(type)           spin   → kart.spinOut(type)
//   knock   → a light bump: hop, shove away from the object, speed x 0.8, drift
//             cancelled; no item loss; 0.6 s re-hit cooldown per hazard (kart:knock)
//   slow    → max speed x (1 - strength), easing back over 1 s; optional lateral
//             shove `push` m/s; 1.5 s cooldown per kart (kart:slow)
// Karts that are not hittable (star, Beer Rocket, just hit) pass through:
// check() returns null for them, and hazardProof() skips them.
//
// World kits expose the same object as `world.hazards` and draw it from
// `hz.time` / `hz.stateAt(h)` (world-palace.js).

import { createHazards as createCastle } from './hazards/castle.js';
import { createHazards as createBay } from './hazards/bay.js';
import { createHazards as createHilltown } from './hazards/hilltown.js';
import { createHazards as createCampus } from './hazards/campus.js';
import { createHazards as createBeach } from './hazards/beach.js';
import { clamp } from './utils.js';
import { bus } from './bus.js';

// v4 exports (world-palace.js, track-check): the castle module's helpers.
export { HAZARD_TUNE, hazardPhase, crusherBottom, flameArmAngle, hazardState, hazardHit, hazardExtent, CASTLE_KINDS } from './hazards/castle.js';
export { makeHazardSet, resolveHazard, cyclePhase, sOfKey } from './hazards/common.js';

const THEMES = {
  bay: createBay,
  hilltown: createHilltown,
  campus: createCampus,
  beach: createBeach,
  castle: createCastle,
};

/** Themes with a hazards module. */
export const HAZARD_THEMES = Object.keys(THEMES);

/** Register (or replace) a theme's set builder at runtime: fn(track, opts) → hazard set. */
export function registerHazardTheme(theme, fn) {
  if (typeof theme !== 'string' || typeof fn !== 'function') throw new TypeError('registerHazardTheme(theme, fn)');
  THEMES[theme] = fn;
}

/** Build the hazard set of a track by its theme (empty set when the theme module has none). */
export function createHazards(track, opts = {}) {
  const make = THEMES[track && track.theme] || createCastle;
  return make(track, opts);
}

// ------------------------------------------------------------------ effects

/** Tuning of the v5 soft effects (research-v5-tracks.md C0). */
export const HAZARD_FX = {
  knock: { hop: 2.5, shove: 4, speedKeep: 0.8, rehit: 0.6 },
  slow: { strength: 0.3, ease: 1.0, cooldown: 1.5 },
  pushRate: 6,               // 1/s: a belt's push blends into the kart's velocity at this rate
};
const EFFECTS = new Set(['tumble', 'spin', 'knock', 'slow']);

/**
 * Normalise a check() / hitAt() result: null | { type, effect, strength, ... }.
 * 'crush' → tumble, 'fire' → spin (v4), an effect name → itself, any other
 * string → spin; objects keep their fields (effect defaults to spin).
 */
export function hazardEffect(hit) {
  if (!hit) return null;
  if (typeof hit === 'string') {
    if (hit === 'crush') return { type: 'crush', effect: 'tumble' };
    if (hit === 'fire') return { type: 'fire', effect: 'spin' };
    return { type: hit, effect: EFFECTS.has(hit) ? hit : 'spin' };
  }
  if (typeof hit !== 'object') return null;
  const effect = EFFECTS.has(hit.effect) ? hit.effect : 'spin';
  return { ...hit, type: hit.type || effect, effect };
}

/** A kart a hazard cannot hurt: on the grid / frozen, invincible (Rainbow Star, Beer Rocket). */
export function hazardProof(k) {
  if (k.frozen) return true;
  if (typeof k.isInvincible === 'function' ? k.isInvincible() : k.starTimer > 0) return true;
  return !!k.beer;                     // Beer Rocket (items.js also keeps starTimer up)
}

const LOOSE = { fx: null };     // cooldown holder for applyHazardHit without a hazard set

function fxState(hz, k) {
  if (!hz.fx) hz.fx = { clock: 0, karts: new Map() };
  let s = hz.fx.karts.get(k);
  if (!s) { s = { knock: new Map(), slowAt: -Infinity, slowStrength: 0, slowUntil: -Infinity }; hz.fx.karts.set(k, s); }
  return s;
}

/**
 * Apply one hazard hit to a kart (the caller checked hazardProof). Returns
 * true if something happened. `hz` holds the per-kart cooldowns (hz.fx).
 */
export function applyHazardHit(k, hit, hz = null) {
  const e = hazardEffect(hit);
  if (!e) return false;
  if (e.effect === 'tumble') return k.tumble(e.type);
  if (e.effect === 'spin') return k.spinOut(e.type);
  const holder = hz || LOOSE;
  const st = fxState(holder, k);
  const now = holder.fx.clock;
  if (e.effect === 'knock') {
    const key = e.hazard && e.hazard.index !== undefined ? e.hazard.index : e.type;
    if (now < (st.knock.get(key) ?? -Infinity)) return false;
    if (typeof k.isDisabled === 'function' && k.isDisabled()) return false;
    st.knock.set(key, now + HAZARD_FX.knock.rehit);
    const K = HAZARD_FX.knock, str = clamp(e.strength ?? 1, 0, 2);
    // shove direction: away from the object (from {x,z} / its lateral / a side), else none
    let sx = 0, sz = 0;
    const pr = k.proj;
    if (e.from && Number.isFinite(e.from.x)) {
      const dx = k.position.x - e.from.x, dz = k.position.z - e.from.z, d = Math.hypot(dx, dz);
      if (d > 1e-3) { sx = dx / d; sz = dz / d; }
    } else if (pr && pr.right) {
      const side = Number.isFinite(e.side) ? -Math.sign(e.side) || 1
        : Number.isFinite(e.lateral) ? Math.sign(pr.lateral - e.lateral) || 1 : 0;
      sx = pr.right.x * side; sz = pr.right.z * side;
    }
    const keep = 1 - (1 - K.speedKeep) * Math.min(1, str);
    k.velocity.x = k.velocity.x * keep + sx * K.shove * str;
    k.velocity.z = k.velocity.z * keep + sz * K.shove * str;
    if (!k.frozen) { k.velocity.y = Math.max(k.velocity.y, K.hop * Math.min(1, str)); k.grounded = false; }
    if (typeof k._cancelDrift === 'function') k._cancelDrift();
    bus.emit('kart:knock', { kart: k, cause: e.type, strength: str });
    return true;
  }
  // slow
  const S = HAZARD_FX.slow;
  if (now < st.slowAt + S.cooldown) return false;
  st.slowAt = now;
  st.slowStrength = clamp(e.strength ?? S.strength, 0, 0.9);
  st.slowUntil = now + S.ease;
  if (Number.isFinite(e.push) && e.push !== 0 && k.proj && k.proj.right) {
    const side = Number.isFinite(e.side) ? Math.sign(e.side) || 1 : 1;     // shove toward -side (surges: toward land)
    k.velocity.x -= k.proj.right.x * side * e.push;
    k.velocity.z -= k.proj.right.z * side * e.push;
  }
  bus.emit('kart:slow', { kart: k, cause: e.type, strength: st.slowStrength });
  return true;
}

/**
 * One physics substep of the course hazards for a field of karts (main.js
 * stepHazards and tools/sim.mjs both call this): advance the clock, then (when
 * `live`: racing / finished) check every kart and apply the hit, keep running
 * slow effects capped, and apply belt pushes (hz.pushAt).
 */
export function stepCourseHazards(hz, karts, dt, live = true) {
  if (!hz) return;
  hz.update(dt);
  const fx = hz.fx || (hz.fx = { clock: 0, karts: new Map() });
  if (dt > 0) fx.clock += dt;
  if (!live) return;
  for (let i = 0; i < karts.length; i++) {
    const k = karts[i];
    const hit = hz.check(k);
    if (!hit || hazardProof(k)) continue;
    applyHazardHit(k, hit, hz);
  }
  // running slow effects: max speed x (1 - strength), easing back to 1
  if (fx.karts.size) {
    for (const [k, st] of fx.karts) {
      if (!(st.slowUntil > fx.clock) || hazardProof(k)) continue;
      const u = 1 - (st.slowUntil - fx.clock) / HAZARD_FX.slow.ease;
      const cap = k.maxSpeed * (1 - st.slowStrength * (1 - clamp(u, 0, 1)));
      const hs = Math.hypot(k.velocity.x, k.velocity.z);
      if (hs > cap && hs > 1e-3) { k.velocity.x *= cap / hs; k.velocity.z *= cap / hs; }
    }
  }
  // conveyor belts: tangent x push blended into the velocity
  if (typeof hz.pushAt === 'function') {
    const a = Math.min(1, HAZARD_FX.pushRate * dt);
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (!k.grounded || hazardProof(k) || !k.proj || !k.proj.tangent) continue;
      const v = hz.pushAt(k);
      if (!v) continue;
      k.velocity.x += k.proj.tangent.x * v * a;
      k.velocity.z += k.proj.tangent.z * v * a;
    }
  }
}
