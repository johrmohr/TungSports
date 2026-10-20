// TV entry point: the games menu, the Tennis / Golf lobbies, and the shell the
// games run in.
//
//   menu ─▶ Tennis / Golf lobby (QR code, players, settings) ─▶ game ─▶ results ─▶ lobby
//        └▶ Bowling / Krishiv Kart: started as their own servers, with their own
//           lobby and QR code; the TV comes back with its "Krishiv Sports" button.
//
// Phones join in a lobby and keep their player slot, name, colour and
// character while this TV page is open — in both lobbies, and when the TV goes
// to Bowling / Krishiv Kart they are sent along.

import * as THREE from 'three';
import { DisplayLink } from './net.js';
import { Audio } from './audio.js';
import { Menu, moveFocus } from './menu.js';
import { Lobby } from './lobby.js';
import { make, toast, notice, showOverlay, hideOverlay, overlayText } from './ui.js';
import {
  MAX_PLAYERS, PLAYER_COLORS, CHARACTER_IDS, GAMES, getCharacter, getGame, defaultCharacterFor,
} from '../shared/protocol.js';

const params = new URLSearchParams(location.search);
const LOW = params.get('quality') === 'low';

const app = {
  phase: 'boot',          // boot | menu | lobby | loading | launching | tennis | golf
  info: null,
  locals: [],             // keyboard players: { key, name, color, character, hand }
  lobbyGame: null,        // the lobby on screen, or the one the running game came from
  game: null,             // the running Tennis / Golf
  gameId: null,
  lastOpts: null,
  paused: false,
  pauseEl: null,
};

let renderer, audio, link, menu, lobby;
const uiRoot = document.getElementById('ui');
const hudRoot = document.getElementById('hud');

// ---------------------------------------------------------------- seats (players)

// Phones in slot order, then keyboard players.
function seats() {
  const out = [];
  link?.players.forEach((p, slot) => {
    if (!p) return;
    out.push({
      key: `s${slot}`, slot, local: false, name: p.name, color: p.color, hand: p.hand || 'right',
      character: p.character || defaultCharacterFor(slot), connected: !!p.connected,
    });
  });
  const used = new Set(out.map((s) => s.color));
  for (const l of app.locals) {
    if (used.has(l.color)) l.color = (PLAYER_COLORS.find((c) => !used.has(c.id)) || PLAYER_COLORS[0]).id;
    used.add(l.color);
    out.push({ key: l.key, slot: null, local: true, name: l.name, color: l.color, hand: l.hand, character: l.character, connected: true });
  }
  return out.slice(0, MAX_PLAYERS);
}

// The host: the first connected phone, else the keyboard.
function hostSeat() {
  const s = seats();
  return s.find((x) => !x.local && x.connected) || s.find((x) => x.local) || null;
}
const hostSlot = () => { const h = hostSeat(); return h && !h.local ? h.slot : -1; };
const isHostSlot = (slot) => { const h = hostSlot(); return h === -1 || h === slot; };

function addLocal() {
  const s = seats();
  if (s.length >= MAX_PLAYERS) return;
  const usedC = new Set(s.map((x) => x.color));
  const usedCh = new Set(s.map((x) => x.character));
  const character = CHARACTER_IDS.find((id) => !usedCh.has(id)) || CHARACTER_IDS[s.length % CHARACTER_IDS.length];
  app.locals.push({
    key: `L${Date.now().toString(36)}${app.locals.length}`,
    name: getCharacter(character).shortName,
    color: (PLAYER_COLORS.find((c) => !usedC.has(c.id)) || PLAYER_COLORS[0]).id,
    character,
    hand: 'right',
  });
  audio.ui('join');
  refresh();
}

function removeSeat(seat) {
  if (seat.local) app.locals = app.locals.filter((l) => l.key !== seat.key);
  else link.kick(seat.slot);
  audio.ui('leave');
  refresh();
}

function cycleCharacter(seat) {
  const next = CHARACTER_IDS[(CHARACTER_IDS.indexOf(seat.character) + 1) % CHARACTER_IDS.length];
  if (seat.local) {
    const l = app.locals.find((x) => x.key === seat.key);
    if (l) { if (l.name === getCharacter(l.character).shortName) l.name = getCharacter(next).shortName; l.character = next; }
  } else {
    link.setProfile(seat.slot, { character: next });
    if (link.players[seat.slot]) link.players[seat.slot].character = next;
  }
  audio.characterTheme(next);
  refresh();
}

function refresh() {
  if (app.phase === 'menu') menu.render();
  if (app.phase === 'lobby') lobby.render();
  link?.setPhase(app.phase === 'tennis' || app.phase === 'golf', app.locals.length);
  syncPhones();
}

// ---------------------------------------------------------------- boot

async function boot() {
  const bootEl = document.getElementById('boot');
  const bootText = bootEl.querySelector('.boot-text');
  try {
    audio = new Audio();
    renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('view'), antialias: !LOW, powerPreference: 'high-performance' });
    renderer.setPixelRatio(LOW ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    bootText.textContent = 'Warming up…';
    try {
      await Promise.race([Promise.all([document.fonts.load('800 60px "M PLUS Rounded 1c"'), document.fonts.load('60px "Lilita One"')]), new Promise((r) => setTimeout(r, 1500))]);
    } catch { /* offline */ }

    menu = new Menu(uiRoot, { get info() { return app.info; }, onPick: (id) => pick(id) });
    lobby = new Lobby(uiRoot, {
      seats, hostSeatKey: () => hostSeat()?.key || null,
      get info() { return app.info; },
      audio,
      onStart: (game, opts) => startGame(game, opts),
      onBack: () => toMenu(),
      addLocal, removeSeat, cycleCharacter,
      syncPhones: () => syncPhones(),
    });

    link = new DisplayLink();
    link.on('players', () => onPlayersChanged());
    link.on('join', ({ player }) => { audio.ui('join'); toast(`${player.name} joined`); });
    link.on('rejoin', ({ player }) => { if (app.phase === 'tennis' || app.phase === 'golf') toast(`${player.name}'s phone is back`); });
    link.on('leave', ({ player }) => {
      if (app.phase !== 'launching') { audio.ui('leave'); toast(`${player?.name || 'A player'}'s phone disconnected`); }
    });
    link.on('info', (info) => { app.info = { ...app.info, ...info }; menu.render(); lobby.render(); });
    link.on('input', onRemoteInput);
    link.on('status', (s) => notice(!s.connected && app.phase !== 'boot' ? 'Lost the connection to the game server — reconnecting…' : null));

    wireKeyboard();
    window.addEventListener('resize', onResize);
    toMenu(true);
    bootEl.classList.add('gone');
    requestAnimationFrame(loop);
    link.connect().then((info) => { app.info = info; menu.render(); lobby.render(); syncPhones(); }).catch((err) => {
      app.info = { error: err.message };
      menu.render();
      lobby.render();
      notice(`${err.message} Keyboard play still works.`);
    });
    setInterval(() => {
      syncPhones();
      menu.setSound(audio.unlocked);
      lobby.setSound(audio.unlocked);
    }, 400);
    // Test / debug hooks.
    window.__ks = {
      get app() { return app; }, get link() { return link; }, get menu() { return menu; }, get lobby() { return lobby; },
      seats, addLocal, pick, openLobby, startGame, toMenu: () => toMenu(), toLobby: () => toLobby(), setPaused,
      get game() { return app.game; },
    };
  } catch (err) {
    console.error(err);
    bootEl.classList.add('error');
    bootText.textContent = `Could not start: ${err.message}`;
  }
}

function onResize() {
  renderer.setPixelRatio(LOW ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  app.game?.resize?.(window.innerWidth, window.innerHeight);
}

function onPlayersChanged() {
  app.game?.playersChanged?.(seats());
  refresh();
}

// ---------------------------------------------------------------- phases

function endGame() {
  if (app.game) { try { app.game.dispose(); } catch (err) { console.error(err); } app.game = null; }
  hudRoot.replaceChildren();
  setPaused(false);
  hideOverlay();
  app.gameId = null;
}

function toMenu(first = false) {
  endGame();
  app.phase = 'menu';
  app.lobbyGame = null;
  document.body.dataset.phase = 'menu';
  lobby.hide();
  menu.show();
  link?.where('menu');
  refresh();
  audio.ambience(null);
  audio.music('menu');
  if (!first) audio.ui('back');
}

function openLobby(game) {
  if (!getGame(game)?.native) return;
  endGame();
  app.phase = 'lobby';
  app.lobbyGame = game;
  document.body.dataset.phase = 'lobby';
  menu.hide();
  lobby.show(game);
  link?.where(game);
  refresh();
  audio.ambience(null);
  audio.music('menu');
  audio.ui('select');
}

const toLobby = () => openLobby(app.lobbyGame || app.gameId || 'tennis');

function pick(id) {
  if (app.phase !== 'menu') return;
  const g = getGame(id);
  if (!g) return;
  const st = app.info?.games?.[id];
  if (st && st.installed === false) { toast(st.why, 4000); audio.ui('error'); return; }
  if (g.native) openLobby(id);
  else launch(id);
}

const TIPS = {
  tennis: [
    'Hold your phone like a racket handle and swing — forehand or backhand.',
    'Swing early to hit cross-court, late to go down the line.',
    'Serve: flick the phone up (or tap TOSS), then swing. Hit the toss at its peak for a fastball!',
  ],
  golf: [
    'Hold your phone like a club grip in both hands. Swing without A to practise.',
    'Hold A (the big button) and swing for real. Don’t go past the top dot!',
    'Twisting your wrists at impact curves the ball. ◀ ▶ aim, ▲ ▼ change club.',
  ],
};

async function startGame(game, opts) {
  if (!['tennis', 'golf'].includes(game) || app.phase === 'loading') return;
  const players = seats();
  // Never a CPU-only game: someone has to be playing.
  if (!players.length) { toast('At least one player has to join first — scan the code or add a keyboard player'); audio.ui('error'); return; }
  if (game === 'tennis' && !(opts?.teams || []).flat().some((k) => players.some((s) => s.key === k))) { toast('Put at least one player on the court'); audio.ui('error'); return; }
  const from = app.phase;
  app.phase = 'loading';
  app.lobbyGame = game;
  app.lastOpts = opts;
  audio.ui('start');
  audio.music(null);
  showOverlay(uiRoot, { title: `${getGame(game).name}`, text: 'Getting ready…', tips: TIPS[game] });
  syncPhones();
  try {
    const mod = await import(`./${game}/game.js`);
    const ctx = {
      renderer, audio, link, hudRoot, uiRoot, seats: players, opts,
      app: {
        toLobby: () => toLobby(),
        again: () => startGame(game, app.lastOpts),
        pause: (on) => setPaused(on),
        syncPhones: () => syncPhones(),
        isHost: (slot) => isHostSlot(slot),
        hostSlot: () => hostSlot(),
        seats: () => seats(),
      },
    };
    if (app.game) { try { app.game.dispose(); } catch { /* */ } app.game = null; }
    hudRoot.replaceChildren();
    setPaused(false);
    const g = new mod.default(ctx);
    await g.load((t) => overlayText(t));
    app.game = g;
    app.gameId = game;
    app.phase = game;
    document.body.dataset.phase = game;
    menu.hide();
    lobby.hide();
    hideOverlay();
    link.where(game);
    refresh();
    g.start();
  } catch (err) {
    console.error(err);
    app.phase = from === 'lobby' ? 'lobby' : app.phase;
    showOverlay(uiRoot, { title: 'Something went wrong', text: err.message, error: true, spinner: false, actions: [{ label: 'Back to the lobby', primary: true, fn: () => toLobby() }] });
  }
}

// Bowling / Krishiv Kart: start their server, then send the TV there. Phones
// already joined here follow once that page reports its room (server → 'hub:goto').
async function launch(id) {
  const g = getGame(id);
  if (!link?.socketConnected) { toast('Not connected to the game server'); return; }
  app.phase = 'launching';
  audio.ui('start');
  showOverlay(uiRoot, {
    title: `Starting ${g.name}…`,
    text: 'Scan its QR code on the next screen to join.',
    tips: id === 'bowling'
      ? ['Hold B, swing back and forward, lift your thumb to roll.', 'The ⌂ Krishiv Sports button (bottom left) brings you back here.']
      : ['Turn your phone like a steering wheel.', 'The ⌂ Krishiv Sports button (bottom left) brings you back here.'],
  });
  syncPhones();
  try {
    const res = await link.launch(id);
    const hub = `${location.protocol}//${location.host}/?room=${link.room}`;
    const q = new URLSearchParams({ room: link.room, hub, hubRoom: link.room, hubSeq: String(res.homeSeq || 0) });
    const url = `${location.protocol}//${location.hostname}:${res.httpPort}/?${q}`;
    setTimeout(() => { location.href = url; }, 350);
  } catch (err) {
    app.phase = 'menu';
    showOverlay(uiRoot, {
      title: `Couldn’t start ${g.name}`, text: err.message, error: true, spinner: false,
      actions: [{ label: 'Back to the games', primary: true, fn: () => { hideOverlay(); syncPhones(); } }],
    });
    audio.ui('error');
    syncPhones();
  }
}

function setPaused(on) {
  if (on === app.paused) return;
  if (on && !app.game) return;
  app.paused = on;
  app.game?.pause?.(on);
  app.pauseEl?.remove();
  app.pauseEl = null;
  if (on) {
    const p = make('div', 'pause', null, uiRoot);
    const box = make('div', 'box', null, p);
    make('h2', null, 'Paused', box);
    const c = make('button', 'btn primary', 'Continue', box);
    c.addEventListener('click', () => setPaused(false));
    const r = make('button', 'btn ghost', 'Restart', box);
    r.addEventListener('click', () => { setPaused(false); startGame(app.gameId, app.lastOpts); });
    const q = make('button', 'btn ghost', 'Quit to the lobby', box);
    q.addEventListener('click', () => toLobby());
    c.classList.add('kbd-focus');
    app.pauseEl = p;
    audio.ui('blip');
  }
  syncPhones();
}

// ---------------------------------------------------------------- input

function onRemoteInput(msg) {
  const slot = msg.slot;
  const seat = seats().find((s) => s.slot === slot);
  if (msg.t === 'menu') { onMenuAction(slot, msg); return; }
  if (msg.t === 'btn' && msg.b === 'plus' && msg.down && app.game) { setPaused(!app.paused); return; }
  if (msg.t === 'btn' && msg.b === 'home' && msg.down) { if (app.game) setPaused(true); return; }
  if (app.paused) return;
  if (app.game) app.game.input(msg, seat);
}

// Lobby / pause / results actions from the phones. Only the host decides.
function onMenuAction(slot, { action, opts }) {
  if (action === 'pause') { if (app.game) setPaused(true); return; }
  if (action === 'resume') { setPaused(false); return; }
  if (!isHostSlot(slot)) { link.sendEvent(slot, { type: 'toast', text: `${hostSeat()?.name || 'Player 1'} chooses` }); return; }
  switch (action) {
    case 'setup': if (app.phase === 'lobby' && opts) lobby.applyOptions(opts); syncPhones(); break;
    case 'start':
      if (app.phase !== 'lobby') break;
      if (lobby.canStart()) startGame(lobby.game, lobby.options());
      else link.sendEvent(slot, { type: 'toast', text: 'Waiting for players' });
      break;
    case 'quit': if (app.game) toLobby(); break;
    case 'lobby': if (app.game?.over) toLobby(); break;
    case 'again': if (app.game?.over) startGame(app.gameId, app.lastOpts); break;
    default: break;
  }
}

function wireKeyboard() {
  const unlock = () => {
    const was = audio.unlocked;
    audio.unlock();
    if (!was) setTimeout(() => { menu.setSound(audio.unlocked); lobby.setSound(audio.unlocked); }, 60);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', (e) => {
    unlock();
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'KeyM' && !e.repeat) { audio.setMuted(!audio.muted); toast(audio.muted ? 'Sound off' : 'Sound on'); return; }
    const arrow = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.code];
    if (app.paused) {
      if (e.code === 'Escape' || e.code === 'KeyP') setPaused(false);
      else if (arrow) moveFocus(app.pauseEl, arrow);
      else if (e.code === 'Enter') app.pauseEl?.querySelector('.kbd-focus')?.click();
      e.preventDefault();
      return;
    }
    if (app.game) {
      if ((e.code === 'Escape' || e.code === 'KeyP') && !e.repeat && !app.game.over) { setPaused(true); e.preventDefault(); return; }
      app.game.keyDown?.(e);
      return;
    }
    const scope = app.phase === 'menu' ? menu.el : app.phase === 'lobby' ? lobby.el : null;
    if (!scope) return;
    if (arrow) { moveFocus(scope, arrow); audio.ui('hover'); e.preventDefault(); }
    else if (e.code === 'Enter' || e.code === 'Space') {
      const f = scope.querySelector('.kbd-focus');
      if (f && !f.disabled) { f.click(); e.preventDefault(); } else moveFocus(scope, 'down');
    } else if ((e.code === 'Escape' || e.code === 'Backspace') && app.phase === 'lobby') toMenu();
    else if (/^Digit[1-9]$/.test(e.code) && app.phase === 'menu') { const g = GAMES[Number(e.code.slice(5)) - 1]; if (g) pick(g.id); }
  });
  window.addEventListener('keyup', (e) => { if (app.game && !app.paused) app.game.keyUp?.(e); });
}

// ---------------------------------------------------------------- phones

function syncPhones() {
  if (!link) return;
  const all = seats();
  const hSlot = hostSlot();
  const hostName = hostSeat()?.name || 'Player 1';
  for (let slot = 0; slot < MAX_PLAYERS; slot++) {
    const lp = link.players[slot];
    if (!lp) continue;
    const st = {
      phase: app.paused ? 'paused' : app.phase === 'boot' ? 'menu' : app.phase,
      you: { slot, name: lp.name, color: lp.color, character: lp.character, hand: lp.hand },
      host: hSlot === slot || hSlot === -1,
      hostName,
      players: all.map((s) => ({ name: s.name, color: s.color, character: s.character, slot: s.slot, local: s.local, connected: s.connected, isYou: s.slot === slot })),
    };
    if (app.phase === 'lobby' || (app.phase === 'loading' && app.lobbyGame)) st.lobby = lobby.phoneModel();
    if (app.game && !app.paused) st.game = app.game.phoneState(slot);
    st.gameId = app.gameId || app.lobbyGame;
    link.sendState(slot, st);
  }
}

// ---------------------------------------------------------------- loop

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (app.game) {
    try { app.game.frame(app.paused ? 0 : dt); } catch (err) { console.error(err); }
  }
}

boot();
