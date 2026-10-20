// The tennis stadium: a green hard court (ITF lines) inside a padded wall,
// stands of cheering spectators on every side, the umpire's chair, a sagging
// net, a summer sky and trees. Everything is built in code.
import * as THREE from 'three';
import { COURT, netHeightAt } from '../../shared/tennis-physics.js';

const CROWD_COLORS = ['#d21e14', '#ff6e19', '#78d220', '#007830', '#3caade', '#f55a7d', '#7328ad', '#483818', '#e0e0e0', '#0a48b4', '#ffd820', '#2f7bf5', '#e8384f', '#ff8a1f', '#8a4ff0', '#ff5fb0'];
const SKIN = ['#f6d0b1', '#e8b997', '#c98b62', '#8d5a3b', '#f1c27d', '#ffdbac'];

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

// The court surface + run-off with every line painted, 36.6 × 18.3 m.
const SURF_W = 18.3, SURF_L = 36.6;
function courtTexture() {
  const PX = 56;                                    // pixels per metre
  return canvasTex(Math.round(SURF_W * PX), Math.round(SURF_L * PX), (g, w, h) => {
    const r = rng(7);
    const X = (x) => (x + SURF_W / 2) * PX, Z = (z) => (z + SURF_L / 2) * PX;
    // Run-off: a deeper green.
    g.fillStyle = '#3d8c47';
    g.fillRect(0, 0, w, h);
    // Court: lighter green.
    g.fillStyle = '#5dae4f';
    g.fillRect(X(-COURT.halfW), Z(-COURT.halfLen), COURT.halfW * 2 * PX, COURT.halfLen * 2 * PX);
    // Speckle for a hard-court texture.
    for (let i = 0; i < 16000; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.04)';
      g.fillRect(r() * w, r() * h, 1.5, 1.5);
    }
    // Lines (5 cm, baselines 10 cm).
    g.fillStyle = '#ffffff';
    const line = (x0, z0, x1, z1, wd = 0.05) => {
      if (x0 === x1) g.fillRect(X(x0) - wd * PX / 2, Z(Math.min(z0, z1)), wd * PX, Math.abs(z1 - z0) * PX);
      else g.fillRect(X(Math.min(x0, x1)), Z(z0) - wd * PX / 2, Math.abs(x1 - x0) * PX, wd * PX);
    };
    const L = COURT.halfLen, W = COURT.halfW, S = COURT.singlesHalfW, SV = COURT.service;
    line(-W, -L, W, -L, 0.1); line(-W, L, W, L, 0.1);
    line(-W, -L, -W, L); line(W, -L, W, L);
    line(-S, -L, -S, L); line(S, -L, S, L);
    line(-S, -SV, S, -SV); line(-S, SV, S, SV);
    line(0, -SV, 0, SV);
    line(0, -L, 0, -L + 0.15, 0.05); line(0, L - 0.15, 0, L, 0.05);   // centre marks
    // A soft painted logo in each run-off.
    g.font = `800 ${Math.round(0.9 * PX)}px "M PLUS Rounded 1c", sans-serif`;
    g.textAlign = 'center';
    g.fillStyle = 'rgba(255,255,255,0.22)';
    g.save(); g.translate(X(0), Z(L + 3.1)); g.fillText('BRAINROT OPEN', 0, 0); g.restore();
    g.save(); g.translate(X(0), Z(-L - 3.1)); g.rotate(Math.PI); g.fillText('BRAINROT OPEN', 0, 0); g.restore();
  });
}

function netTexture() {
  return canvasTex(256, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(20,24,28,0.85)';
    g.lineWidth = 1.4;
    for (let x = 0; x <= w; x += 6) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += 6) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  }, { repeat: [10, 1], srgb: true });
}

function skyTexture() {
  return canvasTex(16, 512, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#3a8fe0');
    grd.addColorStop(0.45, '#7fc0f2');
    grd.addColorStop(0.62, '#d9eefb');
    grd.addColorStop(1, '#f4fbff');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
}

function wallTexture() {
  return canvasTex(512, 64, (g, w, h) => {
    g.fillStyle = '#1f6b46';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, 5);
    g.font = '800 30px "M PLUS Rounded 1c", sans-serif';
    g.textAlign = 'center';
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillText('KRISHIV SPORTS', w / 4, 44);
    g.fillStyle = 'rgba(215,242,92,0.95)';
    g.fillText('BRAINROT OPEN', (3 * w) / 4, 44);
  }, { repeat: [6, 1] });
}

export function ballTexture() {
  return canvasTex(128, 64, (g, w, h) => {
    g.fillStyle = '#d7f25c';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 5;
    g.beginPath();
    for (let x = 0; x <= w; x++) {
      const y = h / 2 + Math.sin((x / w) * Math.PI * 2) * h * 0.28;
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  });
}

export class Court {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog('#d9eefb', 70, 170);
    this.disposables = [];
    this._lights();
    this._sky();
    this._ground();
    this._court();
    this._net();
    this._walls();
    this._stands();
    this._umpire();
    this._scenery();
    this._ball();
  }

  _track(...xs) { for (const x of xs) this.disposables.push(x); return xs[0]; }

  _lights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight('#eaf6ff', '#5d8a4a', 1.05));
    const sun = new THREE.DirectionalLight('#fff4de', 2.0);
    sun.position.set(-9, 22, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -12; c.right = 12; c.top = 18; c.bottom = -18; c.near = 1; c.far = 60;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    sun.target.position.set(0, 0, 0);
    s.add(sun, sun.target);
    this.sun = sun;
  }

  _sky() {
    const geo = this._track(new THREE.SphereGeometry(160, 24, 16));
    const mat = this._track(new THREE.MeshBasicMaterial({ map: this._track(skyTexture()), side: THREE.BackSide, fog: false, depthWrite: false }));
    const sky = new THREE.Mesh(geo, mat);
    this.scene.add(sky);
    // A few soft clouds.
    const cloudTex = this._track(canvasTex(128, 64, (g, w, h) => {
      const blob = (x, y, r) => { const grd = g.createRadialGradient(x, y, 0, x, y, r); grd.addColorStop(0, 'rgba(255,255,255,0.95)'); grd.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
      blob(40, 38, 26); blob(64, 30, 30); blob(90, 38, 24); blob(64, 44, 22);
    }));
    const r = rng(31);
    for (let i = 0; i < 14; i++) {
      const sp = new THREE.Sprite(this._track(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.75 + r() * 0.2, fog: false, depthWrite: false })));
      const a = r() * Math.PI * 2, d = 110 + r() * 30;
      sp.position.set(Math.cos(a) * d, 35 + r() * 30, Math.sin(a) * d);
      sp.scale.set(40 + r() * 30, 18 + r() * 10, 1);
      this.scene.add(sp);
    }
  }

  _ground() {
    const geo = this._track(new THREE.PlaneGeometry(400, 400));
    const tex = this._track(canvasTex(256, 256, (g, w, h) => {
      const r = rng(3);
      g.fillStyle = '#5a9c45'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 4000; i++) { g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,40,0,0.08)'; g.fillRect(r() * w, r() * h, 2, 2); }
    }, { repeat: [60, 60] }));
    const m = new THREE.Mesh(geo, this._track(new THREE.MeshLambertMaterial({ map: tex })));
    m.rotation.x = -Math.PI / 2;
    m.position.y = -0.02;
    m.receiveShadow = true;
    this.scene.add(m);
  }

  _court() {
    const geo = this._track(new THREE.PlaneGeometry(SURF_W, SURF_L));
    const mat = this._track(new THREE.MeshStandardMaterial({ map: this._track(courtTexture()), roughness: 0.85, metalness: 0 }));
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.receiveShadow = true;
    this.scene.add(m);
  }

  _net() {
    const g = new THREE.Group();
    const postM = this._track(new THREE.MeshStandardMaterial({ color: '#f2f4f7', roughness: 0.4, metalness: 0.3 }));
    const postG = this._track(new THREE.CylinderGeometry(0.05, 0.05, COURT.netPost + 0.05, 12));
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(postG, postM);
      p.position.set(s * COURT.postX, (COURT.netPost + 0.05) / 2, 0);
      p.castShadow = true;
      g.add(p);
    }
    // Net mesh: a sagging strip from the posts.
    const seg = 48;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const x = -COURT.postX + (2 * COURT.postX * i) / seg;
      const top = netHeightAt(x);
      pos.push(x, 0.02, 0, x, top - 0.03, 0);
      uv.push(i / seg, 0, i / seg, 1);
      if (i < seg) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const ng = this._track(new THREE.BufferGeometry());
    ng.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ng.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    ng.setIndex(idx);
    ng.computeVertexNormals();
    const nm = this._track(new THREE.MeshStandardMaterial({ map: this._track(netTexture()), transparent: true, alphaTest: 0.25, side: THREE.DoubleSide, roughness: 0.9 }));
    const net = new THREE.Mesh(ng, nm);
    net.castShadow = true;
    g.add(net);
    // White tape along the top.
    const pts = [];
    for (let i = 0; i <= seg; i++) { const x = -COURT.postX + (2 * COURT.postX * i) / seg; pts.push(new THREE.Vector3(x, netHeightAt(x) - 0.02, 0)); }
    const tape = new THREE.Mesh(this._track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.03, 6, false)), this._track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 })));
    tape.castShadow = true;
    g.add(tape);
    const strap = new THREE.Mesh(this._track(new THREE.BoxGeometry(0.05, COURT.netCenter, 0.01)), tape.material);
    strap.position.set(0, COURT.netCenter / 2, 0.012);
    g.add(strap);
    this.scene.add(g);
  }

  _walls() {
    const wallH = 1.1, X = 10.6, Z = 20.4;
    const tex = this._track(wallTexture());
    const mat = this._track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
    const add = (w, x, z, ry) => {
      const geo = this._track(new THREE.BoxGeometry(w, wallH, 0.3));
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, wallH / 2, z);
      m.rotation.y = ry;
      m.receiveShadow = true;
      this.scene.add(m);
    };
    add(X * 2, 0, -Z, 0); add(X * 2, 0, Z, Math.PI);
    add(Z * 2, -X, 0, Math.PI / 2); add(Z * 2, X, 0, -Math.PI / 2);
  }

  // Tiered stands on all four sides, filled with instanced spectators.
  _stands() {
    const tierM = this._track(new THREE.MeshStandardMaterial({ color: '#c9d2dc', roughness: 0.9 }));
    const seatM = this._track(new THREE.MeshStandardMaterial({ color: '#2f6fd6', roughness: 0.6 }));
    const rows = 7, rise = 0.55, depth = 0.9;
    const sides = [
      { len: 22, at: (i, along) => [along, -21.2 - i * depth], ry: 0 },
      { len: 22, at: (i, along) => [along, 21.2 + i * depth], ry: Math.PI },
      { len: 40, at: (i, along) => [-11.4 - i * depth, along], ry: Math.PI / 2 },
      { len: 40, at: (i, along) => [11.4 + i * depth, along], ry: -Math.PI / 2 },
    ];
    const spots = [];
    const r = rng(19);
    for (const side of sides) {
      for (let i = 0; i < rows; i++) {
        const y = 0.6 + i * rise;
        const [cx, cz] = side.at(i, 0);
        const geo = this._track(new THREE.BoxGeometry(side.len, y, depth));
        const tier = new THREE.Mesh(geo, tierM);
        tier.position.set(cx, y / 2, cz);
        tier.rotation.y = side.ry;
        this.scene.add(tier);
        const sgeo = this._track(new THREE.BoxGeometry(side.len, 0.12, depth * 0.45));
        const seat = new THREE.Mesh(sgeo, seatM);
        seat.position.set(cx, y + 0.06, cz);
        seat.rotation.y = side.ry;
        this.scene.add(seat);
        for (let along = -side.len / 2 + 0.6; along < side.len / 2 - 0.4; along += 0.62) {
          if (r() < 0.16) continue;
          const [x, z] = side.at(i, along + (r() - 0.5) * 0.12);
          spots.push({ x, y: y + 0.12, z, ry: side.ry });
        }
      }
    }
    // Spectators: a body and a head per seat (two instanced meshes).
    const n = spots.length;
    const bodyG = this._track(new THREE.CapsuleGeometry(0.17, 0.32, 4, 8));
    const headG = this._track(new THREE.SphereGeometry(0.14, 12, 10));
    const bodyM = this._track(new THREE.MeshLambertMaterial({ color: '#ffffff' }));
    const headM = this._track(new THREE.MeshLambertMaterial({ color: '#ffffff' }));
    this.crowdBody = new THREE.InstancedMesh(bodyG, bodyM, n);
    this.crowdHead = new THREE.InstancedMesh(headG, headM, n);
    const col = new THREE.Color();
    spots.forEach((s, i) => {
      this.crowdBody.setColorAt(i, col.set(CROWD_COLORS[Math.floor(r() * CROWD_COLORS.length)]));
      this.crowdHead.setColorAt(i, col.set(SKIN[Math.floor(r() * SKIN.length)]));
      s.phase = r() * Math.PI * 2;
      s.speed = 6 + r() * 4;
      s.lag = r() * 0.4;
    });
    this.crowd = spots;
    this.crowdMood = { cheer: 0, until: 0, wave: 0 };
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._updateCrowd(0, 0);
    this.scene.add(this.crowdBody, this.crowdHead);
  }

  // kind: 'cheer' (bounce, arms up), 'ooh' (lean), 'idle'
  crowdReact(kind, seconds = 2) {
    this.crowdMood.kind = kind;
    this.crowdMood.until = this._time + seconds;
  }

  _updateCrowd(t, dt) {
    this._time = t;
    const mood = this.crowdMood;
    const active = t < mood.until;
    const target = active ? (mood.kind === 'cheer' ? 1 : mood.kind === 'ooh' ? 0.35 : 0) : 0;
    mood.cheer += (target - mood.cheer) * Math.min(1, dt * 5);
    const k = mood.cheer;
    for (let i = 0; i < this.crowd.length; i++) {
      const s = this.crowd[i];
      const hop = k > 0.01 ? Math.max(0, Math.sin(t * s.speed + s.phase)) * 0.25 * k : Math.sin(t * 1.3 + s.phase) * 0.01;
      this._q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.ry);
      this._p.set(s.x, s.y + 0.33 + hop, s.z);
      this._m4.compose(this._p, this._q, this._s);
      this.crowdBody.setMatrixAt(i, this._m4);
      this._p.set(s.x, s.y + 0.74 + hop, s.z);
      this._m4.compose(this._p, this._q, this._s);
      this.crowdHead.setMatrixAt(i, this._m4);
    }
    this.crowdBody.instanceMatrix.needsUpdate = true;
    this.crowdHead.instanceMatrix.needsUpdate = true;
  }

  _umpire() {
    const g = new THREE.Group();
    const m = this._track(new THREE.MeshStandardMaterial({ color: '#f3f5f8', roughness: 0.5 }));
    const legG = this._track(new THREE.CylinderGeometry(0.04, 0.04, 2.0, 8));
    for (const [x, z] of [[-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]]) {
      const l = new THREE.Mesh(legG, m);
      l.position.set(x, 1.0, z);
      g.add(l);
    }
    const seat = new THREE.Mesh(this._track(new THREE.BoxGeometry(0.9, 0.08, 0.9)), m);
    seat.position.y = 2.0;
    const back = new THREE.Mesh(this._track(new THREE.BoxGeometry(0.9, 0.7, 0.08)), m);
    back.position.set(0, 2.35, 0.42);
    const rail = new THREE.Mesh(this._track(new THREE.BoxGeometry(0.9, 0.06, 0.06)), this._track(new THREE.MeshStandardMaterial({ color: '#1f6b46' })));
    rail.position.set(0, 2.35, -0.44);
    g.add(seat, back, rail);
    for (let i = 0; i < 5; i++) {
      const step = new THREE.Mesh(this._track(new THREE.BoxGeometry(0.6, 0.05, 0.2)), m);
      step.position.set(0, 0.35 + i * 0.35, 0.6 + i * 0.05);
      g.add(step);
    }
    g.position.set(-7.6, 0, 0);
    g.rotation.y = -Math.PI / 2;
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.scene.add(g);
    this.umpireSeat = new THREE.Vector3(-7.6, 2.04, 0);
  }

  _scenery() {
    const r = rng(41);
    const trunkM = this._track(new THREE.MeshLambertMaterial({ color: '#6b4a2b' }));
    const leafMs = ['#2f8a3a', '#3fa047', '#28763a'].map((c) => this._track(new THREE.MeshLambertMaterial({ color: c })));
    const trunkG = this._track(new THREE.CylinderGeometry(0.3, 0.4, 3, 8));
    const leafG = this._track(new THREE.IcosahedronGeometry(2.6, 1));
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * Math.PI * 2 + r() * 0.05;
      const d = 34 + r() * 22;
      const x = Math.cos(a) * d * 0.85, z = Math.sin(a) * d * 1.2;
      const s = 0.9 + r() * 0.9;
      const t = new THREE.Mesh(trunkG, trunkM);
      t.position.set(x, 1.5 * s, z);
      t.scale.setScalar(s);
      const l = new THREE.Mesh(leafG, leafMs[i % 3]);
      l.position.set(x, 4.2 * s, z);
      l.scale.set(s, s * 1.1, s);
      this.scene.add(t, l);
    }
    // Rolling hills on the horizon.
    const hillM = this._track(new THREE.MeshLambertMaterial({ color: '#6fae5a' }));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const h = new THREE.Mesh(this._track(new THREE.SphereGeometry(30 + r() * 20, 16, 10)), hillM);
      h.position.set(Math.cos(a) * 125, -14 + r() * 6, Math.sin(a) * 125);
      h.scale.y = 0.5;
      this.scene.add(h);
    }
  }

  _ball() {
    const tex = this._track(ballTexture());
    this.ballMesh = new THREE.Mesh(this._track(new THREE.SphereGeometry(0.085, 18, 12)), this._track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissive: '#3b4a00', emissiveIntensity: 0.25 })));
    this.ballMesh.castShadow = true;
    this.scene.add(this.ballMesh);
    // Blob shadow under the ball (always readable, even mid-air).
    const blob = this._track(canvasTex(64, 64, (g) => {
      const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
      grd.addColorStop(0, 'rgba(0,0,0,0.55)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    }, { srgb: false }));
    this.ballShadow = new THREE.Mesh(this._track(new THREE.PlaneGeometry(0.42, 0.42)), this._track(new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false })));
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);
    // Fastball trail.
    this.trail = [];
    const tm = this._track(new THREE.SpriteMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, depthWrite: false }));
    for (let i = 0; i < 16; i++) {
      const s = new THREE.Sprite(tm.clone());
      this.disposables.push(s.material);
      s.visible = false;
      this.scene.add(s);
      this.trail.push(s);
    }
    this.trailPts = [];
    // Bounce mark for "Out" calls.
    this.markM = this._track(new THREE.MeshBasicMaterial({ color: '#e8384f', transparent: true, opacity: 0.85, depthWrite: false }));
    this.mark = new THREE.Mesh(this._track(new THREE.RingGeometry(0.12, 0.2, 24)), this.markM);
    this.mark.rotation.x = -Math.PI / 2;
    this.mark.visible = false;
    this.scene.add(this.mark);
  }

  setBall(x, y, z, visible = true, fast = false, color = '#ffffff') {
    const b = this.ballMesh;
    b.visible = visible;
    b.position.set(x, y, z);
    b.rotation.x += 0.3;
    const sh = this.ballShadow;
    sh.visible = visible && y < 12;
    sh.position.set(x, 0.012, z);
    const k = Math.max(0.35, 1 - y / 6);
    sh.scale.setScalar(k);
    sh.material.opacity = 0.9 * k;
    // Trail.
    this.trailPts.unshift([x, y, z]);
    if (this.trailPts.length > this.trail.length) this.trailPts.length = this.trail.length;
    this.trail.forEach((s, i) => {
      const p = this.trailPts[i];
      s.visible = visible && fast && !!p && i > 0;
      if (!s.visible) return;
      s.position.set(p[0], p[1], p[2]);
      const f = 1 - i / this.trail.length;
      s.scale.setScalar(0.22 * f + 0.04);
      s.material.opacity = 0.75 * f;
      s.material.color.set(color);
    });
  }

  clearTrail() { this.trailPts.length = 0; for (const s of this.trail) s.visible = false; }

  showMark(x, z, on = true) {
    this.mark.visible = on;
    this.mark.position.set(x, 0.015, z);
  }

  update(t, dt) { this._updateCrowd(t, dt); }

  dispose() {
    for (const d of this.disposables) d.dispose?.();
    this.crowdBody.dispose();
    this.crowdHead.dispose();
  }
}
