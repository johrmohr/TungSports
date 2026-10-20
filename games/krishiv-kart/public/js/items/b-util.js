// Shared helpers of the v5 group-B item plugins (calzone, ladro, hot_potato,
// mortadella, tarantella, grissino, antipasto, amore, lira_purse, tip_jar).
// Not a plugin itself (registers nothing). Node-safe.

import { ITEM, ITEM_INFO, KART } from '../config.js';
import { getItemHandler } from './registry.js';
import { clamp } from '../utils.js';

// v5 group-A entities that are "items in play" a chomp / swipe / giant / heart
// may eat, swat or absorb (by plugin id; kinds that are pickups or boosts are skipped).
export const EATABLE_ITEMS = new Set(['peperoncino', 'granita', 'flying_pizza', 'rolling_pins', 'surprise_egg',
  'prank_box', 'banana_split', 'sour_lemon', 'befana']);
const NOT_ITEM_KIND = /capsule|hoop|ring|witch|broom|pickup|gift|marker|portal/i;

/** Write the HUD meter of a timed item: kart.itemWindow = share of the window left (0 clears). */
export function setWindow(kart, left, total) {
  kart.itemWindow = total > 0 && left > 0 ? clamp(left / total, 0, 1) : 0;
}

/** Empty the slot if it still holds `id`, and clear the window meter. */
export function clearSlot(kart, id) {
  if (kart.item === id) { kart.item = null; kart.itemCount = 0; }
  kart.itemWindow = 0;
}

/** Point `fwd` m ahead, `right` m to the right and `up` m above the kart (scaled by its size) into out. */
export function kartPoint(kart, fwd, up, right, out) {
  const s = kart.sizeMult || 1, fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
  out.x = kart.position.x + (fx * fwd - fz * right) * s;
  out.y = kart.position.y + up * s;
  out.z = kart.position.z + (fz * fwd + fx * right) * s;
  return out;
}

/** A rival kart this kart may hit with an item (not itself, not finished, not race-frozen). */
export function isRival(k, owner) { return k && k !== owner && !k.finished && !k.frozen; }

/** Is this plugin entity an item in play (eatable / swattable)? */
export function isItemEntity(e, skipItems = null) {
  if (!e || !e.active || !EATABLE_ITEMS.has(e.item)) return false;
  if (skipItems && skipItems.has(e.item)) return false;
  return !NOT_ITEM_KIND.test(e.kind || '');
}

/**
 * Items in play near `pos` (3D radius, |dy| <= dy): native projectiles,
 * native banana peels, bombs (optional) and the eatable v5 entities; `owner`'s
 * own are left out while `skipOwn`. Calls fn(obj, kind) for each, where kind is
 * 'projectile' | 'banana' | 'stink' | 'bomb' | 'entity'. Returns the count visited.
 */
export function forItemsNear(ctx, pos, radius, fn, { owner = null, skipOwn = true, bombs = false, stink = false, dy = 2.5 } = {}) {
  const sys = ctx.sys, r2 = radius * radius;
  let n = 0;
  const near = (p) => {
    const dx = p.x - pos.x, dz = p.z - pos.z;
    return dx * dx + dz * dz <= r2 && Math.abs(p.y - pos.y) <= dy;
  };
  for (let i = sys.projectiles.length - 1; i >= 0; i--) {
    const p = sys.projectiles[i];
    if (!p || !p.active || (skipOwn && owner && p.owner === owner) || !near(p.position)) continue;
    n++; fn(p, 'projectile');
  }
  for (let i = sys.hazards.length - 1; i >= 0; i--) {
    const h = sys.hazards[i];
    if (!h || !h.active || (h.type === 'stink' && !stink) || (skipOwn && owner && h.owner === owner && h.age < 1)) continue;
    if (!near(h.position)) continue;
    n++; fn(h, h.type === 'stink' ? 'stink' : 'banana');
  }
  if (bombs) {
    for (let i = sys.bombs.length - 1; i >= 0; i--) {
      const b = sys.bombs[i];
      if (!b || !b.active || (skipOwn && owner && b.owner === owner) || !near(b.position)) continue;
      n++; fn(b, 'bomb');
    }
  }
  for (let i = sys.entities.length - 1; i >= 0; i--) {
    const e = sys.entities[i];
    if (!isItemEntity(e) || (skipOwn && owner && e.owner === owner) || !near(e.position)) continue;
    n++; fn(e, 'entity');
  }
  return n;
}

/** Destroy one item found by forItemsNear (natives through the system, entities with `reason`). */
export function destroyItem(ctx, obj, kind, reason = 'blocked') {
  if (kind === 'entity') ctx.remove(obj, reason);
  else ctx.destroyNative(obj, reason);
}

/** The id an absorbed / stolen thing becomes in a slot (amore gifts), or null. */
export function giftIdOf(obj, kind) {
  if (kind === 'projectile') return obj.type === 'rocket' ? 'rocket' : obj.type === 'bouncer' ? 'bouncer' : null;
  if (kind === 'banana') return 'banana';
  if (kind === 'bomb') return 'meatball_bomb';
  if (kind === 'entity' && (obj.item === 'prank_box' || obj.item === 'sour_lemon' || obj.item === 'banana_split')) return obj.item;
  return null;
}

// Items a Ladro Mask can't take (research B2): these ids, plus anything active.
const UNSTEALABLE = new Set(['accordion', 'ladro', 'hot_potato', 'antipasto', 'beer_rocket']);

/** Can the Ladro Mask steal this kart's held item right now? */
export function stealable(ctx, k) {
  const id = k.item;
  if (!id || k.rolling || !(k.itemCount > 0) || UNSTEALABLE.has(id) || !ITEM_INFO[id]) return false;
  if (k.beer || k.itemWindow > 0) return false;                       // a ride / a running window
  if (id === 'golden_toot' && k.goldenTimer > 0) return false;
  if (id === 'mortadella' && k.megaTimer > 0) return false;
  const h = getItemHandler(id);
  if (h) {
    // a plugin may say so itself (handler.stealable(ctx, kart)); otherwise a started multi-use / timed item is active
    const pc = ctx.sys.pluginContext(id);
    if (typeof h.stealable === 'function' && pc) return !!h.stealable(pc, k);
    if ((ITEM_INFO[id].uses || 1) > 1 && k.itemCount < ITEM_INFO[id].uses) return false;
  }
  return true;
}

/** Native triples attached to this kart (the ItemSystem's per-kart state). */
export function attachedCount(ctx, k) {
  const st = ctx.sys._st && ctx.sys._st.get(k);
  return st ? st.attached || 0 : 0;
}

/** Drop a kart's held item (triples release their orbiters / peels). Not while rolling. */
export function dropHeldItem(ctx, k) {
  if (k.rolling || !k.item) return null;
  const id = k.item;
  if (attachedCount(ctx, k) > 0 && typeof ctx.sys._releaseAttached === 'function') ctx.sys._releaseAttached(k);
  if (k.item) { k.item = null; k.itemCount = 0; }
  k.itemWindow = 0;
  return id;
}

/** Remove an espresso cup flying at this kart (and its coffee): the cup was eaten / dodged. */
export function cancelIncomingInk(ctx, k) {
  const st = ctx.sys._st && ctx.sys._st.get(k);
  if (!st || !(st.inkAge >= 0) || st.inkAge >= ITEM.espressoDelay) return false;
  st.inkAge = -1; st.inkLanded = false; st.inkWash = false; st.inkBy = null;
  k.ink = 0; k.inkIncoming = false;
  const vis = ctx.vis;
  if (vis && Array.isArray(vis.cupPool)) {
    for (const c of vis.cupPool) if (c.kart === k) { c.kart = null; c.from = null; if (c.group) c.group.visible = false; }
  }
  return true;
}

/** Wipe coffee off a kart at once (ghost: no ink at all). */
export function washInkNow(ctx, k) {
  const st = ctx.sys._st && ctx.sys._st.get(k);
  if (!st || !(st.inkAge >= 0)) return false;
  if (!cancelIncomingInk(ctx, k)) { st.inkAge = -1; st.inkBy = null; k.ink = 0; k.inkIncoming = false; }
  return true;
}

/** Give a coffee splat of `seconds` to a kart (antipasto's espresso orbiter). */
export function splatInk(ctx, k, seconds, by = null) {
  const st = ctx.sys._st && ctx.sys._st.get(k);
  if (!st || ctx.immune(k)) return false;
  const end = ITEM.espressoDelay + ITEM.espressoTime;
  st.inkAge = Math.max(ITEM.espressoDelay, end - seconds);
  st.inkLanded = false; st.inkWash = false; st.inkBy = by;
  return true;
}

/** Kart index in the system (stink hitMask bit). */
export function kartIndex(ctx, k) { return ctx.karts.indexOf(k); }

export const KART_R = KART.radius;
