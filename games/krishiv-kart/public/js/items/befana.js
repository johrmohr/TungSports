// Befana's Broom (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A13, §C7, §C9).
//
// The kindly Epiphany witch of Italian folklore — headscarf, patched shawl, a
// sack of coal — launches from the user and flies along the track centre
// ITEM5.befanaHeight m up at befanaSpeed x cc m/s, past every kart ahead. Each
// kart ahead of the user that she passes within ITEM5.befanaHexRadius m
// (horizontally) is SOOTED for HIT.sootTime s (kart.soot: drift cancelled,
// items locked, speed x0.94); stars / Beer Rockets / ghosts / giants are
// spared, and a kart far enough off to the side escapes. She drops a cluster of
// ITEM5.coalPerDrop coal lumps ITEM5.coalAhead m in front of each of up to
// ITEM5.coalDrops front-most karts: two staggered rows with >= ITEM5.coalGap m
// between lumps, static for ITEM5.coalLife s; touching one spins you (it
// breaks). She ends ITEM5.befanaPast m past the leader or after
// ITEM5.befanaLife s in a sparkle poof; ITEM_RULES gives the 30 s cooldown
// from the end (ctx.startCooldown) and the 3rd-or-worse place gate. Nothing
// stops her (role 'fx', sturdy); the accordion, stars and Beer Rockets clear
// coal (role 'hazard', threats for the CPUs).
//
// item:hit for a soot carries coinLoss: 0 (soot is not a crash: no lire lost).
// CPU use: at once when not leading and >= 2 karts are ahead.

import * as THREE from 'three';
import { registerItem } from './registry.js';
import { ITEM5, HIT } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';

const CAP_COAL = 36, CLUSTER_SPACING = 18, ROW_GAP = 9;

registerSound('befanaLaunch', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a broom whoosh + a kindly old "eh-heh-heh" laugh (formant-ish blips) + a twinkle
  SYNTH.hiss(ac, out, t, { f0: 500, f1: 3000, sweep: 0.35, dur: 0.45, peak: 0.16, Q: 1.3 });
  for (let i = 0; i < 4; i++) {
    const f = (520 - i * 45) * p;
    SYNTH.blip(ac, out, t + 0.12 + i * 0.12, { type: 'sawtooth', f0: f, f1: f * 0.82, glide: 0.08, dur: 0.09, peak: 0.07, lp: 1800, Q: 5 });
  }
  [0, 5, 9].forEach((st, i) => SYNTH.bell(ac, out, t + 0.6 + i * 0.06, SYNTH.mtof(86 + st) * p, 0.04, 0.4));
  return 0.95;
}, 1.3);
registerSound('befanaSoot', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 1400, f1: 300, sweep: 0.3, dur: 0.4, peak: 0.28 });
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 180 * p, f1: 90 * p, glide: 0.2, dur: 0.25, peak: 0.14 });
  SYNTH.blip(ac, out, t + 0.1, { type: 'square', f0: 330 * p, f1: 300 * p, glide: 0.1, dur: 0.12, peak: 0.04, lp: 1200 });   // a cough
  return 0.45;
}, 1.4);
registerSound('coalDrop', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  for (let i = 0; i < 4; i++) SYNTH.blip(ac, out, t + i * 0.05 + Math.random() * 0.02, { type: 'sine', f0: (260 + 60 * i) * p, f1: 110 * p, glide: 0.05, dur: 0.07, peak: 0.12 });
  SYNTH.hiss(ac, out, t, { type: 'lowpass', f0: 800, dur: 0.25, peak: 0.08 });
  return 0.35;
}, 1.3);
registerSound('coalHit', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { type: 'bandpass', f0: 900, dur: 0.18, peak: 0.24, Q: 1.5 });
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 200 * p, f1: 80 * p, glide: 0.1, dur: 0.16, peak: 0.22 });
  return 0.25;
}, 1.4);
registerSound('befanaPoof', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 3000, dur: 0.3, peak: 0.12 });
  [0, 4, 7, 12].forEach((st, i) => SYNTH.bell(ac, out, t + i * 0.05, SYNTH.mtof(79 + st) * p, 0.05, 0.5));
  return 0.6;
}, 1.2);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const _tmp = new THREE.Vector3(), _f = {};

function lumpGeometry(T, r, seed) {
  const g = new T.DodecahedronGeometry(r, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = 1 + 0.22 * Math.sin(x * 9 + seed) * Math.sin(y * 11 - seed) * Math.cos(z * 7 + seed * 2);
    pos.setXYZ(i, x * n, y * n * 0.8, z * n);
  }
  g.computeVertexNormals();
  return g;
}

// A cluster of coal lumps: ITEM5.coalPerDrop lanes evenly across the road, alternating between two rows
// ROW_GAP m apart (a slalom). Same-row lumps are 2 lanes apart and neighbours are diagonal, so every
// surface-to-surface gap is >= ITEM5.coalGap on a road >= 8.5 m half-width.
function dropCluster(ctx, s, owner, fromPos) {
  const tr = ctx.track, per = ITEM5.coalPerDrop;
  const made = [];
  for (let j = 0; j < per; j++) {
    const row = j % 2, rs = tr.wrapS(s + row * ROW_GAP);
    const f = tr.frameAt(rs, _f);
    const lim = Math.max(1, f.halfWidth - 1.0);
    const lat = per > 1 ? -lim + ((2 * lim) / (per - 1)) * j : 0;
    const pos = tr.pointAt(rs, lat, _tmp);
    made.push(ctx.spawn({
      kind: 'coal', role: 'hazard', owner, position: pos, radius: ITEM5.coalRadius, life: ITEM5.coalLife,
      threat: true, clear: ITEM5.coalRadius + 1.15, solid: true, ownerGrace: 0,
      data: { from: fromPos ? Math.max(1, fromPos.y - pos.y) : 6, seed: ctx.rng() * 6.28, delay: 0.05 * j },
    }));
  }
  return made;
}

function endFlight(ctx, e) {
  if (!e.active) return;
  ctx.remove(e, 'done');
}

registerItem('befana', {
  init(ctx) { ctx.state.witch = null; ctx.state.coal = null; },

  use(ctx, kart) {
    const victims = ctx.kartsAhead(kart);
    const pr = kart.proj && Number.isFinite(kart.proj.s) ? kart.proj : ctx.project(kart.position, kart.hint);
    // the front-most karts (up to coalDrops of them) get a coal cluster each
    const leaders = ctx.standings().filter((k) => !k.finished && victims.includes(k)).slice(0, ITEM5.coalDrops);
    const e = ctx.spawn({
      kind: 'befana', role: 'fx', owner: kart, sturdy: true, radius: 1, height: ITEM5.befanaHeight, life: ITEM5.befanaLife,
      speed: ITEM5.befanaSpeed * ctx.ccMult, s: ctx.wrapS(pr.s), lateral: pr.lateral || 0,
      data: { victims, sooted: new Set(), leaders, dropped: new Set(), clusters: [], seed: ctx.rng() * 6.28 },
    });
    e.dist = kart.distance || 0;
    ctx.sfx('befanaLaunch', kart);
    ctx.emit('item:befana', { kart, victims: victims.slice() });
    for (const v of victims) ctx.flash(v, 'BEFANA!', '#b28bff', { size: 'small', duration: 0.8, vibrate: [40] });
    return true;
  },

  update(ctx, dt) {
    const list = ctx.entities();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.active) continue;
      if (e.kind === 'coal') { stepCoal(ctx, e, dt); continue; }
      const d = e.data;
      ctx.stepTrack(e, dt, { lateral: 0, rate: 4 });
      // soot every victim she passes close enough to
      for (const k of d.victims) {
        if (d.sooted.has(k) || k.finished) continue;
        const dx = k.position.x - e.position.x, dz = k.position.z - e.position.z;
        if (dx * dx + dz * dz > ITEM5.befanaHexRadius * ITEM5.befanaHexRadius) continue;
        d.sooted.add(k);
        if (ctx.hit(k, 'soot', { by: e.owner, duration: HIT.sootTime, coinLoss: 0 })) {
          ctx.sfx('befanaSoot', k);
          ctx.flash(k, 'SOOTED!', '#7b4fc9', { size: 'medium', duration: 1.2, sub: 'items locked', vibrate: [30, 30, 30, 30, 30] });
          if (ctx.effects) {
            _p.set(k.position.x, k.position.y + 1, k.position.z);
            ctx.effects.emit('smoke', _p, { count: 10, color: 0x2a2a30, size: 1.0, alpha: 0.7, spread: 2 });
          }
        }
      }
      // coal clusters ahead of the front-most karts as she passes them
      for (const k of d.leaders) {
        if (d.dropped.has(k) || k.finished || !k.proj) continue;
        if (ctx.deltaS(k.proj.s, e.s) < -1) continue;                        // not passed yet
        d.dropped.add(k);
        const s = ctx.wrapS(k.proj.s + ITEM5.coalAhead);
        if (d.clusters.some((cs) => Math.abs(ctx.deltaS(cs, s)) < CLUSTER_SPACING)) continue;   // one there already
        d.clusters.push(s);
        dropCluster(ctx, s, e.owner, e.position);
        ctx.sfx('coalDrop', ctx.pointAt(s, 0, _tmp), 1);
      }
      // done 40 m past the leader (or out of time)
      const lead = ctx.leader();
      const past = lead && lead !== e.owner ? e.dist - (lead.distance || 0) : e.dist - (e.owner ? e.owner.distance || 0 : 0);
      if (past >= ITEM5.befanaPast || e.age >= ITEM5.befanaLife - 1e-6) { endFlight(ctx, e); continue; }
      if (ctx.effects && Math.random() < dt * 30) {
        _p.set(e.position.x - e.dir.x * 1.6, e.position.y - 0.2, e.position.z - e.dir.z * 1.6);
        ctx.effects.emit(Math.random() < 0.5 ? 'sparkle' : 'smoke', _p, { count: 2, color: Math.random() < 0.5 ? 0xd9b8ff : 0x3a3440, spread: 1.2, size: 0.5, alpha: 0.5 });
      }
    }
  },

  onEntityRemove(ctx, e, reason) {
    if (e.kind === 'befana') {
      if (reason === 'clear') return;
      ctx.startCooldown();
      ctx.sfx('befanaPoof', e.position, 1);
      ctx.emit('item:befanaEnd', { kart: e.owner, sooted: e.data.sooted.size });
      if (ctx.effects) {
        ctx.effects.emit('sparkle', e.position, { count: 26, color: 0xe6d0ff, spread: 5, radius: 1.2 });
        ctx.effects.emit('smoke', e.position, { count: 8, color: 0x8a7aa0, size: 1.2, alpha: 0.5 });
      }
      return;
    }
    if (!ctx.effects || reason === 'clear' || reason === 'expire') return;
    _p.set(e.position.x, e.position.y + 0.3, e.position.z);
    ctx.effects.emit('smoke', _p, { count: 5, color: 0x26262a, size: 0.6, alpha: 0.7 });
    ctx.effects.emit('spark', _p, { count: 8, color: 0xff7a30, spread: 4 });
  },

  countLive(ctx) {
    let n = 0;
    for (const e of ctx.sys.entities) if (e.plugin === ctx && e.active && e.kind === 'befana') n++;
    return n;
  },

  aiUse(kart, c) {
    const ahead = c.plugin ? c.plugin.kartsAhead(kart).length : c.place - 1;
    return ahead >= 2 || (ahead >= 1 && c.hold > 3) || c.hold > 8;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE;
    const P = [];
    // the broom (along local z: bristles at the back)
    P.push(ctx.part(new T.CylinderGeometry(0.06, 0.06, 3.0, 8), 0x8a5a2a, { rot: new T.Euler(Math.PI / 2, 0, 0), pos: [0, 0, 0.2] }));
    P.push(ctx.part(new T.CylinderGeometry(0.1, 0.36, 1.0, 12, 1, false), 0xd8b45a, { rot: new T.Euler(-Math.PI / 2, 0, 0), pos: [0, 0, -1.55] }));
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      P.push(ctx.part(new T.CylinderGeometry(0.02, 0.03, 1.05, 4), i % 2 ? 0xc49a40 : 0xe6c870, {
        rot: new T.Euler(-Math.PI / 2 + Math.sin(a) * 0.28, 0, Math.cos(a) * 0.28), pos: [Math.cos(a) * 0.2, Math.sin(a) * 0.2, -1.6],
      }));
    }
    P.push(ctx.part(new T.CylinderGeometry(0.13, 0.13, 0.12, 10), 0x8a3a1a, { rot: new T.Euler(Math.PI / 2, 0, 0), pos: [0, 0, -1.08] }));
    // her: a patched dark shawl / skirt draped over the broom, sitting side-saddle
    P.push(ctx.part(new T.ConeGeometry(0.62, 1.1, 14), 0x3b2f5a, { pos: [0, 0.38, 0.1] }));
    P.push(ctx.part(new T.SphereGeometry(0.38, 14, 10), 0x5a3a2a, { scale: [1.05, 0.9, 0.95], pos: [0, 0.98, 0.12] }));          // shawl over the shoulders
    for (const [x, y, z, c] of [[0.3, 0.6, 0.38, 0xb03a3a], [-0.32, 0.45, 0.2, 0x3a7a5a], [0.12, 0.3, -0.45, 0xc0a040], [-0.2, 0.9, 0.42, 0x6a5ab0]]) {
      P.push(ctx.part(new T.BoxGeometry(0.2, 0.2, 0.03), c, { rot: new T.Euler(0.2, Math.atan2(x, z), 0.3), pos: [x, y, z] }));     // patches
    }
    // face: a kind old face with a long nose, rosy cheeks and a smile
    P.push(ctx.part(new T.SphereGeometry(0.27, 16, 12), 0xf0c8a0, { scale: [1, 1.05, 0.95], pos: [0, 1.33, 0.26] }));
    P.push(ctx.part(new T.ConeGeometry(0.075, 0.32, 8), 0xe8b08a, { rot: new T.Euler(Math.PI / 2 + 0.35, 0, 0), pos: [0, 1.3, 0.58] }));
    P.push(ctx.part(new T.SphereGeometry(0.045, 6, 5), 0xe0a07a, { pos: [0, 1.2, 0.7] }));                   // nose tip
    for (const s of [-1, 1]) {
      P.push(ctx.part(new T.SphereGeometry(0.04, 6, 4), 0x2a1a10, { pos: [s * 0.1, 1.41, 0.5] }));
      P.push(ctx.part(new T.SphereGeometry(0.065, 8, 6), 0xff7a7a, { scale: [1, 0.6, 0.4], pos: [s * 0.17, 1.27, 0.47] }));
      P.push(ctx.part(new T.BoxGeometry(0.1, 0.02, 0.02), 0xbfbfbf, { rot: new T.Euler(0, 0, s * 0.25), pos: [s * 0.1, 1.48, 0.49] }));   // brows
    }
    P.push(ctx.part(new T.TorusGeometry(0.07, 0.018, 5, 10, Math.PI), 0x8a2a20, { rot: new T.Euler(0, 0, Math.PI), pos: [0, 1.2, 0.5] }));   // smile
    // headscarf: a hood open at the front, knotted under the chin; wisps of grey hair at the temples
    P.push(ctx.part(new T.SphereGeometry(0.33, 16, 12, Math.PI * 0.85, Math.PI * 1.3, 0, Math.PI * 0.72), 0xc8402e, { pos: [0, 1.36, 0.22] }));
    P.push(ctx.part(new T.ConeGeometry(0.1, 0.24, 6), 0xc8402e, { rot: new T.Euler(Math.PI - 0.4, 0, 0), pos: [0.12, 1.02, 0.4] }));
    P.push(ctx.part(new T.ConeGeometry(0.08, 0.2, 6), 0xc8402e, { rot: new T.Euler(Math.PI - 0.6, 0, -0.5), pos: [0.2, 1.02, 0.36] }));
    for (const s of [-1, 1]) P.push(ctx.part(new T.SphereGeometry(0.09, 8, 6), 0xd8d8d8, { scale: [0.7, 1.2, 0.8], pos: [s * 0.25, 1.3, 0.36] }));
    for (let i = 0; i < 9; i++) {
      const a = Math.PI * 0.9 + i * 0.15 * Math.PI;
      P.push(ctx.part(new T.SphereGeometry(0.035, 5, 4), 0xffe36a, { pos: [-Math.cos(a) * 0.33, 1.47 + 0.07 * Math.cos(i * 2), 0.22 + Math.sin(a) * 0.33] }));   // scarf dots
    }
    // arms holding the broom, boots
    for (const s of [-1, 1]) {
      P.push(ctx.part(new T.CylinderGeometry(0.07, 0.08, 0.6, 6), 0x3b2f5a, { rot: new T.Euler(1.1, 0, s * 0.3), pos: [s * 0.22, 0.75, 0.42] }));
      P.push(ctx.part(new T.SphereGeometry(0.08, 8, 6), 0xf0c8a0, { pos: [s * 0.1, 0.52, 0.66] }));
      P.push(ctx.part(new T.BoxGeometry(0.14, 0.12, 0.3), 0x2a1a14, { pos: [0.42, -0.08 + s * 0.06, 0.15 + s * 0.12] }));
    }
    // the sack of coal on her back, with a few lumps peeking out
    P.push(ctx.part(new T.SphereGeometry(0.3, 12, 10), 0x9a7a4c, { scale: [0.9, 1.05, 0.8], pos: [0.12, 0.78, -0.5] }));
    P.push(ctx.part(new T.CylinderGeometry(0.1, 0.15, 0.14, 8), 0x7a5a38, { pos: [0.12, 1.1, -0.5] }));
    P.push(ctx.part(new T.TorusGeometry(0.11, 0.025, 5, 10), 0x5a3a20, { rot: new T.Euler(Math.PI / 2, 0, 0), pos: [0.12, 1.05, -0.5] }));
    for (let i = 0; i < 3; i++) P.push(ctx.part(new T.DodecahedronGeometry(0.08, 0), 0x1c1c22, { pos: [0.12 + (i - 1) * 0.08, 1.2, -0.5 + (i % 2) * 0.05] }));
    const geo = ctx.mergeParts(P);
    const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 });
    ctx.state.witch = ctx.instanced(geo, mat, 2, 'befana', { shadow: true });
    // coal lumps
    const coalGeo = ctx.own(lumpGeometry(T, ITEM5.coalRadius, 1.7));
    const cmat = new T.MeshStandardMaterial({ color: 0x1d1d22, roughness: 0.55, metalness: 0.35, emissive: 0x2a0800, emissiveIntensity: 0.5, flatShading: true });
    ctx.state.coal = ctx.instanced(coalGeo, cmat, CAP_COAL, 'befana-coal', { shadow: true, receive: true });
  },

  updateVisuals(ctx) {
    const wm = ctx.state.witch, cm = ctx.state.coal;
    if (!wm) return;
    const t = ctx.time;
    let nw = 0, nc = 0;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active) continue;
      if (e.kind === 'befana') {
        if (nw >= 2) continue;
        const yaw = Math.atan2(e.dir.x, e.dir.z);
        const pop = Math.min(1, e.age / 0.25);
        _e.set(-0.12 + Math.sin(t * 5 + e.data.seed) * 0.06, yaw, Math.sin(t * 3.3 + e.data.seed) * 0.12, 'YXZ');
        _q.setFromEuler(_e);
        _p.set(e.position.x, e.position.y + Math.sin(t * 4 + e.data.seed) * 0.25 - 6 * (1 - pop) * (1 - pop), e.position.z);
        _s.setScalar(1.6 * Math.max(0.05, pop));
        wm.setMatrixAt(nw++, _m.compose(_p, _q, _s));
      } else if (nc < CAP_COAL) {
        const d = e.data;
        const u = Math.min(1, Math.max(0, (e.age - d.delay) / 0.45));
        const left = e.life - e.age;
        _p.set(e.position.x, e.position.y + ITEM5.coalRadius * 0.7 + d.from * (1 - u) * (1 - u), e.position.z);
        _e.set(d.seed, d.seed * 2.3 + (1 - u) * 6, d.seed * 0.7);
        _q.setFromEuler(_e);
        _s.setScalar(Math.max(0.01, (e.age < d.delay ? 0.01 : 1) * (left < 0.5 ? left / 0.5 : 1)));
        cm.setMatrixAt(nc++, _m.compose(_p, _q, _s));
      }
    }
    wm.count = nw; cm.count = nc;
    wm.visible = nw > 0; cm.visible = nc > 0;
    wm.instanceMatrix.needsUpdate = true;
    cm.instanceMatrix.needsUpdate = true;
  },

  callout: 'SOOTED!',
});

function stepCoal(ctx, e) {
  if (e.age < e.data.delay + 0.35) return;                  // still falling from her sack
  for (const k of ctx.kartsTouching(e.position, e.radius, { dy: 1.4, yOff: 0 })) {
    if (ctx.immune(k)) { ctx.remove(e, 'smash'); return; }
    if (ctx.hit(k, 'spin', { by: e.owner, cause: 'coal' })) {
      ctx.sfx('coalHit', k);
      ctx.flash(k, 'COAL!', '#7b4fc9', { size: 'medium', duration: 0.9, vibrate: [60, 30, 60] });
      ctx.remove(e, 'hit');
      return;
    }
  }
}
