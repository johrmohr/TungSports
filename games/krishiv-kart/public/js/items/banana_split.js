// Banana Split (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A9, §C7, §C9).
//
// A giant peel (hit distance ITEM5.splitRadius) dropped ITEM5.splitBack m
// behind, crowned with three scoops and a cherry. A kart that touches it spins
// for HIT.splitSpinTime s, then the giant peel SPLITS into ITEM5.splitPeels
// normal banana peels in an ITEM5.splitScatter m triangle around the impact.
// Being destroyed also splits it — by a native projectile (it is `solid`), an
// explosion, a star / Beer Rocket / giant kart, fireballs, pins or the wheel —
// except by the Accordion Blast, which wipes it out clean. ≤ ITEM5.splitMaxRoad
// on the road (oldest recycled), ITEM5.splitLife s each.
//
// Accordion vs other blasts: both remove plugin entities with reason 'blocked'
// before calling clearAround(kind); so a 'blocked' removal only queues the
// split, clearAround('accordion') cancels the queued ones in its radius, and
// the next update() spills the rest.
//
// CPU: banana rules (a rival < 15 m behind, or after 6 s); sooner on a narrow road.

import * as THREE from 'three';
import { registerItem } from './registry.js';
import { ITEM5, HIT } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';

const GRACE = 0.7, HIT_DY = 1.6;

registerSound('splitDrop', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 210 * p, f1: 70 * p, glide: 0.12, dur: 0.22, peak: 0.3 });
  SYNTH.hiss(ac, out, t + 0.02, { type: 'lowpass', f0: 900, dur: 0.12, peak: 0.12 });
  SYNTH.bell(ac, out, t + 0.08, 1760 * p, 0.04, 0.35);
  return 0.35;
}, 1.4);
registerSound('splitSlip', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a long squelchy slide, then three little peel "plaps"
  SYNTH.blip(ac, out, t, { type: 'sawtooth', f0: 520 * p, f1: 110 * p, glide: 0.5, dur: 0.55, peak: 0.1, lp: 1400, vib: 70, vibRate: 11 });
  SYNTH.hiss(ac, out, t, { f0: 1500, f1: 500, dur: 0.45, peak: 0.12, Q: 1.5 });
  for (let i = 0; i < 3; i++) SYNTH.blip(ac, out, t + 0.42 + i * 0.09, { type: 'sine', f0: (360 + 80 * i) * p, f1: 120 * p, glide: 0.05, dur: 0.08, peak: 0.14 });
  return 0.8;
}, 1.3);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _at = new THREE.Vector3();

// Three peels in a triangle (circumradius splitScatter / sqrt(3)) around `at`, turned to the road.
function spill(ctx, e, at, owner) {
  if (!owner) return 0;
  const n = ITEM5.splitPeels, R = ITEM5.splitScatter / Math.sqrt(3);
  const pr = ctx.project(at, e.hint);
  const base = ctx.rng() * Math.PI * 2;
  let made = 0;
  for (let i = 0; i < n; i++) {
    const a = base + (i / n) * Math.PI * 2;
    const lat = pr.lateral + Math.cos(a) * R, ds = Math.sin(a) * R;
    const p = ctx.pointAt(pr.s + ds, Math.max(-(pr.wallL - 0.7), Math.min(pr.wallR - 0.7, lat)), _at);
    const h = ctx.dropBanana(owner, p);
    if (h) { h.dropFrom = 0.9; made++; }
  }
  ctx.emit('item:splitSpill', { kart: owner, position: at, peels: made });
  return made;
}

registerItem('banana_split', {
  init(ctx) { ctx.state.pending = []; ctx.state.mesh = null; },

  use(ctx, kart) {
    ctx.roadCap('split', ITEM5.splitMaxRoad);
    const at = ctx.behind(kart, ITEM5.splitBack);
    const e = ctx.spawn({
      kind: 'split', role: 'hazard', owner: kart, position: at, radius: ITEM5.splitRadius, life: ITEM5.splitLife,
      threat: true, clear: ITEM5.splitRadius + 0.95, solid: true, ownerGrace: GRACE,
      data: { drop: Math.max(0.3, kart.position.y + 0.9 - at.y), seed: ctx.rng() * 6.283 },
    });
    ctx.keepOnRoad(e, 0.8, true);
    ctx.sfx('splitDrop', kart);
    ctx.emit('item:splitDrop', { kart, entity: e });
    return true;
  },

  update(ctx) {
    // splits queued by blasts / native projectiles (not cancelled by an accordion)
    const pend = ctx.state.pending;
    while (pend.length) { const q = pend.pop(); spill(ctx, q, q.at, q.owner); }
    const list = ctx.entities();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.active) continue;
      for (const k of ctx.kartsTouching(e.position, e.radius, { dy: HIT_DY, yOff: 0, kartRadius: 0 })) {
        if (k === e.owner && e.age < e.ownerGrace) continue;
        if (ctx.immune(k)) { ctx.remove(e, 'smash'); break; }
        const ok = ctx.hit(k, (kart) => {
          if (!kart.spinOut('banana_split')) return false;
          kart.spinTimer = kart.spinDuration = HIT.splitSpinTime;
          return true;
        }, { by: e.owner });
        if (ok) {
          ctx.sfx('splitSlip', k);
          ctx.flash(k, 'SPLIT!', '#fff07a', { size: 'medium', duration: 1.1, vibrate: [60, 30, 120] });
          e.data.impact = true;
          ctx.remove(e, 'hit');
          break;
        }
      }
    }
  },

  onEntityRemove(ctx, e, reason) {
    if (reason === 'clear' || reason === 'expire' || reason === 'accordion') return;
    if (ctx.effects) {
      _p.set(e.position.x, e.position.y + 0.6, e.position.z);
      ctx.effects.emit('splash', _p, { count: 18, color: 0xfff3a0, spread: 5, size: 0.2 });
      ctx.effects.emit('splash', _p, { count: 10, color: 0xff9ac8, spread: 4, size: 0.16 });
    }
    if (reason === 'blocked') {
      // a blast or a native projectile: split unless an accordion (clearAround) cancels it this substep
      ctx.state.pending.push({ at: e.position.clone(), owner: e.owner, hint: e.hint });
      return;
    }
    spill(ctx, e, e.position, e.owner);                   // 'hit' / 'smash' (fireball, pin, wheel, star kart ...)
  },

  clearAround(ctx, at, R, by, kind) {
    if (kind !== 'accordion') return 0;
    const pend = ctx.state.pending, R2 = (R + 0.5) * (R + 0.5);
    for (let i = pend.length - 1; i >= 0; i--) if (pend[i].at.distanceToSquared(at) <= R2) pend.splice(i, 1);
    return 0;
  },

  clear(ctx) { ctx.state.pending.length = 0; },

  aiUse(kart, c) {
    const f = c.track.frameAt(c.s - 3);
    if (f.halfWidth < 8 && c.rivalBehind(1.5, 25, 4)) return true;     // a narrow road: no way round it
    if (c.rivalBehind(1.5, 15, 3.5)) return true;
    return c.hold > 6 * (1.2 - 0.4 * (c.aggression || 0.7));
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE;
    const parts = [];
    // four drooping peel petals around a cut top, ~2.4 m across, + the fruit peeking out
    const petals = 4;
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * Math.PI * 2 + 0.4;
      const g = new T.SphereGeometry(0.55, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      parts.push(ctx.part(g, i % 2 ? 0xffdc2e : 0xffd21c, {
        scale: [0.62, 0.32, 1.55], rot: new T.Euler(-0.32, a, 0, 'YXZ'), pos: [Math.sin(a) * 0.7, 0.05, Math.cos(a) * 0.7],
      }));
      // brown tip of each petal
      parts.push(ctx.part(new T.SphereGeometry(0.14, 8, 6), 0x6b4a14, { scale: [1, 0.5, 1], pos: [Math.sin(a) * 1.38, 0.05, Math.cos(a) * 1.38] }));
    }
    parts.push(ctx.part(new T.CylinderGeometry(0.42, 0.5, 0.75, 14), 0xfff4c2, { pos: [0, 0.38, 0] }));     // the banana inside
    parts.push(ctx.part(new T.CylinderGeometry(0.47, 0.52, 0.45, 14, 1, true), 0xffcf22, { pos: [0, 0.22, 0] }));
    // three scoops (pink / vanilla / chocolate), whipped cream, a cherry on top
    const scoops = [[0xff8fb8, -0.34, 0.12], [0xfff2d6, 0.3, -0.18], [0x7a4a2a, 0.02, 0.36]];
    for (const [c, x, z] of scoops) {
      parts.push(ctx.part(new T.SphereGeometry(0.34, 14, 10), c, { pos: [x, 0.95, z] }));
      parts.push(ctx.part(new T.TorusGeometry(0.29, 0.07, 6, 14), c, { rot: new T.Euler(Math.PI / 2, 0, 0), pos: [x, 0.82, z] }));
    }
    parts.push(ctx.part(new T.ConeGeometry(0.3, 0.42, 9), 0xffffff, { pos: [0, 1.36, 0.02] }));
    parts.push(ctx.part(new T.SphereGeometry(0.13, 10, 8), 0xe0102a, { pos: [0, 1.62, 0.02] }));
    parts.push(ctx.part(new T.CylinderGeometry(0.012, 0.016, 0.26, 4), 0x3a5a14, { rot: new T.Euler(0, 0, 0.5), pos: [0.06, 1.8, 0.02] }));
    // sprinkles
    for (let i = 0; i < 14; i++) {
      const a = i * 2.4, r = 0.18 + (i % 4) * 0.07;
      parts.push(ctx.part(new T.BoxGeometry(0.03, 0.03, 0.1), [0xff3355, 0x33aaff, 0x66dd44, 0xffee33][i % 4], {
        rot: new T.Euler(i, i * 0.7, 0), pos: [Math.sin(a) * r, 1.15 + (i % 3) * 0.06, Math.cos(a) * r],
      }));
    }
    const geo = ctx.mergeParts(parts);
    const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
    ctx.state.mesh = ctx.instanced(geo, mat, ITEM5.splitMaxRoad + 2, 'banana-splits', { shadow: true, receive: true });
  },

  updateVisuals(ctx) {
    const m = ctx.state.mesh;
    if (!m) return;
    const t = ctx.time;
    let i = 0;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || i >= m.instanceMatrix.count) continue;
      const d = e.data;
      const fall = Math.max(0, 1 - e.age / 0.32);
      const left = e.life - e.age;
      const squish = e.age < 0.5 ? 1 + 0.18 * Math.sin(e.age * 26) * (1 - e.age / 0.5) : 1;
      const sc = (left < 0.8 ? Math.max(0.01, left / 0.8) : 1) * (e.age < 0.1 ? 0.5 + 5 * e.age : 1);
      _p.set(e.position.x, e.position.y + d.drop * fall * fall, e.position.z);
      _e.set(0, d.seed + Math.sin(t * 0.8 + d.seed) * 0.08, 0);
      _q.setFromEuler(_e);
      _s.set(sc * (2 - squish), sc * squish, sc * (2 - squish));
      m.setMatrixAt(i++, _m.compose(_p, _q, _s));
    }
    m.count = i;
    m.visible = i > 0;
    m.instanceMatrix.needsUpdate = true;
  },

  callout: 'SPLIT!',
});
