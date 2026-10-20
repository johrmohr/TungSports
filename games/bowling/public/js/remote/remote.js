// Phone remote: joins the TV's room as one of four players and works like a
// motion controller — ◀ ▶ to move / turn, A to switch, ▲ to zoom, hold B and swing,
// lift your thumb to bowl. See swing.js for the motion analysis.

import { SwingDetector, upFromOrientation } from './swing.js';
import { releaseGrade, RELEASE_ZONE } from '../shared/throw.js';
import {
  PLAYER_COLORS, colorHex, normalizeRoomCode, cleanName, NAME_MAX, NET,
  BRAINROT_CHARACTERS, DEFAULT_CHARACTER, getCharacter,
} from '../shared/protocol.js';

const $ = (id) => document.getElementById(id);
const body = document.body;

// ---------------------------------------------------------------- storage

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(`bowl.${k}`); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`bowl.${k}`, String(v)); } catch { /* private mode */ } },
};

function newId() {
  const a = new Uint8Array(12);
  (globalThis.crypto || window.msCrypto).getRandomValues(a);
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
  invertSpin: store.get('invert', '0') === '1',
  sound: store.get('sound', '1') !== '0',
};

const state = {
  room: normalizeRoomCode(params.get('room')) || null,
  screen: 'connecting',
  socket: null,
  socketUp: false,
  joined: false,          // we have a slot in the room (rejoin silently on reconnect)
  joining: false,
  rejoining: false,       // waiting for the TV to re-open the room after a restart
  rejoinTries: 0,
  editing: false,
  slot: null,
  display: null,          // last state from the TV
  displayGone: false,
  rtt: null,
  watchUntil: 0,          // after our throw, show "Rolling…" until the TV catches up
  watchText: null,
  lastTurnKey: '',
  motion: { asked: false, denied: false, events: 0, gyroEvents: 0, lastAt: 0, orient: null, orientAt: 0, touchFallback: false },
  grip: { active: false, pointers: new Set(), mode: 'motion', path: [], streamTimer: null, startedAt: 0 },
  throwSeq: Math.floor(Math.random() * 1e6),
};

const swing = new SwingDetector({ invertSpin: settings.invertSpin });

// ---------------------------------------------------------------- screens

function setScreen(name) {
  if (state.screen === name) return;
  state.screen = name;
  body.dataset.screen = name;
  if (name !== 'aim' && state.grip.active) cancelGrip('screen');
}

function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function flash() {
  body.classList.remove('flash');
  void body.offsetWidth;
  body.classList.add('flash');
}

function haptic(pattern) {
  if (typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(pattern); } catch { /* needs activation */ }
}

// ---------------------------------------------------------------- phone sounds (the controller's speaker)

let actx = null;
function unlockAudio() {
  try {
    if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC(); }
    if (actx && actx.state === 'suspended') actx.resume();
  } catch { /* ignore */ }
}
function beep(seq, type = 'triangle', vol = 0.2) {
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
// Release: a soft whoosh, then the first moments of the roll (the TV takes over).
function releaseSound(speed) {
  if (!actx || !settings.sound) return;
  const t = actx.currentTime + 0.005;
  const len = Math.floor(actx.sampleRate * 0.9);
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const d = buf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < len; i++) { b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = b * 3.5; }
  const src = actx.createBufferSource();
  src.buffer = buf;
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 300 + speed * 300;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.9, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
  src.connect(lp).connect(g).connect(actx.destination);
  src.start(t);
}

// ---------------------------------------------------------------- motion sensors

const needsPermission = () =>
  (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') ||
  (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function');

// Must run synchronously inside a click / touchend (iOS).
function askMotion() {
  state.motion.asked = true;
  state.motion.asking = true;
  const asks = [];
  for (const C of [window.DeviceMotionEvent, window.DeviceOrientationEvent]) {
    if (C && typeof C.requestPermission === 'function') {
      try { asks.push(C.requestPermission().catch(() => 'denied')); } catch { asks.push(Promise.resolve('denied')); }
    }
  }
  if (!asks.length) { state.motion.asking = false; return Promise.resolve('unsupported'); }
  return Promise.all(asks).then((r) => {
    state.motion.asking = false;
    return r.includes('granted') ? 'granted' : 'denied';
  });
}

function onMotion(e) {
  const rr = e.rotationRate;
  const acc = e.accelerationIncludingGravity;
  const w = rr && rr.alpha !== null && rr.alpha !== undefined ? [Number(rr.alpha), Number(rr.beta), Number(rr.gamma)] : null;
  const a = acc && acc.x !== null && acc.x !== undefined ? [Number(acc.x), Number(acc.y), Number(acc.z)] : null;
  if (!w && !a) return;
  state.motion.events++;
  if (w) state.motion.gyroEvents++;
  state.motion.lastAt = performance.now();
  if (state.grip.active && state.grip.mode === 'motion') swing.sample(e.timeStamp, w, a);
}

function onOrientation(e) {
  if (e.beta === null || e.gamma === null || e.beta === undefined) return;
  state.motion.orient = upFromOrientation(Number(e.beta), Number(e.gamma));
  state.motion.orientAt = performance.now();
}

window.addEventListener('devicemotion', onMotion);
window.addEventListener('deviceorientation', onOrientation);

const motionLive = () => performance.now() - state.motion.lastAt < 1500 && state.motion.events > 3;
const throwMode = () => (settings.mode === 'touch' || state.motion.touchFallback || !window.isSecureContext ? 'touch' : 'motion');

function checkSensors() {
  clearTimeout(checkSensors._t);
  checkSensors._t = setTimeout(() => {
    if (state.motion.asking) { checkSensors(); return; }   // the Allow / Deny prompt is still open
    const fallback = settings.mode === 'motion' && !motionLive();
    if (fallback !== state.motion.touchFallback) {
      state.motion.touchFallback = fallback;
      if (fallback && state.joined) toast(state.motion.denied ? 'Motion is blocked — drag the ball to bowl (see ⚙)' : 'No motion sensor found — drag the ball to bowl');
    }
    renderMode();
  }, 1600);
}

function renderMode() {
  body.classList.toggle('touch', throwMode() === 'touch');
  $('grip-label').textContent = throwMode() === 'touch' ? 'DRAG THE BALL UP & LET GO' : 'HOLD';
  const s = $('sensor-status');
  if (!window.isSecureContext) s.textContent = 'Motion sensors need the secure (https) page. Using touch.';
  else if (state.motion.denied) s.textContent = 'Motion access was denied. On iPhone: close Safari fully, reopen this page and tap Allow.';
  else if (motionLive()) s.textContent = `Motion sensors: working${state.motion.gyroEvents ? ' (gyroscope)' : ' (accelerometer only)'}.`;
  else s.textContent = 'Motion sensors: no data yet.';
  $('btn-motion-retry').hidden = !(needsPermission() && (state.motion.denied || !motionLive()));
  for (const b of $('mode-seg').children) b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode));
}

// ---------------------------------------------------------------- wake lock / fullscreen

let wakeLock = null;
async function keepAwake() {
  if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not allowed right now — retried on the next tap */ }
}
function goFullscreen() {
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!req || document.fullscreenElement || !/Android/i.test(navigator.userAgent)) return;
  try {
    const p = req.call(root, { navigationUI: 'hide' });
    p?.then?.(() => screen.orientation?.lock?.('portrait').catch(() => {}), () => {});
  } catch { /* unsupported */ }
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
    if (state.joined) join(true);
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
    if (p.name) profile.name = p.name;
    if (p.color) profile.color = p.color;
    if (p.character) profile.character = p.character;
    if (p.hand) profile.hand = p.hand;
    applyAccent();
    render();
  });
  socket.on('display:gone', () => { state.displayGone = true; renderConn(); toast('The TV disconnected — waiting for it…', 3000); });
  socket.on('display:back', () => { state.displayGone = false; renderConn(); });
  socket.on('kicked', (p) => {
    state.joined = false;
    const why = p?.reason === 'reconnected' ? 'This phone connected again in another tab.' : p?.reason === 'replaced' ? 'Someone else took your spot while you were away.' : 'You were removed from the game on the TV.';
    showError('👋', 'Disconnected', why, false);
  });
  socket.on('room:closed', () => {
    state.joined = false;
    showError('🎳', 'The game has closed', 'Scan the new QR code on the TV, or enter its room code.', false);
  });
  setInterval(() => {
    if (!socket.connected) return;
    const t0 = performance.now();
    socket.timeout(3000).emit('net:ping', {}, (err) => { if (!err) { state.rtt = Math.round(performance.now() - t0); renderConn(); } });
  }, 3000);
}

function renderConn() {
  const c = $('conn');
  c.classList.toggle('ok', state.socketUp && !state.displayGone);
  c.classList.toggle('bad', !state.socketUp || state.displayGone);
  $('conn-text').textContent = !state.socketUp ? 'offline' : state.displayGone ? 'no TV' : state.rtt !== null ? `${state.rtt} ms` : 'online';
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
      // After a server restart the TV re-opens the same room a moment later:
      // a silent rejoin keeps trying for a minute before asking for a code.
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
      showError(res?.code === 'full' ? '🎳' : '⚠️', res?.code === 'full' ? 'The game is full' : 'Could not join', res?.error || 'Try again.', true);
      return;
    }
    state.joined = true;
    state.rejoining = false;
    state.rejoinTries = 0;
    state.slot = res.slot;
    state.displayGone = !res.displayConnected;
    renderConn();
    store.set('room', state.room);
    profile.name = res.name;
    profile.color = res.color;
    profile.hand = res.hand || profile.hand;
    if (res.character) {
      profile.character = res.character;
      store.set('character', profile.character);
    }
    applyAccent();
    if (!silent) haptic(30);
    if (!state.display) setScreen('lobby');
    render();
    checkSensors();
  });
}

function saveProfile() {
  const socket = state.socket;
  const name = cleanName($('name-input').value) || profile.name;
  profile.name = name;
  store.set('name', name);
  store.set('hand', profile.hand);
  store.set('character', profile.character);
  if (profile.color) store.set('color', profile.color);
  if (!socket?.connected || !state.joined) return;
  socket.timeout(4000).emit('remote:profile', { name, color: profile.color, character: profile.character, hand: profile.hand }, (err, res) => {
    if (err || !res?.ok) return;
    profile.name = res.name;
    if (res.color !== profile.color) toast('That colour is taken');
    profile.color = res.color;
    profile.hand = res.hand;
    if (res.character) profile.character = res.character;
    applyAccent();
    render();
  });
}

function send(msg) {
  const s = state.socket;
  if (s?.connected) s.emit('remote:input', msg);
}

// Throws are acknowledged; retried with the same id (the TV ignores repeats).
function sendThrow(th) {
  const msg = { t: 'throw', id: ++state.throwSeq, ...th };
  const until = performance.now() + 6000;          // covers a TV reconnect
  const giveUp = () => {
    if (th.quality === 'none') return;
    state.watchUntil = 0;
    toast('The TV didn\u2019t get that throw — try again', 3000);
    render();
  };
  const attempt = () => {
    const s = state.socket;
    if (performance.now() > until) { giveUp(); return; }
    if (!s?.connected) { setTimeout(attempt, 400); return; }
    s.timeout(900).emit('remote:input', msg, (err, res) => {
      if (err || !res?.ok) setTimeout(attempt, res?.error === 'not connected' ? 400 : 150);
    });
  };
  attempt();
}

function onEvent(ev) {
  if (!ev || typeof ev.type !== 'string') return;
  if (ev.type === 'vibrate' && Array.isArray(ev.pattern)) haptic(ev.pattern);
  if (ev.type === 'toast' && ev.text) toast(String(ev.text));
  if (ev.type === 'sound') {
    if (ev.name === 'turn') beep([[523, 0.09], [659, 0.09], [784, 0.16]]);
    if (ev.name === 'strike') beep([[784, 0.08], [988, 0.08], [1175, 0.08], [1568, 0.22]], 'square', 0.12);
    if (ev.name === 'spare') beep([[659, 0.08], [988, 0.18]], 'square', 0.12);
    if (ev.name === 'hit') beep([[180, 0.12]], 'sine', 0.3);
  }
  if (ev.type === 'flash') flash();
}

// ---------------------------------------------------------------- rendering

function applyAccent() {
  document.documentElement.style.setProperty('--accent', colorHex(profile.color));
  $('me-pip').textContent = state.slot !== null ? `P${state.slot + 1}` : 'P?';
  $('me-name').textContent = profile.name || 'Player';
}

function ballDot(color) {
  const d = document.createElement('span');
  d.className = 'pl-ball';
  d.style.setProperty('--c', colorHex(color));
  return d;
}

function render() {
  if (!state.joined || state.rejoining) return;
  applyAccent();
  if (state.editing) { setScreen('join'); return; }
  const d = state.display;
  if (!d) { setScreen('lobby'); renderLobby(null); return; }
  const turn = d.turn || null;
  if (d.phase !== 'game') $('tb-mid').textContent = '';
  if (d.phase === 'lobby') { setScreen('lobby'); renderLobby(d); return; }
  if (d.phase === 'paused') { setScreen('paused'); $('btn-quit').hidden = !d.host; return; }
  if (d.phase === 'over') { setScreen('over'); renderOver(d); return; }
  // In a game.
  $('tb-mid').textContent = turn ? `Frame ${turn.frame}${turn.yours ? ` · Ball ${turn.ball}` : ''}` : '';
  const key = turn ? `${turn.slot}/${turn.frame}/${turn.ball}` : '';
  if (turn?.yours && key !== state.lastTurnKey && turn.step === 'intro') flash();   // the TV sends the chime + buzz
  state.lastTurnKey = key;
  if (!turn || !turn.yours) { setScreen('wait'); renderWait(d); return; }
  if (turn.step === 'intro') {
    setScreen('ready');
    $('ready-frame').textContent = `Frame ${turn.frame} · Ball ${turn.ball}`;
    return;
  }
  const localWatch = performance.now() < state.watchUntil;
  if ((turn.step === 'aim' || turn.step === 'approach') && !localWatch) {
    setScreen('aim');
    renderAim(d);
    return;
  }
  if (turn.step === 'aim' || turn.step === 'approach') { renderWatch(d, true); return; }
  state.watchUntil = 0;
  renderWatch(d, false);
}

function renderLobby(d) {
  const curChar = getCharacter(profile.character);
  $('lobby-ball').style.setProperty('--c', colorHex(profile.color));
  $('lobby-slot').textContent = state.slot !== null ? `Player ${state.slot + 1}` : 'Player';
  $('lobby-name').textContent = profile.name || 'Player';
  if ($('lobby-char')) $('lobby-char').textContent = `${curChar.icon} ${curChar.name}`;
  if ($('lobby-char-icon')) $('lobby-char-icon').textContent = curChar.icon;
  const list = $('lobby-players');
  list.replaceChildren();
  for (const p of d?.players || []) {
    const li = document.createElement('li');
    li.append(ballDot(p.color));
    const ch = getCharacter(p.character);
    const n = document.createElement('span');
    n.className = 'pl-name';
    n.textContent = `${ch.icon} ${p.name}`;
    const tag = document.createElement('span');
    tag.className = 'pl-tag';
    tag.textContent = p.local ? 'keyboard' : p.connected ? `P${p.slot + 1}` : 'reconnecting…';
    li.append(n, tag);
    if (p.isYou) li.classList.add('you');
    if (!p.connected && !p.local) li.classList.add('off');
    list.append(li);
  }
  $('btn-start').hidden = !d?.host;
  $('lobby-note').textContent = d?.host ? 'Everyone in? Start when ready — up to 4 players.' : `Waiting for ${d?.hostName || 'Player 1'} to start…`;
}

function renderWait(d) {
  const turn = d.turn;
  $('wait-ball').style.setProperty('--c', colorHex(turn?.color));
  $('wait-name').textContent = turn?.name || '…';
  $('wait-result').textContent = d.result?.title || '';
  const list = $('wait-board');
  list.replaceChildren();
  for (const p of d.players || []) {
    const li = document.createElement('li');
    li.append(ballDot(p.color));
    const n = document.createElement('span');
    n.className = 'pl-name';
    n.textContent = p.name;
    const sc = document.createElement('span');
    sc.className = 'pl-score';
    sc.textContent = String(p.total ?? 0);
    li.append(n, sc);
    if (p.isYou) li.classList.add('you');
    if (p.isTurn) li.classList.add('turn');
    list.append(li);
  }
  const nextIsMe = d.nextSlot === state.slot && d.nextSlot !== undefined && d.nextSlot !== -1;
  $('wait-next-line').textContent = d.spectator ? 'You\u2019ll join the next game.' : nextIsMe ? 'You\u2019re up next — get ready!' : d.nextName ? `Up next: ${d.nextName}` : '';
}

function renderAim(d) {
  const turn = d.turn;
  $('aim-title').textContent = turn.forName ? `Bowling for ${turn.forName}` : turn.ball > 1 && turn.standing ? `${turn.standing} pin${turn.standing === 1 ? '' : 's'} left` : 'Your turn!';
  $('aim-frame').textContent = `Frame ${turn.frame} · Ball ${turn.ball}`;
  $('mode-switch').dataset.mode = turn.mode === 'turn' ? 'turn' : 'move';
  $('btn-zoom').classList.toggle('on', !!turn.zoom);
  body.classList.toggle('blocked', !d.canThrow);
  renderMode();
}

function renderWatch(d, local) {
  setScreen('watch');
  const r = d?.result;
  const title = $('watch-title');
  if (!local && r) {
    title.textContent = r.title;
    title.classList.toggle('strike', r.kind === 'strike');
    $('watch-sub').textContent = r.sub || '';
  } else {
    title.textContent = state.watchText || 'Rolling…';
    title.classList.remove('strike');
    $('watch-sub').textContent = d?.lastThrow && !local ? `${d.lastThrow.mph} mph` : '';
  }
  renderReleaseMeter(local ? null : d?.lastThrow);
  $('watch-tip').textContent = d?.tip || '';
  $('btn-skip').hidden = local || !['result', 'sweep'].includes(d?.turn?.step);
}

// Side view of the swing: the arc the hand travels, the sweet spot at the
// bottom, and where this phone let go. Shown while the ball rolls.
function arcPath(r, a0, a1) {
  const p = (a) => [Math.sin(a * Math.PI / 180) * r, Math.cos(a * Math.PI / 180) * r];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 0 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}
function renderReleaseMeter(tvThrow) {
  const box = $('release-meter');
  const rel = state.lastRelease?.rel ?? (Number.isFinite(tvThrow?.release) ? tvThrow.release : null);
  if (rel === null || rel === undefined || state.screen !== 'watch') { box.hidden = true; return; }
  const g = releaseGrade(rel);
  box.hidden = false;
  box.dataset.tone = g.tone;
  $('rm-zone').setAttribute('d', arcPath(80, RELEASE_ZONE.early, RELEASE_ZONE.late));
  const a = Math.max(-95, Math.min(95, rel)) * Math.PI / 180;
  const dot = $('rm-dot');
  dot.setAttribute('cx', (Math.sin(a) * 80).toFixed(1));
  dot.setAttribute('cy', (Math.cos(a) * 80).toFixed(1));
  $('rm-arm').setAttribute('x2', (Math.sin(a) * 80).toFixed(1));
  $('rm-arm').setAttribute('y2', (Math.cos(a) * 80).toFixed(1));
  const speed = state.lastRelease?.speed;
  $('release-label').textContent = g.label;
  $('release-hint').textContent = g.grade === 'early' || g.grade === 'way-early' ? 'Let go a little later — at the bottom of the swing'
    : g.grade === 'late' || g.grade === 'lofted' ? 'Let go a little sooner — at the bottom of the swing'
      : speed !== undefined ? (speed < 0.35 ? 'Swing harder for more speed' : speed > 0.95 ? 'Full power!' : '') : '';
}

function renderOver(d) {
  const list = $('over-standings');
  list.replaceChildren();
  for (const p of d.standings || []) {
    const li = document.createElement('li');
    const pl = document.createElement('span');
    pl.className = 'place';
    pl.textContent = `${p.place}`;
    const n = document.createElement('span');
    n.className = 'pl-name';
    n.textContent = p.name;
    const sc = document.createElement('span');
    sc.className = 'pl-score';
    sc.textContent = String(p.total);
    li.append(pl, ballDot(p.color), n, sc);
    if (p.place === 1) li.classList.add('first');
    list.append(li);
  }
  const me = (d.standings || []).find((p) => p.isYou);
  const firsts = (d.standings || []).filter((p) => p.place === 1).length;
  $('over-title').textContent = !me ? 'Game over' : (d.standings || []).length < 2 ? `You scored ${me.total}` : me.place === 1 ? (firsts > 1 ? 'Tied for 1st! 🏆' : 'You win! 🏆') : `${['', '1st', '2nd', '3rd', '4th'][me.place]} place · ${me.total}`;
  $('btn-again').hidden = !d.host;
  $('btn-lobby').hidden = !d.host;
  $('over-note').textContent = d.host ? '' : `Waiting for ${d.hostName || 'Player 1'}…`;
}

// ---------------------------------------------------------------- join / code screens

function showJoin() {
  setScreen('join');
  $('name-input').value = profile.name || '';
  renderCharacters();
  renderSwatches();
  renderHand();
  $('btn-join').textContent = state.editing ? 'Save' : profile.name ? `Join as ${profile.name}` : 'Join game';
}

function renderCharacters() {
  const box = $('char-grid');
  if (!box) return;
  box.replaceChildren();
  for (const c of BRAINROT_CHARACTERS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `char-card${profile.character === c.id ? ' active' : ''}${c.isMain ? ' is-main' : ''}`;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(profile.character === c.id));
    card.setAttribute('aria-label', c.name);

    const icon = document.createElement('div');
    icon.className = 'char-card-icon';
    icon.textContent = c.icon;

    const info = document.createElement('div');
    info.className = 'char-card-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'char-card-title-row';
    const name = document.createElement('b');
    name.textContent = c.name;
    titleRow.append(name);
    if (c.isMain) {
      const badge = document.createElement('span');
      badge.className = 'char-main-badge';
      badge.textContent = '★ MAIN';
      titleRow.append(badge);
    }

    const sub = document.createElement('small');
    sub.textContent = c.tagline;

    info.append(titleRow, sub);
    card.append(icon, info);

    card.addEventListener('click', () => {
      profile.character = c.id;
      store.set('character', c.id);
      if (!$('name-input').value || $('name-input').value.startsWith('Player')) {
        $('name-input').value = c.shortName;
        profile.name = c.shortName;
        store.set('name', c.shortName);
      }
      haptic(25);
      renderCharacters();
    });

    box.append(card);
  }
}

function renderSwatches() {
  const box = $('swatches');
  box.replaceChildren();
  const taken = new Set((state.display?.players || []).filter((p) => !p.isYou).map((p) => p.color));
  for (const c of PLAYER_COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.type = 'button';
    b.style.setProperty('--c', c.hex);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c.name);
    b.setAttribute('aria-checked', String(profile.color === c.id));
    b.disabled = taken.has(c.id);
    b.addEventListener('click', () => { profile.color = c.id; renderSwatches(); });
    box.append(b);
  }
}

function renderHand() {
  for (const b of $('hand-seg').children) b.setAttribute('aria-checked', String(b.dataset.hand === profile.hand));
}

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

// ---------------------------------------------------------------- B button: grip, swing, release

function canGrip() {
  const d = state.display;
  return !state.displayGone && state.socketUp && state.screen === 'aim' && d?.phase === 'game' && d.turn?.yours && d.canThrow && (d.turn.step === 'aim' || d.turn.step === 'approach');
}

function startGrip(e) {
  const g = state.grip;
  g.active = true;
  g.mode = throwMode();
  g.startedAt = e.timeStamp;
  g.path = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }];
  state.lastRelease = null;
  body.classList.add('gripping');
  if (g.mode === 'motion') {
    const up = performance.now() - state.motion.orientAt < 500 ? state.motion.orient : null;
    swing.invertSpin = settings.invertSpin;
    swing.grip(e.timeStamp, up);
    clearInterval(g.streamTimer);
    g.streamTimer = setInterval(() => {
      const a = Math.round(swing.armAngle);
      const s = state.socket;
      if (s?.connected) s.volatile.emit('remote:input', { t: 'swing', a, w: 0 });
      $('swing-arm').style.transform = `rotate(${-a}deg)`;
    }, 50);
    $('swing-title').textContent = 'SWING!';
    $('swing-sub').textContent = 'Swing back, then forward — lift your thumb at the bottom';
  }
  send({ t: 'btn', b: 'b', down: true });
  haptic(12);
  keepAwake();
}

function endGrip() {
  const g = state.grip;
  g.active = false;
  g.pointers.clear();
  clearInterval(g.streamTimer);
  g.streamTimer = null;
  body.classList.remove('gripping');
  const ball = $('flick-ball');
  ball.style.transform = '';
}

function cancelGrip(why) {
  if (!state.grip.active) return;
  endGrip();
  swing.cancel();
  send({ t: 'cancel' });
  send({ t: 'btn', b: 'b', down: false });
  if (why !== 'screen') toast('Throw cancelled — hold B again');
}

function releaseGrip(e) {
  const g = state.grip;
  if (!g.active) return;
  const mode = g.mode;
  let th;
  if (mode === 'motion') {
    const r = swing.release(e.timeStamp);
    th = { speed: r.speed, spin: r.spin, quality: r.quality, mode: 'motion', peak: r.peak, rel: r.release };
    state.lastRelease = r.quality === 'ok' || r.quality === 'loft' ? { rel: r.release, speed: r.speed } : null;
    if (r.hard) setTimeout(() => toast('Easy! You don’t need to swing that hard.', 3000), 600);
  } else {
    th = flickThrow(g.path, e);
    state.lastRelease = null;
  }
  endGrip();
  send({ t: 'btn', b: 'b', down: false });
  sendThrow(th);
  if (th.quality === 'none') {
    toast(mode === 'motion' ? 'Swing your arm, then lift your thumb' : 'Flick the ball up faster');
    return;
  }
  haptic(20);
  unlockAudio();
  releaseSound(th.speed);
  state.watchUntil = performance.now() + 4000;
  state.watchText = th.quality === 'drop' ? 'Oops!' : th.quality === 'loft' ? 'Lofted!' : 'Rolling…';
  if (th.quality === 'ok' || th.quality === 'loft') haptic(releaseGrade(th.rel).tone === 'good' ? [20] : [20, 60, 20]);
  render();
}

// Touch fallback: drag the ball upward and let go. Speed from the last
// ~90 ms of the drag; curve from how the path bends at the end.
function flickThrow(path, e) {
  path.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
  const H = window.innerHeight || 700;
  const end = path[path.length - 1];
  // A still finger sends no moves, so the position at time T is the last
  // point recorded at or before T.
  const at = (T) => {
    let p = path[0];
    for (const q of path) { if (q.t <= T) p = q; else break; }
    return p;
  };
  const W = Math.max(16, Math.min(90, end.t - path[0].t));
  const start = at(end.t - W);
  const vUp = (start.y - end.y) / H / (W / 1000);       // screen heights per second, up = +
  // ~0.6 screen heights/s is the slowest roll; a brisk thumb flick (~4 h/s) is full power.
  if (path.length < 3 || vUp < 0.6) return { speed: 0, spin: 0, quality: 'none', mode: 'touch', peak: 0 };
  const speed = Math.pow(Math.min(1, (vUp - 0.6) / 3.6), 0.8);
  // Curve: how the last ~50 ms of the flick bends against its last ~160 ms.
  const c0 = at(end.t - 160), l0 = at(end.t - 50);
  const cx = end.x - c0.x, cy = end.y - c0.y;
  const lx = end.x - l0.x, ly = end.y - l0.y;
  let spin = 0;
  if (Math.hypot(cx, cy) > 20 && Math.hypot(lx, ly) > 6) {
    let bend = (Math.atan2(lx, -ly) - Math.atan2(cx, -cy)) * 180 / Math.PI;
    if (bend > 180) bend -= 360;
    if (bend < -180) bend += 360;
    spin = Math.max(-1, Math.min(1, bend / 35));
    if (Math.abs(spin) < 0.12) spin = 0;
  }
  if (settings.invertSpin) spin = -spin;
  return { speed, spin: Math.round(spin * 1000) / 1000 || 0, quality: 'ok', mode: 'touch', peak: Math.round(vUp * 100) };
}

function wireGrip() {
  const grip = $('grip');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const g = state.grip;
    if (g.active) return;                        // a palm / second finger: ignored
    if (!canGrip()) { if (state.screen === 'aim') toast(state.displayGone || !state.socketUp ? 'Waiting for the TV to reconnect…' : 'Wait for the pins…'); return; }
    startGrip(e);
    g.pointers.add(e.pointerId);                 // the finger that pressed B is the B button
    try { grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  grip.addEventListener('pointermove', (e) => {
    const g = state.grip;
    if (!g.active || g.mode !== 'touch' || !g.pointers.has(e.pointerId)) return;
    g.path.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    if (g.path.length > 200) g.path.splice(0, 50);
    const p0 = g.path[0];
    $('flick-ball').style.transform = `translate(${e.clientX - p0.x}px, ${e.clientY - p0.y}px)`;
  });
  const up = (e) => {
    const g = state.grip;
    if (!g.active || !g.pointers.has(e.pointerId)) return;
    releaseGrip(e);
  };
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', (e) => { if (state.grip.pointers.has(e.pointerId)) cancelGrip('lost'); });
  grip.addEventListener('lostpointercapture', (e) => { if (state.grip.active && state.grip.pointers.has(e.pointerId)) cancelGrip('lost'); });
  grip.addEventListener('contextmenu', (e) => e.preventDefault());
  for (const ev of ['touchstart', 'touchmove']) grip.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}

// ---------------------------------------------------------------- D-pad / A / zoom

function holdButton(id, b) {
  const el = $(id);
  const down = (e) => {
    e.preventDefault();
    if (el.classList.contains('down')) return;
    el.classList.add('down');
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
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
  holdButton('btn-left', 'left');
  holdButton('btn-right', 'right');
  holdButton('btn-a', 'a');
  holdButton('btn-zoom', 'up');
  wireGrip();

  $('btn-plus').addEventListener('click', () => send({ t: 'menu', action: 'pause' }));
  // A: skip the turn intro / hurry the pinsetter.
  const pressA = () => { send({ t: 'btn', b: 'a', down: true }); send({ t: 'btn', b: 'a', down: false }); };
  document.querySelector('[data-for="ready"]').addEventListener('click', pressA);
  $('btn-skip').addEventListener('click', pressA);
  $('btn-resume').addEventListener('click', () => send({ t: 'menu', action: 'resume' }));
  $('btn-quit').addEventListener('click', () => send({ t: 'menu', action: 'quit' }));
  $('btn-start').addEventListener('click', () => { unlockAudio(); send({ t: 'menu', action: 'start' }); });
  $('btn-again').addEventListener('click', () => send({ t: 'menu', action: 'again' }));
  $('btn-lobby').addEventListener('click', () => send({ t: 'menu', action: 'lobby' }));

  $('btn-edit').addEventListener('click', () => { state.editing = true; showJoin(); });
  $('btn-join').addEventListener('click', () => {
    // Inside the tap: motion permission (iOS), audio, wake lock, fullscreen (Android).
    let ask = null;
    if (window.isSecureContext && needsPermission() && settings.mode === 'motion') ask = askMotion();
    unlockAudio();
    keepAwake();
    goFullscreen();
    ask?.then((r) => { state.motion.denied = r === 'denied'; checkSensors(); });
    profile.name = cleanName($('name-input').value) || profile.name;
    store.set('name', profile.name);
    store.set('hand', profile.hand);
    if (profile.color) store.set('color', profile.color);
    if (state.editing) {
      state.editing = false;
      saveProfile();
      render();
      return;
    }
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

  $('btn-settings').addEventListener('click', () => { renderMode(); $('opt-invert').checked = settings.invertSpin; $('opt-sound').checked = settings.sound; $('settings').hidden = false; });
  $('btn-settings-close').addEventListener('click', () => { $('settings').hidden = true; });
  $('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').hidden = true; });
  for (const b of $('mode-seg').children) {
    b.addEventListener('click', () => {
      settings.mode = b.dataset.mode;
      store.set('mode', settings.mode);
      if (settings.mode === 'motion' && needsPermission()) askMotion().then((r) => { state.motion.denied = r === 'denied'; checkSensors(); });
      state.motion.touchFallback = false;
      renderMode();
      checkSensors();
    });
  }
  $('opt-invert').addEventListener('change', (e) => { settings.invertSpin = e.target.checked; store.set('invert', settings.invertSpin ? '1' : '0'); });
  $('opt-sound').addEventListener('change', (e) => { settings.sound = e.target.checked; store.set('sound', settings.sound ? '1' : '0'); unlockAudio(); });
  $('btn-motion-retry').addEventListener('click', () => {
    askMotion().then((r) => { state.motion.denied = r === 'denied'; state.motion.touchFallback = false; checkSensors(); renderMode(); });
  });

  // Page hidden mid-swing (call, app switch): never throw by accident.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') cancelGrip('hidden');
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
    link.href = `https://${location.hostname}:${NET.httpsPort}/remote${location.search}`;
    fetch('/api/info').then((r) => r.json()).then((info) => {
      if (Number.isInteger(info?.httpsPort)) link.href = `https://${location.hostname}:${info.httpsPort}/remote${location.search}`;
    }).catch(() => {});
    setScreen('insecure');
    return;
  }
  connect();
  if (!state.room) showCode();
}

// Test hook (synthetic sensor runs in headless Chrome).
window.__remote = { state, swing, settings, profile, flickThrow };

boot();
