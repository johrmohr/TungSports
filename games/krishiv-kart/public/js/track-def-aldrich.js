// Layout data for Aldrich Park (v5, SPEC §16.1, registered in tracks.js).
// Node-safe, pure data. PATH MODE (track.js): the centreline is a closed
// centripetal Catmull-Rom spline through `path`; every `u` below is a LAP
// FRACTION 0..1 (track.sOfU(u) = u x length; the lap is 1518 m).
//
// Rebuilt from the real place (notes/research-v5-aldrich.md, notes/v5-track-aldrich.md):
// the circle of Aldrich Park at the heart of the UC Irvine campus, the Ring
// Mall walkway round it and the paths inside it. Driven CLOCKWISE (net -360°):
//   * the Ring Mall from the administration gateway past the main library,
//     up the Social Science Rise, over the Engineering Bridge and along
//     Engineering Row (≈ 55 % of the lap, R 250-280 m, rolling 23-35 m a.s.l.);
//   * the Grove Turn off the Ring down the Alumni Grove spoke, Parkview Corner
//     onto the Inner Ring, past the Infinity Fountain plaza, the eucalyptus
//     sweeper into the West Gate, the unpaved West Gate path, the Meadow Hub,
//     the gravel Meadow Spine past the knoll and the Rock Garden, the Arroyo
//     Jump over the park's lowest point, the sculpture-garden corridor and the
//     Arch Corner back onto the Ring beside the Humanities Bridge.
// The Ring and the paths follow the real OpenStreetMap geometry; the five park
// corners (Grove Turn R30, Parkview R28, West Gate R28, Meadow Hub R34, Arch
// Corner R34) are constant-radius fillets between the real paths' straight
// legs, the way a road designer joins two paths at a junction: within 2.8 m of
// the real paths for 90 % of the lap (10 m at most), and drift-friendly
// (a steady radius, a straight between every pair of corners).
//
// Coordinates: metres, x = east, z = south (north = -z), origin = the Aldrich
// Park polygon centroid (33.645929 N, 117.842738 W). Elevation = USGS 3DEP
// 1 m lidar terrain along the line minus 17.0 m.
// Geometry derived from OpenStreetMap data, © OpenStreetMap contributors,
// available under the Open Database License (ODbL 1.0); elevation courtesy
// USGS 3D Elevation Program (public domain).
//
// Set pieces (hazards/campus.js): Ring Mall bike crossings at the two real
// service-road crossings, the fountain's mallard pair crossing the Inner
// Ring, and the meadow's impact sprinklers.

export const ALDRICH_DEF = {
  id: 'aldrich',
  name: 'Aldrich Park',
  theme: 'campus',             // world kit (worlds.js): 'campus' -> world-aldrich.js; hazards/campus.js
  sampleSpacing: 1.0,
  // closed control points [x, z]; path[0] = start / finish, order = driving direction
  path: [
    [139.4, -217.5], [163.1, -204.7], [181.8, -193.2], [207.2, -173.8], [230.8, -152.2], [245.6, -135.9],
    [258.2, -117.9], [272, -93.5], [281.3, -73.6], [288.1, -52.7], [291.8, -31.1], [292.4, -9.1],
    [290.5, 12.8], [286.8, 34.5], [281.4, 55.8], [274.1, 76.5], [260.2, 105.3], [249.2, 124.4],
    [236.4, 142.3], [215.1, 166.1], [199.1, 181.2], [181.9, 194.9], [163, 206.1], [143.1, 215.4],
    [115.4, 231.3], [109, 234.9], [102.4, 238.6], [95.7, 242.4], [89.1, 246.1], [82.4, 249.9],
    [75.8, 253.6], [72.3, 255.3], [68.6, 256.5], [64.8, 257.2], [61, 257.4], [57.1, 257.2],
    [53.3, 256.4], [49.7, 255.2], [46.2, 253.5], [43, 251.4], [40, 248.9], [37.5, 246],
    [35.3, 242.8], [33.5, 239.4], [32.2, 235.7], [31.4, 232], [31.1, 228.1], [31.2, 224.3],
    [32.1, 215.9], [33, 207.6], [33.9, 199.3], [34.8, 191], [35, 189], [35.7, 181.8],
    [36.5, 174.7], [37.3, 167.6], [38, 160.5], [38.2, 156.7], [37.8, 153], [37, 149.4],
    [35.7, 145.9], [33.9, 142.6], [31.7, 139.6], [29.2, 136.9], [26.3, 134.6], [23.1, 132.6],
    [19.6, 131.2], [16.1, 130.1], [12.4, 129.6], [8.7, 129.5], [1.4, 129.9], [-5.9, 130.3],
    [-13.1, 130.7], [-20.4, 131.1], [-26.1, 131.2], [-47.9, 128.4], [-56.7, 126.6], [-74.9, 118.4],
    [-92.7, 105.5], [-108.2, 90], [-120.1, 74.7], [-124.4, 68.7], [-128.7, 62.7], [-133, 56.7],
    [-135, 53.4], [-136.6, 49.8], [-137.6, 46], [-138.2, 42.1], [-138.1, 38.1], [-137.5, 34.3],
    [-136.4, 30.5], [-134.8, 26.9], [-132.6, 23.6], [-130, 20.6], [-127.1, 18], [-123.8, 15.9],
    [-120.2, 14.2], [-116.5, 13.1], [-112.6, 12.5], [-105.8, 11.9], [-99, 11.3], [-92.2, 10.8],
    [-90.2, 10.6], [-82.4, 9.9], [-74.7, 9.3], [-70.9, 8.8], [-67.2, 7.8], [-63.7, 6.5],
    [-60.3, 4.7], [-57.1, 2.6], [-54.2, 0.2], [-51.6, -2.6], [-49.3, -5.6], [-47.4, -8.9],
    [-45.8, -12.3], [-44.6, -16], [-42.4, -24.4], [-40.2, -32.8], [-37.2, -44.1], [-29.3, -73],
    [-22.3, -104.2], [-17.8, -125.7], [-13.9, -139.2], [-12.3, -153], [-13, -175], [-11.5, -207],
    [-11.4, -209.4], [-10.9, -216.7], [-10.5, -224], [-10.1, -231.3], [-9.6, -235.3], [-8.7, -239.1],
    [-7.3, -242.9], [-5.5, -246.4], [-3.3, -249.7], [-0.7, -252.8], [2.2, -255.5], [5.4, -257.8],
    [8.8, -259.8], [12.5, -261.4], [16.3, -262.5], [20.2, -263.1], [24.2, -263.3], [28.2, -263],
    [32.1, -262.3], [35.9, -261.1], [43, -258.5], [50, -255.8], [57.1, -253.1], [64.2, -250.5],
    [71.2, -247.8], [78.3, -245.1], [85.4, -242.5], [90.5, -240.5], [119.8, -227.7],
  ],

  // Real heights (lidar - 17 m). Overrides: the Engineering Bridge deck (the
  // lidar reads the service road 8 m below), the Grove Turn drop spread over
  // ~120 m (7 %), the Arch climb up the Ring embankment over ~80 m (6 %).
  elevation: [
    [0, 9.78], [0.0359, 9.97], [0.0921, 11.11], [0.1454, 16.09], [0.1745, 15.97], [0.2074, 18.06],
    [0.2733, 17.29], [0.316, 17.9], [0.3392, 17.04], [0.4051, 17.9], [0.4951, 9.56], [0.5455, 12.44],
    [0.5717, 15.25], [0.6007, 16.14], [0.6337, 15.11], [0.6698, 13.09], [0.7046, 9.57], [0.7252, 8.36],
    [0.7682, 2.98], [0.8273, 0.51], [0.8467, 0.93], [0.9024, 5.9], [0.9467, 7.72], [0.969, 10.06],
  ],
  // Half-width: 10.5 on the Ring, 11 on the Gateway Plaza (grid), 9.5 only at
  // real pinch points (the bridge deck, the spine, the sculpture corridor),
  // ≥ 10 out of every corner tighter than R30 (tilt drivers).
  halfWidth: [
    [0, 11], [0.0388, 11], [0.0678, 10.5], [0.2326, 10.5], [0.2462, 9.5], [0.2753, 9.5], [0.2888, 10.5],
    [0.3877, 10.5], [0.4864, 10.5], [0.496, 10], [0.5008, 10.5], [0.561, 10.5], [0.5755, 10], [0.6288, 10],
    [0.6385, 10.5], [0.7017, 10.5], [0.7133, 10], [0.7361, 10.5], [0.7508, 10.5], [0.7653, 9.5], [0.7944, 10],
    [0.8283, 10], [0.8428, 9.5], [0.8719, 9.5], [0.8815, 10], [0.9371, 10], [0.9515, 10.5], [0.9758, 11],
  ],
  // Verges (curb + grass / paving up to the barrier). Left on the Ring = the
  // building side (plazas, podiums), right = the park side (lawn, hedge).
  // 2.5 m only at the bridge rails, a podium and the statues; wide lawns at the
  // corner exits (drift run-off) and 12 m inside the West Gate and the Meadow
  // Hub = the boost shortcuts across the grass.
  offroadLeft: [
    [0, 5], [0.0678, 4.5], [0.1163, 4.5], [0.1241, 2.5], [0.1357, 2.5], [0.1454, 4.5], [0.2326, 4.5],
    [0.2462, 2.5], [0.2753, 2.5], [0.2888, 4], [0.3053, 3], [0.378, 3], [0.3925, 4.5], [0.4071, 6],
    [0.4767, 6], [0.496, 5.5], [0.5117, 5.5], [0.5465, 5.5], [0.5561, 5.5], [0.5707, 7], [0.5998, 7],
    [0.6143, 4.5], [0.6385, 4.5], [0.7017, 4.5], [0.7133, 5], [0.7232, 10], [0.7332, 12.5], [0.7527, 12.5],
    [0.7624, 10], [0.7798, 6], [0.8186, 6], [0.838, 2.5], [0.8768, 2.5], [0.8864, 5], [0.9323, 5],
    [0.9612, 5],
  ],
  offroadRight: [
    [0, 5], [0.0678, 5], [0.0824, 4], [0.1018, 4], [0.1115, 5], [0.2326, 5], [0.2462, 2.5],
    [0.2753, 2.5], [0.2888, 5], [0.3199, 5], [0.3276, 2.5], [0.3392, 2.5], [0.3489, 5], [0.3974, 5],
    [0.4071, 3.5], [0.4164, 3.5], [0.4359, 6], [0.4625, 6], [0.4767, 10], [0.496, 10], [0.5183, 7],
    [0.561, 7], [0.6191, 7], [0.6462, 12], [0.6901, 12], [0.7066, 7.5], [0.7232, 7.5], [0.7361, 6],
    [0.7604, 6], [0.8186, 6], [0.8477, 5], [0.8815, 4], [0.8974, 2.5], [0.9275, 2.5], [0.9467, 5],
  ],
  smoothing: { elevation: 8, halfWidth: 6, offroad: 3 },

  itemRows: [
    { u: 0.1066, count: 5 },    // Social Science Rise
    { u: 0.3489, count: 5 },    // Engineering Row, after the bridge
    { u: 0.6211, count: 4 },    // Inner Ring, after the ducks
    { u: 0.8622, count: 4 },    // sculpture garden, after the Arroyo landing
  ],
  boostPads: [
    { u: 0.2258, lateral: -4, length: 5, width: 3.6 },   // outside line into the Engineering Bridge (feeds the side kicker)
    { u: 0.5532, lateral: 3.5, length: 5, width: 3.6 },  // Parkview Corner exit, inside of the Inner Ring sweep
    { u: 0.7866, lateral: 0, length: 5, width: 4 },      // feeds the Arroyo Jump
    { u: 0.9438, lateral: 3, length: 5, width: 3.6 },    // Arch Corner exit onto the Student Center straight
  ],
  ramps: [
    { u: 0.2309, length: 6, height: 1.3, lateral: -4, width: 4.4 },   // the Ecology Sweep hop: a side kicker after the pad, onto the Engineering Bridge
    { u: 0.8021, length: 7, height: 1.6, lateral: 0, width: 0 },   // the Arroyo Jump over the dry creek swale
  ],
  // Lire lines (v5 coins): on the racing line and on the risky lines (bridge
  // deck centre, between the sprinklers, the Arroyo landing).
  coins: [
    { u: 0.0339, count: 6, lateral: 3, spacing: 4 },
    { u: 0.1454, count: 6, lateral: -4, spacing: 4 },
    { u: 0.2539, count: 5, lateral: 0, spacing: 4 },
    { u: 0.3858, count: 5, lateral: 5, spacing: 4 },
    { u: 0.4844, count: 4, lateral: 0, spacing: 4 },
    { u: 0.5998, count: 5, lateral: 4, spacing: 4 },
    { u: 0.7046, count: 4, lateral: 0, spacing: 4 },
    { u: 0.7624, count: 5, lateral: -3, spacing: 4 },
    { u: 0.8244, count: 4, lateral: 0, spacing: 4 },
    { u: 0.8787, count: 5, lateral: 3, spacing: 4 },
    { u: 0.9593, count: 6, lateral: -3, spacing: 4 },
  ],

  // Named stretches (path mode has no segment names; the world kit and the dev
  // page find landmarks by these).
  sections: [
    { u0: 0, u1: 0.0388, name: 'Gateway Plaza' }, { u0: 0.0388, u1: 0.0872, name: 'Library Mall' },
    { u0: 0.0872, u1: 0.2084, name: 'Social Science Rise' }, { u0: 0.2084, u1: 0.2462, name: 'Ecology Sweep' },
    { u0: 0.2462, u1: 0.2753, name: 'Engineering Bridge' }, { u0: 0.2753, u1: 0.4042, name: 'Engineering Row' },
    { u0: 0.4042, u1: 0.4747, name: 'Grove Turn' }, { u0: 0.4747, u1: 0.4932, name: 'Alumni Grove' },
    { u0: 0.4932, u1: 0.5523, name: 'Parkview Corner' }, { u0: 0.5523, u1: 0.6395, name: 'Fountain Walk' },
    { u0: 0.6395, u1: 0.694, name: 'West Gate' }, { u0: 0.694, u1: 0.7104, name: 'West Gate Path' },
    { u0: 0.7104, u1: 0.742, name: 'Meadow Hub' }, { u0: 0.742, u1: 0.8196, name: 'Meadow Spine' },
    { u0: 0.8196, u1: 0.836, name: 'North Gate' }, { u0: 0.836, u1: 0.8738, name: 'Sculpture Garden' },
    { u0: 0.8738, u1: 0.9332, name: 'Arch Corner' }, { u0: 0.9332, u1: 1, name: 'Student Center Straight' },
  ],
  zones: [
    { u0: 0, u1: 0.0436, type: 'plaza' }, { u0: 0.9332, u1: 1, type: 'plaza' },
    { u0: 0.0436, u1: 0.4042, type: 'ring' },       // Ring Mall: buildings outside (left), lawns + groves inside (right)
    { u0: 0.2462, u1: 0.2753, type: 'bridge' },     // Engineering Bridge: deck + white rails, service road 8 m below
    { u0: 0.4042, u1: 0.4932, type: 'grove' },      // Alumni Grove spoke
    { u0: 0.4932, u1: 0.7104, type: 'innerRing' },  // park edge: lawn right, eucalyptus + science halls left
    { u0: 0.5755, u1: 0.6114, type: 'fountain' },   // Infinity Fountain plaza (left) — the ducks' home
    { u0: 0.6462, u1: 0.6901, type: 'shortcut' },   // West Gate inside lawn (12 m verge, boost corner-cut)
    { u0: 0.694, u1: 0.7104, type: 'dirt' },       // unpaved West Gate path
    { u0: 0.7104, u1: 0.8196, type: 'meadow' },     // gravel spine across the central meadow
    { u0: 0.7232, u1: 0.7459, type: 'shortcut' }, // Meadow Hub inside lawn (12 m verge)
    { u0: 0.7992, u1: 0.838, type: 'arroyo' },   // dry creek swale + the jump
    { u0: 0.836, u1: 0.8738, type: 'sculpture' }, // four statues on plinths, left
    { u0: 0.8738, u1: 0.9332, type: 'arch' },     // the climb onto the Ring; the Humanities Bridge arch on the left
  ],

  // Course set pieces (hazards/campus.js; pure functions of the race clock).
  hazards: [
    // Ring Mall bike crossings at the two real service-road crossings: two
    // riders per crossing in opposite lanes (rider A from the left / building
    // side, rider B from the right / park side, half a period apart). Each
    // waits beyond the barrier ringing its bell (telegraph), crosses wall to
    // wall at `speed` m/s, then rides off down the service road.
    { type: 'cyclist', u: 0.0872, speed: 5.5, period: 9.0, phase: 0.00, riders: 2 },                  // library service road
    { type: 'cyclist', u: 0.1861, speed: 4.5, period: 10.0, phase: 0.35, riders: 2, skater: 1 },      // Brandywine service road (rider B on a skateboard)
    // The Infinity Fountain's resident mallard pair waddles in file from the
    // plaza verge to just past the centre line and back. The right half of the
    // road is always clear.
    { type: 'ducks', u: 0.6027, lateral0: -13, lateral1: 1, speed: 1.3, period: 24, phase: 0.0 },
    // Impact sprinklers on the meadow verges, two irrigation zones taking
    // turns: a head pops up (telegraph), then its jet makes one slow sweep of
    // a 140° fan across the road (reaching 0.5 m past the centre line) for 40 %
    // of the period; the other half of the spine is dry meanwhile. Wet tyres =
    // -30 % top speed briefly. The lire line between them is the risk/reward.
    { type: 'sprinkler', u: 0.7576, lateral: -12, reach: 12.5, arc: 140, period: 8.0, phase: 0.0, run: 0.4 },
    { type: 'sprinkler', u: 0.7707, lateral: 12, reach: 12.5, arc: 140, period: 8.0, phase: 0.5, run: 0.4 },
  ],
};
