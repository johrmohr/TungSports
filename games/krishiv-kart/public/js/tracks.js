// Track registry + cups (SPEC §14.4, §15.3). Node-safe.
//
//   import { TRACK_LIST, getTrack, CUPS, getCup } from './tracks.js';
//   const track = getTrack('breezy');   // cached Track instance
//   const cup = getCup('krishiv');      // { id, name, tracks: [ids] }
//
// To add a track: write a def file (same format as track-def.js, plus
// `id` and `theme`), import it here, append it to TRACK_LIST and give its
// theme a world kit in worlds.js.

import { Track } from './track.js';
import { TRACK_DEF } from './track-def.js';
import { MONTE_DEF } from './track-def-monte.js';
import { ALDRICH_DEF } from './track-def-aldrich.js';
import { LAGUNA_DEF } from './track-def-laguna.js';
import { PALACE_DEF } from './track-def-palace.js';

// Every course, in menu order (VS track cards follow this order).
export const TRACK_LIST = [
  { id: 'breezy', def: TRACK_DEF },      // theme 'bay'      -> world.js         (clockwise)
  { id: 'monte', def: MONTE_DEF },       // theme 'hilltown' -> world-monte.js   (counter-clockwise)
  { id: 'aldrich', def: ALDRICH_DEF },   // theme 'campus'   -> world-aldrich.js (clockwise)
  { id: 'laguna', def: LAGUNA_DEF },     // theme 'beach'    -> world-laguna.js  (counter-clockwise)
  { id: 'palace', def: PALACE_DEF },     // theme 'castle'   -> world-palace.js  (counter-clockwise, cup finale)
];

export const DEFAULT_TRACK_ID = 'breezy';

// Grand Prix cups (3 laps per race). Explicit lists: the castle only closes
// the Krishiv Cup. Directions alternate as far as five tracks allow.
export const CUPS = [
  { id: 'gelato', name: 'Gelato Cup', tracks: ['breezy', 'monte', 'aldrich', 'laguna'] },
  { id: 'krishiv', name: 'Krishiv Cup', tracks: ['breezy', 'laguna', 'monte', 'aldrich', 'palace'] },
];
export const DEFAULT_CUP_ID = CUPS[0].id;

// Old callers (v3): the single cup = the first cup.
export const CUP = CUPS[0];

export function hasCup(id) { return CUPS.some((c) => c.id === id); }

// Cup by id (falls back to the first cup).
export function getCup(id = DEFAULT_CUP_ID) { return CUPS.find((c) => c.id === id) || CUPS[0]; }

// { id, name, tracks: [{ id, name }] } for menus / phone state.
export function cupInfo(id) {
  const c = getCup(id);
  return { id: c.id, name: c.name, tracks: c.tracks.map((t) => ({ id: t, name: trackInfo(t).name })) };
}

const _cache = new Map();

export function hasTrack(id) { return TRACK_LIST.some((t) => t.id === id); }

export function trackInfo(id) {
  const t = TRACK_LIST.find((x) => x.id === id) || TRACK_LIST[0];
  return { id: t.id, name: t.def.name, theme: t.def.theme };
}

// Cached Track instance for an id (falls back to the default track).
export function getTrack(id = DEFAULT_TRACK_ID) {
  const entry = TRACK_LIST.find((t) => t.id === id) || TRACK_LIST[0];
  let tr = _cache.get(entry.id);
  if (!tr) {
    tr = new Track(entry.def);
    tr.id = entry.id;
    tr.theme = entry.def.theme;
    _cache.set(entry.id, tr);
  }
  return tr;
}
