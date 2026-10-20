// Server test: starts server.js on free ports (with its own certificate
// folder) and drives it like a TV and phones would, over Socket.IO and the
// small JSON API the Bowling / Krishiv Kart pages use.
//   node tools/net-test.mjs [-v]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { io as connectIo } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('-v');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; if (VERBOSE) console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

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
const BASE = `http://localhost:${HTTP}`;
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krishiv-net-'));

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(HTTP), HTTPS_PORT: String(HTTPS), NO_OPEN: '1', NO_COLOR: '1', ROOM_GRACE_MS: '1500', KRISHIV_SPORTS_CERT_DIR: certDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (d) => { output += d; });
server.stderr.on('data', (d) => { output += d; });
let exited = false;
server.on('exit', () => { exited = true; });

const sockets = [];
function connect(extra = {}) {
  const s = connectIo(BASE, { transports: ['websocket'], forceNew: true, reconnection: false, ...extra });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 4000);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}
const call = (s, ev, payload, ms = 4000) => s.timeout(ms).emitWithAck(ev, payload);
function next(s, ev, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { s.off(ev, h); reject(new Error(`no ${ev} within ${ms} ms`)); }, ms);
    const h = (d) => { clearTimeout(t); resolve(d); };
    s.once(ev, h);
  });
}
// Resolves with the first `ev` matching `fn` (or null after ms).
function nextWhere(s, ev, fn, ms = 3000) {
  return new Promise((resolve) => {
    const h = (d) => { if (fn(d)) { clearTimeout(t); s.off(ev, h); resolve(d); } };
    const t = setTimeout(() => { s.off(ev, h); resolve(null); }, ms);
    s.on(ev, h);
  });
}
const nothing = (s, ev, ms = 350) => new Promise((resolve) => {
  const h = () => { clearTimeout(t); resolve(false); };
  const t = setTimeout(() => { s.off(ev, h); resolve(true); }, ms);
  s.once(ev, h);
});
const seatOf = (clientId, code) => crypto.createHash('sha256').update(`${clientId}:${code}`).digest('base64url').slice(0, 24);
const api = (p, init) => fetch(`${BASE}${p}`, init);

try {
  // ------------------------------------------------------------ start-up
  let info = null;
  for (let i = 0; i < 100 && !exited && !info; i++) {
    try { info = await (await api('/api/info')).json(); } catch { await sleep(200); }
  }
  ok(!!info, `server answered on port ${HTTP}`);
  if (!info) throw new Error('server did not start');
  console.log(`net: server on ${HTTP}/${HTTPS}${info.https ? ' (https on)' : ' (http only)'}`);

  // ------------------------------------------------------------ http
  ok(info.title === 'Krishiv Sports' && info.httpPort === HTTP && info.httpsPort === HTTPS, '/api/info names the game and its ports');
  ok(/\/play$/.test(info.phoneBaseUrl), `phone address ends in /play (${info.phoneBaseUrl})`);
  ok(['bowling', 'kart'].every((g) => typeof info.games?.[g]?.installed === 'boolean'), 'reports whether Bowling and Krishiv Kart are installed');
  let r = await api('/');
  ok(r.status === 200 && /text\/html/.test(r.headers.get('content-type')) && /Krishiv Sports/.test(await r.text()), 'the TV page is served');
  r = await api('/play');
  ok(r.status === 200 && /<title>Krishiv Sports<\/title>/.test(await r.text()), 'the phone page is served on loopback http');
  r = await api('/remote?room=ABCD', { redirect: 'manual' });
  ok(r.status === 302 && r.headers.get('location') === '/play?room=ABCD', 'old /remote links go to /play (query kept)');
  r = await api('/hub-link.js');
  ok(r.status === 200 && r.headers.get('access-control-allow-origin') === '*' && /javascript/.test(r.headers.get('content-type')), 'hub-link.js is served to the other games');
  r = await api('/vendor/three/build/three.module.js', { method: 'HEAD' });
  ok(r.status === 200, 'three.js is served from node_modules');
  r = await api('/js/shared/protocol.js');
  ok(r.status === 200 && /javascript/.test(r.headers.get('content-type')), 'shared modules are served');
  if (info.https && info.lanIps.length) {
    const ip = info.lanIps[0];
    r = await fetch(`http://${ip}:${HTTP}/play?room=ABCD`, { redirect: 'manual' });
    ok(r.status === 302 && r.headers.get('location') === `https://${ip}:${HTTPS}/play?room=ABCD`, `a phone on http://${ip} is sent to https (motion needs it)`);
    const cert = await new Promise((resolve) => {
      const sock = tls.connect({ host: '127.0.0.1', port: HTTPS, rejectUnauthorized: false, servername: 'localhost' }, () => { resolve(sock.getPeerCertificate()); sock.end(); });
      sock.on('error', () => resolve(null));
    });
    ok(!!cert && cert.subjectaltname?.includes(`IP Address:${ip}`), `the HTTPS certificate covers the LAN address ${ip}`);
    const days = cert ? (Date.parse(cert.valid_to) - Date.parse(cert.valid_from)) / 86400000 : 0;
    ok(days > 0 && days <= 825, `certificate lifetime ${Math.round(days)} days (iOS allows ≤ 825)`);
  }

  // ------------------------------------------------------------ TV + phones
  const tv = await connect();
  const made = await call(tv, 'display:create', {});
  ok(made.ok && /^[A-HJKMNP-Z]{4}$/.test(made.room) && typeof made.key === 'string', `TV opened room ${made.room}`);
  ok(/^<svg/.test(made.qrSvg || '') && made.joinUrl === `${info.phoneBaseUrl}?room=${made.room}`, 'with a QR code for the join address');
  ok(made.players.length === 4 && made.players.every((p) => p === null), 'four empty slots');
  const room = made.room;
  const other = room === 'WXYZ' ? 'VWXY' : 'WXYZ';

  ok((await call(tv, 'remote:join', { room })).code === 'role', 'the TV connection cannot join as a phone');

  const a = await connect();
  ok((await call(a, 'remote:join', { room: 'AB' })).code === 'bad_code', 'a malformed code is refused');
  ok((await call(a, 'remote:join', { room: 'abc1' })).code === 'bad_code', 'letters outside the code alphabet are refused');
  ok((await call(a, 'remote:join', { room: other })).code === 'no_room', 'an unknown room is refused');
  const joinSeen = next(tv, 'player:join');
  const ja = await call(a, 'remote:join', { room: room.toLowerCase(), clientId: 'net-test-client-a', name: '  Ace​‮Bot  ', color: 'red', character: 'gigachad', hand: 'left' });
  ok(ja.ok && ja.slot === 0 && ja.room === room, 'a phone joins slot 1 (code is case-insensitive)');
  ok(ja.name === 'AceBot' && ja.color === 'red' && ja.character === 'gigachad' && ja.hand === 'left', `its profile is kept and the name cleaned (${JSON.stringify(ja.name)})`);
  const pj = await joinSeen;
  ok(pj.slot === 0 && pj.name === 'AceBot' && pj.connected && !pj.rejoin, 'the TV hears about the new player');

  // Inputs: forwarded with the slot, cleaned on the way.
  let got = next(tv, 'remote:input');
  ok((await call(a, 'remote:input', { t: 'btn', b: 'a', down: true })).ok, 'a button press is acknowledged');
  const btn = await got;
  ok(btn.slot === 0 && btn.t === 'btn' && btn.b === 'a' && btn.down === true, 'the TV gets the button with the player slot');
  ok(!(await call(a, 'remote:input', { t: 'btn', b: 'self-destruct', down: true })).ok, 'unknown buttons are refused');
  ok(!(await call(a, 'remote:input', { t: 'eval', code: 'x' })).ok, 'unknown input types are refused');
  got = next(tv, 'remote:input');
  await call(a, 'remote:input', { t: 'tswing', side: 'sideways', speed: 99, plane: -7, roll: 'x', lag: 1e9, id: 5, mode: 'hack', extra: { evil: true } });
  const sw = await got;
  ok(sw.side === 'fh' && sw.speed === 1.2 && sw.plane === -1 && sw.roll === 0 && sw.lag === 600 && sw.mode === 'motion' && !('extra' in sw), 'a tennis swing is clamped to sane values');
  got = next(tv, 'remote:input');
  await call(a, 'remote:input', { t: 'gswing', power: 3, curve: -2, practice: 'yes', peak: 800, back: 140, id: 9 });
  const gs = await got;
  ok(gs.power === 1.6 && gs.curve === -1 && gs.practice === false && gs.peak === 800, 'a golf swing is clamped (practice only when exactly true)');
  got = next(tv, 'remote:input');
  await call(a, 'remote:input', { t: 'menu', action: 'setup', value: 'tennis', opts: { format: 3, level: 'pro', Bad: 1, 'x y': 2, deep: { a: 1 } } });
  const mn = await got;
  ok(mn.action === 'setup' && mn.value === 'tennis' && JSON.stringify(mn.opts) === '{"format":3,"level":"pro"}', 'menu actions keep only simple options');
  ok(!(await call(a, 'remote:input', { t: 'ptr', x: 0.5, y: 0.5 })).ok, 'there is no pointer input any more');
  ok(!(await call(a, 'remote:input', { t: 'menu', action: 'pick', value: 'golf' })).ok, 'phones cannot pick the game (the TV does)');

  // TV → phone state and events.
  got = next(a, 'state');
  tv.emit('display:state', { slot: 0, state: { phase: 'menu', n: 1 } });
  ok((await got).n === 1, 'TV state reaches the phone of that slot');
  const big = nothing(a, 'state', 400);
  tv.emit('display:state', { slot: 0, state: { junk: 'x'.repeat(30 * 1024) } });
  ok(await big, 'oversized TV state is dropped');
  got = next(a, 'event');
  tv.emit('display:event', { slot: 'all', event: { type: 'buzz', ms: 30 } });
  ok((await got).type === 'buzz', 'TV events reach every phone');

  // More phones, a full room.
  const b = await connect(), c2 = await connect(), d = await connect(), e = await connect();
  const jb = await call(b, 'remote:join', { room, clientId: 'net-test-client-b', name: 'Bea', color: 'red' });
  ok(jb.ok && jb.slot === 1 && jb.color !== 'red', `two phones never share a colour (second got ${jb.color})`);
  ok((await call(c2, 'remote:join', { room, clientId: 'net-test-client-c', name: 'Cy' })).slot === 2, 'third phone → slot 3');
  ok((await call(d, 'remote:join', { room, clientId: 'net-test-client-d', name: 'Dee' })).slot === 3, 'fourth phone → slot 4');
  ok((await call(e, 'remote:join', { room, clientId: 'net-test-client-e', name: 'Eve' })).code === 'full', 'a fifth phone is told the game is full');

  // Phones cannot drive the TV's side.
  const notKicked = nothing(b, 'kicked', 300);
  d.emit('display:kick', { slot: 1 });
  ok(await notKicked, 'a phone cannot kick another player');
  const hub0 = await (await api(`/api/hub/room/${room}`)).json();
  ok(hub0.ok && hub0.where === 'menu' && hub0.tvHere === true && hub0.homeSeq === 0, 'the hub API reports the room (menu, TV here)');

  // TV-side profile change and kick.
  got = next(a, 'profile:updated');
  tv.emit('display:profile', { slot: 0, character: 'skibidi', color: 'red', name: 'Ace' });
  const prof = await got;
  ok(prof.character === 'skibidi' && prof.name === 'Ace', 'the TV can change a player\'s character and name');
  got = next(d, 'kicked');
  const removed = next(tv, 'player:remove');
  tv.emit('display:kick', { slot: 3 });
  ok((await got).reason === 'removed' && (await removed).slot === 3, 'the TV can remove a player');
  ok((await call(e, 'remote:join', { room, clientId: 'net-test-client-e', name: 'Eve' })).slot === 3, 'the freed slot takes the waiting phone');

  // A phone drops and comes back: same slot, same profile.
  const left = next(tv, 'player:leave');
  b.disconnect();
  ok((await left).slot === 1, 'the TV hears when a phone drops');
  const b2 = await connect();
  const back = next(tv, 'player:join');
  const jb2 = await call(b2, 'remote:join', { room, clientId: 'net-test-client-b' });
  const pb = await back;
  ok(jb2.slot === 1 && jb2.name === 'Bea' && pb.rejoin === true, 'the phone reclaims its own slot and name');

  // Rate limits: a burst of swings is cut off, nothing crashes.
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => call(c2, 'remote:input', { t: 'tswing', side: 'fh', speed: 0.5, id: 100 + i }).catch(() => ({ ok: false }))));
  const limited = burst.filter((x) => x.code === 'rate').length;
  ok(limited >= 15 && burst.filter((x) => x.ok).length <= 20, `a swing flood is rate limited (${limited} of 40 refused)`);

  // ------------------------------------------------------------ hub API (Bowling / Kart pages)
  const H = (p, init) => api(`/api/hub/room/${room}${p}`, init);
  r = await H('/home', { method: 'POST' });
  ok((await r.json()).homeSeq === 1, 'HOME from a phone bumps homeSeq');
  ok((await (await H('?tv=1')).json()).homeSeq === 1, 'the other game\'s TV page sees it');
  r = await H('/child', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ room: 'ABCD', game: 'bowling' }) });
  ok((await r.json()).ignored === true, 'a child-room report is ignored while the TV is on the menu');
  r = await H('/child', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ room: 'ABCD', game: 'chess' }) });
  ok(r.status === 400, 'unknown games are refused');
  r = await api(`/api/hub/room/${other}`);
  ok(r.status === 404, 'unknown rooms are 404');
  r = await H('', { headers: { origin: `http://localhost:3100` } });
  ok(r.status === 200 && r.headers.get('access-control-allow-origin') === 'http://localhost:3100', 'CORS allows this machine\'s other games');
  r = await H('', { headers: { origin: 'https://evil.example' } });
  ok(r.status === 429 && !r.headers.get('access-control-allow-origin'), 'other websites are refused');
  r = await H('/home', { method: 'OPTIONS', headers: { origin: 'http://localhost:3200', 'access-control-request-method': 'POST' } });
  ok(r.status === 204 && /POST/.test(r.headers.get('access-control-allow-methods') || ''), 'CORS preflight answers');
  await sleep(1100);   // the API budget is per second
  tv.emit('display:where', { where: 'golf' });
  await sleep(150);
  ok((await (await H('')).json()).where === 'golf', 'the TV reports which sport it is in');
  tv.emit('display:where', { where: 'bowling' });
  await sleep(150);
  ok((await (await H('')).json()).where === 'golf', 'only the server can send the room to Bowling / Kart');
  tv.emit('display:where', { where: 'menu' });
  ok((await call(tv, 'display:launch', { game: 'minesweeper' })).ok === false, 'launching an unknown game fails cleanly');

  // Sockets from other websites are refused.
  let refused = false;
  try { await connect({ extraHeaders: { origin: 'https://evil.example' } }); } catch { refused = true; }
  ok(refused, 'a socket from another website is refused');

  // ------------------------------------------------------------ TV reload, server restart
  const gone = next(a, 'display:gone');
  tv.disconnect();
  ok((await gone).where === 'menu', 'phones hear the TV went away');
  const tv2 = await connect();
  const backA = next(a, 'display:back');
  const re = await call(tv2, 'display:create', { room, key: made.key });
  ok(re.ok && re.room === room && re.reclaimed, 'a reloaded TV reclaims its room with the key');
  ok(re.players.filter(Boolean).map((p) => p.name).join(',') === 'Ace,Bea,Cy,Eve', `players are still seated (${re.players.filter(Boolean).map((p) => p.name).join(', ')})`);
  await backA;
  ok(true, 'phones hear the TV is back');
  const thief = await connect();
  const stolen = await call(thief, 'display:create', { room, key: 'wrong-key' });
  ok(stolen.ok && stolen.room !== room, 'a TV without the key gets a fresh room instead');

  // After a server restart the TV re-creates its room with the seat tokens.
  const tv3 = await connect();
  const seats = [{ slot: 0, seat: seatOf('net-test-client-z', other), name: 'Zed', color: 'green', character: 'smurf_cat' }, { slot: 1, seat: 'bad seat!', name: 'X' }];
  const rs = await call(tv3, 'display:create', { room: other, seats });
  ok(rs.ok && rs.room === other && rs.players[0]?.name === 'Zed' && !rs.players[0].connected && rs.players[1] === null, 'a TV restores its seats into a re-created room');
  const z = await connect();
  const jz = await call(z, 'remote:join', { room: other, clientId: 'net-test-client-z' });
  ok(jz.slot === 0 && jz.name === 'Zed' && jz.character === 'smurf_cat', 'the phone with that seat gets its slot back');

  // A TV that never comes back: the room closes after the grace period.
  const closed = next(a, 'room:closed', 5000);
  tv2.disconnect();
  ok((await closed).reason === 'expired', 'the room closes when the TV is gone for good');
  ok((await api(`/api/hub/room/${room}`)).status === 404, 'and the hub API forgets it');
} catch (err) {
  fail++;
  console.log('  ✗ error:', err?.message || err);
} finally {
  for (const s of sockets) s.disconnect();
  server.kill('SIGTERM');
  await Promise.race([new Promise((r) => server.once('exit', r)), sleep(2000)]);
  if (!exited) server.kill('SIGKILL');
  fs.rmSync(certDir, { recursive: true, force: true });
  if (fail && output) console.log(output.split('\n').slice(-30).join('\n'));
}
console.log(`net: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
