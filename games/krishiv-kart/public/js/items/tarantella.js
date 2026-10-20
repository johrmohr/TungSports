// Tarantella Jump 🤸 (v5 group B, research-v5-items.md B5; analog: the jump feather).
//
// A big dance leap: kart.bigJump(ITEM5.jumpVy) (12 m/s vs the drift hop's 5):
// ~0.86 s in the air, ~2.6 m apex, ~25 m forward at top speed. While the leap
// lasts (kart.airImmune) ground hazards, ground projectiles, the padella slam
// and hot-potato passes miss (kart.js airDodges); capo blasts, zaps, espresso
// and soot still land. DRIFT pressed in the air = the normal trick boost on landing.
// Pressed in the air, the leap is queued for ITEM5.jumpQueue s (taken on
// landing), then dropped. Tracks may mark `jumpGaps` ({ s0, s1 } / { f0, f1 })
// that only this leap clears; CPUs leap at their entry.
// CPU: a projectile aimed at it < 8 m, a hazard on its line < 10 m ahead, a
// padella warning, a jumpGaps entry, or after 8 s.

import { registerItem } from './registry.js';
import { ITEM5 } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';
import { clearSlot } from './b-util.js';

const ID = 'tarantella';

registerSound('leap', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'triangle', f0: 440 * p, f1: 1320 * p, glide: 0.28, dur: 0.32, peak: 0.12, vib: 18, vibRate: 11 });
  // tambourine shake: jingles over a quick 6/8 figure (A minor arpeggio, our own)
  [0, 0.09, 0.18].forEach((d, i) => {
    SYNTH.hiss(ac, out, t + d, { type: 'highpass', f0: 7000, dur: 0.07, peak: 0.05 });
    SYNTH.note(ac, out, t + d, [880, 1047, 1319][i] * p, 0.08, { type: 'square', peak: 0.04, lp: 4000 });
  });
  return 0.45;
}, 0.9);
registerSound('leapLand', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 160 * p, f1: 60 * p, dur: 0.16, peak: 0.16 });
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 6500, dur: 0.1, peak: 0.04 });
  return 0.2;
}, 0.9);

function leap(ctx, kart) {
  if (!kart.bigJump(ITEM5.jumpVy)) return false;
  ctx.sfx('leap', kart, 1);
  ctx.emit('item:jump', { kart });
  ctx.state.flying.add(kart);
  return true;
}

// track jumpGaps (optional def feature) as [s0, s1] arc-length pairs
function gapsOf(ctx) {
  const st = ctx.state;
  if (st.gaps) return st.gaps;
  const tr = ctx.track, defs = (tr.def && tr.def.jumpGaps) || [];
  st.gaps = defs.map((g) => {
    const s0 = typeof tr.sOfKey === 'function' ? tr.sOfKey(g, '0') : g.s0;
    const s1 = typeof tr.sOfKey === 'function' ? tr.sOfKey(g, '1') : g.s1;
    return [s0, s1];
  }).filter((g) => Number.isFinite(g[0]) && Number.isFinite(g[1]));
  return st.gaps;
}

registerItem(ID, {
  init(ctx) {
    ctx.state.flying = new Set();
    ctx.state.queue = new Map();          // kart → system time of an in-air press
    ctx.on('kart:bigJumpLand', (e) => {
      if (!e || !ctx.state.flying.has(e.kart)) return;
      ctx.state.flying.delete(e.kart);
      ctx.sfx('leapLand', e.kart, 0.9);
    });
  },

  use(ctx, kart) {
    if (kart.grounded && !kart.isDisabled()) return leap(ctx, kart);
    // in the air (a hop, a ramp): queue it for the landing
    ctx.state.queue.set(kart, ctx.time);
    return { consume: false, first: false };
  },

  update(ctx) {
    const st = ctx.state;
    if (!st.queue.size) return;
    for (const [k, t0] of st.queue) {
      if (ctx.time - t0 > ITEM5.jumpQueue || k.item !== ID) { st.queue.delete(k); continue; }
      if (k.grounded && !k.isDisabled() && !k.frozen) {
        st.queue.delete(k);
        if (leap(ctx, k)) {
          clearSlot(k, ID);
          ctx.sys.used[ID] = (ctx.sys.used[ID] || 0) + 1;
          ctx.emit('item:use', { kart: k, item: ID, first: true });
        }
      }
    }
  },

  aiUse(kart, c) {
    if (!kart.grounded) return false;
    const th = c.threats(14);
    for (const t of th) {
      const d = t.distance;
      // a projectile aimed at us (homing / coming our way) close by
      if (t.speed > 1 && d < 8 && (t.targeting || t.dirX * Math.sin(kart.yaw) + t.dirZ * Math.cos(kart.yaw) < -0.2 || !t.ahead)) return true;
      // a hazard on our line just ahead
      if (t.speed <= 1 && t.ahead && d < 10 && Math.abs((t.lateral || 0) - kart.proj.lateral) < 1.6) return true;
      if (t.item === 'padella' || t.type === 'padella') return true;
    }
    const pc = c.plugin;
    if (pc) {
      for (const [s0] of gapsOf(pc)) {
        const ds = c.track.deltaS(c.s, s0);
        if (ds > 0 && ds < Math.max(6, c.speed * 0.5)) return true;
      }
    }
    return c.hold > 8 && c.straightAhead(30);
  },

  clear(ctx) { ctx.state.flying.clear(); ctx.state.queue.clear(); },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const st = ctx.state;
    st.ribbon = { count: 2, color: 'rainbow', size: 0.2, life: 0.55, radius: 0.35, spread: 0.6 };
    st.p = new ctx.THREE.Vector3();
  },
  updateVisuals(ctx) {
    const st = ctx.state;
    if (!ctx.effects || !st.flying.size) return;
    for (const k of st.flying) {
      if (!k.airImmune) continue;
      st.p.set(k.position.x - Math.sin(k.yaw) * 1.2, k.position.y + 0.8, k.position.z - Math.cos(k.yaw) * 1.2);
      ctx.effects.emit('confetti', st.p, st.ribbon);
    }
  },
});
