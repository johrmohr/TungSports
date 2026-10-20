// Headless race simulation (SPEC §8, §14): the real tracks, karts, AI, items
// and race rules, no rendering. Runs as fast as possible at dt = 1/120.
// The field is 8 of the 12 racers, rotating through the roster by seed
// (consecutive seeds race every character). Every kart drives real parts
// (CPUs: cpuLoadout per set), and the engine class scales every kart, the
// item projectiles and sets the CPU difficulty (50cc easy, 100cc normal,
// 150cc hard).
//
//   node tools/sim.mjs [--track breezy|monte] [--cc 50|100|150] [--seed 3] [--laps 3]
//                      [--player N] [--difficulty d] [--items off] [--all] [--seeds 1-6] [--quiet]
//
//   --player N   use character N of the roster as "the player" (still
//                AI-driven, skill 0.6), with rubber banding like in the game
//   --difficulty override the CPU difficulty the engine class picks
//   --all        every track in TRACK_LIST x every engine class x every seed in
//                --seeds (default 1-6), one summary row per race + totals, then
//                the fairness check on every track
//   --fairness   only the fairness check (every track, or --track): like the
//                game, the player starts in RACE.playerGridSlot at speedMult 1,
//                driven by an AIDriver at skill 0.85 (the __game.autopilot
//                driver); every character in turn. 100cc (Normal) must be
//                clearly easier than 150cc (Hard), and Hard must stay winnable
//                (win rate inside FAIR.hardWins).
// Exit code 1 if any kart fails to finish within 300 s, any NaN appears, any
// kart is stuck (speed < 2 m/s while able to drive) for more than 5 s, the
// fairness check fails, or a v4 item rule is broken (SPEC §15.2): an item
// rolled before its start time (capo / beer / golden / zap 30 s, bomb /
// accordion / triple rocket 20 s, espresso 15 s) or in a gated place (capo
// from 3rd, beer from 5th), more than 1 Capo Crusher or 2 Beer Rockets in
// play, more than 2 stars, a beer ride past ITEM.beerHardMax or off the road;
// or a v5 rule (config ITEM_RULES, SPEC §16.2): a v5 item rolled before its
// freeTime / outside its place gate, more of one in play than its max, or an
// item plugin hook that threw (items.pluginErrors).
// Each race also prints the v4 item stats (capo launches / slams / dodges /
// fizzles, beer rides + places gained, bombs, espresso victims, accordion spins).
// Course hazards (Krishiv's Palace crushers / flame arms / geysers, hazards.js)
// run through hazards.js stepCourseHazards exactly like main.js stepHazards:
// the clock advances every step, after the kart collisions every kart is
// checked and the effect applied (applyHazardHit: 'crush' / tumble -> tumble,
// 'fire' / spin -> spin, knock, slow; stars and Beer Rockets pass), belts
// push, and the CPUs get them in ctx.hazards. --no-hazards turns
// them off (what-if); the hits show as 'crush' / 'fire' in the hit columns.

import { TRACK_LIST, getTrack } from '../public/js/tracks.js';
import { Kart, resolveKartCollisions } from '../public/js/kart.js';
import { CHARACTERS } from '../public/js/characters.js';
import { AIDriver, createAIDrivers, cpuLoadout, difficultyForCc } from '../public/js/ai.js';
import { ItemSystem } from '../public/js/items.js';
import { Race } from '../public/js/race.js';
import { createHazards, stepCourseHazards } from '../public/js/hazards.js';
import { bus } from '../public/js/bus.js';
import { makeRng } from '../public/js/utils.js';
import { ITEM, ITEM_IDS, ITEM_RULES, NATIVE_ITEM_IDS, RACE, GAME_TITLE, COIN } from '../public/js/config.js';
import { ENGINE_CLASSES, getEngineClass, DEFAULT_CC } from '../public/js/parts.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);

const DT = 1 / 120;
const MAX_TIME = 400;
const FINISH_LIMIT = 300;
const STUCK_LIMIT = 5;
const HAZARDS_ON = !flag('no-hazards');
// fairness check (an AI-quality player vs the CPU field, items on)
const FAIR = {
  seeds: 48,                // races per difficulty, cycling through the full roster
  skill: 0.85,              // player AIDriver skill (= __game.autopilot)
  hardWins: [0.10, 0.40],   // Hard (150cc) win-rate band: beatable, but not Normal
  normalOverHard: 0.2,      // Normal (100cc) win rate must beat Hard's by this much
};

const f1 = (x) => (x == null || !isFinite(x) ? '  -  ' : x.toFixed(1));
const f2 = (x) => (x == null || !isFinite(x) ? '   -   ' : x.toFixed(2));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

/**
 * CPU characters for one race: the next racers of the roster (minus the
 * player's pick), rotating by seed so that every character gets to race.
 */
export function raceField(seed, playerDef = null) {
  const pool = CHARACTERS.filter((c) => c !== playerDef);
  const need = Math.max(0, RACE.racers - (playerDef ? 1 : 0));
  const start = ((((seed - 1) * need) % pool.length) + pool.length) % pool.length;
  return Array.from({ length: need }, (_, i) => pool[(start + i) % pool.length]);
}

/** Run one race; returns a result record (does not print). */
export function simulate({
  seed = 1, laps = 3, trackId = 'breezy', cc = DEFAULT_CC, difficulty = null, items: itemsOn = true,
  playerIndex = -1, playerSkill = 0.6, playerSlot = -1, playerPersonality = {},
} = {}) {
  const track = getTrack(trackId);
  const ccMult = getEngineClass(cc).mult;
  difficulty = difficulty || difficultyForCc(cc);
  const rng = makeRng(seed);
  const playerDef = playerIndex >= 0 ? CHARACTERS[playerIndex] : null;
  if (playerIndex >= 0 && !playerDef) throw new RangeError(`Unknown player roster index: ${playerIndex}`);
  // 8 racers like main.js; a seeded shuffle sets the grid order.
  const field = shuffle(raceField(seed, playerDef), rng);
  if (playerDef) {
    const slot = playerSlot >= 0
      ? Math.min(playerSlot, RACE.racers - 1)
      : Math.floor(rng() * RACE.racers);
    field.splice(slot, 0, playerDef);
  }
  // CPUs drive their per-set preset kart; the "player" a Classic + Standard kart
  const karts = field.map((c) => new Kart({
    id: c.id, character: c, track, isPlayer: c === playerDef, ccMult,
    loadout: c === playerDef ? null : cpuLoadout(c, seed),
  }));
  const player = playerDef ? karts.find((k) => k.character === playerDef) : null;
  const humans = player ? [player] : [];
  karts.forEach((k, slot) => k.placeOnGrid(track.gridSlot(slot)));

  const drivers = createAIDrivers(karts, { track, difficulty, rng: makeRng(seed * 31 + 7), humans });
  if (player) drivers.push(new AIDriver(player, { track, difficulty, skill: playerSkill, rng: makeRng(seed * 17 + 3), personality: playerPersonality }));
  const driverOf = new Map(drivers.map((d) => [d.kart, d]));
  const items = new ItemSystem({ track, karts, scene: null, rng: makeRng(seed * 101 + 13), ccMult, enabled: itemsOn });
  const race = new Race({ track, karts, laps, players: humans });
  // course hazards (SPEC §15.3), as main.js stepHazards
  const hazards = HAZARDS_ON ? createHazards(track) : null;
  const hz = hazards && hazards.list.length ? hazards : null;
  const ctx = { karts, items, race, humans, hazards: hz };

  // ---- stats via the event bus
  const S = new Map(karts.map((k) => [k, {
    items: 0, used: {}, hitsBy: {}, hits: 0, walls: 0, drifts: 0, mt: [0, 0, 0, 0], boxes: 0,
    stuck: 0, maxStuck: 0, respawns: 0, bumps: 0, startBoost: false, stall: false,
  }]));
  const usedTotal = Object.fromEntries(ITEM_IDS.map((id) => [id, 0]));
  const hitTotal = {};
  let leadChanges = 0, overtakes = 0, blocked = 0, explode = 0, zaps = 0, tricks = 0, zapEarly = 0, starPeak = 0;
  // v4 item rules (SPEC §15.2) + stats
  const ruleFails = [];
  const v4 = { capoLaunch: 0, capoHit: 0, capoDodged: 0, capoFizzle: 0, beerRides: 0, beerGained: [], beerTime: [], bombs: 0, espressoVictims: 0, accordionHits: 0, peakCapo: 0, peakBeer: 0 };
  const beerT0 = new Map();
  const RULES = {
    capo: { free: ITEM.capoFreeTime, minPlace: ITEM.capoMinPlace }, beer_rocket: { free: ITEM.beerFreeTime, minPlace: ITEM.beerMinPlace },
    golden_toot: { free: ITEM.goldenFreeTime }, espresso: { free: ITEM.espressoFreeTime }, meatball_bomb: { free: ITEM.bombFreeTime },
    accordion: { free: ITEM.accordionFreeTime }, triple_rocket: { free: ITEM.tripleRocketFreeTime }, zap: { free: ITEM.zapFreeTime },
  };
  // v5 (SPEC §16.2): every ITEM_RULES entry (free time, place gates; caps checked below)
  for (const [id, r] of Object.entries(ITEM_RULES)) RULES[id] = { free: r.freeTime || 0, minPlace: r.minPlace || 0, maxPlace: r.maxPlace || 0 };
  const v5Peak = {};
  const platterStar = new Set();          // karts whose running star came off an Antipasto Platter
  const offs = [
    bus.on('item:use', (e) => { if (e.first === false) return; const s = S.get(e.kart); s.items++; s.used[e.item] = (s.used[e.item] || 0) + 1; usedTotal[e.item]++; }),
    bus.on('item:rollStart', (e) => {
      const id = e.kart.rollItem, rule = RULES[id];
      if (!rule) return;
      const place = race.getPlace(e.kart);
      if (race.time < rule.free) ruleFails.push(`${id} rolled at ${race.time.toFixed(1)} s (< ${rule.free} s)`);
      if (rule.minPlace && place < rule.minPlace) ruleFails.push(`${id} rolled in place ${place}`);
      if (rule.maxPlace && place > rule.maxPlace && race.standings.length >= RACE.racers) ruleFails.push(`${id} rolled in place ${place}`);
    }),
    bus.on('item:platterUse', (e) => { if (e.item === 'star') platterStar.add(e.kart); }),
    bus.on('kart:starEnd', (e) => { platterStar.delete(e.kart); }),
    bus.on('item:capoLaunch', () => { v4.capoLaunch++; }),
    bus.on('item:capoHit', (e) => { if (e.hit) v4.capoHit++; if (e.dodged) v4.capoDodged++; }),
    bus.on('item:capoFizzle', () => { v4.capoFizzle++; }),
    bus.on('item:beerRide', (e) => { v4.beerRides++; beerT0.set(e.kart, race.time); }),
    bus.on('item:beerEnd', (e) => { v4.beerGained.push(e.gained || 0); if (beerT0.has(e.kart)) v4.beerTime.push(race.time - beerT0.get(e.kart)); }),
    bus.on('item:bombExplode', () => { v4.bombs++; }),
    bus.on('item:espresso', (e) => { v4.espressoVictims += (e.victims || []).length; }),
    bus.on('item:accordion', (e) => { v4.accordionHits += e.hits || 0; }),
    bus.on('kart:spin', (e) => { const s = S.get(e.kart); s.hits++; s.hitsBy[e.cause] = (s.hitsBy[e.cause] || 0) + 1; hitTotal[e.cause] = (hitTotal[e.cause] || 0) + 1; }),
    bus.on('kart:tumble', (e) => { const s = S.get(e.kart); s.hits++; s.hitsBy[e.cause] = (s.hitsBy[e.cause] || 0) + 1; hitTotal[e.cause] = (hitTotal[e.cause] || 0) + 1; }),
    bus.on('kart:wallHit', (e) => { S.get(e.kart).walls++; }),
    bus.on('kart:driftStart', (e) => { S.get(e.kart).drifts++; }),
    bus.on('kart:driftEnd', (e) => { if (e.tier > 0) S.get(e.kart).mt[e.tier]++; }),
    bus.on('kart:respawn', (e) => { S.get(e.kart).respawns++; }),
    bus.on('kart:bump', (e) => { S.get(e.a).bumps++; }),
    bus.on('item:boxHit', (e) => { S.get(e.kart).boxes++; }),
    bus.on('item:blocked', () => { blocked++; }),
    bus.on('item:explode', (e) => { if (e.hit) explode++; }),
    bus.on('item:zap', () => { zaps++; if (race.time < 30) zapEarly++; }),
    bus.on('kart:trick', () => { tricks++; }),
    bus.on('race:startBoost', (e) => { S.get(e.kart).startBoost = true; }),
    bus.on('race:stall', (e) => { S.get(e.kart).stall = true; }),
  ];

  race.skipIntro();
  let t = 0, nan = false, nanWhat = '';
  let prevLeader = null;
  const prevPlace = new Map();
  const t0 = performance.now();
  // run until every kart is home (with a player, race:over fires resultsDelay
  // after the player finishes; the others keep racing for the table)
  const allHome = () => karts.every((k) => k.finished);
  while (t < MAX_TIME && !(race.over && allHome())) {
    for (const d of drivers) d.update(DT, ctx);
    items.update(DT, race);
    for (const k of karts) k.update(DT);
    resolveKartCollisions(karts);
    if (hz) stepCourseHazards(hz, karts, DT, race.state === 'racing' || race.state === 'finished');
    race.update(DT);
    t += DT;
    for (const k of karts) {
      const p = k.position, v = k.velocity;
      if (!(isFinite(p.x) && isFinite(p.y) && isFinite(p.z) && isFinite(v.x) && isFinite(v.y) && isFinite(v.z) && isFinite(k.yaw) && isFinite(k.distance))) {
        nan = true; nanWhat = `${k.id} @${t.toFixed(2)}s`;
      }
      const s = S.get(k);
      const able = race.state === 'racing' && !k.frozen && !k.finished && !k.isDisabled();
      if (able && Math.hypot(v.x, v.z) < 2) { s.stuck += DT; if (s.stuck > s.maxStuck) s.maxStuck = s.stuck; }
      else s.stuck = 0;
      if (race.state === 'racing' && !k.finished) {
        const pp = prevPlace.get(k);
        if (pp !== undefined && k.place < pp) overtakes += pp - k.place;
        prevPlace.set(k, k.place);
      }
    }
    let stars = 0, capos = items.capos.length, beers = 0;
    for (const k of karts) {
      // (a star served by an Antipasto Platter is a bonus: research-v5-items §C4, not counted toward starMax)
      if (k.item === 'star' || (k.rolling && k.rollItem === 'star') || (k.starTimer > 0 && !k.beer && !platterStar.has(k))) stars++;
      if (k.item === 'capo' || (k.rolling && k.rollItem === 'capo')) capos++;
      if (k.item === 'beer_rocket' || (k.rolling && k.rollItem === 'beer_rocket') || k.beer) beers++;
      if (k.beer && k.proj && Math.abs(k.proj.lateral) > Math.min(k.proj.wallL, k.proj.wallR) - 0.9) ruleFails.push(`${k.id} beer rocket off the road (lateral ${k.proj.lateral.toFixed(2)})`);
      if (k.coins !== undefined && !(k.coins >= 0 && k.coins <= COIN.max)) ruleFails.push(`${k.id} has ${k.coins} lire (0..${COIN.max})`);   // v5 lire
    }
    if (stars > starPeak) starPeak = stars;
    // v5 caps (ITEM_RULES max): items of each kind in play, as the roulette counts them
    for (const id in ITEM_RULES) {
      if (!ITEM_RULES[id].max) continue;
      const n = items._countOf(id);
      if (n > (v5Peak[id] || 0)) v5Peak[id] = n;
    }
    if (capos > v4.peakCapo) v4.peakCapo = capos;
    if (beers > v4.peakBeer) v4.peakBeer = beers;
    for (const c of items.capos) if (!(isFinite(c.position.x) && isFinite(c.position.y) && isFinite(c.position.z))) { nan = true; nanWhat = `capo @${t.toFixed(2)}s`; }
    if (race.state === 'racing') {
      const leader = race.standings[0];
      if (prevLeader && leader !== prevLeader && !prevLeader.finished && race.time > 3) leadChanges++;
      prevLeader = leader;
    }
    if (nan) break;
  }
  const wall = performance.now() - t0;
  for (const off of offs) off();

  const results = race.getResults(true);
  const rows = results.map((r) => {
    const k = r.kart, s = S.get(k), d = driverOf.get(k);
    return {
      place: r.place, id: k.id, name: k.character.name, isPlayer: k === player, finished: r.finished,
      time: r.time, lapTimes: k.lapTimes.slice(), bestLap: r.bestLap, skill: d ? d.skill : null,
      ...s, maxStuck: Math.max(s.maxStuck, d ? d.maxStuck : 0), respawns: s.respawns, coins: k.coins | 0,
    };
  });
  const finished = rows.filter((r) => r.finished);
  const allLaps = finished.flatMap((r) => r.lapTimes);
  const flying = finished.flatMap((r) => r.lapTimes.slice(1));
  const avgLap = allLaps.length ? allLaps.reduce((a, b) => a + b, 0) / allLaps.length : NaN;
  const avgFlying = flying.length ? flying.reduce((a, b) => a + b, 0) / flying.length : NaN;
  const spread = finished.length > 1 ? finished[finished.length - 1].time - finished[0].time : NaN;
  const totalWalls = rows.reduce((a, r) => a + r.walls, 0);
  const totalDrifts = rows.reduce((a, r) => a + r.drifts, 0);
  const totalMT = rows.reduce((a, r) => a + r.mt[1] + r.mt[2] + r.mt[3], 0);
  const maxStuck = Math.max(...rows.map((r) => r.maxStuck));
  const failures = [];
  if (nan) failures.push(`NaN (${nanWhat})`);
  if (zapEarly) failures.push(`${zapEarly} zap(s) in the first 30 s`);
  if (starPeak > 2) failures.push(`${starPeak} stars at once`);
  if (v4.peakCapo > ITEM.capoMax) failures.push(`${v4.peakCapo} capos in play at once`);
  if (v4.peakBeer > ITEM.beerMax) failures.push(`${v4.peakBeer} beer rockets at once`);
  for (const [id, n] of Object.entries(v5Peak)) if (n > ITEM_RULES[id].max) failures.push(`${n} ${id} in play at once (max ${ITEM_RULES[id].max})`);
  if (items.pluginErrors > 0) failures.push(`${items.pluginErrors} item plugin hook error(s)`);
  for (const f of [...new Set(ruleFails)].slice(0, 4)) failures.push(f);
  for (const bt of v4.beerTime) if (bt > ITEM.beerHardMax + 0.05) { failures.push(`beer ride ${bt.toFixed(2)} s > ${ITEM.beerHardMax} s`); break; }
  if (!itemsOn && Object.values(usedTotal).some((n) => n > 0)) failures.push('items used with items off');
  for (const r of rows) {
    if (!r.finished || r.time > FINISH_LIMIT) failures.push(`${r.id} did not finish within ${FINISH_LIMIT}s`);
    if (r.maxStuck > STUCK_LIMIT) failures.push(`${r.id} stuck ${r.maxStuck.toFixed(2)}s`);
  }
  items.dispose();
  race.dispose();
  return {
    seed, laps, trackId, cc, difficulty, rows, avgLap, avgFlying, spread, usedTotal, hitTotal, leadChanges, overtakes,
    blocked, explode, zaps, tricks, totalWalls, wallsPerLap: totalWalls / (karts.length * laps), totalDrifts, totalMT, v4,
    maxStuck, simTime: t, wallMs: wall, failures, ok: failures.length === 0,
  };
}

// Item ids to print: the 17 native ones always, a v5 plugin id once it was used.
const NATIVE = new Set(NATIVE_ITEM_IDS);
const usedIds = (used) => ITEM_IDS.filter((id) => NATIVE.has(id) || used[id] > 0);

function hitsStr(h) {
  const keys = ['banana', 'stink', 'bouncer', 'rocket', 'zap', 'star', 'capo', 'bomb', 'accordion', 'beer', 'crush', 'fire'];
  const abbr = { banana: 'ba', stink: 'st', bouncer: 'bo', rocket: 'ro', zap: 'za', star: 'sr', capo: 'ca', bomb: 'mb', accordion: 'ac', beer: 'be', crush: 'cr', fire: 'fi' };
  const parts = keys.filter((k) => h[k]).map((k) => `${abbr[k]}${h[k]}`);
  return parts.join(' ') || '-';
}

function v4Str(v) {
  const med = (xs) => { if (!xs.length) return NaN; const a = xs.slice().sort((x, y) => x - y); return a[(a.length - 1) >> 1]; };
  return `capo ${v.capoLaunch} launched / ${v.capoHit} slams / ${v.capoDodged} dodged / ${v.capoFizzle} fizzled | beer rides ${v.beerRides} (places gained ${v.beerGained.join(',') || '-'}, median ride ${f2(med(v.beerTime))} s) | bombs ${v.bombs} | espresso victims ${v.espressoVictims} | accordion spins ${v.accordionHits} | peak capo ${v.peakCapo} beer ${v.peakBeer}`;
}

function printRace(R) {
  console.log(`\n=== ${GAME_TITLE} sim: ${R.trackId} ${R.cc}cc (${R.difficulty}), seed ${R.seed}, ${R.laps} laps — ${R.simTime.toFixed(1)} s simulated in ${(R.wallMs / 1000).toFixed(2)} s ===`);
  const lapHdr = Array.from({ length: R.laps }, (_, i) => lpad(`Lap${i + 1}`, 6)).join(' ');
  console.log(`${pad('Pos', 4)}${pad('Kart', 12)}${lpad('Skill', 5)} ${lpad('Time', 8)} ${lapHdr} ${lpad('Best', 6)}  ${pad('Start', 5)} ${lpad('Box', 3)} ${lpad('Itm', 3)} ${pad('Hits', 24)} ${lpad('Dr', 3)} ${pad('MT 1/2/3', 9)} ${lpad('Wall', 4)} ${lpad('Bump', 4)} ${lpad('Stuck', 5)} ${lpad('Resp', 4)}`);
  for (const r of R.rows) {
    const laps = Array.from({ length: R.laps }, (_, i) => lpad(f2(r.lapTimes[i]), 6)).join(' ');
    const name = r.isPlayer ? `${r.id}*` : r.id;
    const time = r.finished ? f2(r.time) : `~${f1(r.time)}`;
    console.log(`${pad(r.place, 4)}${pad(name, 12)}${lpad(r.skill == null ? '-' : r.skill.toFixed(2), 5)} ${lpad(time, 8)} ${laps} ${lpad(f2(r.bestLap), 6)}  ${pad(r.startBoost ? 'BOOST' : r.stall ? 'STALL' : '-', 5)} ${lpad(r.boxes, 3)} ${lpad(r.items, 3)} ${pad(hitsStr(r.hitsBy), 24)} ${lpad(r.drifts, 3)} ${pad(`${r.mt[1]}/${r.mt[2]}/${r.mt[3]}`, 9)} ${lpad(r.walls, 4)} ${lpad(r.bumps, 4)} ${lpad(r.maxStuck.toFixed(2), 5)} ${lpad(r.respawns, 4)}`);
  }
  console.log(`avg lap ${f2(R.avgLap)} s (flying ${f2(R.avgFlying)} s) | spread winner->last ${f2(R.spread)} s | lead changes ${R.leadChanges} | overtakes ${R.overtakes}`);
  console.log(`items used: ${usedIds(R.usedTotal).map((id) => `${id} ${R.usedTotal[id]}`).join(', ')} | blocked ${R.blocked} | rocket hits ${R.explode} | zaps ${R.zaps}`);
  console.log(`hits by cause: ${Object.entries(R.hitTotal).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  console.log(`v4 items: ${v4Str(R.v4)}`);
  console.log(`drifts ${R.totalDrifts}, mini-turbos ${R.totalMT}, tricks ${R.tricks} | wall hits ${R.totalWalls} (${R.wallsPerLap.toFixed(2)} per kart-lap) | max stuck ${R.maxStuck.toFixed(2)} s`);
  console.log(R.ok ? 'RESULT: PASS' : `RESULT: FAIL — ${R.failures.join('; ')}`);
}

/**
 * Player-vs-CPU fairness on one track: `n` races at 100cc (Normal) and 150cc
 * (Hard), the player (every character in turn) driven by an AIDriver at
 * FAIR.skill from the back of the grid.
 * Returns { ok, lines, stats: { [difficulty]: { wins, n, meanPlace } } }.
 */
export function fairness({ trackId = 'breezy', classes = [100, 150], n = FAIR.seeds, laps = 3 } = {}) {
  const stats = {};
  const lines = [];
  let ok = true;
  for (const cc of classes) {
    const difficulty = difficultyForCc(cc);
    const st = stats[difficulty] = { wins: 0, n: 0, places: 0, meanPlace: 0, hist: new Array(RACE.racers + 1).fill(0), failures: 0 };
    for (let seed = 1; seed <= n; seed++) {
      const R = simulate({
        seed: 1000 + seed, laps, trackId, cc, playerIndex: (seed - 1) % CHARACTERS.length,
        playerSkill: FAIR.skill, playerSlot: RACE.playerGridSlot, playerPersonality: { aggression: 0.5 },
      });
      if (!R.ok) { st.failures++; ok = false; lines.push(`  ${difficulty} seed ${1000 + seed}: FAIL ${R.failures.join('; ')}`); }
      const me = R.rows.find((r) => r.isPlayer);
      st.n++; st.places += me.place; st.hist[me.place]++;
      if (me.place === 1) st.wins++;
    }
    st.meanPlace = st.places / st.n;
    lines.push(`  ${pad(trackId, 7)}${pad(`${cc}cc`, 6)} ${pad(difficulty, 7)} player wins ${st.wins}/${st.n} (${((100 * st.wins) / st.n).toFixed(0)}%) | mean place ${st.meanPlace.toFixed(2)} | places ${st.hist.slice(1).map((c, i) => `${i + 1}:${c}`).join(' ')}`);
  }
  const rate = (d) => (stats[d] ? stats[d].wins / stats[d].n : NaN);
  if (stats.hard) {
    const r = rate('hard'), [lo, hi] = FAIR.hardWins;
    if (!(r >= lo && r <= hi)) { ok = false; lines.push(`  FAIL: ${trackId} Hard win rate ${(100 * r).toFixed(0)}% outside ${100 * lo}-${100 * hi}% (CPUs too fast / too slow for an AI-quality player)`); }
  }
  if (stats.hard && stats.normal && !(rate('normal') >= rate('hard') + FAIR.normalOverHard)) {
    ok = false;
    lines.push(`  FAIL: ${trackId} Normal win rate ${(100 * rate('normal')).toFixed(0)}% not clearly above Hard's ${(100 * rate('hard')).toFixed(0)}%`);
  }
  return { ok, lines, stats };
}

function printFairness(F) {
  console.log(`
fairness (player = AIDriver skill ${FAIR.skill} from grid slot ${RACE.playerGridSlot}, speedMult 1, items on):`);
  for (const l of F.lines) console.log(l);
  console.log(F.ok ? 'FAIRNESS: PASS' : 'FAIRNESS: FAIL');
}

function parseSeeds(spec) {
  const m = /^(\d+)-(\d+)$/.exec(spec);
  if (m) { const a = +m[1], b = +m[2]; return Array.from({ length: b - a + 1 }, (_, i) => a + i); }
  return spec.split(',').map(Number).filter((x) => x > 0);
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sim.mjs');
if (isMain) {
  const laps = Number(opt('laps', 3));
  const playerIndex = args.includes('--player') ? Number(opt('player', 0)) : -1;
  const trackOpt = opt('track', null);
  const ccOpt = opt('cc', null);
  const difficulty = opt('difficulty', null);
  const itemsOn = opt('items', 'on') !== 'off';
  const trackIds = trackOpt ? [trackOpt] : TRACK_LIST.map((t) => t.id);
  if (flag('all')) {
    const seeds = parseSeeds(opt('seeds', '1-6'));
    const classes = ccOpt ? [Number(ccOpt)] : ENGINE_CLASSES.map((e) => e.id);
    let failed = 0;
    const agg = {};
    console.log(`${pad('track', 7)}${pad('cc', 5)}${pad('diff', 7)}${lpad('seed', 4)} ${lpad('avgLap', 7)} ${lpad('flying', 7)} ${lpad('spread', 7)} ${lpad('lead', 4)} ${lpad('ovtk', 4)} ${lpad('items', 5)} ${lpad('hits', 4)} ${lpad('MT', 4)} ${lpad('trk', 3)} ${lpad('wall/l', 6)} ${lpad('stuck', 5)} ${lpad('resp', 4)}  result`);
    for (const trackId of trackIds) {
      for (const cc of classes) {
        const key = `${trackId} ${cc}cc`;
        const a = agg[key] = { lap: [], spread: [], used: Object.fromEntries(ITEM_IDS.map((id) => [id, 0])), hits: {}, mt: 0, drifts: 0, tricks: 0, walls: [], stuck: 0, lead: 0, ovt: 0, n: 0, coins: [],
          v4: { capoLaunch: 0, capoHit: 0, capoDodged: 0, capoFizzle: 0, beerRides: 0, beerGained: [], beerTime: [], bombs: 0, espressoVictims: 0, accordionHits: 0, peakCapo: 0, peakBeer: 0 } };
        for (const seed of seeds) {
          const R = simulate({ seed, laps, trackId, cc, difficulty, items: itemsOn, playerIndex });
          if (!R.ok) failed++;
          if (flag('verbose')) printRace(R);
          const itemsUsed = Object.values(R.usedTotal).reduce((x, y) => x + y, 0);
          const hits = Object.values(R.hitTotal).reduce((x, y) => x + y, 0);
          const resp = R.rows.reduce((x, r) => x + r.respawns, 0);
          console.log(`${pad(trackId, 7)}${pad(cc, 5)}${pad(R.difficulty, 7)}${lpad(seed, 4)} ${lpad(f2(R.avgLap), 7)} ${lpad(f2(R.avgFlying), 7)} ${lpad(f2(R.spread), 7)} ${lpad(R.leadChanges, 4)} ${lpad(R.overtakes, 4)} ${lpad(itemsUsed, 5)} ${lpad(hits, 4)} ${lpad(R.totalMT, 4)} ${lpad(R.tricks, 3)} ${lpad(R.wallsPerLap.toFixed(2), 6)} ${lpad(R.maxStuck.toFixed(2), 5)} ${lpad(resp, 4)}  ${R.ok ? 'PASS' : 'FAIL ' + R.failures.join('; ')}`);
          a.lap.push(R.avgLap); a.spread.push(R.spread); a.mt += R.totalMT; a.drifts += R.totalDrifts; a.tricks += R.tricks; a.walls.push(R.wallsPerLap);
          a.stuck = Math.max(a.stuck, R.maxStuck); a.lead += R.leadChanges; a.ovt += R.overtakes; a.n++;
          for (const id of ITEM_IDS) a.used[id] += R.usedTotal[id];
          for (const [kk, vv] of Object.entries(R.v4)) {
            if (Array.isArray(vv)) a.v4[kk].push(...vv);
            else if (kk.startsWith('peak')) a.v4[kk] = Math.max(a.v4[kk], vv);
            else a.v4[kk] += vv;
          }
          for (const [c, v] of Object.entries(R.hitTotal)) a.hits[c] = (a.hits[c] || 0) + v;
          for (const r of R.rows) a.coins[r.place - 1] = (a.coins[r.place - 1] || 0) + r.coins;
        }
      }
    }
    const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
    console.log('\nper track and engine class (means over seeds):');
    for (const [key, a] of Object.entries(agg)) {
      console.log(`  ${pad(key, 13)} lap ${f2(mean(a.lap))} s | spread ${f2(mean(a.spread))} s (min ${f2(Math.min(...a.spread))}, max ${f2(Math.max(...a.spread))}) | lead changes ${(a.lead / a.n).toFixed(1)} | overtakes ${(a.ovt / a.n).toFixed(1)} | drifts ${(a.drifts / a.n).toFixed(1)}, MTs ${(a.mt / a.n).toFixed(1)}, tricks ${(a.tricks / a.n).toFixed(1)} | wall hits/kart-lap ${mean(a.walls).toFixed(2)} | max stuck ${a.stuck.toFixed(2)} s`);
      console.log(`                items/race: ${usedIds(a.used).map((id) => `${id} ${(a.used[id] / a.n).toFixed(1)}`).join(', ')}`);
      console.log(`                hits/race:  ${Object.entries(a.hits).map(([c, v]) => `${c} ${(v / a.n).toFixed(1)}`).join(', ')}`);
      console.log(`                v4 totals over ${a.n} races: ${v4Str(a.v4)}`);
      console.log(`                lire at the finish by place: ${a.coins.map((c, i) => `${i + 1}: ${(c / a.n).toFixed(1)}`).join('  ')}`);
    }
    if (!flag('no-fairness')) {
      for (const trackId of trackIds) {
        const F = fairness({ trackId, laps, n: Number(opt('seeds-per', FAIR.seeds)) });
        printFairness(F);
        if (!F.ok) failed++;
      }
    }
    console.log(failed ? `\nOVERALL: FAIL (${failed} race(s) / check(s))` : '\nOVERALL: PASS');
    process.exit(failed ? 1 : 0);
  } else if (flag('fairness')) {
    let ok = true;
    for (const trackId of trackIds) {
      const F = fairness({ trackId, laps, n: Number(opt('seeds-per', FAIR.seeds)) });
      printFairness(F);
      ok = ok && F.ok;
    }
    process.exit(ok ? 0 : 1);
  } else {
    const R = simulate({ seed: Number(opt('seed', 1)), laps, trackId: trackIds[0], cc: Number(ccOpt || DEFAULT_CC), difficulty, items: itemsOn, playerIndex });
    if (!flag('quiet')) printRace(R);
    process.exit(R.ok ? 0 : 1);
  }
}
