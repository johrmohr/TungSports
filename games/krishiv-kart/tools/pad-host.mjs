// Fake desktop "host" for testing the phone controller (public/pad.html)
// without the full game (SPEC §14.5–14.8). It hosts a room through the real
// PhoneLink (public/js/net.js) and runs a small but complete v3 game: lobby
// (host sets mode / class / items, START), per-phone select steps
// (char → body → wheels → ready → done), the host's track screen, a timed
// race per slot (places, laps, items, Steer Assist pip), pause / resume,
// results → standings → (next race | podium) → lobby, with host-only actions
// enforced like the desktop does. Shared state and per-slot pad states follow
// SPEC §14.7 exactly. It logs everything the phones send and exposes an HTTP
// control API so scripted browser tests can force screens and read back what
// the host received.
//
// The roster is the 12-racer cast of SPEC §14.1 (the real characters.js when
// it exports that cast, else the built-in table below) + one custom racer;
// bodies / wheels / ratings come from parts.js.
//
//   node tools/pad-host.mjs [--url http://localhost:3100] [--room PADS] [--control 3198]
//
// Control API (GET, JSON responses):
//   /state?screen=lobby|select|track|loading|race|paused|results|standings|podium
//          [&slot=2][&step=char|body|wheels|ready|done]
//          [&race=intro|countdown|racing|finished|auto][&item=rocket][&rolling=1]
//          [&count=3][&place=2][&lap=2][&finished=1][&assistActive=1][&mode=vs]   force a screen
//          [&warn=capo|][&splash=0.8][&beer=1|0][&cup=krishiv]                     (v4 race alerts, GP cup)
//          [&coins=7]                                                               (v5 lire)
//   /log                      { last, lastBySlot, edges, menus, counts }
//   /clear                    clear the logs
//   /event?type=vibrate&pattern=40,30,40[&slot=2]   |   /event?type=toast&text=Hi
//   /leave                    disconnect the host (phones show "waiting for the game")
//   /join                     reconnect and reclaim the room
//   /release                  free the slots of phones that left
//
// Also importable: `const host = await startFakeHost({ url, room })`, and the
// roster / catalog helpers used by tools/test-net.mjs.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import {
  WEIGHT_GROUPS, KART_BODIES, WHEELS, PLAYER_SLOTS, MAX_PLAYERS, DEFAULT_CC, ENGINE_CLASSES,
  computeRatings, pointsFor, slotInfo, CUSTOM_GROUP_FOR_CLASS,
} from '../public/js/parts.js';
import { ITEM_IDS, ITEM_INFO } from '../public/js/config.js';

// ---------------------------------------------------------------- roster

// SPEC §14.1 (grid order: Light, Medium, Heavy rows of 4).
const BUILTIN_CAST = [
  ['ballerina', 'Farfallina Farfallona', 'Farfallina', 'L1', '#8A5CF6', '#F2D27A', 'Bow-tie wings, big dreams!'],
  ['cappuccino', 'Gufetto Cialdino', 'Gufetto', 'L1', '#B7D98B', '#D9A15C', 'Hoo-hoo, coming through!'],
  ['trippi', 'Rotolino Fritolino', 'Rotolino', 'L2', '#E7A33E', '#C77C25', 'Roll it, fry it, fly it!'],
  ['chimpanzini', 'Criceto Calzonetto', 'Criceto', 'L2', '#E3A86B', '#D9472B', 'Snug as a bug, fast as a rug!'],
  ['sahur', 'Tung Tung Tung Sahur', 'Ruggero', 'M2', '#E9B949', '#C8742A', 'Roar-o! Sugar on top, never stop!'],
  ['tralalero', 'Ronzella Cannoletta', 'Ronzella', 'M2', '#FFC93C', '#1E1E24', 'Buzz-buzz, cream of the crop!'],
  ['bananita', 'Pecorino Gnocchino', 'Pecorino', 'M1', '#F3DFA2', '#2F6BFF', 'Baa-baa, see you at the finish!'],
  ['lirili', 'Pavone Carnevalone', 'Pavone', 'M1', '#1FA3A3', '#7B4BC9', 'Masks on, eyes on the prize!'],
  ['patapim', 'Lamapisa Pendolina', 'Lamapisa', 'H1', '#C99F73', '#F3EFE6', 'Lean in and win!'],
  ['saturnita', 'Ippolino Mandolino', 'Ippolino', 'H1', '#8C9AA6', '#D49A5B', 'Strum-strum, here I come!'],
  ['bombardiro', 'Tricheco Fornaccio', 'Tricheco', 'H2', '#C2603A', '#FFB347', 'Hot from the oven, too fast to catch!'],
  ['gusini', 'Colosseo Bulldoggo', 'Colosseo', 'H2', '#E6D3A8', '#4F8A3C', 'Built to last, born to blast!'],
].map(([id, name, shortName, group, cssColor, accent, catchphrase]) => ({
  id, name, shortName, group, weightClass: WEIGHT_GROUPS[group].weightClass, ratings: { ...WEIGHT_GROUPS[group].ratings },
  cssColor, accent, catchphrase, tagline: '', lead: id === 'sahur',
}));

// A user-supplied .glb racer (SPEC §14.9): a "Custom" row on the phones.
export const FAKE_CUSTOM = {
  id: 'custom_robo', name: 'Robo Rex', shortName: 'Robo Rex', group: CUSTOM_GROUP_FOR_CLASS.medium, weightClass: 'medium',
  ratings: { ...WEIGHT_GROUPS[CUSTOM_GROUP_FOR_CLASS.medium].ratings }, cssColor: '#3fd6b2', accent: '#1a6b5a', custom: true,
};

// The 12-racer v3 cast: the real characters.js when it already has it (SPEC
// §14.1), else the built-in table (the CAST work may be in progress).
export async function loadRoster() {
  try {
    const chars = await import('../public/js/characters.js');
    const list = chars.CHARACTERS;
    if (Array.isArray(list) && list.length === 12 && list.some((c) => c.id === 'sahur') &&
      list.every((c) => typeof c.cssColor === 'string' && c.ratings && c.weightClass)) {
      return list.map((c) => ({ ...c, ratings: { ...c.ratings } }));
    }
  } catch { /* characters.js mid-edit: use the built-in cast */ }
  return BUILTIN_CAST.map((c) => ({ ...c, ratings: { ...c.ratings } }));
}

// host:state.characters entries (SPEC §14.7) for roster defs (+ custom ones).
// (characters.js keeps THREE hex numbers in color / accent and CSS strings
// in cssColor / accentCss; the phones get the CSS ones.)
export function charactersForState(defs) {
  return defs.map((d) => ({
    id: d.id, name: d.name, shortName: d.shortName || d.name, weightClass: d.weightClass, cssColor: d.cssColor,
    accent: d.accentCss || (typeof d.accent === 'string' ? d.accent : d.cssColor), ratings: { ...d.ratings },
    img: d.custom ? null : `/img/racers/${d.id}.png`, custom: d.custom === true, catchphrase: d.catchphrase || '', tagline: d.tagline || '',
  }));
}

export const bodiesForState = () => KART_BODIES.map((b) => ({ id: b.id, label: b.label, desc: b.desc, mods: { ...b.mods } }));
export const wheelsForState = () => WHEELS.map((w) => ({ id: w.id, label: w.label, desc: w.desc, mods: { ...w.mods }, offroad: w.offroad }));

const FALLBACK_TRACKS = [{ id: 'breezy', name: 'Breezy Bay Circuit' }, { id: 'monte', name: 'Monte Mozzarella' }];

// Track list: the real registry (every course, menu order, with themes), else
// the two v3 tracks.
async function loadTracks() {
  try {
    const tracks = await import('../public/js/tracks.js');
    const out = tracks.TRACK_LIST.map((t) => { const i = tracks.trackInfo(t.id); return { id: i.id, name: i.name || i.id, ...(i.theme ? { theme: i.theme } : {}) }; });
    if (out.length) return out;
  } catch { /* fallback */ }
  return FALLBACK_TRACKS.map((t) => ({ ...t }));
}

// Grand Prix cups (SPEC §15.3): tracks.js CUPS, else one cup of every track.
async function loadCups(tracks) {
  try {
    const mod = await import('../public/js/tracks.js');
    if (Array.isArray(mod.CUPS) && mod.CUPS.length) {
      return mod.CUPS.map((c) => ({ id: c.id, name: c.name, tracks: c.tracks.filter((id) => tracks.some((t) => t.id === id)) }));
    }
  } catch { /* fallback */ }
  return [{ id: 'gelato', name: 'Gelato Cup', tracks: tracks.map((t) => t.id) }];
}

// ---------------------------------------------------------------- fake host

// Every item config knows (SPEC §15.2 adds the v4 set); triples hold 3 uses.
const ITEMS = [...new Set([...ITEM_IDS, ...Object.keys(ITEM_INFO)])].filter((id) => ITEM_INFO[id]);
const usesOf = (id) => Math.max(1, Number(ITEM_INFO[id] && ITEM_INFO[id].uses) || (/^triple_/.test(id) ? 3 : 1));
const LAPS = 3;
const INTRO_S = 1.2;
const COUNTDOWN_S = 3;
const LAP_S = 14;
const LOADING_S = 0.6;
const HOST_ONLY = new Set(['mode', 'cc', 'items', 'start', 'track', 'cup', 'go', 'next', 'quit', 'restart']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal Web Storage stand-in (each fake host = one desktop browser tab).
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false });
}

export async function startFakeHost({ url = 'http://localhost:3100', room = 'PADS', quiet = false, custom = true } = {}) {
  const roster = await loadRoster();
  const defs = custom ? [...roster, FAKE_CUSTOM] : roster;
  const defById = new Map(defs.map((d) => [d.id, d]));
  const characters = charactersForState(defs);
  const bodies = bodiesForState();
  const wheels = wheelsForState();
  const tracks = await loadTracks();
  const cups = await loadCups(tracks);
  const log = (...a) => { if (!quiet) console.log(`[host ${new Date().toISOString().slice(11, 23)}]`, ...a); };

  // ---- PhoneLink in this process (its own "tab" storage, pre-seeded with the room code)
  const session = memoryStorage();
  session.setItem('krishivkart.host.room', JSON.stringify({ room, key: '' }));
  setGlobal('sessionStorage', session);
  setGlobal('localStorage', memoryStorage());
  setGlobal('io', (opts) => ioClient(url, { ...opts, forceNew: true, transports: ['websocket'] }));
  const { PhoneLink } = await import('../public/js/net.js');
  const link = new PhoneLink();

  // ---- game state
  const g = {
    screen: 'lobby', mode: 'gp', cc: DEFAULT_CC, items: true, raceNo: 0, races: 2,
    cup: cups[0].id,                   // GP cup (host's pick on the track screen)
    track: null,                       // VS pick (null = not picked yet)
    trackId: tracks[0].id,             // track of the current / last race
    pausedBy: null,
    loadingUntil: 0,
    race: { state: null, t0: 0, auto: true, pausedAt: 0 },
    results: null, standings: null,
  };
  /** slot → player */
  const players = new Map();
  const logs = { last: null, lastBySlot: {}, edges: [], menus: [], counts: { input: 0, menu: 0, join: 0, leave: 0, rejected: 0 } };
  const lastSeq = new Map();           // slot → { i, p }

  const now = () => Date.now() / 1000;
  const isHost = (slot) => slot === link.host;

  function newPlayer(slot) {
    return {
      slot, step: 'char', ready: false, points: 0, lastPlace: 0,
      choice: { char: 'sahur', body: 'standard', wheels: 'standard', assist: true },
      // race view of this slot
      r: { place: 8, lap: 1, item: null, itemCount: 0, rolling: false, rollEnd: 0, nextItemAt: 0, finished: false, finishedAt: 0, assistActive: false, assistForced: null, warn: null, splash: 0, beer: false },
    };
  }

  const connectedPlayers = () => [...players.values()].filter((p) => link.players.get(p.slot)?.connected);

  function resetSelect() {
    for (const p of players.values()) { p.step = 'char'; p.ready = false; }
  }

  function maybeAllReady() {
    const list = connectedPlayers();
    if (g.screen === 'select' && list.length && list.every((p) => p.ready)) {
      g.screen = 'track';
      g.track = g.mode === 'vs' ? g.track : null;
    }
  }

  function startRace() {
    g.screen = 'loading';
    g.loadingUntil = now() + LOADING_S;
    g.pausedBy = null;
    g.results = null;
    const r = g.race;
    r.state = 'intro'; r.t0 = g.loadingUntil; r.auto = true;
    let k = 0;
    for (const p of players.values()) {
      Object.assign(p.r, { place: 8 - k, lap: 1, item: null, itemCount: 0, rolling: false, finished: false, assistActive: false, assistForced: null, warn: null, splash: 0, beer: false });
      p.r.nextItemAt = INTRO_S + COUNTDOWN_S + 2.5 + k * 0.4;
      k++;
    }
  }

  function elapsed() {
    return (g.screen === 'paused' ? g.race.pausedAt : now()) - g.race.t0;
  }

  // 8 racers: the humans (by slot) among CPUs from the roster.
  function finishRace() {
    const humans = [...players.values()].sort((a, b) => a.r.place - b.r.place);
    const cpus = roster.filter((d) => !humans.some((h) => h.choice.char === d.id)).slice(0, 8 - humans.length);
    const field = [];
    let hi = 0;
    let ci = 0;
    for (let place = 1; place <= 8; place++) {
      const h = humans[hi];
      if (h && (h.r.place <= place || ci >= cpus.length)) { field.push({ human: h }); hi++; } else field.push({ cpu: cpus[ci++] });
    }
    g.results = field.map((e, k) => {
      const place = k + 1;
      const pts = pointsFor(place, 8);
      if (e.human) {
        const d = defById.get(e.human.choice.char) || roster[0];
        e.human.points += pts;
        e.human.lastPlace = place;
        return { place, name: d.shortName || d.name, cssColor: d.cssColor, time: 98.512 + k * 1.731, points: pts, slot: e.human.slot, finished: true };
      }
      return { place, name: e.cpu.shortName || e.cpu.name, cssColor: e.cpu.cssColor, time: 98.512 + k * 1.731, points: pts, slot: null, finished: k < 7 };
    });
    // Standings: humans' totals + CPU totals (CPUs accumulate their race points too).
    const totals = new Map();
    for (const row of g.results) {
      const key = row.slot ? `p${row.slot}` : row.name;
      const prev = g.standings?.find((s) => (s.slot ? `p${s.slot}` : s.name) === key);
      totals.set(key, { name: row.name, cssColor: row.cssColor, slot: row.slot, points: (prev ? prev.points : 0) + row.points, last: row.place });
    }
    g.standings = [...totals.values()].sort((a, b) => b.points - a.points || a.last - b.last)
      .map((s, k) => ({ place: k + 1, name: s.name, cssColor: s.cssColor, points: s.points, slot: s.slot }));
    g.screen = 'results';
    g.race.state = null;
  }

  // Advances the timed race (auto mode) for every slot.
  function tickRace() {
    if (g.screen === 'loading' && now() >= g.loadingUntil) g.screen = 'race';
    if (g.screen !== 'race' || !g.race.auto) return;
    const t = elapsed();
    const r = g.race;
    if (t < INTRO_S) r.state = 'intro';
    else if (t < INTRO_S + COUNTDOWN_S) r.state = 'countdown';
    else r.state = 'racing';
    if (r.state !== 'racing') return;
    const rt = t - INTRO_S - COUNTDOWN_S;
    let k = 0;
    let allDone = true;
    for (const p of players.values()) {
      const pr = p.r;
      if (!pr.finished) {
        pr.lap = Math.min(LAPS, 1 + Math.floor(rt / LAP_S));
        pr.place = Math.max(1 + k, 8 - k - Math.floor(rt / 3.5));
        if (!pr.item && !pr.rolling && t >= pr.nextItemAt) { pr.rolling = true; pr.rollEnd = t + 2; }
        if (pr.rolling && t >= pr.rollEnd) {
          pr.rolling = false;
          pr.item = ITEMS[(Math.floor(t * 7) + k) % ITEMS.length];
          pr.itemCount = usesOf(pr.item);
        }
        // Steer Assist pip: on for 0.6 s of every 2 s while assisted.
        pr.assistActive = pr.assistForced ?? (p.choice.assist && (rt % 2) < 0.6);
        if (rt >= LAPS * LAP_S) { pr.finished = true; pr.finishedAt = t; }
      }
      if (!pr.finished || t - pr.finishedAt < 3) allDone = false;
      k++;
    }
    if (allDone && players.size) finishRace();
  }

  // ---- outgoing states (SPEC §14.7)

  function trackRef(id) {
    const t = tracks.find((x) => x.id === id);
    return t ? { id: t.id, name: t.name } : null;
  }
  const curCup = () => cups.find((c) => c.id === g.cup) || cups[0];
  const cupRef = (c) => ({ id: c.id, name: c.name, tracks: c.tracks.map((id) => trackRef(id) || { id, name: id }) });

  function buildShared() {
    const list = [...players.values()].sort((a, b) => a.slot - b.slot);
    return {
      screen: g.screen, mode: g.mode, cc: g.cc, items: g.items, host: link.host, raceNo: g.raceNo, races: g.mode === 'gp' ? curCup().tracks.length : g.races,
      track: g.screen === 'track' ? (g.mode === 'gp' ? trackRef(curCup().tracks[0]) : g.track ? trackRef(g.track) || { id: 'random', name: 'Random' } : null) : trackRef(g.trackId),
      tracks: tracks.map((t) => ({ ...t })),
      cup: cupRef(curCup()),
      cups: cups.map(cupRef),
      players: list.map((p) => ({
        slot: p.slot, color: slotInfo(p.slot).css, connected: !!link.players.get(p.slot)?.connected, ready: p.ready,
        char: p.choice.char, body: p.choice.body, wheels: p.choice.wheels, assist: p.choice.assist, step: p.step,
      })),
      characters, bodies, wheels,
      results: g.screen === 'results' ? g.results : null,
      standings: g.screen === 'standings' || g.screen === 'podium' ? g.standings : null,
      ...(g.screen === 'paused' && g.pausedBy ? { pausedBy: g.pausedBy } : {}),
    };
  }

  function buildPadState(p) {
    const inRace = g.screen === 'race' || g.screen === 'paused' || g.screen === 'loading';
    const t = elapsed();
    const pr = p.r;
    const def = defById.get(p.choice.char) || roster[0];
    const standing = g.standings?.find((s) => s.slot === p.slot);
    return {
      slot: p.slot, color: slotInfo(p.slot).css, isHost: isHost(p.slot), step: p.step,
      choice: { ...p.choice },
      ratings: computeRatings(def, p.choice),
      race: inRace && g.race.state ? {
        state: pr.finished ? 'finished' : g.race.state, lap: pr.lap, laps: LAPS, place: pr.place, racers: 8,
        item: pr.item, itemCount: pr.itemCount, rolling: pr.rolling,
        countdown: g.race.state === 'countdown' ? Math.max(0, Math.round((INTRO_S + COUNTDOWN_S - t) * 100) / 100) : 0,
        finished: pr.finished, assist: p.choice.assist, assistActive: !!(p.choice.assist && (pr.assistForced ?? pr.assistActive)),
        ...(pr.warn ? { warn: pr.warn } : {}), ...(pr.splash > 0 ? { splash: pr.splash } : {}), ...(pr.beer ? { beer: true } : {}),
        coins: pr.coins | 0,                                     // v5 lire (main.js padState race.coins)
      } : null,
      standing: standing ? { place: standing.place, points: standing.points } : null,
    };
  }

  function sendState() {
    tickRace();
    link.sendState(buildShared());
    for (const p of players.values()) link.sendPadState(p.slot, buildPadState(p));
  }

  // ---- incoming

  function onMenu(m) {
    logs.menus.push({ ...m, at: Date.now() });
    logs.counts.menu++;
    log('menu', JSON.stringify(m));
    const p = players.get(m.slot);
    if (!p) return;
    if (HOST_ONLY.has(m.action) && !isHost(m.slot)) { logs.counts.rejected++; return; }
    const knownId = (list, id) => list.some((x) => x.id === id);
    switch (m.action) {
      case 'mode': if (g.screen === 'lobby') g.mode = m.value; break;
      case 'cc': if (g.screen === 'lobby' && ENGINE_CLASSES.some((e) => e.id === m.value)) g.cc = m.value; break;
      case 'items': if (g.screen === 'lobby') g.items = m.value; break;
      case 'start': if (g.screen === 'lobby') { g.screen = 'select'; g.raceNo = 0; g.standings = null; for (const x of players.values()) x.points = 0; resetSelect(); } break;
      case 'char': if (g.screen === 'select' && p.step === 'char' && defById.has(m.id)) { p.choice.char = m.id; p.step = 'body'; } break;
      case 'body': if (g.screen === 'select' && p.step === 'body' && knownId(bodies, m.id)) { p.choice.body = m.id; p.step = 'wheels'; } break;
      case 'wheels': if (g.screen === 'select' && p.step === 'wheels' && knownId(wheels, m.id)) { p.choice.wheels = m.id; p.step = 'ready'; } break;
      case 'back':
        if (g.screen === 'select') {
          if (p.step === 'body') p.step = 'char';
          else if (p.step === 'wheels') p.step = 'body';
          else if (p.step === 'ready') p.step = 'wheels';
          else if (p.step === 'done') { p.step = 'ready'; p.ready = false; }
          else if (p.step === 'char' && isHost(p.slot)) g.screen = 'lobby';
        } else if (g.screen === 'track' && isHost(p.slot)) {
          g.screen = 'select';
          p.step = 'ready';
          p.ready = false;
        }
        break;
      case 'ready':
        if (g.screen === 'select' && m.value && p.step === 'ready') { p.step = 'done'; p.ready = true; maybeAllReady(); }
        else if (g.screen === 'select' && !m.value && p.step === 'done') { p.step = 'ready'; p.ready = false; }
        break;
      case 'assist': p.choice.assist = m.value; break;
      case 'track':
        if (g.screen === 'track' && g.mode === 'vs' && (m.value === 'random' || trackRef(m.value))) g.track = m.value;
        break;
      case 'cup':
        if (g.screen === 'track' && g.mode === 'gp' && cups.some((c) => c.id === m.id)) g.cup = m.id;
        break;
      case 'go':
        if (g.screen === 'track') {
          g.raceNo = g.mode === 'gp' ? 1 : g.raceNo + 1;
          g.trackId = g.mode === 'gp' ? curCup().tracks[0] : g.track && g.track !== 'random' ? g.track : tracks[g.raceNo % tracks.length].id;
          startRace();
        }
        break;
      case 'pause': if (g.screen === 'race') { g.screen = 'paused'; g.race.pausedAt = now(); g.pausedBy = m.slot; } break;
      case 'resume': if (g.screen === 'paused') { g.race.t0 += now() - g.race.pausedAt; g.screen = 'race'; g.pausedBy = null; } break;
      case 'restart': if (g.screen === 'paused') startRace(); break;
      case 'quit': if (g.screen !== 'lobby') { g.screen = 'lobby'; g.race.state = null; resetSelect(); } break;
      case 'next':
        if (g.screen === 'results') g.screen = 'standings';
        else if (g.screen === 'standings') {
          if (g.mode === 'gp' && g.raceNo < curCup().tracks.length) { g.raceNo++; g.trackId = curCup().tracks[g.raceNo - 1]; startRace(); }
          else if (g.mode === 'gp') g.screen = 'podium';
          else { g.screen = 'track'; g.track = null; }
        } else if (g.screen === 'podium') { g.screen = 'lobby'; resetSelect(); }
        break;
      default: break;
    }
    sendState();
  }

  function onInput(inp) {
    logs.counts.input++;
    const p = { ...inp, at: Date.now() };
    const prev = logs.lastBySlot[inp.slot];
    logs.last = p;
    logs.lastBySlot[inp.slot] = p;
    const seq = lastSeq.get(inp.slot);
    const pl = players.get(inp.slot);
    // pauseSeq press = pause (anyone) / resume
    if (seq && inp.p > seq.p) {
      if (g.screen === 'race') onMenu({ slot: inp.slot, action: 'pause', via: 'pauseSeq' });
      else if (g.screen === 'paused') onMenu({ slot: inp.slot, action: 'resume', via: 'pauseSeq' });
    }
    if (seq && inp.i > seq.i && pl && pl.r.item) {
      pl.r.itemCount--;
      if (pl.r.itemCount <= 0) { pl.r.item = null; pl.r.itemCount = 0; pl.r.nextItemAt = elapsed() + 4; }
    }
    lastSeq.set(inp.slot, { i: inp.i, p: inp.p });
    if (!prev || prev.g !== inp.g || prev.b !== inp.b || prev.d !== inp.d || prev.i !== inp.i || prev.p !== inp.p) {
      logs.edges.push({ slot: inp.slot, s: inp.s, g: inp.g, b: inp.b, d: inp.d, i: inp.i, p: inp.p, at: Date.now() });
      if (logs.edges.length > 500) logs.edges.splice(0, 100);
      log('input edge', JSON.stringify(inp));
    }
  }

  link.on('join', ({ slot, padId, rejoin }) => {
    logs.counts.join++;
    log('join', slot, padId, rejoin ? '(rejoin)' : '');
    lastSeq.delete(slot);
    if (!players.has(slot) || !rejoin) {
      const p = newPlayer(slot);
      // Joining mid-flow: menus put the new player on the character screen.
      if (g.screen !== 'lobby') p.step = 'char';
      players.set(slot, p);
    }
    sendState();
  });
  link.on('leave', ({ slot, reason }) => {
    logs.counts.leave++;
    log('leave', slot, reason);
    if (reason === 'expired') players.delete(slot);
    maybeAllReady();
    sendState();
  });
  link.on('slots', () => sendState());
  link.on('menu', onMenu);
  link.on('input', (pl) => {
    const inp = pl.input;
    onInput({ slot: pl.slot, s: inp.steer, g: inp.gas, b: inp.brake, d: inp.drift, i: inp.itemSeq, p: inp.pauseSeq });
  });

  const info = await link.connect();
  log(`room ${info.room} ready — pad: ${info.padUrl}`);
  const ticker = setInterval(sendState, 100);   // 10 Hz (countdown precision); PhoneLink dedupes

  return {
    get info() { return info; },
    link,
    logs,
    game: g,
    players,
    roster,
    characters,
    tracks,
    cups,
    get host() { return link.host; },
    buildShared,
    buildPadState,
    sendState,
    // Forces a screen (and race details) for scripted tests. `slot` limits
    // per-player overrides (step, place, item, …) to one player.
    setScreen(q) {
      const targets = q.slot ? [players.get(Number(q.slot))].filter(Boolean) : [...players.values()];
      if (q.mode) g.mode = q.mode;
      if (q.cup && cups.some((c) => c.id === q.cup)) g.cup = q.cup;
      if (q.cc) g.cc = Number(q.cc);
      if (q.items !== undefined) g.items = q.items !== '0' && q.items !== false;
      const screen = q.screen || g.screen;
      if (screen === 'race' || screen === 'paused') {
        if (!g.race.state || q.race) {
          if (!g.race.state) { startRace(); g.loadingUntil = 0; }
          g.screen = 'race';
        }
        g.screen = screen;
        if (q.race) {
          g.race.auto = q.race === 'auto';
          if (q.race === 'auto') { g.race.t0 = now(); g.race.state = 'intro'; for (const p of players.values()) p.r.finished = false; }
          else {
            g.race.state = q.race === 'finished' ? 'racing' : q.race;
            g.race.t0 = now() - (q.race === 'countdown' ? INTRO_S + 0.2 : 0);
          }
        }
        if (q.auto === '0') g.race.auto = false;
        for (const p of targets) {
          const pr = p.r;
          if (q.item !== undefined) { pr.item = ITEMS.includes(q.item) ? q.item : null; pr.itemCount = pr.item ? Number(q.count) || usesOf(pr.item) : 0; }
          if (q.warn !== undefined) pr.warn = /^[a-z0-9_-]{1,32}$/.test(q.warn) ? q.warn : null;
          if (q.splash !== undefined) pr.splash = Math.max(0, Math.min(1, Number(q.splash) || 0));
          if (q.beer !== undefined) pr.beer = q.beer === '1' || q.beer === true;
          if (q.coins !== undefined) pr.coins = Math.max(0, Math.min(10, Number(q.coins) | 0));
          if (q.rolling !== undefined) pr.rolling = q.rolling === '1';
          if (q.place !== undefined) pr.place = Number(q.place);
          if (q.lap !== undefined) pr.lap = Number(q.lap);
          if (q.finished !== undefined) pr.finished = q.finished === '1';
          if (q.race === 'finished') pr.finished = true;
          if (q.assistActive !== undefined) pr.assistForced = q.assistActive === '' ? null : q.assistActive === '1';
        }
        if (screen === 'paused') { g.race.pausedAt = now(); g.pausedBy = Number(q.pausedBy) || g.pausedBy || 1; }
      } else {
        g.screen = screen;
        if (screen !== 'results' && screen !== 'loading') g.race.state = null;
        if (screen === 'loading') g.loadingUntil = now() + 3600;
        if ((screen === 'results' || screen === 'standings' || screen === 'podium') && !g.results) {
          for (const p of players.values()) p.r.place = p.slot + 1;
          finishRace();
          g.screen = screen;
        }
        if (screen === 'select' && q.step === undefined) resetSelect();
      }
      for (const p of targets) {
        if (q.step) { p.step = q.step; p.ready = q.step === 'done'; }
        if (q.char) p.choice.char = q.char;
        if (q.assist !== undefined) p.choice.assist = q.assist === '1';
      }
      sendState();
      return buildShared();
    },
    event(type, data, slot = null) { link.sendEvent(type, data, slot); },
    // Frees the slots of phones that left (what the desktop does after 20 s in the menus).
    releaseGone() {
      for (const [slot, pl] of [...link.players]) {
        if (pl.connected) continue;
        link.release(slot);
        players.delete(slot);
      }
      sendState();
    },
    clear() { logs.edges.length = 0; logs.menus.length = 0; logs.last = null; logs.lastBySlot = {}; logs.counts.rejected = 0; },
    // Fresh game: lobby, defaults, no points (players stay).
    reset() {
      Object.assign(g, { screen: 'lobby', mode: 'gp', cc: DEFAULT_CC, items: true, raceNo: 0, cup: cups[0].id, track: null, pausedBy: null, results: null, standings: null });
      g.race.state = null;
      for (const p of players.values()) Object.assign(p, newPlayer(p.slot));
      sendState();
    },
    async leave() { link._socket?.disconnect(); await sleep(50); },
    async join() {
      const socket = link._socket;
      if (!socket) return null;
      if (!socket.connected) socket.connect();
      for (let i = 0; i < 100 && !(socket.connected && link.room); i++) await sleep(30);
      await sleep(150);
      return link._info();
    },
    async close() { clearInterval(ticker); link.dispose(); },
  };
}

export { PLAYER_SLOTS, MAX_PLAYERS };

// ---------------------------------------------------------------- CLI

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
  const host = await startFakeHost({ url: arg('url', 'http://localhost:3100'), room: arg('room', 'PADS') });
  const port = Number(arg('control', 3198));
  http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    let body = { ok: true };
    try {
      if (u.pathname === '/state') body = host.setScreen(q);
      else if (u.pathname === '/log') body = host.logs;
      else if (u.pathname === '/clear') host.clear();
      else if (u.pathname === '/event') {
        const slot = q.slot ? Number(q.slot) : null;
        if (q.type === 'vibrate') host.event('vibrate', { pattern: String(q.pattern || '40').split(',').map(Number) }, slot);
        else host.event(q.type, { text: q.text || '' }, slot);
      } else if (u.pathname === '/leave') await host.leave();
      else if (u.pathname === '/join') body = await host.join();
      else if (u.pathname === '/release') host.releaseGone();
      else { res.writeHead(404); res.end(); return; }
    } catch (err) { body = { ok: false, error: String(err?.message || err) }; }
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  }).listen(port, () => console.log(`[host] control API on http://localhost:${port}`));
  const stop = async () => { await host.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
