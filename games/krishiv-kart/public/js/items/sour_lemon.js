// Sour Lemon (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A10, §C7, §C9).
//
// A big Amalfi lemon dropped 2.2 m behind (banana rules). A kart that touches
// it puckers up and SHRINKS for HIT.shrinkTime s (kart.shrink: size 0.55,
// speed x0.85, accel x0.9; a full-size kart can squash it, kart.js). A kart
// that is already shrunk and hits a second lemon is restored to full size at
// once (the old poison rule). Star / Beer Rocket / giant karts squash the lemon.
// Native bouncers / rockets and blasts destroy it (it is `solid`); fireballs,
// pins and the wheel smash it (role 'hazard'). At most ITEM5.lemonMaxRoad on
// the road (oldest recycled), each lives ITEM5.lemonLife s.
//
// CPU: banana rules (drop with a rival < 15 m behind, or after 6 s).

import * as THREE from 'three';
import { registerItem } from './registry.js';
import { ITEM5, HIT } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';

const BACK = 2.2, GRACE = 0.7, HIT_DY = 1.4, VIS_R = 0.62;

// ---- sounds (original synth voices)
registerSound('lemonDrop', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 420 * p, f1: 150 * p, glide: 0.09, dur: 0.14, peak: 0.22 });
  SYNTH.blip(ac, out, t + 0.05, { type: 'triangle', f0: 1300 * p, f1: 1700 * p, glide: 0.05, dur: 0.07, peak: 0.06 });
  return 0.2;
}, 1.4);
registerSound('lemonPucker', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a sour "eeek" then a shrinking slide whistle
  SYNTH.blip(ac, out, t, { type: 'square', f0: 1500 * p, f1: 1150 * p, glide: 0.12, dur: 0.16, peak: 0.07, lp: 3200, vib: 40, vibRate: 22 });
  SYNTH.blip(ac, out, t + 0.12, { type: 'sine', f0: 900 * p, f1: 160 * p, glide: 0.42, dur: 0.5, peak: 0.2 });
  SYNTH.hiss(ac, out, t, { f0: 5200, f1: 2400, dur: 0.14, peak: 0.05, Q: 2 });
  return 0.65;
}, 1.3);
registerSound('lemonRestore', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 200 * p, f1: 820 * p, glide: 0.32, dur: 0.38, peak: 0.2 });
  SYNTH.bell(ac, out, t + 0.3, 1320 * p, 0.06, 0.4);
  return 0.6;
}, 1.3);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

registerItem('sour_lemon', {
  init(ctx) { ctx.state.mesh = null; },

  use(ctx, kart) {
    ctx.roadCap('lemon', ITEM5.lemonMaxRoad);
    const at = ctx.behind(kart, BACK);
    const e = ctx.spawn({
      kind: 'lemon', role: 'hazard', owner: kart, position: at, radius: ITEM5.lemonRadius, life: ITEM5.lemonLife,
      threat: true, clear: ITEM5.lemonRadius + 0.95, solid: true, ownerGrace: GRACE,
      data: { drop: Math.max(0.2, kart.position.y + 0.7 - at.y), seed: ctx.rng() * 6.283 },
    });
    ctx.keepOnRoad(e, 0.6, true);
    ctx.sfx('lemonDrop', kart);
    ctx.emit('item:lemonDrop', { kart, entity: e });
    return true;
  },

  update(ctx) {
    const list = ctx.entities();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.active) continue;
      const touching = ctx.kartsTouching(e.position, e.radius, { dy: HIT_DY, yOff: 0, kartRadius: 0 });
      for (const k of touching) {
        if (k === e.owner && e.age < e.ownerGrace) continue;
        if (ctx.immune(k)) { ctx.remove(e, 'smash'); break; }
        if (k.shrinkTimer > 0) {
          // already shrunk: a second lemon puts it right again
          if (typeof k.unshrink === 'function') k.unshrink('sour_lemon');
          else k.shrinkTimer = Math.min(k.shrinkTimer, 1e-3);
          ctx.sfx('lemonRestore', k);
          ctx.flash(k, 'BACK TO SIZE!', '#fff200', { size: 'medium', duration: 1 });
          ctx.emit('item:lemonRestore', { kart: k, by: e.owner });
          ctx.remove(e, 'hit');
          break;
        }
        if (ctx.hit(k, 'shrink', { by: e.owner, duration: HIT.shrinkTime })) {
          ctx.sfx('lemonPucker', k);
          ctx.flash(k, 'PUCKER UP!', '#fff200', { size: 'medium', duration: 1.1, vibrate: [40, 30, 90] });
          ctx.remove(e, 'hit');
          break;
        }
        // invulnerable / already spinning: drives over it
      }
    }
  },

  onEntityRemove(ctx, e, reason) {
    if (!ctx.effects || reason === 'clear' || reason === 'expire') return;
    _p.set(e.position.x, e.position.y + 0.5, e.position.z);
    ctx.effects.emit('splash', _p, { count: 16, color: 0xfff27a, spread: 4.5, size: 0.17 });
    ctx.effects.emit('spark', _p, { count: 8, color: 0xffee55, spread: 3.5 });
  },

  aiUse(kart, c) {
    if (c.rivalBehind(1.5, 15, 3)) return true;
    return c.hold > 6 * (1.2 - 0.4 * (c.aggression || 0.7));
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE;
    const parts = [];
    // the fruit: an elongated, slightly lumpy ellipsoid with pointy ends (along local x)
    const body = new T.SphereGeometry(VIS_R, 20, 14);
    const pos = body.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const n = 1 + 0.035 * Math.sin(x * 23 + y * 17) * Math.sin(z * 19 - y * 13);   // peel dimples
      pos.setXYZ(i, x * 1.3 * n, y * 0.92 * n, z * 0.92 * n);
    }
    body.computeVertexNormals();
    parts.push(ctx.part(body, 0xffd81f));
    for (const s of [-1, 1]) {
      parts.push(ctx.part(new T.ConeGeometry(0.17, 0.3, 10), 0xf0c010, {
        rot: new T.Euler(0, 0, -s * Math.PI / 2), pos: [s * VIS_R * 1.33, 0, 0],
      }));
    }
    // stem + two leaves
    parts.push(ctx.part(new T.CylinderGeometry(0.035, 0.05, 0.16, 6), 0x5c7a2a, { rot: new T.Euler(0, 0, Math.PI / 2), pos: [-VIS_R * 1.55, 0.04, 0] }));
    parts.push(ctx.part(new T.SphereGeometry(0.2, 10, 6), 0x3f9a2f, { scale: [1.5, 0.22, 0.65], rot: new T.Euler(0.3, 0.6, 0.35), pos: [-VIS_R * 1.25, 0.32, 0.12] }));
    parts.push(ctx.part(new T.SphereGeometry(0.17, 10, 6), 0x52b23b, { scale: [1.4, 0.22, 0.6], rot: new T.Euler(-0.4, -0.7, 0.2), pos: [-VIS_R * 1.2, 0.3, -0.16] }));
    // a little sour face (it is a prank lemon after all): two squinting eyes + a puckered mouth
    for (const s of [-1, 1]) parts.push(ctx.part(new T.BoxGeometry(0.16, 0.035, 0.03), 0x3a2a08, { rot: new T.Euler(0, 0, s * 0.35), pos: [s * 0.16, 0.14, VIS_R * 0.9] }));
    parts.push(ctx.part(new T.TorusGeometry(0.055, 0.022, 6, 10), 0x7a2a10, { pos: [0, -0.06, VIS_R * 0.9] }));
    const geo = ctx.mergeParts(parts);
    const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0, emissive: 0x2a2200 });
    ctx.state.mesh = ctx.instanced(geo, mat, ITEM5.lemonMaxRoad + 2, 'sour-lemons', { shadow: true });
  },

  updateVisuals(ctx) {
    const m = ctx.state.mesh;
    if (!m) return;
    const t = ctx.time;
    let i = 0;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || i >= m.instanceMatrix.count) continue;
      const d = e.data;
      const fall = Math.max(0, 1 - e.age / 0.28);
      const left = e.life - e.age;
      const sc = (e.age < 0.12 ? 0.6 + 0.4 * (e.age / 0.12) : 1) * (left < 0.6 ? Math.max(0.01, left / 0.6) : 1);
      const bob = Math.abs(Math.sin(t * 2.2 + d.seed)) * 0.04;
      _p.set(e.position.x, e.position.y + VIS_R * 0.92 + bob + d.drop * fall * fall, e.position.z);
      _e.set(Math.sin(t * 1.7 + d.seed) * 0.12, d.seed + t * 0.35, Math.sin(t * 2.3 + d.seed) * 0.1);
      _q.setFromEuler(_e);
      _s.setScalar(sc);
      m.setMatrixAt(i++, _m.compose(_p, _q, _s));
    }
    m.count = i;
    m.visible = i > 0;
    m.instanceMatrix.needsUpdate = true;
  },

  callout: 'SOURED!',
});
