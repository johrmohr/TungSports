// KARTS sandbox (dev only) — served at /dev/karts.html by tools/devserver.mjs.
//
//   ?mode=lineup [&view=front|three|side|back] [&grid=1]
//        the 12 racers side by side (grid=1: one camera each)
//   ?mode=closeups [&cam=chase|front3|back3|side] [&cols=4] [&chars=a,b] [&boost=1] [&lod=low]
//        every racer at chase-camera distance (cam=chase: as seen while racing) or
//        front 3/4; signature motions animate (boost=1: their boosted variant)
//   ?mode=portrait &char=id [&size=256]
//        one racer, head-and-shoulders 3/4 front view on a transparent background
//        (tools/render-portraits.mjs screenshots it into public/img/racers/<id>.png)
//   ?mode=parts [&wheels=standard,monster,tiny] [&char=sahur] [&view=three|rear3|...]
//        6 kart bodies × the listed wheel styles (one camera per cell)
//        (grid modes log "[karts] grid draw calls per kart" — the per-kart budget check)
//   ?mode=closeup [&char=sahur] [&body=..] [&wheels=..] [&front=1] [&speed=0] [&assist=1]
//        one kart at chase-camera distance (front=1: look-back camera = face view)
//   ?mode=drive [&track=breezy|monte] [&scenario=race|pack] [&s=50] [&follow=0] [&intro=1]
//        [&stopAt=2.5] [&chars=a,b] [&assist=1] [&tier=1..3] [&boostAt=t] [&starAt=t]
//        [&spinAt=t] [&tumbleAt=t] [&zapAt=t] [&trickAt=t] [&lat=x] [&nodrift=1]
//        debug ribbon of the real track, 8 autopiloted karts, ChaseCamera on kart
//        `follow`. assist=1 gives the followed kart Steer Assist (antenna), tier=N
//        forces its drift charge to tier N (spark colors), trickAt plays the jump
//        trick flourish. stopAt freezes the simulation at that sim time (rendering
//        continues), and fast-forwards there, so screenshots are deterministic.
//
// Simulation is fixed-step: every rendered frame advances 1/60 s (2 substeps).
// Debug handle: window.__karts (scene, renderer, karts, views, effects, chase, stats()).

import * as THREE from 'three';
import { CURB_WIDTH } from '../js/track.js';
import { getTrack } from '../js/tracks.js';
import { Kart, resolveKartCollisions } from '../js/kart.js';
import { CHARACTERS, getCharacter, buildKartModel } from '../js/characters.js';
import { KART_BODIES, getWheels, CPU_PRESETS } from '../js/parts.js';
import { KartView } from '../js/kartview.js';
import { Effects } from '../js/effects.js';
import { ChaseCamera } from '../js/camera.js';
import { RACE } from '../js/config.js';
import { bus } from '../js/bus.js';
import { Autopilot } from './karts-autopilot.js';

const Q = new URLSearchParams(location.search);
const MODE = Q.get('mode') || 'drive';
const num = (k, d) => (Q.has(k) && Q.get(k) !== '' ? Number(Q.get(k)) : d);
const FRAME_DT = 1 / 60;
const SUBSTEPS = 2;

// ------------------------------------------------------------ renderer/scene

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: MODE === 'portrait', preserveDrawingBuffer: MODE === 'portrait', powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = MODE === 'portrait' ? null : new THREE.Color(0x9fd3f5);
scene.fog = new THREE.Fog(0xcfeafb, 220, 1650);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 2000);

// Lights roughly matching world.js (hemi + one shadow-casting sun).
const hemi = new THREE.HemisphereLight(0xd7ecff, 0x7d9a55, 1.35);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dc, 2.7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, near: 1, far: 200 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.035;
sun.shadow.radius = 2.2;
scene.add(sun, sun.target);
const SUN_OFFSET = new THREE.Vector3(-38, 70, -26);
function sunFollow(p) {
  sun.position.copy(p).add(SUN_OFFSET);
  sun.target.position.copy(p);
}

const hud = document.getElementById('hud');
const labelsRoot = document.getElementById('labels');

window.addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ------------------------------------------------------------ debug track

// Vertex-colored ribbon of the real track: road (incl. kicker ramp height),
// red/white curbs, banded grass to the walls, wall strips with skirts down to
// the ground, boost pads and a checkered start line. Plus a ground plane and
// instanced cone "trees" for depth cues. ~5 draw calls.
function buildDebugTrack(track) {
  const group = new THREE.Group();
  group.name = 'debug-track';
  const pos = [], col = [];
  const c = new THREE.Color();
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3(), pd = new THREE.Vector3();
  const quad = (a, b, cc, d, color) => {
    // a-b at sample i (left->right), d-cc at sample i+1
    c.set(color);
    for (const p of [a, b, cc, a, cc, d]) { pos.push(p.x, p.y, p.z); col.push(c.r, c.g, c.b); }
  };
  const N = track.N, sp = track.spacing;
  for (let i = 0; i < N; i++) {
    const s0 = i * sp, s1 = (i + 1) * sp;
    const j = (i + 1) % N;
    const stripe = Math.floor(s0 / 10) % 2 === 0;
    const curbRed = Math.floor(s0 / 2) % 2 === 0;
    const grass = stripe ? 0x5cbc43 : 0x4fae3a;
    // grass left / right (flat at center height)
    const gl0 = -track.wl[i], gl1 = -(track.hw[i] + CURB_WIDTH);
    const gl0n = -track.wl[j], gl1n = -(track.hw[j] + CURB_WIDTH);
    quad(track.pointAt(s0, gl1, pa), track.pointAt(s0, gl0, pb), track.pointAt(s1, gl0n, pc), track.pointAt(s1, gl1n, pd), grass);
    quad(track.pointAt(s0, track.wr[i], pa), track.pointAt(s0, track.hw[i] + CURB_WIDTH, pb), track.pointAt(s1, track.hw[j] + CURB_WIDTH, pc), track.pointAt(s1, track.wr[j], pd), grass);
    // curbs
    const curb = curbRed ? 0xe5302a : 0xf7f6f2;
    quad(track.pointAt(s0, -(track.hw[i] + 0.001), pa), track.pointAt(s0, -(track.hw[i] + CURB_WIDTH), pb), track.pointAt(s1, -(track.hw[j] + CURB_WIDTH), pc), track.pointAt(s1, -(track.hw[j] + 0.001), pd), curb);
    quad(track.pointAt(s0, track.hw[i] + CURB_WIDTH, pa), track.pointAt(s0, track.hw[i] + 0.001, pb), track.pointAt(s1, track.hw[j] + 0.001, pc), track.pointAt(s1, track.hw[j] + CURB_WIDTH, pd), curb);
    // road in 4 lanes (center dashes)
    const lanes = [-1, -0.04, 0.04, 1];
    for (let l = 0; l < 3; l++) {
      const la = lanes[l], lb = lanes[l + 1];
      const color = l === 1 ? (Math.floor(s0 / 4) % 2 === 0 ? 0xf2f2f2 : 0x5a5d66) : (stripe ? 0x5a5d66 : 0x555861);
      quad(track.pointAt(s0, lb * track.hw[i], pa), track.pointAt(s0, la * track.hw[i], pb), track.pointAt(s1, la * track.hw[j], pc), track.pointAt(s1, lb * track.hw[j], pd), color);
    }
  }
  // boost pads (slightly above the road)
  for (const p of track.boostPads) {
    for (let x = 0; x < p.length; x += 1) {
      const s0 = p.s0 + x, s1 = Math.min(p.s1, s0 + 1);
      const lift = (v) => { v.y += 0.03; return v; };
      quad(lift(track.pointAt(s0, p.lat1, pa)), lift(track.pointAt(s0, p.lat0, pb)), lift(track.pointAt(s1, p.lat0, pc)), lift(track.pointAt(s1, p.lat1, pd)), x % 2 ? 0xffb21f : 0xff6a1a);
    }
  }
  // start line checkers
  {
    const hw = track.hw[0];
    const cells = 16;
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < cells; k++) {
        const la = -hw + (2 * hw * k) / cells, lb = -hw + (2 * hw * (k + 1)) / cells;
        const s0 = r * 0.8 - 0.8, s1 = s0 + 0.8;
        const lift = (v) => { v.y += 0.02; return v; };
        quad(lift(track.pointAt(s0, lb, pa)), lift(track.pointAt(s0, la, pb)), lift(track.pointAt(s1, la, pc)), lift(track.pointAt(s1, lb, pd)), (k + r) % 2 ? 0x111111 : 0xffffff);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  const ribbon = new THREE.Mesh(geo, mat);
  ribbon.receiveShadow = true;
  ribbon.name = 'ribbon';
  group.add(ribbon);

  // walls + skirts down to the ground (shows elevation)
  const wp = [], wc = [];
  const ground = track.bounds.minY - 1.5;
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const s0 = i * sp, s1 = (i + 1) * sp;
      const l0 = side > 0 ? track.wr[i] : -track.wl[i];
      const l1 = side > 0 ? track.wr[j] : -track.wl[j];
      track.pointAt(s0, l0, pa); track.pointAt(s1, l1, pb);
      const top0 = pa.y + 0.9, top1 = pb.y + 0.9;
      const band = Math.floor(s0 / 4) % 2 === 0;
      c.set(band ? 0xf05a28 : 0xf7f6f2);
      const verts = [[pa.x, top0, pa.z], [pa.x, ground, pa.z], [pb.x, ground, pb.z], [pa.x, top0, pa.z], [pb.x, ground, pb.z], [pb.x, top1, pb.z]];
      for (const v of verts) { wp.push(...v); wc.push(c.r, c.g, c.b); }
    }
  }
  const wgeo = new THREE.BufferGeometry();
  wgeo.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
  wgeo.setAttribute('color', new THREE.Float32BufferAttribute(wc, 3));
  wgeo.computeVertexNormals();
  const walls = new THREE.Mesh(wgeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
  walls.castShadow = true;
  walls.receiveShadow = true;
  walls.name = 'walls';
  group.add(walls);

  // ground plane
  const b = track.bounds;
  const gw = (b.maxX - b.minX) + 600, gd = (b.maxZ - b.minZ) + 600;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(gw, gd), new THREE.MeshStandardMaterial({ color: 0x6fbf55, roughness: 1 }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.set((b.minX + b.maxX) / 2, ground, (b.minZ + b.maxZ) / 2);
  plane.receiveShadow = true;
  group.add(plane);

  // instanced cone trees outside the walls
  const treeGeo = new THREE.ConeGeometry(1.6, 5, 7);
  treeGeo.translate(0, 2.5, 0);
  const trees = new THREE.InstancedMesh(treeGeo, new THREE.MeshStandardMaterial({ color: 0x2f8a46, roughness: 0.9, flatShading: true }), 260);
  const m4 = new THREE.Matrix4();
  let n = 0;
  for (let s = 0; s < track.length && n < trees.count; s += 7.5) {
    const f = track.frameAt(s);
    for (const side of [-1, 1]) {
      if (n >= trees.count) break;
      const wall = side > 0 ? f.wallR : f.wallL;
      const off = wall + 4 + ((s * 7.31) % 9);
      const p = track.pointAt(s, side * off, pa);
      const sc = 0.7 + ((s * 3.7) % 0.6);
      m4.makeScale(sc, sc, sc).setPosition(p.x, ground, p.z);
      trees.setMatrixAt(n++, m4);
    }
  }
  trees.count = n;
  trees.castShadow = true;
  group.add(trees);
  return group;
}

// ------------------------------------------------------------ helpers

const stats = { frames: 0, last: performance.now(), fps: 0 };
function measure(fn) {
  renderer.info.autoReset = false;
  renderer.info.reset();
  fn();
  const r = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  renderer.info.autoReset = true;
  return r;
}

function addLabel(text, sub) {
  const el = document.createElement('div');
  el.className = 'label';
  el.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
  labelsRoot.appendChild(el);
  return el;
}
const _lp = new THREE.Vector3();
function placeLabel(el, worldPos, cam, vp = null) {
  _lp.copy(worldPos).project(cam);
  const W = vp ? vp.w : innerWidth, H = vp ? vp.h : innerHeight;
  const ox = vp ? vp.x : 0, oy = vp ? vp.y : 0;
  el.style.left = `${ox + (_lp.x * 0.5 + 0.5) * W}px`;
  el.style.top = `${oy + (-_lp.y * 0.5 + 0.5) * H}px`;
}

// ------------------------------------------------------------ mode: lineup / grids

// Ground + pad shared by the static modes.
function showroomGround(w = 26, d = 5, cx = 0) {
  const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 64), new THREE.MeshStandardMaterial({ color: 0x6cc35a, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const pad = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), new THREE.MeshStandardMaterial({ color: 0x5a5d66, roughness: 0.9 }));
  pad.position.set(cx, 0.02, 0);
  pad.receiveShadow = true;
  scene.add(pad);
}

const VIEW_YAW = { front: 0, three: 0.55, side: -Math.PI / 2, back: Math.PI, rear3: Math.PI - 0.6 };

// Signature motions of static models (no kart: menu-style idle; &boost=1: boosted).
const fakeKart = Q.get('boost') === '1' ? { boostTimer: 1, starTimer: 0, speed: 25 } : null;
function animateModels(models, t) {
  for (const m of models) if (m.userData.animate) m.userData.animate(t, fakeKart);
}

// The 12 racers side by side (Classic + Standard).
function runLineup() {
  if (Q.get('grid') === '1') return runGrid(CHARACTERS.map((c) => ({ def: c, label: c.shortName, sub: c.catchphrase })), { cols: 4 });
  const view = Q.get('view') || 'three';
  const spacing = 2.55;
  const n = CHARACTERS.length;
  showroomGround(n * spacing + 2, 5);
  const models = CHARACTERS.map((c, i) => {
    const m = buildKartModel(c);
    m.position.set((i - (n - 1) / 2) * spacing, 0.04, 0);
    m.rotation.y = VIEW_YAW[view] ?? 0.55;
    scene.add(m);
    return m;
  });
  sun.position.set(-30, 60, 40);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 20, bottom: -20 });
  sun.shadow.camera.updateProjectionMatrix();
  // frame the whole row for the current aspect ratio
  camera.fov = 30;
  const hf = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
  const dist = ((n * spacing) / 2 + 0.6) / Math.tan(hf / 2);
  camera.position.set(0, 0.6 + dist * 0.13, dist);
  camera.lookAt(0, 0.55, 0);
  camera.updateProjectionMatrix();
  const labels = CHARACTERS.map((c) => addLabel(c.shortName, `${c.weightClass} ${c.group}`));
  let t = 0;
  const frame = () => {
    t += 1 / 60;
    animateModels(models, t);
    models.forEach((m, i) => placeLabel(labels[i], _lp.set(m.position.x, -0.15, m.position.z + 1.2), camera));
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  frame();
  const info = measure(() => renderer.render(scene, camera));
  console.log(`[karts] lineup draw calls ${info.calls}, triangles ${info.triangles}`);
}

// Grid of cells, one camera each. cell = { def, loadout?, label, sub?, view? }.
//   &view=front|three|side|back|rear3  &zoom=kart|head  &spin=1 (turntable)
//   cam: 'orbit' (default: view yaw at 5.4 m) | 'chase' (the race camera: 5.6 m
//   behind, 2.3 m up, looking 3.2 m ahead) | 'front3' (face-on 3/4 at chase distance)
function runGrid(cells, { cols = 4, zoom = Q.get('zoom') || 'kart', cam: camMode = Q.get('cam') || 'orbit' } = {}) {
  const view = Q.get('view') || 'three';
  const spacing = 9;
  showroomGround(cells.length * spacing + 10, 6, (cells.length - 1) * spacing / 2);
  const models = cells.map((cell, i) => {
    const m = buildKartModel(cell.def, { loadout: cell.loadout || null, lod: Q.get('lod') || 'high' });
    m.position.set(i * spacing, 0.04, 0);
    scene.add(m);
    return m;
  });
  sun.position.set(cells.length * spacing * 0.5 - 30, 60, 40);
  sun.target.position.set(cells.length * spacing * 0.5, 0, 0);
  Object.assign(sun.shadow.camera, { left: -cells.length * spacing * 0.6, right: cells.length * spacing * 0.6, top: 20, bottom: -20, far: 300 });
  sun.shadow.camera.updateProjectionMatrix();
  const rows = Math.ceil(cells.length / cols);
  const fov = zoom === 'head' ? 22 : camMode === 'chase' ? num('fov', 46) : 30;
  const cams = models.map(() => new THREE.PerspectiveCamera(fov, 1, 0.1, 400));
  const labels = cells.map((c) => addLabel(c.label, c.sub || ''));
  renderer.setScissorTest(true);
  let t = 0;
  const frame = () => {
    t += 1 / 60;
    animateModels(models, t);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.setClearColor(0x2a2f3c);
    renderer.clear();
    renderer.setScissorTest(true);
    const W = innerWidth, H = innerHeight, cw = W / cols, ch = H / rows;
    models.forEach((m, i) => {
      const cx = i % cols, cy = Math.floor(i / cols);
      const cam = cams[i];
      cam.aspect = cw / ch;
      const ud = m.userData;
      if (camMode === 'chase') {
        cam.position.set(m.position.x, 2.3, m.position.z - 5.6);
        cam.lookAt(m.position.x, 0.9, m.position.z + 3.2);
      } else if (camMode === 'front3' || camMode === 'back3' || camMode === 'side') {
        const a = camMode === 'front3' ? 0.7 : camMode === 'back3' ? Math.PI - 0.7 : -Math.PI / 2;
        cam.position.set(m.position.x + Math.sin(a) * 4.2, 1.7, m.position.z + Math.cos(a) * 4.2);
        cam.lookAt(m.position.x, 0.75, m.position.z);
        cam.fov = 34;
      } else if (zoom === 'head') {
        const ang = (VIEW_YAW[cells[i].view || view] ?? 0.5) + (Q.get('spin') === '1' ? t * 0.6 : 0);
        ud.head.updateWorldMatrix(true, false);
        const hp = _lp.setFromMatrixPosition(ud.head.matrixWorld);
        const d = num('dist', 2.3);
        cam.position.set(hp.x + Math.sin(ang) * d, hp.y + 0.45, hp.z + Math.cos(ang) * d);
        cam.lookAt(hp.x, hp.y + 0.2, hp.z);
      } else {
        const ang = (VIEW_YAW[cells[i].view || view] ?? 0.5) + (Q.get('spin') === '1' ? t * 0.6 : 0);
        const d = 5.4;
        cam.position.set(m.position.x + Math.sin(ang) * d, 1.85, m.position.z + Math.cos(ang) * d);
        cam.lookAt(m.position.x, 0.72, m.position.z);
      }
      cam.updateProjectionMatrix();
      const x = cx * cw, y = (rows - 1 - cy) * ch;
      renderer.setViewport(x + 1, y + 1, cw - 2, ch - 2);
      renderer.setScissor(x + 1, y + 1, cw - 2, ch - 2);
      renderer.setClearColor(0x9fd3f5);
      renderer.clear();
      renderer.render(scene, cam);
      labels[i].style.left = `${x + cw / 2}px`;
      labels[i].style.top = `${cy * ch + ch - (cells[i].sub ? 40 : 26)}px`;
    });
    requestAnimationFrame(frame);
  };
  frame();
  // draw calls for one kart (no shadow pass) — the per-kart budget check
  setTimeout(() => {
    const keep = models.map((m) => m.visible);
    renderer.setScissorTest(false);
    const per = models.map((m, i) => {
      models.forEach((o, j) => { o.visible = i === j; });
      sun.castShadow = false;
      const r = measure(() => renderer.render(scene, cams[i]));
      sun.castShadow = true;
      return r.calls - 2;           // minus ground + pad
    });
    models.forEach((m, i) => { m.visible = keep[i]; });
    renderer.setScissorTest(true);
    console.log(`[karts] grid draw calls per kart (no shadows): max ${Math.max(...per)} [${per.join(',')}]`);
  }, 600);
}

// Every racer at chase distance / front 3/4 (&cam=chase|front3|back3|side &chars=a,b).
function runCloseups() {
  const chars = Q.get('chars') ? Q.get('chars').split(',').map((id) => getCharacter(id)) : CHARACTERS;
  const preset = Q.get('preset') === '1';
  const cells = chars.map((c) => ({
    def: c,
    loadout: preset ? CPU_PRESETS[c.weightClass][1] : null,
    label: c.shortName,
    sub: Q.get('subs') === '0' ? '' : c.catchphrase,
  }));
  runGrid(cells, { cols: num('cols', 4), cam: Q.get('cam') || 'chase' });
}

// One racer for its select-screen portrait: driver + the top of the kart,
// front 3/4, transparent background, idle signature pose (window.__portraitReady).
function runPortrait() {
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  scene.fog = null;
  const def = getCharacter(Q.get('char') || 'sahur');
  const m = buildKartModel(def);
  m.rotation.y = 0.5;
  scene.add(m);
  if (m.userData.animate) m.userData.animate(0.35, null);
  sun.position.set(6, 9, 10);
  sun.target.position.set(0, 0.8, 0);
  sun.castShadow = false;
  hemi.intensity = 1.6;
  m.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(m.userData.driver);
  const c = box.getCenter(new THREE.Vector3());
  const h = box.max.y - box.min.y;
  // frame the driver (+ a sliver of the kart): ~1.35 m tall view, slightly from above
  const dist = (Math.max(1.0, h) * 1.35) / (2 * Math.tan((24 * Math.PI) / 360));
  camera.fov = 24;
  camera.aspect = 1;
  camera.position.set(c.x + dist * 0.3, c.y + dist * 0.16, c.z + dist * 0.94);
  camera.lookAt(c.x, c.y - 0.04, c.z);
  camera.updateProjectionMatrix();
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);
  window.__portraitReady = true;
}

// 6 bodies × wheel styles (&wheels=standard,monster,tiny  &char=sahur).
function runParts() {
  const wheels = (Q.get('wheels') || 'standard,monster,tiny').split(',');
  const def = getCharacter(Q.get('char') || 'sahur');
  const cells = [];
  for (const w of wheels) {
    for (const b of KART_BODIES) cells.push({ def, loadout: { body: b.id, wheels: w }, label: b.label, sub: getWheels(w).label });
  }
  runGrid(cells, { cols: KART_BODIES.length });
}

// ------------------------------------------------------------ mode: drive / closeup

function runDrive() {
  const track = getTrack(Q.get('track') || 'breezy');
  scene.add(buildDebugTrack(track));
  const effects = new Effects(scene);
  const chase = new ChaseCamera(camera);
  const closeup = MODE === 'closeup';
  const scenario = Q.get('scenario') || (Q.has('s') ? 'pack' : 'race');
  const follow = num('follow', 0);
  const stopAt = num('stopAt', Infinity);

  // default field: 8 of the 12 racers, one of each look (&chars=a,b,c to pick)
  const field = Q.get('chars') ? Q.get('chars').split(',').map((id) => getCharacter(id))
    : ['sahur', 'ballerina', 'bombardiro', 'lirili', 'cappuccino', 'gusini', 'tralalero', 'patapim'].map(getCharacter);
  const chars = closeup ? [getCharacter(Q.get('char') || 'sahur')] : field;
  // &body= / &wheels= set the followed kart's parts
  const parts = { body: Q.get('body') || 'standard', wheels: Q.get('wheels') || 'standard' };
  const karts = chars.map((c, i) => new Kart({
    id: c.id, character: c, track, isPlayer: i === follow, loadout: i === follow ? parts : null,
    steerAssist: i === follow && Q.get('assist') === '1',
  }));
  const pilots = karts.map((k, i) => new Autopilot(k, {
    drift: Q.get('nodrift') !== '1',
    offset: ((i % 3) - 1) * 2.2 + num('lat', 0),
    throttle: 1,
  }));

  // placement
  if (scenario === 'race') {
    karts.forEach((k, i) => k.placeOnGrid(track.gridSlot(i)));
  } else {
    const s0 = num('s', 50);
    karts.forEach((k, i) => {
      const order = i === follow ? 0 : i < follow ? i + 1 : i;
      const s = track.wrapS(s0 - order * 4.5);
      const f = track.frameAt(s);
      const lat = closeup ? num('lat', 0) : f.racingLine + ((order % 3) - 1) * 2.6 + (order === 0 ? num('lat', 0) : 0);
      k.placeOnGrid({ position: track.pointAt(s, lat), yaw: f.yaw, s, lateral: lat });
      const v = closeup ? num('speed', 0) : k.stats.topSpeed * (order === 0 ? 1 : 0.97);
      k.velocity.set(Math.sin(k.yaw) * v, 0, Math.cos(k.yaw) * v);
    });
  }
  const target = karts[Math.min(follow, karts.length - 1)];
  const views = karts.map((k) => new KartView(k, scene, effects));
  for (const [q, key] of [['camDist', 'distance'], ['camHeight', 'height'], ['camLook', 'lookAhead'], ['camLookH', 'lookHeight'], ['fov', 'baseFov']]) {
    if (Q.has(q)) chase.params[key] = num(q, chase.params[key]);
  }
  chase.setTarget(target);
  chase.lookBack = Q.get('front') === '1';
  chase.snap();

  let introLeft = 0;
  if (Q.get('intro') === '1') {
    for (const k of karts) k.frozen = true;
    introLeft = num('introSeconds', RACE.introSeconds);
    chase.startIntro(track, introLeft);
  }
  if (Q.get('orbit') === '1') chase.startOrbit();

  // scripted events at sim times
  const script = [];
  const at = (key, fn) => { if (Q.has(key)) script.push({ t: num(key, 0), fn, done: false }); };
  at('boostAt', () => target.applyBoost(num('boostDur', 2.0), Q.get('boostSource') || 'pad'));
  at('starAt', () => target.startStar());
  at('spinAt', () => target.spinOut('banana'));
  at('tumbleAt', () => target.tumble('rocket'));
  at('zapAt', () => target.zap());
  at('tootAt', () => target.applyBoost(1.25, 'item'));
  at('trickAt', () => bus.emit('kart:trick', { kart: target }));
  const forceTier = num('tier', 0);

  let simTime = 0;
  let stopped = false;
  const step = () => {
    const h = FRAME_DT / SUBSTEPS;
    for (let n = 0; n < SUBSTEPS; n++) {
      for (const e of script) if (!e.done && simTime >= e.t) { e.done = true; e.fn(); }
      if (introLeft > 0) {
        introLeft -= h;
        // rev engines on the grid in the last second of the intro
        for (const k of karts) k.input.throttle = introLeft < 1.2 ? 1 : 0;
        if (introLeft <= 0) for (const k of karts) k.frozen = false;
      } else if (!closeup || num('speed', 0) > 0) {
        for (const p of pilots) p.update(h);
      } else {
        for (const k of karts) { k.input.throttle = 0; k.input.steer = 0; }
      }
      for (const k of karts) k.update(h);
      if (forceTier > 0 && target.drift.active) target.drift.tier = Math.max(target.drift.tier, Math.min(3, forceTier));
      resolveKartCollisions(karts);
      simTime += h;
    }
    for (const v of views) v.update(FRAME_DT, camera);
    effects.update(FRAME_DT, camera);
    chase.update(FRAME_DT);
    sunFollow(target.position);
  };

  let hudT = 0;
  const frame = () => {
    // fast-forward toward stopAt (full frame updates, no rendering in between)
    let guard = 0;
    if (!stopped) {
      do {
        step();
        if (simTime >= stopAt - 1e-6) {
          stopped = true;
          console.log(`[karts] stopped at t=${simTime.toFixed(3)}`);
          setTimeout(() => console.log('[karts] stats', JSON.stringify(window.__karts.stats())), 300);
          break;
        }
      } while (isFinite(stopAt) && simTime < stopAt - 0.25 && ++guard < 14);
    }
    renderer.render(scene, camera);
    stats.frames++;
    const now = performance.now();
    if (now - stats.last > 500) { stats.fps = (stats.frames * 1000) / (now - stats.last); stats.frames = 0; stats.last = now; }
    hudT -= FRAME_DT;
    if (hudT <= 0) {
      hudT = 0.25;
      const k = target, d = k.drift;
      hud.textContent = [
        `t ${simTime.toFixed(2)}${stopped ? ' (stopped)' : ''}  fps ${stats.fps.toFixed(0)}  cam ${chase.mode}`,
        `${k.character.shortName}: ${k.speed.toFixed(1)} m/s  s ${k.proj.s.toFixed(0)}  lat ${k.proj.lateral.toFixed(1)}  ${k.surface}${k.grounded ? '' : '  AIR ' + k.airTime.toFixed(2)}`,
        `drift ${d.active ? (d.dir > 0 ? 'R' : 'L') + ' tier ' + d.tier + ' ' + d.charge.toFixed(2) : '-'}  boost ${k.boostTimer.toFixed(2)}  star ${k.starTimer.toFixed(1)}${k.steerAssist ? `  assist ${k.assist.toFixed(2)}` : ''}`,
        `calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}  particles ${effects.count}`,
      ].join('\n');
    }
    requestAnimationFrame(frame);
  };
  frame();

  window.__karts = {
    scene, renderer, camera, chase, karts, views, effects, track,
    get simTime() { return simTime; },
    // draw-call breakdown (includes the shadow pass)
    stats() {
      const all = measure(() => renderer.render(scene, camera));
      const hide = scene.children.filter((o) => o.name === 'debug-track' || o.isPoints);
      hide.forEach((o) => { o.visible = false; });
      const kartsOnly = measure(() => renderer.render(scene, camera));
      sun.castShadow = false;
      const kartsNoShadow = measure(() => renderer.render(scene, camera));
      sun.castShadow = true;
      hide.forEach((o) => { o.visible = true; });
      const lods = views.map((v) => v.lod).join(',');
      return { all, kartsOnly, kartsNoShadow, lods, particles: effects.count };
    },
  };
  if (!isFinite(stopAt)) setTimeout(() => console.log('[karts] stats', JSON.stringify(window.__karts.stats())), 1500);
}

if (MODE === 'lineup') runLineup();
else if (MODE === 'portrait') runPortrait();
else if (MODE === 'closeups') runCloseups();
else if (MODE === 'parts') runParts();
else runDrive();
