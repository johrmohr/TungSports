// Ladro Mask 🎭 (v5 group B, research-v5-items.md B2; analog: the item-stealing ghost).
//
// The racer pulls on a burglar's mask: kart.ghost(ITEM5.ladroTime) — no kart
// contact, every item / hazard / course hazard / global attack misses (capo,
// zap, espresso, padella, befana included), offroad-proof, the kart drawn see-through.
// ITEM5.ladroStealDelay s later it steals: a random unfinished kart AHEAD
// holding a stealable item (b-util stealable: not rolling, not active / timed,
// not accordion / ladro / potato / antipasto / beer) loses it to the user's
// slot with fresh uses, plus ITEM5.ladroCoins lire. Leading, or nothing to
// steal ahead → a Toot Boost instead. The mask keeps the slot until the steal.
// Events: item:ladro { kart } · item:ladroSteal { kart, from, item, coins }.
// CPU: a power item held ahead, or a ghost-dodge (capo locked on, rocket
// < 10 m, padella warning); else after 6 s.

import { registerItem } from './registry.js';
import { ITEM5, ITEM_INFO } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';
import { takeCoins, giveCoins } from './coins.js';
import { stealable, dropHeldItem, washInkNow, clearSlot } from './b-util.js';

const ID = 'ladro';
const POWER = new Set(['star', 'golden_toot', 'beer_rocket', 'capo', 'mortadella', 'antipasto', 'triple_bouncer', 'triple_rocket', 'triple_toot', 'triple_banana', 'zap']);

registerSound('ladroOn', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // sneaky pizzicato tiptoe down + a soft whoosh
  [784, 659, 523, 392].forEach((f, i) => SYNTH.blip(ac, out, t + i * 0.07, { type: 'triangle', f0: f * p, dur: 0.07, peak: 0.08, lp: 3000 }));
  SYNTH.hiss(ac, out, t, { type: 'bandpass', f0: 600, f1: 2400, dur: 0.4, peak: 0.06, Q: 0.8 });
  return 0.45;
}, 0.9);
registerSound('ladroSteal', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 500 * p, f1: 1700 * p, glide: 0.16, dur: 0.18, peak: 0.12 });     // "yoink" slide
  SYNTH.bell(ac, out, t + 0.16, 2400 * p, 0.04, 0.25);
  SYNTH.bell(ac, out, t + 0.22, 3000 * p, 0.03, 0.25);
  return 0.4;
}, 0.9);

function steal(ctx, kart) {
  const ahead = ctx.kartsAhead(kart).filter((k) => !k.finished && !(k.ghostTimer > 0 && k !== kart) && stealable(ctx, k));
  let victim = null;
  if (ctx.placeOf(kart) > 1 && ahead.length) victim = ahead[Math.floor(ctx.rng() * ahead.length) % ahead.length];
  clearSlot(kart, ID);
  if (!victim) {
    ctx.giveItem(kart, 'toot');
    ctx.emit('item:ladroSteal', { kart, from: null, item: 'toot', coins: 0 });
    ctx.sfx('ladroSteal', kart, 0.8, 0.9);
    return;
  }
  const id = dropHeldItem(ctx, victim);
  const lost = takeCoins(ctx.sys, victim, ITEM5.ladroCoins, 'ladro', { scatter: false });
  if (lost > 0) giveCoins(ctx.sys, kart, lost, 'ladro', { nudge: false });
  if (id && ITEM_INFO[id]) ctx.giveItem(kart, id);
  ctx.emit('item:ladroSteal', { kart, from: victim, item: id, coins: lost });
  ctx.emit('item:hit', { kart: victim, by: kart, item: ID, effect: 'steal', light: true, silentHit: true });
  ctx.sfx('ladroSteal', kart, 1);
  ctx.flash(victim, 'ROBBED!', '#b9a6ff', { sub: kart.name, subColor: kart.cssColor, vibrate: [40, 30, 40] });
}

registerItem(ID, {
  init(ctx) { ctx.state.list = new Set(); },

  use(ctx, kart) {
    const st = ctx.kstate(kart);
    if (st.active) return false;                       // already masked: the steal is coming
    st.active = true;
    st.t0 = ctx.time;
    st.stolen = false;
    kart.ghost(ITEM5.ladroTime);
    ctx.state.list.add(kart);
    ctx.sfx('ladroOn', kart, 1);
    ctx.emit('item:ladro', { kart });
    return { consume: false };
  },

  update(ctx) {
    const list = ctx.state.list;
    if (!list.size) return;
    for (const kart of list) {
      const st = ctx.kstate(kart);
      if (kart.ghostTimer > 0) washInkNow(ctx, kart);       // espresso can't touch a ghost
      if (!st.stolen && ctx.time - st.t0 >= ITEM5.ladroStealDelay) {
        st.stolen = true;
        if (kart.item === ID) steal(ctx, kart);
      }
      if (st.stolen && !(kart.ghostTimer > 0)) { st.active = false; list.delete(kart); }
      else if (!st.stolen && !(kart.ghostTimer > 0)) {
        // the ghost ended early (respawn): the steal is off
        st.active = false; st.stolen = true; clearSlot(kart, ID); list.delete(kart);
      }
    }
  },

  // the mask is an active item: it can't be stolen while it works
  stealable() { return false; },

  aiUse(kart, c) {
    const items = c.items;
    // ghost-dodge: a capo locked on, a rocket close, a padella warning
    for (const t of c.threats(24)) {
      if (t.type === 'capo' && t.targeting) return true;
      if (t.type === 'rocket' && t.targeting && t.distance < 10) return true;
      if (t.item === 'padella') return true;
    }
    if (items && items.capoFor && items.capoFor(kart)) return true;
    // a power item held by someone ahead
    for (const k of c.karts) {
      if (k === kart || k.finished || !k.item || !POWER.has(k.item)) continue;
      if (c.race && c.race.getPlace && c.race.getPlace(k) < c.place && c.plugin && stealable(c.plugin, k)) return true;
    }
    return c.hold > 6;
  },

  clear(ctx) { ctx.state.list.clear(); },

  // ---------------------------------------------------------------- visuals
  // (the see-through kart and the domino mask on the driver's head are kartview.js's,
  // from kart.ghostTimer; here: a faint violet haze trailing the ghost)
  initVisuals(ctx) {
    ctx.state.puff = { count: 2, color: 0x9d8cff, size: 0.5, life: 0.6, radius: 0.8, alpha: 0.35 };
  },
  updateVisuals(ctx) {
    const st = ctx.state;
    if (!ctx.effects || !st.list.size) return;
    for (const k of st.list) if (k.ghostTimer > 0 && Math.random() < 0.3) ctx.effects.emit('smoke', k.position, st.puff);
  },

  callout: 'ROBBED!',
});
