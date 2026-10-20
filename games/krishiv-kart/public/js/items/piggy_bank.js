// Piggy Bank (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A5, §C7, §C9).
//
// A glossy ceramic piggy bank on little wheels. Forward, it rolls down the
// track CENTRE LINE (lateral easing to 0 at 3 m/s, so it ignores walls) at
// max(piggySpeed x cc, speed + piggyBoost) m/s, 0.5 m up, TUMBLING every
// non-immune kart in its path without stopping, and dropping a loose lira every
// ITEM5.piggyCoinEvery m (up to ITEM5.piggyTrailMax). After ITEM5.piggyLife s or
// ITEM5.piggyRange m — or on touching any item (a peel, shell, orbiter, pin, a
// hazard or a shield) or in a blast — it BURSTS into a ring of ITEM5.piggyRing
// loose lire (ITEM5.piggyRingRadius m). With the brake held it is thrown
// straight back like a bouncer (ITEM5.piggyBackBounces wall bounces,
// ITEM5.piggyBackLife s), still dropping coins. Loose lire are the coins
// system's (coins.js spillCoins; ctx.dropCoins → a dropLoose hook as the fallback).
//
// CPU: forward with any rival 15-120 m ahead on the track, or for the coins when
// it has <= 5; back at a rival < 10 m behind; otherwise after 6 s.

import * as THREE from 'three';
import { registerItem } from './registry.js';
import { ITEM5, ITEM } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';
import { spillCoins } from './coins.js';

const CAP = 4, RIDE = 0.5, LANE_RATE = 3;

registerSound('piggyLaunch', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a cheerful "oink-oink" (two nasal formant squeals) + wheels whirring off
  for (let i = 0; i < 2; i++) {
    SYNTH.blip(ac, out, t + i * 0.16, { type: 'sawtooth', f0: 520 * p, f1: 340 * p, glide: 0.1, dur: 0.12, peak: 0.1, lp: 1500, Q: 6 });
    SYNTH.blip(ac, out, t + i * 0.16, { type: 'square', f0: 260 * p, f1: 170 * p, glide: 0.1, dur: 0.12, peak: 0.05, lp: 900 });
  }
  SYNTH.hiss(ac, out, t + 0.25, { f0: 1200, f1: 2800, sweep: 0.2, dur: 0.25, peak: 0.07, Q: 2 });
  return 0.55;
}, 1.4);
registerSound('piggyBurst', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // ceramic smash + a shower of coin chimes
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 2600, dur: 0.22, peak: 0.3 });
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 300 * p, f1: 110 * p, glide: 0.1, dur: 0.16, peak: 0.24 });
  for (let i = 0; i < 6; i++) SYNTH.bell(ac, out, t + 0.06 + i * 0.045, SYNTH.mtof(88 + ((i * 5) % 12)) * p, 0.05, 0.35);
  return 0.6;
}, 1.3);
registerSound('piggyHit', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 260 * p, f1: 120 * p, glide: 0.1, dur: 0.18, peak: 0.3 });
  SYNTH.blip(ac, out, t + 0.03, { type: 'sawtooth', f0: 560 * p, f1: 380 * p, glide: 0.1, dur: 0.12, peak: 0.07, lp: 1500, Q: 6 });
  return 0.3;
}, 1.4);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();

// Loose lire through the coins system (group B: coins.js spillCoins); ctx.dropCoins is the generic fallback.
function coins(ctx, at, n, opts) {
  if (typeof spillCoins === 'function') return spillCoins(ctx.sys, at, n, opts);
  return ctx.dropCoins(at, n, opts);
}

function burst(ctx, e, reason = 'burst') {
  if (!e.active) return;
  ctx.remove(e, reason);
}

registerItem('piggy_bank', {
  init(ctx) { ctx.state.mesh = null; },

  use(ctx, kart) {
    const back = (kart.input && kart.input.brake || 0) > 0.5;
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw), sgn = back ? -1 : 1;
    const speed = back ? ITEM.bouncerSpeed * ctx.ccMult : Math.max(ITEM5.piggySpeed * ctx.ccMult, kart.speed + ITEM5.piggyBoost * ctx.ccMult);   // back: like a bouncer
    const e = ctx.spawn({
      kind: 'piggy', role: 'projectile', owner: kart, radius: 0.8, height: RIDE,
      position: { x: kart.position.x + fx * 2.0 * sgn, y: kart.position.y, z: kart.position.z + fz * 2.0 * sgn },
      dir: { x: fx * sgn, z: fz * sgn }, speed, life: back ? ITEM5.piggyBackLife : ITEM5.piggyLife,
      threat: true, clear: ITEM5.piggyHitRadius + 1.2, solid: true, ownerGrace: ITEM.shooterGrace, phase: back ? 'back' : 'lane',
      data: { start: 0, nextCoin: ITEM5.piggyCoinEvery, coins: 0, wheel: 0, seed: ctx.rng() * 6.28 },
    });
    if (back) { ctx.keepOnRoad(e, 0.9); e.position.y = e.proj.height + RIDE; }
    else { e.s = ctx.wrapS(kart.proj.s + 2.0); e.lateral = kart.proj.lateral || 0; }
    e.data.start = e.dist;
    ctx.sfx('piggyLaunch', kart);
    ctx.emit('item:piggyLaunch', { kart, entity: e, back });
    return true;
  },

  update(ctx, dt) {
    const list = ctx.entities();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.active) continue;
      const d = e.data;
      const d0 = e.dist;
      if (e.phase === 'lane') ctx.stepTrack(e, dt, { lateral: 0, rate: LANE_RATE });
      else {
        const x0 = e.position.x, z0 = e.position.z;
        const res = ctx.stepStraight(e, dt);
        e.dist = d0 + Math.hypot(e.position.x - x0, e.position.z - z0);
        if (res === 'bounce' && e.bounces > ITEM5.piggyBackBounces) { burst(ctx, e); continue; }
      }
      if (e.phase === 'lane') e.position.y = e.proj.height + RIDE;
      d.wheel += (e.speed * dt) / 0.18;
      const travelled = e.dist - d.start;
      // a lira every piggyCoinEvery m
      while (travelled >= d.nextCoin && d.coins < ITEM5.piggyTrailMax) {
        d.nextCoin += ITEM5.piggyCoinEvery;
        d.coins++;
        coins(ctx, e.position, 1, { speed: 1.2, up: 3, radius: 0.4, from: 'piggy_bank' });
        if (ctx.effects) ctx.effects.emit('glitter', e.position, { count: 4, spread: 1.5 });
      }
      if (travelled >= ITEM5.piggyRange) { burst(ctx, e); continue; }
      // karts in its path tumble; it keeps rolling (a star / giant kart breaks it)
      let gone = false;
      for (const k of ctx.kartsTouching(e.position, ITEM5.piggyHitRadius, { dy: 1.8, yOff: 0.5, kartRadius: 0 })) {
        if (k === e.owner && e.age < e.ownerGrace) continue;
        if (ctx.immune(k)) { burst(ctx, e, 'smash'); gone = true; break; }
        if (ctx.hit(k, 'tumble', { by: e.owner })) {
          ctx.sfx('piggyHit', k);
          ctx.flash(k, 'OINK!', '#ff8fb1', { size: 'medium', duration: 1, vibrate: [70, 40, 70] });
        }
      }
      if (gone) continue;
      // it bursts on touching any item (and on a shield)
      if (e.age > 0.12) {
        const hitItem = ctx.touchingItem(e.position, e.radius, { skip: e, owner: e.owner });
        if (hitItem) {
          if (hitItem.plugin) ctx.remove(hitItem, 'smash');
          else ctx.destroyNative(hitItem, 'blocked');
          burst(ctx, e);
          continue;
        }
        if (ctx.shieldAt(e.position, e.radius, e.owner, { entity: e, kind: 'piggy', dir: e.dir })) { burst(ctx, e); continue; }
      }
    }
  },

  onEntityRemove(ctx, e, reason) {
    if (reason === 'clear') return;
    // every way it ends — out of time / range, an item, a blast — breaks it open
    coins(ctx, e.position, ITEM5.piggyRing, { radius: ITEM5.piggyRingRadius, ring: true, from: 'piggy_bank' });
    ctx.sfx('piggyBurst', e.position, 1);
    ctx.emit('item:piggyBurst', { kart: e.owner, position: e.position, coins: ITEM5.piggyRing });
    if (ctx.effects) {
      _p.copy(e.position);
      ctx.effects.emit('spark', _p, { count: 22, color: 0xff9fc0, spread: 7 });
      ctx.effects.emit('glitter', _p, { count: 18, spread: 5, radius: 0.8 });
      ctx.effects.emit('dust', _p, { count: 6, spread: 2.5, size: 0.6, color: 0xffd6e4 });
    }
  },

  countLive(ctx) {
    const seen = new Set();
    for (const e of ctx.sys.entities) if (e.plugin === ctx && e.active && e.owner && e.owner.item !== 'piggy_bank') seen.add(e.owner);
    return seen.size;
  },

  aiUse(kart, c) {
    if (c.rivalBehind(1.5, 10, 3.5) && !c.rivalAhead(3, 50, 0.6)) return { use: true, brake: true };
    const tr = c.track;
    for (const o of c.karts) {
      if (o === kart || o.finished || !o.proj) continue;
      const ds = tr.deltaS(c.s, o.proj.s);
      if (ds > 15 && ds < 120) return true;
    }
    if ((kart.coins | 0) <= 5 && c.hold > 2) return true;
    return c.hold > 6;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE;
    const parts = [];
    const pink = 0xff9ec0, deep = 0xf07aa2;
    parts.push(ctx.part(new T.SphereGeometry(0.62, 22, 16), pink, { scale: [0.86, 0.82, 1.12], pos: [0, 0.55, 0] }));
    parts.push(ctx.part(new T.CylinderGeometry(0.2, 0.24, 0.2, 16), deep, { rot: new T.Euler(Math.PI / 2, 0, 0), pos: [0, 0.5, 0.74] }));          // snout
    for (const s of [-1, 1]) {
      parts.push(ctx.part(new T.CylinderGeometry(0.035, 0.035, 0.02, 8), 0x7a2a4a, { rot: new T.Euler(Math.PI / 2, 0, 0), pos: [s * 0.07, 0.52, 0.845] }));
      parts.push(ctx.part(new T.ConeGeometry(0.13, 0.24, 8), deep, { rot: new T.Euler(0.3, 0, s * 0.35), pos: [s * 0.3, 1.02, 0.32] }));             // ears
      parts.push(ctx.part(new T.SphereGeometry(0.07, 10, 8), 0x1a1020, { pos: [s * 0.2, 0.78, 0.6] }));                                              // eyes
      parts.push(ctx.part(new T.SphereGeometry(0.025, 6, 4), 0xffffff, { pos: [s * 0.2 + 0.02, 0.81, 0.66] }));
      parts.push(ctx.part(new T.SphereGeometry(0.08, 8, 6), 0xff6f9a, { scale: [1, 0.6, 0.4], pos: [s * 0.36, 0.6, 0.58] }));                        // blush
      for (const z of [-0.36, 0.36]) {
        parts.push(ctx.part(new T.CylinderGeometry(0.17, 0.17, 0.12, 14), 0x30242a, { rot: new T.Euler(0, 0, Math.PI / 2), pos: [s * 0.44, 0.18, z] }));   // wheels
        parts.push(ctx.part(new T.CylinderGeometry(0.07, 0.07, 0.13, 10), 0xf5c542, { rot: new T.Euler(0, 0, Math.PI / 2), pos: [s * 0.45, 0.18, z] }));
      }
    }
    parts.push(ctx.part(new T.BoxGeometry(0.06, 0.03, 0.34), 0x3a1626, { pos: [0, 1.06, -0.05] }));                                                 // coin slot
    parts.push(ctx.part(new T.TorusGeometry(0.09, 0.03, 6, 12, Math.PI * 1.6), deep, { rot: new T.Euler(0, Math.PI / 2, 0), pos: [0, 0.7, -0.76] }));   // curly tail
    // painted flowers on the flanks (ceramic decoration)
    for (const s of [-1, 1]) for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      parts.push(ctx.part(new T.SphereGeometry(0.06, 6, 4), 0xffffff, { scale: [0.3, 1, 1], pos: [s * 0.535, 0.62 + Math.sin(a) * 0.09, -0.12 + Math.cos(a) * 0.09] }));
    }
    const geo = ctx.mergeParts(parts);
    const mat = new T.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.2, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08 });
    ctx.state.mesh = ctx.instanced(geo, mat, CAP, 'piggy-banks', { shadow: true });
  },

  updateVisuals(ctx) {
    const m = ctx.state.mesh;
    if (!m) return;
    let i = 0;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || i >= CAP) continue;
      const yaw = Math.atan2(e.dir.x, e.dir.z);
      const bob = Math.abs(Math.sin(e.data.wheel * 0.25 + e.data.seed)) * 0.06;
      _e.set(Math.sin(e.data.wheel * 0.12) * 0.05, yaw, Math.sin(e.data.wheel * 0.17) * 0.07, 'YXZ');
      _q.setFromEuler(_e);
      _p.set(e.position.x, e.position.y - RIDE + bob, e.position.z);
      _s.setScalar(Math.min(1, 0.5 + e.age * 5));
      m.setMatrixAt(i++, _m.compose(_p, _q, _s));
    }
    m.count = i;
    m.visible = i > 0;
    m.instanceMatrix.needsUpdate = true;
  },

  callout: 'OINK!',
});
