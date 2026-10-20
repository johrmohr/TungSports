// World dispatcher (browser only, SPEC §14.4 / §15.3): builds the scenery
// kit that matches a track's theme.
//
//   import { buildWorld } from './worlds.js';
//   const world = buildWorld(scene, track, { renderer, quality: 'high' | 'low' });
//   world.update(dt, focusPosition, camera);   // every frame
//   world.dispose();
//
// Every kit returns the same contract: { sun, hemi, root, update, dispose,
// getGroundHeight(x, z), landmarks, stats, quality, itemBoxAnchor }.
// The castle kit adds `hazards` ({ update(dt), check(kart) → null | 'crush' |
// 'fire', ... }, see hazards.js); other kits have none.
// quality 'low' (split-screen) builds no follow shadow map (karts use blob
// shadows), coarser terrain and fewer props.

import { buildWorld as buildBayWorld } from './world.js';
import { buildMonteWorld } from './world-monte.js';
import { buildAldrichWorld } from './world-aldrich.js';
import { buildLagunaWorld } from './world-laguna.js';
import { buildPalaceWorld } from './world-palace.js';

const KITS = {
  bay: buildBayWorld,          // Breezy Bay Circuit
  hilltown: buildMonteWorld,   // Monte Mozzarella
  campus: buildAldrichWorld,   // Aldrich Park
  beach: buildLagunaWorld,     // Laguna Beach
  castle: buildPalaceWorld,    // Krishiv's Palace
};

export const WORLD_THEMES = Object.keys(KITS);

export function buildWorld(scene, track, opts = {}) {
  const kit = KITS[track && track.theme] || buildBayWorld;
  return kit(scene, track, opts);
}
