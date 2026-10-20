// Synthetic swings through the phone swing detector.
//   node tools/swing-test.mjs
import assert from 'node:assert/strict';
import { SwingDetector, speedFromRate, spinFromTwist, forwardAxisFromUp, upFromOrientation } from '../public/js/remote/swing.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (err) { console.error(`✖ ${name}\n  ${err.message}`); process.exitCode = 1; }
};

import { makeSwing, GRIPS } from './swing-gen.mjs';

function run(opts, detOpts, { withUp = true } = {}) {
  const sw = new SwingDetector(detOpts);
  const { samples, tRelease, up } = makeSwing(opts);
  sw.grip(samples[0].t - 5, withUp ? up : null);
  let live = [];
  for (const s of samples) { sw.sample(s.t, s.w, s.a); live.push(sw.armAngle); }
  const res = sw.release(tRelease);
  return { res, live };
}

// ---- mappings
test('speed map: linear to a full swing, small bonus above, then capped', () => {
  assert.equal(speedFromRate(100), 0);
  assert.equal(speedFromRate(1000), 1);
  assert.ok(Math.abs(speedFromRate(560) - 0.5) < 1e-9);
  assert.ok(speedFromRate(1150) > 1 && speedFromRate(1150) < 1.1);
  assert.equal(speedFromRate(5000), 1.1);
});
test('spin map: dead zone and sign', () => {
  assert.equal(spinFromTwist(8), 0);
  assert.ok(spinFromTwist(80) <= -0.999);   // CCW twist → curves left
  assert.ok(spinFromTwist(-80) >= 0.999);
});

// ---- normal swings
test('standard swing released at the bottom: ok, sensible speed, no spin', () => {
  const { res } = run({ fwdPeakRate: 600 });
  assert.equal(res.quality, 'ok', JSON.stringify(res));
  assert.ok(Math.abs(res.speed - speedFromRate(600)) < 0.08, `speed ${res.speed}`);
  assert.equal(res.spin, 0);
  assert.ok(Math.abs(res.releaseAngle) < 25, `releaseAngle ${res.releaseAngle}`);
});
test('gentle swing is slower than a hard swing', () => {
  const soft = run({ fwdPeakRate: 300 }).res;
  const hard = run({ fwdPeakRate: 850 }).res;
  assert.equal(soft.quality, 'ok');
  assert.equal(hard.quality, 'ok');
  assert.ok(hard.speed > soft.speed + 0.3, `${soft.speed} vs ${hard.speed}`);
});
test('counter-clockwise twist hooks left, clockwise hooks right', () => {
  const left = run({ twistDeg: 60 }).res;
  const right = run({ twistDeg: -60 }).res;
  assert.ok(left.spin < -0.5, `left ${left.spin} (twist ${left.twist})`);
  assert.ok(right.spin > 0.5, `right ${right.spin}`);
});
test('invert spin setting', () => {
  const r = run({ twistDeg: 60 }, { invertSpin: true }).res;
  assert.ok(r.spin > 0.5);
});
test('late release on the upswing is lofted', () => {
  const r = run({ releaseAt: 55 }).res;
  assert.equal(r.quality, 'loft', JSON.stringify(r));
});
test('release during the backswing drops the ball behind', () => {
  const r = run({ releaseInBackswing: true }).res;
  assert.equal(r.quality, 'drop', JSON.stringify(r));
});
test('no swing (just press and release) does not throw', () => {
  const sw = new SwingDetector();
  sw.grip(0);
  for (let t = 0; t < 600; t += 16) sw.sample(t, [Math.sin(t) * 4, Math.cos(t * 3) * 4, Math.sin(t * 7) * 4], [0, -9.8, 0]);
  const r = sw.release(600);
  assert.equal(r.quality, 'none');
});
test('forward flick without a backswing still throws forward (released high: lofted)', () => {
  const r = run({ flick: true, fwdPeakRate: 700 }).res;
  assert.ok(r.quality === 'ok' || r.quality === 'loft', JSON.stringify(r));
  assert.ok(r.speed > 0.4);
});

// ---- robustness: grips, sensor conventions, sample rate
for (const grip of Object.keys(GRIPS)) {
  for (const accelSign of [1, -1]) {
    test(`grip ${grip}, accel sign ${accelSign}: ok + hook sign preserved`, () => {
      const r = run({ grip, accelSign, twistDeg: 50, fwdPeakRate: 650 }).res;
      assert.equal(r.quality, 'ok', JSON.stringify(r));
      assert.ok(Math.abs(r.speed - speedFromRate(650)) < 0.1, `speed ${r.speed}`);
      assert.ok(r.spin < -0.3, `spin ${r.spin}`);
    });
    test(`grip ${grip}, accel sign ${accelSign}: backswing release drops`, () => {
      const r = run({ grip, accelSign, releaseInBackswing: true }).res;
      assert.equal(r.quality, 'drop', JSON.stringify(r));
    });
  }
}
test('forward axis from the grip pose: standard grip → +X', () => {
  const ax = forwardAxisFromUp([0, -0.5, 0.866]);
  assert.ok(ax[0] > 0.99, JSON.stringify(ax));
  assert.equal(forwardAxisFromUp([0, -1, 0]), null);   // pointing straight down: unknown
});
test('upFromOrientation: flat face-up and upright', () => {
  const flat = upFromOrientation(0, 0);
  assert.ok(Math.abs(flat[2] - 1) < 1e-9);
  const upright = upFromOrientation(90, 0);
  assert.ok(Math.abs(upright[1] - 1) < 1e-9);
});
test('without orientation data the standard grip still works', () => {
  const r = run({ releaseInBackswing: true }, {}, { withUp: false }).res;
  assert.equal(r.quality, 'drop');
  const f = run({ twistDeg: 50 }, {}, { withUp: false }).res;
  assert.equal(f.quality, 'ok');
  assert.ok(f.spin < -0.3);
});
test('arm hanging at the grip (no pose info): backswing-first logic', () => {
  const r = run({ startAngle: 0, releaseInBackswing: true }).res;
  assert.equal(r.quality, 'drop', JSON.stringify(r));
  const f = run({ startAngle: 0, twistDeg: -50 }).res;
  assert.equal(f.quality, 'ok', JSON.stringify(f));
  assert.ok(f.spin > 0.3);
});
for (const push of [10, 20, 30, 40]) {
  for (const withUp of [true, false]) {
    test(`pushaway ${push}° before the backswing (${withUp ? 'pose' : 'no pose'}): normal throw, arm swings back`, () => {
      const { res, live } = run({ pushaway: push, twistDeg: 50 }, {}, { withUp });
      assert.equal(res.quality, 'ok', JSON.stringify(res));
      assert.ok(res.spin < -0.3, `spin ${res.spin}`);
      if (withUp) assert.ok(Math.min(...live) < -30, `live arm went back: min ${Math.min(...live)}`);
    });
    // (A pushaway starts at the chest, where the grip pose is known.)
    if (withUp) test(`pushaway ${push}° then let go in the backswing: drop`, () => {
      const r = run({ pushaway: push, releaseInBackswing: true }, {}, { withUp }).res;
      assert.equal(r.quality, 'drop', JSON.stringify(r));
    });
  }
}
// ---- release point
for (const at of [-40, -25, -10, 0, 10, 25, 40, 60]) {
  test(`release point at ${at}° is measured (with the grip pose)`, () => {
    const r = run({ releaseAt: at, fwdPeakRate: 650 }).res;
    assert.ok(Math.abs(r.release - at) <= 8, `measured ${r.release} for ${at}`);
  });
}
for (const at of [0, 20, 45]) {
  test(`release point at ${at}° without pose data (from the bottom of the swing)`, () => {
    const r = run({ releaseAt: at, fwdPeakRate: 650 }, {}, { withUp: false }).res;
    assert.ok(Math.abs(r.release - at) <= 12, `measured ${r.release} for ${at}`);
  });
}
for (const grip of ['thigh', 'screenBack']) {
  test(`release point with the ${grip} grip`, () => {
    const early = run({ grip, releaseAt: -30, fwdPeakRate: 650 }).res;
    const late = run({ grip, releaseAt: 35, fwdPeakRate: 650 }).res;
    assert.ok(Math.abs(early.release + 30) <= 9, `early ${early.release}`);
    assert.ok(Math.abs(late.release - 35) <= 9, `late ${late.release}`);
  });
}
test('release point survives a pushaway', () => {
  const r = run({ pushaway: 25, releaseAt: -20, fwdPeakRate: 650 }).res;
  assert.ok(Math.abs(r.release + 20) <= 9, `measured ${r.release}`);
});
test('ball speed follows arm speed (soft < medium < hard, clearly apart)', () => {
  const v = [300, 600, 950].map((rate) => run({ fwdPeakRate: rate }).res.speed);
  assert.ok(v[1] - v[0] > 0.25 && v[2] - v[1] > 0.25, JSON.stringify(v));
});
test('an early release (still accelerating) gives less speed than the same swing at the bottom', () => {
  const early = run({ releaseAt: -35, fwdPeakRate: 800 }).res;
  const bottom = run({ releaseAt: 0, fwdPeakRate: 800 }).res;
  assert.ok(early.speed < bottom.speed - 0.1, `${early.speed} vs ${bottom.speed}`);
});
test('events delivered in bursts (equal timestamps) still measure the release point', () => {
  const sw = new SwingDetector();
  const { samples, tRelease, up } = makeSwing({ releaseAt: -28, fwdPeakRate: 650 });
  sw.grip(samples[0].t - 5, up);
  // Delivered two or three at a time, stamped with the delivery time.
  let stamp = samples[0].t;
  samples.forEach((s, i) => { if (i % 3 === 0) stamp = s.t + 30; sw.sample(stamp, s.w, s.a); });
  const r = sw.release(Math.max(tRelease, stamp + 1));
  assert.equal(r.quality, 'ok', JSON.stringify(r));
  assert.ok(Math.abs(r.release + 28) <= 10, `measured ${r.release}`);
});
test('30 Hz sampling still works', () => {
  const r = run({ hz: 30, fwdPeakRate: 600, twistDeg: -40 }).res;
  assert.equal(r.quality, 'ok');
  assert.ok(r.spin > 0.2);
});
test('heavy noise does not invent spin', () => {
  const r = run({ noise: 25, fwdPeakRate: 600 }).res;
  assert.equal(r.quality, 'ok');
  assert.ok(Math.abs(r.spin) < 0.25, `spin ${r.spin}`);
});
test('live arm angle follows the swing (back then forward)', () => {
  const { live } = run({ fwdPeakRate: 600, releaseAt: 20 });
  const min = Math.min(...live);
  assert.ok(min < -40, `min ${min}`);
  assert.ok(live[live.length - 1] > min + 60, `end ${live[live.length - 1]}`);
});
test('very hard swing flags the safety nag', () => {
  const r = run({ fwdPeakRate: 1500 }).res;
  assert.equal(r.hard, true);
  assert.equal(r.speed, 1.1);
});
test('accelerometer-only phones still throw', () => {
  const sw = new SwingDetector();
  const { samples, tRelease } = makeSwing({ fwdPeakRate: 600 });
  sw.grip(samples[0].t - 5);
  for (const s of samples) sw.sample(s.t, null, s.a);
  const r = sw.release(tRelease);
  assert.equal(r.quality, 'ok', JSON.stringify(r));
  assert.ok(r.speed > 0.3);
});

console.log(process.exitCode ? `swing: some tests FAILED (${passed} passed)` : `swing: all ${passed} tests passed`);
