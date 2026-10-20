// A game's lobby (Tennis / Golf), laid out like Bowling's and Krishiv Kart's:
// the QR code to join on the left; the players, the game's settings and Start
// on the right. Phones join here; the first phone (or the keyboard) is the host
// and can change the settings and start from the phone too. A game needs at
// least one player — a phone or a keyboard player — no CPU-only matches.
import { MAX_PLAYERS, TENNIS_FORMATS, CPU_LEVELS, GOLF_COURSES, getCharacter, getGame, colorHex } from '../shared/protocol.js';
import { make, faceEl } from './ui.js';
import { SPORT_ART, SPORT_STYLE } from './art.js';

const STORE = 'krishivsports.lobby';

// Tennis team layouts for the players who joined (seat keys in join order).
// Every layout puts every player on the court.
export function tennisPresets(humans) {
  const [a, b, c, d] = humans;
  switch (humans.length) {
    case 0: return [];
    case 1: return [
      { id: 'both', label: 'You play both', sub: 'Control both players on your side', teams: [[a, a], ['cpu', 'cpu']] },
      { id: 'partner', label: 'CPU partner', sub: 'You play back, a CPU at the net', teams: [[a, 'cpu'], ['cpu', 'cpu']] },
    ];
    case 2: return [
      { id: 'coop', label: 'Team up', sub: 'Both of you vs two CPUs', teams: [[a, b], ['cpu', 'cpu']] },
      { id: 'versus', label: 'Head to head', sub: 'Each of you plays both players', teams: [[a, a], [b, b]] },
      { id: 'versusCpu', label: 'With CPU partners', sub: 'Each of you + a CPU partner', teams: [[a, 'cpu'], [b, 'cpu']] },
    ];
    case 3: return [
      { id: 'twoVsOne', label: '2 vs 1', sub: 'P3 plays both players', teams: [[a, b], [c, c]] },
      { id: 'twoVsCpu', label: '2 vs 1 + CPU', sub: 'P3 with a CPU partner', teams: [[a, b], [c, 'cpu']] },
    ];
    default: return [
      { id: 'pairs', label: 'P1 & P2 vs P3 & P4', teams: [[a, b], [c, d]] },
      { id: 'mixed', label: 'P1 & P3 vs P2 & P4', teams: [[a, c], [b, d]] },
    ];
  }
}

const HOW_TO = {
  tennis: [
    'You only swing — players run by themselves',
    'Early = cross-court · late = down the line',
    'Serve: toss, then swing at the top',
  ],
  golf: [
    'Hold A + swing · without A = practice',
    'Past the top dot = overswing',
    '◀ ▶ aim · ▲ ▼ club · 1 map · 2 eye level',
  ],
};

export class Lobby {
  // app: { seats(), hostSeatKey(), info, audio, onStart(game, opts), onBack(),
  //        addLocal(), removeSeat(seat), cycleCharacter(seat), syncPhones() }
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.el = make('section', 'lobby', null, root);
    this.el.style.display = 'none';
    this.visible = false;
    this.game = null;
    this.tennis = { format: 3, level: 'pro', preset: null, teams: null };
    this.golf = { course: GOLF_COURSES[0].id };
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (TENNIS_FORMATS.some((f) => f.id === saved?.tennis?.format)) this.tennis.format = saved.tennis.format;
      if (CPU_LEVELS.some((l) => l.id === saved?.tennis?.level)) this.tennis.level = saved.tennis.level;
      if (GOLF_COURSES.some((c) => c.id === saved?.golf?.course)) this.golf.course = saved.golf.course;
    } catch { /* none */ }
  }

  _save() {
    try { localStorage.setItem(STORE, JSON.stringify({ tennis: { format: this.tennis.format, level: this.tennis.level }, golf: this.golf })); } catch { /* blocked */ }
  }

  show(game) {
    this.game = game;
    this.visible = true;
    this.el.style.display = '';
    this.render();
  }

  hide() {
    this.visible = false;
    this.el.style.display = 'none';
  }

  setSound(on) { this.soundPill?.classList.toggle('off', !!on); }

  // ------------------------------------------------------------ settings

  _ensureTeams() {
    const humans = this.app.seats().map((s) => s.key);
    const presets = tennisPresets(humans);
    if (!presets.length) { this.tennis.preset = null; this.tennis.teams = null; return; }
    const placed = (teams) => teams && teams.flat().every((k) => k === 'cpu' || humans.includes(k)) && humans.every((k) => teams.flat().includes(k));
    if (!placed(this.tennis.teams) || !presets.some((p) => p.id === this.tennis.preset)) {
      const p = presets.find((x) => x.id === this.tennis.preset) || presets[0];
      this.tennis.preset = p.id;
      this.tennis.teams = p.teams.map((t) => t.slice());
    }
  }

  // From the TV or the host phone: { format, level, preset, course }.
  applyOptions(o) {
    if (this.game === 'tennis') {
      if (TENNIS_FORMATS.some((f) => f.id === o.format)) this.tennis.format = o.format;
      if (CPU_LEVELS.some((l) => l.id === o.level)) this.tennis.level = o.level;
      if (typeof o.preset === 'string') {
        const p = tennisPresets(this.app.seats().map((s) => s.key)).find((x) => x.id === o.preset);
        if (p) { this.tennis.preset = p.id; this.tennis.teams = p.teams.map((t) => t.slice()); }
      }
    }
    if (this.game === 'golf' && GOLF_COURSES.some((c) => c.id === o.course)) this.golf.course = o.course;
    this._save();
    this.render();
  }

  // At least one player, and (tennis) on the court.
  canStart() {
    const seats = this.app.seats();
    if (!seats.length) return false;
    if (this.game === 'tennis') {
      this._ensureTeams();
      return !!this.tennis.teams?.flat().some((k) => seats.some((s) => s.key === k));
    }
    return true;
  }

  options(game = this.game) {
    if (game === 'tennis') {
      this._ensureTeams();
      return { format: this.tennis.format, level: this.tennis.level, teams: (this.tennis.teams || []).map((t) => t.slice()) };
    }
    return { course: this.golf.course };
  }

  // ------------------------------------------------------------ render

  render() {
    if (!this.visible) return;
    const game = this.game;
    const g = getGame(game);
    const info = this.app.info || {};
    const seats = this.app.seats();
    if (game === 'tennis') this._ensureTeams();
    const el = this.el;
    el.replaceChildren();
    el.dataset.game = game;
    el.style.setProperty('--g', SPORT_STYLE[game]?.g || '#29b6f6');

    // Top bar: back, the game, sound.
    const top = make('header', 'lobby-top', null, el);
    const back = make('button', 'btn ghost small', '◀ Games', top);
    back.addEventListener('click', () => this.app.onBack());
    const title = make('div', 'lobby-title', null, top);
    const icon = make('div', 'icon', null, title);
    icon.innerHTML = SPORT_ART[game] || '';
    const tt = make('div', null, null, title);
    make('h1', null, g.name, tt);
    make('p', null, g.blurb, tt);
    this.soundPill = make('div', 'sound-pill', '🔈 Click anywhere for sound', top);

    const body = make('div', 'lobby-body', null, el);

    // Join card.
    const join = make('div', 'card join', null, body);
    const qr = make('div', 'qr', null, join);
    if (info.qrSvg) qr.innerHTML = info.qrSvg;
    else make('div', 'wait', info.error ? 'Server offline' : 'Connecting…', qr);
    make('h3', null, 'Scan to join', join);
    make('p', null, 'Your phone becomes your controller.', join);
    const rc = make('div', 'room-code', 'ROOM', join);
    make('b', null, info.room || '····', rc);
    if (info.joinUrl) make('div', 'join-url', info.joinUrl.replace(/^https?:\/\//, ''), join);
    if (info.https === false) make('p', 'warn', '⚠️ HTTPS is off — phones will use touch controls.', join);
    make('p', 'hint', 'Same Wi-Fi as this computer. First time: accept the certificate warning (iPhone: Show Details → visit this website · Android: Advanced → Proceed).', join);

    const side = body;   // players | settings, with Start under them (see tv.css)

    // Players.
    const pc = make('div', 'card players', null, side);
    const ph = make('h3', null, 'Players', pc);
    make('small', null, `${seats.length}/${MAX_PLAYERS}`, ph);
    const grid = make('div', 'seats', null, pc);
    const host = this.app.hostSeatKey();
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const s = seats[i];
      const row = make('div', `seat${s ? ' filled' : ''}${s && !s.connected && !s.local ? ' off' : ''}`, null, grid);
      make('span', 'pnum', s ? (s.local ? '⌨️' : `P${s.slot + 1}`) : `P${i + 1}`, row);
      if (!s) { make('span', 'empty', 'Scan the code to join', row); continue; }
      row.style.setProperty('--c', colorHex(s.color));
      if (s.key === host) make('span', 'crown', '👑', row);
      const f = faceEl(s.color, s.character, row);
      f.classList.add('focusable');
      f.title = 'Change character';
      f.addEventListener('click', () => this.app.cycleCharacter(s));
      const who = make('div', 'who', null, row);
      make('b', null, s.name, who);
      make('small', null, `${getCharacter(s.character).shortName}${s.local ? ' · keyboard' : s.connected ? '' : ' · reconnecting…'}`, who);
      const x = make('button', 'x', '×', row);
      x.title = 'Remove player';
      x.addEventListener('click', () => this.app.removeSeat(s));
    }
    const add = make('button', 'btn ghost small add', '+ Keyboard player', pc);
    add.disabled = seats.length >= MAX_PLAYERS;
    add.title = 'For someone without a phone';
    add.addEventListener('click', () => this.app.addLocal());

    // Settings.
    const st = make('div', 'card settings', null, side);
    if (game === 'tennis') this._tennisSettings(st, seats);
    else this._golfSettings(st);

    // Start.
    const act = make('div', 'lobby-actions', null, side);
    const ok = this.canStart();
    const hs = seats.find((s) => s.key === host);
    make('span', 'note', !ok ? 'At least one player has to join — scan the code, or add a keyboard player.'
      : hs && !hs.local ? `P${hs.slot + 1} ${hs.name} can also start from their phone.` : 'Press Enter or click Start.', act);
    const go = make('button', 'btn primary big start', ok ? 'Start ▶' : 'Waiting for players…', act);
    go.disabled = !ok;
    go.addEventListener('click', () => this.app.onStart(game, this.options(game)));
    if (ok) go.classList.add('kbd-focus');

    const foot = make('footer', 'lobby-foot', null, el);
    for (const t of HOW_TO[game] || []) make('span', null, t, foot);
  }

  _optGroup(box, label, items, cur, key, { subs = true } = {}) {
    const row = make('div', 'opt-row', null, box);
    make('span', 'opt-label', label, row);
    const list = make('div', 'opts', null, row);
    for (const it of items) {
      const b = make('button', `opt${it.id === cur ? ' on' : ''}`, it.short || it.label, list);
      if (it.sub && subs) make('small', null, it.sub, b);
      else if (it.sub) b.title = it.sub;
      b.addEventListener('click', () => { this.applyOptions({ [key]: it.id }); this.app.audio.ui('blip'); this.app.syncPhones(); });
    }
  }

  _tennisSettings(box, seats) {
    const byKey = new Map(seats.map((s) => [s.key, s]));
    if (this.tennis.teams) {
      const teams = make('div', 'teams', null, box);
      const tcol = ['#2f7bf5', '#e8384f'];
      this.tennis.teams.forEach((members, ti) => {
        const t = make('div', 'team', null, teams);
        t.style.setProperty('--tc', tcol[ti]);
        members.forEach((k, i) => {
          const p = make('div', 'pos', null, t);
          make('span', 'role', i === 0 ? 'Back' : 'Net', p);
          const s = byKey.get(k);
          if (s) { faceEl(s.color, s.character, p); make('b', null, s.name, p); } else { faceEl('#9aa6b4', null, p).querySelector('i').textContent = '🤖'; make('b', 'cpu', 'CPU', p); }
        });
        if (ti === 0) make('div', 'vs', 'vs', teams);
      });
      const presets = tennisPresets(seats.map((s) => s.key));
      if (presets.length > 1) this._optGroup(box, 'Teams', presets, this.tennis.preset, 'preset', { subs: false });
    } else {
      make('div', 'empty-note', 'Teams appear here when players join.', box);
    }
    this._optGroup(box, 'Match', TENNIS_FORMATS, this.tennis.format, 'format');
    this._optGroup(box, 'CPU skill', CPU_LEVELS, this.tennis.level, 'level');
  }

  _golfSettings(box) {
    this._optGroup(box, 'Course', GOLF_COURSES.map((c) => ({ id: c.id, label: c.label, sub: c.sub })), this.golf.course, 'course');
  }

  // What the phones show while the TV is in this lobby.
  phoneModel() {
    const game = this.game;
    const seats = this.app.seats();
    const out = { game, canStart: this.canStart() };
    if (game === 'tennis') {
      out.tennis = {
        format: this.tennis.format, level: this.tennis.level, preset: this.tennis.preset,
        presets: tennisPresets(seats.map((x) => x.key)).map((p) => ({ id: p.id, label: p.label, sub: p.sub || '' })),
        teams: (this.tennis.teams || []).map((t) => t.map((k) => { const x = seats.find((y) => y.key === k); return x ? { name: x.name, color: x.color, character: x.character } : { name: 'CPU', cpu: true }; })),
      };
    }
    if (game === 'golf') out.golf = { course: this.golf.course };
    return out;
  }
}
