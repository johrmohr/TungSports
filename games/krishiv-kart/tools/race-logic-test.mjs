// RACE LOGIC rule tests (node): race.js state machine / laps / places /
// start judge / wrong way / results, the multi-human finish rules (SPEC
// §14.5), items.js rules for every item (+ v3 Zap / Star limits, Items Off,
// engine class; v4 §15.2: distribution by place, start times / caps /
// cooldowns / far-behind shift, triples, Capo Crusher, Golden Toot, Meatball
// Bomb, Espresso Splash, Accordion Blast, Beer Rocket), AI personalities,
// CPU presets, pace, tricks and CPU item usage; v5 §16 extension points: the
// 40-item table (read through ITEM_ENABLED), ITEM_RULES, the item plugin
// registry / PluginContext / entities / aiUse, the hazards registry + effect
// mapping, track path mode / f keys / coins. Roster-agnostic: only needs >= 8
// racers in characters.js (the user's roster).
//   node tools/race-logic-test.mjs
import { getTrack } from '../public/js/tracks.js';
import { Kart, resolveKartCollisions } from '../public/js/kart.js';
import { CHARACTERS } from '../public/js/characters.js';
import { Race } from '../public/js/race.js';
import { ItemSystem, ITEM_TUNE } from '../public/js/items.js';
import { AIDriver, AI_PERSONALITIES, AI_TUNE, cpuLoadout, createAIDrivers, difficultyForCc } from '../public/js/ai.js';
import { CPU_PRESETS, pointsFor } from '../public/js/parts.js';
import { damp, clamp } from '../public/js/utils.js';
import { bus } from '../public/js/bus.js';
import { createHazards } from '../public/js/hazards.js';
import { makeRng } from '../public/js/utils.js';
import { RACE, ITEM, ITEM_IDS, ITEM_INFO, ITEM_TABLE, ITEM_RULES, ITEM_ENABLED, NATIVE_ITEM_IDS, itemEnabled, COIN, ITEM5, BOOST, HIT, DIFFICULTY, DRIFT } from '../public/js/config.js';
import { registerItem, getItemHandler, itemHandlers, isNativeItem, itemSystems } from '../public/js/items/registry.js';
import { createHazards as createHazardsRegistry, stepCourseHazards, applyHazardHit, hazardEffect, makeHazardSet, HAZARD_THEMES } from '../public/js/hazards.js';
import { Track } from '../public/js/track.js';

let fails = 0, passes = 0;
const ok = (c, msg) => { if (c) passes++; else { fails++; console.log('  FAIL:', msg); } };
const section = (t) => console.log(`\n== ${t}`);
const track = getTrack('breezy');
const L = track.length;
const DT = 1 / 120;

const events = [];
bus.on('*', (data, type) => { if (type.startsWith('race:') || type.startsWith('item:')) events.push({ type, data }); });
const count = (type, pred = () => true) => events.filter((e) => e.type === type && pred(e.data)).length;

function makeKarts(n = 8) {
  const ks = CHARACTERS.slice(0, n).map((c) => new Kart({ id: c.id, character: c, track }));
  ks.forEach((k, i) => k.placeOnGrid(track.gridSlot(i)));
  return ks;
}
// Put a kart at (s, lateral) facing along the track (or backwards), moving at `speed`.
function placeAt(k, s, lat = 0, { back = false, speed = 0 } = {}) {
  track.pointAt(s, lat, k.position);
  const f = track.frameAt(s);
  k.yaw = back ? f.yaw + Math.PI : f.yaw;
  k.velocity.set(Math.sin(k.yaw) * speed, 0, Math.cos(k.yaw) * speed);
  k.hint = -1;
  track.project(k.position, -1, k.proj);
  k.hint = k.proj.index;
}
function step(race, n = 1) { for (let i = 0; i < n; i++) race.update(DT); }

// --------------------------------------------------------------- race
section('race: intro -> countdown -> GO');
{
  events.length = 0;
  const ks = makeKarts();
  const race = new Race({ track, karts: ks, laps: 3, player: ks[7] });
  ok(race.state === 'intro' && ks.every((k) => k.frozen), 'starts in intro with karts frozen');
  ok(ks[0].distance < 0 && ks[0].distance > -12, `pole distance negative (${ks[0].distance.toFixed(2)})`);
  ok(ks.map((k) => k.place).join() === '1,2,3,4,5,6,7,8', `grid places ${ks.map((k) => k.place)}`);
  step(race, 600);
  ok(race.state === 'intro', 'intro does not run until startIntro()');
  race.startIntro();
  ok(count('race:intro') === 1, 'race:intro emitted');
  step(race, Math.round(RACE.introSeconds * 120) + 1);
  ok(race.state === 'countdown', `countdown after intro (${race.state})`);
  // start judge inputs: k0 holds inside the window, k1 holds from the start (stall),
  // k2 presses at 1.0 s before GO (nothing), k3 presses 0.15 s before GO (nothing),
  // k4 presses early, releases, re-presses in the window (boost)
  const pressAt = (k, from, to = 99) => ({ k, from, to });
  const plan = [pressAt(ks[0], 0.6), pressAt(ks[1], 9), pressAt(ks[2], 1.0), pressAt(ks[3], 0.15)];
  let guard = 0;
  while (race.state === 'countdown' && guard++ < 1000) {
    const cd = race.countdown;
    for (const p of plan) p.k.input.throttle = cd <= p.from ? 1 : 0;
    ks[4].input.throttle = (cd <= 2.5 && cd > 1.9) || cd <= 0.5 ? 1 : 0;
    step(race);
  }
  const beats = events.filter((e) => e.type === 'race:countdown').map((e) => e.data.n).join();
  ok(beats === '3,2,1', `countdown beats ${beats}`);
  ok(race.state === 'racing' && count('race:go') === 1, 'GO -> racing');
  ok(ks.every((k) => !k.frozen), 'karts unfrozen at GO');
  ok(ks[0].boostTimer > 0 && count('race:startBoost', (d) => d.kart === ks[0]) === 1, 'start boost for a press inside the window');
  ok(ks[1].stallTimer > 0 && count('race:stall', (d) => d.kart === ks[1]) === 1, 'stall for holding since the countdown start');
  ok(ks[2].boostTimer === 0 && ks[2].stallTimer === 0, 'press 1.0 s before GO: nothing');
  ok(ks[3].boostTimer === 0 && ks[3].stallTimer === 0, 'press 0.15 s before GO: nothing');
  ok(ks[4].boostTimer > 0 && ks[4].stallTimer === 0, 'early tap released, re-pressed in window: boost');
  ok(race.time < 0.02, 'race.time starts at GO');
}

section('race: laps, places, finish, results, over');
{
  events.length = 0;
  const ks = makeKarts(4);
  const race = new Race({ track, karts: ks, laps: 2, player: ks[3] });
  race.skipIntro();
  step(race, 3 * 120 + 2);
  ok(race.state === 'racing', 'racing after skipIntro + 3 s');
  // drive karts forward by teleporting along the track at different speeds
  const sOf = ks.map((k) => k.proj.s);
  const speeds = [30, 29, 20, 28];
  let t = 0;
  let lapEvents = 0, finalLaps = 0;
  const off1 = bus.on('race:lap', () => lapEvents++), off2 = bus.on('race:finalLap', () => finalLaps++);
  // long enough for the player (28 m/s) to finish + the results delay on any lap length (v5: 1387 m Breezy),
  // short enough that the 20 m/s kart never does
  const tMax = (2 * L + 20) / 28 + 15;
  while (t < tMax && !race.over) {
    for (let i = 0; i < ks.length; i++) {
      sOf[i] += speeds[i] * DT;
      placeAt(ks[i], sOf[i], 0, { speed: speeds[i] });
    }
    // the player wiggles backwards over the line once early in lap 2
    step(race);
    t += DT;
  }
  off1(); off2();
  const k0 = ks[0];
  ok(k0.finished && k0.lapTimes.length === 2, `leader finished 2 laps (${k0.lapTimes.length})`);
  const expect = (2 * L + 7) / 30;          // pole starts 7 m behind the line
  ok(Math.abs(k0.finishTime - expect) < 0.05, `finish time ${k0.finishTime?.toFixed(3)} ~ ${expect.toFixed(3)}`);
  ok(Math.abs(k0.lapTimes[1] - L / 30) < 0.05, `lap 2 time ${k0.lapTimes[1]?.toFixed(3)} ~ ${(L / 30).toFixed(3)}`);
  ok(lapEvents === 4 && finalLaps === 4, `race:lap x4 (${lapEvents}), finalLap x4 (${finalLaps})`);
  const order = race.finishOrder.map((k) => k.id).join();
  ok(order === `${ks[0].id},${ks[1].id},${ks[3].id}`, `finish order ${order}`);
  ok(race.playerFinished, 'player finished');
  ok(race.over && count('race:over') === 1, 'race:over once (resultsDelay after the player)');
  const res = race.getResults();
  ok(res.length === 4 && res[3].kart === ks[2] && !res[3].finished && res[3].estimated, 'slow kart last, estimated');
  ok(res[3].time > res[2].time, `estimate after the last finisher (${res[3].time.toFixed(2)} > ${res[2].time.toFixed(2)})`);
  ok(res[0].bestLap > 0 && res[0].place === 1, 'bestLap + place');
  ok(race.getResults() === res, 'results snapshot is stable after race:over');
  ok(count('race:finish') === 3, 'race:finish x3');
  step(race, 120);
  ok(count('race:over') === 1, 'race:over not repeated');
}

section('race: no lap credit for wiggling over the line; position change; wrong way');
{
  events.length = 0;
  const ks = makeKarts(2);
  const race = new Race({ track, karts: ks, laps: 3, player: ks[1] });
  race.skipIntro();
  step(race, 361);
  const p = ks[1], other = ks[0];
  let s = p.proj.s;
  // cross the line forward, then back and forth 3 times
  for (const target of [5, -5, 5, -5, 5]) {
    const dir = Math.sign(track.deltaS(s, target));
    while (Math.abs(track.deltaS(s, target)) > 0.3) { s += dir * 0.25; placeAt(p, s, 2, { speed: 10 }); placeAt(other, -2, -2); step(race); }
  }
  ok(p.lapTimes.length === 0 && p.lap === 1, `no lap credit (laps done ${p.lapTimes.length}, lap ${p.lap})`);
  // player overtakes the other kart -> race:positionChange
  placeAt(other, 40, -3); step(race);
  const toFirst = (d) => d.kart === p && d.to === 1 && d.from === 2;
  const before = count('race:positionChange', toFirst);
  ok(p.place === 2, `player 2nd before the pass (${p.place})`);
  placeAt(p, 60, 3); step(race);
  ok(count('race:positionChange', toFirst) === before + 1, 'positionChange emitted for the player');
  // wrong way: face backwards and move for > wrongWayDelay
  let ss = 60;
  for (let i = 0; i < 150; i++) { ss -= 8 * DT; placeAt(p, ss, 3, { back: true, speed: 8 }); step(race); }
  ok(p.wrongWay && count('race:wrongWay', (d) => d.on) === 1, 'wrong way ON after delay');
  for (let i = 0; i < 10; i++) { ss += 8 * DT; placeAt(p, ss, 3, { speed: 8 }); step(race); }
  ok(!p.wrongWay && count('race:wrongWay', (d) => !d.on) === 1, 'wrong way OFF when facing forward');
}

section('race: photo finish is decided by crossing time, not kart order');
{
  // ks[1] crosses 0.1 m (3.3 ms) before ks[0], inside the same 1/120 s substep
  events.length = 0;
  const ks = makeKarts(2);
  const race = new Race({ track, karts: ks, laps: 1, player: ks[1] });
  race.skipIntro();
  step(race, 361);
  const v = 30;
  let s1 = L - 20 + 0.22, s0 = s1 - 0.1;                      // 1-lap race, ~20 m to go
  ks[1].distance = s1; ks[0].distance = s0;
  race._st.get(ks[1]).prevS = track.wrapS(s1); race._st.get(ks[0]).prevS = track.wrapS(s0);
  placeAt(ks[1], s1, 2, { speed: v }); placeAt(ks[0], s0, -2, { speed: v });
  const steps = [];
  const off = bus.on('race:finish', (e) => steps.push({ kart: e.kart, place: e.place, time: e.time, at: race.elapsed }));
  for (let i = 0; i < 200 && steps.length < 2; i++) {
    s1 += v * DT; s0 += v * DT;
    placeAt(ks[1], s1, 2, { speed: v }); placeAt(ks[0], s0, -2, { speed: v });
    step(race);
  }
  off();
  ok(steps.length === 2 && steps[0].at === steps[1].at, 'both karts finish in the same substep (test setup)');
  ok(ks[1].place === 1 && ks[0].place === 2 && race.finishOrder[0] === ks[1], `earlier crossing wins (places ${ks[1].place}/${ks[0].place})`);
  ok(ks[1].finishTime < ks[0].finishTime && steps[0].kart === ks[1] && steps[0].place === 1, 'race:finish in crossing order with the faster time first');
  const res = race.getResults(true);
  ok(res[0].kart === ks[1] && res[0].time < res[1].time, 'results: 1st has the faster time');
}

// --------------------------------------------------------------- items
function itemSetup(n = 4) {
  const ks = makeKarts(n);
  const race = new Race({ track, karts: ks, laps: 3 });
  race.skipIntro();
  step(race, 361);
  const items = new ItemSystem({ track, karts: ks, scene: null, rng: makeRng(5) });
  return { ks, race, items };
}
// After teleporting karts with placeAt: make race distances = their s on lap 1.
function syncDistances(race, ks) { race.update(DT); for (const k of ks) k.distance = k.proj.s; race.update(DT); }
// Move every kart out of the way (500 m + 30 m each), keeping race distances valid.
function park(ks, race) { ks.forEach((k, i) => driveTo(race, k, 500 + i * 30, 0)); }
// Walk a kart to arc length s in small steps so race.js can follow its distance.
function driveTo(race, k, s, lat = 0) {
  let cur = k.proj.s;
  for (let g = 0; g < 100 && Math.abs(track.deltaS(cur, s)) > 0.01; g++) {
    const d = track.deltaS(cur, s);
    cur += Math.sign(d) * Math.min(Math.abs(d), 40);
    placeAt(k, cur, lat);
    race.update(DT);
  }
}
// one full substep the way main.js does it (no AI)
function tick(items, race, ks, n = 1) {
  for (let i = 0; i < n; i++) { items.update(DT, race); for (const k of ks) k.update(DT); race.update(DT); }
}

section('items: boxes + roulette');
{
  events.length = 0;
  const { ks, race, items } = itemSetup();
  park(ks, race);
  const k = ks[0];
  const box = items.boxes[0];
  ok(items.boxes.length === track.itemBoxes.length && Math.abs(box.position.y - track.itemBoxes[0].position.y - 1.1) < 1e-6, 'boxes 1.1 m above the road');
  k.position.copy(box.position); k.position.y -= 1.1; k.velocity.set(0, 0, 0);
  items.update(DT, race);
  ok(!box.active && count('item:boxHit') === 1 && count('item:rollStart') === 1, 'box broken, roulette started');
  ok(k.rolling && Math.abs(k.rollTimer - ITEM.aiRouletteSeconds) < 0.02 && ITEM_IDS.includes(k.rollItem), 'CPU roll time + rollItem decided');
  const rolled = k.rollItem;
  k.input.useItem = true;
  items.update(DT, race);
  ok(k.rollTimer <= ITEM_TUNE.rollShortenTo && !k.input.useItem, 'item press shortens the roll, pulse consumed');
  for (let i = 0; i < 40; i++) items.update(DT, race);
  ok(!k.rolling && k.item === rolled && count('item:get') === 1, `item assigned at roll end (${k.item})`);
  // second box while holding: breaks, no roll
  const box2 = items.boxes[1];
  k.position.copy(box2.position); k.position.y -= 1.1;
  items.update(DT, race);
  ok(!box2.active && !k.rolling && count('item:rollStart') === 1, 'holding an item: box breaks, no roulette');
  placeAt(k, 600, 0);
  for (let i = 0; i < Math.ceil(ITEM.boxRespawn * 120) + 2; i++) items.update(DT, race);
  ok(box.active && box2.active, 'boxes respawn');
  // player roll time
  const pk = ks[1]; pk.isPlayer = true; park(ks, race); pk.position.copy(items.boxes[3].position); pk.position.y -= 1.1;
  items.update(DT, race);
  ok(pk.rolling && Math.abs(pk.rollTimer - ITEM.rouletteSeconds) < 0.02, 'player roll time');
  // roulette table: 1st never gets star / zap / triple; 8th never banana / stink
  const rng = makeRng(9);
  const it8 = new ItemSystem({ track, karts: makeKarts(8), scene: null, rng });
  const got = { 1: new Set(), 8: new Set() };
  for (let i = 0; i < 4000; i++) { got[1].add(it8.rollFor(ks[0], 1)); it8.time += 20; got[8].add(it8.rollFor(ks[0], 8)); }
  ok(!got[1].has('star') && !got[1].has('zap') && !got[1].has('triple_toot'), `1st place items ${[...got[1]]}`);
  ok(!got[8].has('banana') && !got[8].has('stink') && got[8].has('star'), `8th place items ${[...got[8]]}`);
  ok(ITEM_TABLE.length === 8, 'table rows');
}

section('items: banana, stink');
{
  events.length = 0;
  const { ks, race, items } = itemSetup();
  park(ks, race);
  const [a, b, c] = ks;
  placeAt(a, 100, 0, { speed: 0 });
  a.item = 'banana'; a.itemCount = 1;
  a.input.useItem = true;
  items.update(DT, race);
  const h = items.hazards[0];
  ok(h && h.type === 'banana' && !a.item && count('item:use') === 1, 'banana dropped, slot emptied');
  ok(Math.abs(track.deltaS(h.s, 100) - ITEM_TUNE.bananaBack) < 0.1 && Math.abs(h.position.y - h.proj.height) < 1e-6, `2.2 m behind, on the road (${track.deltaS(h.s, 100).toFixed(2)})`);
  // the owner backing over it right away: grace; later it would hit
  placeAt(a, h.s, h.lateral); items.update(DT, race);
  ok(items.hazards.length === 1 && a.spinTimer === 0, 'owner grace');
  placeAt(a, 300, 0);
  placeAt(b, h.s, h.lateral, { speed: 20 }); items.update(DT, race);
  ok(b.spinTimer > 0 && items.hazards.length === 0 && count('item:hit', (d) => d.kart === b && d.item === 'banana') === 1, 'banana spins the victim and disappears');
  // disabled karts cannot use items
  b.item = 'toot'; b.itemCount = 1; b.input.useItem = true; items.update(DT, race);
  ok(b.item === 'toot' && !b.input.useItem, 'use ignored while spinning (pulse consumed)');
  // stink: owner immune for 1 s, spins each kart once, slows
  b.spinTimer = 0; b.invulnTimer = 0;
  placeAt(c, 200, 0); c.item = 'stink'; c.itemCount = 1; items.useItem(c);
  const cloud = items.hazards.find((x) => x.type === 'stink');
  ok(cloud && Math.abs(cloud.radius - ITEM.stinkRadius) < 1e-6 && cloud.life === ITEM.stinkLife, 'stink cloud radius/life');
  placeAt(c, cloud.s, cloud.lateral); items.update(DT, race);
  ok(c.spinTimer === 0, 'stink owner immune at first');
  placeAt(c, 400, 0);
  for (let i = 0; i < 70; i++) items.update(DT, race);     // let it billow out
  placeAt(b, cloud.s, cloud.lateral + 2.5, { speed: 20 });
  const v0 = b.velocity.length();
  items.update(DT, race);
  ok(b.spinTimer > 0 && b.velocity.length() < v0, 'stink spins + slows an entering kart');
  b.spinTimer = 0; b.invulnTimer = 0;
  items.update(DT, race);
  ok(b.spinTimer === 0, 'only once per cloud per kart');
  for (let i = 0; i < ITEM.stinkLife * 120; i++) items.update(DT, race);
  ok(!items.hazards.includes(cloud), 'stink expires');
}

section('items: bouncer, rocket, blocking');
{
  events.length = 0;
  const { ks, race, items } = itemSetup();
  park(ks, race);
  const [a, b, c] = ks;
  // bouncer: launched at max(speed, kart+20), hits a kart ahead with a tumble
  placeAt(a, 20, 0, { speed: 25 });
  placeAt(b, 50, 0);
  a.item = 'bouncer'; a.itemCount = 1; items.useItem(a);
  const ball = items.projectiles[0];
  ok(ball && ball.type === 'bouncer' && Math.abs(ball.speed - Math.max(ITEM.bouncerSpeed, 45)) < 0.6, `bouncer speed ${ball && ball.speed.toFixed(1)}`);
  for (let i = 0; i < 120 && items.projectiles.length; i++) items.update(DT, race);
  ok(b.tumbleTimer > 0 && count('item:hit', (d) => d.kart === b && d.item === 'bouncer' && d.by === a) === 1, 'bouncer tumbles the kart ahead');
  // bouncer bounces off walls (aim it across the road) and dies after max bounces / life
  park(ks, race);
  placeAt(a, 30, 0); a.yaw += 1.2; a.item = 'bouncer'; a.itemCount = 1; items.useItem(a);
  let bounces = 0; const offB = bus.on('item:bounce', () => bounces++);
  let life = 0;
  while (items.projectiles.length && life < 10) { items.update(DT, race); life += DT; }
  offB();
  ok(bounces >= 2 && bounces <= ITEM.bouncerMaxBounces && life <= ITEM.bouncerLife + 0.05, `bounced ${bounces}x, gone after ${life.toFixed(2)} s`);
  // rocket: c is 3rd, b 2nd -> targets b and hits it even with a lateral offset
  placeAt(ks[3], 30); placeAt(c, 100, -5); placeAt(b, 180, 5); placeAt(a, 600);
  b.tumbleTimer = 0; b.invulnTimer = 0; b.velocity.set(0, 0, 0);
  syncDistances(race, ks);
  ok(race.getPlace(b) === 2 && race.getPlace(c) === 3, 'places for the rocket test');
  c.item = 'rocket'; c.itemCount = 1; items.useItem(c);
  const r = items.projectiles[0];
  ok(r && r.type === 'rocket' && r.target === b && r.mode === 'track', 'rocket locks on the kart one place ahead');
  let sawHome = false;
  for (let i = 0; i < 400 && items.projectiles.length; i++) { items.update(DT, race); if (r.mode === 'home') sawHome = true; }
  ok(sawHome && b.tumbleTimer > 0 && count('item:explode', (d) => d.hit && d.kart === b) === 1 && count('item:hit', (d) => d.kart === b && d.item === 'rocket') === 1, 'rocket homes in + tumbles + explodes');
  // leader's rocket flies straight
  placeAt(a, 700); syncDistances(race, ks);
  a.item = 'rocket'; a.itemCount = 1; items.useItem(a);
  ok(items.projectiles[0].mode === 'straight' && !items.projectiles[0].target, 'rocket from 1st flies straight');
  items.clear();
  // projectile vs banana -> item:blocked
  park(ks, race);
  placeAt(b, 72.2, 0); b.item = 'banana'; b.itemCount = 1; items.useItem(b); placeAt(b, 900, 0);
  placeAt(a, 30, items.hazards[0].lateral, { speed: 0 });
  a.item = 'bouncer'; a.itemCount = 1; items.useItem(a);
  for (let i = 0; i < 120 && items.projectiles.length; i++) items.update(DT, race);
  ok(items.hazards.length === 0 && count('item:blocked', (d) => d.kart === a) === 1, 'bouncer clears a banana (item:blocked)');
}

section('items: point-blank rocket (target right alongside), owner immunity');
{
  // shooter 2nd, target 1st just ahead + to the side, both at 27 m/s on the
  // start straight; after firing the shooter keeps its lane or tucks in 6 m
  // behind the target: the rocket must connect at once, never loop back
  const cases = [[0, 2.4, false], [0.5, 3, false], [1, 4, false], [1.5, 5, false], [0, 2.4, true], [0.5, 3, true], [1, 2.5, true], [1.5, 4, true]];
  let prompt = 0, selfHits = 0;
  const bad = [];
  for (const [gap, dl, tuck] of cases) {
    const ks = makeKarts(2);
    const [tgt, sh] = ks;
    const race = new Race({ track, karts: ks, laps: 3, player: sh });
    race.skipIntro();
    step(race, 361);
    const items = new ItemSystem({ track, karts: ks, scene: null, rng: makeRng(3) });
    const v = 27;
    let sS = 10, sT = 10 + gap, latS = -dl / 2;
    const latT = dl / 2;
    placeAt(sh, sS, latS, { speed: v }); placeAt(tgt, sT, latT, { speed: v });
    for (const k of ks) k.frozen = false;
    race.update(DT);
    sh.item = 'rocket'; sh.itemCount = 1; sh.input.useItem = true;
    let hit = null, t = 0;
    const off = bus.on('item:hit', (e) => { if (e.projectile && !hit) hit = { kart: e.kart, t }; });
    while (t < 3 && !hit) {
      items.update(DT, race);
      sT += v * DT;
      if (tuck) { latS = damp(latS, latT, 3, DT); sS += (v + clamp((sT - 6 - sS) * 1.5, -6, 6)) * DT; } else sS += v * DT;
      placeAt(tgt, sT, latT, { speed: v }); placeAt(sh, sS, latS, { speed: v });
      race.update(DT);
      t += DT;
    }
    off();
    if (hit && hit.kart === sh) selfHits++;
    if (hit && hit.kart === tgt && hit.t < 0.35) prompt++;
    else bad.push(`gap ${gap} lat ${dl}${tuck ? ' tuck' : ''}: ${hit ? `${hit.kart === sh ? 'SHOOTER' : 'target'} @${hit.t.toFixed(2)}s` : 'miss'}`);
    items.dispose();
  }
  ok(selfHits === 0, `no rocket self-hits at point-blank range (${selfHits})`);
  ok(prompt === cases.length, `point-blank rocket hits the target within 0.35 s (${prompt}/${cases.length}) ${bad.join('; ')}`);
  // a rocket locked on a target flies through its own shooter harmlessly
  {
    const { ks, race, items } = itemSetup(3);
    park(ks, race);
    const [a, b] = ks;
    placeAt(a, 300, 0); placeAt(b, 200, 0);
    syncDistances(race, ks);
    b.item = 'rocket'; b.itemCount = 1; items.useItem(b);
    const r = items.projectiles[0];
    for (let i = 0; i < Math.ceil((ITEM.shooterGrace + 0.1) * 120); i++) items.update(DT, race);
    ok(r.active && r.mode === 'track' && r.target === a, 'rocket still tracking after the shooter grace');
    b.position.copy(r.position); b.position.y -= 0.6; b.invulnTimer = 0;
    items.update(DT, race);
    ok(r.active && b.tumbleTimer === 0, 'locked-on rocket ignores its shooter after the grace period');
    ok(!items.getThreatsNear(b, 40).some((x) => x.ref === r), 'shooter does not dodge its own locked-on rocket (threats)');
    items.dispose();
  }
}

section('items: toot, triple toot, star, zap, threats, clear');
{
  events.length = 0;
  const { ks, race, items } = itemSetup();
  park(ks, race);
  const [a, b, c, d] = ks;
  a.item = 'toot'; a.itemCount = 1; items.useItem(a);
  ok(Math.abs(a.boostTimer - BOOST.tootDuration) < 1e-6 && !a.item, 'toot boost');
  a.boostTimer = 0;
  a.item = 'triple_toot'; a.itemCount = 3;
  items.useItem(a); ok(a.item === 'triple_toot' && a.itemCount === 2, 'triple toot keeps the slot (2 left)');
  items.useItem(a); items.useItem(a);
  ok(!a.item && a.itemCount === 0 && count('item:use', (e) => e.item === 'triple_toot') === 3, 'triple toot: 3 uses');
  b.item = 'star'; b.itemCount = 1; items.useItem(b);
  ok(b.starTimer > 0 && b.isInvincible(), 'star');
  // zap from 4th: 1st..3rd zapped except the starred one
  placeAt(d, 500); placeAt(a, 600); placeAt(b, 700); placeAt(c, 800);
  syncDistances(race, ks);
  ok(race.getPlace(d) === 4, 'zap user is 4th');
  d.item = 'zap'; d.itemCount = 1; items.useItem(d);
  ok(c.slowTimer > 0 && a.slowTimer > 0 && b.slowTimer === 0 && d.slowTimer === 0, 'zap hits better-placed, not starred, not the user');
  ok(count('item:zap', (e) => e.kart === d) === 1 && count('item:hit', (e) => e.item === 'zap') === 2, 'item:zap + item:hit per victim');
  ok(count('item:zap', (e) => Array.isArray(e.victims) && e.victims.length === 2 && e.victims.includes(a) && e.victims.includes(c) && e.count === 2) === 1,
    'item:zap lists its victims (main.js shows ZAPPED! when the player is one)');
  ok(Math.abs(c.maxSpeed - c.stats.topSpeed * HIT.zapSlowMult) < 1e-6 || c.isDisabled(), 'zapped kart slowed');
  // threats
  park(ks, race);
  placeAt(a, 300, 0); a.item = 'banana'; a.itemCount = 1; items.useItem(a);
  placeAt(b, 280, 0);
  const th = items.getThreatsNear(b, 40);
  ok(th.length === 1 && th[0].type === 'banana' && th[0].ahead && Math.abs(th[0].distance - 17.8) < 0.5, `threat ahead (${th.length} ${th[0] && th[0].distance.toFixed(1)})`);
  const th2 = items.getThreatsNear(b, 40);
  ok(th2 === th && th2[0] === th[0], 'threat list is reused (no allocation)');
  items.clear();
  ok(items.hazards.length === 0 && items.projectiles.length === 0 && items.boxes.every((x) => x.active), 'clear()');
  items.dispose();
}

section('ai: no bouncer fired across the lighthouse hairpin');
{
  // a rival straight ahead on our nose line, 26 m away: on the hill straight
  // before the hairpin it is already in the turn (the ball would rebound off
  // the outer wall into us); on a plain straight it is a fair shot
  const ks = makeKarts(2);
  const [me, o] = ks;
  const race = new Race({ track, karts: ks, laps: 3 });
  const ai = new AIDriver(me, { track, difficulty: 'hard', skill: 0.9, rng: makeRng(4) });
  const aimAt = (s0) => {
    placeAt(me, s0, 0, { speed: 25 });
    const f = track.frameAt(s0);
    const pr = track.project({ x: f.x + Math.sin(f.yaw) * 26, y: f.y, z: f.z + Math.cos(f.yaw) * 26 }, -1, {});
    placeAt(o, pr.s, pr.lateral, { speed: 20 });
    return ai._shouldUse('bouncer', { karts: ks, race }, me.proj.s, me.speed);
  };
  const hairpin = track.zones.find((z) => z.type === 'hairpin');
  ok(!aimAt(hairpin.s0 - 12), 'bouncer held when the target is across the hairpin');
  ok(aimAt(320), 'bouncer fired at a kart ahead on a straight');
}

section('ai: never NaN, start timing, recovery from a wall-facing standstill');
{
  const ks = makeKarts(2);
  const race = new Race({ track, karts: ks, laps: 3 });
  const ai = new AIDriver(ks[0], { track, skill: 0.9, rng: makeRng(2) });
  race.skipIntro();
  let pressed = null;
  while (race.state === 'countdown') { ai.update(DT, { karts: ks, race }); if (ks[0].input.throttle > 0 && pressed === null) pressed = race.countdown; race.update(DT); }
  ok(pressed !== null, `AI pressed the throttle during the countdown (${pressed && pressed.toFixed(2)} s before GO)`);
  // park facing the right wall at standstill
  const f = track.frameAt(120);
  placeAt(ks[0], 120, f.wallR - 1.15);
  ks[0].yaw = f.yaw - Math.PI / 2;
  let t = 0, moved = 0; const s0 = ks[0].distance;
  while (t < 9) { ai.update(DT, { karts: ks, race }); ks[0].update(DT); race.update(DT); t += DT; }
  moved = ks[0].distance - s0;
  ok(moved > 60, `AI recovered from facing the wall (moved ${moved.toFixed(1)} m in 9 s, respawns ${ai.respawns})`);
}


// ---------------------------------------------------------------- v3 rules
section('race v3: two humans — finish clock, estimated placings, points, per-human events');
{
  events.length = 0;
  const ks = makeKarts(4);
  ks[1].slot = 1; ks[3].slot = 2;
  const race = new Race({ track, karts: ks, laps: 1, players: [ks[1], ks[3]] });
  ok(race.player === ks[1] && race.isHuman(ks[3]) && !race.isHuman(ks[0]), 'players registered (P1 = first)');
  race.skipIntro();
  step(race, 361);
  const sOf = ks.map((k) => k.proj.s);
  const speeds = [29, 30, 27, 8];          // human P2 (ks[3]) crawls: still racing when the clock ends
  let t = 0, clockAt = null, overAt = null;
  const offC = bus.on('race:finishClock', (e) => { clockAt = race.time; ok(e.seconds === RACE.finishClock && e.kart === ks[1], 'finish clock starts with the first human'); });
  const offO = bus.on('race:over', () => { overAt = race.time; });
  while (t < 120 && !race.over) {
    for (let i = 0; i < ks.length; i++) { sOf[i] += speeds[i] * DT; placeAt(ks[i], sOf[i], 0, { speed: speeds[i] }); }
    step(race);
    t += DT;
  }
  offC(); offO();
  ok(clockAt !== null && overAt !== null && Math.abs(overAt - clockAt - RACE.finishClock) < 0.05, `race over ${overAt && clockAt && (overAt - clockAt).toFixed(2)} s after the first human finished`);
  ok(race.over && !ks[3].finished && count('race:over') === 1, 'race:over while the slow human is still racing');
  const res = race.getResults();
  const slow = res.find((r) => r.kart === ks[3]);
  ok(slow.place === 4 && slow.estimated && slow.isHuman && slow.slot === 2, `slow human placed by running order with an estimated time (place ${slow.place})`);
  ok(res.every((r) => r.points === pointsFor(r.place, 4)) && res[0].points === 5, `points from parts.pointsFor (${res.map((r) => r.points)})`);
  ok(res.find((r) => r.kart === ks[1]).isHuman && !res.find((r) => r.kart === ks[0]).isHuman, 'isHuman flags');
  ok(pointsFor(1, 8) === 10 && pointsFor(8, 8) === 1 && pointsFor(2, 2) === 1, 'GP points table');
}
{
  // both humans finish inside the clock: results RACE.resultsDelay after the LAST human
  const ks = makeKarts(3);
  const race = new Race({ track, karts: ks, laps: 1, players: [ks[0], ks[2]] });
  race.skipIntro();
  step(race, 361);
  const sOf = ks.map((k) => k.proj.s), speeds = [30, 6, 25];
  let lastHuman = null, overAt = null, t = 0;
  const offF = bus.on('race:finish', (e) => { if (e.kart === ks[2]) lastHuman = race.time; });
  const offO = bus.on('race:over', () => { overAt = race.time; });
  while (t < 120 && !race.over) {
    for (let i = 0; i < ks.length; i++) { sOf[i] += speeds[i] * DT; placeAt(ks[i], sOf[i], 0, { speed: speeds[i] }); }
    step(race);
    t += DT;
  }
  offF(); offO();
  ok(lastHuman !== null && Math.abs(overAt - lastHuman - RACE.resultsDelay) < 0.05 && !ks[1].finished, `over ${overAt && (overAt - lastHuman).toFixed(2)} s after the last human (CPU still racing)`);
}
{
  // wrong way + position events for every human kart
  events.length = 0;
  const ks = makeKarts(3);
  const race = new Race({ track, karts: ks, laps: 3, humans: [ks[1], ks[2]] });   // (alias of players)
  race.skipIntro();
  step(race, 361);
  placeAt(ks[0], 30, -3); placeAt(ks[1], 20, 0); placeAt(ks[2], 10, 3); syncDistances(race, ks);
  placeAt(ks[2], 50, 3); syncDistances(race, ks);
  ok(count('race:positionChange', (d) => d.kart === ks[2] && d.to === 1) === 1 && count('race:positionChange', (d) => d.kart === ks[1] && d.to === 3) === 1, 'positionChange for both humans');
  let s1 = 20, s2 = 50;
  for (let i = 0; i < 150; i++) { s1 -= 8 * DT; s2 -= 8 * DT; placeAt(ks[1], s1, 0, { back: true, speed: 8 }); placeAt(ks[2], s2, 3, { back: true, speed: 8 }); placeAt(ks[0], 30, -3); step(race); }
  ok(count('race:wrongWay', (d) => d.on && d.kart === ks[1]) === 1 && count('race:wrongWay', (d) => d.on && d.kart === ks[2]) === 1, 'WRONG WAY for both humans');
  ok(count('race:wrongWay', (d) => d.kart === ks[0]) === 0, 'no events for CPUs');
}

section('items v3: Zap limits, Star limit, Items Off, engine class');
{
  const { ks, race, items } = itemSetup(8);
  park(ks, race);
  items.update(DT, race);                   // the item clock follows race.time (s since GO)
  const roll = (n, place = 8) => { const got = new Map(); for (let i = 0; i < n; i++) { const id = items.rollFor(ks[0], place); got.set(id, (got.get(id) || 0) + 1); if (id === 'zap') return { got, zap: true }; } return { got, zap: false }; };
  race.time = 5;
  ok(!roll(3000).zap, 'no Zap in the first 30 s');
  race.time = ITEM.zapFreeTime + 1;
  const first = roll(3000);
  ok(first.zap, 'Zap possible after 30 s');
  ok(!roll(3000).zap, 'no second Zap within the 30 s cooldown');
  race.time += ITEM.zapCooldown + 1;
  ks[3].item = 'zap'; ks[3].itemCount = 1;
  ok(!roll(3000).zap, 'never two Zaps at once (one is held)');
  ks[3].item = null; ks[3].itemCount = 0;
  ok(roll(3000).zap, 'Zap again once the cooldown passed and none is held');
  // stars: at most two held / rolling / running
  ks[1].item = 'star'; ks[1].itemCount = 1; ks[2].starTimer = 3;
  let stars = 0;
  for (let i = 0; i < 3000; i++) if (items.rollFor(ks[0], 8) === 'star') stars++;
  ok(stars === 0, 'no third Rainbow Star while two are in play');
  ks[2].starTimer = 0;
  for (let i = 0; i < 3000; i++) if (items.rollFor(ks[0], 8) === 'star') stars++;
  ok(stars > 0, 'stars roll again below the limit');
  // engine class scales projectile speeds
  const slow = new ItemSystem({ track, karts: ks, scene: null, rng: makeRng(3), ccMult: 0.8 });
  placeAt(ks[5], 300, 0); ks[5].velocity.set(0, 0, 0);
  ks[5].item = 'bouncer'; ks[5].itemCount = 1; slow.useItem(ks[5]);
  ok(slow.projectiles.length === 1 && Math.abs(slow.projectiles[0].speed - ITEM.bouncerSpeed * 0.8) < 1e-9, `bouncer speed x ccMult (${slow.projectiles[0] && slow.projectiles[0].speed})`);
  slow.dispose();
  // items off: no boxes, nothing to pick up
  const off = new ItemSystem({ track, karts: ks, scene: null, rng: makeRng(4), enabled: false });
  const k = ks[0];
  k.position.copy(track.itemBoxes[0].position);
  for (let i = 0; i < 10; i++) off.update(DT, race);
  ok(off.boxes.length === 0 && !k.rolling && !k.item, 'items off: no boxes, no roulette');
  off.dispose();
  items.dispose();
}

section('ai v3: personalities, CPU presets, engine class difficulty, pace, tricks');
{
  // roster-agnostic (characters.js is the user's): every personality is well-formed, and a
  // racer without one drives with the default personality
  ok(Object.values(AI_PERSONALITIES).every((p) => ['offset', 'wander', 'line', 'aggression', 'drift', 'items', 'pace'].every((f) => Number.isFinite(p[f]))), 'AI personalities well-formed');
  {
    const stranger = new Kart({ id: 'stranger', character: { ...CHARACTERS[0], id: 'no-such-racer-v5' }, track });
    const sd = new AIDriver(stranger, { track, difficulty: 'normal', skill: 0.7, rng: makeRng(1) });
    ok(Number.isFinite(sd.personality.aggression) && Number.isFinite(sd.personality.line), 'a racer without a personality gets the default one');
  }
  const presetSeen = { light: new Set(), medium: new Set(), heavy: new Set() };
  for (const c of CHARACTERS) {
    const a = cpuLoadout(c, 7), b = cpuLoadout(c, 7);
    ok(a.body === b.body && a.wheels === b.wheels && CPU_PRESETS[c.weightClass].some((p) => p.body === a.body && p.wheels === a.wheels), `${c.id}: preset kart, stable per set`);
    for (let seed = 0; seed < 40; seed++) presetSeen[c.weightClass].add(cpuLoadout(c, seed).body);
  }
  ok(Object.values(presetSeen).every((set) => set.size === 2), 'both presets of every class appear across sets');
  ok(difficultyForCc(50) === 'easy' && difficultyForCc(100) === 'normal' && difficultyForCc(150) === 'hard', 'difficulty from the engine class');
  const ks = makeKarts(4);
  const drivers = createAIDrivers(ks, { track, cc: 150, rng: makeRng(1), humans: [ks[0], ks[1]] });
  ok(drivers.length === 2 && drivers.every((d) => d.difficulty === 'hard' && d.kart !== ks[0] && d.kart !== ks[1]), 'CPU drivers for the non-humans, 150cc = hard');
  // rubber band against the LEADING human; a human kart driven by an AIDriver keeps 1.0
  const [h1, h2, cpu] = ks;
  h1.distance = 100; h2.distance = 600; cpu.distance = 300;
  const ai = new AIDriver(cpu, { track, difficulty: 'normal', skill: 0.7, rng: makeRng(2) });
  const ctx = { karts: ks, humans: [h1, h2] };
  for (let i = 0; i < 2000; i++) ai._updatePace(DT, ctx);
  const base = DIFFICULTY.normal.aiSpeedMult * ai.pace;
  ok(cpu.speedMult > base * (1 + DIFFICULTY.normal.rubberBand * 0.9), `CPU 300 m behind the leading human speeds up (${cpu.speedMult.toFixed(3)} vs ${base.toFixed(3)})`);
  ctx.humans = [h1];
  for (let i = 0; i < 2000; i++) ai._updatePace(DT, ctx);
  ok(cpu.speedMult < base, `CPU 200 m ahead of the only human eases off (${cpu.speedMult.toFixed(3)})`);
  const take = new AIDriver(h1, { track, difficulty: 'normal', skill: 0.7, rng: makeRng(3) });
  h1.speedMult = 0.5;
  for (let i = 0; i < 2000; i++) take._updatePace(DT, { karts: ks, humans: [h1, h2] });
  ok(Math.abs(h1.speedMult - 1) < 1e-3, 'a disconnected human driven by the AI keeps pace 1.0');
  // tricks off the kicker ramp: probability = skill
  const trickRate = (skill) => {
    let tricks = 0;
    const off = bus.on('kart:trick', () => tricks++);
    for (let seed = 1; seed <= 12; seed++) {
      const k = new Kart({ id: 'tr', character: CHARACTERS[4], track });
      const r = track.ramps[0];
      placeAt(k, r.s0 - 60, 0, { speed: 26 });
      k.position.y = k.proj.height;
      const d = new AIDriver(k, { track, difficulty: 'hard', skill, rng: makeRng(seed) });
      for (let i = 0; i < 4 / DT; i++) { d.update(DT, { karts: [k] }); k.update(DT); }
    }
    off();
    return tricks / 12;
  };
  const hi = trickRate(1), lo = trickRate(0.05);
  ok(hi >= 0.9 && lo <= 0.25, `CPU tricks: skill 1 -> ${hi.toFixed(2)}, skill 0.05 -> ${lo.toFixed(2)} per jump`);
  ok(AI_TUNE.pulseSkill > 0 && DRIFT.trickWindow === 0.5, 'tuning sanity');
}


// ---------------------------------------------------------------- v4 items (SPEC §15.2)
const IDX = Object.fromEntries(ITEM_IDS.map((id, i) => [id, i]));
// Give a kart an item through the real roulette end (triples deploy there).
function grant(items, k, id) { k.item = null; k.itemCount = 0; k.rolling = true; k.rollItem = id; k.rollTimer = 0; items._finishRoll(k); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Expected roulette share (%) of an item at a place (no shift, nothing blocked): its
// ITEM_TABLE weight over the row's sum of the ENABLED columns (config ITEM_ENABLED).
const expPct = (place, id) => {
  const row = ITEM_TABLE[place - 1];
  const sum = row.reduce((a, w, i) => a + (itemEnabled(ITEM_IDS[i]) ? w : 0), 0);
  return itemEnabled(id) ? (100 * row[IDX[id]]) / sum : 0;
};

section('items v4: ids, table, distribution by place');
{
  ok(ITEM_IDS.length === 40 && ITEM_IDS.slice(0, 8).join() === 'banana,bouncer,rocket,toot,triple_toot,stink,star,zap'
    && ITEM_IDS[16] === 'beer_rocket' && ITEM_IDS[17] === 'peperoncino' && NATIVE_ITEM_IDS.join() === ITEM_IDS.slice(0, 17).join(), 'ids append-only: original 8, v4 9, v5 23');
  ok(ITEM_IDS.every((id) => ITEM_INFO[id] && ITEM_INFO[id].name && ITEM_INFO[id].icon && ITEM_INFO[id].uses >= 1), 'ITEM_INFO for every id');
  ok(ITEM_TABLE.length === 8 && ITEM_TABLE.every((r) => r.length === ITEM_IDS.length && r.reduce((a, b) => a + b, 0) === 100), `ITEM_TABLE 8 x ${ITEM_IDS.length}, rows sum to 100`);
  ok(['triple_banana', 'triple_bouncer', 'triple_rocket'].every((id) => ITEM_INFO[id].uses === 3), 'triples have 3 uses');
  // original names only: no Nintendo item names (SPEC §16.0 list included)
  const banned = /blue shell|bullet bill|blooper|bob-?omb|mushroom|bowser|thwomp|lakitu|spiny|fire flower|boomerang|piranha|\bboo\b|\bmega\b|\bpow\b|kamek|super leaf|\bleaf\b|lucky 7|lucky seven|crazy 8|crazy eight|coin shell|thunder cloud|feather|chain chomp|yoshi|birdo|\bstar\s?man/i;
  ok(ITEM_IDS.every((id) => !banned.test(ITEM_INFO[id].name)), `original item names only (${ITEM_IDS.filter((id) => banned.test(ITEM_INFO[id].name))})`);
  // sample the roulette by place, mid-race (every start time passed, nothing in play)
  const { ks, race, items } = itemSetup(8);
  park(ks, race);
  items.update(DT, race);
  race.time = 200;
  const N = 12000;
  const hist = {};
  for (let place = 1; place <= 8; place++) {
    const h = hist[place] = Object.fromEntries(ITEM_IDS.map((id) => [id, 0]));
    for (let i = 0; i < N; i++) { items._zapBlockedUntil = -Infinity; h[items.rollFor(ks[0], place)]++; }
  }
  const pct = (place, id) => (100 * hist[place][id]) / N;
  ok([1, 2, 3, 4].every((p) => hist[p].beer_rocket === 0), `no Beer Rocket for places 1-4 (${[1, 2, 3, 4].map((p) => hist[p].beer_rocket)})`);
  ok([1, 2].every((p) => hist[p].capo === 0), 'no Capo Crusher for 1st / 2nd');
  ok(['toot', 'triple_toot', 'star', 'zap', 'golden_toot', 'espresso'].every((id) => hist[1][id] === 0), '1st never gets toots / star / zap / golden / espresso');
  ok(['banana', 'stink', 'bouncer', 'triple_banana'].every((id) => hist[8][id] === 0), '8th never gets bananas / stink / bouncers');
  // the expected shares follow the table read through ITEM_ENABLED (v4 values while every v5 item is off:
  // 8th beer 20 %, 7th 12 %, 6th 2 %, 8th golden 26 %, 1st banana 33 %, 2nd rocket 28 %)
  ok(near(pct(8, 'beer_rocket'), expPct(8, 'beer_rocket'), 2) && near(pct(7, 'beer_rocket'), expPct(7, 'beer_rocket'), 1.6) && near(pct(6, 'beer_rocket'), expPct(6, 'beer_rocket'), 0.7), `beer odds back of the pack: 6th ${pct(6, 'beer_rocket').toFixed(1)}% (${expPct(6, 'beer_rocket').toFixed(1)}), 7th ${pct(7, 'beer_rocket').toFixed(1)}% (${expPct(7, 'beer_rocket').toFixed(1)}), 8th ${pct(8, 'beer_rocket').toFixed(1)}% (${expPct(8, 'beer_rocket').toFixed(1)})`);
  ok(near(pct(8, 'golden_toot'), expPct(8, 'golden_toot'), 2) && near(pct(1, 'banana'), expPct(1, 'banana'), 2) && near(pct(2, 'rocket'), expPct(2, 'rocket'), 2), `table shape (8th golden ${pct(8, 'golden_toot').toFixed(1)}% (${expPct(8, 'golden_toot').toFixed(1)}), 1st banana ${pct(1, 'banana').toFixed(1)}% (${expPct(1, 'banana').toFixed(1)}), 2nd rocket ${pct(2, 'rocket').toFixed(1)}% (${expPct(2, 'rocket').toFixed(1)}))`);
  ok(ITEM_IDS.every((id) => itemEnabled(id) || [1, 2, 3, 4, 5, 6, 7, 8].every((p) => hist[p][id] === 0)), 'items not enabled yet never roll');
  const power = (p) => ['star', 'golden_toot', 'beer_rocket', 'capo', 'zap', 'triple_toot'].reduce((a, id) => a + pct(p, id), 0);
  ok(power(1) < power(3) && power(3) < power(5) && power(5) < power(7) && power(7) <= power(8) + 1, `power items rise toward the back (${[1, 3, 5, 7, 8].map((p) => power(p).toFixed(0)).join(' < ')})`);
  items.dispose();
}

section('items v4: start times, caps, cooldowns, place gates, far-behind shift');
{
  const { ks, race, items } = itemSetup(8);
  park(ks, race);
  items.update(DT, race);
  const seen = (place, n = 4000) => { const s = new Set(); for (let i = 0; i < n; i++) { items._zapBlockedUntil = -Infinity; s.add(items.rollFor(ks[0], place)); } return s; };
  race.time = 10;
  const early = new Set([...seen(5), ...seen(7), ...seen(8)]);
  ok(['capo', 'beer_rocket', 'golden_toot', 'zap', 'espresso', 'meatball_bomb', 'accordion', 'triple_rocket'].every((id) => !early.has(id)), `nothing nasty in the first 15 s (${[...early]})`);
  race.time = 17;
  const t17 = new Set([...seen(4), ...seen(5), ...seen(6)]);
  ok(t17.has('espresso') && !t17.has('meatball_bomb') && !t17.has('accordion') && !t17.has('capo'), 'espresso from 15 s; bombs / accordion / capo not yet');
  race.time = 25;
  const t25 = new Set([...seen(1), ...seen(2), ...seen(5), ...seen(6)]);
  ok(t25.has('meatball_bomb') && t25.has('accordion') && t25.has('triple_rocket') && !t25.has('capo') && !t25.has('beer_rocket') && !t25.has('golden_toot'), 'bomb / accordion / triple rocket from 20 s; capo / beer / golden from 30 s');
  race.time = 40;
  ok(seen(6).has('capo') && seen(8).has('beer_rocket') && seen(8).has('golden_toot'), 'capo / beer / golden after 30 s');
  // caps: one capo in play (held), two beers, two goldens, one espresso, three bombs
  ks[3].item = 'capo'; ks[3].itemCount = 1;
  ok(!seen(6, 6000).has('capo'), 'no second Capo Crusher while one is held');
  ks[3].item = null; ks[3].rolling = true; ks[3].rollItem = 'capo';
  ok(!seen(6, 6000).has('capo'), '... or rolling');
  ks[3].rolling = false; ks[3].rollItem = null;
  ks[3].item = 'beer_rocket'; ks[4].item = 'beer_rocket';
  ok(!seen(8, 6000).has('beer_rocket'), 'no third Beer Rocket while two are in play');
  ks[4].item = null;
  ok(seen(8, 6000).has('beer_rocket'), 'beer again below the cap');
  ks[3].item = 'golden_toot'; ks[4].item = 'golden_toot';
  ok(!seen(8, 6000).has('golden_toot'), 'at most two Golden Toots');
  ks[3].item = 'espresso'; ks[4].item = null;
  ok(!seen(5, 6000).has('espresso'), 'one Espresso Splash at a time');
  ks[3].item = 'meatball_bomb'; ks[4].item = 'meatball_bomb'; ks[5].item = 'meatball_bomb';
  ok(!seen(3, 6000).has('meatball_bomb'), 'at most three Meatball Bombs in play');
  for (const k of ks) { k.item = null; k.itemCount = 0; }
  // capo cooldown: 20 s after one resolves
  items._capoBlockedUntil = race.time + ITEM.capoCooldown;
  ok(!seen(6, 6000).has('capo'), 'capo cooldown');
  race.time += ITEM.capoCooldown + 0.5;
  ok(seen(6, 6000).has('capo'), 'capo after the cooldown');
  // espresso cooldown runs from the use
  placeAt(ks[2], 300, 0); ks[2].item = 'espresso'; ks[2].itemCount = 1; items.useItem(ks[2]);
  ok(!seen(5, 6000).has('espresso'), 'espresso cooldown after a use');
  race.time += ITEM.espressoCooldown + 0.5;
  ok(seen(5, 6000).has('espresso'), 'espresso again after 15 s');
  // far-behind shift (gap at 29 m/s x ccMult): none <= 8 s, +1 row at 14 s, capped at +2, never the leader
  park(ks, race);
  for (const k of ks) k.distance = 1000;
  const v = 29 * items.ccMult;
  ks[1].distance = 1000 - 7 * v;
  ok(items.farBehindShift(ks[1]) === 0, 'no shift 7 s behind');
  ks[1].distance = 1000 - 14 * v;
  ok(near(items.farBehindShift(ks[1]), 1, 1e-6), '+1 row 14 s behind');
  ks[1].distance = 1000 - 40 * v;
  ok(items.farBehindShift(ks[1]) === ITEM.farBehindMaxRows, '+2 rows max');
  ks[1].distance = 1000 - 14 * v;
  const w = items.weightsFor(ks[1], 2, new Float64Array(ITEM_IDS.length));
  ok(near(w[IDX.rocket], ITEM_TABLE[2][IDX.rocket], 1e-9) && w[IDX.capo] === 0, 'a 2nd place 14 s back reads the 3rd-place row (capo still gated by place)');
  const w1 = items.weightsFor(ks[1], 1, new Float64Array(ITEM_IDS.length));
  ok(near(w1[IDX.banana], ITEM_TABLE[0][IDX.banana], 1e-9), 'the leader is never shifted');
  items.dispose();
}

section('items v4: Banana Bunch (trailing peels)');
{
  events.length = 0;
  const { ks, race, items } = itemSetup(4);
  park(ks, race);
  const [a, b] = ks;
  placeAt(a, 300, 0, { speed: 0 });
  grant(items, a, 'triple_banana');
  const peels = () => items.attached.filter((x) => x.owner === a);
  ok(a.item === 'triple_banana' && a.itemCount === 3 && peels().length === 3 && peels().every((x) => x.type === 'banana'), 'three peels attach on pickup');
  const gaps = peels().map((x) => Math.hypot(x.position.x - a.position.x, x.position.z - a.position.z)).sort((x, y) => x - y);
  ok(near(gaps[0], ITEM.trailGaps[0], 0.15) && near(gaps[2], ITEM.trailGaps[2], 0.15), `peels trail behind (${gaps.map((g) => g.toFixed(2))})`);
  ok(peels().every((x) => track.deltaS(x.proj.s, a.proj.s) > 1.5), 'all behind the kart');
  // drive along a curve: they follow the path (stay on the road)
  let s = 300;
  for (let i = 0; i < 240; i++) { s += 20 * DT; placeAt(a, s, 2, { speed: 20 }); tick(items, race, [], 1); }
  ok(peels().every((x) => Math.abs(x.proj.lateral - 2) < 1.2), `peels follow the kart's path (laterals ${peels().map((x) => x.proj.lateral.toFixed(2))})`);
  a.input.useItem = true; items.update(DT, race);
  ok(a.itemCount === 2 && peels().length === 2 && items.hazards.filter((h) => h.type === 'banana').length === 1, 'a press drops the rearmost peel on the road');
  // a rival touching a trailing peel spins out
  const front = peels().sort((x, y) => x.gap - y.gap)[0];
  placeAt(b, front.proj.s, front.proj.lateral, { speed: 15 });
  items.update(DT, race);
  ok(b.spinTimer > 0 && a.itemCount === 1 && count('item:hit', (d) => d.kart === b && d.by === a && d.item === 'banana') === 1, 'a rival hitting a trailing peel spins (peel used up)');
  placeAt(b, 700, 0);
  // the owner hit: the last peel drops on the road, the slot empties
  const bananas = items.hazards.filter((h) => h.type === 'banana').length;
  a.spinOut('banana');
  items.update(DT, race);
  ok(!a.item && peels().length === 0 && items.hazards.filter((h) => h.type === 'banana').length === bananas + 1, 'owner hit: remaining peels fall onto the road');
  items.dispose();
}

section('items v4: Triple Bouncers / Rockets (orbiters)');
{
  events.length = 0;
  const { ks, race, items } = itemSetup(4);
  park(ks, race);
  const [a, b, c] = ks;
  placeAt(a, 300, 0, { speed: 0 });
  grant(items, a, 'triple_bouncer');
  const orb = () => items.attached.filter((x) => x.owner === a);
  ok(orb().length === 3 && orb().every((x) => near(Math.hypot(x.position.x - a.position.x, x.position.z - a.position.z), ITEM.orbitRadius, 1e-6)), 'three bouncers orbit at radius 2 m');
  const ang0 = Math.atan2(orb()[0].position.x - a.position.x, orb()[0].position.z - a.position.z);
  items.update(0.05, race);
  const ang1 = Math.atan2(orb()[0].position.x - a.position.x, orb()[0].position.z - a.position.z);
  ok(near(Math.abs(angleDiffTest(ang0, ang1)), ITEM.orbitSpeed * 0.05, 0.01), 'they circle the kart');
  // a rival alongside gets bonked by an orbiter
  const o = orb()[0];
  b.position.set(o.position.x, a.position.y, o.position.z); b.velocity.set(0, 0, 0);
  items.update(DT, race);
  ok(b.tumbleTimer > 0 && a.itemCount === 2 && count('item:hit', (d) => d.kart === b && d.by === a && d.item === 'bouncer') === 1, 'an orbiter tumbles a rival it touches');
  placeAt(b, 700, 0);
  // an incoming bouncer is blocked by an orbiter (both destroyed, owner safe): on the start straight
  placeAt(a, 60, 0, { speed: 0 });
  placeAt(c, 35, 0, { speed: 0 });
  c.item = 'bouncer'; c.itemCount = 1; items.useItem(c);
  for (let i = 0; i < 120 && items.projectiles.length; i++) items.update(DT, race);
  ok(a.tumbleTimer === 0 && a.itemCount === 1 && count('item:blocked', (d) => d.kart === a) >= 1, 'an orbiter blocks a shot from behind');
  // a press fires the remaining orbiter as a real bouncer
  a.input.useItem = true; items.update(DT, race);
  ok(!a.item && orb().length === 0 && items.projectiles.some((p) => p.type === 'bouncer' && p.owner === a), 'a press fires an orbiter');
  items.clear();
  // triple rockets home on the kart ahead
  park(ks, race);
  placeAt(c, 400, 0); placeAt(a, 300, 0); syncDistances(race, ks);
  grant(items, a, 'triple_rocket');
  a.input.useItem = true; items.update(DT, race);
  const r = items.projectiles.find((p) => p.type === 'rocket' && p.owner === a);
  ok(r && r.target && r.target !== a && a.itemCount === 2, 'a triple rocket locks on the kart ahead');
  items.dispose();
}

function angleDiffTest(a, b) { let d = (b - a + Math.PI) % (2 * Math.PI); if (d < 0) d += 2 * Math.PI; return d - Math.PI; }

// One capo scenario: shooter in 4th at s0, leader driving ahead. Returns what happened.
function capoRun({ leaderItem = null, useAt = null, bystander = false, seconds = 14 } = {}) {
  const res = { hit: null, launch: null, warnings: [], lockAt: null, phases: new Set(), blocked: false };
  const { ks, race, items } = itemSetup(5);
  park(ks, race);
  const [lead, two, three, me, by] = ks;
  let sL = 520;
  placeAt(lead, sL, 0, { speed: 24 }); placeAt(two, 470, 0.4); placeAt(three, 430, 4); placeAt(me, 330, 0); placeAt(by, 120, 0);
  syncDistances(race, ks);
  for (const k of ks) { k.invulnTimer = 0; k.frozen = false; }
  const offs = [
    bus.on('item:capoHit', (e) => { res.hit = e; }),
    bus.on('item:capoLaunch', (e) => { res.launch = e; }),
    bus.on('item:capoWarning', (e) => { res.warnings.push(e); }),
    bus.on('item:blocked', (e) => { if (e.item === 'capo') res.blocked = true; }),
  ];
  if (leaderItem) { lead.item = leaderItem; lead.itemCount = 1; }
  me.item = 'capo'; me.itemCount = 1;
  items.useItem(me);
  res.capo = items.capos[0];
  let t = 0;
  while (t < seconds && !res.hit && items.capos.length) {
    sL += 24 * DT;
    if (!lead.isDisabled()) placeAt(lead, sL, 0, { speed: 24 });
    if (bystander && res.capo && res.capo.locked) placeAt(by, sL + 3.2, 0.5, { speed: 24 });
    const c = items.capos[0];
    if (c) {
      res.phases.add(c.phase);
      if (c.locked && res.lockAt === null) res.lockAt = t;
      if (useAt && c.phase === useAt) { lead.input.useItem = true; useAt = null; }
    }
    items.update(DT, race); race.update(DT);
    t += DT;
  }
  res.t = t;
  res.lead = lead; res.by = by; res.me = me; res.items = items; res.race = race;
  res.tumble = lead.tumbleTimer;
  for (const off of offs) off();
  return res;
}

section('items v4: Capo Crusher');
{
  events.length = 0;
  const R = capoRun();
  ok(R.launch && R.launch.target === R.lead && R.warnings[0] && R.warnings[0].target === R.lead && !R.warnings[0].locked, 'launch targets 1st and warns it');
  ok(['ground', 'rise', 'orbit', 'windup', 'dive'].every((p) => R.phases.has(p)), `ground -> rise -> orbit -> windup -> dive (${[...R.phases]})`);
  ok(R.warnings.some((w) => w.locked && w.target === R.lead), 'warns again at lock-on');
  ok(R.hit && R.hit.kart === R.lead && R.hit.hit && !R.hit.dodged, `slams the leader (${R.t.toFixed(2)} s)`);
  ok(R.tumble > HIT.tumbleDuration + 0.3 && Math.hypot(R.lead.velocity.x, R.lead.velocity.z) < 24 * HIT.capoSpeedKeep + 0.5, `big tumble (${R.tumble.toFixed(2)} s) and stopped in place`);
  ok(count('item:explode', (d) => d.item === 'capo' && d.hit) === 1 && R.items.capos.length === 0, 'explosion, capo gone');
  ok(R.lockAt !== null && R.t - R.lockAt > 1.7 && R.t - R.lockAt < 3.2, `lock-on to slam ${(R.t - R.lockAt).toFixed(2)} s`);
  ok(R.items._capoBlockedUntil > R.race.time + ITEM.capoCooldown - 0.1, 'cooldown starts at the slam');
  // karts in the ground path are knocked over (not the target)
  ok(count('item:hit', (d) => d.item === 'capo' && d.kart !== R.lead) >= 1, `karts in its path are hit too (${count('item:hit', (d) => d.item === 'capo' && d.kart !== R.lead)})`);
  R.items.dispose();
  // an Accordion Blast destroys it in the orbit phase
  const A = capoRun({ leaderItem: 'accordion', useAt: 'orbit' });
  ok(!A.hit && A.blocked && A.items.capos.length === 0 && A.lead.tumbleTimer === 0, 'accordion destroys the capo while it circles');
  A.items.dispose();
  // a toot in the wind-up spares the target; a bystander 3 m away still spins
  events.length = 0;
  const D = capoRun({ leaderItem: 'toot', useAt: 'windup', bystander: true });
  ok(D.hit && D.hit.dodged && !D.hit.hit && D.lead.tumbleTimer === 0, 'boost in the wind-up dodges the slam');
  ok(D.by.spinTimer > 0 && count('kart:spin', () => true) >= 0, 'the blast still spins a bystander');
  D.items.dispose();
}

section('items v4: Golden Toot');
{
  events.length = 0;
  const { ks, race, items } = itemSetup(2);
  park(ks, race);
  const a = ks[0];
  grant(items, a, 'golden_toot');
  ok(a.item === 'golden_toot' && a.goldenTimer === 0, 'held, window not started');
  a.input.useItem = true; items.update(DT, race);
  ok(near(a.goldenTimer, ITEM.goldenTime, 1e-6) && near(a.boostTimer, BOOST.tootDuration, 1e-6) && a.item === 'golden_toot', 'first press: 7.5 s window + toot boost, item stays');
  for (let i = 0; i < 6; i++) items.update(DT, race);
  a.input.useItem = true; items.update(DT, race);
  ok(count('item:use', (e) => e.item === 'golden_toot') === 1, 'a press within 0.15 s is ignored');
  for (let i = 0; i < 30; i++) { items.update(DT, race); a.update(DT); }
  a.input.useItem = true; items.update(DT, race);
  ok(count('item:use', (e) => e.item === 'golden_toot') === 2 && a.boostTimer <= BOOST.tootDuration + 1e-6 && a.boostTimer > BOOST.tootDuration - 0.02, 'later presses refresh the boost without stacking');
  for (let i = 0; i < Math.ceil(ITEM.goldenTime * 120); i++) items.update(DT, race);
  ok(!a.item && a.goldenTimer === 0 && items.used.golden_toot === 1, 'slot clears when the window ends (one use counted)');
  items.dispose();
}

section('items v4: Meatball Bomb');
{
  events.length = 0;
  const { ks, race, items } = itemSetup(4);
  park(ks, race);
  const [a, b, c, d] = ks;
  placeAt(a, 30, 0, { speed: 20 });
  a.item = 'meatball_bomb'; a.itemCount = 1; items.useItem(a);
  placeAt(a, 900, 0);
  const bomb = items.bombs[0];
  ok(bomb && bomb.phase === 'air', 'thrown in an arc');
  let landed = null, t = 0;
  while (t < 2 && bomb.phase === 'air') { items.update(DT, race); t += DT; }
  landed = track.deltaS(30, bomb.proj.s);
  ok(bomb.phase !== 'air' && landed > 12 && landed < 30, `lands ${landed.toFixed(1)} m ahead`);
  // rivals near / farther from where it rests
  for (let i = 0; i < 120; i++) items.update(DT, race);
  ok(bomb.phase === 'rest' && bomb.active, 'rolls to a stop on the road');
  placeAt(b, bomb.proj.s + 3, bomb.proj.lateral); placeAt(c, bomb.proj.s - 6.5, bomb.proj.lateral); placeAt(d, bomb.proj.s + 15, 0);
  for (const k of [b, c, d]) k.invulnTimer = 0;
  let boomT = null;
  const off = bus.on('item:bombExplode', () => { boomT = t; });
  while (t < 6 && bomb.active) { items.update(DT, race); t += DT; }
  off();
  ok(boomT !== null && count('item:explode', (e) => e.item === 'meatball_bomb') === 1, `fuse goes off (${boomT && boomT.toFixed(2)} s after the throw)`);
  ok(b.tumbleTimer > 0 && c.spinTimer > 0 && c.tumbleTimer === 0 && d.spinTimer === 0 && d.tumbleTimer === 0, 'core tumbles, ring spins, far kart safe');
  // contact: driving into a dropped bomb (brake held = dropped behind)
  park(ks, race);
  placeAt(a, 200, 0, { speed: 10 });
  a.input.brake = 1; a.item = 'meatball_bomb'; a.itemCount = 1; items.useItem(a); a.input.brake = 0;
  const b2 = items.bombs[0];
  ok(b2 && b2.phase === 'rest' && track.deltaS(b2.proj.s, 200) > 1.5, 'brake held: dropped behind');
  placeAt(a, 600, 0);
  b.tumbleTimer = 0; b.spinTimer = 0; b.invulnTimer = 0;
  placeAt(b, b2.proj.s - 6, b2.proj.lateral, { speed: 20 });
  let sB = b2.proj.s - 6;
  for (let i = 0; i < 60 && b2.active; i++) { sB += 20 * DT; placeAt(b, sB, b2.proj.lateral, { speed: 20 }); items.update(DT, race); }
  ok(!b2.active && b.tumbleTimer > 0, 'contact sets it off');
  items.dispose();
}

section('items v4: Espresso Splash');
{
  events.length = 0;
  const { ks, race, items } = itemSetup(5);
  park(ks, race);
  const [a, b, c, d, e] = ks;
  placeAt(a, 500, 0); placeAt(b, 480, 0); placeAt(c, 460, 0); placeAt(d, 440, 0); placeAt(e, 420, 0);
  syncDistances(race, ks);
  b.startStar();
  d.item = 'espresso'; d.itemCount = 1; items.useItem(d);
  const ev = events.find((x) => x.type === 'item:espresso');
  ok(ev && ev.data.kart === d && ev.data.victims.length === 2 && ev.data.victims.includes(a) && ev.data.victims.includes(c), 'everyone ahead except the starred kart is splashed');
  for (let i = 0; i < 36; i++) items.update(DT, race);
  ok(a.ink === 0 && a.inkIncoming && e.ink === 0 && !e.inkIncoming, 'cup in flight first (0.6 s)');
  for (let i = 0; i < 48; i++) items.update(DT, race);
  ok(a.ink === 1 && !a.inkIncoming && count('item:espressoSplash', (x) => x.kart === a) === 1, 'then full splash');
  a.input.steer = 1; items.update(DT, race);
  ok(near(a.input.steer, ITEM.espressoSteerMult, 1e-9), 'lighter touch on the wheel');
  items.update(DT, race);
  ok(near(a.input.steer, ITEM.espressoSteerMult, 1e-9), '... not compounded within a frame');
  const top = a.maxSpeed;
  a.velocity.set(Math.sin(a.yaw) * top, 0, Math.cos(a.yaw) * top);
  items.update(DT, race);
  ok(Math.hypot(a.velocity.x, a.velocity.z) <= top * ITEM.espressoSpeedMult + 1e-6, 'a touch slower');
  // a pad / item boost washes it off; the other victim keeps it until it fades
  a.applyBoost(1, 'pad');
  for (let i = 0; i < 60; i++) items.update(DT, race);
  ok(a.ink === 0 && c.ink > 0.9, 'a boost washes the coffee off early');
  for (let i = 0; i < 4 * 120; i++) items.update(DT, race);
  ok(c.ink === 0 && !c.inkIncoming, 'gone after 4.5 s');
  items.dispose();
}

section('items v4: Accordion Blast');
{
  events.length = 0;
  const { ks, race, items } = itemSetup(4);
  park(ks, race);
  const [a, b, c, d] = ks;
  placeAt(a, 300, 0); placeAt(b, 305, 2); placeAt(c, 312, -2); placeAt(d, 320, 0);
  for (const k of ks) k.invulnTimer = 0;
  // items around: a peel 6 m ahead, a bouncer 9 m away, a peel 20 m away
  d.item = 'banana'; d.itemCount = 1; items.useItem(d);            // dropped ~17.8 m ahead of a
  placeAt(d, 700, 0);
  const far = items.hazards[0];
  items._dropHazard(c, 'banana', track.pointAt(306, -3));
  placeAt(c, 312, -2);
  c.yaw += Math.PI; c.item = 'bouncer'; c.itemCount = 1; items.useItem(c); c.yaw -= Math.PI;
  a.item = 'accordion'; a.itemCount = 1; items.useItem(a);
  ok(b.spinTimer > 0 && c.spinTimer === 0 && count('item:accordion', (x) => x.kart === a && x.hits === 1) === 1, 'spins karts within 8 m only');
  ok(items.projectiles.length === 0 && items.hazards.length === 1 && items.hazards[0] === far, 'destroys items within 12 m (not beyond)');
  items.dispose();
}

section('items v4: Beer Rocket (8th place, real CPU field)');
{
  for (const trackId of ['breezy', 'monte']) {
    const tr = getTrack(trackId);
    events.length = 0;
    const ks = CHARACTERS.slice(0, 8).map((c) => new Kart({ id: c.id, character: c, track: tr }));
    ks.forEach((k, i) => k.placeOnGrid(tr.gridSlot(i)));
    const race = new Race({ track: tr, karts: ks, laps: 3 });
    const items = new ItemSystem({ track: tr, karts: ks, scene: null, rng: makeRng(7) });
    const drivers = createAIDrivers(ks, { track: tr, difficulty: 'normal', rng: makeRng(3) });
    const ctx = { karts: ks, items, race };
    race.skipIntro();
    let t = 0;
    const rider = ks[7];
    const stepAll = () => { for (const d of drivers) d.update(DT, ctx); items.update(DT, race); for (const k of ks) k.update(DT); resolveKartCollisions(ks); race.update(DT); t += DT; };
    while (race.state !== 'racing') stepAll();
    // a few seconds of racing, then the last kart gets a beer
    while (t < 12) stepAll();
    const last = race.standings[race.standings.length - 1];
    last.item = 'beer_rocket'; last.itemCount = 1;
    const startPlace = race.getPlace(last);
    let start = null, ride = null, end = null, maxV = 0, offRoad = 0, invOk = true, knocked = 0, gained = 0;
    const offs = [
      bus.on('item:beerStart', (e) => { if (e.kart === last) start = t; }),
      bus.on('item:beerRide', (e) => { if (e.kart === last) ride = t; }),
      bus.on('item:beerEnd', (e) => { if (e.kart === last) { end = t; gained = e.gained; } }),
      bus.on('item:hit', (e) => { if (e.by === last && e.item === 'beer_rocket') knocked++; }),
    ];
    last.input.useItem = true;
    items.useItem(last);
    while (t < 40 && end === null) {
      stepAll();
      if (last.beer) {
        maxV = Math.max(maxV, Math.hypot(last.velocity.x, last.velocity.z));
        if (Math.abs(last.proj.lateral) > last.proj.halfWidth + 1.0) offRoad++;
        if (!last.isInvincible()) invOk = false;
      }
    }
    for (const off of offs) off();
    const rideT = end - ride;
    ok(start !== null && ride !== null && near(ride - start, ITEM.beerChug, 0.02), `${trackId}: chug ${(ride - start).toFixed(2)} s, then the ride`);
    ok(end !== null && rideT >= ITEM.beerMinTime - 1e-6 && rideT <= ITEM.beerHardMax + 0.02, `${trackId}: ride ${rideT.toFixed(2)} s (min ${ITEM.beerMinTime}, hard max ${ITEM.beerHardMax})`);
    ok(gained >= 3 && race.getPlace(last) <= startPlace - 3, `${trackId}: from ${startPlace}th it gained ${gained} places`);
    ok(maxV > 1.6 * last.stats.topSpeed, `${trackId}: top ride speed ${maxV.toFixed(1)} m/s (${(maxV / last.stats.topSpeed).toFixed(2)}x)`);
    ok(offRoad === 0 && invOk, `${trackId}: stays on the road, invincible all the way`);
    ok(!last.beer && !last.item && last.invulnTimer > 0 && last.starTimer === 0 && last.boostTimer > 0, `${trackId}: pops out with a boost + grace, slot free`);
    ok(ks.every((k) => isFinite(k.position.x) && isFinite(k.position.z)), `${trackId}: no NaN (knocked ${knocked})`);
    items.dispose();
  }
}

section('ai v4: CPU usage of the new items');
{
  const ks = makeKarts(4);
  const race = new Race({ track, karts: ks, laps: 3 });
  race.skipIntro(); step(race, 361);
  const items = new ItemSystem({ track, karts: ks, scene: null, rng: makeRng(2) });
  const [a, b, c, d] = ks;
  placeAt(a, 400, 0); placeAt(b, 380, 0); placeAt(c, 300, 0); placeAt(d, 250, 0);
  syncDistances(race, ks);
  const ai = new AIDriver(c, { track, difficulty: 'hard', skill: 0.9, rng: makeRng(4) });
  const lead = new AIDriver(a, { track, difficulty: 'hard', skill: 0.9, rng: makeRng(5) });
  const ctx = { karts: ks, items, race };
  ok(ai._shouldUse('capo', ctx, c.proj.s, 20) && !lead._shouldUse('capo', ctx, a.proj.s, 20), 'capo fired when not 1st, held in the lead');
  ok(ai._shouldUse('espresso', ctx, c.proj.s, 20) && !lead._shouldUse('espresso', ctx, a.proj.s, 20), 'espresso when not 1st');
  ok(ai._shouldUse('beer_rocket', ctx, c.proj.s, 20), 'beer rocket at once');
  c.lap = 3; c.distance = 3 * track.length - 80;
  ok(!ai._shouldUse('beer_rocket', ctx, c.proj.s, 20), '... but not right before the finish');
  syncDistances(race, ks);
  ok(!ai._shouldUse('accordion', ctx, c.proj.s, 20), 'accordion held with nobody around');
  placeAt(b, 304, 2); placeAt(d, 297, -2);
  ok(ai._shouldUse('accordion', ctx, c.proj.s, 20), 'accordion with two rivals close');
  items.dispose();
}

section('ai v4: CPUs time the passes under the palace hazards (SPEC §15.3)');
{
  // A full 3-lap CPU race on Krishiv's Palace with the course hazards applied
  // like main.js stepHazards, once with ctx.hazards (the CPUs see them) and
  // once without (blind): the CPUs must dodge most of them. v5 (SPEC §16.1):
  // results go through the v5 effect mapping (hazardEffect / applyHazardHit:
  // a knock or a slow is a bump, not a hit), and since the palace gained
  // set-piece rooms the bound is per hard room (hazards that spin / tumble,
  // grouped like track-check: < 60 m apart): <= 0.0875 hits per kart-lap and
  // room (the v4 bound, 0.35 for its 4 rooms).
  const tr = getTrack('palace');
  const hz0 = createHazards(tr);
  const HARD = new Set(['crusher', 'flamearm', 'geyser', 'curtain', 'portcullis']);
  let rooms = 0, lastS = -Infinity;
  for (const h of hz0.list.filter((x) => HARD.has(x.type)).sort((a, b) => a.s - b.s)) { if (h.s - lastS >= 60) rooms++; lastS = h.s; }
  const bound = 0.0875 * Math.max(4, rooms);
  const run = (see) => {
    const ks = CHARACTERS.slice(0, 8).map((c) => new Kart({ id: c.id, character: c, track: tr }));
    ks.forEach((k, i) => k.placeOnGrid(tr.gridSlot(i)));
    const race = new Race({ track: tr, karts: ks, laps: 3 });
    const items = new ItemSystem({ track: tr, karts: ks, scene: null, rng: makeRng(11), enabled: false });
    const drivers = createAIDrivers(ks, { track: tr, difficulty: 'normal', rng: makeRng(5) });
    const hz = createHazards(tr);
    const ctx = { karts: ks, items, race, hazards: see ? hz : null };
    race.skipIntro();
    let t = 0, hits = 0;
    while (t < 240 && !ks.every((k) => k.finished)) {
      for (const d of drivers) d.update(DT, ctx);
      items.update(DT, race);
      for (const k of ks) k.update(DT);
      resolveKartCollisions(ks);
      hz.update(DT);
      if (hz.fx) hz.fx.clock += DT;                 // knock / slow cooldowns run on the hazard clock (as stepCourseHazards)
      if (race.state === 'racing') {
        for (const k of ks) {
          const kind = hz.check(k);
          if (!kind || k.isInvincible()) continue;
          const e = hazardEffect(kind);
          if (e.effect === 'tumble' || e.effect === 'spin') { if ((e.effect === 'tumble' ? k.tumble(e.type) : k.spinOut(e.type)) !== false) hits++; }
          else applyHazardHit(k, kind, hz);
        }
      }
      race.update(DT);
      t += DT;
    }
    items.dispose();
    return { hits, perLap: hits / (ks.length * 3), done: ks.every((k) => k.finished) };
  };
  const seen = run(true), blind = run(false);
  console.log(`  palace course-hazard hits, 8 CPUs x 3 laps: seeing ${seen.hits} (${seen.perLap.toFixed(2)}/kart-lap), blind ${blind.hits} (${blind.perLap.toFixed(2)}/kart-lap)`);
  ok(hz0.list.length >= 8, `palace has course hazards (${hz0.list.length})`);
  ok(seen.done && blind.done, 'both races finish');
  ok(seen.perLap <= bound, `CPUs that see the hazards: ${seen.hits} hits (${seen.perLap.toFixed(2)} per kart-lap, <= ${bound.toFixed(2)} for ${rooms} hard rooms)`);
  ok(blind.hits >= 2 * Math.max(1, seen.hits), `... far fewer than blind CPUs (${blind.hits} hits, ${blind.perLap.toFixed(2)} per kart-lap)`);
}

// ---------------------------------------------------------------- v5 extension points (SPEC §16)
section('items v5: 40-item table, ITEM_ENABLED, ITEM_RULES (SPEC §16.2)');
{
  ok(ITEM_IDS.every((id, i) => ITEM_TABLE.some((r) => r[i] > 0)), 'every item has a non-zero weight in some row');
  ok(Object.keys(ITEM_RULES).every((id) => ITEM_IDS.includes(id) && !NATIVE_ITEM_IDS.includes(id)), 'ITEM_RULES only for v5 ids');
  ok(Object.keys(ITEM_ENABLED).every((id) => ITEM_IDS.includes(id) && !NATIVE_ITEM_IDS.includes(id)) && NATIVE_ITEM_IDS.every((id) => itemEnabled(id)), 'ITEM_ENABLED: v5 ids only, every v4 item enabled');
  ok(COIN.max === 10 && COIN.speedPerCoin > 0 && COIN.lossHit === 2 && COIN.lossFall === 3, 'COIN constants');
  ok(ITEM5.platter.length === 8 && ITEM5.platter.every((id) => ITEM_IDS.includes(id)), 'antipasto platter lists real ids');
  // switch every v5 item on (what the item agents do one by one) and sample the roulette
  const saved = { ...ITEM_ENABLED };
  for (const id of Object.keys(ITEM_ENABLED)) ITEM_ENABLED[id] = true;
  try {
    const { ks, race, items } = itemSetup(8);
    park(ks, race);
    items.update(DT, race);
    race.time = 200;
    const N = 20000, hist = {}, all = new Set();
    for (let place = 1; place <= 8; place++) {
      const h = hist[place] = Object.fromEntries(ITEM_IDS.map((id) => [id, 0]));
      for (let i = 0; i < N; i++) { items._zapBlockedUntil = -Infinity; const id = items.rollFor(ks[0], place); h[id]++; all.add(id); }
    }
    const pct = (place, id) => (100 * hist[place][id]) / N;
    ok(ITEM_IDS.every((id) => all.has(id)), `all ${ITEM_IDS.length} items roll somewhere (missing: ${ITEM_IDS.filter((id) => !all.has(id))})`);
    let worst = 0, worstAt = '';
    for (let place = 1; place <= 8; place++) {
      for (const id of ITEM_IDS) { const d = Math.abs(pct(place, id) - expPct(place, id)); if (d > worst) { worst = d; worstAt = `${id} @${place}`; } }
    }
    ok(worst <= 2, `roulette shape within ±2 % of ITEM_TABLE (worst ${worst.toFixed(2)} at ${worstAt})`);
    // research-v5-items.md §C3 assertion updates (every v5 item on)
    ok(near(pct(8, 'beer_rocket'), 17, 2) && near(pct(7, 'beer_rocket'), 9, 1.5) && near(pct(6, 'beer_rocket'), 1, 0.5)
      && near(pct(8, 'golden_toot'), 22, 2) && near(pct(1, 'banana'), 21, 2) && near(pct(2, 'rocket'), 20, 2) && near(pct(1, 'lira_purse'), 14, 2),
    `v5 shares: 8th beer ${pct(8, 'beer_rocket').toFixed(1)}, 7th ${pct(7, 'beer_rocket').toFixed(1)}, 6th ${pct(6, 'beer_rocket').toFixed(1)}, 8th golden ${pct(8, 'golden_toot').toFixed(1)}, 1st banana ${pct(1, 'banana').toFixed(1)}, 2nd rocket ${pct(2, 'rocket').toFixed(1)}, 1st purse ${pct(1, 'lira_purse').toFixed(1)}`);
    ok(['toot', 'triple_toot', 'star', 'zap', 'golden_toot', 'espresso'].every((id) => hist[1][id] === 0) && ['banana', 'stink', 'bouncer', 'triple_banana'].every((id) => hist[8][id] === 0), 'v4 place rules still hold with every v5 item on');
    const power = (p) => ['star', 'golden_toot', 'beer_rocket', 'capo', 'zap', 'triple_toot', 'mortadella', 'antipasto', 'ladro', 'padella', 'befana'].reduce((a, id) => a + pct(p, id), 0);
    ok(power(1) < power(3) && power(3) < power(5) && power(5) < power(7) && power(7) <= power(8) + 1, `power items (v4 + v5) rise toward the back (${[1, 3, 5, 7, 8].map((p) => power(p).toFixed(0)).join(' < ')})`);
    // the rules, per ITEM_RULES entry, at the place where the item is most common
    const rolls = (place, n = 4000, id) => { let c = 0; for (let i = 0; i < n; i++) { items._zapBlockedUntil = -Infinity; if (items.rollFor(ks[0], place) === id) c++; } return c; };
    const bad = [];
    for (const [id, r] of Object.entries(ITEM_RULES)) {
      let place = 1;
      for (let p = 1; p <= 8; p++) if (ITEM_TABLE[p - 1][IDX[id]] > ITEM_TABLE[place - 1][IDX[id]]) place = p;
      race.time = 200;
      if (!(rolls(place, 4000, id) > 0)) bad.push(`${id}: never rolls at ${place}`);
      if (r.freeTime) {
        race.time = r.freeTime - 0.5;
        if (rolls(place, 4000, id) > 0) bad.push(`${id}: rolled before ${r.freeTime} s`);
        race.time = r.freeTime + 0.5;
        if (!(rolls(place, 4000, id) > 0)) bad.push(`${id}: not after ${r.freeTime} s`);
        race.time = 200;
      }
      if (r.max) {
        for (let i = 1; i <= r.max; i++) { ks[i].item = id; ks[i].itemCount = 1; }
        if (rolls(place, 4000, id) > 0) bad.push(`${id}: rolled with ${r.max} in play`);
        for (let i = 1; i <= r.max; i++) { ks[i].item = null; ks[i].itemCount = 0; }
      }
      if (r.cooldown) {
        items.pluginContext(id).startCooldown();
        if (!(items._blockedUntil[id] > race.time) || rolls(place, 4000, id) > 0) bad.push(`${id}: rolled during its cooldown`);
        race.time += r.cooldown + 0.5;
        if (!(rolls(place, 4000, id) > 0)) bad.push(`${id}: not after its cooldown`);
        race.time = 200;
      }
      // place gates: give the gated place a weight and the gate must still zero it
      for (const gp of [r.minPlace ? r.minPlace - 1 : 0, r.maxPlace ? r.maxPlace + 1 : 0]) {
        if (!(gp >= 1 && gp <= 8)) continue;
        const keep = ITEM_TABLE[gp - 1][IDX[id]];
        ITEM_TABLE[gp - 1][IDX[id]] = 5;
        const w = items.weightsFor(ks[0], gp, new Float64Array(ITEM_IDS.length));
        ITEM_TABLE[gp - 1][IDX[id]] = keep;
        if (w[IDX[id]] !== 0) bad.push(`${id}: gate open at place ${gp}`);
      }
    }
    ok(!bad.length, `every ITEM_RULES entry holds: free time, max in play, cooldown, place gates (${bad.join('; ')})`);
    race.time = 10;
    const early = new Set();
    for (const p of [2, 4, 5, 7, 8]) for (let i = 0; i < 3000; i++) early.add(items.rollFor(ks[0], p));
    const nasty = Object.entries(ITEM_RULES).filter(([, r]) => r.freeTime > 15).map(([id]) => id);
    ok(nasty.every((id) => !early.has(id)), `no v5 item with a start lock > 15 s in the first 15 s (${nasty.filter((id) => early.has(id))})`);
    items.dispose();
  } finally {
    for (const id of Object.keys(saved)) ITEM_ENABLED[id] = saved[id];
  }
}

section('items v5: plugin registry, PluginContext, entities, aiUse (SPEC §16.2)');
{
  ok(ITEM_IDS.filter((id) => !isNativeItem(id)).every((id) => getItemHandler(id) && typeof getItemHandler(id).use === 'function'), 'a registered handler for every v5 item');
  ok(NATIVE_ITEM_IDS.every((id) => !getItemHandler(id) && isNativeItem(id)) && itemHandlers().length === ITEM_IDS.length - NATIVE_ITEM_IDS.length, 'native items have no handler');
  ok(itemSystems().some(([n]) => n === 'coins'), 'the coins item system is registered');
  let threw = 0;
  for (const args of [['banana', {}], ['nope', {}], ['Bad Id', {}], ['taralli', null]]) { try { registerItem(...args); } catch { threw++; } }
  ok(threw === 4, 'registerItem rejects native / unknown / malformed ids and a missing handler');
  // a stub: a safe no-op that consumes the press and warns once
  {
    const { ks, race, items } = itemSetup(4);
    park(ks, race);
    const warn = console.warn;
    let warns = 0;
    console.warn = () => { warns++; };
    let used1, used2;
    try {
      ks[0].item = 'befana'; ks[0].itemCount = 1; used1 = items.useItem(ks[0]);
      ks[1].item = 'befana'; ks[1].itemCount = 1; used2 = items.useItem(ks[1]);
    } finally { console.warn = warn; }
    ok(used1 && used2 && !ks[0].item && !ks[1].item && warns <= 1 && items.used.befana === 2, `stub use: consumed, no-op, warns once (${warns})`);
    items.dispose();
  }
  // a test handler on a v5 id (the stub is restored afterwards)
  const ID = 'taralli', orig = getItemHandler(ID);
  const log = [];
  const H = registerItem(ID, {
    init(ctx) { ctx.state.inits = (ctx.state.inits || 0) + 1; },
    onGet() { log.push('get'); },
    use(ctx, k) {
      ctx.state.uses = (ctx.state.uses || 0) + 1;
      ctx.state.last = ctx.spawn({ kind: 'hoop', owner: k, life: 2, radius: 1.5, threat: true, clear: 2.5, counts: true });
      return true;
    },
    update(ctx) { ctx.state.updates = (ctx.state.updates || 0) + 1; },
    onEntityRemove(ctx, e, reason) { log.push(`remove:${reason}`); },
    onKartHit(ctx, k) { log.push(`kartHit:${k.id}`); },
    countLive(ctx) { return ctx.state.extraLive || 0; },
    clear() { log.push('clear'); },
    dispose() { log.push('dispose'); },
    aiUse(kart, c) { return c.hold > 0.5 ? { use: true, brake: true } : false; },
    callout: 'HOOPED!',
  });
  try {
    const { ks, race, items } = itemSetup(4);
    park(ks, race);
    const [a, b, c, d] = ks;
    const ctx = items.pluginContext(ID);
    ok(ctx && ctx.state.inits === 1 && ctx.id === ID && ctx.info === ITEM_INFO[ID] && ctx.track === track && ctx.scene === null, 'init once per ItemSystem; ctx: id, info, state, track, no scene headless');
    ok(items.giveItem(a, ID) && a.item === ID && log.includes('get') && !items.giveItem(a, 'banana'), 'giveItem → onGet; a full slot refuses');
    placeAt(a, 300, 0);
    syncDistances(race, ks);
    ok(items.useItem(a) && !a.item && ctx.state.uses === 1 && items.entities.length === 1, 'use dispatched to the handler, one use consumed');
    const e = ctx.state.last;
    ok(e.active && e.item === ID && e.kind === 'hoop' && e.owner === a && Math.abs(track.deltaS(a.proj.s, e.s) - ITEM_TUNE.launchAhead) < 0.3, 'ctx.spawn: entity at the nose, projected on the track');
    ok(items._countOf(ID) === 1, 'counts: true entities count as in play');
    ctx.state.extraLive = 2;
    ok(items._countOf(ID) === 3, 'countLive adds to the in-play count');
    ctx.state.extraLive = 0;
    placeAt(b, 280, 0);
    const th = items.getThreatsNear(b, 40).find((t) => t.ref === e);
    ok(th && th.type === 'hoop' && th.item === ID && th.clear === 2.5 && th.ahead, 'threat entities are listed for the AI with their clear distance');
    const u0 = ctx.state.updates || 0;
    for (let i = 0; i < 120; i++) items.update(DT, race);
    ok(ctx.state.updates - u0 === 120, 'update hook every substep');
    for (let i = 0; i < 130; i++) items.update(DT, race);
    ok(!e.active && items.entities.length === 0 && log.includes('remove:expire'), 'an entity leaves at its life (onEntityRemove "expire")');
    // the accordion destroys a rival's entities nearby, not sturdy ones
    park(ks, race);
    placeAt(c, 300, 0);
    const e1 = ctx.spawn({ owner: b, position: track.pointAt(305, 0), radius: 1 });
    const e2 = ctx.spawn({ owner: b, position: track.pointAt(306, 2), radius: 1, sturdy: true });
    c.item = 'accordion'; c.itemCount = 1; items.useItem(c);
    ok(!e1.active && e2.active && log.includes('remove:blocked'), 'accordion destroys plugin entities nearby (a sturdy one survives)');
    ctx.remove(e2, 'test');
    // a solid entity stops a native bouncer (both gone), on a straight
    park(ks, race);
    const st = track.segments.find((g) => g.type === 'straight' && g.s1 - g.s0 > 60 && g.s1 < 480);
    placeAt(d, st.s0 + 5, 0);
    const wall = ctx.spawn({ owner: b, position: track.pointAt(st.s0 + 20, 0), radius: 1.2, solid: true });
    d.item = 'bouncer'; d.itemCount = 1; items.useItem(d);
    for (let i = 0; i < 60; i++) items.update(DT, race);
    ok(!wall.active && items.projectiles.length === 0, 'a solid entity blocks a native bouncer');
    // ctx.hit: immunity, v5 effect fallback, item:hit, onKartHit
    park(ks, race);
    b.startStar();
    ok(!ctx.hit(b, 'spin', { by: a }), 'ctx.hit: a starred kart is immune');
    b.starTimer = 0;
    const hits0 = count('item:hit', (x) => x.item === ID);
    // (kart.freeze exists since v5 group B: the effect reaches it; a kart without it would spin out)
    ok(ctx.hit(c, 'freeze', { by: a, light: true }) && (typeof c.freeze === 'function' ? c.iceTimer > 0 : c.spinTimer > 0) && count('item:hit', (x) => x.item === ID && x.effect === 'freeze' && x.light && x.by === a) === hits0 + 1,
      'ctx.hit freeze reaches kart.freeze (spin-out fallback without it); item:hit { effect, light, by }');
    ok(!ctx.hit(c, 'tumble'), 'already spinning: not hittable');
    items.update(DT, race);
    ok(log.includes(`kartHit:${c.id}`), 'onKartHit when a kart gets disabled');
    ok(ctx.touches(d, d.position, 0.1) && ctx.kartsTouching(d.position, 0.5).includes(d), 'contact helpers');
    ctx.startCooldown(5);
    ok(Math.abs(items._blockedUntil[ID] - (race.time + 5)) < 1e-9, 'ctx.startCooldown stamps the rule clock');
    park(ks, race);
    a.item = null;
    const nb = items.hazards.length;
    ok(ctx.activate(a, 'banana') && items.hazards.length === nb + 1 && !a.item, 'ctx.activate runs a native effect without a slot');
    // a throwing hook is isolated and counted
    const up = H.update;
    H.update = () => { throw new Error('test'); };
    const err = console.error;
    console.error = () => {};
    try { items.update(DT, race); items.update(DT, race); } finally { console.error = err; H.update = up; }
    ok(items.pluginErrors === 2, `a throwing hook is isolated (items.pluginErrors ${items.pluginErrors})`);
    // AI: aiUse decides the press (and the brake)
    {
      const ai = new AIDriver(d, { track, difficulty: 'hard', skill: 0.9, rng: makeRng(3) });
      d.item = ID; d.itemCount = 1; d.rolling = false; d.input.brake = 0;
      const actx = { karts: ks, items, race };
      let used = false, braked = false;
      for (let i = 0; i < 900 && !used; i++) { d.input.useItem = false; ai._items(DT, actx, d.proj.s, 20); if (d.input.useItem) { used = true; braked = d.input.brake === 1; } }
      ok(used && braked && ai.itemHold > 0.5, `aiUse decides the CPU press + brake (at ${ai.itemHold.toFixed(2)} s held)`);
      ok(ai._aiCtx && ai._aiCtx.plugin === ctx && typeof ai._aiCtx.rivalAhead === 'function' && ai._aiCtx.kart === d, "aiUse ctx carries the item's PluginContext + helpers");
    }
    ctx.spawn({ owner: a, position: track.pointAt(320, 0) });
    items.clear();
    ok(items.entities.length === 0 && log.includes('clear') && log.includes('remove:clear'), 'clear(): entities removed, clear hook');
    items.dispose();
    ok(log.includes('dispose'), 'dispose hook');
  } finally {
    registerItem(ID, orig);
  }
}

section('hazards v5: registry by theme, effect mapping, kinds (SPEC §16.1)');
{
  ok(['bay', 'hilltown', 'campus', 'beach', 'castle'].every((t) => HAZARD_THEMES.includes(t)), 'a hazards module per theme');
  const API = ['update', 'setTime', 'reset', 'stateAt', 'check', 'hitAt', 'hitAtWorld', 'ahead', 'hitOne'];
  for (const id of ['breezy', 'monte', 'aldrich', 'laguna', 'palace']) {
    const tr = getTrack(id), hz = createHazardsRegistry(tr);
    ok(hz.list.length === (tr.def.hazards || []).length && API.every((f) => typeof hz[f] === 'function') && hz.theme === tr.theme,
      `${id}: the ${tr.theme} set, ${hz.list.length} hazard(s), full interface`);
  }
  ok(createHazards === createHazardsRegistry, 'hazards.js createHazards is the registry');
  ok(hazardEffect('crush').effect === 'tumble' && hazardEffect('fire').effect === 'spin' && hazardEffect('knock').effect === 'knock'
    && hazardEffect('splash').effect === 'spin' && hazardEffect({ type: 'crab', effect: 'knock', strength: 0.5 }).strength === 0.5
    && hazardEffect({ effect: 'slow' }).type === 'slow' && hazardEffect(null) === null, 'hazardEffect normalises strings and objects');
  const pal = createHazardsRegistry(getTrack('palace'));
  const ks = makeKarts(4);
  const [a, b, c] = ks;
  const causes = [];
  const offs = [bus.on('kart:tumble', (e) => causes.push(`t:${e.cause}`)), bus.on('kart:spin', (e) => causes.push(`s:${e.cause}`)), bus.on('kart:knock', (e) => causes.push(`k:${e.cause}`))];
  placeAt(a, 200, 0, { speed: 20 }); placeAt(b, 230, 0, { speed: 20 }); placeAt(c, 260, 3, { speed: 20 });
  ok(applyHazardHit(a, 'crush', pal) && a.tumbleTimer > 0 && applyHazardHit(b, 'fire', pal) && b.spinTimer > 0 && causes.join() === 't:crush,s:fire', "v4: 'crush' → tumble('crush'), 'fire' → spinOut('fire')");
  const vlat0 = c.velocity.x * c.proj.right.x + c.velocity.z * c.proj.right.z, v0 = Math.hypot(c.velocity.x, c.velocity.z);
  ok(applyHazardHit(c, { type: 'duck', effect: 'knock', lateral: 0 }, pal) && c.spinTimer === 0 && c.tumbleTimer === 0 && c.velocity.y > 0
    && c.velocity.x * c.proj.right.x + c.velocity.z * c.proj.right.z > vlat0 + 3 && causes.includes('k:duck'), `knock: a hop + a shove away (lateral +), no spin (speed ${v0.toFixed(1)} → ${Math.hypot(c.velocity.x, c.velocity.z).toFixed(1)})`);
  ok(!applyHazardHit(c, { type: 'duck', effect: 'knock', lateral: 0 }, pal), 'knock: re-hit cooldown');
  for (const off of offs) off();
  // a custom kinds table: a slow puddle, a conveyor band, the stepper
  const tr = getTrack('breezy');
  const KINDS = {
    puddle: { hit: (h, t, along, lat) => (Math.abs(along) < 3 && Math.abs(lat - h.lateral) < 3 ? { type: 'puddle', effect: 'slow', strength: 0.5 } : null), extent: () => 3, soft: () => 0.7 },
    belt: { hit: () => null, extent: (h) => [0, h.len], push: () => 5 },
  };
  const hz = makeHazardSet(tr, KINDS, { defs: [{ type: 'puddle', u: 1.5, lateral: 0 }, { type: 'belt', f0: 0.5, f1: 0.52 }, { type: 'mystery', u: 2 }], theme: 'test' });
  ok(hz.list.length === 2 && Math.abs(hz.list[1].len - 0.02 * tr.length) < 1e-6 && hz.list[1].reach1 === hz.list[1].len, 'bands (f0 / f1 → len); unknown types skipped');
  ok(typeof hz.pushAt === 'function' && hz.softAt(hz.list[0].s, 0) === 0.7 && hz.hitAt(hz.list[0].s + 1, 0.5).effect === 'slow' && hz.ahead(hz.list[0].s - 20, 30).length === 1, 'pushAt / softAt / hitAt / ahead on custom kinds');
  const k = new Kart({ id: 'probe', character: CHARACTERS[0], track: tr });
  placeAt(k, hz.list[0].s, 0, { speed: 25 });
  stepCourseHazards(hz, [k], DT, true);
  const capped = Math.hypot(k.velocity.x, k.velocity.z);
  ok(capped <= k.maxSpeed * 0.5 + 0.01, `slow: speed capped at max x (1 - strength) (${capped.toFixed(2)} <= ${(k.maxSpeed * 0.5).toFixed(2)})`);
  placeAt(k, hz.list[0].s + 40, 0, { speed: 25 });
  stepCourseHazards(hz, [k], DT, true);
  const mid = Math.hypot(k.velocity.x, k.velocity.z);
  for (let i = 0; i < 125; i++) stepCourseHazards(hz, [k], DT, true);
  placeAt(k, hz.list[0].s + 40, 0, { speed: 25 });
  stepCourseHazards(hz, [k], DT, true);
  ok(mid < 25 - 1, `slow: still capped right after leaving the puddle (${mid.toFixed(2)})`);
  ok(Math.abs(Math.hypot(k.velocity.x, k.velocity.z) - 25) < 1e-6, 'slow eased off after 1 s (no cap left)');
  const k2 = new Kart({ id: 'belt', character: CHARACTERS[1], track: tr });
  placeAt(k2, hz.list[1].s + 5, 0, { speed: 0 });
  k2.grounded = true;
  for (let i = 0; i < 12; i++) stepCourseHazards(hz, [k2], DT, true);
  const vt = k2.velocity.x * k2.proj.tangent.x + k2.velocity.z * k2.proj.tangent.z;
  ok(vt > 1, `a belt pushes a grounded kart along the track (${vt.toFixed(2)} m/s)`);
  const k3 = new Kart({ id: 'star', character: CHARACTERS[2], track: tr });
  placeAt(k3, hz.list[0].s, 0, { speed: 25 });
  k3.startStar();
  stepCourseHazards(hz, [k3], DT, true);
  ok(Math.abs(Math.hypot(k3.velocity.x, k3.velocity.z) - 25) < 1e-6, 'a starred kart ignores the slow');
}

section('track v5: path mode, f / s keys, coins (SPEC §16.1)');
{
  // turtle tracks: u = segment index + fraction; path-mode tracks (Aldrich Park): u = lap fraction
  ok(['breezy', 'monte', 'aldrich', 'laguna', 'palace'].every((id) => { const t = getTrack(id); return Array.isArray(t.coins) && t.sOfKey({ f: 0.5 }) === t.length / 2 && (t.pathMode ? t.sOfKey({ u: 0.25 }) === t.length / 4 : t.sOfKey({ u: 2.5 }) === t.sOfU(2.5)); }), 'registered tracks: coins array, sOfKey u / f (turtle and path mode)');
  const R = 70, n = 20;
  const path = Array.from({ length: n }, (_, i) => [R * Math.sin((i / n) * 2 * Math.PI), R * Math.cos((i / n) * 2 * Math.PI)]);
  const tr = new Track({
    id: 'ring', name: 'Ring', theme: 'bay', path, sampleSpacing: 1,
    halfWidth: [{ f: 0, v: 9 }, { f: 0.5, v: 11 }], elevation: [[0, 0], [0.5, 2]],
    itemRows: [{ f: 0.25, count: 4 }], boostPads: [{ u: 0.5, lateral: 0, length: 5, width: 3 }],
    zones: [{ f0: 0.1, f1: 0.2, type: 'a' }, { s0: 50, s1: 70, type: 'b' }],
    coins: [{ f: 0.75, count: 5, lateral: 2, spacing: 3 }, { u: 0.1, count: 3, lateral: 40, spacing: 2 }],
  });
  const L0 = 2 * Math.PI * R, Lt = tr.length;
  ok(tr.pathMode && Math.abs(Lt - L0) / L0 < 0.003 && tr.closureError === 0 && tr.controlS.length === n, `path mode ring: ${Lt.toFixed(2)} m (circle ${L0.toFixed(2)}), closed`);
  let cmax = 0;
  for (let i = 0; i < tr.N; i++) cmax = Math.max(cmax, Math.abs(tr.curv[i]));
  ok(Math.abs(1 / cmax - R) < 0.06 * R, `curvature ~ 1/${R} (min R ${(1 / cmax).toFixed(1)}; Catmull-Rom ripple on 20 points)`);
  ok(tr.sOfU(0.25) === Lt * 0.25 && tr.sOfKey({ f: 0.5 }) === Lt * 0.5 && tr.sOfKey({ s: 12 }) === 12 && Math.abs(tr.itemRows[0].s - Lt / 4) < 1e-6 && Math.abs(tr.boostPads[0].s0 - Lt / 2) < 1e-6, 'u = lap fraction in path mode; f / s keys on features');
  ok(Math.abs(tr.zones[0].s0 - 0.1 * Lt) < 1e-6 && tr.zones[1].s0 === 50 && tr.zones[1].s1 === 70 && Math.abs(tr.frameAt(Lt / 2).halfWidth - 11) < 0.05 && Math.abs(tr.frameAt(Lt / 2).y - 2) < 0.05, 'zones f0/f1 + s0/s1; { f, v } and [u, v] keyframes');
  ok(tr.coins.length === 8 && tr.coinLines.length === 2 && Math.abs(tr.coins[1].s - (0.75 * Lt + 3)) < 1e-6 && tr.coins.every((cn) => Math.abs(cn.lateral) <= tr.frameAt(cn.s).halfWidth - 0.8 + 1e-6), 'coins: lines from s, spaced, kept inside the road edge');
  const pr = tr.project(tr.coins[1].position, -1, {});
  ok(Math.abs(tr.deltaS(pr.s, tr.coins[1].s)) < 0.05 && Math.abs(pr.lateral - 2) < 0.05, 'coin positions are road points (project round-trip)');
  ok(tr.segments.length >= 1 && tr.segments.every((g) => g.type === 'arc' && g.radius > 50 && g.radius < 90) && tr.segStartS[tr.segStartS.length - 1] === Lt, `derived segments (${tr.segments.map((g) => `${g.type} R${(g.radius || 0).toFixed(0)}`).join(', ')})`);
  const g = tr.gridSlot(0);
  ok(Number.isFinite(g.position.x) && Math.abs(g.s - (Lt - 7)) < 1e-6, 'grid slots in path mode');
}

section('hazards v5: Aldrich Park set pieces — bike crossings, ducks, sprinklers (hazards/campus.js)');
{
  const { KART } = await import('../public/js/config.js');
  const ald = getTrack('aldrich'), hz = createHazardsRegistry(ald), hz2 = createHazardsRegistry(ald);
  const of = (type) => hz.list.filter((h) => h.type === type);
  const cyc = of('cyclist'), ducks = of('ducks')[0], spr = of('sprinkler');
  ok(ald.pathMode && ald.length >= 1300 && ald.length <= 1600 && hz.theme === 'campus' && cyc.length === 2 && ducks && spr.length === 2 && hz.list.length === ald.def.hazards.length,
    `aldrich: path mode ${ald.length.toFixed(0)} m, 2 crossings + the ducks + 2 sprinklers through the campus module`);
  let same = true;
  for (let t = 0; t < 40 && same; t += 0.29) for (const h of hz.list) if (JSON.stringify(hz.stateAt(h, t)) !== JSON.stringify(hz2.stateAt(hz2.list[h.index], t))) same = false;
  ok(same, 'set-piece state is a pure function of the race clock');
  const R = KART.radius, dt = 0.02;
  // bike crossings: every rider waits >= 0.8 s beyond the barrier (bell) before it enters the walls, hits spin,
  // and at every moment some line across the road is clear
  let waitOk = true, openOk = true, spinOk = true, rides = 0;
  for (const h of cyc) {
    const f = ald.frameAt(h.s), lim = Math.min(f.halfWidth, f.wallL, f.wallR) - R;
    for (let k = 0; k < h.riders; k++) {
      let outside = 0, prevIn = true;          // a ride already under way at t = 0 is not counted
      for (let t = 0; t < 2 * h.period; t += dt) {
        const rd = hz.stateAt(h, t).riders[k];
        const inside = rd.mode !== 'gone' && Math.abs(rd.lat) < (rd.lat < 0 ? f.wallL : f.wallR);
        if (inside && !prevIn && t > 0) { rides++; if (outside < 0.8) waitOk = false; }
        outside = inside ? 0 : outside + dt;
        prevIn = inside;
      }
    }
    for (let t = 0; t < h.period; t += 0.05) {
      let clear = false;
      for (let lat = -lim; lat <= lim && !clear; lat += 0.5) {
        let hit = null;
        for (let along = -3; along <= 3 && !hit; along += 0.25) hit = hz.hitOne(h, t, along, lat, 0, R);
        if (!hit) clear = true;
      }
      if (!clear) openOk = false;
    }
    for (let t = 0; t < h.period; t += 0.05) for (let lat = -8; lat <= 8; lat += 1) { const r = hz.hitOne(h, t, -1.2, lat, 0, R); if (r && (r.effect !== 'spin' || r.type !== 'cyclist')) spinOk = false; }
  }
  ok(waitOk && rides >= 8, `bike crossings: every ride (${rides}) is announced by >= 0.8 s at the curb (bell)`);
  ok(openOk, 'bike crossings: an open line across the road at every moment');
  ok(spinOk, 'bike crossings: a clipped bike spins the kart');
  // ducks: the right half of the road is always clear, a hit is a soft knock with the duck's lateral, they pause on the verge
  let rightClear = true, knockOk = true, preen = 0, hits = 0;
  for (let t = 0; t < 2 * ducks.period; t += dt) {
    for (let lat = 3; lat <= 9; lat += 1) if (hz.hitOne(ducks, t, 0, lat, 0, R)) rightClear = false;
    const st = hz.stateAt(ducks, t);
    if (st.mode === 'preen') preen += dt;
    const r = hz.hitOne(ducks, t, 0, st.lead, 0, R);
    if (r) { hits++; if (r.effect !== 'knock' || !(r.strength > 0 && r.strength < 1) || !Number.isFinite(r.lateral)) knockOk = false; }
  }
  ok(rightClear, 'ducks: the right half of the road (lat >= 3) is always clear');
  ok(hits > 0 && knockOk, 'ducks: a hit is a soft knock (strength < 1) shoving away from the duck');
  ok(preen >= 1.0 * 2 - 1e-6, `ducks: they pause on the plaza verge every cycle (${preen.toFixed(1)} s in 2 cycles)`);
  // sprinklers: the two irrigation zones never run together, each run is announced by >= 0.7 s of pop-up,
  // hits are 'slow', and the far half is dry while a head runs
  let together = false, announceOk = true, slowOk = true, farDry = true, runs = 0;
  for (const h of spr) {
    let rise = 0, prevOn = false;
    for (let t = 0; t < 3 * h.period; t += dt) {
      const st = hz.stateAt(h, t);
      if (st.on && !prevOn) { runs++; if (t > h.period && rise < 0.7) announceOk = false; }
      rise = st.on ? 0 : st.rise > 0.02 ? rise + dt : 0;
      prevOn = st.on;
      for (let along = -10; along <= 10; along += 2) {
        const r = hz.hitOne(h, t, along, -h.lateral * 0.5, 0, R);
        if (r && r.effect !== 'slow') slowOk = false;
        if (hz.hitOne(h, t, along, -Math.sign(h.lateral) * 4.5, 0, R)) farDry = false;
      }
    }
  }
  for (let t = 0; t < 3 * spr[0].period; t += dt) if (hz.stateAt(spr[0], t).on && hz.stateAt(spr[1], t).on) together = true;
  ok(!together, 'sprinklers: the two irrigation zones take turns (never both running)');
  ok(announceOk && runs >= 4, `sprinklers: every run (${runs}) is announced by >= 0.7 s of the head popping up`);
  ok(slowOk && farDry, 'sprinklers: wet tyres = slow; the other half of the spine stays dry');
  // the shared stepper applies them: a duck knock and a sprinkler soak on real karts
  const kd = new Kart({ id: 'ducktest', character: CHARACTERS[0], track: ald });
  let tHit = 0;
  for (let t = 0; t < ducks.period; t += dt) { const st = hz.stateAt(ducks, t); if (st.mode === 'out' && st.lead > -6) { tHit = t; break; } }
  const hk = createHazardsRegistry(ald);
  hk.setTime(tHit);
  placeAt(kd, ducks.s, hk.stateAt(ducks, tHit).lead, { speed: 20 });
  let knocked = 0;
  const offK = bus.on('kart:knock', (e) => { if (e.kart === kd) knocked++; });
  stepCourseHazards(hk, [kd], DT, true);
  offK();
  ok(knocked === 1 && !kd.isDisabled(), 'a kart on the ducks is knocked (no spin, no item loss)');
}

section('hazards v5: Laguna Beach set pieces — blowholes, shore-break waves, volleyball spikes (hazards/beach.js)');
{
  const B = await import('../public/js/hazards/beach.js');
  const lag = getTrack('laguna'), hz = createHazardsRegistry(lag), hz2 = createHazardsRegistry(lag);
  const by = (type) => hz.list.find((h) => h.type === type);
  const jet = by('jet'), surge = by('surge'), lob = by('lob');
  ok(hz.theme === 'beach' && jet && surge && lob && hz.list.length === 3 && typeof hz.softAt === 'function', 'laguna: jet + surge + lob resolved through the beach module (+ softAt for the AI)');
  // pure in t: two sets agree everywhere
  let same = true;
  for (let t = 0; t < 30 && same; t += 0.37) for (const h of hz.list) if (JSON.stringify(hz.stateAt(h, t)) !== JSON.stringify(hz2.stateAt(hz2.list[h.index], t))) same = false;
  ok(same, 'set-piece state is a pure function of the race clock');
  // blowholes: every spout is announced by >= 0.7 s of bubbling; only spouts soak (slow), the inland half stays dry
  const dt = 0.01;
  let warnOk = true, inlandDry = true, effectOk = true, spouts = 0;
  jet.lats.forEach((lat, k) => {
    let bubble = 0, prev = false;
    for (let t = 0; t < 4 * jet.period; t += dt) {
      const st = B.jetState(jet, t, k);
      if (st.bubbling) bubble += dt;
      if (st.erupting && !prev) { spouts++; if (t > jet.period && bubble < 0.7 - 1e-6) warnOk = false; bubble = 0; }
      if (!st.erupting && !st.bubbling) bubble = 0;
      prev = st.erupting;
      const hit = hz.hitOne(jet, t, 0, lat, 0);
      if (!!hit !== st.erupting) effectOk = false;
      if (hit && (hit.effect !== 'slow' || !(hit.strength > 0 && hit.strength <= 0.3))) effectOk = false;
    }
  });
  for (let t = 0; t < 2 * jet.period; t += 0.05) for (let lat = -lag.frameAt(jet.s).halfWidth + 1.2; lat < 0; lat += 0.5) if (hz.hitAt(jet.s, lat, t)) inlandDry = false;
  ok(spouts >= 6 && warnOk, `blowholes: ${spouts} spouts, each after >= 0.7 s of bubbling (the telegraph)`);
  ok(effectOk && inlandDry, 'blowholes: hit only while spouting → slow (<= 0.3), the inland half of the shelf always dry');
  // waves: no water on the road before the build has run (>= 1.5 s), a dry inland lane at every moment, the tide rises
  const hw = surge.hw, mid = surge.s + surge.len / 2;
  let buildOk = true, dryLane = true, wetEarly = -Infinity, wetLate = -Infinity, waveHit = null;
  let buildT = 0;
  for (let t = 0; t < 130; t += 0.02) {
    const ph = B.surgePhase(surge, t);
    if (ph.phase === 'build') buildT += 0.02;
    const r = B.surgeReach(surge, t);
    if (r > 0 && ph.phase === 'wash' && ph.k < 0.05 && buildT > 0 && buildT < 1.5) buildOk = false;
    if (ph.phase === 'calm') buildT = 0;
    if (hz.hitAt(mid, -hw + 1.2, t)) dryLane = false;
    for (let lat = hw; lat > -hw; lat -= 0.25) {
      const h = hz.hitAt(mid, lat, t);
      if (!h) break;
      waveHit = waveHit || h;
      if (t < 40) wetEarly = Math.max(wetEarly, hw - lat); else if (t > 92) wetLate = Math.max(wetLate, hw - lat);
    }
  }
  ok(buildOk && dryLane, 'waves: the build (foam up the sand, roar) runs >= 1.5 s before the water reaches the road; a dry inland lane always');
  ok(wetEarly > 0 && wetLate > wetEarly + 3 && wetLate < 2 * hw * 0.62, `waves: the tide rises — wet ${wetEarly.toFixed(1)} m of road on lap 1, ${wetLate.toFixed(1)} m late (of ${(2 * hw).toFixed(0)})`);
  ok(waveHit && waveHit.effect === 'slow' && waveHit.strength === 0.3 && waveHit.push === 2 && waveHit.side === 1 && hz.softAt(mid, hw - 1, 4.2) === 1 && hz.softAt(mid, -hw + 1, 4.2) === 0,
    'waves: slow 0.3 + a 2 m/s shove toward land; softAt marks the wet side only');
  // volleyballs: danger only around each landing (<= 0.6 s per serve), a >= 1 s ring telegraph, knock away from the ball
  let windows = 0, longest = 0, run = 0, knock = null, telegraphOk = true;
  for (let t = 0; t < 4 * lob.period * lob.spots.length; t += dt) {
    const st = B.lobState(lob, t);
    if (st.danger) { run += dt; if (st.tau < 1.0 - 1e-6) telegraphOk = false; const h = hz.hitOne(lob, t, st.along, st.lat, 0); knock = knock || h; }
    else if (run > 0) { windows++; longest = Math.max(longest, run); run = 0; }
  }
  ok(windows >= 14 && longest <= 0.61 && telegraphOk, `volleyballs: ${windows} landings, each dangerous <= ${longest.toFixed(2)} s, after >= 1 s of shrinking ring`);
  ok(knock && knock.effect === 'knock' && Number.isFinite(knock.lateral), 'volleyballs: knock (a bump away from the ball, no item loss)');
  // the kart path: check() via the kart's projection, applied by the shared stepper (game == sim)
  const k = new Kart({ id: CHARACTERS[0].id, character: CHARACTERS[0], track: lag });
  lag.pointAt(mid, hw - 2, k.position);
  const f = lag.frameAt(mid);
  k.yaw = f.yaw; k.velocity.set(Math.sin(k.yaw) * 25, 0, Math.cos(k.yaw) * 25); k.hint = -1;
  lag.project(k.position, -1, k.proj); k.hint = k.proj.index; k.grounded = true;
  hz.reset(4.2);
  const slows = [];
  const off = bus.on('kart:slow', (e) => slows.push(e.cause));
  const latV0 = k.velocity.x * f.right.x + k.velocity.z * f.right.z;
  ok(!!hz.check(k) && JSON.stringify(hz.check(k)) === JSON.stringify(hz.hitAt(k.proj.s, k.proj.lateral, hz.time, 0)), 'check(kart) = hitAt at the kart projection (what the CPUs plan with)');
  stepCourseHazards(hz, [k], DT, true);
  off();
  ok(slows.join() === 'wave' && k.velocity.x * f.right.x + k.velocity.z * f.right.z < latV0 - 1.5, 'a kart in the wash is slowed and shoved toward land (stepCourseHazards)');
}

// v5 group-A items (thrown / placed / projectile / environment): tools/race-logic-items-a.mjs
await (await import('./race-logic-items-a.mjs')).itemsATests({ ok, section });

// v5 group-B items (self-buff / transform / kart states) + the lire: tools/race-logic-items-b.mjs
await (await import('./race-logic-items-b.mjs')).runItemsB({ ok, section });

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
