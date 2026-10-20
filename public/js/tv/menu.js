// The games menu (DOM): the logo and one card per game — nothing else. Pick
// with the mouse, the arrow keys + Enter, or 1–4. Tennis and Golf then open
// their lobby (QR code, players, settings); Bowling and Krishiv Kart start as
// their own servers with their own lobby. The cards come from GAMES in
// shared/protocol.js and their art from art.js.
import { GAMES } from '../shared/protocol.js';
import { make, logo } from './ui.js';
import { SPORT_ART, SPORT_STYLE } from './art.js';

// ---------------------------------------------------------------- keyboard spatial navigation

export function moveFocus(scope, dir) {
  const items = [...scope.querySelectorAll('button:not([disabled]), .focusable')].filter((e) => e.offsetParent !== null);
  if (!items.length) return null;
  const cur = scope.querySelector('.kbd-focus');
  if (!cur || !items.includes(cur)) { items[0].classList.add('kbd-focus'); return items[0]; }
  const r0 = cur.getBoundingClientRect();
  const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
  let best = null, bestScore = Infinity;
  for (const e of items) {
    if (e === cur) continue;
    const r = e.getBoundingClientRect();
    const dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
    const main = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
    const cross = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (main <= 4) continue;
    const score = main + cross * 2.2;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  if (best) { cur.classList.remove('kbd-focus'); best.classList.add('kbd-focus'); }
  return best || cur;
}

// ---------------------------------------------------------------- the menu

export class Menu {
  // app: { info, onPick(id) }
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.el = make('section', 'menu', null, root);
    this.visible = false;
    this._build();
  }

  _build() {
    const el = this.el;
    const bubbles = make('div', 'bubbles', null, el);
    for (let i = 0; i < 14; i++) {
      const b = make('i', null, null, bubbles);
      const s = 20 + Math.random() * 70;
      b.style.cssText = `left:${Math.random() * 100}%;width:${s}px;height:${s}px;animation-duration:${14 + Math.random() * 18}s;animation-delay:${-Math.random() * 30}s;opacity:${0.35 + Math.random() * 0.5}`;
    }
    const head = make('header', 'menu-head', null, el);
    logo(head);
    make('div', 'menu-sub', 'Choose a game', head);
    this.soundPill = make('div', 'sound-pill', '🔈 Click anywhere for sound', head);

    this.grid = make('div', 'games', null, el);
    this.cards = {};
    GAMES.forEach((g, i) => {
      const b = make('button', 'game-card', null, this.grid);
      b.dataset.game = g.id;
      b.style.setProperty('--g', SPORT_STYLE[g.id]?.g || 'linear-gradient(160deg, #69d0ff, #1c8fe0)');
      b.innerHTML = SPORT_ART[g.id] || '';
      make('span', 'tag', g.players, b);
      make('span', 'num', String(i + 1), b);
      const lab = make('div', 'label', null, b);
      make('b', null, g.name, lab);
      make('span', null, g.blurb, lab);
      b.addEventListener('click', () => this.app.onPick(g.id));
      this.cards[g.id] = b;
    });

    const foot = make('footer', 'menu-foot', null, el);
    for (const [k, t] of [['🖱️', 'Click a game'], ['← →', 'Arrow keys + Enter'], ['1–4', 'Quick pick'], ['M', 'Sound']]) {
      const s = make('span', null, null, foot);
      make('b', null, k, s);
      s.append(t);
    }
  }

  show() {
    this.visible = true;
    this.el.style.display = '';
    this.render();
    if (!this.el.querySelector('.kbd-focus')) this.cards[GAMES[0].id]?.classList.add('kbd-focus');
  }

  hide() {
    this.visible = false;
    this.el.style.display = 'none';
  }

  setSound(on) { this.soundPill.classList.toggle('off', !!on); }

  // Bowling / Kart cards say so when their folder is missing.
  render() {
    if (!this.visible) return;
    const info = this.app.info || {};
    for (const g of GAMES) {
      const card = this.cards[g.id];
      const st = info.games?.[g.id];
      const off = st && st.installed === false;
      card.classList.toggle('off', !!off);
      card.querySelector('.tag').textContent = off ? 'Not found' : g.players;
      card.title = off ? st.why : '';
    }
  }
}
