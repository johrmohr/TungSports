// In-race HUD: a DOM overlay (styles in css/game.css) drawn above the WebGL canvas.
//
//   const hud = new HUD(document.getElementById('hud'), { audio });  // audio optional
//   hud.setTrack(track);           // pre-renders the minimap outline
//   hud.setRect(null);             // full screen (1P) — or a split-screen view:
//   hud.setRect({ x, y, w, h }, { compact: true, color: '#2f7bff', label: 'P2' });
//   hud.show();
//   // every frame:
//   hud.update(dt, { player, race, karts, items, phoneConnected, slotColors });
//   hud.updateTags(camera, tags);  // split-screen: "P2"-style tags over other humans' karts
//   hud.countdown(3) … hud.countdown(0);   hud.flash('FINAL LAP!', { color: '#ff5a3c' });
//   hud.flash('KABOOM!', { size: 'medium', sub: 'Bolt', subColor: '#2f6bff' });   // + name pill
//   hud.setWrongWay(true);  hud.showFinish(1);  hud.reset();
//
// Elements: lap + race timer (top-left), item slot with roulette (top-right),
// phone badge (top-center), minimap (bottom-left), speedometer + drift charge
// + place badge (bottom-right), countdown / flash / wrong-way / finish (center).
// Split-screen (SPEC §14.6): one HUD per view, positioned on the view's rect
// with its own --u unit (everything scales with the view); compact mode hides
// the per-view minimap (SharedHud draws one for everybody) and adds a border
// + "P2" chip in the slot color. Minimap + SharedHud are exported too.
// The DOM is only touched when a displayed value changes; animations use the
// Web Animations API (compositor-friendly transforms/opacity).
//
// Roulette ticks: if an `audio` (AudioEngine) is passed, the HUD plays the
// 'roulette' tick in sync with its reel. It also emits bus 'hud:rouletteTick'
// { progress } — use one or the other, not both.
//
// v4 items (SPEC §15.2), per view:
//   hud.splash(strength 0..1, duration s)  coffee splattered over this view (Espresso Splash)
//   hud.warn('capo' | null)                siren banner: a Capo Crusher is coming for this player
// update() also follows its player's item state by itself (items.js writes
// kart.ink / kart.capoWarn / kart.goldenTimer / kart.beer), so main.js needs no
// extra calls: the coffee lands with the item's own timing, the siren runs while
// the capo is on its way (faster once it locks on) and the HUD plays the 'splat'
// and 'capoSiren' sounds for its player through `audio`. Explicit splash() /
// warn() calls combine with that (the stronger one shows). The item slot shows
// triple counts, a draining gold ring for a running Golden Toot and a glowing
// mug while a Beer Rocket rides.

import * as THREE from 'three';
import { ITEM_INFO, ITEM_IDS, ITEM, DRIFT, KART, RACE, COIN, itemEnabled } from './config.js';
import { clamp, ordinal } from './utils.js';
import { bus } from './bus.js';

const PLACE_FILLS = {
  1: 'linear-gradient(180deg, #fffbe6 0%, #ffe680 30%, #ffc21a 52%, #f29100 78%, #ffd45c 100%)',
  2: 'linear-gradient(180deg, #ffffff 0%, #eef3f8 32%, #b9c5d3 54%, #8d9bad 76%, #dfe6ee 100%)',
  3: 'linear-gradient(180deg, #ffe9d2 0%, #f7b47a 32%, #c9773a 55%, #9c5427 78%, #e39a62 100%)',
  other: 'linear-gradient(180deg, #ffffff 0%, #ffffff 50%, #d9defa 100%)',
};
const COUNT_FILLS = {
  3: 'linear-gradient(180deg, #fff1f1 0%, #ff8a8a 40%, #ff2e4d 75%, #d4002f 100%)',
  2: 'linear-gradient(180deg, #fff8e6 0%, #ffd27a 40%, #ff9d1a 75%, #e06a00 100%)',
  1: 'linear-gradient(180deg, #fffde6 0%, #fff27a 40%, #ffd91a 75%, #f0b400 100%)',
  0: 'linear-gradient(180deg, #f0fff4 0%, #9dff9a 35%, #2ee86a 70%, #00b84a 100%)',
};
const DRIFT_NAMES = ['', 'MINI', 'SUPER', 'ULTRA'];

// One icon per distinct item look, cycled by the roulette reel (items the
// roulette can hand out: config ITEM_ENABLED).
const REEL_ICONS = [...new Set(ITEM_IDS.filter((id) => itemEnabled(id)).map((id) => ITEM_INFO[id].icon))];

// Minimap orientation: rotate the world so the start straight points up.
const MAP_ROT = Math.PI;

let hudCounter = 0;
// A coffee splat: an irregular blob path around (cx, cy) with radius r (SVG units).
function blobPath(cx, cy, r, rnd, lobes = 9) {
  const pts = [];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + rnd() * 0.35;
    const rr = r * (0.62 + 0.55 * rnd());
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  let d = '';
  for (let i = 0; i < lobes; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % lobes];
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    if (i === 0) d += `M ${mx.toFixed(1)} ${my.toFixed(1)} `;
    const [x2, y2] = pts[(i + 2) % lobes];
    d += `Q ${x1.toFixed(1)} ${y1.toFixed(1)} ${((x1 + x2) / 2).toFixed(1)} ${((y1 + y2) / 2).toFixed(1)} `;
  }
  return d + 'Z';
}
const SPLASH_SPOTS = [[50, 46, 26], [22, 30, 17], [79, 28, 16], [16, 72, 15], [83, 70, 18], [37, 80, 12], [64, 82, 13], [52, 14, 10]];
const MAX_TAGS = 3;                  // other humans a view can show tags for
const TAG_RANGE = 160;               // m: tags fade out beyond this distance
const _tagPos = new THREE.Vector3();

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

// Text with a thick outline: an outlined back copy under a gradient-filled front copy.
function outlined(cls, parent, text = '') {
  const wrap = el('span', 'olt ' + cls, parent);
  const back = el('span', 'olt-back', wrap, text);
  const front = el('span', 'olt-front', wrap, text);
  back.setAttribute('aria-hidden', 'true');
  return {
    el: wrap,
    text,
    set(t) {
      if (t === this.text) return;
      this.text = t;
      back.textContent = t;
      front.textContent = t;
    },
    fill(css) { wrap.style.setProperty('--fill', css); },
  };
}

// Whole centiseconds of a time in seconds (floored; 0 for negative / NaN).
const toCs = (t) => (Number.isFinite(t) && t > 0 ? Math.floor(t * 100 + 1e-6) : 0);

// m:ss.cc from whole centiseconds
function fmtCs(cs) {
  const m = Math.floor(cs / 6000), rem = cs - m * 6000;
  const whole = Math.floor(rem / 100), frac = rem - whole * 100;
  return `${m}:${whole < 10 ? '0' : ''}${whole}.${frac < 10 ? '0' : ''}${frac}`;
}
const fmtClock = (t) => fmtCs(toCs(t));

const POP = [
  { transform: 'scale(1)' },
  { transform: 'scale(1.38)', offset: 0.28 },
  { transform: 'scale(0.94)', offset: 0.62 },
  { transform: 'scale(1)' },
];
const POP_OPTS = { duration: 460, easing: 'ease-out' };
// v5 lire counter: a quick pop on a gain, a red shake on a loss
const COIN_POP = [{ transform: 'scale(1)' }, { transform: 'scale(1.22)', offset: 0.35 }, { transform: 'scale(1)' }];
const COIN_LOSS = [
  { transform: 'translateX(0)', filter: 'none' },
  { transform: 'translateX(-6%)', filter: 'hue-rotate(-45deg) saturate(2.2)', offset: 0.2 },
  { transform: 'translateX(5%)', offset: 0.45 },
  { transform: 'translateX(-3%)', offset: 0.7 },
  { transform: 'translateX(0)', filter: 'none' },
];

export class HUD {
  constructor(root, { audio = null } = {}) {
    this.root = root;
    this.audio = audio;
    this.track = null;
    this.visible = false;
    this._id = ++hudCounter;
    this.rect = null;               // view rect in CSS px (null = full screen)
    this.compact = false;
    this._build();
    this._onResize = () => this.map.invalidate();
    window.addEventListener('resize', this._onResize);
    this.reset();
  }

  // ------------------------------------------------------------------ DOM

  _build() {
    const r = el('div', 'hud hud--hidden', this.root);
    this.el = r;

    // espresso splash overlay (under every other widget) + the capo siren banner
    this.splashEl = el('div', 'hud-splash', r);
    this.cupEl = el('div', 'hud-cup', r, ITEM_INFO.espresso ? ITEM_INFO.espresso.icon : '');
    this.warnEl = el('div', 'hud-warn', r);
    el('span', 'hud-warn-siren', this.warnEl);
    el('span', 'hud-warn-icon', this.warnEl, ITEM_INFO.capo ? ITEM_INFO.capo.icon : '!');
    this.warnText = el('span', 'hud-warn-text', this.warnEl, 'CAPO CRUSHER!');

    // top-left: lap + timer
    const tl = el('div', 'hud-tl', r);
    const lap = el('div', 'hud-lap', tl);
    el('span', 'hud-lap-label', lap, 'LAP');
    this.lapNum = el('span', 'hud-lap-num', lap, '1');
    this.lapTotal = el('span', 'hud-lap-total', lap, '/3');
    this.lapEl = lap;
    const timer = el('div', 'hud-timer', tl);
    this.timerText = document.createTextNode('0:00.00');
    timer.appendChild(this.timerText);
    this.split = el('div', 'hud-split', tl);
    // v5 lire counter (setCoins): a gold lira + the count, glowing at the cap
    this.coinsEl = el('div', 'hud-coins', tl);
    el('span', 'hud-coins-icon', this.coinsEl, '₤');
    this.coinsNum = el('span', 'hud-coins-num', this.coinsEl, '0');
    el('span', 'hud-coins-max', this.coinsEl, `/${COIN.max}`);

    // top-center: phone badge
    this.phone = el('div', 'hud-phone', r);
    el('span', 'hud-phone-dot', this.phone);
    el('span', 'hud-phone-icon', this.phone, '📱');
    this.phoneText = el('span', 'hud-phone-text', this.phone, 'PHONE CONNECTED');

    // top-right: item slot
    const item = el('div', 'hud-item', r);
    this.itemEl = item;
    const ring = el('div', 'hud-item-ring', item);
    el('div', 'hud-item-ring-spin', ring);
    const frame = el('div', 'hud-item-frame', item);
    this.itemFrame = frame;
    el('div', 'hud-item-shine', frame);
    this.itemIcon = el('div', 'hud-item-icon', frame);
    this.itemGlyph = el('span', '', this.itemIcon, '');
    this.itemBurst = el('div', 'hud-item-burst', item);
    this.itemCount = el('div', 'hud-item-count', item);
    this.itemName = el('div', 'hud-item-name', item);
    this.itemMeter = el('div', 'hud-item-meter', item);     // Golden Toot window, draining
    // v5 Hot Potato fuse on the carrier's view (kart.potatoTimer): a potato in a draining ring + seconds
    this.potatoEl = el('div', 'hud-potato', r);
    el('span', 'hud-potato-icon', this.potatoEl, ITEM_INFO.hot_potato ? ITEM_INFO.hot_potato.icon : '!');
    this.potatoNum = el('span', 'hud-potato-num', this.potatoEl, '');

    // bottom-left: minimap
    const map = el('div', 'hud-map', r);
    this.mapEl = map;
    this.map = new Minimap(map);

    // bottom-right: speedometer, drift charge, place
    const br = el('div', 'hud-br', r);
    const spd = el('div', 'hud-speed', br);
    this.speedEl = spd;
    const gid = `hudSpd${this._id}`, bid = `hudBoost${this._id}`, sid = `hudStar${this._id}`;
    spd.innerHTML = `
      <svg class="hud-speed-svg" viewBox="0 0 100 78" aria-hidden="true">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#3be8ff"/><stop offset="0.55" stop-color="#8f7bff"/><stop offset="1" stop-color="#ff4fa0"/>
          </linearGradient>
          <linearGradient id="${bid}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#ffe14d"/><stop offset="0.5" stop-color="#ff9d2e"/><stop offset="1" stop-color="#ff3b2e"/>
          </linearGradient>
          <linearGradient id="${sid}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#ff4f6d"/><stop offset="0.2" stop-color="#ffb02e"/><stop offset="0.4" stop-color="#fff24d"/>
            <stop offset="0.6" stop-color="#4dff7a"/><stop offset="0.8" stop-color="#38c8ff"/><stop offset="1" stop-color="#b56bff"/>
          </linearGradient>
        </defs>
        <path class="hud-speed-track" d="M 18.9 66.8 A 38 38 0 1 1 81.1 66.8" pathLength="100"/>
        <path class="hud-speed-ticks" d="M 13.5 70.6 A 44.5 44.5 0 1 1 86.5 70.6" pathLength="100"/>
        <path class="hud-speed-val" d="M 18.9 66.8 A 38 38 0 1 1 81.1 66.8" pathLength="100"
              stroke="url(#${gid})" data-normal="url(#${gid})" data-boost="url(#${bid})" data-star="url(#${sid})"/>
      </svg>`;
    this.speedVal = spd.querySelector('.hud-speed-val');
    this.speedNum = el('div', 'hud-speed-num', spd, '0');
    el('div', 'hud-speed-unit', spd, 'KM/H');

    const drift = el('div', 'hud-drift', spd);
    this.driftEl = drift;
    this.driftSegs = [];
    const bar = el('div', 'hud-drift-bar', drift);
    for (let k = 1; k <= 3; k++) {
      const seg = el('div', 'hud-drift-seg', bar);
      seg.style.setProperty('--seg', DRIFT.tierColors[k]);
      this.driftSegs.push(el('i', '', seg));
    }
    this.driftLabel = el('div', 'hud-drift-label', drift, '');

    const place = el('div', 'hud-place', br);
    this.placeEl = place;
    this.placeNum = outlined('hud-place-num', place, '8');
    this.placeSuf = outlined('hud-place-suf', place, 'th');

    // center layers
    const c = el('div', 'hud-center', r);
    this.countEl = el('div', 'hud-count', c);
    this.countBurst = el('div', 'hud-count-burst', this.countEl);
    this.countText = outlined('hud-count-text', this.countEl, '');
    this.flashEl = el('div', 'hud-flash', c);
    this.flashText = outlined('hud-flash-text', this.flashEl, '');
    this.flashSub = el('div', 'hud-flash-sub', this.flashEl);
    this.flashSubText = document.createTextNode('');
    this.flashSub.appendChild(this.flashSubText);
    this.wrongEl = el('div', 'hud-wrong', c);
    this.wrongEl.innerHTML = `
      <svg class="hud-wrong-icon" viewBox="0 0 64 64" aria-hidden="true">
        <path d="M44 50V26a12 12 0 0 0-24 0v8" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>
        <path d="M8 30l12 14 12-14z" fill="currentColor"/>
      </svg>`;
    el('span', 'hud-wrong-text', this.wrongEl, 'WRONG WAY!');
    this.finishEl = el('div', 'hud-finish', c);
    el('div', 'hud-finish-band', this.finishEl);
    this.finishTitle = outlined('hud-finish-title', this.finishEl, 'FINISH!');
    this.finishPlace = outlined('hud-finish-place', this.finishEl, '');
    this.finishTime = el('div', 'hud-finish-time', this.finishEl, '');
    el('div', 'hud-finish-band', this.finishEl);

    // split-screen: slot-colored view border + "P2" chip, tags over other humans
    this.frameEl = el('div', 'hud-frame', r);
    this.slotChip = el('div', 'hud-slot', r);
    this.tagEls = [];
    for (let k = 0; k < MAX_TAGS; k++) {
      const t = el('div', 'hud-tag', r);
      t.style.visibility = 'hidden';
      this.tagEls.push({ el: t, label: '', color: '', shown: false });
    }
  }

  /**
   * Position the HUD on a view rect ({ x, y, w, h } CSS px, null = full screen).
   * compact: split-screen look (no own minimap, border + slot chip).
   * avoid: { corner, w } — that corner sits next to the shared minimap.
   */
  setRect(rect, { compact = false, color = '', label = '', avoid = null } = {}) {
    const st = this.el.style;
    this.rect = rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null;
    this.compact = !!compact;
    if (rect) {
      st.left = `${rect.x}px`; st.top = `${rect.y}px`; st.width = `${rect.w}px`; st.height = `${rect.h}px`;
      st.right = 'auto'; st.bottom = 'auto';
      // narrow 2P views (~8:9) use their width a little more generously than 16:9
      const u = compact ? Math.min(rect.h / 100, rect.w * 0.0075) : Math.min(rect.h / 100, rect.w * 0.005625);
      st.setProperty('--u', `${u.toFixed(3)}px`);
    } else {
      for (const k of ['left', 'top', 'width', 'height', 'right', 'bottom']) st[k] = '';
      st.removeProperty('--u');
    }
    this.el.classList.toggle('hud--compact', this.compact);
    // keep the corner that touches the shared center minimap clear (4P):
    // avoid = { corner: 'tl'|'tr'|'bl'|'br', w } pushes that corner's widgets inward
    for (const c of ['tl', 'tr', 'bl', 'br']) this.el.classList.toggle('avoid-' + c, !!avoid && avoid.corner === c);
    if (avoid) this.el.style.setProperty('--avoid', `${Math.round(avoid.w)}px`); else this.el.style.removeProperty('--avoid');
    if (color) this.el.style.setProperty('--slot', color); else this.el.style.removeProperty('--slot');
    this.slotChip.textContent = label || '';
    this.slotChip.hidden = !(compact && label);
    this.map.invalidate();
  }

  /**
   * Tags over other humans' karts in this view: tags = [{ kart, label, color }]
   * (at most MAX_TAGS). Projected with the view's camera; hidden behind it,
   * off-view or far away. Writes the DOM only when something changes.
   */
  updateTags(camera, tags) {
    const n = tags ? Math.min(tags.length, MAX_TAGS) : 0;
    const w = this.rect ? this.rect.w : window.innerWidth, h = this.rect ? this.rect.h : window.innerHeight;
    for (let k = 0; k < MAX_TAGS; k++) {
      const t = this.tagEls[k];
      let show = false;
      if (k < n && camera && this.visible) {
        const g = tags[k];
        const kp = g.kart.position;
        const dx = kp.x - camera.position.x, dy = kp.y - camera.position.y, dz = kp.z - camera.position.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < TAG_RANGE) {
          _tagPos.set(kp.x, kp.y + 2.1, kp.z).project(camera);
          if (_tagPos.z < 1 && _tagPos.z > -1 && Math.abs(_tagPos.x) < 1.05 && Math.abs(_tagPos.y) < 1.05) {
            show = true;
            if (t.label !== g.label) { t.label = g.label; t.el.textContent = g.label; }
            if (t.color !== g.color) { t.color = g.color; t.el.style.setProperty('--c', g.color); }
            const x = (_tagPos.x * 0.5 + 0.5) * w, y = (-_tagPos.y * 0.5 + 0.5) * h;
            const sc = clamp(1.25 - d / TAG_RANGE, 0.55, 1.1);
            t.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${sc.toFixed(2)})`;
            t.el.style.opacity = d > TAG_RANGE * 0.75 ? String(((TAG_RANGE - d) / (TAG_RANGE * 0.25)).toFixed(2)) : '1';
          }
        }
      }
      if (show !== t.shown) { t.shown = show; t.el.style.visibility = show ? 'visible' : 'hidden'; }
    }
  }

  // ------------------------------------------------------------------ public API

  setTrack(track) {
    this.track = track;
    this.map.setTrack(track);
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.el.classList.remove('hud--hidden');
    this.map.invalidate();
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.add('hud--hidden');
  }

  reset() {
    this._v = {
      lap: null, laps: null, finalLap: null, time: null, place: null, speed: null, speedPct: null, speedMode: null,
      driftOn: null, driftFill: [-1, -1, -1], driftTier: -1, phone: null, splits: 0, ai: false,
    };
    this._item = { shown: null, count: 0, rolling: false };
    this._reel = { acc: 0, idx: Math.floor(Math.random() * REEL_ICONS.length), total: ITEM.rouletteSeconds };
    this._splitTimer = 0;
    this._nameTimer = 0;
    this._phoneTimer = 0;
    this._lastPlayer = null;
    for (const a of [this._countAnim, this._flashAnim, this._finishAnim]) if (a) a.cancel();
    this._countAnim = this._flashAnim = this._finishAnim = null;
    this.countEl.classList.remove('on');
    this.flashEl.classList.remove('on');
    this.finishEl.classList.remove('on');
    this.wrongEl.classList.remove('on');
    this._wrong = false;
    this.split.classList.remove('on');
    this.itemName.classList.remove('on');
    this.itemEl.classList.remove('has', 'rolling');
    this.itemGlyph.textContent = '';
    this.itemCount.classList.remove('on');
    this.lapEl.classList.remove('final');
    this.driftEl.classList.remove('on');
    this.phone.classList.remove('on', 'lost', 'expanded');
    this.speedEl.classList.remove('boosting', 'star', 'zero');
    if (this.tagEls) for (const t of this.tagEls) { t.shown = false; t.el.style.visibility = 'hidden'; }
    // v4 item feedback
    this._splash = { manual: 0, manualT: 0, manualDur: 0, shown: -1, wasInk: false, wasIncoming: false };
    this._warn = { manual: null, shown: null, level: 0, beep: 0 };
    this._meter = -1;
    this._beer = false;
    this.splashEl.classList.remove('on');
    this.splashEl.style.opacity = '0';
    this.warnEl.classList.remove('on', 'locked');
    this.itemMeter.classList.remove('on');
    this.itemEl.classList.remove('golden', 'riding', 'busy');
    this._busy = false;
    this._coins = -1;
    this._golden = false;
    this._potatoOn = false; this._potatoSec = -1; this._potatoP = -1;
    this.potatoEl.classList.remove('on', 'hot');
    this.coinsEl.classList.remove('max', 'on');
  }

  // v5 Hot Potato fuse (kart.potatoTimer): shown while this view's racer carries it
  _updatePotato(player) {
    const t = player && player.potatoTimer > 0 && !player.finished ? player.potatoTimer : 0;
    const on = t > 0;
    if (on !== this._potatoOn) { this._potatoOn = on; this.potatoEl.classList.toggle('on', on); }
    if (!on) return;
    const sec = Math.ceil(t);
    if (sec !== this._potatoSec) {
      this._potatoSec = sec;
      this.potatoNum.textContent = String(sec);
      this.potatoEl.classList.toggle('hot', sec <= 3);
    }
    const p = Math.round(clamp(t / 8, 0, 1) * 100);
    if (p !== this._potatoP) { this._potatoP = p; this.potatoEl.style.setProperty('--p', `${p}%`); }
  }

  /**
   * v5 lire counter (main.js calls it every frame with kart.coins): pops on a
   * gain, shakes red on a loss, glows gold at COIN.max.
   */
  setCoins(n) {
    const c = clamp(n | 0, 0, 99);
    if (c === this._coins) return;
    const prev = this._coins;
    this._coins = c;
    this.coinsNum.textContent = String(c);
    this.coinsEl.classList.add('on');
    this.coinsEl.classList.toggle('max', c >= COIN.max);
    if (prev < 0 || typeof this.coinsEl.animate !== 'function') return;
    if (c > prev) this.coinsEl.animate(COIN_POP, { duration: 280, easing: 'ease-out' });
    else this.coinsEl.animate(COIN_LOSS, { duration: 420, easing: 'ease-out' });
  }

  /**
   * Coffee splattered over this view (Espresso Splash): full `strength` for
   * duration - fade, then fading out over the last ~1.5 s (or the whole duration when short).
   */
  splash(strength = 1, duration = ITEM.espressoTime || 4.5) {
    const sp = this._splash;
    sp.manual = clamp(+strength || 0, 0, 1);
    sp.manualDur = Math.max(0.05, +duration || 0);
    sp.manualT = sp.manualDur;
    if (sp.manual > 0) this._splat();
  }

  /** Siren banner for an incoming item ('capo'), or null to clear it. */
  warn(type = 'capo') {
    this._warn.manual = type || null;
    this._showWarn(type ? 1 : 0);
  }

  // A fresh coffee splat: new blob layout + a splat-in animation.
  _splat() {
    let seed = (Math.random() * 1e9) | 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const id = `hudCoffee${this._id}`;
    let blobs = '', drips = '';
    for (const [cx, cy, r] of SPLASH_SPOTS) {
      const x = cx + (rnd() - 0.5) * 8, y = cy + (rnd() - 0.5) * 8, rr = r * (0.85 + rnd() * 0.35);
      blobs += `<path d="${blobPath(x, y, rr, rnd)}" fill="url(#${id})" stroke="#c48a52" stroke-width="${(rr * 0.07).toFixed(1)}" stroke-opacity="0.75"/>`;
      // crema swirl + a glossy highlight
      blobs += `<path d="${blobPath(x - rr * 0.12, y - rr * 0.1, rr * 0.45, rnd, 7)}" fill="#a06a3a" fill-opacity="0.45"/>`;
      blobs += `<ellipse cx="${(x - rr * 0.35).toFixed(1)}" cy="${(y - rr * 0.38).toFixed(1)}" rx="${(rr * 0.16).toFixed(1)}" ry="${(rr * 0.07).toFixed(1)}" fill="#fff" fill-opacity="0.35" transform="rotate(-25 ${(x - rr * 0.35).toFixed(1)} ${(y - rr * 0.38).toFixed(1)})"/>`;
      // a few satellite droplets and drips running down
      for (let i = 0; i < 3; i++) {
        const a = rnd() * Math.PI * 2, d = rr * (1.05 + rnd() * 0.5);
        blobs += `<circle cx="${(x + Math.cos(a) * d).toFixed(1)}" cy="${(y + Math.sin(a) * d * 0.9).toFixed(1)}" r="${(rr * (0.08 + rnd() * 0.1)).toFixed(1)}" fill="#3a200f"/>`;
      }
      const n = 1 + Math.floor(rnd() * 2);
      for (let i = 0; i < n; i++) {
        const dx = x + (rnd() - 0.5) * rr * 1.1, w = rr * (0.06 + rnd() * 0.06), len = rr * (0.5 + rnd() * 0.8);
        drips += `<g class="hud-splash-drip" style="animation-delay:${(rnd() * 0.8).toFixed(2)}s"><rect x="${(dx - w / 2).toFixed(1)}" y="${(y + rr * 0.3).toFixed(1)}" width="${w.toFixed(1)}" height="${len.toFixed(1)}" rx="${(w / 2).toFixed(1)}" fill="#3a200f"/><circle cx="${dx.toFixed(1)}" cy="${(y + rr * 0.3 + len).toFixed(1)}" r="${(w * 0.75).toFixed(1)}" fill="#3a200f"/></g>`;
      }
    }
    this.splashEl.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <defs><radialGradient id="${id}" cx="45%" cy="40%" r="65%">
        <stop offset="0" stop-color="#5b3519"/><stop offset="0.55" stop-color="#3b2010"/><stop offset="0.9" stop-color="#2a160a"/><stop offset="1" stop-color="#9a6a3c"/>
      </radialGradient></defs>${drips}${blobs}</svg>`;
    this.splashEl.classList.add('on');
    this.splashEl.firstElementChild.animate([
      { transform: 'scale(0.35)', opacity: 0.2 },
      { transform: 'scale(1.06)', opacity: 1, offset: 0.55 },
      { transform: 'scale(1)', opacity: 1 },
    ], { duration: 240, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
    if (this.audio) this.audio.play('splat', { volume: 0.9 });
  }

  _updateSplash(dt, player) {
    const sp = this._splash;
    if (sp.manualT > 0) sp.manualT = Math.max(0, sp.manualT - dt);
    const fade = Math.min(1.5, sp.manualDur);
    const manual = sp.manualT > 0 ? sp.manual * Math.min(1, sp.manualT / fade) : 0;
    const ink = player && player.ink > 0 ? clamp(player.ink, 0, 1) : 0;
    if (ink > 0 && !sp.wasInk && !(sp.manualT > 0)) this._splat();          // the coffee just landed
    sp.wasInk = ink > 0;
    const incoming = !!(player && player.inkIncoming);
    if (incoming && !sp.wasIncoming) {
      // the cup flies at the screen (it lands with the splat)
      if (this.audio) this.audio.play('espresso', { volume: 0.7, pitch: 1.1 });
      this.cupEl.classList.add('on');
      const anim = this.cupEl.animate([
        { transform: 'translate(-50%, -160%) scale(0.3) rotate(-30deg)', opacity: 0 },
        { transform: 'translate(-50%, -40%) scale(1.1) rotate(10deg)', opacity: 1, offset: 0.45 },
        { transform: 'translate(-50%, -20%) scale(2.6) rotate(-140deg)', opacity: 1 },
      ], { duration: (ITEM.espressoDelay || 0.6) * 1000, easing: 'ease-in', fill: 'forwards' });
      anim.onfinish = () => this.cupEl.classList.remove('on');
    }
    sp.wasIncoming = incoming;
    const a = Math.round(Math.max(manual, ink) * 50) / 50;
    if (a !== sp.shown) {
      sp.shown = a;
      this.splashEl.style.opacity = String(Math.min(0.94, a * 0.94));
      if (a <= 0) this.splashEl.classList.remove('on');
    }
  }

  _showWarn(level) {
    const w = this._warn;
    if (level === w.level) return;
    w.level = level;
    this.warnEl.classList.toggle('on', level > 0);
    this.warnEl.classList.toggle('locked', level > 1);
    this.warnText.textContent = level > 1 ? 'INCOMING!' : 'CAPO CRUSHER!';
    if (level > 0) {
      this.warnEl.animate([{ transform: 'translateX(-50%) scale(0.4)' }, { transform: 'translateX(-50%) scale(1.15)', offset: 0.6 }, { transform: 'translateX(-50%) scale(1)' }], { duration: 300, easing: 'ease-out' });
      w.beep = 0;
    }
  }

  _updateWarn(dt, player) {
    const w = this._warn;
    const auto = player && player.capoWarn > 0 && !player.finished ? player.capoWarn : 0;
    const level = Math.max(auto, w.manual ? 1 : 0);
    this._showWarn(level);
    if (level > 0 && this.audio) {
      w.beep -= dt;
      if (w.beep <= 0) {
        w.beep = level > 1 ? 0.28 : 0.6;
        this.audio.play('capoSiren', { volume: level > 1 ? 1 : 0.75, pitch: level > 1 ? 1.12 : 1 });
      }
    }
  }

  /** Big center "3", "2", "1"; n = 0 → "GO!". */
  countdown(n) {
    if (this._countAnim) this._countAnim.cancel();
    const go = n <= 0;
    this.countText.set(go ? 'GO!' : String(n));
    this.countText.fill(COUNT_FILLS[go ? 0 : clamp(n, 1, 3)] || COUNT_FILLS[1]);
    this.countEl.classList.toggle('go', go);
    this.countEl.classList.add('on');
    // Linear overall timing with per-segment easing, so the number holds fully
    // visible for most of its second instead of fading early.
    const frames = go
      ? [{ transform: 'scale(0.3)', opacity: 0, easing: 'cubic-bezier(.2,.8,.3,1)' },
        { transform: 'scale(1.2)', opacity: 1, offset: 0.13, easing: 'ease-in-out' },
        { transform: 'scale(1)', opacity: 1, offset: 0.25 },
        { transform: 'scale(1.05)', opacity: 1, offset: 0.7, easing: 'ease-in' },
        { transform: 'scale(1.8)', opacity: 0 }]
      : [{ transform: 'scale(2.4)', opacity: 0, easing: 'cubic-bezier(.15,.8,.3,1)' },
        { transform: 'scale(0.9)', opacity: 1, offset: 0.16, easing: 'ease-out' },
        { transform: 'scale(1.05)', opacity: 1, offset: 0.26, easing: 'ease-in-out' },
        { transform: 'scale(1)', opacity: 1, offset: 0.36 },
        { transform: 'scale(0.97)', opacity: 1, offset: 0.8, easing: 'ease-in' },
        { transform: 'scale(0.6)', opacity: 0 }];
    const anim = this.countEl.animate(frames, { duration: go ? 1200 : 980, fill: 'forwards' });
    this.countBurst.animate(
      [{ transform: 'scale(0.3)', opacity: 0.9 }, { transform: 'scale(1.6)', opacity: 0 }],
      { duration: go ? 700 : 520, easing: 'ease-out' });
    anim.onfinish = () => { if (this._countAnim === anim) { this.countEl.classList.remove('on'); this._countAnim = null; } };
    this._countAnim = anim;
  }

  /**
   * Transient banner: "LAP 2", "FINAL LAP!", item names, etc. `sub` adds a small
   * name pill under it (a racer's name; `subColor` = their kart color).
   */
  flash(text, { color = '#ffd23a', duration = 1.5, size = 'big', sub = '', subColor = '#ffffff' } = {}) {
    if (this._flashAnim) this._flashAnim.cancel();
    this.flashText.set(String(text));
    this.flashText.fill(`linear-gradient(180deg, #ffffff 0%, #ffffff 18%, ${color} 58%, ${color} 100%)`);
    this.flashEl.classList.toggle('medium', size === 'medium');
    const subText = sub ? String(sub) : '';
    if (this.flashSubText.data !== subText) this.flashSubText.data = subText;
    this.flashSub.classList.toggle('on', !!subText);
    if (subText) this.flashSub.style.setProperty('--c', subColor || '#ffffff');
    this.flashEl.classList.add('on');
    const d = Math.max(0.4, duration) * 1000;
    const anim = this.flashEl.animate([
      { transform: 'translateY(30%) scale(0.4)', opacity: 0, easing: 'cubic-bezier(.2,.8,.3,1)' },
      { transform: 'translateY(0) scale(1.14)', opacity: 1, offset: Math.min(0.14, 170 / d), easing: 'ease-in-out' },
      { transform: 'translateY(0) scale(1)', opacity: 1, offset: Math.min(0.24, 300 / d) },
      { transform: 'translateY(0) scale(1)', opacity: 1, offset: Math.max(0.5, 1 - 260 / d), easing: 'ease-in' },
      { transform: 'translateY(-35%) scale(1.04)', opacity: 0 },
    ], { duration: d, fill: 'forwards' });
    anim.onfinish = () => { if (this._flashAnim === anim) { this.flashEl.classList.remove('on'); this._flashAnim = null; } };
    this._flashAnim = anim;
  }

  setWrongWay(on) {
    on = !!on;
    if (on === this._wrong) return;
    this._wrong = on;
    this.wrongEl.classList.toggle('on', on);
  }

  /** "FINISH!" + finishing place (stays until reset()/hide()). */
  showFinish(place) {
    this.setWrongWay(false);
    if (this._countAnim) { this._countAnim.cancel(); this.countEl.classList.remove('on'); }
    const p = clamp(Math.round(place) || 1, 1, 99);
    this.finishPlace.set(ordinal(p));
    this.finishPlace.fill(PLACE_FILLS[p] || PLACE_FILLS.other);
    const pl = this._lastPlayer;
    this.finishTime.textContent = pl && pl.finished && Number.isFinite(pl.finishTime) ? fmtClock(pl.finishTime) : '';
    this.finishEl.classList.toggle('podium', p <= 3);
    this.finishEl.classList.add('on');
    if (this._finishAnim) this._finishAnim.cancel();
    this._finishAnim = this.finishEl.animate([
      { transform: 'scale(2.2) rotate(-6deg)', opacity: 0 },
      { transform: 'scale(0.92) rotate(1deg)', opacity: 1, offset: 0.45 },
      { transform: 'scale(1.04) rotate(0deg)', opacity: 1, offset: 0.7 },
      { transform: 'scale(1) rotate(0deg)', opacity: 1 },
    ], { duration: 650, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' });
  }

  update(dt, { player = null, race = null, karts = null, phoneConnected = false, slotColors = null, aiDriving = false } = {}) {
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, 0.25);
    const v = this._v;
    this._lastPlayer = player;

    // ---- a CPU drives this player's kart (split-screen: phone dropped / hidden)
    if (aiDriving !== v.ai) {
      v.ai = aiDriving;
      if (aiDriving) {
        this.phoneText.textContent = 'CPU IS DRIVING';
        this.phone.classList.add('on', 'lost', 'expanded');
        this._phoneTimer = 0;
      } else {
        v.phone = null;              // re-announce the phone state below
      }
    }

    // ---- phone badge: announces a connection, then collapses to a compact
    // dot + icon; a dropped connection shows a red warning for a few seconds.
    const ph = !!phoneConnected;
    if (!aiDriving && ph !== v.phone) {
      const was = v.phone;
      v.phone = ph;
      const cl = this.phone.classList;
      if (ph) {
        this.phoneText.textContent = 'PHONE CONNECTED';
        cl.remove('lost');
        cl.add('on', 'expanded');
        this._phoneTimer = 4;
      } else if (was) {
        this.phoneText.textContent = 'PHONE DISCONNECTED';
        cl.add('on', 'lost', 'expanded');
        this._phoneTimer = 3.5;
      } else {
        cl.remove('on', 'lost', 'expanded');
        this._phoneTimer = 0;
      }
    }
    if (this._phoneTimer > 0) {
      this._phoneTimer -= dt;
      if (this._phoneTimer <= 0) {
        // connected → collapse; disconnected → fade out as-is (red, expanded)
        this.phone.classList.remove(v.phone ? 'expanded' : 'on');
      }
    }

    // ---- lap
    const laps = (race && race.laps) || RACE.laps;
    const lap = player ? clamp(player.lap || 1, 1, laps) : 1;
    if (lap !== v.lap || laps !== v.laps) {
      const changed = v.lap !== null && lap !== v.lap;
      v.lap = lap; v.laps = laps;
      this.lapNum.textContent = String(lap);
      this.lapTotal.textContent = `/${laps}`;
      if (changed) this.lapNum.animate(POP, POP_OPTS);
    }
    const isFinal = lap === laps && laps > 1 && !!race && race.state === 'racing' && !(player && player.finished);
    if (isFinal !== v.finalLap) { v.finalLap = isFinal; this.lapEl.classList.toggle('final', isFinal); }

    // ---- timer (frozen at the player's finish time); compared in whole
    // centiseconds so an unchanged clock costs no string formatting
    let t = race && Number.isFinite(race.time) ? race.time : 0;
    if (player && player.finished && Number.isFinite(player.finishTime)) t = player.finishTime;
    const cs = toCs(t);
    if (cs !== v.time) { v.time = cs; this.timerText.nodeValue = fmtCs(cs); }

    // ---- lap split
    const splits = player && player.lapTimes ? player.lapTimes.length : 0;
    if (splits !== v.splits) {
      if (splits > v.splits && splits > 0) {
        const lt = player.lapTimes[splits - 1];
        const best = Math.min(...player.lapTimes);
        this.split.textContent = `LAP ${splits}  ${fmtClock(lt)}`;
        this.split.classList.toggle('best', splits > 1 && lt <= best + 1e-6);
        this.split.classList.add('on');
        this._splitTimer = 4;
      }
      v.splits = splits;
    }
    if (this._splitTimer > 0) {
      this._splitTimer -= dt;
      if (this._splitTimer <= 0) this.split.classList.remove('on');
    }

    // ---- place badge
    const place = player ? player.place || 0 : 0;
    if (place !== v.place) {
      const changed = v.place !== null && v.place > 0 && place > 0;
      v.place = place;
      if (place > 0) {
        const suffix = ordinal(place).slice(String(place).length);
        this.placeNum.set(String(place));
        this.placeSuf.set(suffix);
        const fill = PLACE_FILLS[place] || PLACE_FILLS.other;
        this.placeNum.fill(fill);
        this.placeSuf.fill(fill);
        this.placeEl.classList.remove('p1', 'p2', 'p3');
        if (place <= 3) this.placeEl.classList.add('p' + place);
        this.placeEl.style.visibility = '';
        if (changed) this.placeEl.animate(POP, { duration: 480, easing: 'ease-out' });
      } else {
        this.placeEl.style.visibility = 'hidden';
      }
    }

    // ---- speedometer
    if (player) {
      const sp = Math.abs(player.speed || 0);
      const kmh = Math.round(sp * 3.6);
      if (kmh !== v.speed) { v.speed = kmh; this.speedNum.textContent = String(kmh); }
      const full = ((player.stats && player.stats.topSpeed) || 30) * KART.boostSpeedMult;
      const pct = Math.round(clamp(sp / full, 0, 1) * 200) / 2;
      if (pct !== v.speedPct) {
        if ((pct === 0) !== (v.speedPct === 0)) this.speedEl.classList.toggle('zero', pct === 0);
        v.speedPct = pct;
        this.speedVal.style.strokeDashoffset = String(100 - pct);
      }
      // arc style: normal gradient, hot boost gradient, or cycling rainbow while starred
      const mode = (player.starTimer || 0) > 0 ? 'star' : (player.boostTimer || 0) > 0 ? 'boost' : 'normal';
      if (mode !== v.speedMode) {
        v.speedMode = mode;
        this.speedEl.classList.toggle('boosting', mode !== 'normal');
        this.speedEl.classList.toggle('star', mode === 'star');
        this.speedVal.setAttribute('stroke', this.speedVal.dataset[mode]);
      }
    }

    // ---- drift charge
    const d = player && player.drift;
    const driftOn = !!(d && d.active);
    if (driftOn !== v.driftOn) { v.driftOn = driftOn; this.driftEl.classList.toggle('on', driftOn); }
    if (driftOn) {
      const charge = d.charge || 0, tt = DRIFT.tierTimes;
      for (let k = 0; k < 3; k++) {
        const a = k === 0 ? 0 : tt[k - 1], b = tt[k];
        const f = Math.round(clamp((charge - a) / (b - a), 0, 1) * 50) / 50;
        if (f !== v.driftFill[k]) { v.driftFill[k] = f; this.driftSegs[k].style.transform = `scaleX(${f})`; }
      }
      const tier = clamp(d.tier | 0, 0, 3);
      if (tier !== v.driftTier) {
        v.driftTier = tier;
        this.driftEl.style.setProperty('--tier', DRIFT.tierColors[tier]);
        this.driftEl.classList.toggle('charged', tier > 0);
        this.driftLabel.textContent = DRIFT_NAMES[tier] || 'DRIFT';
        if (tier > 0) this.driftLabel.animate(POP, { duration: 320, easing: 'ease-out' });
      }
    } else if (v.driftTier !== -1) {
      v.driftTier = -1;
    }

    // ---- item slot + roulette (+ Golden Toot meter, Beer Rocket glow)
    this._updateItem(dt, player);
    const golden = !!(player && player.goldenTimer > 0 && player.item === 'golden_toot');
    // v5 timed items (calzone, grissino, tip jar, ...): kart.itemWindow = share of the window left
    const gt = golden ? clamp(player.goldenTimer / (ITEM.goldenTime || 7.5), 0, 1)
      : player && player.item && player.itemWindow > 0 ? clamp(player.itemWindow, 0, 1) : 0;
    const gq = Math.round(gt * 100) / 100;
    if (golden !== this._golden) { this._golden = golden; this.itemEl.classList.toggle('golden', golden); }
    if (gq !== this._meter) {
      if ((gq > 0) !== (this._meter > 0)) this.itemMeter.classList.toggle('on', gq > 0);
      this._meter = gq;
      this.itemMeter.style.setProperty('--p', `${(gq * 100).toFixed(0)}%`);
    }
    const riding = !!(player && player.beer);
    if (riding !== this._beer) { this._beer = riding; this.itemEl.classList.toggle('riding', riding); }
    // v5: a multi-use item whose last throw is still out (Flying Pizza: kart.itemBusy) greys the slot
    const busy = !!(player && player.item && player.itemBusy);
    if (busy !== this._busy) { this._busy = busy; this.itemEl.classList.toggle('busy', busy); }

    // ---- espresso splash + capo siren for this view's player
    this._updateSplash(dt, player);
    this._updatePotato(player);
    this._updateWarn(dt, player);

    // ---- minimap (compact split-screen views use the shared one)
    if (this.visible && !this.compact) this.map.draw(karts, player, slotColors);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    for (const a of [this._countAnim, this._flashAnim, this._finishAnim]) if (a) a.cancel();
    this.map.dispose();
    this.el.remove();
  }

  // ------------------------------------------------------------------ item slot

  _updateItem(dt, player) {
    const st = this._item;
    const rolling = !!(player && player.rolling);
    const item = player ? player.item || null : null;
    const count = player ? player.itemCount || 0 : 0;

    if (rolling) {
      if (!st.rolling) {
        st.rolling = true;
        this._reel.acc = 0;
        this._reel.total = Math.max(0.3, player.rollTimer || ITEM.rouletteSeconds, ITEM.rouletteSeconds);
        this.itemEl.classList.add('has', 'rolling');
        this.itemCount.classList.remove('on');
        this.itemName.classList.remove('on');
        this._tickReel(0);
      }
      // reel slows down as the roll timer runs out: fast ticks → long ticks
      const progress = clamp(1 - (player.rollTimer || 0) / this._reel.total, 0, 1);
      const interval = 0.05 + 0.2 * Math.pow(progress, 2.1);
      this._reel.acc += dt;
      if (this._reel.acc >= interval) {
        this._reel.acc = 0;
        this._tickReel(progress);
      }
      st.shown = null;
      return;
    }

    if (st.rolling) {
      // roll just ended
      st.rolling = false;
      this.itemEl.classList.remove('rolling');
      if (item) this._landItem(item, count);
      else this._clearItem();
      return;
    }

    if (item !== st.shown) {
      if (item) this._landItem(item, count);
      else this._clearItem();
      return;
    }

    if (item && count !== st.count) {
      st.count = count;
      this._setCount(item, count, true);
      this.itemIcon.animate([
        { transform: 'scale(1)' }, { transform: 'scale(0.6)', offset: 0.35 }, { transform: 'scale(1.12)', offset: 0.7 }, { transform: 'scale(1)' },
      ], { duration: 360, easing: 'ease-out' });
    }

    if (this._nameTimer > 0) {
      this._nameTimer -= dt;
      if (this._nameTimer <= 0) this.itemName.classList.remove('on');
    }
  }

  _tickReel(progress) {
    const r = this._reel;
    r.idx = (r.idx + 1 + Math.floor(Math.random() * (REEL_ICONS.length - 2))) % REEL_ICONS.length;
    this.itemGlyph.textContent = REEL_ICONS[r.idx];
    this.itemIcon.animate([
      { transform: 'translateY(-62%) scale(0.85)', opacity: 0.2 },
      { transform: 'translateY(0) scale(1)', opacity: 1 },
    ], { duration: Math.min(140, 60 + progress * 120), easing: 'ease-out' });
    if (this.audio) this.audio.play('roulette', { pitch: 1.12 - progress * 0.22, volume: 0.8 });
    bus.emit('hud:rouletteTick', { progress });
  }

  _landItem(item, count) {
    const info = ITEM_INFO[item];
    const st = this._item;
    st.shown = item;
    st.count = count;
    this.itemGlyph.textContent = info ? info.icon : '?';
    this.itemEl.classList.add('has');
    this.itemEl.style.setProperty('--item', info ? info.color : '#fff');
    this._setCount(item, count, false);
    this.itemName.textContent = info ? info.name : item;
    this.itemName.classList.add('on');
    this._nameTimer = 1.8;
    this.itemIcon.animate([
      { transform: 'scale(0.3) rotate(-25deg)', opacity: 0.4 },
      { transform: 'scale(1.45) rotate(8deg)', opacity: 1, offset: 0.4 },
      { transform: 'scale(0.9) rotate(-3deg)', offset: 0.7 },
      { transform: 'scale(1) rotate(0deg)' },
    ], { duration: 520, easing: 'ease-out' });
    this.itemBurst.animate([
      { transform: 'scale(0.6)', opacity: 1 }, { transform: 'scale(1.75)', opacity: 0 },
    ], { duration: 520, easing: 'ease-out' });
    this.itemFrame.animate(POP, { duration: 420, easing: 'ease-out' });
  }

  _setCount(item, count, pop) {
    const multi = ITEM_INFO[item] && ITEM_INFO[item].uses > 1;
    const show = multi && count > 1;
    this.itemCount.classList.toggle('on', show);
    if (show) {
      this.itemCount.textContent = `×${count}`;
      if (pop) this.itemCount.animate(POP, { duration: 360, easing: 'ease-out' });
    }
  }

  _clearItem() {
    const st = this._item;
    const had = st.shown;
    st.shown = null;
    st.count = 0;
    this.itemCount.classList.remove('on');
    this.itemName.classList.remove('on');
    if (!had) {
      this.itemEl.classList.remove('has');
      this.itemGlyph.textContent = '';
      return;
    }
    // used: puff the icon away
    const anim = this.itemIcon.animate([
      { transform: 'scale(1)', opacity: 1 },
      { transform: 'scale(1.5)', opacity: 0 },
    ], { duration: 260, easing: 'ease-out' });
    anim.onfinish = () => {
      if (!this._item.shown && !this._item.rolling) {
        this.itemGlyph.textContent = '';
        this.itemEl.classList.remove('has');
      }
    };
  }
}

// ================================================================== Minimap

// Course outline + kart dots on a 2D canvas. The outline is pre-rendered once
// per size/track; each frame only the dots are drawn. `focus` = the view's
// own kart (big white-ringed dot with a heading wedge); other human karts
// get a ring in their player-slot color, CPUs a plain dot in their paint.
export class Minimap {
  constructor(container) {
    this.el = container;
    this.canvas = el('canvas', 'hud-map-canvas', container);
    this.ctx2d = this.canvas.getContext('2d');
    this.track = null;
    this._bg = null;
    this._xf = null;
    this._dirty = true;
    this._W = 0; this._H = 0;
    this._roadW = 4;
  }

  setTrack(track) { this.track = track; this._dirty = true; }
  invalidate() { this._dirty = true; }

  _layout() {
    const rect = this.el.getBoundingClientRect();
    // not laid out yet (e.g. a display:none parent): retry next frame
    if (rect.width < 4 || rect.height < 4) { this._bg = null; return; }
    this._dirty = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(16, Math.round(rect.width * dpr));
    const H = Math.max(16, Math.round(rect.height * dpr));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    this._W = W; this._H = H;
    this._bg = null;
    const track = this.track;
    if (!track || !track.samples || !track.samples.length) return;

    // fit the rotated track into the canvas
    const c = Math.cos(MAP_ROT), s = Math.sin(MAP_ROT);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const smp of track.samples) {
      const X = smp.pos.x * c - smp.pos.z * s, Y = smp.pos.x * s + smp.pos.z * c;
      const m = smp.halfWidth;
      minX = Math.min(minX, X - m); maxX = Math.max(maxX, X + m);
      minY = Math.min(minY, Y - m); maxY = Math.max(maxY, Y + m);
    }
    const pad = Math.min(W, H) * 0.09;
    const scale = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    const ox = W / 2 - ((minX + maxX) / 2) * scale;
    const oy = H / 2 - ((minY + maxY) / 2) * scale;
    this._xf = { c, s, scale, ox, oy };

    // pre-render outline, road, bridge tint and the start line
    const bg = document.createElement('canvas');
    bg.width = W; bg.height = H;
    const g = bg.getContext('2d');
    const P = (x, z) => [ox + (x * c - z * s) * scale, oy + (x * s + z * c) * scale];
    const path = (from = 0, to = track.samples.length, close = true) => {
      g.beginPath();
      for (let i = from; i <= to; i++) {
        const smp = track.samples[i % track.samples.length];
        const [x, y] = P(smp.pos.x, smp.pos.z);
        i === from ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      if (close) g.closePath();
    };
    const roadW = Math.max(3, Math.min(W, H) * 0.052);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    path();
    g.strokeStyle = 'rgba(16, 8, 40, 0.9)';
    g.lineWidth = roadW + Math.max(3, roadW * 0.7);
    g.stroke();
    g.strokeStyle = '#f3f1ff';
    g.lineWidth = roadW;
    g.stroke();
    // inner lane hint
    g.strokeStyle = 'rgba(160, 150, 210, 0.55)';
    g.lineWidth = Math.max(1, roadW * 0.14);
    g.setLineDash([roadW * 0.6, roadW * 0.7]);
    g.stroke();
    g.setLineDash([]);
    // bridges (water blue on the bay, warm stone for the hill-town aqueduct) and covered sections
    const bridgeTint = track.theme === 'hilltown' ? '#f0d7a0' : '#9fdcff';
    for (const z of track.zones || []) {
      const tint = z.type === 'bridge' ? bridgeTint : z.type === 'tunnel' ? '#b9a6d8' : null;
      if (!tint || !Number.isFinite(z.s0) || !Number.isFinite(z.s1)) continue;
      const i0 = Math.floor(z.s0 / track.spacing), i1 = Math.ceil(z.s1 / track.spacing);
      path(i0, i1 >= i0 ? i1 : i1 + track.samples.length, false);
      g.strokeStyle = tint;
      g.lineWidth = roadW * 0.62;
      g.stroke();
    }
    // checkered start line across the road
    const f0 = track.samples[0];
    const hw = f0.halfWidth * 1.15;
    const [ax, ay] = P(f0.pos.x - f0.right.x * hw, f0.pos.z - f0.right.z * hw);
    const [bx, by] = P(f0.pos.x + f0.right.x * hw, f0.pos.z + f0.right.z * hw);
    g.lineCap = 'butt';
    g.strokeStyle = '#1a1030';
    g.lineWidth = roadW * 0.55;
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    g.strokeStyle = '#ffffff';
    g.lineWidth = roadW * 0.42;
    const len = Math.hypot(bx - ax, by - ay);
    g.setLineDash([len / 6, len / 6]);
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    g.setLineDash([]);
    this._bg = bg;
    this._roadW = roadW;
  }

  /**
   * karts: every kart; focus: the view's own kart (or null: shared map);
   * slotColors: Map kart → slot css color for human karts (or null).
   */
  draw(karts, focus = null, slotColors = null) {
    if (this._dirty) this._layout();
    if (!this._bg || !this._xf) return;
    const g = this.ctx2d, W = this._W, H = this._H;
    g.clearRect(0, 0, W, H);
    g.drawImage(this._bg, 0, 0);
    if (!karts || !karts.length) return;
    const { c, s, scale, ox, oy } = this._xf;
    const base = Math.max(3, this._roadW * 0.58);
    // 3 passes: CPUs, other humans, then the focus kart on top
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        if (!k || !k.position) continue;
        const ring = slotColors ? slotColors.get(k) : null;
        const kind = k === focus ? 2 : ring ? 1 : 0;
        if (kind !== pass) continue;
        const x = ox + (k.position.x * c - k.position.z * s) * scale;
        const y = oy + (k.position.x * s + k.position.z * c) * scale;
        const color = k.cssColor || (k.character && k.character.cssColor) || '#ffffff';
        if (kind === 2) {
          const r = base * 1.45;
          // heading wedge
          const yaw = k.yaw || 0;
          const fx = Math.sin(yaw), fz = Math.cos(yaw);
          const hx = fx * c - fz * s, hy = fx * s + fz * c;
          g.beginPath();
          g.moveTo(x + hx * r * 2.1, y + hy * r * 2.1);
          g.lineTo(x - hy * r * 0.95, y + hx * r * 0.95);
          g.lineTo(x + hy * r * 0.95, y - hx * r * 0.95);
          g.closePath();
          g.fillStyle = ring || '#ffffff';
          g.fill();
          g.lineWidth = Math.max(1.5, r * 0.28);
          g.strokeStyle = 'rgba(16, 8, 40, 0.95)';
          g.stroke();
          g.beginPath();
          g.arc(x, y, r * 1.42, 0, Math.PI * 2);
          g.fillStyle = ring || '#ffffff';
          g.fill();
          g.lineWidth = Math.max(1.5, r * 0.3);
          g.stroke();
          g.beginPath();
          g.arc(x, y, r * 0.95, 0, Math.PI * 2);
          g.fillStyle = color;
          g.fill();
        } else if (kind === 1) {
          const r = base * 1.25;
          g.beginPath();
          g.arc(x, y, r * 1.38, 0, Math.PI * 2);
          g.fillStyle = ring;
          g.fill();
          g.lineWidth = Math.max(1.3, r * 0.3);
          g.strokeStyle = 'rgba(16, 8, 40, 0.95)';
          g.stroke();
          g.beginPath();
          g.arc(x, y, r * 0.9, 0, Math.PI * 2);
          g.fillStyle = color;
          g.fill();
        } else {
          g.beginPath();
          g.arc(x, y, base, 0, Math.PI * 2);
          g.fillStyle = color;
          g.fill();
          g.lineWidth = Math.max(1.2, base * 0.38);
          g.strokeStyle = 'rgba(16, 8, 40, 0.95)';
          g.stroke();
        }
      }
    }
  }

  dispose() { this._bg = null; this.el.remove(); }
}

// ================================================================== SharedHud

// The split-screen widget shared by every view (SPEC §14.6): 2P / 4P a small
// minimap on the center divider / cross; 3P the empty 4th quadrant holds a
// big minimap and live standings (place, paint chip, name, P-tags).
//
//   const shared = new SharedHud(document.getElementById('hud'));
//   shared.setTrack(track);
//   shared.setLayout(splitLayout(n, W, H).shared);    // { kind, x, y, w, h }
//   shared.update(karts, slotColors, standings);      // every frame (DOM only on change)
export class SharedHud {
  constructor(root) {
    this.root = root;
    this.el = el('div', 'hud-shared hud--hidden', root);
    this.mapEl = el('div', 'hud-shared-map', this.el);
    this.map = new Minimap(this.mapEl);
    this.listEl = el('div', 'hud-shared-list', this.el);
    this.kind = 'none';
    this.visible = false;
    this._rows = [];
    this._key = '';
    this._timer = 0;
  }

  setTrack(track) { this.map.setTrack(track); }

  /** Place the widget ({ kind: 'none' | 'center' | 'quad', x, y, w, h } in CSS px). */
  setLayout(L) {
    const kind = L && L.kind ? L.kind : 'none';
    this.kind = kind;
    this.el.dataset.kind = kind;
    const st = this.el.style;
    if (kind === 'none') { this.hide(); return; }
    st.left = `${L.x}px`; st.top = `${L.y}px`; st.width = `${L.w}px`; st.height = `${L.h}px`;
    // the quadrant panel scales its text with its own size
    st.setProperty('--u', `${Math.max(2, Math.min(L.h / 50, L.w / 90)).toFixed(2)}px`);
    this.map.invalidate();
    this._key = '';
  }

  show() { if (this.kind === 'none' || this.visible) return; this.visible = true; this.el.classList.remove('hud--hidden'); this.map.invalidate(); }
  hide() { if (!this.visible) return; this.visible = false; this.el.classList.add('hud--hidden'); }

  /**
   * karts: every kart; slotColors: Map kart → { color, label } (humans);
   * standings: karts in race order (quad layout only; refreshed ~4×/s).
   */
  update(dt, karts, slotColors, standings) {
    if (!this.visible) return;
    this.map.draw(karts, null, slotColors && slotColors.colors);
    if (this.kind !== 'quad' || !standings) return;
    this._timer -= dt;
    if (this._timer > 0) return;
    this._timer = 0.25;
    let key = '';
    for (let i = 0; i < standings.length; i++) key += standings[i].id + (standings[i].finished ? '!' : '') + ',';
    if (key === this._key) return;
    this._key = key;
    while (this._rows.length < standings.length) {
      const row = el('div', 'hud-st-row', this.listEl);
      const pos = el('span', 'hud-st-pos', row);
      const chip = el('i', 'hud-st-chip', row);
      const name = el('span', 'hud-st-name', row);
      const tag = el('span', 'hud-st-tag', row);
      this._rows.push({ row, pos, chip, name, tag });
    }
    for (let i = 0; i < this._rows.length; i++) {
      const r = this._rows[i], k = standings[i];
      r.row.hidden = !k;
      if (!k) continue;
      const info = slotColors && slotColors.labels ? slotColors.labels.get(k) : null;
      r.pos.textContent = String(i + 1);
      r.chip.style.background = k.cssColor || '#fff';
      r.name.textContent = k.shortName || k.name || '???';
      r.tag.textContent = info ? info.label : '';
      r.tag.style.background = info ? info.color : '';
      r.row.classList.toggle('human', !!info);
      r.row.classList.toggle('done', !!k.finished);
    }
  }

  dispose() { this.map.dispose(); this.el.remove(); }
}
