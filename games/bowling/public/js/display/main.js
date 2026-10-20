// Display (TV) entry point: boots the alley, runs the game and talks to the
// phone remotes.
//
// One ball goes through these steps:
//   intro → aim → approach → (release → roll → result → react → sweep) | drop
// intro:    turn introduction, camera facing the bowler, scorecard shown
// aim:      ◀ ▶ Move / Turn (A switches), ▲ zoom; B (hold) starts the approach
// approach: four steps to the foul line; the ball arm mirrors the phone
// release:  the ball leaves the hand (lofted throws bounce)
// roll:     physics; the camera chases the ball and stops short of the deck
// result:   pin count / Strike / Spare message, score update, crowd
// react:    the bowler celebrates or slumps (notable balls only)
// sweep:    the pinsetter lifts standing pins, rakes the dead wood, re-sets
// drop:     the ball was let go during the backswing: it rolls into the crowd

import * as THREE from 'three';
import RAPIER from 'rapier';
import { LanePhysics, DIM, speedToMps, pinSpot } from '../shared/physics.js';
import { BowlingGame, nextBall, FRAMES } from '../shared/scoring.js';
import {
  colorHex, MAX_PLAYERS, PLAYER_COLORS, cleanName,
  BRAINROT_CHARACTERS, CHARACTER_IDS, DEFAULT_CHARACTER, getCharacter,
} from '../shared/protocol.js';
import { releaseEffects, releaseGrade } from '../shared/throw.js';
import { Alley, LANE_PITCH } from './scene.js';
import { Avatar } from './avatar.js';
import { CameraDirector } from './camera.js';
import { Hud, streakName } from './hud.js';
import { Screens } from './lobby.js';
import { Audio } from './audio.js';
import { DisplayLink } from './net.js';
import { Ambient } from './ambient.js';

const params = new URLSearchParams(location.search);
const LOW = params.get('quality') === 'low';
const BALL_START_Z = 2.3;           // where the ball (and the aim guide) starts
const APPROACH_TIME = 1.7;          // four steps
const AIM_X_MAX = 0.5;
const AIM_STEP = DIM.boardWidth;    // one board per D-pad click
const ANGLE_MAX = 10;               // degrees
const ANGLE_STEP = 0.5;
const MPS_TO_MPH = 2.23694;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- app state

const app = {
  phase: 'boot',        // boot | lobby | game | over
  paused: false,
  info: null,           // room info from the server
  locals: [],           // keyboard players added in the lobby: { key, name, color, hand }
  players: [],          // game players: { key, slot, local, name, color, hand }
  game: null,           // BowlingGame
  turn: null,           // the current ball (see newTurn)
  aims: new Map(),      // per player: last { aimX, angle }
  lastResult: null,     // { title, sub, kind } for the phones
  lastThrow: null,
  tips: new Map(),
  timeScale: 1,
  throwIds: new Map(),  // slot → last throw id (dedupe retries)
  toastAt: new Map(),   // slot → last 'wait' toast (throttle)
  kb: { space: false, spaceAt: 0, spin: 0, repeat: null },
  frameCount: 0,
};

let renderer, camera, alley, director, lane, hud, screens, audio, link, ambient;
const pinMeshes = [];
let ballMesh = null;
const ballGhosts = [];
let ballBlob, avatarBlob;
const bowlerAvatars = new Map();  // player key → avatar with legs
const crowd = [];                 // spectators: { avatar, seat, key? }
const tmpV = new THREE.Vector3();

// ---------------------------------------------------------------- boot

async function boot() {
  const bootText = document.querySelector('#boot .boot-text');
  try {
    bootText.textContent = 'Waxing the lanes…';
    await RAPIER.init();
    renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('view'), antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(LOW ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.05, 80);
    bootText.textContent = 'Setting up the pins…';
    // Canvas text (the sign, lane numbers) needs the rounded font loaded first.
    try {
      await Promise.race([document.fonts.load('800 150px "M PLUS Rounded 1c"'), new Promise((r) => setTimeout(r, 1500))]);
    } catch { /* offline: fallback font */ }
    alley = new Alley(renderer);
    director = new CameraDirector(camera);
    lane = new LanePhysics(RAPIER);
    lane.rack();
    lane.onPinHit = (f, kind) => audio.pinHit(f, kind);
    for (let n = 1; n <= 10; n++) {
      const m = alley.makePinMesh();
      alley.scene.add(m);
      pinMeshes[n] = m;
    }
    syncPinsFromPhysics();
    ballBlob = alley.makeBlob(0.34);
    avatarBlob = alley.makeBlob(0.9);
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Mesh(alley.ballGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.18 - i * 0.05, depthWrite: false }));
      g.visible = false;
      alley.scene.add(g);
      ballGhosts.push(g);
    }
    buildCrowd();
    hud = new Hud(document.getElementById('hud'));
    audio = new Audio();
    ambient = new Ambient(alley, audio);
    screens = new Screens(document.getElementById('screens'), {
      start: () => startGame(),
      addLocal: () => addLocal(),
      removeLocal: (key) => { app.locals = app.locals.filter((l) => l.key !== key); refreshLobby(); },
      changeCharacter: (player, charId) => changePlayerCharacter(player, charId),
      kick: (slot) => link.kick(slot),
      again: () => playAgain(),
      lobby: () => toLobby(),
      resume: () => setPaused(false),
      quit: () => toLobby(),
    });
    window.addEventListener('resize', onResize);
    // Moving the window to a screen with another pixel density fires no resize.
    const watchDpr = () => {
      const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', () => { onResize(); watchDpr(); }, { once: true });
    };
    watchDpr();
    wireKeyboard();
    link = new DisplayLink();
    link.on('players', () => onPlayersChanged());
    link.on('join', ({ player }) => { audio.ui('join'); hud.toast(`${player.name} joined`); });
    link.on('rejoin', ({ player }) => { hud.toast(`${player.name}'s remote reconnected`); });
    link.on('leave', ({ slot, player }) => {
      audio.ui('leave');
      hud.toast(`${player?.name || 'A player'}'s remote disconnected`);
      // A held D-pad button / grip on that phone is released with it.
      const t = app.turn;
      if (t && !t.player.local && t.player.slot === slot) {
        stopRepeat();
        if (t.step === 'approach' && !t.pending) cancelApproach();
      }
    });
    link.on('info', (info) => { app.info = info; refreshLobby(); });
    link.on('input', onRemoteInput);
    link.on('status', (s) => { if (!s.connected && app.phase !== 'boot') hud.setNotice('Lost the connection to the game server — reconnecting…'); else if (s.connected) hud.setNotice(null); });
    toLobby();
    screens.hideBoot();
    requestAnimationFrame(loop);
    link.connect().then((info) => { app.info = info; refreshLobby(); }).catch((err) => {
      app.info = { error: err.message };
      refreshLobby();
      hud.setNotice(`${err.message} Keyboard play still works.`);
    });
    setInterval(syncPhones, 500);
  } catch (err) {
    console.error(err);
    screens?.bootError?.(`Could not start: ${err.message}`);
    if (!screens) { document.querySelector('#boot').classList.add('error'); bootText.textContent = `Could not start: ${err.message}`; }
  }
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(LOW ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  alley.resize(w, h);
}

// ---------------------------------------------------------------- crowd

function buildCrowd() {
  const npcColors = ['#d21e14', '#ff6e19', '#78d220', '#007830', '#3caade', '#f55a7d', '#7328ad', '#483818', '#e0e0e0', '#0a48b4', '#ffd820'];
  let k = 0;
  for (const seat of alley.seats) {
    if (seat.lane === 0) continue;               // our lane's seats are for the players
    if ((k++ * 7) % 3 === 0) continue;           // leave some seats empty
    const charId = CHARACTER_IDS[k % CHARACTER_IDS.length];
    const avatar = new Avatar({ color: npcColors[k % npcColors.length], seed: 100 + k, legs: false, character: charId });
    avatar.group.position.set(seat.x, 0.18, seat.z);
    avatar.group.rotation.y = 0;
    alley.scene.add(avatar.group);
    crowd.push({ avatar, seat });
  }
}

// Our players sit behind our lane while someone else bowls. Spectator Brainrot
// characters are kept per player across games; players who left are disposed.
function seatPlayers() {
  const seats = alley.seats.filter((s) => s.lane === 0);
  const keep = new Set(app.players.map((p) => p.key));
  for (let i = crowd.length - 1; i >= 0; i--) {
    const c = crowd[i];
    if (c.key && !keep.has(c.key)) { c.avatar.dispose(); crowd.splice(i, 1); }
  }
  for (const [key, m] of bowlerAvatars) if (!keep.has(key)) { m.dispose(); bowlerAvatars.delete(key); }
  app.players.forEach((p, i) => {
    let c = crowd.find((x) => x.key === p.key);
    if (!c) {
      c = { avatar: new Avatar({ color: colorHex(p.color), hand: p.hand, seed: hashKey(p.key), legs: false, character: p.character || DEFAULT_CHARACTER }), key: p.key };
      alley.scene.add(c.avatar.group);
      crowd.push(c);
    }
    c.avatar.setColor(colorHex(p.color));
    if (p.character && c.avatar.characterId !== p.character) c.avatar.setCharacter(p.character);
    c.seat = seats[i % seats.length];
    c.avatar.group.position.set(c.seat.x, 0.18, c.seat.z);
    c.avatar.group.visible = true;
  });
}

function crowdReact(kind) {
  for (const c of crowd) {
    if (kind === 'laugh') c.avatar.laugh();
    else if (kind === 'cheer') c.avatar.setPose('cheer');
    else c.avatar.setPose('idle');
    c.until = performance.now() + (kind === 'laugh' ? 1600 : 1800) + Math.random() * 400;
  }
}

function hashKey(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 100000;
}

function bowlerAvatar(p) {
  let m = bowlerAvatars.get(p.key);
  if (!m) {
    m = new Avatar({ color: colorHex(p.color), hand: p.hand, seed: hashKey(p.key), character: p.character || DEFAULT_CHARACTER });
    alley.scene.add(m.group);
    bowlerAvatars.set(p.key, m);
  }
  m.setColor(colorHex(p.color));
  m.setHand(p.hand);
  if (p.character && m.characterId !== p.character) m.setCharacter(p.character);
  return m;
}

// ---------------------------------------------------------------- lobby / players

// Phones (in slot order) then keyboard players. Phones keep the colour & character they
// chose; a keyboard player whose colour a phone took gets a free one.
function lobbySeats() {
  const seats = [];
  link.players.forEach((p, slot) => {
    if (p) seats.push({
      key: `s${slot}`,
      slot,
      local: false,
      name: p.name,
      color: p.color,
      hand: p.hand || 'right',
      character: p.character || (slot === 0 ? DEFAULT_CHARACTER : CHARACTER_IDS[slot % CHARACTER_IDS.length]),
      connected: p.connected,
    });
  });
  const used = new Set(seats.map((x) => x.color));
  for (const l of app.locals) {
    if (used.has(l.color)) l.color = (PLAYER_COLORS.find((c) => !used.has(c.id)) || PLAYER_COLORS[0]).id;
    used.add(l.color);
    seats.push({
      key: l.key,
      slot: null,
      local: true,
      name: l.name,
      color: l.color,
      hand: l.hand || 'right',
      character: l.character || (seats.length === 0 ? DEFAULT_CHARACTER : CHARACTER_IDS[seats.length % CHARACTER_IDS.length]),
      connected: true,
    });
  }
  return seats.slice(0, MAX_PLAYERS);
}

function refreshLobby() {
  if (app.phase === 'lobby') screens.renderLobby(app.info, lobbySeats(), { soundOn: audio.unlocked });
  if (app.phase === 'lobby') link?.setPhase(false, app.locals.length);   // keyboard players hold seats too
  syncPhones();
}

function hostSlot() {
  const seats = app.phase === 'lobby' || app.phase === 'boot' ? lobbySeats() : app.players;
  const seated = seats.find((p) => !p.local && link.players[p.slot]?.connected);
  if (seated) return seated.slot;
  const any = link.players.findIndex((p) => p && p.connected);
  return any;
}

function addLocal() {
  if (lobbySeats().length >= MAX_PLAYERS) return;
  const usedColors = new Set(lobbySeats().map((s) => s.color));
  const color = (PLAYER_COLORS.find((c) => !usedColors.has(c.id)) || PLAYER_COLORS[0]).id;
  const usedChars = new Set(lobbySeats().map((s) => s.character));
  const charId = (lobbySeats().length === 0 && !usedChars.has(DEFAULT_CHARACTER))
    ? DEFAULT_CHARACTER
    : (CHARACTER_IDS.find((id) => !usedChars.has(id)) || CHARACTER_IDS[lobbySeats().length % CHARACTER_IDS.length]);
  const n = app.locals.length + 1;
  const charObj = getCharacter(charId);
  app.locals.push({
    key: `L${Date.now().toString(36)}${n}`,
    name: charObj.shortName || `Guest ${n}`,
    color,
    hand: 'right',
    character: charId,
  });
  audio.ui('join');
  if (charId === 'tung_tung') audio.tungTungDrum(2, 0.16);
  refreshLobby();
}

function changePlayerCharacter(player, charId) {
  if (player.local) {
    const loc = app.locals.find((l) => l.key === player.key);
    if (loc) {
      loc.character = charId;
      if (loc.name.startsWith('Guest') || CHARACTER_IDS.some((id) => getCharacter(id).shortName === loc.name)) {
        loc.name = getCharacter(charId).shortName;
      }
    }
  } else if (player.slot !== null && player.slot !== undefined) {
    link.setProfile(player.slot, { character: charId });
    const lp = link.players[player.slot];
    if (lp) lp.character = charId;
  }
  audio.ui('select');
  if (charId === 'tung_tung') audio.tungTungDrum(2, 0.16);
  const bowler = bowlerAvatars.get(player.key);
  if (bowler) bowler.setCharacter(charId);
  refreshLobby();
}

function onPlayersChanged() {
  // Keep names / colours / characters of game players in sync with their phones.
  for (const p of app.players) {
    if (p.local) continue;
    const lp = link.players[p.slot];
    if (lp) {
      p.name = lp.name;
      p.color = lp.color;
      p.hand = lp.hand || p.hand;
      p.character = lp.character || p.character;
      p.connected = lp.connected;
    } else p.connected = false;
  }
  if (app.game) for (const gp of app.game.players) {
    const p = app.players.find((q) => q.key === gp.id);
    if (p) {
      gp.name = p.name;
      gp.color = p.color;
      gp.character = p.character;
    }
  }
  refreshLobby();
  updateNotice();
  updateChips();
}

function updateNotice() {
  if (app.phase !== 'game') { hud.setNotice(null); return; }
  const cur = currentPlayer();
  if (cur && !cur.local && !cur.connected) {
    const h = hostSlot();
    const by = h >= 0 && h !== cur.slot ? `, or ${link.players[h]?.name || 'Player 1'} can bowl for them` : '';
    hud.setNotice(`${cur.name}'s remote is disconnected — reopen the page on that phone${by} (keyboard: Space).`);
  }
  else hud.setNotice(null);
}

function updateChips() {
  if (app.phase !== 'game') { hud.chips([], null); return; }
  const cur = currentPlayer();
  hud.chips(app.players.map((p) => ({
    name: p.name, color: p.color, character: p.character, connected: p.connected, local: p.local, current: p === cur,
  })), app.info?.room);
}

// ---------------------------------------------------------------- phases

function toLobby() {
  stopRepeat();
  app.phase = 'lobby';
  app.game = null;
  app.turn = null;
  setPaused(false);
  link?.setPhase(false, app.locals.length);
  hud.hideAll();
  hud.setNotice(null);
  hud.chips([], null);
  screens.hideOver();
  screens.showLobby(app.info, lobbySeats(), { soundOn: audio.unlocked });
  director.set('lobby');
  for (const m of bowlerAvatars.values()) m.group.visible = false;
  if (ballMesh) ballMesh.visible = false;
  alley.setGuide(false);
  resetPinsetter();
  lane.removeBall();
  lane.rack();
  syncPinsFromPhysics();
  audio.rollStop(0.1);
  audio.music(true);
  syncPhones();
}

function startGame(players = lobbySeats()) {
  if (!players.length) return;
  stopRepeat();
  app.players = players.map((p) => ({ ...p }));
  app.game = new BowlingGame(app.players.map((p) => ({ id: p.key, name: p.name, color: p.color, character: p.character })));
  app.aims.clear();
  app.tips.clear();
  app.lastResult = null;
  app.lastThrow = null;
  app.phase = 'game';
  link.setPhase(true, app.players.filter((p) => p.local).length);
  screens.hideLobby();
  screens.hideOver();
  audio.ui('start');
  audio.music(false);
  seatPlayers();
  alley.setRackBalls(app.players.map((p) => colorHex(p.color)));
  resetPinsetter();
  lane.removeBall();
  lane.rack();
  syncPinsFromPhysics();
  newTurn(true);
  updateChips();
  syncPhones();
}

// Same players again, plus anyone whose phone joined during the game (they
// were told they would play the next one). Phones that left are dropped.
function playAgain() {
  const players = lobbySeats();
  if (!players.length) { toLobby(); return; }
  startGame(players);
}

function resetPinsetter() {
  alley.table.position.copy(alley.tableHome);
  alley.sweep.position.copy(alley.sweepHome);
}

function gameOver() {
  app.phase = 'over';
  app.turn = null;
  link.setPhase(false, app.locals.length);
  hud.hideAll();
  hud.setNotice(null);
  director.set('over');
  const board = app.game.board();
  const standings = app.game.standings();
  hud.chips([], null);
  screens.showOver(board, standings);
  audio.crowd('big');
  audio.ui('start');
  for (const m of bowlerAvatars.values()) m.group.visible = false;
  for (const c of crowd) if (c.key) { c.avatar.group.visible = true; c.avatar.setPose(standings[0] && app.players.find((p) => p.key === c.key)?.name === standings[0].name ? 'celebrate' : 'cheer'); c.until = performance.now() + 6000; }
  syncPhones();
}

function setPaused(p) {
  if (p === app.paused) return;
  if (p && app.phase !== 'game') return;
  app.paused = p;
  if (p) {
    stopRepeat();
    app.kb.space = false;
    // A throw in progress is called off; the bowler steps back and aims again.
    if (app.turn?.step === 'approach') goStep('aim');
    screens.showPause();
    audio.rollStop(0.1);
  } else {
    screens.hidePause();
    if (app.turn?.step === 'roll' && lane.ball) audio.roll(clamp(Math.hypot(lane.ball.linvel().x, lane.ball.linvel().z) / 10, 0, 1));
  }
  syncPhones();
}

// D-pad auto-repeat (held ◀ ▶).
function stopRepeat() {
  const t = app.turn;
  if (!t) return;
  clearInterval(t.repeat);
  clearTimeout(t.repeatDelay);
  t.repeat = t.repeatDelay = null;
}

// ---------------------------------------------------------------- turns

function currentPlayer() {
  if (!app.game) return null;
  const gp = app.game.player;
  return app.players.find((p) => p.key === gp.id) || null;
}

function newTurn(isNewPlayer) {
  const p = currentPlayer();
  const tb = app.game.turn();
  const aim = app.aims.get(p.key) || { aimX: 0, angle: 0 };
  app.turn = {
    step: 'intro',
    t: 0,
    player: p,
    frame: tb.frame,
    ball: tb.ball,
    freshRack: tb.freshRack,
    mode: 'move',
    zoom: false,
    aimX: aim.aimX,
    angle: aim.angle,
    armAngle: 62,
    armTarget: 62,
    approach: 0,
    gripAt: 0,
    bUpAt: 0,
    throwInfo: null,
    rel: null,
    result: null,
    sweepT: 0,
    standingBefore: new Set(lane.pins.filter((pp) => lane.pinStanding(pp)).map((pp) => pp.n)),
  };
  for (const [k, m] of bowlerAvatars) m.group.visible = k === p.key;
  for (const c of crowd) if (c.key) c.avatar.group.visible = c.key !== p.key;
  const avatar = bowlerAvatar(p);
  avatar.group.visible = true;
  avatar.setPose('hold');
  avatar.setGhost(0);
  placeBowler();
  ensureBall(p);
  if (isNewPlayer) {
    goStep('intro');
    audio.ui('turn');
    if (!p.local) {
      link.sendEvent(p.slot, { type: 'sound', name: 'turn' });
      link.sendEvent(p.slot, { type: 'vibrate', pattern: [40, 60, 40] });
    }
  } else {
    goStep('aim');
  }
  updateNotice();
  updateChips();
}

function goStep(step) {
  const turn = app.turn;
  turn.step = step;
  turn.t = 0;
  const p = turn.player;
  const avatar = bowlerAvatar(p);
  const board = app.game.board();
  const idx = app.game.players.findIndex((gp) => gp.id === p.key);
  switch (step) {
    case 'intro': {
      director.ctx.bowlerX = bowlerX();
      director.ctx.bowlerZ = BALL_START_Z;
      director.set('intro');
      hud.hideAll();
      const charObj = getCharacter(p.character || DEFAULT_CHARACTER);
      hud.showBanner(p.name, p.color, idx, app.players.length, `${charObj.name} · Frame ${turn.frame + 1}`, charObj.id);
      hud.showCard(board, idx);
      hud.showChips(false);
      audio.characterTheme(charObj.id);
      avatar.setGhost(0);
      avatar.setPose('hold');
      break;
    }
    case 'aim':
      stopRepeat();
      hud.hideBanner();
      hud.hideCard();
      hud.showChips(true);
      hud.clearMessage();
      hud.speed(null);
      hud.setPins(standingSet());
      hud.showMini(board[idx], turn.frame);
      hud.showPrompts(turn.mode, turn.zoom, p.local ? 'Hold Space and let go' : 'Hold B and swing');
      director.set(turn.zoom ? 'zoom' : 'aim');
      avatar.setPose('hold');
      avatar.setGhost(1);
      turn.approach = 0;
      turn.armAngle = turn.armTarget = 62;
      placeBowler();
      break;
    case 'approach':
      hud.hidePrompts();
      if (turn.zoom) { turn.zoom = false; director.set('aim'); }
      avatar.setPose('approach');
      break;
    case 'release':
      hud.hideMini();
      hud.setPins(null);
      alley.setGuide(false);
      avatar.setPose('follow');
      break;
    case 'roll':
      director.set('chase');
      avatar.setGhost(1);
      break;
    case 'result':
      director.set('pins');
      break;
    case 'react':
      hud.hideCard();
      director.ctx.bowlerX = bowlerX();
      director.ctx.bowlerZ = 0.4;
      director.set('react');
      avatar.setGhost(0);
      avatar.group.position.set(bowlerX(), 0, 0.45);
      avatar.group.rotation.y = 0;               // facing down the lane = toward the camera
      if (['strike', 'spare'].includes(turn.result?.kind)) { avatar.setPose('celebrate'); crowdReact('cheer'); }
      else avatar.setPose('slump');
      break;
    case 'sweep':
      hud.clearMessage();
      turn.sweepT = 0;
      startSweep();
      if (!turn.nextIsNewPlayer && !app.game.over) {
        turn.approach = 0;
        avatar.approach = 0;
        turn.armAngle = avatar.armAngle = 62;
        director.set('aim');
        placeBowler();
        avatar.setGhost(1);
        avatar.setPose('hold');
      } else director.set('pins');
      if (!app.game.over) hud.showCard(board, idx, { top: true, compact: true });
      audio.machine();
      break;
    case 'drop':
      director.ctx.bowlerX = bowlerX();
      director.set('back');
      avatar.setGhost(0);
      hud.hidePrompts();
      hud.hideMini();
      hud.setPins(null);
      alley.setGuide(false);
      audio.crowd('gasp');
      setTimeout(() => { crowdReact('laugh'); audio.crowd('cheer'); }, 450);
      break;
    default: break;
  }
  syncPhones();
}

// The avatar stands so its ball hand is on the aim line, facing the aim direction.
function bowlerX() { return app.turn ? app.turn.aimX - handSide() * 0.24 : 0; }
function handSide() { return app.turn?.player?.hand === 'left' ? -1 : 1; }

function placeBowler() {
  const turn = app.turn;
  const avatar = bowlerAvatar(turn.player);
  const a = turn.angle * Math.PI / 180;
  // Along the aim line from the start to just behind the foul line.
  const travel = (BALL_START_Z - 0.35) * smooth(0, 1, turn.approach);
  const bx = turn.aimX + Math.sin(a) * travel / Math.cos(a) * 1;
  const bz = BALL_START_Z - travel;
  const side = handSide() * 0.24;
  avatar.group.position.set(bx - Math.cos(a) * side, 0, bz + 0.45 - Math.sin(a) * side * 0);
  avatar.group.rotation.y = -a;
  director.ctx.bowlerX = turn.aimX;
  director.ctx.bowlerZ = BALL_START_Z + 0.45;
  director.ctx.angle = a;
}

function standingSet() {
  return new Set(lane.pins.filter((p) => lane.pinStanding(p)).map((p) => p.n));
}

function ensureBall(p) {
  const hex = colorHex(p.color);
  if (!ballMesh || ballMesh.userData.hex !== hex) {
    if (ballMesh) alley.scene.remove(ballMesh);
    ballMesh = alley.makeBall(hex);
    ballMesh.userData.hex = hex;
    alley.scene.add(ballMesh);
  }
  ballMesh.visible = true;
}

// ---------------------------------------------------------------- inputs

// Who may bowl the current ball: its player's phone, the TV keyboard, and —
// when that player's phone is gone — the host's phone (bowling for them).
function controllerSlot() {
  const p = currentPlayer();
  if (!p || p.local) return -1;
  if (link.players[p.slot]?.connected) return p.slot;
  return hostSlot();
}

function canControl(slot) {
  const p = currentPlayer();
  return app.phase === 'game' && !app.paused && !!app.turn && !!p && (slot === 'kb' || slot === controllerSlot());
}

function isHostSlot(slot) {
  const h = hostSlot();
  return h === -1 || h === slot;
}

const isGameSlot = (slot) => app.players.some((p) => !p.local && p.slot === slot);

function onRemoteInput(msg) {
  const slot = msg.slot;
  if (msg.t === 'menu') { onMenu(msg.action, slot); return; }
  if (!canControl(slot)) {
    if ((msg.t === 'throw' || (msg.t === 'btn' && msg.b === 'b' && msg.down)) && app.turn) {
      const now = performance.now();
      if (now - (app.toastAt.get(slot) || 0) > 2000) {
        app.toastAt.set(slot, now);
        link.sendEvent(slot, { type: 'toast', text: app.paused ? 'The game is paused' : 'Wait for your turn' });
      }
    }
    return;
  }
  if (msg.t === 'btn') onButton(msg.b, msg.down);
  else if (msg.t === 'swing') { if (app.turn.step === 'approach') app.turn.armTarget = msg.a; }
  else if (msg.t === 'throw') {
    if (app.throwIds.get(slot) === msg.id) return;      // a retried duplicate
    app.throwIds.set(slot, msg.id);
    onThrow(msg);
  } else if (msg.t === 'cancel') cancelApproach();
}

function onMenu(action, slot) {
  const player = slot === 'kb' || isGameSlot(slot) || isHostSlot(slot);
  if (action === 'pause' && app.phase === 'game') { if (player) setPaused(true); return; }
  if (action === 'resume') { if (player) setPaused(false); return; }
  if (action === 'quit' && app.paused) { if (slot === 'kb' || isHostSlot(slot)) toLobby(); return; }
  if (slot !== 'kb' && !isHostSlot(slot)) return;
  if (action === 'start' && app.phase === 'lobby') startGame();
  else if (action === 'again' && app.phase === 'over') playAgain();
  else if (action === 'lobby' && app.phase === 'over') toLobby();
}

function onButton(b, down) {
  const turn = app.turn;
  if (!turn) return;
  if (b === 'a' && down && (turn.step === 'intro')) { goStep('aim'); return; }
  if (b === 'a' && down && ['result', 'react', 'sweep'].includes(turn.step)) { turn.fast = true; return; }
  if (turn.step === 'intro' && down && b !== 'b') { goStep('aim'); return; }
  if (turn.step === 'aim') {
    if (b === 'a' && down && turn.t < 0.35) return;     // a late "skip intro" tap, not a mode switch
    if (b === 'a' && down) {
      turn.mode = turn.mode === 'move' ? 'turn' : 'move';
      audio.ui('blip');
      hud.showPrompts(turn.mode, turn.zoom, turn.player.local ? 'Hold Space and let go' : 'Hold B and swing');
      syncPhones();
    } else if (b === 'up' && down) {
      turn.zoom = !turn.zoom;
      director.set(turn.zoom ? 'zoom' : 'aim');
      hud.showPrompts(turn.mode, turn.zoom, turn.player.local ? 'Hold Space and let go' : 'Hold B and swing');
      audio.ui('blip');
      syncPhones();
    } else if (b === 'left' || b === 'right') {
      const dir = b === 'left' ? -1 : 1;
      if (down) {
        stepAim(dir);
        clearInterval(turn.repeat);
        clearTimeout(turn.repeatDelay);
        turn.repeatDelay = setTimeout(() => { turn.repeat = setInterval(() => { if (app.turn === turn && turn.step === 'aim' && !app.paused) stepAim(dir); else stopRepeat(); }, 70); }, 320);
      } else {
        clearInterval(turn.repeat);
        clearTimeout(turn.repeatDelay);
      }
    } else if (b === 'b' && down) {
      startApproach();
    }
  } else if (turn.step === 'approach') {
    if (b === 'b' && !down) turn.bUpAt = performance.now();
  }
  if (!down && (b === 'left' || b === 'right')) { clearInterval(turn.repeat); clearTimeout(turn.repeatDelay); }
}

function stepAim(dir) {
  const turn = app.turn;
  if (turn.mode === 'move') turn.aimX = clamp(Math.round((turn.aimX + dir * AIM_STEP) / AIM_STEP) * AIM_STEP, -AIM_X_MAX, AIM_X_MAX);
  else turn.angle = clamp(Math.round((turn.angle + dir * ANGLE_STEP) / ANGLE_STEP) * ANGLE_STEP, -ANGLE_MAX, ANGLE_MAX);
  app.aims.set(turn.player.key, { aimX: turn.aimX, angle: turn.angle });
  audio.ui('blip');
  placeBowler();
}

function startApproach() {
  const turn = app.turn;
  if (turn.step !== 'aim') return;
  stopRepeat();
  turn.gripAt = performance.now();
  turn.bUpAt = 0;
  turn.pending = null;
  turn.armTarget = 62;
  goStep('approach');
}

function cancelApproach() {
  const turn = app.turn;
  if (!turn || (turn.step !== 'approach')) return;
  goStep('aim');
}

// th: { speed 0..1, spin −1..1 (+ = curves right), quality, mode }
function onThrow(th) {
  const turn = app.turn;
  if (turn.step === 'aim' && th.quality !== 'none') { turn.gripAt = performance.now(); goStep('approach'); }
  if (turn.step !== 'approach' || turn.pending) return;
  if (th.quality === 'none') { cancelApproach(); return; }
  if (th.quality === 'drop') { startDrop(th); return; }
  // Like the original, the ball leaves the hand at the foul line: a throw that
  // arrives mid-walk hurries the last steps (~0.2 s), then releases.
  if (turn.approach < 0.999) { turn.pending = th; turn.rushRate = (1 - turn.approach) / 0.22; turn.armTarget = -10; return; }
  release(th);
}

// The swing decides the throw: arm speed → ball speed; the release point
// (degrees from the bottom of the swing) → speed lost, line, loft and hook.
function release(th) {
  const turn = app.turn;
  const relDeg = Number.isFinite(th.rel) ? th.rel : th.quality === 'loft' ? 50 : undefined;
  const fx = releaseEffects(relDeg, turn.player.hand);
  const grade = releaseGrade(relDeg);
  const speed = clamp(th.speed, 0, 1.1);
  const mps = speedToMps(speed) * fx.speedK;
  turn.throwInfo = { ...th, mps, fx };
  // The bowler walked the aim line; a mistimed release sends the ball off it.
  const aim = turn.angle * Math.PI / 180;
  const a = (turn.angle + fx.lineDeg) * Math.PI / 180;
  const xEdge = DIM.gutterOuter - DIM.ballRadius - 0.01;
  const xLine = clamp(turn.aimX + Math.tan(aim) * BALL_START_Z, -xEdge, xEdge);
  const loft = fx.loftY > 0.02;
  // Where the ball physically starts: on the lane just past the foul line.
  turn.rel = {
    from: alley && bowlerAvatar(turn.player).handWorld(new THREE.Vector3()),
    to: new THREE.Vector3(clamp(xLine + Math.sin(a) * 0.12, -xEdge, xEdge), DIM.ballRadius + fx.loftY + (fx.dumpVy < 0 ? 0.06 : 0), -0.12),
    t: 0,
    dur: 0.16,
    loft,
    loftVy: fx.loftVy,
    dumpVy: fx.dumpVy,
    spin: clamp(th.spin * fx.spinK, -1, 1),
    mps,
    angle: a,
  };
  app.lastThrow = { mph: Math.round(mps * MPS_TO_MPH), spin: th.spin, release: relDeg ?? null, grade: grade.grade, label: grade.short, tone: grade.tone };
  audio.ui('release');
  goStep('release');
}

function launchBall() {
  const rel = app.turn.rel;
  lane.throwBall({ x: rel.to.x, z: rel.to.z, angle: rel.angle, mps: rel.mps, spin: rel.spin });
  if (rel.loft || rel.dumpVy < 0) {
    // Late: the ball leaves the hand high, flies and bounces. Early: it is
    // dumped onto the lane with a thud.
    lane.ball.setTranslation({ x: rel.to.x, y: rel.to.y, z: rel.to.z }, true);
    const v = lane.ball.linvel();
    const vy = rel.loft ? rel.loftVy : rel.dumpVy;
    lane.ball.setLinvel({ x: v.x, y: vy, z: v.z }, true);
    const h = rel.to.y - DIM.ballRadius;
    const tLand = (vy + Math.sqrt(vy * vy + 2 * 9.81 * h)) / 9.81;   // time to fall h with upward speed vy
    const thud = 300 + Math.abs(vy) * 500 + h * 1500;
    setTimeout(() => audio.pinHit(thud, 'floor'), Math.max(20, tLand * 1000 / Math.max(0.1, app.timeScale)));
    if (rel.loft && rel.loftVy > 0.9) setTimeout(() => audio.crowd('gasp'), 200);
  }
  audio.roll(clamp(rel.mps / 10, 0, 1));
  hud.speed(`${app.lastThrow.mph} mph${app.lastThrow.label ? `  ·  ${app.lastThrow.label}` : ''}`, app.lastThrow.tone);
  app.turn.maxSpeed = rel.mps;
  goStep('roll');
}

function startDrop() {
  const turn = app.turn;
  const from = bowlerAvatar(turn.player).handWorld(new THREE.Vector3());
  turn.drop = { from, t: 0 };
  app.lastResult = { title: 'Oops!', sub: 'You let go during the backswing', kind: 'drop' };
  hud.message('oops', 'Oops!', 'Let go at the bottom of the swing', 2200);
  goStep('drop');
}

// ---------------------------------------------------------------- results

function finishRoll() {
  const turn = app.turn;
  audio.rollStop(0.3);
  const res = lane.result();
  const standing = new Set(res.standing);
  const before = turn.standingBefore;
  // Only pins that stood before this ball count (USBC: a pin that was down stays down).
  const knocked = [...before].filter((n) => !standing.has(n)).length;
  const leave = [...before].filter((n) => standing.has(n));
  const p = turn.player;
  const r = app.game.roll(knocked, leave);
  const streak = r.strike ? app.game.strikeStreak(app.game.players.findIndex((gp) => gp.id === p.key)) : 0;
  let kind, title, sub = null;
  if (r.strike) {
    kind = 'strike';
    title = 'Strike';
    sub = streakName(streak);
    audio.crash(1);
    audio.crowd(streak >= 2 ? 'big' : 'cheer');
    audio.characterTheme(p.character || DEFAULT_CHARACTER);
  } else if (r.spare) {
    kind = 'spare';
    title = 'Spare';
    audio.crowd('cheer');
    audio.characterTheme(p.character || DEFAULT_CHARACTER);
  } else if (res.gutter && knocked === 0) {
    kind = 'gutter';
    title = 'Gutter';
    audio.crowd('groan');
  } else {
    kind = r.split ? 'split' : 'pins';
    title = `${knocked} pin${knocked === 1 ? '' : 's'}`;
    if (r.split) { sub = r.leaveName ? `Split · ${r.leaveName}` : 'Split'; audio.crowd('gasp'); }
    else if (knocked === 9 && r.firstBall) audio.crowd('clap');
    else if (!r.firstBall && knocked === 0) audio.crowd('groan');
  }
  if (kind === 'strike') hud.message('strike', title, sub, 2400);
  else hud.message(kind === 'gutter' ? 'gutter' : 'pins', title, sub, 2200);
  app.lastResult = { title: sub && kind === 'strike' ? `${title}! ${sub}` : `${title}${kind === 'strike' || kind === 'spare' ? '!' : ''}`, sub: kind === 'strike' ? null : sub, kind };
  turn.result = { kind, knocked, r, streak };
  // Phone feedback.
  if (!p.local) {
    if (kind === 'strike') { link.sendEvent(p.slot, { type: 'sound', name: 'strike' }); link.sendEvent(p.slot, { type: 'vibrate', pattern: [60, 40, 60, 40, 120] }); }
    else if (kind === 'spare') { link.sendEvent(p.slot, { type: 'sound', name: 'spare' }); link.sendEvent(p.slot, { type: 'vibrate', pattern: [60, 50, 90] }); }
  }
  app.tips.set(p.key, tipFor(res, r, knocked));
  // What comes next?
  const after = app.game.over ? null : app.game.turn();
  turn.nextIsNewPlayer = r.turnOver || app.game.over;
  turn.nextFresh = after ? after.freshRack : true;
  turn.leave = leave;
  hud.speed(null);
  goStep('result');
}

function tipFor(res, r, knocked) {
  const g = app.lastThrow?.grade;
  if (g === 'way-early' || g === 'early') return 'Tip: you let go early. Wait until your arm swings down past your leg, then lift your thumb.';
  if (g === 'lofted' || g === 'late') return 'Tip: you let go late, so the ball flew and bounced. Lift your thumb right at the bottom of the swing.';
  if (res.gutter) return 'Tip: press ◀ ▶ to line up with the pins, or A then ◀ ▶ to turn.';
  if (r.split && Math.abs(res.hitBoard ?? 1) < 0.03) return 'Tip: a ball straight into the head pin splits. Aim just right of it, between the 1 and 3 pins.';
  if (r.firstBall && knocked < 7) return 'Tip: twist your wrist as you let go to curve the ball into the pocket.';
  return '';
}

// ---------------------------------------------------------------- pinsetter

// Builds the sweep plan: which pins get lifted and re-set, which are swept.
function startSweep() {
  const turn = app.turn;
  const snap = lane.snapshot();
  const keep = turn.nextIsNewPlayer || turn.nextFresh ? new Set() : new Set(turn.leave);
  turn.sweep = {
    keep,
    fresh: turn.nextIsNewPlayer || turn.nextFresh,
    pins: snap.pins.map((s) => ({ n: s.n, p: new THREE.Vector3(s.p.x, s.p.y, s.p.z), q: new THREE.Quaternion(s.q.x, s.q.y, s.q.z, s.q.w), standing: keep.has(s.n) })),
  };
  // Hide pins that already fell into the pit.
  lane.removeBall();
  if (ballMesh) ballMesh.visible = false;
}

// t: seconds into the sweep. Returns true when finished.
function updateSweep(t) {
  const sw = app.turn.sweep;
  const table = alley.table, sweep = alley.sweep;
  const T = { lowerA: 0.55, liftA: 0.95, barDown: 1.25, barBack: 2.0, barHome: 2.5, set: 3.0, home: 3.4 };
  // Table: down to grab standing pins, up, then down again to set pins.
  let ty = alley.tableHome.y;
  const grabY = DIM.pinHeight + 0.03, holdY = 0.85;
  if (sw.keep.size) {
    if (t < T.lowerA) ty = lerp(alley.tableHome.y, grabY, smooth(0, T.lowerA, t));
    else if (t < T.liftA) ty = lerp(grabY, holdY, smooth(T.lowerA, T.liftA, t));
    else if (t < T.barHome) ty = holdY;
    else if (t < T.set) ty = lerp(holdY, grabY, smooth(T.barHome, T.set, t));
    else ty = lerp(grabY, alley.tableHome.y, smooth(T.set, T.home, t));
  } else {
    if (t < T.barHome) ty = alley.tableHome.y;
    else if (t < T.set) ty = lerp(alley.tableHome.y, grabY, smooth(T.barHome, T.set, t));
    else ty = lerp(grabY, alley.tableHome.y, smooth(T.set, T.home, t));
  }
  table.position.y = ty;
  // Sweep bar: down in front of the pins, back to the pit, home again.
  const front = alley.sweepHome.z, backZ = DIM.deckEndZ - 0.05;
  let by = alley.sweepHome.y, bz = front;
  if (t < T.barDown) by = lerp(alley.sweepHome.y, 0.08, smooth(0.6, T.barDown, t));
  else if (t < T.barBack) { by = 0.08; bz = lerp(front, backZ, smooth(T.barDown, T.barBack, t)); }
  else if (t < T.barHome) { by = lerp(0.08, alley.sweepHome.y, smooth(T.barBack, T.barHome, t)); bz = lerp(backZ, front, smooth(T.barBack, T.barHome, t)); }
  sweep.position.set(0, by, bz);
  // Pins.
  const lifted = sw.keep.size > 0;
  for (const pin of sw.pins) {
    const m = pinMeshes[pin.n];
    if (pin.standing) {
      // Lifted with the table (upright), set back where they stood.
      const yLift = t > T.lowerA && t < T.set + 0.05 && lifted ? Math.max(0, ty - grabY) : 0;
      m.position.set(pin.p.x, yLift, pin.p.z);
      m.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pin.n * 1.7), 0.2);
      m.visible = true;
    } else {
      // Dead wood: pushed into the pit by the bar.
      const pz = Math.min(pin.p.z, bz - 0.08);
      const inPit = pz < DIM.deckEndZ || pin.p.y < -0.1;
      m.position.set(pin.p.x, inPit ? Math.max(-0.5, pin.p.y - (DIM.deckEndZ - pz) * 2) : pin.p.y, pz);
      m.quaternion.copy(pin.q);
      m.visible = !(inPit && t > T.barBack);
    }
  }
  // A fresh rack comes down with the table.
  if (sw.fresh && t > T.barHome) {
    for (let n = 1; n <= 10; n++) {
      const m = pinMeshes[n];
      const s = pinSpot(n);
      m.visible = true;
      m.position.set(s.x, t < T.set ? Math.max(0, ty - grabY) : 0, s.z);
      m.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), n * 1.7);
    }
  }
  return t >= T.home;
}

function finishSweep() {
  const turn = app.turn;
  alley.table.position.copy(alley.tableHome);
  alley.sweep.position.copy(alley.sweepHome);
  if (turn.sweep.fresh) lane.rack();
  else lane.respot([...turn.sweep.keep]);
  syncPinsFromPhysics();
  if (app.game.over) { gameOver(); return; }
  newTurn(turn.nextIsNewPlayer);
}

// ---------------------------------------------------------------- per-frame update

function syncPinsFromPhysics() {
  const snap = lane.snapshot();
  const seen = new Set();
  for (const s of snap.pins) {
    const m = pinMeshes[s.n];
    m.position.set(s.p.x, s.p.y, s.p.z);
    m.quaternion.set(s.q.x, s.q.y, s.q.z, s.q.w);
    m.visible = s.p.y > -0.6;
    seen.add(s.n);
  }
  for (let n = 1; n <= 10; n++) if (!seen.has(n)) pinMeshes[n].visible = false;
}

function updateTurn(dt) {
  const turn = app.turn;
  if (!turn) return;
  turn.t += dt;
  const avatar = bowlerAvatar(turn.player);
  const speedUp = turn.fast ? 3 : 1;
  switch (turn.step) {
    case 'intro':
      if (turn.t > 1.9) goStep('aim');
      break;
    case 'aim':
      alley.setGuide(true, turn.aimX, BALL_START_Z, turn.angle * Math.PI / 180);
      placeBowler();
      break;
    case 'approach': {
      turn.approach = Math.min(1, turn.approach + dt * (turn.pending ? turn.rushRate : 1 / APPROACH_TIME));
      avatar.approach = turn.approach;
      if (turn.player.local) {
        // Keyboard: a pendulum swing in time with the power meter.
        const tt = (performance.now() - app.kb.spaceAt) / 1000;
        turn.armTarget = 62 - 132 * (1 - Math.cos(Math.min(tt, 1.6) * Math.PI / 1.6)) / 2;
      }
      turn.armAngle = lerp(turn.armAngle, turn.armTarget, 1 - Math.exp(-dt * 18));
      avatar.armAngle = turn.armAngle;
      if (turn.approach >= 1 && avatar.pose === 'approach') avatar.setPose('swing');
      placeBowler();
      if (turn.pending && turn.approach >= 1) { const th = turn.pending; turn.pending = null; release(th); break; }
      // B came up but no throw arrived (lost message): give up after a moment.
      if (turn.bUpAt && !turn.pending && performance.now() - turn.bUpAt > 1500) cancelApproach();
      // Held B for ages without throwing.
      if (turn.t > 12) cancelApproach();
      break;
    }
    case 'release': {
      const rel = turn.rel;
      rel.t += dt;
      avatar.armAngle = Math.max(avatar.armAngle, lerp(turn.armAngle, 40, rel.t / rel.dur));
      const k = smooth(0, rel.dur, rel.t);
      tmpV.copy(rel.from).lerp(rel.to, k);
      if (ballMesh) ballMesh.position.copy(tmpV);
      if (rel.t >= rel.dur) launchBall();
      break;
    }
    case 'roll': {
      const live = lane.step(dt);
      const b = lane.ball;
      if (b) {
        const p = b.translation(), v = b.linvel();
        director.ctx.ball = { x: p.x, z: p.z };
        audio.rollUpdate(Math.hypot(v.x, v.z), clamp(-p.z / DIM.laneLength, 0, 1), Math.abs(p.x) > DIM.laneHalfWidth);
        if (p.z < DIM.headPinZ + 0.6 && !turn.hitSoundDone && lane.roll?.firstHitAt !== null) { turn.hitSoundDone = true; audio.crowd('gasp'); }
      }
      if (!live) finishRoll();
      break;
    }
    case 'result':
      lane.step(dt);
      if (turn.t > 2.3 / speedUp) {
        const k = turn.result.kind;
        if (k === 'strike' || k === 'spare' || k === 'gutter' || (k === 'split')) goStep('react');
        else goStep('sweep');
      }
      break;
    case 'react':
      if (turn.t > 1.7 / speedUp) goStep('sweep');
      break;
    case 'sweep':
      turn.sweepT += dt * speedUp;
      if (updateSweep(turn.sweepT)) finishSweep();
      break;
    case 'drop': {
      const d = turn.drop;
      d.t += dt;
      // The ball rolls backwards off the approach toward the seats.
      const z = d.from.z + Math.min(6, d.t * 2.6 - d.t * d.t * 0.12);
      const y = d.t < 0.25 ? lerp(d.from.y, DIM.ballRadius, d.t / 0.25) : DIM.ballRadius + (z > 5.4 ? -0.12 : 0);
      if (ballMesh) {
        ballMesh.position.set(d.from.x + d.t * 0.1, Math.max(DIM.ballRadius - 0.12, y), z);
        ballMesh.rotation.x += dt * 20;
      }
      avatar.setPose('slump');
      if (d.t > 3) {
        app.lastResult = null;
        goStep('aim');
      }
      break;
    }
    default: break;
  }
  // Physics-driven pins (not during the sweep).
  if (turn.step !== 'sweep') syncPinsFromPhysics();
}

function updateBall(dt) {
  const turn = app.turn;
  if (!ballMesh) return;
  for (const g of ballGhosts) g.visible = false;
  if (!turn || app.phase !== 'game') { ballBlob.visible = false; return; }
  const step = turn.step;
  if (step === 'intro' || step === 'aim' || step === 'approach') {
    ballMesh.visible = true;
    bowlerAvatar(turn.player).handWorld(tmpV);
    ballMesh.position.copy(tmpV);
  } else if (step === 'roll' || step === 'result') {
    const b = lane.ball;
    if (b) {
      const p = b.translation(), q = b.rotation(), v = b.linvel();
      ballMesh.visible = p.y > -0.5;
      ballMesh.position.set(p.x, p.y, p.z);
      ballMesh.quaternion.set(q.x, q.y, q.z, q.w);
      // Motion-blur ghosts stretched along the velocity (like the original).
      const sp = Math.hypot(v.x, v.z);
      if (sp > 3 && step === 'roll') {
        ballGhosts.forEach((g, i) => {
          g.visible = true;
          g.position.set(p.x - v.x * 0.012 * (i + 1), p.y, p.z - v.z * 0.012 * (i + 1));
        });
      }
    } else if (step === 'result') ballMesh.visible = false;
  }
  ballBlob.visible = ballMesh.visible && ballMesh.position.y < 0.6 && ballMesh.position.y > -0.05;
  ballBlob.position.set(ballMesh.position.x, 0.003, ballMesh.position.z);
  void dt;
}

let last = performance.now();
let lastSync = 0;
function loop(now) {
  requestAnimationFrame(loop);
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (app.paused) dt = 0;
  dt *= app.timeScale;
  app.frameCount++;
  if (app.phase === 'game') updateTurn(dt);
  updateBall(dt);
  for (const m of bowlerAvatars.values()) if (m.group.visible) m.update(dt);
  ambient.update(dt);
  const nowMs = performance.now();
  for (const c of crowd) {
    if (c.until && nowMs > c.until) { c.until = 0; c.avatar.setPose('idle'); c.avatar.group.rotation.y = 0; }
    c.avatar.update(dt);
  }
  // Avatar shadow blob.
  const cur = app.turn && bowlerAvatar(app.turn.player);
  avatarBlob.visible = !!(cur && cur.group.visible && app.phase === 'game');
  if (cur) avatarBlob.position.set(cur.group.position.x, 0.002, cur.group.position.z);
  // Shadow focus: pins while rolling / settling, the bowler otherwise.
  const step = app.turn?.step;
  if (step === 'roll' || step === 'result' || step === 'sweep') alley.focusShadow(0, DIM.headPinZ - 0.4);
  else if (cur) alley.focusShadow(cur.group.position.x, cur.group.position.z - 0.6);
  // Keyboard power meter.
  if (app.kb.space && app.turn?.step === 'approach') hud.power(kbPower(), app.kb.spin);
  else hud.power(null);
  director.update(dt || 0.0001);
  alley.setReflection(!['intro', 'react', 'back'].includes(director.mode));   // shots that face away from the lane
  renderer.render(alley.scene, camera);
  if (nowMs - lastSync > 250) { lastSync = nowMs; syncPhones(); }
}

// ---------------------------------------------------------------- phones

function syncPhones() {
  if (!link) return;
  const seatsLobby = lobbySeats();
  const hSlot = hostSlot();
  const hostName = hSlot >= 0 ? link.players[hSlot]?.name : null;
  const ctrl = app.phase === 'game' ? controllerSlot() : -1;
  const board = app.game ? app.game.board() : null;
  const turn = app.turn;
  const cur = currentPlayer();
  const standings = app.phase === 'over' && app.game ? app.game.standings() : null;
  const order = app.game ? app.game.players.map((gp) => gp.id) : [];
  // Who bowls after the current player (skipping anyone who has finished)?
  let nextName = null, nextSlot = -1;
  if (app.game && cur) {
    const i = order.indexOf(cur.key);
    for (let k = 1; k < order.length; k++) {
      const gp = app.game.players[(i + k) % order.length];
      if (nextBall(gp.rolls).done) continue;
      const nxt = app.players.find((p) => p.key === gp.id);
      nextName = nxt?.name || null;
      nextSlot = nxt && !nxt.local ? nxt.slot : -1;
      break;
    }
  }
  for (let slot = 0; slot < MAX_PLAYERS; slot++) {
    const lp = link.players[slot];
    if (!lp) continue;
    const me = app.players.find((p) => !p.local && p.slot === slot);
    const inGame = app.phase !== 'lobby' && !!me;
    const phase = app.paused ? 'paused' : app.phase === 'boot' ? 'lobby' : app.phase;
    const list = (app.phase === 'lobby' || !inGame ? seatsLobby : app.players).map((p, i) => ({
      slot: p.slot ?? -1, seat: i, name: p.name, color: p.color, character: p.character || DEFAULT_CHARACTER, local: p.local, connected: p.local || !!link.players[p.slot]?.connected,
      total: board ? board.find((b) => b.id === p.key)?.total ?? 0 : 0, isYou: !p.local && p.slot === slot, isTurn: cur ? p.key === cur.key : false,
    }));
    const st = {
      phase,
      you: { slot, name: lp.name, color: lp.color, character: lp.character || DEFAULT_CHARACTER, hand: lp.hand },
      host: hSlot === slot,
      hostName: hostName || 'Player 1',
      players: list,
      spectator: app.phase !== 'lobby' && !me,
    };
    if (app.phase === 'game' && turn && cur) {
      // Yours — or the host bowling for a player whose phone is gone.
      const yours = ctrl === slot;
      const forOther = yours && cur.slot !== slot;
      const stepMap = { intro: 'intro', aim: 'aim', approach: 'approach', release: 'roll', roll: 'roll', result: 'result', react: 'result', sweep: 'sweep', drop: 'result' };
      st.turn = {
        slot: cur.local ? -1 : cur.slot, name: cur.name, color: cur.color, character: cur.character || DEFAULT_CHARACTER, frame: turn.frame + 1, ball: turn.ball + 1, yours,
        step: stepMap[turn.step] || 'aim', mode: turn.mode, zoom: turn.zoom, standing: turn.standingBefore.size,
        forName: forOther ? cur.name : null,
      };
      st.canThrow = yours && (turn.step === 'aim' || turn.step === 'approach') && !app.paused;
      st.result = ['result', 'react', 'sweep', 'drop'].includes(turn.step) ? app.lastResult : null;
      st.lastThrow = app.lastThrow;
      st.nextName = nextName;
      st.nextSlot = nextSlot;
      st.tip = yours && !forOther && ['result', 'react', 'sweep'].includes(turn.step) ? app.tips.get(cur.key) || '' : '';
      if (st.spectator) st.tip = 'You’ll join the next game.';
    }
    if (standings) st.standings = standings.map((s) => ({ name: s.name, color: s.color, character: s.character || DEFAULT_CHARACTER, total: s.total, place: s.place, isYou: app.players[s.index] && !app.players[s.index].local && app.players[s.index].slot === slot }));
    link.sendState(slot, st);
  }
}

// ---------------------------------------------------------------- keyboard

function kbPower() {
  const t = (performance.now() - app.kb.spaceAt) / 1000;
  return 0.2 + 0.8 * (1 - Math.cos((t % 1.6) / 1.6 * Math.PI * 2)) / 2;
}

function wireKeyboard() {
  const unlock = () => {
    const was = audio.unlocked;
    audio.unlock();
    if (!was) setTimeout(() => { if (audio.unlocked) refreshLobby(); }, 50);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', (e) => {
    unlock();
    if (e.repeat && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') { if (e.code === 'Space') e.preventDefault(); return; }
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const key = e.code;
    if (key === 'KeyM') { audio.setMuted(!audio.muted); hud.toast(audio.muted ? 'Sound off' : 'Sound on'); return; }
    if (app.phase === 'lobby') {
      if (key === 'Enter') startGame();
      return;
    }
    if (app.phase === 'over') {
      if (key === 'Enter') playAgain();
      if (key === 'Escape') toLobby();
      return;
    }
    if (app.phase !== 'game') return;
    if (key === 'Escape' || key === 'KeyP') { setPaused(!app.paused); return; }
    if (app.paused) return;
    const turn = app.turn;
    if (!turn) return;
    e.preventDefault();
    if (key === 'Space') {
      if (turn.step === 'intro') { goStep('aim'); return; }
      if (turn.step === 'aim' && !app.kb.space && !e.repeat) {
        app.kb.space = true;
        app.kb.spaceAt = performance.now();
        app.kb.spin = 0;
        onButton('b', true);
      }
      return;
    }
    if (turn.step === 'approach' && app.kb.space && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      app.kb.spin = clamp(Math.round((app.kb.spin + (key === 'ArrowLeft' ? -1 : 1) / 3) * 3) / 3, -1, 1);
      return;
    }
    if (e.repeat) return;
    const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', KeyA: 'a', Enter: 'a' };
    if (map[key]) onButton(map[key], true);
  });
  window.addEventListener('keyup', (e) => {
    const key = e.code;
    if (app.phase !== 'game' || !app.turn) return;
    if (key === 'Space' && app.kb.space) {
      app.kb.space = false;
      if (app.turn.step === 'approach' && !app.paused) onThrow({ speed: kbPower(), spin: app.kb.spin, quality: 'ok', mode: 'keyboard' });
      return;
    }
    const map = { ArrowLeft: 'left', ArrowRight: 'right' };
    if (map[key]) onButton(map[key], false);
  });
}

// ---------------------------------------------------------------- debug / test API

window.__bowl = {
  get app() { return app; },
  get lane() { return lane; },
  get link() { return link; },
  get screens() { return screens; },
  addLocal: (name) => { addLocal(); if (name) app.locals[app.locals.length - 1].name = cleanName(name); refreshLobby(); },
  start: () => startGame(),
  // Bowl the current ball: { aimX, angle (deg), speed 0..1, spin −1..1, quality }
  bowl: (th = {}) => {
    const turn = app.turn;
    if (!turn) return false;
    if (turn.step === 'intro') goStep('aim');
    if (turn.step !== 'aim') return false;
    if (th.aimX !== undefined) turn.aimX = th.aimX;
    if (th.angle !== undefined) turn.angle = th.angle;
    startApproach();
    turn.approach = 1;
    onThrow({ speed: th.speed ?? 0.7, spin: th.spin ?? 0, quality: th.quality || 'ok', mode: 'keyboard' });
    return true;
  },
  step: () => app.turn?.step,
  board: () => app.game?.board(),
  setTimeScale: (k) => { app.timeScale = k; },
  phase: () => app.phase,
};

boot();
