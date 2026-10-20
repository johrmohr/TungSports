// The Brainrot cast for Tennis and Golf. The eight characters are built exactly
// as in Bowling (same meshes, same colours) — Tung Tung Tung Sahur, Tralalero
// Tralala, Ballerina Cappuccina, Bombardiro Crocodilo, Skibidi Toilet, Brr Brr
// Patapim, Smurf Cat and Sigma GigaChad — with floating hands like Miis, and
// carry a racket or a golf club.
//
//   const c = new Brainrot({ character: 'tung_tung', color: '#2f7bf5', hand: 'right' });
//   c.setEquipment('racket') | c.setEquipment('club', 'iron')
//   c.anim.pose = 'ready' | 'idle' | 'swing' | 'serve' | 'celebrate' | 'slump' | 'cheer'
//                 | 'address' | 'golf' | 'finish' | 'dive' | 'walk' | 'sad'
//   c.swing('fh' | 'bh' | 'oh' | 'volley' | 'smash' | 'serve', durationSeconds, contactAt)
//   c.anim.club.angle = deg                 golf: live club angle (+ backswing, − follow-through)
//   c.update(dt)                           advance and pose; c.applyPose() poses without advancing
//   c.snapshot() / c.restore(s)            for replays
//
// Local frame: the character faces −z, its right is +x, feet at y = 0.

import * as THREE from 'three';
import { DEFAULT_CHARACTER } from '../shared/protocol.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const DEG = Math.PI / 180;
export const CHAR_HEIGHT = 1.62;

// Procedural texture generators for character details (from Bowling)
// Procedural texture generators for character details
function createWoodTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#9e5922';
  ctx.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * 256;
    ctx.strokeStyle = i % 2 === 0 ? 'rgba(80,36,8,0.35)' : 'rgba(210,145,75,0.25)';
    ctx.lineWidth = 1 + Math.random() * 3;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + (Math.random() - 0.5) * 40, 180, x + (Math.random() - 0.5) * 40, 360, x + (Math.random() - 0.5) * 20, 512);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function createLatteTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  // Coffee surface
  ctx.fillStyle = '#3a1e0d';
  ctx.beginPath(); ctx.arc(128, 128, 124, 0, Math.PI * 2); ctx.fill();
  // Crema rim
  ctx.strokeStyle = '#996237'; ctx.lineWidth = 14; ctx.stroke();
  // Foam heart latte art
  ctx.fillStyle = '#f8f3eb';
  ctx.beginPath();
  ctx.moveTo(128, 175);
  ctx.bezierCurveTo(70, 130, 60, 80, 100, 75);
  ctx.bezierCurveTo(120, 72, 128, 95, 128, 105);
  ctx.bezierCurveTo(128, 95, 136, 72, 156, 75);
  ctx.bezierCurveTo(196, 80, 186, 130, 128, 175);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

function createMushroomTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d92222';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#ffffff';
  const dots = [
    [64, 64, 22], [192, 64, 20], [128, 128, 26], [64, 192, 18], [192, 192, 22],
    [128, 40, 16], [40, 128, 18], [216, 128, 16], [128, 216, 18],
  ];
  for (const [x, y, r] of dots) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  return tex;
}


export class Brainrot {
  constructor({ color = '#2f7bf5', hand = 'right', seed = 1, legs = true, character = DEFAULT_CHARACTER } = {}) {
    this.group = new THREE.Group();
    this.root = new THREE.Group();
    this.group.add(this.root);
    this.hand = hand;
    this.side = hand === 'left' ? -1 : 1;
    this.t = 0;
    this.materials = [];
    this.geometries = [];
    this.textures = [];
    this.hasLegs = legs;
    this.seed = seed;
    this.characterId = character || DEFAULT_CHARACTER;
    this.propellers = [];
    this.eyes = [];
    this.faceParts = [];
    this.legsList = [];
    this.equipment = null;      // { kind: 'racket' | 'club', club, group }
    this.anim = {
      pose: 'idle', t: 0,
      run: { speed: 0, phase: 0 },
      swing: null,              // { kind, p, dur, contact }
      club: { angle: 0, club: 'driver' },
      lean: 0, look: 0, sweat: 0,
      dive: { dir: 1, p: 0 },
      toss: 0,
    };
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._buildCharacter(color, legs);
    this.setColor(color);
  }
  _mat(color, opts = {}) {
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.rough ?? 0.55,
      metalness: opts.metal ?? 0,
      map: opts.map ?? null,
      ...opts.extra,
    });
    this.materials.push(m);
    return m;
  }

  _geo(g) {
    this.geometries.push(g);
    return g;
  }

  _buildCharacter(color, legs) {
    // Clear any previous character parts inside this.root
    while (this.root.children.length > 0) {
      this.root.remove(this.root.children[0]);
    }
    this.propellers = [];
    this.eyes = [];
    this.faceParts = [];
    this.legsList = [];

    switch (this.characterId) {
      case 'tung_tung':
        this._buildTungTung(color, legs);
        break;
      case 'tralalero':
        this._buildTralalero(color, legs);
        break;
      case 'ballerina':
        this._buildBallerina(color, legs);
        break;
      case 'bombardiro':
        this._buildBombardiro(color, legs);
        break;
      case 'skibidi':
        this._buildSkibidi(color, legs);
        break;
      case 'patapim':
        this._buildPatapim(color, legs);
        break;
      case 'smurf_cat':
        this._buildSmurfCat(color, legs);
        break;
      case 'gigachad':
        this._buildGigaChad(color, legs);
        break;
      default:
        this._buildTungTung(color, legs);
        break;
    }

    // Attach floating hands for bowling
    this._buildHands(color);
  }

  // ------------------------------------------------------------ 1. TUNG TUNG TUNG SAHUR (MAIN)
  _buildTungTung(color, legs) {
    const woodTex = createWoodTexture();
    this.textures.push(woodTex);
    const woodM = this._mat('#9e5922', { map: woodTex, rough: 0.7 });
    const darkCavityM = this._mat('#150903', { rough: 0.9 });
    const whiteM = this._mat('#ffffff', { rough: 0.35 });
    const blackM = this._mat('#111111', { rough: 0.4 });
    const goldM = this._mat('#e5a93b', { metal: 0.5, rough: 0.3 });
    const peciM = this._mat('#181818', { rough: 0.95 });
    this.bodyM = this._mat(color, { rough: 0.5 });

    // Torso: Indonesian Kentongan slit-drum (hollow wooden cylinder)
    this.torso = new THREE.Group();
    this.torso.position.y = legs ? 0.52 : 0.12;

    const drumMesh = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.24, 0.25, 0.82, 28)), woodM);
    drumMesh.position.y = 0.41;
    drumMesh.castShadow = true;
    this.torso.add(drumMesh);

    // Carved vertical slit down the center of the drum
    const slit = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.048, 0.46, 0.1)), darkCavityM);
    slit.position.set(0, 0.35, -0.21);
    this.torso.add(slit);

    // Drum decorative bands (top & bottom rims)
    for (const y of [0.06, 0.76]) {
      const ring = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.245, 0.018, 8, 24)), goldM);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      this.torso.add(ring);
    }

    // Traditional sash / belt in player color
    const sash = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.252, 0.252, 0.1, 28)), this.bodyM);
    sash.position.y = 0.22;
    this.torso.add(sash);

    // Wooden striker stick (pentungan) strapped diagonally across back
    const striker = new THREE.Group();
    striker.position.set(0, 0.45, 0.26);
    striker.rotation.z = 0.55;
    const stickMesh = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.022, 0.022, 0.55, 12)), woodM);
    const malletHead = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.052, 14, 12)), woodM);
    malletHead.position.y = 0.26;
    striker.add(stickMesh, malletHead);
    this.torso.add(striker);

    this.root.add(this.torso);

    // Head: Carved wooden face atop the drum with Songkok/Peci hat
    this.head = new THREE.Group();
    this.head.position.y = legs ? 1.40 : 0.98;
    this.root.add(this.head);

    const headBase = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.235, 0.24, 0.32, 28)), woodM);
    headBase.position.y = 0.02;
    headBase.castShadow = true;
    this.head.add(headBase);

    // Indonesian Peci / Songkok hat (velvet black with gold trim)
    const peci = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.20, 0.225, 0.16, 28)), peciM);
    peci.position.set(0, 0.22, 0.01);
    peci.scale.set(0.92, 1, 1.08);
    const peciTrim = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.222, 0.012, 8, 24)), goldM);
    peciTrim.rotation.x = Math.PI / 2;
    peciTrim.position.set(0, 0.145, 0.01);
    peciTrim.scale.set(0.92, 1.08, 1);
    this.head.add(peci, peciTrim);

    // Staring unblinking circular googly eyes
    for (const s of [-1, 1]) {
      const eyeWhite = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.05, 16, 14)), whiteM);
      eyeWhite.scale.set(1, 1, 0.65);
      eyeWhite.position.set(s * 0.088, 0.04, -0.215);
      const pupil = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.02, 10, 10)), blackM);
      pupil.position.set(s * 0.088, 0.04, -0.245);
      this.head.add(eyeWhite, pupil);
      this.eyes.push(eyeWhite);
      this.faceParts.push(eyeWhite, pupil);

      // Angled furrowed carved wooden eyebrows
      const brow = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.08, 0.018, 0.03)), woodM);
      brow.rotation.z = s * -0.25;
      brow.position.set(s * 0.088, 0.11, -0.225);
      this.head.add(brow);
      this.faceParts.push(brow);
    }

    // Carved wooden nose
    const nose = new THREE.Mesh(this._geo(new THREE.ConeGeometry(0.03, 0.065, 8)), woodM);
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, -0.01, -0.24);
    this.head.add(nose);
    this.faceParts.push(nose);

    // Wide carved menacingly joyful wooden toothy grin!
    const mouthBack = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.24, 0.075, 0.03)), darkCavityM);
    mouthBack.position.set(0, -0.08, -0.222);
    this.head.add(mouthBack);
    this.faceParts.push(mouthBack);

    // Individual wooden block teeth
    for (let i = 0; i < 6; i++) {
      const u = (i - 2.5) * 0.032;
      const toothTop = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.022, 0.024, 0.02)), whiteM);
      toothTop.position.set(u, -0.06, -0.235);
      const toothBtm = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.022, 0.022, 0.02)), whiteM);
      toothBtm.position.set(u, -0.098, -0.235);
      this.head.add(toothTop, toothBtm);
      this.faceParts.push(toothTop, toothBtm);
    }

    // Legs & large bare sculpted feet
    if (legs) {
      for (const s of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(s * 0.11, 0.54, 0);

        // Thin wooden stick leg
        const thigh = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(0.048, 0.32, 6, 12)), woodM);
        thigh.position.y = -0.21;
        thigh.castShadow = true;

        // Big bare human/wooden foot with carved toes
        const foot = new THREE.Group();
        foot.position.set(0, -0.49, -0.04);
        const sole = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.12, 0.055, 0.22)), woodM);
        sole.castShadow = true;
        foot.add(sole);
        for (let t = 0; t < 5; t++) {
          const toe = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.016, 8, 6)), woodM);
          toe.position.set((t - 2) * 0.022, -0.01, -0.11);
          foot.add(toe);
        }
        leg.add(thigh, foot);
        this.root.add(leg);
        this.legsList.push(leg);
      }
    }
  }

  // ------------------------------------------------------------ 2. TRALALERO TRALALA (WALKING SHARK IN NIKES)
  _buildTralalero(color, legs) {
    const sharkBlueM = this._mat('#1b68d4', { rough: 0.45 });
    const sharkWhiteM = this._mat('#f2f6fc', { rough: 0.4 });
    const redCapM = this._mat('#e8384f', { rough: 0.6 });
    const whiteM = this._mat('#ffffff', { rough: 0.3 });
    const blackM = this._mat('#151515', { rough: 0.3 });
    this.bodyM = this._mat(color, { rough: 0.45 });

    // Shark Torso with Dorsal Fin
    this.torso = new THREE.Group();
    this.torso.position.y = legs ? 0.5 : 0.1;

    const bodyMesh = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(0.24, 0.42, 12, 24)), sharkBlueM);
    bodyMesh.position.y = 0.4;
    bodyMesh.castShadow = true;
    this.torso.add(bodyMesh);

    // White underbelly
    const belly = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(0.22, 0.38, 10, 20)), sharkWhiteM);
    belly.scale.set(0.75, 0.95, 0.4);
    belly.position.set(0, 0.38, -0.12);
    this.torso.add(belly);

    // Large Shark Dorsal Fin on back!
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0);
    finShape.quadraticCurveTo(0.12, 0.35, -0.06, 0.45);
    finShape.quadraticCurveTo(0.04, 0.22, 0.24, 0);
    const finGeo = this._geo(new THREE.ExtrudeGeometry(finShape, { depth: 0.035, bevelEnabled: false }));
    const dorsalFin = new THREE.Mesh(finGeo, sharkBlueM);
    dorsalFin.rotation.y = Math.PI / 2;
    dorsalFin.position.set(-0.017, 0.32, 0.16);
    this.torso.add(dorsalFin);

    // Pectoral side fins
    for (const s of [-1, 1]) {
      const pec = new THREE.Mesh(this._geo(new THREE.ConeGeometry(0.08, 0.28, 4)), sharkBlueM);
      pec.rotation.set(0.6, 0, s * 1.1);
      pec.position.set(s * 0.26, 0.46, 0);
      this.torso.add(pec);
    }

    this.root.add(this.torso);

    // Shark Head with Snout & Jaws
    this.head = new THREE.Group();
    this.head.position.y = legs ? 1.34 : 0.94;
    this.root.add(this.head);

    const headMesh = new THREE.Mesh(this._geo(new THREE.ConeGeometry(0.25, 0.42, 24)), sharkBlueM);
    headMesh.rotation.x = -Math.PI / 2 + 0.3;
    headMesh.position.set(0, 0.05, -0.08);
    this.head.add(headMesh);

    // Open shark mouth with rows of white razor teeth
    const mouthCavity = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.12, 0.14, 0.12, 16)), blackM);
    mouthCavity.rotation.x = Math.PI / 2;
    mouthCavity.scale.set(1.1, 0.6, 1);
    mouthCavity.position.set(0, -0.06, -0.18);
    this.head.add(mouthCavity);
    this.faceParts.push(mouthCavity);

    // Upper and lower shark teeth
    for (let i = 0; i < 8; i++) {
      const a = (i / 7) * Math.PI - Math.PI / 2;
      const tooth = new THREE.Mesh(this._geo(new THREE.ConeGeometry(0.018, 0.035, 3)), whiteM);
      tooth.position.set(Math.sin(a) * 0.11, -0.02 + Math.cos(a) * 0.02, -0.22);
      tooth.rotation.x = Math.PI;
      this.head.add(tooth);
      this.faceParts.push(tooth);
    }

    // Eyes
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.032, 12, 10)), blackM);
      eye.position.set(s * 0.16, 0.08, -0.12);
      const glint = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.009, 6, 6)), whiteM);
      glint.position.set(s * 0.16 + 0.006, 0.09, -0.145);
      this.head.add(eye, glint);
      this.eyes.push(eye);
      this.faceParts.push(eye, glint);
    }

    // Red backwards cap
    const cap = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.24, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.5)), redCapM);
    cap.position.set(0, 0.14, 0.02);
    cap.rotation.x = -0.3;
    const visor = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 16, 1, false, 0, Math.PI)), redCapM);
    visor.rotation.x = Math.PI / 2 - 0.2;
    visor.position.set(0, 0.13, 0.22);
    this.head.add(cap, visor);

    // Legs with FRESH WHITE NIKE HIGH-TOP SNEAKERS
    if (legs) {
      for (const s of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(s * 0.11, 0.54, 0);

        const thigh = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(0.065, 0.3, 6, 12)), sharkBlueM);
        thigh.position.y = -0.21;
        thigh.castShadow = true;

        // Nike High-Top Sneaker
        const shoe = new THREE.Group();
        shoe.position.set(0, -0.48, -0.04);

        const sneakerBody = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.12, 0.12, 0.24)), whiteM);
        sneakerBody.castShadow = true;
        const sole = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.126, 0.03, 0.246)), this._mat('#333333', { rough: 0.8 }));
        sole.position.y = -0.06;

        // Nike Swoosh on the side!
        const swooshShape = new THREE.Shape();
        swooshShape.moveTo(0, 0);
        swooshShape.quadraticCurveTo(0.08, -0.04, 0.14, 0.04);
        swooshShape.quadraticCurveTo(0.06, -0.01, 0, 0);
        const swooshGeo = this._geo(new THREE.ShapeGeometry(swooshShape));
        const swoosh = new THREE.Mesh(swooshGeo, redCapM);
        swoosh.position.set(s * 0.064, 0, -0.06);
        swoosh.rotation.y = s * (Math.PI / 2);

        shoe.add(sneakerBody, sole, swoosh);
        leg.add(thigh, shoe);
        this.root.add(leg);
        this.legsList.push(leg);
      }
    }
  }

  // ------------------------------------------------------------ 3. BALLERINA CAPPUCCINA (CAPPUCCINO CUP HEAD + TUTU)
  _buildBallerina(color, legs) {
    const latteTex = createLatteTexture();
    this.textures.push(latteTex);
    const porcelainM = this._mat('#ffffff', { rough: 0.15 });
    const pinkM = this._mat('#ff77b4', { rough: 0.45 });
    const tulleM = this._mat('#ffb3d9', { rough: 0.7, extra: { transparent: true, opacity: 0.85 } });
    const goldM = this._mat('#f5c518', { metal: 0.6, rough: 0.3 });
    const coffeeM = this._mat('#3a1e0d', { map: latteTex, rough: 0.4 });
    const faceInkM = this._mat('#261710', { rough: 0.4 });
    const blushM = this._mat('#ff85a2', { rough: 0.6 });
    this.bodyM = this._mat(color, { rough: 0.5 });

    // Torso with layered Ballerina Tutu Skirt
    this.torso = new THREE.Group();
    this.torso.position.y = legs ? 0.52 : 0.12;

    const bodice = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.18, 0.15, 0.45, 24)), pinkM);
    bodice.position.y = 0.34;
    bodice.castShadow = true;
    this.torso.add(bodice);

    // Multi-layered flared Tutu skirt
    for (let layer = 0; layer < 3; layer++) {
      const r = 0.28 + layer * 0.07;
      const tutu = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(r * 0.9, r, 0.05, 28, 1, true)), tulleM);
      tutu.position.y = 0.16 + layer * 0.04;
      this.torso.add(tutu);
    }
    const belt = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.17, 0.015, 8, 24)), goldM);
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 0.28;
    this.torso.add(belt);

    this.root.add(this.torso);

    // Head: Ceramic Cappuccino Coffee Cup with Latte Art!
    this.head = new THREE.Group();
    this.head.position.y = legs ? 1.34 : 0.94;
    this.root.add(this.head);

    // Cup body
    const cupMesh = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.24, 0.16, 0.28, 28)), porcelainM);
    cupMesh.position.y = 0.05;
    cupMesh.castShadow = true;
    this.head.add(cupMesh);

    // Cup handle
    const handle = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.09, 0.024, 8, 20, Math.PI * 1.3)), porcelainM);
    handle.position.set(0.22, 0.05, 0);
    handle.rotation.z = -Math.PI / 6;
    this.head.add(handle);

    // Liquid surface inside the cup (Latte foam art)
    const latteSurface = new THREE.Mesh(this._geo(new THREE.CircleGeometry(0.225, 28)), coffeeM);
    latteSurface.rotation.x = -Math.PI / 2;
    latteSurface.position.y = 0.185;
    this.head.add(latteSurface);

    // Cute smiling face on the front of the cup
    for (const s of [-1, 1]) {
      // Curved happy eyes (^ ^)
      const eye = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.025, 0.007, 6, 12, Math.PI)), faceInkM);
      eye.position.set(s * 0.08, 0.05, -0.22);
      // Rosy blush cheeks
      const blush = new THREE.Mesh(this._geo(new THREE.CircleGeometry(0.028, 12)), blushM);
      blush.position.set(s * 0.11, -0.01, -0.215);
      this.head.add(eye, blush);
      this.faceParts.push(eye, blush);
    }
    const smile = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.035, 0.006, 6, 12, Math.PI)), faceInkM);
    smile.rotation.set(0, 0, Math.PI);
    smile.position.set(0, -0.03, -0.22);
    this.head.add(smile);
    this.faceParts.push(smile);

    // Legs with Ballet Ribbons & Pointe Shoes
    if (legs) {
      for (const s of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(s * 0.09, 0.54, 0);

        const thigh = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(0.052, 0.32, 6, 12)), pinkM);
        thigh.position.y = -0.21;
        thigh.castShadow = true;

        // Ballet slipper
        const slipper = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.08, 0.07, 0.18)), pinkM);
        slipper.position.set(0, -0.5, -0.02);
        slipper.castShadow = true;

        leg.add(thigh, slipper);
        this.root.add(leg);
        this.legsList.push(leg);
      }
    }
  }

  // ------------------------------------------------------------ 4. BOMBARDIRO CROCODILO (FLYING CROC BOMBER PLANE)
  _buildBombardiro(color, legs) {
    const crocGreenM = this._mat('#32782c', { rough: 0.6 });
    const bellyM = this._mat('#b5cf53', { rough: 0.55 });
    const armyM = this._mat('#485438', { rough: 0.7 });
    const whiteM = this._mat('#ffffff', { rough: 0.3 });
    const goldM = this._mat('#e5a93b', { metal: 0.7, rough: 0.25 });
    const blackM = this._mat('#151515', { rough: 0.4 });
    const hazardM = this._mat('#eab308', { rough: 0.5 });
    this.bodyM = this._mat(color, { rough: 0.5 });

    // Aircraft Fuselage & Wings Torso
    this.torso = new THREE.Group();
    this.torso.position.y = legs ? 0.52 : 0.12;

    const fuselage = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(0.24, 0.45, 12, 24)), armyM);
    fuselage.position.y = 0.4;
    fuselage.castShadow = true;
    this.torso.add(fuselage);

    // Aircraft Wings extending wide
    const wingL = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.65, 0.038, 0.26)), armyM);
    wingL.position.set(-0.48, 0.48, 0.02);
    const wingR = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.65, 0.038, 0.26)), armyM);
    wingR.position.set(0.48, 0.48, 0.02);
    this.torso.add(wingL, wingR);

    // Twin Wingtip Engines with SPINNING PROPELLERS!
    for (const s of [-1, 1]) {
      const engine = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.065, 0.065, 0.18, 12)), blackM);
      engine.rotation.x = Math.PI / 2;
      engine.position.set(s * 0.48, 0.48, -0.12);

      const propGroup = new THREE.Group();
      propGroup.position.set(s * 0.48, 0.48, -0.22);
      for (let b = 0; b < 3; b++) {
        const blade = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.02, 0.15, 0.005)), hazardM);
        blade.rotation.z = (b * Math.PI * 2) / 3;
        propGroup.add(blade);
      }
      this.torso.add(engine, propGroup);
      this.propellers.push(propGroup);
    }

    // Tail Rudder Stabilizer
    const rudder = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.04, 0.32, 0.22)), armyM);
    rudder.position.set(0, 0.64, 0.22);
    this.torso.add(rudder);

    this.root.add(this.torso);

    // Crocodile Head with Aviator Helmet & Goggles
    this.head = new THREE.Group();
    this.head.position.y = legs ? 1.34 : 0.94;
    this.root.add(this.head);

    const crocHead = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.22, 16, 14)), crocGreenM);
    this.head.add(crocHead);

    // Long crocodile snout
    const snout = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.24, 0.14, 0.36)), crocGreenM);
    snout.position.set(0, -0.04, -0.24);
    this.head.add(snout);

    // Interlocking crocodile teeth
    for (let i = 0; i < 6; i++) {
      const z = -0.12 - i * 0.05;
      for (const s of [-1, 1]) {
        const tooth = new THREE.Mesh(this._geo(new THREE.ConeGeometry(0.015, 0.035, 4)), whiteM);
        tooth.position.set(s * 0.118, i % 2 === 0 ? 0.02 : -0.1, z);
        tooth.rotation.x = i % 2 === 0 ? Math.PI : 0;
        this.head.add(tooth);
        this.faceParts.push(tooth);
      }
    }

    // Aviator Pilot Helmet with Goggles!
    const helmet = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.235, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55)), this._mat('#3b2314', { rough: 0.8 }));
    helmet.position.set(0, 0.04, 0);
    const strap = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.225, 0.02, 6, 20)), this._mat('#26170d', { rough: 0.8 }));
    strap.position.set(0, 0.08, -0.02);
    this.head.add(helmet, strap);

    // Aviator Goggles on forehead
    for (const s of [-1, 1]) {
      const goggleRim = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.055, 0.015, 8, 16)), goldM);
      goggleRim.position.set(s * 0.08, 0.09, -0.21);
      const lens = new THREE.Mesh(this._geo(new THREE.CircleGeometry(0.05, 14)), this._mat('#60a5fa', { metal: 0.8, rough: 0.1 }));
      lens.position.set(s * 0.08, 0.09, -0.212);
      this.head.add(goggleRim, lens);
      this.faceParts.push(goggleRim, lens);
    }

    // Legs with reptilian crocodile claws
    if (legs) {
      for (const s of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(s * 0.12, 0.54, 0);

        const thigh = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(0.075, 0.32, 6, 12)), crocGreenM);
        thigh.position.y = -0.21;
        thigh.castShadow = true;

        const clawFoot = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.14, 0.07, 0.22)), crocGreenM);
        clawFoot.position.set(0, -0.49, -0.04);
        leg.add(thigh, clawFoot);
        this.root.add(leg);
        this.legsList.push(leg);
      }
    }
  }

  // ------------------------------------------------------------ 5. SKIBIDI TOILET (PORCELAIN THRONE WITH SINGING HEAD)
  _buildSkibidi(color, legs) {
    const porcelainM = this._mat('#ffffff', { rough: 0.12, metal: 0.05 });
    const chromeM = this._mat('#cccccc', { metal: 0.9, rough: 0.15 });
    const waterM = this._mat('#38bdf8', { rough: 0.1, extra: { transparent: true, opacity: 0.8 } });
    const skinM = this._mat('#f6d0b1', { rough: 0.55 });
    const hairM = this._mat('#26180e', { rough: 0.8 });
    const blackM = this._mat('#151515', { rough: 0.3 });
    const whiteM = this._mat('#ffffff', { rough: 0.3 });
    this.bodyM = this._mat(color, { rough: 0.5 });

    // The Toilet Base & Bowl
    this.torso = new THREE.Group();
    this.torso.position.y = legs ? 0.48 : 0.1;

    // Toilet tank (cistern) at rear
    const tank = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.48, 0.52, 0.24)), porcelainM);
    tank.position.set(0, 0.5, 0.16);
    tank.castShadow = true;
    const tankLid = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.51, 0.06, 0.26)), porcelainM);
    tankLid.position.set(0, 0.78, 0.16);

    // Chrome flush handle
    const handle = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.015, 0.015, 0.08, 8)), chromeM);
    handle.rotation.z = Math.PI / 2;
    handle.position.set(-0.26, 0.7, 0.16);
    this.torso.add(tank, tankLid, handle);

    // Toilet bowl
    const bowl = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.26, 0.18, 0.42, 24)), porcelainM);
    bowl.position.set(0, 0.3, -0.08);
    bowl.castShadow = true;
    const water = new THREE.Mesh(this._geo(new THREE.CircleGeometry(0.24, 24)), waterM);
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, 0.45, -0.08);

    // Upright toilet seat & lid behind head
    const seat = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.24, 0.03, 8, 24)), porcelainM);
    seat.position.set(0, 0.65, 0.04);
    seat.rotation.x = 0.25;
    this.torso.add(bowl, water, seat);

    this.root.add(this.torso);

    // Human Head POPPING OUT OF THE TOILET BOWL!
    this.head = new THREE.Group();
    this.head.position.set(0, legs ? 1.28 : 0.88, -0.06);
    this.root.add(this.head);

    const headMesh = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.23, 24, 20)), skinM);
    headMesh.scale.set(0.95, 1.05, 0.95);
    this.head.add(headMesh);

    // Hair
    const hair = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.24, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.5)), hairM);
    hair.position.set(0, 0.06, 0);
    hair.rotation.x = 0.3;
    this.head.add(hair);

    // Manic staring eyes
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.038, 12, 10)), whiteM);
      eye.position.set(s * 0.08, 0.04, -0.215);
      const pupil = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.016, 8, 8)), blackM);
      pupil.position.set(s * 0.08, 0.04, -0.245);
      this.head.add(eye, pupil);
      this.eyes.push(eye);
      this.faceParts.push(eye, pupil);
    }

    // Wide open singing mouth
    const mouth = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.05, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.6)), blackM);
    mouth.rotation.x = Math.PI;
    mouth.position.set(0, -0.07, -0.21);
    this.head.add(mouth);
    this.faceParts.push(mouth);

    // Toilet pedestal legs
    if (legs) {
      for (const s of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(s * 0.12, 0.48, 0);
        const pipe = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.055, 0.065, 0.42, 12)), porcelainM);
        pipe.position.y = -0.22;
        pipe.castShadow = true;
        leg.add(pipe);
        this.root.add(leg);
        this.legsList.push(leg);
      }
    }
  }

  // ------------------------------------------------------------ 6. BRR BRR PATAPIM (LONG-NOSED WOODS ANOMALY)
  _buildPatapim(color, legs) {
    const mossM = this._mat('#52793b', { rough: 0.85 });
    const woodM = this._mat('#85542b', { rough: 0.8 });
    const leafM = this._mat('#84cc16', { rough: 0.5 });
    const whiteM = this._mat('#ffffff', { rough: 0.3 });
    const blackM = this._mat('#151515', { rough: 0.3 });
    this.bodyM = this._mat(color, { rough: 0.6 });

    this.torso = new THREE.Group();
    this.torso.position.y = legs ? 0.52 : 0.12;

    const bodyMesh = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.28, 20, 16)), mossM);
    bodyMesh.scale.set(0.9, 1.25, 0.9);
    bodyMesh.position.y = 0.38;
    bodyMesh.castShadow = true;
    this.torso.add(bodyMesh);

    // Leafy vine belt
    const vine = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.24, 0.025, 8, 24)), leafM);
    vine.rotation.x = Math.PI / 2;
    vine.position.y = 0.28;
    this.torso.add(vine);

    this.root.add(this.torso);

    this.head = new THREE.Group();
    this.head.position.y = legs ? 1.34 : 0.94;
    this.root.add(this.head);

    const headMesh = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.22, 16, 14)), mossM);
    this.head.add(headMesh);

    // COLOSSAL CURVED PINOCCHIO-STYLE NOSE EXTENDING FORWARD!
    const noseCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, -0.18),
      new THREE.Vector3(0, -0.04, -0.42),
      new THREE.Vector3(0, -0.15, -0.62),
    ]);
    const noseGeo = this._geo(new THREE.TubeGeometry(noseCurve, 20, 0.038, 10, false));
    const nose = new THREE.Mesh(noseGeo, woodM);
    this.head.add(nose);
    this.faceParts.push(nose);

    // Sprouting leaf at the tip of the nose!
    const sprout = new THREE.Mesh(this._geo(new THREE.ConeGeometry(0.03, 0.08, 4)), leafM);
    sprout.rotation.x = -1.2;
    sprout.position.set(0, -0.16, -0.65);
    this.head.add(sprout);

    // Huge inquisitive googly eyes
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.045, 14, 12)), whiteM);
      eye.position.set(s * 0.09, 0.07, -0.19);
      const pupil = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.018, 8, 8)), blackM);
      pupil.position.set(s * 0.09, 0.07, -0.23);
      this.head.add(eye, pupil);
      this.eyes.push(eye);
      this.faceParts.push(eye, pupil);

      // Sprouting leaf ears
      const ear = new THREE.Mesh(this._geo(new THREE.ConeGeometry(0.045, 0.14, 5)), leafM);
      ear.rotation.z = s * -1.2;
      ear.position.set(s * 0.24, 0.08, 0);
      this.head.add(ear);
    }

    if (legs) {
      for (const s of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(s * 0.11, 0.54, 0);

        const thigh = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(0.06, 0.32, 6, 12)), woodM);
        thigh.position.y = -0.21;
        thigh.castShadow = true;

        const foot = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.12, 0.06, 0.22)), woodM);
        foot.position.set(0, -0.49, -0.03);
        leg.add(thigh, foot);
        this.root.add(leg);
        this.legsList.push(leg);
      }
    }
  }

  // ------------------------------------------------------------ 7. SMURF CAT / SHAILUSHAI (MUSHROOM CAT)
  _buildSmurfCat(color, legs) {
    const smurfBlueM = this._mat('#38bdf8', { rough: 0.5 });
    const mushroomTex = createMushroomTexture();
    this.textures.push(mushroomTex);
    const shroomCapM = this._mat('#d92222', { map: mushroomTex, rough: 0.4 });
    const shroomBtmM = this._mat('#f5f5f4', { rough: 0.6 });
    const whiteM = this._mat('#ffffff', { rough: 0.3 });
    const blackM = this._mat('#151515', { rough: 0.3 });
    const pinkM = this._mat('#fb7185', { rough: 0.5 });
    this.bodyM = this._mat(color, { rough: 0.5 });

    this.torso = new THREE.Group();
    this.torso.position.y = legs ? 0.5 : 0.1;

    const bodyMesh = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(0.21, 0.4, 12, 20)), smurfBlueM);
    bodyMesh.position.y = 0.38;
    bodyMesh.castShadow = true;
    this.torso.add(bodyMesh);

    // Snail shell / traveler backpack
    const shell = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.14, 0.065, 8, 20)), this._mat('#854d0e', { rough: 0.7 }));
    shell.position.set(0, 0.42, 0.22);
    this.torso.add(shell);

    // Cat tail swishing in the back
    const tail = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(0.025, 0.35, 6, 12)), smurfBlueM);
    tail.rotation.x = -0.8;
    tail.position.set(0, 0.2, 0.26);
    this.torso.add(tail);

    this.root.add(this.torso);

    this.head = new THREE.Group();
    this.head.position.y = legs ? 1.34 : 0.94;
    this.root.add(this.head);

    const headMesh = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.22, 18, 16)), smurfBlueM);
    this.head.add(headMesh);

    // Pointed cat ears
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(this._geo(new THREE.ConeGeometry(0.065, 0.12, 4)), smurfBlueM);
      ear.rotation.z = s * -0.4;
      ear.position.set(s * 0.15, 0.22, 0);
      const innerEar = new THREE.Mesh(this._geo(new THREE.ConeGeometry(0.045, 0.09, 4)), pinkM);
      innerEar.rotation.z = s * -0.4;
      innerEar.position.set(s * 0.15, 0.22, -0.02);
      this.head.add(ear, innerEar);
    }

    // GIANT RED-AND-WHITE POLKA DOT MUSHROOM CAP HAT!
    const shroomCap = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.36, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.48)), shroomCapM);
    shroomCap.position.set(0, 0.25, 0);
    const shroomBtm = new THREE.Mesh(this._geo(new THREE.CircleGeometry(0.35, 24)), shroomBtmM);
    shroomBtm.rotation.x = Math.PI / 2;
    shroomBtm.position.set(0, 0.25, 0);
    this.head.add(shroomCap, shroomBtm);

    // Soulful cat eyes
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.045, 12, 10)), blackM);
      eye.position.set(s * 0.08, 0.04, -0.21);
      const glint = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.015, 6, 6)), whiteM);
      glint.position.set(s * 0.08 + 0.012, 0.06, -0.24);
      this.head.add(eye, glint);
      this.eyes.push(eye);
      this.faceParts.push(eye, glint);
    }
    const nose = new THREE.Mesh(this._geo(new THREE.ConeGeometry(0.02, 0.025, 3)), pinkM);
    nose.rotation.x = Math.PI;
    nose.position.set(0, -0.01, -0.225);
    this.head.add(nose);
    this.faceParts.push(nose);

    if (legs) {
      for (const s of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(s * 0.1, 0.54, 0);

        const thigh = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(0.055, 0.32, 6, 12)), smurfBlueM);
        thigh.position.y = -0.21;
        thigh.castShadow = true;

        const paw = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.075, 10, 8)), smurfBlueM);
        paw.scale.set(1, 0.6, 1.3);
        paw.position.set(0, -0.49, -0.03);
        leg.add(thigh, paw);
        this.root.add(leg);
        this.legsList.push(leg);
      }
    }
  }

  // ------------------------------------------------------------ 8. SIGMA GIGACHAD (CHISELED JAW & SUNGLASSES)
  _buildGigaChad(color, legs) {
    const skinM = this._mat('#e8b997', { rough: 0.5 });
    const hairM = this._mat('#181412', { rough: 0.7 });
    const blackSuitM = this._mat('#121214', { rough: 0.6 });
    const goldM = this._mat('#f5c518', { metal: 0.85, rough: 0.2 });
    const shadesM = this._mat('#050505', { metal: 0.9, rough: 0.1 });
    const whiteM = this._mat('#ffffff', { rough: 0.3 });
    this.bodyM = this._mat(color, { rough: 0.5 });

    // Muscular V-taper Turtleneck Torso
    this.torso = new THREE.Group();
    this.torso.position.y = legs ? 0.52 : 0.12;

    const chest = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.28, 0.20, 0.52, 16)), blackSuitM);
    chest.position.y = 0.38;
    chest.castShadow = true;
    this.torso.add(chest);

    // Thick Chunky Gold Chain Necklace
    const chain = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.18, 0.024, 8, 20)), goldM);
    chain.rotation.x = Math.PI / 2.3;
    chain.position.set(0, 0.55, -0.04);
    this.torso.add(chain);

    this.root.add(this.torso);

    // Head with Granite-Carved Jawline
    this.head = new THREE.Group();
    this.head.position.y = legs ? 1.38 : 0.98;
    this.root.add(this.head);

    const headMesh = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.32, 0.38, 0.32)), skinM);
    this.head.add(headMesh);

    // Impossibly sharp chin & jaw corners
    const jaw = new THREE.Mesh(this._geo(new THREE.ConeGeometry(0.18, 0.18, 4)), skinM);
    jaw.rotation.y = Math.PI / 4;
    jaw.position.set(0, -0.22, -0.06);
    this.head.add(jaw);

    // Stubble / Beard along the jaw
    const beard = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.33, 0.14, 0.33)), hairM);
    beard.position.set(0, -0.14, 0);
    this.head.add(beard);

    // Sigma Pompadour Hair
    const hair = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.34, 0.16, 0.34)), hairM);
    hair.position.set(0, 0.22, 0);
    this.head.add(hair);

    // Sleek Dark Aviator Sunglasses
    const glassesBridge = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.36, 0.08, 0.04)), shadesM);
    glassesBridge.position.set(0, 0.05, -0.18);
    this.head.add(glassesBridge);
    this.faceParts.push(glassesBridge);

    if (legs) {
      for (const s of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(s * 0.11, 0.54, 0);

        const thigh = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(0.072, 0.32, 6, 12)), blackSuitM);
        thigh.position.y = -0.21;
        thigh.castShadow = true;

        const dressShoe = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.11, 0.06, 0.24)), blackSuitM);
        dressShoe.position.set(0, -0.49, -0.04);
        leg.add(thigh, dressShoe);
        this.root.add(leg);
        this.legsList.push(leg);
      }
    }
  }

  // ------------------------------------------------------------ FLOATING HANDS
  _buildHands(color) {
    const handG = this._geo(new THREE.SphereGeometry(0.076, 18, 14));
    this.handM = this._mat('#ffffff', { rough: 0.45 });
    this.ballHand = new THREE.Mesh(handG, this.handM);
    this.offHand = new THREE.Mesh(handG, this.handM);
    this.ballHand.castShadow = this.offHand.castShadow = true;
    this.root.add(this.ballHand, this.offHand);
    this.sweatDrops = [];
    const dropM = this._mat('#9fd8ff', { rough: 0.1, extra: { transparent: true, opacity: 0.85 } });
    for (let i = 0; i < 3; i++) {
      const d = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.03, 8, 6)), dropM);
      d.scale.set(0.7, 1.2, 0.7);
      d.visible = false;
      this.root.add(d);
      this.sweatDrops.push(d);
    }
    void color;
    if (this.equipment) this.setEquipment(this.equipment.kind, this.equipment.club, true);
  }

  // ------------------------------------------------------------ equipment

  _racket() {
    const g = new THREE.Group();
    const gripM = this._mat('#2b2d38', { rough: 0.8 });
    this.racketFrameM = this._mat(this.color || '#2f7bf5', { rough: 0.35, metal: 0.2 });
    const whiteM = this._mat('#f4f6f9', { rough: 0.4 });
    const handle = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.018, 0.016, 0.22, 10)), gripM);
    handle.position.y = 0.05;
    const throatL = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.009, 0.009, 0.14, 6)), this.racketFrameM);
    throatL.position.set(-0.035, 0.22, 0); throatL.rotation.z = 0.32;
    const throatR = throatL.clone(); throatR.position.x = 0.035; throatR.rotation.z = -0.32;
    const frame = new THREE.Mesh(this._geo(new THREE.TorusGeometry(0.12, 0.012, 8, 32)), this.racketFrameM);
    frame.scale.set(1, 1.28, 1);
    frame.position.y = 0.43;
    frame.castShadow = true;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 64, 64);
    x.strokeStyle = 'rgba(255,255,255,0.85)';
    x.lineWidth = 1.2;
    for (let i = 4; i < 64; i += 6) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 64); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(64, i); x.stroke(); }
    const tex = new THREE.CanvasTexture(c);
    this.textures.push(tex);
    const stringsM = this._mat('#ffffff', { rough: 0.6, extra: { map: tex, transparent: true, alphaTest: 0.2, side: THREE.DoubleSide } });
    const strings = new THREE.Mesh(this._geo(new THREE.CircleGeometry(0.118, 24)), stringsM);
    strings.scale.set(1, 1.28, 1);
    strings.position.y = 0.43;
    const cap = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.02, 0.02, 0.02, 10)), whiteM);
    cap.position.y = -0.065;
    g.add(handle, throatL, throatR, frame, strings, cap);
    g.userData.headY = 0.43;
    return g;
  }

  _club(kind) {
    const g = new THREE.Group();
    const L = CLUB_LEN[kind] || 0.78;
    const shaftM = this._mat('#c9ced6', { rough: 0.25, metal: 0.8 });
    const gripM = this._mat('#24262e', { rough: 0.85 });
    const shaft = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.0065, 0.0055, L, 8)), shaftM);
    shaft.position.y = -L / 2;
    const grip = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.014, 0.011, 0.24, 10)), gripM);
    grip.position.y = -0.1;
    g.add(shaft, grip);
    let head;
    if (kind === 'driver') {
      const m = this._mat('#1b2236', { rough: 0.3, metal: 0.6 });
      head = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.05, 18, 12)), m);
      head.scale.set(0.75, 0.7, 1.25);
      head.position.set(0.012, -L - 0.005, -0.045);
      const face = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.004, 0.045, 0.085)), this._mat('#d8dde5', { rough: 0.2, metal: 0.9 }));
      face.position.set(-0.026, -L - 0.005, -0.045);
      g.add(face);
    } else if (kind === 'putter') {
      const m = this._mat('#d8dde5', { rough: 0.2, metal: 0.9 });
      head = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.03, 0.026, 0.11)), m);
      head.position.set(0.004, -L + 0.004, -0.04);
    } else {
      const m = this._mat('#dfe3ea', { rough: 0.22, metal: 0.9 });
      head = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.016, 0.052, 0.085)), m);
      head.rotation.z = kind === 'wedge' ? 0.85 : 0.4;          // loft
      head.position.set(0.006, -L + 0.01, -0.04);
    }
    head.castShadow = true;
    g.add(head);
    g.userData.len = L;
    return g;
  }

  // kind: 'racket' | 'club' | null; club: 'driver' | 'iron' | 'wedge' | 'putter'
  setEquipment(kind, club = 'driver', rebuild = false) {
    if (!rebuild && this.equipment && this.equipment.kind === kind && this.equipment.club === club) return;
    if (this.equipment?.group) this.root.remove(this.equipment.group);
    this.equipment = null;
    if (!kind) return;
    const group = kind === 'racket' ? this._racket() : this._club(club);
    if (this.side < 0 && kind === 'club') group.scale.x = -1;
    this.root.add(group);
    this.equipment = { kind, club, group };
    this.anim.club.club = club;
    this.applyPose();
  }

  setCharacter(characterId) {
    if (this.characterId === characterId) return;
    this.characterId = characterId;
    this._buildCharacter(this.color || '#2f7bf5', this.hasLegs);
    this.setColor(this.color || '#2f7bf5');
    this.applyPose();
  }

  setColor(hex) {
    this.color = hex;
    if (this.bodyM) this.bodyM.color.set(hex);
    if (this.handM) this.handM.color.set(hex).lerp(new THREE.Color('#ffffff'), 0.72);
    if (this.racketFrameM) this.racketFrameM.color.set(hex);
  }

  setHand(hand) {
    const side = hand === 'left' ? -1 : 1;
    if (side === this.side) return;
    this.hand = hand;
    this.side = side;
    if (this.equipment) this.setEquipment(this.equipment.kind, this.equipment.club, true);
  }

  // ------------------------------------------------------------ animation control

  setPose(pose) {
    if (this.anim.pose === pose) return;
    this.anim.pose = pose;
    this.anim.t = 0;
    if (pose !== 'swing' && pose !== 'serve') this.anim.swing = null;
  }

  // Starts a racket swing lasting `dur` s with the contact at fraction `contact`.
  swing(kind, dur = 0.5, contact = 0.42) {
    this.anim.swing = { kind, p: 0, dur: Math.max(0.15, dur), contact };
    this.anim.pose = kind === 'serve' ? 'serve' : 'swing';
    this.anim.t = 0;
  }

  get swinging() { return !!this.anim.swing && this.anim.swing.p < 1; }

  update(dt) {
    this.t += dt;
    const a = this.anim;
    a.t += dt;
    a.run.phase += dt * clamp(a.run.speed, 0, 8) * 2.1;
    if (a.swing) {
      a.swing.p = Math.min(1, a.swing.p + dt / a.swing.dur);
      if (a.swing.p >= 1 && (a.pose === 'swing' || a.pose === 'serve')) { a.swing = null; a.pose = 'ready'; a.t = 0; }
    }
    if (a.pose === 'dive') a.dive.p = Math.min(1, a.dive.p + dt * 3.2);
    for (const prop of this.propellers) prop.rotation.z += dt * (a.run.speed > 0.5 || a.swing ? 30 : 10);
    this.applyPose();
  }

  snapshot() {
    const a = this.anim;
    return {
      pose: a.pose, t: a.t, rs: a.run.speed, rp: a.run.phase, lean: a.lean, look: a.look, sweat: a.sweat, toss: a.toss,
      sw: a.swing ? { kind: a.swing.kind, p: a.swing.p, dur: a.swing.dur, contact: a.swing.contact } : null,
      ca: a.club.angle, dv: { dir: a.dive.dir, p: a.dive.p },
    };
  }

  restore(s) {
    const a = this.anim;
    a.pose = s.pose; a.t = s.t; a.run.speed = s.rs; a.run.phase = s.rp; a.lean = s.lean; a.look = s.look; a.sweat = s.sweat; a.toss = s.toss;
    a.swing = s.sw ? { ...s.sw } : null;
    a.club.angle = s.ca;
    a.dive.dir = s.dv.dir; a.dive.p = s.dv.p;
    this.applyPose();
  }

  // ------------------------------------------------------------ posing

  applyPose() {
    const a = this.anim;
    const S = this.side;
    const hand = this.ballHand.position;
    const off = this.offHand.position;
    const shY = this.hasLegs ? 1.0 : 0.6;
    let bob = 0, crouch = 0, lean = a.lean || 0, tiltZ = 0, yaw = 0, headTilt = 0, torsoYaw = 0;
    let legMode = 'stand';
    const runK = clamp(a.run.speed / 6, 0, 1);
    const eq = this.equipment;
    let racket = null;                // { pos, shaft: [x,y,z], face: [x,y,z] }

    switch (a.pose) {
      case 'ready':
      case 'idle':
      case 'walk': {
        const ready = a.pose === 'ready';
        crouch = ready ? 0.07 : 0;
        lean += ready ? 0.12 : 0;
        if (eq?.kind === 'racket') {
          hand.set(S * 0.2, shY - 0.06 + Math.sin(this.t * 3) * 0.008, -0.36);
          off.set(-S * 0.02, shY - 0.02, -0.42);
          racket = { pos: hand, shaft: [S * 0.2, 0.8, -0.55], face: [S * 0.9, 0, 0.1] };
        } else if (eq?.kind === 'club' && a.pose !== 'walk') {
          hand.set(S * 0.27, shY - 0.22, -0.06);
          off.set(-S * 0.27, shY - 0.22 + Math.sin(this.t * 1.7 + 1) * 0.012, -0.04);
        } else {
          hand.set(S * 0.27, shY - 0.22 + Math.sin(this.t * 1.7) * 0.012, -0.04);
          off.set(-S * 0.27, shY - 0.22 + Math.sin(this.t * 1.7 + 1) * 0.012, -0.04);
        }
        bob = Math.sin(this.t * 2.2) * 0.008;
        if (runK > 0.05) {
          legMode = 'run';
          bob = Math.abs(Math.sin(a.run.phase * Math.PI)) * 0.05 * runK;
          lean += 0.12 * runK;
          if (!eq || eq.kind !== 'racket') {
            hand.z = -0.04 + Math.sin(a.run.phase * Math.PI) * 0.18 * runK;
            off.z = -0.04 - Math.sin(a.run.phase * Math.PI) * 0.18 * runK;
          }
        }
        if (a.pose === 'walk') { legMode = 'run'; bob = Math.abs(Math.sin(a.run.phase * Math.PI)) * 0.03; }
        break;
      }
      case 'swing':
      case 'serve': {
        const sw = a.swing;
        if (!sw) break;
        crouch = 0.05;
        lean += 0.1;
        if (runK > 0.05) legMode = 'run';
        const res = this._racketSwing(sw, S, shY);
        hand.copy(res.hand);
        off.copy(res.off);
        racket = res.racket;
        torsoYaw = res.torso;
        bob = res.lift;
        if (sw.kind === 'serve' || sw.kind === 'smash' || sw.kind === 'oh') lean -= 0.12;
        break;
      }
      case 'dive': {
        const p = smooth(0, 1, a.dive.p);
        tiltZ = -a.dive.dir * 1.15 * p;
        crouch = 0.35 * p;
        hand.set(a.dive.dir * 0.75, shY + 0.05, -0.3);
        off.set(-a.dive.dir * 0.2, shY - 0.1, -0.2);
        racket = { pos: hand, shaft: [a.dive.dir, 0.25, -0.4], face: [0, 0.2, -1] };
        legMode = 'split';
        break;
      }
      case 'celebrate': {
        const j = Math.abs(Math.sin(a.t * 6)) * 0.22;
        bob = j;
        hand.set(S * 0.33, shY + 0.6 + Math.sin(a.t * 12) * 0.05, -0.05);
        off.set(-S * 0.33, shY + 0.6 + Math.cos(a.t * 12) * 0.05, -0.05);
        racket = { pos: hand, shaft: [S * 0.3, 1, 0], face: [0, 0, -1] };
        headTilt = -0.15;
        break;
      }
      case 'cheer': {
        const ph = a.t * 7 + (this.seed % 7);
        bob = Math.max(0, Math.sin(ph)) * 0.16;
        hand.set(S * 0.3, shY + 0.45 + Math.sin(ph * 2) * 0.06, -0.05);
        off.set(-S * 0.3, shY + 0.45 + Math.cos(ph * 2) * 0.06, -0.05);
        racket = { pos: hand, shaft: [S * 0.2, 1, 0], face: [0, 0, -1] };
        break;
      }
      case 'slump':
      case 'sad': {
        hand.set(S * 0.24, shY - 0.4, -0.05);
        off.set(-S * 0.24, shY - 0.4, -0.05);
        racket = { pos: hand, shaft: [S * 0.1, -1, -0.2], face: [S, 0, 0] };
        headTilt = 0.4;
        bob = -0.04;
        break;
      }
      case 'address':
      case 'golf':
      case 'finish': {
        const ang = a.pose === 'finish' ? lerp(a.club.angle, -165, smooth(0, 0.6, a.t)) : a.club.angle;
        const res = this._golfPose(ang, S);
        hand.copy(res.hand);
        off.copy(res.off);
        torsoYaw = res.torso;
        crouch = res.crouch;
        lean += res.lean;
        legMode = a.pose === 'finish' && a.t > 0.2 ? 'finish' : 'golf';
        if (eq?.kind === 'club') this._placeClub(res.grip, res.dir, S);
        break;
      }
      default: {
        hand.set(S * 0.27, shY - 0.22, -0.04);
        off.set(-S * 0.27, shY - 0.22, -0.04);
      }
    }

    if (eq?.kind === 'racket') {
      if (!racket) racket = { pos: hand, shaft: [S * 0.15, -1, -0.2], face: [S, 0, 0] };
      this._placeRacket(racket);
    } else if (eq?.kind === 'club' && !['address', 'golf', 'finish'].includes(a.pose)) {
      // Carried in the hand, head down.
      this._placeClub(hand.clone(), new THREE.Vector3(S * 0.15, -1, -0.25).normalize(), S);
    }

    this.root.position.y = bob - crouch;
    this.root.rotation.set(-lean, yaw, tiltZ);
    if (this.torso) this.torso.rotation.y = torsoYaw;
    if (this.head) { this.head.rotation.x = headTilt + lean * 0.3; this.head.rotation.y = torsoYaw * 0.6 + (a.look || 0); }

    // Legs.
    for (let i = 0; i < this.legsList.length; i++) {
      const leg = this.legsList[i];
      const s = i === 0 ? 1 : -1;
      leg.rotation.set(0, 0, 0);
      if (legMode === 'run') leg.rotation.x = Math.sin(a.run.phase * Math.PI) * 0.65 * s * Math.max(0.35, runK);
      else if (legMode === 'split') { leg.rotation.z = s * 0.45; leg.rotation.x = 0.2; }
      else if (legMode === 'golf') leg.rotation.z = s * 0.12;
      else if (legMode === 'finish') { leg.rotation.z = s * 0.1; if ((s > 0) !== (S > 0)) leg.rotation.x = 0.5; }
      else if (crouch > 0.03) leg.rotation.z = s * 0.08;
    }

    // Blink, sweat.
    const blink = (this.t % 3.7) < 0.12 ? 0.15 : 1;
    for (const e of this.eyes) e.scale.y = blink;
    const sw = a.sweat || 0;
    this.sweatDrops?.forEach((d, i) => {
      d.visible = sw > 0.4;
      if (!d.visible) return;
      const ph = (this.t * 1.3 + i * 0.37) % 1;
      d.position.set((i - 1) * 0.18, (this.head?.position.y || 1.4) + 0.25 - ph * 0.35, -0.12);
      d.material.opacity = 0.9 * (1 - ph);
    });
  }

  // Racket swing keyframes (right-handed frame, mirrored by S).
  _racketSwing(sw, S, shY) {
    const p = sw.p;
    const kind = sw.kind;
    const out = { hand: new THREE.Vector3(), off: new THREE.Vector3(), racket: null, torso: 0, lift: 0 };
    const key = (frames) => {
      // frames: [[p, ...values]]; smooth piecewise interpolation.
      let k = frames.length - 2;
      for (let i = 0; i < frames.length - 1; i++) if (p <= frames[i + 1][0]) { k = i; break; }
      const [p0, ...v0] = frames[k];
      const [p1, ...v1] = frames[k + 1];
      const u = smooth(p0, p1, p);
      return v0.map((v, j) => lerp(v, v1[j], u));
    };
    const pc = sw.contact;
    if (kind === 'fh' || kind === 'bh') {
      const back = kind === 'bh';
      const m = back ? -S : S;                     // which side the racket travels on
      // [p, arcDeg, radius, height, shaftOffsetDeg, pitchDeg]
      const [ang, r, h, so, pitch] = key([
        [0, 35, 0.42, -0.06, 50, 30],
        [pc * 0.72, 150, 0.6, 0.06, 45, 30],
        [pc, 45, 0.7, -0.1, 55, 8],
        [pc + 0.22, -70, 0.5, 0.32, 75, 45],
        [1, 25, 0.42, -0.06, 50, 30],
      ]);
      const ar = ang * DEG;
      const px = S * 0.12;
      out.hand.set(px + m * Math.sin(ar) * r, shY + h, -Math.cos(ar) * r);
      const sy = (ang + so) * DEG;
      const cp = Math.cos(pitch * DEG);
      const shaft = [m * Math.sin(sy) * cp, Math.sin(pitch * DEG), -Math.cos(sy) * cp];
      const fy = sy - Math.PI / 2;
      const face = [m * Math.sin(fy), 0.1, -Math.cos(fy)];
      out.racket = { pos: out.hand, shaft, face };
      // The off hand helps on the backhand and balances on the forehand.
      if (back && p < pc + 0.05) out.off.copy(out.hand).add(new THREE.Vector3(S * 0.05, 0.03, 0.05));
      else out.off.set(-m * 0.3, shY - 0.05, -0.3 + (p < pc ? 0 : 0.2));
      out.torso = -m * (ang - 45) * 0.006;
    } else if (kind === 'volley') {
      const [x, y, z] = key([
        [0, 0.22, -0.05, -0.36],
        [pc * 0.7, 0.5, 0.06, -0.12],
        [pc, 0.46, 0.02, -0.58],
        [pc + 0.25, 0.4, 0.02, -0.5],
        [1, 0.22, -0.05, -0.36],
      ]);
      out.hand.set(S * x, shY + y, z);
      out.off.set(-S * 0.18, shY - 0.02, -0.32);
      out.racket = { pos: out.hand, shaft: [S * 0.7, 0.7, -0.15], face: [0, 0.05, -1] };
    } else {
      // Overhead: serve, smash and overheads ('oh').
      const [x, y, z, sx, sy, sz] = key([
        [0, 0.28, 0.05, -0.28, 0.3, 0.6, -0.6],
        [pc * 0.75, 0.32, 0.52, 0.28, 0.1, -1, 0.35],
        [pc, 0.24, 1.12, -0.3, 0.05, 1, -0.35],
        [pc + 0.25, -0.22, 0.02, -0.38, -0.3, -1, -0.4],
        [1, 0.28, 0.05, -0.28, 0.3, 0.6, -0.6],
      ]);
      out.hand.set(S * x, shY + y, z);
      const shaft = [S * sx, sy, sz];
      out.racket = { pos: out.hand, shaft, face: [0, 0.2, -1] };
      // Serve: the other hand tosses the ball.
      if (kind === 'serve' && p < pc) {
        const tossUp = smooth(0, pc * 0.6, p);
        out.off.set(-S * 0.15, shY + 0.0 + tossUp * 0.85, -0.3);
      } else out.off.set(-S * 0.3, shY - 0.05, -0.25);
      if (kind === 'smash') out.lift = Math.sin(Math.min(1, p / (pc + 0.2)) * Math.PI) * 0.22;
      out.torso = S * (p < pc ? 0.35 * smooth(0, pc * 0.75, p) : 0.35 - 0.8 * smooth(pc, pc + 0.25, p));
    }
    return out;
  }

  _placeRacket(r) {
    const g = this.equipment.group;
    const Y = new THREE.Vector3(...r.shaft).normalize();
    const Z = new THREE.Vector3(...r.face);
    Z.addScaledVector(Y, -Z.dot(Y)).normalize();
    if (Z.lengthSq() < 1e-6) Z.set(0, 0, 1);
    const X = new THREE.Vector3().crossVectors(Y, Z);
    this._m.makeBasis(X, Y, Z);
    g.quaternion.setFromRotationMatrix(this._m);
    g.position.copy(r.pos);
  }

  // Golf: hands on an arc in a tilted swing plane; the club hinges at the wrists.
  _golfPose(angDeg, S) {
    const club = this.anim.club.club || 'driver';
    const putt = club === 'putter';
    const C = new THREE.Vector3(0, putt ? 1.04 : 1.08, -0.02);
    const vH = new THREE.Vector3(0, -1, putt ? -0.32 : -0.45).normalize();
    const u = new THREE.Vector3(S, 0, 0);
    const rH = putt ? 0.5 : 0.5;
    const th = angDeg * DEG;
    const hands = C.clone().addScaledVector(vH, rH * Math.cos(th)).addScaledVector(u, rH * Math.sin(th));
    const hinge = putt ? 0 : (angDeg > 0 ? Math.min(75, angDeg * 0.5) : Math.max(-55, angDeg * 0.35)) * DEG;
    const d0 = golfAddressDir(club);
    const axis = new THREE.Vector3().crossVectors(d0, u).normalize();
    const dir = d0.clone().applyAxisAngle(axis, th + hinge);
    const off = hands.clone().addScaledVector(dir, -0.085);
    const torso = -S * clamp(angDeg * 0.42, -75, 80) * DEG;
    return { hand: hands, off, grip: hands, dir, torso, crouch: putt ? 0.05 : 0.07, lean: putt ? 0.32 : 0.28 };
  }

  _placeClub(grip, dir, S) {
    const g = this.equipment.group;
    const Y = dir.clone().negate();                         // up the shaft
    // Face normal at address looks at the target (−x for a right-hander);
    // keep it perpendicular to the shaft as the club swings round.
    const tgt = new THREE.Vector3(-S, 0, 0);
    const X = tgt.clone().negate().addScaledVector(Y, tgt.dot(Y)).normalize();
    if (X.lengthSq() < 1e-6) X.set(1, 0, 0);
    const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
    this._m.makeBasis(X.multiplyScalar(S), Y, Z);
    g.quaternion.setFromRotationMatrix(this._m);
    g.scale.set(S < 0 ? -1 : 1, 1, 1);
    g.position.copy(grip);
  }

  // Where the ball sits (local frame) at address for the current club.
  ballLocal(club = this.anim.club.club) {
    const putt = club === 'putter';
    const C = new THREE.Vector3(0, putt ? 1.04 : 1.08, -0.02);
    const vH = new THREE.Vector3(0, -1, putt ? -0.32 : -0.45).normalize();
    const hands = C.addScaledVector(vH, 0.5);
    const p = hands.addScaledVector(golfAddressDir(club), CLUB_LEN[club] || 0.78);
    p.x = 0;
    p.y = 0;
    return p;
  }

  // World position of the racket's sweet spot / the clubhead.
  racketHeadWorld(out) {
    const g = this.equipment?.group;
    if (!g) return this.handWorld(out);
    g.updateWorldMatrix(true, false);
    return out.set(0, 0.43, 0).applyMatrix4(g.matrixWorld);
  }

  clubHeadWorld(out) {
    const g = this.equipment?.group;
    if (!g) return this.handWorld(out);
    g.updateWorldMatrix(true, false);
    return out.set(0, -(g.userData.len || 0.78), -0.04).applyMatrix4(g.matrixWorld);
  }

  handWorld(out) {
    this.ballHand.updateWorldMatrix(true, false);
    return out.set(0, 0, 0).applyMatrix4(this.ballHand.matrixWorld);
  }

  offHandWorld(out) {
    this.offHand.updateWorldMatrix(true, false);
    return out.set(0, 0, 0).applyMatrix4(this.offHand.matrixWorld);
  }

  dispose() {
    this.group.parent?.remove(this.group);
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}

const CLUB_LEN = { driver: 0.8, iron: 0.74, wedge: 0.71, putter: 0.66 };

// Shaft direction (hands → clubhead) at address, in the golfer's frame.
function golfAddressDir(club) {
  if (club === 'putter') return new THREE.Vector3(0, -0.88, -0.47).normalize();
  if (club === 'driver') return new THREE.Vector3(0, -0.77, -0.64).normalize();
  return new THREE.Vector3(0, -0.8, -0.6).normalize();
}
