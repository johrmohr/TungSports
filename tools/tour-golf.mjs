// Screenshots of every golf hole: flyover start and the tee shot view.
//   node tools/tour-golf.mjs <outdir> [--http 3010]
import puppeteer from 'puppeteer-core';
const out = process.argv[2] || '/tmp';
const HTTP = Number(process.argv[process.argv.indexOf('--http') + 1] || 3010) || 3010;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], defaultViewport: { width: 1280, height: 720 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${HTTP}/`, { waitUntil: 'networkidle2' });
await sleep(1200);
await page.evaluate(async () => { window.__ks.addLocal(); await window.__ks.startGame('golf', { course: 'full' }); });
const holes = (process.argv.find((a) => a.startsWith('--holes='))?.slice(8) || '1,2,3,4,5,6,7,8,9').split(',').map(Number);
for (const n of holes) {
  await page.evaluate(async (n) => { const g = window.__ks.game; g.round.holeIndex = n - 1; await g._loadHole(); g._flyover(); }, n);
  await sleep(1400);
  await page.screenshot({ path: `${out}/hole${n}-fly.png` });
  await page.evaluate(() => { window.__ks.game.skip = true; });
  await sleep(1600);
  await page.screenshot({ path: `${out}/hole${n}-tee.png` });
  console.log('hole', n, await page.evaluate(() => { const t = window.__ks.game.turn; return `${t.club} ${Math.round(t.dist)} m aim ${(t.aim * 57.3).toFixed(1)}°`; }));
}
await browser.close();
