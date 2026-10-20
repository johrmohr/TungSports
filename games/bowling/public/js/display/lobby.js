// Lobby (join QR + player cards), results and pause screens (DOM).
import { colorHex, MAX_PLAYERS, BRAINROT_CHARACTERS, CHARACTER_IDS, getCharacter } from '../shared/protocol.js';
import { miniFace, renderCard } from './hud.js';

const make = (tag, cls, text, parent) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  if (parent) parent.append(e);
  return e;
};

// The Krishiv logo: chunky outlined letters (same family as Krishiv Sports and Krishiv Kart).
function logo(parent, words = [['KRISHIV', 'w1'], ['BOWLING', 'w2']]) {
  const el = make('div', 'ks-logo', null, parent);
  el.setAttribute('role', 'img');
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

export class Screens {
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;      // { start, addLocal, removeLocal, kick, again, lobby, resume, quit, mute, changeCharacter }
    this.lobbyEl = make('section', 'screen-lobby', null, root);
    this.overEl = make('section', 'screen-over', null, root);
    this.pauseEl = make('section', 'screen-pause', null, root);
    this.modalEl = make('div', 'screen-modal', null, root);
    this.bootEl = document.getElementById('boot');
  }

  hideBoot() { this.bootEl?.classList.add('gone'); }

  bootError(text) {
    if (!this.bootEl) return;
    this.bootEl.querySelector('.boot-text').textContent = text;
    this.bootEl.classList.add('error');
  }

  // ------------------------------------------------------------ character picker modal

  showCharacterModal(player) {
    const el = this.modalEl;
    el.replaceChildren();
    const backdrop = make('div', 'modal-backdrop', null, el);
    const box = make('div', 'char-modal-box', null, el);

    const head = make('div', 'modal-head', null, box);
    make('h3', 'modal-title', `Choose Character for ${player.name}`, head);
    const closeBtn = make('button', 'modal-close', '×', head);
    const close = () => el.classList.remove('show');
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);

    const grid = make('div', 'modal-char-grid', null, box);
    for (const c of BRAINROT_CHARACTERS) {
      const card = make('button', `modal-char-card${(player.character || 'tung_tung') === c.id ? ' active' : ''}${c.isMain ? ' is-main' : ''}`, null, grid);
      const icon = make('div', 'modal-char-icon', c.icon, card);
      const info = make('div', 'modal-char-info', null, card);
      const row = make('div', 'modal-char-row', null, info);
      make('b', null, c.name, row);
      if (c.isMain) make('span', 'modal-main-badge', '★ MAIN CHARACTER', row);
      make('span', 'modal-char-title', c.title, info);
      make('small', 'modal-char-tagline', c.tagline, info);

      card.addEventListener('click', () => {
        this.h.changeCharacter?.(player, c.id);
        close();
      });
    }

    el.classList.add('show');
  }

  // ------------------------------------------------------------ lobby

  showLobby(info, players, opts) {
    this.lobbyEl.classList.add('show');
    this.renderLobby(info, players, opts);
  }
  hideLobby() {
    this.lobbyEl.classList.remove('show');
    this.modalEl.classList.remove('show');
  }

  // players: [{ key, slot, local, name, color, character, connected }] in seat order
  renderLobby(info, players, { soundOn = true } = {}) {
    const el = this.lobbyEl;
    el.replaceChildren();
    if (!soundOn) make('div', 'sound-hint', '🔈 Click anywhere on this screen to turn on sound', el);
    const panel = make('div', 'lobby-panel', null, el);
    const left = make('div', 'lobby-join', null, panel);
    const brand = make('div', 'lobby-brand', null, left);
    logo(brand);
    make('div', 'logo-sub', 'Brainrot Edition', brand);
    const qrBox = make('div', 'qr-box', null, left);
    if (info?.qrSvg) qrBox.innerHTML = info.qrSvg;
    else make('div', 'qr-wait', info?.error ? 'Server offline' : 'Connecting…', qrBox);
    make('div', 'scan-title', 'Scan with your phone to join', left);
    if (info?.joinUrl) {
      const u = make('div', 'join-url', null, left);
      u.textContent = info.joinUrl.replace(/^https?:\/\//, '');
    }
    const code = make('div', 'room-code', null, left);
    make('small', null, 'Room', code);
    make('b', null, info?.room || '····', code);
    if (info && info.https === false) make('p', 'lobby-warn', 'HTTPS is off — phones will use touch controls only.', left);
    make('p', 'lobby-hint', 'Same Wi-Fi as this computer. The first time, your phone warns about the certificate — tap Show Details → visit this website (iPhone) or Advanced → Proceed (Android).', left);

    const right = make('div', 'lobby-side', null, panel);
    make('h2', 'lobby-h', 'Players & Characters', right);
    const grid = make('div', 'seat-grid', null, right);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = players[i];
      const card = make('div', `seat${p ? ' filled' : ''}${p && !p.connected && !p.local ? ' off' : ''}`, null, grid);
      make('span', 'seat-no', `P${i + 1}`, card);
      if (p) {
        card.style.setProperty('--c', colorHex(p.color));
        const charObj = getCharacter(p.character || (i === 0 ? 'tung_tung' : CHARACTER_IDS[i % CHARACTER_IDS.length]));
        const face = make('div', 'seat-face', null, card);
        miniFace(p.color, face, charObj.id);
        make('b', 'seat-name', p.name, card);

        // Interactive character selector right on the card
        const charBox = make('div', 'seat-char-box', null, card);
        const prevBtn = make('button', 'seat-char-nav', '◀', charBox);
        prevBtn.title = 'Previous Character';
        prevBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const curIdx = CHARACTER_IDS.indexOf(charObj.id);
          const nextId = CHARACTER_IDS[(curIdx - 1 + CHARACTER_IDS.length) % CHARACTER_IDS.length];
          this.h.changeCharacter?.(p, nextId);
        });

        const pill = make('button', `seat-char-pill${charObj.isMain ? ' is-main' : ''}`, null, charBox);
        pill.title = 'Click to open character menu';
        make('span', 'pill-icon', charObj.icon, pill);
        make('span', 'pill-name', charObj.shortName, pill);
        if (charObj.isMain) make('span', 'pill-main', '★ MAIN', pill);
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          this.showCharacterModal(p);
        });

        const nextBtn = make('button', 'seat-char-nav', '▶', charBox);
        nextBtn.title = 'Next Character';
        nextBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const curIdx = CHARACTER_IDS.indexOf(charObj.id);
          const nextId = CHARACTER_IDS[(curIdx + 1) % CHARACTER_IDS.length];
          this.h.changeCharacter?.(p, nextId);
        });

        make('span', 'seat-status', p.local ? 'Keyboard' : p.connected ? 'Remote connected' : 'Reconnecting…', card);
        const x = make('button', 'seat-x', '×', card);
        x.title = 'Remove player';
        x.addEventListener('click', () => (p.local ? this.h.removeLocal(p.key) : this.h.kick(p.slot)));
      } else {
        make('div', 'seat-empty', 'Scan code to join as a Brainrot Bowler', card);
      }
    }
    const actions = make('div', 'lobby-actions', null, right);
    const add = make('button', 'btn ghost', '+ Add player without phone', actions);
    add.disabled = players.filter(Boolean).length >= MAX_PLAYERS;
    add.addEventListener('click', () => this.h.addLocal());
    const start = make('button', 'btn primary', players.some(Boolean) ? `Start game  ▶` : 'Waiting for players…', actions);
    start.disabled = !players.some(Boolean);
    start.addEventListener('click', () => this.h.start());
    make('p', 'lobby-hint', 'Choose your characters above! Player 1 defaults to Tung Tung Tung Sahur. Press Enter or Start on phone.', right);
    const how = make('div', 'howto', null, right);
    make('b', null, 'How to bowl', how);
    const ol = make('ol', null, null, how);
    for (const t of [
      'Hold your phone like a remote control — screen up, top pointing at the TV.',
      '◀ ▶ moves your bowler. Press A to switch to Turn and aim.',
      'Hold B, swing your arm back and forward, and lift your thumb at the bottom to let go.',
      'Twist your wrist as you let go to curve the ball into the pocket.',
    ]) make('li', null, t, ol);
    make('p', 'lobby-safety', 'Grip the phone with your whole hand — you bowl by lifting your thumb, never by letting go. Keep clear of people and the TV.', right);
  }

  // ------------------------------------------------------------ results

  showOver(board, standings, { canAgain = true } = {}) {
    const el = this.overEl;
    el.replaceChildren();
    const box = make('div', 'over-panel', null, el);
    const winner = standings[0];
    const tie = standings.filter((s) => s.place === 1).length > 1;
    make('div', 'over-title', standings.length === 1 ? 'Final score' : tie ? 'It’s a tie!' : `${winner.name} wins!`, box);
    const cards = make('div', 'over-cards', null, box);
    for (const s of standings) {
      const c = make('div', `result-card${s.place === 1 ? ' first' : ''}`, null, cards);
      c.style.setProperty('--c', colorHex(s.color));
      const charObj = getCharacter(s.character);
      make('span', 'rc-place', ['1st', '2nd', '3rd', '4th'][s.place - 1] || `${s.place}th`, c);
      miniFace(s.color, make('div', 'rc-face', null, c), s.character);
      make('b', 'rc-name', s.name, c);
      make('span', 'rc-char', `${charObj.icon} ${charObj.shortName}`, c);
      make('span', 'rc-score', String(s.total), c);
    }
    const cardWrap = make('div', 'over-sheet', null, box);
    renderCard(cardWrap, board, { current: -1 });
    const actions = make('div', 'over-actions', null, box);
    const again = make('button', 'btn primary', 'Play again', actions);
    again.disabled = !canAgain;
    again.addEventListener('click', () => this.h.again());
    make('button', 'btn ghost', 'Back to lobby', actions).addEventListener('click', () => this.h.lobby());
    make('p', 'lobby-hint', 'Enter: play again · Esc: lobby · or use Player 1’s phone', box);
    el.classList.add('show');
  }
  hideOver() { this.overEl.classList.remove('show'); }

  // ------------------------------------------------------------ pause

  showPause() {
    const el = this.pauseEl;
    el.replaceChildren();
    const box = make('div', 'pause-panel', null, el);
    make('div', 'pause-title', 'Paused', box);
    make('button', 'btn primary', 'Continue', box).addEventListener('click', () => this.h.resume());
    make('button', 'btn ghost', 'Quit to lobby', box).addEventListener('click', () => this.h.quit());
    el.classList.add('show');
  }
  hidePause() { this.pauseEl.classList.remove('show'); }
}
