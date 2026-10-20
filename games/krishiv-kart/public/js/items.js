// Item system: item boxes + roulette, held items, hazards (banana peels,
// stink clouds, meatball bombs), projectiles (bouncers, homing rockets, the
// Capo Crusher), items attached to karts (orbiting triples, trailing banana
// bunches) and the instant items (toots, rainbow star, zap, espresso,
// accordion, beer rocket). SPEC §8, §14.5, §15.2; numbers and the reasoning
// behind them: notes/research-v4-items.md.
//
//   const items = new ItemSystem({ track, karts, scene, effects, rng, ccMult, enabled });
//   // per physics substep, after the AI wrote kart inputs, before kart.update():
//   items.update(dt, race);
//
// Roulette (same rules for humans and CPUs): ITEM_TABLE row by race place
// (stretched over the table for fewer racers), read up to 2 rows further back
// when a kart is far behind the leader (ITEM.farBehind*), then the hard rules:
// start times, caps on items in play, cooldowns and place gates (ITEM.*FreeTime,
// *Max, *Cooldown, *MinPlace). A blocked column re-rolls among the others.
// Projectile speeds scale with the engine class (ccMult). enabled: false (VS
// "Items Off") builds no item boxes at all.
//
// The Beer Rocket drives its rider from here, without kart.js hooks: every
// substep (before kart.update) the rider's inputs, heading and velocity are
// set by a racing-line autopilot, its invincibility is the star timer (kept
// topped up; KartView draws the mug instead of the rainbow) and its speed a
// boost whose multiplier makes maxSpeed = ITEM.beerSpeedMult x top speed.
//
// Per-kart fields written here for views / HUD / AI (undefined when items are off):
//   kart.beer        null | { phase: 'chug'|'ride', t, startPlace, gained }
//   kart.ink         0..1 coffee on this kart's screen (Espresso Splash); kart.inkIncoming
//   kart.capoWarn    0 | 1 (a Capo Crusher heads for this kart) | 2 (locked on)
//   kart.goldenTimer s left in a running Golden Toot window
//
// Node-safe when constructed with `scene: null` (no THREE objects besides
// Vector3s are created, no DOM access): tools/sim.mjs runs the exact same
// rules headless. With a scene, ItemVisuals builds a small set of pooled /
// instanced meshes (see below).
//
// Every hit goes through the Kart API (spinOut / tumble / zap / startStar /
// applyBoost), which handles invincibility and invulnerability itself.
//
// v5 item plugins (SPEC §16.2): every id that is not one of the 17 native
// items (config NATIVE_ITEM_IDS) is dispatched to its registered handler
// (public/js/items/<id>.js, registered through items/registry.js, imported by
// items/index.js). Each handler gets a PluginContext (items/context.js) per
// ItemSystem with the shared helpers (entities, contact tests, hits, track
// projection, places, events, rng, scene). The hooks run at fixed points:
//   _finishRoll → onGet · useItem → use · update (each substep, after the
//   natives) → update · a kart becoming disabled → onKartHit · getThreatsNear
//   → threats · blasts / accordion → clearAround · clear / dispose · with a
//   scene: initVisuals / updateVisuals (each substep) / disposeVisuals.
// Plugin entities (ctx.spawn) live in this.entities; the roulette applies
// ITEM_ENABLED + ITEM_RULES (config) generically. notes/v5-foundation.md has
// the full reference.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ITEM, ITEM_IDS, ITEM_INFO, ITEM_TABLE, ITEM_RULES, BOOST, KART, HIT, itemEnabled } from './config.js';
import { bus } from './bus.js';
import { clamp, damp, angleDiff, wrapAngle, approach, weightedPick, TAU } from './utils.js';
import { itemHandlers, itemSystems } from './items/index.js';
import { PluginContext } from './items/context.js';

export { registerItem, getItemHandler, registerItemSystem, isNativeItem } from './items/index.js';

// Private tuning of the item rules (shared numbers live in config.js ITEM).
export const ITEM_TUNE = {
  boxHover: 1.1,            // box center height above the road (m)
  boxPickupDy: 2.4,         // vertical tolerance for box pickups
  rollShortenTo: 0.3,       // pressing item while rolling cuts the roulette to this
  // hazards
  bananaBack: 2.2,          // dropped this far behind the kart
  bananaLife: 50,           // s before an untouched peel shrivels away
  bananaOwnerGrace: 0.7,    // s the dropper ignores its own peel
  bananaHitDy: 1.4,
  maxBananas: 20,           // oldest peel is recycled beyond this
  stinkBack: 3.0,
  stinkOwnerGrace: 1.0,     // SPEC: owner immune for the first second
  stinkSlowRate: 0.9,       // 1/s extra speed bleed while inside a cloud ("slight slow")
  stinkHitDy: 3.0,
  stinkShrinkTime: 1.2,     // s at the end of life in which the cloud shrinks away
  stinkGrowTime: 0.45,      // s for a fresh cloud to billow out to full radius (45% -> 100%)
  maxStinks: 8,
  // projectiles
  launchAhead: 1.9,         // spawn this far in front of the kart center
  bouncerRadius: 0.55,
  bouncerBoost: 20,         // launched at max(bouncerSpeed, kartSpeed + this)
  rocketHeight: 0.85,       // cruise height above the road
  rocketLateralRate: 1.6,   // 1/s lateral easing toward the target while following the track
  rocketHomeTurn: 7.0,      // rad/s turn rate while homing (at range) ...
  rocketCloseTurn: 2.0,     // ... rising to speed x this / distance up close: turn radius <= half
                            //     the distance, so it reaches a target at any bearing (a rival
                            //     right alongside is hit, not circled)
  rocketLostGap: -12,       // m: target this far behind the rocket -> fly straight
  kartHitDy: 1.8,
  bananaBlockRadius: 0.6,   // projectile vs banana extra radius
  maxProjectiles: 16,
  // triples (orbiters circle the kart, peels trail it along a breadcrumb path)
  trailStep: 0.35,          // m between breadcrumbs
  trailPoints: 24,          // breadcrumbs kept (> max trail gap / step)
  attachedHitDy: 1.6,
  // Capo Crusher
  capoLateralRate: 2,       // m/s: the ground run eases onto the centre line
  capoRiseSpeed: 48,        // m/s: lock-on swoop up to the orbit (time = distance / this, clamped)
  capoRiseMin: 0.45,
  capoRiseMax: 1.1,
  capoHitDy: 2.2,
  capoOwnerGrace: 0.6,      // s the shooter is safe from its own capo's ground run
  // Meatball Bomb
  bombRadius: 0.55,
  maxBombs: 6,
  bombHitDy: 2.2,
  bombBack: 2.5,            // dropped this far behind (brake held)
  bombLandKeep: 0.3,        // share of the throw speed kept rolling after the landing thud
  // Beer Rocket autopilot
  beerLookBase: 5,          // m: pure-pursuit look-ahead = base + gain x speed
  beerLookGain: 0.22,
  beerYawRate: 7,           // rad/s max heading change while riding ...
  beerChugYawRate: 5,       // ... and while chugging (turns a wrong-way kart round)
  beerEdge: 1.2,            // m: the line keeps this far inside the road edge
  beerOffsetRate: 3,        // 1/s: the player's wheel -> lateral offset smoothing
  beerStraight: 25,         // m of road ahead that must be fairly straight to drop out ...
  beerStraightCurv: 1 / 70, // ... (|curvature| below this)
  beerKnockDy: 1.6,
  inkWashLeft: 0.35,        // s of fade left after a boost washes the coffee off
};

const T = ITEM_TUNE;
const IDX = Object.fromEntries(ITEM_IDS.map((id, i) => [id, i]));
const TRIPLE_TYPE = { triple_banana: 'banana', triple_bouncer: 'bouncer', triple_rocket: 'rocket' };
const TOOTS = { toot: 1, triple_toot: 1, golden_toot: 1 };
// "at 29 m/s" for the far-behind shift (a 3-star kart's 150cc top speed)
const REF_SPEED = KART.topSpeedBase + 3 * KART.topSpeedPerStar;

export class ItemSystem {
  /**
   * @param {object} o
   * @param {number} [o.ccMult=1]     engine class speed multiplier (projectile speeds)
   * @param {boolean} [o.enabled=true] false: items off (no item boxes)
   */
  constructor({ track, karts, scene = null, effects = null, rng = Math.random, ccMult = 1, enabled = true }) {
    this.track = track;
    this.karts = karts;
    this.scene = scene;
    this.effects = effects;
    this.rng = rng;
    this.ccMult = ccMult > 0 ? ccMult : 1;
    this.enabled = enabled !== false;
    this.time = 0;
    this.race = null;            // last race passed to update() (places, rocket targets)

    // item boxes (center ~1.1 m above the road); none with items off
    this.boxes = (this.enabled ? track.itemBoxes : []).map((b, i) => {
      const position = b.position.clone();
      position.y += T.boxHover;
      return { index: i, row: b.row, s: b.s, lateral: b.lateral, position, active: true, respawnTimer: 0 };
    });

    this.hazards = [];           // active bananas + stink clouds
    this.projectiles = [];       // active bouncers + rockets
    this.attached = [];          // orbiting bouncers / rockets + trailing peels of triples
    this.capos = [];             // Capo Crushers in flight
    this.bombs = [];             // Meatball Bombs (flying, rolling or sitting on the road)
    this._hazardPool = [];
    this._projPool = [];
    this._attPool = [];
    this._capoPool = [];
    this._bombPool = [];
    this._uid = 0;

    this._weights = new Float64Array(ITEM_IDS.length);
    this._zapBlockedUntil = -Infinity;      // race clock (s since GO) before which no zap rolls
    this._capoBlockedUntil = -Infinity;     // ... no capo (cooldown after one resolves)
    this._espressoBlockedUntil = -Infinity; // ... no espresso (cooldown after one is used)
    this._threats = [];
    this._threatPool = [];
    this._frame = {};
    this._frame2 = {};
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    // per-kart item state (+ the public kart fields views and the HUD read)
    this._st = new Map();
    for (const k of karts) this._initKart(k);
    this._offs = [
      bus.on('kart:boost', (e) => {
        // an item or pad boost washes espresso off the screen (not drift mini-turbos)
        const st = e && this._st.get(e.kart);
        if (st && st.inkLanded && (e.source === 'item' || e.source === 'pad')) st.inkWash = true;
      }),
    ];

    // counters (handy for tests / the sim)
    this.used = Object.fromEntries(ITEM_IDS.map((id) => [id, 0]));

    // ---- v5 item plugins + item systems (SPEC §16.2) and their pooled entities
    this.entities = [];
    this._entityPool = [];
    this._blockedUntil = {};                // ITEM_RULES cooldowns: id → race clock
    this.pluginErrors = 0;                  // hooks that threw (logged once per hook; the sim fails on > 0)
    this._errWarned = new Set();
    this._plugins = [];                     // { id, handler, ctx, item }
    this._pluginById = new Map();
    this._hk = { update: [], onKartHit: [], threats: [], clearAround: [], updateVisuals: [] };
    this._threatKart = null;
    this._threatPush = (ref, o) => this._pushPluginThreat(ref, o);
    for (const [id, handler] of itemHandlers()) this._addPlugin(id, handler, true);
    for (const [name, handler] of itemSystems()) this._addPlugin(name, handler, false);
    for (const p of this._plugins) if (p.handler.init) this._call(p, 'init');

    this.vis = scene ? new ItemVisuals(this, scene, effects) : null;
    if (this.vis) {
      for (const p of this._plugins) {
        p.ctx._initVisuals();
        if (p.handler.initVisuals) this._call(p, 'initVisuals');
      }
    }
  }

  // ------------------------------------------------------------- plugins

  _addPlugin(id, handler, item) {
    const p = { id, handler, ctx: new PluginContext(this, id, handler), item };
    this._plugins.push(p);
    if (item) this._pluginById.set(id, p);
    for (const hook in this._hk) if (typeof handler[hook] === 'function') this._hk[hook].push(p);
  }

  /** Call a plugin hook, isolating the native items from a throwing plugin (logged once per hook). */
  _call(p, name, ...args) {
    try {
      return p.handler[name](p.ctx, ...args);
    } catch (err) {
      this.pluginErrors++;
      const key = `${p.id}.${name}`;
      if (!this._errWarned.has(key)) { this._errWarned.add(key); console.error(`[items] plugin hook ${key} threw`, err); }
      return undefined;
    }
  }

  /** The PluginContext of a plugin item / item system by id (tests, dev pages), or null. */
  pluginContext(id) {
    for (const p of this._plugins) if (p.id === id) return p.ctx;
    return null;
  }

  _spawnEntity(ctx, o) {
    const tr = this.track;
    const e = this._entityPool.pop() || makeEntity();
    const owner = o.owner || null;
    e.uid = ++this._uid;
    e.plugin = ctx;
    e.item = ctx.id;
    e.kind = e.type = o.kind || ctx.id;
    e.owner = owner;
    e.target = o.target || null;
    e.age = 0;
    e.life = o.life ?? 0;
    e.speed = o.speed ?? 0;
    e.radius = o.radius ?? 0.5;
    e.height = o.height ?? 0;
    e.bounces = 0;
    e.grounded = !!o.grounded;
    e.threat = !!o.threat;
    e.clear = o.clear ?? 0;
    e.solid = !!o.solid;
    e.sturdy = !!o.sturdy;
    e.counts = !!o.counts;
    e.ownerGrace = o.ownerGrace ?? ITEM.shooterGrace;
    e.phase = o.phase || '';
    e.hitMask = 0;
    e.data = o.data || {};
    e.vis = null;
    const fx = owner ? Math.sin(owner.yaw) : 0, fz = owner ? Math.cos(owner.yaw) : 1;
    if (o.position) e.position.set(o.position.x, o.position.y, o.position.z);
    else if (owner) e.position.set(owner.position.x + fx * T.launchAhead, owner.position.y, owner.position.z + fz * T.launchAhead);
    else e.position.set(0, 0, 0);
    if (o.dir) { e.dir.set(o.dir.x, 0, o.dir.z); if (e.dir.lengthSq() > 1e-9) e.dir.normalize(); else e.dir.set(fx, 0, fz); }
    else e.dir.set(fx, 0, fz);
    if (o.vel) e.vel.set(o.vel.x, o.vel.y, o.vel.z); else e.vel.set(0, 0, 0);
    tr.project(e.position, owner && owner.hint !== undefined ? owner.hint : -1, e.proj);
    e.hint = e.proj.index;
    e.s = o.s ?? e.proj.s;
    e.lateral = o.lateral ?? e.proj.lateral;
    e.dist = o.dist ?? (owner && Number.isFinite(owner.distance) ? owner.distance : 0);
    e.prev.copy(e.position);
    e.active = true;
    this.entities.push(e);
    return e;
  }

  _removeEntity(e, reason) {
    if (!e || !e.active) return;
    e.active = false;
    const i = this.entities.indexOf(e);
    if (i >= 0) { this.entities[i] = this.entities[this.entities.length - 1]; this.entities.pop(); }
    const p = e.plugin && this._plugins.find((x) => x.ctx === e.plugin);
    if (p && p.handler.onEntityRemove) this._call(p, 'onEntityRemove', e, reason);
    e.owner = null; e.target = null; e.plugin = null; e.data = null; e.vis = null;
    this._entityPool.push(e);
  }

  // Plugin entities age every substep (removed at their life), then each plugin's update hook.
  _updatePlugins(dt) {
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      if (!e || !e.active) continue;
      e.age += dt;
      e.prev.copy(e.position);
      if (e.life > 0 && e.age >= e.life) this._removeEntity(e, 'expire');
    }
    for (const p of this._hk.update) this._call(p, 'update', dt);
  }

  // Blasts / the accordion: plugin entities (not sturdy ones) in range are destroyed, then the clearAround hooks.
  // The accordion spares its user's own entities (like its own projectiles). Returns the number removed.
  _clearPlugins(at, R, by, kind) {
    let n = 0;
    const R2 = R * R;
    for (let j = this.entities.length - 1; j >= 0; j--) {
      const e = this.entities[j];
      if (!e || !e.active || e.sturdy || (kind === 'accordion' && e.owner === by)) continue;
      if (e.position.distanceToSquared(at) > R2) continue;
      this._removeEntity(e, 'blocked');
      n++;
    }
    for (const p of this._hk.clearAround) n += Number(this._call(p, 'clearAround', at, R, by, kind)) || 0;
    return n;
  }

  // A plugin threats hook's push(ref, o): o = { position, s, lateral, radius, clear, type, dirX, dirZ, speed, targeting, phase }
  _pushPluginThreat(ref, o = {}) {
    const kart = this._threatKart;
    const pos = o.position || ref.position;
    if (!kart || !pos) return null;
    const dx = pos.x - kart.position.x, dz = pos.z - kart.position.z;
    const ahead = dx * Math.sin(kart.yaw) + dz * Math.cos(kart.yaw) > 0;
    const t = this._pushThreat(ref, Math.hypot(dx, dz), ahead, o.radius ?? ref.radius ?? 1, o.s ?? ref.s ?? 0, o.lateral ?? ref.lateral ?? 0);
    t.position = pos;
    t.type = o.type || ref.kind || ref.type || 'hazard';
    t.clear = o.clear ?? (t.radius + 1.0);
    t.dirX = o.dirX || 0; t.dirZ = o.dirZ || 0; t.speed = o.speed || 0;
    t.targeting = !!o.targeting;
    t.phase = o.phase || '';
    t.item = o.item || '';
    return t;
  }

  /**
   * Run an item's effect for a kart without touching its slot (plugin helper
   * ctx.activate): native banana / stink / bouncer / rocket / toots / star /
   * zap / capo / meatball_bomb / espresso / accordion, or a plugin id's use().
   */
  activateEffect(kart, id) {
    switch (id) {
      case 'banana': case 'triple_banana': this._dropHazard(kart, 'banana'); return true;
      case 'stink': this._dropHazard(kart, 'stink'); return true;
      case 'bouncer': case 'triple_bouncer': this._launch(kart, 'bouncer'); return true;
      case 'rocket': case 'triple_rocket': this._launch(kart, 'rocket'); return true;
      case 'toot': case 'triple_toot': case 'golden_toot': kart.applyBoost(BOOST.tootDuration, 'item'); this._boostDodge(kart); return true;
      case 'star': kart.startStar(); this._washInk(kart); return true;
      case 'zap': this._zap(kart); return true;
      case 'capo': this._launchCapo(kart); return true;
      case 'meatball_bomb': this._throwBomb(kart); return true;
      case 'espresso': this._espresso(kart); return true;
      case 'accordion': this._accordion(kart); return true;
      default: {
        const p = this._pluginById.get(id);
        return !!(p && p.handler.use && this._call(p, 'use', kart));
      }
    }
  }

  /** Put an item in an empty slot as if the roulette had landed on it (triples deploy, plugin onGet). */
  giveItem(kart, id) {
    if (!kart || kart.item || kart.rolling || !ITEM_INFO[id]) return false;
    kart.rolling = true;
    kart.rollItem = id;
    kart.rollTimer = 0;
    this._finishRoll(kart);
    return true;
  }

  _initKart(k) {
    const st = {
      steerIn: 0, steerOut: NaN,        // the driver's own wheel (detects fresh input writes)
      prevDisabled: false,
      attached: 0,                      // items attached to this kart
      orbitAngle: 0,
      trail: new Float32Array(T.trailPoints * 3), trailN: 0, trailHead: 0,
      inkAge: -1, inkLanded: false, inkWash: false, inkBy: null,
      beer: null, realStar: 0,
      goldenLast: -Infinity,
    };
    this._st.set(k, st);
    k.beer = null;
    k.ink = 0;
    k.inkIncoming = false;
    k.capoWarn = 0;
    k.goldenTimer = 0;
    return st;
  }

  _state(k) { return this._st.get(k) || this._initKart(k); }

  // ------------------------------------------------------------- roulette

  // Race clock for the item limits: seconds since GO (the system's own clock without a race).
  _clock() {
    return this.race && this.race.time !== undefined ? this.race.time : this.time;
  }

  /** Items of a kind in play: held + rolling + live (stars running, capos flying, bombs on the road). */
  _countOf(id) {
    let n = 0;
    for (const k of this.karts) {
      if (k.item === id || (k.rolling && k.rollItem === id)) n++;
      else if (id === 'star' && k.starTimer > 0 && !(k.beer && !(this._state(k).realStar > 0))) n++;
    }
    if (id === 'capo') n += this.capos.length;
    else if (id === 'meatball_bomb') n += this.bombs.length;
    // v5 plugins: entities spawned with counts: true, plus the plugin's own count of live instances
    for (let i = 0; i < this.entities.length; i++) { const e = this.entities[i]; if (e.counts && e.item === id && e.active) n++; }
    const p = this._pluginById.get(id);
    if (p && p.handler.countLive) n += Number(this._call(p, 'countLive')) || 0;
    return n;
  }

  /** Table rows (0 = 1st) a kart this far behind the leader reads further back (0..ITEM.farBehindMaxRows). */
  farBehindShift(kart) {
    let lead = -Infinity;
    for (const k of this.karts) if (!k.finished && k.distance > lead) lead = k.distance;
    if (!Number.isFinite(lead) || !Number.isFinite(kart.distance)) return 0;
    const gapS = (lead - kart.distance) / (REF_SPEED * this.ccMult);
    return clamp((gapS - ITEM.farBehindStart) / ITEM.farBehindPerRow, 0, ITEM.farBehindMaxRows);
  }

  /**
   * Roulette weights for a kart at `place` (1..8) into `out` (Float64Array,
   * ITEM_IDS order), after the far-behind shift and every hard rule. Returns `out`.
   */
  weightsFor(kart, place, out = this._weights) {
    const n = this.karts.length, rows = ITEM_TABLE.length;
    let row = clamp(Math.round(place) || 1, 1, rows) - 1;
    // fewer racers than table rows: stretch places over the whole table
    if (n > 1 && n < rows) row = Math.round(((clamp(place, 1, n) - 1) * (rows - 1)) / (n - 1));
    const gate = row + 1;                         // place as an 8-racer place (for the gates)
    const r = row > 0 ? Math.min(rows - 1, row + this.farBehindShift(kart)) : 0;   // the leader is never shifted
    const r0 = Math.floor(r), r1 = Math.min(rows - 1, r0 + 1), f = r - r0;
    const A = ITEM_TABLE[r0], B = ITEM_TABLE[r1];
    const w = out;
    for (let i = 0; i < w.length; i++) w[i] = (A[i] || 0) * (1 - f) + (B[i] || 0) * f;
    const now = this._clock();
    const block = (id, cond) => { const i = IDX[id]; if (i !== undefined && w[i] > 0 && cond()) w[i] = 0; };
    block('zap', () => now < ITEM.zapFreeTime || now < this._zapBlockedUntil || this._countOf('zap') > 0);
    block('star', () => this._countOf('star') >= ITEM.starMax);
    block('capo', () => now < ITEM.capoFreeTime || now < this._capoBlockedUntil || gate < ITEM.capoMinPlace || this._countOf('capo') >= ITEM.capoMax);
    block('beer_rocket', () => now < ITEM.beerFreeTime || gate < ITEM.beerMinPlace || this._countOf('beer_rocket') >= ITEM.beerMax);
    block('golden_toot', () => now < ITEM.goldenFreeTime || this._countOf('golden_toot') >= ITEM.goldenMax);
    block('espresso', () => now < ITEM.espressoFreeTime || now < this._espressoBlockedUntil || this._countOf('espresso') >= ITEM.espressoMax);
    block('meatball_bomb', () => now < ITEM.bombFreeTime || this._countOf('meatball_bomb') >= ITEM.bombMax);
    block('accordion', () => now < ITEM.accordionFreeTime);
    block('triple_rocket', () => now < ITEM.tripleRocketFreeTime);
    // v5 (SPEC §16.2): items not enabled yet never roll; then the data-driven ITEM_RULES
    for (let i = 0; i < w.length; i++) if (w[i] > 0 && !itemEnabled(ITEM_IDS[i])) w[i] = 0;
    for (const id in ITEM_RULES) {
      const r = ITEM_RULES[id];
      block(id, () => (r.freeTime > 0 && now < r.freeTime)
        || (r.cooldown > 0 && now < (this._blockedUntil[id] ?? -Infinity))
        || (r.minPlace > 0 && gate < r.minPlace) || (r.maxPlace > 0 && gate > r.maxPlace)
        || (r.max > 0 && this._countOf(id) >= r.max));
    }
    return w;
  }

  /** Item id for a kart at `place` (1..8): ITEM_TABLE odds within every limit (SPEC §15.2). */
  rollFor(kart, place) {
    const w = this.weightsFor(kart, place);
    let any = false;
    for (let i = 0; i < w.length; i++) if (w[i] > 0) { any = true; break; }
    const id = any ? ITEM_IDS[weightedPick(w, this.rng)] : 'banana';
    if (id === 'zap') this._zapBlockedUntil = this._clock() + ITEM.zapCooldown;
    return id;
  }

  _startRoll(kart) {
    kart.rolling = true;
    kart.rollTimer = kart.isPlayer ? ITEM.rouletteSeconds : ITEM.aiRouletteSeconds;
    kart.rollItem = this.rollFor(kart, this._placeOf(kart));
    bus.emit('item:rollStart', { kart });
  }

  _finishRoll(kart) {
    const id = kart.rollItem || 'banana';
    kart.rolling = false;
    kart.rollTimer = 0;
    kart.rollItem = null;
    kart.item = id;
    kart.itemCount = ITEM_INFO[id].uses;
    if (id === 'golden_toot') kart.goldenTimer = 0;
    bus.emit('item:get', { kart, item: id });
    if (TRIPLE_TYPE[id]) this._deploy(kart, id);
    else {
      const p = this._pluginById.get(id);
      if (p && p.handler.onGet) this._call(p, 'onGet', kart);
    }
  }

  // ------------------------------------------------------------- use

  /** Activate the held item (no-op without an item or while the roulette spins). */
  useItem(kart) {
    if (!kart || !kart.item || kart.rolling || kart.itemCount <= 0) return false;
    if (kart.itemsLocked) return false;              // v5: Befana's soot locks the slot (kart.js sootTimer)
    const id = kart.item;
    let consume = true, first = true;
    switch (id) {
      case 'banana': this._dropHazard(kart, 'banana'); break;
      case 'stink': this._dropHazard(kart, 'stink'); break;
      case 'bouncer': this._launch(kart, 'bouncer'); break;
      case 'rocket': this._launch(kart, 'rocket'); break;
      case 'toot':
      case 'triple_toot': kart.applyBoost(BOOST.tootDuration, 'item'); this._boostDodge(kart); break;
      case 'star': kart.startStar(); this._washInk(kart); break;
      case 'zap': this._zap(kart); break;
      case 'triple_banana': if (!this._dropTrailing(kart)) return false; break;
      case 'triple_bouncer': if (!this._fireOrbiter(kart, 'bouncer')) return false; break;
      case 'triple_rocket': if (!this._fireOrbiter(kart, 'rocket')) return false; break;
      case 'capo': this._launchCapo(kart); break;
      case 'golden_toot': {
        const r = this._goldenPress(kart);
        if (!r) return false;
        first = r === 1;
        consume = false;
        break;
      }
      case 'meatball_bomb': this._throwBomb(kart); break;
      case 'espresso': this._espresso(kart); break;
      case 'accordion': this._accordion(kart); break;
      case 'beer_rocket': if (!this._startBeer(kart)) return false; consume = false; break;
      default: {
        // v5 plugin item: use() → true (one use consumed) | { consume, first } | false (ignored)
        const p = this._pluginById.get(id);
        if (!p || !p.handler.use) return false;
        const r = this._call(p, 'use', kart);
        if (!r) return false;
        if (typeof r === 'object') { consume = r.consume !== false; first = r.first !== false; }
        if (first && p.ctx.rule.cooldown > 0 && p.ctx.rule.cooldownFrom !== 'end') p.ctx.startCooldown();
        if (kart.item !== id) consume = false;          // the plugin already emptied / swapped the slot
        break;
      }
    }
    if (consume) {
      kart.itemCount--;
      if (kart.itemCount <= 0) { kart.item = null; kart.itemCount = 0; }
    }
    if (first) this.used[id] = (this.used[id] || 0) + 1;
    bus.emit('item:use', { kart, item: id, first });
    return true;
  }

  // An item boost pressed while a Capo Crusher winds up over this kart spares it.
  _boostDodge(kart) {
    for (const c of this.capos) if (c.target === kart && c.phase === 'windup') c.dodged = true;
  }

  // Golden Toot press: 0 = ignored (too soon), 1 = first press (window starts), 2 = another press.
  _goldenPress(kart) {
    const st = this._state(kart), now = this.time;
    if (now - st.goldenLast < ITEM.goldenPressGap) return 0;
    st.goldenLast = now;
    const first = !(kart.goldenTimer > 0);
    if (first) kart.goldenTimer = ITEM.goldenTime;
    kart.applyBoost(BOOST.tootDuration, 'item');
    this._boostDodge(kart);
    if (first) bus.emit('item:goldenStart', { kart });
    return first ? 1 : 2;
  }

  _dropHazard(kart, type, at = null) {
    const tr = this.track;
    const banana = type === 'banana';
    // recycle the oldest of this type when at the cap
    let count = 0, oldest = null;
    for (const h of this.hazards) {
      if (h.type !== type) continue;
      count++;
      if (!oldest || h.age > oldest.age) oldest = h;
    }
    if (count >= (banana ? T.maxBananas : T.maxStinks) && oldest) this._removeHazard(oldest, 'expire');

    const h = this._hazardPool.pop() || makeHazard();
    h.uid = ++this._uid;
    h.type = type;
    h.owner = kart;
    h.radius = banana ? ITEM.hazardRadius : ITEM.stinkRadius;
    h.life = banana ? T.bananaLife : ITEM.stinkLife;
    h.age = 0;
    h.hitMask = 0;
    h.wisp = 0;
    if (at) h.position.copy(at);
    else {
      const back = banana ? T.bananaBack : T.stinkBack;
      h.position.set(kart.position.x - Math.sin(kart.yaw) * back, kart.position.y, kart.position.z - Math.cos(kart.yaw) * back);
    }
    tr.project(h.position, kart.hint, h.proj);
    h.hint = h.proj.index;
    // keep it on the drivable surface, inside the walls
    const lim = 0.6;
    const lat = clamp(h.proj.lateral, -(h.proj.wallL - lim), h.proj.wallR - lim);
    if (lat !== h.proj.lateral) {
      tr.pointAt(h.proj.s, lat, h.position);
      tr.project(h.position, h.hint, h.proj);
    }
    h.position.y = h.proj.height;
    h.s = h.proj.s;
    h.lateral = h.proj.lateral;
    h.dropFrom = at ? 0.25 : Math.max(0, kart.position.y + 0.6 - h.position.y);   // visual drop height
    h.active = true;
    this.hazards.push(h);
    if (this.vis) this.vis.onHazardSpawn(h);
    return h;
  }

  _launch(kart, type) {
    const tr = this.track;
    if (this.projectiles.length >= T.maxProjectiles) {
      let oldest = this.projectiles[0];
      for (const p of this.projectiles) if (p.age > oldest.age) oldest = p;
      this._removeProjectile(oldest, 'expire');
    }
    const p = this._projPool.pop() || makeProjectile();
    p.uid = ++this._uid;
    p.type = type;
    p.owner = kart;
    p.age = 0;
    p.bounces = 0;
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
    p.dir.set(fx, 0, fz);
    p.position.set(kart.position.x + fx * T.launchAhead, kart.position.y, kart.position.z + fz * T.launchAhead);
    tr.project(p.position, kart.hint, p.proj);
    p.hint = p.proj.index;
    const r = type === 'bouncer' ? T.bouncerRadius : 0.5;
    const lat = clamp(p.proj.lateral, -(p.proj.wallL - r - 0.05), p.proj.wallR - r - 0.05);
    if (lat !== p.proj.lateral) {
      p.position.x += p.proj.right.x * (lat - p.proj.lateral);
      p.position.z += p.proj.right.z * (lat - p.proj.lateral);
      tr.project(p.position, p.hint, p.proj);
      p.hint = p.proj.index;
    }
    p.s = p.proj.s;
    p.lateral = p.proj.lateral;
    p.dist = kart.distance + T.launchAhead;
    if (type === 'bouncer') {
      p.speed = Math.max(ITEM.bouncerSpeed * this.ccMult, kart.speed + T.bouncerBoost * this.ccMult);
      p.life = ITEM.bouncerLife;
      p.mode = 'bounce';
      p.target = null;
      p.position.y = p.proj.height + T.bouncerRadius;
    } else {
      p.speed = Math.max(ITEM.rocketSpeed * this.ccMult, kart.speed + 16 * this.ccMult);
      p.life = ITEM.rocketLife;
      p.target = this._rocketTarget(kart);
      p.mode = p.target ? 'track' : 'straight';
      p.position.y = p.proj.height + T.rocketHeight;
    }
    p.prev.copy(p.position);
    p.active = true;
    this.projectiles.push(p);
    if (this.vis) this.vis.onProjectileSpawn(p);
    return p;
  }

  // The kart one place ahead (skipping finished karts); null when leading.
  _rocketTarget(kart) {
    const race = this.race;
    const place = this._placeOf(kart);
    if (place <= 1) return null;
    if (race && race.standings) {
      for (let i = place - 2; i >= 0; i--) {
        const k = race.standings[i];
        if (k && k !== kart && !k.finished) return k;
      }
      return null;
    }
    let best = null;
    for (const k of this.karts) {
      if (k === kart || k.finished || !(k.place > 0 && k.place < place)) continue;
      if (!best || k.place > best.place) best = k;
    }
    return best;
  }

  // The leading kart still racing (Capo Crusher target), or null.
  _leader() {
    const race = this.race;
    if (race && race.standings) {
      for (const k of race.standings) if (k && !k.finished) return k;
      return null;
    }
    let best = null;
    for (const k of this.karts) if (!k.finished && (!best || k.distance > best.distance)) best = k;
    return best;
  }

  _zap(user) {
    const place = this._placeOf(user);
    this._zapBlockedUntil = this._clock() + ITEM.zapCooldown;
    const victims = [];          // zaps are rare (cooldown): a fresh list listeners may keep
    for (const k of this.karts) {
      if (k === user || k.finished || k.frozen) continue;
      if (!(this._placeOf(k) < place) || k.isInvincible()) continue;
      if (k.zap()) {
        victims.push(k);
        bus.emit('item:hit', { kart: k, by: user, item: 'zap' });
        if (this.vis) this.vis.onZapVictim(k);
      }
    }
    bus.emit('item:zap', { kart: user, victims, count: victims.length });
    if (this.vis) this.vis.onZapUser(user);
  }

  _placeOf(kart) {
    if (this.race && this.race.getPlace) return this.race.getPlace(kart);
    return kart.place > 0 ? kart.place : this.karts.length;
  }

  // ------------------------------------------------------------- triples

  // Banana Bunch / Triple Bouncers / Triple Rockets: three items attach to the kart on pickup.
  _deploy(kart, id) {
    const type = TRIPLE_TYPE[id];
    this._clearAttached(kart, 'clear');
    const st = this._state(kart);
    st.orbitAngle = kart.yaw;
    if (type === 'banana') this._seedTrail(kart, st);
    for (let i = 0; i < 3; i++) {
      const a = this._attPool.pop() || makeAttached();
      a.uid = ++this._uid;
      a.type = type;
      a.owner = kart;
      a.slot = i;
      a.phase = (i / 3) * TAU;
      a.gap = ITEM.trailGaps[i] || 2 + i * 1.2;
      a.age = 0;
      a.active = true;
      a.hint = kart.hint;
      this.attached.push(a);
      this._placeAttached(a, st, 0);
      a.prev.copy(a.position);
      if (this.vis) this.vis.onAttach(a);
    }
    st.attached = 3;
    bus.emit('item:deploy', { kart, item: id });
  }

  // Breadcrumb trail for trailing peels, seeded straight behind the kart.
  _seedTrail(kart, st) {
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
    const n = T.trailPoints, tr = st.trail;
    for (let i = 0; i < n; i++) {
      // index (head - i) holds the point i + 1 steps behind the kart
      const j = ((n - i) % n) * 3;
      const d = (i + 1) * T.trailStep;
      tr[j] = kart.position.x - fx * d; tr[j + 1] = kart.position.y; tr[j + 2] = kart.position.z - fz * d;
    }
    st.trailHead = 0;
    st.trailN = n;
  }

  _recordTrail(kart, st) {
    const tr = st.trail, h = st.trailHead * 3;
    const p = kart.position;
    const dx = p.x - tr[h], dz = p.z - tr[h + 2];
    const d2 = dx * dx + dz * dz;
    if (d2 < T.trailStep * T.trailStep) return;
    if (d2 > 64) { this._seedTrail(kart, st); return; }        // teleported (respawn): start a fresh trail
    st.trailHead = (st.trailHead + 1) % T.trailPoints;
    const j = st.trailHead * 3;
    tr[j] = p.x; tr[j + 1] = p.y; tr[j + 2] = p.z;
    if (st.trailN < T.trailPoints) st.trailN++;
  }

  // Point `gap` m behind the kart along its breadcrumb trail.
  _trailPoint(kart, st, gap, out) {
    const tr = st.trail, n = T.trailPoints;
    let ax = kart.position.x, ay = kart.position.y, az = kart.position.z;
    let left = gap;
    for (let i = 0; i < st.trailN; i++) {
      const j = ((st.trailHead - i + n) % n) * 3;
      const bx = tr[j], by = tr[j + 1], bz = tr[j + 2];
      const seg = Math.hypot(bx - ax, bz - az);
      if (seg >= left && seg > 1e-6) {
        const u = left / seg;
        return out.set(ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u);
      }
      left -= seg;
      ax = bx; ay = by; az = bz;
    }
    // trail too short: continue straight back from its end
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
    return out.set(ax - fx * left, ay, az - fz * left);
  }

  _placeAttached(a, st, dt) {
    const k = a.owner, tr = this.track;
    if (a.type === 'banana') {
      this._trailPoint(k, st, a.gap, a.position);
      tr.project(a.position, a.hint, a.proj);
      a.hint = a.proj.index;
      const lim = 0.6;
      const lat = clamp(a.proj.lateral, -(a.proj.wallL - lim), a.proj.wallR - lim);
      if (lat !== a.proj.lateral) {
        a.position.x += a.proj.right.x * (lat - a.proj.lateral);
        a.position.z += a.proj.right.z * (lat - a.proj.lateral);
        a.proj.lateral = lat;
      }
      a.position.y = a.proj.height;
    } else {
      const th = st.orbitAngle + a.phase;
      a.position.set(k.position.x + Math.sin(th) * ITEM.orbitRadius, k.position.y + ITEM.orbitHeight, k.position.z + Math.cos(th) * ITEM.orbitRadius);
      if (dt > 0 || a.proj.s === undefined) { tr.project(a.position, a.hint, a.proj); a.hint = a.proj.index; }
    }
  }

  _attachedOf(kart, type = null) {
    let best = null;
    for (const a of this.attached) if (a.owner === kart && (!type || a.type === type)) { best = a; break; }
    return best;
  }

  // One attached item consumed (fired, dropped, hit something, destroyed).
  _detach(a, reason) {
    if (!a.active) return;
    a.active = false;
    const i = this.attached.indexOf(a);
    if (i >= 0) { this.attached[i] = this.attached[this.attached.length - 1]; this.attached.pop(); }
    const k = a.owner, st = this._st.get(k);
    if (st) st.attached = Math.max(0, st.attached - 1);
    if (k && TRIPLE_TYPE[k.item] === a.type && reason !== 'clear') {
      k.itemCount = Math.max(0, k.itemCount - (reason === 'use' ? 0 : 1));   // 'use': useItem counts it
      if (k.itemCount <= 0) { k.item = null; k.itemCount = 0; }
    }
    if (this.vis) this.vis.onAttachRemove(a, reason);
    a.owner = null;
    this._attPool.push(a);
  }

  _clearAttached(kart, reason) {
    for (let i = this.attached.length - 1; i >= 0; i--) {
      const a = this.attached[i];
      if (a && a.owner === kart) this._detach(a, reason);
    }
  }

  // Owner hit: orbiters are lost, trailing peels drop on the road as plain bananas.
  _releaseAttached(kart) {
    for (let i = this.attached.length - 1; i >= 0; i--) {
      const a = this.attached[i];
      if (!a || a.owner !== kart) continue;
      if (a.type === 'banana') {
        const h = this._dropHazard(kart, 'banana', a.position);
        h.age = T.bananaOwnerGrace;          // the owner can hit its own dropped bunch
      }
      this._detach(a, a.type === 'banana' ? 'drop' : 'lost');
    }
    if (TRIPLE_TYPE[kart.item]) { kart.item = null; kart.itemCount = 0; }
  }

  // Banana Bunch press: the rearmost peel stays on the road.
  _dropTrailing(kart) {
    let rear = null;
    for (const a of this.attached) if (a.owner === kart && a.type === 'banana' && (!rear || a.gap > rear.gap)) rear = a;
    if (!rear) { kart.item = null; kart.itemCount = 0; return false; }
    this._dropHazard(kart, 'banana', rear.position);
    this._detach(rear, 'use');
    return true;
  }

  // Triple Bouncers / Rockets press: the orbiter nearest the nose is fired.
  _fireOrbiter(kart, type) {
    const st = this._state(kart);
    let best = null, bd = Infinity;
    for (const a of this.attached) {
      if (a.owner !== kart || a.type !== type) continue;
      const d = Math.abs(angleDiff(kart.yaw, st.orbitAngle + a.phase));
      if (d < bd) { bd = d; best = a; }
    }
    if (!best) { kart.item = null; kart.itemCount = 0; return false; }
    this._detach(best, 'use');
    this._launch(kart, type);
    return true;
  }

  _updateAttached(dt) {
    if (!this.attached.length) return;
    // move: orbit angle per kart, breadcrumbs for the peels
    for (const k of this.karts) {
      const st = this._st.get(k);
      if (!st || st.attached <= 0) continue;
      st.orbitAngle = wrapAngle(st.orbitAngle + ITEM.orbitSpeed * dt);
      this._recordTrail(k, st);
    }
    const karts = this.karts;
    for (let i = this.attached.length - 1; i >= 0; i--) {
      const a = this.attached[i];
      if (!a || !a.active) continue;
      a.age += dt;
      a.prev.copy(a.position);
      this._placeAttached(a, this._st.get(a.owner), dt);
      const ap = a.position;
      const orbiter = a.type !== 'banana';
      const rk = KART.radius + (orbiter ? ITEM.orbitHitRadius : ITEM.hazardRadius * 0.6);
      let gone = false;
      // rival karts touching it
      for (const k of karts) {
        if (k === a.owner) continue;
        const dx = k.position.x - ap.x, dz = k.position.z - ap.z;
        if (dx * dx + dz * dz > rk * rk) continue;
        if (Math.abs(k.position.y + (orbiter ? 0.5 : 0) - ap.y) > T.attachedHitDy) continue;
        if (k.isInvincible()) { this._detach(a, 'smash'); gone = true; break; }
        const hit = orbiter ? k.tumble(a.type) : k.spinOut('banana');
        if (hit) {
          bus.emit('item:hit', { kart: k, by: a.owner, item: a.type, attached: a });
          this._detach(a, 'hit');
          gone = true;
          break;
        }
      }
      if (gone) continue;
      // projectiles (not the owner's) touching it: both destroyed
      const rp = ITEM.projectileRadius + (orbiter ? ITEM.orbitHitRadius : 0.5);
      for (let j = this.projectiles.length - 1; j >= 0; j--) {
        const p = this.projectiles[j];
        if (!p.active || p.owner === a.owner) continue;
        const dx = p.position.x - ap.x, dz = p.position.z - ap.z;
        if (dx * dx + dz * dz > rp * rp || Math.abs(p.position.y - ap.y) > 1.5) continue;
        bus.emit('item:blocked', { kart: a.owner, item: p.type, by: p.owner });
        this._removeProjectile(p, 'blocked');
        this._detach(a, 'blocked');
        gone = true;
        break;
      }
      if (gone || !orbiter) continue;
      // orbiters clear banana peels they sweep over
      const rb = ITEM.orbitHitRadius + T.bananaBlockRadius;
      for (let j = this.hazards.length - 1; j >= 0; j--) {
        const h = this.hazards[j];
        if (h.type !== 'banana' || (h.owner === a.owner && h.age < T.bananaOwnerGrace)) continue;
        const dx = h.position.x - ap.x, dz = h.position.z - ap.z;
        if (dx * dx + dz * dz > rb * rb || Math.abs(h.position.y + 0.4 - ap.y) > 1.5) continue;
        this._removeHazard(h, 'blocked');
        bus.emit('item:blocked', { kart: a.owner, item: a.type });
        this._detach(a, 'blocked');
        break;
      }
    }
  }

  // ------------------------------------------------------------- capo crusher

  _launchCapo(kart) {
    const tr = this.track;
    const c = this._capoPool.pop() || makeCapo();
    c.uid = ++this._uid;
    c.owner = kart;
    c.age = 0;
    c.phaseT = 0;
    c.dodged = false;
    c.locked = false;
    c.s = tr.wrapS(kart.proj.s + T.launchAhead);
    c.lateral = clamp(kart.proj.lateral || 0, -6, 6);
    c.dist = kart.distance + T.launchAhead;
    c.startDist = c.dist;
    c.speed = ITEM.capoSpeed * this.ccMult;
    tr.pointAt(c.s, c.lateral, c.position);
    c.position.y += ITEM.capoHeight;
    c.prev.copy(c.position);
    c.dir.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw));
    c.target = this._leader() || kart;
    c.phase = 'ground';
    c.active = true;
    this.capos.push(c);
    if (this.vis) this.vis.onCapoSpawn(c);
    bus.emit('item:capoLaunch', { kart, target: c.target });
    bus.emit('item:capoWarning', { target: c.target, kart, locked: false });
    // the shooter took the lead since the pickup (or the leader is behind it): straight at it
    if (c.target === kart || c.target.distance < c.dist) this._capoLock(c);
    return c;
  }

  _capoLock(c) {
    c.locked = true;
    c.phase = 'rise';
    c.phaseT = 0;
    c.from.copy(c.position);
    const tp = c.target.position;
    c.angle = Math.atan2(c.position.x - tp.x, c.position.z - tp.z);
    const d = Math.hypot(c.position.x - tp.x, c.position.y - tp.y, c.position.z - tp.z);
    c.riseTime = clamp(d / T.capoRiseSpeed, T.capoRiseMin, T.capoRiseMax);
    bus.emit('item:capoWarning', { target: c.target, kart: c.owner, locked: true });
  }

  _updateCapos(dt) {
    const L = this.track.length;
    for (let i = this.capos.length - 1; i >= 0; i--) {
      const c = this.capos[i];
      if (!c.active) continue;
      c.age += dt;
      c.phaseT += dt;
      c.prev.copy(c.position);
      if (c.age > ITEM.capoLife || c.dist - c.startDist > ITEM.capoMaxLaps * L) { this._removeCapo(c, 'fizzle'); continue; }
      if (c.phase === 'ground') {
        const lead = this._leader();
        if (!lead) { this._removeCapo(c, 'fizzle'); continue; }
        if (lead !== c.target) {
          c.target = lead;
          bus.emit('item:capoWarning', { target: lead, kart: c.owner, locked: false });
        }
        this._stepCapoGround(c, dt);
        if (!c.active) continue;
        if (c.target === c.owner || c.target.distance - c.dist <= ITEM.capoLockRange) this._capoLock(c);
        continue;
      }
      const tgt = c.target;
      if (!tgt || tgt.finished) { this._removeCapo(c, 'fizzle'); continue; }
      const tp = tgt.position, R = ITEM.capoOrbitRadius, H = ITEM.capoHover;
      if (c.phase === 'rise') {
        const u = clamp(c.phaseT / c.riseTime, 0, 1);
        const e = u * u * (3 - 2 * u);
        const hx = tp.x + Math.sin(c.angle) * R, hy = tp.y + H, hz = tp.z + Math.cos(c.angle) * R;
        c.position.set(c.from.x + (hx - c.from.x) * e, c.from.y + (hy - c.from.y) * e + Math.sin(u * Math.PI) * 1.5, c.from.z + (hz - c.from.z) * e);
        if (u >= 1) { c.phase = 'orbit'; c.phaseT = 0; }
      } else if (c.phase === 'orbit') {
        c.angle += ((2 * TAU) / ITEM.capoOrbitTime) * dt;
        c.position.set(tp.x + Math.sin(c.angle) * R, tp.y + H, tp.z + Math.cos(c.angle) * R);
        if (c.phaseT >= ITEM.capoOrbitTime) { c.phase = 'windup'; c.phaseT = 0; c.from.set(Math.sin(c.angle) * R, H, Math.cos(c.angle) * R); }
      } else if (c.phase === 'windup') {
        // pull in over the target and rear back: the boost-dodge window
        const u = clamp(c.phaseT / ITEM.capoWindup, 0, 1);
        const k = 1 - u * u;
        c.position.set(tp.x + c.from.x * k, tp.y + H + 1.2 * Math.sin(u * Math.PI * 0.5), tp.z + c.from.z * k);
        if (c.phaseT >= ITEM.capoWindup) { c.phase = 'dive'; c.phaseT = 0; c.from.set(0, H + 1.2, 0); }
      } else if (c.phase === 'dive') {
        const u = clamp(c.phaseT / ITEM.capoDive, 0, 1);
        c.position.set(tp.x, tp.y + 0.5 + (c.from.y - 0.5) * (1 - u * u), tp.z);
        if (u >= 1) { this._capoBlast(c); continue; }
      }
      const dx = c.position.x - c.prev.x, dz = c.position.z - c.prev.z, dl = Math.hypot(dx, dz);
      if (dl > 1e-4) { c.dir.x = dx / dl; c.dir.z = dz / dl; }
    }
    // the target's HUD siren: 1 incoming, 2 locked on
    for (const k of this.karts) k.capoWarn = 0;
    for (const c of this.capos) if (c.active && c.target) c.target.capoWarn = Math.max(c.target.capoWarn || 0, c.locked ? 2 : 1);
  }

  // Ground run along the centre line, tumbling karts in its path (it ignores hazards).
  _stepCapoGround(c, dt) {
    const tr = this.track, tgt = c.target;
    const tSpeed = tgt ? Math.hypot(tgt.velocity.x, tgt.velocity.z) : 0;
    c.speed = Math.max(ITEM.capoSpeed * this.ccMult, tSpeed + ITEM.capoMinClosing);
    const f = tr.frameAt(c.s, this._frame);
    const corr = clamp(1 - f.curvature * c.lateral, 0.55, 1.6);
    const ds = (c.speed * dt) / corr;
    c.s = tr.wrapS(c.s + ds);
    c.dist += ds;
    c.lateral = approach(c.lateral, 0, T.capoLateralRate * dt);
    tr.pointAt(c.s, c.lateral, c.position);
    c.position.y += ITEM.capoHeight;
    const dx = c.position.x - c.prev.x, dz = c.position.z - c.prev.z, dl = Math.hypot(dx, dz);
    if (dl > 1e-4) { c.dir.x = dx / dl; c.dir.z = dz / dl; }
    const rr = ITEM.capoHitRadius;
    for (const k of this.karts) {
      if (k === tgt || (k === c.owner && c.age < T.capoOwnerGrace)) continue;
      const kx = k.position.x - c.position.x, kz = k.position.z - c.position.z;
      if (kx * kx + kz * kz > rr * rr || Math.abs(k.position.y + 0.5 - c.position.y) > T.capoHitDy) continue;
      if (k.tumble('capo')) bus.emit('item:hit', { kart: k, by: c.owner, item: 'capo', capo: c });
    }
  }

  _capoBlast(c) {
    const tgt = c.target;
    const at = this._v2.copy(tgt.position);
    let hitTarget = false;
    if (!c.dodged && !tgt.finished && tgt.tumble('capo')) {
      tgt.tumbleTimer = Math.max(tgt.tumbleTimer, HIT.capoTumble);
      tgt.velocity.x *= HIT.capoSpeedKeep;
      tgt.velocity.z *= HIT.capoSpeedKeep;
      hitTarget = true;
      bus.emit('item:hit', { kart: tgt, by: c.owner, item: 'capo', capo: c });
    }
    const R = ITEM.capoBlastRadius;
    for (const k of this.karts) {
      if (k === tgt || k.finished) continue;
      const dx = k.position.x - at.x, dy = k.position.y - at.y, dz = k.position.z - at.z;
      if (dx * dx + dy * dy + dz * dz > R * R) continue;
      if (k.spinOut('capo')) bus.emit('item:hit', { kart: k, by: c.owner, item: 'capo', capo: c });
    }
    this._clearAround(at, R, c.owner, true);
    bus.emit('item:capoHit', { kart: tgt, by: c.owner, position: at, dodged: c.dodged, hit: hitTarget });
    bus.emit('item:explode', { position: at, hit: hitTarget, kart: tgt, item: 'capo' });
    this._removeCapo(c, 'blast');
  }

  _removeCapo(c, reason) {
    if (!c.active) return;
    c.active = false;
    const i = this.capos.indexOf(c);
    if (i >= 0) { this.capos[i] = this.capos[this.capos.length - 1]; this.capos.pop(); }
    if (reason !== 'clear') {
      this._capoBlockedUntil = this._clock() + ITEM.capoCooldown;
      if (reason !== 'blast') bus.emit('item:capoFizzle', { position: c.position, reason });
    }
    if (c.target) c.target.capoWarn = 0;
    if (this.vis) this.vis.onCapoRemove(c, reason);
    c.owner = null;
    c.target = null;
    this._capoPool.push(c);
  }

  // Destroy projectiles, road hazards and bombs (not exploding them) around a
  // point, and the plugins' entities / clearAround hooks (kind: 'blast' | ...).
  _clearAround(at, R, by, keepStink = false, kind = 'blast') {
    if (this.entities.length || this._hk.clearAround.length) this._clearPlugins(at, R, by, kind);
    const R2 = R * R;
    for (let j = this.projectiles.length - 1; j >= 0; j--) {
      const p = this.projectiles[j];
      if (!p.active || p.position.distanceToSquared(at) > R2) continue;
      this._removeProjectile(p, 'blocked');
    }
    for (let j = this.hazards.length - 1; j >= 0; j--) {
      const h = this.hazards[j];
      if (keepStink && h.type === 'stink') continue;
      if (h.position.distanceToSquared(at) > R2) continue;
      this._removeHazard(h, 'blocked');
    }
    for (let j = this.bombs.length - 1; j >= 0; j--) {
      const b = this.bombs[j];
      if (b.active && b.position.distanceToSquared(at) <= R2) this._removeBomb(b, 'blocked');
    }
  }

  // ------------------------------------------------------------- meatball bomb

  _throwBomb(kart) {
    const tr = this.track;
    if (this.bombs.length >= T.maxBombs) {
      let oldest = this.bombs[0];
      for (const x of this.bombs) if (x.age > oldest.age) oldest = x;
      this._explodeBomb(oldest);
    }
    const b = this._bombPool.pop() || makeBomb();
    b.uid = ++this._uid;
    b.owner = kart;
    b.age = 0;
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
    const back = (kart.input.brake || 0) > 0.5;        // brake held: drop it behind
    if (back) {
      b.position.set(kart.position.x - fx * T.bombBack, kart.position.y, kart.position.z - fz * T.bombBack);
      b.vel.set(0, 0, 0);
      b.phase = 'rest';
      b.fuse = ITEM.bombDropFuse;
    } else {
      b.position.set(kart.position.x + fx * T.launchAhead, kart.position.y + 0.9, kart.position.z + fz * T.launchAhead);
      const hs = Math.max(0, kart.speed) + ITEM.bombThrowSpeed * this.ccMult;
      b.vel.set(fx * hs, ITEM.bombThrowUp, fz * hs);
      b.phase = 'air';
      b.fuse = -1;                                       // lit on landing
    }
    tr.project(b.position, kart.hint, b.proj);
    b.hint = b.proj.index;
    if (back) { this._bombInside(b); b.position.y = b.proj.height + T.bombRadius; }
    b.prev.copy(b.position);
    b.active = true;
    b.dropped = back;
    this.bombs.push(b);
    if (this.vis) this.vis.onBombSpawn(b);
    return b;
  }

  // Keep a bomb inside the walls (removing the velocity into the wall).
  _bombInside(b) {
    const pr = b.proj, r = T.bombRadius + 0.1;
    const lat = clamp(pr.lateral, -(pr.wallL - r), pr.wallR - r);
    if (lat === pr.lateral) return;
    const d = lat - pr.lateral;
    b.position.x += pr.right.x * d;
    b.position.z += pr.right.z * d;
    pr.lateral = lat;
    const vn = b.vel.x * pr.right.x + b.vel.z * pr.right.z;
    if (vn * d < 0) { b.vel.x -= pr.right.x * vn * 1.3; b.vel.z -= pr.right.z * vn * 1.3; }
  }

  _updateBombs(dt) {
    const tr = this.track, g = KART.gravity;
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      if (!b || !b.active) continue;
      b.age += dt;
      b.prev.copy(b.position);
      if (b.phase === 'air') {
        b.vel.y -= g * dt;
        b.position.x += b.vel.x * dt; b.position.y += b.vel.y * dt; b.position.z += b.vel.z * dt;
        tr.project(b.position, b.hint, b.proj); b.hint = b.proj.index;
        this._bombInside(b);
        if (b.position.y <= b.proj.height + T.bombRadius && b.vel.y < 0) {
          b.position.y = b.proj.height + T.bombRadius;
          b.vel.y = 0;
          b.vel.x *= T.bombLandKeep; b.vel.z *= T.bombLandKeep;     // a soft meatball: it thuds down and rolls a little
          b.phase = 'roll';
          b.fuse = ITEM.bombFuse;
          if (this.vis) this.vis.onBombLand(b);
        }
      } else if (b.phase === 'roll') {
        const hs = Math.hypot(b.vel.x, b.vel.z);
        const ns = Math.max(0, hs - ITEM.bombRollDecel * dt);
        if (hs > 1e-6) { b.vel.x *= ns / hs; b.vel.z *= ns / hs; }
        b.position.x += b.vel.x * dt; b.position.z += b.vel.z * dt;
        tr.project(b.position, b.hint, b.proj); b.hint = b.proj.index;
        this._bombInside(b);
        b.position.y = b.proj.height + T.bombRadius;
        if (ns < 0.05) { b.phase = 'rest'; b.vel.set(0, 0, 0); }
      } else {
        tr.project(b.position, b.hint, b.proj); b.hint = b.proj.index;
        b.position.y = b.proj.height + T.bombRadius;
      }
      b.s = b.proj.s; b.lateral = b.proj.lateral;
      if (b.fuse >= 0) { b.fuse -= dt; if (b.fuse <= 0) { this._explodeBomb(b); continue; } }
      if (b.age >= ITEM.bombLife) { this._explodeBomb(b); continue; }
      // contact: any kart (its thrower after a grace), any projectile or orbiter
      const rr = ITEM.bombTriggerRadius;
      let boom = false;
      for (const k of this.karts) {
        if (k === b.owner && b.age < ITEM.bombOwnerGrace) continue;
        const dx = k.position.x - b.position.x, dz = k.position.z - b.position.z;
        if (dx * dx + dz * dz <= rr * rr && Math.abs(k.position.y + 0.4 - b.position.y) <= T.bombHitDy) { boom = true; break; }
      }
      if (!boom) {
        const rp = ITEM.projectileRadius + T.bombRadius + 0.3;
        for (const p of this.projectiles) {
          if (p.active && p.position.distanceToSquared(b.position) <= rp * rp) { this._removeProjectile(p, 'blocked'); boom = true; break; }
        }
      }
      if (!boom) {
        const ro = ITEM.orbitHitRadius + T.bombRadius + 0.2;
        for (const a of this.attached) {
          if (a.active && a.type !== 'banana' && a.position.distanceToSquared(b.position) <= ro * ro) { this._detach(a, 'blocked'); boom = true; break; }
        }
      }
      if (!boom && this.entities.length) {
        // solid plugin entities set it off too (sturdy ones survive the touch)
        for (const e of this.entities) {
          if (!e.active || !e.solid) continue;
          const re = e.radius + T.bombRadius + 0.3;
          if (e.position.distanceToSquared(b.position) <= re * re) { if (!e.sturdy) this._removeEntity(e, 'blocked'); boom = true; break; }
        }
      }
      if (boom) this._explodeBomb(b);
    }
  }

  _explodeBomb(b) {
    if (!b.active) return;
    const at = this._v2.copy(b.position);
    this._removeBomb(b, 'explode');
    const core = ITEM.bombCoreRadius, R = ITEM.bombBlastRadius;
    let hits = 0;
    for (const k of this.karts) {
      if (k.finished && !k.isPlayer) continue;
      const dx = k.position.x - at.x, dy = k.position.y + 0.4 - at.y, dz = k.position.z - at.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > R * R || Math.abs(dy) > 3.5) continue;
      const ok = d2 <= core * core ? k.tumble('bomb') : k.spinOut('bomb');
      if (ok) { hits++; bus.emit('item:hit', { kart: k, by: b.owner, item: 'meatball_bomb' }); }
    }
    // the blast clears projectiles and peels; other bombs in it go off too (chain)
    const R2 = R * R;
    for (let j = this.projectiles.length - 1; j >= 0; j--) {
      const p = this.projectiles[j];
      if (p.active && p.position.distanceToSquared(at) <= R2) this._removeProjectile(p, 'blocked');
    }
    for (let j = this.hazards.length - 1; j >= 0; j--) {
      const h = this.hazards[j];
      if (h.type === 'banana' && h.position.distanceToSquared(at) <= R2) this._removeHazard(h, 'blocked');
    }
    for (const o of this.bombs) if (o.active && o.position.distanceToSquared(at) <= R2) o.fuse = Math.min(o.fuse >= 0 ? o.fuse : 1, 0.08);
    if (this.entities.length || this._hk.clearAround.length) this._clearPlugins(at, R, b.owner, 'bomb');
    bus.emit('item:bombExplode', { position: at, kart: b.owner, hits });
    bus.emit('item:explode', { position: at, hit: hits > 0, kart: null, item: 'meatball_bomb' });
    if (this.vis) this.vis.onBlast(at, 'bomb');
  }

  _removeBomb(b, reason) {
    if (!b.active) return;
    b.active = false;
    const i = this.bombs.indexOf(b);
    if (i >= 0) { this.bombs[i] = this.bombs[this.bombs.length - 1]; this.bombs.pop(); }
    if (this.vis) this.vis.onBombRemove(b, reason);
    b.owner = null;
    this._bombPool.push(b);
  }

  // ------------------------------------------------------------- espresso splash

  _espresso(user) {
    const place = this._placeOf(user);
    this._espressoBlockedUntil = this._clock() + ITEM.espressoCooldown;
    const victims = [];
    for (const k of this.karts) {
      if (k === user || k.finished || k.frozen) continue;
      if (!(this._placeOf(k) < place) || k.isInvincible()) continue;
      const st = this._state(k);
      st.inkAge = 0;
      st.inkLanded = false;
      st.inkWash = false;
      st.inkBy = user;
      k.inkIncoming = true;
      victims.push(k);
      if (this.vis) this.vis.onEspressoCup(k, user);
    }
    bus.emit('item:espresso', { kart: user, victims, count: victims.length });
  }

  _washInk(kart) {
    const st = this._st.get(kart);
    if (st && st.inkAge >= 0) st.inkWash = true;
  }

  // Coffee on a victim's screen: 0.6 s flight, then 3 s full + 1.5 s fade (a
  // boost / star / beer washes it off early). While it's on: a little slower
  // and a lighter touch on the wheel (CPUs also wobble, ai.js).
  _updateInk(k, st, dt) {
    if (st.inkAge < 0) { k.ink = 0; k.inkIncoming = false; return; }
    st.inkAge += dt;
    const D = ITEM.espressoDelay, end = D + ITEM.espressoTime;
    if (st.inkAge < D) { k.ink = 0; k.inkIncoming = true; return; }
    k.inkIncoming = false;
    if (!st.inkLanded) {
      st.inkLanded = true;
      st.inkWash = false;
      if (k.isInvincible() || k.finished) { st.inkAge = -1; k.ink = 0; return; }
      bus.emit('item:espressoSplash', { kart: k, by: st.inkBy });
      if (this.vis) this.vis.onEspressoSplash(k);
    }
    if (st.inkWash || k.isInvincible()) {
      st.inkWash = false;
      st.inkAge = Math.max(st.inkAge, end - T.inkWashLeft);
    }
    const left = end - st.inkAge;
    if (left <= 0) { st.inkAge = -1; st.inkBy = null; k.ink = 0; return; }
    k.ink = Math.min(1, left / ITEM.espressoFade);
    // a touch slower (max speed x espressoSpeedMult)
    const cap = k.maxSpeed * ITEM.espressoSpeedMult;
    const hs = Math.hypot(k.velocity.x, k.velocity.z);
    if (hs > cap && hs > 1e-3 && !k.frozen) { k.velocity.x *= cap / hs; k.velocity.z *= cap / hs; }
  }

  // ------------------------------------------------------------- accordion blast

  _accordion(user) {
    const p = user.position;
    let hits = 0;
    const rk = ITEM.accordionKartRadius;
    for (const k of this.karts) {
      if (k === user || k.finished) continue;
      const dx = k.position.x - p.x, dz = k.position.z - p.z;
      if (dx * dx + dz * dz > rk * rk || Math.abs(k.position.y - p.y) > 3) continue;
      if (!k.isInvincible() && k.spinOut('accordion')) { hits++; bus.emit('item:hit', { kart: k, by: user, item: 'accordion' }); }
    }
    // every item within accordionItemRadius (3D) is destroyed — a Capo Crusher in any phase too
    const R = ITEM.accordionItemRadius, R2 = R * R;
    const at = this._v.set(p.x, p.y + 0.8, p.z);
    let blocked = 0;
    for (let j = this.capos.length - 1; j >= 0; j--) {
      const c = this.capos[j];
      if (c.active && c.position.distanceToSquared(at) <= R2) { blocked++; bus.emit('item:blocked', { kart: user, item: 'capo', by: c.owner }); this._removeCapo(c, 'blocked'); }
    }
    for (let j = this.projectiles.length - 1; j >= 0; j--) {
      const q = this.projectiles[j];
      if (q.active && q.owner !== user && q.position.distanceToSquared(at) <= R2) { blocked++; this._removeProjectile(q, 'blocked'); }
    }
    for (let j = this.hazards.length - 1; j >= 0; j--) {
      const h = this.hazards[j];
      if (h.position.distanceToSquared(at) <= R2) { blocked++; this._removeHazard(h, 'blocked'); }
    }
    for (let j = this.bombs.length - 1; j >= 0; j--) {
      const b = this.bombs[j];
      if (b.active && b.position.distanceToSquared(at) <= R2) { blocked++; this._removeBomb(b, 'blocked'); }
    }
    for (let j = this.attached.length - 1; j >= 0; j--) {
      const a = this.attached[j];
      if (a && a.active && a.owner !== user && a.position.distanceToSquared(at) <= R2) { blocked++; this._detach(a, 'blocked'); }
    }
    if (this.entities.length || this._hk.clearAround.length) blocked += this._clearPlugins(at, R, user, 'accordion');
    if (blocked) bus.emit('item:blocked', { kart: user, item: 'accordion', count: blocked });
    bus.emit('item:accordion', { kart: user, hits, blocked });
    if (this.vis) this.vis.onAccordion(user);
  }

  // ------------------------------------------------------------- beer rocket

  _startBeer(kart) {
    const st = this._state(kart);
    if (st.beer) return false;
    const place = this._placeOf(kart);
    st.beer = kart.beer = { phase: 'chug', t: 0, total: 0, startPlace: place, gained: 0, offset: 0 };
    st.realStar = kart.starTimer > 0 ? kart.starTimer : 0;   // a running star keeps its remainder
    kart.slowTimer = 0;
    kart.starTimer = Math.max(kart.starTimer, 0.3);
    this._clearAttached(kart, 'clear');
    if (st.inkAge >= 0) st.inkWash = true;
    bus.emit('item:beerStart', { kart });
    if (this.vis) this.vis.onBeer(kart, 'start');
    return true;
  }

  // The rider's substep (before kart.update): invincible, autopilot, speed, end rule.
  _updateBeer(k, st, dt) {
    const b = st.beer;
    b.t += dt;
    b.total += dt;
    if (st.realStar > 0) {
      st.realStar -= dt;
      if (st.realStar <= 0) { st.realStar = 0; bus.emit('kart:starEnd', { kart: k }); }
    }
    k.starTimer = Math.max(k.starTimer, 0.25);
    k.slowTimer = 0;
    if (b.phase === 'chug' && b.t >= ITEM.beerChug) {
      b.phase = 'ride';
      b.t = 0;
      k.boostTimer = 0;
      k.applyBoost(0.3, 'beer', this._beerMult(k));
      bus.emit('item:beerRide', { kart: k });
      if (this.vis) this.vis.onBeer(k, 'ride');
    }
    if (b.phase === 'ride') {
      k.boostMult = this._beerMult(k);
      k.boostTimer = Math.max(k.boostTimer, 0.25);
      k.boostSource = 'beer';
      const place = this._placeOf(k);
      b.gained = Math.max(0, b.startPlace - place);
      const need = Math.max(0, Math.min(ITEM.beerPlaces, b.startPlace - 1));
      const done = (b.t >= ITEM.beerMinTime && (b.gained >= need || place <= 1)) || b.t >= ITEM.beerMaxTime;
      if (k.finished || b.t >= ITEM.beerHardMax || (done && this._beerCanExit(k))) { this._endBeer(k, st); return; }
      // karts it touches are knocked over (a starred kart is only pushed aside, kart.js)
      const rr = ITEM.beerKnockRadius;
      for (const o of this.karts) {
        if (o === k) continue;
        const dx = o.position.x - k.position.x, dz = o.position.z - k.position.z;
        if (dx * dx + dz * dz > rr * rr || Math.abs(o.position.y - k.position.y) > T.beerKnockDy) continue;
        if (!o.isInvincible() && o.tumble('beer')) bus.emit('item:hit', { kart: o, by: k, item: 'beer_rocket' });
      }
    }
    this._beerSteer(k, st, b, dt);
  }

  // Boost multiplier that makes the rider's maxSpeed = beerSpeedMult x its top speed
  // (kart.maxSpeed = topSpeed x speedMult x boostMult x starSpeedMult).
  _beerMult(k) {
    return ITEM.beerSpeedMult / (KART.starSpeedMult * Math.max(0.3, k.speedMult || 1));
  }

  // Pure pursuit on the racing line (+ the driver's wheel as a lateral offset):
  // heading and velocity are set directly, so kart.update just integrates.
  _beerSteer(k, st, b, dt) {
    const tr = this.track, inp = k.input, pr = k.proj;
    const raw = k.isPlayer ? clamp(+st.steerIn || 0, -1, 1) : 0;
    b.offset = damp(b.offset, raw * ITEM.beerSteer, T.beerOffsetRate, dt);
    const hs = Math.hypot(k.velocity.x, k.velocity.z);
    const s = pr && Number.isFinite(pr.s) ? pr.s : 0;
    const f = tr.frameAt(s + T.beerLookBase + T.beerLookGain * hs, this._frame);
    const lim = Math.max(0, f.halfWidth - T.beerEdge);
    const lat = clamp((f.racingLine || 0) + b.offset, -lim, lim);
    const pt = tr.pointAt(f.s, lat, this._v);
    const want = Math.atan2(pt.x - k.position.x, pt.z - k.position.z);
    const maxTurn = (b.phase === 'chug' ? T.beerChugYawRate : T.beerYawRate) * dt;
    const dyaw = clamp(angleDiff(k.yaw, want), -maxTurn, maxTurn);
    k.yaw = wrapAngle(k.yaw + dyaw);
    k.yawRate = 0;
    if (hs > 1e-3) { k.velocity.x = Math.sin(k.yaw) * hs; k.velocity.z = Math.cos(k.yaw) * hs; }
    b.turn = dt > 0 ? dyaw / dt : 0;           // for the views (lean)
    inp.throttle = 1;
    inp.brake = 0;
    inp.drift = false;
    inp.steer = 0;
    st.steerOut = 0;
  }

  _beerCanExit(k) {
    if (!k.grounded) return false;
    const tr = this.track, s = k.proj.s;
    if (Math.abs(k.proj.lateral) > k.proj.halfWidth) return false;
    for (let d = 0; d <= T.beerStraight; d += 2.5) if (Math.abs(tr.curv[tr.indexAt(s + d)]) > T.beerStraightCurv) return false;
    return true;
  }

  _endBeer(k, st, quiet = false) {
    const b = st.beer;
    st.beer = null;
    k.beer = null;
    k.starTimer = st.realStar > 0 ? st.realStar : 0;
    st.realStar = 0;
    k.boostTimer = 0;              // drop the beer multiplier before the exit boost
    if (!quiet) {
      k.applyBoost(ITEM.beerExitBoost, 'beer');
      k.invulnTimer = Math.max(k.invulnTimer, ITEM.beerExitInvuln);
    }
    if (k.item === 'beer_rocket') { k.item = null; k.itemCount = 0; }
    if (!quiet) bus.emit('item:beerEnd', { kart: k, gained: b ? b.gained : 0 });
    if (this.vis) this.vis.onBeer(k, 'end');
  }

  // ------------------------------------------------------------- update

  update(dt, race = null) {
    if (!(dt > 0)) return;
    if (dt > 0.05) dt = 0.05;
    this.time += dt;
    if (race) this.race = race;
    const live = !race || race.state === 'racing' || race.state === 'finished';

    // ---- per kart: the driver's wheel, coffee, Golden Toot timer, beer autopilot, triples lost on a hit
    for (const k of this.karts) {
      const st = this._state(k);
      const inp = k.input;
      if (inp.steer !== st.steerOut) st.steerIn = inp.steer;      // a fresh write by the input layer / AI
      st.steerOut = NaN;
      this._updateInk(k, st, dt);
      if (k.ink > 0 && !st.beer && Number.isFinite(+st.steerIn)) {
        inp.steer = st.steerIn * ITEM.espressoSteerMult;
        st.steerOut = inp.steer;
      }
      if (k.goldenTimer > 0) {
        k.goldenTimer -= dt;
        if (k.goldenTimer <= 0) {
          k.goldenTimer = 0;
          if (k.item === 'golden_toot') { k.item = null; k.itemCount = 0; }
          bus.emit('item:goldenEnd', { kart: k });
        }
      }
      if (st.beer) this._updateBeer(k, st, dt);
      const dis = k.isDisabled();
      const fresh = dis && !st.prevDisabled;
      if (fresh && st.attached > 0) this._releaseAttached(k);
      if (fresh) for (const p of this._hk.onKartHit) this._call(p, 'onKartHit', k);
      st.prevDisabled = dis;
    }

    // ---- item button pulses + roulette
    for (const k of this.karts) {
      const inp = k.input;
      if (inp.useItem) {
        inp.useItem = false;
        if (live && !k.frozen && !k.isDisabled() && !k.finished) {
          if (k.rolling) k.rollTimer = Math.min(k.rollTimer, T.rollShortenTo);
          else this.useItem(k);
        }
      }
      if (k.rolling) {
        k.rollTimer -= dt;
        if (k.rollTimer <= 0) this._finishRoll(k);
      }
    }

    this._updateBoxes(dt, live);
    this._updateHazards(dt);
    this._updateProjectiles(dt);
    this._updateAttached(dt);
    this._updateBombs(dt);
    this._updateCapos(dt);
    if (this.entities.length || this._hk.update.length) this._updatePlugins(dt);
    if (this.vis) {
      this.vis.update(dt);
      for (const p of this._hk.updateVisuals) this._call(p, 'updateVisuals', dt);
    }
  }

  _updateBoxes(dt, live) {
    const r2 = ITEM.boxRadius * ITEM.boxRadius;
    for (const b of this.boxes) {
      if (!b.active) {
        b.respawnTimer -= dt;
        if (b.respawnTimer <= 0) {
          b.active = true;
          b.respawnTimer = 0;
          if (this.vis) this.vis.onBoxRespawn(b);
        }
        continue;
      }
      if (!live) continue;
      const bp = b.position;
      for (const k of this.karts) {
        const dx = k.position.x - bp.x, dz = k.position.z - bp.z;
        if (dx * dx + dz * dz > r2) continue;
        if (Math.abs(k.position.y + 0.5 - bp.y) > T.boxPickupDy) continue;
        b.active = false;
        b.respawnTimer = ITEM.boxRespawn;
        bus.emit('item:boxHit', { kart: k, box: b });
        if (this.vis) this.vis.onBoxBreak(b, k);
        if (!k.item && !k.rolling && !k.finished) this._startRoll(k);
        break;
      }
    }
  }

  _updateHazards(dt) {
    const karts = this.karts;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      if (!h) continue;
      h.age += dt;
      if (h.age >= h.life) { this._removeHazard(h, 'expire'); continue; }
      const hp = h.position;
      if (h.type === 'banana') {
        const rr = h.radius * h.radius;
        for (const k of karts) {
          if (k === h.owner && h.age < T.bananaOwnerGrace) continue;
          const dx = k.position.x - hp.x, dz = k.position.z - hp.z;
          if (dx * dx + dz * dz > rr || Math.abs(k.position.y - hp.y) > T.bananaHitDy) continue;
          if (k.isInvincible()) { this._removeHazard(h, 'smash'); break; }
          if (k.spinOut('banana')) {
            bus.emit('item:hit', { kart: k, by: h.owner, item: 'banana', hazard: h });
            this._removeHazard(h, 'hit');
            break;
          }
          // invulnerable / already spinning karts drive over it
        }
      } else {
        // stink cloud: billows out over its first moments, shrinks away at the end
        const left = h.life - h.age;
        const grow = h.age < T.stinkGrowTime ? 0.45 + 0.55 * (h.age / T.stinkGrowTime) : 1;
        const rad = h.radius * grow * (left < T.stinkShrinkTime ? left / T.stinkShrinkTime : 1);
        const rr = rad * rad;
        const slow = Math.exp(-T.stinkSlowRate * dt);
        for (let j = 0; j < karts.length; j++) {
          const k = karts[j];
          if (k === h.owner && h.age < T.stinkOwnerGrace) continue;
          const dx = k.position.x - hp.x, dz = k.position.z - hp.z;
          if (dx * dx + dz * dz > rr || Math.abs(k.position.y - hp.y) > T.stinkHitDy) continue;
          if (k.isInvincible()) continue;
          if (!k.frozen) { k.velocity.x *= slow; k.velocity.z *= slow; }
          const bit = 1 << (j & 31);
          if (h.hitMask & bit) continue;
          if (k.spinOut('stink')) {
            h.hitMask |= bit;
            bus.emit('item:hit', { kart: k, by: h.owner, item: 'stink', hazard: h });
          }
        }
      }
    }
  }

  _updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (!p || !p.active) continue;
      p.age += dt;
      if (p.age >= p.life) { this._removeProjectile(p, 'expire'); continue; }
      p.prev.copy(p.position);
      if (p.mode === 'track') this._stepRocketTrack(p, dt);
      else if (p.mode === 'home') this._stepRocketHome(p, dt);
      else this._stepStraight(p, dt);
      if (!p.active) continue;
      this._collideProjectile(p);
    }
    // projectile vs projectile (few of them: O(n^2) is fine)
    const ps = this.projectiles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const a = ps[i];
      if (!a || !a.active) continue;
      for (let j = i - 1; j >= 0; j--) {
        const b = ps[j];
        if (!b.active) continue;
        if (a.age < 0.15 && b.age < 0.15 && a.owner === b.owner) continue;
        const dx = a.position.x - b.position.x, dz = a.position.z - b.position.z, dy = a.position.y - b.position.y;
        const r = ITEM.projectileRadius * 2;
        if (dx * dx + dz * dz < r * r && Math.abs(dy) < 1.5) {
          this._removeProjectile(a, 'clash');
          this._removeProjectile(b, 'clash');
          break;
        }
      }
    }
  }
  // Bouncer, or a rocket without a target: straight along its heading, riding
  // the road. Bouncers reflect off walls; straight rockets explode there.
  _stepStraight(p, dt) {
    const tr = this.track, pos = p.position, proj = p.proj;
    const step = p.speed * dt;
    pos.x += p.dir.x * step;
    pos.z += p.dir.z * step;
    tr.project(pos, p.hint, proj);
    p.hint = proj.index;
    p.dist += step * (p.dir.x * proj.tangent.x + p.dir.z * proj.tangent.z);
    const bouncer = p.type === 'bouncer';
    const r = bouncer ? T.bouncerRadius : 0.45;
    const lat = proj.lateral;
    const limR = proj.wallR - r, limL = -(proj.wallL - r);
    if (lat > limR || lat < limL) {
      const side = lat > limR ? 1 : -1;
      const pen = side > 0 ? lat - limR : limL - lat;
      pos.x -= proj.right.x * pen * side;
      pos.z -= proj.right.z * pen * side;
      proj.lateral -= pen * side;
      if (!bouncer) { this._removeProjectile(p, 'wall'); return; }
      // reflect the heading on the (tapered) wall normal, like kart.js walls
      const N = tr.N, ix = proj.index;
      const arr = side > 0 ? tr.wr : tr.wl;
      const dW = (arr[(ix + 1) % N] - arr[(ix - 1 + N) % N]) / (2 * tr.spacing);
      let nx = -side * proj.right.x + proj.tangent.x * dW;
      let nz = -side * proj.right.z + proj.tangent.z * dW;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      const dn = p.dir.x * nx + p.dir.z * nz;
      if (dn < 0) {
        p.dir.x -= 2 * dn * nx;
        p.dir.z -= 2 * dn * nz;
        const dl = Math.hypot(p.dir.x, p.dir.z) || 1;
        p.dir.x /= dl; p.dir.z /= dl;
        p.bounces++;
        if (p.bounces > ITEM.bouncerMaxBounces) { this._removeProjectile(p, 'wall'); return; }
        bus.emit('item:bounce', { position: pos, item: p.type, projectile: p });
        if (this.vis) this.vis.onBounce(p);
      }
    }
    pos.y = proj.height + (bouncer ? T.bouncerRadius : T.rocketHeight);
  }

  // Rocket chasing its target along the track: s advances at rocket speed
  // (corrected for the lateral offset in corners), lateral eases toward the
  // target's lateral; switches to direct homing within rocketHomingRange.
  _stepRocketTrack(p, dt) {
    const tr = this.track, tgt = p.target, pos = p.position, proj = p.proj;
    if (!tgt || tgt.finished) { p.mode = 'straight'; this._stepStraight(p, dt); return; }
    const corr = clamp(1 - proj.curvature * p.lateral, 0.55, 1.6);
    const ds = (p.speed * dt) / corr;
    p.s = tr.wrapS(p.s + ds);
    p.dist += ds;
    const gap = tgt.distance - p.dist;
    if (gap < T.rocketLostGap) { p.mode = 'straight'; return; }
    const rate = T.rocketLateralRate * (gap < 70 ? 2.2 : 1);
    const f = tr.frameAt(p.s, this._frame);
    const lim = 0.8;
    p.lateral = clamp(damp(p.lateral, tgt.proj.lateral, rate, dt), -(f.wallL - lim), f.wallR - lim);
    tr.pointAt(p.s, p.lateral, pos);
    pos.y += T.rocketHeight;
    tr.project(pos, p.hint, proj);
    p.hint = proj.index;
    // heading for the visuals / a later straight flight
    const dx = pos.x - p.prev.x, dz = pos.z - p.prev.z;
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-4) { p.dir.x = dx / dl; p.dir.z = dz / dl; }
    const tx = tgt.position.x - pos.x, tz = tgt.position.z - pos.z;
    if (tx * tx + tz * tz < ITEM.rocketHomingRange * ITEM.rocketHomingRange && gap > -3) p.mode = 'home';
  }

  _stepRocketHome(p, dt) {
    const tr = this.track, tgt = p.target, pos = p.position, proj = p.proj;
    if (!tgt || tgt.finished) { p.mode = 'straight'; this._stepStraight(p, dt); return; }
    const tx = tgt.position.x - pos.x, tz = tgt.position.z - pos.z;
    const cur = Math.atan2(p.dir.x, p.dir.z);
    const want = Math.atan2(tx, tz);
    // the turn limit tightens with proximity: at point-blank range (a rival
    // right alongside the shooter) the rocket still connects instead of
    // swinging out wide and looping back into the pack
    const d = Math.max(1, Math.hypot(tx, tz));
    const maxTurn = Math.max(T.rocketHomeTurn, (p.speed * T.rocketCloseTurn) / d) * dt;
    const yaw = cur + clamp(angleDiff(cur, want), -maxTurn, maxTurn);
    p.dir.x = Math.sin(yaw); p.dir.z = Math.cos(yaw);
    const step = p.speed * dt;
    pos.x += p.dir.x * step;
    pos.z += p.dir.z * step;
    tr.project(pos, p.hint, proj);
    p.hint = proj.index;
    p.dist += step * (p.dir.x * proj.tangent.x + p.dir.z * proj.tangent.z);
    // slide along walls rather than flying through them
    const r = 0.45;
    const lat = clamp(proj.lateral, -(proj.wallL - r), proj.wallR - r);
    if (lat !== proj.lateral) {
      pos.x += proj.right.x * (lat - proj.lateral);
      pos.z += proj.right.z * (lat - proj.lateral);
      proj.lateral = lat;
    }
    pos.y = damp(pos.y, Math.max(proj.height + 0.45, tgt.position.y + 0.7), 10, dt);
  }

  // The shooter is immune to its own projectile for ITEM.shooterGrace, and to
  // a rocket for as long as it is locked on a target ('track' / 'home').
  _ownerImmune(p) {
    return p.age < ITEM.shooterGrace || p.mode === 'track' || p.mode === 'home';
  }

  _collideProjectile(p) {
    const pos = p.position;
    // orbiting triples shield their kart: checked before the kart itself
    const ro = ITEM.projectileRadius + ITEM.orbitHitRadius;
    for (let i = this.attached.length - 1; i >= 0; i--) {
      const a = this.attached[i];
      if (!a.active || a.type === 'banana' || a.owner === p.owner) continue;
      const dx = a.position.x - pos.x, dz = a.position.z - pos.z;
      if (dx * dx + dz * dz > ro * ro || Math.abs(a.position.y - pos.y) > 1.5) continue;
      bus.emit('item:blocked', { kart: a.owner, item: p.type, by: p.owner });
      this._detach(a, 'blocked');
      this._removeProjectile(p, 'blocked');
      return;
    }
    // solid v5 plugin entities (another kart's) stop it: both destroyed, a sturdy one survives
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      if (!e.active || !e.solid || e.owner === p.owner) continue;
      const re = ITEM.projectileRadius + e.radius;
      const dx = e.position.x - pos.x, dz = e.position.z - pos.z;
      if (dx * dx + dz * dz > re * re || Math.abs(e.position.y - pos.y) > 1.5) continue;
      bus.emit('item:blocked', { kart: e.owner, item: p.type, by: p.owner, entity: e });
      if (!e.sturdy) this._removeEntity(e, 'blocked');
      this._removeProjectile(p, 'blocked');
      return;
    }
    const rk = ITEM.projectileRadius + KART.radius;
    const ownerImmune = this._ownerImmune(p);
    for (const k of this.karts) {
      if ((k === p.owner && ownerImmune) || k.ghostTimer > 0) continue;   // v5: a ghost (Ladro Mask) lets it pass
      const dx = k.position.x - pos.x, dz = k.position.z - pos.z;
      if (dx * dx + dz * dz > rk * rk) continue;
      if (Math.abs(k.position.y + 0.5 - pos.y) > T.kartHitDy) continue;
      if (k.isInvincible() || !k.isHittable()) {
        // stars smash projectiles; blinking / spinning karts just absorb them
        this._removeProjectile(p, 'smash');
        return;
      }
      if (k.tumble(p.type)) {
        p.victim = k;
        bus.emit('item:hit', { kart: k, by: p.owner, item: p.type, projectile: p });
        this._removeProjectile(p, 'hit');
        return;
      }
    }
    // projectiles clear banana peels
    const rb = ITEM.projectileRadius + T.bananaBlockRadius;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      if (h.type !== 'banana') continue;
      const dx = h.position.x - pos.x, dz = h.position.z - pos.z;
      if (dx * dx + dz * dz > rb * rb || Math.abs(h.position.y + 0.4 - pos.y) > 1.5) continue;
      this._removeHazard(h, 'blocked');
      bus.emit('item:blocked', { kart: p.owner, item: p.type });
      this._removeProjectile(p, 'blocked');
      return;
    }
  }

  _removeHazard(h, reason) {
    if (!h.active) return;
    h.active = false;
    const i = this.hazards.indexOf(h);
    if (i >= 0) { this.hazards[i] = this.hazards[this.hazards.length - 1]; this.hazards.pop(); }
    if (this.vis) this.vis.onHazardRemove(h, reason);
    h.owner = null;
    this._hazardPool.push(h);
  }

  _removeProjectile(p, reason) {
    if (!p.active) return;
    p.active = false;
    // every rocket detonation is an explosion (hit = it tumbled a kart)
    if (p.type === 'rocket' && reason !== 'clear') bus.emit('item:explode', { position: p.position, hit: reason === 'hit', kart: p.victim, item: 'rocket' });
    const i = this.projectiles.indexOf(p);
    if (i >= 0) { this.projectiles[i] = this.projectiles[this.projectiles.length - 1]; this.projectiles.pop(); }
    if (this.vis) this.vis.onProjectileRemove(p, reason);
    p.owner = null;
    p.target = null;
    p.victim = null;
    this._projPool.push(p);
  }

  // ------------------------------------------------------------- queries

  /**
   * Hazards and projectiles within `radius` (horizontal) of the kart, for AI
   * avoidance. Returns a REUSED array of reused objects (valid until the next
   * call): { type, position, distance, ahead, radius, s, lateral, owner,
   * targeting (a rocket / capo locked on this kart), dirX, dirZ, speed, phase, ref }.
   * Types: 'banana' (road peels and trailing peels of other karts), 'stink',
   * 'bomb', 'bouncer', 'rocket', 'capo'. The kart's own projectiles are left
   * out while it is immune to them, its own trailing peels always. v5 plugin
   * threats (entities with threat: true, threats hooks) carry their kind as
   * the type, `item` (the plugin id) and `clear` (> 0: the AI's dodge distance).
   */
  getThreatsNear(kart, radius) {
    const out = this._threats;
    out.length = 0;
    const kp = kart.position;
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
    for (let i = 0; i < this.hazards.length; i++) {
      const h = this.hazards[i];
      const dx = h.position.x - kp.x, dz = h.position.z - kp.z;
      const d = Math.hypot(dx, dz);
      if (d - h.radius > radius) continue;
      this._pushThreat(h, d, dx * fx + dz * fz > 0, h.radius, h.s, h.lateral);
    }
    for (let i = 0; i < this.bombs.length; i++) {
      const b = this.bombs[i];
      const dx = b.position.x - kp.x, dz = b.position.z - kp.z;
      const d = Math.hypot(dx, dz);
      if (d - ITEM.bombTriggerRadius > radius) continue;
      const t = this._pushThreat(b, d, dx * fx + dz * fz > 0, ITEM.bombTriggerRadius, b.proj.s, b.proj.lateral);
      t.type = 'bomb';
      t.dirX = b.vel.x; t.dirZ = b.vel.z; t.speed = Math.hypot(b.vel.x, b.vel.z);
    }
    for (let i = 0; i < this.attached.length; i++) {
      const a = this.attached[i];
      if (a.owner === kart || a.type !== 'banana' || a.proj.s === undefined) continue;
      const dx = a.position.x - kp.x, dz = a.position.z - kp.z;
      const d = Math.hypot(dx, dz);
      if (d - ITEM.hazardRadius > radius) continue;
      this._pushThreat(a, d, dx * fx + dz * fz > 0, ITEM.hazardRadius, a.proj.s, a.proj.lateral);
    }
    for (let i = 0; i < this.projectiles.length; i++) {
      const p = this.projectiles[i];
      if (p.owner === kart && this._ownerImmune(p)) continue;
      const dx = p.position.x - kp.x, dz = p.position.z - kp.z;
      const d = Math.hypot(dx, dz);
      if (d > radius) continue;
      const t = this._pushThreat(p, d, dx * fx + dz * fz > 0, ITEM.projectileRadius, p.proj.s, p.proj.lateral);
      t.targeting = p.type === 'rocket' && p.target === kart;
      t.dirX = p.dir.x; t.dirZ = p.dir.z; t.speed = p.speed;
    }
    for (let i = 0; i < this.capos.length; i++) {
      const c = this.capos[i];
      const dx = c.position.x - kp.x, dy = c.position.y - kp.y, dz = c.position.z - kp.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius && c.target !== kart) continue;
      const t = this._pushThreat(c, d, dx * fx + dz * fz > 0, ITEM.capoHitRadius, c.s, c.lateral);
      t.type = 'capo';
      t.targeting = c.target === kart;
      t.phase = c.phase;
      t.dirX = c.dir.x; t.dirZ = c.dir.z; t.speed = c.speed;
    }
    // v5 plugins: entities spawned with threat: true (their owner is left out
    // while it is in its grace), then each plugin's threats(ctx, kart, radius, push) hook.
    // These records carry `clear` (m the AI keeps between its centre and the
    // threat's) and `item` (the plugin id); type = the entity kind.
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (!e.active || !e.threat || (e.owner === kart && e.age < e.ownerGrace)) continue;
      const dx = e.position.x - kp.x, dz = e.position.z - kp.z;
      const d = Math.hypot(dx, dz);
      if (d - e.radius > radius) continue;
      const t = this._pushThreat(e, d, dx * fx + dz * fz > 0, e.radius, e.s, e.lateral);
      t.type = e.kind;
      t.item = e.item;
      t.clear = e.clear > 0 ? e.clear : e.radius + 1.0;
      t.targeting = e.target === kart;
      t.phase = e.phase;
      t.dirX = e.dir.x; t.dirZ = e.dir.z; t.speed = e.speed;
    }
    if (this._hk.threats.length) {
      this._threatKart = kart;
      for (const p of this._hk.threats) this._call(p, 'threats', kart, radius, this._threatPush);
      this._threatKart = null;
    }
    return out;
  }

  // Fill the next pooled threat record and append it to the result list.
  _pushThreat(ref, distance, ahead, radius, s, lateral) {
    const out = this._threats;
    let t = this._threatPool[out.length];
    if (!t) {
      t = this._threatPool[out.length] = { type: '', position: null, distance: 0, ahead: false, radius: 0, s: 0, lateral: 0, owner: null, targeting: false, dirX: 0, dirZ: 0, speed: 0, phase: '', ref: null, clear: 0, item: '' };
    }
    t.type = ref.type; t.ref = ref; t.position = ref.position; t.distance = distance; t.ahead = ahead;
    t.radius = radius; t.s = s; t.lateral = lateral; t.owner = ref.owner;
    t.targeting = false; t.dirX = 0; t.dirZ = 0; t.speed = 0; t.phase = ''; t.clear = 0; t.item = '';
    out.push(t);
    return t;
  }

  /** The Capo Crusher heading for this kart, or null. */
  capoFor(kart) {
    for (const c of this.capos) if (c.active && c.target === kart) return c;
    return null;
  }

  /** Remove every item in play (hazards, projectiles, triples, capos, bombs, running beers / coffee) and reactivate all boxes. */
  clear() {
    while (this.hazards.length) this._removeHazard(this.hazards[this.hazards.length - 1], 'clear');
    while (this.projectiles.length) this._removeProjectile(this.projectiles[this.projectiles.length - 1], 'clear');
    while (this.attached.length) this._detach(this.attached[this.attached.length - 1], 'clear');
    while (this.capos.length) this._removeCapo(this.capos[this.capos.length - 1], 'clear');
    while (this.bombs.length) this._removeBomb(this.bombs[this.bombs.length - 1], 'clear');
    for (const k of this.karts) {
      const st = this._st.get(k);
      if (!st) continue;
      if (st.beer) this._endBeer(k, st, true);
      st.attached = 0;
      st.inkAge = -1; st.inkLanded = false; st.inkWash = false; st.inkBy = null;
      k.ink = 0; k.inkIncoming = false; k.capoWarn = 0; k.goldenTimer = 0;
    }
    for (const b of this.boxes) { b.active = true; b.respawnTimer = 0; }
    this._zapBlockedUntil = -Infinity;
    this._capoBlockedUntil = -Infinity;
    this._espressoBlockedUntil = -Infinity;
    // v5 plugins: entities, then each plugin's clear hook, then its per-kart state
    while (this.entities.length) this._removeEntity(this.entities[this.entities.length - 1], 'clear');
    for (const p of this._plugins) {
      if (p.handler.clear) this._call(p, 'clear');
      p.ctx._kst.clear();
    }
    this._blockedUntil = {};
    if (this.vis) this.vis.onClear();
  }

  dispose() {
    this.clear();
    for (const off of this._offs) off();
    this._offs = [];
    for (const p of this._plugins) {
      if (p.handler.dispose) this._call(p, 'dispose');
      if (this.vis) {
        if (p.handler.disposeVisuals) this._call(p, 'disposeVisuals');
        p.ctx._disposeVisuals();
      }
      p.ctx._dispose();
    }
    if (this.vis) { this.vis.dispose(); this.vis = null; }
  }
}

// A v5 plugin entity (ctx.spawn): pooled, owned by one plugin.
function makeEntity() {
  return {
    uid: 0, plugin: null, item: '', kind: '', type: '', active: false, owner: null, target: null,
    position: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1),
    speed: 0, radius: 0.5, height: 0, age: 0, life: 0, s: 0, lateral: 0, dist: 0, proj: {}, hint: -1, bounces: 0,
    grounded: false, threat: false, clear: 0, solid: false, sturdy: false, counts: false, ownerGrace: 0.5,
    phase: '', hitMask: 0, data: null, vis: null,
  };
}

function makeHazard() {
  return {
    uid: 0, type: 'banana', active: false, owner: null, position: new THREE.Vector3(),
    radius: 0, life: 0, age: 0, hitMask: 0, s: 0, lateral: 0, proj: {}, hint: -1,
    dropFrom: 0, seed: 0, visYaw: 0, wisp: 0,     // visual state (ItemVisuals)
  };
}

function makeProjectile() {
  return {
    uid: 0, type: 'bouncer', active: false, owner: null, target: null,
    position: new THREE.Vector3(), prev: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1),
    speed: 0, life: 0, age: 0, bounces: 0, proj: {}, hint: -1, mode: 'bounce',
    s: 0, lateral: 0, dist: 0, vis: null, victim: null,
  };
}

// An item attached to a kart: an orbiting bouncer / rocket or a trailing peel.
function makeAttached() {
  return {
    uid: 0, type: 'bouncer', active: false, owner: null, slot: 0, phase: 0, gap: 0, age: 0,
    position: new THREE.Vector3(), prev: new THREE.Vector3(), proj: {}, hint: -1, vis: null, visYaw: 0,
  };
}

function makeCapo() {
  return {
    uid: 0, type: 'capo', active: false, owner: null, target: null, phase: 'ground', phaseT: 0, age: 0,
    position: new THREE.Vector3(), prev: new THREE.Vector3(), from: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1),
    s: 0, lateral: 0, dist: 0, startDist: 0, speed: 0, angle: 0, riseTime: 0.6, locked: false, dodged: false, vis: null,
  };
}

function makeBomb() {
  return {
    uid: 0, type: 'bomb', active: false, owner: null, phase: 'air', fuse: -1, age: 0, dropped: false,
    position: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), proj: {}, hint: -1,
    s: 0, lateral: 0, vis: null, spin: 0,
  };
}

// ===================================================================== visuals
//
// Only constructed when a scene is given (browser). Everything is pooled and
// built once; per-frame work is matrix writes and a few particle emits.

const BOX_SIZE = 1.3;
const PUFFS = 9;                 // body spheres per stink cloud
const BUBBLES = 3;               // small puffs bubbling up out of each cloud
const BOUNCER_POOL = 12;
const ORBIT_POOL = 24;            // orbiting triple bouncers / rockets (instanced) and trailing peels
const CAPO_POOL = 2;
const BOMB_POOL = 6;
const CUP_POOL = 8;
const ACC_POOL = 3;
const RING_POOL = 8;
const ROCKET_POOL = 8;
const BOLT_POOL = 8;
const BOLT_SEGMENTS = 11;
const BOLT_TIME = 0.45;
const SHARD_POOL = 72;           // flying glass shards from broken item boxes
const SHARDS_PER_BOX = 12;
const SHARD_LIFE = 0.8;

// Display-referred rainbow glass with bright edges and a fresnel rim.
const BOX_VERT = /* glsl */`
attribute float aPhase;
varying vec3 vN;
varying vec3 vV;
varying vec3 vLocal;
varying float vPhase;
#include <fog_pars_vertex>
void main() {
  vLocal = position;
  vPhase = aPhase;
  mat4 mw = modelMatrix * instanceMatrix;
  vec4 mvPosition = viewMatrix * mw * vec4(position, 1.0);
  vN = normalize(mat3(viewMatrix) * mat3(mw) * normal);
  vV = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const BOX_FRAG = /* glsl */`
uniform float uTime;
uniform float uHalf;
varying vec3 vN;
varying vec3 vV;
varying vec3 vLocal;
varying float vPhase;
#include <common>
#include <fog_pars_fragment>
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  float facing = abs(dot(n, v));
  float fres = pow(1.0 - facing, 2.0);
  float hue = fract(vPhase + uTime * 0.16 + vLocal.y * 0.32 + (vLocal.x + vLocal.z) * 0.18);
  vec3 rain = hsv2rgb(vec3(hue, 0.88, 1.0));
  // bright frame where two face coordinates are both near the surface
  vec3 a = smoothstep(0.74, 0.93, abs(vLocal) / uHalf);
  float edge = clamp(a.x * a.y + a.y * a.z + a.z * a.x, 0.0, 1.0);
  // soft diagonal glints sweeping across the faces
  float glint = smoothstep(0.92, 1.0, sin((vLocal.x + vLocal.y * 0.7 - vLocal.z * 0.4) * 3.2 - uTime * 2.6 + vPhase * 6.28));
  vec3 col = mix(rain * 0.92, vec3(1.0), 0.1 + 0.38 * fres);
  col += edge * mix(rain, vec3(1.0), 0.55) * 0.9 + glint * 0.35;
  float alpha = clamp(0.3 + 0.5 * fres + 0.6 * edge + glint * 0.2, 0.0, 0.94);
  // display-referred colours -> linear working space; output conversion below
  col = pow(col, vec3(2.2));
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// Camera-facing "?" inside each box (billboarded in view space).
const Q_VERT = /* glsl */`
attribute float aPhase;
uniform float uTime;
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float sc = length(instanceMatrix[0].xyz);
  float w = sin(uTime * 2.3 + aPhase * 6.2831) * 0.16;
  float c = cos(w), s = sin(w);
  vec2 p = mat2(c, s, -s, c) * position.xy * sc;
  vec4 mvPosition = center + vec4(p, 0.0, 0.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const Q_FRAG = /* glsl */`
uniform sampler2D map;
varying vec2 vUv;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(map, vUv);
  if (t.a < 0.45) discard;
  gl_FragColor = vec4(t.rgb, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// Cartoon stink puffs: crisp silhouettes, top-lit shading, darker blotches,
// a light rim on the upper edge and a soft (not fuzzy) translucent body.
const PUFF_VERT = /* glsl */`
attribute float aAlpha;
varying vec3 vN;
varying vec3 vV;
varying vec3 vObjN;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  vAlpha = aAlpha;
  vSeed = float(gl_InstanceID) * 1.618;
  mat4 mw = modelMatrix * instanceMatrix;
  vec4 mvPosition = viewMatrix * mw * vec4(position, 1.0);
  vN = normalize(mat3(viewMatrix) * mat3(mw) * normal);
  vObjN = normal;
  vV = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const PUFF_FRAG = /* glsl */`
uniform vec3 uLight;
uniform vec3 uDark;
uniform vec3 uRim;
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying vec3 vObjN;
varying float vAlpha;
varying float vSeed;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  vec3 o = normalize(vObjN);
  float facing = clamp(dot(n, v), 0.0, 1.0);
  // top-lit with a little wrap from the sun side
  float shade = smoothstep(-0.75, 0.95, o.y * 0.85 + o.x * 0.15);
  vec3 col = mix(uDark, uLight, shade);
  // slowly churning darker blotches
  float b = sin(o.x * 6.0 + vSeed + uTime * 0.7) * sin(o.z * 5.0 - vSeed * 1.3 + uTime * 0.5) * sin(o.y * 4.0 + vSeed * 0.7);
  col *= 1.0 - 0.16 * smoothstep(0.15, 0.75, b);
  // darker edges separate the puffs (cartoon ink), bright rim on the upper silhouette
  float up = smoothstep(-0.2, 0.6, o.y);
  col *= mix(0.62, 1.0, smoothstep(0.05, 0.5, facing) * (1.0 - up * 0.5) + up * 0.5);
  col = mix(col, uRim, pow(1.0 - facing, 2.0) * 0.6 * up);
  float a = vAlpha * mix(0.8, 1.0, facing);
  // crisp silhouette (depth is written, so no soft fringes that would cut into puffs behind)
  if (facing < 0.06 || a < 0.02) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function makeQuestionTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 112px "Arial Black", "Arial Rounded MT Bold", Impact, sans-serif';
  g.lineJoin = 'round';
  // dark outline + drop shadow, then a warm white-to-yellow fill
  g.lineWidth = 18;
  g.strokeStyle = 'rgba(40, 14, 70, 0.95)';
  g.strokeText('?', S / 2 + 3, S / 2 + 8);
  g.strokeText('?', S / 2, S / 2 + 4);
  const grd = g.createLinearGradient(0, 18, 0, S - 14);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.55, '#fff6c4');
  grd.addColorStop(1, '#ffc93b');
  g.fillStyle = grd;
  g.fillText('?', S / 2, S / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Primitive -> non-indexed, vertex-coloured, uv-less part for merging.
function part(geo, color, { scale, rot, pos } = {}) {
  if (scale) geo.scale(scale[0], scale[1], scale[2]);
  if (rot) geo.applyQuaternion(rot);
  if (pos) geo.translate(pos[0], pos[1], pos[2]);
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.deleteAttribute('uv');
  const col = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function merge(parts) {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

const _up = new THREE.Vector3(0, 1, 0);
// Capsule from point a to point b (local Y axis -> a->b), flattened across.
function segment(a, b, radius, color, flatten = 1, widen = 1) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  dir.normalize();
  const geo = new THREE.CapsuleGeometry(radius, Math.max(0.01, len - radius), 4, 10);
  geo.scale(flatten, 1, widen);
  const q = new THREE.Quaternion().setFromUnitVectors(_up, dir);
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  return part(geo, color, { rot: q, pos: [mid.x, mid.y, mid.z] });
}

// Banana peel lying on the road: cream fruit stub, brown stem, three yellow
// peel petals flopping outward with brown tips. ~1.4 m across.
function buildBananaGeometry() {
  const parts = [];
  const YEL = 0xffcc12, YEL2 = 0xf0a80c, TIP = 0x5e3a0e, CREAM = 0xfff1b0;
  parts.push(part(new THREE.CapsuleGeometry(0.13, 0.2, 4, 10), CREAM, { rot: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, 0, 0.1)), pos: [0, 0.33, 0] }));
  parts.push(part(new THREE.CylinderGeometry(0.045, 0.065, 0.14, 8), TIP, { pos: [0.02, 0.56, 0.02] }));
  parts.push(part(new THREE.SphereGeometry(0.2, 12, 8), YEL2, { scale: [1, 0.55, 1], pos: [0, 0.16, 0] }));
  for (let i = 0; i < 3; i++) {
    const th = (i / 3) * TAU + 0.35;
    const c = Math.cos(th), s = Math.sin(th);
    const p0 = new THREE.Vector3(0.06 * c, 0.24, 0.06 * s);
    const p1 = new THREE.Vector3(0.34 * c, 0.2, 0.34 * s);
    const p2 = new THREE.Vector3(0.64 * c, 0.06, 0.64 * s);
    parts.push(segment(p0, p1, 0.1, YEL, 0.5, 1.5));
    parts.push(segment(p1, p2, 0.095, i === 1 ? YEL2 : YEL, 0.5, 1.45));
    parts.push(part(new THREE.SphereGeometry(0.07, 8, 6), TIP, { scale: [1, 0.6, 1], pos: [0.7 * c, 0.05, 0.7 * s] }));
  }
  return merge(parts);
}

// Bouncer: glossy green ball with a white stripe (shows the roll) and two
// white "eye" spots. Radius ITEM_TUNE.bouncerRadius, centered at the origin.
function buildBouncerGeometry() {
  const r = T.bouncerRadius;
  const parts = [];
  const alongX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  parts.push(part(new THREE.SphereGeometry(r, 28, 18), 0x1fc84a));
  parts.push(part(new THREE.TorusGeometry(r * 1.0, r * 0.12, 8, 40), 0xffffff, { rot: alongX }));
  for (const sx of [-1, 1]) {
    parts.push(part(new THREE.CylinderGeometry(r * 0.36, r * 0.36, r * 0.08, 20), 0xffffff, {
      rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2), pos: [sx * r * 0.955, 0, 0],
    }));
    parts.push(part(new THREE.CylinderGeometry(r * 0.2, r * 0.2, r * 0.1, 16), 0x0e7a2c, {
      rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2), pos: [sx * r * 0.975, 0, 0],
    }));
  }
  return merge(parts);
}

// Homing rocket pointing +Z: red body, white nose, yellow band + fins, dark
// nozzle and a pair of determined cartoon eyes. ~1.7 m long.
function buildRocketGeometry() {
  const parts = [];
  const RED = 0xe62a2a, WHITE = 0xf6f6f6, YEL = 0xffc21f, DARK = 0x2e2e36;
  const toZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  parts.push(part(new THREE.CylinderGeometry(0.25, 0.28, 1.0, 18), RED, { rot: toZ, pos: [0, 0, 0] }));
  parts.push(part(new THREE.ConeGeometry(0.25, 0.55, 18), WHITE, { rot: toZ, pos: [0, 0, 0.775] }));
  parts.push(part(new THREE.SphereGeometry(0.06, 8, 6), RED, { pos: [0, 0, 1.04] }));
  parts.push(part(new THREE.CylinderGeometry(0.262, 0.262, 0.12, 18), YEL, { rot: toZ, pos: [0, 0, 0.32] }));
  parts.push(part(new THREE.CylinderGeometry(0.17, 0.23, 0.2, 14), DARK, { rot: toZ, pos: [0, 0, -0.6] }));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
    const off = new THREE.Vector3(0, 0.36, 0).applyQuaternion(q);
    parts.push(part(new THREE.BoxGeometry(0.05, 0.3, 0.38), YEL, { rot: q, pos: [off.x, off.y, -0.36] }));
  }
  // eyes on the nose, looking ahead
  for (const sx of [-1, 1]) {
    parts.push(part(new THREE.SphereGeometry(0.085, 10, 8), WHITE, { scale: [1, 1.25, 0.6], pos: [sx * 0.105, 0.13, 0.57] }));
    parts.push(part(new THREE.SphereGeometry(0.042, 8, 6), 0x111111, { pos: [sx * 0.1, 0.12, 0.625] }));
    parts.push(part(new THREE.BoxGeometry(0.12, 0.028, 0.03), 0x111111, {
      rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), sx * 0.45), pos: [sx * 0.1, 0.25, 0.6],
    }));
  }
  return merge(parts);
}

// ---- v4 item looks (all original: a winged golden meatball, a meatball bomb
// with a fuse, a big espresso cup, a squeezebox, blast rings)

// Deterministic lumpy displacement for "meatball" spheres (direction based, so
// the duplicated vertices of a non-indexed icosahedron stay welded).
function lump(nx, ny, nz, seed) {
  return Math.sin(nx * 7.1 + seed) * Math.sin(ny * 6.3 + seed * 1.7) * Math.sin(nz * 5.7 + seed * 2.3) +
    0.5 * Math.sin(nx * 13.0 - seed) * Math.sin(ny * 11.0 + seed) * Math.sin(nz * 12.0 + 0.7 * seed);
}

// Flat-shaded lumpy ball with vertex colors from dark (dents) to light (bumps).
function lumpyBall(r, detail, amp, seed, dark, light) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const pos = g.attributes.position;
  const ca = new THREE.Color(dark), cb = new THREE.Color(light), c = new THREE.Color();
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const l = Math.hypot(x, y, z) || 1;
    const d = lump(x / l, y / l, z / l, seed);
    const k = 1 + amp * d;
    pos.setXYZ(i, x * k, y * k, z * k);
    c.copy(ca).lerp(cb, clamp(0.5 + 0.6 * d, 0, 1));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.deleteAttribute('uv');
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// Capo Crusher body: a golden lumpy meatball with pale-gold spikes all over,
// ~1.5 m across with the spikes. Wings are separate meshes (they flap).
function buildCapoGeometry() {
  const parts = [lumpyBall(0.62, 2, 0.085, 2.4, 0xb8741a, 0xffd25a)];
  const SPIKE = 0xfff1b8, TIP = 0xffffff;
  const n = 14;
  for (let i = 0; i < n; i++) {
    // golden-angle spiral over the sphere, skipping the very bottom (it rolls on it)
    const y = 1 - (i + 0.5) / n * 1.7;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * 2.39996;
    const dir = new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(_up, dir);
    const base = dir.clone().multiplyScalar(0.6);
    const tip = dir.clone().multiplyScalar(0.62 + 0.2);
    parts.push(part(new THREE.ConeGeometry(0.13, 0.36, 6), SPIKE, { rot: q, pos: [base.x + dir.x * 0.16, base.y + dir.y * 0.16, base.z + dir.z * 0.16] }));
    parts.push(part(new THREE.SphereGeometry(0.035, 6, 4), TIP, { pos: [tip.x + dir.x * 0.13, tip.y + dir.y * 0.13, tip.z + dir.z * 0.13] }));
  }
  return merge(parts);
}

// One feathered wing, root at the origin, spreading along +X (mirror for the other side).
function buildWingGeometry() {
  const parts = [];
  const W = 0xfffdf6, G = 0xffd34d;
  for (let i = 0; i < 4; i++) {
    const a = -0.35 + i * 0.32;                       // fan angle (rad) around Z
    const len = 0.95 - i * 0.12;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a - Math.PI / 2));
    const dir = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), a);
    const mid = dir.clone().multiplyScalar(len * 0.5);
    parts.push(part(new THREE.CapsuleGeometry(0.1, len - 0.2, 3, 8), i === 3 ? G : W, { scale: [1, 1, 0.32], rot: q, pos: [mid.x, mid.y, mid.z - i * 0.03] }));
  }
  parts.push(part(new THREE.SphereGeometry(0.13, 8, 6), G, { scale: [1, 1, 0.6] }));
  return merge(parts);
}

// Meatball Bomb: a lumpy brown meatball with a dollop of red sauce, herb
// flecks and a fuse on top. Radius ~ITEM_TUNE.bombRadius, centered.
function buildBombGeometry() {
  const parts = [lumpyBall(0.5, 2, 0.1, 5.1, 0x5c2c14, 0xa45a30)];
  parts.push(part(new THREE.SphereGeometry(0.34, 14, 8), 0xd2361c, { scale: [1, 0.36, 1], pos: [0.03, 0.43, -0.02] }));
  parts.push(part(new THREE.SphereGeometry(0.18, 10, 6), 0xe8502c, { scale: [1, 0.4, 1], pos: [-0.12, 0.47, 0.08] }));
  for (let i = 0; i < 7; i++) {
    const a = i * 2.1, y = -0.2 + (i % 3) * 0.22;
    const r = Math.sqrt(Math.max(0, 0.27 - y * y));
    parts.push(part(new THREE.BoxGeometry(0.08, 0.025, 0.04), 0x3f8a2a, {
      rot: new THREE.Quaternion().setFromEuler(new THREE.Euler(a, a * 0.7, 0)), pos: [Math.cos(a) * r * 1.02, y, Math.sin(a) * r * 1.02],
    }));
  }
  parts.push(part(new THREE.CylinderGeometry(0.08, 0.1, 0.08, 10), 0x3a3a42, { pos: [0, 0.55, 0] }));
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.56, 0), new THREE.Vector3(0.04, 0.72, 0.02), new THREE.Vector3(0.13, 0.84, -0.01), new THREE.Vector3(0.24, 0.88, -0.06)]);
  parts.push(part(new THREE.TubeGeometry(curve, 10, 0.032, 6, false), 0xead6a2));
  return merge(parts);
}
const BOMB_FUSE_TIP = new THREE.Vector3(0.25, 0.88, -0.06);

// Big espresso cup on a saucer, coffee + crema inside (~0.9 m across the saucer).
function buildCupGeometry() {
  const parts = [];
  const CER = 0xfbfaf6, RIM = 0xd9d6cf;
  parts.push(part(new THREE.CylinderGeometry(0.3, 0.22, 0.36, 18, 1, true), CER, { pos: [0, 0.22, 0] }));
  parts.push(part(new THREE.CylinderGeometry(0.29, 0.21, 0.35, 18, 1, true), RIM, { rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI), pos: [0, 0.22, 0] }));
  parts.push(part(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 18), CER, { pos: [0, 0.05, 0] }));
  parts.push(part(new THREE.CylinderGeometry(0.306, 0.292, 0.08, 18, 1, true), 0xd2563a, { pos: [0, 0.31, 0] }));   // a red band
  parts.push(part(new THREE.CylinderGeometry(0.27, 0.27, 0.02, 18), 0x3b200f, { pos: [0, 0.33, 0] }));
  parts.push(part(new THREE.TorusGeometry(0.17, 0.035, 6, 18), 0xc78a4f, { rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), pos: [0, 0.345, 0] }));
  parts.push(part(new THREE.TorusGeometry(0.1, 0.035, 6, 14, Math.PI * 1.2), CER, { rot: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -Math.PI * 0.6)), pos: [0.31, 0.24, 0] }));
  parts.push(part(new THREE.CylinderGeometry(0.46, 0.38, 0.05, 22), CER, { pos: [0, 0.025, 0] }));
  parts.push(part(new THREE.TorusGeometry(0.42, 0.025, 5, 22), RIM, { rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), pos: [0, 0.05, 0] }));
  return merge(parts);
}

// Accordion: two red end boards (keys on one, buttons on the other) and a
// pleated bellows that spans x = -0.5..0.5 (scaled to squeeze), ~1 m wide.
function buildAccordionEnds() {
  const parts = [];
  const RED = 0xd8334f, GOLD = 0xffcf4a;
  for (const sx of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(0.16, 0.62, 0.54), RED, { pos: [sx * 0.08, 0, 0] }));
    parts.push(part(new THREE.BoxGeometry(0.17, 0.64, 0.04), GOLD, { pos: [sx * 0.08, 0, 0.27] }));
    parts.push(part(new THREE.BoxGeometry(0.17, 0.64, 0.04), GOLD, { pos: [sx * 0.08, 0, -0.27] }));
  }
  // piano keys (left board, outer face) + round buttons (right board)
  for (let i = 0; i < 6; i++) parts.push(part(new THREE.BoxGeometry(0.04, 0.07, 0.4), 0xffffff, { pos: [-0.17, -0.22 + i * 0.09, 0] }));
  for (let i = 0; i < 9; i++) parts.push(part(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 8), 0x1d1830, { rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2), pos: [0.175, -0.2 + (i % 5) * 0.1, i < 5 ? -0.1 : 0.1] }));
  return merge(parts);
}
function buildBellowsGeometry() {
  const parts = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const x = -0.5 + (i + 0.5) / n;
    parts.push(part(new THREE.BoxGeometry(0.6 / n, 0.58, 0.5), i % 2 ? 0xf6ead6 : 0x2b2448, { pos: [x, 0, 0] }));
  }
  return merge(parts);
}

// Two crossed ribbons along a jagged path: reads as a bolt from any angle.
function writeBolt(geo, height, rnd) {
  const pos = geo.attributes.position.array;
  const pts = [];
  let x = 0, z = 0;
  for (let i = 0; i <= BOLT_SEGMENTS; i++) {
    const t = i / BOLT_SEGMENTS;
    const y = height * (1 - t);
    if (i > 0 && i < BOLT_SEGMENTS) { x += (rnd() - 0.5) * 2.2; z += (rnd() - 0.5) * 2.2; x *= 0.75; z *= 0.75; }
    else if (i === BOLT_SEGMENTS) { x = 0; z = 0; }
    pts.push(x, y, z);
  }
  let o = 0;
  for (let plane = 0; plane < 2; plane++) {
    for (let i = 0; i < BOLT_SEGMENTS; i++) {
      const w0 = 0.55 * (1 - (i / BOLT_SEGMENTS) * 0.5), w1 = 0.55 * (1 - ((i + 1) / BOLT_SEGMENTS) * 0.5);
      const ax = pts[i * 3], ay = pts[i * 3 + 1], az = pts[i * 3 + 2];
      const bx = pts[i * 3 + 3], by = pts[i * 3 + 4], bz = pts[i * 3 + 5];
      const ox = plane === 0 ? 1 : 0, oz = plane === 0 ? 0 : 1;
      const quad = [
        ax - ox * w0, ay, az - oz * w0, ax + ox * w0, ay, az + oz * w0, bx + ox * w1, by, bz + oz * w1,
        ax - ox * w0, ay, az - oz * w0, bx + ox * w1, by, bz + oz * w1, bx - ox * w1, by, bz - oz * w1,
      ];
      for (let k = 0; k < 18; k++) pos[o++] = quad[k];
    }
  }
  geo.attributes.position.needsUpdate = true;
  geo.computeBoundingSphere();
}

function freeSlot(pool) {
  for (let i = 0; i < pool.length; i++) if (!pool[i].used) return pool[i];
  return null;
}

const easeOutBack = (t) => { const c1 = 1.9, c3 = c1 + 1; const u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; };

class ItemVisuals {
  constructor(sys, scene, effects) {
    this.sys = sys;
    this.scene = scene;
    this.fx = effects;
    this.time = 0;
    this.root = new THREE.Group();
    this.root.name = 'items';
    scene.add(this.root);
    this._geos = [];
    this._mats = [];
    this._texs = [];

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    // reused particle option objects
    this._o = {
      shard: { count: 34, spread: 7.5, size: 0.24, life: 1.1, radius: 0.55, color: 'rainbow' },
      sparkle: { count: 10, spread: 2.2, size: 0.3, radius: 0.5, color: 0xffffff },
      spawnSparkle: { count: 6, spread: 1.2, size: 0.22, radius: 0.55, color: 0xfff3a0 },
      flame: { count: 0, velocity: new THREE.Vector3(), spread: 1.2, size: 0.42, life: 0.2, radius: 0.06, from: new THREE.Vector3() },
      smoke: { count: 0, velocity: new THREE.Vector3(), spread: 0.5, size: 0.42, life: 0.85, radius: 0.08, alpha: 0.42, color: 0xb4b4bc, from: new THREE.Vector3() },
      glowGreen: { count: 0, velocity: new THREE.Vector3(), spread: 0.3, size: 0.42, life: 0.16, radius: 0.12, color: 0x4dff6e, from: new THREE.Vector3() },
      bounceSpark: { count: 10, spread: 5, size: 0.14, color: 0xb8ffb0 },
      pop: { count: 14, spread: 5, size: 0.16, color: 0x7dff8f },
      popSmoke: { count: 6, spread: 1.6, size: 0.6, alpha: 0.45, color: 0xcfd6cf },
      banana: { count: 10, spread: 4.5, size: 0.16, color: 0xffe14d },
      stink: { count: 1, velocity: new THREE.Vector3(0, 0.6, 0), spread: 1.4, size: 1.0, radius: 2.2, alpha: 0.42, life: 1.6 },
      zap: { count: 30, spread: 9, size: 0.34, radius: 0.9 },
      zapGlow: { count: 4, spread: 1, size: 1.6, life: 0.25, color: 0xfff6a0, radius: 0.3 },
      explosion: { count: 28, spread: 8, size: 0.95, alpha: 0.75, velocity: new THREE.Vector3() },
      fizzle: { count: 14, spread: 5, size: 0.7, alpha: 0.75, velocity: new THREE.Vector3() },
      blastSmoke: { count: 10, spread: 3, size: 1.1, alpha: 0.55, life: 1.4, color: 0x9a9aa2, velocity: new THREE.Vector3() },
    };

    this._buildBoxes();
    this._buildBananas();
    this._buildBouncers();
    this._buildRockets();
    this._buildStink();
    this._buildBolts();
    this._buildShards();
    this._buildV4();
    this.update(0);
  }

  _own(x, list) { list.push(x); return x; }

  // ---------------------------------------------------------------- build

  _buildBoxes() {
    const boxes = this.sys.boxes;
    const n = Math.max(1, boxes.length);
    const geo = this._own(new RoundedBoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE, 3, 0.2), this._geos);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) phase[i] = (i * 0.618034) % 1;
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    const mat = this._own(new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uHalf: { value: BOX_SIZE / 2 } }]),
      vertexShader: BOX_VERT, fragmentShader: BOX_FRAG,
      transparent: true, depthWrite: false, fog: true, toneMapped: false,
    }), this._mats);
    this.boxUniforms = mat.uniforms;
    this.boxMesh = new THREE.InstancedMesh(geo, mat, n);
    this.boxMesh.name = 'item-boxes';
    this.boxMesh.frustumCulled = false;
    this.boxMesh.renderOrder = 3;
    this.boxMesh.castShadow = true;
    this.boxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.boxMesh);

    const qgeo = this._own(new THREE.PlaneGeometry(0.98, 0.98), this._geos);
    qgeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase.slice(), 1));
    const tex = this._own(makeQuestionTexture(), this._texs);
    const qmat = this._own(new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, map: { value: null } }]),
      vertexShader: Q_VERT, fragmentShader: Q_FRAG, fog: true, toneMapped: false,
    }), this._mats);
    qmat.uniforms.map.value = tex;
    this.qUniforms = qmat.uniforms;
    this.qMesh = new THREE.InstancedMesh(qgeo, qmat, n);
    this.qMesh.name = 'item-box-marks';
    this.qMesh.frustumCulled = false;
    this.qMesh.renderOrder = 2;
    this.qMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.qMesh);

    // per-box animation state (pop-in after respawn)
    this.boxAnim = boxes.map((b, i) => ({ pop: 1, phase: phase[i] * TAU }));
    if (!boxes.length) { this.boxMesh.count = 0; this.qMesh.count = 0; }   // items off
  }

  _buildBananas() {
    const geo = this._own(buildBananaGeometry(), this._geos);
    const mat = this._own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.0 }), this._mats);
    this.bananaMesh = new THREE.InstancedMesh(geo, mat, T.maxBananas + ORBIT_POOL);   // road peels + trailing bunches
    this.bananaMesh.name = 'bananas';
    this.bananaMesh.castShadow = true;
    this.bananaMesh.receiveShadow = true;
    this.bananaMesh.frustumCulled = false;
    this.bananaMesh.count = 0;
    this.bananaMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.bananaMesh);
  }

  _buildBouncers() {
    const geo = this._own(buildBouncerGeometry(), this._geos);
    const mat = this._own(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.16, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.06 }), this._mats);
    this._bouncerGeo = geo;
    this._bouncerMat = mat;
    this.bouncerPool = [];
    for (let i = 0; i < BOUNCER_POOL; i++) {
      const g = new THREE.Group();
      g.name = 'bouncer';
      const ball = new THREE.Mesh(geo, mat);
      ball.castShadow = true;
      g.add(ball);
      g.visible = false;
      this.root.add(g);
      this.bouncerPool.push({ group: g, ball, used: false, roll: 0 });
    }
  }

  _buildRockets() {
    const geo = this._own(buildRocketGeometry(), this._geos);
    const mat = this._own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.08 }), this._mats);
    this._rocketGeo = geo;
    this._rocketMat = mat;
    const glowGeo = this._own(new THREE.SphereGeometry(0.17, 12, 8), this._geos);
    const glowMat = this._own(new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), this._mats);
    const ringGeo = this._own(new THREE.RingGeometry(1.35, 1.65, 40, 1).rotateX(-Math.PI / 2), this._geos);
    const ringMat = this._own(new THREE.MeshBasicMaterial({ color: 0xff2424, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }), this._mats);
    const tickGeo = this._own(new THREE.BoxGeometry(0.16, 0.02, 0.7), this._geos);
    this.rocketPool = [];
    for (let i = 0; i < ROCKET_POOL; i++) {
      const g = new THREE.Group();
      g.name = 'rocket';
      g.rotation.order = 'YXZ';
      const body = new THREE.Mesh(geo, mat);
      body.castShadow = true;
      g.add(body);
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.z = -0.78;
      g.add(glow);
      g.visible = false;
      this.root.add(g);
      // lock-on reticle under the target kart: ring + 4 ticks, spins
      const ring = new THREE.Group();
      ring.name = 'rocket-lock';
      ring.add(new THREE.Mesh(ringGeo, ringMat));
      for (let t = 0; t < 4; t++) {
        const tick = new THREE.Mesh(tickGeo, ringMat);
        const a = (t / 4) * TAU;
        tick.position.set(Math.sin(a) * 1.95, 0, Math.cos(a) * 1.95);
        tick.rotation.y = a;
        ring.add(tick);
      }
      ring.visible = false;
      this.root.add(ring);
      this.rocketPool.push({ group: g, body, glow, ring, used: false, tail: new THREE.Vector3(), tailValid: false, acc: 0, smokeAcc: 0 });
    }
  }

  _buildStink() {
    const geo = this._own(new THREE.IcosahedronGeometry(1, 3), this._geos);
    const cap = T.maxStinks * (PUFFS + BUBBLES);
    const alpha = new Float32Array(cap);
    this.puffAlpha = new THREE.InstancedBufferAttribute(alpha, 1);
    this.puffAlpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.puffAlpha);
    const mat = this._own(new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uLight: { value: new THREE.Color(0xd2f45e) },
        uDark: { value: new THREE.Color(0x3f6c12) },
        uRim: { value: new THREE.Color(0xf4ffc2) },
        uTime: { value: 0 },
      }]),
      vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG,
      transparent: true, depthWrite: true, fog: true,
    }), this._mats);
    this.puffUniforms = mat.uniforms;
    this.puffMesh = new THREE.InstancedMesh(geo, mat, cap);
    this.puffMesh.name = 'stink-clouds';
    this.puffMesh.frustumCulled = false;
    this.puffMesh.count = 0;
    this.puffMesh.renderOrder = 4;
    this.puffMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.puffMesh);
    // fixed puff layout (unit cloud): a ring of puffs + a taller crown
    this.puffLayout = [];
    for (let i = 0; i < PUFFS; i++) {
      if (i < 6) {
        const a = (i / 6) * TAU;
        this.puffLayout.push({ x: Math.cos(a) * 0.55, y: 0.38 + (i % 2) * 0.12, z: Math.sin(a) * 0.55, r: 0.5 + (i % 3) * 0.07, ph: i * 1.7 });
      } else {
        const a = ((i - 6) / 3) * TAU + 0.5;
        this.puffLayout.push({ x: Math.cos(a) * 0.22, y: 0.85 + (i - 6) * 0.08, z: Math.sin(a) * 0.22, r: 0.48, ph: i * 2.3 });
      }
    }
  }

  _buildBolts() {
    const mat = this._own(new THREE.MeshBasicMaterial({ color: 0xffd81f, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }), this._mats);
    const coreMat = this._own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }), this._mats);
    this.boltPool = [];
    for (let i = 0; i < BOLT_POOL; i++) {
      const geo = this._own(new THREE.BufferGeometry(), this._geos);
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * BOLT_SEGMENTS * 18), 3));
      geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 12;
      const core = new THREE.Mesh(geo, coreMat);
      core.scale.set(0.42, 1, 0.42);
      core.renderOrder = 13;
      core.frustumCulled = false;
      mesh.add(core);
      this.root.add(mesh);
      this.boltPool.push({ mesh, geo, kart: null, t: 0, reshape: 0 });
    }
    this._rnd = Math.random;
  }

  _buildShards() {
    const geo = this._own(new THREE.TetrahedronGeometry(0.36, 0), this._geos);
    geo.scale(1, 0.4, 1.25);
    const mat = this._own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1, metalness: 0.0, transparent: true, opacity: 0.9, emissive: 0x6a6a6a }), this._mats);
    this.shardMesh = new THREE.InstancedMesh(geo, mat, SHARD_POOL);
    this.shardMesh.name = 'box-shards';
    this.shardMesh.frustumCulled = false;
    this.shardMesh.count = 0;
    this.shardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shardMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.shardMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    // remember the viewing camera: shards right in front of the lens are shrunk
    // away (the chase camera flies through the debris of a box the kart just broke)
    this._shardCam = new THREE.Vector3(0, -1e6, 0);
    this.shardMesh.onBeforeRender = (renderer, scene, camera) => { this._shardCam.copy(camera.position); };
    this.root.add(this.shardMesh);
    // struct-of-arrays state, alive shards dense in [0, shardCount)
    const n = SHARD_POOL;
    this.sh = {
      p: new Float32Array(n * 3), v: new Float32Array(n * 3), axis: new Float32Array(n * 3),
      c: new Float32Array(n * 3), ang: new Float32Array(n), spin: new Float32Array(n), age: new Float32Array(n),
    };
    this.shardCount = 0;
    this._col = new THREE.Color();
  }

  _spawnShards(pos, kart) {
    const S = this.sh, col = this._col;
    const kvx = kart ? kart.velocity.x * 0.45 : 0, kvz = kart ? kart.velocity.z * 0.45 : 0;
    const hue0 = Math.random();
    for (let i = 0; i < SHARDS_PER_BOX; i++) {
      let j = this.shardCount;
      if (j >= SHARD_POOL) j = (Math.random() * SHARD_POOL) | 0;     // full: recycle a random one
      else this.shardCount++;
      // random outward direction, biased upward
      let dx = Math.random() * 2 - 1, dy = Math.random() * 0.8 + 0.3, dz = Math.random() * 2 - 1;
      const dl = Math.hypot(dx, dy, dz) || 1;
      const sp = 3 + Math.random() * 4;
      dx /= dl; dy /= dl; dz /= dl;
      S.p[j * 3] = pos.x + dx * 0.4; S.p[j * 3 + 1] = pos.y + dy * 0.4; S.p[j * 3 + 2] = pos.z + dz * 0.4;
      S.v[j * 3] = dx * sp + kvx; S.v[j * 3 + 1] = dy * sp + 2.5; S.v[j * 3 + 2] = dz * sp + kvz;
      let ax = Math.random() - 0.5, ay = Math.random() - 0.5, az = Math.random() - 0.5;
      const al = Math.hypot(ax, ay, az) || 1;
      S.axis[j * 3] = ax / al; S.axis[j * 3 + 1] = ay / al; S.axis[j * 3 + 2] = az / al;
      S.ang[j] = Math.random() * TAU;
      S.spin[j] = (Math.random() < 0.5 ? -1 : 1) * (8 + Math.random() * 10);
      S.age[j] = 0;
      col.setHSL((hue0 + i / SHARDS_PER_BOX) % 1, 0.9, 0.62);
      S.c[j * 3] = col.r; S.c[j * 3 + 1] = col.g; S.c[j * 3 + 2] = col.b;
    }
  }

  _syncShards(dt) {
    const S = this.sh, m = this._m, q = this._q, p = this._p, sc = this._s, ax = this._axis;
    const mesh = this.shardMesh, colors = mesh.instanceColor.array;
    let i = 0;
    while (i < this.shardCount) {
      const age = S.age[i] + dt;
      if (age >= SHARD_LIFE) {
        // swap-remove
        const last = --this.shardCount;
        if (i !== last) {
          for (let k = 0; k < 3; k++) {
            S.p[i * 3 + k] = S.p[last * 3 + k]; S.v[i * 3 + k] = S.v[last * 3 + k];
            S.axis[i * 3 + k] = S.axis[last * 3 + k]; S.c[i * 3 + k] = S.c[last * 3 + k];
          }
          S.ang[i] = S.ang[last]; S.spin[i] = S.spin[last]; S.age[i] = S.age[last];
        }
        continue;
      }
      S.age[i] = age;
      const k = Math.exp(-1.2 * dt);
      S.v[i * 3] *= k; S.v[i * 3 + 2] *= k;
      S.v[i * 3 + 1] -= 16 * dt;
      S.p[i * 3] += S.v[i * 3] * dt; S.p[i * 3 + 1] += S.v[i * 3 + 1] * dt; S.p[i * 3 + 2] += S.v[i * 3 + 2] * dt;
      S.ang[i] += S.spin[i] * dt;
      ax.set(S.axis[i * 3], S.axis[i * 3 + 1], S.axis[i * 3 + 2]);
      q.setFromAxisAngle(ax, S.ang[i]);
      const u = age / SHARD_LIFE;
      p.set(S.p[i * 3], S.p[i * 3 + 1], S.p[i * 3 + 2]);
      const near = Math.min(1, Math.max(0, (p.distanceTo(this._shardCam) - 0.7) / 1.8));
      sc.setScalar(Math.max(0.001, (1 - u * u) * near * near * (3 - 2 * near)));
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
      colors[i * 3] = S.c[i * 3]; colors[i * 3 + 1] = S.c[i * 3 + 1]; colors[i * 3 + 2] = S.c[i * 3 + 2];
      i++;
    }
    mesh.count = this.shardCount;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------- hooks

  onBoxBreak(b, kart) {
    const fx = this.fx;
    const a = this.boxAnim[b.index];
    a.pop = 0;
    this._spawnShards(b.position, kart);
    if (fx) {
      fx.emit('confetti', b.position, this._o.shard);
      fx.emit('sparkle', b.position, this._o.sparkle);
      fx.emit('glow', b.position, this._o.zapGlow);
    }
  }

  onBoxRespawn(b) {
    this.boxAnim[b.index].pop = 0.0001;
    if (this.fx) this.fx.emit('sparkle', b.position, this._o.spawnSparkle);
  }

  onHazardSpawn(h) {
    h.seed = Math.random();
    h.visYaw = Math.random() * TAU;
  }

  onHazardRemove(h, reason) {
    const fx = this.fx;
    if (!fx || reason === 'clear') return;
    if (h.type === 'banana') {
      if (reason !== 'expire') fx.emit('spark', h.position, this._o.banana);
      fx.emit('smoke', h.position, this._o.popSmoke);
    }
  }

  onProjectileSpawn(p) {
    if (p.type === 'bouncer') {
      const slot = freeSlot(this.bouncerPool);
      if (!slot) return;
      slot.used = true;
      slot.roll = 0;
      slot.group.visible = true;
      p.vis = slot;
    } else {
      const slot = freeSlot(this.rocketPool);
      if (!slot) return;
      slot.used = true;
      slot.tailValid = false;
      slot.acc = 0;
      slot.smokeAcc = 0;
      slot.group.visible = true;
      p.vis = slot;
    }
    this._syncProjectile(p, 0);
  }

  onProjectileRemove(p, reason) {
    const slot = p.vis;
    if (slot) {
      slot.used = false;
      slot.group.visible = false;
      if (slot.ring) slot.ring.visible = false;
      p.vis = null;
    }
    const fx = this.fx;
    if (!fx || reason === 'clear') return;
    if (p.type === 'rocket') {
      // centre the blast between the rocket and the kart it hit
      const at = this._v2.copy(p.position);
      const o = reason === 'hit' ? this._o.explosion : this._o.fizzle;
      o.velocity.set(0, 0, 0);
      if (p.victim) {
        at.lerp(p.victim.position, 0.85);
        at.y = Math.max(at.y, p.victim.position.y + 0.9);
        o.velocity.copy(p.victim.velocity).multiplyScalar(0.7);   // the fireball rides along with the kart
      }
      fx.emit('explosion', at, o);
      this._o.blastSmoke.velocity.copy(o.velocity).multiplyScalar(0.5);
      fx.emit('smoke', at, this._o.blastSmoke);
    } else {
      fx.emit('spark', p.position, this._o.pop);
      fx.emit('smoke', p.position, this._o.popSmoke);
    }
  }

  onBounce(p) {
    if (this.fx) this.fx.emit('spark', p.position, this._o.bounceSpark);
  }

  onZapVictim(k) {
    let slot = this.boltPool[0];
    for (const b of this.boltPool) if (!b.kart) { slot = b; break; }
    slot.kart = k;
    slot.t = 0;
    slot.reshape = 0;
    slot.mesh.visible = true;
    writeBolt(slot.geo, 16, this._rnd);
    if (this.fx) {
      this._p.copy(k.position); this._p.y += 0.8;
      this.fx.emit('zap', this._p, this._o.zap);
      this.fx.emit('glow', this._p, this._o.zapGlow);
    }
  }

  onZapUser(k) {
    if (!this.fx) return;
    this._p.copy(k.position); this._p.y += 1.2;
    this.fx.emit('zap', this._p, this._o.zap);
    this.fx.emit('sparkle', this._p, this._o.spawnSparkle);
  }

  onClear() {
    for (const s of this.bouncerPool) { s.used = false; s.group.visible = false; }
    for (const s of this.rocketPool) { s.used = false; s.group.visible = false; s.ring.visible = false; }
    for (const b of this.boltPool) { b.kart = null; b.mesh.visible = false; }
    for (const a of this.boxAnim) a.pop = 1;
    this.bananaMesh.count = 0;
    this.puffMesh.count = 0;
    this.shardCount = 0;
    this.shardMesh.count = 0;
    for (const m of [this.orbitBouncerMesh, this.orbitRocketMesh]) { m.count = 0; m.visible = false; }
    for (const s of this.capoPool) { s.used = false; s.group.visible = false; s.ring.visible = false; }
    for (const s of this.bombPool) { s.used = false; s.group.visible = false; }
    for (const c of this.cupPool) { c.kart = null; c.group.visible = false; }
    for (const a of this.accPool) { a.kart = null; a.group.visible = false; }
    for (const r of this.ringPool) { r.used = false; r.kart = null; r.mesh.visible = false; r.wall.visible = false; }
  }

  // ---------------------------------------------------------------- v4 items

  _buildV4() {
    const own = (x) => this._own(x, this._geos);
    const ownM = (x) => this._own(x, this._mats);
    // orbiting triples: one instanced draw call per type
    this.orbitBouncerMesh = new THREE.InstancedMesh(this._bouncerGeo, this._bouncerMat, ORBIT_POOL);
    this.orbitRocketMesh = new THREE.InstancedMesh(this._rocketGeo, this._rocketMat, ORBIT_POOL);
    for (const m of [this.orbitBouncerMesh, this.orbitRocketMesh]) {
      m.castShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      m.visible = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.root.add(m);
    }
    this.orbitBouncerMesh.name = 'orbit-bouncers';
    this.orbitRocketMesh.name = 'orbit-rockets';

    // Capo Crusher: body + two flapping wings + a soft golden halo; a gold lock-on ring under the target
    const capoGeo = own(buildCapoGeometry());
    const capoMat = ownM(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.55, emissive: 0x7a4300, emissiveIntensity: 0.45 }));
    const wingGeo = own(buildWingGeometry());
    const wingMat = ownM(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05, emissive: 0x3a2a00, emissiveIntensity: 0.25 }));
    const haloGeo = own(new THREE.SphereGeometry(1, 16, 10));
    const haloMat = ownM(new THREE.MeshBasicMaterial({ color: 0xffc23a, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    const ringGeo = own(new THREE.RingGeometry(1.5, 1.85, 48, 1).rotateX(-Math.PI / 2));
    const tickGeo = own(new THREE.BoxGeometry(0.2, 0.02, 0.8));
    this.capoPool = [];
    for (let i = 0; i < CAPO_POOL; i++) {
      const g = new THREE.Group();
      g.name = 'capo';
      g.rotation.order = 'YXZ';
      const tilt = new THREE.Group();                 // pitch (rear back / dive) lives here
      g.add(tilt);
      const body = new THREE.Mesh(capoGeo, capoMat);
      body.castShadow = true;
      tilt.add(body);
      const wings = [];
      for (const sx of [-1, 1]) {
        const w = new THREE.Mesh(wingGeo, wingMat);
        w.position.set(sx * 0.48, 0.18, -0.05);
        w.scale.set(sx, 1, 1);
        w.castShadow = true;
        tilt.add(w);
        wings.push(w);
      }
      const halo = new THREE.Mesh(haloGeo, haloMat);
      halo.scale.setScalar(1.05);
      tilt.add(halo);
      g.visible = false;
      this.root.add(g);
      const ringMat = ownM(new THREE.MeshBasicMaterial({ color: 0xffb21f, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
      const ring = new THREE.Group();
      ring.name = 'capo-lock';
      ring.add(new THREE.Mesh(ringGeo, ringMat));
      for (let t = 0; t < 4; t++) {
        const tick = new THREE.Mesh(tickGeo, ringMat);
        const a = (t / 4) * TAU + Math.PI / 4;
        tick.position.set(Math.sin(a) * 2.25, 0, Math.cos(a) * 2.25);
        tick.rotation.y = a;
        ring.add(tick);
      }
      ring.visible = false;
      this.root.add(ring);
      this.capoPool.push({ group: g, tilt, body, wings, halo, ring, ringMat, used: false, roll: 0, flap: 0, acc: 0 });
    }

    // Meatball Bombs (own material each: the fuse blinks them red)
    const bombGeo = own(buildBombGeometry());
    this.bombPool = [];
    for (let i = 0; i < BOMB_POOL; i++) {
      const mat = ownM(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.0, emissive: 0xff2010, emissiveIntensity: 0 }));
      const g = new THREE.Group();
      g.name = 'meatball-bomb';
      const mesh = new THREE.Mesh(bombGeo, mat);
      mesh.castShadow = true;
      g.add(mesh);
      g.visible = false;
      this.root.add(g);
      this.bombPool.push({ group: g, mesh, mat, used: false, acc: 0, squash: 0 });
    }

    // Espresso cups popping up over each victim, then tipping onto them
    const cupGeo = own(buildCupGeometry());
    const cupMat = ownM(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.0, emissive: 0x3a3330, emissiveIntensity: 0.6 }));
    this.cupPool = [];
    for (let i = 0; i < CUP_POOL; i++) {
      const g = new THREE.Group();
      g.name = 'espresso-cup';
      g.rotation.order = 'YXZ';
      const mesh = new THREE.Mesh(cupGeo, cupMat);
      mesh.castShadow = true;
      g.add(mesh);
      g.visible = false;
      this.root.add(g);
      this.cupPool.push({ group: g, kart: null, from: null, t: 0, splashed: false });
    }

    // Accordions squeezing over their player
    const endGeo = own(buildAccordionEnds());
    const bellowsGeo = own(buildBellowsGeometry());
    const accMat = ownM(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 }));
    this.accPool = [];
    for (let i = 0; i < ACC_POOL; i++) {
      const g = new THREE.Group();
      g.name = 'accordion';
      const left = new THREE.Mesh(endGeo, accMat), right = new THREE.Mesh(endGeo, accMat), bellows = new THREE.Mesh(bellowsGeo, accMat);
      right.scale.x = -1;
      g.add(left, right, bellows);
      g.visible = false;
      this.root.add(g);
      this.accPool.push({ group: g, left, right, bellows, kart: null, t: 0 });
    }

    // expanding blast / shockwave rings: a bright band on the road + a glowing wall
    // fading upward (one material each so they fade independently)
    const blastGeo = own(new THREE.RingGeometry(0.9, 1.0, 64, 1).rotateX(-Math.PI / 2));
    const wallGeo = own(new THREE.CylinderGeometry(1, 1, 1, 64, 1, true).translate(0, 0.5, 0));
    {
      const pos = wallGeo.attributes.position, col = new Float32Array(pos.count * 4);
      for (let i = 0; i < pos.count; i++) { col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1; col[i * 4 + 3] = pos.getY(i) > 0.5 ? 0 : 0.85; }
      wallGeo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    }
    this.ringPool = [];
    for (let i = 0; i < RING_POOL; i++) {
      const mat = ownM(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
      const wallMat = ownM(new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
      const mesh = new THREE.Mesh(blastGeo, mat);
      mesh.name = 'blast-ring';
      mesh.visible = false;
      mesh.renderOrder = 12;
      mesh.frustumCulled = false;
      const wall = new THREE.Mesh(wallGeo, wallMat);
      wall.name = 'blast-wall';
      wall.visible = false;
      wall.renderOrder = 12;
      wall.frustumCulled = false;
      this.root.add(mesh, wall);
      this.ringPool.push({ mesh, mat, wall, wallMat, t: 0, life: 0.4, radius: 1, height: 1.4, used: false, kart: null, y: 0 });
    }

    // particle option objects
    this._o2 = {
      glitter: { count: 0, velocity: new THREE.Vector3(), spread: 1.6, size: 0.24, life: 0.5, radius: 0.5, from: new THREE.Vector3() },
      glitterBurst: { count: 30, spread: 6, size: 0.3, life: 0.7, radius: 0.8 },
      capoBlast: { count: 46, spread: 13, size: 1.3, alpha: 0.8, velocity: new THREE.Vector3(), color: 0xfff0a0 },
      bombBlast: { count: 34, spread: 10, size: 1.15, alpha: 0.8, velocity: new THREE.Vector3() },
      bombChunks: { count: 16, spread: 9, size: 0.2, life: 0.8, color: 0x7a3a1c },
      sauce: { count: 14, spread: 7, size: 0.22, color: 0xd2361c },
      fuse: { count: 0, velocity: new THREE.Vector3(0, 1.2, 0), spread: 2.2, size: 0.09, life: 0.22, color: 0xffd36b },
      fuseGlow: { count: 0, spread: 0.2, size: 0.32, life: 0.08, color: 0xffb040, radius: 0.02 },
      thud: { count: 8, spread: 2.2, size: 0.45, life: 0.6, color: 0xc9b48a, alpha: 0.5 },
      coffee: { count: 26, velocity: new THREE.Vector3(), spread: 5, radius: 0.6 },
      crema: { count: 12, velocity: new THREE.Vector3(), spread: 4, radius: 0.5 },
      sparkleNotes: { count: 22, spread: 5, size: 0.32, life: 0.8, radius: 1.0, color: 'rainbow' },
      poof: { count: 14, spread: 3, size: 0.8, alpha: 0.5, color: 0xf3ead2 },
      steam: { count: 1, velocity: new THREE.Vector3(0, 1.6, 0), spread: 0.4, size: 0.32, life: 0.7, alpha: 0.45, color: 0xffffff, radius: 0.12 },
      foam: { count: 24, velocity: new THREE.Vector3(), spread: 3.2, radius: 0.7 },
    };
  }

  _ring(at, radius, color, life = 0.4, y = 0.15, height = 1.4) {
    let r = null;
    for (const x of this.ringPool) if (!x.used) { r = x; break; }
    if (!r) { r = this.ringPool[0]; for (const x of this.ringPool) if (x.t > r.t) r = x; }
    r.used = true; r.t = 0; r.life = life; r.radius = radius; r.y = y; r.height = height;
    r.mat.color.set(color);
    r.wallMat.color.set(color);
    r.mesh.position.set(at.x, at.y + y, at.z);
    r.wall.position.copy(r.mesh.position);
    r.mesh.visible = true;
    r.wall.visible = height > 0;
    return r;
  }

  // ---- hooks (called by ItemSystem)

  onAttach(a) { a.visYaw = Math.random() * TAU; }
  onAttachRemove(a, reason) {
    const fx = this.fx;
    if (!fx || reason === 'clear' || reason === 'use' || reason === 'drop') return;
    fx.emit('spark', a.position, this._o.pop);
    fx.emit('smoke', a.position, this._o.popSmoke);
  }

  onCapoSpawn(c) {
    const slot = freeSlot(this.capoPool);
    if (!slot) return;
    slot.used = true;
    slot.roll = 0;
    slot.group.visible = true;
    c.vis = slot;
    if (this.fx) this.fx.emit('glitter', c.position, this._o2.glitterBurst);
  }

  onCapoRemove(c, reason) {
    const slot = c.vis;
    if (slot) { slot.used = false; slot.group.visible = false; slot.ring.visible = false; c.vis = null; }
    if (!this.fx || reason === 'clear') return;
    if (reason === 'blast') {
      const at = this._v2.copy(c.target ? c.target.position : c.position);
      at.y += 0.8;
      this.fx.emit('explosion', at, this._o2.capoBlast);
      this.fx.emit('glitter', at, this._o2.glitterBurst);
      this._o.blastSmoke.velocity.set(0, 0, 0);
      this.fx.emit('smoke', at, this._o.blastSmoke);
      this._ring(at, ITEM.capoBlastRadius, 0xffc23a, 0.5, -0.65, 2.6);
      this._ring(at, ITEM.capoBlastRadius * 0.6, 0xffffff, 0.3, -0.6, 0);
    } else {
      // fizzle / blocked: a golden poof
      this.fx.emit('glitter', c.position, this._o2.glitterBurst);
      this.fx.emit('smoke', c.position, this._o2.poof);
    }
  }

  onBombSpawn(b) {
    const slot = freeSlot(this.bombPool);
    if (!slot) return;
    slot.used = true;
    slot.acc = 0;
    slot.squash = 0;
    slot.group.visible = true;
    slot.group.rotation.set(0, Math.random() * TAU, 0);
    b.vis = slot;
    b.spin = 0;
  }

  onBombLand(b) {
    if (b.vis) b.vis.squash = 1;
    if (this.fx) { this._p.copy(b.position); this._p.y -= 0.4; this.fx.emit('dust', this._p, this._o2.thud); }
  }

  onBombRemove(b, reason) {
    const slot = b.vis;
    if (slot) { slot.used = false; slot.group.visible = false; slot.mat.emissiveIntensity = 0; b.vis = null; }
    if (this.fx && reason === 'blocked') { this.fx.emit('smoke', b.position, this._o2.poof); this.fx.emit('spark', b.position, this._o.pop); }
  }

  onBlast(at, kind) {
    if (kind !== 'bomb' || !this.fx) return;
    const p = this._v2.copy(at);
    p.y += 0.6;
    this.fx.emit('explosion', p, this._o2.bombBlast);
    this.fx.emit('spark', p, this._o2.bombChunks);
    this.fx.emit('crema', p, this._o2.sauce);
    this._o.blastSmoke.velocity.set(0, 0, 0);
    this.fx.emit('smoke', p, this._o.blastSmoke);
    this._ring(at, ITEM.bombBlastRadius, 0xff8a2a, 0.45, 0.12, 2.0);
    this._ring(at, ITEM.bombCoreRadius, 0xfff0c0, 0.3, 0.14, 0);
  }

  onEspressoCup(victim, from) {
    let slot = null;
    for (const c of this.cupPool) if (!c.kart) { slot = c; break; }
    if (!slot) return;
    slot.kart = victim;
    slot.from = from;
    slot.t = 0;
    slot.splashed = false;
    slot.group.visible = true;
    if (this.fx && from) { this._p.copy(from.position); this._p.y += 1.2; this.fx.emit('crema', this._p, this._o2.crema); }
  }

  onEspressoSplash(k) {
    if (!this.fx) return;
    const o = this._o2.coffee, c = this._o2.crema;
    this._p.copy(k.position); this._p.y += 1.3;
    o.velocity.copy(k.velocity).multiplyScalar(0.8);
    c.velocity.copy(o.velocity);
    this.fx.emit('coffee', this._p, o);
    this.fx.emit('crema', this._p, c);
  }

  onAccordion(k) {
    let slot = null;
    for (const a of this.accPool) if (!a.kart) { slot = a; break; }
    if (!slot) slot = this.accPool[0];
    slot.kart = k;
    slot.t = 0;
    slot.group.visible = true;
    const r = this._ring(k.position, ITEM.accordionItemRadius, 0xff6fa3, 0.4, 0.1, 1.8);
    r.kart = k;
    const r2 = this._ring(k.position, ITEM.accordionKartRadius, 0xfff2f8, 0.3, 0.12, 1.2);
    r2.kart = k;
    if (this.fx) { this._p.copy(k.position); this._p.y += 2.2; this.fx.emit('sparkle', this._p, this._o2.sparkleNotes); }
  }

  onBeer(k, phase) {
    if (!this.fx) return;
    this._p.copy(k.position); this._p.y += 1.0;
    const o = this._o2.foam;
    o.velocity.copy(k.velocity).multiplyScalar(0.7);
    if (phase === 'end') { o.count = 30; this.fx.emit('foam', this._p, o); this.fx.emit('sparkle', this._p, this._o.sparkle); }
    else if (phase === 'ride') { o.count = 22; this.fx.emit('foam', this._p, o); }
  }

  // ---- per-substep sync

  _syncV4(dt, t) {
    const m = this._m, q = this._q, p = this._p, s = this._s, e = this._e;
    // orbiters
    let nb = 0, nr = 0;
    for (const a of this.sys.attached) {
      if (a.type === 'banana' || !a.active) continue;
      const k = a.owner;
      const th = Math.atan2(a.position.x - k.position.x, a.position.z - k.position.z);
      if (a.type === 'bouncer') {
        if (nb >= ORBIT_POOL) continue;
        e.set(t * 9 + a.slot, th + Math.PI / 2, 0, 'YXZ');
        q.setFromEuler(e);
        s.setScalar(1);
        m.compose(a.position, q, s);
        this.orbitBouncerMesh.setMatrixAt(nb++, m);
      } else {
        if (nr >= ORBIT_POOL) continue;
        // nose along the orbit (counter-clockwise seen from above = +th), little bob
        e.set(0, th + Math.PI / 2, Math.sin(t * 7 + a.slot * 2) * 0.25, 'YXZ');
        q.setFromEuler(e);
        s.setScalar(0.8);
        p.copy(a.position); p.y += Math.sin(t * 5 + a.slot * 2.1) * 0.08;
        m.compose(p, q, s);
        this.orbitRocketMesh.setMatrixAt(nr++, m);
        if (this.fx && dt > 0 && (a.uid + Math.floor(t * 30)) % 3 === 0) {
          const o = this._o.flame;
          o.count = 1; o.from.copy(a.prev); o.velocity.set(0, 0.3, 0);
          this.fx.emit('flame', a.position, o);
        }
      }
    }
    this.orbitBouncerMesh.count = nb; this.orbitBouncerMesh.visible = nb > 0;
    this.orbitRocketMesh.count = nr; this.orbitRocketMesh.visible = nr > 0;
    if (nb) this.orbitBouncerMesh.instanceMatrix.needsUpdate = true;
    if (nr) this.orbitRocketMesh.instanceMatrix.needsUpdate = true;

    // capos
    for (const c of this.sys.capos) {
      const slot = c.vis;
      if (!slot) continue;
      const g = slot.group;
      g.position.copy(c.position);
      const yaw = Math.atan2(c.dir.x, c.dir.z);
      g.rotation.y = yaw;
      let pitch = 0, flapRate = 9, flapAmp = 0.5;
      if (c.phase === 'ground') {
        slot.roll += (c.speed * dt) / 0.62;           // rolls along the road ...
        slot.body.rotation.set(slot.roll, 0, 0);
        flapRate = 14; flapAmp = 0.35;                // ... wings buzzing
      } else {
        slot.body.rotation.x = damp(slot.body.rotation.x % TAU, 0, 6, dt);
        if (c.phase === 'windup') { pitch = -0.9 * clamp(c.phaseT / ITEM.capoWindup, 0, 1); flapRate = 4; flapAmp = 0.9; }
        else if (c.phase === 'dive') { pitch = 1.3; flapAmp = 0.15; }
      }
      slot.tilt.rotation.x = damp(slot.tilt.rotation.x, pitch, 14, dt);
      slot.flap += dt * flapRate;
      const f = Math.sin(slot.flap * TAU) * flapAmp;
      slot.wings[0].rotation.set(0, 0, -f);
      slot.wings[1].rotation.set(0, 0, f);
      slot.halo.scale.setScalar(1.0 + 0.12 * Math.sin(t * 10));
      // gold lock-on ring under the target
      const tgt = c.target;
      if (tgt) {
        slot.ring.visible = true;
        slot.ring.position.set(tgt.position.x, tgt.position.y + 0.07, tgt.position.z);
        slot.ring.rotation.y = -t * (c.locked ? 5 : 2);
        const pulse = c.locked ? 0.9 + 0.18 * Math.sin(t * 26) : 1.1 + 0.08 * Math.sin(t * 8);
        slot.ring.scale.setScalar(pulse);
        slot.ringMat.color.setHex(c.locked && Math.sin(t * 26) > 0 ? 0xff3a1f : 0xffb21f);
      }
      if (this.fx && dt > 0) {
        slot.acc += dt * (c.phase === 'ground' ? 60 : 35);
        const n = Math.floor(slot.acc);
        if (n > 0) {
          slot.acc -= n;
          const o = this._o2.glitter;
          o.count = n; o.from.copy(c.prev);
          o.velocity.set(-c.dir.x * 3, 0.8, -c.dir.z * 3);
          this.fx.emit('glitter', c.position, o);
        }
      }
    }

    // bombs: tumble in flight, thud squash, fuse sparks, blink before the bang
    for (const b of this.sys.bombs) {
      const slot = b.vis;
      if (!slot) continue;
      const g = slot.group;
      g.position.copy(b.position);
      if (b.phase === 'air') { b.spin += dt * 7; g.rotation.x = b.spin; }
      else if (b.phase === 'roll') { const hs = Math.hypot(b.vel.x, b.vel.z); g.rotation.y = Math.atan2(b.vel.x, b.vel.z); b.spin += (hs * dt) / T.bombRadius; g.rotation.x = b.spin; }
      else g.rotation.x = damp(g.rotation.x, Math.round(g.rotation.x / TAU) * TAU, 6, dt);
      slot.squash = Math.max(0, slot.squash - dt * 4);
      const sq = Math.sin(slot.squash * Math.PI) * 0.22;
      slot.mesh.scale.set(1 + sq, 1 - sq, 1 + sq);
      const fuse = b.fuse >= 0 ? b.fuse : 99;
      const hz = fuse < 1 ? 9 : fuse < 2 ? 4 : 1.5;
      const sn = Math.max(0, Math.sin(t * hz * TAU));
      const blink = b.fuse >= 0 ? sn * sn * sn * (fuse < 1 ? 0.6 : 0.3) : 0;
      slot.mat.emissiveIntensity = blink;
      if (this.fx && dt > 0) {
        slot.acc += dt * 45;
        const n = Math.floor(slot.acc);
        if (n > 0) {
          slot.acc -= n;
          slot.mesh.updateWorldMatrix(true, false);
          p.copy(BOMB_FUSE_TIP).applyMatrix4(slot.mesh.matrixWorld);
          this._o2.fuse.count = n;
          this.fx.emit('spark', p, this._o2.fuse);
          this._o2.fuseGlow.count = 1;
          this.fx.emit('glow', p, this._o2.fuseGlow);
        }
      }
    }

    // espresso cups: pop up over the victim, wobble, tip onto it
    const D = ITEM.espressoDelay;
    for (const c of this.cupPool) {
      if (!c.kart) continue;
      c.t += dt;
      const k = c.kart;
      const u = c.t / D;
      if (u >= 1.35) { c.kart = null; c.group.visible = false; continue; }
      const pop = clamp(c.t / 0.18, 0, 1);
      const sc = 1.5 * (u < 1 ? Math.max(0.01, easeOutBack(pop)) : Math.max(0.01, 1 - (u - 1) / 0.35));
      const g = c.group;
      g.position.set(k.position.x, k.position.y + 2.6 + Math.sin(c.t * 9) * 0.06, k.position.z);
      g.rotation.set(u < 0.75 ? Math.sin(c.t * 16) * 0.12 : -2.3 * clamp((u - 0.75) / 0.3, 0, 1), k.yaw, Math.sin(c.t * 13) * 0.1);
      g.scale.setScalar(sc);
      if (!c.splashed && u >= 1) c.splashed = true;
      if (this.fx && dt > 0 && u < 0.8 && (Math.floor(c.t * 24) !== Math.floor((c.t - dt) * 24))) {
        p.set(g.position.x, g.position.y + 0.55 * sc, g.position.z);
        this.fx.emit('smoke', p, this._o2.steam);
      }
    }

    // accordions: squeeze-squeeze-honk over the player
    for (const a of this.accPool) {
      if (!a.kart) continue;
      a.t += dt;
      const u = a.t / 0.6;
      if (u >= 1) { a.kart = null; a.group.visible = false; continue; }
      const k = a.kart;
      const w = 0.55 + 0.45 * Math.cos(u * TAU * 1.5);       // in, out, in
      const sc = Math.min(1, a.t / 0.08) * (u > 0.85 ? (1 - u) / 0.15 : 1) * 2.1;
      a.group.position.set(k.position.x, k.position.y + 2.9, k.position.z);
      a.group.rotation.set(0, k.yaw, Math.sin(a.t * 20) * 0.08);
      a.group.scale.setScalar(Math.max(0.01, sc));
      a.bellows.scale.x = w;
      a.left.position.x = -w / 2 - 0.08;
      a.right.position.x = w / 2 + 0.08;
    }

    // blast rings
    for (const r of this.ringPool) {
      if (!r.used) continue;
      r.t += dt;
      const u = r.t / r.life;
      if (u >= 1) { r.used = false; r.mesh.visible = false; r.wall.visible = false; r.kart = null; continue; }
      if (r.kart) r.mesh.position.set(r.kart.position.x, r.kart.position.y + r.y, r.kart.position.z);
      const e2 = 1 - (1 - u) * (1 - u);
      const rad = Math.max(0.05, r.radius * (0.15 + 0.85 * e2));
      r.mesh.scale.setScalar(rad);
      r.mat.opacity = 0.8 * (1 - u) * (1 - u);
      if (r.wall.visible) {
        r.wall.position.copy(r.mesh.position);
        r.wall.scale.set(rad, r.height * (1 - 0.5 * u), rad);
        r.wallMat.opacity = 0.75 * (1 - u);
      }
    }
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    this.time += dt;
    const t = this.time;
    this.boxUniforms.uTime.value = t;
    this.qUniforms.uTime.value = t;
    this.puffUniforms.uTime.value = t;
    this._syncBoxes(dt, t);
    this._syncHazards(dt, t);
    for (const p of this.sys.projectiles) this._syncProjectile(p, dt);
    this._syncBolts(dt);
    this._syncShards(dt);
    this._syncV4(dt, t);
  }

  _syncBoxes(dt, t) {
    const boxes = this.sys.boxes, m = this._m, q = this._q, p = this._p, s = this._s;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i], a = this.boxAnim[i];
      if (!b.active) {
        this.boxMesh.setMatrixAt(i, this._zero);
        this.qMesh.setMatrixAt(i, this._zero);
        continue;
      }
      if (a.pop < 1) a.pop = Math.min(1, a.pop + dt / 0.38);
      const sc = a.pop < 1 ? Math.max(0, easeOutBack(a.pop)) : 1;
      p.copy(b.position);
      p.y += Math.sin(t * 2.1 + a.phase) * 0.12;
      this._e.set(0.42, t * 1.25 + a.phase, 0.42, 'YXZ');
      q.setFromEuler(this._e);
      s.setScalar(sc);
      m.compose(p, q, s);
      this.boxMesh.setMatrixAt(i, m);
      q.identity();
      m.compose(p, q, s);
      this.qMesh.setMatrixAt(i, m);
    }
    this.boxMesh.instanceMatrix.needsUpdate = true;
    this.qMesh.instanceMatrix.needsUpdate = true;
  }

  _syncHazards(dt, t) {
    const m = this._m, q = this._q, p = this._p, s = this._s;
    let nb = 0, np = 0;
    const alpha = this.puffAlpha.array;
    const lay = this.puffLayout;
    for (const h of this.sys.hazards) {
      if (h.type === 'banana') {
        if (nb >= T.maxBananas) continue;
        // little drop from the kart's tail, then a squash on landing
        const drop = clamp(h.age / 0.28, 0, 1);
        p.copy(h.position);
        p.y += h.dropFrom * (1 - drop * drop);
        const land = h.age > 0.28 ? Math.max(0, 1 - (h.age - 0.28) / 0.25) : 0;
        const squash = 1 - 0.22 * Math.sin(land * Math.PI);
        const grow = 0.55 + 0.45 * drop;
        const fade = h.life - h.age < 1 ? Math.max(0.01, h.life - h.age) : 1;
        s.set(grow * fade * (2 - squash), grow * fade * squash, grow * fade * (2 - squash));
        q.setFromAxisAngle(_up, h.visYaw + (1 - drop) * 3);
        m.compose(p, q, s);
        this.bananaMesh.setMatrixAt(nb++, m);
      } else {
        // puffy cloud: puffs breathe out of phase; grows in, shrinks out
        const left = h.life - h.age;
        const grow = h.age < 0.45 ? easeOutBack(h.age / 0.45) : 1;
        const shrink = left < T.stinkShrinkTime ? left / T.stinkShrinkTime : 1;
        const R = h.radius * 0.82 * grow * shrink;
        const a = 0.9 * Math.min(1, h.age / 0.25) * Math.min(1, left / 0.6);
        for (let i = 0; i < PUFFS && np < this.puffMesh.instanceMatrix.count; i++) {
          const L = lay[i];
          const br = 1 + 0.09 * Math.sin(t * 3.1 + L.ph + h.seed * 10);
          const sway = Math.sin(t * 1.3 + L.ph) * 0.06;
          p.set(h.position.x + (L.x + sway) * R, h.position.y + L.y * R, h.position.z + (L.z - sway) * R);
          s.setScalar(L.r * R * br);
          q.identity();
          m.compose(p, q, s);
          this.puffMesh.setMatrixAt(np, m);
          alpha[np] = a;
          np++;
        }
        // small puffs bubbling up from the crown, growing and fading on a loop
        for (let i = 0; i < BUBBLES && np < this.puffMesh.instanceMatrix.count; i++) {
          const ph = (t * 0.55 + i / BUBBLES + h.seed) % 1;
          const ang = h.seed * 20 + i * 2.1;
          const rr = R * (0.25 + 0.2 * Math.sin(ph * 3 + i));
          p.set(h.position.x + Math.cos(ang) * rr, h.position.y + R * (0.95 + ph * 0.9), h.position.z + Math.sin(ang) * rr);
          s.setScalar(R * (0.12 + 0.18 * ph));
          q.identity();
          m.compose(p, q, s);
          this.puffMesh.setMatrixAt(np, m);
          alpha[np] = a * Math.min(1, ph * 5) * (1 - ph);
          np++;
        }
        // rising wisps (rate-based, so substep count doesn't matter)
        if (this.fx && dt > 0) {
          h.wisp = (h.wisp || 0) + dt * 7 * shrink;
          if (h.wisp >= 1) {
            h.wisp -= 1;
            this._v.copy(h.position); this._v.y += R * 0.6;
            this._o.stink.radius = R * 0.7;
            this.fx.emit('stink', this._v, this._o.stink);
          }
        }
      }
    }
    // trailing peels of Banana Bunches: dragged along, wobbling a little
    const cap = this.bananaMesh.instanceMatrix.count;
    for (const a of this.sys.attached) {
      if (a.type !== 'banana' || !a.active || nb >= cap) continue;
      const pop = clamp(a.age / 0.3, 0, 1);
      s.setScalar(0.85 * Math.max(0.01, easeOutBack(pop)));
      this._e.set(Math.sin(t * 13 + a.uid) * 0.1, a.visYaw + Math.sin(t * 3 + a.slot) * 0.3, Math.cos(t * 11 + a.uid) * 0.1, 'YXZ');
      q.setFromEuler(this._e);
      m.compose(a.position, q, s);
      this.bananaMesh.setMatrixAt(nb++, m);
    }
    this.bananaMesh.count = nb;
    this.bananaMesh.instanceMatrix.needsUpdate = true;
    this.puffMesh.count = np;
    this.puffMesh.instanceMatrix.needsUpdate = true;
    this.puffAlpha.needsUpdate = true;
  }

  _syncProjectile(p, dt) {
    const slot = p.vis;
    if (!slot) return;
    const g = slot.group;
    g.position.copy(p.position);
    const yaw = Math.atan2(p.dir.x, p.dir.z);
    if (p.type === 'bouncer') {
      g.rotation.y = yaw;
      slot.roll += (p.speed * dt) / T.bouncerRadius;
      slot.ball.rotation.x = slot.roll;
      if (this.fx && dt > 0) {
        // faint green glow trail
        slot.acc = (slot.acc || 0) + dt * 70;
        const n = Math.floor(slot.acc);
        if (n > 0) {
          slot.acc -= n;
          const o = this._o.glowGreen;
          o.count = n;
          o.from.copy(p.prev);
          this.fx.emit('glow', p.position, o);
        }
      }
      return;
    }
    // rocket: point along travel (incl. climb), wobble roll, flicker glow
    const dy = p.position.y - p.prev.y;
    const hd = Math.hypot(p.position.x - p.prev.x, p.position.z - p.prev.z);
    g.rotation.set(hd > 1e-4 ? -Math.atan2(dy, hd) : 0, yaw, Math.sin(this.time * 9 + p.uid) * 0.25);
    const fl = 0.8 + 0.3 * Math.sin(this.time * 60 + p.uid * 3) + 0.15 * Math.random();
    slot.glow.scale.set(fl, fl, 1.8 * fl);
    // lock-on reticle under the target
    const tgt = p.target;
    if (tgt && (p.mode === 'home' || p.mode === 'track')) {
      slot.ring.visible = true;
      slot.ring.position.set(tgt.position.x, tgt.position.y + 0.06, tgt.position.z);
      slot.ring.rotation.y = this.time * 3;
      const pulse = p.mode === 'home' ? 0.85 + 0.15 * Math.sin(this.time * 22) : 1.15;
      slot.ring.scale.setScalar(pulse);
    } else {
      slot.ring.visible = false;
    }
    if (!this.fx || !(dt > 0)) return;
    // flame + smoke trail from the nozzle, spread along last frame's path
    const tail = this._v.set(0, 0, -0.85).applyEuler(g.rotation).add(p.position);
    if (!slot.tailValid) { slot.tail.copy(tail); slot.tailValid = true; }
    slot.acc += dt * 220;
    let n = Math.floor(slot.acc);
    if (n > 0) {
      slot.acc -= n;
      const o = this._o.flame;
      o.count = n;
      o.from.copy(slot.tail);
      o.velocity.set(-p.dir.x * 7, 0.5, -p.dir.z * 7);
      this.fx.emit('flame', tail, o);
    }
    slot.smokeAcc += dt * 70;
    n = Math.floor(slot.smokeAcc);
    if (n > 0) {
      slot.smokeAcc -= n;
      const o = this._o.smoke;
      o.count = n;
      o.from.copy(slot.tail);
      o.velocity.set(-p.dir.x * 2, 0.8, -p.dir.z * 2);
      this.fx.emit('smoke', tail, o);
    }
    slot.tail.copy(tail);
  }

  _syncBolts(dt) {
    for (const b of this.boltPool) {
      if (!b.kart) continue;
      b.t += dt;
      if (b.t >= BOLT_TIME) { b.kart = null; b.mesh.visible = false; continue; }
      b.reshape -= dt;
      if (b.reshape <= 0) { b.reshape = 0.06; writeBolt(b.geo, 16, this._rnd); }
      b.mesh.position.copy(b.kart.position);
      b.mesh.position.y += 0.7;
      // flicker: strike, dim, re-strike, fade
      const u = b.t / BOLT_TIME;
      const on = u < 0.18 || (u > 0.3 && u < 0.62) || (u > 0.72 && Math.random() < 0.5);
      b.mesh.visible = on;
      const w = 1 + (1 - u) * 0.5;
      b.mesh.scale.set(w, 1, w);
    }
  }

  dispose() {
    this.scene.remove(this.root);
    for (const g of this._geos) g.dispose();
    for (const m of this._mats) m.dispose();
    for (const t of this._texs) t.dispose();
    this.boxMesh.dispose();
    this.qMesh.dispose();
    this.bananaMesh.dispose();
    this.puffMesh.dispose();
    this.shardMesh.dispose();
    this.orbitBouncerMesh.dispose();
    this.orbitRocketMesh.dispose();
    this._geos.length = this._mats.length = this._texs.length = 0;
  }
}

