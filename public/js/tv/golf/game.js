// Golf on Krishiv Links: nine holes (Meadow 1–3, Lakeside 4–6, Clifftop 7–9,
// or all nine), four clubs, wind, and a power meter you must not overswing. Hold A and swing to hit; swing without A to practise.
//
// A turn:  aim (◀ ▶, club ▲ ▼, views 1 / 2, practice swings) → swing →
//          flight (the whole shot is simulated at impact and played back) →
//          result → the next player (farthest from the hole) …
// A hole:  flyover → turns → everyone holed (or gave up) → scorecard.

import * as THREE from 'three';
import { CourseScene } from './course.js';
import { GolfHud, fmtDist } from './hud.js';
import { Brainrot } from '../brainrot.js';
import { banner, band, clearBanners } from '../ui.js';
import { getHole } from '../../shared/golf-course.js';
import { simulateShot, suggestClub, putterScale, swingToShot, flatLanding, CLUBS, CLUB_ORDER, LIE_CAP } from '../../shared/golf-physics.js';
import { GolfRound, scoreName, toParText, PARS } from '../../shared/golf-rules.js';
import { GOLF_COURSES, colorHex, M_TO_YD, M_TO_FT, MPS_TO_MPH } from '../../shared/protocol.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const AIM_STEP = 0.5 * Math.PI / 180;
const PUTT_AIM_STEP = 0.2 * Math.PI / 180;

export default class GolfGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.renderer = ctx.renderer;
    this.audio = ctx.audio;
    this.link = ctx.link;
    this.course = GOLF_COURSES.find((c) => c.id === ctx.opts.course) || GOLF_COURSES[0];
    this.time = 0;
    this.phase = 'load';
    this.phaseT = 0;
    this.over = false;
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 3000);
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.view = 'normal';      // normal | map (1) | eye (2)
    this.held = new Map();     // repeat timers for held D-pad buttons
    this.kb = { space: false, t0: 0 };
    this.seed = Math.floor(Math.random() * 1e6);
  }

  // ------------------------------------------------------------ setup

  async load(progress) {
    const seats = this.ctx.seats;
    this.players = seats.map((s, i) => ({
      index: i, seat: s, name: s.name, color: colorHex(s.color), colorId: s.color, character: s.character, hand: s.hand || 'right',
      char: null, ball: null,
    }));
    this.round = new GolfRound({ holes: this.course.holes, players: this.players.map((p) => ({ id: p.seat.key, name: p.name })) });
    this.hud = new GolfHud(this.ctx.hudRoot);
    this.hud.show(false);
    for (const p of this.players) {
      p.char = new Brainrot({ character: p.character, color: p.color, hand: p.hand, seed: 31 + p.index });
      p.char.setEquipment('club', 'driver');
    }
    progress?.('Mowing the fairways…');
    await new Promise((r) => setTimeout(r, 20));
    await this._loadHole(progress);
  }

  async _loadHole(progress) {
    const n = this.round.hole;
    progress?.(`Hole ${n}: shaping the greens…`);
    await new Promise((r) => setTimeout(r, 20));
    if (this.cs) { for (const p of this.players) this.cs.scene.remove(p.char.group); this.cs.dispose(); }
    const hole = getHole(n);
    this.hole = hole;
    this.cs = new CourseScene(hole, { low: new URLSearchParams(location.search).get('quality') === 'low' });
    this.scene = this.cs.scene;
    for (const p of this.players) { this.scene.add(p.char.group); p.char.group.visible = false; }
    // Pin: one of the hole's positions; wind from the course's range.
    this.pin = hole.pinFor(Math.floor(Math.random() * hole.pins.length));
    this.cs.setPin(this.pin);
    const [lo, hi] = this.course.wind;
    const mph = lo + Math.random() * (hi - lo);
    const dir = Math.random() * Math.PI * 2;
    const mps = mph / MPS_TO_MPH;
    this.wind = [Math.cos(dir) * mps, 0, Math.sin(dir) * mps];
    this.windMph = mph;
    this.round.startHole({ x: hole.tee[0], z: hole.tee[1] }, this.pin);
    this.hud.buildMap(hole, this.cs.map);
    this.hud.hole(n, hole.par, hole.yards, this.round.holeIndex, this.course.holes.length);
    this.renderer.compile(this.scene, this.camera);
  }

  start() {
    this.audio.ambience('golf', { wind: this.windMph });
    this._flyover();
  }

  playersChanged(seats) {
    for (const p of this.players) {
      const s = seats.find((x) => x.key === p.seat.key);
      if (s) { p.seat = s; p.name = s.name; }
    }
  }

  // Phones that are gone: the host plays for them (or the keyboard).
  controllerOf(p) {
    if (!p) return null;
    if (p.seat.local) return 'kb';
    if (this.link.players[p.seat.slot]?.connected) return p.seat.slot;
    const h = this.ctx.app.hostSlot();
    return h >= 0 ? h : 'kb';
  }

  // ------------------------------------------------------------ flow

  _go(phase) {
    this.phase = phase;
    this.phaseT = 0;
    this.ctx.app.syncPhones();
  }

  _flyover() {
    const hole = this.hole;
    clearBanners(this.hud.bannerRoot);
    this.hud.hideCard();
    this.hud.show(false);
    this.hud.flyover(hole.n, hole.par, hole.yards, true, hole.name);
    // Path: over the tee → along the hole (aim points) → over the green → back behind the tee.
    const pts = [[hole.tee[0], hole.tee[1]], ...hole.aim, [this.pin.x, this.pin.z]];
    this.fly = { pts, dur: 6.2 };
    this.audio.music('golf');
    this.audio.say(`Hole ${hole.n}. Par ${hole.par}.`);
    this._go('flyover');
  }

  _startTurn() {
    const i = this.round.next();
    if (i < 0) { this._holeOver(); return; }
    this.cur = this.players[i];
    const rp = this.round.players[i];
    const p = this.cur;
    const surface = rp.surface;
    const pos = rp.pos;
    p.ball = { x: pos.x, z: pos.z };
    const dist = Math.hypot(pos.x - this.pin.x, pos.z - this.pin.z);
    this.turn = {
      player: p, rp, from: { x: pos.x, z: pos.z, teed: !rp.teed }, surface, dist,
      club: suggestClub(dist, surface), aim: 0, armed: false, practicePower: null,
      angle: 0, lastSwing: null,
    };
    this.turn.putterMax = putterScale(dist);
    this.turn.aim = this._defaultAim();
    for (const q of this.players) q.char.group.visible = q === p;
    p.char.setEquipment('club', this.turn.club);
    p.char.anim.club.club = this.turn.club;
    p.char.anim.club.angle = 0;
    p.char.setPose('address');
    this.view = 'normal';
    this.cs.showGrid(false);
    this._placeGolfer();
    this.hud.show(true);
    this.hud.clearShot();
    this.hud.player(p, rp.strokes + 1, this._toPar(i));
    this._hudClub();
    this.hud.power(0);
    this.cs.setTrail([]);
    this._camAim(true);
    this.audio.music(null);
    banner(this.hud.bannerRoot, p.name, rp.strokes === 0 ? 'Tee off!' : `${ordinal(rp.strokes + 1)} shot`, { ms: 1300, top: '22vh', kind: 'dark' });
    const ctl = this.controllerOf(p);
    if (typeof ctl === 'number') {
      this.link.sendEvent(ctl, { type: 'sound', name: 'turn' });
      this.link.sendEvent(ctl, { type: 'vibrate', pattern: [30, 50, 30] });
    }
    this._go('aim');
  }

  _toPar(i) {
    const t = this.round.totals()[i];
    return t.toPar;
  }

  // The default aim: at the pin if it can be reached, else at the hole's
  // landing area for long shots.
  _defaultAim() {
    const t = this.turn;
    const reach = CLUBS[t.club].putter ? 999 : CLUBS[t.club].maxCarry * (LIE_CAP[t.surface] ?? 1) * 1.08;
    let target = this.pin;
    if (t.dist > reach) {
      const pinD = t.dist;
      const ahead = this.hole.aim.map(([x, z]) => ({ x, z })).filter((a) => {
        const d = Math.hypot(a.x - t.from.x, a.z - t.from.z);
        return d > 25 && Math.hypot(a.x - this.pin.x, a.z - this.pin.z) < pinD - 10;
      });
      if (ahead.length) target = ahead[0];
    }
    return Math.atan2(target.x - t.from.x, -(target.z - t.from.z));
  }

  _placeGolfer() {
    const t = this.turn;
    const p = t.player;
    const ch = p.char;
    // Stand side-on: the target to the golfer's left (right-handed).
    const dir = new THREE.Vector3(Math.sin(t.aim), 0, -Math.cos(t.aim));
    const S = p.hand === 'left' ? -1 : 1;
    const facing = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(S);       // dir × up
    const local = ch.ballLocal(t.club);                                          // where the ball sits in front of the golfer
    const gx = t.from.x - facing.x * -local.z, gz = t.from.z - facing.z * -local.z;
    ch.group.position.set(gx, this.hole.heightAt(gx, gz), gz);
    ch.group.rotation.y = Math.atan2(-facing.x, -facing.z);
  }

  _hudClub() {
    const t = this.turn;
    const cap = LIE_CAP[t.surface] ?? 1;
    this.hud.club(t.club, t.surface, cap, t.putterMax * M_TO_FT);
    const putt = CLUBS[t.club].putter;
    this.hud.distance(putt ? `${fmtDist(t.dist, true)} to the hole` : `${fmtDist(t.dist)} to the pin`, '');
  }

  _marks() {
    const t = this.turn;
    return [0.25, 0.5, 0.75, 1].map((pw) => flatLanding(t.club, pw, t.from, t.aim, t.putterMax));
  }

  // A swing from the controller. sw: { power, curve, practice, mode }
  _swing(sw) {
    const t = this.turn;
    if (this.phase !== 'aim' || !t) return;
    const p = t.player;
    if (this.view === 'eye') { this.view = 'normal'; p.char.group.visible = true; this.ctx.app.syncPhones(); }
    if (sw.practice) {
      t.practicePower = sw.power;
      const cap = LIE_CAP[t.surface] ?? 1;
      this.hud.power(sw.power, { over: sw.power > cap, curve: sw.curve });
      if (sw.mode !== 'motion') this._practiceAnim(sw.power);
      this.audio.swing(Math.min(1.2, sw.power));
      return;
    }
    const shot = swingToShot(sw.power, sw.curve, t.surface, this.seed++);
    t.lastSwing = { ...sw, ...shot };
    this.hud.power(sw.power, { over: shot.over > 0.02, curve: shot.curve });
    const sim = simulateShot(this.hole, {
      from: t.from, aim: t.aim, clubId: t.club, power: shot.power, curve: shot.curve,
      wind: CLUBS[t.club].putter || ['green', 'fringe'].includes(t.surface) ? [0, 0, 0] : this.wind,
      pin: this.pin, seed: this.seed++, putterMax: t.putterMax,
    });
    t.sim = sim;
    this.flight = null;
    this.practice = null;
    // The golfer swings through; the ball leaves at impact.
    this.swingAnim = { t: 0, from: Math.max(20, p.char.anim.club.angle || (CLUBS[t.club].putter ? 25 : 150)), power: shot.power };
    p.char.setPose('golf');
    this._go('swing');
  }

  _practiceAnim(power) {
    const p = this.turn.player;
    this.practice = { t: 0, top: CLUBS[this.turn.club].putter ? 30 * power + 8 : 60 + power * 110 };
    p.char.setPose('golf');
  }

  _launch() {
    const t = this.turn;
    const sw = t.lastSwing;
    const putt = CLUBS[t.club].putter;
    const lie = t.surface;
    this.audio.club(putt ? 'putter' : lie === 'sand' ? 'sand' : lie === 'rough' ? 'rough' : t.club, sw.power);
    if (!putt) this.audio.whoosh(Math.min(1.2, sw.power));
    if (sw.nice && !putt) {
      this.hud.shot('Nice shot!', null, 1600);
      this.audio.say('Nice shot!');
    } else if (sw.over > 0.02) {
      this.hud.shot(sw.curve < 0 ? 'Hook!' : 'Slice!', 'Overswing — stay under the red dot', 2000);
    }
    this.flight = { t: 0, i: 0, ev: 0, trail: [], landed: false, landCam: null };
    t.player.char.setPose('finish');
    this.cs.setAim(null, null, false);
    this.cs.showGrid(false);
    this.view = 'normal';
    const ctl = this.controllerOf(t.player);
    if (typeof ctl === 'number') this.link.sendEvent(ctl, { type: 'sound', name: 'hit', k: Math.min(1, sw.power) });
    this._go('flight');
  }

  _finishFlight() {
    const t = this.turn;
    const sim = t.sim;
    const p = t.player;
    const i = p.index;
    const rest = sim.rest;
    const res = this.round.recordShot(i, { result: sim.result, pos: { x: rest.x, z: rest.z }, surface: rest.surface });
    const putt = CLUBS[t.club].putter;
    const fromGreen = ['green', 'fringe'].includes(t.surface);
    let title = null, sub = null, kind = '';
    if (sim.result === 'holed') {
      const name = res.name;
      const strokes = res.strokes;
      const d = strokes - this.hole.par;
      if (strokes === 1) {
        band(this.hud.bannerRoot, 'Hole in One!', `${p.name}`, 3600);
        this.audio.say('Hole in one!');
        this.audio.jingle('ace');
        this.audio.crowd('big', 1.2);
      } else {
        const chip = !putt && !fromGreen;
        title = name;
        sub = chip ? 'Chip-in!' : null;
        kind = d < 0 ? 'gold' : d === 0 ? 'green' : 'dark';
        banner(this.hud.bannerRoot, name, sub || `${strokes} strokes`, { kind, ms: 2600 });
        this.audio.say(chip ? `${name}! Chip in!` : `${name}!`);
        this.audio.jingle(d <= -2 ? 'eagle' : d === -1 ? 'birdie' : 'point');
        this.audio.crowd(d < 0 ? 'big' : 'cheer', d < 0 ? 1 : 0.7);
      }
      p.char.setPose(d <= 0 ? 'celebrate' : 'cheer');
      const ctl = this.controllerOf(p);
      if (typeof ctl === 'number') this.link.sendEvent(ctl, { type: 'sound', name: 'cup' });
    } else if (sim.result === 'water' || sim.result === 'ob') {
      const ob = sim.result === 'ob' || this.hole.obWater;
      title = ob ? 'Out of bounds' : 'Water hazard';
      sub = '+1 penalty stroke';
      this.hud.shot(title, sub, 2600);
      this.audio.say(ob ? 'Out of bounds.' : 'Water hazard.');
      this.audio.crowd('groan');
      p.char.setPose('slump');
    } else {
      const lie = { fairway: 'Fairway', rough: 'Rough', sand: 'Bunker', green: 'On the green', fringe: 'Fringe', tee: 'Tee' }[rest.surface] || '';
      const dist = sim.total;
      const left = Math.hypot(rest.x - this.pin.x, rest.z - this.pin.z);
      title = putt ? `${fmtDist(left, true)} left` : `${fmtDist(dist)}`;
      sub = putt ? (sim.events.some((e) => e.type === 'lip') ? 'Lipped out!' : null) : lie;
      this.hud.shot(title, sub, 2400);
      if (left < 3.05 && !putt && !fromGreen) { this.audio.crowd('ooh', 1); }
      else if (rest.surface === 'green' && !fromGreen) this.audio.crowd('clap', 0.7);
      if (sim.events.some((e) => e.type === 'lip')) { this.audio.crowd('groan'); }
      p.char.setPose(left < 3 || rest.surface === 'green' ? 'cheer' : 'idle');
    }
    if (res?.gaveUp) {
      banner(this.hud.bannerRoot, 'Give up', `${p.name} picks up at ${res.strokes}`, { kind: 'red', ms: 2400, top: '40vh' });
    }
    this.hud.player(p, Math.min(this.round.players[i].strokes + 1, 99), this._toPar(i));
    this.result = { holed: sim.result === 'holed', at: this.time };
    this._go('result');
  }

  _holeOver() {
    this.round.finishHole();
    const last = this.round.over;
    this._showCard(last);
    this._go(last ? 'final' : 'card');
    if (last) this._final();
  }

  _rows() {
    const totals = this.round.totals();
    const standings = this.round.standings();
    return this.players.map((p, i) => ({
      name: p.name, color: p.colorId, character: p.character,
      scores: this.round.players[i].scores.slice(),
      total: totals[i].strokes, toPar: totals[i].toPar,
      place: standings.find((s) => s.index === i)?.place ?? i + 1,
    }));
  }

  _showCard(final) {
    this.hud.show(false);
    clearBanners(this.hud.bannerRoot);
    const rows = this._rows();
    if (final) return;
    this.hud.scorecard(this.course.holes, rows, { current: this.round.holeIndex - 1, title: `After hole ${this.course.holes[this.round.holeIndex - 1]}`, sub: this.course.label });
    this.audio.music('results');
  }

  _final() {
    this.over = true;
    const rows = this._rows();
    const st = this.round.standings();
    const win = this.players[st[0].index];
    const solo = this.players.length === 1;
    this.hud.scorecard(this.course.holes, rows, {
      title: solo ? `${toParText(st[0].toPar)} · ${st[0].strokes} strokes` : st.filter((s) => s.place === 1).length > 1 ? 'It’s a tie!' : `${win.name} wins!`,
      sub: `${this.course.label} · ${this.course.sub}`, final: true,
      onAgain: () => this.ctx.app.again(), onLobby: () => this.ctx.app.toLobby(),
    });
    this.audio.jingle('win');
    this.audio.crowd('big');
    this.audio.music('results');
    this.resultsShown = true;
    this.ctx.app.syncPhones();
  }

  async _nextHole() {
    this.hud.hideCard();
    this.phase = 'loading';
    await this._loadHole();
    this.audio.ambience('golf', { wind: this.windMph });
    this._flyover();
  }

  // ------------------------------------------------------------ per-frame

  frame(dt) {
    if (dt > 0) {
      let left = dt * (this.timeScale || 1);
      while (left > 1e-6) { const d = Math.min(left, 0.034); this._update(d); left -= d; }
    }
    this._render();
  }

  _update(dt) {
    this.time += dt;
    this.phaseT += dt;
    switch (this.phase) {
      case 'flyover':
        if (this.phaseT > this.fly.dur || this.skip) { this.skip = false; this.hud.flyover(0, 0, 0, false); this._startTurn(); }
        break;
      case 'aim': this._updateAim(dt); break;
      case 'swing': this._updateSwing(dt); break;
      case 'flight': this._updateFlight(dt); break;
      case 'result':
        if (this.phaseT > (this.result?.holed ? 3.0 : 2.4) || (this.skip && this.phaseT > 0.6)) { this.skip = false; this._startTurn(); }
        break;
      case 'card':
        if (this.phaseT > 6 || (this.skip && this.phaseT > 0.5)) { this.skip = false; this._nextHole(); }
        break;
      default: break;
    }
    for (const p of this.players) if (p.char.group.visible) p.char.update(dt);
    this.cs?.update(this.time);
    this.cs?.updateFlag(this.time, this.wind);
    this.cs?.updateFlow(dt);
  }

  _updateAim(dt) {
    const t = this.turn;
    const p = t.player;
    // Keyboard backswing.
    if (this.kb.space && this._kbPlayer() === p) {
      const u = (performance.now() - this.kb.t0) / 1000;
      const pw = Math.min(1.35, u / 1.15);
      this.kb.power = pw;
      p.char.anim.club.angle = Math.min(175, 20 + pw * 130);
      this.hud.power(pw, { over: pw > (LIE_CAP[t.surface] ?? 1) });
    } else if (this.practice) {
      // A practice swing (touch / keyboard) animates by itself.
      const pr = this.practice;
      pr.t += dt;
      const u = pr.t;
      p.char.anim.club.angle = u < 0.5 ? pr.top * smooth(0, 0.5, u) : u < 0.8 ? pr.top * (1 - smooth(0.5, 0.8, u)) - 60 * smooth(0.65, 0.8, u) : -60 * (1 - smooth(0.8, 1.3, u));
      if (u > 1.3) { this.practice = null; p.char.setPose('address'); p.char.anim.club.angle = 0; }
    } else if (this.liveAngle !== undefined && performance.now() - (this.liveAt || 0) < 400) {
      p.char.anim.club.angle = lerp(p.char.anim.club.angle, clamp(this.liveAngle, -170, 175), 1 - Math.exp(-dt * 25));
    } else {
      p.char.anim.club.angle *= Math.exp(-dt * 4);
    }
    // Aim line + map.
    const marks = this._marks();
    const putt = CLUBS[t.club].putter;
    this.cs.setAim(t.from, marks, this.view !== 'eye', putt);
    this.hud.drawMap(this._mapBalls(), { from: t.from, marks }, this.pin);
    this._camAim(false, dt);
  }

  _kbPlayer() { return this.players.find((p) => p.seat.local) || null; }

  _updateSwing(dt) {
    const a = this.swingAnim;
    a.t += dt;
    const p = this.turn.player;
    const putt = CLUBS[this.turn.club].putter;
    // Down from wherever the club was (the phone's backswing) through impact.
    const down = putt ? 0.28 : 0.24;
    if (a.t < down) p.char.anim.club.angle = a.from * (1 - smooth(0, down, a.t));
    else {
      if (!this.flight) this._launch();
      p.char.anim.club.angle = -170 * smooth(down, down + 0.45, a.t) * (putt ? 0.25 : 1);
      if (a.t > down + 0.1) { p.char.setPose('finish'); }
    }
    this._camAim(false, dt);
  }

  _updateFlight(dt) {
    const f = this.flight;
    const sim = this.turn.sim;
    f.t += dt;
    const S = sim.samples;
    while (f.i < S.length - 1 && S[f.i + 1].t <= f.t) f.i++;
    const a = S[f.i], b = S[Math.min(S.length - 1, f.i + 1)];
    const u = b.t > a.t ? clamp((f.t - a.t) / (b.t - a.t), 0, 1) : 1;
    const x = lerp(a.x, b.x, u), y = lerp(a.y, b.y, u), z = lerp(a.z, b.z, u);
    this.ballPos = { x, y, z };
    // Events.
    while (f.ev < sim.events.length && sim.events[f.ev].t <= f.t) {
      const e = sim.events[f.ev++];
      if (e.type === 'land') { this.audio.land(e.surface, e.speed); f.landed = true; }
      else if (e.type === 'bounce') this.audio.land(e.surface, e.speed * 0.7);
      else if (e.type === 'tree') this.audio.leaves();
      else if (e.type === 'trunk') this.audio.thunk();
      else if (e.type === 'flag') { this.audio.flag(); this.audio.crowd('ooh', 1); }
      else if (e.type === 'lip') this.audio.rim();
      else if (e.type === 'cup') { this.audio.cup(); }
      else if (e.type === 'splash') this.audio.splash();
      else if (e.type === 'ob') this.audio.thunk();
    }
    // Trail while flying.
    if (!f.landed) { f.trail.push([x, y, z]); if (f.trail.length > 120) f.trail.shift(); }
    else if (f.trail.length) f.trail.shift();
    this.cs.setTrail(f.trail);
    this._camFlight(dt);
    const travelled = Math.hypot(x - this.turn.from.x, z - this.turn.from.z);
    if (CLUBS[this.turn.club].putter) this.hud.distance(`${fmtDist(Math.hypot(x - this.pin.x, z - this.pin.z), true)} to the hole`);
    else this.hud.distance(fmtDist(travelled), f.landed ? '' : 'in the air');
    const p = this.turn.player;
    if (f.t > 0.9 && p.char.anim.pose === 'finish') { /* hold the finish */ }
    if (f.t >= S[S.length - 1].t + 0.6) this._finishFlight();
  }

  _mapBalls() {
    const out = [];
    this.round.players.forEach((rp, i) => {
      if (rp.done) return;
      const p = this.players[i];
      out.push({ x: rp.pos.x, z: rp.pos.z, color: p.colorId, current: this.turn?.player === p });
    });
    return out;
  }

  // ------------------------------------------------------------ cameras

  _camAim(cut = false, dt = 0.016) {
    const t = this.turn;
    if (!t) return;
    const dir = new THREE.Vector3(Math.sin(t.aim), 0, -Math.cos(t.aim));
    const putt = CLUBS[t.club].putter;
    const by = this.hole.heightAt(t.from.x, t.from.z);
    const pos = new THREE.Vector3(), look = new THREE.Vector3();
    if (this.view === 'map') {
      if (putt || ['green', 'fringe'].includes(t.surface)) {
        // Slope view: high over the green.
        const c = { x: (t.from.x + this.pin.x) / 2, z: (t.from.z + this.pin.z) / 2 };
        pos.set(c.x - dir.x * 10, this.hole.heightAt(c.x, c.z) + 16, c.z - dir.z * 10);
        look.set(c.x, this.hole.heightAt(c.x, c.z), c.z);
      } else {
        const marks = this._marks();
        const m = marks[2];
        const mid = { x: (t.from.x + m.x) / 2, z: (t.from.z + m.z) / 2 };
        const span = Math.hypot(m.x - t.from.x, m.z - t.from.z);
        pos.set(mid.x - dir.x * span * 0.55, this.hole.heightAt(mid.x, mid.z) + span * 0.7 + 25, mid.z - dir.z * span * 0.55);
        look.set(m.x, this.hole.heightAt(m.x, m.z), m.z);
      }
    } else if (this.view === 'eye') {
      pos.set(t.from.x - dir.x * 1.2, by + 0.32, t.from.z - dir.z * 1.2);
      look.set(this.pin.x, this.hole.heightAt(this.pin.x, this.pin.z) + 0.1, this.pin.z);
    } else {
      // Behind the ball, a little to the side away from the golfer, so they
      // stand at the left of the picture (right-handed) facing the ball.
      const S = t.player.hand === 'left' ? -1 : 1;
      const right = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(S);
      if (putt) {
        pos.set(t.from.x - dir.x * 3.4 + right.x * 0.7, by + 1.55, t.from.z - dir.z * 3.4 + right.z * 0.7);
        const ahead = Math.min(t.dist, 9);
        look.set(t.from.x + dir.x * ahead + right.x * 0.2, by, t.from.z + dir.z * ahead + right.z * 0.2);
      } else {
        pos.set(t.from.x - dir.x * 4.6 + right.x * 1.15, by + 2.0, t.from.z - dir.z * 4.6 + right.z * 1.15);
        // Look down at what lies ahead (a pond below the tee, a valley) or up a hill.
        const ax = t.from.x + dir.x * 50, az = t.from.z + dir.z * 50;
        const ahead = Math.max(this.hole.heightAt(ax, az), this.hole.waterLevel);
        look.set(t.from.x + dir.x * 34, clamp(Math.min(by + 1.6, ahead + 1.6), by - 6, by + 8), t.from.z + dir.z * 34);
      }
    }
    // Keep the camera above the ground.
    pos.y = Math.max(pos.y, this.hole.heightAt(pos.x, pos.z) + 0.25);
    const k = cut ? 1 : 1 - Math.exp(-dt * 7);
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    this.cs.focusShadow(t.from.x, t.from.z);
  }

  _camFlight(dt) {
    const f = this.flight;
    const sim = this.turn.sim;
    const b = this.ballPos;
    const putt = CLUBS[this.turn.club].putter;
    const rest = sim.samples[sim.samples.length - 1];
    const land = sim.landed || rest;
    const from = this.turn.from;
    const dirToLand = new THREE.Vector3(land.x - from.x, 0, land.z - from.z);
    const span = dirToLand.length();
    dirToLand.normalize();
    const pos = new THREE.Vector3(), look = new THREE.Vector3(b.x, b.y, b.z);
    let k = 1 - Math.exp(-dt * 3.5);
    if (putt || span < 25) {
      // Short shots: stay behind, raised a little.
      pos.set(from.x - dirToLand.x * 4.5, this.hole.heightAt(from.x, from.z) + 2.2 + span * 0.08, from.z - dirToLand.z * 4.5);
    } else {
      const landT = sim.landed ? sim.landed.t : sim.duration;
      const tail = landT - f.t;
      if (tail > 1.3 && !f.landCam) {
        // Chase: behind and above the ball.
        pos.set(b.x - dirToLand.x * 14, b.y + 5, b.z - dirToLand.z * 14);
        pos.y = Math.max(pos.y, this.hole.heightAt(pos.x, pos.z) + 2);
        k = 1 - Math.exp(-dt * 5);
      } else {
        // Landing camera: ahead and to the side of where it comes down.
        if (!f.landCam) {
          const side = new THREE.Vector3(-dirToLand.z, 0, dirToLand.x);
          const lx = land.x + dirToLand.x * 16 + side.x * 9, lz = land.z + dirToLand.z * 16 + side.z * 9;
          f.landCam = new THREE.Vector3(lx, Math.max(this.hole.heightAt(lx, lz), this.hole.waterLevel) + 4.5, lz);
          this.camPos.copy(f.landCam);
        }
        pos.copy(f.landCam);
        k = 1;
      }
    }
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, 1 - Math.exp(-dt * 9));
    this.cs.focusShadow(b.x, b.z);
  }

  _camFlyover() {
    const fly = this.fly;
    const u = clamp(this.phaseT / fly.dur, 0, 1);
    const pts = fly.pts;
    const hole = this.hole;
    // Along the hole's line, high, looking ahead; then back to the tee.
    const along = (s) => {
      const segs = [];
      let total = 0;
      for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); segs.push(l); total += l; }
      let d = s * total;
      for (let i = 0; i < segs.length; i++) {
        if (d <= segs[i] || i === segs.length - 1) { const w = segs[i] ? d / segs[i] : 0; return [lerp(pts[i][0], pts[i + 1][0], w), lerp(pts[i][1], pts[i + 1][1], w)]; }
        d -= segs[i];
      }
      return pts[pts.length - 1];
    };
    const s = smooth(0, 0.85, u);
    const [x, z] = along(s);
    const [lx, lz] = along(Math.min(1, s + 0.18));
    const h = hole.heightAt(x, z);
    this.camPos.set(x - 30 * (1 - s), h + 42 - s * 14, z + 40 * (1 - s) + 10);
    this.camLook.set(lx, hole.heightAt(lx, lz), lz);
    this.cs.focusShadow(x, z);
  }

  _render() {
    if (!this.cs) return;
    if (this.phase === 'flyover') this._camFlyover();
    const cam = this.camera;
    cam.aspect = window.innerWidth / window.innerHeight;
    cam.fov = this.view === 'eye' ? 40 : 50;
    cam.updateProjectionMatrix();
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
    // Balls: every player's (the flying one follows the flight).
    this.round.players.forEach((rp, i) => {
      const p = this.players[i];
      const id = p.seat.key;
      if (rp.done && !(this.phase === 'flight' && this.turn?.player === p)) { this.cs.placeBall(id, p.color, 0, -50, 0, { visible: false }); return; }
      if ((this.phase === 'flight' || (this.phase === 'result' && this.turn?.player === p)) && this.turn?.player === p && this.ballPos) {
        this.cs.placeBall(id, p.color, this.ballPos.x, this.ballPos.y, this.ballPos.z, { visible: this.ballPos.y > this.hole.waterLevel - 0.2 && !(this.turn.sim.result === 'holed' && this.phase === 'result') });
        return;
      }
      const x = rp.pos.x, z = rp.pos.z;
      const teed = !rp.teed;
      this.cs.placeBall(id, p.color, x, this.hole.heightAt(x, z) + 0.065 + (teed ? 0.03 : 0), z, { ring: this.turn?.player !== p });
    });
    // The flag comes out for putts close to the hole.
    this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    this.renderer.render(this.scene, cam);
    // Wind arrow relative to the view.
    const camYaw = Math.atan2(this.camLook.x - this.camPos.x, -(this.camLook.z - this.camPos.z));
    const windYaw = Math.atan2(this.wind[0], -this.wind[2]);
    this.hud.wind(this.windMph, (windYaw - camYaw) * 180 / Math.PI);
  }

  resize() {}

  pause(on) { this.paused = on; }


  // ------------------------------------------------------------ input

  _isController(slot) {
    const p = this.turn?.player;
    if (!p) return false;
    const ctl = this.controllerOf(p);
    return ctl === slot;
  }

  input(msg, seat) {
    if (msg.t === 'btn' && msg.down && msg.b === 'a') {
      if (this.phase === 'flyover') { this.skip = true; return; }
      if (this.phase === 'result' || this.phase === 'card') { this.skip = true; return; }
      if (this.resultsShown && this.ctx.app.isHost(msg.slot)) { this.ctx.app.again(); return; }
    }
    if (this.phase !== 'aim' || !this._isController(msg.slot)) return;
    if (msg.t === 'gclub') {
      this.liveAngle = msg.a;
      this.liveAt = performance.now();
      if (this.turn.player.char.anim.pose === 'address' && Math.abs(msg.a) > 8) this.turn.player.char.setPose('golf');
      this.hud.armed(msg.armed);
      // Live meter: during the downswing, how fast the club is coming.
      if (msg.r < -40) {
        const full = { driver: 980, iron: 920, wedge: 820, putter: 300 }[this.turn.club];
        this.hud.power(Math.min(1.5, -msg.r / full), { over: -msg.r / full > (LIE_CAP[this.turn.surface] ?? 1), ghost: this.turn.practicePower });
      }
      return;
    }
    if (msg.t === 'gswing') {
      if (this._lastSwingId === msg.id) return;
      this._lastSwingId = msg.id;
      this._swing(msg);
      return;
    }
    if (msg.t === 'btn') this._button(msg.b, msg.down);
  }

  _button(b, down) {
    const t = this.turn;
    if (!t) return;
    if (b === 'left' || b === 'right') {
      const dir = b === 'left' ? -1 : 1;
      if (down) {
        this._aimStep(dir);
        clearTimeout(this.held.get(b)?.d); clearInterval(this.held.get(b)?.i);
        const h = { d: setTimeout(() => { h.i = setInterval(() => { if (this.phase === 'aim') this._aimStep(dir); }, 55); }, 300) };
        this.held.set(b, h);
      } else { const h = this.held.get(b); if (h) { clearTimeout(h.d); clearInterval(h.i); } }
      return;
    }
    if (!down) return;
    if (b === 'up' || b === 'down') {
      const i = CLUB_ORDER.indexOf(t.club);
      const ni = clamp(i + (b === 'up' ? -1 : 1), 0, CLUB_ORDER.length - 1);
      if (ni === i) return;
      t.club = CLUB_ORDER[ni];
      t.player.char.setEquipment('club', t.club);
      t.player.char.anim.club.club = t.club;
      this._placeGolfer();
      this._hudClub();
      this.audio.ui('blip');
      this.ctx.app.syncPhones();
    } else if (b === 'one') {
      this.view = this.view === 'map' ? 'normal' : 'map';
      t.player.char.group.visible = true;
      const onGreen = CLUBS[t.club].putter || ['green', 'fringe'].includes(t.surface);
      this.cs.showGrid(this.view === 'map' && onGreen, { x: this.pin.x, z: this.pin.z });
      this.audio.ui('blip');
      this.ctx.app.syncPhones();
    } else if (b === 'two') {
      this.view = this.view === 'eye' ? 'normal' : 'eye';
      // The ball's-eye view is from beside the golfer: hide them while it is on.
      t.player.char.group.visible = this.view !== 'eye';
      this.cs.showGrid(false);
      this.audio.ui('blip');
      this.ctx.app.syncPhones();
    } else if (b === 'a') {
      this.hud.armed(true);
    }
  }

  _aimStep(dir) {
    const t = this.turn;
    t.aim += dir * (CLUBS[t.club].putter ? PUTT_AIM_STEP : AIM_STEP);
    this._placeGolfer();
    this.audio.ui('hover');
  }

  keyDown(e) {
    if (this.resultsShown) {
      if (e.code === 'Enter') this.ctx.app.again();
      if (e.code === 'Escape') this.ctx.app.toLobby();
      return;
    }
    if ((e.code === 'Enter' || e.code === 'Space') && ['flyover', 'result', 'card'].includes(this.phase)) { this.skip = true; e.preventDefault(); return; }
    const kp = this._kbPlayer();
    const t = this.turn;
    if (this.phase !== 'aim' || !t) return;
    const mine = kp === t.player || this.controllerOf(t.player) === 'kb';
    if (!mine) return;
    const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Digit1: 'one', Digit2: 'two' };
    if (map[e.code]) { if (!e.repeat || e.code.startsWith('ArrowL') || e.code.startsWith('ArrowR')) this._button(map[e.code], true); e.preventDefault(); return; }
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      this.kb.space = true;
      this.kb.t0 = performance.now();
      t.player.char.setPose('golf');
    }
  }

  keyUp(e) {
    const map = { ArrowLeft: 'left', ArrowRight: 'right' };
    if (map[e.code]) this._button(map[e.code], false);
    if (e.code === 'Space' && this.kb.space) {
      this.kb.space = false;
      if (this.phase === 'aim') this._swing({ power: this.kb.power || 0.2, curve: 0, practice: false, mode: 'keyboard' });
    }
  }

  // ------------------------------------------------------------ phones

  phoneState(slot) {
    const me = this.players.find((p) => !p.seat.local && p.seat.slot === slot);
    const t = this.turn;
    const out = { kind: 'golf', step: this.phase === 'swing' || this.phase === 'flight' ? 'flight' : this.phase, hole: this.hole?.n, par: this.hole?.par };
    out.wind = `${Math.round(this.windMph || 0)} mph`;
    const rows = this.players.map((p, i) => {
      const rp = this.round.players[i];
      const tot = this.round.totals()[i];
      const run = tot.toPar + (rp.done ? rp.strokes - this.round.par : 0);
      return { name: p.name, color: p.colorId, toPar: toParText(rp.done ? run : tot.toPar), you: p === me, turn: t?.player === p && this.phase === 'aim', status: rp.done ? (rp.gaveUp ? 'gave up' : `holed · ${rp.strokes}`) : `${rp.strokes} shot${rp.strokes === 1 ? '' : 's'}` };
    });
    out.card = rows;
    if (t) {
      const ctlMine = this._isController(slot);
      out.yourTurn = ctlMine;
      out.turnName = t.player.name;
      out.stroke = t.rp.strokes + 1;
      out.club = t.club;
      out.lie = { tee: 'Tee', fairway: 'Fairway', rough: 'Rough', sand: 'Bunker', green: 'Green', fringe: 'Fringe' }[t.surface] || '';
      out.cap = LIE_CAP[t.surface] ?? 1;
      const putt = CLUBS[t.club].putter;
      out.unit = putt ? 'ft' : 'yds';
      out.toPin = putt ? `${Math.max(1, Math.round(t.dist * M_TO_FT))} ft` : `${Math.round(t.dist * M_TO_YD)} yds`;
      out.view1 = this.view === 'map';
      out.view2 = this.view === 'eye';
      out.lastPower = t.lastSwing ? t.lastSwing.power : t.practicePower;
      out.lastOver = t.lastSwing ? t.lastSwing.over > 0.02 : (t.practicePower ?? 0) > out.cap;
      if (ctlMine && t.player.seat.slot !== slot) out.msg = { title: `Playing for ${t.player.name}`, sub: 'Their phone is away' };
      const order = this.round.next();
      out.nextIsYou = me && order === me.index && !ctlMine;
    }
    if (this.phase === 'flyover') out.msg = { title: `Hole ${this.hole.n} · Par ${this.hole.par}`, sub: `${this.hole.yards} yds · tap A to skip` };
    if (this.phase === 'card') out.msg = { title: 'Scorecard', sub: 'Tap A to continue' };
    if (this.phase === 'result' && t) out.msg = { title: t.player === me ? 'Your ball' : `${t.player.name}'s ball`, sub: '' };
    if (this.over && this.resultsShown) {
      const st = this.round.standings();
      const mine = me ? st.find((s) => s.index === me.index) : null;
      out.over = {
        won: mine?.place === 1, title: !mine ? 'Round over' : this.players.length === 1 ? `${toParText(mine.toPar)} · ${mine.strokes} strokes` : mine.place === 1 ? 'You win! 🏆' : `${ordinal(mine.place)} place`,
        sub: this.course.label,
        standings: st.map((s) => ({ place: s.place, placeLabel: ordinal(s.place), name: this.players[s.index].name, value: `${toParText(s.toPar)} (${s.strokes})`, you: me?.index === s.index })),
      };
    }
    return out;
  }

  dispose() {
    for (const h of this.held.values()) { clearTimeout(h.d); clearInterval(h.i); }
    this.audio.ambience(null);
    this.hud.dispose();
    for (const p of this.players) p.char.dispose();
    this.cs?.dispose();
  }
}

function ordinal(n) { return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`; }
void PARS; void scoreName;
