// KRISHIV KART — desktop app (SPEC §12, §14.5–14.7, §15): bootstrap, the
// session state machine, split-screen races and the phone sync.
//
// Flow: lobby → (host) START → select (every phone at its own pace) → track
// (host: GP cup pick (Gelato / Krishiv Cup) / VS track + GO) → loading → race →
// results → standings → (GP: next race of the cup … podium) / (VS: track
// again) → lobby.
// The desktop is a display: every intent arrives as a phone `pad:menu`
// action { slot, action, ... } (host-only actions are enforced here: host =
// lowest connected slot). Keyboard mode (no phone connected) seats a keyboard
// player as P1 whose menu intents come from the desktop pickers (menus.js)
// with the very same vocabulary.
//
// Layout of this module:
//   1. constants + optional modules (race logic, worlds) + the roster
//   2. boot()               renderer, scene, audio, input, menus, phones, world, HUDs
//   3. catalog              characters / bodies / wheels / tracks / cups for phones + menus
//   4. players              slots, host, keyboard mode, reservations
//   5. actions              onMenu(slot, action, payload) — the single entry point
//   6. flow                 lobby / select / track / loading / results / standings / podium
//   7. world                ensureWorld (track switch), AttractCam, StartLights, BlobShadows
//   8. race setup           grid rules, CPU field, karts, split-screen views
//   9. race frame           input, AI takeover, substeps (+ track hazards), cameras, HUDs, audio, finish rules
//  10. race events          bus → HUD banners / sounds / phone rumble per player (items incl. §15.2)
//  11. podium scene         top-3 karts on a 3D podium + confetti
//  12. portraits            kart + driver renders for the player panels
//  13. phone sync           host:state (shared) + host:padState (per slot)
//  14. render + loop        one view or split-screen viewports
//  15. window.__game        debug / test handle

import * as THREE from 'three';
import { RACE, PHYS, GAME_TITLE, NET, ITEM_IDS, HIT, ITEM } from './config.js';
import { bus } from './bus.js';
import { clamp, lerp, damp, makeRng } from './utils.js';
// tracks.js through its namespace: CUPS (SPEC §15.3) is optional for older registries
import * as Tracks from './tracks.js';
import { Kart, resolveKartCollisions } from './kart.js';
import * as Cast from './characters.js';
import { loadCustomRacers } from './glb-racers.js';
import {
  KART_BODIES, WHEELS, getBody, getWheels, sanitizeLoadout, computeRatings, CPU_PRESETS, DEFAULT_CC,
  getEngineClass, slotInfo, pointsFor, DEFAULT_LOADOUT,
} from './parts.js';
import { KartView, enableKartShadowLod } from './kartview.js';
import { Effects } from './effects.js';
import { ChaseCamera, splitLayout } from './camera.js';
import { AudioEngine, SOUNDS, SONG_KINDS, FILE_SONGS } from './audio.js';
import * as AudioMod from './audio.js';      // ITEM_SFX (v4 item sounds), optional
import { Input, PadInput, isTypingTarget } from './input.js';
import { PhoneLink } from './net.js';
import { HUD, SharedHud } from './hud.js';
import { Menus, showFatal } from './menus.js';

const { TRACK_LIST, getTrack, trackInfo, DEFAULT_TRACK_ID, hasTrack } = Tracks;

const params = new URLSearchParams(location.search);
const FORCE_LOW = params.get('quality') === 'low';

const menusRoot = document.getElementById('menus');
const hudRoot = document.getElementById('hud');
const canvas = document.getElementById('game');

// =============================================================== 1. constants

const MODE_LABEL = { gp: 'Grand Prix', vs: 'VS Race' };
// Phone rumble patterns (ms on/off).
const VIBE = {
  hit: [80, 40, 80], itemGet: [30], lap: [40, 30, 40], finish: [100, 50, 100, 50, 200],
  countdown: [25], go: [90], bump: [20], join: [30, 40, 30],
  // SPEC §15.2 / §15.3: each new item / hazard has its own feel in the hand
  capoWarn: [180, 90, 180, 90, 180],          // siren: the Capo Crusher is coming for 1st
  capoHit: [320, 60, 140, 60, 320],
  espresso: [40, 30, 40, 30, 40, 30, 160],    // splat-splat-splat … splash
  accordion: [60, 30, 60],
  beer: [30, 20, 30, 20, 30, 20, 260],        // glug glug glug … WHOOSH
  beerEnd: [80],
  bomb: [140, 40, 90],
  crush: [260, 50, 160],
  fire: [70, 35, 70, 35, 70],
};
const RELEASE_AFTER_S = 20;        // a phone gone this long in the menus loses its slot (host:release)
const TAKEOVER_AFTER_S = 1.0;      // ≥ 2 humans: a silent phone's kart gets a CPU driver after this
const HANDBACK_AFTER_S = 0.35;     // … and gets it back once input flows again this long
const FINISH_CLOCK_S = RACE.finishClock || 30;
const ENGINE_LEVEL = { 1: 1, 2: 0.78, 3: 0.62, 4: 0.58 };   // engine loop level per view count
const SFX_HUMAN = { 1: 1, 2: 0.85, 3: 0.75, 4: 0.7 };        // one-shot level of a player's own sounds
// Track theme → its synth song. A theme with its own song in audio.js (SONG_KINDS)
// uses it; the others borrow the closest one.
const RACE_SONG = { bay: 'race', hilltown: 'hilltown', campus: 'race', beach: 'hilltown', castle: 'race' };
// Race soundtrack rotation: the recorded Claude Song (audio.js FILE_SONGS)
// alternates with each track's own theme, starting with the Claude Song.
let raceSongTurn = 0;
function themeSong(theme) {
  if (theme && theme !== 'menu' && (SONG_KINDS.includes(theme) || FILE_SONGS[theme])) return theme;
  const kind = RACE_SONG[theme] || 'race';
  return SONG_KINDS.includes(kind) || FILE_SONGS[kind] ? kind : 'race';
}
function nextRaceSong(tr) {
  const theme = themeSong(tr.theme);
  return raceSongTurn++ % 2 === 0 && FILE_SONGS.claude ? 'claude' : theme;
}
const PHONE_SYNC_HZ = NET.hostStateHz;
const FLASH_HOLD = 1.6;            // s: big banners (LAP / FINAL LAP) are not cut short by callouts
const RESULTS_FAILSAFE = RACE.resultsDelay + 90;   // results even if a race somehow never ends
// Title flyover. minClear = camera height above the road; bridgeClear over bridge zones.
const ATTRACT = { speed: 13, startS: -70, height: 21, heightVar: 7, lateral: 24, lookAhead: 42, rate: 1.4, fov: 56,
  minClear: 14, bridgeClear: 24, groundClear: 14 };
// item:use one-shots (toot sounds through kart:boost 'item', star through
// kart:starStart, the Beer Rocket through item:beerStart). Each entry lists
// audio.js sound names in order of preference: the first one that exists plays.
const ITEM_USE_SOUND = {
  banana: ['throw'], bouncer: ['bouncer'], rocket: ['rocket'], stink: ['stink'], zap: ['zap'],
  triple_banana: ['throw'], triple_bouncer: ['bouncer'], triple_rocket: ['rocket'],
  meatball_bomb: ['bombThrow', 'throw'], capo: ['capoLaunch', 'capo', 'rocket'],
  espresso: ['espresso', 'splat', 'throw'], accordion: ['accordion', 'squeeze', 'bump'],
};
// The user's item landed on a rival → a quick callout in the user's view.
const HIT_CALLOUT = {
  bouncer: 'BONK!', rocket: 'KABOOM!', banana: 'SLIPPED!', stink: 'PEE-YEW!', star: 'STAR SMASH!',
  triple_banana: 'SLIPPED!', triple_bouncer: 'BONK!', triple_rocket: 'KABOOM!',
  capo: 'CRUSHED!', meatball_bomb: 'MEATBALL BOOM!', bomb: 'MEATBALL BOOM!', accordion: 'OOM-PAH!',
  beer_rocket: 'CHEERS!', beer: 'CHEERS!', espresso: 'SPLASH!',
};
// Sound names per event, in order of preference (audio.js may not have them all).
const SND = {
  capoWarn: ['capoWarn', 'capoWarning', 'capoSiren', 'siren', 'finalLap'],
  capoHit: ['capoHit', 'capoBlast', 'explode'],
  espressoSplat: ['espressoSplat', 'splat', 'espresso', 'banana'],
  beerStart: ['beerStart', 'chug', 'glug', 'beer', 'boost'],
  beerEnd: ['beerEnd', 'beerPop', 'pop', 'boost'],
  bomb: ['bombExplode', 'bomb', 'explode'],
  crush: ['crush', 'hit'],
  fire: ['fire', 'flame', 'burn', 'spin'],
  // course ambience (Krishiv's Palace): a crusher hitting the road, a lava geyser erupting
  slam: ['crusherSlam', 'slam', 'wall'],
  geyser: ['geyser', 'lavaBurst', 'stink'],
  saved: ['blocked', 'bump'],
};
// audio.js ITEM_SFX: { use: { itemId: sound }, event: { 'item:…': sound } } (SPEC §15.2)
const ITEM_SFX = AudioMod.ITEM_SFX && typeof AudioMod.ITEM_SFX === 'object' ? AudioMod.ITEM_SFX : { use: {}, event: {} };
const _sndPick = new Map();
/** The first sound name of the list that audio.js knows (null: none). */
function snd(list) {
  const key = Array.isArray(list) ? list.join('|') : String(list);
  if (_sndPick.has(key)) return _sndPick.get(key);
  const names = Array.isArray(list) ? list : [list];
  const pick = names.find((n) => typeof SOUNDS[n] === 'function') || null;
  _sndPick.set(key, pick);
  return pick;
}
// Item numbers the app needs (config.js ITEM may carry them, SPEC §15.2 / research brief §B5).
const ITEMV = (key, def) => (ITEM && Number.isFinite(ITEM[key]) ? ITEM[key] : def);
// Beer Rocket camera: extra FOV while riding (after the chug), how fast it eases in / out.
const BEER_FOV_KICK = 8;            // on top of the chase camera's boost FOV (the ride is a boost too)
// During the ride the rider's chase camera rises and pulls back so the mug-rocket
// (which sits around the kart) is seen from above instead of filling the view.
const BEER_CAM = { height: 2.6, distance: 3.2, lookHeight: 0.5, lookAhead: 5 };
const BEER_FOV_RATE = 3.2;
// A Capo Crusher warning lasts until the hit / it is destroyed, or this long after the last warning.
const CAPO_WARN_HOLD = 10;

// --------------------------------------------------------------- optional modules

// items.js / ai.js / race.js are loaded with guarded dynamic imports: if one is
// missing or throws, menus and free driving keep working and the failing
// subsystem is switched off for the rest of that race (logged once).
const RaceMods = { ItemSystem: null, AIDriver: null, Race: null, createAIDrivers: null, buildWorld: null, errors: {},
  getItemHandler: null, createHazards: null, stepCourseHazards: null };

async function loadModules() {
  const specs = [['items', './items.js', 'ItemSystem'], ['ai', './ai.js', 'AIDriver'], ['race', './race.js', 'Race']];
  await Promise.all(specs.map(async ([key, path, name]) => {
    try {
      const mod = await import(path);
      if (typeof mod[name] !== 'function') throw new Error(`${path} does not export ${name}`);
      RaceMods[name] = mod[name];
      if (key === 'ai' && typeof mod.createAIDrivers === 'function') RaceMods.createAIDrivers = mod.createAIDrivers;
      if (key === 'items' && typeof mod.getItemHandler === 'function') RaceMods.getItemHandler = mod.getItemHandler;   // v5 plugins
    } catch (err) {
      RaceMods.errors[key] = String(err && err.message || err);
      console.warn(`[main] ${path} unavailable (${RaceMods.errors[key]}) — continuing without it`);
    }
  }));
  // hazards.js (SPEC §16.1): the shared hazard stepper (+ sets for kits that expose none)
  try {
    const mod = await import('./hazards.js');
    if (typeof mod.stepCourseHazards === 'function') RaceMods.stepCourseHazards = mod.stepCourseHazards;
    if (typeof mod.createHazards === 'function') RaceMods.createHazards = mod.createHazards;
  } catch (err) {
    RaceMods.errors.hazards = String(err && err.message || err);
    console.warn(`[main] ./hazards.js unavailable (${RaceMods.errors.hazards}) — world hazards use the v4 mapping`);
  }
  // worlds.js dispatches on track.theme; world.js alone still builds Breezy Bay
  for (const path of ['./worlds.js', './world.js']) {
    try {
      const mod = await import(path);
      if (typeof mod.buildWorld === 'function') { RaceMods.buildWorld = mod.buildWorld; break; }
    } catch (err) {
      console.warn(`[main] ${path} unavailable (${err && err.message})`);
    }
  }
}

// The roster: the 12 built-in racers + any registered custom racers.
function roster() {
  const all = typeof Cast.getAllCharacters === 'function' ? Cast.getAllCharacters() : Cast.CHARACTERS;
  return (all || []).filter((c) => c && c.id);
}
const isCustomDef = (def) => !!(def && def.custom);
function charById(id) {
  if (!id) return null;
  const list = roster();
  return list.find((c) => c.id === id) || null;
}
function weightClassOf(def) {
  if (def && def.weightClass) return def.weightClass;
  const w = def && def.ratings ? def.ratings.weight : 3;
  return w <= 2 ? 'light' : w >= 4 ? 'heavy' : 'medium';
}
const defaultCharId = () => Cast.DEFAULT_CHARACTER_ID || (roster()[0] || {}).id || null;

// =============================================================== 2. boot

let renderer, scene, camera, menuChase, effects, audio, input, menus, phone;
let world = null, worldKey = '', track = null;
let attract, startLights, blobs, portraits, sharedHud;
let podium = null;

// The session (SPEC §14.5): mode / class / items, players, points, the race.
const S = {
  screen: 'boot',           // 'boot'|'lobby'|'select'|'track'|'loading'|'race'|'results'|'standings'|'podium'
  paused: false,
  pausedBy: null,           // slot that paused (null: the desktop)
  mode: 'gp',
  cc: DEFAULT_CC,
  items: true,
  players: new Map(),       // slot → player (see newPlayer)
  host: null,
  kb: false,                // keyboard mode: P1 is the desktop keyboard
  raceNo: 0,                // races run in this set (GP: 1..cup length)
  trackId: DEFAULT_TRACK_ID,
  trackPick: DEFAULT_TRACK_ID,   // VS: the host's current pick ('random' allowed)
  cupId: null,              // GP: the host's cup (null = the first cup, Gelato); locked once race 1 starts
  seed: 1,                  // per set: CPU field + presets
  pinnedSeed: null,         // tests: a fixed seed for every set (null = random)
  cpus: null,               // [{ key, def, loadout }] for this set
  entries: new Map(),       // standings key → { key, name, cssColor, points, slot, lastPlace }
  lastOrder: null,          // finishing order keys of the last race (grid of the next one)
  results: null,
  standings: null,
  podium: null,
  timeScale: 1,
};

function setBootText(text) {
  const t = document.getElementById('tk-boot-text');
  if (t) t.textContent = text;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function boot() {
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    showFatal(menusRoot, 'WebGL is not available',
      `${GAME_TITLE} needs a browser with WebGL enabled (Chrome, Edge, Firefox or Safari).\nTry enabling hardware acceleration and reload.`);
    throw err;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  // three r186: PCFShadowMap is the soft filtered mode that honours light.shadow.radius.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  enableKartShadowLod(renderer);     // karts cast their shadow with the low-detail model (§2 budget)

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(ATTRACT.fov, window.innerWidth / window.innerHeight, 0.1, 2000);
  scene.add(camera);
  menuChase = new ChaseCamera(camera);

  audio = new AudioEngine();
  menus = new Menus(menusRoot, { audio, onAction: onDesktopAction });
  menus.setMuted(audio.muted);
  audio.startMusic('menu');          // remembered until the first gesture unlocks audio
  const unlock = () => { audio.unlock(); };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  window.addEventListener('touchstart', unlock, { capture: true, passive: true });

  input = new Input();
  phone = new PhoneLink();
  wirePhone();
  phone.connect().then((info) => {
    menus.setPhone({ status: 'online', ...info });
    syncAll();
  }).catch((err) => {
    console.warn('[main] phone link unavailable — keyboard / gamepad only:', err.message);
    menus.setPhone({ status: 'offline' });
  });

  setBootText('Fueling up the racers…');
  await loadModules();
  if (!RaceMods.buildWorld) throw new Error('No world builder available (worlds.js / world.js failed to load)');

  // ---- world for the lobby backdrop (let the boot splash paint first: the build is synchronous)
  setBootText(`Paving ${trackInfo(DEFAULT_TRACK_ID).name}…`);
  await nextFrame();
  effects = new Effects(scene);
  sharedHud = new SharedHud(hudRoot);
  attract = new AttractCam(camera);
  blobs = new BlobShadows(scene);
  portraits = new PortraitStudio();
  ensureWorld(DEFAULT_TRACK_ID, FORCE_LOW ? 'low' : 'high');

  // custom .glb racers (SPEC §14.9): glb-racers.js loads + registers them
  setBootText('Looking for custom racers…');
  const custom = await loadCustomRacers({ takenIds: roster().map((c) => c.id) });
  if (custom.length) console.info(`[main] ${custom.length} custom racer(s) loaded`);
  rebuildCatalog();

  // ---- global listeners
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKeyDown);
  // a hidden tab stops rendering: pause the race (phones see the paused screen)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.screen === 'race' && !S.paused) pause(null);
  });
  window.addEventListener('blur', () => {
    if (S.screen === 'race' && !S.paused && S.kb) pause(null);
  });

  try { renderer.compile(scene, camera); } catch { /* optional */ }
  goLobby(true);
  requestAnimationFrame(loop);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  applyPixelRatio();
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  applyFraming();
  if (R) layoutViews();
}

function applyPixelRatio() {
  const n = R ? R.views.length : 1;
  const pr = n >= 3 ? 1 : Math.min(2, window.devicePixelRatio || 1);
  if (renderer.getPixelRatio() !== pr) {
    renderer.setPixelRatio(pr);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
}

// App-level keys Input does not map: M = mute, H = help. Esc / P (pause) come
// through Input; on the lobby with no phone, Enter starts keyboard mode.
function onKeyDown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
  if (e.code === 'KeyM') onDesktopAction('mute', {});
  else if (e.code === 'KeyH' && S.screen !== 'boot') onDesktopAction('help', {});
}

function setFov(fov) {
  if (Math.abs(camera.fov - fov) > 1e-3) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

// Results / standings: the orbiting kart sits in the left part of the screen,
// beside the table (horizontal view offset as a fraction of the width).
let framing = 0;
function setFraming(x) {
  if (x === framing) return;
  framing = x;
  applyFraming();
}
function applyFraming() {
  const w = window.innerWidth, h = window.innerHeight;
  if (Math.abs(framing) < 1e-4) camera.clearViewOffset();
  else camera.setViewOffset(w, h, framing * w, 0, w, h);
}

// =============================================================== 3. catalog

// host:state catalogs (SPEC §14.7), rebuilt only when the roster changes.
const CAT = { characters: [], bodies: [], wheels: [], tracks: [], cups: [], cupsShared: [] };

// ---- cups (SPEC §15.3): tracks.js CUPS (Gelato Cup 4 races, Krishiv Cup 5),
// or the single old CUP. Track ids a cup lists that this build does not know
// are skipped, so a cup never points at a missing track.
function buildCups() {
  const raw = Array.isArray(Tracks.CUPS) && Tracks.CUPS.length ? Tracks.CUPS : [Tracks.CUP];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c.id !== 'string' || out.some((x) => x.id === c.id)) continue;
    const tracks = (Array.isArray(c.tracks) ? c.tracks : [])
      .map((t) => (typeof t === 'string' ? t : t && t.id)).filter((id) => hasTrack(id));
    if (tracks.length) out.push({ id: c.id, name: c.name || c.id, tracks });
  }
  if (!out.length) out.push({ id: 'gelato', name: 'Gelato Cup', tracks: TRACK_LIST.map((t) => t.id) });
  return out;
}
function refreshCups() {
  CAT.cups = buildCups();
  CAT.cupsShared = CAT.cups.map((c) => ({ id: c.id, name: c.name, tracks: c.tracks.map((id) => ({ id, name: trackInfo(id).name })) }));
}
refreshCups();

/** The Grand Prix cup of this set: the host's pick, else the first cup. */
function curCup() {
  return CAT.cups.find((c) => c.id === S.cupId) || CAT.cups[0];
}

function rebuildCatalog() {
  CAT.characters = roster().map((c) => ({
    id: c.id,
    name: c.name,
    shortName: c.shortName || c.name,
    weightClass: weightClassOf(c),
    cssColor: c.cssColor || '#8890b5',
    accent: typeof c.accent === 'number' ? `#${c.accent.toString(16).padStart(6, '0')}` : c.accent || c.cssColor || '#8890b5',
    ratings: { ...c.ratings },
    img: isCustomDef(c) ? null : `img/racers/${c.id}.png`,
    custom: isCustomDef(c),
    catchphrase: c.catchphrase || '',
    tagline: c.tagline || '',
    group: c.group,
    lead: !!c.lead,
  }));
  CAT.bodies = KART_BODIES.map((b) => ({ id: b.id, label: b.label, desc: b.desc, mods: { ...b.mods } }));
  CAT.wheels = WHEELS.map((w) => ({ id: w.id, label: w.label, desc: w.desc, mods: { ...w.mods }, offroad: w.offroad }));
  CAT.tracks = TRACK_LIST.map((t) => ({ id: t.id, name: t.def.name || t.id, theme: t.def.theme }));
  refreshCups();
  menus.setCatalog({
    characters: CAT.characters, bodies: CAT.bodies, wheels: CAT.wheels,
    tracks: TRACK_LIST.map((t) => ({ id: t.id, name: t.def.name || t.id, track: getTrack(t.id) })),
  });
  syncAll();
}

// =============================================================== 4. players

/** A player in a slot (phone or keyboard). Choices survive between sets. */
function newPlayer(slot, padId = null, kb = false) {
  return {
    slot, padId, kb, connected: true,
    char: null, body: DEFAULT_LOADOUT.body, wheels: DEFAULT_LOADOUT.wheels, assist: true,
    step: 'char', ready: false,
    goneAt: 0,               // performance.now() when the phone dropped (menus: released after 20 s)
    key: `P${slot}`,         // standings key
  };
}

const playersSorted = () => [...S.players.values()].sort((a, b) => a.slot - b.slot);
const connectedPlayers = () => playersSorted().filter((p) => p.connected);
const slotLabel = (slot) => slotInfo(slot).label;

function computeHost() {
  const c = connectedPlayers();
  const h = c.length ? c[0].slot : null;
  if (h !== S.host) S.host = h;
  return h;
}

// All connected players finished their picks (and there is at least one).
function allReady() {
  const c = connectedPlayers();
  return c.length > 0 && c.every((p) => p.ready && p.char);
}

function onPhoneJoin({ slot, padId, rejoin }) {
  if (S.kb) endKeyboardMode('A phone joined — it takes over as P1');
  let p = S.players.get(slot);
  if (p && p.padId !== padId && !rejoin) {
    // a new phone in a freed slot: the old player's standings entry is kept
    retireEntry(p);
    p = null;
  }
  const fresh = !p;
  if (!p) { p = newPlayer(slot, padId); S.players.set(slot, p); }
  p.padId = padId;
  p.connected = true;
  p.goneAt = 0;
  computeHost();
  if (fresh) {
    audio.play('join');
    menus.toast(`${slotLabel(slot)} joined!`, { icon: '📱', tone: 'good', duration: 2.2 });
    phone.sendEvent('vibrate', { pattern: VIBE.join }, slot);
    // a new player mid-set picks a racer before the next race
    if (S.screen === 'track') goSelect();
  } else if (R) {
    menus.toast(`${slotLabel(slot)} is back`, { icon: '📱', tone: 'good', duration: 1.6 });
  }
  syncAll();
}

function onPhoneLeave({ slot, reason }) {
  const p = S.players.get(slot);
  if (!p || p.kb) return;
  if (reason === 'expired') {
    // the server freed the slot (phone gone for good)
    removePlayer(p);
    return;
  }
  p.connected = false;
  p.goneAt = performance.now();
  computeHost();
  updatePauseOverlay();
  audio.play('leave');
  if (S.screen !== 'race') menus.toast(`${slotLabel(slot)} disconnected`, { icon: '📵', tone: 'warn' });
  // solo race: pause; with more humans a CPU takes the wheel (raceFrame)
  if (S.screen === 'race' && !S.paused && R && R.humans.length <= 1) pause(slot);
  afterPlayersChanged();
}

function removePlayer(p) {
  retireEntry(p);
  S.players.delete(p.slot);
  computeHost();
  afterPlayersChanged();
}

// Keep a departed player's points in the standings under a new key.
function retireEntry(p) {
  const e = S.entries.get(p.key);
  if (!e) return;
  S.entries.delete(p.key);
  e.key = `gone:${p.key}:${performance.now() | 0}`;
  e.slot = null;
  S.entries.set(e.key, e);
  if (S.lastOrder) S.lastOrder = S.lastOrder.map((k) => (k === p.key ? e.key : k));
}

// Somebody left / un-readied: the select / track screens follow.
function afterPlayersChanged() {
  if (!S.players.size && ['select', 'track', 'results', 'standings', 'podium'].includes(S.screen)) { goLobby(); return; }
  if (S.screen === 'select' && allReady()) goTrack();
  else if (S.screen === 'track' && !allReady()) goSelect();
  else if ((S.screen === 'select' || S.screen === 'track') && !connectedPlayers().length) goLobby();
  syncAll();
}

// Phones gone for RELEASE_AFTER_S in the menus lose their slot.
function releaseStalePlayers() {
  if (S.screen === 'race' || S.screen === 'loading') return;
  const now = performance.now();
  for (const p of [...S.players.values()]) {
    if (p.kb || p.connected || !p.goneAt || now - p.goneAt < RELEASE_AFTER_S * 1000) continue;
    phone.release(p.slot);
    removePlayer(p);
  }
}

// ---- keyboard mode (SPEC §14.6): solo / testing with no phone connected

function startKeyboardMode() {
  if (S.kb || phone.connected || connectedPlayers().length) return false;
  // phones that are gone (only reserved) give their slots up to the keyboard
  for (const p of [...S.players.values()]) { phone.release(p.slot); removePlayer(p); }
  S.kb = true;
  const p = newPlayer(1, null, true);
  S.players.set(1, p);
  computeHost();
  audio.play('menuSelect');
  menus.toast('Keyboard mode — you are P1', { icon: '⌨️', tone: 'good', duration: 2 });
  syncAll();
  return true;
}

function endKeyboardMode(reason = '') {
  if (!S.kb) return;
  S.kb = false;
  const p = [...S.players.values()].find((x) => x.kb);
  if (p) { S.players.delete(p.slot); S.entries.delete(p.key); }
  computeHost();
  if (reason) menus.toast(reason, { icon: '📱', tone: 'good', duration: 2.6 });
  if (S.screen !== 'lobby') goLobby();
  syncAll();
}

// =============================================================== 5. actions

const HOST_ONLY = new Set(['mode', 'cc', 'items', 'start', 'track', 'cup', 'go', 'next', 'quit', 'restart']);

/** Desktop menus (keyboard mode pickers, corner buttons). */
function onDesktopAction(name, payload = {}) {
  switch (name) {
    case 'mute': {
      const muted = audio.toggleMute();
      menus.setMuted(muted);
      menus.toast(muted ? 'Sound off' : 'Sound on', { icon: muted ? '🔇' : '🔊', duration: 1.4 });
      return;
    }
    case 'help': {
      const open = payload && payload.close ? false : !menus.helpOpen;
      if (open === menus.helpOpen || (open && S.screen === 'race' && !S.paused)) return;
      menus.toggleHelp(open);
      audio.play(open ? 'menuSelect' : 'menuBack', { volume: 0.7 });
      return;
    }
    case 'kbJoin': if (S.screen === 'lobby') startKeyboardMode(); return;
    case 'kbLeave': if (S.screen === 'lobby') endKeyboardMode(); return;
    default: {
      const kbp = [...S.players.values()].find((p) => p.kb);
      if (kbp) onMenu(kbp.slot, name, payload, 'kb');
      else if (!connectedPlayers().length) desktopHostAction(name);
    }
  }
}

/**
 * Every menu intent: phone `pad:menu` { slot, action, ... } and keyboard mode.
 * Host-only actions from anyone else are ignored.
 */
function onMenu(slot, name, payload = {}, source = 'phone') {
  const p = S.players.get(slot);
  if (!p) return;
  if (HOST_ONLY.has(name) && slot !== computeHost()) return;
  const sc = S.screen;
  switch (name) {
    // ---- lobby settings (host)
    case 'mode':
      if (sc === 'lobby' && (payload.value === 'gp' || payload.value === 'vs') && payload.value !== S.mode) { S.mode = payload.value; audio.play('menuMove'); }
      break;
    case 'cc': {
      const v = Number(payload.value);
      if (sc === 'lobby' && [50, 100, 150].includes(v) && v !== S.cc) { S.cc = v; audio.play('menuMove'); }
      break;
    }
    case 'items':
      if (sc === 'lobby' && typeof payload.value === 'boolean' && payload.value !== S.items) { S.items = payload.value; audio.play('menuMove'); }
      break;
    case 'start':
      if (sc === 'lobby' && connectedPlayers().length) { audio.play('menuSelect'); startSet(); }
      break;

    // ---- personal picks (everyone): pick + advance (char → body → wheels → ready)
    case 'char': case 'body': case 'wheels': {
      if (sc !== 'select' || p.ready) break;
      const id = payload.id;
      const ok = name === 'char' ? !!charById(id) : name === 'body' ? KART_BODIES.some((b) => b.id === id) : WHEELS.some((w) => w.id === id);
      if (!ok) break;
      p[name] = id;
      if (p.step === name) p.step = name === 'char' ? 'body' : name === 'body' ? 'wheels' : 'ready';
      audio.play('menuMove');
      portraits.want(p);
      break;
    }
    case 'assist':
      if (typeof payload.value === 'boolean') {
        p.assist = payload.value;
        const h = R && R.humans.find((x) => x.slot === slot);
        if (h) h.kart.steerAssist = p.assist;
        audio.play('menuMove', { volume: 0.6 });
      }
      break;
    case 'ready':
      if (sc !== 'select' && sc !== 'track') break;
      if (payload.value === true && sc === 'select' && p.char && (p.step === 'ready' || p.step === 'done')) {
        p.ready = true; p.step = 'done';
        audio.play('menuSelect');
        if (allReady()) goTrack();
      } else if (payload.value === false && p.ready) {
        p.ready = false; p.step = 'ready';
        audio.play('menuBack');
        if (sc === 'track') goSelect();
      }
      break;
    case 'back':
      if (sc === 'select') {
        if (p.ready) { p.ready = false; p.step = 'ready'; }
        else if (p.step === 'ready') p.step = 'wheels';
        else if (p.step === 'wheels') p.step = 'body';
        else if (p.step === 'body') p.step = 'char';
        else if (slot === computeHost()) { audio.play('menuBack'); goLobby(); break; }
        audio.play('menuBack');
      } else if (sc === 'track' && slot === computeHost()) {
        p.ready = false; p.step = 'ready';
        audio.play('menuBack');
        goSelect();
      }
      break;

    // ---- track (host)
    case 'track':
      if (sc === 'track' && S.mode === 'vs' && (payload.value === 'random' || hasTrack(payload.value)) && payload.value !== S.trackPick) {
        S.trackPick = payload.value;
        audio.play('menuMove');
      }
      break;
    case 'cup': {
      // GP: the host picks the cup on the track screen (SPEC §15.3), until race 1 starts
      const id = typeof payload.id === 'string' ? payload.id : payload.value;
      if ((sc === 'track' || sc === 'lobby') && S.mode === 'gp' && S.raceNo === 0 && CAT.cups.some((c) => c.id === id) && id !== curCup().id) {
        S.cupId = id;
        audio.play('menuMove');
      }
      break;
    }
    case 'go':
      if (sc === 'track' && allReady()) { audio.play('menuSelect'); startNextRace(); }
      break;

    // ---- after the race (host)
    case 'next':
      if (sc === 'results') { audio.play('menuSelect'); goStandings(); }
      else if (sc === 'standings') { audio.play('menuSelect'); afterStandings(); }
      else if (sc === 'podium') { audio.play('menuBack'); goLobby(); }
      break;
    case 'quit':
      if (sc === 'race' && S.paused) { audio.play('menuBack'); goLobby(); }
      else if (['results', 'standings', 'podium', 'track', 'select'].includes(sc)) { audio.play('menuBack'); goLobby(); }
      break;
    case 'restart':
      if (sc === 'race' && S.paused && R) { audio.play('menuSelect'); restartRace(); }
      break;

    // ---- pause (everyone)
    case 'pause':
      if (sc !== 'race' || S.paused) break;
      // a hidden phone in a multiplayer race: a CPU takes over instead (raceFrame)
      if ((payload.reason === 'hidden' || payload.reason === 'signal') && R && R.humans.length >= 2) break;
      pause(slot);
      break;
    case 'resume':
      if (sc === 'race' && S.paused) resume(slot);
      break;
    default:
      if (source === 'phone') console.warn('[main] unknown phone menu action', name);
      return;
  }
  syncAll();
}

// No phone connected at all (they all dropped): the desktop keyboard may
// resume / restart / quit so the game never gets stuck.
function desktopHostAction(name) {
  const sc = S.screen;
  if (name === 'resume' && S.paused) resume(null);
  else if (name === 'restart' && sc === 'race' && S.paused) restartRace();
  else if (name === 'quit' && (S.paused || ['results', 'standings', 'podium', 'track', 'select'].includes(sc))) goLobby();
  else if (name === 'next' && ['results', 'standings', 'podium'].includes(sc)) goLobby();
}

function pause(slot) {
  if (S.screen !== 'race' || !R || S.paused) return;
  S.paused = true;
  S.pausedBy = slot;
  audio.setEngineActive(false);
  audio.play('menuBack', { volume: 0.7 });
  input.releaseAll();
  updatePauseOverlay();
  syncAll();
}

function resume() {
  if (!S.paused || !R) return;
  S.paused = false;
  S.pausedBy = null;
  // the Enter that pressed "Resume" must not also skip the intro this frame
  R.inputGuard = R.frames + 1;
  audio.setEngineActive(true);
  audio.play('menuSelect', { volume: 0.7 });
  updatePauseOverlay();
  syncAll();
}

function updatePauseOverlay() {
  if (!S.paused) { menus.setPaused(null); return; }
  const by = S.pausedBy ? slotLabel(S.pausedBy) : '';
  const host = computeHost();
  // keyboard mode (or no phone left): the pause menu gets desktop buttons
  menus.setPaused({ by, color: S.pausedBy ? slotInfo(S.pausedBy).css : '', kb: S.kb || !host, hostLabel: host ? slotLabel(host) : '' });
}

// =============================================================== 6. flow

function setScreen(screen) {
  S.screen = screen;
  setFraming(screen === 'results' || screen === 'standings' ? 0.2 : 0);
  menus.toggleHelp(false);
  menus.show(screen);
  updatePauseOverlay();
  syncAll();
}

/** Back to the lobby: the set ends (points cleared), picks are kept. */
function goLobby(first = false) {
  teardownRace();
  disposePodium();
  S.paused = false;
  S.pausedBy = null;
  S.raceNo = 0;
  S.results = S.standings = S.podium = null;
  S.entries.clear();
  S.lastOrder = null;
  S.cpus = null;
  for (const p of S.players.values()) { p.ready = false; p.step = 'char'; }
  menuChase.setTarget(null);
  menuChase.mode = 'chase';
  attract.reset();
  audio.startMusic('menu');
  if (!first) menus.dip();
  setScreen('lobby');
}

/** Host START: a new set (GP cup or VS session). */
function startSet() {
  S.raceNo = 0;
  S.entries.clear();
  S.lastOrder = null;
  S.cpus = null;
  S.seed = S.pinnedSeed !== null ? S.pinnedSeed : (Math.random() * 0x7fffffff) | 0;
  S.trackPick = S.trackPick && (S.trackPick === 'random' || hasTrack(S.trackPick)) ? S.trackPick : DEFAULT_TRACK_ID;
  goSelect();
}

function goSelect() {
  for (const p of S.players.values()) {
    if (!p.ready) p.step = p.step === 'done' ? 'ready' : p.step || 'char';
    if (!p.char) p.step = 'char';
    portraits.want(p);
  }
  setScreen('select');
  if (allReady()) goTrack();
}

function goTrack() {
  if (!allReady()) { goSelect(); return; }
  setScreen('track');
}

// GP: the cup's next track; VS: the host's pick (Random resolved now: any
// track, never the one just raced when there is a choice).
function nextTrackId() {
  if (S.mode === 'gp') { const c = curCup(); return c.tracks[Math.min(S.raceNo, c.tracks.length - 1)]; }
  if (S.trackPick === 'random') {
    let ids = TRACK_LIST.map((t) => t.id);
    if (S.raceNo > 0 && ids.length > 1) ids = ids.filter((id) => id !== S.trackId);
    return ids[Math.floor(Math.random() * ids.length)];
  }
  return hasTrack(S.trackPick) ? S.trackPick : DEFAULT_TRACK_ID;
}

/** loading → (world for the track) → race. */
async function startNextRace(setup = null) {
  const id = setup ? setup.trackId : nextTrackId();
  if (!setup) S.raceNo++;
  S.trackId = id;
  S.results = null;
  S.paused = false;
  S.pausedBy = null;
  teardownRace();
  disposePodium();
  audio.stopMusic(0.4);
  menus.dip();
  setScreen('loading');
  // let the loading card paint before the synchronous world build
  await nextFrame();
  await nextFrame();
  if (S.screen !== 'loading') return;            // quit meanwhile
  const humans = setup ? setup.humans.length : connectedPlayers().filter((p) => p.char).length;
  const quality = FORCE_LOW || humans >= 2 ? 'low' : 'high';
  try {
    ensureWorld(id, quality);
    buildRace(setup || makeSetup(id));
  } catch (err) {
    console.error('[main] race setup failed', err);
    menus.toast('Could not start the race', { icon: '⚠️', tone: 'warn' });
    goLobby();
    return;
  }
  setScreen('race');
}

function restartRace() {
  if (!R) return;
  const setup = R.setup;
  startNextRace(setup);
}

function goResults() {
  const r = R;
  if (!r || S.screen === 'results') return;
  let res = null;
  if (r.race) { try { res = r.race.getResults(true); } catch (err) { console.error('[main] getResults failed', err); } }
  if (!Array.isArray(res) || !res.length) {
    res = r.karts.slice().sort((a, b) => (a.place || 99) - (b.place || 99))
      .map((k, i) => ({ kart: k, place: k.place || i + 1, time: k.finishTime, finished: !!k.finished }));
  }
  // points for every racer (CPUs too), standings updated now
  const n = r.karts.length;
  const order = [];
  S.results = res.map((x, i) => {
    const place = x.place || i + 1;
    const ent = r.entryByKart.get(x.kart);
    const pts = pointsFor(place, n);
    if (ent) {
      const e = S.entries.get(ent.key) || { key: ent.key, name: ent.name, cssColor: ent.cssColor, points: 0, slot: ent.slot, lastPlace: 99, gained: 0 };
      e.name = ent.name; e.cssColor = ent.cssColor; e.slot = ent.slot;
      e.points += pts;
      e.gained = pts;
      e.lastPlace = place;
      S.entries.set(ent.key, e);
      order.push(ent.key);
    }
    return { place, name: ent ? ent.name : x.kart.name, cssColor: ent ? ent.cssColor : x.kart.cssColor, time: Number.isFinite(x.time) ? x.time : null,
      points: pts, slot: ent ? ent.slot : null, finished: x.finished !== false };
  });
  // entries that did not race this time (left mid-set) gain nothing
  for (const e of S.entries.values()) if (!order.includes(e.key)) e.gained = 0;
  S.lastOrder = order;
  S.standings = standingsRows();
  // the race keeps running behind the results (CPU drivers, orbit camera) but goes quiet
  for (const h of r.humans) if (!h.ai) takeOver(h, true);
  const best = r.humans.slice().sort((a, b) => (a.kart.place || 99) - (b.kart.place || 99))[0];
  menuChase.setTarget(best ? best.kart : r.karts[0]);
  menuChase.snap();
  menuChase.startOrbit();
  for (const v of r.views) v.hud.hide();
  sharedHud.hide();
  audio.setEngineActive(false);
  audio.startMusic('menu');
  setScreen('results');
}

// Standings: points desc; ties → better finish in the last race.
function standingsRows() {
  const list = [...S.entries.values()].sort((a, b) => (b.points - a.points) || (a.lastPlace - b.lastPlace));
  return list.map((e, i) => ({ place: i + 1, name: e.name, cssColor: e.cssColor, points: e.points, slot: e.slot, gained: e.gained || 0 }));
}

function goStandings() {
  S.standings = standingsRows();
  setScreen('standings');
}

function afterStandings() {
  if (S.mode === 'gp' && S.raceNo >= curCup().tracks.length) { goPodium(); return; }
  // a late joiner (or a fresh pick) first goes through select
  if (!allReady()) { goSelect(); return; }
  if (S.mode === 'gp') startNextRace();
  else goTrack();
}

function goPodium() {
  const top = (S.standings || standingsRows()).slice(0, 3);
  S.podium = top.map((r) => ({ place: r.place, name: r.name, cssColor: r.cssColor, points: r.points, slot: r.slot }));
  // the podium karts: who they were in the last race
  const lastKarts = R ? R.entryByKart : null;
  const entries = top.map((row) => {
    let pick = null;
    if (lastKarts) for (const [k, ent] of lastKarts) if (ent.name === row.name && ent.slot === row.slot) { pick = { def: k.character, loadout: k.loadout }; break; }
    return pick;
  });
  teardownRace();
  podium = new Podium(scene, track, entries);
  audio.startMusic('menu');
  audio.playJingle('finish');
  menus.dip();
  setScreen('podium');
}

// =============================================================== 7. world

/**
 * The scenery for a track at a quality ('high' 1P / 'low' split-screen).
 * A different track or quality disposes the old world first; nothing heavy is
 * cached across tracks (Track instances are cheap math, cached by tracks.js).
 */
function ensureWorld(trackId, quality) {
  const key = `${trackId}|${quality}`;
  if (world && worldKey === key) return world;
  if (world) {
    try { world.dispose(); } catch (err) { console.error('[main] world.dispose failed', err); }
    world = null;
  }
  if (startLights) { startLights.dispose(); startLights = null; }
  track = getTrack(trackId);
  world = RaceMods.buildWorld(scene, track, { renderer, quality });
  worldKey = key;
  blobs.setEnabled(quality === 'low');
  startLights = new StartLights(scene, track);
  attract.setWorld(track, world);
  sharedHud.setTrack(track);
  return world;
}

// Title / lobby flyover: glides along the course high above the road, swinging
// from side to side, clear of terrain, bridges and the world's tall landmarks.
class AttractCam {
  constructor(cam) {
    this.cam = cam;
    this.track = null;
    this.world = null;
    this.s = 0;
    this.t = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._l = new THREE.Vector3();
    this.minClear = null;
  }

  setWorld(track, world) {
    this.track = track;
    this.world = world;
    this.minClear = this._clearanceProfile();
    this.reset();
  }

  // Per-sample minimum height above the road, raised around bridges and
  // blurred so the camera eases up and down instead of popping.
  _clearanceProfile() {
    const tr = this.track, N = tr.N, sp = tr.spacing;
    const raw = new Float32Array(N).fill(ATTRACT.minClear);
    for (const z of tr.zones || []) {
      if (z.type !== 'bridge' && z.type !== 'tunnel') continue;
      for (let i = 0; i < N; i++) {
        const s = i * sp;
        const inside = tr.deltaS(z.s0 - 12, s) >= 0 && tr.deltaS(s, z.s1 + 12) >= 0;
        if (inside) raw[i] = Math.max(raw[i], ATTRACT.bridgeClear);
      }
    }
    const out = new Float32Array(N), R2 = Math.round(30 / sp);
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let k = -R2; k <= R2; k++) sum += raw[(i + k + N) % N];
      out[i] = Math.max(ATTRACT.minClear, sum / (2 * R2 + 1), raw[i] > ATTRACT.minClear ? ATTRACT.bridgeClear * 0.98 : 0);
    }
    return out;
  }

  reset() {
    if (!this.track) return;
    this.s = this.track.wrapS(ATTRACT.startS);
    this.t = 0;
    this._target(this._p, this._l);
    this.pos.copy(this._p);
    this.look.copy(this._l);
    this._apply();
  }

  _target(outPos, outLook) {
    const tr = this.track, t = this.t;
    const lat = Math.sin(t * 0.083) * ATTRACT.lateral;
    tr.pointAt(this.s, lat, outPos);
    const road = outPos.y;
    const clear = this.minClear[Math.floor(this.s / tr.spacing) % tr.N] || ATTRACT.minClear;
    let y = road + Math.max(clear, ATTRACT.height + Math.sin(t * 0.121 + 1.1) * ATTRACT.heightVar);
    const w = this.world;
    const ground = w && w.getGroundHeight ? w.getGroundHeight(outPos.x, outPos.z) : -Infinity;
    if (Number.isFinite(ground)) y = Math.max(y, ground + ATTRACT.groundClear);
    // tall landmarks (lighthouse, bell tower …): rise over them
    const lms = (w && w.landmarks) || [];
    for (let i = 0; i < lms.length; i++) {
      const lm = lms[i];
      const d = Math.hypot(outPos.x - lm.x, outPos.z - lm.z) - (lm.r || 6);
      if (d < 40) y = Math.max(y, lerp((lm.h || 30) + 14, y, clamp(d / 40, 0, 1)));
    }
    outPos.y = y;
    tr.pointAt(this.s + ATTRACT.lookAhead, -lat * 0.2, outLook);
    outLook.y += 1.5;
  }

  update(dt) {
    if (!this.track) return;
    this.t += dt;
    this.s = this.track.wrapS(this.s + dt * ATTRACT.speed);
    this._target(this._p, this._l);
    const k = 1 - Math.exp(-ATTRACT.rate * dt);
    this.pos.lerp(this._p, k);
    this.look.lerp(this._l, k * 1.4);
    this._apply();
  }

  _apply() {
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
    setFov(ATTRACT.fov);
    this.focus.copy(this.look);
  }
}

// The start gantry's five lights (world kit: lenses at lateral k·1.6 m, 9.7 m
// up, just before the line): dark during the intro, filling red on "3" / "2" /
// "1", all green at GO. One instanced draw call.
const LIGHT_RED_COUNT = { 3: 2, 2: 4, 1: 5 };
const LIGHT_COLOR = { off: new THREE.Color(0x3a1418), red: new THREE.Color(0xff2a1a), green: new THREE.Color(0x3dff6a) };

class StartLights {
  constructor(scene, track) {
    const f = track.frameAt(0);
    this.scene = scene;
    this.geo = new THREE.CylinderGeometry(0.36, 0.36, 0.04, 16);
    this.mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, 5);
    this.mesh.name = 'StartLights';
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, f.yaw, 0, 'YXZ'));
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    for (let k = 0; k < 5; k++) {
      const lat = (k - 2) * 1.6, along = -0.65;
      p.set(f.x + f.right.x * lat + f.tangent.x * along, f.y + 9.7, f.z + f.right.z * lat + f.tangent.z * along);
      this.mesh.setMatrixAt(k, m4.compose(p, q, s));
      this.mesh.setColorAt(k, LIGHT_COLOR.off);
    }
    this.mesh.computeBoundingSphere();
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** reds = lenses lit red (0..5); green = all green (GO). */
  set(reds, green = false) {
    for (let k = 0; k < 5; k++) this.mesh.setColorAt(k, green ? LIGHT_COLOR.green : k < reds ? LIGHT_COLOR.red : LIGHT_COLOR.off);
    this.mesh.instanceColor.needsUpdate = true;
    this.mesh.visible = true;
  }

  hide() { this.mesh.visible = false; }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}

// Soft round shadows under every kart when the world has no shadow map
// (split-screen quality 'low'): one instanced draw call, on the road surface.
const BLOB_MAX = 12;
const _bm = new THREE.Matrix4(), _bq = new THREE.Quaternion(), _bp = new THREE.Vector3(), _bs = new THREE.Vector3();
const _bEuler = new THREE.Euler(0, 0, 0, 'YXZ');

class BlobShadows {
  constructor(scene) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    grad.addColorStop(0, 'rgba(0,0,0,0.62)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.38)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.tex = new THREE.CanvasTexture(cv);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.geo = new THREE.PlaneGeometry(1, 1);
    this.geo.rotateX(-Math.PI / 2);
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, BLOB_MAX);
    this.mesh.name = 'BlobShadows';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.enabled = false;
  }

  setEnabled(on) { this.enabled = !!on; if (!on) this.mesh.count = 0; }

  update(karts) {
    if (!this.enabled || !karts) { this.mesh.count = 0; return; }
    const n = Math.min(BLOB_MAX, karts.length);
    for (let i = 0; i < n; i++) {
      const k = karts[i];
      const road = k.proj && Number.isFinite(k.proj.height) ? k.proj.height : k.position.y;
      const air = clamp(k.position.y - road, 0, 6);
      const sc = 1 / (1 + air * 0.35);
      _bp.set(k.position.x, road + 0.04, k.position.z);
      _bEuler.set(0, k.yaw, 0);
      _bq.setFromEuler(_bEuler);
      _bs.set(2.3 * sc, 1, 3.1 * sc);
      this.mesh.setMatrixAt(i, _bm.compose(_bp, _bq, _bs));
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// =============================================================== 8. race setup

let R = null;       // live race context (null outside races)

// Constructs an optional subsystem; logs and returns null on failure.
function tryCreate(key, fn) {
  try { return fn(); } catch (err) {
    console.error(`[main] ${key} failed to start — racing without it`, err);
    return null;
  }
}

function shuffleWith(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * The CPU field for this set (SPEC §14.5–14.6): characters no human picked
 * (never custom racers), each on a seeded CPU_PRESETS loadout. Kept for the
 * whole set; only CPUs whose character a human took are replaced.
 */
function ensureCpuField(humanDefs, count) {
  const taken = new Set(humanDefs.map((d) => d.id));
  const rng = makeRng((S.seed + S.raceNo * 7919) >>> 0);
  let cpus = (S.cpus || []).filter((c) => !taken.has(c.def.id));
  if (cpus.length > count) cpus = cpus.slice(0, count);
  const used = new Set(cpus.map((c) => c.def.id));
  const pool = shuffleWith(roster().filter((c) => !isCustomDef(c) && !taken.has(c.id) && !used.has(c.id)), rng);
  // a full roster always has enough racers; a tiny one reuses characters
  for (let i = 0; cpus.length < count && i < count * 4; i++) {
    const def = pool.length ? pool.shift() : roster().filter((c) => !isCustomDef(c))[i % Math.max(1, roster().length)];
    if (!def) break;
    const presets = CPU_PRESETS[weightClassOf(def)] || CPU_PRESETS.medium;
    const loadout = presets[rng() < 0.5 ? 0 : 1];
    let key = `cpu:${def.id}`;
    while (cpus.some((c) => c.key === key)) key += '+';
    cpus.push({ key, def, loadout: { ...loadout } });
  }
  S.cpus = cpus;
  return cpus;
}

/**
 * Who races, on what, from which grid slot. Race 1 of a set: CPUs in front
 * (seeded order), the humans fill the last N slots with P1 front-most. Later
 * races start in the previous race's finishing order; newcomers at the back.
 */
function makeSetup(trackId) {
  const players = connectedPlayers().filter((p) => p.char && p.ready);
  const humans = players.map((p) => ({
    slot: p.slot, key: p.key, kb: !!p.kb, def: charById(p.char) || charById(defaultCharId()),
    loadout: sanitizeLoadout({ body: p.body, wheels: p.wheels }), assist: !!p.assist,
  })).filter((h) => h.def);
  const cpus = ensureCpuField(humans.map((h) => h.def), Math.max(0, RACE.racers - humans.length));
  const keys = new Set([...humans.map((h) => h.key), ...cpus.map((c) => c.key)]);
  let order;
  if (S.lastOrder && S.lastOrder.length) {
    order = S.lastOrder.filter((k) => keys.has(k));
    const rest = [...cpus.map((c) => c.key), ...humans.map((h) => h.key)].filter((k) => !order.includes(k));
    order.push(...rest);
  } else {
    order = [...cpus.map((c) => c.key), ...humans.map((h) => h.key)];
  }
  return { trackId, cc: S.cc, items: S.mode === 'vs' ? S.items : true, humans, cpus, order };
}

function buildRace(setup) {
  teardownRace();
  const ec = getEngineClass(setup.cc);
  const karts = [], humans = [], cpuKarts = [];
  const entryByKart = new Map();
  for (const key of setup.order) {
    const h = setup.humans.find((x) => x.key === key);
    const c = h ? null : setup.cpus.find((x) => x.key === key);
    if (!h && !c) continue;
    const def = h ? h.def : c.def;
    const k = new Kart({
      id: h ? `${def.id}@P${h.slot}` : def.id, character: def, track, isPlayer: !!h,
      loadout: h ? h.loadout : c.loadout, ccMult: ec.mult, steerAssist: h ? h.assist : false, slot: h ? h.slot : null,
    });
    // kart.js fills these from the character; fallbacks keep views / HUD / results working
    if (!k.cssColor) k.cssColor = def.cssColor || '#ffffff';
    if (!k.name) k.name = def.name;
    karts.push(k);
    entryByKart.set(k, { key, name: def.name, cssColor: def.cssColor || k.cssColor, slot: h ? h.slot : null });
    if (h) {
      humans.push({
        slot: h.slot, key, kb: h.kb, kart: k, pad: h.kb ? null : new PadInput(phone, h.slot),
        view: null, ai: null, aiCtx: null, auto: false, inactive: 0, activeT: 0,
        bannerUntil: 0, phoneKey: -1, wasLost: false,
      });
    } else {
      cpuKarts.push(k);
    }
  }
  karts.forEach((k, i) => { k.placeOnGrid(track.gridSlot(i)); k.frozen = true; });
  humans.sort((a, b) => a.slot - b.slot);
  const humanKarts = humans.map((h) => h.kart);

  // ---- race logic (guarded)
  const { ItemSystem, AIDriver, Race } = RaceMods;
  // (Items Off still builds an item-less ItemSystem: no boxes, but the v5 lire stay on the track)
  const items = ItemSystem
    ? tryCreate('items', () => new ItemSystem({ track, karts, scene, effects, rng: Math.random, ccMult: ec.mult, enabled: !!setup.items }))
    : null;
  const race = Race ? tryCreate('race', () => new Race({ track, karts, laps: RACE.laps, player: humanKarts[0] || null, humans: humanKarts })) : null;
  const drivers = [];
  if (AIDriver && cpuKarts.length) {
    tryCreate('ai', () => {
      if (RaceMods.createAIDrivers) drivers.push(...RaceMods.createAIDrivers(cpuKarts, { track, difficulty: ec.cpu, rng: Math.random, player: null }));
      else for (const k of cpuKarts) drivers.push(new AIDriver(k, { track, difficulty: ec.cpu, rng: Math.random }));
      return true;
    }) || (drivers.length = 0);
  }

  // ---- split-screen views: one per human (slot order)
  const n = Math.max(1, humans.length);
  const views = [];
  for (let i = 0; i < n; i++) {
    const h = humans[i] || null;
    const cam = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
    scene.add(cam);
    const chase = new ChaseCamera(cam);
    const hud = new HUD(hudRoot, { audio });
    hud.setTrack(track);
    const v = { i, h, cam, chase, hud, rect: null, pan: 0, tags: [] };
    chase.setTarget(h ? h.kart : karts[0]);
    if (h) h.view = v;
    views.push(v);
  }
  // per-view "P2" tags over the other humans' karts
  for (const v of views) {
    v.tags = humans.filter((o) => o !== v.h).map((o) => ({ kart: o.kart, label: slotLabel(o.slot), color: slotInfo(o.slot).css }));
  }
  const slotColors = { colors: new Map(), labels: new Map() };
  for (const h of humans) {
    slotColors.colors.set(h.kart, slotInfo(h.slot).css);
    slotColors.labels.set(h.kart, { label: slotLabel(h.slot), color: slotInfo(h.slot).css });
  }
  const kartViews = karts.map((k) => new KartView(k, scene, effects, { lod: n === 1 || k.isPlayer ? 'auto' : 'low' }));
  // split-screen: a human's kart is drawn / LOD-switched for its own view's camera
  const ownCam = kartViews.map((kv) => {
    const v = n > 1 ? views.find((x) => x.h && x.h.kart === kv.kart) : null;
    return v ? v.cam : null;
  });

  // human karts: low-detail in the views that do not own them (render)
  const humanKvs = n > 1 ? kartViews.filter((kv) => kv.kart.isPlayer) : [];

  effects.clear();
  effects.intensity = n >= 2 ? 0.5 : 1;
  // track hazards (SPEC §15.3, §16.1): the world kit's set (it draws them); a
  // track whose hazards module has hazards but whose kit exposes none still
  // gets them (undrawn, warned) so the game and the sim agree
  const hazards = worldHazards() || undrawnHazards(track);
  if (hazards && typeof hazards.reset === 'function') tryCreate('hazards', () => { hazards.reset(); return true; });
  R = {
    setup, karts, humans, humanKarts, cpuKarts, items, race, drivers, views, kartViews, ownCam, humanKvs, entryByKart, slotColors,
    hByKart: new Map(humans.map((h) => [h.kart, h])),
    ccMult: ec.mult, difficulty: ec.cpu,
    song: nextRaceSong(track),
    offs: [],
    clock: 0, frames: 0,
    inputGuard: 1,           // no intro skip until frames > this (the Enter that started the race)
    firstFinishAt: -1,       // r.clock when the first human finished (≥ 2 humans: 30 s clock)
    allDoneAt: -1,           // r.clock when every human had finished
    clockWarned: 0,
    leader: humanKarts[0] || null,
    failed: new Set(),
    hudCtx: { player: null, race, karts, items, phoneConnected: false, slotColors: slotColors.colors, aiDriving: false },
    aiCtx: { karts, items, race, player: humanKarts[0] || null, humans: humanKarts, hazards },
    hazards,
    // item feedback state (SPEC §15.2): Capo Crusher target + launcher, Beer Rocket riders, timed HUD effects
    capo: { target: null, by: null, until: 0 },
    beer: new Map(),         // kart → r.simClock when its Beer Rocket started
    timers: [],              // [{ at: r.simClock, fn }] run after the substeps (paused races wait)
    engine: { speed: 0, maxSpeed: 1, throttle: 0, drifting: false, boosting: false, grounded: true, offroad: false, active: true },
    finalLap: false,
    introFull: false,        // split-screen: view 0 shows the intro flyover full-screen
  };
  applyPixelRatio();
  layoutViews();
  audio.setEngineChannels(n);
  audio.setEngineActive(true);
  // compile every material the race can show now (behind the loading card)
  try { renderer.compile(scene, views[0].cam); } catch { /* optional warm-up */ }
  subscribeRaceEvents();
  startLights.set(0);
  for (const v of views) v.hud.reset();
  menuChase.setTarget(null);

  if (race) {
    try {
      race.startIntro();
      for (const v of views) v.chase.startIntro(track, RACE.introSeconds);
      menus.setIntroHint(true, humans.some((h) => h.kb) ? 'Enter' : 'ITEM');
      audio.playJingle('start');
    } catch (err) {
      subsystemFailed('race', err);
    }
  } else {
    freeDrive();
  }
}

/** View rects, camera aspect / FOV, HUD rects, engine pans, the shared widget. */
function layoutViews() {
  const r = R;
  if (!r) return;
  const W = window.innerWidth, H = window.innerHeight;
  const n = r.views.length;
  const L = splitLayout(n, W, H);
  r.layout = L;
  for (let i = 0; i < n; i++) {
    const v = r.views[i];
    v.rect = L.views[i];
    v.cam.aspect = i === 0 && r.introFull ? W / Math.max(1, H) : v.rect.w / Math.max(1, v.rect.h);
    v.cam.updateProjectionMatrix();
    v.chase.setBaseFov(L.fov);
    const slot = v.h ? v.h.slot : 1;
    // 4P: each quadrant's corner at the center cross stays clear of the shared minimap
    const avoid = n === 4 ? { corner: ['br', 'bl', 'tr', 'tl'][i], w: L.shared.w / 2 + 8 } : null;
    v.hud.setRect(n === 1 ? null : v.rect, { compact: n > 1, color: slotInfo(slot).css, label: slotLabel(slot), avoid });
    v.pan = n === 1 ? 0 : clamp(((v.rect.x + v.rect.w / 2) / W - 0.5) * 1.2, -0.6, 0.6);
  }
  sharedHud.setLayout(L.shared);
}

// No race logic: unfreeze everyone and just drive.
function freeDrive() {
  if (!R) return;
  for (const k of R.karts) k.frozen = false;
  startLights.set(5, true);
  for (const v of R.views) { v.chase.snap(); v.hud.show(); }
  if (R.views.length > 1) sharedHud.show();
  audio.startMusic(R.song);
  menus.setIntroHint(false);
}

function subsystemFailed(key, err) {
  if (!R || R.failed.has(key)) return;
  R.failed.add(key);
  console.error(`[main] ${key} threw — disabled for the rest of this race`, err);
  if (key === 'ai') { R.drivers.length = 0; for (const h of R.humans) { h.ai = null; } }
  else if (key === 'items') { try { R.items.dispose(); } catch { /* ignore */ } R.items = null; R.hudCtx.items = null; R.aiCtx.items = null; }
  else if (key === 'race') { R.race = null; R.hudCtx.race = null; R.aiCtx.race = null; freeDrive(); }
  else if (key === 'hazards') { R.hazards = null; R.aiCtx.hazards = null; for (const h of R.humans) if (h.aiCtx) h.aiCtx.hazards = null; }
}

function teardownRace() {
  if (!R) return;
  const r = R;
  R = null;
  for (const off of r.offs) off();
  r.offs.length = 0;
  for (const v of r.kartViews) v.dispose();
  for (const d of r.drivers) if (d && typeof d.dispose === 'function') { try { d.dispose(); } catch { /* ignore */ } }
  for (const h of r.humans) if (h.ai && typeof h.ai.dispose === 'function') { try { h.ai.dispose(); } catch { /* ignore */ } }
  if (r.items) { try { r.items.dispose(); } catch (err) { console.error('[main] items.dispose failed', err); } }
  if (r.race && typeof r.race.dispose === 'function') { try { r.race.dispose(); } catch { /* ignore */ } }
  for (const v of r.views) {
    v.chase.dispose();
    v.hud.dispose();
    scene.remove(v.cam);
  }
  effects.clear();
  effects.intensity = 1;
  sharedHud.hide();
  blobs.update(null);
  audio.setEngineChannels(0);
  audio.setEngineActive(false);
  audio.setMusicIntensity(0);
  if (startLights) startLights.hide();
  menus.setIntroHint(false);
  if (menuChase.target && r.karts.includes(menuChase.target)) { menuChase.setTarget(null); menuChase.mode = 'chase'; }
  renderer.setScissorTest(false);
  applyPixelRatio();
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
}

// =============================================================== 9. race frame

/** A CPU driver for a human's kart: phone gone (≥ 2 humans), finished, or tests. */
function takeOver(h, permanent = false) {
  const r = R;
  if (!r) return false;
  if (permanent) h.auto = true;
  if (h.ai) return true;
  const k = h.kart;
  if (RaceMods.AIDriver) {
    // its own ctx with player = this kart: no rubber band for a stand-in
    h.aiCtx = { karts: r.karts, items: r.items, race: r.race, player: k, humans: r.humanKarts, hazards: r.hazards };
    h.ai = tryCreate('ai', () => new RaceMods.AIDriver(k, { track, difficulty: r.difficulty, skill: 0.75, rng: Math.random, personality: { aggression: 0.3 } }));
  }
  if (!h.ai) { k.input.throttle = 0.5; k.input.steer = 0; k.input.drift = false; k.input.brake = 0; }
  h.activeT = 0;
  return !!h.ai;
}

function handBack(h) {
  if (h.ai && typeof h.ai.dispose === 'function') { try { h.ai.dispose(); } catch { /* ignore */ } }
  h.ai = null;
  h.aiCtx = null;
  h.inactive = 0;
  h.activeT = 0;
  const ki = h.kart.input;
  ki.steer = 0; ki.throttle = 0; ki.brake = 0; ki.drift = false; ki.useItem = false;
  if (h.view) h.view.hud.flash('YOU\'RE BACK!', { color: '#7dff6a', size: 'medium', duration: 1.1 });
}

// Phones / keyboard → karts, once per frame (before the substeps).
function updateHumans(dt, racing) {
  const r = R;
  const multi = r.humans.length >= 2;
  let pauseBy = 0, skip = false;
  for (let i = 0; i < r.humans.length; i++) {
    const h = r.humans[i];
    const k = h.kart;
    let active = true;
    if (!h.kb) {
      h.pad.update(dt);
      const lost = phone.isLost(h.slot);
      active = h.pad.active && !lost;
      if (h.pad.pausePressed && racing) pauseBy = h.slot;
      if (h.pad.itemPressed) skip = true;
      // solo race: the racer's phone losing its signal pauses (PhoneLink's own
      // 'signal' pause only fires while it is the only phone in the room)
      if (!multi && lost && !h.wasLost && racing && !k.finished) pauseBy = h.slot;
      h.wasLost = lost;
    } else if (input.itemPressed || input.menu.confirm) {
      skip = true;
    }
    // ≥ 2 humans: a silent / hidden phone's kart is driven by a CPU until it is back
    if (multi && !h.auto && !k.finished && racing) {
      if (!active) {
        h.activeT = 0;
        h.inactive += dt;
        if (!h.ai && h.inactive >= TAKEOVER_AFTER_S) takeOver(h);
      } else {
        h.inactive = 0;
        if (h.ai) { h.activeT += dt; if (h.activeT >= HANDBACK_AFTER_S) handBack(h); }
      }
    }
    if (h.ai || !racing) continue;
    const ki = k.input;
    if (h.kb) {
      ki.steer = input.steer; ki.throttle = input.throttle; ki.brake = input.brake; ki.drift = input.drift;
      if (input.itemPressed) ki.useItem = true;
      h.view.chase.lookBack = input.lookBack;
    } else {
      const pd = h.pad;
      ki.steer = pd.steer; ki.throttle = pd.throttle; ki.brake = pd.brake; ki.drift = pd.drift;
      if (pd.itemPressed) ki.useItem = true;
    }
  }
  // intro skip: any player's item press (or Enter on the keyboard)
  if (skip && racing && r.frames > r.inputGuard && r.race && r.race.state === 'intro') skipIntro();
  if (pauseBy) pause(pauseBy);
}

/** One physics substep (SPEC §12 order): AI → items → karts → collisions → race. */
function step(dt) {
  const r = R;
  const drivers = r.drivers;
  if (drivers.length) {
    try { for (let i = 0; i < drivers.length; i++) drivers[i].update(dt, r.aiCtx); } catch (err) { subsystemFailed('ai', err); }
  }
  for (let i = 0; i < r.humans.length; i++) {
    const h = r.humans[i];
    if (!h.ai) continue;
    h.aiCtx.items = r.items; h.aiCtx.race = r.race;
    try { h.ai.update(dt, h.aiCtx); } catch (err) { console.error('[main] stand-in driver failed', err); h.ai = null; }
  }
  if (r.items) {
    try { r.items.update(dt, r.race); } catch (err) { subsystemFailed('items', err); }
  }
  const karts = r.karts;
  for (let i = 0; i < karts.length; i++) karts[i].update(dt);
  resolveKartCollisions(karts);
  if (r.hazards) {
    try { stepHazards(r, dt); } catch (err) { subsystemFailed('hazards', err); }
  }
  if (r.race) {
    try { r.race.update(dt); } catch (err) { subsystemFailed('race', err); }
  }
}

/** The current world's hazards ({ update(dt), check(kart) → null | 'crush' | 'fire' }) or null. */
function worldHazards() {
  const hz = world && world.hazards;
  return hz && typeof hz.update === 'function' && typeof hz.check === 'function' ? hz : null;
}

// The track's hazards from hazards.js when the world kit exposes none (null if the set is empty).
let _undrawnWarned = '';
function undrawnHazards(track) {
  if (!RaceMods.createHazards) return null;
  let hz = null;
  try { hz = RaceMods.createHazards(track); } catch (err) { console.warn('[main] createHazards failed', err); return null; }
  if (!hz || !Array.isArray(hz.list) || !hz.list.length) return null;
  if (_undrawnWarned !== track.id) { _undrawnWarned = track.id; console.warn(`[main] ${track.id}: the world kit exposes no world.hazards; running ${hz.list.length} hazards.js hazards undrawn`); }
  return hz;
}

// Track hazards, once per substep (hazards.js stepCourseHazards, the same code
// as tools/sim.mjs): the hazard clock runs with the race (time scale, pause),
// then every kart is checked and the effect applied ('crush' / tumble → tumble,
// 'fire' / spin → spin, knock, slow; stars / Beer Rockets / the grid pass).
// No hits during the intro / countdown (nobody is near a hazard anyway).
function stepHazards(r, dt) {
  const st = r.race ? r.race.state : 'racing';
  const live = st === 'racing' || st === 'finished';
  if (RaceMods.stepCourseHazards) { RaceMods.stepCourseHazards(r.hazards, r.karts, dt, live); return; }
  // hazards.js failed to load: the v4 mapping on the world kit's own set
  const hz = r.hazards;
  hz.update(dt);
  if (!live) return;
  for (const k of r.karts) {
    const kind = hz.check(k);
    if (!kind || k.frozen || k.isInvincible() || k.beer) continue;
    if (kind === 'crush') k.tumble('crush');
    else if (kind === 'fire') k.spinOut('fire');
  }
}

const _nearCam = (k, views) => {
  let best = views[0].cam, bd = Infinity;
  for (let i = 0; i < views.length; i++) {
    const c = views[i].cam.position;
    const dx = c.x - k.position.x, dz = c.z - k.position.z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = views[i].cam; }
  }
  return best;
};

/** Per-frame race update: input → substeps → views → cameras → HUDs → audio → finish rules. */
function raceFrame(dt) {
  const r = R;
  const onRace = S.screen === 'race';
  const racing = onRace && !S.paused;
  const live = racing || S.screen === 'results' || S.screen === 'standings';
  r.clock += dt;
  r.frames++;

  if (onRace) updateHumans(dt, racing);
  if (R !== r) return;

  // ---- simulate
  let simDt = 0;
  if (live) {
    simDt = Math.min(dt * S.timeScale, PHYS.maxFrameDt * Math.max(1, S.timeScale));
    const n = Math.max(1, Math.ceil(simDt / PHYS.maxSubstep - 1e-6));
    const h = simDt / n;
    for (let i = 0; i < n && R === r; i++) step(h);
    if (R !== r) return;          // a handler tore the race down mid-frame
  }
  r.simClock = (r.simClock || 0) + simDt;
  if (r.timers.length) runTimers(r);
  if (R !== r) return;
  if (r.hazards && simDt > 0 && onRace) hazardSounds(r);

  // ---- the CPU rubber band follows the leading human
  let lead = null;
  for (let i = 0; i < r.humanKarts.length; i++) {
    const k = r.humanKarts[i];
    if (!lead || (k.place || 99) < (lead.place || 99)) lead = k;
  }
  r.aiCtx.player = lead;

  // ---- kart views (LOD + effects relative to the nearest view camera) and cameras
  const views = r.views;
  for (let i = 0; i < r.kartViews.length; i++) {
    const kv = r.kartViews[i];
    kv.update(simDt, r.ownCam[i] || (views.length === 1 ? views[0].cam : _nearCam(kv.kart, views)));
  }
  for (let i = 0; i < views.length; i++) {
    views[i].chase.update(simDt);
    beerCamera(r, views[i], simDt);
  }
  if (S.screen === 'results' || S.screen === 'standings') menuChase.update(simDt);
  blobs.update(r.karts);

  // ---- HUDs + engine audio (race screen)
  if (onRace) {
    const hc = r.hudCtx;
    const hudDt = S.paused ? 0 : dt;
    const n = views.length;
    for (let i = 0; i < n; i++) {
      const v = views[i], h = v.h;
      if (!h) continue;
      const k = h.kart, p = S.players.get(h.slot);
      hc.player = k;
      hc.phoneConnected = !h.kb && !!p && p.connected;
      hc.aiDriving = !!h.ai && !h.auto && !k.finished;
      v.hud.update(hudDt, hc);
      if (typeof v.hud.setCoins === 'function') v.hud.setCoins(k.coins | 0);   // v5 lire (the coin plugin keeps kart.coins)
      if (v.warnOn && r.capo.target !== k) setCapoWarn(v, false);     // fallback warning only
      v.hud.setWrongWay(!!k.wrongWay && !k.finished && !!r.race && r.race.state === 'racing');
      if (n > 1) v.hud.updateTags(v.cam, v.tags);
      const e = r.engine;
      e.speed = k.speed; e.maxSpeed = k.maxSpeed; e.throttle = k.input.throttle;
      e.drifting = k.drift.active; e.boosting = k.boostTimer > 0; e.grounded = k.grounded;
      e.offroad = k.surface === 'offroad'; e.active = racing;
      audio.updateEngine(dt, e, i, v.pan, ENGINE_LEVEL[n] || 0.6);
    }
    if (n > 1) sharedHud.update(dt, r.karts, r.slotColors, r.race ? r.race.standings : r.karts);
    if (r.capo.target && r.simClock > r.capo.until) clearCapo(r);
    if (racing) checkRaceEnd(r);
  }
  if (R !== r) return;
  syncRacePhones(r, dt);
}

// Course hazards are heard where they are: a crusher thuds onto the road, a
// geyser erupts (distance-attenuated to the nearest view, like every one-shot).
const _hzPos = new THREE.Vector3();
function hazardSounds(r) {
  const hz = r.hazards;
  const list = hz.list;
  if (!Array.isArray(list) || typeof hz.stateAt !== 'function') return;
  const prev = r.hzPrev || (r.hzPrev = new Map());
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    if (h.type !== 'crusher' && h.type !== 'geyser') continue;
    let st;
    try { st = hz.stateAt(h); } catch { return; }
    const on = h.type === 'crusher' ? !!st.danger : !!st.erupting;
    const was = prev.get(h);
    prev.set(h, on);
    if (!on || was !== false || !Number.isFinite(h.x)) continue;
    _hzPos.set(h.x, (h.y || 0) + 1, h.z);
    if (h.type === 'crusher') sfx(SND.slam, _hzPos, 1.3, 0.65);
    else sfx(SND.geyser, _hzPos, 0.9, 0.55);
  }
}

// Timed race feedback (espresso ink landing …) on the race clock.
function runTimers(r) {
  const due = [];
  for (let i = r.timers.length - 1; i >= 0; i--) if (r.timers[i].at <= r.simClock) { due.push(r.timers[i]); r.timers.splice(i, 1); }
  for (let i = due.length - 1; i >= 0; i--) { try { due[i].fn(); } catch (err) { console.error('[main] race timer failed', err); } }
}
function after(r, seconds, fn) { r.timers.push({ at: (r.simClock || 0) + Math.max(0, seconds), fn }); }

/** Is this kart riding a Beer Rocket right now (after the chug)? */
function beerRide(r, k) {
  if (k.finished) return 0;
  if (k.beer !== undefined) return k.beer && k.beer.phase === 'ride' ? 1 : 0;   // items.js state
  const t0 = r.beer.get(k);
  if (t0 === undefined) return 0;
  return (r.simClock - t0) >= ITEMV('beerChug', 0.7) ? 1 : 0;
}

// Beer Rocket camera feel: the rider's view widens (FOV kick on top of the
// chase camera's own boost FOV) and its HUD gets speed lines when it has them.
function beerCamera(r, v, dt) {
  const k = v.h ? v.h.kart : null;
  const want = k && S.screen === 'race' ? beerRide(r, k) * BEER_FOV_KICK : 0;
  const prev = v.fovKick || 0;
  if (!want && prev < 0.02) {
    if (prev) {
      v.fovKick = 0;
      v.cam.fov = v.chase.fov;
      v.cam.updateProjectionMatrix();
      beerCameraPose(v, 0);
      if (typeof v.hud.speedLines === 'function') { try { v.hud.speedLines(0); } catch { /* optional */ } }
    }
    return;
  }
  v.fovKick = damp(prev, want, BEER_FOV_RATE, dt);
  v.cam.fov = v.chase.fov + v.fovKick;
  v.cam.updateProjectionMatrix();
  const u = clamp(v.fovKick / BEER_FOV_KICK, 0, 1);
  beerCameraPose(v, want ? u : (u < 0.02 ? 0 : u));
  if (typeof v.hud.speedLines === 'function') {
    try { v.hud.speedLines(u); } catch { /* optional */ }
  }
}

// Blend the chase camera's pose params toward the high "ride" pose by u (0..1).
function beerCameraPose(v, u) {
  const P = v.chase.params;
  if (!v.beerBase) {
    if (u <= 0) return;
    v.beerBase = { height: P.height, distance: P.distance, lookHeight: P.lookHeight, lookAhead: P.lookAhead };
  }
  const B = v.beerBase;
  P.height = B.height + BEER_CAM.height * u;
  P.distance = B.distance + BEER_CAM.distance * u;
  P.lookHeight = B.lookHeight + BEER_CAM.lookHeight * u;
  P.lookAhead = B.lookAhead + BEER_CAM.lookAhead * u;
  if (u <= 0) v.beerBase = null;      // back to the exact base pose
}

// ---- Capo Crusher warning (SPEC §15.2): the targeted human's view + phone
function setCapoWarn(v, on, again = false) {
  if (!v || (!!v.warnOn === !!on && !(on && again))) return;
  v.warnOn = !!on;
  if (typeof v.hud.warn === 'function') {
    try { v.hud.warn(on ? 'capo' : null); } catch (err) { console.warn('[main] hud.warn failed', err); }
  }
}
function clearCapo(r) {
  const t = r.capo.target;
  r.capo.target = null;
  r.capo.until = 0;
  const h = t && t.isPlayer ? r.hByKart.get(t) : null;
  if (h) setCapoWarn(h.view, false);
}

// SPEC §14.5: results RACE.resultsDelay after the last human finished; with
// ≥ 2 humans a 30 s clock starts when the first one finishes.
function checkRaceEnd(r) {
  const nh = r.humans.length;
  let done = 0;
  for (let i = 0; i < nh; i++) if (r.humans[i].kart.finished) done++;
  const t = r.simClock;
  if (nh && done === nh) {
    if (r.allDoneAt < 0) r.allDoneAt = t;
    if (t - r.allDoneAt >= RACE.resultsDelay) goResults();
    return;
  }
  if (nh >= 2 && r.firstFinishAt >= 0) {
    const left = FINISH_CLOCK_S - (t - r.firstFinishAt);
    const warn = left <= 10 ? 10 : left <= FINISH_CLOCK_S ? FINISH_CLOCK_S : 0;
    if (warn && r.clockWarned !== warn) {
      r.clockWarned = warn;
      for (const h of r.humans) if (!h.kart.finished && h.view) h.view.hud.flash(`${warn} SECONDS LEFT!`, { color: '#ff9d2e', size: 'medium', duration: 1.6 });
    }
    if (left <= 0) goResults();
    return;
  }
  if (!nh && r.race && r.race.over) goResults();
  else if (r.race && r.race.time > RESULTS_FAILSAFE + RACE.laps * 150) goResults();
}

function skipIntro() {
  if (!R || !R.race) return;
  try { R.race.skipIntro(); } catch (err) { subsystemFailed('race', err); }
  for (const v of R.views) v.chase.snap();
  menus.setIntroHint(false);
}

function onHumanFinish(h, place) {
  const r = R;
  if (!r) return;
  if (r.firstFinishAt < 0) r.firstFinishAt = r.simClock || 0;
  // after the line a CPU drives the kart round (as in the old solo game)
  h.kart.input.useItem = false;
  takeOver(h, true);
  if (h.view) {
    h.view.chase.startOrbit();
    h.view.hud.showFinish(place);
  }
  audio.playJingle(place <= 3 ? 'finish' : 'lose');
  vibrate(h.slot, VIBE.finish);
  if (place <= 3) {
    _confettiPos.copy(h.kart.position).y += 2.2;
    effects.burst('confetti', _confettiPos, { count: 110 });
  }
}
const _confettiPos = new THREE.Vector3();

// =============================================================== 10. race events

const _sfx = { volume: 1, pitch: 1, pan: 0 };
const _camRight = new THREE.Vector3();
const _rel = new THREE.Vector3();

// One-shot sound for a kart (or a position): a player's own sounds at full
// volume panned toward their view, everything else attenuated by the distance
// to the nearest view camera. `name` may be a preference list (see snd()).
function sfx(name, kart, base = 1, pitch = 1) {
  const r = R;
  if (!r || base <= 0 || S.screen !== 'race') return;
  if (Array.isArray(name)) { name = snd(name); if (!name) return; }
  const n = r.views.length;
  const h = kart && kart.isPlayer ? r.hByKart.get(kart) : null;
  if (h && h.view) {
    _sfx.volume = base * (SFX_HUMAN[n] || 0.7);
    _sfx.pan = h.view.pan;
  } else {
    const pos = kart && kart.position ? kart.position : kart;
    if (!pos) return;
    let cam = r.views[0].cam, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = r.views[i].cam.position.distanceToSquared(pos);
      if (d < bd) { bd = d; cam = r.views[i].cam; }
    }
    _rel.subVectors(pos, cam.position);
    const d = _rel.length();
    if (d > 75) return;
    const fall = 1 - d / 75;
    _sfx.volume = base * fall * fall * 0.85 * (SFX_HUMAN[n] || 0.7);
    _camRight.setFromMatrixColumn(cam.matrixWorld, 0);
    _sfx.pan = d > 0.01 ? clamp(_rel.dot(_camRight) / d, -1, 1) * 0.7 : 0;
  }
  _sfx.pitch = pitch;
  audio.play(name, _sfx);
}

function vibrate(slot, pattern) {
  if (!phone || S.screen !== 'race' || !slot) return;
  const p = S.players.get(slot);
  if (p && !p.kb && p.connected) phone.sendEvent('vibrate', { pattern }, slot);
}

function subscribeRaceEvents() {
  const r = R;
  const on = (type, fn) => r.offs.push(bus.on(type, fn));
  const hOf = (k) => (k && k.isPlayer ? r.hByKart.get(k) || null : null);
  // per-player banner with priority: lap / final-lap / start banners hold the slot
  const banner = (h, text, opts, hold = 0) => {
    if (!h || !h.view) return;
    if (hold <= 0 && r.clock < h.bannerUntil) return;
    h.view.hud.flash(text, opts);
    if (hold > 0) h.bannerUntil = r.clock + hold;
  };
  const flashView = (h, kind) => { if (h && h.view) menus.screenFlash(kind, r.views.length > 1 ? h.view.rect : null); };

  // ---- race flow → HUDs / lights / audio / phones
  on('race:countdown', (e) => {
    if (S.screen !== 'race') return;
    menus.setIntroHint(false);
    for (const v of r.views) { v.hud.show(); v.hud.countdown(e.n); }
    if (r.views.length > 1) sharedHud.show();
    startLights.set(LIGHT_RED_COUNT[e.n] || 0);
    audio.play('countdown');
    for (const h of r.humans) vibrate(h.slot, VIBE.countdown);
  });
  on('race:go', () => {
    if (S.screen !== 'race') return;
    for (const v of r.views) v.hud.countdown(0);
    startLights.set(5, true);
    audio.play('go');
    audio.startMusic(r.song);
    for (const h of r.humans) vibrate(h.slot, VIBE.go);
  });
  on('race:startBoost', (e) => {
    const h = hOf(e.kart);
    if (!h) return;                    // CPUs: their kart:boost 'start' whoosh below
    sfx('startBoost', e.kart, 1);
    banner(h, 'ROCKET START!', { color: '#38c8ff', size: 'medium', duration: 1.3 }, 1.3);
  });
  on('race:stall', (e) => {
    const h = hOf(e.kart);
    if (!h) return;
    sfx('stall', e.kart, 1);
    banner(h, 'STALLED!', { color: '#ff9d2e', size: 'medium', duration: 1.2 }, 1.2);
  });
  on('race:lap', (e) => {
    const h = hOf(e.kart);
    if (!h) return;
    const laps = r.race ? r.race.laps : RACE.laps;
    if (e.lap > laps) return;
    vibrate(h.slot, VIBE.lap);
    if (e.lap < laps) {
      sfx('lap', e.kart, 1);
      banner(h, `LAP ${e.lap}`, { color: '#ffd23a' }, FLASH_HOLD);
    }
  });
  on('race:finalLap', (e) => {
    const h = hOf(e.kart);
    if (!h) return;
    sfx('finalLap', e.kart, 1);
    if (!r.finalLap) { r.finalLap = true; audio.setMusicIntensity(1); }
    banner(h, 'FINAL LAP!', { color: '#ff5a3c', duration: 2 }, 2);
  });
  on('race:finish', (e) => { const h = hOf(e.kart); if (h) onHumanFinish(h, e.place); });

  // ---- kart one-shots
  on('kart:hop', (e) => sfx('hop', e.kart, e.kart.isPlayer ? 0.5 : 0.3));
  on('kart:land', (e) => sfx('land', e.kart, clamp(e.airTime || 0.3, 0.3, 1)));
  on('kart:driftTier', (e) => sfx(`drift${clamp(e.tier | 0, 1, 3)}`, e.kart, e.kart.isPlayer ? 0.9 : 0.4));
  on('kart:boost', (e) => {
    // an item / pad boost washes espresso off the screen (research brief §B5)
    if (e.source === 'item' || e.source === 'pad') clearInk(hOf(e.kart));
    if (e.source === 'item') sfx('toot', e.kart, 1);                 // toot boost = the signature fart
    else if (e.source === 'start') { if (!e.kart.isPlayer) sfx('boost', e.kart, 0.4); }
    else sfx('boost', e.kart, e.source === 'pad' ? 0.8 : 0.9);
  });
  on('kart:trick', (e) => {
    sfx('boost', e.kart, 0.7);
    const h = hOf(e.kart);
    if (h) banner(h, 'TRICK!', { color: '#7dff6a', size: 'medium', duration: 0.9 });
  });
  on('kart:spin', (e) => {
    const h = hOf(e.kart);
    if (e.cause === 'fire') {
      // flame arm / lava geyser (Krishiv's Palace)
      sfx(SND.fire, e.kart, 1.1);
      if (h) { vibrate(h.slot, VIBE.fire); flashView(h, 'hit'); banner(h, 'TOASTY!', { color: '#ff7a1a', size: 'medium', duration: 1.0 }); }
      return;
    }
    sfx('spin', e.kart, 1);
    if (h) { vibrate(h.slot, VIBE.hit); if (e.cause !== 'zap') flashView(h, 'hit'); }
  });
  on('kart:tumble', (e) => {
    const h = hOf(e.kart);
    if (e.cause === 'crush') {
      // a crushing stone block came down on the kart
      sfx(SND.crush, e.kart, 1.25, 0.75);
      shakeNear(e.kart.position, 26, 0.3);
      if (h) { vibrate(h.slot, VIBE.crush); flashView(h, 'hit'); h.view.chase.shake(0.55); banner(h, 'SQUASHED!', { color: '#d9d4e8', size: 'medium', duration: 1.2 }); }
      return;
    }
    sfx('hit', e.kart, 1);
    if (h) { if (e.cause !== 'capo') vibrate(h.slot, VIBE.hit); flashView(h, 'hit'); }
  });
  on('kart:wallHit', (e) => {
    const it = clamp(e.intensity || 0.5, 0, 1);
    sfx('wall', e.kart, 0.35 + 0.65 * it);
    const h = hOf(e.kart);
    if (h && it > 0.45) vibrate(h.slot, [Math.round(20 + 40 * it)]);
  });
  on('kart:bump', (e) => {
    const it = clamp(e.intensity || 0.5, 0, 1);
    const k = e.b && e.b.isPlayer ? e.b : e.a;
    sfx('bump', k, 0.35 + 0.65 * it);
    const ha = hOf(e.a), hb = hOf(e.b);
    if (ha) vibrate(ha.slot, VIBE.bump);
    if (hb) vibrate(hb.slot, VIBE.bump);
    // star ram (kart.js: a = the starred kart, b = the one it sent flying); a Beer
    // Rocket rider is invincible through the star timer too, its ram says CHEERS! (item:hit)
    if (ha && e.a.starTimer > 0 && !e.a.beer && e.b && e.b.tumbleTimer > HIT.tumbleDuration - 0.1) {
      banner(ha, HIT_CALLOUT.star, { color: '#ffe14d', size: 'medium', duration: 0.9, sub: e.b.name, subColor: e.b.cssColor });
    }
  });
  on('kart:starStart', (e) => {
    sfx('star', e.kart, 1);
    const h = hOf(e.kart);
    if (h) { flashView(h, 'star'); clearInk(h); }
  });
  on('kart:respawn', (e) => sfx('respawn', e.kart, 0.9));

  // ---- items
  on('item:boxHit', (e) => sfx('itemBox', e.kart, e.kart.isPlayer ? 0.8 : 0.6));
  on('item:get', (e) => { const h = hOf(e.kart); if (h) { sfx('itemGet', e.kart, 1); vibrate(h.slot, VIBE.itemGet); } });
  on('item:use', (e) => {
    const own = ITEM_SFX.use && ITEM_SFX.use[e.item];
    const s = own && typeof SOUNDS[own] === 'function' ? own : ITEM_USE_SOUND[e.item];
    // the zap is heard by everyone it strikes, so it plays at full volume
    if (s) sfx(s, e.item === 'zap' ? r.humanKarts[0] || e.kart : e.kart, e.item === 'zap' ? 1.1 : 1);
  });
  // item event sounds from audio.js (triples deploying, Golden Toot, capo slam, Beer Rocket ride / pop)
  for (const [type, name] of Object.entries(ITEM_SFX.event || {})) {
    if (typeof type !== 'string' || typeof SOUNDS[name] !== 'function') continue;
    on(type, (e) => { const at = e && (e.kart || e.position); if (at) sfx(name, at, 1); });
  }
  on('item:zap', (e) => {
    const victims = Array.isArray(e.victims) ? e.victims : [];
    for (const h of r.humans) {
      if (victims.indexOf(h.kart) >= 0) {
        flashView(h, 'zap');
        banner(h, 'ZAPPED!', { color: '#ffe600', size: 'medium', duration: 1.1, sub: e.kart ? `by ${e.kart.name}` : '', subColor: e.kart ? e.kart.cssColor : '#fff' });
      } else if (h.kart === e.kart) {
        flashView(h, 'zap');
      }
    }
  });
  on('item:hit', (e) => {
    const base = typeof e.item === 'string' ? e.item.replace(/^triple_/, '') : '';
    if (base === 'banana') sfx('banana', e.kart, 1);
    else if (base === 'stink') sfx('stink', e.kart, 0.6);
    // the player's item landed on a rival → a quick callout (the Capo Crusher's
    // target gets its own in item:capoHit; racers in its path were bowled over)
    const by = hOf(e.by);
    if (!by || !e.kart || e.kart === e.by) return;
    const plug = RaceMods.getItemHandler ? RaceMods.getItemHandler(e.item) : null;      // v5 plugin: handler.callout
    const text = e.item === 'capo' ? (e.kart === r.capo.target ? null : 'BOWLED OVER!') : HIT_CALLOUT[e.item] || (plug && typeof plug.callout === 'string' ? plug.callout : null);
    if (text) banner(by, text, { color: '#7dff6a', size: 'medium', duration: 0.9, sub: e.kart.name, subColor: e.kart.cssColor });
  });
  on('item:explode', (e) => { if (e.position) sfx('explode', e.position, 1); });

  // ---- v5 extension points (SPEC §16): plugin sounds, per-view banners, soft hazard effects
  // item:sfx { name, position, kart, volume, pitch }: an audio.js SOUNDS / registerSound name, at a kart
  // (its owner hears it at full level, panned to their view) or a position (distance-attenuated)
  on('item:sfx', (e) => {
    if (!e || typeof e.name !== 'string' || typeof SOUNDS[e.name] !== 'function') return;
    const at = e.kart && e.kart.position ? e.kart : e.position;
    if (at) sfx(e.name, at, Number.isFinite(e.volume) ? e.volume : 1, Number.isFinite(e.pitch) ? e.pitch : 1);
  });
  // hud:flash { kart, text, color, size?, duration?, sub?, subColor?, vibrate? }: a banner on that human's own view
  on('hud:flash', (e) => {
    const h = e && hOf(e.kart);
    if (!h || typeof e.text !== 'string') return;
    banner(h, e.text, { color: e.color || '#ffd23a', size: e.size || 'medium', duration: Number.isFinite(e.duration) ? e.duration : 1.1, sub: e.sub || '', subColor: e.subColor || '#ffffff' });
    if (Array.isArray(e.vibrate)) vibrate(h.slot, e.vibrate);
  });
  // course hazards' light effects (hazards.js applyHazardHit): a bump / a soak
  on('kart:knock', (e) => {
    if (!e || !e.kart) return;
    sfx('bump', e.kart, 0.8);
    const h = hOf(e.kart);
    if (h) vibrate(h.slot, VIBE.bump);
  });
  on('kart:slow', (e) => {
    if (!e || !e.kart) return;
    const h = hOf(e.kart);
    if (h) vibrate(h.slot, VIBE.bump);
  });
  on('item:blocked', (e) => {
    if (e.item === 'capo') {
      // an Accordion Blast (or a lucky boost) stopped the Capo Crusher
      const t = r.capo.target;
      const h = hOf(t);
      sfx(SND.saved, h ? t : e.kart, 0.9);
      if (h) banner(h, 'PHEW!', { color: '#7dff6a', size: 'medium', duration: 1.1, sub: 'Capo Crusher stopped' });
      clearCapo(r);
      return;
    }
    sfx('bump', e.kart, 0.6);
  });

  // ---- v4 items (SPEC §15.2): Capo Crusher, Espresso Splash, Accordion Blast, Beer Rocket, Meatball Bomb.
  // items.js keeps kart.capoWarn / kart.ink / kart.beer and the HUD reads them
  // itself (siren, coffee overlay + their sounds); the phones buzz from
  // padState (race.warn / race.splash). The handlers here add what only the
  // app knows: callouts per view, camera shakes, hit rumbles, and fallbacks
  // for item modules without those kart fields. Explosions also come as
  // item:explode, whose handler plays the blast sound.
  on('item:capoLaunch', (e) => {
    r.capo.by = e.kart || null;
    const h = hOf(e.kart);
    if (h) {
      const t = e.target && e.target !== e.kart ? e.target : null;
      banner(h, 'CAPO CRUSHER!', { color: '#ffb300', size: 'medium', duration: 1.1, sub: t ? `after ${t.name}` : 'after the leader', subColor: t ? t.cssColor : '#ffffff' });
    }
  });
  on('item:capoWarning', (e) => {
    const t = e.target || null;
    const prev = r.capo.target;
    r.capo.target = t;
    r.capo.until = r.simClock + CAPO_WARN_HOLD;
    if (e.kart) r.capo.by = e.kart;
    if (prev && prev !== t) { const hp = hOf(prev); if (hp && !kartHasField(prev, 'capoWarn')) setCapoWarn(hp.view, false); }
    const h = hOf(t);
    if (!h || !h.view || t.finished || kartHasField(t, 'capoWarn')) return;
    // fallback (no kart.capoWarn): the app raises the HUD siren itself
    const fresh = !h.view.warnOn || r.clock - (h.capoBuzz ?? -9) > 1.2;
    setCapoWarn(h.view, true, true);
    if (fresh) { h.capoBuzz = r.clock; sfx(SND.capoWarn, t, 1); }
  });
  on('item:capoHit', (e) => {
    const k = e.kart || null;
    const pos = e.position || (k && k.position) || null;
    const by = e.by || r.capo.by;
    const h = hOf(k);
    if (pos) shakeNear(pos, 30, e.dodged ? 0.25 : 0.4);
    if (h && e.dodged) {
      banner(h, 'DODGED!', { color: '#7dff6a', size: 'big', duration: 1.3, sub: 'Capo Crusher' }, 1.3);
    } else if (h) {
      vibrate(h.slot, VIBE.capoHit);
      h.view.chase.shake(0.6);
      banner(h, 'CRUSHED!', { color: '#ffb300', size: 'big', duration: 1.5, sub: by && by !== k ? `Capo Crusher by ${by.name}` : 'Capo Crusher', subColor: by ? by.cssColor : '#ffffff' }, 1.5);
    }
    const hb = hOf(by);
    if (hb && k && by !== k && !e.dodged) banner(hb, 'BULLSEYE!', { color: '#7dff6a', size: 'medium', duration: 1.1, sub: k.name, subColor: k.cssColor });
    clearCapo(r);
  });
  on('item:capoFizzle', (e) => {
    // knocked out of the air by an Accordion Blast (or it ran out of steam)
    const h = hOf(r.capo.target);
    if (h && e && e.reason === 'blocked') {
      sfx(SND.saved, r.capo.target, 0.9);
      banner(h, 'PHEW!', { color: '#7dff6a', size: 'medium', duration: 1.1, sub: 'Capo Crusher stopped' });
    }
    clearCapo(r);
  });
  on('item:espresso', (e) => {
    const victims = Array.isArray(e.victims) ? e.victims : [];
    const hu = hOf(e.kart);
    if (hu) {
      banner(hu, victims.length ? 'ESPRESSO SPLASH!' : 'NOBODY AHEAD!', { color: '#c8945a', size: 'medium', duration: 1.1,
        sub: victims.length ? `${victims.length} racer${victims.length === 1 ? '' : 's'} splashed` : '' });
    }
    // fallback (no kart.ink): the coffee lands on the victims' own views after the cup's flight
    const delay = ITEMV('espressoDelay', 0.6), dur = ITEMV('espressoTime', 4.5);
    for (const vk of victims) {
      const h = hOf(vk);
      if (!h || kartHasField(vk, 'ink')) continue;
      h.inkIncoming = true;
      after(r, delay, () => {
        h.inkIncoming = false;
        if (R !== r || !h.view || vk.finished) return;
        if (typeof vk.isInvincible === 'function' && vk.isInvincible()) return;
        sfx(SND.espressoSplat, vk, 1);
        splashView(h, 1, dur);
      });
    }
  });
  on('item:accordion', (e) => {
    const k = e.kart;
    if (!k) return;
    shakeNear(k.position, 16, 0.2);
    const h = hOf(k);
    if (h) vibrate(h.slot, VIBE.accordion);
  });
  on('item:beerStart', (e) => {
    const k = e.kart;
    if (!k) return;
    r.beer.set(k, r.simClock);
    const h = hOf(k);
    if (!h) return;
    clearInk(h);
    vibrate(h.slot, VIBE.beer);
    banner(h, 'BEER ROCKET!', { color: '#f2b632', size: 'big', duration: 1.5, sub: 'Chug… and blast off!' }, 1.5);
  });
  on('item:beerRide', (e) => {
    const h = hOf(e.kart);
    if (h && h.view) h.view.chase.shake(0.25);
  });
  on('item:beerEnd', (e) => {
    const k = e.kart;
    if (!k) return;
    r.beer.delete(k);
    const h = hOf(k);
    if (!h) return;
    vibrate(h.slot, VIBE.beerEnd);
    const n = Number(e.gained) | 0;
    if (n > 0) banner(h, `+${n} PLACE${n === 1 ? '' : 'S'}!`, { color: '#f2b632', size: 'medium', duration: 1.2 });
  });
  on('item:bombExplode', (e) => {
    const pos = e.position;
    if (!pos) return;
    shakeNear(pos, 24, 0.38);
    for (const h of r.humans) if (h.kart.position.distanceTo(pos) < 10) vibrate(h.slot, VIBE.bomb);
  });
}

// items.js-provided kart state (number / object fields) vs. an older item module.
const kartHasField = (k, f) => !!k && k[f] !== undefined;

// Camera shake for every view whose camera is near a blast.
function shakeNear(pos, radius, amount) {
  const r = R;
  if (!r || !pos) return;
  for (const v of r.views) {
    const d = v.cam.position.distanceTo(pos);
    if (d < radius) v.chase.shake(amount * (1 - d / radius));
  }
}

// Espresso Splash on one human's own view (hud.splash, SPEC §15.2); a coffee
// flash over the view when the HUD has no splash overlay.
function splashView(h, strength, duration) {
  const r = R;
  if (!r || !h || !h.view) return;
  h.inkUntil = r.simClock + duration;
  const hud = h.view.hud;
  if (typeof hud.splash === 'function') {
    try { hud.splash(strength, duration); return; } catch (err) { console.warn('[main] hud.splash failed', err); }
  }
  menus.screenFlash('coffee', r.views.length > 1 ? h.view.rect : null);
}

function clearInk(h) {
  const r = R;
  if (!r || !h || !h.view || !(h.inkUntil > r.simClock)) return;
  h.inkUntil = 0;
  const hud = h.view.hud;
  if (typeof hud.splash === 'function') { try { hud.splash(0, 0); } catch { /* optional */ } }
}

// =============================================================== 11. podium

// Gelato Cup podium (SPEC §14.5): the top-3 karts on gold / silver / bronze
// blocks just past the start line, confetti, a slow camera drift.
const PODIUM_S = 32;

class Podium {
  constructor(scene, track, entries) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'Podium';
    this.time = 0;
    this.confetti = 0.4;
    this._mats = [];
    this._geos = [];
    this._texs = [];
    this.models = [];
    const f = track.frameAt(PODIUM_S);
    this.center = new THREE.Vector3(f.x, f.y, f.z);
    this.right = f.right.clone();
    this.tangent = f.tangent.clone();
    // the camera looks back down the straight, so the track's right is its left:
    // 2nd place stands on the camera's left, 3rd on its right
    const blocks = [{ place: 1, lat: 0, h: 1.7, color: 0xffc21a }, { place: 2, lat: 3.5, h: 1.15, color: 0xc9d3de }, { place: 3, lat: -3.5, h: 0.75, color: 0xd98a4a }];
    const yaw = Math.atan2(f.tangent.x, f.tangent.z);       // fronts + karts face the camera
    for (const b of blocks) {
      const geo = new THREE.BoxGeometry(3.2, b.h, 3.2);
      this._geos.push(geo);
      // the place number on the front face
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const g = cv.getContext('2d');
      g.fillStyle = `#${b.color.toString(16).padStart(6, '0')}`;
      g.fillRect(0, 0, 128, 128);
      g.fillStyle = '#1b1035';
      g.font = 'bold 96px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(b.place), 64, 70);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      this._texs.push(tex);
      const side = new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.35, metalness: 0.45 });
      const front = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, metalness: 0.2 });
      this._mats.push(side, front);
      // BoxGeometry groups: +x, -x, +y, -y, +z, -z — +z faces the camera after the yaw
      const mesh = new THREE.Mesh(geo, [side, side, side, side, front, side]);
      const pos = this.center.clone().addScaledVector(this.right, b.lat);
      mesh.position.set(pos.x, pos.y + b.h / 2, pos.z);
      mesh.rotation.y = yaw;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      const e = entries[b.place - 1];
      if (e && e.def) {
        try {
          const m = Cast.buildKartModel(e.def, { lod: 'high', loadout: e.loadout || DEFAULT_LOADOUT });
          m.position.set(pos.x, pos.y + b.h, pos.z);
          m.rotation.y = yaw;
          this.group.add(m);
          this.models.push({ m, baseY: pos.y + b.h, place: b.place });
        } catch (err) { console.warn('[main] podium kart failed', err); }
      }
    }
    scene.add(this.group);
    // framed so the karts sit in the upper middle, above the name plates
    this.camPos = this.center.clone().addScaledVector(this.tangent, 13).add(new THREE.Vector3(0, 2.6, 0));
    this.camLook = this.center.clone().add(new THREE.Vector3(0, 0.75, 0));
    this._p = new THREE.Vector3();
    this._c = new THREE.Vector3();
  }

  update(dt) {
    this.time += dt;
    // winners bounce a little (1st the most)
    for (const e of this.models) {
      const amp = e.place === 1 ? 0.12 : 0.06;
      e.m.position.y = e.baseY + Math.max(0, Math.sin(this.time * 3 + e.place)) * amp;
    }
    this.confetti -= dt;
    if (this.confetti <= 0 && effects) {
      this.confetti = 0.75;
      const lat = (Math.random() - 0.5) * 8;
      this._c.copy(this.center).addScaledVector(this.right, lat).y += 5 + Math.random() * 1.5;
      effects.burst('confetti', this._c, { count: 70 });
    }
  }

  applyCamera(cam) {
    const t = this.time;
    this._p.copy(this.camPos).addScaledVector(this.right, Math.sin(t * 0.25) * 2.2);
    this._p.y += Math.sin(t * 0.4) * 0.25;
    cam.position.copy(this._p);
    cam.lookAt(this.camLook);
    setFov(48);
  }

  dispose() {
    this.scene.remove(this.group);
    for (const e of this.models) Cast.disposeKartModel(e.m);
    for (const m of this._mats) m.dispose();
    for (const g of this._geos) g.dispose();
    for (const t of this._texs) t.dispose();
    this.models.length = 0;
  }
}

function disposePodium() {
  if (!podium) return;
  podium.dispose();
  podium = null;
  if (effects) effects.clear();
}

// =============================================================== 12. portraits

// Player-panel portraits: a small persistent offscreen renderer (transparent
// background, same tone mapping) draws each picked racer on its chosen kart
// body + wheels and hands the menus a data URL. One render at a time while
// idle in the menus (never mid-race).
const PORTRAIT = { w: 320, h: 320, gap: 30, raceRetry: 1500 };

class PortraitStudio {
  constructor() {
    this.queue = new Set();          // 'char|body|wheels'
    this.timer = 0;
    this.r = null;
    this.rendered = 0;
  }

  /** The player's current pick should have a portrait. */
  want(p) {
    if (!p || !p.char) return;
    const key = `${p.char}|${p.body}|${p.wheels}`;
    if (menus.hasPortrait(key) || this.queue.has(key)) return;
    this.queue.add(key);
    this._kick(40);
  }

  get pending() { return this.queue.size; }

  _kick(ms) { if (!this.timer && this.queue.size) this.timer = setTimeout(() => this._pump(), ms); }

  _setup() {
    const { w, h } = PORTRAIT;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.setClearColor(0x000000, 0);
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight(0xffffff, 0x6b5a9a, 1.7));
    const key = new THREE.DirectionalLight(0xfff4e0, 2.6);
    key.position.set(3, 6, 5);
    const rim = new THREE.DirectionalLight(0xbfe6ff, 1.6);
    rim.position.set(-5, 3, -4);
    sc.add(key, rim);
    const cam = new THREE.PerspectiveCamera(26, w / h, 0.1, 50);
    const a = 0.62;
    cam.position.set(Math.sin(a) * 5.6, 2.0, Math.cos(a) * 5.6);
    cam.lookAt(0, 0.8, 0);
    this.r = r; this.cv = cv; this.sc = sc; this.cam = cam;
  }

  _pump() {
    this.timer = 0;
    if (!this.queue.size) return;
    if (S.screen === 'race' || S.screen === 'loading' || S.screen === 'boot') { this._kick(PORTRAIT.raceRetry); return; }
    const key = this.queue.values().next().value;
    this.queue.delete(key);
    const [cid, body, wheels] = key.split('|');
    const def = charById(cid);
    if (def) {
      try {
        if (!this.r) this._setup();
        const m = Cast.buildKartModel(def, { lod: 'high', loadout: { body, wheels } });
        this.sc.add(m);
        this.r.render(this.sc, this.cam);
        menus.setPortrait(key, this.cv.toDataURL('image/png'));
        this.sc.remove(m);
        Cast.disposeKartModel(m);
        this.rendered++;
      } catch (err) {
        console.warn('[main] portrait render failed', err);
      }
    }
    this._kick(PORTRAIT.gap);
  }
}

// =============================================================== 13. phone sync

const RACE_SCREENS = new Set(['loading', 'race', 'results', 'standings', 'podium']);
const RACE_STATE_INDEX = { intro: 0, countdown: 1, racing: 2, finished: 3 };

function hostLabel() { const h = computeHost(); return h ? slotLabel(h) : 'The host'; }

function statusText() {
  const host = hostLabel();
  switch (S.screen) {
    case 'lobby':
      if (!S.players.size) return 'Waiting for players — scan the QR code with up to 4 phones';
      if (S.kb) return 'Keyboard mode: pick a mode and class, then START';
      return `${host} picks the mode, then taps START`;
    case 'select': {
      const waiting = connectedPlayers().filter((p) => !p.ready).map((p) => slotLabel(p.slot));
      return waiting.length ? `Waiting for ${waiting.join(', ')}…` : 'Everyone is ready!';
    }
    case 'track':
      if (S.mode !== 'gp') return `${host} is choosing the track`;
      return S.raceNo === 0 ? `${host} picks the cup, then taps GO` : `${host} taps GO for race ${S.raceNo + 1} of the ${curCup().name}`;
    case 'results': return `${host}: tap NEXT for the standings`;
    case 'standings':
      return S.mode === 'gp' && S.raceNo >= curCup().tracks.length ? `${host}: tap NEXT for the trophy` : `${host}: tap NEXT for the next race (or LOBBY)`;
    case 'podium': return `${host}: tap NEXT to go back to the lobby`;
    default: return '';
  }
}

function settingsText() {
  return `${MODE_LABEL[S.mode]} · ${S.cc}cc${S.mode === 'vs' && !S.items ? ' · Items off' : ''}`;
}

function currentTrackRef() {
  if (RACE_SCREENS.has(S.screen) && S.raceNo > 0) { const t = trackInfo(S.trackId); return { id: t.id, name: t.name }; }
  if (S.screen === 'track') {
    if (S.mode === 'gp') { const c = curCup(); const t = trackInfo(c.tracks[Math.min(S.raceNo, c.tracks.length - 1)]); return { id: t.id, name: t.name }; }
    if (S.trackPick !== 'random') { const t = trackInfo(S.trackPick); return { id: t.id, name: t.name }; }
  }
  return null;
}

/** host:state (SPEC §14.7) — shared by every phone (net.js dedupes unchanged states). */
function sharedState() {
  const screen = S.screen === 'race' && S.paused ? 'paused' : S.screen === 'boot' ? 'loading' : S.screen;
  const showRes = screen === 'results' || screen === 'standings' || screen === 'podium';
  return {
    screen, mode: S.mode, cc: S.cc, items: S.items, host: computeHost(),
    raceNo: S.raceNo, races: S.mode === 'gp' ? curCup().tracks.length : S.raceNo,
    track: currentTrackRef(),
    tracks: CAT.tracks,
    // the chosen cup (track ids, as before) + every cup with track refs (SPEC §15.3)
    cup: (() => { const c = curCup(); return { id: c.id, name: c.name, tracks: c.tracks.slice() }; })(),
    cups: CAT.cupsShared,
    players: playersSorted().map((p) => ({
      slot: p.slot, color: slotInfo(p.slot).css, connected: p.connected, ready: p.ready,
      char: p.char, body: p.body, wheels: p.wheels, assist: p.assist, step: p.ready ? 'done' : p.step,
    })),
    characters: CAT.characters, bodies: CAT.bodies, wheels: CAT.wheels,
    results: showRes ? S.results : null,
    standings: screen === 'standings' || screen === 'podium' ? S.standings : null,
    // extras (primitive fields the server forwards)
    status: statusText(),
    pausedBy: S.paused ? S.pausedBy || 0 : 0,
    trackPick: S.trackPick,
    cupId: curCup().id,
    cupLocked: S.mode === 'gp' && S.raceNo > 0,
    keyboard: S.kb,
  };
}

function choiceRatings(p) {
  const def = charById(p.char) || charById(defaultCharId());
  return def ? computeRatings(def, { body: p.body, wheels: p.wheels }) : { speed: 3, accel: 3, handling: 3, weight: 3 };
}

/** host:padState (SPEC §14.7) for one slot. */
function padState(p) {
  const host = computeHost();
  let race = null;
  const h = R && (S.screen === 'race' || S.screen === 'results') ? R.humans.find((x) => x.slot === p.slot) : null;
  if (h) {
    const k = h.kart, rc = R.race;
    const laps = rc ? rc.laps : RACE.laps;
    race = {
      state: rc ? rc.state : 'racing', lap: clamp(k.lap || 1, 1, laps), laps, place: k.place || 0, racers: R.karts.length,
      item: k.item || null, itemCount: k.itemCount || 0, rolling: !!k.rolling, coins: k.coins | 0,
      countdown: rc && rc.state === 'countdown' ? Math.ceil(rc.countdown || 0) : 0,
      finished: !!k.finished, assist: !!k.steerAssist, assistActive: (k.assist || 0) > 0.05,
      cpuDriving: !!h.ai && !h.auto && !k.finished,
    };
    // SPEC §15.2 phone cues: the Capo Crusher is after this racer / coffee on the screen / riding a Beer Rocket
    const fx = raceFx(h);
    if (fx.warn) race.warn = fx.warn;
    race.capoWarn = fx.warn === 'capo';
    race.splash = fx.splash;
    race.beer = fx.beer;
    if (R.firstFinishAt >= 0 && R.humans.length >= 2 && !k.finished) race.finishClock = Math.max(0, Math.ceil(FINISH_CLOCK_S - (R.simClock - R.firstFinishAt)));
  }
  let standing = null;
  if (S.standings && S.standings.length) {
    const row = S.standings.find((x) => x.slot === p.slot);
    if (row) standing = { place: row.place, points: row.points };
  }
  return {
    slot: p.slot, color: slotInfo(p.slot).css, isHost: p.slot === host,
    step: p.ready ? 'done' : p.step,
    choice: { char: p.char, body: p.body, wheels: p.wheels, assist: p.assist },
    ratings: choiceRatings(p),
    race, standing,
  };
}

/** The desktop menus' snapshot (shared state + display extras). */
function menuView() {
  const sh = sharedState();
  const host = sh.host;
  const kbp = [...S.players.values()].find((p) => p.kb) || null;
  return {
    ...sh,
    screen: S.screen,
    settings: settingsText(),
    kb: S.kb,
    kbIsHost: !!kbp && kbp.slot === host,
    podium: S.podium,
    players: playersSorted().map((p) => {
      const def = charById(p.char);
      return {
        slot: p.slot, color: slotInfo(p.slot).css, connected: p.connected, ready: p.ready, step: p.step,
        char: def ? def.id : null, body: p.body, wheels: p.wheels, assist: p.assist,
        isHost: p.slot === host, kb: !!p.kb,
        name: def ? def.name : '', cssColor: def ? def.cssColor : '#8890b5',
        bodyLabel: getBody(p.body).label, wheelsLabel: getWheels(p.wheels).label,
        ratings: choiceRatings(p), img: def && !isCustomDef(def) ? `img/racers/${def.id}.png` : '',
      };
    }),
  };
}

let syncQueued = false;
/** Push the state to the menus and every phone (coalesced to once per frame). */
function syncAll() {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(flushSync);
}

function flushSync() {
  syncQueued = false;
  if (!menus) return;
  // mid-race the big screen shows HUDs only: the menus need no snapshot
  if (S.screen !== 'race') menus.update(menuView());
  if (!phone) return;
  phone.sendState(sharedState());
  for (const p of S.players.values()) if (!p.kb) phone.sendPadState(p.slot, padState(p));
}

// Item cues of one human for the phone (padState.race) and its change key.
function raceFx(h) {
  const r = R, k = h.kart;
  if (!r || k.finished) return { warn: null, splash: 0, beer: false };
  const capo = typeof k.capoWarn === 'number' ? k.capoWarn > 0 : r.capo.target === k;
  let splash = 0;
  if (typeof k.ink === 'number') splash = k.ink > 0 ? Math.round(clamp(k.ink, 0.05, 1) * 20) / 20 : k.inkIncoming ? 0.05 : 0;
  else splash = h.inkUntil > r.simClock ? 1 : h.inkIncoming ? 0.05 : 0;
  return { warn: capo ? 'capo' : null, splash, beer: k.beer !== undefined ? !!k.beer : r.beer.has(k) };
}

// All phone-visible race fields of one human packed into one number.
function phoneRaceKey(h) {
  const k = h.kart, rc = R.race;
  const st = rc ? (RACE_STATE_INDEX[rc.state] ?? 2) : 2;
  const cd = rc && rc.state === 'countdown' ? Math.ceil(rc.countdown || 0) : 0;
  const item = k.item ? ITEM_IDS.indexOf(k.item) + 1 : 0;
  let x = st;
  x = x * 32 + clamp(k.lap | 0, 0, 31);
  x = x * 32 + clamp(k.place | 0, 0, 31);
  x = x * 32 + item;                           // 17 item ids (SPEC §15.2)
  x = x * 8 + clamp(k.itemCount | 0, 0, 7);
  x = x * 2 + (k.rolling ? 1 : 0);
  x = x * 8 + clamp(cd, 0, 7);
  x = x * 2 + (k.finished ? 1 : 0);
  x = x * 2 + ((k.assist || 0) > 0.05 ? 1 : 0);
  x = x * 2 + (h.ai && !h.auto ? 1 : 0);
  x = x * 16 + clamp(k.coins | 0, 0, 15);      // v5 lire
  const fx = raceFx(h);
  x = x * 8 + (fx.warn ? 4 : 0) + (fx.splash > 0 ? 2 : 0) + (fx.beer ? 1 : 0);
  return x;
}

// Race fields go to the phones the moment one changes, plus a refresh at NET.hostStateHz.
function syncRacePhones(r, dt) {
  r.phoneTimer = (r.phoneTimer || 0) - dt;
  let changed = false;
  for (let i = 0; i < r.humans.length; i++) {
    const h = r.humans[i];
    const key = phoneRaceKey(h);
    if (key !== h.phoneKey) { h.phoneKey = key; changed = true; }
  }
  if (changed || r.phoneTimer <= 0) {
    r.phoneTimer = 1 / PHONE_SYNC_HZ;
    syncAll();
  }
}

function wirePhone() {
  phone.on('join', (e) => onPhoneJoin(e));
  phone.on('leave', (e) => onPhoneLeave(e));
  phone.on('slots', () => { computeHost(); syncAll(); });
  phone.on('menu', (m) => { if (m && typeof m.action === 'string') onMenu(Number(m.slot), m.action, m, 'phone'); });
  phone.on('info', (info) => { menus.setPhone({ status: 'online', ...info }); syncAll(); });
  phone.on('status', (s) => {
    if (s && s.socketConnected === false) menus.setPhone({ status: 'connecting' });
    else if (phone.room) menus.setPhone({ status: 'online' });
  });
}

// =============================================================== 14. render + loop

let lastT = -1;
let hintTimer = 0;
let releaseTimer = 0;
const _camList = [];
const _focus = new THREE.Vector3();

function loop(t) {
  requestAnimationFrame(loop);
  let dt = lastT < 0 ? 0 : (t - lastT) / 1000;
  lastT = t;
  if (!(dt > 0)) dt = 0;
  if (dt > PHYS.maxFrameDt) dt = PHYS.maxFrameDt;
  frame(dt);
}

// CPU time of frame() (simulation + scene update + render submission), smoothed.
const frameCost = { ms: 0, max: 0 };
const fpsMeter = { frames: 0, t: 0, fps: 0 };

// Desktop keyboard: Esc / P pause or resume any race; the menus handle
// keyboard mode (and "Enter on the lobby" to start it).
function handleDesktopInput() {
  if (S.screen === 'race') {
    if (input.pausePressed && !menus.helpOpen) { if (S.paused) resume(null); else pause(null); }
    else if (S.paused) menus.handleNav(input.menu);
    return;
  }
  if (S.screen !== 'boot' && S.screen !== 'loading') menus.handleNav(input.menu);
}

function frame(dt) {
  const t0 = performance.now();
  input.update(dt);
  handleDesktopInput();
  releaseTimer -= dt;
  if (releaseTimer <= 0) { releaseTimer = 1; releaseStalePlayers(); }

  const sc = S.screen;
  if (R) raceFrame(dt);
  const r = R;
  const raceCams = r && sc === 'race';
  if (sc === 'podium' && podium) {
    podium.update(dt);
    podium.applyCamera(camera);
    _focus.copy(podium.center);
  } else if (r && (sc === 'results' || sc === 'standings')) {
    _focus.copy(menuChase.target ? menuChase.target.position : r.karts[0].position);
  } else if (raceCams) {
    _focus.copy(r.views[0].h ? r.views[0].h.kart.position : r.karts[0].position);
  } else {
    attract.update(dt);
    _focus.copy(attract.focus);
  }
  // hazards run on the race clock inside a race (substeps); in the menus /
  // podium they just keep animating in real time
  if (!(r && (sc === 'race' || sc === 'results' || sc === 'standings'))) {
    const hz = worldHazards();
    if (hz) { try { hz.update(dt); } catch (err) { if (!frame.hzWarned) { frame.hzWarned = true; console.warn('[main] hazards.update failed', err); } } }
  }
  _camList.length = 0;
  if (raceCams) for (let i = 0; i < r.views.length; i++) _camList.push(r.views[i].cam);
  else _camList.push(camera);
  effects.update(S.paused ? 0 : dt, _camList);
  world.update(dt, _focus, _camList[0]);

  hintTimer -= dt;
  if (hintTimer <= 0) {
    hintTimer = 0.4;
    menus.setSoundHint(!audio.ready && sc !== 'boot');
  }
  render();
  const cost = performance.now() - t0;
  frameCost.ms += (cost - frameCost.ms) * 0.05;
  frameCost.max = Math.max(frameCost.max * 0.995, cost);
  fpsMeter.frames++;
  fpsMeter.t += dt;
  if (fpsMeter.t >= 1) { fpsMeter.fps = fpsMeter.frames / fpsMeter.t; fpsMeter.frames = 0; fpsMeter.t = 0; }
}

// Split-screen: the intro flyover is one shared shot, so it plays full-screen
// through view 0's camera (the views split at the countdown).
function setIntroFull(r, on) {
  if (r.introFull === on) return;
  r.introFull = on;
  const v = r.views[0];
  v.cam.aspect = on ? window.innerWidth / Math.max(1, window.innerHeight) : v.rect.w / Math.max(1, v.rect.h);
  v.cam.updateProjectionMatrix();
}

function render() {
  const r = R;
  const W = window.innerWidth, H = window.innerHeight;
  if (r && S.screen === 'race') {
    const n = r.views.length;
    if (n > 1) setIntroFull(r, !!r.race && r.race.state === 'intro');
    if (n === 1 || r.introFull) {
      renderer.setViewport(0, 0, W, H);
      renderer.render(scene, r.views[0].cam);
      return;
    }
    renderer.setScissorTest(true);
    for (let i = 0; i < n; i++) {
      const v = r.views[i], rc = v.rect;
      const y = H - rc.y - rc.h;            // WebGL viewports start bottom-left
      renderer.setViewport(rc.x, y, rc.w, rc.h);
      renderer.setScissor(rc.x, y, rc.w, rc.h);
      if (i > 0) world.update(0, v.h ? v.h.kart.position : _focus, v.cam);
      const own = v.h ? v.h.kart : null;
      for (let j = 0; j < r.humanKvs.length; j++) r.humanKvs[j].setForeignView(r.humanKvs[j].kart !== own);
      renderer.render(scene, v.cam);
    }
    for (let j = 0; j < r.humanKvs.length; j++) r.humanKvs[j].setForeignView(false);
    const q = r.layout && r.layout.shared;
    if (q && q.kind === 'quad') {
      // 3P: the 4th quadrant is the standings panel (DOM) — just clear it
      const y = H - q.y - q.h;
      renderer.setViewport(q.x, y, q.w, q.h);
      renderer.setScissor(q.x, y, q.w, q.h);
      renderer.setClearColor(0x120a2e, 1);
      renderer.clear(true, true, false);
      renderer.setClearColor(0x000000, 1);
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    return;
  }
  renderer.setViewport(0, 0, W, H);
  renderer.render(scene, camera);
}

// =============================================================== 15. debug handle

window.__game = {
  get state() { return S.screen; },
  get screen() { return S.screen; },
  get paused() { return S.paused; },
  get pausedBy() { return S.pausedBy; },
  get mode() { return S.mode; },
  get cc() { return S.cc; },
  get items() { return S.items; },
  get host() { return computeHost(); },
  get keyboard() { return S.kb; },
  get raceNo() { return S.raceNo; },
  get trackId() { return S.trackId; },
  get trackPick() { return S.trackPick; },
  /** GP cup of this set { id, name, tracks } and every cup (SPEC §15.3). */
  get cup() { const c = curCup(); return { id: c.id, name: c.name, tracks: c.tracks.slice() }; },
  get cups() { return CAT.cups.map((c) => ({ id: c.id, name: c.name, tracks: c.tracks.slice() })); },
  /** The live race's track hazards (null on tracks without any). */
  get hazards() { return R ? R.hazards : worldHazards(); },
  get track() { return track; },
  get world() { return world; },
  get players() { return playersSorted().map((p) => ({ ...p })); },
  get results() { return S.results; },
  get standings() { return S.standings; },
  get podium() { return S.podium; },
  get race() { return R ? R.race : null; },
  get karts() { return R ? R.karts : []; },
  get timeScale() { return S.timeScale; },
  /** Humans of the live race: slot, kart + loadout, assist, CPU stand-in. */
  get humans() {
    return R ? R.humans.map((h) => ({
      slot: h.slot, kb: h.kb, kartId: h.kart.id, char: h.kart.character && h.kart.character.id,
      body: h.kart.loadout && h.kart.loadout.body, wheels: h.kart.loadout && h.kart.loadout.wheels,
      steerAssist: !!h.kart.steerAssist, ccMult: h.kart.ccMult, kartSlot: h.kart.slot, isPlayer: !!h.kart.isPlayer,
      ai: !!h.ai, auto: !!h.auto, finished: !!h.kart.finished, place: h.kart.place, grid: R.karts.indexOf(h.kart),
    })) : [];
  },
  /** Grid of the live race: [{ id, char, human slot | null, loadout }]. */
  get grid() {
    return R ? R.karts.map((k) => ({ id: k.id, char: k.character && k.character.id, slot: k.slot ?? null, body: k.loadout && k.loadout.body, wheels: k.loadout && k.loadout.wheels, ccMult: k.ccMult })) : [];
  },
  get views() { return R ? R.views.map((v) => ({ slot: v.h ? v.h.slot : null, rect: { ...v.rect }, fov: v.chase.params.baseFov, aspect: v.cam.aspect })) : []; },
  get layout() { return R ? R.layout : null; },
  /** A pad:menu action as if sent by that slot's phone (or the keyboard player). */
  action(slot, name, payload = {}) { onMenu(Number(slot), name, payload, 'debug'); return S.screen; },
  desktop(name, payload = {}) { onDesktopAction(name, payload); return S.screen; },
  kbJoin() { return startKeyboardMode(); },
  setTimeScale(x) { S.timeScale = clamp(Number(x) || 1, 0, 16); return S.timeScale; },
  /** Tests: the same CPU field + presets for every following set (null = random again). */
  pinSeed(seed = null) { S.pinnedSeed = seed === null ? null : Number(seed) >>> 0; return S.pinnedSeed; },
  skipIntro,
  /** Tests: CPU drivers for every human kart (on), or hand the karts back (off). */
  autopilot(on = true, slot = null) {
    if (!R) return false;
    const list = R.humans.filter((h) => slot === null || h.slot === Number(slot));
    for (const h of list) {
      if (on) takeOver(h, true);
      else if (h.ai && !h.kart.finished) { h.auto = false; handBack(h); }
    }
    return list.length > 0 && list.every((h) => !!h.ai === !!on);
  },
  /** Tests: jump to the results now (live classification). */
  endRace() { if (R && S.screen === 'race') goResults(); return S.screen; },
  sharedState: () => sharedState(),
  padState: (slot) => { const p = S.players.get(Number(slot)); return p ? padState(p) : null; },
  stats() {
    const i = renderer.info;
    return {
      calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures,
      programs: i.programs ? i.programs.length : 0, frameCpuMs: +frameCost.ms.toFixed(2), frameCpuMaxMs: +frameCost.max.toFixed(2),
      fps: +fpsMeter.fps.toFixed(1), pixelRatio: renderer.getPixelRatio(), views: R ? R.views.length : 0,
      quality: world ? world.quality : null, effectsIntensity: effects ? effects.intensity : 1, blobs: blobs ? blobs.mesh.count : 0,
    };
  },
  /** Leak probe: GPU resources, scene graph size, bus listeners, HUD DOM nodes. */
  leaks() {
    let listeners = 0;
    for (const list of bus._map.values()) listeners += list.length;
    let objects = 0;
    scene.traverse(() => { objects++; });
    return {
      geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
      sceneChildren: scene.children.length, objects, listeners, huds: hudRoot.querySelectorAll('.hud').length,
    };
  },
  modules: RaceMods,
  bus,
  get portraits() { return { pending: portraits.pending, rendered: portraits.rendered }; },
  get menus() { return menus; },
  get phone() { return phone; },
  get audio() { return audio; },
  get renderer() { return renderer; },
  get scene() { return scene; },
  get camera() { return camera; },
  get input() { return input; },
  get effects() { return effects; },
  get sharedHud() { return sharedHud; },
  get R() { return R; },
  title: GAME_TITLE,
};

boot().catch((err) => {
  console.error('[main] boot failed', err);
  if (!document.querySelector('.tk-fatal')) {
    showFatal(menusRoot, `${GAME_TITLE} failed to start`, String(err && err.message || err));
  }
});
