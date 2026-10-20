// KRISHIV KART phone controller (SPEC §11, §14.3b, §14.7, §14.8).
//
// Runs on each player's phone at https://<LAN IP>:3443/pad?room=ABCD. Up to
// four phones join one game, one per player slot P1–P4 (the server seats
// them; the lowest connected slot is the host, shown with a crown). The phone
// is held sideways like a steering wheel: rotating it steers, the on-screen
// buttons are GAS / BRAKE (right thumb) and DRIFT / ITEM (left thumb). Every
// personal choice happens here, classic kart-racer style:
//
//   join → lobby (host: MODE / CLASS / ITEMS / START) → CHARACTER → KART BODY
//   → WHEELS → READY card (Steer Assist, Auto-Gas) → waiting for the others →
//   track (host: cup / track pick + GO) → race controller → results →
//   standings → podium (host: NEXT / LOBBY).
//
// The shared `host:state` drives which screen everyone sees; `host:padState`
// is this phone's own view (its step, choices, race HUD). Taps are optimistic:
// a picked card or an advanced step shows at once and the desktop confirms.
//
// Flow before that: [insecure-context help] → [room code entry] → "tap to
// start" gate (sensor permission, wake lock, fullscreen) → live screens. A 5th
// phone gets a "Game full" screen and keeps retrying.
//
// Orientation: the race UI is an always-landscape stage, CSS-rotated ±90°
// when the page is laid out portrait (orientation-locked phone held
// sideways). Menus are the exception: held upright they use the natural
// portrait layout (.stage.tall), held sideways the rotated landscape one.
//
// Steering pipeline:
//   deviceorientation β,γ → world-up in device coords → rotate into the
//   visible UI frame (screen orientation angle + our CSS rotation) →
//   θ = in-plane wheel angle atan2(−ux, uy), blended into asin(−ux) as the
//   phone lies flat (see angleFromScreenUp) → minus calibration → invert? →
//   3° dead zone → expo 0.55 centre → soft knee (from 70 % of the way to the
//   lock) into a hard steering lock at the sensitivity angle (default 42°):
//   steer 0.8, and tilting further adds nothing (SPEC §15.1) → 30/s low-pass
//   → sent as `s` (+1 = right). Falls back to
//   devicemotion gravity, then to a touch slider. The wheel re-centers itself
//   at every countdown.
//
// When the page is hidden mid-race (screen lock, app switch, a call) the pad
// releases everything and stops streaming; in a solo race it also pauses the
// game (with more players the desktop lets a CPU drive this kart instead).
//
// window.__pad exposes live values for automated tests.

import { ITEM_INFO, ITEM_IDS, ITEM_ENABLED, NET, RACE } from './config.js';
import { clamp, damp, ordinal, formatTime } from './utils.js';
import { ROOM_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } from './net.js';
import { STAT_KEYS, STAT_LABELS, PLAYER_SLOTS, KART_BODIES, WHEELS, GP_POINTS, computeRatings, slotInfo } from './parts.js';

// ---------------------------------------------------------------- constants

const DEG = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const DEAD_ZONE_DEG = 3;
const LOCK_MIN_DEG = 18;
const LOCK_MAX_DEG = 50;
const LOCK_DEFAULT_DEG = 42;       // calm: half steer at ~30° of tilt (notes/drift-fix.md)
const LOCK_OLD_DEFAULT_DEG = 32;   // the default before the drift fix (tilt mapping v1)
const TILT_MAP_VERSION = 2;        // saved with the settings: v1 phones still on the old default move to the new one
const EXPO = 0.55;                 // 0 = linear … 1 = cubic response (tilt), below the knee
const STEER_KNEE = 0.7;            // fraction of the dead-zone→lock span where the curve starts to flatten (30.3° at 42°)
const STEER_CAP = 0.8;             // steering lock: the most a phone wheel steers (share of the kart's full turn; SPEC §15.1)
const TOUCH_EXPO = 0.3;            // touch slider curve
const STEER_LPF_RATE = 30;         // 1/s low-pass (~33 ms time constant)
const TOUCH_LPF_RATE = 32;
const SENSOR_TIMEOUT_MS = 1500;    // after the gate: no events → next fallback
const SENSOR_STALE_MS = 600;       // tilt source silent this long → steer returns to 0
const CALIB_LIMIT_DEG = 45;
const AUTO_CENTER_LIMIT_DEG = 30;
const ROT_SWITCH = 0.55;           // in-plane gravity needed to flip the CSS rotation side
const ROT_HOLD_MS = 220;
// Orientation-angle sanity check (see checkAngleSanity). Both holds are longer
// than the OS takes to re-orient the page after a 180° turn, so a normal turn
// never triggers a false correction.
const FLIP_HOLD_FIRST_MS = 900;
const FLIP_HOLD_MS = 1600;
const WHEEL_M0 = 0.35;             // in-plane gravity at/below this: flat phone → roll angle…
const WHEEL_M1 = 0.6;              // …at/above this: wheel grip → true in-plane wheel angle
const KEEPALIVE_MS = 250;          // input heartbeat outside the race screen
const IN_USE_MS = 30000;           // touched this recently = the phone is the controller
const RELOAD_HINT_ERRORS = 4;      // failed reconnects in a row → suggest reloading the page
const HINT_DELAY_MS = 900;         // portrait pose held this long → "turn sideways" hint
const PING_MS = 2000;
const WHEEL_VISUAL_DEG = 110;      // wheel graphic rotation at full lock
const START_PRESS_LEAD = (RACE.startBoostWindow[0] + RACE.startBoostWindow[1]) / 2;
const POSE_HOLD_MS = 350;          // phone held upright this long → menus use the natural layout
const PENDING_MS = 1500;           // an optimistic tap waits this long for the desktop to confirm
const FULL_RETRY_MS = 4000;        // "Game full": try to join again this often
const ASSIST_RETRY_MS = 1500;      // phone's Steer Assist preference re-sent while the host differs
const SETTINGS_KEY = 'krishivkart.pad.settings.v1';
const ID_KEY = 'krishivkart.pad.id';
// Before the KRISHIV KART rename: read once so phones keep their settings + id.
const LEGACY_KEYS = { [SETTINGS_KEY]: 'tootkart.pad.settings.v1', [ID_KEY]: 'tootkart.pad.id' };
const CSS_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const STEPS = new Set(['char', 'body', 'wheels', 'ready', 'done']);
const STEP_NEXT = { char: 'body', body: 'wheels', wheels: 'ready', ready: 'done' };
const STEP_BACK = { body: 'char', wheels: 'body', ready: 'wheels', done: 'ready' };
const LIVE_RACE_STATES = new Set(['intro', 'countdown', 'racing']);
const STAT_SHORT = { speed: 'SPD', accel: 'ACC', handling: 'HND', weight: 'WGT' };
const CLASS_ROWS = [['light', 'LIGHT'], ['medium', 'MEDIUM'], ['heavy', 'HEAVY']];
const DEFAULT_CHAR = 'sahur';
// Screens that use the phone's natural orientation when it is held upright
// (everything but the gate and the race controller).
const MENU_SCREENS = new Set(['insecure', 'code', 'full', 'connecting', 'lobby', 'char', 'body', 'wheels', 'ready', 'waiting',
  'track', 'trackwait', 'loading', 'spectate', 'paused', 'results', 'standings', 'podium']);

// ---------------------------------------------------------------- storage

function storageGet(key) {
  try {
    const v = window.localStorage.getItem(key);
    return v !== null || !LEGACY_KEYS[key] ? v : window.localStorage.getItem(LEGACY_KEYS[key]);
  } catch { return null; }
}
function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode / blocked */ }
}

// Defaults (SPEC §14.3b): full lock at 42°, Auto-Gas and Steer Assist ON for a
// phone that never saved a setting. A phone saved with tilt mapping v1 that
// still sits on that version's 32° default gets the new default (it never
// chose 32°: any change of Assist / Auto-Gas / tilt mode saved it).
function loadSettings() {
  const s = { lockDeg: LOCK_DEFAULT_DEG, autoGas: true, assist: true, invert: false, haptics: true, steerMode: 'tilt', tiltMap: TILT_MAP_VERSION };
  try {
    const v = JSON.parse(storageGet(SETTINGS_KEY) || '{}');
    if (Number.isFinite(v.lockDeg)) s.lockDeg = clamp(Math.round(v.lockDeg), LOCK_MIN_DEG, LOCK_MAX_DEG);
    if (v.tiltMap !== TILT_MAP_VERSION && s.lockDeg === LOCK_OLD_DEFAULT_DEG) s.lockDeg = LOCK_DEFAULT_DEG;
    if (typeof v.autoGas === 'boolean') s.autoGas = v.autoGas;
    if (typeof v.assist === 'boolean') s.assist = v.assist;
    if (typeof v.invert === 'boolean') s.invert = v.invert;
    if (typeof v.haptics === 'boolean') s.haptics = v.haptics;
    if (v.steerMode === 'touch' || v.steerMode === 'tilt') s.steerMode = v.steerMode;
  } catch { /* defaults */ }
  return s;
}
const settings = loadSettings();
const saveSettings = () => storageSet(SETTINGS_KEY, JSON.stringify(settings));

function getClientId() {
  let id = storageGet(ID_KEY);
  if (!id || !/^[A-Za-z0-9_-]{6,40}$/.test(id)) {
    const rnd = new Uint8Array(9);
    (window.crypto || {}).getRandomValues?.(rnd);
    id = 'pad-' + Array.from(rnd, (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);
  }
  storageSet(ID_KEY, id);            // (also moves an id found under the legacy key)
  return id;
}
const clientId = getClientId();

// ---------------------------------------------------------------- state

const state = {
  phase: 'boot',            // 'insecure' | 'code' | 'gate' | 'live'
  room: null,
  gatePassed: false,
  socketConnected: false,
  joined: false,            // our pad:hello was accepted and this socket drives our slot
  everJoined: false,
  hostPresent: false,       // the desktop is in the room
  kicked: false,            // this controller was opened again elsewhere
  full: false,              // 5th phone: every slot is taken
  serverMissing: false,
  roomError: '',
  slot: null,               // our player slot 1..4
  color: '#8890b5',         // our slot color
  hostSlot: null,           // the player host (lowest connected slot)
  shared: null,             // last host:state (shared by every phone)
  mine: null,               // last host:padState (ours only)
  steerSource: 'none',      // 'orientation' | 'motion' | 'touch' | 'none'
  forceTouch: false,
  permissionDenied: false,
  connectErrors: 0,         // failed (re)connect attempts in a row
  pageVisible: document.visibilityState !== 'hidden',
  cssRot: 0,                // CSS rotation applied to the stage (0 | 90 | -90)
  calib: 0,                 // steering center θ₀ (degrees)
  buttons: { gas: false, brake: false, drift: false, item: false },
  itemSeq: 0,
  pauseSeq: 0,
  sheetOpen: false,
  rttMs: null,
  sent: 0,
};

// Steering pipeline values
const grav = { x: 0, y: 0, z: 1 };   // world-up in device coordinates (unit)
const scr = { x: 0, y: 0 };          // scratch: up in a screen frame
let gravValid = false;
let gravAt = -1e9;
let rawAngleDeg = 0;                 // θ before calibration
let steerTarget = 0;
let steer = 0;                       // filtered value that is sent
let lastOrientationAt = -1e9;
let lastMotionAt = -1e9;
let orientationEvents = 0;
let motionEvents = 0;
let motionSign = /iPad|iPhone|iPod/.test(navigator.userAgent) ? -1 : 1;   // legacy iOS reports inverted gravity
const motionEvidence = { sum: 0, n: 0 };
const touchSteer = { pointerId: null, value: 0 };

// Layout / orientation
const layout = { w: 0, h: 0, portrait: false };
let rotSide = 90;                    // CSS rotation used while the layout is portrait
let rotPendingSince = 0;
let osFlip = false;                  // corrects a browser reporting the opposite landscape angle
let flipPendingSince = 0;
let flipVerified = false;
let saneSince = 0;
let holdingUpright = false;
let uprightSince = 0;                // when holdingUpright last became true
// Pose of a portrait-laid-out phone: held upright (true) or sideways like a
// wheel (false). Menus held upright drop the CSS rotation and use the natural
// portrait layout. Unknown (no sensor data) counts as upright.
let poseUpright = true;
let poseKnown = false;
let posePendingSince = 0;

// ---------------------------------------------------------------- steering math (pure)

// World-up vector in device coordinates from W3C deviceorientation β, γ (deg).
function upFromOrientation(betaDeg, gammaDeg, out) {
  const b = betaDeg * DEG;
  const g = gammaDeg * DEG;
  const cb = Math.cos(b);
  out.x = -Math.sin(g) * cb;
  out.y = Math.sin(b);
  out.z = Math.cos(g) * cb;
  return out;
}

// Rotates the device-frame vector into a screen frame rotated by aDeg.
function toScreen(up, aDeg, out) {
  const a = aDeg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  out.x = up.x * c - up.y * s;
  out.y = up.x * s + up.y * c;
  return out;
}

const smooth01 = (x) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };

// Steering angle θ (degrees, clockwise like a wheel = positive) from world-up
// (ux, uy) in the UI frame. Held like a wheel, θ is the true in-plane wheel
// angle atan2(−ux, uy): it does not depend on how far the screen is tilted
// back, and pitching the phone while holding a turn does not change it. Lying
// (nearly) flat there is hardly any in-plane gravity and that angle means
// nothing, so θ blends into asin(−ux), the roll of a flat phone, as
// m = hypot(ux, uy) falls from WHEEL_M1 to WHEEL_M0. It also fades to asin as
// the wheel nears ±90° (uy → 0), so it can never wrap around.
function angleFromScreenUp(ux, uy) {
  const flat = Math.asin(clamp(-ux, -1, 1));
  const m = Math.hypot(ux, uy);
  if (m <= WHEEL_M0 || uy <= 0) return flat * RAD2DEG;
  const w = smooth01((m - WHEEL_M0) / (WHEEL_M1 - WHEEL_M0)) * smooth01(uy / (m * 0.25));
  return (w * Math.atan2(-ux, uy) + (1 - w) * flat) * RAD2DEG;
}

function rawAngleFromUp(up, aDeg) {
  const a = aDeg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return angleFromScreenUp(up.x * c - up.y * s, up.x * s + up.y * c);
}

// Dead zone + expo centre + soft knee into a hard steering lock (SPEC §15.1,
// notes/research-v4-steering.md §3). deg is already calibrated (and inverted).
// u = (|θ| − dead zone) / (lock − dead zone). Up to the knee (u 0.7, 30.3° at
// the 42° default) it is the v3 expo curve, so small and medium adjustments
// feel the same; above it a cubic Hermite eases from the knee's value and
// slope to STEER_CAP with zero slope at the lock, and tilting further adds
// nothing — like a real wheel's end stop. C¹ and monotone.
function shapeSteer(deg, lockDeg) {
  const mag = Math.abs(deg);
  if (mag <= DEAD_ZONE_DEG) return 0;
  const u = Math.min(1, (mag - DEAD_ZONE_DEG) / Math.max(1, lockDeg - DEAD_ZONE_DEG));
  let x;
  if (u <= STEER_KNEE) x = (1 - EXPO) * u + EXPO * u * u * u;
  else {
    const h = 1 - STEER_KNEE, t = (u - STEER_KNEE) / h, t2 = t * t, t3 = t2 * t;
    const p0 = (1 - EXPO) * STEER_KNEE + EXPO * STEER_KNEE * STEER_KNEE * STEER_KNEE;   // 0.5037
    const m0 = ((1 - EXPO) + 3 * EXPO * STEER_KNEE * STEER_KNEE) * h;                 // 0.3776
    x = p0 * (2 * t3 - 3 * t2 + 1) + m0 * (t3 - 2 * t2 + t) + STEER_CAP * (3 * t2 - 2 * t3);
  }
  return deg < 0 ? -x : x;
}

function steerFromAngle(thetaDeg) {
  let d = thetaDeg - state.calib;
  if (settings.invert) d = -d;
  return shapeSteer(d, settings.lockDeg);
}

// ---------------------------------------------------------------- orientation angle

function reportedOsAngle() {
  const so = window.screen && window.screen.orientation;
  let a = null;
  if (so && typeof so.angle === 'number') a = so.angle;
  else if (typeof window.orientation === 'number') a = window.orientation;
  return a === null ? null : ((Math.round(a) % 360) + 360) % 360;
}

// Angle of the page layout relative to the device's natural orientation.
function osAngle() {
  let a = reportedOsAngle();
  if (a === null) a = layout.portrait ? 0 : 90;
  if (!layout.portrait && osFlip) a = (a + 180) % 360;
  return a;
}

// Effective rotation of the visible UI relative to the device.
function uiAngle() {
  return (osAngle() + state.cssRot + 360) % 360;
}

// The OS only lays a page out landscape when gravity says so, so in landscape
// the screen's "up" must point roughly up. If it consistently points down, the
// browser reports the opposite landscape angle (seen on some WebKit builds):
// flip our interpretation. Quick on the first samples, slow afterwards.
function checkAngleSanity(now) {
  if (layout.portrait) { flipPendingSince = 0; return; }
  toScreen(grav, uiAngle(), scr);
  if (Math.hypot(scr.x, scr.y) < 0.6) { flipPendingSince = 0; return; }
  if (scr.y < -0.55) {
    if (!flipPendingSince) flipPendingSince = now;
    else if (now - flipPendingSince > (flipVerified ? FLIP_HOLD_MS : FLIP_HOLD_FIRST_MS)) {
      osFlip = !osFlip;
      flipPendingSince = 0;
      flipVerified = true;
      rawAngleDeg = rawAngleFromUp(grav, uiAngle());
    }
  } else {
    flipPendingSince = 0;
    if (scr.y > 0.4) {
      if (!saneSince) saneSince = now;
      if (!flipVerified && now - saneSince > 1000) flipVerified = true;
    }
  }
}

// Portrait layout: rotate the stage toward the side gravity says is up, with
// hysteresis (must clearly cross to the other side, for ROT_HOLD_MS). Also
// tracks whether the phone is held upright or sideways (poseUpright: menus
// held upright use the natural layout).
function updateRotation(now) {
  if (!layout.portrait || !gravValid || now - gravAt > 1000) {
    rotPendingSince = 0;
    posePendingSince = 0;
    holdingUpright = false;
    return;
  }
  toScreen(grav, osAngle(), scr);
  const upright = Math.abs(scr.y) > 0.75 && Math.abs(scr.x) < 0.45;
  if (upright && !holdingUpright) uprightSince = now;
  holdingUpright = upright;
  const want = scr.x > ROT_SWITCH ? 90 : scr.x < -ROT_SWITCH ? -90 : 0;
  if (!poseKnown) {
    // First sample: adopt the pose at once, so a menu shown right away never
    // flashes the wrong layout.
    poseKnown = true;
    if (want) { rotSide = want; poseUpright = false; } else if (upright) poseUpright = scr.y > 0;
  }
  if (want && (want !== rotSide || poseUpright)) {
    if (!rotPendingSince) rotPendingSince = now;
    else if (now - rotPendingSince >= ROT_HOLD_MS) {
      rotSide = want;
      poseUpright = false;
      rotPendingSince = 0;
    }
  } else {
    rotPendingSince = 0;
  }
  if (upright && scr.y > 0 && !poseUpright) {
    if (!posePendingSince) posePendingSince = now;
    else if (now - posePendingSince >= POSE_HOLD_MS) {
      poseUpright = true;
      posePendingSince = 0;
    }
  } else {
    posePendingSince = 0;
  }
  const rot = desiredRot();
  // A flip to the other side animates; dropping / adding the rotation (the
  // stage changes shape) is instant.
  if (rot !== state.cssRot) applyLayout(!(rot && state.cssRot));
}

// The CSS rotation the stage should have now (0 | 90 | -90).
function desiredRot() {
  if (!layout.portrait) return 0;
  if (poseUpright && naturalLayoutScreen()) return 0;
  return rotSide;
}
const naturalLayoutScreen = () => MENU_SCREENS.has(shownScreen);

// ---------------------------------------------------------------- DOM

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'),
  connDot: $('conn-dot'), roomLabel: $('room-label'), pingLabel: $('ping-label'), meTag: $('me-tag'), meTagText: $('me-tag-text'),
  place: $('place'), placeNum: $('place-num'), placeSuf: $('place-suf'), placeOf: $('place-of'),
  lapNum: $('lap-num'), lapTotal: $('lap-total'), coins: $('coins'), coinsNum: $('coins-num'),
  insecureLink: $('insecure-link'),
  codeSlots: $('code-slots'), codeError: $('code-error'), keypad: $('keypad'), codeJoin: $('btn-code-join'),
  gatePerm: $('gate-perm'), gateStatus: $('gate-status'), gateStatusText: $('gate-status-text'),
  connectingTitle: $('connecting-title'), connectingSub: $('connecting-sub'),
  // lobby
  yaTag: $('ya-tag'), lobRole: $('lob-role'), lobSlots: $('lob-slots'), lobSettings: $('lob-settings'), lobWait: $('lob-wait'),
  segMode: $('seg-mode'), segCc: $('seg-cc'), segItems: $('seg-items'),
  // select
  charRows: $('char-rows'), ciName: $('ci-name'), ciClass: $('ci-class'), ciFull: $('ci-full'), ciQuote: $('ci-quote'), ciStats: $('ci-stats'),
  ciBack: $('ci-back'),
  bodyGrid: $('body-grid'), biName: $('bi-name'), biDesc: $('bi-desc'), biStats: $('bi-stats'),
  wheelsGrid: $('wheels-grid'), wiName: $('wi-name'), wiDesc: $('wi-desc'), wiStats: $('wi-stats'),
  rdArt: $('rd-art'), rdName: $('rd-name'), rdParts: $('rd-parts'), rdStats: $('rd-stats'), tgAssist: $('tg-assist'), tgAutoGas: $('tg-autogas'),
  wlList: $('wl-list'), wlNote: $('wl-note'),
  // track
  tkTitle: $('tk-title'), tkSub: $('tk-sub'), tkCards: $('tk-cards'), tkName: $('tk-name'), tkDesc: $('tk-desc'), tkPreview: $('tk-preview'),
  twTitle: $('tw-title'), twSub: $('tw-sub'), ldTitle: $('ld-title'),
  // race
  btnItem: $('btn-item'), itemIcon: $('item-icon'), itemCount: $('item-count'),
  wheel: $('wheel'), wheelLogo: $('wheel-logo'), countdown: $('countdown'), finish: $('finish-banner'), assistPip: $('assist-pip'),
  tmLeft: $('tm-left'), tmRight: $('tm-right'), tiltMeter: $('tilt-meter'), wheelWrap: $('wheel-wrap'),
  raceWarn: $('race-warn'), raceWarnText: $('race-warn-text'),
  tsTrack: $('ts-track'), tsKnob: $('ts-knob'), steerMode: $('steer-mode'),
  pausedBy: $('paused-by'),
  // results / standings / podium
  resSub: $('res-sub'), resList: $('res-list'), resMe: $('res-me'),
  stdSub: $('std-sub'), stdList: $('std-list'), stdMe: $('std-me'), stdNext: $('std-next'),
  podTitle: $('pod-title'), podBlocks: $('pod-blocks'), podMe: $('pod-me'),
  // overlays / sheet
  ovWaiting: $('ov-waiting'), ovKicked: $('ov-kicked'),
  hintRotate: $('hint-rotate'), bannerOffline: $('banner-offline'), offlineText: $('offline-text'),
  sheet: $('sheet'), sheetBody: $('sheet-body'), sens: $('sens'), sensVal: $('sens-val'), modeSeg: $('mode-seg'),
  tiltNote: $('tilt-note'),
  setAssist: $('set-assist'), setAutoGas: $('set-autogas'), setInvert: $('set-invert'), setHaptics: $('set-haptics'), dbg: $('dbg'),
  toast: $('toast'), flash: $('flash'),
};
const hostWaits = document.querySelectorAll('.host-wait');
const screens = {};
for (const sec of document.querySelectorAll('.screen')) screens[sec.id.replace(/^scr-/, '')] = sec;

function setText(node, text) {
  if (node._text !== text) { node._text = text; node.textContent = text; }
}
function toggle(node, cls, on) {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
}
function setVar(node, name, value) {
  const key = `_v${name}`;
  if (node[key] !== value) { node[key] = value; node.style.setProperty(name, value); }
}
// Scrollable lists get .more (bottom fade) while rows are hidden below.
function updateScrollHint(node) {
  toggle(node, 'more', node.scrollTop + node.clientHeight < node.scrollHeight - 2);
}
const scrollLists = () => [el.charRows, el.resList, el.stdList, el.sheetBody];
function refreshScrollHints() {
  requestAnimationFrame(() => { for (const list of scrollLists()) updateScrollHint(list); });
}

// ---------------------------------------------------------------- layout

let trackHalf = 0;   // touch slider travel (px, unrotated), measured lazily

function applyLayout(instant) {
  const vv = window.visualViewport;
  const useVV = !!(vv && vv.width && vv.height);
  const W = Math.round(useVV ? vv.width : window.innerWidth);
  const H = Math.round(useVV ? vv.height : window.innerHeight);
  layout.w = W;
  layout.h = H;
  layout.portrait = H > W;
  const rot = desiredRot();
  const sw = rot ? H : W;
  const sh = rot ? W : H;
  const st = el.stage.style;
  if (instant) el.stage.classList.add('no-anim');
  st.setProperty('--sw', `${sw}px`);
  st.setProperty('--sh', `${sh}px`);
  st.setProperty('--vw', `${(sw / 100).toFixed(3)}px`);
  // 1% of the stage's short side, so a portrait-shaped stage (menus held
  // upright) keeps the landscape layout's proportions.
  st.setProperty('--vh', `${(Math.min(sw, sh) / 100).toFixed(3)}px`);
  st.setProperty('--rot', `${rot}deg`);
  toggle(el.stage, 'rot-cw', rot === 90);
  toggle(el.stage, 'rot-ccw', rot === -90);
  toggle(el.stage, 'tall', sh > sw);         // portrait-shaped stage (menus held upright)
  toggle(el.stage, 'narrow', sw < 600);      // small phone (e.g. portrait-locked SE): compact menus
  toggle(el.stage, 'compact', sw < 720);     // small landscape phone (e.g. SE 667×375)
  toggle(el.stage, 'short', sh > sw && sh < 700);   // short upright phone (SE 375×667)
  state.cssRot = rot;
  trackHalf = 0;
  if (instant) requestAnimationFrame(() => requestAnimationFrame(() => el.stage.classList.remove('no-anim')));
  if (gravValid) rawAngleDeg = rawAngleFromUp(grav, uiAngle());
}

// ---------------------------------------------------------------- sensors

function onGravitySample(now) {
  gravValid = true;
  gravAt = now;
  checkAngleSanity(now);
  rawAngleDeg = rawAngleFromUp(grav, uiAngle());
}

function onDeviceOrientation(e) {
  const b = e.beta;
  const g = e.gamma;
  if (b == null || g == null || !Number.isFinite(b) || !Number.isFinite(g)) return;
  const now = performance.now();
  lastOrientationAt = now;
  orientationEvents++;
  upFromOrientation(b, g, grav);
  onGravitySample(now);
  if (state.gatePassed && tiltWanted() && state.steerSource !== 'orientation') setSource('orientation');
}

function onDeviceMotion(e) {
  const acc = e.accelerationIncludingGravity;
  if (!acc || acc.x == null || acc.y == null || acc.z == null) return;
  const x = Number(acc.x), y = Number(acc.y), z = Number(acc.z);
  const len = Math.hypot(x, y, z);
  if (!Number.isFinite(len) || len < 4 || len > 20) return;   // free fall / hard shake / junk
  const now = performance.now();
  lastMotionAt = now;
  motionEvents++;
  if (now - lastOrientationAt < 400) return;                 // orientation events win
  // Spec: the vector points UP (+9.8 z when lying face up). Legacy iOS reports
  // it inverted. Evidence: the screen faces the player, so up·z should be > 0.
  const nz = z / len;
  if (motionEvidence.n < 20 && Math.abs(nz) > 0.3) {
    motionEvidence.sum += nz * motionSign;
    motionEvidence.n++;
    if (motionEvidence.n === 20 && motionEvidence.sum / 20 < -0.25) motionSign = -motionSign;
  }
  const k = 0.45;   // light smoothing: this signal includes hand jerks
  grav.x += (motionSign * x / len - grav.x) * k;
  grav.y += (motionSign * y / len - grav.y) * k;
  grav.z += (motionSign * z / len - grav.z) * k;
  onGravitySample(now);
  if (state.gatePassed && tiltWanted() && state.steerSource !== 'orientation' && state.steerSource !== 'motion') setSource('motion');
}

const tiltWanted = () => settings.steerMode === 'tilt' && !state.forceTouch;

function setSource(src) {
  if (state.steerSource === src) return;
  state.steerSource = src;
  el.stage.dataset.steer = src;
  renderSteerMode();
  touchSteer.value = 0;
  touchSteer.pointerId = null;
  trackHalf = 0;
}

function renderSteerMode() {
  const src = state.steerSource;
  const blocked = state.permissionDenied && settings.steerMode === 'tilt';
  toggle(el.stage, 'tilt-blocked', blocked);
  setText(el.steerMode, src === 'touch' ? (blocked ? 'TILT BLOCKED (SEE ⚙) · DRAG TO STEER' : 'DRAG THE KNOB TO STEER') : src === 'none' ? '' : 'TILT TO STEER');
}

// iOS remembers a denied motion permission for this address until Safari is
// relaunched, so say how to get tilt back — on the race screen and in settings.
function setPermissionDenied(denied) {
  state.permissionDenied = denied;
  el.tiltNote.hidden = !denied;
  renderSteerMode();
}

// Asks for motion access (iOS 13+). Must run synchronously inside a user
// gesture. Resolves 'granted' | 'denied' | 'unsupported'.
function askMotionPermission() {
  const asks = [];
  for (const C of [window.DeviceOrientationEvent, window.DeviceMotionEvent]) {
    if (C && typeof C.requestPermission === 'function') {
      try { asks.push(C.requestPermission().catch(() => 'denied')); } catch { asks.push(Promise.resolve('denied')); }
    }
  }
  if (!asks.length) return Promise.resolve('unsupported');
  return Promise.all(asks).then((res) => (res.includes('granted') ? 'granted' : 'denied'));
}

// TILT mode / "Enable tilt" button: ask again (inside the tap), then re-pick the source.
function enableTilt() {
  settings.steerMode = 'tilt';
  state.forceTouch = false;
  saveSettings();
  syncSettingsUI();
  const ask = needsMotionPermission() ? askMotionPermission() : Promise.resolve('unsupported');
  ask.then((r) => {
    if (r !== 'unsupported') setPermissionDenied(r === 'denied');
    if (state.gatePassed) armSensorCheck();
  });
}

let sensorTimer = null;
// Picks the steering source shortly after the gate (or a settings change).
function armSensorCheck() {
  clearTimeout(sensorTimer);
  if (!tiltWanted()) { setSource('touch'); return; }
  const now = performance.now();
  if (now - lastOrientationAt < 300) setSource('orientation');
  sensorTimer = setTimeout(() => {
    const t = performance.now();
    if (!tiltWanted()) return;
    if (t - lastOrientationAt < SENSOR_TIMEOUT_MS) setSource('orientation');
    else if (t - lastMotionAt < SENSOR_TIMEOUT_MS) setSource('motion');
    else {
      setSource('touch');
      toast(state.permissionDenied ? 'Motion access blocked — drag to steer (⚙ explains how to fix it)' : 'No tilt sensor found — drag to steer', 3200);
    }
  }, SENSOR_TIMEOUT_MS);
}

function center(silent = false) {
  if (gravValid && performance.now() - gravAt < 1500) {
    state.calib = clamp(rawAngleDeg, -CALIB_LIMIT_DEG, CALIB_LIMIT_DEG);
  }
  if (!silent) { toast('Steering centered'); haptic(25); }
}

// At the start of each countdown: re-center if the phone is held roughly level.
function autoCenter() {
  if (state.steerSource !== 'orientation' && state.steerSource !== 'motion') return;
  if (!gravValid || performance.now() - gravAt > 1000) return;
  if (Math.abs(rawAngleDeg) > AUTO_CENTER_LIMIT_DEG) return;
  state.calib = rawAngleDeg;
  toast('Wheel centered — get ready!', 1400);
}

// ---------------------------------------------------------------- touch slider

// Pointer offset from the center of `node` along the stage's x axis, which
// the CSS rotation turns sideways on screen.
function stageAxisOffset(e, node) {
  const r = node.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  if (state.cssRot === 90) return e.clientY - cy;
  if (state.cssRot === -90) return cy - e.clientY;
  return e.clientX - cx;
}
const touchLocalOffset = (e) => stageAxisOffset(e, el.tsTrack);

function measureTrack() {
  if (!trackHalf) trackHalf = Math.max(20, (el.tsTrack.offsetWidth - el.tsKnob.offsetWidth) / 2);
  return trackHalf;
}

function onTrackPointer(e) {
  switch (e.type) {
    case 'pointerdown':
      if (state.steerSource !== 'touch' || touchSteer.pointerId !== null) return;
      e.preventDefault();
      try { el.tsTrack.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      touchSteer.pointerId = e.pointerId;
      touchSteer.value = clamp(touchLocalOffset(e) / measureTrack(), -1, 1);
      break;
    case 'pointermove':
      if (e.pointerId !== touchSteer.pointerId) return;
      touchSteer.value = clamp(touchLocalOffset(e) / measureTrack(), -1, 1);
      break;
    default:   // pointerup / pointercancel / lostpointercapture
      if (e.pointerId !== touchSteer.pointerId) return;
      touchSteer.pointerId = null;
      touchSteer.value = 0;
  }
}

// ---------------------------------------------------------------- buttons

function haptic(pattern) {
  if (!settings.haptics || typeof navigator.vibrate !== 'function') return;
  // Before the first tap (e.g. the desktop's welcome buzz on join) Chrome blocks
  // the call and logs an error: skip it quietly instead.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try { navigator.vibrate(pattern); } catch { /* not allowed yet */ }
}

// A press-and-hold button driven by Pointer Events. Tracks its own pointer
// ids so several fingers on different buttons never interfere.
class HoldButton {
  constructor(node, { onPress = null, onRelease = null, buzz = 10 } = {}) {
    this.node = node;
    this.onPress = onPress;
    this.onRelease = onRelease;
    this.buzz = buzz;
    this.pointers = new Set();
    this.down = false;
    for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'contextmenu']) {
      node.addEventListener(t, this, { passive: false });
    }
  }

  handleEvent(e) {
    switch (e.type) {
      case 'pointerdown':
        if (e.button > 0) return;
        e.preventDefault();
        try { this.node.setPointerCapture(e.pointerId); } catch { /* implicit capture on touch */ }
        this.pointers.add(e.pointerId);
        if (!this.down) this._press();
        break;
      case 'pointerup':
      case 'pointercancel':
      case 'lostpointercapture':
        if (this.pointers.delete(e.pointerId) && this.pointers.size === 0 && this.down) this._release();
        break;
      case 'contextmenu':
        e.preventDefault();
        break;
    }
  }

  _press() {
    this.down = true;
    this.node.classList.add('pressed');
    if (this.buzz) haptic(this.buzz);
    this.onPress?.();
  }

  _release() {
    this.down = false;
    this.node.classList.remove('pressed');
    this.onRelease?.();
  }

  reset() {
    this.pointers.clear();
    if (this.down) this._release();
  }
}

const holdButtons = [];
function holdButton(id, opts) {
  const b = new HoldButton($(id), opts);
  holdButtons.push(b);
  return b;
}

function setButton(name, on) {
  if (state.buttons[name] === on) return;
  state.buttons[name] = on;
  sendInput(false);
}

function releaseAll() {
  for (const b of holdButtons) b.reset();
  touchSteer.pointerId = null;
  touchSteer.value = 0;
}

// Is the phone the controller right now (rather than lying next to a keyboard)?
let lastTouchAt = -1e9;
function padInUse(now) {
  return settings.autoGas || touchSteer.pointerId !== null || holdButtons.some((b) => b.down) || now - lastTouchAt < IN_USE_MS;
}

// Our race view (padState.race) while the shared screen is the race.
const myRace = () => (state.mine && state.mine.race && typeof state.mine.race === 'object' ? state.mine.race : null);
const isRaceScreen = () => !!state.shared && state.shared.screen === 'race' && !!myRace();

function raceInProgress() {
  const r = isRaceScreen() ? myRace() : null;
  return !!r && !r.finished && LIVE_RACE_STATES.has(r.state);
}

// Connected human players (from the shared state; at least us).
function connectedPlayers() {
  const list = state.shared && Array.isArray(state.shared.players) ? state.shared.players : [];
  let n = 0;
  for (const p of list) if (p && p.connected) n++;
  return Math.max(1, n);
}

// Page hidden (screen lock, app switch, incoming call, tab closed): never
// leave anything held. In a solo race also pause right away instead of
// letting it run on until the socket times out; with more players the
// desktop sees our silent stream and lets a CPU drive this kart (SPEC §14.5).
// pad:menu 'pause' only ever pauses (a pauseSeq press would toggle).
function onPageHidden() {
  if (!state.pageVisible) return;
  state.pageVisible = false;
  if (raceInProgress() && padInUse(performance.now()) && connectedPlayers() <= 1 && socket && socket.connected && state.joined) {
    socket.emit('pad:menu', { action: 'pause', reason: 'hidden' });
  }
  releaseAll();
  sendInput(false);                  // zeros: nothing stays held while we are away
}

function onPageVisible() {
  if (state.pageVisible) return;
  state.pageVisible = true;
  nextSendAt = 0;
  if (state.gatePassed) requestWakeLock();
  if (socket && !socket.connected) socket.connect();
}

// ---------------------------------------------------------------- input sending

const volatileInput = { s: 0, g: 0, b: 0, d: 0, i: 0, p: 0, t: 0 };
const edgeInput = { s: 0, g: 0, b: 0, d: 0, i: 0, p: 0, t: 0 };
const SEND_SLACK_MS = 4;             // a tick this early still sends (timer jitter)
let nextSendAt = 0;                  // next steady-state (volatile) sample
let sendOnDrain = false;             // a sample was due while the transport was busy
let watchedEngine = null;
let sendWindowStart = 0;
let sendsInWindow = 0;
let sendRate = 0;

function countdownRemaining(now) {
  if (!(countdownBase.value > 0) || !countdownBase.at) return Infinity;
  return countdownBase.value - (now - countdownBase.at) / 1000;
}

// Auto-gas: hold the throttle unless braking. During the countdown it waits
// until the middle of the start-boost window, so it never stalls the engine.
function autoGasActive(now) {
  if (!settings.autoGas || state.buttons.brake || !state.pageVisible) return false;
  const rs = myRace()?.state;
  if (rs === 'intro') return false;
  if (rs === 'countdown') return countdownRemaining(now) <= START_PRESS_LEAD;
  return true;
}

function fillInput(out) {
  const now = performance.now();
  const active = isRaceScreen() && !state.sheetOpen && state.hostPresent && state.pageVisible;
  const b = state.buttons;
  out.s = state.pageVisible ? Math.round(steer * 1000) / 1000 : 0;
  out.g = active && (b.gas || autoGasActive(now)) ? 1 : 0;
  out.b = active && b.brake ? 1 : 0;
  out.d = active && b.drift ? 1 : 0;
  out.i = state.itemSeq;
  out.p = state.pauseSeq;
  out.t = Date.now();
  return out;
}

// volatile = steady-state sample (may be dropped); otherwise a reliable edge.
// (Both reuse one object: Socket.IO serializes an emit synchronously.)
function sendInput(volatile) {
  if (!socket || !socket.connected || !state.joined) return;
  if (volatile) {
    const tr = socket.io.engine && socket.io.engine.transport;
    // A stalled WebSocket queues samples in the browser; they would only
    // arrive late, in one burst. Skip until it has drained.
    if (tr && tr.ws && tr.ws.bufferedAmount > 0) return;
    // Busy transport (HTTP long-polling has one POST in flight at a time):
    // Socket.IO would drop a volatile sample, so send a fresh one the moment
    // it is writable again (engine 'drain', see watchEngine).
    if (tr && !tr.writable) { sendOnDrain = true; return; }
    socket.volatile.emit('pad:input', fillInput(volatileInput));
  } else {
    socket.emit('pad:input', fillInput(edgeInput));
  }
  const now = performance.now();
  state.sent++;
  sendsInWindow++;
  if (now - sendWindowStart >= 1000) {
    sendRate = Math.round((sendsInWindow * 1000) / (now - sendWindowStart));
    sendWindowStart = now;
    sendsInWindow = 0;
  }
}

// ---------------------------------------------------------------- main tick (60 Hz)

let lastTickAt = performance.now();

function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, Math.max(0, (now - lastTickAt) / 1000));
  lastTickAt = now;

  const src = state.steerSource;
  let rate = STEER_LPF_RATE;
  if (src === 'orientation' || src === 'motion') {
    const last = src === 'orientation' ? lastOrientationAt : lastMotionAt;
    steerTarget = now - last < SENSOR_STALE_MS ? steerFromAngle(rawAngleDeg) : 0;
  } else if (src === 'touch') {
    const v = touchSteer.value;
    steerTarget = Math.sign(v) * ((1 - TOUCH_EXPO) * Math.abs(v) + TOUCH_EXPO * Math.abs(v) ** 3);
    rate = TOUCH_LPF_RATE;
  } else {
    steerTarget = 0;
  }
  steer = damp(steer, steerTarget, rate, dt);
  if (Math.abs(steer) < 0.0005) steer = 0;

  updateRotation(now);

  if (state.pageVisible && state.joined && socket && socket.connected) {
    const interval = isRaceScreen() ? 1000 / NET.padInputHz : KEEPALIVE_MS;
    if (now >= nextSendAt - SEND_SLACK_MS) {
      sendInput(true);
      // Steady cadence despite timer jitter; no catch-up burst after a stall.
      nextSendAt = Math.max(nextSendAt + interval, now - interval / 2);
    }
  }
}

// ---------------------------------------------------------------- visuals (rAF)

let shownScreen = null;
let lastWheelDeg = NaN;
let lastMeterL = -1;
let lastMeterR = -1;
let lastKnobPx = NaN;
let cdText = null;
let lastDbgAt = 0;
let lastHintOn = null;

// Steering lock feedback (SPEC §15.1): the wheel graphic and the tilt meter
// reach their end stop at the lock (STEER_CAP), the meter lights up while the
// tilt is at/past it, and entering the lock gives a short buzz (Android; iOS
// has no vibrate API).
const LOCK_ON = 0.995;               // |steer target| / STEER_CAP at which the lock lights …
const LOCK_OFF = 0.96;               // … and this below which it goes out again (hysteresis)
const LOCK_BUZZ_MS = 15;
const LOCK_BUZZ_GAP_MS = 450;        // at most one lock buzz this often
let atLock = false;
let lockBuzzAt = -1e9;

function updateLock(now) {
  const tilt = state.steerSource === 'orientation' || state.steerSource === 'motion';
  const m = tilt ? Math.abs(steerTarget) / STEER_CAP : 0;
  const on = atLock ? m >= LOCK_OFF : m >= LOCK_ON;
  if (on === atLock) return;
  atLock = on;
  toggle(el.tiltMeter, 'at-lock', on);
  toggle(el.wheelWrap, 'at-lock', on);
  if (on && now - lockBuzzAt > LOCK_BUZZ_GAP_MS) {
    const r = myRace();
    if (r && r.state === 'racing' && !r.finished) { lockBuzzAt = now; haptic(LOCK_BUZZ_MS); }
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  if (shownScreen === 'race') {
    // the wheel's travel ends at the steering lock (touch slider: at full steer)
    const norm = state.steerSource === 'touch' ? 1 : STEER_CAP;
    const sv = clamp(steer / norm, -1, 1);
    const deg = Math.round(sv * WHEEL_VISUAL_DEG * 10) / 10;
    if (deg !== lastWheelDeg) { el.wheel.style.transform = `rotate(${deg}deg)`; lastWheelDeg = deg; }
    const l = Math.round(Math.max(0, -sv) * 500) / 500;
    const r = Math.round(Math.max(0, sv) * 500) / 500;
    if (l !== lastMeterL) { el.tmLeft.style.transform = `scaleX(${l})`; lastMeterL = l; }
    if (r !== lastMeterR) { el.tmRight.style.transform = `scaleX(${r})`; lastMeterR = r; }
    if (state.steerSource === 'touch') {
      const px = Math.round(steer * measureTrack() * 10) / 10;
      if (px !== lastKnobPx) { el.tsKnob.style.transform = `translateX(${px}px)`; lastKnobPx = px; }
    }
    updateLock(now);
    updateCountdown(now);
    updateWarn(now);
  } else {
    if (atLock) {
      atLock = false;
      toggle(el.tiltMeter, 'at-lock', false);
      toggle(el.wheelWrap, 'at-lock', false);
    }
    if (warn.kind || warn.splash) updateWarn(now);   // no race any more: clears the alerts
  }
  if (state.sheetOpen && now - lastDbgAt > 125) { lastDbgAt = now; updateDebug(now); }
  // Held upright in portrait for a moment (not just a hard over-steer) while
  // the UI is rotated (upright menus are not): the race wants it sideways.
  const hint = layout.portrait && holdingUpright && now - uprightSince > HINT_DELAY_MS && state.phase !== 'boot' && state.cssRot !== 0;
  if (hint !== lastHintOn) { lastHintOn = hint; toggle(el.hintRotate, 'show', hint); }
}

// Countdown overlay: extrapolates the host's countdown between updates.
const countdownBase = { value: 0, at: 0 };
let goShownAt = -1e9;
let prevRaceState = null;

function updateCountdown(now) {
  const r = myRace();
  let text = '';
  let cls = '';
  if (r) {
    if (r.state === 'intro') { text = 'GET READY'; cls = 'small'; }
    else if (r.state === 'countdown') {
      const rem = countdownRemaining(now);
      if (rem !== Infinity) text = String(clamp(Math.ceil(rem), 1, 3));
    } else if (r.state === 'racing' && now - goShownAt < 900) { text = 'GO!'; cls = 'go'; }
  }
  const key = text + '|' + cls;
  if (key === cdText) return;
  cdText = key;
  el.countdown.textContent = text;
  el.countdown.className = 'countdown';
  if (text) {
    void el.countdown.offsetWidth;   // restart the pop animation
    el.countdown.className = `countdown show${cls ? ' ' + cls : ''}`;
    if (cls !== 'small') haptic(text === 'GO!' ? 70 : 30);
  }
}

// Race alerts from host:padState.race (SPEC §15.2): an incoming Capo Crusher
// (`warn: 'capo'`, also `capoWarn: true`) flashes a siren banner and buzzes in
// a rhythm; an Espresso Splash on this player's screen (`splash` > 0) gives a
// short splat buzz; a running Beer Rocket (`beer`) shows AUTOPILOT.
const WARN_BUZZ = [90, 60, 90];
const WARN_REBUZZ_MS = 1000;
const WARN_MAX_BUZZES = 4;
const SPLASH_BUZZ = [40, 30, 110];
const warn = { kind: '', buzzAt: -1e9, buzzes: 0, splash: false };

function raceAlert(r) {
  if (!r || r.finished) return '';
  if (r.warn === 'capo' || r.capoWarn === true) return 'capo';
  if (r.beer === true) return 'beer';
  return '';
}

function updateWarn(now) {
  const r = shownScreen === 'race' ? myRace() : null;
  const kind = raceAlert(r);
  if (kind !== warn.kind) {
    warn.kind = kind;
    warn.buzzes = 0;
    warn.buzzAt = -1e9;
    toggle(el.raceWarn, 'show', !!kind);
    toggle(el.raceWarn, 'capo', kind === 'capo');
    toggle(el.raceWarn, 'beer', kind === 'beer');
    toggle(el.stage, 'capo-warn', kind === 'capo');
    setText(el.raceWarnText, kind === 'capo' ? 'CAPO CRUSHER INCOMING!' : kind === 'beer' ? 'BEER ROCKET · AUTOPILOT' : '');
  }
  if (kind === 'capo' && warn.buzzes < WARN_MAX_BUZZES && now - warn.buzzAt >= WARN_REBUZZ_MS) {
    warn.buzzAt = now;
    warn.buzzes++;
    haptic(WARN_BUZZ);
    flash();
  }
  const splashed = !!r && !r.finished && Number(r.splash) > 0;
  if (splashed && !warn.splash) { haptic(SPLASH_BUZZ); splat(); }
  warn.splash = splashed;
}

// ---------------------------------------------------------------- feedback

let toastTimer = null;
function toast(text, ms = 1800) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function flash() {
  el.flash.classList.remove('on', 'splat');
  void el.flash.offsetWidth;
  el.flash.classList.add('on');
}

// A coffee-brown flash: the espresso landed on this player's screen.
function splat() {
  el.flash.classList.remove('on', 'splat');
  void el.flash.offsetWidth;
  el.flash.classList.add('on', 'splat');
}

// ---------------------------------------------------------------- networking

let socket = null;
let helloTimer = null;
let helloInFlight = false;
let retryUntil = 0;

const validSlot = (v) => (Number.isInteger(v) && v >= 1 && v <= PLAYER_SLOTS.length ? v : null);
const safeColor = (v, def = '#8890b5') => (typeof v === 'string' && CSS_COLOR_RE.test(v) ? v : def);

function connectSocket() {
  if (typeof window.io !== 'function') {
    state.serverMissing = true;
    render();
    return;
  }
  socket = window.io({ reconnectionDelay: 500, reconnectionDelayMax: 2000, timeout: 6000 });
  socket.io.on('open', watchEngine);
  socket.on('connect', () => {
    state.socketConnected = true;
    state.connectErrors = 0;
    watchEngine();
    if (state.room) hello();
    render();
  });
  socket.on('disconnect', (reason) => {
    state.socketConnected = false;
    state.joined = false;
    helloInFlight = false;
    releaseAll();
    render();
    // Socket.IO only auto-reconnects after network-level drops; a disconnect
    // initiated by the server (e.g. it is restarting) needs a manual retry.
    if (reason === 'io server disconnect') setTimeout(() => { if (!socket.connected) socket.connect(); }, 1000);
  });
  // Repeated failures while this page is loaded: the server is gone, or it made
  // a new certificate the phone has not accepted yet (render() then suggests a reload).
  socket.on('connect_error', () => { state.socketConnected = false; state.connectErrors++; render(); });
  socket.on('host:state', onHostState);
  socket.on('host:padState', onPadState);
  socket.on('host:event', onHostEvent);
  socket.on('slot:update', (p) => { if (p && typeof p === 'object') { applySlot(p.slot, p.host, p.color); render(); } });
  socket.on('host:leave', () => { state.hostPresent = false; releaseAll(); render(); });
  socket.on('host:join', () => { state.hostPresent = true; render(); });
  // The same controller (same padId) connected again from another tab: this
  // one stops driving until the player takes it back.
  socket.on('pad:kicked', () => {
    state.kicked = true;
    state.joined = false;
    releaseAll();
    render();
  });
  socket.on('room:closed', () => {
    state.joined = false;
    state.everJoined = false;
    state.shared = null;
    state.mine = null;
    applySlot(null, null, null);
    releaseAll();
    state.roomError = 'That game room closed. Scan the new QR code or type its room code.';
    retryUntil = Date.now() + 120000;
    scheduleHello(3000);
    enterCode(state.room || '');
  });
}

// Each (re)connect gets a new engine: send the pending sample when its
// transport finishes a write.
function watchEngine() {
  const eng = socket && socket.io && socket.io.engine;
  if (!eng || eng === watchedEngine) return;
  watchedEngine = eng;
  eng.on('drain', () => {
    if (!sendOnDrain || eng !== watchedEngine) return;
    sendOnDrain = false;
    if (state.pageVisible && isRaceScreen()) sendInput(true);
  });
}

const transportName = () => (socket && socket.io && socket.io.engine && socket.io.engine.transport ? socket.io.engine.transport.name : 'none');

function scheduleHello(ms) {
  clearTimeout(helloTimer);
  helloTimer = setTimeout(hello, ms);
}

function hello() {
  clearTimeout(helloTimer);
  if (!socket || !socket.connected || !state.room || helloInFlight) return;
  helloInFlight = true;
  const room = state.room;
  socket.timeout(4000).emit('pad:hello', { room, padId: clientId }, (err, res) => {
    helloInFlight = false;
    if (room !== state.room) { hello(); return; }       // code changed meanwhile
    if (err) { scheduleHello(1500); render(); return; }
    if (res && res.ok) onJoined(res);
    else onHelloError(res || {});
  });
}

function onJoined(res) {
  state.joined = true;
  state.everJoined = true;
  state.kicked = false;
  state.full = false;
  state.roomError = '';
  state.hostPresent = !!res.hostConnected;
  applySlot(res.slot, res.host, res.color);
  retryUntil = 0;
  if (state.phase === 'code') state.phase = state.gatePassed ? 'live' : 'gate';
  sendInput(false);
  render();
}

function onHelloError(res) {
  state.joined = false;
  if (res.code === 'rate') { scheduleHello(1200); return; }
  if (res.error === 'full' || res.code === 'full') {
    // Every slot is taken: keep trying, a spot frees up when someone leaves.
    state.full = true;
    scheduleHello(FULL_RETRY_MS);
    render();
    return;
  }
  if (res.code === 'no_room' && state.everJoined) {
    // The game is restarting (server or desktop reload): keep waiting quietly.
    state.hostPresent = false;
    scheduleHello(2000);
    render();
    return;
  }
  state.roomError = res.code === 'no_room'
    ? `Room ${state.room} isn't open. Check the code on the big screen.`
    : res.message || 'Could not join that room.';
  if (res.code === 'no_room') {
    if (!retryUntil) retryUntil = Date.now() + 120000;
    if (Date.now() < retryUntil) scheduleHello(3000);
  }
  enterCode(state.room || '');
}

// Our slot / the player host / our color (hello ack, slot:update).
function applySlot(slot, host, color) {
  const s = validSlot(slot);
  if (s !== state.slot) {
    state.slot = s;
    state.mine = null;                // that state was for another slot
  }
  state.hostSlot = validSlot(host);
  state.color = safeColor(color, s ? slotInfo(s).css : '#8890b5');
  setVar(el.stage, '--me', state.color);
  const tag = s ? `P${s}` : '';
  setText(el.meTagText, tag);
  setText(el.wheelLogo, tag || 'KK');
}

// Player host: the server's word (lowest connected slot), else the desktop's.
const hostSlot = () => state.hostSlot ?? validSlot(state.shared && state.shared.host);
const amHost = () => state.slot !== null && hostSlot() === state.slot;

// Bumped whenever the desktop's character list changes (rebuilds the grid,
// re-renders lists that show portraits).
let rosterKey = '';
let rosterVersion = 0;

function onHostState(s) {
  if (!s || typeof s !== 'object') return;
  const prev = state.shared ? state.shared.screen : null;
  const rk = JSON.stringify(s.characters || null);
  if (rk !== rosterKey) { rosterKey = rk; rosterVersion++; }
  state.shared = s;
  state.hostPresent = true;
  if (s.screen !== prev) onSharedScreen(s.screen);
  render();
}

function onPadState(ps) {
  if (!ps || typeof ps !== 'object' || (state.slot !== null && ps.slot !== state.slot)) return;
  state.mine = ps;
  const r = myRace();
  const rs = r ? r.state : null;
  const now = performance.now();
  if (rs === 'countdown') {
    const v = Number(r.countdown) || 0;
    if (v !== countdownBase.value || prevRaceState !== 'countdown') { countdownBase.value = v; countdownBase.at = now; }
  }
  if (rs === 'countdown' && prevRaceState !== 'countdown' && state.shared && state.shared.screen === 'race') autoCenter();
  if (rs === 'racing' && prevRaceState === 'countdown') goShownAt = now;
  prevRaceState = rs;
  syncAssist(now, false);
  render();
}

function onHostEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'vibrate' && Array.isArray(ev.pattern)) { haptic(ev.pattern); flash(); }
  else if (ev.type === 'toast' && typeof ev.text === 'string') toast(ev.text);
}

// The same button pressed twice within this window sends once (double taps).
const MENU_DEBOUNCE_MS = 350;
let lastMenuKey = '';
let lastMenuAt = -1e9;

function sendMenu(action, extra = null, buzz = true) {
  if (!socket || !socket.connected || !state.joined) { toast('Not connected to the game'); return false; }
  const payload = extra ? { action, ...extra } : { action };
  const key = JSON.stringify(payload);
  const now = performance.now();
  if (key === lastMenuKey && now - lastMenuAt < MENU_DEBOUNCE_MS) return true;
  lastMenuKey = key;
  lastMenuAt = now;
  socket.emit('pad:menu', payload);
  if (buzz) haptic(12);
  return true;
}

// The phone's Steer Assist preference wins: re-sent (a few times at most)
// while the desktop's copy differs, e.g. right after joining.
const assistSync = { value: null, at: -1e9, tries: 0 };
function syncAssist(now, force) {
  const host = state.mine && state.mine.choice ? state.mine.choice.assist : undefined;
  if (typeof host !== 'boolean' || !state.joined) return;
  if (host === settings.assist) { assistSync.tries = 0; return; }
  if (assistSync.value !== settings.assist || force) { assistSync.value = settings.assist; assistSync.tries = 0; assistSync.at = -1e9; }
  if (assistSync.tries >= 3 || now - assistSync.at < ASSIST_RETRY_MS) return;
  assistSync.tries++;
  assistSync.at = now;
  sendMenu('assist', { value: settings.assist }, false);
}

function setAssist(on) {
  settings.assist = !!on;
  saveSettings();
  syncSettingsUI();
  if (state.joined) sendMenu('assist', { value: settings.assist }, false);
  assistSync.value = settings.assist;
  assistSync.tries = 1;
  assistSync.at = performance.now();
}

function startPing() {
  setInterval(() => {
    if (!socket || !socket.connected) { state.rttMs = null; return; }
    const t0 = performance.now();
    socket.timeout(1500).emit('net:ping', 0, (err) => {
      state.rttMs = err ? null : Math.round(performance.now() - t0);
      renderConn();
    });
  }, PING_MS);
}

// ---------------------------------------------------------------- shared data helpers

const sharedList = (key) => (state.shared && Array.isArray(state.shared[key]) ? state.shared[key].filter((x) => x && typeof x === 'object' && typeof x.id === 'string') : []);
const characters = () => sharedList('characters');
// Kart parts: the desktop's catalog (parts.js is the fallback, same data).
function partList(kind) {
  const list = sharedList(kind === 'body' ? 'bodies' : 'wheels');
  return list.length ? list : (kind === 'body' ? KART_BODIES : WHEELS);
}
const findId = (list, id) => list.find((x) => x.id === id) || null;
const charById = (id) => findId(characters(), id);
const defaultChar = (list) => findId(list, DEFAULT_CHAR) || list.find((c) => c.lead) || list[0] || null;
function players() {
  const list = state.shared && Array.isArray(state.shared.players) ? state.shared.players : [];
  return list.filter((p) => p && validSlot(p.slot)).sort((a, b) => a.slot - b.slot);
}
const playerBySlot = (slot) => players().find((p) => p.slot === slot) || null;
const modeName = (m) => (m === 'vs' ? 'VS Race' : 'Grand Prix');
function settingsLine(s) {
  const parts = [modeName(s.mode), `${Number(s.cc) || 100}cc`];
  if (s.mode === 'vs') parts.push(s.items === false ? 'Items off' : 'Items on');
  return parts.join(' · ');
}
// The roster entry behind a results / standings row (portrait, colors).
function charForRow(row) {
  if (!row) return null;
  if (validSlot(row.slot)) {
    const p = playerBySlot(row.slot);
    if (p && p.char) return charById(p.char);
  }
  return characters().find((c) => c.shortName === row.name || c.name === row.name) || null;
}

// Optimistic values for the host's lobby controls: shown until the desktop
// echoes them (or PENDING_MS passes).
const pending = new Map();
function setPending(key, value) { pending.set(key, { value, at: performance.now() }); }
function pendingValue(key, hostValue) {
  const p = pending.get(key);
  if (!p) return hostValue;
  if (p.value === hostValue || performance.now() - p.at > PENDING_MS) { pending.delete(key); return hostValue; }
  return p.value;
}

// ---------------------------------------------------------------- select flow state

// Locally browsed picks (a tap previews; OK sends) and sent-but-unconfirmed
// choices. The step shown is the desktop's, or the next one right after OK.
const pick = {
  char: null, body: null, wheels: null, track: null, cup: null,
  touched: { char: false, body: false, wheels: false, track: false, cup: false },
  sent: { char: null, body: null, wheels: null },
};
const pendingStep = { from: null, to: null, at: 0 };

function hostStep() {
  const st = state.mine && state.mine.step;
  return STEPS.has(st) ? st : 'char';
}

function shownStep() {
  const host = hostStep();
  if (pendingStep.to && host === pendingStep.from && performance.now() - pendingStep.at < PENDING_MS) return pendingStep.to;
  pendingStep.to = null;
  return host;
}

function goStep(to) {
  pendingStep.from = hostStep();
  pendingStep.to = to === pendingStep.from ? null : to;
  pendingStep.at = performance.now();
}

// A choice as it stands: just sent (awaiting the desktop), else the desktop's.
function choiceOf(k) {
  const host = state.mine && state.mine.choice ? state.mine.choice[k] : null;
  const p = pick.sent[k];
  if (p) {
    if (p.id === host || performance.now() - p.at > PENDING_MS) pick.sent[k] = null;
    else return p.id;
  }
  return typeof host === 'string' ? host : null;
}

function onSharedScreen(screen) {
  if (screen !== 'select') {
    pick.sent.char = pick.sent.body = pick.sent.wheels = null;
    pendingStep.to = null;
  }
}

// Entering a step: browse from the current choice.
function enterPick(step) {
  pick.touched[step] = false;
  pick[step] = null;
}

function adoptPick(step) {
  if (pick.touched[step] && pick[step]) return;
  const list = step === 'char' ? characters() : partList(step);
  const want = choiceOf(step);
  pick[step] = findId(list, want) ? want : step === 'char' ? defaultChar(list)?.id || null : list[0]?.id || null;
}

// The ratings of a character def alone (standard parts), clamped to 1..5.
const baseRatings = (def) => computeRatings(def, null);
const loadoutNow = (over = null) => ({ body: choiceOf('body') || 'standard', wheels: choiceOf('wheels') || 'standard', ...over });

// ---------------------------------------------------------------- shared widgets

// 1.5 → "1½", 0.5 → "½", 2 → "2" (ratings move in half-star steps).
function starText(v) {
  const a = Math.round(Math.abs(v) * 2) / 2;
  const whole = Math.floor(a);
  return a - whole ? `${whole || ''}½` : String(whole);
}
const deltaText = (d) => (Math.abs(d) < 0.25 ? '' : `${d > 0 ? '+' : '−'}${starText(d)}`);

// Stat effects of a kart part: [[text, isGood], …] (empty = balanced).
function partEffects(o) {
  const out = [];
  for (const k of STAT_KEYS) {
    const d = Number(o.mods && o.mods[k]) || 0;
    if (Math.abs(d) >= 0.25) out.push([`${STAT_SHORT[k]} ${deltaText(d)}`, d > 0]);
  }
  const off = Number(o.offroad) || 0;
  if (Math.abs(off) >= 0.005) out.push([`GRASS ${off > 0 ? '+' : '−'}${Math.round(Math.abs(off) * 100)}%`, off > 0]);
  return out;
}

// Four stat bars: the final rating, with the gain (green) or the loss (red
// stripes) against the character's own rating.
function buildStatBars(container) {
  const frag = document.createDocumentFragment();
  const recs = STAT_KEYS.map((key) => {
    const row = document.createElement('div');
    row.className = 'sb-row';
    const label = document.createElement('span');
    label.className = 'sb-label';
    label.textContent = STAT_SHORT[key];
    label.title = STAT_LABELS[key];
    const bar = document.createElement('div');
    bar.className = 'sb-bar';
    const fill = document.createElement('div');
    fill.className = 'sb-fill';
    const seg = document.createElement('div');
    seg.className = 'sb-seg';
    bar.append(fill, seg);
    const num = document.createElement('span');
    num.className = 'sb-num';
    row.append(label, bar, num);
    frag.appendChild(row);
    return { key, row, num, f: NaN, b: NaN };
  });
  container.replaceChildren(frag);
  return recs;
}

function setStatBars(recs, final, base) {
  for (const r of recs) {
    const f = Number(final && final[r.key]) || 0;
    const b = base ? Number(base[r.key]) || 0 : f;
    if (f === r.f && b === r.b) continue;
    r.f = f;
    r.b = b;
    setVar(r.row, '--lo', (Math.min(f, b) / 5).toFixed(3));
    setVar(r.row, '--hi', (Math.max(f, b) / 5).toFixed(3));
    toggle(r.row, 'up', f > b + 0.01);
    toggle(r.row, 'down', f < b - 0.01);
    setText(r.num, deltaText(f - b) || starText(f));
  }
}

const brokenImages = new Set();      // portrait URLs that failed: straight to the color card

// A racer portrait: the PNG from host:state.characters[].img over a disc in
// the racer's colors; a missing / broken image leaves the color card with the
// racer's initial.
function makeArt(def, cls = '') {
  const art = document.createElement('span');
  art.className = cls ? `art ${cls}` : 'art';
  if (def) {
    art.style.setProperty('--c', safeColor(def.cssColor));
    art.style.setProperty('--a', safeColor(def.accent || def.cssColor));
  }
  const init = document.createElement('span');
  init.className = 'art-init';
  init.textContent = def ? Array.from(String(def.shortName || def.name || '?'))[0].toUpperCase() : '?';
  art.appendChild(init);
  const src = def && typeof def.img === 'string' && def.img ? def.img : null;
  if (src && !brokenImages.has(src)) {
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.addEventListener('error', () => { brokenImages.add(src); art.classList.add('noimg'); img.remove(); }, { once: true });
    img.src = src;
    art.appendChild(img);
  } else {
    art.classList.add('noimg');
  }
  return art;
}

function slotTag(slot, withCrown = slot === hostSlot()) {
  const t = document.createElement('span');
  t.className = withCrown ? 'slot-tag host' : 'slot-tag';
  t.style.setProperty('--sc', slotInfo(slot).css);
  t.textContent = `P${slot}`;
  if (withCrown) t.insertAdjacentHTML('beforeend', '<svg class="crown" aria-hidden="true"><use href="#i-crown"/></svg>');
  return t;
}

// Segmented control: highlight the button whose data-v matches.
function segOn(seg, value) {
  for (const b of seg.children) {
    const on = b.dataset.v === value;
    toggle(b, 'on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}

// ---------------------------------------------------------------- part icons

// Small side-view kart bodies (painted in the racer's colors: --kc / --ka)
// and wheel faces. Unknown ids get the classic shape.
const KART_WHEELS = '<circle cx="17" cy="33" r="6.5" class="tire"/><circle cx="17" cy="33" r="2.6" class="hub"/><circle cx="49" cy="33" r="6.5" class="tire"/><circle cx="49" cy="33" r="2.6" class="hub"/>';
const BODY_ICONS = {
  standard: '<path class="kb" d="M7 29c0-6 4-9 10-9.5L41 18c9 0 15 4 17 10v2H7z"/><path class="ka" d="M24 19l4-7h7l-2 7z"/><path class="ka" d="M44 18l3-6" stroke-width="3" stroke-linecap="round"/>',
  speedster: '<path class="kb" d="M5 30l10-8 44 3v5z"/><path class="ka" d="M6 23V13h13v3h-8v7z"/><path class="ka" d="M31 22l5-6h7l-3 6z"/>',
  buggy: '<path class="kb" d="M9 30c0-11 9-18 23-18s23 7 23 18z"/><path d="M19 24c2-6 7-9 13-9" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="3" stroke-linecap="round"/>',
  tank: '<rect class="kb" x="7" y="13" width="50" height="17" rx="3"/><path class="ka" d="M47 13v17M52 13v17" stroke-width="2.5"/><rect class="ka" x="13" y="8" width="18" height="6" rx="2"/>',
  feather: '<path d="M8 28h50M15 28l7-9h19l7 9M28 19l-3-7" fill="none" class="kf" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><rect class="ka" x="24" y="17" width="9" height="5" rx="2"/>',
  rocket: '<path class="kb" d="M10 29l8-9h31c6 0 10 4 10 9z"/><path class="ka" d="M13 21L7 10l13 10z"/><path d="M10 23L1 26l9 3z" fill="#ff8a1f"/><path class="ka" d="M30 20l4-6h7l-1 6z"/>',
};
const WHEEL_ICONS = {
  standard: '<circle cx="20" cy="20" r="16" class="tire"/><circle cx="20" cy="20" r="8.5" class="rim"/><circle cx="20" cy="20" r="3" class="hub"/>',
  slick: '<circle cx="20" cy="20" r="16" class="tire"/><path d="M8 13a14 14 0 0 1 9-7" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="2.4" stroke-linecap="round"/><circle cx="20" cy="20" r="9.5" class="rim"/><circle cx="20" cy="20" r="3" class="hub"/>',
  offroad: '<circle cx="20" cy="20" r="14.5" class="tire"/><circle cx="20" cy="20" r="16" fill="none" class="tread" stroke-width="4.5" stroke-dasharray="4.2 3.2"/><circle cx="20" cy="20" r="7.5" class="rim"/><circle cx="20" cy="20" r="2.6" class="hub"/>',
  tiny: '<circle cx="20" cy="22" r="10.5" class="tire"/><circle cx="20" cy="22" r="5.5" class="rim"/><circle cx="20" cy="22" r="2" class="hub"/>',
  monster: '<circle cx="20" cy="20" r="18" class="tire"/><circle cx="20" cy="20" r="18.4" fill="none" class="tread" stroke-width="3.5" stroke-dasharray="6 3"/><circle cx="20" cy="20" r="6.5" class="rim"/><circle cx="20" cy="20" r="2.6" class="hub"/>',
  neon: '<circle cx="20" cy="20" r="16" class="tire"/><circle cx="20" cy="20" r="10" fill="none" stroke="#38c8ff" stroke-width="2.6" class="glow"/><circle cx="20" cy="20" r="6.5" fill="none" stroke="#ff4fa3" stroke-width="2.2" class="glow"/><circle cx="20" cy="20" r="2.6" class="hub"/>',
};
function partIcon(kind, id) {
  if (kind === 'body') return `<svg viewBox="0 0 64 42" aria-hidden="true">${BODY_ICONS[id] || BODY_ICONS.standard}${KART_WHEELS}</svg>`;
  return `<svg viewBox="0 0 40 40" aria-hidden="true">${WHEEL_ICONS[id] || WHEEL_ICONS.standard}</svg>`;
}

// Track art: a little scene per theme (bay / hill town / campus park / beach /
// lava castle), the cups, Random. Original drawings — no logos or emblems
// other than the game's own crowned "K".
const TRACK_ART = {
  campus: '<path d="M0 42q30-10 60-6t60 4v30H0z" fill="#5fb04a"/><ellipse cx="60" cy="50" rx="44" ry="13" fill="none" stroke="#f3e2b8" stroke-width="4"/><path d="M0 64q60-10 120 0v6H0z" fill="#3f8a36"/><rect x="6" y="22" width="18" height="16" fill="#e8e2d4"/><path d="M6 26h18M6 31h18" stroke="#9aa3b5" stroke-width="1.6"/><rect x="96" y="20" width="20" height="18" fill="#e3d6c2"/><path d="M96 25h20M96 30h20" stroke="#9aa3b5" stroke-width="1.6"/><path d="M40 44V30M58 42V24M80 44V30" stroke="#7a5b3c" stroke-width="2.4"/><circle cx="40" cy="27" r="7" fill="#2f7d4f"/><ellipse cx="58" cy="20" rx="6" ry="9" fill="#5e9c6e"/><circle cx="80" cy="27" r="7" fill="#2f7d4f"/><path d="M48 52q12-6 24 0" fill="none" stroke="#c98b4a" stroke-width="3"/>',
  beach: '<circle cx="96" cy="16" r="8" fill="#fff1a8"/><path d="M0 38h120v14H0z" fill="#1f9bd8"/><path d="M0 46q15-4 30 0t30 0 30 0 30 0v6H0z" fill="#7fd6f5"/><path d="M0 52q40-6 120 0v18H0z" fill="#f4d79b"/><path d="M84 30h14v4H84z" fill="#e8344e"/><path d="M86 34h10v10H86z" fill="#5fc8e8" stroke="#0d0f22" stroke-width="1.4"/><path d="M85 44l-2 10M97 44l2 10" stroke="#0d0f22" stroke-width="1.6"/><path d="M83 30l8-6 8 6z" fill="#e8344e"/><path d="M22 60q2-20 6-34" fill="none" stroke="#8a5a26" stroke-width="2.6"/><path d="M28 26q-10-2-16 6M28 26q8-6 16-2M28 26q-2-8-10-10M28 26q6 2 8 10" fill="none" stroke="#2f9a4f" stroke-width="3" stroke-linecap="round"/><path d="M0 34l10-8 8 6 8-10 10 12z" fill="#8a7a66"/>',
  castle: '<path d="M0 0h120v70H0z" fill="#3a1d2a"/><path d="M0 56q30-6 60 0t60 0v14H0z" fill="#ff6a1f"/><path d="M0 60q30-4 60 0t60 0v10H0z" fill="#ffb21f"/><path d="M30 54V22h8v-6h6v6h8v-6h6v6h8v-6h6v6h8v32z" fill="#5b5566" stroke="#1c1420" stroke-width="2"/><path d="M52 54V40a8 8 0 0 1 16 0v14z" fill="#1c1420"/><path d="M60 8v10" stroke="#1c1420" stroke-width="2"/><path d="M60 8h12l-3 3 3 3H60z" fill="#e8344e"/><path d="M36 30h4v6h-4zM80 30h4v6h-4z" fill="#ffb21f"/><path d="M12 54l3-10 3 10zM104 54l3-12 3 12z" fill="#ff8a1f"/>',
  krishivcup: '<path d="M0 0h120v70H0z" fill="#4a1f33"/><path d="M0 58q30-6 60 0t60 0v12H0z" fill="#ff7a1f"/><path d="M40 20h40l-4 22q-4 10-16 10t-16-10z" fill="#ffd23f" stroke="#8a5a26" stroke-width="2"/><path d="M40 24q-12 0-10 10t12 6M80 24q12 0 10 10t-12 6" fill="none" stroke="#ffd23f" stroke-width="3"/><path d="M54 52h12v6h6v4H48v-4h6z" fill="#ffd23f" stroke="#8a5a26" stroke-width="1.6"/><path d="M48 12l4 6 8-8 8 8 4-6v8H48z" fill="#ffd23f" stroke="#8a5a26" stroke-width="1.6"/><text x="60" y="40" text-anchor="middle" font-size="16" font-family="Lilita One, sans-serif" fill="#8a2a1f">K</text>',
  bay: '<circle cx="92" cy="18" r="9" fill="#ffd23f"/><path d="M0 46q15-7 30 0t30 0 30 0 30 0v24H0z" fill="#1e90ea"/><path d="M0 55q15-6 30 0t30 0 30 0 30 0v15H0z" fill="#0b4785"/><path d="M28 44V24l14 20z" fill="#fff"/><path d="M26 45h20l-3 4H29z" fill="#ff8a1f"/><path d="M58 46c10-16 30-16 40 0" fill="none" stroke="#ff4fa3" stroke-width="3"/>',
  hilltown: '<path d="M0 50q30-30 60-6t60-10v36H0z" fill="#4f8a3c"/><path d="M0 60q40-14 120-4v14H0z" fill="#3a6b2c"/><rect x="52" y="14" width="9" height="24" fill="#f3efe6"/><path d="M52 18h9M52 24h9M52 30h9" stroke="#c2603a" stroke-width="2.4"/><path d="M50 14l6.5-7 6.5 7z" fill="#c2603a"/><rect x="30" y="34" width="14" height="11" fill="#e7a33e"/><path d="M28 35l9-7 9 7z" fill="#c2603a"/><rect x="68" y="32" width="15" height="12" fill="#e8c38a"/><path d="M66 33l9.5-7 9.5 7z" fill="#c2603a"/>',
  generic: '<path d="M10 52c0-20 20-30 50-30s50 10 50 30" fill="none" stroke="#ffd23f" stroke-width="7" stroke-linecap="round"/><path d="M10 52c0-20 20-30 50-30s50 10 50 30" fill="none" stroke="#0d0f22" stroke-width="1.6" stroke-dasharray="5 5"/>',
  random: '<text x="60" y="52" text-anchor="middle" font-size="48" font-family="Lilita One, sans-serif" fill="#fff" stroke="#0d0f22" stroke-width="3" paint-order="stroke">?</text>',
  cup: '<path d="M48 30h24l-12 34z" fill="#d9a15c" stroke="#8a5a26" stroke-width="2" stroke-linejoin="round"/><path d="M52 36l14 8M50 42l10 10M68 36l-12 14" stroke="#8a5a26" stroke-width="1.5"/><circle cx="54" cy="25" r="9" fill="#b7d98b"/><circle cx="66" cy="25" r="9" fill="#ff8ab8"/><circle cx="60" cy="15" r="9" fill="#fff4dc"/><circle cx="60" cy="7" r="3" fill="#e8344e"/>',
};
const THEME_OF = { bay: 'bay', breezy: 'bay', hilltown: 'hilltown', monte: 'hilltown', campus: 'campus', aldrich: 'campus', beach: 'beach', laguna: 'beach', castle: 'castle', palace: 'castle' };
function trackTheme(t) {
  if (!t) return 'generic';
  return THEME_OF[t.theme] || THEME_OF[t.id] || 'generic';
}
// Cup art: the Krishiv Cup gets the castle trophy, every other cup the gelato cone.
const cupTheme = (c) => (c && (c.id === 'krishiv' || /krishiv/i.test(String(c.name || ''))) ? 'krishivcup' : 'cup');
const trackArt = (theme, fit = 'slice') => `<svg viewBox="0 0 120 70" preserveAspectRatio="xMidYMid ${fit}" aria-hidden="true">${TRACK_ART[theme] || TRACK_ART.generic}</svg>`;

// ---------------------------------------------------------------- rendering

function currentScreen() {
  if (state.phase === 'insecure' || state.phase === 'code') return state.phase;
  if (state.full && !state.joined) return 'full';
  if (state.phase === 'gate') return 'gate';
  if (state.phase !== 'live') return 'connecting';
  if (!state.shared || (!state.joined && !state.everJoined)) return 'connecting';
  const s = state.shared.screen;
  switch (s) {
    case 'lobby': return 'lobby';
    case 'select': { const st = shownStep(); return st === 'done' ? 'waiting' : st; }
    case 'track': return amHost() ? 'track' : 'trackwait';
    case 'race': return myRace() ? 'race' : 'spectate';
    case 'paused': return 'paused';
    case 'results':
    case 'standings':
    case 'podium': return s;
    default: return 'loading';
  }
}

function showScreen(name) {
  if (name === shownScreen) return;
  const prev = shownScreen;
  shownScreen = name;
  for (const key in screens) toggle(screens[key], 'active', key === name);
  el.stage.dataset.screen = name;
  if (prev === 'race') { releaseAll(); cdText = null; }
  if (name === 'race') { lastWheelDeg = NaN; lastMeterL = -1; lastMeterR = -1; lastKnobPx = NaN; trackHalf = 0; }
  if (name === 'char' || name === 'body' || name === 'wheels') enterPick(name);
  if (name === 'track') { pick.track = null; pick.touched.track = false; pick.cup = null; pick.touched.cup = false; }
  if (desiredRot() !== state.cssRot) applyLayout(true);   // menus may use the natural layout
  refreshScrollHints();
}

function render() {
  const name = currentScreen();
  showScreen(name);
  renderConn();
  const live = state.phase === 'live';
  // "Waiting for the game": the desktop left, or our room vanished (server
  // restart) and we keep re-joining until the desktop re-creates it.
  const waiting = live && state.everJoined && state.socketConnected && !state.kicked && !state.full &&
    (state.joined ? !state.hostPresent : !helloInFlight);
  toggle(el.ovWaiting, 'show', waiting);
  toggle(el.ovKicked, 'show', state.kicked && state.phase !== 'code');
  toggle(el.bannerOffline, 'show', live && state.everJoined && !state.socketConnected);
  const stuck = reconnectStuck();
  toggle(el.bannerOffline, 'stuck', stuck);
  setText(el.offlineText, stuck ? "Can't reconnect. If the game is still running, reload this page (accept the certificate warning again)." : 'Reconnecting…');
  toggle(el.stage, 'auto-gas', settings.autoGas);
  toggle(el.stage, 'is-host', amHost());
  toggle(el.stage, 'has-slot', state.slot !== null && state.everJoined);
  const hs = hostSlot();
  const waitText = `Waiting for P${hs || 1}…`;
  for (const n of hostWaits) setText(n, waitText);
  switch (name) {
    case 'connecting': renderConnecting(); break;
    case 'lobby': renderLobby(); break;
    case 'char': renderChar(); break;
    case 'body':
    case 'wheels': renderPart(name); break;
    case 'ready': renderReady(); break;
    case 'waiting': renderWaiting(); break;
    case 'track': renderTrack(); break;
    case 'trackwait': renderTrackWait(); break;
    case 'loading': renderLoading(); break;
    case 'race': renderRace(); break;
    case 'paused': renderPaused(); break;
    case 'results': renderResults(); break;
    case 'standings': renderStandings(); break;
    case 'podium': renderPodium(); break;
    default: break;
  }
}

const reconnectStuck = () => !state.socketConnected && state.connectErrors >= RELOAD_HINT_ERRORS;

function renderConn() {
  const ok = state.socketConnected && state.joined && state.hostPresent;
  const cls = ok ? 'dot ok' : state.socketConnected ? 'dot wait' : 'dot';
  if (el.connDot.className !== cls) el.connDot.className = cls;
  setText(el.roomLabel, state.room || '----');
  setText(el.pingLabel, ok && state.rttMs != null ? `${state.rttMs}ms` : '');

  let text;
  if (state.serverMissing) text = "Can't reach the game server";
  else if (reconnectStuck()) text = "Can't reach the game — reload this page";
  else if (!state.socketConnected) text = 'Connecting to the game…';
  else if (state.joined && state.hostPresent) text = `Connected as P${state.slot} · room ${state.room}`;
  else if (state.joined) text = `Room ${state.room} · waiting for the game`;
  else text = `Joining room ${state.room || '…'}…`;
  setText(el.gateStatusText, text);
  const gdot = el.gateStatus.firstElementChild;
  if (gdot.className !== cls) gdot.className = cls;
}

function renderConnecting() {
  if (state.serverMissing) {
    setText(el.connectingTitle, "Can't reach the game");
    setText(el.connectingSub, 'Make sure KRISHIV KART is running on the computer, then reload this page.');
  } else if (reconnectStuck()) {
    setText(el.connectingTitle, "Can't reach the game");
    setText(el.connectingSub, 'If it is still running on the computer, reload this page and accept the certificate warning again.');
  } else if (!state.socketConnected) {
    setText(el.connectingTitle, 'Connecting…');
    setText(el.connectingSub, 'Looking for the game on your Wi-Fi');
  } else if (!state.joined) {
    setText(el.connectingTitle, 'Joining…');
    setText(el.connectingSub, `Room ${state.room || ''}`);
  } else {
    setText(el.connectingTitle, 'Connected!');
    setText(el.connectingSub, 'Waiting for the game screen…');
  }
}

// ---- lobby

const slotChips = [];
function buildSlotChips() {
  const frag = document.createDocumentFragment();
  for (const info of PLAYER_SLOTS) {
    const chip = document.createElement('div');
    chip.className = 'slot-chip';
    chip.style.setProperty('--sc', info.css);
    const disc = document.createElement('span');
    disc.className = 'sc-disc';
    disc.textContent = info.label;
    disc.insertAdjacentHTML('beforeend', '<svg class="crown" aria-hidden="true"><use href="#i-crown"/></svg>');
    const sub = document.createElement('span');
    sub.className = 'sc-sub';
    chip.append(disc, sub);
    frag.appendChild(chip);
    slotChips.push({ slot: info.slot, chip, sub });
  }
  el.lobSlots.replaceChildren(frag);
}

function renderLobby() {
  const s = state.shared;
  const host = amHost();
  const hs = hostSlot();
  setText(el.yaTag, state.slot ? `P${state.slot}` : 'P?');
  setText(el.lobRole, host ? 'You are the host: set up the race, then press START!' : `P${hs || 1} is the host and starts the race`);
  for (const c of slotChips) {
    const p = playerBySlot(c.slot);
    const me = c.slot === state.slot;
    const on = me || !!(p && p.connected);
    toggle(c.chip, 'me', me);
    toggle(c.chip, 'on', on);
    toggle(c.chip, 'away', !!p && !p.connected && !me);
    toggle(c.chip, 'host', c.slot === hs);
    setText(c.sub, me ? 'YOU' : p ? (p.connected ? 'JOINED' : 'AWAY') : 'OPEN');
  }
  const mode = pendingValue('mode', s.mode === 'vs' ? 'vs' : 'gp');
  const cc = pendingValue('cc', Number(s.cc) || 100);
  const items = pendingValue('items', s.items !== false);
  segOn(el.segMode, mode);
  segOn(el.segCc, String(cc));
  segOn(el.segItems, items ? 'on' : 'off');
  toggle(screens.lobby, 'mode-vs', mode === 'vs');
  setText(el.lobSettings, settingsLine({ mode, cc, items }));
  setText(el.lobWait, `Waiting for P${hs || 1} to start…`);
}

// ---- select: character

let charsBuilt = -1;                 // rosterVersion the character grid was built for
let ciRecs = null;

function buildCharRows(chars) {
  const groups = CLASS_ROWS.map(([id, label]) => ({ label, list: chars.filter((c) => !c.custom && (c.weightClass || 'medium') === id) }));
  groups.push({ label: 'CUSTOM', list: chars.filter((c) => c.custom) });
  const frag = document.createDocumentFragment();
  for (const g of groups) {
    if (!g.list.length) continue;
    const row = document.createElement('div');
    row.className = g.label === 'CUSTOM' ? 'char-row custom' : 'char-row';
    const label = document.createElement('span');
    label.className = 'cr-label';
    label.textContent = g.label;
    const cards = document.createElement('div');
    cards.className = 'cr-cards';
    for (const c of g.list) {
      const b = document.createElement('button');
      b.className = 'rc';
      b.dataset.id = c.id;
      b.style.setProperty('--c', safeColor(c.cssColor));
      b.setAttribute('aria-label', String(c.name || c.id));
      const name = document.createElement('span');
      const label = String(c.shortName || c.name || c.id);
      name.className = label.length >= 10 ? 'rc-name long' : 'rc-name';    // long names a size smaller (stay whole)
      name.textContent = label;
      b.append(makeArt(c), name);
      cards.appendChild(b);
    }
    row.append(label, cards);
    frag.appendChild(row);
  }
  el.charRows.replaceChildren(frag);
  refreshScrollHints();
}

function renderChar() {
  const chars = characters();
  if (charsBuilt !== rosterVersion) { charsBuilt = rosterVersion; buildCharRows(chars); }
  adoptPick('char');
  const chosen = choiceOf('char');
  for (const b of el.charRows.querySelectorAll('.rc')) {
    toggle(b, 'selected', b.dataset.id === pick.char);
    toggle(b, 'chosen', b.dataset.id === chosen);
  }
  const def = charById(pick.char);
  const cls = def ? (def.custom ? 'CUSTOM' : String(def.weightClass || 'medium').toUpperCase()) : '';
  setText(el.ciName, def ? String(def.shortName || def.name) : '');
  setText(el.ciClass, cls);
  setText(el.ciFull, def && def.name !== def.shortName ? String(def.name) : '');
  const quote = def ? def.catchphrase || def.tagline || '' : '';
  setText(el.ciQuote, quote ? `“${quote}”` : '');
  setStatBars(ciRecs, def ? baseRatings(def) : null, null);
  toggle(el.ciBack, 'hidden', !amHost());         // the host's BACK returns everyone to the lobby
}

// ---- select: kart body / wheels

const partKeys = { body: '', wheels: '' };
let biRecs = null;
let wiRecs = null;

function buildPartGrid(kind, list) {
  const grid = kind === 'body' ? el.bodyGrid : el.wheelsGrid;
  const frag = document.createDocumentFragment();
  for (const p of list) {
    const b = document.createElement('button');
    b.className = 'pc';
    b.dataset.id = p.id;
    b.dataset.kind = kind;
    const icon = document.createElement('span');
    icon.className = 'pc-icon';
    icon.innerHTML = partIcon(kind, p.id);
    const name = document.createElement('span');
    name.className = 'pc-name';
    name.textContent = String(p.label || p.id);
    const fx = document.createElement('span');
    fx.className = 'pc-fx';
    const effects = partEffects(p);
    if (!effects.length) effects.push(['BALANCED', null]);
    for (const [text, good] of effects) {
      const t = document.createElement('span');
      t.className = good === null ? 'fx even' : good ? 'fx up' : 'fx down';
      t.textContent = text;
      fx.appendChild(t);
    }
    b.append(icon, name, fx);
    frag.appendChild(b);
  }
  grid.replaceChildren(frag);
}

function renderPart(kind) {
  const list = partList(kind);
  const key = JSON.stringify(list);
  if (key !== partKeys[kind]) { partKeys[kind] = key; buildPartGrid(kind, list); }
  adoptPick(kind);
  const grid = kind === 'body' ? el.bodyGrid : el.wheelsGrid;
  const def = charById(choiceOf('char'));
  // Karts are painted in the racer's colors.
  setVar(grid, '--kc', safeColor(def && def.cssColor, '#ffd23f'));
  setVar(grid, '--ka', safeColor(def && (def.accent || def.cssColor), '#ff4fa3'));
  const chosen = choiceOf(kind);
  for (const b of grid.children) {
    toggle(b, 'selected', b.dataset.id === pick[kind]);
    toggle(b, 'chosen', b.dataset.id === chosen);
  }
  const part = findId(list, pick[kind]);
  setText(kind === 'body' ? el.biName : el.wiName, part ? String(part.label || part.id) : '');
  setText(kind === 'body' ? el.biDesc : el.wiDesc, part ? String(part.desc || '') : '');
  const final = def ? computeRatings(def, loadoutNow({ [kind]: pick[kind] })) : null;
  setStatBars(kind === 'body' ? biRecs : wiRecs, final, def ? baseRatings(def) : null);
}

// ---- select: ready card + waiting list

let rdArtId = null;
let rdRecs = null;

function renderReady() {
  const def = charById(choiceOf('char'));
  const id = def ? `${def.id}|${def.img}|${def.cssColor}` : '';
  if (id !== rdArtId) {
    rdArtId = id;
    el.rdArt.replaceChildren(def ? makeArt(def, 'big') : document.createTextNode(''));
  }
  const lo = loadoutNow();
  const body = findId(partList('body'), lo.body);
  const wheels = findId(partList('wheels'), lo.wheels);
  setText(el.rdName, def ? String(def.name) : '');
  setText(el.rdParts, `${body ? body.label : lo.body} · ${wheels ? wheels.label : lo.wheels}`);
  setStatBars(rdRecs, def ? computeRatings(def, lo) : null, def ? baseRatings(def) : null);
  if (el.tgAssist.checked !== settings.assist) el.tgAssist.checked = settings.assist;
  if (el.tgAutoGas.checked !== settings.autoGas) el.tgAutoGas.checked = settings.autoGas;
}

let wlKey = '';
function renderWaiting() {
  const list = players();
  const hs = hostSlot();
  const key = JSON.stringify([list, hs, state.slot, rosterVersion]);
  if (key !== wlKey) {
    wlKey = key;
    const frag = document.createDocumentFragment();
    for (const p of list) {
      const li = document.createElement('li');
      li.className = `wl-row${p.slot === state.slot ? ' me' : ''}${p.ready ? ' ready' : ''}${p.connected ? '' : ' away'}`;
      const def = p.char ? charById(p.char) : null;
      const body = findId(partList('body'), p.body);
      const wheels = findId(partList('wheels'), p.wheels);
      const text = document.createElement('span');
      text.className = 'wl-text';
      const name = document.createElement('span');
      name.className = 'wl-name';
      name.textContent = def ? String(def.shortName || def.name) : 'Choosing…';
      const sub = document.createElement('span');
      sub.className = 'wl-sub';
      sub.textContent = def && body && wheels ? `${body.label} · ${wheels.label}` : '';
      text.append(name, sub);
      const st = document.createElement('span');
      st.className = 'wl-status';
      st.textContent = !p.connected ? 'AWAY' : p.ready ? 'READY' : 'CHOOSING';
      li.append(slotTag(p.slot, p.slot === hs), def ? makeArt(def, 'small') : makeArt(null, 'small empty'), text, st);
      frag.appendChild(li);
    }
    el.wlList.replaceChildren(frag);
  }
  const waitingFor = list.filter((p) => p.connected && !p.ready && p.slot !== state.slot).length;
  setText(el.wlNote, waitingFor ? `Waiting for ${waitingFor} more player${waitingFor > 1 ? 's' : ''}…` : 'Everyone is ready!');
}

// ---- track (host) / choosing (others) / loading

let tkKey = '';
// The host's current VS pick: the desktop's `trackPick` extra ('random'
// allowed), else the shared track ref.
function hostTrackPick() {
  const s = state.shared;
  if (!s) return null;
  if (typeof s.trackPick === 'string') return s.trackPick;
  return s.track && typeof s.track === 'object' ? s.track.id : null;
}

function trackChoices() {
  const tracks = sharedList('tracks');
  return [...tracks, { id: 'random', name: 'Random', random: true }];
}

// Grand Prix cups (SPEC §15.3): the desktop's `cups` list ({ id, name, tracks:
// [id | {id, name}] }), else the single shared `cup` (older desktops).
function cupChoices() {
  const s = state.shared;
  const list = Array.isArray(s.cups) ? s.cups.filter((c) => c && typeof c === 'object' && typeof c.id === 'string') : [];
  if (list.length) return list;
  const one = s.cup && typeof s.cup === 'object' ? s.cup : { name: 'Grand Prix', tracks: [] };
  return [{ ...one, id: typeof one.id === 'string' ? one.id : 'cup' }];
}
// The host's current cup: the desktop's `cupPick` extra, else the shared `cup`.
function hostCupPick() {
  const s = state.shared;
  if (!s) return null;
  if (typeof s.cupPick === 'string') return s.cupPick;
  return s.cup && typeof s.cup === 'object' && typeof s.cup.id === 'string' ? s.cup.id : null;
}
const cupTracks = (c) => (c && Array.isArray(c.tracks) ? c.tracks : []);

function cupCard(cup, multi) {
  const tracks = sharedList('tracks');
  const card = document.createElement(multi ? 'button' : 'div');
  card.className = multi ? 'tk-card cup' : 'tk-card cup selected';
  card.dataset.id = cup.id;
  const theme = cupTheme(cup);
  card.innerHTML = `<span class="tk-art" data-theme="${theme}">${trackArt(theme, multi ? 'meet' : 'slice')}</span>`;   // side-by-side cards are wide: show the whole emblem
  const body = document.createElement('span');
  body.className = 'tk-body';
  const name = document.createElement('span');
  name.className = 'tk-name';
  name.textContent = String(cup.name || 'Grand Prix');
  const n = cupTracks(cup).length;
  const count = document.createElement('span');
  count.className = 'tk-count';
  count.textContent = `${n} RACE${n === 1 ? '' : 'S'}`;
  const ol = document.createElement('ol');
  ol.className = 'tk-list';
  for (const t of cupTracks(cup)) {
    const id = typeof t === 'string' ? t : t && t.id;
    const ref = findId(tracks, id) || (t && typeof t === 'object' ? t : { id, name: id });
    const li = document.createElement('li');
    li.textContent = String(ref.name || ref.id || '');
    ol.appendChild(li);
  }
  body.append(name, count, ol);
  card.appendChild(body);
  return card;
}

function buildTrackCards(gp) {
  const frag = document.createDocumentFragment();
  if (gp) {
    const cups = cupChoices();
    for (const c of cups) frag.appendChild(cupCard(c, cups.length > 1));
    setVar(el.tkCards, '--cups', String(Math.max(1, Math.min(3, cups.length))));
  } else {
    for (const t of trackChoices()) {
      const b = document.createElement('button');
      b.className = t.random ? 'tk-card random' : 'tk-card';
      b.dataset.id = t.id;
      const theme = t.random ? 'random' : trackTheme(t);
      b.innerHTML = `<span class="tk-art" data-theme="${theme}">${trackArt(theme)}</span>`;
      const name = document.createElement('span');
      name.className = 'tk-name';
      name.textContent = String(t.name || t.id);
      b.appendChild(name);
      frag.appendChild(b);
    }
    setVar(el.tkCards, '--cards', String(trackChoices().length));
  }
  el.tkCards.replaceChildren(frag);
}

function setPreview(theme) {
  if (el.tkPreview.dataset.theme !== theme) { el.tkPreview.dataset.theme = theme; el.tkPreview.innerHTML = trackArt(theme); }
}

function renderTrack() {
  const s = state.shared;
  const gp = s.mode !== 'vs';
  setText(el.tkTitle, gp ? 'GRAND PRIX' : 'VS RACE');
  setText(el.tkSub, `${Number(s.cc) || 100}cc`);
  const key = JSON.stringify([gp, s.tracks, gp ? [s.cups, s.cup] : null]);
  if (key !== tkKey) { tkKey = key; buildTrackCards(gp); }
  toggle(screens.track, 'gp', gp);
  const laps = RACE.laps;
  if (gp) {
    const cups = cupChoices();
    toggle(screens.track, 'multi', cups.length > 1);
    // an optimistic tap shows at once; the desktop's pick wins once it answers (or after PENDING_MS)
    const want = pendingValue('cup', hostCupPick());
    pick.cup = findId(cups, want) ? want : cups[0].id;
    if (cups.length > 1) for (const b of el.tkCards.children) toggle(b, 'selected', b.dataset.id === pick.cup);
    const cup = findId(cups, pick.cup) || cups[0];
    const n = cupTracks(cup).length;
    setPreview(cupTheme(cup));
    setText(el.tkName, cups.length > 1 ? String(cup.name || 'Grand Prix') : `${n} RACE${n === 1 ? '' : 'S'}`);
    setText(el.tkDesc, `${cups.length > 1 ? `${n} race${n === 1 ? '' : 's'} · ` : ''}${laps} laps each · ${Number(s.cc) || 100}cc · points for every finish: ${GP_POINTS.join('-')}`);
    return;
  }
  toggle(screens.track, 'multi', false);
  const choices = trackChoices();
  if (!pick.touched.track || !findId(choices, pick.track)) {
    const hostPick = hostTrackPick();
    pick.track = findId(choices, hostPick) ? hostPick : choices[0].id;
  }
  for (const b of el.tkCards.children) toggle(b, 'selected', b.dataset.id === pick.track);
  const t = findId(choices, pick.track);
  setPreview(t ? (t.random ? 'random' : trackTheme(t)) : 'generic');
  setText(el.tkName, t ? String(t.name || t.id) : '');
  setText(el.tkDesc, t && t.random ? `A surprise track · ${laps} laps` : `${laps} laps · ${s.items === false ? 'Items off' : 'Items on'} · ${Number(s.cc) || 100}cc`);
}

function renderTrackWait() {
  const s = state.shared;
  setText(el.twTitle, `P${hostSlot() || 1} is choosing the track…`);
  const cup = s.cup && typeof s.cup === 'object' ? s.cup : null;
  const hp = hostTrackPick();
  const picked = hp === 'random' ? 'Random' : s.track && typeof s.track === 'object' ? s.track.name : '';
  setText(el.twSub, s.mode !== 'vs' ? `${cup && cup.name ? cup.name : 'Grand Prix'} · ${Number(s.cc) || 100}cc`
    : picked ? `Picked so far: ${picked}` : `VS Race · ${Number(s.cc) || 100}cc`);
}

function renderLoading() {
  const s = state.shared;
  const name = s && s.track && typeof s.track === 'object' ? s.track.name : '';
  setText(el.ldTitle, name ? `NEXT UP: ${String(name).toUpperCase()}` : 'LOADING RACE…');
}

// ---- race

let rollTimer = null;
let rollIndex = 0;

// Every item the desktop can hand out (config ITEM_INFO is the source of the
// icons / colours; ITEM_IDS the roulette order).
const itemInfo = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(ITEM_INFO, id) && ITEM_INFO[id] ? ITEM_INFO[id] : null);
// The roulette reel cycles the items the desktop can hand out right now (config ITEM_ENABLED).
const ROLL_IDS = [...new Set([...ITEM_IDS, ...Object.keys(ITEM_INFO)])].filter((id) => itemInfo(id) && itemInfo(id).icon && ITEM_ENABLED[id] !== false);

function startRoll() {
  if (rollTimer) return;
  rollTimer = setInterval(() => {
    if (!ROLL_IDS.length) return;
    rollIndex = (rollIndex + 1) % ROLL_IDS.length;
    const info = itemInfo(ROLL_IDS[rollIndex]);
    el.itemIcon.textContent = info.icon;
    el.itemIcon._text = null;
    setVar(el.btnItem, '--item-c', safeColor(info.color, '#ffffff'));
  }, 85);
}
function stopRoll() {
  clearInterval(rollTimer);
  rollTimer = null;
}

function renderRace() {
  const r = myRace() || {};
  const place = Number(r.place) || 0;
  const racers = Number(r.racers) || 0;
  if (place > 0) {
    const ord = ordinal(place);
    setText(el.placeNum, String(place));
    setText(el.placeSuf, ord.slice(String(place).length));
    setText(el.placeOf, racers ? `/${racers}` : '');
  } else {
    setText(el.placeNum, '–');
    setText(el.placeSuf, '');
    setText(el.placeOf, '');
  }
  toggle(el.place, 'p1', place === 1);
  toggle(el.place, 'p2', place === 2);
  toggle(el.place, 'p3', place === 3);
  const laps = Math.max(1, Number(r.laps) || RACE.laps);
  setText(el.lapNum, String(clamp(Number(r.lap) || 1, 1, laps)));
  setText(el.lapTotal, String(laps));
  // v5 lire (padState race.coins): shown once the host sends them, gold at the cap
  const coins = Number.isFinite(Number(r.coins)) && r.coins !== undefined && r.coins !== null ? clamp(Math.trunc(Number(r.coins)), 0, 99) : null;
  if (el.coins) {
    toggle(el.coins, 'on', coins !== null);
    toggle(el.coins, 'max', coins !== null && coins >= 10);
    setText(el.coinsNum, coins !== null ? String(coins) : '');
  }

  const info = itemInfo(r.item);
  const item = info ? r.item : null;
  const rolling = !!r.rolling;
  const count = item ? Math.max(1, Number(r.itemCount) || 1) : 0;
  toggle(el.btnItem, 'rolling', rolling);
  toggle(el.btnItem, 'empty', !rolling && !item);
  toggle(el.btnItem, 'ready', !!item && !rolling);
  toggle(el.btnItem, 'has-count', count > 1 && !rolling);
  if (rolling) startRoll();
  else {
    stopRoll();
    setText(el.itemIcon, info ? String(info.icon || '') : '');
    setVar(el.btnItem, '--item-c', info ? safeColor(info.color, '#ffffff') : 'transparent');
  }
  el.btnItem.setAttribute('aria-label', info && !rolling ? `Use item: ${info.name || item}${count > 1 ? ` (${count} left)` : ''}` : 'Use item');
  setText(el.itemCount, count > 1 ? String(count) : '');

  // Steer Assist pip: shown while assisted, lit while it is steering.
  toggle(el.assistPip, 'on', r.assist === true);
  toggle(el.assistPip, 'active', r.assist === true && r.assistActive === true);

  const finished = !!r.finished;
  if (finished !== el.finish.classList.contains('show') || (finished && el.finish._place !== place)) {
    el.finish._place = place;
    el.finish.replaceChildren();
    if (finished) {
      const t = document.createElement('div');
      t.className = 'fb-title';
      t.textContent = 'FINISH!';
      const p = document.createElement('div');
      p.className = 'fb-place';
      p.textContent = place > 0 ? ordinal(place) : '';
      el.finish.append(t, p);
    }
    toggle(el.finish, 'show', finished);
  }
}

function renderPaused() {
  const by = validSlot(Number(state.shared.pausedBy));
  setText(el.pausedBy, by ? (by === state.slot ? 'You paused the race' : `P${by} paused the race`) : '');
}

// ---- results / standings / podium

function raceLabel(s) {
  const no = Number(s.raceNo) || 0;
  const of = Number(s.races) || 0;
  const track = s.track && typeof s.track === 'object' ? s.track.name : '';
  const head = s.mode === 'vs' ? (no ? `RACE ${no}` : 'VS RACE') : no && of ? `RACE ${no}/${of}` : 'GRAND PRIX';
  return track ? `${head} · ${String(track).toUpperCase()}` : head;
}

function listRow(r, { points, time }) {
  const li = document.createElement('li');
  const slot = validSlot(r.slot);
  if (slot && slot === state.slot) li.className = 'me';
  else if (slot) li.className = 'human';
  if (slot) li.style.setProperty('--sc', slotInfo(slot).css);
  const place = document.createElement('span');
  const pl = Number(r.place) || 0;
  place.className = `st-place${pl >= 1 && pl <= 3 ? ` p${pl}` : ''}`;
  place.textContent = pl ? ordinal(pl) : '–';
  const sw = document.createElement('span');
  sw.className = 'st-swatch';
  sw.style.background = safeColor(r.cssColor);
  const name = document.createElement('span');
  name.className = 'st-name';
  name.textContent = String(r.name || '???');
  li.append(place, sw, name);
  if (slot) li.appendChild(slotTag(slot, false));
  if (time) {
    const t = document.createElement('span');
    t.className = 'st-time';
    // Racers still on track when the results appear get an estimated time.
    const estimated = r.finished === false;
    t.textContent = Number.isFinite(r.time) ? `${estimated ? '~' : ''}${formatTime(r.time)}` : estimated ? '—' : '--:--.---';
    if (estimated) t.classList.add('est');
    li.appendChild(t);
  }
  const pts = document.createElement('span');
  pts.className = 'st-pts';
  pts.textContent = points === 'gain' ? `+${Number(r.points) || 0}` : `${Number(r.points) || 0}`;
  li.appendChild(pts);
  return li;
}

function renderMeCard(node, big, line1, line2) {
  const key = `${big}|${line1}|${line2}`;
  if (node._key === key) return;
  node._key = key;
  node.replaceChildren();
  if (!big) return;
  const b = document.createElement('div');
  b.className = 'mc-big';
  b.textContent = big;
  const l1 = document.createElement('div');
  l1.className = 'mc-line';
  l1.textContent = line1;
  node.append(b, l1);
  if (line2) {
    const l2 = document.createElement('div');
    l2.className = 'mc-sub';
    l2.textContent = line2;
    node.appendChild(l2);
  }
}

let resKey = '';
function renderResults() {
  const s = state.shared;
  const list = (Array.isArray(s.results) ? s.results : []).filter((r) => r && typeof r === 'object').sort((a, b) => (a.place || 99) - (b.place || 99));
  const key = JSON.stringify([list, state.slot]);
  if (key !== resKey) {
    resKey = key;
    const frag = document.createDocumentFragment();
    for (const r of list) frag.appendChild(listRow(r, { points: 'gain', time: true }));
    el.resList.replaceChildren(frag);
    refreshScrollHints();
  }
  const me = list.find((r) => validSlot(r.slot) && r.slot === state.slot);
  setText(el.resSub, raceLabel(s));
  const st = state.mine && state.mine.standing;
  renderMeCard(el.resMe, me && me.place ? ordinal(me.place) : '', me ? `+${Number(me.points) || 0} points` : '',
    st && st.points ? `${st.points} in total` : '');
}

let stdKey = '';
function renderStandings() {
  const s = state.shared;
  const list = (Array.isArray(s.standings) ? s.standings : []).filter((r) => r && typeof r === 'object').sort((a, b) => (a.place || 99) - (b.place || 99));
  const key = JSON.stringify([list, state.slot]);
  if (key !== stdKey) {
    stdKey = key;
    const frag = document.createDocumentFragment();
    for (const r of list) frag.appendChild(listRow(r, { points: 'total', time: false }));
    el.stdList.replaceChildren(frag);
    refreshScrollHints();
  }
  const no = Number(s.raceNo) || 0;
  const of = Number(s.races) || 0;
  const last = s.mode !== 'vs' && of > 0 && no >= of;
  setText(el.stdSub, s.mode === 'vs' ? (no ? `AFTER RACE ${no}` : 'VS RACE') : of ? `AFTER RACE ${no}/${of}` : 'GRAND PRIX');
  setText(el.stdNext, last ? 'PODIUM' : 'NEXT RACE');
  const me = list.find((r) => validSlot(r.slot) && r.slot === state.slot);
  renderMeCard(el.stdMe, me && me.place ? ordinal(me.place) : '', me ? `${Number(me.points) || 0} points` : '', me ? 'overall' : '');
}

let podKey = '';
function renderPodium() {
  const s = state.shared;
  const list = (Array.isArray(s.standings) ? s.standings : []).filter((r) => r && typeof r === 'object').sort((a, b) => (a.place || 99) - (b.place || 99));
  const cupName = s.cup && typeof s.cup === 'object' && s.cup.name ? s.cup.name : s.mode === 'vs' ? 'VS RACE' : 'GRAND PRIX';
  setText(el.podTitle, String(cupName).toUpperCase());
  const key = JSON.stringify([list.slice(0, 3), state.slot, rosterVersion]);
  if (key !== podKey) {
    podKey = key;
    const frag = document.createDocumentFragment();
    for (const idx of [1, 0, 2]) {             // 2nd, 1st, 3rd
      const r = list[idx];
      const col = document.createElement('div');
      col.className = `pod-col p${idx + 1}${r && validSlot(r.slot) && r.slot === state.slot ? ' me' : ''}`;
      if (r) {
        col.appendChild(makeArt(charForRow(r) || { cssColor: r.cssColor, name: r.name }, 'pod-art'));
        const name = document.createElement('span');
        name.className = 'pod-name';
        name.textContent = String(r.name || '');
        const pts = document.createElement('span');
        pts.className = 'pod-pts';
        pts.textContent = `${Number(r.points) || 0} pts`;
        col.append(name, pts);
        if (validSlot(r.slot)) col.appendChild(slotTag(r.slot, false));
      }
      const block = document.createElement('div');
      block.className = 'pod-block';
      block.textContent = String(idx + 1);
      if (r) block.style.setProperty('--bc', safeColor(r.cssColor));
      col.appendChild(block);
      frag.appendChild(col);
    }
    el.podBlocks.replaceChildren(frag);
  }
  const me = list.find((r) => validSlot(r.slot) && r.slot === state.slot);
  renderMeCard(el.podMe, me && me.place ? ordinal(me.place) : '', me ? (me.place === 1 ? 'You won the cup!' : `${Number(me.points) || 0} points`) : '',
    me && me.place > 1 ? 'overall' : '');
}

// ---------------------------------------------------------------- menu actions

// OK on a select step (or a second tap on the picked card): send the pick
// and show the next step right away.
function confirmPick(step) {
  const id = pick[step];
  if (!id || !sendMenu(step, { id })) return;
  pick.sent[step] = { id, at: performance.now() };
  goStep(STEP_NEXT[step]);
  render();
}

function onAction(act) {
  const step = shownScreen;
  switch (act) {
    case 'ok':
      if (step === 'char' || step === 'body' || step === 'wheels') confirmPick(step);
      break;
    case 'back': {
      const cur = shownStep();
      if (!sendMenu('back')) break;
      if (STEP_BACK[cur] && (step === 'body' || step === 'wheels' || step === 'ready' || step === 'waiting')) goStep(STEP_BACK[cur]);
      render();
      break;
    }
    case 'ready':
      syncAssist(performance.now(), true);
      if (sendMenu('ready', { value: true })) { goStep('done'); render(); }
      break;
    case 'go':
      if (state.shared && state.shared.mode === 'vs' && pick.track && hostTrackPick() !== pick.track) {
        sendMenu('track', { value: pick.track }, false);
      }
      if (state.shared && state.shared.mode !== 'vs' && pick.cup && cupChoices().length > 1 && hostCupPick() !== pick.cup) sendMenu('cup', { id: pick.cup }, false);
      sendMenu('go');
      break;
    case 'start':
    case 'next':
    case 'quit':
    case 'resume':
    case 'restart':
      sendMenu(act);
      break;
    default:
      break;
  }
}

function onSeg(seg, value) {
  if (seg === el.segMode) {
    if (sendMenu('mode', { value })) setPending('mode', value);
  } else if (seg === el.segCc) {
    const cc = Number(value);
    if (sendMenu('cc', { value: cc })) setPending('cc', cc);
  } else if (seg === el.segItems) {
    const on = value === 'on';
    if (sendMenu('items', { value: on })) setPending('items', on);
  }
  render();
}

// A tap on a racer / part card previews it; tapping the picked one again confirms.
function onPickCard(step, id) {
  if (pick[step] === id && pick.touched[step]) { confirmPick(step); return; }
  pick[step] = id;
  pick.touched[step] = true;
  haptic(8);
  render();
}

function onCupCard(id) {
  if (!id || pick.cup === id) return;
  if (sendMenu('cup', { id })) { setPending('cup', id); pick.cup = id; }
  render();
}

function onTrackCard(id) {
  pick.track = id;
  pick.touched.track = true;
  sendMenu('track', { value: id });
  render();
}

// ---------------------------------------------------------------- room code entry

let codeBuf = '';

function buildKeypad() {
  const frag = document.createDocumentFragment();
  for (const ch of ROOM_ALPHABET) {
    const k = document.createElement('button');
    k.className = 'key';
    k.dataset.k = ch;
    k.textContent = ch;
    frag.appendChild(k);
  }
  const back = document.createElement('button');
  back.className = 'key back';
  back.dataset.k = 'back';
  back.setAttribute('aria-label', 'Delete');
  back.textContent = '⌫';
  frag.appendChild(back);
  el.keypad.replaceChildren(frag);
  el.keypad.addEventListener('click', (e) => {
    const k = e.target.closest('.key');
    if (k) typeKey(k.dataset.k);
  });
}

function typeKey(k) {
  if (k === 'back') codeBuf = codeBuf.slice(0, -1);
  else if (codeBuf.length < ROOM_CODE_LENGTH && ROOM_ALPHABET.includes(k)) codeBuf += k;
  else return;
  haptic(8);
  state.roomError = '';
  renderCode();
  if (codeBuf.length === ROOM_CODE_LENGTH) submitCode();
}

function renderCode() {
  const slots = el.codeSlots.children;
  for (let i = 0; i < slots.length; i++) {
    setText(slots[i], codeBuf[i] || '');
    toggle(slots[i], 'filled', i < codeBuf.length);
    toggle(slots[i], 'cursor', i === codeBuf.length);
  }
  el.codeJoin.disabled = codeBuf.length !== ROOM_CODE_LENGTH;
  setText(el.codeError, state.roomError);
}

function submitCode() {
  const code = normalizeRoomCode(codeBuf);
  if (!code) { state.roomError = 'Room codes are 4 letters.'; renderCode(); return; }
  state.room = code;
  state.roomError = '';
  state.full = false;
  retryUntil = 0;
  try { history.replaceState(null, '', `${location.pathname}?room=${code}`); } catch { /* ignore */ }
  setText(el.codeError, socket && socket.connected ? 'Joining…' : 'Connecting…');
  hello();
  renderConn();
}

function enterCode(prefill) {
  state.phase = 'code';
  codeBuf = normalizeRoomCode(prefill || '') || '';
  renderCode();
  render();
}

// ---------------------------------------------------------------- settings sheet

// Sensitivity slider: a pointer-driven control instead of <input type=range>,
// which cannot be dragged once the stage is CSS-rotated (the native control
// only follows the unrotated screen axis). Left = calm (full lock at 50°),
// right = twitchy (18°).
const sensSlider = { pointerId: null };

function renderSens() {
  const pos = (LOCK_MAX_DEG - settings.lockDeg) / (LOCK_MAX_DEG - LOCK_MIN_DEG);
  el.sens.style.setProperty('--pos', pos.toFixed(4));
  el.sens.setAttribute('aria-valuenow', String(LOCK_MIN_DEG + LOCK_MAX_DEG - settings.lockDeg));
  el.sens.setAttribute('aria-valuetext', `full lock at ${settings.lockDeg}°`);
  setText(el.sensVal, `full lock at ${settings.lockDeg}°`);
}

function setLockDeg(deg) {
  const v = clamp(Math.round(deg), LOCK_MIN_DEG, LOCK_MAX_DEG);
  if (v === settings.lockDeg) return;
  settings.lockDeg = v;
  renderSens();
  saveSettings();
}

function onSensPointer(e) {
  switch (e.type) {
    case 'pointerdown':
      if (e.button > 0 || sensSlider.pointerId !== null) return;
      e.preventDefault();
      try { el.sens.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      sensSlider.pointerId = e.pointerId;
      toggle(el.sens, 'active', true);
      break;
    case 'pointermove':
      if (e.pointerId !== sensSlider.pointerId) return;
      break;
    default:   // pointerup / pointercancel / lostpointercapture
      if (e.pointerId === sensSlider.pointerId) { sensSlider.pointerId = null; toggle(el.sens, 'active', false); }
      return;
  }
  const len = Math.max(1, el.sens.offsetWidth);       // unrotated length
  const pos = clamp(0.5 + stageAxisOffset(e, el.sens) / len, 0, 1);
  setLockDeg(LOCK_MAX_DEG - pos * (LOCK_MAX_DEG - LOCK_MIN_DEG));
}

function onSensKey(e) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? 1 : 0;
  if (!step) return;
  e.preventDefault();
  setLockDeg(settings.lockDeg + step);
}

function syncSettingsUI() {
  renderSens();
  el.setAssist.checked = settings.assist;
  el.setAutoGas.checked = settings.autoGas;
  el.setInvert.checked = settings.invert;
  el.setHaptics.checked = settings.haptics;
  el.tgAssist.checked = settings.assist;
  el.tgAutoGas.checked = settings.autoGas;
  const mode = tiltWanted() ? 'tilt' : 'touch';
  for (const b of el.modeSeg.children) toggle(b, 'on', b.dataset.mode === mode);
  toggle(el.stage, 'auto-gas', settings.autoGas);
}

function setAutoGas(on) {
  settings.autoGas = !!on;
  saveSettings();
  syncSettingsUI();
  sendInput(false);
}

function openSheet() {
  releaseAll();
  state.sheetOpen = true;
  syncSettingsUI();
  el.sheet.classList.add('open');
  el.sheet.setAttribute('aria-hidden', 'false');
  refreshScrollHints();
}

function closeSheet() {
  state.sheetOpen = false;
  el.sheet.classList.remove('open');
  el.sheet.setAttribute('aria-hidden', 'true');
}

// Events-per-second meters for the debug readout.
const rateMeters = { orientation: { n: 0, t: 0, rate: 0 }, motion: { n: 0, t: 0, rate: 0 } };
function eventRate(meter, count, now) {
  if (now - meter.t >= 1000) {
    meter.rate = meter.t ? Math.round(((count - meter.n) * 1000) / (now - meter.t)) : 0;
    meter.n = count;
    meter.t = now;
  }
  return meter.rate;
}

function updateDebug(now) {
  const src = state.steerSource;
  const oRate = eventRate(rateMeters.orientation, orientationEvents, now);
  const mRate = eventRate(rateMeters.motion, motionEvents, now);
  const f = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
  el.dbg.textContent =
    `player   ${state.slot ? `P${state.slot}${amHost() ? ' (host)' : ''}` : '–'} · room ${state.room || '–'}\n` +
    `source   ${src}${src === 'orientation' ? ` (${oRate}/s)` : src === 'motion' ? ` (${mRate}/s)` : ''}\n` +
    `tilt     ${rawAngleDeg.toFixed(1)}°   center ${state.calib.toFixed(1)}°\n` +
    `steer    ${f(steer)}\n` +
    `screen   ${uiAngle()}° (os ${osAngle()}°${osFlip ? ' flipped' : ''}, css ${state.cssRot}°)\n` +
    `gravity  ${gravValid ? `${grav.x.toFixed(2)} ${grav.y.toFixed(2)} ${grav.z.toFixed(2)}` : 'n/a'}\n` +
    `network  ${state.socketConnected ? (state.rttMs != null ? `${state.rttMs} ms` : 'up') : 'down'} · ${sendRate} msg/s · ${linkLabel()}`;
}

// Socket.IO starts on HTTP long-polling and upgrades to a WebSocket. Staying on
// polling (upgrade refused) caps steering at about one sample per round trip.
function linkLabel() {
  const t = transportName();
  return t === 'polling' ? 'polling (slow: no WebSocket)' : t;
}

// ---------------------------------------------------------------- gate (permissions etc.)

const needsMotionPermission = () =>
  (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') ||
  (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function');

let wakeLock = null;
async function requestWakeLock() {
  if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not supported / not allowed */ }
}

function lockLandscape() {
  try {
    const p = window.screen.orientation && window.screen.orientation.lock && window.screen.orientation.lock('landscape');
    if (p && p.catch) p.catch(() => {});
  } catch { /* unsupported */ }
}

function requestFullscreenAndLock() {
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!req || document.fullscreenElement || document.webkitFullscreenElement) { lockLandscape(); return; }
  try {
    const p = req.call(root, { navigationUI: 'hide' });
    if (p && p.then) p.then(lockLandscape, () => {});
    else lockLandscape();
  } catch { /* iPhone Safari has no element fullscreen */ }
}

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const canFullscreen = () => {
  const root = document.documentElement;
  return !!(root.requestFullscreen || root.webkitRequestFullscreen) && (document.fullscreenEnabled ?? document.webkitFullscreenEnabled ?? true) !== false;
};
let fullscreenWanted = false;        // we went fullscreen at the gate (Android): keep it that way
let lastFullscreenTry = -1e9;

// Android drops fullscreen and the landscape lock after an app switch or the
// back gesture, which leaves a phone with auto-rotate off in the CSS-rotated
// portrait layout. Re-enter on the next tap: it needs a user gesture, and for
// touch that is pointerup, not pointerdown.
function restoreFullscreen() {
  if (!fullscreenWanted || fullscreenElement() || !state.pageVisible) return;
  const t = performance.now();
  if (t - lastFullscreenTry < 1500) return;
  lastFullscreenTry = t;
  requestFullscreenAndLock();
}

function onGateTap() {
  // iOS: requestPermission() must be called synchronously inside the gesture.
  const ask = askMotionPermission();
  fullscreenWanted = canFullscreen();
  lastFullscreenTry = performance.now();
  requestFullscreenAndLock();
  requestWakeLock();
  haptic(20);
  state.gatePassed = true;
  state.phase = 'live';
  render();
  ask.then((r) => {
    setPermissionDenied(r === 'denied');
    armSensorCheck();
  });
}

// ---------------------------------------------------------------- wiring

function wireUi() {
  // Race controls
  holdButton('btn-gas', { onPress: () => setButton('gas', true), onRelease: () => setButton('gas', false) });
  holdButton('btn-brake', { onPress: () => setButton('brake', true), onRelease: () => setButton('brake', false) });
  // DRIFT: hold to drift; pressed in the air off a ramp it is a trick (the desktop decides).
  holdButton('btn-drift', { onPress: () => setButton('drift', true), onRelease: () => setButton('drift', false) });
  holdButton('btn-item', {
    buzz: 18,
    onPress: () => { state.itemSeq++; state.buttons.item = true; sendInput(false); },
    onRelease: () => { state.buttons.item = false; },
  });
  holdButton('btn-pause', {
    onPress: () => {
      if (!isRaceScreen()) return;
      state.pauseSeq++;
      sendInput(false);
    },
  });
  holdButton('btn-center', { buzz: 0, onPress: () => center(false) });

  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    el.tsTrack.addEventListener(t, onTrackPointer, { passive: false });
  }

  // Menus (one delegated listener)
  document.addEventListener('click', (e) => {
    if (!e.target.closest) return;
    const act = e.target.closest('[data-act]');
    if (act) { onAction(act.dataset.act); return; }
    const segBtn = e.target.closest('.seg[id^="seg-"] button[data-v]');
    if (segBtn) { onSeg(segBtn.parentElement, segBtn.dataset.v); return; }
    const rc = e.target.closest('.rc');
    if (rc) { onPickCard('char', rc.dataset.id); return; }
    const pc = e.target.closest('.pc');
    if (pc) { onPickCard(pc.dataset.kind, pc.dataset.id); return; }
    const tk = e.target.closest('button.tk-card');
    if (tk) { if (tk.classList.contains('cup')) onCupCard(tk.dataset.id); else onTrackCard(tk.dataset.id); }
  });

  // Ready card + settings toggles
  el.tgAssist.addEventListener('change', () => setAssist(el.tgAssist.checked));
  el.setAssist.addEventListener('change', () => setAssist(el.setAssist.checked));
  el.tgAutoGas.addEventListener('change', () => setAutoGas(el.tgAutoGas.checked));
  el.setAutoGas.addEventListener('change', () => setAutoGas(el.setAutoGas.checked));

  // Gate / code / insecure / full / kicked
  $('btn-gate').addEventListener('click', onGateTap);
  el.codeJoin.addEventListener('click', submitCode);
  $('btn-insecure-touch').addEventListener('click', () => {
    state.forceTouch = true;
    proceedFromBoot();
  });
  $('btn-full-retry').addEventListener('click', () => { haptic(12); hello(); });
  $('btn-reclaim').addEventListener('click', () => {
    state.kicked = false;
    render();
    hello();
  });

  // Settings
  $('btn-settings').addEventListener('click', openSheet);
  $('btn-sheet-close').addEventListener('click', closeSheet);
  $('sheet-backdrop').addEventListener('click', closeSheet);
  $('btn-sheet-center').addEventListener('click', () => center(false));
  $('btn-enable-tilt').addEventListener('click', enableTilt);
  $('btn-reload').addEventListener('click', () => location.reload());
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    el.sens.addEventListener(t, onSensPointer, { passive: false });
  }
  el.sens.addEventListener('keydown', onSensKey);
  el.setInvert.addEventListener('change', () => { settings.invert = el.setInvert.checked; saveSettings(); });
  el.setHaptics.addEventListener('change', () => { settings.haptics = el.setHaptics.checked; saveSettings(); haptic(30); });
  el.modeSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    if (b.dataset.mode === 'tilt') { enableTilt(); return; }   // asks for motion access again (iOS)
    settings.steerMode = b.dataset.mode;
    saveSettings();
    syncSettingsUI();
    renderSteerMode();
    if (state.gatePassed) armSensorCheck();
  });

  // Physical keyboard on the code screen (handy on tablets / desktop tests)
  window.addEventListener('keydown', (e) => {
    if (state.phase !== 'code') return;
    if (e.key === 'Backspace') typeKey('back');
    else if (e.key === 'Enter') submitCode();
    else if (/^[a-z]$/i.test(e.key)) typeKey(e.key.toUpperCase());
  });

  // No scrolling, zooming, selection or callouts anywhere except lists.
  document.addEventListener('touchmove', (e) => {
    if (!e.target.closest || !e.target.closest('.scroll')) e.preventDefault();
  }, { passive: false });
  for (const t of ['gesturestart', 'gesturechange', 'dblclick', 'contextmenu', 'selectstart']) {
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  }

  for (const list of scrollLists()) {
    list.addEventListener('scroll', () => updateScrollHint(list), { passive: true });
  }

  // Layout + orientation changes.
  const relayout = () => { applyLayout(true); refreshScrollHints(); };
  window.addEventListener('resize', relayout);
  window.addEventListener('orientationchange', () => setTimeout(relayout, 60));
  window.screen.orientation?.addEventListener?.('change', relayout);
  window.visualViewport?.addEventListener('resize', relayout);

  // Sensors are always listened to (gravity also picks the CSS rotation side).
  window.addEventListener('deviceorientation', onDeviceOrientation);
  window.addEventListener('devicemotion', onDeviceMotion);

  // Hidden mid-race → release everything (+ pause a solo race).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onPageHidden();
    else onPageVisible();
  });
  window.addEventListener('pagehide', onPageHidden);
  window.addEventListener('pageshow', () => { if (document.visibilityState !== 'hidden') onPageVisible(); });
  window.addEventListener('blur', releaseAll);

  // "Is the phone in use?" (see padInUse) + fullscreen recovery on the next tap.
  const touched = () => { lastTouchAt = performance.now(); };
  document.addEventListener('pointerdown', touched, true);
  document.addEventListener('pointerup', () => { touched(); restoreFullscreen(); }, true);
  for (const t of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(t, relayout);
}

function proceedFromBoot() {
  if (state.room) {
    state.phase = 'gate';
    render();
  } else {
    enterCode('');
  }
}

function boot() {
  buildKeypad();
  buildSlotChips();
  ciRecs = buildStatBars(el.ciStats);
  biRecs = buildStatBars(el.biStats);
  wiRecs = buildStatBars(el.wiStats);
  rdRecs = buildStatBars(el.rdStats);
  wireUi();
  applyLayout(true);
  setSource('none');
  applySlot(null, null, null);
  toggle(el.gatePerm, 'show', needsMotionPermission());
  syncSettingsUI();

  state.room = normalizeRoomCode(new URLSearchParams(location.search).get('room') || '');
  connectSocket();

  if (window.isSecureContext === false) {
    state.phase = 'insecure';
    const fallback = location.href.replace(/^http:/, 'https:');
    el.insecureLink.href = fallback;
    fetch('/api/info').then((r) => r.json()).then((info) => {
      if (info && Number.isInteger(info.httpsPort)) {
        el.insecureLink.href = `https://${location.hostname}:${info.httpsPort}${location.pathname}${location.search}`;
      }
    }).catch(() => {});
    render();
  } else {
    proceedFromBoot();
  }

  setInterval(tick, 1000 / 60);
  requestAnimationFrame(frame);
  startPing();
}

// ---------------------------------------------------------------- test hook

window.__pad = {
  get steer() { return steer; },
  get rawAngleDeg() { return rawAngleDeg; },
  get uiAngle() { return uiAngle(); },
  get steerTarget() { return steerTarget; },
  get osFlip() { return osFlip; },
  get transport() { return transportName(); },
  get sendRate() { return sendRate; },
  get poseUpright() { return poseUpright; },
  get screen() { return shownScreen; },
  get isHost() { return amHost(); },
  get step() { return shownStep(); },
  get pick() { return { char: pick.char, body: pick.body, wheels: pick.wheels, track: pick.track, cup: pick.cup }; },
  state,
  settings,
  center,
  setSource,
  math: { upFromOrientation, toScreen, rawAngleFromUp, angleFromScreenUp, shapeSteer, DEAD_ZONE_DEG, EXPO, STEER_KNEE, STEER_CAP, WHEEL_M0, WHEEL_M1, STEER_LPF_RATE, LOCK_DEFAULT_DEG, WHEEL_VISUAL_DEG },
  get atLock() { return atLock; },
};

boot();
