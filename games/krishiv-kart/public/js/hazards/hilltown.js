// Monte Mozzarella course set pieces (theme 'hilltown', SPEC §16.1;
// notes/research-v5-tracks.md §B2 + Part C4-C6). Node-safe and pure: every
// state is a function of the hazard def and the race clock t, so the game,
// the headless sim, the CPU look-ahead (hitAt at arrival times) and the world
// renderer (world-monte.js, via stateAt / the helpers below) all agree.
//
// Kinds (track-def-monte.js `hazards`; u + lateral as everywhere, + = right):
//   mover  { u, lateral, length, speed, period, phase, weave }: Via Vespa scooter
//          traffic riding WITH the racers. Cycle τ = frac(t / period + phase)
//          · period: the scooter rides the lane from along 0 to `length` at
//          `speed` m/s (lateral + weave·sin(along / 9)), then turns off into
//          an alley; the next one rolls out of the entry alley in the last
//          second of the cycle with a horn toot (telegraph, visual only —
//          no hit before along 0). Hit: a box along ±(1.1 + r) × lateral
//          ±(0.55 + r), up < 1.5 m → knock (shoved away from the scooter).
//   jet    { u, lats[], radius, period, phase, dphase, effect }: Piazza Alta's
//          dancing fountain. Jet k runs on p = frac(t / period + phase +
//          k·dphase): idle < 0.6, bubbling 0.6-0.8 (telegraph: rings and a
//          gurgle), erupting >= 0.8 (6 m tall, cannot be jumped). Hit: a
//          circle radius + r while erupting → knock (popped away from the jet).
//          (The brief's 1.0 s eruption measured a 42 % Hard win rate in the
//          sim fairness check, outside its 10-40 % band; 0.8 s: 29 %.)
//   wheel  { u, from, period, phase, count, speed, radius, travel }: Cheese Run
//          wheels rolling across the road from side `from` (-1 = left, the
//          dairy) over `travel` m at `speed` m/s, `count` per period. Before
//          they reach the bank they roll down a chute from the dairy (visual
//          only, WHEEL.chute s), after the far bank they roll on down the hill.
//          Hit: a box along ±(width / 2 + r) × lateral ±(radius + 0.6 r),
//          up < 2·radius → tumble.
// Effects are applied by hazards.js applyHazardHit (identically in the game
// and the sim); stars / Beer Rockets / just-hit karts pass through.

import { makeHazardSet, cyclePhase, frac, smooth } from './common.js';

export const HILLTOWN_TUNE = {
  mover: {
    halfLen: 1.1, halfWidth: 0.55, height: 1.5,   // hit box (+ kart radius), m
    wave: 9,                                      // weave wavelength factor: lat += weave·sin(along / wave)
    enter: 1.0,                                   // s: rolls out of the entry alley (horn) before along 0
    exit: 1.0,                                    // s: turns into the exit alley after along `length`
    alley: 7.5,                                   // m: alley mouth this far before / after the ride
  },
  jet: { bubble0: 0.6, erupt0: 0.8, height: 6 },   // idle 2.4 s, bubbling 0.8 s, erupting 0.8 s (4 s period)
  wheel: { width: 1.4, chute: 2.0, downhill: 2.5 },
};

const lerp = (a, b, f) => a + (b - a) * f;

// ------------------------------------------------------------------ mover (scooter traffic)

/** The riding scooter of a mover lane at time t: { along, lat, tau } or null (between scooters). */
export function moverPos(h, t) {
  const tau = cyclePhase(h, t) * h.period;
  const a = tau * h.speed;
  if (a > h.length) return null;
  return { along: a, lat: h.lateral + (h.weave || 0) * Math.sin(a / HILLTOWN_TUNE.mover.wave), tau };
}

/**
 * Every scooter of a mover lane to draw at time t (at most two): the one
 * riding, the one turning off into the exit alley, the one rolling out of the
 * entry alley (horn). Fills `out` with { along, lat, heading (rad, 0 = along
 * the track, + = toward the right), phase: 'enter'|'ride'|'exit', u (0..1
 * through the phase) } and returns the count. `side` = the lane's side (±1).
 */
export function moverVisuals(h, t, out = []) {
  const M = HILLTOWN_TUNE.mover;
  const side = Math.sign(h.lateral) || -1;
  const ride = h.length / h.speed;
  const tau = cyclePhase(h, t) * h.period;
  let n = 0;
  const push = (o) => { out[n] = Object.assign(out[n] || {}, o); n++; };
  const alleyLat = side * (Number.isFinite(h.alleyLat) ? h.alleyLat : Math.abs(h.lateral) + 10);
  // the scooter of this cycle: riding, or turning off into the exit alley
  if (tau <= ride) {
    const a = tau * h.speed;
    const lat = h.lateral + (h.weave || 0) * Math.sin(a / M.wave);
    const dl = (h.weave || 0) * Math.cos(a / M.wave) / M.wave;          // d lat / d along
    push({ along: a, lat, heading: Math.atan(dl), phase: 'ride', u: tau / ride });
  } else if (tau <= ride + M.exit) {
    const u = (tau - ride) / M.exit;
    const a0 = h.length, lat0 = h.lateral + (h.weave || 0) * Math.sin(a0 / M.wave);
    // a quarter turn into the alley mouth at along length + alley (slowing down)
    const e = smooth(u);
    const along = a0 + M.alley * Math.sin(e * Math.PI / 2);
    const lat = lerp(lat0, alleyLat, 1 - Math.cos(e * Math.PI / 2));
    push({ along, lat, heading: side * e * Math.PI / 2 * 0.9, phase: 'exit', u });
  }
  // the next scooter rolling out of the entry alley (the last `enter` s of the cycle)
  if (tau >= h.period - M.enter) {
    const u = (tau - (h.period - M.enter)) / M.enter;
    const e = smooth(u);
    const along = -M.alley * Math.cos(e * Math.PI / 2);
    const lat = lerp(alleyLat, h.lateral, Math.sin(e * Math.PI / 2));
    push({ along, lat, heading: -side * (1 - e) * Math.PI / 2 * 0.9, phase: 'enter', u });
  }
  return n;
}

// ------------------------------------------------------------------ jet (dancing fountain)

/** Jet k's cycle position 0..1 at time t. */
export function jetPhase(h, k, t) { return frac(t / h.period + (h.phase || 0) + k * (h.dphase || 0)); }

/** Jet k at time t: { p, bubbling, erupting, rise (0..1 column height) }. */
export function jetState(h, k, t) {
  const J = HILLTOWN_TUNE.jet;
  const p = jetPhase(h, k, t);
  const erupting = p >= J.erupt0;
  const bubbling = !erupting && p >= J.bubble0;
  // the column shoots up in the first 15 % of the eruption and drops in the last 12 %
  const q = erupting ? (p - J.erupt0) / (1 - J.erupt0) : 0;
  const rise = erupting ? Math.min(1, q / 0.15) * (q > 0.88 ? 1 - (q - 0.88) / 0.12 * 0.7 : 1) : 0;
  return { p, bubbling, erupting, rise, b: bubbling ? (p - J.bubble0) / (J.erupt0 - J.bubble0) : 0 };
}

// ------------------------------------------------------------------ wheel (cheese wheels)

/**
 * Wheels of a wheel row at time t (on the road / bank only): [{ lat, tau, k }].
 * τ = frac(t / period + phase + k / count) · period; on the road while τ·speed <= travel.
 */
export function wheelsAt(h, t, out = []) {
  out.length = 0;
  const n = h.count || 1;
  for (let k = 0; k < n; k++) {
    const tau = frac(t / h.period + (h.phase || 0) + k / n) * h.period;
    const d = tau * h.speed;
    if (d > h.travel) continue;
    out.push({ lat: h.from * h.travel / 2 - h.from * d, tau, k });
  }
  return out;
}

/**
 * Every wheel of a row to draw at time t, including the chute run before the
 * bank (phase 'chute', u 0..1) and the roll down the hill after it ('downhill').
 * Fills `out` with { k, phase, u, lat (road phase), tau } and returns the count.
 */
export function wheelVisuals(h, t, out = []) {
  const W = HILLTOWN_TUNE.wheel, n = h.count || 1;
  const cross = h.travel / h.speed;
  let m = 0;
  for (let k = 0; k < n; k++) {
    // τ = time since this wheel reached the bank, for the previous, current and next cycle's wheel
    const base = frac(t / h.period + (h.phase || 0) + k / n) * h.period;
    for (let c = 1; c >= -1; c--) {
      const tau = base + c * h.period;
      let o = null;
      if (tau >= 0 && tau <= cross) o = { phase: 'road', u: tau / cross, lat: h.from * h.travel / 2 - h.from * tau * h.speed };
      else if (tau > cross && tau <= cross + W.downhill) o = { phase: 'downhill', u: (tau - cross) / W.downhill, lat: -h.from * h.travel / 2 };
      else if (tau < 0 && tau >= -W.chute) o = { phase: 'chute', u: 1 + tau / W.chute, lat: h.from * h.travel / 2 };
      if (o) { o.k = k; o.c = c; o.tau = tau; out[m] = Object.assign(out[m] || {}, o); m++; }
    }
  }
  return m;
}

// ------------------------------------------------------------------ kinds

export const HILLTOWN_KINDS = {
  mover: {
    hit(h, t, along, lat, up, r) {
      const M = HILLTOWN_TUNE.mover;
      if (up > M.height) return null;
      const m = moverPos(h, t);
      if (!m) return null;
      if (Math.abs(along - m.along) < M.halfLen + r && Math.abs(lat - m.lat) < M.halfWidth + r) {
        return { type: 'scooter', effect: 'knock', lateral: m.lat, hazard: h };
      }
      return null;
    },
    extent(h) { const M = HILLTOWN_TUNE.mover; return [-M.halfLen - 0.1, h.length + M.halfLen + 0.1]; },
    state(h, t) { return { ride: moverPos(h, t) }; },
  },
  jet: {
    hit(h, t, along, lat, up, r) {
      const J = HILLTOWN_TUNE.jet;
      if (up > J.height) return null;
      const rr = (h.radius + r) * (h.radius + r);
      if (along * along > rr) return null;
      for (let k = 0; k < h.lats.length; k++) {
        if (jetPhase(h, k, t) < J.erupt0) continue;
        const dl = lat - h.lats[k];
        if (along * along + dl * dl < rr) {
          return { type: 'fountain', effect: h.effect || 'knock', lateral: h.lats[k], from: h.jets ? h.jets[k] : undefined, hazard: h };
        }
      }
      return null;
    },
    extent(h) { return h.radius; },
    resolve(h, track) {
      // world positions of the jets (the knock shoves away from the one that hit)
      h.jets = h.lats.map((lat) => { const p = track.pointAt(h.s, lat); return { x: p.x, z: p.z }; });
    },
    state(h, t) { return { jets: h.lats.map((_, k) => jetState(h, k, t)) }; },
  },
  wheel: {
    hit(h, t, along, lat, up, r) {
      const W = HILLTOWN_TUNE.wheel;
      if (up > 2 * h.radius || Math.abs(along) >= W.width / 2 + r) return null;
      const n = h.count || 1;
      for (let k = 0; k < n; k++) {
        const tau = frac(t / h.period + (h.phase || 0) + k / n) * h.period;
        const d = tau * h.speed;
        if (d > h.travel) continue;
        const wl = h.from * h.travel / 2 - h.from * d;
        if (Math.abs(lat - wl) < h.radius + r * 0.6) return { type: 'cheese', effect: 'tumble', lateral: wl, hazard: h };
      }
      return null;
    },
    extent() { return HILLTOWN_TUNE.wheel.width / 2; },
    state(h, t) { return { wheels: wheelsAt(h, t, []) }; },
  },
};

// Placement rules for tools/track-check.mjs (research-v5-tracks.md A3.6 / D2):
// lateral movers may sit on gentle grades (the Cheese Run wheels: <= 9 %).
HILLTOWN_KINDS.wheel.maxGrade = 0.09;

/** Build this theme's hazard set (Track instance with def.hazards). */
export function createHazards(track, opts = {}) {
  return makeHazardSet(track, HILLTOWN_KINDS, { ...opts, theme: 'hilltown' });
}
