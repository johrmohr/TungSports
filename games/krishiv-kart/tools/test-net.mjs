// Protocol tests for server.js + public/js/net.js (SPEC §11, §14.7).
//
//   node tools/test-net.mjs              # spawns the server on PORT=3100 HTTPS_PORT=3543
//   node tools/test-net.mjs --no-spawn   # use an already running server on those ports
//                                        # (start it with SLOT_RESERVE_MS=2500 ROOM_GRACE_MS=1500)
//
// Prints PASS/FAIL per case and exits non-zero on any failure.
import { spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { loadRoster, charactersForState, bodiesForState, wheelsForState, FAKE_CUSTOM } from './pad-host.mjs';
import { PLAYER_SLOTS, computeRatings } from '../public/js/parts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3100;
const HTTPS_PORT = 3543;
const GRACE_MS = 1500;
const RESERVE_MS = 2500;
const HTTP_URL = `http://localhost:${PORT}`;
const HTTPS_URL = `https://localhost:${HTTPS_PORT}`;
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
const spawnServer = !process.argv.includes('--no-spawn');
const COLORS = PLAYER_SLOTS.map((s) => s.css);

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sockets = new Set();

function getUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

function connect(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const s = ioClient(url, { reconnection: false, forceNew: true, rejectUnauthorized: false, timeout: 4000, ...opts });
    sockets.add(s);
    const t = setTimeout(() => reject(new Error(`connect timeout ${url}`)), 5000);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}

const ack = (s, ev, payload, ms = 3000) => s.timeout(ms).emitWithAck(ev, payload);

// Minimal Web Storage stand-in. Node 26 has a process-wide sessionStorage and a
// localStorage that warns unless --localstorage-file is given: tests install
// their own per simulated browser tab.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
function setStorage(name, store) {
  Object.defineProperty(globalThis, name, { value: store, configurable: true, writable: true, enumerable: false });
}
setStorage('localStorage', memoryStorage());
setStorage('sessionStorage', memoryStorage());

// Resolves with the next `ev` payload matching `pred` (rejects after ms).
function waitFor(s, ev, ms = 2000, pred = () => true) {
  const promise = new Promise((resolve, reject) => {
    const fn = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, fn); resolve(p); } };
    const t = setTimeout(() => { s.off(ev, fn); reject(new Error(`timed out waiting for ${ev}`)); }, ms);
    s.on(ev, fn);
  });
  promise.catch(() => {});   // a failing test may never await it; avoid unhandled rejections
  return promise;
}

// Resolves true when no `ev` arrives within ms (else the payload that came).
function expectNone(s, ev, ms = 400) {
  return new Promise((resolve) => {
    let got = null;
    const fn = (p) => { got = p; };
    s.on(ev, fn);
    setTimeout(() => { s.off(ev, fn); resolve(got === null ? true : got); }, ms);
  });
}

// Collects every `ev` payload on a socket until stop() is called.
function collect(s, ev) {
  const out = [];
  const fn = (p) => out.push(p);
  s.on(ev, fn);
  out.stop = () => s.off(ev, fn);
  return out;
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}: expected ${jb}, got ${ja}`);
}

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} ${dim(`(${Date.now() - t0} ms)`)}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL  ${name}: ${err?.message || err}`);
  }
}
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

// Key-order independent JSON (deep equality of relayed payloads).
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

// A fresh room with a raw host socket.
async function newHost() {
  const h = await connect(HTTP_URL, { transports: ['websocket'] });
  const res = await ack(h, 'host:create', {});
  return { h, room: res.room, key: res.key };
}

// A phone joining `room` as `padId`; resolves { p, res }.
async function phone(room, padId) {
  const p = await connect(HTTPS_URL, { transports: ['websocket'] });
  const res = await ack(p, 'pad:hello', { room, padId });
  return { p, res };
}

// A host + one pad in a fresh room.
async function pairUp(padId) {
  const { h, room, key } = await newHost();
  const joined = waitFor(h, 'pad:join');
  const { p, res } = await phone(room, padId);
  assert(res.ok, `pad joined (${res.error})`);
  await joined;
  return { h, p, room, key };
}

// pad:menu is limited to 30 messages/s per socket: callers pace batches.
function menuBudget() {
  let sent = 0;
  let windowStart = Date.now();
  return async (n) => {
    if (Date.now() - windowStart > 1000) { sent = 0; windowStart = Date.now(); }
    if (sent + n > 24) { await sleep(1100); sent = 0; windowStart = Date.now(); }
    sent += n;
  };
}

// v4 courses + cups (SPEC §15.3) as the desktop sends them (tracks.js cupInfo shape).
const V4_TRACKS = [['breezy', 'Breezy Bay Circuit'], ['monte', 'Monte Mozzarella'], ['aldrich', 'Aldrich Park'], ['laguna', 'Laguna Beach'], ['palace', "Krishiv's Palace"]]
  .map(([id, name]) => ({ id, name }));
const v4Ref = (id) => V4_TRACKS.find((t) => t.id === id);
const V4_CUPS = [
  { id: 'gelato', name: 'Gelato Cup', tracks: ['breezy', 'monte', 'aldrich', 'laguna'].map(v4Ref) },
  { id: 'krishiv', name: 'Krishiv Cup', tracks: ['breezy', 'laguna', 'monte', 'aldrich', 'palace'].map(v4Ref) },
];

// A realistic v4 shared host:state (SPEC §14.7, §15.3) built from the same roster /
// parts catalog the fake host and the desktop use: 12 racers + 1 custom,
// 6 bodies, 6 wheels, 4 players, 8 result rows.
const roster = await loadRoster();
const CHARACTERS = charactersForState([...roster, FAKE_CUSTOM]);
function realSharedState(screen = 'select') {
  const ids = ['sahur', 'ballerina', 'bombardiro', 'custom_robo'];
  return {
    screen, mode: 'gp', cc: 150, items: true, host: 1, raceNo: 1, races: 5,
    track: { id: 'breezy', name: 'Breezy Bay Circuit' },
    tracks: V4_TRACKS,
    cup: V4_CUPS[1],
    cups: V4_CUPS,                    // SPEC §15.3: the host picks a cup on the phone
    cupPick: 'krishiv',
    players: [1, 2, 3, 4].map((slot) => ({
      slot, color: COLORS[slot - 1], connected: slot !== 3, ready: slot === 2, char: ids[slot - 1],
      body: slot === 4 ? 'rocket' : 'standard', wheels: slot === 2 ? 'neon' : 'standard', assist: slot !== 4, step: slot === 2 ? 'done' : 'body',
    })),
    characters: CHARACTERS,
    bodies: bodiesForState(),
    wheels: wheelsForState(),
    results: screen === 'results' ? roster.slice(0, 8).map((d, k) => ({
      place: k + 1, name: d.shortName, cssColor: d.cssColor, time: Math.round((98.512 + k * 1.731) * 1000) / 1000, points: [10, 8, 6, 5, 4, 3, 2, 1][k],
      slot: k < 4 ? k + 1 : null, finished: k < 7,
    })) : null,
    standings: null,
  };
}

function realPadState(slot, extra = {}) {
  const def = roster.find((d) => d.id === 'sahur');
  const choice = { char: 'sahur', body: 'speedster', wheels: 'slick', assist: true };
  return {
    slot, color: COLORS[slot - 1], isHost: slot === 1, step: 'wheels', choice, ratings: computeRatings(def, choice),
    race: null, standing: null, ...extra,
  };
}

// ------------------------------------------------------------------ server

let server = null;
let serverLog = '';
async function startServer() {
  if (!spawnServer) return;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), NO_OPEN: '1', NO_COLOR: '1',
      ROOM_GRACE_MS: String(GRACE_MS), SLOT_RESERVE_MS: String(RESERVE_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  server.on('exit', (code) => { if (code) console.log(`server exited with ${code}\n${serverLog}`); });
}

async function waitForServer() {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    // Our own server must be the one answering (not a leftover on the same ports).
    if (server && server.exitCode !== null) throw new Error(`spawned server exited (${server.exitCode})\n${serverLog}`);
    if (!server || serverLog.includes('Desktop game')) {
      try {
        const r = await getUrl(`${HTTPS_URL}/api/info`);
        if (r.status === 200) return JSON.parse(r.body);
      } catch { /* not up yet */ }
    }
    await sleep(200);
  }
  throw new Error(`server did not start\n${serverLog}`);
}

// ------------------------------------------------------------------ tests: http + tls

await startServer();
let info;
try {
  info = await waitForServer();
} catch (err) {
  console.log(`FAIL  server startup: ${err.message}`);
  server?.kill();
  process.exit(1);
}

await test('GET /api/info over http and https', async () => {
  const a = JSON.parse((await getUrl(`${HTTP_URL}/api/info`)).body);
  assertEq(a.httpPort, PORT, 'httpPort');
  assertEq(a.httpsPort, HTTPS_PORT, 'httpsPort');
  assert(Array.isArray(a.lanIps), 'lanIps array');
  assert(/^https:\/\/[^/]+:3543\/pad$/.test(a.padBaseUrl), `padBaseUrl ${a.padBaseUrl}`);
  assertEq(info.padBaseUrl, a.padBaseUrl, 'same info on https');
  assertEq(a.title, 'KRISHIV KART', 'game title');
  if (serverLog) assert(serverLog.includes('KRISHIV KART'), 'startup banner shows KRISHIV KART');
});

await test('static routes: /pad (https), /socket.io client, /vendor/three, http→https pad redirect', async () => {
  const pad = await getUrl(`${HTTPS_URL}/pad?room=ABCD`);
  assertEq(pad.status, 200, '/pad status');
  assert(/text\/html/.test(pad.headers['content-type']), 'pad content-type');
  assert(pad.body.includes('js/pad.js'), 'pad.html references pad.js');
  assert(pad.body.includes('<title>KRISHIV KART') && !/TOOT KART/i.test(pad.body), 'pad page renamed to KRISHIV KART');
  const sio = await getUrl(`${HTTPS_URL}/socket.io/socket.io.js`);
  assertEq(sio.status, 200, 'socket.io client');
  const three = await getUrl(`${HTTP_URL}/vendor/three/build/three.module.js`);
  assertEq(three.status, 200, 'three vendor');
  const parts = await getUrl(`${HTTPS_URL}/js/parts.js`);
  assertEq(parts.status, 200, 'parts.js served to the phone');
  if (info.lanIps.length) {
    const r = await getUrl(`http://${info.lanIps[0]}:${PORT}/pad?room=ABCD`);
    assertEq(r.status, 302, 'LAN http /pad redirects');
    assertEq(r.headers.location, `https://${info.lanIps[0]}:${HTTPS_PORT}/pad?room=ABCD`, 'redirect target');
  }
  const local = await getUrl(`${HTTP_URL}/pad`);
  assertEq(local.status, 200, 'localhost http /pad is served directly');
});

await test('certificate SAN covers localhost, 127.0.0.1, the phone URL host (+ every LAN IP when made now); validity < 825 days', async () => {
  const cert = await new Promise((resolve, reject) => {
    const sock = tls.connect({ host: 'localhost', port: HTTPS_PORT, rejectUnauthorized: false, servername: 'localhost' }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      resolve(c);
    });
    sock.on('error', reject);
  });
  const san = cert.subjectaltname || '';
  assert(san.includes('DNS:localhost'), `SAN localhost: ${san}`);
  assert(san.includes('IP Address:127.0.0.1'), `SAN 127.0.0.1: ${san}`);
  const padHost = new URL(info.padBaseUrl).hostname;
  assert(san.includes(/^\d+\.\d+\.\d+\.\d+$/.test(padHost) ? `IP Address:${padHost}` : `DNS:${padHost}`), `SAN ${padHost} (phone URL): ${san}`);
  // A certificate made at this start names every LAN IP. A cached one is kept on
  // purpose while it covers the phone URL host, even after a VPN / VM bridge adds
  // an address (the phone's exception is for that exact certificate).
  if (/generated a new HTTPS certificate/.test(serverLog)) {
    for (const ip of info.lanIps) assert(san.includes(`IP Address:${ip}`), `SAN ${ip}: ${san}`);
  }
  const days = (Date.parse(cert.valid_to) - Date.parse(cert.valid_from)) / 86400000;
  assert(days > 700 && days < 825, `validity ${days} days`);
  assert(cert.bits === 2048, `RSA bits ${cert.bits}`);
});

// ------------------------------------------------------------------ tests: slots (SPEC §14.6 / §14.7)

let host, room, hostKey;
const pads = {};                                     // slot → socket of the main room

await test('host:create over http → { room, padUrl, qrSvg, lanIps, key, slots }', async () => {
  host = await connect(HTTP_URL);
  const res = await ack(host, 'host:create', {});
  assert(CODE_RE.test(res.room), `room code ${res.room}`);
  assertEq(res.padUrl, `${info.padBaseUrl}?room=${res.room}`, 'padUrl');
  assert(typeof res.qrSvg === 'string' && res.qrSvg.startsWith('<svg'), 'qrSvg is an SVG string');
  assert(Array.isArray(res.lanIps), 'lanIps');
  assert(typeof res.key === 'string' && res.key.length >= 8, 'host key');
  assertEq(res.padConnected, false, 'no pad yet');
  assertEq(res.slots, { host: null, connected: [] }, 'empty slots');
  room = res.room;
  hostKey = res.key;
  const again = await ack(host, 'host:create', {});
  assertEq(again.room, room, 'repeat host:create on the same socket is idempotent');
});

await test('four phones take slots 1–4 in join order; acks, pad:join, slots and slot:update follow SPEC §14.7', async () => {
  const slotsSeen = collect(host, 'slots');
  for (let n = 1; n <= 4; n++) {
    const p = await connect(HTTPS_URL, { transports: n === 3 ? ['polling'] : ['websocket'] });
    const joined = waitFor(host, 'pad:join');
    const update = waitFor(p, 'slot:update');
    const res = await ack(p, 'pad:hello', { room: n === 2 ? room.toLowerCase() : room, padId: `phone-slot-${n}` });
    assertEq([res.ok, res.slot, res.color, res.host, res.room, res.hostConnected], [true, n, COLORS[n - 1], 1, room, true], `ack for phone ${n}`);
    assertEq(await joined, { slot: n, padId: `phone-slot-${n}`, host: 1 }, `host pad:join ${n}`);
    assertEq(await update, { slot: n, host: 1, color: COLORS[n - 1] }, `slot:update to phone ${n}`);
    pads[n] = p;
  }
  await sleep(100);
  slotsSeen.stop();
  const seen = slotsSeen.filter((s) => s.connected.length);     // (the repeat host:create above also sent one)
  assertEq(seen.map((s) => s.connected.length), [1, 2, 3, 4], 'slots after each join');
  assertEq(seen[3], { host: 1, connected: [1, 2, 3, 4] }, 'final slots');
});

await test("a 5th phone gets error 'full' and is not seated", async () => {
  const noJoin = expectNone(host, 'pad:join', 300);
  const { p, res } = await phone(room, 'phone-slot-5');
  assertEq([res.ok, res.error, res.code], [false, 'full', 'full'], 'full');
  assert(/full/i.test(res.message), `message ${res.message}`);
  assertEq(await noJoin, true, 'host not told');
  const none = expectNone(host, 'pad:input', 300);
  p.emit('pad:input', { s: 1, g: 1, b: 0, d: 0, i: 0, p: 0, t: 1 });
  p.emit('pad:menu', { action: 'start' });
  assertEq(await none, true, 'an unseated phone cannot send input');
  p.close();
});

await test('pad:input relayed tagged with the sender slot and sanitized', async () => {
  let got = waitFor(host, 'pad:input');
  pads[3].emit('pad:input', { s: 0.5, g: 1, b: 0, d: 1, i: 1, p: 0, t: 123, slot: 1 });
  assertEq(await got, { slot: 3, s: 0.5, g: 1, b: 0, d: 1, i: 1, p: 0, t: 123 }, 'clean input from P3 (a spoofed slot is ignored)');
  got = waitFor(host, 'pad:input');
  pads[2].emit('pad:input', { s: 7, g: 'yes', b: true, d: 2, i: -5, p: 1.6, t: 'x', evil: '<script>' });
  assertEq(await got, { slot: 2, s: 1, g: 0, b: 1, d: 1, i: 0, p: 2, t: 0 }, 'clamped input from P2');
  got = waitFor(host, 'pad:input');
  pads[4].emit('pad:input', { s: -0.123456, g: 0, b: 0, d: 0, i: 0, p: 2, t: 5 });
  assertEq([(await got).slot, (await got).s], [4, -0.1235], 'steer rounded to 4 decimals');
  const none = expectNone(host, 'pad:input', 300);
  pads[1].emit('pad:input', 'garbage');
  pads[1].emit('pad:input', null);
  pads[1].emit('pad:input', [1, 2, 3]);
  assertEq(await none, true, 'garbage not relayed');
});

await test('pad:menu: every v3/v4 action relayed with the sender slot (valid payloads)', async () => {
  const budget = menuBudget();
  const relay = async (sock, payload) => { await budget(1); const got = waitFor(host, 'pad:menu'); sock.emit('pad:menu', payload); return got; };
  const cases = [
    [{ action: 'mode', value: 'vs' }, { action: 'mode', value: 'vs' }],
    [{ action: 'mode', value: 'gp', extra: 1 }, { action: 'mode', value: 'gp' }],
    [{ action: 'cc', value: 150 }, { action: 'cc', value: 150 }],
    [{ action: 'cc', value: '50' }, { action: 'cc', value: 50 }],
    [{ action: 'items', value: false }, { action: 'items', value: false }],
    [{ action: 'items', value: 1 }, { action: 'items', value: true }],
    [{ action: 'start', junk: 'x'.repeat(5000) }, { action: 'start' }],
    [{ action: 'track', value: 'monte' }, { action: 'track', value: 'monte' }],
    [{ action: 'track', value: 'random' }, { action: 'track', value: 'random' }],
    [{ action: 'cup', id: 'krishiv' }, { action: 'cup', id: 'krishiv', value: 'krishiv' }],
    [{ action: 'cup', value: 'gelato', junk: 'x'.repeat(500) }, { action: 'cup', id: 'gelato', value: 'gelato' }],
    [{ action: 'go', value: 3 }, { action: 'go' }],
    [{ action: 'next' }, { action: 'next' }],
    [{ action: 'quit' }, { action: 'quit' }],
    [{ action: 'restart' }, { action: 'restart' }],
    [{ action: 'char', id: 'sahur', value: 'x' }, { action: 'char', id: 'sahur' }],
    [{ action: 'char', id: 'custom_robo' }, { action: 'char', id: 'custom_robo' }],
    [{ action: 'body', id: 'speedster' }, { action: 'body', id: 'speedster' }],
    [{ action: 'wheels', id: 'neon' }, { action: 'wheels', id: 'neon' }],
    [{ action: 'back', id: 'x' }, { action: 'back' }],
    [{ action: 'ready', value: true }, { action: 'ready', value: true }],
    [{ action: 'ready', value: 0 }, { action: 'ready', value: false }],
    [{ action: 'assist', value: false }, { action: 'assist', value: false }],
    [{ action: 'pause' }, { action: 'pause' }],
    [{ action: 'pause', reason: 'hidden' }, { action: 'pause', reason: 'hidden' }],
    [{ action: 'pause', reason: '<evil>' }, { action: 'pause' }],
    [{ action: 'resume' }, { action: 'resume' }],
  ];
  let k = 0;
  for (const [payload, want] of cases) {
    const slot = (k++ % 4) + 1;
    assertEq(await relay(pads[slot], payload), { slot, ...want }, `${payload.action} ${JSON.stringify(payload.value ?? payload.id ?? payload.reason ?? '')}`);
  }
});

await test('pad:menu: hostile payloads and the removed v2 actions are dropped', async () => {
  const budget = menuBudget();
  const dropped = async (payloads) => {
    let none = true;
    for (let i = 0; i < payloads.length; i += 12) {
      const batch = payloads.slice(i, i + 12);
      await budget(batch.length);
      const wait = expectNone(host, 'pad:menu', 300);
      for (const p of batch) pads[2].emit('pad:menu', p);
      const r = await wait;
      if (r !== true) none = r;
    }
    return none;
  };
  assertEq(await dropped([
    { action: 'mode', value: 'grandprix' }, { action: 'mode' }, { action: 'mode', value: ['vs'] },
    { action: 'cc', value: 200 }, { action: 'cc', value: '100cc' }, { action: 'cc', value: 99.9 }, { action: 'cc' },
    { action: 'items', value: 'yes' }, { action: 'items' }, { action: 'items', value: 2 },
    { action: 'ready', value: 'true' }, { action: 'ready' }, { action: 'assist', value: null },
    { action: 'track', value: 'Breezy' }, { action: 'track', value: '../etc' }, { action: 'track', value: 'x'.repeat(33) },
    { action: 'track', value: 5 }, { action: 'track' },
    { action: 'cup' }, { action: 'cup', id: 'Krishiv Cup' }, { action: 'cup', id: '<x>' }, { action: 'cup', id: 5 }, { action: 'cup', id: 'x'.repeat(33) },
    { action: 'cup', id: ['gelato'] }, { action: 'cup', value: { id: 'gelato' } },
    { action: 'char', id: 'Ruggero' }, { action: 'char', id: '<img>' }, { action: 'char', id: '' }, { action: 'char' },
    { action: 'char', id: 'a b' }, { action: 'body', id: ['tank'] }, { action: 'body', id: 'x'.repeat(40) },
    { action: 'wheels', id: { id: 'neon' } }, { action: 'wheels', id: 7 },
  ]), true, 'bad values / ids dropped');
  assertEq(await dropped([
    { action: 'select', index: 3 }, { action: 'difficulty', value: 'hard' }, { action: 'customize' },
    { action: 'loadout', field: 'paint', value: 'red' }, { action: 'cycle', field: 'body', dir: 1 },
    { action: 'name', text: 'Max' }, { action: 'randomize' }, { action: 'reset' }, { action: 'done' }, { action: 'again' },
    { action: 'hack' }, { action: '__proto__' }, { action: 'toString' }, { action: 5 }, { action: null }, {}, null, 'start', ['start'],
  ]), true, 'v2 garage / unknown actions dropped');
});

await test('host:state (realistic v4: 13 racers + catalogs + 5 tracks + 2 cups, ~5–10 KB) reaches every phone intact; late phones get it from the cache', async () => {
  const st = realSharedState('select');
  const size = JSON.stringify(st).length;
  assert(size > 4000 && size < 12000, `realistic shared state size ${size} B`);
  const got = [1, 2, 3, 4].map((n) => waitFor(pads[n], 'host:state', 2000, (s) => s.screen === 'select'));
  host.emit('host:state', st);
  for (const s of await Promise.all(got)) {
    assertEq(canon(s), canon(st), 'shared state relayed unchanged');
  }
  const s = await got[0];
  assertEq([s.characters.length, s.characters.filter((c) => c.custom).length, s.characters[12].img], [13, 1, null], '13 racers, custom last without portrait');
  assertEq(s.characters[4].img, '/img/racers/sahur.png', 'portrait path kept');
  assertEq([s.tracks.length, s.cups.map((c) => `${c.id}:${c.tracks.length}`).join(), s.cup.id, s.cupPick], [5, 'gelato:4,krishiv:5', 'krishiv', 'krishiv'], '5 tracks, Gelato Cup 4 races, Krishiv Cup 5, the picked cup');
  // results rows
  const rs = realSharedState('results');
  const gotR = waitFor(pads[1], 'host:state', 2000, (x) => x.screen === 'results');
  host.emit('host:state', rs);
  assertEq(canon((await gotR).results), canon(rs.results), 'results relayed unchanged');
  host.emit('host:state', st);                       // leave the select state cached
  await waitFor(pads[1], 'host:state', 2000, (x) => x.screen === 'select');
});

await test('hostile host:state is capped and cleaned', async () => {
  const many = {
    screen: 'garage', mode: 'battle', cc: 999, items: 'no', host: 9, raceNo: 1e9, races: -3,
    track: { id: '<x>', name: 'n' }, tracks: Array(40).fill(0).map((_, i) => ({ id: `t${i}`, name: 'B'.repeat(100), evil: 1 })),
    cup: { id: 'gelato', name: 'C'.repeat(90), tracks: ['breezy', '<x>', { id: 'monte', name: 'M' }, 5] },
    cups: [{ name: 'no id', tracks: ['breezy'] }, { id: 'gelato', name: 'G'.repeat(90), tracks: Array(40).fill('breezy'), evil: 1 }, { id: 'gelato', name: 'dupe' },
      'junk', null, { id: '<x>', name: 'bad id' }, ...Array(20).fill(0).map((_, i) => ({ id: `cup${i}`, name: 'c', tracks: [{ id: 'palace', name: 'P', deep: { x: 1 } }] }))],
    players: [{ slot: 0 }, { slot: 5 }, { slot: 2, color: 'url(x)', connected: 'yes', ready: 1, char: '<img>', body: 'tank', wheels: 'x'.repeat(40), assist: 1, deep: { a: 1 } },
      ...Array(10).fill({ slot: 1, connected: true })],
    characters: [
      { id: 'pip', name: 'P'.repeat(100), shortName: 'S'.repeat(50), weightClass: 'mega', cssColor: 'red', accent: '#12345', ratings: { speed: 99, accel: -9, handling: 'x', weight: 2.5 },
        img: 'javascript:alert(1).png', custom: 'yes', catchphrase: 'c'.repeat(300), group: 'zz', lead: 'y' },
      { id: 'dot', name: 'Dot', img: '../../secret.png' }, { id: 'pic', name: 'Pic', img: 'https://evil.example/x.png' },
      { id: 'ok', name: 'Ok', img: '/img/racers/ok.webp', custom: true, cssColor: 0x2f7bff, accent: 0xf2d27a },
      { id: 'BAD ID', name: 'x' }, null, 'str',
      ...Array(200).fill(0).map((_, i) => ({ id: `c${i}`, name: 'y'.repeat(60), cssColor: '#fff' })),
    ],
    bodies: [{ id: 'tank', label: 'L'.repeat(60), desc: 'd'.repeat(500), mods: { speed: 9, accel: -9, handling: 'x', evil: 1 } }, { id: 'tank', label: 'dupe' },
      ...Array(30).fill(0).map((_, i) => ({ id: `b${i}`, label: 'b' }))],
    wheels: [{ id: 'mud', label: 'Mud', mods: {}, offroad: 7 }],
    results: Array(30).fill({ place: 99, name: 'N'.repeat(60), cssColor: 'blue', time: 'soon', points: 1e9, slot: 7, finished: 'no' }),
    standings: 'x',
    pausedBy: 2, note: 'n'.repeat(500), bad: { deep: 1 },
  };
  assert(JSON.stringify(many).length < 60000, 'hostile payload stays under the 64 KB message cap');
  const got = waitFor(pads[1], 'host:state', 2000);
  host.emit('host:state', many);
  const s = await got;
  assertEq([s.screen, s.mode, s.cc, s.items, s.host, s.raceNo, s.races], ['loading', 'gp', 100, true, null, 99, 0], 'scalars cleaned');
  assertEq([s.track, s.tracks.length, s.tracks[0].name.length, 'evil' in s.tracks[0]], [null, 16, 40, false], 'tracks cleaned');
  assertEq(canon(s.cup), canon({ name: 'C'.repeat(40), tracks: ['breezy', { id: 'monte', name: 'M' }], id: 'gelato' }), 'cup cleaned');
  assertEq([s.cups.length, s.cups[0].id, s.cups[0].name.length, s.cups[0].tracks.length, 'evil' in s.cups[0], s.cups[1].id, canon(s.cups[1].tracks[0])],
    [8, 'gelato', 40, 16, false, 'cup0', canon({ id: 'palace', name: 'P' })], 'cups capped at 8 (id required, repeats dropped), names 40, tracks 16');
  assertEq(s.players.map((x) => x.slot), [2, 1], 'invalid and repeated slots dropped');
  assertEq(canon(s.players[0]), canon({ slot: 2, color: COLORS[1], connected: false, ready: false, char: null, body: 'tank', wheels: null, assist: false }), 'player row cleaned');
  assertEq(s.characters.length, 40, 'characters capped at 40 (junk dropped)');
  const c0 = s.characters[0];
  assertEq([c0.name.length, c0.shortName.length, c0.weightClass, c0.cssColor, c0.accent, c0.img, c0.custom, c0.catchphrase.length, 'group' in c0, 'lead' in c0],
    [32, 20, 'medium', '#8890b5', '#8890b5', null, false, 100, false, false], 'character row cleaned');
  assertEq(canon(c0.ratings), canon({ speed: 5, accel: 1, handling: 3, weight: 2.5 }), 'ratings clamped to 1..5 (half stars kept)');
  assertEq(s.characters.slice(1, 4).map((c) => c.img), [null, null, '/img/racers/ok.webp'], 'only same-origin image paths kept');
  assertEq(s.characters[3].custom, true, 'custom flag for === true');
  assertEq([s.characters[3].cssColor, s.characters[3].accent], ['#2f7bff', '#f2d27a'], 'THREE hex colors become CSS colors');
  assertEq([s.bodies.length, s.bodies[1].id], [16, 'b0'], 'bodies capped, repeated id dropped');
  assertEq(canon(s.bodies[0]), canon({ id: 'tank', label: 'L'.repeat(24), desc: 'd'.repeat(80), mods: { speed: 5, accel: -5, handling: 0, weight: 0 } }), 'body cleaned');
  assertEq([s.wheels[0].offroad, canon(s.wheels[0].mods)], [1, canon({ speed: 0, accel: 0, handling: 0, weight: 0 })], 'wheel cleaned');
  assertEq(s.results.length, 16, 'results capped');
  assertEq(canon(s.results[0]), canon({ place: 16, name: 'N'.repeat(32), cssColor: '#8890b5', time: null, points: 9999, slot: null, finished: true }), 'result row cleaned');
  assertEq([s.standings, s.pausedBy, s.note.length, 'bad' in s], [null, 2, 120, false], 'extras: primitives kept (bounded), objects dropped');
  const none = expectNone(pads[1], 'host:state', 300);
  host.emit('host:state', 'nope');
  host.emit('host:state', null);
  host.emit('host:state', [1]);
  assertEq(await none, true, 'invalid state ignored');
  host.emit('host:state', realSharedState('select'));
  await waitFor(pads[1], 'host:state');
});

await test('host:padState goes only to its slot, is cleaned, and is cached for that slot', async () => {
  const others = [1, 3, 4].map((n) => expectNone(pads[n], 'host:padState', 400));
  const got = waitFor(pads[2], 'host:padState');
  const ps = realPadState(2);
  host.emit('host:padState', ps);
  assertEq(canon(await got), canon(ps), 'P2 got its pad state unchanged');
  for (const r of await Promise.all(others)) assertEq(r, true, 'no other phone got it');

  // race view
  const race = { state: 'racing', lap: 2, laps: 3, place: 4, racers: 8, item: 'triple_toot', itemCount: 3, rolling: false, countdown: 0, finished: false, assist: true, assistActive: true, finishClock: 12.5 };
  const got3 = waitFor(pads[3], 'host:padState');
  host.emit('host:padState', realPadState(3, { step: 'done', race, standing: { place: 2, points: 18 } }));
  const s3 = await got3;
  assertEq(canon(s3.race), canon(race), 'race view (incl. assistActive + extras) relayed');
  assertEq(s3.standing, { place: 2, points: 18 }, 'standing');

  // v4 (SPEC §15.2): every new item id, triple counts, race alerts
  for (const [item, itemCount] of [['triple_banana', 3], ['triple_bouncer', 3], ['triple_rocket', 3], ['capo', 1], ['golden_toot', 1], ['meatball_bomb', 1], ['espresso', 1], ['accordion', 1], ['beer_rocket', 1]]) {
    const r4 = { ...race, item, itemCount, warn: 'capo', capoWarn: true, splash: 0.75, beer: true };
    const g = waitFor(pads[3], 'host:padState', 2000, (x) => x.race && x.race.item === item);
    host.emit('host:padState', realPadState(3, { step: 'done', race: r4 }));
    assertEq(canon((await g).race), canon(r4), `v4 item ${item} ×${itemCount} + alerts relayed`);
  }
  {
    const g = waitFor(pads[3], 'host:padState', 2000, (x) => x.race && x.race.item === null);
    host.emit('host:padState', realPadState(3, { step: 'done', race: { ...race, item: 'blue_shell', warn: '<siren>', capoWarn: 1, splash: 7, beer: 'yes' } }));
    const r = (await g).race;
    assertEq([r.item, 'warn' in r, 'capoWarn' in r, r.splash, 'beer' in r], [null, false, false, 1, false], 'unknown item dropped; bad alert flags dropped, splash clamped to 1');
    const g2 = waitFor(pads[3], 'host:padState', 2000, (x) => x.race && x.race.item === 'espresso');
    host.emit('host:padState', realPadState(3, { step: 'done', race: { ...race, item: 'espresso', splash: true, warn: null } }));
    const r2 = (await g2).race;
    assertEq([r2.splash, 'warn' in r2], [1, false], 'splash: true → 1; warn null → absent');
  }

  // hostile
  const got4 = waitFor(pads[4], 'host:padState');
  host.emit('host:padState', {
    slot: '4', color: 'nope', isHost: 'yes', step: 'garage', choice: { char: '<x>', body: 'tank', wheels: 9, assist: 0 }, ratings: { speed: 50 },
    race: { state: 'warp', lap: 500, laps: 0, place: -3, racers: 99, item: 'bomb', itemCount: 50, rolling: 'y', countdown: 1e6, finished: 0, assist: 1, assistActive: 'yes' },
    standing: { place: 'x', points: -5 }, deep: { a: 1 }, flagged: true,
  });
  const s4 = await got4;
  assertEq(canon(s4), canon({
    slot: 4, color: COLORS[3], isHost: false, step: 'char', choice: { char: null, body: 'tank', wheels: null, assist: true },
    ratings: { speed: 5, accel: 3, handling: 3, weight: 3 },
    race: { state: 'racing', lap: 99, laps: 1, place: 0, racers: 16, item: null, itemCount: 9, rolling: true, countdown: 60, finished: false, assist: false, assistActive: false },
    standing: { place: 0, points: 0 }, flagged: true,
  }), 'hostile pad state cleaned');

  const none = [1, 2, 3, 4].map((n) => expectNone(pads[n], 'host:padState', 300));
  host.emit('host:padState', { ...realPadState(2), slot: 9 });
  host.emit('host:padState', { ...realPadState(2), slot: 0 });
  host.emit('host:padState', { ...realPadState(2), slot: undefined });
  host.emit('host:padState', 'x');
  for (const r of await Promise.all(none)) assertEq(r, true, 'pad states without a valid slot dropped');

  host.emit('host:padState', realPadState(2));       // cache P2's state again
  await waitFor(pads[2], 'host:padState');
});

await test('host:event to one slot or to everyone; sanitized', async () => {
  let got = waitFor(pads[3], 'host:event');
  let others = [1, 2, 4].map((n) => expectNone(pads[n], 'host:event', 400));
  host.emit('host:event', { slot: 3, type: 'vibrate', pattern: [40, 'x', 5000] });
  assertEq(await got, { type: 'vibrate', pattern: [40, 0, 1000] }, 'vibrate to P3 only');
  for (const r of await Promise.all(others)) assertEq(r, true, 'others got nothing');
  const all = [1, 2, 3, 4].map((n) => waitFor(pads[n], 'host:event'));
  host.emit('host:event', { type: 'toast', text: 'L'.repeat(200) });
  for (const e of await Promise.all(all)) assertEq(e.text.length, 80, 'toast to everyone, truncated');
  others = [1, 2, 3, 4].map((n) => expectNone(pads[n], 'host:event', 300));
  host.emit('host:event', { slot: 7, type: 'toast', text: 'bad slot' });
  host.emit('host:event', { slot: 'all', type: 'toast', text: 'bad slot' });
  host.emit('host:event', { type: 'eval', code: 'x' });
  host.emit('host:event', { type: 'toast', text: '   ' });
  host.emit('host:event', { type: 'vibrate', pattern: [] });
  for (const r of await Promise.all(others)) assertEq(r, true, 'invalid slot / type / empty payload dropped');
  got = waitFor(pads[1], 'host:event');
  host.emit('host:event', { slot: 1, type: 'vibrate', ms: 25 });
  assertEq(await got, { type: 'vibrate', pattern: [25] }, 'ms shorthand');
});

await test('host hand-off: P1 leaves → P2 is host (pad:leave, slots, slot:update to all); P1 returns by padId → slot 1 + host again, cached pad state', async () => {
  const left = waitFor(host, 'pad:leave');
  const slotsMsg = waitFor(host, 'slots', 2000, (s) => !s.connected.includes(1));
  const updates = [2, 3, 4].map((n) => waitFor(pads[n], 'slot:update', 2000, (u) => u.host === 2));
  pads[1].close();
  assertEq(await left, { slot: 1, padId: 'phone-slot-1', reason: 'left' }, 'pad:leave for P1');
  assertEq(await slotsMsg, { host: 2, connected: [2, 3, 4] }, 'slots: P2 is host');
  const ups = await Promise.all(updates);
  assertEq(ups.map((u) => [u.slot, u.host, u.color]), [[2, 2, COLORS[1]], [3, 2, COLORS[2]], [4, 2, COLORS[3]]], 'slot:update to every phone');

  // While P1 is away its slot stays reserved: a new phone finds the game full.
  const stranger = await phone(room, 'phone-stranger-1');
  assertEq([stranger.res.ok, stranger.res.error], [false, 'full'], 'reserved slot not given away');
  stranger.p.close();

  // P1's state while away, then P1 comes back with the same padId.
  host.emit('host:padState', realPadState(1, { step: 'ready' }));
  await sleep(100);
  const p1 = await connect(HTTPS_URL, { transports: ['websocket'] });
  const joined = waitFor(host, 'pad:join');
  const cachedShared = waitFor(p1, 'host:state');
  const cachedPad = waitFor(p1, 'host:padState');
  const back = [2, 3, 4].map((n) => waitFor(pads[n], 'slot:update', 2000, (u) => u.host === 1));
  const res = await ack(p1, 'pad:hello', { room, padId: 'phone-slot-1' });
  assertEq([res.ok, res.slot, res.host], [true, 1, 1], 'P1 reclaimed slot 1 and is host');
  assertEq(await joined, { slot: 1, padId: 'phone-slot-1', host: 1 }, 'host pad:join for the returning P1');
  assertEq((await cachedShared).screen, 'select', 'cached shared state');
  assertEq([(await cachedPad).slot, (await cachedPad).step], [1, 'ready'], 'P1 got its own cached pad state');
  assertEq((await Promise.all(back)).map((u) => u.host), [1, 1, 1], 'everyone told P1 is host again');
  pads[1] = p1;
});

await test('the old v2 `id` field still identifies a phone; a phone without an id gets a fresh slot each time', async () => {
  const { h, room: r } = await newHost();
  const a = await phone(r, undefined);
  assertEq([a.res.ok, a.res.slot], [true, 1], 'no padId → slot 1');
  a.p.close();
  await sleep(150);
  const b = await connect(HTTPS_URL, { transports: ['websocket'] });
  const rb = await ack(b, 'pad:hello', { room: r, id: 'legacy-id-0001' });
  assertEq([rb.ok, rb.slot], [true, 2], 'slot 1 stays reserved for the anonymous phone; legacy id → slot 2');
  b.close();
  await sleep(150);
  const c = await connect(HTTPS_URL, { transports: ['websocket'] });
  const rc = await ack(c, 'pad:hello', { room: r, id: 'legacy-id-0001' });
  assertEq([rc.ok, rc.slot], [true, 2], 'same legacy id → same slot');
  c.close();
  h.close();
});

await test('same phone reconnecting replaces its stale socket silently (no pad:leave)', async () => {
  const p = await connect(HTTPS_URL, { transports: ['websocket'] });
  const kicked = waitFor(pads[3], 'pad:kicked');
  const joined = waitFor(host, 'pad:join');
  const noLeave = expectNone(host, 'pad:leave', 400);
  const res = await ack(p, 'pad:hello', { room, padId: 'phone-slot-3' });
  assertEq([res.ok, res.slot], [true, 3], 'hello ok, same slot');
  assertEq((await kicked).reason, 'reconnected', 'stale socket told it was replaced');
  assertEq(await joined, { slot: 3, padId: 'phone-slot-3', host: 1 }, 'host pad:join');
  assertEq(await noLeave, true, 'no pad:leave for the same phone');
  const none = expectNone(host, 'pad:input', 300);
  pads[3].emit('pad:input', { s: 1, g: 1, b: 0, d: 0, i: 9, p: 0, t: 1 });
  assertEq(await none, true, 'the replaced socket can no longer send input');
  pads[3] = p;
  const got = waitFor(host, 'pad:input');
  p.emit('pad:input', { s: 0.2, g: 1, b: 0, d: 0, i: 0, p: 0, t: 2 });
  assertEq((await got).slot, 3, 'the new socket drives slot 3');
});

await test('host:release frees a dropped slot (never a connected one); a reservation also expires on its own', async () => {
  let r = await ack(host, 'host:release', { slot: 4 });
  assertEq(r.ok, false, 'connected slot not released');
  const left = waitFor(host, 'pad:leave');
  pads[4].close();
  await left;
  r = await ack(host, 'host:release', { slot: 4 });
  assertEq(r.ok, true, 'released');
  r = await ack(host, 'host:release', { slot: 4 });
  assertEq(r.ok, false, 'already free');
  r = await ack(host, 'host:release', { slot: 'x' });
  assertEq(r.ok, false, 'bad slot');
  const pr = await ack(pads[2], 'host:release', { slot: 1 });
  assertEq(pr.ok, false, 'a phone cannot release slots');
  const fresh = await phone(room, 'phone-new-4');
  assertEq([fresh.res.ok, fresh.res.slot], [true, 4], 'new phone takes the released slot 4');
  pads[4] = fresh.p;
  // A returning phone whose slot was released gets a free slot (none here → full).
  const old4 = await phone(room, 'phone-slot-4');
  assertEq([old4.res.ok, old4.res.error], [false, 'full'], 'the released phone finds the game full');
  old4.p.close();

  // Expiry: P4 leaves and does not come back within SLOT_RESERVE_MS.
  const left2 = waitFor(host, 'pad:leave', 2000, (x) => x.reason === 'left');
  const expired = waitFor(host, 'pad:leave', RESERVE_MS + 3000, (x) => x.reason === 'expired');
  pads[4].close();
  assertEq((await left2).slot, 4, 'left');
  assertEq(await expired, { slot: 4, padId: 'phone-new-4', reason: 'expired' }, `reservation expired after ${RESERVE_MS} ms`);
  const late = await phone(room, 'phone-late-4');
  assertEq([late.res.ok, late.res.slot], [true, 4], 'slot 4 free again');
  pads[4] = late.p;
});

await test('lowest free slot: a gap at P2 is filled before P5 would be', async () => {
  const left = waitFor(host, 'pad:leave');
  pads[2].close();
  await left;
  assertEq((await ack(host, 'host:release', { slot: 2 })).ok, true, 'P2 released');
  const n = await phone(room, 'phone-gap-2');
  assertEq([n.res.ok, n.res.slot, n.res.color, n.res.host], [true, 2, COLORS[1], 1], 'new phone takes slot 2');
  pads[2] = n.p;
});

await test('net:ping answers', async () => {
  const r = await ack(pads[1], 'net:ping', Date.now());
  assert(typeof r.t === 'number', 'ping reply');
});

await test('bad room codes are rejected', async () => {
  const p = await connect(HTTPS_URL, { transports: ['websocket'] });
  let free = 'ZZZZ';
  if (free === room) free = 'YYYY';
  let r = await ack(p, 'pad:hello', { room: free });
  assertEq([r.ok, r.error, r.code], [false, 'room', 'no_room'], 'unknown room');
  r = await ack(p, 'pad:hello', { room: 'IL0!' });
  assertEq([r.ok, r.error, r.code], [false, 'room', 'bad_code'], 'invalid characters');
  r = await ack(p, 'pad:hello', {});
  assertEq([r.ok, r.code], [false, 'bad_code'], 'missing code');
  r = await ack(p, 'pad:hello', 'ABCD');
  assertEq([r.ok, r.code], [false, 'bad_code'], 'non-object payload');
  p.emit('pad:hello', { room: free });   // no ack callback must not crash the server
  await sleep(100);
  p.close();
});

await test('a host connection cannot act as a pad', async () => {
  const r = await ack(host, 'pad:hello', { room });
  assertEq([r.ok, r.code], [false, 'role'], 'role guard');
});

// ------------------------------------------------------------------ tests: desktop reconnects

await test('host disconnect → phones get host:leave; reconnect with key reclaims the room and re-announces every phone', async () => {
  const lefts = [1, 2, 3, 4].map((n) => waitFor(pads[n], 'host:leave'));
  host.close();
  await Promise.all(lefts);
  await sleep(100);
  host = await connect(HTTP_URL, { transports: ['websocket'] });
  const joins = collect(host, 'pad:join');
  const slotsMsg = waitFor(host, 'slots');
  const hostJoin = waitFor(pads[2], 'host:join');
  const res = await ack(host, 'host:create', { room, key: hostKey });
  assertEq([res.room, res.reclaimed, res.padConnected], [room, true, true], 'same room reclaimed, phones still there');
  assertEq(res.slots, { host: 1, connected: [1, 2, 3, 4] }, 'slots in the ack');
  assertEq(await slotsMsg, { host: 1, connected: [1, 2, 3, 4] }, 'slots event');
  await hostJoin;
  await sleep(100);
  joins.stop();
  assertEq(joins.map((j) => j.slot), [1, 2, 3, 4], 'pad:join for every waiting phone');
  const got = waitFor(host, 'pad:input');
  pads[3].emit('pad:input', { s: -1, g: 1, b: 0, d: 0, i: 3, p: 0, t: 9 });
  assertEq([(await got).slot, (await got).s], [3, -1], 'input flows again after reclaim');
});

await test('a phone joining while the desktop is away is seated and told the host is missing', async () => {
  const { h, room: r, key } = await newHost();
  h.close();
  await sleep(150);
  const p = await connect(HTTPS_URL, { transports: ['websocket'] });
  const hl = waitFor(p, 'host:leave');
  const res = await ack(p, 'pad:hello', { room: r, padId: 'phone-early-1' });
  assertEq([res.ok, res.slot, res.hostConnected], [true, 1, false], 'seated without a host');
  await hl;
  const h2 = await connect(HTTP_URL, { transports: ['websocket'] });
  const joined = waitFor(h2, 'pad:join');
  const hj = waitFor(p, 'host:join');
  await ack(h2, 'host:create', { room: r, key });
  assertEq((await joined).slot, 1, 'desktop told about the waiting phone');
  await hj;
  h2.close(); p.close();
});

await test('another desktop cannot steal a live room without the key', async () => {
  const other = await connect(HTTP_URL);
  const res = await ack(other, 'host:create', { room });
  assert(res.room !== room && CODE_RE.test(res.room), 'got a different room');
  other.close();
});

await test('host key lets a duplicate tab take over (old host gets host:replaced)', async () => {
  const tab2 = await connect(HTTP_URL);
  const replaced = waitFor(host, 'host:replaced');
  const res = await ack(tab2, 'host:create', { room, key: hostKey });
  assertEq(res.room, room, 'takeover with key');
  await replaced;
  const got = waitFor(tab2, 'pad:input');
  pads[1].emit('pad:input', { s: 0.25, g: 0, b: 1, d: 0, i: 3, p: 0, t: 10 });
  assertEq([(await got).slot, (await got).s], [1, 0.25], 'input goes to the new tab');
  const fresh = await ack(host, 'host:create', {});
  assert(fresh.room !== room, 'replaced tab can create a fresh room');
  host.close();
  host = tab2;
});

await test('a reserved (host-less) room cannot be claimed without its key', async () => {
  const left = waitFor(pads[1], 'host:leave');
  host.close();
  await left;
  const stranger = await connect(HTTP_URL);
  const res = await ack(stranger, 'host:create', { room });
  assert(res.room !== room && CODE_RE.test(res.room), 'stranger gets a different room');
  const res2 = await ack(stranger, 'host:create', { room, key: 'wrong-key-123' });
  assert(res2.room !== room, 'wrong key rejected too');
  stranger.close();
  host = await connect(HTTP_URL);
  const hostJoin = waitFor(pads[1], 'host:join');
  const res3 = await ack(host, 'host:create', { room, key: hostKey });
  assertEq(res3.room, room, 'owner reclaims with the key');
  await hostJoin;
});

await test(`room expires after the grace period (${GRACE_MS} ms) → every phone gets room:closed`, async () => {
  const closed = [1, 2, 3, 4].map((n) => waitFor(pads[n], 'room:closed', GRACE_MS + 3000));
  host.close();
  for (const c of await Promise.all(closed)) assertEq(c.reason, 'expired', 'reason');
  const r = await ack(pads[1], 'pad:hello', { room, padId: 'phone-slot-1' });
  assertEq([r.ok, r.code], [false, 'no_room'], 'room gone');
  // A desktop coming back later (or after a server restart) recreates its code.
  host = await connect(HTTP_URL);
  const res = await ack(host, 'host:create', { room, key: hostKey });
  assertEq(res.room, room, 'free code re-created on request');
  const r2 = await ack(pads[2], 'pad:hello', { room, padId: 'phone-gap-2' });
  assertEq([r2.ok, r2.slot], [true, 1], 'first phone back in the re-created room is P1');
});

await test('server survives garbage on every event', async () => {
  const s = await connect(HTTP_URL);
  const junk = [null, 42, 'x'.repeat(10000), [1, 2], { room: { $gt: '' } }, { action: { toString: 1 } }, { slot: { valueOf: 1 } }, true];
  for (const ev of ['host:create', 'host:state', 'host:padState', 'host:event', 'host:release', 'pad:hello', 'pad:input', 'pad:menu', 'net:ping', 'unknown']) {
    for (const j of junk) s.emit(ev, j);
  }
  for (const j of junk) { host.emit('host:padState', j); host.emit('host:event', j); host.emit('host:release', j); }
  await sleep(300);
  const r = await getUrl(`${HTTP_URL}/api/info`);
  assertEq(r.status, 200, 'still serving');
  s.close();
});

await test('heartbeat: pingInterval + pingTimeout ≤ 6 s (a phone that vanished is dropped quickly)', async () => {
  const r = await getUrl(`${HTTP_URL}/socket.io/?EIO=4&transport=polling`);
  const hs = JSON.parse(r.body.slice(r.body.indexOf('{')));
  assert(hs.pingInterval + hs.pingTimeout <= 6000, `ping ${hs.pingInterval} + ${hs.pingTimeout} ms`);
});

await test('pad:input burst over the rate limit: the final release edge reaches the host at once', async () => {
  const { h, p } = await pairUp('burst-pad-0001');
  const got = [];
  h.on('pad:input', (x) => got.push({ ...x, at: Date.now() }));
  await sleep(1100);                                 // fresh rate window
  const t0 = Date.now();
  // ~3 s of 60 Hz samples queued during a Wi-Fi stall (GAS held, steering
  // right), then the reliable release edge the pad sent last.
  for (let k = 0; k < 179; k++) p.emit('pad:input', { s: 0.8, g: 1, b: 0, d: 0, i: 0, p: 0, t: k + 1 });
  p.emit('pad:input', { s: 0, g: 0, b: 0, d: 0, i: 0, p: 0, t: 999 });
  await sleep(400);
  const last = got[got.length - 1];
  assertEq([last?.g, last?.s, last?.t], [0, 0, 999], 'last packet relayed is the release');
  assert(last.at - t0 < 350, `release relayed promptly (${last.at - t0} ms)`);
  h.close(); p.close();
});

await test('pad:input over the rate limit is coalesced: the newest sample still reaches the host', async () => {
  const { h, p } = await pairUp('burst-pad-0002');
  let last = null;
  h.on('pad:input', (x) => { last = x; });
  await sleep(1100);
  for (let k = 0; k <= 300; k++) p.emit('pad:input', { s: k === 300 ? -0.5 : 0.3, g: 1, b: 0, d: 0, i: 0, p: 0, t: k + 1 });
  await sleep(1300);                                 // the budget resets within 1 s
  assertEq([last?.s, last?.t], [-0.5, 301], 'newest sample relayed when the window resets');
  h.close(); p.close();
});

await test('four phones streaming at 60 Hz each: every slot keeps its own budget (no cross-slot loss)', async () => {
  const { h, room: r } = await newHost();
  const ps = [];
  for (let n = 1; n <= 4; n++) ps.push((await phone(r, `stream-pad-${n}`)).p);
  const counts = [0, 0, 0, 0, 0];
  h.on('pad:input', (x) => { counts[x.slot]++; });
  await sleep(200);
  const iv = setInterval(() => { for (const p of ps) p.emit('pad:input', { s: 0.1, g: 1, b: 0, d: 0, i: 0, p: 0, t: Date.now() }); }, 1000 / 60);
  await sleep(1000);
  clearInterval(iv);
  await sleep(150);
  for (let n = 1; n <= 4; n++) assert(counts[n] >= 50, `slot ${n} relayed ${counts[n]} of ~60 samples`);
  for (const p of ps) p.close();
  h.close();
});

await test('host:create vacantOnly: a reopened tab reclaims a host-less room, never a live one', async () => {
  const a = await connect(HTTP_URL);
  const ra = await ack(a, 'host:create', {});
  const noReplace = expectNone(a, 'host:replaced', 300);
  const b = await connect(HTTP_URL);
  const rb = await ack(b, 'host:create', { room: ra.room, key: ra.key, vacantOnly: true });
  assert(rb.room !== ra.room && CODE_RE.test(rb.room), 'live room not taken over');
  assertEq(await noReplace, true, 'live host keeps its room');
  a.close();
  await sleep(150);
  const c = await connect(HTTP_URL);
  const rc = await ack(c, 'host:create', { room: ra.room, key: ra.key, vacantOnly: true });
  assertEq([rc.room, rc.reclaimed], [ra.room, true], 'room held for the closed tab is reclaimed');
  b.close(); c.close();
});

// ------------------------------------------------------------------ tests: PhoneLink (net.js) against the live server

// A fresh browser profile + tab for each PhoneLink (no stored room to reclaim).
const useLink = async () => {
  globalThis.io = (opts) => ioClient(HTTP_URL, { ...opts, forceNew: true });
  setStorage('localStorage', memoryStorage());
  setStorage('sessionStorage', memoryStorage());
  const { PhoneLink } = await import('../public/js/net.js');
  return PhoneLink;
};

await test('PhoneLink: multi-slot join, players / host / getInput(slot) / isActive(slot), menus with slot, leave', async () => {
  const PhoneLink = await useLink();
  const link = new PhoneLink();
  const infoRes = await link.connect();
  assert(CODE_RE.test(infoRes.room) && infoRes.qrSvg.startsWith('<svg'), 'connect() resolves room info');
  assertEq([link.room, link.connected, link.players.size, link.host], [infoRes.room, false, 0, null], 'empty room');
  assertEq(link.getInput(1), { steer: 0, gas: 0, brake: 0, drift: 0, itemSeq: 0, pauseSeq: 0, lastUpdate: 0 }, 'zeros for an empty slot');
  assert(link.getInput(3) === link.getInput(4), 'the zero input is shared (no allocation)');

  const events = [];
  link.on('join', (p) => events.push(['join', p.slot, p.host, p.rejoin]));
  link.on('leave', (p) => events.push(['leave', p.slot, p.reason]));
  link.on('slots', (p) => events.push(['slots', p.host, p.connected.join('')]));
  const menus = [];
  link.on('menu', (m) => menus.push(m));

  const a = await phone(link.room, 'link-pad-aaaa');
  const b = await phone(link.room, 'link-pad-bbbb');
  assertEq([a.res.slot, b.res.slot], [1, 2], 'slots 1 and 2');
  await sleep(150);
  assertEq([link.connected, link.count, link.host, [...link.players.keys()]], [true, 2, 1, [1, 2]], 'players map + host');
  assertEq(canon(link.players.get(2)), canon({ slot: 2, padId: 'link-pad-bbbb', connected: true, input: link.players.get(2).input }), 'player entry');

  const send = async (p, s, i, pz, g = 1) => { p.emit('pad:input', { s, g, b: 0, d: 1, i, p: pz, t: Date.now() }); await sleep(60); };
  await send(a.p, 0.3, 5, 2);                          // baselines adopted, no presses
  await send(b.p, -0.6, 1, 1, 0);
  assertEq([link.getInput(1).itemSeq, link.getInput(2).pauseSeq], [0, 0], 'baselines do not fire presses');
  await send(a.p, 0.3, 6, 2);
  await send(a.p, 0.3, 8, 3);
  await send(b.p, -0.6, 2, 1, 0);
  const i1 = link.getInput(1), i2 = link.getInput(2);
  assertEq([i1.steer, i1.gas, i1.drift, i1.itemSeq, i1.pauseSeq], [0.3, 1, 1, 3, 1], 'P1 input + deltas');
  assertEq([i2.steer, i2.gas, i2.itemSeq, i2.pauseSeq], [-0.6, 0, 1, 0], 'P2 input kept separately');
  assert(link.isActive(1) && link.isActive(2) && !link.isActive(3), 'isActive per slot');

  b.p.emit('pad:menu', { action: 'char', id: 'cappuccino' });
  a.p.emit('pad:menu', { action: 'start' });
  await sleep(150);
  assertEq(menus, [{ slot: 2, action: 'char', id: 'cappuccino' }, { slot: 1, action: 'start' }], 'menus carry the slot');

  // P1 leaves → P2 becomes host; P1's input is zeroed.
  const left = new Promise((r) => { const off = link.on('leave', (x) => { off(); r(x); }); });
  a.p.close();
  assertEq(await left, { slot: 1, padId: 'link-pad-aaaa', reason: 'left' }, 'leave event');
  await sleep(150);
  assertEq([link.host, link.players.get(1).connected, link.getInput(1).gas, link.isActive(1), link.count], [2, false, 0, false, 1], 'P2 host, P1 kept but disconnected');
  // P1 comes back: rejoin, counters adopted as a new baseline (seqs stay monotonic).
  const a2 = await phone(link.room, 'link-pad-aaaa');
  assertEq(a2.res.slot, 1, 'P1 back in slot 1');
  await sleep(150);
  await send(a2.p, 0.1, 0, 0);
  await send(a2.p, 0.1, 1, 0);
  assertEq([link.host, link.getInput(1).itemSeq], [1, 4], 'host back to P1, itemSeq monotonic across rejoin');
  assert(events.some((e) => e[0] === 'join' && e[1] === 1 && e[3] === true), `rejoin flagged ${JSON.stringify(events)}`);
  assert(events.some((e) => e[0] === 'slots' && e[1] === 2 && e[2] === '2'), 'slots event with the hand-off');
  link.dispose();
  a2.p.close(); b.p.close();
  delete globalThis.io;
});

await test('PhoneLink: sendState to all, sendPadState only to its slot (deduped + heartbeat), sendEvent to one / all, release', async () => {
  const PhoneLink = await useLink();
  const link = new PhoneLink();
  await link.connect();
  link.sendState(realSharedState('lobby'));            // cached before anyone joins
  link.sendPadState(1, realPadState(1, { step: 'char' }));
  const a = await connect(HTTPS_URL, { transports: ['websocket'] });
  const firstShared = waitFor(a, 'host:state');
  assertEq((await ack(a, 'pad:hello', { room: link.room, padId: 'route-pad-aaaa' })).slot, 1, 'P1');
  assertEq((await firstShared).screen, 'lobby', 'state cached via sendState reaches a late phone');
  const b = (await phone(link.room, 'route-pad-bbbb')).p;
  await sleep(200);

  const aPad = collect(a, 'host:padState');
  const bPad = collect(b, 'host:padState');
  const bShared = collect(b, 'host:state');
  link.sendPadState(2, realPadState(2, { step: 'body' }));
  link.sendPadState(2, realPadState(2, { step: 'body' }));   // same content: deduped
  link.sendState(realSharedState('select'));
  await sleep(150);
  assertEq(bPad.filter((s) => s.step === 'body').length, 1, 'P2 got its pad state once');
  assert(aPad.every((s) => s.slot === 1), 'P1 never sees P2\'s pad state');
  assert(bShared.some((s) => s.screen === 'select'), 'shared state to P2 too');
  link.sendPadState(2, { ...realPadState(2), slot: 3, step: 'ready' });   // the slot argument wins
  await sleep(120);
  assertEq(bPad[bPad.length - 1].step, 'ready', 'slot argument routes the state');

  // Heartbeat: unchanged states are re-sent at NET.hostStateHz to connected phones.
  const before = [aPad.length, bPad.length, bShared.length];
  await sleep(700);
  aPad.stop(); bPad.stop(); bShared.stop();
  assert(aPad.length - before[0] >= 2 && bPad.length - before[1] >= 2 && bShared.length - before[2] >= 2,
    `heartbeats ${aPad.length - before[0]}/${bPad.length - before[1]}/${bShared.length - before[2]} in 700 ms`);

  const evA = collect(a, 'host:event');
  const evB = collect(b, 'host:event');
  link.sendEvent('vibrate', { pattern: [30, 20, 30] }, 2);
  link.sendEvent('toast', { text: 'Lap 2!', slot: 1 });  // a slot inside data is ignored: everyone
  link.sendEvent('vibrate', { pattern: [10] }, 4);        // nobody in slot 4: not sent
  await sleep(200);
  evA.stop(); evB.stop();
  assertEq(evA, [{ type: 'toast', text: 'Lap 2!' }], 'P1 events');
  assertEq(evB, [{ type: 'vibrate', pattern: [30, 20, 30] }, { type: 'toast', text: 'Lap 2!' }], 'P2 events');

  // release: never a connected slot; a gone one is freed for a new phone.
  link.release(2);
  await sleep(100);
  assert(link.players.get(2)?.connected, 'a connected slot is not released');
  const gone = new Promise((r) => { const off = link.on('leave', (x) => { off(); r(x); }); });
  b.close();
  await gone;
  link.release(2);
  await sleep(150);
  assert(!link.players.has(2), 'released player removed');
  const c = await phone(link.room, 'route-pad-cccc');
  assertEq(c.res.slot, 2, 'new phone gets the released slot');
  link.dispose();
  a.close(); c.p.close();
  delete globalThis.io;
});

await test('PhoneLink: reservation expiry removes the player; a host network drop reconnects and reclaims the room', async () => {
  const PhoneLink = await useLink();
  const link = new PhoneLink();
  await link.connect();
  const a = await phone(link.room, 'expire-pad-aaaa');
  const b = await phone(link.room, 'expire-pad-bbbb');
  await sleep(150);
  const leaves = [];
  link.on('leave', (x) => leaves.push([x.slot, x.reason]));
  b.p.close();
  await sleep(RESERVE_MS + 600);
  assertEq(leaves, [[2, 'left']], 'one leave event (the expiry of a gone player is silent)');
  assert(!link.players.has(2), 'expired player removed from players');

  const joins = [];
  link.on('join', (x) => joins.push([x.slot, x.rejoin]));
  const oldRoom = link.room;
  link._socket.io.engine.close();
  await sleep(1800);
  assertEq([link.room, link.socketConnected], [oldRoom, true], 'same room after reconnect');
  assert(leaves.some((l) => l[1] === 'server'), `phones marked gone while our link was down ${JSON.stringify(leaves)}`);
  assertEq(joins, [[1, true]], 'the waiting phone re-announced as a rejoin');
  assertEq([link.connected, link.host], [true, 1], 'connected again');
  link.dispose();
  a.p.close();
  delete globalThis.io;
});

await test("PhoneLink: a driving phone that goes silent mid-race → inactive fast, then 'lost' (+ local pause only when it is the only phone)", async () => {
  const PhoneLink = await useLink();
  const RACE = { ...realSharedState('race') };
  const racing = (slot) => realPadState(slot, { step: 'done', race: { state: 'racing', lap: 1, laps: 3, place: 5, racers: 8, finished: false } });

  async function linkWith(padIds) {
    setStorage('localStorage', memoryStorage());
    setStorage('sessionStorage', memoryStorage());
    const link = new PhoneLink();
    await link.connect();
    const ev = [];
    link.on('menu', (m) => { if (m.action === 'pause') ev.push(['pause', m.slot, m.reason]); });
    link.on('lost', (x) => ev.push(['lost', x.slot]));
    link.on('signal', (x) => ev.push(['signal', x.slot, x.lost]));
    const ps = [];
    for (const id of padIds) ps.push((await phone(link.room, id)).p);
    await sleep(150);
    link.sendState(RACE);
    ps.forEach((_, k) => link.sendPadState(k + 1, racing(k + 1)));
    const stream = (p, g) => setInterval(() => p.emit('pad:input', { s: 0.9, g, b: 0, d: 0, i: 0, p: 0, t: Date.now() }), 1000 / 60);
    return { link, ps, ev, stream };
  }

  // Solo: driving (GAS held), then silence (a locked phone keeps its socket open).
  const A = await linkWith(['silent-pad-0001']);
  let iv = A.stream(A.ps[0], 1);
  await sleep(1300);
  assert(A.link.isActive(1) && A.link.getInput(1).gas === 1, 'driving');
  clearInterval(iv);
  await sleep(500);
  assert(!A.link.isActive(1), 'inactive 500 ms after a 60 Hz stream stopped');
  await sleep(900);
  assertEq(A.ev, [['lost', 1], ['pause', 1, 'signal']], 'lost + local pause after ~1 s of silence (solo)');
  assertEq([A.link.getInput(1).gas, A.link.getInput(1).steer, A.link.isLost(1), A.link.players.get(1).connected], [0, 0, true, true], 'inputs zeroed, phone still joined');
  iv = A.stream(A.ps[0], 1);
  await sleep(200);
  clearInterval(iv);
  assertEq(A.ev[A.ev.length - 1], ['signal', 1, false], "'signal' when input resumes");
  A.link.dispose(); A.ps[0].close();

  // Two phones: P2 goes silent → 'lost' for P2 only, no pause (the desktop lets a CPU drive).
  const B = await linkWith(['multi-pad-0001', 'multi-pad-0002']);
  const iv1 = B.stream(B.ps[0], 1);
  iv = B.stream(B.ps[1], 1);
  await sleep(1200);
  clearInterval(iv);
  await sleep(1500);
  clearInterval(iv1);
  assertEq(B.ev, [['lost', 2]], 'lost for P2, no pause with two players');
  assert(!B.link.isLost(1), 'P1 fine');
  B.link.dispose(); B.ps.forEach((p) => p.close());

  // An idle phone (no buttons, no menu taps) never counts as lost; nor outside a live race.
  const C = await linkWith(['idle-pad-0001']);
  iv = C.stream(C.ps[0], 0);
  await sleep(1100);
  clearInterval(iv);
  await sleep(1500);
  assertEq(C.ev, [], 'idle phone going silent does not pause');
  C.link.sendPadState(1, realPadState(1, { step: 'done', race: { state: 'finished', finished: true } }));
  iv = C.stream(C.ps[0], 1);
  await sleep(400);
  clearInterval(iv);
  await sleep(1500);
  assertEq(C.ev, [], 'no pause after this phone finished');
  C.link.dispose(); C.ps[0].close();
  delete globalThis.io;
});

await test('PhoneLink: closing the game tab and opening it again reclaims the paired room (localStorage)', async () => {
  globalThis.io = (opts) => ioClient(HTTP_URL, { ...opts, forceNew: true });
  setStorage('localStorage', memoryStorage());       // one browser profile…
  setStorage('sessionStorage', memoryStorage());     // …tab A
  const { PhoneLink } = await import('../public/js/net.js');
  const a = new PhoneLink();
  const ia = await a.connect();
  const p = (await phone(ia.room, 'reopen-pad-0001')).p;
  await sleep(150);
  assert(a.connected, 'tab A paired');

  setStorage('sessionStorage', memoryStorage());     // tab B, opened while A is still open
  const b = new PhoneLink();
  const ib = await b.connect();
  await sleep(150);
  assert(ib.room !== ia.room, 'a second live tab gets its own room');
  assert(a.connected && !b.connected, 'the phone stays with tab A');
  b.dispose();

  const left = waitFor(p, 'host:leave', 3000);
  a.dispose();                                       // tab A closed
  await left;
  setStorage('sessionStorage', memoryStorage());     // tab C: the game opened again
  const back = waitFor(p, 'host:join', 3000);
  const c = new PhoneLink();
  const ic = await c.connect();
  assertEq(ic.room, ia.room, 'reopened tab reclaims the room');
  await back;
  await sleep(150);
  assert(c.connected && c.players.get(1)?.connected, 'phone paired with the reopened tab as P1, no rescan');
  c.dispose();
  p.close();
  delete globalThis.io;
});

await test('PhoneLink: a realistic shared state goes out once, intact, and is deduped', async () => {
  const PhoneLink = await useLink();
  const link = new PhoneLink();
  await link.connect();
  const p = (await phone(link.room, 'phonelink-dedupe-1')).p;
  await sleep(150);
  const st = realSharedState('select');
  const states = [];
  p.on('host:state', (s) => states.push(s));
  link.sendState(st);
  await sleep(120);
  link.sendState(JSON.parse(JSON.stringify(st)));     // same content again: deduped
  link.sendState(JSON.parse(JSON.stringify(st)));
  await sleep(120);
  const sel = states.filter((s) => s.screen === 'select');
  assert(sel.length >= 1 && sel.length <= 2, `state sent once (+ at most one heartbeat): ${sel.length}`);
  assertEq(canon(sel[0]), canon(st), 'state intact through PhoneLink + server');
  link.dispose();
  p.close();
  delete globalThis.io;
});

await test('PhoneLink.connect() rejects cleanly when the server is unreachable', async () => {
  globalThis.io = (opts) => ioClient('http://localhost:1', { ...opts, forceNew: true });
  const { PhoneLink } = await import('../public/js/net.js');
  const link = new PhoneLink();
  let err = null;
  try { await link.connect(); } catch (e) { err = e; }
  assert(err instanceof Error, 'rejected with an Error');
  link.dispose();
  delete globalThis.io;
});

// ------------------------------------------------------------------ server restarts

for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
if (server) {
  server.kill('SIGTERM');
  await new Promise((r) => (server.exitCode !== null ? r() : server.once('exit', r)));
}

// The rest starts its own short-lived servers on the same ports, with a
// scratch certificate directory (the real .certs/ is never touched).
if (spawnServer) {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krishivkart-certs-'));
  const temps = [];
  const startTemp = (env = {}) => {
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), NO_OPEN: '1', NO_COLOR: '1', PAD_HOST: '', KRISHIVKART_CERT_DIR: certDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t = { proc, log: '' };
    temps.push(t);
    proc.stdout.on('data', (d) => { t.log += d; });
    proc.stderr.on('data', (d) => { t.log += d; });
    t.exited = new Promise((r) => proc.once('exit', (code) => r(code)));
    t.ready = (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode})\n${t.log}`);
        if (t.log.includes('Desktop game')) return;
        await sleep(100);
      }
      throw new Error(`server did not start\n${t.log}`);
    })();
    t.ready.catch(() => {});                         // awaited where it matters
    return t;
  };
  const stopTemp = async (t) => { if (t.proc.exitCode === null && t.proc.signalCode === null) { t.proc.kill('SIGTERM'); await t.exited; } };
  const stopAll = async () => { for (const t of temps) await stopTemp(t); };
  const peerCert = () => new Promise((resolve, reject) => {
    const sock = tls.connect({ host: '127.0.0.1', port: HTTPS_PORT, rejectUnauthorized: false, servername: 'localhost' }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      resolve({ fp: c.fingerprint256, san: c.subjectaltname || '', subject: c.subject || {} });
    });
    sock.on('error', reject);
  });

  await test('certificate kept across restarts while it covers the phone URL host; a new one keeps the old addresses', async () => {
    try { await certCase(); } finally { await stopAll(); }
  });
  async function certCase() {
    let t = startTemp({ PAD_HOST: '10.9.8.7' });
    await t.ready;
    const c1 = await peerCert();
    assert(c1.san.includes('IP Address:10.9.8.7'), `SAN has PAD_HOST: ${c1.san}`);
    assertEq([c1.subject.CN, c1.subject.O], ['KRISHIV KART local server', 'KRISHIV KART'], 'new certificates carry the KRISHIV KART name');
    assert(t.log.includes('KRISHIV KART'), 'banner shows KRISHIV KART');
    await stopTemp(t);
    // PAD_HOST gone (like a VPN / bridge interface going away): the primary
    // address is still covered, so phones keep their certificate exception.
    // (Also: the pre-rename variable name TOOTKART_CERT_DIR still works.)
    t = startTemp({ KRISHIVKART_CERT_DIR: '', TOOTKART_CERT_DIR: certDir });
    await t.ready;
    const c2 = await peerCert();
    assertEq(c2.fp, c1.fp, 'same certificate reused');
    assert(!/generated a new HTTPS certificate/.test(t.log), 'no regeneration logged');
    await stopTemp(t);
    t = startTemp({ PAD_HOST: '10.9.8.6' });          // a host the cached one does not cover
    await t.ready;
    const c3 = await peerCert();
    assert(c3.fp !== c1.fp, 'regenerated for an uncovered host');
    assert(c3.san.includes('IP Address:10.9.8.6') && c3.san.includes('IP Address:10.9.8.7'), `new SAN keeps the old addresses: ${c3.san}`);
    await stopTemp(t);
  }

  await test('port held by another program on 127.0.0.1 only → the server refuses to start', async () => {
    const other = http.createServer((req, res) => res.end('OTHER'));
    await new Promise((resolve, reject) => { other.once('error', reject); other.listen(PORT, '127.0.0.1', resolve); });
    const t = startTemp();
    const code = await Promise.race([t.exited, t.ready.then(() => 'started', () => null), sleep(15000).then(() => 'timeout')])
      .then((v) => (v === null ? t.exited : v));
    other.close();
    await stopAll();
    assertEq(code, 1, `exit code (${code === 'started' ? 'it started and served localhost behind the other program' : code})`);
    assert(/already in use/.test(t.log), `explains the clash: ${t.log.trim().split('\n').slice(-6).join(' | ')}`);
  });
  fs.rmSync(certDir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ done

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length && serverLog) console.log(`--- server log ---\n${serverLog}`);
process.exit(failed.length ? 1 : 0);
