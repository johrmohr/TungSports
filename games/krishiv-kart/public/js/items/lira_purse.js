// Lira Purse 💰 (v5 group B, research-v5-items.md B9; analog: the coin item).
//
// One press: +ITEM5.purseCoins lire (capped at COIN.max), each with the
// pickup nudge. At the cap it does nothing but jingle (the 1st-place dud).
// A little leather purse pops up over the racer, tosses the lire and is caught.
// CPU: at once with <= 8 lire; otherwise hold it, use it when the lire drop or after 10 s.

import { registerItem } from './registry.js';
import { ITEM5, COIN } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';
import { giveCoins } from './coins.js';
import { kartPoint } from './b-util.js';

const POP_TIME = 0.9;

registerSound('purseJingle', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { type: 'bandpass', f0: 1800, f1: 900, dur: 0.12, peak: 0.05, Q: 2 });          // leather flap
  for (let i = 0; i < 6; i++) SYNTH.bell(ac, out, t + 0.06 + i * 0.045, (2400 + ((i * 397) % 900)) * p, 0.03, 0.2);
  return 0.45;
}, 0.9);

registerItem('lira_purse', {
  init(ctx) { ctx.state.pops = []; },

  use(ctx, kart) {
    const got = giveCoins(ctx.sys, kart, ITEM5.purseCoins, 'purse');
    ctx.sfx('purseJingle', kart, 1, got > 0 ? 1 : 0.85);
    ctx.emit('item:purse', { kart, gained: got });
    if (ctx.vis) ctx.state.pops.push({ kart, t: 0, got });
    return true;
  },

  aiUse(kart, c) {
    const coins = kart.coins | 0;
    if (coins <= COIN.max - ITEM5.purseCoins) return true;
    if (c.mem.held === undefined) c.mem.held = coins;
    return coins < c.mem.held || c.hold > 10;
  },

  clear(ctx) { ctx.state.pops.length = 0; },

  initVisuals(ctx) {
    const T = ctx.THREE, st = ctx.state;
    const bagMat = ctx.own(new T.MeshStandardMaterial({ color: 0x8a4a22, roughness: 0.7 }));
    const tieMat = ctx.own(new T.MeshStandardMaterial({ color: 0xffc22e, metalness: 0.5, roughness: 0.3, emissive: 0x9a6400, emissiveIntensity: 0.6 }));
    const bag = ctx.own(new T.SphereGeometry(0.34, 14, 10));
    bag.scale(1, 0.9, 0.85);
    const neck = ctx.own(new T.CylinderGeometry(0.11, 0.18, 0.16, 10));
    const tie = ctx.own(new T.TorusGeometry(0.13, 0.035, 6, 14));
    const coin = ctx.own(new T.CylinderGeometry(0.16, 0.16, 0.04, 14));
    coin.rotateX(Math.PI / 2);
    st.groups = [];
    for (let i = 0; i < 4; i++) {
      const g = new T.Group();
      const b = new T.Mesh(bag, bagMat);
      const n = new T.Mesh(neck, bagMat); n.position.y = 0.33;
      const r = new T.Mesh(tie, tieMat); r.position.y = 0.3; r.rotation.x = Math.PI / 2;
      g.add(b, n, r);
      g.userData.coins = [0, 1].map(() => { const m = new T.Mesh(coin, tieMat); g.add(m); return m; });
      g.visible = false;
      ctx.root.add(g);
      st.groups.push(g);
    }
    st.p = new T.Vector3();
  },

  updateVisuals(ctx, dt) {
    const st = ctx.state;
    if (!st.groups) return;
    for (const g of st.groups) g.visible = false;
    for (let i = st.pops.length - 1; i >= 0; i--) {
      const pop = st.pops[i];
      pop.t += dt;
      if (pop.t >= POP_TIME || !pop.kart) { st.pops.splice(i, 1); continue; }
    }
    for (let i = 0; i < st.pops.length && i < st.groups.length; i++) {
      const pop = st.pops[i], g = st.groups[i], k = pop.kart, u = pop.t / POP_TIME;
      kartPoint(k, 0.1, 1.5 + Math.sin(Math.min(1, u * 1.6) * Math.PI) * 0.45, 0, st.p);
      g.position.copy(st.p);
      g.rotation.set(0, k.yaw + u * 6, Math.sin(u * 14) * 0.2);
      const s = (u < 0.15 ? u / 0.15 : u > 0.85 ? (1 - u) / 0.15 : 1) * (k.sizeMult || 1);
      g.scale.setScalar(Math.max(0.01, s));
      g.visible = true;
      // two lire tossed up and caught back
      g.userData.coins.forEach((m, j) => {
        const a = Math.max(0, u * 1.4 - j * 0.15);
        m.visible = pop.got > j && a > 0 && a < 1;
        m.position.set((j ? 0.22 : -0.22), 0.35 + Math.sin(a * Math.PI) * 0.9, 0);
        m.rotation.y = a * 18;
      });
    }
  },
});
