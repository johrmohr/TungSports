// KRISHIV KART game server (SPEC §11, §14.7, §15).
//
//   npm start            (= node server.js)
//
// * HTTP  on PORT       (default 3000): the desktop game at http://localhost:3000
// * HTTPS on HTTPS_PORT (default 3443): the phone controller. Motion sensors need
//   a secure context, so we generate a self-signed certificate on first start
//   (SAN = localhost, 127.0.0.1 and every LAN IPv4), cache it in .certs/ and
//   only replace it when it no longer covers the host in the phone URL (a
//   phone's certificate exception is for that one certificate).
// * ONE Socket.IO server is attached to both, so a desktop on http and phones
//   on https share the same rooms.
//
// Environment:
//   PORT, HTTPS_PORT   listening ports
//   NO_OPEN=1          do not open the desktop URL in the default browser
//   PAD_HOST=<ip|name> force the host used in the phone URL / QR code
//   ROOM_GRACE_MS      how long a room survives without its desktop (default 60000)
//   SLOT_RESERVE_MS    how long a dropped phone's player slot stays reserved for
//                      it (default 300000 = 5 min; tests use less)
//   KRISHIVKART_CERT_DIR  where the certificate is cached (default .certs/; tests).
//                      The old name TOOTKART_CERT_DIR still works.
//
// Rooms: one desktop "host" + up to 4 phones, one per player slot P1–P4. A
// phone takes the lowest free slot; slots never renumber. A phone that drops
// keeps its slot reserved (by its stable padId) for SLOT_RESERVE_MS or until
// the desktop releases it (host:release); a 5th phone is told the game is
// full. The player host is the lowest connected slot. Every pad:input /
// pad:menu reaches the desktop tagged with the sender's slot; the shared
// host:state goes to every phone, host:padState only to its slot (both cached
// for phones that (re)join). If the desktop disconnects, the room is kept for
// ROOM_GRACE_MS so it can reclaim it (same code, same phones) after a reload
// or a network blip. Every client payload is validated and clamped before it
// is relayed.

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
import { NET, ITEM_IDS, ITEM_INFO, GAME_TITLE } from './public/js/config.js';
import { MAX_PLAYERS, ENGINE_CLASSES, DEFAULT_CC, STAT_KEYS, slotInfo } from './public/js/parts.js';
import { ROOM_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } from './public/js/net.js';

// ---------------------------------------------------------------- settings

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const CERT_DIR_ENV = process.env.KRISHIVKART_CERT_DIR || process.env.TOOTKART_CERT_DIR;
const CERT_DIR = CERT_DIR_ENV ? path.resolve(CERT_DIR_ENV) : path.join(ROOT, '.certs');
// Bump to force regeneration after changing cert options. (Not bumped for the
// KRISHIV KART rename: the subject name is cosmetic, and a new certificate
// would make every phone accept the warning again. New certs get the new name.)
const CERT_VERSION = 2;
const CERT_MAX_IPS = 24;                  // SAN cap when old + new addresses are merged
const DAY_MS = 24 * 3600 * 1000;
// Answers /api/info in a response header, so startup can tell whether
// localhost really reaches this process (see checkLoopback).
const INSTANCE = crypto.randomBytes(9).toString('base64url');
const INSTANCE_HEADER = 'X-Krishiv-Kart-Instance';
const TITLE = GAME_TITLE || 'KRISHIV KART';

const HTTP_PORT = envPort('PORT', NET.httpPort);
const HTTPS_PORT = envPort('HTTPS_PORT', NET.httpsPort);
const NO_OPEN = /^(1|true|yes)$/i.test(process.env.NO_OPEN || '');
const ROOM_GRACE_MS = Math.max(1000, Number(process.env.ROOM_GRACE_MS) || 60_000);
const SLOT_RESERVE_MS = Math.max(500, Number(process.env.SLOT_RESERVE_MS) || 5 * 60_000);
const MAX_SLOTS = MAX_PLAYERS;          // player slots (phones) per room
const MAX_ROOMS = 500;
const NETWORK_POLL_MS = 10_000;

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
  bold: paint('1'), dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33'),
  blue: paint('34'), magenta: paint('35'), cyan: paint('36'), gray: paint('90'),
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

// Name of the interface carrying the default route (the network this computer
// is actually using), or null. Cached per interface set: it spawns a process.
let defaultRouteCache = { key: '', name: null };
function defaultRouteInterface(key) {
  if (defaultRouteCache.key === key) return defaultRouteCache.name;
  let name = null;
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    if (process.platform === 'darwin') name = /interface:\s*(\S+)/.exec(run('route', ['-n', 'get', 'default']))?.[1] || null;
    else if (process.platform === 'linux') name = /\bdev\s+(\S+)/.exec(run('ip', ['route', 'show', 'default']))?.[1] || null;
  } catch {
    // no default route / tool missing: fall back to name heuristics
  }
  defaultRouteCache = { key, name };
  return name;
}

// Higher score = more likely the address a phone on the same Wi-Fi can reach.
function scoreAddress(name, ip, routeIf) {
  let score = 0;
  if (routeIf && name === routeIf) score += 50;                 // the interface we are online through
  if (ip.startsWith('169.254.')) score -= 1000;                 // link-local (no DHCP lease)
  if (isPrivateIPv4(ip)) {
    score += 100;
    if (ip.startsWith('192.168.')) score += 6;
    else if (ip.startsWith('10.')) score += 4;
    else score += 2;
  }
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) score -= 40;   // CGNAT / Tailscale
  if (/^(en0|wlan0|wi-?fi)$/i.test(name)) score += 30;          // primary Wi-Fi (macOS / Linux / Windows)
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

// Names a certificate made right now should cover: every LAN IPv4, this
// machine's hostname(s) and PAD_HOST.
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

// { ips, hosts } from X509Certificate.subjectAltName
// ("DNS:localhost, DNS:Mac.lan, IP Address:127.0.0.1, IP Address:192.168.1.20").
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

// Returns { key, cert, regenerated }. The cached certificate is kept while it
// is valid for the host the phone URL uses (the primary LAN IP or PAD_HOST),
// is not about to expire and was made with the current options. A phone's
// "visit this website" exception holds for that exact certificate, so a VPN,
// VM bridge, hotspot or hostname change must not replace it. When it has to
// be replaced, the new one keeps every address the old one had, so moving back
// to an earlier network does not need yet another certificate.
async function ensureCertificate(network) {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const metaFile = path.join(CERT_DIR, 'meta.json');
  let previous = { ips: [], hosts: [] };

  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const key = fs.readFileSync(keyFile, 'utf8');
    const cert = fs.readFileSync(certFile, 'utf8');
    const x509 = new crypto.X509Certificate(cert);   // throws if corrupt
    if (!x509.checkPrivateKey(crypto.createPrivateKey(key))) throw new Error('key does not match');
    previous = parseSan(x509.subjectAltName);
    const fresh = Date.parse(x509.validTo) - Date.now() > 7 * DAY_MS;
    // (A PAD_HOST no certificate can name, e.g. an IPv6 literal, must not force a new one on every start.)
    const needed = IPV4_RE.test(network.primary) || HOSTNAME_RE.test(network.primary) ? network.primary : 'localhost';
    if (meta.version === CERT_VERSION && fresh && certCovers(previous, needed)) return { key, cert, regenerated: false };
  } catch {
    // missing or corrupt cache → regenerate below
  }

  const want = certNames(network);
  const ips = union(want.ips, previous.ips.filter((ip) => ip !== '127.0.0.1')).slice(0, CERT_MAX_IPS);
  const extraHosts = union(want.hosts, previous.hosts.filter((h) => h !== 'localhost')).slice(0, 16);
  const ident = { ips, hosts: extraHosts };
  const notBefore = new Date(Date.now() - DAY_MS);              // slack for phone clock skew
  const notAfter = new Date(notBefore.getTime() + 730 * DAY_MS); // < 825 days: iOS rejects longer-lived TLS certs
  const altNames = [
    { type: 2, value: 'localhost' },
    ...extraHosts.map((value) => ({ type: 2, value })),
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: `${TITLE} local server` }, { name: 'organizationName', value: TITLE }],
    {
      keyType: 'rsa',
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: notBefore,
      notAfterDate: notAfter,
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    },
  );
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(metaFile, JSON.stringify({
    version: CERT_VERSION, ...ident, created: new Date().toISOString(),
    notAfter: notAfter.toISOString(), fingerprint: pems.fingerprint,
  }, null, 2));
  return { key: pems.private, cert: pems.cert, regenerated: true, names: ['localhost', ...extraHosts, '127.0.0.1', ...ips] };
}

// ---------------------------------------------------------------- payload sanitizers (SPEC §14.7)

const SCREENS = new Set(['lobby', 'select', 'track', 'loading', 'race', 'results', 'standings', 'podium', 'paused']);
const STEPS = new Set(['char', 'body', 'wheels', 'ready', 'done']);
const RACE_STATES = new Set(['intro', 'countdown', 'racing', 'finished']);
const MODES = new Set(['gp', 'vs']);
const CLASSES = new Set(ENGINE_CLASSES.map((e) => e.id));
const WEIGHT_CLASS_IDS = new Set(['light', 'medium', 'heavy']);
// Every item the desktop can hand out: config's ITEM_IDS / ITEM_INFO (the v5
// plugin items included, SPEC §16.2) plus the v4 set by id (SPEC §15.2), so a
// phone shows them even if config lags behind. A padState item must look like
// an item id (ITEM_ID_RE) and be one of these.
const V4_ITEM_IDS = ['triple_banana', 'triple_bouncer', 'triple_rocket', 'capo', 'golden_toot', 'meatball_bomb', 'espresso', 'accordion', 'beer_rocket'];
const ITEM_ID_RE = /^[a-z0-9_]{1,24}$/;
const ITEMS = new Set([...ITEM_IDS, ...Object.keys(ITEM_INFO || {}), ...V4_ITEM_IDS].filter((id) => ITEM_ID_RE.test(id)));
const itemId = (v) => (typeof v === 'string' && ITEM_ID_RE.test(v) && ITEMS.has(v) ? v : null);
const MAX_SEQ = 2 ** 31 - 1;
const ID_RE = /^[a-z0-9_-]{1,32}$/;            // racer / part / track ids (SPEC §14.7)
// Portrait paths: same-origin, a few path segments, an image extension, no "..".
const IMG_RE = /^\/?(?:[A-Za-z0-9_-]+\/){0,4}[A-Za-z0-9_-]+\.(?:png|webp|jpe?g)$/;

// pad:menu actions. Host-only ones are enforced by the desktop (it knows the
// host from `slots`); the server only whitelists and cleans them.
const HOST_ACTIONS = ['mode', 'cc', 'items', 'start', 'track', 'cup', 'go', 'next', 'quit', 'restart'];
const PLAYER_ACTIONS = ['char', 'body', 'wheels', 'back', 'ready', 'assist', 'pause', 'resume'];
const MENU_ACTIONS = new Set([...HOST_ACTIONS, ...PLAYER_ACTIONS]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function num(v, lo, hi, def = 0) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? (n < lo ? lo : n > hi ? hi : n) : def;
}
const int = (v, lo, hi, def = 0) => Math.round(num(v, lo, hi, def));
const bit = (v) => (v === true || num(v, 0, 1, 0) >= 0.5 ? 1 : 0);
// A strict boolean (true / false, or 1 / 0), else null.
const flag = (v) => (v === true || v === 1 ? true : v === false || v === 0 ? false : null);
const str = (v, max, def = '') => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : def);
const cssColor = (v, def = '#8890b5') => (typeof v === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : def);
// A CSS color, or a THREE-style 0xRRGGBB number (characters.js keeps those) as '#rrggbb'.
const anyColor = (v, def) => (Number.isInteger(v) && v >= 0 && v <= 0xffffff ? `#${v.toString(16).padStart(6, '0')}` : cssColor(v, def));
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const idOr = (v, def) => (isId(v) ? v : def);
// A player slot number 1..MAX_SLOTS, or null.
const slotNum = (v) => { const n = num(v, -1, 99, -1); return Number.isInteger(n) && n >= 1 && n <= MAX_SLOTS ? n : null; };
// Up to `max` sanitized entries of an array: invalid ones are dropped, and so
// are repeats of an entry's `key` (slot / id) when one is given. At most
// 4 × max entries are looked at, so junk cannot make this loop long.
function list(v, max, fn, key = null) {
  const out = [];
  if (!Array.isArray(v)) return out;
  const seen = key ? new Set() : null;
  const n = Math.min(v.length, max * 4);
  for (let i = 0; i < n && out.length < max; i++) {
    const row = fn(v[i]);
    if (!row) continue;
    if (seen) {
      const k = row[key];
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(row);
  }
  return out;
}

// Copies up to `max` extra primitive fields (forward compatibility for host
// state additions, e.g. `pausedBy`) with bounded sizes.
function copyExtras(src, dst, known, max = 12) {
  let n = 0;
  for (const k of Object.keys(src)) {
    if (n >= max) break;
    if (known.has(k) || k.length > 32 || !/^[a-zA-Z_][\w]*$/.test(k)) continue;
    const v = src[k];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) dst[k] = v;
    else if (typeof v === 'string') dst[k] = v.slice(0, 120);
    else continue;
    n++;
  }
}

// { speed, accel, handling, weight } clamped to lo..hi (0.5-star steps are kept).
function statBlock(v, lo, hi, def) {
  const src = isObj(v) ? v : {};
  const out = {};
  for (const k of STAT_KEYS) out[k] = Math.round(num(src[k], lo, hi, def) * 100) / 100;
  return out;
}

function sanitizeInput(p, slot) {
  if (!isObj(p)) return null;
  return {
    slot,
    s: Math.round(num(p.s, -1, 1) * 10000) / 10000,
    g: bit(p.g),
    b: bit(p.b),
    d: bit(p.d),
    i: int(p.i, 0, MAX_SEQ),
    p: int(p.p, 0, MAX_SEQ),
    t: num(p.t, 0, 1e15),
  };
}

// Whitelisted pad:menu actions with only their own (validated) fields. The
// relay adds the sender's slot.
function sanitizeMenu(p) {
  if (!isObj(p) || typeof p.action !== 'string' || !MENU_ACTIONS.has(p.action)) return null;
  const out = { action: p.action };
  switch (p.action) {
    case 'mode':
      if (!MODES.has(p.value)) return null;
      out.value = p.value;
      break;
    case 'cc': {
      const v = typeof p.value === 'string' && p.value.trim() !== '' ? Number(p.value) : p.value;
      if (!CLASSES.has(v)) return null;
      out.value = v;
      break;
    }
    case 'items':
    case 'ready':
    case 'assist': {
      const v = flag(p.value);
      if (v === null) return null;
      out.value = v;
      break;
    }
    case 'track':                        // a track id or 'random'
      if (!isId(p.value)) return null;
      out.value = p.value;
      break;
    case 'cup': {                        // a Grand Prix cup id (SPEC §15.3): { id } (value accepted too)
      const id = isId(p.id) ? p.id : isId(p.value) ? p.value : null;
      if (!id) return null;
      out.id = id;
      out.value = id;
      break;
    }
    case 'char':
    case 'body':
    case 'wheels':
      if (!isId(p.id)) return null;
      out.id = p.id;
      break;
    case 'pause':                        // reason 'hidden': the phone's page went to the background
      if (p.reason === 'hidden') out.reason = 'hidden';
      break;
    default:                             // start, go, next, quit, restart, back, resume
      break;
  }
  return out;
}

// ---- host:state (shared by every phone)

const SHARED_KEYS = new Set(['screen', 'mode', 'cc', 'items', 'host', 'raceNo', 'races', 'track', 'tracks', 'cup', 'cups',
  'players', 'characters', 'bodies', 'wheels', 'results', 'standings']);
const PLAYER_KEYS = new Set(['slot', 'color', 'connected', 'ready', 'char', 'body', 'wheels', 'assist']);
const ROW_KEYS = new Set(['place', 'name', 'cssColor', 'time', 'points', 'slot', 'finished']);
const MAX_CHARACTERS = 40;               // 12 roster racers + custom ones (SPEC §14.9)
const MAX_PARTS = 16;
const MAX_TRACKS = 16;
const MAX_CUPS = 8;
const MAX_ROWS = 16;

function trackRef(o) {
  if (!isObj(o) || !isId(o.id)) return null;
  const out = { id: o.id, name: str(o.name, 40) || o.id };
  if (isId(o.theme)) out.theme = o.theme;
  return out;
}

function cupInfo(o) {
  if (!isObj(o)) return null;
  const out = {
    name: str(o.name, 40),
    // track ids (or { id, name } refs)
    tracks: list(o.tracks, MAX_TRACKS, (t) => (isId(t) ? t : trackRef(t))),
  };
  if (isId(o.id)) out.id = o.id;
  return out;
}
// A `cups` list entry: like cupInfo, but it needs an id (the host picks cups by id).
function cupRow(o) {
  const c = cupInfo(o);
  return c && c.id ? c : null;
}

function playerRow(o) {
  if (!isObj(o)) return null;
  const slot = slotNum(o.slot);
  if (!slot) return null;
  const out = {
    slot,
    color: cssColor(o.color, slotInfo(slot).css),
    connected: o.connected === true,
    ready: o.ready === true,
    char: idOr(o.char, null),
    body: idOr(o.body, null),
    wheels: idOr(o.wheels, null),
    assist: o.assist === true,
  };
  copyExtras(o, out, PLAYER_KEYS, 6);   // e.g. name, step
  return out;
}

function characterRow(o) {
  if (!isObj(o) || !isId(o.id)) return null;
  const name = str(o.name, 32) || o.id;
  const out = {
    id: o.id,
    name,
    shortName: str(o.shortName, 20) || name,
    weightClass: WEIGHT_CLASS_IDS.has(o.weightClass) ? o.weightClass : 'medium',
    cssColor: anyColor(o.cssColor, '#8890b5'),
    accent: anyColor(o.accent, anyColor(o.cssColor, '#8890b5')),
    ratings: statBlock(o.ratings, 1, 5, 3),
    img: typeof o.img === 'string' && o.img.length <= 96 && IMG_RE.test(o.img) ? o.img : null,
    custom: o.custom === true,
  };
  // Optional extras the phone shows on the character screen (SPEC §14.8).
  if (typeof o.catchphrase === 'string') out.catchphrase = o.catchphrase.slice(0, 100);
  if (typeof o.tagline === 'string') out.tagline = o.tagline.slice(0, 100);
  if (typeof o.group === 'string' && /^[A-Z][0-9]$/.test(o.group)) out.group = o.group;
  if (o.lead === true) out.lead = true;
  return out;
}

function partRow(o, wheel) {
  if (!isObj(o) || !isId(o.id)) return null;
  const out = { id: o.id, label: str(o.label, 24) || o.id, desc: str(o.desc, 80), mods: statBlock(o.mods, -5, 5, 0) };
  if (wheel || typeof o.offroad === 'number') out.offroad = Math.round(num(o.offroad, -1, 1, 0) * 1000) / 1000;
  return out;
}

function resultRow(o) {
  if (!isObj(o)) return null;
  const time = num(o.time, 0, 360000, NaN);
  const out = {
    place: int(o.place, 0, MAX_ROWS),
    name: str(o.name, 32),
    cssColor: cssColor(o.cssColor),
    time: Number.isFinite(time) ? Math.round(time * 1000) / 1000 : null,
    points: int(o.points, 0, 9999),
    slot: slotNum(o.slot),
    finished: o.finished !== false,
  };
  copyExtras(o, out, ROW_KEYS, 4);      // e.g. total, charId
  return out;
}

function standingRow(o) {
  if (!isObj(o)) return null;
  const out = { place: int(o.place, 0, MAX_ROWS), name: str(o.name, 32), cssColor: cssColor(o.cssColor), points: int(o.points, 0, 9999), slot: slotNum(o.slot) };
  copyExtras(o, out, ROW_KEYS, 4);
  return out;
}

function sanitizeShared(p) {
  if (!isObj(p)) return null;
  const cc = Number(p.cc);
  const out = {
    screen: SCREENS.has(p.screen) ? p.screen : 'loading',
    mode: MODES.has(p.mode) ? p.mode : 'gp',
    cc: CLASSES.has(cc) ? cc : DEFAULT_CC,
    items: p.items !== false,
    host: slotNum(p.host),
    raceNo: int(p.raceNo, 0, 99),
    races: int(p.races, 0, 99),
    track: trackRef(p.track),
    tracks: list(p.tracks, MAX_TRACKS, trackRef, 'id'),
    cup: cupInfo(p.cup),
    players: list(p.players, MAX_SLOTS, playerRow, 'slot'),
    characters: list(p.characters, MAX_CHARACTERS, characterRow, 'id'),
    bodies: list(p.bodies, MAX_PARTS, (o) => partRow(o, false), 'id'),
    wheels: list(p.wheels, MAX_PARTS, (o) => partRow(o, true), 'id'),
    results: Array.isArray(p.results) ? list(p.results, MAX_ROWS, resultRow) : null,
    standings: Array.isArray(p.standings) ? list(p.standings, MAX_ROWS, standingRow) : null,
  };
  if (Array.isArray(p.cups)) out.cups = list(p.cups, MAX_CUPS, cupRow, 'id');   // GP cups (SPEC §15.3)
  copyExtras(p, out, SHARED_KEYS);
  return out;
}

// ---- host:padState (one phone's personal view)

const PAD_KEYS = new Set(['slot', 'color', 'isHost', 'step', 'choice', 'ratings', 'race', 'standing']);
const RACE_KEYS = new Set(['state', 'lap', 'laps', 'place', 'racers', 'item', 'itemCount', 'rolling', 'countdown',
  'finished', 'assist', 'assistActive', 'warn', 'capoWarn', 'splash', 'beer']);

function raceInfo(r) {
  const out = {
    state: RACE_STATES.has(r.state) ? r.state : 'racing',
    lap: int(r.lap, 0, 99),
    laps: int(r.laps, 1, 99, 3),
    place: int(r.place, 0, 16),
    racers: int(r.racers, 0, 16, 8),
    item: itemId(r.item),
    itemCount: int(r.itemCount, 0, 9),
    rolling: !!r.rolling,
    countdown: Math.round(num(r.countdown, 0, 60) * 100) / 100,
    finished: !!r.finished,
    assist: r.assist === true,
    assistActive: r.assistActive === true,
  };
  // v4 race alerts (SPEC §15.2): incoming Capo Crusher, espresso on my screen, Beer Rocket running
  if (isId(r.warn)) out.warn = r.warn;
  if (r.capoWarn === true) out.capoWarn = true;
  const splash = r.splash === true ? 1 : num(r.splash, 0, 1, 0);
  if (splash > 0) out.splash = Math.round(splash * 100) / 100;
  if (r.beer === true) out.beer = true;
  copyExtras(r, out, RACE_KEYS);         // e.g. finishClock
  return out;
}

function sanitizePadState(p) {
  if (!isObj(p)) return null;
  const slot = slotNum(p.slot);
  if (!slot) return null;
  const c = isObj(p.choice) ? p.choice : {};
  const out = {
    slot,
    color: cssColor(p.color, slotInfo(slot).css),
    isHost: p.isHost === true,
    step: STEPS.has(p.step) ? p.step : 'char',
    choice: { char: idOr(c.char, null), body: idOr(c.body, null), wheels: idOr(c.wheels, null), assist: c.assist !== false },
    ratings: statBlock(p.ratings, 1, 5, 3),
    race: isObj(p.race) ? raceInfo(p.race) : null,
    standing: isObj(p.standing) ? { place: int(p.standing.place, 0, MAX_ROWS), points: int(p.standing.points, 0, 9999) } : null,
  };
  copyExtras(p, out, PAD_KEYS);
  return out;
}

function sanitizeEvent(p) {
  if (!isObj(p)) return null;
  if (p.type === 'vibrate') {
    const raw = Array.isArray(p.pattern) ? p.pattern : [p.pattern ?? p.ms ?? 40];
    const pattern = raw.slice(0, 16).map((v) => int(v, 0, 1000)).filter((v, i) => i > 0 || v > 0);
    return pattern.length ? { type: 'vibrate', pattern } : null;
  }
  if (p.type === 'toast') {
    const text = str(p.text, 80).trim();
    return text ? { type: 'toast', text } : null;
  }
  return null;
}

const sanitizePadId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(v) ? v : null);

// ---------------------------------------------------------------- rooms

/** @type {Map<string, Room>} */
const rooms = new Map();

// Short blocklist so random codes never spell something rude on the big screen.
// (Only letters from ROOM_ALPHABET can occur, so words with I/L/O are omitted.)
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
    this.key = crypto.randomBytes(12).toString('base64url');   // lets the host reclaim this room
    this.host = null;
    this.state = null;                // last sanitized shared host:state (sent to every pad)
    this.seats = new Array(MAX_SLOTS + 1).fill(null);           // [1..MAX_SLOTS] → Seat | null
    this.hostSlot = null;             // player host last announced to the pads
    this.graceTimer = null;
    this.createdAt = Date.now();
  }
}

// One player slot. While its phone is away the seat stays reserved for that
// phone's padId (SLOT_RESERVE_MS) or until the desktop releases it.
class Seat {
  constructor(room, slot, padId) {
    this.room = room;
    this.slot = slot;
    this.padId = padId;
    this.socket = null;               // the phone's live socket, null while away
    this.padState = null;             // last sanitized host:padState for this slot
    this.lastInput = null;            // last pad:input relayed to the host (edge detection)
    this.reserveTimer = null;
  }
}

const tag = (room) => c.cyan(`[${room.code}]`);
const seatLabel = (seat) => c.bold(slotInfo(seat.slot).label);

function createRoom(code) {
  const room = new Room(code);
  rooms.set(code, room);
  log(`${tag(room)} room opened`);
  return room;
}

function connectedSeats(room) {
  return room.seats.filter((s) => s && s.socket);
}

// The player host: the lowest connected slot (SPEC §14.6), or null.
function lowestConnected(room) {
  for (let n = 1; n <= MAX_SLOTS; n++) if (room.seats[n] && room.seats[n].socket) return n;
  return null;
}

const slotsInfo = (room) => ({ host: lowestConnected(room), connected: connectedSeats(room).map((s) => s.slot) });

// After any seat change: tells the desktop (`slots`) and, when the player host
// changed, every phone (`slot:update`). `joiner` always gets its own update.
function announceSlots(room, joiner = null) {
  const info = slotsInfo(room);
  const changed = info.host !== room.hostSlot;
  room.hostSlot = info.host;
  for (const seat of connectedSeats(room)) {
    if (changed || seat.socket === joiner) {
      seat.socket.emit('slot:update', { slot: seat.slot, host: info.host, color: slotInfo(seat.slot).css });
    }
  }
  if (room.host) room.host.emit('slots', info);
  return info;
}

function attachHost(room, socket) {
  clearTimeout(room.graceTimer);
  room.graceTimer = null;
  const old = room.host;
  if (old && old !== socket) {
    old.data.room = null;
    old.data.role = null;
    old.emit('host:replaced', {});
  }
  const hadHost = !!old;
  room.host = socket;
  socket.data.role = 'host';
  socket.data.room = room.code;
  if (!hadHost) for (const seat of connectedSeats(room)) seat.socket.emit('host:join', {});
}

function hostGone(room) {
  room.host = null;
  for (const seat of connectedSeats(room)) seat.socket.emit('host:leave', {});
  log(`${tag(room)} desktop disconnected — holding the room for ${Math.round(ROOM_GRACE_MS / 1000)} s`);
  clearTimeout(room.graceTimer);
  room.graceTimer = setTimeout(() => closeRoom(room, 'expired'), ROOM_GRACE_MS);
}

function closeRoom(room, reason) {
  if (rooms.get(room.code) !== room || room.host) return;
  clearTimeout(room.graceTimer);
  for (const seat of room.seats) {
    if (!seat) continue;
    clearTimeout(seat.reserveTimer);
    if (seat.socket) {
      seat.socket.emit('room:closed', { reason });
      seat.socket.data.room = null;
      seat.socket.data.slot = null;
    }
  }
  rooms.delete(room.code);
  log(`${tag(room)} room closed (${reason})`);
}

// The room this socket hosts, or null.
function hostRoom(socket) {
  if (socket.data.role !== 'host' || !socket.data.room) return null;
  const room = rooms.get(socket.data.room);
  return room && room.host === socket ? room : null;
}

// The seat this socket is the live phone of, or null.
function padSeat(socket) {
  if (socket.data.role !== 'pad' || !socket.data.room) return null;
  const room = rooms.get(socket.data.room);
  const seat = room && room.seats[socket.data.slot];
  return seat && seat.socket === socket ? seat : null;
}

// Seats a phone: its reserved slot back (same padId), else the lowest free
// slot. Returns the seat, or null when every slot is taken or reserved.
function seatPad(room, socket, padId) {
  let seat = room.seats.find((s) => s && s.padId === padId) || null;
  if (seat) {
    clearTimeout(seat.reserveTimer);
    seat.reserveTimer = null;
    const old = seat.socket;
    if (old && old !== socket) {
      // The same phone reconnected (page reload, network change) while its old
      // socket still looked alive: replace it silently.
      old.data.room = null;
      old.data.slot = null;
      old.emit('pad:kicked', { reason: 'reconnected' });
    }
  } else {
    let n = 1;
    while (n <= MAX_SLOTS && room.seats[n]) n++;
    if (n > MAX_SLOTS) return null;
    seat = room.seats[n] = new Seat(room, n, padId);
  }
  seat.socket = socket;
  seat.lastInput = null;
  socket.data.role = 'pad';
  socket.data.room = room.code;
  socket.data.slot = seat.slot;
  socket.data.padId = padId;
  return seat;
}

// The phone's socket went away: keep its slot reserved for it.
function unseatPad(socket) {
  const seat = padSeat(socket);
  socket.data.room = null;
  socket.data.slot = null;
  clearTimeout(socket.data.inputRate?.timer);
  if (!seat) return;
  const room = seat.room;
  seat.socket = null;
  seat.lastInput = null;
  clearTimeout(seat.reserveTimer);
  seat.reserveTimer = setTimeout(() => expireSeat(seat), SLOT_RESERVE_MS);
  if (room.host) room.host.emit('pad:leave', { slot: seat.slot, padId: seat.padId, reason: 'left' });
  log(`${tag(room)} ${seatLabel(seat)} phone left (slot reserved for ${Math.round(SLOT_RESERVE_MS / 1000)} s)`);
  announceSlots(room);
}

// A reservation ran out: the slot is free for a new phone.
function expireSeat(seat) {
  const room = seat.room;
  if (room.seats[seat.slot] !== seat || seat.socket) return;
  room.seats[seat.slot] = null;
  if (room.host) room.host.emit('pad:leave', { slot: seat.slot, padId: seat.padId, reason: 'expired' });
  log(`${tag(room)} ${seatLabel(seat)} reservation expired`);
}

// The desktop dropped a player (host:release): free the slot, but never take
// it from a phone that is connected.
function releaseSeat(room, slot) {
  const seat = room.seats[slot];
  if (!seat || seat.socket) return false;
  clearTimeout(seat.reserveTimer);
  room.seats[slot] = null;
  log(`${tag(room)} ${seatLabel(seat)} released by the desktop`);
  return true;
}

// ---------------------------------------------------------------- shared server state

let network = getNetworkInfo();
let httpsReady = false;
const qrCache = new Map();

function padBaseUrl() {
  return httpsReady
    ? `https://${urlHost(network.primary)}:${HTTPS_PORT}/pad`
    : `http://${urlHost(network.primary)}:${HTTP_PORT}/pad`;
}

async function qrFor(url) {
  let svg = qrCache.get(url);
  if (!svg) {
    svg = await QRCode.toString(url, { type: 'svg', margin: 1 });
    if (qrCache.size > 64) qrCache.clear();
    qrCache.set(url, svg);
  }
  return svg;
}

async function roomInfo(room) {
  const padUrl = `${padBaseUrl()}?room=${room.code}`;
  return { room: room.code, padUrl, qrSvg: await qrFor(padUrl), lanIps: network.lanIps.slice() };
}

// ---------------------------------------------------------------- express app

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/info', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set(INSTANCE_HEADER, INSTANCE);
    res.json({
      lanIps: network.lanIps,
      httpPort: HTTP_PORT,
      httpsPort: HTTPS_PORT,
      padBaseUrl: padBaseUrl(),
      primaryIp: network.primary,
      https: httpsReady,
      title: GAME_TITLE,
    });
  });

  app.get('/pad', (req, res) => {
    // A phone that typed the plain-http URL is bounced to HTTPS (motion sensors
    // need a secure context). Loopback http is already a secure context.
    const host = String(req.hostname || '');
    if (!req.secure && httpsReady && !isLoopbackHost(host) && /^[a-z0-9.-]+$/i.test(host)) {
      const q = req.originalUrl.indexOf('?');
      res.redirect(302, `https://${host}:${HTTPS_PORT}/pad${q >= 0 ? req.originalUrl.slice(q) : ''}`);
      return;
    }
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'pad.html'));
  });

  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.use('/vendor/three', express.static(THREE_DIR, { index: false, maxAge: '1h', fallthrough: false }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  return app;
}

// ---------------------------------------------------------------- socket.io

// Per socket and second. One desktop serves up to 4 phones: host:padState
// carries 4 slots × ~15 Hz (+ heartbeats); each phone has its own socket.
const RATE_LIMITS = {
  'host:create': 10, 'host:state': 90, 'host:padState': 160, 'host:event': 60, 'host:release': 20,
  'pad:hello': 10, 'pad:input': 150, 'pad:menu': 30, 'net:ping': 10,
};
// pad:input button / sequence edges get their own, separate budget: a pad
// flushing a backlog after a Wi-Fi stall must never lose its last release.
const PAD_EDGE_LIMIT = 60;

function allow(socket, event) {
  const t = Date.now();
  const rate = socket.data.rate || (socket.data.rate = {});
  let bucket = rate[event];
  if (!bucket || t - bucket.t >= 1000) bucket = rate[event] = { t, n: 0 };
  return ++bucket.n <= RATE_LIMITS[event];
}

// Registers a handler with rate limiting, ack normalization and error safety.
function handle(socket, event, fn) {
  socket.on(event, (...args) => {
    let ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const payload = args[0];
    const reply = (v) => { if (ack) { const a = ack; ack = null; a(v); } };
    if (!allow(socket, event)) { reply({ ok: false, error: 'rate', code: 'rate', message: 'Too many requests' }); return; }
    try {
      const r = fn(payload, reply);
      if (r && typeof r.catch === 'function') {
        r.catch((err) => { log(c.red(`${event} failed: ${err?.message || err}`)); reply({ ok: false, error: 'server', message: 'Server error' }); });
      }
    } catch (err) {
      log(c.red(`${event} failed: ${err?.message || err}`));
      reply({ ok: false, error: 'server', message: 'Server error' });
    }
  });
}

const isEdge = (last, inp) => !last || last.g !== inp.g || last.b !== inp.b || last.d !== inp.d || last.i !== inp.i || last.p !== inp.p;

function emitPadInput(seat, inp, reliable) {
  seat.lastInput = inp;
  const host = seat.room.host;
  if (reliable) host.emit('pad:input', inp);
  else host.volatile.emit('pad:input', inp);
}

// Relays one sanitized pad:input to the host. Button / sequence edges (against
// the last RELAYED sample) go reliably, steady-state samples volatile. Past the
// per-second budget nothing is lost: only the newest sample is kept and relayed
// (reliably) when the window resets, so a burst of queued samples after a
// network stall still ends on the pad's latest state.
function relayPadInput(socket, seat, inp) {
  const rl = socket.data.inputRate || (socket.data.inputRate = { t: 0, n: 0, edges: 0, pending: null, timer: null });
  const t = Date.now();
  if (t - rl.t >= 1000) { rl.t = t; rl.n = 0; rl.edges = 0; }
  rl.n++;
  const edge = isEdge(seat.lastInput, inp);
  if (edge ? rl.edges < PAD_EDGE_LIMIT : rl.n <= RATE_LIMITS['pad:input']) {
    if (edge) rl.edges++;
    rl.pending = null;                 // superseded by this newer sample
    emitPadInput(seat, inp, edge);
    return;
  }
  rl.pending = inp;
  if (rl.timer) return;
  rl.timer = setTimeout(() => {
    rl.timer = null;
    const p = rl.pending;
    rl.pending = null;
    const s = padSeat(socket);
    if (!p || !s || !s.room.host) return;
    rl.t = Date.now();
    rl.n = 1;
    rl.edges = isEdge(s.lastInput, p) ? 1 : 0;
    emitPadInput(s, p, true);
  }, Math.max(1, rl.t + 1000 - t));
}

function setupSockets(io) {
  io.on('connection', (socket) => {
    socket.data.role = null;
    socket.data.room = null;
    socket.data.slot = null;

    // ---- desktop (host) ----

    handle(socket, 'host:create', async (payload, reply) => {
      if (socket.data.role === 'pad') { reply({ error: 'This connection is a controller' }); return; }
      let room = hostRoom(socket);
      let reclaimed = false;
      const wanted = normalizeRoomCode(isObj(payload) ? payload.room : null);
      if (!room || (wanted && wanted !== room.code)) {
        if (room) { room.host = null; closeRoom(room, 'abandoned'); }
        room = null;
        if (wanted) {
          // A free code is re-created on request (desktop reloaded after the
          // room expired, or the server restarted). An existing room — live or
          // held during the grace period — needs the host key handed out when
          // it was created, so nobody else can take over paired phones.
          // `vacantOnly`: a newly opened tab found the code another tab stored;
          // it may take the room back from a closed tab, never from a live one.
          const existing = rooms.get(wanted);
          const key = isObj(payload) && typeof payload.key === 'string' ? payload.key : '';
          const vacantOnly = isObj(payload) && payload.vacantOnly === true;
          if (!existing) {
            if (rooms.size < MAX_ROOMS) { room = createRoom(wanted); reclaimed = true; }
          } else if (key && key === existing.key && !(vacantOnly && existing.host)) {
            room = existing;
            reclaimed = true;
          }
        }
        if (!room) {
          if (rooms.size >= MAX_ROOMS) { reply({ error: 'Server is full' }); return; }
          room = createRoom(generateCode());
        }
        attachHost(room, socket);
        log(`${tag(room)} desktop connected${reclaimed ? ' (reclaimed)' : ''}`);
      }
      const info = await roomInfo(room);
      if (!socket.connected || room.host !== socket) return;
      const slots = slotsInfo(room);
      reply({ ...info, key: room.key, padConnected: slots.connected.length > 0, slots, reclaimed, padBaseUrl: padBaseUrl() });
      // Phones already in the room (a reloaded desktop reclaiming it).
      for (const seat of connectedSeats(room)) socket.emit('pad:join', { slot: seat.slot, padId: seat.padId, host: slots.host });
      socket.emit('slots', slots);
    });

    handle(socket, 'host:state', (payload) => {
      const room = hostRoom(socket);
      if (!room) return;
      const state = sanitizeShared(payload);
      if (!state) return;
      room.state = state;
      for (const seat of connectedSeats(room)) seat.socket.emit('host:state', state);
    });

    // Personal state for one slot: cached (a reconnecting phone gets it back)
    // and sent to that phone only. Slots without a seat are ignored.
    handle(socket, 'host:padState', (payload) => {
      const room = hostRoom(socket);
      if (!room) return;
      const state = sanitizePadState(payload);
      const seat = state && room.seats[state.slot];
      if (!seat) return;
      seat.padState = state;
      if (seat.socket) seat.socket.emit('host:padState', state);
    });

    // To one slot ({ slot }) or, without a slot, to every phone.
    handle(socket, 'host:event', (payload) => {
      const room = hostRoom(socket);
      if (!room) return;
      const ev = sanitizeEvent(payload);
      if (!ev) return;
      if (payload.slot === undefined || payload.slot === null) {
        for (const seat of connectedSeats(room)) seat.socket.emit('host:event', ev);
        return;
      }
      const slot = slotNum(payload.slot);
      const seat = slot && room.seats[slot];
      if (seat && seat.socket) seat.socket.emit('host:event', ev);
    });

    handle(socket, 'host:release', (payload, reply) => {
      const room = hostRoom(socket);
      const slot = slotNum(isObj(payload) ? payload.slot : payload);
      reply({ ok: !!(room && slot && releaseSeat(room, slot)) });
    });

    // ---- phone (pad) ----

    handle(socket, 'pad:hello', (payload, reply) => {
      if (socket.data.role === 'host') { reply({ ok: false, error: 'role', code: 'role', message: 'This connection is the game host' }); return; }
      const code = normalizeRoomCode(isObj(payload) ? payload.room : null);
      if (!code) { reply({ ok: false, error: 'room', code: 'bad_code', message: 'That room code is not valid.' }); return; }
      const room = rooms.get(code);
      if (!room) { reply({ ok: false, error: 'room', code: 'no_room', message: `Room ${code} is not open.` }); return; }
      // `padId` (SPEC §14.7); `id` is the v2 name, still accepted.
      const padId = sanitizePadId(isObj(payload) ? payload.padId ?? payload.id : null) || socket.id;

      // A socket re-joining elsewhere (or as another phone) gives up its seat first.
      if (socket.data.room && (socket.data.room !== code || socket.data.padId !== padId)) unseatPad(socket);
      const known = room.seats.find((s) => s && s.padId === padId);
      const prevSocket = known ? known.socket : null;
      const seat = seatPad(room, socket, padId);
      if (!seat) {
        reply({ ok: false, error: 'full', code: 'full', message: `This game is full (${MAX_SLOTS}/${MAX_SLOTS}).`, max: MAX_SLOTS });
        return;
      }
      if (prevSocket !== socket) {
        log(`${tag(room)} ${seatLabel(seat)} phone ${known ? 'is back' : 'joined'} ${c.gray(`(${socket.handshake.address})`)}`);
      }
      const host = lowestConnected(room);
      reply({ ok: true, room: code, slot: seat.slot, color: slotInfo(seat.slot).css, host, hostConnected: !!room.host });
      if (room.host) room.host.emit('pad:join', { slot: seat.slot, padId, host });
      if (room.state) socket.emit('host:state', room.state);
      if (seat.padState) socket.emit('host:padState', seat.padState);
      if (!room.host) socket.emit('host:leave', {});
      announceSlots(room, socket);
    });

    // Not registered through handle(): over its rate limit pad:input is
    // coalesced, not dropped (see relayPadInput).
    socket.on('pad:input', (payload) => {
      try {
        const seat = padSeat(socket);
        if (!seat || !seat.room.host) return;
        const inp = sanitizeInput(payload, seat.slot);
        if (inp) relayPadInput(socket, seat, inp);
      } catch (err) {
        log(c.red(`pad:input failed: ${err?.message || err}`));
      }
    });

    handle(socket, 'pad:menu', (payload) => {
      const seat = padSeat(socket);
      if (!seat || !seat.room.host) return;
      const menu = sanitizeMenu(payload);
      if (menu) seat.room.host.emit('pad:menu', { slot: seat.slot, ...menu });
    });

    handle(socket, 'net:ping', (payload, reply) => reply({ t: Date.now() }));

    socket.on('disconnect', () => {
      clearTimeout(socket.data.inputRate?.timer);
      const code = socket.data.room;
      const room = code ? rooms.get(code) : null;
      if (!room) return;
      if (room.host === socket) hostGone(room);
      else if (padSeat(socket)) unseatPad(socket);
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

// Another program can hold our port on a loopback address only (e.g. a dev
// server bound to localhost:3000). On macOS the wildcard listen above still
// succeeds, but http://localhost:PORT then reaches that program while the
// phone (LAN IP) reaches us. Ask both loopback addresses who answers.
// Resolves the first loopback address served by someone else, or null.
async function checkLoopback(port, secure) {
  for (const host of ['127.0.0.1', '::1']) {
    if ((await probeLoopback(host, port, secure)) === 'other') return host;
  }
  return null;
}

// 'us' | 'other' | 'none' (nothing listening / no IPv6 loopback / no answer).
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
      // Refused / unreachable: nobody there. Anything else (TLS or protocol
      // errors, resets) means some other program answered.
      finish(/^(ECONNREFUSED|EADDRNOTAVAIL|ENETUNREACH|EHOSTUNREACH|EAFNOSUPPORT|ENOTFOUND)$/.test(err.code || '') ? 'none' : 'other');
    });
  });
}

function explainPortInUse(port, label, where = '') {
  console.error('');
  console.error(c.red(`  ✖ Port ${port} (${label}) is already in use${where ? ` on ${where}` : ''}.`));
  console.error(`    ${TITLE} may already be running — try ${c.cyan(`http://localhost:${HTTP_PORT}`)}.`);
  console.error(`    Otherwise stop the other program, or pick other ports:`);
  console.error(`      ${c.bold(`PORT=${HTTP_PORT + 1} HTTPS_PORT=${HTTPS_PORT + 1} npm start`)}`);
  console.error('');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser launcher available */ });
    child.unref();
  } catch { /* ignore */ }
}

function printBanner() {
  const desktop = `http://localhost:${HTTP_PORT}`;
  const line = c.yellow('━'.repeat(62));
  const ipList = network.interfaces.length
    ? network.interfaces.map((e) => `${e.ip}${c.gray(` (${e.name})`)}`).join(', ')
    : c.red('none found — connect this computer to Wi-Fi');
  console.log('');
  console.log(line);
  console.log(`  ${c.bold(c.yellow(TITLE))}  ${c.gray('· kart racing with a phone steering wheel')}`);
  console.log(line);
  console.log(`  ${c.bold('Desktop game')}   ${c.cyan(desktop)}`);
  console.log(`  ${c.bold('Phone wheel')}    ${c.cyan(`${padBaseUrl()}?room=XXXX`)}  ${c.gray('(scan the QR code in the game)')}`);
  console.log(`  ${c.bold('LAN IPs')}        ${ipList}`);
  if (network.override) console.log(`  ${c.bold('PAD_HOST')}       ${network.override}`);
  console.log('');
  if (httpsReady) {
    console.log(`  ${c.yellow('Tip:')} the phone will warn about the self-signed certificate — that's expected.`);
    console.log(`       iPhone: ${c.bold('Show Details → visit this website')}   Android: ${c.bold('Advanced → Proceed')}`);
  } else {
    console.log(`  ${c.red('HTTPS is unavailable')} — phones can only use touch steering (motion needs HTTPS).`);
  }
  console.log(`       Phone and computer must be on the same Wi-Fi. If macOS asks, allow incoming connections for node.`);
  console.log(line);
  console.log('');
}

async function main() {
  let tls = null;
  try {
    tls = await ensureCertificate(network);
    if (tls.regenerated) log(`generated a new HTTPS certificate for ${tls.names.join(', ')}`);
  } catch (err) {
    log(c.red(`could not create an HTTPS certificate (${err?.message || err}); continuing with HTTP only`));
  }

  const app = buildApp();
  const httpServer = http.createServer(app);
  const httpsServer = tls ? https.createServer({ key: tls.key, cert: tls.cert }, app) : null;

  // Short heartbeat: a phone that locks or loses Wi-Fi keeps its TCP socket
  // "open", so this is how long the room keeps a vanished pad (≤ 6 s). The game
  // itself pauses sooner: the pad sends a pause when its page is hidden, and
  // PhoneLink notices a silent input stream after ~1 s.
  const io = new Server(httpServer, {
    pingInterval: 3000,
    pingTimeout: 3000,
    maxHttpBufferSize: 64 * 1024,
  });
  const httpEngine = io.engine;
  if (httpsServer) io.attach(httpsServer);
  setupSockets(io);

  try {
    await listen(httpServer, HTTP_PORT, 'HTTP');
    if (httpsServer) await listen(httpsServer, HTTPS_PORT, 'HTTPS');
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      explainPortInUse(err.port, err.label);
    } else if (err.code === 'EACCES') {
      console.error(c.red(`  ✖ No permission to listen on port ${err.port}. Use a port above 1024 (PORT=3000).`));
    } else {
      console.error(c.red(`  ✖ Could not start the ${err.label} server: ${err.message}`));
    }
    process.exit(1);
  }
  for (const [port, label, secure] of [[HTTP_PORT, 'HTTP', false], ...(httpsServer ? [[HTTPS_PORT, 'HTTPS', true]] : [])]) {
    const clash = await checkLoopback(port, secure);
    if (clash) {
      explainPortInUse(port, label, clash === '::1' ? '[::1] (localhost)' : `${clash} (localhost)`);
      process.exit(1);
    }
  }
  httpsReady = !!httpsServer;
  for (const s of [httpServer, httpsServer]) s?.on('error', (err) => log(c.red(`server error: ${err.message}`)));

  printBanner();
  if (!NO_OPEN) openBrowser(`http://localhost:${HTTP_PORT}`);

  // Follow network changes (Wi-Fi switch, DHCP renew): new phone URL / QR for
  // every desktop; a new certificate only if the cached one does not cover it.
  let checking = false;
  setInterval(async () => {
    if (checking) return;
    const next = getNetworkInfo();
    if (networkKey(next) === networkKey(network)) return;
    checking = true;
    try {
      network = next;
      qrCache.clear();
      log(`network changed — LAN IPs: ${network.lanIps.join(', ') || 'none'}; phone URL is now ${padBaseUrl()}`);
      if (httpsServer) {
        const creds = await ensureCertificate(network);
        if (creds.regenerated) {
          httpsServer.setSecureContext({ key: creds.key, cert: creds.cert });
          log(`HTTPS certificate regenerated for ${creds.names.join(', ')} — phones must reload the pad page and accept it again`);
        }
      }
      for (const room of rooms.values()) {
        if (room.host) room.host.emit('host:info', await roomInfo(room));
      }
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
    log('shutting down…');
    // Close the transports without Socket.IO "disconnect" packets: clients then
    // see a plain connection loss and auto-reconnect when the server is back
    // (the desktop reclaims its room code, the phone re-joins it).
    try { httpEngine.close(); } catch { /* ignore */ }
    io.close();
    httpServer.close();
    httpServer.closeAllConnections?.();
    httpsServer?.close();
    httpsServer?.closeAllConnections?.();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(c.red(`  ✖ ${err?.stack || err}`));
  process.exit(1);
});
