// Camera director: smooth moves between the bowling shots.
//   lobby  – slow drift over the alley
//   intro  – facing the bowler (turn introduction)
//   aim    – behind and above the bowler, looking down the lane
//   zoom   – toward the pins (D-pad Up)
//   chase  – low behind the rolling ball, stopping short of the pin deck
//   pins   – watching the pin deck
//   react  – facing the bowler and the crowd after a notable ball
//   back   – a ball rolled backwards: look at the seats
import * as THREE from 'three';
import { DIM } from '../shared/physics.js';

const damp = (k, dt) => 1 - Math.exp(-k * dt);

export class CameraDirector {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'lobby';
    this.pos = new THREE.Vector3(0, 3, 9);
    this.look = new THREE.Vector3(0, 0.5, -10);
    this.targetPos = this.pos.clone();
    this.targetLook = this.look.clone();
    this.stiff = 3;
    this.t = 0;
    this.ctx = { bowlerX: 0, bowlerZ: 2.4, angle: 0, ball: null, ballVel: null };
    camera.position.copy(this.pos);
    camera.lookAt(this.look);
  }

  // Shots that are cuts in the original (turn intro, reactions) jump; others glide.
  set(mode, { cut } = {}) {
    if (mode !== this.mode) this.modeT = 0;
    this.mode = mode;
    this._target(0);
    const far = this.pos.distanceTo(this.targetPos) > 7;
    if (cut ?? (['intro', 'react', 'back', 'over'].includes(mode) || (mode === 'aim' && far))) {
      this.pos.copy(this.targetPos);
      this.look.copy(this.targetLook);
    }
  }

  _target(dt) {
    const c = this.ctx;
    const tp = this.targetPos, tl = this.targetLook;
    switch (this.mode) {
      case 'lobby': {
        const a = this.t * 0.05;
        tp.set(Math.sin(a) * 2.2, 2.6 + Math.sin(a * 1.7) * 0.25, 8.5);
        tl.set(Math.sin(a * 0.7) * 0.6, 0.7, -12);
        this.stiff = 1.2;
        break;
      }
      case 'intro': {
        // In front of the bowler, a little to the side, looking back at them.
        tp.set(c.bowlerX - 0.5, 1.35, c.bowlerZ - 2.6);
        tl.set(c.bowlerX, 1.05, c.bowlerZ);
        this.stiff = 4;
        break;
      }
      case 'aim': {
        const ax = Math.sin(c.angle), az = -Math.cos(c.angle);
        // High enough that the (ghosted) bowler sits low in the frame.
        tp.set(c.bowlerX - ax * 2.9 + 0.05, 2.45, c.bowlerZ - az * 2.9);
        tl.set(c.bowlerX + ax * 14, -0.1, c.bowlerZ + az * 14);
        this.stiff = 5;
        break;
      }
      case 'zoom': {
        tp.set(c.bowlerX * 0.3, 1.25, DIM.headPinZ + 6.5);
        tl.set(0, 0.2, DIM.headPinZ - 0.4);
        this.stiff = 3;
        break;
      }
      case 'chase': {
        const b = c.ball;
        if (b) {
          const stopZ = DIM.headPinZ + 3.4;            // stop short of the pin deck
          const z = Math.max(stopZ, b.z + 2.4);
          const k = THREE.MathUtils.clamp((z - stopZ) / 8, 0, 1);
          // High over the bowler at first, settling low behind the ball.
          const y = Math.max(0.55 + k * 0.45, 2.3 + Math.min(0, b.z) * 0.26);
          tp.set(b.x * 0.65, y, z);
          tl.set(b.x * 0.4, 0.12, Math.min(b.z - 4, DIM.headPinZ - 0.2 + k * 4));
        }
        this.stiff = 6;
        break;
      }
      case 'pins': {
        tp.set(0.05, 0.78, DIM.headPinZ + 2.6);
        tl.set(0, 0.16, DIM.headPinZ - 0.45);
        this.stiff = 2.5;
        break;
      }
      case 'react': {
        tp.set(c.bowlerX + 0.9, 1.5, -1.6);
        tl.set(c.bowlerX, 1.0, c.bowlerZ + 1.8);
        this.stiff = 4;
        break;
      }
      case 'back': {
        tp.set(c.bowlerX + 1.2, 2.0, -1.0);
        tl.set(c.bowlerX, 0.6, 6.5);
        this.stiff = 3;
        break;
      }
      case 'over': {
        const a = this.t * 0.06;
        tp.set(Math.sin(a) * 1.5, 1.8, DIM.headPinZ + 5.5);
        tl.set(0, 0.6, DIM.headPinZ - 0.5);
        this.stiff = 1.5;
        break;
      }
      default: break;
    }
    void dt;
  }

  update(dt) {
    this.t += dt;
    this.modeT = (this.modeT || 0) + dt;
    this._target(dt);
    const fov = this.mode === 'aim' ? 40 : this.mode === 'zoom' ? 34 : this.mode === 'chase' ? 46 : 48;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 6));
      this.camera.updateProjectionMatrix();
    }
    const k = damp(this.stiff, dt);
    this.pos.lerp(this.targetPos, k);
    this.look.lerp(this.targetLook, k);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }
}
