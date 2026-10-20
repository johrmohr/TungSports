// Amore Hearts 💕 (v5 group B, research-v5-items.md B8; analog: the protective hearts / bubble).
//
// One press: ITEM5.amoreHearts hearts orbit the kart (radius ITEM5.amoreRadius,
// ITEM5.amoreSpeed rad/s) for ITEM5.amoreTime s and the slot is freed (the
// kart can roll again). Each heart absorbs ONE hit, then breaks:
//   * projectiles: bouncer, rocket and the v5 fireball / iceball / pizza / egg / piggy / pins;
//   * hazard contacts: banana, split, prank, lemon, coal (a stink cloud stays, but spares the kart).
// Gift: if the slot is empty (and not rolling) an absorbed banana / bouncer /
// rocket / prank_box / sour_lemon / banana_split / meatball_bomb becomes yours.
// Not absorbed: capo, bomb blasts, padella, espresso, befana; the parmesan wheel
// breaks both hearts (and still hits); a zap destroys both.
// Events: item:amore { kart } · item:heartBlock { kart, item, gift } · item:amoreEnd { kart, cause }.
// CPU: uses it at once.

import { registerItem } from './registry.js';
import { ITEM5, ITEM, KART } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';
import { forItemsNear, destroyItem, giftIdOf, kartIndex, isItemEntity } from './b-util.js';

const ID = 'amore';
// how far from the kart centre a thing is absorbed (before it can reach the kart)
const CATCH = { projectile: 3.1, banana: 2.6, bomb: 3.4, entity: 3.0, stink: 0 };

registerSound('heartsOn', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  [659, 831, 988, 1319].forEach((f, i) => SYNTH.note(ac, out, t + i * 0.06, f * p, 0.18, { type: 'triangle', peak: 0.07, vib: 12 }));
  SYNTH.bell(ac, out, t + 0.24, 2637 * p, 0.03, 0.5);
  return 0.6;
}, 0.9);
registerSound('heartBlock', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 380 * p, f1: 760 * p, glide: 0.08, dur: 0.16, peak: 0.13 });
  SYNTH.bell(ac, out, t + 0.06, 1760 * p, 0.05, 0.4);
  return 0.45;
}, 0.9);
registerSound('heartBreak', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'triangle', f0: 900 * p, f1: 300 * p, glide: 0.2, dur: 0.24, peak: 0.08 });
  return 0.3;
}, 0.9);

function stop(ctx, kart, cause) {
  const hs = ctx.kstate(kart);
  if (!(hs.hearts > 0)) return;
  hs.hearts = 0;
  ctx.state.list.delete(kart);
  ctx.emit('item:amoreEnd', { kart, cause });
  if (cause !== 'time' && cause !== 'clear') ctx.sfx('heartBreak', kart, 0.9);
}

function breakHeart(ctx, kart, hs, what, gift) {
  hs.hearts--;
  if (ctx.vis) ctx.state.bursts.push({ kart, t: 0, angle: hs.angle + hs.hearts * Math.PI });
  ctx.sfx('heartBlock', kart, 1);
  ctx.emit('item:heartBlock', { kart, item: what, gift: gift || null });
  if (hs.hearts <= 0) stop(ctx, kart, 'used');
}

registerItem(ID, {
  init(ctx) {
    ctx.state.list = new Set();
    ctx.state.bursts = [];
    ctx.state._v = new ctx.THREE.Vector3();
    // a zap destroys both hearts (they don't stop it)
    ctx.on('item:zap', (e) => {
      for (const k of (e && e.victims) || []) if (ctx.state.list.has(k)) stop(ctx, k, 'zap');
    });
  },

  use(ctx, kart) {
    const hs = ctx.kstate(kart);
    hs.hearts = ITEM5.amoreHearts;
    hs.t0 = ctx.time;
    hs.angle = 0;
    ctx.state.list.add(kart);
    ctx.sfx('heartsOn', kart, 1);
    ctx.emit('item:amore', { kart });
    return true;                                   // the slot is freed
  },

  update(ctx, dt) {
    const st = ctx.state;
    if (!st.list.size) return;
    for (const kart of st.list) {
      const hs = ctx.kstate(kart);
      hs.angle = (hs.angle + ITEM5.amoreSpeed * dt) % (Math.PI * 2);
      if (ctx.time - hs.t0 >= ITEM5.amoreTime || kart.finished) { stop(ctx, kart, 'time'); continue; }
      const c = st._v.set(kart.position.x, kart.position.y + 0.6, kart.position.z);
      // the parmesan wheel breaks both hearts (it rolls on and still hits)
      for (const e of ctx.sys.entities) {
        if (!e.active || e.item !== 'parm_wheel' || e.owner === kart) continue;
        const dx = e.position.x - c.x, dz = e.position.z - c.z, r = (e.radius || 1.6) + ITEM5.amoreRadius;
        if (dx * dx + dz * dz <= r * r && Math.abs(e.position.y - c.y) < 3) { stop(ctx, kart, 'wheel'); break; }
      }
      if (!(hs.hearts > 0)) continue;
      // absorb the first thing about to reach the kart
      let done = false;
      forItemsNear(ctx, c, 3.6, (obj, kind) => {
        if (done || !(hs.hearts > 0)) return;
        const lim = CATCH[kind] || 0;
        if (kind === 'stink') {
          // the cloud stays, but this kart is marked as already hit by it
          const j = kartIndex(ctx, kart);
          const dx = obj.position.x - c.x, dz = obj.position.z - c.z, r = (obj.radius || 3) + 0.5;
          if (j < 0 || dx * dx + dz * dz > r * r || (obj.hitMask & (1 << (j & 31)))) return;
          obj.hitMask |= 1 << (j & 31);
          done = true;
          breakHeart(ctx, kart, hs, 'stink', null);
          return;
        }
        const dx = obj.position.x - c.x, dz = obj.position.z - c.z;
        if (dx * dx + dz * dz > lim * lim) return;
        if (kind === 'projectile' && obj.age < 0.3 && obj.owner === kart) return;
        if (kind === 'entity' && !isItemEntity(obj)) return;
        // moving things only when they come at us (or are homing in)
        if (kind === 'projectile') {
          const vx = obj.dir ? obj.dir.x : 0, vz = obj.dir ? obj.dir.z : 0;
          const rel = (vx * -dx + vz * -dz);
          if (rel < 0 && obj.target !== kart && dx * dx + dz * dz > 1.6 * 1.6) return;
        }
        done = true;
        const gid = giftIdOf(obj, kind);
        const gift = gid && !kart.item && !kart.rolling ? gid : null;
        destroyItem(ctx, obj, kind, 'blocked');
        if (gift) ctx.giveItem(kart, gift);
        breakHeart(ctx, kart, hs, kind === 'entity' ? obj.item : obj.type || kind, gift);
      }, { owner: kart, skipOwn: true, bombs: true, stink: true, dy: 2.6 });
    }
  },

  // v5 integration: the plugin projectiles ask ctx.shieldAt() before they touch a kart (fireball, iceball,
  // pizza, egg, pins, piggy). A heart in reach absorbs the attack (research §C7: the piggy bursts on it).
  // The parmesan wheel (pierce) is left to update(), which breaks both hearts while the wheel rolls on.
  shield(ctx, pos, r, owner, info) {
    const st = ctx.state;
    if (!st.list.size || (info && (info.pierce || info.item === 'parm_wheel'))) return null;
    for (const kart of st.list) {
      if (kart === owner) continue;
      const hs = ctx.kstate(kart);
      if (!(hs.hearts > 0)) continue;
      const dx = kart.position.x - pos.x, dz = kart.position.z - pos.z, lim = CATCH.entity;
      if (dx * dx + dz * dz > lim * lim || Math.abs(kart.position.y + 0.6 - pos.y) > 2.6) continue;
      breakHeart(ctx, kart, hs, (info && (info.item || info.kind)) || 'item', null);
      return { kart };
    }
    return null;
  },

  clear(ctx) { for (const k of ctx.state.list) ctx.kstate(k).hearts = 0; ctx.state.list.clear(); ctx.state.bursts.length = 0; },

  aiUse() { return true; },

  // ---------------------------------------------------------------- visuals: two puffy hearts in orbit
  initVisuals(ctx) {
    const T = ctx.THREE, st = ctx.state;
    const s = new T.Shape();
    s.moveTo(0, -0.3);
    s.bezierCurveTo(-0.08, -0.2, -0.36, -0.04, -0.34, 0.12);
    s.bezierCurveTo(-0.32, 0.3, -0.08, 0.34, 0, 0.18);
    s.bezierCurveTo(0.08, 0.34, 0.32, 0.3, 0.34, 0.12);
    s.bezierCurveTo(0.36, -0.04, 0.08, -0.2, 0, -0.3);
    const geo = ctx.own(new T.ExtrudeGeometry(s, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 3, curveSegments: 10 }));
    geo.center();
    const mat = ctx.own(new T.MeshStandardMaterial({ color: 0xff4f8b, emissive: 0xff2a6a, emissiveIntensity: 0.55, roughness: 0.35 }));
    st.mesh = new T.InstancedMesh(geo, mat, 16);
    st.mesh.count = 0;
    st.mesh.frustumCulled = false;
    ctx.root.add(st.mesh);
    st.m = new T.Matrix4(); st.q = new T.Quaternion(); st.e = new T.Euler(); st.p = new T.Vector3(); st.s = new T.Vector3();
    st.pink = { count: 12, color: 0xff7ab0, size: 0.24, life: 0.5, radius: 0.4 };
  },

  updateVisuals(ctx, dt) {
    const st = ctx.state, m = st.mesh;
    if (!m) return;
    let i = 0;
    for (const k of st.list) {
      const hs = ctx.kstate(k);
      const sz = k.sizeMult || 1;
      const left = ITEM5.amoreTime - (ctx.time - hs.t0);
      if (left < 2.5 && Math.floor(ctx.time * 8) % 2 === 0) continue;      // blink before they go
      for (let h = 0; h < hs.hearts && i < 16; h++) {
        const a = hs.angle + h * Math.PI;
        st.p.set(k.position.x + Math.sin(a) * ITEM5.amoreRadius * sz, k.position.y + (0.8 + Math.sin(ctx.time * 4 + h) * 0.12) * sz, k.position.z + Math.cos(a) * ITEM5.amoreRadius * sz);
        st.e.set(0, a + ctx.time * 2.6, 0);                                 // turning as they orbit: never edge-on for long
        st.q.setFromEuler(st.e);
        const beat = 1.25 * Math.sqrt(sz) * (1 + 0.12 * Math.max(0, Math.sin(ctx.time * 9)));   // (a giant's hearts grow less than it does)
        st.s.set(beat, beat, beat);
        m.setMatrixAt(i++, st.m.compose(st.p, st.q, st.s));
      }
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    for (let j = st.bursts.length - 1; j >= 0; j--) {
      const b = st.bursts[j];
      if (b.t === 0 && ctx.effects && b.kart) {
        st.p.set(b.kart.position.x + Math.sin(b.angle) * ITEM5.amoreRadius, b.kart.position.y + 0.8, b.kart.position.z + Math.cos(b.angle) * ITEM5.amoreRadius);
        ctx.effects.emit('sparkle', st.p, st.pink);
      }
      b.t += dt;
      if (b.t > 0.1) st.bursts.splice(j, 1);
    }
  },
});
