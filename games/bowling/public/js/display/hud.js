// HUD overlay (DOM): scorecard, pin indicator, mini scoreboard, name banner,
// control prompts, result messages, toasts and the player chips.
import { colorHex, getCharacter } from '../shared/protocol.js';
import { FRAMES } from '../shared/scoring.js';

const make = (tag, cls, text, parent) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  if (parent) parent.append(e);
  return e;
};

// Streak names from the original game.
const STREAK = [null, null, 'Double', 'Turkey', 'Fourth', 'Fifth', 'Six-pack', 'Seven-pack', 'Eight in a row', 'Nine in a row', 'Ten in a row', 'Eleven in a row', 'Perfect'];
export const streakName = (n) => (n >= 12 ? 'Perfect' : STREAK[n] || null);

// A tiny Brainrot Character avatar for scorecards, chips, and hud.
export function miniFace(color, parent, characterId = 'tung_tung') {
  const char = getCharacter(characterId);
  const f = make('span', `face face-${char.id}`, null, parent);
  f.style.setProperty('--c', colorHex(color));
  f.title = char.name;
  make('span', 'face-icon', char.icon, f);
  return f;
}

function markCell(parent, mark, cls) {
  const box = make('span', cls, null, parent);
  const m = typeof mark === 'object' && mark ? mark : { text: mark || '' };
  if (m.text === 'X') box.append(make('span', 'bowtie'));
  else if (m.text === '/') box.append(make('span', 'spare-tri'));
  else box.textContent = m.text;
  if (m.split) box.classList.add('split');
  return box;
}

export function renderCard(el, board, { current = -1, compact = false } = {}) {
  el.replaceChildren();
  const grid = make('div', `card-grid${compact ? ' compact' : ''}`, null, el);
  const head = make('div', 'card-row head', null, grid);
  make('span', 'cell name', '', head);
  for (let f = 1; f <= FRAMES; f++) make('span', `cell frame-no${f === FRAMES ? ' tenth' : ''}`, String(f), head);
  make('span', 'cell total-h', 'Total', head);
  board.forEach((row, i) => {
    const r = make('div', `card-row${i === current ? ' current' : ''}`, null, grid);
    r.style.setProperty('--c', colorHex(row.color));
    const nm = make('span', 'cell name', null, r);
    miniFace(row.color, nm, row.character);
    make('b', 'pname', row.name, nm);
    row.frames.forEach((fr, f) => {
      const cell = make('span', `cell frame${f === FRAMES - 1 ? ' tenth' : ''}`, null, r);
      const top = make('span', 'balls', null, cell);
      if (f < FRAMES - 1) {
        if (fr.marks[1] === 'X') {
          make('span', 'b1 strike', null, top).append(make('span', 'bowtie'));
          make('span', 'b2', null, top);
        } else {
          markCell(top, fr.marks[0], 'b1');
          markCell(top, fr.marks[1], 'b2');
        }
      } else {
        for (let k = 0; k < 3; k++) markCell(top, fr.marks[k], 'b2 t');
      }
      make('span', 'run', fr.score === null ? '' : String(fr.score), cell);
    });
    make('span', 'cell total', String(row.total), r);
  });
}

export class Hud {
  constructor(root) {
    this.root = root;
    this.card = make('div', 'hud-card', null, root);
    this.pins = make('div', 'hud-pins', null, root);
    this.mini = make('div', 'hud-mini', null, root);
    this.banner = make('div', 'hud-banner', null, root);
    this.prompts = make('div', 'hud-prompts', null, root);
    this.arrows = make('div', 'hud-arrows', null, root);
    make('span', 'arrow l', null, this.arrows);
    make('span', 'arrow r', null, this.arrows);
    this.msg = make('div', 'hud-msg', null, root);
    this.band = make('div', 'hud-band', null, root);
    this.speedEl = make('div', 'hud-speed', null, root);
    this.powerEl = make('div', 'hud-power', null, root);
    this.chipsEl = make('div', 'hud-chips', null, root);
    this.toastEl = make('div', 'hud-toast', null, document.body);   // above the lobby / results screens
    this.notice = make('div', 'hud-notice', null, root);
    this.pinDots = [];
    for (const row of [[7, 8, 9, 10], [4, 5, 6], [2, 3], [1]]) {
      const r = make('div', 'pin-row', null, this.pins);
      for (const n of row) this.pinDots[n] = make('span', 'pin-dot', String(n), r);
    }
    this.hideAll();
  }

  hideAll() {
    for (const e of [this.card, this.pins, this.mini, this.banner, this.prompts, this.arrows, this.msg, this.band, this.speedEl, this.powerEl]) e.classList.remove('show');
  }

  showCard(board, current, opts = {}) {
    renderCard(this.card, board, { current, ...opts });
    this.card.classList.toggle('top', !!opts.top);
    this.card.classList.add('show');
  }
  hideCard() { this.card.classList.remove('show'); }

  // standing: Set of pin numbers still up (null hides the indicator).
  setPins(standing) {
    if (!standing) { this.pins.classList.remove('show'); return; }
    for (let n = 1; n <= 10; n++) this.pinDots[n].classList.toggle('down', !standing.has(n));
    this.pins.classList.add('show');
  }

  showMini(row, frameIndex) {
    this.mini.replaceChildren();
    this.mini.style.setProperty('--c', colorHex(row.color));
    miniFace(row.color, make('span', 'mini-face', null, this.mini), row.character);
    const from = Math.max(0, Math.min(frameIndex - 1, FRAMES - 3));
    for (let f = from; f < from + 3; f++) {
      const fr = row.frames[f];
      const col = make('span', `mini-col${f === frameIndex ? ' now' : ''}`, null, this.mini);
      make('span', 'mini-no', String(f + 1), col);
      const balls = make('span', 'balls', null, col);
      if (f < FRAMES - 1 && fr.marks[1] === 'X') { make('span', 'b1 strike', null, balls).append(make('span', 'bowtie')); make('span', 'b2', null, balls); }
      else if (f < FRAMES - 1) { markCell(balls, fr.marks[0], 'b1'); markCell(balls, fr.marks[1], 'b2'); }
      else for (let k = 0; k < 3; k++) markCell(balls, fr.marks[k], 'b2 t');
      make('span', 'run', fr.score === null ? '' : String(fr.score), col);
    }
    this.mini.classList.add('show');
  }
  hideMini() { this.mini.classList.remove('show'); }

  showBanner(name, color, index, count, sub, character) {
    this.banner.replaceChildren();
    this.banner.style.setProperty('--c', colorHex(color));
    const band = make('div', 'banner-band', null, this.banner);
    miniFace(color, band, character);
    make('b', 'banner-name', name, band);
    const pips = make('span', 'pips', null, band);
    for (let i = 0; i < 4; i++) make('i', `${i === index ? 'on' : ''}${i >= count ? ' off' : ''}`, null, pips);
    if (sub) make('div', 'banner-sub', sub, this.banner);
    this.banner.classList.add('show');
  }
  hideBanner() { this.banner.classList.remove('show'); }

  showPrompts(mode, zoom, extra) {
    this.prompts.replaceChildren();
    const line = (icon, text, on) => {
      const l = make('div', `prompt${on ? ' on' : ''}`, null, this.prompts);
      make('span', 'picon', icon, l);
      make('span', 'ptext', text, l);
    };
    line('✚', mode === 'turn' ? 'Turn' : 'Move', true);
    line('A', 'Switch', false);
    line('▲', zoom ? 'Zoom out' : 'Zoom', false);
    line('B', extra || 'Hold B and swing', false);
    this.prompts.classList.add('show');
    this.arrows.classList.toggle('turn', mode === 'turn');
    this.arrows.classList.add('show');
  }
  hidePrompts() { this.prompts.classList.remove('show'); this.arrows.classList.remove('show'); }

  showChips(on) { this.chipsEl.classList.toggle('hidden', !on); }

  // kind: 'strike' (metallic band) | 'spare' | 'pins' | 'gutter' | 'split' | 'oops'
  message(kind, title, sub, ms = 2200) {
    clearTimeout(this._msgT);
    this.msg.classList.remove('show');
    this.band.classList.remove('show');
    void this.msg.offsetWidth;
    if (kind === 'strike') {
      this.band.replaceChildren();
      const inner = make('div', 'band-inner', null, this.band);
      make('span', 'gold-ball l', null, inner);
      const words = make('div', 'band-words', null, inner);
      make('div', 'band-title', title, words);
      if (sub) make('div', 'band-sub', sub, words);
      make('span', 'gold-ball r', null, inner);
      this.band.classList.add('show');
    } else {
      this.msg.replaceChildren();
      this.msg.className = `hud-msg ${kind}`;
      make('div', 'msg-title', title, this.msg);
      if (sub) make('div', 'msg-sub', sub, this.msg);
      void this.msg.offsetWidth;
      this.msg.classList.add('show');
    }
    this._msgT = setTimeout(() => this.clearMessage(), ms);
  }
  clearMessage() { this.msg.classList.remove('show'); this.band.classList.remove('show'); }

  // Speed + release feedback during the roll. tone: 'good' | 'warn' | 'bad'.
  speed(text, tone) {
    this.speedEl.textContent = text || '';
    this.speedEl.dataset.tone = tone || '';
    this.speedEl.classList.toggle('show', !!text);
  }

  // Keyboard players: a swing-power meter while Space is held.
  power(value, spin) {
    if (value === null || value === undefined) { this.powerEl.classList.remove('show'); return; }
    this.powerEl.replaceChildren();
    const bar = make('div', 'power-bar', null, this.powerEl);
    make('i', null, null, bar).style.width = `${Math.round(value * 100)}%`;
    make('div', 'power-text', `Power ${Math.round(value * 100)}%   ·   Curve ${spin === 0 ? 'none' : spin < 0 ? '◀'.repeat(Math.ceil(-spin * 3)) : '▶'.repeat(Math.ceil(spin * 3))}   ·   ← → to curve, let go of Space to bowl`, this.powerEl);
    this.powerEl.classList.add('show');
  }

  toast(text, ms = 2600) {
    const t = make('div', 'toast', text, this.toastEl);
    setTimeout(() => t.classList.add('out'), ms);
    setTimeout(() => t.remove(), ms + 500);
  }

  // Persistent notice (e.g. a disconnected remote); null clears it.
  setNotice(text) {
    this.notice.textContent = text || '';
    this.notice.classList.toggle('show', !!text);
  }

  // players: [{ name, color, character, connected, local, current }]
  chips(players, room) {
    this.chipsEl.replaceChildren();
    for (const p of players) {
      const c = make('span', `chip${p.connected || p.local ? '' : ' off'}${p.current ? ' current' : ''}`, null, this.chipsEl);
      c.style.setProperty('--c', colorHex(p.color));
      const ch = getCharacter(p.character || 'tung_tung');
      const ci = make('span', 'chip-char-icon', ch.icon, c);
      ci.title = ch.name;
      make('b', null, p.name, c);
      if (p.local) make('small', null, '⌨', c);
      else if (!p.connected) make('small', null, 'offline', c);
    }
    if (room) make('span', 'chip room', `Room ${room}`, this.chipsEl);
  }
}
