// Tennis rules + ball physics checks.   node tools/tennis-test.mjs
import { TennisMatch } from '../public/js/shared/tennis-rules.js';
import { COURT, BALL, makeBall, stepBall, predict, solveShot, landsIn, netHeightAt, spinFor, ballAt } from '../public/js/shared/tennis-physics.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a.toFixed(3)} vs ${b} ±${tol}`);

// ---------------------------------------------------------------- scoring
{
  const m = new TennisMatch({ format: 1 });
  ok(m.gamesToWin === 1, 'one game format');
  ok(m.server.team === 0 && m.server.member === 0, 'team 0 member 0 serves first');
  ok(m.side === 'deuce', 'first serve from the deuce court');
  m.point(0);
  ok(m.pointLabel(0) === '15' && m.pointLabel(1) === '0', '15–0 labels');
  ok(m.side === 'ad', 'second point from the ad court');
  ok(m.call() === '15–Love', `call 15–Love (${m.call()})`);
  m.point(1);
  ok(m.call() === '15 all', `call 15 all (${m.call()})`);
  m.point(0); m.point(0);
  ok(m.situation()?.kind === 'match point' && m.situation().team === 0, 'match point at 40–15 in a one-game match');
  m.point(1); m.point(1);
  ok(m.isDeuce() && m.call() === 'Deuce', 'deuce at 40–40');
  ok(m.situation()?.kind === 'deuce', 'situation: deuce');
  let r = m.point(1);
  ok(r.advantageTeam === 1 && m.pointLabel(1) === 'Ad' && m.pointLabel(0) === '40', 'advantage team 1');
  ok(m.situation()?.kind === 'match point' && m.situation().team === 1, 'advantage = match point for team 1');
  r = m.point(0);
  ok(r.deuce && m.isDeuce(), 'back to deuce');
  m.point(0);
  r = m.point(0);
  ok(r.game === 0 && r.match === 0 && m.over && m.winner === 0, 'team 0 wins the one-game match from advantage');
  ok(m.point(1).call === null, 'no points after the match');
}
{
  const m = new TennisMatch({ format: 3 });
  ok(m.gamesToWin === 2, 'best of 3 needs 2 games');
  const servers = [];
  const winGame = (team) => { servers.push(`${m.server.team}${m.server.member}`); for (let i = 0; i < 4; i++) m.point(team); };
  winGame(1);                                  // break of serve
  ok(m.games[1] === 1 && m.server.team === 1 && m.server.member === 0, 'serve passes to team 1 member 0');
  ok(m.situation() === null, 'no call at 0–0');
  for (let i = 0; i < 3; i++) m.point(1);
  ok(m.situation()?.kind === 'match point', 'team 1 at 40–0 with a game in hand: match point');
  for (let i = 0; i < 5; i++) m.point(0);          // 0–40 → deuce → ad → game
  ok(m.games[0] === 1 && m.games[1] === 1, '1–1 in games');
  ok(m.server.team === 0 && m.server.member === 1, 'third game: team 0 member 1 serves');
  m.point(1); m.point(1); m.point(1);
  ok(m.situation()?.kind === 'match point' && m.situation().team === 1, 'break point that is also match point says match point');
  m.point(1);
  ok(m.over && m.winner === 1, 'team 1 wins 2–1');
  ok(servers.join(',') === '00', 'server log');
}
{
  // Break point vs game point.
  const m = new TennisMatch({ format: 5 });
  for (let i = 0; i < 3; i++) m.point(1);
  ok(m.situation()?.kind === 'break point' && m.situation().team === 1, 'receivers at 0–40: break point');
  const m2 = new TennisMatch({ format: 5 });
  for (let i = 0; i < 3; i++) m2.point(0);
  ok(m2.situation()?.kind === 'game point', 'servers at 40–0: game point');
}
{
  // Receivers alternate courts point by point.
  const m = new TennisMatch({ format: 5 });
  const recv = [];
  for (let i = 0; i < 4; i++) { recv.push(m.receiver.member); m.point(i % 2); }
  ok(recv.join('') === '0101', `receivers alternate (${recv.join('')})`);
}

// ---------------------------------------------------------------- physics
{
  near(netHeightAt(0), 0.914, 1e-9, 'net centre height');
  near(netHeightAt(COURT.postX), 1.07, 1e-9, 'net post height');
  // A dropped ball bounces to ~55% of its height (e² ≈ 0.55).
  const b = makeBall([0, 2.54, 5], [0, 0, 0]);
  let peak = 0, bounced = false;
  for (let i = 0; i < 2400; i++) {
    const ev = stepBall(b);
    if (ev?.type === 'bounce') { if (bounced) break; bounced = true; }
    if (bounced) peak = Math.max(peak, b.y);
  }
  ok(peak > 1.1 && peak < 1.6, `drop test rebound ${peak.toFixed(2)} m (ITF: 1.35–1.47 m from 2.54 m)`);
}
{
  // Topspin kicks: after the bounce it keeps more pace than a slice.
  const run = (top) => {
    const b = makeBall([0, 1, 11], [0, 4.2, -21], spinFor(0, -1, top));
    for (let i = 0; i < 2400; i++) { const ev = stepBall(b); if (ev?.type === 'bounce') return { vh: Math.hypot(b.vx, b.vz), vy: b.vy, z: ev.z }; }
    return null;
  };
  const tops = run(250), flat = run(0), slice = run(-200);
  ok(tops && flat && slice, 'spin runs bounce');
  ok(tops.z > flat.z, `topspin dips shorter (${tops.z.toFixed(2)} vs ${flat.z.toFixed(2)})`);
  ok(slice.z < flat.z, `slice floats longer (${slice.z.toFixed(2)} vs ${flat.z.toFixed(2)})`);
  ok(tops.vh > slice.vh, `topspin kicks harder than slice after the bounce (${tops.vh.toFixed(1)} vs ${slice.vh.toFixed(1)} m/s)`);
}
{
  // Net: a ball fired low into the net stays on the hitter's side.
  const p = predict(makeBall([0, 0.5, 8], [0, 0.5, -20]), { maxT: 3 });
  ok(p.net && !p.net.cord, 'low ball hits the net');
  ok(p.bounces.length && p.bounces[0].z > 0, 'netted ball drops on the hitter’s side');
}

// Shot solver: every kind of shot lands near its target and clears the net.
const cases = [
  { name: 'drive', from: [1, 0.95, 11.2], target: [-2.5, -9.0], o: { time: 1.25, top: 160, clear: 0.3 } },
  { name: 'cross drive', from: [-3, 0.9, 10.5], target: [3.8, -8.0], o: { time: 1.3, top: 180, clear: 0.3 } },
  { name: 'slice', from: [2, 0.8, 11], target: [-1.5, -8.5], o: { time: 1.35, top: -140, clear: 0.12 } },
  { name: 'lob', from: [0, 1.0, 11], target: [1.5, -10.4], o: { time: 2.3, top: 60, clear: 2.0 } },
  { name: 'volley', from: [0.5, 1.2, 2.5], target: [-3.5, -7.0], o: { time: 0.75, top: 0, clear: 0.15 } },
  { name: 'drop volley', from: [-0.5, 0.9, 2.2], target: [2.5, -3.2], o: { time: 0.9, top: -60, clear: 0.12 } },
  { name: 'smash', from: [0.5, 2.8, 4.0], target: [-2.0, -7.5], o: { time: 0.5, top: 0, clear: 0.08 } },
  { name: 'serve', from: [1.0, 2.75, 12.2], target: [-2.4, -5.7], o: { time: 0.85, top: 40, clear: 0.08 } },
  { name: 'fast serve', from: [-1.0, 2.8, 12.2], target: [2.3, -5.9], o: { time: 0.6, top: 0, clear: 0.05 } },
  { name: 'team 1 drive', from: [-1, 1.0, -11.0], target: [2.0, 9.0], o: { time: 1.25, top: 160, clear: 0.3 } },
];
for (const c of cases) {
  const s = solveShot(c.from, c.target, c.o);
  ok(!!s, `${c.name}: solved`);
  if (!s) continue;
  const p = predict(makeBall(c.from, s.v, s.w), { maxT: 4, maxBounces: 1 });
  ok(!p.net || p.net.cord === false ? !p.net : true, `${c.name}: clears the net`);
  const land = p.bounces[0];
  ok(land && Math.hypot(land.x - c.target[0], land.z - c.target[1]) < 0.4, `${c.name}: lands on target (${land ? `${land.x.toFixed(2)},${land.z.toFixed(2)}` : 'none'})`);
  const speed = Math.hypot(s.v[0], s.v[1], s.v[2]);
  if (c.name === 'fast serve') ok(speed > 26, `fast serve speed ${speed.toFixed(1)} m/s`);
  if (process.argv.includes('-v')) console.log(`  ${c.name.padEnd(12)} v=${speed.toFixed(1)} m/s  t=${s.tLand.toFixed(2)} s  net y=${s.netY?.toFixed(2)}`);
}
{
  // ballAt agrees with step-by-step flight.
  const start = makeBall([0, 1, 11], [0.5, 3, -18], spinFor(0.03, -1, 150));
  const a = ballAt(start, 0.5);
  const p = predict(start, { maxT: 0.6, every: 1 });
  const last = p.samples.reduce((a, b) => (Math.abs(b.t - 0.5) < Math.abs(a.t - 0.5) ? b : a));
  near(a.z, last.z, 0.05, 'ballAt matches predict');
}
{
  // Service boxes.
  ok(landsIn(-2, -5, 1, { side: 'deuce' }), 'team 1 deuce box is x<0');
  ok(!landsIn(2, -5, 1, { side: 'deuce' }), 'team 1 ad side is not the deuce box');
  ok(landsIn(2, 5, 0, { side: 'deuce' }), 'team 0 deuce box is x>0');
  ok(!landsIn(-2, -7, 1, { side: 'deuce' }), 'long serve is out');
  ok(landsIn(5.3, -11.5, 1), 'doubles alley is in during a rally');
  ok(!landsIn(5.7, -9, 1), 'wide is out');
  ok(!landsIn(0, -12.2, 1), 'long is out');
  ok(!landsIn(0, -4, 0), 'own side is not the opponents’ court');
}

console.log(`tennis: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
void BALL;
