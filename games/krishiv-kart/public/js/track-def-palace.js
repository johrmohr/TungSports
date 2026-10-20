// Layout data for Krishiv's Palace (v5 castle finale, SPEC §16.1, registered
// in tracks.js). Node-safe, pure data, same format as track-def.js (turtle
// path, u = segment index + fraction) plus `hazards` (hazards.js registry →
// hazards/castle.js; drawn by world-palace.js as world.hazards) and `coins`.
//
// A dark lava fortress, driven COUNTER-clockwise (net +360°), 1539 m, the
// Krishiv Cup finale (notes/research-v5-tracks.md §B4, extended in
// notes/v5-track-palace.md):
//   the Ash Causeway, a kicker onto the Drawbridge over the lava moat, the
//   Gatehouse under the crowned-K shield, the torch-lit Crusher Hall, the
//   stair turns down into the Flame Gallery (flame arms), then the FORGE WING:
//   the Forge (three reversing conveyor belts), the Anvil Hairpin round a
//   giant anvil and trip hammer, the Lavafall Tunnel (lava curtains pouring
//   from ceiling slots: an outer pair, then the middle); out to the Spiral
//   Climb round the Flame Tower, the Rampart Run crusher row, the Rampart
//   Leap into the Throne Hall, the Throne Turn at the giant throne, and the
//   FINALE GAUNTLET: the Geyser Stairs (four lava geysers), the Banquet Hall
//   (three chandeliers swinging across the road) and the Portcullis Run (two
//   gates whose leaves slam down in turn) to the back gate and the line.
// Castle halls are boxy: long straights for the set pieces, 90° / 180° turns.
// The two straights marked * were solved so the loop closes (< 0.01 m).

export const PALACE_DEF = {
  id: 'palace',
  name: "Krishiv's Palace",
  theme: 'castle',             // world kit (worlds.js): 'castle' -> world-palace.js; hazards/castle.js
  start: { x: 0, y: 0, z: 0, yaw: 0 },
  sampleSpacing: 1.0,

  segments: [
    /* 0 */ { type: 'straight', length: 60, name: 'Ash Causeway' },
    /* 1 */ { type: 'straight', length: 60, name: 'Drawbridge' },
    /* 2 */ { type: 'straight', length: 25, name: 'Gatehouse' },
    /* 3 */ { type: 'arc', dir: 'left', angle: 90, radius: 30, name: 'Gate Turn' },
    /* 4 */ { type: 'straight', length: 100, name: 'Crusher Hall' },
    /* 5 */ { type: 'arc', dir: 'right', angle: 40, radius: 34, name: 'Stair Turn A' },
    /* 6 */ { type: 'arc', dir: 'left', angle: 40, radius: 34, name: 'Stair Turn B' },
    /* 7 */ { type: 'straight', length: 90, name: 'Flame Gallery' },
    /* 8 */ { type: 'arc', dir: 'right', angle: 90, radius: 34, name: 'Forge Turn' },
    /* 9 */ { type: 'straight', length: 80, name: 'The Forge' },
    /* 10 */ { type: 'arc', dir: 'left', angle: 180, radius: 30, name: 'Anvil Hairpin' },
    /* 11 */ { type: 'straight', length: 80, name: 'Lavafall Tunnel' },
    /* 12 */ { type: 'arc', dir: 'right', angle: 90, radius: 34, name: 'Tunnel Exit' },
    /* 13 */ { type: 'straight', length: 25, name: 'Tower Approach' },
    /* 14 */ { type: 'arc', dir: 'left', angle: 180, radius: 36, name: 'Spiral Climb' },
    /* 15 */ { type: 'straight', length: 90, name: 'Rampart Run' },
    /* 16 */ { type: 'arc', dir: 'right', angle: 90, radius: 40, name: 'Rampart Bend' },
    /* 17 */ { type: 'straight', length: 84.69, name: 'Throne Hall' },              // *
    /* 18 */ { type: 'arc', dir: 'left', angle: 90, radius: 30, name: 'Throne Turn' },
    /* 19 */ { type: 'straight', length: 80.08, name: 'Geyser Stairs' },            // *
    /* 20 */ { type: 'arc', dir: 'right', angle: 30, radius: 40, name: 'Banquet Chicane A' },
    /* 21 */ { type: 'straight', length: 55, name: 'Banquet Hall' },
    /* 22 */ { type: 'arc', dir: 'left', angle: 30, radius: 40, name: 'Banquet Chicane B' },
    /* 23 */ { type: 'straight', length: 55, name: 'Portcullis Run' },
    /* 24 */ { type: 'arc', dir: 'left', angle: 90, radius: 34, name: 'Back Gate Turn' },
    /* 25 */ { type: 'straight', length: 40, name: 'Home Straight' },
  ],

  // Causeway / drawbridge 2 m (the lava moat ~4.5 m below), the hall 3 m,
  // the stairs down (≤ 6 %) to the lava-chamber floor (0 m), which runs flat
  // through the whole forge wing (belts + curtains), the Spiral Climb up to
  // the ramparts (10 m, ≤ 6.5 %), the Rampart Leap off the battlements with
  // the Throne Hall floor falling away (≤ 9 %), the Throne Turn and the
  // Geyser Stairs gently down to 2 m; the Banquet Hall, the Portcullis Run
  // and the back gate are flat.
  elevation: [
    [0, 2], [2.0, 2], [2.6, 2.5], [3.5, 3], [4.829, 3], [4.979, 2.8], [5.493, 2.1], [6.065, 1.2],
    [6.638, 0.4], [7.039, 0], [14.0, 0], [14.093, 0.5], [14.358, 2.0], [14.623, 3.8], [14.889, 5.7],
    [15.138, 7.3], [15.36, 8.6], [15.527, 9.5], [15.693, 10], [17.0, 10], [17.152, 9.9], [17.216, 9.8],
    [17.409, 8.6], [17.638, 7.0], [17.827, 5.6], [18.0, 4.4], [18.5, 3.9], [19.0, 3.4], [20.0, 2.0], [26, 2],
  ],
  // Road half-width (m): 11 (castle roads are broad: tilt drivers weave on the
  // long hall straights), 10.5 through the gatehouse, 11.5 in the Flame
  // Gallery, the Forge and the Throne Hall landing, 12 round the Anvil Hairpin.
  halfWidth: [
    [0, 11], [2.0, 11], [2.15, 10.5], [2.9, 10.5], [3.1, 11], [6.9, 11], [7.15, 11.5], [7.85, 11.5],
    [8.1, 11], [8.8, 11], [9, 11.5], [9.9, 11.5], [10.1, 12], [10.9, 12], [11.15, 11], [17.05, 11],
    [17.25, 11.5], [17.9, 11.5], [18.2, 11], [26, 11],
  ],
  // Off-road (m; first 1 m curb) before every wall, lava channel or parapet:
  // 6 on the causeway, the Crusher Hall and the Geyser Stairs, 6.5 outside the
  // Forge Turn / Tunnel Exit / Throne Turn, 7 outside the Anvil Hairpin and the
  // Spiral Climb (steer-probe: the outsides of 180° turns are where casual
  // tilt drivers meet the wall), 4.5 in the gatehouse, 5 elsewhere.
  offroadLeft: [
    [0, 6], [2.0, 6], [2.15, 4.5], [2.9, 4.5], [3.1, 5], [3.8, 6], [4.9, 6], [5.1, 5], [7.9, 5], [8.1, 6.5],
    [8.9, 6.5], [9.1, 5], [11.9, 5], [12.1, 6.5], [12.9, 6.5], [13.1, 5], [17.0, 5], [17.2, 6], [19.9, 6],
    [20.1, 5], [24.9, 5], [25.1, 6], [26, 6],
  ],
  offroadRight: [
    [0, 6], [2.0, 6], [2.15, 4.5], [2.9, 4.5], [3.1, 5], [3.8, 6], [4.9, 6], [5.1, 5], [9.9, 5], [10.1, 7],
    [10.9, 7], [11.1, 5], [13.9, 5], [14.1, 7], [14.9, 7], [15.1, 5], [17.0, 5], [17.2, 6], [17.9, 6],
    [18.1, 6.5], [18.9, 6.5], [19.1, 6], [19.9, 6], [20.1, 5], [24.9, 5], [25.1, 6], [26, 6],
  ],
  smoothing: { elevation: 2, halfWidth: 6, offroad: 3 },

  itemRows: [
    { u: 1.87, count: 4 },   // drawbridge, after the moat jump
    { u: 7.00, count: 5 },   // foot of the stairs, into the Flame Gallery
    { u: 10.92, count: 5 },  // Anvil Hairpin exit, before the lava curtains
    { u: 16.25, count: 4 },  // Rampart Bend, after the rampart crusher row
    { u: 23.873, count: 5 }, // end of the Portcullis Run: items for the last dash
  ],
  boostPads: [
    { u: 0.85, lateral: 0.0, length: 5, width: 4.0 },   // feeds the drawbridge kicker
    { u: 4.05, lateral: 0.0, length: 5, width: 3.6 },   // into the Crusher Hall (time the crushers)
    { u: 14.49, lateral: -5.0, length: 5, width: 3.6 }, // Spiral Climb, inside line (uphill help)
    { u: 17.035, lateral: 0.0, length: 5, width: 4.0 }, // feeds the Rampart Leap
  ],
  ramps: [
    { u: 0.967, length: 7, height: 1.7, lateral: 0, width: 0 },   // onto the drawbridge
    { u: 17.154, length: 7, height: 1.8, lateral: 0, width: 0 },  // Rampart Leap into the Throne Hall
  ],
  // Coin lines (v5 kart-racer staple; the items team owns pickup / HUD).
  coins: [
    { u: 1.45, count: 5, lateral: 0, spacing: 5 },      // drawbridge landing
    { u: 9.25, count: 6, lateral: 0, spacing: 6 },      // the Forge centre belt (ride its forward phase)
    { u: 13.20, count: 4, lateral: 0, spacing: 5 },     // Tower Approach
    { u: 17.708, count: 4, lateral: 0, spacing: 5 },    // Throne Hall, the red carpet after the landing
    { u: 19.375, count: 5, lateral: 0, spacing: 4.5 },  // Geyser Stairs: the middle line, over the centre geyser (risk)
  ],

  // Course hazards (hazards.js registry → hazards/castle.js, which documents
  // every kind; exposed by the castle world kit as world.hazards). Positions in
  // u (+ lateral, m, + = right); timings in seconds of race time, phase = the
  // fraction of the period at t = 0. Every set piece sits on a straight, clear
  // of item rows / pads / ramps / corners, and for every entry time and speed
  // some straight line gets through clean (tools/track-check.mjs).
  hazards: [
    // v4 set (unchanged parameters)
    { type: 'crusher', u: 4.33, lateral: -5.0, size: 6.0, period: 3.2, phase: 0.0 },
    { type: 'crusher', u: 4.33, lateral: 5.0, size: 6.0, period: 3.2, phase: 0.0 },
    { type: 'crusher', u: 4.70, lateral: 0.0, size: 7.0, period: 3.2, phase: 0.5 },
    { type: 'flamearm', u: 7.28, lateral: -12.5, length: 9.0, speed: 60, phase: 0 },
    { type: 'flamearm', u: 7.67, lateral: 12.5, length: 9.0, speed: -60, phase: 180 },
    { type: 'crusher', u: 15.80, lateral: -7.25, size: 7.0, period: 3.2, phase: 0.6 },
    { type: 'crusher', u: 15.80, lateral: 0.0, size: 7.0, period: 3.2, phase: 0.1 },
    { type: 'crusher', u: 15.80, lateral: 7.25, size: 7.0, period: 3.2, phase: 0.6 },
    // the Forge: three conveyor lanes, the centre forward while the sides run backward, then swap
    // (forward / backward = the push hazards.js applies: ≈ +12 % / -17 % of top speed, measured)
    { type: 'belt', u0: 9.10, u1: 9.88, latA: -3.5, latB: 3.5, startDir: 1, forward: 1.8, backward: 1.25, period: 6.0, phase: 0.0 },
    { type: 'belt', u0: 9.10, u1: 9.88, latA: -16.5, latB: -3.5, startDir: -1, forward: 1.8, backward: 1.25, period: 6.0, phase: 0.0 },
    { type: 'belt', u0: 9.10, u1: 9.88, latA: 3.5, latB: 16.5, startDir: -1, forward: 1.8, backward: 1.25, period: 6.0, phase: 0.0 },
    // the Lavafall Tunnel: an outer pair of lava curtains, then the middle one half a period later
    { type: 'curtain', row: 'lavafall', u: 11.32, latA: -16.5, latB: -5.0, period: 3.6, phase: 0.0 },
    { type: 'curtain', row: 'lavafall', u: 11.32, latA: 5.0, latB: 16.5, period: 3.6, phase: 0.0 },
    { type: 'curtain', row: 'lavafall', u: 11.52, latA: -3.0, latB: 3.0, period: 3.6, phase: 0.5 },
    // the Geyser Stairs: four lava geysers, left / right / middle / left
    { type: 'geyser', row: 'geysers', u: 19.200, lateral: -7.5, radius: 2.0, period: 4.0, phase: 0.0 },
    { type: 'geyser', row: 'geysers', u: 19.350, lateral: 7.5, radius: 2.0, period: 4.0, phase: 0.5 },
    { type: 'geyser', row: 'geysers', u: 19.500, lateral: 0.0, radius: 2.0, period: 4.0, phase: 0.25 },
    { type: 'geyser', row: 'geysers', u: 19.649, lateral: -7.5, radius: 2.0, period: 4.0, phase: 0.75 },
    // the Banquet Hall: three iron chandeliers swinging across the road from the vault
    { type: 'chandelier', row: 'banquet', u: 21.218, lateral: -3.0, pivot: 20, chain: 19, radius: 1.5, amp: 35, period: 4.0, phase: 0.0 },
    { type: 'chandelier', row: 'banquet', u: 21.436, lateral: 3.0, pivot: 20, chain: 19, radius: 1.5, amp: 35, period: 4.0, phase: 0.5 },
    { type: 'chandelier', row: 'banquet', u: 21.655, lateral: -3.0, pivot: 20, chain: 19, radius: 1.5, amp: 35, period: 4.0, phase: 0.0 },
    // the Portcullis Run: two gates whose left and right leaves slam down in turn (gate 2 a beat earlier)
    { type: 'portcullis', row: 'gates', u: 23.40, latA: -16.5, latB: 0.0, period: 3.2, phase: 0.0 },
    { type: 'portcullis', row: 'gates', u: 23.40, latA: 0.0, latB: 16.5, period: 3.2, phase: 0.5 },
    { type: 'portcullis', row: 'gates', u: 23.673, latA: -16.5, latB: 0.0, period: 3.2, phase: 0.875 },
    { type: 'portcullis', row: 'gates', u: 23.673, latA: 0.0, latB: 16.5, period: 3.2, phase: 0.375 },
  ],

  // Visual hints for the castle world kit (inclusive u ranges).
  zones: [
    { u0: 25.0, u1: 26.0, type: 'causeway' },   // ash plain, dead trees, start gantry
    { u0: 0.0, u1: 0.97, type: 'causeway' },
    { u0: 0.97, u1: 2.0, type: 'bridge' },      // drawbridge over the lava moat
    { u0: 2.0, u1: 3.0, type: 'gate' },         // gatehouse, portcullis, crowned-K shield
    { u0: 3.6, u1: 5.0, type: 'hall' },         // Crusher Hall (roofed, torches, banners)
    { u0: 5.0, u1: 7.0, type: 'stairs' },       // stepped ramps down
    { u0: 7.0, u1: 8.0, type: 'lava' },         // Flame Gallery: lava chamber, lava falls
    { u0: 8.6, u1: 10.0, type: 'forge' },       // the Forge: belts, furnaces, crucible overhead
    { u0: 10.0, u1: 11.0, type: 'anvil' },      // Anvil Hairpin: the giant anvil + trip hammer
    { u0: 11.0, u1: 12.0, type: 'lavafall' },   // Lavafall Tunnel: arches, ceiling slots, floor grates
    { u0: 14.0, u1: 15.0, type: 'tower' },      // Spiral Climb round the Flame Tower
    { u0: 15.0, u1: 17.1, type: 'rampart' },    // battlements, banners, open sky
    { u0: 17.1, u1: 18.6, type: 'throne' },     // Throne Hall: red carpet, giant throne at the turn
    { u0: 19.0, u1: 20.0, type: 'stairs' },     // Geyser Stairs
    { u0: 20.0, u1: 23.0, type: 'banquet' },    // Banquet Hall: vaulted, long tables, swinging chandeliers
    { u0: 23.0, u1: 24.0, type: 'portcullis' }, // Portcullis Run: two gate arches
    { u0: 24.0, u1: 25.0, type: 'gate' },       // back gate out to the causeway
  ],
};
