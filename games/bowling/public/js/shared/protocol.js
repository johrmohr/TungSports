// Shared between server.js, the display (big screen) and the phone remote.
// Pure constants and helpers: no DOM, no Node APIs.

export const GAME_TITLE = 'Krishiv Bowling';
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

// Ball / player colours, in slot order (P1 is blue).
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

// Remote → display input messages (validated by the server):
//   { t: 'btn', b: BUTTON, down: bool }        D-pad / A / B / + / − presses (B down = grip)
//   { t: 'swing', a: deg, w: deg/s }           live arm angle while B is held (volatile, ~20 Hz)
//   { t: 'throw', speed, spin, quality, mode, peak, rel, id }
//        speed 0..1.1 (1 = a strong full swing), spin -1..1 (+ = curves right),
//        rel = release point in degrees from the bottom of the swing (− early, + late),
//        quality 'ok' (released at the bottom) | 'loft' (late: bouncing ball) |
//        'drop' (early: the ball goes backwards) | 'none' (no swing: cancel)
//   { t: 'cancel' }                            the grip was lost (call, app switch …)
//   { t: 'menu', action: MENU_ACTION }         lobby / results / pause actions
export const BUTTONS = ['left', 'right', 'up', 'down', 'a', 'b', 'plus', 'minus'];
export const MENU_ACTIONS = ['start', 'again', 'lobby', 'pause', 'resume', 'skip', 'quit'];
export const THROW_QUALITIES = ['ok', 'loft', 'drop', 'none'];
export const THROW_MODES = ['motion', 'touch', 'keyboard'];

export const BRAINROT_CHARACTERS = [
  {
    id: 'tung_tung',
    name: 'Tung Tung Tung Sahur',
    shortName: 'Tung Tung',
    title: 'Ramadan Slit-Drum Anomaly',
    tagline: 'Wakes you up at 3 AM or visits your house! TUNG TUNG TUNG SAHUR!',
    color: '#d99b38',
    icon: '🥁',
    isMain: true,
  },
  {
    id: 'tralalero',
    name: 'Tralalero Tralala',
    shortName: 'Tralalero',
    title: 'Nike Sneaker Shark',
    tagline: 'Land-walking apex predator rocking fresh high-top kicks.',
    color: '#2f7bf5',
    icon: '🦈',
  },
  {
    id: 'ballerina',
    name: 'Ballerina Cappuccina',
    shortName: 'Ballerina',
    title: 'Latte Art Ballerina',
    tagline: 'Pirouetting with pure steamed cappuccino & foam art.',
    color: '#ff5fb0',
    icon: '☕',
  },
  {
    id: 'bombardiro',
    name: 'Bombardiro Crocodilo',
    shortName: 'Bombardiro',
    title: 'Tactical Bomber Croc',
    tagline: 'Twin propeller aircraft wings fused with crocodile firepower.',
    color: '#2fb45a',
    icon: '🐊',
  },
  {
    id: 'skibidi',
    name: 'Skibidi Toilet',
    shortName: 'Skibidi',
    title: 'The Porcelain Menace',
    tagline: 'Skibidi dop dop dop yes yes, bowling for strikes!',
    color: '#7fc5ec',
    icon: '🚽',
  },
  {
    id: 'patapim',
    name: 'Brr Brr Patapim',
    shortName: 'Patapim',
    title: 'The Long-Nosed Anomaly',
    tagline: 'Deep woods creature with an impossibly long curved nose.',
    color: '#8a4ff0',
    icon: '🤥',
  },
  {
    id: 'smurf_cat',
    name: 'Smurf Cat',
    shortName: 'Smurf Cat',
    title: 'Mushroom Feline (Shailushai)',
    tagline: 'We live, we love, we lie. The mythical woodland creature.',
    color: '#3caade',
    icon: '🍄',
  },
  {
    id: 'gigachad',
    name: 'Sigma GigaChad',
    shortName: 'GigaChad',
    title: 'The Ultra Sigma Male',
    tagline: 'Chiseled jawline, gold chain, pure effortless rizz.',
    color: '#f5c518',
    icon: '🗿',
  },
];
export const CHARACTER_IDS = BRAINROT_CHARACTERS.map((c) => c.id);
export const DEFAULT_CHARACTER = 'tung_tung';
export function getCharacter(id) {
  return BRAINROT_CHARACTERS.find((c) => c.id === id) || BRAINROT_CHARACTERS[0];
}

export const NET = {
  httpPort: 3000,
  httpsPort: 3443,
};

