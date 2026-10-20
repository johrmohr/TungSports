import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('screenshots/brainrot-verify');
fs.mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1280, height: 720 },
});

const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

// 1. Visit TV display
await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => window.__bowl && window.__bowl.phase() === 'lobby', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 1000));

// Add players
await page.evaluate(() => {
  __bowl.addLocal('Tung Fan');
  __bowl.addLocal('Sigma King');
});
await new Promise((r) => setTimeout(r, 600));

// Screenshot 1: Lobby with 2 players (Tung Tung + Tralalero)
await page.screenshot({ path: path.join(out, '01-lobby-brainrot.png') });
console.log('Saved 01-lobby-brainrot.png');

// Click character pill on Player 1 to open Character Modal
const pill = await page.$('.seat.filled:nth-child(1) .seat-char-pill');
if (pill) await pill.click();
await new Promise((r) => setTimeout(r, 600));

// Screenshot 2: Character Selection Modal on TV
await page.screenshot({ path: path.join(out, '02-character-modal.png') });
console.log('Saved 02-character-modal.png');

// Select GigaChad from modal
await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll('.modal-char-card'));
  const chad = cards.find(c => c.textContent.includes('GigaChad') || c.textContent.includes('Sigma'));
  if (chad) chad.click();
});
await new Promise((r) => setTimeout(r, 500));

// Cycle Player 2 using next button to Skibidi Toilet
await page.evaluate(() => {
  const nextBtns = document.querySelectorAll('.seat.filled:nth-child(2) .seat-char-nav');
  if (nextBtns.length >= 2) nextBtns[1].click(); // click next
});
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: path.join(out, '03-lobby-custom-chars.png') });
console.log('Saved 03-lobby-custom-chars.png');

// 2. Open phone remote page with room code to verify remote UI character selector
const room = await page.evaluate(() => __bowl.app.link?.room || 'TEST');
const remotePage = await browser.newPage();
await remotePage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await remotePage.goto(`http://localhost:3000/remote?room=${room}`, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1000));
await remotePage.screenshot({ path: path.join(out, '04-phone-remote-chars.png') });
console.log('Saved 04-phone-remote-chars.png');

// 3. Test Game Over Screen with brainrot characters
await page.evaluate(() => {
  __bowl.screens.showOver(
    [
      { name: 'Tung Fan', color: 0, character: 'tung_tung', total: 215, frames: [] },
      { name: 'Sigma King', color: 1, character: 'gigachad', total: 188, frames: [] }
    ],
    [
      { name: 'Tung Fan', color: 0, character: 'tung_tung', place: 1, total: 215 },
      { name: 'Sigma King', color: 1, character: 'gigachad', place: 2, total: 188 }
    ]
  );
});
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: path.join(out, '05-results-brainrot.png') });
console.log('Saved 05-results-brainrot.png');

if (errors.length) console.log('Errors:', errors);
else console.log('Zero errors!');

await browser.close();
