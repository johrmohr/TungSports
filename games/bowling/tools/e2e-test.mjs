// End-to-end: a real server, the TV page and FOUR phone remote pages in
// headless Chrome (touch-emulated iPhones). Phones join with the room code,
// Player 1 starts, and everyone bowls by holding B and "swinging" — synthetic
// gyroscope/accelerometer samples are fed through real devicemotion events in
// real time. The first frames use real swings; the rest of the game is
// fast-forwarded through the display's test hook. Also checks D-pad / A /
// zoom, a phone reload mid-game (same slot), turn order and the results.
//
//   node tools/e2e-test.mjs [--swing-frames=2] [--shots=dir]
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import puppeteer, { KnownDevices } from 'puppeteer-core';
import { makeSwing } from './swing-gen.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const SWING_FRAMES = Number(arg('swing-frames', 2));
const SHOTS = arg('shots', null);
const PORT = 3310, HTTPS_PORT = 3753;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- server
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bowling-e2e-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), NO_OPEN: '1', BOWLING_CERT_DIR: certDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });
let browser;
const cleanup = async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  try { server.kill('SIGKILL'); } catch { /* ignore */ }
  fs.rmSync(certDir, { recursive: true, force: true });
};
process.on('unhandledRejection', async (err) => { await fail(err?.stack || String(err)); });
process.on('uncaughtException', async (err) => { await fail(err?.stack || String(err)); });
const fail = async (msg) => { console.error(`✖ ${msg}`); console.error(serverOut.split('\n').slice(-15).join('\n')); await cleanup(); process.exit(1); };
for (let i = 0; i < 150 && !/TV \/ display/.test(serverOut); i++) await sleep(100);
if (!/TV \/ display/.test(serverOut)) await fail('server did not start');
const base = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------- browser
browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g/.test(m.text())) errors.push(`${who} console: ${m.text()}`); });
};

const display = await browser.newPage();
await display.setViewport({ width: 1280, height: 720 });
watch(display, 'display');
await display.goto(base, { waitUntil: 'networkidle2' });
await display.waitForFunction(() => window.__bowl?.phase() === 'lobby' && window.__bowl.link.room, { timeout: 30000 });
const room = await display.evaluate(() => __bowl.link.room);
console.log(`room ${room}`);

// A phone at rest keeps reporting motion (so the remote keeps motion mode);
// window.__swinging pauses the idle stream while a swing is being fed.
const IDLE_SENSORS = () => {
  window.__swinging = false;
  setInterval(() => {
    if (window.__swinging) return;
    const n = () => (Math.random() - 0.5) * 2;
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x: n() * 0.1, y: -4.9, z: 8.5 },
      rotationRate: { alpha: n(), beta: n(), gamma: n() }, interval: 16,
    }));
    const o = window.__orient || { beta: -30, gamma: 0 };
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: o.beta, gamma: o.gamma }));
  }, 33);
};

const names = ['Jordan', 'Krishiv', 'Maya', 'Leo'];
const phones = [];
for (let i = 0; i < 4; i++) {
  // Each phone is its own device: separate storage (client id) and cookies.
  const ctx = await browser.createBrowserContext();
  const ph = await ctx.newPage();
  await ph.emulate(KnownDevices['iPhone 13']);
  await ph.evaluateOnNewDocument(IDLE_SENSORS);
  watch(ph, `phone${i}`);
  await ph.goto(`${base}/remote?room=${room}`, { waitUntil: 'networkidle2' });
  await ph.waitForFunction(() => document.body.dataset.screen === 'join', { timeout: 15000 });
  await ph.click('#name-input', { clickCount: 3 });
  await ph.type('#name-input', names[i]);
  if (i === 3) await ph.tap('#hand-seg [data-hand="left"]');
  if (SHOTS && i === 0) await ph.screenshot({ path: path.join(SHOTS, 'phone-join.png') });
  await ph.tap('#btn-join');
  await ph.waitForFunction(() => document.body.dataset.screen === 'lobby', { timeout: 15000 });
  phones.push(ph);
}
const screenOf = (ph) => ph.evaluate(() => document.body.dataset.screen);
await display.waitForFunction(() => __bowl.link.players.filter(Boolean).length === 4, { timeout: 5000 }).catch(async () => {
  const dp = await display.evaluate(() => JSON.stringify(__bowl.link.players));
  const ps = await Promise.all(phones.map((ph) => ph.evaluate(() => JSON.stringify({ slot: window.__remote.state.slot, joined: window.__remote.state.joined, screen: document.body.dataset.screen }))));
  await fail(`display players ${dp}; phones ${ps.join(' ')}`);
});
const lobby = await display.evaluate(() => __bowl.link.players.map((p) => ({ name: p.name, color: p.color, hand: p.hand })));
assert.deepEqual(lobby.map((p) => p.name), names, 'names reach the TV');
assert.equal(new Set(lobby.map((p) => p.color)).size, 4, 'four different colours');
assert.equal(lobby[3].hand, 'left', 'left hand reaches the TV');
await sleep(600);
const startVisible = await Promise.all(phones.map((ph) => ph.evaluate(() => !document.getElementById('btn-start').hidden)));
assert.deepEqual(startVisible, [true, false, false, false], 'only Player 1 can start');
if (SHOTS) { await phones[1].screenshot({ path: path.join(SHOTS, 'phone-lobby.png') }); await display.screenshot({ path: path.join(SHOTS, 'tv-lobby.png') }); }
console.log('✓ four phones joined; only P1 sees Start');

await phones[0].tap('#btn-start');
await display.waitForFunction(() => __bowl.phase() === 'game', { timeout: 5000 });
await display.evaluate(() => __bowl.setTimeScale(2.5));
console.log('✓ P1 started the game from the phone');

// ---------------------------------------------------------------- play
const turnInfo = () => display.evaluate(() => {
  const t = __bowl.app.turn;
  return t ? { step: t.step, slot: t.player.slot, frame: t.frame, ball: t.ball, aimX: t.aimX, angle: t.angle, mode: t.mode, zoom: t.zoom } : null;
});

// deviceorientation β/γ of a phone held at the chest (arm 60° forward) in each grip.
const GRIP_POSE = { standard: { beta: -30, gamma: 0 }, thigh: { beta: -30, gamma: -90 }, screenBack: { beta: -150, gamma: 0 } };

async function swingOn(ph, opts) {
  const { samples, tRelease } = makeSwing(opts);
  await ph.evaluate((o) => { window.__orient = o; }, GRIP_POSE[opts.grip || 'standard']);
  await sleep(120);                                // a few orientation events in the new pose
  const box = await ph.$eval('#grip', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await ph.evaluate(() => { window.__swinging = true; });
  await ph.touchscreen.touchStart(box.x, box.y);
  await ph.evaluate(async (pts, t0, tRel) => {
    const start = performance.now();
    for (const p of pts) {
      const due = start + (p.t - t0);
      const wait = due - performance.now();
      if (wait > 1) await new Promise((r) => setTimeout(r, wait));
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: p.a[0], y: p.a[1], z: p.a[2] },
        rotationRate: { alpha: p.w[0], beta: p.w[1], gamma: p.w[2] }, interval: 16,
      }));
    }
    const endDue = start + (tRel - t0);
    const w = endDue - performance.now();
    if (w > 1) await new Promise((r) => setTimeout(r, w));
    // Lift the thumb exactly at the release moment (a CDP round trip would
    // add 30-80 ms, during which the detector rightly assumes the arm swung on).
    const g = window.__remote.state.grip;
    const id = [...g.pointers][0];
    const sw = window.__remote.swing;
    window.__lastCapture = { samples: sw.samples.map((x) => ({ t: x.t, w: x.w, a: x.a })), gripUp: sw.gripUp, gripAxis: sw.gripAxis, mode: g.mode, t0: sw.t0, now: performance.now() };
    if (g.active && id !== undefined) document.getElementById('grip').dispatchEvent(new PointerEvent('pointerup', { pointerId: id, pointerType: 'touch', isPrimary: true, bubbles: true }));
  }, samples, samples[0].t, tRelease);
  await ph.touchscreen.touchEnd();
  await ph.evaluate(() => { window.__swinging = false; });
}

let balls = 0, swings = 0, reloaded = false, dpadChecked = false, flickChecked = false, lastKey = '';
const releases = [];
const seenOrder = [];
const t0 = Date.now();
while (Date.now() - t0 < 12 * 60 * 1000) {
  const phase = await display.evaluate(() => __bowl.phase());
  if (phase === 'over') break;
  const t = await turnInfo();
  if (!t || !['aim', 'intro'].includes(t.step)) { await sleep(120); continue; }
  const key = `${t.slot}/${t.frame}/${t.ball}`;
  if (key === lastKey) { await sleep(100); continue; }
  const ph = phones[t.slot];
  if (t.ball === 0 && (seenOrder.length === 0 || seenOrder[seenOrder.length - 1] !== `${t.frame}:${t.slot}`)) seenOrder.push(`${t.frame}:${t.slot}`);
  if (t.frame < SWING_FRAMES) {
    // The phone must show the aim controls for its own turn only.
    await ph.waitForFunction(() => document.body.dataset.screen === 'aim' && !document.body.classList.contains('blocked'), { timeout: 15000 })
      .catch(async () => fail(`phone ${t.slot} never showed aim (screen ${await screenOf(ph)})`));
    const others = await Promise.all(phones.map((p, i) => (i === t.slot ? 'me' : screenOf(p))));
    assert.ok(others.every((s) => s === 'me' || s === 'wait'), `others wait: ${others}`);
    if (!dpadChecked) {
      await sleep(450);   // let the turn settle into aim (a too-early A counts as skipping the intro)
      // D-pad: two steps right (Move), A → Turn, one step left, ▲ zoom in/out.
      await ph.tap('#btn-right'); await ph.tap('#btn-right');
      await ph.tap('#btn-a');
      await ph.tap('#btn-left');
      await ph.tap('#btn-zoom');
      await sleep(400);
      const a = await turnInfo();
      assert.ok(a.aimX > 0.04, `moved right: ${a.aimX}`);
      assert.equal(a.mode, 'turn');
      assert.ok(a.angle < 0, `turned left: ${a.angle}`);
      assert.equal(a.zoom, true);
      const ui = await ph.evaluate(() => ({ mode: document.getElementById('mode-switch').dataset.mode, zoom: document.getElementById('btn-zoom').classList.contains('on') }));
      assert.deepEqual(ui, { mode: 'turn', zoom: true }, 'phone mirrors Move/Turn and zoom');
      await ph.tap('#btn-zoom');
      await ph.tap('#btn-a');
      if (SHOTS) { await ph.screenshot({ path: path.join(SHOTS, 'phone-aim.png') }); await display.screenshot({ path: path.join(SHOTS, 'tv-aim.png') }); }
      dpadChecked = true;
      console.log('✓ D-pad / A / zoom from the phone move the bowler and mirror back');
    }
    // Once: the touch-flick fallback through the phone's settings sheet.
    if (swings === 5 && !flickChecked) {
      await ph.tap('#btn-settings');
      await ph.waitForSelector('#settings:not([hidden])');
      await ph.tap('#mode-seg [data-mode="touch"]');
      await ph.tap('#btn-settings-close');
      await ph.waitForFunction(() => document.body.classList.contains('touch'));
      const ball = await ph.$eval('#flick-ball', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await ph.touchscreen.touchStart(ball.x, ball.y);
      for (let k = 1; k <= 6; k++) await ph.touchscreen.touchMove(ball.x + k * k * 4, ball.y - k * 70);
      await ph.touchscreen.touchEnd();
      await display.waitForFunction(() => ['release', 'roll', 'result', 'react', 'sweep'].includes(__bowl.step()), { timeout: 8000 })
        .catch(async () => fail(`flick did not throw (phone ${await screenOf(ph)})`));
      const info = await display.evaluate(() => __bowl.app.turn.throwInfo);
      assert.equal(info.mode, 'touch');
      assert.ok(info.speed > 0, `flick speed ${info.speed}`);
      assert.ok(info.spin > 0, `a flick bending right curves right: ${info.spin}`);
      // Back to motion for the rest.
      await ph.waitForFunction(() => document.body.dataset.screen !== 'aim', { timeout: 5000 }).catch(() => {});
      await ph.tap('#btn-settings');
      await ph.tap('#mode-seg [data-mode="motion"]');
      await ph.tap('#btn-settings-close');
      flickChecked = true;
      swings++;
      balls++;
      lastKey = key;
      console.log(`✓ touch-flick fallback throws (speed ${info.speed.toFixed(2)}, spin ${info.spin})`);
      continue;
    }
    // A real swing: hold B, swing, lift the thumb. Vary speed / twist / grip.
    const opts = {
      fwdPeakRate: 380 + ((balls * 97) % 450), twistDeg: [-50, 0, 45, 70, -20][balls % 5],
      grip: ['standard', 'thigh', 'standard', 'screenBack'][balls % 4], accelSign: balls % 2 ? 1 : -1,
      releaseAt: [0, -28, 12, 40, -45, 25, 5][balls % 7],
    };
    await swingOn(ph, opts);
    swings++;
    await display.waitForFunction(() => ['release', 'roll', 'result', 'react', 'sweep'].includes(__bowl.step()), { timeout: 8000 })
      .catch(async () => {
        const diag = await ph.evaluate(() => {
          const st = window.__remote.state;
          return JSON.stringify({ slot: st.slot, joined: st.joined, displayGone: st.displayGone, socketUp: st.socketUp, grip: { active: st.grip.active, mode: st.grip.mode }, motion: { events: st.motion.events, touch: st.motion.touchFallback, asking: st.motion.asking }, touchClass: document.body.classList.contains('touch'), blocked: document.body.classList.contains('blocked') });
        });
        await fail(`swing ${swings} did not throw (step ${(await turnInfo())?.step}, phone ${t.slot} ${await screenOf(ph)}) ${diag}`);
      });
    const thr = await display.evaluate(() => __bowl.app.lastThrow);
    assert.ok(thr.mph >= 7 && thr.mph <= 25, `mph ${thr.mph}`);
    // The release point measured on the phone reaches the TV and is graded.
    if (!(Number.isFinite(thr.release) && Math.abs(thr.release - opts.releaseAt) <= 12)) {
      const cap = await ph.evaluate(() => window.__lastCapture);
      fs.writeFileSync(path.join(os.tmpdir(), 'bowling-release-capture.json'), JSON.stringify({ opts, cap, thr }));   // debug dump for a failing release check
    }
    assert.ok(Number.isFinite(thr.release) && Math.abs(thr.release - opts.releaseAt) <= 12, `release ${thr.release} for ${opts.releaseAt}`);
    assert.ok(thr.label, 'release graded');
    releases.push(`${opts.releaseAt}→${thr.release} ${thr.label}`);
    const meter = await ph.evaluate(() => ({ shown: !document.getElementById('release-meter').hidden, label: document.getElementById('release-label').textContent }));
    assert.ok(meter.shown && meter.label, `phone release meter ${JSON.stringify(meter)}`);
    if (SHOTS && opts.releaseAt === -28) { await ph.screenshot({ path: path.join(SHOTS, 'phone-release-early.png') }); await display.screenshot({ path: path.join(SHOTS, 'tv-release-early.png') }); }
    if (SHOTS && swings === 1) {
      await sleep(300);
      await ph.screenshot({ path: path.join(SHOTS, 'phone-watch.png') });
      await phones[(t.slot + 1) % 4].screenshot({ path: path.join(SHOTS, 'phone-wait.png') });
    }
    // Mid-game reload of a phone: it must get its slot back.
    if (!reloaded && swings === 3) {
      const victim = phones[2];
      await victim.reload({ waitUntil: 'networkidle2' });
      await victim.waitForFunction(() => document.body.dataset.screen === 'join', { timeout: 10000 });
      const label = await victim.$eval('#btn-join', (b) => b.textContent);
      assert.match(label, /Join as Maya/);
      await victim.tap('#btn-join');
      await victim.waitForFunction(() => ['wait', 'aim', 'ready', 'watch'].includes(document.body.dataset.screen), { timeout: 10000 });
      const slotBack = await victim.evaluate(() => window.__remote.state.slot);
      assert.equal(slotBack, 2, 'same slot after reload');
      reloaded = true;
      console.log('✓ a phone reloaded mid-game and got its slot back');
    }
  } else {
    if (t.step === 'intro') await display.evaluate(() => __bowl.app.timeScale = 6);
    await display.evaluate(() => __bowl.bowl({ aimX: 0.28, angle: -0.6, speed: 0.72, spin: -0.45 }));
  }
  balls++;
  lastKey = key;
  if (balls % 10 === 0) console.log(`  … ${balls} balls`);
}
const phase = await display.evaluate(() => __bowl.phase());
if (phase !== 'over') await fail(`game did not finish (phase ${phase}, step ${(await turnInfo())?.step})`);
assert.ok(flickChecked, 'touch flick was exercised');
console.log(`✓ release points measured on the phones and graded on the TV: ${releases.slice(0, 7).join(', ')}`);
console.log(`✓ full game finished: ${balls} balls (${swings} real swings)`);

// Turn order: frame by frame, P1..P4.
const firstFrames = seenOrder.slice(0, 8).map((s) => s.split(':')[1]).join('');
assert.equal(firstFrames, '01230123', `turn order ${seenOrder.slice(0, 8)}`);
console.log('✓ turn order P1→P4 each frame');

// ---------------------------------------------------------------- results
const board = await display.evaluate(() => __bowl.board().map((b) => ({ name: b.name, total: b.total, complete: b.complete, rolls: b.frames.map((f) => f.rolls) })));
for (const b of board) assert.equal(b.complete, true, `${b.name} complete`);
await sleep(1200);
const overs = await Promise.all(phones.map((ph) => ph.evaluate(() => ({ screen: document.body.dataset.screen, rows: document.querySelectorAll('#over-standings li').length, again: !document.getElementById('btn-again').hidden }))));
for (const o of overs) { assert.equal(o.screen, 'over'); assert.equal(o.rows, 4); }
assert.deepEqual(overs.map((o) => o.again), [true, false, false, false], 'only P1 can restart');
if (SHOTS) { await phones[0].screenshot({ path: path.join(SHOTS, 'phone-over.png') }); await display.screenshot({ path: path.join(SHOTS, 'tv-over.png') }); }
console.log(`✓ results on every phone: ${board.map((b) => `${b.name} ${b.total}`).join(', ')}`);

// Play again from P1's phone.
await phones[0].tap('#btn-again');
await display.waitForFunction(() => __bowl.phase() === 'game' && __bowl.board().every((b) => b.total === 0), { timeout: 5000 });
console.log('✓ "Play again" from P1 starts a fresh game');

if (errors.length) { console.error(errors.join('\n')); await fail(`${errors.length} page errors`); }
console.log('e2e: all checks passed');
await cleanup();
process.exit(0);
