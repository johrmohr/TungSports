// Peperoncino Blaster (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A1, §C7, §C9).
//
// Timed item (ITEM_INFO: uses 8, timed 8): the first press opens an
// ITEM5.pepperWindow s window for up to ITEM5.pepperShots chili fireballs;
// presses closer than ITEM5.pepperGap s are ignored. Each fireball leaves the
// nose at max(pepperSpeed x cc, speed + pepperBoost) m/s, hops (visually) and
// reflects off up to ITEM5.pepperBounces walls, living ITEM5.pepperLife s; with
// the brake held it is lobbed backward at pepperBackSpeed m/s, slowing as it
// rolls, for pepperBackLife s. A kart it touches SPINS and loses 1 lira (a light
// hit); it burns through a banana / prank box / lemon / coal lump (both gone)
// and trades with a bouncer or rocket head-on (it is `solid`). Orbiting shields,
// trailing peels, hearts, the grissino tail, the calzone and the accordion stop
// it. At most ITEM5.pepperMaxLive fireballs live (oldest recycled). The window
// ends after the last shot, when it runs out, or when the owner is hit.
//
// Kart fields for the HUD: kart.itemWindow (0..1 of the window left: hud.js draws the slot meter),
// kart.itemTimer / kart.itemTimerMax (s).
// CPU: shoots at a rival 6-40 m ahead within ±15° (one shot per 0.6 s), backward
// at a rival < 15 m behind when nobody is ahead, dumps the rest at < 1.5 s left.

import * as THREE from 'three';
import { registerItem } from './registry.js';
import { ITEM5, ITEM } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';

const CAP = ITEM5.pepperMaxLive, HOP = 0.4, HOP_T = 0.25, RIDE = 0.45, BACK_DECEL = 5;

registerSound('pepperShot', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a fiery "fwoomp": bright noise burst + a quick downward zap
  SYNTH.hiss(ac, out, t, { f0: 3200, f1: 800, sweep: 0.12, dur: 0.16, peak: 0.18, Q: 0.9 });
  SYNTH.blip(ac, out, t, { type: 'square', f0: 900 * p, f1: 260 * p, glide: 0.1, dur: 0.12, peak: 0.08, lp: 2600 });
  SYNTH.blip(ac, out, t + 0.01, { type: 'sine', f0: 140 * p, f1: 70 * p, glide: 0.08, dur: 0.1, peak: 0.16 });
  return 0.2;
}, 1.4);
registerSound('pepperHit', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 2600, f1: 600, sweep: 0.3, dur: 0.38, peak: 0.24 });
  SYNTH.blip(ac, out, t, { type: 'sawtooth', f0: 320 * p, f1: 90 * p, glide: 0.25, dur: 0.3, peak: 0.08, lp: 1400 });
  return 0.45;
}, 1.4);
registerSound('pepperFizz', (ac, out, o) => {
  const { t } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 4000, dur: 0.18, peak: 0.09 });
  return 0.2;
}, 1.2);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3();
const _e = new THREE.Euler();

function endWindow(ctx, kart) {
  const st = ctx.kstate(kart);
  st.window = 0;
  kart.itemTimer = 0; kart.itemTimerMax = 0; kart.itemWindow = 0;
  if (kart.item === 'peperoncino') { kart.item = null; kart.itemCount = 0; }
}

registerItem('peperoncino', {
  init(ctx) { ctx.state.mesh = null; ctx.state.glow = null; },

  use(ctx, kart) {
    const st = ctx.kstate(kart);
    const now = ctx.time;
    if (now - (st.last ?? -Infinity) < ITEM5.pepperGap) return false;          // too soon: ignored
    const first = !(st.window > 0);
    if (first) { st.window = ITEM5.pepperWindow; kart.itemTimer = ITEM5.pepperWindow; kart.itemTimerMax = ITEM5.pepperWindow; kart.itemWindow = 1; }
    st.last = now;
    ctx.roadCap('fireball', CAP);
    const back = (kart.input && kart.input.brake || 0) > 0.5;
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw), sgn = back ? -1 : 1;
    const speed = back ? ITEM5.pepperBackSpeed * ctx.ccMult : Math.max(ITEM5.pepperSpeed * ctx.ccMult, kart.speed + ITEM5.pepperBoost * ctx.ccMult);
    const e = ctx.spawn({
      kind: 'fireball', role: 'projectile', owner: kart, radius: ITEM5.pepperRadius, height: RIDE,
      position: { x: kart.position.x + fx * 1.9 * sgn, y: kart.position.y, z: kart.position.z + fz * 1.9 * sgn },
      dir: { x: fx * sgn, z: fz * sgn }, speed, life: back ? ITEM5.pepperBackLife : ITEM5.pepperLife,
      threat: true, clear: 2.4, solid: true, ownerGrace: ITEM.shooterGrace, data: { back, seed: ctx.rng() * 6.28 },
    });
    ctx.keepOnRoad(e, ITEM5.pepperRadius + 0.1);
    e.position.y = e.proj.height + RIDE;
    ctx.sfx('pepperShot', kart, 1, 0.92 + 0.16 * ctx.rng());
    if (first) ctx.emit('item:pepperStart', { kart });
    return { consume: true, first };
  },

  update(ctx, dt) {
    // the windows
    for (const k of ctx.karts) {
      const st = ctx.kstate(k);
      if (!(st.window > 0)) continue;
      st.window -= dt;
      k.itemTimer = Math.max(0, st.window);
      k.itemWindow = Math.max(0, Math.min(1, st.window / ITEM5.pepperWindow));
      if (st.window <= 0 || k.item !== 'peperoncino') endWindow(ctx, k);
    }
    const list = ctx.entities();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.active) continue;
      if (e.data.back) e.speed = Math.max(4, e.speed - BACK_DECEL * dt);
      const res = ctx.stepStraight(e, dt);
      if (res === 'bounce' && e.bounces > ITEM5.pepperBounces) { ctx.remove(e, 'wall'); continue; }
      const pos = e.position;
      // shields first (orbiters, trailing peels, plugin shields)
      if (ctx.shieldAt(pos, e.radius, e.owner, { entity: e, kind: 'fireball', dir: e.dir })) { ctx.remove(e, 'blocked'); continue; }
      // karts
      let gone = false;
      for (const k of ctx.kartsTouching(pos, e.radius, { dy: 1.8, yOff: 0.5 })) {
        if (k === e.owner && e.age < e.ownerGrace) continue;
        if (ctx.immune(k) || !k.isHittable()) { ctx.remove(e, 'smash'); gone = true; break; }
        if (ctx.hit(k, 'spin', { by: e.owner, light: true })) {
          ctx.sfx('pepperHit', k);
          ctx.flash(k, 'TOASTED!', '#ff3b1f', { size: 'medium', duration: 0.9, vibrate: [50, 30, 50] });
          ctx.remove(e, 'hit');
          gone = true;
          break;
        }
      }
      if (gone) continue;
      // road hazards burn up with it; head-on native shells trade with it
      if (ctx.smashAt(pos, e.radius, { bananas: true, projectiles: true, roles: ['hazard'], owner: e.owner, ownerGrace: 0.3, max: 1 })) { ctx.remove(e, 'smash'); continue; }
    }
  },

  onKartHit(ctx, kart) {
    const st = ctx.kstate(kart);
    if (st.window > 0) endWindow(ctx, kart);                 // unfired shots are lost
  },

  countLive(ctx) {
    // a fireball volley still flying from a kart whose slot is already empty counts as one in play
    const seen = new Set();
    for (const e of ctx.sys.entities) if (e.plugin === ctx && e.active && e.owner && e.owner.item !== 'peperoncino') seen.add(e.owner);
    return seen.size;
  },

  onEntityRemove(ctx, e, reason) {
    if (reason === 'clear') return;
    if (ctx.effects) {
      _p.copy(e.position);
      ctx.effects.emit('flame', _p, { count: 10, spread: 3, size: 0.6, life: 0.3 });
      ctx.effects.emit('spark', _p, { count: 10, color: 0xffa040, spread: 6 });
      ctx.effects.emit('smoke', _p, { count: 3, size: 0.5, alpha: 0.35 });
    }
    if (reason === 'expire' || reason === 'wall' || reason === 'blocked') ctx.sfx('pepperFizz', e.position, 0.7);
  },

  clear(ctx) { for (const k of ctx.karts) { k.itemTimer = 0; k.itemTimerMax = 0; k.itemWindow = 0; } },

  aiUse(kart, c) {
    const st = c.plugin ? c.plugin.kstate(kart) : {};
    const m = c.mem;
    if (c.hold - (m.last ?? -10) < 0.6) return false;
    const open = st.window > 0;
    const shoot = (r) => { m.last = c.hold; return r; };
    if (open && st.window < 1.5) return shoot(true);                       // dump the rest
    if (c.rivalAhead(6, 40, 0.26)) return shoot(true);
    if (c.rivalBehind(1.5, 15, 3.5) && !c.rivalAhead(3, 60, 0.6)) return shoot({ use: true, brake: true });
    if (!open && c.hold > 9) return shoot(true);
    return false;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE;
    // a fat, curved red chili (lathe profile bent along an arc, pointing along local +z) with a green cap
    const L = 0.95, prof = [];
    for (let i = 0; i <= 12; i++) {
      const u = i / 12;
      prof.push(new T.Vector2(Math.max(0.004, 0.24 * Math.pow(Math.sin(Math.min(1, u * 1.15) * Math.PI * 0.5), 0.6) * (1 - 0.92 * u * u)), u * L));
    }
    const body = new T.LatheGeometry(prof, 16);
    const bp = body.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      // bend: the further along, the more it curls down (around x)
      const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i);
      const a = (y / L) * 0.9, R = 1.0;
      const ny = Math.sin(a) * (R - z) , nz = R - Math.cos(a) * (R - z);
      bp.setXYZ(i, x * (1 + 0.05 * Math.sin(y * 20)), ny, nz);
    }
    body.computeVertexNormals();
    const parts = [];
    // body points along +y after the lathe; turn it so the tip trails behind (-z) and the cap leads (+z)
    parts.push(ctx.part(body, 0xe8231a, { rot: new T.Euler(Math.PI / 2, Math.PI, 0), pos: [0, 0.05, 0.12] }));
    parts.push(ctx.part(new T.SphereGeometry(0.21, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0x3f9a2f, { rot: new T.Euler(Math.PI / 2, 0, 0), scale: [1.15, 1.15, 0.6], pos: [0, 0.05, 0.14] }));
    parts.push(ctx.part(new T.CylinderGeometry(0.035, 0.05, 0.24, 6), 0x2f7a1f, { rot: new T.Euler(Math.PI / 2 - 0.6, 0, 0), pos: [0, 0.12, 0.26] }));
    const geo = ctx.mergeParts(parts);
    const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0, emissive: 0x6a0800, emissiveIntensity: 1 });
    ctx.state.mesh = ctx.instanced(geo, mat, CAP, 'pepper-fireballs', { shadow: true });
    // a soft fire halo around it: additive, bright toward the middle, transparent at the rim
    const glow = ctx.own(new T.SphereGeometry(0.75, 20, 14));
    const gmat = new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vV; varying vec3 vL;
        void main() {
          vL = position;
          mat4 mw = modelMatrix * instanceMatrix;
          vec4 mv = viewMatrix * mw * vec4(position, 1.0);
          vN = normalize(mat3(viewMatrix) * mat3(mw) * normal);
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime;
        varying vec3 vN; varying vec3 vV; varying vec3 vL;
        void main() {
          float f = abs(dot(normalize(vN), normalize(vV)));
          float lick = 0.75 + 0.25 * sin(vL.y * 9.0 + vL.x * 7.0 - uTime * 18.0) * sin(vL.z * 8.0 + uTime * 11.0);
          float a = pow(f, 1.6) * lick;
          vec3 col = mix(vec3(1.0, 0.22, 0.02), vec3(1.0, 0.82, 0.35), pow(f, 3.0));
          gl_FragColor = vec4(col * a * 1.35, a);
        }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false,
    });
    ctx.state.glowU = gmat.uniforms;
    ctx.state.glow = ctx.instanced(glow, gmat, CAP, 'pepper-flames', { shadow: false, order: 5 });
  },

  updateVisuals(ctx, dt) {
    const m = ctx.state.mesh, g = ctx.state.glow;
    if (!m) return;
    const t = ctx.time;
    if (ctx.state.glowU) ctx.state.glowU.uTime.value = t;
    let i = 0;
    const fx = ctx.effects;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || i >= CAP) continue;
      const d = e.data;
      const hop = HOP * Math.abs(Math.sin((Math.PI * (e.age + d.seed)) / HOP_T));
      _p.set(e.position.x, e.position.y + hop - 0.1, e.position.z);
      const yaw = Math.atan2(e.dir.x, e.dir.z);
      _e.set(0, yaw, Math.sin(t * 20 + d.seed) * 0.4, 'YXZ');
      _q.setFromEuler(_e);
      const born = Math.min(1, e.age / 0.08);
      _s.setScalar(0.5 + 0.5 * born);
      m.setMatrixAt(i, _m.compose(_p, _q, _s));
      const fl = 0.9 + 0.15 * Math.sin(t * 37 + d.seed * 5);
      _s.set(fl, fl * 1.05, fl * 1.35);
      g.setMatrixAt(i, _m.compose(_p, _q, _s));
      i++;
      if (fx && Math.random() < dt * 60) {
        _v.set(e.position.x - e.dir.x * 0.5, e.position.y + hop, e.position.z - e.dir.z * 0.5);
        fx.emit('flame', _v, { count: 3, spread: 1.1, size: 0.7, life: 0.28 });
      }
    }
    m.count = g.count = i;
    m.visible = g.visible = i > 0;
    m.instanceMatrix.needsUpdate = true;
    g.instanceMatrix.needsUpdate = true;
  },

  callout: 'TOASTED!',
});
