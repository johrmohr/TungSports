// Ten-pin bowling rules: scoring, scoresheet marks, turn order and splits.
// Pure functions + a small game model. No DOM / Three.js: runs in Node tests.
//
// A player's game is the flat list of pin counts per ball, e.g. a perfect game
// is twelve 10s. `pinsAfter` records which pins were left standing after each
// first ball (for split marks).

export const FRAMES = 10;
export const PINS = 10;

// Pin positions on the deck in half-spacing units: x across (− = left as the
// bowler sees it), row 0 = head pin, row 3 = back row.
//        7   8   9   10
//          4   5   6
//            2   3
//              1
export const PIN_GRID = {
  1: [0, 0], 2: [-1, 1], 3: [1, 1], 4: [-2, 2], 5: [0, 2], 6: [2, 2], 7: [-3, 3], 8: [-1, 3], 9: [1, 3], 10: [3, 3],
};

// Splits frames out of a roll list. Frames 1-9 take one ball for a strike, two
// otherwise; frame 10 takes up to three. Returns [{ rolls: [...] }] (≤ 10 frames).
export function splitFrames(rolls) {
  const frames = [];
  let i = 0;
  while (i < rolls.length && frames.length < FRAMES) {
    if (frames.length === FRAMES - 1) {
      frames.push({ rolls: rolls.slice(i, i + 3) });
      break;
    }
    if (rolls[i] === PINS) { frames.push({ rolls: [PINS] }); i += 1; }
    else { frames.push({ rolls: rolls.slice(i, i + 2) }); i += 2; }
  }
  return frames;
}

// Is a frame finished (no more balls in it)?
function frameDone(frame, index) {
  const r = frame.rolls;
  if (index < FRAMES - 1) return r[0] === PINS || r.length === 2;
  if (r.length < 2) return false;
  if (r.length === 3) return true;
  return r[0] + r[1] < PINS;     // open tenth: two balls only
}

// Full scoring. Returns
//   { frames: [{ rolls, marks: [..3], score: cumulative | null, done }] × 10,
//     total: running total of the frames that can be scored, complete: bool }
// `score` is null until the frame's bonus balls are known.
export function scoreGame(rolls, pinsAfter = []) {
  const frames = splitFrames(rolls);
  let total = 0;
  let cursor = 0;
  let scoredThrough = -1;
  const out = [];
  for (let f = 0; f < FRAMES; f++) {
    const frame = frames[f] || { rolls: [] };
    const r = frame.rolls;
    const done = frames[f] ? frameDone(frame, f) : false;
    let score = null;
    if (f < FRAMES - 1) {
      if (r[0] === PINS) {
        const b1 = rolls[cursor + 1], b2 = rolls[cursor + 2];
        if (b1 !== undefined && b2 !== undefined) score = PINS + b1 + b2;
      } else if (r.length === 2 && r[0] + r[1] === PINS) {
        const b1 = rolls[cursor + 2];
        if (b1 !== undefined) score = PINS + b1;
      } else if (r.length === 2) {
        score = r[0] + r[1];
      }
    } else if (done) {
      score = r.reduce((a, b) => a + b, 0);
    }
    if (score !== null && scoredThrough === f - 1) {
      total += score;
      scoredThrough = f;
      out.push({ rolls: r.slice(), marks: frameMarks(r, f, pinsAfter[f]), score: total, done });
    } else {
      out.push({ rolls: r.slice(), marks: frameMarks(r, f, pinsAfter[f]), score: null, done });
    }
    cursor += r.length;
  }
  return { frames: out, total, complete: scoredThrough === FRAMES - 1 };
}

const digit = (n) => (n === 0 ? '-' : String(n));

// Scoresheet marks for one frame: 'X' strike, '/' spare, '-' miss, digits.
// Frames 1-9 return two boxes (a strike goes in the right box, like a real
// scoresheet); frame 10 returns three. A split first ball is wrapped as
// { text, split: true } so the scoreboard can circle it.
export function frameMarks(r, index, firstBallLeave) {
  const boxes = index < FRAMES - 1 ? ['', ''] : ['', '', ''];
  if (!r.length) return boxes;
  const splitMark = (text, leave) => (leave && isSplit(leave) ? { text, split: true } : text);
  if (index < FRAMES - 1) {
    if (r[0] === PINS) { boxes[1] = 'X'; return boxes; }
    boxes[0] = splitMark(digit(r[0]), firstBallLeave);
    if (r.length > 1) boxes[1] = r[0] + r[1] === PINS ? '/' : digit(r[1]);
    return boxes;
  }
  // Tenth frame: pins are re-racked after a strike or spare.
  // firstBallLeave for the tenth may be an array of leaves per ball (a fresh rack can split twice).
  const leaves = Array.isArray(firstBallLeave) && Array.isArray(firstBallLeave[0]) ? firstBallLeave : [firstBallLeave];
  let rackStart = 0;            // index of the ball that started the current rack
  let leaveIdx = 0;
  for (let i = 0; i < r.length; i++) {
    const fresh = i === rackStart;
    if (fresh) {
      if (r[i] === PINS) { boxes[i] = 'X'; rackStart = i + 1; leaveIdx++; continue; }
      boxes[i] = splitMark(digit(r[i]), leaves[leaveIdx]);
      leaveIdx++;
    } else {
      if (r[rackStart] + r[i] === PINS) { boxes[i] = '/'; rackStart = i + 1; }
      else boxes[i] = digit(r[i]);
    }
  }
  return boxes;
}

// What the next ball of this player's game is.
//   { frame: 0..9, ball: 0..2, freshRack: bool, done: bool }
// freshRack = a full set of ten pins (start of a frame, or a tenth-frame bonus ball after a mark).
export function nextBall(rolls) {
  const frames = splitFrames(rolls);
  if (!frames.length) return { frame: 0, ball: 0, freshRack: true, done: false };
  const lastIndex = frames.length - 1;
  const last = frames[lastIndex];
  if (frameDone(last, lastIndex)) {
    if (lastIndex === FRAMES - 1) return { frame: FRAMES, ball: 0, freshRack: false, done: true };
    return { frame: lastIndex + 1, ball: 0, freshRack: true, done: false };
  }
  const ball = last.rolls.length;
  if (lastIndex < FRAMES - 1) return { frame: lastIndex, ball, freshRack: false, done: false };
  // Tenth frame.
  const r = last.rolls;
  let fresh;
  if (ball === 1) fresh = r[0] === PINS;
  else fresh = (r[0] === PINS && r[1] === PINS) || (r[0] !== PINS && r[0] + r[1] === PINS);
  return { frame: lastIndex, ball, freshRack: fresh, done: false };
}

// How many pins are standing before the next ball (10 on a fresh rack).
export function pinsStanding(rolls) {
  const nb = nextBall(rolls);
  if (nb.done) return 0;
  if (nb.freshRack) return PINS;
  return PINS - rolls[rolls.length - 1];
}

// ---------------------------------------------------------------- splits
//
// USBC rule 2h: a split is a leave after the first delivery at a full rack,
// with the head pin down and at least one pin down
//   1. between two or more standing pins (7-9, 3-10), or
//   2. immediately ahead of two or more standing pins (5-6).
// Rule 1 is a gap in the seven pin columns; rule 2 is a side-by-side pair
// whose front pin is down. Sleepers (2-8, 3-9) and the bucket are not splits.

const PIN_COLUMN = { 1: 0, 2: -1, 3: 1, 4: -2, 5: 0, 6: 2, 7: -3, 8: -1, 9: 1, 10: 3 };
const PAIR_FRONT = [[2, 3, 1], [4, 5, 2], [5, 6, 3], [7, 8, 4], [8, 9, 5], [9, 10, 6]];

// standing: iterable of pin numbers (1..10) left after a first ball.
export function isSplit(standingPins) {
  const s = new Set([...standingPins].map(Number).filter((n) => n >= 1 && n <= 10));
  if (s.has(1) || s.size < 2) return false;
  const cols = [...s].map((p) => PIN_COLUMN[p]).sort((a, b) => a - b);
  for (let k = 1; k < cols.length; k++) if (cols[k] - cols[k - 1] >= 2) return true;
  for (const [a, b, front] of PAIR_FRONT) if (s.has(a) && s.has(b) && !s.has(front)) return true;
  return false;
}

// Common names for famous leaves, for the on-screen callout.
const LEAVE_NAMES = new Map([
  ['7,10', 'Bedposts!'], ['4,6,7,10', 'Big Four!'], ['4,6,7,9,10', 'Greek Church!'], ['4,6,7,8,10', 'Greek Church!'],
  ['5,7,10', 'Sour Apple!'], ['2,7', 'Baby Split'], ['3,10', 'Baby Split'], ['2,7,10', 'Christmas Tree'], ['3,7,10', 'Christmas Tree'],
  ['2,4,5,8', 'Bucket'], ['3,5,6,9', 'Bucket'],
]);
export function leaveName(standingPins) {
  const key = [...standingPins].map(Number).sort((a, b) => a - b).join(',');
  return LEAVE_NAMES.get(key) || null;
}

// ---------------------------------------------------------------- multi-player game

// Players take turns frame by frame: P1 bowls all of frame 1, then P2 … then
// P1 frame 2. In the tenth each player bowls their bonus balls before passing on.
export class BowlingGame {
  constructor(players) {
    // players: [{ id, name, color }]
    this.players = players.map((p) => ({ ...p, rolls: [], leaves: [], tenthLeaves: [] }));
    this.current = 0;
  }

  get player() { return this.players[this.current]; }
  get over() { return this.players.every((p) => nextBall(p.rolls).done); }
  get frame() { return nextBall(this.player.rolls).frame; }

  // Where the current player stands: { frame, ball, freshRack, standing }.
  turn() {
    const p = this.player;
    const nb = nextBall(p.rolls);
    return { ...nb, player: this.current, standing: pinsStanding(p.rolls) };
  }

  // Records one ball. knocked = pins knocked down by this ball; leave = pin
  // numbers still standing afterwards (used for split marks).
  // Returns { strike, spare, split, gutter, frameOver, turnOver, gameOver, knocked, leaveName }.
  roll(knocked, leave = []) {
    const p = this.player;
    const before = nextBall(p.rolls);
    if (before.done) throw new Error('This player has finished');
    const standing = pinsStanding(p.rolls);
    const n = Math.max(0, Math.min(standing, Math.round(knocked)));
    p.rolls.push(n);
    const after = nextBall(p.rolls);
    const strike = before.freshRack && n === PINS;
    const spare = !before.freshRack && n === standing && n > 0;
    const split = before.freshRack && !strike && isSplit(leave);
    if (before.freshRack) {
      if (before.frame < FRAMES - 1) p.leaves[before.frame] = leave.slice();
      else p.tenthLeaves.push(leave.slice());
    }
    const frameOver = after.frame !== before.frame || after.done;
    if (frameOver) this.current = this._nextPlayer();
    return {
      knocked: n, strike, spare, split, gutter: n === 0, firstBall: before.freshRack,
      frameOver, turnOver: frameOver, gameOver: this.over,
      leaveName: split || (before.freshRack && !strike) ? leaveName(leave) : null,
      frame: before.frame, ball: before.ball,
    };
  }

  _nextPlayer() {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.current + k) % n;
      if (!nextBall(this.players[i].rolls).done) return i;
    }
    return this.current;
  }

  // Scoreboard rows: [{ name, color, frames, total, complete }]
  board() {
    return this.players.map((p) => {
      const leaves = p.leaves.slice();
      leaves[FRAMES - 1] = p.tenthLeaves.length ? p.tenthLeaves : undefined;
      const s = scoreGame(p.rolls, leaves);
      return { id: p.id, name: p.name, color: p.color, character: p.character, ...s };
    });
  }

  // Current consecutive strikes for a player (for Double / Turkey callouts).
  strikeStreak(playerIndex = this.current) {
    const tmp = [];
    let streak = 0;
    for (const n of this.players[playerIndex].rolls) {
      const nb = nextBall(tmp);
      tmp.push(n);
      streak = nb.freshRack && n === PINS ? streak + 1 : 0;
    }
    return streak;
  }

  // Final standings (highest total first; ties share a place).
  standings() {
    const rows = this.board().map((b, i) => ({ index: i, name: b.name, color: b.color, character: b.character, total: b.total }));
    rows.sort((a, b) => b.total - a.total);
    let place = 0, last = null;
    rows.forEach((r, i) => { if (r.total !== last) { place = i + 1; last = r.total; } r.place = place; });
    return rows;
  }

  toJSON() { return { players: this.players, current: this.current }; }
  static fromJSON(j) {
    const g = new BowlingGame([]);
    g.players = j.players.map((p) => ({ ...p, rolls: p.rolls.slice(), leaves: (p.leaves || []).slice(), tenthLeaves: (p.tenthLeaves || []).slice() }));
    g.current = j.current;
    return g;
  }
}
