// Lire — the coin system (v5 group B, SPEC §16.1 / §16.2, research-v5-items.md §C5).
//
// An item *system* (registerItemSystem), not a roulette item: it runs in every
// ItemSystem, Items Off included (main.js builds an item-less ItemSystem for it).
//
//   * Track lire: track.coins (from the defs' `coins: [{ u|f|s, count, lateral, spacing }]`)
//     hover COIN.hover m above the road, are picked up within COIN.pickupRadius m
//     (x the kart's size) and |dy| <= COIN.pickupDy, and come back COIN.respawn s later.
//   * kart.coins 0..COIN.max (start 0). kart.js multiplies the max speed by
//     1 + COIN.speedPerCoin x coins (+5 % at 10); every lira picked up also nudges
//     the kart +COIN.pickupNudge m/s forward (never above its max speed).
//   * Loss (nothing while immune — star / ghost / giant):
//       COIN.lossHit (2) on a normal hit: kart:spin / tumble / freeze / squash / shrink
//       COIN.lossLightHit (1) for light projectiles (cause peperoncino / granita /
//         flying_pizza, or an item:hit with light: true)
//       COIN.lossFall (3) on a respawn (kart:respawn) — those vanish
//     Hit-lost lire pop out as loose lire within COIN.dropRadius m: they live
//     COIN.looseLife s, never respawn, the loser can't regrab them for
//     COIN.regrabDelay s; at most COIN.maxLoose (the oldest is recycled).
//   * A squash (kart:squash) also drops the victim's held item (§C2).
//   * Events: coin:get { kart, count, total, source } · coin:lose { kart, count, total, cause }.
//   * CPUs (ai.js plugin lures): Normal / Hard CPUs below the cap lean toward a lira
//     within ±2.5 m of their line (aiLure below); Easy CPUs ignore lire.
//
// Helpers for the other plugins (sys = ctx.sys, the ItemSystem):
//   giveCoins(sys, kart, n, source, { nudge }) → gained
//   takeCoins(sys, kart, n, cause, { scatter }) → lost
//   spillCoins(sys, at, n, { owner, dirX, dirZ, speed, spread, up, behind }) → spawned
//   grabCoinsNear(sys, kart, pos, radius) → collected (track + loose lire)
//   coinsNear(sys, pos, radius) → nearest lira { position } or null

import { registerItemSystem } from './registry.js';
import { COIN, KART } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';
import { clamp } from '../utils.js';

const LIGHT = new Set(['peperoncino', 'granita', 'flying_pizza']);
const LOSS_EVENTS = ['kart:spin', 'kart:tumble', 'kart:freeze', 'kart:squash', 'kart:shrink'];
const GRAVITY = 22;
const SPIN_RATE = 3.2;                  // rad/s: track lire turning in place
const LURE = { lateral: 2.5, look: [6, 34], urgency: 0.32 };

// ---------------------------------------------------------------- sounds
registerSound('coinGet', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'square', f0: 1318 * p, dur: 0.05, peak: 0.07, lp: 6000 });
  SYNTH.blip(ac, out, t + 0.05, { type: 'square', f0: 1976 * p, dur: 0.16, peak: 0.07, lp: 7000 });
  SYNTH.bell(ac, out, t + 0.05, 3952 * p, 0.025, 0.25);
  return 0.24;
}, 0.9);
registerSound('coinLose', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.bell(ac, out, t, 2350 * p, 0.05, 0.22);
  SYNTH.bell(ac, out, t + 0.085, 1980 * p, 0.045, 0.22);
  SYNTH.bell(ac, out, t + 0.16, 1660 * p, 0.035, 0.28);
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 6000, dur: 0.06, peak: 0.03 });
  return 0.45;
}, 0.9);
registerSound('coinSpill', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  for (let i = 0; i < 5; i++) SYNTH.bell(ac, out, t + i * 0.035 + Math.random() * 0.015, (2100 + Math.random() * 900) * p, 0.025, 0.16);
  return 0.35;
}, 0.9);
registerSound('coinFull', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  [1318, 1660, 1976, 2637].forEach((f, i) => SYNTH.blip(ac, out, t + i * 0.055, { type: 'square', f0: f * p, dur: 0.09, peak: 0.055, lp: 7000 }));
  return 0.32;
}, 0.9);

// ---------------------------------------------------------------- helpers

function coinCtx(sys) {
  const c = sys && typeof sys.pluginContext === 'function' ? sys.pluginContext('coins') : null;
  return c && c.state && c.state.ready ? c : null;
}

/** The coin system's state of an ItemSystem (null if none). */
export function coinState(sys) { const c = coinCtx(sys); return c ? c.state : null; }

/** Add lire to a kart (capped), with the pickup nudge per lira. Returns the number gained. */
export function giveCoins(sys, kart, n, source = 'item', { nudge = true } = {}) {
  const c = coinCtx(sys);
  return c ? addCoins(c, kart, n, source, nudge) : 0;
}

/** Take lire from a kart. scatter: pop them out as loose lire around it. Returns the number lost. */
export function takeCoins(sys, kart, n, cause = 'hit', { scatter = true } = {}) {
  const c = coinCtx(sys);
  return c ? loseCoins(c, kart, n, cause, scatter) : 0;
}

/**
 * Spill `n` loose lire at a position. opts: owner (can't regrab for
 * COIN.regrabDelay), dirX / dirZ + spread (rad) aim the spill (default all
 * round), speed (m/s outward, default to land within COIN.dropRadius), up (m/s).
 */
export function spillCoins(sys, at, n, opts = {}) {
  const c = coinCtx(sys);
  if (!c) return 0;
  let made = 0;
  for (let i = 0; i < n; i++) if (spawnLoose(c, at, i, n, opts)) made++;
  if (made && c.vis) c.sfx('coinSpill', at, 0.8);
  return made;
}

/** Collect every lira (track + loose) within `radius` m of `pos` for `kart` (chomps, swipes). */
export function grabCoinsNear(sys, kart, pos, radius) {
  const c = coinCtx(sys);
  if (!c) return 0;
  const st = c.state, r2 = radius * radius;
  let n = 0;
  for (const cn of st.coins) {
    if (!cn.active) continue;
    const dx = cn.x - pos.x, dz = cn.z - pos.z;
    if (dx * dx + dz * dz > r2 || Math.abs(cn.y - pos.y) > 3) continue;
    takeTrackCoin(c, cn);
    n++;
  }
  for (const l of st.loose) {
    if (!l.active || (l.owner === kart && l.age < COIN.regrabDelay)) continue;
    const dx = l.x - pos.x, dz = l.z - pos.z;
    if (dx * dx + dz * dz > r2 || Math.abs(l.y - pos.y) > 3) continue;
    killLoose(st, l);
    n++;
  }
  if (n > 0) addCoins(c, kart, n, 'grab', true);
  return n;
}

/** Nearest active lira (track or loose) within `radius` m of pos: { x, y, z } or null. */
export function coinsNear(sys, pos, radius) {
  const c = coinCtx(sys);
  if (!c) return null;
  let best = null, bd = radius * radius;
  for (const list of [c.state.coins, c.state.loose]) {
    for (const cn of list) {
      if (!cn.active) continue;
      const dx = cn.x - pos.x, dz = cn.z - pos.z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = cn; }
    }
  }
  return best;
}

function addCoins(c, kart, n, source, nudge) {
  if (!kart || !(n > 0)) return 0;
  const before = kart.coins | 0;
  const after = Math.min(COIN.max, before + n);
  kart.coins = after;
  const got = after - before;
  if (nudge) nudgeKart(kart, n);
  if (got > 0) {
    c.emit('coin:get', { kart, count: got, total: after, source });
    c.sfx(after >= COIN.max && before < COIN.max ? 'coinFull' : 'coinGet', kart, 0.85, 1 + 0.03 * after);
  } else c.sfx('coinGet', kart, 0.35, 0.8);
  return got;
}

// +COIN.pickupNudge m/s per lira along the nose, never past the kart's max speed
function nudgeKart(k, n) {
  if (k.frozen || (typeof k.isDisabled === 'function' && k.isDisabled())) return;
  const v = k.velocity, fx = Math.sin(k.yaw), fz = Math.cos(k.yaw);
  const hs = Math.hypot(v.x, v.z), max = k.maxSpeed;
  const add = Math.min(COIN.pickupNudge * n, Math.max(0, max - hs));
  if (add > 0) { v.x += fx * add; v.z += fz * add; }
}

function loseCoins(c, kart, n, cause, scatter) {
  const have = kart.coins | 0;
  const m = Math.min(have, Math.max(0, n | 0));
  if (m <= 0) return 0;
  kart.coins = have - m;
  c.emit('coin:lose', { kart, count: m, total: kart.coins, cause });
  c.sfx('coinLose', kart, 0.9);
  if (scatter) {
    const at = kart.position;
    for (let i = 0; i < m; i++) spawnLoose(c, at, i, m, { owner: kart });
  }
  return m;
}

function takeTrackCoin(c, cn) {
  cn.active = false;
  cn.timer = COIN.respawn;
  c.state.taken++;
  if (c.effects) { c.state._v.set(cn.x, cn.y, cn.z); c.effects.emit('glitter', c.state._v, c.state._glit); }
}

function killLoose(st, l) {
  l.active = false;
  st.looseLive--;
}

function spawnLoose(c, at, i, n, o) {
  const st = c.state;
  let l = null;
  for (const x of st.loose) if (!x.active) { l = x; break; }
  if (!l) {
    if (st.loose.length < COIN.maxLoose) { l = { active: false, proj: {}, hint: -1 }; st.loose.push(l); }
    else {
      // recycle the oldest
      l = st.loose[0];
      for (const x of st.loose) if (x.age > l.age) l = x;
      killLoose(st, l);
    }
  }
  const air = (2 * (o.up ?? 5.5)) / GRAVITY;
  const spread = o.spread ?? Math.PI * 2;
  let base = 0;
  if (Number.isFinite(o.dirX) && Number.isFinite(o.dirZ) && (o.dirX || o.dirZ)) base = Math.atan2(o.dirX, o.dirZ);
  else base = c.rng() * Math.PI * 2;
  const ang = n > 1 ? base - spread / 2 + (spread * (i + 0.5)) / n + (c.rng() - 0.5) * 0.25 : base + (c.rng() - 0.5) * spread;
  const dist = (o.speed ?? null) != null ? o.speed * air : COIN.dropRadius * (0.45 + 0.55 * c.rng());
  const hsp = dist / air;
  l.active = true;
  l.x = at.x; l.y = at.y + 1.0; l.z = at.z;
  l.vx = Math.sin(ang) * hsp; l.vz = Math.cos(ang) * hsp; l.vy = o.up ?? 5.5;
  l.age = 0;
  l.life = o.life ?? COIN.looseLife;
  l.owner = o.owner || null;
  l.grounded = false;
  l.hint = -1;
  l.phase = c.rng() * 6.28;
  st.looseLive++;
  return true;
}

// ---------------------------------------------------------------- the system

registerItemSystem('coins', {
  init(ctx) {
    const st = ctx.state;
    const tr = ctx.track;
    st.coins = (tr.coins || []).map((cn) => ({
      index: cn.index, s: cn.s, lateral: cn.lateral, line: cn.line,
      x: cn.position.x, y: cn.position.y + COIN.hover, z: cn.position.z, active: true, timer: 0, phase: cn.index * 0.7,
    }));
    st.loose = [];
    st.looseLive = 0;
    st.taken = 0;
    st.pending = new Map();             // kart → { n, light } lire to lose next substep
    st.kartSet = new Set(ctx.karts);
    st._v = new ctx.THREE.Vector3();
    st._glit = { count: 5, color: 0xffd84a, size: 0.22, life: 0.45, radius: 0.35 };
    st.ready = true;
    for (const k of ctx.karts) k.coins = 0;
    const mark = (e) => {
      const k = e && e.kart;
      if (!k || !st.kartSet.has(k)) return;
      const p = st.pending.get(k) || { n: 0, light: false, cause: '' };
      p.n = Math.max(p.n, LIGHT.has(e.cause) ? COIN.lossLightHit : COIN.lossHit);
      if (LIGHT.has(e.cause)) p.light = true;
      p.cause = e.cause || p.cause;
      st.pending.set(k, p);
    };
    for (const type of LOSS_EVENTS) ctx.on(type, mark);
    ctx.on('item:hit', (e) => {
      const p = e && e.light && st.pending.get(e.kart);
      if (p) p.light = true;
    });
    // a squash drops the held item (§C2); the lire go with the pending loss
    ctx.on('kart:squash', (e) => {
      const k = e && e.kart;
      if (!k || !st.kartSet.has(k) || k.rolling) return;
      if (k.item) { k.item = null; k.itemCount = 0; }
      const ist = ctx.sys._st && ctx.sys._st.get(k);
      if (ist && ist.attached > 0 && typeof ctx.sys._releaseAttached === 'function') ctx.sys._releaseAttached(k);
    });
    ctx.on('kart:respawn', (e) => {
      const k = e && e.kart;
      if (!k || !st.kartSet.has(k)) return;
      loseCoins(ctx, k, COIN.lossFall, 'fall', false);
    });
  },

  update(ctx, dt) {
    const st = ctx.state, karts = ctx.karts, race = ctx.race;
    // losses from this / the last substep's hits
    if (st.pending.size) {
      for (const [k, p] of st.pending) {
        if (!ctx.immune(k)) loseCoins(ctx, k, p.light ? COIN.lossLightHit : p.n, p.cause || 'hit', true);
      }
      st.pending.clear();
    }
    const live = !race || race.state === 'racing' || race.state === 'finished';
    // track lire: respawn + pickup
    const coins = st.coins;
    for (let i = 0; i < coins.length; i++) {
      const cn = coins[i];
      if (!cn.active) {
        cn.timer -= dt;
        if (cn.timer <= 0) { cn.active = true; cn.timer = 0; }
        continue;
      }
      if (!live) continue;
      for (let j = 0; j < karts.length; j++) {
        const k = karts[j];
        if (k.frozen) continue;
        const r = COIN.pickupRadius * Math.max(1, k.sizeMult || 1);
        const dx = k.position.x - cn.x, dz = k.position.z - cn.z;
        if (dx * dx + dz * dz > r * r || Math.abs(k.position.y + 0.5 - cn.y) > COIN.pickupDy) continue;
        takeTrackCoin(ctx, cn);
        addCoins(ctx, k, 1, 'track', true);
        break;
      }
    }
    // loose lire: fly, land, expire, pickup
    if (st.looseLive > 0) {
      const tr = ctx.track;
      for (const l of st.loose) {
        if (!l.active) continue;
        l.age += dt;
        if (l.age >= l.life) { killLoose(st, l); continue; }
        if (!l.grounded) {
          l.vy -= GRAVITY * dt;
          l.x += l.vx * dt; l.y += l.vy * dt; l.z += l.vz * dt;
          const pos = st._v.set(l.x, l.y, l.z);
          const pr = tr.project(pos, l.hint, l.proj);
          l.hint = pr.index;
          const lim = 0.9;
          const lat = clamp(pr.lateral, -(pr.wallL - lim), pr.wallR - lim);
          if (lat !== pr.lateral) {
            l.x += pr.right.x * (lat - pr.lateral); l.z += pr.right.z * (lat - pr.lateral);
            const vn = l.vx * pr.right.x + l.vz * pr.right.z;
            l.vx -= pr.right.x * vn * 1.5; l.vz -= pr.right.z * vn * 1.5;
          }
          const floor = pr.height + COIN.hover;
          if (l.y <= floor && l.vy < 0) { l.y = floor; l.vy = 0; l.vx = 0; l.vz = 0; l.grounded = true; }
        }
        if (!live) continue;
        for (let j = 0; j < karts.length; j++) {
          const k = karts[j];
          if (k.frozen || (k === l.owner && l.age < COIN.regrabDelay)) continue;
          const r = COIN.pickupRadius * Math.max(1, k.sizeMult || 1);
          const dx = k.position.x - l.x, dz = k.position.z - l.z;
          if (dx * dx + dz * dz > r * r || Math.abs(k.position.y + 0.5 - l.y) > COIN.pickupDy) continue;
          killLoose(st, l);
          if (ctx.effects) { st._v.set(l.x, l.y, l.z); ctx.effects.emit('glitter', st._v, st._glit); }
          addCoins(ctx, k, 1, 'loose', true);
          break;
        }
      }
    }
  },

  clear(ctx) {
    const st = ctx.state;
    if (!st.ready) return;
    for (const cn of st.coins) { cn.active = true; cn.timer = 0; }
    for (const l of st.loose) l.active = false;
    st.looseLive = 0;
    st.pending.clear();
    for (const k of ctx.karts) k.coins = 0;
  },

  // ai.js plugin lures: a Normal / Hard CPU below the cap leans toward the
  // nearest lira ahead within ±LURE.lateral m of its planned line (never while
  // dodging; ai.js gives hazards priority). Returns { s, lateral, urgency } | null.
  aiLure(ctx, kart, c) {
    if (!c || c.difficulty === 'easy' || (kart.coins | 0) >= COIN.max) return null;
    const st = ctx.state, tr = ctx.track;
    if (!st.ready) return null;
    let best = null, bd = Infinity;
    for (const list of [st.coins, st.loose]) {
      for (const cn of list) {
        if (!cn.active) continue;
        const dx = cn.x - kart.position.x, dz = cn.z - kart.position.z;
        if (dx * dx + dz * dz > 40 * 40) continue;
        const s = cn.s !== undefined ? cn.s : (cn.grounded ? (cn.proj && cn.proj.s) : undefined);
        if (s === undefined) continue;
        const ds = tr.deltaS(c.s, s);
        if (ds < LURE.look[0] || ds > LURE.look[1]) continue;
        const lat = cn.lateral !== undefined ? cn.lateral : cn.proj.lateral;
        const dl = Math.abs(lat - c.plannedLat(s));
        if (dl > LURE.lateral || dl < 0.5) continue;
        const score = ds + dl * 6;
        if (score < bd) { bd = score; best = { s, lateral: lat }; }
      }
    }
    if (!best) return null;
    best.urgency = LURE.urgency * (0.5 + 0.5 * c.skill);
    return best;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = ctx.THREE, st = ctx.state;
    const geo = ctx.own(new T.CylinderGeometry(0.42, 0.42, 0.1, 22, 1));
    geo.rotateX(Math.PI / 2);            // faces along ±z, spins about y
    // two groups (rim, both faces) instead of three: one draw call fewer
    const [gs, gt, gb] = geo.groups;
    if (gs && gt && gb && gt.start + gt.count === gb.start) { geo.clearGroups(); geo.addGroup(gs.start, gs.count, 0); geo.addGroup(gt.start, gt.count + gb.count, 1); }
    const face = ctx.own(makeFaceTexture(T));
    const rim = ctx.own(new T.MeshStandardMaterial({ color: 0xffc22e, metalness: 0.55, roughness: 0.3, emissive: 0x9a6400, emissiveIntensity: 0.55 }));
    const faces = ctx.own(new T.MeshStandardMaterial({ map: face, color: 0xffffff, metalness: 0.35, roughness: 0.35, emissive: 0xffd040, emissiveMap: face, emissiveIntensity: 0.45 }));
    const cap = st.coins.length + COIN.maxLoose;
    const mesh = new T.InstancedMesh(geo, [rim, faces], Math.max(1, cap));
    mesh.name = 'lire';
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.castShadow = false;
    ctx.root.add(mesh);
    st.mesh = mesh;
    st._m = new T.Matrix4();
    st._q = new T.Quaternion();
    st._e = new T.Euler();
    st._p = new T.Vector3();
    st._s = new T.Vector3(1, 1, 1);
    st._t = 0;
  },

  updateVisuals(ctx, dt) {
    const st = ctx.state, m = st.mesh;
    if (!m) return;
    st._t += dt;
    let i = 0;
    const max = m.instanceMatrix.count;
    const put = (x, y, z, yaw, s) => {
      st._e.set(0, yaw, 0);
      st._q.setFromEuler(st._e);
      st._p.set(x, y, z);
      st._s.set(s, s, s);
      m.setMatrixAt(i++, st._m.compose(st._p, st._q, st._s));
    };
    for (const cn of st.coins) {
      if (i >= max) break;
      if (cn.active) put(cn.x, cn.y + Math.sin(st._t * 2.4 + cn.phase) * 0.08, cn.z, st._t * SPIN_RATE + cn.phase, 1);
      else if (cn.timer > COIN.respawn - 0.18) {
        // quick pop + vanish on pickup
        const u = (COIN.respawn - cn.timer) / 0.18;
        put(cn.x, cn.y + u * 0.9, cn.z, st._t * 18, 1 + u * 0.4 - u * u * 1.3);
      } else if (cn.timer < 0.3) {
        // respawn: grow back in
        const u = 1 - cn.timer / 0.3;
        put(cn.x, cn.y, cn.z, st._t * SPIN_RATE + cn.phase, Math.max(0.05, u));
      }
    }
    for (const l of st.loose) {
      if (!l.active || i >= max) continue;
      const left = l.life - l.age;
      if (left < 2 && Math.floor(l.age * 10) % 2 === 0) continue;          // blink before vanishing
      put(l.x, l.y + (l.grounded ? Math.sin(st._t * 3 + l.phase) * 0.06 : 0), l.z, st._t * (l.grounded ? SPIN_RATE : 12) + l.phase, 0.9);
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
  },
});

// Our own lira face: a gold disc with a raised rim, laurel dots and a big ₤.
function makeFaceTexture(T) {
  const S = 128;
  const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!cv) return new T.Texture();
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(S * 0.4, S * 0.35, 8, S / 2, S / 2, S / 2);
  grd.addColorStop(0, '#fff3a8');
  grd.addColorStop(0.55, '#f6c431');
  grd.addColorStop(1, '#b77a0a');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#8f5d06';
  g.lineWidth = 7;
  g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 8, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#a56e08';
  for (let a = 0; a < 18; a++) {
    const ang = (a / 18) * Math.PI * 2;
    g.beginPath(); g.arc(S / 2 + Math.cos(ang) * (S / 2 - 18), S / 2 + Math.sin(ang) * (S / 2 - 18), 3, 0, Math.PI * 2); g.fill();
  }
  g.font = `bold ${S * 0.56}px Georgia, 'Times New Roman', serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff6c4';
  g.fillText('₤', S / 2 - 2, S / 2 + 3);
  g.fillStyle = '#9a6507';
  g.fillText('₤', S / 2 + 2, S / 2 + 6);
  const tex = new T.CanvasTexture(cv);
  tex.colorSpace = T.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
