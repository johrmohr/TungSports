// Imports every item plugin module (SPEC §16.2) so each registers its
// handler (registry.js) before any ItemSystem is built. items.js imports this
// file; nothing else needs to. Add a line when a new plugin module appears.

// v5 group A — thrown / placed / projectile / environment
import './peperoncino.js';
import './granita.js';
import './flying_pizza.js';
import './rolling_pins.js';
import './piggy_bank.js';
import './parm_wheel.js';
import './surprise_egg.js';
import './prank_box.js';
import './banana_split.js';
import './sour_lemon.js';
import './padella.js';
import './taralli.js';
import './befana.js';
// v5 group B — self-buff / transform / kart-state
import './calzone.js';
import './ladro.js';
import './hot_potato.js';
import './mortadella.js';
import './tarantella.js';
import './grissino.js';
import './antipasto.js';
import './amore.js';
import './lira_purse.js';
import './tip_jar.js';
// v5 group B — the lire (coin) system: an item *system* plugin, not a roulette item
import './coins.js';

export { registerItem, getItemHandler, itemHandlers, isNativeItem, registerItemSystem, itemSystems } from './registry.js';
