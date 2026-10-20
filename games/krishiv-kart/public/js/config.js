// Shared tuning constants — the single source of truth for numbers that more
// than one module depends on. Node-safe (no DOM access).

export const GAME_TITLE = 'KRISHIV KART';

export const RACE = {
  laps: 3,
  racers: 8,
  introSeconds: 4.0,          // camera flyover before the countdown starts
  countdownSeconds: 3.0,      // "3", "2", "1" each last 1s, then GO
  playerGridSlot: 7,          // 0 = pole position, 7 = last row (solo; humans fill the last N slots)
  resultsDelay: 4.0,          // seconds after the LAST human finishes before results show
  finishClock: 30,            // with >= 2 humans: seconds the others get once the first human finishes
  startBoostWindow: [0.25, 0.75], // seconds BEFORE "GO" in which first throttle press grants a start boost
  startStallBefore: 1.6,      // pressing throttle earlier than this many seconds before GO stalls the engine
  wrongWayDelay: 1.0,         // seconds facing backwards before WRONG WAY shows
};

export const KART = {
  radius: 1.1,                // collision circle radius (m)
  gravity: 28,                // arcade gravity (m/s^2)
  // Reference only (audio pitch, speedometers): a 3-star kart at 150cc tops out
  // at topSpeedBase + 3 * topSpeedPerStar = 29 m/s. Stat math is parts.js statsFromRatings.
  topSpeedBase: 26.0, topSpeedPerStar: 1.0,
  reverseMax: 9,
  brakeDecel: 32,
  coastDecel: 5,
  offroadSpeedMult: 0.5,      // max-speed multiplier on grass (ignored while boosting / star); + wheel offroad bonus
  offroadMultMax: 0.8,        // ... whatever the tires
  curbSpeedMult: 0.96,
  boostSpeedMult: 1.32,       // max-speed multiplier of pads, Toot items and the start boost
  boostAccel: 45,             // m/s^2 toward boosted max speed
  starSpeedMult: 1.15,
};

export const DRIFT = {
  minSpeed: 10,               // m/s needed to hop (and, x 0.8, to start a drift) ...
  startSpeedFrac: 0.55,       // ... and a drift needs this share of the kart's top speed to start (genre standard: 55 %)
  keepSpeedFrac: 0.5,         // below this share a drift ends (genre standard: 50 %; mini-turbo if charged, cancelled when braking)
  hopVelocity: 5,             // upward velocity of the drift hop (m/s)
  tierTimes: [0.85, 1.8, 2.8],          // seconds of full-rate charge to reach tier 1/2/3
  chargeIntoMin: 0.5,         // steer * dir >= this (wheel held into the turn) charges at the full rate ...
  chargeSlowRate: 0.4,        // ... any other wheel position charges at this rate
  boostDurations: [0, 0.6, 1.5, 2.4],   // mini-turbo length per tier at 3 Accel stars (index = tier)
  boostAccelGain: 0.06,       // duration x (1 + gain * (accelRating - 3))
  boostSpeedMult: 1.2,        // max-speed multiplier of drift mini-turbos and trick boosts
  assistMaxTier: 2,           // Steer Assist caps the charge at this tier
  // jump boost (trick): DRIFT pressed in the air within trickWindow s of a
  // launch; it counts once the kart has been airborne trickMinAir s
  trickWindow: 0.5,
  trickMinAir: 0.15,
  trickBoost: 0.6,            // boost length on landing (at boostSpeedMult)
  tierColors: ['#ffffff', '#38c8ff', '#ff9d2e', '#c45cff'],
};

export const HIT = {
  spinDuration: 1.0,          // banana / stink cloud
  tumbleDuration: 1.5,        // bouncer / rocket / star ram
  zapSpinDuration: 0.8,
  zapSlowDuration: 2.5,
  zapSlowMult: 0.72,          // max-speed multiplier while zapped
  invulnAfterHit: 1.2,        // grace period after recovering
  capoTumble: 2.0,            // Capo Crusher slam: the target tumbles this long ...
  capoSpeedKeep: 0.1,         // ... and keeps this share of its speed (stopped in place)
  // v5 kart effects (notes/research-v5-items.md §C2; implemented by the v5 item agents, data only here)
  iceTime: 1.4, iceSlideDecel: 4,                                       // Granita freeze: sliding straight
  shrinkTime: 4.0, shrinkScale: 0.55, shrinkSpeedMult: 0.85, shrinkAccelMult: 0.9,
  squashTime: 1.6, squashSpeedMult: 0.35, squashSteerMult: 0.6,         // Maxi Mortadella flatten
  splitSpinTime: 1.6,                                                   // Banana Split giant peel
  sootTime: 3.0, sootSpeedMult: 0.94,                                   // Befana's soot (items locked, drift cancelled)
};

export const BOOST = {
  padDuration: 1.0,
  tootDuration: 1.25,
  startDuration: 1.2,
};

export const STAR = { duration: 7.5 };

// Item ids — every module must use exactly these strings. Append-only: the v4
// items follow the original 8, the v5 items (SPEC §16.2, notes/research-v5-items.md)
// follow the v4 ones, so every ITEM_TABLE column keeps its meaning.
export const ITEM_IDS = ['banana', 'bouncer', 'rocket', 'toot', 'triple_toot', 'stink', 'star', 'zap',
  'triple_banana', 'triple_bouncer', 'triple_rocket', 'capo', 'golden_toot', 'meatball_bomb',
  'espresso', 'accordion', 'beer_rocket',
  // v5 group A (thrown / placed / projectile / environment) — plugin modules in public/js/items/<id>.js
  'peperoncino', 'granita', 'flying_pizza', 'rolling_pins', 'piggy_bank', 'parm_wheel', 'surprise_egg',
  'prank_box', 'banana_split', 'sour_lemon', 'padella', 'taralli', 'befana',
  // v5 group B (self-buff / transform / kart-state / coins)
  'calzone', 'ladro', 'hot_potato', 'mortadella', 'tarantella', 'grissino', 'antipasto', 'amore',
  'lira_purse', 'tip_jar'];

// The v4 + original items (built into items.js); every other id is a plugin (public/js/items/).
export const NATIVE_ITEM_IDS = ITEM_IDS.slice(0, 17);

// Which items the roulette may hand out. A v5 item stays false until its plugin
// module is implemented (its item agent flips it to true); a disabled column is
// zeroed in ItemSystem.weightsFor (so the other columns are renormalised by the
// pick), the HUD / phone roulette reels skip its icon, and tests read the
// effective table. Missing / true = enabled (every v4 item).
export const ITEM_ENABLED = {
  peperoncino: true, granita: true, flying_pizza: true, rolling_pins: true, piggy_bank: true,
  parm_wheel: true, surprise_egg: true, prank_box: true, banana_split: true, sour_lemon: true,
  padella: true, taralli: true, befana: true,
  calzone: true, ladro: true, hot_potato: true, mortadella: true, tarantella: true, grissino: true,
  antipasto: true, amore: true, lira_purse: true, tip_jar: true,
};

/** Can the roulette hand out this item (ITEM_ENABLED)? */
export const itemEnabled = (id) => ITEM_ENABLED[id] !== false;

// uses = presses per pickup (triples: the attached items, one per press). The
// Golden Toot is one item that stays in the slot for its ITEM.goldenTime window
// (press as often as you like); the Beer Rocket stays in the slot while it runs.
// v5 fields: timed = s window that starts on the first press (the slot shows a
// draining meter; uses = max presses in it); auto = activates on the roulette
// end (the slot stays free).
export const ITEM_INFO = {
  banana:         { name: 'Banana Peel',     icon: '🍌', color: '#ffd93b', uses: 1 },
  bouncer:        { name: 'Bouncer',         icon: '🟢', color: '#3ddc5a', uses: 1 },
  rocket:         { name: 'Homing Rocket',   icon: '🚀', color: '#ff4b3e', uses: 1 },
  toot:           { name: 'Toot Boost',      icon: '💨', color: '#b8f0ff', uses: 1 },
  triple_toot:    { name: 'Triple Toot',     icon: '💨', color: '#7fe3ff', uses: 3 },
  stink:          { name: 'Stink Bomb',      icon: '🦨', color: '#9be15d', uses: 1 },
  star:           { name: 'Rainbow Star',    icon: '⭐', color: '#ffe14d', uses: 1 },
  zap:            { name: 'Zap Cloud',       icon: '⚡', color: '#ffe600', uses: 1 },
  triple_banana:  { name: 'Banana Bunch',    icon: '🍌', color: '#ffd93b', uses: 3 },
  triple_bouncer: { name: 'Triple Bouncers', icon: '🟢', color: '#3ddc5a', uses: 3 },
  triple_rocket:  { name: 'Triple Rockets',  icon: '🚀', color: '#ff4b3e', uses: 3 },
  capo:           { name: 'Capo Crusher',    icon: '🧆', color: '#ffb300', uses: 1 },
  golden_toot:    { name: 'Golden Toot',     icon: '✨', color: '#ffc928', uses: 1 },
  meatball_bomb:  { name: 'Meatball Bomb',   icon: '💣', color: '#b5653a', uses: 1 },
  espresso:       { name: 'Espresso Splash', icon: '☕', color: '#a0714f', uses: 1 },
  accordion:      { name: 'Accordion Blast', icon: '🪗', color: '#e0466a', uses: 1 },
  beer_rocket:    { name: 'Beer Rocket',     icon: '🍺', color: '#f2b632', uses: 1 },
  // v5 (SPEC §16.2; specs + reasoning: notes/research-v5-items.md §C6)
  peperoncino:    { name: 'Peperoncino Blaster', icon: '🌶️', color: '#ff3b1f', uses: 8, timed: 8 },
  granita:        { name: 'Granita Freeze',      icon: '🍧', color: '#8fe3ff', uses: 1 },
  flying_pizza:   { name: 'Flying Pizza',        icon: '🍕', color: '#ffb347', uses: 3 },
  rolling_pins:   { name: 'Rolling Pins',        icon: '🪵', color: '#d9a066', uses: 5, timed: 5 },
  piggy_bank:     { name: 'Piggy Bank',          icon: '🐷', color: '#ff8fb1', uses: 1 },
  parm_wheel:     { name: 'Parmesan Wheel',      icon: '🧀', color: '#f4d27a', uses: 1 },
  surprise_egg:   { name: 'Surprise Egg',        icon: '🥚', color: '#ff9ec4', uses: 1 },
  prank_box:      { name: 'Prank Box',           icon: '🎁', color: '#c040ff', uses: 1 },
  banana_split:   { name: 'Banana Split',        icon: '🍨', color: '#fff07a', uses: 1 },
  sour_lemon:     { name: 'Sour Lemon',          icon: '🍋', color: '#fff200', uses: 1 },
  padella:        { name: 'Padella Slam',        icon: '🍳', color: '#9aa3ad', uses: 1 },
  taralli:        { name: 'Taralli Hoops',       icon: '🥯', color: '#e8b04a', uses: 1 },
  befana:         { name: "Befana's Broom",      icon: '🧹', color: '#7b4fc9', uses: 1 },
  calzone:        { name: 'Chomping Calzone',    icon: '🥟', color: '#e0a050', uses: 1, timed: 8 },
  ladro:          { name: 'Ladro Mask',          icon: '🎭', color: '#6c5ce7', uses: 1 },
  hot_potato:     { name: 'Hot Potato',          icon: '🥔', color: '#c8873a', uses: 1, auto: true },
  mortadella:     { name: 'Maxi Mortadella',     icon: '🍖', color: '#ff8a9a', uses: 1 },
  tarantella:     { name: 'Tarantella Jump',     icon: '🤸', color: '#ff5e7e', uses: 1 },
  grissino:       { name: 'Grissino Swipe',      icon: '🥖', color: '#f0c27b', uses: 1, timed: 10 },
  antipasto:      { name: 'Antipasto Platter',   icon: '🍽️', color: '#ffcf40', uses: 8 },
  amore:          { name: 'Amore Hearts',        icon: '💕', color: '#ff4f8b', uses: 1 },
  lira_purse:     { name: 'Lira Purse',          icon: '💰', color: '#f5c542', uses: 1 },
  tip_jar:        { name: 'Tip Jar',             icon: '🫙', color: '#ffd166', uses: 6, timed: 6 },  // '🏺' if 🫙 (Unicode 14) shows tofu
};

// Item roulette weights by race place (index 0 = 1st place ... 7 = 8th place;
// every row sums to 100). Columns follow ITEM_IDS: the 17 v4 columns (rescaled
// in v5 to make room) then the 23 v5 columns. Leaders get defence plus a "dud"
// (Lira Purse), the back of the pack the catch-up items (notes/research-v4-items.md
// §B3, notes/research-v5-items.md §C3); the hard rules (ITEM start times, caps,
// cooldowns, place gates for the v4 ids, ITEM_RULES for the v5 ids) are applied
// on top, a disabled column (ITEM_ENABLED) is zeroed, and a kart far behind the
// leader reads a row further back (farBehind*).
//           ban bnc rkt tot 3tt stk str zap 3bn 3bc 3rk cpo gld bmb esp acc ber  (v4 columns)
//           pep gra piz pin pig prm egg prk spl lem pan tar bef cal lad pot mor jmp gri ant amo lir tip  (v5 columns)
export const ITEM_TABLE = [
  /* 1st */ [ 21, 14,  2,  0,  0, 12,  0,  0,  7,  0,  0,  0,  0,  4,  0,  3,  0,
               0,  0,  0,  0,  2,  0,  0,  7,  4,  3,  0,  0,  0,  0,  0,  0,  0,  1,  4,  0,  0, 14,  2 ],
  /* 2nd */ [  8, 10, 20,  9,  2,  6,  0,  0,  4,  4,  1,  0,  0,  3,  0,  3,  0,
               2,  1,  2,  2,  2,  0,  2,  4,  2,  1,  0,  1,  0,  0,  0,  1,  0,  1,  3,  0,  1,  4,  1 ],
  /* 3rd */ [  3,  6, 13, 12,  6,  3,  1,  0,  3,  6,  2,  0,  0,  3,  1,  2,  0,
               4,  2,  3,  3,  2,  1,  2,  2,  1,  1,  0,  2,  1,  2,  1,  2,  1,  2,  2,  0,  2,  2,  1 ],
  /* 4th */ [  2,  4, 10, 10, 13,  2,  3,  0,  1,  5,  5,  1,  1,  3,  3,  1,  0,
               3,  2,  2,  2,  2,  1,  2,  1,  0,  0,  2,  2,  1,  3,  2,  2,  2,  2,  1,  0,  2,  1,  1 ],
  /* 5th */ [  0,  2,  8,  8, 19,  1,  6,  0,  0,  4,  5,  2,  2,  2,  4,  0,  0,
               3,  2,  2,  2,  1,  2,  1,  0,  0,  0,  3,  3,  1,  3,  3,  2,  4,  1,  0,  1,  2,  0,  1 ],
  /* 6th */ [  0,  1,  4,  5, 17,  0, 12,  1,  0,  2,  4,  4, 11,  1,  3,  0,  1,
               2,  1,  1,  2,  1,  2,  1,  0,  0,  0,  3,  3,  1,  3,  3,  1,  5,  1,  0,  2,  1,  0,  1 ],
  /* 7th */ [  0,  0,  2,  3, 16,  0, 19,  3,  0,  0,  2,  5, 17,  0,  2,  0,  9,
               1,  0,  0,  1,  0,  1,  0,  0,  0,  0,  2,  2,  1,  2,  3,  0,  5,  0,  0,  3,  1,  0,  0 ],
  /* 8th */ [  0,  0,  0,  2, 14,  0, 21,  5,  0,  0,  0,  3, 22,  0,  2,  0, 17,
               0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  2,  2,  0,  1,  2,  0,  4,  0,  0,  3,  0,  0,  0 ],
];

// v5 hard rules (race seconds since GO; "in play" = held + rolling + live
// entities spawned by the item + handler.countLive() across karts). Applied
// generically by ItemSystem.weightsFor: a blocked column re-rolls among the others.
//   freeTime: no roll before this race time      max: at most this many in play
//   cooldown: s after the stamp (cooldownFrom 'use' = stamped on the first press,
//             automatic; 'end' = the plugin calls ctx.startCooldown() when it resolves)
//   minPlace / maxPlace: gates on the stretched 8-racer place (like ITEM.capoMinPlace)
// Missing fields = no rule. The v4 items keep their ITEM.* keys (zap / star / capo / ...).
export const ITEM_RULES = {
  peperoncino:  { freeTime: 20, max: 2 },
  granita:      { freeTime: 20, max: 2 },
  flying_pizza: { freeTime: 20, max: 2 },
  rolling_pins: { freeTime: 15, max: 2 },
  piggy_bank:   { freeTime: 20, max: 2 },
  parm_wheel:   { freeTime: 20, max: 1 },
  surprise_egg: { freeTime: 15, max: 2 },
  padella:      { freeTime: 20, max: 1, cooldown: 20, cooldownFrom: 'end', minPlace: 3 },
  befana:       { freeTime: 30, max: 1, cooldown: 30, cooldownFrom: 'end', minPlace: 3 },
  calzone:      { freeTime: 20, max: 2 },
  ladro:        { freeTime: 20, max: 1 },
  hot_potato:   { freeTime: 30, max: 1, cooldown: 15, cooldownFrom: 'end', minPlace: 2, maxPlace: 6 },
  mortadella:   { freeTime: 20, max: 2 },
  antipasto:    { freeTime: 30, max: 1 },
};

// Lire (coins): track pickups (track.coins) + coin items (notes/research-v5-items.md §C5).
export const COIN = {
  max: 10, speedPerCoin: 0.005,           // max speed x (1 + speedPerCoin x coins): +5 % at 10
  pickupRadius: 1.3, pickupDy: 2.0, hover: 0.7, pickupNudge: 0.5, respawn: 12,
  lossHit: 2, lossLightHit: 1, lossFall: 3,   // lost on a normal hit / a light projectile / a fall or respawn
  dropRadius: 2.5, looseLife: 10, maxLoose: 60, regrabDelay: 1.0,
};

// v5 per-item tuning (150cc values; speeds x ccMult like the v4 projectiles).
// Data for the item plugins (notes/research-v5-items.md §C6 / §C8).
export const ITEM5 = {
  // Peperoncino Blaster
  pepperWindow: 8, pepperShots: 8, pepperGap: 0.22, pepperSpeed: 40, pepperBoost: 14, pepperBackSpeed: 18,
  pepperLife: 2.0, pepperBackLife: 2.5, pepperBounces: 4, pepperRadius: 0.45, pepperMaxLive: 12,
  // Granita Freeze
  granitaOrbitRadius: 2.0, granitaSpread: 10, granitaSpeed: 40, granitaBoost: 12, granitaLife: 1.6, granitaRadius: 0.5,
  // Flying Pizza
  pizzaOutSpeed: 36, pizzaOutBoost: 10, pizzaOutTime: 0.85, pizzaBackSpeed: 40, pizzaBackBoost: 14,
  pizzaBackTime: 2.0, pizzaCatch: 2.0, pizzaRadius: 0.8, pizzaHeight: 1.0,
  // Rolling Pins
  pinsWindow: 5, pinsGap: 0.2, pinsThrow: 18, pinsUp: 7, pinsSpread: 6, pinsBackThrow: 4,
  pinsStuck: 3.0, pinsRadius: 0.8, pinsFlightRadius: 1.0,
  // Piggy Bank
  piggySpeed: 44, piggyBoost: 12, piggyLife: 3.5, piggyRange: 150, piggyCoinEvery: 12, piggyTrailMax: 10,
  piggyRing: 8, piggyRingRadius: 2.5, piggyHitRadius: 1.4, piggyBackBounces: 3, piggyBackLife: 4,
  // Parmesan Wheel
  wheelSpeed: 38, wheelBoost: 8, wheelRadius: 1.6, wheelLife: 6, wheelBounces: 12, wheelRehit: 1.0,
  // Surprise Egg
  eggSpeed: 46, eggBoost: 12, eggRadius: 0.7, eggLife: 5, eggCapsules: 3, eggCapsuleRadius: 1.2,
  eggCapsuleLife: 12, eggSpill: 4,
  // Prank Box / Banana Split / Sour Lemon (dropped behind, banana rules)
  prankRadius: 1.7, prankLife: 40, prankMaxRoad: 4, prankHover: 1.1, prankTell: 25,
  splitBack: 3.0, splitRadius: 2.4, splitLife: 50, splitMaxRoad: 2, splitPeels: 3, splitScatter: 3.5,
  lemonRadius: 1.2, lemonLife: 40, lemonMaxRoad: 4,
  // Padella Slam
  padellaBeats: [0, 0.6, 1.2], padellaSlam: 1.8,
  // Taralli Hoops
  ringAt: [12, 28, 46], ringRadius: 1.9, ringHeight: 1.4, ringLife: 6, ringBoost: 1.0, ringLineBlend: 0.5,
  // Befana's Broom
  befanaSpeed: 70, befanaHeight: 6, befanaHexRadius: 7, befanaLife: 8, befanaPast: 40,
  coalDrops: 3, coalPerDrop: 6, coalAhead: 30, coalRadius: 0.6, coalLife: 10, coalGap: 3.5,
  // Chomping Calzone
  calzoneTime: 8, calzoneChomps: 7, calzoneMinGap: 0.6, calzoneIdle: 1.6, calzoneReach: 4.5, calzoneCone: 50,
  calzoneBoost: 0.45,
  // Ladro Mask
  ladroTime: 4.0, ladroStealDelay: 0.8, ladroCoins: 2,
  // Hot Potato
  potatoTime: 8, potatoSpeedMult: 1.10, potatoPassMin: 1.0, potatoNoReturn: 1.0, potatoShrink: 5.0,
  // Maxi Mortadella
  mortTime: 7.5, mortScale: 2.2, mortGrow: 0.4, mortShrinkBack: 0.5, mortSpeedMult: 1.12,
  // Tarantella Jump
  jumpVy: 12, jumpQueue: 0.3,
  // Grissino Swipe
  grissTime: 10, grissSwipe: 0.35, grissGap: 0.6, grissKartRadius: 3.2, grissItemRadius: 3.5,
  // Antipasto Platter (orbit order = nose order on pickup)
  platter: ['banana', 'bouncer', 'rocket', 'toot', 'star', 'espresso', 'meatball_bomb', 'lira_purse'],
  platterRadius: 2.4, platterSpeed: 3.4, platterTouchBoost: 0.8, platterInk: 1.5,
  // Amore Hearts
  amoreTime: 20, amoreHearts: 2, amoreRadius: 1.8, amoreSpeed: 4.0,
  // Lira Purse / Tip Jar
  purseCoins: 2,
  tipWindow: 6, tipTaps: 6, tipGap: 0.25, tipSpill: 2, tipFinalSpill: 6, tipBoost: 0.3, tipBoostMult: 1.1,
};

export const ITEM = {
  rouletteSeconds: 2.0,       // player roulette spin time
  aiRouletteSeconds: 1.2,
  boxRespawn: 2.5,            // seconds until a broken item box reappears
  boxRadius: 1.9,             // pickup distance (kart center to box center, horizontal)
  bouncerSpeed: 48, bouncerLife: 7, bouncerMaxBounces: 6,
  rocketSpeed: 52, rocketLife: 10, rocketHomingRange: 30,
  hazardRadius: 1.4,          // banana hit distance
  stinkRadius: 4.0, stinkLife: 12,
  projectileRadius: 1.0,
  shooterGrace: 0.5,          // seconds a projectile ignores its shooter
  // Classic kart-racer limits (same rules for humans and CPUs; a blocked item re-rolls the other columns).
  // Times are race seconds since GO; "in play" = held + rolling + live (flying / riding / running / on the road).
  zapFreeTime: 30,            // no Zap Cloud in the first 30 s of a race ...
  zapCooldown: 30,            // ... nor within 30 s of the last one, and at most one held at a time
  starMax: 2,                 // Rainbow Stars held, rolling or active at once
  capoFreeTime: 30, capoCooldown: 20, capoMax: 1, capoMinPlace: 3,   // cooldown runs from the slam / fizzle
  beerFreeTime: 30, beerMax: 2, beerMinPlace: 5,
  goldenFreeTime: 30, goldenMax: 2,
  espressoFreeTime: 15, espressoCooldown: 15, espressoMax: 1,         // cooldown runs from the use
  bombFreeTime: 20, bombMax: 3,
  accordionFreeTime: 20, tripleRocketFreeTime: 20,
  // far behind the leader (seconds at 29 m/s x ccMult): read the table up to 2 rows further back
  farBehindStart: 8, farBehindPerRow: 6, farBehindMaxRows: 2,
  // triples: orbiters (bouncers / rockets) circle the kart; bananas trail behind it
  orbitRadius: 2.0, orbitHeight: 0.6, orbitSpeed: 4.2, orbitHitRadius: 0.55,
  trailGaps: [2.0, 3.2, 4.4],
  // Capo Crusher: rides the road centre at max(capoSpeed x ccMult, leader speed + capoMinClosing),
  // tumbling karts in its path; locks on capoLockRange m behind 1st, circles above it, winds up
  // (the boost-dodge window), dives and slams (target tumbles HIT.capoTumble s, others in the blast spin)
  capoSpeed: 52, capoMinClosing: 14, capoHeight: 0.6, capoHitRadius: 1.6, capoLockRange: 35,
  capoHover: 4.5, capoOrbitRadius: 2.6, capoOrbitTime: 1.2, capoWindup: 0.3, capoDive: 0.2,
  capoBlastRadius: 7, capoLife: 30, capoMaxLaps: 1.5,
  // Golden Toot: presses refresh a toot boost for goldenTime s after the first one
  goldenTime: 7.5, goldenPressGap: 0.15,
  // Meatball Bomb: lobbed forward (brake held: dropped behind); explodes on contact / fuse
  bombThrowSpeed: 14, bombThrowUp: 7, bombRollDecel: 25, bombFuse: 3.0, bombDropFuse: 2.0,
  bombTriggerRadius: 2.6, bombCoreRadius: 4.5, bombBlastRadius: 8, bombOwnerGrace: 1.0, bombLife: 12,
  // Espresso Splash: everyone ahead gets coffee on their screen after espressoDelay s
  espressoDelay: 0.6, espressoTime: 4.5, espressoFade: 1.5, espressoSpeedMult: 0.97, espressoSteerMult: 0.85,
  // Accordion Blast: spins karts within accordionKartRadius, destroys items (Capo too) within accordionItemRadius
  accordionKartRadius: 8, accordionItemRadius: 12,
  // Beer Rocket: chug, then an invincible autopilot ride at beerSpeedMult x top speed
  beerChug: 0.7, beerSpeedMult: 1.75, beerMinTime: 2.5, beerMaxTime: 8, beerHardMax: 10,
  beerPlaces: 5, beerSteer: 2.5, beerKnockRadius: 2.6, beerExitBoost: 1.0, beerExitInvuln: 1.0,
};

// CPU difficulty, chosen by the engine class (parts.js ENGINE_CLASSES: 50cc easy,
// 100cc normal, 150cc hard). aiSpeedMult stays below 1 on every level: human
// karts always run at 1.0, so CPUs with a higher top speed would be unbeatable
// however well you drive. Hard comes from better lines, drifting and items
// (tools/sim.mjs --all checks that an AI-quality player still wins some Hard races).
export const DIFFICULTY = {
  easy:   { label: 'Easy',   aiSpeedMult: 0.88,  aiSkill: 0.45, rubberBand: 0.06, itemAggression: 0.4 },
  normal: { label: 'Normal', aiSpeedMult: 0.945, aiSkill: 0.7,  rubberBand: 0.08, itemAggression: 0.7 },
  hard:   { label: 'Hard',   aiSpeedMult: 0.975, aiSkill: 0.92, rubberBand: 0.08, itemAggression: 1.0 },
};

export const NET = {
  padInputHz: 60,             // phone -> desktop input rate while racing
  hostStateHz: 5,             // desktop -> phone heartbeat state rate
  httpPort: 3000,
  httpsPort: 3443,
};

export const PHYS = {
  maxSubstep: 1 / 120,        // physics substep upper bound (s)
  maxFrameDt: 0.05,           // clamp of a single frame's dt (s)
};
