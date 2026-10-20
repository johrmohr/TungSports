// Procedural sound for the TV: everything is synthesized with Web Audio (no
// audio files), plus an optional announcer through the browser's speech
// synthesis. Browsers only start audio after a user gesture: call
// audio.unlock() from the first click / key press.
//
//   audio.ui('blip' | 'hover' | 'select' | 'back' | 'start' | 'join' | 'leave' | 'turn' | 'cheer')
//   audio.crowd('cheer' | 'big' | 'clap' | 'groan' | 'gasp' | 'ooh' | 'murmur')
//   audio.racket(power01, kind) · audio.bounce(speed) · audio.net() · audio.whoosh(speed01)
//   audio.club(kind, power01) · audio.land(surface, speed) · audio.cup() · audio.splash() · audio.leaves()
//   audio.ambience('menu' | 'tennis' | 'golf' | null, { wind })
//   audio.music('menu' | 'tennis' | 'golf' | 'results' | null)
//   audio.say('Nice shot!')

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.voice = true;
    this._noise = null;
    this._musicTimer = null;
    this._musicName = null;
    this._wantMusic = null;
    this._amb = null;
    this._wantAmb = null;
    this._lastHover = 0;
    this._speechVoice = null;
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.85;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(this.ctx.destination);
    this.verb = this.ctx.createConvolver();
    this.verb.buffer = this._impulse(2.2, 2.8);
    this.verbSend = this.ctx.createGain();
    this.verbSend.gain.value = 0.16;
    this.verbSend.connect(this.verb).connect(this.master);
    this.sfx = this.ctx.createGain();
    this.sfx.connect(this.master);
    this.sfx.connect(this.verbSend);
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.15;
    this.musicBus.connect(this.master);
    this.ambBus = this.ctx.createGain();
    this.ambBus.gain.value = 0.5;
    this.ambBus.connect(this.master);
    this._noise = this._noiseBuffer(2);
    if (this._wantMusic) this.music(this._wantMusic);
    if (this._wantAmb) this.ambience(this._wantAmb.kind, this._wantAmb.opts);
    this._pickVoice();
  }

  get unlocked() { return !!this.ctx && this.ctx.state === 'running'; }
  get t() { return this.ctx ? this.ctx.currentTime : 0; }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.05);
    if (m) try { speechSynthesis.cancel(); } catch { /* none */ }
  }

  _noiseBuffer(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  _noiseSrc() {
    const s = this.ctx.createBufferSource();
    s.buffer = this._noise;
    s.loop = true;
    s.loopStart = Math.random();
    return s;
  }

  // One enveloped oscillator.
  _tone(t, f, dur, { type = 'sine', vol = 0.2, to = null, attack = 0.005, out = null } = {}) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out || this.sfx);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // Filtered noise burst.
  _burst(t, dur, { type = 'bandpass', f = 1000, q = 1, vol = 0.3, to = null, attack = 0.002, out = null } = {}) {
    const n = this._noiseSrc();
    const bp = this.ctx.createBiquadFilter();
    bp.type = type;
    bp.frequency.setValueAtTime(f, t);
    if (to) bp.frequency.exponentialRampToValueAtTime(to, t + dur);
    bp.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(bp).connect(g).connect(out || this.sfx);
    n.start(t);
    n.stop(t + dur + 0.05);
  }

  // ---------------------------------------------------------------- UI

  ui(kind) {
    if (!this.ctx) return;
    const t = this.t;
    if (kind === 'hover') {
      if (performance.now() - this._lastHover < 60) return;
      this._lastHover = performance.now();
      this._tone(t, 1320, 0.05, { type: 'sine', vol: 0.06 });
      return;
    }
    const seqs = {
      blip: [[880, 0.06]],
      select: [[784, 0.06], [1175, 0.1]],
      back: [[660, 0.06], [494, 0.1]],
      turn: [[523, 0.08], [659, 0.08], [784, 0.14]],
      start: [[523, 0.09], [659, 0.09], [784, 0.09], [1047, 0.22]],
      join: [[784, 0.07], [1175, 0.12]],
      leave: [[440, 0.08], [330, 0.14]],
      cheer: [[1047, 0.07], [1319, 0.07], [1568, 0.16]],
      error: [[220, 0.12], [196, 0.18]],
    };
    const seq = seqs[kind];
    if (!seq) return;
    let tt = t;
    for (const [f, d] of seq) {
      this._tone(tt, f, d, { type: 'triangle', vol: 0.16 });
      this._tone(tt, f * 2, d * 0.8, { type: 'sine', vol: 0.03 });
      tt += d * 0.85;
    }
  }

  // ---------------------------------------------------------------- crowd

  crowd(kind, power = 1) {
    if (!this.ctx) return;
    switch (kind) {
      case 'big': this._cheer(1.0 * power, 3.2); this._clap(3.0, 1.0 * power); break;
      case 'cheer': this._cheer(0.7 * power, 2.2); this._clap(2.0, 0.7 * power); break;
      case 'clap': this._clap(1.6, 0.55 * power); break;
      case 'groan': this._groan(); break;
      case 'gasp': this._gasp(); break;
      case 'ooh': this._ooh(power); break;
      case 'murmur': this._murmur(); break;
      default: break;
    }
  }

  _cheer(power, dur) {
    const ctx = this.ctx;
    const t = this.t;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.5 * power, t + 0.25);
    out.gain.setTargetAtTime(0.35 * power, t + 0.6, 0.4);
    out.gain.setTargetAtTime(0.0001, t + dur * 0.6, dur * 0.25);
    out.connect(this.sfx);
    for (const [f, q, lvl] of [[620, 3, 1], [1150, 4, 0.7], [2600, 5, 0.35], [380, 2, 0.6]]) {
      const n = this._noiseSrc();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(f * 0.85, t);
      bp.frequency.linearRampToValueAtTime(f * 1.08, t + 0.5);
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = lvl;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 6 + Math.random() * 5;
      const lfoG = ctx.createGain();
      lfoG.gain.value = lvl * 0.35;
      lfo.connect(lfoG).connect(g.gain);
      n.connect(bp).connect(g).connect(out);
      n.start(t);
      lfo.start(t);
      n.stop(t + dur + 0.5);
      lfo.stop(t + dur + 0.5);
    }
    if (power > 0.9) {
      for (let k = 0; k < 2; k++) {
        const t0 = t + 0.3 + k * 0.5;
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(1900, t0);
        o.frequency.linearRampToValueAtTime(2900, t0 + 0.18);
        o.frequency.linearRampToValueAtTime(2300, t0 + 0.45);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
        o.connect(g).connect(this.sfx);
        o.start(t0);
        o.stop(t0 + 0.55);
      }
    }
  }

  _clap(dur, density) {
    const t0 = this.t;
    const claps = Math.floor(44 * dur * density);
    for (let i = 0; i < claps; i++) {
      const t = t0 + Math.random() * dur * (0.4 + 0.6 * Math.random());
      const fade = 1 - (t - t0) / dur;
      this._burst(t, 0.035, { f: 900 + Math.random() * 1500, q: 1.4, vol: 0.17 * Math.max(0.1, fade) });
    }
  }

  _groan() {
    const ctx = this.ctx;
    const t = this.t;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.3, t + 0.2);
    out.gain.setTargetAtTime(0.0001, t + 0.7, 0.3);
    out.connect(this.sfx);
    for (let v = 0; v < 6; v++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = 150 + v * 23 + Math.random() * 10;
      o.frequency.setValueAtTime(f0 * 1.15, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.8, t + 1.3);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(800, t);
      f.frequency.exponentialRampToValueAtTime(500, t + 1.2);
      f.Q.value = 5;
      const g = ctx.createGain();
      g.gain.value = 0.18;
      o.connect(f).connect(g).connect(out);
      o.start(t);
      o.stop(t + 1.8);
    }
  }

  _gasp() {
    const t = this.t;
    this._burst(t, 0.6, { f: 900, to: 1700, q: 2, vol: 0.3, attack: 0.08 });
  }

  // "Oooh!" — a rising then falling vowel from many voices (near misses, close shots).
  _ooh(power = 1) {
    const ctx = this.ctx;
    const t = this.t;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.28 * power, t + 0.25);
    out.gain.setTargetAtTime(0.0001, t + 0.8, 0.25);
    out.connect(this.sfx);
    for (let v = 0; v < 8; v++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = 170 + v * 31 + Math.random() * 14;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.linearRampToValueAtTime(f0 * 1.35, t + 0.45);
      o.frequency.linearRampToValueAtTime(f0 * 1.1, t + 1.2);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 420;
      f.Q.value = 4;
      const g = ctx.createGain();
      g.gain.value = 0.12;
      o.connect(f).connect(g).connect(out);
      o.start(t + Math.random() * 0.05);
      o.stop(t + 1.4);
    }
  }

  _murmur() {
    const t = this.t;
    this._burst(t, 1.4, { f: 500, q: 1.5, vol: 0.08, attack: 0.3 });
  }

  // ---------------------------------------------------------------- tennis

  // A racket strike: a hollow "pock" with a string ping.
  racket(power = 0.6, kind = 'drive') {
    if (!this.ctx) return;
    const t = this.t;
    const p = clamp(power, 0, 1.4);
    const base = kind === 'serve' || kind === 'smash' ? 760 : kind === 'volley' ? 900 : 820;
    this._tone(t, base * (0.9 + p * 0.25), 0.06, { type: 'triangle', vol: 0.35 + p * 0.2, to: base * 0.6 });
    this._tone(t, base * 2.7, 0.035, { type: 'sine', vol: 0.12 });
    this._burst(t, 0.04, { f: 2800, q: 0.9, vol: 0.45 + p * 0.25 });
    this._tone(t, 2100 + Math.random() * 300, 0.12, { type: 'sine', vol: 0.03 });
    if (p > 0.95) this._burst(t + 0.01, 0.12, { type: 'highpass', f: 3000, q: 0.5, vol: 0.12 });
  }

  bounce(speed = 10) {
    if (!this.ctx) return;
    const t = this.t;
    const k = clamp(speed / 25, 0.15, 1);
    this._tone(t, 260 + k * 120, 0.07, { type: 'sine', vol: 0.3 * k, to: 140 });
    this._burst(t, 0.03, { f: 1500, q: 0.8, vol: 0.25 * k });
  }

  net() {
    if (!this.ctx) return;
    const t = this.t;
    this._burst(t, 0.25, { type: 'lowpass', f: 900, q: 0.6, vol: 0.35 });
    this._tone(t, 120, 0.15, { type: 'sine', vol: 0.15, to: 80 });
  }

  whoosh(speed = 0.6) {
    if (!this.ctx) return;
    const t = this.t;
    const k = clamp(speed, 0.1, 1.3);
    this._burst(t, 0.22 + k * 0.08, { f: 600 + k * 700, to: 2200 + k * 900, q: 1.2, vol: 0.09 + k * 0.13, attack: 0.05 });
  }

  // A fastball's rising hiss.
  fastball() {
    if (!this.ctx) return;
    const t = this.t;
    this._burst(t, 0.5, { type: 'highpass', f: 2500, to: 6000, q: 0.7, vol: 0.18, attack: 0.03 });
    this._tone(t, 1400, 0.4, { type: 'sine', vol: 0.05, to: 2600 });
  }

  // Line judge / umpire "Out!" stand-in when speech is off: a sharp double tone.
  outCall() {
    if (!this.ctx) return;
    const t = this.t;
    this._tone(t, 988, 0.12, { type: 'square', vol: 0.06 });
    this._tone(t + 0.13, 784, 0.18, { type: 'square', vol: 0.06 });
  }

  // ---------------------------------------------------------------- golf

  // kind: 'driver' | 'iron' | 'wedge' | 'putter' | 'sand' | 'rough'
  club(kind = 'driver', power = 0.8) {
    if (!this.ctx) return;
    const t = this.t;
    const p = clamp(power, 0.05, 1.3);
    if (kind === 'putter') {
      this._tone(t, 1200, 0.05, { type: 'sine', vol: 0.12 + p * 0.25, to: 900 });
      this._burst(t, 0.02, { f: 3500, q: 1, vol: 0.12 + p * 0.2 });
      return;
    }
    if (kind === 'sand') {
      this._burst(t, 0.35, { type: 'lowpass', f: 1800, to: 500, q: 0.5, vol: 0.4 });
      return;
    }
    if (kind === 'driver') {
      // Titanium "ping".
      this._tone(t, 1850, 0.25, { type: 'sine', vol: 0.18 * p, to: 1700 });
      this._tone(t, 3300, 0.12, { type: 'sine', vol: 0.07 * p });
      this._burst(t, 0.03, { f: 4200, q: 0.7, vol: 0.5 * p });
      this._tone(t, 180, 0.08, { type: 'sine', vol: 0.25 * p, to: 90 });
    } else {
      // Iron / wedge: a crisp click with turf.
      this._burst(t, 0.025, { f: 5200, q: 0.9, vol: 0.55 * p });
      this._tone(t, 2400, 0.05, { type: 'triangle', vol: 0.1 * p });
      this._burst(t + 0.01, 0.12, { type: 'lowpass', f: 1200, q: 0.5, vol: 0.18 * p });
      if (kind === 'rough') this._burst(t, 0.25, { type: 'bandpass', f: 1500, q: 0.6, vol: 0.2 });
    }
  }

  // Club whoosh during the downswing (practice swings too).
  swing(power = 0.7) { this.whoosh(clamp(power, 0.15, 1.2)); }

  land(surface = 'fairway', speed = 10) {
    if (!this.ctx) return;
    const t = this.t;
    const k = clamp(speed / 25, 0.1, 1);
    if (surface === 'sand') { this._burst(t, 0.2, { type: 'lowpass', f: 900, q: 0.6, vol: 0.3 * k + 0.1 }); return; }
    if (surface === 'green' || surface === 'fringe') { this._tone(t, 330, 0.06, { vol: 0.25 * k, to: 200 }); this._burst(t, 0.03, { f: 1800, q: 1, vol: 0.12 * k }); return; }
    if (surface === 'rough') { this._burst(t, 0.12, { type: 'bandpass', f: 1300, q: 0.5, vol: 0.18 * k + 0.05 }); return; }
    this._tone(t, 260, 0.08, { vol: 0.28 * k, to: 140 });
    this._burst(t, 0.05, { f: 1200, q: 0.7, vol: 0.15 * k });
  }

  // Ball drops in: a hollow plastic rattle.
  cup() {
    if (!this.ctx) return;
    const t = this.t;
    [0, 0.07, 0.12, 0.155].forEach((d, i) => this._tone(t + d, 900 - i * 60, 0.06, { type: 'triangle', vol: 0.28 - i * 0.05, to: 600 }));
    this._tone(t + 0.2, 260, 0.2, { vol: 0.12, to: 180 });
  }

  rim() {
    if (!this.ctx) return;
    this._tone(this.t, 1100, 0.07, { type: 'triangle', vol: 0.2, to: 800 });
  }

  flag() {
    if (!this.ctx) return;
    const t = this.t;
    this._tone(t, 620, 0.25, { type: 'triangle', vol: 0.18, to: 560 });
    this._tone(t, 1240, 0.15, { type: 'sine', vol: 0.06 });
  }

  splash() {
    if (!this.ctx) return;
    const t = this.t;
    this._burst(t, 0.6, { type: 'lowpass', f: 2200, to: 400, q: 0.6, vol: 0.4 });
    this._burst(t + 0.05, 0.3, { f: 3500, q: 1.5, vol: 0.12 });
    for (let i = 0; i < 6; i++) this._tone(t + 0.1 + Math.random() * 0.4, 700 + Math.random() * 900, 0.05, { vol: 0.04 });
  }

  leaves() {
    if (!this.ctx) return;
    const t = this.t;
    this._burst(t, 0.45, { type: 'highpass', f: 2500, q: 0.4, vol: 0.18, attack: 0.03 });
  }

  thunk() {
    if (!this.ctx) return;
    this._tone(this.t, 300, 0.1, { type: 'triangle', vol: 0.3, to: 120 });
  }

  // ---------------------------------------------------------------- ambience

  ambience(kind, opts = {}) {
    this._wantAmb = kind ? { kind, opts } : null;
    if (!this.ctx) return;
    const old = this._amb;
    if (old) {
      old.g.gain.setTargetAtTime(0, this.t, 0.4);
      setTimeout(() => { try { old.stop(); } catch { /* gone */ } }, 1800);
      this._amb = null;
    }
    if (!kind || kind === 'menu') return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(this.ambBus);
    const nodes = [];
    // Air: soft wind (stronger with the hole's wind).
    const wind = clamp((opts.wind ?? 6) / 30, 0, 1);
    const n = this._noiseSrc();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 350 + wind * 500;
    const wg = ctx.createGain();
    wg.gain.value = kind === 'golf' ? 0.06 + wind * 0.2 : 0.04;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.15;
    const lfoG = ctx.createGain();
    lfoG.gain.value = wg.gain.value * 0.6;
    lfo.connect(lfoG).connect(wg.gain);
    n.connect(lp).connect(wg).connect(g);
    n.start(); lfo.start();
    nodes.push(n, lfo);
    // Crowd murmur at the tennis stadium.
    if (kind === 'tennis') {
      const m = this._noiseSrc();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 520;
      bp.Q.value = 1.2;
      const mg = ctx.createGain();
      mg.gain.value = 0.05;
      m.connect(bp).connect(mg).connect(g);
      m.start();
      nodes.push(m);
    }
    let birdTimer = null;
    if (kind === 'golf') {
      const chirp = () => {
        if (!this.ctx || this._amb?.g !== g) return;
        const t = this.t;
        const base = 2400 + Math.random() * 1600;
        const notes = 2 + Math.floor(Math.random() * 4);
        for (let i = 0; i < notes; i++) this._tone(t + i * 0.09, base * (1 + Math.random() * 0.2), 0.07, { vol: 0.025, to: base * 1.3, out: g });
        birdTimer = setTimeout(chirp, 1800 + Math.random() * 5000);
      };
      birdTimer = setTimeout(chirp, 1200);
    }
    g.gain.setTargetAtTime(1, this.t, 0.8);
    this._amb = { g, stop: () => { clearTimeout(birdTimer); for (const x of nodes) try { x.stop(); } catch { /* */ } } };
  }

  // ---------------------------------------------------------------- music

  music(name) {
    this._wantMusic = name;
    if (!this.ctx) return;
    if (name === this._musicName) return;
    clearInterval(this._musicTimer);
    this._musicTimer = null;
    this._musicName = name;
    if (!name) return;
    const songs = {
      // A bright, bouncy menu tune in C: piano chords, marimba melody, soft bass.
      menu: { bpm: 118, chords: [[48, [60, 64, 67, 71]], [45, [57, 60, 64, 67]], [41, [57, 60, 65, 69]], [43, [55, 59, 62, 65]]],
        melody: [76, null, 74, 72, 74, null, 76, 79, 77, null, 76, 74, 72, null, null, null, 72, null, 74, 76, 77, 76, 74, 72, 71, null, 72, 74, 67, null, null, null], lead: 'mallet', swing: 0.05 },
      // Relaxed results / tennis interlude.
      results: { bpm: 104, chords: [[53, [57, 60, 64, 65]], [50, [57, 60, 62, 65]], [55, [59, 62, 65, 67]], [48, [55, 60, 64, 67]]],
        melody: [72, null, 74, 76, 77, null, 76, 74, 72, null, 69, null, 67, null, null, null], lead: 'bell', swing: 0.08 },
      golf: { bpm: 96, chords: [[43, [55, 59, 62, 66]], [40, [55, 59, 64, 67]], [36, [55, 60, 64, 67]], [38, [54, 57, 62, 66]]],
        melody: [74, null, 71, null, 74, 76, 74, null, 72, null, 69, null, 71, null, null, null], lead: 'bell', swing: 0.06 },
      tennis: { bpm: 124, chords: [[52, [59, 64, 67, 71]], [48, [60, 64, 67, 72]], [50, [57, 62, 66, 69]], [47, [59, 62, 66, 69]]],
        melody: [76, null, 79, null, 76, 74, 71, null, 72, null, 76, null, 74, null, null, null], lead: 'mallet', swing: 0.04 },
    };
    const song = songs[name] || songs.menu;
    const beat = 60 / song.bpm;
    let step = 0;
    let next = this.t + 0.12;
    const tick = () => {
      if (!this.ctx || this._musicName !== name) return;
      while (next < this.t + 0.45) {
        const bar = Math.floor(step / 4);
        const chord = song.chords[bar % song.chords.length];
        const b = step % 4;
        const sw = (step % 2) ? beat * song.swing : 0;
        this._note(next, chord[0] - 12 + (b === 2 ? 7 : 0), beat * 0.85, 'bass');
        if (b === 0 || b === 2) for (const n of chord[1]) this._note(next, n, beat * 1.6, 'keys');
        const m = song.melody[(step * 2) % song.melody.length];
        const m2 = song.melody[(step * 2 + 1) % song.melody.length];
        if (m) this._note(next + sw, m, beat * 0.5, song.lead);
        if (m2) this._note(next + beat / 2 + sw, m2, beat * 0.45, song.lead);
        this._hat(next + beat / 2 + sw, 0.03);
        if (b === 1 || b === 3) this._hat(next, 0.05);
        next += beat;
        step++;
      }
    };
    this._musicTimer = setInterval(tick, 100);
    tick();
  }

  _note(t, n, dur, voice) {
    const ctx = this.ctx;
    const f = midi(n);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    if (voice === 'bass') {
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    } else if (voice === 'keys') {
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    } else if (voice === 'mallet') {
      o.type = 'sine';
      o.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = f * 3.98;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, t);
      g2.gain.exponentialRampToValueAtTime(0.05, t + 0.003);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o2.connect(g2).connect(this.musicBus);
      o2.start(t); o2.stop(t + 0.15);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.4);
    } else {
      // bell
      o.type = 'triangle';
      o.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = f * 2.76;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, t);
      g2.gain.exponentialRampToValueAtTime(0.04, t + 0.004);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.2);
      o2.connect(g2).connect(this.musicBus);
      o2.start(t); o2.stop(t + dur * 1.3);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.8);
    }
    o.connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + dur * 2 + 0.05);
  }

  _hat(t, lvl) {
    const n = this._noiseSrc();
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(lvl, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    n.connect(hp).connect(g).connect(this.musicBus);
    n.start(t);
    n.stop(t + 0.07);
  }

  // Jingles: short fanfares for big moments.
  jingle(kind) {
    if (!this.ctx) return;
    const t = this.t;
    const seqs = {
      win: [[72, 0.12], [76, 0.12], [79, 0.12], [84, 0.36], [83, 0.12], [84, 0.5]],
      point: [[79, 0.08], [84, 0.16]],
      birdie: [[76, 0.1], [79, 0.1], [84, 0.26]],
      eagle: [[72, 0.1], [76, 0.1], [79, 0.1], [84, 0.1], [88, 0.32]],
      ace: [[72, 0.09], [76, 0.09], [79, 0.09], [84, 0.09], [88, 0.09], [91, 0.5]],
      lose: [[67, 0.2], [64, 0.2], [60, 0.5]],
      game: [[72, 0.1], [79, 0.1], [84, 0.3]],
    };
    let tt = t;
    for (const [n, d] of seqs[kind] || []) {
      this._tone(tt, midi(n), d * 1.4, { type: 'triangle', vol: 0.16, out: this.musicBus });
      this._tone(tt, midi(n + 12), d, { type: 'sine', vol: 0.05, out: this.musicBus });
      tt += d;
    }
  }

  // ---------------------------------------------------------------- announcer

  _pickVoice() {
    try {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this._speechVoice = vs.find((v) => /Samantha|Alex|Daniel|Google US English/i.test(v.name) && /en/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    } catch { /* no speech */ }
  }

  say(text, { rate = 1.02, pitch = 1.05, interrupt = true } = {}) {
    if (!this.voice || this.muted || !text) return;
    try {
      if (interrupt) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate;
      u.pitch = pitch;
      u.volume = 0.9;
      if (this._speechVoice) u.voice = this._speechVoice;
      speechSynthesis.speak(u);
    } catch { /* unsupported */ }
  }

  // Brainrot calling cards (from Bowling).
  characterTheme(charId) {
    if (!this.ctx) return;
    const t = this.t;
    switch (charId) {
      case 'tung_tung':
        for (let i = 0; i < 3; i++) {
          const st = t + i * 0.2;
          for (const [f, v] of [[520, 0.4], [1040, 0.2], [280, 0.28]]) this._tone(st, f * (1 + (i % 2) * 0.08), 0.15, { type: 'triangle', vol: v, to: f * 0.92 });
          this._burst(st, 0.035, { f: 2400, q: 4, vol: 0.22 });
        }
        break;
      case 'tralalero': [523, 659, 784, 1046].forEach((f, i) => this._tone(t + i * 0.09, f, 0.18, { type: 'sawtooth', vol: 0.12 })); break;
      case 'ballerina': [1046, 1318, 1567, 2093].forEach((f, i) => this._tone(t + i * 0.11, f, 0.35, { vol: 0.18 })); break;
      case 'bombardiro': this._burst(t, 0.65, { f: 220, to: 680, q: 5, vol: 0.3, attack: 0.1 }); break;
      case 'skibidi': [320, 480, 320, 640].forEach((f, i) => this._tone(t + i * 0.08, f, 0.1, { type: 'square', vol: 0.1 })); break;
      case 'patapim': [392, 330, 392, 523].forEach((f, i) => this._tone(t + i * 0.12, f, 0.12, { type: 'triangle', vol: 0.16 })); break;
      case 'smurf_cat': [880, 988, 1175].forEach((f, i) => this._tone(t + i * 0.14, f, 0.3, { vol: 0.14 })); break;
      case 'gigachad': this._tone(t, 140, 0.55, { type: 'triangle', vol: 0.5, to: 55, attack: 0.02 }); break;
      default: break;
    }
  }
}
