// Tennis ball flight for the TV and the tests (pure, deterministic).
//
// Court frame (metres): x to the right as seen from the near team (team 0),
// y up, z toward the near baseline. The net is the plane z = 0; team 0 plays
// on z > 0, team 1 on z < 0. ITF dimensions; doubles court (the game is
// always doubles).
//
// The ball feels gravity, quadratic drag and the Magnus lift of its spin
// (topspin dips, slice floats). Bounces use an impulse model of a hollow ball
// with Coulomb friction, so topspin kicks forward and slice skids. The net is
// a sagging tape between the posts.

export const COURT = {
  halfLen: 11.885,          // net → baseline
  halfW: 5.485,             // doubles sideline
  singlesHalfW: 4.115,
  service: 6.40,            // net → service line
  netCenter: 0.914,
  netPost: 1.07,
  postX: 6.40,              // 0.914 m outside the doubles sideline
};

export const BALL = { r: 0.033, m: 0.057 };

const G = 9.81;
const RHO = 1.21;
const AREA = Math.PI * BALL.r * BALL.r;
const KD = 0.5 * RHO * 0.55 * AREA / BALL.m;        // drag: a = −KD |v| v
const KL = 0.5 * RHO * AREA / BALL.m;               // lift: a = KL CL v² (ŵ × v̂)
const SPIN_DECAY = 1 / 8;                           // 1/s
const E_COURT = 0.74;                               // vertical restitution
const MU_COURT = 0.55;                              // ball–court friction
const I_RATIO = 2 / 3;                              // I = (2/3) m r² (thin shell)
export const SIM_DT = 1 / 240;

export const netHeightAt = (x) => {
  const ax = Math.min(Math.abs(x), COURT.postX);
  return COURT.netCenter + (COURT.netPost - COURT.netCenter) * (ax / COURT.postX) ** 2;
};

export function makeBall(p, v, w = [0, 0, 0]) {
  return { x: p[0], y: p[1], z: p[2], vx: v[0], vy: v[1], vz: v[2], wx: w[0], wy: w[1], wz: w[2] };
}
export const cloneBall = (b) => ({ x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, wx: b.wx, wy: b.wy, wz: b.wz });

// Spin vector for `top` rad/s of topspin (negative = slice) and `side` rad/s
// of sidespin (+ curves the ball to its right) for a ball travelling along
// horizontal direction (dx, dz).
export function spinFor(dx, dz, top, side = 0) {
  const l = Math.hypot(dx, dz) || 1;
  const ux = dx / l, uz = dz / l;
  // Topspin axis = up × d = (uz, 0, −ux); sidespin about −y curves right.
  return [uz * top, -side, -ux * top];
}

// One integration step. Returns an event or null:
//   { type: 'bounce', x, z, vIn } | { type: 'net', x, y, cord: bool }
export function stepBall(b, dt = SIM_DT, { net = true } = {}) {
  const sp = Math.hypot(b.vx, b.vy, b.vz);
  let ax = 0, ay = -G, az = 0;
  if (sp > 1e-4) {
    ax -= KD * sp * b.vx; ay -= KD * sp * b.vy; az -= KD * sp * b.vz;
    const ws = Math.hypot(b.wx, b.wy, b.wz);
    if (ws > 1e-3) {
      const S = BALL.r * ws / sp;
      const cl = Math.min(0.35, 1 / (2 + 1 / S));
      // ŵ × v̂ scaled by |v|²: (w × v) |v| / |w|
      const cx = b.wy * b.vz - b.wz * b.vy;
      const cy = b.wz * b.vx - b.wx * b.vz;
      const cz = b.wx * b.vy - b.wy * b.vx;
      const k = KL * cl * sp / ws;
      ax += k * cx; ay += k * cy; az += k * cz;
    }
  }
  const z0 = b.z;
  b.vx += ax * dt; b.vy += ay * dt; b.vz += az * dt;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
  const decay = Math.exp(-SPIN_DECAY * dt);
  b.wx *= decay; b.wy *= decay; b.wz *= decay;

  // Net: crossing z = 0 between the posts.
  if (net && ((z0 > 0 && b.z <= 0) || (z0 < 0 && b.z >= 0))) {
    const k = z0 / (z0 - b.z);
    const cx = b.x - b.vx * dt * (1 - k);
    const cy = b.y - b.vy * dt * (1 - k);
    if (Math.abs(cx) <= COURT.postX) {
      const h = netHeightAt(cx);
      if (cy - BALL.r < h) {
        if (cy + BALL.r * 0.2 > h) {
          // Clips the tape: loses pace, pops up, carries on (it may still drop back).
          b.vz *= 0.42; b.vx *= 0.7; b.vy = Math.abs(b.vy) * 0.25 + 1.0;
          b.wx *= 0.3; b.wy *= 0.3; b.wz *= 0.3;
          return { type: 'net', x: cx, y: cy, cord: true };
        }
        // Into the net: it drops on the hitter's side.
        const side = Math.sign(z0) || 1;
        b.z = side * (BALL.r + 0.02);
        b.vz = -b.vz * 0.1; b.vx *= 0.35; b.vy *= 0.3;
        b.wx = b.wy = b.wz = 0;
        return { type: 'net', x: cx, y: cy, cord: false };
      }
    }
  }

  // Court contact.
  if (b.y < BALL.r && b.vy < 0) {
    const vIn = Math.hypot(b.vx, b.vy, b.vz);
    b.y = BALL.r;
    const vn = -b.vy;
    const jn = (1 + E_COURT) * vn;                     // normal impulse per unit mass
    // Contact-point slip u = v + ω × r_c with r_c = (0, −r, 0): ω × r_c = (wz r, 0, −wx r).
    const uxSlip = b.vx + b.wz * BALL.r;
    const uzSlip = b.vz - b.wx * BALL.r;
    const slip = Math.hypot(uxSlip, uzSlip);
    let jx = 0, jz = 0;
    if (slip > 1e-6) {
      // The impulse that ends the slip is u / (1 + m r²/I); friction caps it at μ·jn.
      const need = slip / (1 + 1 / I_RATIO);
      const j = Math.min(need, MU_COURT * jn);
      jx = -j * uxSlip / slip;
      jz = -j * uzSlip / slip;
    }
    b.vy = vn * E_COURT;
    b.vx += jx; b.vz += jz;
    // Δω = m (r_c × J) / I = (−jz, 0, jx) / (I_RATIO r).
    const inv = 1 / (I_RATIO * BALL.r);
    b.wx -= jz * inv;
    b.wz += jx * inv;
    if (b.vy < 0.35) b.vy = 0;                         // rolling
    return { type: 'bounce', x: b.x, z: b.z, vIn };
  }
  return null;
}

// Simulates from `start` (not modified). Returns the path and its events:
//   { samples: [{ t, x, y, z }], bounces: [{ t, x, z }], net: event|null, end }
export function predict(start, { maxT = 4, maxBounces = 2, every = 2, net = true } = {}) {
  const b = cloneBall(start);
  const samples = [{ t: 0, x: b.x, y: b.y, z: b.z }];
  const bounces = [];
  let netEv = null;
  let t = 0, i = 0;
  while (t < maxT) {
    const ev = stepBall(b, SIM_DT, { net });
    t += SIM_DT;
    i++;
    if (i % every === 0) samples.push({ t, x: b.x, y: b.y, z: b.z });
    if (ev?.type === 'net' && !netEv) netEv = { ...ev, t };
    if (ev?.type === 'bounce') {
      bounces.push({ t, x: ev.x, z: ev.z });
      if (bounces.length >= maxBounces) break;
    }
    if (b.vy === 0 && b.y <= BALL.r + 1e-6 && Math.hypot(b.vx, b.vz) < 0.5) break;
  }
  return { samples, bounces, net: netEv, end: b, t };
}

// Ball state after `t` seconds of flight from `start` (for rollback and replays).
export function ballAt(start, t) {
  const b = cloneBall(start);
  let left = t;
  while (left > 1e-9) {
    const dt = Math.min(SIM_DT, left);
    stepBall(b, dt);
    left -= dt;
  }
  return b;
}

// Is a bounce at (x, z) inside the given team's court half?
//   box: null for a rally (doubles court), or { team, side: 'deuce'|'ad' } for a serve.
export function landsIn(x, z, team, box = null, margin = 0) {
  const zIn = team === 0 ? z >= -margin && z <= COURT.halfLen + margin : z <= margin && z >= -COURT.halfLen - margin;
  if (!box) return zIn && Math.abs(x) <= COURT.halfW + margin;
  // Service box: between the net and the service line, singles sideline to the centre line.
  const depth = Math.abs(z);
  if (depth > COURT.service + margin || (team === 0 ? z < -margin : z > margin)) return false;
  // Deuce court is the receiver's right: x < 0 for team 1 (facing +z), x > 0 for team 0 (facing −z).
  const right = team === 0 ? x : -x;
  const wantRight = box.side === 'deuce';
  const lateral = wantRight ? right : -right;
  return lateral >= -margin && lateral <= COURT.singlesHalfW + margin;
}

// Initial velocity that makes a ball leave `from` and first bounce at
// `target` (x, z) after about `time` seconds of flight, with the given spin
// (rad/s, see spinFor). If that arc does not clear the net by `clear` metres
// the flight is made longer (a higher, slower ball) until it does.
// Returns { v: [vx, vy, vz], w, tLand, land: {x, z}, netY, netX } or null.
export function solveShot(from, target, { time = 1.2, top = 0, side = 0, clear = 0.25, maxTime = null } = {}) {
  const dx = target[0] - from[0], dz = target[1] - from[2];
  const dist = Math.hypot(dx, dz);
  if (dist < 0.5) return null;
  const crossesNet = (from[2] > 0) !== (target[1] > 0);
  const w = spinFor(dx, dz, top, side);
  const nx = dx / dist, nz = dz / dist;               // along-track unit vector
  const limit = maxTime ?? time * 2.6;
  let tau = time;
  for (let attempt = 0; attempt < 14 && tau <= limit; attempt++) {
    let vh = dist / tau;
    let vy = (BALL.r - from[1] + 0.5 * G * tau * tau) / tau;
    let heading = 0;                                   // radians off the target line (+ = to the right of travel)
    let res = null;
    for (let it = 0; it < 12; it++) {
      const c = Math.cos(heading), s = Math.sin(heading);
      // Rotate (nx, nz) by `heading` clockwise seen from above (right of travel = (−nz, nx)).
      const hx = nx * c - nz * s, hz = nz * c + nx * s;
      res = flyToFirstBounce(from, [vh * hx, vy, vh * hz], w);
      if (!res) { vy += 1.5; continue; }
      const rx = res.x - from[0], rz = res.z - from[2];
      const along = rx * nx + rz * nz;
      const cross = rx * -nz + rz * nx;                // + = landed right of the target line
      const ea = along - dist, ec = cross, et = res.t - tau;
      res.vel = [vh * hx, vy, vh * hz];
      if (Math.abs(ea) < 0.04 && Math.abs(ec) < 0.04 && Math.abs(et) < 0.01) break;
      vh -= ea / Math.max(0.2, res.t);
      heading -= ec / Math.max(1, along);
      vy -= et * G * 0.5;
    }
    if (res && res.vel) {
      const err = Math.hypot(target[0] - res.x, target[1] - res.z);
      const netOk = !crossesNet || res.netY === null || res.netY - BALL.r >= netHeightAt(res.netX) + clear;
      if (err < 0.3 && netOk) return { v: res.vel, w, tLand: res.t, land: { x: res.x, z: res.z }, netY: res.netY, netX: res.netX };
    }
    tau *= 1.08;                                       // a longer, higher flight
  }
  return null;
}

// Flight without the net (the solver checks clearance itself).
function flyToFirstBounce(from, v, w) {
  const b = makeBall(from, v, w);
  let t = 0, netY = null, netX = 0;
  for (let i = 0; i < 2400; i++) {
    const z0 = b.z;
    const ev = stepBall(b, SIM_DT, { net: false });
    t += SIM_DT;
    if ((z0 > 0 && b.z <= 0) || (z0 < 0 && b.z >= 0)) { netY = b.y; netX = b.x; }
    if (ev?.type === 'bounce') return { x: ev.x, z: ev.z, t, netY, netX };
    if (b.y < -1) return null;
  }
  return null;
}
