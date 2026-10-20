// Hot Potato 🥔 (v5 group B, research-v5-items.md B3; analog: the shrinking raincloud).
//
// Auto item: on the roulette end a steaming potato lands on the kart at once
// and the slot stays free. The carrier gets kart.potatoTimer = ITEM5.potatoTime
// s on the fuse, speed x1.10 (kart.js) and offroad immunity.
//   * Pass: touching / bumping a non-immune rival hands it over with
//     max(fuse, ITEM5.potatoPassMin) s left; no pass-back for ITEM5.potatoNoReturn s.
//     A ghost, an airborne leap (airImmune), a star or a giant can't receive it.
//   * Pop: at 0 it bursts in a steam cloud: the carrier shrinks for
//     ITEM5.potatoShrink s, drops its held item and loses 2 lire (coins.js on kart:shrink).
//   * Removed safely when the carrier becomes immune (star, beer, giant, ghost),
//     respawns or finishes. Max 1 in play; the 15 s cooldown runs from its end.
// Events: item:potato { kart } · item:potatoPass { from, to } · item:potatoPop { kart } · item:potatoEnd { kart, cause }.
// HUD: hud.js shows the fuse on the carrier's view (kart.potatoTimer).
// CPU: a carrier with <= 4 s left chases the nearest rival within 25 m (aiLure);
// other CPUs keep away from a carrier within 6 m (threats).

import { registerItem } from './registry.js';
import { ITEM5, ITEM_RULES, KART } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';
import { dropHeldItem, kartPoint } from './b-util.js';

const ID = 'hot_potato';
const PASS_GAP = 0.15;                  // m beyond the two radii that still counts as a touch

registerSound('potatoGet', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 520 * p, f1: 260 * p, glide: 0.2, dur: 0.24, peak: 0.12, vib: 40, vibRate: 14 });   // "uh-oh" boing
  SYNTH.hiss(ac, out, t + 0.05, { type: 'highpass', f0: 3500, dur: 0.5, peak: 0.05 });                                         // sizzle
  return 0.55;
}, 0.9);
registerSound('potatoPass', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'triangle', f0: 300 * p, f1: 900 * p, glide: 0.1, dur: 0.14, peak: 0.12 });
  SYNTH.hiss(ac, out, t, { type: 'bandpass', f0: 1200, f1: 3000, dur: 0.15, peak: 0.07 });
  return 0.2;
}, 0.9);
registerSound('potatoTick', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'square', f0: 1760 * p, dur: 0.035, peak: 0.05, lp: 5000 });
  return 0.05;
}, 0.9);
registerSound('potatoPop', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.kickDrum(ac, out, t, 1);
  SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 2500, f1: 400, dur: 0.7, peak: 0.22 });                  // steam blast
  SYNTH.blip(ac, out, t + 0.05, { type: 'sine', f0: 900 * p, f1: 300 * p, glide: 0.4, dur: 0.45, peak: 0.08 });
  return 0.8;
}, 0.9);

function canHold(ctx, k) {
  return k && !k.finished && !k.frozen && !ctx.immune(k) && !k.airImmune && !(k.beer);
}

function attach(ctx, k, fuse, from = null) {
  const P = ctx.state;
  P.holder = k;
  P.fuse = fuse;
  P.noReturn = from;
  P.noReturnUntil = ctx.time + ITEM5.potatoNoReturn;
  P.lastTick = Math.ceil(fuse);
  k.potatoTimer = fuse;
  k.offroadImmune = true;
}

function detach(ctx, k) {
  if (!k) return;
  k.potatoTimer = 0;
  k.offroadImmune = false;
}

function finish(ctx, cause) {
  const P = ctx.state, k = P.holder;
  if (!k) return;
  detach(ctx, k);
  P.holder = null;
  P.noReturn = null;
  ctx.startCooldown(ITEM_RULES[ID] ? ITEM_RULES[ID].cooldown : 15);
  ctx.emit('item:potatoEnd', { kart: k, cause });
}

registerItem(ID, {
  init(ctx) {
    const P = ctx.state;
    P.holder = null; P.fuse = 0; P.noReturn = null; P.noReturnUntil = 0; P.lastTick = 0;
    P.pops = [];
    ctx.on('kart:respawn', (e) => { if (e && e.kart === P.holder) finish(ctx, 'respawn'); });
    // a bump also passes it (kart.js emits kart:bump { a, b } on a real knock)
    ctx.on('kart:bump', (e) => {
      if (!e || !P.holder || (e.a !== P.holder && e.b !== P.holder)) return;
      const other = e.a === P.holder ? e.b : e.a;
      tryPass(ctx, other);
    });
  },

  // auto: the roulette end attaches it and frees the slot
  onGet(ctx, kart) {
    kart.item = null;
    kart.itemCount = 0;
    const P = ctx.state;
    if (P.holder || !canHold(ctx, kart)) return;            // one at a time (the rules keep it so)
    attach(ctx, kart, ITEM5.potatoTime, null);
    ctx.sys.used[ID] = (ctx.sys.used[ID] || 0) + 1;
    ctx.emit('item:use', { kart, item: ID, first: true });
    ctx.emit('item:potato', { kart });
    ctx.sfx('potatoGet', kart, 1);
    ctx.flash(kart, 'HOT POTATO!', '#ffb347', { sub: 'bump someone to pass it', vibrate: [30, 30, 30] });
  },

  use(ctx, kart) {
    // never in a slot (auto); a forced activation attaches it like onGet
    if (ctx.state.holder) return false;
    if (!canHold(ctx, kart)) return false;
    attach(ctx, kart, ITEM5.potatoTime, null);
    ctx.emit('item:potato', { kart });
    ctx.sfx('potatoGet', kart, 1);
    return true;
  },

  countLive(ctx) { return ctx.state.holder ? 1 : 0; },

  update(ctx, dt) {
    const P = ctx.state, k = P.holder;
    if (!k) return;
    if (k.finished || ctx.immune(k) || k.beer) { finish(ctx, 'safe'); return; }
    P.fuse -= dt;
    k.potatoTimer = Math.max(0.001, P.fuse);
    k.offroadImmune = true;
    // fuse ticks over the last 3 s
    const sec = Math.ceil(P.fuse);
    if (sec < P.lastTick) { P.lastTick = sec; if (sec <= 3 && sec > 0) ctx.sfx('potatoTick', k, 0.9, 1 + (3 - sec) * 0.12); }
    if (P.fuse <= 0) {
      // pop: shrink, drop the item, lose lire (coins.js on kart:shrink)
      detach(ctx, k);
      P.holder = null;
      k.shrink(ITEM5.potatoShrink, ID, true);
      dropHeldItem(ctx, k);
      ctx.emit('item:potatoPop', { kart: k });
      ctx.emit('item:hit', { kart: k, by: null, item: ID, effect: 'shrink' });
      ctx.sfx('potatoPop', k, 1);
      ctx.flash(k, 'POP!', '#ffb347', { sub: 'shrunk!', vibrate: [120, 60, 120] });
      if (ctx.vis) P.pops.push({ kart: k, t: 0 });
      ctx.startCooldown(ITEM_RULES[ID] ? ITEM_RULES[ID].cooldown : 15);
      ctx.emit('item:potatoEnd', { kart: k, cause: 'pop' });
      return;
    }
    // pass on touch
    const R = KART.radius * (k.sizeMult || 1);
    for (const o of ctx.karts) {
      if (o === k) continue;
      const dx = o.position.x - k.position.x, dz = o.position.z - k.position.z;
      const r = R + KART.radius * (o.sizeMult || 1) + PASS_GAP;
      if (dx * dx + dz * dz > r * r || Math.abs(o.position.y - k.position.y) > 1.6) continue;
      if (tryPass(ctx, o)) break;
    }
  },

  // CPUs keep away from a carrier within ~6 m (a static threat: always avoided when ahead)
  threats(ctx, kart, radius, push) {
    const P = ctx.state, h = P.holder;
    if (!h || h === kart || !h.proj) return;
    const dx = h.position.x - kart.position.x, dz = h.position.z - kart.position.z;
    if (dx * dx + dz * dz > Math.min(radius, 8) ** 2) return;
    push(h, { position: h.position, s: h.proj.s, lateral: h.proj.lateral, radius: KART.radius, clear: 3.6, type: 'potato', speed: 0, item: ID });
  },

  // the carrier with <= 4 s left chases the nearest rival within 25 m (ahead preferred)
  aiLure(ctx, kart, c) {
    const P = ctx.state;
    if (P.holder !== kart || P.fuse > 4) return null;
    let best = null, bd = Infinity;
    for (const o of ctx.karts) {
      if (o === kart || !canHold(ctx, o) || !o.proj || (o === P.noReturn && ctx.time < P.noReturnUntil)) continue;
      const ds = ctx.track.deltaS(c.s, o.proj.s);
      if (ds < -6 || ds > 25) continue;
      const score = ds >= 0 ? ds : 12 - ds;
      if (score < bd) { bd = score; best = o; }
    }
    return best ? { s: best.proj.s, lateral: best.proj.lateral, urgency: 0.48 } : null;
  },

  clear(ctx) {
    const P = ctx.state;
    if (P.holder) detach(ctx, P.holder);
    P.holder = null; P.noReturn = null; P.fuse = 0;
    P.pops.length = 0;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = ctx.THREE, st = ctx.state;
    const skin = ctx.own(new T.MeshStandardMaterial({ color: 0xb87a3e, roughness: 0.85, emissive: 0x501800, emissiveIntensity: 0.25 }));
    const eye = ctx.own(new T.MeshStandardMaterial({ color: 0x5a3416, roughness: 0.9 }));
    const g0 = ctx.own(new T.SphereGeometry(0.42, 16, 12));
    g0.scale(1.25, 0.85, 0.9);
    const spot = ctx.own(new T.SphereGeometry(0.05, 6, 5));
    const wick = ctx.own(new T.CylinderGeometry(0.025, 0.025, 0.28, 6));
    const wickMat = ctx.own(new T.MeshStandardMaterial({ color: 0x3a2a1a }));
    const g = new T.Group();
    const body = new T.Mesh(g0, skin);
    g.add(body);
    for (let i = 0; i < 6; i++) {
      const m = new T.Mesh(spot, eye);
      m.position.set(Math.cos(i * 1.9) * 0.4, Math.sin(i * 2.7) * 0.18, Math.sin(i * 1.9) * 0.33);
      g.add(m);
    }
    const w = new T.Mesh(wick, wickMat); w.position.set(0.15, 0.42, 0); w.rotation.z = -0.4;
    g.add(w);
    g.visible = false;
    ctx.root.add(g);
    st.mesh = g;
    st.body = body;
    st.p = new T.Vector3();
    st.wickTip = new T.Vector3();
    st.steam = { count: 1, color: 0xf2f2f2, size: 0.35, life: 0.7, radius: 0.15, alpha: 0.4, velocity: new T.Vector3(0, 1.5, 0) };
    st.spark = { count: 2, color: 0xffd36b, size: 0.1, life: 0.25, radius: 0.04 };
    st.blast = { count: 26, color: 0xffffff, size: 1.0, life: 1.1, radius: 1.2, alpha: 0.6 };
  },

  updateVisuals(ctx, dt) {
    const st = ctx.state;
    if (!st.mesh) return;
    const k = st.holder;
    st.mesh.visible = !!k;
    if (k) {
      const left = Math.max(0, st.fuse);
      const panic = left < 3 ? (3 - left) / 3 : 0;
      kartPoint(k, -0.15, 1.75 + Math.abs(Math.sin(ctx.time * (6 + panic * 10))) * 0.16, 0, st.p);
      st.mesh.position.copy(st.p);
      st.mesh.rotation.set(Math.sin(ctx.time * 7) * 0.2, ctx.time * 2, Math.cos(ctx.time * 5) * 0.2);
      st.mesh.scale.setScalar((k.sizeMult || 1) * 1.3 * (1 + panic * 0.25 * Math.abs(Math.sin(ctx.time * 18))));
      st.body.material.emissiveIntensity = 0.25 + panic * 1.2 * Math.abs(Math.sin(ctx.time * 14));
      if (ctx.effects) {
        if (Math.random() < 0.5) ctx.effects.emit('smoke', st.p, st.steam);
        st.wickTip.set(st.p.x, st.p.y + 0.6 * (k.sizeMult || 1), st.p.z);
        ctx.effects.emit('spark', st.wickTip, st.spark);
      }
    }
    for (let i = st.pops.length - 1; i >= 0; i--) {
      const pop = st.pops[i];
      if (pop.t === 0 && ctx.effects) {
        kartPoint(pop.kart, 0, 1.6, 0, st.p);
        ctx.effects.emit('smoke', st.p, st.blast);
        ctx.effects.emit('explosion', st.p, { count: 10, size: 0.8 });
      }
      pop.t += dt;
      if (pop.t > 0.1) st.pops.splice(i, 1);
    }
  },

  callout: 'HOT POTATO!',
});

function tryPass(ctx, o) {
  const P = ctx.state, k = P.holder;
  if (!k || o === k || !canHold(ctx, o)) return false;
  if (o === P.noReturn && ctx.time < P.noReturnUntil) return false;
  detach(ctx, k);
  attach(ctx, o, Math.max(P.fuse, ITEM5.potatoPassMin), k);
  ctx.emit('item:potatoPass', { from: k, to: o });
  ctx.sfx('potatoPass', o, 1);
  ctx.flash(o, 'HOT POTATO!', '#ffb347', { sub: `from ${k.name}`, subColor: k.cssColor, vibrate: [30, 30, 30] });
  ctx.flash(k, 'PASSED IT!', '#7dff6a', { sub: o.name, subColor: o.cssColor });
  return true;
}
