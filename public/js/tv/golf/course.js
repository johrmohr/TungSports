// 3D scene for one golf hole, built from the shared hole data (the physics
// and the picture use the same heights and surfaces): the terrain, its painted
// surface map, water, trees, out-of-bounds stakes, tee markers, the flag, sky.
import * as THREE from 'three';
import { treeShape, CUP_R } from '../../shared/golf-physics.js';

const SURF_COLORS = {
  tee: [124, 196, 92], fairway: [116, 190, 84], green: [138, 214, 104], fringe: [104, 176, 76],
  rough: [66, 136, 58], sand: [236, 214, 160], water: [52, 120, 170], ob: [58, 120, 54],
};
const SURF_IDS = ['tee', 'fairway', 'rough', 'sand', 'green', 'fringe', 'water', 'ob'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

function canvasTex(w, h, draw, { repeat = null, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}

// Classifies every pixel of the surface map. 8×8 blocks whose corners and
// centre agree are filled at once; only blocks on an edge are done per pixel.
export function surfaceMap(hole, mpp) {
  const { x0, x1, z0, z1 } = hole.extent;
  const W = Math.ceil((x1 - x0) / mpp), H = Math.ceil((z1 - z0) / mpp);
  const ids = new Uint8Array(W * H);
  const B = 8;
  const gx = Math.ceil(W / B) + 1, gz = Math.ceil(H / B) + 1;
  const grid = new Uint8Array(gx * gz);
  const cls = (px, pz) => SURF_IDS.indexOf(hole.surfaceAt(x0 + (px + 0.5) * mpp, z0 + (pz + 0.5) * mpp));
  for (let j = 0; j < gz; j++) for (let i = 0; i < gx; i++) grid[j * gx + i] = cls(Math.min(W - 1, i * B), Math.min(H - 1, j * B));
  for (let j = 0; j < gz - 1; j++) {
    for (let i = 0; i < gx - 1; i++) {
      const a = grid[j * gx + i], b = grid[j * gx + i + 1], c = grid[(j + 1) * gx + i], d = grid[(j + 1) * gx + i + 1];
      const pxs = Math.min(W, (i + 1) * B), pzs = Math.min(H, (j + 1) * B);
      let same = a === b && a === c && a === d;
      if (same) same = cls(Math.min(W - 1, i * B + B / 2), Math.min(H - 1, j * B + B / 2)) === a;
      for (let pz = j * B; pz < pzs; pz++) {
        for (let px = i * B; px < pxs; px++) ids[pz * W + px] = same ? a : cls(px, pz);
      }
    }
  }
  return { ids, W, H, mpp };
}

export class CourseScene {
  constructor(hole, { low = false } = {}) {
    this.hole = hole;
    this.low = low;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog('#cfe6f7', 220, 900);
    this.disposables = [];
    this._sky();
    this._lights();
    this.map = surfaceMap(hole, low ? 0.9 : 0.55);
    this._terrain();
    this._water();
    this._trees();
    this._stakes();
    this._tee();
    this._flag();
    this._scenery();
    this._balls();
    this._aim();
    this._grid();
  }

  _track(...xs) { for (const x of xs) this.disposables.push(x); return xs[0]; }

  _sky() {
    const tex = this._track(canvasTex(16, 512, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, '#2f86de'); grd.addColorStop(0.42, '#78bdf2'); grd.addColorStop(0.6, '#d3ecfb'); grd.addColorStop(1, '#eef8ff');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }));
    const sky = new THREE.Mesh(this._track(new THREE.SphereGeometry(1400, 24, 16)), this._track(new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })));
    this.scene.add(sky);
    this.sky = sky;
    const cloudTex = this._track(canvasTex(128, 64, (g) => {
      const blob = (x, y, r) => { const grd = g.createRadialGradient(x, y, 0, x, y, r); grd.addColorStop(0, 'rgba(255,255,255,0.95)'); grd.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
      blob(40, 38, 26); blob(64, 30, 30); blob(90, 38, 24); blob(64, 44, 22);
    }));
    const r = rng(this.hole.seed + 3);
    for (let i = 0; i < 18; i++) {
      const sp = new THREE.Sprite(this._track(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.7 + r() * 0.25, fog: false, depthWrite: false })));
      const a = r() * Math.PI * 2, d = 700 + r() * 300;
      sp.position.set(Math.cos(a) * d, 160 + r() * 140, Math.sin(a) * d - 200);
      sp.scale.set(220 + r() * 160, 90 + r() * 50, 1);
      this.scene.add(sp);
    }
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight('#e8f5ff', '#4f7a3e', 1.1));
    const sun = new THREE.DirectionalLight('#fff3dc', 2.1);
    sun.position.set(-60, 120, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -45; c.right = 45; c.top = 45; c.bottom = -45; c.near = 10; c.far = 400;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.05;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this.sunOffset = new THREE.Vector3(-60, 120, 40);
  }

  // Keep the shadow map around what the camera looks at.
  focusShadow(x, z) {
    this.sun.position.set(x + this.sunOffset.x, this.sunOffset.y, z + this.sunOffset.z);
    this.sun.target.position.set(x, 0, z);
  }

  _terrain() {
    const hole = this.hole;
    const { x0, x1, z0, z1 } = hole.extent;
    const step = this.low ? 2.5 : 1.6;
    const nx = Math.ceil((x1 - x0) / step), nz = Math.ceil((z1 - z0) / step);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
    const uv = new Float32Array((nx + 1) * (nz + 1) * 2);
    let k = 0, u = 0;
    for (let j = 0; j <= nz; j++) {
      const z = z0 + (j / nz) * (z1 - z0);
      for (let i = 0; i <= nx; i++) {
        const x = x0 + (i / nx) * (x1 - x0);
        pos[k++] = x; pos[k++] = hole.heightAt(x, z); pos[k++] = z;
        uv[u++] = i / nx; uv[u++] = 1 - j / nz;
      }
    }
    const idx = new Uint32Array(nx * nz * 6);
    let q = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    this._track(geo);
    // The surface map: colours per class, mown stripes, grain.
    const { ids, W, H, mpp } = this.map;
    const tex = this._track(canvasTex(W, H, (g) => {
      const img = g.createImageData(W, H);
      const d = img.data;
      const r = rng(hole.seed + 11);
      for (let pz = 0; pz < H; pz++) {
        const wz = z0 + (pz + 0.5) * mpp;
        for (let px = 0; px < W; px++) {
          const s = SURF_IDS[ids[pz * W + px]];
          const c = SURF_COLORS[s];
          let k2 = 1;
          const wx = x0 + (px + 0.5) * mpp;
          if (s === 'fairway' || s === 'tee') k2 = (Math.floor((wz + 2000) / 7) % 2 === 0) ? 1.07 : 0.95;
          else if (s === 'green') k2 = (Math.floor((wx + wz + 2000) / 2.4) % 2 === 0) ? 1.04 : 0.97;
          else if (s === 'rough' || s === 'ob') k2 = 0.92 + r() * 0.14;
          else if (s === 'sand') k2 = 0.95 + r() * 0.08;
          k2 *= 0.97 + r() * 0.06;
          const o = (pz * W + px) * 4;
          d[o] = Math.min(255, c[0] * k2); d[o + 1] = Math.min(255, c[1] * k2); d[o + 2] = Math.min(255, c[2] * k2); d[o + 3] = 255;
        }
      }
      // Soft edges: a cheap blur pass along both axes for the colour transitions.
      g.putImageData(img, 0, 0);
      g.filter = 'blur(0.6px)';
      g.drawImage(g.canvas, 0, 0);
      g.filter = 'none';
    }));
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    // Fine grass detail, tiled every few metres.
    const detail = this._track(canvasTex(256, 256, (g, w, h) => {
      const r = rng(5);
      g.fillStyle = '#808080'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) { const v = 100 + r() * 70; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(r() * w, r() * h, 1, 2 + r() * 3); }
    }, { repeat: [1, 1], srgb: false }));
    detail.wrapS = detail.wrapT = THREE.RepeatWrapping;
    const mat = this._track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 }));
    const sizeX = x1 - x0, sizeZ = z1 - z0;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.detailMap = { value: detail };
      shader.uniforms.detailRepeat = { value: new THREE.Vector2(sizeX / 3.2, sizeZ / 3.2) };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform sampler2D detailMap;\nuniform vec2 detailRepeat;')
        .replace('#include <map_fragment>', '#include <map_fragment>\nfloat dt = texture2D(detailMap, vMapUv * detailRepeat).r;\ndiffuseColor.rgb *= mix(0.86, 1.16, dt);');
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.terrain = mesh;
    // A wide skirt of meadow around the hole (a ring: it never covers the
    // hole's own ponds and rivers).
    const ring = new THREE.Shape([new THREE.Vector2(-2400, -2400), new THREE.Vector2(2400, -2400), new THREE.Vector2(2400, 2400), new THREE.Vector2(-2400, 2400)]);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const hw = (x1 - x0) / 2 - 0.5, hd = (z1 - z0) / 2 - 0.5;
    ring.holes.push(new THREE.Path([new THREE.Vector2(-hw, -hd), new THREE.Vector2(-hw, hd), new THREE.Vector2(hw, hd), new THREE.Vector2(hw, -hd)]));
    // Painted like the out-of-bounds grass at the terrain's edge (same
    // material and grain, about a metre per texel) so the seam disappears.
    const meadow = this._track(canvasTex(64, 64, (g, w, h) => {
      const r = rng(hole.seed + 23);
      const c = SURF_COLORS.ob;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const k2 = (0.92 + r() * 0.14) * (0.97 + r() * 0.06);
          g.fillStyle = `rgb(${Math.round(c[0] * k2)},${Math.round(c[1] * k2)},${Math.round(c[2] * k2)})`;
          g.fillRect(x, y, 1, 1);
        }
      }
    }));
    meadow.wrapS = meadow.wrapT = THREE.RepeatWrapping;
    meadow.repeat.set(1 / 64, 1 / 64);
    const skirt = new THREE.Mesh(this._track(new THREE.ShapeGeometry(ring)), this._track(new THREE.MeshStandardMaterial({ map: meadow, roughness: 0.92, metalness: 0 })));
    skirt.rotation.x = -Math.PI / 2;
    // By the sea it sits under the water, so the sea runs to the horizon.
    skirt.position.set(cx, this.hole.scenery?.hills === 'sea' ? this.hole.waterLevel - 3 : Math.min(-0.3, this.hole.baseH - 0.4), cz);
    this.scene.add(skirt);
  }

  _water() {
    const hole = this.hole;
    const { x0, x1, z0, z1 } = hole.extent;
    const hasWater = hole.def.water.length || hole.islands.length;
    if (!hasWater) return;
    const nrm = this._track(canvasTex(256, 256, (g, w, h) => {
      const r = rng(9);
      g.fillStyle = 'rgb(128,128,255)'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 260; i++) {
        const x = r() * w, y = r() * h, rr = 6 + r() * 18;
        const grd = g.createRadialGradient(x, y, 0, x, y, rr);
        grd.addColorStop(0, `rgba(${100 + r() * 60},${100 + r() * 60},255,0.5)`); grd.addColorStop(1, 'rgba(128,128,255,0)');
        g.fillStyle = grd; g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
      }
    }, { repeat: [60, 60], srgb: false }));
    const mat = this._track(new THREE.MeshStandardMaterial({ color: '#2a8fd6', roughness: 0.12, metalness: 0.15, normalMap: nrm, normalScale: new THREE.Vector2(0.45, 0.45), transparent: true, opacity: 0.88 }));
    const size = Math.max(x1 - x0, z1 - z0) + (hole.scenery?.hills === 'sea' ? 2400 : 200);
    const w = new THREE.Mesh(this._track(new THREE.PlaneGeometry(size, size)), mat);
    w.rotation.x = -Math.PI / 2;
    w.position.set((x0 + x1) / 2, hole.waterLevel, (z0 + z1) / 2);
    w.receiveShadow = true;
    this.scene.add(w);
    this.waterMesh = w;
    this.waterNormal = nrm;
  }

  _trees() {
    const hole = this.hole;
    const byKind = { round: [], cone: [], palm: [] };
    for (const t of hole.trees) byKind[t.kind || 'round'].push(t);
    const r = rng(hole.seed + 29);
    const col = new THREE.Color();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const trunkM = this._track(new THREE.MeshLambertMaterial({ color: '#7a5233' }));
    const leafM = this._track(new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true }));
    const make = (geo, mat, list, place, tint) => {
      if (!list.length) return null;
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((t, i) => {
        const gy = hole.heightAt(t.x, t.z);
        place(t, gy, p, s, q);
        m4.compose(p, q, s);
        inst.setMatrixAt(i, m4);
        if (tint) inst.setColorAt(i, col.set(tint(t)));
      });
      inst.castShadow = true;
      inst.receiveShadow = true;
      this.scene.add(inst);
      this.disposables.push(inst);
      return inst;
    };
    const greens = ['#2f8a3a', '#3a9a44', '#2a7a37', '#469f43', '#33803e'];
    // Round trees: trunk + a chunky canopy.
    const trunkG = this._track(new THREE.CylinderGeometry(0.28, 0.38, 1, 7));
    trunkG.translate(0, 0.5, 0);
    make(trunkG, trunkM, byKind.round, (t, gy, P, S, Q) => { const sh = treeShape(t, gy); P.set(t.x, gy, t.z); S.set(t.s, sh.trunkTop - gy + 0.6, t.s); Q.identity(); });
    const canopyG = this._track(new THREE.IcosahedronGeometry(1, 1));
    make(canopyG, leafM, byKind.round, (t, gy, P, S, Q) => { const sh = treeShape(t, gy); P.set(t.x, sh.cy, t.z); S.set(sh.rx, sh.ry, sh.rx); Q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r() * 6.28); }, () => greens[Math.floor(r() * greens.length)]);
    // Cone trees (pines).
    make(trunkG, trunkM, byKind.cone, (t, gy, P, S, Q) => { const sh = treeShape(t, gy); P.set(t.x, gy, t.z); S.set(t.s * 0.8, sh.trunkTop - gy + 0.8, t.s * 0.8); Q.identity(); });
    const coneG = this._track(new THREE.ConeGeometry(1, 2, 8));
    make(coneG, leafM, byKind.cone, (t, gy, P, S, Q) => { const sh = treeShape(t, gy); P.set(t.x, sh.cy, t.z); S.set(sh.rx, sh.ry / 2, sh.rx); Q.identity(); }, () => ['#1f6b34', '#25753a', '#2c7f3f'][Math.floor(r() * 3)]);
    // Palms: a slim leaning trunk and a crown of fronds.
    const palmTrunkG = this._track(new THREE.CylinderGeometry(0.16, 0.26, 1, 7));
    palmTrunkG.translate(0, 0.5, 0);
    make(palmTrunkG, this._track(new THREE.MeshLambertMaterial({ color: '#9b7a55' })), byKind.palm, (t, gy, P, S, Q) => { const sh = treeShape(t, gy); P.set(t.x, gy, t.z); S.set(t.s, sh.trunkTop - gy + 0.3, t.s); Q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.25, 0, (r() - 0.5) * 0.25)); });
    const frondG = this._track(new THREE.ConeGeometry(1, 0.5, 7, 1, true));
    make(frondG, this._track(new THREE.MeshLambertMaterial({ color: '#3fa047', side: THREE.DoubleSide, flatShading: true })), byKind.palm, (t, gy, P, S, Q) => { const sh = treeShape(t, gy); P.set(t.x, sh.cy, t.z); S.set(sh.rx, sh.ry * 0.8, sh.rx); Q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r() * 6.28); Q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)); });
  }

  // White out-of-bounds stakes along the boundary.
  _stakes() {
    const hole = this.hole;
    const poly = hole.def.bounds.poly;
    if (!poly) return;
    const pts = [];
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.floor(len / 9));
      for (let k = 0; k < n; k++) {
        const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
        if (hole.heightAt(x, z) < hole.waterLevel + 0.1) continue;
        pts.push([x, z]);
      }
    }
    if (!pts.length) return;
    const geo = this._track(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6));
    geo.translate(0, 0.5, 0);
    const inst = new THREE.InstancedMesh(geo, this._track(new THREE.MeshLambertMaterial({ color: '#ffffff' })), pts.length);
    const m4 = new THREE.Matrix4();
    pts.forEach(([x, z], i) => { m4.makeTranslation(x, hole.heightAt(x, z), z); inst.setMatrixAt(i, m4); });
    inst.castShadow = true;
    this.scene.add(inst);
    this.disposables.push(inst);
  }

  _tee() {
    const [tx, tz] = this.hole.tee;
    const gy = this.hole.heightAt(tx, tz);
    const m = this._track(new THREE.MeshStandardMaterial({ color: '#2f7bf5', roughness: 0.4 }));
    for (const s of [-1, 1]) {
      const b = new THREE.Mesh(this._track(new THREE.SphereGeometry(0.12, 14, 10)), m);
      b.position.set(tx + s * 2.6, gy + 0.1, tz - 0.4);
      b.castShadow = true;
      this.scene.add(b);
    }
  }

  _flag() {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(this._track(new THREE.CylinderGeometry(0.02, 0.02, 2.13, 8)), this._track(new THREE.MeshStandardMaterial({ color: '#fdfdfd', roughness: 0.3 })));
    pole.position.y = 2.13 / 2;
    pole.castShadow = true;
    const n = this.hole.n;
    const flagTex = this._track(canvasTex(128, 80, (c, w, h) => {
      c.fillStyle = '#e8384f'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#ffffff'; c.font = '800 54px "M PLUS Rounded 1c", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(String(n), w / 2, h / 2 + 3);
    }));
    const flagGeo = this._track(new THREE.PlaneGeometry(0.62, 0.4, 8, 1));
    flagGeo.translate(0.31, 0, 0);
    this.flagMesh = new THREE.Mesh(flagGeo, this._track(new THREE.MeshStandardMaterial({ map: flagTex, side: THREE.DoubleSide, roughness: 0.7 })));
    this.flagMesh.position.y = 1.9;
    this.flagMesh.castShadow = true;
    this.flagBase = flagGeo.attributes.position.array.slice();
    const cup = new THREE.Mesh(this._track(new THREE.CircleGeometry(CUP_R * 1.15, 20)), this._track(new THREE.MeshBasicMaterial({ color: '#1a1f1a' })));
    cup.rotation.x = -Math.PI / 2;
    cup.position.y = 0.006;
    const rim = new THREE.Mesh(this._track(new THREE.RingGeometry(CUP_R * 1.15, CUP_R * 1.35, 20)), this._track(new THREE.MeshBasicMaterial({ color: '#f4f6f0' })));
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.005;
    g.add(pole, this.flagMesh, cup, rim);
    this.scene.add(g);
    this.flag = g;
  }

  setPin(pin) {
    this.pin = pin;
    const y = this.hole.heightAt(pin.x, pin.z);
    this.flag.position.set(pin.x, y, pin.z);
  }

  setFlagVisible(on) { this.flag.children[0].visible = on; this.flagMesh.visible = on; }

  // Wind ripples the flag.
  updateFlag(t, wind) {
    const pos = this.flagMesh.geometry.attributes.position;
    const base = this.flagBase;
    const k = Math.min(1, Math.hypot(wind[0], wind[2]) / 10);
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3];
      pos.array[i * 3 + 2] = Math.sin(t * (4 + k * 6) + x * 9) * x * (0.08 + k * 0.12);
    }
    pos.needsUpdate = true;
    this.flagMesh.rotation.y = Math.atan2(-wind[2], wind[0] || 1e-6) * (k > 0.05 ? 1 : 0);
  }

  _scenery() {
    const hole = this.hole;
    const { x0, x1, z0, z1 } = hole.extent;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const r = rng(hole.seed + 77);
    const kind = hole.scenery?.hills || 'meadow';
    if (kind !== 'sea') {
      const hillM = this._track(new THREE.MeshLambertMaterial({ color: kind === 'forest' ? '#3f7f3c' : '#5e9e4e' }));
      const farM = this._track(new THREE.MeshLambertMaterial({ color: '#8fb8a8' }));
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2 + r() * 0.2;
        const d = 520 + r() * 260;
        const h = new THREE.Mesh(this._track(new THREE.SphereGeometry(120 + r() * 120, 16, 10)), i % 2 ? farM : hillM);
        h.position.set(cx + Math.cos(a) * d, -60 + r() * 30, cz + Math.sin(a) * d);
        h.scale.y = 0.55 + r() * 0.25;
        this.scene.add(h);
      }
      // Distant tree line.
      const tg = this._track(new THREE.IcosahedronGeometry(1, 1));
      const tm = this._track(new THREE.MeshLambertMaterial({ color: '#2f7a38', flatShading: true }));
      const n = 220;
      const inst = new THREE.InstancedMesh(tg, tm, n);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2;
        const rx = (x1 - x0) / 2 + 40 + r() * 90, rz = (z1 - z0) / 2 + 40 + r() * 90;
        p.set(cx + Math.cos(a) * rx, -1 + r() * 2, cz + Math.sin(a) * rz);
        const sc = 4 + r() * 5;
        s.set(sc, sc * (1.1 + r() * 0.5), sc);
        m4.compose(p, q, s);
        inst.setMatrixAt(i, m4);
      }
      this.scene.add(inst);
      this.disposables.push(inst);
    } else {
      // Far islands on the sea.
      const islM = this._track(new THREE.MeshLambertMaterial({ color: '#79b46a' }));
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + r();
        const d = 480 + r() * 300;
        const h = new THREE.Mesh(this._track(new THREE.SphereGeometry(60 + r() * 80, 14, 8)), islM);
        h.position.set(cx + Math.cos(a) * d, -40, cz + Math.sin(a) * d);
        h.scale.y = 0.6;
        this.scene.add(h);
      }
    }
  }

  // Balls: one per player.
  _balls() {
    this.ballGeo = this._track(new THREE.SphereGeometry(0.065, 16, 12));
    this.ballMat = this._track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35 }));
    const blob = this._track(canvasTex(64, 64, (g) => {
      const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
      grd.addColorStop(0, 'rgba(0,0,0,0.5)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    }, { srgb: false }));
    this.blobMat = this._track(new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false }));
    this.blobGeo = this._track(new THREE.PlaneGeometry(0.4, 0.4));
    this.balls = new Map();
    // The flying ball's trail.
    this.trailGeo = this._track(new THREE.BufferGeometry());
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 120), 3));
    this.trail = new THREE.Line(this.trailGeo, this._track(new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.75 })));
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    this.scene.add(this.trail);
  }

  ball(id, color) {
    let b = this.balls.get(id);
    if (!b) {
      const mesh = new THREE.Mesh(this.ballGeo, this.ballMat);
      mesh.castShadow = true;
      const shadow = new THREE.Mesh(this.blobGeo, this.blobMat);
      shadow.rotation.x = -Math.PI / 2;
      const ringM = this._track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
      const ring = new THREE.Mesh(this._track(new THREE.RingGeometry(0.16, 0.24, 20)), ringM);
      ring.rotation.x = -Math.PI / 2;
      this.scene.add(mesh, shadow, ring);
      b = { mesh, shadow, ring };
      this.balls.set(id, b);
    }
    return b;
  }

  placeBall(id, color, x, y, z, { visible = true, ring = false } = {}) {
    const b = this.ball(id, color);
    b.mesh.visible = visible;
    b.mesh.position.set(x, y, z);
    const gy = this.hole.heightAt(x, z);
    b.shadow.visible = visible && y - gy < 60;
    b.shadow.position.set(x, Math.max(gy, this.hole.waterLevel) + 0.02, z);
    const k = Math.max(0.3, 1 - (y - gy) / 30);
    b.shadow.scale.setScalar(k);
    b.ring.visible = visible && ring;
    b.ring.position.set(x, gy + 0.03, z);
  }

  setTrail(points) {
    const arr = this.trailGeo.attributes.position.array;
    const n = Math.min(points.length, 120);
    for (let i = 0; i < n; i++) { arr[i * 3] = points[i][0]; arr[i * 3 + 1] = points[i][1]; arr[i * 3 + 2] = points[i][2]; }
    this.trailGeo.setDrawRange(0, n);
    this.trailGeo.attributes.position.needsUpdate = true;
    this.trail.visible = n > 1;
  }

  // The aim line: blue dots across the ground to the full-power landing spot.
  _aim() {
    const g = this._track(new THREE.SphereGeometry(0.22, 10, 8));
    this.aimDots = new THREE.InstancedMesh(g, this._track(new THREE.MeshBasicMaterial({ color: '#36b7ff', transparent: true, opacity: 0.85 })), 64);
    this.aimDots.frustumCulled = false;
    this.aimDots.count = 0;
    this.scene.add(this.aimDots);
    this.markGeo = this._track(new THREE.TorusGeometry(1, 0.12, 6, 32));
    this.marks = [0, 1, 2, 3].map((i) => {
      const m = new THREE.Mesh(this.markGeo, this._track(new THREE.MeshBasicMaterial({ color: i === 3 ? '#e8384f' : '#ffffff', transparent: true, opacity: 0.9 })));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.scene.add(m);
      return m;
    });
  }

  // from: ball position; dir: aim; marks: [{ x, z }] at the four power dots.
  setAim(from, marks, on = true, putt = false) {
    if (!on) { this.aimDots.count = 0; for (const m of this.marks) m.visible = false; return; }
    const last = marks[marks.length - 1];
    const len = Math.hypot(last.x - from.x, last.z - from.z);
    const n = Math.min(64, Math.max(2, Math.floor(len / (putt ? 0.5 : 4))));
    const m4 = new THREE.Matrix4();
    for (let i = 1; i <= n; i++) {
      const u = i / n;
      const x = from.x + (last.x - from.x) * u, z = from.z + (last.z - from.z) * u;
      const d = len * u;
      const s = putt ? 0.22 : clamp01((d - 6) / 50) * 0.8 + 0.2;
      if (d < (putt ? 0.6 : 5)) { m4.makeScale(0, 0, 0); this.aimDots.setMatrixAt(i - 1, m4); continue; }
      m4.makeScale(s, s, s).setPosition(x, this.hole.heightAt(x, z) + 0.15 * s, z);
      this.aimDots.setMatrixAt(i - 1, m4);
    }
    this.aimDots.count = n;
    this.aimDots.instanceMatrix.needsUpdate = true;
    marks.forEach((p, i) => {
      const m = this.marks[i];
      m.visible = true;
      const s = putt ? 0.35 : 1.6 + i * 0.4;
      m.scale.set(s, s, 1);
      m.position.set(p.x, this.hole.heightAt(p.x, p.z) + 0.12, p.z);
    });
  }

  // The green's slope grid (button 1 on the green): lines that follow the
  // ground, tinted by height, with dots flowing downhill.
  _grid() {
    this.gridGroup = new THREE.Group();
    this.gridGroup.visible = false;
    this.scene.add(this.gridGroup);
  }

  showGrid(on, center) {
    this.gridGroup.visible = on;
    if (!on) return;
    if (this._gridBuilt) return;
    this._gridBuilt = true;
    const hole = this.hole;
    const R = 22, step = 1.0;
    const pos = [], col = [];
    let hmin = Infinity, hmax = -Infinity;
    for (let x = -R; x <= R; x += step) for (let z = -R; z <= R; z += step) { const h = hole.heightAt(center.x + x, center.z + z); hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
    const c = new THREE.Color();
    const colorAt = (h) => c.setHSL(0.6 - 0.6 * ((h - hmin) / Math.max(0.05, hmax - hmin)), 0.85, 0.55);
    const seg = (x0, z0, x1, z1) => {
      const ax = center.x + x0, az = center.z + z0, bx = center.x + x1, bz = center.z + z1;
      if (hole.greenDist(ax, az) > 3 && hole.greenDist(bx, bz) > 3) return;
      const ha = hole.heightAt(ax, az), hb = hole.heightAt(bx, bz);
      pos.push(ax, ha + 0.03, az, bx, hb + 0.03, bz);
      colorAt(ha); col.push(c.r, c.g, c.b);
      colorAt(hb); col.push(c.r, c.g, c.b);
    };
    for (let x = -R; x <= R; x += step) for (let z = -R; z < R; z += step) { seg(x, z, x, z + step); seg(z, x, z + step, x); }
    const geo = this._track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const lines = new THREE.LineSegments(geo, this._track(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 })));
    this.gridGroup.add(lines);
    // Flow dots: start on a lattice and slide downhill.
    const n = 160;
    this.flow = [];
    this.flowMesh = new THREE.InstancedMesh(this._track(new THREE.SphereGeometry(0.06, 6, 4)), this._track(new THREE.MeshBasicMaterial({ color: '#ffffff' })), n);
    this.flowMesh.frustumCulled = false;
    const r = rng(3);
    for (let i = 0; i < n; i++) this.flow.push({ x: center.x + (r() * 2 - 1) * R, z: center.z + (r() * 2 - 1) * R, life: r() * 3 });
    this.gridCenter = center;
    this.gridGroup.add(this.flowMesh);
  }

  updateFlow(dt) {
    if (!this.gridGroup.visible || !this.flow) return;
    const hole = this.hole;
    const m4 = new THREE.Matrix4();
    const R = 22, c = this.gridCenter;
    this.flow.forEach((f, i) => {
      f.life -= dt;
      const n = hole.normalAt(f.x, f.z);
      f.x += n[0] * dt * 18; f.z += n[2] * dt * 18;
      if (f.life <= 0 || hole.greenDist(f.x, f.z) > 2.5) { f.x = c.x + (Math.random() * 2 - 1) * R; f.z = c.z + (Math.random() * 2 - 1) * R; f.life = 1.5 + Math.random() * 2; }
      const vis = hole.greenDist(f.x, f.z) < 1.5;
      m4.makeScale(vis ? 1 : 0, vis ? 1 : 0, vis ? 1 : 0).setPosition(f.x, hole.heightAt(f.x, f.z) + 0.08, f.z);
      this.flowMesh.setMatrixAt(i, m4);
    });
    this.flowMesh.instanceMatrix.needsUpdate = true;
  }

  update(t) {
    if (this.waterNormal) this.waterNormal.offset.set(t * 0.004, t * 0.003);
  }

  dispose() {
    for (const d of this.disposables) d.dispose?.();
  }
}
