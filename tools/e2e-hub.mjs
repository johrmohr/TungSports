// End-to-end: picking Bowling / Krishiv Kart on the games menu starts it and
// sends the TV there (its own lobby and QR code). A phone that already joined
// in a lobby here follows, and HOME on the phone brings everyone back.
//   node tools/e2e-hub.mjs [--game bowling|kart] [--http 3000] [--https 3443] [--shots dir]
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const GAME = opt('--game', 'bowling');
const HTTP = Number(opt('--http', 3000));
const SHOTS = opt('--shots', null);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

async function waitFor(fn, ms = 15000, step = 200) {
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
  await tv.goto(`http://localhost:${HTTP}/`, { waitUntil: 'networkidle2' });
  const room = await waitFor(() => tv.evaluate(() => window.__ks?.link?.room));
  ok(!!room, `TV opened room ${room}`);

  // A player joins in the Tennis lobby, then the TV goes back to the games.
  await tv.evaluate(() => document.querySelector('.game-card[data-game="tennis"]').click());
  await waitFor(() => tv.evaluate(() => !!document.querySelector('.lobby .qr svg')), 5000);
  const phone = await browser.newPage();
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  phone.on('pageerror', (e) => logs.push(`[phone] ${e.message}`));
  // Like a real phone: the address from the QR code (the LAN IP).
  const info = await (await fetch(`http://localhost:${HTTP}/api/info`)).json();
  await phone.goto(`${info.phoneBaseUrl}?room=${room}`, { waitUntil: 'networkidle2' });
  await waitFor(() => phone.evaluate(() => document.body.dataset.screen === 'join'));
  await phone.evaluate(() => { document.getElementById('name-input').value = 'Jordan'; });
  await phone.click('#btn-join');
  ok(!!await waitFor(() => phone.evaluate(() => document.body.dataset.screen === 'lobby')), 'phone joined the Tennis lobby');
  await tv.bringToFront();
  const seats = await tv.evaluate(() => window.__ks.seats().map((s) => s.name));
  ok(seats.includes('Jordan'), `TV lists the player (${seats.join(', ')})`);
  await tv.keyboard.press('Escape');
  ok(!!await waitFor(() => tv.evaluate(() => window.__ks.app.phase === 'menu'), 4000), 'TV back on the games menu');
  ok(!!await waitFor(() => phone.evaluate(() => document.body.dataset.screen === 'wait'), 5000), 'phone waits for the TV to pick');

  // Pick the game on the TV.
  await tv.evaluate((g) => document.querySelector(`.game-card[data-game="${g}"]`).click(), GAME);
  const port = GAME === 'kart' ? 3200 : 3100;
  const tvMoved = await waitFor(() => tv.url().includes(`:${port}/`), 30000);
  ok(!!tvMoved, `TV went to ${GAME} (${tv.url().slice(0, 60)}…)`);
  const childRoom = await waitFor(() => tv.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || 'null')?.room, GAME === 'kart' ? 'krishivkart.host.room' : 'krishivbowling.display.room'), 15000);
  ok(childRoom === room, `${GAME} TV opened the same room code (${childRoom})`);
  const tvBtn = await waitFor(() => tv.evaluate(() => [...document.querySelectorAll('button')].some((b) => /Krishiv Sports/.test(b.textContent))), 8000);
  ok(!!tvBtn, 'TV shows the "Krishiv Sports" button');
  const phoneMoved = await waitFor(() => phone.url().includes(GAME === 'kart' ? ':3643/pad' : ':3543/remote'), 20000);
  ok(!!phoneMoved, `phone followed to ${GAME} (${phone.url().slice(0, 70)}…)`);
  await sleep(1500);
  if (GAME === 'bowling') {
    const prefill = await phone.evaluate(() => localStorage.getItem('bowl.name'));
    ok(prefill === 'Jordan', `phone profile carried over (${prefill})`);
  }
  const home = await waitFor(() => phone.evaluate(() => !!document.querySelector('.tb-right button[aria-label="Krishiv Sports menu"]')), 8000);
  ok(!!home, 'phone has a HOME button in the top bar');
  if (SHOTS) { await phone.screenshot({ path: `${SHOTS}/phone-${GAME}.png` }); await tv.screenshot({ path: `${SHOTS}/tv-${GAME}.png` }); }

  // HOME on the phone → confirm → everyone back to the games menu.
  await phone.evaluate(() => document.querySelector('.tb-right button[aria-label="Krishiv Sports menu"]').click());
  await sleep(300);
  await phone.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.dataset.k === 'yes').click());
  const tvBack = await waitFor(() => tv.url().includes(`:${HTTP}/`), 15000);
  ok(!!tvBack, 'TV went back to Krishiv Sports');
  const sameRoom = await waitFor(() => tv.evaluate(() => window.__ks?.link?.room), 10000);
  ok(sameRoom === room, `menu reclaimed room ${sameRoom}`);
  ok(!!await waitFor(() => tv.evaluate(() => window.__ks.app.phase === 'menu'), 5000), 'TV shows the games menu');
  const phoneBack = await waitFor(() => phone.url().startsWith(info.phoneBaseUrl), 15000);
  ok(!!phoneBack, 'phone came back');
  const rejoined = await waitFor(() => phone.evaluate(() => document.body.dataset.screen === 'wait'), 15000);
  ok(!!rejoined, 'phone rejoined without asking again and waits for the next game');
  const still = await tv.evaluate(() => window.__ks.seats().map((s) => `${s.name}${s.connected ? '' : '(off)'}`));
  ok(still.includes('Jordan'), `same player slot (${still.join(', ')})`);
} catch (err) {
  fail++;
  console.log('  ✗ error:', err.message);
} finally {
  if (logs.length) console.log(logs.slice(0, 20).join('\n'));
  await browser.close();
}
console.log(`hub e2e (${GAME}): ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
