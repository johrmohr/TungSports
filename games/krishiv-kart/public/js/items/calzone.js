// Chomping Calzone 🥟 (v5 group B, research-v5-items.md B1; analog: the chomping plant).
//
// The first press mounts a calzone with teeth on the front bumper for
// ITEM5.calzoneTime s (the slot keeps it, a meter drains), up to
// ITEM5.calzoneChomps chomps. A chomp needs ITEM5.calzoneMinGap s since the
// last one, and a target in reach, or a press, or ITEM5.calzoneIdle s idle.
// Reach: a ITEM5.calzoneReach m cone ±ITEM5.calzoneCone° ahead of the nose; the nearest target wins:
//   * a rival kart → spins out;
//   * a hazard or projectile (peel, prank, lemon, coal, bouncer, rocket,
//     fireball, iceball, pizza, egg) → eaten (not the capo, the wheel or the piggy bank);
//   * a lira → collected;
//   * an espresso cup flying at the owner → eaten (no coffee).
// Every chomp lunges: applyBoost(ITEM5.calzoneBoost, 'chomp', DRIFT.boostSpeedMult).
// Lost when the owner is hit. Free from 20 s, max 2 in play (config ITEM_RULES).
// Events: item:calzone { kart } · item:chomp { kart, target, kind } · item:calzoneEnd { kart, cause }.
// CPU: mounts with a rival < 20 m ahead or on a straight; presses when a rival is in reach.

import { registerItem } from './registry.js';
import { ITEM5, DRIFT, ITEM, KART } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';
import { grabCoinsNear, coinsNear } from './coins.js';
import { setWindow, clearSlot, forItemsNear, destroyItem, isRival, cancelIncomingInk, kartPoint } from './b-util.js';

const ID = 'calzone';
const COS_CONE = Math.cos((ITEM5.calzoneCone * Math.PI) / 180);

registerSound('calzoneMount', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 180 * p, f1: 90 * p, dur: 0.18, peak: 0.16 });              // doughy plop
  SYNTH.blip(ac, out, t + 0.1, { type: 'triangle', f0: 520 * p, f1: 780 * p, dur: 0.12, peak: 0.07 });
  return 0.25;
}, 0.9);
registerSound('chomp', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { type: 'bandpass', f0: 1400 * p, dur: 0.05, peak: 0.16, Q: 2 });               // teeth clack
  SYNTH.blip(ac, out, t, { type: 'square', f0: 200 * p, f1: 110 * p, dur: 0.08, peak: 0.1, lp: 1500 });
  SYNTH.hiss(ac, out, t + 0.06, { type: 'lowpass', f0: 800, dur: 0.1, peak: 0.08 });                     // munch
  return 0.18;
}, 0.9);

function end(ctx, kart, cause) {
  const cs = ctx.kstate(kart);
  if (!cs.on) return;
  cs.on = false;
  ctx.state.list.delete(kart);
  clearSlot(kart, ID);
  ctx.emit('item:calzoneEnd', { kart, cause, chomps: cs.chomps });
}

// The nearest thing in the bite cone: { kind, obj, d } or null.
function target(ctx, kart, cs) {
  const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
  const reach = ITEM5.calzoneReach * (kart.sizeMult || 1);
  const nose = cs._n;
  kartPoint(kart, 1.0, 0.5, 0, nose);
  let best = null, bd = Infinity;
  const inCone = (p, extra = 0) => {
    const dx = p.x - kart.position.x, dz = p.z - kart.position.z, d = Math.hypot(dx, dz);
    if (d < 1e-3) return -1;
    const fwd = (dx * fx + dz * fz) / d;
    if (d > reach + extra + KART.radius || fwd < COS_CONE) return -1;
    return d;
  };
  for (const k of ctx.karts) {
    if (!isRival(k, kart) || ctx.immune(k) || !k.isHittable() || Math.abs(k.position.y - kart.position.y) > 2) continue;
    const d = inCone(k.position, KART.radius * ((k.sizeMult || 1) - 1));
    if (d >= 0 && d < bd) { bd = d; best = { kind: 'kart', obj: k, d }; }
  }
  forItemsNear(ctx, nose, reach + 1.5, (obj, kind) => {
    if (kind === 'entity' && (obj.item === 'parm_wheel' || obj.item === 'piggy_bank')) return;
    const d = inCone(obj.position);
    if (d >= 0 && d < bd) { bd = d; best = { kind, obj, d }; }
  }, { owner: kart, skipOwn: true, dy: 2.5 });
  const coin = coinsNear(ctx.sys, nose, reach);
  if (coin) {
    const d = inCone(coin);
    if (d >= 0 && d < bd) { bd = d; best = { kind: 'coin', obj: coin, d }; }
  }
  return best;
}

function chomp(ctx, kart, cs, tgt) {
  cs.last = ctx.time;
  cs.chomps++;
  cs.bite = 1;
  kart.applyBoost(ITEM5.calzoneBoost, 'chomp', DRIFT.boostSpeedMult);
  ctx.sfx('chomp', kart, 1, 0.95 + 0.1 * ctx.rng());
  let kind = null, what = null;
  // an espresso cup flying at us is eaten first
  if (kart.inkIncoming && cancelIncomingInk(ctx, kart)) { kind = 'espresso'; what = 'espresso'; }
  if (tgt) {
    kind = tgt.kind;
    if (tgt.kind === 'kart') {
      if (ctx.hit(tgt.obj, 'spin', { by: kart })) what = tgt.obj;
    } else if (tgt.kind === 'coin') {
      grabCoinsNear(ctx.sys, kart, tgt.obj, 0.8);
      what = 'lira';
    } else {
      what = tgt.kind === 'entity' ? tgt.obj.item : tgt.obj.type;
      destroyItem(ctx, tgt.obj, tgt.kind, 'blocked');
    }
  }
  // lire right in the mouth come along anyway
  grabCoinsNear(ctx.sys, kart, cs._n, 1.4);
  ctx.emit('item:chomp', { kart, target: what, kind });
  if (cs.chomps >= ITEM5.calzoneChomps) end(ctx, kart, 'chomps');
}

registerItem(ID, {
  init(ctx) {
    ctx.state.list = new Set();
    ctx.on('kart:squash', (e) => { if (e && ctx.state.list.has(e.kart)) end(ctx, e.kart, 'hit'); });
  },

  use(ctx, kart) {
    const cs = ctx.kstate(kart);
    if (!cs.on) {
      cs.on = true; cs.t0 = ctx.time; cs.last = ctx.time - ITEM5.calzoneMinGap; cs.chomps = 0; cs.bite = 0; cs.press = false;   // (a target can be bitten at once)
      cs._n = cs._n || new ctx.THREE.Vector3();
      ctx.state.list.add(kart);
      ctx.sfx('calzoneMount', kart, 1);
      ctx.emit('item:calzone', { kart });
      return { consume: false, first: true };
    }
    cs.press = true;                               // chomp at the next chance
    return { consume: false, first: false };
  },

  update(ctx, dt) {
    const st = ctx.state;
    if (!st.list.size) return;
    for (const kart of st.list) {
      const cs = ctx.kstate(kart);
      const left = ITEM5.calzoneTime - (ctx.time - cs.t0);
      if (left <= 0 || kart.finished) { end(ctx, kart, 'time'); continue; }
      if (kart.item !== ID) { end(ctx, kart, 'lost'); continue; }
      setWindow(kart, left, ITEM5.calzoneTime);
      cs.bite = Math.max(0, cs.bite - dt * 5);
      if (ctx.time - cs.last < ITEM5.calzoneMinGap || kart.isDisabled()) continue;
      const tgt = target(ctx, kart, cs);
      const cupNear = kart.inkIncoming;
      if (tgt || cupNear || cs.press || ctx.time - cs.last >= ITEM5.calzoneIdle) {
        cs.press = false;
        chomp(ctx, kart, cs, tgt);
      }
    }
  },

  onKartHit(ctx, kart) { if (ctx.state.list.has(kart)) end(ctx, kart, 'hit'); },

  stealable(ctx, kart) { return !ctx.kstate(kart).on; },

  countLive(ctx) {
    let n = 0;
    for (const k of ctx.state.list) if (k.item !== ID) n++;
    return n;
  },

  aiUse(kart, c) {
    const pc = c.plugin;
    const cs = pc ? pc.kstate(kart) : null;
    if (!cs || !cs.on) return !!c.rivalAhead(2, 20, 0.6) || c.straightAhead(40) || c.hold > 5;
    return !!c.rivalAhead(0.5, ITEM5.calzoneReach + KART.radius, 0.85);
  },

  clear(ctx) {
    for (const k of ctx.state.list) { ctx.kstate(k).on = false; k.itemWindow = 0; }
    ctx.state.list.clear();
  },

  // ---------------------------------------------------------------- visuals: a crimped calzone with teeth on the bumper
  initVisuals(ctx) {
    const T = ctx.THREE, st = ctx.state;
    const dough = ctx.own(new T.MeshStandardMaterial({ color: 0xe0a050, roughness: 0.7, emissive: 0x3a1800, emissiveIntensity: 0.15 }));
    const crust = ctx.own(new T.MeshStandardMaterial({ color: 0xb8742c, roughness: 0.8 }));
    const tooth = ctx.own(new T.MeshStandardMaterial({ color: 0xfffcf2, roughness: 0.4 }));
    const sauce = ctx.own(new T.MeshStandardMaterial({ color: 0xc8261a, roughness: 0.5, emissive: 0x500000, emissiveIntensity: 0.3 }));
    // half-moon jaw: a half disc, puffed (scaled sphere slice)
    const half = ctx.own(new T.SphereGeometry(0.62, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2));
    half.scale(1, 0.45, 0.75);
    const lipGeo = ctx.own(new T.TorusGeometry(0.6, 0.07, 6, 20, Math.PI));
    const toothGeo = ctx.own(new T.ConeGeometry(0.06, 0.16, 5));
    const tongue = ctx.own(new T.SphereGeometry(0.35, 12, 8));
    tongue.scale(1, 0.25, 0.8);
    const eyeGeo = ctx.own(new T.SphereGeometry(0.12, 10, 8));
    const pupilGeo = ctx.own(new T.SphereGeometry(0.06, 8, 6));
    const white = ctx.own(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }));
    const black = ctx.own(new T.MeshStandardMaterial({ color: 0x141414, roughness: 0.3 }));
    const armGeo = ctx.own(new T.CylinderGeometry(0.07, 0.09, 0.9, 8));
    armGeo.rotateX(Math.PI / 2);
    st.make = () => {
      const g = new T.Group();
      const top = new T.Group(), bot = new T.Group();
      const ht = new T.Mesh(half, dough);
      const hb = new T.Mesh(half, dough); hb.rotation.x = Math.PI;
      const lt = new T.Mesh(lipGeo, crust); lt.rotation.set(-Math.PI / 2, 0, Math.PI); lt.position.z = 0.02;
      const lb = new T.Mesh(lipGeo, crust); lb.rotation.set(Math.PI / 2, 0, Math.PI); lb.position.z = 0.02;
      top.add(ht, lt);
      bot.add(hb, lb);
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * (0.12 + 0.76 * (i / 6));
        const t1 = new T.Mesh(toothGeo, tooth); t1.position.set(Math.cos(a) * 0.5, -0.04, Math.sin(a) * 0.38); t1.rotation.x = Math.PI;
        const t2 = new T.Mesh(toothGeo, tooth); t2.position.set(Math.cos(a) * 0.5, 0.04, Math.sin(a) * 0.38);
        top.add(t1); bot.add(t2);
      }
      const tg = new T.Mesh(tongue, sauce); tg.position.set(0, 0, 0.12);
      bot.add(tg);
      // googly eyes on the top jaw, looking ahead (our own calzone, not anyone's plant)
      for (const x of [-0.2, 0.2]) {
        const e = new T.Mesh(eyeGeo, white); e.position.set(x, 0.3, 0.02);
        const pu = new T.Mesh(pupilGeo, black); pu.position.set(x, 0.32, -0.09);
        top.add(e, pu);
      }
      // the hinge is at the back (toward the kart); the jaws open forward
      top.position.z = -0.25; bot.position.z = -0.25;
      const hinge = new T.Group();
      hinge.add(top, bot);
      g.add(hinge);
      // the bracket that holds it on the bumper (a crust-brown arm back to the kart)
      const arm = new T.Mesh(armGeo, crust); arm.position.set(0, -0.05, 0.55);
      g.add(arm);
      g.userData.top = top; g.userData.bot = bot;
      ctx.root.add(g);
      return g;
    };
    st.heads = new Map();
    st.p = new T.Vector3();
    st.crumbs = { count: 6, color: 0xe0a050, size: 0.12, life: 0.4, radius: 0.3, spread: 3 };
  },

  updateVisuals(ctx) {
    const st = ctx.state;
    if (!st.heads) return;
    for (const [k, g] of st.heads) if (!st.list.has(k)) g.visible = false;
    for (const k of st.list) {
      let g = st.heads.get(k);
      if (!g) { g = st.make(); st.heads.set(k, g); }
      const cs = ctx.kstate(k), sz = k.sizeMult || 1;
      const lunge = cs.bite * 0.5;
      kartPoint(k, 1.55 + lunge, 0.62, 0, st.p);
      g.position.copy(st.p);
      g.rotation.set(0, k.yaw + Math.PI, 0);          // the jaws face forward (the model's +z is the hinge side)
      g.scale.setScalar(sz * 1.3 * (1 + cs.bite * 0.15));
      // jaws: wide open while waiting (breathing), snap shut on a bite
      const open = cs.bite > 0 ? (1 - cs.bite) * 0.15 : 0.45 + Math.sin(ctx.time * 7) * 0.12;
      g.userData.top.rotation.x = -open;
      g.userData.bot.rotation.x = open * 0.6;
      g.visible = true;
      if (cs.bite > 0.95 && ctx.effects) ctx.effects.emit('spark', st.p, st.crumbs);
    }
  },
  disposeVisuals(ctx) { if (ctx.state.heads) ctx.state.heads.clear(); },

  callout: 'CHOMPED!',
});
