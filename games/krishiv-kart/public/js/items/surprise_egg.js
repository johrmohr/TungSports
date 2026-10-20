// Surprise Egg (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A7, §C7, §C9).
//
// A foil-wrapped chocolate egg (radius ITEM5.eggRadius) launched at
// max(eggSpeed x cc, speed + eggBoost) m/s that homes on the kart one place
// ahead with the homing-rocket logic (rides the track toward it, then homes in
// within ITEM.rocketHomingRange m); from 1st it rolls straight. The kart it
// hits TUMBLES and the egg cracks open. It also cracks after ITEM5.eggLife s,
// against a wall (when rolling straight), on touching a hazard or projectile,
// on an orbiting shield / trailing peel / heart, or in a blast. A crack spills
// ITEM5.eggCapsules surprise capsules within ITEM5.eggSpill m on the road
// (radius ITEM5.eggCapsuleRadius, ITEM5.eggCapsuleLife s): a kart that drives
// through one with an empty slot (not rolling) gets a normal roulette for its
// own place; anyone else just drives through. An Accordion Blast destroys the
// egg cleanly — no capsules (removals by blasts are 'blocked' before the
// clearAround(kind) hook runs, so the capsules wait for the next update and
// clearAround('accordion') cancels them).
//
// CPU: fires at a target ahead within 80 m; from 1st only with a rival < 20 m ahead.

import * as THREE from 'three';
import { registerItem } from './registry.js';
import { ITEM5, ITEM } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';

const CAP_EGGS = 4, CAP_CAPS = 18, CAPSULE_HOVER = 0.75, LAT_RATE = 1.6, LOST_GAP = -12;

registerSound('eggLaunch', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // foil crinkle + a playful rising "pwee"
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 3800, dur: 0.18, peak: 0.12 });
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 420 * p, f1: 980 * p, glide: 0.2, dur: 0.24, peak: 0.16, vib: 30, vibRate: 9 });
  return 0.3;
}, 1.4);
registerSound('eggCrack', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a chocolatey crack + a little toy-surprise fanfare
  SYNTH.hiss(ac, out, t, { type: 'bandpass', f0: 2400, dur: 0.07, peak: 0.3, Q: 3 });
  SYNTH.hiss(ac, out, t + 0.05, { type: 'bandpass', f0: 1700, dur: 0.06, peak: 0.2, Q: 3 });
  [0, 4, 7, 12].forEach((st, i) => SYNTH.note(ac, out, t + 0.12 + i * 0.07, SYNTH.mtof(72 + st) * p, 0.09, { type: 'square', peak: 0.05, lp: 2600 }));
  return 0.5;
}, 1.3);
registerSound('eggCapsule', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 700 * p, f1: 1400 * p, glide: 0.1, dur: 0.12, peak: 0.12 });
  SYNTH.bell(ac, out, t + 0.06, 1760 * p, 0.06, 0.4);
  return 0.35;
}, 1.3);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _e = new THREE.Euler(), _ax = new THREE.Vector3(), _f = {}, _tmp = new THREE.Vector3();

// Spill the capsules around a crack point (on the road, inside the walls).
function spill(ctx, at, hint, owner) {
  const pr = ctx.project(at, hint ?? -1);
  for (let i = 0; i < ITEM5.eggCapsules; i++) {
    const a = ctx.rng() * Math.PI * 2, r = ITEM5.eggSpill * Math.sqrt(0.25 + 0.75 * ctx.rng());
    const lat = Math.max(-(pr.wallL - 1), Math.min(pr.wallR - 1, pr.lateral + Math.cos(a) * r));
    const pos = ctx.pointAt(pr.s + Math.sin(a) * r, lat, _tmp);
    pos.y += CAPSULE_HOVER;
    ctx.spawn({
      kind: 'capsule', role: 'pickup', owner, position: pos, radius: ITEM5.eggCapsuleRadius, life: ITEM5.eggCapsuleLife,
      data: { seed: ctx.rng() * 6.28, hue: i },
    });
  }
  ctx.sfx('eggCrack', at, 1);
  ctx.emit('item:eggCrack', { kart: owner, position: at, capsules: ITEM5.eggCapsules });
}

function crack(ctx, e, reason = 'crack') { if (e.active) ctx.remove(e, reason); }

registerItem('surprise_egg', {
  init(ctx) { ctx.state.pending = []; ctx.state.egg = null; ctx.state.caps = null; },

  use(ctx, kart) {
    const target = ctx.kartAhead(kart);
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
    const e = ctx.spawn({
      kind: 'egg', role: 'projectile', owner: kart, target, radius: ITEM5.eggRadius, height: ITEM5.eggRadius,
      speed: Math.max(ITEM5.eggSpeed * ctx.ccMult, kart.speed + ITEM5.eggBoost * ctx.ccMult), life: ITEM5.eggLife,
      position: { x: kart.position.x + fx * 1.9, y: kart.position.y, z: kart.position.z + fz * 1.9 },
      threat: true, clear: 2.6, solid: true, ownerGrace: ITEM.shooterGrace, phase: target ? 'track' : 'straight',
      data: { roll: 0, seed: ctx.rng() * 6.28 },
    });
    ctx.keepOnRoad(e, ITEM5.eggRadius + 0.1);
    e.position.y = e.proj.height + e.height;
    e.s = e.proj.s; e.lateral = e.proj.lateral;
    e.dist = (kart.distance || 0) + 1.9;
    ctx.sfx('eggLaunch', kart);
    ctx.emit('item:eggLaunch', { kart, target, entity: e });
    return true;
  },

  update(ctx, dt) {
    const pend = ctx.state.pending;
    while (pend.length) { const q = pend.pop(); spill(ctx, q.at, q.hint, q.owner); }
    const list = ctx.entities();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.active) continue;
      if (e.kind === 'capsule') { stepCapsule(ctx, e); continue; }
      const tgt = e.target;
      if (e.phase !== 'straight' && (!tgt || tgt.finished)) e.phase = 'straight';
      if (e.phase === 'track') {
        const f = ctx.frameAt(e.s, _f);
        const corr = Math.max(0.55, Math.min(1.6, 1 - f.curvature * e.lateral));
        const ds = (e.speed * dt) / corr;
        e.s = ctx.wrapS(e.s + ds);
        e.dist += ds;
        const gap = (tgt.distance || 0) - e.dist;
        if (gap < LOST_GAP) e.phase = 'straight';
        else {
          const rate = LAT_RATE * (gap < 70 ? 2.2 : 1), tl = tgt.proj ? tgt.proj.lateral : 0;
          e.lateral += (tl - e.lateral) * (1 - Math.exp(-rate * dt));
          e.lateral = Math.max(-(f.wallL - 0.8), Math.min(f.wallR - 0.8, e.lateral));
          ctx.pointAt(e.s, e.lateral, e.position);
          ctx.track.project(e.position, e.hint, e.proj);
          e.hint = e.proj.index;
          const dx = e.position.x - e.prev.x, dz = e.position.z - e.prev.z, dl = Math.hypot(dx, dz);
          if (dl > 1e-4) { e.dir.x = dx / dl; e.dir.z = dz / dl; }
          const tx = tgt.position.x - e.position.x, tz = tgt.position.z - e.position.z;
          if (tx * tx + tz * tz < ITEM.rocketHomingRange * ITEM.rocketHomingRange && gap > -3) e.phase = 'home';
        }
      } else if (e.phase === 'home') {
        const d = Math.max(1, Math.hypot(tgt.position.x - e.position.x, tgt.position.z - e.position.z));
        ctx.steerToward(e, tgt.position, Math.max(7, (e.speed * 2) / d), dt);
        ctx.stepStraight(e, dt, { bounce: false });
      } else if (ctx.stepStraight(e, dt, { bounce: false }) === 'wall') { crack(ctx, e); continue; }
      e.position.y = e.proj.height + e.height;
      e.data.roll += (e.speed * dt) / ITEM5.eggRadius;
      const pos = e.position;
      if (ctx.shieldAt(pos, e.radius, e.owner, { entity: e, kind: 'egg', dir: e.dir })) { crack(ctx, e); continue; }
      let gone = false;
      for (const k of ctx.kartsTouching(pos, e.radius, { dy: 1.8, yOff: 0.5 })) {
        if (k === e.owner && e.age < e.ownerGrace) continue;
        if (ctx.immune(k) || !k.isHittable()) { crack(ctx, e); gone = true; break; }
        if (ctx.hit(k, 'tumble', { by: e.owner })) {
          ctx.flash(k, 'EGGED!', '#ff9ec4', { size: 'medium', duration: 1, vibrate: [80, 40, 80] });
          crack(ctx, e, 'hit');
          gone = true;
          break;
        }
      }
      if (gone) continue;
      if (e.age > 0.1 && ctx.smashAt(pos, e.radius, { bananas: true, projectiles: true, roles: ['hazard', 'projectile'], skip: e, owner: e.owner, ownerGrace: 0.4, max: 1 })) crack(ctx, e);
    }
  },

  onEntityRemove(ctx, e, reason) {
    if (e.kind === 'capsule') {
      if (ctx.effects && reason !== 'clear') ctx.effects.emit(reason === 'taken' ? 'sparkle' : 'glitter', e.position, { count: 10, spread: 3, color: 0xffd0ea });
      return;
    }
    if (reason === 'clear') return;
    if (ctx.effects) {
      _p.copy(e.position);
      ctx.effects.emit('spark', _p, { count: 16, color: 0xff9ec4, spread: 6 });
      ctx.effects.emit('crema', _p, { count: 10, spread: 4 });         // chocolate shell bits
      ctx.effects.emit('confetti', _p, { count: 18, spread: 5 });
    }
    if (reason === 'blocked') { ctx.state.pending.push({ at: e.position.clone(), hint: e.hint, owner: e.owner }); return; }
    spill(ctx, e.position, e.hint, e.owner);
  },

  clearAround(ctx, at, R, by, kind) {
    if (kind !== 'accordion') return 0;
    const pend = ctx.state.pending, R2 = (R + 0.5) * (R + 0.5);
    for (let i = pend.length - 1; i >= 0; i--) if (pend[i].at.distanceToSquared(at) <= R2) pend.splice(i, 1);
    return 0;
  },

  countLive(ctx) {
    const seen = new Set();
    for (const e of ctx.sys.entities) if (e.plugin === ctx && e.active && e.kind === 'egg' && e.owner && e.owner.item !== 'surprise_egg') seen.add(e.owner);
    return seen.size;
  },

  clear(ctx) { ctx.state.pending.length = 0; },

  aiUse(kart, c) {
    const tgt = c.plugin ? c.plugin.kartAhead(kart) : c.kartAhead();
    if (!tgt) return !!c.rivalAhead(4, 20, 0.5) || c.hold > 12;
    const ds = c.track.deltaS(c.s, tgt.proj ? tgt.proj.s : c.s);
    if (ds > 0 && ds < 80) return true;
    return c.hold > 10;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE, R = ITEM5.eggRadius;
    // the egg: foil stripes (pink / gold / teal bands) along its long axis (local y)
    const egg = new T.SphereGeometry(R, 24, 18);
    const pos = egg.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    const cA = new T.Color(0xff6fae), cB = new T.Color(0xffd34a), cC = new T.Color(0x3fd6c8), cW = new T.Color(0xfff4fa);
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const u = y / R;
      const sc = 1 - 0.18 * Math.max(0, u);                       // narrower top
      x *= sc; z *= sc; y *= 1.28;
      pos.setXYZ(i, x, y, z);
      const band = Math.floor((u + 1) * 4.5);
      const dot = Math.sin(Math.atan2(z, x) * 7) * Math.sin(u * 14) > 0.55;
      const c = dot ? cW : [cA, cB, cC][band % 3];
      cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
    }
    egg.computeVertexNormals();
    egg.setAttribute('color', new T.BufferAttribute(cols, 3));
    egg.deleteAttribute('uv');
    const eggGeo = ctx.own(egg.index ? egg.toNonIndexed() : egg);
    if (eggGeo !== egg) egg.dispose();
    const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0.75 });
    ctx.state.egg = ctx.instanced(eggGeo, mat, CAP_EGGS, 'surprise-eggs', { shadow: true });
    // the capsules: a toy capsule — a coloured top half (instance colour), a clear-white bottom half, a gold band
    const top = [], bottom = [];
    top.push(ctx.part(new T.SphereGeometry(0.55, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2), 0xffffff, { pos: [0, 0.05, 0] }));
    top.push(ctx.part(new T.SphereGeometry(0.1, 8, 6), 0xffffff, { pos: [0.22, 0.45, 0.2] }));
    bottom.push(ctx.part(new T.SphereGeometry(0.55, 18, 9, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), 0xf6f2ff, { pos: [0, -0.05, 0] }));
    bottom.push(ctx.part(new T.CylinderGeometry(0.56, 0.56, 0.11, 18), 0xffc83a));
    // a little star sticker on the bottom half's face
    bottom.push(ctx.part(new T.CircleGeometry(0.16, 5), 0xff5a8a, { pos: [0, -0.24, 0.5], rot: new T.Euler(-0.45, 0, 0) }));
    const cmat = new T.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.15, metalness: 0, clearcoat: 1, emissive: 0x202020 });
    const caps = ctx.instanced(ctx.mergeParts(top), cmat, CAP_CAPS, 'surprise-capsules', { shadow: true });
    caps.instanceColor = new T.InstancedBufferAttribute(new Float32Array(CAP_CAPS * 3), 3);
    const hues = [0xff5fa8, 0x4fc3ff, 0x8dff6a, 0xffb02e, 0xb57bff];
    const c = new T.Color();
    for (let i = 0; i < CAP_CAPS; i++) caps.setColorAt(i, c.set(hues[i % hues.length]));
    ctx.state.caps = caps;
    ctx.state.capsB = ctx.instanced(ctx.mergeParts(bottom), new T.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.1, metalness: 0, clearcoat: 1, transmission: 0, emissive: 0x181818 }), CAP_CAPS, 'surprise-capsules-base', { shadow: true });
  },

  updateVisuals(ctx) {
    const em = ctx.state.egg, cm = ctx.state.caps;
    if (!em) return;
    const t = ctx.time;
    let ne = 0, nc = 0;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active) continue;
      if (e.kind === 'egg') {
        if (ne >= CAP_EGGS) continue;
        // tumbling end over end along its heading, long axis wobbling
        const yaw = Math.atan2(e.dir.x, e.dir.z);
        _e.set(0, yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _q2.setFromAxisAngle(_ax.set(1, 0, 0), e.data.roll);
        _q.multiply(_q2);
        _s.setScalar(Math.min(1, 0.5 + e.age * 5));
        em.setMatrixAt(ne++, _m.compose(e.position, _q, _s));
      } else {
        if (nc >= CAP_CAPS) continue;
        const left = e.life - e.age, pop = Math.min(1, e.age / 0.3);
        _p.set(e.position.x, e.position.y + Math.sin(t * 2.6 + e.data.seed) * 0.12, e.position.z);
        _e.set(0.35, t * 1.8 + e.data.seed, 0.25, 'YXZ');
        _q.setFromEuler(_e);
        _s.setScalar(Math.max(0.01, (0.4 + 0.6 * pop) * (left < 0.6 ? left / 0.6 : 1) * (left < 3 ? 0.85 + 0.15 * Math.sin(t * 18) : 1)));
        _m.compose(_p, _q, _s);
        cm.setMatrixAt(nc, _m);
        ctx.state.capsB.setMatrixAt(nc++, _m);
      }
    }
    const cb = ctx.state.capsB;
    em.count = ne; cm.count = cb.count = nc;
    em.visible = ne > 0; cm.visible = cb.visible = nc > 0;
    em.instanceMatrix.needsUpdate = true;
    cm.instanceMatrix.needsUpdate = true;
    cb.instanceMatrix.needsUpdate = true;
  },

  callout: 'EGGED!',
});

// A capsule: an empty-handed kart driving through it gets a roulette for its place.
function stepCapsule(ctx, e) {
  for (const k of ctx.kartsTouching(e.position, e.radius, { dy: 2.4, yOff: 0.5, kartRadius: 0 })) {
    if (k.item || k.rolling || k.finished) continue;
    const sys = ctx.sys;
    if (typeof sys._startRoll === 'function') sys._startRoll(k);
    else ctx.giveItem(k, ctx.rollFor(k));
    ctx.sfx('eggCapsule', k);
    ctx.emit('item:capsule', { kart: k, by: e.owner });
    ctx.remove(e, 'taken');
    return;
  }
}
