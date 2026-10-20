// End-to-end: the games menu → the Tennis lobby (QR code) → a phone joins and
// starts → swings over Socket.IO → back to the lobby → the menu → Golf.
//   node tools/e2e-games.mjs [--http 3000] [--shots dir]
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const HTTP = Number(opt('--http', 3000));
const SHOTS = opt('--shots', null);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
async function waitFor(fn, ms = 15000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(step); }
  return null;
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--ignore-certificate-errors', '--use-gl=angle', '--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const logs = [];
try {
  const tv = await browser.newPage();
  await tv.setViewport({ width: 1280, height: 720 });
  tv.on('pageerror', (e) => logs.push(`[tv] ${e.message}`));
  tv.on('console', (m) => { if (m.type() === 'error') logs.push(`[tv console] ${m.text()}`); });
  await tv.goto(`http://localhost:${HTTP}/`, { waitUntil: 'networkidle2' });
  const room = await waitFor(() => tv.evaluate(() => window.__ks?.link?.room));

  // ------------------------------------------------ the menu: games only
  const menu = await tv.evaluate(() => ({
    cards: [...document.querySelectorAll('.game-card')].map((c) => c.dataset.game),
    qr: !!document.querySelector('.menu .qr, .menu svg:not(.art)'),
    phase: window.__ks.app.phase,
    title: document.title,
  }));
  ok(menu.phase === 'menu' && menu.cards.join(',') === 'tennis,golf,bowling,kart', `the menu shows the four games (${menu.cards.join(', ')})`);
  ok(!menu.qr, 'the menu has no QR code or settings');
  ok(menu.title === 'Krishiv Sports', `the page is Krishiv Sports (${menu.title})`);
  if (SHOTS) await tv.screenshot({ path: `${SHOTS}/tv-menu.png` });

  // ------------------------------------------------ Tennis lobby
  await tv.evaluate(() => document.querySelector('.game-card[data-game="tennis"]').click());
  ok(!!await waitFor(() => tv.evaluate(() => window.__ks.app.phase === 'lobby' && window.__ks.lobby.game === 'tennis'), 4000), 'picking Tennis opens its lobby');
  ok(!!await waitFor(() => tv.evaluate(() => !!document.querySelector('.lobby .qr svg')), 4000), 'the lobby shows the QR code');
  ok(await tv.evaluate(() => document.querySelector('.lobby .start').disabled), 'Start is disabled with nobody in the lobby');
  await tv.evaluate(() => window.__ks.startGame('tennis', { format: 1, level: 'pro', teams: [['cpu', 'cpu'], ['cpu', 'cpu']] }));
  await sleep(300);
  ok(await tv.evaluate(() => window.__ks.app.phase === 'lobby'), 'a CPU-only match is refused');

  const info = await (await fetch(`http://localhost:${HTTP}/api/info`)).json();
  const phone = await browser.newPage();
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  phone.on('pageerror', (e) => logs.push(`[phone] ${e.message}`));
  await phone.goto(`${info.phoneBaseUrl}?room=${room}`, { waitUntil: 'networkidle2' });
  await waitFor(() => phone.evaluate(() => document.body.dataset.screen === 'join'));
  await phone.evaluate(() => { document.getElementById('name-input').value = 'Ace'; });
  await phone.click('#btn-join');
  ok(!!await waitFor(() => phone.evaluate(() => document.body.dataset.screen === 'lobby' && document.body.classList.contains('host'))), 'the phone joined the lobby as the host');
  await tv.bringToFront();
  ok(!!await waitFor(() => tv.evaluate(() => !document.querySelector('.lobby .start').disabled), 4000), 'Start is enabled once a player is in');
  ok(await phone.evaluate(() => document.getElementById('lobby-title').textContent === 'Tennis'), 'the phone shows the Tennis lobby');
  if (SHOTS) { await phone.screenshot({ path: `${SHOTS}/phone-lobby.png` }); await tv.screenshot({ path: `${SHOTS}/tv-lobby.png` }); }

  // The host picks a one-game match on the phone, then starts.
  await phone.evaluate(() => [...document.querySelectorAll('#lobby-settings .opt-btn')].find((b) => b.textContent.startsWith('1 game'))?.click());
  ok(!!await waitFor(() => tv.evaluate(() => window.__ks.lobby.tennis.format === 1), 3000), 'the phone changed the match length on the TV');
  await phone.evaluate(() => document.getElementById('btn-lobby-start').click());
  ok(!!await waitFor(() => tv.evaluate(() => window.__ks.app.phase === 'tennis'), 15000), 'tennis started from the phone');
  ok(!!await waitFor(() => phone.evaluate(() => document.body.dataset.screen === 'tennis'), 5000), 'the phone became a racket');
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/phone-tennis.png` });

  // ------------------------------------------------ tennis: swing on cue over the socket
  await tv.evaluate(() => { const g = window.__ks.game; g.skip = true; window.__hits = []; g.onHitDebug = (i) => { if (i.human) window.__hits.push(i); }; });
  let served = false, swings = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000 && swings < 6) {
    const st = await tv.evaluate(() => {
      const g = window.__ks.game;
      if (!g) return null;
      const p = g.plan;
      return {
        phase: g.phase, serverMine: !!g.server?.seat, tossed: g.serve?.tossed, apexIn: g.serve?.apex - g.time,
        mine: !!(p && !p.done && p.hitter.seat && !p.hopeless), dt: p ? p.tc - g.time : null, side: p?.side,
      };
    });
    if (!st) break;
    if (st.phase === 'replay' || st.phase === 'score') await tv.evaluate(() => { window.__ks.game.replaySkip = true; });
    if (st.phase === 'serve' && st.serverMine) {
      if (!st.tossed) { await phone.evaluate(() => document.getElementById('btn-toss').click()); await sleep(80); continue; }
      if (st.apexIn < 0.12) {
        await phone.evaluate(() => window.__phone.send({ t: 'tswing', side: 'oh', speed: 0.7, plane: 0, roll: 0, lag: 30, age: 20, id: Date.now() % 1e9, mode: 'motion' }));
        served = true;
        await sleep(400);
        continue;
      }
    }
    if (st.phase === 'rally' && st.mine && st.dt !== null && st.dt < 0.09) {
      await phone.evaluate((side) => window.__phone.send({ t: 'tswing', side, speed: 0.6, plane: 0, roll: 0, lag: 30, age: 25, id: Date.now() % 1e9, mode: 'motion' }), st.side);
      swings++;
      await sleep(350);
      continue;
    }
    await sleep(25);
  }
  const hits = await tv.evaluate(() => window.__hits.length);
  ok(served || hits > 0, `phone swings reached the TV (served: ${served}, rally hits: ${hits} of ${swings} swings)`);
  ok(hits >= Math.max(1, Math.floor(swings * 0.6)), 'well-timed phone swings hit the ball');
  const tstate = await phone.evaluate(() => document.getElementById('t-title').textContent);
  ok(tstate.length > 0, `phone shows the tennis status (“${tstate}”)`);
  // Quit from the phone's pause: back to the lobby, everyone still in.
  await phone.evaluate(() => document.getElementById('btn-plus').click());
  ok(!!await waitFor(() => tv.evaluate(() => window.__ks.app.paused), 4000), '+ on the phone pauses the TV');
  await phone.evaluate(() => document.getElementById('btn-quit').click());
  ok(!!await waitFor(() => tv.evaluate(() => window.__ks.app.phase === 'lobby' && window.__ks.lobby.game === 'tennis'), 6000), 'Quit on the phone goes back to the Tennis lobby');
  ok(!!await waitFor(() => phone.evaluate(() => document.body.dataset.screen === 'lobby'), 5000), 'the phone is back in the lobby');

  // ------------------------------------------------ back to the menu, then Golf
  await tv.keyboard.press('Escape');
  ok(!!await waitFor(() => tv.evaluate(() => window.__ks.app.phase === 'menu'), 4000), 'Esc in the lobby goes back to the games menu');
  ok(!!await waitFor(() => phone.evaluate(() => document.body.dataset.screen === 'wait'), 5000), 'the phone waits while the TV picks a game');
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/phone-wait.png` });
  await tv.evaluate(() => document.querySelector('.game-card[data-game="golf"]').click());
  ok(!!await waitFor(() => phone.evaluate(() => document.body.dataset.screen === 'lobby' && document.getElementById('lobby-title').textContent === 'Golf'), 5000), 'the phone follows into the Golf lobby');
  await phone.evaluate(() => document.getElementById('btn-lobby-start').click());
  ok(!!await waitFor(() => tv.evaluate(() => window.__ks.app.phase === 'golf'), 15000), 'golf started from the phone');
  await tv.evaluate(() => { window.__ks.game.skip = true; });
  ok(!!await waitFor(() => tv.evaluate(() => window.__ks.game.phase === 'aim'), 8000), 'tee shot: aiming');
  ok(!!await waitFor(() => phone.evaluate(() => document.body.classList.contains('grip-on') && !document.getElementById('g-controls').hidden), 4000), 'the phone shows the club controls and the A grip');
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/phone-golf.png` });
  const aim0 = await tv.evaluate(() => window.__ks.game.turn.aim);
  await phone.evaluate(() => { window.__phone.send({ t: 'btn', b: 'right', down: true }); window.__phone.send({ t: 'btn', b: 'right', down: false }); });
  const aim1 = await waitFor(() => tv.evaluate((a) => { const v = window.__ks.game.turn.aim; return v !== a ? v : null; }, aim0), 3000);
  ok(aim1 !== null && aim1 > aim0, '▶ on the phone turns the aim right');
  await phone.evaluate(() => { window.__phone.send({ t: 'btn', b: 'down', down: true }); window.__phone.send({ t: 'btn', b: 'down', down: false }); });
  const club = await waitFor(() => tv.evaluate(() => (window.__ks.game.turn.club !== 'driver' ? window.__ks.game.turn.club : null)), 3000);
  ok(club === 'iron', `▼ changes the club (${club})`);
  await phone.evaluate(() => { window.__phone.send({ t: 'btn', b: 'up', down: true }); window.__phone.send({ t: 'btn', b: 'up', down: false }); });
  // Live club angle mirrors on the golfer, a practice swing shows on the meter, then the real one.
  await phone.evaluate(() => window.__phone.send({ t: 'gclub', a: 120, r: 0, armed: false }));
  await sleep(250);
  const ang = await tv.evaluate(() => window.__ks.game.turn.player.char.anim.club.angle);
  ok(ang > 60, `the golfer mirrors the phone's backswing (${Math.round(ang)}°)`);
  await phone.evaluate(() => window.__phone.send({ t: 'gswing', power: 0.6, curve: 0, practice: true, peak: 600, back: 120, id: 11, mode: 'motion' }));
  await sleep(200);
  ok(await tv.evaluate(() => window.__ks.game.phase === 'aim' && window.__ks.game.turn.practicePower === 0.6), 'a practice swing does not hit the ball');
  await phone.evaluate(() => window.__phone.send({ t: 'gswing', power: 0.9, curve: 0, practice: false, peak: 900, back: 150, id: 12, mode: 'motion' }));
  ok(!!await waitFor(() => tv.evaluate(() => ['swing', 'flight'].includes(window.__ks.game.phase)), 3000), 'holding A and swinging hits the ball');
  const res = await waitFor(() => tv.evaluate(() => (window.__ks.game.phase === 'result' ? window.__ks.game.turn.sim.rest.surface : null)), 20000);
  ok(!!res, `the ball came to rest (${res})`);
  const card = await phone.evaluate(() => document.querySelectorAll('#g-card .row').length);
  ok(card === 1, 'the phone shows the mini scorecard');
} catch (err) {
  fail++;
  console.log('  ✗ error:', err.message);
} finally {
  if (logs.length) console.log(logs.slice(0, 20).join('\n'));
  await browser.close();
}
console.log(`games e2e: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
