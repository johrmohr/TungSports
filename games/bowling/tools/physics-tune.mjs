// Headless pin-action tuning: strike rates by impact board / entry angle,
// hook paths down the full lane, gutter behaviour and rack stability.
//   node tools/physics-tune.mjs [--quick]
import RAPIER from '@dimforge/rapier3d-compat';
import { LanePhysics, DIM, TUNING, speedToMps } from '../public/js/shared/physics.js';

await RAPIER.init();
const quick = process.argv.includes('--quick');
const lane = new LanePhysics(RAPIER);

function run(th, rackFn = () => lane.rack()) {
  rackFn();
  lane.throwBall(th);
  let guard = 0;
  while (lane.step(1 / 60) && guard++ < 60 * 12);
  return lane.result();
}

// 1. Rack stability: pins must stay put with nothing touching them.
lane.rack();
for (let i = 0; i < 60 * 5; i++) lane.step(1 / 60);
const idle = lane.pins.filter((p) => lane.pinStanding(p)).length;
console.log(`rack stability: ${idle}/10 standing after 5 s idle`);

// 2. Pin action: ball launched 2.5 m before the head pin at a board and entry angle.
// Negative angle = ball moving right→left (a right-hander's hook into the 1-3 pocket at +x).
function pinAction(hitX, entryDeg, mps, trials = quick ? 8 : 20) {
  let strikes = 0, total = 0;
  const leaves = new Map();
  for (let k = 0; k < trials; k++) {
    const jitter = (k / trials - 0.5) * 0.02;          // ±1 cm spread
    const a = (entryDeg * Math.PI) / 180;
    const back = 2.5;
    const x0 = hitX + jitter + Math.sin(a) * back * -1;
    const r = run({ x: x0, z: DIM.headPinZ + back, angle: a, mps, spin: 0 });
    total += r.knocked;
    if (r.knocked === 10) strikes++;
    else {
      const key = r.standing.join('-');
      leaves.set(key, (leaves.get(key) || 0) + 1);
    }
  }
  const top = [...leaves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k}×${n}`).join(' ');
  return { strikeRate: strikes / trials, avg: total / trials, top };
}

console.log('\npin action (hitX m, entry°, m/s) → strike rate, avg pins, common leaves');
const cases = [
  ['head-on', 0.0, 0, 8],
  ['head-on fast', 0.0, 0, 10],
  ['light head', 0.03, 0, 8],
  ['pocket straight', 0.065, 0, 8],
  ['pocket 3°', 0.065, -3, 8],
  ['pocket 5°', 0.065, -5, 8],
  ['pocket 6° slow', 0.065, -6, 6.5],
  ['pocket 6° fast', 0.065, -6, 9.5],
  ['high pocket 5°', 0.035, -5, 8],
  ['light pocket 5°', 0.10, -5, 8],
  ['very light 5°', 0.14, -5, 8],
  ['brooklyn 5°', -0.065, 5, 8],
  ['left pocket straight', -0.065, 0, 8],
  ['edge 10-pin side', 0.40, 0, 8],
];
for (const [name, x, deg, v] of cases) {
  const r = pinAction(x, deg, v);
  console.log(`  ${name.padEnd(22)} x=${x.toFixed(3)} ${String(deg).padStart(3)}° ${v}m/s → strike ${(r.strikeRate * 100).toFixed(0).padStart(3)}%  avg ${r.avg.toFixed(1)}  ${r.top}`);
}

// 3. Full-lane hook paths: where does a throw from x with angle and spin hit?
console.log('\nfull lane paths (x0, angle°, speed, spin) → board at pins, entry°, pins');
const paths = [
  [0, 0, 0.6, 0], [0, 0, 0.6, -0.5], [0.3, -1.5, 0.6, -0.6], [0.35, -2.5, 0.6, -0.8], [0.25, -1, 0.5, -1],
  [0.25, -1, 0.9, -1], [-0.3, 1.5, 0.6, 0.6], [0, 0, 0.1, 0], [0, 0, 1.2, 0],
];
for (const [x, deg, speed, spin] of paths) {
  const r = run({ x, angle: (deg * Math.PI) / 180, speed, spin });
  console.log(`  x=${x.toFixed(2)} ${String(deg).padStart(5)}° s=${speed} (${speedToMps(speed).toFixed(1)} m/s) spin=${String(spin).padStart(4)} → hitX ${r.hitBoard?.toFixed(3) ?? '—'} entry ${r.entryAngle?.toFixed(1) ?? '—'}° knocked ${r.knocked} t=${r.time.toFixed(2)}s ${r.gutter ? 'GUTTER' : ''} standing:[${r.standing}]`);
}

// 4. Gutter balls must not knock pins.
console.log('\ngutters');
for (const [x, deg] of [[0.45, 3], [-0.45, -3], [0.2, 4]]) {
  const r = run({ x, angle: (deg * Math.PI) / 180, speed: 0.6, spin: 0 });
  console.log(`  x=${x} ${deg}° → gutter=${r.gutter} knocked=${r.knocked} t=${r.time.toFixed(2)}`);
}

// 5. Second ball: respot standing pins and pick up a spare.
lane.rack();
lane.respot([7, 10]);
console.log(`\nrespot: ${lane.pins.map((p) => p.n).join(',')} on deck`);
for (let i = 0; i < 120; i++) lane.step(1 / 60);
console.log(`  standing after 2 s: ${lane.pins.filter((p) => lane.pinStanding(p)).length}/2`);

const t0 = performance.now();
run({ x: 0.065, z: DIM.headPinZ + 2.5, angle: -0.09, mps: 8, spin: 0 });
console.log(`\nperf: one pocket roll simulated in ${(performance.now() - t0).toFixed(0)} ms (tuning ${JSON.stringify({ hook: TUNING.hookAccel })})`);

// 6. Regression: a roll must finish even when the ball leaves the world and a
// pin keeps rocking (the roll clock used to stop with the ball).
{
  lane.rack();
  lane.throwBall({ x: 0.065, z: DIM.headPinZ + 2.5, angle: -0.09, mps: 9, spin: 0 });
  let frames = 0;
  while (lane.step(1 / 60) && frames < 60 * 30) {
    frames++;
    if (!lane.ball && lane.pins[0]) lane.pins[0].body.setAngvel({ x: 2, y: 0, z: 0 }, true);   // keep a pin "rocking"
  }
  console.log(`\nroll ends with the ball gone + a rocking pin: ${frames < 60 * 30 ? 'yes' : 'NO (stuck)'} after ${(frames / 60).toFixed(1)} s`);
  if (frames >= 60 * 30) process.exitCode = 1;
}
