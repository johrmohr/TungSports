// Golf ball flight, bounce and roll over a hole's terrain (pure, deterministic:
// the TV simulates a whole shot the moment it is struck, then plays it back).
//
//   const shot = simulateShot(hole, { from, aim, club, power, curve, wind, pin, seed });
//   shot.samples   [{ t, x, y, z }] every 1/120 s
//   shot.result    'rest' | 'holed' | 'water' | 'ob'
//   shot.rest      { x, y, z, surface }   where it stopped (or went in / was lost)
//   shot.events    [{ t, type: 'land' | 'bounce' | 'tree' | 'trunk' | 'flag' | 'lip' | 'cup' | 'splash' | 'ob', … }]
//
// Four clubs: driver, iron, wedge and putter. A swing's power
// 0..1 maps linearly to carry (1 = the red dot = the club's full carry with no
// wind on flat ground); the lie caps it (rough: 2 dots, bunker: 1 dot) and a
// swing past the cap is an overswing that hooks or slices.

export const GBALL = { r: 0.02135, m: 0.04593 };
const G = 9.81;
const RHO = 1.21;
const AREA = Math.PI * GBALL.r * GBALL.r;
const K = 0.5 * RHO * AREA / GBALL.m;
export const CUP_R = 0.054;
export const FLAG_H = 2.13;
const DT = 1 / 240;
const RECORD_EVERY = 2;                      // samples at 120 Hz
const RPM = Math.PI / 30;

export const CLUBS = {
  driver: { id: 'driver', name: 'Driver', short: '1W', launch: 12.5, spin: 2700, maxCarry: 250 },
  iron: { id: 'iron', name: 'Iron', short: 'I', launch: 21, spin: 5600, maxCarry: 140 },
  wedge: { id: 'wedge', name: 'Wedge', short: 'W', launch: 37, spin: 8200, maxCarry: 91 },
  putter: { id: 'putter', name: 'Putter', short: 'P', putter: true, maxCarry: 36.6 },
};
export const CLUB_ORDER = ['driver', 'iron', 'wedge', 'putter'];

// Rolling resistance (m/s²), bounce restitution and friction per surface.
// `turf`: share of the along-ground speed the grass gives back on a bounce.
export const SURF = {
  tee: { roll: 1.7, e: 0.34, mu: 0.42, turf: 0.62 },
  fairway: { roll: 1.7, e: 0.34, mu: 0.42, turf: 0.62 },
  green: { roll: 0.55, e: 0.24, mu: 0.5, turf: 0.62 },
  fringe: { roll: 1.1, e: 0.24, mu: 0.5, turf: 0.58 },
  rough: { roll: 4.6, e: 0.14, mu: 0.62, turf: 0.42 },
  sand: { roll: 12, e: 0.03, mu: 0.9, turf: 0.15 },
  ob: { roll: 2.5, e: 0.2, mu: 0.6, turf: 0.5 },
  water: { roll: 50, e: 0, mu: 1, turf: 0 },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1000003) / 1000003; };
}

// ---------------------------------------------------------------- air

// Aerodynamic acceleration on a ball (velocity v, spin w) in a wind (horizontal).
function airAccel(v, w, wind, out) {
  const rx = v[0] - wind[0], ry = v[1], rz = v[2] - wind[2];
  const sp = Math.hypot(rx, ry, rz);
  out[0] = 0; out[1] = -G; out[2] = 0;
  if (sp < 1e-3) return out;
  const cd = sp > 32 ? 0.24 : 0.24 + 0.14 * (32 - sp) / 32;
  out[0] -= K * cd * sp * rx; out[1] -= K * cd * sp * ry; out[2] -= K * cd * sp * rz;
  const ws = Math.hypot(w[0], w[1], w[2]);
  if (ws > 1) {
    const S = GBALL.r * ws / sp;
    const cl = Math.min(0.26, 0.4 * Math.pow(S, 0.4));
    const cx = w[1] * rz - w[2] * ry, cy = w[2] * rx - w[0] * rz, cz = w[0] * ry - w[1] * rx;
    const k = K * cl * sp / ws;
    out[0] += k * cx; out[1] += k * cy; out[2] += k * cz;
  }
  return out;
}

const windAt = (wind, y) => {
  const k = clamp(0.55 + Math.max(0, y) / 45, 0.55, 1);
  return [wind[0] * k, 0, wind[2] * k];
};

// Backspin axis for a ball travelling along (dx, dz), tilted by `tilt`
// radians (+ = the axis leans left: the ball curves left).
function spinAxis(dx, dz, tilt) {
  const l = Math.hypot(dx, dz) || 1;
  const rx = -dz / l, rz = dx / l;                   // right of travel
  const c = Math.cos(tilt), s = Math.sin(tilt);
  return [rx * c, s, rz * c];
}

// Carry (flat ground, no wind) for a launch speed — the club tables below.
function flatCarry(club, v0) {
  const th = club.launch * Math.PI / 180;
  const v = [0, v0 * Math.sin(th), -v0 * Math.cos(th)];
  const spin = club.spin * RPM * clamp(v0 / 60, 0.35, 1.2);
  const ax = spinAxis(0, -1, 0);
  const w = [ax[0] * spin, ax[1] * spin, ax[2] * spin];
  const p = [0, 0.02, 0];
  const a = [0, 0, 0];
  for (let i = 0; i < 6000; i++) {
    airAccel(v, w, [0, 0, 0], a);
    v[0] += a[0] * DT; v[1] += a[1] * DT; v[2] += a[2] * DT;
    p[0] += v[0] * DT; p[1] += v[1] * DT; p[2] += v[2] * DT;
    if (p[1] < 0 && v[1] < 0) return -p[2];
  }
  return -p[2];
}

const tables = new Map();
function table(club) {
  if (!tables.has(club.id)) {
    const rows = [];
    for (let v = 3; v <= 120; v += 1) rows.push([v, flatCarry(club, v)]);
    tables.set(club.id, rows);
  }
  return tables.get(club.id);
}

// Launch speed (m/s) that carries `carry` metres on flat ground in still air.
export function launchSpeedFor(clubId, carry) {
  const club = CLUBS[clubId];
  const rows = table(club);
  if (carry <= rows[0][1]) return rows[0][0] * carry / Math.max(1e-6, rows[0][1]);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][1] >= carry) {
      const [v0, c0] = rows[i - 1], [v1, c1] = rows[i];
      return v0 + (v1 - v0) * (carry - c0) / Math.max(1e-6, c1 - c0);
    }
  }
  return rows[rows.length - 1][0];
}

// ---------------------------------------------------------------- the shot

// Spatial lookup for trees.
function treeGrid(trees) {
  const cell = 16, map = new Map();
  for (const t of trees) {
    const k = `${Math.floor(t.x / cell)},${Math.floor(t.z / cell)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return (x, z) => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    const out = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const l = map.get(`${cx + i},${cz + j}`); if (l) out.push(...l); }
    return out;
  };
}

// Tree shape in world units (shared with the renderer).
export function treeShape(t, groundY) {
  const s = t.s;
  if (t.kind === 'palm') return { trunkR: 0.22 * s, trunkTop: groundY + 6.2 * s, cx: 0, cy: groundY + 6.6 * s, rx: 2.6 * s, ry: 1.2 * s };
  if (t.kind === 'cone') return { trunkR: 0.32 * s, trunkTop: groundY + 2.2 * s, cx: 0, cy: groundY + 5.6 * s, rx: 2.4 * s, ry: 4.0 * s };
  return { trunkR: 0.34 * s, trunkTop: groundY + 2.4 * s, cx: 0, cy: groundY + 5.2 * s, rx: 3.1 * s, ry: 2.9 * s };
}

export function simulateShot(hole, opts) {
  const { from, aim = 0, clubId = 'driver', power = 0.8, curve = 0, wind = [0, 0, 0], pin, seed = 1, putterMax = null } = opts;
  const club = CLUBS[clubId];
  const rand = rng(seed * 7919 + 17);
  const trees = treeGrid(hole.trees);
  const samples = [];
  const events = [];
  const dir = [Math.sin(aim), 0, -Math.cos(aim)];
  const startY = hole.heightAt(from.x, from.z) + GBALL.r + (from.teed ? 0.03 : 0);
  const p = [from.x, startY, from.z];
  let v, w;
  let rolling = false;
  if (club.putter) {
    const maxD = putterMax ?? club.maxCarry;
    const d = Math.max(0, power) * maxD;
    const sp = Math.sqrt(2 * SURF.green.roll * d);
    v = [dir[0] * sp, 0, dir[2] * sp];
    w = [0, 0, 0];
    rolling = true;
  } else {
    const carry = Math.max(0.5, power * club.maxCarry);
    const v0 = launchSpeedFor(clubId, carry);
    const th = club.launch * Math.PI / 180;
    // A curving shot starts a touch the other way (push / pull).
    const start = aim - curve * 0.03;
    const d = [Math.sin(start), 0, -Math.cos(start)];
    v = [d[0] * v0 * Math.cos(th), v0 * Math.sin(th), d[2] * v0 * Math.cos(th)];
    const spin = club.spin * RPM * clamp(v0 / 60, 0.35, 1.2);
    const axis = spinAxis(d[0], d[2], -curve * 0.55);
    w = [axis[0] * spin, axis[1] * spin, axis[2] * spin];
  }

  const a = [0, 0, 0];
  let t = 0, step = 0;
  let landed = null;          // first touchdown
  let result = 'rest';
  let surface = hole.surfaceAt(p[0], p[2]);
  let stillFor = 0;
  let inCanopy = false;
  let lipped = false;
  const record = () => samples.push({ t, x: p[0], y: p[1], z: p[2] });
  record();

  const pinGround = pin ? hole.heightAt(pin.x, pin.z) : 0;
  const finish = (res, extra = {}) => { result = res; events.push({ t, type: res === 'holed' ? 'cup' : res === 'water' ? 'splash' : res === 'ob' ? 'ob' : 'rest', x: p[0], z: p[2], ...extra }); };

  for (step = 0; step < 240 * 40; step++) {
    t += DT;
    const ground = hole.heightAt(p[0], p[2]);
    if (!rolling) {
      // ---- in the air
      airAccel(v, w, windAt(wind, p[1] - ground), a);
      v[0] += a[0] * DT; v[1] += a[1] * DT; v[2] += a[2] * DT;
      p[0] += v[0] * DT; p[1] += v[1] * DT; p[2] += v[2] * DT;
      const decay = Math.exp(-DT / 20);
      w[0] *= decay; w[1] *= decay; w[2] *= decay;
      // Trees: canopies soak up the ball, trunks bounce it back.
      let canopyNow = false;
      for (const tr of trees(p[0], p[2])) {
        const gy = hole.heightAt(tr.x, tr.z);
        const sh = treeShape(tr, gy);
        const dx = p[0] - tr.x, dz = p[2] - tr.z;
        const dh = Math.hypot(dx, dz);
        if (p[1] < sh.trunkTop && dh < sh.trunkR + GBALL.r) {
          const nx = dx / (dh || 1), nz = dz / (dh || 1);
          const vn = v[0] * nx + v[2] * nz;
          if (vn < 0) {
            v[0] -= 1.5 * vn * nx; v[2] -= 1.5 * vn * nz;
            v[0] *= 0.6; v[2] *= 0.6;
            events.push({ t, type: 'trunk', x: p[0], z: p[2] });
          }
        }
        const ky = (p[1] - sh.cy) / sh.ry;
        const k = Math.hypot(dx / sh.rx, ky, dz / sh.rx);
        if (k < 1) {
          canopyNow = true;
          const damp = Math.exp(-DT * (4.5 * (1 - k * 0.6)));
          v[0] *= damp; v[1] *= damp; v[2] *= damp;
          v[0] += (rand() - 0.5) * 6 * DT * Math.hypot(v[0], v[2]);
          v[2] += (rand() - 0.5) * 6 * DT * Math.hypot(v[0], v[2]);
          w[0] *= 0.98; w[1] *= 0.98; w[2] *= 0.98;
        }
      }
      if (canopyNow && !inCanopy) events.push({ t, type: 'tree', x: p[0], y: p[1], z: p[2] });
      inCanopy = canopyNow;
      // The flagstick.
      if (pin) {
        const dx = p[0] - pin.x, dz = p[2] - pin.z;
        const dh = Math.hypot(dx, dz);
        if (dh < 0.0125 + GBALL.r && p[1] < pinGround + FLAG_H && p[1] > pinGround) {
          const nx = dx / (dh || 1), nz = dz / (dh || 1);
          const vn = v[0] * nx + v[2] * nz;
          if (vn < 0) {
            v[0] = (v[0] - 1.4 * vn * nx) * 0.18; v[2] = (v[2] - 1.4 * vn * nz) * 0.18;
            v[1] = Math.min(v[1], 0) * 0.5;
            events.push({ t, type: 'flag', x: p[0], z: p[2] });
          }
        }
      }
      const gy = hole.heightAt(p[0], p[2]);
      surface = hole.surfaceAt(p[0], p[2]);
      if (surface === 'water' && p[1] - GBALL.r <= Math.max(gy, hole.waterLevel)) {
        p[1] = hole.waterLevel;
        record();
        finish('water');
        break;
      }
      if (p[1] - GBALL.r <= gy) {
        if (surface === 'ob') { p[1] = gy + GBALL.r; record(); finish('ob'); break; }
        // Straight into the cup?
        if (pin && Math.hypot(p[0] - pin.x, p[2] - pin.z) < CUP_R - GBALL.r * 0.3 && Math.hypot(v[0], v[2]) < 9) {
          p[0] = pin.x; p[2] = pin.z; p[1] = pinGround - 0.06;
          record();
          finish('holed', { direct: true });
          break;
        }
        p[1] = gy + GBALL.r;
        const n = hole.normalAt(p[0], p[2]);
        const vn = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
        if (vn < 0) {
          const sf = SURF[surface] || SURF.rough;
          if (!landed) { landed = { t, x: p[0], z: p[2], surface }; events.push({ t, type: 'land', x: p[0], z: p[2], surface, speed: -vn }); }
          else events.push({ t, type: 'bounce', x: p[0], z: p[2], surface, speed: -vn });
          // Normal impulse.
          const e = sf.e * clamp(1 - (-vn - 18) / 40, 0.45, 1);
          const jn = (1 + e) * -vn;
          // Tangential slip at the contact point: u = v + ω × (−r n).
          const rc = [-n[0] * GBALL.r, -n[1] * GBALL.r, -n[2] * GBALL.r];
          const wxr = [w[1] * rc[2] - w[2] * rc[1], w[2] * rc[0] - w[0] * rc[2], w[0] * rc[1] - w[1] * rc[0]];
          let ux = v[0] + wxr[0], uy = v[1] + wxr[1], uz = v[2] + wxr[2];
          const un = ux * n[0] + uy * n[1] + uz * n[2];
          ux -= un * n[0]; uy -= un * n[1]; uz -= un * n[2];
          const slip = Math.hypot(ux, uy, uz);
          let jt = [0, 0, 0];
          if (slip > 1e-6) {
            const need = slip / (1 + 2.5);                // solid ball: I = 0.4 m r²
            const j = Math.min(need, sf.mu * jn);
            jt = [-j * ux / slip, -j * uy / slip, -j * uz / slip];
          }
          v[0] += jn * n[0] + jt[0]; v[1] += jn * n[1] + jt[1]; v[2] += jn * n[2] + jt[2];
          // Δω = (r_c × J) / (0.4 r²)
          const inv = 1 / (0.4 * GBALL.r * GBALL.r);
          w[0] += (rc[1] * jt[2] - rc[2] * jt[1]) * inv;
          w[1] += (rc[2] * jt[0] - rc[0] * jt[2]) * inv;
          w[2] += (rc[0] * jt[1] - rc[1] * jt[0]) * inv;
          // The turf soaks up pace along the ground (and the spin with it).
          const vn1 = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
          const tk = sf.turf * clamp(0.75 + 0.25 * (1 - -vn / 25), 0.75, 1);
          v[0] = vn1 * n[0] + (v[0] - vn1 * n[0]) * tk;
          v[1] = vn1 * n[1] + (v[1] - vn1 * n[1]) * tk;
          v[2] = vn1 * n[2] + (v[2] - vn1 * n[2]) * tk;
          w[0] *= tk; w[1] *= tk; w[2] *= tk;
          if (surface === 'sand') { v[0] *= 0.15; v[2] *= 0.15; v[1] *= 0.2; }
          const vn2 = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
          if (vn2 < 0.7) rolling = true;
        }
      }
    } else {
      // ---- rolling (or putting) along the ground
      surface = hole.surfaceAt(p[0], p[2]);
      if (surface === 'water') { p[1] = hole.waterLevel; record(); finish('water'); break; }
      if (surface === 'ob') { record(); finish('ob'); break; }
      const sf = SURF[surface] || SURF.rough;
      const n = hole.normalAt(p[0], p[2]);
      // Downhill pull on a rolling ball is 5/7 of g along the slope.
      let ax = (5 / 7) * G * n[0] * n[1], az = (5 / 7) * G * n[2] * n[1];
      const sp = Math.hypot(v[0], v[2]);
      if (sp > 1e-4) { ax -= sf.roll * v[0] / sp; az -= sf.roll * v[2] / sp; }
      const slopePull = Math.hypot((5 / 7) * G * n[0], (5 / 7) * G * n[2]);
      if (sp < 0.05 && slopePull < sf.roll * 0.9) {
        v[0] = v[2] = 0;
        stillFor += DT;
        if (stillFor > 0.25) { record(); finish('rest'); break; }
      } else {
        stillFor = 0;
        const nvx = v[0] + ax * DT, nvz = v[2] + az * DT;
        // Friction never reverses the ball on flat ground.
        if (sp > 1e-4 && nvx * v[0] + nvz * v[2] < 0 && slopePull < sf.roll) { v[0] = 0; v[2] = 0; }
        else { v[0] = nvx; v[2] = nvz; }
      }
      p[0] += v[0] * DT; p[2] += v[2] * DT;
      p[1] = hole.heightAt(p[0], p[2]) + GBALL.r;
      v[1] = 0;
      // The cup.
      if (pin) {
        const dx = p[0] - pin.x, dz = p[2] - pin.z;
        const d = Math.hypot(dx, dz);
        const s2 = Math.hypot(v[0], v[2]);
        if (d < CUP_R) {
          const edge = d / CUP_R;
          const capture = 1.35 * Math.sqrt(Math.max(0, 1 - edge * edge)) + 0.18;
          if (s2 < capture) {
            p[0] = pin.x; p[2] = pin.z; p[1] = pinGround - 0.06;
            record();
            finish('holed', { speed: s2 });
            break;
          }
          if (s2 < 3 && !lipped) {
            // Lip-out: the rim turns the ball and takes its pace.
            const turn = (rand() < 0.5 ? -1 : 1) * (0.35 + rand() * 0.6);
            const c = Math.cos(turn), s = Math.sin(turn);
            const nvx = (v[0] * c - v[2] * s) * 0.6, nvz = (v[0] * s + v[2] * c) * 0.6;
            v[0] = nvx; v[2] = nvz;
            lipped = true;
            events.push({ t, type: 'lip', x: p[0], z: p[2] });
          }
        } else if (d < CUP_R + 0.02 && s2 < 0.12) {
          p[0] = pin.x; p[2] = pin.z; p[1] = pinGround - 0.06;
          record();
          finish('holed', { speed: s2, edge: true });
          break;
        }
      }
    }
    if (step % RECORD_EVERY === 0) record();
  }
  if (!events.length || !['rest', 'cup', 'splash', 'ob'].includes(events[events.length - 1].type)) { record(); finish('rest'); }
  const last = samples[samples.length - 1];
  const restSurface = result === 'rest' ? hole.surfaceAt(last.x, last.z) : result === 'holed' ? 'green' : result;
  const carry = landed ? Math.hypot(landed.x - from.x, landed.z - from.z) : 0;
  return {
    samples, events, result,
    rest: { x: last.x, y: last.y, z: last.z, surface: restSurface },
    landed, carry,
    total: Math.hypot(last.x - from.x, last.z - from.z),
    duration: last.t,
  };
}

// Where a shot of the given power would first land on flat ground in still
// air, along `aim` from `from` (the dots on the map and the aim guide).
export function flatLanding(clubId, power, from, aim, putterMax = null) {
  const club = CLUBS[clubId];
  const d = club.putter ? power * (putterMax ?? club.maxCarry) : power * club.maxCarry;
  return { x: from.x + Math.sin(aim) * d, z: from.z - Math.cos(aim) * d, d };
}

// The game picks a club for you: the putter on (and just off) the green,
// the wedge from bunkers, otherwise the shortest club that reaches.
export function suggestClub(distance, surface) {
  if (surface === 'green' || surface === 'fringe') return 'putter';
  if (surface === 'sand') return 'wedge';
  if (distance <= CLUBS.wedge.maxCarry * 0.95) return 'wedge';
  if (distance <= CLUBS.iron.maxCarry * 0.97) return 'iron';
  return 'driver';
}

// The putter's scale adapts to the putt (like the putting meter's distance marks):
// full power reaches comfortably past the hole. Returns metres.
export function putterScale(distance) {
  const ft = distance * 3.28084;
  const steps = [10, 20, 30, 45, 60, 80, 100, 120];
  const want = ft * 1.45 + 3;
  const pick = steps.find((s) => s >= want) || 120;
  return pick / 3.28084;
}

// Power cap of a lie (rough: 2 dots of 4, bunker: 1 dot).
export const LIE_CAP = { tee: 1, fairway: 1, green: 1, fringe: 1, rough: 0.5, sand: 0.25, ob: 1, water: 1 };

// What a swing does: power past the lie's cap is an overswing (big hook or
// slice); a swing within it only curves a little with the wrist.
export function swingToShot(power, curveHint, surface, seed = 1) {
  const cap = LIE_CAP[surface] ?? 1;
  const over = Math.max(0, power - cap);
  const p = Math.min(power, cap) * (1 + 0.12 * Math.min(1, over / 0.3));
  let curve = clamp(curveHint, -1, 1) * 0.18;
  if (over > 0.02) {
    const sign = Math.abs(curveHint) > 0.05 ? Math.sign(curveHint) : (rng(seed)() < 0.5 ? -1 : 1);
    curve = sign * clamp(0.25 + over / 0.25, 0, 1);
  }
  return { power: p, curve, over, cap, nice: !over && power >= cap * 0.9 };
}
