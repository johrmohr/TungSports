// Parmesan Wheel (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A6, §C7, §C9).
//
// A giant rolling cheese wheel (radius ITEM5.wheelRadius) fired forward — or
// back with the brake held — at max(wheelSpeed x cc, speed + wheelBoost). It
// reflects off up to ITEM5.wheelBounces walls and lives ITEM5.wheelLife s.
// Every non-immune kart it touches TUMBLES (once per kart per ITEM5.wheelRehit
// s) and it keeps rolling. It flattens every hazard and projectile in its way
// (not the Capo Crusher) and breaks orbiting shields without stopping. Nothing
// destroys it (`sturdy` + `solid`: native shells and bombs break on it): an
// Accordion Blast only deflects it, and a star / giant kart bounces it off.
// At most 1 in play (ITEM_RULES).
//
// CPU: with a rival 10-60 m ahead and the next 40 m fairly straight; back with a
// rival < 12 m behind; otherwise after 8 s.

import * as THREE from 'three';
import { registerItem } from './registry.js';
import { ITEM5, ITEM } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';

const LAUNCH = 2.6, HIT_R = 1.35, CAP = 3;

registerSound('wheelLaunch', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.kickDrum(ac, out, t, 1.2);
  SYNTH.blip(ac, out, t, { type: 'sawtooth', f0: 70 * p, f1: 48 * p, glide: 0.5, dur: 0.7, peak: 0.16, lp: 260 });
  SYNTH.hiss(ac, out, t + 0.04, { type: 'lowpass', f0: 500, dur: 0.6, peak: 0.12 });
  return 0.8;
}, 1.3);
registerSound('wheelBonk', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a deep wooden-cheesy "BONK"
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 190 * p, f1: 85 * p, glide: 0.12, dur: 0.3, peak: 0.36 });
  SYNTH.blip(ac, out, t, { type: 'triangle', f0: 620 * p, f1: 300 * p, glide: 0.05, dur: 0.1, peak: 0.12 });
  SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 1200, dur: 0.12, peak: 0.16 });
  return 0.35;
}, 1.4);
registerSound('wheelThud', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.kickDrum(ac, out, t, 0.8);
  SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 700 * p, dur: 0.18, peak: 0.1 });
  return 0.25;
}, 1.2);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _v = new THREE.Vector3();

registerItem('parm_wheel', {
  init(ctx) { ctx.state.mesh = null; },

  use(ctx, kart) {
    const back = (kart.input && kart.input.brake || 0) > 0.5;
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw), sgn = back ? -1 : 1;
    const speed = back ? ITEM5.wheelSpeed * ctx.ccMult : Math.max(ITEM5.wheelSpeed * ctx.ccMult, kart.speed + ITEM5.wheelBoost * ctx.ccMult);
    const e = ctx.spawn({
      kind: 'wheel', role: 'projectile', owner: kart, radius: ITEM5.wheelRadius, height: ITEM5.wheelRadius, life: ITEM5.wheelLife,
      position: { x: kart.position.x + fx * LAUNCH * sgn, y: kart.position.y, z: kart.position.z + fz * LAUNCH * sgn },
      dir: { x: fx * sgn, z: fz * sgn }, speed, threat: true, clear: ITEM5.wheelRadius + 1.5, solid: true, sturdy: true, counts: true,
      ownerGrace: ITEM.shooterGrace, data: { roll: 0, hitAt: new Float64Array(ctx.karts.length).fill(-1e9), wob: ctx.rng() * 6.28 },
    });
    ctx.keepOnRoad(e, ITEM5.wheelRadius * 0.6);
    e.position.y = e.proj.height + e.height;
    ctx.sfx('wheelLaunch', kart);
    ctx.emit('item:wheelLaunch', { kart, entity: e, back });
    return true;
  },

  update(ctx, dt) {
    const list = ctx.entities();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.active) continue;
      const res = ctx.stepStraight(e, dt);
      e.data.roll += (e.speed * dt) / ITEM5.wheelRadius;
      if (res === 'bounce') {
        if (e.bounces > ITEM5.wheelBounces) { ctx.remove(e, 'wall'); continue; }
        ctx.sfx('wheelThud', e.position, 0.9);
        if (ctx.effects) ctx.effects.emit('dust', e.position, { count: 8, spread: 3, size: 0.8 });
      }
      // karts: tumble (a star / giant kart bounces it off instead)
      const now = ctx.time;
      const ks = ctx.karts;
      for (let j = 0; j < ks.length; j++) {
        const k = ks[j];
        if (k === e.owner && e.age < e.ownerGrace) continue;
        if (!ctx.touches(k, e.position, HIT_R, 2.4, 0.5 + ITEM5.wheelRadius * 0.4)) continue;
        if (now - e.data.hitAt[j] < ITEM5.wheelRehit) continue;
        e.data.hitAt[j] = now;
        if (ctx.immune(k)) {
          // bounced off: reflect the heading away from the kart
          const dx = e.position.x - k.position.x, dz = e.position.z - k.position.z, dl = Math.hypot(dx, dz) || 1;
          const nx = dx / dl, nz = dz / dl, dn = e.dir.x * nx + e.dir.z * nz;
          if (dn < 0) { e.dir.x -= 2 * dn * nx; e.dir.z -= 2 * dn * nz; const l = Math.hypot(e.dir.x, e.dir.z) || 1; e.dir.x /= l; e.dir.z /= l; }
          ctx.sfx('wheelBonk', e.position, 0.8, 1.2);
          continue;
        }
        if (ctx.hit(k, 'tumble', { by: e.owner })) {
          ctx.sfx('wheelBonk', k);
          ctx.flash(k, 'CHEESED!', '#f4d27a', { size: 'medium', duration: 1, vibrate: [90, 40, 90] });
        }
      }
      // it flattens hazards and projectiles (natives and plugins'), breaks orbiting shields
      ctx.smashAt(e.position, ITEM5.wheelRadius * 0.9, { bananas: true, stink: false, projectiles: true, bombs: true, roles: ['hazard', 'projectile'], skip: e, dy: 2.6 });
      _v.set(e.position.x, e.position.y - ITEM5.wheelRadius + 0.6, e.position.z);
      ctx.shieldAt(_v, ITEM5.wheelRadius, e.owner, { entity: e, kind: 'wheel', dir: e.dir, pierce: true, peels: true });
      if (ctx.effects && Math.random() < dt * 14) {
        _v.set(e.position.x - e.dir.x * 1.2, e.position.y - ITEM5.wheelRadius + 0.15, e.position.z - e.dir.z * 1.2);
        ctx.effects.emit('dust', _v, { count: 2, spread: 1.6, size: 0.55 });
      }
    }
  },

  // an Accordion Blast deflects the wheel (it is sturdy: blasts do not remove it)
  clearAround(ctx, at, R, by, kind) {
    if (kind !== 'accordion') return 0;
    for (const e of ctx.entities()) {
      const dx = e.position.x - at.x, dz = e.position.z - at.z;
      if (dx * dx + dz * dz > R * R) continue;
      const dl = Math.hypot(dx, dz) || 1;
      e.dir.x = dx / dl; e.dir.z = dz / dl;
      ctx.sfx('wheelBonk', e.position, 0.9, 0.8);
      ctx.emit('item:wheelDeflect', { kart: by, entity: e });
    }
    return 0;
  },

  onEntityRemove(ctx, e, reason) {
    if (!ctx.effects || reason === 'clear') return;
    _p.set(e.position.x, e.position.y, e.position.z);
    ctx.effects.emit('dust', _p, { count: 18, spread: 5, size: 1.1 });
    ctx.effects.emit('splash', _p, { count: 20, color: 0xf6dc8a, spread: 6, size: 0.24 });
  },

  aiUse(kart, c) {
    if (c.rivalBehind(1.5, 12, 3.5) && !c.rivalAhead(4, 40, 0.4)) return { use: true, brake: true };
    if (c.rivalAhead(10, 60, 0.45)) {
      const tr = c.track;
      let straight = true;
      for (let d = 0; d <= 40; d += 4) if (Math.abs(tr.curv[tr.indexAt(c.s + d)]) > 1 / 60) { straight = false; break; }
      if (straight) return true;
    }
    return c.hold > 8;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE, R = ITEM5.wheelRadius, W = 1.2;
    const parts = [];
    // the rind: a bulging (convex) straw-gold band, lathe-turned around the axle (local x)
    const prof = [];
    for (let i = 0; i <= 10; i++) {
      const u = i / 10, x = (u - 0.5) * W;
      prof.push(new T.Vector2(R * (0.9 + 0.1 * Math.sin(u * Math.PI)), x));
    }
    parts.push(ctx.part(new T.LatheGeometry(prof, 40), 0xe0a640, { rot: new T.Euler(0, 0, -Math.PI / 2) }));
    for (const s of [-1, 1]) {
      // the cut faces: pale, crumbly cream with crystals, a darker rim of rind
      parts.push(ctx.part(new T.CircleGeometry(R * 0.9, 40), 0xf7e6ad, { rot: new T.Euler(0, s * Math.PI / 2, 0), pos: [s * W / 2, 0, 0] }));
      parts.push(ctx.part(new T.TorusGeometry(R * 0.885, 0.05, 6, 40), 0xc28a2e, { rot: new T.Euler(0, Math.PI / 2, 0), pos: [s * W / 2, 0, 0] }));
      for (let i = 0; i < 16; i++) {
        const a = i * 2.39996, r = R * 0.8 * Math.sqrt((i + 0.5) / 16);
        parts.push(ctx.part(new T.CircleGeometry(0.05 + 0.03 * (i % 3), 6), i % 2 ? 0xfff6d2 : 0xe9cf86, {
          rot: new T.Euler(0, s * Math.PI / 2, 0), pos: [s * (W / 2 + 0.006), Math.sin(a) * r, Math.cos(a) * r],
        }));
      }
    }
    // the dotted stamp all round the rind (an aged wheel's pin-dot lettering band — dots only, no words)
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2 + row * 0.05, x = (row - 1) * 0.22;
        const rr = R * (0.9 + 0.1 * Math.cos((x / W) * Math.PI)) + 0.005;
        parts.push(ctx.part(new T.SphereGeometry(0.035, 5, 4), 0x9c6a1e, { scale: [1, 1, 0.4], rot: new T.Euler(a, 0, 0), pos: [x, Math.cos(a) * rr, Math.sin(a) * rr] }));
      }
    }
    const geo = ctx.mergeParts(parts);
    const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, side: T.DoubleSide });
    ctx.state.mesh = ctx.instanced(geo, mat, CAP, 'parm-wheels', { shadow: true, receive: true });
  },

  updateVisuals(ctx) {
    const m = ctx.state.mesh;
    if (!m) return;
    let i = 0;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || i >= CAP) continue;
      // axle = right of the heading, rolling forward about it
      _z.set(e.dir.x, 0, e.dir.z).normalize();
      _x.crossVectors(_up, _z).normalize();
      _y.crossVectors(_z, _x);
      _m.makeBasis(_x, _y, _z);
      _q.setFromRotationMatrix(_m);
      _q2.setFromAxisAngle(_x.set(1, 0, 0), e.data.roll);
      _q.multiply(_q2);
      const born = Math.min(1, e.age / 0.15), left = e.life - e.age;
      _s.setScalar(Math.max(0.01, (0.4 + 0.6 * born) * (left < 0.4 ? left / 0.4 : 1)));
      _p.set(e.position.x, e.position.y + Math.abs(Math.sin(e.data.roll * 2 + e.data.wob)) * 0.05, e.position.z);
      m.setMatrixAt(i++, _m.compose(_p, _q, _s));
    }
    m.count = i;
    m.visible = i > 0;
    m.instanceMatrix.needsUpdate = true;
  },

  callout: 'CHEESED!',
});
