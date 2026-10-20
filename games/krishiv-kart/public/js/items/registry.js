// Item plugin registry (SPEC §16.2). Node-safe, no imports besides config.
//
// Every v5 item lives in its own module public/js/items/<id>.js that calls
//   registerItem('<id>', handler)
// at import time; public/js/items/index.js imports every module, and items.js
// imports index.js, so the handlers are in place before any ItemSystem exists
// (game, sim, tests alike). ItemSystem dispatches every item id it does not
// handle natively (config NATIVE_ITEM_IDS) to the registered handler.
//
// The full handler contract (all hooks optional except use) and the helper
// context (`ctx`) every hook receives are documented in notes/v5-foundation.md
// and in items.js (class PluginContext). In short:
//
//   registerItem('peperoncino', {
//     init(ctx) {},                        // once per ItemSystem: ctx.state is this system's private object
//     onGet(ctx, kart) {},                 // the roulette landed on this item (kart.item === id already)
//     use(ctx, kart) { return true; },     // item button: true = one use consumed (false = ignored;
//                                          //   { consume, first } for timed / multi-press items)
//     update(ctx, dt) {},                  // every physics substep, after the native items
//     onKartHit(ctx, kart) {},             // a kart just got disabled (spin / tumble) — drop attached things
//     countLive(ctx) { return 0; },        // instances in play beyond held / rolling / ctx.spawn entities
//     threats(ctx, kart, radius, push) {}, // AI avoidance records: push(ref, { position, s, lateral, radius, clear, ... })
//     clearAround(ctx, at, R, by) {},      // an explosion / accordion destroyed things around `at`
//     onEntityRemove(ctx, e, reason) {},   // a ctx.spawn() entity left play ('hit' | 'blocked' | 'expire' | 'clear' | ...)
//     clear(ctx) {}, dispose(ctx) {},      // remove everything (restart) / tear down
//     initVisuals(ctx) {}, updateVisuals(ctx, dt) {}, disposeVisuals(ctx) {},   // only with a scene (browser)
//     aiUse(kart, aictx) { return false; },// CPU decision (ai.js): true | { use: true, brake: true }
//     callout: 'TOASTED!',                 // HUD callout when the user's item hits a rival (main.js)
//   });

import { ITEM_IDS, NATIVE_ITEM_IDS } from '../config.js';

const HANDLERS = new Map();
const NATIVE = new Set(NATIVE_ITEM_IDS);
const ID_RE = /^[a-z0-9_]{1,24}$/;

/**
 * Register (or replace) the handler of a plugin item. Returns the handler.
 * The id must be a config ITEM_IDS entry that items.js does not handle natively.
 */
export function registerItem(id, handler) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError(`registerItem: bad item id ${JSON.stringify(id)}`);
  if (NATIVE.has(id)) throw new Error(`registerItem: '${id}' is a native item (items.js)`);
  if (!ITEM_IDS.includes(id)) throw new Error(`registerItem: '${id}' is not in config ITEM_IDS`);
  if (!handler || typeof handler !== 'object') throw new TypeError(`registerItem('${id}'): handler must be an object`);
  handler.id = id;
  HANDLERS.set(id, handler);
  return handler;
}

/** The handler registered for an item id, or null (native items have none). */
export function getItemHandler(id) {
  return (typeof id === 'string' && HANDLERS.get(id)) || null;
}

/** Is this id one of items.js's own (v3 / v4) items? */
export function isNativeItem(id) { return NATIVE.has(id); }

/** Every registered [id, handler] pair, in ITEM_IDS order. */
export function itemHandlers() {
  const out = [];
  for (const id of ITEM_IDS) { const h = HANDLERS.get(id); if (h) out.push([id, h]); }
  return out;
}

// ---- item *systems*: plugins that are not roulette items (the lire / coin system)
// They get the same per-ItemSystem ctx and the same lifecycle hooks as items
// (init, update, onKartHit, countLive, threats, clearAround, onEntityRemove,
// clear, dispose, initVisuals, updateVisuals, disposeVisuals) but no use / aiUse.

const SYSTEMS = new Map();

/** Register (or replace) a non-item plugin system by name (e.g. 'coins'). */
export function registerItemSystem(name, handler) {
  if (typeof name !== 'string' || !ID_RE.test(name)) throw new TypeError(`registerItemSystem: bad name ${JSON.stringify(name)}`);
  if (ITEM_IDS.includes(name)) throw new Error(`registerItemSystem: '${name}' is an item id (use registerItem)`);
  if (!handler || typeof handler !== 'object') throw new TypeError(`registerItemSystem('${name}'): handler must be an object`);
  handler.id = name;
  SYSTEMS.set(name, handler);
  return handler;
}

/** Every registered [name, handler] system pair, in registration order. */
export function itemSystems() { return [...SYSTEMS.entries()]; }
