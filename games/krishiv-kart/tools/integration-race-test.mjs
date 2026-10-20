// End-to-end test of RACES (SPEC §14.5–14.7, §15) against the real server, with
// socket.io-client fake phones and the debug handle's autopilot + time scale:
//
//   A. Grand Prix — the Gelato Cup (4 races), 2 phones: cup cards (the host
//      picks the cup, a non-host pick is ignored), race 1 (Breezy Bay): pad
//      input drives the kart, a phone going silent gets a CPU stand-in
//      (padState cpuDriving, HUD badge) and the kart is handed back when it
//      streams again; P1 finishes on autopilot, P2 never does → the 30 s finish
//      clock ends the race (P2 placed with an estimated time); results
//      (+points), standings; races 2–4 on autopilot in the cup's order (each
//      grid = the previous finishing order), standings after every race, the
//      podium (3D blocks + karts) after race 4, lobby.
//   B. VS, 2 phones, items on: a race on each new track (Aldrich Park, Laguna
//      Beach, Krishiv's Palace). On the palace: the hazards are live, a human
//      kart parked under a crusher gets crushed (tumble 'crush' → callout +
//      phone rumble) and a CPU kart at a flame-arm pillar gets burned (spin
//      'fire'). Then Random, points keep adding up, host LOBBY.
//   F. Grand Prix — the Krishiv Cup (5 races, castle finale): host picks the
//      cup, every race on its track in order (--quick: each race cut short with
//      the live classification), standings, podium.
//   G. item events → HUDs / phones (real item uses through items.js): Capo
//      Crusher warning on the leader's view + phone, Espresso Splash on the
//      victims' views + phones, Beer Rocket (FOV kick, phone AUTOPILOT flag).
//   C. leaks: GPU geometries / textures, scene graph, bus listeners and HUD
//      DOM after the sets back in the lobby vs. the lobby before; perf during a
//      live 2P race.
//   D. keyboard solo race: the solo finish rule (results RACE.resultsDelay
//      after the player finishes), results by keyboard, back to the lobby.
//   E. solo race with a late joiner in the room: the racer's phone losing its
//      signal pauses the race.
//
//   node tools/integration-race-test.mjs [--port 3106] [--https-port 3546] [--shots dir] [--only ABFGCDE] [--quick]
//
// Exit code 0 = all checks passed (also fails on page errors / console.error,
// except 404s for racer portraits not rendered yet).
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { io as ioClient } from 'socket.io-client';
import { RACE } from '../public/js/config.js';
import { GP_POINTS } from '../public/js/parts.js';
import * as Tracks from '../public/js/tracks.js';

const { TRACK_LIST } = Tracks;
const CUPS = Array.isArray(Tracks.CUPS) && Tracks.CUPS.length ? Tracks.CUPS : [Tracks.CUP];
const GELATO = CUPS.find((c) => c.id === 'gelato') || CUPS[0];
const KRISHIV = CUPS.find((c) => c.id === 'krishiv') || null;
const NEW_TRACKS = ['aldrich', 'laguna', 'palace'].filter((id) => TRACK_LIST.some((t) => t.id === id));
const THEME = Object.fromEntries(TRACK_LIST.map((t) => [t.id, t.def.theme]));
const POINTS_PER_RACE = GP_POINTS.reduce((a, b) => a + b, 0);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt('port', 3106));
const HTTPS_PORT = Number(opt('https-port', 3546));
const SHOTS = opt('shots', null);
const ONLY = opt('only', 'ABFGCDE').toUpperCase();
const QUICK = args.includes('--quick');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL ${label} ${extra}`); }
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer() {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (server.exitCode !== null) throw new Error(`server exited (${server.exitCode})\n${serverLog}`);
    try { const r = await fetch(`http://localhost:${PORT}/api/info`); if (r.ok) return r.json(); } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not start\n' + serverLog);
}

class FakePad {
  constructor(padId) {
    this.padId = padId;
    this.shared = null; this.pad = null; this.events = []; this.slot = null; this.sock = null; this._timer = null;
    this.inp = { s: 0, g: 0, b: 0, d: 0, i: 0, p: 0 };
  }
  async join(room) {
    const sock = ioClient(`https://localhost:${HTTPS_PORT}`, { transports: ['websocket'], rejectUnauthorized: false, reconnection: false, forceNew: true });
    this.sock = sock;
    sock.on('host:state', (s) => { this.shared = s; });
    sock.on('host:padState', (s) => { this.pad = s; });
    sock.on('host:event', (e) => this.events.push(e));
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('connect_error', rej); });
    const ack = await sock.timeout(3000).emitWithAck('pad:hello', { room, padId: this.padId });
    this.slot = ack && ack.ok ? ack.slot : null;
    return ack;
  }
  menu(action, extra = {}) { this.sock.emit('pad:menu', { action, ...extra }); }
  send() { this.sock.emit('pad:input', { ...this.inp, t: Date.now() }); }
  stream(on = true) { clearInterval(this._timer); this._timer = on ? setInterval(() => this.send(), 33) : null; }
  close() { this.stream(false); if (this.sock) this.sock.close(); this.sock = null; }
}

let browser = null;
const pads = [];
let errors = 0;
const errorLines = [];

try {
  await waitForServer();
  console.log(`server up: http ${PORT} / https ${HTTPS_PORT}`);
  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    acceptInsecureCerts: true,
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  let console404 = 0, portrait404 = 0;
  page.on('response', (r) => {
    if (r.status() !== 404) return;
    if (/\/img\/racers\/[a-z0-9_-]+\.png$/.test(r.url())) portrait404++;
    else { errors++; errorLines.push(`404 ${r.url()}`); }
  });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') {
      if (/Failed to load resource.*404/.test(t)) { console404++; return; }
      errors++; errorLines.push(t);
    }
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [console.${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => { errors++; errorLines.push(e.message); console.log(`  [pageerror] ${e.message}`); });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

  const G = (expr) => page.evaluate(expr);
  const waitFor = async (expr, ms = 6000) => {
    const t0 = Date.now();
    let v;
    while (Date.now() - t0 < ms) { v = await G(expr); if (v) return v; await sleep(80); }
    return v;
  };
  const waitState = async (want, ms = 8000) => (await waitFor(`window.__game && window.__game.state === ${JSON.stringify(want)}`, ms)) === true;
  // screens cross-fade for ~0.35 s: settle before a screenshot
  const shot = async (name) => { if (SHOTS) { await sleep(700); await page.screenshot({ path: path.join(SHOTS, name) }); } };
  const padWait = async (pd, fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn(pd)) return true; await sleep(50); } return false; };

  check(await waitState('lobby', 20000), 'reaches the lobby');
  let room = null;
  for (let i = 0; i < 80 && !room; i++) { room = await G('window.__game.phone.room'); if (!room) await sleep(100); }
  check(/^[A-Z]{4}$/.test(room || ''), `room ${room}`);
  await sleep(800);
  const baseline = await G('__game.leaks()');
  const chars = (await G('__game.sharedState().characters')).filter((c) => !c.custom).map((c) => c.id);

  // everyone picks + readies (host = first pad)
  async function pickAll(list, picks) {
    for (let k = 0; k < list.length; k++) list[k].menu('char', { id: picks[k].char });
    await sleep(200);
    for (let k = 0; k < list.length; k++) list[k].menu('body', { id: picks[k].body });
    await sleep(150);
    for (let k = 0; k < list.length; k++) list[k].menu('wheels', { id: picks[k].wheels });
    await sleep(150);
    for (const pd of list) pd.menu('ready', { value: true });
  }
  // a race on autopilot at 8× until the results screen
  async function autoRace(label, ms = 120000) {
    await G('__game.skipIntro()');
    await G('__game.setTimeScale(8)');
    await G('__game.autopilot(true)');
    const ok = await waitState('results', ms);
    await G('__game.setTimeScale(1)');
    check(ok, `${label}: finished → results`);
    return ok;
  }
  // --quick: a few seconds on autopilot, then the results with the live classification
  async function shortRace(label, ms = 3000) {
    await G('__game.skipIntro()');
    await G('__game.setTimeScale(4)');
    await G('__game.autopilot(true)');
    await sleep(ms);
    await G('__game.setTimeScale(1)');
    await G('__game.endRace()');
    const ok = await waitState('results', 5000);
    check(ok, `${label}: (quick) → results`);
    return ok;
  }
  const runRace = (label) => (QUICK ? shortRace(label) : autoRace(label));
  const vibes = (pd) => pd.events.filter((e) => e.type === 'vibrate').map((e) => JSON.stringify(e.pattern));

  let P1 = null, P2 = null;
  if (ONLY.includes('A') || ONLY.includes('B') || ONLY.includes('C')) {
    P1 = new FakePad('rtest-pad-1'); P2 = new FakePad('rtest-pad-2');
    pads.push(P1, P2);
    await P1.join(room); await P2.join(room);
    check(await waitFor('__game.players.length === 2 && __game.host === 1'), 'two phones joined (host P1)');
  }

  // ================================================================ A. Grand Prix — Gelato Cup
  if (ONLY.includes('A')) {
    console.log(`\n# A. Grand Prix — ${GELATO.name}, ${GELATO.tracks.length} races (2 phones)`);
    P1.menu('mode', { value: 'gp' }); P1.menu('cc', { value: 50 });
    await waitFor(`__game.mode === 'gp' && __game.cc === 50`);
    P1.menu('start');
    check(await waitState('select'), 'START → select');
    await pickAll([P1, P2], [{ char: chars[1], body: 'rocket', wheels: 'slick' }, { char: chars[9], body: 'standard', wheels: 'offroad' }]);
    check(await waitState('track'), 'all ready → the cup screen');
    if (KRISHIV) {
      P2.menu('cup', { id: KRISHIV.id });
      await sleep(300);
      check((await G('__game.cup.id')) === GELATO.id, 'non-host cup pick ignored');
      P1.menu('cup', { id: KRISHIV.id });
      check(await waitFor(`__game.cup.id === ${JSON.stringify(KRISHIV.id)} && document.querySelectorAll('.tk-tile').length === ${KRISHIV.tracks.length}`),
        `host picks the ${KRISHIV.name} (${KRISHIV.tracks.length} tiles)`);
      check(await padWait(P2, (p) => p.shared && p.shared.cup && p.shared.cup.id === KRISHIV.id && p.shared.races === KRISHIV.tracks.length), 'phones see the chosen cup + its race count');
      P1.menu('cup', { id: GELATO.id });
    }
    check(await waitFor(`__game.cup.id === ${JSON.stringify(GELATO.id)} && document.querySelectorAll('.tk-tile').length === ${GELATO.tracks.length} && /${GELATO.name}/i.test(document.querySelector('.tk-track-title').textContent)`),
      `${GELATO.name} card lists its ${GELATO.tracks.length} tracks`);
    check(await G(`document.querySelectorAll('.tk-cup').length === ${CUPS.length} && !!document.querySelector('.tk-cup.is-on')`), `desktop shows ${CUPS.length} cup cards, the chosen one lit`);
    check(await padWait(P1, (p) => p.shared && Array.isArray(p.shared.cups) && p.shared.cups.length === CUPS.length
      && p.shared.cups.every((c, i) => c.id === CUPS[i].id && c.tracks.length === CUPS[i].tracks.length)), 'host:state cups (every cup + its tracks)');
    await shot('A1-cup.png');
    P2.menu('go');
    await sleep(300);
    check((await G('__game.state')) === 'track', 'non-host GO ignored');
    P1.menu('go');
    check(await waitState('race', 15000), 'GO → race 1');
    check((await G('__game.trackId')) === GELATO.tracks[0] && (await G('__game.raceNo')) === 1, `race 1 = ${GELATO.tracks[0]}`);
    check(await padWait(P1, (p) => p.shared && p.shared.screen === 'race' && p.shared.raceNo === 1 && p.shared.races === GELATO.tracks.length && p.shared.track && p.shared.track.id === GELATO.tracks[0]),
      'host:state race / raceNo / races / track');
    const grid1 = await G('__game.humans');
    check(grid1.map((h) => h.grid).join() === '6,7', `humans in the last 2 grid slots, P1 ahead (${grid1.map((h) => h.grid)})`);

    // ---- pad input drives the kart
    P1.stream(true); P2.stream(true);
    await G('__game.skipIntro()');
    check(await waitFor(`__game.race && __game.race.state === 'racing'`, 8000), 'countdown → racing');
    check(await padWait(P1, (p) => p.pad && p.pad.race && p.pad.race.state === 'racing' && p.pad.race.laps === RACE.laps && p.pad.race.racers === RACE.racers),
      'P1 padState race fields');
    P1.inp.g = 1; P1.inp.s = 0.2;
    await sleep(1600);
    const k1 = await G(`(() => { const k = __game.karts.find((k) => k.slot === 1); return { speed: k.speed, steer: k.input.steer }; })()`);
    check(k1.speed > 6 && Math.abs(k1.steer - 0.2) < 1e-6, `pad gas + steer drive P1 (${k1.speed.toFixed(1)} m/s, steer ${k1.steer})`);
    check(await padWait(P1, (p) => p.events.some((e) => e.type === 'vibrate'), 3000), 'phones get vibrate events');

    // ---- a silent phone → CPU stand-in, then handed back
    P2.stream(false);
    check(await waitFor(`__game.humans.find((h) => h.slot === 2).ai === true`, 5000), 'P2 silent → CPU drives P2 (≥ 2 humans: no pause)');
    check(!(await G('__game.paused')), 'no global pause');
    check(await padWait(P2, (p) => p.pad && p.pad.race && p.pad.race.cpuDriving === true, 3000), 'P2 padState cpuDriving');
    check(await G(`[...document.querySelectorAll('.hud-phone-text')].some((t) => /CPU IS DRIVING/.test(t.textContent))`), 'P2 view shows the CPU-driving badge');
    await shot('A2-takeover.png');
    P2.stream(true);
    check(await waitFor(`__game.humans.find((h) => h.slot === 2).ai === false`, 4000), 'P2 streams again → kart handed back');
    // ---- finish clock: P1 on autopilot, P2 stays (gas off) behind
    P2.inp.g = 0; P2.inp.s = 0;
    await G('__game.setTimeScale(8)');
    await G('__game.autopilot(true, 1)');
    check(await waitFor(`__game.humans.find((h) => h.slot === 1).finished`, 90000), 'P1 finishes');
    check(await padWait(P2, (p) => p.pad && p.pad.race && p.pad.race.finishClock > 0, 4000), `P2 padState finishClock (${P2.pad && P2.pad.race && P2.pad.race.finishClock})`);
    check(await waitState('results', 30000), 'finish clock runs out → results');
    await G('__game.setTimeScale(1)');
    const res1 = await G('__game.results');
    check(res1.length === RACE.racers && res1.every((r, i) => r.place === i + 1 && r.points === GP_POINTS[i]), 'results: 8 rows, GP points 10-8-6-5-4-3-2-1');
    const p2row = res1.find((r) => r.slot === 2);
    check(p2row && p2row.finished === false && Number.isFinite(p2row.time), 'P2 placed by running order with an estimated time');
    check(await padWait(P1, (p) => p.shared && p.shared.screen === 'results' && Array.isArray(p.shared.results) && p.shared.results.length === RACE.racers), 'phones get the results');
    check(await G(`document.querySelectorAll('.tk-results .tk-res-row:not(.tk-res-headrow)').length === ${RACE.racers}`), 'results table on the desktop');
    check(await G(`/Race 1 of ${GELATO.tracks.length}/.test(document.querySelector('.tk-results .tk-res-sub').textContent)`), `results say "Race 1 of ${GELATO.tracks.length}"`);
    await shot('A3-results-1280.png');
    await page.setViewport({ width: 1920, height: 1080 }); await sleep(600); await shot('A3-results-1920.png'); await page.setViewport({ width: 1280, height: 720 }); await sleep(300);
    P2.menu('next');
    await sleep(250);
    check((await G('__game.state')) === 'results', 'non-host NEXT ignored');
    P1.menu('next');
    check(await waitState('standings'), 'NEXT → standings');
    const std1 = await G('__game.standings');
    check(std1.length === RACE.racers && std1.every((r, i) => i === 0 || r.points <= std1[i - 1].points), 'standings sorted by points');
    check(await padWait(P2, (p) => p.pad && p.pad.standing && p.pad.standing.place >= 1), 'P2 padState standing');
    await shot('A4-standings.png');

    // ---- races 2..N of the cup on autopilot (8×), standings after each, podium after the last
    let prevOrder = res1.map((r) => r.name);
    for (let n = 2; n <= GELATO.tracks.length; n++) {
      const want = GELATO.tracks[n - 1];
      P1.menu('next');
      check(await waitState('race', 20000), `NEXT → race ${n}`);
      check((await G('__game.trackId')) === want && (await G('__game.raceNo')) === n, `race ${n} = ${want}`);
      const names = await G('__game.karts.map((k) => k.character.name)');
      check(names.join('|') === prevOrder.join('|'), `race ${n} grid = race ${n - 1} finishing order`, `${names.join(',')} vs ${prevOrder.join(',')}`);
      if (n === 2) check((await G('__game.grid')).every((g) => g.ccMult === 0.8), '50cc engine class on every kart');
      check(await padWait(P2, (p) => p.shared && p.shared.raceNo === n && p.shared.track && p.shared.track.id === want), `phones: race ${n} of ${GELATO.tracks.length} on ${want}`);
      if (n === GELATO.tracks.length) await shot(`A5-race${n}-${want}.png`);
      await autoRace(`race ${n} (${want})`);
      const resN = await G('__game.results');
      prevOrder = resN.map((r) => r.name);
      P1.menu('next');
      check(await waitState('standings'), `standings after race ${n}`);
      const stdN = await G('__game.standings');
      const total = stdN.reduce((a, r) => a + r.points, 0);
      check(total === n * POINTS_PER_RACE, `points add up over ${n} races (${total})`);
      if (n < GELATO.tracks.length) check(/next race/i.test(await G('__game.sharedState().status')), 'status: NEXT for the next race');
      else check(/trophy/i.test(await G('__game.sharedState().status')), 'status: NEXT for the trophy');
    }
    P1.menu('next');
    check(await waitState('podium', 8000), `race ${GELATO.tracks.length} → podium`);
    const pod = await G('__game.podium');
    check(pod && pod.length === 3 && pod[0].points >= pod[1].points && pod[1].points >= pod[2].points, 'podium: top 3 by points');
    check(await G(`!!__game.scene.getObjectByName('Podium') && __game.scene.getObjectByName('Podium').children.length >= 6`), '3D podium with blocks + karts');
    check(await G(`new RegExp(${JSON.stringify(GELATO.name)}).test(document.querySelector('.tk-pod-kicker').textContent)`), 'podium names the cup');
    await sleep(1500);
    await shot('A6-podium-1280.png');
    await page.setViewport({ width: 1920, height: 1080 }); await sleep(700); await shot('A6-podium-1920.png'); await page.setViewport({ width: 1280, height: 720 }); await sleep(300);
    check(await padWait(P1, (p) => p.shared && p.shared.screen === 'podium'), 'phones on the podium screen');
    P1.menu('next');
    check(await waitState('lobby'), 'podium NEXT → lobby');
    check(!(await G(`!!__game.scene.getObjectByName('Podium')`)), 'podium removed');
  }

  // ================================================================ B. VS on every new track (+ palace hazards)
  if (ONLY.includes('B')) {
    console.log(`\n# B. VS races on ${NEW_TRACKS.join(', ')} + Random (2 phones, items on)`);
    P1.menu('mode', { value: 'vs' }); P1.menu('items', { value: true }); P1.menu('cc', { value: 100 });
    await waitFor(`__game.mode === 'vs' && __game.items === true && __game.cc === 100`);
    P1.menu('start');
    await waitState('select');
    await pickAll([P1, P2], [{ char: chars[2], body: 'feather', wheels: 'tiny' }, { char: chars[6], body: 'speedster', wheels: 'neon' }]);
    check(await waitState('track'), 'VS track screen');
    check(await G(`document.querySelectorAll('.tk-tile').length === ${TRACK_LIST.length + 1} && document.querySelectorAll('.tk-cup').length === 0`), `VS: ${TRACK_LIST.length} track tiles + Random, no cup cards`);
    await shot('B0-vs-tracks.png');
    let vsRaces = 0;
    for (const id of NEW_TRACKS) {
      P1.menu('track', { value: id });
      check(await waitFor(`__game.trackPick === ${JSON.stringify(id)}`), `host picks ${id}`);
      P1.menu('go');
      check(await waitState('race', 20000), `VS ${id}: race`);
      vsRaces++;
      check((await G('__game.trackId')) === id && (await G('__game.track.theme')) === THEME[id], `VS ${id}: track + theme ${THEME[id]}`);
      check(await G('!!__game.R.items && !!__game.world'), `VS ${id}: items on, world built`);
      P1.stream(true); P2.stream(true);
      if (id === 'palace') {
        // ---- hazards (SPEC §15.3): live in the race, crush → tumble, fire → spin
        const hz = await G(`(() => { const h = __game.hazards; return h && Array.isArray(h.list) ? h.list.map((x) => ({ type: x.type, s: x.s, lateral: x.lateral })) : null; })()`);
        check(hz && hz.some((h) => h.type === 'crusher') && hz.some((h) => h.type === 'flamearm'), `palace hazards live (${hz ? hz.map((h) => h.type).join(',') : 'none'})`);
        await G('__game.skipIntro()');
        check(await waitFor(`__game.race && __game.race.state === 'racing'`, 8000), 'palace: racing');
        const t0 = await G('__game.hazards.time');
        await sleep(600);
        check((await G('__game.hazards.time')) > t0, 'hazard clock runs with the race');
        // P2 (human, no gas) parked under the first crusher until it slams down
        const ev0 = P2.events.length;
        const crush = await G(`new Promise((resolve) => {
          const g = __game, R = g.R, tr = g.track;
          const h = R.hazards.list.find((x) => x.type === 'crusher');
          const k = R.karts.find((x) => x.slot === 2);
          const p = tr.pointAt(h.s, h.lateral);
          const f = tr.frameAt(h.s);
          k.placeOnGrid({ position: p, yaw: f.yaw });
          const hits = [];
          const off = g.bus.on('kart:tumble', (e) => { if (e.kart === k) hits.push(e.cause); });
          const t0 = performance.now();
          const iv = setInterval(() => {
            if (hits.length) { clearInterval(iv); off(); resolve({ hits, tumble: k.tumbleTimer }); return; }
            if (performance.now() - t0 > 7000) { clearInterval(iv); off(); resolve({ hits, tumble: k.tumbleTimer, timeout: true }); return; }
            k.position.x = p.x; k.position.z = p.z; k.velocity.set(0, 0, 0);
          }, 16);
        })`);
        check(crush.hits.includes('crush') && crush.tumble > 0, `kart parked under a crusher gets crushed (${JSON.stringify(crush)})`);
        check(await G(`[...document.querySelectorAll('.hud')].some((h) => /SQUASHED/.test(h.textContent))`), 'crushed player sees SQUASHED!');
        check(await padWait(P2, (p) => p.events.slice(ev0).some((e) => e.type === 'vibrate' && JSON.stringify(e.pattern) === '[260,50,160]'), 3000), 'crushed player\'s phone rumbles (crush pattern)');
        await shot('B1-palace-crush.png');
        // a CPU kart at a flame-arm pillar gets burned (spin 'fire')
        const fire = await G(`new Promise((resolve) => {
          const g = __game, R = g.R, tr = g.track;
          const h = R.hazards.list.find((x) => x.type === 'flamearm');
          const k = R.karts.find((x) => !x.isPlayer && !x.finished && x.isHittable());
          const lat = h.lateral - Math.sign(h.lateral || 1) * 1.5;      // beside the pillar, road side
          const p = tr.pointAt(h.s, lat);
          k.placeOnGrid({ position: p, yaw: tr.frameAt(h.s).yaw });
          const hits = [];
          const off = g.bus.on('kart:spin', (e) => { if (e.kart === k) hits.push(e.cause); });
          const t0 = performance.now();
          const iv = setInterval(() => {
            if (hits.length || performance.now() - t0 > 4000) { clearInterval(iv); off(); resolve({ hits, spin: k.spinTimer }); return; }
            k.position.x = p.x; k.position.z = p.z; k.velocity.set(0, 0, 0);
          }, 16);
        })`);
        check(fire.hits.includes('fire'), `kart at a flame-arm pillar gets burned (${JSON.stringify(fire)})`);
      }
      await runRace(`VS ${id}`);
      if (vsRaces === 1) {
        P1.menu('next');
        check(await waitState('standings'), 'VS standings');
        P1.menu('next');
        check(await waitState('track'), 'VS NEXT → track screen again');
        check((await G('__game.raceNo')) === 1, 'raceNo kept for the session');
      } else {
        P1.menu('next'); await waitState('standings');
        P1.menu('next'); await waitState('track');
      }
    }
    P1.menu('track', { value: 'random' });
    await sleep(150);
    P1.menu('go');
    check(await waitState('race', 20000), 'VS race (Random)');
    vsRaces++;
    const tid = await G('__game.trackId');
    check(TRACK_LIST.some((t) => t.id === tid), `random → ${tid}`);
    check(NEW_TRACKS.length === 0 || tid !== NEW_TRACKS[NEW_TRACKS.length - 1], 'Random never repeats the track just raced');
    await runRace('VS Random');
    const std = await G('__game.standings');
    check(std.reduce((a, r) => a + r.points, 0) === vsRaces * POINTS_PER_RACE, `VS points keep adding up (${vsRaces} races)`);
    P1.menu('quit');
    check(await waitState('lobby'), 'VS LOBBY (quit) → lobby');
  }

  // ================================================================ F. Grand Prix — Krishiv Cup
  if (ONLY.includes('F') && KRISHIV) {
    console.log(`\n# F. Grand Prix — ${KRISHIV.name}, ${KRISHIV.tracks.length} races${QUICK ? ' (quick)' : ''}`);
    P1.menu('mode', { value: 'gp' }); P1.menu('cc', { value: 150 });
    await waitFor(`__game.mode === 'gp' && __game.cc === 150`);
    P1.menu('start');
    await waitState('select');
    await pickAll([P1, P2], [{ char: chars[3], body: 'standard', wheels: 'standard' }, { char: chars[7], body: 'buggy', wheels: 'offroad' }]);
    check(await waitState('track'), 'cup screen');
    P1.menu('cup', { id: KRISHIV.id });
    check(await waitFor(`__game.cup.id === ${JSON.stringify(KRISHIV.id)}`), `host picks the ${KRISHIV.name}`);
    check(await G(`/castle finale/.test(document.querySelector('.tk-track-sub').textContent)`), 'cup card: castle finale');
    await shot('F1-krishiv-cup.png');
    P1.menu('go');
    for (let n = 1; n <= KRISHIV.tracks.length; n++) {
      const want = KRISHIV.tracks[n - 1];
      check(await waitState('race', 20000), `race ${n} starts`);
      check((await G('__game.trackId')) === want && (await G('__game.raceNo')) === n, `race ${n} of ${KRISHIV.tracks.length} = ${want}`);
      if (n === 1) {
        // the cup is locked once it started
        P1.menu('cup', { id: GELATO.id });
        await sleep(200);
        check((await G('__game.cup.id')) === KRISHIV.id, 'cup locked after race 1 starts');
      }
      P1.stream(true); P2.stream(true);
      await runRace(`${KRISHIV.name} race ${n} (${want})`);
      check(await G(`/Race ${n} of ${KRISHIV.tracks.length}/.test(document.querySelector('.tk-results .tk-res-sub').textContent)`), `results: Race ${n} of ${KRISHIV.tracks.length}`);
      P1.menu('next');
      check(await waitState('standings'), `standings after race ${n}`);
      const total = (await G('__game.standings')).reduce((a, r) => a + r.points, 0);
      check(total === n * POINTS_PER_RACE, `points after ${n} races (${total})`);
      P1.menu('next');
    }
    check(await waitState('podium', 8000), `${KRISHIV.name} → podium after ${KRISHIV.tracks.length} races`);
    check(await G(`new RegExp(${JSON.stringify(KRISHIV.name)}).test(document.querySelector('.tk-pod-kicker').textContent)`), 'podium names the Krishiv Cup');
    await sleep(1200);
    await shot('F2-krishiv-podium.png');
    P1.menu('next');
    check(await waitState('lobby'), 'podium → lobby');
    P1.menu('cup', { id: GELATO.id });          // leave the default for later sets
  }

  // ================================================================ G. item events → HUDs / phones
  if (ONLY.includes('G')) {
    console.log('\n# G. item events → HUDs / phones (real item uses)');
    P1.menu('mode', { value: 'vs' }); P1.menu('items', { value: true }); P1.menu('cc', { value: 100 });
    await waitFor(`__game.mode === 'vs' && __game.items === true`);
    P1.menu('start');
    await waitState('select');
    await pickAll([P1, P2], [{ char: chars[0], body: 'standard', wheels: 'standard' }, { char: chars[5], body: 'standard', wheels: 'standard' }]);
    await waitState('track');
    P1.menu('track', { value: 'breezy' });
    await sleep(150);
    P1.menu('go');
    check(await waitState('race', 15000), 'item race');
    P1.inp.g = 1; P1.inp.s = 0; P2.inp.g = 1; P2.inp.s = 0;
    P1.stream(true); P2.stream(true);
    await G('__game.skipIntro()');
    check(await waitFor(`__game.race && __game.race.state === 'racing'`, 8000), 'racing');
    await sleep(1500);
    // P2 takes the lead (moved 40 m past the leader, then on autopilot); P1 stays at the back
    const lead = await G(`(() => {
      const g = __game, R = g.R, tr = g.track;
      const k2 = R.karts.find((k) => k.slot === 2);
      const top = R.karts.reduce((a, k) => (k.distance > a.distance ? k : a), R.karts[0]);
      const s = tr.wrapS(tr.project(top.position, -1, {}).s + 40);
      k2.placeOnGrid({ position: tr.pointAt(s, 0), yaw: tr.frameAt(s).yaw });
      return true;
    })()`);
    await G('__game.autopilot(true, 2)');
    check(lead && await waitFor(`__game.karts.find((k) => k.slot === 2).place === 1`, 3000), 'P2 leads the race');
    const use = (id) => G(`(() => { const R = __game.R, k = R.karts.find((x) => x.slot === 1); k.item = ${JSON.stringify(id)}; k.itemCount = 1; k.rolling = false; return R.items.useItem(k); })()`);
    const hudText = (slot) => G(`(() => { const v = __game.R.views.find((x) => x.h && x.h.slot === ${slot}); return v && v.hud.el ? v.hud.el.textContent : ''; })()`);
    const rec = await G(`(() => { const out = window.__evlog = []; const B = __game.bus;
      for (const t of ['item:capoLaunch', 'item:capoWarning', 'item:capoHit', 'item:capoFizzle', 'item:espresso', 'item:espressoSplash', 'item:accordion', 'item:beerStart', 'item:beerRide', 'item:beerEnd', 'item:bombExplode'])
        window.__evoff = (window.__evoff || []).concat(B.on(t, (e) => out.push({ t, kart: e.kart && e.kart.slot, target: e.target && e.target.slot, victims: (e.victims || []).map((v) => v.slot ?? 'cpu'), dodged: !!e.dodged })));
      return true; })()`);
    void rec;

    // ---- Capo Crusher: P1 fires it, the leader (P2) gets the siren on its view + phone, then the slam
    const ev2 = P2.events.length;
    check(await use('capo'), 'P1 fires a Capo Crusher');
    check(await waitFor(`window.__evlog.some((e) => e.t === 'item:capoLaunch' && e.kart === 1 && e.target === 2)`, 2000), 'item:capoLaunch → the leader (P2)');
    check(await padWait(P2, (p) => p.pad && p.pad.race && p.pad.race.warn === 'capo' && p.pad.race.capoWarn === true, 3000), 'P2 phone: padState race.warn = capo');
    check(await waitFor(`__game.karts.find((k) => k.slot === 2).capoWarn > 0`, 2000), 'P2 kart flagged (capoWarn)');
    await shot('G1-capo-warning.png');
    await G('__game.setTimeScale(2)');
    check(await waitFor(`window.__evlog.some((e) => e.t === 'item:capoHit' || e.t === 'item:capoFizzle')`, 20000), 'the Capo Crusher lands (or fizzles)');
    await G('__game.setTimeScale(1)');
    const capoEnd = await G(`window.__evlog.filter((e) => e.t === 'item:capoHit' || e.t === 'item:capoFizzle')`);
    if (capoEnd.some((e) => e.t === 'item:capoHit' && e.kart === 2 && !e.dodged)) {
      check(/CRUSHED/.test(await hudText(2)), 'P2 view: CRUSHED!');
      check(await padWait(P2, (p) => p.events.slice(ev2).some((e) => e.type === 'vibrate' && JSON.stringify(e.pattern) === '[320,60,140,60,320]'), 3000), 'P2 phone: capo hit rumble');
      check(/BULLSEYE/.test(await hudText(1)), 'P1 view: BULLSEYE!');
    } else {
      console.log(`  (capo ended as ${JSON.stringify(capoEnd)}: hit checks skipped)`);
    }
    check(await padWait(P2, (p) => p.pad && p.pad.race && !p.pad.race.warn, 4000), 'P2 phone: warning cleared after the capo');

    // ---- Espresso Splash: P1 (behind) splashes everybody ahead, P2's view + phone
    await sleep(2200);                          // P2 back on its wheels
    check(await use('espresso'), 'P1 uses an Espresso Splash');
    check(await waitFor(`window.__evlog.some((e) => e.t === 'item:espresso' && e.kart === 1 && e.victims.includes(2))`, 2000), 'item:espresso victims include P2');
    check(await padWait(P2, (p) => p.pad && p.pad.race && p.pad.race.splash > 0, 3000), 'P2 phone: padState race.splash');
    check(await waitFor(`__game.karts.find((k) => k.slot === 2).ink > 0`, 3000), 'coffee on P2 (kart.ink)');
    check(/ESPRESSO SPLASH/.test(await hudText(1)), 'P1 view: ESPRESSO SPLASH!');
    await sleep(400);
    await shot('G2-espresso.png');

    // ---- Accordion Blast + Meatball Bomb: rumble on P1's phone, events fire
    const ev1 = P1.events.length;
    check(await use('accordion'), 'P1 uses an Accordion Blast');
    check(await waitFor(`window.__evlog.some((e) => e.t === 'item:accordion' && e.kart === 1)`, 2000), 'item:accordion');
    check(await padWait(P1, (p) => p.events.slice(ev1).some((e) => e.type === 'vibrate' && JSON.stringify(e.pattern) === '[60,30,60]'), 3000), 'P1 phone: accordion rumble');
    check(await use('meatball_bomb'), 'P1 throws a Meatball Bomb');
    check(await waitFor(`window.__evlog.some((e) => e.t === 'item:bombExplode')`, 8000), 'item:bombExplode');

    // ---- Beer Rocket: P1 chugs, rides (FOV kick, phone AUTOPILOT flag), pops out
    const ev1b = P1.events.length;
    check(await use('beer_rocket'), 'P1 starts a Beer Rocket');
    check(await waitFor(`window.__evlog.some((e) => e.t === 'item:beerStart' && e.kart === 1)`, 2000), 'item:beerStart');
    check(await padWait(P1, (p) => p.pad && p.pad.race && p.pad.race.beer === true, 3000), 'P1 phone: padState race.beer');
    check(/BEER ROCKET/.test(await hudText(1)), 'P1 view: BEER ROCKET!');
    check(await waitFor(`(__game.R.views.find((v) => v.h && v.h.slot === 1).fovKick || 0) > 5`, 4000), 'P1 view: FOV kick while riding');
    await shot('G3-beer-ride.png');
    check(await waitFor(`window.__evlog.some((e) => e.t === 'item:beerEnd' && e.kart === 1)`, 15000), 'item:beerEnd');
    check(await padWait(P1, (p) => p.pad && p.pad.race && !p.pad.race.beer && p.events.slice(ev1b).some((e) => e.type === 'vibrate' && JSON.stringify(e.pattern) === '[80]'), 4000), 'P1 phone: beer flag off + pop rumble');
    check(await waitFor(`(__game.R.views.find((v) => v.h && v.h.slot === 1).fovKick || 0) < 0.5`, 4000), 'P1 view: FOV back to normal');
    await G(`(window.__evoff || []).forEach((off) => off()); window.__evoff = []; true`);
    await G('__game.autopilot(false, 2)');
    P1.menu('pause'); await waitFor('__game.paused'); P1.menu('quit');
    check(await waitState('lobby'), 'item race → lobby');
  }

  // ================================================================ C. leaks + perf
  if (ONLY.includes('C')) {
    console.log('\n# C. leaks + 2P perf');
    await sleep(800);
    const after = await G('__game.leaks()');
    console.log(`  baseline ${JSON.stringify(baseline)}\n  after    ${JSON.stringify(after)}`);
    check(after.listeners === baseline.listeners, `bus listeners flat (${baseline.listeners} → ${after.listeners})`);
    check(after.huds === 0, 'no HUD DOM left');
    check(after.sceneChildren <= baseline.sceneChildren + 1, `scene children flat (${baseline.sceneChildren} → ${after.sceneChildren})`);
    // the lobby world may be the last track's: compare against a 2nd lap of the same world.
    // The CPU field is pinned so both sets race the same karts (the kart-model
    // geometry cache keeps idle models of other racers on purpose, up to its limit).
    await G('__game.pinSeed(4242)');
    const kartCache = () => G(`import('/js/characters.js').then((m) => m.kartModelCacheInfo())`);
    P1.menu('mode', { value: 'vs' });
    P1.menu('start');
    await waitState('select');
    await pickAll([P1, P2], [{ char: chars[0], body: 'standard', wheels: 'standard' }, { char: chars[3], body: 'standard', wheels: 'standard' }]);
    await waitState('track');
    P1.menu('track', { value: TRACK_LIST[0].id });
    await sleep(100);
    P1.menu('go');
    await waitState('race', 15000);
    P1.stream(true); P2.stream(true);
    await G('__game.skipIntro()');
    await G('__game.autopilot(true)');
    await sleep(6000);
    const st = await G('__game.stats()');
    console.log(`  perf 2P: ${st.fps} fps, cpu ${st.frameCpuMs} ms (max ${st.frameCpuMaxMs}), ${st.calls} calls, ${st.triangles} tris`);
    check(st.fps >= 50, `2P race ≥ 50 fps headless (${st.fps})`);
    check(st.calls < 400, `2P draw calls (${st.calls})`);
    P1.menu('pause'); await waitFor('__game.paused'); P1.menu('quit');
    await waitState('lobby');
    await sleep(500);
    const lap1 = await G('__game.leaks()');
    const cache1 = await kartCache();
    P1.menu('start');
    await waitState('select');
    await pickAll([P1, P2], [{ char: chars[0], body: 'standard', wheels: 'standard' }, { char: chars[3], body: 'standard', wheels: 'standard' }]);
    await waitState('track');
    P1.menu('go');
    await waitState('race', 15000);
    await G('__game.skipIntro()');
    await sleep(2500);
    P1.menu('pause'); await waitFor('__game.paused'); P1.menu('quit');
    await waitState('lobby');
    await sleep(500);
    const lap2 = await G('__game.leaks()');
    const cache2 = await kartCache();
    await G('__game.pinSeed(null)');
    console.log(`  same track twice: ${JSON.stringify(lap1)} → ${JSON.stringify(lap2)}`);
    console.log(`  kart model cache: ${JSON.stringify(cache1)} → ${JSON.stringify(cache2)}`);
    check(cache2.live === 0 && cache2.entries === cache1.entries, 'kart model cache: nothing live after the race, no new entries for the same field');
    check(lap2.geometries <= lap1.geometries + 2 && lap2.textures <= lap1.textures + 1, 'GPU geometries / textures flat across races');
    check(lap2.objects === lap1.objects && lap2.listeners === lap1.listeners, 'scene graph + listeners flat across races');
  }

  // ================================================================ D. keyboard solo
  if (ONLY.includes('D')) {
    console.log('\n# D. keyboard solo race');
    for (const pd of pads) pd.close();
    await waitFor('__game.players.every((p) => !p.connected)');
    await page.focus('canvas#game');
    await page.keyboard.press('Enter');
    check(await waitFor('__game.keyboard === true'), 'keyboard mode');
    await G(`__game.action(1, 'mode', { value: 'vs' })`);
    await G(`__game.action(1, 'start')`);
    await waitState('select');
    for (const [a, p] of [['char', { id: chars[4] }], ['body', { id: 'buggy' }], ['wheels', { id: 'standard' }], ['ready', { value: true }]]) { await G(`__game.action(1, '${a}', ${JSON.stringify(p)})`); await sleep(80); }
    check(await waitState('track'), 'keyboard → track');
    await page.keyboard.press('Enter');
    check(await waitState('race', 15000), 'keyboard race');
    await G('__game.skipIntro()');
    await G('__game.setTimeScale(8)');
    await G('__game.autopilot(true)');
    check(await waitFor(`__game.humans[0] && __game.humans[0].finished`, 90000), 'keyboard kart finishes');
    const t0 = Date.now();
    check(await waitState('results', 20000), 'solo: results after the player finishes');
    console.log(`  (results ${((Date.now() - t0) / 1000).toFixed(1)} s real after the finish at 8×)`);
    await G('__game.setTimeScale(1)');
    check(await G(`document.querySelectorAll('.tk-results .tk-end-btns .tk-btn--menu').length === 2`), 'keyboard results: NEXT / LOBBY buttons');
    await page.keyboard.press('Enter'); await sleep(300);
    check(await waitState('standings'), 'Enter → standings');
    await page.keyboard.press('ArrowRight'); await sleep(200);
    await page.keyboard.press('Enter');
    check(await waitState('lobby'), 'LOBBY → lobby');
  }

  // ================================================================ E. solo racer + a late joiner
  if (ONLY.includes('E')) {
    console.log('\n# E. solo race with a late joiner: the racer\'s phone loses its signal');
    const S1 = new FakePad('rtest-solo-1');
    pads.push(S1);
    await S1.join(room);
    check(await waitFor('__game.keyboard === false && __game.players.filter((p) => p.connected).length === 1'), 'a phone joins (keyboard mode, if any, ends)');
    S1.menu('mode', { value: 'vs' });
    S1.menu('start');
    await waitState('select');
    await pickAll([S1], [{ char: chars[2], body: 'standard', wheels: 'standard' }]);
    await waitState('track');
    S1.menu('go');
    check(await waitState('race', 15000), 'solo VS race');
    S1.inp.g = 1;
    S1.stream(true);
    await G('__game.skipIntro()');
    await waitFor(`__game.race && __game.race.state === 'racing'`, 8000);
    const S2 = new FakePad('rtest-solo-2');                 // joins mid-race: spectates until the next race
    pads.push(S2);
    await S2.join(room);
    await waitFor('__game.players.filter((p) => p.connected).length === 2');
    await sleep(1500);
    check(!(await G('__game.paused')) && (await G('__game.humans.length')) === 1, 'racing alone with a second phone in the room');
    S1.stream(false);                                       // locked phone: silent, socket still open
    check(await waitFor('__game.paused', 4000), 'the racer\'s phone loses its signal → the race pauses (PhoneLink alone would not: 2 phones)');
    check((await G('__game.pausedBy')) === S1.slot, `paused by P${S1.slot}`);
    S1.stream(true);
    await sleep(300);
    S1.menu('resume');
    check(await waitFor('!__game.paused', 3000), 'signal back + RESUME → racing again');
    await sleep(600);
    check(!(await G('__game.paused')), 'stays running once the signal is back');
    S1.menu('pause');
    await waitFor('__game.paused');
    S1.menu('quit');
    check(await waitState('lobby'), 'QUIT → lobby');
  }

  if (portrait404) console.log(`  (${portrait404} racer portrait 404s — run tools/render-portraits.mjs)`);
  errors += Math.max(0, console404 - portrait404);
  check(errors === 0, `no page errors / console errors (${errors})`, errorLines.slice(0, 5).join(' | '));
} catch (err) {
  fail++;
  failures.push(String(err && err.message || err));
  console.error('test crashed:', err);
} finally {
  for (const pd of pads) pd.close();
  if (browser) await browser.close().catch(() => {});
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
