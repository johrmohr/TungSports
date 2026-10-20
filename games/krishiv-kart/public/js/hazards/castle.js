// Krishiv's Palace course hazards (theme 'castle', SPEC §15.3, §16.1).
// Node-safe and deterministic: the state of every hazard is a pure function
// of its def and the race clock (hazards/common.js builds the set; the castle
// keeps the v4 'frame' check — the kart projected onto each hazard's own
// straight frame — every castle hazard sits on a straight).
//
// Hazard defs (track-def-palace.js; u + lateral as everywhere, + = right):
//   crusher  { u, lateral, size, period, phase }: a faceless stone block with
//            a square footprint `size` m, cycling (fraction p of the period,
//            phase = p at t = 0): hover 0-55 % (7 m up, shadow on the road),
//            shake 55-70 % (telegraph: rattles, sags 0.4 m), slam 70-75 %,
//            rest 75-86 %, rise 86-100 %. Dangerous while its bottom is
//            < 1.6 m above the road (~74-90 % of the period, ~0.5 s).
//   flamearm { u, lateral, length, speed, phase }: a chain of fireballs of
//            `length` m swinging round a stone pillar (radius 1 m) at kart
//            height; angle = phase + speed·t degrees, 0 = pointing along the
//            driving direction, +90 = pointing right. The pillars stand just
//            past the road edges, so the middle of the road is always safe.
//   geyser   { u, lateral, radius, period, phase }: lava jet; idle 0-55 %,
//            bubbling 55-75 % (telegraph), erupting 75-100 %.
// v5 (SPEC §16.1, notes/research-v5-tracks.md C8 / C9, notes/v5-track-palace.md):
//   belt     { u0, u1, latA, latB, startDir ±1, forward, backward, period, phase }:
//            a Forge conveyor lane between latA and latB (a classic factory-course
//            conveyor, our own look): direction d = startDir · (+1 over 0-45 % of
//            the period, stop 45-50 %, -1 over 50-95 %, stop 95-100 %). It never
//            hits: a grounded kart on it is pushed along the track by +forward
//            (d > 0) or -backward m/s (d < 0) (pushAt; hazards.js blends it into
//            the velocity at 6 1/s, so forward 1.8 ≈ +12 % and backward 1.25 ≈ -17 %
//            of top speed at 100-150cc, measured). The surface is drawn scrolling at
//            HAZARD_TUNE.belt.look × that. Lane colour (green / red), scrolling
//            chevrons and an amber strobe + clunk in the stops telegraph it.
//   curtain  { u, latA, latB, period, phase }: lava pouring from a ceiling slot
//            across the lane band latA..latB, 1.6 m deep: idle 0-55 %, drip 55-75 %
//            (telegraph: glowing drips, a growing glow on the floor, a hiss),
//            pour 75-100 %, deadly 78-98 % -> 'fire' (spin), also for karts in the air.
//   chandelier { u, lateral, pivot, chain, radius, amp, period, phase }: an iron
//            wheel chandelier on a chain from a pivot `pivot` m above the road at
//            `lateral`, swinging ACROSS the road (a real pendulum arc): angle =
//            amp·sin(2π(t/period + phase)) degrees, + = toward the right. Its
//            ring (radius `radius`) only comes down to kart height near the
//            bottom of the swing; touching it -> a knock (bump, shove along the
//            swing, no item loss). Always visible: the swing is its telegraph.
//   portcullis { u, latA, latB, period, phase }: one leaf (latA..latB) of a
//            spiked iron gate in a stone arch over the road, 0.8 m deep: raised
//            0-48 % (bottom 5.5 m up), rattle 48-70 % (telegraph: shakes, sags
//            0.35 m, chains clank), slam 70-74 %, down 74-82 %, rise 82-100 %.
//            Dangerous while its bottom is < 1.6 m above the road -> 'crush'
//            (tumble). Two leaves per arch, half a period apart, so one half of
//            the road is always open (~0.4 s of danger per leaf and period).
// Effects (hazards.js applyHazardHit): 'crush' -> kart.tumble('crush'),
// 'fire' -> kart.spinOut('fire'), { effect: 'knock' } -> a bump. Karts that
// are not hittable (star, beer rocket, just hit) pass through: check()
// returns null for them.

import { KART } from '../config.js';
import { makeHazardSet, cyclePhase, frac } from './common.js';

export const HAZARD_TUNE = {
  crusher: {
    hover: 7.0,          // bottom height while waiting (m above the road)
    sag: 0.4,            // extra drop while shaking (telegraph)
    shake0: 0.55, slam0: 0.70, rest0: 0.75, rise0: 0.86,
    dangerHeight: 1.6,   // crushes while the bottom is lower than this
    height: 4.2,         // block height (m), for rendering
  },
  flamearm: {
    pillarRadius: 1.0,   // stone pivot pillar
    reach: 0.3,          // fireball radius beyond the arm line (+ kart radius)
    height: 1.0,         // arm height above the road (m)
    pillarHeight: 2.2,
  },
  geyser: {
    bubble0: 0.55, erupt0: 0.75,
    jetHeight: 7.5,      // erupting jet height (m), rendering + airborne karts
  },
  belt: {
    run: 0.45,           // fraction of the period each way (then a stop of 0.05)
    maxUp: 0.35,         // a kart this far above the belt is not pushed (airborne)
    look: 2.4,           // drawn surface speed = look × push (m/s)
  },
  curtain: {
    drip0: 0.55, pour0: 0.75, danger0: 0.78, danger1: 0.98,
    depth: 1.6,          // along-track thickness of the falling sheet (m)
    height: 9.0,         // slot height above the road (rendering; airborne karts are hit too)
  },
  chandelier: {
    ringHalf: 0.45,      // ring half-height (m): the hit slab is centre ± this
    kartTop: 1.5,        // a kart's height (m) above its road point
    planSmear: 0.12,     // s: CPU planning queries (wider radius) also test t ± this
  },
  portcullis: {
    raised: 5.5,         // bottom height while up (m)
    sag: 0.35,           // drop while rattling (telegraph)
    rattle0: 0.48, slam0: 0.70, down0: 0.74, rise0: 0.82,
    dangerHeight: 1.6,   // crushes while the bottom is lower than this
    depth: 0.8,          // along-track thickness incl. the spikes (m)
    height: 7.4,         // grille height (rendering: its top stays in the arch beam when down)
  },
  kartRadius: KART.radius,
  airClear: 2.6,         // a kart this far above the road clears flame arms
};

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const DEG = Math.PI / 180;

// Cycle position 0..1 of a periodic hazard at time t.
export function hazardPhase(h, t) { return cyclePhase(h, t); }

// Height of a crusher's bottom above the road at cycle position p.
export function crusherBottom(p) {
  const C = HAZARD_TUNE.crusher;
  if (p < C.shake0) return C.hover;
  if (p < C.slam0) return C.hover - C.sag * smooth((p - C.shake0) / 0.04);
  if (p < C.rest0) { const u = (p - C.slam0) / (C.rest0 - C.slam0); return (C.hover - C.sag) * (1 - u * u); }
  if (p < C.rise0) return 0;
  return C.hover * smooth((p - C.rise0) / (1 - C.rise0));
}

// Flame arm angle (radians, 0 = along the driving direction, + toward the right).
export function flameArmAngle(h, t) { return ((h.phase || 0) + h.speed * t) * Math.PI / 180; }

// Conveyor direction at cycle position p: +1 forward, -1 backward, 0 stopped (times startDir).
export function beltDir(h, p) {
  const B = HAZARD_TUNE.belt;
  const d = p < B.run ? 1 : p < 0.5 ? 0 : p < 0.5 + B.run ? -1 : 0;
  return d * (h.startDir || 1);
}
// Belt surface speed (m/s along the track) at time t.
export function beltSpeed(h, t) {
  const d = beltDir(h, cyclePhase(h, t));
  return d > 0 ? h.forward : d < 0 ? -h.backward : 0;
}
// Drawn belt surface displacement (m) since t = 0 (texture scroll; a pure function of t).
export function beltTravel(h, t) {
  const B = HAZARD_TUNE.belt, P = h.period, sd = h.startDir || 1;
  const fwd = (sd > 0 ? h.forward : -h.backward) * B.look, back = (sd > 0 ? -h.backward : h.forward) * B.look;
  const part = (p) => (Math.min(p, B.run) * fwd + Math.max(0, Math.min(p, 0.5 + B.run) - 0.5) * back) * P;
  const x = t / P + (h.phase || 0);
  return Math.floor(x) * part(1) + part(frac(x)) - part(frac(h.phase || 0));
}

// Chandelier swing angle (radians, + = toward the right) and its time derivative.
export function chandelierAngle(h, t) { return (h.amp || 30) * DEG * Math.sin(2 * Math.PI * (t / h.period + (h.phase || 0))); }
export function chandelierPose(h, t, out = {}) {
  const w = 2 * Math.PI / h.period, a = 2 * Math.PI * (t / h.period + (h.phase || 0));
  const th = (h.amp || 30) * DEG * Math.sin(a);
  out.theta = th;
  out.omega = (h.amp || 30) * DEG * w * Math.cos(a);
  out.lat = (h.lateral || 0) + h.chain * Math.sin(th);
  out.height = h.pivot - h.chain * Math.cos(th);       // ring centre above the road
  return out;
}

// Height of a portcullis leaf's bottom above the road at cycle position p.
export function portcullisBottom(p) {
  const G = HAZARD_TUNE.portcullis;
  if (p < G.rattle0) return G.raised;
  if (p < G.slam0) return G.raised - G.sag * smooth((p - G.rattle0) / 0.05);
  if (p < G.down0) { const u = (p - G.slam0) / (G.down0 - G.slam0); return (G.raised - G.sag) * (1 - u * u); }
  if (p < G.rise0) return 0;
  return G.raised * smooth((p - G.rise0) / (1 - G.rise0));
}

// Hazard state at time t (rendering / debugging):
//   crusher: { p, bottom, shaking, danger }
//   flamearm: { angle }
//   geyser: { p, bubbling, erupting, jet (0..1 jet height) }
//   belt: { p, dir, speed, travel, stopped }
//   curtain: { p, dripping, pouring, danger, drip (0..1), pour (0..1) }
//   chandelier: { theta, omega, lat, height, low (ring at kart height) }
//   portcullis: { p, bottom, rattling, danger }
export function hazardState(h, t) {
  const k = CASTLE_KINDS[h.type];
  return k ? k.state(h, t) : {};
}

// Does a kart circle at (along, lat) relative to the hazard's own frame
// (along = metres ahead of the hazard's s, lat = track lateral), `up` metres
// above the road, get hit at time t? -> null | 'crush' | 'fire' | { type, effect, ... }
export function hazardHit(h, t, along, lat, up = 0, r = HAZARD_TUNE.kartRadius) {
  const k = CASTLE_KINDS[h.type];
  return k ? k.hit(h, t, along, lat, up, r) : null;
}

// How far (m, along the track) a hazard reaches from its own s.
export function hazardExtent(h) {
  const k = CASTLE_KINDS[h.type];
  if (!k) return 0;
  const e = k.extent(h);
  return Array.isArray(e) ? Math.max(-e[0], e[1]) : e;
}

/** The castle's hazard kinds (hazards/common.js kind contract). */
export const CASTLE_KINDS = {
  crusher: {
    hit(h, t, along, lat, up = 0, r = HAZARD_TUNE.kartRadius) {
      const C = HAZARD_TUNE.crusher;
      const half = h.size / 2 + r;
      if (Math.abs(along) >= half || Math.abs(lat - h.lateral) >= half) return null;
      const bottom = crusherBottom(hazardPhase(h, t));
      return bottom < C.dangerHeight && up < bottom + 1.2 ? 'crush' : null;
    },
    extent(h) { return h.size / 2; },
    state(h, t) {
      const C = HAZARD_TUNE.crusher, p = hazardPhase(h, t), bottom = crusherBottom(p);
      return { p, bottom, shaking: p >= C.shake0 && p < C.slam0, danger: bottom < C.dangerHeight };
    },
  },
  flamearm: {
    hit(h, t, along, lat, up = 0, r = HAZARD_TUNE.kartRadius) {
      const F = HAZARD_TUNE.flamearm;
      const dx = along, dy = lat - h.lateral;
      if (up < F.pillarHeight && dx * dx + dy * dy < (F.pillarRadius + r) ** 2) return 'fire';
      if (up > HAZARD_TUNE.airClear) return null;
      const a = flameArmAngle(h, t);
      const ex = Math.cos(a) * h.length, ey = Math.sin(a) * h.length;
      const k = Math.max(0, Math.min(1, (dx * ex + dy * ey) / (h.length * h.length)));
      const qx = dx - ex * k, qy = dy - ey * k;
      return qx * qx + qy * qy < (r + F.reach) ** 2 ? 'fire' : null;
    },
    extent(h) { return h.length + HAZARD_TUNE.flamearm.reach; },
    state(h, t) { return { angle: flameArmAngle(h, t) }; },
  },
  geyser: {
    hit(h, t, along, lat, up = 0, r = HAZARD_TUNE.kartRadius) {
      if (hazardPhase(h, t) < HAZARD_TUNE.geyser.erupt0) return null;
      const dx = along, dy = lat - h.lateral;
      return dx * dx + dy * dy < (h.radius + r) ** 2 && up < HAZARD_TUNE.geyser.jetHeight ? 'fire' : null;
    },
    extent(h) { return h.radius; },
    state(h, t) {
      const G = HAZARD_TUNE.geyser, p = hazardPhase(h, t);
      const erupting = p >= G.erupt0;
      const e = erupting ? (p - G.erupt0) / (1 - G.erupt0) : 0;
      return { p, bubbling: p >= G.bubble0 && !erupting, erupting, jet: erupting ? Math.min(1, e * 8) * (e > 0.85 ? (1 - e) / 0.15 : 1) : 0 };
    },
  },

  // ---- v5: the Forge conveyor belts (surface push, never a hit)
  belt: {
    hit() { return null; },
    extent(h) { return [0, h.len]; },
    push(h, t, along, lat, up = 0) {
      if (along < 0 || along > h.len || lat < h.latA || lat > h.latB || up > HAZARD_TUNE.belt.maxUp) return 0;
      return beltSpeed(h, t);
    },
    // AI cost: a backward lane costs, a forward one is free (the planner may prefer it later)
    soft(h, t, along, lat) {
      if (along < 0 || along > h.len || lat < h.latA || lat > h.latB) return 0;
      return beltSpeed(h, t) < 0 ? 0.5 : 0;
    },
    state(h, t) {
      const p = hazardPhase(h, t), dir = beltDir(h, p);
      return { p, dir, speed: dir > 0 ? h.forward : dir < 0 ? -h.backward : 0, travel: beltTravel(h, t), stopped: dir === 0 };
    },
  },

  // ---- v5: the Lavafall Tunnel's lava curtains
  curtain: {
    hit(h, t, along, lat, up = 0, r = HAZARD_TUNE.kartRadius) {
      const C = HAZARD_TUNE.curtain;
      if (Math.abs(along) >= C.depth / 2 + r || lat <= h.latA - r || lat >= h.latB + r || up > C.height) return null;
      const p = hazardPhase(h, t);
      return p >= C.danger0 && p < C.danger1 ? 'fire' : null;
    },
    extent() { return HAZARD_TUNE.curtain.depth / 2; },
    state(h, t) {
      const C = HAZARD_TUNE.curtain, p = hazardPhase(h, t);
      const dripping = p >= C.drip0 && p < C.pour0, pouring = p >= C.pour0;
      return {
        p, dripping, pouring, danger: p >= C.danger0 && p < C.danger1,
        drip: dripping ? (p - C.drip0) / (C.pour0 - C.drip0) : pouring ? 1 : 0,
        pour: pouring ? (p - C.pour0) / (1 - C.pour0) : 0,
      };
    },
  },

  // ---- v5: the Banquet Hall's swinging chandeliers
  chandelier: {
    hit(h, t, along, lat, up = 0, r = HAZARD_TUNE.kartRadius) {
      const D = HAZARD_TUNE.chandelier, R = h.radius + r;
      if (Math.abs(along) >= R) return null;
      // A query with a wider radius than a kart's is a CPU planning margin
      // (ai.js tests a few arrival instants only): a fast swing is also looked
      // at D.planSmear s around t so it is not missed between those samples.
      const smear = r > HAZARD_TUNE.kartRadius + 0.01 ? D.planSmear : 0;
      const q = h._pose || (h._pose = {});
      for (let k = smear ? -1 : 0; k <= (smear ? 1 : 0); k++) {
        chandelierPose(h, t + k * smear, q);
        // the ring's slab (centre ± ringHalf) against the kart's (up .. up + kartTop)
        if (q.height - D.ringHalf > up + D.kartTop || q.height + D.ringHalf < up) continue;
        const dl = lat - q.lat;
        if (along * along + dl * dl >= R * R) continue;
        const hit = h._hit || (h._hit = { type: 'chandelier', effect: 'knock', strength: 1.4, side: 0, hazard: h });
        hit.side = q.omega > 0 ? -1 : 1;          // shoved along the swing (toward -side)
        return hit;
      }
      return null;
    },
    extent(h) { return h.radius; },
    state(h, t) {
      const D = HAZARD_TUNE.chandelier, q = chandelierPose(h, t, {});
      q.low = q.height - D.ringHalf < D.kartTop;
      return q;
    },
  },

  // ---- v5: the Portcullis Run's dropping gate leaves
  portcullis: {
    hit(h, t, along, lat, up = 0, r = HAZARD_TUNE.kartRadius) {
      const G = HAZARD_TUNE.portcullis;
      if (Math.abs(along) >= G.depth / 2 + r || lat <= h.latA - r || lat >= h.latB + r) return null;
      const bottom = portcullisBottom(hazardPhase(h, t));
      return bottom < G.dangerHeight && up < bottom + 1.2 ? 'crush' : null;
    },
    extent() { return HAZARD_TUNE.portcullis.depth / 2; },
    state(h, t) {
      const G = HAZARD_TUNE.portcullis, p = hazardPhase(h, t), bottom = portcullisBottom(p);
      return { p, bottom, rattling: p >= G.rattle0 && p < G.slam0, danger: bottom < G.dangerHeight };
    },
  },
};

/**
 * Build the palace's hazard set (Track instance with def.hazards).
 *
 * Rows: hazards whose defs share a `row` id (the lava curtains, the geyser
 * field, the chandeliers, the portcullis gates) are one room for the CPU
 * look-ahead: ahead() returns a single planning record for the whole row
 * ({ s, extent, reach0, reach1, index, type: 'row', row, members }), so
 * ai.js plans ONE line through every hazard of the room (it tests hz.hitAt
 * over the whole stretch) instead of the nearest hazard only, which left no
 * time to change lanes between hazards 12-16 m apart. Hits, rendering and
 * track-check use the real hazards (set.list) as before. The belts (a push,
 * never a hit) are left out of the look-ahead.
 */
export function createHazards(track, { time = 0 } = {}) {
  const hz = makeHazardSet(track, CASTLE_KINDS, { time, checkMode: 'frame', theme: 'castle' });
  const rows = new Map();
  for (const h of hz.list) {
    if (!h.row) continue;
    let r = rows.get(h.row);
    if (!r) rows.set(h.row, (r = { members: [] }));
    r.members.push(h);
  }
  const L = track.length;
  const records = [], inRow = new Set();
  for (const [id, r] of rows) {
    // span along the track (members sit within a few tens of metres: unwrap around the first)
    const s0 = r.members[0].s;
    let a = Infinity, b = -Infinity;
    for (const h of r.members) {
      const d = track.deltaS(s0, h.s);
      a = Math.min(a, d + h.reach0); b = Math.max(b, d + h.reach1);
    }
    const half = (b - a) / 2;
    records.push({
      type: 'row', row: id, members: r.members, index: r.members[0].index,
      s: ((s0 + (a + b) / 2) % L + L) % L, extent: half, reach0: -half, reach1: half,
    });
    for (const h of r.members) inRow.add(h);
  }
  hz.ahead = (s, dist) => {
    const out = [];
    const R = HAZARD_TUNE.kartRadius;
    for (const h of hz.list) {
      if (inRow.has(h) || h.type === 'belt') continue;      // belts never hit: nothing to plan
      const d = track.deltaS(s, h.s);
      if (d >= -h.reach1 - R && d <= dist - h.reach0) out.push(h);
    }
    for (const r of records) {
      const d = track.deltaS(s, r.s);
      if (d >= -r.reach1 - R && d <= dist - r.reach0) out.push(r);
    }
    return out;
  };
  hz.rows = records;
  return hz;
}
