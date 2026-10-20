// Golf swing detection from the phone's gyroscope (pure: no DOM, no network).
//
//   const sw = new GolfSwingDetector();
//   sw.setClub('driver');                        // sets how fast a full swing is
//   const ev = sw.sample(t, [ωx, ωy, ωz]);       // every devicemotion event
//   sw.angle, sw.rate, sw.state                  // live club angle (deg, + = backswing) for the TV
//   ev = { power, curve, peak, back, twist, swingMs }   at impact, else null
//
// Hold the phone like a club grip, in both hands, its long axis along the
// shaft (any way round). The swing is the rotation across that axis; turning
// about it is the club face opening or closing.
//   * The first sustained rotation is the backswing; when it reverses, the
//     downswing starts; impact is when the club is back where it started.
//   * Power = the swing speed at impact / the club's full-swing speed
//     (1 = the red dot; more is an overswing).
//   * curve = how far the face turned between address and impact
//     (+ = face open = the ball curves right for a right-hander).
// ω is rotationRate [alpha, beta, gamma] in deg/s = rates about device X, Y, Z.

const ONSET = 45;            // °/s that starts the backswing
const REVERSE = 40;          // °/s of downswing that ends the backswing
const STILL = 22;            // °/s: at rest
const MAX_BACK_MS = 5000;    // a backswing that never comes down is dropped
const MAX_DOWN_MS = 1400;
const TWIST_FULL = 40;       // degrees of face turn for a full curve
const REFRACTORY = 450;

// Swing speed at impact (°/s) that fills the meter, per club (× strength setting).
export const FULL_RATE = { driver: 980, iron: 920, wedge: 820, putter: 300 };
export const MIN_BACK = { driver: 22, iron: 20, wedge: 16, putter: 5 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class GolfSwingDetector {
  constructor({ strength = 1, invertCurve = false, hand = 'right' } = {}) {
    this.strength = strength;
    this.invertCurve = invertCurve;
    this.hand = hand;
    this.club = 'driver';
    this.state = 'idle';       // idle | back | down | follow
    this.angle = 0;            // deg, + = backswing
    this.rate = 0;             // deg/s along the swing, + = going back
    this.t = null;
    this.until = 0;
    this._reset();
  }

  setClub(club) { if (FULL_RATE[club]) this.club = club; }

  _reset() {
    this.dir = null;           // backswing rotation direction (device frame, unit)
    this.onsetN = 0;
    this.back = 0;             // biggest backswing angle
    this.twist = 0;            // face turn since the takeaway (deg)
    this.peakDown = 0;
    this.recent = [];          // [{ t, r }] for the impact speed
    this.startT = 0;
    this.downT = 0;
  }

  get fullRate() { return FULL_RATE[this.club] * this.strength; }

  sample(t, w) {
    if (!w || !w.every(Number.isFinite)) return null;
    const dt = this.t === null ? 0 : clamp((t - this.t) / 1000, 0, 0.05);
    this.t = t;
    // Swing rotation: ω across the long (Y) axis; twist: ω about it.
    const perp = [w[0], 0, w[2]];
    const mag = Math.hypot(perp[0], perp[2]);
    const twistRate = w[1];
    let ev = null;
    switch (this.state) {
      case 'idle':
      case 'follow': {
        this.rate = 0;
        if (this.state === 'follow') {
          if (Math.hypot(w[0], w[1], w[2]) < STILL * 2) this.angle *= Math.exp(-dt * 6);
          if (t > this.until && mag < STILL * 2) { this.state = 'idle'; this.angle = 0; }
          break;
        }
        if (mag < STILL) this.angle *= Math.exp(-dt * 4);
        if (t < this.until) break;
        if (mag > ONSET) {
          this.onsetN++;
          if (!this.dir) this.dir = [0, 0, 0];
          this.dir[0] += perp[0]; this.dir[2] += perp[2];
          if (this.onsetN >= 3) {
            const l = Math.hypot(this.dir[0], this.dir[2]) || 1;
            this.dir = [this.dir[0] / l, 0, this.dir[2] / l];
            this.state = 'back';
            this.angle = 0;
            this.back = 0;
            this.twist = 0;
            this.startT = t;
          }
        } else { this.onsetN = 0; this.dir = null; }
        break;
      }
      case 'back': {
        const r = Math.sign(perp[0] * this.dir[0] + perp[2] * this.dir[2]) * mag;
        this.rate = r;
        this.angle += r * dt;
        this.twist += twistRate * dt;
        this.back = Math.max(this.back, this.angle);
        if (r < -REVERSE && this.back >= MIN_BACK[this.club]) { this.state = 'down'; this.downT = t; this.peakDown = 0; this.recent = []; }
        else if (t - this.startT > MAX_BACK_MS || (this.angle < -30 && this.back < MIN_BACK[this.club])) { this.state = 'idle'; this.angle = 0; this._reset(); }
        break;
      }
      case 'down': {
        const r = Math.sign(perp[0] * this.dir[0] + perp[2] * this.dir[2]) * mag;
        this.rate = r;
        this.angle += r * dt;
        this.twist += twistRate * dt;
        const speed = Math.max(0, -r);
        this.recent.push({ t, s: speed });
        while (this.recent.length && t - this.recent[0].t > 45) this.recent.shift();
        this.peakDown = Math.max(this.peakDown, speed);
        // Impact: back at address, or (with gyro drift) past the fastest point
        // and slowing, near the bottom.
        const atAddress = this.angle <= 0;
        const slowing = this.peakDown > 150 && speed < this.peakDown * 0.7 && this.angle < this.back * 0.35;
        if (atAddress || slowing || t - this.downT > MAX_DOWN_MS) ev = this._impact(t);
        break;
      }
      default: break;
    }
    return ev;
  }

  _impact(t) {
    let impact = 0;
    for (const x of this.recent) impact = Math.max(impact, x.s);
    const power = impact / this.fullRate;
    let curve = clamp(-this.twist / TWIST_FULL, -1, 1) * (this.hand === 'left' ? -1 : 1);
    if (this.invertCurve) curve = -curve;
    const ev = {
      power: Math.round(clamp(power, 0, 1.6) * 1000) / 1000,
      curve: Math.round(curve * 1000) / 1000,
      peak: Math.round(this.peakDown),
      back: Math.round(this.back),
      twist: Math.round(this.twist),
      swingMs: Math.round(t - this.startT),
    };
    this.state = 'follow';
    this.until = t + REFRACTORY;
    this._reset();
    return ev;
  }

  // Live meter value (0..1.6): how fast the club is coming down right now.
  get live() { return this.state === 'down' ? clamp(Math.max(0, -this.rate) / this.fullRate, 0, 1.6) : 0; }
  get backLevel() { return this.state === 'back' || this.state === 'down' ? clamp(this.back / 180, 0, 1) : 0; }

  cancel() { this.state = 'idle'; this.angle = 0; this.rate = 0; this._reset(); }
}
