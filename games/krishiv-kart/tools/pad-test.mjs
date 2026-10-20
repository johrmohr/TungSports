// End-to-end tests for the phone controller (public/pad.html + pad.js, SPEC
// §14.3b, §14.7, §14.8) in headless Chrome with phone emulation, against the
// real server and a fake desktop host (tools/pad-host.mjs: the 12-racer cast +
// a custom racer, parts.js catalog, a timed race per slot).
//
//   node tools/pad-test.mjs [--out <dir>] [--no-spawn] [--dpr 1] [--only L90,L270,P0,multi,SE,extra]
//
// L90 / L270 / P0: one phone per orientation (landscape at screen angle 90 and
// 270, and a portrait layout pad.js rotates with CSS while held sideways). It
// simulates a phone held like a wheel (synthetic deviceorientation events),
// checks the steering tuning (3° dead zone, expo 0.55, 30/s low-pass, full
// lock 42° = steer 0.8 after a soft knee, flat beyond it: SPEC §15.1), the
// lock indicator + buzz, every config item icon, the Capo Crusher / Beer
// Rocket / espresso alerts, walks lobby → character → body → wheels → ready → track → race
// with real touch input, auto-centers at the countdown, presses GAS / DRIFT /
// ITEM / BRAKE with multi-touch, Auto-Gas, the Steer Assist pip, pause, the
// settings sheet, touch steering, the desktop leaving, the controller being
// opened elsewhere and (P0) the rotation side + "turn sideways" hint.
// multi: four phones at once (each its own browser profile = its own padId)
// play VS and Grand Prix through every screen: host-only lobby controls, each
// phone's own picks with stat deltas, ready / waiting, the host's track
// screen, per-slot race input, pause by a guest, results / standings / podium,
// host hand-off when P1 leaves and comes back, and a 5th phone that finds the
// game full until a slot frees up. SE: every menu on iPhone SE sizes (667×375,
// 375×553 upright, 375×553 held sideways) fits. extra: devicemotion
// fallback, flipped angle, touch fallback, code entry, unknown room, hidden
// page (solo pause vs. multi), denied motion access, fullscreen re-entry,
// long-polling, insecure page, legacy storage keys, a full server restart.
//
// Screenshots of every screen go to --out. Prints PASS/FAIL per check; exits
// non-zero on any failure or page error.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { io as ioClient } from 'socket.io-client';
import { startFakeHost } from './pad-host.mjs';
import { computeRatings, PLAYER_SLOTS } from '../public/js/parts.js';
import { ITEM_IDS, ITEM_INFO } from '../public/js/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3100;
const HTTPS_PORT = 3543;
const ROOM = 'PADT';
const PAD_URL = `https://localhost:${HTTPS_PORT}/pad?room=${ROOM}`;
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'krishivkart-pad-shots')));
const ONLY = opt('only', 'L90,L270,P0,multi,SE,extra').split(',');
const DPR = Number(opt('dpr', 1)) || 1;
const spawnServer = !argv.includes('--no-spawn');
fs.mkdirSync(OUT, { recursive: true });

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const SLOT_CSS = PLAYER_SLOTS.map((s) => s.css);

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let pageErrors = 0;
let portraitMisses = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return !!ok;
}
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
const fmt = (v) => (typeof v === 'number' ? v.toFixed(3) : JSON.stringify(v));

// Expected steering angle θ (deg) for world-up (ux, uy) in the UI frame
// (mirrors pad.js angleFromScreenUp): the in-plane wheel angle while held
// upright-ish, blending into the flat-phone roll angle asin(−ux) as the
// in-plane gravity m drops from 0.6 to 0.35.
function expectedTheta(ux, uy) {
  const D = Math.PI / 180;
  const flat = Math.asin(Math.max(-1, Math.min(1, -ux))) / D;
  const m = Math.hypot(ux, uy);
  if (m <= 0.35 || uy <= 0) return flat;
  const sm = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
  const w = sm((m - 0.35) / 0.25) * sm(uy / (m * 0.25));
  return w * Math.atan2(-ux, uy) / D + (1 - w) * flat;
}

// Pad steering for an angle (SPEC §15.1: dead zone 3°, expo 0.55 centre, soft
// knee at 70 % of the span into the steering lock: 0.8 at 42°, flat beyond).
const LOCK_DEFAULT = 42, EXPO = 0.55, KNEE = 0.7, CAP = 0.8;
const v3Steer = (u) => (1 - EXPO) * u + EXPO * u * u * u;
function shapedSteer(theta, lockDeg = LOCK_DEFAULT) {
  const mag = Math.abs(theta);
  if (mag <= 3) return 0;
  const u = Math.min(1, (mag - 3) / (lockDeg - 3));
  let x;
  if (u <= KNEE) x = v3Steer(u);
  else {
    const h = 1 - KNEE, t = (u - KNEE) / h;
    const p0 = v3Steer(KNEE), m0 = ((1 - EXPO) + 3 * EXPO * KNEE * KNEE) * h;
    x = p0 * (2 * t ** 3 - 3 * t * t + 1) + m0 * (t ** 3 - 2 * t * t + t) + CAP * (3 * t * t - 2 * t ** 3);
  }
  return Math.sign(theta) * x;
}
const atCap = (v) => v > CAP - 0.03 && v <= CAP + 0.002;

// Expected pad steering for a wheel rotated phiDeg clockwise with the screen
// tilted back tauDeg.
function expectedSteer(phiDeg, tauDeg, calibDeg = 0, lockDeg = LOCK_DEFAULT) {
  const D = Math.PI / 180;
  const c = Math.cos(tauDeg * D);
  return shapedSteer(expectedTheta(-Math.sin(phiDeg * D) * c, Math.cos(phiDeg * D) * c) - calibDeg, lockDeg);
}

async function waitUntil(fn, ms = 3000, every = 50) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(every);
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ------------------------------------------------------------------ server

let server = null;
let serverLog = '';
function startServer() {
  serverLog = '';
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), NO_OPEN: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
}
async function waitForServer() {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (server && server.exitCode !== null) throw new Error(`server exited:\n${serverLog}`);
    if (!server || serverLog.includes('Desktop game')) {
      try { return await getJson(`https://localhost:${HTTPS_PORT}/api/info`); } catch { /* not yet */ }
    }
    await sleep(150);
  }
  throw new Error(`server did not start\n${serverLog}`);
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  s.kill('SIGTERM');
  await new Promise((r) => { if (s.exitCode !== null) r(); else s.once('exit', r); });
}

// ------------------------------------------------------------------ page helpers

// Injected before the page scripts: a simulated phone held like a wheel.
//   __tilt.start(a)   a = how the phone is held: 90 = rotated counter-clockwise
//                     from portrait (top to the left), 270 = clockwise, 0 = portrait
//   __tilt.set(phi, tau)  phi = wheel rotation (clockwise +), tau = screen tilted back
//   __tilt.motion(convention)  'ios' | 'android' → send devicemotion instead
function tiltSim() {
  const D = Math.PI / 180;
  const sim = { a: 90, phi: 0, tau: 15, raw: null, timer: null, mode: 'orientation', convention: 'android', sent: 0 };
  function up() {
    // World up in the held phone's UI frame (x right, y up, z out of the screen)...
    let ux = -Math.sin(sim.phi * D) * Math.cos(sim.tau * D);
    let uy = Math.cos(sim.phi * D) * Math.cos(sim.tau * D);
    let uz = Math.sin(sim.tau * D);
    if (sim.raw) [ux, uy, uz] = sim.raw;
    // ...rotated into device coordinates (natural portrait frame).
    const a = sim.a * D;
    return { x: ux * Math.cos(a) + uy * Math.sin(a), y: -ux * Math.sin(a) + uy * Math.cos(a), z: uz };
  }
  function fire() {
    const u = up();
    sim.sent++;
    if (sim.mode === 'orientation') {
      const beta = Math.asin(u.y) / D;
      const gamma = Math.atan2(-u.x, u.z) / D;
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta, gamma, absolute: false }));
    } else {
      const k = sim.convention === 'ios' ? -9.81 : 9.81;
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        accelerationIncludingGravity: { x: k * u.x, y: k * u.y, z: k * u.z },
        acceleration: { x: 0, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16,
      }));
    }
  }
  window.__tilt = {
    start(a = 90, mode = 'orientation', convention = 'android') {
      sim.a = a; sim.mode = mode; sim.convention = convention;
      clearInterval(sim.timer);
      sim.timer = setInterval(fire, 16);
      fire();
    },
    hold(a) { sim.a = a; },
    set(phi, tau = sim.tau) { sim.phi = phi; sim.tau = tau; sim.raw = null; },
    // Raw world-up vector in the UI frame, e.g. a flat phone rolled right by r:
    // setUp(-sin r, 0, cos r).
    setUp(ux, uy, uz) { const n = Math.hypot(ux, uy, uz); sim.raw = [ux / n, uy / n, uz / n]; },
    stop() { clearInterval(sim.timer); sim.timer = null; },
    get sent() { return sim.sent; },
  };
}

class Phone {
  constructor(page, client, label, ctx) { this.page = page; this.client = client; this.label = label; this.ctx = ctx; this.touches = new Map(); }

  // Each phone gets its own browser profile (context) unless one is passed:
  // its own localStorage, so its own padId and saved settings.
  static async open(browser, { w, h, angle, ua = IPHONE_UA, url = PAD_URL, label, netErrorsOk = false, init = null, context = null }) {
    const ctx = context || await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // Racer portraits are rendered by a separate tool; until they exist the
      // phone shows its color-card fallback (checked below) and the browser logs a 404.
      if (/\/img\/racers\//.test(m.location()?.url || '')) { portraitMisses++; return; }
      // While the server is deliberately down, the browser logs refused connections.
      if (netErrorsOk && /WebSocket connection|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) return;
      pageErrors++;
      console.log(`  [${label} console.error] ${m.text()}`);
    });
    page.on('pageerror', (e) => { pageErrors++; console.log(`  [${label} pageerror] ${e.message}`); });
    page.on('requestfailed', (r) => {
      if (!r.url().includes('fonts.g')) console.log(`  [${label} requestfailed] ${r.url()} ${r.failure()?.errorText}`);
    });
    // All device emulation goes through this one CDP session (the browser is
    // launched with defaultViewport: null) — two sessions overriding device
    // metrics race, and the screen angle must be exact for these tests.
    const client = await page.createCDPSession();
    const type = angle === 0 ? 'portraitPrimary' : angle === 90 ? 'landscapePrimary' : angle === 180 ? 'portraitSecondary' : 'landscapeSecondary';
    await client.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: DPR, mobile: true, screenOrientation: { type, angle } });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await client.send('Emulation.setUserAgentOverride', { userAgent: ua, platform: ua.includes('iPhone') ? 'iPhone' : 'Linux armv8l' });
    await page.evaluateOnNewDocument(tiltSim);
    if (init) await page.evaluateOnNewDocument(init);
    await page.goto(url, { waitUntil: 'load' });
    return new Phone(page, client, label, context ? null : ctx);
  }

  eval(fn, ...args) { return this.page.evaluate(fn, ...args); }
  screen() { return this.eval(() => document.getElementById('stage').dataset.screen); }
  pad() {
    return this.eval(() => ({
      steer: window.__pad.steer, raw: window.__pad.rawAngleDeg, ui: window.__pad.uiAngle,
      src: window.__pad.state.steerSource, calib: window.__pad.state.calib, rot: window.__pad.state.cssRot,
      flip: window.__pad.osFlip, joined: window.__pad.state.joined, slot: window.__pad.state.slot,
      host: window.__pad.isHost, tall: document.getElementById('stage').classList.contains('tall'),
    }));
  }
  async waitScreen(name, ms = 4000) { return waitUntil(async () => (await this.screen()) === name, ms); }
  async center(sel) {
    return this.eval((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
  }
  visible(sel) { return this.eval((s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; }, sel); }
  text(sel) { return this.eval((s) => document.querySelector(s)?.textContent ?? null, sel); }
  // Scrolls the list holding `sel` so it is centered (no touch). Not
  // scrollIntoView(): that may also scroll the overflow-hidden stage.
  reveal(sel) {
    return this.eval((s) => {
      const el = document.querySelector(s);
      const list = el && el.closest('.scroll');
      if (!list) return;
      let top = 0;
      for (let n = el; n && n !== list; n = n.offsetParent) top += n.offsetTop;
      list.scrollTop = top - (list.clientHeight - el.offsetHeight) / 2;
    }, sel);
  }
  async tapIn(sel) { await this.reveal(sel); await sleep(60); await this.tap(sel); }
  async _touch(type) {
    const touchPoints = [...this.touches.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 8, radiusY: 8, force: 1 }));
    await this.client.send('Input.dispatchTouchEvent', { type, touchPoints });
  }
  async down(id, sel, dx = 0, dy = 0) {
    const c = await this.center(sel);
    if (!c) throw new Error(`${this.label}: ${sel} not visible`);
    this.touches.set(id, { x: c.x + dx, y: c.y + dy });
    await this._touch('touchStart');
    return c;
  }
  async move(id, x, y) { this.touches.set(id, { x, y }); await this._touch('touchMove'); }
  // CDP (Chrome): touchEnd releases exactly the fingers it lists.
  async up(id) {
    const p = this.touches.get(id);
    if (!p) return;
    this.touches.delete(id);
    await this.client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: p.x, y: p.y, id }] });
  }
  async tap(sel) { await this.down(99, sel); await sleep(40); await this.up(99); await sleep(70); }
  // Screen-space vector for a vector in the (possibly CSS-rotated) stage's frame.
  async stageVec(sx, sy) {
    const rot = await this.eval(() => window.__pad.state.cssRot);
    return rot === 90 ? { x: -sy, y: sx } : rot === -90 ? { x: sy, y: -sx } : { x: sx, y: sy };
  }
  // One finger dragged from the center of `sel` by (dx, dy) screen px in small steps.
  async swipe(sel, dx, dy, steps = 12) {
    const c = await this.down(98, sel);
    for (let i = 1; i <= steps; i++) { await this.move(98, c.x + (dx * i) / steps, c.y + (dy * i) / steps); await sleep(16); }
    await this.up(98);
    await sleep(120);
  }
  // Fakes document.visibilityState (screen lock / app switch) and fires visibilitychange.
  setHidden(hidden) {
    return this.eval((h) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  }
  // Captured through our own CDP session so the emulated size is used.
  async shot(name) {
    const f = path.join(OUT, `${this.label}-${name}.png`);
    const { data } = await this.client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    return f;
  }
  // Layout audit of the visible screen: elements sticking out of the stage
  // (outside scrolling lists) and racer / part names cut off.
  layout() {
    return this.eval(() => {
      const stage = document.getElementById('stage').getBoundingClientRect();
      const scr = document.querySelector('.screen.active');
      const out = [];
      const cut = [];
      if (!scr) return { out, cut, screen: null };
      for (const n of scr.querySelectorAll('button, .info-card, .stat-bars, .rc, .pc, .tk-card, .me-card, .wl-row, .pod-col, .tog-row, h2')) {
        if (!n.getClientRects().length || n.closest('.scroll')) continue;
        const r = n.getBoundingClientRect();
        if (r.left < stage.left - 1 || r.top < stage.top - 1 || r.right > stage.right + 1 || r.bottom > stage.bottom + 1) out.push(n.id || n.className || n.tagName);
      }
      for (const n of scr.querySelectorAll('.rc-name, .pc-name, .ic-name, .tk-name, .wl-name, .pod-name')) {
        if (!n.getClientRects().length) continue;
        if (n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 2) cut.push(n.textContent);
      }
      return { out, cut, screen: scr.id };
    });
  }
  async close() { if (this.ctx) await this.ctx.close(); else await this.page.close(); }
}

// Last pad:menu the host logged (optionally of one action / slot).
const lastMenu = (host, action, slot) => [...host.logs.menus].reverse().find((m) => (!action || m.action === action) && (!slot || m.slot === slot)) || null;
const menuJson = (m) => (m ? JSON.stringify(Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'at'))) : 'none');
const hostPlayer = (host, slot) => host.players.get(slot);

// Opens a phone and passes the gate (holding it like a wheel when `hold` is given).
async function joinPhone(browser, cfg) {
  const ph = await Phone.open(browser, cfg);
  if (cfg.hold !== undefined && cfg.hold !== null) await ph.eval((a) => window.__tilt.start(a), cfg.hold);
  await ph.waitScreen('gate');
  await waitUntil(() => ph.eval(() => window.__pad.state.joined), 3000);
  await sleep(150);
  await ph.tap('#btn-gate');
  return ph;
}

// Walks one phone through the select steps with OK taps (a card is only
// tapped when it is not already the one previewed: a second tap confirms).
async function pickAll(ph, { char = null, body = null, wheels = null } = {}) {
  const preview = async (step, id, sel) => {
    if (id && (await ph.eval((k) => window.__pad.pick[k], step)) !== id) await ph.tap(sel);
  };
  await ph.waitScreen('char');
  await preview('char', char, `.rc[data-id='${char}']`);
  await ph.tap("#scr-char [data-act='ok']");
  await ph.waitScreen('body');
  await preview('body', body, `#body-grid .pc[data-id='${body}']`);
  await ph.tap("#scr-body [data-act='ok']");
  await ph.waitScreen('wheels');
  await preview('wheels', wheels, `#wheels-grid .pc[data-id='${wheels}']`);
  await ph.tap("#scr-wheels [data-act='ok']");
  await ph.waitScreen('ready');
}

// The fake host's view catches up with an optimistic phone within this time.
const hostSoon = (fn) => waitUntil(fn, 1500);

// Waits until the server has seen every closed phone go, then frees their
// slots (the desktop does that after 20 s in the menus).
async function releaseClosed(host) {
  await waitUntil(() => [...host.link.players.values()].every((p) => !p.connected || p.slot in openSlots), 4000);
  host.releaseGone();
}
const openSlots = {};                 // slots of phones a scenario keeps open across a release

// A fresh game in the lobby with no leftover players.
async function freshGame(host) {
  await releaseClosed(host);
  host.reset();
  host.clear();
}

async function closeAndRelease(ph, host) {
  await ph.close();
  await releaseClosed(host);
}

// ------------------------------------------------------------------ per orientation: one phone, the controller

async function orientationScenario(browser, host, cfg) {
  const L = cfg.label;
  console.log(`\n=== ${L}: ${cfg.w}x${cfg.h}, screen angle ${cfg.angle}${cfg.angle === 0 ? ' (portrait layout → CSS rotation)' : ''}`);
  await freshGame(host);
  const ph = await Phone.open(browser, { ...cfg });
  try {
    check(`${L} gate screen after load`, await ph.waitScreen('gate'));
    const statusText = () => ph.eval(() => document.getElementById('gate-status-text').textContent);
    await waitUntil(async () => /Connected/.test(await statusText()), 3000);
    const status = await statusText();
    check(`${L} gate shows the connection and our slot`, /Connected as P1/.test(status), status);
    const fresh = await ph.eval(() => ({ s: { ...window.__pad.settings }, m: window.__pad.math }));
    check(`${L} tilt tuning: dead zone 3°, expo 0.55, low-pass 30/s, lock 42°, knee 0.7, steering lock 0.8`, fresh.m.DEAD_ZONE_DEG === 3 && fresh.m.EXPO === EXPO && fresh.m.STEER_LPF_RATE === 30 && fresh.m.LOCK_DEFAULT_DEG === LOCK_DEFAULT && fresh.m.STEER_KNEE === KNEE && fresh.m.STEER_CAP === CAP,
      JSON.stringify({ dz: fresh.m.DEAD_ZONE_DEG, expo: fresh.m.EXPO, lpf: fresh.m.STEER_LPF_RATE, lock: fresh.m.LOCK_DEFAULT_DEG, knee: fresh.m.STEER_KNEE, cap: fresh.m.STEER_CAP }));
    // The curve itself (pad.js shapeSteer): v3 below the knee, a hard lock at 0.8, monotone.
    const curve = await ph.eval((lock) => {
      const f = window.__pad.math.shapeSteer;
      const v3 = (d) => { const m = Math.abs(d); if (m <= 3) return 0; const u = Math.min(1, (m - 3) / (lock - 3)); return Math.sign(d) * (0.45 * u + 0.55 * u ** 3); };
      let maxDiff = 0, mono = true, prev = -1;
      for (let d = 0; d <= 30; d += 0.25) maxDiff = Math.max(maxDiff, Math.abs(f(d, lock) - v3(d)), Math.abs(f(-d, lock) - v3(-d)));
      for (let d = 0; d <= 70; d += 0.1) { const v = f(d, lock); if (v < prev - 1e-12) mono = false; prev = v; }
      return { maxDiff, mono, lock: f(lock, lock), past: [f(lock + 4, lock), f(lock + 18, lock), f(-lock - 30, lock)], at35: f(35, lock), lock30: f(30, 30) };
    }, LOCK_DEFAULT);
    check(`${L} curve below 30° identical to v3 (small adjustments unchanged)`, curve.maxDiff < 1e-9, `max diff ${curve.maxDiff}`);
    check(`${L} curve: steering lock 0.8 at 42°, flat beyond (+4°/+18°/−72° → ±0.8)`, Math.abs(curve.lock - CAP) < 1e-9 && curve.past.every((v, i) => Math.abs(Math.abs(v) - CAP) < 1e-9 && Math.sign(v) === (i < 2 ? 1 : -1)), JSON.stringify(curve));
    check(`${L} curve monotone, soft knee (35° → ${shapedSteer(35).toFixed(3)}), lock scales with sensitivity`, curve.mono && near(curve.at35, shapedSteer(35), 1e-9) && Math.abs(curve.lock30 - CAP) < 1e-9, JSON.stringify({ mono: curve.mono, at35: curve.at35 }));
    check(`${L} fresh phone: full lock 42°, Auto-Gas ON, Steer Assist ON`, fresh.s.lockDeg === LOCK_DEFAULT && fresh.s.autoGas === true && fresh.s.assist === true, JSON.stringify(fresh.s));
    // The desktop buzzes the phone as it joins, before any tap: Chrome blocks
    // navigator.vibrate until the first user gesture and logs a console error,
    // so pad.js must not call it yet.
    await ph.eval(() => {
      window.__vibCalls = [];
      window.__vibOrig = navigator.vibrate;
      navigator.vibrate = (p) => { window.__vibCalls.push(p); return true; };
      Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { hasBeenActive: false, isActive: false } });
    });
    host.event('vibrate', { pattern: [40] }, 1);
    await sleep(250);
    const vibBlocked = await ph.eval(() => window.__vibCalls.length);
    await ph.eval(() => { delete navigator.userActivation; navigator.vibrate = window.__vibOrig; });
    check(`${L} buzz before the first tap → navigator.vibrate not called`, vibBlocked === 0, `${vibBlocked} calls`);
    const angleSeen = await ph.eval(() => screen.orientation.angle);
    check(`${L} emulated screen angle is ${cfg.angle}`, angleSeen === cfg.angle, String(angleSeen));
    await ph.shot('1-gate');

    // Hold the phone like a wheel, then tap the gate.
    await ph.eval((a) => window.__tilt.start(a), cfg.hold);
    await sleep(350);
    await ph.tap('#btn-gate');
    check(`${L} lobby after the gate`, await ph.waitScreen('lobby'));
    await sleep(400);
    let p = await ph.pad();
    check(`${L} steering source = orientation`, p.src === 'orientation', p.src);
    check(`${L} effective UI angle = ${cfg.expectUi}`, p.ui === cfg.expectUi, `ui ${p.ui}, css ${p.rot}, flip ${p.flip}`);
    check(`${L} upright wheel → steer ≈ 0`, near(p.steer, 0, 0.02), fmt(p.steer));
    check(`${L} lobby: "P1" + crown + host controls`, (await ph.text('#ya-tag')) === 'P1' && await ph.visible('.ya-crown') && await ph.visible('#seg-mode') && await ph.visible("[data-act='start']"));
    await ph.shot('2-lobby');

    // Steering sign + magnitude: clockwise = right = positive.
    for (const phi of [20, -20, 35, 2.5]) {
      await ph.eval((v) => window.__tilt.set(v, 15), phi);
      await sleep(400);
      p = await ph.pad();
      const exp = expectedSteer(phi, 15, p.calib);
      check(`${L} wheel ${phi > 0 ? 'clockwise' : 'counter-clockwise'} ${Math.abs(phi)}° → steer ${exp.toFixed(3)}`, near(p.steer, exp, 0.03),
        `steer ${fmt(p.steer)}, θ ${p.raw.toFixed(2)}°`);
      const last = host.logs.lastBySlot[1];
      if (phi !== 2.5) check(`${L} host receives steer sign ${phi > 0 ? '+' : '−'} (slot 1)`, last && last.slot === 1 && Math.sign(last.s) === Math.sign(phi) && near(last.s, exp, 0.05), last && fmt(last.s));
    }
    // Wheel grip: the steering does not depend on how far the screen is
    // tilted back (phone held low / in the lap), and full lock stays reachable.
    {
      await ph.eval(() => window.__tilt.set(20, 15));
      await sleep(400);
      const upright = (await ph.pad()).steer;
      await ph.eval(() => window.__tilt.set(20, 50));
      await sleep(450);
      p = await ph.pad();
      check(`${L} wheel 20° with the screen tilted back 50° → same steer as at 15°`, near(p.steer, upright, 0.02) && near(p.steer, expectedSteer(20, 50, p.calib), 0.03), `${fmt(p.steer)} vs ${fmt(upright)}`);
      await ph.eval((deg) => window.__tilt.set(deg, 56), LOCK_DEFAULT + 4);
      await sleep(450);
      p = await ph.pad();
      check(`${L} wheel ${LOCK_DEFAULT + 4}° tilted back 56° → steering lock (0.8)`, atCap(p.steer), fmt(p.steer));
    }
    // Flat tilting: phone lying almost flat, right edge dipped 15° → steer right.
    for (const r of [15, -15]) {
      await ph.eval((deg) => { const d = deg * Math.PI / 180; window.__tilt.setUp(-Math.sin(d), 0.12, Math.cos(d)); }, r);
      await sleep(450);
      p = await ph.pad();
      const exp = expectedSteer(Math.asin(Math.sin(r * Math.PI / 180) / Math.hypot(1, 0.12)) * 180 / Math.PI, 0, p.calib);
      check(`${L} flat phone, ${r > 0 ? 'right' : 'left'} edge down 15° → steer ${exp.toFixed(3)}`, near(p.steer, exp, 0.03), fmt(p.steer));
    }
    // Low-pass: a step to full lock reaches ~63% in 1/30 s and settles fast.
    {
      await ph.eval(() => window.__tilt.set(0, 15));
      await sleep(350);
      await ph.eval((deg) => window.__tilt.set(deg, 15), LOCK_DEFAULT + 8);
      await sleep(150);
      p = await ph.pad();
      check(`${L} 30/s low-pass: steering lock within 150 ms of a step`, atCap(p.steer), fmt(p.steer));
      await ph.eval(() => window.__tilt.set(0, 15));
      await sleep(300);
    }

    // Menus (taps follow the CSS rotation): START → char → body → wheels → ready → GO.
    await ph.tap("[data-act='start']");
    check(`${L} START → character screen`, await ph.waitScreen('char'));
    await sleep(200);
    // roster-agnostic (characters.js is the user's): the second racer of the roster and its own short name
    const pickDef = host.characters[1];
    await ph.tap(`.rc[data-id='${pickDef.id}']`);
    const picked = await ph.eval(() => ({ sel: [...document.querySelectorAll('.rc.selected')].map((c) => c.dataset.id), name: document.getElementById('ci-name').textContent }));
    check(`${L} tap a racer → previewed (name + highlight), nothing sent yet`, picked.sel.join() === pickDef.id && picked.name === String(pickDef.shortName || pickDef.name) && !lastMenu(host, 'char'), JSON.stringify(picked));
    await ph.shot('3-char');
    await ph.tap(`.rc[data-id='${pickDef.id}']`);                        // second tap = OK
    check(`${L} second tap on the picked racer confirms → body screen`, await ph.waitScreen('body') && await hostSoon(() => hostPlayer(host, 1).choice.char === pickDef.id));
    await ph.tap("#body-grid .pc[data-id='speedster']");
    await ph.tap("#scr-body [data-act='ok']");
    check(`${L} body OK → wheels`, await ph.waitScreen('wheels') && await hostSoon(() => hostPlayer(host, 1).choice.body === 'speedster'));
    await ph.tap("#scr-wheels [data-act='ok']");
    check(`${L} wheels OK → ready card`, await ph.waitScreen('ready') && await hostSoon(() => hostPlayer(host, 1).step === 'ready'));
    const tg = await ph.eval(() => [document.getElementById('tg-assist').checked, document.getElementById('tg-autogas').checked]);
    check(`${L} ready card: Steer Assist + Auto-Gas ON by default`, tg.join() === 'true,true', tg.join());
    await ph.shot('4-ready');
    await ph.tap("[data-act='ready']");
    check(`${L} READY (the only player) → host's track screen`, await ph.waitScreen('track'));
    await ph.shot('5-track');

    // Hold the wheel slightly turned: auto-center at the countdown absorbs it.
    await ph.eval(() => window.__tilt.set(6, 15));
    await ph.tap("[data-act='go']");
    check(`${L} GO → loading → race screen`, await ph.waitScreen('race', 5000));
    await waitUntil(() => host.game.race.state === 'countdown', 4000);
    await sleep(500);
    p = await ph.pad();
    check(`${L} auto-center at countdown`, near(p.calib, p.raw, 0.6) && Math.abs(p.calib) > 4 && near(p.steer, 0, 0.02),
      `calib ${p.calib.toFixed(2)}°, θ ${p.raw.toFixed(2)}°, steer ${fmt(p.steer)}`);
    const cd = await ph.text('#countdown');
    check(`${L} countdown number shown`, /^[123]$/.test(cd), cd);
    await ph.shot('6-countdown');
    await waitUntil(() => host.game.race.state === 'racing', 4000);
    await sleep(300);
    check(`${L} Auto-Gas: throttle on without touching GAS once racing`, host.logs.lastBySlot[1]?.g === 1, JSON.stringify(host.logs.lastBySlot[1]));
    await ph.eval(() => window.__tilt.set(0, 15));
    await sleep(350);
    p = await ph.pad();
    check(`${L} after auto-center, level wheel steers left a bit`, p.steer < -0.03, fmt(p.steer));
    await ph.tap('#btn-center');
    await sleep(300);
    p = await ph.pad();
    check(`${L} CENTER button re-centers`, near(p.calib, 0, 0.6) && near(p.steer, 0, 0.02), `calib ${p.calib.toFixed(2)}, steer ${fmt(p.steer)}`);

    // Steer Assist pip: lit while the desktop says the assist is steering.
    host.setScreen({ screen: 'race', race: 'racing', item: 'rocket', place: 2, lap: 2, assistActive: '1', auto: '0' });
    await sleep(250);
    let pip = await ph.eval(() => ({ on: document.getElementById('assist-pip').classList.contains('on'), lit: document.getElementById('assist-pip').classList.contains('active') }));
    check(`${L} assist pip shown + lit while assisting`, pip.on && pip.lit, JSON.stringify(pip));
    await ph.shot('7-race-assist');
    host.setScreen({ screen: 'race', assistActive: '0' });
    await sleep(250);
    pip = await ph.eval(() => ({ on: document.getElementById('assist-pip').classList.contains('on'), lit: document.getElementById('assist-pip').classList.contains('active') }));
    check(`${L} assist pip dim while not assisting`, pip.on && !pip.lit, JSON.stringify(pip));
    const icon = await ph.text('#item-icon');
    check(`${L} item icon from the pad state`, icon === ITEM_INFO.rocket.icon, icon);
    const readout = await ph.eval(() => `${document.getElementById('place').textContent} ${document.getElementById('lap-num').textContent}`);
    check(`${L} place + lap readout`, /^2nd\/8 2$/.test(readout), readout);

    // Steering lock feedback: wheel graphic at its end stop, meter lit, one short buzz.
    await ph.eval(() => { window.__vibCalls = []; window.__vibOrig = navigator.vibrate; navigator.vibrate = (pt) => { window.__vibCalls.push(pt); return true; }; });
    await ph.eval((deg) => window.__tilt.set(deg, 15), LOCK_DEFAULT + 9);
    await sleep(450);
    let lk = await ph.eval(() => ({ steer: window.__pad.steer, at: window.__pad.atLock, meter: document.getElementById('tilt-meter').classList.contains('at-lock'), wheel: document.getElementById('wheel').style.transform, vib: window.__vibCalls.slice() }));
    check(`${L} past the lock: steer 0.8, wheel at its end stop (rotate 110°), meter lit, buzz 15 ms`,
      atCap(lk.steer) && lk.at && lk.meter && lk.wheel === 'rotate(110deg)' && lk.vib.filter((v) => v === 15).length === 1, JSON.stringify(lk));
    await ph.shot('7b-race-lock');
    await ph.eval(() => window.__tilt.set(0, 15));
    await sleep(400);
    lk = await ph.eval(() => ({ at: window.__pad.atLock, meter: document.getElementById('tilt-meter').classList.contains('at-lock') }));
    check(`${L} back from the lock → indicator off`, !lk.at && !lk.meter, JSON.stringify(lk));

    // Every item config knows renders its icon (+ count for multi-use items) and colour ring.
    {
      const bad = [];
      for (const id of ITEM_IDS) {
        const info = ITEM_INFO[id];
        if (!info) { bad.push(`${id}: no ITEM_INFO`); continue; }
        const uses = Math.max(1, Number(info.uses) || (/^triple_/.test(id) ? 3 : 1));
        host.setScreen({ screen: 'race', item: id, count: String(uses), rolling: '0' });
        const read = () => ph.eval(() => ({ icon: document.getElementById('item-icon').textContent, count: document.getElementById('item-count').textContent, ring: document.getElementById('btn-item').style.getPropertyValue('--item-c').trim(), label: document.getElementById('btn-item').getAttribute('aria-label') }));
        const want = { icon: info.icon, count: uses > 1 ? String(uses) : '', ring: info.color };
        const good = (ui) => ui.icon === want.icon && ui.count === want.count && ui.ring.toLowerCase() === String(want.ring).toLowerCase() && ui.label.includes(info.name);
        const ok = await waitUntil(async () => good(await read()), 1500);   // (items may share an icon: wait for all of it)
        if (!ok) bad.push(`${id}: ${JSON.stringify(await read())} want ${JSON.stringify(want)}`);
      }
      check(`${L} all ${ITEM_IDS.length} config items: icon, count, colour ring`, bad.length === 0, bad.join('; '));
    }

    // Race alerts: incoming Capo Crusher (siren banner + rhythmic buzz), Beer Rocket autopilot, espresso splat.
    await ph.eval(() => { window.__vibCalls = []; });
    host.setScreen({ screen: 'race', item: 'none', warn: 'capo' });
    await sleep(350);
    let al = await ph.eval(() => { const w = document.getElementById('race-warn'); return { cls: w.className, text: w.textContent, stage: document.getElementById('stage').classList.contains('capo-warn'), vib: window.__vibCalls.slice() }; });
    check(`${L} padState warn 'capo' → siren banner + red edge + buzz`, /\bshow\b/.test(al.cls) && /\bcapo\b/.test(al.cls) && /CAPO CRUSHER/.test(al.text) && al.stage && al.vib.some((v) => Array.isArray(v) && v.join() === '90,60,90'), JSON.stringify(al));
    await ph.shot('7c-race-capo');
    host.setScreen({ screen: 'race', warn: '' });
    await sleep(300);
    al = await ph.eval(() => ({ cls: document.getElementById('race-warn').className, stage: document.getElementById('stage').classList.contains('capo-warn') }));
    check(`${L} warning cleared → banner hidden`, !/\bshow\b/.test(al.cls) && !al.stage, JSON.stringify(al));
    host.setScreen({ screen: 'race', beer: '1' });
    await sleep(300);
    al = await ph.eval(() => { const w = document.getElementById('race-warn'); return { cls: w.className, text: w.textContent }; });
    check(`${L} Beer Rocket running → AUTOPILOT banner`, /\bbeer\b/.test(al.cls) && /\bshow\b/.test(al.cls) && /AUTOPILOT/.test(al.text), JSON.stringify(al));
    host.setScreen({ screen: 'race', beer: '0' });
    await ph.eval(() => { window.__vibCalls = []; });
    host.setScreen({ screen: 'race', splash: '0.8' });
    await sleep(300);
    al = await ph.eval(() => ({ vib: window.__vibCalls.slice(), splat: document.getElementById('flash').classList.contains('splat'), cls: document.getElementById('race-warn').className }));
    check(`${L} espresso on my screen → splat buzz + coffee flash`, al.vib.some((v) => Array.isArray(v) && v.join() === '40,30,110') && al.splat && !/\bshow\b/.test(al.cls), JSON.stringify(al));
    host.setScreen({ screen: 'race', splash: '0', item: 'rocket' });
    await ph.eval(() => { navigator.vibrate = window.__vibOrig; });
    await sleep(200);
    // v5 lire: padState race.coins → a ₤ counter next to the lap, gold at the cap, inside the top bar
    host.setScreen({ screen: 'race', coins: '7' });
    await sleep(300);
    const lire = () => ph.eval(() => {
      const c = document.getElementById('coins'), r = c.getBoundingClientRect(), bar = document.getElementById('race-readout').parentElement.getBoundingClientRect();
      return { on: c.classList.contains('on'), max: c.classList.contains('max'), text: document.getElementById('coins-num').textContent, w: r.width, inBar: r.left >= bar.left - 1 && r.right <= bar.right + 1 };
    });
    let li = await lire();
    check(`${L} padState race.coins → lire counter (7)`, li.on && li.text === '7' && li.w > 0 && li.inBar && !li.max, JSON.stringify(li));
    host.setScreen({ screen: 'race', coins: '10' });
    await sleep(300);
    li = await lire();
    check(`${L} lire at the cap → gold`, li.on && li.text === '10' && li.max, JSON.stringify(li));
    await ph.shot('7d-race-lire');
    host.setScreen({ screen: 'race', coins: '0' });

    // BRAKE overrides Auto-Gas; then Auto-Gas off in settings → manual buttons.
    host.clear();
    await ph.down(4, '#btn-brake');
    await sleep(150);
    let last = host.logs.lastBySlot[1];
    check(`${L} BRAKE held → b=1, Auto-Gas lets go (g=0)`, last && last.b === 1 && last.g === 0, JSON.stringify(last));
    await ph.up(4);
    await ph.tap('#btn-settings');
    await sleep(350);
    check(`${L} settings sheet opens (Steer Assist switch on)`, await ph.eval(() => document.getElementById('sheet').classList.contains('open') && document.getElementById('set-assist').checked));
    await ph.shot('8-settings');
    await ph.tapIn('#set-autogas');
    await ph.tapIn('#set-invert');
    await ph.eval(() => window.__tilt.set(26, 15));          // ~0.38 steer at the 42° default lock
    await sleep(400);
    p = await ph.pad();
    check(`${L} invert steering flips the sign`, p.steer < -0.3, fmt(p.steer));
    await ph.tapIn('#set-invert');
    await sleep(400);
    p = await ph.pad();
    check(`${L} invert off again`, p.steer > 0.3, fmt(p.steer));
    await ph.tap('#btn-sheet-close');
    await sleep(300);
    check(`${L} Auto-Gas off → no throttle without GAS`, host.logs.lastBySlot[1]?.g === 0 && (await ph.eval(() => window.__pad.settings.autoGas)) === false);

    // Buttons with multi-touch.
    host.clear();
    await ph.down(1, '#btn-gas');
    await ph.down(2, '#btn-drift');
    await sleep(400);
    last = host.logs.lastBySlot[1];
    const pressedCls = await ph.eval(() => ['btn-gas', 'btn-drift', 'btn-brake'].map((id) => document.getElementById(id).classList.contains('pressed')));
    check(`${L} GAS + DRIFT held together → host g=1 d=1, steering right`, last && last.g === 1 && last.d === 1 && last.b === 0 && last.s > 0.3, JSON.stringify(last));
    check(`${L} pressed visuals on GAS + DRIFT only`, pressedCls.join() === 'true,true,false', pressedCls.join());
    await ph.shot('9-race-pressed');
    const seq0 = last.i;
    await ph.down(3, '#btn-item');
    await sleep(60);
    await ph.up(3);
    await sleep(250);
    last = host.logs.lastBySlot[1];
    check(`${L} ITEM tap (third finger) → itemSeq +1, others still held`, last.i === seq0 + 1 && last.g === 1 && last.d === 1, `i ${seq0}→${last.i}`);
    check(`${L} item consumed on the host → slot empties`, await waitUntil(() => ph.eval(() => document.getElementById('btn-item').classList.contains('empty')), 1500));
    await ph.up(1);
    await sleep(150);
    last = host.logs.lastBySlot[1];
    check(`${L} release GAS → g=0 while DRIFT stays held`, last.g === 0 && last.d === 1, JSON.stringify(last));
    await ph.up(2);
    await sleep(150);
    check(`${L} all released → zeros`, host.logs.lastBySlot[1].b === 0 && host.logs.lastBySlot[1].g === 0 && host.logs.lastBySlot[1].d === 0);
    check(`${L} button edges were sent immediately (≥ 5 edges)`, host.logs.edges.length >= 5, `${host.logs.edges.length} edges`);
    const n0 = host.logs.counts.input;
    await sleep(1000);
    const rate = host.logs.counts.input - n0;
    check(`${L} pad:input rate ≈ 60 Hz while racing`, rate >= 45 && rate <= 75, `${rate}/s`);
    await ph.eval(() => window.__tilt.set(0, 15));
    await ph.tap('#btn-settings');
    await sleep(350);
    await ph.tapIn('#set-autogas');                                  // back to the default
    await ph.tap('#btn-sheet-close');
    await sleep(300);

    // Roulette + triple count visuals.
    host.setScreen({ screen: 'race', race: 'racing', item: 'triple_toot', count: 3, place: 1, lap: 3 });
    await sleep(250);
    check(`${L} triple item shows its count`, (await ph.text('#item-count')) === '3');
    host.setScreen({ screen: 'race', item: 'none', rolling: '1' });
    await sleep(300);
    check(`${L} roulette animates while rolling`, await ph.eval(() => document.getElementById('btn-item').classList.contains('rolling')));

    // Pause via the top-bar button (pauseSeq) → paused (host: RESTART + QUIT) → RESUME.
    host.setScreen({ screen: 'race', rolling: '0', item: 'banana' });
    await sleep(200);
    await ph.tap('#btn-pause');
    check(`${L} pause button → host pauses → paused screen`, await ph.waitScreen('paused'));
    check(`${L} paused: host sees RESUME, RESTART and QUIT`, await ph.visible("[data-act='restart']") && await ph.visible("#scr-paused [data-act='quit']"));
    await ph.shot('10-paused');
    await ph.tap("[data-act='resume']");
    check(`${L} RESUME → race screen`, await ph.waitScreen('race'));

    // Finish banner → results (NEXT) → standings.
    host.setScreen({ screen: 'race', race: 'finished', finished: '1', place: 3 });
    await sleep(300);
    check(`${L} finish banner`, await ph.eval(() => document.getElementById('finish-banner').classList.contains('show')));
    await ph.shot('11-finish');
    host.setScreen({ screen: 'results' });
    check(`${L} results screen`, await ph.waitScreen('results'));
    await sleep(250);
    const rows = await ph.eval(() => [...document.querySelectorAll('#res-list li')].map((li) => li.className));
    check(`${L} results: 8 rows, ours highlighted`, rows.length === 8 && rows.filter((c) => c === 'me').length === 1, rows.join());
    await ph.shot('12-results');
    await ph.tap("#scr-results [data-act='next']");
    check(`${L} NEXT → standings`, await ph.waitScreen('standings'));

    // Touch steering mode (settings → TOUCH): drag the knob.
    host.setScreen({ screen: 'race', race: 'racing' });
    await ph.waitScreen('race');
    await ph.tap('#btn-settings');
    await sleep(300);
    await ph.tapIn("#mode-seg button[data-mode='touch']");
    await ph.tap('#btn-sheet-close');
    await sleep(300);
    p = await ph.pad();
    check(`${L} TOUCH mode → touch source`, p.src === 'touch', p.src);
    const dir = await ph.stageVec(1, 0);
    const c = await ph.down(5, '#ts-track');
    await ph.move(5, c.x + dir.x * 150, c.y + dir.y * 150);
    await sleep(300);
    p = await ph.pad();
    check(`${L} drag knob right → steer right`, p.steer > 0.5 && host.logs.lastBySlot[1].s > 0.5, `${fmt(p.steer)} / host ${fmt(host.logs.lastBySlot[1].s)}`);
    await ph.move(5, c.x - dir.x * 80, c.y - dir.y * 80);
    await sleep(300);
    p = await ph.pad();
    check(`${L} drag knob left → steer left`, p.steer < -0.2, fmt(p.steer));
    await ph.up(5);
    await sleep(300);
    check(`${L} release knob → recenters`, near((await ph.pad()).steer, 0, 0.02));
    await ph.tap('#btn-settings');
    await sleep(300);
    await ph.tapIn("#mode-seg button[data-mode='tilt']");
    await ph.tap('#btn-sheet-close');
    await sleep(500);
    check(`${L} back to TILT mode`, (await ph.pad()).src === 'orientation');

    // Desktop leaves → waiting overlay → comes back.
    await host.leave();
    check(`${L} desktop leaves → "waiting for the game" overlay`,
      await waitUntil(() => ph.eval(() => document.getElementById('ov-waiting').classList.contains('show')), 3000));
    await sleep(300);
    await ph.shot('13-waiting');
    await host.join();
    check(`${L} desktop back → overlay hidden`,
      await waitUntil(() => ph.eval(() => !document.getElementById('ov-waiting').classList.contains('show')), 3000));

    // The same controller opened elsewhere (same padId) → "opened somewhere else" → USE THIS ONE.
    const padId = await ph.eval(() => localStorage.getItem('krishivkart.pad.id'));
    const other = ioClient(`https://localhost:${HTTPS_PORT}`, { rejectUnauthorized: false, transports: ['websocket'], forceNew: true });
    await new Promise((r) => other.once('connect', r));
    const hr = await other.timeout(3000).emitWithAck('pad:hello', { room: ROOM, padId });
    check(`${L} same padId from another tab takes over slot 1`, hr.ok === true && hr.slot === 1, JSON.stringify(hr));
    check(`${L} this tab shows the "opened somewhere else" overlay`,
      await waitUntil(() => ph.eval(() => document.getElementById('ov-kicked').classList.contains('show')), 3000));
    await sleep(300);
    await ph.shot('14-kicked');
    const kicked = new Promise((r) => other.once('pad:kicked', r));
    await ph.tap('#btn-reclaim');
    check(`${L} USE THIS ONE → the other tab is replaced`, !!(await Promise.race([kicked, sleep(3000).then(() => null)])));
    check(`${L} this phone drives slot 1 again`, await waitUntil(async () => { const q = await ph.pad(); return q.joined && q.slot === 1; }, 3000));
    other.close();

    if (cfg.angle === 0) {
      // Portrait layout: holding the phone the other way flips the CSS rotation.
      await ph.eval(() => window.__tilt.hold(270));
      await sleep(600);
      p = await ph.pad();
      check(`${L} held the other way → stage rotates −90°`, p.rot === -90 && p.ui === 270, `rot ${p.rot}, ui ${p.ui}`);
      await ph.eval(() => window.__tilt.set(20, 15));
      await sleep(450);
      p = await ph.pad();
      check(`${L} (−90°) clockwise → steer right`, near(p.steer, expectedSteer(20, 15, p.calib), 0.03), fmt(p.steer));
      await ph.eval(() => window.__tilt.set(0, 15));
      await ph.shot('15-race-rot-ccw');
      // Hysteresis: leaning 60° toward the other side must not flip it back.
      await ph.eval(() => { window.__tilt.hold(270); window.__tilt.set(60, 15); });
      await sleep(500);
      check(`${L} hysteresis: 60° lean keeps the rotation`, (await ph.pad()).rot === -90);
      await ph.eval(() => { window.__tilt.set(0, 15); window.__tilt.hold(0); });
      await sleep(1400); // pad.js waits HINT_DELAY_MS (900 ms) of upright pose before hinting
      check(`${L} race: phone upright in portrait → "turn sideways" hint`, await ph.eval(() => document.getElementById('hint-rotate').classList.contains('show')));
      await ph.shot('16-portrait-hint');
      // Menus held upright use the natural portrait layout instead.
      host.setScreen({ screen: 'results' });
      await ph.waitScreen('results');
      await sleep(600);
      p = await ph.pad();
      const hint = await ph.eval(() => document.getElementById('hint-rotate').classList.contains('show'));
      check(`${L} menus held upright → natural portrait layout (no rotation, no hint)`, p.rot === 0 && p.tall && !hint, `rot ${p.rot}, tall ${p.tall}, hint ${hint}`);
      await ph.shot('17-results-upright');
      await ph.eval(() => window.__tilt.hold(90));
      await sleep(600);
      p = await ph.pad();
      check(`${L} menus held sideways again → rotated landscape`, p.rot === 90 && !p.tall, `rot ${p.rot}`);
    }
    host.setScreen({ screen: 'loading' });
    check(`${L} loading screen`, await ph.waitScreen('loading'));
    await ph.shot('18-loading');
  } finally {
    await ph.close();
  }
}

// ------------------------------------------------------------------ four phones at once: the whole game

async function multiScenario(browser, host) {
  console.log('\n=== multi: four phones (L90 / P0 upright / L270 / SE 667x375) + a 5th');
  await freshGame(host);
  const cfgs = [
    { label: 'm-P1', w: 844, h: 390, angle: 90, hold: 90 },
    { label: 'm-P2', w: 390, h: 844, angle: 0, hold: null },          // held upright, no tilt data
    { label: 'm-P3', w: 844, h: 390, angle: 270, hold: 270, ua: ANDROID_UA },
    { label: 'm-P4', w: 667, h: 375, angle: 90, hold: 90 },
  ];
  const ctx1 = await browser.createBrowserContext();              // P1 comes back later with the same padId
  const phones = [];
  let fifth = null;
  try {
    for (const [k, cfg] of cfgs.entries()) {
      const ph = await joinPhone(browser, { ...cfg, context: k === 0 ? ctx1 : null });
      phones.push(ph);
    }
    const [p1, p2, p3, p4] = phones;
    const slots = await Promise.all(phones.map((ph) => ph.eval(() => window.__pad.state.slot)));
    check('multi: four phones take slots 1–4 in join order', slots.join() === '1,2,3,4', slots.join());
    await waitUntil(async () => (await Promise.all(phones.map((ph) => ph.screen()))).every((s) => s === 'lobby'), 3000);
    const tags = await Promise.all(phones.map((ph) => ph.eval(() => ({ tag: document.getElementById('me-tag-text').textContent, me: getComputedStyle(document.getElementById('stage')).getPropertyValue('--me').trim() }))));
    check('multi: each phone shows its own P# tag in its slot color', tags.every((t, k) => t.tag === `P${k + 1}` && t.me.toLowerCase() === SLOT_CSS[k].toLowerCase()), JSON.stringify(tags));
    const hostUi = await Promise.all(phones.map(async (ph) => [await ph.visible('#seg-mode'), await ph.visible('.ya-crown'), await ph.visible('#lob-wait')]));
    check('multi: only P1 has the crown + MODE/CLASS/ITEMS/START; guests see "Waiting for P1…"',
      JSON.stringify(hostUi) === JSON.stringify([[true, true, false], [false, false, true], [false, false, true], [false, false, true]]), JSON.stringify(hostUi));
    check('multi: guests read "Waiting for P1 to start…"', (await p3.text('#lob-wait')) === 'Waiting for P1 to start…');
    check('multi: P2 (upright, no tilt data) gets the natural portrait layout', (await p2.pad()).tall && (await p2.pad()).rot === 0);
    const chips = await p2.eval(() => [...document.querySelectorAll('.slot-chip')].map((c) => c.className.replace('slot-chip', '').trim() + ':' + c.querySelector('.sc-sub').textContent));
    check('multi: lobby slot chips (P1 host, P2 = YOU, all joined)', chips[0].includes('host') && chips[1].includes('me') && chips[1].endsWith('YOU') && chips[3].endsWith('JOINED'), chips.join(' | '));

    // 5th phone → "Game full" until a slot frees up.
    fifth = await Phone.open(browser, { w: 844, h: 390, angle: 90, label: 'm-P5' });
    check('multi: a 5th phone gets the "Game full" screen', await fifth.waitScreen('full', 4000));
    await fifth.shot('full');

    // Host controls: VS · 150cc · items off.
    await p1.tap("#seg-mode button[data-v='vs']");
    await p1.tap("#seg-cc button[data-v='150']");
    await sleep(200);
    check('multi: ITEMS control appears for VS only', await p1.visible('#seg-items'));
    await p1.tap("#seg-items button[data-v='off']");
    await sleep(300);
    check('multi: host lobby controls relayed (mode vs, 150cc, items off)', host.game.mode === 'vs' && host.game.cc === 150 && host.game.items === false,
      JSON.stringify({ mode: host.game.mode, cc: host.game.cc, items: host.game.items }));
    check('multi: guests see the settings line', (await p4.text('#lob-settings')) === 'VS Race · 150cc · Items off', await p4.text('#lob-settings'));
    for (const ph of phones) await ph.shot('1-lobby');

    await p1.tap("[data-act='start']");
    check('multi: host START → every phone on CHARACTER',
      await waitUntil(async () => (await Promise.all(phones.map((ph) => ph.screen()))).every((s) => s === 'char'), 4000));
    await sleep(300);
    check('multi: guests have no BACK on the character screen (host only)', !(await p2.visible('#ci-back')) && await p1.visible('#ci-back'));
    const rowsLab = await p2.eval(() => [...document.querySelectorAll('.char-row')].map((r) => `${r.querySelector('.cr-label').textContent}:${r.querySelectorAll('.rc').length}`));
    check('multi: character grid = Light / Medium / Heavy rows of 4 + Custom row', rowsLab.join() === 'LIGHT:4,MEDIUM:4,HEAVY:4,CUSTOM:1', rowsLab.join());
    const art = await p2.eval(() => {
      const a = document.querySelector(".rc[data-id='sahur'] .art");
      return { img: !!a.querySelector('img'), noimg: a.classList.contains('noimg'), init: a.querySelector('.art-init').textContent, c: a.style.getPropertyValue('--c') };
    });
    check('multi: portrait from characters[].img, or the color card with the initial', (art.img && !art.noimg) || (art.noimg && art.init === 'R' && /^#/.test(art.c)), JSON.stringify(art));

    // Each phone picks its own racer at its own pace.
    await p2.tap(".rc[data-id='custom_robo']");
    const quote = await p2.eval(() => [document.getElementById('ci-name').textContent, document.getElementById('ci-class').textContent]);
    check('multi: custom racer preview (name + CUSTOM badge)', quote.join() === 'Robo Rex,CUSTOM', quote.join());
    await p1.tap(".rc[data-id='bombardiro']");
    const ci = await p1.eval(() => ({ q: document.getElementById('ci-quote').textContent, bars: [...document.querySelectorAll('#ci-stats .sb-num')].map((n) => n.textContent) }));
    check('multi: character info: catchphrase + 4 stat bars (Tricheco H2: 4/2/2/4)', ci.q.length > 4 && ci.bars.join() === '4,2,2,4', JSON.stringify(ci));
    for (const ph of [p1, p2]) await ph.shot('2-char');
    await Promise.all([
      pickAll(p1, { char: 'bombardiro', body: 'tank', wheels: 'monster' }),
      pickAll(p2, { char: 'custom_robo', body: 'feather', wheels: 'neon' }),
      pickAll(p3, { char: 'ballerina', body: 'rocket', wheels: 'slick' }),
    ]);
    // P4: step back from WHEELS to BODY once, and check the body stat deltas against parts.js.
    await p4.waitScreen('char');
    await p4.tap(".rc[data-id='tralalero']");
    await p4.tap("#scr-char [data-act='ok']");
    await p4.waitScreen('body');
    await p4.tap("#body-grid .pc[data-id='speedster']");
    const bodyBars = await p4.eval(() => [...document.querySelectorAll('#bi-stats .sb-row')].map((r) => `${r.className.replace('sb-row', '').trim() || '='}${r.querySelector('.sb-num').textContent}`));
    const ronz = host.characters.find((c) => c.id === 'tralalero');
    const exp = computeRatings(ronz, { body: 'speedster', wheels: 'standard' });
    check('multi: body screen stat bars = parts.js computeRatings with +/− vs the racer (Speedster: SPD +1, ACC −½, HND −½)',
      bodyBars.join() === 'up+1,down−½,down−½,=3' && exp.speed === 4 && exp.accel === 2.5, `${bodyBars.join()} / ${JSON.stringify(exp)}`);
    await p4.shot('3-body');
    await p4.tap("#scr-body [data-act='ok']");
    await p4.waitScreen('wheels');
    await p4.tap("#scr-wheels [data-act='back']");
    check('multi: BACK on wheels → body (P4)', await p4.waitScreen('body') && await hostSoon(() => hostPlayer(host, 4).step === 'body'));
    await p4.tap("#scr-body [data-act='ok']");
    await p4.waitScreen('wheels');
    await p4.tap("#wheels-grid .pc[data-id='offroad']");
    const wBars = await p4.eval(() => [...document.querySelectorAll('#wi-stats .sb-num')].map((n) => n.textContent));
    check('multi: wheels screen = final ratings with body + wheels (Ronzella + Speedster + Mud Grippers)', wBars.join() === '+1,−½,−1,+½', wBars.join());
    await p4.shot('4-wheels');
    await p4.tap("#scr-wheels [data-act='ok']");
    await p4.waitScreen('ready');
    const picks = [1, 2, 3, 4].map((s) => { const c = hostPlayer(host, s).choice; return `${c.char}/${c.body}/${c.wheels}`; });
    check('multi: every phone\'s own picks reached the host', picks.join() === 'bombardiro/tank/monster,custom_robo/feather/neon,ballerina/rocket/slick,tralalero/speedster/offroad', picks.join());
    // P3 turns Steer Assist off on its ready card.
    await p3.tap('#tg-assist');
    await sleep(300);
    check('multi: ready-card Steer Assist off → assist {value:false} from P3 only', await hostSoon(() => hostPlayer(host, 3).choice.assist === false) && hostPlayer(host, 1).choice.assist === true,
      menuJson(lastMenu(host, 'assist', 3)));
    await p3.shot('5-ready');
    await p1.tap("[data-act='ready']");
    await p3.tap("[data-act='ready']");
    check('multi: ready phones see the waiting list', await p1.waitScreen('waiting') && await p3.waitScreen('waiting'));
    await sleep(300);
    const wl = await p1.eval(() => [...document.querySelectorAll('#wl-list .wl-row')].map((r) => `${r.querySelector('.slot-tag').textContent}:${r.querySelector('.wl-status').textContent}`));
    check('multi: waiting list shows everyone\'s status', wl.join() === 'P1:READY,P2:CHOOSING,P3:READY,P4:CHOOSING', wl.join());
    await p1.shot('6-waiting');
    await p3.tap("#scr-waiting [data-act='back']");
    check('multi: CHANGE on the waiting list → back to the ready card (un-ready)', await p3.waitScreen('ready') && await hostSoon(() => hostPlayer(host, 3).ready === false));
    await p3.tap("[data-act='ready']");
    await p2.tap("[data-act='ready']");
    await p4.tap("[data-act='ready']");
    check('multi: all ready → P1 gets the track screen, others "P1 is choosing…"', await p1.waitScreen('track') && await p2.waitScreen('trackwait') && await p4.waitScreen('trackwait'));
    check('multi: "P1 is choosing the track…"', (await p2.text('#tw-title')) === 'P1 is choosing the track…', await p2.text('#tw-title'));
    const cards = await p1.eval(() => [...document.querySelectorAll('#tk-cards .tk-card')].map((c) => c.dataset.id));
    const wantCards = [...host.tracks.map((t) => t.id), 'random'];
    check(`multi: VS track cards = all ${host.tracks.length} tracks + Random`, cards.join() === wantCards.join(), cards.join());
    await p1.tap(".tk-card[data-id='monte']");
    await sleep(250);
    check('multi: track pick relayed', host.game.track === 'monte' && (await p2.text('#tw-sub')).includes('Monte'), await p2.text('#tw-sub'));
    await p1.shot('7-track');
    await p2.shot('7-trackwait');
    await p1.tap("[data-act='go']");
    check('multi: GO → every phone on the race controller',
      await waitUntil(async () => (await Promise.all(phones.map((ph) => ph.screen()))).every((s) => s === 'race'), 5000));
    check('multi: the 5th phone is still waiting for a free slot', (await fifth.screen()) === 'full');

    // Race: per-slot input + assist pip per player.
    host.setScreen({ screen: 'race', race: 'racing', auto: '0', assistActive: '1' });
    await sleep(300);
    host.clear();
    await p1.eval(() => window.__tilt.set(25, 15));
    await p2.down(1, '#btn-brake');
    await p4.down(1, '#btn-drift');
    await sleep(350);
    const L = host.logs.lastBySlot;
    check('multi: inputs are tagged per slot (P1 steers right, P2 brakes, P4 drifts)',
      L[1]?.s > 0.3 && L[2]?.b === 1 && L[2]?.g === 0 && L[4]?.d === 1 && Math.abs(L[3]?.s ?? 1) < 0.05 && L[1]?.b === 0,
      JSON.stringify([1, 2, 3, 4].map((s) => L[s] && { s: L[s].s, g: L[s].g, b: L[s].b, d: L[s].d })));
    await p2.up(1);
    await p4.up(1);
    await p1.eval(() => window.__tilt.set(0, 15));
    const pips = await Promise.all(phones.map((ph) => ph.eval(() => { const e = document.getElementById('assist-pip'); return `${e.classList.contains('on') ? 'on' : 'off'}${e.classList.contains('active') ? '+lit' : ''}`; })));
    check('multi: assist pip lit for assisted players, hidden for P3 (assist off)', pips.join() === 'on+lit,on+lit,off,on+lit', pips.join());
    for (const ph of phones) await ph.shot('8-race');
    const seq = host.logs.lastBySlot[2]?.i ?? 0;
    await p2.tap('#btn-item');
    await sleep(200);
    check('multi: P2 ITEM → itemSeq +1 on slot 2', host.logs.lastBySlot[2]?.i === seq + 1);

    // A guest pauses; RESTART / QUIT stay host-only; another guest resumes.
    await p3.tap('#btn-pause');
    check('multi: P3 (guest) pauses → paused on every phone',
      await waitUntil(async () => (await Promise.all(phones.map((ph) => ph.screen()))).every((s) => s === 'paused'), 3000));
    const pausedUi = await Promise.all(phones.map(async (ph) => [await ph.visible("#scr-paused [data-act='resume']"), await ph.visible("[data-act='restart']"), await ph.text('#paused-by')]));
    check('multi: RESUME for all, RESTART/QUIT for P1 only, "P3 paused the race"',
      pausedUi[0][1] && !pausedUi[1][1] && !pausedUi[3][1] && pausedUi.every((u) => u[0]) && pausedUi[0][2] === 'P3 paused the race' && pausedUi[2][2] === 'You paused the race', JSON.stringify(pausedUi));
    await p2.shot('9-paused');
    await p2.tap("#scr-paused [data-act='resume']");
    check('multi: P2 resumes → race on every phone',
      await waitUntil(async () => (await Promise.all(phones.map((ph) => ph.screen()))).every((s) => s === 'race'), 3000));

    // Results → standings → (VS) track pick again → LOBBY.
    host.setScreen({ screen: 'results' });
    await waitUntil(async () => (await Promise.all(phones.map((ph) => ph.screen()))).every((s) => s === 'results'), 3000);
    await sleep(250);
    const mine = await Promise.all(phones.map((ph) => ph.eval(() => document.querySelector('#res-list li.me .slot-tag')?.textContent)));
    check('multi: results mirrored, each phone highlights its own row', mine.join() === 'P1,P2,P3,P4', mine.join());
    check('multi: results: NEXT/LOBBY for the host only, guests "Waiting for P1…"',
      await p1.visible("#scr-results [data-act='next']") && !(await p2.visible("#scr-results [data-act='next']")) && await p2.visible('#scr-results .wait-pill'));
    for (const ph of [p1, p2, p4]) await ph.shot('10-results');
    await p2.tap('#res-list');                                        // guests cannot advance
    await p1.tap("#scr-results [data-act='next']");
    await p1.tap(".screen.active [data-act='next']");                 // a double-tap: the 2nd NEXT is ignored
    check('multi: host NEXT → standings everywhere',
      await waitUntil(async () => (await Promise.all(phones.map((ph) => ph.screen()))).every((s) => s === 'standings'), 3000));
    check('multi: standings NEXT label (VS) = NEXT RACE', (await p1.text('#std-next')) === 'NEXT RACE');
    check('multi: the host\'s NEXT double-tap did not skip the standings', host.game.screen === 'standings', host.game.screen);
    await p1.shot('11-standings');
    await sleep(400);                                                 // (a NEXT double-tap within 350 ms is ignored)
    await p1.tap("#scr-standings [data-act='next']");
    check('multi: VS standings NEXT → track pick again', await p1.waitScreen('track') && await p3.waitScreen('trackwait'));
    await p1.tap("#scr-track [data-act='back']");
    check('multi: host BACK on the track screen → select (host un-readied)', await p1.waitScreen('ready'));
    host.setScreen({ screen: 'lobby' });
    await waitUntil(async () => (await Promise.all(phones.map((ph) => ph.screen()))).every((s) => s === 'lobby'), 3000);

    // Grand Prix: cup card, 2 races, standings, podium, back to the lobby.
    await p1.tap("#seg-mode button[data-v='gp']");
    await sleep(150);
    check('multi: ITEMS hidden for Grand Prix', !(await p1.visible('#seg-items')));
    await p1.tap("[data-act='start']");
    await Promise.all(phones.map(async (ph) => { await pickAll(ph); await ph.tap("[data-act='ready']"); }));
    // Cups (SPEC §15.3): one card per cup with its race count and tracks; the host picks one.
    const cupsWant = host.cups;
    check(`multi: GP track screen = ${cupsWant.length} cup card(s) (${cupsWant.map((c) => c.name).join(', ')}) + GO`, await p1.waitScreen('track') && (await p1.text('#tk-cards .tk-card.cup .tk-name')) === cupsWant[0].name);
    const cupCards = await p1.eval(() => [...document.querySelectorAll('#tk-cards .tk-card.cup')].map((c) => ({ id: c.dataset.id, name: c.querySelector('.tk-name').textContent, count: c.querySelector('.tk-count')?.textContent, list: [...c.querySelectorAll('.tk-list li')].map((li) => li.textContent), sel: c.classList.contains('selected') })));
    const trackName = (id) => (host.tracks.find((t) => t.id === id) || { name: id }).name;
    check('multi: each cup card lists its tracks in order + the race count, the first one selected',
      cupCards.length === cupsWant.length && cupCards.every((c, i) => c.id === cupsWant[i].id && c.count === `${cupsWant[i].tracks.length} RACE${cupsWant[i].tracks.length === 1 ? '' : 'S'}` && c.list.join('|') === cupsWant[i].tracks.map(trackName).join('|') && c.sel === (i === 0)),
      JSON.stringify(cupCards));
    if (cupsWant.some((c) => c.id === 'gelato') && cupsWant.some((c) => c.id === 'krishiv')) {
      const g = cupsWant.find((c) => c.id === 'gelato'), k = cupsWant.find((c) => c.id === 'krishiv');
      check('multi: Gelato Cup = 4 races, Krishiv Cup = 5 races ending at the palace', g.tracks.length === 4 && k.tracks.length === 5 && k.tracks[4] === 'palace', `${g.tracks.join(',')} | ${k.tracks.join(',')}`);
    }
    let gpCup = cupsWant[0];
    if (cupsWant.length > 1) {
      gpCup = cupsWant[cupsWant.length - 1];
      await p1.tap(`.tk-card.cup[data-id='${gpCup.id}']`);
      check(`multi: tapping the ${gpCup.name} → pad:menu cup {id} → the desktop's cup + selection`,
        await hostSoon(() => host.game.cup === gpCup.id) && lastMenu(host, 'cup')?.id === gpCup.id &&
        await waitUntil(() => p1.eval((id) => document.querySelector(`.tk-card.cup[data-id='${id}']`).classList.contains('selected') && document.querySelectorAll('.tk-card.cup.selected').length === 1, gpCup.id), 1500),
        menuJson(lastMenu(host, 'cup')));
      check('multi: guests see the picked cup while P1 chooses', await waitUntil(async () => (await p2.text('#tw-sub')).includes(gpCup.name), 1500), await p2.text('#tw-sub'));
      check('multi: the side panel names the picked cup', (await p1.text('#tk-name')) === gpCup.name, await p1.text('#tk-name'));
    }
    await p1.shot('12-gp-track');
    await p1.tap("[data-act='go']");
    await waitUntil(async () => (await Promise.all(phones.map((ph) => ph.screen()))).every((s) => s === 'race'), 5000);
    const nRaces = gpCup.tracks.length;
    check(`multi: GP of ${nRaces} races on the ${gpCup.name}: race 1 = ${gpCup.tracks[0]}`, host.game.trackId === gpCup.tracks[0], host.game.trackId);
    for (let r = 1; r <= nRaces; r++) {
      host.setScreen({ screen: 'results' });
      await p1.waitScreen('results');
      await sleep(400);
      await p1.tap("#scr-results [data-act='next']");
      await p1.waitScreen('standings');
      await sleep(400);
      if (r === nRaces) break;
      if (r === 1) check(`multi: GP standings after race 1/${nRaces} → NEXT RACE`, (await p1.text('#std-next')) === 'NEXT RACE' && new RegExp(`1/${nRaces}`).test(await p1.text('#std-sub')), await p1.text('#std-sub'));
      await p1.tap("#scr-standings [data-act='next']");
      const started = await waitUntil(async () => (await Promise.all(phones.map((ph) => ph.screen()))).every((s) => s === 'race' || s === 'loading'), 5000);
      if (r === 1 || !started) check(`multi: GP race ${r + 1} starts for everyone`, started);
    }
    check(`multi: GP race ${nRaces} was ${gpCup.tracks[nRaces - 1]}`, host.game.trackId === gpCup.tracks[nRaces - 1], host.game.trackId);
    check('multi: last GP standings → PODIUM', (await p1.text('#std-next')) === 'PODIUM');
    await sleep(400);
    await p1.tap("#scr-standings [data-act='next']");
    check('multi: podium on every phone',
      await waitUntil(async () => (await Promise.all(phones.map((ph) => ph.screen()))).every((s) => s === 'podium'), 3000));
    await sleep(300);
    const pod = await p1.eval(() => [...document.querySelectorAll('.pod-col')].map((c) => c.className.split(' ')[1] + ':' + (c.querySelector('.pod-name')?.textContent || '')));
    check('multi: podium shows 2nd · 1st · 3rd', pod.length === 3 && pod[0].startsWith('p2') && pod[1].startsWith('p1') && pod[2].startsWith('p3'), pod.join());
    for (const ph of phones) await ph.shot('13-podium');
    await sleep(400);
    await p1.tap("#scr-podium [data-act='next']");
    check('multi: BACK TO LOBBY → lobby everywhere',
      await waitUntil(async () => (await Promise.all(phones.map((ph) => ph.screen()))).every((s) => s === 'lobby'), 3000));

    // Host hand-off: P1 leaves → P2 is host; P1 comes back (same padId) → host again.
    await p1.page.close();
    check('multi: P1 leaves → P2 gets the crown + host controls',
      await waitUntil(async () => (await p2.pad()).host && await p2.visible('#seg-mode') && await p2.visible('#me-tag .crown'), 4000));
    check('multi: P3 now reads "Waiting for P2 to start…"', await waitUntil(async () => (await p3.text('#lob-wait')) === 'Waiting for P2 to start…', 2000));
    await p2.shot('14-host-handoff');
    const p1b = await joinPhone(browser, { ...cfgs[0], label: 'm-P1b', context: ctx1 });
    phones[0] = p1b;
    check('multi: P1 reopens (same padId) → slot 1 again, host again',
      await waitUntil(async () => { const q = await p1b.pad(); return q.slot === 1 && q.host && !(await p2.pad()).host; }, 4000));

    // A slot frees up → the 5th phone joins (auto-retry).
    await p4.close();
    phones[3] = null;
    for (const k of [1, 2, 3]) openSlots[k] = true;
    await releaseClosed(host);
    for (const k of [1, 2, 3]) delete openSlots[k];
    check('multi: slot 4 freed → the 5th phone joins as P4 by itself',
      await waitUntil(async () => (await fifth.screen()) === 'gate' && (await fifth.eval(() => window.__pad.state.slot)) === 4, 6000));
  } finally {
    for (const ph of phones) if (ph) await ph.close().catch(() => {});
    if (fifth) await fifth.close().catch(() => {});
    await ctx1.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ iPhone SE: every screen fits

async function seScenarios(browser, host) {
  const cfgs = [
    { label: 'SE-L', w: 667, h: 375, angle: 90, hold: 90, expect: { rot: 0, tall: false } },
    { label: 'SE-up', w: 375, h: 553, angle: 0, hold: null, expect: { rot: 0, tall: true } },       // Safari with its toolbars, held upright
    { label: 'SE-side', w: 375, h: 553, angle: 0, hold: 90, expect: { rot: 90, tall: false } },      // portrait-locked, held sideways
  ];
  const screens = [
    ['lobby', { screen: 'lobby', mode: 'vs' }],
    ['char', { screen: 'select', step: 'char' }],
    ['body', { screen: 'select', step: 'body' }],
    ['wheels', { screen: 'select', step: 'wheels' }],
    ['ready', { screen: 'select', step: 'ready' }],
    ['waiting', { screen: 'select', step: 'done' }],
    ['track', { screen: 'track', mode: 'vs' }],
    ['trackgp', { screen: 'track', mode: 'gp' }],
    ['results', { screen: 'results' }],
    ['standings', { screen: 'standings' }],
    ['podium', { screen: 'podium' }],
  ];
  for (const cfg of cfgs) {
    console.log(`\n=== ${cfg.label}: ${cfg.w}x${cfg.h}`);
    await freshGame(host);
    const ph = await joinPhone(browser, cfg);
    try {
      await ph.waitScreen('lobby');
      await sleep(500);
      for (const [name, q] of screens) {
        host.reset();
        host.setScreen(q);
        const want = name === 'waiting' ? 'waiting' : name === 'trackgp' ? 'track' : name;
        await ph.waitScreen(want, 3000);
        await sleep(350);
        const p = await ph.pad();
        const lay = await ph.layout();
        check(`${cfg.label} ${name}: layout ${cfg.expect.tall ? 'upright' : 'landscape'}, nothing off-screen, names whole`,
          (await ph.screen()) === want && p.rot === cfg.expect.rot && p.tall === cfg.expect.tall && !lay.out.length && !lay.cut.length,
          `rot ${p.rot} tall ${p.tall} out [${lay.out.join(', ')}] cut [${lay.cut.join(', ')}]`);
        if (name === 'char') {
          const vis = await ph.eval(() => {
            const box = document.getElementById('char-rows').getBoundingClientRect();
            return [...document.querySelectorAll('.char-row:not(.custom) .rc')].filter((c) => { const r = c.getBoundingClientRect(); return r.top >= box.top - 1 && r.bottom <= box.bottom + 1; }).length;
          });
          check(`${cfg.label} char: all 12 roster racers visible without scrolling`, vis === 12, `${vis} visible`);
        }
        await ph.shot(name);
      }
      host.setScreen({ screen: 'race', race: 'racing', item: 'banana', place: 4, lap: 1, assistActive: '1', auto: '0' });
      await ph.waitScreen('race');
      await sleep(400);
      const big = await ph.eval(() => ['btn-gas', 'btn-brake', 'btn-drift', 'btn-item'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); }));
      check(`${cfg.label} race: big touch targets (≥ 60 px)`, big.every((v) => v >= 60), big.join());
      await ph.shot('race');
    } finally {
      await ph.close();
    }
  }
}

// ------------------------------------------------------------------ extras

async function extraScenarios(browser, host) {
  console.log('\n=== extra scenarios');
  await freshGame(host);
  host.setScreen({ screen: 'race', race: 'racing' });

  // devicemotion fallback, iOS sign convention, iPhone UA.
  for (const [conv, ua, label] of [['ios', IPHONE_UA, 'iOS'], ['android', ANDROID_UA, 'Android']]) {
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, ua, label: `motion-${conv}` });
    await ph.eval((c) => window.__tilt.start(90, 'motion', c), conv);
    await ph.tap('#btn-gate');
    await sleep(500);
    await ph.eval(() => window.__tilt.set(20, 30));
    await sleep(500);
    let p = await ph.pad();
    check(`motion fallback (${label} convention) → source motion`, p.src === 'motion', p.src);
    check(`motion fallback (${label}) clockwise → steer right`, near(p.steer, expectedSteer(20, 30), 0.04), fmt(p.steer));
    await ph.eval(() => window.__tilt.set(-20, 30));
    await sleep(400);
    p = await ph.pad();
    check(`motion fallback (${label}) counter-clockwise → steer left`, near(p.steer, expectedSteer(-20, 30), 0.04), fmt(p.steer));
    await closeAndRelease(ph, host);
  }
  // Wrong initial sign guess (iPhone UA but W3C-convention data) is corrected.
  {
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, ua: IPHONE_UA, label: 'motion-fix' });
    await ph.eval(() => { window.__tilt.set(0, 30); window.__tilt.start(90, 'motion', 'android'); });
    await ph.tap('#btn-gate');
    await sleep(800);
    await ph.eval(() => window.__tilt.set(20, 30));
    await sleep(400);
    const p = await ph.pad();
    check('motion sign auto-detection fixes an inverted guess', near(p.steer, expectedSteer(20, 30), 0.04), fmt(p.steer));
    await closeAndRelease(ph, host);
  }
  // A browser reporting the opposite landscape angle (screen says 90, phone is
  // really held the 270 way) is detected from gravity and corrected.
  {
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, label: 'flip' });
    await ph.eval(() => window.__tilt.start(270));
    await ph.tap('#btn-gate');
    await sleep(1600);
    let p = await ph.pad();
    check('opposite landscape angle → detected and corrected', p.flip === true && p.ui === 270, `flip ${p.flip}, ui ${p.ui}`);
    await ph.eval(() => window.__tilt.set(20, 15));
    await sleep(400);
    p = await ph.pad();
    check('…and clockwise still steers right', near(p.steer, expectedSteer(20, 15, p.calib), 0.03), fmt(p.steer));
    await closeAndRelease(ph, host);
  }
  // No sensors at all → touch slider after 1.5 s.
  {
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, label: 'nosensor' });
    await ph.tap('#btn-gate');
    await sleep(1900);
    const p = await ph.pad();
    const toast = await ph.text('#toast');
    check('no sensor events → touch slider fallback', p.src === 'touch', `${p.src}; toast "${toast}"`);
    await ph.shot('race-touch-fallback');
    await closeAndRelease(ph, host);
  }
  // Room-code entry (no ?room=): type the code on the keypad → joins → gate.
  for (const [w, h, angle] of [[844, 390, 90], [390, 844, 0]]) {
    const label = `code-${w > h ? 'L' : 'P'}`;
    const ph = await Phone.open(browser, { w, h, angle, url: `https://localhost:${HTTPS_PORT}/pad`, label });
    check(`${label} no room → code entry screen`, await ph.waitScreen('code'));
    await ph.tap(".key[data-k='Z']");
    await ph.tap(".key[data-k='back']");
    for (const k of 'PAD') await ph.tap(`.key[data-k='${k}']`);
    await ph.shot('1-typing');
    await ph.tap(".key[data-k='T']");
    check(`${label} typed code joins → gate`, await ph.waitScreen('gate'));
    check(`${label} URL updated with the room`, (await ph.eval(() => location.search)) === `?room=${ROOM}`);
    await closeAndRelease(ph, host);
  }
  // Unknown room: error + keeps retrying, joins automatically once it opens.
  {
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, url: `https://localhost:${HTTPS_PORT}/pad?room=WXYZ`, label: 'badroom' });
    check('unknown room → code screen with an error', await ph.waitScreen('code'));
    check('error text mentions the room', /WXYZ/.test(await ph.text('#code-error')));
    await ph.shot('code-error');
    const late = await startFakeHost({ url: `http://localhost:${PORT}`, room: 'WXYZ', quiet: true });
    check('room opens later → phone joins by itself', await ph.waitScreen('gate', 6000));
    await late.close();
    await ph.close();
  }
  // Page hidden mid-race (screen lock / app switch / call) while driving. Solo:
  // the pad pauses the game right away ({reason:'hidden'}) and stops
  // streaming. With two players: no pause (the desktop lets a CPU drive).
  {
    await releaseClosed(host);
    host.reset();
    host.setScreen({ screen: 'race', race: 'racing' });
    host.clear();
    const ph = await joinPhone(browser, { w: 844, h: 390, angle: 90, ua: ANDROID_UA, label: 'hidden', hold: 90 });
    await ph.waitScreen('race');
    host.setScreen({ screen: 'race', race: 'racing', auto: '0' });
    await ph.down(1, '#btn-gas');
    await ph.eval(() => window.__tilt.set(25, 15));
    await sleep(400);
    const slot = await ph.eval(() => window.__pad.state.slot);
    check('hidden: driving before (GAS held, steering)', host.logs.lastBySlot[slot]?.g === 1 && host.logs.lastBySlot[slot].s > 0.3, JSON.stringify(host.logs.lastBySlot[slot]));
    const menus0 = host.logs.menus.length;
    await ph.setHidden(true);
    await sleep(250);
    const pauses = host.logs.menus.slice(menus0).filter((m) => m.action === 'pause');
    check("hidden mid-race (solo) → pause {reason:'hidden'} at once → host paused", pauses.length === 1 && pauses[0].reason === 'hidden' && host.game.screen === 'paused',
      `${menuJson(pauses[0])}, host ${host.game.screen}`);
    check('hidden → host input released (g=0, s=0)', host.logs.lastBySlot[slot].g === 0 && host.logs.lastBySlot[slot].s === 0, JSON.stringify(host.logs.lastBySlot[slot]));
    const n0 = host.logs.counts.input;
    await sleep(700);
    check('hidden → no input stream while away', host.logs.counts.input - n0 <= 1, `${host.logs.counts.input - n0} samples`);
    await ph.up(1);
    await ph.setHidden(false);
    await sleep(700);
    check('visible again → stream resumes, phone shows the pause menu', host.logs.counts.input - n0 >= 2 && (await ph.screen()) === 'paused', `${host.logs.counts.input - n0} samples, ${await ph.screen()}`);
    // Two players: hiding one phone must not pause the race for both.
    host.setScreen({ screen: 'race', race: 'racing', auto: '0' });
    const other = await joinPhone(browser, { w: 844, h: 390, angle: 90, label: 'hidden-2', hold: 90 });
    await other.waitScreen('race');
    host.setScreen({ screen: 'race', race: 'racing', auto: '0' });
    await sleep(300);
    await ph.down(1, '#btn-gas');
    await sleep(200);
    const menus1 = host.logs.menus.length;
    await ph.setHidden(true);
    await sleep(300);
    check('hidden with two players → no pause (released, stream stops)', host.logs.menus.length === menus1 && host.game.screen === 'race' && host.logs.lastBySlot[slot].g === 0,
      `${host.logs.menus.length - menus1} menus, host ${host.game.screen}`);
    await ph.up(1);
    await ph.setHidden(false);
    // After the finish (a CPU drives the kart home) hiding the page must not pause.
    await other.close();
    await sleep(300);
    host.setScreen({ screen: 'race', race: 'finished', finished: '1' });
    await waitUntil(() => ph.eval(() => window.__pad.state.mine?.race?.finished === true), 2000);
    const menus2 = host.logs.menus.length;
    await ph.setHidden(true);
    await sleep(250);
    check('hidden after the player finished → no pause', host.logs.menus.length === menus2 && host.game.screen === 'race');
    await ph.setHidden(false);
    await ph.close();
  }
  await releaseClosed(host);
  // iPhone with motion access denied: a lasting note (race screen + settings)
  // and a button that asks again inside the tap.
  {
    host.reset();
    host.setScreen({ screen: 'race', race: 'racing' });
    const ph = await Phone.open(browser, {
      w: 844, h: 390, angle: 90, label: 'perm-denied',
      init: () => {
        window.__permAsks = 0;
        window.__permAnswer = 'denied';
        DeviceOrientationEvent.requestPermission = () => { window.__permAsks++; return Promise.resolve(window.__permAnswer); };
        DeviceMotionEvent.requestPermission = () => Promise.resolve(window.__permAnswer);
      },
    });
    await ph.tap('#btn-gate');
    await sleep(1900);
    const st = () => ph.eval(() => ({
      src: window.__pad.state.steerSource, denied: window.__pad.state.permissionDenied, asks: window.__permAsks,
      mode: document.getElementById('steer-mode').textContent, note: !document.getElementById('tilt-note').hidden,
    }));
    let v = await st();
    check('motion access denied → touch steering + lasting "tilt blocked" line on the race screen', v.src === 'touch' && v.denied && /BLOCKED/.test(v.mode) && v.asks === 1, JSON.stringify(v));
    await ph.tap('#btn-settings');
    await sleep(350);
    check('settings explain how to get tilt back', v.note);
    await ph.eval(() => { window.__permAnswer = 'granted'; window.__tilt.start(90); });
    await ph.tapIn('#btn-enable-tilt');
    await sleep(700);
    v = await st();
    check('TRY TILT AGAIN asks again inside the tap → tilt steering, note gone', v.asks === 2 && !v.denied && !v.note && v.src === 'orientation', JSON.stringify(v));
    await ph.close();
  }
  await releaseClosed(host);
  // Android: fullscreen (+ landscape lock) is re-entered on the next tap after it was lost.
  {
    host.reset();
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, ua: ANDROID_UA, label: 'fullscreen' });
    await ph.eval(() => window.__tilt.start(90));
    await ph.tap('#btn-gate');
    await sleep(500);
    if (!(await ph.eval(() => !!document.fullscreenElement))) {
      console.log('SKIP  fullscreen re-entry (this Chrome does not enter fullscreen at the gate)');
    } else {
      await ph.eval(() => document.exitFullscreen());
      await sleep(1600);
      check('fullscreen lost (app switch / back gesture)', await ph.eval(() => !document.fullscreenElement));
      await ph.tap('#btn-settings');
      await sleep(400);
      check('next tap re-enters fullscreen', await ph.eval(() => !!document.fullscreenElement));
    }
    await ph.close();
  }
  await releaseClosed(host);
  // No WebSocket (upgrade refused): long-polling still streams, and the
  // settings readout says which link is in use.
  {
    host.reset();
    host.setScreen({ screen: 'race', race: 'racing' });
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, ua: ANDROID_UA, label: 'polling', init: () => { window.WebSocket = undefined; } });
    await ph.eval(() => window.__tilt.start(90));
    await ph.tap('#btn-gate');
    await ph.waitScreen('race');
    await sleep(600);
    const n0 = host.logs.counts.input;
    await sleep(1000);
    const rate = host.logs.counts.input - n0;
    await ph.tap('#btn-settings');
    await sleep(400);
    const tr = await ph.eval(() => ({ t: window.__pad.transport, dbg: document.getElementById('dbg').textContent }));
    check('no WebSocket → "polling" shown in the settings readout', tr.t === 'polling' && /polling/.test(tr.dbg), tr.t);
    check('polling still streams steering on a fast link (≥ 30/s)', rate >= 30, `${rate}/s`);
    await ph.close();
  }
  await releaseClosed(host);
  // Small phone, portrait-locked, held sideways (stage CSS-rotated): results
  // list scrolls with a swipe along the rotated axis, the sensitivity slider
  // can be dragged, the settings sheet scrolls.
  {
    host.reset();
    host.setScreen({ screen: 'results' });
    const ph = await joinPhone(browser, { w: 375, h: 553, angle: 0, label: 'SE-rot', hold: 90 });
    await ph.waitScreen('results');
    await sleep(500);
    // cssRot 90: stage +x = screen +y (down), stage "scroll up" = finger to screen +x.
    await ph.swipe('#res-list', 160, 0);
    const res = await ph.eval(() => { const l = document.getElementById('res-list'); return { top: l.scrollTop, over: l.scrollHeight - l.clientHeight, rot: window.__pad.state.cssRot }; });
    check('SE rotated: results list scrolls (swipe along the rotated axis)', res.rot === 90 && res.over > 10 && res.top > 10, JSON.stringify(res));
    host.setScreen({ screen: 'race', race: 'racing' });
    await ph.waitScreen('race');
    await ph.tap('#btn-settings');
    await sleep(400);
    const before = await ph.eval(() => window.__pad.settings.lockDeg);
    const len = await ph.eval(() => document.getElementById('sens').offsetWidth);
    await ph.swipe('#sens', 0, len * 0.3, 16);       // stage +x (toward "twitchy") = screen +y
    const after = await ph.eval(() => window.__pad.settings.lockDeg);
    check('SE rotated: sensitivity slider drags along its (rotated) axis', after <= before - 7, `full lock ${before}° → ${after}°`);
    await ph.swipe('.sheet-body .set-row:nth-child(2) .set-label', 160, 0);
    const sb = await ph.eval(() => { const b = document.getElementById('sheet-body'); return { top: b.scrollTop, over: b.scrollHeight - b.clientHeight }; });
    check('SE rotated: settings sheet scrolls (swipe along the rotated axis)', sb.over > 10 && sb.top > 10, JSON.stringify(sb));
    await ph.shot('settings');
    await ph.close();
  }
  await releaseClosed(host);
  // Insecure-context help screen (forced visually; a real http:// LAN page is redirected).
  {
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, label: 'insecure' });
    await ph.eval(() => {
      for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === 'scr-insecure');
      document.getElementById('stage').dataset.screen = 'insecure';
    });
    await sleep(200);
    await ph.shot('screen');
    await ph.close();
  }
  await releaseClosed(host);
  // A phone set up before the KRISHIV KART rename keeps its settings and its
  // controller id (read from the old storage keys).
  {
    host.reset();
    const joins0 = host.logs.counts.join;
    const ph = await Phone.open(browser, {
      w: 844, h: 390, angle: 90, label: 'legacy-keys',
      init: () => {
        if (sessionStorage.getItem('seeded')) return;               // (first page load only)
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('tootkart.pad.settings.v1', JSON.stringify({ lockDeg: 41, invert: true, autoGas: false, haptics: true, steerMode: 'tilt' }));
        localStorage.setItem('tootkart.pad.id', 'pad-legacy-id-01');
      },
    });
    await ph.eval(() => window.__tilt.start(90));
    await ph.tap('#btn-gate');
    await ph.waitScreen('lobby');
    const v = await ph.eval(() => ({ lock: window.__pad.settings.lockDeg, invert: window.__pad.settings.invert, autoGas: window.__pad.settings.autoGas, assist: window.__pad.settings.assist, id: localStorage.getItem('krishivkart.pad.id') }));
    check('pre-rename phone keeps its settings + controller id (legacy storage keys; Assist defaults ON)',
      v.lock === 41 && v.invert === true && v.autoGas === false && v.assist === true && v.id === 'pad-legacy-id-01' && host.logs.counts.join > joins0, JSON.stringify(v));
    await ph.close();
  }
  await releaseClosed(host);
  // Tilt mapping v2: a phone saved under v1 that still sits on v1's 32° default
  // moves to the new default; one saved under v2 keeps a chosen 32°.
  for (const [saved, want, what] of [[{ lockDeg: 32 }, LOCK_DEFAULT, 'v1 default 32° → new default'], [{ lockDeg: 32, tiltMap: 2 }, 32, 'v2 chosen 32° kept']]) {
    host.reset();
    const ph = await Phone.open(browser, {
      w: 844, h: 390, angle: 90, label: 'tilt-map',
      // (first page load only; the saved JSON is inlined into the init script)
      init: `(() => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
        localStorage.setItem('krishivkart.pad.settings.v1', ${JSON.stringify(JSON.stringify({ ...saved, autoGas: true, assist: true, invert: false, haptics: true, steerMode: 'tilt' }))}); })()`,
    });
    const lock = await ph.eval(() => window.__pad.settings.lockDeg);
    check(`saved settings: ${what} (${lock}°)`, lock === want, JSON.stringify(saved));
    await ph.close();
  }
  await releaseClosed(host);
  // Full server restart: the phone shows "Reconnecting…", then recovers once
  // the desktop (fake host) reclaims its room on the new server.
  if (spawnServer) {
    host.reset();
    const ph = await joinPhone(browser, { w: 844, h: 390, angle: 90, label: 'restart', netErrorsOk: true, hold: 90 });
    check('restart: phone in the lobby before the restart', await ph.waitScreen('lobby'));
    await stopServer();
    await sleep(400);
    check('restart: "Reconnecting…" banner while the server is down', await ph.eval(() => document.getElementById('banner-offline').classList.contains('show')));
    await ph.shot('1-offline');
    const stuck = await waitUntil(() => ph.eval(() => {
      const b = document.getElementById('banner-offline');
      return b.classList.contains('stuck') && /reload this page/i.test(b.textContent) && document.getElementById('btn-reload').offsetWidth > 0;
    }), 15000, 250);
    check('restart: after repeated failures the banner suggests reloading the page', !!stuck);
    startServer();
    await waitForServer();
    const back = await waitUntil(async () => (await ph.pad()).joined && !(await ph.eval(() => document.getElementById('ov-waiting').classList.contains('show'))), 12000, 200);
    check('restart: phone and desktop reconnect to the same room automatically', !!back);
    check('restart: same slot after the restart', (await ph.pad()).slot === 1);
    check('restart: reload hint gone once connected', await ph.eval(() => !document.getElementById('banner-offline').classList.contains('show') && window.__pad.state.connectErrors === 0));
    host.setScreen({ screen: 'select', step: 'char' });
    check('restart: host state flows again', await ph.waitScreen('char', 4000));
    await ph.close();
  }
}

// ------------------------------------------------------------------ main

if (spawnServer) startServer();
try {
  await waitForServer();
} catch (err) {
  console.log(`FAIL  server startup: ${err.message}`);
  await stopServer();
  process.exit(1);
}
const host = await startFakeHost({ url: `http://localhost:${PORT}`, room: ROOM, quiet: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  acceptInsecureCerts: true,
  defaultViewport: null,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--ignore-certificate-errors'],
});

const CONFIGS = [
  { label: 'L90', w: 844, h: 390, angle: 90, hold: 90, expectUi: 90 },
  { label: 'L270', w: 844, h: 390, angle: 270, hold: 270, expectUi: 270 },
  { label: 'P0', w: 390, h: 844, angle: 0, hold: 90, expectUi: 90 },
];
try {
  for (const cfg of CONFIGS) {
    if (!ONLY.includes(cfg.label)) continue;
    try { await orientationScenario(browser, host, cfg); } catch (err) { check(`${cfg.label} scenario crashed`, false, err.stack); }
  }
  if (ONLY.includes('multi')) {
    try { await multiScenario(browser, host); } catch (err) { check('multi scenario crashed', false, err.stack); }
  }
  if (ONLY.includes('SE')) {
    try { await seScenarios(browser, host); } catch (err) { check('SE scenarios crashed', false, err.stack); }
  }
  if (ONLY.includes('extra')) {
    try { await extraScenarios(browser, host); } catch (err) { check('extra scenarios crashed', false, err.stack); }
  }
} finally {
  await browser.close();
  await host.close();
  await stopServer();
}

if (portraitMisses) console.log(`NOTE  ${portraitMisses} racer portrait request(s) missed (public/img/racers/*.png not rendered yet): the color-card fallback was shown`);
check('no page errors / console errors', pageErrors === 0, `${pageErrors}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed — screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
