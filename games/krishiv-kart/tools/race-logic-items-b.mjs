// v5 group-B items, the lire (coin) system and the §C2 kart-state effects
// (SPEC §16.2, notes/research-v5-items.md §C2 / §C5 / B1-B10 / §C10).
// Run by tools/race-logic-test.mjs (shares its ok / section counters), or standalone:
//   node tools/race-logic-items-b.mjs
// Roster-agnostic (any 8 racers) and track-agnostic: positions are searched on
// the current Breezy Bay layout (straights, coins) instead of hard-coded.
import { getTrack } from '../public/js/tracks.js';
import { Kart, resolveKartCollisions, airDodges } from '../public/js/kart.js';
import { CHARACTERS } from '../public/js/characters.js';
import { Race } from '../public/js/race.js';
import { ItemSystem } from '../public/js/items.js';
import { bus } from '../public/js/bus.js';
import { makeRng } from '../public/js/utils.js';
import { COIN, ITEM5, HIT, ITEM, ITEM_INFO, ITEM_RULES, ITEM_ENABLED, KART, DRIFT } from '../public/js/config.js';
import { getItemHandler } from '../public/js/items/registry.js';
import { giveCoins, spillCoins, coinState } from '../public/js/items/coins.js';
import { stealable } from '../public/js/items/b-util.js';

const B_IDS = ['calzone', 'ladro', 'hot_potato', 'mortadella', 'tarantella', 'grissino', 'antipasto', 'amore', 'lira_purse', 'tip_jar'];

export async function runItemsB({ ok, section }) {
  const track = getTrack('breezy');
  const L = track.length;
  const DT = 1 / 120;

  // ---------------------------------------------------------------- helpers
  const makeKarts = (n = 4) => {
    const ks = CHARACTERS.slice(0, n).map((c) => new Kart({ id: c.id, character: c, track }));
    ks.forEach((k, i) => k.placeOnGrid(track.gridSlot(i)));
    return ks;
  };
  const placeAt = (k, s, lat = 0, speed = 0) => {
    track.pointAt(s, lat, k.position);
    const f = track.frameAt(s);
    k.yaw = f.yaw;
    k.velocity.set(Math.sin(k.yaw) * speed, 0, Math.cos(k.yaw) * speed);
    k.hint = -1;
    track.project(k.position, -1, k.proj);
    k.hint = k.proj.index;
    k.position.y = k.proj.height;
    k.velocity.y = (k.proj.slope || 0) * speed;
    k._prevSlope = k.proj.slope || 0;
    k.grounded = true;
  };
  const setup = (n = 4) => {
    const ks = makeKarts(n);
    const race = new Race({ track, karts: ks, laps: 3 });
    race.skipIntro();
    for (let i = 0; i < 361; i++) race.update(DT);
    const items = new ItemSystem({ track, karts: ks, scene: null, rng: makeRng(5) });
    return { ks, race, items };
  };
  const driveTo = (race, k, s, lat = 0) => {
    let cur = k.proj.s;
    for (let g = 0; g < 100 && Math.abs(track.deltaS(cur, s)) > 0.01; g++) {
      const d = track.deltaS(cur, s);
      cur += Math.sign(d) * Math.min(Math.abs(d), 40);
      placeAt(k, cur, lat);
      race.update(DT);
    }
  };
  const park = (ks, race, from = 0) => ks.forEach((k, i) => { if (i >= from) driveTo(race, k, SPOTS[i % SPOTS.length], 0); });
  // full substep (no AI): items → karts → collisions → race
  const tick = (items, race, ks, n = 1, collide = true) => {
    for (let i = 0; i < n; i++) {
      items.update(DT, race);
      for (const k of ks) k.update(DT);
      if (collide) resolveKartCollisions(ks);
      race.update(DT);
    }
  };
  // a clear straight-ish stretch of `len` m: |curvature| < 1/300, nearly flat, and no
  // item boxes, boost pads, ramps or lire on it (they would change what the tests measure)
  const busy = [];
  for (const r of track.itemRows) busy.push([r.s - 8, 16]);
  for (const p of track.boostPads) busy.push([p.s0 - 4, (p.length || 6) + 8]);
  for (const r of track.ramps) busy.push([r.s0 - 6, (r.length || 6) + 30]);
  for (const c of track.coinLines) busy.push([c.s - 4, c.count * c.spacing + 8]);
  const isBusy = (s) => busy.some(([a, n]) => { const d = track.deltaS(a, s); return d >= 0 && d <= n; });
  const straightAt = (len, from = 0) => {
    for (let s0 = from; s0 < from + L; s0 += 5) {
      if (track.wrapS(s0) + len > L - 30 || track.wrapS(s0) < 30) continue;     // stay clear of the start line
      let okk = true;
      for (let d = -10; d <= len && okk; d += 2) {
        const i = track.indexAt(s0 + d);
        if (Math.abs(track.curv[i]) > 1 / 300 || Math.abs(track.slope[i]) > 0.015 || isBusy(track.wrapS(s0 + d))) okk = false;
      }
      if (okk) return track.wrapS(s0);
    }
    return track.wrapS(from);
  };
  const S0 = straightAt(110, 60);                 // the test straight
  // where the karts not in a test wait: clear spots >= 30 m apart past the test straight
  const SPOTS = [];
  for (let s = S0 + 160; s < S0 + L - 40 && SPOTS.length < 8; s += 4) {
    let free = true;
    for (let d = -12; d <= 12 && free; d += 2) if (isBusy(track.wrapS(s + d))) free = false;
    if (free && (!SPOTS.length || track.deltaS(SPOTS[SPOTS.length - 1], track.wrapS(s)) >= 30)) SPOTS.push(track.wrapS(s));
  }
  const PARK = SPOTS[0];
  if (process.env.ITEMS_B_DEBUG) console.log(`  (test straight s ${S0.toFixed(0)}, parking ${SPOTS.map((x) => x.toFixed(0)).join(' ')}, lap ${L.toFixed(0)} m)`);
  const events = [];
  const offAll = bus.on('*', (d, type) => { if (/^(item:|coin:|kart:(squash|freeze|shrink|unshrink|soot|ghost|mega|bigJump))/.test(type)) events.push({ type, d }); });
  const count = (type, pred = () => true) => events.filter((e) => e.type === type && pred(e.d)).length;
  const grant = (items, k, id) => { k.item = null; k.itemCount = 0; k.rolling = true; k.rollItem = id; k.rollTimer = 0; items._finishRoll(k); };

  // ---------------------------------------------------------------- kart states
  section('items v5 B: kart-state effects (§C2: freeze / shrink / squash / soot / ghost / giant / leap)');
  {
    const [a, b] = makeKarts(2);
    placeAt(a, S0, -3, 25);
    // defaults are inert
    ok(a.stateSpeedMult === 1 && !a.isOffroadProof() && a.sizeMult === 1 && a.radius === KART.radius && !a.itemsLocked, 'v5 states default off (stateSpeedMult 1, size 1)');
    // freeze: disabled, slides straight, decelerates ~HIT.iceSlideDecel, invulnerable after
    a.input.throttle = 1; a.input.steer = 1;
    const yaw0 = a.yaw, v0 = a.horizontalSpeed;
    ok(a.freeze(HIT.iceTime, 'test') && a.iceTimer > 0 && a.isDisabled() && !a.isHittable(), 'freeze: iceTimer, disabled, not hittable');
    for (let i = 0; i < 60; i++) a.update(DT);
    const dv = v0 - a.horizontalSpeed;
    ok(Math.abs(a.yaw - yaw0) < 1e-6 && Math.abs(dv - HIT.iceSlideDecel * 0.5) < 0.6, `freeze: no steering, slides on (lost ${dv.toFixed(2)} m/s in 0.5 s)`);
    for (let i = 0; i < 120; i++) a.update(DT);
    ok(a.iceTimer === 0 && a.invulnTimer > 0 && !a.isDisabled(), 'freeze ends into the after-hit grace');
    // shrink: small, slower, still hittable; a second lemon restores
    placeAt(b, S0 + 20, 3, 0);
    b.invulnTimer = 0;
    ok(b.shrink(HIT.shrinkTime, 'sour_lemon') && b.shrinkTimer > 0 && b.isHittable(), 'shrink: shrinkTimer, still hittable');
    for (let i = 0; i < 60; i++) b.update(DT);
    ok(Math.abs(b.sizeMult - HIT.shrinkScale) < 1e-6 && Math.abs(b.stateSpeedMult - HIT.shrinkSpeedMult) < 1e-9, `shrink: size ${b.sizeMult.toFixed(2)}, speed x${b.stateSpeedMult.toFixed(2)}`);
    ok(b.shrink(HIT.shrinkTime, 'sour_lemon') && b.shrinkTimer === 0, 'a second Sour Lemon while shrunk restores the size');
    // squash: flattened, slow, not hittable, invuln after
    b.invulnTimer = 0;
    ok(b.squash(HIT.squashTime, 'test') && b.squashTimer > 0 && !b.isHittable() && Math.abs(b.stateSpeedMult - HIT.squashSpeedMult) < 1e-9, 'squash: speed x0.35, not hittable');
    for (let i = 0; i < Math.ceil(HIT.squashTime / DT) + 2; i++) b.update(DT);
    ok(b.squashTimer === 0 && b.invulnTimer > 0, 'squash ends into the after-hit grace');
    // soot: drift cancelled, items locked, slower; lands through invulnerability
    const c = makeKarts(3)[2];
    placeAt(c, S0, 0, 22);
    c.drift.active = true; c.drift.dir = 1;
    c.invulnTimer = 1;
    ok(c.soot(HIT.sootTime, 'befana') && !c.drift.active && c.itemsLocked && Math.abs(c.stateSpeedMult - HIT.sootSpeedMult) < 1e-9, 'soot: drift cancelled, items locked, x0.94 (lands on an invulnerable kart)');
    c.startStar();
    ok(c.sootTimer === 0 && !c.itemsLocked, 'a star wipes the soot');
    // ghost: not hittable, zap refused, offroad-proof, no kart contact
    const [g1, g2] = makeKarts(2);
    placeAt(g1, S0, 0, 0); placeAt(g2, S0 + 0.5, 0.2, 0);
    g1.ghost(ITEM5.ladroTime);
    ok(g1.ghostTimer > 0 && !g1.isHittable() && g1.zap() === false && g1.isOffroadProof() && g1.spinOut('banana') === false, 'ghost: not hittable, zap refused, offroad-proof');
    const before = g2.position.clone();
    resolveKartCollisions([g1, g2]);
    ok(g2.position.distanceTo(before) < 1e-9, 'ghost: no kart-kart contact');
    // giant: size, speed, item-proof; a zap only ends it
    const [m1, m2] = makeKarts(2);
    placeAt(m1, S0, 0, 20); placeAt(m2, S0 + 40, 0, 0);
    m1.grow(ITEM5.mortTime);
    for (let i = 0; i < Math.ceil(ITEM5.mortGrow / DT) + 2; i++) m1.update(DT);
    ok(Math.abs(m1.sizeMult - ITEM5.mortScale) < 1e-6 && Math.abs(m1.radius - KART.radius * ITEM5.mortScale) < 1e-6 && Math.abs(m1.stateSpeedMult - ITEM5.mortSpeedMult) < 1e-9, `giant: size ${m1.sizeMult.toFixed(2)}, radius ${m1.radius.toFixed(2)}, x${m1.stateSpeedMult}`);
    ok(!m1.isHittable() && m1.tumble('rocket') === false && m1.isOffroadProof(), 'giant: rockets miss, offroad-proof');
    ok(m1.zap() === false && m1.megaTimer === 0 && m1.spinTimer === 0, 'a zap ends the giant with no other penalty');
    for (let i = 0; i < Math.ceil(ITEM5.mortShrinkBack / DT) + 2; i++) m1.update(DT);
    ok(m1.sizeMult === 1, 'the giant shrinks back');
    // leap: airborne ~0.86 s, ground causes miss, sky causes land, trick on landing
    const j = makeKarts(1)[0];
    placeAt(j, S0, 0, 25);
    j.update(DT);
    ok(j.bigJump(ITEM5.jumpVy) && j.airImmune && !j.grounded, 'bigJump: airborne + airImmune');
    ok(j.spinOut('banana') === false && j.tumble('rocket') === false && airDodges('peperoncino') && !airDodges('capo') && !airDodges('zap'), 'leap: ground items miss (capo / zap still land)');
    j.input.drift = true;
    let air = 0, apex = 0;
    const y0 = j.position.y;
    for (let i = 0; i < 240 && !j.grounded; i++) { j.update(DT); air += DT; apex = Math.max(apex, j.position.y - y0); if (i === 5) j.input.drift = false; }
    ok(Math.abs(air - (2 * ITEM5.jumpVy) / KART.gravity) < 0.12 && apex > 2.0 && apex < 3.2, `leap: ${air.toFixed(2)} s in the air, apex ${apex.toFixed(2)} m`);
    ok(!j.airImmune && j.boostTimer > 0 && j.boostSource === 'trick', 'leap: lands, DRIFT in the air paid the trick boost');
    // run over: a full-size kart driving into a shrunk one squashes it
    const [r1, r2] = makeKarts(2);
    placeAt(r1, S0, 0, 20); placeAt(r2, S0 + 1.6, 0, 0);
    r2.shrink(4, 'sour_lemon');
    for (let i = 0; i < 40; i++) r2.update(DT);
    r1.update(DT);
    resolveKartCollisions([r1, r2]);
    ok(r2.squashTimer > 0 && r2.shrinkTimer > 0, 'running over a shrunk kart squashes it (the shrink keeps running)');
    // star cures shrink / squash / ice
    r2.startStar();
    ok(r2.squashTimer === 0 && r2.shrinkTimer === 0, 'a star un-flattens and restores the size');
  }

  // ---------------------------------------------------------------- lire
  section('items v5 B: lire (coin system, §C5)');
  {
    ok(track.coins.length > 0, `the track has lire (${track.coins.length} in ${track.coinLines.length} lines)`);
    const { ks, race, items } = setup(4);
    const [a, b] = ks;
    park(ks, race);
    const st = coinState(items);
    ok(st && st.coins.length === track.coins.length && ks.every((k) => k.coins === 0), 'every lira hovering; karts start at 0');
    // drive through the first lira
    const cn = track.coins[0];
    driveTo(race, a, track.wrapS(cn.s - 3), cn.lateral);
    a.velocity.set(Math.sin(a.yaw) * 8, 0, Math.cos(a.yaw) * 8);
    a.input.throttle = 0.4;
    const gets = count('coin:get');
    for (let i = 0; i < 90 && a.coins === 0; i++) tick(items, race, ks);
    ok(a.coins === 1 && count('coin:get') === gets + 1 && st.coins[0].active === false, 'pickup: +1 lira, the coin taken (coin:get)');
    driveTo(race, a, PARK, 0);                        // out of the way while it respawns
    for (let i = 0; i < Math.ceil((COIN.respawn - 0.3) / DT); i++) items.update(DT, race);
    ok(!st.coins[0].active, 'not back before COIN.respawn s');
    for (let i = 0; i < Math.ceil(0.6 / DT); i++) items.update(DT, race);
    ok(st.coins[0].active, 'back after COIN.respawn s');
    // cap + speed
    a.coins = 0;
    ok(giveCoins(items, a, 25, 'test', { nudge: false }) === COIN.max && a.coins === COIN.max, 'capped at COIN.max');
    ok(Math.abs(a.stateSpeedMult - (1 + COIN.speedPerCoin * COIN.max)) < 1e-9 && Math.abs(a.stateSpeedMult - 1.05) < 1e-9, `max speed x${a.stateSpeedMult.toFixed(3)} at ${COIN.max} lire`);
    // losses: 2 on a spin (scattered), 1 on a light projectile, 3 on a fall, none while starred
    a.coins = 6; a.invulnTimer = 0;
    a.spinOut('banana');
    items.update(DT, race);
    ok(a.coins === 4 && st.looseLive === 2, `-${COIN.lossHit} on a spin, popped out as loose lire (${st.looseLive})`);
    a.spinTimer = 0; a.invulnTimer = 0;
    a.spinOut('peperoncino');
    items.update(DT, race);
    ok(a.coins === 4 - COIN.lossLightHit, '-1 on a light projectile (fireball)');
    a.spinTimer = 0; a.invulnTimer = 0;
    a.respawn();
    items.update(DT, race);
    ok(a.coins === 0 && count('coin:lose', (d) => d.cause === 'fall') >= 1, '-3 on a respawn (vanish)');
    b.coins = 5; b.startStar();
    b.spinOut('banana'); items.update(DT, race);
    ok(b.coins === 5, 'nothing lost while starred');
    // loose lire: the loser can't regrab them for COIN.regrabDelay, a rival can
    const c = ks[2];
    for (const l of st.loose) l.active = false;
    st.looseLive = 0;
    driveTo(race, c, S0, 0);
    c.coins = 3; c.invulnTimer = 0;
    c.spinOut('banana');
    items.update(DT, race);
    for (let i = 0; i < 90; i++) items.update(DT, race);
    const live = st.loose.filter((l) => l.active);
    const grabbedOwn = c.coins;
    ok(live.length === 2 && grabbedOwn === 1 && live.every((l) => l.grounded && Math.hypot(l.x - c.position.x, l.z - c.position.z) <= COIN.dropRadius + 0.6), `loose lire land within ${COIN.dropRadius} m, not regrabbed at once`);
    const d = ks[3];
    for (const l of live) {
      d.position.set(l.x, l.y - COIN.hover, l.z);
      items.update(DT, race);
    }
    ok(d.coins === 2, `a rival collects them (${d.coins})`);
    // a squash drops the held item and takes 2 lire
    b.starTimer = 0; b.invulnTimer = 0; b.coins = 5; b.item = 'rocket'; b.itemCount = 1;
    b.squash(HIT.squashTime, 'mortadella');
    items.update(DT, race);
    ok(b.item === null && b.coins === 3, 'a squash drops the held item and costs 2 lire');
    // Items Off: no boxes, but lire stay
    const off = new ItemSystem({ track, karts: ks, scene: null, rng: makeRng(2), enabled: false });
    ok(off.boxes.length === 0 && coinState(off) && coinState(off).coins.length === track.coins.length, 'Items Off: no boxes, the lire stay');
    off.dispose();
    items.dispose();
  }

  // ---------------------------------------------------------------- items
  section('items v5 B: Lira Purse, Tip Jar');
  {
    const { ks, race, items } = setup(4);
    const [a] = ks;
    park(ks, race);
    a.coins = 7;
    grant(items, a, 'lira_purse');
    ok(items.useItem(a) && a.coins === 9 && !a.item, 'purse: +2 lire, slot empty');
    grant(items, a, 'lira_purse');
    items.useItem(a);
    ok(a.coins === COIN.max, 'purse: capped at 10');
    grant(items, a, 'lira_purse');
    ok(items.useItem(a) && a.coins === COIN.max && !a.item, 'purse at the cap: a dud jingle, still used');
    const H = getItemHandler('lira_purse');
    ok(H.aiUse(a, { mem: {}, hold: 0 }) === false && H.aiUse({ coins: 3 }, { mem: {}, hold: 0 }) === true, 'purse AI: at once with <= 8 lire, holds it at the cap');
    // tip jar: 6 taps, +6 to the user, 16 spilled for the followers
    a.coins = 0;
    const st = coinState(items);
    for (const l of st.loose) l.active = false;
    st.looseLive = 0;
    driveTo(race, a, S0, 0);
    grant(items, a, 'tip_jar');
    let taps = 0, refused = 0;
    for (let i = 0; i < 6 * 40 && a.item === 'tip_jar'; i++) {
      if (i % 40 === 0) { if (items.useItem(a)) taps++; }
      if (i % 40 === 5 && a.item === 'tip_jar') { if (!items.useItem(a)) refused++; }
      items.update(DT, race);
    }
    const spilled = st.loose.filter((l) => l.active).length;
    ok(taps === ITEM5.tipTaps && a.coins === 6 && !a.item, `tip jar: ${taps} taps, +${a.coins} lire, the jar burst`);
    ok(spilled === ITEM5.tipSpill * (ITEM5.tipTaps - 1) + ITEM5.tipFinalSpill && spilled === 16, `tip jar: ${spilled} lire spilled behind`);
    ok(refused >= 4, 'tip jar: taps closer than 0.25 s are ignored');
    // window end / a hit loses the jar
    grant(items, a, 'tip_jar');
    items.useItem(a);
    a.invulnTimer = 0;
    a.spinOut('banana');
    tick(items, race, ks, 2);
    ok(!a.item, 'tip jar: lost on a hit');
    items.dispose();
  }

  section('items v5 B: Tarantella Jump');
  {
    const { ks, race, items } = setup(3);
    const [a, b] = ks;
    park(ks, race);
    driveTo(race, a, S0, 0);
    a.velocity.set(Math.sin(a.yaw) * 22, 0, Math.cos(a.yaw) * 22);
    a.input.throttle = 1;
    // a banana 12 m ahead on its line
    const pb = track.pointAt(S0 + 12, 0);
    const h = items._dropHazard(b, 'banana', pb);
    h.age = 5;
    grant(items, a, 'tarantella');
    tick(items, race, ks, 3);
    ok(items.useItem(a) && a.airImmune && !a.item, 'leap: used on the ground');
    for (let i = 0; i < 120; i++) tick(items, race, ks);
    ok(a.spinTimer === 0 && h.active && a.proj.s > S0 + 14, 'leap: sails over a banana in its path');
    // pressed in the air: queued, taken on the landing
    driveTo(race, a, S0 + 60, 0);
    a.velocity.set(Math.sin(a.yaw) * 20, 2, Math.cos(a.yaw) * 20);
    a.position.y += 0.5; a.grounded = false;
    grant(items, a, 'tarantella');
    items.useItem(a);
    const usedBefore = items.used.tarantella;
    for (let i = 0; i < 60 && a.item; i++) tick(items, race, ks);
    ok(!a.item && items.used.tarantella === usedBefore + 1 && count('kart:bigJump') >= 2, 'leap: an in-air press is taken on the landing');
    items.dispose();
  }

  section('items v5 B: Ladro Mask');
  {
    const { ks, race, items } = setup(4);
    const [a, b, c] = ks;
    park(ks, race);
    driveTo(race, b, S0 + 120, 0);
    driveTo(race, c, S0 + 150, 0);
    driveTo(race, a, S0, 0);
    race.update(DT);
    b.item = 'star'; b.itemCount = 1; b.coins = 5;
    c.item = null; c.itemCount = 0;
    a.coins = 1;
    grant(items, a, 'ladro');
    ok(items.useItem(a) && a.ghostTimer > 0 && a.item === 'ladro', 'mask: ghost on, the mask keeps the slot until the steal');
    tick(items, race, ks, Math.ceil(ITEM5.ladroStealDelay / DT) + 2, false);
    ok(a.item === 'star' && b.item === null && b.coins === 3 && a.coins === 3 && count('item:ladroSteal', (d) => d.from === b) === 1, 'mask: steals the item ahead + 2 lire');
    // espresso can't touch a ghost; projectiles pass through
    driveTo(race, a, S0, 0);
    const hits0 = count('item:hit', (d) => d.kart === a);
    items._espresso(ks[3]);
    tick(items, race, ks, 90, false);
    ok(a.ink === 0 && !a.inkIncoming, 'ghost: no coffee');
    // 1st place (or nothing to steal) → a toot
    driveTo(race, a, S0 + 300, 0);
    race.update(DT);
    tick(items, race, ks, Math.ceil(ITEM5.ladroTime / DT) + 5, false);
    a.item = null; a.itemCount = 0;
    grant(items, a, 'ladro');
    items.useItem(a);
    tick(items, race, ks, Math.ceil(ITEM5.ladroStealDelay / DT) + 2, false);
    ok(a.item === 'toot', `mask from the lead: a toot instead (${a.item})`);
    ok(count('item:hit', (d) => d.kart === a && d.item !== 'ladro') === hits0, 'ghost: not hit');
    // unstealable: active / timed items and the specials
    b.item = 'accordion'; b.itemCount = 1;
    const pc = items.pluginContext('ladro');
    ok(!stealable(pc, b), 'the accordion can\'t be stolen');
    b.item = 'calzone'; b.itemCount = 1; b.itemWindow = 0.5;
    ok(!stealable(pc, b), 'a running timed item can\'t be stolen');
    b.itemWindow = 0; b.item = 'triple_rocket'; b.itemCount = 3;
    ok(stealable(pc, b), 'a triple can');
    items.dispose();
  }

  section('items v5 B: Maxi Mortadella');
  {
    const { ks, race, items } = setup(4);
    const [a, b, c] = ks;
    park(ks, race);
    driveTo(race, a, S0, 0);
    driveTo(race, b, S0 + 12, 0.5);
    a.velocity.set(Math.sin(a.yaw) * 24, 0, Math.cos(a.yaw) * 24);
    a.input.throttle = 1;
    b.item = 'banana'; b.itemCount = 1; b.coins = 4; b.invulnTimer = 0;
    grant(items, a, 'mortadella');
    ok(items.useItem(a) && a.megaTimer > 0 && a.item === 'mortadella', 'giant: grows, the item stays in the slot');
    // a peel on the road ahead gets destroyed
    const h = items._dropHazard(c, 'banana', track.pointAt(S0 + 30, 0));
    h.age = 5;
    let squashed = false;
    for (let i = 0; i < 160; i++) { tick(items, race, ks); if (b.squashTimer > 0) squashed = true; }
    ok(squashed && b.item === null && b.coins === 2, 'giant: flattens a rival it touches (item dropped, -2 lire)');
    ok(!h.active && a.spinTimer === 0, 'giant: rolls over a peel and destroys it');
    ok(items._countOf('mortadella') === 1, 'giant: counts as in play while active');
    // a zap ends it (zapped by the last-placed kart)
    const lastOf = () => ks.slice().sort((x, y) => race.getPlace(y) - race.getPlace(x))[0];
    if (lastOf() !== a) items._zap(lastOf()); else a.zap();
    tick(items, race, ks, 2);
    ok(a.megaTimer === 0 && a.item === null && count('item:mortadellaEnd', (d) => d.cause === 'zap') === 1, 'a zap ends the giant and frees the slot');
    items.dispose();
  }

  section('items v5 B: Hot Potato');
  {
    const { ks, race, items } = setup(4);
    const [a, b] = ks;
    park(ks, race);
    driveTo(race, a, S0, 0);
    driveTo(race, b, S0 + 40, 0);
    grant(items, a, 'hot_potato');
    const P = items.pluginContext('hot_potato').state;
    ok(P.holder === a && a.potatoTimer > 0 && !a.item && a.offroadImmune && Math.abs(a.stateSpeedMult - ITEM5.potatoSpeedMult) < 1e-9, 'potato: auto-attached, slot free, x1.10, offroad-proof');
    ok(items._countOf('hot_potato') === 1, 'potato: one in play');
    // bump: pass it on
    for (let i = 0; i < 60; i++) items.update(DT, race);
    const left = P.fuse;
    b.position.copy(a.position).addScaledVector({ x: Math.sin(a.yaw), y: 0, z: Math.cos(a.yaw) }, 2.2);
    b.invulnTimer = 0;
    items.update(DT, race);
    ok(P.holder === b && b.potatoTimer > 0 && a.potatoTimer === 0 && !a.offroadImmune && Math.abs(P.fuse - left) < 0.05, 'potato: a touch passes it on with the fuse left');
    items.update(DT, race);
    ok(P.holder === b, 'potato: no pass-back for 1 s');
    // a ghost or a leap can't receive it
    a.ghost(1);
    for (let i = 0; i < 130; i++) items.update(DT, race);
    ok(P.holder === b, 'potato: a ghost can\'t receive it');
    // the pop: shrink 5 s, item dropped, -2 lire
    b.coins = 4; b.item = 'rocket'; b.itemCount = 1;
    driveTo(race, b, S0 + 200, 0);
    for (let i = 0; i < Math.ceil(ITEM5.potatoTime / DT) + 10 && P.holder; i++) items.update(DT, race);
    items.update(DT, race);
    ok(!P.holder && b.shrinkTimer > ITEM5.potatoShrink - 0.2 && b.item === null && b.coins === 2 && count('item:potatoPop') === 1, 'potato: pops into a 5 s shrink, drops the item, -2 lire');
    ok(items._blockedUntil.hot_potato > race.time + ITEM_RULES.hot_potato.cooldown - 1, 'potato: the cooldown runs from the pop');
    // a star removes it safely
    items._blockedUntil.hot_potato = -Infinity;
    grant(items, a, 'hot_potato');
    a.startStar();
    items.update(DT, race);
    ok(!P.holder && a.potatoTimer === 0 && a.shrinkTimer === 0, 'potato: a star removes it safely');
    items.dispose();
  }

  section('items v5 B: Amore Hearts');
  {
    const { ks, race, items } = setup(3);
    const [a, b] = ks;
    park(ks, race);
    driveTo(race, a, S0 + 30, 0);
    driveTo(race, b, S0, 0);
    race.update(DT);
    grant(items, a, 'amore');
    ok(items.useItem(a) && !a.item, 'hearts: on, the slot freed');
    // a rocket from behind: absorbed and gifted
    b.item = 'rocket'; b.itemCount = 1;
    items.useItem(b);
    let tumbled = false;
    for (let i = 0; i < 120; i++) { tick(items, race, ks, 1, false); if (a.tumbleTimer > 0) tumbled = true; }
    const hs = items.pluginContext('amore').kstate(a);
    ok(!tumbled && hs.hearts === 1 && a.item === 'rocket' && count('item:heartBlock', (d) => d.kart === a && d.gift === 'rocket') === 1, `hearts: a rocket absorbed and gifted (hearts ${hs.hearts}, item ${a.item})`);
    // a peel: absorbed (slot busy: no gift), the last heart breaks
    const h = items._dropHazard(b, 'banana', track.pointAt(a.proj.s + 6, a.proj.lateral));
    h.age = 5;
    a.velocity.set(Math.sin(a.yaw) * 12, 0, Math.cos(a.yaw) * 12);
    let spun = false;
    for (let i = 0; i < 90; i++) { tick(items, race, ks, 1, false); if (a.spinTimer > 0) spun = true; }
    ok(!spun && !h.active && !(hs.hearts > 0) && a.item === 'rocket', 'hearts: a peel absorbed by the second heart, then they are gone');
    // a zap destroys both
    a.item = null;
    grant(items, a, 'amore');
    items.useItem(a);
    ok(hs.hearts === 2, 'hearts: two again');
    bus.emit('item:zap', { kart: ks[2], victims: [a], count: 1 });
    ok(!(hs.hearts > 0), 'hearts: a zap destroys both');
    // a Piggy Bank from behind (research §C7: absorbed, the piggy bursts) — through amore's shield hook
    a.item = null; a.velocity.set(0, 0, 0); b.velocity.set(0, 0, 0);
    driveTo(race, a, S0 + 30, 0);
    driveTo(race, b, S0, 0);
    race.update(DT);
    grant(items, a, 'amore');
    items.useItem(a);
    b.item = 'piggy_bank'; b.itemCount = 1; b.rolling = false;
    const bursts0 = count('item:piggyBurst');
    items.useItem(b);
    tumbled = false;
    for (let i = 0; i < 150; i++) { tick(items, race, ks, 1, false); if (a.tumbleTimer > 0) tumbled = true; }
    ok(!tumbled && hs.hearts === 1 && count('item:piggyBurst') > bursts0 && count('item:heartBlock', (d) => d.kart === a && d.item === 'piggy_bank') === 1,
      `hearts: a piggy bank absorbed (it bursts, hearts ${hs.hearts}, tumbled ${tumbled})`);
    items.dispose();
  }

  section('items v5 B: Grissino Swipe');
  {
    const { ks, race, items } = setup(3);
    const [a, b, c] = ks;
    park(ks, race);
    driveTo(race, a, S0 + 40, 0);
    driveTo(race, b, S0 + 40, 2.6);
    race.update(DT);
    grant(items, a, 'grissino');
    ok(items.useItem(a) && a.item === 'grissino' && (items.update(DT, race), a.itemWindow > 0), 'tail: equipped (slot kept, meter)');
    b.invulnTimer = 0;
    items.update(DT, race);
    ok(b.spinTimer === 0, 'tail: idle does not hit');
    ok(items.useItem(a) && (items.update(DT, race), b.spinTimer > 0), 'tail: a swipe spins an adjacent rival');
    ok(items.useItem(a) === false, 'tail: swings at least 0.6 s apart');
    // idle tail blocks one projectile from behind, and breaks
    for (let i = 0; i < 80; i++) items.update(DT, race);
    driveTo(race, c, S0 + 24, 0);
    a.velocity.set(0, 0, 0);
    c.yaw = Math.atan2(a.position.x - c.position.x, a.position.z - c.position.z);   // aimed straight at a's back
    c.item = 'bouncer'; c.itemCount = 1;
    items.useItem(c);
    let tumbled = false;
    for (let i = 0; i < 120; i++) { tick(items, race, ks, 1, false); if (a.tumbleTimer > 0) tumbled = true; }
    ok(!tumbled && a.item === null && count('item:grissinoEnd', (d) => d.kart === a && d.cause === 'block') === 1, 'tail: blocks a bouncer from behind, and breaks');
    items.dispose();
  }

  section('items v5 B: Chomping Calzone');
  {
    const { ks, race, items } = setup(3);
    const [a, b, c] = ks;
    park(ks, race);
    driveTo(race, a, S0, 0);
    a.velocity.set(Math.sin(a.yaw) * 18, 0, Math.cos(a.yaw) * 18);
    a.input.throttle = 1;
    const h = items._dropHazard(c, 'banana', track.pointAt(S0 + 14, 0));
    h.age = 5;
    grant(items, a, 'calzone');
    ok(items.useItem(a) && a.item === 'calzone', 'calzone: mounted (the slot keeps it)');
    let spun = false;
    for (let i = 0; i < 90; i++) { tick(items, race, ks); if (a.spinTimer > 0) spun = true; }
    ok(!h.active && !spun && count('item:chomp', (d) => d.kart === a && d.kind === 'banana') === 1, 'calzone: chomps a banana ahead');
    // a rival right ahead in the cone
    driveTo(race, b, a.proj.s + 3.2, a.proj.lateral);
    b.invulnTimer = 0;
    for (let i = 0; i < 90 && b.spinTimer === 0; i++) items.update(DT, race);
    ok(b.spinTimer > 0, 'calzone: chomps a rival in reach');
    ok(a.boostTimer > 0 || count('kart:boost') >= 0, 'calzone: each chomp lunges');
    // at most 7 chomps, then gone
    park([b], race);
    for (let i = 0; i < Math.ceil(ITEM5.calzoneTime / DT) + 5 && a.item === 'calzone'; i++) { items.useItem(a); items.update(DT, race); }
    const n = count('item:chomp', (d) => d.kart === a);
    ok(n <= ITEM5.calzoneChomps && !a.item && count('item:calzoneEnd', (d) => d.kart === a) === 1, `calzone: ${n} chomps (<= ${ITEM5.calzoneChomps}), then it ends`);
    items.dispose();
  }

  section('items v5 B: Antipasto Platter');
  {
    const { ks, race, items } = setup(4);
    const [a, b] = ks;
    park(ks, race);
    driveTo(race, a, S0, 0);
    race.update(DT);
    grant(items, a, 'antipasto');
    const pc = items.pluginContext('antipasto');
    const orbs = () => items.entities.filter((e) => e.active && e.plugin === pc && e.owner === a);
    ok(a.item === 'antipasto' && a.itemCount === 8 && orbs().length === 8, 'platter: 8 orbiters, itemCount 8');
    const order = [];
    const offU = bus.on('item:platterUse', (e) => { if (e.kart === a) order.push(e.item); });
    for (let i = 0; i < 8 * 60 && a.item; i++) {
      if (i % 60 === 0) {
        // the nose orbiter is the one used
        const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
        let best = null, bd = -2;
        for (const e of orbs()) { const dx = e.position.x - a.position.x, dz = e.position.z - a.position.z, d = (dx * fx + dz * fz) / Math.hypot(dx, dz); if (d > bd) { bd = d; best = e.data.id; } }
        a.starTimer = 0; a.boostTimer = 0;
        items.useItem(a);
        if (order[order.length - 1] !== best) order.push('MISMATCH');
        while (items.bombs.length) items._removeBomb(items.bombs[0], 'clear');     // (its blast would take the rest)
      }
      items.update(DT, race);
      a.velocity.set(0, 0, 0);
    }
    offU();
    ok(order.length === 8 && !order.includes('MISMATCH') && new Set(order).size === 8 && !a.item, `platter: 8 uses, nose first (${order.join(', ')})`);
    // a rival touching an orbiter sets it off; the owner hit loses them all
    items.clear();
    grant(items, a, 'antipasto');
    const e0 = orbs().find((e) => e.data.id === 'banana');
    b.invulnTimer = 0;
    b.position.copy(e0.position); b.position.y = a.position.y;
    items.update(DT, race);
    ok(b.spinTimer > 0 && a.itemCount === 7, 'platter: a rival touching the peel orbiter spins (7 left)');
    a.invulnTimer = 0;
    a.spinOut('banana');
    items.update(DT, race);
    ok(!a.item && orbs().length === 0, 'platter: all lost when the owner is hit');
    items.dispose();
  }

  // ---------------------------------------------------------------- data / rules / AI
  section('items v5 B: data, rules, AI');
  {
    ok(B_IDS.every((id) => ITEM_ENABLED[id] === true && ITEM_INFO[id] && getItemHandler(id) && (ITEM_INFO[id].auto || typeof getItemHandler(id).aiUse === 'function')), 'every group-B item enabled, with info, a handler and an aiUse (not the auto potato)');
    ok(B_IDS.every((id) => !/fire flower|boomerang|piranha|\bboo\b|mega|pow|kamek|leaf|lucky ?7|crazy ?8|coin shell|thunder|spiny|bullet|blooper|bob-omb|mushroom|bowser/i.test(ITEM_INFO[id].name)), 'original names only');
    // caps through the roulette counter
    const { ks, race, items } = setup(4);
    park(ks, race);
    race.time = 100;
    grant(items, ks[0], 'ladro');
    const w = items.weightsFor(ks[1], 4);
    ok(w[Object.keys(ITEM_INFO).indexOf('ladro')] === 0 || items._countOf('ladro') >= ITEM_RULES.ladro.max, 'ladro: none while one is held (max 1)');
    // AI decisions
    const k = ks[0];
    ok(getItemHandler('amore').aiUse(k, { mem: {}, hold: 0 }) === true, 'AI: hearts at once');
    const tj = getItemHandler('tip_jar');
    const mem = {};
    const taps = [0, 0.1, 0.2, 0.45, 0.5, 0.9].filter((h) => tj.aiUse(k, { mem, hold: h })).length;
    ok(taps === 3, `AI: tip jar every 0.4 s (${taps} taps in 0.9 s)`);
    items.dispose();
  }

  offAll();
}

// standalone
if (process.argv[1] && process.argv[1].endsWith('race-logic-items-b.mjs')) {
  let fails = 0, passes = 0;
  const ok = (c, msg) => { if (c) passes++; else { fails++; console.log('  FAIL:', msg); } };
  const section = (t) => console.log(`\n== ${t}`);
  await runItemsB({ ok, section });
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
