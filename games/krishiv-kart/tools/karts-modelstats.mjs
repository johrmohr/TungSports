// KARTS: model stats (draw calls / triangles). node tools/karts-modelstats.mjs [--parts]
//   * every racer on its default kart (Classic + Standard), high + low LOD
//   * the heaviest combination: heaviest body × heaviest wheels × heaviest driver
//   * --parts: triangles of each body and wheel style
import { CHARACTERS, buildKartModel, disposeKartModel } from '../public/js/characters.js';
import { KART_BODIES, WHEELS } from '../public/js/parts.js';

function stats(def, loadout, lod = 'high') {
  const m = buildKartModel(def, { lod, loadout });
  let tris = 0, calls = 0;
  const parts = {};
  m.traverse((o) => {
    if (!o.isMesh) return;
    calls++;
    const g = o.geometry;
    const n = (g.index ? g.index.count / 3 : g.attributes.position.count / 3) * (o.isInstancedMesh ? o.count : 1);
    tris += n;
    parts[o.name] = n;
  });
  disposeKartModel(m);
  return { tris, calls, parts };
}

const driverTris = {};
for (const lod of ['high', 'low']) {
  let total = 0;
  for (const c of CHARACTERS) {
    const s = stats(c, null, lod);
    total += s.tris;
    if (lod === 'high') driverTris[c.id] = s.tris - s.parts.chassis - s.parts.wheels;
    console.log(`${lod} ${c.id.padEnd(11)} draw calls ${s.calls}  tris ${String(s.tris).padStart(6)}  [${Object.entries(s.parts).map(([k, v]) => `${k}:${v}`).join(' ')}]`);
  }
  console.log(`${lod} total ${CHARACTERS.length} karts: ${total} tris (8-kart grid ~${Math.round((total / CHARACTERS.length) * 8)})\n`);
}

const bodyTris = {}, wheelTris = {};
for (const b of KART_BODIES) for (const w of WHEELS) {
  const s = stats(CHARACTERS[0], { body: b.id, wheels: w.id });
  bodyTris[b.id] = Math.max(bodyTris[b.id] || 0, s.parts.chassis);
  wheelTris[w.id] = s.parts.wheels;
}
const heavyBody = Object.entries(bodyTris).sort((a, b) => b[1] - a[1])[0][0];
const heavyWheels = Object.entries(wheelTris).sort((a, b) => b[1] - a[1])[0][0];
const heavyDriver = Object.entries(driverTris).sort((a, b) => b[1] - a[1])[0][0];
const worst = stats(CHARACTERS.find((c) => c.id === heavyDriver), { body: heavyBody, wheels: heavyWheels });
console.log(`heaviest combo: ${heavyBody} + ${heavyWheels} + ${heavyDriver}: draw calls ${worst.calls}, tris ${worst.tris} [${Object.entries(worst.parts).map(([k, v]) => `${k}:${v}`).join(' ')}]`);
console.log(`most draw calls of any racer: ${Math.max(...CHARACTERS.map((c) => stats(c, null).calls))} — budget ~6 per kart`);

if (process.argv.includes('--parts')) {
  console.log('\nchassis tris:', JSON.stringify(bodyTris));
  console.log('4 wheels tris:', JSON.stringify(wheelTris));
  console.log('driver tris:', JSON.stringify(driverTris));
}
