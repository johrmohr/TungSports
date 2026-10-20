// The helper context every item plugin hook receives (SPEC §16.2). One
// PluginContext per (ItemSystem, plugin): `ctx.state` is that system's private
// state for the plugin, everything else is a shared helper over the system.
// Node-safe: with a headless ItemSystem (scene: null) ctx.scene / ctx.root /
// ctx.vis are null and the visual hooks are never called.
//
// Full reference with examples: notes/v5-foundation.md §Items.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KART, HIT, ITEM, ITEM_RULES, ITEM_INFO } from '../config.js';
import { bus } from '../bus.js';
import { clamp, damp, angleDiff, approach } from '../utils.js';

// Kart effects ctx.hit() understands. The v5 kart-state effects (freeze /
// shrink / squash / soot) call kart methods of the same name once kart.js has
// them (group B); until then they fall back to a spin-out.
const V5_EFFECTS = { freeze: 'iceTime', shrink: 'shrinkTime', squash: 'squashTime', soot: 'sootTime' };

export class PluginContext {
  constructor(sys, id, handler) {
    this.sys = sys;
    this.id = id;
    this.handler = handler;
    this.state = {};                         // the plugin's per-ItemSystem state (init() fills it)
    this.info = ITEM_INFO[id] || null;       // null for item systems (coins)
    this.rule = ITEM_RULES[id] || {};
    this.THREE = THREE;
    this.root = null;                        // THREE.Group for this plugin's meshes (visuals only)
    this._own = [];
    this._offs = [];
    this._kst = new Map();
    this._near = [];
  }

  // ------------------------------------------------------------ the world
  get track() { return this.sys.track; }
  get karts() { return this.sys.karts; }
  get race() { return this.sys.race; }
  get scene() { return this.sys.scene; }
  get effects() { return this.sys.effects; }
  get vis() { return this.sys.vis; }
  get ccMult() { return this.sys.ccMult; }
  get enabled() { return this.sys.enabled; }
  /** The system clock (s, advances with every substep, also before GO). */
  get time() { return this.sys.time; }
  /** Race seconds since GO (the clock the item rules use). */
  clock() { return this.sys._clock(); }
  rng() { return this.sys.rng(); }

  // ------------------------------------------------------------ places
  /** Race place of a kart (1 = leading). */
  placeOf(kart) { return this.sys._placeOf(kart); }
  /** The leading kart still racing (or null). */
  leader() { return this.sys._leader(); }
  /** The kart one place ahead still racing (or null when leading) — the homing-rocket target. */
  kartAhead(kart) { return this.sys._rocketTarget(kart); }
  /** Karts in race order (race.standings when racing, else by distance). Fresh array. */
  standings() {
    const r = this.sys.race;
    if (r && Array.isArray(r.standings) && r.standings.length) return r.standings.slice();
    return this.sys.karts.slice().sort((a, b) => (b.distance || 0) - (a.distance || 0));
  }
  /** Karts ahead of `kart` in the race (not finished), nearest place first. Fresh array. */
  kartsAhead(kart) {
    const p = this.placeOf(kart);
    return this.sys.karts.filter((k) => k !== kart && !k.finished && this.placeOf(k) < p).sort((a, b) => this.placeOf(b) - this.placeOf(a));
  }

  // ------------------------------------------------------------ events
  /** bus.emit */
  emit(type, data) { bus.emit(type, data); }
  /** bus.on, unsubscribed automatically when the ItemSystem is disposed. */
  on(type, fn) { const off = bus.on(type, fn); this._offs.push(off); return off; }
  /** One-shot sound (audio.js SOUNDS / registerSound name) at a kart or position; main.js plays it distance-attenuated. */
  sfx(name, at, volume = 1, pitch = 1) {
    if (!name || !at) return;
    const kart = at && at.position && at.input ? at : null;
    bus.emit('item:sfx', { name, kart, position: kart ? kart.position : at, volume, pitch, item: this.id });
  }
  /** Banner on a human kart's own view (main.js; CPUs ignore it). opts: { size, duration, sub, vibrate: [ms...] } */
  flash(kart, text, color = '#ffd23a', opts = {}) { bus.emit('hud:flash', { kart, text, color, ...opts }); }

  // ------------------------------------------------------------ track
  project(pos, hint = -1, out = {}) { return this.sys.track.project(pos, hint, out); }
  pointAt(s, lateral = 0, out) { return this.sys.track.pointAt(s, lateral, out); }
  frameAt(s, out = {}) { return this.sys.track.frameAt(s, out); }
  wrapS(s) { return this.sys.track.wrapS(s); }
  deltaS(a, b) { return this.sys.track.deltaS(a, b); }
  /**
   * Re-project `obj` ({ position, proj, hint }, e.g. an entity) and pull it
   * inside the walls by `margin` m; sets obj.s / obj.lateral. Returns obj.proj.
   */
  keepOnRoad(obj, margin = 0.6, onSurface = false) {
    const tr = this.sys.track, pr = obj.proj || (obj.proj = {});
    tr.project(obj.position, obj.hint ?? -1, pr);
    obj.hint = pr.index;
    const lat = clamp(pr.lateral, -(pr.wallL - margin), pr.wallR - margin);
    if (lat !== pr.lateral) {
      obj.position.x += pr.right.x * (lat - pr.lateral);
      obj.position.z += pr.right.z * (lat - pr.lateral);
      pr.lateral = lat;
    }
    if (onSurface) obj.position.y = pr.height;
    obj.s = pr.s;
    obj.lateral = pr.lateral;
    return pr;
  }

  // ------------------------------------------------------------ kart state
  /** This plugin's per-kart state object (created on first use, dropped by clear()). */
  kstate(kart) {
    let s = this._kst.get(kart);
    if (!s) { s = {}; this._kst.set(kart, s); }
    return s;
  }
  /** Immune to item hits: star, Beer Rocket (star timer), ghost (kart.ghostTimer) or giant (kart.megaTimer). */
  immune(kart) {
    return (typeof kart.isInvincible === 'function' ? kart.isInvincible() : kart.starTimer > 0) || kart.ghostTimer > 0 || kart.megaTimer > 0;
  }
  /**
   * Hit a kart with an effect, respecting immunity (immune()) and the kart's
   * own grace (isHittable(): invulnerable / already spinning / tumbling).
   *   effect: 'spin' | 'tumble' | 'zap' | 'freeze' | 'shrink' | 'squash' | 'soot' | fn(kart) → bool
   *   opts:   { by (attacker kart), item (id for item:hit, default this plugin), cause (kart event cause,
   *             default the item id), duration (v5 effects), light (true: a light projectile, 1 lira lost),
   *             silent (no item:hit event), ...extra fields copied into item:hit }
   * Returns true when the hit landed (item:hit { kart, by, item, effect, light } emitted).
   */
  hit(kart, effect = 'spin', opts = {}) {
    if (!kart || this.immune(kart)) return false;
    const cause = opts.cause || this.id;
    let ok = false;
    if (typeof effect === 'function') ok = !!effect(kart);
    else if (effect === 'tumble') ok = kart.tumble(cause);
    else if (effect === 'zap') ok = kart.zap();
    else if (effect === 'spin') ok = kart.spinOut(cause);
    else if (V5_EFFECTS[effect]) {
      const fn = kart[effect];
      ok = typeof fn === 'function' ? !!fn.call(kart, opts.duration ?? HIT[V5_EFFECTS[effect]], cause) : kart.spinOut(cause);
    } else ok = kart.spinOut(cause);
    if (ok && !opts.silent) {
      const { by = null, item = this.id, light = false } = opts;
      bus.emit('item:hit', { ...opts, kart, by, item, effect: typeof effect === 'string' ? effect : 'custom', light });
    }
    return ok;
  }

  // ------------------------------------------------------------ contact
  /**
   * Karts touching a sphere-ish volume: horizontal distance <= radius + KART.radius
   * and |kart.y + yOff - pos.y| <= dy. Returns a REUSED array (valid until the next call).
   *   opts: { dy = 1.8, yOff = 0.5, skip = null (a kart to leave out), kartRadius = KART.radius }
   */
  kartsTouching(pos, radius, { dy = 1.8, yOff = 0.5, skip = null, kartRadius = KART.radius } = {}) {
    const out = this._near;
    out.length = 0;
    const r = radius + kartRadius, r2 = r * r;
    for (const k of this.sys.karts) {
      if (k === skip) continue;
      const dx = k.position.x - pos.x, dz = k.position.z - pos.z;
      if (dx * dx + dz * dz > r2 || Math.abs(k.position.y + yOff - pos.y) > dy) continue;
      out.push(k);
    }
    return out;
  }
  /** Does this kart touch the volume (same rule as kartsTouching)? */
  touches(kart, pos, radius, dy = 1.8, yOff = 0.5) {
    const r = radius + KART.radius, dx = kart.position.x - pos.x, dz = kart.position.z - pos.z;
    return dx * dx + dz * dz <= r * r && Math.abs(kart.position.y + yOff - pos.y) <= dy;
  }
  /**
   * An orbiting triple bouncer / rocket of another kart (not `owner`) within
   * `radius` of `pos` blocks it: the orbiter is detached ('blocked') and
   * returned (else null). Use it as the shield test for new projectiles.
   */
  blockByOrbiters(pos, radius, owner = null) {
    const sys = this.sys, ro = radius + ITEM.orbitHitRadius;
    for (let i = sys.attached.length - 1; i >= 0; i--) {
      const a = sys.attached[i];
      if (!a.active || a.type === 'banana' || a.owner === owner) continue;
      const dx = a.position.x - pos.x, dz = a.position.z - pos.z;
      if (dx * dx + dz * dz > ro * ro || Math.abs(a.position.y - pos.y) > 1.5) continue;
      sys._detach(a, 'blocked');
      return a;
    }
    return null;
  }
  /** Native projectiles (bouncers / rockets) within `radius` (3D) of pos. Fresh array. */
  projectilesNear(pos, radius) {
    const r2 = radius * radius;
    return this.sys.projectiles.filter((p) => p.active && p.position.distanceToSquared(pos) <= r2);
  }
  /** Native road hazards (banana peels, stink clouds) within `radius` (3D). Fresh array. */
  hazardsNear(pos, radius) {
    const r2 = radius * radius;
    return this.sys.hazards.filter((h) => h.active && h.position.distanceToSquared(pos) <= r2);
  }
  /** Remove a native projectile / hazard / bomb / capo / attached item (reason e.g. 'blocked', 'hit'). */
  destroyNative(obj, reason = 'blocked') {
    const sys = this.sys;
    if (!obj || !obj.active) return;
    if (sys.projectiles.includes(obj)) sys._removeProjectile(obj, reason);
    else if (sys.hazards.includes(obj)) sys._removeHazard(obj, reason);
    else if (sys.bombs.includes(obj)) sys._removeBomb(obj, reason);
    else if (sys.capos.includes(obj)) sys._removeCapo(obj, reason);
    else if (sys.attached.includes(obj)) sys._detach(obj, reason);
  }
  /** Destroy every item in play around `at` (natives + every plugin's entities / clearAround hooks). */
  clearAround(at, R, by = null, kind = 'blast') { this.sys._clearAround(at, R, by, false, kind); }

  // ------------------------------------------------------------ native items
  /** Drop a plain banana peel (at a position, else behind the kart). Returns the hazard. */
  dropBanana(kart, at = null) { return this.sys._dropHazard(kart, 'banana', at); }
  /** Fire a native 'bouncer' | 'rocket' from the kart's nose. Returns the projectile. */
  launchNative(kart, type) { return this.sys._launch(kart, type); }
  /**
   * Run an item's effect for a kart without touching its slot (antipasto
   * orbiters, egg capsules ...): native ids banana / stink / bouncer / rocket /
   * toot / star / zap / capo / meatball_bomb / espresso / accordion, or any
   * plugin id (its use()). Returns true if something happened.
   */
  activate(kart, id) { return this.sys.activateEffect(kart, id); }
  /** Put an item in an empty slot as if the roulette landed on it (triples deploy). False if busy. */
  giveItem(kart, id) { return this.sys.giveItem(kart, id); }
  /** The roulette pick for a kart at its place (all rules applied). */
  rollFor(kart) { return this.sys.rollFor(kart, this.placeOf(kart)); }
  /** Stamp this item's rule cooldown (ITEM_RULES[id].cooldown, or `seconds`) from now (race clock). */
  startCooldown(seconds = this.rule.cooldown || 0) {
    if (seconds > 0) this.sys._blockedUntil[this.id] = this.clock() + seconds;
  }

  // ------------------------------------------------------------ entities
  /**
   * Spawn a pooled entity owned by this plugin. The system ages it every
   * substep (e.age, e.prev) and removes it at e.life (reason 'expire'), lists
   * it as an AI threat when e.threat, lets accordion / bomb / capo blasts
   * destroy it unless e.sturdy, lets native projectiles collide with it when
   * e.solid, and counts it as "in play" for ITEM_RULES max. Moving it is the
   * plugin's job (stepStraight / stepBallistic / stepTrack below, or your own).
   *   props: { kind, owner, position, dir, vel, speed, radius, height, life, threat, clear, solid, sturdy, data, ... }
   * Returns the entity { uid, item, kind, owner, active, age, life, position, prev, vel, dir, speed, radius,
   *   height, s, lateral, proj, hint, dist, bounces, target, grounded, threat, clear, solid, sturdy, hitMask, data, vis }.
   */
  spawn(props = {}) {
    const e = this.sys._spawnEntity(this, props);
    // what the entity is for the shared contact helpers (shieldAt / smashAt / touchingItem):
    // 'hazard' (a road object: peel-like), 'projectile', 'shield' (orbiting a kart), 'pickup', 'fx' (untouchable), '' (none)
    e.role = props.role || '';
    return e;
  }
  /** Remove an entity (onEntityRemove(ctx, e, reason) is called). */
  remove(e, reason = 'expire') { this.sys._removeEntity(e, reason); }
  /** This plugin's live entities (the live array: iterate backwards if you remove). */
  entities() { return this.sys.entities.filter((e) => e.plugin === this); }

  /**
   * Move an entity straight along e.dir at e.speed riding the road (e.height
   * above it), like the native bouncer. At a wall it reflects (opts.bounce,
   * counting e.bounces) or stops at it. Returns null | 'bounce' | 'wall'.
   */
  stepStraight(e, dt, { bounce = true } = {}) {
    const tr = this.sys.track, pos = e.position, proj = e.proj;
    const step = e.speed * dt;
    pos.x += e.dir.x * step;
    pos.z += e.dir.z * step;
    tr.project(pos, e.hint, proj);
    e.hint = proj.index;
    e.dist += step * (e.dir.x * proj.tangent.x + e.dir.z * proj.tangent.z);
    let res = null;
    const r = e.radius || 0.5, lat = proj.lateral;
    const limR = proj.wallR - r, limL = -(proj.wallL - r);
    if (lat > limR || lat < limL) {
      const side = lat > limR ? 1 : -1;
      const pen = side > 0 ? lat - limR : limL - lat;
      pos.x -= proj.right.x * pen * side;
      pos.z -= proj.right.z * pen * side;
      proj.lateral -= pen * side;
      res = 'wall';
      if (bounce) {
        const N = tr.N, ix = proj.index, arr = side > 0 ? tr.wr : tr.wl;
        const dW = (arr[(ix + 1) % N] - arr[(ix - 1 + N) % N]) / (2 * tr.spacing);
        let nx = -side * proj.right.x + proj.tangent.x * dW, nz = -side * proj.right.z + proj.tangent.z * dW;
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl; nz /= nl;
        const dn = e.dir.x * nx + e.dir.z * nz;
        if (dn < 0) {
          e.dir.x -= 2 * dn * nx; e.dir.z -= 2 * dn * nz;
          const dl = Math.hypot(e.dir.x, e.dir.z) || 1;
          e.dir.x /= dl; e.dir.z /= dl;
          e.bounces++;
          res = 'bounce';
        }
      }
    }
    pos.y = proj.height + (e.height || 0);
    e.s = proj.s;
    e.lateral = proj.lateral;
    return res;
  }

  /**
   * Ballistic flight under gravity (e.vel), kept inside the walls; on touching
   * the road (bottom = e.radius) it lands: e.grounded = true, vel.y = 0, the
   * horizontal velocity is scaled by opts.landKeep. Grounded entities roll with
   * opts.rollDecel m/s². Returns 'land' on the landing substep, else null.
   */
  stepBallistic(e, dt, { gravity = KART.gravity, landKeep = 1, rollDecel = 0 } = {}) {
    const tr = this.sys.track, pos = e.position, v = e.vel, proj = e.proj;
    let res = null;
    if (!e.grounded) {
      v.y -= gravity * dt;
      pos.x += v.x * dt; pos.y += v.y * dt; pos.z += v.z * dt;
    } else {
      const hs = Math.hypot(v.x, v.z), ns = Math.max(0, hs - rollDecel * dt);
      if (hs > 1e-6) { v.x *= ns / hs; v.z *= ns / hs; }
      pos.x += v.x * dt; pos.z += v.z * dt;
    }
    tr.project(pos, e.hint, proj);
    e.hint = proj.index;
    const r = (e.radius || 0.5) + 0.1;
    const lat = clamp(proj.lateral, -(proj.wallL - r), proj.wallR - r);
    if (lat !== proj.lateral) {
      const d = lat - proj.lateral;
      pos.x += proj.right.x * d; pos.z += proj.right.z * d;
      proj.lateral = lat;
      const vn = v.x * proj.right.x + v.z * proj.right.z;
      if (vn * d < 0) { v.x -= proj.right.x * vn * 1.3; v.z -= proj.right.z * vn * 1.3; }
    }
    const floor = proj.height + (e.radius || 0);
    if (e.grounded) pos.y = floor;
    else if (pos.y <= floor && v.y < 0) {
      pos.y = floor; v.y = 0; v.x *= landKeep; v.z *= landKeep;
      e.grounded = true;
      res = 'land';
    }
    e.s = proj.s;
    e.lateral = proj.lateral;
    return res;
  }

  /**
   * Ride along the track: e.s advances at e.speed (corrected for the lateral
   * offset in corners), e.lateral eases toward opts.lateral (m, default 0) at
   * opts.rate m/s (or opts.damp 1/s), position = road point + e.height. Like
   * the Capo Crusher's ground run. Returns null.
   */
  stepTrack(e, dt, { lateral = 0, rate = 2, damp: dampRate = 0 } = {}) {
    const tr = this.sys.track, f = tr.frameAt(e.s, this.sys._frame2);
    const corr = clamp(1 - f.curvature * e.lateral, 0.55, 1.6);
    const ds = (e.speed * dt) / corr;
    e.s = tr.wrapS(e.s + ds);
    e.dist += ds;
    e.lateral = dampRate > 0 ? damp(e.lateral, lateral, dampRate, dt) : approach(e.lateral, lateral, rate * dt);
    const lim = 0.6;
    e.lateral = clamp(e.lateral, -(f.wallL - lim), f.wallR - lim);
    tr.pointAt(e.s, e.lateral, e.position);
    e.position.y += e.height || 0;
    const dx = e.position.x - e.prev.x, dz = e.position.z - e.prev.z, dl = Math.hypot(dx, dz);
    if (dl > 1e-4) { e.dir.x = dx / dl; e.dir.z = dz / dl; }
    tr.project(e.position, e.hint, e.proj);
    e.hint = e.proj.index;
    return null;
  }

  /** Turn e.dir toward a world position at up to `turnRate` rad/s (horizontal homing). */
  steerToward(e, target, turnRate, dt) {
    const tx = target.x - e.position.x, tz = target.z - e.position.z;
    const cur = Math.atan2(e.dir.x, e.dir.z), want = Math.atan2(tx, tz);
    const yaw = cur + clamp(angleDiff(cur, want), -turnRate * dt, turnRate * dt);
    e.dir.x = Math.sin(yaw); e.dir.z = Math.cos(yaw);
  }

  // ------------------------------------------------------------ shields, smashing, coins (shared v5 helpers)
  // Added by the v5 group-A item agent (notes/v5-items-A.md §Shared helpers). Generic: any plugin may use them,
  // and any plugin can take part through the optional hooks `shield(ctx, pos, r, owner, info)` (blocks attacks)
  // and, for the coins system, `dropLoose(ctx, position, count, opts)`.

  /**
   * Does a shield stop an attack at `pos` (radius r) owned by `owner`? In order:
   *   1. another kart's orbiting triple bouncer / rocket → detached ('blocked');
   *   2. info.peels !== false: another kart's trailing peel (Banana Bunch) → it drops off ('blocked');
   *   3. every plugin's `shield(ctx, pos, r, owner, info)` hook (orbiting ice balls, hearts, tails, mouths ...):
   *      a truthy return = blocked (the hook consumes its own shield, may return { kart, ref }).
   * info: { item (attacker id, default this plugin), kind, entity, dir {x,z} (attacker heading), pierce
   *         (true: the attacker survives, e.g. a giant wheel), peels; the hook also gets by (= owner), attacker (plugin id) }.
   * Returns { kart, by: 'orbiter' | 'peel' | <plugin id>, ref } or null. Emits item:blocked when blocked.
   */
  shieldAt(pos, radius, owner = null, info = {}) {
    const sys = this.sys;
    const item = info.item || this.id;
    const ro = radius + ITEM.orbitHitRadius;
    for (let i = sys.attached.length - 1; i >= 0; i--) {
      const a = sys.attached[i];
      if (!a.active || a.owner === owner) continue;
      const peel = a.type === 'banana';
      if (peel && info.peels === false) continue;
      const rr = peel ? radius + ITEM.hazardRadius * 0.6 : ro;
      const dx = a.position.x - pos.x, dz = a.position.z - pos.z;
      if (dx * dx + dz * dz > rr * rr || Math.abs(a.position.y + (peel ? 0.4 : 0) - pos.y) > 1.5) continue;
      const kart = a.owner;
      sys._detach(a, 'blocked');
      bus.emit('item:blocked', { kart, item, by: owner, entity: info.entity || null });
      return { kart, by: peel ? 'peel' : 'orbiter', ref: a };
    }
    const q = this._shieldInfo || (this._shieldInfo = {});
    for (const k in q) delete q[k];
    Object.assign(q, info);
    q.item = item; q.by = owner; q.attacker = this.id;
    for (const p of sys._plugins) {
      if (typeof p.handler.shield !== 'function') continue;
      const r = sys._call(p, 'shield', pos, radius, owner, q);
      if (!r) continue;
      const kart = (r && r.kart) || null;
      bus.emit('item:blocked', { kart, item, by: owner, entity: info.entity || null, shield: p.id });
      return { kart, by: p.id, ref: (r && r.ref) || null };
    }
    return null;
  }

  /**
   * Destroy the road items something at `pos` (radius r) touches; returns how many.
   *   opts.bananas (true)      native banana peels (within r + 0.6)
   *   opts.stink (false)       native stink clouds (within r + their radius x 0.5)
   *   opts.projectiles (false) native bouncers / rockets (within r + ITEM.projectileRadius)
   *   opts.bombs (false)       native Meatball Bombs: set off (they explode)
   *   opts.roles (['hazard'])  plugin entities with one of these roles (within r + e.radius), removed with opts.reason
   *   opts.reason ('smash')    the removal reason plugins see in onEntityRemove
   *   opts.skip                an entity (or array of them) to leave alone (usually the attacker itself)
   *   opts.owner / opts.ownerGrace (s): leave the owner's own items younger than this alone
   *   opts.dy (1.6)            vertical tolerance
   *   opts.max (Infinity)      stop after this many
   */
  smashAt(pos, radius, opts = {}) {
    const sys = this.sys;
    const { bananas = true, stink = false, projectiles = false, bombs = false, roles = ['hazard'], reason = 'smash',
      skip = null, owner = null, ownerGrace = 0, dy = 1.6, max = Infinity } = opts;
    let n = 0;
    const near = (p, r, yOff = 0) => {
      const dx = p.x - pos.x, dz = p.z - pos.z;
      return dx * dx + dz * dz <= r * r && Math.abs(p.y + yOff - pos.y) <= dy;
    };
    if (bananas || stink) {
      for (let i = sys.hazards.length - 1; i >= 0 && n < max; i--) {
        const h = sys.hazards[i];
        if (!h.active) continue;
        if (owner && h.owner === owner && h.age < ownerGrace) continue;
        if (h.type === 'banana' ? !bananas || !near(h.position, radius + 0.6, 0.4) : !stink || !near(h.position, radius + h.radius * 0.5, 0.4)) continue;
        sys._removeHazard(h, 'blocked');
        n++;
      }
    }
    if (projectiles) {
      for (let i = sys.projectiles.length - 1; i >= 0 && n < max; i--) {
        const p = sys.projectiles[i];
        if (!p.active || (owner && p.owner === owner && p.age < ownerGrace) || !near(p.position, radius + ITEM.projectileRadius)) continue;
        sys._removeProjectile(p, 'blocked');
        n++;
      }
    }
    if (bombs) {
      for (let i = sys.bombs.length - 1; i >= 0 && n < max; i--) {
        const b = sys.bombs[i];
        if (!b.active || (owner && b.owner === owner && b.age < ownerGrace) || !near(b.position, radius + 0.8)) continue;
        sys._explodeBomb(b);
        n++;
      }
    }
    if (roles && roles.length) {
      for (let i = sys.entities.length - 1; i >= 0 && n < max; i--) {
        const e = sys.entities[i];
        if (!e || !e.active || !roles.includes(e.role)) continue;
        if (skip && (skip === e || (Array.isArray(skip) && skip.includes(e)))) continue;
        if (owner && e.owner === owner && e.age < ownerGrace) continue;
        if (!near(e.position, radius + e.radius)) continue;
        sys._removeEntity(e, reason);
        n++;
      }
    }
    return n;
  }

  /**
   * The first item in play touching `pos` (radius r), without destroying it — for "ends on contact with
   * any item" rules: native peels / projectiles / bombs / orbiters and plugin entities with opts.roles
   * (default hazard + projectile + shield). Returns the object or null. opts: { skip, owner, dy }.
   */
  touchingItem(pos, radius, opts = {}) {
    const sys = this.sys;
    const { roles = ['hazard', 'projectile', 'shield'], skip = null, owner = null, dy = 1.6 } = opts;
    const near = (p, r) => { const dx = p.x - pos.x, dz = p.z - pos.z; return dx * dx + dz * dz <= r * r && Math.abs(p.y - pos.y) <= dy; };
    for (const h of sys.hazards) if (h.active && h.type === 'banana' && near(h.position, radius + 0.6)) return h;
    for (const p of sys.projectiles) if (p.active && p.owner !== owner && near(p.position, radius + ITEM.projectileRadius)) return p;
    for (const b of sys.bombs) if (b.active && near(b.position, radius + 0.8)) return b;
    for (const a of sys.attached) if (a.active && a.owner !== owner && near(a.position, radius + ITEM.orbitHitRadius)) return a;
    for (const e of sys.entities) {
      if (!e.active || e === skip || !roles.includes(e.role) || (owner && e.owner === owner)) continue;
      if (near(e.position, radius + e.radius)) return e;
    }
    return null;
  }

  /** Recycle this plugin's oldest entity of `kind` when `max` of them are live (road caps: "oldest recycled"). */
  roadCap(kind, max, reason = 'expire') {
    let n = 0, oldest = null;
    for (const e of this.sys.entities) {
      if (e.plugin !== this || e.kind !== kind || !e.active) continue;
      n++;
      if (!oldest || e.age > oldest.age) oldest = e;
    }
    if (n >= max && oldest) { this.remove(oldest, reason); return oldest; }
    return null;
  }

  /** A point `back` m behind the kart (out), pulled onto the road inside the walls (margin m), on the surface. */
  behind(kart, back, out = {}, margin = 0.6) {
    const o = this._behindObj || (this._behindObj = { position: new THREE.Vector3(), proj: {}, hint: -1 });
    o.position.set(kart.position.x - Math.sin(kart.yaw) * back, kart.position.y, kart.position.z - Math.cos(kart.yaw) * back);
    o.hint = kart.hint ?? -1;
    this.keepOnRoad(o, margin, true);
    out.x = o.position.x; out.y = o.position.y; out.z = o.position.z;
    return out;
  }

  /**
   * Loose lire on the road at `position` (the coins system's `dropLoose(ctx, position, count, opts)` hook).
   * opts: { radius (spread, m), ring (true: evenly on a ring), owner (the dropper, regrab delay), along {x,z} }.
   * Returns the number dropped (0 when no coin system takes them).
   */
  dropCoins(position, count, opts = {}) {
    if (!(count > 0) || !position) return 0;
    for (const p of this.sys._plugins) {
      if (p.item || typeof p.handler.dropLoose !== 'function') continue;
      return Number(this.sys._call(p, 'dropLoose', position, count, opts)) || 0;
    }
    return 0;
  }

  /**
   * Something heavy hit the road at `position` (rolling pins): course hazards that can be knocked out
   * (Monte's cheese wheels, scooters ...) may listen to the bus event item:strike { position, radius, kart, item }.
   */
  strike(position, radius, by = null) {
    bus.emit('item:strike', { position, radius, kart: by, item: this.id });
  }

  /**
   * The CPU difficulty of this race, guessed from the engine class (50cc easy, 100cc normal, 150cc hard
   * by default — DIFFICULTY is picked by the class): 'easy' | 'normal' | 'hard'. For rules like
   * "only Hard CPUs see through a fake box" where an item has no AI driver at hand.
   */
  difficulty() {
    const m = this.sys.ccMult;
    return m >= 0.97 ? 'hard' : m >= 0.87 ? 'normal' : 'easy';
  }

  // ------------------------------------------------------------ visuals (browser)
  /** Register a geometry / material / texture (anything with dispose()) for disposal with the ItemSystem. */
  own(x) { if (x) this._own.push(x); return x; }

  /**
   * Primitive → non-indexed, vertex-coloured, uv-less part for mergeParts (like items.js part()).
   * opts: { scale: [x, y, z], rot: Quaternion | Euler, pos: [x, y, z] }. Consumes `geo`.
   */
  part(geo, color, { scale, rot, pos } = {}) {
    if (scale) geo.scale(scale[0], scale[1], scale[2]);
    if (rot) { if (rot.isEuler) geo.applyQuaternion(new THREE.Quaternion().setFromEuler(rot)); else geo.applyQuaternion(rot); }
    if (pos) geo.translate(pos[0], pos[1], pos[2]);
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (g.attributes.uv) g.deleteAttribute('uv');
    if (g.attributes.uv1) g.deleteAttribute('uv1');
    const col = new THREE.Color(color);
    const n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  }
  /** Merge part() pieces into one owned geometry. */
  mergeParts(parts) {
    const g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    g.computeBoundingSphere();
    return this.own(g);
  }
  /** An owned InstancedMesh (count 0, hidden while empty) under ctx.root. opts: { shadow, receive, order }. */
  instanced(geo, material, capacity, name, { shadow = true, receive = false, order = 0 } = {}) {
    const m = new THREE.InstancedMesh(geo, material, capacity);
    m.name = name || `item:${this.id}`;
    m.frustumCulled = false;
    m.castShadow = shadow;
    m.receiveShadow = receive;
    m.renderOrder = order;
    m.count = 0;
    m.visible = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.own(material);
    this.own(m);                                  // InstancedMesh.dispose() frees its instance buffers
    if (this.root) this.root.add(m);
    return m;
  }

  // internal: called by ItemSystem
  _initVisuals() {
    if (!this.sys.vis || this.root) return;
    this.root = new THREE.Group();
    this.root.name = `item:${this.id}`;
    this.sys.vis.root.add(this.root);
  }
  _disposeVisuals() {
    for (const x of this._own) { try { x.dispose(); } catch { /* gone */ } }
    this._own.length = 0;
    if (this.root && this.root.parent) this.root.parent.remove(this.root);
    this.root = null;
  }
  _dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this._kst.clear();
  }
}
