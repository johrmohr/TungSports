// Custom .glb racers (SPEC §14.9): loading + seating user-supplied models.
//
//   import { loadCustomRacers } from './glb-racers.js';
//   const defs = await loadCustomRacers();   // desktop, at boot
//
// public/characters/index.json lists the racers:
//   [{ id, name, file, weightClass: 'light'|'medium'|'heavy', color: '#rrggbb',
//      scale?, yOffset?, rotationY? }]
// and the .glb files sit beside it. Each model is loaded with three's
// GLTFLoader and registered through characters.js registerCustomCharacters()
// (ratings from parts.js CUSTOM_GROUP_FOR_CLASS); buildKartModel() then seats
// it as the driver of the racer's kart (seatCustomModel below). Broken or
// missing entries are skipped with a console warning. Custom racers are only
// ever picked by humans (never CPUs).
//
// Node-safe to import: GLTFLoader is imported lazily inside loadCustomRacers()
// (the browser path), and seatCustomModel() only uses three's core math.

import * as THREE from 'three';
import { registerCustomCharacters } from './characters.js';

export const MAX_CUSTOM_RACERS = 16;
const ID_RE = /^[a-z0-9_-]{1,32}$/;
const FILE_RE = /^[\w-][\w .-]{0,63}\.glb$/i;      // a plain file name beside index.json
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Validate the entries of characters/index.json. Returns the usable ones
 * ({ id, name, file, weightClass, color, scale, yOffset, rotationY }); bad
 * entries are skipped with a warning.
 */
export function parseRacerIndex(list, takenIds = []) {
  const out = [];
  const taken = new Set(takenIds);
  if (!Array.isArray(list)) return out;
  for (const e of list.slice(0, MAX_CUSTOM_RACERS)) {
    const id = e && typeof e.id === 'string' ? e.id.toLowerCase() : '';
    if (!ID_RE.test(id) || taken.has(id) || typeof e.file !== 'string' || !FILE_RE.test(e.file)) {
      console.warn('[custom racers] entry skipped (bad id, duplicate or bad file name):', e && e.id);
      continue;
    }
    taken.add(id);
    out.push({
      id,
      name: String(e.name || id).slice(0, 32),
      file: e.file,
      weightClass: ['light', 'medium', 'heavy'].includes(e.weightClass) ? e.weightClass : 'medium',
      color: COLOR_RE.test(e.color || '') ? e.color.toLowerCase() : '#8a8f99',
      scale: Number(e.scale) > 0 ? Number(e.scale) : 1,
      yOffset: Number.isFinite(Number(e.yOffset)) ? Number(e.yOffset) : 0,
      rotationY: Number.isFinite(Number(e.rotationY)) ? Number(e.rotationY) : 0,
    });
  }
  return out;
}

/**
 * Browser: fetch `${base}index.json`, load every listed .glb and register the
 * racers that loaded. Resolves to the registered defs ([] when there are none
 * or the index is missing). Never throws.
 */
export async function loadCustomRacers({ base = 'characters/', takenIds = [] } = {}) {
  if (typeof fetch !== 'function') return [];
  let entries;
  try {
    const res = await fetch(`${base}index.json`, { cache: 'no-cache' });
    if (!res.ok) return [];
    entries = parseRacerIndex(await res.json(), takenIds);
  } catch (err) {
    console.warn('[custom racers] characters/index.json unreadable — none loaded', err && err.message);
    return [];
  }
  if (!entries.length) return [];
  let GLTFLoader;
  try {
    ({ GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'));
  } catch (err) {
    console.warn('[custom racers] GLTFLoader unavailable — none loaded', err && err.message);
    return [];
  }
  const loader = new GLTFLoader();
  const defs = [];
  for (const e of entries) {
    try {
      const gltf = await loader.loadAsync(`${base}${encodeURIComponent(e.file)}`);
      defs.push({ ...e, model: gltf.scene });
    } catch (err) {
      console.warn(`[custom racers] "${e.id}" failed to load (${e.file}) — skipped`, err && err.message);
    }
  }
  return defs.length ? registerCustomCharacters(defs) : [];
}

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();

/**
 * Seat a custom racer's model on its kart (called by buildKartModel): a clone
 * of the loaded scene, turned by def.rotationY so it faces +Z, normalized to
 * ~1.0 m tall (× def.scale; never wider than the cockpit), centered on the
 * seat and lifted by def.yOffset. Returns a Group in driver space. The clone
 * shares the loaded geometry and materials (never disposed with the kart).
 */
export function seatCustomModel(def) {
  const wrap = new THREE.Group();
  wrap.name = 'customModel';
  const inner = def.model.clone(true);
  inner.rotation.y = def.rotationY || 0;
  wrap.add(inner);
  wrap.updateMatrixWorld(true);
  _box.setFromObject(inner);
  if (_box.isEmpty()) return wrap;
  _box.getSize(_size);
  _box.getCenter(_center);
  const s = Math.min(1.0 / Math.max(_size.y, 1e-3), 0.95 / Math.max(_size.x, 1e-3), 1.2 / Math.max(_size.z, 1e-3)) * (def.scale || 1);
  inner.scale.multiplyScalar(s);
  inner.position.set(-_center.x * s, -_box.min.y * s - 0.04 + (def.yOffset || 0), -_center.z * s);
  inner.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return wrap;
}
