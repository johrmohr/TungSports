// Golf round rules (pure; shared by the TV and the tests).
//
//   const r = new GolfRound({ holes: [1, 2, 3], players: [{ id, name }, …] });
//   r.startHole(teePos, pinPos);
//   r.next()                       index of the player to play (or -1 when the hole is over)
//   r.recordShot(i, { result: 'rest' | 'holed' | 'water' | 'ob', pos, surface })
//   r.finishHole();                → next hole (r.over when the round is done)
//
// Everyone tees off in order (after the first hole, the best score on the
// last hole goes first); after that the player farthest from the hole plays.
// Water or out of bounds: one penalty stroke and the shot is replayed from
// where it was hit. Reaching three times par without holing out ends the hole
// ("give up") with that many strokes.

import { PARS } from './golf-course.js';

export function scoreName(strokes, par) {
  if (strokes === 1) return 'Hole in One';
  const d = strokes - par;
  const names = { '-4': 'Condor', '-3': 'Albatross', '-2': 'Eagle', '-1': 'Birdie', 0: 'Par', 1: 'Bogey', 2: 'Double Bogey', 3: 'Triple Bogey' };
  return names[d] ?? (d > 0 ? `+${d}` : `${d}`);
}

export const toParText = (d) => (d === 0 ? '±0' : d > 0 ? `+${d}` : `${d}`);

// Par of each hole, from the course.
export { PARS };

export class GolfRound {
  constructor({ holes, players }) {
    this.holes = holes.slice();
    this.holeIndex = 0;
    this.players = players.map((p, i) => ({
      id: p.id, name: p.name, index: i,
      scores: [],                     // strokes per finished hole (null = not played)
      strokes: 0, done: false, gaveUp: false, teed: false,
      pos: null, prevPos: null, surface: 'tee',
    }));
    this.teeOrder = this.players.map((_, i) => i);
    this.pin = null;
    this.over = false;
  }

  get hole() { return this.holes[this.holeIndex]; }
  get par() { return PARS[this.hole] ?? 4; }
  get holeDone() { return this.players.every((p) => p.done); }

  startHole(tee, pin) {
    this.pin = { x: pin.x, z: pin.z };
    for (const p of this.players) {
      p.strokes = 0; p.done = false; p.gaveUp = false; p.teed = false;
      p.pos = { x: tee.x, z: tee.z }; p.prevPos = { x: tee.x, z: tee.z }; p.surface = 'tee';
    }
  }

  distance(i) {
    const p = this.players[i];
    return Math.hypot(p.pos.x - this.pin.x, p.pos.z - this.pin.z);
  }

  next() {
    for (const i of this.teeOrder) if (!this.players[i].teed && !this.players[i].done) return i;
    let best = -1, bestD = -1;
    for (const i of this.teeOrder) {
      const p = this.players[i];
      if (p.done) continue;
      const d = this.distance(i);
      if (d > bestD + 1e-6) { best = i; bestD = d; }
    }
    return best;
  }

  // Returns { strokes, penalty, holed, gaveUp, name? }.
  recordShot(i, { result, pos, surface }) {
    const p = this.players[i];
    if (p.done) return null;
    p.teed = true;
    p.strokes++;
    const out = { strokes: p.strokes, penalty: 0, holed: false, gaveUp: false };
    if (result === 'water' || result === 'ob') {
      p.strokes++;
      out.penalty = 1;
      out.strokes = p.strokes;
      // Replay from where the shot was hit.
      p.pos = { ...p.prevPos };
    } else if (result === 'holed') {
      p.pos = { x: this.pin.x, z: this.pin.z };
      p.done = true;
      out.holed = true;
      out.name = scoreName(p.strokes, this.par);
    } else {
      p.prevPos = { x: pos.x, z: pos.z };
      p.pos = { x: pos.x, z: pos.z };
      p.surface = surface || 'rough';
    }
    if (out.penalty) p.prevPos = { ...p.pos };
    const limit = this.par * 3;
    if (!p.done && p.strokes >= limit) {
      p.strokes = limit;
      p.done = true;
      p.gaveUp = true;
      out.gaveUp = true;
      out.strokes = limit;
    }
    return out;
  }

  // Closes the hole: records scores and orders the next tee by this hole's scores.
  finishHole() {
    for (const p of this.players) p.scores[this.holeIndex] = p.strokes;
    const hi = this.holeIndex;
    this.teeOrder = this.teeOrder.slice().sort((a, b) => this.players[a].scores[hi] - this.players[b].scores[hi]);
    if (this.holeIndex + 1 >= this.holes.length) { this.over = true; return false; }
    this.holeIndex++;
    return true;
  }

  totals() {
    return this.players.map((p) => {
      let strokes = 0, par = 0;
      p.scores.forEach((s, k) => { if (s !== null && s !== undefined) { strokes += s; par += PARS[this.holes[k]] ?? 4; } });
      return { index: p.index, id: p.id, name: p.name, strokes, toPar: strokes - par, scores: p.scores.slice() };
    });
  }

  // Final ranking (lowest strokes first; ties share a place).
  standings() {
    const t = this.totals().sort((a, b) => a.strokes - b.strokes || a.index - b.index);
    let place = 0, last = null;
    t.forEach((r, k) => { if (r.strokes !== last) { place = k + 1; last = r.strokes; } r.place = place; });
    return t;
  }
}
