# TTTKart — Architecture & Module Contracts

A 3D kart racer that runs in the desktop browser (Three.js, no build step) plus a
phone controller page: the phone scans a QR code, connects over the LAN, and
becomes a steering wheel (rotate phone to steer; on-screen GAS / BRAKE / DRIFT /
ITEM buttons).

**All characters, names, items and art are ORIGINAL.** Never use Nintendo (or
any other) IP: no Mario/Luigi/Yoshi/Bowser/etc. names or likenesses, no
"Mushroom", "Green Shell", "Blue Shell", "Bullet Bill", "Rainbow Road". Use the
names defined here.

This document records the original module interfaces and subsequent extensions.
Section 13 describes the current roster, customization system, and in-game title
and supersedes earlier descriptions where they differ. The runtime code is the
source of truth; update affected callers and this reference when interfaces change.

---------------------------------------------------------------------------

## 0. Runtime / tooling

* Node 22.12+ (developed on Node 26); the project root contains this file. `package.json`
  has `"type": "module"` → all `.js` files are ES modules (server too).
* Deps: `express@5`, `socket.io@4`, `qrcode`, `selfsigned@5` (async API:
  `await selfsigned.generate(attrs, opts)`), `three@0.186`. Dev: `puppeteer-core`,
  `socket.io-client`.
* Browser imports use an import map in every HTML page:
  ```html
  <script type="importmap">{"imports":{"three":"/vendor/three/build/three.module.js","three/addons/":"/vendor/three/examples/jsm/"}}</script>
  ```
  Modules import three as `import * as THREE from 'three'` and each other with
  relative paths **including `.js`** (`import { bus } from './bus.js'`). In Node,
  `'three'` resolves to node_modules/three, so the same modules run headless.
* Socket.IO browser client: classic script `<script src="/socket.io/socket.io.js"></script>`
  (exposes `window.io`), loaded before module scripts.
* **Node-safe modules** (must not touch `window`/`document`/`navigator`/canvas at
  import time or in their logic paths): `config.js`, `bus.js`, `utils.js`,
  `track-def.js`, `track.js`, `kart.js`, `ai.js`, `race.js`, `items.js` (when
  constructed with `scene: null`). These power `tools/sim.mjs`, a headless race
  simulation.
* Dev tools (already written):
  * `node tools/devserver.mjs <port>` — static server: `/` → `public/`,
    `/vendor/three/` → `node_modules/three/`. Use a unique port for each running
    instance when opening sandbox pages under `public/dev/`.
  * `node tools/shot.mjs <url> --out file.png --wait 3000 --actions '[...]'` —
    headless Chrome with real GPU WebGL. Prints console logs/errors. View the PNG
    in an image viewer. `--mobile --w 844 --h 390` emulates a landscape phone.
  * `node tools/track-check.mjs` — track sanity checks.
* Install dependencies locally and stop development servers when finished.
  Keep generated screenshots and test artifacts out of commits.

## 1. Module layout

| Path | Purpose |
|---|---|
| `public/js/config.js`, `bus.js`, `utils.js`, `track.js`, `track-def.js` | Shared configuration, events, utilities, and track geometry |
| `server.js`, `public/pad.html`, `public/css/pad.css`, `public/js/pad.js`, `public/js/net.js` | Local server, phone controller, and network protocol |
| `public/js/world.js`, `public/js/textures.js` | Scenery and procedural textures |
| `public/js/kart.js`, `characters.js`, `customize.js`, `kartview.js`, `effects.js`, `camera.js` | Physics, roster, customization, models, effects, and camera |
| `public/js/audio.js`, `input.js`, `hud.js`, `public/css/game.css` | Audio, controls, and race HUD |
| `public/js/items.js`, `ai.js`, `race.js`, `tools/sim.mjs` | Items, CPU drivers, race rules, and simulation |
| `public/index.html`, `public/js/main.js`, `public/js/menus.js`, `public/css/menus.css` | Application state, menus, and race loop |

## 2. Conventions

* Y up, meters, seconds, radians. Track ≈ 978 m loop, laps take ~35–40 s.
* **Heading**: `forward = (sin yaw, 0, cos yaw)`, `right = (-cos yaw, 0, sin yaw)`.
  Increasing yaw turns LEFT; a right turn decreases yaw. `object.rotation.y = yaw`
  makes a model built facing **+Z** face forward. All kart/character models are
  built facing +Z with origin at ground level, centered.
* `steer` input ∈ [-1, 1], **+1 = steer RIGHT**.
* Track coordinates: `s` = arc length from start line in [0, L); `lateral` =
  signed horizontal offset from centerline, **+ = right** of driving direction.
* Colors: hex numbers (0xff3344) in three code, CSS strings in DOM code.
* Use `bus` (bus.js) for cross-module notifications (catalog in §9). Anything that
  subscribes must keep the unsubscribe fns and call them in `dispose()`.
* Performance budget (whole game, 1080p laptop iGPU at 60 fps): ≤ 250 draw calls,
  ≤ 400k triangles, one shadow-casting directional light (2048 map) that follows
  the player, no per-frame allocations in hot paths (reuse Vector3s), no
  per-frame DOM layout thrash (update text only when it changes).

## 3. Track — `track.js` (written) + `track-def.js`

```js
import { Track, getTrack, CURB_WIDTH } from './track.js';
const track = getTrack();          // shared instance (or new Track())
track.length; track.N; track.spacing;          // ~978 m, 978 samples, ~1 m
track.samples[i] = { index, s, pos: Vector3, tangent: Vector3 (horizontal unit),
  right: Vector3, yaw, halfWidth, wallL, wallR, curvature (+ = right turn, 1/m), slope };
// typed arrays: px py pz tx tz rx rz hw wl wr curv slope yawArr racingLine
track.project(pos, hint = -1, out = {}) → out:
  { index (use as next hint), f, s, lateral, height (road y incl. ramps),
    centerY, halfWidth, wallL, wallR, curvature, slope, yaw,
    tangent: Vector3, right: Vector3, surface: 'road'|'boost'|'curb'|'offroad',
    onRamp: bool, boostPad: pad|null }
track.pointAt(s, lateral = 0, out?) → Vector3 (road surface point incl. ramps)
track.frameAt(s, out?) → { index, s, x, y, z, position, tangent, right, yaw,
                           halfWidth, wallL, wallR, curvature, slope, racingLine }
track.wrapS(s); track.deltaS(a, b) /* signed shortest b-a */; track.forwardDistance(a, b)
track.gridSlot(i) → { position: Vector3, yaw, s, lateral }   // i = 0 pole … 7
track.racingLine   // Float32Array lateral offset per sample (inside-cutting line)
track.itemBoxes    // [{ row, s, lateral, position: Vector3 (road surface) }]
track.itemRows     // [{ s, boxes }]
track.boostPads    // [{ s0, s1, length, width, lateral, lat0, lat1, center: Vector3, yaw }]
track.ramps        // [{ s0, s1, length, height, fullWidth, lat0, lat1 }]  (kicker: height rises linearly s0→s1 then drops to 0)
track.zones        // [{ type: 'bridge'|'hill'|'hairpin'|'cliff', s0, s1 }]
track.segments     // def segments + { index, s0, s1 }
track.bounds       // { minX, maxX, minZ, maxZ, minY, maxY } (incl. walls)
track.startLine    // { s: 0, position, yaw, halfWidth }
```
Lateral layout at any s: road `|lateral| ≤ halfWidth`; curb strip
`halfWidth < |lat| ≤ halfWidth + CURB_WIDTH(1.0)`; grass (`offroad`) out to the
wall; walls at `lateral = -wallL` (left) and `lateral = +wallR` (right). Karts can
never pass walls, so the drivable area is exactly between them. The off-road
surface is at the same height as the road at that s.

## 4. Characters — `characters.js`

Eight original characters, all selectable, all appear in every race (player +
7 CPU). Ratings are 1–5.

| id | name | look | speed | accel | handling | weight |
|---|---|---|---|---|---|---|
| `blaze` | Blaze | orange fox, pointy ears, white muzzle, bushy tail | 3 | 3 | 4 | 3 |
| `bolt` | Bolt | chunky silver/blue robot, antenna, glowing visor | 4 | 2 | 3 | 5 |
| `pip` | Pip | small penguin, black/white, orange beak, scarf | 2 | 5 | 4 | 1 |
| `duke` | Duke | big brown bear, round ears, aviator goggles | 5 | 1 | 2 | 5 |
| `nova` | Nova | astronaut kid, purple suit, bubble helmet | 3 | 4 | 4 | 2 |
| `gus` | Gus | green frog, big eyes on top, wide mouth | 2 | 4 | 5 | 2 |
| `mochi` | Mochi | white cat, pink ears, bell collar | 3 | 4 | 3 | 2 |
| `ziggy` | Ziggy | teal alien, three eyes, antenna bobbles | 4 | 3 | 2 | 3 |

```js
export const CHARACTERS = [ { id, name, color /*0xRRGGBB primary*/, accent, cssColor /*'#rrggbb'*/,
  ratings: { speed, accel, handling, weight }, tagline } , ... ];   // order as in the table
export function getCharacter(id) → def
export function statsFromRatings(ratings) → { topSpeed, accel, turnRate, mass }  // uses config KART.*Base/PerStar
export function buildKartModel(def, { lod = 'high' } = {}) → THREE.Group
   // faces +Z, origin at ground center, ~2.2 m long, ~1.5 m wide, ~1.5 m tall with driver.
   // group.userData = { body: Object3D (chassis, tilts/rolls), driver: Object3D, head: Object3D,
   //   wheels: { fl, fr, rl, rr } (Object3D, spin around local X), steerPivots: { fl, fr } (rotate Y),
   //   exhausts: [Object3D] (world positions for boost flames), rearWheelL/R refs for sparks,
   //   tintMaterials: [Material] (for star rainbow tint) }
   // All meshes castShadow = true. Low-poly primitives (Box/Sphere/Cylinder/Cone/Capsule/Torus).
```

## 5. Kart physics — `kart.js` (node-safe)

```js
export class Kart {
  constructor({ id, character /*def*/, track, isPlayer = false })
  id; character; isPlayer; track;
  stats;                          // statsFromRatings(character.ratings)
  position: THREE.Vector3; yaw; velocity: THREE.Vector3 /* world m/s; y = vertical */;
  grounded; airTime;
  input = { steer: 0, throttle: 0, brake: 0, drift: false, useItem: false };
  proj = {};                      // last track.project() result (reused object)
  hint = -1;                      // track index hint
  // read-only-ish state for views/AI/HUD:
  get speed()                     // signed forward speed (m/s)
  get maxSpeed()                  // current effective max (after surface/boost/zap)
  drift = { active, dir /*-1 left, +1 right*/, charge /*s*/, tier /*0..3*/, hopping };
  boostTimer; starTimer; spinTimer; tumbleTimer; slowTimer; invulnTimer; stallTimer;
  frozen = false;                 // true during intro/countdown: no movement
  speedMult = 1;                  // extra max-speed multiplier (AI difficulty / rubber band)
  surface;                        // proj.surface of current frame
  steerVisual;                    // smoothed steer for front-wheel animation
  // race bookkeeping (written by race.js; initialize in constructor):
  distance = 0; lap = 0; place = 0; finished = false; finishTime = null; lapTimes = [];
  lapStartTime = 0; wrongWay = false;
  // item bookkeeping (written by items.js; initialize in constructor):
  item = null /*item id*/; itemCount = 0; rolling = false; rollTimer = 0; rollItem = null;

  placeOnGrid(slot /*track.gridSlot() result*/)   // set pos/yaw, zero velocity, reset states
  update(dt)                      // one physics substep using this.input
  applyBoost(duration, source = 'item')   // stacks to max(remaining, duration); emits kart:boost
  spinOut(cause = 'banana')       // returns false if invincible/invuln; else spin HIT.spinDuration
  tumble(cause = 'rocket')        // shells/rockets/star-ram; HIT.tumbleDuration, little hop
  zap()                           // HIT.zapSpinDuration spin + slowTimer HIT.zapSlowDuration
  startStar(duration = STAR.duration)
  isInvincible()                  // starTimer > 0
  isHittable()                    // !star && invulnTimer <= 0 && spin/tumble not active
  isDisabled()                    // spinning or tumbling (input ignored)
  respawn()                       // put back on the centerline at current s (safety net)
}
export function resolveKartCollisions(karts)   // pairwise circle push-apart + bumps; star rams tumble others
```
Model requirements (tune the feel; these are targets, not exact formulas):

* Velocity model: decompose horizontal velocity into forward (`vF`) and lateral
  (`vR`) components each step. Engine/brake/drag act on `vF`; lateral grip decays
  `vR` quickly (grip ≈ 10/s normal, ≈ 3.5/s while drifting so the kart slides
  outward a bit, ≈ 0.8/s airborne). Bumps/wall impulses add to velocity.
* Acceleration feels snappy: 0→90% top speed in ~2.5 s (accel stat dependent).
  Max speed = stats.topSpeed × surface mult (KART.offroadSpeedMult / curbSpeedMult;
  ignored while boost or star) × KART.boostSpeedMult if boostTimer>0 ×
  KART.starSpeedMult if star × HIT.zapSlowMult if slowTimer>0. If above max
  (e.g. entering grass) decelerate smoothly (~25 m/s²), not instantly.
* Steering: yaw rate = turnRate × steer × speed factor (0 at standstill → 1 by
  ~8 m/s, slightly reduced near top speed). Reversing inverts steering. Target
  minimum non-drift turn radius at top speed ≈ 18–22 m.
* **Drift**: when `input.drift` goes true while grounded with speed ≥
  DRIFT.minSpeed: hop (vy = DRIFT.hopVelocity, emit `kart:hop`). If |steer| > 0.2
  at hop time or on landing, enter drift with dir = sign(steer)
  (`kart:driftStart`). While drifting (button held): the kart always turns
  toward dir; steer modulates tightness (counter-steer = wide, into = tight;
  tight drift radius ≈ 11–13 m at speed); charge += dt (×1.3 when steering into
  the drift); tier rises at DRIFT.tierTimes (`kart:driftTier`). Releasing the
  button: if tier ≥ 1 → applyBoost(DRIFT.boostDurations[tier], 'drift');
  emit `kart:driftEnd` {tier}. Drift cancels (no boost) if speed < 6, on
  spin/tumble, or after >0.6 s airborne. Hop without steering = just a hop.
* Vertical: road height from `track.project(position, hint, proj)`. Snap to the
  road when predicted y ≤ road height; otherwise airborne with KART.gravity.
  While grounded keep `velocity.y` = actual vertical rate (so crests and the
  kicker ramp launch the kart). Emit `kart:land` {airTime} if airTime > 0.25.
* Walls: if lateral > wallR − radius or < −(wallL − radius): clamp back, remove
  the velocity component into the wall, scrub speed proportional to impact angle,
  small bounce; emit `kart:wallHit` {intensity 0..1} (throttle repeats to ≥0.3 s).
* Boost pad: when `proj.surface === 'boost'` → applyBoost(BOOST.padDuration,'pad')
  (re-trigger at most once per 0.5 s).
* Spin: 1 s, input ignored, speed decays to ~30%, yaw unaffected (the view spins
  the model). Tumble: 1.5 s, hop vy ≈ 6, speed decays to ~10%. After either:
  invulnTimer = HIT.invulnAfterHit. Drift cancels; boost cancels.
* Start-of-race stall/boost are triggered by race.js via `stallTimer` (engine
  stalled: no throttle for that time) and `applyBoost(BOOST.startDuration,'start')`.
* `frozen` → velocity zero, position fixed (but still compute proj so height is correct).
* Never produce NaN; clamp dt to ≤ 0.05.

`resolveKartCollisions`: circles of KART.radius (horizontal), only if |Δy| < 1.5.
Push apart weighted by inverse mass; exchange a bump impulse along the normal
(heavier kart pushes lighter more); emit `kart:bump` {a, b, intensity}. If one
kart has a star and the other is hittable → other.tumble('star'), no push on the
star kart.

## 6. Kart view, effects, camera (browser)

```js
// kartview.js
export class KartView {
  constructor(kart, scene, effects)     // builds buildKartModel(kart.character), adds to scene
  update(dt, camera)                    // sync transform & animations from kart state
  dispose()                             // remove from scene, free geometry/materials it owns
  object                                // root THREE.Group
}
```
Visual behaviour: position/yaw from kart; drift slide angle (extra yaw ≈ dir ×
0.35 rad, eased); pitch to track slope, slight roll in turns; wheel spin from
speed; front wheels steer; hop/land squash; spin = model rotates 2 full turns
around Y over spinTimer; tumble = flip around X once while bouncing; star =
rainbow hue cycling on tint materials + sparkle particles; drift sparks from rear
wheels colored by tier (DRIFT.tierColors; tier 0 = small white dust); boost =
flame/exhaust particles + slight FOV kick is done by camera; offroad = grass/dirt
dust; invuln after hit = blink (visible toggling at ~10 Hz); shadow via
castShadow. Character head bobs slightly.

```js
// effects.js — pooled particles, ONE draw call for all (THREE.Points with a custom
// ShaderMaterial: per-particle color, size, alpha; additive or normal blending
// via two pools is fine). Capacity ≥ 3000.
export class Effects {
  constructor(scene)
  emit(type, position, opts = {})   // type: 'spark' | 'dust' | 'grass' | 'smoke' | 'flame' |
                                    //  'sparkle' | 'confetti' | 'explosion' | 'stink' | 'zap' | 'splash'
                                    // opts: { color, count, velocity: Vector3, spread, size, life }
  burst(type, position, opts)       // alias of emit with larger default count
  update(dt, camera)
  clear()
  dispose()
}
```
```js
// camera.js
export class ChaseCamera {
  constructor(camera /*THREE.PerspectiveCamera*/)
  setTarget(kart)
  mode                       // 'chase' | 'intro' | 'orbit' | 'free'
  startIntro(track, duration)   // sweeping flyover ending behind the target kart's grid slot
  startOrbit()               // slow orbit around target (after finishing)
  snap()                     // jump to the ideal chase pose immediately
  lookBack                   // bool: chase camera looks backwards when true
  update(dt)
}
```
Chase: behind & above the kart (~6.5 m back, ~2.6 m up), looks slightly ahead,
yaw follows the kart's *velocity/visual* heading with damping (so drifts swing
the view), FOV 70 → ~82 while boosting, small shake on wall hits / landings.
Never clips under the road (keep camera y ≥ road height + 1).

## 7. World — `world.js`, `textures.js` (browser)

```js
export function buildWorld(scene, track, { renderer, quality = 'high' } = {})
  → { sun: THREE.DirectionalLight, update(dt, focusPosition /*Vector3*/, camera), dispose(),
      itemBoxAnchor?: unused }
```
Must create: sky (gradient dome or shader), fog, hemisphere + sun light (the
sun casts shadows; `update` moves the sun + its shadow camera to follow
`focusPosition` with a ~70 m shadow box), road mesh (textured asphalt, lane
markings), curbs (red/white) along road edges, grass off-road strip to the
walls, walls/barriers at wallL/wallR (tire walls / fences / bridge rails on the
bridge zone), terrain beyond walls (ground, embankments down from elevated
sections, cliffs in the cliff zone), water body under the bridge zone + bay
(animated), the bridge structure, start/finish checkered line + gantry with
banner, starting grid marks, boost pads (animated chevrons, use
`track.boostPads`), kicker ramp wedges (use `track.ramps`; the physics height
rises linearly over the ramp strip then drops), arrow signs on the hairpin,
decorations (instanced trees, rocks, a lighthouse near the hairpin, grandstands
with crowd near the start, flags, hills/mountains in the distance, clouds).
**Item boxes are NOT built here** (items.js owns them). Bright, saturated,
friendly low-poly style. Respect the perf budget (instancing, merged geometry).
Textures: generate with canvas in `textures.js` (asphalt, grass, checker, curb,
dirt, rock, chevron, water normal-ish, item-box "?" not needed). The world module
may tune `track-def.js` (e.g. widths, elevations, pad/ramp/item positions) but
must keep the turtle segment list closed (run `node tools/track-check.mjs`;
closure error must stay < 0.1 m) and keep every API in §3.

## 8. Items, AI, Race (node-safe)

### items.js
```js
export class ItemSystem {
  constructor({ track, karts, scene = null, effects = null, rng = Math.random })
  boxes;        // [{ position: Vector3 (center, ~1.1 m above road), active, respawnTimer, s, lateral }]
  hazards;      // bananas & stink clouds: [{ type, position, owner, radius, life, ... }]
  projectiles;  // bouncers & rockets
  update(dt, race)     // race gives places for roulette odds & rocket targets
  useItem(kart)        // activate held item (no-op if none / rolling)
  rollFor(kart, place) // returns an item id from ITEM_TABLE[place-1] (place 1..8)
  getThreatsNear(kart, radius) → [{ type, position, distance, ahead /*bool*/ }]  // for AI avoidance
  clear()              // remove everything (keep boxes, reactivate them)
  dispose()
}
```
Rules:
* Box pickup: a kart within ITEM.boxRadius of an active box breaks it
  (`item:boxHit`); box respawns after ITEM.boxRespawn. If the kart holds no
  item and isn't rolling, start roulette: `kart.rolling = true`,
  `kart.rollTimer = ITEM.rouletteSeconds` (player) / `aiRouletteSeconds` (CPU),
  result decided at roll start via rollFor (store in `kart.rollItem`), assigned
  to `kart.item`/`kart.itemCount = ITEM_INFO[id].uses` when the timer ends
  (`item:get`). Pressing item during the roll shortens remaining time to ≤ 0.3 s.
* Each substep, for every kart: if `kart.input.useItem` is true → `useItem(kart)`
  and set `kart.input.useItem = false` (pulse consumed). Ignored while disabled.
* `banana`: dropped 2.2 m behind the kart, sits on road (height via project),
  hit → `spinOut('banana')`. Bouncers/rockets destroy bananas.
* `bouncer`: launched forward from the kart front at max(ITEM.bouncerSpeed,
  kartSpeed + 20) m/s along kart heading, follows road height, reflects off walls
  (use track.project lateral vs wallL/wallR), up to bouncerMaxBounces / bouncerLife
  seconds; hit kart → `tumble('bouncer')`. Ignores its shooter for
  ITEM.shooterGrace s.
* `rocket`: targets the kart one place ahead (`race` places). Flies along the
  track (s increasing, lateral easing toward the target's lateral) at
  ITEM.rocketSpeed, then homes directly within rocketHomingRange; hit →
  `tumble('rocket')` + `item:explode`. If user is 1st or no target: flies
  straight like a bouncer without bouncing. Life rocketLife.
* `toot`: `applyBoost(BOOST.tootDuration, 'item')`; `triple_toot`: 3 uses (count
  decrements; the slot keeps the item until count hits 0).
* `stink`: drops a stink cloud 3 m behind: a hazard of radius ITEM.stinkRadius,
  life ITEM.stinkLife; any kart entering (not owner for first 1 s) →
  `spinOut('stink')` once per cloud per kart; slight slow.
* `star`: `startStar()`.
* `zap`: every kart with a better place than the user (and not starred) →
  `zap()`; emit `item:zap`.
* Visuals only when `scene` given: rotating translucent rainbow item boxes with a
  "?" (canvas texture) and a shatter burst; banana mesh; green glossy bouncer
  ball; red rocket with flame trail; green stink cloud (puffy, semi-transparent,
  pulsing); zap flash. All pooled/cheap. Effects via `effects.emit` if given.
* Events: see §9.

### ai.js
```js
export class AIDriver {
  constructor(kart, { track, difficulty = 'normal', skill = 0.7, rng = Math.random, personality = {} })
  update(dt, { karts, items, race, player })   // writes kart.input (steer/throttle/brake/drift/useItem)
}
```
Follows `track.racingLine` + a personal lateral offset (varies slowly over time,
plus avoidance of hazards from `items.getThreatsNear` and other karts), look-ahead
steering (lookahead ~ 6 m + 0.45 × speed), brakes/lifts on sharp curvature,
drifts through long corners (charging tier 1–2 mini-turbos), uses items
smartly (banana/stink when someone is close behind; bouncer when a kart is
straight ahead within ~35 m; rocket when one is ahead; toot on straights; star
immediately; zap when not leading). Difficulty from config DIFFICULTY:
`aiSpeedMult` caps their throttle/top speed (implement by scaling throttle or
via a per-kart `kart.speedMult` field that kart.js multiplies into maxSpeed —
**kart.js must support `kart.speedMult` (default 1)**), rubber banding vs the
player (behind by >60 m → up to +rubberBand, ahead by >60 m → down to
−rubberBand). CPU karts must never get stuck: if speed < 2 m/s for > 2 s while
not disabled/frozen, reverse-and-steer recovery; if still stuck for 5 s →
`kart.respawn()`.

### race.js
```js
export class Race {
  constructor({ track, karts, laps = RACE.laps, player = null })
  state;          // 'intro' | 'countdown' | 'racing' | 'finished'  ('finished' = every kart done or results shown)
  time;           // seconds since GO (0 before)
  countdown;      // seconds remaining in countdown (3 → 0)
  laps;
  standings;      // karts sorted by place (1st first), updated every update()
  playerFinished; // bool
  startIntro()    // state='intro' (karts frozen) for RACE.introSeconds then auto startCountdown()
  startCountdown()// state='countdown' for RACE.countdownSeconds, then GO → 'racing'
  update(dt)      // call AFTER karts move each substep
  getPlace(kart)  // 1..8
  getResults()    // [{ kart, place, time (actual or estimated), finished: bool, bestLap }]
  skipIntro()
}
```
* Grid: race.js does NOT place karts; main places them with `kart.placeOnGrid(track.gridSlot(i))`.
* Karts are `frozen` during intro/countdown; unfrozen at GO (`race:go`).
* Countdown emits `race:countdown` {n:3}, {n:2}, {n:1} at the start of each second.
* Start boost / stall: track each kart's throttle during the countdown. First
  press inside RACE.startBoostWindow (seconds before GO) → at GO
  `applyBoost(BOOST.startDuration, 'start')` + `race:startBoost`; pressing earlier
  than RACE.startStallBefore → `kart.stallTimer = 1.0` at GO + `race:stall`.
* Progress: each kart has continuous `distance` (start = `track.deltaS(0, gridS)`,
  negative on the grid). Each update: `distance += track.deltaS(prevS, proj.s)`.
  `lap = clamp(floor(distance / L) + 1, 1, laps)` for display; a lap completes when
  `floor(distance / L)` increases beyond the max reached (emit `race:lap` {kart,
  lap, lapTime} for lap ≥ 2 and `race:finalLap` when lap === laps). Finish when
  `distance ≥ laps × L` → `finished = true`, `finishTime`, `race:finish` {kart,
  place}. Driving backwards reduces distance; no lap credit for wiggling over
  the line.
* Places: finished karts by finish order, then by distance desc. Write
  `kart.place`. Emit `race:positionChange` for the player when it changes.
* Wrong way: player's forward·tangent < −0.4 and speed > 3 for RACE.wrongWayDelay
  → `kart.wrongWay = true` (`race:wrongWay` {kart, on}).
* After the player finishes, main swaps the player to AI control; when all karts
  finish or RACE.resultsDelay elapses after the player finished →
  `race:over` (once). Unfinished karts get estimated times from remaining
  distance / their average speed.

### tools/sim.mjs (headless)
Builds the track, 8 karts (all characters), AI for all, items (scene null), race;
places on grid; skips intro; simulates at dt = 1/120 for up to 400 s game time
(as fast as possible). Prints per-kart finish time, lap times, items used, hits
taken, max stuck time, wall hits; exits non-zero if any kart fails to finish
within 300 s, any NaN, or any kart stuck > 5 s. `node tools/sim.mjs --seed 3 --laps 3`.

## 9. Event bus catalog (`bus.emit(type, data)`)

| type | data |
|---|---|
| `kart:hop` | { kart } |
| `kart:driftStart` | { kart, dir } |
| `kart:driftTier` | { kart, tier } (1..3) |
| `kart:driftEnd` | { kart, tier } |
| `kart:boost` | { kart, source: 'drift'\|'item'\|'pad'\|'start', duration } |
| `kart:spin` | { kart, cause } |
| `kart:tumble` | { kart, cause } |
| `kart:wallHit` | { kart, intensity } |
| `kart:bump` | { a, b, intensity } |
| `kart:land` | { kart, airTime } |
| `kart:starStart` / `kart:starEnd` | { kart } |
| `kart:respawn` | { kart } |
| `item:boxHit` | { kart, box } |
| `item:rollStart` | { kart } |
| `item:get` | { kart, item } |
| `item:use` | { kart, item } |
| `item:hit` | { kart /*victim*/, by /*kart or null*/, item } |
| `item:explode` | { position } |
| `item:zap` | { kart } |
| `item:blocked` | { kart, item } (projectile destroyed a banana) |
| `item:deploy` | { kart, item } (v4: a triple attached its 3 orbiters / trailing peels) |
| `item:capoLaunch` / `item:capoWarning` | { kart, target } / { target, kart, locked } (v4) |
| `item:capoHit` / `item:capoFizzle` | { kart /*target*/, by, position, dodged } / { position, reason: 'fizzle' \| 'blocked' \| … } (v4) |
| `item:espresso` / `item:espressoSplash` | { kart, victims } / { kart /*victim*/, by } (v4; the coffee lands ~0.6 s later) |
| `item:accordion` | { kart, hits, blocked } (v4) |
| `item:beerStart` / `item:beerRide` / `item:beerEnd` | { kart } / { kart } / { kart, gained } (v4) |
| `item:bombExplode` | { position, kart /*owner*/ } (v4; every explosion also emits `item:explode`) |
| `race:intro` | {} |
| `race:countdown` | { n } |
| `race:go` | {} |
| `race:startBoost` / `race:stall` | { kart } |
| `race:lap` | { kart, lap, lapTime } |
| `race:finalLap` | { kart } |
| `race:finish` | { kart, place, time } |
| `race:positionChange` | { kart, from, to } |
| `race:wrongWay` | { kart, on } |
| `race:over` | {} |

## 10. Audio, input, HUD (browser)

```js
// audio.js — 100% synthesized with WebAudio (no audio files).
export class AudioEngine {
  constructor()
  unlock()                     // call from any user gesture; creates/resumes AudioContext (idempotent)
  get ready()
  muted; toggleMute(); setMuted(b); setVolume(v /*0..1*/)
  play(name, { volume = 1, pitch = 1, pan = 0 } = {})
     // names: 'menuMove','menuSelect','menuBack','countdown','go','itemBox','roulette'
     //   (short tick),'itemGet','throw','bouncer','rocket','toot' (comedic fart-like
     //   boost toot!),'boost','hit','spin','explode','banana','stink','star','zap',
     //   'lap','finalLap','finish','lose','wall','bump','hop','land','drift1','drift2',
     //   'drift3','stall','startBoost','respawn','join' (phone connected),'leave'
  updateEngine(dt, { speed, maxSpeed, throttle, drifting, boosting, grounded, offroad, active })
     // continuous player engine + drift screech + offroad rumble loops
  setEngineActive(b)
  startMusic(kind /*'menu'|'race'*/), setMusicIntensity(level /*0 normal, 1 final lap*/), stopMusic()
  playJingle(name /*'finish'|'lose'|'start'*/)
}
```
Music: procedural chiptune sequencer (lookahead scheduler on AudioContext time),
catchy original melodies (do not reproduce existing songs), menu + race loops,
final-lap = faster tempo. Master compressor; music quieter than SFX.

```js
// input.js — keyboard + gamepad + phone merge
export class Input {
  constructor({ phone = null /*PhoneLink*/ } = {})
  update(dt)          // call once per frame BEFORE reading
  // race controls (merged across sources):
  steer; throttle; brake; drift /*held*/; itemPressed /*edge this frame*/;
  pausePressed /*edge*/; lookBack /*held*/;
  // menu navigation (edges this frame):
  menu = { left, right, up, down, confirm, back };
  lastSource;         // 'keyboard' | 'gamepad' | 'phone'
  phoneActive;        // phone connected and sending
  dispose()
}
```
Keyboard: ←/→ or A/D steer (smoothed ramp ~7/s, return ~10/s), ↑/W gas, ↓/S
brake/reverse, Space or Shift = drift (held), X / E / Z = item, C = look
back, Esc/P = pause, Enter = confirm, Backspace/Esc = back in menus. Gamepad:
left stick X steer (deadzone .15), A/RT gas, B/LT brake, RB/R1/X drift, LB/Y
item, Start pause, d-pad menus. Phone: `phone.input` (see §11): steer is used
directly (already smoothed on the phone), gas→throttle, brake, drift, item and
pause edges from sequence counters. While the phone is active and sending,
phone steer overrides keyboard steer unless a key is pressed.

```js
// hud.js — DOM overlay (absolutely positioned elements inside a root div)
export class HUD {
  constructor(root /*HTMLElement*/)
  setTrack(track)            // pre-render minimap outline (canvas)
  show(); hide()
  update(dt, { player, race, karts, items, phoneConnected })
     // lap "LAP 2/3", race timer, place badge (1st gold / 2nd silver / 3rd bronze),
     // item slot with roulette animation (cycles ITEM_INFO icons while
     // player.rolling) + count badge for triple_toot, minimap with kart dots
     // (character cssColor; player larger with white ring), speed bar,
     // drift charge indicator, phone-connected icon
  countdown(n)               // big center "3","2","1" then "GO!" (n = 0)
  flash(text, { color, duration = 1.5, size = 'big'|'medium' })  // "LAP 2", "FINAL LAP!", "FINISH!"
  setWrongWay(on)
  showFinish(place)          // "FINISH!" + place
  reset()
}
```
CSS in `public/css/game.css` (HUD + shared base styles, bold rounded game font
via Google Fonts, e.g. "Lilita One" / "Bungee" with system fallbacks, text
outlines/shadows for readability). Must scale for 720p → 4K (use vh/clamp).

## 11. Network protocol — server + phone

`npm start` → `node server.js`:
* HTTP on 3000 (`http://localhost:3000` desktop game), HTTPS on 3443 with a
  self-signed cert generated at first start (selfsigned, SAN = localhost +
  127.0.0.1 + all LAN IPv4s; cached in `.certs/` and kept while it covers the
  host in the phone URL — a phone's exception is for that one certificate;
  when it must be replaced, the new SAN keeps the old addresses). At startup
  the server checks that `localhost` (127.0.0.1 and ::1) really reaches it and
  exits with "port in use" otherwise. Both servers share ONE Socket.IO instance/room state
  (`io.attach(httpsServer)` additionally, or create io on http and attach the
  https server too).
* Static: `/` → `public/index.html`, `/pad` → `public/pad.html`, `/vendor/three/*`
  → `node_modules/three/*`, everything else from `public/`.
* `GET /api/info` → `{ lanIps: [...], httpPort, httpsPort, padBaseUrl }`.
* Prints the desktop URL + phone hint on start; opens the desktop URL in the
  default browser (`open` on macOS) unless `NO_OPEN=1`.
* Rooms: 4-letter codes (no ambiguous letters). One host + at most one active
  pad per room (a new pad replaces the old one, old gets `pad:kicked`).

Socket.IO events:
| direction | event | payload |
|---|---|---|
| host→server | `host:create` (ack) | `{ room?, key?, vacantOnly? }` (reclaim on reconnect; `vacantOnly`: only if no live host has it) → ack `{ room, padUrl, qrSvg, lanIps }` |
| server→host | `pad:join` / `pad:leave` | `{ padId }` |
| server→host | `pad:input` | `{ s, g, b, d, i, p, t }` steer float −1..1 (+right), gas 0/1, brake 0/1, drift 0/1, itemSeq int, pauseSeq int, client ms timestamp |
| server→host | `pad:menu` | `{ action, ... }` actions: `start`, `select` {index}, `difficulty` {value}, `go`, `pause`, `resume`, `restart`, `quit`, `again`, `menu` |
| host→server→pad | `host:state` | see below (server caches the last one per room and sends it to a pad on join) |
| host→server→pad | `host:event` | `{ type: 'vibrate', pattern: [ms...] }` \| `{ type: 'toast', text }` |
| pad→server | `pad:hello` (ack) | `{ room }` → ack `{ ok, error? }` |
| server→pad | `host:leave` | `{}` (desktop disconnected) |

`padUrl` = `https://<primary LAN IP>:3443/pad?room=ABCD`. `qrSvg` = SVG string
from `qrcode.toString(padUrl, { type: 'svg', margin: 1 })`.

`host:state` payload:
```js
{ screen: 'title'|'select'|'race'|'results'|'paused'|'loading',
  characters: [{ id, name, cssColor }], selected: 0, difficulty: 'normal',
  race: { state, lap, laps, place, racers, item, itemCount, rolling, countdown, finished } | null,
  results: [{ name, cssColor, place, time, isPlayer }] | null }
```

### net.js (desktop side)
```js
export class PhoneLink {
  constructor()
  async connect()            // connects socket, emits host:create; resolves { room, padUrl, qrSvg, lanIps }
  room; padUrl; qrSvg; lanIps;
  connected                  // a pad is currently joined
  input = { steer: 0, gas: 0, brake: 0, drift: 0, itemSeq: 0, pauseSeq: 0, lastUpdate: 0 /*performance.now()*/ }
  get active()               // connected && input updated within the last 1500 ms
                             // (shrinks to 400 ms while the pad streams at race rate)
  on(event, fn)              // 'join' | 'leave' | 'menu' (payload) | 'info' → returns unsubscribe
                             // also 'lost' / 'signal': a pad that was driving went silent ≥ 1 s
                             // during a live race → 'lost', then a local 'menu' {action:'pause'}
  sendState(state)           // dedupes; also re-sends at NET.hostStateHz heartbeat
  sendEvent(type, data)      // e.g. sendEvent('vibrate', { pattern: [40] })
}
```
Re-claims its room after a socket reconnect (`host:create {room}`). The room a
phone is paired with is also kept in localStorage, so a closed and reopened
game tab reclaims it (`vacantOnly`) within the grace period.

### pad.html / pad.js / pad.css (phone controller)
* Opens `https://LAN:3443/pad?room=ABCD`; if no/invalid room, shows a 4-letter
  code input. Connects Socket.IO to its own origin, `pad:hello`.
* "Tap to start" gate (needed for iOS): calls
  `DeviceOrientationEvent.requestPermission()` (and DeviceMotionEvent's) when
  present, requests a screen Wake Lock, tries fullscreen +
  `screen.orientation.lock('landscape')` (Android; ignore failures).
* **Always-landscape UI**: the controller layout is landscape. If the page is
  laid out portrait (orientation-locked iPhone held sideways), rotate the whole
  UI container 90° with CSS so it appears landscape; choose ±90° from gravity
  (which way the phone is held) with hysteresis.
* **Steering math** (robust for upright "wheel" grip AND flat tilting):
  from `deviceorientation` β, γ (degrees→radians) compute world-up in device
  coords `up = (-sinγ·cosβ, sinβ, cosγ·cosβ)`. Let `a` = effective UI rotation
  angle in degrees = `screen.orientation.angle ?? window.orientation ?? 0`, plus the CSS
  rotation if applied (so `a` describes how the visible UI is rotated relative to
  the device's natural portrait). Screen-space up: `ux = up.x·cos a − up.y·sin a`,
  `uy = up.x·sin a + up.y·cos a`. Raw steering angle: the in-plane wheel angle
  `θ = atan2(−ux, uy)` while the phone is held like a wheel (in-plane gravity
  `m = hypot(ux, uy) ≥ 0.6`), so steering does not depend on how far the
  screen is tilted back; blended (smoothstep) into `asin(clamp(−ux, −1, 1))` as
  `m` falls to 0.35 (phone lying flat: roll angle) and as `uy → 0`
  (rotating the phone clockwise like a wheel = positive = steer right).
  Verify the sign on both landscape directions and fix if inverted.
  Subtract the calibration offset θ₀ (set by "Center" button and automatically
  at race start), dead zone 2°, full lock at ±32° (sensitivity slider 18°–50°,
  saved in localStorage), mild expo curve, low-pass filter. Fallback if no
  orientation events arrive within 1.5 s after the gate: `devicemotion`
  `accelerationIncludingGravity` (detect iOS sign inversion) and, failing that,
  a touch steering slider. Show a live steering-wheel graphic that rotates with
  the input.
* Race layout (landscape, thumbs on the edges like holding a wheel): left side
  DRIFT (big, hold) and ITEM (shows current item icon from host state, tap);
  right side GAS (big, hold) and BRAKE (hold); top bar: pause button, place,
  lap, connection dot, "Center" button; settings sheet (sensitivity, auto-gas
  toggle, invert steering). Multi-touch with Pointer Events (each button tracks
  its own pointerId; implicit capture; handle pointercancel/lostpointercapture);
  `touch-action: none`, no selection/callouts/zoom, no scroll bounce.
  Pressed state visual feedback; `navigator.vibrate` short buzz on press
  (Android).
* Menu screens mirror `host:state.screen`: title → big "START" button; select →
  scrollable grid of character cards (name + color swatch; tap = `select`
  {index}; highlights `selected`), difficulty segmented control, big "RACE!"
  (`go`); paused → Resume / Restart / Quit; results → standings list + "Race
  Again" (`again`) / "Change Character" (`menu`). Portrait or landscape both OK
  for menus, but the always-landscape container is fine too.
* Sends `pad:input` at NET.padInputHz while screen is race (volatile emits) and
  immediately on any button edge; item/pause presses increment sequence
  counters (never lost). Auto-gas (setting) sends g=1 unless brake held.
  A sample due while the transport is busy goes out when it drains (HTTP
  long-polling); none are queued behind a stalled WebSocket. The server relays
  edges reliably and coalesces samples over its rate limit (newest wins).
* Page hidden mid-race (lock, app switch, call) while the phone is in use →
  `pad:menu {action:'pause'}` right away, buttons released, stream stopped.
* Handles `host:event` vibrate patterns, `host:leave` (show "waiting for game"),
  reconnects (re-`pad:hello`).
* Shows clear help: if not a secure context, explain HTTPS is needed.

## 12. Integration — index.html, main.js, menus.js

* `index.html`: import map, socket.io script, `<canvas id="game">`, `#hud` root,
  `#menus` root, fonts, `css/game.css` + `css/menus.css`, `<script type="module" src="js/main.js">`.
* `main.js`: creates renderer (antialias, pixelRatio ≤ 2, ACES tone mapping,
  sRGB, PCFSoft shadows), scene, camera, `getTrack()`, `buildWorld`, `Effects`,
  `ChaseCamera`, `AudioEngine`, `PhoneLink` (connect; failures must not break
  keyboard play), `Input`, `HUD`, menus. App states: `title` → `select` →
  `race` (intro → countdown → racing) → `results` → (`again` → new race |
  `menu` → select). Pause overlay (Esc / phone pause). Race setup: 8 karts
  (player's character + the other 7), player in grid slot RACE.playerGridSlot,
  CPU in the others, `AIDriver` for each CPU with skill spread around the
  difficulty's aiSkill, `ItemSystem`, `Race`, `KartView` for every kart.
  Teardown fully disposes race objects between races (no leaks, no duplicate
  bus listeners).
* Main loop: `requestAnimationFrame`; frame dt clamped to PHYS.maxFrameDt; split
  into n = ceil(dt / PHYS.maxSubstep) equal substeps. Per substep: AI drivers
  update → `items.update(dt, race)` → `kart.update(dt)` for all →
  `resolveKartCollisions(karts)` → `race.update(dt)`. Per frame: input.update
  (once, before substeps; player input written to player kart; itemPressed sets
  `player.input.useItem = true`), KartViews, effects, camera, world.update,
  HUD, audio (engine + event-driven one-shots for the player and nearby
  karts, distance-attenuated), phone state sync (screen/race fields; vibrate on
  player hit/item get/lap), render.
* After the player finishes: player kart is driven by an AIDriver; camera orbit;
  after `race:over` show results.
* Menus (`menus.js`, DOM): title screen with logo and "Press Enter / tap START on
  your phone", QR panel (always visible on title & select screens: QR SVG,
  "Scan with your phone camera to use it as a steering wheel", the URL in text,
  certificate-warning tip, connection status with the phone), character select
  (8 cards with color, name, stat bars, live 3D preview of the selected kart
  on a turntable — render with the main renderer into the main scene or a
  small dedicated scene; keyboard ←/→/↑/↓ + Enter, phone `select`/`go`),
  difficulty selector, results screen (standings table, times, "Race Again" /
  "Change Character"), pause menu (Resume / Restart / Quit). Keyboard and phone
  can both drive every menu. Mute toggle (M key + button). Controls help.
* `window.__game` debug handle: `{ state, track, race, karts, player, items,
  quickRace(charId = 'blaze', difficulty = 'normal'), setTimeScale(x),
  skipIntro() }` — used by automated tests (tools/shot.mjs).
* AudioContext unlock on the first desktop keydown/pointerdown; show a small
  "click for sound" hint until unlocked.

---------------------------------------------------------------------------

## 13. KRISHIV KART update — rename, 4 new racers, racer customization

### 13.1 Rename
The game is now **KRISHIV KART** (`GAME_TITLE` in config.js; package name
`krishivkart`). Replace every user-facing "TOOT KART" (page `<title>`s, logos,
boot splash, start-gantry banner texture, phone pad, server banner + cert
subject, README, error/help text, aria labels, code header comments). Item
names (Toot Boost, Triple Toot, …) stay as they are.

### 13.2 Roster
`CHARACTERS` (characters.js) grows from 8 to **12**: the 8 existing racers plus
four human kid racers appended in this order. Humans have `human: true`, a
default `look` and a `signature` loadout (see customize.js):

| id | name | ratings spd/acc/hnd/wgt | color / accent | look (default) | signature kart |
|---|---|---|---|---|---|
| `krishiv` | Krishiv | 4 / 4 / 3 / 3 | red 0xe8344e / gold 0xd9a514 | skin s4, spiky black hair, no hat, no eyewear, red outfit | speedster, slick, paint red, trim gold, rim gold |
| `striker_max` | Striker Max | 5 / 2 / 3 / 4 | blue 0x2f6bff / yellow 0xffc21f | skin s3, blonde mohawk, shades, blue outfit | rocket, standard, paint blue, trim yellow, rim silver |
| `rayyaan` | Rayyaan | 3 / 4 / 5 / 2 | green 0x35c64a / white 0xf4f4f4 | skin s4, curly black hair, backwards cap, green outfit | feather, neon, paint green, trim white, rim lime |
| `jordan` | Jordan | 3 / 5 / 3 / 3 | sky 0x38c8ff / orange 0xff7a1f | skin s2, short brown hair, race helmet, goggles, sky outfit | buggy, tiny, paint sky, trim orange, rim white |

Taglines (keep upbeat): Krishiv "The champ this whole Grand Prix is named
after.", Striker Max "Full throttle, zero brakes, all swagger.", Rayyaan
"Smooth lines and silky drifts.", Jordan "Launches off the line like a rocket."
Each of the 8 original characters also gets a `signature` (visual variety for
CPUs) chosen to fit them (e.g. Bolt/Duke → tank or monster wheels, Pip → buggy +
tiny, Gus → feather, Ziggy → rocket, Nova → buggy, Mochi → feather or
standard, Blaze → standard), keeping their current colors.

Plus a 13th selectable slot, the player's own creation:
```js
export const CUSTOM_CHARACTER = { id: 'custom', name: 'My Racer', isCustom: true, human: true,
  ratings: { speed: 3, accel: 3, handling: 3, weight: 3 }, color, accent, cssColor,
  tagline: 'Your racer, your rules.', look: {...}, signature: {...} };
export const SELECTABLE = [...CHARACTERS, CUSTOM_CHARACTER];   // 13, custom last
getCharacter(id)  // resolves 'custom' too
```
`CHARACTERS` (12) is the racing roster used for CPUs and the sim; the custom
slot is only ever the player.

### 13.3 Loadouts — `customize.js` (written by the lead; node-safe)
Read the file: catalogs (`PALETTE`, `SKIN_TONES`, `HAIR_STYLES`,
`HAIR_COLORS`, `HEADWEAR`, `EYEWEAR`, `KART_BODIES`, `WHEELS`,
`FIELD_GROUPS`), `defaultLoadout(def)`, `sanitizeLoadout(def, raw)`,
`setLoadoutField`, `cycleLoadoutField`, `computeRatings(def, loadout)` (base
ratings + body + wheel mods, clamped 1..5, 0.5 steps), `offroadBonus`,
`loadoutFields(def)` (the field list every garage UI renders), `randomLoadout`,
`sanitizeName` / `NAME_MAX` (12), `loadoutCssColor`, `paletteHex`, `skinHex`,
`hairHex`, `getBody`, `getWheels`, `loadSavedLoadouts()` / `saveLoadouts(map)`
(localStorage key `krishivkart.loadouts.v1`, `{ [charId]: loadout }`).
Humans customize skin/hair/hairColor/headwear/eyewear/outfit; non-humans
customize `driverColor` ('default' = original colors, else a palette tint of
the character's main color). Everyone customizes body/paint/trim and
wheels/rim, plus the display name.

### 13.4 Models — `buildKartModel(def, { lod = 'high', loadout = null })`
`loadout` defaults to `defaultLoadout(def)`. Must render: the 6 kart bodies as
clearly different silhouettes (Classic = current chassis; Speedster = low wedge
+ big rear wing; Bubble Buggy = round bubbly tub + roll bar; Thunder Truck =
boxy, tall, chunky bumpers; Featherlite = minimal exposed tube frame; Rocket
Sled = long nose, jet fins, rear thruster nozzle), painted with
paint/trim; the 6 wheel styles (Standard; Racing Slicks = wide smooth; Mud
Grippers = knobby chunky; Mini Rollers = small; Monster Wheels = huge (kart rides
higher — keep the wheel bottoms on the ground at y=0); Neon Rings = emissive
glowing rims) with `rim` color; human drivers from a parametric builder
(head, face with readable eyes + smile, skin tone, 9 hair styles × hair color,
7 headwear, 4 eyewear, outfit-colored suit, arms on the wheel) that look like
cheerful cartoon kids in the same style as the existing cast; non-human
`driverColor` tint. Keep the `userData` contract of §4 (wheels/steerPivots/
exhausts/tintMaterials/body/driver/head) for every body/wheel combo so
kartview.js keeps working; keep ≤ ~14 draw calls per kart (merge static parts);
cache geometries by (body, wheels) and part.

### 13.5 Kart physics — kart.js
`new Kart({ id, character, track, isPlayer = false, loadout = null, useLoadoutStats = isPlayer })`:
`this.loadout = sanitizeLoadout(character, loadout)`, `this.name = this.loadout.name`,
`this.cssColor = loadoutCssColor(this.loadout)`. Stats: `useLoadoutStats ?
statsFromRatings(computeRatings(character, loadout)) : statsFromRatings(character.ratings)`
plus `stats.offroadMult = KART.offroadSpeedMult + (useLoadoutStats ? offroadBonus(loadout) : 0)`
(clamp ≤ 0.8), used by `maxSpeed` instead of the constant. CPU stats therefore
ignore part mods (their signature karts are cosmetic), so AI balance is unchanged.
KartView builds its model from `kart.loadout`. Race results, HUD, phone and
callouts use `kart.name` / `kart.cssColor`.

### 13.6 Race field
8 racers: the player + 7 CPUs. CPUs always include the four human racers
(Krishiv, Striker Max, Rayyaan, Jordan — minus the player's own pick), the rest
random from the other characters; never the player's character twice. CPUs use
their signature loadouts. ai.js gets personalities for the 4 new ids.
tools/sim.mjs must race 8 of the 12 (rotate the subset per seed) and keep passing.

### 13.7 Desktop flow (main.js / menus.js)
* **Select** (13 cards; the custom card shows "CREATE YOUR RACER" + its current
  name, ✚ badge): Enter / RACE! starts a race with the selected character's saved
  loadout; **C / CUSTOMIZE** button opens the garage for the selected character.
  Card portraits reflect saved loadouts and refresh after garage edits.
* **Garage** (new app state `'garage'`): tabs Driver / Kart / Wheels (+ a Name
  field always visible at the top), each field a row with ◀ value ▶ (color fields
  show swatch strips, part fields show name + description + stat deltas), live
  turntable 3D preview rebuilt on every change, stat bars of the FINAL ratings
  with +/− markers vs the character's base, Randomize (R), Reset, Done (Esc →
  select), RACE! (Enter when not typing). Keyboard: ↑/↓ row, ←/→ value, Tab or
  Q/E switch tab, typing into the name box (Input must ignore game keys while an
  `<input>`/`<textarea>` is focused). Mouse/touch on everything. Saved to
  localStorage on change (debounced) per character id.
* Results / pause / phone show `kart.name`.

### 13.8 Phone protocol additions (server.js / net.js / pad.js)
* `pad:menu` new actions: `customize` (optional {index}: select it first, then
  open the garage), `loadout` {field, value}, `cycle` {field, dir: −1|1},
  `name` {text}, `randomize`, `reset`, `done` (garage → select). `go` also works
  from the garage. `select` index range is now 0..12.
* server.js sanitizes them: field `/^[a-zA-Z]{1,16}$/`, value
  `/^[a-z0-9_]{1,24}$/`, dir ∈ {−1, 1}, text = string, control chars stripped,
  ≤ 24 chars (the host applies `sanitizeName`). `host:state` may carry the new
  key `garage` and screen `'garage'`; size caps must allow ~10 KB states.
* `host:state.characters` = 13 entries `{ id, name, cssColor, custom }` (custom
  last; name = saved custom name). `host:state.garage` =
  `{ index, charId, human, name, nameMax, groups: FIELD_GROUPS,
     fields: loadoutFields(def) each with its current `value`,
     ratings (final), base (def.ratings), offroad }` while on the garage screen,
  else null.
* Phone garage UI: same tabs, tappable swatches/chips + ◀ ▶, part stat deltas,
  name text field using the phone keyboard (maxlength NAME_MAX; send on input
  debounced + on Enter/blur; must work on iPhone — do not put the text field in a
  CSS-rotated container; menus may use natural orientation), stat bars,
  Randomize / Reset / Done / RACE!. Select grid shows 13 cards incl. the custom
  card and a CUSTOMIZE button.

---------------------------------------------------------------------------

## 14. v3 — Mario-Kart structure, local multiplayer on phones, original brainrot-style cast, second track, easier steering

§14 supersedes §13 (and earlier sections) wherever they conflict. Background
research: `notes/research-selection-stats.md`, `research-multiplayer-flow.md`,
`research-steering-feel.md`, `research-tracks-cast.md`, `research-critic.md`.
**Those notes discuss real meme characters ("Roster A", "Tung Tung Tung Sahur",
"Sahur Cup") — IGNORE all of that. The cast is the ORIGINAL roster in §14.1;
never model, name or reference existing meme characters.** Nintendo names stay
banned (no "Smart Steering", "Mario", "Mushroom", …). Title stays **KRISHIV KART**.

### 14.0 Removed in v3
The 4 kid racers (krishiv, striker_max, rayyaan, jordan), the custom "My Racer"
slot, the cosmetic garage (name/skin/hair/headwear/eyewear/outfit/paint/trim/
rim/driverColor), the Easy/Normal/Hard selector (replaced by engine class) and
the desktop character-select/garage screens (kept only for keyboard mode,
§14.6). `customize.js` is replaced by `parts.js` (written); once nothing imports
customize.js the verifier deletes it.

### 14.1 Cast — Brainrot roster

This roster supersedes the earlier original-character designs. See [research and visual references](docs/brainrot-roster.md).

| Class | ID | Character | Group | Visual details |
|---|---|---|---|---|
| light | `ballerina` | Ballerina Cappuccina | L1 | Cappuccino-cup ballerina, pink tutu, pointe shoes. |
| light | `cappuccino` | Cappuccino Assassino | L1 | Ninja coffee cup with a black headband and twin swords. |
| light | `trippi` | Trippi Troppi | L2 | The tabby-cat and orange-shrimp version of Trippi Troppi. |
| light | `chimpanzini` | Chimpanzini Bananini | L2 | Green chimpanzee peeking out of a peeled banana. |
| medium | `sahur` | Tung Tung Tung Sahur **LEAD** | M2 | The wooden log with a face, bare limbs, and his signature bat. |
| medium | `tralalero` | Tralalero Tralala | M2 | Three-legged shark with blue sneakers and a dorsal fin. |
| medium | `bananita` | Bananita Dolfinita | M1 | A dolphin emerging from a bright yellow banana. |
| medium | `lirili` | Lirili Larila | M1 | Cactus-elephant hybrid with a long trunk and sandals. |
| heavy | `patapim` | Brr Brr Patapim | H1 | Forest monkey with a tree-trunk body, leafy crown, and big nose. |
| heavy | `saturnita` | La Vaca Saturno Saturnita | H1 | Cow head on a ringed Saturn body. |
| heavy | `bombardiro` | Bombardiro Crocodilo | H2 | Crocodile head fused to a twin-propeller bomber plane. |
| heavy | `gusini` | Bombombini Gusini | H2 | White goose with an aircraft body, wings, and orange beak. |

`DEFAULT_CHARACTER_ID = 'sahur'`. The shared `characters.js` roster feeds desktop, phone, and CPU racers. `brainrot-drivers.js` builds the stylized geometry; the existing kart parts, weight groups, material cache and high/low LOD interfaces remain in use. Portraits are generated with `node tools/render-portraits.mjs`.

### 14.2 Parts, stats, engine class — `parts.js` (written; read it)
`final ratings = clamp(character + body + wheels, 1, 5)` for EVERY kart (CPUs too).
`statsFromRatings` (parts.js) replaces characters.js's version. `new Kart({ id,
character, track, isPlayer, loadout, ccMult = 1, steerAssist = false, slot = null })`:
topSpeed and accel × ccMult; `stats.offroadMult = min(0.8, KART.offroadSpeedMult +
offroadBonus(loadout))`. Bumps: effective mass = mass × (0.55 + 0.45 ×
clamp(speed/topSpeed, 0, 1)) × (boosting ? 1.5 : 1); each kart's push share = other's
effective mass / sum. CPUs pick a seeded `CPU_PRESETS[weightClass]` loadout per set.
Engine class (`ENGINE_CLASSES`, default 100cc) scales kart top speed/accel, item
projectile speeds and CPU pace (not turn rate, drift tier times or boost durations)
and sets CPU difficulty (50 easy / 100 normal / 150 hard via config DIFFICULTY).
Rubber band measures against the LEADING human.

### 14.3 Steering & drift (details + derivations in research-steering-feel.md, research-drift-tilt.md, drift-fix.md)
a) **Steer Assist** (per human, phone toggle, default ON; CPUs never): assist edge
`E = min(halfWidth + 0.5, wall − 1.4)` per side (`wall − 1.4` while boosting/star);
`Lt = 2.5 m`, `w = 1 − d/Lt` where d = distance from kart center to E (inside only):
add inward lateral accel `26·w²` m/s², bleed outward lateral velocity by
`exp(−14·w·dt)`, and when not drifting rotate yaw toward the road tangent by
`1 − exp(−2.6·w·dt)`. Look-ahead `D = 6 + 0.6·speed` m with edges inset 0.5 m: if the
velocity heading points e rad outside that window, `c = ±min(1, e/0.35)`; blend with
the player's steer u: same sign → the larger magnitude; opposite sign →
`c + (sign(u) − c)·|u|` (full opposite lock always wins). Facing > 100° the wrong way
→ full lock toward the track direction. While drifting the wheel only shapes the arc
(x = steer·dir), so the correction acts on x instead (`ASSIST_TUNE.driftLimit 2`):
heading inside the window caps x at `1 − 2·min(1, 2|c|)` (wider), outside raises it to
`2·min(1, 2|c|) − 1` (tighter); the edge rotation correction judges the direction of
travel (the nose leads it in a drift), and the nose only beyond a 20° lead (`driftRotate 1`,
`driftNoseLead 0.35`). While ON the drift charge caps at tier 2.
Expose `kart.steerAssist`, `kart.assist` (0..1 strength now), `kart.assistDir`.
KartView: small antenna on assisted karts whose tip glows and bends when assisting.
b) Tuning: kart.js `yawResponse 18, wallScrub 0.25, wallBounce 0.12, wallBounceMax 2.5`
(yawResponse 13–14 and highSpeedTurnLoss 0.25–0.3 were re-measured for the drift fix:
no calmer, more weaving). Phone: dead zone 3°, expo 0.55, low-pass 30/s, default lock
42° (slider 18–50°; half steer at ~30° of tilt, the drift direction needs ~11°, fast
charge ~30°), auto-center at each countdown, Auto-Gas default ON. Settings saved by
tilt mapping v1 that still hold its 32° default load as 42° (`tiltMap: 2`).
c) Drift (Mario Kart semantics: hop, direction locked, the wheel only tightens or
widens the arc, outward slide, blue/orange/purple mini-turbos):
* Direction: the hop (DRIFT pressed at ≥ `DRIFT.minSpeed` 10 m/s, grounded) reads the
  wheel when it LANDS (`driftDirAtLanding`, MK8): `|steer| > 0.1` picks the side, else
  for `landDriftGrace` 0.35 s after landing; a drift needs `0.55 × topSpeed` to start.
  That steer is the player's own wheel, before Steer Assist (`driftDirFromPlayer`): near an
  edge the assist steers away from it, often out of the corner, so it never picks the side.
* Arc: yaw rate = turnRate × `driftTightness(x)` = lerp(0.13, 0.8, ((x+1)/2)^1.5) for
  x = steer·dir: full counter 0.13 / neutral 0.37 / fast-charge position 0.57 / full in
  0.8. Handling 3 at 26 m/s (100cc): R 105 / 37 / 24 / 17 m, full in ≈ normal full lock
  (never tighter), 88°/s, 360° ≥ 3.6 s (best handling 99°/s). No speed factor, but the
  yaw rate is capped at |v| / 10 m (`driftMinRadius`): a slowed drift never pirouettes.
* Slip: the drift yaw fades from 25° to 35° of nose-ahead-of-travel (`driftSlipFade0/1`)
  and the nose is hard-capped at 38° ahead (`driftSlipMax`); steady full-in slip ~18°.
  KartView adds `VIEW_TUNE.driftYaw` 0.2 rad of visual yaw, topped up only to a 32° total.
* Ends: release → mini-turbo for tier ≥ 1; a fresh wall knock (> 1.5 m/s) ends it with
  its mini-turbo (`driftWallEnd`); below `0.5 × topSpeed` it ends with its mini-turbo
  (cancelled when braking); nose more than 90° off the road direction → cancelled
  (`driftMaxHeading`: a drift cannot turn the kart round); spin, < 6 m/s or 0.6 s airborne
  → cancelled. After a drift of ≥ 0.3 s, for 0.35 s the nose swings back onto the
  direction of travel (16/s, lateral grip 6/s) while it points further into the old
  turn than the road, so a release doesn't dart the kart into the inside wall.
* Mini-turbos use `DRIFT.boostSpeedMult = 1.2` (pads, Toot, start boost
keep `KART.boostSpeedMult` 1.32): `applyBoost(duration, source, mult = KART.boostSpeedMult)`,
overlapping boosts keep max mult and max remaining time. `DRIFT.boostDurations =
[0, 0.6, 1.5, 2.4]` × `(1 + 0.06·(accelRating − 3))`; `DRIFT.tierTimes = [0.85, 1.8, 2.8]`
with charge rate 1.0 when `steer·dir ≥ 0.5`, else 0.4. `kart:boost` / `kart:driftEnd`
events carry `tier` (kartview must not infer tier from duration).
d) **Jump boost (trick)**: DRIFT pressed while airborne within the first 0.5 s of a
launch (airTime > 0.15 s) → on landing a 0.6 s boost at ×1.2, `kart:trick` event,
little spin flourish in the view. CPUs trick with probability = their skill.
e) Gates: `node tools/sim.mjs --all` passes on both tracks at every cc; a casual-tilt
probe (human-like noisy, delayed tilt input, no drifting) gets ≤ 0.5 wall hits/lap
with assist ON and ≤ 4.5 with it OFF; expert autopilot plain lap times stay within ±0.3 s.
`node tools/drift-probe.mjs` (phone drifters through pad.js + the real kart, keyboard
drifter, autopilot) with assist ON: 0 % spin-outs and over-rotation ≲ the slip angle
for every style; numbers per release in notes/drift-fix.md.

### 14.4 Tracks
* `tracks.js` (written): `TRACK_LIST [{id, def}]`, `getTrack(id)` (cached),
  `trackInfo(id)`, `CUP = { id: 'gelato', name: 'Gelato Cup', tracks }`. Defs carry
  `id` + `theme`. Code must stop using track.js's single `getTrack()` for gameplay.
* Breezy Bay: widen Bay Bridge (u 8–9) to halfWidth 8.5 with offroad 2.0.
* **Monte Mozzarella** (`track-def-monte.js`, theme `'hilltown'`, ~1071 m,
  counter-clockwise): start from the validated drop-in def in research-tracks-cast.md
  §A12 with the critic's fixes (Aqueduct halfWidth 9.5 at the curve exit then ≥ 8.5
  with offroad ≥ 2.0; Espresso Works offroad 2.0; check the jump landing into the
  Vineyard Sweep, move ramp/pad/item row ~20 m earlier if karts land badly).
  Closure < 0.1 m (track-check). 4 item rows, 4 dash pads, 1 kicker ramp after a pad.
* `worlds.js`: `buildWorld(scene, track, opts)` dispatches on `track.theme`: `'bay'`
  → world.js (existing), `'hilltown'` → `world-monte.js`. Same contract `{ sun,
  update(dt, focus, camera), dispose, getGroundHeight? }`. Hill town: cobbled piazza
  with fountain + café umbrellas + start gantry banner "KRISHIV KART", terracotta
  houses + laundry lines + gelato-shop props, climbing hairpin, striped bell tower on
  the summit, stone aqueduct across a green valley (dash pad + kicker), vineyards +
  cypress trees on the descent, a coffee factory with giant generic stovetop
  coffee pots and a short covered section, pizza-oven final turn. ≤ 120 draw calls,
  ≤ 250k triangles; `quality: 'low'` for split-screen.
* `tools/track-check.mjs --track <id>`, `tools/sim.mjs --track <id> --cc <n>`.

### 14.5 Modes & rules
* **Grand Prix** = Gelato Cup (Breezy Bay → Monte Mozzarella), 3 laps, 8 racers.
  Points `GP_POINTS` (10-8-6-5-4-3-2-1). Race 1 grid: humans fill the last N slots
  (P1 front-most of them); race 2 starts in race 1's finishing order. After each race:
  results (place, name, time, +points) → standings; after the last race → podium
  (top 3 on a 3D podium, confetti) → lobby. Ties: better finish in the last race.
* **VS Race**: host picks a track (or Random), Items On/Off; after results: Next Race
  (pick again; points keep adding up) or Lobby.
* Engine class 50/100/150 (default 100) for both modes.
* Finish: race ends `RACE.resultsDelay` after the last human finishes; with ≥ 2
  humans a 30 s finish clock starts when the first human finishes; humans still
  racing at 0 get placed by running order with estimated times.
* Pause: anyone pauses/resumes (phone pause or Esc); Restart/Quit host-only. With 1
  human, phone hidden/disconnected → pause (existing). With ≥ 2 humans, a
  disconnected/hidden player's kart is driven by an AIDriver (class difficulty, no
  rubber band) and keeps scoring; no global pause.
* Items: same place-based ITEM_TABLE for everyone; Zap: none in the first 30 s, 30 s
  cooldown, ≤ 1 active; Star ≤ 2 at once.

### 14.6 Multiplayer — desktop
* 1–4 humans, one phone each; CPUs fill to 8. Slots P1–P4 (`PLAYER_SLOTS` colors);
  a phone takes the lowest free slot, slots never renumber, host = lowest connected
  slot (crown icon).
* **Desktop is display-only**: lobby (logo, big QR + URL + cert tip, 4 player panels:
  slot color, portrait/3D model, body + wheels names, final stat bars, READY badge,
  host crown; settings line "Grand Prix · 100cc"; status line "Waiting for players" /
  "P1 is choosing the track"), cup/track display, loading, split-screen race,
  results, standings, podium. All personal choices happen on phones.
* **Keyboard mode** (solo/testing only): with NO phone connected, Enter on the lobby
  joins a keyboard player as P1 who makes the same choices with a desktop version of
  the phone flow; it ends as soon as a phone joins (that phone becomes P1).
* Split-screen: 1P full; 2P side by side (vFOV 76); 3P quadrants with Q4 = big
  minimap + live standings; 4P quadrants with a small shared minimap at the center.
  Each view: own PerspectiveCamera + ChaseCamera + HUD scaled to the view, colored
  border in the slot color, "P2"-style tags over other humans' karts. Renderer
  viewport/scissor per view.
* Performance with ≥ 2 views: world `quality: 'low'`/blob shadows instead of the
  follow shadow map, low-LOD karts for karts a view doesn't own, pixelRatio 1 in
  3–4P, particles halved. Targets: 60 fps in 2P, ≥ 30 fps in 3–4P.

### 14.7 Protocol — server.js / net.js
* `pad:hello {room, padId}` → ack `{ ok, slot, color, host, error?: 'full' | 'room' }`
  (5th phone → 'full'). A returning padId gets its slot back (reserved 5 min).
* server→host: `pad:join {slot, padId, host}`, `pad:leave {slot, padId, reason}`,
  `pad:input {slot, s, g, b, d, i, p, t}`, `pad:menu {slot, action, ...}`,
  `slots {host, connected: [slot...]}` on any change.
* host→server→pads: `host:state` (shared; cached; to every pad), `host:padState
  {slot, ...}` (only to that slot; cached per slot), `host:event {slot?, type, ...}`
  (no slot = all). server→pad: `slot:update {slot, host, color}`.
* host→server: `host:release {slot}` (desktop drops a player after 20 s
  disconnected in menus; frees the reservation).
* `pad:menu` actions (server whitelists/sanitizes; desktop enforces host-only):
  host-only `mode {value:'gp'|'vs'}`, `cc {value:50|100|150}`, `items {value:bool}`,
  `start`, `track {value: id | 'random'}`, `go`, `next`, `quit`, `restart`;
  everyone `char {id}`, `body {id}`, `wheels {id}`, `back`, `ready {value:bool}`,
  `assist {value:bool}`, `pause`, `resume`. ids match `/^[a-z0-9_-]{1,32}$/`.
* `host:state`: `{ screen: 'lobby'|'select'|'track'|'loading'|'race'|'results'|
  'standings'|'podium'|'paused', mode, cc, items, host, raceNo, races, track:
  {id,name}|null, tracks:[{id,name}], cup:{name,tracks}, players:[{slot, color,
  connected, ready, char, body, wheels, assist}], characters:[{id, name, shortName,
  weightClass, cssColor, accent, ratings, img, custom}], bodies:[{id,label,desc,mods}],
  wheels:[{id,label,desc,mods,offroad}], results:[{place, name, cssColor, time,
  points, slot, finished}]|null, standings:[{place, name, cssColor, points,
  slot}]|null }`.
* `host:padState`: `{ slot, color, isHost, step: 'char'|'body'|'wheels'|'ready'|'done',
  choice:{char, body, wheels, assist}, ratings, race:{state, lap, laps, place, racers,
  item, itemCount, rolling, countdown, finished, assist, assistActive}|null,
  standing:{place, points}|null }`.
* `PhoneLink` (net.js): `connect()`, `players` (Map slot → { slot, padId, connected,
  input }), `host`, `on('join'|'leave'|'menu'|'slots'|'info', fn)`, `getInput(slot)`
  (zeros if none), `isActive(slot)`, `sendState(shared)`, `sendPadState(slot,
  state)` (both dedupe + heartbeat), `sendEvent(type, data, slot?)`, `release(slot)`.

### 14.8 Phone flow — pad.js
Join → **lobby**: "You are P2" in the slot color (+ crown if host). Host sees MODE
(Grand Prix / VS Race), CLASS (50/100/150), ITEMS (VS only) and START; others see
"Waiting for P1…". **Select** (each phone at its own pace): CHARACTER (rows Light /
Medium / Heavy, portraits, + a Custom row if any; selected racer's name, catchphrase,
4 stat bars) → KART BODY (6; final stat bars with +/− vs character) → WHEELS (6; same)
→ READY card (summary, Steer Assist toggle default ON, Auto-Gas toggle default ON,
big READY, BACK). Waiting screen lists everyone's status. When all connected players
are ready: host gets the **track** screen (GP: Gelato Cup card + GO; VS: track cards +
Random + GO); others see "P1 is choosing…". **Race**: existing controller + assist
pip; DRIFT in the air = trick. Results / standings / podium mirrored; host gets NEXT /
LOBBY. Settings sheet keeps sensitivity / invert / auto-gas / assist.

### 14.9 Custom racers (.glb)
`public/characters/index.json`: `[{ id, name, file, weightClass: 'light'|'medium'|'heavy',
color: '#rrggbb', scale?, yOffset?, rotationY? }]` + the `.glb` files beside it. The
desktop loads them at boot (GLTFLoader from three/addons), registers them via
`registerCustomCharacters` (ratings from `CUSTOM_GROUP_FOR_CLASS`), and
buildKartModel seats the cloned model as the driver (normalized to ~1.0 m above the
seat, centered, facing +Z) on the chosen body/wheels. Broken/missing files are
skipped with a console warning. They appear as a "Custom" row on phones (color + name
card), never as CPUs. Ship `index.json` as `[]` plus README instructions. Ship no
third-party models.

---------------------------------------------------------------------------

## 15. v4 — steering cap + drift-exit fix, full item set, 3 new tracks, cups

§15 supersedes earlier sections where they conflict. Research briefs for this
round: `notes/research-v4-items.md`, `notes/research-v4-steering.md`,
`notes/research-v4-tracks.md` (written in the Research phase). **The cast /
characters.js is OUT OF SCOPE** (the user is redoing characters separately) — do
not edit characters.js or public/img/racers/. Nintendo names stay banned in code and
UI (no "Blue Shell", "Bullet Bill", "Blooper", "Bob-omb", "Mushroom", "Bowser",
"Thwomp", …); mechanics may mirror Mario Kart 8 Deluxe.

### 15.1 Steering (playtester: "small adjustments are OK, bigger adjustments swing too hard; there should be a cutoff like a real steering wheel's lock" and "after a drift, it goes too hard in that direction when you let go")
* Phone tilt → steer must be a **saturating** curve: responsive and roughly linear
  around centre, easing into a hard cap; tilting past the lock angle adds nothing
  (today's expo curve gets STEEPER toward lock — remove that behaviour). The cap
  ("steering lock") may be < 1.0 of the kart's full turn authority if research +
  probes show full authority is too strong at speed; also review the kart's own
  full-lock turn rate at speed vs Mario Kart (research says ours is ~2× MK) and
  speed-sensitive steering. Keyboard keeps working (its ramp is separate).
* **Drift exit**: when a drift ends (release, cancel, wall), the phone is still
  tilted hard into the corner; normal steering must NOT instantly apply that tilt.
  Measure the post-release heading swing with tools/drift-probe.mjs, then fix
  (e.g. a post-drift steering latch/ramp that blends from the drift-equivalent
  steer to the live tilt over ~0.4–0.7 s, released early when the player
  re-centres) — choose by research + probe evidence. Same for keyboard/gamepad.
* Gates: all existing probes/suites pass; new probe metrics for "large tilt step
  → heading swing" and "post-drift-release swing" improve clearly vs baseline.

### 15.2 Items (MK8DX-style set with original names/looks)
Keep the 8 existing items. Add (ids exact; names/looks original; numbers from the
research brief):
| id | name | role (MK8DX analog by mechanics only) |
|---|---|---|
| `triple_banana` | Banana Bunch | 3 bananas trailing behind; drop one at a time |
| `triple_bouncer` | Triple Bouncers | 3 bouncers orbiting the kart (block hits); fire one at a time |
| `triple_rocket` | Triple Rockets | 3 homing rockets orbiting; fire one at a time |
| `capo` | Capo Crusher | leader-seeker: winged spiky golden meatball that flies along the track to **1st place** and slams down with an explosion (tumble + big slow) hitting karts near the leader; others on its path may be bumped; only an Accordion Blast (or a precisely-timed boost, research) avoids it; ≤ 1 active, cooldown |
| `golden_toot` | Golden Toot | unlimited boosts for ~7.5 s (press repeatedly) |
| `meatball_bomb` | Meatball Bomb | throwable fused bomb (forward throw; dropped behind if research says so) — explodes on contact/fuse, blast radius tumbles karts |
| `espresso` | Espresso Splash | everyone AHEAD of the user gets coffee splattered on their screen for ~4–5 s (per-view overlay; CPUs: impaired steering/slower), phones buzz |
| `accordion` | Accordion Blast | shockwave around the user: spins nearby karts and destroys nearby items/projectiles INCLUDING an incoming Capo Crusher |
| `beer_rocket` | Beer Rocket | (the user's design) the racer **chugs a giant foamy beer mug** (short animation), then rides a mug-shaped rocket: autopilot along the racing line at very high speed, invincible, knocking karts aside; lasts until ~5 places gained or a max time (min time applies), then pops out with a small boost. Back-of-pack only (last / 2nd-to-last mostly) |
* **Distribution by position** like Mario Kart: leaders get defensive/weak items,
  the back gets strong catch-up items. Implement the research's table for 8 racers
  (ITEM_TABLE rows = places 1–8, columns = ITEM_IDS) plus caps/cooldowns
  (≤ 1 Capo at a time + cooldown, no Capo/Beer Rocket/Zap/Espresso too early in a
  race, no Beer Rocket for places 1–4, Star limits, etc.). Items On/Off still works.
* Every item needs: physics/logic in items.js, visuals (3D + held/orbit/trail),
  HUD icon + roulette, phone item icon (config ITEM_INFO), SFX (audio.js, synthesized),
  CPU usage in ai.js, bus events, sim coverage. New bus events: `item:capoLaunch
  {kart, target}`, `item:capoWarning {target}` (1st place warned), `item:capoHit
  {kart, position}`, `item:espresso {kart, victims}`, `item:accordion {kart}`,
  `item:beerStart {kart}`, `item:beerEnd {kart}`, `item:bombExplode {position}`.
* HUD API additions (hud.js): `splash(strength 0..1, duration)` per view
  (espresso overlay), item slot shows triple counts; `warn(type)` for an incoming
  Capo (siren-style indicator, like MK).
* As built (v4): items.js writes kart fields `beer` (null | { phase: 'chug'|'ride', … }), `ink` (0..1),
  `inkIncoming`, `capoWarn` (0 | 1 incoming | 2 locked on) and `goldenTimer`; the HUD reads `ink` / `capoWarn` of its own
  player itself. Beer Rocket invincibility rides on `starTimer` (no kart.js hook). Details: notes/v4-items.md.

### 15.3 Tracks (3 new; low-poly, bright, same perf budget as §14.4)
* **Aldrich Park** (`aldrich`, theme `'campus'`): inspired by UC Irvine's Aldrich
  Park — the circular park at the centre of campus ringed by the Ring Mall walkway
  and campus buildings; eucalyptus/tree groves, grassy hills, footbridges, paths,
  a botanical-garden corner. No university logos/mascots/seals.
* **Laguna Beach** (`laguna`, theme `'beach'`): inspired by Laguna Beach's Main
  Beach — the coast highway through the village, the Main Beach boardwalk and sand,
  the iconic little lifeguard tower, palm trees, beach courts, the clifftop park
  path with ocean views, rocky coves. No real business logos.
* **Krishiv's Palace** (`palace`, theme `'castle'`): a dark lava fortress in the
  style of classic kart-racer castle finales — drawbridge over a lava moat, stone
  halls with torches, faceless crushing stone blocks that slam the road, rotating
  fire bars, lava falls, a jump over lava, banners with a crowned "K" emblem, a
  throne-hall finale. Original design: no Nintendo characters, faces or emblems.
  Hazards affect karts via the world API: `world.hazards = { update(dt), check(kart)
  → null | 'crush' | 'fire' }` (crush → tumble, fire → spin; respect invincibility).
* Each track: closed turtle def (track-check passes), 4 item rows, 3–4 dash pads,
  1–2 ramps, widths per §14.3e (tilt-friendly: halfWidth ≥ 8.5, ≥ 9.5 at tight
  exits, grass ≥ 2 m), length ~950–1250 m, distinct shape/direction/elevation.
  steer-probe + drift-probe + sim must pass on every track.
* **Cups** (tracks.js `CUPS`): `gelato` "Gelato Cup" = breezy → monte → aldrich →
  laguna (4 races); `krishiv` "Krishiv Cup" = breezy → laguna → monte → aldrich →
  palace (5 races, castle finale). Keep `CUP` as an alias of the first cup for old
  callers. Host picks the cup on the phone track screen (GP); VS can pick any of
  the 5 tracks or Random. New pad:menu action `cup {id}` (host-only).

---------------------------------------------------------------------------

## 16. v5 — better maps (longer, twistier, set pieces, textures, music, accurate Aldrich Park) + every kart-racer item with balancing

§16 supersedes earlier sections where they conflict. Research briefs (written in
the Research phase): `notes/research-v5-items.md`, `notes/research-v5-tracks.md`,
`notes/research-v5-aldrich.md`.

### 16.0 Scope rules
* **Characters are the user's own work (characters.js now holds their roster, made
  with another tool). Do not edit characters.js, public/img/racers/, or any
  character model; do not reference those characters in anything new.** If a test
  depends on character ids, make it roster-agnostic (read CHARACTERS) instead.
* Everything new is original: no Nintendo names in code/UI (no "Fire Flower",
  "Boomerang Flower", "Piranha Plant", "Boo", "Mega Mushroom", "POW", "Kamek",
  "Super Leaf", "Lucky 7", "Crazy 8", "Coin Shell", "Thunder Cloud", "Spiny", …),
  no Nintendo character likenesses; mechanics may mirror Mario Kart. Track set
  pieces may be inspired by Mario Kart track ideas (waves, rolling obstacles,
  traffic, moving hazards) but layouts and art are original.
* Real places (Aldrich Park at UC Irvine, Laguna Beach) may be depicted; no
  university/business logos, mascots or seals. If OpenStreetMap data is used for
  geometry, credit "© OpenStreetMap contributors" in README.

### 16.1 Maps — all five improved
* **Longer + more turns**: target lap 1300–1600 m (3 laps ≈ 2–2.5 min at 100cc)
  with more corner variety (chicanes, esses, sweepers, a hairpin, elevation),
  still tilt-friendly (halfWidth ≥ 8.5 m, ≥ 9.5 at tight exits, grass ≥ 2 m,
  min radius ≥ 22 m) — track-check passes.
* **Set pieces in the map** (like the palace's crushers/fire bars): 2–4 per track,
  deterministic timing with fair windows, readable visuals, CPU-dodgeable via the
  hazards API. Ideas per theme (original): Breezy Bay — crabs scuttling across,
  beach balls rolling, wave surges over a low beach road, a cliff jump; Monte
  Mozzarella — giant cheese wheels rolling down the hill road, piazza scooter
  traffic, fountain jets, a trick ramp; Aldrich Park — lawn sprinklers (spin/slow),
  cyclists/skateboarders crossing the ring, ducks at the pond?, a shortcut through
  the trees; Laguna Beach — waves washing over the beach road on a cycle, crabs,
  volleyballs, the lifeguard-tower jump, tide-pool splash; Krishiv's Palace —
  extend: lava geysers, rotating fire, moving platforms/conveyor, a lava-fall
  tunnel, the throne-room spiral. Plus shortcuts (≤ 1–2 per track, item-boost or
  skill based), extra ramps/trick spots, dash pads.
* **Hazards registry** (`public/js/hazards.js`): `createHazards(track)` dispatches
  by track theme to per-track modules `public/js/hazards/<theme>.js` (`bay`,
  `hilltown`, `campus`, `beach`, `castle` — move the palace set there). Interface
  unchanged (`update, setTime, reset, stateAt, check(kart), hitAt, ahead`), but
  `check()` may return a string type or `{ type, effect: 'tumble'|'spin'|'slow'|'knock', strength? }`;
  main.js maps effects generically (old 'crush'→tumble, 'fire'→spin still work).
  World builders expose `world.hazards` and draw them; the sim runs them headless.
* **Textures**: richer per-track materials (higher-res canvas textures, detail
  variation, cobble/sand/grass/stone/asphalt variety, painted road details),
  within perf budget (≤ 120 draw calls / ≤ 280k tris world at 'high'; 'low' for split).
* **Coins** (kart-racer staple): track defs get `coins: [{ u, count, lateral, spacing }]`;
  track.js exposes `track.coins` (positions). The items team implements pickup,
  visuals, effect and HUD (§16.3).
* **Aldrich Park accuracy**: rebuild from real geometry (research-v5-aldrich.md):
  the circular park, the Ring Mall loop, real path/bridge layout inside the park,
  hills/groves/landmark positions, surrounding campus buildings placed by real
  bearing/distance (generic architecture, no logos). track.js gains a **path mode**:
  a def may give `path: [[x, z], ...]` (closed control points, centripetal
  Catmull-Rom, resampled) instead of turtle `segments`; all other keyframe fields
  (elevation/halfWidth/offroad/itemRows/... as arc-length fractions `f` 0..1 or u)
  must work in both modes.
* **Music**: an original synthesized theme per track in audio.js SONG_DEFS named by
  theme so main.js picks them automatically: refresh `race` (Breezy Bay — sunny
  pop) and `hilltown` (Monte — Italian-flavoured tarantella feel), add `campus`
  (Aldrich — breezy indie/lo-fi), `beach` (Laguna — surf rock), `castle` (palace —
  dark organ/rock), each with a final-lap intensity; original melodies only; keep
  the Claude Song rotation and FILE_SONGS untouched.

### 16.2 Items — an equivalent for every distinct kart-racer item
* Keep all 17 current items unchanged. Add an original-named equivalent for every
  remaining distinct race item across Mario Kart 8 Deluxe, Mario Kart World and
  notable earlier entries (e.g. fireball thrower, returning boomerang, chomping
  plant, item-steal + invisibility, giant growth, ring of eight items, coin(s),
  ice/freeze thrower, arcing hammers, coin-dropping shell, jump feather, tail-spin
  leaf, fake item box, shockwave slam, raincloud that shrinks, giant banana, lucky
  seven, hearts that absorb hits, etc.) exactly as the research brief lists — skip
  battle-only items and items fully duplicated by ours.
* **Plugin architecture** (Foundation): new items live in `public/js/items/*.js`
  modules registered via `registerItem(id, handler)` with hooks for use, per-substep
  update, collisions (shared helpers from ItemSystem), visuals (scene objects),
  clear/dispose, and `aiUse(kart, ctx) → bool` consumed by ai.js; sounds via
  `registerSound(name, fn)` in audio.js. config.js gets every new id in ITEM_IDS
  (appended), ITEM_INFO (original name, emoji icon, colour, uses) and the full
  balanced ITEM_TABLE. HUD/phone icons are data-driven from ITEM_INFO.
* **Balancing** (from research): place-based 8-row table for all items with the
  existing far-behind shift, plus caps/cooldowns/early-race locks for strong
  items, coin rules (max 10 coins, small top-speed bonus per coin, lose some on
  hits), and sim/race-logic checks that every item appears and nothing breaks.
