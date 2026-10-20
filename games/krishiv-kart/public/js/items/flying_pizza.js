// Flying Pizza (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A3, §C7, §C9).
//
// Three throws (ITEM_INFO uses 3). A spinning pizza flies out forward (backward
// with the brake) at max(pizzaOutSpeed x cc, speed + pizzaOutBoost) m/s for
// ITEM5.pizzaOutTime s (~35 m), drifting gently toward the road centre; at the
// end of the out leg (or at a wall) it turns and homes back to its thrower at
// max(pizzaBackSpeed x cc, owner speed + pizzaBackBoost) for up to
// ITEM5.pizzaBackTime s and is caught within ITEM5.pizzaCatch m. It PIERCES:
// every kart it touches spins and loses 1 lira (once per kart per throw), on
// the way out and on the way back; it also cuts through peels, prank boxes,
// lemons, coal and stink clouds on its way. The thrower is never hit by it.
// While it is out the slot stays greyed (kart.itemBusy) and presses do nothing;
// a pizza that is not caught is lost, and with it the throws that were left.
// Orbiting shields (both gone), the parm wheel, the accordion and star / giant
// karts stop it.
//
// CPU: throws at a rival 5-30 m ahead within ±20°, back at a rival < 12 m
// behind, otherwise after 6 s.

import * as THREE from 'three';
import { registerItem } from './registry.js';
import { ITEM5 } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';

const CAP = 8, CENTER_TURN = 0.7, HOME_TURN = 8, CLOSE_TURN = 2.2;

registerSound('pizzaThrow', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a whirring frisbee "whup-whup"
  for (let i = 0; i < 4; i++) SYNTH.hiss(ac, out, t + i * 0.07, { f0: 900 + 200 * i, f1: 1800, dur: 0.06, peak: 0.12 - i * 0.02, Q: 2.5 });
  SYNTH.blip(ac, out, t, { type: 'triangle', f0: 380 * p, f1: 620 * p, glide: 0.2, dur: 0.24, peak: 0.08 });
  return 0.35;
}, 1.4);
registerSound('pizzaHit', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a doughy "SPLAT-thwap"
  SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 1600, f1: 400, sweep: 0.15, dur: 0.2, peak: 0.26 });
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 240 * p, f1: 90 * p, glide: 0.1, dur: 0.16, peak: 0.24 });
  return 0.3;
}, 1.4);
registerSound('pizzaCatch', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'square', f0: 660 * p, f1: 990 * p, glide: 0.05, dur: 0.07, peak: 0.07, lp: 3000 });
  SYNTH.blip(ac, out, t + 0.07, { type: 'square', f0: 990 * p, f1: 1320 * p, glide: 0.05, dur: 0.09, peak: 0.07, lp: 3000 });
  return 0.2;
}, 1.3);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _v = new THREE.Vector3();
const _f = {};

function busyOff(kart) { kart.itemBusy = false; }

registerItem('flying_pizza', {
  init(ctx) { ctx.state.mesh = null; },

  use(ctx, kart) {
    if (kart.itemBusy) return false;                       // the pizza is still out
    const back = (kart.input && kart.input.brake || 0) > 0.5;
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw), sgn = back ? -1 : 1;
    const speed = back ? ITEM5.pizzaOutSpeed * ctx.ccMult : Math.max(ITEM5.pizzaOutSpeed * ctx.ccMult, kart.speed + ITEM5.pizzaOutBoost * ctx.ccMult);
    const e = ctx.spawn({
      kind: 'pizza', role: 'projectile', owner: kart, radius: ITEM5.pizzaRadius, height: ITEM5.pizzaHeight,
      position: { x: kart.position.x + fx * 2.0 * sgn, y: kart.position.y, z: kart.position.z + fz * 2.0 * sgn },
      dir: { x: fx * sgn, z: fz * sgn }, speed, threat: true, clear: 2.6, ownerGrace: 1e9, phase: 'out',
      data: { t: 0, spin: ctx.rng() * 6.28, back },
    });
    ctx.keepOnRoad(e, ITEM5.pizzaRadius);
    e.position.y = e.proj.height + e.height;
    // the throw that leaves the slot greyed (the last one empties it)
    if (kart.itemCount > 1 && kart.item === 'flying_pizza') kart.itemBusy = true;
    ctx.sfx('pizzaThrow', kart);
    ctx.emit('item:pizzaThrow', { kart, entity: e, back });
    return true;
  },

  update(ctx, dt) {
    for (const k of ctx.karts) if (k.itemBusy && k.item !== 'flying_pizza') k.itemBusy = false;   // the slot changed (dropped / swapped)
    const list = ctx.entities();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.active) continue;
      const d = e.data, k = e.owner;
      d.t += dt;
      if (e.phase === 'out') {
        // drift gently toward the road centre
        const f = ctx.frameAt(ctx.wrapS(e.s + (d.back ? -8 : 8)), _f);
        ctx.pointAt(f.s, e.lateral * 0.8, _v);
        ctx.steerToward(e, _v, CENTER_TURN, dt);
        const res = ctx.stepStraight(e, dt, { bounce: false });
        if (d.t >= ITEM5.pizzaOutTime || res === 'wall') { e.phase = 'back'; d.t = 0; }
      } else {
        if (!k || d.t > ITEM5.pizzaBackTime) { ctx.remove(e, 'lost'); continue; }
        e.speed = Math.max(ITEM5.pizzaBackSpeed * ctx.ccMult, Math.abs(k.speed) + ITEM5.pizzaBackBoost * ctx.ccMult);
        const dx = k.position.x - e.position.x, dz = k.position.z - e.position.z, dist = Math.max(1, Math.hypot(dx, dz));
        ctx.steerToward(e, k.position, Math.max(HOME_TURN, (e.speed * CLOSE_TURN) / dist), dt);
        ctx.stepStraight(e, dt, { bounce: false });
        const cx = k.position.x - e.position.x, cz = k.position.z - e.position.z;
        if (cx * cx + cz * cz <= ITEM5.pizzaCatch * ITEM5.pizzaCatch) { ctx.remove(e, 'caught'); continue; }
      }
      e.position.y = e.proj.height + e.height;
      const pos = e.position;
      // orbiting shields stop it (both gone)
      if (ctx.shieldAt(pos, e.radius, k, { entity: e, kind: 'pizza', dir: e.dir, peels: false })) { ctx.remove(e, 'blocked'); continue; }
      // it pierces every kart in its way (once per kart per throw)
      let gone = false;
      for (const o of ctx.kartsTouching(pos, e.radius, { dy: 1.6, yOff: 0.5, skip: k })) {
        if (ctx.immune(o)) { ctx.remove(e, 'smash'); gone = true; break; }
        const j = ctx.karts.indexOf(o), bit = 1 << (j & 31);
        if (e.hitMask & bit) continue;
        if (ctx.hit(o, 'spin', { by: k, light: true })) {
          e.hitMask |= bit;
          ctx.sfx('pizzaHit', o);
          ctx.flash(o, 'DELIVERED!', '#ffb347', { size: 'medium', duration: 0.9, vibrate: [40, 30, 60] });
        }
      }
      if (gone) continue;
      ctx.smashAt(pos, e.radius, { bananas: true, stink: true, roles: ['hazard'], owner: k, ownerGrace: 0.5, dy: 1.8 });
    }
  },

  onEntityRemove(ctx, e, reason) {
    const k = e.owner;
    if (reason === 'caught') {
      if (k) { busyOff(k); ctx.sfx('pizzaCatch', k); ctx.emit('item:pizzaCatch', { kart: k }); }
      return;
    }
    // not caught: the throws that were left go with it
    if (k && k.itemBusy) { busyOff(k); if (k.item === 'flying_pizza') { k.item = null; k.itemCount = 0; } }
    if (!ctx.effects || reason === 'clear') return;
    _p.copy(e.position);
    ctx.effects.emit('splash', _p, { count: 16, color: 0xffd36b, spread: 4.5, size: 0.18 });
    ctx.effects.emit('splash', _p, { count: 10, color: 0xd8341c, spread: 4, size: 0.15 });
  },

  countLive(ctx) {
    const seen = new Set();
    for (const e of ctx.sys.entities) if (e.plugin === ctx && e.active && e.owner && e.owner.item !== 'flying_pizza') seen.add(e.owner);
    return seen.size;
  },

  clear(ctx) { for (const k of ctx.karts) k.itemBusy = false; },

  aiUse(kart, c) {
    if (kart.itemBusy) { c.mem.lastThrow = c.hold; return false; }
    const go = (r) => { c.mem.lastThrow = c.hold; return r; };
    if (c.rivalAhead(5, 30, 0.35)) return go(true);
    if (c.rivalBehind(1.5, 12, 3.5)) return go({ use: true, brake: true });
    return c.hold - (c.mem.lastThrow || 0) > 6 ? go(true) : false;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE, R = ITEM5.pizzaRadius;
    const parts = [];
    parts.push(ctx.part(new T.CylinderGeometry(R * 0.93, R * 0.93, 0.08, 32), 0xffd65a));               // cheese
    parts.push(ctx.part(new T.CylinderGeometry(R * 0.95, R * 0.9, 0.06, 32), 0xd8432a, { pos: [0, -0.035, 0] }));   // sauce rim under
    parts.push(ctx.part(new T.TorusGeometry(R * 0.93, 0.085, 8, 36), 0xd99a4a, { rot: new T.Euler(Math.PI / 2, 0, 0), pos: [0, 0.01, 0] }));  // crust
    parts.push(ctx.part(new T.CylinderGeometry(R * 0.9, R * 0.9, 0.04, 32), 0xe6b060, { pos: [0, -0.07, 0] }));   // base
    // pepperoni + basil + melty highlights
    const tops = [[0.42, 0.1], [-0.3, 0.38], [-0.2, -0.42], [0.18, -0.2], [0.05, 0.55], [-0.52, -0.05]];
    for (const [x, z] of tops) parts.push(ctx.part(new T.CylinderGeometry(0.12, 0.12, 0.03, 12), 0xb8231c, { pos: [x * R * 1.1, 0.05, z * R * 1.1] }));
    for (const [x, z, a] of [[0.15, 0.25, 0.4], [-0.35, -0.3, 1.9], [0.45, -0.3, 3.1]]) {
      parts.push(ctx.part(new T.SphereGeometry(0.09, 8, 4), 0x2e9a3a, { scale: [1.6, 0.25, 0.8], rot: new T.Euler(0, a, 0), pos: [x * R, 0.07, z * R] }));
    }
    for (let i = 0; i < 8; i++) {
      const a = i * 0.78 + 0.2, r = R * (0.25 + 0.5 * ((i * 0.41) % 1));
      parts.push(ctx.part(new T.SphereGeometry(0.07, 6, 4), 0xfff1b0, { scale: [1.5, 0.3, 1], pos: [Math.sin(a) * r, 0.055, Math.cos(a) * r] }));
    }
    const geo = ctx.mergeParts(parts);
    const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 });
    ctx.state.mesh = ctx.instanced(geo, mat, CAP, 'flying-pizzas', { shadow: true });
  },

  updateVisuals(ctx, dt) {
    const m = ctx.state.mesh;
    if (!m) return;
    let i = 0;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || i >= CAP) continue;
      e.data.spin += dt * 22;
      const yaw = Math.atan2(e.dir.x, e.dir.z);
      _e.set(0.18 * (e.phase === 'out' ? 1 : -1), yaw, 0.12, 'YXZ');
      _q.setFromEuler(_e);
      _q.multiply(_q2.setFromAxisAngle(_v.set(0, 1, 0), e.data.spin));
      _s.setScalar(Math.min(1, 0.5 + e.age * 6));
      m.setMatrixAt(i++, _m.compose(e.position, _q, _s));
      if (ctx.effects && Math.random() < dt * 25) ctx.effects.emit('sparkle', e.position, { count: 1, color: 0xffe6a0, spread: 0.6, radius: 0.5 });
    }
    m.count = i;
    m.visible = i > 0;
    m.instanceMatrix.needsUpdate = true;
  },

  callout: 'DELIVERED!',
});
