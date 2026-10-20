// Kart-racer-style vehicle parts, stat math, engine classes, player slots and
// Grand Prix points (SPEC §14). Node-safe, pure data + functions.
//
// A racer's final ratings = character ratings + kart body + wheels, clamped
// to 1..5 (0.5 steps). Every body and every wheel set sums to zero across
// the four stats, so parts only ever TRADE one strength for another.

import { clamp } from './utils.js';

export const STAT_KEYS = ['speed', 'accel', 'handling', 'weight'];
export const STAT_LABELS = { speed: 'Speed', accel: 'Accel', handling: 'Handling', weight: 'Weight' };
export const RATING_MIN = 1;
export const RATING_MAX = 5;

// ------------------------------------------------------------- weight groups

// Character stat groups (each sums to 12 stars). Two racers share a group.
export const WEIGHT_GROUPS = {
  L1: { weightClass: 'light',  ratings: { speed: 2,   accel: 4.5, handling: 4,   weight: 1.5 } },
  L2: { weightClass: 'light',  ratings: { speed: 2.5, accel: 4,   handling: 3.5, weight: 2 } },
  M1: { weightClass: 'medium', ratings: { speed: 3,   accel: 3.5, handling: 3,   weight: 2.5 } },
  M2: { weightClass: 'medium', ratings: { speed: 3,   accel: 3,   handling: 3,   weight: 3 } },
  H1: { weightClass: 'heavy',  ratings: { speed: 3.5, accel: 2.5, handling: 2.5, weight: 3.5 } },
  H2: { weightClass: 'heavy',  ratings: { speed: 4,   accel: 2,   handling: 2,   weight: 4 } },
};
export const WEIGHT_CLASSES = [
  { id: 'light', label: 'Light' },
  { id: 'medium', label: 'Medium' },
  { id: 'heavy', label: 'Heavy' },
];
// Default group for user-supplied custom racers by weight class.
export const CUSTOM_GROUP_FOR_CLASS = { light: 'L2', medium: 'M2', heavy: 'H1' };

// ---------------------------------------------------------------- vehicle parts

export const KART_BODIES = [
  { id: 'standard',  label: 'Classic',       mods: { speed: 0,    accel: 0,    handling: 0,    weight: 0 },
    desc: 'Balanced all-rounder.' },
  { id: 'speedster', label: 'Speedster',     mods: { speed: 1,    accel: -0.5, handling: -0.5, weight: 0 },
    desc: 'Low wedge with a big wing. Fast but twitchy.' },
  { id: 'buggy',     label: 'Bubble Buggy',  mods: { speed: -1,   accel: 1,    handling: 0.5,  weight: -0.5 },
    desc: 'Bouncy and quick off the line.' },
  { id: 'tank',      label: 'Thunder Truck', mods: { speed: 0.5,  accel: -1,   handling: -0.5, weight: 1 },
    desc: 'Heavy bruiser that shoves rivals aside.' },
  { id: 'feather',   label: 'Featherlite',   mods: { speed: -0.5, accel: 0.5,  handling: 1,    weight: -1 },
    desc: 'Bare-frame go-kart. Corners on rails.' },
  { id: 'rocket',    label: 'Rocket Sled',   mods: { speed: 1,    accel: -0.5, handling: 0,    weight: -0.5 },
    desc: 'Jet fins and raw top speed.' },
];

// `offroad` is added to KART.offroadSpeedMult (grass speed) for players.
export const WHEELS = [
  { id: 'standard', label: 'Standard',       mods: { speed: 0,    accel: 0,    handling: 0,    weight: 0 },   offroad: 0,
    desc: 'Reliable everyday tires.' },
  { id: 'slick',    label: 'Racing Slicks',  mods: { speed: 0.5,  accel: -0.5, handling: 0,    weight: 0 },   offroad: -0.05,
    desc: 'Smooth tread for top speed.' },
  { id: 'offroad',  label: 'Mud Grippers',   mods: { speed: 0,    accel: 0,    handling: -0.5, weight: 0.5 }, offroad: 0.15,
    desc: 'Chunky tread — barely slows on grass.' },
  { id: 'tiny',     label: 'Mini Rollers',   mods: { speed: -0.5, accel: 0.5,  handling: 0.5,  weight: -0.5 }, offroad: 0,
    desc: 'Small and zippy.' },
  { id: 'monster',  label: 'Monster Wheels', mods: { speed: 0,    accel: -0.5, handling: -0.5, weight: 1 },   offroad: 0.1,
    desc: 'Huge tires, huge presence.' },
  { id: 'neon',     label: 'Neon Rings',     mods: { speed: 0,    accel: -0.5, handling: 0.5,  weight: 0 },   offroad: 0,
    desc: 'Glowing rims that grip the corners.' },
];

const BODY_MAP = new Map(KART_BODIES.map((b) => [b.id, b]));
const WHEEL_MAP = new Map(WHEELS.map((w) => [w.id, w]));
export const getBody = (id) => BODY_MAP.get(id) || KART_BODIES[0];
export const getWheels = (id) => WHEEL_MAP.get(id) || WHEELS[0];

export const DEFAULT_LOADOUT = Object.freeze({ body: 'standard', wheels: 'standard' });

// A loadout is just { body, wheels } (the kart is painted in the
// character's own colors automatically, as in classic kart racers).
export function sanitizeLoadout(raw) {
  const body = raw && BODY_MAP.has(raw.body) ? raw.body : DEFAULT_LOADOUT.body;
  const wheels = raw && WHEEL_MAP.has(raw.wheels) ? raw.wheels : DEFAULT_LOADOUT.wheels;
  return { body, wheels };
}

// Final 1..5 ratings for a character def + loadout.
export function computeRatings(def, loadout) {
  const base = (def && def.ratings) || {};
  const b = getBody(loadout && loadout.body);
  const w = getWheels(loadout && loadout.wheels);
  const out = {};
  for (const k of STAT_KEYS) {
    out[k] = clamp((Number(base[k]) || 3) + (b.mods[k] || 0) + (w.mods[k] || 0), RATING_MIN, RATING_MAX);
  }
  return out;
}

export const offroadBonus = (loadout) => getWheels(loadout && loadout.wheels).offroad || 0;

// Physical stats from final ratings. r = 3 reproduces the original tuning
// (29 m/s top speed, 16 m/s² accel, 1.91 rad/s turn, 1.1 mass). Engine class
// scaling (ENGINE_CLASSES[].mult) is applied by kart.js, not here.
export const TURN_RATE_MIN = 1.67;
export const TURN_RATE_MAX = 2.15;
export function statsFromRatings(r = {}) {
  const g = (k) => clamp(Number(r[k]) || 3, RATING_MIN, RATING_MAX);
  return {
    topSpeed: 29.0 * (1 + 0.02 * (g('speed') - 3)),
    accel: 16.0 * (1 + 0.18 * (g('accel') - 3)),
    turnRate: clamp(1.55 + 0.12 * g('handling'), TURN_RATE_MIN, TURN_RATE_MAX),
    mass: 1.1 * (1 + 0.25 * (g('weight') - 3)),
  };
}

// CPU racers drive real parts (stats apply to them too, unlike v2). Each CPU
// picks one of two presets per set: Classic + Standard, or a class preset.
export const CPU_PRESETS = {
  light: [{ body: 'standard', wheels: 'standard' }, { body: 'buggy', wheels: 'standard' }],
  medium: [{ body: 'standard', wheels: 'standard' }, { body: 'speedster', wheels: 'standard' }],
  heavy: [{ body: 'standard', wheels: 'standard' }, { body: 'tank', wheels: 'standard' }],
};

// --------------------------------------------------------------- engine class

// Speed multiplier applies to top speed, acceleration, item projectile speeds
// and CPU pace — NOT to turn rate, drift tier times or boost durations.
export const ENGINE_CLASSES = [
  { id: 50,  label: '50cc',  mult: 0.80, cpu: 'easy' },
  { id: 100, label: '100cc', mult: 0.90, cpu: 'normal' },
  { id: 150, label: '150cc', mult: 1.00, cpu: 'hard' },
];
export const DEFAULT_CC = 100;
export const getEngineClass = (cc) => ENGINE_CLASSES.find((e) => e.id === Number(cc)) || ENGINE_CLASSES[1];

// --------------------------------------------------------------- players & GP

export const MAX_PLAYERS = 4;
export const PLAYER_SLOTS = [
  { slot: 1, label: 'P1', css: '#ff3b3b', hex: 0xff3b3b },
  { slot: 2, label: 'P2', css: '#2f7bff', hex: 0x2f7bff },
  { slot: 3, label: 'P3', css: '#ffc81e', hex: 0xffc81e },
  { slot: 4, label: 'P4', css: '#2ecc40', hex: 0x2ecc40 },
];
export const slotInfo = (slot) => PLAYER_SLOTS[(Number(slot) || 1) - 1] || PLAYER_SLOTS[0];

// Points by finishing place with 8 racers (classic 10-8-6-5-4-3-2-1 table).
export const GP_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
// Humans-only VS races (CPUs off) with 2/3/4 racers.
export const SMALL_FIELD_POINTS = { 2: [3, 1], 3: [4, 2, 1], 4: [5, 3, 2, 1] };
export function pointsFor(place, racers = 8) {
  const table = racers >= 5 ? GP_POINTS : SMALL_FIELD_POINTS[racers] || GP_POINTS;
  return table[place - 1] || 0;
}
