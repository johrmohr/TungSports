// Character roster + low-poly kart/driver model builder (KRISHIV KART v3).
//
// Node-safe: only uses THREE geometry/material classes (no canvas/DOM), so the
// headless simulation and the tests can import the roster from here.
//
// The cast is 12 recognizable Brainrot characters (docs/brainrot-roster.md), in grid order (3 rows of 4: Light,
// Medium, Heavy). Stats come from their weight group (parts.js WEIGHT_GROUPS);
// a racer's kart body and wheels add to them (parts.js computeRatings).
// User-supplied .glb racers (SPEC §14.9) are loaded by glb-racers.js,
// registered at runtime with registerCustomCharacters() and seated on the
// same karts (glb-racers.js seatCustomModel).
//
// A model = kart body (6 shapes) × wheels (6) × driver. Every moving part is
// ONE merged geometry, so a kart costs 4–6 draw calls: chassis (1) + driver
// torso (1) + head (1) + 4 wheels as one InstancedMesh (1) + at most two
// small animated parts for the racer's signature motion (wings, shell, tail…).
//
// Colors: every primitive carries a vertex color plus a per-vertex "surface"
// vec4 (roughness, metalness, glow, color slot), injected into a standard
// material. Slot 0 is a literal color; slots 1–3 (paint, trim, rim) are looked
// up in a small uniform array on the kart's own material, so the shared
// chassis/wheel geometry is painted in each racer's own colors without being
// rebuilt. The kart's one material is also its tint material (star rainbow).
// Cached geometry is reference counted; disposeKartModel() releases a model's
// references and idle entries are evicted LRU-style.
//
// Models face +Z with the origin at ground level, centered (see SPEC §2/§4).
// NOTE: the kart's RIGHT side is -X (right = (-cos yaw, 0, sin yaw)).

import * as THREE from 'three';
import { createBrainrotDrivers } from './brainrot-drivers.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { WEIGHT_GROUPS, CUSTOM_GROUP_FOR_CLASS, sanitizeLoadout } from './parts.js';
import { seatCustomModel } from './glb-racers.js';     // (cycle-safe: only used inside buildKartModel)

// --------------------------------------------------------------- roster data

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

// [id, name, shortName, group, color, accent, kart paint/trim/rim, tagline, catchphrase]
const ROSTER = [
  ['ballerina', 'Ballerina Cappuccina', 'Ballerina', 'L1', 0xf3a9c5, 0xfff5e4, [0xf3a9c5, 0xfff5e4, 0xe1d8bf],
    'Cappuccino-cup ballerina, pink tutu, pointe shoes.', 'Ballerina Cappuccina!'],
  ['cappuccino', 'Cappuccino Assassino', 'Cappuccino', 'L1', 0x34343c, 0xc3b18a, [0x34343c, 0xc3b18a, 0xe1d8bf],
    'Ninja coffee cup with a black headband and twin swords.', 'Cappuccino Assassino!'],
  ['trippi', 'Trippi Troppi', 'Trippi', 'L2', 0xed9560, 0xf7dec0, [0xed9560, 0xf7dec0, 0xe1d8bf],
    'The tabby-cat and orange-shrimp version of Trippi Troppi.', 'Trippi Troppi!'],
  ['chimpanzini', 'Chimpanzini Bananini', 'Chimpanzini', 'L2', 0x80a73c, 0xffdc36, [0x80a73c, 0xffdc36, 0xe1d8bf],
    'Green chimpanzee peeking out of a peeled banana.', 'Chimpanzini Bananini!'],
  ['sahur', 'Tung Tung Tung Sahur', 'Tung Sahur', 'M2', 0xb77b42, 0xe7b978, [0xb77b42, 0xe7b978, 0xe1d8bf],
    'The wooden log with a face, bare limbs, and his signature bat.', 'Tung Tung Tung Sahur!'],
  ['tralalero', 'Tralalero Tralala', 'Tralalero', 'M2', 0x7796a6, 0x1684ec, [0x7796a6, 0x1684ec, 0xe1d8bf],
    'Three-legged shark with blue sneakers and a dorsal fin.', 'Tralalero Tralala!'],
  ['bananita', 'Bananita Dolfinita', 'Bananita', 'M1', 0xf4ce32, 0x93afb7, [0xf4ce32, 0x93afb7, 0xe1d8bf],
    'A dolphin emerging from a bright yellow banana.', 'Bananita Dolfinita!'],
  ['lirili', 'Lirili Larila', 'Lirili', 'M1', 0x729b58, 0xc09a66, [0x729b58, 0xc09a66, 0xe1d8bf],
    'Cactus-elephant hybrid with a long trunk and sandals.', 'Lirili Larila!'],
  ['patapim', 'Brr Brr Patapim', 'Patapim', 'H1', 0x648644, 0x9d7a52, [0x648644, 0x9d7a52, 0xe1d8bf],
    'Forest monkey with a tree-trunk body, leafy crown, and big nose.', 'Brr Brr Patapim!'],
  ['saturnita', 'La Vaca Saturno Saturnita', 'Saturnita', 'H1', 0xcc9b64, 0xf3eee2, [0xcc9b64, 0xf3eee2, 0xe1d8bf],
    'Cow head on a ringed Saturn body.', 'La Vaca Saturno Saturnita!'],
  ['bombardiro', 'Bombardiro Crocodilo', 'Bombardiro', 'H2', 0x748267, 0xb9bd86, [0x748267, 0xb9bd86, 0xe1d8bf],
    'Crocodile head fused to a twin-propeller bomber plane.', 'Bombardiro Crocodilo!'],
  ['gusini', 'Bombombini Gusini', 'Gusini', 'H2', 0xd5dedc, 0xea9a31, [0xd5dedc, 0xea9a31, 0xe1d8bf],
    'White goose with an aircraft body, wings, and orange beak.', 'Bombombini Gusini!'],
];

/** The 12 racers in grid order (Light row, Medium row, Heavy row). */
export const CHARACTERS = ROSTER.map(([id, name, shortName, group, color, accent, kart, tagline, catchphrase]) => ({
  id, name, shortName, group,
  weightClass: WEIGHT_GROUPS[group].weightClass,
  ratings: { ...WEIGHT_GROUPS[group].ratings },
  color, accent, cssColor: hex(color), accentCss: hex(accent),
  kart: { paint: kart[0], trim: kart[1], rim: kart[2] },
  tagline, catchphrase,
  ...(id === 'sahur' ? { lead: true } : {}),
}));

export const DEFAULT_CHARACTER_ID = 'sahur';

const BY_ID = new Map(CHARACTERS.map((c) => [c.id, c]));
let customDefs = [];
const CUSTOM_BY_ID = new Map();

/** A racer by id (custom .glb racers included); unknown ids give the lead. */
export function getCharacter(id) {
  return BY_ID.get(id) || CUSTOM_BY_ID.get(id) || BY_ID.get(DEFAULT_CHARACTER_ID);
}

/** The 12 built-in racers followed by the registered custom racers. */
export function getAllCharacters() {
  return customDefs.length ? [...CHARACTERS, ...customDefs] : CHARACTERS;
}

/** The registered custom racers (never CPUs). */
export function getCustomCharacters() {
  return customDefs;
}

const ID_RE = /^[a-z0-9_-]{1,32}$/;
const CSS_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Register user-supplied racers (SPEC §14.9), replacing any earlier set.
 * Each raw entry: { id, name, weightClass, color: '#rrggbb', shortName?,
 * model? (THREE.Object3D, e.g. a loaded gltf.scene), scale?, yOffset?,
 * rotationY?, file? }. Ratings come from CUSTOM_GROUP_FOR_CLASS. Invalid
 * entries and ids that clash with the built-in cast are skipped (with a
 * console warning). Returns the registered defs.
 */
export function registerCustomCharacters(defs = []) {
  customDefs = [];
  CUSTOM_BY_ID.clear();
  for (const raw of Array.isArray(defs) ? defs : []) {
    const id = raw && String(raw.id || '').toLowerCase();
    if (!ID_RE.test(id) || BY_ID.has(id) || CUSTOM_BY_ID.has(id)) {
      console.warn('[characters] custom racer skipped (bad or duplicate id):', raw && raw.id);
      continue;
    }
    const weightClass = ['light', 'medium', 'heavy'].includes(raw.weightClass) ? raw.weightClass : 'medium';
    const group = CUSTOM_GROUP_FOR_CLASS[weightClass];
    const css = CSS_RE.test(raw.color || '') ? raw.color.toLowerCase() : '#8a8f99';
    const color = parseInt(css.slice(1), 16);
    const name = String(raw.name || id).slice(0, 32);
    const def = {
      id, name, shortName: String(raw.shortName || name).slice(0, 12), group, weightClass,
      ratings: { ...WEIGHT_GROUPS[group].ratings },
      color, accent: 0xffffff, cssColor: css, accentCss: '#ffffff',
      kart: { paint: color, trim: 0xffffff, rim: 0xd8dde3 },
      tagline: 'A custom racer.', catchphrase: '',
      custom: true,
      file: typeof raw.file === 'string' ? raw.file : null,
      model: raw.model && raw.model.isObject3D ? raw.model : null,
      scale: Number(raw.scale) > 0 ? Number(raw.scale) : 1,
      yOffset: Number.isFinite(Number(raw.yOffset)) ? Number(raw.yOffset) : 0,
      rotationY: Number.isFinite(Number(raw.rotationY)) ? Number(raw.rotationY) : 0,
    };
    customDefs.push(def);
    CUSTOM_BY_ID.set(id, def);
  }
  return customDefs;
}

// Kart colors of a racer: { paint, trim, rim } as 0xrrggbb numbers.
function kartColors(def) {
  return (def && def.kart) || { paint: (def && def.color) || 0x8a8f99, trim: 0xffffff, rim: 0xd8dde3 };
}

// ------------------------------------------------------------ layout consts

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

// Nominal layout = Classic body on Standard wheels. +X is the kart's LEFT side.
// Wheel radii are OUTER (tread tip) radii, so wheel bottoms touch y = 0.
export const WHEEL_RADIUS_REAR = 0.365;
export const FRONT_WHEEL_SCALE = 0.82;
export const WHEEL_RADIUS_FRONT = WHEEL_RADIUS_REAR * FRONT_WHEEL_SCALE;
const SEAT = [0, 0.44, -0.3];          // nominal driver origin (hips): drivers are authored around it
const NECK = [0, 0.86, -0.28];         // head pivot (kart space, before driver scale)
const REACH = [0, 0.32, 0.46];         // steering-wheel center relative to the seat (where the hands are)
const COLUMN = [0, 0.06, 0.68];        // steering-column foot relative to the seat

// Surface presets: [roughness, metalness, glow]
const S = {
  paint: [0.3, 0.06, 0],
  plastic: [0.55, 0, 0],
  rubber: [0.92, 0, 0],
  metal: [0.28, 0.5, 0],
  fur: [0.82, 0, 0],
  skin: [0.62, 0, 0],
  cloth: [0.88, 0, 0],
  gloss: [0.12, 0, 0],
  glow: [0.5, 0, 1],
  softGlow: [0.4, 0, 0.45],
};

const DARK = 0x33353f;
const SEAT_COL = 0x3b3e4a;
const CHROME = 0xc3ccd6;
const AXLE = 0x55585f;
const TAILLIGHT = 0xff2a2a;
const HEADLIGHT = 0xfff4c8;

// ------------------------------------------------------------ color slots

// Slot colors live in the kart material's `uSlot` uniform array; a part
// colored with a slot reference is drawn in that color × its multiplier `k`
// (per channel). The chassis and wheels are shared by every racer, so they
// use the slots (paint, trim, rim = the racer's kart colors); drivers are
// built per racer and use literal colors.
const SLOT = { fixed: 0, paint: 1, trim: 2, rim: 3 };
const SLOT_COUNT = 4;
const slot = (s, k = 1) => ({ slot: s, k: Array.isArray(k) ? k : [k, k, k] });
const PAINT = slot(SLOT.paint);
const TRIM = slot(SLOT.trim);
const RIM = slot(SLOT.rim);

// --------------------------------------------------------- material shader

// Inject the per-vertex surface attribute (roughness, metalness, glow, slot)
// into the standard material. Every kart shares one program (same cache key);
// the slot colors are a per-material uniform.
function patchSurfaceShader(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nattribute vec4 aSurf;\nuniform vec3 uSlot[${SLOT_COUNT}];\nvarying vec3 vSurf;`)
    .replace('#include <color_vertex>', '#include <color_vertex>\n#ifdef USE_COLOR\nvColor.rgb *= uSlot[int(aSurf.w + 0.5)];\n#endif')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = aSurf.xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vSurf;')
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(vSurf.x * (roughness / 0.5), 0.04, 1.0);')
    .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vSurf.y;')
    .replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor.rgb * vSurf.z * 1.4;\n#endif');
}

function makeKartMaterial(slotColors) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
  const uSlot = { value: slotColors };
  m.userData.slotColors = slotColors;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSlot = uSlot;
    patchSurfaceShader(shader);
  };
  m.customProgramCacheKey = () => 'krishivkart-surface-v3';
  return m;
}

// Slot color table for a racer's kart (linear working-space colors).
function kartSlotColors(def) {
  const k = kartColors(def);
  return [new THREE.Color(1, 1, 1), new THREE.Color(k.paint), new THREE.Color(k.trim), new THREE.Color(k.rim)];
}

// --------------------------------------------------------- geometry cache

// Shared, reference-counted geometry assets ({ value, refs, dispose }).
// Unreferenced entries stay cached (most recently used last) until more than
// IDLE_LIMIT of them pile up, then the oldest idle ones are freed.
const IDLE_LIMIT = 48;
const _assets = new Map();

function acquireAsset(key, build) {
  let e = _assets.get(key);
  if (e) _assets.delete(key);
  else {
    const value = build();
    e = { value, refs: 0 };
  }
  _assets.set(key, e);
  e.refs++;
  return e.value;
}

function disposeAssetValue(v) {
  if (!v) return;
  if (v.isBufferGeometry) { v.dispose(); return; }
  for (const g of Object.values(v)) {
    if (g && g.isBufferGeometry) g.dispose();
    else if (Array.isArray(g)) for (const p of g) if (p && p.geo) p.geo.dispose();
  }
}

function releaseAsset(key) {
  const e = _assets.get(key);
  if (!e) return;
  e.refs = Math.max(0, e.refs - 1);
  let idle = 0;
  for (const a of _assets.values()) if (a.refs === 0) idle++;
  if (idle <= IDLE_LIMIT) return;
  for (const [k, a] of _assets) {            // oldest first
    if (a.refs > 0) continue;
    disposeAssetValue(a.value);
    _assets.delete(k);
    if (--idle <= IDLE_LIMIT) break;
  }
}

/** Cache diagnostics (tests / dev tools): { entries, live, idle, refs }. */
export function kartModelCacheInfo() {
  let live = 0, idle = 0, refs = 0;
  for (const a of _assets.values()) { if (a.refs > 0) live++; else idle++; refs += a.refs; }
  return { entries: _assets.size, live, idle, refs, idleLimit: IDLE_LIMIT };
}

// -------------------------------------------------------- geometry builder

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _sv = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

// Euler angles that turn +Y toward the direction (x, y, z).
function aimEuler(x, y, z) {
  _dir.set(x, y, z).normalize();
  _q.setFromUnitVectors(_up, _dir);
  _e.setFromQuaternion(_q);
  return [_e.x, _e.y, _e.z];
}

// Collects transformed, colored primitives and merges them into one geometry.
class Parts {
  constructor(seg = 1) {
    this.geos = [];
    this.seg = seg;                       // LOD multiplier for segment counts
    this.stack = [new THREE.Matrix4()];   // parent transform stack
  }

  n(base, min = 3) { return Math.max(min, Math.round(base * this.seg)); }

  // Push a parent transform (pos, rot euler, uniform/vec scale).
  push(pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
    const sc = Array.isArray(scale) ? scale : [scale, scale, scale];
    _m.compose(_pv.fromArray(pos), _q.setFromEuler(_e.set(rot[0], rot[1], rot[2])), _sv.fromArray(sc));
    const top = this.stack[this.stack.length - 1];
    this.stack.push(new THREE.Matrix4().multiplyMatrices(top, _m));
    return this;
  }

  pop() { if (this.stack.length > 1) this.stack.pop(); return this; }

  // Add a primitive geometry with a color (hex literal or slot ref) + surface preset.
  add(geo, color, surf = S.plastic, pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    const sc = Array.isArray(scale) ? scale : [scale, scale, scale];
    _m.compose(_pv.fromArray(pos), _q.setFromEuler(_e.set(rot[0], rot[1], rot[2])), _sv.fromArray(sc));
    _m2.multiplyMatrices(this.stack[this.stack.length - 1], _m);
    g.applyMatrix4(_m2);
    const count = g.attributes.position.count;
    const col = new Float32Array(count * 3);
    const srf = new Float32Array(count * 4);
    let sl = 0;
    if (typeof color === 'number') _c.set(color);
    else { sl = color.slot; _c.setRGB(color.k[0], color.k[1], color.k[2]); }
    for (let i = 0; i < count; i++) {
      col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
      srf[i * 4] = surf[0]; srf[i * 4 + 1] = surf[1]; srf[i * 4 + 2] = surf[2]; srf[i * 4 + 3] = sl;
    }
    if (g.attributes.uv) g.deleteAttribute('uv');
    if (g.attributes.uv1) g.deleteAttribute('uv1');
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSurf', new THREE.BufferAttribute(srf, 4));
    this.geos.push(g);
    return this;
  }

  // Mirror helper: adds the part at +x and -x (rotation y/z mirrored).
  sym(geoFn, color, surf, pos, rot = [0, 0, 0], scale = 1) {
    this.add(geoFn(), color, surf, pos, rot, scale);
    this.add(geoFn(), color, surf, [-pos[0], pos[1], pos[2]], [rot[0], -rot[1], -rot[2]], scale);
    return this;
  }

  // Capsule/limb between two points.
  limb(a, b, radius, color, surf = S.cloth) {
    _dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = _dir.length();
    const rot = aimEuler(_dir.x, _dir.y, _dir.z);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    this.add(new THREE.CapsuleGeometry(radius, Math.max(0.001, len), this.n(3, 2), this.n(8, 5)), color, surf, mid, rot);
    return this;
  }

  // Straight tube (open-ended look, capped cylinder) between two points.
  tube(a, b, radius, color, surf = S.metal, seg = 8) {
    _dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = _dir.length();
    const rot = aimEuler(_dir.x, _dir.y, _dir.z);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    this.add(new THREE.CylinderGeometry(radius, radius, Math.max(0.001, len), this.n(seg, 5), 1), color, surf, mid, rot);
    return this;
  }

  // Tube through a list of points with rounded joints.
  path(points, radius, color, surf = S.metal) {
    for (let i = 0; i < points.length - 1; i++) this.tube(points[i], points[i + 1], radius, color, surf);
    for (let i = 1; i < points.length - 1; i++) this.add(new THREE.SphereGeometry(radius, this.n(8, 5), this.n(6, 3)), color, surf, points[i]);
    return this;
  }

  merge() {
    if (!this.geos.length) return null;
    const g = mergeGeometries(this.geos, false);
    for (const p of this.geos) p.dispose();
    this.geos = [];
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Primitive factories (fresh geometry each call; Parts.add consumes them).
const sphere = (P, r, w = 14, h = 10) => new THREE.SphereGeometry(r, P.n(w, 6), P.n(h, 4));
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const rbox = (P, w, h, d, r = 0.06, segs = 1) => new RoundedBoxGeometry(w, h, d, P.seg < 0.8 ? 1 : segs, r);
const cyl = (P, rt, rb, h, seg = 14, open = false, t0 = 0, tl = TAU) =>
  new THREE.CylinderGeometry(rt, rb, h, P.n(seg, 5), 1, open, t0, tl);
const cone = (P, r, h, seg = 10) => new THREE.ConeGeometry(r, h, P.n(seg, 4));
const torus = (P, R, t, rs = 6, ts = 16, arc = TAU) => new THREE.TorusGeometry(R, t, P.n(rs, 3), P.n(ts, 6), arc);
// Partial sphere cap (polar angle 0..theta from +Y).
const dome = (P, r, theta, w = 20, h = 10) => new THREE.SphereGeometry(r, P.n(w, 8), P.n(h, 4), 0, TAU, 0, theta);
const AX = [0, 0, HALF_PI];      // rotation that lays a Y-axis cylinder along X (wheels, axles)
const ORIGIN = [0, 0, 0];

// Cartoon eye facing +Z (head space): sclera, iris, pupil, two glints.
function eye(P, x, y, z, r, { iris = 0x3a2a1e, pupil = 0x0d0d12, sclera = 0xffffff, yaw = 0, pitch = 0, squash = 1.15, irisScale = 0.62 } = {}) {
  P.push([x, y, z], [pitch, yaw, 0]);
  P.add(sphere(P, r, 12, 8), sclera, S.gloss, [0, 0, 0], [0, 0, 0], [1, squash, 0.6]);
  P.add(sphere(P, r * irisScale, 10, 6), iris, S.gloss, [0, -r * 0.05, r * 0.36], [0, 0, 0], [1, 1.08, 0.5]);
  P.add(sphere(P, r * irisScale * 0.55, 8, 5), pupil, S.gloss, [0, -r * 0.05, r * 0.5], [0, 0, 0], [1, 1.1, 0.4]);
  P.add(sphere(P, r * 0.17, 5, 3), 0xffffff, S.softGlow, [-r * 0.22, r * 0.24, r * 0.58]);
  P.add(sphere(P, r * 0.08, 4, 3), 0xffffff, S.softGlow, [r * 0.2, -r * 0.22, r * 0.56]);
  P.pop();
}

// =============================================================== wheels
//
// Each style: rear OUTER radius r (tread tips), overall width w (tread +
// sidewall bulge + hub), front wheels are scaled instances (fs). Geometry
// axis = X, centered. The rim uses the RIM slot, spokes the kart PAINT.

function wheelStandard(P, outer) {
  const r = outer - 0.025;       // tire core; tread blocks stick out to the outer radius
  P.add(cyl(P, r, r, 0.26, 18), 0x24242b, S.rubber, ORIGIN, AX);
  P.add(cyl(P, r * 0.9, r * 0.9, 0.34, 18), 0x2c2c34, S.rubber, ORIGIN, AX);
  // tread blocks so spinning reads
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * TAU;
    P.add(box(0.27, 0.05, 0.07), 0x1c1c22, S.rubber, [0, Math.cos(a) * r, Math.sin(a) * r], [a, 0, 0]);
  }
  P.add(cyl(P, r * 0.55, r * 0.55, 0.355, 16), RIM, S.paint, ORIGIN, AX);
  for (let k = 0; k < 3; k++) P.add(box(0.365, 0.05, r), PAINT, S.paint, ORIGIN, [(k * Math.PI) / 3, 0, 0]);
  P.add(cyl(P, r * 0.18, r * 0.18, 0.375, 10), CHROME, S.metal, ORIGIN, AX);
}

// Racing slicks: wide, smooth, a colored sidewall ring and a 5-spoke star rim.
function wheelSlick(P, r) {
  P.add(cyl(P, r, r, 0.34, 20), 0x232329, S.rubber, ORIGIN, AX);
  P.add(cyl(P, r * 0.92, r * 0.92, 0.4, 20), 0x2b2b33, S.rubber, ORIGIN, AX);
  for (const sx of [1, -1]) P.add(torus(P, r * 0.78, 0.016, 4, 22), RIM, S.paint, [sx * 0.2, 0, 0], [0, HALF_PI, 0]);
  P.add(cyl(P, r * 0.62, r * 0.62, 0.405, 18), 0x3a3d46, S.metal, ORIGIN, AX);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU, d = r * 0.3;
    P.add(box(0.415, r * 0.13, r * 0.56), RIM, S.paint, [0, -Math.sin(a) * d, Math.cos(a) * d], [a, 0, 0]);
  }
  P.add(cyl(P, r * 0.2, r * 0.2, 0.42, 12), PAINT, S.paint, ORIGIN, AX);
  P.add(cyl(P, r * 0.09, r * 0.09, 0.43, 8), CHROME, S.metal, ORIGIN, AX);
}

// Mud grippers: knobby staggered chevron tread, steel rim with holes + beadlock ring.
function wheelMud(P, r) {
  const core = r - 0.055;
  P.add(cyl(P, core, core, 0.3, 16), 0x26262c, S.rubber, ORIGIN, AX);
  P.add(cyl(P, core * 0.92, core * 0.92, 0.36, 16), 0x2e2e36, S.rubber, ORIGIN, AX);
  const n = 11;
  for (let k = 0; k < n; k++) {
    for (const sx of [1, -1]) {
      const a = ((k + (sx > 0 ? 0 : 0.5)) / n) * TAU;
      const rr = r - 0.043;
      P.add(box(0.16, 0.075, 0.11), 0x1b1b20, S.rubber, [sx * 0.085, Math.cos(a) * rr, Math.sin(a) * rr], [a, sx * 0.35, 0]);
    }
  }
  P.add(cyl(P, r * 0.52, r * 0.52, 0.365, 16), RIM, S.paint, ORIGIN, AX);
  for (const sx of [1, -1]) {
    P.add(torus(P, r * 0.52, 0.018, 4, 18), CHROME, S.metal, [sx * 0.183, 0, 0], [0, HALF_PI, 0]);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU + 0.3;
      P.add(cyl(P, 0.026, 0.026, 0.01, 6), 0x1a1a1f, S.rubber, [sx * 0.184, Math.cos(a) * r * 0.33, Math.sin(a) * r * 0.33], AX);
    }
  }
  P.add(cyl(P, r * 0.15, r * 0.15, 0.39, 10), CHROME, S.metal, ORIGIN, AX);
}

// Mini rollers: small and zippy, big glossy rim + painted hubcap.
function wheelTiny(P, outer) {
  const r = outer - 0.02;
  P.add(cyl(P, r, r, 0.2, 16), 0x24242b, S.rubber, ORIGIN, AX);
  P.add(cyl(P, r * 0.88, r * 0.88, 0.24, 16), 0x2c2c34, S.rubber, ORIGIN, AX);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    P.add(box(0.21, 0.04, 0.05), 0x1c1c22, S.rubber, [0, Math.cos(a) * r, Math.sin(a) * r], [a, 0, 0]);
  }
  P.add(cyl(P, r * 0.66, r * 0.66, 0.245, 16), RIM, S.gloss, ORIGIN, AX);
  P.add(cyl(P, r * 0.36, r * 0.36, 0.255, 12), PAINT, S.paint, ORIGIN, AX);
  P.add(cyl(P, r * 0.12, r * 0.12, 0.265, 8), CHROME, S.metal, ORIGIN, AX);
}

// Monster wheels: huge, paddle tread, deep-dish rim with a bolt circle.
function wheelMonster(P, r) {
  const core = r - 0.07;
  P.add(cyl(P, core, core, 0.36, 18), 0x232328, S.rubber, ORIGIN, AX);
  P.add(cyl(P, core * 0.93, core * 0.93, 0.44, 18), 0x2c2c34, S.rubber, ORIGIN, AX);
  const n = 13;
  for (let k = 0; k < n; k++) {
    for (const sx of [1, -1]) {
      const a = ((k + (sx > 0 ? 0 : 0.5)) / n) * TAU;
      const rr = r - 0.048;
      P.add(box(0.2, 0.085, 0.14), 0x1b1b20, S.rubber, [sx * 0.1, Math.cos(a) * rr, Math.sin(a) * rr], [a, sx * 0.45, 0]);
    }
  }
  P.add(cyl(P, r * 0.5, r * 0.5, 0.445, 18), RIM, S.paint, ORIGIN, AX);
  for (const sx of [1, -1]) {
    P.add(torus(P, r * 0.5, 0.022, 4, 16), CHROME, S.metal, [sx * 0.222, 0, 0], [0, HALF_PI, 0]);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      P.add(cyl(P, 0.022, 0.022, 0.02, 5), CHROME, S.metal, [sx * 0.226, Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3], AX);
    }
  }
  P.add(cyl(P, r * 0.18, r * 0.18, 0.46, 12), PAINT, S.paint, ORIGIN, AX);
  P.add(cyl(P, r * 0.08, r * 0.08, 0.47, 8), CHROME, S.metal, ORIGIN, AX);
}

// Neon rings: sleek dark tire, glowing rim rings + spokes in the rim color.
function wheelNeon(P, r) {
  P.add(cyl(P, r, r, 0.24, 18), 0x1c1c22, S.rubber, ORIGIN, AX);
  P.add(cyl(P, r * 0.9, r * 0.9, 0.3, 18), 0x24242b, S.rubber, ORIGIN, AX);
  P.add(cyl(P, r * 0.66, r * 0.66, 0.305, 18), 0x15161c, S.gloss, ORIGIN, AX);
  for (const sx of [1, -1]) {
    P.add(torus(P, r * 0.6, 0.026, 5, 20), RIM, S.glow, [sx * 0.153, 0, 0], [0, HALF_PI, 0]);
    P.add(torus(P, r * 0.92, 0.008, 3, 20), RIM, S.glow, [sx * 0.151, 0, 0], [0, HALF_PI, 0]);
  }
  for (let k = 0; k < 3; k++) P.add(box(0.312, 0.03, r * 1.1), RIM, S.softGlow, ORIGIN, [(k * Math.PI) / 3, 0, 0]);
  P.add(cyl(P, r * 0.16, r * 0.16, 0.32, 10), CHROME, S.metal, ORIGIN, AX);
}

const WHEEL_STYLES = {
  standard: { r: WHEEL_RADIUS_REAR, w: 0.36, fs: FRONT_WHEEL_SCALE, build: wheelStandard },
  slick: { r: 0.36, w: 0.42, fs: 0.8, build: wheelSlick },
  offroad: { r: 0.39, w: 0.38, fs: 0.86, build: wheelMud },
  tiny: { r: 0.26, w: 0.26, fs: 0.9, build: wheelTiny },
  monster: { r: 0.55, w: 0.46, fs: 0.94, build: wheelMonster },
  neon: { r: 0.355, w: 0.31, fs: FRONT_WHEEL_SCALE, build: wheelNeon },
};

// Wheel placement + ride height for a body/wheel combination. Bigger and
// wider tires sit further out; the chassis rides higher on big wheels and
// lower on small ones (the wheel bottoms always touch y = 0).
function wheelLayout(bodyDef, style) {
  const r = style.r;
  const out = (style.w - 0.36) / 2 + Math.max(0, r - 0.43);
  const axle = (b, rad, w) => {
    const x = b.x + out * (w / style.w);
    return { x, z: b.z, r: rad, w, inner: x - w / 2, outer: x + w / 2 };
  };
  return {
    lift: r >= WHEEL_RADIUS_REAR ? r - WHEEL_RADIUS_REAR : (r - WHEEL_RADIUS_REAR) * 0.8,
    rear: axle(bodyDef.rear, r, style.w),
    front: axle(bodyDef.front, r * style.fs, style.w * style.fs),
    big: r > 0.45,
  };
}

// Largest half-width a part at (z ± depth/2) may have without cutting into a
// wheel of that axle (unchanged if the wheel doesn't reach that far).
function clearHalf(w, z, depth, half, margin = 0.03) {
  return Math.abs(z - w.z) + 0.02 < w.r + depth / 2 ? Math.min(half, w.inner - margin) : half;
}

// =============================================================== bodies
//
// Builders work in chassis space; parts that hang on the wheels (axles,
// fenders, shocks) use the actual wheel layout, everything else is lifted
// by the ride height. Each body also declares its seat, axle positions and
// exhaust tips (nominal, before lift).

// Shared cockpit bits ------------------------------------------------------

function seatShell(P, s, color = SEAT_COL, back = 0.5) {
  P.add(rbox(P, 0.5, 0.08, 0.42, 0.04), color, S.cloth, [s[0], s[1], s[2]]);
  P.add(rbox(P, 0.52, back, 0.1, 0.05), color, S.cloth, [s[0], s[1] + back / 2 + 0.01, s[2] - 0.23], [-0.22, 0, 0]);
}

function steering(P, s, color = TRIM) {
  const c = [s[0] + REACH[0], s[1] + REACH[1], s[2] + REACH[2]];
  P.limb([s[0] + COLUMN[0], s[1] + COLUMN[1], s[2] + COLUMN[2]], c, 0.025, DARK, S.plastic);
  P.push(c, [0.69, 0, 0]);
  P.add(torus(P, 0.14, 0.028, 6, 18), DARK, S.rubber);
  P.add(box(0.26, 0.03, 0.02), DARK, S.plastic);
  P.add(cyl(P, 0.045, 0.045, 0.04, 10), color, S.paint, [0, 0, 0.01], [HALF_PI, 0, 0]);
  P.pop();
}

function axles(P, ctx, front = true) {
  const f = ctx.front, r = ctx.rear;
  P.add(cyl(P, 0.045, 0.045, 2 * r.x - 0.1, 8), AXLE, S.metal, [0, r.r, r.z], AX);
  if (front) P.add(cyl(P, 0.04, 0.04, 2 * f.x - 0.1, 8), AXLE, S.metal, [0, f.r, f.z], AX);
  // raised rides get visible coil-over shocks from the chassis to the hubs
  if (ctx.lift > 0.06) {
    for (const w of [f, r]) {
      for (const sx of [1, -1]) {
        const top = [sx * Math.min(0.42, w.inner - 0.1), 0.56 + ctx.lift, w.z + (w === f ? -0.06 : 0.06)];
        const bot = [sx * (w.inner + 0.03), w.r, w.z];
        P.tube(top, bot, 0.05, TRIM, S.paint, 10);
        P.tube(top, bot, 0.022, CHROME, S.metal, 6);
      }
    }
  }
}

// Classic: the original (v1) chassis -----------------------------------------

function bodyClassic(P, ctx) {
  const L = ctx.lift, f = ctx.front, r = ctx.rear;
  axles(P, ctx);
  // rear fenders hug the rear wheels
  P.sym(() => torus(P, r.r + 0.06, 0.07, 6, 14, Math.PI * 0.86), PAINT, S.paint, [r.x, r.r, r.z],
    [0, HALF_PI, 0.22], [1, 1, (r.w + 0.02) / 0.14]);
  P.push([0, L, 0]);
  // floor pan
  P.add(rbox(P, 0.84, 0.12, 1.9, 0.05), DARK, S.plastic, [0, 0.18, -0.02]);
  // main tub
  P.add(rbox(P, 0.86, 0.32, 1.16, 0.12, 2), PAINT, S.paint, [0, 0.38, -0.12]);
  // cockpit rim (dark lip around the driver)
  P.add(torus(P, 0.3, 0.045, 5, 18), DARK, S.plastic, [0, 0.545, -0.22], [HALF_PI, 0, 0], [1.15, 1.25, 1]);
  // nose + hood stripe + emblem + headlights
  P.push([0, 0.35, 0.64], [0.1, 0, 0]);
  P.add(rbox(P, 0.74, 0.25, 0.68, 0.11, 2), PAINT, S.paint);
  P.add(box(0.18, 0.03, 0.6), TRIM, S.paint, [0, 0.125, -0.02]);
  P.add(cyl(P, 0.1, 0.1, 0.02, 16), 0xffffff, S.paint, [0, 0.02, 0.341], [HALF_PI, 0, 0]);
  P.add(cyl(P, 0.06, 0.06, 0.025, 12), TRIM, S.paint, [0, 0.02, 0.345], [HALF_PI, 0, 0]);
  P.add(cyl(P, 0.05, 0.05, 0.03, 10), HEADLIGHT, S.glow, [0.23, 0.03, 0.335], [HALF_PI, 0, 0]);
  P.add(cyl(P, 0.05, 0.05, 0.03, 10), HEADLIGHT, S.glow, [-0.23, 0.03, 0.335], [HALF_PI, 0, 0]);
  P.pop();
  // dashboard
  P.add(rbox(P, 0.6, 0.12, 0.2, 0.05), DARK, S.plastic, [0, 0.55, 0.3], [-0.3, 0, 0]);
  // front bumper (narrowed when big front wheels reach it)
  const fb = clearHalf(f, 1.04, 0.18, 0.58);
  P.add(rbox(P, fb * 2, 0.15, 0.18, 0.07), DARK, S.plastic, [0, 0.23, 1.04]);
  P.sym(() => box(0.12, 0.17, 0.2), TRIM, S.paint, [fb - 0.04, 0.24, 1.04]);
  // side pods
  const podOut = Math.min(clearHalf(f, 0.05, 0.56, 0.63), clearHalf(r, 0.05, 0.56, 0.63));
  P.sym(() => rbox(P, 0.26, 0.24, 0.56, 0.09), TRIM, S.paint, [podOut - 0.13, 0.33, 0.05]);
  P.sym(() => box(0.16, 0.05, 0.4), PAINT, S.paint, [podOut - 0.05, 0.39, 0.05]);
  // seat
  seatShell(P, SEAT);
  // engine block, cylinder heads
  P.add(rbox(P, 0.6, 0.28, 0.36, 0.06), DARK, S.plastic, [0, 0.44, -0.8]);
  P.sym(() => box(0.18, 0.1, 0.28), CHROME, S.metal, [0.13, 0.62, -0.8]);
  // rear cowl in body color (what the chase camera sees most): taillights,
  // a white plate with the emblem, diffuser
  P.add(rbox(P, 0.82, 0.24, 0.12, 0.05, 2), PAINT, S.paint, [0, 0.42, -1.0]);
  P.sym(() => rbox(P, 0.12, 0.07, 0.03, 0.015), TAILLIGHT, S.glow, [0.31, 0.47, -1.065]);
  P.add(rbox(P, 0.2, 0.09, 0.02, 0.02), 0xffffff, S.paint, [0, 0.37, -1.064]);
  P.add(cyl(P, 0.03, 0.03, 0.02, 10), TRIM, S.paint, [0, 0.37, -1.075], [HALF_PI, 0, 0]);
  P.add(box(0.7, 0.06, 0.1), DARK, S.plastic, [0, 0.28, -1.0]);
  // exhaust pipes (angled up and back) with dark mouths
  for (const sx of [1, -1]) {
    P.push([0.2 * sx, 0.52, -1.02], [-HALF_PI + 0.35, 0, 0]);
    P.add(cyl(P, 0.07, 0.08, 0.38, 12), CHROME, S.metal);
    P.add(torus(P, 0.07, 0.022, 5, 12), CHROME, S.metal, [0, 0.19, 0], [HALF_PI, 0, 0]);
    P.add(cyl(P, 0.052, 0.052, 0.02, 10), 0x111114, S.rubber, [0, 0.192, 0]);
    P.pop();
  }
  // rear bumper (trim) + side taillights
  const rb = clearHalf(r, -1.06, 0.13, 0.67);
  P.add(rbox(P, rb * 2, 0.13, 0.13, 0.06), TRIM, S.paint, [0, 0.25, -1.06]);
  P.sym(() => box(0.12, 0.06, 0.03), TAILLIGHT, S.glow, [0.34, 0.46, -0.71]);
  // spoiler
  P.sym(() => box(0.05, 0.36, 0.08), DARK, S.plastic, [0.28, 0.72, -0.97], [-0.15, 0, 0]);
  P.add(rbox(P, 1.22, 0.06, 0.32, 0.03), PAINT, S.paint, [0, 0.91, -1.02], [0.1, 0, 0]);
  P.add(box(1.0, 0.02, 0.1), TRIM, S.paint, [0, 0.945, -0.96], [0.1, 0, 0]);
  P.sym(() => box(0.04, 0.2, 0.36), TRIM, S.paint, [0.62, 0.9, -1.02]);
  steering(P, SEAT);
  P.pop();
}

// Speedster: low wedge nose, front wing, long sidepods, big rear wing --------

function bodySpeedster(P, ctx) {
  const L = ctx.lift, f = ctx.front, r = ctx.rear, s = BODIES.speedster.seat;
  axles(P, ctx);
  P.push([0, L, 0]);
  P.add(rbox(P, 0.78, 0.1, 2.0, 0.04), DARK, S.plastic, [0, 0.16, -0.06]);
  // long low wedge nose sloping down to the front wing
  P.push([0, 0.3, 0.6], [0.16, 0, 0]);
  P.add(rbox(P, 0.6, 0.17, 1.12, 0.075, 2), PAINT, S.paint);
  P.add(box(0.16, 0.02, 0.98), TRIM, S.paint, [0, 0.086, -0.02]);
  P.sym(() => rbox(P, 0.15, 0.04, 0.03, 0.012), HEADLIGHT, S.glow, [0.17, 0.0, 0.56]);
  P.pop();
  // front wing ahead of the front wheels, with end plates
  const fw = clearHalf(f, 1.2, 0.26, 0.62, 0.02);
  P.add(rbox(P, fw * 2, 0.04, 0.26, 0.016), TRIM, S.paint, [0, 0.15, 1.2]);
  P.add(rbox(P, fw * 2 - 0.1, 0.03, 0.12, 0.012), PAINT, S.paint, [0, 0.2, 1.16], [-0.25, 0, 0]);
  P.sym(() => rbox(P, 0.03, 0.14, 0.3, 0.012), PAINT, S.paint, [fw - 0.015, 0.2, 1.2]);
  // cockpit tub
  P.add(rbox(P, 0.76, 0.26, 1.0, 0.1, 2), PAINT, S.paint, [0, 0.33, -0.22]);
  P.add(torus(P, 0.29, 0.04, 5, 18), DARK, S.plastic, [0, 0.47, -0.26], [HALF_PI, 0, 0], [1.1, 1.25, 1]);
  // sidepods with dark intakes and a trim stripe
  const podOut = Math.min(clearHalf(f, 0.08, 0.62, 0.58), clearHalf(r, 0.08, 0.62, 0.58));
  const pod = podOut - 0.13;
  P.sym(() => rbox(P, 0.26, 0.2, 0.62, 0.08), PAINT, S.paint, [pod, 0.29, 0.08]);
  P.sym(() => rbox(P, 0.2, 0.12, 0.04, 0.03), 0x15161c, S.plastic, [pod, 0.3, 0.39]);
  P.sym(() => box(0.02, 0.05, 0.5), TRIM, S.paint, [podOut, 0.3, 0.06]);
  // dash + small tinted wind deflector
  P.add(rbox(P, 0.54, 0.1, 0.2, 0.04), DARK, S.plastic, [0, 0.47, 0.22], [-0.3, 0, 0]);
  P.add(rbox(P, 0.44, 0.13, 0.02, 0.02), 0x9fd8ff, S.gloss, [0, 0.56, 0.33], [-0.55, 0, 0]);
  seatShell(P, s, SEAT_COL, 0.46);
  // engine cover hump + shark fin
  P.add(rbox(P, 0.5, 0.24, 0.62, 0.1, 2), PAINT, S.paint, [0, 0.42, -0.86], [-0.1, 0, 0]);
  P.add(rbox(P, 0.035, 0.22, 0.46, 0.015), TRIM, S.paint, [0, 0.6, -0.92], [-0.18, 0, 0]);
  // rear: diffuser, taillights, twin center exhausts
  P.add(box(0.72, 0.07, 0.18), DARK, S.plastic, [0, 0.2, -1.1]);
  P.add(rbox(P, 0.56, 0.18, 0.1, 0.04), PAINT, S.paint, [0, 0.36, -1.18]);
  P.sym(() => rbox(P, 0.1, 0.05, 0.03, 0.015), TAILLIGHT, S.glow, [0.19, 0.41, -1.235]);
  for (const sx of [1, -1]) {
    P.add(cyl(P, 0.05, 0.055, 0.2, 10), CHROME, S.metal, [0.08 * sx, 0.28, -1.24], [HALF_PI, 0, 0]);
    P.add(cyl(P, 0.036, 0.036, 0.02, 8), 0x111114, S.rubber, [0.08 * sx, 0.28, -1.345], [HALF_PI, 0, 0]);
  }
  // big rear wing on two swept struts (low and far back so the chase camera still sees the driver)
  P.sym(() => box(0.045, 0.46, 0.1), DARK, S.plastic, [0.22, 0.6, -1.17], [-0.32, 0, 0]);
  P.add(rbox(P, 1.48, 0.07, 0.42, 0.03), PAINT, S.paint, [0, 0.84, -1.3], [0.14, 0, 0]);
  P.add(rbox(P, 1.48, 0.05, 0.17, 0.02), TRIM, S.paint, [0, 0.925, -1.42], [0.34, 0, 0]);
  P.sym(() => rbox(P, 0.05, 0.32, 0.56, 0.02), TRIM, S.paint, [0.76, 0.85, -1.32]);
  steering(P, s);
  P.pop();
}

// Bubble Buggy: round bubbly tub, roll bar, big round headlights, spare tire -

function bodyBuggy(P, ctx) {
  const L = ctx.lift, f = ctx.front, r = ctx.rear, s = BODIES.buggy.seat;
  axles(P, ctx);
  P.push([0, L, 0]);
  P.add(rbox(P, 0.7, 0.1, 1.5, 0.04), DARK, S.plastic, [0, 0.18, -0.08]);
  // the bubble tub + a trim belt line around its waist
  P.add(sphere(P, 0.5, 24, 18), PAINT, S.paint, [0, 0.44, -0.08], ORIGIN, [0.88, 0.62, 1.5]);
  P.add(torus(P, 0.5, 0.03, 5, 30), TRIM, S.paint, [0, 0.43, -0.08], [HALF_PI, 0, 0], [0.89, 1.515, 1]);
  // cockpit opening ring
  P.add(torus(P, 0.27, 0.05, 6, 20), DARK, S.plastic, [0, 0.725, -0.3], [HALF_PI, 0, 0], [1.12, 1.3, 1]);
  // big round headlights ("eyes") with chrome bezels + a grin grille
  for (const sx of [1, -1]) {
    P.push([0.19 * sx, 0.55, 0.535], [HALF_PI - 0.42, 0.34 * sx, 0]);
    P.add(cyl(P, 0.1, 0.1, 0.06, 16), CHROME, S.metal);
    P.add(cyl(P, 0.078, 0.078, 0.065, 16), HEADLIGHT, S.glow);
    P.pop();
  }
  P.add(torus(P, 0.13, 0.024, 4, 14, Math.PI), 0x15161c, S.plastic, [0, 0.4, 0.645], [-0.25, 0, Math.PI], [1, 0.6, 1]);
  // dash + steering
  P.add(rbox(P, 0.46, 0.1, 0.18, 0.05), DARK, S.plastic, [0, 0.76, 0.2], [-0.35, 0, 0]);
  seatShell(P, s, SEAT_COL, 0.42);
  steering(P, s);
  // tube bumpers front and back
  const fb = Math.min(0.32, f.inner - 0.06);
  P.path([[fb, 0.3, 0.6], [fb, 0.26, 0.74], [-fb, 0.26, 0.74], [-fb, 0.3, 0.6]], 0.035, CHROME, S.metal);
  const rb = clearHalf(r, -0.95, 0.07, 0.34, 0.05);
  P.path([[rb - 0.02, 0.27, -0.74], [rb, 0.22, -0.95], [-rb, 0.22, -0.95], [0.02 - rb, 0.27, -0.74]], 0.035, CHROME, S.metal);
  // roll bar behind the seat (feet planted in the tub)
  P.add(torus(P, 0.27, 0.04, 6, 18, Math.PI), CHROME, S.metal, [0, 0.55, -0.6], [-0.1, 0, 0], [1, 2.4, 1]);
  // spare tire on the back
  P.add(torus(P, 0.15, 0.07, 8, 16), 0x24242b, S.rubber, [0, 0.52, -0.88]);
  P.add(cyl(P, 0.09, 0.09, 0.06, 12), RIM, S.paint, [0, 0.52, -0.88], [HALF_PI, 0, 0]);
  // round taillights + twin upswept pipes
  P.sym(() => cyl(P, 0.045, 0.045, 0.03, 10), TAILLIGHT, S.glow, [0.27, 0.46, -0.72], [HALF_PI + 0.6, 0.45, 0]);
  for (const sx of [1, -1]) {
    P.path([[0.24 * sx, 0.3, -0.7], [0.27 * sx, 0.3, -0.86], [0.29 * sx, 0.38, -0.96]], 0.045, CHROME, S.metal);
    P.add(cyl(P, 0.034, 0.034, 0.02, 8), 0x111114, S.rubber, [0.29 * sx, 0.39, -0.975], [HALF_PI - 0.7, 0, 0]);
  }
  P.pop();
}

// Thunder Truck: boxy and tall, chunky bumpers, grille, stacks, light bar ---

function bodyTruck(P, ctx) {
  const L = ctx.lift, f = ctx.front, r = ctx.rear, s = BODIES.tank.seat;
  axles(P, ctx);
  // square wheel arches over normal-size tires (monster tires stay open)
  if (!ctx.big) {
    for (const w of [f, r]) {
      P.sym(() => rbox(P, w.w + 0.08, 0.06, w.r * 1.9, 0.025), TRIM, S.paint, [w.x, w.r * 2 + 0.07, w.z]);
      P.sym(() => box(0.06, 0.14, w.r * 1.5), TRIM, S.paint, [w.inner - 0.03, w.r * 2 + 0.0, w.z]);
    }
  }
  P.push([0, L, 0]);
  P.add(rbox(P, 0.92, 0.12, 1.94, 0.05), DARK, S.plastic, [0, 0.2, -0.04]);
  // slab-sided hull + flat hood
  P.add(rbox(P, 0.9, 0.4, 1.3, 0.05), PAINT, S.paint, [0, 0.46, -0.24]);
  P.add(rbox(P, 0.88, 0.36, 0.62, 0.05), PAINT, S.paint, [0, 0.47, 0.64]);
  P.add(rbox(P, 0.3, 0.08, 0.32, 0.03), TRIM, S.paint, [0, 0.68, 0.6]);
  P.add(box(0.22, 0.04, 0.06), 0x15161c, S.plastic, [0, 0.69, 0.77]);
  // big grille + headlights
  P.add(rbox(P, 0.72, 0.26, 0.05, 0.02), 0x1d1f26, S.plastic, [0, 0.45, 0.955]);
  for (let k = 0; k < 4; k++) P.add(box(0.66, 0.022, 0.02), CHROME, S.metal, [0, 0.36 + k * 0.06, 0.98]);
  P.sym(() => rbox(P, 0.13, 0.1, 0.04, 0.02), HEADLIGHT, S.glow, [0.33, 0.56, 0.96]);
  // chunky bumpers (narrowed when the tires reach them) + bull bar + tow hitch
  const fb = clearHalf(f, 1.08, 0.24, 0.62);
  P.add(rbox(P, fb * 2, 0.2, 0.24, 0.06), DARK, S.plastic, [0, 0.27, 1.08]);
  P.sym(() => rbox(P, 0.14, 0.21, 0.25, 0.05), TRIM, S.paint, [fb - 0.07, 0.27, 1.08]);
  P.path([[0.24, 0.36, 1.12], [0.24, 0.66, 1.06], [-0.24, 0.66, 1.06], [-0.24, 0.36, 1.12]], 0.03, CHROME, S.metal);
  const rb = clearHalf(r, -1.06, 0.24, 0.64);
  P.add(rbox(P, rb * 2, 0.2, 0.24, 0.06), DARK, S.plastic, [0, 0.27, -1.06]);
  P.sym(() => rbox(P, 0.14, 0.21, 0.25, 0.05), TRIM, S.paint, [rb - 0.07, 0.27, -1.06]);
  P.add(sphere(P, 0.05, 10, 8), CHROME, S.metal, [0, 0.25, -1.22]);
  // tailgate + taillights
  P.add(rbox(P, 0.8, 0.22, 0.06, 0.03), PAINT, S.paint, [0, 0.5, -0.92]);
  P.add(box(0.5, 0.05, 0.02), TRIM, S.paint, [0, 0.52, -0.955]);
  P.sym(() => rbox(P, 0.08, 0.14, 0.03, 0.015), TAILLIGHT, S.glow, [0.37, 0.48, -0.955]);
  // lightning-bolt decals on the doors + side steps
  for (const sx of [1, -1]) {
    const x = 0.452 * sx;
    P.add(box(0.012, 0.05, 0.3), TRIM, S.paint, [x, 0.56, -0.1], [0.45, 0, 0]);
    P.add(box(0.012, 0.05, 0.2), TRIM, S.paint, [x, 0.48, -0.2], [-0.2, 0, 0]);
    P.add(box(0.012, 0.05, 0.3), TRIM, S.paint, [x, 0.4, -0.3], [0.45, 0, 0]);
    P.add(rbox(P, 0.12, 0.04, 0.3, 0.015), DARK, S.plastic, [0.47 * sx, 0.24, -0.08]);
  }
  // open cockpit rim, dash, seat, steering
  P.add(torus(P, 0.3, 0.045, 5, 18), DARK, S.plastic, [0, 0.665, -0.24], [HALF_PI, 0, 0], [1.15, 1.25, 1]);
  P.add(rbox(P, 0.6, 0.12, 0.2, 0.05), DARK, S.plastic, [0, 0.68, 0.24], [-0.3, 0, 0]);
  seatShell(P, s);
  steering(P, s);
  // roll hoop with a light bar
  P.add(torus(P, 0.4, 0.04, 6, 18, Math.PI), DARK, S.plastic, [0, 0.64, -0.72], [-0.1, 0, 0], [1, 1.25, 1]);
  P.add(rbox(P, 0.56, 0.08, 0.1, 0.03), DARK, S.plastic, [0, 1.13, -0.77]);
  for (let k = 0; k < 4; k++) P.add(cyl(P, 0.035, 0.035, 0.02, 10), HEADLIGHT, S.glow, [-0.195 + k * 0.13, 1.13, -0.715], [HALF_PI, 0, 0]);
  // twin chrome exhaust stacks
  for (const sx of [1, -1]) {
    P.add(cyl(P, 0.055, 0.055, 0.66, 10), CHROME, S.metal, [0.36 * sx, 0.86, -1.0]);
    P.add(cyl(P, 0.068, 0.058, 0.08, 10), 0x5a606b, S.metal, [0.36 * sx, 1.2, -1.0]);
    P.add(cyl(P, 0.045, 0.045, 0.02, 8), 0x111114, S.rubber, [0.36 * sx, 1.242, -1.0]);
  }
  P.pop();
}

// Featherlite: bare tube-frame go-kart -------------------------------------

function bodyFeather(P, ctx) {
  const L = ctx.lift, f = ctx.front, r = ctx.rear, s = BODIES.feather.seat;
  axles(P, ctx);
  // rear axle sprocket (go-kart detail)
  P.add(cyl(P, 0.11, 0.11, 0.03, 14), 0x4a4d55, S.metal, [-0.22, r.r, r.z], AX);
  P.push([0, L, 0]);
  // flat tray + frame rails, nose loop and rear loop (paint)
  P.add(rbox(P, 0.62, 0.035, 1.7, 0.015), DARK, S.plastic, [0, 0.14, -0.04]);
  const y = 0.19;
  P.path([[0.3, y, -0.95], [0.32, y, 0.78], [0.18, y + 0.02, 1.0], [-0.18, y + 0.02, 1.0], [-0.32, y, 0.78], [-0.3, y, -0.95]], 0.032, PAINT, S.paint);
  // side nerf bars between the wheels (clear of any tire)
  const nb = Math.min(clearHalf(f, 0.06, 0.6, 0.52, 0.05), clearHalf(r, 0.06, 0.6, 0.52, 0.05));
  for (const sx of [1, -1]) {
    P.path([[0.31 * sx, y, 0.32], [nb * sx, y + 0.03, 0.26], [nb * sx, y + 0.03, -0.12], [0.31 * sx, y, -0.2]], 0.028, TRIM, S.paint);
  }
  // front bumper tube + rear bumper loop (chrome)
  const fb = clearHalf(f, 1.12, 0.06, 0.3, 0.04);
  P.path([[fb, 0.22, 1.12], [-fb, 0.22, 1.12]], 0.028, CHROME, S.metal);
  P.path([[0.18, y + 0.02, 1.0], [0.16, 0.22, 1.12]], 0.022, CHROME, S.metal);
  P.path([[-0.18, y + 0.02, 1.0], [-0.16, 0.22, 1.12]], 0.022, CHROME, S.metal);
  const rb = clearHalf(r, -1.08, 0.06, 0.42, 0.04);
  P.path([[0.3, y, -0.95], [rb, 0.25, -1.08], [-rb, 0.25, -1.08], [-0.3, y, -0.95]], 0.03, CHROME, S.metal);
  // nose fairing with a number plate
  P.add(rbox(P, 0.44, 0.18, 0.4, 0.08, 2), PAINT, S.paint, [0, 0.29, 0.84], [0.25, 0, 0]);
  P.add(cyl(P, 0.085, 0.085, 0.015, 16), 0xffffff, S.paint, [0, 0.33, 1.04], [HALF_PI + 0.25, 0, 0]);
  P.add(cyl(P, 0.05, 0.05, 0.02, 12), TRIM, S.paint, [0, 0.33, 1.045], [HALF_PI + 0.25, 0, 0]);
  // small side fairings
  P.sym(() => rbox(P, 0.06, 0.15, 0.42, 0.03), PAINT, S.paint, [0.33, 0.27, -0.02]);
  // bucket seat (trim colored) on struts
  P.add(rbox(P, 0.46, 0.07, 0.42, 0.03), TRIM, S.cloth, [s[0], s[1], s[2]]);
  P.add(rbox(P, 0.48, 0.46, 0.08, 0.04), TRIM, S.cloth, [s[0], s[1] + 0.24, s[2] - 0.23], [-0.28, 0, 0]);
  P.sym(() => rbox(P, 0.06, 0.18, 0.4, 0.025), TRIM, S.cloth, [0.24, s[1] + 0.08, s[2] - 0.02]);
  P.sym(() => cyl(P, 0.02, 0.02, s[1] - 0.15, 6), DARK, S.metal, [0.16, (s[1] + 0.15) / 2, s[2]]);
  // pedals + steering
  P.sym(() => box(0.07, 0.1, 0.03), DARK, S.metal, [0.12, 0.22, 0.5], [-0.4, 0, 0]);
  steering(P, s);
  // small engine behind the seat + muffler with twin tips
  P.add(rbox(P, 0.26, 0.24, 0.26, 0.04), DARK, S.plastic, [-0.18, 0.3, -0.78]);
  for (let k = 0; k < 3; k++) P.add(box(0.28, 0.02, 0.2), CHROME, S.metal, [-0.18, 0.44 + k * 0.035, -0.78]);
  P.add(cyl(P, 0.06, 0.06, 0.1, 10), 0xe8344e, S.paint, [-0.18, 0.3, -0.62], [HALF_PI, 0, 0]);
  P.path([[0.0, 0.34, -0.74], [0.2, 0.36, -0.74], [0.24, 0.4, -0.84]], 0.03, CHROME, S.metal);
  P.add(cyl(P, 0.075, 0.075, 0.26, 12), CHROME, S.metal, [0.24, 0.4, -0.98], [HALF_PI, 0, 0]);
  for (const sx of [1, -1]) P.add(cyl(P, 0.026, 0.026, 0.06, 8), 0x2a2a33, S.metal, [0.24 + 0.035 * sx, 0.4, -1.13], [HALF_PI, 0, 0]);
  // taillights on the rear loop
  P.sym(() => box(0.08, 0.05, 0.03), TAILLIGHT, S.glow, [0.3, 0.27, -1.1]);
  P.pop();
}

// Rocket Sled: long fuselage + nose cone, jet fins, thruster nozzle ---------

function bodyRocket(P, ctx) {
  const L = ctx.lift, f = ctx.front, r = ctx.rear, s = BODIES.rocket.seat;
  axles(P, ctx);
  P.push([0, L, 0]);
  P.add(rbox(P, 0.6, 0.1, 1.8, 0.04), DARK, S.plastic, [0, 0.17, -0.12]);
  // fuselage (elliptical) + nose cone + tip
  const ell = [0.9, 1, 0.62];
  P.add(cyl(P, 0.4, 0.4, 1.3, 22), PAINT, S.paint, [0, 0.4, -0.25], [HALF_PI, 0, 0], ell);
  P.add(cone(P, 0.4, 0.9, 22), PAINT, S.paint, [0, 0.4, 0.85], [HALF_PI, 0, 0], ell);
  P.add(cone(P, 0.088, 0.2, 14), TRIM, S.paint, [0, 0.4, 1.2], [HALF_PI, 0, 0], ell);
  // trim rings + side stripes
  for (const z of [0.4, -0.86]) P.add(torus(P, 0.4, 0.026, 5, 24), TRIM, S.paint, [0, 0.4, z], ORIGIN, [0.905, 0.63, 1]);
  P.sym(() => box(0.02, 0.05, 1.06), TRIM, S.paint, [0.361, 0.42, -0.24]);
  // headlight "eyes" on the nose + canard fins
  P.sym(() => cyl(P, 0.045, 0.045, 0.03, 12), HEADLIGHT, S.glow, [0.15, 0.48, 0.82], [HALF_PI - 0.5, 0.45, 0]);
  const cn = Math.min(0.36, f.inner - 0.04);
  P.sym(() => rbox(P, cn - 0.12, 0.03, 0.14, 0.012), TRIM, S.paint, [0.06 + cn / 2, 0.33, 0.98], [0, 0, -0.12]);
  // cockpit opening, dash, seat, steering
  P.add(torus(P, 0.26, 0.045, 6, 18), DARK, S.plastic, [0, 0.645, -0.26], [HALF_PI, 0, 0], [1.1, 1.35, 1]);
  P.add(rbox(P, 0.48, 0.1, 0.18, 0.05), DARK, S.plastic, [0, 0.62, 0.22], [-0.35, 0, 0]);
  P.add(rbox(P, 0.42, 0.13, 0.02, 0.02), 0x9fd8ff, S.gloss, [0, 0.7, 0.31], [-0.55, 0, 0]);
  seatShell(P, s, SEAT_COL, 0.44);
  steering(P, s);
  // thruster nozzle (narrow at the fuselage, flared at the back) + glowing core
  P.add(cyl(P, 0.27, 0.2, 0.32, 18), 0x5a606b, S.metal, [0, 0.4, -1.06], [-HALF_PI, 0, 0]);
  P.add(torus(P, 0.265, 0.025, 5, 20), CHROME, S.metal, [0, 0.4, -1.22]);
  P.add(cyl(P, 0.22, 0.22, 0.02, 18), 0x16171d, S.plastic, [0, 0.4, -1.2], [HALF_PI, 0, 0]);
  P.add(cyl(P, 0.15, 0.15, 0.025, 16), 0x3fb8ff, S.glow, [0, 0.4, -1.21], [HALF_PI, 0, 0]);
  P.add(cyl(P, 0.07, 0.07, 0.03, 12), 0xbff0ff, S.softGlow, [0, 0.4, -1.215], [HALF_PI, 0, 0]);
  // tall swept tail fin + two canted fins around the nozzle
  P.add(rbox(P, 0.05, 0.5, 0.4, 0.02), TRIM, S.paint, [0, 0.82, -0.98], [-0.5, 0, 0]);
  P.add(box(0.055, 0.06, 0.3), PAINT, S.paint, [0, 1.02, -1.12], [-0.5, 0, 0]);
  const tf = Math.min(0.46, r.inner - 0.01);
  P.sym(() => rbox(P, tf - 0.2, 0.04, 0.3, 0.015), TRIM, S.paint, [0.2 + (tf - 0.2) / 2, 0.36, -1.12], [0, 0.25, -0.35]);
  // taillights on the fuselage flanks
  P.sym(() => rbox(P, 0.03, 0.06, 0.1, 0.012), TAILLIGHT, S.glow, [0.33, 0.48, -0.88]);
  P.pop();
}

// Seats, axles, exhaust tips and the Steer Assist antenna mount per body
// (nominal, before lift). Wheel x/z are the Standard-tire layout;
// wheelLayout() adapts them per style.
const BODIES = {
  standard: { build: bodyClassic, seat: SEAT, front: { x: 0.57, z: 0.68 }, rear: { x: 0.6, z: -0.6 },
    exhausts: [[0.2, 0.585, -1.2], [-0.2, 0.585, -1.2]], antenna: [0.3, 0.5, -1.1] },
  speedster: { build: bodySpeedster, seat: [0, 0.38, -0.32], front: { x: 0.58, z: 0.74 }, rear: { x: 0.62, z: -0.62 },
    exhausts: [[0.08, 0.28, -1.36], [-0.08, 0.28, -1.36]], antenna: [0.32, 0.36, -1.19] },
  buggy: { build: bodyBuggy, seat: [0, 0.5, -0.28], front: { x: 0.57, z: 0.62 }, rear: { x: 0.62, z: -0.56 },
    exhausts: [[0.29, 0.4, -0.99], [-0.29, 0.4, -0.99]], antenna: [0.3, 0.5, -0.78] },
  tank: { build: bodyTruck, seat: [0, 0.52, -0.3], front: { x: 0.62, z: 0.66 }, rear: { x: 0.64, z: -0.6 },
    exhausts: [[0.36, 1.26, -1.0], [-0.36, 1.26, -1.0]], antenna: [0.3, 0.62, -0.97] },
  feather: { build: bodyFeather, seat: [0, 0.3, -0.32], front: { x: 0.58, z: 0.66 }, rear: { x: 0.6, z: -0.6 },
    exhausts: [[0.275, 0.4, -1.17], [0.205, 0.4, -1.17]], antenna: [-0.26, 0.28, -1.0] },
  rocket: { build: bodyRocket, seat: [0, 0.42, -0.26], front: { x: 0.56, z: 0.74 }, rear: { x: 0.62, z: -0.64 },
    exhausts: [[0.07, 0.4, -1.24], [-0.07, 0.4, -1.24]], antenna: [0.28, 0.5, -0.92] },
};

// Shared limbs: arms reaching the steering wheel, knees-up legs on the pedals.
function arms(T, sleeve, glove, r = 0.068, gloveR = 0.078) {
  for (const sx of [1, -1]) {
    const sh = [0.2 * sx, 0.79, -0.27];
    const el = [0.27 * sx, 0.67, -0.07];
    const ha = [0.14 * sx, 0.76, 0.15];
    T.limb(sh, el, r, sleeve);
    T.limb(el, ha, r * 0.92, sleeve);
    T.add(sphere(T, gloveR, 10, 8), glove, S.cloth, ha);
  }
}

// Knees up, feet forward on the pedals.
function legs(T, pants, shoe, { r = 0.066, shoeSurf = S.plastic } = {}) {
  for (const sx of [1, -1]) {
    const hip = [0.1 * sx, 0.5, -0.24], knee = [0.14 * sx, 0.6, 0.08], ankle = [0.13 * sx, 0.45, 0.34];
    T.limb(hip, knee, r, pants);
    T.limb(knee, ankle, r * 0.85, pants);
    T.add(sphere(T, 0.07, 10, 8), shoe, shoeSurf, [0.13 * sx, 0.43, 0.4], ORIGIN, [0.85, 0.7, 1.35]);
  }
}

// =============================================================== drivers
//
// Each builder gets three part collectors and authors its racer around the
// nominal layout:
//   T  torso — kart space, sitting on the nominal SEAT (re-centered on it later)
//   H  head  — relative to the head pivot NECK, +Z is the face
//   A  A.part(name, { parent: 'driver'|'head', pivot, mirror?, material? }, build)
//      adds a separately animated part, authored in the same space as its
//      parent (kart space for 'driver', head space for 'head') and rotated /
//      scaled about `pivot`. mirror: also a right-hand copy (x mirrored).
// Drivers stay within ~1.0 m above the seat; heavies are wider, not taller.
// Big glossy eyes face the camera on the grid; from the chase camera every
// racer reads by its silhouette and back (wings, shell, mane, fan, oven…).

const INK = 0x1b1b22;
const BLUSH = 0xff8a9a;
const MOUTH = 0x5a1d24;
const TONGUE = 0xff7b8a;
const TOOTH = 0xfffaf0;

const DRIVER_SCALE = { light: 0.9, medium: 1, heavy: 1.05 };
const DRIVERS = createBrainrotDrivers({ THREE, S, sphere, cyl, cone, torus, box, rbox, eyes, arms, legs });
const ANIMATE = {};

function eyes(H, x, y, z, r, o = {}) {
  eye(H, -x, y, z, r, o);
  eye(H, x, y, z, r, o);
}
function openSmile(H, y, z, w) {
  H.add(sphere(H, w, 12, 8), MOUTH, S.skin, [0, y, z], ORIGIN, [1, .65, .3]);
}

// Placeholder driver for a custom racer whose .glb is not loaded (node tools,
// or a model that failed after registration): a friendly round racer in the
// racer's color.
function blobDriver(T, H, A, def) {
  const col = (def && def.color) || 0x8a8f99, light = new THREE.Color(col).lerp(new THREE.Color(0xffffff), 0.45).getHex();
  T.add(sphere(T, 0.25, 14, 10), col, S.cloth, [0, 0.66, -0.31], ORIGIN, [1.05, 1, 0.9]);
  arms(T, col, light);
  const hc = 0.26;
  H.add(sphere(H, 0.22, 16, 12), light, S.skin, [0, hc, 0.02]);
  eyes(H, 0.085, hc + 0.04, 0.19, 0.075);
  openSmile(H, hc - 0.09, 0.215, 0.05);
}

// =============================================================== the model

function driverAssets(def, lod) {
  const seg = lod === 'low' ? 0.55 : 1;
  const build = DRIVERS[def.id] || blobDriver;
  const key = `driver|${DRIVERS[def.id] ? def.id : `blob-${(def.color >>> 0).toString(16)}`}|${lod}`;
  const v = acquireAsset(key, () => {
    const T = new Parts(seg), H = new Parts(seg);
    const parts = [];
    const A = {
      part(name, opts, fn) {
        const P = new Parts(seg);
        fn(P);
        const geo = P.merge();
        const pv = opts.pivot || [0, 0, 0];
        geo.translate(-pv[0], -pv[1], -pv[2]);
        geo.computeBoundingSphere();
        parts.push({ name, parent: opts.parent === 'head' ? 'head' : 'driver', pivot: pv, geo, mirror: !!opts.mirror, material: opts.material || null });
      },
    };
    build(T, H, A, def);
    const torso = T.merge();
    torso.translate(-SEAT[0], -SEAT[1], -SEAT[2]);
    return { torso, head: H.merge(), parts };
  });
  return { ...v, keys: [key], scale: DRIVER_SCALE[def.weightClass] || 1 };
}

const _wm = new THREE.Matrix4();
const WHEEL_ORDER = ['fl', 'fr', 'rl', 'rr'];

/**
 * Build a kart + driver model for a racer definition (or id) and a loadout
 * { body, wheels } (parts.js; default Classic + Standard). The kart is painted
 * in the racer's colors. Faces +Z, origin at ground center. userData contract
 * (SPEC §4/§13.4/§14.1): character, loadout, body, driver, head, headMesh,
 * wheels, steerPivots, exhausts, rearWheelL/R, tintMaterials, wheelMesh,
 * syncWheels, wheelRadius, lift, kartScale, antennaMount, anim (animated
 * parts by name), animate(t, kart) | null, ownedMaterials, assetKeys.
 */
export function buildKartModel(def, { lod = 'high', loadout = null } = {}) {
  def = def && def.id ? def : getCharacter(def);
  lod = lod === 'low' ? 'low' : 'high';
  const lo = sanitizeLoadout(loadout);
  const bodyDef = BODIES[lo.body] || BODIES.standard;
  const style = WHEEL_STYLES[lo.wheels] || WHEEL_STYLES.standard;
  const layout = wheelLayout(bodyDef, style);
  const lift = layout.lift;
  const seg = lod === 'low' ? 0.55 : 1;

  // shared geometry
  const chassisKey = `chassis|${lo.body}|${lo.wheels}|${lod}`;
  const wheelKey = `wheel|${lo.wheels}|${lod}`;
  const chassisGeo = acquireAsset(chassisKey, () => { const P = new Parts(seg); bodyDef.build(P, layout); return P.merge(); });
  const wheelGeo = acquireAsset(wheelKey, () => { const P = new Parts(seg); style.build(P, style.r); return P.merge(); });
  const glb = def.custom && def.model ? def : null;
  const drv = glb ? { torso: null, head: null, parts: [], keys: [], scale: 1 } : driverAssets(def, lod);

  // per-kart material (slot colors = the racer's kart colors) — also the star tint material
  const paint = makeKartMaterial(kartSlotColors(def));
  paint.name = `kart-${def.id}`;
  const owned = [paint];

  const root = new THREE.Group();
  root.name = `kart:${def.id}`;
  const kartScale = 0.95 + 0.025 * ((def.ratings && def.ratings.weight) || 3);
  root.scale.setScalar(kartScale);

  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);
  const chassis = new THREE.Mesh(chassisGeo, paint);
  chassis.name = 'chassis';
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  body.add(chassis);

  const seat = bodyDef.seat;
  const driver = new THREE.Group();
  driver.name = 'driver';
  driver.position.set(seat[0], seat[1] + lift, seat[2]);
  driver.scale.setScalar(drv.scale);
  body.add(driver);
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(NECK[0] - SEAT[0], NECK[1] - SEAT[1], NECK[2] - SEAT[2]);
  driver.add(head);
  let headMesh = null;
  if (glb) {
    driver.add(seatCustomModel(glb));
    headMesh = new THREE.Group();          // nothing to animate on a custom head
    headMesh.name = 'headMesh';
    head.add(headMesh);
  } else {
    const torso = new THREE.Mesh(drv.torso, paint);
    torso.name = 'torso';
    torso.castShadow = true;
    torso.receiveShadow = true;
    driver.add(torso);
    headMesh = new THREE.Mesh(drv.head, paint);
    headMesh.name = 'headMesh';
    headMesh.castShadow = true;
    headMesh.receiveShadow = true;
    head.add(headMesh);
  }

  // signature-motion parts (wings, shell, mane, fan, oven fire, …)
  const anim = {};
  let glowMat = null;
  for (const p of drv.parts) {
    let mat = paint;
    if (p.material === 'glow') {
      if (!glowMat) { glowMat = new THREE.MeshBasicMaterial({ vertexColors: true }); glowMat.name = `glow-${def.id}`; owned.push(glowMat); }
      mat = glowMat;
    }
    const parent = p.parent === 'head' ? head : driver;
    const base = p.parent === 'head' ? [0, 0, 0] : SEAT;
    const sides = p.mirror ? [1, -1] : [0];
    for (const sx of sides) {
      const m = new THREE.Mesh(p.geo, mat);
      m.name = sx === 0 ? p.name : p.name + (sx > 0 ? 'L' : 'R');
      m.position.set((p.pivot[0] - base[0]) * (sx || 1), p.pivot[1] - base[1], p.pivot[2] - base[2]);
      if (sx < 0) m.scale.x = -1;
      m.castShadow = mat === paint;
      m.receiveShadow = mat === paint;
      parent.add(m);
      anim[m.name] = m;
    }
  }

  // Exhaust tip markers (for boost flames) + the Steer Assist antenna mount.
  const exhausts = bodyDef.exhausts.map((p, i) => {
    const o = new THREE.Object3D();
    o.name = `exhaust${i}`;
    o.position.set(p[0], p[1] + lift, p[2]);
    body.add(o);
    return o;
  });
  const antennaMount = new THREE.Object3D();
  antennaMount.name = 'antennaMount';
  antennaMount.position.set(bodyDef.antenna[0], bodyDef.antenna[1] + lift, bodyDef.antenna[2]);
  body.add(antennaMount);

  // Wheel "bones" (empty transforms) + one InstancedMesh drawing all 4 wheels.
  const steerPivots = {};
  const wheels = {};
  for (const k of WHEEL_ORDER) {
    const bone = new THREE.Object3D();
    bone.name = `wheel_${k}`;
    const w = k[0] === 'f' ? layout.front : layout.rear;
    const x = k[1] === 'l' ? w.x : -w.x;
    if (k[0] === 'f') {
      const pivot = new THREE.Object3D();
      pivot.name = `steer_${k}`;
      pivot.position.set(x, w.r, w.z);
      bone.scale.setScalar(style.fs);
      pivot.add(bone);
      root.add(pivot);
      steerPivots[k] = pivot;
    } else {
      bone.position.set(x, w.r, w.z);
      root.add(bone);
    }
    wheels[k] = bone;
  }
  const wheelMesh = new THREE.InstancedMesh(wheelGeo, paint, 4);
  wheelMesh.name = 'wheels';
  wheelMesh.castShadow = true;
  wheelMesh.receiveShadow = true;
  root.add(wheelMesh);
  const syncWheels = () => {
    for (let i = 0; i < 4; i++) {
      const k = WHEEL_ORDER[i];
      const bone = wheels[k];
      bone.updateMatrix();
      if (k[0] === 'f') {
        const pivot = steerPivots[k];
        pivot.updateMatrix();
        _wm.multiplyMatrices(pivot.matrix, bone.matrix);
      } else {
        _wm.copy(bone.matrix);
      }
      wheelMesh.setMatrixAt(i, _wm);
    }
    wheelMesh.instanceMatrix.needsUpdate = true;
  };
  syncWheels();
  wheelMesh.computeBoundingSphere();
  // a little slack so steering/spin never culls a wheel
  if (wheelMesh.boundingSphere) wheelMesh.boundingSphere.radius += 0.25;

  const ud = {
    character: def,
    loadout: lo,
    body,
    driver,
    head,
    headMesh,
    wheels,
    steerPivots,
    exhausts,
    antennaMount,
    rearWheelL: wheels.rl,
    rearWheelR: wheels.rr,
    tintMaterials: [paint],
    wheelMesh,
    syncWheels,
    wheelRadius: { front: layout.front.r, rear: layout.rear.r },
    lift,
    kartScale,
    anim,
    animate: null,
    ownedMaterials: owned,
    assetKeys: [chassisKey, wheelKey, ...drv.keys],
  };
  const motion = !glb && ANIMATE[def.id];
  if (motion) ud.animate = (t, kart = null) => motion(ud, t, kart);
  root.userData = ud;
  if (ud.animate) ud.animate(0, null);
  return root;
}

// Free the per-kart GPU resources of a model built by buildKartModel (its
// materials and the wheel instance buffer) and release its references to the
// shared geometry cache (shared geometry stays alive while other models use
// it; idle entries are evicted LRU-style). A custom racer's .glb geometry is
// shared with its loaded scene and is left alone. Safe to call more than once.
export function disposeKartModel(model) {
  const ud = model && model.userData;
  if (!ud) return;
  if (ud.ownedMaterials) for (const m of ud.ownedMaterials) m.dispose();
  ud.ownedMaterials = [];
  if (ud.wheelMesh && ud.wheelMesh.dispose) ud.wheelMesh.dispose();
  ud.wheelMesh = null;
  if (ud.assetKeys) for (const key of ud.assetKeys) releaseAsset(key);
  ud.assetKeys = [];
}
