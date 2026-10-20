// Track sanity checks (SPEC §3 / §14.4 / §15.3): closure, projection
// round-trips, corner radii, width rules, features on the road, kicker
// landings, loop self-overlap, the v4 layout rules and course hazards.
//
//   node tools/track-check.mjs                 # every track in tracks.js
//   node tools/track-check.mjs --track monte   # one track
//   node tools/track-check.mjs --def my-def.mjs  # a def module not registered yet (its first export
//                                                # with `segments` or `path`; strict v4 rules)
//
// v4 rules (tracks added in v4; info lines for the v3 courses Breezy and
// Monte, whose spec'd layouts predate them): every arc R >= 22 m, walls of
// two separate parts of the loop >= 16 m apart, tight-turn exits >= 9.5 m,
// length 950-1250 m, 4 item rows, 3-4 dash pads, 1-2 ramps, net turn ±360°.
// Hazards (def.hazards, built through the hazards.js registry for the
// track's theme): each on a flat straight, inside the road, >= 10 m from item
// rows / pads / ramps / corners, and for every entry time and speed (18-36 m/s)
// some straight line gets through clean.
// Path-mode defs (def.path, SPEC §16.1) are checked the same way: net turn
// from the sampled headings, radii from the curvature, tight-turn exits from
// the stretches tighter than R30, "on a straight" = |curvature| < 1/100 around
// the hazard. Coins (def.coins → track.coins) must sit on the road.
// v5 (SPEC §16.1): lap 1300-1600 m is accepted next to the v4 950-1250 m
// window (and reported as info) until V5.enforce is switched on — the track
// agents flip it once every track meets it; 4-5 item rows.
//
// Exit code 1 if any check FAILs (informational lines never fail).
import { Track, CURB_WIDTH } from '../public/js/track.js';
import { TRACK_LIST } from '../public/js/tracks.js';
import { KART } from '../public/js/config.js';
import { makeRng } from '../public/js/utils.js';
import { createHazards } from '../public/js/hazards.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; };
const only = opt('track', null);
const defFile = opt('def', null);
let list = only ? TRACK_LIST.filter((t) => t.id === only) : TRACK_LIST;
if (defFile) {
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const mod = await import(pathToFileURL(resolve(defFile)).href);
  const def = [mod.default, ...Object.values(mod)].find((d) => d && typeof d === 'object' && (Array.isArray(d.path) || Array.isArray(d.segments)));
  if (!def) { console.error(`${defFile}: no export with \`segments\` or \`path\``); process.exit(1); }
  list = [{ id: def.id || 'def', def }];
}
if (!list.length) { console.error(`unknown track '${only}' (have: ${TRACK_LIST.map((t) => t.id).join(', ')})`); process.exit(1); }

// v3 limits (SPEC §14.3/§14.4, research-steering-feel R4)
const LIM = {
  closure: 0.1,          // m
  minRadius: 20,         // m (tightest corner)
  minHalfWidth: 8.5,     // m, everywhere
  minOffroad: 2.0,       // m of curb + grass in front of every wall
  exitHalfWidth: 9.5,    // m, out of turns tighter than R30 (info only: Breezy's bridge is a spec'd exception)
  boxEdge: 0.8,          // item boxes at least this far inside the road edge
  padToRamp: 30,         // a kicker needs a dash pad ending this close before it
  overlapGap: 0,         // m between the walls of two separate parts of the loop
  overlapDy: 6,          // ... unless one passes this far above the other
};
// v4 layout rules (SPEC §15.3, notes/research-v4-tracks.md A4)
const V4 = {
  legacy: new Set([]),          // v3 courses whose rules print as info (none left: v5 rebuilt Breezy + Monte to the v4 rules)
  minRadius: 22, overlapGap: 16, exitHalfWidth: 9.5,
  length: [950, 1250], itemRows: 4, pads: [3, 4], ramps: [1, 2],
};
// v5 targets (SPEC §16.1; notes/research-v5-tracks.md D2): enforce = true makes the v5 lap window the only one
const V5 = { enforce: true, length: [1300, 1600], itemRows: [4, 5] };   // v5: every track is long now (flipped by the palace agent)
const KART_RADIUS = KART.radius;

let failures = 0;
const f1 = (x) => x.toFixed(1), f2 = (x) => x.toFixed(2);
function check(cond, label, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  return cond;
}
// A v4 rule: a check on v4 tracks, an info line on the legacy courses.
let strict = true;
function rule(cond, label, detail) {
  if (strict) return check(cond, label, detail);
  console.log(`  info ${cond ? 'meets' : 'misses'} v4 rule: ${label}${detail ? ' — ' + detail : ''}`);
  return cond;
}

for (const { id, def } of list) {
  const t0 = performance.now();
  const tr = new Track(def);
  if (!tr.theme || tr.id !== id) { tr.id = id; tr.theme = def.theme || 'bay'; }
  const ms = performance.now() - t0;
  const N = tr.N, sp = tr.spacing;
  console.log(`\n== ${id}: ${tr.name} (theme ${tr.theme})`);
  console.log(`  build ${f1(ms)} ms, length ${f1(tr.length)} m, N ${N}, bounds ${JSON.stringify(Object.fromEntries(Object.entries(tr.bounds).map(([k, v]) => [k, +v.toFixed(1)])))}`);
  console.log(`  segments ${tr.segments.map((s) => `${s.index}:${s.s0.toFixed(0)}`).join(' ')}`);
  strict = !V4.legacy.has(id);

  check(tr.closureError < LIM.closure, 'closure', `${tr.closureError.toFixed(4)} m (< ${LIM.closure})`);

  // ---- v4 layout rules
  {
    const n = (a) => (a || []).length;
    // length: the v4 window or (v5, SPEC §16.1) the longer one while the tracks are being
    // rebuilt in parallel; only the v5 window once V5.enforce is on
    const inV4 = tr.length >= V4.length[0] && tr.length <= V4.length[1];
    const inV5 = tr.length >= V5.length[0] && tr.length <= V5.length[1];
    if (V5.enforce) rule(inV5, `length ${V5.length[0]}-${V5.length[1]} m (v5)`, `${f1(tr.length)} m`);
    else rule(inV4 || inV5, `length ${V4.length[0]}-${V4.length[1]} m (v4) or ${V5.length[0]}-${V5.length[1]} m (v5)`, `${f1(tr.length)} m`);
    rule(n(def.itemRows) >= V5.itemRows[0] && n(def.itemRows) <= V5.itemRows[1], `${V5.itemRows[0]}-${V5.itemRows[1]} item rows`, `${n(def.itemRows)}`);
    rule(n(def.boostPads) >= V4.pads[0] && n(def.boostPads) <= V4.pads[1], `${V4.pads[0]}-${V4.pads[1]} dash pads`, `${n(def.boostPads)}`);
    rule(n(def.ramps) >= V4.ramps[0] && n(def.ramps) <= V4.ramps[1], `${V4.ramps[0]}-${V4.ramps[1]} kicker ramps`, `${n(def.ramps)}`);
    if (tr.pathMode) {
      // path mode: the turn summed over the sampled headings, the radius from the curvature
      let turn = 0;
      for (let i = 0; i < N; i++) turn += Math.atan2(Math.sin(tr.yawArr[(i + 1) % N] - tr.yawArr[i]), Math.cos(tr.yawArr[(i + 1) % N] - tr.yawArr[i]));
      turn = (turn * 180) / Math.PI;
      rule(Math.abs(Math.abs(turn) - 360) < 0.5, 'net turn ±360°', `${f2(turn)}° (path mode, ${turn < 0 ? 'clockwise' : 'counter-clockwise'})`);
      let maxC = 0;
      for (let i = 0; i < N; i++) maxC = Math.max(maxC, Math.abs(tr.curv[i]));
      rule(1 / maxC >= V4.minRadius, `every corner radius >= ${V4.minRadius} m`, `min R ${f1(1 / maxC)} (path mode, smoothed curvature)`);
    } else {
      let turn = 0;
      for (const sg of def.segments) if (sg.type === 'arc') turn += (sg.dir === 'right' ? -1 : 1) * sg.angle;
      rule(Math.abs(Math.abs(turn) - 360) < 1e-6, 'net turn ±360°', `${turn}° (${turn < 0 ? 'clockwise' : 'counter-clockwise'})`);
      const minR = Math.min(...def.segments.filter((x) => x.type === 'arc').map((x) => x.radius));
      rule(minR >= V4.minRadius, `every arc radius >= ${V4.minRadius} m`, `min R ${minR}`);
    }
    if (!V5.enforce) console.log(`  info ${inV5 ? 'meets' : 'misses'} the v5 lap target ${V5.length[0]}-${V5.length[1]} m — ${f1(tr.length)} m`);
  }

  // ---- projection round-trips (seeded: deterministic output)
  {
    const rng = makeRng(7);
    const proj = {};
    let maxS = 0, maxL = 0, bad = 0;
    for (let k = 0; k < 4000; k++) {
      const s = rng() * tr.length;
      const f = tr.frameAt(s);
      const lat = (rng() * 2 - 1) * Math.min(f.wallL, f.wallR);
      tr.project(tr.pointAt(s, lat), -1, proj);
      const es = Math.abs(tr.deltaS(s, proj.s)), el = Math.abs(proj.lateral - lat);
      maxS = Math.max(maxS, es); maxL = Math.max(maxL, el);
      if (es > 0.5 || el > 0.3) bad++;
    }
    check(bad === 0, 'projection round-trip', `max |ds| ${maxS.toFixed(3)}, max |dlat| ${maxL.toFixed(3)}, bad ${bad}/4000`);
  }

  // ---- corners + widths
  {
    let maxC = 0, maxCi = 0, maxRL = 0;
    let minHw = Infinity, minHwI = 0, minOff = Infinity, minOffI = 0;
    for (let i = 0; i < N; i++) {
      if (Math.abs(tr.curv[i]) > maxC) { maxC = Math.abs(tr.curv[i]); maxCi = i; }
      maxRL = Math.max(maxRL, Math.abs(tr.racingLine[i]));
      if (tr.hw[i] < minHw) { minHw = tr.hw[i]; minHwI = i; }
      const o = Math.min(tr.offL[i], tr.offR[i]);
      if (o < minOff) { minOff = o; minOffI = i; }
    }
    check(1 / maxC >= LIM.minRadius, 'min corner radius', `${f1(1 / maxC)} m at s ${f1(maxCi * sp)} (>= ${LIM.minRadius}); racing line max offset ${f2(maxRL)} m`);
    check(minHw >= LIM.minHalfWidth - 0.01, 'road half-width', `min ${f2(minHw)} m at s ${f1(minHwI * sp)} (>= ${LIM.minHalfWidth})`);
    check(minOff >= LIM.minOffroad - 0.01, 'curb + grass before walls', `min ${f2(minOff)} m at s ${f1(minOffI * sp)} (>= ${LIM.minOffroad})`);
    // exits of tight arcs (info); path mode: the stretches tighter than R30
    const tight = tr.pathMode ? tightStretches(tr, 30) : tr.segments.filter((s) => s.type === 'arc' && s.radius < 30);
    const exits = tight.map((s) => {
      let hw = Infinity;
      for (let d = 0; d <= 25; d += 1) hw = Math.min(hw, tr.frameAt(s.s1 + d).halfWidth);
      return `${s.name} R${tr.pathMode ? f1(s.radius) : s.radius}: ${f2(hw)}${hw < LIM.exitHalfWidth - 0.01 ? ' (narrow)' : ''}`;
    });
    if (exits.length) rule(!exits.some((e) => e.includes('(narrow)')), `tight-turn exits >= ${V4.exitHalfWidth} m (min half-width over 25 m)`, exits.join('; '));
  }

  // ---- elevation (info): range, grades, convex crests that may launch karts
  {
    let maxUp = 0, maxDown = 0, maxConvex = 0, convexI = 0;
    for (let i = 0; i < N; i++) {
      maxUp = Math.max(maxUp, tr.slope[i]); maxDown = Math.min(maxDown, tr.slope[i]);
      const c = -(tr.py[(i + 1) % N] - 2 * tr.py[i] + tr.py[(i - 1 + N) % N]) / (sp * sp);
      if (c > maxConvex) { maxConvex = c; convexI = i; }
    }
    console.log(`  info elevation ${f1(tr.bounds.minY)}..${f1(tr.bounds.maxY)} m, grade +${f1(maxUp * 100)}% / ${f1(maxDown * 100)}%, max convex curvature ${maxConvex.toFixed(4)} 1/m at s ${f1(convexI * sp)}`);
  }

  // ---- features on the road
  {
    const proj = {};
    const off = tr.itemBoxes.filter((b) => {
      tr.project(b.position, -1, proj);
      return Math.abs(proj.lateral) > proj.halfWidth - LIM.boxEdge || proj.surface === 'offroad';
    });
    check(off.length === 0, 'item boxes on the road', `${tr.itemBoxes.length} boxes in ${tr.itemRows.length} rows at s ${tr.itemRows.map((r) => r.s.toFixed(0)).join(', ')}; off-road ${off.length}`);
    let padsOff = 0;
    for (const p of tr.boostPads) {
      for (const t of [0, 0.5, 1]) {
        const f = tr.frameAt(p.s0 + p.length * t);
        if (Math.max(Math.abs(p.lat0), Math.abs(p.lat1)) > f.halfWidth) padsOff++;
      }
    }
    check(padsOff === 0, 'dash pads on the road', `${tr.boostPads.length} pads at s ${tr.boostPads.map((p) => p.s0.toFixed(0)).join(', ')}; off-road corners ${padsOff}`);
    let rampsOff = 0;
    for (const r of tr.ramps) {
      if (r.fullWidth) continue;
      for (const t of [0, 1]) { const f = tr.frameAt(r.s0 + r.length * t); if (Math.abs(r.lat0) > f.halfWidth || Math.abs(r.lat1) > f.halfWidth) rampsOff++; }
    }
    check(rampsOff === 0, 'kicker ramps on the road', `${tr.ramps.length} ramp(s) at s ${tr.ramps.map((r) => `${r.s0.toFixed(0)}-${r.s1.toFixed(0)}`).join(', ')}`);
    for (const r of tr.ramps) {
      const pad = tr.boostPads.find((p) => { const d = tr.deltaS(p.s1, r.s0); return d >= 0 && d <= LIM.padToRamp; });
      check(!!pad, `ramp at s ${r.s0.toFixed(0)} is fed by a dash pad`, pad ? `pad ends ${f1(tr.deltaS(pad.s1, r.s0))} m before it` : `no pad within ${LIM.padToRamp} m`);
    }
    let gridOff = 0;
    for (let i = 0; i < 8; i++) {
      const g = tr.gridSlot(i);
      tr.project(g.position, -1, proj);
      if (proj.surface !== 'road' || Math.abs(proj.lateral) > proj.halfWidth - KART_RADIUS) gridOff++;
    }
    check(gridOff === 0, 'grid slots on the road', `slots at s ${tr.gridSlot(0).s.toFixed(0)}..${tr.gridSlot(7).s.toFixed(0)}`);
    // v5 coins (def.coins → track.coins): on the road surface, inside the edge
    if ((tr.coins || []).length) {
      const offC = tr.coins.filter((c) => { tr.project(c.position, -1, proj); return proj.surface === 'offroad' || Math.abs(proj.lateral) > proj.halfWidth - 0.5; });
      check(offC.length === 0, 'coins on the road', `${tr.coins.length} coins in ${tr.coinLines.length} lines; off-road ${offC.length}`);
    }
  }

  // ---- kicker landings: ballistic flight (no steering) straight off the
  // lip from three lines at slow / boosted speeds; the kart must come down
  // on the road (or its curb) inside the walls, pointing roughly along it.
  for (const r of tr.ramps) {
    const rows = [];
    let ok = true;
    const p = { x: 0, y: 0, z: 0 }, proj = {};
    for (const v of [20, 26, 32, 40]) {
      for (const lat0 of [-4, 0, 4]) {
        const f = tr.frameAt(r.s1);
        const top = tr.pointAt(r.s1 - 1e-3, lat0);
        const slope = r.height / r.length + f.slope;
        let x = top.x, y = top.y, z = top.z, vy = slope * v, t = 0;
        const vx = f.tangent.x * v, vz = f.tangent.z * v;
        let hint = f.index, land = null;
        while (t < 3) {
          x += vx * 0.005; z += vz * 0.005; vy -= KART.gravity * 0.005; y += vy * 0.005; t += 0.005;
          p.x = x; p.z = z;
          tr.project(p, hint, proj); hint = proj.index;
          if (y <= proj.height) { land = { s: proj.s, lat: proj.lateral, hw: proj.halfWidth, wl: proj.wallL, wr: proj.wallR, head: Math.abs(Math.atan2(Math.sin(f.yaw - proj.yaw), Math.cos(f.yaw - proj.yaw))) * 180 / Math.PI, t }; break; }
        }
        const good = land && Math.abs(land.lat) <= land.hw + CURB_WIDTH &&
          land.lat < land.wr - KART_RADIUS && -land.lat < land.wl - KART_RADIUS && land.head < 20;
        if (!good) ok = false;
        rows.push(land ? `${v}m/s lat ${lat0}: +${f1(tr.deltaS(r.s1, land.s))} m lat ${f1(land.lat)}/${f1(land.hw)} ${f1(land.head)}° ${f2(land.t)} s${good ? '' : ' BAD'}` : `${v}m/s lat ${lat0}: no landing`);
      }
    }
    check(ok, `kicker at s ${r.s0.toFixed(0)}: landings on the road, < 20° off its heading`, '');
    console.log(`       ${rows.filter((_, i) => i % 3 === 1 || rows[i].includes('BAD')).join(' | ')}`);
  }

  // ---- self-overlap: two parts of the loop > 80 m apart along it must keep
  // their wall corridors apart (or pass well above / below each other).
  {
    let worst = { gap: Infinity };
    for (let i = 0; i < N; i += 2) {
      for (let j = i + 2; j < N; j += 2) {
        if (Math.abs(tr.deltaS(i * sp, j * sp)) < 80) continue;
        const dx = tr.px[j] - tr.px[i], dz = tr.pz[j] - tr.pz[i];
        const d = Math.hypot(dx, dz);
        if (d > 120) continue;
        const li = dx * tr.rx[i] + dz * tr.rz[i], lj = -dx * tr.rx[j] - dz * tr.rz[j];
        const gap = d - (li >= 0 ? tr.wr[i] : tr.wl[i]) - (lj >= 0 ? tr.wr[j] : tr.wl[j]);
        const dy = Math.abs(tr.py[i] - tr.py[j]);
        if (dy >= LIM.overlapDy) continue;
        if (gap < worst.gap) worst = { gap, si: i * sp, sj: j * sp, dy };
      }
    }
    const detail = Number.isFinite(worst.gap)
      ? `closest pass ${f1(worst.gap)} m wall-to-wall (s ${f1(worst.si)} / ${f1(worst.sj)}, dy ${f1(worst.dy)} m)` : 'no close passes';
    check(worst.gap > LIM.overlapGap, 'no overlapping sections', detail);
    rule(worst.gap >= V4.overlapGap, `separate parts of the loop >= ${V4.overlapGap} m apart`, detail);
  }

  // ---- course hazards (def.hazards): placement + an always-open line
  if ((def.hazards || []).length) checkHazards(tr);

  // ---- hinted projection perf (info)
  {
    const proj = {};
    let hint = -1;
    const t1 = performance.now();
    for (let k = 0; k < 100000; k++) { const s = (k * 0.3) % tr.length; tr.project(tr.pointAt(s, 2), hint, proj); hint = proj.index; }
    console.log(`  info 100k hinted projections ${f1(performance.now() - t1)} ms`);
  }
}

// Path mode: stretches whose curvature radius is below `r` m ({ name, s0, s1, radius }).
function tightStretches(tr, r) {
  const out = [];
  let cur = null;
  for (let i = 0; i <= tr.N; i++) {
    const c = i < tr.N ? Math.abs(tr.curv[i]) : 0;
    if (c > 1 / r) {
      if (!cur) cur = { s0: i * tr.spacing, s1: i * tr.spacing, radius: 1 / c };
      cur.s1 = i * tr.spacing; cur.radius = Math.min(cur.radius, 1 / c);
    } else if (cur) { out.push({ ...cur, name: `tight @${cur.s0.toFixed(0)}` }); cur = null; }
  }
  return out;
}

// |curvature| below 1/100 over [s0, s1] (path mode's "on a straight").
function straightOver(tr, s0, s1) {
  for (let s = s0; s <= s1; s += tr.spacing) if (Math.abs(tr.curv[tr.indexAt(s)]) >= 1 / 100) return false;
  return true;
}

function checkHazards(tr) {
  // the set the game and the sim run (hazards.js registry → hazards/<theme>.js)
  const hz = createHazards(tr);
  const H = hz.list;
  if (H.length !== tr.def.hazards.length) check(false, 'every hazard def has a kind in its theme module', `${H.length} of ${tr.def.hazards.length} resolved`);
  if (!H.length) return;
  const hazardHit = (h, t, along, lat) => hz.hitOne(h, t, along, lat);
  const R = KART_RADIUS;
  const feats = [
    ...tr.itemRows.map((r) => ({ what: 'item row', s0: r.s, s1: r.s })),
    ...tr.boostPads.map((p) => ({ what: 'pad', s0: p.s0, s1: p.s1 })),
    ...tr.ramps.map((r) => ({ what: 'ramp', s0: r.s0, s1: r.s1 })),
  ];
  let bad = [];
  for (const h of H) {
    // v5 kinds (research-v5-tracks.md A3.6 / D2): the span is the kind's reach [s + reach0, s + reach1]
    // (bands start at s), 6 m from the straight's ends; soft areas (kinds with soft(), e.g. surges /
    // belts) may contain features (a pad on a wet lane is risk / reward); a kind may allow a grade
    // (`maxGrade`, e.g. lateral movers on gentle slopes). The castle kinds keep the v4 rules.
    const kind = (hz.kinds && hz.kinds[h.type]) || {};
    const castle = h.type === 'flamearm' || h.type === 'crusher' || h.type === 'geyser';
    const ext = h.type === 'flamearm' ? h.length : h.extent;
    const a0 = castle ? h.s - ext : h.s + (h.reach0 ?? -ext), a1 = castle ? h.s + ext : h.s + (h.reach1 ?? ext);
    const margin = castle ? 10 : 6, soft = typeof kind.soft === 'function';
    const fc = tr.frameAt(h.s);
    let flat = Math.max(Math.abs(tr.frameAt(a0).slope), Math.abs(tr.frameAt(a1).slope), Math.abs(fc.slope));
    if (!castle) for (let s = a0; s <= a1; s += 2) flat = Math.max(flat, Math.abs(tr.frameAt(s).slope));
    const maxGrade = Number.isFinite(kind.maxGrade) ? kind.maxGrade : h.type === 'geyser' ? Infinity : 0.01;
    let onStraight;
    if (tr.pathMode) onStraight = straightOver(tr, a0 - margin, a1 + margin);
    else {
      const seg = tr.segments.find((g) => h.s >= g.s0 && h.s < g.s1);
      onStraight = seg.type === 'straight' && a0 - margin >= seg.s0 && a1 + margin <= seg.s1;
    }
    const near = soft ? [] : feats.filter((f) => tr.deltaS(f.s1, a0) < 10 && tr.deltaS(a1, f.s0) < 10).map((f) => `${f.what}@${f.s0.toFixed(0)}`);
    const inside = h.type === 'flamearm'
      ? Math.abs(h.lateral) + 1.0 <= Math.min(fc.wallL, fc.wallR) - 0.5     // pivot pillar between the road edge and the wall
      : h.type === 'crusher' || h.type === 'geyser'
        ? Math.abs(h.lateral) + (h.type === 'crusher' ? h.size / 2 : 0) <= fc.halfWidth + 0.01
        : Math.abs(h.lateral) <= Math.min(fc.wallL, fc.wallR);              // v5 kinds: anchored inside the walls
    if (!(onStraight && flat < maxGrade && !near.length && inside)) {
      bad.push(`${h.type}@${h.s.toFixed(0)}/${h.lateral}${onStraight ? '' : ' not on a straight'}${near.length ? ' near ' + near.join(' ') : ''}${inside ? '' : ' outside the road'}${flat < maxGrade ? '' : ` sloped ${(flat * 100).toFixed(1)} %`}`);
    }
  }
  check(!bad.length, `${H.length} hazards placed on flat straights, inside the road, clear of features`, bad.join('; '));

  // timing: groups of hazards within 60 m; straight lines (0.5 m apart) at
  // constant speed from every entry time over 16 s
  const groups = [];
  for (const h of [...H].sort((a, b) => a.s - b.s)) {
    const g = groups[groups.length - 1];
    if (g && h.s - g[g.length - 1].s < 60) g.push(h); else groups.push([h]);
  }
  // (v5 kinds: the stretch covers their whole reach, e.g. a surge band; a group with a rising tide
  // (rampT) is also tested late in the race, t0 in [100, 116), research-v5-tracks.md D2)
  const castleType = (h) => h.type === 'flamearm' || h.type === 'crusher' || h.type === 'geyser';
  for (const g of groups) {
    const s0 = Math.min(...g.map((h) => h.s + (castleType(h) ? 0 : Math.min(0, h.reach0 || 0)))) - 12;
    const s1 = Math.max(...g.map((h) => h.s + (castleType(h) ? 0 : Math.max(0, h.reach1 || 0)))) + 12;
    const hw = Math.min(...g.map((h) => tr.frameAt(h.s).halfWidth));
    const lines = [];
    for (let l = -(hw - R); l <= hw - R + 1e-6; l += 0.5) lines.push(l);
    const rows = [];
    let blockedAll = 0;
    const late = g.some((h) => Array.isArray(h.rampT));
    for (const [v, T0] of [18, 24, 30, 36].flatMap((v) => (late ? [[v, 0], [v, 100]] : [[v, 0]]))) {
      let blocked = 0, hits = 0, n = 0;
      for (let t0 = T0; t0 < T0 + 16; t0 += 0.05) {
        let clear = false;
        for (const l of lines) {
          let hit = false;
          for (let s = s0; s <= s1 && !hit; s += 0.25) {
            const t = t0 + (s - s0) / v;
            for (const h of g) if (hazardHit(h, t, s - h.s, l)) { hit = true; break; }
          }
          if (hit) hits++; else clear = true;
        }
        if (!clear) blocked++;
        n++;
      }
      blockedAll += blocked;
      rows.push(`${v} m/s${T0 ? ' late' : ''}: random line hit ${(100 * hits / (n * lines.length)).toFixed(0)} %${blocked ? `, ${blocked}/${n} entry times blocked` : ''}`);
    }
    check(blockedAll === 0, `hazard group ${g.map((h) => `${h.type}@${h.s.toFixed(0)}/${h.lateral}`).join(' ')}: an open line at every entry time`, rows.join('; '));
  }
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} (${failures} failure${failures === 1 ? '' : 's'})`);
process.exit(failures ? 1 : 0);
