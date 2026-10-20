// Motion-detector checks with synthetic sensor data.   node tools/swing-test.mjs
import { TennisSwingDetector } from '../public/js/phone/tennis-swing.js';
import { GolfSwingDetector, FULL_RATE } from '../public/js/phone/golf-swing.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

let seed = 99;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return s - 3; };

// Device axes expressed in the world (x right, y up, z toward the player).
const GRIPS = {
  // Long axis along the racket to the player's right, screen to the net.
  racket: { X: [0, 1, 0], Y: [1, 0, 0], Z: [0, 0, -1] },
  // Phone upright (top up), screen facing the player's left.
  upright: { X: [0, 0, -1], Y: [0, 1, 0], Z: [-1, 0, 0] },
  // Remote style: flat, screen up, top pointing at the TV.
  remote: { X: [1, 0, 0], Y: [0, 0, -1], Z: [0, 1, 0] },
  // Golf: hanging down along the shaft, screen to the target side (−x... any).
  club: { X: [0, 0, 1], Y: [0, -1, 0], Z: [1, 0, 0] },
};
const toDev = (g, v) => [g.X[0] * v[0] + g.X[1] * v[1] + g.X[2] * v[2], g.Y[0] * v[0] + g.Y[1] * v[1] + g.Y[2] * v[2], g.Z[0] * v[0] + g.Z[1] * v[1] + g.Z[2] * v[2]];

// A tennis swing: rotation about `axis` (world) peaking at `peak` °/s, with a
// vertical hand speed reaching `vUp` m/s at the peak; `rollDeg` of forearm roll
// about the long axis.
function tennisSwing({ grip = 'racket', axis = [0, 1, 0], peak = 800, vUp = 0, rollDeg = 0, hz = 60, noise = 4, t0 = 1000 }) {
  const g = GRIPS[grip];
  const dur = 0.32;                                  // s of the burst
  const out = [];
  for (let t = 0; t <= 0.8; t += 1 / hz) {
    const u = (t - 0.2) / dur;
    const env = u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0;
    const rate = peak * env;
    const wWorld = [axis[0] * rate, axis[1] * rate, axis[2] * rate];
    let w = toDev(g, wWorld);
    // Roll about the device long axis (Y) spread over the burst.
    w[1] += env * rollDeg * Math.PI / (2 * dur);
    w = w.map((x) => x + gauss() * noise);
    // Vertical acceleration: the hand speeds up (vUp at the peak), then slows.
    const aUp = env > 0 ? (vUp * Math.PI / dur) * Math.cos(Math.PI * u) : 0;
    const a = toDev(g, [gauss() * 0.2, aUp + gauss() * 0.2, gauss() * 0.2]);
    out.push({ t: t0 + t * 1000, w, a });
  }
  return { samples: out, up: toDev(g, [0, 1, 0]) };
}

function runTennis(det, sw) {
  det.setUp(sw.up);
  let ev = null;
  for (const s of sw.samples) { const e = det.sample(s.t, s.w, s.a); if (e) ev = e; }
  return ev;
}

// ---------------------------------------------------------------- tennis
{
  for (const grip of ['racket', 'upright', 'remote']) {
    const fh = runTennis(new TennisSwingDetector(), tennisSwing({ grip, axis: [0, 1, 0], peak: 800 }));
    ok(fh?.side === 'fh', `${grip}: right-handed forehand (got ${fh?.side})`);
    const bh = runTennis(new TennisSwingDetector(), tennisSwing({ grip, axis: [0, -1, 0], peak: 800 }));
    ok(bh?.side === 'bh', `${grip}: right-handed backhand (got ${bh?.side})`);
    const lfh = runTennis(new TennisSwingDetector({ hand: 'left' }), tennisSwing({ grip, axis: [0, -1, 0], peak: 800 }));
    ok(lfh?.side === 'fh', `${grip}: left-handed forehand sweeps the other way (got ${lfh?.side})`);
  }
  const oh = runTennis(new TennisSwingDetector(), tennisSwing({ axis: [1, 0, 0], peak: 900 }));
  ok(oh?.side === 'oh', `overhead swing (got ${oh?.side})`);
  const weak = runTennis(new TennisSwingDetector(), tennisSwing({ peak: 250 }));
  ok(weak === null, 'a gentle wave is not a swing');
  const slow = runTennis(new TennisSwingDetector(), tennisSwing({ peak: 400 }));
  const fast = runTennis(new TennisSwingDetector(), tennisSwing({ peak: 1200 }));
  ok(slow && fast && fast.speed > slow.speed + 0.5, `speed follows the swing (${slow?.speed} → ${fast?.speed})`);
  const lob = runTennis(new TennisSwingDetector(), tennisSwing({ vUp: 2.4 }));
  const slice = runTennis(new TennisSwingDetector(), tennisSwing({ vUp: -2.4 }));
  const flat = runTennis(new TennisSwingDetector(), tennisSwing({ vUp: 0 }));
  ok(lob?.plane > 0.6, `low-to-high swing reads as a lob (${lob?.plane})`);
  ok(slice?.plane < -0.6, `high-to-low swing reads as a slice (${slice?.plane})`);
  ok(Math.abs(flat?.plane) < 0.25, `level swing (${flat?.plane})`);
  // Roll over the ball on a racket grip forehand = topspin.
  const top = runTennis(new TennisSwingDetector(), tennisSwing({ grip: 'racket', rollDeg: -60 }));
  ok(top?.roll > 0.5, `wrist rolled over = topspin (${top?.roll})`);
  const upr = runTennis(new TennisSwingDetector(), tennisSwing({ grip: 'upright', rollDeg: 0 }));
  ok(Math.abs(upr?.roll) < 0.2, `upright phone: the swing itself is not mistaken for a roll (${upr?.roll})`);
  // Two swings in a row both count; a swing right after another (refractory) does not double.
  const det = new TennisSwingDetector();
  const a = tennisSwing({ t0: 1000 }), b = tennisSwing({ t0: 2000, axis: [0, -1, 0] });
  let evs = [];
  det.setUp(a.up);
  for (const s of [...a.samples, ...b.samples]) { const e = det.sample(s.t, s.w, s.a); if (e) evs.push(e); }
  ok(evs.length === 2 && evs[0].side === 'fh' && evs[1].side === 'bh', `forehand then backhand (${evs.map((e) => e.side).join(',')})`);
  // The peak time is reported (for timing).
  const timed = runTennis(new TennisSwingDetector(), tennisSwing({ t0: 5000 }));
  ok(timed && Math.abs(timed.t - (5000 + 200 + 160)) < 40, `peak time ≈ middle of the burst (${timed?.t})`);
  // 30 Hz sensors still work.
  const lo = runTennis(new TennisSwingDetector(), tennisSwing({ hz: 30 }));
  ok(lo?.side === 'fh', '30 Hz sampling');
}

// ---------------------------------------------------------------- golf
// Club angle profile: address → back to `back`° → down through address at
// `impactRate` °/s → follow-through. Rotation about the device X axis; `twist`
// degrees of face turn about Y during the downswing.
function golfSwing({ back = 150, impactRate = 800, twist = 0, hz = 60, noise = 3, t0 = 1000, axisSign = 1, pauseTop = 0.08 }) {
  const out = [];
  const hold = 0.4, backDur = Math.max(0.35, back / 160);
  const downDur = (back * Math.PI / 2) / impactRate * 0.98;   // cosine ease: peak rate at the bottom ≈ impactRate
  const theta = (t) => {
    if (t < hold) return 0;
    if (t < hold + backDur) return back * (1 - Math.cos(Math.PI * (t - hold) / backDur)) / 2;
    if (t < hold + backDur + pauseTop) return back;
    const u = (t - hold - backDur - pauseTop) / downDur;
    if (u <= 1) return back * Math.cos(Math.PI / 2 * u);
    return -impactRate * (u - 1) * downDur * Math.exp(-(u - 1) * 2);
  };
  const tDown = hold + backDur + pauseTop;
  const total = tDown + downDur * 2.2;
  for (let t = 0; t <= total; t += 1 / hz) {
    const h = 0.003;
    const rate = (theta(t + h) - theta(t - h)) / (2 * h);
    const tw = t > tDown && t < tDown + downDur ? twist / downDur : 0;
    out.push({ t: t0 + t * 1000, w: [axisSign * rate + gauss() * noise, tw + gauss() * noise, gauss() * noise] });
  }
  return out;
}
function runGolf(det, samples) {
  let ev = null, maxBack = 0;
  for (const s of samples) { const e = det.sample(s.t, s.w); maxBack = Math.max(maxBack, det.angle); if (e && !ev) ev = e; }
  return { ev, maxBack };
}
{
  for (const club of ['driver', 'iron', 'wedge']) {
    const det = new GolfSwingDetector();
    det.setClub(club);
    const { ev } = runGolf(det, golfSwing({ impactRate: FULL_RATE[club] * 0.8 }));
    ok(ev && Math.abs(ev.power - 0.8) < 0.1, `${club}: 80% swing reads 80% (${ev?.power})`);
  }
  const full = runGolf(new GolfSwingDetector(), golfSwing({ impactRate: 1250 }));
  ok(full.ev?.power > 1.15, `a very hard swing is an overswing (${full.ev?.power})`);
  const other = runGolf(new GolfSwingDetector(), golfSwing({ impactRate: 600, axisSign: -1 }));
  ok(other.ev && Math.abs(other.ev.power - 600 / FULL_RATE.driver) < 0.1, `phone held the other way round (${other.ev?.power})`);
  ok(full.maxBack > 120, `live angle follows the backswing (${Math.round(full.maxBack)}°)`);
  const open = runGolf(new GolfSwingDetector(), golfSwing({ impactRate: 800, twist: -30 }));
  const shut = runGolf(new GolfSwingDetector(), golfSwing({ impactRate: 800, twist: 30 }));
  const square = runGolf(new GolfSwingDetector(), golfSwing({ impactRate: 800, twist: 0 }));
  ok(open.ev?.curve > 0.4, `face opened → curves right (${open.ev?.curve})`);
  ok(shut.ev?.curve < -0.4, `face closed → curves left (${shut.ev?.curve})`);
  ok(Math.abs(square.ev?.curve) < 0.15, `square face → straight (${square.ev?.curve})`);
  // Putting: a small pendulum.
  const putt = new GolfSwingDetector();
  putt.setClub('putter');
  const p = runGolf(putt, golfSwing({ back: 18, impactRate: 150, pauseTop: 0.05 }));
  ok(p.ev && Math.abs(p.ev.power - 150 / FULL_RATE.putter) < 0.08, `putt: gentle stroke (${p.ev?.power})`);
  // Fidgeting is not a swing.
  const fidget = new GolfSwingDetector();
  let any = null;
  for (let i = 0; i < 120; i++) { const e = fidget.sample(1000 + i * 16, [gauss() * 15, gauss() * 15, gauss() * 15]); if (e) any = e; }
  ok(!any, 'holding still / fidgeting does not swing');
  // A waggle back and forth smaller than a backswing is ignored.
  const wag = new GolfSwingDetector();
  const wagS = golfSwing({ back: 10, impactRate: 120 });
  ok(!runGolf(wag, wagS).ev, 'a tiny waggle with the driver is not a swing');
  // Two swings in a row.
  const twice = new GolfSwingDetector();
  const s1 = golfSwing({ t0: 1000, impactRate: 500 });
  const s2 = golfSwing({ t0: 1000 + 4000, impactRate: 900 });
  const evs = [];
  for (const s of [...s1, ...s2]) { const e = twice.sample(s.t, s.w); if (e) evs.push(e); }
  ok(evs.length === 2 && evs[1].power > evs[0].power, `two swings (${evs.map((e) => e.power).join(', ')})`);
  // 30 Hz.
  const lo = runGolf(new GolfSwingDetector(), golfSwing({ impactRate: 700, hz: 30 }));
  ok(lo.ev && Math.abs(lo.ev.power - 700 / FULL_RATE.driver) < 0.15, `30 Hz sampling (${lo.ev?.power})`);
  // Strength setting.
  const soft = new GolfSwingDetector({ strength: 0.75 });
  const sv = runGolf(soft, golfSwing({ impactRate: 0.75 * FULL_RATE.driver }));
  ok(sv.ev && Math.abs(sv.ev.power - 1) < 0.1, `"light" strength: a 75% swing fills the meter (${sv.ev?.power})`);
}

console.log(`swing: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
