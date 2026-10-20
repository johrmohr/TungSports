// Golf HUD (DOM + a canvas minimap): hole card, current player, wind, the
// power meter (three dots and the red one; the lie's cap; red and bent on an
// overswing), club, distance, minimap with the aim line and the power dots,
// shot callouts, the hole flyover card and the scorecard.
import { colorHex, getCharacter, M_TO_YD, M_TO_FT } from '../../shared/protocol.js';
import { make, faceEl } from '../ui.js';
import { scoreName, toParText, PARS } from '../../shared/golf-rules.js';
import { CLUBS } from '../../shared/golf-physics.js';

const SURF_RGB = { tee: '#7cc45c', fairway: '#74be54', green: '#8ad668', fringe: '#68b04c', rough: '#42883a', sand: '#ecd6a0', water: '#3478aa', ob: '#2f5f2c' };
const LIE_NAME = { tee: 'Tee', fairway: 'Fairway', rough: 'Rough', sand: 'Bunker', green: 'Green', fringe: 'Fringe' };

export class GolfHud {
  constructor(root) {
    this.root = make('div', 'golf-hud', null, root);
    this.holeEl = make('div', 'g-hole', null, this.root);
    this.playerEl = make('div', 'g-player', null, this.root);
    this.windEl = make('div', 'g-wind', null, this.root);
    make('div', 'lbl', 'WIND', this.windEl);
    this.windArrow = make('div', 'arrow', null, this.windEl);
    this.windArrow.innerHTML = '<svg viewBox="-50 -50 100 100"><path d="M0 -40 L18 -6 L7 -6 L7 38 L-7 38 L-7 -6 L-18 -6 Z" fill="#e8384f" stroke="#fff" stroke-width="4" stroke-linejoin="round"/></svg>';
    this.windMph = make('div', 'mph', '0 mph', this.windEl);
    this.meterEl = make('div', 'g-meter', null, this.root);
    this.bar = make('div', 'bar', null, this.meterEl);
    this.ghost = make('div', 'ghost', null, this.bar);
    this.fill = make('div', 'fill', null, this.bar);
    this.dots = [0.25, 0.5, 0.75, 1].map((v, i) => { const d = make('div', `dot${i === 3 ? ' red' : ''}`, null, this.bar); d.style.bottom = this._css(v); return d; });
    this.capEl = make('div', 'cap', null, this.bar);
    const info = make('div', 'info', null, this.meterEl);
    this.clubEl = make('div', 'club', null, info);
    this.lieEl = make('div', 'lie', null, info);
    this.aEl = make('div', 'lie', 'A', info);
    this.aEl.style.display = 'none';
    this.mapEl = make('div', 'g-map', null, this.root);
    this.mapCanvas = make('canvas', null, null, this.mapEl);
    this.distEl = make('div', 'g-dist', null, this.root);
    this.bannerRoot = make('div', 'pass', null, this.root);
    this.shotEl = null;
    this.visible = true;
  }

  // Meter height: 0 → 0 %, 1 (red dot) → 80 %, 1.25 → 100 %.
  _pct(v) { return Math.max(0, Math.min(1.25, v)) / 1.25 * 100; }
  // Inside the bar's 9 px padding.
  _css(v, base = 9) { return `calc(${base}px + (100% - 18px) * ${(this._pct(v) / 100).toFixed(4)})`; }

  show(on) {
    this.visible = on;
    for (const e of [this.holeEl, this.playerEl, this.windEl, this.meterEl, this.mapEl, this.distEl]) e.style.display = on ? '' : 'none';
  }

  hole(n, par, yards, holeIndex, holes) {
    this.holeEl.replaceChildren();
    const num = make('div', 'num', null, this.holeEl);
    make('small', null, 'HOLE', num);
    make('b', null, String(n), num);
    const meta = make('div', 'meta', null, this.holeEl);
    make('b', null, `Par ${par}`, meta);
    make('span', null, `${yards} yds · ${holeIndex + 1}/${holes}`, meta);
  }

  player(p, stroke, toPar) {
    this.playerEl.replaceChildren();
    faceEl(p.color, p.character, this.playerEl);
    this.playerEl.append(p.name);
    make('small', null, `${stroke === 1 ? '1st' : stroke === 2 ? '2nd' : stroke === 3 ? '3rd' : `${stroke}th`} shot · ${toParText(toPar)}`, this.playerEl);
    this.playerEl.style.borderLeft = `6px solid ${colorHex(p.color)}`;
  }

  // relDeg: wind direction relative to the view (0 = blowing away from the camera).
  wind(mph, relDeg) {
    this.windMph.textContent = `${Math.round(mph)} mph`;
    this.windArrow.style.transform = `rotate(${relDeg}deg)`;
    this.windArrow.style.opacity = mph < 0.5 ? '0.25' : '1';
  }

  club(clubId, lie, cap, putterMaxFt = null) {
    this.clubEl.replaceChildren();
    const c = CLUBS[clubId];
    make('b', null, c.short, this.clubEl);
    make('small', null, c.putter ? `${c.name} · ${Math.round(putterMaxFt)} ft` : `${c.name} · ${Math.round(c.maxCarry * M_TO_YD)} yds`, this.clubEl);
    this.lieEl.textContent = LIE_NAME[lie] || lie;
    this.lieEl.className = `lie ${lie}`;
    this.capEl.style.display = cap < 1 ? 'block' : 'none';
    this.capEl.style.bottom = this._css(cap);
    this.dots.forEach((d, i) => { d.style.opacity = (i + 1) / 4 <= cap + 1e-6 ? '1' : '0.35'; });
    this.cap = cap;
  }

  // Live / final power. curve: −1..1 (for the bend when it is an overswing).
  power(v, { over = false, curve = 0, ghost = null } = {}) {
    this.fill.style.height = this._css(v, 0);
    this.ghost.style.height = ghost === null || ghost === undefined ? '0' : this._css(ghost, 0);
    this.bar.classList.toggle('over', over);
    this.bar.classList.toggle('bendL', over && curve < 0);
    this.bar.classList.toggle('bendR', over && curve > 0);
  }

  armed(on) { this.aEl.style.display = on ? '' : 'none'; this.aEl.style.background = on ? '#0b8fd8' : ''; }

  distance(text, sub = '') {
    this.distEl.replaceChildren();
    this.distEl.append(text);
    if (sub) make('small', null, sub, this.distEl);
    this.distEl.style.display = text && this.visible ? '' : 'none';
  }

  shot(title, sub = null, ms = 2200) {
    this.shotEl?.remove();
    const e = make('div', 'g-shot', title, this.root);
    if (sub) make('small', null, sub, e);
    this.shotEl = e;
    clearTimeout(this._shotT);
    this._shotT = setTimeout(() => { e.remove(); if (this.shotEl === e) this.shotEl = null; }, ms);
  }

  clearShot() { this.shotEl?.remove(); this.shotEl = null; }

  flyover(n, par, yards, on = true, name = '') {
    this.flyEl?.remove();
    this.flyEl = null;
    if (!on) return;
    const f = make('div', 'g-flyover', null, this.root);
    const c = make('div', 'card-h', null, f);
    make('b', null, `Hole ${n}`, c);
    if (name) make('em', null, name, c);
    make('span', null, `Par ${par} · ${yards} yds`, c);
    make('div', 'skip', 'Press A to skip', f);
    this.flyEl = f;
  }

  // The hole map (static) is drawn once; balls and the aim line on top each frame.
  buildMap(hole, map) {
    const { ids, W, H } = map;
    const { x0, x1, z0, z1 } = hole.extent;
    // Crop to the bounds (plus a little).
    const b = hole.def.bounds.poly;
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const [x, z] of b) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
    bx0 -= 8; bx1 += 8; bz0 -= 8; bz1 += 8;
    const cw = 200, ch = Math.round(this.mapEl.clientHeight || 400) || 400;
    const scale = Math.min(cw / (bx1 - bx0), ch / (bz1 - bz0));
    const base = document.createElement('canvas');
    base.width = cw; base.height = ch;
    const g = base.getContext('2d');
    g.fillStyle = '#2d5f2a';
    g.fillRect(0, 0, cw, ch);
    const ox = (cw - (bx1 - bx0) * scale) / 2, oz = (ch - (bz1 - bz0) * scale) / 2;
    const toPx = (x, z) => [ox + (x - bx0) * scale, oz + (z - bz0) * scale];
    const step = Math.max(1, Math.floor(1 / scale / map.mpp));
    for (let pz = 0; pz < H; pz += step) {
      const z = z0 + (pz + 0.5) * map.mpp;
      if (z < bz0 || z > bz1) continue;
      for (let px = 0; px < W; px += step) {
        const x = x0 + (px + 0.5) * map.mpp;
        if (x < bx0 || x > bx1) continue;
        const id = ids[pz * W + px];
        g.fillStyle = SURF_RGB[['tee', 'fairway', 'rough', 'sand', 'green', 'fringe', 'water', 'ob'][id]];
        const [qx, qz] = toPx(x, z);
        g.fillRect(qx, qz, Math.ceil(step * map.mpp * scale) + 0.5, Math.ceil(step * map.mpp * scale) + 0.5);
      }
    }
    g.fillStyle = 'rgba(20, 70, 30, 0.85)';
    for (const t of hole.trees) {
      if (t.x < bx0 || t.x > bx1 || t.z < bz0 || t.z > bz1) continue;
      const [qx, qz] = toPx(t.x, t.z);
      g.beginPath(); g.arc(qx, qz, Math.max(1.2, 2.8 * t.s * scale), 0, Math.PI * 2); g.fill();
    }
    this.mapBase = base;
    this.mapToPx = toPx;
    this.mapScale = scale;
    this.mapCanvas.width = cw;
    this.mapCanvas.height = ch;
  }

  // balls: [{ x, z, color, current }]; aim: { from, marks: [{x,z}] } | null; pin: {x,z}
  drawMap(balls, aim, pin) {
    if (!this.mapBase) return;
    const g = this.mapCanvas.getContext('2d');
    g.drawImage(this.mapBase, 0, 0);
    const P = this.mapToPx;
    if (pin) {
      const [px, pz] = P(pin.x, pin.z);
      g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(px, pz); g.lineTo(px, pz - 12); g.stroke();
      g.fillStyle = '#e8384f';
      g.beginPath(); g.moveTo(px, pz - 12); g.lineTo(px + 9, pz - 9); g.lineTo(px, pz - 6); g.fill();
    }
    if (aim) {
      const [fx, fz] = P(aim.from.x, aim.from.z);
      const last = aim.marks[aim.marks.length - 1];
      const [lx, lz] = P(last.x, last.z);
      g.strokeStyle = 'rgba(54, 183, 255, 0.95)';
      g.setLineDash([3, 4]);
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(fx, fz); g.lineTo(lx, lz); g.stroke();
      g.setLineDash([]);
      aim.marks.forEach((m, i) => {
        const [mx, mz] = P(m.x, m.z);
        g.fillStyle = i === aim.marks.length - 1 ? '#e8384f' : '#ffffff';
        g.beginPath(); g.arc(mx, mz, i === aim.marks.length - 1 ? 3.6 : 2.6, 0, Math.PI * 2); g.fill();
      });
    }
    for (const b of balls) {
      const [bx, bz] = P(b.x, b.z);
      g.fillStyle = colorHex(b.color);
      g.strokeStyle = '#fff';
      g.lineWidth = b.current ? 2.5 : 1.5;
      g.beginPath(); g.arc(bx, bz, b.current ? 5 : 3.6, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }

  // The scorecard. rows: [{ name, color, character, scores: [strokes|null], total, toPar }]
  scorecard(holes, rows, { current = -1, title = 'Scorecard', sub = null, final = false, onAgain = null, onLobby = null } = {}) {
    this.cardEl?.remove();
    const wrap = make('div', 'results', null, this.root);
    wrap.style.pointerEvents = 'auto';
    const panel = make('div', 'panel', null, wrap);
    make('h2', null, title, panel);
    if (sub) make('p', 'subtitle', sub, panel);
    if (final) {
      const pod = make('div', 'podium', null, panel);
      for (const r of rows.slice().sort((a, b) => a.place - b.place)) {
        const card = make('div', `pcard${r.place === 1 ? ' first' : ''}`, null, pod);
        card.style.setProperty('--c', colorHex(r.color));
        make('div', 'place', r.place === 1 ? '🏆 1st' : r.place === 2 ? '2nd' : r.place === 3 ? '3rd' : `${r.place}th`, card);
        faceEl(r.color, r.character, card);
        make('b', null, r.name, card);
        make('div', 'score', toParText(r.toPar), card);
        make('small', null, `${r.total} strokes`, card);
      }
    }
    const t = make('table', 'scorecard', null, panel);
    t.style.marginTop = '16px';
    const thead = make('thead', null, null, t);
    const hr = make('tr', null, null, thead);
    make('th', null, 'Hole', hr);
    for (const h of holes) make('th', null, String(h), hr);
    make('th', null, 'Total', hr);
    make('th', null, '±', hr);
    const tb = make('tbody', null, null, t);
    const pr = make('tr', 'par', null, tb);
    make('td', null, 'Par', pr);
    let parTot = 0;
    for (const h of holes) { make('td', null, String(PARS[h]), pr); parTot += PARS[h]; }
    make('td', null, String(parTot), pr);
    make('td', null, '', pr);
    for (const r of rows) {
      const tr = make('tr', null, null, tb);
      const nm = make('td', 'name', null, tr);
      nm.style.setProperty('--c', colorHex(r.color));
      faceEl(r.color, r.character, nm);
      nm.append(r.name);
      holes.forEach((h, i) => {
        const s = r.scores[i];
        const d = s === null || s === undefined ? null : s - PARS[h];
        make('td', `s${d !== null && d < 0 ? ' under' : ''}${d !== null && d >= 2 ? ' over2' : ''}${i === current ? ' cur' : ''}`, s ?? '', tr);
      });
      make('td', 'tot', String(r.total), tr);
      make('td', 'topar', toParText(r.toPar), tr);
    }
    if (final) {
      const act = make('div', 'actions', null, panel);
      const again = make('button', 'btn primary', 'Play again', act);
      again.addEventListener('click', onAgain);
      const lobby = make('button', 'btn ghost', 'Back to the lobby', act);
      lobby.addEventListener('click', onLobby);
      again.classList.add('kbd-focus');
      make('div', 'hint', 'Enter: play again · Esc: back to the lobby', panel);
    } else make('div', 'hint', 'Press A to continue', panel);
    this.cardEl = wrap;
    return wrap;
  }

  hideCard() { this.cardEl?.remove(); this.cardEl = null; }

  dispose() { this.root.remove(); }
}

export const fmtDist = (m, putt = false) => (putt ? `${Math.max(1, Math.round(m * M_TO_FT))} ft` : `${Math.max(1, Math.round(m * M_TO_YD))} yds`);
void getCharacter; void scoreName;
