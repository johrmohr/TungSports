// Grissino Swipe 🥖 (v5 group B, research-v5-items.md B6; analog: the tail-spin leaf).
//
// The first press fixes a giant breadstick "tail" to the back of the kart for
// ITEM5.grissTime s (the slot keeps it, a meter drains). Each later press is a
// 360° swing lasting ITEM5.grissSwipe s, swings >= ITEM5.grissGap s apart:
//   * rival karts within ITEM5.grissKartRadius m spin out;
//   * items within ITEM5.grissItemRadius m are destroyed (peels, prank, lemon,
//     coal, bouncers, rockets, fireballs, iceballs, pizzas, eggs, pins) — not
//     the capo, the parmesan wheel or the piggy bank;
//   * lire within reach are collected.
// While idle the tail blocks ONE projectile from behind, and that breaks it.
// Lost when the owner is spun, tumbled, frozen, squashed or blasted, or the window ends.
// Events: item:grissino { kart } · item:grissinoSwipe { kart, hits } · item:grissinoEnd { kart, cause }.
// CPU: equips at once; swipes at a rival < 3.2 m, a threat < 4 m or a lira < 3 m.

import { registerItem } from './registry.js';
import { ITEM5, KART } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';
import { grabCoinsNear, coinsNear } from './coins.js';
import { setWindow, clearSlot, forItemsNear, destroyItem, isRival } from './b-util.js';

const ID = 'grissino';
const BEHIND_BLOCK = 3.0;              // m: an idle tail catches a projectile this close behind

registerSound('grissEquip', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { type: 'bandpass', f0: 2600, dur: 0.06, peak: 0.12, Q: 3 });                  // crunch
  SYNTH.hiss(ac, out, t + 0.05, { type: 'bandpass', f0: 1900, dur: 0.06, peak: 0.1, Q: 3 });
  SYNTH.blip(ac, out, t + 0.04, { type: 'triangle', f0: 600 * p, f1: 900 * p, dur: 0.12, peak: 0.06 });
  return 0.2;
}, 0.9);
registerSound('grissSwipe', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { type: 'bandpass', f0: 500 * p, f1: 3200 * p, sweep: 0.2, dur: 0.32, peak: 0.16, Q: 1.4 });
  return 0.34;
}, 0.9);
registerSound('grissHit', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.kickDrum(ac, out, t, 0.6);
  SYNTH.hiss(ac, out, t, { type: 'bandpass', f0: 1500, dur: 0.08, peak: 0.14, Q: 2 });                   // thwack
  SYNTH.blip(ac, out, t, { type: 'square', f0: 330 * p, f1: 180 * p, dur: 0.1, peak: 0.05, lp: 1800 });
  return 0.2;
}, 0.9);

function end(ctx, kart, cause) {
  const gs = ctx.kstate(kart);
  if (!gs.on) return;
  gs.on = false;
  ctx.state.list.delete(kart);
  clearSlot(kart, ID);
  ctx.emit('item:grissinoEnd', { kart, cause });
  if (ctx.vis && cause !== 'time' && cause !== 'clear') ctx.state.breaks.push({ kart, t: 0 });
}

registerItem(ID, {
  init(ctx) {
    ctx.state.list = new Set();
    ctx.state.breaks = [];
    ctx.state._v = new ctx.THREE.Vector3();
    // a capo blast / squash also takes the tail (squash isn't a "disabled" hit)
    ctx.on('kart:squash', (e) => { if (e && ctx.state.list.has(e.kart)) end(ctx, e.kart, 'hit'); });
  },

  use(ctx, kart) {
    const gs = ctx.kstate(kart);
    if (!gs.on) {
      gs.on = true; gs.t0 = ctx.time; gs.swing = -1; gs.lastSwing = -Infinity; gs.hit = new Set();
      ctx.state.list.add(kart);
      ctx.sfx('grissEquip', kart, 1);
      ctx.emit('item:grissino', { kart });
      return { consume: false, first: true };
    }
    if (ctx.time - gs.lastSwing < ITEM5.grissGap) return false;
    gs.lastSwing = ctx.time;
    gs.swing = 0;
    gs.hits = 0;
    gs.hit.clear();
    ctx.sfx('grissSwipe', kart, 1);
    return { consume: false, first: false };
  },

  update(ctx, dt) {
    const st = ctx.state;
    if (!st.list.size) return;
    for (const kart of st.list) {
      const gs = ctx.kstate(kart);
      const left = ITEM5.grissTime - (ctx.time - gs.t0);
      if (left <= 0 || kart.finished) { end(ctx, kart, 'time'); continue; }
      if (kart.item !== ID) { end(ctx, kart, 'lost'); continue; }
      setWindow(kart, left, ITEM5.grissTime);
      const c = st._v.set(kart.position.x, kart.position.y + 0.5, kart.position.z);
      if (gs.swing >= 0) {
        // the swing: rivals spin, items in reach are swatted, lire collected
        gs.swing += dt;
        const kr = ITEM5.grissKartRadius * (kart.sizeMult || 1);
        for (const k of ctx.kartsTouching(c, kr - KART.radius, { dy: 2, yOff: 0.5, skip: kart })) {
          if (!isRival(k, kart) || gs.hit.has(k)) continue;
          gs.hit.add(k);
          if (ctx.hit(k, 'spin', { by: kart })) { gs.hits++; ctx.sfx('grissHit', k, 1); }
        }
        forItemsNear(ctx, c, ITEM5.grissItemRadius * (kart.sizeMult || 1), (obj, kind) => {
          if (kind === 'entity' && (obj.item === 'parm_wheel' || obj.item === 'piggy_bank')) return;
          destroyItem(ctx, obj, kind, 'blocked');
          gs.hits++;
        }, { owner: kart, skipOwn: true, dy: 2.5 });
        grabCoinsNear(ctx.sys, kart, c, ITEM5.grissItemRadius);
        if (gs.swing >= ITEM5.grissSwipe) {
          ctx.emit('item:grissinoSwipe', { kart, hits: gs.hits });
          gs.swing = -1;
        }
      } else {
        // idle tail: blocks one projectile from behind, and breaks
        const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
        let blocked = false;
        forItemsNear(ctx, c, BEHIND_BLOCK, (obj, kind) => {
          if (blocked || (kind !== 'projectile' && !(kind === 'entity' && obj.speed > 1))) return;
          const dx = obj.position.x - c.x, dz = obj.position.z - c.z;
          if (dx * fx + dz * fz > -0.4) return;                 // must be behind
          if (kind === 'entity' && (obj.item === 'parm_wheel' || obj.item === 'piggy_bank')) return;
          blocked = true;
          destroyItem(ctx, obj, kind, 'blocked');
        }, { owner: kart, skipOwn: true, dy: 2.2 });
        if (blocked) {
          ctx.emit('item:blocked', { kart, item: ID, by: null });
          ctx.sfx('grissHit', kart, 0.9);
          end(ctx, kart, 'block');
        }
      }
    }
  },

  onKartHit(ctx, kart) { if (ctx.state.list.has(kart)) end(ctx, kart, 'hit'); },

  stealable(ctx, kart) { return !ctx.kstate(kart).on; },

  aiUse(kart, c) {
    const pc = c.plugin;
    const gs = pc ? pc.kstate(kart) : null;
    if (!gs || !gs.on) return true;                                    // equip at once
    for (const o of c.karts) {
      if (o === kart || o.finished) continue;
      const dx = o.position.x - kart.position.x, dz = o.position.z - kart.position.z;
      if (dx * dx + dz * dz < ITEM5.grissKartRadius * ITEM5.grissKartRadius && !(pc && pc.immune(o))) return true;
    }
    for (const t of c.threats(5)) if (t.distance < 4 && t.type !== 'capo' && t.type !== 'potato') return true;
    if (pc && coinsNear(pc.sys, kart.position, 3)) return true;
    return false;
  },

  clear(ctx) {
    for (const k of ctx.state.list) { ctx.kstate(k).on = false; k.itemWindow = 0; }
    ctx.state.list.clear();
    ctx.state.breaks.length = 0;
  },

  // ---------------------------------------------------------------- visuals: a long knobbly breadstick behind the kart
  initVisuals(ctx) {
    const T = ctx.THREE, st = ctx.state;
    const crust = ctx.own(new T.MeshStandardMaterial({ color: 0xe0a85a, roughness: 0.75, emissive: 0x3a2000, emissiveIntensity: 0.15 }));
    const seed = ctx.own(new T.MeshStandardMaterial({ color: 0xfff1d2, roughness: 0.8 }));
    const stick = ctx.own(new T.CylinderGeometry(0.13, 0.17, 2.6, 10, 6));
    // knobbly: wobble the radius a little along the length
    const pos = stick.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i), x = pos.getX(i), z = pos.getZ(i);
      const w = 1 + 0.12 * Math.sin(y * 9) + 0.05 * Math.sin(y * 23 + x * 4);
      pos.setX(i, x * w); pos.setZ(i, z * w);
    }
    stick.computeVertexNormals();
    stick.rotateX(Math.PI / 2);
    stick.translate(0, 0, -1.3);            // pivot at the kart end, the stick pointing back
    const dot = ctx.own(new T.SphereGeometry(0.03, 4, 3));
    st.make = () => {
      const g = new T.Group();
      const arm = new T.Group();
      arm.add(new T.Mesh(stick, crust));
      for (let i = 0; i < 14; i++) {
        const m = new T.Mesh(dot, seed);
        const a = i * 2.3, zz = -0.3 - (i / 14) * 2.2;
        m.position.set(Math.cos(a) * 0.15, Math.sin(a) * 0.15, zz);
        arm.add(m);
      }
      g.add(arm);
      g.userData.arm = arm;
      ctx.root.add(g);
      return g;
    };
    st.tails = new Map();
    st.swoosh = { count: 3, color: 0xfff2c8, size: 0.28, life: 0.25, radius: 0.15 };
    st.crumbs = { count: 14, color: 0xe0a85a, size: 0.14, life: 0.6, radius: 0.5, spread: 4 };
    st.p = new T.Vector3();
  },

  updateVisuals(ctx, dt) {
    const st = ctx.state;
    if (!st.tails) return;
    for (const [k, g] of st.tails) if (!st.list.has(k)) g.visible = false;
    for (const k of st.list) {
      let g = st.tails.get(k);
      if (!g) { g = st.make(); st.tails.set(k, g); }
      const gs = ctx.kstate(k), sz = k.sizeMult || 1;
      const back = -Math.sin(k.yaw) * 0.9 * sz, backZ = -Math.cos(k.yaw) * 0.9 * sz;
      g.position.set(k.position.x + back, k.position.y + 0.55 * sz, k.position.z + backZ);
      let spin = 0;
      if (gs.swing >= 0) spin = (gs.swing / ITEM5.grissSwipe) * Math.PI * 2;
      g.rotation.set(0, k.yaw + spin, 0);
      const arm = g.userData.arm;
      arm.rotation.set(gs.swing >= 0 ? -0.05 : 0.25 + Math.sin(ctx.time * 6) * 0.06, Math.sin(ctx.time * 3.1) * 0.12, 0);
      g.scale.setScalar(sz * (gs.swing >= 0 ? 1.25 : 1));
      g.visible = true;
      if (gs.swing >= 0 && ctx.effects) {
        const a = k.yaw + spin + Math.PI;
        st.p.set(g.position.x + Math.sin(a) * 2.4 * sz, g.position.y, g.position.z + Math.cos(a) * 2.4 * sz);
        ctx.effects.emit('glow', st.p, st.swoosh);
      }
    }
    for (let i = st.breaks.length - 1; i >= 0; i--) {
      const b = st.breaks[i];
      if (b.t === 0 && ctx.effects && b.kart) {
        st.p.set(b.kart.position.x - Math.sin(b.kart.yaw) * 2, b.kart.position.y + 0.6, b.kart.position.z - Math.cos(b.kart.yaw) * 2);
        ctx.effects.emit('spark', st.p, st.crumbs);
      }
      b.t += dt;
      if (b.t > 0.1) st.breaks.splice(i, 1);
    }
  },
  disposeVisuals(ctx) { if (ctx.state.tails) ctx.state.tails.clear(); },

  callout: 'SWIPED!',
});
