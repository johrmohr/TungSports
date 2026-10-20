// Visual tour: drives a keyboard game in headless Chrome and saves
// screenshots of every stage (lobby, intro, aim, roll, strike, card, react,
// sweep, results).   node tools/tour.mjs [outDir] [--url http://localhost:3000]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = path.resolve(args.find((a) => !a.startsWith('--')) || 'screenshots');
const url = (args.find((a) => a.startsWith('--url=')) || '--url=http://localhost:3000').slice(6);
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
await page.goto(url, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => window.__bowl && window.__bowl.phase() === 'lobby', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));
const shot = async (name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }); console.log('  shot', name); };
const waitStep = (step, ms = 20000) => page.waitForFunction((s) => window.__bowl.step() === s, { timeout: ms }, step);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await shot('01-lobby');
await page.evaluate(() => { __bowl.addLocal('Jordan'); __bowl.addLocal('Krishiv'); __bowl.addLocal('Maya'); __bowl.addLocal('Bartholomew'); });
await sleep(400);
await shot('02-lobby-players');
await page.evaluate(() => __bowl.start());
await sleep(700);
await shot('03-intro');
await waitStep('aim');
await sleep(600);
await shot('04-aim');
// Zoom + turn mode via the keyboard.
await page.keyboard.press('ArrowUp');
await sleep(900);
await shot('05-zoom');
await page.keyboard.press('ArrowUp');
await sleep(500);
// Strike attempt into the pocket with a hook.
await page.evaluate(() => __bowl.bowl({ aimX: 0.3, angle: -0.5, speed: 0.75, spin: -0.45 }));
await sleep(250);
await shot('06-release');
await sleep(900);
await shot('07-roll');
await sleep(1100);
await shot('08-impact');
await waitStep('result');
await sleep(500);
await shot('09-result');
const r1 = await page.evaluate(() => __bowl.app.lastResult);
console.log('  ball 1:', JSON.stringify(r1));
await page.waitForFunction(() => ['react', 'sweep'].includes(__bowl.step()), { timeout: 15000 });
await sleep(500);
await shot('10-react-or-sweep');
await page.waitForFunction(() => __bowl.step() === 'sweep', { timeout: 15000 });
await sleep(900);
await shot('11-sweep');
await page.waitForFunction(() => ['intro', 'aim'].includes(__bowl.step()), { timeout: 20000 });
await sleep(400);
await shot('12-next');
// A backwards drop.
await page.evaluate(() => { if (__bowl.step() === 'intro') __bowl.app.turn && null; });
await page.waitForFunction(() => __bowl.step() === 'aim', { timeout: 20000 }).catch(() => {});
await page.evaluate(() => __bowl.bowl({ quality: 'drop', speed: 0.5 }));
await sleep(1200);
await shot('13-drop');
await page.waitForFunction(() => __bowl.step() === 'aim', { timeout: 20000 });
// Play the rest of the game fast.
await page.evaluate(() => __bowl.setTimeScale(4));
let guard = 0;
while (guard++ < 200) {
  const ph = await page.evaluate(() => __bowl.phase());
  if (ph === 'over') break;
  const st = await page.evaluate(() => __bowl.step());
  if (st === 'aim' || st === 'intro') {
    await page.evaluate(() => {
      const r = Math.random();
      __bowl.bowl({ aimX: 0.2 + Math.random() * 0.2, angle: -0.5 - Math.random(), speed: 0.5 + Math.random() * 0.4, spin: -0.2 - r * 0.6 });
    });
  }
  await sleep(300);
}
await sleep(1500);
await shot('14-results');
const board = await page.evaluate(() => __bowl.board()?.map((b) => ({ name: b.name, total: b.total, complete: b.complete })));
console.log('  final:', JSON.stringify(board));
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
