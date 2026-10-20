// TV side of the phone link: creates (or reclaims) the room, tracks the four
// player slots, and relays phone input into the app.
//
//   const link = new DisplayLink();
//   await link.connect();                 // { room, joinUrl, qrSvg, games }
//   link.on('players', (players) => …)    // slot list changed
//   link.on('input', (msg) => …)          // { slot, t: 'btn' | 'ptr' | 'tswing' | 'gswing' | …, … }
//   link.sendState(slot, state)           // the phone's screen model (deduped)
//   link.sendEvent(slot | 'all', event)   // one-off: vibrate / sound / toast
//   link.where('tennis')                  // what the TV is showing
//   await link.launch('bowling')          // start Bowling / Kart → { httpPort, … }
//
// The room code + key live in sessionStorage so a reload of the TV — or a trip
// to Bowling / Krishiv Kart and back — reclaims the same room and every phone
// stays paired.

import { MAX_PLAYERS } from '../shared/protocol.js';

const STORAGE_KEY = 'krishivsports.display.room';

export class DisplayLink {
  constructor() {
    this.room = null;
    this.joinUrl = null;
    this.qrSvg = null;
    this.lanIps = [];
    this.https = false;
    this.games = {};
    this.key = '';
    this.socket = null;
    this.socketConnected = false;
    this.rtt = 40;                      // TV ↔ server round trip (ms)
    /** @type {Array<null | {slot, name, color, hand, character, connected, seat}>} */
    this.players = new Array(MAX_PLAYERS).fill(null);
    this._listeners = new Map();
    this._inGame = false;
    this._reserved = 0;
    this._where = 'menu';
    this._sent = new Array(MAX_PLAYERS).fill(null);
    this._pending = new Array(MAX_PLAYERS).fill(null);
    this._timers = new Array(MAX_PLAYERS).fill(null);
    try {
      const v = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
      if (v && typeof v.room === 'string') { this.room = v.room; this.key = String(v.key || ''); }
      if (Array.isArray(v?.seats)) this._seats = v.seats;
    } catch { /* storage blocked */ }
    // ?room=XXXX (coming back from Bowling / Kart in a tab that lost its storage).
    const q = new URLSearchParams(location.search).get('room');
    if (q && !this.room && /^[A-Z]{4}$/.test(q)) this.room = q;
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event).delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this._listeners.get(event) || []) {
      try { fn(payload); } catch (err) { console.error(`[net] ${event} listener`, err); }
    }
  }

  connect() {
    if (typeof window.io !== 'function') return Promise.reject(new Error('Socket.IO client missing — start the menu with `npm start`.'));
    return new Promise((resolve, reject) => {
      const socket = window.io({ reconnectionDelay: 400, reconnectionDelayMax: 2500, timeout: 6000 });
      this.socket = socket;
      let first = true;
      const timer = setTimeout(() => { if (first) reject(new Error('Timed out reaching the game server')); }, 8000);
      socket.on('connect', () => {
        this.socketConnected = true;
        this._emit('status', { connected: true });
        this._claim((info, err) => {
          if (!first) return;
          first = false;
          clearTimeout(timer);
          if (err) reject(err); else resolve(info);
        });
      });
      socket.on('disconnect', (reason) => {
        this.socketConnected = false;
        this._emit('status', { connected: false, reason });
        if (reason === 'io server disconnect') setTimeout(() => { if (!socket.connected) socket.connect(); }, 1000);
      });
      socket.on('connect_error', (err) => { if (first) this._emit('status', { connected: false, error: err?.message }); });
      socket.on('player:join', (p) => this._setPlayer(p.slot, { slot: p.slot, name: p.name, color: p.color, hand: p.hand, character: p.character, seat: p.seat, connected: true }, p.rejoin ? 'rejoin' : 'join'));
      socket.on('player:update', (p) => p && this._setPlayer(p.slot, { ...p }, 'update'));
      socket.on('player:leave', (p) => {
        const cur = this.players[p.slot];
        if (cur) this._setPlayer(p.slot, { ...cur, connected: false }, 'leave');
      });
      socket.on('player:remove', (p) => this._setPlayer(p.slot, null, 'remove'));
      socket.on('remote:input', (msg) => {
        if (!msg || !Number.isInteger(msg.slot)) return;
        msg.at = performance.now();
        this._emit('input', msg);
      });
      socket.on('display:info', (info) => this._applyInfo(info));
      socket.on('display:replaced', () => {
        // Another tab took this room over: start a fresh one here.
        this.room = null;
        this.key = '';
        this._claim(() => {});
      });
      setInterval(() => {
        if (!socket.connected) return;
        const t0 = performance.now();
        socket.timeout(2500).emit('net:ping', {}, (err) => { if (!err) this.rtt = this.rtt * 0.7 + (performance.now() - t0) * 0.3; });
      }, 2000);
    });
  }

  _claim(cb) {
    const socket = this.socket;
    const payload = { inGame: this._inGame, reserved: this._reserved };
    if (this.room) {
      payload.room = this.room;
      payload.key = this.key;
      const seats = this.players.some(Boolean) ? this.players : (this._seats || []);
      payload.seats = seats.map((p, slot) => (p && p.seat ? { slot: p.slot ?? slot, seat: p.seat, name: p.name, color: p.color, hand: p.hand, character: p.character } : null)).filter(Boolean);
    }
    socket.timeout(5000).emit('display:create', payload, (err, res) => {
      if (err || !res || !res.ok) {
        const e = new Error(err ? 'The server did not answer' : res?.error || 'Could not create a room');
        cb(null, e);
        if (socket.connected) setTimeout(() => { if (socket.connected) this._claim(() => {}); }, 1500);
        return;
      }
      this.key = res.key;
      this._applyInfo(res);
      const players = new Array(MAX_PLAYERS).fill(null);
      (res.players || []).forEach((p, i) => { if (p) players[i] = { ...p }; });
      this.players = players;
      this._save();
      this._emit('players', this.players.slice());
      this._sent.fill(null);
      for (let i = 0; i < MAX_PLAYERS; i++) if (this._pending[i]) this._flush(i);
      if (this._where !== 'menu') socket.emit('display:where', { where: this._where });
      cb(this._info(), null);
    });
  }

  _save() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        room: this.room, key: this.key,
        seats: this.players.map((p) => (p ? { slot: p.slot, seat: p.seat, name: p.name, color: p.color, hand: p.hand, character: p.character } : null)),
      }));
    } catch { /* blocked */ }
  }

  _applyInfo(res) {
    if (!res) return;
    if (typeof res.room === 'string') this.room = res.room;
    if (typeof res.joinUrl === 'string') this.joinUrl = res.joinUrl;
    if (typeof res.qrSvg === 'string') this.qrSvg = res.qrSvg;
    if (Array.isArray(res.lanIps)) this.lanIps = res.lanIps;
    if (res.games) this.games = res.games;
    this.https = !!res.https;
    this._emit('info', this._info());
  }

  _info() { return { room: this.room, joinUrl: this.joinUrl, qrSvg: this.qrSvg, lanIps: this.lanIps, https: this.https, games: this.games }; }

  _setPlayer(slot, value, why) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PLAYERS) return;
    this.players[slot] = value;
    if (why === 'join' || why === 'rejoin') { this._sent[slot] = null; if (this._pending[slot]) this._flush(slot); }
    this._save();
    this._emit('players', this.players.slice());
    this._emit(why, { slot, player: value });
  }

  setPhase(inGame, reserved = this._reserved) {
    const next = { inGame: !!inGame, reserved: Math.max(0, Math.min(MAX_PLAYERS, reserved | 0)) };
    if (next.inGame === this._inGame && next.reserved === this._reserved) return;
    this._inGame = next.inGame;
    this._reserved = next.reserved;
    if (this.socket?.connected) this.socket.emit('display:phase', next);
  }

  where(w) {
    this._where = w;
    if (this.socket?.connected) this.socket.emit('display:where', { where: w });
  }

  launch(game) {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) { reject(new Error('Not connected to the server')); return; }
      this.socket.timeout(25000).emit('display:launch', { game }, (err, res) => {
        if (err) reject(new Error('The server did not answer'));
        else if (!res?.ok) reject(new Error(res?.error || 'Could not start the game'));
        else resolve(res);
      });
    });
  }

  kick(slot) { if (this.socket?.connected) this.socket.emit('display:kick', { slot }); }

  setProfile(slot, profile) { if (this.socket?.connected) this.socket.emit('display:profile', { slot, ...profile }); }

  // Phone screen model. Unchanged states are skipped; changes are capped at ~20 Hz.
  sendState(slot, state) {
    let json;
    try { json = JSON.stringify(state); } catch { return; }
    this._pending[slot] = json;
    if (json === this._sent[slot] || this._timers[slot]) return;
    this._timers[slot] = setTimeout(() => { this._timers[slot] = null; this._flush(slot); }, 50);
  }

  _flush(slot) {
    const json = this._pending[slot];
    if (!json || json === this._sent[slot] || !this.socket?.connected) return;
    this.socket.emit('display:state', { slot, state: JSON.parse(json) });
    this._sent[slot] = json;
  }

  sendEvent(slot, event) {
    if (!this.socket?.connected) return;
    this.socket.emit('display:event', { slot, event });
  }
}
