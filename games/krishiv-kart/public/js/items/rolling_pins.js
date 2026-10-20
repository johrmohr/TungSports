// Rolling Pins (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A4, §C7, §C9).
//
// Timed item (ITEM_INFO: uses 5, timed 5): the first press opens an
// ITEM5.pinsWindow s window for up to 5 pins, presses >= ITEM5.pinsGap s apart.
// Each press lobs a wooden rolling pin forward at speed + ITEM5.pinsThrow m/s,
// ITEM5.pinsUp m/s up (gravity 28: ~0.5 s of air), alternating ±ITEM5.pinsSpread°
// left / right — it lands ~25 m from the throw point, ~11 m ahead of the
// thrower; with the brake held it is lobbed backward at ITEM5.pinsBackThrow m/s.
// In flight a kart within ITEM5.pinsFlightRadius TUMBLES; on landing it breaks
// what it lands on (peels, prank boxes, lemons, coal; a bomb goes off), knocks
// course hazards (bus item:strike) and then sticks in the road for
// ITEM5.pinsStuck s (radius ITEM5.pinsRadius): touching it tumbles you and breaks
// it. The thrower is never hit by its own pins. Orbiting shields stop pins in
// flight; the accordion, bomb blasts and star / giant / Beer Rocket karts
// destroy them.
//
// Kart fields for the HUD: kart.itemWindow (0..1 of the window left: hud.js draws the slot meter),
// kart.itemTimer / kart.itemTimerMax (s).
// CPU: throws at a rival 10-30 m ahead within ±20° every 0.5 s, one pin back at
// a rival < 10 m behind, dumps the rest as the window closes.

import * as THREE from 'three';
import { registerItem } from './registry.js';
import { ITEM5 } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';

const CAP = 16, DEG = Math.PI / 180, PIN_LEN = 1.5;

registerSound('pinThrow', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { f0: 700, f1: 2400, sweep: 0.18, dur: 0.22, peak: 0.14, Q: 1.6 });
  SYNTH.blip(ac, out, t, { type: 'triangle', f0: 300 * p, f1: 520 * p, glide: 0.12, dur: 0.14, peak: 0.06 });
  return 0.25;
}, 1.4);
registerSound('pinLand', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a hollow wooden "TOCK" into the tarmac
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 720 * p, f1: 380 * p, glide: 0.04, dur: 0.12, peak: 0.24 });
  SYNTH.blip(ac, out, t, { type: 'triangle', f0: 1450 * p, f1: 900 * p, glide: 0.03, dur: 0.06, peak: 0.1 });
  SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 900, dur: 0.1, peak: 0.12 });
  return 0.2;
}, 1.4);
registerSound('pinBonk', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 520 * p, f1: 210 * p, glide: 0.08, dur: 0.2, peak: 0.3 });
  SYNTH.blip(ac, out, t + 0.02, { type: 'square', f0: 1700 * p, f1: 1100 * p, glide: 0.04, dur: 0.05, peak: 0.05, lp: 3000 });
  SYNTH.bell(ac, out, t + 0.05, 2100 * p, 0.04, 0.3);
  return 0.35;
}, 1.4);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _e = new THREE.Euler(), _ax = new THREE.Vector3();

function endWindow(ctx, kart) {
  const st = ctx.kstate(kart);
  st.window = 0;
  kart.itemTimer = 0; kart.itemTimerMax = 0; kart.itemWindow = 0;
  if (kart.item === 'rolling_pins') { kart.item = null; kart.itemCount = 0; }
}

function land(ctx, e) {
  e.phase = 'stuck';
  e.role = 'hazard';
  e.life = e.age + ITEM5.pinsStuck;
  e.radius = ITEM5.pinsRadius;
  e.vel.set(0, 0, 0);
  e.position.y = e.proj.height;
  ctx.smashAt(e.position, ITEM5.pinsRadius + 0.3, { bananas: true, bombs: true, roles: ['hazard'], skip: e, dy: 2 });
  ctx.strike(e.position, ITEM5.pinsRadius + 0.5, e.owner);
  ctx.sfx('pinLand', e.position, 0.9, 0.9 + 0.2 * ctx.rng());
  if (ctx.effects) ctx.effects.emit('dust', e.position, { count: 8, spread: 2.5, size: 0.5 });
}

registerItem('rolling_pins', {
  init(ctx) { ctx.state.mesh = null; },

  use(ctx, kart) {
    const st = ctx.kstate(kart);
    const now = ctx.time;
    if (now - (st.last ?? -Infinity) < ITEM5.pinsGap) return false;
    const first = !(st.window > 0);
    if (first) { st.window = ITEM5.pinsWindow; st.n = 0; kart.itemTimer = ITEM5.pinsWindow; kart.itemTimerMax = ITEM5.pinsWindow; kart.itemWindow = 1; }
    st.last = now;
    st.n = (st.n || 0) + 1;
    ctx.roadCap('pin', CAP);
    const back = (kart.input && kart.input.brake || 0) > 0.5;
    const side = st.n % 2 ? 1 : -1;
    const yaw = back ? kart.yaw + Math.PI : kart.yaw + side * ITEM5.pinsSpread * DEG;
    const hs = back ? ITEM5.pinsBackThrow : Math.max(0, kart.speed) + ITEM5.pinsThrow * ctx.ccMult;
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw), sgn = back ? -1 : 1;
    const e = ctx.spawn({
      kind: 'pin', role: 'projectile', owner: kart, radius: 0.35, phase: 'air',
      position: { x: kart.position.x + fx * 1.2 * sgn, y: kart.position.y + 1.3, z: kart.position.z + fz * 1.2 * sgn },
      vel: { x: Math.sin(yaw) * hs, y: ITEM5.pinsUp, z: Math.cos(yaw) * hs }, dir: { x: Math.sin(yaw), z: Math.cos(yaw) },
      life: 6, threat: true, clear: 2.0, ownerGrace: 1e9, data: { spin: 0, spinRate: 13 + 4 * ctx.rng(), tilt: (ctx.rng() - 0.5) * 0.8, yaw },
    });
    e.position.y = kart.position.y + 1.3;
    ctx.sfx('pinThrow', kart, 1, 0.9 + 0.2 * ctx.rng());
    if (first) ctx.emit('item:pinsStart', { kart });
    return { consume: true, first };
  },

  update(ctx, dt) {
    for (const k of ctx.karts) {
      const st = ctx.kstate(k);
      if (!(st.window > 0)) continue;
      st.window -= dt;
      k.itemTimer = Math.max(0, st.window);
      k.itemWindow = Math.max(0, Math.min(1, st.window / ITEM5.pinsWindow));
      if (st.window <= 0 || k.item !== 'rolling_pins') endWindow(ctx, k);
    }
    const list = ctx.entities();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.active) continue;
      if (e.phase === 'air') {
        e.data.spin += e.data.spinRate * dt;
        const res = ctx.stepBallistic(e, dt, { landKeep: 0 });
        if (res === 'land') { land(ctx, e); continue; }
        if (ctx.shieldAt(e.position, 0.5, e.owner, { entity: e, kind: 'pin', dir: e.dir, peels: false })) { ctx.remove(e, 'blocked'); continue; }
        for (const k of ctx.kartsTouching(e.position, ITEM5.pinsFlightRadius, { dy: 1.8, yOff: 0.5, skip: e.owner, kartRadius: 0.8 })) {
          if (ctx.immune(k)) { ctx.remove(e, 'smash'); break; }
          if (ctx.hit(k, 'tumble', { by: e.owner })) {
            ctx.sfx('pinBonk', k);
            ctx.flash(k, 'BONKED!', '#d9a066', { size: 'medium', duration: 1, vibrate: [80, 40, 80] });
            ctx.remove(e, 'hit');
            break;
          }
        }
        continue;
      }
      // stuck in the road: an obstacle for everyone but its thrower
      for (const k of ctx.kartsTouching(e.position, e.radius, { dy: 1.6, yOff: 0, skip: e.owner })) {
        if (ctx.immune(k)) { ctx.remove(e, 'smash'); break; }
        if (ctx.hit(k, 'tumble', { by: e.owner })) {
          ctx.sfx('pinBonk', k);
          ctx.flash(k, 'BONKED!', '#d9a066', { size: 'medium', duration: 1, vibrate: [80, 40, 80] });
          ctx.remove(e, 'hit');
          break;
        }
      }
    }
  },

  onKartHit(ctx, kart) {
    const st = ctx.kstate(kart);
    if (st.window > 0) endWindow(ctx, kart);
  },

  countLive(ctx) {
    const seen = new Set();
    for (const e of ctx.sys.entities) if (e.plugin === ctx && e.active && e.owner && e.owner.item !== 'rolling_pins') seen.add(e.owner);
    return seen.size;
  },

  onEntityRemove(ctx, e, reason) {
    if (!ctx.effects || reason === 'clear') return;
    _p.set(e.position.x, e.position.y + 0.4, e.position.z);
    if (reason === 'expire') { ctx.effects.emit('dust', _p, { count: 5, spread: 1.5, size: 0.4 }); return; }
    ctx.effects.emit('spark', _p, { count: 12, color: 0xd9a066, spread: 6 });
    ctx.effects.emit('dust', _p, { count: 6, spread: 2.5, size: 0.5 });
  },

  clear(ctx) { for (const k of ctx.karts) { k.itemTimer = 0; k.itemTimerMax = 0; k.itemWindow = 0; } },

  aiUse(kart, c) {
    const st = c.plugin ? c.plugin.kstate(kart) : {};
    const m = c.mem;
    if (c.hold - (m.last ?? -10) < 0.5) return false;
    const go = (r) => { m.last = c.hold; return r; };
    if (st.window > 0 && st.window < 1.0) return go(true);                 // dump the rest
    if (c.rivalAhead(10, 30, 0.35)) return go(true);
    if (!m.backDone && c.rivalBehind(1.5, 10, 3.5)) { m.backDone = true; return go({ use: true, brake: true }); }
    if (!(st.window > 0) && c.hold > 8) return go(true);
    return false;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE;
    // a wooden rolling pin along local z, centred
    const parts = [];
    parts.push(ctx.part(new T.CylinderGeometry(0.2, 0.2, PIN_LEN * 0.62, 16), 0xe2b479, { rot: new T.Euler(Math.PI / 2, 0, 0) }));
    for (const s of [-1, 1]) {
      parts.push(ctx.part(new T.CylinderGeometry(0.21, 0.19, 0.04, 16), 0xc8955a, { rot: new T.Euler(Math.PI / 2, 0, 0), pos: [0, 0, s * PIN_LEN * 0.31] }));
      parts.push(ctx.part(new T.CylinderGeometry(0.06, 0.07, PIN_LEN * 0.16, 8), 0xa0703a, { rot: new T.Euler(Math.PI / 2, 0, 0), pos: [0, 0, s * PIN_LEN * 0.39] }));
      parts.push(ctx.part(new T.SphereGeometry(0.1, 10, 8), 0x8a5a2a, { scale: [1, 1, 0.8], pos: [0, 0, s * PIN_LEN * 0.48] }));
    }
    // wood grain rings + a dusting of flour
    for (let i = 0; i < 5; i++) parts.push(ctx.part(new T.TorusGeometry(0.202, 0.008, 4, 16), 0xb88446, { pos: [0, 0, (i / 4 - 0.5) * PIN_LEN * 0.5] }));
    parts.push(ctx.part(new T.SphereGeometry(0.21, 10, 6, 0, Math.PI * 2, 0, 0.8), 0xfaf3e6, { scale: [1, 0.35, 2.6], pos: [0, 0.07, 0] }));
    const geo = ctx.mergeParts(parts);
    const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0 });
    ctx.state.mesh = ctx.instanced(geo, mat, CAP, 'rolling-pins', { shadow: true });
  },

  updateVisuals(ctx) {
    const m = ctx.state.mesh;
    if (!m) return;
    let i = 0;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || i >= CAP) continue;
      const d = e.data;
      if (e.phase === 'air') {
        // end over end about the axis across the throw
        _e.set(0, d.yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _q2.setFromAxisAngle(_ax.set(1, 0, 0), d.spin);
        _q.multiply(_q2);
        _p.copy(e.position);
        _s.setScalar(1);
      } else {
        // stuck: one end dug in, leaning back toward the thrower
        const wob = e.age - (e.life - ITEM5.pinsStuck);
        const shake = wob < 0.4 ? Math.sin(wob * 40) * 0.25 * (1 - wob / 0.4) : 0;
        _e.set(-0.85 + shake, d.yaw, d.tilt, 'YXZ');
        _q.setFromEuler(_e);
        _p.set(e.position.x, e.position.y + 0.45, e.position.z);
        const left = e.life - e.age;
        _s.setScalar(left < 0.4 ? Math.max(0.01, left / 0.4) : 1);
      }
      m.setMatrixAt(i++, _m.compose(_p, _q, _s));
    }
    m.count = i;
    m.visible = i > 0;
    m.instanceMatrix.needsUpdate = true;
  },

  callout: 'BONKED!',
});
