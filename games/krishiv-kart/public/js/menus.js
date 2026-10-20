// DOM menus for KRISHIV KART (SPEC §14.5–14.6, §15.3). Styles: css/menus.css.
//
// The desktop is a display: every personal choice happens on the phones.
// Screens: boot splash, lobby (logo, big QR, 4 player panels, settings +
// status lines), select (the same panels, live), track (GP: the cup cards —
// Gelato Cup / Krishiv Cup — and the chosen cup's races; VS: a tile per track
// + Random), loading, race (HUD only; pause overlay on top), results,
// standings, podium. Plus toasts, the controls overlay and small hints.
//
// Keyboard mode (no phone connected): P1 plays on the keyboard and makes the
// same choices through a desktop version of the phone flow (pickers drawn
// here, driven by handleNav). Those intents are reported through ONE
// callback using the phone's `pad:menu` vocabulary, so main.js treats them
// exactly like a phone's:
//
//   const menus = new Menus(document.getElementById('menus'), { audio, onAction });
//   onAction(action, payload)   // 'char' {id} | 'body' {id} | 'wheels' {id} | 'ready' {value} |
//                               // 'assist' {value} | 'back' | 'mode' {value} | 'cc' {value} |
//                               // 'items' {value} | 'start' | 'track' {value} | 'cup' {id} | 'go' | 'next' |
//                               // 'quit' | 'restart' | 'resume' | 'kbJoin' | 'kbLeave' | 'mute' | 'help'
//   menus.setCatalog({ characters, bodies, wheels, tracks });   // once (+ after custom racers load)
//   menus.show('lobby');                // 'boot'|'lobby'|'select'|'track'|'loading'|'race'|'results'|'standings'|'podium'
//   menus.update(view);                 // app snapshot (see main.js menuView); DOM only on change
//   menus.setPaused({ by: 'P2', color, kb }) / menus.setPaused(null);
//   menus.setPortrait(key, url);        // rendered kart portraits for the player panels
//   menus.setPhone({ status: 'online', room, padUrl, qrSvg });
//   menus.handleNav(input.menu);        // keyboard / gamepad edges, once per frame
//   menus.toast('P2 joined!', { icon: '📱', tone: 'good' });

import { GAME_TITLE } from './config.js';
import { computeRatings, slotInfo, MAX_PLAYERS } from './parts.js';
import { formatTime, ordinal } from './utils.js';

const SCREENS = ['boot', 'lobby', 'select', 'track', 'loading', 'race', 'results', 'standings', 'podium'];
const STATS = [['speed', 'Speed', 'SPD'], ['accel', 'Accel', 'ACC'], ['handling', 'Handling', 'HND'], ['weight', 'Weight', 'WGT']];
const STEP_TEXT = { char: 'Choosing a racer…', body: 'Picking a kart…', wheels: 'Picking wheels…', ready: 'Almost ready…', done: 'READY!' };
const MODE_LABEL = { gp: 'Grand Prix', vs: 'VS Race' };
const CLASSES = [50, 100, 150];
const WEIGHT_ROWS = [['light', 'Light'], ['medium', 'Medium'], ['heavy', 'Heavy']];
const KB_STEPS = ['char', 'body', 'wheels', 'ready'];

// Inline SVG icons (crisp white on dark buttons).
const ICON_SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9h4l5-4.2v14.4l-5-4.2h-4z" fill="currentColor"/>'
  + '<path d="M16 8.6a4.8 4.8 0 0 1 0 6.8M18.8 5.8a8.8 8.8 0 0 1 0 12.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const ICON_MUTED = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9h4l5-4.2v14.4l-5-4.2h-4z" fill="currentColor"/>'
  + '<path d="M16.2 9.2l5.6 5.6M21.8 9.2l-5.6 5.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const CROWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-1.8 10H4.8z" fill="#ffd23a" stroke="#1b1035" stroke-width="1.6" stroke-linejoin="round"/></svg>';
// Cup emblems (original art): a gelato cone for the Gelato Cup, the crowned K
// shield of Krishiv's Palace for the Krishiv Cup, a plain trophy otherwise.
const CUP_ART = {
  gelato: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M20 30h24L32 60z" fill="#d9a15c" stroke="#8a5a26" stroke-width="2.2" stroke-linejoin="round"/>'
    + '<path d="M24 36l14 9M22 42l10 9M40 36l-12 14" stroke="#8a5a26" stroke-width="1.6"/><circle cx="25" cy="25" r="9" fill="#b7d98b" stroke="#6f9a45" stroke-width="1.6"/>'
    + '<circle cx="39" cy="25" r="9" fill="#ff8ab8" stroke="#c4527e" stroke-width="1.6"/><circle cx="32" cy="14" r="9" fill="#fff4dc" stroke="#d8c39a" stroke-width="1.6"/>'
    + '<circle cx="32" cy="5.5" r="3.2" fill="#e8344e"/></svg>',
  krishiv: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 22h40v14c0 12-9 20-20 25C21 56 12 48 12 36z" fill="#7a1420" stroke="#ffc21a" stroke-width="2.6" stroke-linejoin="round"/>'
    + '<path d="M16 17l7 5 9-11 9 11 7-5-2 9H18z" fill="#ffc21a" stroke="#8a5a00" stroke-width="1.6" stroke-linejoin="round"/>'
    + '<path d="M25 30v22M25 41l11-11M28 38l10 14" fill="none" stroke="#ffd23a" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trophy: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 10h28v10c0 10-6 17-14 18-8-1-14-8-14-18z" fill="#ffc21a" stroke="#8a5a00" stroke-width="2.2"/>'
    + '<path d="M18 14H9c0 8 4 12 10 13M46 14h9c0 8-4 12-10 13" fill="none" stroke="#ffc21a" stroke-width="3"/><path d="M28 38h8v10h-8zM20 48h24v7H20z" fill="#d99a14" stroke="#8a5a00" stroke-width="2"/></svg>',
};

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function button(cls, parent, label, action) {
  const b = el('button', 'tk-btn ' + cls, parent);
  b.type = 'button';
  if (label != null) b.innerHTML = label;
  if (action) b.dataset.action = action;
  return b;
}

// Splits a logo word into bouncy letters (outlined back copy + gradient front copy).
function logoWord(parent, word, cls, offset = 0) {
  const w = el('span', 'tk-logo-word ' + cls, parent);
  w.setAttribute('aria-hidden', 'true');
  [...word].forEach((ch, i) => {
    const s = el('span', 'tk-logo-ch', w);
    s.style.setProperty('--i', String(i + offset));
    el('span', 'b', s, ch);
    el('span', 'f', s, ch);
  });
  return w;
}

function logo(parent, cls = '') {
  const lg = el('div', 'tk-logo ' + cls, parent);
  lg.setAttribute('role', 'heading');
  lg.setAttribute('aria-level', '1');
  lg.setAttribute('aria-label', GAME_TITLE);
  const puffs = el('div', 'tk-logo-puffs', lg);
  for (let k = 0; k < 4; k++) el('i', 'tk-puff p' + k, puffs);
  const [w1 = GAME_TITLE, w2 = ''] = GAME_TITLE.split(' ');
  logoWord(lg, w1, 'w1', 0);
  if (w2) logoWord(lg, w2, 'w2', w1.length);
  return lg;
}

function statBars(parent, cls = '', short = false) {
  const box = el('div', 'tk-stats ' + cls, parent);
  const fills = {};
  for (const [key, label, abbr] of STATS) {
    const row = el('div', 'tk-stat', box);
    row.title = label;
    el('span', 'tk-stat-label', row, short ? abbr : label);
    const bar = el('span', 'tk-stat-bar', row);
    const pips = [];
    for (let k = 0; k < 5; k++) pips.push(el('i', '', bar));
    fills[key] = pips;
  }
  return { el: box, fills, set(r) { for (const [k] of STATS) setStat(fills[k], r ? r[k] : 0); } };
}

// 5 pips; fractional ratings (0.5 steps from kart parts) light a half pip.
function setStat(pips, value) {
  const v = Math.max(0, Math.min(5, Number(value) || 0));
  const full = Math.floor(v + 1e-6);
  const half = v - full >= 0.5 - 1e-6;
  for (let k = 0; k < pips.length; k++) {
    pips[k].classList.toggle('on', k < full);
    pips[k].classList.toggle('half', k === full && half);
  }
}

// "+1", "−0.5" (real minus sign), "" for 0.
function signed(v) {
  if (!v) return '';
  const a = Math.abs(v);
  return (v > 0 ? '+' : '−') + (Number.isInteger(a) ? String(a) : a.toFixed(1));
}

// SVG path of a track's centerline (map view, start straight pointing up).
function outlinePath(track, size = 100) {
  const smp = track && track.samples;
  if (!smp || !smp.length) return '';
  const step = Math.max(1, Math.floor(smp.length / 160));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const pts = [];
  for (let i = 0; i < smp.length; i += step) {
    const x = -smp[i].pos.x, y = -smp[i].pos.z;      // same 180° rotation as the HUD minimap
    pts.push(x, y);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const pad = size * 0.1;
  const sc = Math.min((size - 2 * pad) / (maxX - minX || 1), (size - 2 * pad) / (maxY - minY || 1));
  const ox = size / 2 - ((minX + maxX) / 2) * sc, oy = size / 2 - ((minY + maxY) / 2) * sc;
  let d = '';
  for (let i = 0; i < pts.length; i += 2) d += `${i ? 'L' : 'M'}${(ox + pts[i] * sc).toFixed(1)} ${(oy + pts[i + 1] * sc).toFixed(1)}`;
  return d + 'Z';
}

/** Minimal full-page error card (used by main.js when WebGL / boot fails). */
export function showFatal(root, title, detail = '') {
  if (!root) return;
  const box = el('div', 'tk-fatal');
  el('div', 'tk-fatal-title', box, title);
  if (detail) el('div', 'tk-fatal-detail', box, detail);
  root.replaceChildren(box);
}

export class Menus {
  constructor(root, { audio = null, onAction = () => {} } = {}) {
    this.root = root;
    this.audio = audio;
    this.onAction = onAction;
    this.screen = 'boot';
    this.view = null;
    this.cat = { characters: [], bodies: [], wheels: [], tracks: [] };
    this._portraits = new Map();     // 'char|body|wheels' → data URL
    this._keys = {};                 // render keys (DOM only on change)
    this._helpOpen = false;
    this._toastTimer = null;
    this._paused = null;
    this._phone = { status: 'connecting', room: null, padUrl: null, qrSvg: null };
    this._qrKey = null;
    // keyboard-mode cursors (browsing is local, like on a phone)
    this._kb = { step: null, char: 0, body: 0, wheels: 0, ready: 1, lobby: 0, track: 0, end: 0, pause: 0 };

    this._build();
    this._onClick = (e) => this._click(e);
    this.el.addEventListener('click', this._onClick);
    this._renderPhone();
  }

  // ================================================================== DOM

  _build() {
    const r = el('div', 'tk-menus', this.root);
    this.el = r;
    r.dataset.screen = 'boot';
    this.bootEl = this.root.querySelector('.tk-boot');
    if (this.bootEl) r.appendChild(this.bootEl);

    // ------------------------------------------------ corner buttons
    const corner = el('div', 'tk-corner', r);
    this.muteBtn = button('tk-icon-btn', corner, '', 'mute');
    this.muteBtn.title = 'Mute / unmute (M)';
    this.muteBtn.setAttribute('aria-label', 'Mute or unmute sound (M)');
    this.helpBtn = button('tk-icon-btn', corner, '<span>?</span>', 'help');
    this.helpBtn.title = 'How to play (H)';
    this.helpBtn.setAttribute('aria-label', 'How to play (H)');
    this.setMuted(false);

    // ------------------------------------------------ lobby
    const lobby = el('section', 'tk-screen tk-lobby', r);
    this.lobbyEl = lobby;
    logo(lobby, 'tk-logo--lobby');
    el('div', 'tk-logo-sub', lobby, 'Grab a phone · up to 4 racers · one big screen');
    this.lobbyQR = this._qrPanel(lobby, 'tk-qr--lobby');
    const bar = el('div', 'tk-lobby-bar', lobby);
    this.settingsLine = el('div', 'tk-settings', bar, '');
    this.statusLine = el('div', 'tk-status', bar, '');
    this.kbLobby = el('div', 'tk-kb-lobby', lobby);
    this.kbPrompt = el('div', 'tk-kb-prompt', lobby);
    this.kbPrompt.innerHTML = 'No phone? Press <span class="tk-key">Enter</span> to race with the keyboard';

    // ------------------------------------------------ select
    const sel = el('section', 'tk-screen tk-select', r);
    this.selectEl = sel;
    const sh = el('div', 'tk-sel-head', sel);
    el('div', 'tk-h1', sh, 'Choose your racers');
    this.selSettings = el('div', 'tk-sel-sub', sh, '');
    this.selectQR = this._qrPanel(sel, 'tk-qr--compact');
    this.kbPick = el('div', 'tk-panel tk-kb', sel);
    this.selStatus = el('div', 'tk-status tk-status--select', sel, '');

    // ------------------------------------------------ player panels (lobby + select share them)
    this.panelsEl = el('div', 'tk-panels', r);
    this.panels = [];
    for (let s = 1; s <= MAX_PLAYERS; s++) this.panels.push(this._buildPanel(s));

    // ------------------------------------------------ track
    const tr = el('section', 'tk-screen tk-trackscr', r);
    this.trackEl = tr;
    const tp = el('div', 'tk-panel tk-track-panel', tr);
    this.trackKicker = el('div', 'tk-track-kicker', tp, '');
    this.trackTitle = el('div', 'tk-h1 tk-track-title', tp, '');
    this.trackCups = el('div', 'tk-cups', tp);
    this.trackTiles = el('div', 'tk-tiles', tp);
    this.trackSub = el('div', 'tk-track-sub', tp, '');
    this.trackStatus = el('div', 'tk-status', tp, '');
    this.trackBtns = el('div', 'tk-end-btns', tp);

    // ------------------------------------------------ loading
    const ld = el('section', 'tk-screen tk-loading', r);
    this.loadingEl = ld;
    const lc = el('div', 'tk-load-card', ld);
    this.loadKicker = el('div', 'tk-load-kicker', lc, '');
    this.loadName = el('div', 'tk-load-name', lc, '');
    this.loadMap = el('div', 'tk-load-map', lc);
    el('div', 'tk-boot-bar', lc).appendChild(document.createElement('i'));
    this.loadTip = el('div', 'tk-load-tip', lc, '');

    // ------------------------------------------------ results / standings
    const res = el('section', 'tk-screen tk-results', r);
    this.resultsEl = res;
    const rp = el('div', 'tk-panel tk-res-panel', res);
    this.resTitle = el('div', 'tk-res-title', rp, 'Results');
    this.resSub = el('div', 'tk-res-sub', rp, '');
    this.resBody = el('div', 'tk-res-table', rp);
    this.resHint = el('div', 'tk-status', rp, '');
    this.resBtns = el('div', 'tk-end-btns', rp);

    const std = el('section', 'tk-screen tk-standings', r);
    this.standingsEl = std;
    const sp = el('div', 'tk-panel tk-res-panel', std);
    this.stdTitle = el('div', 'tk-res-title', sp, 'Standings');
    this.stdSub = el('div', 'tk-res-sub', sp, '');
    this.stdBody = el('div', 'tk-res-table', sp);
    this.stdHint = el('div', 'tk-status', sp, '');
    this.stdBtns = el('div', 'tk-end-btns', sp);

    // ------------------------------------------------ podium
    const pod = el('section', 'tk-screen tk-podium', r);
    this.podiumEl = pod;
    const ph = el('div', 'tk-pod-head', pod);
    this.podKicker = el('div', 'tk-pod-kicker', ph, '');
    this.podWinner = el('div', 'tk-pod-winner', ph, '');
    this.podPlates = el('div', 'tk-pod-plates', pod);
    const pf = el('div', 'tk-pod-foot', pod);
    this.podHint = el('div', 'tk-status', pf, '');
    this.podBtns = el('div', 'tk-end-btns', pf);

    // ------------------------------------------------ pause overlay
    const pause = el('section', 'tk-pause', r);
    this.pauseEl = pause;
    const pp = el('div', 'tk-panel tk-pause-panel', pause);
    el('div', 'tk-h1 tk-pause-title', pp, 'Paused');
    this.pauseBy = el('div', 'tk-pause-by', pp, '');
    this.pauseHint = el('div', 'tk-pause-hint', pp, '');
    this.pauseBtnsEl = el('div', 'tk-pause-btns', pp);
    this.pauseBtns = [
      button('tk-btn--menu green', this.pauseBtnsEl, 'Resume', 'resume'),
      button('tk-btn--menu orange', this.pauseBtnsEl, 'Restart', 'restart'),
      button('tk-btn--menu red', this.pauseBtnsEl, 'Quit to lobby', 'quit'),
    ];

    // ------------------------------------------------ in-race hint (intro skip)
    this.introHint = el('div', 'tk-intro-hint', r);
    this.introKey = el('span', 'tk-key', this.introHint, 'Enter');
    this.introHint.append(' skip intro');

    this._buildHelp(r);

    // ------------------------------------------------ flash, dip curtain, toast, sound hint
    this.fxEl = el('div', 'tk-fx', r);
    this.dipEl = el('div', 'tk-dip', r);
    this.toastEl = el('div', 'tk-toast', r);
    this.toastIcon = el('span', 'tk-toast-icon', this.toastEl);
    this.toastText = el('span', 'tk-toast-text', this.toastEl);
    this.soundHint = el('div', 'tk-sound-hint', r);
    this.soundHint.innerHTML = `${ICON_SPEAKER} Click or press any key for sound`;
  }

  // One player panel (slot color, portrait, racer, kart parts, stats, READY).
  _buildPanel(slot) {
    const info = slotInfo(slot);
    const p = el('div', 'tk-pp is-empty', this.panelsEl);
    p.dataset.slot = String(slot);
    p.style.setProperty('--slot', info.css);
    const head = el('div', 'tk-pp-head', p);
    el('span', 'tk-pp-tag', head, info.label);
    const crown = el('span', 'tk-pp-crown', head);
    crown.innerHTML = CROWN;
    crown.title = 'Host — picks the mode and track';
    const state = el('span', 'tk-pp-state', head, '');
    const pic = el('div', 'tk-pp-pic no-img', p);
    const img = el('img', 'tk-pp-img', pic);
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('error', () => pic.classList.add('no-img'));
    img.addEventListener('load', () => pic.classList.remove('no-img'));
    const initial = el('span', 'tk-pp-initial', pic, '?');
    const ready = el('div', 'tk-pp-ready', pic, 'READY!');
    const body = el('div', 'tk-pp-body', p);
    const name = el('div', 'tk-pp-name', body, '');
    const kart = el('div', 'tk-pp-kart', body, '');
    const stats = statBars(body, 'tk-pp-stats', true);
    const step = el('div', 'tk-pp-step', body, '');
    const empty = el('div', 'tk-pp-empty', p);
    el('div', 'tk-pp-empty-big', empty, info.label);
    el('div', 'tk-pp-empty-txt', empty, 'Scan the QR to join');
    return { slot, el: p, state, pic, img, initial, ready, name, kart, stats, step, src: '' };
  }

  _buildHelp(r) {
    const help = el('div', 'tk-help', r);
    this.helpEl = help;
    const hp = el('div', 'tk-panel tk-help-panel', help);
    el('div', 'tk-h1', hp, 'How to play');
    const cols = el('div', 'tk-help-cols', hp);
    const phone = el('div', 'tk-help-col', cols);
    el('div', 'tk-help-h', phone, '📱 Phone wheel (1–4 players)');
    phone.insertAdjacentHTML('beforeend', `
      <dl class="tk-keys">
        <dt>Scan the QR</dt><dd>Join as P1–P4 (P1 = host 👑)</dd>
        <dt>Turn the phone</dt><dd>Steer like a wheel</dd>
        <dt>Right thumb</dt><dd>GAS (big) · BRAKE</dd>
        <dt>Left thumb</dt><dd>DRIFT (hold; in the air = trick) · ITEM</dd>
        <dt>⏸ button</dt><dd>Pause (anyone)</dd>
        <dt>Steer Assist</dt><dd>Keeps you on the road (READY card)</dd>
      </dl>
      <div class="tk-help-note">Phones and computer must be on the same Wi-Fi. The host picks the mode, class and the cup or track.</div>`);
    const kb = el('div', 'tk-help-col', cols);
    el('div', 'tk-help-h', kb, '⌨️ Keyboard (solo)');
    kb.insertAdjacentHTML('beforeend', `
      <dl class="tk-keys">
        <dt><span class="tk-key">Enter</span></dt><dd>Lobby: play with the keyboard · confirm</dd>
        <dt><span class="tk-key">←</span><span class="tk-key">→</span> / <span class="tk-key">A</span><span class="tk-key">D</span></dt><dd>Steer · browse</dd>
        <dt><span class="tk-key">↑</span> / <span class="tk-key">W</span></dt><dd>Gas</dd>
        <dt><span class="tk-key">↓</span> / <span class="tk-key">S</span></dt><dd>Brake / reverse</dd>
        <dt><span class="tk-key">Space</span> / <span class="tk-key">Shift</span></dt><dd>Hop &amp; drift · trick in the air</dd>
        <dt><span class="tk-key">X</span> <span class="tk-key">E</span> <span class="tk-key">Z</span></dt><dd>Use item</dd>
        <dt><span class="tk-key">C</span></dt><dd>Look back</dd>
        <dt><span class="tk-key">Esc</span> / <span class="tk-key">P</span></dt><dd>Pause · back</dd>
        <dt><span class="tk-key">M</span></dt><dd>Mute</dd>
      </dl>
      <div class="tk-help-note">🎮 Gamepads work too: stick steers, A gas, B brake, RB drift, LB item.</div>`);
    const tips = el('div', 'tk-help-tips', hp);
    tips.innerHTML = '<b>Pro tips:</b> hold drift through corners until the sparks turn '
      + '<span style="color:#38c8ff">blue</span> → <span style="color:#ff9d2e">orange</span> → '
      + '<span style="color:#c45cff">purple</span>, then release for a mini-turbo. '
      + 'Press gas just before <b>GO!</b> for a rocket start — too early and you stall. '
      + 'The further back you are, the better the items (up to the 🍺 Beer Rocket); '
      + 'leading? Keep an 🪗 Accordion Blast for the 🧆 Capo Crusher.';
    const close = button('tk-btn--menu blue tk-help-close', hp, 'Got it!', 'help');
    close.dataset.close = '1';
  }

  // One QR / phone panel (lobby: large, select: compact).
  _qrPanel(parent, variant) {
    const p = el('div', 'tk-qr ' + variant, parent);
    const code = el('div', 'tk-qr-code', p);
    const svg = el('div', 'tk-qr-svg', code);
    el('div', 'tk-qr-off', code, '📵');
    const info = el('div', 'tk-qr-info', p);
    el('div', 'tk-qr-title', info, 'Join with your phone');
    const scan = el('div', 'tk-qr-scan', info, 'Scan with the camera app — each phone becomes a steering wheel');
    const url = el('div', 'tk-qr-url', info, '');
    const status = el('div', 'tk-qr-status', info);
    el('i', 'tk-dot', status);
    const statusText = el('span', '', status, 'Connecting…');
    const tip = el('div', 'tk-qr-tip', info);
    tip.innerHTML = '<span class="tk-tip-long"><b>Certificate warning?</b> It\'s our self-signed HTTPS — tap <i>Show Details / Advanced</i> → <i>visit / proceed</i>. Same Wi-Fi needed.</span>'
      + '<span class="tk-tip-short"><b>Cert warning?</b> Tap <i>Advanced → Proceed</i>. Same Wi-Fi.</span>';
    return { el: p, svg, url, scan, statusText };
  }

  // ================================================================== screens

  /** Switch the visible menu screen ('race' = no menu, HUD only). */
  show(name) {
    if (!SCREENS.includes(name)) name = 'race';
    if (name === this.screen) return;
    const prev = this.screen;
    this.screen = name;
    this.el.dataset.screen = name;
    const map = { lobby: this.lobbyEl, select: this.selectEl, track: this.trackEl, loading: this.loadingEl,
      results: this.resultsEl, standings: this.standingsEl, podium: this.podiumEl };
    for (const [key, node] of Object.entries(map)) node.classList.toggle('is-active', key === name);
    this._kb.end = 0;
    this._keys = {};                     // re-render everything for the new screen
    if (name !== 'race') this.setIntroHint(false);
    if (prev === 'boot' && this.bootEl) {
      const boot = this.bootEl;
      this.bootEl = null;
      boot.classList.add('is-gone');
      setTimeout(() => boot.remove(), 700);
    }
    if (this.view) this.update(this.view);
  }

  setBootText(text) {
    const t = this.bootEl && this.bootEl.querySelector('.tk-boot-text');
    if (t) t.textContent = text;
  }

  /** Characters (incl. custom), bodies, wheels, tracks [{ id, name, track }] for pickers and tiles. */
  setCatalog(cat) {
    this.cat = { ...this.cat, ...cat };
    this._outlines = new Map((this.cat.tracks || []).map((t) => [t.id, outlinePath(t.track)]));
    this._keys = {};
    if (this.view) this.update(this.view);
  }

  /** A rendered portrait (kart + driver in its parts) for 'char|body|wheels'. */
  setPortrait(key, url) {
    if (this._portraits.get(key) === url) return;
    this._portraits.set(key, url);
    if (this.view) this._renderPanels(this.view);
  }

  hasPortrait(key) { return this._portraits.has(key); }

  // ================================================================== update (app snapshot)

  /**
   * view = { screen, mode, cc, items, host, raceNo, races, track, tracks, cup, cups,
   *          cupLocked, trackPick, players: [{ slot, color, connected, ready, step, char, body,
   *          wheels, assist, isHost, kb, name, bodyLabel, wheelsLabel, ratings, img }],
   *          settings, status, results, standings, podium, kb, lastRace }
   */
  update(v) {
    if (!v) return;
    this.view = v;
    this.el.classList.toggle('kb-mode', !!v.kb);
    const s = this.screen;
    if (s === 'lobby' || s === 'select') this._renderPanels(v);
    if (s === 'lobby') this._renderLobby(v);
    else if (s === 'select') this._renderSelect(v);
    else if (s === 'track') this._renderTrack(v);
    else if (s === 'loading') this._renderLoading(v);
    else if (s === 'results') this._renderResults(v);
    else if (s === 'standings') this._renderStandings(v);
    else if (s === 'podium') this._renderPodium(v);
    this._renderPause();
  }

  _changed(name, key) {
    if (this._keys[name] === key) return false;
    this._keys[name] = key;
    return true;
  }

  _renderPanels(v) {
    const players = v.players || [];
    for (const pnl of this.panels) {
      const p = players.find((x) => x.slot === pnl.slot) || null;
      const pk = p ? `${p.char}|${p.body}|${p.wheels}` : '';
      const portrait = p && p.char ? this._portraits.get(pk) || '' : '';
      const key = p ? `${p.connected}${p.ready}${p.step}${pk}${p.isHost}${p.kb}${p.name}${portrait ? 1 : 0}${this.screen}` : '-';
      if (!this._changed('pp' + pnl.slot, key)) continue;
      const c = pnl.el.classList;
      c.toggle('is-empty', !p);
      if (!p) continue;
      c.toggle('is-host', !!p.isHost);
      c.toggle('is-ready', !!p.ready);
      c.toggle('is-offline', !p.connected);
      c.toggle('is-kb', !!p.kb);
      c.toggle('no-char', !p.char);
      pnl.state.textContent = p.kb ? '⌨️ Keyboard' : p.connected ? '' : 'Reconnecting…';
      const lobby = this.screen === 'lobby';
      pnl.name.textContent = p.char ? p.name : lobby ? 'Joined!' : 'Picking…';
      pnl.kart.textContent = p.char ? `${p.bodyLabel} · ${p.wheelsLabel}` : '';
      pnl.stats.set(p.char ? p.ratings : null);
      pnl.step.textContent = lobby
        ? (p.isHost ? 'Picks the mode & class' : 'Waiting for the host')
        : STEP_TEXT[p.ready ? 'done' : p.step] || '';
      pnl.initial.textContent = p.char ? (p.name || '?').charAt(0) : '?';
      const src = portrait || (p.img || '');
      if (src !== pnl.src) {
        pnl.src = src;
        pnl.pic.classList.toggle('no-img', !src);
        if (src) pnl.img.src = src; else pnl.img.removeAttribute('src');
      }
      pnl.pic.style.setProperty('--c', p.cssColor || '#8890b5');
    }
  }

  _renderLobby(v) {
    if (this._changed('lobbyLines', `${v.settings}|${v.status}`)) {
      this.settingsLine.textContent = v.settings || '';
      this.statusLine.textContent = v.status || '';
    }
    const nobody = !(v.players || []).some((p) => p.connected);
    this.kbPrompt.classList.toggle('on', nobody && !v.kb);
    const kbHost = !!(v.kb && v.kbIsHost);
    this.kbLobby.classList.toggle('on', kbHost);
    if (!kbHost) return;
    const rows = this._lobbyRows(v);
    const kb = this._kb;
    kb.lobby = Math.min(kb.lobby, rows.length - 1);
    const key = rows.map((r) => `${r.id}:${r.value}`).join(',') + '|' + kb.lobby;
    if (!this._changed('kbLobby', key)) return;
    const frag = document.createDocumentFragment();
    rows.forEach((row, i) => {
      const d = el('div', 'tk-kbrow' + (i === kb.lobby ? ' is-focus' : ''), frag);
      if (row.id === 'start') {
        const b = button('tk-btn--go tk-kb-start' + (i === kb.lobby ? ' is-focus' : ''), d, 'START', 'start');
        b.dataset.row = String(i);
        return;
      }
      el('span', 'tk-kbrow-label', d, row.label);
      const seg = el('div', 'tk-seg', d);
      for (const o of row.options) {
        const b = button('tk-seg-btn' + (o.value === row.value ? ' is-on' : ''), seg, o.label, row.id);
        b.dataset.value = String(o.value);
      }
    });
    el('div', 'tk-kb-hint', frag).innerHTML = '<span class="tk-key">↑</span><span class="tk-key">↓</span> choose · '
      + '<span class="tk-key">←</span><span class="tk-key">→</span> change · <span class="tk-key">Enter</span> start · <span class="tk-key">Esc</span> leave';
    this.kbLobby.replaceChildren(frag);
  }

  _lobbyRows(v) {
    const rows = [
      { id: 'mode', label: 'Mode', value: v.mode, options: [{ value: 'gp', label: 'Grand Prix' }, { value: 'vs', label: 'VS Race' }] },
      { id: 'cc', label: 'Class', value: v.cc, options: CLASSES.map((c) => ({ value: c, label: `${c}cc` })) },
    ];
    if (v.mode === 'vs') rows.push({ id: 'items', label: 'Items', value: v.items, options: [{ value: true, label: 'On' }, { value: false, label: 'Off' }] });
    rows.push({ id: 'start', label: 'Start' });
    return rows;
  }

  _renderSelect(v) {
    if (this._changed('selLines', `${v.settings}|${v.status}`)) {
      this.selSettings.textContent = v.settings || '';
      this.selStatus.textContent = v.status || '';
    }
    if (v.kb) this._renderKbPick(v);
  }

  // ---- keyboard-mode picker (desktop version of the phone's select flow)

  _kbPlayer(v) { return (v.players || []).find((p) => p.kb) || null; }

  _kbChars() {
    const chars = this.cat.characters || [];
    const rows = WEIGHT_ROWS.map(([id, label]) => ({ label, list: chars.filter((c) => !c.custom && c.weightClass === id) }));
    const custom = chars.filter((c) => c.custom);
    if (custom.length) rows.push({ label: 'Custom', list: custom });
    return rows.filter((r) => r.list.length);
  }

  _kbList(step) {
    if (step === 'char') return this._kbChars().flatMap((r) => r.list);
    if (step === 'body') return this.cat.bodies || [];
    if (step === 'wheels') return this.cat.wheels || [];
    return [];
  }

  _renderKbPick(v) {
    const p = this._kbPlayer(v);
    const kb = this._kb;
    if (!p) { this.kbPick.replaceChildren(); return; }
    const step = p.ready ? 'done' : p.step;
    if (kb.step !== step) {
      // entering a step: the cursor starts on the current choice
      kb.step = step;
      const list = this._kbList(step);
      const cur = step === 'char' ? p.char : step === 'body' ? p.body : step === 'wheels' ? p.wheels : null;
      const i = list.findIndex((o) => o.id === cur);
      if (step === 'char' || step === 'body' || step === 'wheels') kb[step] = i >= 0 ? i : 0;
      if (step === 'ready') kb.ready = 1;
    }
    const key = `${step}|${kb.char}|${kb.body}|${kb.wheels}|${kb.ready}|${p.char}|${p.body}|${p.wheels}|${p.assist}`;
    if (!this._changed('kbPick', key)) return;
    const frag = document.createDocumentFragment();
    const steps = el('div', 'tk-kb-steps', frag);
    KB_STEPS.forEach((s, i) => {
      const done = step === 'done' || KB_STEPS.indexOf(step) > i;
      el('span', 'tk-kb-stepdot' + (s === step ? ' is-on' : done ? ' is-done' : ''), steps, ['Racer', 'Kart', 'Wheels', 'Ready'][i]);
    });
    const ch = this.cat.characters || [];
    let preview = { char: p.char, body: p.body, wheels: p.wheels };
    if (step === 'char') {
      el('div', 'tk-kb-title', frag, 'Pick your racer');
      const grid = el('div', 'tk-kb-chars', frag);
      let idx = 0;
      for (const row of this._kbChars()) {
        const r = el('div', 'tk-kb-row', grid);
        el('span', 'tk-kb-rowlabel', r, row.label);
        for (const c of row.list) {
          const on = idx === kb.char;
          const card = button('tk-kb-card' + (on ? ' is-focus' : '') + (c.id === p.char ? ' is-picked' : ''), r, '', 'char');
          card.dataset.id = c.id;
          card.style.setProperty('--c', c.cssColor || '#8890b5');
          const pic = el('span', 'tk-kb-cardpic', card);
          if (c.img) { const im = el('img', '', pic); im.alt = ''; im.src = c.img; im.addEventListener('error', () => im.remove()); }
          el('span', 'tk-kb-cardinit', pic, (c.shortName || c.name || '?').charAt(0));
          el('span', 'tk-kb-cardname', card, c.shortName || c.name);
          if (on) preview.char = c.id;
          idx++;
        }
      }
    } else if (step === 'body' || step === 'wheels') {
      el('div', 'tk-kb-title', frag, step === 'body' ? 'Pick your kart' : 'Pick your wheels');
      const list = el('div', 'tk-kb-parts', frag);
      this._kbList(step).forEach((o, i) => {
        const on = i === kb[step];
        const b = button('tk-kb-part' + (on ? ' is-focus' : '') + (o.id === p[step] ? ' is-picked' : ''), list, '', step);
        b.dataset.id = o.id;
        el('span', 'tk-kb-partname', b, o.label);
        el('span', 'tk-kb-partdesc', b, o.desc || '');
        const mods = el('span', 'tk-kb-mods', b);
        for (const [k, , abbr] of STATS) {
          const m = o.mods && o.mods[k];
          if (m) el('span', 'tk-mod ' + (m > 0 ? 'up' : 'down'), mods, `${abbr} ${signed(m)}`);
        }
        if (on) preview[step] = o.id;
      });
    } else {
      el('div', 'tk-kb-title', frag, step === 'done' ? 'Ready! Waiting for the host…' : 'Ready to race?');
      const card = el('div', 'tk-kb-ready', frag);
      const assist = button('tk-kb-toggle' + (kb.ready === 0 && step === 'ready' ? ' is-focus' : '') + (p.assist ? ' is-on' : ''), card, '', 'assist');
      assist.dataset.value = p.assist ? 'false' : 'true';
      el('span', 'tk-kb-toggle-label', assist, 'Steer Assist');
      el('span', 'tk-kb-toggle-val', assist, p.assist ? 'ON' : 'OFF');
      el('span', 'tk-kb-toggle-desc', assist, 'Keeps your kart on the road (drift charge up to orange)');
      if (step === 'ready') {
        const go = button('tk-btn--go tk-kb-go' + (kb.ready === 1 ? ' is-focus' : ''), card, 'READY!', 'ready');
        go.dataset.value = 'true';
      }
    }
    // detail: name, catchphrase, final stats of the browsed combination
    const def = ch.find((c) => c.id === preview.char) || null;
    const det = el('div', 'tk-kb-detail', frag);
    el('div', 'tk-kb-dname', det, def ? def.name : 'Pick a racer');
    el('div', 'tk-kb-dtag', det, def ? def.catchphrase || def.tagline || '' : '');
    const parts = el('div', 'tk-kb-dparts', det);
    const bl = (this.cat.bodies || []).find((b) => b.id === preview.body);
    const wl = (this.cat.wheels || []).find((w) => w.id === preview.wheels);
    parts.textContent = `${bl ? bl.label : 'Classic'} · ${wl ? wl.label : 'Standard'}`;
    const sb = statBars(det, 'tk-stats--big');
    sb.set(def ? computeRatings(def, { body: preview.body, wheels: preview.wheels }) : null);
    const hint = el('div', 'tk-kb-hint', frag);
    hint.innerHTML = step === 'done'
      ? '<span class="tk-key">Esc</span> change your picks'
      : '<span class="tk-key">←</span><span class="tk-key">→</span><span class="tk-key">↑</span><span class="tk-key">↓</span> browse · '
        + '<span class="tk-key">Enter</span> pick · <span class="tk-key">Esc</span> back';
    this.kbPick.replaceChildren(frag);
  }

  // ---- track / cup screen

  _renderTrack(v) {
    const gp = v.mode === 'gp';
    const kbHost = !!(v.kb && v.kbIsHost);
    const tracks = v.tracks || [];
    const cups = this._cups(v);
    const cup = v.cup || cups[0] || null;
    const locked = !!v.cupLocked || (v.raceNo || 0) > 0;
    const opts = gp ? [] : [...tracks.map((t) => t.id), 'random'];
    const kb = this._kb;
    if (!gp) {
      const i = opts.indexOf(v.trackPick);
      if (i >= 0) kb.track = i;
    }
    const key = `${v.mode}|${v.trackPick}|${v.status}|${v.cc}|${v.items}|${kbHost}|${v.raceNo}|${tracks.length}|${this._outlines ? this._outlines.size : 0}`
      + `|${cup ? cup.id : ''}|${cups.map((c) => c.id + ':' + c.tracks.length).join(',')}|${locked}`;
    if (!this._changed('track', key)) return;
    this.trackKicker.textContent = gp ? 'Grand Prix' : 'VS Race';
    this.trackTitle.textContent = gp ? (cup && cup.name) || 'Grand Prix' : 'Choose a track';
    // GP: one card per cup (the host picks on the phone; read-only here except in keyboard mode)
    const cf = document.createDocumentFragment();
    if (gp && cups.length > 1) {
      for (const c of cups) {
        const on = !!cup && c.id === cup.id;
        if (locked && !on) continue;
        const card = button('tk-cup' + (on ? ' is-on' : '') + (locked ? ' is-locked' : ''), cf, '', kbHost && !locked ? 'cup' : null);
        card.dataset.value = c.id;
        if (!kbHost || locked) card.tabIndex = -1;
        const art = el('span', 'tk-cup-art', card);
        art.innerHTML = CUP_ART[c.id] || CUP_ART.trophy;
        const txt = el('span', 'tk-cup-txt', card);
        el('span', 'tk-cup-name', txt, c.name);
        el('span', 'tk-cup-n', txt, `${c.tracks.length} races`);
      }
    }
    this.trackCups.replaceChildren(cf);
    this.trackCups.hidden = !this.trackCups.childElementCount;
    const frag = document.createDocumentFragment();
    let nTiles = 0;
    const tile = (id, name, label, on, done = false) => {
      nTiles++;
      const t = button('tk-tile' + (on ? ' is-on' : done ? ' is-done' : ''), frag, '', gp ? null : 'track');
      if (!gp) t.dataset.value = id;
      const map = el('span', 'tk-tile-map', t);
      const d = this._outlines && this._outlines.get(id);
      map.innerHTML = id === 'random'
        ? '<span class="tk-tile-q">?</span>'
        : `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="${d || ''}" class="tk-tile-road-o"/><path d="${d || ''}" class="tk-tile-road"/></svg>`;
      if (label) el('span', 'tk-tile-num', t, label);
      el('span', 'tk-tile-name', t, name);
    };
    if (gp) {
      const cupTracks = (cup && cup.tracks) || tracks.map((t) => t.id);
      // the next race is highlighted, finished ones dimmed
      cupTracks.forEach((ref, i) => {
        const id = typeof ref === 'string' ? ref : ref && ref.id;
        const t = tracks.find((x) => x.id === id);
        tile(id, t ? t.name : (ref && ref.name) || id, `Race ${i + 1}`, i === (v.raceNo || 0), i < (v.raceNo || 0));
      });
    } else {
      for (const t of tracks) tile(t.id, t.name, '', v.trackPick === t.id);
      tile('random', 'Random', '', v.trackPick === 'random');
    }
    this.trackTiles.replaceChildren(frag);
    this.trackTiles.dataset.n = String(nTiles);
    const cupIds = cup && cup.tracks ? cup.tracks.map((t) => (typeof t === 'string' ? t : t && t.id)) : tracks.map((t) => t.id);
    const nRaces = cupIds.length;
    const last = tracks.find((t) => t.id === cupIds[nRaces - 1]);
    this.trackSub.textContent = gp
      ? `${nRaces} races · 3 laps each · ${v.cc}cc${last && last.theme === 'castle' ? ' · castle finale' : ''}`
      : `3 laps · ${v.cc}cc · Items ${v.items ? 'on' : 'off'}`;
    this.trackStatus.textContent = kbHost ? '' : v.status || '';
    this.trackBtns.replaceChildren();
    if (kbHost) {
      const go = button('tk-btn--go is-focus', this.trackBtns, 'GO!', 'go');
      go.dataset.kb = '1';
      const pick = gp ? (cups.length > 1 && !locked ? '<span class="tk-key">←</span><span class="tk-key">→</span> cup · ' : '')
        : '<span class="tk-key">←</span><span class="tk-key">→</span> track · ';
      el('div', 'tk-kb-hint', this.trackBtns).innerHTML = pick + '<span class="tk-key">Enter</span> go · <span class="tk-key">Esc</span> back';
    }
  }

  // Cups from the app snapshot: [{ id, name, tracks: [ids] }] (refs → ids).
  _cups(v) {
    const raw = Array.isArray(v.cups) && v.cups.length ? v.cups : v.cup ? [v.cup] : [];
    return raw.filter((c) => c && c.id).map((c) => ({
      id: c.id, name: c.name || c.id,
      tracks: (Array.isArray(c.tracks) ? c.tracks : []).map((t) => (typeof t === 'string' ? t : t && t.id)).filter(Boolean),
    }));
  }

  _renderLoading(v) {
    const t = v.track || { id: '', name: '' };
    if (!this._changed('loading', `${t.id}|${v.raceNo}|${v.races}|${v.mode}`)) return;
    this.loadKicker.textContent = v.mode === 'gp' ? `${(v.cup && v.cup.name) || 'Grand Prix'} · Race ${v.raceNo} of ${v.races}` : `VS Race ${v.raceNo}`;
    this.loadName.textContent = t.name || '';
    const d = this._outlines && this._outlines.get(t.id);
    this.loadMap.innerHTML = d ? `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="${d}" class="tk-tile-road-o"/><path d="${d}" class="tk-tile-road"/></svg>` : '';
    const tips = ['Hold DRIFT through a corner, let go when the sparks turn orange!',
      'Press DRIFT in the air off a ramp for a trick boost.',
      'Steer Assist keeps you on the road — turn it off for purple mini-turbos.',
      'Heavy racers shove light ones aside. Light racers accelerate faster.',
      'Mud Grippers barely slow down on the grass.',
      'An Accordion Blast knocks away a Capo Crusher — keep one if you are leading!',
      'Way back in the pack? You might get a Beer Rocket: it carries you past five racers.',
      'Krishiv\'s Palace: the stone blocks shake before they slam. Watch their shadows!',
      'Espresso on your screen? Grab a Toot or roll over a boost pad to wash it off.'];
    this.loadTip.textContent = tips[(v.raceNo + (t.id ? t.id.length : 0)) % tips.length];
  }

  // ---- results / standings / podium

  _endButtons(container, v, which) {
    container.replaceChildren();
    if (!(v.kb && v.kbIsHost)) return;
    const labels = which === 'podium' ? [['next', 'Back to lobby']]
      : [['next', which === 'results' ? 'Next' : v.mode === 'gp' ? (v.raceNo >= v.races ? 'Trophy!' : 'Next race') : 'Next race'], ['quit', 'Lobby']];
    this._kb.end = Math.min(this._kb.end, labels.length - 1);
    labels.forEach(([action, label], i) => {
      button('tk-btn--menu ' + (i === 0 ? 'green' : 'blue') + (i === this._kb.end ? ' is-focus' : ''), container, label, action);
    });
  }

  _row(parent, r, i, cols) {
    const row = el('div', 'tk-res-row' + (r.slot ? ' is-player' : ''), parent);
    row.style.setProperty('--c', r.cssColor || '#8890b5');
    if (r.slot) row.style.setProperty('--slot', slotInfo(r.slot).css);
    row.style.setProperty('--d', `${0.08 + i * 0.06}s`);
    const pl = el('span', 'tk-res-pl', row);
    el('span', 'tk-place' + (r.place >= 1 && r.place <= 3 ? ' p' + r.place : ''), pl, r.place ? ordinal(r.place) : '–');
    const nm = el('span', 'tk-res-nm', row);
    el('i', 'tk-chip', nm);
    el('span', 'tk-res-name', nm, r.name || '???');
    if (r.slot) el('span', 'tk-you', nm, slotInfo(r.slot).label);
    for (const c of cols) {
      if (c === 'time') {
        const est = r.finished === false;
        const tm = el('span', 'tk-res-tm' + (est ? ' est' : ''), row, Number.isFinite(r.time) ? `${est ? '~' : ''}${formatTime(r.time)}` : '--:--.---');
        if (est) tm.title = 'Still racing — estimated time';
      } else if (c === 'plus') {
        el('span', 'tk-res-pts plus', row, r.points ? `+${r.points}` : '');
      } else if (c === 'total') {
        el('span', 'tk-res-pts', row, String(r.points || 0));
      }
    }
  }

  _renderResults(v) {
    const rows = v.results || [];
    const key = JSON.stringify(rows) + `|${v.kb && v.kbIsHost}|${this._kb.end}|${v.status}`;
    if (!this._changed('results', key)) return;
    this.resTitle.textContent = v.track ? v.track.name : 'Results';
    const best = rows.filter((r) => r.slot).sort((a, b) => a.place - b.place)[0];
    this.resTitle.className = 'tk-res-title' + (best && best.place <= 3 ? ' p' + best.place : '');
    this.resSub.textContent = `${v.mode === 'gp' ? `Race ${v.raceNo} of ${v.races}` : `VS race ${v.raceNo}`} · ${v.cc}cc · 3 laps${v.mode === 'vs' && !v.items ? ' · no items' : ''}`;
    const frag = document.createDocumentFragment();
    const th = el('div', 'tk-res-row tk-res-headrow', frag);
    for (const [cls, text] of [['pl', 'Pos'], ['nm', 'Racer'], ['tm', 'Time'], ['pts', 'Pts']]) el('span', 'tk-res-' + cls, th, text);
    rows.forEach((r, i) => this._row(frag, r, i, ['time', 'plus']));
    this.resBody.replaceChildren(frag);
    this.resHint.textContent = v.kb ? '' : v.status || '';
    this._endButtons(this.resBtns, v, 'results');
  }

  _renderStandings(v) {
    const rows = v.standings || [];
    const key = JSON.stringify(rows) + `|${v.kb && v.kbIsHost}|${this._kb.end}|${v.status}`;
    if (!this._changed('standings', key)) return;
    this.stdTitle.textContent = v.mode === 'gp' ? `${(v.cup && v.cup.name) || 'Grand Prix'} standings` : 'VS standings';
    this.stdTitle.className = 'tk-res-title';
    this.stdSub.textContent = v.mode === 'gp' ? `After race ${v.raceNo} of ${v.races}` : `After ${v.raceNo} race${v.raceNo === 1 ? '' : 's'}`;
    const frag = document.createDocumentFragment();
    const th = el('div', 'tk-res-row tk-res-headrow tk-std-row', frag);
    for (const [cls, text] of [['pl', 'Pos'], ['nm', 'Racer'], ['pts', ''], ['pts', 'Total']]) el('span', 'tk-res-' + cls, th, text);
    rows.forEach((r, i) => {
      // "+gained" this race, then the running total
      this._row(frag, { ...r, points: r.gained }, i, ['plus']);
      const line = frag.lastChild;
      line.classList.add('tk-std-row');
      el('span', 'tk-res-pts', line, String(r.points || 0));
    });
    this.stdBody.replaceChildren(frag);
    this.stdHint.textContent = v.kb ? '' : v.status || '';
    this._endButtons(this.stdBtns, v, 'standings');
  }

  _renderPodium(v) {
    const top = v.podium || [];
    const key = JSON.stringify(top) + `|${v.kb && v.kbIsHost}|${v.status}`;
    if (!this._changed('podium', key)) return;
    this.podKicker.textContent = `${(v.cup && v.cup.name) || 'Grand Prix'} · ${v.cc}cc`;
    const w = top[0];
    this.podWinner.textContent = w ? `🏆 ${w.name}${w.slot ? ` (${slotInfo(w.slot).label})` : ''} wins!` : 'Champions';
    const frag = document.createDocumentFragment();
    // 2nd · 1st · 3rd, like the 3D podium behind
    for (const i of [1, 0, 2]) {
      const r = top[i];
      const plate = el('div', 'tk-pod-plate p' + (i + 1), frag);
      if (!r) continue;
      plate.style.setProperty('--c', r.cssColor || '#8890b5');
      el('span', 'tk-place p' + (i + 1), plate, ordinal(i + 1));
      el('span', 'tk-pod-name', plate, r.name);
      if (r.slot) { const t = el('span', 'tk-you', plate, slotInfo(r.slot).label); t.style.setProperty('--slot', slotInfo(r.slot).css); }
      el('span', 'tk-pod-pts', plate, `${r.points} pts`);
    }
    this.podPlates.replaceChildren(frag);
    this.podHint.textContent = v.kb ? '' : v.status || '';
    this._endButtons(this.podBtns, v, 'podium');
  }

  // ---- pause overlay

  /** Pause overlay: null = hidden; { by: 'P2', color, kb (keyboard host: buttons), hostLabel }. */
  setPaused(p) {
    this._paused = p || null;
    this._kb.pause = 0;
    this._keys.pause = null;
    this._renderPause();
  }

  _renderPause() {
    const p = this._paused;
    const key = p ? `${p.by}|${p.kb}|${p.hostLabel}|${this._kb.pause}` : '-';
    if (!this._changed('pause', key)) return;
    this.pauseEl.classList.toggle('is-active', !!p);
    if (!p) return;
    this.pauseBy.textContent = p.by ? `${p.by} paused the race` : '';
    this.pauseBy.style.color = p.color || '';
    this.pauseHint.innerHTML = p.kb
      ? '<span class="tk-key">Esc</span> resume &nbsp; <span class="tk-key">M</span> mute &nbsp; <span class="tk-key">H</span> controls'
      : `Anyone can resume from their phone (or press <span class="tk-key">Esc</span>).<br>${p.hostLabel || 'The host'} can restart or quit.`;
    this.pauseBtnsEl.hidden = !p.kb;
    this.pauseBtns.forEach((b, i) => b.classList.toggle('is-focus', !!p.kb && i === this._kb.pause));
  }

  // ================================================================== phone / QR

  /** Merge phone link state: { status: 'connecting'|'online'|'offline', room, padUrl, qrSvg } */
  setPhone(patch = {}) {
    Object.assign(this._phone, patch);
    this._renderPhone();
  }

  _renderPhone() {
    const ph = this._phone;
    const qrKey = ph.status === 'online' ? ph.qrSvg : null;
    for (const q of [this.lobbyQR, this.selectQR]) {
      const p = q.el;
      p.classList.toggle('is-online', ph.status === 'online');
      p.classList.toggle('is-offline', ph.status === 'offline');
      p.classList.toggle('is-connecting', ph.status === 'connecting');
      if (qrKey !== this._qrKey) {
        // qrSvg comes from our own server (qrcode.toString), not from user input.
        q.svg.innerHTML = qrKey || '';
        const svg = q.svg.querySelector('svg');
        if (svg) { svg.removeAttribute('width'); svg.removeAttribute('height'); svg.setAttribute('aria-label', 'QR code for the phone controller'); }
      }
      q.url.textContent = ph.status === 'online' && ph.padUrl ? ph.padUrl : '';
      let text;
      if (ph.status === 'offline') text = 'Offline — keyboard & gamepad still work!';
      else if (ph.status === 'connecting') text = 'Connecting to the game server…';
      else text = `Room ${ph.room || '····'} · up to 4 phones`;
      q.statusText.textContent = text;
      q.scan.textContent = ph.status === 'offline' ? `Phone steering needs the ${GAME_TITLE} server — start the game with “npm start”.`
        : 'Scan with the camera app — each phone becomes a steering wheel';
    }
    this._qrKey = qrKey;
  }

  // ================================================================== small UI bits

  setMuted(muted) {
    this.muted = !!muted;
    this.muteBtn.innerHTML = muted ? ICON_MUTED : ICON_SPEAKER;
    this.muteBtn.classList.toggle('is-muted', !!muted);
  }

  setSoundHint(on) { this.soundHint.classList.toggle('on', !!on); }

  /** Quick dip from black — hides camera cuts between 3D scenes. */
  dip() {
    const d = this.dipEl;
    d.classList.remove('on');
    void d.offsetWidth;
    d.classList.add('on');
  }

  /** Brief race feedback flash over one view rect (null = full screen): 'zap' | 'hit' | 'star'. */
  screenFlash(kind = 'hit', rect = null) {
    const f = this.fxEl;
    f.dataset.kind = kind;
    const st = f.style;
    if (rect) { st.left = `${rect.x}px`; st.top = `${rect.y}px`; st.width = `${rect.w}px`; st.height = `${rect.h}px`; st.right = 'auto'; st.bottom = 'auto'; }
    else { st.left = st.top = st.width = st.height = st.right = st.bottom = ''; }
    f.classList.remove('on');
    void f.offsetWidth;            // restart the animation
    f.classList.add('on');
  }

  /** key: what skips the intro ('Enter' on the keyboard, 'ITEM' on a phone). */
  setIntroHint(on, key = null) {
    if (key && this.introKey.textContent !== key) this.introKey.textContent = key;
    this.introHint.classList.toggle('on', !!on);
  }

  get helpOpen() { return this._helpOpen; }

  toggleHelp(force) {
    const on = force === undefined ? !this._helpOpen : !!force;
    if (on === this._helpOpen) return on;
    this._helpOpen = on;
    this.helpEl.classList.toggle('is-open', on);
    return on;
  }

  toast(text, { icon = '', tone = 'info', duration = 2.6 } = {}) {
    const t = this.toastEl;
    this.toastIcon.textContent = icon;
    this.toastIcon.hidden = !icon;
    this.toastText.textContent = text;
    t.dataset.tone = tone;
    t.classList.remove('on');
    void t.offsetWidth;            // restart the enter animation
    t.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('on'), Math.max(0.8, duration) * 1000);
  }

  // ================================================================== keyboard mode input

  _sound(name) { if (this.audio) this.audio.play(name); }

  /**
   * Keyboard / gamepad menu edges { left, right, up, down, confirm, back }.
   * Outside keyboard mode only "Enter on the lobby" (join with the keyboard)
   * and closing the help overlay do anything. Returns true if consumed.
   */
  handleNav(menu) {
    if (!menu) return false;
    const { left, right, up, down, confirm, back } = menu;
    if (!(left || right || up || down || confirm || back)) return false;
    if (this._helpOpen) {
      if (confirm || back) { this.onAction('help', { close: true }); return true; }
      return true;               // modal: swallow navigation
    }
    const v = this.view;
    if (!v) return false;
    if (this._paused) return this._navPause(menu);
    if (!v.kb) {
      if (this.screen === 'lobby' && confirm && !(v.players || []).some((p) => p.connected)) { this.onAction('kbJoin', {}); return true; }
      return false;
    }
    const p = this._kbPlayer(v);
    const host = !!v.kbIsHost;
    const kb = this._kb;
    const h = (right ? 1 : 0) - (left ? 1 : 0), vv = (down ? 1 : 0) - (up ? 1 : 0);
    switch (this.screen) {
      case 'lobby': {
        if (!host) return false;
        if (back) { this.onAction('kbLeave', {}); return true; }
        const rows = this._lobbyRows(v);
        const row = rows[Math.min(kb.lobby, rows.length - 1)];
        if (confirm) {
          if (row.id === 'start') this.onAction('start', {});
          else { kb.lobby = Math.min(rows.length - 1, kb.lobby + 1); this._sound('menuMove'); this._renderLobby(v); }
          return true;
        }
        if (vv) { kb.lobby = (kb.lobby + vv + rows.length) % rows.length; this._sound('menuMove'); this._renderLobby(v); return true; }
        if (h && row.options) {
          const i = row.options.findIndex((o) => o.value === row.value);
          const o = row.options[(i + h + row.options.length) % row.options.length];
          this.onAction(row.id, { value: o.value });
        }
        return true;
      }
      case 'select': {
        if (!p) return false;
        const step = p.ready ? 'done' : p.step;
        if (back) { this.onAction('back', {}); return true; }
        if (step === 'done') return true;
        if (step === 'ready') {
          if (vv || h) { kb.ready = 1 - kb.ready; this._sound('menuMove'); this._renderKbPick(v); }
          else if (confirm) {
            if (kb.ready === 0) this.onAction('assist', { value: !p.assist });
            else this.onAction('ready', { value: true });
          }
          return true;
        }
        const list = this._kbList(step);
        if (!list.length) return true;
        if (confirm) { this.onAction(step, { id: list[kb[step]].id }); return true; }
        let i = kb[step];
        if (step === 'char') i = this._gridMove(i, h, vv);
        else { const cols = 3; i = vv ? i + vv * cols : i + h; i = Math.max(0, Math.min(list.length - 1, i)); }
        if (i !== kb[step]) { kb[step] = i; this._sound('menuMove'); this._renderKbPick(v); }
        return true;
      }
      case 'track': {
        if (!host) return false;
        if (back) { this.onAction('back', {}); return true; }
        if (confirm) { this.onAction('go', {}); return true; }
        if (v.mode === 'vs' && h) {
          const opts = [...(v.tracks || []).map((t) => t.id), 'random'];
          kb.track = (kb.track + h + opts.length) % opts.length;
          this.onAction('track', { value: opts[kb.track] });
        } else if (v.mode === 'gp' && (h || vv) && !v.cupLocked && !(v.raceNo > 0)) {
          const cups = this._cups(v);
          if (cups.length > 1) {
            const i = Math.max(0, cups.findIndex((c) => v.cup && c.id === v.cup.id));
            this.onAction('cup', { id: cups[(i + (h || vv) + cups.length) % cups.length].id });
          }
        }
        return true;
      }
      case 'results': case 'standings': case 'podium': {
        if (!host) return false;
        const n = this.screen === 'podium' ? 1 : 2;
        if (confirm) { this.onAction(kb.end === 1 ? 'quit' : 'next', {}); return true; }
        if (back) { this.onAction('quit', {}); return true; }
        if ((h || vv) && n > 1) { kb.end = 1 - kb.end; this._sound('menuMove'); this._keys[this.screen] = null; this.update(v); }
        return true;
      }
      default:
        return false;
    }
  }

  // Character grid: rows of 4 (Light / Medium / Heavy [/ Custom]).
  _gridMove(i, h, vv) {
    const rows = this._kbChars();
    let r = 0, c = i;
    while (r < rows.length && c >= rows[r].list.length) { c -= rows[r].list.length; r++; }
    if (r >= rows.length) return 0;
    if (h) c = Math.max(0, Math.min(rows[r].list.length - 1, c + h));
    if (vv) { r = Math.max(0, Math.min(rows.length - 1, r + vv)); c = Math.min(c, rows[r].list.length - 1); }
    let out = c;
    for (let k = 0; k < r; k++) out += rows[k].list.length;
    return out;
  }

  _navPause({ up, down, left, right, confirm }) {
    const p = this._paused;
    if (!p.kb) return false;
    // (Esc / P resume through main's pause toggle)
    const d = (down || right ? 1 : 0) - (up || left ? 1 : 0);
    if (confirm) { this.onAction(this.pauseBtns[this._kb.pause].dataset.action, {}); return true; }
    if (d) { this._kb.pause = (this._kb.pause + d + 3) % 3; this._sound('menuMove'); this._renderPause(); }
    return true;
  }

  // Mouse: corner buttons always; pickers only in keyboard mode.
  _click(e) {
    if (e.target === this.helpEl) { this.onAction('help', { close: true }); return; }   // backdrop
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const action = b.dataset.action;
    b.blur();                       // keep Enter/Space for the game, not the button
    if (action === 'help') { this.onAction('help', b.dataset.close ? { close: true } : {}); return; }
    if (action === 'mute') { this.onAction('mute', {}); return; }
    const v = this.view;
    if (!v || !v.kb) return;        // the desktop is a display while phones play
    if (action === 'char' || action === 'body' || action === 'wheels') this.onAction(action, { id: b.dataset.id });
    else if (action === 'mode') this.onAction('mode', { value: b.dataset.value });
    else if (action === 'cc') this.onAction('cc', { value: Number(b.dataset.value) });
    else if (action === 'items' || action === 'assist' || action === 'ready') this.onAction(action, { value: b.dataset.value === 'true' });
    else if (action === 'track') this.onAction('track', { value: b.dataset.value });
    else if (action === 'cup') this.onAction('cup', { id: b.dataset.value });
    else this.onAction(action, {});
  }

  dispose() {
    clearTimeout(this._toastTimer);
    this.el.removeEventListener('click', this._onClick);
    this.el.remove();
  }
}
