// Ten-pin scoring, marks, turn order and split detection.
//   node tools/scoring-test.mjs
import assert from 'node:assert/strict';
import { scoreGame, nextBall, pinsStanding, isSplit, frameMarks, BowlingGame, leaveName } from '../public/js/shared/scoring.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (err) { console.error(`✖ ${name}\n  ${err.message}`); process.exitCode = 1; }
};
const rep = (n, arr) => Array.from({ length: n }, () => arr).flat();
const total = (rolls) => scoreGame(rolls).total;

// ---- totals
test('perfect game = 300', () => assert.equal(total(rep(12, [10])), 300));
test('all gutters = 0', () => assert.equal(total(rep(20, [0])), 0));
test('9-0 every frame = 90', () => assert.equal(total(rep(10, [9, 0])), 90));
test('9 spare every frame, 9 bonus = 190', () => assert.equal(total([...rep(10, [9, 1]), 9]), 190));
test('5 spare every frame, 5 bonus = 150', () => assert.equal(total([...rep(10, [5, 5]), 5]), 150));
test('alternating strike / spare = 200', () => {
  const rolls = [10, 5, 5, 10, 5, 5, 10, 5, 5, 10, 5, 5, 10, 5, 5, 10];
  assert.equal(total(rolls), 200);
});
test('alternating spare / strike = 200', () => {
  const rolls = [5, 5, 10, 5, 5, 10, 5, 5, 10, 5, 5, 10, 5, 5, 10, 5, 5];
  assert.equal(total(rolls), 200);
});
test('11 strikes then 9 = 299', () => assert.equal(total([...rep(11, [10]), 9]), 299));
test('9 strikes then 9-0 = 267', () => assert.equal(total([...rep(9, [10]), 9, 0]), 267));
test('classic sample game = 133', () => {
  const rolls = [1, 4, 4, 5, 6, 4, 5, 5, 10, 0, 1, 7, 3, 6, 4, 10, 2, 8, 6];
  assert.equal(total(rolls), 133);
});
test('tenth: X 9 / = 20 in frame', () => {
  const rolls = [...rep(9, [0, 0]), 10, 9, 1];
  const g = scoreGame(rolls);
  assert.equal(g.total, 20);
  assert.equal(g.complete, true);
});
test('tenth: 9 / X = 20 in frame', () => assert.equal(total([...rep(9, [0, 0]), 9, 1, 10]), 20));
test('tenth: X X 7 = 27', () => assert.equal(total([...rep(9, [0, 0]), 10, 10, 7]), 27));
test('USBC keeping-score walkthrough', () => {
  const rolls = [8, 0, 5, 5, 3, 5, 8, 1, 7, 1, 10, 9, 1, 10, 10, 8, 2, 6];
  assert.deepEqual(scoreGame(rolls).frames.map((f) => f.score), [8, 21, 29, 38, 46, 66, 86, 114, 134, 150]);
});
test('tenth variants: XXX / 0/X / X00 / X72 / X73', () => {
  const z = rep(9, [0, 0]);
  assert.equal(total([...z, 10, 10, 10]), 30);
  assert.equal(total([...z, 0, 10, 10]), 20);
  assert.equal(total([...z, 10, 0, 0]), 10);
  assert.equal(total([...z, 10, 7, 2]), 19);
  assert.equal(total([...z, 10, 7, 3]), 20);
});
test('10 strikes then 9,1 = 289; 9 strikes then 9/X = 279', () => {
  assert.equal(total([...rep(10, [10]), 9, 1]), 289);
  assert.equal(total([...rep(9, [10]), 9, 1, 10]), 279);
});
test('X X X running totals [30, null, null]', () => {
  assert.deepEqual(scoreGame([10, 10, 10]).frames.slice(0, 3).map((f) => f.score), [30, null, null]);
});
test('tenth open: 3 4 → complete after two balls', () => {
  const g = scoreGame([...rep(9, [0, 0]), 3, 4]);
  assert.equal(g.complete, true);
  assert.equal(g.total, 7);
});

// ---- pending scores
test('strike is pending until two more balls', () => {
  let g = scoreGame([10]);
  assert.equal(g.frames[0].score, null);
  g = scoreGame([10, 3]);
  assert.equal(g.frames[0].score, null);
  g = scoreGame([10, 3, 4]);
  assert.equal(g.frames[0].score, 17);
  assert.equal(g.frames[1].score, 24);
});
test('spare is pending until next ball', () => {
  let g = scoreGame([7, 3]);
  assert.equal(g.frames[0].score, null);
  g = scoreGame([7, 3, 4]);
  assert.equal(g.frames[0].score, 14);
  assert.equal(g.frames[1].score, null);   // frame 2 not finished yet
});
test('later open frame stays blank while an earlier strike is pending', () => {
  const g = scoreGame([10, 10]);
  assert.equal(g.frames[0].score, null);
  assert.equal(g.frames[1].score, null);
});

// ---- marks
test('marks: strike goes in the right box', () => assert.deepEqual(frameMarks([10], 0), ['', 'X']));
test('marks: spare', () => assert.deepEqual(frameMarks([7, 3], 0), ['7', '/']));
test('marks: misses', () => assert.deepEqual(frameMarks([0, 0], 0), ['-', '-']));
test('marks: gutter then spare', () => assert.deepEqual(frameMarks([0, 10], 0), ['-', '/']));
test('marks: tenth X X X', () => assert.deepEqual(frameMarks([10, 10, 10], 9), ['X', 'X', 'X']));
test('marks: tenth X 9 /', () => assert.deepEqual(frameMarks([10, 9, 1], 9), ['X', '9', '/']));
test('marks: tenth X 9 -', () => assert.deepEqual(frameMarks([10, 9, 0], 9), ['X', '9', '-']));
test('marks: tenth 9 / X', () => assert.deepEqual(frameMarks([9, 1, 10], 9), ['9', '/', 'X']));
test('marks: tenth 0 / 0', () => assert.deepEqual(frameMarks([0, 10, 0], 9), ['-', '/', '-']));
test('marks: tenth X 0 /', () => assert.deepEqual(frameMarks([10, 0, 10], 9), ['X', '-', '/']));
test('marks: tenth open', () => assert.deepEqual(frameMarks([4, 5], 9), ['4', '5', '']));
test('marks: split first ball is circled', () => {
  const m = frameMarks([8, 1], 0, [7, 10]);
  assert.deepEqual(m[0], { text: '8', split: true });
});

// ---- next ball
test('nextBall progression', () => {
  assert.deepEqual(nextBall([]), { frame: 0, ball: 0, freshRack: true, done: false });
  assert.deepEqual(nextBall([7]), { frame: 0, ball: 1, freshRack: false, done: false });
  assert.deepEqual(nextBall([10]), { frame: 1, ball: 0, freshRack: true, done: false });
  assert.equal(nextBall(rep(12, [10])).done, true);
  assert.equal(nextBall([...rep(9, [0, 0]), 10]).freshRack, true);
  assert.equal(nextBall([...rep(9, [0, 0]), 10, 4]).freshRack, false);
  assert.equal(nextBall([...rep(9, [0, 0]), 6, 4]).freshRack, true);
  assert.equal(nextBall([...rep(9, [0, 0]), 6, 3]).done, true);
});
test('pins standing', () => {
  assert.equal(pinsStanding([]), 10);
  assert.equal(pinsStanding([7]), 3);
  assert.equal(pinsStanding([...rep(9, [0, 0]), 10, 4]), 6);
});

// ---- splits
const splits = [[7, 10], [7, 9], [4, 6], [5, 7], [3, 10], [2, 7], [4, 6, 7, 10], [5, 7, 10], [4, 7, 10], [6, 7], [8, 10], [4, 10], [4, 5], [5, 6], [7, 8], [9, 10], [2, 3], [8, 9], [5, 10], [2, 6], [3, 4], [4, 9], [6, 8], [4, 5, 8], [5, 6, 8], [4, 6, 7, 9, 10], [4, 6, 7, 8, 10]];
const notSplits = [[1, 2, 4], [2, 8], [3, 9], [1, 5], [2, 4, 5, 8], [3, 5, 6, 9], [10], [7], [4, 7], [2, 4, 5], [6, 10], [3, 6, 10], [2, 5], [1, 7, 10], [1, 2, 10], [1, 2, 4, 10], [5, 8, 9], [2, 4, 7], [3, 6, 9, 10]];
for (const s of splits) test(`split ${s.join('-')}`, () => assert.equal(isSplit(s), true));
for (const s of notSplits) test(`not split ${s.join('-')}`, () => assert.equal(isSplit(s), false));
test('leave names', () => {
  assert.equal(leaveName([10, 7]), 'Bedposts!');
  assert.equal(leaveName([4, 6, 7, 10]), 'Big Four!');
});

// ---- multi-player turn order
test('turn order: frame by frame, strike passes the turn', () => {
  const g = new BowlingGame([{ id: 0, name: 'A' }, { id: 1, name: 'B' }]);
  assert.equal(g.current, 0);
  let r = g.roll(10);
  assert.equal(r.strike, true);
  assert.equal(r.turnOver, true);
  assert.equal(g.current, 1);
  r = g.roll(7, [4, 7, 10]);
  assert.equal(r.turnOver, false);
  assert.equal(g.current, 1);
  r = g.roll(3);
  assert.equal(r.spare, true);
  assert.equal(g.current, 0);
});
test('roll clamps to standing pins', () => {
  const g = new BowlingGame([{ id: 0, name: 'A' }]);
  g.roll(8);
  const r = g.roll(5);
  assert.equal(r.knocked, 2);
  assert.equal(r.spare, true);
});
test('full 3-player game ends, tenth bonus handled per player', () => {
  const g = new BowlingGame([{ id: 0 }, { id: 1 }, { id: 2 }]);
  let guard = 0;
  while (!g.over && guard++ < 200) {
    const p = g.current;
    const t = g.turn();
    if (p === 0) g.roll(10);                         // perfect
    else if (p === 1) g.roll(t.freshRack ? 9 : 1);   // all spares, 9 bonus
    else g.roll(0);                                   // all gutters
  }
  assert.equal(g.over, true);
  const b = g.board();
  assert.equal(b[0].total, 300);
  assert.equal(b[1].total, 190);
  assert.equal(b[2].total, 0);
  assert.equal(g.players[0].rolls.length, 12);
  assert.equal(g.players[1].rolls.length, 21);
  assert.equal(g.players[2].rolls.length, 20);
  const st = g.standings();
  assert.deepEqual(st.map((s) => s.place), [1, 2, 3]);
});
test('strike streak', () => {
  const g = new BowlingGame([{ id: 0 }]);
  g.roll(10); g.roll(10);
  assert.equal(g.strikeStreak(0), 2);
  g.roll(10);
  assert.equal(g.strikeStreak(0), 3);
  g.roll(9); g.roll(1);
  assert.equal(g.strikeStreak(0), 0);
});
test('serialization round trip', () => {
  const g = new BowlingGame([{ id: 0 }, { id: 1 }]);
  g.roll(10); g.roll(3); g.roll(4);
  const h = BowlingGame.fromJSON(JSON.parse(JSON.stringify(g)));
  assert.deepEqual(h.board().map((x) => x.total), g.board().map((x) => x.total));
  assert.equal(h.current, g.current);
});

console.log(process.exitCode ? `scoring: some tests FAILED (${passed} passed)` : `scoring: all ${passed} tests passed`);
