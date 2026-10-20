// Maxi Mortadella 🍖 (v5 group B, research-v5-items.md B4; analog: the giant-growth item).
//
// The racer gulps a giant mortadella: kart.grow(ITEM5.mortTime) — sizeMult
// to ITEM5.mortScale (2.2) over 0.4 s, back over 0.5 s, speed x1.12,
// offroad-proof, immune to every item and hazard except espresso (it still
// splashes) and a zap (it ends the giant early, no other penalty). The item
// stays in the slot while it lasts.
//   * Flatten: a non-immune rival touching the giant → squash(HIT.squashTime)
//     (speed x0.35, item dropped, -2 lire); a star kart or another giant is just bumped.
//   * Hazards it drives over (peels, v5 traps) and projectiles that reach it are destroyed.
// Events: item:mortadellaStart / item:mortadellaEnd { kart, cause }.
// CPU: on pickup with a rival < 40 m ahead, or on a straight; while big it
// aims at rivals within ±3 m ahead (aiLure).

import { registerItem } from './registry.js';
import { ITEM5, HIT, KART } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';
import { clearSlot, forItemsNear, destroyItem, kartPoint } from './b-util.js';

const ID = 'mortadella';

registerSound('megaGrow', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sawtooth', f0: 70 * p, f1: 260 * p, glide: 0.45, dur: 0.55, peak: 0.12, lp: 900 });
  SYNTH.blip(ac, out, t, { type: 'square', f0: 140 * p, f1: 520 * p, glide: 0.45, dur: 0.5, peak: 0.05, lp: 1600 });
  SYNTH.hiss(ac, out, t + 0.05, { type: 'lowpass', f0: 300, f1: 1200, dur: 0.45, peak: 0.08 });
  SYNTH.kickDrum(ac, out, t + 0.5, 0.9);
  return 0.7;
}, 0.9);
registerSound('megaShrink', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sawtooth', f0: 300 * p, f1: 80 * p, glide: 0.45, dur: 0.5, peak: 0.1, lp: 1000 });
  return 0.55;
}, 0.9);
registerSound('squash', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.kickDrum(ac, out, t, 1);
  SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 900, f1: 200, dur: 0.25, peak: 0.18 });                  // "pfft"
  SYNTH.blip(ac, out, t + 0.04, { type: 'square', f0: 220 * p, f1: 90 * p, dur: 0.22, peak: 0.07, lp: 1200 });
  return 0.35;
}, 0.9);
registerSound('megaStomp', (ac, out, o) => {
  const { t } = SYNTH.opt(ac, o);
  SYNTH.kickDrum(ac, out, t, 0.6);
  return 0.2;
}, 0.8);

function start(ctx, kart) {
  const st = ctx.kstate(kart);
  st.active = true;
  st.t0 = ctx.time;
  ctx.state.list.add(kart);
  kart.grow(ITEM5.mortTime);
  ctx.sfx('megaGrow', kart, 1);
  ctx.emit('item:mortadellaStart', { kart });
  if (ctx.vis) ctx.state.gulps.push({ kart, t: 0 });
}

function end(ctx, kart, cause) {
  const st = ctx.kstate(kart);
  if (!st.active) return;
  st.active = false;
  ctx.state.list.delete(kart);
  clearSlot(kart, ID);
  if (kart.megaTimer > 0) kart.endGrow(cause);
  ctx.sfx('megaShrink', kart, 0.9);
  ctx.emit('item:mortadellaEnd', { kart, cause });
}

registerItem(ID, {
  init(ctx) {
    ctx.state.list = new Set();
    ctx.state.gulps = [];
    ctx.state._v = new ctx.THREE.Vector3();
    ctx.on('kart:megaEnd', (e) => {
      if (e && ctx.state.list.has(e.kart)) end(ctx, e.kart, e.cause || 'end');
    });
  },

  use(ctx, kart) {
    if (ctx.kstate(kart).active) return false;
    start(ctx, kart);
    return { consume: false };
  },

  // the giant is active: nothing to steal
  stealable(ctx, kart) { return !ctx.kstate(kart).active; },

  countLive(ctx) {
    let n = 0;
    for (const k of ctx.state.list) if (k.item !== ID) n++;      // held ones are counted by the system
    return n;
  },

  update(ctx, dt) {
    const list = ctx.state.list;
    if (!list.size) return;
    for (const kart of list) {
      if (!(kart.megaTimer > 0) || kart.finished) { end(ctx, kart, kart.finished ? 'finish' : 'end'); continue; }
      const R = KART.radius * (kart.sizeMult || 1);
      // flatten rivals in contact
      for (const k of ctx.kartsTouching(kart.position, R + 0.25, { dy: 2.6, yOff: 0, skip: kart })) {
        if (k.finished || k.frozen || ctx.immune(k)) continue;
        if (ctx.hit(k, 'squash', { by: kart, duration: HIT.squashTime })) {
          ctx.sfx('squash', k, 1);
          ctx.flash(k, 'FLATTENED!', '#ff8a9a', { sub: kart.name, subColor: kart.cssColor, vibrate: [60, 40, 90] });
        }
      }
      // hazards it rolls over and projectiles that reach it are destroyed
      const at = ctx.state._v.set(kart.position.x, kart.position.y + 0.6, kart.position.z);
      forItemsNear(ctx, at, R + 0.4, (obj, kind) => destroyItem(ctx, obj, kind, 'smash'), { owner: kart, skipOwn: true, dy: 2.6 });
    }
  },

  aiUse(kart, c) {
    if (c.rivalAhead(2, 40, 0.5)) return true;
    return c.straightAhead(45) || c.hold > 6;
  },

  // while big: lean toward a rival ahead within ±3 m (flatten it)
  aiLure(ctx, kart, c) {
    if (!(kart.megaTimer > 0) || !ctx.kstate(kart).active) return null;
    let best = null, bd = Infinity;
    for (const o of ctx.karts) {
      if (o === kart || o.finished || ctx.immune(o) || !o.proj) continue;
      const ds = ctx.track.deltaS(c.s, o.proj.s);
      if (ds < 2 || ds > 30) continue;
      if (Math.abs(o.proj.lateral - kart.proj.lateral) > 3 + KART.radius) continue;
      if (ds < bd) { bd = ds; best = o; }
    }
    return best ? { s: best.proj.s, lateral: best.proj.lateral, urgency: 0.45 } : null;
  },

  clear(ctx) {
    for (const k of ctx.state.list) { if (k.megaTimer > 0) k.endGrow('clear'); }
    ctx.state.list.clear();
    ctx.state.gulps.length = 0;
  },

  // ---------------------------------------------------------------- visuals: a giant mortadella slice gulped down
  initVisuals(ctx) {
    const T = ctx.THREE, st = ctx.state;
    const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    let tex = null;
    if (cv) {
      cv.width = cv.height = 128;
      const g = cv.getContext('2d');
      g.fillStyle = '#f7a1ad'; g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#d96a7c'; g.lineWidth = 6; g.beginPath(); g.arc(64, 64, 59, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#fff3ee';
      for (let i = 0; i < 16; i++) { const a = i * 2.4, r = 14 + (i * 23) % 38; g.beginPath(); g.ellipse(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 5, 3.5, a, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = '#3b2a2a';
      for (let i = 0; i < 7; i++) { const a = i * 0.9 + 0.5, r = 20 + (i * 17) % 30; g.beginPath(); g.arc(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 2.2, 0, Math.PI * 2); g.fill(); }
      tex = ctx.own(new T.CanvasTexture(cv));
      tex.colorSpace = T.SRGBColorSpace;
    }
    const face = ctx.own(new T.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 0.55 }));
    const rind = ctx.own(new T.MeshStandardMaterial({ color: 0xc8505f, roughness: 0.5 }));
    const geo = ctx.own(new T.CylinderGeometry(0.9, 0.9, 0.08, 28));
    geo.rotateX(Math.PI / 2);
    st.slices = [0, 1].map(() => {
      const m = new T.Mesh(geo, [rind, face, face]);
      m.visible = false;
      ctx.root.add(m);
      return m;
    });
    st.p = new T.Vector3();
    st.dust = { count: 3, color: 0xd8c8a8, size: 0.7, life: 0.7, radius: 1.4, alpha: 0.4 };
  },

  updateVisuals(ctx, dt) {
    const st = ctx.state;
    if (!st.slices) return;
    for (const m of st.slices) m.visible = false;
    for (let i = st.gulps.length - 1; i >= 0; i--) {
      const g = st.gulps[i];
      g.t += dt;
      if (g.t > 0.5) st.gulps.splice(i, 1);
    }
    st.gulps.slice(0, st.slices.length).forEach((g, i) => {
      const m = st.slices[i], k = g.kart, u = g.t / 0.5;
      kartPoint(k, 1.6 * (1 - u), 2.4 - 1.2 * u, 0, st.p);
      m.position.copy(st.p);
      m.rotation.set(0, k.yaw + u * 3, 0);
      m.scale.setScalar(Math.max(0.02, (1 - u) * 1.3));
      m.visible = true;
    });
    // heavy footsteps: dust under a rolling giant
    if (ctx.effects) {
      for (const k of st.list) {
        if (k.grounded && Math.abs(k.speed) > 6 && Math.random() < 0.35) {
          st.p.set(k.position.x - Math.sin(k.yaw) * 2, k.position.y + 0.2, k.position.z - Math.cos(k.yaw) * 2);
          ctx.effects.emit('dust', st.p, st.dust);
        }
      }
    }
  },

  callout: 'FLATTENED!',
});
