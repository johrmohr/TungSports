// Tennis swing detection from the phone's motion sensors (pure: no DOM, no
// network), so it can be exercised with synthetic swings in Node.
//
//   const sw = new TennisSwingDetector({ hand: 'right' });
//   sw.setUp(up);                               // world-up in device coordinates (from deviceorientation)
//   const ev = sw.sample(t, [ωx, ωy, ωz], acc); // every devicemotion event → a swing or null
//   ev = { side: 'fh' | 'bh' | 'oh', speed 0..1.2, plane −1..1, roll −1..1, peak deg/s, t: peak time (ms) }
//
// Only the swing matters: any grip works.
//   * A swing is a burst of rotation (> ~330 °/s at its peak).
//   * Forehand vs backhand: the sign of the rotation about the vertical. A
//     right-hander's forehand sweeps right → left (counter-clockwise seen from
//     above); a backhand the other way. Mostly-vertical swings are overheads.
//   * plane: the hand's vertical speed at the peak (from the gravity-free
//     acceleration): + brushed up (a lob), − chopped down (a slice).
//   * roll: the wrist rolling about the phone's long axis over the swing
//     (+ rolls over the ball = topspin), a small extra.
// ω is rotationRate [alpha, beta, gamma] in deg/s = rates about device X, Y, Z.

const ONSET = 220;          // °/s that starts a swing
const END = 110;            // °/s that ends it
const MIN_PEAK = 330;       // weaker bursts are not swings
const FULL = 1150;          // °/s for a full-speed swing
const MAX_DUR = 520;        // ms
const REFRACTORY = 240;     // ms after a swing before the next can start
const PLANE_FULL = 2.2;     // m/s of vertical hand speed for a full lob / slice

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const TENNIS_SWING = { ONSET, END, MIN_PEAK, FULL };

export class TennisSwingDetector {
  constructor({ hand = 'right', invertSpin = false } = {}) {
    this.hand = hand;
    this.invertSpin = invertSpin;
    this.up = [0, 1, 0];          // phone upright until told otherwise
    this.upAt = -1e9;
    this.history = [];            // recent samples (for the pre-swing window)
    this.reset();
    this.until = 0;               // refractory end
  }

  reset() {
    this.active = false;
    this.onsetT = 0;
    this.peak = 0;
    this.peakW = null;
    this.peakT = 0;
    this.quiet = 0;
    this.upAtOnset = null;
    this.roll = 0;
    this.lastT = null;
  }

  setUp(up, t = 0) {
    const l = len(up);
    if (l < 0.5) return;
    this.up = [up[0] / l, up[1] / l, up[2] / l];
    this.upAt = t;
  }

  sample(t, w, acc = null) {
    if (!w || !w.every(Number.isFinite)) return null;
    const prev = this.history[this.history.length - 1];
    if (prev && t <= prev.t) t = prev.t + 0.5;
    const s = { t, w, a: acc && acc.every(Number.isFinite) ? acc : null, up: this.up };
    this.history.push(s);
    while (this.history.length && t - this.history[0].t > 700) this.history.shift();
    const mag = len(w);
    if (!this.active) {
      if (t < this.until) return null;
      const p = this.history[this.history.length - 2];
      if (mag > ONSET && p && len(p.w) > ONSET * 0.6) {
        this.active = true;
        this.onsetT = p.t;
        // World-up from just before the motion (orientation lags during a fast swing).
        const before = this.history.find((x) => x.t >= p.t - 120) || p;
        this.upAtOnset = before.up;
        this.peak = mag; this.peakW = w; this.peakT = t;
        this.roll = 0;
        this.lastT = t;
      }
      return null;
    }
    const dt = Math.min(0.05, (t - this.lastT) / 1000);
    this.lastT = t;
    // Roll about the long axis, leaving out what is really the swing's own
    // turn about the vertical (an upright phone cannot show a roll).
    const up = this.upAtOnset || this.up;
    this.roll += (w[1] - dot(w, up) * up[1]) * dt;
    if (mag > this.peak) { this.peak = mag; this.peakW = w; this.peakT = t; }
    if (mag < END) this.quiet++; else this.quiet = 0;
    if (this.quiet >= 2 || t - this.onsetT > MAX_DUR) return this._finish(t);
    return null;
  }

  _finish(t) {
    const peak = this.peak, pw = this.peakW, up = this.upAtOnset || this.up;
    const out = peak >= MIN_PEAK ? this._classify(peak, pw, up) : null;
    this.reset();
    this.until = t + REFRACTORY;
    return out;
  }

  _classify(peak, pw, up) {
    const yaw = dot(pw, up);                              // + = counter-clockwise from above
    const horiz = Math.abs(yaw) / peak;
    const right = this.hand !== 'left';
    let side;
    if (horiz < 0.42) side = 'oh';
    else side = (yaw > 0) === right ? 'fh' : 'bh';
    // Vertical hand speed at the peak: integrate the gravity-free acceleration
    // projected on world-up from just before the swing to its peak.
    let vUp = 0, haveAcc = false;
    let last = null;
    for (const s of this.history) {
      if (s.t < this.onsetT - 80 || s.t > this.peakT) continue;
      if (last && s.a) {
        haveAcc = true;
        vUp += dot(s.a, up) * Math.min(0.05, (s.t - last.t) / 1000);
      }
      last = s;
    }
    const plane = haveAcc ? clamp(vUp / PLANE_FULL, -1, 1) : 0;
    // Wrist roll: + = over the ball (topspin) for the stroke's geometry.
    const geo = (side === 'bh') === right ? 1 : -1;
    let roll = clamp((this.roll * geo) / 70, -1, 1);
    if (this.invertSpin) roll = -roll;
    const speed = clamp((peak - 300) / (FULL - 300), 0, 1.2);
    return {
      side,
      speed: Math.round(speed * 1000) / 1000,
      plane: Math.round(plane * 1000) / 1000,
      roll: Math.round(roll * 1000) / 1000,
      peak: Math.round(peak),
      t: this.peakT,
    };
  }
}
