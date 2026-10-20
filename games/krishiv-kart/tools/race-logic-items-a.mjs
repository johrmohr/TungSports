// RACE LOGIC rule tests for the v5 group-A items (SPEC §16.2; notes/research-v5-items.md §C6 A1-A13,
// §C7, §C10): peperoncino, granita, flying_pizza, rolling_pins, piggy_bank, parm_wheel, surprise_egg,
// prank_box, banana_split, sour_lemon, padella, taralli, befana — behaviour, interactions with the
// existing items, caps / rules, CPU use. Run from tools/race-logic-test.mjs (shares its ok / section),
// or alone: node tools/race-logic-items-a.mjs. Roster-agnostic (needs >= 8 racers in characters.js);
// track-agnostic (finds the longest straight of Breezy Bay).
import { getTrack } from '../public/js/tracks.js';
import { Kart } from '../public/js/kart.js';
import { CHARACTERS } from '../public/js/characters.js';
import { Race } from '../public/js/race.js';
import { ItemSystem } from '../public/js/items.js';
import { AIDriver } from '../public/js/ai.js';
import { bus } from '../public/js/bus.js';
import { makeRng } from '../public/js/utils.js';
import { ITEM_INFO, ITEM_RULES, ITEM5, HIT, ITEM, itemEnabled } from '../public/js/config.js';
import { getItemHandler } from '../public/js/items/registry.js';
import { coinState } from '../public/js/items/coins.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GROUP_A = ['peperoncino', 'granita', 'flying_pizza', 'rolling_pins', 'piggy_bank', 'parm_wheel', 'surprise_egg',
  'prank_box', 'banana_split', 'sour_lemon', 'padella', 'taralli', 'befana'];

export async function itemsATests({ ok, section }) {
  const track = getTrack('breezy');
  const DT = 1 / 120;
  const straight = track.segments.filter((g) => g.type === 'straight').sort((a, b) => (b.s1 - b.s0) - (a.s1 - a.s0))[0];
  const S = straight.s0 + 4, SL = straight.s1 - straight.s0;
  const events = [];
  const offAll = bus.on('*', (data, type) => { if (type.startsWith('item:') || type.startsWith('kart:')) events.push({ type, data }); });
  const count = (type, pred = () => true) => events.filter((e) => e.type === type && pred(e.data)).length;
  let errors = 0;

  function makeKarts(n = 8) {
    const ks = CHARACTERS.slice(0, n).map((c) => new Kart({ id: c.id, character: c, track }));
    ks.forEach((k, i) => k.placeOnGrid(track.gridSlot(i)));
    return ks;
  }
  function placeAt(k, s, lat = 0, speed = 0, back = false) {
    track.pointAt(s, lat, k.position);
    const f = track.frameAt(s);
    k.yaw = back ? f.yaw + Math.PI : f.yaw;
    k.velocity.set(Math.sin(k.yaw) * speed, 0, Math.cos(k.yaw) * speed);
    k.hint = -1;
    track.project(k.position, -1, k.proj);
    k.hint = k.proj.index;
    k.position.y = k.proj.height;
  }
  function setup(n = 4, ccMult = 1) {
    const ks = makeKarts(n);
    const race = new Race({ track, karts: ks, laps: 3 });
    race.skipIntro();
    for (let i = 0; i < 361; i++) race.update(DT);
    const items = new ItemSystem({ track, karts: ks, scene: null, rng: makeRng(11), ccMult });
    ks.forEach((k, i) => placeAt(k, track.wrapS(straight.s1 + 300 + i * 30), 0));
    race.time = 60;
    return { ks, race, items };
  }
  // race distances = s on lap 1 (places for "karts ahead")
  function sync(race, ks) { race.update(DT); for (const k of ks) k.distance = k.proj.s; race.update(DT); race.time = Math.max(race.time, 60); }
  function tick(items, race, ks, n = 1) {
    for (let i = 0; i < n; i++) { items.update(DT, race); for (const k of ks) k.update(DT); race.update(DT); }
  }
  // items only (karts held in place: no physics) — for geometry checks
  function itick(items, race, n = 1) { for (let i = 0; i < n; i++) items.update(DT, race); }
  const hold = (ks) => { for (const k of ks) { k.input.throttle = 0; k.input.brake = 0; k.input.steer = 0; } };
  const hits = (item, kart) => count('item:hit', (d) => d.item === item && (!kart || d.kart === kart));
  const done = (items) => { errors += items.pluginErrors; items.dispose(); };
  const ents = (items, kind) => items.entities.filter((e) => e.kind === kind && e.active);
  const sAhead = (from, ahead) => track.wrapS(from + ahead);

  section('items v5 group A: registration, data, names (SPEC §16.0, §16.2)');
  {
    ok(GROUP_A.every((id) => getItemHandler(id) && typeof getItemHandler(id).use === 'function' && typeof getItemHandler(id).aiUse === 'function'
      && typeof getItemHandler(id).initVisuals === 'function' && typeof getItemHandler(id).updateVisuals === 'function'), 'every group-A item: use, aiUse, visuals');
    ok(GROUP_A.every((id) => itemEnabled(id)), `group A switched on in ITEM_ENABLED (${GROUP_A.filter((id) => !itemEnabled(id))})`);
    ok(GROUP_A.filter((id) => id !== 'taralli').every((id) => typeof getItemHandler(id).callout === 'string'), 'a hit callout for every group-A attack item');
    const banned = /blue shell|bullet bill|blooper|bob-?omb|mushroom|bowser|thwomp|lakitu|spiny|fire flower|boomerang|piranha|\bboo\b|\bmega\b|\bpow\b|kamek|super leaf|lucky 7|lucky seven|crazy 8|crazy eight|coin shell|thunder cloud|feather|chain chomp|yoshi|birdo|mario|luigi|nintendo/i;
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/js/items');
    const strings = [];
    for (const id of GROUP_A) {
      const src = fs.readFileSync(path.join(dir, `${id}.js`), 'utf8');
      for (const m of src.matchAll(/'([^'\n]{3,})'|"([^"\n]{3,})"|`([^`\n]{3,})`/g)) strings.push(`${id}: ${m[1] || m[2] || m[3]}`);
    }
    const bad = strings.filter((x) => banned.test(x.slice(x.indexOf(':') + 1)));
    ok(!bad.length && strings.length > 100, `no other game's names in group-A strings (${bad.slice(0, 3)})`);
  }

  // ------------------------------------------------------------------ A1
  section('items v5 A1: Peperoncino Blaster (timed volley, spin + 1 lira, walls, blockers)');
  {
    events.length = 0;
    const { ks, race, items } = setup(4);
    const [a, b, c, d] = ks;
    placeAt(a, S, 0); placeAt(b, S + 20, 0); hold(ks);
    ok(items.giveItem(a, 'peperoncino') && a.item === 'peperoncino' && a.itemCount === 8, 'pickup: 8 shots in the slot');
    ok(items.useItem(a) && a.itemCount === 7 && a.itemTimer === ITEM5.pepperWindow && a.itemTimerMax === ITEM5.pepperWindow, 'first press: a fireball + the 8 s window (kart.itemTimer)');
    ok(!items.useItem(a) && a.itemCount === 7, `presses < ${ITEM5.pepperGap} s apart are ignored`);
    const fb = ents(items, 'fireball')[0];
    ok(fb && fb.speed >= ITEM5.pepperSpeed - 1e-6 && fb.role === 'projectile' && fb.solid, `fireball at max(${ITEM5.pepperSpeed}, speed + ${ITEM5.pepperBoost}) m/s, solid`);
    tick(items, race, ks, 90);
    ok(hits('peperoncino', b) === 1 && b.spinTimer > 0 && count('item:hit', (x) => x.item === 'peperoncino' && x.light && x.by === a) === 1 && !fb.active, 'a fireball spins a rival 20 m ahead: a light hit (1 lira), gone');
    // the window: 8 shots max, then the slot is empty
    for (let i = 0; i < 12; i++) { items.useItem(a); itick(items, race, 30); }
    ok(!a.item && a.itemTimer === 0 && items.used.peperoncino === 1, 'after 8 shots the slot is empty (one use counted)');
    // the window running out with shots left
    items.giveItem(a, 'peperoncino'); items.useItem(a);
    itick(items, race, Math.ceil(ITEM5.pepperWindow / DT) + 2);
    ok(!a.item && a.itemTimer === 0, `the window ends after ${ITEM5.pepperWindow} s (unfired shots lost)`);
    // owner hit: the window ends
    items.giveItem(a, 'peperoncino'); items.useItem(a);
    a.invulnTimer = 0; a.spinOut('test'); itick(items, race, 2);
    ok(!a.item, 'the owner being hit ends the window');
    a.spinTimer = 0; a.invulnTimer = 0;
    // brake: backward, slower
    for (const e of ents(items, 'fireball')) items.pluginContext('peperoncino').remove(e, 'clear');
    itick(items, race, 2);
    items.giveItem(a, 'peperoncino'); items.pluginContext('peperoncino').kstate(a).last = -9;
    a.input.brake = 1; items.useItem(a); a.input.brake = 0;
    const back = ents(items, 'fireball')[0];
    ok(back && back.dir.x * Math.sin(a.yaw) + back.dir.z * Math.cos(a.yaw) < -0.9 && back.speed <= ITEM5.pepperBackSpeed + 1e-6, 'brake held: thrown backward at 18 m/s');
    items.pluginContext('peperoncino').remove(back, 'clear');
    // blockers: an orbiting triple bouncer stops it; it burns through a banana; it trades with a native bouncer head-on
    a.item = null; items.giveItem(b, 'triple_bouncer');
    itick(items, race, 2);
    items.giveItem(a, 'peperoncino'); items.pluginContext('peperoncino').kstate(a).last = -9; items.useItem(a);
    const fb2 = ents(items, 'fireball')[0], orb = items.attached.find((x) => x.owner === b);
    fb2.position.copy(orb.position).add({ x: -fb2.dir.x * 0.3, y: 0, z: -fb2.dir.z * 0.3 }); fb2.position.y = orb.position.y - 0.15;
    fb2.speed = 0.01;
    itick(items, race, 1);
    ok(items.attached.filter((x) => x.owner === b).length === 2 && !fb2.active && hits('peperoncino', b) === 1, 'an orbiting triple blocks a fireball (both gone)');
    for (const x of items.attached.slice()) items._detach(x, 'clear');
    b.item = null; b.itemCount = 0;
    placeAt(b, S + 60, 0);
    const peel = items._dropHazard(c, 'banana', track.pointAt(S + 15, 0));
    items.pluginContext('peperoncino').kstate(a).last = -9; items.useItem(a);
    itick(items, race, 40);
    ok(!peel.active && ents(items, 'fireball').length === 0, 'a fireball burns up a banana peel (both gone)');
    placeAt(d, S + 40, 0, 0, true);
    d.item = 'bouncer'; d.itemCount = 1; items.useItem(d);
    items.pluginContext('peperoncino').kstate(a).last = -9; items.useItem(a);
    itick(items, race, 90);
    ok(items.projectiles.length === 0 && ents(items, 'fireball').length === 0 && hits('peperoncino', d) === 0 && hits('bouncer', a) === 0, 'a fireball and a bouncer trade head-on');
    // cap on live fireballs (oldest recycled)
    for (let i = 0; i < 20; i++) { a.item = 'peperoncino'; a.itemCount = 8; items.pluginContext('peperoncino').kstate(a).last = -9; items.useItem(a); }
    ok(ents(items, 'fireball').length === ITEM5.pepperMaxLive, `at most ${ITEM5.pepperMaxLive} fireballs live (oldest recycled)`);
    done(items);
  }

  // ------------------------------------------------------------------ A2
  section('items v5 A2: Granita Freeze (orbit shield, fan, freeze)');
  {
    events.length = 0;
    const { ks, race, items } = setup(4);
    const [a, b, c, d] = ks;
    placeAt(a, S + 20, 0); hold(ks);
    items.giveItem(a, 'granita');
    itick(items, race, 10);
    const orbs = ents(items, 'iceorb');
    ok(orbs.length === 3 && orbs.every((o) => Math.abs(Math.hypot(o.position.x - a.position.x, o.position.z - a.position.z) - ITEM5.granitaOrbitRadius) < 0.05), `pickup: 3 scoops orbit at ${ITEM5.granitaOrbitRadius} m`);
    // a rival's bouncer from behind is stopped by a scoop
    placeAt(d, S, 0); d.item = 'bouncer'; d.itemCount = 1; items.useItem(d);
    itick(items, race, 50);
    ok(ents(items, 'iceorb').length === 2 && items.projectiles.length === 0 && a.tumbleTimer === 0 && a.item === 'granita', 'a scoop blocks a bouncer (both gone; the item stays)');
    // a rival touching a scoop is frozen
    const o = ents(items, 'iceorb')[0];
    c.position.copy(o.position); c.position.y = a.position.y; track.project(c.position, -1, c.proj);
    itick(items, race, 2);
    ok(c.iceTimer > 0 && hits('granita', c) === 1 && ents(items, 'iceorb').length === 1, 'a rival touching a scoop is frozen (kart.iceTimer)');
    // fling: the fan (forward), freeze + 1 lira
    placeAt(c, track.wrapS(straight.s1 + 300), 0); c.iceTimer = 0; c.invulnTimer = 0;
    placeAt(b, S + 45, 0); b.invulnTimer = 0;
    items.giveItem(a, 'granita');
    ok(!items.giveItem(a, 'granita'), 'one at a time per slot');
    a.item = null; a.itemCount = 0; itick(items, race, 2);
    ok(ents(items, 'iceorb').length === 0, 'scoops are lost with the item');
    items.giveItem(a, 'granita'); itick(items, race, 2);
    ok(items.useItem(a) && !a.item && ents(items, 'iceball').length === 3 && ents(items, 'iceorb').length === 0, 'the press flings all three as a fan');
    const balls = ents(items, 'iceball');
    const yaws = balls.map((x) => Math.atan2(x.dir.x, x.dir.z) - a.yaw).map((v) => Math.atan2(Math.sin(v), Math.cos(v)) * 180 / Math.PI).sort((x, y) => x - y);
    ok(Math.abs(yaws[0] + ITEM5.granitaSpread) < 0.5 && Math.abs(yaws[1]) < 0.5 && Math.abs(yaws[2] - ITEM5.granitaSpread) < 0.5, `fan at -${ITEM5.granitaSpread}° / 0° / +${ITEM5.granitaSpread}° (${yaws.map((v) => v.toFixed(1))})`);
    itick(items, race, 90);
    ok(b.iceTimer > 0 && count('item:hit', (x) => x.item === 'granita' && x.kart === b && x.light && x.effect === 'freeze') === 1, 'a flung scoop freezes a rival 25 m ahead (light hit)');
    // freeze: no steering, slides straight, decelerating
    const v0 = Math.hypot(b.velocity.x, b.velocity.z), yaw0 = b.yaw;
    b.velocity.set(Math.sin(b.yaw) * 20, 0, Math.cos(b.yaw) * 20);
    b.input.steer = 1; b.input.throttle = 1;
    for (let i = 0; i < 30; i++) b.update(DT);
    const v1 = Math.hypot(b.velocity.x, b.velocity.z);
    ok(Math.abs(b.yaw - yaw0) < 1e-6 && v1 < 20 && v1 > 18, `frozen: no steering, slides on decelerating (${v0.toFixed(1)} → 20 → ${v1.toFixed(2)} m/s)`);
    // owner hit: orbit lost
    a.invulnTimer = 0; b.iceTimer = 0;
    items.giveItem(a, 'granita'); itick(items, race, 2);
    a.spinOut('test'); itick(items, race, 2);
    ok(!a.item && ents(items, 'iceorb').length === 0, 'the owner hit: the orbit and the item are lost');
    done(items);
  }

  // ------------------------------------------------------------------ A3
  section('items v5 A3: Flying Pizza (out + back, pierces, caught, busy slot)');
  {
    events.length = 0;
    const { ks, race, items } = setup(4);
    const [a, b, c, d] = ks;
    placeAt(a, S, 0); placeAt(b, S + 12, 0.4); placeAt(c, S + 24, -0.4); hold(ks);
    items.giveItem(a, 'flying_pizza');
    ok(items.useItem(a) && a.item === 'flying_pizza' && a.itemCount === 2 && a.itemBusy === true, 'throw: one of 3 used, the slot greyed (kart.itemBusy)');
    ok(!items.useItem(a) && a.itemCount === 2, 'presses while it is out do nothing');
    let caught = 0;
    const off = bus.on('item:pizzaCatch', () => caught++);
    const pz = ents(items, 'pizza')[0];
    let maxOut = 0;
    for (let i = 0; i < 360 && pz.active; i++) { itick(items, race, 1); maxOut = Math.max(maxOut, track.deltaS(a.proj.s, pz.s)); }
    off();
    ok(hits('flying_pizza', b) === 1 && hits('flying_pizza', c) === 1 && b.spinTimer > 0 && c.spinTimer > 0, 'it pierces: both rivals in its path spin (once each)');
    ok(count('item:hit', (x) => x.item === 'flying_pizza' && x.light) === 2 && hits('flying_pizza', a) === 0, 'light hits (1 lira); the thrower is never hit');
    ok(caught === 1 && !a.itemBusy && a.itemCount === 2 && maxOut > 25 && maxOut < 45, `out ~35 m (${maxOut.toFixed(1)}), back and caught: the next throw is ready`);
    // the return leg hits too
    b.spinTimer = 0; b.invulnTimer = 0; c.spinTimer = 0; c.invulnTimer = 0;
    placeAt(b, track.wrapS(straight.s1 + 300), 0); placeAt(c, track.wrapS(straight.s1 + 330), 0);
    items.useItem(a);
    const pz2 = ents(items, 'pizza')[0];
    for (let i = 0; i < 200 && pz2.active && pz2.phase === 'out'; i++) itick(items, race, 1);
    placeAt(a, S, -6);                                   // the thrower moved over: the return line is off the out line
    placeAt(d, S + 4.5, -6.2); d.invulnTimer = 0;
    for (let i = 0; i < 300 && pz2.active; i++) itick(items, race, 1);
    ok(hits('flying_pizza', d) === 1 && count('item:pizzaCatch') === 2, 'it hits on the way back too (and is caught)');
    placeAt(a, S, 0); placeAt(d, track.wrapS(straight.s1 + 360), 0);
    // uncaught: lost, with the throws that were left
    items.useItem(a);
    const pz3 = ents(items, 'pizza')[0];
    ok(!pz3 || a.itemCount === 0, 'the last throw empties the slot');
    a.item = 'flying_pizza'; a.itemCount = 2; a.itemBusy = false;
    if (pz3) items.pluginContext('flying_pizza').remove(pz3, 'clear');
    items.useItem(a);
    placeAt(a, track.wrapS(S + 400), 0);
    itick(items, race, 420);
    ok(!a.item && !a.itemBusy && ents(items, 'pizza').length === 0, 'not caught: the pizza and the throws left are lost');
    // an orbiting triple stops it (both gone)
    placeAt(a, S, 0); placeAt(b, S + 15, 0); items.giveItem(b, 'triple_rocket');
    a.item = null; items.giveItem(a, 'flying_pizza'); items.useItem(a);
    itick(items, race, 60);
    ok(items.attached.filter((x) => x.owner === b).length === 2 && ents(items, 'pizza').length === 0, 'an orbiting triple stops the pizza (both gone)');
    done(items);
  }

  // ------------------------------------------------------------------ A4
  section('items v5 A4: Rolling Pins (lobs, stuck in the road, tumble, breaks hazards)');
  {
    events.length = 0;
    const { ks, race, items } = setup(4);
    const [a, b, c] = ks;
    placeAt(a, S, 0, 25); hold(ks);
    items.giveItem(a, 'rolling_pins');
    ok(a.itemCount === 5 && items.useItem(a) && a.itemTimer === ITEM5.pinsWindow && !items.useItem(a), `5 pins, a ${ITEM5.pinsWindow} s window, presses >= ${ITEM5.pinsGap} s apart`);
    const pin = ents(items, 'pin')[0];
    const s0 = a.proj.s;
    let t = 0;
    for (; t < 2 && pin.phase === 'air'; t += DT) itick(items, race, 1);
    const land = track.deltaS(s0, pin.s);
    ok(pin.phase === 'stuck' && Math.abs(t - 0.5) < 0.12 && land > 18 && land < 30, `lobbed: lands after ${t.toFixed(2)} s, ${land.toFixed(1)} m from the throw point (~25)`);
    // the thrower drives over its own pin; a rival tumbles on it
    a.position.copy(pin.position); itick(items, race, 2);
    ok(pin.active && a.tumbleTimer === 0, 'the thrower is never hit by its own pin');
    placeAt(a, track.wrapS(straight.s1 + 300), 0);
    b.position.copy(pin.position); b.invulnTimer = 0; itick(items, race, 2);
    ok(!pin.active && b.tumbleTimer > 0 && hits('rolling_pins', b) === 1, 'a stuck pin tumbles a rival and breaks');
    // stuck for pinsStuck s
    const arm = () => { const st = items.pluginContext('rolling_pins').kstate(a); a.item = 'rolling_pins'; a.itemCount = 5; st.window = 0; st.last = -9; return st; };
    placeAt(a, S, 0, 25); arm(); items.useItem(a);
    const p2 = ents(items, 'pin')[0];
    for (let i = 0; i < 120 && p2.phase === 'air'; i++) itick(items, race, 1);
    const tLand = p2.age;
    for (let i = 0; i < 600 && p2.active; i++) itick(items, race, 1);
    ok(!p2.active && Math.abs(p2.age - tLand - ITEM5.pinsStuck) < 0.05, `stuck in the road for ${ITEM5.pinsStuck} s`);
    // in flight it tumbles a kart in its arc; landing breaks a banana there
    placeAt(a, S, 0, 25); placeAt(c, S + 9, 0); c.invulnTimer = 0; c.tumbleTimer = 0;
    arm(); items.useItem(a);
    itick(items, race, 40);
    ok(hits('rolling_pins', c) >= 1 && c.tumbleTimer > 0, 'a pin in flight tumbles a kart in its arc');
    placeAt(c, track.wrapS(straight.s1 + 330), 0);
    // where does the next pin land? throw one, note the spot, then throw the same one again onto a peel there
    for (const x of ents(items, 'pin')) items.pluginContext('rolling_pins').remove(x, 'clear');
    placeAt(a, S, 0, 25);
    const pst = arm();
    items.useItem(a);
    const probe = ents(items, 'pin')[0];
    for (let i = 0; i < 120 && probe.phase === 'air'; i++) itick(items, race, 1);
    const spot = probe.position.clone();
    items.pluginContext('rolling_pins').remove(probe, 'clear');
    const peel = items._dropHazard(a, 'banana', spot);
    const strikes = count('item:strike');
    pst.n = 0; pst.last = -9; items.useItem(a);           // the same side as the probe (the first pin of a window)
    const p3 = ents(items, 'pin')[0];
    for (let i = 0; i < 120 && p3.phase === 'air'; i++) itick(items, race, 1);
    ok(p3.phase === 'stuck' && !peel.active && count('item:strike') > strikes, 'a landing pin breaks the banana it lands on, and strikes course hazards (item:strike)');
    // accordion destroys a stuck pin
    const sp = ents(items, 'pin').find((p) => p.phase === 'stuck');
    placeAt(b, track.project(sp.position, -1, {}).s - 4, 0);
    b.item = 'accordion'; b.itemCount = 1; items.useItem(b);
    ok(!sp.active, 'the accordion destroys a stuck pin');
    done(items);
  }

  // ------------------------------------------------------------------ A5
  section('items v5 A5: Piggy Bank (centre line, tumbles through, lire, burst)');
  {
    events.length = 0;
    const { ks, race, items } = setup(4);
    const [a, b, c] = ks;
    placeAt(a, S, 3, 20); placeAt(b, S + 25, 0.2); placeAt(c, S + 40, -0.3); hold(ks);
    items.giveItem(a, 'piggy_bank'); items.useItem(a);
    const pg = ents(items, 'piggy')[0];
    ok(pg && pg.phase === 'lane' && pg.speed >= ITEM5.piggySpeed - 1e-6, `rolls down the centre line at max(${ITEM5.piggySpeed}, speed + ${ITEM5.piggyBoost})`);
    itick(items, race, 30);
    ok(Math.abs(pg.lateral) < 3 - 0.2 * 1.5, `eases onto the centre line (lateral ${pg.lateral.toFixed(2)})`);
    for (let i = 0; i < 600 && pg.active; i++) itick(items, race, 1);
    ok(hits('piggy_bank', b) === 1 && hits('piggy_bank', c) === 1 && b.tumbleTimer > 0 && c.tumbleTimer > 0, 'tumbles every kart in its path and keeps rolling');
    ok(count('item:piggyBurst') === 1 && !pg.active, `bursts after ${ITEM5.piggyRange} m / ${ITEM5.piggyLife} s`);
    // the lire: a trail every piggyCoinEvery m + the burst ring (the coins system's loose lire; nobody in the way)
    const cs = coinState(items);
    if (cs) {
      for (const l of cs.loose) l.active = false;
      cs.looseLive = 0;
      ks.forEach((k, i) => placeAt(k, track.wrapS(straight.s1 + 300 + i * 30), 0));
      placeAt(a, S, 0, 20);
      items.giveItem(a, 'piggy_bank'); items.useItem(a);
      const p2 = ents(items, 'piggy')[0];
      for (let i = 0; i < 600 && p2.active; i++) itick(items, race, 1);
      const trail = Math.min(ITEM5.piggyTrailMax, Math.floor(Math.min(ITEM5.piggyRange, ITEM5.piggySpeed * ITEM5.piggyLife) / ITEM5.piggyCoinEvery));
      ok(cs.looseLive === trail + ITEM5.piggyRing, `a lira every ${ITEM5.piggyCoinEvery} m (${trail}) + a ring of ${ITEM5.piggyRing} on the burst: ${cs.looseLive} loose lire`);
    }
    // it bursts on touching an item
    placeAt(a, S, 0, 20);
    const peel = items._dropHazard(c, 'banana', track.pointAt(S + 20, 0));
    items.giveItem(a, 'piggy_bank'); items.useItem(a);
    itick(items, race, 60);
    ok(!peel.active && count('item:piggyBurst') >= 2, 'it bursts on touching an item (a peel)');
    // back with the brake: like a bouncer
    placeAt(a, S + 40, 0, 0);
    items.giveItem(a, 'piggy_bank'); a.input.brake = 1; items.useItem(a); a.input.brake = 0;
    const pb = ents(items, 'piggy')[0];
    ok(pb && pb.phase === 'back' && pb.dir.x * Math.sin(a.yaw) + pb.dir.z * Math.cos(a.yaw) < -0.9, 'brake held: thrown straight back');
    done(items);
  }

  // ------------------------------------------------------------------ A6
  section('items v5 A6: Parmesan Wheel (rolls through karts, sturdy, accordion deflects)');
  {
    events.length = 0;
    const { ks, race, items } = setup(4);
    const [a, b, c, d] = ks;
    placeAt(a, S, 0, 10); placeAt(b, S + 22, -0.8); placeAt(c, S + 34, 0.8); hold(ks);
    items.giveItem(a, 'parm_wheel'); items.useItem(a);
    const w = ents(items, 'wheel')[0];
    ok(w && w.sturdy && w.solid && w.speed >= ITEM5.wheelSpeed - 1e-6, 'a sturdy, solid wheel');
    itick(items, race, 110);
    ok(hits('parm_wheel', b) === 1 && hits('parm_wheel', c) === 1 && w.active, 'tumbles two karts in a row and keeps rolling');
    // a bouncer hitting it breaks, the wheel rolls on
    placeAt(d, track.project(w.position, -1, {}).s + 25, 0, 0, true);
    d.item = 'bouncer'; d.itemCount = 1; items.useItem(d);
    itick(items, race, 30);
    ok(items.projectiles.length === 0 && w.active, 'a bouncer breaks on it; the wheel rolls on');
    // the accordion only deflects it
    const ws = track.project(w.position, -1, {}).s;
    placeAt(d, ws + 8, w.lateral);
    const dir0 = w.dir.x * Math.sin(d.yaw) + w.dir.z * Math.cos(d.yaw);
    d.item = 'accordion'; d.itemCount = 1; items.useItem(d);
    const dir1 = w.dir.x * Math.sin(d.yaw) + w.dir.z * Math.cos(d.yaw);
    ok(w.active && dir0 > 0.5 && dir1 < 0, `the accordion deflects it (heading along the road ${dir0.toFixed(2)} → ${dir1.toFixed(2)})`);
    ok(items._countOf('parm_wheel') === 1 && ITEM_RULES.parm_wheel.max === 1, 'one in play (ITEM_RULES max 1: a live wheel counts)');
    // lives wheelLife s
    for (let i = 0; i < Math.ceil(ITEM5.wheelLife / DT) && w.active; i++) itick(items, race, 1);
    ok(!w.active, `gone after ${ITEM5.wheelLife} s or ${ITEM5.wheelBounces} wall bounces`);
    done(items);
  }

  // ------------------------------------------------------------------ A7
  section('items v5 A7: Surprise Egg (homes, tumbles, capsules give a roulette)');
  {
    events.length = 0;
    const { ks, race, items } = setup(4);
    const [a, b, c, d] = ks;
    placeAt(a, S, 0, 15); placeAt(b, S + 35, 3, 10);
    placeAt(c, track.wrapS(straight.s1 + 400), 0); placeAt(d, track.wrapS(straight.s1 + 430), 0);
    sync(race, ks); hold(ks);
    items.giveItem(a, 'surprise_egg'); items.useItem(a);
    const egg = ents(items, 'egg')[0];
    ok(egg && egg.target === b, 'homes on the kart one place ahead');
    for (let i = 0; i < 240 && egg.active; i++) tick(items, race, ks, 1);
    const caps = ents(items, 'capsule');
    ok(hits('surprise_egg', b) === 1 && b.tumbleTimer > 0 && caps.length === ITEM5.eggCapsules, `tumbles it and cracks into ${ITEM5.eggCapsules} capsules`);
    ok(caps.every((x) => x.position.distanceTo(egg.position) <= ITEM5.eggSpill + 1.5), `capsules within ${ITEM5.eggSpill} m of the crack`);
    // an empty-handed kart gets a roulette; a kart holding an item drives through
    const cp = caps[0];
    c.item = 'banana'; c.itemCount = 1;
    c.position.set(cp.position.x, cp.position.y - 0.75, cp.position.z); track.project(c.position, -1, c.proj);
    itick(items, race, 2);
    ok(cp.active && !c.rolling, 'a kart holding an item drives through a capsule');
    c.item = null; c.itemCount = 0;
    itick(items, race, 2);
    ok(ents(items, 'capsule').length === ITEM5.eggCapsules - 1 && c.rolling && !!c.rollItem, `an empty-handed kart gets a roulette for its place (${c.rollItem})`);
    // the accordion destroys an egg cleanly; a bomb blast cracks it
    for (const x of ents(items, 'capsule')) items.pluginContext('surprise_egg').remove(x, 'clear');
    placeAt(a, S, 0); placeAt(b, S + 60, 0); sync(race, ks);
    a.item = null; items.giveItem(a, 'surprise_egg'); items.useItem(a);
    const e2 = ents(items, 'egg')[0];
    itick(items, race, 20);
    placeAt(d, track.project(e2.position, -1, {}).s + 5, 0);
    d.item = 'accordion'; d.itemCount = 1; items.useItem(d);
    itick(items, race, 2);
    ok(!e2.active && ents(items, 'capsule').length === 0, 'the accordion destroys it cleanly (no capsules)');
    placeAt(d, track.wrapS(straight.s1 + 430), 0);
    for (const x of ents(items, 'capsule')) items.pluginContext('surprise_egg').remove(x, 'clear');
    items.giveItem(a, 'surprise_egg'); items.useItem(a);
    const e3 = ents(items, 'egg')[0];
    items._clearAround(e3.position.clone(), 6, null, false, 'bomb');
    itick(items, race, 2);
    ok(ents(items, 'egg').length === 0 && ents(items, 'capsule').length === ITEM5.eggCapsules, `a blast cracks it (capsules spill: ${ents(items, 'capsule').length})`);
    done(items);
  }

  // ------------------------------------------------------------------ A8
  section('items v5 A8: Prank Box (fake box, tumble, projectiles pass, road cap, Hard CPUs)');
  {
    events.length = 0;
    const { ks, race, items } = setup(4);
    const [a, b, c, d] = ks;
    placeAt(a, S + 30, 0); hold(ks);
    items.giveItem(a, 'prank_box'); items.useItem(a);
    const pb = ents(items, 'prank')[0];
    const pr = track.project(pb.position, -1, {});
    ok(pb && Math.abs(pb.position.y - pr.height - ITEM5.prankHover) < 0.05 && Math.abs(track.deltaS(pr.s, a.proj.s) - 2.2) < 0.2, 'dropped 2.2 m behind, hovering at box height');
    // projectiles pass through it
    placeAt(d, S, 0); d.item = 'bouncer'; d.itemCount = 1; items.useItem(d);
    itick(items, race, 25);
    ok(pb.active, 'projectiles pass through it');
    for (const p of items.projectiles.slice()) items._removeProjectile(p, 'clear');
    // a kart touching it tumbles
    placeAt(a, track.wrapS(straight.s1 + 300), 0);
    b.position.copy(pb.position); b.position.y = pr.height; b.invulnTimer = 0;
    itick(items, race, 2);
    ok(!pb.active && b.tumbleTimer > 0 && hits('prank_box', b) === 1, 'touching it tumbles the kart; the box is gone');
    // a star kart smashes it
    placeAt(a, S + 30, 0); items.giveItem(a, 'prank_box'); items.useItem(a);
    const p2 = ents(items, 'prank')[0];
    placeAt(a, track.wrapS(straight.s1 + 300), 0);
    c.startStar(); c.position.copy(p2.position); c.position.y -= ITEM5.prankHover;
    itick(items, race, 2);
    ok(!p2.active && c.tumbleTimer === 0, 'a star kart smashes it');
    c.starTimer = 0;
    // road cap (oldest recycled)
    for (let i = 0; i < ITEM5.prankMaxRoad + 2; i++) { placeAt(a, S + 10 + i * 8, 0); a.item = null; items.giveItem(a, 'prank_box'); items.useItem(a); }
    ok(ents(items, 'prank').length === ITEM5.prankMaxRoad, `at most ${ITEM5.prankMaxRoad} on the road`);
    // only Hard CPUs (150cc class) see through some; others treat it as a box
    const seen = (sys, k) => sys.getThreatsNear(k, 30).filter((t) => t.type === 'prank').length;
    placeAt(b, S, 0);
    let hard = 0;
    for (const k of [b, c, d]) { placeAt(k, S + 2, 0); hard += seen(items, k); }
    ok(hard > 0 && hard < 3 * ITEM5.prankMaxRoad, `Hard CPUs see through some boxes (${hard} of ${3 * ITEM5.prankMaxRoad} sightings)`);
    done(items);
    const n = setup(4, 0.9);
    n.items.giveItem(n.ks[0], 'prank_box');
    placeAt(n.ks[0], S + 10, 0); n.items.useItem(n.ks[0]);
    placeAt(n.ks[1], S, 0);
    ok(seen(n.items, n.ks[1]) === 0, 'Normal CPUs never see through it');
    done(n.items);
  }

  // ------------------------------------------------------------------ A9
  section('items v5 A9: Banana Split (giant peel, 1.6 s spin, splits in three)');
  {
    events.length = 0;
    const { ks, race, items } = setup(4);
    const [a, b, c, d] = ks;
    placeAt(a, S + 30, 0); hold(ks);
    items.giveItem(a, 'banana_split'); items.useItem(a);
    const sp = ents(items, 'split')[0];
    ok(sp && sp.radius === ITEM5.splitRadius && Math.abs(track.deltaS(track.project(sp.position, -1, {}).s, a.proj.s) - ITEM5.splitBack) < 0.25, `a giant peel (${ITEM5.splitRadius} m) ${ITEM5.splitBack} m behind`);
    placeAt(a, track.wrapS(straight.s1 + 300), 0);
    const peels0 = items.hazards.length;
    b.position.copy(sp.position); b.invulnTimer = 0;
    itick(items, race, 2);
    const peels = items.hazards.filter((h) => h.type === 'banana');
    ok(!sp.active && b.spinTimer > 1.5 && b.spinDuration === HIT.splitSpinTime && hits('banana_split', b) === 1, `a ${HIT.splitSpinTime} s spin`);
    ok(peels.length - peels0 === ITEM5.splitPeels && peels.every((h) => h.position.distanceTo(sp.position) < ITEM5.splitScatter), `then it splits into ${ITEM5.splitPeels} peels in a ${ITEM5.splitScatter} m triangle`);
    for (const h of items.hazards.slice()) items._removeHazard(h, 'clear');
    // the accordion wipes it out with no peels; a bomb blast splits it
    placeAt(a, S + 30, 0); items.giveItem(a, 'banana_split'); items.useItem(a); placeAt(a, track.wrapS(straight.s1 + 300), 0);
    const s2 = ents(items, 'split')[0];
    placeAt(d, track.project(s2.position, -1, {}).s + 5, 0);
    d.item = 'accordion'; d.itemCount = 1; items.useItem(d);
    itick(items, race, 2);
    ok(!s2.active && items.hazards.length === 0, 'the accordion destroys it with no peels');
    placeAt(d, track.wrapS(straight.s1 + 400), 0);
    placeAt(a, S + 30, 0); items.giveItem(a, 'banana_split'); items.useItem(a); placeAt(a, track.wrapS(straight.s1 + 300), 0);
    const s3 = ents(items, 'split')[0];
    items._clearAround(s3.position.clone(), 5, null, false, 'bomb');
    itick(items, race, 2);
    ok(!s3.active && items.hazards.filter((h) => h.type === 'banana').length === ITEM5.splitPeels, 'a blast splits it');
    for (const h of items.hazards.slice()) items._removeHazard(h, 'clear');
    for (let i = 0; i < 4; i++) { placeAt(a, S + 10 + i * 12, 0); items.giveItem(a, 'banana_split'); items.useItem(a); }
    ok(ents(items, 'split').length === ITEM5.splitMaxRoad, `at most ${ITEM5.splitMaxRoad} on the road`);
    done(items);
  }

  // ------------------------------------------------------------------ A10
  section('items v5 A10: Sour Lemon (shrink, a second lemon restores, squashed by a star)');
  {
    events.length = 0;
    const { ks, race, items } = setup(4);
    const [a, b, c] = ks;
    placeAt(a, S + 30, 0); hold(ks);
    items.giveItem(a, 'sour_lemon'); items.useItem(a);
    const l1 = ents(items, 'lemon')[0];
    placeAt(a, track.wrapS(straight.s1 + 300), 0);
    b.position.copy(l1.position); b.invulnTimer = 0;
    itick(items, race, 2);
    ok(!l1.active && b.shrinkTimer > 0 && Math.abs(b.shrinkTimer - HIT.shrinkTime) < 0.05 && hits('sour_lemon', b) === 1, `touching it shrinks the kart for ${HIT.shrinkTime} s`);
    placeAt(a, S + 30, 0); items.giveItem(a, 'sour_lemon'); items.useItem(a); placeAt(a, track.wrapS(straight.s1 + 300), 0);
    const l2 = ents(items, 'lemon')[0];
    b.position.copy(l2.position); b.invulnTimer = 0;
    itick(items, race, 2);
    ok(!l2.active && !(b.shrinkTimer > 0), 'a second lemon while shrunk restores normal size');
    placeAt(a, S + 30, 0); items.giveItem(a, 'sour_lemon'); items.useItem(a); placeAt(a, track.wrapS(straight.s1 + 300), 0);
    const l3 = ents(items, 'lemon')[0];
    c.startStar(); c.position.copy(l3.position);
    itick(items, race, 2);
    ok(!l3.active && !(c.shrinkTimer > 0), 'a star kart squashes it');
    for (let i = 0; i < 6; i++) { placeAt(a, S + 10 + i * 8, 0); items.giveItem(a, 'sour_lemon'); items.useItem(a); }
    ok(ents(items, 'lemon').length === ITEM5.lemonMaxRoad, `at most ${ITEM5.lemonMaxRoad} on the road`);
    done(items);
  }

  // ------------------------------------------------------------------ A11
  section('items v5 A11: Padella Slam (beats, slam, drops items, airborne dodge, cooldown)');
  {
    events.length = 0;
    const { ks, race, items } = setup(5, 0.8);           // 50cc: Easy CPUs never hop-dodge
    const [a, b, c, d, e] = ks;
    placeAt(a, S, 0); placeAt(b, S + 20, 2); placeAt(c, S + 30, -2); placeAt(d, S + 40, 0);
    placeAt(e, track.wrapS(S - 30), 0);
    sync(race, ks); hold(ks);
    b.item = 'banana'; b.itemCount = 1; c.item = 'rocket'; c.itemCount = 1;
    items.giveItem(a, 'padella'); items.useItem(a);
    ok(count('item:padellaWarn', (x) => x.kart === a && x.victims.length === 3 && !x.victims.includes(e)) === 1, 'pans over every kart ahead (not the one behind)');
    ok(items._countOf('padella') === 1, 'in play while the pans hang (countLive)');
    let beats = 0;
    for (let i = 0; i < Math.round(1.7 / DT); i++) { itick(items, race, 1); beats = Math.max(beats, b.panWarn || 0); }
    ok(beats === 3 && count('item:padellaBeat') === 3 && !b.spinTimer, 'three beats (kart.panWarn 1..3), no slam yet');
    // d is airborne at the slam: dodged
    d.grounded = false; d.velocity.y = 2;
    for (let i = 0; i < Math.round(0.2 / DT); i++) itick(items, race, 1);
    ok(b.spinTimer > 0 && c.spinTimer > 0 && d.spinTimer === 0 && e.spinTimer === 0, 'the slam spins grounded karts ahead; an airborne one dodges');
    ok(!b.item && !c.item && items.hazards.some((h) => h.type === 'banana' && h.owner === b), 'held items dropped: a banana lands as a hazard, a rocket is lost');
    ok(count('item:hit', (x) => x.item === 'padella' && !x.light) === 2, 'item:hit (a normal hit: 2 lire)');
    ok(Math.abs(items._blockedUntil.padella - (race.time + ITEM_RULES.padella.cooldown)) < 0.3, `cooldown ${ITEM_RULES.padella.cooldown} s from the slam`);
    itick(items, race, 120);
    ok(items._countOf('padella') === 0, 'done after the slam');
    done(items);
  }

  // ------------------------------------------------------------------ A12
  section('items v5 A12: Taralli Hoops (three rings ahead, a boost each, for anyone)');
  {
    events.length = 0;
    const { ks, race, items } = setup(4);
    const [a, b] = ks;
    placeAt(a, S, 0); hold(ks);
    items.giveItem(a, 'taralli'); items.useItem(a);
    const rings = ents(items, 'ring').sort((x, y) => x.data.n - y.data.n);
    ok(rings.length === 3 && rings.every((r, i) => Math.abs(track.deltaS(S, r.s) - ITEM5.ringAt[i]) < 0.01), `rings at +${ITEM5.ringAt.join(' / +')} m along the track`);
    ok(rings.every((r) => Math.abs(r.position.y - track.frameAt(r.s).y - ITEM5.ringHeight) < 0.3), `centred ${ITEM5.ringHeight} m up`);
    // a follower drives through all three: a pad boost at each, once
    placeAt(b, S - 5, rings[0].lateral, 22);
    b.input.throttle = 1;
    let boosts = 0;
    const off = bus.on('item:ringBoost', (x) => { if (x.kart === b) boosts++; });
    for (let i = 0; i < 200; i++) {
      // steer along the rings' line
      const r = rings.find((x) => track.deltaS(b.proj.s, x.s) > 0) || rings[2];
      b.position.x += (track.pointAt(b.proj.s, r.lateral).x - b.position.x) * 0.2;
      b.position.z += (track.pointAt(b.proj.s, r.lateral).z - b.position.z) * 0.2;
      tick(items, race, [b], 1);
    }
    off();
    ok(boosts === 3 && count('kart:boost', (x) => x.kart === b && x.source === 'pad') >= 3, `a rival takes all three boosts (${boosts}), pad-strength (washes ink)`);
    for (const r of rings) r.data.side.fill(-1);
    placeAt(b, S, rings[0].lateral, 0);
    tick(items, race, [b], 2);
    ok(boosts === 3, 'once per kart per ring');
    itick(items, race, Math.ceil(ITEM5.ringLife / DT));
    ok(ents(items, 'ring').length === 0, `rings last ${ITEM5.ringLife} s`);
    done(items);
  }

  // ------------------------------------------------------------------ A13
  section("items v5 A13: Befana's Broom (soot ahead, coal clusters, cooldown)");
  {
    events.length = 0;
    const { ks, race, items } = setup(5);
    const [a, b, c, d, e] = ks;
    placeAt(a, S - 10, 0); placeAt(b, S + 20, 3); placeAt(c, S + 35, -8); placeAt(d, S + 50, 0); placeAt(e, track.wrapS(S - 40), 0);
    sync(race, ks); hold(ks);
    items.giveItem(a, 'befana'); items.useItem(a);
    ok(count('item:befana', (x) => x.kart === a) === 1 && items._countOf('befana') === 1, 'she takes off (one in play)');
    for (let i = 0; i < Math.round(ITEM5.befanaLife / DT) && ents(items, 'befana').length; i++) itick(items, race, 1);
    ok(b.sootTimer > 0 && d.sootTimer > 0 && !(e.sootTimer > 0) && !(a.sootTimer > 0), 'karts ahead she passes close to are sooted (not the user, not karts behind)');
    ok(!(c.sootTimer > 0), `a kart > ${ITEM5.befanaHexRadius} m off to the side escapes`);
    b.item = 'banana'; b.itemCount = 1;
    ok(!items.useItem(b) && b.item === 'banana', 'a sooted kart cannot use items');
    ok(count('item:hit', (x) => x.item === 'befana' && x.effect === 'soot' && x.coinLoss === 0) === 2, 'soot: item:hit with coinLoss 0');
    const coal = ents(items, 'coal');
    ok(coal.length >= ITEM5.coalPerDrop && coal.length <= ITEM5.coalDrops * ITEM5.coalPerDrop && coal.length % ITEM5.coalPerDrop === 0, `clusters of ${ITEM5.coalPerDrop} coal lumps ahead of the front-most karts (${coal.length / ITEM5.coalPerDrop}, <= ${ITEM5.coalDrops})`);
    let minGap = Infinity;
    for (const x of coal) for (const y of coal) if (x !== y) minGap = Math.min(minGap, x.position.distanceTo(y.position) - 2 * ITEM5.coalRadius);
    ok(minGap >= ITEM5.coalGap, `coal gaps >= ${ITEM5.coalGap} m (${minGap.toFixed(2)})`);
    ok(Math.abs(items._blockedUntil.befana - (race.time + ITEM_RULES.befana.cooldown)) < 0.5, `cooldown ${ITEM_RULES.befana.cooldown} s from the end`);
    // a lump spins whoever touches it; the accordion clears them
    const lump = coal[0];
    e.position.copy(lump.position); e.invulnTimer = 0; e.sootTimer = 0;
    itick(items, race, 50);
    ok(!lump.active && e.spinTimer > 0, 'a coal lump spins a kart and breaks');
    const lump2 = ents(items, 'coal')[0];
    placeAt(e, track.project(lump2.position, -1, {}).s - 3, 0); e.spinTimer = 0;
    e.item = 'accordion'; e.itemCount = 1; e.sootTimer = 0; items.useItem(e);
    ok(!lump2.active, 'the accordion clears coal');
    itick(items, race, Math.ceil(ITEM5.coalLife / DT));
    ok(ents(items, 'coal').length === 0, `coal lasts ${ITEM5.coalLife} s`);
    done(items);
  }

  // ------------------------------------------------------------------ CPUs
  section('ai v5: CPUs use every group-A item (aiUse)');
  {
    const used = {}, braked = {};
    for (const id of GROUP_A) {
      const { ks, race, items } = setup(5);
      const [a, b, c, d, e] = ks;
      // a pack: two rivals ahead on the straight, one behind, one far ahead
      placeAt(e, S - 8, 0.5, 20); placeAt(a, S + 4, 0, 20); placeAt(b, S + 22, 0.5, 20); placeAt(c, S + 45, -0.5, 20); placeAt(d, track.wrapS(S + 110), 0, 20);
      sync(race, ks);
      const ai = new AIDriver(a, { track, difficulty: 'hard', skill: 0.92, rng: makeRng(7) });
      items.giveItem(a, id);
      const actx = { karts: ks, items, race };
      let t = 0;
      for (; t < 14 && !used[id]; t += DT) {
        a.input.useItem = false; a.input.brake = 0;
        ai._items(DT, actx, a.proj.s, 20);
        if (a.input.useItem) { used[id] = t; braked[id] = a.input.brake === 1; }
      }
      done(items);
    }
    // lures (ai.js plugin lures): a CPU steers for a ring near its line, and for a prank box it takes for an item box
    {
      const { ks, race, items } = setup(4, 0.9);
      const [a, b] = ks;
      placeAt(a, S, 0); placeAt(b, S - 6, 1.5); hold(ks);
      items.giveItem(a, 'taralli'); items.useItem(a);
      const lc = { s: b.proj.s, speed: 20, skill: 0.8, plannedLat: () => 1.5, baseLat: () => 1.5 };
      const lr = getItemHandler('taralli').aiLure(items.pluginContext('taralli'), b, lc);
      ok(lr && Math.abs(track.deltaS(b.proj.s, lr.s) - (ITEM5.ringAt[0] + 6)) < 0.5 && lr.urgency < 0.5, 'a CPU near the rings steers for the next one (aiLure)');
      placeAt(a, S + 30, 0); a.item = null; items.giveItem(a, 'prank_box'); items.useItem(a);
      b.item = null; b.rolling = false;
      const pl = getItemHandler('prank_box').aiLure(items.pluginContext('prank_box'), b, lc);
      ok(pl && pl.urgency > 0 && pl.urgency < 0.5, 'an empty-handed Normal CPU goes for a prank box like an item box (aiLure)');
      b.item = 'banana';
      ok(!getItemHandler('prank_box').aiLure(items.pluginContext('prank_box'), b, lc), '... but not while holding an item');
      done(items);
    }
    const missing = GROUP_A.filter((id) => used[id] === undefined);
    ok(!missing.length, `a CPU uses every group-A item within 14 s (${GROUP_A.map((id) => `${id} ${used[id] !== undefined ? used[id].toFixed(1) : '-'}`).join(', ')}) missing: ${missing}`);
  }

  offAll();
  ok(errors === 0, `no plugin hook errors in the group-A tests (${errors})`);
}

// standalone
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let passes = 0, fails = 0;
  await itemsATests({
    ok: (c, msg) => { if (c) passes++; else { fails++; console.log('  FAIL:', msg); } },
    section: (t) => console.log(`\n== ${t}`),
  });
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
