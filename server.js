// Krishiv Sports — the games server.
//
//   npm start            (= node server.js)
//
// * HTTP  on PORT       (default 3000): the TV — the games menu, and Tennis and
//   Golf (each with its own lobby and QR code).
// * HTTPS on HTTPS_PORT (default 3443): the phone controller. Motion sensors need a
//   secure context, so a self-signed certificate is created on first start
//   (SAN = localhost, 127.0.0.1 and every LAN IPv4) and kept in .certs/. If the
//   Bowling or Krishiv Kart folder already has a certificate that covers this
//   computer, it is reused, so phones that accepted it are not asked again.
// * ONE Socket.IO server is attached to both, so a TV on http and phones on
//   https share the same rooms.
// * Bowling and Krishiv Kart are the existing projects next to this folder.
//   When the menu picks one, it is started as a child server on its own ports
//   (with this certificate) and the TV and the phones are sent to it. A small
//   script in those pages (hub-link.js, only active when opened from here)
//   adds a "Krishiv Sports" button that brings everyone back.
//
// Rooms: one TV + up to four phones (player slots 0..3). Every phone scans the
// QR code in a game's lobby and gets the next free slot; its client id (localStorage) lets a
// reload / Wi-Fi blip / trip to another game reclaim the same slot. Every
// client payload is validated and clamped before it is relayed.
//
// Environment:
//   PORT, HTTPS_PORT      listening ports (3000 / 3443)
//   NO_OPEN=1             do not open the TV page in the default browser
//   PAD_HOST=<ip|name>    force the host used in the phone URL / QR code
//   ROOM_GRACE_MS         how long a room survives without its TV (default 120000)
//   KRISHIV_SPORTS_CERT_DIR  where the certificate is kept (default .certs/)
//   BOWLING_DIR, KART_DIR where the other games live (default games/bowling and
//                         games/krishiv-kart in this repo; falls back to ../Bowling
//                         and ../Mario Fart for the old side-by-side folder layout)

import express from 'express';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import selfsigned from 'selfsigned';
import {
  GAME_TITLE, MAX_PLAYERS, ROOM_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode, PLAYER_COLORS, COLOR_IDS,
  cleanName, BUTTONS, MENU_ACTIONS, SWING_SIDES, INPUT_MODES, NET, CHARACTER_IDS, defaultCharacterFor, GAME_IDS,
} from './public/js/shared/protocol.js';

// ---------------------------------------------------------------- settings

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const CERT_DIR = process.env.KRISHIV_SPORTS_CERT_DIR ? path.resolve(process.env.KRISHIV_SPORTS_CERT_DIR) : path.join(ROOT, '.certs');
const CERT_VERSION = 2;
const CERT_MAX_IPS = 24;
const DAY_MS = 24 * 3600 * 1000;
const INSTANCE = crypto.randomBytes(9).toString('base64url');
const INSTANCE_HEADER = 'X-KrishivSports-Instance';

const HTTP_PORT = envPort('PORT', NET.httpPort);
const HTTPS_PORT = envPort('HTTPS_PORT', NET.httpsPort);
const NO_OPEN = /^(1|true|yes)$/i.test(process.env.NO_OPEN || '');
const ROOM_GRACE_MS = Math.max(1000, Number(process.env.ROOM_GRACE_MS) || 120_000);
const AWAY_HOLD_MS = 45_000;        // a TV in another game keeps the room while its page checks in
const MAX_ROOMS = 200;
const NETWORK_POLL_MS = 10_000;
const MAX_STATE_BYTES = 24 * 1024;

function envPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`  ${name}=${raw} is not a valid port number.`);
    process.exit(1);
  }
  return n;
}

// ---------------------------------------------------------------- console output

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: paint('1'), red: paint('31'), green: paint('32'), yellow: paint('33'), blue: paint('34'), magenta: paint('35'), cyan: paint('36'), gray: paint('90'),
};
function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`${c.gray(t)} ${msg}`);
}

// ---------------------------------------------------------------- network discovery

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

let defaultRouteCache = { key: '', name: null };
function defaultRouteInterface(key) {
  if (defaultRouteCache.key === key) return defaultRouteCache.name;
  let name = null;
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    if (process.platform === 'darwin') name = /interface:\s*(\S+)/.exec(run('route', ['-n', 'get', 'default']))?.[1] || null;
    else if (process.platform === 'linux') name = /\bdev\s+(\S+)/.exec(run('ip', ['route', 'show', 'default']))?.[1] || null;
  } catch { /* no default route: fall back to name heuristics */ }
  defaultRouteCache = { key, name };
  return name;
}

// Higher score = more likely the address a phone on the same Wi-Fi can reach.
function scoreAddress(name, ip, routeIf) {
  let score = 0;
  if (routeIf && name === routeIf) score += 50;
  if (ip.startsWith('169.254.')) score -= 1000;
  if (isPrivateIPv4(ip)) {
    score += 100;
    if (ip.startsWith('192.168.')) score += 6;
    else if (ip.startsWith('10.')) score += 4;
    else score += 2;
  }
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) score -= 40;
  if (/^(en0|wlan0|wi-?fi)$/i.test(name)) score += 30;
  else if (/^(en\d|eth|eno|enp|ens|wlp|wlan|wl|ethernet)/i.test(name)) score += 20;
  if (/^(utun|tun|tap|ppp|ipsec|gif|stf|bridge|vmnet|vboxnet|docker|br-|veth|virbr|zt|tailscale|llw|awdl|anpi|ap\d|vethernet)/i.test(name)) score -= 60;
  return score;
}

function getNetworkInfo() {
  const list = [];
  const seen = new Set();
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const family = typeof a.family === 'string' ? a.family : a.family === 4 ? 'IPv4' : 'IPv6';
      if (family !== 'IPv4' || a.internal || seen.has(a.address)) continue;
      seen.add(a.address);
      list.push({ name, ip: a.address, score: 0 });
    }
  }
  const routeIf = list.length > 1 ? defaultRouteInterface(list.map((e) => `${e.name}=${e.ip}`).sort().join(',')) : null;
  for (const e of list) e.score = scoreAddress(e.name, e.ip, routeIf);
  list.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name, 'en', { numeric: true }));
  const override = (process.env.PAD_HOST || '').trim();
  return {
    interfaces: list,
    lanIps: list.map((e) => e.ip),
    primary: override || (list[0] ? list[0].ip : 'localhost'),
    override: override || null,
  };
}

const networkKey = (n) => `${[...n.lanIps].sort().join(',')}|${n.primary}`;
const urlHost = (h) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

// ---------------------------------------------------------------- TLS certificate

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOSTNAME_RE = /^[a-z0-9.-]{1,253}$/i;

function certNames(network) {
  const ips = [...new Set(network.lanIps)];
  const hosts = [];
  const hostname = os.hostname();
  if (HOSTNAME_RE.test(hostname)) {
    hosts.push(hostname);
    if (!hostname.includes('.')) hosts.push(`${hostname}.local`);
  }
  if (network.override) {
    if (IPV4_RE.test(network.override)) { if (!ips.includes(network.override)) ips.push(network.override); }
    else if (HOSTNAME_RE.test(network.override)) hosts.push(network.override);
  }
  return { ips, hosts };
}

function parseSan(san) {
  const out = { ips: [], hosts: [] };
  for (const part of String(san || '').split(/,\s*/)) {
    const m = /^(DNS|IP Address):(.+)$/.exec(part.trim());
    if (!m) continue;
    if (m[1] === 'DNS') out.hosts.push(m[2].toLowerCase());
    else out.ips.push(m[2]);
  }
  return out;
}

const certCovers = (san, host) => (IPV4_RE.test(host) ? san.ips.includes(host) : san.hosts.includes(String(host).toLowerCase()));
const union = (a, b) => [...new Set([...a, ...b])];
const neededHost = (network) => (IPV4_RE.test(network.primary) || HOSTNAME_RE.test(network.primary) ? network.primary : 'localhost');

// Reads a cached certificate from `dir`; null if missing, broken or not usable here.
function readCert(dir, network) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const key = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');
    const cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
    const x509 = new crypto.X509Certificate(cert);
    if (!x509.checkPrivateKey(crypto.createPrivateKey(key))) return null;
    const san = parseSan(x509.subjectAltName);
    const fresh = Date.parse(x509.validTo) - Date.now() > 7 * DAY_MS;
    return { meta, key, cert, san, usable: meta.version === CERT_VERSION && fresh && certCovers(san, neededHost(network)) };
  } catch { return null; }
}

// First start: borrow the certificate the Bowling / Kart folders already use
// (the same format), so phones that trusted it are not warned again.
function seedCertificate(network) {
  if (readCert(CERT_DIR, network)) return null;
  for (const dir of [path.join(gameDir('bowling'), '.certs'), path.join(gameDir('kart'), '.certs')]) {
    const found = readCert(dir, network);
    if (!found?.usable) continue;
    fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(CERT_DIR, 'key.pem'), found.key, { mode: 0o600 });
    fs.writeFileSync(path.join(CERT_DIR, 'cert.pem'), found.cert);
    fs.writeFileSync(path.join(CERT_DIR, 'meta.json'), JSON.stringify(found.meta, null, 2));
    return dir;
  }
  return null;
}

// Keeps the cached certificate while it covers the phone-URL host: a phone's
// "visit this website" exception is for that exact certificate.
async function ensureCertificate(network) {
  const cached = readCert(CERT_DIR, network);
  if (cached?.usable) return { key: cached.key, cert: cached.cert, regenerated: false };
  const previous = cached?.san || { ips: [], hosts: [] };
  const want = certNames(network);
  const ips = union(want.ips, previous.ips.filter((ip) => ip !== '127.0.0.1')).slice(0, CERT_MAX_IPS);
  const extraHosts = union(want.hosts, previous.hosts.filter((h) => h !== 'localhost')).slice(0, 16);
  const notBefore = new Date(Date.now() - DAY_MS);
  const notAfter = new Date(notBefore.getTime() + 730 * DAY_MS); // < 825 days: iOS rejects longer-lived TLS certs
  const altNames = [
    { type: 2, value: 'localhost' },
    ...extraHosts.map((value) => ({ type: 2, value })),
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: `${GAME_TITLE} local server` }, { name: 'organizationName', value: GAME_TITLE }],
    {
      keyType: 'rsa', keySize: 2048, algorithm: 'sha256', notBeforeDate: notBefore, notAfterDate: notAfter,
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    },
  );
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(CERT_DIR, 'key.pem'), pems.private, { mode: 0o600 });
  fs.writeFileSync(path.join(CERT_DIR, 'cert.pem'), pems.cert);
  fs.writeFileSync(path.join(CERT_DIR, 'meta.json'), JSON.stringify({
    version: CERT_VERSION, ips, hosts: extraHosts, created: new Date().toISOString(),
    notAfter: notAfter.toISOString(), fingerprint: pems.fingerprint,
  }, null, 2));
  return { key: pems.private, cert: pems.cert, regenerated: true, names: ['localhost', ...extraHosts, '127.0.0.1', ...ips] };
}

// ---------------------------------------------------------------- the other games (child servers)

const CHILD_GAMES = {
  bowling: {
    name: 'Bowling', envDir: 'BOWLING_DIR', repoDir: 'games/bowling', folder: 'Bowling', ports: NET.bowling, certEnv: 'BOWLING_CERT_DIR',
    phonePath: '/remote', title: /bowling/i, color: c.yellow,
  },
  kart: {
    name: 'Krishiv Kart', envDir: 'KART_DIR', repoDir: 'games/krishiv-kart', folder: 'Mario Fart', ports: NET.kart, certEnv: 'KRISHIVKART_CERT_DIR',
    phonePath: '/pad', title: null, color: c.magenta,
  },
};

function gameDir(id) {
  const g = CHILD_GAMES[id];
  if (process.env[g.envDir]) return path.resolve(process.env[g.envDir]);
  const inRepo = path.join(ROOT, g.repoDir);
  if (fs.existsSync(path.join(inRepo, 'server.js'))) return inRepo;
  return path.join(ROOT, '..', g.folder);
}

/** @type {Map<string, {proc: any, ready: Promise<any>|null, ports: any, exited: boolean}>} */
const children = new Map();

function childInstalled(id) {
  const dir = gameDir(id);
  if (!fs.existsSync(path.join(dir, 'server.js'))) return { ok: false, why: `${CHILD_GAMES[id].name} was not found at ${dir}` };
  if (!fs.existsSync(path.join(dir, 'node_modules'))) return { ok: false, why: `${CHILD_GAMES[id].name} needs its packages: run "npm install" in ${dir}` };
  return { ok: true, dir };
}

function probeChild(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/info', timeout: 1200, agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > 8000) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Starts (or reuses) a game's own server. Resolves { httpPort, httpsPort, https }.
async function ensureChild(id) {
  const g = CHILD_GAMES[id];
  const cur = children.get(id);
  if (cur && !cur.exited && cur.ready) return cur.ready;
  const inst = childInstalled(id);
  if (!inst.ok) throw new Error(inst.why);
  // Already running on its ports (started by hand, or a previous hub)?
  const running = await probeChild(g.ports.httpPort);
  if (running && (!g.title || g.title.test(running.title || ''))) {
    log(`${g.color(`[${id}]`)} already running on port ${g.ports.httpPort} — using it`);
    const info = { httpPort: g.ports.httpPort, httpsPort: running.httpsPort || g.ports.httpsPort, https: running.https !== false };
    children.set(id, { proc: null, ready: Promise.resolve(info), exited: false });
    return info;
  }
  if (running) throw new Error(`Port ${g.ports.httpPort} is used by another program`);
  const env = {
    ...process.env,
    PORT: String(g.ports.httpPort),
    HTTPS_PORT: String(g.ports.httpsPort),
    NO_OPEN: '1',
    PAD_HOST: network.primary,
    [g.certEnv]: CERT_DIR,
  };
  delete env.NO_COLOR;
  log(`${g.color(`[${id}]`)} starting ${g.name} from ${inst.dir}`);
  const proc = spawn(process.execPath, ['server.js'], { cwd: inst.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { proc, ready: null, exited: false };
  children.set(id, entry);
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\s+$/, '');
        buf = buf.slice(i + 1);
        if (line.trim()) console.log(`${g.color(`[${id}]`)} ${line}`);
      }
    });
  };
  pipe(proc.stdout);
  pipe(proc.stderr);
  proc.on('exit', (code) => {
    entry.exited = true;
    if (!shuttingDown) log(`${g.color(`[${id}]`)} ${g.name} stopped${code ? ` (exit ${code})` : ''}`);
  });
  entry.ready = (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000) {
      if (entry.exited) throw new Error(`${g.name} could not start (see the terminal)`);
      const info = await probeChild(g.ports.httpPort);
      if (info) return { httpPort: g.ports.httpPort, httpsPort: info.httpsPort || g.ports.httpsPort, https: info.https !== false };
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`${g.name} did not start in time`);
  })();
  entry.ready.catch(() => { entry.exited = true; });
  return entry.ready;
}

let shuttingDown = false;
function stopChildren() {
  for (const [, ch] of children) {
    if (ch.proc && !ch.exited) { try { ch.proc.kill('SIGTERM'); } catch { /* gone */ } }
  }
}

// ---------------------------------------------------------------- payload sanitizers

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function num(v, lo, hi, def = 0) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? (n < lo ? lo : n > hi ? hi : n) : def;
}
const round = (v, k = 1000) => Math.round(v * k) / k;
const sanitizeClientId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,48}$/.test(v) ? v : null);
const BUTTON_SET = new Set(BUTTONS);
const MENU_SET = new Set(MENU_ACTIONS);
const SIDE_SET = new Set(SWING_SIDES);
const MODE_SET = new Set(INPUT_MODES);
const COLOR_SET = new Set(COLOR_IDS);

function sanitizeValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? round(num(v, -1e6, 1e6)) : undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^[A-Za-z0-9 _.:-]{1,24}$/.test(v)) return v;
  return undefined;
}

function sanitizeInput(p) {
  if (!isObj(p)) return null;
  switch (p.t) {
    case 'btn':
      if (!BUTTON_SET.has(p.b)) return null;
      return { t: 'btn', b: p.b, down: p.down === true };
    case 'tswing':
      return {
        t: 'tswing',
        side: SIDE_SET.has(p.side) ? p.side : 'fh',
        speed: round(num(p.speed, 0, 1.2, 0.5)),
        plane: round(num(p.plane, -1, 1)),
        roll: round(num(p.roll, -1, 1)),
        lag: Math.round(num(p.lag, 0, 600, 40)),
        age: Math.round(num(p.age, 0, 600, 0)),
        id: Math.round(num(p.id, 0, 2 ** 31 - 1)),
        mode: MODE_SET.has(p.mode) ? p.mode : 'motion',
      };
    case 'gclub':
      return { t: 'gclub', a: round(num(p.a, -400, 400), 10), r: round(num(p.r, -4000, 4000), 10), armed: p.armed === true };
    case 'gswing':
      return {
        t: 'gswing',
        power: round(num(p.power, 0, 1.6)),
        curve: round(num(p.curve, -1, 1)),
        practice: p.practice === true,
        peak: round(num(p.peak, 0, 6000), 10),
        back: round(num(p.back, 0, 400), 10),
        id: Math.round(num(p.id, 0, 2 ** 31 - 1)),
        mode: MODE_SET.has(p.mode) ? p.mode : 'motion',
      };
    case 'menu': {
      if (!MENU_SET.has(p.action)) return null;
      const out = { t: 'menu', action: p.action };
      const v = sanitizeValue(p.value);
      if (v !== undefined) out.value = v;
      if (isObj(p.opts)) {
        const opts = {};
        for (const [k, val] of Object.entries(p.opts).slice(0, 12)) {
          if (!/^[a-z][A-Za-z0-9]{0,15}$/.test(k)) continue;
          const sv = sanitizeValue(val);
          if (sv !== undefined) opts[k] = sv;
        }
        out.opts = opts;
      }
      return out;
    }
    case 'cancel':
      return { t: 'cancel' };
    default:
      return null;
  }
}

// TV → phone payloads come from our own TV page, but they are still forced
// through JSON and capped so a broken tab cannot flood phones.
function plainJson(v) {
  if (!isObj(v)) return null;
  let json;
  try { json = JSON.stringify(v); } catch { return null; }
  if (!json || json.length > MAX_STATE_BYTES) return null;
  return JSON.parse(json);
}

// ---------------------------------------------------------------- rooms

/** @type {Map<string, Room>} */
const rooms = new Map();

const BLOCKED_CODES = new Set(['ANUS', 'ARSE', 'CRAP', 'CUNT', 'DAMN', 'DUMB', 'DYKE', 'FAGS', 'FUCK', 'FUCT', 'HATE',
  'JERK', 'KKKK', 'MUFF', 'NAZI', 'PUKE', 'PUSS', 'RAPE', 'SCUM', 'SEXY', 'SHAG', 'SHAT', 'SMEG', 'SPAZ', 'TARD', 'TURD',
  'TWAT', 'WANK', 'XXXX']);

function generateCode() {
  for (let attempt = 0; attempt < 500; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
    if (!rooms.has(code) && !BLOCKED_CODES.has(code)) return code;
  }
  throw new Error('No free room codes');
}

class Room {
  constructor(code) {
    this.code = code;
    this.key = crypto.randomBytes(12).toString('base64url');   // lets the TV reclaim this room
    this.display = null;
    /** @type {Array<null | {clientId, socket, name, color, hand, character, seat}>} */
    this.slots = new Array(MAX_PLAYERS).fill(null);
    this.lastState = new Array(MAX_PLAYERS).fill(null);
    this.inGame = false;
    this.reserved = 0;                                    // seats held by keyboard players on the TV
    this.graceTimer = null;
    this.where = 'menu';                                  // menu | tennis | golf | bowling | kart
    this.childRoom = null;                                // the room code the other game's TV got
    this.childPorts = null;
    this.homeSeq = 0;                                     // bumped when a phone presses HOME
    this.lastSeen = Date.now();                           // TV page in another game checking in
  }
}

function createRoom(code) {
  const room = new Room(code);
  rooms.set(code, room);
  log(`${c.cyan(`[${code}]`)} room opened`);
  return room;
}

// A phone's seat token: a hash of its private client id + the room code. The
// TV keeps the tokens, so if the server loses the room (restart) it can
// re-create the seats and each phone reclaims its own.
const seatOf = (clientId, code) => crypto.createHash('sha256').update(`${clientId}:${code}`).digest('base64url').slice(0, 24);
const SEAT_RE = /^[A-Za-z0-9_-]{16,44}$/;

const slotInfo = (room, i) => {
  const s = room.slots[i];
  return s ? { slot: i, name: s.name, color: s.color, hand: s.hand, character: s.character || defaultCharacterFor(i), connected: !!s.socket, seat: s.seat } : null;
};
const playersOf = (room) => room.slots.map((_, i) => slotInfo(room, i));
const toDisplay = (room, event, payload) => { if (room.display) room.display.emit(event, payload); };

function freeColor(room, slot) {
  const used = new Set(room.slots.filter((s, i) => s && i !== slot).map((s) => s.color));
  return (PLAYER_COLORS.find((col, i) => i === slot && !used.has(col.id)) || PLAYER_COLORS.find((col) => !used.has(col.id)) || PLAYER_COLORS[0]).id;
}

function attachDisplay(room, socket) {
  clearTimeout(room.graceTimer);
  room.graceTimer = null;
  const old = room.display;
  if (old && old !== socket) {
    old.data.room = null;
    old.data.role = null;
    old.emit('display:replaced', {});
  }
  room.display = socket;
  socket.data.role = 'display';
  socket.data.room = room.code;
  // The TV is back on the hub: whatever game it was in is over.
  if (room.where === 'bowling' || room.where === 'kart') log(`${c.cyan(`[${room.code}]`)} back from ${CHILD_GAMES[room.where].name}`);
  setWhere(room, 'menu');
  for (const s of room.slots) if (s?.socket) s.socket.emit('display:back', {});
}

function setWhere(room, where) {
  if (room.where === where) return;
  room.where = where;
  if (where !== 'bowling' && where !== 'kart') { room.childRoom = null; room.childPorts = null; }
}

function displayGone(room) {
  room.display = null;
  for (const s of room.slots) if (s?.socket) s.socket.emit('display:gone', { where: room.where });
  scheduleExpiry(room);
}

function scheduleExpiry(room) {
  clearTimeout(room.graceTimer);
  const away = room.where === 'bowling' || room.where === 'kart';
  if (!away) log(`${c.cyan(`[${room.code}]`)} TV disconnected — holding the room for ${Math.round(ROOM_GRACE_MS / 1000)} s`);
  room.graceTimer = setTimeout(() => {
    // A TV in another game keeps the room alive while that page checks in.
    if (!room.display && away && Date.now() - room.lastSeen < AWAY_HOLD_MS) { scheduleExpiry(room); return; }
    closeRoom(room, 'expired');
  }, away ? AWAY_HOLD_MS : ROOM_GRACE_MS);
}

function closeRoom(room, reason) {
  if (rooms.get(room.code) !== room || room.display) return;
  clearTimeout(room.graceTimer);
  for (const s of room.slots) {
    if (!s?.socket) continue;
    s.socket.emit('room:closed', { reason });
    s.socket.data.room = null;
  }
  rooms.delete(room.code);
  log(`${c.cyan(`[${room.code}]`)} room closed (${reason})`);
}

function displayRoom(socket) {
  if (socket.data.role !== 'display' || !socket.data.room) return null;
  const room = rooms.get(socket.data.room);
  return room && room.display === socket ? room : null;
}

function remoteSlot(socket) {
  if (socket.data.role !== 'remote' || !socket.data.room) return null;
  const room = rooms.get(socket.data.room);
  const slot = socket.data.slot;
  if (!room || !Number.isInteger(slot) || room.slots[slot]?.socket !== socket) return null;
  return { room, slot };
}

// Picks the slot for a joining phone: its own (same client id), else a free
// one, else — outside a game — the slot of a phone that is not connected.
function pickSlot(room, clientId) {
  const seat = seatOf(clientId, room.code);
  const own = room.slots.findIndex((s) => s && (s.clientId === clientId || (!s.clientId && s.seat === seat)));
  if (own >= 0) return { slot: own, reclaimed: true };
  const taken = room.slots.filter(Boolean).length;
  const free = room.slots.findIndex((s) => !s);
  if (free >= 0 && taken + room.reserved < MAX_PLAYERS) return { slot: free, reclaimed: false };
  if (!room.inGame && !CHILD_GAMES[room.where]) {
    const idle = room.slots.findIndex((s) => s && !s.socket);
    if (idle >= 0) return { slot: idle, reclaimed: false, replaced: true };
  }
  return null;
}

function releaseSlot(room, slot, reason) {
  const s = room.slots[slot];
  if (!s) return;
  if (s.socket) {
    s.socket.emit('kicked', { reason });
    s.socket.data.room = null;
    s.socket.data.slot = null;
  }
  room.slots[slot] = null;
  room.lastState[slot] = null;
  toDisplay(room, 'player:remove', { slot, reason });
  log(`${c.cyan(`[${room.code}]`)} P${slot + 1} removed (${reason})`);
}

function applyPhase(room, p) {
  if (!isObj(p)) return;
  if (typeof p.inGame === 'boolean') room.inGame = p.inGame;
  if (p.reserved !== undefined) room.reserved = Math.round(num(p.reserved, 0, MAX_PLAYERS, 0));
}

function restoreSeats(room, p) {
  if (!isObj(p) || !Array.isArray(p.seats)) return;
  for (const x of p.seats.slice(0, MAX_PLAYERS)) {
    if (!isObj(x) || typeof x.seat !== 'string' || !SEAT_RE.test(x.seat)) continue;
    const slot = Number(x.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PLAYERS || room.slots[slot]) continue;
    room.slots[slot] = {
      clientId: null, seat: x.seat, socket: null,
      name: cleanName(x.name) || `Player ${slot + 1}`,
      color: COLOR_SET.has(x.color) ? x.color : freeColor(room, slot),
      hand: x.hand === 'left' ? 'left' : 'right',
      character: CHARACTER_IDS.includes(x.character) ? x.character : defaultCharacterFor(slot),
    };
  }
}

const MAX_ROOMS_PER_ADDRESS = 8;
const roomsOf = (socket) => {
  const addr = socket.handshake.address;
  let n = 0;
  for (const r of rooms.values()) if (r.display?.handshake.address === addr) n++;
  return n;
};
function evictVacantRoom() {
  for (const r of rooms.values()) {
    if (!r.display) { closeRoom(r, 'evicted'); return true; }
  }
  return false;
}

// ---------------------------------------------------------------- sending phones to the other games

function hubPhoneUrl(room) {
  return `${phoneBaseUrl()}?room=${room.code}`;
}

// The other game's phone page for one player, with their profile and the way home.
function childPhoneUrl(room, slot) {
  const g = CHILD_GAMES[room.where];
  const s = room.slots[slot];
  if (!g || !s || !room.childPorts) return null;
  const q = new URLSearchParams({ room: room.childRoom || room.code, hub: hubPhoneUrl(room), hubRoom: room.code, name: s.name, color: s.color, character: s.character || '', hand: s.hand || 'right' });
  const proto = room.childPorts.https ? 'https' : 'http';
  const port = room.childPorts.https ? room.childPorts.httpsPort : room.childPorts.httpPort;
  return `${proto}://${urlHost(network.primary)}:${port}${g.phonePath}?${q}`;
}

function sendPhonesToChild(room) {
  room.slots.forEach((s, slot) => {
    if (!s?.socket) return;
    const url = childPhoneUrl(room, slot);
    if (url) s.socket.emit('hub:goto', { game: room.where, url });
  });
}

// ---------------------------------------------------------------- shared server state

let network = getNetworkInfo();
let httpsReady = false;
const qrCache = new Map();

function phoneBaseUrl() {
  return httpsReady
    ? `https://${urlHost(network.primary)}:${HTTPS_PORT}/play`
    : `http://${urlHost(network.primary)}:${HTTP_PORT}/play`;
}

async function qrFor(url) {
  let svg = qrCache.get(url);
  if (!svg) {
    svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#1d2433', light: '#ffffff' } });
    if (qrCache.size > 64) qrCache.clear();
    qrCache.set(url, svg);
  }
  return svg;
}

function gamesInfo() {
  const out = {};
  for (const id of Object.keys(CHILD_GAMES)) {
    const inst = childInstalled(id);
    out[id] = { installed: inst.ok, why: inst.ok ? null : inst.why };
  }
  return out;
}

async function roomInfo(room) {
  const joinUrl = `${phoneBaseUrl()}?room=${room.code}`;
  return { room: room.code, joinUrl, qrSvg: await qrFor(joinUrl), lanIps: network.lanIps.slice(), https: httpsReady, games: gamesInfo() };
}

// ---------------------------------------------------------------- express app

// Browsers send an Origin: only pages from this machine (localhost, its LAN
// addresses or names) may drive the game. Non-browser clients send none.
function originAllowed(origin) {
  if (!origin) return true;
  let host;
  try { host = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return false; }
  const me = os.hostname().toLowerCase();
  return isLoopbackHost(host) || network.lanIps.includes(host) || host === me || host === `${me}.local` ||
    (network.override && host === network.override.toLowerCase());
}

const isLoopbackHost = (host) => host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');

// Per-address budget for the small JSON API the other games' pages poll.
const apiHits = new Map();
function apiAllowed(req) {
  const k = req.socket.remoteAddress || '?';
  const t = Date.now();
  let b = apiHits.get(k);
  if (!b || t - b.t > 1000) { b = { t, n: 0 }; apiHits.set(k, b); }
  if (apiHits.size > 500) apiHits.clear();
  return ++b.n <= 30;
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/info', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set(INSTANCE_HEADER, INSTANCE);
    res.json({ lanIps: network.lanIps, httpPort: HTTP_PORT, httpsPort: HTTPS_PORT, phoneBaseUrl: phoneBaseUrl(), https: httpsReady, title: GAME_TITLE, games: gamesInfo() });
  });

  // The other games' pages (on other ports) check in here: where the TV is, and HOME.
  const cors = (req, res) => {
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET, POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
    }
    res.set('Cache-Control', 'no-store');
  };
  app.options('/api/hub/room/:code{/:action}', (req, res) => { cors(req, res); res.status(204).end(); });
  app.get('/api/hub/room/:code', (req, res) => {
    cors(req, res);
    if (!apiAllowed(req) || (req.headers.origin && !originAllowed(req.headers.origin))) { res.status(429).json({ ok: false }); return; }
    const room = rooms.get(normalizeRoomCode(req.params.code) || '');
    if (!room) { res.status(404).json({ ok: false, error: 'no room' }); return; }
    if (req.query.tv === '1') room.lastSeen = Date.now();
    res.json({ ok: true, where: room.where, homeSeq: room.homeSeq, childRoom: room.childRoom, tvHere: !!room.display });
  });
  app.post('/api/hub/room/:code/home', (req, res) => {
    cors(req, res);
    if (!apiAllowed(req) || (req.headers.origin && !originAllowed(req.headers.origin))) { res.status(429).json({ ok: false }); return; }
    const room = rooms.get(normalizeRoomCode(req.params.code) || '');
    if (!room) { res.status(404).json({ ok: false }); return; }
    room.homeSeq++;
    log(`${c.cyan(`[${room.code}]`)} HOME pressed on a phone — the TV goes back to the menu`);
    res.json({ ok: true, homeSeq: room.homeSeq });
  });
  // The TV page of the other game reports the room code it actually got.
  app.post('/api/hub/room/:code/child', express.json({ limit: '1kb', type: ['application/json', 'text/plain'] }), (req, res) => {
    cors(req, res);
    if (!apiAllowed(req) || (req.headers.origin && !originAllowed(req.headers.origin))) { res.status(429).json({ ok: false }); return; }
    const room = rooms.get(normalizeRoomCode(req.params.code) || '');
    const child = normalizeRoomCode(isObj(req.body) ? req.body.room : null);
    const game = isObj(req.body) ? req.body.game : null;
    if (!room || !child || !CHILD_GAMES[game]) { res.status(400).json({ ok: false }); return; }
    room.lastSeen = Date.now();
    if (room.where !== game) { res.json({ ok: true, ignored: true }); return; }
    if (room.childRoom !== child) {
      room.childRoom = child;
      log(`${c.cyan(`[${room.code}]`)} ${CHILD_GAMES[game].name} opened room ${child} — sending the phones`);
      sendPhonesToChild(room);
    }
    res.json({ ok: true });
  });

  app.get('/play', (req, res) => {
    // A phone that typed the plain-http address is bounced to HTTPS (motion
    // sensors need a secure context). Loopback http already is one.
    const host = String(req.hostname || '');
    if (!req.secure && httpsReady && !isLoopbackHost(host) && /^[a-z0-9.-]+$/i.test(host)) {
      const q = req.originalUrl.indexOf('?');
      res.redirect(302, `https://${host}:${HTTPS_PORT}/play${q >= 0 ? req.originalUrl.slice(q) : ''}`);
      return;
    }
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'play.html'));
  });
  app.get(['/play.html', '/remote', '/pad'], (req, res) => {
    const q = req.originalUrl.indexOf('?');
    res.redirect(302, `/play${q >= 0 ? req.originalUrl.slice(q) : ''}`);
  });
  app.get('/hub-link.js', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.set('Access-Control-Allow-Origin', '*');
    res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'hub-link.js'));
  });
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.use('/vendor/three', express.static(path.join(NODE_MODULES, 'three'), { index: false, maxAge: '1h', fallthrough: false }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  return app;
}

// ---------------------------------------------------------------- socket.io

const RATE_LIMITS = {
  'display:create': 10, 'display:state': 160, 'display:event': 80, 'display:kick': 10, 'display:phase': 20, 'display:profile': 20,
  'display:where': 20, 'display:launch': 4,
  'remote:join': 10, 'remote:profile': 10, 'net:ping': 10,
  'remote:input:gclub': 70, 'remote:input:btn': 60, 'remote:input:tswing': 20, 'remote:input:gswing': 10,
  'remote:input:cancel': 10, 'remote:input:menu': 20,
};

function allow(socket, event) {
  const t = Date.now();
  const rate = socket.data.rate || (socket.data.rate = {});
  let bucket = rate[event];
  if (!bucket || t - bucket.t >= 1000) bucket = rate[event] = { t, n: 0 };
  return ++bucket.n <= (RATE_LIMITS[event] ?? 20);
}

function handle(socket, event, fn) {
  socket.on(event, (...args) => {
    let ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const payload = args[0];
    const reply = (v) => { if (ack) { const a = ack; ack = null; a(v); } };
    if (!allow(socket, event)) { reply({ ok: false, error: 'Too many requests', code: 'rate' }); return; }
    try {
      const r = fn(payload, reply);
      if (r && typeof r.catch === 'function') {
        r.catch((err) => { log(c.red(`${event} failed: ${err?.message || err}`)); reply({ ok: false, error: err?.message || 'Server error' }); });
      }
    } catch (err) {
      log(c.red(`${event} failed: ${err?.message || err}`));
      reply({ ok: false, error: 'Server error' });
    }
  });
}

function setupSockets(io) {
  io.on('connection', (socket) => {
    socket.data.role = null;
    socket.data.room = null;
    socket.data.slot = null;

    // ---- TV ----

    handle(socket, 'display:create', async (payload, reply) => {
      if (socket.data.role === 'remote') { reply({ ok: false, error: 'This connection is a remote' }); return; }
      let room = displayRoom(socket);
      let reclaimed = false;
      const wanted = normalizeRoomCode(isObj(payload) ? payload.room : null);
      if (!room || (wanted && wanted !== room.code)) {
        if (room) { room.display = null; closeRoom(room, 'abandoned'); }
        room = null;
        if (wanted) {
          const existing = rooms.get(wanted);
          const key = isObj(payload) && typeof payload.key === 'string' ? payload.key : '';
          if (!existing) {
            if (rooms.size < MAX_ROOMS) { room = createRoom(wanted); reclaimed = true; }
          } else if (key && key === existing.key) {
            room = existing;
            reclaimed = true;
          }
        }
        if (!room) {
          if (rooms.size >= MAX_ROOMS) evictVacantRoom();
          if (rooms.size >= MAX_ROOMS || roomsOf(socket) >= MAX_ROOMS_PER_ADDRESS) { reply({ ok: false, error: 'Server is full' }); return; }
          room = createRoom(generateCode());
        }
        if (reclaimed && !room.display && room.slots.every((x) => !x)) restoreSeats(room, payload);
        attachDisplay(room, socket);
        log(`${c.cyan(`[${room.code}]`)} TV connected${reclaimed ? ' (reclaimed)' : ''}`);
      }
      applyPhase(room, payload);
      const info = await roomInfo(room);
      if (!socket.connected || room.display !== socket) return;
      reply({ ok: true, ...info, key: room.key, reclaimed, players: playersOf(room) });
    });

    handle(socket, 'display:state', (payload) => {
      const room = displayRoom(socket);
      if (!room || !isObj(payload)) return;
      const slot = Number(payload.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PLAYERS) return;
      const state = plainJson(payload.state);
      if (!state) return;
      room.lastState[slot] = state;
      room.slots[slot]?.socket?.emit('state', state);
    });

    handle(socket, 'display:event', (payload) => {
      const room = displayRoom(socket);
      if (!room || !isObj(payload)) return;
      const ev = plainJson(payload.event);
      if (!ev || typeof ev.type !== 'string') return;
      const targets = payload.slot === 'all' ? room.slots.map((_, i) => i) : [Number(payload.slot)];
      for (const i of targets) if (Number.isInteger(i)) room.slots[i]?.socket?.emit('event', ev);
    });

    handle(socket, 'display:kick', (payload) => {
      const room = displayRoom(socket);
      const slot = Number(isObj(payload) ? payload.slot : NaN);
      if (!room || !Number.isInteger(slot) || slot < 0 || slot >= MAX_PLAYERS) return;
      releaseSlot(room, slot, 'removed');
    });

    handle(socket, 'display:phase', (payload) => {
      const room = displayRoom(socket);
      if (!room || !isObj(payload)) return;
      applyPhase(room, payload);
    });

    handle(socket, 'display:where', (payload) => {
      const room = displayRoom(socket);
      if (!room || !isObj(payload)) return;
      if (['menu', 'tennis', 'golf'].includes(payload.where)) setWhere(room, payload.where);
    });

    handle(socket, 'display:profile', (payload) => {
      const room = displayRoom(socket);
      if (!room || !isObj(payload)) return;
      const slot = Number(payload.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PLAYERS) return;
      const s = room.slots[slot];
      if (!s) return;
      if (CHARACTER_IDS.includes(payload.character)) s.character = payload.character;
      if (COLOR_SET.has(payload.color) && !room.slots.some((o, i) => o && i !== slot && o.color === payload.color)) s.color = payload.color;
      if (payload.name) s.name = cleanName(payload.name) || s.name;
      if (payload.hand === 'left' || payload.hand === 'right') s.hand = payload.hand;
      if (s.socket) s.socket.emit('profile:updated', { name: s.name, color: s.color, character: s.character, hand: s.hand });
      toDisplay(room, 'player:update', slotInfo(room, slot));
    });

    // The menu picked Bowling or Krishiv Kart: start it and tell the TV where to go.
    // Phones follow once that game's TV page reports its room (see /child above).
    handle(socket, 'display:launch', async (payload, reply) => {
      const room = displayRoom(socket);
      const game = isObj(payload) ? payload.game : null;
      if (!room || !CHILD_GAMES[game]) { reply({ ok: false, error: 'Unknown game' }); return; }
      let ports;
      try {
        ports = await ensureChild(game);
      } catch (err) {
        reply({ ok: false, error: err?.message || 'Could not start the game' });
        return;
      }
      if (rooms.get(room.code) !== room) { reply({ ok: false, error: 'Room closed' }); return; }
      setWhere(room, game);
      room.childPorts = ports;
      room.childRoom = null;
      room.lastSeen = Date.now();
      room.homeSeq = room.homeSeq || 0;
      log(`${c.cyan(`[${room.code}]`)} launching ${CHILD_GAMES[game].name} (TV → port ${ports.httpPort})`);
      reply({ ok: true, game, httpPort: ports.httpPort, httpsPort: ports.httpsPort, room: room.code, homeSeq: room.homeSeq });
      // If the TV page never reports (no hub-link in that game), send phones to our code after a moment.
      setTimeout(() => { if (room.where === game && !room.childRoom) { room.childRoom = room.code; sendPhonesToChild(room); } }, 6000);
    });

    // ---- phone remote ----

    handle(socket, 'remote:join', (payload, reply) => {
      if (socket.data.role === 'display') { reply({ ok: false, error: 'This connection is the TV', code: 'role' }); return; }
      const code = normalizeRoomCode(isObj(payload) ? payload.room : null);
      if (!code) { reply({ ok: false, error: 'That room code is not valid.', code: 'bad_code' }); return; }
      const room = rooms.get(code);
      if (!room) { reply({ ok: false, error: `Room ${code} is not open. Check the code on the TV.`, code: 'no_room' }); return; }
      const clientId = sanitizeClientId(isObj(payload) ? payload.clientId : null) || `s_${socket.id.replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 48);

      const prev = remoteSlot(socket);
      if (prev && (prev.room !== room || prev.room.slots[prev.slot]?.clientId !== clientId)) {
        prev.room.slots[prev.slot].socket = null;
        toDisplay(prev.room, 'player:leave', { slot: prev.slot });
      }

      const pick = pickSlot(room, clientId);
      if (!pick) { reply({ ok: false, error: 'This game already has 4 players.', code: 'full' }); return; }
      const { slot } = pick;
      if (pick.replaced) releaseSlot(room, slot, 'replaced');
      let s = room.slots[slot];
      const old = s?.socket;
      if (old && old !== socket) {
        old.data.room = null;
        old.data.slot = null;
        old.emit('kicked', { reason: 'reconnected' });
      }
      const wantedName = cleanName(isObj(payload) ? payload.name : '');
      const wantedColor = isObj(payload) && COLOR_SET.has(payload.color) ? payload.color : null;
      const wantedChar = isObj(payload) && CHARACTER_IDS.includes(payload.character) ? payload.character : null;
      if (!s) {
        s = room.slots[slot] = {
          clientId,
          seat: seatOf(clientId, code),
          socket,
          name: wantedName || `Player ${slot + 1}`,
          color: freeColor(room, slot),
          hand: isObj(payload) && payload.hand === 'left' ? 'left' : 'right',
          character: wantedChar || defaultCharacterFor(slot),
        };
        if (wantedColor && !room.slots.some((o, i) => o && i !== slot && o.color === wantedColor)) s.color = wantedColor;
      } else {
        s.socket = socket;
        if (!s.clientId) s.clientId = clientId;
        if (wantedChar) s.character = wantedChar;
        if (wantedName) s.name = wantedName;
        if (wantedColor && !room.slots.some((o, i) => o && i !== slot && o.color === wantedColor)) s.color = wantedColor;
        if (isObj(payload) && (payload.hand === 'left' || payload.hand === 'right')) s.hand = payload.hand;
      }
      socket.data.role = 'remote';
      socket.data.room = code;
      socket.data.slot = slot;
      log(`${c.cyan(`[${code}]`)} P${slot + 1} ${s.name} (${s.character}) ${pick.reclaimed ? 'reconnected' : 'joined'} ${c.gray(`(${socket.handshake.address})`)}`);

      reply({ ok: true, room: code, slot, name: s.name, color: s.color, hand: s.hand, character: s.character, displayConnected: !!room.display, where: room.where });
      toDisplay(room, 'player:join', { ...slotInfo(room, slot), rejoin: pick.reclaimed });
      if (room.lastState[slot] && !CHILD_GAMES[room.where]) socket.emit('state', room.lastState[slot]);
      if (!room.display) socket.emit('display:gone', { where: room.where });
      // The TV is in Bowling / Kart: this phone should be there too.
      if (CHILD_GAMES[room.where] && room.childRoom) {
        const url = childPhoneUrl(room, slot);
        if (url) socket.emit('hub:goto', { game: room.where, url });
      }
    });

    handle(socket, 'remote:profile', (payload, reply) => {
      const at = remoteSlot(socket);
      if (!at || !isObj(payload)) { reply({ ok: false }); return; }
      const s = at.room.slots[at.slot];
      const name = cleanName(payload.name);
      if (name) s.name = name;
      if (COLOR_SET.has(payload.color)) {
        const taken = at.room.slots.some((o, i) => o && i !== at.slot && o.color === payload.color);
        if (!taken) s.color = payload.color;
      }
      if (payload.hand === 'left' || payload.hand === 'right') s.hand = payload.hand;
      if (CHARACTER_IDS.includes(payload.character)) s.character = payload.character;
      reply({ ok: true, name: s.name, color: s.color, hand: s.hand, character: s.character });
      toDisplay(at.room, 'player:update', slotInfo(at.room, at.slot));
    });

    // Not registered through handle(): streaming samples over the limit are
    // dropped, but swings / buttons / menu actions always go through. A swing
    // carries an ack so the phone can retry it (same id) over a flaky link.
    socket.on('remote:input', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const at = remoteSlot(socket);
        if (!at || !at.room.display) { reply({ ok: false, error: 'not connected' }); return; }
        const inp = sanitizeInput(payload);
        if (!inp) { reply({ ok: false, error: 'bad input' }); return; }
        if (!allow(socket, `remote:input:${inp.t}`)) { reply({ ok: false, error: 'Too many requests', code: 'rate' }); return; }
        reply({ ok: true });
        if (inp.t === 'gclub') at.room.display.volatile.emit('remote:input', { slot: at.slot, ...inp });
        else at.room.display.emit('remote:input', { slot: at.slot, ...inp });
      } catch (err) {
        log(c.red(`remote:input failed: ${err?.message || err}`));
      }
    });

    handle(socket, 'net:ping', (payload, reply) => reply({ t: Date.now() }));

    socket.on('disconnect', () => {
      const code = socket.data.room;
      const room = code ? rooms.get(code) : null;
      if (!room) return;
      if (room.display === socket) { displayGone(room); return; }
      const at = remoteSlot(socket);
      if (at) {
        at.room.slots[at.slot].socket = null;
        toDisplay(at.room, 'player:leave', { slot: at.slot });
        if (!CHILD_GAMES[at.room.where]) log(`${c.cyan(`[${at.room.code}]`)} P${at.slot + 1} disconnected (slot kept)`);
      }
    });
  });
}

// ---------------------------------------------------------------- startup

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); err.label = label; err.port = port; reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

async function checkLoopback(port, secure) {
  for (const host of ['127.0.0.1', '::1']) {
    if ((await probeLoopback(host, port, secure)) === 'other') return host;
  }
  return null;
}

function probeLoopback(host, port, secure) {
  return new Promise((resolve) => {
    const mod = secure ? https : http;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = mod.get({ hostname: host, port, path: '/api/info', agent: false, rejectUnauthorized: false, timeout: 2000 }, (res) => {
      res.resume();
      finish(res.headers[INSTANCE_HEADER.toLowerCase()] === INSTANCE ? 'us' : 'other');
    });
    req.on('timeout', () => { finish('none'); req.destroy(); });
    req.on('error', (err) => {
      finish(/^(ECONNREFUSED|EADDRNOTAVAIL|ENETUNREACH|EHOSTUNREACH|EAFNOSUPPORT|ENOTFOUND)$/.test(err.code || '') ? 'none' : 'other');
    });
  });
}

function explainPortInUse(port, label, where = '') {
  console.error('');
  console.error(c.red(`  ✖ Port ${port} (${label}) is already in use${where ? ` on ${where}` : ''}.`));
  console.error(`    The menu may already be running — try ${c.cyan(`http://localhost:${HTTP_PORT}`)}.`);
  console.error('    Bowling and Krishiv Kart use the same ports when started on their own: stop them');
  console.error('    (this menu starts them itself), or pick other ports:');
  console.error(`      ${c.bold(`PORT=${HTTP_PORT + 10} HTTPS_PORT=${HTTPS_PORT + 10} npm start`)}`);
  console.error('');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* ignore */ }
}

function printBanner(seededFrom) {
  const display = `http://localhost:${HTTP_PORT}`;
  const line = c.yellow('━'.repeat(66));
  const ipList = network.interfaces.length
    ? network.interfaces.map((e) => `${e.ip}${c.gray(` (${e.name})`)}`).join(', ')
    : c.red('none found — connect this computer to Wi-Fi');
  const games = gamesInfo();
  const gameLine = (id, label) => (games[id].installed ? c.green(`✔ ${label}`) : c.red(`✖ ${label} (${games[id].why})`));
  console.log('');
  console.log(line);
  console.log(`  ${c.bold(c.yellow(GAME_TITLE))}  ${c.gray('· Tennis · Golf · Bowling · Krishiv Kart — phones are the controllers')}`);
  console.log(line);
  console.log(`  ${c.bold('TV / games')}     ${c.cyan(display)}`);
  console.log(`  ${c.bold('Phones')}         ${c.cyan(`${phoneBaseUrl()}?room=XXXX`)}  ${c.gray('(pick a game on the TV, then scan its QR code)')}`);
  console.log(`  ${c.bold('LAN IPs')}        ${ipList}`);
  if (network.override) console.log(`  ${c.bold('PAD_HOST')}       ${network.override}`);
  console.log(`  ${c.bold('Games')}          ${c.green('✔ Tennis')}  ${c.green('✔ Golf')}  ${gameLine('bowling', 'Bowling')}  ${gameLine('kart', 'Krishiv Kart')}`);
  console.log('');
  if (httpsReady) {
    if (seededFrom) console.log(`  ${c.green('Using the certificate from')} ${seededFrom} ${c.gray('— phones that trusted it won’t be asked again.')}`);
    console.log(`  ${c.yellow('Tip:')} phones warn about the self-signed certificate once — that's expected.`);
    console.log(`       iPhone: ${c.bold('Show Details → visit this website')}   Android: ${c.bold('Advanced → Proceed')}`);
  } else {
    console.log(`  ${c.red('HTTPS is unavailable')} — phones can only use touch controls (motion needs HTTPS).`);
  }
  console.log('       Phones and this computer must be on the same Wi-Fi. If macOS asks, allow incoming connections for node.');
  console.log(line);
  console.log('');
}

async function main() {
  let tls = null;
  let seededFrom = null;
  try {
    seededFrom = seedCertificate(network);
    tls = await ensureCertificate(network);
    if (tls.regenerated) { seededFrom = null; log(`generated a new HTTPS certificate for ${tls.names.join(', ')}`); }
  } catch (err) {
    log(c.red(`could not create an HTTPS certificate (${err?.message || err}); continuing with HTTP only`));
  }

  const app = buildApp();
  const httpServer = http.createServer(app);
  const httpsServer = tls ? https.createServer({ key: tls.key, cert: tls.cert }, app) : null;

  // Short heartbeat so a locked phone is noticed within a few seconds.
  const io = new Server(httpServer, {
    pingInterval: 4000, pingTimeout: 4000, maxHttpBufferSize: 64 * 1024,
    allowRequest: (req, cb) => cb(null, originAllowed(req.headers.origin)),
  });
  const httpEngine = io.engine;
  if (httpsServer) io.attach(httpsServer);
  setupSockets(io);

  try {
    await listen(httpServer, HTTP_PORT, 'HTTP');
    if (httpsServer) { await listen(httpsServer, HTTPS_PORT, 'HTTPS'); httpsReady = true; }
  } catch (err) {
    if (err.code === 'EADDRINUSE') explainPortInUse(err.port, err.label);
    else if (err.code === 'EACCES') console.error(c.red(`  ✖ No permission to listen on port ${err.port}. Use a port above 1024.`));
    else console.error(c.red(`  ✖ Could not start the ${err.label} server: ${err.message}`));
    process.exit(1);
  }
  for (const [port, label, secure] of [[HTTP_PORT, 'HTTP', false], ...(httpsServer ? [[HTTPS_PORT, 'HTTPS', true]] : [])]) {
    const clash = await checkLoopback(port, secure);
    if (clash) {
      explainPortInUse(port, label, `${clash} (localhost)`);
      process.exit(1);
    }
  }
  httpsReady = !!httpsServer;
  for (const s of [httpServer, httpsServer]) s?.on('error', (err) => log(c.red(`server error: ${err.message}`)));
  for (const room of rooms.values()) if (room.display) room.display.emit('display:info', await roomInfo(room));

  printBanner(seededFrom);
  if (!NO_OPEN) openBrowser(`http://localhost:${HTTP_PORT}`);

  // Follow network changes (Wi-Fi switch, DHCP renew): new phone URL / QR for every TV.
  let checking = false;
  setInterval(async () => {
    if (checking) return;
    const next = getNetworkInfo();
    if (networkKey(next) === networkKey(network)) return;
    checking = true;
    try {
      network = next;
      qrCache.clear();
      log(`network changed — LAN IPs: ${network.lanIps.join(', ') || 'none'}; phone URL is now ${phoneBaseUrl()}`);
      if (httpsServer) {
        try {
          const creds = await ensureCertificate(network);
          if (creds.regenerated) {
            httpsServer.setSecureContext({ key: creds.key, cert: creds.cert });
            log('HTTPS certificate regenerated — phones must reload and accept it again');
          }
        } catch (err) {
          log(c.red(`certificate update failed: ${err?.message || err}`));
        }
      }
      for (const room of rooms.values()) if (room.display) room.display.emit('display:info', await roomInfo(room));
    } catch (err) {
      log(c.red(`network update failed: ${err?.message || err}`));
    } finally {
      checking = false;
    }
  }, NETWORK_POLL_MS).unref();

  let closing = false;
  const shutdown = () => {
    if (closing) process.exit(0);
    closing = true;
    shuttingDown = true;
    log('shutting down…');
    stopChildren();
    try { httpEngine.close(); } catch { /* ignore */ }
    io.close();
    httpServer.close();
    httpServer.closeAllConnections?.();
    httpsServer?.close();
    httpsServer?.closeAllConnections?.();
    setTimeout(() => process.exit(0), 400).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', stopChildren);
}

main().catch((err) => {
  console.error(c.red(`  ✖ ${err?.stack || err}`));
  stopChildren();
  process.exit(1);
});

void GAME_IDS;
