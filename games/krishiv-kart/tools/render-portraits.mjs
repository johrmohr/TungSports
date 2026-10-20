// Render the select-screen portraits of the 12 racers (SPEC §14.1):
// public/img/racers/<id>.png, 256×256, transparent background, used by the
// phone and desktop character cards.
//
//   node tools/render-portraits.mjs [--ids sahur,lirili] [--size 256] [--port 8231]
//
// Serves ./public (+ three.js) on a local port, opens the karts sandbox in
// portrait mode (/dev/karts.html?mode=portrait&char=<id>) in headless Chrome
// for each racer and screenshots the canvas with a transparent background.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { CHARACTERS } from '../public/js/characters.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; };
const SIZE = Number(opt('size', 256));
const PORT = Number(opt('port', 8231));
const ids = opt('ids', null) ? opt('ids').split(',') : CHARACTERS.map((c) => c.id);
const outDir = path.join(root, 'public/img/racers');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };

// Minimal static server (same layout as tools/devserver.mjs).
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = url.startsWith('/vendor/three/')
    ? path.join(root, 'node_modules/three', url.slice('/vendor/three/'.length))
    : path.join(root, 'public', url.endsWith('/') ? url + 'index.html' : url);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });

fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist'],
});
let failed = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { failed++; console.log(`[pageerror] ${e.message}`); });
  for (const id of ids) {
    await page.goto(`http://127.0.0.1:${PORT}/dev/karts.html?mode=portrait&char=${encodeURIComponent(id)}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__portraitReady === true', { timeout: 15000 });
    await page.evaluate(() => { const h = document.getElementById('hud'); if (h) h.remove(); });
    const file = path.join(outDir, `${id}.png`);
    const canvas = await page.$('canvas');
    await canvas.screenshot({ path: file, omitBackground: true });
    console.log(`[portrait] ${path.relative(root, file)}`);
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) { console.log(`${failed} page error(s)`); process.exit(1); }
