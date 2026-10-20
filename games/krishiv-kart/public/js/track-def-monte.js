// Layout data for Monte Mozzarella (track 2, registered in tracks.js).
// Node-safe, pure data, same format as track-def.js (see that file for the
// turtle path / u-keyframe conventions). v5 layout: notes/research-v5-tracks.md
// §B2 (validated there with track-check / sim / steer-probe / drift-probe).
//
// A sunny Italian hill town, driven COUNTER-clockwise (net +360°, left turns
// dominate), 1438 m:
//   * the cobbled piazza start and the Fontana Turn (fountain inside);
//   * Via Vespa: a long town street where scooters ride WITH the racers in
//     both lanes (they pop out of an alley arch with a horn toot, and turn
//     into another alley 72 m later; the centre stays clear);
//   * the gelato esses and Laundry Lane climbing past the houses;
//   * the switchback: two tornanti (a left then a right 180°) zig-zag up the
//     hillside, terraced gardens and roadside shrines between the legs;
//   * the campanile on the 18 m summit and Piazza Alta, whose paving hides a
//     row of dancing fountain jets erupting in a sweeping wave;
//   * the Belvedere viewpoint turn and the stone aqueduct (dash pad + kicker
//     jump; the road falls away beyond the deck);
//   * the Cheese Run: an 8 % descent with big cheese wheels rolling across it
//     from the hillside dairy on the left;
//   * the Espresso chicane (20 m gate), the covered Espresso Works and the
//     pizza-oven final turn (14 m lawn inside: an item-only shortcut) home.
//
// Widths follow the v3 / v4 steering rules (SPEC §14.3, §15.3, §16.1) with
// margin for casual tilt drivers: road half-width >= 10.5 m everywhere, 11.5 m
// through both tornanti, 8 m verges on the outside of each tornante. The two
// straights marked * were solved so the loop closes (track-check: closure <
// 0.1 m).

export const MONTE_DEF = {
  id: 'monte',
  name: 'Monte Mozzarella',
  theme: 'hilltown',           // world kit (worlds.js): 'hilltown' -> world-monte.js, hazards/hilltown.js
  start: { x: 0, y: 0, z: 0, yaw: 0 },
  sampleSpacing: 1.0,

  segments: [
    /* 0 */ { type: 'straight', length: 95, name: 'Piazza Straight' },
    /* 1 */ { type: 'arc', dir: 'left', angle: 90, radius: 34, name: 'Fontana Turn' },
    /* 2 */ { type: 'straight', length: 95, name: 'Via Vespa' },
    /* 3 */ { type: 'arc', dir: 'right', angle: 40, radius: 34, name: 'Gelato Esses A' },
    /* 4 */ { type: 'arc', dir: 'left', angle: 40, radius: 34, name: 'Gelato Esses B' },
    /* 5 */ { type: 'straight', length: 100, name: 'Laundry Lane' },
    /* 6 */ { type: 'arc', dir: 'left', angle: 30, radius: 50, name: 'Laundry Kink A' },
    /* 7 */ { type: 'arc', dir: 'right', angle: 30, radius: 50, name: 'Laundry Kink B' },
    /* 8 */ { type: 'straight', length: 40, name: 'Bakery Row' },
    /* 9 */ { type: 'arc', dir: 'left', angle: 180, radius: 26, name: 'Tornante Uno' },
    /* 10 */ { type: 'straight', length: 90, name: 'Switchback Climb' },
    /* 11 */ { type: 'arc', dir: 'right', angle: 180, radius: 26, name: 'Tornante Due' },
    /* 12 */ { type: 'straight', length: 60, name: 'Campanile Climb' },
    /* 13 */ { type: 'arc', dir: 'left', angle: 90, radius: 30, name: 'Campanile Curve' },
    /* 14 */ { type: 'straight', length: 120.91, name: 'Piazza Alta' },        // *
    /* 15 */ { type: 'arc', dir: 'left', angle: 90, radius: 40, name: 'Belvedere Turn' },
    /* 16 */ { type: 'straight', length: 100.13, name: 'Aqueduct Bridge' },    // *
    /* 17 */ { type: 'arc', dir: 'left', angle: 30, radius: 60, name: 'Vineyard Sweep' },
    /* 18 */ { type: 'straight', length: 90, name: 'Cheese Run' },
    /* 19 */ { type: 'arc', dir: 'right', angle: 30, radius: 40, name: 'Espresso Chicane A' },
    /* 20 */ { type: 'straight', length: 20, name: 'Espresso Gate' },
    /* 21 */ { type: 'arc', dir: 'left', angle: 30, radius: 40, name: 'Espresso Chicane B' },
    /* 22 */ { type: 'straight', length: 40, name: 'Espresso Works' },
    /* 23 */ { type: 'arc', dir: 'left', angle: 60, radius: 40, name: 'Pizza Oven Turn' },
    /* 24 */ { type: 'straight', length: 45, name: 'Home Straight' },
  ],

  // Flat piazza + Via Vespa, Laundry Lane 4.6 %, the tornanti 2.4 % and the
  // Switchback Climb 4.4 %, the Campanile Climb 2.7 % up to the summit
  // plateau at 18 m (Piazza Alta, the Belvedere, the aqueduct deck), then the
  // Cheese Run down at 8.2 %, the Espresso chicane and works ~6 % and the
  // pizza-oven turn onto the flat home straight. Convex grade changes are
  // spread over two keys: only the aqueduct kicker launches karts.
  elevation: [
    [0, 0], [3, 0], [4, 0.3], [5, 0.6], [6, 5.2], [8, 7.0], [9, 8.0], [10, 10], [11, 14], [12, 16],
    [13, 17.6], [13.6, 17.95], [14, 18], [17, 18], [17.55, 17.7], [18, 17.0], [18.12, 16.1], [19, 9.6],
    [22, 6.0], [23, 3.0], [23.81, 0.5], [24, 0.1], [25, 0],
  ],
  // Road half-width (m): 12 in the piazzas and on Piazza Alta (the jets need
  // room), 11 in town, 11.5 through both tornanti and on the Cheese Run,
  // 10.5-10.8 in the Espresso Works.
  halfWidth: [
    [0, 12], [0.85, 12], [1, 11.5], [2, 11], [5, 11], [8.8, 11], [9, 11.5], [10, 11.5],
    [10.2, 11], [10.85, 11], [11, 11.5], [12, 11.5], [12.2, 11], [12.8, 11.5], [14, 12], [15, 12], [15.3, 11],
    [17.8, 11], [18, 11.5], [19, 11.5], [19.2, 10.8], [22, 10.8], [22.1, 10.5], [23, 10.5], [23.2, 11],
    [24, 11.5], [24.6, 12], [25, 12],
  ],
  // Off-road beyond each road edge before the wall (m; the first 1 m is the
  // curb): 8 m on the outside of each tornante (right for Uno, left for Due),
  // 6.5 m outside the Campanile Curve, 5 m of stone parapet strip on the
  // aqueduct, the 14 m lawn inside the pizza-oven turn (item-only shortcut).
  offroadLeft: [
    [0, 6], [1, 8], [2, 4.5], [10.9, 4.5], [11.1, 8], [11.9, 8], [12.1, 4.5], [13, 4.5], [14, 6],
    [15, 5], [16, 5], [17, 5], [17.2, 6], [18, 6], [19, 4.5], [22, 4], [23, 4], [23.15, 14], [23.85, 14],
    [24, 6], [25, 6],
  ],
  offroadRight: [
    [0, 6], [1, 6.5], [2, 4.5], [8.9, 4.5], [9.1, 8], [9.9, 8], [10.1, 4.5], [12.9, 4.5], [13.1, 6.5],
    [13.9, 6.5], [14, 6], [15, 5], [16, 5], [17, 5], [17.2, 8], [18, 7], [19, 4.5], [22, 4], [23, 4],
    [23.15, 5], [24, 6], [25, 6],
  ],
  smoothing: { elevation: 2, halfWidth: 6, offroad: 3 },

  // Five item rows, 230-370 m apart.
  itemRows: [
    { u: 1.85, count: 5 },   // Fontana Turn exit (before the scooters)
    { u: 8.50, count: 4 },   // Bakery Row
    { u: 12.45, count: 4 },  // Campanile Climb
    { u: 16.25, count: 4 },  // aqueduct deck, out of the Belvedere
    { u: 22.40, count: 4 },  // Espresso Works
  ],
  // Dash pads. lateral = offset of the pad center (+ = right).
  boostPads: [
    { u: 1.60, lateral: 7.0, length: 5, width: 3.6 },    // outside of the Fontana Turn (risk/reward)
    { u: 10.50, lateral: 0.0, length: 5, width: 3.6 },   // Switchback Climb (uphill help)
    { u: 16.55, lateral: 0.0, length: 5, width: 4.0 },   // feeds the aqueduct kicker
    { u: 18.88, lateral: 4.0, length: 5, width: 3.6 },   // foot of the Cheese Run, outside line past the last wheel
  ],
  // Kicker: 66 m after the Belvedere, so even a boosted 150cc kart (~35 m
  // flight) lands on the deck end / the first metres of the Vineyard Sweep,
  // nearly straight (track-check verifies the landing envelope).
  ramps: [
    { u: 16.66, length: 7, height: 1.8, lateral: 0, width: 0 },   // aqueduct jump
  ],
  // Coin lines (SPEC §16.1; the items team does pickup / HUD): risky lines pay.
  coins: [
    { u: 2.20, count: 5, lateral: 0, spacing: 6 },      // Via Vespa centre line between the scooter lanes
    { u: 10.15, count: 6, lateral: -4, spacing: 6 },    // Switchback Climb inside line
    { u: 14.15, count: 5, lateral: 0, spacing: 5 },     // Piazza Alta, threading the fountain jets
    { u: 16.85, count: 5, lateral: 0, spacing: 5 },     // aqueduct landing
    { u: 18.35, count: 5, lateral: -5, spacing: 6 },    // Cheese Run uphill side (the wheels come from there)
  ],
  // Course set pieces (hazards/hilltown.js; research-v5-tracks.md Part C):
  //   mover: a scooter rides the lane at `lateral` from u for `length` m at
  //          `speed` m/s, one every `period` s, weaving ±weave m — knock;
  //   jet:   fountain jets across the paving at `lats`, each idle / bubbling
  //          (telegraph) / erupting on its own phase (dphase apart) — knock;
  //   wheel: a cheese wheel (radius m) rolls across the road from side `from`
  //          (-1 = left) over `travel` m at `speed` m/s, `count` per period — tumble.
  hazards: [
    { type: 'mover', u: 2.14, lateral: -4.8, length: 70, speed: 11, period: 7.0, phase: 0.0, weave: 0.6 },
    { type: 'mover', u: 2.14, lateral: 4.8, length: 70, speed: 13, period: 6.0, phase: 0.45, weave: 1.0 },
    { type: 'jet', u: 14.45, lats: [-8, -4, 0, 4, 8], radius: 1.4, period: 4.0, phase: 0.0, dphase: 0.2, effect: 'knock' },
    { type: 'wheel', u: 18.33, from: -1, period: 5.0, phase: 0.0, count: 1, speed: 8, radius: 1.8, travel: 32 },
    { type: 'wheel', u: 18.62, from: -1, period: 5.0, phase: 0.5, count: 1, speed: 8, radius: 1.8, travel: 32 },
  ],

  // Visual hints for world-monte.js (inclusive u ranges).
  zones: [
    { u0: 0.0, u1: 1.6, type: 'piazza' },
    { u0: 24.2, u1: 25.0, type: 'piazza' },
    { u0: 2.0, u1: 9.0, type: 'village' },
    { u0: 9.0, u1: 10.0, type: 'hairpin' },
    { u0: 11.0, u1: 12.0, type: 'hairpin' },
    { u0: 10.0, u1: 13.0, type: 'switchback' },
    { u0: 12.6, u1: 14.0, type: 'summit' },
    { u0: 14.0, u1: 15.0, type: 'piazza-alta' },
    { u0: 16.0, u1: 17.0, type: 'bridge' },     // the stone aqueduct
    { u0: 17.0, u1: 19.0, type: 'vineyard' },
    { u0: 18.0, u1: 19.0, type: 'dairy' },
    { u0: 21.9, u1: 22.9, type: 'tunnel' },     // covered Espresso Works
  ],
};
