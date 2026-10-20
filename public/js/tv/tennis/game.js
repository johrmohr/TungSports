// Tennis: always doubles, players run by themselves, you only swing. Timing aims the ball (early pulls it across your body, late
// pushes it the other way), the swing's path picks the shot (brush up = lob,
// chop down = slice), and a serve struck at the top of the toss is a fastball.
//
// A point:  intro → serve (toss, hit) → rally → over → [replay] → score call
// Phone swings carry their own timing (the peak of the swing, minus the
// network lag), so a late swing is applied in the past ("rollback").

import * as THREE from 'three';
import { Court } from './court.js';
import { TennisHud, TEAM_COLORS, teamTitle } from './hud.js';
import { Brainrot } from '../brainrot.js';
import { banner, band, clearBanners } from '../ui.js';
import { TennisMatch } from '../../shared/tennis-rules.js';
import { COURT, makeBall, cloneBall, stepBall, predict, solveShot, landsIn, SIM_DT } from '../../shared/tennis-physics.js';
import { colorHex, getCharacter, CHARACTER_IDS, PLAYER_COLORS } from '../../shared/protocol.js';

const G = 9.81;
const LEVELS = {
  rookie: { react: 0.3, speed: 4.7, timing: 0.085, aimErr: 1.4, margin: 0.95, lob: 0.12, slice: 0.1, leaveOut: 0.5, smart: 0.3, serveErr: 0.12, depthErr: 1.1, mishit: 0.1 },
  pro: { react: 0.2, speed: 5.3, timing: 0.055, aimErr: 1.0, margin: 0.72, lob: 0.2, slice: 0.15, leaveOut: 0.8, smart: 0.62, serveErr: 0.075, depthErr: 0.85, mishit: 0.06 },
  champ: { react: 0.12, speed: 5.9, timing: 0.036, aimErr: 0.72, margin: 0.55, lob: 0.26, slice: 0.18, leaveOut: 0.94, smart: 0.88, serveErr: 0.045, depthErr: 0.6, mishit: 0.035 },
};
const HUMAN_SPEED = 6.2;
const WINDOW_EARLY = -0.32;          // s before the ball reaches you
const WINDOW_LATE = 0.17;            // s after
const AIM_SPAN = 0.11;               // s of earliness for a full-corner pull
const SWING_DUR = 0.46;
const CONTACT_AT = 0.42;
const SERVE_DUR = 1.0;
const SERVE_CONTACT = 0.6;
const TOSS_V = 5.5;                  // m/s: the toss climbs ~1.5 m
const FAST_WINDOW = 0.075;           // s around the top of the toss for a fastball
const GRACE = 0.2;                   // s a point waits for a late (lagged) swing
const REPLAY_SPAN = 2.8;
const REPLAY_SPEED = 0.42;

const sideZ = (team) => (team === 0 ? 1 : -1);          // which half a team plays in
const KB_KEYS = [
  { swing: 'Space', fh: 'KeyZ', bh: 'KeyX', label: 'Space', glyph: '␣' },
  { swing: 'Enter', fh: 'Comma', bh: 'Period', label: 'Enter', glyph: '↵' },
  { swing: 'KeyQ', fh: null, bh: null, label: 'Q', glyph: 'Q' },
  { swing: 'KeyO', fh: null, bh: null, label: 'O', glyph: 'O' },
];
const rightSign = (team) => (team === 0 ? 1 : -1);      // the team's right, in world x
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = () => Math.random();
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += Math.random(); return s - 3; };

export default class TennisGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.renderer = ctx.renderer;
    this.audio = ctx.audio;
    this.link = ctx.link;
    this.opts = ctx.opts;
    this.level = LEVELS[ctx.opts.level] || LEVELS.pro;
    this.time = 0;
    this.wallAt = performance.now();
    this.paused = false;
    this.over = false;
    this.phase = 'load';
    this.phaseT = 0;
    this.keys = { up: false, down: false };
    this.stats = { rallies: [], aces: [0, 0], fast: [0, 0], winners: [0, 0], longest: 0 };
    this.frames = [];
    this.tagV = new THREE.Vector3();
  }

  // ------------------------------------------------------------ setup

  async load(progress) {
    progress?.('Building the stadium…');
    await new Promise((r) => setTimeout(r, 30));
    this.court = new Court();
    this.scene = this.court.scene;
    this.camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 400);
    this.camera2 = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
    this.camPos = new THREE.Vector3(0, 7.4, 20.5);
    this.camLook = new THREE.Vector3(0, 0.6, -2.5);
    this.hud = new TennisHud(this.ctx.hudRoot);
    progress?.('Warming up the players…');
    this._makePlayers();
    this.match = new TennisMatch({ format: this.opts.format || 3, firstTeam: rnd() < 0.5 ? 0 : 1 });
    this.split = this.teams[0].humans > 0 && this.teams[1].humans > 0;
    this.hud.split(this.split);
    this._hudScore();
    // Render once so shaders compile during the loading screen.
    this.renderer.compile(this.scene, this.camera);
  }

  _makePlayers() {
    const seats = this.ctx.seats;
    const used = new Set(seats.map((s) => s.character));
    const spare = CHARACTER_IDS.filter((c) => !used.has(c));
    const cpuColors = PLAYER_COLORS.map((c) => c.id).filter((c) => !seats.some((s) => s.color === c));
    let k = 0;
    this.players = [];
    this.teams = [0, 1].map((team) => {
      const members = (this.opts.teams?.[team] || ['cpu', 'cpu']).map((key, member) => {
        const seat = seats.find((s) => s.key === key) || null;
        const character = seat ? seat.character : spare[k % Math.max(1, spare.length)] || CHARACTER_IDS[(k + 3) % CHARACTER_IDS.length];
        const color = seat ? colorHex(seat.color) : colorHex(cpuColors[(k + team) % cpuColors.length] || 'black');
        if (!seat) k++;
        const char = new Brainrot({ character, color, hand: seat?.hand || 'right', seed: 17 + team * 5 + member });
        char.setEquipment('racket');
        char.setPose('ready');
        this.scene.add(char.group);
        const p = {
          id: `${team}${member}`, team, member, seat, char, character, color,
          name: seat ? seat.name : getCharacter(character).shortName,
          hand: seat?.hand || 'right',
          pos: { x: 0, z: sideZ(team) * 11 }, vel: { x: 0, z: 0 }, target: { x: 0, z: sideZ(team) * 11 },
          role: member === 0 ? 'back' : 'front', yaw: team === 0 ? 0 : Math.PI,
          swingLockUntil: 0, sweat: 0,
        };
        this.players.push(p);
        return p;
      });
      return { team, players: members, humans: members.filter((m) => m.seat).length };
    });
    for (const t of this.teams) {
      const info = teamTitle(t.players.map((p) => ({ name: p.name, character: p.character, human: !!p.seat, label: p.seat ? (p.seat.local ? `Keys · ${this._kbLabel(p.seat.key)}` : `P${p.seat.slot + 1}`) : 'CPU' })));
      t.title = info.title;
      t.sub = info.sub;
    }
  }

  // A seat's players act as CPUs while its phone is gone.
  isHuman(p) {
    if (!p.seat) return false;
    if (p.seat.local) return true;
    const lp = this.link.players[p.seat.slot];
    return !!lp?.connected;
  }

  playersChanged(seats) {
    for (const p of this.players) {
      if (!p.seat) continue;
      const s = seats.find((x) => x.key === p.seat.key);
      if (s) { p.seat = s; if (p.name !== s.name) p.name = s.name; }
    }
  }

  start() {
    this.audio.ambience('tennis');
    this.audio.crowd('clap', 1.2);
    this._go('intro');
  }

  // ------------------------------------------------------------ flow

  _go(phase) {
    this.phase = phase;
    this.phaseT = 0;
    this.ctx.app.syncPhones();
  }

  _startPoint() {
    const m = this.match;
    this.court.showMark(0, 0, false);
    this.hud.clearOut();
    this.hud.replay(false);
    this.hud.hidePrompt();
    clearBanners(this.hud.bannerRoot);
    this.frames = [];
    this.pointStart = this.time;
    this.pendingPoint = null;
    this.pendingHits = [];
    this.plan = null;
    this.shots = 0;
    this.lastHit = null;
    const srv = this.teams[m.server.team].players[m.server.member];
    const rcv = this.teams[m.receiver.team].players[m.receiver.member];
    const deuce = m.side === 'deuce';
    for (const p of this.players) {
      p.role = (p === srv || p === rcv) ? 'back' : 'front';
      p.vel.x = p.vel.z = 0;
      p.char.setPose('ready');
      p.char.anim.swing = null;
      p.swingLockUntil = 0;
    }
    const sx = (deuce ? 1 : -1) * 0.95 * rightSign(srv.team);
    this._place(srv, sx, sideZ(srv.team) * 12.3);
    this._place(this._partner(srv), -Math.sign(sx) * 2.7, sideZ(srv.team) * 3.5);
    const rx = (deuce ? 1 : -1) * 2.9 * rightSign(rcv.team);
    this._place(rcv, rx, sideZ(rcv.team) * 11.7);
    this._place(this._partner(rcv), -Math.sign(rx) * 2.2, sideZ(rcv.team) * 6.0);
    this.server = srv;
    this.receiver = rcv;
    this.serve = { tossed: false, t0: 0, hit: false, cpuTossAt: this.time + 1.2 + rnd() * 0.5, cpuHitAt: 0, attempts: 0 };
    this.ball = { st: null, mode: 'held', isServe: true, fast: false, lastHitTeam: srv.team, hitter: srv, bounces: [], history: [], netCord: false };
    this.simT = this.time;
    // Calls before the serve: Game point, Break point, Match point, Deuce.
    const sit = m.situation();
    if (sit) {
      const label = { 'match point': 'Match point', 'game point': 'Game point', 'break point': 'Break point', deuce: 'Deuce' }[sit.kind];
      banner(this.hud.bannerRoot, label, null, { kind: sit.kind === 'match point' ? 'gold' : sit.kind === 'deuce' ? 'dark' : '', ms: 1400, top: '14vh' });
      this.audio.say(label);
    }
    this._hudScore();
    this._go('serve');
    if (this.isHuman(srv) && srv.seat && !srv.seat.local) {
      this.link.sendEvent(srv.seat.slot, { type: 'sound', name: 'turn' });
      this.link.sendEvent(srv.seat.slot, { type: 'vibrate', pattern: [30, 50, 30] });
    }
  }

  _partner(p) { return this.teams[p.team].players[1 - p.member]; }

  _place(p, x, z) {
    p.pos.x = x; p.pos.z = z;
    p.target.x = x; p.target.z = z;
    p.char.group.position.set(x, 0, z);
  }

  // ------------------------------------------------------------ the serve

  _toss() {
    const s = this.serve;
    if (s.tossed) return;
    const srv = this.server;
    s.tossed = true;
    s.t0 = this.time;
    s.attempts++;
    if (s.prompted) this.hud.hidePrompt();
    const hand = srv.char.offHandWorld(new THREE.Vector3());
    // The ball goes up just in front of the racket shoulder.
    const fwd = -sideZ(srv.team);
    s.p0 = { x: srv.pos.x + rightSign(srv.team) * 0.18 * (srv.hand === 'left' ? -1 : 1), y: Math.max(1.3, hand.y), z: srv.pos.z + fwd * 0.35 };
    s.apex = s.t0 + TOSS_V / G;
    this.ball.mode = 'toss';
    srv.char.swing('serve', SERVE_DUR, SERVE_CONTACT);
    srv.char.anim.swing.p = 0;
    srv.serveAnimT0 = this.time;
    // CPU: swing near the top of the toss.
    if (!this.isHuman(srv)) {
      const err = gauss() * this.level.serveErr * 0.6;
      s.cpuHitAt = s.apex + err;
    }
    this.audio.whoosh(0.25);
    this.ctx.app.syncPhones();
  }

  _tossPos(t) {
    const s = this.serve;
    const u = t - s.t0;
    return { x: s.p0.x, y: s.p0.y + TOSS_V * u - 0.5 * G * u * u, z: s.p0.z };
  }

  // The serve is struck at game time tHit.
  _serveHit(tHit, swing = null) {
    const s = this.serve;
    if (!s.tossed || s.hit) return false;
    const u = tHit - s.t0;
    if (u < 0.22 || u > 1.12) return false;
    s.hit = true;
    const srv = this.server;
    const q = tHit - s.apex;
    const fast = Math.abs(q) < FAST_WINDOW;
    const m = this.match;
    const R = 1 - srv.team;
    const deuce = m.side === 'deuce';
    // Receiver's deuce box is on their right.
    const boxSign = (deuce ? 1 : -1) * rightSign(R);
    const T = boxSign * 0.55, wide = boxSign * (COURT.singlesHalfW - 0.45);
    const lat = clamp(q / 0.22, -1, 1);
    let tx = lerp(T, wide, (lat + 1) / 2) + gauss() * 0.22;
    tx = boxSign > 0 ? clamp(tx, 0.3, COURT.singlesHalfW - 0.3) : clamp(tx, -COURT.singlesHalfW + 0.3, -0.3);
    const tz = sideZ(R) * clamp(COURT.service - 0.6 - rnd() * 0.9, 3.5, COURT.service - 0.35);
    const from = this._tossPos(tHit);
    const speedK = swing ? clamp(1.06 - swing.speed * 0.12, 0.92, 1.06) : 1;
    const time = fast ? 0.6 : clamp((0.82 + Math.abs(q) * 0.55) * speedK, 0.72, 1.15);
    const sol = solveShot([from.x, from.y, from.z], [tx, tz], { time, top: fast ? 10 : 60, clear: fast ? 0.05 : 0.12 })
      || solveShot([from.x, from.y, from.z], [tx * 0.8, tz * 0.85], { time: time * 1.2, top: 40, clear: 0.05 });
    if (!sol) return false;
    const st = makeBall([from.x, from.y, from.z], sol.v, sol.w);
    // Fast-forward the ball from tHit to now (a late swing).
    this._launch(st, tHit, srv, { isServe: true, fast });
    this.ball.hitKind = 'serve';
    this.audio.racket(fast ? 1.2 : 0.8, 'serve');
    if (fast) { this.audio.fastball(); this.court.crowdReact('ooh', 1.2); this.stats.fast[srv.team]++; }
    this._feedback(srv, fast ? 'FASTBALL!' : Math.abs(q) < 0.15 ? 'Good serve' : q < 0 ? 'Hit it higher for a fastball' : 'A touch late — hit the top of the toss', fast ? 'good' : '');
    if (srv.seat && !srv.seat.local) this.link.sendEvent(srv.seat.slot, { type: 'sound', name: 'hit', k: fast ? 1 : 0.7 });
    this._go('rally');
    return true;
  }

  // ------------------------------------------------------------ ball

  // A new flight that started at game time t0 with state st (struck by p).
  _launch(st, t0, p, { isServe = false, fast = false } = {}) {
    const b = this.ball;
    b.st = st;
    b.mode = 'flight';
    b.isServe = isServe;
    b.fast = fast;
    b.lastHitTeam = p.team;
    b.hitter = p;
    b.bounces = [];
    b.netCord = false;
    b.history = [{ t: t0, st: cloneBall(st) }];
    this.simT = t0;
    if (this.pendingPoint && this.pendingPoint.t >= t0) this.pendingPoint = null;
    this.court.clearTrail();
    this.shots++;
    this.lastHit = { team: p.team, t: t0, fast };
    // Catch up to now.
    this._advanceBall(this.time);
    this._planReturn();
  }

  _stateAt(t) {
    const h = this.ball.history;
    let base = h[0];
    for (const e of h) { if (e.t <= t) base = e; else break; }
    const st = cloneBall(base.st);
    let left = t - base.t;
    while (left > 1e-6) { const dt = Math.min(SIM_DT, left); stepBall(st, dt); left -= dt; }
    return st;
  }

  _advanceBall(t1) {
    const b = this.ball;
    if (b.mode !== 'flight') return;
    let guard = 0;
    while (this.simT + SIM_DT <= t1 + 1e-9 && guard++ < 2000) {
      const ev = stepBall(b.st, SIM_DT);
      this.simT += SIM_DT;
      if (guard % 4 === 0) {
        b.history.push({ t: this.simT, st: cloneBall(b.st) });
        if (b.history.length > 400) b.history.splice(1, 40);
      }
      if (ev) this._ballEvent(ev, this.simT);
      if (b.mode !== 'flight') break;
      // Into the stands / walls.
      if (Math.abs(b.st.x) > 10.4 || Math.abs(b.st.z) > 20.2) { this._wall(this.simT); break; }
    }
  }

  _ballEvent(ev, t) {
    const b = this.ball;
    const X = b.lastHitTeam, Y = 1 - X;
    if (ev.type === 'net') {
      this.audio.net();
      if (ev.cord) { b.netCord = true; this.court.crowdReact('ooh', 1); this.audio.crowd('ooh', 0.6); this._planReturn(); }
      return;
    }
    if (ev.type !== 'bounce') return;
    this.audio.bounce(ev.vIn);
    const sideTeam = ev.z > 0 ? 0 : 1;
    const ownSide = b.bounces.filter((x) => x.team === sideTeam);
    b.bounces.push({ team: sideTeam, x: ev.x, z: ev.z, t });
    if (this.pendingPoint) return;
    if (sideTeam === X) {
      // It never got over (or came back): the point goes to Y.
      this._pointTo(Y, t, { reason: 'net', x: ev.x, z: ev.z });
      return;
    }
    if (ownSide.length === 0) {
      const box = b.isServe ? { side: this.match.side } : null;
      if (!landsIn(ev.x, ev.z, Y, box)) {
        this._pointTo(Y, t, { reason: 'out', x: ev.x, z: ev.z });
        return;
      }
      if (b.isServe) b.serveIn = true;
    } else {
      // Second bounce: Y could not get it back.
      this._pointTo(X, t, { reason: b.isServe ? 'ace' : 'winner', x: ev.x, z: ev.z });
    }
  }

  _wall(t) {
    const b = this.ball;
    b.mode = 'dead';
    if (this.pendingPoint) return;
    const X = b.lastHitTeam, Y = 1 - X;
    const bouncedIn = b.bounces.some((x) => x.team === Y);
    this._pointTo(bouncedIn ? X : Y, t, { reason: bouncedIn ? 'winner' : 'out', x: b.st.x, z: b.st.z });
  }

  _pointTo(team, t, info) {
    this.pendingPoint = { team, t, ...info };
  }

  // ------------------------------------------------------------ who takes the ball

  _planReturn() {
    const b = this.ball;
    if (b.mode !== 'flight') { this.plan = null; return; }
    const team = 1 - b.lastHitTeam;
    const pred = predict(b.st, { maxT: 3.4, maxBounces: 2, every: 2 });
    const now = this.time;
    const t0 = this.simT;
    const own = pred.bounces.filter((bo) => (bo.z > 0 ? 0 : 1) === team);
    const firstOwn = own[0] || null;
    const secondOwn = own[1] || null;
    const bounceIn = firstOwn ? landsIn(firstOwn.x, firstOwn.z, team, b.isServe ? { side: this.match.side } : null) : null;
    const cands = [];
    for (const smp of pred.samples) {
      const tAbs = t0 + smp.t;
      if (tAbs < now + 0.05) continue;
      if ((smp.z > 0 ? 0 : 1) !== team || Math.abs(smp.z) < 0.4) continue;
      const after = firstOwn && smp.t >= firstOwn.t;
      if (secondOwn && smp.t >= secondOwn.t) break;
      if (!after) {
        if (b.isServe) continue;                                  // a serve must bounce
        if (smp.y > 0.45 && smp.y < 3.0 && Math.abs(smp.z) < 8.5) cands.push({ t: tAbs, x: smp.x, y: smp.y, z: smp.z, kind: smp.y > 2.0 ? 'smash' : 'volley' });
      } else if (smp.y > 0.3 && smp.y < 1.7 && Math.abs(smp.z) < 16) {
        cands.push({ t: tAbs, x: smp.x, y: smp.y, z: smp.z, kind: 'ground' });
      }
    }
    if (!cands.length) { this.plan = null; return; }
    let best = null;
    for (const p of this.teams[team].players) {
      const vmax = this.isHuman(p) ? HUMAN_SPEED : this.level.speed;
      const react = this.isHuman(p) ? 0.08 : this.level.react;
      for (const c of cands) {
        // The net player only takes balls that come near: a step either way.
        if (c.kind !== 'ground') {
          if (p.role !== 'front') continue;
          if (Math.abs(c.x - p.pos.x) > 1.9 || Math.abs(Math.abs(c.z) - Math.abs(p.pos.z)) > 2.4) continue;
        } else if (p.role === 'front' && (Math.abs(c.z) > 7 || Math.abs(c.x - p.pos.x) > 3)) continue;
        const stand = this._standFor(p, c);
        const dist = Math.hypot(stand.x - p.pos.x, stand.z - p.pos.z);
        const avail = c.t - now - react;
        const short = dist - Math.max(0, avail) * vmax;
        // Prefer: reachable, then the nicer height, then sooner (volleys) / the front player.
        const heightPen = c.kind === 'ground' ? Math.abs(c.y - 0.95) * 1.5 : c.kind === 'smash' ? 0.2 : Math.abs(c.y - 1.15) * 0.8;
        const score = (short > 0 ? 10 + short * 3 : 0) + heightPen + (c.kind !== 'ground' && p.role === 'front' ? -0.6 : 0) + (c.t - now) * 0.12;
        if (!best || score < best.score) best = { score, p, c, stand, short };
      }
    }
    if (!best) { this.plan = null; return; }
    const { p, c, stand, short } = best;
    const side = stand.side;
    const plan = {
      team, hitter: p, tc: c.t, contact: { x: c.x, y: c.y, z: c.z }, kind: c.kind, side, stand,
      dive: short > 0.3 && short < 2.2, hopeless: short >= 2.2, bounceIn, fastIn: b.fast, done: false, cpu: null,
    };
    this.plan = plan;
    // Point the other players at their spots; the CPU decides its shot now.
    if (!this.isHuman(p) && !plan.hopeless) this._cpuDecide(plan);
  }

  // Where to stand so the ball meets the racket: beside and a little in front.
  _standFor(p, c) {
    const R = rightSign(p.team) * (p.hand === 'left' ? -1 : 1);   // racket side in world x
    const back = sideZ(p.team);
    const fh = { x: c.x - R * 0.72, z: c.z + back * 0.28, side: 'fh' };
    const bh = { x: c.x + R * 0.72, z: c.z + back * 0.28, side: 'bh' };
    if (c.kind === 'smash') return { x: c.x - R * 0.3, z: c.z + back * 0.35, side: 'oh' };
    const dF = Math.hypot(fh.x - p.pos.x, fh.z - p.pos.z) - 0.35;    // a slight forehand preference
    const dB = Math.hypot(bh.x - p.pos.x, bh.z - p.pos.z);
    return dF <= dB ? fh : bh;
  }

  // ------------------------------------------------------------ CPU shots

  _cpuDecide(plan) {
    const L = this.level;
    const p = plan.hitter;
    // Leave balls that are going out (if it can tell).
    if (plan.kind !== 'ground' && plan.bounceIn === false && rnd() < L.leaveOut) { plan.cpu = { leave: true }; return; }
    const opp = this.teams[1 - p.team].players;
    const oppSide = -sideZ(p.team);
    const oppFront = opp.find((o) => Math.abs(o.pos.z) < 5.5);
    const oppBack = opp.reduce((a, o) => (Math.abs(o.pos.z) > Math.abs(a.pos.z) ? o : a));
    let type = 'drive';
    if (plan.kind === 'smash') type = 'smash';
    else if (plan.kind === 'volley') type = rnd() < 0.18 * L.smart && Math.abs(oppBack.pos.z) > 9 ? 'drop' : 'volley';
    else if (oppFront && rnd() < L.lob) type = 'lob';
    else if (rnd() < L.slice) type = 'slice';
    if (plan.fastIn) type = rnd() < 0.5 ? 'drive' : 'lob';
    // Aim away from the deep opponent (smart CPUs), else somewhere sensible.
    const margin = L.margin;
    const wide = COURT.halfW - margin;
    let tx;
    if (rnd() < L.smart) tx = -Math.sign(oppBack.pos.x || (rnd() - 0.5)) * (wide * (0.55 + rnd() * 0.45));
    else tx = (rnd() * 2 - 1) * wide * 0.8;
    if (type === 'lob' && oppFront) tx = clamp(oppFront.pos.x + (rnd() - 0.5) * 2, -wide, wide);
    // Keep it away from the net player (where the ball crosses their line).
    if (oppFront && type !== 'lob' && rnd() < L.smart) {
      const k = Math.abs(plan.contact.z - oppFront.pos.z) / Math.max(1, Math.abs(plan.contact.z) + 9.5);
      const xAt = plan.contact.x + (tx - plan.contact.x) * clamp(k, 0, 1);
      if (Math.abs(xAt - oppFront.pos.x) < 2.0) tx = clamp(-Math.sign(oppFront.pos.x || 0.1) * wide * (0.6 + rnd() * 0.4), -wide, wide);
    }
    // Timing that would aim there; plus the CPU's own timing error.
    const baseX = clamp(plan.contact.x * 0.3, -2.2, 2.2);
    const lateral = (tx - baseX) / (3.4 * rightSign(p.team));
    const pullDir = this._pullDir(p, plan.side);
    const aim = clamp(lateral / pullDir, -1, 1);
    let delta = -aim * AIM_SPAN + gauss() * L.timing;
    if (plan.dive) delta += gauss() * 0.05;
    const miss = delta < WINDOW_EARLY || delta > WINDOW_LATE;
    plan.cpu = { type, delta, miss, depth: oppSide };
  }

  _pullDir(p, side) {
    const right = p.hand !== 'left';
    if (side === 'fh' || side === 'oh') return right ? -1 : 1;
    return right ? 1 : -1;
  }

  // ------------------------------------------------------------ hitting

  // Computes and launches the return of `plan` by its hitter, struck at tHit.
  //   delta: swing time − ideal contact time; swing: { speed, plane, roll, side } (humans) or null
  _hit(plan, tHit, delta, swing = null, cpuType = null) {
    const p = plan.hitter;
    const b = this.ball;
    if (b.mode !== 'flight' || b.lastHitTeam === p.team) return;
    const st = this._stateAt(Math.min(tHit, this.simT));
    const from = [st.x, Math.max(0.25, st.y), st.z];
    const right = rightSign(p.team);
    const L = this.level;
    const human = !!swing;
    // Shot type.
    let type = cpuType;
    if (!type) {
      if (plan.kind === 'smash' && (swing.side === 'oh' || swing.plane < 0.3)) type = 'smash';
      else if (plan.kind !== 'ground') type = swing.plane < -0.55 ? 'drop' : 'volley';
      else type = swing.plane > 0.42 ? 'lob' : swing.plane < -0.42 ? 'slice' : 'drive';
    }
    if (plan.dive) type = 'weak';
    // Direction from timing.
    const pullDir = this._pullDir(p, plan.side);
    const aim = clamp(-delta / AIM_SPAN, -1.6, 1.6);
    const baseX = clamp(from[0] * 0.3, -2.2, 2.2);
    let tx = baseX + right * pullDir * aim * 3.4;
    const opp = -sideZ(p.team);
    const depthR = { drive: [8.6, 10.7], lob: [9.6, 11.1], slice: [7.4, 9.8], volley: [5.4, 9.2], drop: [2.3, 4.4], smash: [5.8, 9.6], weak: [6, 10] }[type];
    let tz = opp * lerp(depthR[0], depthR[1], rnd());
    // Errors: off the sweet spot of the timing window, a fastball coming at you, a mismatched stroke, a dive.
    const offSweet = Math.max(0, Math.abs(aim) - 0.95);
    let sigma = (human ? 0.32 : L.aimErr * 0.62 * (1 + this.shots / 22)) * (1 + offSweet * 2.6);
    if (plan.fastIn) sigma *= 1.8;
    if (human && swing.side !== 'oh' && plan.side !== swing.side && plan.kind === 'ground') sigma *= 1.45;
    if (plan.dive) sigma *= 2.2;
    tx += gauss() * sigma;
    tz += gauss() * sigma * (human ? 1.1 : L.depthErr);
    // CPUs mishit now and then (more in long rallies).
    let mishit = false;
    if (!human && rnd() < L.mishit * (1 + this.shots / 14)) {
      mishit = true;
      if (rnd() < 0.4) tz = opp * 0.3;                     // into the net
      else { tx += (rnd() < 0.5 ? -1 : 1) * (1.2 + rnd() * 1.8); tz += opp * (rnd() * 2.2); }
    }
    // Pace: swing speed (humans) — a little only, as in the original.
    const k = human ? clamp(1.08 - swing.speed * 0.16, 0.88, 1.1) : clamp(1 + gauss() * 0.04, 0.92, 1.08);
    const P = {
      drive: { time: 1.02 * k, top: 150 + (swing?.roll || 0) * 80, clear: 0.3 },
      lob: { time: 2.2, top: 70, clear: 1.6 },
      slice: { time: 1.1 * k, top: -150, clear: 0.14 },
      volley: { time: 0.74 * k, top: 10, clear: 0.1 },
      drop: { time: 0.95, top: -90, clear: 0.08 },
      smash: { time: 0.48 * k, top: 30, clear: 0.05 },
      weak: { time: 1.55, top: 40, clear: 0.6 },
    }[type];
    if (plan.fastIn && type === 'drive') P.time *= 1.12;
    let sol = mishit && Math.abs(tz) < 1 ? null : solveShot(from, [tx, tz], P);
    if (!sol) {
      // Nothing clears the net from here: it goes into the net.
      const v = [(tx - from[0]) * 0.8, 0.5, (tz - from[2]) * 0.8];
      sol = { v, w: [0, 0, 0] };
    }
    const nst = makeBall(from, sol.v, sol.w);
    // The racket turns the ball: launch it from the moment of contact.
    this._launch(nst, Math.min(tHit, this.simT), p, { fast: type === 'smash' });
    this.onHitDebug?.({ team: p.team, side: plan.side, delta, type, tx, tz, human, kind: plan.kind });
    this.ball.hitKind = type;
    if (this.shots > this.stats.longest) this.stats.longest = this.shots;
    const pow = type === 'smash' ? 1.25 : type === 'lob' || type === 'drop' ? 0.45 : 0.75 + (swing?.speed || 0.4) * 0.25;
    this.audio.racket(pow, type === 'volley' ? 'volley' : type);
    if (type === 'smash') { this.court.crowdReact('ooh', 1); this.audio.crowd('ooh', 0.8); }
    if (human) {
      const t = Math.abs(delta) < 0.035 ? 'Perfect timing' : delta < 0 ? `Early → ${aim > 0.6 ? 'pulled across' : 'a little across'}` : `Late → ${aim < -0.6 ? 'pushed down the line' : 'a little down the line'}`;
      const typeLabel = { lob: 'Lob', slice: 'Slice', smash: 'Smash!', volley: 'Volley', drop: 'Drop shot', weak: 'Dive!', drive: plan.side === 'bh' ? 'Backhand' : 'Forehand' }[type];
      this._feedback(p, `${typeLabel} · ${t}`, Math.abs(aim) > 1.15 ? 'bad' : Math.abs(delta) < 0.05 ? 'good' : '');
      if (p.seat && !p.seat.local) this.link.sendEvent(p.seat.slot, { type: 'sound', name: 'hit', k: pow });
    }
  }

  _feedback(p, text, tone = '') {
    if (!p.seat || p.seat.local) return;
    this.link.sendEvent(p.seat.slot, { type: 'feedback', text, tone });
  }

  // Plays the swing animation so its contact lands at game time tContact.
  _animSwing(p, kind, tContact) {
    const start = tContact - SWING_DUR * CONTACT_AT;
    p.char.swing(kind, SWING_DUR, CONTACT_AT);
    p.char.anim.swing.p = clamp((this.time - start) / SWING_DUR, 0, 0.9);
    p.swingLockUntil = this.time + SWING_DUR * 0.8;
    this.audio.whoosh(0.4);
  }

  // A phone (or keyboard) swing from `seatKey`. msg.at: wall time it arrived.
  humanSwing(seatKey, msg) {
    const lag = (msg.lag ?? 40) + (this.link.rtt || 40) / 2 + (msg.age || 0);
    const tS = this._gameTime(msg.at ?? performance.now()) - clamp(lag, 0, 400) / 1000;
    const mine = this.players.filter((p) => p.seat?.key === seatKey);
    if (!mine.length) return;
    const swing = { side: msg.side || 'fh', speed: msg.speed ?? 0.5, plane: msg.plane ?? 0, roll: msg.roll ?? 0 };
    // Replays, scores… any swing skips.
    if (this.phase === 'replay') { this.replaySkip = true; return; }
    if (this.phase === 'serve' && mine.includes(this.server)) {
      if (!this.serve.tossed) { this._toss(); return; }
      if (!this._serveHit(tS, swing)) { /* too early after the toss */ }
      return;
    }
    if (this.phase !== 'rally') { this._whiff(mine[0], swing); return; }
    const plan = this.plan;
    if (!plan || plan.done || !mine.includes(plan.hitter) || plan.hopeless) { this._whiff(this._nearest(mine), swing); return; }
    const delta = tS - plan.tc;
    if (delta < WINDOW_EARLY) { this._whiff(plan.hitter, swing, 'Too early!'); return; }
    if (delta > WINDOW_LATE) { this._whiff(plan.hitter, swing, 'Too late!'); return; }
    plan.done = true;
    const kind = plan.kind === 'smash' ? 'smash' : plan.kind === 'volley' ? 'volley' : plan.side;
    if (delta < 0) {
      // Early: the racket meets the ball when it arrives; the timing aims it.
      this.pendingHits.push({ at: plan.tc, plan, delta, swing });
      this._animSwing(plan.hitter, kind, plan.tc);
    } else {
      this._animSwing(plan.hitter, kind, Math.max(this.time, tS));
      this._hit(plan, tS, delta, swing);
    }
  }

  _whiff(p, swing, text = null) {
    if (!p || this.time < p.swingLockUntil) return;
    const kind = swing.side === 'oh' ? 'oh' : swing.side;
    p.char.swing(kind, SWING_DUR, CONTACT_AT);
    p.swingLockUntil = this.time + SWING_DUR * 0.8;
    this.audio.whoosh(0.3 + swing.speed * 0.3);
    if (text) this._feedback(p, text, 'bad');
  }

  _nearest(list) {
    const bp = this.ball?.st;
    if (!bp) return list[0];
    return list.reduce((a, p) => (Math.hypot(p.pos.x - bp.x, p.pos.z - bp.z) < Math.hypot(a.pos.x - bp.x, a.pos.z - bp.z) ? p : a));
  }

  _gameTime(wallMs) { return this.time - (this.wallAt - wallMs) / 1000; }

  // ------------------------------------------------------------ per-frame

  frame(dt) {
    const now = performance.now();
    this.wallAt = now;
    if (dt > 0) {
      // Tests can fast-forward (timeScale); big steps are split up.
      let left = dt * (this.timeScale || 1);
      while (left > 1e-6) { const d = Math.min(left, 0.034); this._update(d); left -= d; }
    }
    this._render();
  }

  _update(dt) {
    this.phaseT += dt;
    if (this.phase === 'replay') { this._updateReplay(dt); this.court.update(this.time, dt); return; }
    this.time += dt;
    this.wallAt = performance.now();
    const ph = this.phase;
    switch (ph) {
      case 'intro':
        if (this.phaseT > 3.2 || this.skip) { this.skip = false; this._startPoint(); }
        break;
      case 'serve': this._updateServe(); break;
      case 'rally': this._updateRally(); break;
      case 'over': this._updateOver(); break;
      case 'score':
        if (this.phaseT > (this.scoreDur || 1.8)) this._afterScore();
        break;
      case 'matchEnd':
        if (this.phaseT > 3.4 && !this.resultsShown) this._showResults();
        break;
      default: break;
    }
    this._movePlayers(dt);
    for (const p of this.players) p.char.update(dt);
    this.court.update(this.time, dt);
    if (['serve', 'rally', 'over'].includes(ph)) this._record();
  }

  _updateServe() {
    const s = this.serve;
    const srv = this.server;
    if (!s.tossed) {
      if (!this.isHuman(srv) && this.time >= s.cpuTossAt) this._toss();
      // A human who hasn't served yet gets a hint on the TV after a moment.
      else if (this.isHuman(srv) && !s.prompted && this.phaseT > (this.stats.rallies.length ? 3.5 : 1.4)) {
        s.prompted = true;
        const half = this.split ? (srv.team === 0 ? '25%' : '75%') : '50%';
        if (srv.seat?.local) {
          const k = KB_KEYS[Math.max(0, this._kbSeats().indexOf(srv.seat.key))];
          this.hud.prompt(`${srv.name} to serve`, k.glyph, `${k.label} to toss, ${k.label} again to hit`, half);
        }
        else this.hud.prompt(`${srv.name} to serve`, 'A', 'Swing to toss, swing again to hit', half);
      }
      return;
    }
    const u = this.time - s.t0;
    if (!s.hit && !this.isHuman(srv) && this.time >= s.cpuHitAt) {
      if (!this._serveHit(s.cpuHitAt)) s.cpuHitAt = this.time + 0.05;
    }
    if (!s.hit && u > 1.18) {
      // Nobody hit it: catch the ball and toss again.
      s.tossed = false;
      this.ball.mode = 'held';
      srv.char.setPose('ready');
      s.cpuTossAt = this.time + 0.8;
      this.ctx.app.syncPhones();
    }
  }

  _updateRally() {
    // Early swings waiting for the ball to arrive.
    for (let i = this.pendingHits.length - 1; i >= 0; i--) {
      const h = this.pendingHits[i];
      if (this.time >= h.at) { this.pendingHits.splice(i, 1); this._hit(h.plan, h.at, h.delta, h.swing); }
    }
    // CPU swings.
    const plan = this.plan;
    if (plan && !plan.done && plan.cpu && !this.isHuman(plan.hitter)) {
      const c = plan.cpu;
      if (!c.leave) {
        const contact = plan.tc + Math.max(0, c.delta * 0.6);
        const kind = plan.kind === 'smash' ? 'smash' : plan.kind === 'volley' ? 'volley' : plan.side;
        if (!c.swung && this.time >= contact - SWING_DUR * CONTACT_AT) { c.swung = true; this._animSwing(plan.hitter, kind, contact); }
        if (this.time >= contact && !plan.done) {
          plan.done = true;
          if (!c.miss) this._hit(plan, contact, c.delta, null, c.type);
        }
      }
    }
    // A dive when the ball is just out of reach.
    if (plan && plan.dive && !plan.dived && this.time > plan.tc - 0.3) {
      plan.dived = true;
      const p = plan.hitter;
      p.char.setPose('dive');
      p.char.anim.dive.dir = Math.sign((plan.contact.x - p.pos.x) * rightSign(p.team)) || 1;
      p.char.anim.dive.p = 0;
      p.diveUntil = this.time + 1.1;
    }
    this._advanceBall(this.time);
    // A point decided — after a short grace for lagging phones.
    if (this.pendingPoint && this.time - this.pendingPoint.t > GRACE) this._endPoint(this.pendingPoint);
    if (this.ball.mode === 'dead' && !this.pendingPoint) this._endPoint({ team: 1 - this.ball.lastHitTeam, t: this.time, reason: 'out', x: this.ball.st.x, z: this.ball.st.z });
  }

  _updateOver() {
    if (this.ball.mode === 'flight') this._advanceBall(this.time);
    if (this.phaseT > 1.7) {
      if (this.wantReplay && this.frames.length > 30) this._startReplay();
      else this._showScore();
    }
  }

  // Players run to their spots (the hitter to the ball).
  _movePlayers(dt) {
    const b = this.ball;
    const plan = this.phase === 'rally' ? this.plan : null;
    const bx = b?.st ? b.st.x : 0;
    for (const p of this.players) {
      if (this.phase === 'serve' || this.phase === 'intro') { this._face(p, dt); continue; }
      if (this.phase === 'over' || this.phase === 'score' || this.phase === 'matchEnd') { p.vel.x *= 0.85; p.vel.z *= 0.85; this._face(p, dt); this._step(p, dt, 0); continue; }
      let tx, tz;
      const S = sideZ(p.team);
      if (plan && plan.hitter === p && !plan.hopeless) { tx = plan.stand.x; tz = plan.stand.z; }
      else if (plan && plan.team === p.team) {
        // Partner covers the other half.
        const h = plan.hitter;
        tx = clamp(-Math.sign(h.pos.x || 0.1) * 2.6, -3.2, 3.2);
        tz = S * (p.role === 'front' ? 3.6 : 11.0);
      } else {
        const lean = b?.lastHitTeam === p.team ? 0.4 : 0.55;
        tx = clamp(bx * lean, -3.4, 3.4);
        tz = S * (p.role === 'front' ? 3.8 : 11.1);
      }
      p.target.x = tx; p.target.z = tz;
      const vmax = this.isHuman(p) ? HUMAN_SPEED : this.level.speed;
      if (p.diveUntil && this.time < p.diveUntil) { p.vel.x *= 0.9; p.vel.z *= 0.9; this._step(p, dt, vmax); continue; }
      if (p.char.anim.pose === 'dive') p.char.setPose('ready');
      const dx = tx - p.pos.x, dz = tz - p.pos.z;
      const d = Math.hypot(dx, dz);
      const want = Math.min(vmax, d * 4.5);
      const vx = d > 1e-3 ? (dx / d) * want : 0, vz = d > 1e-3 ? (dz / d) * want : 0;
      const acc = 24 * dt;
      p.vel.x += clamp(vx - p.vel.x, -acc, acc);
      p.vel.z += clamp(vz - p.vel.z, -acc, acc);
      this._step(p, dt, vmax);
      this._face(p, dt);
    }
  }

  _step(p, dt) {
    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
    // Stay on your own side, inside the walls.
    const S = sideZ(p.team);
    p.pos.z = S > 0 ? clamp(p.pos.z, 0.8, 19.5) : clamp(p.pos.z, -19.5, -0.8);
    p.pos.x = clamp(p.pos.x, -9.8, 9.8);
    p.char.group.position.set(p.pos.x, 0, p.pos.z);
    p.char.anim.run.speed = Math.hypot(p.vel.x, p.vel.z);
  }

  _face(p, dt) {
    // Face the net, turned a little toward the ball.
    let yaw = p.team === 0 ? 0 : Math.PI;
    const b = this.ball?.st;
    if (b && this.ball.mode !== 'held') {
      const dx = b.x - p.pos.x, dz = b.z - p.pos.z;
      const toBall = Math.atan2(-dx, -dz);
      let d = toBall - yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      yaw += clamp(d, -0.6, 0.6) * 0.5;
    }
    const cur = p.char.group.rotation.y;
    const diff = Math.atan2(Math.sin(yaw - cur), Math.cos(yaw - cur));
    p.char.group.rotation.y = cur + diff * Math.min(1, dt * 8);
  }

  // ------------------------------------------------------------ end of a point

  _endPoint(pp) {
    if (this.phase !== 'rally') return;
    this.pendingPoint = null;
    const winner = pp.team;
    const reason = pp.reason;
    this.lastPoint = { winner, reason, rally: this.shots, fast: !!this.lastHit?.fast, kind: this.ball.hitKind };
    (this.pointLog ||= []).push(this.lastPoint);
    this.stats.rallies.push(this.shots);
    if (reason === 'ace') this.stats.aces[winner]++;
    if (reason === 'winner' || reason === 'ace') this.stats.winners[winner]++;
    // The call.
    if (reason === 'out') {
      this.court.showMark(pp.x, pp.z, true);
      const sp = this._project(new THREE.Vector3(pp.x, 0.4, pp.z));
      if (sp) this.hud.out(sp.x, sp.y);
      this.audio.say('Out!', { rate: 1.1 });
      this.audio.outCall();
    }
    if (reason === 'ace') banner(this.hud.bannerRoot, 'Ace!', null, { kind: 'gold', ms: 1500, top: '20vh' });
    // Reactions.
    for (const p of this.players) p.char.setPose(p.team === winner ? 'celebrate' : 'slump');
    const humansWon = this.teams[winner].humans > 0;
    this.court.crowdReact('cheer', 2.2);
    this.audio.crowd(humansWon ? 'cheer' : 'clap', this.shots > 6 ? 1.2 : 0.8);
    for (const p of this.players) {
      if (!p.seat || p.seat.local) continue;
      if (p.team === winner) this.link.sendEvent(p.seat.slot, { type: 'sound', name: 'point' });
    }
    // CPUs sweat in long rallies.
    if (this.shots > 8) for (const p of this.players) if (!p.seat) p.char.anim.sweat = Math.min(1, p.char.anim.sweat + 0.35);
    this.wantReplay = (reason === 'out' || reason === 'winner' || reason === 'ace') && (this.lastHit?.fast || this.shots >= 4 || reason === 'out') && this.opts.replays !== false;
    this.result = this.match.point(winner);
    this._go('over');
  }

  _showScore() {
    const r = this.result;
    const m = this.match;
    clearBanners(this.hud.bannerRoot);
    this.hud.replay(false);
    for (const p of this.players) p.char.setPose('ready');
    this._hudScore();
    if (r.match !== null && r.match !== undefined) {
      band(this.hud.bannerRoot, 'Game, Set & Match', `${this.teams[r.match].title}`, 3200);
      this.audio.say('Game, set and match!');
      this.audio.jingle('win');
      this.audio.crowd('big');
      this.court.crowdReact('cheer', 4);
      for (const p of this.players) p.char.setPose(p.team === r.match ? 'celebrate' : 'sad');
      this.over = true;
      this.winner = r.match;
      for (const p of this.players) if (p.seat && !p.seat.local) this.link.sendEvent(p.seat.slot, { type: 'sound', name: p.team === r.match ? 'win' : 'miss' });
      this._go('matchEnd');
      return;
    }
    if (r.game !== null && r.game !== undefined) {
      banner(this.hud.bannerRoot, 'Game', `${this.teams[r.game].title} · ${m.games[0]}–${m.games[1]}`, { kind: 'green', ms: 1900 });
      this.audio.say('Game!');
      this.audio.jingle('game');
      this.scoreDur = 2.2;
    } else {
      const call = r.call;
      banner(this.hud.bannerRoot, call, null, { kind: call === 'Deuce' ? 'dark' : call === 'Advantage' ? 'gold' : '', ms: 1500 });
      if (call === 'Advantage') {
        const team = r.advantageTeam;
        banner(this.hud.bannerRoot, '', `${this.teams[team].title}`, { ms: 1500, top: '42vh' });
      }
      this.audio.say(call.replace('–', ' ').replace('Love', 'love'));
      this.scoreDur = 1.6;
    }
    this._go('score');
  }

  _afterScore() { this._startPoint(); }

  _showResults() {
    this.resultsShown = true;
    const w = this.winner;
    const teams = this.teams.map((t) => ({ title: t.title, sub: t.sub, games: this.match.games[t.team], players: t.players.map((p) => ({ name: p.name, color: p.color, character: p.character })) }));
    const avg = this.stats.rallies.length ? (this.stats.rallies.reduce((a, b) => a + b, 0) / this.stats.rallies.length) : 0;
    const stats = [`Longest rally: ${this.stats.longest} shots`, `Average rally: ${avg.toFixed(1)}`, `Fastballs: ${this.stats.fast[0]}–${this.stats.fast[1]}`, `Aces: ${this.stats.aces[0]}–${this.stats.aces[1]}`];
    this.hud.results({ title: `${this.teams[w].title} win!`, sub: `${this.match.games[0]}–${this.match.games[1]} · ${this.opts.format === 1 ? 'One game' : `Best of ${this.opts.format}`}`, teams, winner: w, stats }, {
      onAgain: () => this.ctx.app.again(),
      onLobby: () => this.ctx.app.toLobby(),
    });
    this.audio.music('results');
    this.ctx.app.syncPhones();
  }

  // ------------------------------------------------------------ replay

  _record() {
    const b = this.ball;
    let bp = null;
    if (b) {
      if (b.mode === 'flight' || b.mode === 'dead') bp = [b.st.x, b.st.y, b.st.z];
      else if (b.mode === 'toss') { const q = this._tossPos(this.time); bp = [q.x, q.y, q.z]; }
    }
    this.frames.push({
      t: this.time, ball: bp, fast: !!b?.fast,
      p: this.players.map((p) => ({ x: p.pos.x, z: p.pos.z, ry: p.char.group.rotation.y, a: p.char.snapshot() })),
    });
    if (this.frames.length > 60 * 6) this.frames.splice(0, 30);
  }

  _startReplay() {
    const end = this.frames[this.frames.length - 1].t;
    const startT = Math.max(this.pointStart, (this.lastPoint ? end - 1.4 : end) - REPLAY_SPAN);
    this.replay = { t: startT, end, i: 0 };
    this.replaySkip = false;
    this.hud.replay(true);
    this.hud.clearOut();
    clearBanners(this.hud.bannerRoot);
    this.court.clearTrail();
    this._go('replay');
  }

  _updateReplay(dt) {
    const r = this.replay;
    r.t += dt * REPLAY_SPEED;
    if (r.t >= r.end || this.replaySkip) {
      this.replaySkip = false;
      // Put everyone back where the point ended.
      const last = this.frames[this.frames.length - 1];
      this._applyFrame(last);
      this.hud.replay(false);
      this._showScore();
      return;
    }
    while (r.i < this.frames.length - 1 && this.frames[r.i + 1].t <= r.t) r.i++;
    this._applyFrame(this.frames[r.i]);
  }

  _applyFrame(f) {
    f.p.forEach((s, i) => {
      const p = this.players[i];
      p.char.group.position.set(s.x, 0, s.z);
      p.char.group.rotation.y = s.ry;
      p.char.restore(s.a);
    });
    this._replayBall = f.ball;
    this._replayFast = f.fast;
  }

  // ------------------------------------------------------------ camera + render

  _cameraFor(team, cam, dt) {
    const S = sideZ(team);
    const b = this.ball?.st;
    const follow = b && this.phase !== 'intro' ? clamp(b.x * 0.18, -1.4, 1.4) : 0;
    if (this.phase === 'intro') {
      const u = Math.min(1, this.phaseT / 3.0);
      const a = (1 - u) * 1.6;
      const r = lerp(36, 24, u);
      cam.position.set(Math.sin(a) * r * S, lerp(17, 9.0, u), Math.cos(a) * r * S);
      cam.lookAt(0, 0.2, -3.5 * S);
      return;
    }
    if (this.phase === 'replay') {
      const bp = this._replayBall || [0, 1, 0];
      // From the stands opposite the umpire's chair (which would block the net).
      cam.position.set(12.5, 3.2, clamp(bp[2] * 0.75, -12, 12));
      cam.lookAt(bp[0] * 0.5, 0.8, bp[2]);
      return;
    }
    if (this.phase === 'matchEnd') {
      const a = this.phaseT * 0.25;
      const w = this.teams[this.winner];
      const cz = w ? sideZ(w.team) * 9 : 0;
      cam.position.set(Math.sin(a) * 9, 3.2, cz + Math.cos(a) * 9 * -sideZ(this.winner));
      cam.lookAt(0, 1, cz);
      return;
    }
    const split = this.split;
    const want = new THREE.Vector3(follow, split ? 10.5 : 9.0, S * (split ? 25.5 : 24.0));
    if (!this._camState) this._camState = [want.clone(), new THREE.Vector3(0, want.y, -want.z)];
    const cs = this._camState[team];
    cs.lerp(want, 1 - Math.exp(-dt * 2));
    cam.position.copy(cs);
    cam.lookAt(cs.x * 0.6, 0.2, -3.5 * S);
  }

  _render() {
    const dt = 1 / 60;
    // The ball.
    let bp = null, fast = false;
    if (this.phase === 'replay') { bp = this._replayBall; fast = this._replayFast; }
    else if (this.ball) {
      const b = this.ball;
      fast = b.fast;
      if (b.mode === 'flight' || b.mode === 'dead') bp = [b.st.x, b.st.y, b.st.z];
      else if (b.mode === 'toss') { const q = this._tossPos(this.time); bp = [q.x, q.y, q.z]; }
      else if (b.mode === 'held' && this.server) { const h = this.server.char.offHandWorld(new THREE.Vector3()); bp = [h.x, h.y, h.z]; }
    }
    if (bp) this.court.setBall(bp[0], bp[1], bp[2], true, fast, fast && this.ball?.hitKind === 'smash' ? '#ffd24a' : '#ffffff');
    else this.court.setBall(0, -5, 0, false);
    const w = window.innerWidth, h = window.innerHeight;
    const r = this.renderer;
    if (this.split && this.phase !== 'replay' && this.phase !== 'intro' && this.phase !== 'matchEnd') {
      this.camera.aspect = (w / 2) / h; this.camera.fov = 50; this.camera.updateProjectionMatrix();
      this.camera2.aspect = (w / 2) / h; this.camera2.fov = 50; this.camera2.updateProjectionMatrix();
      this._cameraFor(0, this.camera, dt);
      this._cameraFor(1, this.camera2, dt);
      r.setScissorTest(true);
      r.setViewport(0, 0, w / 2, h); r.setScissor(0, 0, w / 2, h);
      r.render(this.scene, this.camera);
      r.setViewport(w / 2, 0, w / 2, h); r.setScissor(w / 2, 0, w / 2, h);
      r.render(this.scene, this.camera2);
      r.setScissorTest(false);
      r.setViewport(0, 0, w, h);
      this.hud.split(true);
    } else {
      this.camera.aspect = w / h; this.camera.fov = 40; this.camera.updateProjectionMatrix();
      this._cameraFor(0, this.camera, dt);
      r.setViewport(0, 0, w, h);
      r.render(this.scene, this.camera);
      this.hud.split(false);
    }
    this._tags();
  }

  // Screen position of a world point in the main (left) view.
  _project(v, cam = this.camera, half = null) {
    const p = v.clone().project(cam);
    if (p.z > 1) return null;
    const w = window.innerWidth, h = window.innerHeight;
    const split = this.split && this.phase !== 'replay' && this.phase !== 'intro' && this.phase !== 'matchEnd';
    const vw = split ? w / 2 : w;
    const ox = split && half === 1 ? w / 2 : 0;
    return { x: ox + (p.x * 0.5 + 0.5) * vw, y: (-p.y * 0.5 + 0.5) * h };
  }

  _tags() {
    const list = [];
    const show = !['intro', 'replay', 'matchEnd'].includes(this.phase) && !this.resultsShown;
    const anyHuman = this.players.some((p) => p.seat);
    const plan = this.plan;
    for (const p of this.players) {
      if (!show) continue;
      const human = !!p.seat;
      if (!human && !anyHuman) continue;
      const head = this.tagV.set(p.pos.x, 2.15, p.pos.z);
      const views = this.split && this.phase !== 'replay' ? [[this.camera, 0], [this.camera2, 1]] : [[this.camera, 0]];
      for (const [cam, half] of views) {
        if (this.split && half !== p.team && !human) continue;
        const sp = this._project(head, cam, half);
        if (!sp) continue;
        list.push({
          id: `${p.id}-${half}`, x: sp.x, y: sp.y, text: human ? (p.seat.local ? p.name : `P${p.seat.slot + 1}`) : 'CPU', color: human ? p.color : 'rgba(30,40,56,.7)', cpu: !human,
          hit: this.phase === 'rally' && plan && plan.hitter === p && !plan.done && human,
          hidden: !human && this.split && half !== p.team,
        });
      }
    }
    this.hud.tags(list);
  }

  _hudScore() {
    const teams = this.teams.map((t) => ({ title: t.title, sub: t.sub, players: t.players.map((p) => ({ color: p.color, character: p.character })) }));
    this.hud.score(teams, this.match.snapshot());
  }

  resize() { /* the camera aspect is set every frame */ }

  pause(on) { this.paused = on; }

  // ------------------------------------------------------------ input

  input(msg, seat) {
    if (!seat) return;
    if (msg.t === 'tswing') {
      if (this._lastSwingId?.[seat.key] === msg.id) return;
      (this._lastSwingId ||= {})[seat.key] = msg.id;
      this.humanSwing(seat.key, msg);
      return;
    }
    if (msg.t === 'btn' && msg.down) {
      if (msg.b === 'a') {
        if (this.phase === 'intro') { this.skip = true; return; }
        if (this.phase === 'replay') { this.replaySkip = true; return; }
        if (this.phase === 'serve' && this.server.seat?.key === seat.key && !this.serve.tossed) { this._toss(); return; }
        if (this.resultsShown && this.ctx.app.isHost(seat.slot)) { this.ctx.app.again(); return; }
      }
    }
  }

  // Keyboard players share one keyboard: the first swings with Space (Z / X
  // force forehand / backhand), a second with Enter (, / .), then Q and O.
  // Hold ↑ / ↓ while swinging for a lob / slice.
  _kbSeats() {
    return this.ctx.seats.filter((s) => s.local && this.players.some((p) => p.seat?.key === s.key)).map((s) => s.key);
  }

  _kbLabel(seatKey) {
    const i = this._kbSeats().indexOf(seatKey);
    return KB_KEYS[Math.max(0, i)].label;
  }

  keyDown(e) {
    if (e.repeat) return;
    if (e.code === 'ArrowUp') this.keys.up = true;
    if (e.code === 'ArrowDown') this.keys.down = true;
    if (this.resultsShown) {
      if (e.code === 'Enter') this.ctx.app.again();
      if (e.code === 'Escape') this.ctx.app.toLobby();
      return;
    }
    let idx = -1, side = null;
    KB_KEYS.forEach((k, i) => {
      if (e.code === k.swing) idx = i;
      else if (e.code === k.fh) { idx = i; side = 'fh'; } else if (e.code === k.bh) { idx = i; side = 'bh'; }
    });
    if (idx < 0) return;
    e.preventDefault();
    if (this.phase === 'intro') { this.skip = true; return; }
    if (this.phase === 'replay') { this.replaySkip = true; return; }
    const kb = this._kbSeats();
    if (!kb.length) return;
    // A lone keyboard player can use any of the keys.
    const key = kb[idx] || (kb.length === 1 ? kb[0] : null);
    if (!key) return;
    const plan = this.plan;
    if (!side) side = plan && plan.hitter.seat?.key === key ? plan.side : 'fh';
    const plane = this.keys.up ? 0.8 : this.keys.down ? -0.8 : 0;
    this.humanSwing(key, { side, speed: 0.6, plane, roll: 0, lag: 0, age: 0, at: performance.now() });
  }

  keyUp(e) {
    if (e.code === 'ArrowUp') this.keys.up = false;
    if (e.code === 'ArrowDown') this.keys.down = false;
  }

  // ------------------------------------------------------------ phones

  phoneState(slot) {
    const mine = this.players.filter((p) => p.seat && !p.seat.local && p.seat.slot === slot);
    const snap = this.match.snapshot();
    const teams = this.teams.map((t, i) => ({ names: t.title, games: snap.games[i], label: snap.labels[i] }));
    const out = { kind: 'tennis', step: this.phase, point: this.match.pointsPlayed, score: { teams } };
    if (!mine.length) { out.msg = { title: 'Watching', sub: 'You’re not on court this match' }; return out; }
    const team = mine[0].team;
    out.role = mine.length > 1 ? `You play both ${team === 0 ? 'near' : 'far'}-side players` : `You play ${mine[0].role === 'front' ? 'at the net' : 'at the back'} · ${team === 0 ? 'near' : 'far'} side`;
    if (this.phase === 'serve') {
      out.serving = mine.includes(this.server);
      out.tossed = this.serve.tossed;
      if (!out.serving) out.msg = { title: this.server.team === team ? 'Partner serving' : 'Get ready to return', sub: this.receiver && mine.includes(this.receiver) ? 'The serve is coming to you' : '' };
    } else if (this.phase === 'rally') {
      const plan = this.plan;
      out.yourBall = !!(plan && !plan.done && mine.includes(plan.hitter) && !plan.hopeless);
      if (out.yourBall) out.hitter = plan.hitter.role;
      out.msg = { title: 'Rally!', sub: '' };
    } else if (this.phase === 'intro') out.msg = { title: 'Tennis', sub: `${this.teams[0].title} vs ${this.teams[1].title}` };
    else if (this.phase === 'replay') out.msg = { title: 'Replay', sub: 'Swing or tap A to skip' };
    else if (this.phase === 'over' || this.phase === 'score') {
      const lp = this.lastPoint;
      const won = lp && lp.winner === team;
      out.msg = { title: won ? 'Point!' : 'Point lost', sub: lp?.reason === 'out' ? 'Out!' : lp?.reason === 'ace' ? 'Ace!' : lp?.rally > 6 ? `${lp.rally}-shot rally` : '' };
    }
    if (this.over && this.resultsShown) {
      const won = this.winner === team;
      out.over = {
        won, title: won ? 'You win! 🏆' : 'Good game!', sub: `${snap.games[0]}–${snap.games[1]}`,
        standings: this.teams.map((t, i) => ({ place: i === this.winner ? 1 : 2, placeLabel: i === this.winner ? '🏆' : '', name: t.title, value: String(snap.games[i]), you: i === team })),
      };
    }
    return out;
  }

  dispose() {
    this.audio.ambience(null);
    this.hud.dispose();
    for (const p of this.players) p.char.dispose();
    this.court.dispose();
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  }
}

void TEAM_COLORS;
