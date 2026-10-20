// Procedural sound for the display: everything is synthesized with Web Audio
// (no audio files). Browsers only start audio after a user gesture, so call
// audio.unlock() from the first click / key press.
//
//   audio.roll(speed01)       start the ball rumble (update with audio.rollUpdate(speed, distance01))
//   audio.rollStop()
//   audio.pinHit(strength, kind)  one clack ('ball' | 'pin' | 'wall' | 'pit' | 'floor')
//   audio.crowd('cheer' | 'big' | 'groan' | 'clap' | 'gasp')
//   audio.ui('blip' | 'select' | 'turn' | 'start' | 'release')
//   audio.music(true | false)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this._rollNodes = null;
    this._lastHit = 0;
    this._hitsThisFrame = 0;
    this._musicOn = false;
    this._musicTimer = null;
    this._noise = null;
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    // Gentle bus compression keeps a 10-pin crash from clipping.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(this.ctx.destination);
    // A short room reverb (synthetic impulse) for the alley.
    this.verb = this.ctx.createConvolver();
    this.verb.buffer = this._impulse(1.6, 2.6);
    this.verbSend = this.ctx.createGain();
    this.verbSend.gain.value = 0.22;
    this.verbSend.connect(this.verb).connect(this.master);
    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.master);
    this.sfx.connect(this.verbSend);
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.16;
    this.musicBus.connect(this.master);
    this._noise = this._noiseBuffer(2);
    if (this._musicOn) this._startMusic();
  }

  get unlocked() { return !!this.ctx && this.ctx.state === 'running'; }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  get t() { return this.ctx ? this.ctx.currentTime : 0; }

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

  // ---------------------------------------------------------------- ball roll

  roll(speed01 = 0.6) {
    if (!this.ctx) return;
    this.rollStop(0);
    const ctx = this.ctx;
    const src = this._noiseSrc();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    lp.Q.value = 0.7;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 90;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = 0;
    // Low hum for the wooden lane resonance.
    const hum = ctx.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = 52;
    const humG = ctx.createGain();
    humG.gain.value = 0;
    src.connect(lp).connect(bp).connect(g).connect(this.sfx);
    hum.connect(humG).connect(this.sfx);
    src.start();
    hum.start();
    const t = this.t;
    g.gain.setTargetAtTime(0.55 + speed01 * 0.4, t, 0.05);
    humG.gain.setTargetAtTime(0.05, t, 0.08);
    this._rollNodes = { src, lp, bp, g, hum, humG };
  }

  // distance01: 0 at the foul line → 1 at the pins (it gets quieter and duller).
  rollUpdate(speedMps, distance01, inGutter = false) {
    const n = this._rollNodes;
    if (!n) return;
    const t = this.t;
    const s = clamp(speedMps / 10, 0, 1.2);
    const far = clamp(distance01, 0, 1);
    n.lp.frequency.setTargetAtTime(160 + s * 260 + (inGutter ? 300 : 0), t, 0.05);
    n.bp.frequency.setTargetAtTime(70 + s * 60 + (inGutter ? 120 : 0), t, 0.05);
    n.g.gain.setTargetAtTime((0.25 + s * 0.6) * (1 - far * 0.55) * (inGutter ? 0.75 : 1), t, 0.06);
    n.hum.frequency.setTargetAtTime(44 + s * 18, t, 0.1);
  }

  rollStop(fade = 0.25) {
    const n = this._rollNodes;
    if (!n || !this.ctx) return;
    this._rollNodes = null;
    const t = this.t;
    n.g.gain.setTargetAtTime(0, t, Math.max(0.01, fade / 3));
    n.humG.gain.setTargetAtTime(0, t, Math.max(0.01, fade / 3));
    setTimeout(() => { try { n.src.stop(); n.hum.stop(); } catch { /* already stopped */ } }, fade * 1000 + 300);
  }

  // ---------------------------------------------------------------- pins

  // One pin impact. strength: contact force (N), kind: what the pin hit.
  pinHit(strength, kind = 'pin') {
    if (!this.ctx) return;
    const now = performance.now();
    if (now - this._lastHit > 16) { this._lastHit = now; this._hitsThisFrame = 0; }
    if (++this._hitsThisFrame > 4) return;          // cap voices per frame
    const ctx = this.ctx;
    const t = this.t + Math.random() * 0.008;
    const loud = clamp(Math.log10(1 + strength / 40) / 2.2, 0.05, 1);
    if (kind === 'floor' || kind === 'pit') {
      // Dull thud of a pin landing on the deck / in the pit.
      this._thud(t, loud * (kind === 'pit' ? 0.5 : 0.7), kind === 'pit' ? 140 : 220);
      return;
    }
    // Hollow maple "clack": a few inharmonic resonances + a noise click.
    const base = kind === 'ball' ? 520 + Math.random() * 120 : 760 + Math.random() * 380;
    const partials = kind === 'ball' ? [1, 1.58, 2.31] : [1, 1.47, 2.09, 2.76];
    const out = ctx.createGain();
    out.gain.value = loud * (kind === 'ball' ? 0.9 : 0.6);
    out.connect(this.sfx);
    for (let i = 0; i < partials.length; i++) {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'triangle' : 'sine';
      o.frequency.value = base * partials[i] * (1 + (Math.random() - 0.5) * 0.04);
      const g = ctx.createGain();
      const dur = (kind === 'wall' ? 0.05 : 0.09) / (1 + i * 0.6);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5 / (1 + i), t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    const n = this._noiseSrc();
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = kind === 'ball' ? 1800 : 3200;
    hp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.7, t + 0.001);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    n.connect(hp).connect(ng).connect(out);
    n.start(t);
    n.stop(t + 0.05);
  }

  _thud(t, loud, freq) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.5, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(loud * 0.5, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.2);
  }

  // Big strike crash layered on top of the individual clacks.
  crash(power = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.t;
    const n = this._noiseSrc();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6 * power, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    n.connect(bp).connect(g).connect(this.sfx);
    n.start(t);
    n.stop(t + 0.8);
    for (let i = 0; i < 10; i++) setTimeout(() => this.pinHit(200 + Math.random() * 900, Math.random() < 0.3 ? 'floor' : 'pin'), i * 22 + Math.random() * 40);
  }

  // ---------------------------------------------------------------- crowd

  crowd(kind) {
    if (!this.ctx) return;
    switch (kind) {
      case 'big': this._cheer(1.0, 3.2); this._clap(2.8, 1.0); break;
      case 'cheer': this._cheer(0.7, 2.2); this._clap(1.8, 0.7); break;
      case 'clap': this._clap(1.4, 0.5); break;
      case 'groan': this._groan(); break;
      case 'gasp': this._gasp(); break;
      default: break;
    }
  }

  // A cheer: band-limited noise with a "vowel" formant and a rising swell.
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
      // Amplitude flutter = many voices.
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
    // A few whistles on the big ones.
    if (power > 0.9) {
      for (let k = 0; k < 2; k++) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        const t0 = t + 0.3 + k * 0.5;
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
    const ctx = this.ctx;
    const t0 = this.t;
    const claps = Math.floor(40 * dur * density);
    for (let i = 0; i < claps; i++) {
      const t = t0 + Math.random() * dur * (0.4 + 0.6 * Math.random());
      const n = this._noiseSrc();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900 + Math.random() * 1500;
      bp.Q.value = 1.4;
      const g = ctx.createGain();
      const fade = 1 - (t - t0) / dur;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18 * Math.max(0.1, fade), t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
      n.connect(bp).connect(g).connect(this.sfx);
      n.start(t);
      n.stop(t + 0.05);
    }
  }

  _groan() {
    const ctx = this.ctx;
    const t = this.t;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.32, t + 0.2);
    out.gain.setTargetAtTime(0.0001, t + 0.7, 0.3);
    out.connect(this.sfx);
    // "Awww": falling formants over a buzzy multi-voice source.
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
    const ctx = this.ctx;
    const t = this.t;
    const n = this._noiseSrc();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.linearRampToValueAtTime(1700, t + 0.25);
    bp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    n.connect(bp).connect(g).connect(this.sfx);
    n.start(t);
    n.stop(t + 0.7);
  }

  // ---------------------------------------------------------------- UI

  ui(kind) {
    if (!this.ctx) return;
    const seqs = {
      blip: [[880, 0.06]],
      select: [[660, 0.06], [990, 0.09]],
      turn: [[523, 0.08], [659, 0.08], [784, 0.14]],
      start: [[392, 0.1], [523, 0.1], [659, 0.1], [784, 0.22]],
      release: [[300, 0.05]],
      sweep: [[180, 0.25]],
      join: [[784, 0.07], [1175, 0.12]],
      leave: [[440, 0.08], [330, 0.14]],
    };
    const seq = seqs[kind];
    if (!seq) return;
    let t = this.t;
    for (const [f, d] of seq) {
      const o = this.ctx.createOscillator();
      o.type = kind === 'sweep' ? 'sawtooth' : 'triangle';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(kind === 'sweep' ? 0.04 : 0.18, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(this.sfx);
      o.start(t);
      o.stop(t + d + 0.02);
      t += d * 0.85;
    }
  }

  // Authentic Indonesian kentongan slit-drum knock: TUNG TUNG TUNG!
  tungTungDrum(count = 3, interval = 0.2) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    let t = this.t;
    for (let i = 0; i < count; i++) {
      const strikeT = t + i * interval;
      for (const [freq, gain] of [[520, 0.45], [1040, 0.22], [280, 0.3]]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq * (1 + (i % 2) * 0.08), strikeT);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.92, strikeT + 0.12);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, strikeT);
        g.gain.exponentialRampToValueAtTime(gain, strikeT + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, strikeT + 0.15);
        osc.connect(g).connect(this.sfx);
        osc.start(strikeT);
        osc.stop(strikeT + 0.16);
      }
      const n = this._noiseSrc();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400;
      bp.Q.value = 4;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, strikeT);
      ng.gain.exponentialRampToValueAtTime(0.25, strikeT + 0.002);
      ng.gain.exponentialRampToValueAtTime(0.0001, strikeT + 0.035);
      n.connect(bp).connect(ng).connect(this.sfx);
      n.start(strikeT);
      n.stop(strikeT + 0.04);
    }
  }

  characterTheme(charId) {
    if (!this.ctx) return;
    const t = this.t;
    switch (charId) {
      case 'tung_tung':
        this.tungTungDrum(3, 0.2);
        break;
      case 'tralalero': {
        for (const [i, freq] of [[0, 523], [1, 659], [2, 784], [3, 1046]]) {
          const o = this.ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = freq;
          const g = this.ctx.createGain();
          const st = t + i * 0.09;
          g.gain.setValueAtTime(0.0001, st);
          g.gain.exponentialRampToValueAtTime(0.18, st + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, st + 0.18);
          o.connect(g).connect(this.sfx);
          o.start(st); o.stop(st + 0.2);
        }
        break;
      }
      case 'ballerina': {
        for (const [i, freq] of [[0, 1046], [1, 1318], [2, 1567], [3, 2093]]) {
          const o = this.ctx.createOscillator();
          o.type = 'sine';
          o.frequency.value = freq;
          const g = this.ctx.createGain();
          const st = t + i * 0.11;
          g.gain.setValueAtTime(0.0001, st);
          g.gain.exponentialRampToValueAtTime(0.22, st + 0.005);
          g.gain.exponentialRampToValueAtTime(0.0001, st + 0.35);
          o.connect(g).connect(this.sfx);
          o.start(st); o.stop(st + 0.4);
        }
        break;
      }
      case 'bombardiro': {
        const n = this._noiseSrc();
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(220, t);
        bp.frequency.exponentialRampToValueAtTime(680, t + 0.35);
        bp.Q.value = 5;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.1);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
        n.connect(bp).connect(g).connect(this.sfx);
        n.start(t); n.stop(t + 0.7);
        break;
      }
      case 'skibidi': {
        for (const [i, freq] of [[0, 320], [1, 480], [2, 320], [3, 640]]) {
          const o = this.ctx.createOscillator();
          o.type = 'square';
          o.frequency.value = freq;
          const g = this.ctx.createGain();
          const st = t + i * 0.08;
          g.gain.setValueAtTime(0.0001, st);
          g.gain.exponentialRampToValueAtTime(0.14, st + 0.008);
          g.gain.exponentialRampToValueAtTime(0.0001, st + 0.1);
          o.connect(g).connect(this.sfx);
          o.start(st); o.stop(st + 0.12);
        }
        break;
      }
      case 'gigachad': {
        const o = this.ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(140, t);
        o.frequency.exponentialRampToValueAtTime(55, t + 0.4);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.65, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
        o.connect(g).connect(this.sfx);
        o.start(t); o.stop(t + 0.6);
        break;
      }
      default:
        this.tungTungDrum(2, 0.2);
        break;
    }
  }

  // Pinsetter machinery: a mechanical whirr + clunk.
  machine() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.t;
    const n = this._noiseSrc();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 300;
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.15);
    g.gain.setTargetAtTime(0.0001, t + 1.1, 0.2);
    n.connect(bp).connect(g).connect(this.sfx);
    n.start(t);
    n.stop(t + 2);
    this._thud(t + 1.2, 0.5, 120);
  }

  // ---------------------------------------------------------------- music

  music(on) {
    this._musicOn = on;
    if (!this.ctx) return;
    if (on) this._startMusic(); else this._stopMusic();
  }

  // A relaxed swing loop: walking bass, brushed hats and soft e-piano chords.
  _startMusic() {
    if (this._musicTimer) return;
    const bpm = 112;
    const beat = 60 / bpm;
    // ii–V–I–VI in F: Gm7 C7 Fmaj7 D7 (two bars each).
    const chords = [
      [55, [55, 58, 62, 65]], [48, [52, 55, 58, 60]], [53, [57, 60, 64, 65]], [50, [54, 57, 60, 62]],
    ];
    const walk = [[0, 2, 4, 5], [0, 4, 7, 9], [0, 2, 4, 7], [0, 3, 4, 6]];
    let step = 0;
    let next = this.t + 0.1;
    const tick = () => {
      if (!this.ctx) return;
      while (next < this.t + 0.4) {
        const bar = Math.floor(step / 4) % 8;
        const chord = chords[Math.floor(bar / 2) % 4];
        const beatInBar = step % 4;
        const swing = beatInBar % 2 ? beat * 0.08 : 0;
        // Bass.
        const bassNote = chord[0] - 12 + walk[Math.floor(bar / 2) % 4][beatInBar];
        this._note(next + swing, bassNote, beat * 0.9, 'bass');
        // Hat on every beat, swung off-beat.
        this._hat(next, 0.05);
        this._hat(next + beat * 0.66, 0.025);
        // Chord stabs on 2 and 4 (+ a pushed one occasionally).
        if (beatInBar === 1 || beatInBar === 3) for (const n of chord[1]) this._note(next + beat * 0.66, n, beat * 0.5, 'keys');
        next += beat;
        step++;
      }
    };
    this._musicTimer = setInterval(tick, 100);
    tick();
  }

  _stopMusic() {
    clearInterval(this._musicTimer);
    this._musicTimer = null;
  }

  _note(t, midi, dur, voice) {
    const ctx = this.ctx;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    if (voice === 'bass') {
      o.type = 'triangle';
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.55, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.frequency.value = f;
      o.connect(g).connect(this.musicBus);
    } else {
      o.type = 'sine';
      o.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = f * 2.01;
      const g2 = ctx.createGain();
      g2.gain.value = 0.25;
      o2.connect(g2).connect(g);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.6);
      o.connect(g).connect(this.musicBus);
      o2.start(t);
      o2.stop(t + dur * 1.7);
    }
    o.start(t);
    o.stop(t + dur * 1.7);
  }

  _hat(t, lvl) {
    const ctx = this.ctx;
    const n = this._noiseSrc();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(lvl, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    n.connect(hp).connect(g).connect(this.musicBus);
    n.start(t);
    n.stop(t + 0.08);
  }
}
