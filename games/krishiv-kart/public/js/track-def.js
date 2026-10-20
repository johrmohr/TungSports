// Layout data for Breezy Bay Circuit (track 1, registered in tracks.js; v5,
// notes/research-v5-tracks.md §B1). Node-safe, pure data.
//
// The centerline is a "turtle" path: starting at `start` (the start/finish
// line) and heading `start.yaw`, each segment is either a straight or a
// circular arc. Total turning is exactly -360° (a clockwise loop when seen
// from above with +X right / +Z down); the two straights marked * were solved
// so the path closes on itself (track.js spreads any tiny residual).
//
// Per-segment attributes (elevation, road half-width, off-road widths) are
// keyframes in "u" coordinates: u = segmentIndex + fraction, so [9.6, 9]
// means "60% of the way through segment 9, the value is 9"; u = 27 is the
// start line again. Values are interpolated linearly, then box-smoothed.
// Heading convention (SPEC.md): forward = (sin yaw, 0, cos yaw); a RIGHT turn
// DEcreases yaw.
//
// Clockwise, 1371 m. Start straight past the grandstands, the
// decreasing-radius Turn 1, the esses (three bends linked by short straights)
// onto Breezy Hill (crest launch), the Lighthouse Hairpin, the Bay Bridge, the
// harbour (slipway kicker), Cove Bend down to Crab Cove (crabs), the Spit Turn
// double apex round the sand spit (boost "Spit Cut"), the Tide Causeway
// (waves), Gull Rise and the Cliff Road up the cliffs, the Cliff Sweep (100°
// R40) onto the cliff top, the Gull Gap cliff jump, the Promenade (beach balls)
// and home.
// Set pieces: hazards/bay.js (crab / surge / ball, research-v5-tracks.md §C1-C3).
// v5b changes to the research layout (notes/v5-track-breezy.md): 8 m links in
// the esses, Cliff Sweep A 100° R40 + Cliff Sweep B 20° (was 80° R50 + 40°),
// closed on the Cliff Road + Crab Cove: tilt drifters now meet the drift-probe
// gates on this course alone; the crabs sit 6.6 m apart (one CPU planning row).

export const TRACK_DEF = {
  id: 'breezy', name: 'Breezy Bay Circuit', theme: 'bay', start: { x: 0, y: 0, z: 0, yaw: 0 }, sampleSpacing: 1.0,
  segments: [
    /* 0 */ { type: 'straight', length: 80, name: 'Start Straight' },
    /* 1 */ { type: 'arc', dir: 'right', angle: 40, radius: 60, name: 'Turn 1 Entry' },
    /* 2 */ { type: 'arc', dir: 'right', angle: 50, radius: 36, name: 'Turn 1' },
    /* 3 */ { type: 'straight', length: 45, name: 'Item Straight' },
    /* 4 */ { type: 'arc', dir: 'left', angle: 40, radius: 32, name: 'Esses A' },
    /* 5 */ { type: 'straight', length: 8, name: 'Esses Link A' },
    /* 6 */ { type: 'arc', dir: 'right', angle: 80, radius: 32, name: 'Esses B' },
    /* 7 */ { type: 'straight', length: 8, name: 'Esses Link B' },
    /* 8 */ { type: 'arc', dir: 'left', angle: 40, radius: 32, name: 'Esses C' },
    /* 9 */ { type: 'straight', length: 95, name: 'Breezy Hill' },
    /* 10 */ { type: 'arc', dir: 'right', angle: 180, radius: 24, name: 'Lighthouse Hairpin' },
    /* 11 */ { type: 'straight', length: 110, name: 'Bay Bridge' },
    /* 12 */ { type: 'arc', dir: 'left', angle: 90, radius: 38, name: 'Harbor Kink' },
    /* 13 */ { type: 'straight', length: 91.9, name: 'Ramp Run' },
    /* 14 */ { type: 'arc', dir: 'left', angle: 90, radius: 40, name: 'Cove Bend' },
    /* 15 */ { type: 'straight', length: 47.05, name: 'Crab Cove' }, // * solved: closes the loop
    /* 16 */ { type: 'arc', dir: 'right', angle: 90, radius: 34, name: 'Spit Turn A' },
    /* 17 */ { type: 'straight', length: 18, name: 'Spit Beacon' },
    /* 18 */ { type: 'arc', dir: 'right', angle: 90, radius: 34, name: 'Spit Turn B' },
    /* 19 */ { type: 'straight', length: 51.52, name: 'Tide Causeway' },
    /* 20 */ { type: 'arc', dir: 'left', angle: 30, radius: 70, name: 'Gull Rise' },
    /* 21 */ { type: 'straight', length: 51.24, name: 'Cliff Road' }, // * solved: closes the loop
    /* 22 */ { type: 'arc', dir: 'right', angle: 100, radius: 40, name: 'Cliff Sweep A' },
    /* 23 */ { type: 'straight', length: 70, name: 'Gull Gap' },
    /* 24 */ { type: 'arc', dir: 'right', angle: 20, radius: 46, name: 'Cliff Sweep B' },
    /* 25 */ { type: 'straight', length: 45, name: 'Promenade' },
    /* 26 */ { type: 'straight', length: 60, name: 'Home Straight' },
  ],
  // Flat start/Turn 1, the esses rising onto Breezy Hill (crest launch at u 9.6,
  // unchanged profile), the hairpin and bridge (3.6 m deck), down to the harbour,
  // the flat beach loop (Crab Cove 0.3 m, the causeway at 0.2 m: waves wash over
  // it), Gull Rise + Cliff Road up to the 8 m cliff top, the Gull Gap kicker off
  // the cliff lip with the road falling away (8 -> 3.6 m, <= 8.6 %) so the jump
  // is long (up to ~40 m / 1 s), then gently down the promenade.
  elevation: [
    [0, 0], [3, 0], [4, 0.5], [9, 2], [9.6, 9], [10, 1.2], [10.45, 1.3], [11, 3.6], [12, 3.6], [12.3, 2.72],
    [12.8, 0.15], [13, 0], [14, 0], [15, 0.3], [16, 0.3], [19, 0.2], [20, 0.2], [20.2, 0.45], [21, 2.6],
    [22, 5.2], [22.5, 7.6], [22.75, 8], [23.5, 8], [24.5, 3.6], [25, 2.2], [25.6, 0.8], [26, 0.3], [27, 0]
  ],
  halfWidth: [
    [0, 11], [0.85, 11], [1, 10.5], [3, 10.5], [3.5, 10], [9, 10], [9.6, 10.5], [10, 12], [10.9, 12], [11, 10],
    [12, 10], [12.4, 11], [14, 11], [14.5, 11], [19, 11], [19.5, 11.5], [20, 11.5], [20.4, 11], [23, 11],
    [23.2, 11.5], [24.6, 11.5], [25, 11], [27, 11]
  ],
  // Off-road (curb + grass/sand before the barrier). Long straights 5 m (tilt
  // weave), the bridge deck 3 m, the hairpin outside 10 m, 6-7 m round the
  // harbour slipway and Gull Gap landings, a 16 m sand tip
  // inside the Spit Turn double apex (the "Spit Cut": a boost item crosses it).
  offroadLeft: [
    [0, 6], [1, 6], [2, 5], [9, 5], [10, 10], [10.9, 7], [11, 3], [12, 3], [12.3, 6], [14, 6], [14.4, 5], [19, 5],
    [19.2, 6], [20, 6], [20.3, 5], [27, 6]
  ],
  offroadRight: [
    [0, 6], [1, 6], [2, 5], [10.9, 5], [11, 3], [12, 3], [12.3, 6], [14, 6], [14.4, 5], [15.9, 5], [16.25, 16],
    [18.75, 16], [19.1, 5], [22, 5], [22.2, 6], [23.3, 6], [23.5, 7], [24.2, 7], [24.8, 6], [25, 5], [27, 6]
  ],
  smoothing: { elevation: 2, halfWidth: 6, offroad: 3 },

  itemRows: [
    { u: 3.45, count: 5 },   // Item Straight (out of Turn 1)
    { u: 11.55, count: 4 },   // mid Bay Bridge
    { u: 15.12, count: 5 },   // Crab Cove entry (before the crabs)
    { u: 21.55, count: 5 },   // Cliff Road
    { u: 25.12, count: 5 },   // Promenade entry (before the beach balls)
  ],
  boostPads: [
    { u: 3.75, lateral: -4, length: 5, width: 3.6 },   // Item Straight, inside line into the esses
    { u: 13.2, lateral: 0, length: 5, width: 4 },   // feeds the harbour slipway kicker
    { u: 19.4, lateral: -6, length: 5, width: 3.6 },   // causeway, SEA-side lane (the waves wash it: risk/reward)
    { u: 23.28, lateral: 0, length: 5, width: 4 },   // feeds the Gull Gap cliff kicker
  ],
  ramps: [
    { u: 13.32, length: 7, height: 1.6, lateral: 0, width: 0 },   // harbour slipway kicker (Ramp Run), 28 m after the Harbor Kink
    { u: 23.4, length: 7, height: 1.8, lateral: 0, width: 0 },   // Gull Gap: off the cliff lip, 28 m after Cliff Sweep A
  ],
  coins: [
    { u: 9.35, count: 5, lateral: 0, spacing: 4 },   // up Breezy Hill to the crest (on the launch line)
    { u: 11.2, count: 6, lateral: 3.5, spacing: 5 },   // Bay Bridge, right lane
    { u: 15.45, count: 4, lateral: 5, spacing: 5 },   // Crab Cove, between the crab lanes (risky)
    { u: 19.15, count: 6, lateral: -7, spacing: 5 },   // causeway sea side (the waves wash it)
    { u: 23.75, count: 5, lateral: 0, spacing: 5 },   // Gull Gap landing strip
  ],
  // v5 set pieces (hazards/bay.js). Types are specified in notes/research-v5-tracks.md §C.
  hazards: [
    { type: 'crab', u: 15.62, latA: -9, latB: 3, period: 8, phase: 0, radius: 1 },
    { type: 'crab', u: 15.76, latA: 9, latB: -3, period: 8, phase: 0.25, radius: 1 },
    { type: 'surge', u0: 19.12, u1: 19.85, side: -1, reachLap1: 0.35, reach: 0.6, rampT: [45, 90], period: 9, phase: 0 },
    { type: 'ball', u: 25.58, from: -1, period: 6.5, phase: 0, count: 2, speed: 6, radius: 1.4, bounce: 2.6, hop: 0.9, bounce0: 0.45, travel: 34 },
  ],
  zones: [
    { u0: 0, u1: 1, type: 'grandstand' },
    { u0: 26, u1: 27, type: 'grandstand' },
    { u0: 9, u1: 10, type: 'hill' },
    { u0: 10, u1: 11, type: 'hairpin' },
    { u0: 11, u1: 12, type: 'bridge' },
    { u0: 12.4, u1: 14, type: 'harbor' },
    { u0: 14.6, u1: 19, type: 'beach' },
    { u0: 16, u1: 19, type: 'spit' },
    { u0: 19, u1: 20, type: 'causeway' },
    { u0: 20.5, u1: 25, type: 'cliff' },
    { u0: 23.4, u1: 24, type: 'gap' },
    { u0: 25, u1: 26, type: 'promenade' },
  ],
};
