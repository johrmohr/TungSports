// Krishiv Links: the nine holes as data (shapes, heights, trees), plus the
// terrain queries the physics and the renderer share. Pure: no DOM, no Three.js.
//
// Hole frame (metres): the tee is at the origin, the hole runs toward −z,
// x is to the right as seen from the tee, y is up.
//
//   const hole = getHole(1);
//   hole.heightAt(x, z)     terrain height
//   hole.normalAt(x, z)     [nx, ny, nz]
//   hole.surfaceAt(x, z)    'tee' | 'fairway' | 'rough' | 'sand' | 'green' | 'fringe' | 'water' | 'ob'
//   hole.trees              [{ x, z, s, kind }]
//   hole.pinFor(i)          pin position i (0..pins-1)

// ---------------------------------------------------------------- noise

function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const fade = (t) => t * t * (3 - 2 * t);
// Smooth value noise in [-1, 1].
export function noise2(x, z, seed = 1) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = fade(x - ix), fz = fade(z - iz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return ((a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz) * 2 - 1;
}
const fbm = (x, z, seed) => noise2(x, z, seed) * 0.65 + noise2(x * 2.1, z * 2.1, seed + 7) * 0.35;

export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1000003) / 1000003; };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- shapes (signed distance, negative inside)

// { e: [x, z, rx, rz, rot] } ellipse · { p: [[x, z, halfWidth], …] } capsule chain · { poly: [[x, z], …] }
function sdEllipse(x, z, [cx, cz, rx, rz, rot = 0]) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const dx = x - cx, dz = z - cz;
  const lx = dx * c + dz * s, lz = -dx * s + dz * c;
  const k = Math.hypot(lx / rx, lz / rz);
  return (k - 1) * Math.min(rx, rz);
}

function sdPath(x, z, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az, aw] = pts[i], [bx, bz, bw] = pts[i + 1];
    const vx = bx - ax, vz = bz - az;
    const l2 = vx * vx + vz * vz || 1e-9;
    const t = clamp(((x - ax) * vx + (z - az) * vz) / l2, 0, 1);
    const d = Math.hypot(x - (ax + vx * t), z - (az + vz * t)) - (aw + (bw - aw) * t);
    if (d < best) best = d;
  }
  return best;
}

function sdPoly(x, z, pts) {
  let d = Infinity, inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, az] = pts[j], [bx, bz] = pts[i];
    const vx = bx - ax, vz = bz - az;
    const l2 = vx * vx + vz * vz || 1e-9;
    const t = clamp(((x - ax) * vx + (z - az) * vz) / l2, 0, 1);
    d = Math.min(d, Math.hypot(x - (ax + vx * t), z - (az + vz * t)));
    if ((az > z) !== (bz > z) && x < ax + ((z - az) / (bz - az)) * vx) inside = !inside;
  }
  return inside ? -d : d;
}

function sdShape(x, z, sh) {
  if (sh.e) return sdEllipse(x, z, sh.e);
  if (sh.p) return sdPath(x, z, sh.p);
  if (sh.poly) return sdPoly(x, z, sh.poly);
  return Infinity;
}

// Axis-aligned bounds of a shape (for quick rejects).
function shapeBox(sh, pad = 0) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const add = (x, z, r) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r); };
  if (sh.e) add(sh.e[0], sh.e[1], Math.max(sh.e[2], sh.e[3]));
  if (sh.p) for (const [x, z, w] of sh.p) add(x, z, w);
  if (sh.poly) for (const [x, z] of sh.poly) add(x, z, 0);
  return [x0 - pad, x1 + pad, z0 - pad, z1 + pad];
}

// ---------------------------------------------------------------- height features
//   { bump: [x, z, r, h] }                       cosine bump (h may be negative)
//   { ebump: [x, z, rx, rz, rot, h] }            elliptical cosine bump
//   { plateau: shape, h, edge }                  raises the inside of a shape by h (smooth edge)
//   { ramp: [x0, z0, x1, z1], h, w, edge }       rises by h from (x0,z0) to (x1,z1) within width w
//   { tilt: [ax, az] }                           plane through the tee: ax·x + az·z

function featureHeight(f, x, z) {
  if (f.bump) {
    const [cx, cz, r, h] = f.bump;
    const d = Math.hypot(x - cx, z - cz);
    return d >= r ? 0 : h * 0.5 * (1 + Math.cos(Math.PI * d / r));
  }
  if (f.ebump) {
    const [cx, cz, rx, rz, rot, h] = f.ebump;
    const c = Math.cos(rot), s = Math.sin(rot);
    const dx = x - cx, dz = z - cz;
    const k = Math.hypot((dx * c + dz * s) / rx, (-dx * s + dz * c) / rz);
    return k >= 1 ? 0 : h * 0.5 * (1 + Math.cos(Math.PI * k));
  }
  if (f.plateau) {
    const d = sdShape(x, z, f.plateau);
    return f.h * (1 - smoothstep(-f.edge, 0, d));
  }
  if (f.ramp) {
    const [x0, z0, x1, z1] = f.ramp;
    const vx = x1 - x0, vz = z1 - z0;
    const l2 = vx * vx + vz * vz;
    const t = ((x - x0) * vx + (z - z0) * vz) / l2;
    const lat = Math.abs((x - x0) * vz - (z - z0) * vx) / Math.sqrt(l2);
    const wk = f.w ? 1 - smoothstep(f.w, f.w + (f.edge || 20), lat) : 1;
    return f.h * smoothstep(0, 1, t) * wk;
  }
  if (f.tilt) return f.tilt[0] * x + f.tilt[1] * z;
  return 0;
}

// ---------------------------------------------------------------- the holes
//
// Krishiv Links, nine original holes: Meadow (1–3), Lakeside (4–6) and
// Clifftop (7–9). Shapes are listed per surface; trees are explicit
// [x, z, size] or scattered in `woods` shapes. `bounds` is the playable area
// (outside = out of bounds). `aim` lists default aiming points for long shots
// (the dogleg corners, the lay-up spots).

const HOLE_DEFS = [
  // 1 · First Tee · Par 4 · 365 yd — a gentle dogleg right. A fairway bunker
  // waits on the left of the corner; the green sits a little uphill.
  {
    n: 1, name: 'First Tee', par: 4, yards: 365, seed: 13,
    tee: [0, 0], teeH: 0.5,
    fairway: [{ p: [[0, -20, 14], [-2, -120, 20], [2, -215, 21], [16, -262, 18], [30, -295, 15]] }],
    green: { e: [38, -322, 15, 12, 0.25] },
    bunkers: [{ e: [-16, -232, 7, 12, 0.1] }, { e: [24, -308, 5, 4, 0.4] }, { e: [56, -326, 4, 7, -0.3] }],
    water: [],
    woods: [{ shape: { p: [[-50, 10, 9], [-52, -150, 10], [-36, -300, 10], [12, -362, 9]] }, density: 0.011 }, { shape: { p: [[48, 10, 9], [52, -140, 10], [70, -230, 10], [82, -330, 9]] }, density: 0.011 }],
    trees: [[-30, -90, 1.2], [32, -110, 1.1], [44, -250, 1.2], [8, -340, 1.0]],
    bounds: { poly: [[-60, 30], [60, 30], [66, -150], [92, -240], [90, -356], [6, -372], [-56, -300], [-62, -150]] },
    heights: [{ bump: [-28, -150, 55, 1.4] }, { ramp: [10, -240, 38, -322], h: 2.0, w: 60, edge: 30 }, { ebump: [44, -328, 9, 7, 0.2, 0.5] }, { ebump: [31, -316, 8, 6, 0, -0.3] }, { plateau: { e: [0, -1, 9, 6] }, h: 0.5, edge: 2 }],
    pins: [[38, -325], [32, -318], [43, -318]],
    aim: [[2, -215]],
    scenery: { hills: 'meadow' },
  },
  // 2 · Long Meadow · Par 5 · 520 yd — an S: left round a grove, then right
  // to the green. A cross bunker cuts the fairway where most lay up.
  {
    n: 2, name: 'Long Meadow', par: 5, yards: 520, seed: 29,
    tee: [0, 0], teeH: 0.6,
    fairway: [{ p: [[0, -20, 14], [-4, -110, 20], [-20, -200, 20], [-30, -260, 18], [-18, -330, 17], [4, -390, 16], [16, -440, 13]] }],
    green: { e: [20, -462, 15, 12, -0.2] },
    bunkers: [{ e: [-6, -378, 14, 3.4, 0.35] }, { e: [22, -215, 7, 12, 0] }, { e: [37, -462, 4, 7, 0.2] }, { e: [5, -472, 4, 6, -0.2] }],
    water: [],
    woods: [
      { shape: { e: [-50, -175, 13, 36, 0] }, density: 0.03 },
      { shape: { e: [30, -330, 12, 26, 0] }, density: 0.03 },
      { shape: { p: [[-50, 10, 9], [-64, -150, 10], [-72, -300, 10], [-42, -420, 9], [-12, -502, 9]] }, density: 0.011 },
      { shape: { p: [[46, 10, 9], [50, -150, 10], [46, -250, 10], [62, -380, 10], [64, -484, 9]] }, density: 0.011 },
    ],
    trees: [[14, -80, 1.2], [-40, -300, 1.1], [44, -440, 1.1]],
    bounds: { poly: [[-60, 30], [56, 30], [60, -200], [56, -280], [74, -380], [72, -500], [-22, -508], [-56, -420], [-82, -300], [-76, -150]] },
    heights: [{ bump: [16, -60, 50, 1.2] }, { bump: [-36, -230, 70, 2.0] }, { ramp: [0, -380, 20, -462], h: 3.0, w: 60, edge: 30 }, { ebump: [26, -468, 9, 7, 0.3, 0.6] }, { ebump: [14, -456, 7, 6, 0, -0.3] }],
    pins: [[20, -465], [13, -458], [27, -457]],
    aim: [[-20, -200], [-18, -330]],
    scenery: { hills: 'meadow' },
  },
  // 3 · Twin Oaks · Par 3 · 140 yd — downhill between two great oaks to a wide,
  // shallow green; a long bunker behind and a pot bunker short right.
  {
    n: 3, name: 'Twin Oaks', par: 3, yards: 140, seed: 41,
    tee: [0, 0], teeH: 2.0,
    fairway: [{ p: [[-3, -80, 10], [-6, -107, 11]] }],
    green: { e: [-6, -126, 18, 9, 0] },
    bunkers: [{ e: [-6, -139, 16, 3.5, 0] }, { e: [11, -113, 4, 3.5, 0.3] }],
    water: [],
    woods: [{ shape: { p: [[-42, 0, 8], [-44, -90, 9], [-38, -158, 9]] }, density: 0.012 }, { shape: { p: [[40, 0, 8], [44, -90, 9], [38, -158, 9]] }, density: 0.012 }, { shape: { p: [[-30, -163, 10], [30, -163, 10]] }, density: 0.012 }],
    trees: [[-24, -64, 1.9], [16, -70, 1.8], [-30, -28, 1.1], [26, -22, 1.0]],
    bounds: { poly: [[-50, 22], [50, 22], [50, -170], [-50, -170]] },
    heights: [{ plateau: { e: [0, 0, 16, 12] }, h: 2.0, edge: 8 }, { bump: [0, -62, 42, -1.0] }, { ebump: [-14, -128, 8, 5, 0, 0.4] }, { ebump: [2, -124, 7, 4, 0, -0.25] }],
    pins: [[-6, -127], [-14, -125], [2, -125]],
    aim: [],
    scenery: { hills: 'meadow' },
  },
  // 4 · Lakeside · Par 4 · 340 yd — the fairway bends right round a lake.
  // The brave carry the water straight at the green; the rest go round.
  {
    n: 4, name: 'Lakeside', par: 4, yards: 340, seed: 53,
    tee: [0, 0], teeH: 0.6,
    fairway: [{ p: [[0, -20, 13], [-12, -110, 19], [-14, -200, 19], [-4, -250, 17], [16, -280, 14]] }],
    green: { e: [32, -300, 14, 12, 0.3] },
    bunkers: [{ e: [-30, -215, 6, 11, 0.1] }, { e: [17, -306, 4, 7, 0.1] }, { e: [36, -317, 8, 3, 0.2] }],
    water: [{ e: [40, -170, 34, 95, 0.12] }],
    woods: [{ shape: { p: [[-50, 10, 9], [-56, -150, 10], [-46, -300, 10], [2, -340, 9]] }, density: 0.011 }, { shape: { p: [[82, 10, 9], [88, -150, 10], [72, -300, 10]] }, density: 0.011 }],
    trees: [[-30, -60, 1.1], [-34, -270, 1.2], [56, -320, 1.0]],
    bounds: { poly: [[-60, 30], [70, 30], [94, -120], [88, -280], [62, -336], [-10, -342], [-62, -260], [-64, -120]] },
    heights: [{ bump: [-34, -140, 50, 1.4] }, { ebump: [38, -305, 9, 7, 0.3, 0.6] }, { ebump: [26, -295, 7, 5, 0, -0.3] }],
    pins: [[32, -302], [26, -296], [38, -296]],
    aim: [[-14, -200]],
    scenery: { hills: 'meadow' },
  },
  // 5 · Peninsula · Par 3 · 140 yd — over a pond to a green with water on
  // three sides; the only bail-out is the bunker behind.
  {
    n: 5, name: 'Peninsula', par: 3, yards: 140, seed: 67,
    tee: [0, 0], teeH: 1.0,
    fairway: [{ e: [0, -107, 12, 4.5, 0] }],
    green: { e: [0, -124, 13, 11, 0] },
    bunkers: [{ e: [0, -139, 8, 3, 0] }, { e: [-11, -113, 3.5, 3, 0.4] }],
    water: [{ e: [0, -70, 30, 30, 0] }, { p: [[-26, -92, 8], [-29, -124, 8], [-20, -148, 8]] }, { p: [[26, -92, 8], [29, -124, 8], [20, -148, 8]] }],
    woods: [{ shape: { p: [[-50, 0, 9], [-52, -90, 10], [-45, -168, 9]] }, density: 0.013 }, { shape: { p: [[50, 0, 9], [52, -90, 10], [45, -168, 9]] }, density: 0.013 }, { shape: { p: [[-34, -172, 9], [34, -172, 9]] }, density: 0.013 }],
    trees: [[-32, -18, 1.1], [30, -12, 1.2]],
    bounds: { poly: [[-58, 22], [58, 22], [58, -180], [-58, -180]] },
    heights: [{ ebump: [0, -125, 18, 15, 0, 1.2] }, { ebump: [4, -128, 7, 5, 0, 0.35] }],
    pins: [[0, -125], [-5, -121], [5, -127]],
    aim: [],
    scenery: { hills: 'forest' },
  },
  // 6 · Three Ponds · Par 5 · 495 yd — a pond left of the drive, one right of
  // the lay-up and one guarding the front left of the green.
  {
    n: 6, name: 'Three Ponds', par: 5, yards: 495, seed: 79,
    tee: [0, 0], teeH: 0.5,
    fairway: [{ p: [[0, -20, 14], [6, -120, 20], [12, -230, 18], [-2, -320, 17], [-6, -390, 15], [0, -420, 13]] }],
    green: { e: [4, -442, 15, 12, 0.1] },
    bunkers: [{ e: [26, -238, 5, 9, 0] }, { e: [21, -448, 4, 7, 0.2] }, { e: [6, -458, 8, 3, 0] }],
    water: [{ e: [-30, -235, 16, 26, 0.2] }, { e: [38, -330, 15, 24, -0.2] }, { e: [-24, -425, 12, 14, 0] }],
    woods: [{ shape: { p: [[-55, 10, 9], [-62, -200, 10], [-55, -470, 9]] }, density: 0.011 }, { shape: { p: [[52, 10, 9], [66, -220, 10], [60, -470, 9]] }, density: 0.011 }],
    trees: [[28, -80, 1.1], [-26, -130, 1.2], [-30, -350, 1.1], [32, -400, 1.0]],
    bounds: { poly: [[-64, 30], [60, 30], [74, -250], [66, -480], [-62, -480], [-70, -250]] },
    heights: [{ bump: [20, -150, 60, 1.3] }, { bump: [-20, -380, 50, 1.0] }, { ebump: [10, -446, 9, 7, 0.2, 0.5] }, { ebump: [-2, -438, 7, 5, 0, -0.3] }],
    pins: [[4, -445], [-2, -438], [10, -438]],
    aim: [[12, -230], [-2, -320]],
    scenery: { hills: 'meadow' },
  },
  // 7 · Cliff Edge · Par 4 · 385 yd — along the cliff top with the sea all down
  // the left (a hook goes in the water); the green is perched near the edge.
  {
    n: 7, name: 'Cliff Edge', par: 4, yards: 385, seed: 83,
    tee: [0, 0], teeH: 0.5,
    waterLevel: -4.5, obWater: true,
    fairway: [{ p: [[0, -20, 14], [6, -120, 19], [2, -220, 19], [-10, -290, 16], [-18, -326, 13]] }],
    green: { e: [-20, -348, 14, 12, 0.2] },
    bunkers: [{ e: [27, -226, 6, 10, 0] }, { e: [-5, -338, 4, 6, 0.3] }, { e: [-22, -364, 7, 3, 0.2] }],
    water: [{ poly: [[-320, 80], [-34, 80], [-30, 0], [-38, -120], [-44, -230], [-46, -330], [-30, -430], [-320, -430]] }],
    woods: [{ shape: { p: [[48, 10, 9], [54, -150, 10], [52, -300, 9], [30, -384, 8]] }, density: 0.014 }],
    trees: [[30, -60, 1.2], [36, -262, 1.1]],
    bounds: { poly: [[-26, 30], [62, 30], [66, -200], [60, -386], [-12, -390], [-36, -340], [-38, -230], [-32, -120], [-24, 0]] },
    heights: [{ plateau: { poly: [[-320, 80], [-34, 80], [-30, 0], [-38, -120], [-44, -230], [-46, -330], [-30, -430], [-320, -430]] }, h: -5, edge: 4 }, { bump: [32, -150, 60, 1.8] }, { ebump: [-14, -352, 8, 6, 0.2, 0.5] }, { ebump: [-25, -342, 6, 5, 0, -0.3] }],
    pins: [[-20, -351], [-14, -345], [-26, -344]],
    aim: [[2, -220]],
    scenery: { hills: 'sea' },
  },
  // 8 · Sea Carry · Par 3 · 200 yd — from one headland to the next, over the
  // sea. Short and left is a little bail-out of short grass.
  {
    n: 8, name: 'Sea Carry', par: 3, yards: 200, seed: 97,
    tee: [0, 0], teeH: 0.4,
    waterLevel: -1.5, baseH: -6,
    fairway: [{ p: [[-18, -150, 8], [-9, -159, 7]] }],
    green: { e: [2, -178, 14, 11, 0.1] },
    bunkers: [{ e: [17, -172, 4, 6, 0.2] }, { e: [-5, -192, 7, 3, 0] }],
    water: [],
    islands: [{ e: [0, -2, 44, 40, 0] }, { e: [2, -182, 50, 42, 0.1] }],
    woods: [],
    trees: [[-26, 8, 1.0], [22, 12, 1.1], [-34, -14, 0.9], [31, -16, 1.0], [-31, -196, 1.0], [35, -200, 1.1], [27, -158, 0.9], [-37, -170, 1.0], [12, -210, 0.9]],
    palms: true,
    bounds: { poly: [[-110, 60], [110, 60], [110, -262], [-110, -262]] },
    heights: [{ plateau: { e: [0, -2, 40, 36, 0] }, h: 5, edge: 3 }, { plateau: { e: [2, -182, 46, 38, 0.1] }, h: 3.5, edge: 3 }, { ebump: [8, -182, 8, 6, 0, 0.45] }, { ebump: [-4, -174, 6, 5, 0, -0.25] }],
    pins: [[2, -178], [-4, -175], [8, -181]],
    aim: [],
    scenery: { hills: 'sea' },
  },
  // 9 · Home · Par 4 · 410 yd — uphill in two steps to the last green.
  // Out of bounds runs close down the whole right side.
  {
    n: 9, name: 'Home', par: 4, yards: 410, seed: 101,
    tee: [0, 0], teeH: 0.5,
    fairway: [{ p: [[0, -20, 14], [-4, -140, 20], [-8, -240, 19], [-4, -310, 16], [2, -345, 13]] }],
    green: { e: [4, -368, 15, 13, 0] },
    bunkers: [{ e: [-30, -165, 7, 12, 0.15] }, { e: [17, -252, 6, 10, 0] }, { e: [-12, -370, 4, 7, 0.2] }, { e: [21, -368, 4, 7, -0.2] }, { e: [4, -385, 9, 3, 0] }],
    water: [],
    woods: [{ shape: { p: [[-50, 10, 9], [-58, -200, 10], [-50, -392, 9]] }, density: 0.013 }, { shape: { p: [[46, 10, 8], [48, -200, 9], [46, -392, 8]] }, density: 0.012 }],
    trees: [[-28, -60, 1.1], [-30, -300, 1.2]],
    bounds: { poly: [[-62, 30], [34, 30], [34, -392], [-62, -398]] },
    heights: [{ ramp: [0, -150, 0, -200], h: 5, w: 80, edge: 30 }, { ramp: [0, -280, 0, -330], h: 4, w: 80, edge: 30 }, { ebump: [10, -372, 9, 7, 0, 0.5] }, { ebump: [-2, -364, 7, 6, 0, -0.3] }],
    pins: [[4, -371], [-3, -364], [10, -364]],
    aim: [[-8, -240]],
    scenery: { hills: 'forest' },
  },
];

// Par of every hole (the scorecard and the rules read it from here).
export const PARS = Object.fromEntries(HOLE_DEFS.map((h) => [h.n, h.par]));

// ---------------------------------------------------------------- Hole

const SURFACES = ['tee', 'fairway', 'rough', 'sand', 'green', 'fringe', 'water', 'ob'];
export const SURFACE_INFO = {
  tee: { name: 'Tee', cap: 1 },
  fairway: { name: 'Fairway', cap: 1 },
  rough: { name: 'Rough', cap: 0.5 },
  sand: { name: 'Bunker', cap: 0.25 },
  green: { name: 'Green', cap: 1 },
  fringe: { name: 'Fringe', cap: 1 },
  water: { name: 'Water', cap: 1 },
  ob: { name: 'Out of bounds', cap: 1 },
};

const FRINGE = 1.6;

class Hole {
  constructor(def) {
    Object.assign(this, def);
    this.def = def;
    this.waterLevel = def.waterLevel ?? -1.2;
    this.baseH = def.baseH ?? 0;
    this.roughCuts = def.roughCuts || [];
    this.islands = def.islands || [];
    // Quick-reject boxes.
    const boxed = (list, pad) => list.map((sh) => ({ sh, box: shapeBox(sh, pad) }));
    this._fair = boxed(def.fairway, 6);
    this._sand = boxed(def.bunkers, 5);
    this._water = boxed(def.water, 8);
    this._cuts = boxed(this.roughCuts, 4);
    this._islands = boxed(this.islands, 12);
    this._greenBox = shapeBox(def.green, FRINGE + 6);
    // Terrain extent: the bounds plus a margin of scenery.
    const b = shapeBox(def.bounds, 70);
    this.extent = { x0: b[0], x1: b[1], z0: b[2], z1: b[3] };
    this.trees = this._plantTrees();
    this.pins = def.pins;
  }

  pinFor(i) { const p = this.pins[((i % this.pins.length) + this.pins.length) % this.pins.length]; return { x: p[0], z: p[1] }; }

  _in(list, x, z, wobble = 0, seed = 0) {
    for (const { sh, box } of list) {
      if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) continue;
      let d = sdShape(x, z, sh);
      if (wobble) d += fbm(x * 0.09, z * 0.09, this.seed + seed) * wobble;
      if (d < 0) return true;
    }
    return false;
  }

  // Signed distance to the green edge (negative on the green).
  greenDist(x, z) {
    return sdShape(x, z, this.green) + noise2(x * 0.15, z * 0.15, this.seed + 5) * 0.5;
  }

  inBounds(x, z) { return sdShape(x, z, this.bounds) < 0; }

  surfaceAt(x, z) {
    if (!this.inBounds(x, z)) return this.obWater && this._isWater(x, z) ? 'water' : 'ob';
    if (this._isWater(x, z)) return 'water';
    if (this._in(this._sand, x, z, 0.9, 3)) return 'sand';
    if (x >= this._greenBox[0] && x <= this._greenBox[1] && z >= this._greenBox[2] && z <= this._greenBox[3]) {
      const g = this.greenDist(x, z);
      if (g < 0) return 'green';
      if (g < FRINGE) return 'fringe';
    }
    const [tx, tz] = this.tee;
    if (Math.abs(x - tx) < 6 && z < tz + 4 && z > tz - 7) return 'tee';
    if (this._in(this._cuts, x, z, 1.5, 9)) return 'rough';
    if (this._in(this._fair, x, z, 2.2, 1)) return 'fairway';
    return 'rough';
  }

  _isWater(x, z) {
    if (this.islands.length) return this.heightAt(x, z) < this.waterLevel;
    return this._in(this._water, x, z, 1.4, 7) || (this._water.length > 0 && this.heightAt(x, z) < this.waterLevel - 0.05);
  }

  heightAt(x, z) {
    let h = this.baseH;
    for (const f of this.heights) h += featureHeight(f, x, z);
    // Islands rise out of the sea.
    for (const { sh, box } of this._islands) {
      if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) continue;
      const d = sdShape(x, z, sh) + fbm(x * 0.07, z * 0.07, this.seed + 13) * 3;
      h += (-this.baseH + 0.9) * (1 - smoothstep(-6, 4, d));
    }
    // Water basins.
    for (const { sh, box } of this._water) {
      if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) continue;
      const d = sdShape(x, z, sh) + fbm(x * 0.09, z * 0.09, this.seed + 7) * 1.4;
      const k = 1 - smoothstep(-4, 3, d);
      if (k > 0) h = h * (1 - k) + Math.min(h, this.waterLevel - 1.6) * k;
    }
    // Bunkers are dished a little.
    for (const { sh, box } of this._sand) {
      if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) continue;
      const d = sdShape(x, z, sh) + fbm(x * 0.09, z * 0.09, this.seed + 3) * 0.9;
      h -= 0.45 * (1 - smoothstep(-2.5, 0.6, d));
    }
    // A raised tee box.
    const [tx, tz] = this.tee;
    const td = Math.max(Math.abs(x - tx) - 5.5, Math.abs(z - (tz - 1.5)) - 5);
    h += (this.teeH || 0) * (1 - smoothstep(0, 4, td));
    // Gentle undulation everywhere but the greens (they get their own bumps).
    const gd = this.greenDist(x, z);
    const roll = fbm(x * 0.02, z * 0.02, this.seed + 21) * 0.9 + noise2(x * 0.11, z * 0.11, this.seed + 22) * 0.12;
    h += roll * smoothstep(1, 12, gd);
    return h;
  }

  normalAt(x, z, e = 0.15) {
    const hx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const hz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    const l = Math.hypot(hx, 1, hz);
    return [-hx / l, 1 / l, -hz / l];
  }

  _plantTrees() {
    const r = rng(this.seed * 977 + 13);
    const out = [];
    const add = (x, z, s, kind) => {
      for (const t of out) if (Math.hypot(t.x - x, t.z - z) < 4.2 * Math.max(s, t.s)) return;
      const surf = this.surfaceAt(x, z);
      if (surf !== 'rough' && surf !== 'ob') return;
      if (this.heightAt(x, z) < this.waterLevel + 0.4) return;
      out.push({ x, z, s, kind });
    };
    const kind = () => (this.palms ? 'palm' : r() < 0.72 ? 'round' : 'cone');
    for (const [x, z, s] of this.def.trees || []) add(x, z, s, this.palms ? 'palm' : 'round');
    for (const w of this.def.woods || []) {
      const box = shapeBox(w.shape, 0);
      const area = (box[1] - box[0]) * (box[3] - box[2]);
      const tries = Math.round(area * w.density * 2.2);
      for (let i = 0; i < tries; i++) {
        const x = box[0] + r() * (box[1] - box[0]);
        const z = box[2] + r() * (box[3] - box[2]);
        if (sdShape(x, z, w.shape) > 0) continue;
        if (w.gap && sdPath(x, z, w.gap.p) < w.gap.w) continue;
        add(x, z, 0.85 + r() * 0.5, kind());
      }
    }
    return out;
  }

  // Distance from (x, z) to the pin.
  distToPin(x, z, pin) { return Math.hypot(x - pin.x, z - pin.z); }
}

const cache = new Map();
export function getHole(n) {
  if (!cache.has(n)) {
    const def = HOLE_DEFS.find((h) => h.n === n);
    if (!def) throw new Error(`No hole ${n}`);
    cache.set(n, new Hole(def));
  }
  return cache.get(n);
}
export const HOLE_NUMBERS = HOLE_DEFS.map((h) => h.n);
export { SURFACES };
