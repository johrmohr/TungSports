// Background life: other bowlers on the neighbouring lanes.
// Purely visual (no physics): an NPC walks up, swings, a ball rolls down its
// lane with a little curve, some pins topple, and the rack resets.
import * as THREE from 'three';
import { DIM, pinSpot } from '../shared/physics.js';
import { Avatar } from './avatar.js';
import { LANE_PITCH } from './scene.js';
import { rng } from './textures.js';

const COLORS = ['#d21e14', '#ff6e19', '#78d220', '#007830', '#3caade', '#f55a7d', '#7328ad', '#ffd820', '#0a48b4', '#483818'];
const NPC_LANES = [-3, -2, 2, 3];   // not ±1: they would crowd the aiming view
const START_Z = 3.0;
const LINE_Z = 0.45;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Ambient {
  constructor(alley, audio) {
    this.alley = alley;
    this.audio = audio;
    this.r = rng(4242);
    this.bowlers = NPC_LANES.map((li, i) => this._makeBowler(li, i));
    this.tmpM = new THREE.Matrix4();
    this.tmpQ = new THREE.Quaternion();
    this.tmpE = new THREE.Euler();
    this.tmpP = new THREE.Vector3();
    this.one = new THREE.Vector3(1, 1, 1);
    this.enabled = true;
  }

  _makeBowler(li, i) {
    const color = COLORS[(i * 3 + 1) % COLORS.length];
    const avatar = new Avatar({ color, seed: 900 + i * 17, hand: i % 4 === 3 ? 'left' : 'right' });
    const x0 = li * LANE_PITCH;
    avatar.group.position.set(x0 - 0.24, 0, START_Z + 0.45);
    avatar.setPose('idle');
    this.alley.scene.add(avatar.group);
    const ball = this.alley.makeBall(color);
    ball.visible = false;
    this.alley.scene.add(ball);
    return {
      li, x0, avatar, ball, state: 'wait', t: 0,
      wait: 3 + i * 2.7 + this.r() * 5,
      plan: null,
      pins: Array.from({ length: 10 }, (_, k) => ({ n: k + 1, down: false, t0: 0, axis: 0, dir: 1 })),
    };
  }

  // A throw plan: where the ball goes and which pins fall.
  _plan(b) {
    const r = this.r;
    const strike = r() < 0.3;
    const knock = strike ? 10 : Math.floor(3 + r() * 7);
    const order = [1, 3, 2, 5, 6, 9, 4, 8, 10, 7].sort(() => (strike ? 0 : r() - 0.5));
    const fall = new Set(strike ? order : [1, ...order.filter((n) => n !== 1)].slice(0, knock));
    return {
      startX: b.x0 + (r() - 0.3) * 0.3,
      endX: b.x0 + (r() - 0.5) * 0.12,
      speed: 6.5 + r() * 2.5,
      fall,
      gutter: r() < 0.06,
    };
  }

  update(dt) {
    if (!this.enabled) return;
    for (const b of this.bowlers) this._updateBowler(b, dt);
  }

  _updateBowler(b, dt) {
    b.t += dt;
    const avatar = b.avatar;
    const side = avatar.side * 0.24;
    switch (b.state) {
      case 'wait':
        avatar.setPose('hold');
        b.ball.visible = true;
        b.ball.position.copy(avatar.handWorld(this.tmpP));
        if (b.t > b.wait) { b.state = 'approach'; b.t = 0; b.plan = this._plan(b); avatar.setPose('approach'); }
        break;
      case 'approach': {
        const k = Math.min(1, b.t / 1.7);
        avatar.approach = k;
        avatar.armAngle = 62 - 132 * (1 - Math.cos(Math.min(b.t, 1.6) * Math.PI / 1.6)) / 2;
        avatar.group.position.set(b.plan.startX - side, 0, START_Z + 0.45 - (START_Z - LINE_Z) * smooth(0, 1, k));
        avatar.update(0);
        b.ball.visible = true;
        b.ball.position.copy(avatar.handWorld(this.tmpP));
        if (b.t >= 1.75) {
          b.state = 'roll';
          b.t = 0;
          avatar.setPose('follow');
        }
        break;
      }
      case 'roll': {
        const p = b.plan;
        const dist = b.t * p.speed;
        const total = -DIM.headPinZ + 0.6;
        const f = Math.min(1, dist / total);
        const z = -0.1 - dist;
        // Late break toward the pocket (or off into the gutter).
        const curve = p.gutter ? (DIM.laneHalfWidth + DIM.gutterWidth / 2) * Math.sign(p.startX - b.x0 || 1) * smooth(0.1, 0.5, f) : 0;
        const x = p.gutter ? b.x0 + curve : p.startX + (p.endX - p.startX) * smooth(0.45, 1, f);
        b.ball.position.set(x, DIM.ballRadius - (p.gutter && f > 0.3 ? DIM.gutterDepth : 0), z);
        b.ball.rotation.x -= dt * p.speed / DIM.ballRadius;
        if (!b.hitDone && z < DIM.headPinZ + 0.1) {
          b.hitDone = true;
          if (!p.gutter) {
            for (const pin of b.pins) {
              if (!p.fall.has(pin.n)) continue;
              pin.down = true;
              pin.t0 = b.t + (pinSpot(pin.n).z - DIM.headPinZ) * -0.25 + this.r() * 0.08;
              pin.axis = this.r() * Math.PI * 2;
              pin.dir = (pinSpot(pin.n).x + this.r() * 0.2 - 0.1) >= 0 ? 1 : -1;
            }
            this.audio?.pinHit(60 + p.fall.size * 25, 'pin');
            if (p.fall.size >= 9) setTimeout(() => this.audio?.pinHit(80, 'pin'), 60);
          }
        }
        if (z < DIM.deckEndZ - 0.3) b.ball.visible = false;
        this._pins(b, b.t);
        if (b.t > total / p.speed + 3.2) { b.state = 'reset'; b.t = 0; }
        break;
      }
      case 'reset':
        // Pinsetter: fallen pins vanish, a fresh rack appears; the bowler walks back.
        for (const pin of b.pins) pin.down = false;
        b.hitDone = false;
        this._pins(b, 0);
        avatar.group.position.set(b.x0 - side, 0, START_Z + 0.45);
        b.state = 'wait';
        b.t = 0;
        b.wait = 6 + this.r() * 12;
        break;
      default: break;
    }
    avatar.update(dt);
  }

  _pins(b, t) {
    const inst = this.alley.otherPins;
    if (!inst) return;
    for (const pin of b.pins) {
      const idx = this.alley.otherPinIndex.get(`${b.li}:${pin.n}`);
      if (idx === undefined) continue;
      const s = pinSpot(pin.n);
      if (!pin.down || t < pin.t0) {
        this.tmpQ.setFromAxisAngle(this.tmpP.set(0, 1, 0), pin.n * 1.3);
        this.tmpM.compose(this.tmpP.set(b.x0 + s.x, 0, s.z), this.tmpQ, this.one);
      } else {
        const k = smooth(0, 0.35, t - pin.t0);
        this.tmpE.set(-k * Math.PI / 2 * Math.cos(pin.axis) * 0.9, pin.axis, k * Math.PI / 2 * pin.dir * 0.6, 'YXZ');
        this.tmpQ.setFromEuler(this.tmpE);
        const slide = k * 0.25;
        this.tmpM.compose(this.tmpP.set(b.x0 + s.x + pin.dir * slide * 0.5, k * 0.04, s.z - slide), this.tmpQ, this.one);
      }
      inst.setMatrixAt(idx, this.tmpM);
    }
    inst.instanceMatrix.needsUpdate = true;
  }
}
