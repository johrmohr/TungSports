// Layout data for Laguna Beach (v5, SPEC §16.1; layout from
// notes/research-v5-tracks.md §B3, registered in tracks.js). Node-safe, pure
// data, same format as track-def.js (see that file for the turtle path /
// u-keyframe conventions); the two straights marked * were solved so the loop
// closes (track-check: < 0.1 m).
//
// A sunny surf-town loop inspired by Laguna Beach's Main Beach, driven
// COUNTER-clockwise (net +360°, 1466 m, 18 arcs / 728° of turning) with the
// Pacific on the right along the coast:
//   * the Coast Highway through the gallery village (start);
//   * the canyon climb: the Canyon Bend, the Hillside Climb past terraced
//     cottages, the canyon esses (L40/R40 R45) and the Sawdust bends past the
//     art-festival field (L30/R30 R50 with a 20 m gap), the Canyon Climb;
//   * the Crest Hairpin (L120 R28, the 17 m summit, ocean ahead), the fast
//     Cliff Drive descent, the Heisler Turn, the rose garden and the Monument
//     Point S past the gazebo on its promontory;
//   * the Rockpile cove jump (a timber trestle over the inlet), Bird Rock Bend,
//     the Bluff Ramp and a gentle S down to the tide-pool shelf: BLOWHOLES
//     spout through cracks in the rock (soak = slow);
//   * Main Beach: SHORE-BREAK WAVES wash over the low beach road from the sea
//     side (slow + a shove toward land; the tide rises on laps 2-3, a dry lane
//     always stays open), the LIFEGUARD-TOWER JUMP off a sand berm (pad on
//     the wet sea-side line), then VOLLEYBALL SPIKES from the courts (a ball
//     lands on a shrinking shadow ring: knock);
//   * the Ocean Avenue Turn (Main Beach Park lawn inside = the item
//     shortcut), Gallery Row, the Forest Avenue chicane (painters' easels),
//     Gallery Walk, the Broadway Turn and home.
// Set pieces: hazards/beach.js (jet / surge / lob), drawn by world-laguna.js.

export const LAGUNA_DEF = {
  id: 'laguna',
  name: 'Laguna Beach',
  theme: 'beach',              // world kit (worlds.js): 'beach' -> world-laguna.js; hazards: hazards/beach.js
  start: { x: 0, y: 0, z: 0, yaw: 0 },
  sampleSpacing: 1.0,

  segments: [
    /* 0 */ { type: 'straight', length: 85, name: 'Coast Highway' },
    /* 1 */ { type: 'arc', dir: 'right', angle: 15, radius: 60, name: 'Canyon Bend' },
    /* 2 */ { type: 'straight', length: 133.48, name: 'Hillside Climb' },                // *
    /* 3 */ { type: 'arc', dir: 'left', angle: 40, radius: 45, name: 'Canyon Esses A' },
    /* 4 */ { type: 'arc', dir: 'right', angle: 40, radius: 45, name: 'Canyon Esses B' },
    /* 5 */ { type: 'straight', length: 30, name: 'Canyon Straight' },
    /* 6 */ { type: 'arc', dir: 'left', angle: 30, radius: 50, name: 'Sawdust Bend A' },
    /* 7 */ { type: 'straight', length: 20, name: 'Sawdust Straight' },
    /* 8 */ { type: 'arc', dir: 'right', angle: 30, radius: 50, name: 'Sawdust Bend B' },
    /* 9 */ { type: 'straight', length: 45, name: 'Canyon Climb' },
    /* 10 */ { type: 'arc', dir: 'left', angle: 120, radius: 28, name: 'Crest Hairpin' },
    /* 11 */ { type: 'straight', length: 90, name: 'Cliff Drive' },
    /* 12 */ { type: 'arc', dir: 'left', angle: 45, radius: 40, name: 'Heisler Turn' },
    /* 13 */ { type: 'straight', length: 20, name: 'Rose Garden' },
    /* 14 */ { type: 'arc', dir: 'right', angle: 22, radius: 60, name: 'Monument Point A' },
    /* 15 */ { type: 'arc', dir: 'left', angle: 44, radius: 60, name: 'Monument Point B' },
    /* 16 */ { type: 'arc', dir: 'right', angle: 22, radius: 60, name: 'Monument Point C' },
    /* 17 */ { type: 'straight', length: 50, name: 'Rockpile Run' },
    /* 18 */ { type: 'arc', dir: 'left', angle: 15, radius: 70, name: 'Bird Rock Bend' },
    /* 19 */ { type: 'straight', length: 30, name: 'Bluff Ramp' },
    /* 20 */ { type: 'arc', dir: 'right', angle: 25, radius: 70, name: 'Bluff Bend A' },
    /* 21 */ { type: 'arc', dir: 'left', angle: 25, radius: 70, name: 'Bluff Bend B' },
    /* 22 */ { type: 'straight', length: 36, name: 'Tide Pools' },
    /* 23 */ { type: 'arc', dir: 'left', angle: 15, radius: 180, name: 'Main Beach Boardwalk' },
    /* 24 */ { type: 'straight', length: 50, name: 'Main Beach' },
    /* 25 */ { type: 'straight', length: 45, name: 'Tower Jump' },
    /* 26 */ { type: 'straight', length: 45, name: 'Volleyball Row' },
    /* 27 */ { type: 'arc', dir: 'left', angle: 90, radius: 40, name: 'Ocean Avenue Turn' },
    /* 28 */ { type: 'straight', length: 70.55, name: 'Gallery Row' },                   // *
    /* 29 */ { type: 'arc', dir: 'right', angle: 30, radius: 40, name: 'Forest Chicane A' },
    /* 30 */ { type: 'straight', length: 25, name: 'Forest Avenue' },
    /* 31 */ { type: 'arc', dir: 'left', angle: 30, radius: 40, name: 'Forest Chicane B' },
    /* 32 */ { type: 'straight', length: 30, name: 'Gallery Walk' },
    /* 33 */ { type: 'arc', dir: 'left', angle: 90, radius: 36, name: 'Broadway Turn' },
    /* 34 */ { type: 'straight', length: 60, name: 'Home Straight' },
  ],

  // Village 4 m, the canyon climb (<= 4.6 %) to the 17 m crest at the hairpin,
  // Cliff Drive down to the clifftop park (~10 m), the Rockpile cove kicker, the
  // bluff down to the tide-pool shelf (<= 8 %), the flat beach at 1.6 m (waves,
  // tower jump, volleyball), then gently back up through the village. Only the
  // kickers launch karts (max convex curvature 0.008 1/m, at the crest).
  elevation: [
    [0, 4], [1, 4.2], [2, 4.4], [3, 9.8], [5, 11.8], [6, 12.9], [9, 15.1], [10, 16.4], [10.5, 16.9],
    [11, 16.7], [12, 12.4], [13, 11.0], [14, 10.4], [17, 9.7], [18, 9.5], [19, 8.8], [20, 7.0],
    [21, 4.6], [22, 2.2], [22.12, 1.85], [23, 1.8], [23.5, 1.65], [24, 1.6], [27, 1.6], [28, 2.6],
    [33, 4.0], [35, 4],
  ],
  // Road half-width (m): 11 in the village and on Cliff Drive, 10.5-11 in the
  // canyon, 11.5 through the hairpin and out of it, 11.5 through the Monument
  // S and on the whole beach (the waves take the sea side), 10.5 on the bluff,
  // Ocean Avenue and through the Forest chicane.
  halfWidth: [
    [0, 11], [1, 11], [1.5, 10.5], [3, 10.5], [3.2, 11], [5, 11], [5.3, 10.5], [9.6, 10.5], [10, 11.5],
    [11.2, 11.5], [11.5, 11], [13, 11], [13.6, 10.5], [14, 11.5], [16.9, 11.5], [17.2, 11], [18, 11],
    [18.3, 10.5], [21.8, 10.5], [22, 11], [23, 11], [23.4, 11.5], [27, 11.5], [27.2, 10.5], [32, 10.5],
    [32.3, 11], [35, 11],
  ],
  // Off-road (m; the first 1 m is the curb). Left = inland: village pavements
  // 5, canyon chaparral 4.5, the Main Beach Park lawn 12 m inside the Ocean
  // Avenue Turn (item shortcut). Right = the sea on the coast: clifftop
  // railing 4.5, 7 m of lawn out of the Monument S (drift exits run wide), the
  // tide-pool rock shelf 6 m, 12 m of sand down the beach (the waves run up it
  // first).
  offroadLeft: [
    [0, 5], [1.5, 4.5], [10, 4.5], [10.2, 6], [10.8, 6], [11, 5], [17, 5], [17.4, 4], [18, 4],
    [18.2, 4.5], [26.9, 5], [27.15, 12], [27.85, 12], [28.1, 5], [35, 5],
  ],
  offroadRight: [
    [0, 5], [1.5, 4.5], [10, 4.5], [11, 6], [12, 4.5], [14, 4.5], [16.8, 5], [17, 7], [17.3, 7],
    [17.45, 4], [18, 4], [18.2, 4.5], [21.8, 4.5], [22, 6], [23, 6], [23.3, 12], [26.9, 12], [27.2, 5], [35, 5],
  ],
  smoothing: { elevation: 2, halfWidth: 6, offroad: 3 },

  itemRows: [
    { u: 2.22, count: 5 },   // Hillside Climb
    { u: 9.25, count: 4 },   // Canyon Climb, before the Crest Hairpin
    { u: 13.60, count: 4 },  // Rose Garden (clifftop)
    { u: 23.45, count: 5 },  // the boardwalk crescent, before the waves
    { u: 28.45, count: 5 },  // Gallery Row
  ],
  boostPads: [
    { u: 2.75, lateral: 0.0, length: 5, width: 3.6 },    // Hillside Climb (uphill help)
    { u: 11.75, lateral: -4.0, length: 5, width: 3.6 },  // Cliff Drive, inside line into the Heisler Turn
    { u: 17.25, lateral: 0.0, length: 5, width: 4.0 },   // feeds the Rockpile cove kicker
    { u: 24.88, lateral: 4.0, length: 5, width: 4.0 },   // feeds the lifeguard-tower kicker, on the wet sea-side line
  ],
  ramps: [
    { u: 17.40, length: 7, height: 1.7, lateral: 0, width: 0 },   // Rockpile cove jump (timber trestle)
    { u: 25.05, length: 7, height: 1.6, lateral: 0, width: 0 },   // lifeguard-tower jump (sand berm by the tower)
  ],
  // Coin lines (SPEC §16.1; items team: pickup / HUD): risky or skilful lines pay.
  coins: [
    { u: 2.40, count: 5, lateral: 0, spacing: 6 },      // Hillside Climb
    { u: 10.55, count: 4, lateral: -6, spacing: 4 },    // Crest Hairpin, tight inside line
    { u: 11.30, count: 6, lateral: 4, spacing: 6 },     // Cliff Drive
    { u: 24.25, count: 5, lateral: 6, spacing: 5 },     // Main Beach, sea side (where the waves wash)
    { u: 30.20, count: 4, lateral: 0, spacing: 5 },     // Forest Avenue chicane
  ],
  // Set pieces (hazards/beach.js; deterministic on the race clock, fair
  // windows checked by track-check, CPUs dodge them through hitAt):
  hazards: [
    // tide-pool blowholes on the sea-side half of the shelf (the inland half is always dry):
    // 3.6 s cycle, the two holes half a period apart, 0.72 s of bubbling + hiss, 0.9 s spout
    { type: 'jet', u: 22.45, lats: [8.5, 4.5], radius: 1.8, period: 3.6, phase: 0.0, dphase: 0.5, effect: 'slow', strength: 0.25 },
    // shore-break waves over Main Beach from the sea (right) edge: 8 s cycle, reach 35 % of the
    // road width on lap 1 rising to 55 % between 45 s and 90 s of race time
    { type: 'surge', u0: 24.14, u1: 24.85, side: 1, reachLap1: 0.35, reach: 0.55, rampT: [45, 90], period: 8.0, phase: 0.25 },
    // volleyball spikes from the courts (sea side): one every 1.8 s, 1.1 s of flight onto four spots in turn
    { type: 'lob', u: 26.45, spots: [{ lat: 6, along: 0, roll: -1 }, { lat: -2, along: 6, roll: -1 }, { lat: 3, along: 10, roll: -1 }, { lat: -6, along: 3, roll: -1 }], period: 1.8, flight: 1.1, phase: 0.0 },
  ],

  zones: [
    { u0: 0.0, u1: 1.0, type: 'village' },     // Coast Highway: galleries, palms, crosswalks
    { u0: 28.0, u1: 35.0, type: 'village' },   // Gallery Row, Forest Avenue, Broadway, home
    { u0: 1.0, u1: 10.0, type: 'hillside' },   // terraced cottages, bougainvillea; chaparral higher up
    { u0: 5.0, u1: 9.0, type: 'canyon' },      // canyon esses + Sawdust bends: chaparral, eucalyptus
    { u0: 6.0, u1: 9.0, type: 'festival' },    // the art-festival field (white tents, sculptures)
    { u0: 10.0, u1: 11.0, type: 'hairpin' },   // Crest Hairpin (bench, Torrey pine, sea view)
    { u0: 11.0, u1: 18.0, type: 'clifftop' },  // the clifftop park: lawns, palms, railing
    { u0: 14.0, u1: 17.0, type: 'point' },     // Monument Point + gazebo on the promontory
    { u0: 17.45, u1: 18.0, type: 'bridge' },   // timber trestle over the Rockpile cove inlet
    { u0: 18.0, u1: 22.0, type: 'bluff' },     // Bluff Ramp + bends down to the shelf (ice plant)
    { u0: 22.0, u1: 23.0, type: 'tidepools' }, // the rock shelf: blowholes, rock arch, pools
    { u0: 23.0, u1: 27.0, type: 'beach' },     // boardwalk, sand, waves, the tower, courts
    { u0: 25.0, u1: 25.6, type: 'tower' },     // the lifeguard tower + its sand berm
    { u0: 26.0, u1: 27.0, type: 'courts' },    // volleyball courts (spikes)
    { u0: 27.1, u1: 27.9, type: 'shortcut' },  // Main Beach Park lawn inside the Ocean Avenue Turn
  ],
};
