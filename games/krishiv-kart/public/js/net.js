// KRISHIV KART — desktop side of the phone-controller link (SPEC §11, §14.7).
//
// Up to four phones join one room, one per player slot P1–P4 (the server
// seats them; a phone keeps its slot across reconnects). The desktop reads
// each slot's input and talks to all phones at once (shared host:state) or to
// one of them (host:padState, host:event with a slot).
//
//   import { PhoneLink } from './net.js';
//   const phones = new PhoneLink();
//   phones.connect().then(({ room, padUrl, qrSvg, lanIps }) => ...).catch(() => { /* keyboard still works */ });
//   phones.on('join',  ({ slot, padId, host, rejoin }) => ...);   // rejoin: the same phone came back
//   phones.on('leave', ({ slot, padId, reason }) => ...);         // 'left' | 'server' | 'replaced' | 'expired'
//   phones.on('menu',  ({ slot, action, ... }) => ...);           // validated by server.js (SPEC §14.7)
//   phones.on('slots', ({ host, connected }) => ...);             // player host = lowest connected slot
//   phones.on('info',  (roomInfo) => ...);                        // new QR / phone URL (network change)
//   phones.players     // Map slot → { slot, padId, connected, input }
//   phones.host        // player host slot, or null
//   phones.getInput(slot)  → { steer, gas, brake, drift, itemSeq, pauseSeq, lastUpdate } (zeros if none)
//   phones.isActive(slot)  // connected and input arriving
//   phones.sendState({ screen: 'lobby', ... });                  // shared, to every phone
//   phones.sendPadState(2, { step: 'body', ... });               // to P2 only
//   phones.sendEvent('vibrate', { pattern: [40] }, 3);          // to P3 (no slot: everyone)
//   phones.release(4);                                           // drop P4's reservation (gone 20 s in menus)
//
// sendState / sendPadState dedupe (unchanged states are not re-sent), cap
// changes at ~15 Hz per channel (the latest always wins) and re-send the last
// state at NET.hostStateHz as a heartbeat while that phone is connected.
//
// isActive(slot) follows the phone's own cadence: input within ~400 ms while
// it streams at race rate (60 Hz), within 1500 ms for the slow keepalive
// outside races, so a stalled phone stops driving its kart almost at once.
//
// Lost phone: a phone that was driving (a button held / an item, pause or
// menu press in the last 30 s) and goes silent for ~1 s during a live race
// fires 'lost' { slot, padId, silentMs } — a locked phone or dead Wi-Fi keeps
// its TCP socket open for seconds. 'signal' { slot, lost: false } follows
// when its input resumes. When it is the only connected phone (a solo race)
// PhoneLink also emits a local 'menu' { slot, action: 'pause', reason:
// 'signal' }; with more players the desktop lets a CPU drive that kart.
//
// Compatibility shim: `connected` (any phone connected) and `count` remain as
// aggregates; there is no single-pad `input` / `active` any more.
//
// Uses the classic Socket.IO browser client (`window.io`, from
// /socket.io/socket.io.js). Importing this module never touches the DOM and
// never throws; connect() rejects with an Error when the server (or the client
// script) is unavailable, so keyboard play keeps working.
//
// The room code + a host key are kept in sessionStorage so a page reload (or a
// socket reconnect, or even a server restart) reclaims the same room and the
// phones stay paired. The room phones are paired with is also kept in
// localStorage, so closing the tab and opening the game again reclaims it too
// (within the server's grace period) — but only while no other tab hosts it.
//
// Also exports the room-code helpers shared by server.js and pad.js.

import { NET } from './config.js';

// Room codes: 4 letters from an alphabet without look-alikes (no I, L, O).
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;

// Normalizes user/URL input into a valid room code, or returns null.
export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (let i = 0; i < code.length; i++) {
    if (ROOM_ALPHABET.indexOf(code[i]) < 0) return null;
  }
  return code;
}

const MAX_SLOTS = 4;
const CONNECT_TIMEOUT_MS = 6000;    // first connection attempt
const ACK_TIMEOUT_MS = 5000;        // host:create acknowledgement
const SCRIPT_TIMEOUT_MS = 4000;     // dynamic load of /socket.io/socket.io.js
const ACTIVE_WINDOW_MS = 1500;      // isActive = input seen within this window…
const STREAM_WINDOW_MS = 400;       // …shrunk toward this while the phone streams fast (6 missed samples' worth)
const LOST_AFTER_MS = 1000;         // a driving phone silent this long mid-race → 'lost'
const IN_USE_MS = 30000;            // "driving" = a button / item / menu press this recently
const MIN_STATE_INTERVAL_MS = 66;   // state emits are capped at ~15 Hz per channel
const STORAGE_KEY = 'krishivkart.host.room';
const LEGACY_STORAGE_KEY = 'tootkart.host.room';    // before the KRISHIV KART rename: still read once
const LIVE_RACE_STATES = new Set(['intro', 'countdown', 'racing']);

// getInput() for a slot without a phone (never mutated).
const ZERO_INPUT = Object.freeze({ steer: 0, gas: 0, brake: 0, drift: 0, itemSeq: 0, pauseSeq: 0, lastUpdate: 0 });

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function clampSteer(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

const validSlot = (v) => (Number.isInteger(v) && v >= 1 && v <= MAX_SLOTS ? v : null);

// This tab's own room (sessionStorage) first, else the room the phones were
// last paired with (localStorage: a closed tab that is opened again).
function readStoredRoom() {
  for (const [name, shared] of [['sessionStorage', false], ['localStorage', true]]) {
    try {
      const store = globalThis[name];
      const raw = store?.getItem(STORAGE_KEY) || store?.getItem(LEGACY_STORAGE_KEY);
      if (!raw) continue;
      const v = JSON.parse(raw);
      const room = normalizeRoomCode(v?.room);
      if (room) return { room, key: typeof v.key === 'string' ? v.key.slice(0, 64) : '', shared };
    } catch { /* storage blocked / junk */ }
  }
  return null;
}

function writeStoredRoom(room, key, shared = false) {
  const json = JSON.stringify({ room, key });
  try { globalThis.sessionStorage?.setItem(STORAGE_KEY, json); globalThis.sessionStorage?.removeItem(LEGACY_STORAGE_KEY); } catch { /* storage blocked */ }
  if (shared) {
    try { globalThis.localStorage?.setItem(STORAGE_KEY, json); globalThis.localStorage?.removeItem(LEGACY_STORAGE_KEY); } catch { /* storage blocked */ }
  }
}

// Resolves window.io, loading the client script on demand if the page did not
// include it. Rejects (never throws) when it cannot be loaded.
function loadSocketIoClient() {
  return new Promise((resolve, reject) => {
    if (typeof globalThis.io === 'function') { resolve(globalThis.io); return; }
    if (typeof document === 'undefined') {
      reject(new Error('Socket.IO client is not available in this environment'));
      return;
    }
    // A <script src=".../socket.io.js"> that already ran without defining io
    // means the server is not there (e.g. a static dev server); do not retry.
    const existing = document.querySelector('script[src*="socket.io.js"]');
    if (existing && existing.dataset.krishivkart !== 'loading') {
      reject(new Error('Socket.IO client failed to load — is the KRISHIV KART server running? (npm start)'));
      return;
    }
    const script = existing || document.createElement('script');
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      delete script.dataset.krishivkart;
      if (err) reject(err);
      else if (typeof globalThis.io === 'function') resolve(globalThis.io);
      else reject(new Error('Socket.IO client loaded but window.io is missing'));
    };
    const onLoad = () => finish(null);
    const onError = () => finish(new Error('Could not load /socket.io/socket.io.js — is the KRISHIV KART server running? (npm start)'));
    const timer = setTimeout(() => finish(new Error('Timed out loading the Socket.IO client')), SCRIPT_TIMEOUT_MS);
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
    if (!existing) {
      script.dataset.krishivkart = 'loading';
      script.src = '/socket.io/socket.io.js';
      script.async = true;
      (document.head || document.documentElement).appendChild(script);
    }
  });
}

// One outgoing state stream (the shared state, or one slot's padState):
// dedupe + rate cap + heartbeat bookkeeping.
class StateChannel {
  constructor(event) {
    this.event = event;
    this.pending = null;     // latest JSON handed to send*()
    this.sent = null;        // last JSON actually emitted
    this.at = -1e9;          // when it was emitted
    this.timer = null;
  }
}

export class PhoneLink {
  constructor() {
    this.room = null;
    this.padUrl = null;
    this.qrSvg = null;
    this.lanIps = [];
    /** @type {Map<number, { slot: number, padId: string|null, connected: boolean, input: object }>} */
    this.players = new Map();
    this.host = null;                // player host slot (lowest connected), from the server
    this.socketConnected = false;    // our own link to the server

    this._key = '';                  // host key that lets us reclaim our room
    this._vacantOnly = false;        // stored room came from another (closed) tab: reclaim only if no one hosts it
    this._socket = null;
    this._listeners = new Map();
    this._connectPromise = null;
    this._meta = new Map();          // slot → per-phone bookkeeping (see _metaFor)
    this._shared = new StateChannel('host:state');
    this._padChannels = new Map();   // slot → StateChannel('host:padState')
    this._sharedRace = false;        // last shared state is the race screen
    this._heartbeat = null;
    this._disposed = false;
  }

  // Aggregates (compatibility shim): any phone connected / how many.
  get connected() {
    for (const p of this.players.values()) if (p.connected) return true;
    return false;
  }

  get count() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  // The slot's live input, or a shared all-zero object (never allocates).
  getInput(slot) {
    const p = this.players.get(slot);
    return p ? p.input : ZERO_INPUT;
  }

  // The slot's phone is joined and has sent input recently ("recently"
  // follows its own cadence, see the header).
  isActive(slot) {
    const p = this.players.get(slot);
    if (!p || !p.connected) return false;
    return now() - p.input.lastUpdate < this._activeWindow(this._metaFor(slot).rate);
  }

  // True after 'lost' until that phone's input arrives again.
  isLost(slot) {
    const m = this._meta.get(slot);
    return !!m && m.lost;
  }

  _activeWindow(rate) {
    if (!(rate > 0)) return ACTIVE_WINDOW_MS;
    const w = 6000 / rate;             // six samples' worth
    return w < STREAM_WINDOW_MS ? STREAM_WINDOW_MS : w > ACTIVE_WINDOW_MS ? ACTIVE_WINDOW_MS : w;
  }

  // Per-slot bookkeeping: raw pad counters (seq baselines), arrival rate,
  // last "in use" press, lost flag, live-race flag (from its padState).
  _metaFor(slot) {
    let m = this._meta.get(slot);
    if (!m) {
      m = { rawItem: null, rawPause: null, rxN: 0, rxT0: 0, rate: 0, usedAt: -Infinity, lost: false, raceLive: true };
      this._meta.set(slot, m);
    }
    return m;
  }

  // Subscribe to 'join' | 'leave' | 'menu' | 'slots' | 'info' (also 'status',
  // 'input', 'lost', 'signal'). Returns an unsubscribe function.
  on(event, fn) {
    let set = this._listeners.get(event);
    if (!set) { set = new Set(); this._listeners.set(event, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[net] '${event}' listener threw`, err); }
    }
  }

  // Connects to the server and creates (or reclaims) a room.
  // Resolves { room, padUrl, qrSvg, lanIps }; rejects with an Error.
  connect() {
    if (this._disposed) return Promise.reject(new Error('PhoneLink was disposed'));
    if (!this._connectPromise) {
      this._connectPromise = this._connect().catch((err) => {
        this._connectPromise = null;
        throw err;
      });
    }
    return this._connectPromise;
  }

  async _connect() {
    const ioFn = await loadSocketIoClient();
    const stored = readStoredRoom();
    if (stored && !this.room) { this.room = stored.room; this._key = stored.key; this._vacantOnly = stored.shared; }

    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      try {
        socket = ioFn({ reconnectionDelay: 400, reconnectionDelayMax: 2500, timeout: CONNECT_TIMEOUT_MS });
      } catch (err) {
        reject(new Error(`Could not start the Socket.IO client (${err?.message || err})`));
        return;
      }
      this._socket = socket;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._closeSocket();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('Timed out connecting to the KRISHIV KART server')), CONNECT_TIMEOUT_MS + 500);

      socket.on('connect_error', (err) => {
        if (!settled) fail(new Error(`Cannot reach the KRISHIV KART server (${err?.message || 'connect error'})`));
      });

      socket.on('connect', () => {
        this.socketConnected = true;
        this._emit('status', { socketConnected: true });
        if (settled) { this._claimRoom(null); return; }     // reconnect: reclaim quietly
        this._claimRoom((info, err) => {
          if (settled) return;
          if (err) { fail(err); return; }
          settled = true;
          clearTimeout(timer);
          resolve(info);
        });
      });

      socket.on('disconnect', (reason) => {
        this.socketConnected = false;
        this._emit('status', { socketConnected: false, reason });
        // Our link is down: no phone can reach us until the room is reclaimed
        // (the server then re-announces every phone that is still there).
        this._allGone('server');
        // Socket.IO does not auto-reconnect after a server-initiated disconnect
        // (e.g. the server restarting); retry ourselves so the room is reclaimed.
        if (reason === 'io server disconnect') {
          setTimeout(() => { if (socket === this._socket && !socket.connected) socket.connect(); }, 1000);
        }
      });

      socket.on('pad:join', (p) => this._onJoin(p));
      socket.on('pad:leave', (p) => this._onLeave(p));
      socket.on('slots', (p) => this._onSlots(p));
      socket.on('pad:input', (p) => this._onPadInput(p));

      socket.on('pad:menu', (p) => {
        if (!p || typeof p.action !== 'string' || !validSlot(p.slot)) return;
        this._metaFor(p.slot).usedAt = now();
        this._emit('menu', p);
      });

      socket.on('host:info', (p) => this._applyInfo(p, true));

      // Another tab took over our room with the same host key (duplicated tab):
      // start over with a brand-new room so both tabs keep working.
      socket.on('host:replaced', () => {
        this._allGone('replaced');
        this.players.clear();
        this._padChannels.clear();
        this.room = null;
        this._key = '';
        this._vacantOnly = false;
        this._claimRoom(null);
      });
    });
  }

  // Emits host:create (reclaiming our previous room when we have one).
  _claimRoom(cb) {
    const socket = this._socket;
    if (!socket) return;
    const payload = this.room ? { room: this.room, key: this._key, ...(this._vacantOnly ? { vacantOnly: true } : {}) } : {};
    socket.timeout(ACK_TIMEOUT_MS).emit('host:create', payload, (err, res) => {
      if (socket !== this._socket) return;
      if (res && res.room) this._vacantOnly = false;   // from now on it is our own room
      if (err || !res || !res.room) {
        const e = new Error(err ? 'The server did not answer host:create' : (res?.error || 'Room creation failed'));
        if (cb) { cb(null, e); return; }
        // Reconnect path: retry shortly while the socket is up.
        setTimeout(() => { if (socket.connected && socket === this._socket) this._claimRoom(null); }, 1000);
        return;
      }
      if (res.slots && typeof res.slots === 'object') this.host = validSlot(res.slots.host);
      const info = this._applyInfo(res, !cb);
      if (cb) {
        cb(info, null);
        this._emit('info', info);
      }
      this._startHeartbeat();
      this._flushAll(true);              // refresh the server's cached states
    });
  }

  _applyInfo(res, notify) {
    if (!res || typeof res !== 'object') return this._info();
    const changed = res.room !== this.room || res.padUrl !== this.padUrl || res.qrSvg !== this.qrSvg;
    if (typeof res.room === 'string') this.room = res.room;
    if (typeof res.key === 'string' && res.key) this._key = res.key;
    if (typeof res.padUrl === 'string') this.padUrl = res.padUrl;
    if (typeof res.qrSvg === 'string') this.qrSvg = res.qrSvg;
    if (Array.isArray(res.lanIps)) this.lanIps = res.lanIps.filter((ip) => typeof ip === 'string');
    if (this.room) writeStoredRoom(this.room, this._key, !!res.padConnected);
    const info = this._info();
    if (notify && changed) this._emit('info', info);
    return info;
  }

  _info() {
    return { room: this.room, padUrl: this.padUrl, qrSvg: this.qrSvg, lanIps: this.lanIps.slice() };
  }

  // ---- phones joining / leaving

  _onJoin(p) {
    const slot = validSlot(p?.slot);
    if (!slot) return;
    const padId = typeof p.padId === 'string' ? p.padId : null;
    let pl = this.players.get(slot);
    const rejoin = !!pl && pl.padId === padId;
    if (!rejoin) {
      // A new phone in this slot (the previous one's reservation ended).
      pl = { slot, padId, connected: false, input: { steer: 0, gas: 0, brake: 0, drift: 0, itemSeq: 0, pauseSeq: 0, lastUpdate: 0 } };
      this.players.set(slot, pl);
      this._meta.delete(slot);
    }
    const m = this._metaFor(slot);
    if (!rejoin) m.usedAt = -Infinity;     // not "driving" yet
    m.rawItem = null;                      // adopt the phone's (maybe restarted) counters as baseline
    m.rawPause = null;
    this._zeroInput(pl.input);
    this._resetSignal(m);
    pl.connected = true;
    if ('host' in p) this.host = validSlot(p.host);
    if (this.room) writeStoredRoom(this.room, this._key, true);   // the phones' room: reopen-able
    this._emit('join', { slot, padId, host: this.host, rejoin });
    // Give the phone our current screens right away.
    this._flush(this._shared, true);
    const ch = this._padChannels.get(slot);
    if (ch) this._flush(ch, true);
  }

  _onLeave(p) {
    const slot = validSlot(p?.slot);
    const pl = slot ? this.players.get(slot) : null;
    if (!pl || (typeof p.padId === 'string' && pl.padId !== null && p.padId !== pl.padId)) return;   // stale
    const reason = typeof p.reason === 'string' ? p.reason : 'left';
    if (reason === 'expired') {
      // The server freed the slot: the phone is not coming back.
      this.players.delete(slot);
      this._meta.delete(slot);
      this._dropPadChannel(slot);
      if (pl.connected) this._emit('leave', { slot, padId: pl.padId, reason });
      return;
    }
    if (!pl.connected) return;
    this._playerGone(pl, reason);
  }

  _onSlots(p) {
    if (!p || typeof p !== 'object') return;
    this.host = validSlot(p.host);
    const connected = Array.isArray(p.connected) ? p.connected.filter((s) => validSlot(s)) : [];
    // (pad:join / pad:leave always come first; this only mops up a missed leave.)
    for (const pl of this.players.values()) if (pl.connected && !connected.includes(pl.slot)) this._playerGone(pl, 'left');
    this._emit('slots', { host: this.host, connected });
  }

  _playerGone(pl, reason) {
    pl.connected = false;
    this._zeroInput(pl.input);
    this._resetSignal(this._metaFor(pl.slot));
    this._emit('leave', { slot: pl.slot, padId: pl.padId, reason });
  }

  _allGone(reason) {
    for (const pl of this.players.values()) if (pl.connected) this._playerGone(pl, reason);
  }

  _zeroInput(inp) {
    inp.steer = 0; inp.gas = 0; inp.brake = 0; inp.drift = 0;
  }

  _resetSignal(m) {
    m.rxN = 0; m.rxT0 = 0; m.rate = 0;
    m.lost = false;
  }

  // ---- input

  // Raw phone counters may restart (page reload); the exposed itemSeq /
  // pauseSeq only ever move forward, by the phone's positive deltas.
  _advanceSeq(pl, m, kind, raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    const last = kind === 'item' ? m.rawItem : m.rawPause;
    if (kind === 'item') m.rawItem = n; else m.rawPause = n;
    if (last === null) return;
    const d = n - last;
    if (d > 0 && d < 1000) {
      if (kind === 'item') pl.input.itemSeq += d;
      else pl.input.pauseSeq += d;
    }
  }

  _onPadInput(p) {
    if (!p || typeof p !== 'object') return;
    const slot = validSlot(p.slot);
    if (!slot) return;
    let pl = this.players.get(slot);
    if (!pl || !pl.connected) {           // missed pad:join (should not happen) — recover
      this._onJoin({ slot, padId: pl ? pl.padId : null, host: this.host });
      pl = this.players.get(slot);
    }
    const m = this._metaFor(slot);
    const inp = pl.input;
    const t = now();
    m.rxN++;
    if (!m.rxT0) m.rxT0 = t;
    else if (t - m.rxT0 >= 1000) { m.rate = (m.rxN * 1000) / (t - m.rxT0); m.rxN = 0; m.rxT0 = t; }
    inp.steer = clampSteer(p.s);
    inp.gas = p.g ? 1 : 0;
    inp.brake = p.b ? 1 : 0;
    inp.drift = p.d ? 1 : 0;
    const seqs = inp.itemSeq + inp.pauseSeq;
    this._advanceSeq(pl, m, 'item', p.i);
    this._advanceSeq(pl, m, 'pause', p.p);
    if (inp.gas || inp.brake || inp.drift || inp.itemSeq + inp.pauseSeq !== seqs) m.usedAt = t;
    inp.lastUpdate = t;
    if (m.lost) {
      m.lost = false;
      this._emit('signal', { slot, lost: false, padId: pl.padId });
    }
    this._emit('input', pl);
  }

  // Heartbeat tick: has a phone that was driving gone silent mid-race?
  _checkSignal(pl) {
    const m = this._metaFor(pl.slot);
    if (!pl.connected || m.lost || !this._sharedRace || !m.raceLive) return;
    const last = pl.input.lastUpdate;
    if (!last || now() - last < LOST_AFTER_MS) return;
    if (last - m.usedAt > IN_USE_MS) return;      // phone lying idle (a keyboard player, a spare phone)
    m.lost = true;
    this._zeroInput(pl.input);
    this._emit('lost', { slot: pl.slot, padId: pl.padId, silentMs: Math.round(now() - last) });
    if (this.count === 1) this._emit('menu', { slot: pl.slot, action: 'pause', reason: 'signal' });
  }

  // ---- outgoing state

  // The shared mirror state for every phone (SPEC §14.7 host:state).
  sendState(state) {
    if (!state || typeof state !== 'object') return;
    this._sharedRace = state.screen === 'race';
    this._queue(this._shared, state);
  }

  // One phone's personal state (SPEC §14.7 host:padState); routed to that slot only.
  sendPadState(slot, state) {
    const s = validSlot(slot);
    if (!s || !state || typeof state !== 'object') return;
    const r = state.race;
    this._metaFor(s).raceLive = !r || typeof r !== 'object' || (!r.finished && LIVE_RACE_STATES.has(r.state));
    let ch = this._padChannels.get(s);
    if (!ch) { ch = new StateChannel('host:padState'); this._padChannels.set(s, ch); }
    this._queue(ch, state.slot === s ? state : { ...state, slot: s });
  }

  _queue(ch, state) {
    let json;
    try { json = JSON.stringify(state); } catch { return; }
    ch.pending = json;
    if (json === ch.sent) return;
    const wait = ch.at + MIN_STATE_INTERVAL_MS - now();
    if (wait <= 0) this._flush(ch, false);
    else if (!ch.timer) {
      ch.timer = setTimeout(() => { ch.timer = null; this._flush(ch, false); }, wait);
    }
  }

  _flush(ch, force) {
    const json = ch.pending;
    const socket = this._socket;
    if (!json || !socket || !socket.connected || !this.room) return;
    if (!force && json === ch.sent) return;
    socket.emit(ch.event, JSON.parse(json));
    ch.sent = json;
    ch.at = now();
  }

  // True while our outgoing queue is backed up (stalled Wi-Fi): heartbeats
  // only refresh what the phones already have, so they wait. (Socket.IO's
  // volatile flag is no substitute: it drops every emit after the first one
  // in the same tick, i.e. all but one phone's heartbeat.)
  _backlogged() {
    const wb = this._socket?.io?.engine?.writeBuffer;
    return Array.isArray(wb) && wb.length > 4;
  }

  _flushAll(force) {
    this._flush(this._shared, force);
    for (const ch of this._padChannels.values()) this._flush(ch, force);
  }

  _dropPadChannel(slot) {
    const ch = this._padChannels.get(slot);
    if (ch) clearTimeout(ch.timer);
    this._padChannels.delete(slot);
  }

  _startHeartbeat() {
    if (this._heartbeat) return;
    const period = 1000 / Math.max(0.5, NET.hostStateHz || 5);
    this._heartbeat = setInterval(() => {
      if (!this.connected) return;
      const t = now();
      const beat = !this._backlogged();
      for (const pl of this.players.values()) {
        if (!pl.connected) continue;
        this._checkSignal(pl);
        const ch = this._padChannels.get(pl.slot);
        if (beat && ch && t - ch.at >= period * 0.9) this._flush(ch, true);
      }
      if (beat && t - this._shared.at >= period * 0.9) this._flush(this._shared, true);
    }, period);
  }

  // A host:event to one phone (slot) or to every phone (no slot), e.g.
  // sendEvent('vibrate', { pattern: [40] }, 2) or sendEvent('toast', { text: 'Lap 2!' }).
  sendEvent(type, data = {}, slot = null) {
    const socket = this._socket;
    if (!socket || !socket.connected || typeof type !== 'string') return;
    const payload = { ...(data && typeof data === 'object' ? data : {}), type };
    delete payload.slot;
    if (slot !== null && slot !== undefined) {
      const s = validSlot(slot);
      if (!s || !this.players.get(s)?.connected) return;
      payload.slot = s;
    } else if (!this.connected) {
      return;
    }
    socket.emit('host:event', payload);
  }

  // Drops a player whose phone is gone (the desktop gives up after 20 s in
  // the menus): frees the server's reservation so a new phone can take the slot.
  release(slot) {
    const s = validSlot(slot);
    if (!s) return;
    const pl = this.players.get(s);
    if (pl && pl.connected) return;       // never drop a phone that is here
    this.players.delete(s);
    this._meta.delete(s);
    this._dropPadChannel(s);
    const socket = this._socket;
    if (socket && socket.connected) socket.emit('host:release', { slot: s });
  }

  _closeSocket() {
    const socket = this._socket;
    this._socket = null;
    if (socket) {
      try { socket.removeAllListeners(); socket.close(); } catch { /* ignore */ }
    }
    this.socketConnected = false;
  }

  // Closes the connection and stops all timers. The instance cannot reconnect.
  dispose() {
    this._disposed = true;
    clearInterval(this._heartbeat);
    this._heartbeat = null;
    clearTimeout(this._shared.timer);
    for (const ch of this._padChannels.values()) clearTimeout(ch.timer);
    this._closeSocket();
    this._allGone('disposed');
    this._listeners.clear();
  }
}
