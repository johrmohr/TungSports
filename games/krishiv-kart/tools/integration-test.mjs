// End-to-end test of the v3 desktop app (index.html / main.js / menus.js /
// hud.js) against the REAL server: spawns `node server.js` on test ports,
// opens the game in headless Chrome and drives it with up to five fake phones
// (socket.io-client) speaking the SPEC §14.7 protocol, plus the keyboard.
//
// Covers: lobby + QR, join order / slots / host (5th phone → 'full'), host-only
// enforcement, mode / class / items, every player's char / body / wheels /
// assist / ready (+ back), the track screen (VS pick + Random, GP cup cards:
// Gelato / Krishiv Cup), race start with the right karts, loadouts, engine
// class and Steer Assist flags, the grid rule (humans fill the last slots, P1
// front-most), the split-screen layouts with 4 / 3 / 2 / 1 views on the v4
// tracks (4P Krishiv's Palace with live hazards, 3P Laguna Beach, 2P Aldrich
// Park, 1P Krishiv's Palace; screenshots at 1280×720 and 1920×1080, perf
// numbers per layout), pause / resume by anyone, restart /
// quit by the host only, host hand-over when P1 leaves, keyboard mode (and
// its end when a phone joins), host:state / host:padState contents and the
// 20 s slot release of a phone gone in the menus.
//
//   node tools/integration-test.mjs [--port 3105] [--https-port 3545] [--shots dir] [--quick]
//
// --quick skips the 1920×1080 shots and the 20 s release wait.
// Exit code 0 = all checks passed, 1 = failures (also fails on page errors /
// console.error, except 404s for racer portraits not rendered yet).
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { io as ioClient } from 'socket.io-client';
import { GAME_TITLE, RACE } from '../public/js/config.js';
import { KART_BODIES, WHEELS, PLAYER_SLOTS, getEngineClass } from '../public/js/parts.js';
import * as Tracks from '../public/js/tracks.js';

const { TRACK_LIST } = Tracks;
const CUPS = Array.isArray(Tracks.CUPS) && Tracks.CUPS.length ? Tracks.CUPS : [Tracks.CUP];
const HAS = (id) => TRACK_LIST.some((t) => t.id === id);
// the split-screen layouts race on the v4 tracks (older registries: the first ones)
const T4 = HAS('palace') ? 'palace' : 'monte';
const T3 = HAS('laguna') ? 'laguna' : 'breezy';
const T2 = HAS('aldrich') ? 'aldrich' : 'breezy';
const T1 = HAS('palace') ? 'palace' : 'breezy';
const NAME = Object.fromEntries(TRACK_LIST.map((t) => [t.id, t.def.name]));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt('port', 3105));
const HTTPS_PORT = Number(opt('https-port', 3545));
const SHOTS = opt('shots', null);
const QUICK = args.includes('--quick');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL ${label} ${extra}`); }
}

// ---------------------------------------------------------------- server
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
    try {
      const r = await fetch(`http://localhost:${PORT}/api/info`);
      if (r.ok) return r.json();
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not start\n' + serverLog);
}

// ---------------------------------------------------------------- fake phone
class FakePad {
  constructor(padId) {
    this.padId = padId;
    this.shared = null;      // last host:state
    this.pad = null;         // last host:padState
    this.events = [];
    this.slot = null;
    this.sock = null;
    this._timer = null;
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
  /** Stream input at ~30 Hz (a phone in a race), or stop. */
  stream(on = true) {
    clearInterval(this._timer);
    this._timer = on ? setInterval(() => this.send(), 33) : null;
  }
  pressItem() { this.inp.i++; this.send(); }
  pressPause() { this.inp.p++; this.send(); }
  close() { this.stream(false); if (this.sock) this.sock.close(); this.sock = null; }
}

let browser = null;
const pads = [];
let errors = 0;
const errorLines = [];

try {
  const info = await waitForServer();
  console.log(`server up: http ${PORT} / https ${HTTPS_PORT}, lanIps ${JSON.stringify(info.lanIps)}`);
  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    acceptInsecureCerts: true,
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  // Racer portraits (img/racers/<id>.png) come from tools/render-portraits.mjs;
  // until they exist the desktop falls back to initials: those 404s are not errors.
  let console404 = 0, portrait404 = 0;
  page.on('response', (r) => {
    if (r.status() !== 404) return;
    if (/\/img\/racers\/[a-z0-9_-]+\.png$/.test(r.url())) portrait404++;
    else { errors++; errorLines.push(`404 ${r.url()}`); console.log(`  [http 404] ${r.url()}`); }
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
    while (Date.now() - t0 < ms) { v = await G(expr); if (v) return v; await sleep(60); }
    return v;
  };
  const waitState = async (want, ms = 6000) => (await waitFor(`window.__game && window.__game.state === ${JSON.stringify(want)}`, ms)) === true;
  const key = async (k, wait = 170) => { await page.keyboard.press(k); await sleep(wait); };
  // screens cross-fade for ~0.35 s: settle before a screenshot
  const shot = async (name) => { if (SHOTS) { await sleep(600); await page.screenshot({ path: path.join(SHOTS, name) }); } };
  const padWait = async (pd, fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn(pd)) return true; await sleep(50); } return false; };

  // ================================================================ boot + lobby
  console.log('\n# boot / lobby');
  check(await waitState('lobby', 20000), 'reaches the lobby');
  check((await page.title()) === GAME_TITLE, `page title is ${GAME_TITLE}`);
  check(await G(`document.querySelector('.tk-logo').getAttribute('aria-label') === ${JSON.stringify(GAME_TITLE)}`), 'lobby logo spells KRISHIV KART');
  check(!(await G(`/toot\\s*kart|mario|mushroom|smart steering|blue shell|bullet bill|blooper|bob-omb|bowser|thwomp|lakitu|spiny/i.test(document.body.innerText)`)), 'no old title / Nintendo names on the page');
  let room = null;
  for (let i = 0; i < 80 && !room; i++) { room = await G('window.__game.phone.room'); if (!room) await sleep(100); }
  check(/^[A-Z]{4}$/.test(room || ''), `host room created (${room})`);
  check(await waitFor(`!!document.querySelector('.tk-qr--lobby.is-online .tk-qr-svg svg')`), 'lobby shows the big QR');
  const url = await G(`document.querySelector('.tk-qr--lobby .tk-qr-url').textContent`);
  check(url.includes(`/pad?room=${room}`) && url.startsWith('https://'), `pad URL shown (${url})`);
  check(await G(`document.querySelectorAll('.tk-pp').length === 4 && document.querySelectorAll('.tk-pp.is-empty').length === 4`), '4 empty player panels');
  check(await G(`/Grand Prix · 100cc/.test(document.querySelector('.tk-settings').textContent)`), 'settings line "Grand Prix · 100cc"');
  check(await G(`/Waiting for players/.test(document.querySelector('.tk-lobby .tk-status').textContent)`), 'status line "Waiting for players"');
  await shot('01-lobby-empty.png');

  // ================================================================ joins
  console.log('\n# 4 phones join (slots, host, 5th = full)');
  for (let k = 0; k < 4; k++) {
    const pd = new FakePad(`itest-pad-${k + 1}`);
    pads.push(pd);
    const ack = await pd.join(room);
    check(ack && ack.ok && ack.slot === k + 1 && ack.color === PLAYER_SLOTS[k].css, `phone ${k + 1} → P${k + 1} (${ack && ack.slot}, ${ack && ack.color})`);
    await sleep(120);
  }
  const [P1, P2, P3, P4] = pads;
  check(await waitFor(`__game.players.length === 4 && __game.host === 1`), 'desktop sees 4 players, host = P1');
  const extra = new FakePad('itest-pad-5');
  const ack5 = await extra.join(room);
  check(ack5 && ack5.ok === false && ack5.error === 'full', `5th phone → 'full' (${JSON.stringify(ack5 && ack5.error)})`);
  extra.close();
  check(await padWait(P2, (p) => p.shared && p.shared.screen === 'lobby' && p.shared.players.length === 4), 'phones get host:state (lobby, 4 players)');
  const sh = P1.shared;
  check(sh && sh.host === 1 && sh.mode === 'gp' && sh.cc === 100 && sh.items === true, 'host:state host / mode / cc / items');
  check(sh && sh.characters.length >= 12 && sh.characters.every((c) => c.img === null || c.img === `img/racers/${c.id}.png`), `characters catalog (${sh && sh.characters.length}) with img paths`);
  check(sh && sh.bodies.length === KART_BODIES.length && sh.wheels.length === WHEELS.length, 'bodies + wheels catalogs');
  check(sh && sh.tracks.length === TRACK_LIST.length && sh.cup && sh.cup.name === CUPS[0].name && sh.cup.tracks.join() === CUPS[0].tracks.join(), `tracks + default cup (${CUPS[0].name})`);
  check(sh && Array.isArray(sh.cups) && sh.cups.length === CUPS.length && sh.cups.every((c, i) => c.id === CUPS[i].id && c.name === CUPS[i].name
    && c.tracks.map((t) => (typeof t === 'string' ? t : t.id)).join() === CUPS[i].tracks.join()), `host:state cups (${sh && sh.cups ? sh.cups.map((c) => c.id).join(', ') : 'none'})`);
  check(await padWait(P1, (p) => p.pad && p.pad.isHost === true && p.pad.slot === 1 && p.pad.step === 'char'), 'P1 padState isHost, step char');
  check(await padWait(P3, (p) => p.pad && p.pad.isHost === false && p.pad.color === PLAYER_SLOTS[2].css), 'P3 padState not host, slot color');
  check(await G(`document.querySelectorAll('.tk-pp.is-empty').length === 0 && document.querySelector('.tk-pp[data-slot="1"]').classList.contains('is-host')`), 'lobby panels filled, crown on P1');
  await shot('02-lobby-4p.png');

  // ================================================================ host controls
  console.log('\n# host-only settings');
  P2.menu('mode', { value: 'vs' });
  P3.menu('start');
  await sleep(300);
  check((await G('__game.mode')) === 'gp' && (await G('__game.state')) === 'lobby', 'non-host mode / start ignored');
  P1.menu('mode', { value: 'vs' });
  P1.menu('cc', { value: 150 });
  P1.menu('items', { value: false });
  check(await waitFor(`__game.mode === 'vs' && __game.cc === 150 && __game.items === false`), 'host sets VS · 150cc · items off');
  check(await G(`/VS Race · 150cc · Items off/.test(document.querySelector('.tk-settings').textContent)`), 'settings line follows');
  P1.menu('start');
  check(await waitState('select'), 'host START → select');
  check(await padWait(P4, (p) => p.shared && p.shared.screen === 'select'), 'phones on the select screen');

  // ================================================================ picks
  console.log('\n# picks (char → body → wheels → ready)');
  const chars = (await G('__game.sharedState().characters')).filter((c) => !c.custom).map((c) => c.id);
  const picks = [
    { char: chars[0], body: 'speedster', wheels: 'slick', assist: true },
    { char: chars[4], body: 'buggy', wheels: 'offroad', assist: true },
    { char: chars[8], body: 'tank', wheels: 'monster', assist: false },
    { char: chars[11], body: 'feather', wheels: 'neon', assist: true },
  ];
  P2.menu('body', { id: 'tank' });            // a pick off its step is remembered but does not advance
  await sleep(200);
  check((await G('__game.players[1].step')) === 'char', 'body before char does not advance the step');
  for (let k = 0; k < 4; k++) pads[k].menu('char', { id: picks[k].char });
  check(await waitFor(`__game.players.every((p, i) => p.step === 'body')`), 'char picked → step body (everyone)');
  check(await padWait(P1, (p) => p.pad && p.pad.step === 'body' && p.pad.choice.char === picks[0].char), 'P1 padState step body + choice');
  P2.menu('char', { id: 'not-a-racer' });
  await sleep(150);
  for (let k = 0; k < 4; k++) pads[k].menu('body', { id: picks[k].body });
  await sleep(250);
  for (let k = 0; k < 4; k++) pads[k].menu('wheels', { id: picks[k].wheels });
  check(await waitFor(`__game.players.every((p) => p.step === 'ready')`), 'wheels → step ready');
  const ratingsP3 = (await G('__game.padState(3)')).ratings;
  check(ratingsP3 && ratingsP3.weight >= 4, `P3 final ratings use parts (weight ${ratingsP3 && ratingsP3.weight})`);
  P3.menu('assist', { value: false });
  for (let k = 0; k < 3; k++) pads[k].menu('ready', { value: true });
  check(await waitFor(`__game.players.filter((p) => p.ready).length === 3 && __game.state === 'select'`), '3 of 4 ready → still select');
  check(await G(`/Waiting for P4/.test(document.querySelector('.tk-status--select').textContent)`), 'select status "Waiting for P4…"');
  await shot('03-select.png');
  P4.menu('back');                            // ready → wheels
  await sleep(150);
  check((await G('__game.players[3].step')) === 'wheels', 'back walks one step (ready → wheels)');
  P4.menu('wheels', { id: picks[3].wheels });
  await sleep(120);
  P4.menu('ready', { value: true });
  check(await waitState('track'), 'all ready → track screen');
  check(await padWait(P1, (p) => p.shared && p.shared.screen === 'track'), 'phones on the track screen');
  check(await G(`document.querySelectorAll('.tk-tile').length === ${TRACK_LIST.length + 1}`), 'VS: a tile per track + Random');
  check(await G(`document.querySelectorAll('.tk-cup').length === 0`), 'VS: no cup cards');
  P2.menu('track', { value: T4 });
  await sleep(200);
  check((await G('__game.trackPick')) !== T4 || T4 === 'breezy', 'non-host track pick ignored');
  P2.menu('cup', { id: CUPS[CUPS.length - 1].id });
  await sleep(150);
  check((await G('__game.cup.id')) === CUPS[0].id, 'non-host / VS cup pick ignored');
  P1.menu('track', { value: 'random' });
  check(await waitFor(`__game.trackPick === 'random'`), 'host picks Random');
  P1.menu('track', { value: T4 });
  check(await waitFor(`__game.trackPick === ${JSON.stringify(T4)}`), `host picks ${NAME[T4]}`);
  await shot('04-track-vs.png');
  P2.menu('ready', { value: false });         // un-ready on the track screen → select
  check(await waitState('select'), 'un-ready on the track screen → back to select');
  P2.menu('ready', { value: true });
  check(await waitState('track'), '…ready again → track');
  P1.menu('go');
  check(await waitState('race', 15000), 'GO → loading → race');

  // ================================================================ 4P race
  console.log('\n# 4P race: karts, loadouts, grid, layout');
  for (const pd of pads) pd.stream(true);
  const humans = await G('__game.humans');
  check(humans.length === 4, `4 human karts (${humans.length})`);
  const cc150 = getEngineClass(150).mult;
  for (let k = 0; k < 4; k++) {
    const h = humans.find((x) => x.slot === k + 1) || {};
    check(h.char === picks[k].char && h.body === picks[k].body && h.wheels === picks[k].wheels && h.isPlayer && h.kartSlot === k + 1,
      `P${k + 1} kart = ${picks[k].char} · ${picks[k].body} · ${picks[k].wheels}`, JSON.stringify(h));
    check(h.steerAssist === picks[k].assist, `P${k + 1} Steer Assist ${picks[k].assist ? 'on' : 'off'}`);
    check(Math.abs(h.ccMult - cc150) < 1e-9, `P${k + 1} engine class ×${cc150}`);
  }
  check(humans.map((h) => h.grid).join() === '4,5,6,7', `humans fill the last 4 grid slots, P1 front-most (${humans.map((h) => h.grid)})`);
  const grid = await G('__game.grid');
  check(grid.length === RACE.racers, `${RACE.racers} karts on the grid`);
  const cpuChars = grid.filter((g) => g.slot === null).map((g) => g.char);
  check(cpuChars.every((c) => !picks.some((p) => p.char === c)), 'CPUs never use a character a human picked');
  check(new Set(cpuChars).size === cpuChars.length, 'CPU characters are distinct');
  check(grid.filter((g) => g.slot === null).every((g) => Math.abs(g.ccMult - cc150) < 1e-9), 'CPUs at the same engine class');
  check((await G('__game.trackId')) === T4 && (await G('__game.items')) === false, `${NAME[T4]}, items off`);
  // (v5: Items Off builds an item-less ItemSystem — no boxes, no rolls — so the lire stay on the track)
  check(await G('!__game.R.items || (__game.R.items.enabled === false && __game.R.items.boxes.length === 0)'), 'items off: no item boxes (an item-less system keeps the lire)');
  if (T4 === 'palace') check(await G('!!__game.hazards && __game.hazards.list.length > 0 && __game.R.hazards === __game.world.hazards'), 'palace hazards live with items off (course, not items)');
  const views4 = await G('__game.views');
  check(views4.length === 4 && views4.every((v) => Math.abs(v.rect.w - 640) <= 1 && Math.abs(v.rect.h - 360) <= 1), '4 quadrant views');
  check(await G(`document.querySelectorAll('.hud.hud--compact').length === 4 && document.querySelector('.hud-shared').dataset.kind === 'center'`), '4 compact HUDs + center minimap');
  // split-screen intro: one full-screen flyover through view 0, then the quadrants
  check(await G(`__game.R.introFull === true && Math.abs(__game.R.views[0].cam.aspect - innerWidth / innerHeight) < 1e-6`), 'intro flyover plays full-screen (view 0)');
  check(await G(`document.querySelector('.tk-intro-hint .tk-key').textContent === 'ITEM'`), 'intro hint: ITEM skips (phones)');
  await G('__game.skipIntro()');
  for (const pd of pads) pd.inp.g = 1;
  await sleep(4800);
  check(await G(`!__game.R.introFull && __game.views.every((v) => Math.abs(v.aspect - v.rect.w / v.rect.h) < 1e-6)`), 'after the intro: every view at its quadrant aspect');
  // SPEC §14.6: a view draws the other humans' karts with the low-detail model
  const lodByView = await G(`new Promise((res) => {
    const r = __game.renderer, orig = r.render, R = __game.R, out = [];
    r.render = function (sc, cam) {
      const v = R.views.find((x) => x.cam === cam);
      if (v) out.push(R.humanKvs.map((kv) => (kv.kart === v.h.kart ? '*' : '') + (kv.models.low.visible ? 'L' : kv.models.high.visible ? 'H' : '-')).join(' '));
      return orig.call(this, sc, cam);
    };
    requestAnimationFrame(() => requestAnimationFrame(() => { r.render = orig; res(out.slice(0, 4)); }));
  })`);
  // per kart: low-detail ('L') in every other view, unless it is blinking ('-') in its own view too
  const lodRows = lodByView.map((row) => row.split(' '));
  const ownOf = (j) => { const r = lodRows.find((row) => row[j] && row[j].startsWith('*')); return r ? r[j].slice(1) : null; };
  const lodOk = lodRows.length === 4 && lodRows.every((row) => row.length === 4 && row.filter((m) => m.startsWith('*')).length === 1 &&
    row.every((m, j) => m.startsWith('*') || m === (ownOf(j) === '-' ? '-' : 'L')));
  check(lodOk, `other humans' karts drawn low-detail (and visible) in each view (${lodByView.join(' | ')})`);
  check(await G(`__game.R.humanKvs.every((kv) => !kv.models.high.visible || !kv.models.low.visible)`), 'kart LOD restored after the split render');
  const st4 = await G('__game.stats()');
  check(st4.pixelRatio === 1 && st4.quality === 'low' && st4.effectsIntensity === 0.5 && st4.blobs === RACE.racers,
    `4P perf rules: pixelRatio 1, world low, particles halved, blob shadows (${JSON.stringify(st4)})`);
  console.log(`  perf 4P: ${st4.fps} fps, cpu ${st4.frameCpuMs} ms, ${st4.calls} calls, ${st4.triangles} tris`);
  check(st4.fps >= 30, `4P ≥ 30 fps headless (${st4.fps})`);
  check(await G(`[...document.querySelectorAll('.hud-tag')].some((t) => t.style.visibility === 'visible')`), 'P-tags over other humans visible');
  await shot('05-race-4p-1280.png');
  if (!QUICK) {
    await page.setViewport({ width: 1920, height: 1080 });
    await sleep(900);
    const v1080 = await G('__game.views');
    check(v1080.every((v) => v.rect.w === 960 && v.rect.h === 540), '1920×1080: views re-laid out');
    await shot('05-race-4p-1920.png');
    await page.setViewport({ width: 1280, height: 720 });
    await sleep(500);
  }

  // ---- pause (anyone) / restart (host only)
  console.log('\n# pause / resume / restart / quit');
  P3.menu('pause');
  check(await waitFor(`__game.paused === true && __game.pausedBy === 3`), 'P3 pauses');
  check(await padWait(P1, (p) => p.shared && p.shared.screen === 'paused' && p.shared.pausedBy === 3), 'phones see screen "paused" (pausedBy 3)');
  check(await G(`document.querySelector('.tk-pause').classList.contains('is-active') && /P3 paused/.test(document.querySelector('.tk-pause-by').textContent)`), 'pause overlay names P3');
  await shot('06-paused.png');
  P2.menu('restart');
  P2.menu('quit');
  await sleep(300);
  check((await G('__game.state')) === 'race' && (await G('__game.paused')), 'non-host restart / quit ignored');
  P4.menu('resume');
  check(await waitFor(`__game.paused === false`), 'P4 resumes');
  P2.pressPause();
  check(await waitFor(`__game.paused === true && __game.pausedBy === 2`), 'phone ⏸ (pause seq) pauses');
  const raceBefore = await G('__game.race');
  P1.menu('restart');
  check(await waitFor(`__game.state === 'race' && !__game.paused && __game.race && __game.race.state === 'intro'`, 15000), 'host restart → fresh race');
  check((await G('__game.humans')).map((h) => h.grid).join() === '4,5,6,7', 'restart keeps the grid');
  void raceBefore;
  P1.menu('pause');
  await waitFor('__game.paused');
  P1.menu('quit');
  check(await waitState('lobby'), 'host quit → lobby');
  check(await G('__game.players.every((p) => !p.ready && p.step === "char")'), 'lobby resets readiness (picks kept)');
  check((await G('__game.players[0].char')) === picks[0].char, 'picks kept across sets');

  // ================================================================ 3P / 2P / 1P layouts
  async function raceWith(n, label, trackId = 'breezy') {
    // everyone still connected picks again quickly (their previous picks are pre-selected)
    const live = pads.filter((p) => p.sock);
    const host = live[0];
    host.menu('start');
    await waitState('select');
    for (const pd of live) { const c = await G(`__game.players.find((p) => p.slot === ${pd.slot}).char`); pd.menu('char', { id: c }); }
    await sleep(200);
    for (const pd of live) pd.menu('body', { id: 'standard' });
    await sleep(150);
    for (const pd of live) pd.menu('wheels', { id: 'standard' });
    await sleep(150);
    for (const pd of live) pd.menu('ready', { value: true });
    check(await waitState('track'), `${label}: all ready → track`);
    host.menu('track', { value: trackId });
    await sleep(150);
    host.menu('go');
    check(await waitState('race', 15000), `${label}: race`);
    check((await G('__game.trackId')) === trackId, `${label}: on ${NAME[trackId]}`);
    const v = await G('__game.views');
    check(v.length === n, `${label}: ${n} view(s)`);
    await G('__game.skipIntro()');
    for (const pd of live) { pd.inp.g = 1; pd.stream(true); }
    await sleep(4500);
    const st = await G('__game.stats()');
    console.log(`  perf ${label}: ${st.fps} fps, cpu ${st.frameCpuMs} ms, ${st.calls} calls, ${st.triangles} tris, pr ${st.pixelRatio}, ${st.quality}`);
    return { v, st };
  }

  console.log('\n# P4 leaves → 3P (Q4 = minimap + standings)');
  P4.close();
  check(await waitFor(`__game.players.find((p) => p.slot === 4) && !__game.players.find((p) => p.slot === 4).connected`), 'P4 disconnected (slot kept)');
  if (!QUICK) {
    console.log('  (waiting 21 s: a phone gone in the menus is released)');
    await sleep(21500);
    check(await waitFor(`!__game.players.find((p) => p.slot === 4)`), 'P4 released after 20 s in the menus');
  }
  const r3 = await raceWith(3, '3P', T3);
  check(await G(`document.querySelector('.hud-shared').dataset.kind === 'quad' && document.querySelectorAll('.hud-st-row:not([hidden])').length === ${RACE.racers}`), '3P: Q4 widget with live standings');
  check(r3.st.pixelRatio === 1 && r3.st.quality === 'low' && r3.st.fps >= 30, `3P perf rules + ≥ 30 fps (${r3.st.fps})`);
  await shot('07-race-3p-1280.png');
  if (!QUICK) { await page.setViewport({ width: 1920, height: 1080 }); await sleep(900); await shot('07-race-3p-1920.png'); await page.setViewport({ width: 1280, height: 720 }); await sleep(400); }
  P1.menu('pause'); await waitFor('__game.paused'); P1.menu('quit'); await waitState('lobby');

  console.log('\n# P3 leaves → 2P side by side');
  P3.close();
  await waitFor(`!__game.players.find((p) => p.slot === 3 && p.connected)`);
  const r2 = await raceWith(2, '2P', T2);
  check(r2.v.every((v) => v.rect.w === 640 && v.rect.h === 720 && v.fov === 76), '2P: side by side, vFOV 76');
  check(r2.st.quality === 'low' && r2.st.fps >= 50, `2P world low + ~60 fps (${r2.st.fps})`);
  await shot('08-race-2p-1280.png');
  if (!QUICK) { await page.setViewport({ width: 1920, height: 1080 }); await sleep(900); await shot('08-race-2p-1920.png'); await page.setViewport({ width: 1280, height: 720 }); await sleep(400); }
  P1.menu('pause'); await waitFor('__game.paused'); P1.menu('quit'); await waitState('lobby');

  console.log('\n# P1 leaves → host hand-over, 1P');
  P1.close();
  check(await waitFor(`__game.host === 2`), 'host passes to P2 (lowest connected)');
  check(await padWait(P2, (p) => p.pad && p.pad.isHost === true), 'P2 padState isHost');
  const r1 = await raceWith(1, '1P', T1);
  check(r1.v.length === 1 && r1.v[0].fov === 70 && r1.st.quality === 'high' && r1.st.blobs === 0, '1P: full screen, world high, shadow map');
  check(await G(`document.querySelectorAll('.hud--compact').length === 0 && document.querySelector('.hud-map').offsetWidth > 0`), '1P HUD with its own minimap');
  await shot('09-race-1p-1280.png');
  if (!QUICK) { await page.setViewport({ width: 1920, height: 1080 }); await sleep(900); await shot('09-race-1p-1920.png'); await page.setViewport({ width: 1280, height: 720 }); await sleep(400); }
  // solo: the phone dropping pauses the race; with no phone left the desktop keyboard may quit
  P2.close();
  check(await waitFor(`__game.paused === true`), 'solo race: phone gone → pause');
  check(await waitFor(`!document.querySelector('.tk-pause-btns').hidden`), 'no phone left: the pause menu gets desktop buttons');
  await page.focus('canvas#game');
  await key('ArrowDown'); await key('ArrowDown'); await key('Enter', 600);
  check(await waitState('lobby'), 'desktop Quit → lobby');

  // ================================================================ keyboard mode
  console.log('\n# keyboard mode');
  await key('Enter', 500);
  check(await waitFor(`__game.keyboard === true && __game.players.length === 1 && __game.players[0].kb && __game.host === 1`), 'Enter on the lobby (no phone connected) → keyboard P1');
  check(await G(`document.querySelector('.tk-kb-lobby').classList.contains('on')`), 'keyboard host controls shown');
  await shot('10-kb-lobby.png');
  await key('ArrowLeft');                    // mode: VS → GP
  check((await G('__game.mode')) === 'gp', 'mode changes from the keyboard');
  await key('ArrowDown'); await key('ArrowLeft');   // class 150 → 100
  check((await G('__game.cc')) === 100, 'class changes from the keyboard');
  await key('ArrowDown'); await key('Enter', 600);
  check(await waitState('select'), 'keyboard START → select');
  check(await G(`document.querySelector('.tk-kb').offsetWidth > 0 && document.querySelectorAll('.tk-kb-card').length >= 12`), 'keyboard picker with the roster');
  await key('ArrowDown'); await key('ArrowRight'); await key('Enter', 300);
  check((await G('__game.players[0].step')) === 'body' && (await G('__game.players[0].char')) === chars[5], `keyboard char pick → ${chars[5]}, step body`);
  await shot('11-kb-body.png');
  await key('ArrowRight'); await key('Enter', 250);
  check((await G('__game.players[0].body')) === KART_BODIES[1].id, `keyboard body pick → ${KART_BODIES[1].id}`);
  await key('ArrowDown'); await key('Enter', 250);
  check((await G('__game.players[0].step')) === 'ready' && (await G('__game.players[0].wheels')) === WHEELS[3].id, `keyboard wheels pick → ${WHEELS[3].id}`);
  await key('ArrowUp'); await key('Enter', 250);       // Steer Assist off
  check((await G('__game.players[0].assist')) === false, 'keyboard toggles Steer Assist');
  await key('ArrowDown'); await key('Enter', 500);
  check(await waitState('track'), 'keyboard READY → track (GP cup cards)');
  check(await G(`document.querySelectorAll('.tk-cup').length === ${CUPS.length} && document.querySelectorAll('.tk-tile').length === ${CUPS[0].tracks.length}`),
    `GP: ${CUPS.length} cup cards, ${CUPS[0].tracks.length} race tiles`);
  await shot('12-kb-cup.png');
  check(!(await G(`/mario|mushroom|blue shell|bullet bill|blooper|bob-omb|bowser|thwomp|lakitu|spiny/i.test(document.body.innerText)`)), 'cup screen: original names only');
  if (CUPS.length > 1) {
    await key('ArrowRight', 300);
    check(await waitFor(`__game.cup.id === ${JSON.stringify(CUPS[1].id)} && document.querySelectorAll('.tk-tile').length === ${CUPS[1].tracks.length}`), `→ picks the ${CUPS[1].name} (${CUPS[1].tracks.length} races)`);
    check((await G('__game.sharedState().races')) === CUPS[1].tracks.length, 'host:state races follows the cup');
    await shot('12b-kb-cup2.png');
    await key('ArrowLeft', 300);
    check(await waitFor(`__game.cup.id === ${JSON.stringify(CUPS[0].id)}`), `← back to the ${CUPS[0].name}`);
  }
  await key('Enter', 300);
  check(await waitState('race', 15000), 'keyboard GO → race');
  check((await G('__game.trackId')) === CUPS[0].tracks[0], `GP race 1 = ${CUPS[0].tracks[0]}`);
  const kbh = await G('__game.humans');
  check(kbh.length === 1 && kbh[0].kb && kbh[0].steerAssist === false && kbh[0].grid === RACE.racers - 1, 'keyboard kart: assist off, last grid slot');
  await G('__game.skipIntro()');
  await sleep(3600);
  await page.keyboard.down('ArrowUp');
  await sleep(1500);
  const sp = await G('__game.karts.find((k) => k.isPlayer).speed');
  await page.keyboard.up('ArrowUp');
  check(sp > 5, `keyboard drives the kart (${sp && sp.toFixed(1)} m/s)`);
  await key('Escape', 300);
  check(await waitFor('__game.paused === true'), 'Esc pauses');
  check(await G(`!document.querySelector('.tk-pause-btns').hidden`), 'keyboard pause menu has buttons');
  await key('Escape', 300);
  check(await waitFor('__game.paused === false'), 'Esc resumes');
  // a phone joining ends keyboard mode
  const late = new FakePad('itest-pad-late');
  pads.push(late);
  const lateAck = await late.join(room);
  check(lateAck && lateAck.ok && lateAck.slot === 1, `a phone joins as P1 (${lateAck && lateAck.slot})`);
  check(await waitFor(`__game.keyboard === false && __game.state === 'lobby' && __game.players.length === 1 && !__game.players[0].kb`), 'keyboard mode ends → lobby with the phone as P1');
  late.close();

  // ================================================================ leaks / errors
  console.log('\n# leaks');
  const lk = await G('__game.leaks()');
  console.log(`  ${JSON.stringify(lk)}`);
  check(lk.huds === 0, 'no HUD DOM left outside races');
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
