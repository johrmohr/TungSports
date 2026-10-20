// Race + menu input for the desktop (SPEC §10, §14.6).
//
//   Input     keyboard + gamepad (navigator.getGamepads polling): the controller
//             of keyboard mode and the desktop's menu keys (Esc = pause, M, …).
//             Optionally merges one phone source (dev sandboxes / solo testing).
//   PadInput  one phone steering wheel per player slot, read from a PhoneLink
//             (`getInput(slot)` + `isActive(slot)`, SPEC §14.7) or from any
//             single-pad object with `.input` + `.active`.
//
//   const keys = new Input();                       // keyboard mode / menus
//   const pad = new PadInput(phoneLink, 2);         // P2's phone
//   // every frame, before reading:
//   keys.update(dt); pad.update(dt);
//   kart.input.steer = pad.steer; kart.input.throttle = pad.throttle; ...
//   if (pad.itemPressed) kart.input.useItem = true;
//
// Conventions: steer ∈ [-1, 1] with +1 = RIGHT. Edges (itemPressed,
// pausePressed, menu.*, anyPressed) are true for exactly one update() after
// the press; presses that start and end between two frames are never lost
// (keys are queued between frames, phone presses arrive as sequence counters).
// Note: Escape is both "pause" and "menu back" — callers should handle
// pausePressed first and ignore menu.back in the same frame if they toggled pause.
//
// Text fields: while an <input> / <textarea> / contenteditable has the focus
// every keyboard key is left to the field and gamepad menu edges are dropped,
// so typing never steers, pauses or navigates a menu. Keys held when a field
// gains the focus are released. `input.typing` reports that state;
// isTypingTarget() is exported for other key listeners (main.js app keys).

import { clamp, approach } from './utils.js';

// Key bindings by KeyboardEvent.code (physical key position).
const KEYS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  gas: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  drift: ['Space', 'ShiftLeft', 'ShiftRight'],
  // no Ctrl: next to W (gas) it would make Ctrl+W, a shortcut Windows / Linux
  // browsers never hand to the page, close the tab mid-race
  item: ['KeyX', 'KeyE', 'KeyZ'],
  look: ['KeyC'],
  pause: ['Escape', 'KeyP'],
  menuLeft: ['ArrowLeft', 'KeyA'],
  menuRight: ['ArrowRight', 'KeyD'],
  menuUp: ['ArrowUp', 'KeyW'],
  menuDown: ['ArrowDown', 'KeyS'],
  confirm: ['Enter', 'NumpadEnter'],
  back: ['Backspace', 'Escape'],
};

// Keys whose browser default (scrolling, history back, focus moves) must be blocked.
const PREVENT = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Backspace']);
// Every bound code (Ctrl+<game key> defaults like save/bookmark are blocked where the browser allows it).
const BOUND = new Set(Object.values(KEYS).flat());

// Fallback for browsers that do not report KeyboardEvent.code.
const KEY_TO_CODE = {
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  ' ': 'Space', Spacebar: 'Space', Shift: 'ShiftLeft', Control: 'ControlLeft', Enter: 'Enter',
  Escape: 'Escape', Esc: 'Escape', Backspace: 'Backspace',
};
function codeOf(e) {
  if (e.code) return e.code;
  const k = e.key || '';
  if (KEY_TO_CODE[k]) return KEY_TO_CODE[k];
  if (k.length === 1 && /[a-z]/i.test(k)) return 'Key' + k.toUpperCase();
  return k;
}

function anyIn(set, codes) {
  for (let i = 0; i < codes.length; i++) if (set.has(codes[i])) return true;
  return false;
}

export function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color'].includes(type);
  }
  return !!el.isContentEditable;
}

// Standard Gamepad mapping indices.
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const PAD_BUTTONS = 17;
const STICK_DEADZONE = 0.15;
const STICK_MENU_ON = 0.6, STICK_MENU_OFF = 0.35;

// Keyboard steering ramp rates (1/s): toward full lock, and back to center / reversing.
const STEER_RAMP = 7;
const STEER_RETURN = 10;

// ================================================================ PadInput

/**
 * One phone steering wheel. `link` is a PhoneLink (per-slot API) or a single
 * pad source `{ input, active }`; the input record may use the long field
 * names (steer, gas, brake, drift, itemSeq, pauseSeq) or the wire names
 * (s, g, b, d, i, p).
 */
export class PadInput {
  constructor(link = null, slot = 1) {
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.drift = false;
    this.itemPressed = false;
    this.pausePressed = false;
    this.active = false;          // the phone is connected and streaming
    this.changed = false;         // a held button changed this frame (input source tracking)
    this._prev = { gas: 0, brake: 0, drift: 0 };
    this.setSource(link, slot);
  }

  /** Attach another link / slot (sequence counters resync without firing). */
  setSource(link, slot = this.slot) {
    this.link = link;
    this.slot = slot;
    this._seqItem = null;
    this._seqPause = null;
  }

  _read() {
    const l = this.link;
    if (!l) return null;
    if (typeof l.getInput === 'function') return l.getInput(this.slot);
    return l.input || null;
  }

  _isActive() {
    const l = this.link;
    if (!l) return false;
    if (typeof l.isActive === 'function') return !!l.isActive(this.slot);
    return !!l.active;
  }

  update() {
    const pin = this._read();
    const active = !!pin && this._isActive();
    this.active = active;
    this.itemPressed = false;
    this.pausePressed = false;
    this.changed = false;
    if (pin) {
      // Sequence counters make item/pause presses lossless. A decrease means a
      // new pad (or a reset) — resync without firing.
      const iseq = (pin.itemSeq ?? pin.i) | 0, pseq = (pin.pauseSeq ?? pin.p) | 0;
      if (this._seqItem === null || iseq < this._seqItem) this._seqItem = iseq;
      else if (iseq > this._seqItem) { this.itemPressed = true; this._seqItem = iseq; this.changed = true; }
      if (this._seqPause === null || pseq < this._seqPause) this._seqPause = pseq;
      else if (pseq > this._seqPause) { this.pausePressed = true; this._seqPause = pseq; this.changed = true; }
    }
    const pp = this._prev;
    if (active) {
      const gas = (pin.gas ?? pin.g) ? 1 : 0;
      const brk = (pin.brake ?? pin.b) ? 1 : 0;
      const dr = (pin.drift ?? pin.d) ? 1 : 0;
      if (gas !== pp.gas || brk !== pp.brake || dr !== pp.drift) this.changed = true;
      pp.gas = gas; pp.brake = brk; pp.drift = dr;
      const s = Number(pin.steer ?? pin.s);
      this.steer = Number.isFinite(s) ? clamp(s, -1, 1) : 0;
      this.throttle = gas;
      this.brake = brk;
      this.drift = dr === 1;
    } else {
      pp.gas = 0; pp.brake = 0; pp.drift = 0;
      this.steer = 0; this.throttle = 0; this.brake = 0; this.drift = false;
    }
  }

  reset() {
    this.steer = 0; this.throttle = 0; this.brake = 0; this.drift = false;
    this.itemPressed = false; this.pausePressed = false; this.changed = false;
    this._seqItem = null; this._seqPause = null;
  }
}

// ================================================================ Input

export class Input {
  constructor({ phone = null } = {}) {
    // merged race controls
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.drift = false;
    this.itemPressed = false;
    this.pausePressed = false;
    this.phonePausePressed = false;   // the pause edge came from the phone's ⏸ (pause-only, never resumes)
    this.lookBack = false;
    // menu navigation edges
    this.menu = { left: false, right: false, up: false, down: false, confirm: false, back: false };
    this.anyPressed = false;          // any key / pad button edge this frame
    this.lastSource = 'keyboard';
    this.phoneActive = false;
    this.gamepadConnected = false;
    this.typing = false;              // a text field has the keyboard focus

    this._down = new Set();           // codes currently held
    this._pressed = new Set();        // codes pressed since the last update()
    this._kSteer = 0;                 // smoothed keyboard steer
    this._padPrev = new Uint8Array(PAD_BUTTONS);
    this._padNow = new Uint8Array(PAD_BUTTONS);
    this._padIndex = -1;
    this._stickX = 0;                 // menu stick latch: -1 / 0 / +1
    this._stickY = 0;
    this._padSteerHard = false;
    this.pad = new PadInput(phone, 1);   // optional merged phone source

    this._onKeyDown = (e) => this._keyDown(e);
    this._onKeyUp = (e) => this._keyUp(e);
    this._onBlur = () => this.releaseAll();
    // a text field taking the focus owns the keyboard from now on: drop held keys + queued edges
    this._onFocusIn = (e) => { if (isTypingTarget(e.target)) { this.releaseAll(); this._pressed.clear(); } };
    this._onVisibility = () => { if (typeof document !== 'undefined' && document.hidden) this.releaseAll(); };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onBlur);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility);
      document.addEventListener('focusin', this._onFocusIn);
    }
  }

  /** Merge one phone source (PhoneLink + slot, or `{ input, active }`); null detaches it. */
  setPhone(phone, slot = 1) { this.pad.setSource(phone, slot); }

  // ------------------------------------------------------------ keyboard events

  _keyDown(e) {
    if (isTypingTarget(e.target) || this._focusTyping()) return;
    const code = codeOf(e);
    if (!e.metaKey && !e.altKey && (PREVENT.has(code) || (e.ctrlKey && BOUND.has(code)))) e.preventDefault();
    if (e.metaKey) return;            // Cmd shortcuts belong to the browser/OS
    this._down.add(code);
    if (e.repeat) return;             // OS auto-repeat never creates edges
    this._pressed.add(code);
    this.lastSource = 'keyboard';
  }

  _keyUp(e) {
    const code = codeOf(e);
    this._down.delete(code);
    // macOS swallows keyup for keys released while Cmd is held: drop everything.
    if (code === 'MetaLeft' || code === 'MetaRight' || e.key === 'Meta') this._down.clear();
    if (PREVENT.has(code) && !isTypingTarget(e.target)) e.preventDefault();
  }

  // A text field has the focus (keydown targets can be the body for a moment
  // after focus() calls, so the active element is checked too).
  _focusTyping() {
    return typeof document !== 'undefined' && isTypingTarget(document.activeElement);
  }

  /** Release every held key (window blur, tab hidden, pause). Edges already queued are kept. */
  releaseAll() {
    this._down.clear();
    this._kSteer = 0;
  }

  // ------------------------------------------------------------ per-frame update

  update(dt = 1 / 60) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    const down = this._down, pressed = this._pressed;
    const m = this.menu;
    const typing = this._focusTyping();
    this.typing = typing;
    if (typing) { down.clear(); pressed.clear(); }

    // ---- keyboard
    const kl = anyIn(down, KEYS.left), kr = anyIn(down, KEYS.right);
    const kTarget = (kr ? 1 : 0) - (kl ? 1 : 0);
    if (kTarget === 0) this._kSteer = approach(this._kSteer, 0, STEER_RETURN * dt);
    else if (this._kSteer * kTarget < 0) this._kSteer = approach(this._kSteer, kTarget, (STEER_RETURN + STEER_RAMP) * dt);
    else this._kSteer = approach(this._kSteer, kTarget, STEER_RAMP * dt);
    let throttle = anyIn(down, KEYS.gas) ? 1 : 0;
    let brake = anyIn(down, KEYS.brake) ? 1 : 0;
    let drift = anyIn(down, KEYS.drift);
    let look = anyIn(down, KEYS.look);
    let item = anyIn(pressed, KEYS.item);
    let pause = anyIn(pressed, KEYS.pause);
    m.left = anyIn(pressed, KEYS.menuLeft);
    m.right = anyIn(pressed, KEYS.menuRight);
    m.up = anyIn(pressed, KEYS.menuUp);
    m.down = anyIn(pressed, KEYS.menuDown);
    m.confirm = anyIn(pressed, KEYS.confirm);
    m.back = anyIn(pressed, KEYS.back);
    let any = pressed.size > 0;
    pressed.clear();

    // ---- gamepad
    let padSteer = 0, padSteering = false;
    const pad = this._pollGamepad();
    if (pad && typing) {
      this._padPrev.set(this._padNow);    // no edges now, none queued for later
    } else if (pad) {
      const now = this._padNow, prev = this._padPrev;
      const axX = pad.axes && pad.axes.length ? pad.axes[0] || 0 : 0;
      const axY = pad.axes && pad.axes.length > 1 ? pad.axes[1] || 0 : 0;
      const ax = Math.abs(axX);
      if (ax > STICK_DEADZONE) {
        padSteer = Math.sign(axX) * clamp((ax - STICK_DEADZONE) / (1 - STICK_DEADZONE), 0, 1);
        padSteering = true;
      } else if (this._btn(PAD.LEFT) !== this._btn(PAD.RIGHT)) {
        padSteer = this._btn(PAD.RIGHT) ? 1 : -1;
        padSteering = true;
      }
      const rt = this._padValue(pad, PAD.RT), lt = this._padValue(pad, PAD.LT);
      throttle = Math.max(throttle, this._btn(PAD.A) ? 1 : rt > 0.1 ? rt : 0);
      brake = Math.max(brake, this._btn(PAD.B) ? 1 : lt > 0.1 ? lt : 0);
      drift = drift || this._btn(PAD.RB) || this._btn(PAD.X);
      look = look || this._btn(PAD.R3) || (pad.axes && pad.axes.length > 3 && pad.axes[3] > 0.7);
      item = item || this._edge(PAD.LB) || this._edge(PAD.Y);
      pause = pause || this._edge(PAD.START);

      // menus: d-pad edges + stick latch with hysteresis
      let sx = this._stickX, sy = this._stickY;
      if (sx === 0 && Math.abs(axX) > STICK_MENU_ON) sx = Math.sign(axX); else if (sx !== 0 && Math.abs(axX) < STICK_MENU_OFF) sx = 0;
      if (sy === 0 && Math.abs(axY) > STICK_MENU_ON) sy = Math.sign(axY); else if (sy !== 0 && Math.abs(axY) < STICK_MENU_OFF) sy = 0;
      m.left = m.left || this._edge(PAD.LEFT) || (sx === -1 && this._stickX !== -1);
      m.right = m.right || this._edge(PAD.RIGHT) || (sx === 1 && this._stickX !== 1);
      m.up = m.up || this._edge(PAD.UP) || (sy === -1 && this._stickY !== -1);
      m.down = m.down || this._edge(PAD.DOWN) || (sy === 1 && this._stickY !== 1);
      m.confirm = m.confirm || this._edge(PAD.A);
      m.back = m.back || this._edge(PAD.B);
      const stickMoved = (sx !== 0 && sx !== this._stickX) || (sy !== 0 && sy !== this._stickY);
      this._stickX = sx; this._stickY = sy;

      let padEdge = false;
      for (let i = 0; i < PAD_BUTTONS; i++) if (now[i] === 1 && prev[i] === 0) { padEdge = true; break; }
      const steerHard = ax > 0.5;
      if (padEdge || stickMoved || (steerHard && !this._padSteerHard)) this.lastSource = 'gamepad';
      this._padSteerHard = steerHard;
      any = any || padEdge;
      prev.set(now);
    }

    // ---- merged phone (optional)
    const ph = this.pad;
    ph.update(dt);
    this.phoneActive = ph.active;
    if (ph.itemPressed) item = true;
    if (ph.changed) { this.lastSource = 'phone'; any = any || ph.itemPressed || ph.pausePressed; }
    if (ph.active) {
      throttle = Math.max(throttle, ph.throttle);
      brake = Math.max(brake, ph.brake);
      drift = drift || ph.drift;
    }

    // ---- steering priority: held steer key > gamepad stick/d-pad > phone > decaying keyboard
    let steer = this._kSteer;
    if (!(kl || kr)) {
      if (padSteering) steer = padSteer;
      else if (ph.active) steer = ph.steer;
    }

    this.steer = clamp(steer, -1, 1);
    this.throttle = throttle;
    this.brake = brake;
    this.drift = drift;
    this.lookBack = !!look;
    this.itemPressed = item;
    this.pausePressed = pause || ph.pausePressed;
    this.phonePausePressed = ph.pausePressed && !pause;
    this.anyPressed = any;
  }

  _btn(i) { return this._padNow[i] === 1; }
  _edge(i) { return this._padNow[i] === 1 && this._padPrev[i] === 0; }

  _padValue(pad, i) {
    const b = pad.buttons && pad.buttons[i];
    if (!b) return 0;
    return typeof b === 'object' ? b.value || (b.pressed ? 1 : 0) : Number(b) || 0;
  }

  // Poll navigator.getGamepads(); keeps using the same pad while it stays connected.
  _pollGamepad() {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || typeof nav.getGamepads !== 'function') { this.gamepadConnected = false; return null; }
    let pads;
    try { pads = nav.getGamepads(); } catch { pads = null; }
    if (!pads) { this.gamepadConnected = false; return null; }
    let pad = this._padIndex >= 0 ? pads[this._padIndex] : null;
    if (!pad || !pad.connected) {
      pad = null;
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p && p.connected && (!pad || (p.mapping === 'standard' && pad.mapping !== 'standard'))) pad = p;
      }
      this._padIndex = pad ? pad.index : -1;
      this._padPrev.fill(0);
      // Buttons already held when a pad is (re)acquired should not fire edges.
      if (pad) for (let i = 0; i < PAD_BUTTONS; i++) this._padPrev[i] = this._isDown(pad, i) ? 1 : 0;
    }
    this.gamepadConnected = !!pad;
    if (!pad) return null;
    for (let i = 0; i < PAD_BUTTONS; i++) this._padNow[i] = this._isDown(pad, i) ? 1 : 0;
    return pad;
  }

  _isDown(pad, i) {
    const b = pad.buttons && pad.buttons[i];
    if (!b) return false;
    if (typeof b === 'object') return !!b.pressed || (b.value || 0) > 0.5;
    return Number(b) > 0.5;
  }

  /** Clear all held state and pending edges (e.g. when switching screens). */
  reset() {
    this._down.clear();
    this._pressed.clear();
    this._kSteer = 0;
    this.steer = 0; this.throttle = 0; this.brake = 0; this.drift = false;
    this.itemPressed = false; this.pausePressed = false; this.phonePausePressed = false; this.lookBack = false; this.anyPressed = false;
    for (const k in this.menu) this.menu[k] = false;
    this.pad.reset();
  }

  dispose() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onBlur);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
      document.removeEventListener('focusin', this._onFocusIn);
    }
    this.reset();
    this.pad.setSource(null);
  }
}
