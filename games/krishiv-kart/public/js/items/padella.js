// Padella Slam (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A11, §C7, §C9).
//
// A giant frying pan appears over EVERY unfinished kart ahead of the user. Three
// warning beats ring out at ITEM5.padellaBeats (0 / 0.6 / 1.2 s): a "BONG", a
// HUD banner and a phone buzz on each victim, `kart.panWarn` = 1..3; then the
// SLAM at ITEM5.padellaSlam (1.8 s): every victim that is GROUNDED and not
// immune (star / Beer Rocket / ghost / giant) spins out, drops its held item and
// loses 2 lire. A dropped banana, prank box, lemon, banana split or bomb lands on
// the road as a hazard; any other held item is lost (triples come off the kart
// as on any hit). Being airborne at the slam — a hop pressed 0-0.3 s before (our
// hop is ~0.36 s of air), a ramp or a big jump — dodges it. Hard CPUs hop-dodge
// with probability aiSkill x 0.6, Normal x 0.3, Easy never (the item has no AI
// driver at hand: the class's difficulty and skill stand in, ctx.difficulty()).
// At most 1 in play; ITEM_RULES gives the 20 s cooldown from the slam
// (ctx.startCooldown) and the place gate (3rd or worse).
//
// CPU use: at once (the place gate guarantees >= 2 karts ahead).

import * as THREE from 'three';
import { registerItem } from './registry.js';
import { ITEM5, DIFFICULTY } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';

const CAP = 8, PAN_R = 1.6, HOVER = 5.4, AHEAD = 1.6, DROPPABLE = new Set(['banana', 'prank_box', 'sour_lemon', 'banana_split', 'meatball_bomb']);
const DODGE = { hard: 0.6, normal: 0.3, easy: 0 }, HOP_LEAD = 0.12;

registerSound('padellaBong', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a big cast-iron pan struck like a gong
  SYNTH.bell(ac, out, t, 196 * p, 0.2, 1.1);
  SYNTH.bell(ac, out, t, 293 * p, 0.08, 0.8);
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 110 * p, f1: 92 * p, glide: 0.4, dur: 0.6, peak: 0.16 });
  return 1.0;
}, 1.4);
registerSound('padellaSlam', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // CLANG: metal crash + a deep thud
  SYNTH.crashCymbal(ac, out, t, 0.9);
  SYNTH.kickDrum(ac, out, t, 1.3);
  SYNTH.bell(ac, out, t, 150 * p, 0.22, 1.2);
  SYNTH.hiss(ac, out, t, { type: 'bandpass', f0: 3200, dur: 0.3, peak: 0.25, Q: 1.2 });
  return 1.2;
}, 1.3);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();

function dropHeld(ctx, k) {
  const id = k.item;
  if (!id || k.rolling) return null;
  if (DROPPABLE.has(id)) {
    k.item = null; k.itemCount = 0;
    if (id === 'banana') ctx.dropBanana(k, k.position);
    else if (id === 'meatball_bomb') { const b = k.input.brake; k.input.brake = 1; ctx.activate(k, id); k.input.brake = b; }
    else ctx.activate(k, id);
    return id;
  }
  k.item = null; k.itemCount = 0;
  return id;
}

registerItem('padella', {
  init(ctx) { ctx.state.runs = []; ctx.state.mesh = null; },

  use(ctx, kart) {
    const victims = ctx.kartsAhead(kart);
    const diff = ctx.difficulty(), skill = (DIFFICULTY[diff] || DIFFICULTY.normal).aiSkill;
    const run = {
      user: kart, t: 0, beat: 0, slammed: false, done: false,
      victims: victims.map((k) => ({ kart: k, dodge: !k.isPlayer && ctx.rng() < skill * (DODGE[diff] || 0), hit: false, hopped: false, seed: ctx.rng() * 6.28 })),
    };
    ctx.state.runs.push(run);
    for (const v of run.victims) v.kart.panWarn = 0;
    ctx.emit('item:padellaWarn', { kart, victims: victims.slice() });
    beat(ctx, run);
    return true;
  },

  update(ctx, dt) {
    const runs = ctx.state.runs;
    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i];
      r.t += dt;
      const beats = ITEM5.padellaBeats;
      while (r.beat < beats.length && r.t >= beats[r.beat]) beat(ctx, r);
      // Hard / Normal CPU victims time a hop into the slam
      if (!r.slammed && r.t >= ITEM5.padellaSlam - HOP_LEAD) {
        for (const v of r.victims) if (v.dodge && !v.hopped) { v.hopped = true; v.kart.input.drift = true; }
      }
      if (!r.slammed && r.t >= ITEM5.padellaSlam) slam(ctx, r);
      if (r.slammed && r.t >= ITEM5.padellaSlam + 0.45) {
        for (const v of r.victims) if (v.kart.panWarn === 4) v.kart.panWarn = 0;
        runs.splice(i, 1);
      }
    }
  },

  countLive(ctx) { return ctx.state.runs.length; },

  clear(ctx) {
    for (const r of ctx.state.runs) for (const v of r.victims) v.kart.panWarn = 0;
    ctx.state.runs.length = 0;
  },

  aiUse(kart, c) {
    return (c.plugin ? c.plugin.kartsAhead(kart).length : c.place - 1) >= 2 || c.hold > 4;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE;
    const parts = [];
    // a cast-iron pan, bottom facing down: dish + rim + a long handle with a wooden grip
    parts.push(ctx.part(new T.CylinderGeometry(PAN_R, PAN_R * 0.86, 0.32, 36), 0x3a3d44));
    parts.push(ctx.part(new T.TorusGeometry(PAN_R * 0.99, 0.09, 8, 40), 0x5a5f69, { rot: new T.Euler(Math.PI / 2, 0, 0), pos: [0, 0.16, 0] }));
    parts.push(ctx.part(new T.CylinderGeometry(PAN_R * 0.9, PAN_R * 0.9, 0.02, 36), 0x24262b, { pos: [0, 0.155, 0] }));
    parts.push(ctx.part(new T.CylinderGeometry(PAN_R * 0.86, PAN_R * 0.86, 0.02, 30), 0xc87a3a, { pos: [0, -0.165, 0] }));     // copper-clad base
    parts.push(ctx.part(new T.TorusGeometry(PAN_R * 0.55, 0.05, 6, 30), 0xe8a060, { rot: new T.Euler(Math.PI / 2, 0, 0), pos: [0, -0.18, 0] }));
    parts.push(ctx.part(new T.TorusGeometry(PAN_R * 0.25, 0.05, 6, 20), 0xe8a060, { rot: new T.Euler(Math.PI / 2, 0, 0), pos: [0, -0.18, 0] }));
    parts.push(ctx.part(new T.BoxGeometry(0.26, 0.12, 1.5), 0x45484f, { pos: [0, 0.1, PAN_R + 0.7] }));
    parts.push(ctx.part(new T.BoxGeometry(0.32, 0.2, 1.0), 0x8a5a2a, { pos: [0, 0.12, PAN_R + 1.7] }));
    parts.push(ctx.part(new T.TorusGeometry(0.11, 0.04, 6, 10), 0x45484f, { pos: [0, 0.12, PAN_R + 2.3] }));
    const geo = ctx.mergeParts(parts);
    const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.2, emissive: 0x1a1a1e });
    ctx.state.mat = mat;
    ctx.state.mesh = ctx.instanced(geo, mat, CAP, 'padella-pans', { shadow: true });
  },

  updateVisuals(ctx) {
    const m = ctx.state.mesh;
    if (!m) return;
    const t = ctx.time;
    let i = 0, flash = 0;
    for (const r of ctx.state.runs) {
      const lastBeat = ITEM5.padellaBeats[Math.max(0, r.beat - 1)] || 0;
      flash = Math.max(flash, r.slammed ? 0 : Math.max(0, 1 - (r.t - lastBeat) / 0.25));
      for (const v of r.victims) {
        if (i >= CAP) break;
        const k = v.kart;
        const appear = Math.min(1, r.t / 0.3);
        let h = HOVER, sc = appear, tilt = Math.sin(t * 3 + v.seed) * 0.15;
        if (!r.slammed) {
          const wind = Math.max(0, (r.t - (ITEM5.padellaSlam - 0.35)) / 0.35);   // rears up before the slam
          h = HOVER + 1.2 * Math.sin(Math.min(1, wind) * Math.PI * 0.5) - (r.t >= ITEM5.padellaSlam - 0.06 ? 3 : 0);
          tilt += wind * 0.3;
        } else {
          const after = r.t - ITEM5.padellaSlam;
          h = 0.9 + after * 4;
          sc = Math.max(0.01, 1 - after / 0.45);
          tilt = 0;
        }
        // hung a little ahead of the kart (so a chase camera sees it coming), dropping onto it for the slam
        const ahead = r.slammed ? 0 : AHEAD * Math.min(1, Math.max(0, (ITEM5.padellaSlam - 0.12 - r.t) / 0.3));
        _p.set(k.position.x + Math.sin(k.yaw) * ahead, k.position.y + h, k.position.z + Math.cos(k.yaw) * ahead);
        _e.set(tilt, k.yaw + v.seed, 0, 'YXZ');
        _q.setFromEuler(_e);
        _s.setScalar(Math.max(0.01, sc));
        m.setMatrixAt(i++, _m.compose(_p, _q, _s));
      }
    }
    m.count = i;
    m.visible = i > 0;
    m.instanceMatrix.needsUpdate = true;
    if (ctx.state.mat) ctx.state.mat.emissive.setRGB(0.1 + 0.6 * flash, 0.1 + 0.3 * flash, 0.12 + 0.1 * flash);
  },

  callout: 'PANNED!',
});

function beat(ctx, r) {
  r.beat++;
  for (const v of r.victims) {
    const k = v.kart;
    if (k.finished) continue;
    k.panWarn = r.beat;
    ctx.sfx('padellaBong', k, 1, 1 + 0.06 * (r.beat - 1));
    ctx.flash(k, r.beat < 3 ? 'BONG!' : 'BONG! HOP!', '#9aa3ad', { size: r.beat < 3 ? 'small' : 'medium', duration: 0.5, vibrate: [60] });
  }
  ctx.emit('item:padellaBeat', { kart: r.user, beat: r.beat, victims: r.victims.map((v) => v.kart) });
}

function slam(ctx, r) {
  r.slammed = true;
  const hits = [];
  for (const v of r.victims) {
    const k = v.kart;
    k.panWarn = 4;
    if (k.finished || k.frozen) continue;
    if (!k.grounded || k.airImmune) { ctx.flash(k, 'DODGED!', '#7dff6a', { size: 'medium', duration: 0.9 }); continue; }
    if (ctx.immune(k)) continue;
    if (ctx.hit(k, 'spin', { by: r.user })) {
      v.hit = true;
      hits.push(k);
      const dropped = dropHeld(ctx, k);
      ctx.flash(k, 'PANNED!', '#9aa3ad', { size: 'big', duration: 1.1, sub: dropped ? 'item dropped' : '', vibrate: [160, 50, 160] });
      if (ctx.effects) {
        _p.set(k.position.x, k.position.y + 0.8, k.position.z);
        ctx.effects.emit('spark', _p, { count: 18, color: 0xfff0c0, spread: 7 });
        ctx.effects.emit('dust', k.position, { count: 10, spread: 4, size: 0.9 });
      }
    }
    ctx.sfx('padellaSlam', k);
  }
  ctx.startCooldown();
  ctx.emit('item:padellaSlam', { kart: r.user, victims: hits });
}
