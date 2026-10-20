// Socket protocol test against a real server on spare ports.
//   node tools/net-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3210, HTTPS_PORT = 3653;
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bowling-cert-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), NO_OPEN: '1', BOWLING_CERT_DIR: certDir, ROOM_GRACE_MS: '1500' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
server.stdout.on('data', (d) => { out += d; });
server.stderr.on('data', (d) => { out += d; });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} fs.rmSync(certDir, { recursive: true, force: true }); };
process.on('exit', cleanup);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await wait(50); }
  throw new Error(`timed out waiting for ${label}`);
}
await waitFor(() => /TV \/ display/.test(out), 15000, 'server start');

const url = `http://127.0.0.1:${PORT}`;
const connect = () => new Promise((resolve, reject) => {
  const s = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
});
const ack = (s, ev, payload) => new Promise((resolve) => s.timeout(3000).emit(ev, payload, (err, res) => resolve(err ? { err } : res)));
const collect = (s, ev) => { const list = []; s.on(ev, (p) => list.push(p)); return list; };

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`✖ ${name}\n  ${err.stack || err.message}`); process.exitCode = 1; }
}

const display = await connect();
const joins = collect(display, 'player:join');
const leaves = collect(display, 'player:leave');
const inputs = collect(display, 'remote:input');
const removes = collect(display, 'player:remove');
let info;

await test('display creates a room with a QR code and join URL', async () => {
  info = await ack(display, 'display:create', {});
  assert.equal(info.ok, true);
  assert.match(info.room, /^[A-HJKMNP-Z]{4}$/);
  assert.match(info.joinUrl, new RegExp(`^https://.+:${HTTPS_PORT}/remote\\?room=${info.room}$`));
  assert.match(info.qrSvg, /^<svg/);
  assert.ok(info.key.length > 10);
});

const phones = [];
await test('four phones get slots 0..3, a fifth is refused', async () => {
  for (let i = 0; i < 4; i++) {
    const s = await connect();
    const r = await ack(s, 'remote:join', { room: info.room, clientId: `client_${i}_abcdef` });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slot, i);
    assert.equal(r.name, `Player ${i + 1}`);
    phones.push(s);
  }
  const colors = new Set();
  await waitFor(() => joins.length === 4, 3000, 'join events');
  for (const j of joins) colors.add(j.color);
  assert.equal(colors.size, 4, 'distinct default colors');
  const fifth = await connect();
  const r = await ack(fifth, 'remote:join', { room: info.room, clientId: 'client_5_abcdef' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'full');
  fifth.close();
});

await test('bad room codes are rejected', async () => {
  const s = await connect();
  assert.equal((await ack(s, 'remote:join', { room: 'ZZZZ', clientId: 'client_x_abcdef' })).code, 'no_room');
  assert.equal((await ack(s, 'remote:join', { room: 'AB', clientId: 'client_x_abcdef' })).code, 'bad_code');
  assert.equal((await ack(s, 'remote:join', { room: 'IIII' })).code, 'bad_code');
  s.close();
});

await test('inputs are validated, tagged with the slot and relayed', async () => {
  phones[1].emit('remote:input', { t: 'btn', b: 'a', down: true });
  phones[2].emit('remote:input', { t: 'throw', speed: 9, spin: -5, quality: 'weird', mode: 'motion', peak: 600, id: 7 });
  phones[3].emit('remote:input', { t: 'nope' });
  phones[3].emit('remote:input', { t: 'btn', b: 'self-destruct', down: true });
  phones[0].emit('remote:input', { t: 'menu', action: 'start' });
  await waitFor(() => inputs.length >= 3, 3000, 'inputs');
  await wait(150);
  assert.equal(inputs.length, 3);
  assert.deepEqual(inputs[0], { slot: 1, t: 'btn', b: 'a', down: true });
  assert.equal(inputs[1].slot, 2);
  assert.equal(inputs[1].speed, 1.1);
  assert.equal(inputs[1].spin, -1);
  assert.equal(inputs[1].quality, 'ok');
  assert.deepEqual(inputs[2], { slot: 0, t: 'menu', action: 'start' });
});

await test('profile updates: names are cleaned, colors are unique', async () => {
  const updates = collect(display, 'player:update');
  const r = await ack(phones[0], 'remote:profile', { name: '  Jordan​ The Great Bowler ', color: 'pink' });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'Jordan The');
  assert.equal(r.color, 'pink');
  const r2 = await ack(phones[1], 'remote:profile', { color: 'pink' });
  assert.notEqual(r2.color, 'pink', 'color already taken');
  await waitFor(() => updates.length >= 2, 2000, 'updates');
});

await test('display state reaches only its slot; events can broadcast', async () => {
  const s1 = collect(phones[1], 'state');
  const s2 = collect(phones[2], 'state');
  const ev = phones.map((p) => collect(p, 'event'));
  display.emit('display:state', { slot: 1, state: { screen: 'turn', yourTurn: true } });
  display.emit('display:event', { slot: 'all', event: { type: 'vibrate', pattern: [30] } });
  await waitFor(() => s1.length === 1 && ev.every((e) => e.length === 1), 2000, 'state/events');
  await wait(100);
  assert.equal(s2.length, 0);
  assert.deepEqual(s1[0], { screen: 'turn', yourTurn: true });
});

await test('a phone that reconnects with its client id keeps its slot and gets its last state', async () => {
  phones[1].close();
  await waitFor(() => leaves.some((l) => l.slot === 1), 3000, 'leave');
  const s = await connect();
  const states = collect(s, 'state');
  const r = await ack(s, 'remote:join', { room: info.room, clientId: 'client_1_abcdef' });
  assert.equal(r.ok, true);
  assert.equal(r.slot, 1);
  await waitFor(() => states.length === 1, 2000, 'replayed state');
  assert.equal(states[0].screen, 'turn');
  phones[1] = s;
});

await test('during a game a new phone cannot take a disconnected slot; in the lobby it can', async () => {
  display.emit('display:phase', { inGame: true });
  phones[3].close();
  await waitFor(() => leaves.some((l) => l.slot === 3), 3000, 'leave');
  const s = await connect();
  assert.equal((await ack(s, 'remote:join', { room: info.room, clientId: 'client_new_abcdef' })).code, 'full');
  display.emit('display:phase', { inGame: false });
  await wait(100);
  const r = await ack(s, 'remote:join', { room: info.room, clientId: 'client_new_abcdef' });
  assert.equal(r.ok, true);
  assert.equal(r.slot, 3);
  assert.ok(removes.some((x) => x.slot === 3 && x.reason === 'replaced'));
  phones[3] = s;
});

await test('display kick frees a slot and tells the phone', async () => {
  const kicked = collect(phones[2], 'kicked');
  display.emit('display:kick', { slot: 2 });
  await waitFor(() => kicked.length === 1 && removes.some((x) => x.slot === 2), 2000, 'kick');
});

await test('display reload reclaims the same room with its key; phones stay paired', async () => {
  const gone = collect(phones[0], 'display:gone');
  const back = collect(phones[0], 'display:back');
  display.close();
  await waitFor(() => gone.length === 1, 3000, 'display:gone');
  const d2 = await connect();
  const r = await ack(d2, 'display:create', { room: info.room, key: info.key });
  assert.equal(r.ok, true);
  assert.equal(r.room, info.room);
  assert.equal(r.reclaimed, true);
  assert.equal(r.players[0].name, 'Jordan The');
  await waitFor(() => back.length === 1, 2000, 'display:back');
  const thief = await connect();
  const r2 = await ack(thief, 'display:create', { room: info.room, key: 'wrong' });
  assert.notEqual(r2.room, info.room, 'room cannot be stolen without the key');
  thief.close();
  d2.close();
});

await test('room closes after the grace period', async () => {
  const closed = collect(phones[0], 'room:closed');
  await waitFor(() => closed.length === 1, 5000, 'room:closed');
});

await test('static files and vendor modules are served', async () => {
  for (const p of ['/vendor/three/build/three.module.js', '/vendor/rapier/dist/rapier.mjs', '/js/shared/scoring.js', '/api/info']) {
    const res = await fetch(url + p);
    assert.equal(res.status, 200, p);
  }
});

await test('seats survive the server losing the room: each phone gets its own slot back', async () => {
  const d = await connect();
  const r = await ack(d, 'display:create', { inGame: true });
  const ann = await connect(), bob = await connect();
  const seats = collect(d, 'player:join');
  assert.equal((await ack(ann, 'remote:join', { room: r.room, clientId: 'client_ann_abcdef', name: 'Ann' })).slot, 0);
  assert.equal((await ack(bob, 'remote:join', { room: r.room, clientId: 'client_bob_abcdef', name: 'Bob' })).slot, 1);
  await waitFor(() => seats.length === 2, 2000, 'joins');
  assert.ok(seats.every((x) => typeof x.seat === 'string' && x.seat.length >= 16), 'seat tokens reach the display');
  // The room expires (stands in for a server restart).
  const closed = collect(ann, 'room:closed');
  d.close();
  await waitFor(() => closed.length === 1, 5000, 'room closed');
  ann.close(); bob.close();
  const d2 = await connect();
  const r2 = await ack(d2, 'display:create', { room: r.room, key: r.key, inGame: true, seats: seats.map((x) => ({ slot: x.slot, seat: x.seat, name: x.name, color: x.color })) });
  assert.equal(r2.room, r.room);
  assert.deepEqual(r2.players.slice(0, 2).map((x) => x && x.name), ['Ann', 'Bob']);
  // Bob comes back first, a stranger next: neither may take Ann's seat.
  const bob2 = await connect(), eve = await connect(), ann2 = await connect();
  assert.equal((await ack(bob2, 'remote:join', { room: r.room, clientId: 'client_bob_abcdef' })).slot, 1);
  assert.equal((await ack(eve, 'remote:join', { room: r.room, clientId: 'client_eve_abcdef' })).slot, 2);
  assert.equal((await ack(ann2, 'remote:join', { room: r.room, clientId: 'client_ann_abcdef' })).slot, 0);
  for (const x of [d2, bob2, eve, ann2]) x.close();
});

await test('seats used by keyboard players are not given to phones', async () => {
  const d = await connect();
  const r = await ack(d, 'display:create', { reserved: 3 });
  const a = await connect(), b = await connect();
  assert.equal((await ack(a, 'remote:join', { room: r.room, clientId: 'client_res_a_abcdef' })).ok, true);
  assert.equal((await ack(b, 'remote:join', { room: r.room, clientId: 'client_res_b_abcdef' })).code, 'full');
  d.emit('display:phase', { inGame: false, reserved: 2 });
  await wait(100);
  assert.equal((await ack(b, 'remote:join', { room: r.room, clientId: 'client_res_b_abcdef' })).ok, true);
  for (const x of [d, a, b]) x.close();
});

await test('every input kind is rate limited (throws reply "Too many requests")', async () => {
  const d = await connect();
  const r = await ack(d, 'display:create', {});
  const a = await connect();
  await ack(a, 'remote:join', { room: r.room, clientId: 'client_rate_abcdef' });
  const got = collect(d, 'remote:input');
  const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => ack(a, 'remote:input', { t: 'throw', speed: 0.5, spin: 0, id: i })));
  assert.ok(replies.some((x) => x.code === 'rate'), 'some throws were refused');
  await wait(100);
  assert.ok(got.length <= 8, `relayed ${got.length}`);
  d.close(); a.close();
});

await test('browsers on other sites cannot connect (Origin check)', async () => {
  const bad = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { Origin: 'http://evil.example' } });
  const outcome = await new Promise((res) => { bad.once('connect', () => res('connected')); bad.once('connect_error', () => res('refused')); });
  bad.close();
  assert.equal(outcome, 'refused');
  const good = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { Origin: `http://localhost:${PORT}` } });
  const ok = await new Promise((res) => { good.once('connect', () => res('connected')); good.once('connect_error', () => res('refused')); });
  good.close();
  assert.equal(ok, 'connected');
});

await test('/remote.html goes through the /remote route', async () => {
  const res = await fetch(`${url}/remote.html?room=ABCD`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/remote?room=ABCD');
});

for (const p of phones) p.close();
console.log(process.exitCode ? `net: some tests FAILED (${passed} passed)` : `net: all ${passed} tests passed`);
cleanup();
process.exit(process.exitCode || 0);
