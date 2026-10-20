// Phone controller: joins a game's lobby by its QR code and follows the TV
// from then on — the lobby (the host changes the settings and starts), a
// racket in Tennis, a club in Golf, and a hop to Bowling / Krishiv Kart (and
// back) when the TV goes there.

import { TennisSwingDetector } from './tennis-swing.js';
import { GolfSwingDetector } from './golf-swing.js';
import {
  PLAYER_COLORS, colorHex, normalizeRoomCode, cleanName, NET, BRAINROT_CHARACTERS, DEFAULT_CHARACTER, getCharacter,
  GAMES, TENNIS_FORMATS, CPU_LEVELS, GOLF_COURSES,
} from '../shared/protocol.js';

const $ = (id) => document.getElementById(id);
const body = document.body;
const make = (tag, cls, text, parent) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  if (parent) parent.append(e);
  return e;
};

// ---------------------------------------------------------------- storage

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(`ks.${k}`); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ks.${k}`, String(v)); } catch { /* private mode */ } },
};
function newId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'[b & 63]).join('');
}

const params = new URLSearchParams(location.search);
let clientId = store.get('clientId');
if (!clientId || !/^[A-Za-z0-9_-]{8,48}$/.test(clientId)) { clientId = newId(); store.set('clientId', clientId); }

const profile = {
  name: cleanName(store.get('name', '')),
  color: store.get('color', null),
  character: store.get('character', DEFAULT_CHARACTER),
  hand: store.get('hand', 'right') === 'left' ? 'left' : 'right',
};
const settings = {
  mode: store.get('mode', 'motion') === 'touch' ? 'touch' : 'motion',
  invert: store.get('invert', '0') === '1',
  sound: store.get('sound', '1') !== '0',
  strength: Number(store.get('strength', '1')) || 1,
};

const state = {
  room: normalizeRoomCode(params.get('room')) || normalizeRoomCode(store.get('room', '')) || null,
  screen: 'connecting',
  socket: null,
  socketUp: false,
  joined: false,
  joining: false,
  rejoining: false,
  rejoinTries: 0,
  editing: false,
  slot: null,
  display: null,              // last state from the TV
  displayGone: false,
  rtt: 60,
  motion: { asked: false, denied: false, granted: false, events: 0, gyro: 0, lastAt: 0, up: null, upAt: 0, touchFallback: false },
  swingSeq: Math.floor(Math.random() * 1e6),
  grip: { held: false, pointer: null, startY: 0, startX: 0, pull: 0, x: 0 },
  lastTennisKey: '',
  clubTimer: null,
  feedbackT: 0,
};
if (!params.get('room') && state.room) history.replaceState(null, '', `${location.pathname}?room=${state.room}`);

const tennis = new TennisSwingDetector({ hand: profile.hand, invertSpin: settings.invert });
const golf = new GolfSwingDetector({ strength: settings.strength, invertCurve: settings.invert, hand: profile.hand });

// ---------------------------------------------------------------- screens / feedback

function setScreen(name) {
  if (state.screen === name) return;
  state.screen = name;
  body.dataset.screen = name;
  updateStreams();
  if (name !== 'golf') releaseGrip(true);
}

function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function flash() { body.classList.remove('flash'); void body.offsetWidth; body.classList.add('flash'); }
function haptic(p) { if (typeof navigator.vibrate === 'function') try { navigator.vibrate(p); } catch { /* */ } }

let actx = null;
function unlockAudio() {
  try {
    if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC(); }
    if (actx && actx.state === 'suspended') actx.resume();
  } catch { /* */ }
}
function beep(seq, type = 'triangle', vol = 0.18) {
  if (!actx || !settings.sound) return;
  let t = actx.currentTime + 0.01;
  for (const [f, d] of seq) {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + d + 0.02);
    t += d * 0.9;
  }
}
// The phone's own speaker: a racket "pock" / club "click".
function pock(k = 0.7) {
  if (!actx || !settings.sound) return;
  const t = actx.currentTime + 0.005;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(900, t);
  o.frequency.exponentialRampToValueAtTime(500, t + 0.06);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.3 * k + 0.1, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + 0.1);
}

// ---------------------------------------------------------------- motion sensors

const needsPermission = () =>
  (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') ||
  (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function');

// Must run inside a tap (iOS).
function askMotion() {
  state.motion.asked = true;
  const asks = [];
  for (const C of [window.DeviceMotionEvent, window.DeviceOrientationEvent]) {
    if (C && typeof C.requestPermission === 'function') {
      try { asks.push(C.requestPermission().catch(() => 'denied')); } catch { asks.push(Promise.resolve('denied')); }
    }
  }
  if (!asks.length) return Promise.resolve('unsupported');
  return Promise.all(asks).then((r) => {
    const ok = r.includes('granted');
    state.motion.denied = !ok;
    state.motion.granted = ok;
    return ok ? 'granted' : 'denied';
  });
}

function upFromOrientation(betaDeg, gammaDeg) {
  const b = betaDeg * Math.PI / 180, g = gammaDeg * Math.PI / 180;
  return [-Math.sin(g) * Math.cos(b), Math.sin(b), Math.cos(g) * Math.cos(b)];
}

function onMotion(e) {
  const rr = e.rotationRate;
  const w = rr && rr.alpha !== null && rr.alpha !== undefined ? [Number(rr.alpha), Number(rr.beta), Number(rr.gamma)] : null;
  const la = e.acceleration;
  const a = la && la.x !== null && la.x !== undefined ? [Number(la.x), Number(la.y), Number(la.z)] : null;
  if (!w && !a) return;
  state.motion.events++;
  if (w) state.motion.gyro++;
  state.motion.lastAt = performance.now();
  if (!w) return;
  const t = e.timeStamp || performance.now();
  if (state.motion.up) tennis.setUp(state.motion.up, t);
  if (state.screen === 'tennis' && motionMode()) {
    const ev = tennis.sample(t, w, a);
    if (ev) onTennisSwing(ev, performance.now() - (t - ev.t));
  } else if (state.screen === 'golf' && motionMode()) {
    const ev = golf.sample(t, w);
    if (ev) onGolfSwing(ev);
  }
}

function onOrientation(e) {
  if (e.beta === null || e.gamma === null || e.beta === undefined) return;
  state.motion.up = upFromOrientation(Number(e.beta), Number(e.gamma));
  state.motion.upAt = performance.now();
}

window.addEventListener('devicemotion', onMotion);
window.addEventListener('deviceorientation', onOrientation);

const motionLive = () => performance.now() - state.motion.lastAt < 1500 && state.motion.gyro > 3;
const motionMode = () => settings.mode === 'motion' && !state.motion.touchFallback && window.isSecureContext;

function checkSensors() {
  clearTimeout(checkSensors._t);
  checkSensors._t = setTimeout(() => {
    const fallback = settings.mode === 'motion' && !motionLive();
    if (fallback !== state.motion.touchFallback) {
      state.motion.touchFallback = fallback;
      if (fallback && state.joined && !needsPermission()) toast('No motion sensor found — using touch controls');
    }
    // iOS: no motion until a tap grants it — asked once; after that, touch.
    $('tapgate').hidden = !(settings.mode === 'motion' && needsPermission() && !motionLive() && !state.motion.asked && state.joined && ['wait', 'lobby', 'tennis', 'golf'].includes(state.screen));
    renderMode();
  }, 1400);
}

function renderMode() {
  body.classList.toggle('touch', !motionMode());
  body.classList.toggle('motion', motionMode() && motionLive());
  const s = $('sensor-status');
  if (!window.isSecureContext) s.textContent = 'Motion sensors need the secure (https) page. Using touch.';
  else if (state.motion.denied) s.textContent = 'Motion access was denied. On iPhone: close Safari fully, reopen this page and tap Allow.';
  else if (motionLive()) s.textContent = `Motion sensors: working${state.motion.gyro ? ' (gyroscope)' : ''}.`;
  else s.textContent = 'Motion sensors: no data yet.';
  $('btn-motion-retry').hidden = !(needsPermission() && (state.motion.denied || !motionLive()));
  for (const b of $('mode-seg').children) b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode));
  for (const b of $('strength-seg').children) b.setAttribute('aria-checked', String(Number(b.dataset.strength) === settings.strength));
}

// ---------------------------------------------------------------- wake lock / fullscreen

let wakeLock = null;
async function keepAwake() {
  if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch { /* later */ }
}
function goFullscreen() {
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!req || document.fullscreenElement || !/Android/i.test(navigator.userAgent)) return;
  try { req.call(root, { navigationUI: 'hide' })?.catch?.(() => {}); } catch { /* */ }
}

// ---------------------------------------------------------------- network

function connect() {
  if (typeof window.io !== 'function') {
    showError('📡', 'Game server not found', 'Start the game on the computer (npm start), then scan the QR code again.', true);
    return;
  }
  const socket = window.io({ reconnectionDelay: 500, reconnectionDelayMax: 3000, timeout: 8000 });
  state.socket = socket;
  socket.on('connect', () => {
    state.socketUp = true;
    renderConn();
    if (state.joined || (profile.name && state.room && !state.editing && state.screen === 'connecting' && store.get('joinedRoom') === state.room)) join(true);
    else if (state.screen === 'connecting') showJoin();
  });
  socket.on('disconnect', () => { state.socketUp = false; renderConn(); });
  socket.on('connect_error', () => {
    state.socketUp = false;
    renderConn();
    if (!state.joined && state.screen === 'connecting') $('connecting-sub').textContent = 'Still looking… is this phone on the same Wi-Fi as the TV?';
  });
  socket.on('state', (s) => { state.display = s; render(); });
  socket.on('event', onEvent);
  socket.on('profile:updated', (p) => {
    if (!p) return;
    Object.assign(profile, { name: p.name || profile.name, color: p.color || profile.color, character: p.character || profile.character, hand: p.hand || profile.hand });
    saveLocal();
    applyAccent();
    render();
  });
  socket.on('display:gone', () => { state.displayGone = true; renderConn(); });
  socket.on('display:back', () => { state.displayGone = false; renderConn(); });
  socket.on('kicked', (p) => {
    state.joined = false;
    store.set('joinedRoom', '');
    const why = p?.reason === 'reconnected' ? 'This phone connected again in another tab.' : p?.reason === 'replaced' ? 'Someone else took your spot while you were away.' : 'You were removed on the TV.';
    showError('👋', 'Disconnected', why, false);
  });
  socket.on('room:closed', () => {
    state.joined = false;
    store.set('joinedRoom', '');
    showError('📺', 'The game has closed', 'Scan the new QR code on the TV, or enter its room code.', false);
  });
  // The TV went to Bowling / Krishiv Kart: follow it.
  socket.on('hub:goto', ({ game, url }) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
    const name = GAMES.find((g) => g.id === game)?.name || 'the game';
    $('goto-title').textContent = `Switching to ${name}…`;
    $('goto-sub').textContent = game === 'kart' ? 'Tap “Tap to start” when it opens.' : 'Tap “Join” when it opens.';
    $('goto-link').href = url;
    setScreen('goto');
    haptic([30, 40, 30]);
    setTimeout(() => { location.href = url; }, 600);
  });
  setInterval(() => {
    if (!socket.connected) return;
    const t0 = performance.now();
    socket.timeout(3000).emit('net:ping', {}, (err) => { if (!err) { state.rtt = state.rtt * 0.6 + (performance.now() - t0) * 0.4; renderConn(); } });
  }, 2000);
}

function renderConn() {
  const c = $('conn');
  c.classList.toggle('ok', state.socketUp && !state.displayGone);
  c.classList.toggle('bad', !state.socketUp || state.displayGone);
  $('conn-text').textContent = !state.socketUp ? 'offline' : state.displayGone ? 'no TV' : `${Math.round(state.rtt)} ms`;
}

function join(silent = false) {
  const socket = state.socket;
  if (!socket || !socket.connected || state.joining) return;
  if (!state.room) { showCode(); return; }
  state.joining = true;
  socket.timeout(5000).emit('remote:join', { room: state.room, clientId, name: profile.name, color: profile.color, character: profile.character, hand: profile.hand }, (err, res) => {
    state.joining = false;
    if (err) { if (!silent) toast('The game did not answer — trying again…'); setTimeout(() => join(silent), 1500); return; }
    if (!res?.ok) {
      if (silent && res?.code === 'no_room' && state.rejoinTries++ < 40) {
        state.rejoining = true;
        setScreen('connecting');
        $('connecting-title').textContent = 'Waiting for the TV…';
        $('connecting-sub').textContent = `Room ${state.room} will be back in a moment`;
        setTimeout(() => { if (state.socket?.connected) join(true); }, 1500);
        return;
      }
      state.rejoining = false;
      state.rejoinTries = 0;
      state.joined = false;
      if (res?.code === 'no_room' || res?.code === 'bad_code') { showCode(res.error); return; }
      showError(res?.code === 'full' ? '🎮' : '⚠️', res?.code === 'full' ? 'The game is full' : 'Could not join', res?.error || 'Try again.', true);
      return;
    }
    state.joined = true;
    state.rejoining = false;
    state.rejoinTries = 0;
    state.slot = res.slot;
    state.displayGone = !res.displayConnected;
    renderConn();
    store.set('room', state.room);
    store.set('joinedRoom', state.room);
    Object.assign(profile, { name: res.name, color: res.color, hand: res.hand || profile.hand, character: res.character || profile.character });
    saveLocal();
    applyAccent();
    if (!silent) haptic(30);
    if (!state.display) setScreen('wait');
    render();
    checkSensors();
  });
}

function saveLocal() {
  store.set('name', profile.name);
  store.set('hand', profile.hand);
  store.set('character', profile.character);
  if (profile.color) store.set('color', profile.color);
  tennis.hand = profile.hand;
  golf.hand = profile.hand;
}

function saveProfile() {
  const socket = state.socket;
  profile.name = cleanName($('name-input').value) || profile.name;
  saveLocal();
  if (!socket?.connected || !state.joined) return;
  socket.timeout(4000).emit('remote:profile', { name: profile.name, color: profile.color, character: profile.character, hand: profile.hand }, (err, res) => {
    if (err || !res?.ok) return;
    if (res.color !== profile.color) toast('That colour is taken');
    Object.assign(profile, { name: res.name, color: res.color, hand: res.hand, character: res.character || profile.character });
    saveLocal();
    applyAccent();
    render();
  });
}

function send(msg) {
  const s = state.socket;
  if (s?.connected) s.emit('remote:input', msg);
}
const sendVolatile = (msg) => { const s = state.socket; if (s?.connected) s.volatile.emit('remote:input', msg); };

// Acknowledged, retried with the same id (the TV ignores repeats).
function sendReliable(msg, onFail) {
  const until = performance.now() + 5000;
  const attempt = () => {
    const s = state.socket;
    if (performance.now() > until) { onFail?.(); return; }
    if (!s?.connected) { setTimeout(attempt, 300); return; }
    s.timeout(900).emit('remote:input', msg, (err, res) => { if (err || !res?.ok) setTimeout(attempt, res?.error === 'not connected' ? 300 : 120); });
  };
  attempt();
}

function menu(action, value, opts) { send({ t: 'menu', action, ...(value !== undefined ? { value } : {}), ...(opts ? { opts } : {}) }); }

function onEvent(ev) {
  if (!ev || typeof ev.type !== 'string') return;
  if (ev.type === 'vibrate' && Array.isArray(ev.pattern)) haptic(ev.pattern);
  if (ev.type === 'toast' && ev.text) toast(String(ev.text));
  if (ev.type === 'flash') flash();
  if (ev.type === 'sound') {
    if (ev.name === 'turn') beep([[523, 0.09], [659, 0.09], [784, 0.16]]);
    if (ev.name === 'win') beep([[784, 0.08], [988, 0.08], [1175, 0.08], [1568, 0.22]], 'square', 0.1);
    if (ev.name === 'point') beep([[659, 0.08], [988, 0.14]], 'square', 0.1);
    if (ev.name === 'hit') pock(ev.k ?? 0.7);
    if (ev.name === 'miss') beep([[220, 0.12]], 'sine', 0.2);
    if (ev.name === 'cup') beep([[880, 0.06], [740, 0.06], [988, 0.18]]);
  }
  if (ev.type === 'feedback') showFeedback(ev.text, ev.tone);
}

function showFeedback(text, tone = '') {
  const el = state.screen === 'golf' ? $('g-sub') : $('t-feedback');
  if (state.screen === 'tennis') {
    el.textContent = text || '';
    el.className = `feedback ${tone || ''}`;
    clearTimeout(showFeedback._t);
    showFeedback._t = setTimeout(() => { el.textContent = ''; }, 2600);
  }
}

// ---------------------------------------------------------------- streams (live club)

function updateStreams() {
  // Golf: live club angle so the TV golfer mirrors the swing.
  const g = state.display?.game;
  const wantClub = state.screen === 'golf' && g?.yourTurn && g?.step === 'aim' && motionMode();
  if (wantClub && !state.clubTimer) {
    state.clubTimer = setInterval(() => {
      sendVolatile({ t: 'gclub', a: Math.round(golf.angle * 10) / 10, r: Math.round(golf.rate), armed: state.grip.held });
      renderGolfMeterLive();
    }, 50);
  } else if (!wantClub && state.clubTimer) {
    clearInterval(state.clubTimer);
    state.clubTimer = null;
    golf.cancel();
  }
}

// ---------------------------------------------------------------- rendering

function applyAccent() {
  document.documentElement.style.setProperty('--accent', colorHex(profile.color));
  $('me-pip').textContent = state.slot !== null ? `P${state.slot + 1}` : 'P?';
  $('me-name').textContent = profile.name || 'Player';
  $('me-icon').textContent = getCharacter(profile.character).icon;
  // The badge on the waiting and lobby screens.
  for (const e of document.querySelectorAll('.b-face')) e.textContent = getCharacter(profile.character).icon;
  for (const e of document.querySelectorAll('.b-slot')) e.textContent = state.slot !== null ? `Player ${state.slot + 1}` : 'Player';
  for (const e of document.querySelectorAll('.b-name')) e.textContent = profile.name || 'Player';
}

function render() {
  if (!state.joined || state.rejoining) return;
  applyAccent();
  if (state.editing) { setScreen('join'); return; }
  const d = state.display;
  body.classList.toggle('host', !!d?.host);
  if (!d) { setScreen('wait'); renderWait(null); return; }
  $('tb-mid').textContent = d.gameId ? GAMES.find((g) => g.id === d.gameId)?.name || '' : '';
  if (d.phase === 'paused') { setScreen('paused'); $('btn-quit').hidden = !d.host; grip(false); return; }
  if (d.game) {
    if (d.game.kind === 'tennis') { if (d.game.over) renderOver(d); else { setScreen('tennis'); renderTennis(d); } }
    else if (d.game.kind === 'golf') { if (d.game.over) renderOver(d); else { setScreen('golf'); renderGolf(d); } }
    updateStreams();
    return;
  }
  grip(false);
  if (d.lobby) { setScreen('lobby'); renderLobby(d); return; }
  setScreen('wait');
  renderWait(d);
}

// The TV is on the games menu (or starting Bowling / Krishiv Kart).
function renderWait(d) {
  const launching = d?.phase === 'launching';
  $('wait-icon').textContent = launching ? '🚀' : '📺';
  $('wait-title').textContent = launching ? 'Starting the game…' : 'Pick a game on the TV';
  $('wait-sub').textContent = launching
    ? 'This phone switches over by itself.'
    : 'Tennis and Golf open their lobby on the TV and this phone joins by itself.';
}

// A game's lobby: who is in, and (for the host) the settings and Start.
function renderLobby(d) {
  const m = d.lobby;
  const game = GAMES.find((g) => g.id === m.game);
  $('lobby-icon').textContent = game?.icon || '🎮';
  $('lobby-title').textContent = game?.name || '';
  $('lobby-sub').textContent = d.host ? 'You’re the host — choose and start' : `${d.hostName || 'Player 1'} chooses and starts`;
  const pl = $('lobby-players');
  pl.replaceChildren();
  for (const p of d.players || []) {
    const chip = make('span', p.connected ? '' : 'off', null, pl);
    chip.style.setProperty('--c', colorHex(p.color));
    make('i', null, getCharacter(p.character).icon, chip);
    chip.append(`${p.name}${p.isYou ? ' (you)' : ''}${p.local ? ' ⌨️' : ''}`);
  }
  const box = $('lobby-settings');
  box.replaceChildren();
  if (d.host) {
    const group = (label, items, cur, key) => {
      const g = make('div', 'opt-group', null, box);
      make('span', null, label, g);
      const list = make('div', 'opt-list', null, g);
      for (const it of items) {
        const b = make('button', `opt-btn${it.id === cur ? ' on' : ''}`, it.short || it.label, list);
        if (it.sub) make('small', null, it.sub, b);
        b.addEventListener('click', () => { haptic(10); menu('setup', undefined, { [key]: it.id }); });
      }
    };
    if (m.game === 'tennis' && m.tennis) {
      const t = m.tennis;
      if (t.teams?.length) {
        const teams = make('div', 'mini-teams', null, box);
        t.teams.forEach((team, i) => {
          const el = make('div', 'mini-team', null, teams);
          el.style.setProperty('--tc', i ? '#e8384f' : '#2f7bf5');
          el.style.setProperty('--tb', i ? '#ffecef' : '#eaf2ff');
          team.forEach((p, k) => make('div', null, `${k ? 'Net' : 'Back'}: ${p.cpu ? '🤖 CPU' : `${getCharacter(p.character).icon} ${p.name}`}`, el));
        });
      }
      if (t.presets.length > 1) group('Teams', t.presets, t.preset, 'preset');
      group('Match', TENNIS_FORMATS, t.format, 'format');
      group('CPU skill', CPU_LEVELS, t.level, 'level');
    }
    if (m.game === 'golf' && m.golf) group('Course', GOLF_COURSES.map((c) => ({ id: c.id, label: c.label, sub: c.sub })), m.golf.course, 'course');
  }
  const start = $('btn-lobby-start');
  const loading = d.phase === 'loading';
  start.hidden = !d.host;
  start.disabled = !m.canStart || loading;
  start.textContent = loading ? 'Starting…' : m.canStart ? 'Start ▶' : 'Waiting for players…';
  $('lobby-note').textContent = loading ? 'Getting the game ready…' : d.host ? 'The TV shows the same choices.' : `Waiting for ${d.hostName || 'Player 1'} to start…`;
}

// ---------------------------------------------------------------- tennis

function renderTennis(d) {
  const g = d.game;
  // Score strip.
  const sc = $('t-score');
  sc.replaceChildren();
  if (g.score) {
    const [a, b] = g.score.teams;
    const left = make('div', 'side', null, sc);
    make('div', 'games', '●'.repeat(a.games) || ' ', left);
    make('small', null, a.names, left);
    const pts = make('div', 'pts', null, sc);
    make('i', null, a.label, pts);
    make('i', null, b.label, pts);
    const right = make('div', 'side r', null, sc);
    make('div', 'games', '●'.repeat(b.games) || ' ', right);
    make('small', null, b.names, right);
  }
  const status = $('t-status');
  const title = $('t-title'), sub = $('t-sub');
  status.className = 'status-card';
  $('btn-toss').hidden = true;
  const touch = !motionMode();
  $('swipe-pad').hidden = !touch;
  if (g.serving && !g.tossed) {
    title.textContent = 'Your serve!';
    sub.textContent = touch ? 'Tap TOSS, then swipe to hit' : 'Flick the phone up to toss (or tap TOSS), then swing';
    status.classList.add('go');
    $('btn-toss').hidden = false;
  } else if (g.serving && g.tossed) {
    title.textContent = 'Swing!';
    sub.textContent = 'Hit it at the top for a fastball';
    status.classList.add('go', 'pulse');
  } else if (g.yourBall) {
    title.textContent = 'Swing!';
    sub.textContent = g.hitter ? `${g.hitter === 'front' ? 'Your net player' : 'Your back player'} is on it` : '';
    status.classList.add('go', 'pulse');
  } else {
    title.textContent = g.msg?.title || (g.step === 'rally' ? 'Rally!' : 'Get ready');
    sub.textContent = g.msg?.sub || (touch ? 'Swipe across the pad to swing' : 'Hold your phone like a racket handle');
    if (g.step !== 'rally') status.classList.add('wait');
  }
  $('t-role').textContent = g.role || '';
  const key = `${g.point}`;
  if (g.serving && key !== state.lastTennisKey) { flash(); haptic([30, 50, 30]); }
  state.lastTennisKey = key;
}

function onTennisSwing(ev, peakAt) {
  const d = state.display;
  if (!d?.game || d.game.kind !== 'tennis') return;
  const age = Math.max(0, Math.round(performance.now() - peakAt));
  const msg = { t: 'tswing', side: ev.side, speed: ev.speed, plane: ev.plane, roll: ev.roll, lag: Math.round(state.rtt / 2), age, id: ++state.swingSeq, mode: 'motion' };
  send(msg);
  haptic(12);
  pock(0.3 + ev.speed * 0.4);
}

// Touch: swipe across the pad.
function wireSwipe() {
  const pad = $('swipe-pad');
  let p0 = null;
  pad.addEventListener('pointerdown', (e) => { p0 = { x: e.clientX, y: e.clientY, t: performance.now() }; pad.setPointerCapture(e.pointerId); });
  pad.addEventListener('pointerup', (e) => {
    if (!p0) return;
    const dx = e.clientX - p0.x, dy = e.clientY - p0.y, dt = Math.max(30, performance.now() - p0.t);
    p0 = null;
    const dist = Math.hypot(dx, dy);
    if (dist < 40) {
      // A tap = toss when serving.
      if (state.display?.game?.serving && !state.display.game.tossed) send({ t: 'btn', b: 'a', down: true });
      return;
    }
    const speed = Math.min(1.2, (dist / dt) * 0.9);
    const right = profile.hand !== 'left';
    const side = Math.abs(dx) < Math.abs(dy) * 0.6 ? 'oh' : ((dx < 0) === right ? 'fh' : 'bh');
    const plane = Math.max(-1, Math.min(1, -dy / Math.max(60, Math.abs(dx)) * 0.9));
    send({ t: 'tswing', side, speed, plane, roll: 0, lag: Math.round(state.rtt / 2), age: 0, id: ++state.swingSeq, mode: 'touch' });
    haptic(12);
    pock(0.5);
  });
}

// ---------------------------------------------------------------- golf

const CLUB_NAMES = { driver: 'Driver', iron: 'Iron', wedge: 'Wedge', putter: 'Putter' };

function renderGolf(d) {
  const g = d.game;
  const info = $('g-info');
  info.replaceChildren();
  const cell = (k, v) => { const c = make('div', null, null, info); make('small', null, k, c); make('b', null, v, c); };
  cell('Hole', `${g.hole}`);
  cell('Par', `${g.par}`);
  cell(g.unit === 'ft' ? 'To hole' : 'To pin', g.toPin ?? '–');
  cell('Wind', g.wind ?? '–');
  const status = $('g-status');
  status.className = 'status-card small';
  const mine = g.yourTurn;
  const aiming = mine && g.step === 'aim';
  $('g-controls').hidden = !aiming;
  grip(aiming, g.blocked);
  if (aiming) {
    status.classList.add('go');
    $('g-title').textContent = `Your shot · ${ordinalShot(g.stroke)}`;
    $('g-sub').textContent = motionMode()
      ? `${g.lie || ''}${g.cap < 1 ? ` · max ${Math.round(g.cap * 4)} dot${g.cap > 0.26 ? 's' : ''}` : ''} · hold A and swing`
      : `${g.lie || ''} · pull the A pad down and let go`;
    $('g-club').textContent = CLUB_NAMES[g.club] || g.club;
    golf.setClub(g.club);
    golf.strength = settings.strength;
    $('g-one').classList.toggle('on', !!g.view1);
    $('g-two').classList.toggle('on', !!g.view2);
    $('g-meter-cap').style.display = g.cap < 1 ? 'block' : 'none';
    $('g-meter-cap').style.left = `${(g.cap / 1.25) * 100}%`;
  } else {
    status.classList.add('wait');
    $('g-title').textContent = g.msg?.title || (mine ? 'Watch your ball…' : g.turnName ? `${g.turnName} is up` : 'Get ready');
    $('g-sub').textContent = g.msg?.sub || (g.nextIsYou ? 'You’re next' : '');
  }
  // Mini scorecard.
  const card = $('g-card');
  card.replaceChildren();
  for (const r of g.card || []) {
    const row = make('div', `row${r.you ? ' you' : ''}${r.turn ? ' turn' : ''}`, null, card);
    row.style.setProperty('--c', colorHex(r.color));
    make('span', 'dot', null, row);
    make('span', 'n', r.name, row);
    make('span', 'v', r.status || '', row);
    make('b', null, r.toPar, row);
  }
  if (g.lastPower !== undefined && g.lastPower !== null && !aiming) setMeter(g.lastPower, g.lastOver);
}

const ordinalShot = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

function setMeter(p, over) {
  const pct = Math.max(0, Math.min(1.25, p)) / 1.25 * 100;
  $('g-meter-fill').style.width = `${pct}%`;
  $('g-meter').classList.toggle('over', !!over);
}

function renderGolfMeterLive() {
  if (golf.state === 'down') setMeter(golf.live, golf.live > (state.display?.game?.cap ?? 1));
  else if (golf.state === 'back') setMeter(golf.backLevel * 0.3, false);
}

function onGolfSwing(ev) {
  const d = state.display;
  const g = d?.game;
  if (!g || g.kind !== 'golf' || !g.yourTurn || g.step !== 'aim') return;
  const practice = !state.grip.held;
  const msg = { t: 'gswing', power: ev.power, curve: ev.curve, practice, peak: ev.peak, back: ev.back, id: ++state.swingSeq, mode: 'motion' };
  setMeter(ev.power, ev.power > (g.cap ?? 1));
  if (practice) { send(msg); haptic(8); return; }
  sendReliable(msg, () => toast('The TV didn’t get that swing — try again'));
  haptic([20, 30, 20]);
  pock(Math.min(1, ev.power));
  releaseGrip(true);
}

// The A grip: hold while swinging (motion), or pull down and let go (touch).
function grip(on, blocked = false) {
  body.classList.toggle('grip-on', !!on);
  $('grip').classList.toggle('blocked', !!blocked);
  if (!on) releaseGrip(true);
  $('grip-label').textContent = motionMode() ? 'HOLD A + SWING' : 'PULL DOWN, LET GO';
  $('grip-sub').textContent = motionMode() ? 'Swing without A to practise' : 'How far you pull = power · red line = full';
}

function releaseGrip(silent = false) {
  const gr = state.grip;
  if (!gr.held) return;
  gr.held = false;
  gr.pointer = null;
  $('grip').classList.remove('held');
  $('pull').firstElementChild.style.height = '0';
  if (!silent) send({ t: 'btn', b: 'a', down: false });
}

function wireGrip() {
  const el = $('grip');
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const g = state.display?.game;
    if (!g?.yourTurn || g.step !== 'aim' || g.blocked) { toast('Wait for your turn'); return; }
    unlockAudio();
    const gr = state.grip;
    if (gr.held) return;
    gr.held = true;
    gr.pointer = e.pointerId;
    gr.startY = e.clientY;
    gr.startX = e.clientX;
    gr.pull = 0;
    try { el.setPointerCapture(e.pointerId); } catch { /* */ }
    el.classList.add('held');
    send({ t: 'btn', b: 'a', down: true });
    haptic(10);
    keepAwake();
  });
  el.addEventListener('pointermove', (e) => {
    const gr = state.grip;
    if (!gr.held || e.pointerId !== gr.pointer || motionMode()) return;
    const h = el.getBoundingClientRect().height * 0.8;
    gr.pull = Math.max(0, (e.clientY - gr.startY) / h) * 1.25;
    gr.x = (e.clientX - gr.startX) / el.getBoundingClientRect().width;
    $('pull').firstElementChild.style.height = `${Math.min(100, gr.pull / 1.25 * 100)}%`;
    setMeter(gr.pull, gr.pull > (state.display?.game?.cap ?? 1));
    sendVolatile({ t: 'gclub', a: Math.min(170, gr.pull * 130), r: 0, armed: true });
  });
  const up = (e) => {
    const gr = state.grip;
    if (!gr.held || e.pointerId !== gr.pointer) return;
    if (!motionMode()) {
      const g = state.display?.game;
      if (gr.pull > 0.05 && g?.yourTurn && g.step === 'aim') {
        const msg = { t: 'gswing', power: Math.round(gr.pull * 1000) / 1000, curve: Math.max(-1, Math.min(1, gr.x * 2.5)), practice: false, peak: 0, back: gr.pull * 130, id: ++state.swingSeq, mode: 'touch' };
        sendReliable(msg, () => toast('The TV didn’t get that swing — try again'));
        pock(Math.min(1, gr.pull));
        haptic([20, 30, 20]);
      }
    }
    releaseGrip(false);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  for (const ev of ['touchstart', 'touchmove']) el.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}

// ---------------------------------------------------------------- over

function renderOver(d) {
  setScreen('over');
  grip(false);
  const g = d.game;
  const o = g.over || {};
  $('over-icon').textContent = o.won ? '🏆' : o.icon || '🎉';
  $('over-title').textContent = o.title || 'Game over';
  $('over-sub').textContent = o.sub || '';
  const list = $('over-standings');
  list.replaceChildren();
  for (const s of o.standings || []) {
    const li = make('li', `${s.place === 1 ? 'first' : ''}${s.you ? ' you' : ''}`, null, list);
    make('span', 'place', s.placeLabel || `${s.place}`, li);
    make('span', 'n', s.name, li);
    make('span', 'v', s.value, li);
  }
  $('btn-again').hidden = !d.host;
  $('btn-lobby').hidden = !d.host;
  $('over-note').textContent = d.host ? '' : `Waiting for ${d.hostName || 'Player 1'}…`;
}

// ---------------------------------------------------------------- join / code / error screens

function showJoin() {
  setScreen('join');
  $('name-input').value = profile.name || '';
  renderCharacters();
  renderSwatches();
  renderHand();
  $('btn-join').textContent = state.editing ? 'Save' : profile.name ? `Join as ${profile.name}` : 'Join';
}

function renderCharacters() {
  const box = $('char-grid');
  box.replaceChildren();
  for (const c of BRAINROT_CHARACTERS) {
    const card = make('button', `char-card${profile.character === c.id ? ' active' : ''}${c.isMain ? ' is-main' : ''}`, null, box);
    card.type = 'button';
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(profile.character === c.id));
    card.setAttribute('aria-label', c.name);
    make('span', 'ci', c.icon, card);
    make('b', null, c.shortName, card);
    card.addEventListener('click', () => {
      const wasDefault = !$('name-input').value || BRAINROT_CHARACTERS.some((x) => x.shortName === $('name-input').value) || /^Player/.test($('name-input').value);
      profile.character = c.id;
      if (wasDefault) $('name-input').value = c.shortName;
      haptic(15);
      renderCharacters();
    });
  }
}

function renderSwatches() {
  const box = $('swatches');
  box.replaceChildren();
  const taken = new Set((state.display?.players || []).filter((p) => !p.isYou).map((p) => p.color));
  for (const c of PLAYER_COLORS) {
    const b = make('button', 'swatch', null, box);
    b.type = 'button';
    b.style.setProperty('--c', c.hex);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c.name);
    b.setAttribute('aria-checked', String(profile.color === c.id));
    b.disabled = taken.has(c.id);
    b.addEventListener('click', () => { profile.color = c.id; renderSwatches(); });
  }
}

function renderHand() { for (const b of $('hand-seg').children) b.setAttribute('aria-checked', String(b.dataset.hand === profile.hand)); }

function showCode(err) {
  setScreen('code');
  $('code-error').textContent = err || '';
  $('code-input').value = state.room || '';
}

function showError(icon, title, text, canRetry) {
  state.editing = false;
  state.rejoining = false;
  $('error-icon').textContent = icon;
  $('error-title').textContent = title;
  $('error-text').textContent = text;
  $('btn-error-retry').hidden = !canRetry && !state.room;
  setScreen('error');
}

// ---------------------------------------------------------------- buttons

function holdButton(id, b) {
  const el = $(id);
  const down = (e) => {
    e.preventDefault();
    if (el.classList.contains('down')) return;
    el.classList.add('down');
    try { el.setPointerCapture(e.pointerId); } catch { /* */ }
    send({ t: 'btn', b, down: true });
    haptic(8);
  };
  const upFn = () => {
    if (!el.classList.contains('down')) return;
    el.classList.remove('down');
    send({ t: 'btn', b, down: false });
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', upFn);
  el.addEventListener('pointercancel', upFn);
  el.addEventListener('lostpointercapture', upFn);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function wireUi() {
  wireGrip();
  wireSwipe();
  holdButton('g-left', 'left');
  holdButton('g-right', 'right');
  holdButton('g-up', 'up');
  holdButton('g-down', 'down');
  holdButton('g-one', 'one');
  holdButton('g-two', 'two');
  $('btn-toss').addEventListener('click', () => { unlockAudio(); send({ t: 'btn', b: 'a', down: true }); send({ t: 'btn', b: 'a', down: false }); haptic(15); });
  $('btn-plus').addEventListener('click', () => menu('pause'));
  $('btn-resume').addEventListener('click', () => menu('resume'));
  $('btn-quit').addEventListener('click', () => menu('quit'));
  $('btn-again').addEventListener('click', () => menu('again'));
  $('btn-lobby').addEventListener('click', () => menu('lobby'));
  $('btn-lobby-start').addEventListener('click', () => { unlockAudio(); haptic(15); menu('start'); });

  for (const b of document.querySelectorAll('.btn-edit')) b.addEventListener('click', () => { state.editing = true; showJoin(); });
  $('btn-join').addEventListener('click', () => {
    let ask = null;
    if (window.isSecureContext && needsPermission() && settings.mode === 'motion') ask = askMotion();
    unlockAudio();
    keepAwake();
    goFullscreen();
    ask?.then(() => checkSensors());
    profile.name = cleanName($('name-input').value) || profile.name || getCharacter(profile.character).shortName;
    saveLocal();
    if (state.editing) { state.editing = false; saveProfile(); render(); return; }
    setScreen('connecting');
    $('connecting-title').textContent = 'Joining…';
    join(false);
  });
  for (const b of $('hand-seg').children) b.addEventListener('click', () => { profile.hand = b.dataset.hand; renderHand(); });
  $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('name-input').blur(); });
  $('btn-code').addEventListener('click', () => {
    const code = normalizeRoomCode($('code-input').value);
    if (!code) { $('code-error').textContent = 'Room codes are 4 letters.'; return; }
    state.room = code;
    history.replaceState(null, '', `${location.pathname}?room=${code}`);
    showJoin();
  });
  $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-code').click(); });
  $('btn-error-retry').addEventListener('click', () => { if (state.room) showJoin(); else showCode(); });
  $('btn-error-code').addEventListener('click', () => showCode());
  $('btn-insecure-touch').addEventListener('click', () => { settings.mode = 'touch'; store.set('mode', 'touch'); setScreen('connecting'); connect(); });

  $('tapgate').addEventListener('click', () => {
    askMotion().then(() => { checkSensors(); });
    unlockAudio();
    keepAwake();
    $('tapgate').hidden = true;
  });

  $('btn-settings').addEventListener('click', () => { renderMode(); $('opt-invert').checked = settings.invert; $('opt-sound').checked = settings.sound; $('settings').hidden = false; });
  $('btn-settings-close').addEventListener('click', () => { $('settings').hidden = true; });
  $('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').hidden = true; });
  for (const b of $('mode-seg').children) {
    b.addEventListener('click', () => {
      settings.mode = b.dataset.mode;
      store.set('mode', settings.mode);
      if (settings.mode === 'motion' && needsPermission()) askMotion().then(() => checkSensors());
      state.motion.touchFallback = false;
      renderMode();
      checkSensors();
      render();
    });
  }
  for (const b of $('strength-seg').children) b.addEventListener('click', () => { settings.strength = Number(b.dataset.strength); store.set('strength', settings.strength); golf.strength = settings.strength; renderMode(); });
  $('opt-invert').addEventListener('change', (e) => { settings.invert = e.target.checked; store.set('invert', settings.invert ? '1' : '0'); tennis.invertSpin = settings.invert; golf.invertCurve = settings.invert; });
  $('opt-sound').addEventListener('change', (e) => { settings.sound = e.target.checked; store.set('sound', settings.sound ? '1' : '0'); unlockAudio(); });
  $('btn-motion-retry').addEventListener('click', () => askMotion().then(() => { state.motion.touchFallback = false; checkSensors(); renderMode(); }));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { releaseGrip(false); golf.cancel(); }
    else { keepAwake(); checkSensors(); }
  });
  document.addEventListener('pointerup', () => { if (state.joined) keepAwake(); }, { passive: true });
  for (const ev of ['gesturestart', 'dblclick']) document.addEventListener(ev, (e) => e.preventDefault());
}

// ---------------------------------------------------------------- boot

function boot() {
  wireUi();
  applyAccent();
  renderMode();
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!window.isSecureContext && !loopback && settings.mode !== 'touch') {
    const link = $('insecure-link');
    link.href = `https://${location.hostname}:${NET.httpsPort}/play${location.search}`;
    fetch('/api/info').then((r) => r.json()).then((info) => {
      if (Number.isInteger(info?.httpsPort)) link.href = `https://${location.hostname}:${info.httpsPort}/play${location.search}`;
    }).catch(() => {});
    setScreen('insecure');
    return;
  }
  connect();
  if (!state.room) showCode();
  setInterval(checkSensors, 3000);
}

// Test hook (synthetic sensor runs in headless Chrome).
window.__phone = { state, settings, profile, tennis, golf, onTennisSwing, onGolfSwing, send };

boot();
