// Laguna Beach course set pieces (theme 'beach', SPEC §16.1,
// notes/research-v5-tracks.md §B3 + §C). Node-safe and deterministic: every
// piece is a pure function of its def and the race clock t, so the game, the
// headless sim, the CPU look-ahead (hitAt) and the world renderer
// (world-laguna.js) agree on where the danger is. Built through
// hazards/common.js makeHazardSet ('proj' check: the kart's own projection).
//
// Kinds (track-def-laguna.js `hazards`; u / f / s keys as everywhere, + lateral = right = the sea):
//
//   jet    tide-pool blowholes { u, lats: [lat...], radius, period, phase, dphase, effect = 'slow', strength }
//          Hole k cycles on p = frac(t/period + phase + k·dphase): idle 0-55 %,
//          bubbling + hissing 55-75 % (the telegraph), spouting 75-100 %. A kart
//          inside the spout (radius + kart radius, < 6 m up) gets soaked:
//          `slow` (strength 0.25). The inland half of the shelf is always dry.
//
//   surge  shore-break waves { u0, u1, side: +1 (sea on the right), reachLap1, reach,
//          rampT: [t0, t1], period, phase, strength = 0.3, push = 2 }
//          One wave per period: calm 0-45 %, build 45-65 % (the lip curls offshore,
//          foam runs up the sand to the road edge, the surf roar swells), wash-in
//          65-70 %, hold 70-85 %, recede 85-100 %. The water covers the band from
//          the sea edge inward to `reach` × the road width; the tide rises from
//          reachLap1 to reach between rampT[0] and rampT[1] s of race time (lap 1
//          teaches it, laps 2-3 test it). Wet = slow 0.3 + a 2 m/s shove toward
//          land. There is always a dry lane on the inland side (reach ≤ 0.6).
//
//   lob    volleyball spikes { u, spots: [{ lat, along, roll }], period, flight, phase, from }
//          Every `period` s a ball is spiked from the courts (the sea side) and
//          lands `flight` s later on the next spot in turn; it is dangerous from
//          0.1 s before landing to 0.5 s after (it bounces and rolls roll·4 m/s,
//          -1 = inland), radius 0.8 + kart radius, < 1.5 m up: `knock` (a bump
//          away from the ball, no item loss). The telegraph is a shadow ring on
//          the landing spot that shrinks during the flight + the smack of the serve.
//
// Every kind also gives the world renderer its state (stateAt) and the AI a
// soft cost (softAt: 1 where wet) next to the hard look-ahead (hitAt).
// track-check treats kinds with soft() as soft areas (a dash pad may sit on a
// wet lane) and tests a surge (rampT) at full tide too (t0 100-116 s).

import { makeHazardSet, frac, smooth } from './common.js';

const lerp = (a, b, f) => a + (b - a) * f;

export const BEACH_TUNE = {
  jet: { bubble0: 0.55, erupt0: 0.75, height: 6, strength: 0.25, spout: 5.5 },
  surge: { build0: 0.45, wash0: 0.65, full0: 0.70, recede0: 0.85, depth: 0.8, strength: 0.3, push: 2 },
  lob: { before: 0.1, after: 0.5, roll: 4.0, radius: 0.8, top: 1.5, arc: 9.5 },
};

// ------------------------------------------------------------------ jet (blowholes)

/** Cycle position of blowhole k (0..1). */
export function jetPhase(h, t, k) { return frac(t / h.period + (h.phase || 0) + k * (h.dphase || 0)); }

/** Blowhole k at t: { p, bubbling, erupting, amt (0..1 spout height envelope), foam (0..1 bubbling) }. */
export function jetState(h, t, k, out = {}) {
  const J = BEACH_TUNE.jet, p = jetPhase(h, t, k);
  out.p = p;
  out.bubbling = p >= J.bubble0 && p < J.erupt0;
  out.erupting = p >= J.erupt0;
  out.foam = out.bubbling ? smooth((p - J.bubble0) / (J.erupt0 - J.bubble0)) : out.erupting ? 1 : 0;
  // the spout shoots up fast, holds, and collapses in the last 15 % of the eruption
  const e = (p - J.erupt0) / (1 - J.erupt0);
  out.amt = out.erupting ? Math.min(smooth(e / 0.18), 1 - smooth((e - 0.82) / 0.18)) : 0;
  return out;
}

// ------------------------------------------------------------------ surge (shore-break waves)

/** Wave phase name + local 0..1 progress at t (rendering). */
export function surgePhase(h, t) {
  const S = BEACH_TUNE.surge, p = frac(t / h.period + (h.phase || 0));
  if (p < S.build0) return { p, phase: 'calm', k: p / S.build0 };
  if (p < S.wash0) return { p, phase: 'build', k: (p - S.build0) / (S.wash0 - S.build0) };
  if (p < S.full0) return { p, phase: 'wash', k: (p - S.wash0) / (S.full0 - S.wash0) };
  if (p < S.recede0) return { p, phase: 'hold', k: (p - S.full0) / (S.recede0 - S.full0) };
  return { p, phase: 'recede', k: (p - S.recede0) / (1 - S.recede0) };
}

/** Full-tide reach (share of the road width) at race time t. */
export function surgeTide(h, t) {
  const [t0, t1] = h.rampT || [0, 1];
  return lerp(h.reachLap1 ?? h.reach, h.reach, smooth((t - t0) / Math.max(1e-6, t1 - t0)));
}

/** Reach of the water now (share of the road width from the sea edge; 0 = not on the road). */
export function surgeReach(h, t) {
  const S = BEACH_TUNE.surge, p = frac(t / h.period + (h.phase || 0));
  const full = surgeTide(h, t);
  if (p < S.wash0) return 0;
  if (p < S.full0) return full * smooth((p - S.wash0) / (S.full0 - S.wash0));
  if (p < S.recede0) return full;
  return full * (1 - smooth((p - S.recede0) / (1 - S.recede0)));
}

/** Waterline lateral (m) for a reach share (side = +1: water on the right of it). */
export function surgeEdge(h, reach) { return h.side * h.hw - h.side * reach * 2 * h.hw; }

// ------------------------------------------------------------------ lob (volleyball spikes)

/**
 * The spike in play at t: { n (spike number), spot, tau (s since the serve),
 * land (0..1 flight progress), lat / along (ball now, on the road after
 * landing), danger }.
 */
export function lobState(h, t, out = {}) {
  const L = BEACH_TUNE.lob, n = h.spots.length;
  const x = t / h.period + (h.phase || 0);
  const k = Math.floor(x);
  const tau = (x - k) * h.period;
  const spot = h.spots[((k % n) + n) % n];
  out.n = k; out.spot = spot; out.tau = tau;
  out.land = Math.min(1, tau / h.flight);
  const roll = Math.max(0, tau - h.flight) * L.roll * (spot.roll ?? -1);
  out.lat = spot.lat + roll;
  out.along = spot.along || 0;
  out.danger = tau >= h.flight - L.before && tau <= h.flight + L.after;
  return out;
}

// ------------------------------------------------------------------ kinds

export const BEACH_KINDS = {
  jet: {
    resolve(h) {
      h.hits = (h.lats || []).map(() => ({ type: 'blowhole', effect: h.effect || 'slow', strength: h.strength ?? BEACH_TUNE.jet.strength }));
    },
    hit(h, t, along, lat, up, r) {
      if (up > BEACH_TUNE.jet.height) return null;
      const rr = (h.radius + r) * (h.radius + r);
      for (let k = 0; k < h.lats.length; k++) {
        if (jetPhase(h, t, k) < BEACH_TUNE.jet.erupt0) continue;
        const dl = lat - h.lats[k];
        if (along * along + dl * dl < rr) return h.hits[k];
      }
      return null;
    },
    extent(h) { return h.radius; },
    state(h, t) { return { jets: h.lats.map((_, k) => jetState(h, t, k)) }; },
    soft(h, t, along, lat) {
      for (let k = 0; k < h.lats.length; k++) {
        const p = jetPhase(h, t, k);
        if (p < BEACH_TUNE.jet.bubble0) continue;
        const dl = lat - h.lats[k];
        if (along * along + dl * dl < (h.radius + 1.1) ** 2) return p >= BEACH_TUNE.jet.erupt0 ? 1 : 0.5;
      }
      return 0;
    },
  },

  surge: {
    resolve(h, track) {
      h.side = h.side === -1 ? -1 : 1;
      h.hw = track.frameAt(h.s + h.len / 2).halfWidth;
      h.hitObj = { type: 'wave', effect: 'slow', strength: h.strength ?? BEACH_TUNE.surge.strength, push: h.push ?? BEACH_TUNE.surge.push, side: h.side };
    },
    hit(h, t, along, lat, up, r) {
      if (along < 0 || along > h.len || up > BEACH_TUNE.surge.depth) return null;
      const reach = surgeReach(h, t);
      if (reach <= 0) return null;
      const edge = surgeEdge(h, reach);
      const wet = h.side < 0 ? lat - r < edge : lat + r > edge;
      return wet ? h.hitObj : null;
    },
    extent(h) { return [0, h.len]; },
    state(h, t) { const ph = surgePhase(h, t); return { ...ph, reach: surgeReach(h, t), tide: surgeTide(h, t) }; },
    soft(h, t, along, lat) {
      if (along < 0 || along > h.len) return 0;
      const reach = Math.max(surgeReach(h, t), surgePhase(h, t).phase === 'build' ? surgeTide(h, t) * 0.5 : 0);
      if (reach <= 0) return 0;
      const edge = surgeEdge(h, reach);
      return (h.side < 0 ? lat - 1.1 < edge : lat + 1.1 > edge) ? 1 : 0;
    },
  },

  lob: {
    resolve(h) {
      h.from = h.from === -1 ? -1 : 1;
      h.hitObj = { type: 'volleyball', effect: 'knock', strength: h.strength ?? 1, lateral: 0 };
      h._st = {};
    },
    hit(h, t, along, lat, up, r) {
      const L = BEACH_TUNE.lob;
      if (up > L.top) return null;
      const st = lobState(h, t, h._st);
      if (!st.danger) return null;
      const dl = lat - st.lat, da = along - st.along;
      if (da * da + dl * dl >= (L.radius + r) * (L.radius + r)) return null;
      h.hitObj.lateral = st.lat;
      return h.hitObj;
    },
    extent(h) {
      let a = 0, b = 0;
      for (const sp of h.spots) { a = Math.min(a, sp.along || 0); b = Math.max(b, sp.along || 0); }
      const m = BEACH_TUNE.lob.radius + 0.5;
      return [a - m, b + m];
    },
    state(h, t) { return lobState(h, t); },
  },
};

/** Build this theme's hazard set (Track instance with def.hazards). */
export function createHazards(track, opts = {}) {
  return makeHazardSet(track, BEACH_KINDS, { ...opts, theme: 'beach' });
}
