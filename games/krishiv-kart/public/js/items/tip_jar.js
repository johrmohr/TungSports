// Tip Jar 🫙 (v5 group B, research-v5-items.md B10; analog: the coin-box block).
//
// The first press puts a glass tip jar over the kart and opens an
// ITEM5.tipWindow s window. Every tap (>= ITEM5.tipGap s apart, the first press
// included, ITEM5.tipTaps in all): +1 lira, a ITEM5.tipBoost s x ITEM5.tipBoostMult
// nudge, and ITEM5.tipSpill loose lire spill behind for the followers (the
// user can't regrab them for COIN.regrabDelay). The last tap bursts the jar:
// ITEM5.tipFinalSpill lire spill behind in a fan. Totals: 6 to the user, 16 to
// whoever follows. The jar is lost when the owner is hit or the window ends.
// CPU: taps every 0.4 s from pickup.

import { registerItem } from './registry.js';
import { ITEM5, ITEM_INFO } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';
import { giveCoins, spillCoins } from './coins.js';
import { setWindow, clearSlot, kartPoint } from './b-util.js';

const ID = 'tip_jar';

registerSound('tipTap', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.bell(ac, out, t, 3100 * p, 0.05, 0.25);                              // glass tink
  SYNTH.bell(ac, out, t + 0.03, 2250 * p, 0.04, 0.3);
  SYNTH.hiss(ac, out, t + 0.02, { type: 'highpass', f0: 5000, dur: 0.05, peak: 0.03 });
  return 0.32;
}, 0.9);
registerSound('tipBurst', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 3500, f1: 7000, dur: 0.25, peak: 0.12 });          // glass shatter
  for (let i = 0; i < 9; i++) SYNTH.bell(ac, out, t + 0.02 + i * 0.03, (2000 + ((i * 613) % 1800)) * p, 0.035, 0.22);
  SYNTH.blip(ac, out, t + 0.05, { type: 'triangle', f0: 660 * p, f1: 1320 * p, dur: 0.25, peak: 0.08 });
  return 0.6;
}, 0.9);

function endJar(ctx, kart, js, burst) {
  if (!js.active) return;
  js.active = false;
  clearSlot(kart, ID);
  ctx.emit('item:tipJarEnd', { kart, taps: js.taps, burst: !!burst });
  if (ctx.vis) ctx.state.shards.push({ kart, t: 0, burst: !!burst });
}

registerItem(ID, {
  init(ctx) { ctx.state.shards = []; ctx.state.list = new Set(); },

  use(ctx, kart) {
    const js = ctx.kstate(kart);
    const now = ctx.time;
    const first = !js.active;
    if (first) {
      js.active = true; js.taps = 0; js.t0 = now; js.last = -Infinity;
      ctx.state.list.add(kart);
      ctx.emit('item:tipJar', { kart });
    } else if (now - js.last < ITEM5.tipGap) return false;
    js.last = now;
    js.taps++;
    giveCoins(ctx.sys, kart, 1, 'tip');
    kart.applyBoost(ITEM5.tipBoost, 'coin', ITEM5.tipBoostMult);
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
    const back = { x: kart.position.x - fx * 1.6, y: kart.position.y, z: kart.position.z - fz * 1.6 };
    const last = js.taps >= ITEM5.tipTaps;
    if (last) {
      spillCoins(ctx.sys, back, ITEM5.tipFinalSpill, { owner: kart, dirX: -fx, dirZ: -fz, spread: 2.2, up: 6 });
      ctx.sfx('tipBurst', kart, 1);
    } else {
      spillCoins(ctx.sys, back, ITEM5.tipSpill, { owner: kart, dirX: -fx, dirZ: -fz, spread: 1.2, up: 5 });
      ctx.sfx('tipTap', kart, 1, 1 + js.taps * 0.06);
    }
    js.bump = 1;
    if (last) {
      // the slot empties through the normal consume (itemCount reaches 0)
      js.active = false;
      ctx.state.list.delete(kart);
      kart.itemWindow = 0;
      ctx.emit('item:tipJarEnd', { kart, taps: js.taps, burst: true });
      if (ctx.vis) ctx.state.shards.push({ kart, t: 0, burst: true });
      if (kart.item === ID) { kart.item = null; kart.itemCount = 0; }
      return { consume: false, first };
    }
    return { consume: true, first };
  },

  update(ctx) {
    const st = ctx.state;
    if (!st.list.size) return;
    for (const kart of st.list) {
      const js = ctx.kstate(kart);
      if (!js.active) { st.list.delete(kart); continue; }
      const left = ITEM5.tipWindow - (ctx.time - js.t0);
      if (left <= 0 || kart.item !== ID || kart.finished) { endJar(ctx, kart, js, false); st.list.delete(kart); continue; }
      setWindow(kart, left, ITEM5.tipWindow);
    }
  },

  onKartHit(ctx, kart) {
    const js = ctx.kstate(kart);
    if (js.active) { endJar(ctx, kart, js, false); ctx.state.list.delete(kart); }
  },

  aiUse(kart, c) {
    if (c.mem.next === undefined) c.mem.next = 0;
    if (c.hold < c.mem.next) return false;
    c.mem.next = c.hold + 0.4;
    return true;
  },

  clear(ctx) {
    for (const k of ctx.state.list) k.itemWindow = 0;
    ctx.state.list.clear();
    ctx.state.shards.length = 0;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = ctx.THREE, st = ctx.state;
    const glass = ctx.own(new T.MeshStandardMaterial({ color: 0xcfefff, transparent: true, opacity: 0.32, roughness: 0.05, metalness: 0.1, depthWrite: false, side: T.DoubleSide }));
    const rim = ctx.own(new T.MeshStandardMaterial({ color: 0xbfc7cf, metalness: 0.8, roughness: 0.25 }));
    const gold = ctx.own(new T.MeshStandardMaterial({ color: 0xf5c542, metalness: 0.7, roughness: 0.3, emissive: 0x4a3000, emissiveIntensity: 0.4 }));
    const label = ctx.own(new T.MeshStandardMaterial({ color: 0xffd166, roughness: 0.6 }));
    const body = ctx.own(new T.CylinderGeometry(0.62, 0.55, 1.05, 22, 1, true));
    const lid = ctx.own(new T.CylinderGeometry(0.5, 0.5, 0.1, 22));
    const neck = ctx.own(new T.TorusGeometry(0.5, 0.06, 8, 22));
    const coin = ctx.own(new T.CylinderGeometry(0.17, 0.17, 0.05, 12));
    const band = ctx.own(new T.CylinderGeometry(0.63, 0.6, 0.3, 22, 1, true));
    st.jars = new Map();
    st.make = () => {
      const g = new T.Group();
      const b = new T.Mesh(body, glass); b.position.y = 0.52;
      const l = new T.Mesh(lid, rim); l.position.y = 1.07;
      const n = new T.Mesh(neck, rim); n.position.y = 1.02; n.rotation.x = Math.PI / 2;
      const w = new T.Mesh(band, label); w.position.y = 0.42;
      g.add(b, l, n, w);
      g.userData.coins = [];
      for (let i = 0; i < 6; i++) {
        const m = new T.Mesh(coin, gold);
        m.position.set(Math.cos(i * 2.1) * 0.25, 0.1 + i * 0.07, Math.sin(i * 2.1) * 0.25);
        m.rotation.set(0.3 * i, i, 0.2);
        g.add(m);
        g.userData.coins.push(m);
      }
      ctx.root.add(g);
      return g;
    };
    st.p = new T.Vector3();
    st.spark = { count: 14, color: 0xdff6ff, size: 0.14, life: 0.5, radius: 0.5, spread: 5 };
    st.glit = { count: 10, color: 0xffd84a, size: 0.22, life: 0.6, radius: 0.6 };
  },

  updateVisuals(ctx, dt) {
    const st = ctx.state;
    if (!st.jars) return;
    for (const [k, g] of st.jars) if (!st.list.has(k)) g.visible = false;
    for (const k of st.list) {
      let g = st.jars.get(k);
      if (!g) { g = st.make(); st.jars.set(k, g); }
      const js = ctx.kstate(k);
      js.bump = Math.max(0, (js.bump || 0) - dt * 5);
      kartPoint(k, -0.1, 1.15 + js.bump * 0.25, 0, st.p);
      g.position.copy(st.p);
      g.rotation.set(0, k.yaw, Math.sin(ctx.time * 9) * 0.05 * (1 + js.bump * 4));
      g.scale.setScalar((k.sizeMult || 1) * (1 + js.bump * 0.12));
      g.visible = true;
      const n = Math.max(0, (ITEM_INFO[ID].uses || 6) - (js.taps || 0));
      g.userData.coins.forEach((m, i) => { m.visible = i < n; });
    }
    for (let i = st.shards.length - 1; i >= 0; i--) {
      const s = st.shards[i];
      if (s.t === 0 && ctx.effects && s.kart) {
        kartPoint(s.kart, -0.1, 1.5, 0, st.p);
        ctx.effects.emit('spark', st.p, st.spark);
        if (s.burst) ctx.effects.emit('glitter', st.p, st.glit);
      }
      s.t += dt;
      if (s.t > 0.1) st.shards.splice(i, 1);
    }
  },

  disposeVisuals(ctx) { if (ctx.state.jars) ctx.state.jars.clear(); },
});
