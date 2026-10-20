// Shared between server.js, the TV and the phone remote. Pure constants and
// helpers: no DOM, no Node APIs.

export const GAME_TITLE = 'Krishiv Sports';
export const MAX_PLAYERS = 4;

// Room codes: 4 letters from an alphabet without look-alikes (no I, L, O).
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;

export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_ALPHABET.includes(ch)) return null;
  return code;
}

// Player colours, in slot order. Same set as Bowling, so a colour picked here
// carries over to the bowling ball.
export const PLAYER_COLORS = [
  { id: 'blue', name: 'Blue', hex: '#2f7bf5' },
  { id: 'red', name: 'Red', hex: '#e8384f' },
  { id: 'green', name: 'Green', hex: '#2fb45a' },
  { id: 'orange', name: 'Orange', hex: '#ff8a1f' },
  { id: 'purple', name: 'Purple', hex: '#8a4ff0' },
  { id: 'pink', name: 'Pink', hex: '#ff5fb0' },
  { id: 'yellow', name: 'Yellow', hex: '#f5c518' },
  { id: 'black', name: 'Black', hex: '#2b2d38' },
];
export const COLOR_IDS = PLAYER_COLORS.map((c) => c.id);
export const colorHex = (id) => (PLAYER_COLORS.find((c) => c.id === id) || PLAYER_COLORS[0]).hex;

export const NAME_MAX = 10;
// C0 / C1 controls, zero-width marks, bidi controls and line separators.
const NAME_JUNK_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]', 'g');
// Strips control / zero-width / bidi characters and trims to NAME_MAX code points.
export function cleanName(v) {
  if (typeof v !== 'string') return '';
  const s = v.replace(NAME_JUNK_RE, '').trim();
  return Array.from(s).slice(0, NAME_MAX).join('').trim();
}

// The Brainrot cast (the same eight as Bowling).
export const BRAINROT_CHARACTERS = [
  { id: 'tung_tung', name: 'Tung Tung Tung Sahur', shortName: 'Tung Tung', title: 'Ramadan Slit-Drum Anomaly', tagline: 'Wakes you up at 3 AM. TUNG TUNG TUNG SAHUR!', color: '#d99b38', icon: '🥁', isMain: true },
  { id: 'tralalero', name: 'Tralalero Tralala', shortName: 'Tralalero', title: 'Nike Sneaker Shark', tagline: 'Land-walking apex predator in fresh high-tops.', color: '#2f7bf5', icon: '🦈' },
  { id: 'ballerina', name: 'Ballerina Cappuccina', shortName: 'Ballerina', title: 'Latte Art Ballerina', tagline: 'Pirouettes on steamed milk and foam art.', color: '#ff5fb0', icon: '☕' },
  { id: 'bombardiro', name: 'Bombardiro Crocodilo', shortName: 'Bombardiro', title: 'Tactical Bomber Croc', tagline: 'Twin propellers fused with crocodile firepower.', color: '#2fb45a', icon: '🐊' },
  { id: 'skibidi', name: 'Skibidi Toilet', shortName: 'Skibidi', title: 'The Porcelain Menace', tagline: 'Skibidi dop dop dop yes yes!', color: '#7fc5ec', icon: '🚽' },
  { id: 'patapim', name: 'Brr Brr Patapim', shortName: 'Patapim', title: 'The Long-Nosed Anomaly', tagline: 'Deep woods creature with an impossibly long nose.', color: '#8a4ff0', icon: '🤥' },
  { id: 'smurf_cat', name: 'Smurf Cat', shortName: 'Smurf Cat', title: 'Mushroom Feline (Shailushai)', tagline: 'We live, we love, we lie.', color: '#3caade', icon: '🍄' },
  { id: 'gigachad', name: 'Sigma GigaChad', shortName: 'GigaChad', title: 'The Ultra Sigma Male', tagline: 'Chiseled jawline, gold chain, effortless rizz.', color: '#f5c518', icon: '🗿' },
];
export const CHARACTER_IDS = BRAINROT_CHARACTERS.map((c) => c.id);
export const DEFAULT_CHARACTER = 'tung_tung';
export function getCharacter(id) {
  return BRAINROT_CHARACTERS.find((c) => c.id === id) || BRAINROT_CHARACTERS[0];
}
export const defaultCharacterFor = (slot) => (slot === 0 ? DEFAULT_CHARACTER : CHARACTER_IDS[slot % CHARACTER_IDS.length]);

// The games on the menu, in menu order. `native` games run inside this app
// (each with its own lobby: QR code, players, settings); the others are the
// projects next to this folder, started by the server on their own ports with
// their own lobby. To add a game: an entry here, its card art in tv/art.js.
export const GAMES = [
  { id: 'tennis', name: 'Tennis', icon: '🎾', native: true, players: '1–4 players', blurb: 'Doubles. Swing your phone like a racket — timing aims the ball.' },
  { id: 'golf', name: 'Golf', icon: '⛳', native: true, players: '1–4 players', blurb: 'Nine holes. Hold A, swing like a club — don’t overswing!' },
  { id: 'bowling', name: 'Bowling', icon: '🎳', native: false, players: '1–4 players', blurb: 'Hold B, swing, lift your thumb to roll. Twist to curve.' },
  { id: 'kart', name: 'Krishiv Kart', icon: '🏎️', native: false, players: '1–4 players', blurb: 'Turn your phone like a steering wheel and race.' },
];
export const GAME_IDS = GAMES.map((g) => g.id);
export const getGame = (id) => GAMES.find((g) => g.id === id) || null;

// ---------------------------------------------------------------- tennis / golf options

export const TENNIS_FORMATS = [
  { id: 1, label: '1 game', short: '1 game' },
  { id: 3, label: 'Best of 3 games', short: 'Best of 3' },
  { id: 5, label: 'Best of 5 games', short: 'Best of 5' },
];
export const CPU_LEVELS = [
  { id: 'rookie', label: 'Rookie' },
  { id: 'pro', label: 'Pro' },
  { id: 'champ', label: 'Champion' },
];
// Krishiv Links: three loops of three holes, or all nine. Wind in mph.
export const GOLF_COURSES = [
  { id: 'meadow', label: 'Meadow', holes: [1, 2, 3], wind: [0, 8], sub: 'Holes 1–3 · a light breeze' },
  { id: 'lakeside', label: 'Lakeside', holes: [4, 5, 6], wind: [6, 16], sub: 'Holes 4–6 · water in play' },
  { id: 'clifftop', label: 'Clifftop', holes: [7, 8, 9], wind: [14, 26], sub: 'Holes 7–9 · by the sea, windy' },
  { id: 'full', label: 'Full 9', holes: [1, 2, 3, 4, 5, 6, 7, 8, 9], wind: [0, 22], sub: 'The whole course' },
];

// ---------------------------------------------------------------- remote → display input
//
// Every message is validated and clamped by the server before it is relayed.
//   { t: 'btn', b: BUTTON, down: bool }       D-pad / A / B / + / − / 1 / 2 presses
//   { t: 'tswing', side, speed, plane, roll, lag, age, id, mode }
//        a tennis swing: side 'fh' | 'bh' | 'oh' (forehand / backhand / overhead),
//        speed 0..1.2, plane −1 (chopped down: slice) .. +1 (brushed up: lob),
//        roll −1..1 (wrist roll: + topspin), lag = phone→server ms, age = ms since
//        the swing's peak when it was sent
//   { t: 'gclub', a, r, armed }                golf: live club angle (deg, + = backswing),
//        swing rate (deg/s) and whether A is held (volatile, ~20 Hz)
//   { t: 'gswing', power, curve, practice, peak, back, id, mode }
//        a finished golf swing: power 0..1.5 (1 = the red dot, more = overswing),
//        curve −1..1 (+ = curves right), practice = A was not held
//   { t: 'menu', action, value, opts }         lobby / pause / results actions (host)
//   { t: 'cancel' }                            the grip was lost (call, app switch …)
export const BUTTONS = ['left', 'right', 'up', 'down', 'a', 'b', 'plus', 'minus', 'one', 'two', 'home'];
//   setup {opts}  change the lobby settings      start   start the game from the lobby
//   pause / resume                               quit    pause menu → back to the lobby
//   again   results → play again                 lobby   results → back to the lobby
export const MENU_ACTIONS = ['setup', 'start', 'pause', 'resume', 'quit', 'again', 'lobby'];
export const SWING_SIDES = ['fh', 'bh', 'oh'];
export const INPUT_MODES = ['motion', 'touch', 'keyboard'];

export const NET = {
  httpPort: 3000,
  httpsPort: 3443,
  // The existing games run as child servers on their own ports.
  bowling: { httpPort: 3100, httpsPort: 3543 },
  kart: { httpPort: 3200, httpsPort: 3643 },
};

// Units shown to players.
export const M_TO_YD = 1 / 0.9144;
export const M_TO_FT = 1 / 0.3048;
export const MPS_TO_MPH = 2.23694;
