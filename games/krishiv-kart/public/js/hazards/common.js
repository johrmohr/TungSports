// Shared machinery of the course-hazard sets (SPEC §16.1). Node-safe, pure:
// a hazard's state is a function of its def and the race clock only, so the
// game, the headless sim, the CPU look-ahead and the world renderers agree.
//
// A theme module (hazards/<theme>.js) describes its hazard *kinds* and builds
// its set with makeHazardSet(track, KINDS, opts):
//
//   const KINDS = {
//     crab: {
//       // REQUIRED. Is a kart circle (radius r) at `along` m ahead of the hazard's
//       // s (negative = behind), track lateral `lat`, `up` m above the road, hit
//       // at time t? → null | 'type' | { type, effect: 'tumble'|'spin'|'knock'|'slow', strength?, side?, lateral?, from? }
//       hit(h, t, along, lat, up, r) { ... },
//       // REQUIRED. Reach along the track: a number e (= [-e, e] around h.s) or [a, b] (a <= 0 <= b).
//       extent(h) { return h.radius; },
//       state(h, t) { return { ... }; },      // optional: rendering / debugging state
//       resolve(h, track) {},                 // optional: derive extra fields once (h has s, len, lateral, x/y/z, frame)
//       push(h, t, along, lat, up) { return 0; },   // optional: along-track m/s (conveyor belts)
//       soft(h, t, along, lat) { return 0; },       // optional: 0..1 cost for the AI (wet / slow areas)
//     },
//   };
//   export function createHazards(track, opts) { return makeHazardSet(track, KINDS, opts); }
//
// Hazard defs (track def `hazards: [...]`) are { type, u | f | s, lateral, ... }
// for a point hazard or { type, u0/u1 | f0/f1 | s0/s1, ... } for a band; each
// is resolved to { ...def, index, s, len, lateral, x, y, z, tx, tz, rx, rz, yaw,
// reach0, reach1, extent } (len = band length, 0 for points; x/y/z = the
// road point at (s, lateral); tx/tz tangent, rx/rz right at s).
//
// The set: { list, time, driven, theme, update(dt), setTime(t), reset(t),
//   stateAt(h, t), hitOne(h, t, along, lat, up, r), hitAt(s, lat, t, up, r),
//   hitAtWorld(x, y, z, t, r), check(kart), ahead(s, dist),
//   pushAt(kart) (only if a kind has push), softAt(s, lat, t) (only if a kind has soft) }.
// check(kart) respects kart.isHittable() and skips finished karts; checkMode
// 'proj' (default) tests the kart's own track projection, 'frame' (the v4
// palace behaviour) projects onto each hazard's local straight frame.

import { KART } from '../config.js';

export const frac = (x) => x - Math.floor(x);
export const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** Cycle position 0..1 of a periodic hazard ({ period, phase }) at time t. */
export const cyclePhase = (h, t) => frac(t / h.period + (h.phase || 0));

/** Arc length of a def key: { s } | { f } (lap fraction) | { u } (track.sOfU). */
export function sOfKey(track, d, key = '') {
  if (typeof track.sOfKey === 'function') return track.sOfKey(d, key);
  const s = d['s' + key], f = d['f' + key], u = d['u' + key];
  if (Number.isFinite(s)) return track.wrapS(s);
  if (Number.isFinite(f)) return track.wrapS(f * track.length);
  return track.sOfU(Number.isFinite(u) ? u : 0);
}

const isBand = (d) => d.u0 !== undefined || d.f0 !== undefined || d.s0 !== undefined;

/** Resolve one hazard def onto a track (see the header). */
export function resolveHazard(track, d, index, kind) {
  let s, len = 0;
  if (isBand(d)) {
    s = sOfKey(track, d, '0');
    len = track.forwardDistance(s, sOfKey(track, d, '1'));
  } else s = sOfKey(track, d);
  const lateral = d.lateral || 0;
  const f = track.frameAt(s);
  const p = track.pointAt(s, lateral);
  const h = {
    ...d, index, s, len, lateral,
    x: p.x, y: f.y, z: p.z,                       // world position of the centre / pivot (road height)
    tx: f.tangent.x, tz: f.tangent.z, rx: f.right.x, rz: f.right.z, yaw: f.yaw,
  };
  const e = kind && kind.extent ? kind.extent(h) : 0;
  if (Array.isArray(e)) { h.reach0 = Math.min(0, e[0]); h.reach1 = Math.max(0, e[1]); }
  else { const v = Math.abs(Number(e) || 0); h.reach0 = -v; h.reach1 = v; }
  h.extent = Math.max(-h.reach0, h.reach1);
  if (kind && kind.resolve) kind.resolve(h, track);
  return h;
}

/**
 * Build a hazard set from track.def.hazards (or opts.defs) with a kinds table.
 *   opts: { time = 0, defs, checkMode = 'proj' | 'frame', theme, kartRadius = KART.radius }
 * Defs of a type the table does not know are skipped (warned once).
 */
export function makeHazardSet(track, kinds, { time = 0, defs = null, checkMode = 'proj', theme = '', kartRadius = KART.radius } = {}) {
  const src = defs || (track && track.def && track.def.hazards) || [];
  const list = [];
  const unknown = new Set();
  src.forEach((d) => {
    const kind = d && kinds[d.type];
    if (!kind) { if (d && !unknown.has(d.type)) { unknown.add(d.type); console.warn(`[hazards] ${theme || 'theme'}: unknown hazard type '${d && d.type}' skipped`); } return; }
    list.push(resolveHazard(track, d, list.length, kind));
  });
  const R = kartRadius;
  const proj = {};
  const hitOne = (h, t, along, lat, up = 0, r = R) => {
    if (along < h.reach0 - r - 1 || along > h.reach1 + r + 1) return null;
    return kinds[h.type].hit(h, t, along, lat, up, r);
  };
  const anyPush = list.some((h) => typeof kinds[h.type].push === 'function');
  const anySoft = list.some((h) => typeof kinds[h.type].soft === 'function');

  // The kart's road height and track coordinates (its own projection when fresh).
  const kartFrame = (kart) => {
    const p = kart.position;
    if (kart.proj && Number.isFinite(kart.proj.height) && Number.isFinite(kart.proj.s)) return kart.proj;
    track.project(p, kart.hint ?? -1, proj);
    return proj;
  };

  const hz = {
    list,
    time,
    theme,
    kinds,
    checkMode,
    driven: false,           // true once someone calls update() / setTime() (the world kit then stops ticking it)
    fx: null,                // per-kart effect state of hazards.js stepCourseHazards (knock / slow)
    update(dt) { if (Number.isFinite(dt) && dt > 0) hz.time += dt; hz.driven = true; },
    setTime(t) { if (Number.isFinite(t)) hz.time = t; hz.driven = true; },
    reset(t = 0) { hz.time = t; hz.fx = null; },
    stateAt(h, t = hz.time) { const k = kinds[h.type]; return k && k.state ? k.state(h, t) : {}; },
    hitOne,

    // Hit test in track coordinates (s, lateral) at time t, `up` m above the road.
    hitAt(s, lat, t = hz.time, up = 0, r = R) {
      for (const h of list) {
        const hit = hitOne(h, t, track.deltaS(h.s, s), lat, up, r);
        if (hit) return hit;
      }
      return null;
    },

    // Hit test in world space (x, z, height y) at time t: projects onto each
    // hazard's own (straight) frame — exact on straights, which is where they sit.
    hitAtWorld(x, y, z, t = hz.time, r = R) {
      for (const h of list) {
        const dx = x - h.x + h.rx * h.lateral, dz = z - h.z + h.rz * h.lateral;   // from the centreline point at h.s
        const along = dx * h.tx + dz * h.tz;
        if (along < h.reach0 - r - 1 || along > h.reach1 + r + 1) continue;
        const lat = dx * h.rx + dz * h.rz;
        const hit = kinds[h.type].hit(h, t, along, lat, y - h.y, r);
        if (hit) return hit;
      }
      return null;
    },

    // The kart contract: null | type string | { type, effect, strength? }. Respects isHittable().
    check(kart) {
      if (!list.length || !kart || !kart.position) return null;
      if (typeof kart.isHittable === 'function' && !kart.isHittable()) return null;
      if (kart.finished) return null;
      const p = kart.position;
      const pr = kartFrame(kart);
      const up = Math.max(0, p.y - pr.height);
      if (checkMode === 'frame') {
        for (const h of list) {
          const dx = p.x - h.x + h.rx * h.lateral, dz = p.z - h.z + h.rz * h.lateral;
          const along = dx * h.tx + dz * h.tz;
          if (along < h.reach0 - R - 1 || along > h.reach1 + R + 1) continue;
          const lat = dx * h.rx + dz * h.rz;
          const hit = kinds[h.type].hit(h, hz.time, along, lat, up, R);
          if (hit) return hit;
        }
        return null;
      }
      for (const h of list) {
        const hit = hitOne(h, hz.time, track.deltaS(h.s, pr.s), pr.lateral, up, R);
        if (hit) return hit;
      }
      return null;
    },

    // Hazards whose reach overlaps [s, s + dist] ahead (CPU look-ahead).
    ahead(s, dist) {
      const out = [];
      for (const h of list) {
        const d = track.deltaS(s, h.s);          // signed: + = ahead
        if (d >= -h.reach1 - R && d <= dist - h.reach0) out.push(h);
      }
      return out;
    },
  };

  if (anyPush) {
    // Along-track push (m/s) on a grounded kart (conveyor belts), 0 elsewhere.
    hz.pushAt = (kart) => {
      if (!kart || !kart.position || kart.finished) return 0;
      const pr = kartFrame(kart), up = Math.max(0, kart.position.y - pr.height);
      let v = 0;
      for (const h of list) {
        const k = kinds[h.type];
        if (!k.push) continue;
        const along = track.deltaS(h.s, pr.s);
        if (along < h.reach0 - R || along > h.reach1 + R) continue;
        v += Number(k.push(h, hz.time, along, pr.lateral, up)) || 0;
      }
      return v;
    };
  }
  if (anySoft) {
    // AI cost 0..1 of slow / wet areas at (s, lat, t) (max over the hazards).
    hz.softAt = (s, lat, t = hz.time) => {
      let c = 0;
      for (const h of list) {
        const k = kinds[h.type];
        if (!k.soft) continue;
        const along = track.deltaS(h.s, s);
        if (along < h.reach0 - R - 1 || along > h.reach1 + R + 1) continue;
        c = Math.max(c, Number(k.soft(h, t, along, lat)) || 0);
      }
      return c;
    };
  }
  return hz;
}
