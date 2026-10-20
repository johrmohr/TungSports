// Test autopilot for the KARTS sandbox + tools/kart-test.mjs (not the game AI).
// Pure pursuit along track.racingLine with optional automatic hop-drifting.
// Node-safe.

import { clamp, angleDiff } from '../js/utils.js';
import { DRIFT } from '../js/config.js';
import { KART_TUNE, driftTightness, driftSteerFor } from '../js/kart.js';

export class Autopilot {
  constructor(kart, { offset = 0, drift = true, throttle = 1, lookBase = 6, lookGain = 0.45, driftMinRadius = 48 } = {}) {
    this.kart = kart;
    this.offset = offset;
    this.driftEnabled = drift;
    this.throttle = throttle;
    this.lookBase = lookBase;
    this.lookGain = lookGain;
    this.driftMinRadius = driftMinRadius;
    this._f = {};
    this._pt = { x: 0, y: 0, z: 0 };
    this.state = 'drive';     // 'drive' | 'drift'
    this.cooldown = 0;
    this.driftsDone = 0;
    this.maxTier = 0;
    this.pwmAcc = 0;          // drift steering pulse (see update)
    this.pwmHigh = false;
    this.pwmHold = 0;
  }

  // Mean curvature over [s+a, s+b].
  curvatureAhead(s, a, b, step = 3) {
    const tr = this.kart.track;
    let sum = 0, n = 0;
    for (let x = a; x <= b; x += step) { sum += tr.frameAt(s + x, this._f).curvature; n++; }
    return n ? sum / n : 0;
  }

  update(dt) {
    const k = this.kart, tr = k.track, proj = k.proj, inp = k.input;
    if (proj.s === undefined) { tr.project(k.position, k.hint, proj); k.hint = proj.index; }
    const v = Math.max(0, k.speed);
    const Ld = this.lookBase + this.lookGain * v;
    const sT = proj.s + Ld;
    const f = tr.frameAt(sT, this._f);
    const lim = Math.max(0, f.halfWidth - 1.6);
    const lat = clamp(f.racingLine + this.offset, -lim, lim);
    const pt = tr.pointAt(sT, lat);
    const dx = pt.x - k.position.x, dz = pt.z - k.position.z;
    const dist = Math.max(1, Math.hypot(dx, dz));
    const alpha = angleDiff(k.yaw, Math.atan2(dx, dz));      // + = target to the LEFT
    const yawReq = (2 * Math.sin(alpha) / dist) * Math.max(v, 4); // + = turn left
    const st = k.stats;
    let fs = Math.min(1, Math.max(v, 1) / KART_TUNE.turnRefSpeed);
    fs *= 1 - KART_TUNE.highSpeedTurnLoss * clamp((v - 12) / 18, 0, 1);
    let steer = clamp(-yawReq / (st.turnRate * fs), -1, 1);
    let drift = false;
    this.cooldown = Math.max(0, this.cooldown - dt);

    const d = k.drift;
    if (this.driftEnabled) {
      const cNear = this.curvatureAhead(proj.s, 2, 14);
      const cFar = this.curvatureAhead(proj.s, 6, 34);
      if (this.state === 'drive') {
        if (this.cooldown <= 0 && k.grounded && v > DRIFT.minSpeed + 4 && Math.abs(cFar) > 1 / this.driftMinRadius && Math.sign(cFar) === Math.sign(cNear || cFar)) {
          this.state = 'drift';
          this.dir = Math.sign(cFar);
          this.hopTime = 0;
        }
      }
      if (this.state === 'drift') {
        drift = true;
        this.hopTime += dt;
        if (!d.active) {
          // during the hop: steer firmly into the corner to start the drift
          steer = this.dir * Math.max(0.6, Math.abs(steer));
          if (this.hopTime > 0.45) { this.state = 'drive'; this.cooldown = 0.6; drift = false; }
        } else {
          this.maxTier = Math.max(this.maxTier, d.tier);
          // map required yaw rate onto drift tightness
          const base = st.turnRate * Math.min(1, v / 10);
          const mag = (-d.dir * yawReq) / Math.max(0.2, base);   // multiplier wanted
          steer = d.dir * driftSteerFor(mag);
          // The wheel held into the turn (steer * dir >= DRIFT.chargeIntoMin)
          // charges mini-turbos 2.5x faster, but wide corners need less turn
          // than that: pulse between "in" and full counter-steer with the duty
          // cycle that gives the wanted average tightness (an expert's technique).
          const mIn = driftTightness(DRIFT.chargeIntoMin);
          if (mag < mIn && mag > KART_TUNE.driftWide) {
            this.pwmAcc = clamp(this.pwmAcc + (mag - (this.pwmHigh ? mIn : KART_TUNE.driftWide)) * dt, -0.3, 0.3);
            this.pwmHold -= dt;
            const high = this.pwmAcc > 0;
            if (this.pwmHold <= 0 && high !== this.pwmHigh) { this.pwmHigh = high; this.pwmHold = 0.12; }
            steer = this.pwmHigh ? d.dir * DRIFT.chargeIntoMin : -d.dir;
          }
          const cornerEnding = Math.abs(cNear) < 1 / 90 || Math.sign(cNear) !== d.dir;
          const tooWide = mag < KART_TUNE.driftWide - 0.25;
          if (cornerEnding || tooWide) {
            drift = false;
            this.state = 'drive';
            this.cooldown = 0.5;
            this.driftsDone++;
          }
        }
      }
    }

    inp.steer = steer;
    inp.throttle = this.throttle;
    inp.brake = 0;
    inp.drift = drift;
  }
}

