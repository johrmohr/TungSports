// Krishiv's Palace set-piece sounds (browser only; registered into audio.js
// SOUNDS through registerSound, played by main.js on the bus event
// `item:sfx { name, position }` — distance-attenuated, races only). The
// world kit (world-palace-setpieces.js) emits them on the set pieces' state
// changes, so every timed set piece has an audio telegraph as well as a
// visual one (research-v5-tracks.md A3).

import { registerSound, SYNTH } from './audio.js';

export const PALACE_SOUNDS = {
  gateRattle: 'palaceGateRattle',   // a portcullis leaf starts to rattle (telegraph)
  gateSlam: 'palaceGateSlam',       // ... and slams down
  lavaDrip: 'palaceLavaDrip',       // a lava curtain starts to drip (telegraph)
  lavaPour: 'palaceLavaPour',       // ... and pours
  beltClunk: 'palaceBeltClunk',     // the Forge belts stop / reverse
  anvil: 'palaceAnvil',             // the trip hammer strikes the anvil
  swing: 'palaceSwing',             // a chandelier sweeps through the bottom of its swing
};

let registered = false;
/** Register the palace sounds once (idempotent). */
export function registerPalaceSounds() {
  if (registered) return;
  registered = true;
  const S = SYNTH;
  registerSound(PALACE_SOUNDS.gateRattle, (ac, out, o) => {
    const { t, p } = S.opt(ac, o);
    // chain links clattering: a quick train of metallic ticks
    for (let k = 0; k < 9; k++) {
      const tt = t + k * 0.065 + (k % 2) * 0.012;
      S.blip(ac, out, tt, { type: 'square', f0: (1500 + (k % 3) * 260) * p, f1: 900 * p, glide: 0.03, dur: 0.035, peak: 0.05, lp: 4200 });
      S.hiss(ac, out, tt, { type: 'bandpass', f0: 3200, Q: 3, dur: 0.03, peak: 0.05 });
    }
    return 0.62;
  }, 1.1);
  registerSound(PALACE_SOUNDS.gateSlam, (ac, out, o) => {
    const { t, p } = S.opt(ac, o);
    S.kickDrum(ac, out, t, 1.1);
    S.blip(ac, out, t, { type: 'sawtooth', f0: 110 * p, f1: 48 * p, glide: 0.25, dur: 0.35, peak: 0.22, lp: 900 });
    S.hiss(ac, out, t, { type: 'lowpass', f0: 1800, f1: 300, dur: 0.4, peak: 0.25 });
    S.bell(ac, out, t + 0.01, 340 * p, 0.05, 0.6);                    // iron ring
    return 0.7;
  }, 1.2);
  registerSound(PALACE_SOUNDS.lavaDrip, (ac, out, o) => {
    const { t, p } = S.opt(ac, o);
    S.hiss(ac, out, t, { type: 'bandpass', f0: 2400, f1: 5200, sweep: 0.6, Q: 1.2, dur: 0.65, peak: 0.12, attack: 0.25 });
    for (let k = 0; k < 4; k++) S.blip(ac, out, t + 0.1 + k * 0.14, { type: 'sine', f0: 700 * p, f1: 260 * p, glide: 0.06, dur: 0.07, peak: 0.06 });
    return 0.7;
  });
  registerSound(PALACE_SOUNDS.lavaPour, (ac, out, o) => {
    const { t } = S.opt(ac, o);
    S.hiss(ac, out, t, { type: 'lowpass', f0: 900, f1: 380, dur: 0.95, peak: 0.3, attack: 0.04 });
    S.hiss(ac, out, t, { type: 'bandpass', f0: 1500, Q: 0.8, dur: 0.8, peak: 0.12, attack: 0.03 });
    S.blip(ac, out, t, { type: 'sawtooth', f0: 70, f1: 52, glide: 0.8, dur: 0.9, peak: 0.08, lp: 400 });
    return 1.0;
  }, 1.1);
  registerSound(PALACE_SOUNDS.beltClunk, (ac, out, o) => {
    const { t, p } = S.opt(ac, o);
    S.blip(ac, out, t, { type: 'square', f0: 95 * p, f1: 60 * p, glide: 0.08, dur: 0.12, peak: 0.18, lp: 700 });
    S.hiss(ac, out, t, { type: 'bandpass', f0: 600, Q: 2, dur: 0.1, peak: 0.12 });
    S.blip(ac, out, t + 0.11, { type: 'square', f0: 80 * p, f1: 55 * p, glide: 0.06, dur: 0.1, peak: 0.12, lp: 600 });
    return 0.25;
  });
  registerSound(PALACE_SOUNDS.anvil, (ac, out, o) => {
    const { t, p } = S.opt(ac, o);
    S.bell(ac, out, t, 520 * p, 0.12, 1.1);
    S.bell(ac, out, t, 1310 * p, 0.05, 0.6);
    S.hiss(ac, out, t, { type: 'highpass', f0: 3000, dur: 0.12, peak: 0.12 });
    S.kickDrum(ac, out, t, 0.6);
    return 1.1;
  });
  registerSound(PALACE_SOUNDS.swing, (ac, out, o) => {
    const { t } = S.opt(ac, o);
    S.hiss(ac, out, t, { type: 'bandpass', f0: 500, f1: 1400, sweep: 0.25, Q: 1.5, dur: 0.45, peak: 0.12, attack: 0.18 });
    S.blip(ac, out, t + 0.05, { type: 'triangle', f0: 180, f1: 150, glide: 0.3, dur: 0.3, peak: 0.03 });
    return 0.5;
  });
}
