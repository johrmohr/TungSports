// The release-point model.   node tools/throw-test.mjs
import assert from 'node:assert/strict';
import { releaseEffects, releaseGrade, RELEASE_ZONE } from '../public/js/shared/throw.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (err) { console.error(`✖ ${name}\n  ${err.message}`); process.exitCode = 1; }
};

test('inside the sweet spot nothing changes', () => {
  for (const r of [RELEASE_ZONE.early, -5, 0, 10, RELEASE_ZONE.late]) {
    const fx = releaseEffects(r);
    assert.deepEqual([fx.speedK, fx.spinK, fx.lineDeg, fx.loftY, fx.dumpVy], [1, 1, 0, 0, 0], `at ${r}`);
  }
});
test('early: slower, dumped, pushed outward, a little more turn — growing with earliness', () => {
  const a = releaseEffects(-20), b = releaseEffects(-40);
  assert.ok(a.speedK < 1 && b.speedK < a.speedK);
  assert.ok(a.dumpVy < 0 && b.dumpVy < a.dumpVy);
  assert.ok(a.lineDeg > 0 && b.lineDeg > a.lineDeg, 'right-hander pushed right');
  assert.ok(b.spinK > 1);
  assert.equal(a.loftY, 0);
});
test('late: lofted, hooks less, pulled across — growing with lateness', () => {
  const a = releaseEffects(30), b = releaseEffects(55);
  assert.ok(a.loftY > 0 && b.loftY > a.loftY && b.loftVy > a.loftVy);
  assert.ok(a.spinK < 1 && b.spinK < a.spinK);
  assert.ok(a.lineDeg < 0 && b.lineDeg < a.lineDeg, 'right-hander pulled left');
  assert.ok(b.speedK < 1 && b.speedK > 0.9, 'a lofted ball keeps most of its speed');
});
test('left-handers are mirrored', () => {
  assert.equal(releaseEffects(-30, 'left').lineDeg, -releaseEffects(-30, 'right').lineDeg);
  assert.equal(releaseEffects(40, 'left').lineDeg, -releaseEffects(40, 'right').lineDeg);
});
test('effects are bounded', () => {
  const e = releaseEffects(-150), l = releaseEffects(150);
  assert.ok(e.speedK >= 0.75 && Math.abs(e.lineDeg) <= 2.2 && e.dumpVy >= -1.5);
  assert.ok(l.spinK >= 0.3 && l.loftY <= 0.45 && l.loftVy <= 1.6 && Math.abs(l.lineDeg) <= 2.2);
});
test('no release data (keyboard, touch) = a clean release', () => {
  assert.equal(releaseEffects(undefined).speedK, 1);
  assert.equal(releaseGrade(undefined).grade, 'none');
});
test('grades', () => {
  assert.equal(releaseGrade(2).grade, 'perfect');
  assert.equal(releaseGrade(-10).grade, 'good');
  assert.equal(releaseGrade(17).grade, 'good');
  assert.equal(releaseGrade(-25).grade, 'early');
  assert.equal(releaseGrade(-50).grade, 'way-early');
  assert.equal(releaseGrade(30).grade, 'late');
  assert.equal(releaseGrade(60).grade, 'lofted');
});

console.log(process.exitCode ? `throw: some tests FAILED (${passed} passed)` : `throw: all ${passed} tests passed`);
