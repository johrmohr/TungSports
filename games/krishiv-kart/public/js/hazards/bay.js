// Breezy Bay Circuit course set pieces (theme 'bay', SPEC §16.1; reference
// math notes/research-v5-tracks.md §C1-C3). Node-safe and deterministic: every
// hazard's state is a pure function of its def and the race clock, so the
// game, the headless sim, the CPU look-ahead (hitAt) and the world renderer
// (world-breezy.js, via hz.stateAt) agree on where the danger is.
//
// Hazard defs (track-def.js `hazards`; lateral + = right of the driving direction):
//   crab  { u, latA, latB, period, phase, radius }
//         A giant sand crab patrolling across the road between latA and latB.
//         Cycle p = frac(t / period + phase): walk A→B (eased) 0-42 %, pause at B
//         with claws raised 42-50 % (the telegraph of the reversal), walk back
//         50-92 %, pause at A 92-100 %. Hits a kart circle within radius + kart
//         radius of its body while the kart is < 1.3 m up. Effect: spin.
//   surge { u0, u1, side ±1, reachLap1, reach, rampT: [t0, t1], period, phase }
//         A wave washing over the low causeway from the sea edge (side -1 = left).
//         Cycle: calm 0-45 %, build 45-65 % (telegraph: the wave rises offshore,
//         rumble), wash-in 65-70 %, hold 70-85 %, recede 85-100 %. The reach
//         (share of the road width covered from the sea edge) grows with the
//         race clock from reachLap1 to reach between rampT[0] and rampT[1] s
//         (lap 1 teaches it, later laps test it); the land side (1 - reach) is
//         always dry. Wet + < 0.8 m up → effect slow 0.3 plus a 2 m/s shove
//         toward land (no loss of control).
//   ball  { u, from ±1, period, phase, count, speed, radius, bounce, hop, bounce0, travel }
//         `count` giant beach balls per period roll across the road from side
//         `from` (lateral from·travel/2 → −from·travel/2 at `speed` m/s, then gone
//         until the period ends), bouncing to `bounce` m every `hop` s (bounce0 s
//         into a hop at the start: hop / 2 = at the top, over the wall). A ball only hits while its bottom is
//         < 1.2 m up (karts pass under high bounces). Effect: knock (a bump away
//         from the ball, no item loss).
// The kart's own projection is tested ('proj' check mode), so check() and
// hitAt() are the same function. Stars / Beer Rockets / just-hit karts pass.

import { makeHazardSet, cyclePhase, frac, smooth } from './common.js';

const lerp = (a, b, f) => a + (b - a) * f;

/** Tuning shared by the hit model and the renderer. */
export const BAY_TUNE = {
  crab: { walk: 0.42, height: 1.3 },        // walk A→B 0-42 %, pause 42-50 %, back 50-92 %, pause 92-100 %
  surge: { build0: 0.45, wash0: 0.65, full0: 0.70, recede0: 0.85, depth: 0.8, strength: 0.3, push: 2 },
  ball: { kartTop: 1.2 },                   // a ball whose bottom is higher than this passes over karts
};

// ---------------------------------------------------------------- crab

/** Lateral of a crab at time t. */
export function crabLat(h, t) {
  const W = BAY_TUNE.crab.walk, p = cyclePhase(h, t);
  if (p < W) return lerp(h.latA, h.latB, smooth(p / W));
  if (p < 0.5) return h.latB;
  if (p < 0.5 + W) return lerp(h.latB, h.latA, smooth((p - 0.5) / W));
  return h.latA;
}

// ---------------------------------------------------------------- surge

/** Full reach (share of the road width, 0..1) of a surge at race time t (the tide rises). */
export function surgeFullReach(h, t) {
  const [t0, t1] = h.rampT || [0, 1];
  return lerp(h.reachLap1 ?? h.reach, h.reach, smooth((t - t0) / Math.max(1e-6, t1 - t0)));
}

/** Current reach (0..1 of the road width from the sea edge) of a surge at time t. */
export function surgeReach(h, t) {
  const S = BAY_TUNE.surge, p = cyclePhase(h, t);
  if (p < S.wash0) return 0;
  const full = surgeFullReach(h, t);
  if (p < S.full0) return full * smooth((p - S.wash0) / (S.full0 - S.wash0));
  if (p < S.recede0) return full;
  return full * (1 - smooth((p - S.recede0) / (1 - S.recede0)));
}

/** Lateral of the waterline for a reach (h.hw = the band's road half-width). */
export const surgeEdge = (h, reach) => h.side * h.hw - h.side * reach * 2 * h.hw;

// ---------------------------------------------------------------- ball

/**
 * Balls of a `ball` hazard at time t → out[k] = { lat, bottom, tau, active }
 * (out is reused: pass your own array; `count` entries are written).
 */
export function ballsAt(h, t, out = []) {
  const n = h.count || 1;
  for (let k = 0; k < n; k++) {
    const tau = frac(t / h.period + (h.phase || 0) + k / n) * h.period;
    const d = tau * h.speed;
    const b = out[k] || (out[k] = { lat: 0, bottom: 0, tau: 0, d: 0, active: false });
    b.tau = tau; b.d = d;
    b.active = d <= h.travel;
    b.lat = h.from * h.travel / 2 - h.from * d;
    b.bottom = h.bounce ? h.bounce * Math.abs(Math.sin(Math.PI * (tau + (h.bounce0 || 0)) / h.hop)) : 0;
  }
  out.length = n;
  return out;
}

// ---------------------------------------------------------------- kinds

const CRAB_HIT = Object.freeze({ type: 'crab', effect: 'spin' });
const _balls = [];

/** The bay's hazard kinds (hazards/common.js kind contract). */
export const BAY_KINDS = {
  crab: {
    hit(h, t, along, lat, up = 0, r = 1.1) {
      if (up > BAY_TUNE.crab.height) return null;
      const dl = lat - crabLat(h, t), rr = h.radius + r;
      return along * along + dl * dl < rr * rr ? CRAB_HIT : null;
    },
    extent(h) { return h.radius; },
    maxGrade: 0.09,                          // a lateral mover may sit on a gentle grade (track-check)
    state(h, t) {
      const W = BAY_TUNE.crab.walk, p = cyclePhase(h, t);
      const walking = p < W || (p >= 0.5 && p < 0.5 + W);
      // heading: +1 moving toward latB, -1 back toward latA (0 while paused)
      const dir = p < W ? 1 : p < 0.5 ? 0 : p < 0.5 + W ? -1 : 0;
      // claws raised during the pauses (the reversal telegraph), eased in / out
      const pause = p < W ? 0 : p < 0.5 ? (p - W) / (0.5 - W) : p < 0.5 + W ? 0 : (p - 0.5 - W) / (0.5 - W);
      const claws = walking ? 0 : Math.sin(Math.PI * Math.min(1, pause * 1.15));
      const wp = p < W ? p / W : p >= 0.5 && p < 0.5 + W ? (p - 0.5) / W : 0;
      return { p, lat: crabLat(h, t), walking, dir, claws, gait: walking ? 4 * wp * (1 - wp) : 0 };
    },
  },

  surge: {
    resolve(h, track) {
      h.side = h.side < 0 ? -1 : 1;
      h.hw = track.frameAt(h.s + h.len / 2).halfWidth;
    },
    hit(h, t, along, lat, up = 0, r = 1.1) {
      if (along < 0 || along > h.len || up > BAY_TUNE.surge.depth) return null;
      const reach = surgeReach(h, t);
      if (reach <= 0) return null;
      const edge = surgeEdge(h, reach);
      const wet = h.side < 0 ? lat - r < edge : lat + r > edge;
      return wet ? { type: 'surge', effect: 'slow', strength: BAY_TUNE.surge.strength, push: BAY_TUNE.surge.push, side: h.side } : null;
    },
    extent(h) { return [0, h.len]; },
    // AI cost of a wet spot (the planner prefers the dry lane, never brakes for it)
    soft(h, t, along, lat) {
      if (along < 0 || along > h.len) return 0;
      const reach = Math.max(surgeReach(h, t), cyclePhase(h, t) >= BAY_TUNE.surge.build0 ? surgeFullReach(h, t) * 0.5 : 0);
      if (reach <= 0) return 0;
      const edge = surgeEdge(h, reach);
      return (h.side < 0 ? lat < edge : lat > edge) ? 0.6 : 0;
    },
    state(h, t) {
      const S = BAY_TUNE.surge, p = cyclePhase(h, t), full = surgeFullReach(h, t), reach = surgeReach(h, t);
      const phase = p < S.build0 ? 'calm' : p < S.wash0 ? 'build' : p < S.full0 ? 'wash' : p < S.recede0 ? 'hold' : 'recede';
      return {
        p, phase, reach, full,
        edge: surgeEdge(h, reach),
        build: p < S.build0 ? 0 : p < S.wash0 ? (p - S.build0) / (S.wash0 - S.build0) : 1,   // telegraph 0..1
        wet: p < S.wash0 ? Math.max(0, 1 - p / 0.3) : 1,          // the darkened sand drying after a wave
      };
    },
  },

  ball: {
    hit(h, t, along, lat, up = 0, r = 1.1) {
      const rr = h.radius + r;
      if (along * along >= rr * rr) return null;
      const balls = ballsAt(h, t, _balls);
      for (let k = 0; k < balls.length; k++) {
        const b = balls[k];
        if (!b.active || b.bottom > BAY_TUNE.ball.kartTop || up > b.bottom + 2 * h.radius) continue;
        const dl = lat - b.lat;
        if (along * along + dl * dl < rr * rr) return { type: 'ball', effect: 'knock', lateral: b.lat, hazard: h };
      }
      return null;
    },
    extent(h) { return h.radius; },
    maxGrade: 0.09,                          // a lateral mover may sit on a gentle grade (track-check)
    state(h, t) { return { balls: ballsAt(h, t, []) }; },
  },
};

/** Build Breezy Bay's hazard set (Track instance with def.hazards). */
export function createHazards(track, opts = {}) {
  return makeHazardSet(track, BAY_KINDS, { ...opts, theme: 'bay' });
}
