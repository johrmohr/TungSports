// Headless Chrome helper: open the TV page, run a script, take screenshots.
//   node tools/shot.mjs <url> <out-prefix> [--wait ms] [--js "<code>"]… [--every ms --count n] [--size 1280x720]
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const url = args[0] || 'http://localhost:3010/';
const out = args[1] || '/tmp/shot';
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const js = []; args.forEach((a, i) => { if (a === '--js') js.push(args[i + 1]); });
const wait = Number(opt('--wait', 1500));
const every = Number(opt('--every', 0));
const count = Number(opt('--count', 1));
const [w, h] = opt('--size', '1280x720').split('x').map(Number);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--ignore-certificate-errors'],
  defaultViewport: { width: w, height: h, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1500));
for (const code of js) {
  const r = await page.evaluate(`(async () => { ${code} })()`).catch((e) => `ERR ${e.message}`);
  if (r !== undefined) console.log('js →', typeof r === 'string' ? r : JSON.stringify(r));
}
await new Promise((r) => setTimeout(r, wait));
for (let i = 0; i < count; i++) {
  const file = `${out}${count > 1 ? `-${String(i).padStart(2, '0')}` : ''}.png`;
  await page.screenshot({ path: file });
  console.log('saved', file);
  if (every && i < count - 1) await new Promise((r) => setTimeout(r, every));
}
const final = opt('--final', null);
if (final) { const r = await page.evaluate(`(async () => { ${final} })()`).catch((e) => `ERR ${e.message}`); console.log('final →', typeof r === 'string' ? r : JSON.stringify(r)); }
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
