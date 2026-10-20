// Antipasto Platter 🍽️ (v5 group B, research-v5-items.md B7; analog: the ring of eight items).
//
// On pickup eight items orbit the kart (radius ITEM5.platterRadius, 0.6 m up,
// ITEM5.platterSpeed rad/s), in ITEM5.platter order: banana, bouncer, rocket,
// toot, star, espresso, meatball_bomb, lira_purse. Each press uses the one
// nearest the nose with that item's normal rules (ctx.activate). itemCount =
// orbiters left. The orbiters are solid entities: a native bouncer / rocket
// hitting one destroys both, a blast takes them.
// A rival touching an orbiter sets it off on itself: banana → spin, bouncer /
// rocket → tumble, bomb → explodes there, toot / star → the RIVAL gets a
// ITEM5.platterTouchBoost s boost, espresso → a ITEM5.platterInk s coffee
// splat, lira → the rival +1. Every orbiter is lost when the owner is hit.
// Free from 30 s, max 1. CPUs get it too (unlike the original).
// CPU: uses the nose item by its own rule, else one every 2.5 s.

import { registerItem } from './registry.js';
import { ITEM5, ITEM_INFO, ITEM } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';
import { giveCoins } from './coins.js';
import { clearSlot, splatInk, isRival } from './b-util.js';

const ID = 'antipasto';
const ORBIT_H = 0.6;
const TOUCH_R = 0.55;

registerSound('platterOn', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // cutlery on china: a bright clink cascade + a little fanfare (our own)
  for (let i = 0; i < 4; i++) SYNTH.bell(ac, out, t + i * 0.05, (2600 + i * 330) * p, 0.04, 0.3);
  [523, 659, 784, 1047].forEach((f, i) => SYNTH.note(ac, out, t + 0.18 + i * 0.07, f * p, 0.12, { type: 'square', peak: 0.04, lp: 3500 }));
  return 0.6;
}, 0.9);
registerSound('platterServe', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.bell(ac, out, t, 2900 * p, 0.04, 0.2);
  SYNTH.blip(ac, out, t, { type: 'triangle', f0: 700 * p, f1: 1050 * p, dur: 0.08, peak: 0.05 });
  return 0.22;
}, 0.9);

function orbiters(ctx, kart) {
  const out = [];
  for (const e of ctx.sys.entities) if (e.active && e.plugin === ctx && e.owner === kart) out.push(e);
  return out;
}

function sync(ctx, kart) {
  if (!kart) return;
  const n = orbiters(ctx, kart).length;
  if (kart.item === ID) {
    if (n <= 0) { clearSlot(kart, ID); ctx.state.list.delete(kart); }
    else kart.itemCount = n;
  } else if (n <= 0) ctx.state.list.delete(kart);
}

function dropAll(ctx, kart, reason) {
  const ps = ctx.kstate(kart);
  ps.dropping = true;
  for (const e of orbiters(ctx, kart)) ctx.remove(e, reason);
  ps.dropping = false;
  clearSlot(kart, ID);
  ctx.state.list.delete(kart);
}

function place(ctx, kart, e, ang) {
  const sz = kart.sizeMult || 1, r = ITEM5.platterRadius * sz;
  e.position.set(kart.position.x + Math.sin(ang) * r, kart.position.y + ORBIT_H * sz, kart.position.z + Math.cos(ang) * r);
}

function serve(ctx, kart) {
  const ps = ctx.kstate(kart);
  ps.angle = kart.yaw;
  ps.used = false;
  ps.t0 = ctx.time;
  ps.last = ctx.time;
  for (const e of orbiters(ctx, kart)) ctx.remove(e, 'clear');
  ITEM5.platter.forEach((id, i) => {
    const e = ctx.spawn({ kind: id, owner: kart, radius: TOUCH_R, solid: true, data: { slot: i, id } });
    place(ctx, kart, e, ps.angle + (i / ITEM5.platter.length) * Math.PI * 2);
  });
  ctx.state.list.add(kart);
  kart.itemCount = ITEM5.platter.length;
  ctx.sfx('platterOn', kart, 1);
  ctx.emit('item:antipasto', { kart });
}

// the orbiter nearest the nose
function noseOrbiter(ctx, kart) {
  const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
  let best = null, bd = -Infinity;
  for (const e of orbiters(ctx, kart)) {
    const dx = e.position.x - kart.position.x, dz = e.position.z - kart.position.z;
    const d = (dx * fx + dz * fz) / (Math.hypot(dx, dz) || 1);
    if (d > bd) { bd = d; best = e; }
  }
  return best;
}

// A rival set an orbiter off on itself.
function touchOff(ctx, owner, e, k) {
  const id = e.data.id;
  const at = { x: e.position.x, y: e.position.y, z: e.position.z };
  ctx.remove(e, 'touch');
  switch (id) {
    case 'banana': ctx.hit(k, 'spin', { by: owner, cause: 'banana' }); break;
    case 'bouncer': case 'rocket': ctx.hit(k, 'tumble', { by: owner, cause: id }); break;
    case 'toot': case 'star': if (!k.isDisabled()) k.applyBoost(ITEM5.platterTouchBoost, 'item'); break;
    case 'espresso': if (splatInk(ctx, k, ITEM5.platterInk, owner)) ctx.emit('item:hit', { kart: k, by: owner, item: ID, effect: 'ink', light: true }); break;
    case 'lira_purse': giveCoins(ctx.sys, k, 1, 'platter'); break;
    case 'meatball_bomb': {
      // it goes off right there (a native bomb set at the orbiter, exploding at once)
      const b = typeof ctx.sys._throwBomb === 'function' ? ctx.sys._throwBomb(owner) : null;
      if (b) { b.position.set(at.x, at.y, at.z); ctx.sys._explodeBomb(b); }
      break;
    }
    default: break;
  }
  ctx.sfx('platterServe', k, 0.8);
  ctx.emit('item:platterTouch', { kart: owner, by: k, item: id });
}

registerItem(ID, {
  init(ctx) {
    ctx.state.list = new Set();
    ctx.on('kart:squash', (e) => { if (e && ctx.state.list.has(e.kart)) dropAll(ctx, e.kart, 'lost'); });
  },

  onGet(ctx, kart) { serve(ctx, kart); },

  use(ctx, kart) {
    if (!orbiters(ctx, kart).length) {
      // given without the roulette (ctx.activate / a test): serve now
      if (kart.item === ID) { serve(ctx, kart); return { consume: false }; }
      return false;
    }
    const e = noseOrbiter(ctx, kart);
    if (!e) return false;
    const id = e.data.id;
    const ps = ctx.kstate(kart);
    ps.last = ctx.time;
    ps.dropping = true;
    ctx.remove(e, 'use');
    ps.dropping = false;
    ctx.activate(kart, id);
    ctx.sfx('platterServe', kart, 1);
    ctx.emit('item:platterUse', { kart, item: id });
    sync(ctx, kart);
    const first = !ps.used;
    ps.used = true;
    return { consume: false, first };
  },

  update(ctx, dt) {
    const st = ctx.state;
    if (!st.list.size) return;
    for (const kart of st.list) {
      const ps = ctx.kstate(kart);
      ps.angle = (ps.angle + ITEM5.platterSpeed * dt) % (Math.PI * 2);
      const os = orbiters(ctx, kart);
      if (!os.length || kart.finished) { dropAll(ctx, kart, 'clear'); continue; }
      if (kart.item !== ID) { dropAll(ctx, kart, 'lost'); continue; }
      for (const e of os) place(ctx, kart, e, ps.angle + (e.data.slot / ITEM5.platter.length) * Math.PI * 2);
      // rivals touching an orbiter
      for (const e of os) {
        if (!e.active) continue;
        const ks = ctx.kartsTouching(e.position, TOUCH_R, { dy: 1.6, yOff: 0.5, skip: kart });
        const k = ks.find((o) => isRival(o, kart) && !(o.ghostTimer > 0) && !o.airImmune);
        if (!k) continue;
        if (ctx.immune(k)) { ctx.remove(e, 'smash'); continue; }      // a star / giant just smashes it
        touchOff(ctx, kart, e, k);
      }
      sync(ctx, kart);
    }
  },

  onEntityRemove(ctx, e, reason) {
    const owner = e.owner;
    if (!owner || ctx.kstate(owner).dropping || reason === 'clear') return;
    // blasts / native projectiles took one: the count follows
    sync(ctx, owner);
  },

  onKartHit(ctx, kart) { if (ctx.state.list.has(kart)) dropAll(ctx, kart, 'lost'); },

  stealable() { return false; },

  aiUse(kart, c) {
    const pc = c.plugin;
    if (!pc) return c.hold > 2.5;
    const e = noseOrbiter(pc, kart);
    if (!e) return true;
    const last = c.mem.last ?? 0;
    const gapOk = c.hold - last > 0.5;
    let go = false;
    switch (e.data.id) {
      case 'banana': go = !!c.rivalBehind(1, 15, 3); break;
      case 'bouncer': go = !!c.kartInSights(40); break;
      case 'rocket': { const a = c.kartAhead(); go = !!(a && !a.finished); break; }
      case 'toot': go = c.straightAhead(30); break;
      case 'star': go = true; break;
      case 'espresso': go = c.place >= 2; break;
      case 'meatball_bomb': go = !!c.rivalAhead(12, 30, 0.44); break;
      case 'lira_purse': go = (kart.coins | 0) <= 8; break;
      default: break;
    }
    if (!(go && gapOk) && c.hold - last < 2.5) return false;
    c.mem.last = c.hold;
    return true;
  },

  clear(ctx) { ctx.state.list.clear(); },

  // ---------------------------------------------------------------- visuals: little silver plates carrying each item
  initVisuals(ctx) {
    const T = ctx.THREE, st = ctx.state;
    const plateGeo = ctx.own(new T.CylinderGeometry(0.42, 0.32, 0.06, 20));
    const plateMat = ctx.own(new T.MeshStandardMaterial({ color: 0xe8edf2, metalness: 0.85, roughness: 0.22 }));
    st.plates = new T.InstancedMesh(plateGeo, plateMat, 8);
    st.plates.count = 0;
    st.plates.frustumCulled = false;
    ctx.root.add(st.plates);
    st.sprites = ITEM5.platter.map((id) => {
      const mat = ctx.own(new T.SpriteMaterial({ map: ctx.own(iconTexture(T, ITEM_INFO[id] ? ITEM_INFO[id].icon : '?', ITEM_INFO[id] ? ITEM_INFO[id].color : '#fff')), depthWrite: false, transparent: true }));
      const s = new T.Sprite(mat);
      s.scale.set(0.85, 0.85, 1);
      s.visible = false;
      ctx.root.add(s);
      return s;
    });
    st.m = new T.Matrix4();
    st.p = new T.Vector3();
  },

  updateVisuals(ctx) {
    const st = ctx.state;
    if (!st.plates) return;
    for (const s of st.sprites) s.visible = false;
    let i = 0;
    for (const kart of st.list) {
      const sz = kart.sizeMult || 1;
      for (const e of orbiters(ctx, kart)) {
        if (i < 8) { st.m.makeTranslation(e.position.x, e.position.y - 0.05, e.position.z); st.plates.setMatrixAt(i++, st.m); }
        const s = st.sprites[e.data.slot];
        if (s) {
          s.position.set(e.position.x, e.position.y + 0.42 * sz + Math.sin(ctx.time * 5 + e.data.slot) * 0.06, e.position.z);
          s.scale.set(0.85 * sz, 0.85 * sz, 1);
          s.visible = true;
        }
      }
    }
    st.plates.count = i;
    st.plates.instanceMatrix.needsUpdate = true;
  },
});

// An item icon (emoji) on a soft coloured disc, for the orbiting sprites.
function iconTexture(T, icon, color) {
  const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!cv) return new T.Texture();
  cv.width = cv.height = 96;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(48, 48, 6, 48, 48, 46);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.7, color);
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(48, 48, 46, 0, Math.PI * 2); g.fill();
  g.font = '56px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(icon, 48, 52);
  const tex = new T.CanvasTexture(cv);
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}
