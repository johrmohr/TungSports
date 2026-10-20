// Granita Freeze (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A2, §C7, §C9).
//
// On pickup three frosty granita scoops orbit the kart (radius
// ITEM5.granitaOrbitRadius, 0.6 m up, like the orbiting triples). Each one
// blocks one incoming attack — native shells collide with them (`solid`), and
// plugin projectiles ask the `shield` hook below — and a rival that touches
// one is FROZEN. The press flings every remaining scoop as a ±ITEM5.granitaSpread°
// fan (backward with the brake) at max(granitaSpeed x cc, speed + granitaBoost)
// m/s; they live ITEM5.granitaLife s and shatter on walls. A hit freezes the
// victim for HIT.iceTime s (kart.freeze: no input, slides straight, decelerating)
// and costs 1 lira (light). Stars / ghosts / giants are immune (a star rams
// through). The same blockers as the fireballs stop the flung scoops. Losing the
// orbit (the owner hit) loses the item.
//
// CPU: flings at a rival 8-35 m ahead within ±20°, backward at a rival < 10 m
// behind when nobody is ahead, otherwise keeps the shield for up to 10 s.

import * as THREE from 'three';
import { registerItem } from './registry.js';
import { ITEM5, ITEM, HIT } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';

const ORB_R = 0.5, ORB_H = 0.6, ORB_SPEED = 4.2, CAP = 24, DEG = Math.PI / 180;

registerSound('granitaGet', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  [0, 7, 12].forEach((st, i) => SYNTH.bell(ac, out, t + i * 0.05, SYNTH.mtof(84 + st) * p, 0.05, 0.4));
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 6000, dur: 0.3, peak: 0.05 });
  return 0.45;
}, 1.3);
registerSound('granitaThrow', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 2800, f1: 7000, sweep: 0.15, dur: 0.2, peak: 0.16 });
  SYNTH.blip(ac, out, t, { type: 'triangle', f0: 1700 * p, f1: 900 * p, glide: 0.12, dur: 0.14, peak: 0.08 });
  return 0.25;
}, 1.4);
registerSound('granitaFreeze', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a crackle of ice forming + a glassy chord
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 3500, dur: 0.35, peak: 0.2 });
  for (let i = 0; i < 5; i++) SYNTH.blip(ac, out, t + i * 0.035, { type: 'square', f0: (2400 + 300 * i) * p, f1: (1800 + 200 * i) * p, glide: 0.02, dur: 0.03, peak: 0.04 });
  SYNTH.bell(ac, out, t + 0.05, SYNTH.mtof(88) * p, 0.08, 0.9);
  SYNTH.bell(ac, out, t + 0.05, SYNTH.mtof(95) * p, 0.05, 0.7);
  return 0.9;
}, 1.3);
registerSound('granitaShatter', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 4200, dur: 0.16, peak: 0.16 });
  SYNTH.bell(ac, out, t, 2600 * p, 0.03, 0.25);
  return 0.25;
}, 1.2);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();

function orbsOf(ctx, kart) {
  const out = [];
  for (const e of ctx.sys.entities) if (e.plugin === ctx && e.active && e.kind === 'iceorb' && e.owner === kart) out.push(e);
  return out;
}
function dropSlot(kart) { if (kart.item === 'granita') { kart.item = null; kart.itemCount = 0; } }

function freezeHit(ctx, k, by) {
  if (!ctx.hit(k, 'freeze', { by, light: true, duration: HIT.iceTime })) return false;
  ctx.sfx('granitaFreeze', k);
  ctx.flash(k, 'BRAIN FREEZE!', '#8fe3ff', { size: 'medium', duration: 1.1, vibrate: [30, 20, 30, 20, 80] });
  return true;
}

registerItem('granita', {
  init(ctx) { ctx.state.mesh = null; },

  onGet(ctx, kart) {
    for (const e of orbsOf(ctx, kart)) ctx.remove(e, 'clear');
    const st = ctx.kstate(kart);
    st.angle = kart.yaw;
    for (let i = 0; i < 3; i++) {
      const e = ctx.spawn({
        kind: 'iceorb', role: 'shield', owner: kart, radius: ORB_R, solid: true,
        position: kart.position, data: { phase: (i / 3) * Math.PI * 2, seed: ctx.rng() * 6.28 },
      });
      placeOrb(ctx, e, st.angle);
    }
    ctx.sfx('granitaGet', kart);
    ctx.emit('item:deploy', { kart, item: 'granita' });
  },

  use(ctx, kart) {
    const orbs = orbsOf(ctx, kart);
    // the orbit was shot away: nothing left to throw (activated without the slot — e.g. a platter —
    // it flings a fresh set of three)
    if (!orbs.length && kart.item === 'granita') { dropSlot(kart); return false; }
    const back = (kart.input && kart.input.brake || 0) > 0.5;
    const n = orbs.length || 3;
    const base = kart.yaw + (back ? Math.PI : 0);
    const speed = back ? ITEM5.granitaSpeed * ctx.ccMult : Math.max(ITEM5.granitaSpeed * ctx.ccMult, kart.speed + ITEM5.granitaBoost * ctx.ccMult);
    const fx = Math.sin(base), fz = Math.cos(base);
    for (let i = 0; i < n; i++) {
      const off = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * ITEM5.granitaSpread * DEG;
      const yaw = base + off;
      if (orbs[i]) ctx.remove(orbs[i], 'use');
      const e = ctx.spawn({
        kind: 'iceball', role: 'projectile', owner: kart, radius: ITEM5.granitaRadius, height: 0.55,
        position: { x: kart.position.x + fx * 1.9 + Math.sin(yaw) * 0.2, y: kart.position.y, z: kart.position.z + fz * 1.9 + Math.cos(yaw) * 0.2 },
        dir: { x: Math.sin(yaw), z: Math.cos(yaw) }, speed, life: ITEM5.granitaLife,
        threat: true, clear: 2.4, solid: true, ownerGrace: ITEM.shooterGrace, data: { seed: ctx.rng() * 6.28 },
      });
      ctx.keepOnRoad(e, ITEM5.granitaRadius + 0.1);
      e.position.y = e.proj.height + e.height;
    }
    ctx.sfx('granitaThrow', kart);
    ctx.emit('item:granitaThrow', { kart, back, count: n });
    return true;
  },

  update(ctx, dt) {
    // orbit angle per kart with orbs
    const owners = new Set();
    for (const e of ctx.sys.entities) if (e.plugin === ctx && e.active && e.kind === 'iceorb') owners.add(e.owner);
    for (const k of owners) { const st = ctx.kstate(k); st.angle = (st.angle || 0) + ORB_SPEED * dt; }
    for (const k of ctx.karts) if (k.item === 'granita' && !k.rolling && !owners.has(k)) dropSlot(k);   // every scoop shot away
    const list = ctx.entities();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.active) continue;
      if (e.kind === 'iceorb') {
        const k = e.owner;
        if (!k || k.item !== 'granita') { ctx.remove(e, 'lost'); continue; }
        placeOrb(ctx, e, ctx.kstate(k).angle);
        // rivals touching an orbiting scoop get frozen (the scoop is used up)
        for (const o of ctx.kartsTouching(e.position, e.radius, { dy: 1.6, yOff: 0.5, skip: k })) {
          if (ctx.immune(o)) { ctx.remove(e, 'smash'); break; }
          if (freezeHit(ctx, o, k)) { ctx.remove(e, 'hit'); break; }
        }
        if (!e.active) { if (!orbsOf(ctx, k).length) dropSlot(k); continue; }
        // they sweep peels away like orbiting shells do
        if (ctx.smashAt(e.position, e.radius, { bananas: true, roles: [], dy: 1.6, max: 1 })) {
          ctx.remove(e, 'blocked');
          if (!orbsOf(ctx, k).length) dropSlot(k);
        }
        continue;
      }
      // a flung scoop
      const res = ctx.stepStraight(e, dt, { bounce: false });
      if (res === 'wall') { ctx.remove(e, 'wall'); continue; }
      const pos = e.position;
      if (ctx.shieldAt(pos, e.radius, e.owner, { entity: e, kind: 'iceball', dir: e.dir })) { ctx.remove(e, 'blocked'); continue; }
      let gone = false;
      for (const k of ctx.kartsTouching(pos, e.radius, { dy: 1.8, yOff: 0.5 })) {
        if (k === e.owner && e.age < e.ownerGrace) continue;
        if (ctx.immune(k) || !k.isHittable()) { ctx.remove(e, 'smash'); gone = true; break; }
        if (freezeHit(ctx, k, e.owner)) { ctx.remove(e, 'hit'); gone = true; break; }
      }
      if (gone) continue;
      if (ctx.smashAt(pos, e.radius, { bananas: true, projectiles: true, roles: ['hazard'], owner: e.owner, ownerGrace: 0.3, max: 1 })) ctx.remove(e, 'smash');
    }
  },

  // orbiting scoops shield their kart from plugin projectiles too
  shield(ctx, pos, r, owner, info) {
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || e.kind !== 'iceorb' || e.owner === owner) continue;
      const rr = r + e.radius + 0.3;
      const dx = e.position.x - pos.x, dz = e.position.z - pos.z;
      if (dx * dx + dz * dz > rr * rr || Math.abs(e.position.y - pos.y) > 1.6) continue;
      const k = e.owner;
      ctx.remove(e, 'blocked');
      if (!orbsOf(ctx, k).length) dropSlot(k);
      return { kart: k, ref: e, item: info.item };
    }
    return null;
  },

  onKartHit(ctx, kart) {
    const orbs = orbsOf(ctx, kart);
    if (!orbs.length) return;
    for (const e of orbs) ctx.remove(e, 'lost');
    dropSlot(kart);
  },

  countLive(ctx) {
    const seen = new Set();
    for (const e of ctx.sys.entities) if (e.plugin === ctx && e.active && e.kind === 'iceball' && e.owner && e.owner.item !== 'granita') seen.add(e.owner);
    return seen.size;
  },

  onEntityRemove(ctx, e, reason) {
    if (reason === 'clear' || reason === 'use') return;
    if (ctx.effects) {
      _p.copy(e.position);
      ctx.effects.emit('splash', _p, { count: 18, color: 0xdff6ff, spread: 5, size: 0.16 });
      ctx.effects.emit('sparkle', _p, { count: 8, color: 0xbfefff, spread: 3 });
    }
    if (reason !== 'hit') ctx.sfx('granitaShatter', e.position, 0.8);
  },

  aiUse(kart, c) {
    if (c.rivalAhead(8, 35, 0.35)) return true;
    if (c.rivalBehind(1.5, 10, 3.5) && !c.rivalAhead(3, 50, 0.6)) return { use: true, brake: true };
    return c.hold > 10;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE;
    const parts = [];
    // a frosty shaved-ice scoop: faceted icy ball, a pink syrup cap and a mint leaf
    const ball = new T.IcosahedronGeometry(ORB_R, 2);
    const pos = ball.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const n = 1 + 0.08 * Math.sin(x * 31 + z * 17) * Math.cos(y * 23);
      pos.setXYZ(i, x * n, y * n, z * n);
    }
    ball.computeVertexNormals();
    parts.push(ctx.part(ball, 0xe8f8ff));
    parts.push(ctx.part(new T.SphereGeometry(ORB_R * 1.06, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.3), 0xff4f8e, { pos: [0, 0.01, 0] }));
    // syrup drips running down the sides + sugar crystals
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05 + 0.3;
      parts.push(ctx.part(new T.SphereGeometry(0.07, 6, 5), 0xff4f8e, { scale: [1, 2.2, 1], pos: [Math.sin(a) * ORB_R * 0.86, ORB_R * 0.42, Math.cos(a) * ORB_R * 0.86] }));
    }
    for (let i = 0; i < 10; i++) {
      const a = i * 2.4, y = -0.2 + (i % 5) * 0.08;
      parts.push(ctx.part(new T.OctahedronGeometry(0.035, 0), 0xffffff, { pos: [Math.sin(a) * ORB_R * 0.98, y, Math.cos(a) * ORB_R * 0.98] }));
    }
    parts.push(ctx.part(new T.SphereGeometry(0.12, 8, 5), 0x4fbf5a, { scale: [1.5, 0.25, 0.7], rot: new T.Euler(0.3, 0.5, 0.2), pos: [0.08, ORB_R * 0.92, 0.05] }));
    const geo = ctx.mergeParts(parts);
    const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0.05, emissive: 0x3a6a80, emissiveIntensity: 0.6, flatShading: true });
    ctx.state.mesh = ctx.instanced(geo, mat, CAP, 'granita-scoops', { shadow: true });
  },

  updateVisuals(ctx, dt) {
    const m = ctx.state.mesh;
    if (!m) return;
    const t = ctx.time;
    let i = 0;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || i >= CAP) continue;
      _e.set(t * 1.3 + e.data.seed, t * 2.1 + e.data.seed, 0);
      _q.setFromEuler(_e);
      _s.setScalar(Math.min(1, 0.4 + e.age * 4));
      m.setMatrixAt(i++, _m.compose(e.position, _q, _s));
      if (ctx.effects && e.kind === 'iceball' && Math.random() < dt * 40) ctx.effects.emit('sparkle', e.position, { count: 1, color: 0xcff4ff, spread: 0.8, radius: 0.3 });
    }
    m.count = i;
    m.visible = i > 0;
    m.instanceMatrix.needsUpdate = true;
  },

  callout: 'FROZEN!',
});

function placeOrb(ctx, e, angle) {
  const k = e.owner, th = angle + e.data.phase, R = ITEM5.granitaOrbitRadius;
  e.position.set(k.position.x + Math.sin(th) * R, k.position.y + ORB_H, k.position.z + Math.cos(th) * R);
  ctx.track.project(e.position, e.hint, e.proj);
  e.hint = e.proj.index;
  e.s = e.proj.s;
  e.lateral = e.proj.lateral;
}
