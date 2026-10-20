// Bowling swing detection from the phone's motion sensors (pure: no DOM, no
// network), so it can be exercised with synthetic swings in Node.
//
//   const sw = new SwingDetector();
//   sw.grip(t);                         // the player pressed and holds B
//   sw.sample(t, [ωx, ωy, ωz], [ax, ay, az]);   // every devicemotion event
//   sw.armAngle                         // live arm angle (deg, 0 = hanging, + = forward)
//   const th = sw.release(t);           // B let go → { quality, speed, spin, release, … }
//
// `release` is where the arm was when the thumb came off B, in degrees from
// the bottom of the swing (− = early, still behind / coming down; + = late,
// already on the way up). With the phone's pose at the grip it is absolute
// (pose angle + integrated gyro); without it, it is measured from the bottom
// of the swing (the fastest point of the forward stroke).
//
// Inputs: ω = rotationRate [alpha, beta, gamma] in deg/s, which per the W3C
// spec and both WebKit and Chromium are the rates about the device X, Y and Z
// axes. a = accelerationIncludingGravity in m/s² (its sign differs between iOS
// and Android, so only its direction is used, sign-corrected by geometry).
//
// Grip: like a remote control — portrait, screen up, top of the phone pointing at
// the TV, thumb on B. Through the swing the phone's long axis stays along the
// forearm, so:
//   * the arm axis â (toward the shoulder) is the phone's −Y axis, refined per
//     throw from the centripetal acceleration at the bottom of the swing;
//   * the swing is the rotation perpendicular to â (|ω⊥| ignores wrist twist);
//   * the wrist twist is the rotation about â (counter-clockwise seen from the
//     shoulder = a right-hander's hook = the ball curves left).
// Forward is learned from the swing itself: the first sustained rotation after
// the grip is the backswing. A one-way flick is judged against the standard
// grip (forward swing = +X rotation).

const DEG = Math.PI / 180;
const ONSET_RATE = 60;         // deg/s of swing that counts as motion
const ONSET_SAMPLES = 3;
const MIN_THROW_RATE = 120;    // below this at release: no throw
const FULL_RATE = 1000;        // a strong, full swing = full speed (1.0)
const OVER_RATE = 1300;        // harder still adds a little (up to 1.1), then nothing
const NAG_RATE = 1300;         // "easy, you don't need to swing that hard"
const SPIN_DEADZONE = 12;      // deg of twist that natural swings add anyway
const SPIN_FULL = 80;          // deg of twist for full spin
const LOFT_AFTER = 40;         // deg past the bottom → lofted (late) release
const SEG_HYST = 12;           // deg of travel back before a turning point counts
const ARM_RADIUS = 0.65;       // m, shoulder → phone (accelerometer-only fallback)

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 1e-9 ? scale(a, 1 / l) : [0, 0, 0]; };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const median3 = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

export const SWING = { MIN_THROW_RATE, FULL_RATE, OVER_RATE, NAG_RATE, SPIN_DEADZONE, SPIN_FULL, LOFT_AFTER };

// Arm speed at release → ball speed, linear so a soft swing is clearly slower
// than a hard one: 120 °/s → 0, 1000 °/s → 1, then a small bonus to 1.1.
export function speedFromRate(rate) {
  if (rate <= FULL_RATE) return clamp((rate - MIN_THROW_RATE) / (FULL_RATE - MIN_THROW_RATE), 0, 1);
  return 1 + 0.1 * clamp((rate - FULL_RATE) / (OVER_RATE - FULL_RATE), 0, 1);
}

export function spinFromTwist(twistDeg) {
  // + twist (counter-clockwise, a right-hander's hook) → ball curves LEFT → spin < 0.
  const mag = clamp((Math.abs(twistDeg) - SPIN_DEADZONE) / (SPIN_FULL - SPIN_DEADZONE), 0, 1);
  return mag === 0 ? 0 : -Math.sign(twistDeg) * mag;
}

// "Up" in device coordinates from deviceorientation β, γ (degrees). Unlike
// accelerationIncludingGravity this has the same sign on iOS and Android.
export function upFromOrientation(betaDeg, gammaDeg) {
  const b = betaDeg * DEG, g = gammaDeg * DEG;
  return [-Math.sin(g) * Math.cos(b), Math.sin(b), Math.cos(g) * Math.cos(b)];
}

// The forward-swing rotation axis at the grip: the player's RIGHT, in device
// coordinates. Holding the ball at the chest the phone's top points at the
// TV, so forward ≈ the phone's +Y made horizontal, and right = forward × up.
// Null when the phone points too steeply up or down to tell.
export function forwardAxisFromUp(up) {
  if (!up) return null;
  const u = norm(up);
  const yDotUp = u[1];
  if (Math.abs(yDotUp) > 0.8) return null;
  const fwd = norm(sub([0, 1, 0], scale(u, yDotUp)));
  const right = [fwd[1] * u[2] - fwd[2] * u[1], fwd[2] * u[0] - fwd[0] * u[2], fwd[0] * u[1] - fwd[1] * u[0]];
  return len(right) > 0.5 ? norm(right) : null;
}

export class SwingDetector {
  constructor(opts = {}) {
    this.invertSpin = !!opts.invertSpin;
    this.startAngle = opts.startAngle ?? 60;   // arm angle while holding the ball at the chest
    this.reset();
  }

  reset() {
    this.gripped = false;
    this.samples = [];
    this.t0 = 0;
    this.onset = -1;           // sample index where the backswing started
    this.backDir = null;       // unit swing-rate direction of the backswing (device frame)
    this.armAngle = this.startAngle;
    this.peakRate = 0;
    this.hasGyro = null;
    this.gripAxis = null;      // forward-swing axis from the phone's pose at the grip
    this.gripUp = null;        // device-frame up at the grip
    this._raw = [];
  }

  // up: optional device-frame up vector at the grip (see upFromOrientation).
  grip(t, up = null) {
    this.reset();
    this.gripped = true;
    this.t0 = t;
    this.gripAxis = forwardAxisFromUp(up);
    if (up && len(up) > 0.5) {
      this.gripUp = norm(up);
      // The on-screen arm starts where the phone really is (−Y points up the arm).
      this.armAngle = Math.acos(clamp(-this.gripUp[1], -1, 1)) / DEG;
    }
  }

  cancel() { this.reset(); }

  // ω: deg/s about device X, Y, Z (or null); a: m/s² incl. gravity (or null).
  sample(t, w, a) {
    if (!this.gripped) return;
    const prev = this.samples[this.samples.length - 1];
    // Events can arrive in bursts with equal timestamps (a busy page): each is
    // still its own sensor sample, so keep it (integration uses the sensor's
    // steady interval, see _analyse).
    if (prev && t <= prev.t) t = prev.t + 0.5;
    const hasW = !!w && w.every((v) => Number.isFinite(v));
    if (this.hasGyro === null && (hasW || a)) this.hasGyro = hasW;
    const raw = hasW ? w.map(Number) : null;
    // Median-of-3 per axis removes single-sample spikes.
    this._raw.push(raw);
    if (this._raw.length > 3) this._raw.shift();
    let wf = raw;
    if (raw && this._raw.length === 3 && this._raw.every(Boolean)) {
      const [p, q, r] = this._raw;
      wf = [0, 1, 2].map((i) => median3(p[i], q[i], r[i]));
    }
    const acc = a && a.every((v) => Number.isFinite(v)) ? a.map(Number) : null;
    const s = { t, w: raw, wf, a: acc };
    this.samples.push(s);
    if (this.samples.length > 400) this.samples.shift();
    this._live(s, prev);
  }

  // Live estimate for the on-screen arm (default axes; refined on release).
  _live(s, prev) {
    if (!s.wf || !prev) return;
    const dt = Math.min(0.05, (s.t - prev.t) / 1000);
    const arm = [0, -1, 0];
    const perp = sub(s.wf, scale(arm, dot(s.wf, arm)));
    const rate = len(perp);
    this.peakRate = Math.max(this.peakRate, rate);
    if (this.onset < 0) {
      const n = this.samples.length;
      const recent = this.samples.slice(-ONSET_SAMPLES);
      if (recent.length === ONSET_SAMPLES && recent.every((x) => x.wf && len(sub(x.wf, scale(arm, dot(x.wf, arm)))) > ONSET_RATE)) {
        this.onset = n - ONSET_SAMPLES;
      }
    }
    if (this.onset >= 0 && !this.backDir && s.t - this.samples[this.onset].t >= 80) {
      this.backDir = this._meanDir(this.onset, this.samples.length, arm, 100);
    }
    // Forward: the grip pose when known (a pushaway must not flip it), else
    // against the first sustained motion, else the standard grip's +X.
    let fwd = this.gripAxis || (this.backDir ? scale(this.backDir, -1) : [1, 0, 0]);
    if (this.gripAxis && this.backDir && dot(this.backDir, this.gripAxis) < 0) fwd = scale(this.backDir, -1);
    this.armAngle = clamp(this.armAngle + dot(perp, fwd) * dt, -150, 200);
  }

  _meanDir(from, to, arm, windowMs) {
    let sum = [0, 0, 0];
    const t0 = this.samples[from].t;
    for (let i = from; i < to; i++) {
      const x = this.samples[i];
      if (x.t - t0 > windowMs) break;
      if (!x.wf) continue;
      sum = add(sum, sub(x.wf, scale(arm, dot(x.wf, arm))));
    }
    return len(sum) > 1e-6 ? norm(sum) : null;
  }

  // B released at time t. Returns the throw description:
  //   { quality: 'ok' | 'loft' | 'drop' | 'none', speed 0..1, spin −1..1 (+ = curves right),
  //     peak deg/s, releaseAngle deg past the bottom, twist deg, swingMs, hard: bool, source }
  release(t) {
    const out = this._analyse(t);
    this.reset();
    return out;
  }

  _analyse(tRel) {
    const S = this.samples.filter((s) => s.t <= tRel + 1);
    const none = (why) => ({ quality: 'none', speed: 0, spin: 0, peak: 0, release: 0, releaseAngle: 0, twist: 0, swingMs: 0, hard: false, reason: why, source: this.hasGyro ? 'gyro' : 'accel' });
    if (S.length < 4) return none('no samples');
    if (!this.hasGyro) return this._accelOnly(S, tRel);
    // Integration step: the sensor samples at a steady rate even when the
    // page receives the events in bursts, so each sample counts the mean
    // interval (elapsed time / samples, leaving out real dropouts); only a
    // dropout (missed samples) counts its own elapsed time.
    const span = S[S.length - 1].t - S[0].t;
    const mean0 = span / (S.length - 1);
    let dropT = 0, dropN = 0;
    for (let i = 1; i < S.length; i++) { const g = S[i].t - S[i - 1].t; if (g > mean0 * 3 && g > 45) { dropT += g; dropN++; } }
    const nominal = clamp((span - dropT) / Math.max(1, S.length - 1 - dropN), 8, 40);
    const stepAt = (i) => { const g = S[i].t - S[i - 1].t; return (g > nominal * 3 && g > 45 ? Math.min(g, 100) : nominal) / 1000; };

    // 1. Arm axis: default −Y, refined by the strongest acceleration (the bottom
    //    of the swing, where centripetal + gravity run along the arm).
    let arm = [0, -1, 0];
    let best = null;
    for (const s of S) if (s.a && (!best || len(s.a) > len(best))) best = s.a;
    if (best && len(best) > 15) {
      let cand = norm(best);
      if (dot(cand, arm) < 0) cand = scale(cand, -1);
      if (dot(cand, arm) > Math.cos(55 * DEG)) arm = cand;
    }
    const perpOf = (w) => sub(w, scale(arm, dot(w, arm)));

    // 2. Backswing onset and direction.
    let onset = -1;
    for (let i = 0; i + ONSET_SAMPLES <= S.length; i++) {
      let ok = true;
      for (let k = 0; k < ONSET_SAMPLES; k++) { const w = S[i + k].wf; if (!w || len(perpOf(w)) <= ONSET_RATE) { ok = false; break; } }
      if (ok) { onset = i; break; }
    }
    if (onset < 0) return none('no swing');
    let sum = [0, 0, 0];
    for (let i = onset; i < S.length && S[i].t - S[onset].t <= 100; i++) if (S[i].wf) sum = add(sum, perpOf(S[i].wf));
    const first = norm(sum);

    // 3. Excursions along the swing axis: θ integrates the rate along the
    //    first motion; turning points (with hysteresis) split it into segments.
    const along = S.map((s) => (s.wf ? dot(perpOf(s.wf), first) : 0));
    const segs = [];
    let theta = 0, dirNow = 0, extreme = 0, extremeAt = onset, segStart = onset, segFrom = 0;
    for (let i = onset + 1; i < S.length; i++) {
      theta += along[i] * stepAt(i);
      if (dirNow === 0) {
        if (Math.abs(theta) > SEG_HYST) { dirNow = Math.sign(theta); extreme = theta; extremeAt = i; }
        continue;
      }
      if ((theta - extreme) * dirNow > 0) { extreme = theta; extremeAt = i; }
      else if (Math.abs(theta - extreme) > SEG_HYST) {
        segs.push({ dir: dirNow, amp: Math.abs(extreme - segFrom), start: segStart, end: extremeAt });
        segStart = extremeAt; segFrom = extreme; dirNow = -dirNow; extreme = theta; extremeAt = i;
      }
    }
    const lastSeg = dirNow ? { dir: dirNow, start: segStart } : { dir: 1, start: onset };
    // The grip pose (top of the phone pointing at the TV) knows which way
    // is forward whenever it lines up with the swing axis — that covers a
    // pushaway from the chest. Without it (arm hanging at the grip, where
    // nobody pushes away first) the biggest completed excursion is the
    // backswing; a single one-way motion falls back to the standard grip.
    const gd = this.gripAxis ? dot(first, this.gripAxis) : 0;
    let fwdSign;
    if (Math.abs(gd) > 0.5) fwdSign = Math.sign(gd);
    else if (segs.length) fwdSign = -segs.reduce((a, b) => (b.amp > a.amp ? b : a)).dir;
    else fwdSign = dot(first, [1, 0, 0]) > 0.5 ? 1 : -1;
    const fwd = scale(first, fwdSign);
    // Start of the final forward stroke (for the bottom of the swing and the twist).
    let fStart = onset;
    if (lastSeg.dir === fwdSign) fStart = lastSeg.start;
    else for (let k = segs.length - 1; k >= 0; k--) if (segs[k].dir === fwdSign) { fStart = segs[k].start; break; }
    // Filtered rate (peaks, the bottom) and raw rate (angles: integrating the
    // median-filtered signal would lag a sample — ~10° at release speed).
    const sAt = (i) => (S[i].wf ? dot(perpOf(S[i].wf), fwd) : 0);
    const rawAt = (i) => (S[i].w ? dot(perpOf(S[i].w), fwd) : 0);

    // 4. Release rate: the strongest swing in the last 100 ms (60 Hz misses peaks).
    let relRate = 0, relSigned = 0;
    for (let i = S.length - 1; i >= 0 && tRel - S[i].t <= 100; i--) {
      if (!S[i].wf) continue;
      const r = len(perpOf(S[i].wf));
      if (r > relRate) { relRate = r; relSigned = sAt(i); }
    }
    let peak = 0;
    for (let i = onset; i < S.length; i++) if (S[i].wf) peak = Math.max(peak, len(perpOf(S[i].wf)));
    const swingMs = Math.round(tRel - S[onset].t);
    const hard = peak > NAG_RATE;
    if (relRate < MIN_THROW_RATE) return { ...none('too slow'), peak, swingMs, hard };

    // 5. Released while still swinging back → the ball goes backwards.
    if (relSigned < 0) {
      return { quality: 'drop', speed: speedFromRate(relRate) * 0.5, spin: 0, peak, release: -90, releaseAngle: 0, twist: 0, swingMs, hard, source: 'gyro' };
    }

    // 6. Where was the arm when the thumb lifted?
    const dtAt = stepAt;
    const last = S[S.length - 1];
    const tail = tRel > last.t ? rawAt(S.length - 1) * Math.min(0.05, (tRel - last.t) / 1000) : 0;
    //  (a) The bottom of the swing: the fastest point of the final forward stroke.
    let bottom = fStart, bottomRate = 0;
    for (let i = fStart; i < S.length; i++) {
      const r = sAt(i);
      if (r > bottomRate) { bottomRate = r; bottom = i; }
    }
    let travelled = 0;
    for (let i = bottom + 1; i < S.length; i++) travelled += rawAt(i) * dtAt(i);
    const past = travelled + tail;
    // The bottom is behind us once the arm has travelled on from the fastest
    // sample (a pendulum barely slows in the first 20° past the bottom, so the
    // angle travelled is the reliable sign, not the speed). The extrapolated
    // tail after the last sample does not count: it cannot show a peak.
    const passedBottom = travelled > 6;
    //  (b) Absolute arm angle: the pose at the grip + the integrated swing.
    let release = passedBottom ? past : 0;
    if (this.gripUp) {
      const theta0 = Math.acos(clamp(dot(arm, this.gripUp), -1, 1)) / DEG;   // in front at the grip
      let theta = theta0, thetaBottom = null;
      for (let i = 1; i < S.length; i++) {
        theta += rawAt(i) * dtAt(i);
        if (i === bottom) thetaBottom = theta;
      }
      theta += tail;
      // Trust it while it agrees with the bottom of the swing (the arm should
      // hang straight down there); otherwise measure from the bottom.
      if (!passedBottom || thetaBottom === null || Math.abs(thetaBottom) <= 30) release = theta;
    }
    release = clamp(release, -150, 150);

    // 7. Wrist twist over the forward swing → spin.
    let twist = 0;
    for (let i = Math.max(fStart, 1); i < S.length; i++) {
      if (!S[i].w) continue;
      twist += dot(S[i].w, arm) * stepAt(i);
    }
    let spin = spinFromTwist(twist);
    if (this.invertSpin) spin = -spin;
    const quality = release > LOFT_AFTER ? 'loft' : 'ok';
    return {
      quality,
      speed: Math.round(speedFromRate(relRate) * 1000) / 1000,
      spin: Math.round(spin * 1000) / 1000 || 0,
      peak: Math.round(peak),
      release: Math.round(release),
      releaseAngle: Math.round(past),
      twist: Math.round(twist),
      swingMs,
      hard,
      source: 'gyro',
    };
  }

  // No gyroscope: speed from the acceleration peak (|a| ≈ g + ω²r at the bottom).
  _accelOnly(S, tRel) {
    let peakA = 0;
    for (const s of S) if (s.a && tRel - s.t <= 250) peakA = Math.max(peakA, len(s.a));
    const omega = Math.sqrt(Math.max(0, peakA - 9.81) / ARM_RADIUS) / DEG;
    if (omega < MIN_THROW_RATE) return { quality: 'none', speed: 0, spin: 0, peak: Math.round(omega), release: 0, releaseAngle: 0, twist: 0, swingMs: 0, hard: false, reason: 'too slow', source: 'accel' };
    return { quality: 'ok', speed: speedFromRate(omega), spin: 0, peak: Math.round(omega), release: 0, releaseAngle: 0, twist: 0, swingMs: Math.round(tRel - S[0].t), hard: omega > NAG_RATE, source: 'accel' };
  }
}
