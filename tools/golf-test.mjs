// Golf course, physics and rules checks.
//   node tools/golf-test.mjs            run the checks
//   node tools/golf-test.mjs --map 3    print hole 3 as an ASCII map
//   node tools/golf-test.mjs -v         verbose numbers
import { getHole, HOLE_NUMBERS } from '../public/js/shared/golf-course.js';
import { CLUBS, simulateShot, launchSpeedFor, suggestClub, putterScale, swingToShot, flatLanding } from '../public/js/shared/golf-physics.js';
import { GolfRound, scoreName, PARS } from '../public/js/shared/golf-rules.js';

const args = process.argv.slice(2);
const V = args.includes('-v');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const yd = (m) => m / 0.9144;

if (args.includes('--map')) {
  const n = Number(args[args.indexOf('--map') + 1]) || 1;
  const hole = getHole(n);
  const { x0, x1, z0, z1 } = hole.extent;
  const chars = { tee: 'T', fairway: '=', rough: '.', sand: 's', green: 'G', fringe: 'g', water: '~', ob: ' ' };
  const cell = 4;
  const pin = hole.pinFor(0);
  const trees = new Set(hole.trees.map((t) => `${Math.round(t.x / cell)},${Math.round(t.z / cell)}`));
  console.log(`Hole ${n} · Par ${hole.par} · ${hole.yards} yd   (1 char = ${cell} m, tee at bottom)`);
  for (let z = z0; z <= z1; z += cell * 2) {
    let line = '';
    for (let x = x0; x <= x1; x += cell) {
      if (Math.hypot(x - pin.x, z - pin.z) < cell) { line += 'P'; continue; }
      if (Math.hypot(x, z) < cell) { line += 'O'; continue; }
      const s = hole.surfaceAt(x, z);
      line += trees.has(`${Math.round(x / cell)},${Math.round(z / cell)}`) && s !== 'water' ? '♣' : chars[s];
    }
    console.log(line);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- clubs
for (const id of ['driver', 'iron', 'wedge']) {
  const v0 = launchSpeedFor(id, CLUBS[id].maxCarry);
  ok(v0 > 15 && v0 < 110, `${id}: full carry needs a sane launch speed (${v0.toFixed(1)} m/s)`);
  if (V) console.log(`  ${id.padEnd(6)} max carry ${yd(CLUBS[id].maxCarry).toFixed(0)} yd ← ${v0.toFixed(1)} m/s (${(v0 * 2.237).toFixed(0)} mph)`);
}

// Flat test hole: a full drive with no wind carries its rated distance.
const flat = {
  heightAt: () => 0, normalAt: () => [0, 1, 0], surfaceAt: () => 'fairway', trees: [], waterLevel: -5,
};
for (const id of ['driver', 'iron', 'wedge']) {
  for (const pw of [0.25, 0.5, 0.75, 1]) {
    const s = simulateShot(flat, { from: { x: 0, z: 0 }, clubId: id, power: pw, wind: [0, 0, 0] });
    const want = CLUBS[id].maxCarry * pw;
    ok(Math.abs(s.carry - want) < want * 0.04 + 1, `${id} ${pw * 100}% carries ${yd(want).toFixed(0)} yd (got ${yd(s.carry).toFixed(1)})`);
    if (V && pw === 1) {
      const apex = Math.max(...s.samples.map((q) => q.y));
      console.log(`  ${id.padEnd(6)} carry ${yd(s.carry).toFixed(0)} yd, total ${yd(s.total).toFixed(0)} yd, apex ${apex.toFixed(1)} m, hang ${s.landed.t.toFixed(2)} s`);
    }
  }
}
{
  // Wind: a 30 mph tailwind adds distance, a headwind takes it away, a crosswind drifts.
  const mph = 30 / 2.237;
  const run = (wind) => simulateShot(flat, { from: { x: 0, z: 0 }, clubId: 'driver', power: 1, wind });
  const still = run([0, 0, 0]), tail = run([0, 0, -mph]), head = run([0, 0, mph]), cross = run([mph, 0, 0]);
  ok(tail.carry > still.carry + 20, `tailwind adds carry (${yd(tail.carry).toFixed(0)} vs ${yd(still.carry).toFixed(0)} yd)`);
  ok(head.carry < still.carry - 25, `headwind costs carry (${yd(head.carry).toFixed(0)} yd)`);
  ok(cross.landed.x > 10, `crosswind drifts the ball (${cross.landed.x.toFixed(1)} m)`);
  if (V) console.log(`  30 mph: tail ${yd(tail.carry).toFixed(0)} · head ${yd(head.carry).toFixed(0)} · cross drift ${cross.landed.x.toFixed(1)} m`);
}
{
  // Hook / slice.
  const slice = simulateShot(flat, { from: { x: 0, z: 0 }, clubId: 'driver', power: 1, curve: 1 });
  const hook = simulateShot(flat, { from: { x: 0, z: 0 }, clubId: 'driver', power: 1, curve: -1 });
  ok(slice.landed.x > 20, `full slice curves right (${slice.landed.x.toFixed(1)} m)`);
  ok(hook.landed.x < -20, `full hook curves left (${hook.landed.x.toFixed(1)} m)`);
  const fade = simulateShot(flat, { from: { x: 0, z: 0 }, clubId: 'driver', power: 1, curve: 0.18 });
  ok(fade.landed.x > 1 && fade.landed.x < 15, `a little wrist = a gentle fade (${fade.landed.x.toFixed(1)} m)`);
}
{
  // Putting on a flat green rolls the asked distance.
  const green = { ...flat, surfaceAt: () => 'green' };
  const s = simulateShot(green, { from: { x: 0, z: 0 }, clubId: 'putter', power: 0.5, putterMax: 10 });
  ok(Math.abs(s.total - 5) < 0.25, `putt rolls 5 m (${s.total.toFixed(2)})`);
  // Holed putt: dead weight at the cup.
  const pin = { x: 0, z: -4 };
  const holed = simulateShot(green, { from: { x: 0, z: 0 }, clubId: 'putter', power: 4.3 / 10, putterMax: 10, pin });
  ok(holed.result === 'holed', `a straight putt that reaches the cup drops (${holed.result})`);
  const blast = simulateShot(green, { from: { x: 0, z: 0 }, clubId: 'putter', power: 1, putterMax: 30, pin });
  ok(blast.result !== 'holed', 'a putt hit far too hard does not drop');
  ok(blast.events.some((e) => e.type === 'lip') || blast.total > 8, 'and lips out or races past');
  const short = simulateShot(green, { from: { x: 0, z: 0 }, clubId: 'putter', power: 0.3, putterMax: 10, pin });
  ok(short.result === 'rest' && short.total < 4, 'a short putt stops short');
}
{
  // Sand plugs, rough grabs.
  const sand = { ...flat, surfaceAt: () => 'sand' };
  const rough = { ...flat, surfaceAt: () => 'rough' };
  const fair = simulateShot(flat, { from: { x: 0, z: 0 }, clubId: 'iron', power: 1 });
  const s = simulateShot(sand, { from: { x: 0, z: 0 }, clubId: 'iron', power: 1 });
  const r = simulateShot(rough, { from: { x: 0, z: 0 }, clubId: 'iron', power: 1 });
  ok(s.total - s.carry < 3, `ball plugs in sand (rolled ${(s.total - s.carry).toFixed(1)} m)`);
  ok(r.total - r.carry < fair.total - fair.carry, `rough stops the ball sooner than fairway (${(r.total - r.carry).toFixed(1)} vs ${(fair.total - fair.carry).toFixed(1)} m)`);
}
{
  // Lie caps and overswing.
  const a = swingToShot(0.95, 0, 'fairway');
  ok(a.over === 0 && a.nice, 'a 95% swing from the fairway is a nice shot');
  const b = swingToShot(0.95, 0.3, 'rough', 3);
  ok(b.over > 0.4 && Math.abs(b.curve) > 0.9, 'a full swing from the rough overswings and curves hard');
  ok(b.curve > 0, 'overswing curves the way the wrist turned');
  const c = swingToShot(0.24, 0, 'sand');
  ok(c.over === 0 && Math.abs(c.power - 0.24) < 1e-9, 'one dot from the sand is fine');
  ok(suggestClub(120, 'fairway') === 'iron' && suggestClub(60, 'fairway') === 'wedge' && suggestClub(200, 'rough') === 'driver', 'club suggestions');
  ok(suggestClub(5, 'green') === 'putter' && suggestClub(30, 'sand') === 'wedge', 'putter on the green, wedge in the sand');
  ok(putterScale(3) * 3.28 >= 10 && putterScale(30) * 3.28 >= 120 - 1, 'putter scale grows with the putt');
  const fl = flatLanding('driver', 0.5, { x: 0, z: 0 }, 0);
  ok(Math.abs(fl.z + 125) < 1e-6, 'flat landing marker');
}

// ---------------------------------------------------------------- holes
for (const n of HOLE_NUMBERS) {
  const hole = getHole(n);
  const pin = hole.pinFor(0);
  ok(hole.surfaceAt(0, -1) === 'tee', `hole ${n}: tee box at the origin (${hole.surfaceAt(0, -1)})`);
  ok(hole.surfaceAt(pin.x, pin.z) === 'green', `hole ${n}: every pin is on the green`);
  for (let i = 0; i < hole.pins.length; i++) { const p = hole.pinFor(i); ok(hole.surfaceAt(p.x, p.z) === 'green' && hole.greenDist(p.x, p.z) < -2, `hole ${n}: pin ${i} well inside the green`); }
  const d = Math.hypot(pin.x, pin.z);
  ok(d <= hole.yards * 0.9144 * 1.02, `hole ${n}: green no further than the card (${yd(d).toFixed(0)} ≤ ${hole.yards} yd)`);
  ok(hole.trees.length >= (hole.palms ? 6 : 40), `hole ${n}: has trees (${hole.trees.length})`);
  ok(hole.inBounds(0, -10), `hole ${n}: tee in bounds`);
  // Every aim point is on fairway or rough (not a hazard).
  for (const [ax, az] of hole.aim) ok(['fairway', 'rough'].includes(hole.surfaceAt(ax, az)), `hole ${n}: aim point (${ax},${az}) is playable (${hole.surfaceAt(ax, az)})`);
  // Pins on fairly flat ground.
  const nrm = hole.normalAt(pin.x, pin.z);
  ok(nrm[1] > 0.985, `hole ${n}: green at the pin isn't too steep (${Math.acos(nrm[1]) * 57.3}°)`);
  if (V) console.log(`  hole ${n}: par ${hole.par}, card ${hole.yards} yd, tee→pin ${yd(d).toFixed(0)} yd, trees ${hole.trees.length}`);
}
{
  // A good drive down hole 1 stays in play.
  const hole = getHole(1);
  const aim = Math.atan2(hole.aim[0][0], -hole.aim[0][1]);
  const s = simulateShot(hole, { from: { x: 0, z: 0, teed: true }, clubId: 'driver', power: 0.92, wind: [0, 0, 0], pin: hole.pinFor(0) });
  ok(s.result === 'rest' && ['fairway', 'rough'].includes(s.rest.surface), `hole 1 drive finds the short grass (${s.rest.surface})`);
  void aim;
  // Water and out of bounds where the holes promise them.
  const tee = { x: 0, z: 0, teed: true };
  const h4 = getHole(4);
  const lake = simulateShot(h4, { from: tee, aim: Math.atan2(32, 300), clubId: 'driver', power: 0.6, pin: h4.pinFor(0) });
  ok(lake.result === 'water', `hole 4: a short carry over the lake gets wet (${lake.result})`);
  const h5 = getHole(5);
  const pond = simulateShot(h5, { from: tee, clubId: 'iron', power: 0.45, pin: h5.pinFor(0) });
  ok(pond.result === 'water', `hole 5: a weak tee shot finds the pond (${pond.result})`);
  const h7 = getHole(7);
  const hook = simulateShot(h7, { from: tee, aim: -0.35, clubId: 'driver', power: 0.9, pin: h7.pinFor(0) });
  ok(hook.result === 'water', `hole 7: a hook goes over the cliff into the sea (${hook.result})`);
  const h8 = getHole(8);
  const sea = simulateShot(h8, { from: tee, clubId: 'iron', power: 0.6, pin: h8.pinFor(0) });
  ok(sea.result === 'water', `hole 8: a weak tee shot drops in the sea (${sea.result})`);
  const h9 = getHole(9);
  const push = simulateShot(h9, { from: tee, aim: 0.3, clubId: 'driver', power: 0.9, pin: h9.pinFor(0) });
  ok(push.result === 'ob', `hole 9: a push right goes out of bounds (${push.result})`);
}

// ---------------------------------------------------------------- rules
{
  ok(scoreName(1, 3) === 'Hole in One' && scoreName(2, 5) === 'Albatross' && scoreName(3, 5) === 'Eagle', 'score names (under)');
  ok(scoreName(4, 5) === 'Birdie' && scoreName(4, 4) === 'Par' && scoreName(5, 4) === 'Bogey' && scoreName(6, 4) === 'Double Bogey' && scoreName(7, 4) === 'Triple Bogey' && scoreName(9, 4) === '+5', 'score names (over)');
  ok(scoreName(1, 4) === 'Hole in One', 'an ace on a par 4 is a hole in one');
  const r = new GolfRound({ holes: [1, 2], players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  r.startHole({ x: 0, z: 0 }, { x: 0, z: -300 });
  ok(r.next() === 0, 'A tees off first');
  r.recordShot(0, { result: 'rest', pos: { x: 0, z: -200 }, surface: 'fairway' });
  ok(r.next() === 1, 'then B tees off');
  r.recordShot(1, { result: 'rest', pos: { x: 0, z: -150 }, surface: 'rough' });
  ok(r.next() === 1, 'B is farther away, so B plays');
  r.recordShot(1, { result: 'water', pos: { x: 0, z: -250 }, surface: 'water' });
  ok(r.players[1].strokes === 3 && r.players[1].pos.z === -150, 'water: shot + penalty, replay from the same spot');
  r.recordShot(1, { result: 'rest', pos: { x: 0, z: -290 }, surface: 'green' });
  ok(r.next() === 0, 'A is now farthest');
  r.recordShot(0, { result: 'holed', pos: { x: 0, z: -300 } });
  ok(r.players[0].done && r.players[0].strokes === 2, 'A holes out in 2');
  r.recordShot(1, { result: 'holed', pos: { x: 0, z: -300 } });
  ok(r.holeDone, 'hole over when everyone holes out');
  ok(r.players[1].strokes === 5, 'B took 5');
  r.finishHole();
  r.startHole({ x: 0, z: 0 }, { x: 0, z: -120 });
  ok(r.next() === 0, 'lowest score on the last hole tees off first');
  // Give up at three times par.
  for (let i = 0; i < 20 && !r.players[1].done; i++) r.recordShot(1, { result: 'ob', pos: { x: 99, z: 0 } });
  ok(r.players[1].done && r.players[1].gaveUp && r.players[1].strokes === 3 * r.par, `give up at 3× par (${r.players[1].strokes})`);
  r.recordShot(0, { result: 'holed', pos: { x: 0, z: -120 } });
  ok(r.holeDone, 'second hole over');
  r.finishHole();
  ok(r.over, 'round over after the last hole');
  const tot = r.totals();
  ok(tot[0].strokes === 3 && tot[1].strokes === 5 + 3 * PARS[2], `running totals (${tot[0].strokes}, ${tot[1].strokes})`);
  ok(r.standings()[0].index === 0 && r.standings()[0].place === 1, 'standings');
}

console.log(`golf: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
