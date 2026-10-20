// Audio for KRISHIV KART. Sound effects and most music are generated live with
// WebAudio (oscillators, noise buffers, filters, envelopes). The one exception
// is FILE_SONGS: recorded tracks streamed from public/audio/ through the same
// music bus (see startMusic).
//
//   const audio = new AudioEngine();
//   window.addEventListener('pointerdown', () => audio.unlock());   // any user gesture
//   audio.play('toot', { volume: 0.8, pitch: 1.05, pan: -0.2 });
//   audio.updateEngine(dt, { speed, maxSpeed, throttle, drifting, boosting, grounded, offroad, active });
//   audio.updateEngine(dt, state, 1, 0.4, 0.7);   // split-screen: engine channel 1, panned right
//   audio.setEngineChannels(2);                   // drop channels ≥ 2 (layout shrank)
//   audio.startMusic('race'); audio.setMusicIntensity(1); audio.stopMusic();
//   (music kinds = SONG_KINDS, named by track theme: 'race' = Breezy Bay,
//    'hilltown' = Monte Mozzarella, 'campus' = Aldrich Park, 'beach' = Laguna
//    Beach, 'castle' = Krishiv's Palace, 'menu' = lobby; plus FILE_SONGS kinds
//    such as 'claude' = public/audio/claudesong.m4a)
//
// Layout of this module:
//   * SOUNDS[name](ctx, destination, { when, pitch }) → duration in seconds.
//     Stateless scheduling functions, so tests can render every sound in an
//     OfflineAudioContext (see public/dev/audio.html).
//   * buildMasterChain(ctx): SFX bus + music bus → compressor → master gain →
//     soft limiter. Shared by the live engine and the offline tests.
//   * Music: SONG_DEFS (original synthesized themes, compiled to step events),
//     createMusicRig (per-song buses, echo, reverb) + scheduleMusicStep (one
//     step of a song) driven by a lookahead sequencer that runs on
//     AudioContext time, so it never drifts and loops seamlessly.
//   * EngineLoops: continuous player engine / drift screech / off-road rumble /
//     boost jet loops. The engine keeps one EngineLoops per channel (one per
//     split-screen view, each panned toward its side of the screen).
//   * AudioEngine: the runtime façade used by the game. Every method is a safe
//     no-op until unlock() has created a running AudioContext.

import { clamp, damp, makeRng } from './utils.js';
import { KART } from './config.js';

// ------------------------------------------------------------------ pitch

const NOTE_OFFSETS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C4' → 60, 'F#5' → 78, 'Bb2' → 46 */
export function noteToMidi(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`[audio] bad note "${name}"`);
  return NOTE_OFFSETS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const nf = (name) => mtof(noteToMidi(name));

// ---------------------------------------------------- per-context caches

const CACHES = new WeakMap();
function cacheFor(ctx) {
  let c = CACHES.get(ctx);
  if (!c) { c = {}; CACHES.set(ctx, c); }
  return c;
}

// 2 s of deterministic white noise, shared by every noise voice of a context.
function noiseBuffer(ctx) {
  const c = cacheFor(ctx);
  if (!c.noise) {
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const rng = makeRng(0x70075);
    for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
    c.noise = buf;
  }
  return c.noise;
}

// Band-limited pulse wave with the given duty cycle (0.125 / 0.25 = classic chiptune).
function pulseWave(ctx, duty) {
  const c = cacheFor(ctx);
  const key = 'pulse' + duty;
  if (!c[key]) {
    const n = 48;
    const real = new Float32Array(n), imag = new Float32Array(n);
    for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
    c[key] = ctx.createPeriodicWave(real, imag);
  }
  return c[key];
}

// Soft-knee limiter curve: linear up to 0.75, then a tanh shoulder that never
// exceeds ~0.99. Covers input -2..2 (a 0.5 pre-gain maps it onto -1..1).
function softClipCurve(n = 2049) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    const ax = Math.abs(x);
    const y = ax <= 0.75 ? ax : 0.75 + 0.24 * Math.tanh((ax - 0.75) / 0.24);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

// ------------------------------------------------------------ node helpers

function osc(ctx, type, freq, t) {
  const o = ctx.createOscillator();
  if (typeof type === 'number') o.setPeriodicWave(pulseWave(ctx, type));
  else o.type = type;
  o.frequency.setValueAtTime(freq, t);
  return o;
}

function gain(ctx, v = 1) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

function filter(ctx, type, freq, Q = 0.707) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q;
  return f;
}

// Looping white-noise source. offset < 0 → random start (variation between plays).
function noise(ctx, t, dur, rate = 1, offset = -1) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx);
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(t, offset >= 0 ? offset : Math.random() * 1.8);
  s.stop(t + dur);
  return s;
}

// Percussive envelope: 0 → peak in `attack`, then exponential decay reaching
// about -60 dB after `decay` seconds.
function perc(param, t, peak, attack, decay) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(0, t + attack, decay / 6.9);
}

// ADSR envelope with an explicit note-off time `end`.
function adsr(param, t, peak, attack, decay, sustain, end, release) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  if (decay > 0) param.setTargetAtTime(peak * sustain, t + attack, decay / 3);
  param.setTargetAtTime(0, Math.max(end, t + attack + 0.001), release / 5);
}

// Pitched one-shot with an exponential glide and a percussive envelope.
function blip(ctx, out, t, o) {
  const dur = o.dur ?? 0.1;
  const s = osc(ctx, o.type ?? 'square', o.f0, t);
  if (o.detune) s.detune.value = o.detune;
  if (o.f1 && o.f1 !== o.f0) s.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + (o.glide ?? dur));
  const g = gain(ctx, 0);
  perc(g.gain, t, o.peak ?? 0.2, o.attack ?? 0.003, dur);
  let head = s;
  if (o.lp) { const f = filter(ctx, 'lowpass', o.lp, o.Q ?? 0.8); head.connect(f); head = f; }
  head.connect(g);
  g.connect(out);
  if (o.vib) {
    const l = osc(ctx, 'sine', o.vibRate ?? 8, t);
    const d = gain(ctx, o.vib);
    l.connect(d); d.connect(s.detune);
    l.start(t); l.stop(t + dur + 0.05);
  }
  s.start(t);
  s.stop(t + dur + 0.05);
  return s;
}

// Filtered noise burst with an optional exponential filter sweep.
function hiss(ctx, out, t, o) {
  const dur = o.dur ?? 0.2;
  const n = noise(ctx, t, dur + 0.05, o.rate ?? 1, o.offset ?? -1);
  const f = filter(ctx, o.type ?? 'bandpass', o.f0 ?? 1000, o.Q ?? 1);
  if (o.f1 && o.f1 !== o.f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.sweep ?? dur));
  const g = gain(ctx, 0);
  perc(g.gain, t, o.peak ?? 0.3, o.attack ?? 0.002, dur);
  n.connect(f); f.connect(g); g.connect(out);
  return g;
}

// Sustained note with ADSR, optional vibrato and lowpass (jingles).
function note(ctx, out, t, freq, dur, o = {}) {
  const g = gain(ctx, 0);
  const end = t + dur;
  const rel = o.release ?? 0.08;
  adsr(g.gain, t, o.peak ?? 0.12, o.attack ?? 0.006, o.decay ?? 0.1, o.sustain ?? 0.65, end, rel);
  const s = osc(ctx, o.type ?? 0.25, freq, t);
  if (o.detune) s.detune.value = o.detune;
  let head = s;
  if (o.lp) { const f = filter(ctx, 'lowpass', o.lp, o.Q ?? 0.7); head.connect(f); head = f; }
  head.connect(g); g.connect(out);
  if (o.vib && dur > 0.2) {
    const l = osc(ctx, 'sine', o.vibRate ?? 5.5, t);
    const d = gain(ctx, 0);
    d.gain.setValueAtTime(0, t);
    d.gain.linearRampToValueAtTime(o.vib, t + Math.min(dur, 0.3));
    l.connect(d); d.connect(s.detune);
    l.start(t); l.stop(end + rel + 0.05);
  }
  s.start(t);
  s.stop(end + rel + 0.05);
  return s;
}

// Inharmonic bell (sine partials with staggered decays).
const BELL_PARTIALS = [[1, 1, 1], [2, 0.42, 0.7], [2.76, 0.26, 0.5], [5.4, 0.1, 0.25], [8.93, 0.05, 0.15]];
function bell(ctx, out, t, freq, peak = 0.12, dur = 0.7) {
  for (const [ratio, amp, dk] of BELL_PARTIALS) {
    const s = osc(ctx, 'sine', freq * ratio, t);
    const g = gain(ctx, 0);
    perc(g.gain, t, peak * amp, 0.002, dur * dk);
    s.connect(g); g.connect(out);
    s.start(t); s.stop(t + dur * dk + 0.05);
  }
}

// Brassy stab: two detuned saws through a lowpass with a "blat" filter envelope.
function brass(ctx, out, t, freq, dur, peak = 0.08) {
  const g = gain(ctx, 0);
  g.connect(out);
  adsr(g.gain, t, peak, 0.015, 0.18, 0.7, t + dur, 0.14);
  const lp = filter(ctx, 'lowpass', 500, 1.4);
  lp.frequency.setValueAtTime(450, t);
  lp.frequency.exponentialRampToValueAtTime(3400, t + 0.045);
  lp.frequency.exponentialRampToValueAtTime(1500, t + 0.3);
  lp.connect(g);
  for (const d of [-9, 9]) {
    const s = osc(ctx, 'sawtooth', freq, t);
    s.detune.value = d;
    s.connect(lp);
    s.start(t); s.stop(t + dur + 0.25);
  }
}

// Shared drum voices (used by the music and by jingles).
function kickDrum(ctx, out, t, vel = 1, offset = 0) {
  const s = osc(ctx, 'sine', 155, t);
  s.frequency.exponentialRampToValueAtTime(46, t + 0.09);
  const g = gain(ctx, 0);
  perc(g.gain, t, 0.62 * vel, 0.002, 0.24);
  s.connect(g); g.connect(out);
  s.start(t); s.stop(t + 0.3);
  hiss(ctx, out, t, { type: 'lowpass', f0: 2500, Q: 0.7, dur: 0.018, peak: 0.12 * vel, offset });
}
function snareDrum(ctx, out, t, vel = 1, offset = 0) {
  hiss(ctx, out, t, { type: 'bandpass', f0: 2100, Q: 0.6, dur: 0.16, peak: 0.36 * vel, offset });
  hiss(ctx, out, t, { type: 'highpass', f0: 5000, Q: 0.7, dur: 0.07, peak: 0.12 * vel, offset: offset + 0.31 });
  blip(ctx, out, t, { type: 'triangle', f0: 230, f1: 170, dur: 0.07, peak: 0.24 * vel });
}
function hatDrum(ctx, out, t, vel = 1, offset = 0, open = false) {
  hiss(ctx, out, t, { type: 'highpass', f0: 7600, Q: 0.8, dur: open ? 0.2 : 0.04, peak: 0.12 * vel, offset });
}
function crashCymbal(ctx, out, t, vel = 1, offset = 0) {
  hiss(ctx, out, t, { type: 'highpass', f0: 4200, Q: 0.5, dur: 1.4, peak: 0.13 * vel, offset });
  hiss(ctx, out, t, { type: 'bandpass', f0: 7000, Q: 1.5, dur: 0.9, peak: 0.07 * vel, offset: offset + 0.5 });
}

// Schedule [step, note, lengthInSteps, velocity] tuples through a voice fn.
function seqNotes(list, t, stepDur, fn) {
  for (const [st, n, len, vel = 1] of list) {
    fn(t + st * stepDur, typeof n === 'string' ? nf(n) : mtof(n), len * stepDur, vel);
  }
}

const opt = (ctx, o) => ({ t: o && o.when != null ? o.when : ctx.currentTime, p: (o && o.pitch) || 1 });

// ================================================================ SOUNDS
// Every function: (ctx, destination, { when, pitch }) → duration (s).
// RAW holds the voice designs; SOUNDS (below) wraps each with a level trim.

const RAW = {
  // ---------------------------------------------------------------- menus
  menuMove(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 0.25, f0: 990 * p, f1: 1320 * p, glide: 0.025, dur: 0.07, peak: 0.16, lp: 6000 });
    return 0.1;
  },
  menuSelect(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 0.25, f0: 784 * p, dur: 0.07, peak: 0.17, lp: 6000 });
    blip(ctx, out, t + 0.065, { type: 0.25, f0: 1175 * p, dur: 0.16, peak: 0.19, lp: 7000 });
    blip(ctx, out, t + 0.065, { type: 'sine', f0: 2350 * p, dur: 0.18, peak: 0.07 });
    return 0.3;
  },
  menuBack(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 0.25, f0: 740 * p, dur: 0.06, peak: 0.15, lp: 5000 });
    blip(ctx, out, t + 0.06, { type: 0.25, f0: 494 * p, f1: 440 * p, dur: 0.13, peak: 0.15, lp: 4000 });
    return 0.25;
  },

  // ---------------------------------------------------------------- race start
  countdown(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    note(ctx, out, t, 523.25 * p, 0.22, { type: 'square', peak: 0.13, decay: 0.05, sustain: 0.8, release: 0.06, lp: 3800 });
    note(ctx, out, t, 1046.5 * p, 0.22, { type: 'sine', peak: 0.09, decay: 0.05, sustain: 0.8, release: 0.06 });
    return 0.35;
  },
  go(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    note(ctx, out, t, 1046.5 * p, 0.55, { type: 'square', peak: 0.13, decay: 0.1, sustain: 0.75, release: 0.2, lp: 4500 });
    note(ctx, out, t, 1568 * p, 0.55, { type: 0.25, peak: 0.07, decay: 0.1, sustain: 0.7, release: 0.2, lp: 6000 });
    note(ctx, out, t, 2093 * p, 0.6, { type: 'sine', peak: 0.08, decay: 0.15, sustain: 0.5, release: 0.25 });
    return 0.9;
  },
  startBoost(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    bell(ctx, out, t, 1568 * p, 0.09, 0.5);
    hiss(ctx, out, t, { type: 'bandpass', f0: 300, f1: 4200, Q: 1.3, dur: 0.95, sweep: 0.55, peak: 0.42, attack: 0.03 });
    const s = osc(ctx, 'sawtooth', 220 * p, t);
    s.frequency.exponentialRampToValueAtTime(880 * p, t + 0.5);
    const lp = filter(ctx, 'lowpass', 600, 3);
    lp.frequency.exponentialRampToValueAtTime(5000, t + 0.45);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.13, 0.04, 0.8);
    s.connect(lp); lp.connect(g); g.connect(out);
    s.start(t); s.stop(t + 0.9);
    return 1.0;
  },
  stall(ctx, out, o) {
    // engine coughs three times and dies
    const { t, p } = opt(ctx, o);
    const chugs = [[0, 78], [0.17, 66], [0.38, 50]];
    for (const [dt, f] of chugs) {
      blip(ctx, out, t + dt, { type: 'sawtooth', f0: f * p * 1.4, f1: f * p, dur: 0.13, peak: 0.34, attack: 0.008, lp: 520, Q: 3 });
      hiss(ctx, out, t + dt, { type: 'lowpass', f0: 900, Q: 1, dur: 0.1, peak: 0.16 });
    }
    hiss(ctx, out, t + 0.52, { type: 'bandpass', f0: 1500, f1: 600, Q: 1.5, dur: 0.22, peak: 0.12, attack: 0.02 });
    return 0.8;
  },

  // ---------------------------------------------------------------- items
  itemBox(ctx, out, o) {
    // crystalline shatter: bright crack + scattered glassy partials + quick sparkle run
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'highpass', f0: 2800, Q: 0.9, dur: 0.12, peak: 0.42 });
    hiss(ctx, out, t, { type: 'bandpass', f0: 6500, f1: 3500, Q: 3, dur: 0.3, peak: 0.12 });
    const shards = [2093, 2637, 3136, 3520, 4186, 4699, 5588, 6272];
    for (let i = 0; i < shards.length; i++) {
      const dt = 0.004 + i * 0.011 + Math.random() * 0.02;
      const f = shards[i] * p * (1 + (Math.random() - 0.5) * 0.02);
      const s = osc(ctx, 'sine', f, t + dt);
      const g = gain(ctx, 0);
      perc(g.gain, t + dt, 0.07, 0.001, 0.22 + Math.random() * 0.35);
      s.connect(g); g.connect(out);
      s.start(t + dt); s.stop(t + dt + 0.65);
    }
    const run = ['E6', 'G#6', 'B6', 'E7'];
    run.forEach((n, i) => blip(ctx, out, t + 0.05 + i * 0.035, { type: 'triangle', f0: nf(n) * p, dur: 0.18, peak: 0.07 }));
    return 0.8;
  },
  roulette(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'square', f0: 1900 * p, f1: 1250 * p, glide: 0.02, dur: 0.035, peak: 0.09, lp: 7000 });
    hiss(ctx, out, t, { type: 'highpass', f0: 5000, dur: 0.012, peak: 0.06 });
    return 0.06;
  },
  itemGet(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    bell(ctx, out, t, 1318.5 * p, 0.11, 0.55);
    bell(ctx, out, t + 0.085, 1760 * p, 0.13, 0.8);
    blip(ctx, out, t + 0.085, { type: 0.25, f0: 1760 * p, dur: 0.12, peak: 0.05, lp: 6000 });
    return 0.9;
  },
  throw(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'bandpass', f0: 500 * p, f1: 2600 * p, Q: 2.2, dur: 0.24, sweep: 0.18, peak: 0.36, attack: 0.02 });
    blip(ctx, out, t, { type: 'triangle', f0: 520 * p, f1: 210 * p, dur: 0.14, peak: 0.16 });
    return 0.3;
  },
  bouncer(ctx, out, o) {
    // springy "bwoing" launch
    const { t, p } = opt(ctx, o);
    const s = osc(ctx, 'triangle', 180 * p, t);
    s.frequency.exponentialRampToValueAtTime(760 * p, t + 0.09);
    s.frequency.exponentialRampToValueAtTime(420 * p, t + 0.3);
    const l = osc(ctx, 'sine', 22, t);
    const d = gain(ctx, 60);
    l.connect(d); d.connect(s.detune);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.32, 0.006, 0.34);
    s.connect(g); g.connect(out);
    s.start(t); s.stop(t + 0.4); l.start(t); l.stop(t + 0.4);
    hiss(ctx, out, t, { type: 'lowpass', f0: 1200, Q: 1, dur: 0.08, peak: 0.22 });
    return 0.4;
  },
  rocket(ctx, out, o) {
    // ignition crackle then a rising roar
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'lowpass', f0: 380, f1: 3200, Q: 1.8, dur: 1.0, sweep: 0.5, peak: 0.42, attack: 0.04 });
    hiss(ctx, out, t, { type: 'highpass', f0: 3000, Q: 0.8, dur: 0.12, peak: 0.25 });
    const s = osc(ctx, 'sawtooth', 110 * p, t);
    s.frequency.exponentialRampToValueAtTime(520 * p, t + 0.7);
    const lp = filter(ctx, 'lowpass', 400, 2);
    lp.frequency.exponentialRampToValueAtTime(2600, t + 0.6);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.15, 0.08, 0.95);
    s.connect(lp); lp.connect(g); g.connect(out);
    s.start(t); s.stop(t + 1.05);
    return 1.1;
  },
  toot(ctx, out, o) {
    // Comedic "pfff-rrrrt!" boost toot: a buzzing low reed with irregular lip
    // flutter through a resonant "mouth" lowpass, a breathy pff at the start
    // and a little upward squeak at the end. Silly, never gross.
    const { t, p } = opt(ctx, o);
    const dur = 0.72;
    const out2 = gain(ctx, 0);
    out2.connect(out);
    const A = out2.gain;
    A.setValueAtTime(0, t);
    A.linearRampToValueAtTime(0.62, t + 0.035);
    A.linearRampToValueAtTime(0.46, t + 0.22);
    A.linearRampToValueAtTime(0.52, t + 0.46);
    A.linearRampToValueAtTime(0.24, t + 0.56);
    A.linearRampToValueAtTime(0.6, t + 0.6);
    A.setTargetAtTime(0, t + 0.62, 0.03);

    const f0 = 88 * p;
    const contour = (param, m) => {
      param.setValueAtTime(f0 * 1.35 * m, t);
      param.exponentialRampToValueAtTime(f0 * m, t + 0.12);
      param.linearRampToValueAtTime(f0 * 0.86 * m, t + 0.45);
      param.exponentialRampToValueAtTime(f0 * 0.68 * m, t + 0.55);
      param.exponentialRampToValueAtTime(f0 * 2.1 * m, t + 0.63);
    };
    const reed = osc(ctx, 'sawtooth', f0, t);
    const reed2 = osc(ctx, 'square', f0, t);
    contour(reed.frequency, 1);
    contour(reed2.frequency, 1.007);
    // lip flutter: two unrelated LFO rates → irregular pitch wobble + chopping
    const fl1 = osc(ctx, 'square', 24, t);
    fl1.frequency.linearRampToValueAtTime(31, t + dur);
    const fl2 = osc(ctx, 'sine', 37.3, t);
    const fd1 = gain(ctx, 120), fd2 = gain(ctx, 80);
    fl1.connect(fd1); fl2.connect(fd2);
    fd1.connect(reed.detune); fd1.connect(reed2.detune);
    fd2.connect(reed.detune); fd2.connect(reed2.detune);
    const chop = gain(ctx, 0.6);
    const chopDepth = gain(ctx, 0.38);
    fl1.connect(chopDepth); chopDepth.connect(chop.gain);
    const r1 = gain(ctx, 0.7), r2 = gain(ctx, 0.35);
    reed.connect(r1); reed2.connect(r2);
    r1.connect(chop); r2.connect(chop);
    // breath underneath the buzz (also chopped by the flutter)
    const air = noise(ctx, t, dur);
    const airBp = filter(ctx, 'bandpass', 360, 0.9);
    const airG = gain(ctx, 0.5);
    air.connect(airBp); airBp.connect(airG); airG.connect(chop);
    // resonant mouth
    const mouth = filter(ctx, 'lowpass', 1100, 7);
    mouth.frequency.setValueAtTime(1200, t);
    mouth.frequency.exponentialRampToValueAtTime(560, t + 0.42);
    mouth.frequency.exponentialRampToValueAtTime(1500, t + 0.62);
    chop.connect(mouth); mouth.connect(out2);
    for (const n of [reed, reed2, fl1, fl2]) { n.start(t); n.stop(t + dur + 0.1); }
    // the initial "pff"
    hiss(ctx, out, t, { type: 'bandpass', f0: 1900, f1: 700, Q: 1.3, dur: 0.17, peak: 0.24, attack: 0.008 });
    return dur + 0.15;
  },
  boost(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'bandpass', f0: 380, f1: 2800, Q: 1.6, dur: 0.7, sweep: 0.35, peak: 0.42, attack: 0.025 });
    const s = osc(ctx, 'sawtooth', 160 * p, t);
    s.frequency.exponentialRampToValueAtTime(340 * p, t + 0.3);
    const lp = filter(ctx, 'lowpass', 700, 2);
    lp.frequency.exponentialRampToValueAtTime(2400, t + 0.3);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.12, 0.03, 0.6);
    s.connect(lp); lp.connect(g); g.connect(out);
    s.start(t); s.stop(t + 0.7);
    return 0.75;
  },
  star(ctx, out, o) {
    // twinkling ascending sparkle arpeggio + shimmer
    const { t, p } = opt(ctx, o);
    const run = ['C6', 'E6', 'G6', 'C7', 'E7', 'G7', 'C8'];
    run.forEach((n, i) => {
      const tt = t + i * 0.045;
      blip(ctx, out, tt, { type: 'triangle', f0: nf(n) * p, dur: 0.3, peak: 0.11 });
      blip(ctx, out, tt, { type: 'sine', f0: nf(n) * p * 2.005, dur: 0.18, peak: 0.04 });
    });
    const sh = noise(ctx, t, 0.9);
    const hp = filter(ctx, 'highpass', 8000, 0.8);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.09, 0.05, 0.85);
    const trem = osc(ctx, 'square', 18, t);
    const td = gain(ctx, 0.5);
    const tg = gain(ctx, 0.5);
    trem.connect(td); td.connect(tg.gain);
    sh.connect(hp); hp.connect(tg); tg.connect(g); g.connect(out);
    trem.start(t); trem.stop(t + 0.95);
    return 1.0;
  },
  zap(ctx, out, o) {
    // electric crackle: random-stepped square buzz + gated noise + falling zzzt
    const { t, p } = opt(ctx, o);
    const dur = 0.7;
    const s = osc(ctx, 'square', 300, t);
    for (let k = 0; k < 48; k++) s.frequency.setValueAtTime((90 + Math.random() * 2200) * p, t + k * 0.013);
    const hp = filter(ctx, 'highpass', 350, 0.7);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    for (let k = 0; k < 28; k++) g.gain.setValueAtTime(Math.random() < 0.65 ? 0.09 + Math.random() * 0.07 : 0, t + k * 0.022);
    g.gain.setTargetAtTime(0, t + 0.62, 0.02);
    s.connect(hp); hp.connect(g); g.connect(out);
    s.start(t); s.stop(t + dur);
    const n = noise(ctx, t, dur);
    const nf2 = filter(ctx, 'highpass', 2500, 0.7);
    const ng = gain(ctx, 0);
    ng.gain.setValueAtTime(0, t);
    for (let k = 0; k < 22; k++) ng.gain.setValueAtTime(Math.random() < 0.5 ? 0.16 + Math.random() * 0.12 : 0.02, t + k * 0.028);
    ng.gain.setTargetAtTime(0, t + 0.62, 0.02);
    n.connect(nf2); nf2.connect(ng); ng.connect(out);
    blip(ctx, out, t, { type: 'sawtooth', f0: 1400 * p, f1: 70 * p, dur: 0.55, peak: 0.1, lp: 3000, Q: 4 });
    return dur + 0.05;
  },
  stink(ctx, out, o) {
    // gassy "psssshhh" hiss with a wobbly low burble
    const { t, p } = opt(ctx, o);
    const dur = 1.0;
    const n = noise(ctx, t, dur);
    const bp = filter(ctx, 'bandpass', 3800 * p, 1.1);
    bp.frequency.exponentialRampToValueAtTime(1300 * p, t + dur);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.06);
    g.gain.setTargetAtTime(0, t + 0.45, 0.16);
    const wob = osc(ctx, 'sine', 9, t);
    const wd = gain(ctx, 0.35);
    const wg = gain(ctx, 0.65);
    wob.connect(wd); wd.connect(wg.gain);
    n.connect(bp); bp.connect(wg); wg.connect(g); g.connect(out);
    wob.start(t); wob.stop(t + dur);
    const b = osc(ctx, 'sawtooth', 62 * p, t);
    b.frequency.linearRampToValueAtTime(48 * p, t + 0.6);
    const fl = osc(ctx, 'sine', 17, t);
    const fd = gain(ctx, 160);
    fl.connect(fd); fd.connect(b.detune);
    const blp = filter(ctx, 'lowpass', 340, 4);
    const bg = gain(ctx, 0);
    perc(bg.gain, t, 0.26, 0.03, 0.6);
    b.connect(blp); blp.connect(bg); bg.connect(out);
    b.start(t); b.stop(t + 0.7); fl.start(t); fl.stop(t + 0.7);
    return dur + 0.1;
  },
  banana(ctx, out, o) {
    // wet squish + slip
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'bandpass', f0: 1400 * p, f1: 260 * p, Q: 4, dur: 0.22, sweep: 0.16, peak: 0.5, attack: 0.004 });
    blip(ctx, out, t, { type: 'sine', f0: 420 * p, f1: 110 * p, dur: 0.24, peak: 0.34, vib: 260, vibRate: 32 });
    blip(ctx, out, t + 0.12, { type: 'triangle', f0: 900 * p, f1: 1800 * p, dur: 0.16, peak: 0.08 });
    return 0.35;
  },

  // ---------------------------------------------------------------- hits
  hit(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'sine', f0: 150 * p, f1: 42 * p, dur: 0.3, peak: 0.55 });
    blip(ctx, out, t, { type: 'square', f0: 330 * p, f1: 150 * p, dur: 0.12, peak: 0.14, lp: 2200 });
    hiss(ctx, out, t, { type: 'lowpass', f0: 2600, f1: 500, Q: 0.9, dur: 0.3, peak: 0.42 });
    return 0.4;
  },
  spin(ctx, out, o) {
    // cartoon spin-out: falling warbly whistle over a tire squeal
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'triangle', f0: 1500 * p, f1: 300 * p, dur: 0.85, glide: 0.8, peak: 0.16, attack: 0.02, vib: 160, vibRate: 13 });
    blip(ctx, out, t, { type: 'sine', f0: 3000 * p, f1: 600 * p, dur: 0.6, glide: 0.8, peak: 0.04, vib: 160, vibRate: 13 });
    hiss(ctx, out, t, { type: 'bandpass', f0: 2600, f1: 1800, Q: 8, dur: 0.7, peak: 0.42, attack: 0.02 });
    return 0.95;
  },
  explode(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'lowpass', f0: 4500, f1: 110, Q: 0.8, dur: 1.3, sweep: 0.9, peak: 0.75, rate: 0.8 });
    blip(ctx, out, t, { type: 'sine', f0: 95 * p, f1: 28 * p, dur: 0.8, peak: 0.6, attack: 0.004 });
    for (let k = 0; k < 6; k++) {
      hiss(ctx, out, t + 0.08 + k * 0.07 + Math.random() * 0.05, { type: 'highpass', f0: 1800, Q: 0.7, dur: 0.05, peak: 0.1 + Math.random() * 0.1 });
    }
    return 1.4;
  },
  wall(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'sine', f0: 115 * p, f1: 44 * p, dur: 0.2, peak: 0.5 });
    hiss(ctx, out, t, { type: 'lowpass', f0: 900 * p, Q: 1, dur: 0.16, peak: 0.46 });
    hiss(ctx, out, t, { type: 'bandpass', f0: 2400 * p, Q: 3, dur: 0.06, peak: 0.12 });
    return 0.25;
  },
  bump(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'triangle', f0: 320 * p, f1: 140 * p, dur: 0.1, peak: 0.34 });
    blip(ctx, out, t, { type: 'sine', f0: 120 * p, f1: 60 * p, dur: 0.14, peak: 0.34 });
    hiss(ctx, out, t, { type: 'bandpass', f0: 900 * p, Q: 1.5, dur: 0.07, peak: 0.24 });
    return 0.18;
  },
  hop(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'square', f0: 250 * p, f1: 560 * p, glide: 0.07, dur: 0.12, peak: 0.1, lp: 1900, Q: 2 });
    blip(ctx, out, t, { type: 'sine', f0: 250 * p, f1: 560 * p, glide: 0.07, dur: 0.12, peak: 0.12 });
    return 0.16;
  },
  land(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'sine', f0: 95 * p, f1: 40 * p, dur: 0.17, peak: 0.42 });
    hiss(ctx, out, t, { type: 'lowpass', f0: 500, Q: 0.8, dur: 0.12, peak: 0.34 });
    return 0.2;
  },
  respawn(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    const s = osc(ctx, 'sine', 300 * p, t);
    s.frequency.exponentialRampToValueAtTime(1250 * p, t + 0.5);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.2, 0.05, 0.6);
    const trem = osc(ctx, 'sine', 16, t);
    const td = gain(ctx, 0.45);
    const tg = gain(ctx, 0.55);
    trem.connect(td); td.connect(tg.gain);
    s.connect(tg); tg.connect(g); g.connect(out);
    s.start(t); s.stop(t + 0.65); trem.start(t); trem.stop(t + 0.65);
    ['G6', 'B6', 'D7'].forEach((n, i) => blip(ctx, out, t + 0.42 + i * 0.05, { type: 'triangle', f0: nf(n) * p, dur: 0.2, peak: 0.07 }));
    return 0.75;
  },

  // ---------------------------------------------------------------- drifting
  drift1(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'triangle', f0: 1050 * p, f1: 1500 * p, glide: 0.06, dur: 0.18, peak: 0.13 });
    hiss(ctx, out, t, { type: 'highpass', f0: 6000, dur: 0.1, peak: 0.1 });
    return 0.22;
  },
  drift2(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'triangle', f0: 1350 * p, f1: 1800 * p, glide: 0.05, dur: 0.1, peak: 0.12 });
    blip(ctx, out, t + 0.07, { type: 'triangle', f0: 1800 * p, f1: 2250 * p, glide: 0.05, dur: 0.2, peak: 0.13 });
    blip(ctx, out, t + 0.07, { type: 0.125, f0: 3600 * p, dur: 0.12, peak: 0.03 });
    hiss(ctx, out, t, { type: 'highpass', f0: 6500, dur: 0.16, peak: 0.12 });
    return 0.32;
  },
  drift3(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    const f = [1700, 2270, 2860];
    f.forEach((fr, i) => {
      blip(ctx, out, t + i * 0.06, { type: 'triangle', f0: fr * p, f1: fr * 1.2 * p, glide: 0.04, dur: 0.16 + i * 0.06, peak: 0.12 });
      blip(ctx, out, t + i * 0.06, { type: 'sine', f0: fr * 2 * p, dur: 0.12, peak: 0.04 });
    });
    hiss(ctx, out, t, { type: 'highpass', f0: 7000, dur: 0.4, peak: 0.13, attack: 0.02 });
    return 0.5;
  },

  // ---------------------------------------------------------------- race flow
  lap(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    bell(ctx, out, t, nf('G5') * p, 0.13, 0.6);
    bell(ctx, out, t + 0.11, nf('D6') * p, 0.14, 0.9);
    blip(ctx, out, t + 0.11, { type: 0.25, f0: nf('D6') * p, dur: 0.14, peak: 0.05, lp: 5000 });
    return 1.0;
  },
  finalLap(ctx, out, o) {
    // rising stab fanfare that lands on a big D major chord (V of the race key)
    const { t, p } = opt(ctx, o);
    const sd = 0.09;
    const stabs = [[0, 'G4', 1], [2, 'G4', 1], [3, 'A4', 1], [4, 'B4', 1]];
    seqNotes(stabs, t, sd, (tt, f, d) => {
      brass(ctx, out, tt, f * p, d, 0.07);
      note(ctx, out, tt, f * 2 * p, d, { type: 0.25, peak: 0.06, release: 0.04 });
    });
    const tc = t + 6 * sd;
    for (const n of ['D4', 'F#4', 'A4', 'D5']) brass(ctx, out, tc, nf(n) * p, 0.8, 0.055);
    note(ctx, out, tc, nf('A5') * p, 0.8, { type: 0.25, peak: 0.08, vib: 25, release: 0.25 });
    for (let k = 0; k < 6; k++) snareDrum(ctx, out, t + k * sd, 0.35 + k * 0.1, k * 0.11);
    crashCymbal(ctx, out, tc, 0.9);
    kickDrum(ctx, out, tc, 1);
    return 6 * sd + 1.3;
  },
  finish(ctx, out, o) {
    // victory fanfare (~2.6 s)
    const { t, p } = opt(ctx, o);
    const sd = 0.1;
    const lead = [[0, 'G5', 1], [1, 'A5', 1], [2, 'B5', 1], [3, 'C6', 3], [6, 'G5', 1], [7, 'C6', 1], [8, 'E6', 4],
      [12, 'D6', 2], [14, 'E6', 2], [16, 'G6', 10]];
    seqNotes(lead, t, sd, (tt, f, d) => {
      note(ctx, out, tt, f * p, d * 0.95, { type: 0.25, peak: 0.1, vib: 20, release: 0.12, lp: 7000 });
      brass(ctx, out, tt, (f / 2) * p, d * 0.95, 0.045);
    });
    for (const n of ['C5', 'E5', 'G5']) brass(ctx, out, t + 16 * sd, nf(n) * p, 1.0, 0.05);
    const bass = [[0, 'G2', 3], [3, 'C3', 3], [8, 'C3', 4], [12, 'G2', 4], [16, 'C3', 10]];
    seqNotes(bass, t, sd, (tt, f, d) => note(ctx, out, tt, f * p, d * 0.85, { type: 'triangle', peak: 0.22, release: 0.1 }));
    [0, 3, 8, 16].forEach((s) => kickDrum(ctx, out, t + s * sd, 0.9, s * 0.05));
    for (let s = 12; s < 16; s++) snareDrum(ctx, out, t + s * sd, 0.5 + (s - 12) * 0.12, s * 0.07);
    crashCymbal(ctx, out, t + 16 * sd, 1);
    return 26 * sd + 1.0;
  },
  lose(ctx, out, o) {
    // gentle "nice try" tune: falls, then a wistful lift to an open chord (~2.3 s)
    const { t, p } = opt(ctx, o);
    const sd = 0.13;
    const lead = [[0, 'G5', 2], [2, 'E5', 2], [4, 'C5', 3], [7, 'D5', 1], [8, 'B4', 4], [12, 'A4', 2], [14, 'C5', 6]];
    seqNotes(lead, t, sd, (tt, f, d) => {
      note(ctx, out, tt, f * p, d * 0.92, { type: 'triangle', peak: 0.16, vib: 30, vibRate: 5, release: 0.15 });
      note(ctx, out, tt, f * p, d * 0.92, { type: 0.125, peak: 0.035, release: 0.1, lp: 3000 });
    });
    const chords = [[0, ['A3', 'C4', 'E4'], 8], [8, ['G3', 'B3', 'D4'], 6], [14, ['F3', 'A3', 'C4', 'G4'], 6]];
    for (const [st, notes, len] of chords) {
      for (const n of notes) note(ctx, out, t + st * sd, nf(n) * p, len * sd, { type: 'sine', peak: 0.05, attack: 0.04, release: 0.25 });
    }
    seqNotes([[0, 'A2', 7], [8, 'G2', 5], [14, 'F2', 6]], t, sd, (tt, f, d) => note(ctx, out, tt, f * p, d, { type: 'triangle', peak: 0.18, release: 0.2 }));
    return 20 * sd + 0.6;
  },
  jingleStart(ctx, out, o) {
    // short pre-race "get ready" flourish (~1.6 s)
    const { t, p } = opt(ctx, o);
    const sd = 0.075;
    const run = [[0, 'C5', 1], [1, 'E5', 1], [2, 'G5', 1], [3, 'C6', 1], [4, 'E6', 1], [5, 'G6', 3]];
    seqNotes(run, t, sd, (tt, f, d) => note(ctx, out, tt, f * p, d, { type: 0.25, peak: 0.09, release: 0.06, lp: 7000 }));
    const tc = t + 9 * sd;
    for (const n of ['C4', 'G4', 'C5', 'E5']) brass(ctx, out, tc, nf(n) * p, 0.6, 0.05);
    kickDrum(ctx, out, tc, 0.9);
    crashCymbal(ctx, out, tc, 0.7);
    return 9 * sd + 1.0;
  },

  // ---------------------------------------------------------------- v4 items (SPEC §15.2)
  capoLaunch(ctx, out, o) {
    // the Capo Crusher takes off: a rising whoosh, a fast golden chime run and buzzing wings
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'bandpass', f0: 300 * p, f1: 3200 * p, Q: 1.8, dur: 0.6, sweep: 0.45, peak: 0.4, attack: 0.03 });
    ['E5', 'G#5', 'B5', 'E6', 'G#6'].forEach((n, i) => bell(ctx, out, t + 0.04 + i * 0.045, nf(n) * p, 0.07, 0.5));
    const n = noise(ctx, t, 0.75);
    const bp = filter(ctx, 'bandpass', 900 * p, 1.4);
    const am = gain(ctx, 0.5), amd = gain(ctx, 0.5), lfo = osc(ctx, 'square', 22, t);
    lfo.connect(amd); amd.connect(am.gain);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.26, 0.05, 0.7);
    n.connect(bp); bp.connect(am); am.connect(g); g.connect(out);
    lfo.start(t); lfo.stop(t + 0.8);
    return 0.85;
  },
  capoSiren(ctx, out, o) {
    // one "wee-woo" of the incoming-capo alarm (the HUD repeats it)
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'square', f0: 1046 * p, f1: 1318 * p, glide: 0.09, dur: 0.12, peak: 0.12, lp: 4200 });
    blip(ctx, out, t + 0.12, { type: 'square', f0: 1318 * p, f1: 880 * p, glide: 0.1, dur: 0.13, peak: 0.12, lp: 4200 });
    blip(ctx, out, t, { type: 'sine', f0: 523 * p, f1: 659 * p, glide: 0.09, dur: 0.24, peak: 0.08 });
    return 0.3;
  },
  capoSlam(ctx, out, o) {
    // the slam: a huge low thud, a crunchy crack and a rumbling tail
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'sine', f0: 120 * p, f1: 24 * p, dur: 1.0, peak: 0.75, attack: 0.002 });
    blip(ctx, out, t, { type: 'square', f0: 240 * p, f1: 60 * p, dur: 0.25, peak: 0.16, lp: 1200 });
    hiss(ctx, out, t, { type: 'lowpass', f0: 6000, f1: 90, Q: 0.8, dur: 1.4, sweep: 1.0, peak: 0.8, rate: 0.7 });
    hiss(ctx, out, t, { type: 'highpass', f0: 2500, Q: 0.7, dur: 0.09, peak: 0.35 });
    bell(ctx, out, t + 0.02, 196 * p, 0.06, 0.9);
    return 1.5;
  },
  bombThrow(ctx, out, o) {
    // "hup!" lob whoosh + the fuse catching
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'bandpass', f0: 420 * p, f1: 1800 * p, Q: 2, dur: 0.3, sweep: 0.25, peak: 0.32, attack: 0.02 });
    blip(ctx, out, t, { type: 'triangle', f0: 260 * p, f1: 520 * p, dur: 0.16, peak: 0.16 });
    const n = noise(ctx, t + 0.05, 0.55);
    const hp = filter(ctx, 'highpass', 4200, 0.8);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t + 0.05);
    for (let k = 0; k < 18; k++) g.gain.setValueAtTime(Math.random() < 0.7 ? 0.08 + Math.random() * 0.06 : 0.01, t + 0.05 + k * 0.028);
    g.gain.setTargetAtTime(0, t + 0.55, 0.03);
    n.connect(hp); hp.connect(g); g.connect(out);
    return 0.65;
  },
  bombFuse(ctx, out, o) {
    // a short fizzing fuse crackle (bomb landing)
    const { t, p } = opt(ctx, o);
    const n = noise(ctx, t, 0.45, 1.2);
    const bp = filter(ctx, 'bandpass', 5200 * p, 1.2);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    for (let k = 0; k < 16; k++) g.gain.setValueAtTime(Math.random() < 0.6 ? 0.12 + Math.random() * 0.1 : 0.02, t + k * 0.026);
    g.gain.setTargetAtTime(0, t + 0.4, 0.03);
    n.connect(bp); bp.connect(g); g.connect(out);
    blip(ctx, out, t, { type: 'sine', f0: 90 * p, f1: 55 * p, dur: 0.14, peak: 0.3 });
    return 0.5;
  },
  espresso(ctx, out, o) {
    // espresso shot: a steamy "pssht" + a gurgling squirt
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'bandpass', f0: 2600 * p, f1: 6000 * p, Q: 1.4, dur: 0.42, sweep: 0.3, peak: 0.34, attack: 0.03 });
    for (let k = 0; k < 4; k++) blip(ctx, out, t + 0.08 + k * 0.06, { type: 'sine', f0: (300 + 90 * k) * p, f1: (180 + 60 * k) * p, dur: 0.06, peak: 0.14 });
    return 0.5;
  },
  splat(ctx, out, o) {
    // coffee lands on the screen: wet splat + a sloppy bloop
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'lowpass', f0: 2400 * p, f1: 300 * p, Q: 1.2, dur: 0.3, sweep: 0.2, peak: 0.6, attack: 0.003 });
    blip(ctx, out, t, { type: 'sine', f0: 360 * p, f1: 90 * p, dur: 0.28, peak: 0.36, vib: 300, vibRate: 26 });
    hiss(ctx, out, t + 0.1, { type: 'bandpass', f0: 1200 * p, f1: 500 * p, Q: 3, dur: 0.22, peak: 0.16 });
    return 0.45;
  },
  accordion(ctx, out, o) {
    // squeezebox blast: a wheezy major chord with a bellows swell and wobbly reeds
    const { t, p } = opt(ctx, o);
    const dur = 0.62;
    const g = gain(ctx, 0);
    g.connect(out);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.04);
    g.gain.linearRampToValueAtTime(0.07, t + 0.2);
    g.gain.linearRampToValueAtTime(0.12, t + 0.42);
    g.gain.setTargetAtTime(0, t + dur - 0.08, 0.04);
    const lp = filter(ctx, 'lowpass', 2600, 1.2);
    lp.connect(g);
    const vib = osc(ctx, 'sine', 6.5, t);
    const vd = gain(ctx, 14);
    vib.connect(vd);
    for (const [n, det] of [['C4', -7], ['C4', 7], ['E4', -5], ['G4', 5], ['C5', -6], ['G3', 0]]) {
      const r = osc(ctx, n === 'G3' ? 'sawtooth' : 0.25, nf(n) * p, t);
      r.detune.value = det;
      vd.connect(r.detune);
      r.connect(lp);
      r.start(t); r.stop(t + dur + 0.1);
    }
    vib.start(t); vib.stop(t + dur + 0.1);
    hiss(ctx, out, t, { type: 'bandpass', f0: 700, Q: 0.8, dur: dur, peak: 0.12, attack: 0.05 });
    blip(ctx, out, t, { type: 'sine', f0: 80 * p, f1: 50 * p, dur: 0.3, peak: 0.3 });
    return dur + 0.15;
  },
  beerChug(ctx, out, o) {
    // glug-glug-glug-gulp: four throaty gulps with bubbly fizz
    const { t, p } = opt(ctx, o);
    for (let k = 0; k < 4; k++) {
      const tt = t + 0.04 + k * 0.15;
      blip(ctx, out, tt, { type: 'triangle', f0: (210 - k * 12) * p, f1: (110 - k * 6) * p, dur: 0.11, peak: 0.34, lp: 900 });
      hiss(ctx, out, tt + 0.03, { type: 'bandpass', f0: 1500 * p, Q: 4, dur: 0.06, peak: 0.12 });
    }
    const n = noise(ctx, t, 0.7);
    const hp = filter(ctx, 'highpass', 6000, 0.8);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    for (let k = 0; k < 24; k++) g.gain.setValueAtTime(Math.random() < 0.5 ? 0.05 + Math.random() * 0.05 : 0, t + k * 0.028);
    g.gain.setTargetAtTime(0, t + 0.68, 0.03);
    n.connect(hp); hp.connect(g); g.connect(out);
    blip(ctx, out, t + 0.66, { type: 'sine', f0: 520 * p, f1: 900 * p, dur: 0.1, peak: 0.12 });
    return 0.85;
  },
  beerRocket(ctx, out, o) {
    // the mug-rocket fires: a fizzy jet roar climbing in pitch + popping bubbles
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'lowpass', f0: 300, f1: 4200, Q: 1.6, dur: 1.3, sweep: 0.5, peak: 0.5, attack: 0.03 });
    const s = osc(ctx, 'sawtooth', 90 * p, t);
    s.frequency.exponentialRampToValueAtTime(420 * p, t + 0.6);
    const lp = filter(ctx, 'lowpass', 500, 2);
    lp.frequency.exponentialRampToValueAtTime(3000, t + 0.5);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.16, 0.06, 1.2);
    s.connect(lp); lp.connect(g); g.connect(out);
    s.start(t); s.stop(t + 1.3);
    for (let k = 0; k < 9; k++) blip(ctx, out, t + 0.1 + k * 0.09 + Math.random() * 0.04, { type: 'sine', f0: (900 + Math.random() * 1400) * p, f1: (1600 + Math.random() * 1800) * p, dur: 0.04, peak: 0.06 });
    return 1.35;
  },
  beerPop(ctx, out, o) {
    // ride over: a cork-like pop and a fizzy tail
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'highpass', f0: 1800, Q: 0.7, dur: 0.03, peak: 0.5 });
    blip(ctx, out, t, { type: 'sine', f0: 820 * p, f1: 300 * p, dur: 0.12, peak: 0.34 });
    hiss(ctx, out, t + 0.05, { type: 'bandpass', f0: 5000, f1: 2500, Q: 1, dur: 0.6, peak: 0.18, attack: 0.02 });
    return 0.7;
  },
  orbit(ctx, out, o) {
    // triples deploy: three quick rising whirls
    const { t, p } = opt(ctx, o);
    for (let k = 0; k < 3; k++) blip(ctx, out, t + k * 0.07, { type: 'triangle', f0: (500 + k * 160) * p, f1: (900 + k * 220) * p, glide: 0.06, dur: 0.1, peak: 0.12, vib: 120, vibRate: 30 });
    hiss(ctx, out, t, { type: 'bandpass', f0: 1200, f1: 3000, Q: 2, dur: 0.25, peak: 0.12 });
    return 0.35;
  },
  golden(ctx, out, o) {
    // Golden Toot window opens: a shimmering chime fanfare
    const { t, p } = opt(ctx, o);
    ['C6', 'E6', 'G6', 'C7'].forEach((n, i) => { bell(ctx, out, t + i * 0.06, nf(n) * p, 0.09, 0.7); blip(ctx, out, t + i * 0.06, { type: 'triangle', f0: nf(n) * p, dur: 0.18, peak: 0.06 }); });
    hiss(ctx, out, t, { type: 'highpass', f0: 7500, dur: 0.6, peak: 0.08, attack: 0.05 });
    return 0.8;
  },

  // ---------------------------------------------------------------- phone
  join(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 0.25, f0: nf('C6') * p, f1: nf('D6') * p, glide: 0.05, dur: 0.09, peak: 0.13, lp: 6000 });
    blip(ctx, out, t + 0.09, { type: 0.25, f0: nf('G6') * p, dur: 0.2, peak: 0.14, lp: 7000 });
    bell(ctx, out, t + 0.09, nf('G6') * p, 0.05, 0.4);
    return 0.45;
  },
  leave(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 0.25, f0: nf('G5') * p, dur: 0.09, peak: 0.13, lp: 5000 });
    blip(ctx, out, t + 0.1, { type: 0.25, f0: nf('C5') * p, f1: nf('B4') * p, dur: 0.22, peak: 0.13, lp: 4000 });
    return 0.4;
  },
};

// Per-sound level trims (linear) balancing perceived loudness after the master
// chain: UI blips and spark tones sit a bit under impacts; item/boost cues pop.
const TRIM = {
  menuMove: 2.6, menuSelect: 1.4, menuBack: 1.5, roulette: 2.8, throw: 2.2, boost: 1.9, star: 1.5,
  startBoost: 1.5, spin: 1.4, respawn: 1.25, itemBox: 1.5, bouncer: 1.4, rocket: 1.5, banana: 1.5,
  drift1: 2.4, drift2: 1.7, drift3: 1.5, hop: 1.5, join: 1.4, leave: 1.7,
  capoLaunch: 1.4, capoSiren: 1.5, bombThrow: 1.6, espresso: 1.5, splat: 1.4, accordion: 1.1,
  beerChug: 1.5, beerRocket: 1.3, beerPop: 1.4, orbit: 1.6, golden: 1.4, bombFuse: 1.3,
};

export const SOUNDS = {};
for (const [name, fn] of Object.entries(RAW)) {
  const trim = TRIM[name] || 1;
  SOUNDS[name] = trim === 1 ? fn : (ctx, out, o) => {
    const g = gain(ctx, trim);
    g.connect(out);
    return fn(ctx, g, o);
  };
}

/**
 * Add (or replace) a one-shot sound (SPEC §16.2, item plugins): `fn` has the
 * SOUNDS signature (ctx, destination, { when, pitch }) → duration in seconds
 * and is wrapped with a level trim like the built-in voices. The music system
 * is not touched. Plugins play their sounds through ctx.sfx(name, at) (the
 * 'item:sfx' bus event main.js plays distance-attenuated). Returns the name.
 * Build voices with SYNTH (below), e.g.
 *   registerSound('pepperShot', (ctx, out, o) => {
 *     const { t, p } = SYNTH.opt(ctx, o);
 *     SYNTH.blip(ctx, out, t, { type: 'square', f0: 880 * p, f1: 440 * p, glide: 0.08, dur: 0.12, peak: 0.12 });
 *     return 0.15;
 *   }, 1.2);
 */
export function registerSound(name, fn, trim = 1) {
  if (typeof name !== 'string' || !name || typeof fn !== 'function') throw new TypeError('registerSound(name, fn[, trim])');
  SOUNDS[name] = trim === 1 ? fn : (ctx, out, o) => {
    const g = gain(ctx, trim);
    g.connect(out);
    return fn(ctx, g, o);
  };
  return name;
}

/**
 * The synth building blocks the built-in sounds use, for registerSound voices
 * (all schedule on AudioContext time `t`; see their definitions above):
 *   opt(ctx, o) → { t, p }               when + pitch from the SOUNDS options
 *   osc(ctx, type, freq, t) · gain(ctx, v) · filter(ctx, type, freq, Q)
 *   noise(ctx, t, dur, rate, offset)     a started noise source
 *   perc(param, t, peak, attack, decay) · adsr(param, t, peak, attack, decay, sustain, end, release)
 *   blip(ctx, out, t, { type, f0, f1, glide, dur, peak, attack, lp, Q, detune, vib, vibRate })   pitched blip
 *   hiss(ctx, out, t, { type ('bandpass'), f0, f1, sweep, Q, dur, peak, attack, rate })        noise burst
 *   note(ctx, out, t, freq, dur, { type, peak, decay, sustain, release, lp, ... })
 *   bell(ctx, out, t, freq, peak, dur) · brass(ctx, out, t, freq, dur, peak)
 *   kickDrum / snareDrum / hatDrum / crashCymbal (ctx, out, t, vel, offset)
 *   nf('C#5') → Hz · mtof(midi) → Hz
 */
export const SYNTH = { opt, osc, gain, filter, noise, perc, adsr, blip, hiss, note, bell, brass, kickDrum, snareDrum, hatDrum, crashCymbal, nf, mtof };

/** v4 item sounds (SPEC §15.2), all in SOUNDS. */
export const ITEM_SOUND_NAMES = ['capoLaunch', 'capoSiren', 'capoSlam', 'bombThrow', 'bombFuse', 'espresso', 'splat',
  'accordion', 'beerChug', 'beerRocket', 'beerPop', 'orbit', 'golden'];

/** Names required by SPEC §10 + the v4 item sounds (all present in SOUNDS; SOUNDS also has 'jingleStart'). */
export const SOUND_NAMES = ['menuMove', 'menuSelect', 'menuBack', 'countdown', 'go', 'itemBox', 'roulette',
  'itemGet', 'throw', 'bouncer', 'rocket', 'toot', 'boost', 'hit', 'spin', 'explode', 'banana', 'stink', 'star',
  'zap', 'lap', 'finalLap', 'finish', 'lose', 'wall', 'bump', 'hop', 'land', 'drift1', 'drift2', 'drift3',
  'stall', 'startBoost', 'respawn', 'join', 'leave', ...ITEM_SOUND_NAMES];

/**
 * Which sound the game plays for the v4 item events (main.js plays them
 * positionally, like the other item one-shots):
 *   use[itemId]    on 'item:use' (first press; the Golden Toot's toots come through kart:boost 'item')
 *   event[type]    on that bus event, at e.kart (or e.position)
 * Not listed on purpose: explosions (items.js also emits item:explode, which
 * already plays 'explode'), and the HUD's own per-player cues — 'capoSiren'
 * while a capo is coming for that player and 'splat' when coffee lands on
 * their screen (hud.js plays those through its audio).
 */
export const ITEM_SFX = {
  use: {
    triple_banana: 'throw', triple_bouncer: 'bouncer', triple_rocket: 'rocket', capo: 'capoLaunch',
    meatball_bomb: 'bombThrow', espresso: 'espresso', accordion: 'accordion', beer_rocket: 'beerChug',
  },
  event: {
    'item:deploy': 'orbit', 'item:goldenStart': 'golden', 'item:capoHit': 'capoSlam', 'item:beerRide': 'beerRocket',
    'item:beerEnd': 'beerPop',
  },
};

// ============================================================ master chain

export const MUSIC_LEVEL = 0.3;      // music bus gain relative to the SFX bus

/**
 * SFX bus + music bus → compressor → master gain → soft limiter.
 * Returns { sfx, music, comp, master, output }; connect `output` to the destination.
 */
export function buildMasterChain(ctx, { limiter = true, volume = 0.8 } = {}) {
  const sfx = gain(ctx, 1);
  const music = gain(ctx, MUSIC_LEVEL);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.22;
  const master = gain(ctx, volume);
  sfx.connect(comp);
  music.connect(comp);
  comp.connect(master);
  let output = master;
  if (limiter) {
    const pre = gain(ctx, 0.5);
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve();
    shaper.oversample = '2x';
    master.connect(pre);
    pre.connect(shaper);
    output = shaper;
  }
  return { sfx, music, comp, master, output };
}

// ================================================================== music
//
// Every song is ORIGINAL (no existing melodies). A song is a list of bars; one
// bar is 4 beats of `stepsPerBeat` steps: 16 sixteenth-note steps by default,
// or 12 eighth-note-triplet steps (`stepsPerBeat: 3`, a compound 12/8 feel).
//
// Line tokens (one per step, whitespace separated, a bar per string):
//   note lines   'C#5' starts a note, '-' sustains the previous note (also
//                across a bar line), '.' is a rest.
//   degree lines (bass patterns, figure voices) '1 3 5 7 8 9 10 12 …' = root,
//                third, fifth, seventh, octave, ninth, tenth, twelfth … of the
//                chord sounding at that step; a trailing ' (up) or , (down)
//                shifts an octave. Placed near the voice's `base` pitch.
//   rhythm lines (comp, drums) 'x' = hit, 'o' = soft hit, '-' = hold the comp
//                chord, '.' = nothing. Drum lines are compact (one char a step).
// Chords: 'Am', 'G7', 'Dmaj7', 'F#m7', 'E7b9', 'D5', 'D/F#' (slash = bass note);
// 'Am7 D7' splits the bar evenly between two chords.
// Event layers: 0 = always, 1 = only at intensity 1 (final lap), 2 = only at intensity 0.
//
// Song definition fields (all optional except bpm/finalBpm/chords):
//   bpm, finalBpm, swing, stepsPerBeat, finalTranspose (semitones, final lap)
//   lead: [lines], leadInst, leadTranspose, double (lead2 an octave down, layer 1)
//   voices: [{ inst, lines | figure, base, layer, transpose, vel, from, to }]
//   bass: 'octave' | 'bounce' | { inst, pattern, base, layer, vel } | [ … ]
//   arp: { bars0, bars1, every, inst }  (chord arpeggio, legacy format)
//   comp: [{ inst, pattern, center, voicing: 'close'|'power', layer, vel, from, to }]
//   pad:  [{ inst, center, layer, vel, from, to }]   (held chords)
//   drums(bar) → { lane: '16 chars' } with lanes kick snare ohat crash hat1
//          (layer 1) hat2 (layer 2) and any DRUM instrument, 'name:1'/'name:2'
//          for layers; 'timp' is tuned to the chord root.
//   fx: { gain, mix: { bus: g }, pan: { bus: p }, lp: { bus: hz }, hp: { bus: hz },
//         echo: { steps, fb, lp, pan, send: { bus: s } },
//         verb: { type: 'room'|'hall'|'spring', ret, send: { bus: s } } }

const CHORD_TONES = {
  '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11],
  6: [0, 4, 7, 9], m6: [0, 3, 7, 9], sus2: [0, 2, 7], sus4: [0, 5, 7], 5: [0, 7],
  dim: [0, 3, 6], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], aug: [0, 4, 8],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], 9: [0, 4, 7, 10, 14], m9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14], '7b9': [0, 4, 7, 10, 13], '7sus4': [0, 5, 7, 10],
};

function parseChord(name) {
  const m = /^([A-G][#b]?)([a-z0-9#]*)(?:\/([A-G][#b]?))?$/.exec(name);
  if (!m || !CHORD_TONES[m[2]]) throw new Error(`[audio] bad chord "${name}"`);
  const root = noteToMidi(m[1] + '2');
  const tones = CHORD_TONES[m[2]];
  const third = tones.find((v) => v === 3 || v === 4) ?? tones.find((v) => v === 2 || v === 5) ?? 4;
  const fifth = tones.find((v) => v >= 6 && v <= 8) ?? 7;
  const seventh = tones.find((v) => v >= 9 && v <= 11) ?? 12;
  const ninth = tones.find((v) => v >= 13 && v <= 15);
  return {
    name, root, tones, pc: root % 12, bassPc: m[3] ? noteToMidi(m[3] + '2') % 12 : root % 12,
    deg: { 1: 0, 2: ninth != null ? ninth - 12 : 2, 3: third, 4: 5, 5: fifth, 6: 9, 7: seventh },
  };
}

// Pitch class `pc` placed within [center - 6, center + 6).
const placeNear = (pc, center) => center - 6 + ((((pc - (center - 6)) % 12) + 12) % 12);

// Degree token → midi for `chord`, root placed near `base` (bass: '1' = slash bass).
function degreeMidi(tok, chord, base, slash = false) {
  const m = /^(\d{1,2})([',]*)$/.exec(tok);
  if (!m) throw new Error(`[audio] bad degree "${tok}"`);
  let d = Number(m[1]);
  if (d < 1 || d > 15) throw new Error(`[audio] bad degree "${tok}"`);
  let oct = 0;
  while (d > 7) { d -= 7; oct += 12; }
  for (const c of m[2]) oct += c === "'" ? 12 : -12;
  if (slash && d === 1 && oct === 0 && chord.bassPc !== chord.pc) return placeNear(chord.bassPc, base);
  return placeNear(chord.pc, base) + chord.deg[d] + oct;
}

// Chord tones voiced in close position around `center` ('power' = root, fifth, octave).
function voiceChord(chord, center, voicing = 'close') {
  if (voicing === 'power') { const r = placeNear(chord.pc, center); return [r, r + 7, r + 12]; }
  const set = new Set(chord.tones.map((iv) => placeNear((chord.pc + iv) % 12, center)));
  return [...set].sort((a, b) => a - b);
}

function tokens(line, n, what) {
  const tok = line.trim().split(/\s+/);
  if (tok.length !== n) throw new Error(`[audio] ${what} needs ${n} steps, got ${tok.length}: "${line}"`);
  return tok;
}

// Note/degree tokens of a whole voice (one entry per step) → events; '-' ties across bars.
function parseVoice(tok, resolve, fn) {
  let cur = null;
  const flush = () => { if (cur) fn(cur.step, cur.midi, cur.len); cur = null; };
  tok.forEach((tk, i) => {
    if (tk === '-') { if (cur) cur.len++; }
    else if (tk === '.' || tk == null) flush();
    else { flush(); cur = { step: i, midi: resolve(tk, i), len: 1 }; }
  });
  flush();
}

function compileSong(name, def) {
  const bars = def.chords.length;
  const spb = def.stepsPerBeat || 4;
  const SB = spb * 4;                          // steps per bar
  const totalSteps = bars * SB;
  const steps = Array.from({ length: totalSteps }, () => []);
  const insts = new Set();
  const add = (step, ev) => { steps[step].push(ev); insts.add(ev.inst); };
  const inBars = (b, o) => b >= (o.from ?? 0) && b < (o.to ?? bars);

  // chord at every step
  const chordAt = [];
  def.chords.forEach((entry, b) => {
    const names = entry.trim().split(/\s+/);
    if (SB % names.length) throw new Error(`[audio] ${name}: bar ${b} cannot split ${names.length} chords`);
    const parsed = names.map(parseChord);
    for (let i = 0; i < SB; i++) chordAt[b * SB + i] = parsed[Math.floor((i * names.length) / SB)];
  });
  const noteTok = (tk) => noteToMidi(tk);

  // one voice of note lines (null / '' entries are silent bars)
  const lineVoice = (lines, o) => {
    const tok = [];
    for (let b = 0; b < bars; b++) {
      const line = lines[b];
      if (!line || !inBars(b, o)) { for (let i = 0; i < SB; i++) tok.push('.'); continue; }
      tok.push(...tokens(line, SB, `${name} ${o.inst} bar ${b}`));
    }
    return tok;
  };
  const emitVoice = (tok, o, resolve) => parseVoice(tok, resolve, (step, midi, len) => {
    add(step, { inst: o.inst, midi: midi + (o.transpose || 0), len, vel: o.vel ?? 1, layer: o.layer || 0 });
  });
  const figureTok = (o) => {
    const tok = [];
    for (let b = 0; b < bars; b++) {
      const pat = inBars(b, o) ? (typeof o.figure === 'function' ? o.figure(b) : o.figure) : null;
      if (!pat) { for (let i = 0; i < SB; i++) tok.push('.'); continue; }
      tok.push(...tokens(pat, SB, `${name} ${o.inst} figure bar ${b}`));
    }
    return tok;
  };

  // lead (+ legacy octave-down double on the final lap)
  if (def.lead) {
    const o = { inst: def.leadInst || 'lead', transpose: def.leadTranspose || 0, layer: def.leadLayer || 0 };
    const tok = lineVoice(def.lead, o);
    emitVoice(tok, o, noteTok);
    if (def.double) emitVoice(tok, { inst: def.doubleInst || 'lead2', transpose: o.transpose - 12, layer: 1 }, noteTok);
  }
  // extra melodic voices: explicit lines or chord-relative figures
  for (const v of def.voices || []) {
    if (v.lines) emitVoice(lineVoice(v.lines, v), v, noteTok);
    else emitVoice(figureTok(v), v, (tk, i) => degreeMidi(tk, chordAt[i], v.base ?? 60));
  }

  // bass
  const basses = def.bass == null ? [] : Array.isArray(def.bass) ? def.bass : [def.bass];
  for (const bs of basses) {
    if (bs === 'octave' || bs === 'bounce') {
      for (let b = 0; b < bars; b++) {
        const base = b * SB;
        const { root, tones } = chordAt[base];
        if (bs === 'octave') {
          for (let k = 0; k < 8; k++) {
            let m = chordAt[base + k * 2].root + (k % 2 ? 12 : 0);
            if (b % 4 === 3 && k === 6) m = chordAt[base + k * 2].root + 7;
            add(base + k * 2, { inst: 'bass', midi: m, len: 1.6, vel: k % 2 ? 0.85 : 1, layer: 0 });
          }
        } else {
          const third = root + tones[1];
          const pat = [[0, root, 3, 1], [3, root, 1, 0.7], [6, root + 7, 2, 0.9], [8, root + 12, 2, 0.9],
            [11, root + 7, 1, 0.7], [12, root, 2, 0.9], [14, third, 2, 0.8]];
          for (const [st, m, len, vel] of pat) add(base + st, { inst: 'bass', midi: m, len, vel, layer: 0 });
        }
      }
    } else {
      const o = { inst: bs.inst || 'bass', layer: bs.layer || 0, vel: bs.vel ?? 1, from: bs.from, to: bs.to, figure: bs.pattern };
      emitVoice(figureTok(o), o, (tk, i) => degreeMidi(tk, chordAt[i], bs.base ?? 40, true));
    }
  }

  // arpeggio (chord tones in octave 5, legacy)
  if (def.arp) {
    for (let b = 0; b < bars; b++) {
      const base = b * SB;
      const inRange = ([a, z]) => b >= a && b < z;
      const always = inRange(def.arp.bars0);
      if (!always && !inRange(def.arp.bars1)) continue;
      for (let k = 0; k < SB; k += def.arp.every) {
        const { root, tones } = chordAt[base + k];
        const pc = root % 12;
        const arpNotes = [...tones, 12].map((iv) => 72 + pc + iv - (pc > 6 ? 12 : 0));
        const idx = Math.floor(k / def.arp.every) % 4;
        add(base + k, { inst: def.arp.inst || 'arp', midi: arpNotes[idx], len: def.arp.every * 0.8, vel: k % 4 === 0 ? 1 : 0.7, layer: always ? 0 : 1 });
      }
    }
  }

  // comp (rhythmic chord hits) and pads (held chords, re-struck on every chord change)
  const compVoice = (o, patFor) => {
    let cur = null;
    const flush = () => { if (cur) add(cur.step, cur.ev); cur = null; };
    for (let b = 0; b < bars; b++) {
      const pat = inBars(b, o) ? patFor(b) : null;
      const tok = pat ? tokens(pat, SB, `${name} ${o.inst} comp bar ${b}`) : Array(SB).fill('.');
      tok.forEach((tk, i) => {
        const step = b * SB + i;
        if (tk === '-') { if (cur) cur.ev.len++; return; }
        flush();
        if (tk === 'x' || tk === 'o') {
          const ch = chordAt[step];
          const notes = voiceChord(ch, o.center ?? 60, o.voicing);
          cur = { step, ev: { inst: o.inst, midi: notes[0], notes, len: 1, vel: (o.vel ?? 1) * (tk === 'x' ? 1 : 0.6), layer: o.layer || 0 } };
        } else if (tk !== '.') throw new Error(`[audio] ${name}: bad comp token "${tk}"`);
      });
    }
    flush();
  };
  for (const c of def.comp || []) compVoice(c, (b) => (typeof c.pattern === 'function' ? c.pattern(b) : c.pattern));
  for (const p of def.pad || []) {
    compVoice(p, (b) => {
      const tok = [];
      for (let i = 0; i < SB; i++) tok.push(i === 0 || chordAt[b * SB + i] !== chordAt[b * SB + i - 1] ? 'x' : '-');
      return tok.join(' ');
    });
  }

  // drums
  if (def.drums) {
    for (let b = 0; b < bars; b++) {
      const base = b * SB;
      const d = def.drums(b) || {};
      for (const key of Object.keys(d)) {
        const pat = d[key];
        if (!pat) continue;
        let [inst, layer] = key.split(':');
        layer = layer ? Number(layer) : 0;
        if (inst === 'hat2') { inst = 'hat'; layer = 2; } else if (inst === 'hat1') { inst = 'hat'; layer = 1; }
        if (!DRUMS.has(inst)) throw new Error(`[audio] ${name}: unknown drum lane "${key}"`);
        if (pat.length !== SB) throw new Error(`[audio] ${name}: drum lane ${key} bar ${b} needs ${SB} steps`);
        for (let i = 0; i < SB; i++) {
          const c = pat[i];
          if (c !== 'x' && c !== 'o') continue;
          const midi = inst === 'timp' ? placeNear(chordAt[base + i].pc, 43) : 0;
          add(base + i, { inst, midi, len: 1, vel: c === 'x' ? 1 : 0.55, layer });
        }
      }
    }
  }

  for (const inst of insts) if (!INSTRUMENTS[inst]) throw new Error(`[audio] ${name}: unknown instrument "${inst}"`);
  return {
    name, bpm: def.bpm, finalBpm: def.finalBpm, swing: def.swing || 0, stepsPerBeat: spb, stepsPerBar: SB,
    finalTranspose: def.finalTranspose || 0, bars, totalSteps, steps, insts: [...insts], fx: def.fx || null,
  };
}

// ------------------------------------------------------------ the songs
// Race themes by track theme (main.js themeSong): race = Breezy Bay (bay),
// hilltown = Monte Mozzarella, campus = Aldrich Park, beach = Laguna Beach,
// castle = Krishiv's Palace; menu = lobby. Each race theme is 32 bars
// (A A' B C) and loops seamlessly; intensity 1 (final lap) is faster and adds layers.

const rest = (n) => Array(n).fill(null);
const without = (lines, from, to) => lines.map((l, b) => (b >= from && b < to ? null : l));

// Breezy Bay: sunny pop in G major, a syncopated hook on a bright square lead.
const BAY_HOOK = [
  'D5 . G5 . . A5 . B5 . D6 . . B5 - - .',
  'A5 . . F#5 . A5 . D6 - - . . C6 . A5 .',
  'G5 . B5 . . E6 . D6 . B5 . . G5 - E5 .',
];
const BAY_LEAD = [
  ...BAY_HOOK,
  'C6 - - . B5 . A5 . G5 - - - E5 . G5 .',
  BAY_HOOK[0],
  'A5 . . F#5 . A5 . D6 - - . . E6 . F#6 .',
  'G6 - - . E6 . D6 . C6 . . A5 . . C6 .',
  'B5 - - - A5 - - - D5 . E5 . F#5 . A5 .',
  ...BAY_HOOK,
  'C6 - - . B5 . C6 . E6 - - - D6 . C6 .',
  'A5 . C6 . . E6 . C6 . A5 . . G5 - E5 .',
  'F#5 . B5 . . D6 . B5 . F#5 . . D5 - F#5 .',
  'E5 . G5 . C6 - - . E6 - - . D6 - C6 .',
  'D6 - - - - - . . A5 . B5 . C6 . A5 .',
  'E5 - - . G5 - - . C6 - - . B5 - A5 -',
  'F#5 - - . A5 - - . D6 - - . C6 - A5 -',
  'B5 - - . D6 - - . F#6 - - . E6 - D6 -',
  'E6 - - - - - . . B5 . . G5 . . E5 .',
  'E5 - - . G5 - - . C6 - - . D6 - E6 -',
  'F#6 - - . E6 - - . D6 - - . A5 - D6 -',
  'G6 - - . F#6 - E6 - D6 - - . B5 . . .',
  'A5 - - - - - . . D6 . . . F#6 . A6 .',
  ...rest(4),                                     // breakdown: the marimba sings
  'B5 . E6 . G6 . E6 . B5 . E6 . G6 - - .',
  'G6 . E6 . C6 . E6 . G6 . E6 . C6 - - .',
  'A5 . C6 . E6 . C6 . A6 - - . G6 - E6 .',
  'F#6 - - . D6 . . A5 - - . . F#5 . A5 .',
];
const BAY_MARIMBA = [
  ...rest(24),
  'E5 . G5 . B5 . . E6 . D6 . B5 . . G5 .',
  'C5 . E5 . G5 . . C6 . B5 . G5 . . E5 .',
  'D5 . G5 . B5 . . D6 . E6 . D6 . . B5 .',
  'A5 . . F#5 . A5 . D6 - - . . C6 . A5 .',
];

// Monte Mozzarella: a tarantella gallop in 12/8 (12 steps = 4 dotted beats),
// A minor with harmonic-minor E chords, opening up to C major in the B half.
const MONTE_A = [
  'A5 - C6 E6 - C6 A5 - E5 A5 B5 C6',
  'B5 - G#5 E5 - G#5 B5 - D6 C6 B5 A5',
  'C6 - E6 A6 - E6 C6 - A5 E6 D6 C6',
];
const MONTE_TUNE = [
  ...MONTE_A,
  'B5 - - G#5 A5 B5 E5 - - . . .',
  MONTE_A[0],
  'D6 - F6 A6 - F6 D6 - A5 D6 E6 F6',
  'E6 - D6 C6 - B5 C6 B5 A5 G#5 - B5',
  'A5 - - C6 B5 A5 E5 - - E5 F5 G#5',
  ...MONTE_A,
  'B5 - D6 G#5 - B5 E5 - G#5 B5 D6 E6',
  'F6 - E6 D6 - A5 F5 - A5 D6 - F6',
  'E6 - C6 A5 - C6 E6 - D6 C6 B5 A5',
  'G#5 - B5 E6 - D6 C6 B5 A5 G#5 - -',
  'A5 - E5 A5 - C6 E6 - - G5 A5 B5',
  'C6 - - - - - E6 - G6 E6 - C6',
  'D6 - - - - - B5 - D6 G6 - F6',
  'E6 - - - - - C6 - E6 G6 A6 G6',
  'F6 - E6 D6 - C6 B5 - - G5 - -',
  'A5 - - - - - C6 - F6 A6 - G6',
  'G6 - - - - - E6 - C6 G5 - C6',
  'B5 - D6 G6 - F6 E6 - D6 C6 - B5',
  'C6 - - G5 A5 B5 C6 - - E6 F6 G6',
  'A6 - G6 E6 - G6 C6 - E6 G6 - E6',
  'F6 - D6 B5 - D6 G5 - B5 D6 - F6',
  'E6 - C6 G5 - C6 E6 - G6 C7 - -',
  'Bb6 - - G6 - E6 C6 - E6 G6 - Bb6',
  'A6 - - - - - F6 - A6 C7 - A6',
  'F6 - - - - - D6 - F6 A6 - F6',
  'E6 - F6 E6 - D6 C6 - B5 A5 - G#5',
  'B5 - - G#5 A5 B5 D6 - C6 B5 A5 G#5',
];

// Aldrich Park: breezy indie / lo-fi in D major — whistled tune, jangly
// guitar with a dotted echo, dusty electric piano, record crackle.
const PARK_A = [
  'F#5 - - . A5 - E5 - - - . . . . D5 E5',
  'F#5 - - . A5 - B5 - - - - - . . A5 .',
  'G5 - - . B5 - D6 - - - . . B5 . A5 .',
  'G5 - - - E5 - - - . . . . C#5 . E5 .',
];
const PARK_LEAD = [
  ...PARK_A,
  PARK_A[0],
  'F#5 - - . A5 - C#6 - - - - - . . B5 A5',
  'B5 - - . D6 - F#6 - - - . . E6 . D6 .',
  'C#6 - - - - - - - . . . . A5 . . .',
  ...PARK_A,
  'A5 - - . C#6 - E6 - - - . . C#6 . A5 .',
  'B5 - - . D6 - F#6 - - - . . E6 . D6 .',
  'E6 - - . D6 - B5 - C#6 - - . A5 . G5 .',
  'F#5 - - - - - - - . . . . . . . .',
  '. . D6 . D6 . B5 . D6 - E6 - F#6 - - .',
  'E6 - - . C#6 . A5 . . . E6 . D6 . C#6 .',
  '. . C#6 . C#6 . A5 . C#6 - D6 - E6 - - .',
  'D6 - - . B5 . F#5 . . . D6 . C#6 . B5 .',
  '. . B5 . B5 . G5 . B5 - C#6 - D6 - - .',
  'E6 - - . D6 . C#6 . . . A5 . B5 . C#6 .',
  'D6 - - . F#6 - - . E6 - - . D6 . B5 .',
  'C#6 - - - - - . . A5 . B5 . C#6 . E6 .',
  ...rest(4),                                     // breakdown: the glockenspiel answers
  'B5 - - - - - - - D6 - - - E6 - - -',
  'C#6 - - - - - - - A5 - - - C#6 - - -',
  'D6 - - - B5 - - - G5 - - - B5 - D6 -',
  'C#6 - - - - - - - . . . . D5 . E5 .',
];
const PARK_GLOCK = [
  ...rest(24),
  'E6 . G6 . B6 . . . A6 . G6 . F#6 . . .',
  'F#6 . A6 . C#7 . . . B6 . A6 . E6 . . .',
  'D6 . F#6 . B6 . . . A6 . F#6 . D6 . . .',
  'C#6 . E6 . A6 - - - G6 - - - E6 - - -',
];

// Laguna Beach: surf rock in E minor — twangy tremolo-picked lead drenched in
// spring reverb, an Andalusian (Am G F E) B section, a low baritone riff break.
const SURF_A = [
  'B4 . E5 . G5 . B5 - - - - - A5 . G5 .',
  'E5 - - - - - - - G5 . E5 . C5 . E5 .',
  'F#5 . A5 . D6 - - - - - C6 . B5 . A5 .',
  'B5 - - - - - - - A5 . F#5 . D#5 . F#5 .',
];
const SURF_LEAD = [
  ...SURF_A,
  SURF_A[0],
  'E5 - - - - - - - G5 . C6 . E6 . D6 .',
  'C6 - - . B5 . A5 . B5 - - . A5 . F#5 .',
  'E5 - - - - - - - - - - - . . . .',
  ...SURF_A,
  'G5 . B5 . E6 - - - - - D6 . B5 . G5 .',
  'E6 - - - - - - - D6 . C6 . B5 . A5 .',
  'B5 - - - - - - - D#6 - - - F#6 - - -',
  'B5 . A5 . F#5 . D#5 . B4 . . . . . . .',
  'E5 - - - - - D5 . C5 . B4 . A4 - - -',
  'D5 - - - - - C5 . B4 . A4 . G4 - - -',
  'C5 - - - - - B4 . A4 . G4 . F4 - - -',
  'B4 - - . G#4 . F4 . E4 - - - G#4 . B4 .',
  'A5 - - - - - G5 . F5 . E5 . C5 - - -',
  'B5 - - - - - A5 . G5 . D5 . B4 - - -',
  'A5 - - . G5 . F5 . G#5 - - . F5 . E5 .',
  'E5 - - - - - - - - - - - . . . .',
  'C4 . C4 . E4 . G4 . C5 . G4 . E4 . G4 .',     // baritone riff break
  'D4 . D4 . F#4 . A4 . D5 . A4 . F#4 . A4 .',
  'E4 . E4 . G4 . B4 . E5 . D5 . B4 . G4 .',
  'E4 . G4 . A4 . A#4 . B4 . . . B3 . . .',
  'G5 - - - - - - - E5 - - - - - - -',
  'F#5 - - - - - - - A5 - - - - - - -',
  'B5 - - - - - - - A5 - - - - - - -',
  'F#5 - - - D#5 - - - F#5 . . . . . . .',
];

// Krishiv's Palace: dark organ rock in D harmonic minor — pipe-organ lead over a
// flue-stop ostinato, distorted power chords, choir, timpani, a choir-led break.
const PALACE_A = [
  'D5 - - - - - - - A5 - - - F5 - E5 -',
  'D5 - - - - - - - F5 - - - Bb5 - A5 -',
  'G5 - - - - - Bb5 - D6 - - - C6 - Bb5 -',
  'A5 - - - - - - - C#6 - - - E6 - - -',
];
const PALACE_LEAD = [
  ...PALACE_A,
  'F6 - - - - - E6 - D6 - - - A5 - - -',
  'Bb5 - - - - - A5 - G5 - - - F5 - G5 -',
  'E5 - - - G5 - - - Bb5 - - - A5 - G5 -',
  'A5 - - - - - - - - - - - C#5 - E5 -',
  ...PALACE_A,
  'D6 - - - - - C#6 - D6 - - - A5 - - -',
  'C6 - - - - - A5 - F5 - - - A5 - C6 -',
  'Bb5 - - - A5 - G5 - E5 - - - C#5 - E5 -',
  'D5 - - - - - - - - - - - . . . .',
  'F5 - - - Bb5 - - - D6 - - - C6 - Bb5 -',
  'C6 - - - - - - - G5 - - - E5 - G5 -',
  'A5 - - - C6 - - - F6 - - - E6 - D6 -',
  'C#6 - - - - - - - - - - - A5 - - -',
  'D6 - - - F6 - - - Bb6 - - - A6 - G6 -',
  'G6 - - - - - E6 - C6 - - - E6 - G6 -',
  'F6 - - - - - D6 - Bb5 - - - D6 - G6 -',
  'E6 - - - - - C#6 - A5 - - - - - - -',
  ...rest(4),                                     // breakdown: the choir takes the line
  'G5 - - - Bb5 - - - D6 - - - Bb5 - - -',
  'C6 - - - Bb5 - - - A5 - - - G5 - - -',
  'A5 - - - C#6 - - - E6 - - - G6 - - -',
  'F6 - - - E6 - - - D6 - - - C#6 - - -',
];
const PALACE_CHOIR = [
  ...rest(24),
  'D5 - - - - - - - - - - - F5 - - -',
  'E5 - - - - - - - D5 - - - C#5 - - -',
  'D5 - - - - - - - - - - - F5 - - -',
  'G5 - - - - - - - F5 - - - E5 - - -',
];

const SONG_DEFS = {
  // Breezy Bay: 150 bpm → 158 and a whole step up (A major) on the final lap,
  // where an octave-down chip double, an 8th-note arpeggio and a shaker join.
  race: {
    bpm: 150, finalBpm: 158, swing: 0, finalTranspose: 2,
    chords: ['G', 'D', 'Em', 'C', 'G', 'D', 'C', 'D',
      'G', 'D', 'Em', 'C', 'Am', 'Bm', 'C', 'D',
      'C', 'D', 'Bm', 'Em', 'C', 'D', 'Em', 'D',
      'Em', 'C', 'G', 'D', 'Em', 'C', 'Am', 'D'],
    lead: BAY_LEAD, leadInst: 'sqlead', double: true,
    voices: [
      { inst: 'marimba', base: 60, vel: 0.8,
        figure: (b) => (b >= 24 && b < 28 ? null : b >= 16 && b < 24 ? '1 . 5 . 8 . 10 . 12 . 10 . 8 . 5 .' : '1 . . 5 . . 8 . 10 . . 8 . . 5 .') },
      { inst: 'marimba', lines: BAY_MARIMBA },
    ],
    comp: [{ inst: 'pluck', center: 64, vel: 0.7, pattern: '. . x . . . x . . . x . . . x .' }],
    bass: { inst: 'bass', base: 43,
      pattern: (b) => (b >= 24 && b < 28 ? '1 - - - - - - - 5 - - - - - - -' : '1 - . 1 - . 8 - 1 - 5 - 8 - 5 -') },
    arp: { bars0: [0, 0], bars1: [0, 32], every: 2 },
    drums(bar) {
      const fill = bar % 8 === 7, brk = bar >= 24 && bar < 28;
      return {
        kick: brk ? 'x.......x.......' : fill ? 'x.....x.x.x.x...' : 'x.....x.x.......',
        snare: fill ? '....x.......x.xx' : '....x.......x...',
        clap: brk ? '................' : '....x.......x...',
        hat2: '..x...x...x...x.',
        hat1: 'xoxoxoxoxoxoxoxo',
        'shaker:1': 'oxoxoxoxoxoxoxox',
        ohat: bar % 2 === 1 && !fill ? '..............o.' : '................',
        crash: bar % 8 === 0 ? 'x...............' : '................',
      };
    },
    fx: {
      gain: 0.87, mix: { lead: 1.75, marimba: 1.4, pluck: 2.1, perc: 1.8 },
      pan: { marimba: -0.3, pluck: 0.3, perc: 0.15 },
      echo: { steps: 3, fb: 0.28, send: { lead: 0.18 } },
      verb: { type: 'room', send: { lead: 0.12, marimba: 0.2, pluck: 0.18, drums: 0.05, perc: 0.1 } },
    },
  },
  // Monte Mozzarella: tarantella in 12/8 (A minor → C major), 160 → 174 bpm.
  // Mandolin tremolo lead; on the final lap the accordion takes the melody,
  // the mandolin tremolos the harmony underneath, claps + castanets join.
  hilltown: {
    bpm: 160, finalBpm: 174, swing: 0, stepsPerBeat: 3,
    chords: ['Am', 'E', 'Am', 'E', 'Am', 'Dm', 'E', 'Am',
      'Am', 'E', 'Am', 'E7', 'Dm', 'Am', 'E', 'Am',
      'C', 'G', 'C', 'G', 'F', 'C', 'G', 'C',
      'C', 'G7', 'C', 'C7', 'F', 'Dm', 'E', 'E7'],
    voices: [
      { inst: 'mandolin', lines: MONTE_TUNE, transpose: -12, layer: 2 },
      { inst: 'accordion', lines: MONTE_TUNE, transpose: -12, layer: 1 },
      { inst: 'mandolin', base: 62, figure: '3 - - - - - 5 - - - - -', layer: 1, vel: 0.55 },
    ],
    comp: [{ inst: 'squeeze', center: 64, pattern: '. x o . x o . x o . x o' }],
    bass: { inst: 'bass', base: 45, pattern: '1 - . 5 - . 1 - . 5 - .' },
    drums(bar) {
      const fill = bar % 8 === 7;
      return {
        kick: fill ? 'x..x..x.....' : 'x..o..x..o..',
        snare: fill ? '.........xox' : '...o.....o..',
        tamb: 'xooxooxooxoo',
        'clap:1': '...x.....x..',
        'castanet:1': fill ? '............' : '..x..x..x.xx',
        crash: bar % 16 === 0 ? 'x...........' : '............',
      };
    },
    fx: {
      gain: 0.95, mix: { mandolin: 1.6, accordion: 1.6, squeeze: 1.4, perc: 1.6 },
      pan: { mandolin: 0.12, accordion: 0.08, squeeze: -0.25, perc: 0.3 },
      echo: { steps: 3, fb: 0.22, send: { mandolin: 0.1, accordion: 0.08 } },
      verb: { type: 'room', send: { mandolin: 0.16, accordion: 0.14, squeeze: 0.12, perc: 0.08, drums: 0.05 } },
    },
  },
  // Aldrich Park: lightly swung 124 bpm → 136. Final lap: driving octave bass,
  // 16th hats, tambourine backbeat, glockenspiel sparkles.
  campus: {
    bpm: 124, finalBpm: 136, swing: 0.14,
    chords: ['Dmaj7', 'Bm7', 'Em7', 'A7', 'Dmaj7', 'F#m7', 'Gmaj7', 'A',
      'Dmaj7', 'Bm7', 'Em7', 'A7', 'F#m7', 'Bm7', 'Em7 A7', 'Dmaj7',
      'Gmaj7', 'A', 'F#m7', 'Bm7', 'Gmaj7', 'A', 'Bm7', 'A',
      'Em7', 'F#m7', 'Gmaj7', 'A', 'Em7', 'F#m7', 'G', 'A7'],
    lead: PARK_LEAD, leadInst: 'whistle',
    voices: [
      { inst: 'pluck', base: 52, vel: 0.8, figure: '1 . 5 . 8 . 9 . 10 . 9 . 8 . 5 .' },
      { inst: 'glock', lines: PARK_GLOCK },
      { inst: 'glock', base: 79, layer: 1, vel: 0.7,
        figure: (b) => (b >= 24 && b < 28 ? null : '. . 8 . . . 5 . . . 10 . . . 9 .') },
    ],
    comp: [{ inst: 'epiano', center: 62, vel: 0.9,
      pattern: (b) => (b % 2 ? '. . . . x - - - . . x - - - . .' : 'x - - - - - x - - . . . . . . .') }],
    bass: [
      { inst: 'subbass', base: 40, layer: 2, pattern: '1 - - . . . 1 . . . 5 - - . 3 .' },
      { inst: 'subbass', base: 40, layer: 1, vel: 0.75, pattern: '1 - 8 . 1 - 8 . 1 - 8 . 5 - 8 .' },
    ],
    drums(bar) {
      const fill = bar % 8 === 7, brk = bar >= 24 && bar < 28;
      return {
        kick: brk ? 'x.........x.....' : fill ? 'x......x..x.x.x.' : 'x......x..x.....',
        snare: brk ? '................' : fill ? '....x.......x.ox' : '....x.......x...',
        rim: brk ? '....x.......x...' : '................',
        hat2: 'x.o.x.o.x.o.x.o.',
        hat1: 'xoxoxoxoxoxoxoxo',
        'tamb:1': '....x.......x...',
        'ohat:1': bar % 2 ? '..............o.' : '................',
        vinyl: 'x...............',
        crash: bar % 8 === 0 && !brk ? 'o...............' : '................',
      };
    },
    fx: {
      gain: 1, mix: { subbass: 0.55, whistle: 1.4, epiano: 1.6, pluck: 1.9, glock: 2, perc: 1.6 },
      lp: { drums: 10000, perc: 7000 },
      pan: { pluck: -0.3, epiano: 0.2, glock: 0.35, whistle: 0.05, perc: 0.2 },
      echo: { steps: 3, fb: 0.32, lp: 2400, send: { pluck: 0.25, whistle: 0.12 } },
      verb: { type: 'room', send: { whistle: 0.2, epiano: 0.15, glock: 0.25, pluck: 0.12, drums: 0.04 } },
    },
  },
  // Laguna Beach: 170 bpm → 178 and up a whole step (F♯ minor) on the final
  // lap, with double-time hats and an octave-down baritone double of the lead.
  beach: {
    bpm: 170, finalBpm: 178, swing: 0, finalTranspose: 2,
    chords: ['Em', 'C', 'D', 'B7', 'Em', 'C', 'Am B7', 'Em',
      'Em', 'C', 'D', 'B7', 'Em', 'C', 'B7', 'B7',
      'Am', 'G', 'F', 'E', 'Am', 'G', 'F E', 'E',
      'C', 'D', 'Em', 'Em', 'C', 'D', 'B7', 'B7'],
    lead: SURF_LEAD, leadInst: 'surf',
    voices: [{ inst: 'surf', lines: without(SURF_LEAD, 24, 28), transpose: -12, layer: 1, vel: 0.65 }],
    comp: [{ inst: 'combo', center: 67,
      pattern: (b) => (b >= 16 && b < 24 ? '. . x - . . x - . . x - . . x -'
        : b >= 24 && b < 28 ? 'x - . . . . x - . . x - . . . .' : '. . x . . . x . . . x . . . x .') }],
    bass: { inst: 'bass', base: 40, pattern: '1 . 1 . 5 . 5 . 8 . 8 . 5 . 3 .' },
    drums(bar) {
      const fill = bar % 8 === 7, riff = bar >= 24 && bar < 28;
      return {
        kick: riff ? 'x...x...x...x...' : fill ? 'x.......x.x.x...' : 'x.......x.x.....',
        snare: riff ? '................' : fill ? '....x.......x.xx' : '....x.......x...',
        tomL: riff ? 'x.x.x.x.x.x.x.x.' : '....x.......x...',
        tomM: fill ? '........x.x.....' : bar === 27 ? '........x.x.x.x.' : '................',
        tomH: fill ? '............xx..' : '................',
        hat2: riff ? '................' : 'x.x.x.x.x.x.x.x.',
        hat1: 'xoxoxoxoxoxoxoxo',
        crash: bar % 8 === 0 ? 'x...............' : '................',
      };
    },
    fx: {
      gain: 0.77, mix: { surf: 2, combo: 2.2 },
      pan: { combo: -0.3, surf: 0.12 },
      echo: { steps: 3, fb: 0.2, send: { surf: 0.06 } },
      verb: { type: 'spring', send: { surf: 0.6, combo: 0.35, drums: 0.1 } },
    },
  },
  // Krishiv's Palace: 140 bpm → 152; the final lap adds tolling bells and a
  // 16th-note double kick.
  castle: {
    bpm: 140, finalBpm: 152, swing: 0,
    chords: ['Dm', 'Bb', 'Gm', 'A', 'Dm', 'Bb', 'Edim', 'A',
      'Dm', 'Bb', 'Gm', 'A', 'Dm', 'F', 'Gm A', 'Dm',
      'Bb', 'C', 'F', 'A', 'Bb', 'C', 'Gm', 'A',
      'Dm', 'Dm', 'Bb', 'Bb', 'Gm', 'Gm', 'A', 'A'],
    lead: PALACE_LEAD, leadInst: 'pipe',
    voices: [
      { inst: 'flue', base: 50, vel: 0.85, figure: '1 5 8 5 3 5 8 5 1 5 8 5 10 8 5 3' },
      { inst: 'choir', lines: PALACE_CHOIR, vel: 1.4 },
      { inst: 'bells', base: 62, layer: 1, figure: '8 . . . . . . . 5 . . . . . . .' },
    ],
    pad: [{ inst: 'choir', center: 62, vel: 0.5 }],
    comp: [{ inst: 'power', voicing: 'power', center: 45,
      pattern: (b) => (b >= 24 && b < 28 ? null : b >= 28 ? 'x - - - x - - - x - - - x - o o' : 'x - o . o . o . x - o . o . o .') }],
    bass: { inst: 'pedal', base: 38, pattern: '1 - - - - - - - 1 - - - - - - -' },
    drums(bar) {
      const brk = bar >= 24 && bar < 28, roll = bar % 8 === 7;
      return {
        kick: brk ? '................' : roll ? 'x.......x.x.x.x.' : 'x.....x.x.......',
        'dkick:1': brk ? '................' : 'xoxoxoxoxoxoxoxo',
        snare: brk ? '................' : roll ? '....x.......xxxx' : '....x.......x...',
        hat: brk ? '................' : 'x.x.x.x.x.x.x.x.',
        timp: brk ? (bar === 27 ? 'oooooooooooooooo' : 'x.......x.......') : roll ? 'x...........oooo' : 'x...............',
        crash: bar % 8 === 0 ? 'x...............' : '................',
      };
    },
    fx: {
      gain: 0.85, mix: { choir: 0.25, pipe: 1.6, flue: 1.8, power: 0.8, timp: 0.8, bells: 0.8 },
      pan: { flue: -0.2, bells: 0.25, power: 0.15 },
      echo: { send: {} },
      verb: { type: 'hall', send: { pipe: 0.3, flue: 0.28, choir: 0.4, bells: 0.4, timp: 0.25, drums: 0.12, power: 0.05, pedal: 0.08 } },
    },
  },
  // Laid-back, swung menu groove in F major, 8 bars at 112 bpm.
  menu: {
    bpm: 112, finalBpm: 124, swing: 0.16,
    chords: ['F', 'Dm', 'Bb', 'C', 'F', 'Am', 'Bb', 'C'],
    lead: [
      'A5 - - . C6 . A5 . G5 - F5 - - - . .',
      'D5 - F5 . A5 - - . G5 . F5 . E5 - D5 .',
      'F5 - - - D5 . F5 . Bb5 - - . A5 . G5 .',
      'E5 - - - G5 - - - C6 - - - - - . .',
      'A5 - - . C6 . F6 . E6 - C6 . A5 - - .',
      'C6 - - . E5 . A5 . C6 - B5 . A5 - E5 .',
      'D6 - - . Bb5 . F5 . D6 - C6 . Bb5 - A5 .',
      'G5 - - - - - . . E5 . F5 . G5 - - .',
    ],
    bass: 'bounce',
    arp: { bars0: [4, 8], bars1: [0, 8], every: 2 },
    double: false,
    drums(bar) {
      return {
        kick: bar % 2 === 1 ? 'x.........x...o.' : 'x.........x.....',
        snare: '....o.......o...',
        hat2: 'o.o.o.o.o.o.o.o.',
        hat1: 'oooooooooooooooo',
        ohat: bar === 7 ? '..............o.' : '................',
        crash: '................',
      };
    },
  },
};

const COMPILED = {};
/** Compiled song by kind (see SONG_KINDS) or null. */
export function getSong(kind) {
  if (!SONG_DEFS[kind]) return null;
  return COMPILED[kind] || (COMPILED[kind] = compileSong(kind, SONG_DEFS[kind]));
}
export const SONG_KINDS = Object.keys(SONG_DEFS);

/** Seconds per step at the given intensity. */
export function songStepDuration(song, intensity = 0) {
  return 60 / ((intensity >= 1 ? song.finalBpm : song.bpm) * (song.stepsPerBeat || 4));
}

/** Loop length in seconds at the given intensity. */
export function songLoopDuration(song, intensity = 0) {
  return song.totalSteps * songStepDuration(song, intensity);
}

// ------------------------------------------------------------ music FX

// Deterministic stereo impulse responses for the music reverb (cached per context).
//   room   short, bright ambience
//   hall   long, darkening tail (palace)
//   spring dispersive "drip" of a guitar-amp spring tank (surf)
const IR_TYPES = {
  room: { seconds: 0.9, rt60: 0.7, pre: 0.008, lpStart: 9000, lpEnd: 3500, seed: 0x1200 },
  hall: { seconds: 2.8, rt60: 2.5, pre: 0.022, lpStart: 7000, lpEnd: 1500, seed: 0x4a11 },
  spring: { seconds: 2.0, rt60: 1.7, pre: 0.004, lpStart: 5200, lpEnd: 2600, seed: 0x5971, spring: true },
};

function impulseResponse(ctx, type) {
  const c = cacheFor(ctx);
  const key = 'ir_' + type;
  if (c[key]) return c[key];
  const P = IR_TYPES[type] || IR_TYPES.room;
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * P.seconds);
  const buf = ctx.createBuffer(2, len, sr);
  const rng = makeRng(P.seed);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let y = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const fc = P.lpEnd + (P.lpStart - P.lpEnd) * Math.exp(-t / (P.rt60 * 0.25));
      const a = Math.exp((-2 * Math.PI * fc) / sr);
      y = (1 - a) * (rng() * 2 - 1) + a * y;
      const fadeIn = t < P.pre ? t / P.pre : 1;
      d[i] = y * Math.exp((-6.91 * t) / P.rt60) * fadeIn;
    }
    if (P.spring) {
      // Echo train of the spring's round trip, smeared into chirps by a
      // cascade of first-order allpasses (the classic spring-tank model).
      const T0 = ch ? 0.0347 : 0.0311;
      const train = new Float32Array(len);
      for (let k = 0; k * T0 < P.seconds; k++) {
        const i = Math.floor(k * T0 * sr) + 1;
        if (i < len) train[i] = Math.pow(0.8, k) * (k % 2 ? -1 : 1);
      }
      const ap = 0.62;
      for (let s = 0; s < 36; s++) {
        let x1 = 0, y1 = 0;
        for (let i = 0; i < len; i++) {
          const x = train[i];
          const v = -ap * x + x1 + ap * y1;
          x1 = x; y1 = v; train[i] = v;
        }
      }
      let e1 = 0, e2 = 0;
      for (let i = 0; i < len; i++) { e1 += d[i] * d[i]; e2 += train[i] * train[i]; }
      const w = Math.sqrt(e1 / Math.max(1e-12, e2)) * 1.3;
      for (let i = 0; i < len; i++) d[i] = d[i] * 0.55 + train[i] * w;
    }
    // unit energy per channel (the bus send / return gains then set the wet level)
    let e = 0;
    for (let i = 0; i < len; i++) e += d[i] * d[i];
    const g = 1 / Math.sqrt(Math.max(1e-12, e));
    for (let i = 0; i < len; i++) d[i] *= g;
  }
  c[key] = buf;
  return buf;
}

// tanh drive curve for the power-chord bus.
function driveCurve(ctx) {
  const c = cacheFor(ctx);
  if (!c.drive) {
    const n = 1025, k = 2.6;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
    c.drive = curve;
  }
  return c.drive;
}

// Additive organ stops (harmonic amplitudes) as cached PeriodicWaves.
const ORGAN_STOPS = {
  pipe: [0, 1, 0.62, 0.34, 0.42, 0.12, 0.22, 0, 0.16, 0, 0.07, 0, 0.08, 0, 0, 0, 0.05],
  flue: [0, 1, 0.45, 0.16, 0.22, 0.04, 0.08, 0, 0.05],
  pedal: [0, 1, 0.55, 0.2, 0.18, 0.05, 0.06],
  combo: [0, 1, 0.5, 0.33, 0.45, 0.2, 0.25, 0.14, 0.2, 0.11, 0.1, 0.09, 0.08],
};
function organWave(ctx, stop) {
  const c = cacheFor(ctx);
  const key = 'organ_' + stop;
  if (!c[key]) {
    const amps = ORGAN_STOPS[stop];
    c[key] = ctx.createPeriodicWave(new Float32Array(amps.length), Float32Array.from(amps));
  }
  return c[key];
}

// Instruments write into named buses of the rig: their own name, except the
// v4 lead2 ('lead'), kit pieces + toms ('drums') and hand percussion ('perc').
const DEFAULT_PAN = { lead: 0.1, arp: -0.35 };

/**
 * Per-song node graph: lazily created instrument buses (gain → optional
 * filters → pan) feeding the song's output, a tempo-synced echo and an
 * optional convolution reverb (both fed by per-bus sends), all set by
 * `song.fx`. Without a song it is the v4 rig (echo on the lead).
 */
export function createMusicRig(ctx, destination, song = null) {
  const fx = (song && song.fx) || {};
  const out = gain(ctx, fx.gain ?? 1);
  out.connect(destination);
  const ecfg = { steps: 3, fb: 0.3, lp: 2600, pan: -0.25, send: { lead: 0.24 }, ...(fx.echo || {}) };
  const echo = ctx.createDelay(2);
  echo.delayTime.value = 0.3;
  const echoIn = gain(ctx, 1), fb = gain(ctx, ecfg.fb), elp = filter(ctx, 'lowpass', ecfg.lp, 0.5);
  const ret = ctx.createStereoPanner ? ctx.createStereoPanner() : gain(ctx, 1);
  if (ret.pan) ret.pan.value = ecfg.pan;
  echoIn.connect(echo); echo.connect(elp); elp.connect(fb); fb.connect(echo);
  elp.connect(ret); ret.connect(out);
  let verbIn = null;
  if (fx.verb) {
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = impulseResponse(ctx, fx.verb.type || 'room');
    verbIn = gain(ctx, 1);
    const hp = filter(ctx, 'highpass', fx.verb.hp ?? 160, 0.7);
    const vret = gain(ctx, fx.verb.ret ?? 1);
    verbIn.connect(conv); conv.connect(hp); hp.connect(vret); vret.connect(out);
  }
  const buses = new Map();
  const rig = {
    ctx, out, echo, buses,
    bus(name) {
      let b = buses.get(name);
      if (b) return b;
      b = gain(ctx, (fx.mix && fx.mix[name]) ?? 1);
      let tail = b;
      const chain = (node) => { tail.connect(node); tail = node; };
      if (name === 'power') {
        // distorted guitar: drive → tanh → cabinet filters
        const drive = gain(ctx, 7);
        const sh = ctx.createWaveShaper();
        sh.curve = driveCurve(ctx);
        sh.oversample = '2x';
        chain(drive); chain(sh);
        chain(filter(ctx, 'highpass', 110, 0.7));
        chain(filter(ctx, 'lowpass', 3400, 0.9));
        const pk = filter(ctx, 'peaking', 1400, 1.1);
        pk.gain.value = 3;
        chain(pk);
        chain(gain(ctx, 0.16));
      }
      if (fx.hp && fx.hp[name]) chain(filter(ctx, 'highpass', fx.hp[name], 0.7));
      if (fx.lp && fx.lp[name]) chain(filter(ctx, 'lowpass', fx.lp[name], 0.7));
      const p = (fx.pan && fx.pan[name]) ?? DEFAULT_PAN[name] ?? 0;
      if (p && ctx.createStereoPanner) {
        const pn = ctx.createStereoPanner();
        pn.pan.value = p;
        tail.connect(pn); pn.connect(out);
      } else {
        tail.connect(out);
      }
      const es = ecfg.send && ecfg.send[name];
      if (es) { const s = gain(ctx, es); tail.connect(s); s.connect(echoIn); }
      const vs = verbIn && fx.verb.send && fx.verb.send[name];
      if (vs) { const s = gain(ctx, vs); tail.connect(s); s.connect(verbIn); }
      buses.set(name, b);
      return b;
    },
    get lead() { return rig.bus('lead'); },
    get bass() { return rig.bus('bass'); },
    get drums() { return rig.bus('drums'); },
    get arp() { return rig.bus('arp'); },
    setTempo(stepDur, t) { echo.delayTime.setValueAtTime(Math.min(1.9, stepDur * ecfg.steps), t); },
    dispose() { try { out.disconnect(); } catch { /* already gone */ } },
  };
  return rig;
}

// ------------------------------------------------------------ instruments
//
// INSTRUMENTS[name](rig, t, midi, dur, vel, seed, ev, stepDur, transpose).
// Chord instruments read ev.notes (+ transpose). Noise offsets derive from
// `seed` (the step index), so a loop renders identically every time around.

const chordNotes = (ev, tr) => (ev && ev.notes ? ev.notes.map((n) => n + tr) : [ev.midi + tr]);
const seedOff = (seed, k) => (seed * k) % 1.5;   // noise-buffer offset (s), < 2 s buffer

// Partial bank (sine partials with individual decays) — mallets, bells.
function partials(ctx, out, t, f, peak, list, attack = 0.002) {
  const ny = ctx.sampleRate * 0.45;
  for (const [ratio, amp, dk] of list) {
    if (f * ratio >= ny) continue;
    const s = osc(ctx, 'sine', f * ratio, t);
    const g = gain(ctx, 0);
    perc(g.gain, t, peak * amp, attack, dk);
    s.connect(g); g.connect(out);
    s.start(t); s.stop(t + dk + 0.05);
  }
}

// Repeated picking envelope (tremolo-picked strings): one attack every `pick` s.
function pickEnvelope(param, filt, t, end, pick, peak, bright, dark) {
  param.setValueAtTime(0, t);
  let k = 0;
  for (let tp = t; tp < end - 0.008; tp += pick, k++) {
    const pk = peak * (k % 2 ? 0.8 : 1);
    param.setTargetAtTime(pk, tp, 0.0025);
    param.setTargetAtTime(pk * 0.28, tp + 0.007, pick * 0.4);
    if (filt) { filt.frequency.setTargetAtTime(bright, tp, 0.002); filt.frequency.setTargetAtTime(dark, tp + 0.006, pick * 0.5); }
  }
  param.setTargetAtTime(0, end, 0.012);
}

function vibrato(ctx, t, end, rate, cents, delay, targets) {
  const l = osc(ctx, 'sine', rate, t);
  const d = gain(ctx, 0);
  d.gain.setValueAtTime(0, t + delay);
  d.gain.linearRampToValueAtTime(cents, t + delay + 0.25);
  l.connect(d);
  for (const p of targets) d.connect(p);
  l.start(t); l.stop(end + 0.1);
}

function tom(rig, t, f0, vel, seed, dk) {
  const ctx = rig.ctx, out = rig.bus('drums');
  const s = osc(ctx, 'sine', f0 * 1.6, t);
  s.frequency.exponentialRampToValueAtTime(f0, t + 0.07);
  const g = gain(ctx, 0);
  perc(g.gain, t, 0.3 * vel, 0.002, dk);
  s.connect(g); g.connect(out);
  s.start(t); s.stop(t + dk + 0.05);
  hiss(ctx, out, t, { type: 'bandpass', f0: 1500, Q: 0.8, dur: 0.02, peak: 0.06 * vel, offset: seedOff(seed, 0.0611) });
}

const INSTRUMENTS = {
  // ---------------------------------------------------- v4 chiptune voices
  lead(rig, t, midi, dur, vel) {
    const ctx = rig.ctx, f = mtof(midi);
    const end = t + Math.max(0.04, dur - 0.015);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.12 * vel, 0.005, 0.12, 0.72, end, 0.06);
    const o = osc(ctx, 0.25, f * 1.015, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.025);
    o.connect(g); g.connect(rig.lead);
    if (dur > 0.28) {
      const l = osc(ctx, 'sine', 5.8, t);
      const d = gain(ctx, 0);
      d.gain.setValueAtTime(0, t + 0.12);
      d.gain.linearRampToValueAtTime(16, t + 0.35);
      l.connect(d); d.connect(o.detune);
      l.start(t); l.stop(end + 0.1);
    }
    o.start(t); o.stop(end + 0.1);
  },
  lead2(rig, t, midi, dur, vel) {
    const ctx = rig.ctx;
    const end = t + Math.max(0.04, dur - 0.015);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.07 * vel, 0.005, 0.1, 0.6, end, 0.05);
    const o = osc(ctx, 0.125, mtof(midi), t);
    o.detune.value = 6;
    o.connect(g); g.connect(rig.lead);
    o.start(t); o.stop(end + 0.08);
  },
  bass(rig, t, midi, dur, vel) {
    const ctx = rig.ctx, f = mtof(midi);
    const end = t + dur * 0.85;
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.22 * vel, 0.004, 0.1, 0.55, end, 0.04);
    const lp = filter(ctx, 'lowpass', 2200, 3);
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.setTargetAtTime(520, t, 0.06);
    const o1 = osc(ctx, 0.5, f, t), o2 = osc(ctx, 'triangle', f, t);
    const g1 = gain(ctx, 0.45);
    o1.connect(g1); g1.connect(lp); o2.connect(lp);
    lp.connect(g); g.connect(rig.bass);
    o1.start(t); o2.start(t); o1.stop(end + 0.06); o2.stop(end + 0.06);
  },
  arp(rig, t, midi, dur, vel) {
    const ctx = rig.ctx;
    const g = gain(ctx, 0);
    const d = Math.min(dur, 0.09);
    perc(g.gain, t, 0.045 * vel, 0.002, d);
    const o = osc(ctx, 0.125, mtof(midi), t);
    o.connect(g); g.connect(rig.arp);
    o.start(t); o.stop(t + d + 0.03);
  },
  kick(rig, t, m, d, vel, seed) { kickDrum(rig.ctx, rig.drums, t, vel, (seed * 0.0731) % 1.7); },
  snare(rig, t, m, d, vel, seed) { snareDrum(rig.ctx, rig.drums, t, vel * 0.8, (seed * 0.0517) % 1.5); },
  hat(rig, t, m, d, vel, seed) { hatDrum(rig.ctx, rig.drums, t, vel * 0.8, (seed * 0.0373) % 1.9, false); },
  ohat(rig, t, m, d, vel, seed) { hatDrum(rig.ctx, rig.drums, t, vel * 0.8, (seed * 0.0291) % 1.7, true); },
  crash(rig, t, m, d, vel, seed) { crashCymbal(rig.ctx, rig.drums, t, vel * 0.8, (seed * 0.0119) % 0.5); },

  // ---------------------------------------------------- melodic voices (v5)
  // Bright pop square lead: square + 25 % pulse, scoop-in, delayed vibrato.
  sqlead(rig, t, midi, dur, vel) {
    const ctx = rig.ctx, f = mtof(midi), out = rig.bus('lead');
    const end = t + Math.max(0.05, dur - 0.012);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.085 * vel, 0.004, 0.16, 0.68, end, 0.05);
    const lp = filter(ctx, 'lowpass', 5200, 0.6);
    lp.connect(g); g.connect(out);
    const a = osc(ctx, 0.5, f * 1.012, t), b = osc(ctx, 0.25, f * 1.012, t);
    a.frequency.exponentialRampToValueAtTime(f, t + 0.03);
    b.frequency.exponentialRampToValueAtTime(f, t + 0.03);
    a.detune.value = -5; b.detune.value = 5;
    const gb = gain(ctx, 0.6);
    a.connect(lp); b.connect(gb); gb.connect(lp);
    if (dur > 0.3) vibrato(ctx, t, end, 5.6, 14, 0.14, [a.detune, b.detune]);
    a.start(t); b.start(t); a.stop(end + 0.1); b.stop(end + 0.1);
  },
  // Marimba: fundamental + the bar's 3.9x / 9.2x partials, low bars ring longer.
  marimba(rig, t, midi, dur, vel, seed) {
    const ctx = rig.ctx, f = mtof(midi), out = rig.bus('marimba');
    const dk = clamp(0.95 - (midi - 55) * 0.014, 0.25, 0.95);
    partials(ctx, out, t, f, 0.13 * vel, [[1, 1, dk], [3.93, 0.2, dk * 0.22], [9.2, 0.05, dk * 0.08]], 0.0015);
    hiss(ctx, out, t, { type: 'bandpass', f0: Math.min(6000, f * 6), Q: 1.2, dur: 0.012, peak: 0.02 * vel, offset: seedOff(seed, 0.0437) });
  },
  // Glockenspiel: bright steel bar partials.
  glock(rig, t, midi, dur, vel) {
    const ctx = rig.ctx, f = mtof(midi);
    partials(ctx, rig.bus('glock'), t, f, 0.055 * vel, [[1, 1, 1.2], [2.756, 0.3, 0.4], [5.404, 0.12, 0.14]], 0.001);
  },
  // Tubular / church bells: hum, prime, minor-third tierce, quint, nominal …
  bells(rig, t, midi, dur, vel) {
    const ctx = rig.ctx, f = mtof(midi);
    partials(ctx, rig.bus('bells'), t, f, 0.05 * vel,
      [[0.5, 0.35, 3.2], [1, 1, 2.6], [1.19, 0.4, 1.8], [1.5, 0.25, 1.4], [2, 0.55, 1.2], [2.52, 0.18, 0.8], [3, 0.12, 0.6]]);
  },
  // Mandolin: doubled course of bright strings; long notes are tremolo-picked.
  mandolin(rig, t, midi, dur, vel, seed, ev, sd) {
    const ctx = rig.ctx, f = mtof(midi), out = rig.bus('mandolin');
    const end = t + Math.max(0.05, dur - 0.01);
    const g = gain(ctx, 0);
    const lp = filter(ctx, 'lowpass', 3600, 1.1);
    const peak = 0.085 * vel;
    if (dur > sd * 1.6) pickEnvelope(g.gain, lp, t, end, sd / 2, peak, 4600, 2300);
    else {
      perc(g.gain, t, peak, 0.002, Math.min(0.5, dur + 0.25));
      lp.frequency.setValueAtTime(4800, t);
      lp.frequency.setTargetAtTime(1900, t + 0.004, 0.05);
    }
    const a = osc(ctx, 'sawtooth', f, t), b = osc(ctx, 'sawtooth', f, t), c = osc(ctx, 'triangle', f, t);
    a.detune.value = -7; b.detune.value = 7;
    const gc = gain(ctx, 0.6);
    a.connect(lp); b.connect(lp); c.connect(gc); gc.connect(lp);
    lp.connect(g); g.connect(out);
    const stop = end + 0.3;
    a.start(t); b.start(t); c.start(t); a.stop(stop); b.stop(stop); c.stop(stop);
  },
  // Musette accordion (three reeds tuned apart) for melodies.
  accordion(rig, t, midi, dur, vel) {
    const ctx = rig.ctx, f = mtof(midi), out = rig.bus('accordion');
    const end = t + Math.max(0.06, dur - 0.01);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.06 * vel, 0.02, 0.1, 0.85, end, 0.06);
    const lp = filter(ctx, 'lowpass', 3200, 0.8), hp = filter(ctx, 'highpass', 220, 0.7);
    lp.connect(hp); hp.connect(g); g.connect(out);
    const reeds = [[0.3, 1, 0], ['sawtooth', 0.5, 14], [0.3, 0.6, -13]];
    for (const [type, lvl, cents] of reeds) {
      const o = osc(ctx, type, f, t);
      o.detune.value = cents;
      const og = gain(ctx, lvl);
      o.connect(og); og.connect(lp);
      o.start(t); o.stop(end + 0.1);
    }
  },
  // Accordion left-hand chord buttons (two reeds a note).
  squeeze(rig, t, midi, dur, vel, seed, ev, sd, tr) {
    const ctx = rig.ctx, out = rig.bus('squeeze');
    const end = t + Math.max(0.05, dur - 0.012);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.03 * vel, 0.012, 0.06, 0.8, end, 0.05);
    const lp = filter(ctx, 'lowpass', 2600, 0.8);
    lp.connect(g); g.connect(out);
    for (const n of chordNotes(ev, tr)) {
      const f = mtof(n);
      const a = osc(ctx, 0.3, f, t), b = osc(ctx, 'sawtooth', f, t);
      b.detune.value = 12;
      const gb = gain(ctx, 0.5);
      a.connect(lp); b.connect(gb); gb.connect(lp);
      a.start(t); b.start(t); a.stop(end + 0.08); b.stop(end + 0.08);
    }
  },
  // FM electric piano (sine carrier + decaying 1:1 modulator), slightly wobbly.
  epiano(rig, t, midi, dur, vel, seed, ev, sd, tr) {
    const ctx = rig.ctx, out = rig.bus('epiano');
    const end = t + Math.max(0.08, dur);
    chordNotes(ev, tr).forEach((n, i) => {
      const f = mtof(n);
      const car = osc(ctx, 'sine', f, t), mod = osc(ctx, 'sine', f, t);
      car.detune.value = (((seed * 7 + i * 5) % 9) - 4) * 1.5;
      const idx = gain(ctx, 0);
      idx.gain.setValueAtTime(f * 1.5 * vel, t);
      idx.gain.setTargetAtTime(f * 0.18, t, 0.22);
      mod.connect(idx); idx.connect(car.frequency);
      const g = gain(ctx, 0);
      adsr(g.gain, t, 0.042 * vel, 0.002, 0.9, 0.4, end, 0.16);
      car.connect(g); g.connect(out);
      car.start(t); mod.start(t); car.stop(end + 0.25); mod.stop(end + 0.25);
    });
  },
  // Clean jangly guitar pluck.
  pluck(rig, t, midi, dur, vel) {
    const ctx = rig.ctx, f = mtof(midi), out = rig.bus('pluck');
    const g = gain(ctx, 0);
    const dk = Math.min(0.9, 0.3 + dur);
    perc(g.gain, t, 0.06 * vel, 0.002, dk);
    const lp = filter(ctx, 'lowpass', 3400, 1.6);
    lp.frequency.setValueAtTime(3400, t);
    lp.frequency.setTargetAtTime(800, t + 0.005, 0.09);
    lp.connect(g); g.connect(out);
    const a = osc(ctx, 'sawtooth', f, t), b = osc(ctx, 'sawtooth', f, t);
    a.detune.value = -6; b.detune.value = 6;
    a.connect(lp); b.connect(lp);
    a.start(t); b.start(t); a.stop(t + dk + 0.05); b.stop(t + dk + 0.05);
  },
  // Breathy whistle / flute lead with a scoop and delayed vibrato.
  whistle(rig, t, midi, dur, vel, seed) {
    const ctx = rig.ctx, f = mtof(midi), out = rig.bus('whistle');
    const end = t + Math.max(0.06, dur - 0.02);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.11 * vel, 0.035, 0.1, 0.85, end, 0.09);
    g.connect(out);
    const s = osc(ctx, 'sine', f * 0.985, t);
    s.frequency.exponentialRampToValueAtTime(f, t + 0.05);
    const h = osc(ctx, 'sine', f * 2, t);
    const gh = gain(ctx, 0.06);
    s.connect(g); h.connect(gh); gh.connect(g);
    const br = noise(ctx, t, end - t + 0.12, 1, seedOff(seed, 0.0523));
    const bp = filter(ctx, 'bandpass', Math.min(9000, f * 2.2), 3);
    const gbr = gain(ctx, 0.012 * vel);
    br.connect(bp); bp.connect(gbr); gbr.connect(g);
    if (dur > 0.3) vibrato(ctx, t, end, 5.2, 16, 0.18, [s.detune, h.detune]);
    s.start(t); h.start(t); s.stop(end + 0.15); h.stop(end + 0.15);
  },
  // Twangy single-coil surf lead: scoop-down twang, presence peak; long notes
  // are tremolo-picked, short ones staccato.
  surf(rig, t, midi, dur, vel, seed, ev, sd) {
    const ctx = rig.ctx, f = mtof(midi), out = rig.bus('surf');
    const end = t + Math.max(0.04, dur - 0.01);
    const g = gain(ctx, 0);
    const lp = filter(ctx, 'lowpass', 5200, 0.9);
    const pk = filter(ctx, 'peaking', 2300, 1.2);
    pk.gain.value = 7;
    const hp = filter(ctx, 'highpass', 170, 0.7);
    const peak = 0.075 * vel;
    if (dur > sd * 1.6) pickEnvelope(g.gain, lp, t, end, sd / 2, peak, 6000, 2600);
    else {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.002);
      g.gain.setTargetAtTime(peak * 0.3, t + 0.002, 0.05);
      g.gain.setTargetAtTime(0, end, 0.015);
      lp.frequency.setValueAtTime(6200, t);
      lp.frequency.setTargetAtTime(2400, t + 0.003, 0.06);
    }
    const a = osc(ctx, 'sawtooth', f * 1.01, t), b = osc(ctx, 0.25, f * 1.01, t);
    a.frequency.exponentialRampToValueAtTime(f, t + 0.03);
    b.frequency.exponentialRampToValueAtTime(f, t + 0.03);
    b.detune.value = 4;
    const gb = gain(ctx, 0.5);
    a.connect(hp); b.connect(gb); gb.connect(hp);
    hp.connect(pk); pk.connect(lp); lp.connect(g); g.connect(out);
    const stop = end + 0.12;
    a.start(t); b.start(t); a.stop(stop); b.stop(stop);
  },
  // Combo organ stabs (bright drawbar organ with vibrato).
  combo(rig, t, midi, dur, vel, seed, ev, sd, tr) {
    const ctx = rig.ctx, out = rig.bus('combo');
    const end = t + Math.max(0.05, dur - 0.015);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.03 * vel, 0.004, 0.05, 0.9, end, 0.03);
    const lp = filter(ctx, 'lowpass', 3800, 0.7);
    lp.connect(g); g.connect(out);
    const dets = [];
    for (const n of chordNotes(ev, tr)) {
      const o = osc(ctx, 'sine', mtof(n), t);
      o.setPeriodicWave(organWave(ctx, 'combo'));
      o.connect(lp);
      o.start(t); o.stop(end + 0.06);
      dets.push(o.detune);
    }
    vibrato(ctx, t, end, 6.4, 10, 0, dets);
  },
  // Pipe organ lead (principal chorus + mixture, celeste pair, chiff).
  pipe(rig, t, midi, dur, vel, seed) {
    const ctx = rig.ctx, f = mtof(midi), out = rig.bus('pipe');
    const end = t + Math.max(0.06, dur - 0.01);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.05 * vel, 0.025, 0.1, 0.95, end, 0.1);
    g.connect(out);
    const a = osc(ctx, 'sine', f, t), b = osc(ctx, 'sine', f, t);
    a.setPeriodicWave(organWave(ctx, 'pipe')); b.setPeriodicWave(organWave(ctx, 'pipe'));
    b.detune.value = 5;
    const gb = gain(ctx, 0.5);
    a.connect(g); b.connect(gb); gb.connect(g);
    a.start(t); b.start(t); a.stop(end + 0.15); b.stop(end + 0.15);
    hiss(ctx, out, t, { type: 'bandpass', f0: Math.min(7000, f * 3), Q: 2, dur: 0.035, peak: 0.012 * vel, offset: seedOff(seed, 0.0383) });
  },
  // Softer flue stop for the organ ostinato.
  flue(rig, t, midi, dur, vel, seed) {
    const ctx = rig.ctx, f = mtof(midi), out = rig.bus('flue');
    const end = t + Math.max(0.04, dur - 0.012);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.042 * vel, 0.01, 0.06, 0.9, end, 0.06);
    g.connect(out);
    const a = osc(ctx, 'sine', f, t);
    a.setPeriodicWave(organWave(ctx, 'flue'));
    a.connect(g);
    a.start(t); a.stop(end + 0.1);
    hiss(ctx, out, t, { type: 'bandpass', f0: Math.min(6000, f * 4), Q: 2.5, dur: 0.02, peak: 0.006 * vel, offset: seedOff(seed, 0.0297) });
  },
  // Organ pedal (16' + 8').
  pedal(rig, t, midi, dur, vel) {
    const ctx = rig.ctx, f = mtof(midi), out = rig.bus('pedal');
    const end = t + Math.max(0.08, dur - 0.02);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.12 * vel, 0.03, 0.1, 0.9, end, 0.12);
    g.connect(out);
    const a = osc(ctx, 'sine', f, t), sub = osc(ctx, 'sine', f / 2, t);
    a.setPeriodicWave(organWave(ctx, 'pedal'));
    const gs = gain(ctx, 0.55);
    a.connect(g); sub.connect(gs); gs.connect(g);
    a.start(t); sub.start(t); a.stop(end + 0.2); sub.stop(end + 0.2);
  },
  // Power chord (root, fifth, octave) into the rig's distortion bus; soft hits are palm-muted.
  power(rig, t, midi, dur, vel, seed, ev, sd, tr) {
    const ctx = rig.ctx, out = rig.bus('power');
    const muted = vel < 0.8;
    const end = t + (muted ? Math.min(dur, sd * 0.9) : Math.max(0.05, dur - 0.01));
    const g = gain(ctx, 0);
    adsr(g.gain, t, muted ? 0.056 : 0.07, 0.002, 0.12, 0.75, end, muted ? 0.02 : 0.06);
    const lp = filter(ctx, 'lowpass', muted ? 700 : 2600, 0.8);
    lp.connect(g); g.connect(out);
    chordNotes(ev, tr).forEach((n, i) => {
      const o = osc(ctx, 'sawtooth', mtof(n), t);
      o.detune.value = i % 2 ? 6 : -6;
      o.connect(lp);
      o.start(t); o.stop(end + 0.1);
    });
  },
  // "Aah" choir: detuned saws through fixed vowel formants, slow swell.
  choir(rig, t, midi, dur, vel, seed, ev, sd, tr) {
    const ctx = rig.ctx, out = rig.bus('choir');
    const end = t + Math.max(0.2, dur);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.5 * vel, 0.22, 0.3, 0.9, end, 0.35);
    g.connect(out);
    const src = gain(ctx, 1);
    for (const [fq, Q, lvl] of [[720, 5, 1], [1150, 6, 0.55], [2650, 8, 0.22]]) {
      const bp = filter(ctx, 'bandpass', fq, Q);
      const gl = gain(ctx, lvl);
      src.connect(bp); bp.connect(gl); gl.connect(g);
    }
    const dets = [];
    for (const n of chordNotes(ev, tr)) {
      for (const c of [-9, 9]) {
        const o = osc(ctx, 'sawtooth', mtof(n), t);
        o.detune.value = c;
        o.connect(src);
        o.start(t); o.stop(end + 0.5);
        dets.push(o.detune);
      }
    }
    vibrato(ctx, t, end + 0.4, 5.1, 11, 0.2, dets);
  },
  // Round sine/triangle bass (lo-fi).
  subbass(rig, t, midi, dur, vel) {
    const ctx = rig.ctx, f = mtof(midi), out = rig.bus('subbass');
    const end = t + Math.max(0.05, dur * 0.92);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.26 * vel, 0.006, 0.12, 0.8, end, 0.05);
    const lp = filter(ctx, 'lowpass', 700, 0.7);
    lp.connect(g); g.connect(out);
    const a = osc(ctx, 'sine', f, t), b = osc(ctx, 'triangle', f, t);
    const gb = gain(ctx, 0.35);
    a.connect(lp); b.connect(gb); gb.connect(lp);
    a.start(t); b.start(t); a.stop(end + 0.08); b.stop(end + 0.08);
  },

  // ---------------------------------------------------- percussion (v5)
  timp(rig, t, midi, dur, vel, seed) {
    const ctx = rig.ctx, f = mtof(midi), out = rig.bus('timp');
    const dk = vel < 0.8 ? 0.5 : 1.3;
    const s = osc(ctx, 'sine', f * 1.06, t);
    s.frequency.exponentialRampToValueAtTime(f, t + 0.12);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.36 * vel, 0.003, dk);
    s.connect(g); g.connect(out);
    s.start(t); s.stop(t + dk + 0.05);
    partials(ctx, out, t, f, 0.36 * vel, [[1.5, 0.35, dk * 0.6], [1.99, 0.18, dk * 0.4]], 0.003);
    hiss(ctx, out, t, { type: 'lowpass', f0: 900, Q: 0.7, dur: 0.03, peak: 0.08 * vel, offset: seedOff(seed, 0.0713) });
  },
  // Tight double-bass-drum kick (short decay, beater click) for 16th-note runs.
  dkick(rig, t, m, d, vel, seed) {
    const ctx = rig.ctx, out = rig.bus('drums');
    const s = osc(ctx, 'sine', 190, t);
    s.frequency.exponentialRampToValueAtTime(58, t + 0.04);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.3 * vel, 0.0015, 0.1);
    s.connect(g); g.connect(out);
    s.start(t); s.stop(t + 0.14);
    hiss(ctx, out, t, { type: 'bandpass', f0: 3500, Q: 1, dur: 0.008, peak: 0.1 * vel, offset: seedOff(seed, 0.0677) });
  },
  tomH(rig, t, m, d, vel, seed) { tom(rig, t, 196, vel, seed, 0.3); },
  tomM(rig, t, m, d, vel, seed) { tom(rig, t, 147, vel, seed, 0.38); },
  tomL(rig, t, m, d, vel, seed) { tom(rig, t, 98, vel, seed, 0.55); },
  tamb(rig, t, m, d, vel, seed) {
    const ctx = rig.ctx, out = rig.bus('perc');
    hiss(ctx, out, t, { type: 'highpass', f0: 6800, Q: 0.8, dur: vel > 0.8 ? 0.14 : 0.07, peak: 0.11 * vel, offset: seedOff(seed, 0.0457) });
    hiss(ctx, out, t, { type: 'bandpass', f0: 9500, Q: 3, dur: 0.1, peak: 0.06 * vel, offset: seedOff(seed, 0.0457) + 0.2 });
  },
  shaker(rig, t, m, d, vel, seed) {
    hiss(rig.ctx, rig.bus('perc'), t, { type: 'bandpass', f0: 6500, Q: 1.2, attack: 0.012, dur: 0.06, peak: 0.06 * vel, offset: seedOff(seed, 0.0389) });
  },
  clap(rig, t, m, d, vel, seed) {
    const ctx = rig.ctx, out = rig.bus('perc'), o = seedOff(seed, 0.0571);
    for (const dt of [0, 0.009, 0.018]) hiss(ctx, out, t + dt, { type: 'bandpass', f0: 1300, Q: 1.3, dur: 0.012, peak: 0.2 * vel, offset: o + dt * 10 });
    hiss(ctx, out, t + 0.027, { type: 'bandpass', f0: 1300, Q: 1, dur: 0.13, peak: 0.15 * vel, offset: (o + 0.4) % 1.9 });
  },
  rim(rig, t, m, d, vel, seed) {
    const ctx = rig.ctx, out = rig.bus('perc');
    blip(ctx, out, t, { type: 'triangle', f0: 1700, f1: 1200, dur: 0.025, peak: 0.12 * vel });
    hiss(ctx, out, t, { type: 'bandpass', f0: 3200, Q: 1.5, dur: 0.02, peak: 0.12 * vel, offset: seedOff(seed, 0.0331) });
  },
  castanet(rig, t, m, d, vel, seed) {
    const ctx = rig.ctx, out = rig.bus('perc'), o = seedOff(seed, 0.0419);
    hiss(ctx, out, t, { type: 'bandpass', f0: 2600, Q: 5, dur: 0.018, peak: 0.22 * vel, offset: o });
    hiss(ctx, out, t + 0.011, { type: 'bandpass', f0: 3100, Q: 5, dur: 0.014, peak: 0.12 * vel, offset: o + 0.3 });
  },
  // Record crackle for a whole bar (quiet hiss + a few deterministic clicks).
  vinyl(rig, t, m, d, vel, seed, ev, sd) {
    const ctx = rig.ctx, out = rig.bus('vinyl');
    const dur = sd * 16;
    const n = noise(ctx, t, dur, 1, seedOff(seed, 0.0157));
    const bp = filter(ctx, 'bandpass', 3000, 0.5);
    const g = gain(ctx, 0.0035 * vel);
    n.connect(bp); bp.connect(g); g.connect(out);
    const rng = makeRng(0x7111 + seed);
    for (let k = 0; k < 6; k++) {
      hiss(ctx, out, t + rng() * dur, { type: 'highpass', f0: 2000, Q: 0.7, dur: 0.003, peak: (0.02 + rng() * 0.04) * vel, offset: rng() * 1.5 });
    }
  },
};
const DRUMS = new Set(['kick', 'dkick', 'snare', 'hat', 'ohat', 'crash', 'tomH', 'tomM', 'tomL', 'tamb', 'shaker', 'clap', 'rim', 'castanet', 'timp', 'vinyl']);

/**
 * Schedule one step of `song` at AudioContext time `t`. Deterministic (noise
 * offsets derive from the step index) so loops render identically every time
 * around. `only` (tests): a Set of instrument names to render, others skipped.
 */
export function scheduleMusicStep(rig, song, step, t, stepDur, intensity = 0, only = null) {
  const events = song.steps[step];
  if (!events || !events.length) return;
  const tt = t + (step % 2 === 1 ? song.swing * stepDur : 0);
  const tr = intensity >= 1 ? song.finalTranspose || 0 : 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.layer === 1 && intensity < 1) continue;
    if (ev.layer === 2 && intensity >= 1) continue;
    if (only && !only.has(ev.inst)) continue;
    INSTRUMENTS[ev.inst](rig, tt, ev.midi ? ev.midi + tr : 0, ev.len * stepDur, ev.vel, step, ev, stepDur, tr);
  }
}

// ============================================================ engine loops

// Gear model: speed ratio thresholds where each of 5 gears begins.
const GEARS = [0, 0.17, 0.37, 0.59, 0.83];

/** Continuous player engine + drift screech + off-road rumble + boost jet. */
export class EngineLoops {
  constructor(ctx, destination) {
    this.ctx = ctx;
    const t = ctx.currentTime;
    this.out = gain(ctx, 1);
    this.out.connect(destination);
    this._last = Object.create(null);
    this.rpm = 0.2;
    this.gear = 0;
    this.refSpeed = KART.topSpeedBase + 3 * KART.topSpeedPerStar;
    this.screechPhase = 0;
    this.nodes = [];

    // engine: sawtooth + detuned square sub → AM "firing" chop → resonant lowpass
    this.engGain = gain(ctx, 0);
    this.engLP = filter(ctx, 'lowpass', 600, 2.6);
    this.engAM = gain(ctx, 0.75);
    this.oA = osc(ctx, 'sawtooth', 45, t);
    this.oB = osc(ctx, 'square', 22.6, t);
    const gA = gain(ctx, 0.6), gB = gain(ctx, 0.32);
    this.oA.connect(gA); this.oB.connect(gB);
    gA.connect(this.engAM); gB.connect(this.engAM);
    this.engAM.connect(this.engLP); this.engLP.connect(this.engGain); this.engGain.connect(this.out);
    this.wobble = osc(ctx, 'sine', 5.5, t);
    this.wobDepth = gain(ctx, 2.5);
    this.wobble.connect(this.wobDepth);
    this.wobDepth.connect(this.oA.frequency);
    this.wobDepth.connect(this.oB.frequency);
    this.fire = osc(ctx, 'triangle', 22, t);
    this.fireDepth = gain(ctx, 0.25);
    this.fire.connect(this.fireDepth); this.fireDepth.connect(this.engAM.gain);

    // drift screech: two resonant bands of noise
    this.drGain = gain(ctx, 0);
    this.drN = noise(ctx, t, 1e6, 1, 0.3);
    this.drBp1 = filter(ctx, 'bandpass', 2100, 7);
    this.drBp2 = filter(ctx, 'bandpass', 3300, 9);
    const d2 = gain(ctx, 0.6);
    this.drN.connect(this.drBp1); this.drN.connect(this.drBp2);
    this.drBp1.connect(this.drGain); this.drBp2.connect(d2); d2.connect(this.drGain);
    this.drGain.connect(this.out);

    // off-road rumble: low noise with a bumpy amplitude LFO
    this.orGain = gain(ctx, 0);
    this.orN = noise(ctx, t, 1e6, 0.7, 0.9);
    this.orLP = filter(ctx, 'lowpass', 260, 1.2);
    this.orAM = gain(ctx, 0.6);
    this.orLfo = osc(ctx, 'triangle', 13, t);
    const orD = gain(ctx, 0.4);
    this.orLfo.connect(orD); orD.connect(this.orAM.gain);
    this.orN.connect(this.orLP); this.orLP.connect(this.orAM); this.orAM.connect(this.orGain);
    // a little gravel crackle on top
    this.orHi = filter(ctx, 'bandpass', 1800, 1.5);
    const orHiG = gain(ctx, 0.25);
    this.orN.connect(this.orHi); this.orHi.connect(orHiG); orHiG.connect(this.orAM);
    this.orGain.connect(this.out);

    // boost jet: bright band of noise
    this.bGain = gain(ctx, 0);
    this.bN = noise(ctx, t, 1e6, 1, 1.4);
    this.bBp = filter(ctx, 'bandpass', 1100, 0.9);
    this.bN.connect(this.bBp); this.bBp.connect(this.bGain); this.bGain.connect(this.out);

    for (const n of [this.oA, this.oB, this.wobble, this.fire, this.orLfo]) n.start(t);
    this.sources = [this.oA, this.oB, this.wobble, this.fire, this.orLfo, this.drN, this.orN, this.bN];
  }

  // setTargetAtTime only when the target moved meaningfully (keeps automation lists short).
  _to(key, param, v, tc) {
    const last = this._last[key];
    if (last !== undefined && Math.abs(last - v) <= Math.abs(v) * 0.005 + 1e-4) return;
    this._last[key] = v;
    param.setTargetAtTime(v, this.ctx.currentTime, tc);
  }

  update(dt, s, active) {
    dt = clamp(dt || 0, 0, 0.1);
    const speed = Math.abs(s.speed || 0);
    const throttle = clamp(s.throttle || 0, 0, 1);
    const grounded = s.grounded !== false;
    const boosting = !!s.boosting;
    if (!boosting && s.maxSpeed > 1) this.refSpeed = s.maxSpeed;
    const ratio = clamp(speed / Math.max(this.refSpeed, 1), 0, 1.3);

    // gear selection with hysteresis
    let g = this.gear;
    while (g < GEARS.length - 1 && ratio > GEARS[g + 1] + 0.01) g++;
    while (g > 0 && ratio < GEARS[g] - 0.04) g--;
    this.gear = g;
    const lo = GEARS[g], hi = g < GEARS.length - 1 ? GEARS[g + 1] : 1.12;
    const frac = clamp((ratio - lo) / (hi - lo), 0, 1.15);
    let rpmT = g === 0 ? 0.18 + 0.82 * frac : 0.46 + 0.54 * frac;
    if (ratio < 0.12 && throttle > 0) rpmT = Math.max(rpmT, 0.3 + 0.62 * throttle);   // revving on the grid
    if (!grounded) rpmT = Math.min(1.15, rpmT + 0.12 * throttle);                       // free-revving in the air
    if (throttle <= 0.05) rpmT *= 0.86;
    this.rpm = damp(this.rpm, rpmT, rpmT < this.rpm ? 14 : 6, dt);
    const rpm = this.rpm;

    const on = active ? 1 : 0;
    let freq = 52 + rpm * 108 + g * 8;          // ~60 Hz idle → ~175 Hz flat out (buzzy kart engine)
    if (boosting) freq *= 1.1;
    const tc = 0.03;
    this._to('fA', this.oA.frequency, freq, tc);
    this._to('fB', this.oB.frequency, freq * 0.502, tc);
    this._to('fire', this.fire.frequency, freq * 0.5, tc);
    this._to('wob', this.wobDepth.gain, rpm < 0.3 ? 2.6 : 0.7, 0.2);
    this._to('lp', this.engLP.frequency, 320 + rpm * 1400 + throttle * 700 + (boosting ? 800 : 0), 0.05);
    this._to('eg', this.engGain.gain, on * (0.1 + throttle * 0.06 + rpm * 0.05), 0.06);

    // drift screech (only while drifting on the ground at speed)
    const screech = on && s.drifting && grounded && speed > 5 ? 0.09 : 0;
    this._to('dg', this.drGain.gain, screech, screech ? 0.04 : 0.07);
    if (screech) {
      this.screechPhase += dt * (8 + Math.random() * 3);
      const wob = Math.sin(this.screechPhase);
      this._to('d1', this.drBp1.frequency, 1950 + wob * 260 + speed * 6, 0.05);
      this._to('d2', this.drBp2.frequency, 3150 - wob * 300 + speed * 8, 0.05);
    }

    // off-road rumble
    const rumble = on && s.offroad && grounded && speed > 1.5 ? 0.3 * clamp(speed / 14, 0.35, 1) : 0;
    this._to('og', this.orGain.gain, rumble, 0.06);
    if (rumble) this._to('of', this.orLfo.frequency, 8 + speed * 0.4, 0.1);

    // boost jet
    this._to('bg', this.bGain.gain, on && boosting ? 0.07 : 0, boosting ? 0.03 : 0.15);
  }

  silence() {
    const now = this.ctx.currentTime;
    for (const g of [this.engGain, this.drGain, this.orGain, this.bGain]) g.gain.setTargetAtTime(0, now, 0.06);
    this._last = Object.create(null);
  }

  dispose() {
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } }
    try { this.out.disconnect(); } catch { /* gone */ }
  }
}

// ============================================================ AudioEngine

const LOOKAHEAD = 0.25;        // seconds of music scheduled ahead of the clock
const TICK_MS = 25;            // sequencer wake-up interval
const MAX_VOICES = 40;         // concurrent one-shot voices
const MIN_REPEAT = 0.03;       // seconds before the same sound may retrigger ...
const REPEAT_LOUDER = 1.5;     // ... unless the new call is this much louder (a distant rival's
                               //     quiet 'spin' must not swallow the player's own in the same zap)
const DUCKERS = { finalLap: 1.8, jingleStart: 1.6 };   // sounds that duck the music (s)
const STORE_KEY = 'tootkart.audio';

// Recorded soundtrack songs, streamed with an <audio> element routed into the
// music bus (so mute / volume / ducking apply). Streaming avoids decoding a
// multi-minute song into ~100 MB of PCM. `gain` levels the master against the
// generated songs (measured gated RMS: song 0.111 vs race theme 0.125);
// `finalLapRate` speeds the song up on the final lap without changing pitch.
export const FILE_SONGS = {
  claude: { url: 'audio/claudesong.m4a', label: 'Claude Song', gain: 0.95, finalLapRate: 1.06 },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.chain = null;
    this.muted = false;
    this.volume = 0.8;
    this._loadPrefs();
    this._engines = [];           // per channel: { loops: EngineLoops, panner, level, pan, gain }
    this._engineActive = true;
    this._music = null;           // { kind, song, rig, gain, step, nextTime, intensity, pending }
                                  // or, for FILE_SONGS: { kind, file, el, gain, token, intensity }
    this._fileSongs = new Map();  // kind -> { el, src } (one element + source node per song, reused)
    this._musicWanted = null;
    this._intensity = 0;
    this._timer = null;
    this._warmTimer = null;
    this._lastPlay = new Map();   // name -> { t, v }: time + volume of its last trigger
    this._voices = 0;
    this._warned = new Set();
    this._visSuspended = false;
    this._onVis = () => this._handleVisibility();
    this._onState = () => { if (this.ready) this._resumeWanted(); };
    this.stepLog = null;          // tests: set to [] to record (step, time, scheduledAt) triples
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  // ------------------------------------------------------------ lifecycle

  /** Create/resume the AudioContext. Call from a user gesture; idempotent. */
  unlock() {
    if (typeof window === 'undefined') return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.chain = buildMasterChain(this.ctx, { volume: this._masterLevel() });
        this.chain.output.connect(this.ctx.destination);
        // iOS: a silent buffer started inside the gesture fully unlocks output
        const b = this.ctx.createBufferSource();
        b.buffer = this.ctx.createBuffer(1, 1, 22050);
        b.connect(this.ctx.destination);
        b.start(0);
        this.ctx.addEventListener('statechange', this._onState);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVis);
        this._timer = setInterval(() => this._tick(), TICK_MS);
        this._prepareFileSongs();
        this._warmTimer = setTimeout(() => this._warmMusic(), 400);
      }
      if (this.ctx.state === 'suspended' && !this._visSuspended) {
        this.ctx.resume().then(() => this._resumeWanted()).catch(() => { /* needs a later gesture */ });
      } else if (this.ready) {
        this._resumeWanted();
      }
    } catch (err) {
      console.warn('[audio] unlock failed', err);
    }
  }

  dispose() {
    if (this._timer) clearInterval(this._timer);
    if (this._warmTimer) clearTimeout(this._warmTimer);
    this._timer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVis);
    this.setEngineChannels(0);
    this._music = null;
    for (const f of this._fileSongs.values()) { try { f.el.pause(); f.el.removeAttribute('src'); f.el.load(); } catch { /* gone */ } }
    this._fileSongs.clear();
    if (this.ctx) {
      this.ctx.removeEventListener('statechange', this._onState);
      this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.chain = null;
  }

  _handleVisibility() {
    if (!this.ctx) return;
    // A streamed song keeps advancing on its own clock: pause it with the tab.
    const m = this._music;
    if (m && m.file) {
      if (document.hidden) m.el.pause();
      else m.el.play().catch(() => { /* resumes on the next gesture */ });
    }
    if (document.hidden) {
      if (this.ctx.state === 'running') {
        this._visSuspended = true;
        this.ctx.suspend().catch(() => {});
      }
    } else if (this._visSuspended) {
      this._visSuspended = false;
      this.ctx.resume().catch(() => {});
    }
  }

  _resumeWanted() {
    if (this._musicWanted && (!this._music || this._music.kind !== this._musicWanted)) {
      const kind = this._musicWanted;
      const intensity = this._intensity;
      this.startMusic(kind);
      if (intensity) this.setMusicIntensity(intensity);
    }
  }

  // ------------------------------------------------------------ volume

  _loadPrefs() {
    try {
      const raw = typeof localStorage !== 'undefined' && localStorage.getItem(STORE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.muted === 'boolean') this.muted = p.muted;
        if (Number.isFinite(p.volume)) this.volume = clamp(p.volume, 0, 1);
      }
    } catch { /* storage unavailable */ }
  }

  _savePrefs() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify({ muted: this.muted, volume: this.volume }));
    } catch { /* storage unavailable */ }
  }

  _masterLevel() { return this.muted ? 0 : this.volume; }

  _applyMaster() {
    if (!this.chain) return;
    const g = this.chain.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(this._masterLevel(), now, 0.04);
  }

  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  setMuted(b) {
    this.muted = !!b;
    this._applyMaster();
    this._savePrefs();
  }

  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    this._applyMaster();
    this._savePrefs();
  }

  // ------------------------------------------------------------ one-shots

  /** Play a named one-shot. No-op before unlock. */
  play(name, { volume = 1, pitch = 1, pan = 0 } = {}) {
    if (!this.ready) return;
    const fn = SOUNDS[name];
    if (!fn) {
      if (!this._warned.has(name)) { this._warned.add(name); console.warn(`[audio] unknown sound "${name}"`); }
      return;
    }
    if (!(volume > 0.001) || this._voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    let last = this._lastPlay.get(name);
    if (last && now - last.t < MIN_REPEAT && !(volume > last.v * REPEAT_LOUDER)) return;
    if (!last) this._lastPlay.set(name, (last = { t: 0, v: 0 }));
    last.t = now;
    last.v = volume;

    const v = gain(ctx, clamp(volume, 0, 2));
    let panner = null;
    if (pan && ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      v.connect(panner);
      panner.connect(this.chain.sfx);
    } else {
      v.connect(this.chain.sfx);
    }
    let dur = 0.5;
    try {
      dur = fn(ctx, v, { when: now + 0.005, pitch: clamp(pitch || 1, 0.25, 4) }) || 0.5;
    } catch (err) {
      console.error(`[audio] sound "${name}" failed`, err);
    }
    if (DUCKERS[name]) this._duck(DUCKERS[name]);
    this._voices++;
    setTimeout(() => {
      this._voices--;
      try { v.disconnect(); if (panner) panner.disconnect(); } catch { /* gone */ }
    }, (dur + 0.4) * 1000);
  }

  /** 'finish' | 'lose' end the race music; 'start' plays over a ducked mix. */
  playJingle(name) {
    if (!this.ready) return;
    if (name === 'finish' || name === 'lose') {
      this.stopMusic(0.35);
      this.play(name);
    } else if (name === 'start') {
      this.play('jingleStart');
    } else if (SOUNDS[name]) {
      this.play(name);
    }
  }

  _duck(seconds) {
    if (!this.chain) return;
    const g = this.chain.music.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(MUSIC_LEVEL * 0.3, now, 0.05);
    g.setTargetAtTime(MUSIC_LEVEL, now + seconds, 0.35);
  }

  // ------------------------------------------------------------ engine loops

  /**
   * Continuous engine / drift / off-road / boost loops of one kart. `channel`
   * = split-screen view index (one loop set each), `pan` -1..1 toward that
   * view's side of the screen, `level` its share of the mix.
   */
  updateEngine(dt, state = {}, channel = 0, pan = 0, level = 1) {
    if (!this.ready) return;
    let ch = this._engines[channel];
    if (!ch) {
      const ctx = this.ctx;
      const g = gain(ctx, level);
      let panner = null;
      if (ctx.createStereoPanner) {
        panner = ctx.createStereoPanner();
        panner.pan.value = clamp(pan, -1, 1);
        g.connect(panner);
        panner.connect(this.chain.sfx);
      } else {
        g.connect(this.chain.sfx);
      }
      ch = this._engines[channel] = { loops: new EngineLoops(ctx, g), gain: g, panner, pan, level };
    }
    if (ch.pan !== pan && ch.panner) { ch.pan = pan; ch.panner.pan.setTargetAtTime(clamp(pan, -1, 1), this.ctx.currentTime, 0.05); }
    if (ch.level !== level) { ch.level = level; ch.gain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.05); }
    ch.loops.update(dt, state, this._engineActive && state.active !== false);
  }

  /** Keep engine channels 0..n-1; the others stop (split-screen layout shrank, race over). */
  setEngineChannels(n) {
    for (let i = this._engines.length - 1; i >= Math.max(0, n); i--) {
      const ch = this._engines[i];
      if (ch) {
        ch.loops.dispose();
        try { ch.gain.disconnect(); if (ch.panner) ch.panner.disconnect(); } catch { /* gone */ }
      }
      this._engines.length = i;
    }
  }

  setEngineActive(b) {
    this._engineActive = !!b;
    if (!b) for (const ch of this._engines) if (ch) ch.loops.silence();
  }

  // ------------------------------------------------------------ music

  /** Start (or crossfade to) a music loop. Resets intensity to 0. Remembered until unlock. */
  startMusic(kind) {
    this._musicWanted = kind;
    if (!this.ready) return;
    if (this._music && this._music.kind === kind) return;
    if (FILE_SONGS[kind]) { this._startFileSong(kind); return; }
    const song = getSong(kind);
    if (!song) { console.warn(`[audio] unknown music "${kind}"`); return; }
    this._fadeOutMusic(0.6);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1, now + 0.4);
    g.connect(this.chain.music);
    const rig = createMusicRig(ctx, g, song);
    rig.setTempo(songStepDuration(song, 0), now);
    this._intensity = 0;
    this._music = { kind, song, rig, gain: g, step: 0, nextTime: now + 0.06, intensity: 0, pending: 0 };
    this._tick();
  }

  /** 0 = normal, 1 = final lap (faster tempo + extra layers, some songs change key). Applied on the next beat (next bar line for a key change). */
  setMusicIntensity(level) {
    this._intensity = level >= 1 ? 1 : 0;
    const m = this._music;
    if (!m) return;
    if (m.file) {
      m.intensity = this._intensity;
      m.el.playbackRate = m.intensity ? FILE_SONGS[m.kind].finalLapRate : 1;
    } else {
      m.pending = this._intensity;
    }
  }

  stopMusic(fade = 0.6) {
    this._musicWanted = null;
    this._fadeOutMusic(fade);
  }

  _fadeOutMusic(fade) {
    const m = this._music;
    if (!m) return;
    this._music = null;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const g = m.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + Math.max(0.02, fade));
    if (m.file) {
      // Pause after the fade unless the same song was restarted meanwhile.
      setTimeout(() => {
        const f = this._fileSongs.get(m.kind);
        if (f && f.token === m.token) f.el.pause();
        try { m.gain.disconnect(); } catch { /* gone */ }
      }, (fade + 0.1) * 1000);
      return;
    }
    setTimeout(() => m.rig.dispose(), (fade + LOOKAHEAD + 0.6) * 1000);
  }

  // Compile every song and build the reverb impulse responses off the critical
  // path (a spring/hall IR takes a few ms; race music starts exactly on GO).
  _warmMusic() {
    this._warmTimer = null;
    if (!this.ctx) return;
    try {
      for (const kind of SONG_KINDS) {
        const song = getSong(kind);
        if (song.fx && song.fx.verb) impulseResponse(this.ctx, song.fx.verb.type || 'room');
      }
      driveCurve(this.ctx);
    } catch (err) {
      console.warn('[audio] music warm-up failed', err);
    }
  }

  // Create the <audio> elements early (after unlock) so songs are buffered by race start.
  _prepareFileSongs() {
    if (typeof Audio === 'undefined' || !this.ctx || !this.chain) return;
    for (const kind of Object.keys(FILE_SONGS)) this._fileSong(kind);
  }

  _fileSong(kind) {
    let f = this._fileSongs.get(kind);
    if (f) return f;
    const el = new Audio();
    el.preload = 'auto';
    el.loop = true;
    el.preservesPitch = true;   // final-lap speed-up keeps the pitch
    el.src = FILE_SONGS[kind].url;
    let src = null;
    try {
      src = this.ctx.createMediaElementSource(el);
    } catch (err) {
      console.warn(`[audio] cannot route song "${kind}" through WebAudio`, err);
    }
    f = { el, src, token: 0 };
    this._fileSongs.set(kind, f);
    return f;
  }

  _startFileSong(kind) {
    const cfg = FILE_SONGS[kind];
    const f = this._fileSong(kind);
    if (!f.src) { console.warn(`[audio] song "${kind}" unavailable`); return; }
    this._fadeOutMusic(0.6);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(cfg.gain, now + 0.4);
    try { f.src.disconnect(); } catch { /* not connected yet */ }
    f.src.connect(g);
    g.connect(this.chain.music);
    f.token++;
    f.el.playbackRate = 1;
    try { f.el.currentTime = 0; } catch { /* not seekable yet: starts from 0 anyway */ }
    this._intensity = 0;
    const m = { kind, file: true, el: f.el, gain: g, token: f.token, intensity: 0 };
    this._music = m;
    f.el.play().catch((err) => {
      // Autoplay/decoding failure: fall back to a generated race theme.
      console.warn(`[audio] song "${kind}" failed to play`, err && err.message);
      if (this._music === m) { this._music = null; this.startMusic('race'); }
    });
  }

  // Lookahead sequencer: schedule every step whose time falls before now + LOOKAHEAD.
  _tick() {
    const m = this._music;
    if (!m || m.file || !this.ready) return;
    const now = this.ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    while (m.nextTime < horizon) {
      // intensity switches on a beat (on a bar line when the final lap changes key)
      const every = m.song.finalTranspose ? m.song.stepsPerBar : m.song.stepsPerBeat;
      if (m.step % every === 0 && m.pending !== m.intensity) {
        m.intensity = m.pending;
        m.rig.setTempo(songStepDuration(m.song, m.intensity), m.nextTime);
      }
      const stepDur = songStepDuration(m.song, m.intensity);
      // If we fell far behind (long stall), skip late steps rather than bursting them.
      if (m.nextTime >= now - 0.03) {
        scheduleMusicStep(m.rig, m.song, m.step, m.nextTime, stepDur, m.intensity);
        if (this.stepLog) this.stepLog.push(m.step, m.nextTime, now);
      }
      m.nextTime += stepDur;
      m.step = (m.step + 1) % m.song.totalSteps;
    }
  }
}
