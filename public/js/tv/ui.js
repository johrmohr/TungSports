// Small DOM helpers shared by the menu, the lobbies and the game HUDs.
import { colorHex, getCharacter } from '../shared/protocol.js';

export const make = (tag, cls, text, parent) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  if (parent) parent.append(e);
  return e;
};

// A tiny character avatar: the character's emoji on the player's colour.
export function faceEl(color, characterId, parent = null, cls = '') {
  const ch = getCharacter(characterId);
  const f = make('span', `face ${cls}`.trim(), null, parent);
  f.style.setProperty('--c', color && color.startsWith('#') ? color : colorHex(color));
  f.title = ch.name;
  make('i', null, ch.icon, f);
  return f;
}

// The Krishiv logo: chunky outlined letters (same family as Krishiv Kart's).
export function logo(parent, words = [['KRISHIV', 'w1'], ['SPORTS', 'w2']], cls = '') {
  const el = make('div', `ks-logo ${cls}`.trim(), null, parent);
  el.setAttribute('aria-label', words.map(([w]) => w).join(' '));
  let i = 0;
  for (const [word, wcls] of words) {
    const w = make('span', `ks-word ${wcls}`, null, el);
    for (const ch of word) {
      const c = make('span', 'ks-ch', null, w);
      c.style.setProperty('--i', String(i++));
      make('span', 'b', ch, c);
      make('span', 'f', ch, c);
    }
  }
  return el;
}

// Full-screen overlay: loading a game, starting Bowling / Kart, errors.
let overlayEl = null;
export function showOverlay(root, { title, text, tips = [], error = false, spinner = true, actions = [] }) {
  hideOverlay();
  const o = make('div', `overlay${error ? ' err' : ''}`, null, root);
  const inner = make('div', 'inner', null, o);
  if (spinner) make('div', 'spin', null, inner);
  make('h2', null, title, inner);
  if (text) make('p', null, text, inner);
  if (tips.length) { const t = make('div', 'tips', null, inner); for (const x of tips) make('div', null, x, t); }
  if (actions.length) {
    const a = make('div', 'overlay-actions', null, inner);
    for (const { label, primary, fn } of actions) {
      const b = make('button', `btn${primary ? ' primary' : ' ghost'}`, label, a);
      b.addEventListener('click', fn);
    }
  }
  overlayEl = o;
  return o;
}
export function hideOverlay() { overlayEl?.remove(); overlayEl = null; }
export const overlayText = (text) => { const p = overlayEl?.querySelector('p'); if (p) p.textContent = text; };

let toastBox = null;
export function toast(text, ms = 2600) {
  if (!toastBox) toastBox = make('div', 'toasts', null, document.body);
  const t = make('div', 'toast', text, toastBox);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 450);
  return t;
}

let noticeEl = null;
export function notice(text) {
  if (!noticeEl) noticeEl = make('div', 'notice', null, document.body);
  noticeEl.textContent = text || '';
  noticeEl.classList.toggle('show', !!text);
}

// Big outlined banner text in the middle of the screen.
//   kind: '' (blue) | 'gold' | 'red' | 'green' | 'dark'
export function banner(root, title, sub = null, { kind = '', ms = 1800, top = null } = {}) {
  const b = make('div', `banner ${kind}`, null, root);
  if (top !== null) b.style.top = top;
  make('div', 'big', title, b);
  if (sub) make('div', 'sub', sub, b);
  if (ms) {
    setTimeout(() => b.classList.add('out'), ms);
    setTimeout(() => b.remove(), ms + 400);
  }
  return b;
}

// The metallic band (a big moment: Hole in One, Match point won…).
export function band(root, title, sub = null, ms = 2600) {
  const b = make('div', 'band', null, root);
  make('div', 't', title, b);
  if (sub) make('div', 's', sub, b);
  setTimeout(() => b.classList.add('out'), ms);
  setTimeout(() => b.remove(), ms + 400);
  return b;
}

export function clearBanners(root) {
  for (const e of root.querySelectorAll('.banner, .band')) e.remove();
}

export const ordinal = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
