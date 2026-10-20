// Starts a fresh server on free ports and runs the headless-Chrome tests
// against it: a phone driving Tennis and Golf, then the hand-off to Bowling
// and Krishiv Kart (when those folders are installed) and back with HOME.
//   node tools/e2e.mjs [games] [bowling] [kart] [--shots dir]
//   node tools/e2e.mjs --tour <dir>      screenshots of all nine golf holes
// Needs Google Chrome (or CHROME_PATH pointing at a Chrome / Chromium binary).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) {
  console.log(`e2e: Chrome not found at ${CHROME} — set CHROME_PATH to a Chrome or Chromium binary.`);
  process.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const HTTP = await freePort();
let HTTPS = await freePort();
while (HTTPS === HTTP) HTTPS = await freePort();

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(HTTP), HTTPS_PORT: String(HTTPS), NO_OPEN: '1', NO_COLOR: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (d) => { output += d; });
server.stderr.on('data', (d) => { output += d; });
let exited = false;
server.on('exit', () => { exited = true; });

let info = null;
for (let i = 0; i < 100 && !exited && !info; i++) {
  try { info = await (await fetch(`http://localhost:${HTTP}/api/info`)).json(); } catch { await sleep(200); }
}
const failed = [];
if (!info) {
  failed.push('server start');
} else {
  console.log(`e2e: server on http://localhost:${HTTP} (phones: ${info.phoneBaseUrl})`);
  const run = (label, script, extra = []) => {
    console.log(`\n▶ ${label}`);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', script), ...extra], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) failed.push(label);
  };
  const tour = opt('--tour');
  if (tour) {
    fs.mkdirSync(tour, { recursive: true });
    run('golf tour', 'tour-golf.mjs', [tour, '--http', String(HTTP)]);
  } else {
    const shots = opt('--shots');
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const extra = ['--http', String(HTTP), '--https', String(HTTPS), ...(shots ? ['--shots', shots] : [])];
    const picked = args.filter((a) => ['games', 'bowling', 'kart'].includes(a));
    const want = picked.length ? picked : ['games', 'bowling', 'kart'];
    if (want.includes('games')) run('Tennis + Golf with a phone', 'e2e-games.mjs', extra);
    for (const g of ['bowling', 'kart']) {
      if (!want.includes(g)) continue;
      if (!info.games?.[g]?.installed) { console.log(`\n– ${g}: skipped (${info.games?.[g]?.why || 'not installed'})`); continue; }
      run(`${g === 'kart' ? 'Krishiv Kart' : 'Bowling'} hand-off and HOME`, 'e2e-hub.mjs', ['--game', g, ...extra]);
    }
  }
}

server.kill('SIGTERM');   // also stops any Bowling / Kart server it started
await Promise.race([new Promise((r) => server.once('exit', r)), sleep(3000)]);
if (!exited) server.kill('SIGKILL');
if (failed.length) {
  console.log(`\ne2e: failed — ${failed.join(', ')}`);
  console.log(output.split('\n').slice(-30).join('\n'));
  process.exit(1);
}
console.log('\ne2e: all passed');
