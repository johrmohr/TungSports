// Synthetic bowling swings (device-frame gyro + accelerometer samples), shared
// by the swing unit test and the end-to-end phone test.
import assert from 'node:assert/strict';

const DEG = Math.PI / 180;

// Deterministic noise.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return s - 3; };

// Device-frame rotations for other grips.
export const GRIPS = {
  standard: (v) => v,                                     // screen faces the TV at the bottom
  thigh: (v) => [v[2], v[1], -v[0]],                      // screen faces the leg: swing shows on Z
  thighOther: (v) => [-v[2], v[1], v[0]],
  screenBack: (v) => [-v[0], v[1], -v[2]],                // screen faces the body
};

// Builds a swing: hold at the chest, back swing, forward pendulum, optional
// follow-through; releases at the requested forward arm angle (deg, 0 = bottom)
// or during the backswing. Returns { samples, tRelease }.
export function makeSwing({
  backPeak = -70, fwdPeakRate = 600, releaseAt = 0, releaseInBackswing = false, twistDeg = 0,
  grip = 'standard', accelSign = 1, noise = 6, hz = 60, flick = false, startAngle = 60, pushaway = 0,
}) {
  const g = 9.81, r = 0.65;
  const dt = 1000 / hz;
  const pts = [];
  // Arm angle as a function of time (s), piecewise.
  const hold = 0.25;
  const backDur = 0.7;
  const amp = 140;                                     // forward travel from backPeak (−70 → +70: fastest at the bottom)
  const fwdDur = (amp * Math.PI / 2) / fwdPeakRate;    // cosine ease: peak rate = amp·π/(2·dur)
  const theta = (t) => {
    if (flick) {
      if (t < hold) return -10;
      const u = Math.min(1, (t - hold) / fwdDur);
      return -10 + 100 * (1 - Math.cos(Math.PI * u)) / 2;
    }
    if (t < hold) return startAngle;
    // Optional pushaway: the ball pushed forward a little before the backswing.
    const pushDur = pushaway ? 0.3 : 0;
    const top = startAngle + pushaway;
    if (t < hold + pushDur) { const u = (t - hold) / pushDur; return startAngle + pushaway * (1 - Math.cos(Math.PI * u)) / 2; }
    if (t < hold + pushDur + backDur) { const u = (t - hold - pushDur) / backDur; return top + (backPeak - top) * (1 - Math.cos(Math.PI * u)) / 2; }
    const u = Math.min(1.6, (t - hold - pushDur - backDur) / fwdDur);
    return backPeak + amp * (1 - Math.cos(Math.PI * Math.min(1, u))) / 2 + (u > 1 ? (u - 1) * 30 : 0);
  };
  const fwdStart = flick ? hold : hold + (pushaway ? 0.3 : 0) + backDur;
  // Find the release time.
  let tRel = null;
  const tEnd = fwdStart + fwdDur * 1.6;
  if (releaseInBackswing) tRel = hold + (pushaway ? 0.3 : 0) + backDur * 0.55;
  else {
    for (let t = fwdStart; t < tEnd; t += 0.001) {
      const target = flick ? releaseAt + 45 : releaseAt;
      if (theta(t) >= target) { tRel = t; break; }
    }
  }
  assert.ok(tRel !== null, 'release time');
  // The wrist twist happens over the forward swing, finishing at the release.
  const psi = (t) => (t < fwdStart ? 0 : twistDeg * Math.min(1, (t - fwdStart) / Math.max(0.05, tRel - fwdStart)));
  const rot = GRIPS[grip];
  // Device-frame up at the grip (arm angle θ: up = (0, −cos θ, sin θ) in the standard grip).
  const th0 = theta(0) * DEG;
  const up = rot([0, -Math.cos(th0), Math.sin(th0)]);
  for (let t = 0; t <= tRel + 0.0001; t += dt / 1000) {
    const h = 0.004;
    const rate = (theta(t + h) - theta(t - h)) / (2 * h);        // deg/s, + = forward
    const twistRate = (psi(t + h) - psi(t - h)) / (2 * h);
    // Standard grip: forward swing = +X rotation; twist about the arm axis (−Y) = −Y rotation.
    let w = [rate + gauss() * noise, -twistRate + gauss() * noise, gauss() * noise];
    const wr = rate * DEG;
    const along = wr * wr * r + g * Math.cos(theta(t) * DEG);  // toward the shoulder
    let a = [gauss() * 0.3, -along * accelSign, g * Math.sin(theta(t) * DEG) * 0.3 * accelSign];
    w = rot(w);
    a = rot(a);
    pts.push({ t: 1000 + t * 1000, w, a });
  }
  return { samples: pts, tRelease: 1000 + tRel * 1000, up };
}

