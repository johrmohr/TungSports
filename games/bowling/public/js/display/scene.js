// The bowling alley: our lane (with a mirror-glossy surface), six neighbouring
// lanes, gutters, gold lane dividers, pin decks, mint masking units with a
// star emblem, the pinsetter, ball returns, the seating area and lights.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DIM, PIN_PROFILE, pinSpot } from '../shared/physics.js';
import { laneWood, approachWood, pinTexture, ballTexture, emblemTexture, carpetTexture, ceilingTexture, blobShadow, signTexture, rng } from './textures.js';

export const LANE_PITCH = 1.65;
export const LANES = [-3, -2, -1, 0, 1, 2, 3];
const APPROACH_LEN = 5.4;
const SEATS_Z0 = APPROACH_LEN;
const SEATS_Z1 = APPROACH_LEN + 6;
const PIT_LEN = 1.1;

// Pin geometry: the USBC lathe profile resampled evenly in height so the
// texture's v coordinate is linear in height.
export function pinGeometry() {
  const H = DIM.pinHeight;
  const pts = [];
  const N = 48;
  const radiusAt = (h) => {
    for (let i = 1; i < PIN_PROFILE.length; i++) {
      const [h1, r1] = PIN_PROFILE[i];
      const [h0, r0] = PIN_PROFILE[i - 1];
      if (h <= h1) return r0 + (r1 - r0) * ((h - h0) / Math.max(1e-6, h1 - h0));
    }
    return 0;
  };
  for (let i = 0; i <= N; i++) {
    const h = (i / N) * H;
    pts.push(new THREE.Vector2(Math.max(i === 0 || i === N ? 0.0005 : 0.0005, radiusAt(h)), h));
  }
  pts[0].x = 0.0001;
  pts.splice(1, 0, new THREE.Vector2(radiusAt(0), 0.0004));
  const g = new THREE.LatheGeometry(pts, 28);
  g.computeVertexNormals();
  return g;
}

export class Alley {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#2a2118');
    this.scene.fog = new THREE.Fog('#3a2d1f', 30, 60);
    this.ballMats = new Map();
    this.ballGeo = new THREE.SphereGeometry(DIM.ballRadius, 40, 28);
    this.pinGeo = pinGeometry();
    this.pinMat = new THREE.MeshPhysicalMaterial({
      map: pinTexture({ total: DIM.pinHeight, bandLow: 0.236, bandHigh: 0.272 }),
      roughness: 0.22, clearcoat: 0.8, clearcoatRoughness: 0.15,
    });
    this._lights();
    this._floorAndRoom();
    this._lanes();
    this._mainLane();
    this._pinsetter();
    this._ballReturns();
    this._seating();
    this._aimGuide();
    this._blobs();
  }

  // ------------------------------------------------------------ lighting

  _lights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight('#fff3dc', '#7d6a4c', 1.15));
    const key = new THREE.DirectionalLight('#fff1d6', 1.6);
    key.position.set(2.5, 9, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const c = key.shadow.camera;
    c.left = -2.4; c.right = 2.4; c.top = 2.4; c.bottom = -2.4; c.near = 1; c.far = 30;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    s.add(key, key.target);
    this.key = key;
    // Bright pin deck (the pins glow under the masking unit lights).
    // Under the masking unit's lip, aimed at the pins (not at the panel).
    const deckLight = new THREE.SpotLight('#fff6e6', 9, 6, 0.75, 0.55, 1.4);
    deckLight.position.set(0, 0.82, DIM.headPinZ + 0.42);
    deckLight.target.position.set(0, 0, DIM.headPinZ - 0.55);
    s.add(deckLight, deckLight.target);
    const fill = new THREE.PointLight('#ffe7c2', 6, 14, 1.6);
    fill.position.set(0, 3.2, 2.5);
    s.add(fill);
  }

  // Shadow camera follows the action.
  focusShadow(x, z) {
    this.key.target.position.set(x, 0, z);
    this.key.position.set(x + 2.5, 9, z + 3);
  }

  // ------------------------------------------------------------ room

  _floorAndRoom() {
    const s = this.scene;
    const width = LANE_PITCH * LANES.length + 3;
    // Approach: light wood across every lane.
    const apTex = approachWood();
    apTex.repeat.set(LANES.length + 1, APPROACH_LEN / 1.0);
    const approach = new THREE.Mesh(new THREE.PlaneGeometry(width, APPROACH_LEN),
      new THREE.MeshStandardMaterial({ map: apTex, roughness: 0.38 }));
    approach.rotation.x = -Math.PI / 2;
    approach.position.set(0, 0, APPROACH_LEN / 2);
    approach.receiveShadow = true;
    s.add(approach);
    // Seating area carpet (a little lower than the approach).
    const carpet = new THREE.Mesh(new THREE.PlaneGeometry(width, SEATS_Z1 - SEATS_Z0),
      new THREE.MeshStandardMaterial({ map: carpetTexture(), roughness: 0.95 }));
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.set(0, -0.12, (SEATS_Z0 + SEATS_Z1) / 2);
    carpet.receiveShadow = true;
    s.add(carpet);
    // Step edge between the approach and the seating area.
    const step = new THREE.Mesh(new THREE.BoxGeometry(width, 0.12, 0.08), new THREE.MeshStandardMaterial({ color: '#b08b55', roughness: 0.5 }));
    step.position.set(0, -0.06, SEATS_Z0);
    s.add(step);
    // Ceiling with soft light pools.
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(width + 4, 40),
      new THREE.MeshStandardMaterial({ map: ceilingTexture(), emissive: '#8a6a3c', emissiveIntensity: 0.9, roughness: 0.9 }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, 4.8, -8);
    s.add(ceil);
    // Side walls.
    const wallM = new THREE.MeshStandardMaterial({ color: '#e8cf9e', roughness: 0.85, emissive: '#3d2f1a', emissiveIntensity: 0.4 });
    for (const sx of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 5), wallM);
      wall.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
      wall.position.set(sx * (width / 2 + 0.6), 2.4, -8);
      s.add(wall);
    }
    // Back wall behind the seats, with a sign.
    const back = new THREE.Mesh(new THREE.PlaneGeometry(width + 2, 5), new THREE.MeshStandardMaterial({ color: '#e7c98f', roughness: 0.9 }));
    back.position.set(0, 2.4, SEATS_Z1 + 0.6);
    back.rotation.y = Math.PI;
    s.add(back);
    // Dark wall above / behind the pin area.
    const pitWall = new THREE.Mesh(new THREE.PlaneGeometry(width + 2, 6), new THREE.MeshStandardMaterial({ color: '#1e1914', roughness: 1 }));
    pitWall.position.set(0, 2.5, DIM.deckEndZ - PIT_LEN - 0.05);
    s.add(pitWall);
    // Sign above the masking units.
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.15), new THREE.MeshBasicMaterial({ map: signTexture('Bowling'), transparent: true }));
    sign.position.set(0, 3.95, DIM.headPinZ + 0.3);
    s.add(sign);
    // Fascia band across the top of the masking units.
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(width + 1, 0.9, 0.2), new THREE.MeshStandardMaterial({ color: '#f0e4c4', roughness: 0.6 }));
    fascia.position.set(0, 2.95, DIM.headPinZ + 0.15);
    s.add(fascia);
  }

  // ------------------------------------------------------------ lanes

  _lanes() {
    const s = this.scene;
    const laneLen = -DIM.deckEndZ;
    const woodTex = laneWood();
    woodTex.repeat.set(1, laneLen / 1.6);
    const otherWood = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.2, metalness: 0.0 });
    const gutterM = new THREE.MeshStandardMaterial({ color: '#6a573d', roughness: 0.45, metalness: 0.15, side: THREE.DoubleSide });
    const capM = new THREE.MeshStandardMaterial({ color: '#d6c25a', roughness: 0.3, metalness: 0.45 });
    const capEndM = new THREE.MeshStandardMaterial({ color: '#e8e8e8', roughness: 0.25, metalness: 0.6 });
    const kickM = new THREE.MeshStandardMaterial({ color: '#4a3524', roughness: 0.7 });
    const pitM = new THREE.MeshStandardMaterial({ color: '#141210', roughness: 1 });
    const mintM = new THREE.MeshStandardMaterial({ color: '#d4ead7', roughness: 0.55 });
    const darkM = new THREE.MeshStandardMaterial({ color: '#1b1815', roughness: 1 });
    const emblem = new THREE.MeshBasicMaterial({ map: emblemTexture(), transparent: true });
    const markM = new THREE.MeshStandardMaterial({ color: '#3b2b1c', roughness: 0.5 });
    const spotM = new THREE.MeshStandardMaterial({ color: '#b66b33', roughness: 0.5 });

    // Gutter profile: a shallow arc (9.25 in wide, 1.9 in deep) extruded down the lane.
    const gw = DIM.gutterWidth / 2, gd = DIM.gutterDepth;
    const R = (gw * gw + gd * gd) / (2 * gd);
    const shape = new THREE.Shape();
    const seg = 14;
    const ang = Math.asin(gw / R);
    for (let i = 0; i <= seg; i++) {
      const a = -ang + (2 * ang * i) / seg;
      const x = Math.sin(a) * R, y = R - Math.cos(a) * R - gd;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    for (let i = seg; i >= 0; i--) {
      const a = -ang + (2 * ang * i) / seg;
      shape.lineTo(Math.sin(a) * (R + 0.012), R - Math.cos(a) * (R + 0.012) - gd);
    }
    const gutterLen = laneLen + 0.2;
    const gutterGeo = new THREE.ExtrudeGeometry(shape, { depth: gutterLen, bevelEnabled: false, steps: 1 });
    gutterGeo.translate(0, 0, -gutterLen + 0.1);

    const markGeos = [];
    const spotGeos = [];
    const otherPinMatrices = [];
    this.otherPinIndex = new Map();     // "lane:pin" → instance index (background bowlers knock them over)
    for (const li of LANES) {
      const x0 = li * LANE_PITCH;
      // Lane surface (ours is built separately with a reflection).
      if (li !== 0) {
        const lane = new THREE.Mesh(new THREE.PlaneGeometry(DIM.laneHalfWidth * 2, laneLen), otherWood);
        lane.rotation.x = -Math.PI / 2;
        lane.position.set(x0, 0.0005, -laneLen / 2);
        lane.receiveShadow = true;
        s.add(lane);
      }
      // Gutters.
      for (const side of [-1, 1]) {
        const gm = new THREE.Mesh(gutterGeo, gutterM);
        gm.position.set(x0 + side * (DIM.laneHalfWidth + gw), 0, 0);
        gm.receiveShadow = true;
        s.add(gm);
      }
      // Markings: foul line, guide dots at 7 ft, arrows at 12–16 ft, pin spots.
      markGeos.push(new THREE.PlaneGeometry(DIM.laneHalfWidth * 2, 0.022).rotateX(-Math.PI / 2).translate(x0, 0.002, -0.011));
      for (const b of [3, 5, 8, 11, 14, 26, 29, 32, 35, 37]) {
        const bx = x0 - DIM.laneHalfWidth + (b - 0.5) * DIM.boardWidth;
        markGeos.push(new THREE.CircleGeometry(0.012, 10).rotateX(-Math.PI / 2).translate(bx, 0.002, -DIM.dotsAt));
      }
      for (const b of [5, 10, 15, 20, 25, 30, 35]) {
        const bx = x0 - DIM.laneHalfWidth + (b - 0.5) * DIM.boardWidth;
        const dz = 16 * 0.3048 - Math.abs(b - 20) / 5 * 0.2;
        const tri = new THREE.BufferGeometry();
        const w = 0.016, l = 0.15;
        tri.setAttribute('position', new THREE.Float32BufferAttribute([bx - w, 0, -dz + l, bx + w, 0, -dz + l, bx, 0, -dz], 3));
        tri.setIndex([0, 1, 2]);
        tri.computeVertexNormals();
        markGeos.push(tri.translate(0, 0.002, 0));
      }
      for (let n = 1; n <= 10; n++) {
        const p = pinSpot(n);
        spotGeos.push(new THREE.CircleGeometry(0.045, 18).rotateX(-Math.PI / 2).translate(x0 + p.x, 0.0015, p.z));
      }
      // Kickbacks beside the pin deck.
      for (const side of [-1, 1]) {
        const kb = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.55, 1.4), kickM);
        kb.position.set(x0 + side * (DIM.gutterOuter + 0.025), 0.22, DIM.headPinZ - 0.35);
        s.add(kb);
      }
      // Pit.
      const pit = new THREE.Mesh(new THREE.BoxGeometry(LANE_PITCH, 0.02, PIT_LEN), pitM);
      pit.position.set(x0, -0.36, DIM.deckEndZ - PIT_LEN / 2);
      s.add(pit);
      const curtain = new THREE.Mesh(new THREE.PlaneGeometry(LANE_PITCH, 1.2), pitM);
      curtain.position.set(x0, 0.24, DIM.deckEndZ - PIT_LEN + 0.05);
      s.add(curtain);
      // Masking unit: mint panel + emblem, dark machinery behind.
      const mask = new THREE.Mesh(new THREE.BoxGeometry(LANE_PITCH - 0.02, 1.62, 0.08), mintM);
      mask.position.set(x0, 1.69, DIM.headPinZ + 0.32);
      s.add(mask);
      const emb = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), emblem);
      emb.position.set(x0, 1.72, DIM.headPinZ + 0.365);
      s.add(emb);
      const inside = new THREE.Mesh(new THREE.BoxGeometry(LANE_PITCH, 1.7, 1.5), darkM);
      inside.position.set(x0, 1.73, DIM.headPinZ - 0.5);
      s.add(inside);
      // Lane number tag.
      const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.2), new THREE.MeshBasicMaterial({ map: numberTag(li + 4) }));
      tag.position.set(x0 + 0.62, 1.05, DIM.headPinZ + 0.365);
      s.add(tag);
      // Other lanes keep a full set of pins.
      if (li !== 0) {
        for (let n = 1; n <= 10; n++) {
          const p = pinSpot(n);
          this.otherPinIndex.set(`${li}:${n}`, otherPinMatrices.length);
          otherPinMatrices.push(new THREE.Matrix4().makeRotationY(n * 1.3).setPosition(x0 + p.x, 0, p.z));
        }
      }
    }
    // Dividers ("capping") between lanes: gold rounded strips with silver end caps.
    for (let k = 0; k <= LANES.length; k++) {
      const xc = (LANES[0] - 0.5 + k) * LANE_PITCH;
      const len = laneLen + 0.1;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, len, 14, 1, false), capM);
      cap.rotation.x = Math.PI / 2;
      cap.scale.set(1, 1, 0.42);
      cap.position.set(xc, 0.0, -len / 2);
      s.add(cap);
      const base = new THREE.Mesh(new THREE.BoxGeometry(LANE_PITCH - DIM.gutterOuter * 2 + 0.02, 0.02, len), capM);
      base.position.set(xc, -0.012, -len / 2);
      s.add(base);
      const end = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 10), capEndM);
      end.scale.set(1, 0.5, 1.4);
      end.position.set(xc, 0.0, 0.02);
      s.add(end);
    }
    // Markings only need positions + normals (the arrow triangles have no UVs).
    for (const g of markGeos) g.deleteAttribute('uv');
    const marks = new THREE.Mesh(mergeGeometries(markGeos), markM);
    s.add(marks);
    const spots = new THREE.Mesh(mergeGeometries(spotGeos), spotM);
    s.add(spots);
    const pinsInst = new THREE.InstancedMesh(this.pinGeo, this.pinMat, otherPinMatrices.length);
    otherPinMatrices.forEach((m, i) => pinsInst.setMatrixAt(i, m));
    pinsInst.castShadow = true;
    pinsInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    s.add(pinsInst);
    this.otherPins = pinsInst;
    // Approach dots across every lane.
    const dotGeos = [];
    for (const li of LANES) {
      const x0 = li * LANE_PITCH;
      for (const dz of [0.15, 0.95, 1.9, 3.05, 3.65, 4.55]) {
        for (const b of [3, 5, 8, 11, 14, 20, 26, 29, 32, 35, 37]) {
          if ((dz === 0.95 || dz === 3.65) && b !== 20 && (b % 3 !== 2)) continue;
          dotGeos.push(new THREE.CircleGeometry(0.011, 8).rotateX(-Math.PI / 2).translate(x0 - DIM.laneHalfWidth + (b - 0.5) * DIM.boardWidth, 0.002, dz));
        }
      }
    }
    s.add(new THREE.Mesh(mergeGeometries(dotGeos), markM));
  }

  // Our lane: a planar mirror under a translucent varnished-wood surface.
  _mainLane() {
    const laneLen = -DIM.deckEndZ;
    const w = DIM.laneHalfWidth * 2;
    const dpr = this.renderer.getPixelRatio();
    this.lowQuality = new URLSearchParams(location.search).get('quality') === 'low';
    this.reflector = new Reflector(new THREE.PlaneGeometry(w, laneLen), {
      textureWidth: Math.round(window.innerWidth * dpr * (this.lowQuality ? 0.3 : 0.5)),
      textureHeight: Math.round(window.innerHeight * dpr * (this.lowQuality ? 0.3 : 0.5)),
      color: 0x8a8a8a,
      clipBias: 0.003,
    });
    this.reflector.rotation.x = -Math.PI / 2;
    this.reflector.position.set(0, -0.002, -laneLen / 2);
    this.scene.add(this.reflector);
    const woodTex = laneWood({ seed: 3 });
    woodTex.repeat.set(1, laneLen / 1.6);
    this.laneMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.18, transparent: true, opacity: 0.8 });
    const lane = new THREE.Mesh(new THREE.PlaneGeometry(w, laneLen), this.laneMat);
    lane.rotation.x = -Math.PI / 2;
    lane.position.set(0, 0.0005, -laneLen / 2);
    lane.receiveShadow = true;
    this.scene.add(lane);
  }

  resize(w, h) {
    const dpr = this.renderer.getPixelRatio();
    const k = this.lowQuality ? 0.3 : 0.5;
    this.reflector?.getRenderTarget().setSize(Math.round(w * dpr * k), Math.round(h * dpr * k));
  }

  // The mirror pass costs a whole extra scene render: only run it when the
  // lane is in the shot.
  setReflection(on) {
    if (on === this._reflectOn) return;
    this._reflectOn = on;
    if (this.reflector) this.reflector.visible = on;
    if (this.laneMat) {
      this.laneMat.opacity = on ? 0.8 : 1;
      this.laneMat.transparent = on;
      this.laneMat.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ pinsetter

  _pinsetter() {
    const m = new THREE.MeshStandardMaterial({ color: '#5c5f63', roughness: 0.5, metalness: 0.5 });
    const stripe = new THREE.MeshStandardMaterial({ color: '#e7c12f', roughness: 0.5 });
    // Sweep bar: drops in front of the pins and rakes the dead wood into the pit.
    this.sweep = new THREE.Group();
    const bar = new THREE.Mesh(new THREE.BoxGeometry(DIM.gutterOuter * 2 - 0.04, 0.16, 0.04), m);
    const band = new THREE.Mesh(new THREE.BoxGeometry(DIM.gutterOuter * 2 - 0.05, 0.04, 0.045), stripe);
    band.position.y = 0.03;
    for (const sx of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 1.1), m);
      arm.position.set(sx * (DIM.gutterOuter - 0.04), 0.06, -0.55);
      this.sweep.add(arm);
    }
    this.sweep.add(bar, band);
    this.sweepHome = new THREE.Vector3(0, 1.25, DIM.headPinZ + 0.24);
    this.sweep.position.copy(this.sweepHome);
    this.scene.add(this.sweep);
    // Setting table: a plate that comes down over the pins.
    this.table = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 1.0), new THREE.MeshStandardMaterial({ color: '#3d4045', roughness: 0.6, metalness: 0.4 }));
    this.tableHome = new THREE.Vector3(0, 1.45, DIM.headPinZ - 0.4);
    this.table.position.copy(this.tableHome);
    this.scene.add(this.table);
  }

  // ------------------------------------------------------------ ball returns & seating

  ballMaterial(hex) {
    let m = this.ballMats.get(hex);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({ map: ballTexture(hex, hex.length * 7 + parseInt(hex.slice(1, 3), 16)), roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, metalness: 0.05 });
      this.ballMats.set(hex, m);
    }
    return m;
  }

  makeBall(hex) {
    const b = new THREE.Mesh(this.ballGeo, this.ballMaterial(hex));
    b.castShadow = true;
    return b;
  }

  _ballReturns() {
    const hoodM = new THREE.MeshStandardMaterial({ color: '#ecebe6', roughness: 0.35 });
    const mouthM = new THREE.MeshStandardMaterial({ color: '#343331', roughness: 0.8 });
    const railM = new THREE.MeshStandardMaterial({ color: '#c9c9c4', roughness: 0.3, metalness: 0.6 });
    this.returnRacks = [];
    // On the divider lines between lane pairs; ours is on our lane's left.
    for (const x of [-0.5 * LANE_PITCH, -2.5 * LANE_PITCH, 1.5 * LANE_PITCH]) {
      const g = new THREE.Group();
      g.position.set(x, 0, 3.3);
      const hood = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), hoodM);
      hood.scale.set(0.9, 1.15, 1.5);
      hood.position.set(0, 0.0, -0.1);
      const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.13, 20), mouthM);
      mouth.position.set(0, 0.14, 0.27);
      mouth.rotation.x = -0.35;
      const rack = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.035, 1.1), railM);
      rack.position.set(0, 0.24, 0.85);
      for (const sx of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.1, 8), railM);
        rail.rotation.x = Math.PI / 2;
        rail.position.set(sx * 0.1, 0.3, 0.85);
        g.add(rail);
      }
      g.add(hood, mouth, rack);
      this.scene.add(g);
      this.returnRacks.push(g);
    }
    this.rackBalls = new THREE.Group();
    this.scene.add(this.rackBalls);
  }

  // Shows each player's ball on the return rack next to our lane.
  setRackBalls(colors) {
    this.rackBalls.clear();
    colors.forEach((hex, i) => {
      const b = this.makeBall(hex);
      b.position.set(-0.5 * LANE_PITCH, 0.26 + DIM.ballRadius, 3.3 + 0.45 + i * 0.23);
      this.rackBalls.add(b);
    });
  }

  _seating() {
    const s = this.scene;
    const chairM = new THREE.MeshStandardMaterial({ color: '#fbf2ce', roughness: 0.4 });
    const tableM = new THREE.MeshStandardMaterial({ color: '#eeefe5', roughness: 0.4 });
    const stripeM = new THREE.MeshStandardMaterial({ color: '#92b4ab', roughness: 0.5 });
    const legM = new THREE.MeshStandardMaterial({ color: '#9a9a96', roughness: 0.4, metalness: 0.6 });
    this.seats = [];
    const chairGeo = new THREE.SphereGeometry(0.33, 18, 12, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55);
    for (const li of LANES) {
      const x0 = li * LANE_PITCH;
      // Two back-to-back rows of bucket chairs facing the lanes + a table.
      for (const row of [0, 1]) {
        for (const k of [-1, 1]) {
          const chair = new THREE.Mesh(chairGeo, chairM);
          const z = SEATS_Z0 + 1.0 + row * 1.6;
          chair.position.set(x0 + k * 0.42, 0.28, z);
          chair.rotation.x = Math.PI;
          chair.scale.set(1, 0.9, 1);
          s.add(chair);
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.3, 8), legM);
          post.position.set(x0 + k * 0.42, 0.0, z);
          s.add(post);
          this.seats.push({ x: x0 + k * 0.42, z, lane: li });
        }
      }
      const table = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.05, 24), tableM);
      table.position.set(x0, 0.62, SEATS_Z0 + 1.8);
      const tstripe = new THREE.Mesh(new THREE.CylinderGeometry(0.355, 0.355, 0.02, 24), stripeM);
      tstripe.position.set(x0, 0.6, SEATS_Z0 + 1.8);
      const tleg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.62, 8), legM);
      tleg.position.set(x0, 0.27, SEATS_Z0 + 1.8);
      s.add(table, tstripe, tleg);
    }
    // Ball racks along the back wall.
    const r = rng(77);
    const rackM = new THREE.MeshStandardMaterial({ color: '#8b6a45', roughness: 0.6 });
    const colors = ['#2f7bf5', '#e8384f', '#2fb45a', '#f5c518', '#8a4ff0', '#ff8a1f', '#ff5fb0', '#2b2d38', '#3aa6c0'];
    const ballGeo = new THREE.SphereGeometry(0.1, 16, 12);
    for (let k = -2; k <= 2; k++) {
      const rack = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.4), rackM);
      rack.position.set(k * 2.3, 0.75, SEATS_Z1 + 0.3);
      s.add(rack);
      for (let i = 0; i < 7; i++) {
        const b = new THREE.Mesh(ballGeo, new THREE.MeshStandardMaterial({ color: colors[Math.floor(r() * colors.length)], roughness: 0.2 }));
        b.position.set(k * 2.3 - 0.66 + i * 0.22, 0.88, SEATS_Z1 + 0.3);
        s.add(b);
      }
    }
  }

  // ------------------------------------------------------------ aim guide

  _aimGuide() {
    this.guide = new THREE.Group();
    const dotM = new THREE.MeshBasicMaterial({ color: '#e3502e', transparent: true, opacity: 0.9, depthWrite: false });
    this.guideDots = [];
    const dotGeo = new THREE.PlaneGeometry(0.035, 0.22).rotateX(-Math.PI / 2);
    for (let i = 0; i < 16; i++) {
      const d = new THREE.Mesh(dotGeo, dotM);
      this.guide.add(d);
      this.guideDots.push(d);
    }
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, -0.18);
    arrowShape.lineTo(0.09, 0.02);
    arrowShape.lineTo(0.035, 0.02);
    arrowShape.lineTo(0.035, 0.14);
    arrowShape.lineTo(-0.035, 0.14);
    arrowShape.lineTo(-0.035, 0.02);
    arrowShape.lineTo(-0.09, 0.02);
    arrowShape.closePath();
    this.guideArrow = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape).rotateX(-Math.PI / 2), dotM);
    this.guide.add(this.guideArrow);
    this.scene.add(this.guide);
  }

  // Dots from the ball start along the aim direction, clipped at the gutters.
  setGuide(visible, x0, z0, angleRad) {
    this.guide.visible = visible;
    if (!visible) return;
    const dx = Math.sin(angleRad), dz = -Math.cos(angleRad);
    this.guideArrow.position.set(x0, 0.006, z0 - 0.15);
    this.guideArrow.rotation.y = -angleRad;
    this.guideDots.forEach((d, i) => {
      const t = 0.55 + i * 0.6;
      const x = x0 + dx * t, z = z0 + dz * t;
      d.position.set(x, 0.006, z);
      d.rotation.y = -angleRad;
      d.visible = z > 0.1 || Math.abs(x) < DIM.laneHalfWidth;
    });
  }

  // ------------------------------------------------------------ blob shadows

  _blobs() {
    const t = blobShadow();
    this.blobMat = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0.8 });
    this.blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  }

  makeBlob(size) {
    const m = new THREE.Mesh(this.blobGeo, this.blobMat);
    m.scale.set(size, 1, size);
    m.renderOrder = 1;
    this.scene.add(m);
    return m;
  }

  makePinMesh() {
    const m = new THREE.Mesh(this.pinGeo, this.pinMat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }
}

function numberTag(n) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.roundRect(4, 4, 120, 88, 18);
  g.fill();
  g.fillStyle = '#d9483a';
  g.font = '800 64px "M PLUS Rounded 1c", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 64, 52);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
