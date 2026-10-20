// Taralli Hoops (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A12, §C9).
//
// Three upright golden ring-crackers stand on the road ITEM5.ringAt (12 / 28 /
// 46) m ahead of the user along the track, at the user's lateral offset eased
// ITEM5.ringLineBlend toward the racing line, centred ITEM5.ringHeight m up.
// ANY kart whose centre crosses a ring's plane within ITEM5.ringRadius of its
// centre gets a pad-strength boost (applyBoost(ITEM5.ringBoost, 'pad'): x1.32,
// and like a pad it washes espresso off the screen), once per kart per ring.
// The rings last ITEM5.ringLife s; nothing destroys them (role 'fx').
//
// CPUs steer for a ring within 2.5 m of their line (aiLure, like a dash pad).
// CPU use: when the next 50 m are fairly straight, or at once from 6th back.

import * as THREE from 'three';
import { registerItem } from './registry.js';
import { ITEM5 } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';

const CAP = 12, KART_YOFF = 0.5, LURE_LAT = 2.5;

registerSound('ringSpawn', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  [0, 4, 7].forEach((st, i) => SYNTH.bell(ac, out, t + i * 0.07, SYNTH.mtof(76 + st) * p, 0.07, 0.5));
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 5000, dur: 0.25, peak: 0.04 });
  return 0.6;
}, 1.3);
registerSound('ringBoost', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a bright "whoom-ting": rising swoosh + a ringing chord
  SYNTH.hiss(ac, out, t, { f0: 600, f1: 3800, sweep: 0.22, dur: 0.28, peak: 0.16, Q: 1.2 });
  SYNTH.blip(ac, out, t, { type: 'triangle', f0: 440 * p, f1: 1320 * p, glide: 0.2, dur: 0.25, peak: 0.12 });
  SYNTH.bell(ac, out, t + 0.12, SYNTH.mtof(84) * p, 0.07, 0.6);
  SYNTH.bell(ac, out, t + 0.12, SYNTH.mtof(91) * p, 0.04, 0.5);
  return 0.7;
}, 1.3);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0), _z = new THREE.Vector3(), _f = {};

registerItem('taralli', {
  init(ctx) { ctx.state.mesh = null; },

  use(ctx, kart) {
    const tr = ctx.track;
    const pr = kart.proj && Number.isFinite(kart.proj.s) ? kart.proj : ctx.project(kart.position, kart.hint);
    const s0 = pr.s, lat0 = pr.lateral || 0;
    let n = 0;
    for (const ahead of ITEM5.ringAt) {
      const s = tr.wrapS(s0 + ahead);
      const f = tr.frameAt(s, _f);
      const lim = Math.max(0, f.halfWidth - ITEM5.ringRadius * 0.6);
      const lat = Math.max(-lim, Math.min(lim, lat0 + ((f.racingLine || 0) - lat0) * ITEM5.ringLineBlend));
      const pos = tr.pointAt(s, lat, new THREE.Vector3());
      pos.y += ITEM5.ringHeight;
      const e = ctx.spawn({
        kind: 'ring', role: 'fx', owner: kart, position: pos, s, lateral: lat, radius: ITEM5.ringRadius, life: ITEM5.ringLife,
        data: { tx: f.tangent.x, tz: f.tangent.z, rx: f.right.x, rz: f.right.z, side: new Float32Array(ctx.karts.length), taken: 0, n: n++, pulse: 0 },
      });
      e.s = s; e.lateral = lat;
      // which side of the plane each kart starts on
      for (let i = 0; i < ctx.karts.length; i++) e.data.side[i] = sideOf(e, ctx.karts[i]);
    }
    ctx.sfx('ringSpawn', kart);
    ctx.emit('item:taralli', { kart });
    return true;
  },

  update(ctx, dt) {
    const karts = ctx.karts;
    for (const e of ctx.entities()) {
      const d = e.data;
      if (d.pulse > 0) d.pulse = Math.max(0, d.pulse - dt * 2.5);
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        const sd = sideOf(e, k), prev = d.side[i];
        d.side[i] = sd;
        if (!(prev < 0 && sd >= 0) && !(prev > 0 && sd <= 0)) continue;     // no crossing this substep
        const bit = 1 << (i & 31);
        if (d.taken & bit || k.finished) continue;
        // radial distance from the ring centre in the ring plane
        const dx = k.position.x - e.position.x, dz = k.position.z - e.position.z;
        const lat = dx * d.rx + dz * d.rz, up = k.position.y + KART_YOFF - e.position.y;
        if (lat * lat + up * up > ITEM5.ringRadius * ITEM5.ringRadius) continue;
        d.taken |= bit;
        d.pulse = 1;
        k.applyBoost(ITEM5.ringBoost, 'pad');
        ctx.sfx('ringBoost', k);
        ctx.emit('item:ringBoost', { kart: k, by: e.owner, ring: d.n });
        if (ctx.effects) {
          _p.set(e.position.x, e.position.y, e.position.z);
          ctx.effects.emit('glitter', _p, { count: 22, spread: 4.5, radius: ITEM5.ringRadius * 0.9 });
          ctx.effects.emit('sparkle', _p, { count: 10, color: 0xffe9a0, spread: 3, radius: 1.6 });
        }
      }
    }
  },

  // CPUs aim for a ring ahead of them that they have not taken yet, if it is near their line (like a dash pad)
  aiLure(ctx, kart, c) {
    const i = ctx.karts.indexOf(kart), bit = 1 << (i & 31);
    let best = null, bd = Infinity;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || (e.data.taken & bit)) continue;
      const ds = ctx.deltaS(c.s, e.s);
      if (ds < 2 || ds > 45 || ds >= bd) continue;
      if (Math.abs(e.lateral - c.plannedLat(e.s)) > LURE_LAT) continue;
      bd = ds; best = e;
    }
    return best ? { s: best.s, lateral: best.lateral, urgency: 0.42 } : null;
  },

  aiUse(kart, c) {
    const n = c.karts.length || 8;
    const place8 = n > 1 ? 1 + ((c.place - 1) * 7) / (n - 1) : 1;
    if (place8 >= 6) return true;
    if (c.straightAhead(50)) return true;
    return c.hold > 10;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE;
    // a twisted two-strand ring-cracker (ring radius = hoop radius + the tube)
    const R = ITEM5.ringRadius + 0.18, tw = 0.1, turns = 14;
    const strands = [];
    for (let k = 0; k < 2; k++) {
      const curve = new T.Curve();
      curve.getPoint = (u, target = new T.Vector3()) => {
        const th = u * Math.PI * 2, ph = th * turns + k * Math.PI;
        const r = R + tw * Math.cos(ph);
        return target.set(Math.cos(th) * r, Math.sin(th) * r, tw * Math.sin(ph));
      };
      strands.push(ctx.part(new T.TubeGeometry(curve, 220, 0.15, 7, true), k ? 0xd99a3a : 0xe6ae4c));
    }
    // fennel seeds speckled over it
    for (let i = 0; i < 46; i++) {
      const th = (i / 46) * Math.PI * 2 + 0.07 * Math.sin(i * 7), r = R + 0.14 * Math.cos(i * 2.3);
      strands.push(ctx.part(new T.SphereGeometry(0.045, 5, 4), i % 3 ? 0x7a5420 : 0x9a8a3a, {
        scale: [1, 0.6, 1.6], pos: [Math.cos(th) * r, Math.sin(th) * r, 0.17 * Math.sin(i * 1.7)],
      }));
    }
    const geo = ctx.mergeParts(strands);
    const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, emissive: 0x6a4210, emissiveIntensity: 0.55 });
    ctx.state.mat = mat;
    ctx.state.mesh = ctx.instanced(geo, mat, CAP, 'taralli-hoops', { shadow: true });
    // inner shimmer disc (additive, very faint) so the "go through me" target reads
    const disc = ctx.own(new T.CircleGeometry(ITEM5.ringRadius, 32));
    const dmat = new T.MeshBasicMaterial({ color: 0xffe6a0, transparent: true, opacity: 0.16, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false });
    ctx.state.disc = ctx.instanced(disc, dmat, CAP, 'taralli-glow', { shadow: false, order: 4 });
  },

  updateVisuals(ctx) {
    const m = ctx.state.mesh, dm = ctx.state.disc;
    if (!m) return;
    const t = ctx.time;
    let i = 0;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || i >= CAP) continue;
      const d = e.data;
      const born = Math.min(1, (e.age - d.n * 0.08) / 0.35);
      const left = e.life - e.age;
      const pop = born <= 0 ? 0.001 : born < 1 ? 1 + 0.25 * Math.sin(born * Math.PI) - 0.25 * (1 - born) : 1;
      const sc = Math.max(0.001, pop * (left < 0.6 ? left / 0.6 : 1) * (1 + 0.12 * d.pulse));
      // the ring plane faces along the road: local z = road tangent
      _z.set(d.tx, 0, d.tz).normalize();
      _x.set(-d.rx, 0, -d.rz).normalize();          // left: (left, up, forward) is a right-handed basis
      _m.makeBasis(_x, _y, _z);
      _q.setFromRotationMatrix(_m);
      _p.set(e.position.x, e.position.y + Math.sin(t * 3 + d.n) * 0.05, e.position.z);
      _s.setScalar(sc);
      _m.compose(_p, _q, _s);
      m.setMatrixAt(i, _m);
      dm.setMatrixAt(i, _m);
      i++;
    }
    m.count = dm.count = i;
    m.visible = dm.visible = i > 0;
    m.instanceMatrix.needsUpdate = true;
    dm.instanceMatrix.needsUpdate = true;
    if (ctx.state.mat) ctx.state.mat.emissiveIntensity = 0.45 + 0.2 * Math.sin(t * 6);
    // a few glints drifting off the rings
    if (ctx.effects && i > 0 && Math.random() < 0.12) {
      for (const e of ctx.sys.entities) {
        if (e.plugin !== ctx || !e.active) continue;
        const a = Math.random() * Math.PI * 2;
        _p.set(e.position.x + Math.cos(a) * e.data.rx * ITEM5.ringRadius, e.position.y + Math.sin(a) * ITEM5.ringRadius, e.position.z + Math.cos(a) * e.data.rz * ITEM5.ringRadius);
        ctx.effects.emit('sparkle', _p, { count: 1, color: 0xfff0b0, spread: 0.6, radius: 0.1 });
      }
    }
  },
});

// Signed distance of the kart centre from a ring's plane (along the road tangent at the ring).
function sideOf(e, k) {
  const d = e.data;
  return (k.position.x - e.position.x) * d.tx + (k.position.z - e.position.z) * d.tz;
}
