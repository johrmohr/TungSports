// Tennis HUD (DOM): the scoreboard, player tags, "Out" calls, replay label,
// prompts and the results screen.
import { colorHex, getCharacter } from '../../shared/protocol.js';
import { make, faceEl } from '../ui.js';

export const TEAM_COLORS = ['#2f7bf5', '#e8384f'];

export class TennisHud {
  constructor(root) {
    this.root = make('div', 'tennis-hud', null, root);
    this.board = make('div', 't-board', null, this.root);
    this.tagsEl = make('div', 't-tags', null, this.root);
    this.promptEl = null;
    this.replayEl = null;
    this.outEl = null;
    this.splitEl = null;
    this.tagEls = new Map();
    this.bannerRoot = make('div', 'pass', null, this.root);
  }

  // teams: [{ players: [{ name, color, character, human, label }] }, …]; snap: TennisMatch.snapshot()
  score(teams, snap) {
    const b = this.board;
    b.replaceChildren();
    teams.forEach((t, i) => {
      const row = make('div', `t-row${snap.server.team === i ? ' serving' : ''}`, null, b);
      row.style.setProperty('--tc', TEAM_COLORS[i]);
      make('div', 'stripe', null, row);
      const faces = make('div', 'faces', null, row);
      for (const p of t.players) faceEl(p.color, p.character, faces);
      const names = make('div', 'names', null, row);
      make('b', null, t.title, names);
      make('small', null, t.sub, names);
      const games = make('div', 'games', null, row);
      for (let k = 0; k < snap.format; k++) {
        if (k >= Math.ceil(snap.format / 2)) break;
        make('i', k < snap.games[i] ? 'on' : '', null, games);
      }
      const pts = make('div', `pts${snap.labels[i] === 'Ad' ? ' ad' : ''}`, snap.labels[i], row);
      void pts;
    });
  }

  // tags: [{ id, x, y, text, color, cpu, hit }] in screen pixels
  tags(list) {
    const seen = new Set();
    for (const t of list) {
      seen.add(t.id);
      let el = this.tagEls.get(t.id);
      if (!el) { el = make('div', 't-tag', null, this.tagsEl); this.tagEls.set(t.id, el); }
      if (el.textContent !== t.text) el.textContent = t.text;
      el.classList.toggle('cpu', !!t.cpu);
      el.classList.toggle('hit', !!t.hit);
      el.style.setProperty('--c', t.color);
      el.style.left = `${t.x.toFixed(1)}px`;
      el.style.top = `${t.y.toFixed(1)}px`;
      el.style.display = t.hidden ? 'none' : '';
    }
    for (const [id, el] of this.tagEls) if (!seen.has(id)) { el.remove(); this.tagEls.delete(id); }
  }

  out(x, y) {
    this.clearOut();
    this.outEl = make('div', 't-out', 'OUT', this.root);
    this.outEl.style.left = `${x}px`;
    this.outEl.style.top = `${y}px`;
  }
  clearOut() { this.outEl?.remove(); this.outEl = null; }

  replay(on) {
    if (on && !this.replayEl) {
      this.replayEl = make('div', 't-replay', 'REPLAY', this.root);
      make('small', null, 'A / swing to skip', this.replayEl);
    } else if (!on && this.replayEl) { this.replayEl.remove(); this.replayEl = null; }
  }

  prompt(text, key = 'A', sub = null, x = '50%') {
    this.hidePrompt();
    const p = make('div', 'prompt', null, this.root);
    p.style.left = x;
    p.style.bottom = '3vh';
    p.style.transform = 'translateX(-50%)';
    p.style.whiteSpace = 'nowrap';
    p.style.fontSize = '22px';
    if (key) make('span', 'k', key, p);
    const t = make('span', null, null, p);
    make('b', null, text, t);
    if (sub) { t.append(document.createElement('br')); t.append(sub); }
    this.promptEl = p;
  }
  hidePrompt() { this.promptEl?.remove(); this.promptEl = null; }

  split(on) {
    if (on && !this.splitEl) this.splitEl = make('div', 't-split', null, this.root);
    else if (!on && this.splitEl) { this.splitEl.remove(); this.splitEl = null; }
  }

  // The match result.
  results({ title, sub, teams, winner, stats }, { onAgain, onLobby }) {
    const wrap = make('div', 'results', null, this.root);
    wrap.style.pointerEvents = 'auto';
    const panel = make('div', 'panel', null, wrap);
    make('h2', null, title, panel);
    make('p', 'subtitle', sub, panel);
    const pod = make('div', 'podium', null, panel);
    teams.forEach((t, i) => {
      const card = make('div', `pcard${i === winner ? ' first' : ''}`, null, pod);
      card.style.setProperty('--c', TEAM_COLORS[i]);
      make('div', 'place', i === winner ? '🏆 Winners' : 'Runners-up', card);
      const faces = make('div', null, null, card);
      faces.style.display = 'flex'; faces.style.justifyContent = 'center'; faces.style.gap = '8px';
      for (const p of t.players) faceEl(p.color, p.character, faces);
      make('b', null, t.title, card);
      make('div', 'score', String(t.games), card);
      make('small', null, t.sub, card);
    });
    if (stats?.length) {
      const st = make('div', 'subtitle', stats.join('  ·  '), panel);
      st.style.marginTop = '16px';
    }
    const act = make('div', 'actions', null, panel);
    const again = make('button', 'btn primary', 'Play again', act);
    again.addEventListener('click', onAgain);
    const lobby = make('button', 'btn ghost', 'Back to the lobby', act);
    lobby.addEventListener('click', onLobby);
    again.classList.add('kbd-focus');
    make('div', 'hint', 'Enter: play again · Esc: back to the lobby', panel);
    this.resultsEl = wrap;
    return wrap;
  }

  dispose() { this.root.remove(); }
}

export function teamTitle(players) {
  const humans = players.filter((p) => p.human);
  if (!humans.length) return { title: players.map((p) => getCharacter(p.character).shortName).join(' & '), sub: 'CPU' };
  const names = [...new Set(players.map((p) => p.name))];
  return { title: names.join(' & '), sub: players.map((p) => (p.human ? p.label : 'CPU')).filter((v, i, a) => a.indexOf(v) === i).join(' · ') };
}

void colorHex;
