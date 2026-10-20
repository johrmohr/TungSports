// Aldrich Park course set pieces (theme 'campus', SPEC §16.1). Node-safe, pure:
// every state is a function of the hazard def and the race clock t only, so
// the game, the headless sim, the CPU look-ahead (hz.ahead / hz.hitAt) and the
// world renderer (world-aldrich.js reads hz.stateAt(h)) agree. Everything here
// is true to the place (notes/research-v5-aldrich.md §8):
//
//   cyclist   — students riding across the Ring Mall at the real service-road
//               crossings. Rider k of `riders` (2: opposite lanes, half a
//               period apart) waits beyond the barrier ringing its bell for
//               CYC.bell s (the telegraph), crosses wall to wall at `speed`,
//               then rides off. Hit = spin (clipped a bike).
//               def { u, speed, period, phase, riders = 2, skater? (rider index on a board) }
//   ducks     — the Infinity Fountain's mallard pair waddling in file from the
//               plaza verge (lateral0) to just past the centre line (lateral1)
//               and back; pauses at both ends. Hit = knock (a soft sideways
//               bump, no spin, no item loss). The far half is always clear.
//               def { u, lateral0, lateral1, speed, period, phase }
//   sprinkler — impact sprinklers on the meadow verges, two irrigation zones
//               taking turns: a head pops up (telegraph), then its jet (`reach`
//               m long) makes one slow sweep across an `arc`° fan centred
//               across the road for `run` of the period. Hit = slow (wet tyres,
//               -30 % top speed easing back). The other half is dry meanwhile.
//               def { u, lateral (head), reach, arc, period, phase, run = 0.4 }
//
// Hit results carry `hazard: h` (the knock re-hit cooldown is per hazard) and
// `lateral` (knocks shove the kart away from the object sideways).

import { makeHazardSet, frac, smooth } from './common.js';

/** Tuning shared with the world renderer. */
export const CAMPUS_TUNE = {
  cyclist: {
    bell: 0.9,          // s waiting at the curb, ringing, before rolling (telegraph)
    beyond: 3.0,        // m beyond each barrier where a ride starts / ends (on the service road)
    lane: 1.2,          // m: rider A rides at along -lane, rider B at +lane (keep right)
    halfLen: 0.95,      // m: half the bike's length (it crosses sideways: along the lateral axis)
    halfWid: 0.35,      // m: half its width (along the track)
    height: 1.7,        // m: rider height (a kart this far above the road clears it)
    ride: 1.6,          // s the renderer keeps a rider in view after it left the far barrier
  },
  ducks: {
    radius: 0.45,       // m: body radius of each duck
    gap: 1.0,           // m: the hen walks this far to the plaza side of the drake (in file)
    stagger: 0.45,      // m: ... and this far along the track (both visible)
    height: 0.9,        // m: a kart this far above the road clears them
    strength: 0.4,      // knock strength
  },
  sprinkler: {
    pre: 0.8,           // s: the head pops up (hiss, spit) this long before its zone runs
    halfWidth: 0.75,    // m: half the jet's width
    height: 1.5,        // m: a kart this far above the road flies over the spray
    strength: 0.3,      // slow strength (-30 % top speed)
  },
};
const CYC = CAMPUS_TUNE.cyclist, DK = CAMPUS_TUNE.ducks, SPR = CAMPUS_TUNE.sprinkler;

// Distance² from (a, l) to an axis-aligned box centred at (a0, l0) with half sizes ha (along), hl (lateral).
function boxDist2(a, l, a0, l0, ha, hl) {
  const da = Math.max(0, Math.abs(a - a0) - ha), dl = Math.max(0, Math.abs(l - l0) - hl);
  return da * da + dl * dl;
}

// ------------------------------------------------------------------ cyclist

/** Rider k of a crossing at t: { lat, along, dir, mode: 'bell' | 'ride' | 'gone', tau, skater }. */
export function cyclistRider(h, k, t, out = {}) {
  const n = Math.max(1, h.riders || 2);
  const tau = frac(t / h.period + (h.phase || 0) + k / n) * h.period;
  const dir = k % 2 === 0 ? 1 : -1;                    // A: from the left (building side), B: from the right
  const start = dir > 0 ? h.latStart : h.latEnd, end = dir > 0 ? h.latEnd : h.latStart;
  out.dir = dir;
  out.along = (k % 2 === 0 ? -1 : 1) * CYC.lane * (n > 2 ? 1 + Math.floor(k / 2) * 0.8 : 1);
  out.tau = tau;
  out.skater = h.skater === k;
  if (tau < CYC.bell) { out.mode = 'bell'; out.lat = start; return out; }
  const d = (tau - CYC.bell) * h.speed;
  if (d <= h.travel) { out.mode = 'ride'; out.lat = start + dir * d; return out; }
  out.mode = 'gone'; out.lat = end + dir * (d - h.travel);
  return out;
}

const _rider = {};
const cyclist = {
  maxGrade: 0.09,      // track-check: a lateral mover may sit on a gentle grade (the Ring rolls)
  resolve(h, track) {
    const f = track.frameAt(h.s);
    h.wallL = f.wallL; h.wallR = f.wallR; h.halfWidth = f.halfWidth;
    h.latStart = -(f.wallL + CYC.beyond);
    h.latEnd = f.wallR + CYC.beyond;
    h.travel = h.latEnd - h.latStart;
    h.speed = h.speed || 5;
    h.riders = Math.max(1, h.riders || 2);
    h.rideTime = h.travel / h.speed;
  },
  extent(h) { return CYC.lane * (Math.max(1, h.riders || 2) > 2 ? 1.8 : 1) + CYC.halfWid + 0.1; },
  hit(h, t, along, lat, up, r) {
    if (up > CYC.height) return null;
    for (let k = 0; k < h.riders; k++) {
      const rd = cyclistRider(h, k, t, _rider);
      if (rd.mode === 'gone') continue;
      if (boxDist2(along, lat, rd.along, rd.lat, CYC.halfWid, CYC.halfLen) < r * r) {
        return { type: 'cyclist', effect: 'spin', strength: 0.7, lateral: rd.lat, hazard: h };
      }
    }
    return null;
  },
  state(h, t) {
    const st = h._st || (h._st = { riders: [] });
    for (let k = 0; k < h.riders; k++) st.riders[k] = cyclistRider(h, k, t, st.riders[k] || {});
    st.riders.length = h.riders;
    return st;
  },
};

// ------------------------------------------------------------------ ducks

/** The pair at t: lateral of the drake (lead), walking direction (0 = paused), cycle position. */
export function duckWalk(h, t, out = {}) {
  const span = Math.abs(h.lateral1 - h.lateral0);
  const W = span / h.speed;                            // s per crossing
  const P = Math.max(0, (h.period - 2 * W) / 2);       // s pause at each end
  const tau = frac(t / h.period + (h.phase || 0)) * h.period;
  const sgn = Math.sign(h.lateral1 - h.lateral0) || 1;
  let u, dir;
  if (tau < P) { u = 0; dir = 0; out.mode = 'preen'; }                         // on the plaza verge
  else if (tau < P + W) { u = (tau - P) / W; dir = sgn; out.mode = 'out'; }
  else if (tau < 2 * P + W) { u = 1; dir = 0; out.mode = 'turn'; }             // just past the centre line
  else { u = 1 - (tau - 2 * P - W) / W; dir = -sgn; out.mode = 'back'; }
  out.lead = h.lateral0 + (h.lateral1 - h.lateral0) * Math.min(1, Math.max(0, u));
  out.dir = dir;
  out.u = u;
  out.tau = tau;
  out.pause = P;
  out.walk = W;
  return out;
}

const _walk = {};
const ducks = {
  maxGrade: 0.09,
  resolve(h) {
    h.speed = h.speed || 1.3;
    h.side = Math.sign(h.lateral1 - h.lateral0) || 1;  // the hen keeps to the lateral0 side of the drake
  },
  extent() { return DK.stagger + DK.radius + 0.1; },
  hit(h, t, along, lat, up, r) {
    if (up > DK.height) return null;
    const w = duckWalk(h, t, _walk);
    const rr = (DK.radius + r) * (DK.radius + r);
    // the drake at (0, lead), the hen at (stagger, lead - side * gap)
    for (let k = 0; k < 2; k++) {
      const a = k * DK.stagger, l = w.lead - k * h.side * DK.gap;
      const da = along - a, dl = lat - l;
      if (da * da + dl * dl < rr) return { type: 'ducks', effect: 'knock', strength: DK.strength, lateral: l, hazard: h };
    }
    return null;
  },
  state(h, t) {
    const st = h._st || (h._st = {});
    duckWalk(h, t, st);
    st.hen = st.lead - h.side * DK.gap;
    return st;
  },
};

// ------------------------------------------------------------------ sprinkler

/**
 * The jet at t: { on, rise (0..1 pop-up head), angle (rad; 0 = straight across
 * the road, + = toward +along), p (cycle position) }. Irrigation zones take
 * turns (the meadow's two heads are half a period apart): a head runs for
 * `run` of its period, one slow sweep across its fan (alternate cycles sweep
 * back the other way), and pops up SPR.pre s before it starts (telegraph).
 */
export function sprinklerJet(h, t, out = {}) {
  const x = t / h.period + (h.phase || 0);
  const n = Math.floor(x), p = x - n;
  const run = h.run || 0.4;
  const pre = Math.min(0.45, SPR.pre / h.period);
  const arc = ((h.arc || 150) * Math.PI) / 180;
  out.p = p;
  out.on = p < run;
  out.rise = out.on ? 1 : p > 1 - pre ? smooth((p - (1 - pre)) / pre) : p < run + 0.06 ? 1 - (p - run) / 0.06 : 0;
  const k = out.on ? smooth(p / run) : p < run + 0.06 ? 1 : 0;
  out.angle = (n % 2 === 0 ? 1 : -1) * arc * (k - 0.5);
  return out;
}

const _jet = {};
const sprinkler = {
  maxGrade: 0.09,      // the meadow spine runs downhill (8 %); the hits are in road coordinates
  resolve(h) {
    h.reach = h.reach || 12;
    h.dirLat = -Math.sign(h.lateral) || 1;             // the fan is centred across the road
  },
  extent(h) { return (h.reach || 12) * Math.sin(Math.min(Math.PI / 2, ((h.arc || 150) * Math.PI) / 360)) + SPR.halfWidth + 0.2; },
  hit(h, t, along, lat, up, r) {
    if (up > SPR.height) return null;
    const j = sprinklerJet(h, t, _jet);
    if (!j.on) return null;
    const da = Math.sin(j.angle), dl = h.dirLat * Math.cos(j.angle);
    const pa = along, pl = lat - h.lateral;
    const q = Math.max(0, Math.min(h.reach, pa * da + pl * dl));
    const ea = pa - da * q, el = pl - dl * q;
    const R = SPR.halfWidth + r;
    if (ea * ea + el * el < R * R) return { type: 'sprinkler', effect: 'slow', strength: SPR.strength, side: Math.sign(h.lateral), hazard: h };
    return null;
  },
  state(h, t) {
    const st = h._st || (h._st = {});
    sprinklerJet(h, t, st);
    st.da = Math.sin(st.angle);
    st.dl = h.dirLat * Math.cos(st.angle);
    return st;
  },
};

export const CAMPUS_KINDS = { cyclist, ducks, sprinkler };

/** Build this theme's hazard set (Track instance with def.hazards). */
export function createHazards(track, opts = {}) {
  return makeHazardSet(track, CAMPUS_KINDS, { ...opts, theme: 'campus' });
}
