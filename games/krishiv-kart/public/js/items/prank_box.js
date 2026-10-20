// Prank Box (v5 group A, SPEC §16.2; notes/research-v5-items.md §C6 A8, §C7, §C9).
//
// A fake item box dropped 2.2 m behind: it hovers at box height and spins like
// the real ones (same rainbow glass), but inside ITEM5.prankTell m a magenta
// tint fades in and its "?" turns into a grinning face — an original tell,
// readable per view (the shader uses each camera's own distance). A kart that
// touches it (within ITEM5.prankRadius) TUMBLES in a confetti pop and the box is
// consumed. Projectiles pass through it (it is not `solid`); stars / Beer
// Rockets / giants, explosions, the accordion, rolling pins, the grissino swipe
// and the calzone destroy it (role 'hazard' for the shared smashAt helper).
// At most ITEM5.prankMaxRoad on the road (oldest recycled), ITEM5.prankLife s each.
//
// CPUs: they drop it just after an item-box row (where it blends in), with a
// rival < 15 m behind, or after 8 s. Only Hard CPUs sometimes see through one
// (50 % per box, inside 15 m: the threats hook lists it for them only); every
// other driver treats it as an item box (aiLure: an empty-handed CPU steers for it).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { registerItem } from './registry.js';
import { ITEM5 } from '../config.js';
import { registerSound, SYNTH } from '../audio.js';

const BACK = 2.2, GRACE = 0.7, BOX = 1.3, SEE_RANGE = 15;
const CAP = ITEM5.prankMaxRoad;

registerSound('prankDrop', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a sly little "hee-hee" over a soft drop
  SYNTH.blip(ac, out, t, { type: 'triangle', f0: 260 * p, f1: 180 * p, glide: 0.08, dur: 0.12, peak: 0.16 });
  for (let i = 0; i < 2; i++) SYNTH.blip(ac, out, t + 0.1 + i * 0.11, { type: 'square', f0: 1180 * p, f1: 1500 * p, glide: 0.05, dur: 0.07, peak: 0.05, lp: 2800 });
  return 0.35;
}, 1.4);
registerSound('prankPop', (ac, out, o) => {
  const { t, p } = SYNTH.opt(ac, o);
  // a party-popper bang + a rubbery "boing" + the joke's laugh
  SYNTH.hiss(ac, out, t, { type: 'highpass', f0: 1800, dur: 0.12, peak: 0.32 });
  SYNTH.blip(ac, out, t, { type: 'sine', f0: 160 * p, f1: 60 * p, glide: 0.1, dur: 0.18, peak: 0.3 });
  SYNTH.blip(ac, out, t + 0.05, { type: 'sine', f0: 300 * p, f1: 700 * p, glide: 0.18, dur: 0.3, peak: 0.12, vib: 60, vibRate: 14 });
  for (let i = 0; i < 3; i++) SYNTH.blip(ac, out, t + 0.28 + i * 0.1, { type: 'square', f0: (980 - i * 90) * p, f1: (1250 - i * 90) * p, glide: 0.04, dur: 0.06, peak: 0.045, lp: 2600 });
  return 0.65;
}, 1.3);

function hash01(a, b) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ---- shaders: our item-box glass with a close-range magenta tell, and a camera-facing decal
const BOX_VERT = /* glsl */`
attribute float aPhase;
varying vec3 vN;
varying vec3 vV;
varying vec3 vLocal;
varying float vPhase;
#include <fog_pars_vertex>
void main() {
  vLocal = position;
  vPhase = aPhase;
  mat4 mw = modelMatrix * instanceMatrix;
  vec4 mvPosition = viewMatrix * mw * vec4(position, 1.0);
  vN = normalize(mat3(viewMatrix) * mat3(mw) * normal);
  vV = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const BOX_FRAG = /* glsl */`
uniform float uTime;
uniform float uHalf;
uniform float uTell;
uniform vec3 uTint;
varying vec3 vN;
varying vec3 vV;
varying vec3 vLocal;
varying float vPhase;
#include <common>
#include <fog_pars_fragment>
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  float facing = abs(dot(n, v));
  float fres = pow(1.0 - facing, 2.0);
  float hue = fract(vPhase + uTime * 0.16 + vLocal.y * 0.32 + (vLocal.x + vLocal.z) * 0.18);
  vec3 rain = hsv2rgb(vec3(hue, 0.88, 1.0));
  vec3 a = smoothstep(0.74, 0.93, abs(vLocal) / uHalf);
  float edge = clamp(a.x * a.y + a.y * a.z + a.z * a.x, 0.0, 1.0);
  float glint = smoothstep(0.92, 1.0, sin((vLocal.x + vLocal.y * 0.7 - vLocal.z * 0.4) * 3.2 - uTime * 2.6 + vPhase * 6.28));
  // the tell: inside uTell m the glass turns magenta and the frame pulses
  float tell = 1.0 - smoothstep(uTell * 0.55, uTell, length(vV));
  rain = mix(rain, uTint, tell * 0.72);
  vec3 col = mix(rain * 0.92, vec3(1.0), 0.1 + 0.38 * fres);
  col += edge * mix(rain, vec3(1.0), 0.55) * (0.9 + tell * 0.35 * sin(uTime * 9.0 + vPhase * 6.28)) + glint * 0.35;
  float alpha = clamp(0.3 + 0.5 * fres + 0.6 * edge + glint * 0.2 + tell * 0.08, 0.0, 0.94);
  col = pow(col, vec3(2.2));
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
const MARK_VERT = /* glsl */`
attribute float aPhase;
uniform float uTime;
varying vec2 vUv;
varying float vDist;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float sc = length(instanceMatrix[0].xyz);
  float w = sin(uTime * 2.3 + aPhase * 6.2831) * 0.16;
  float c = cos(w), s = sin(w);
  vec2 p = mat2(c, s, -s, c) * position.xy * sc;
  vec4 mvPosition = center + vec4(p, 0.0, 0.0);
  vDist = length(center.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const MARK_FRAG = /* glsl */`
uniform sampler2D mapQ;
uniform sampler2D mapGrin;
uniform float uTell;
varying vec2 vUv;
varying float vDist;
#include <common>
#include <fog_pars_fragment>
void main() {
  float tell = 1.0 - smoothstep(uTell * 0.45, uTell * 0.8, vDist);
  vec4 q = texture2D(mapQ, vUv);
  vec4 g = texture2D(mapGrin, vUv);
  vec4 t = mix(q, g, tell);
  if (t.a < 0.45) discard;
  gl_FragColor = vec4(t.rgb, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function markTexture(kind) {
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  if (kind === 'q') {
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '900 112px "Arial Black", "Arial Rounded MT Bold", Impact, sans-serif';
    g.lineJoin = 'round'; g.lineWidth = 18; g.strokeStyle = 'rgba(40, 14, 70, 0.95)';
    g.strokeText('?', S / 2 + 3, S / 2 + 8); g.strokeText('?', S / 2, S / 2 + 4);
    const grd = g.createLinearGradient(0, 18, 0, S - 14);
    grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.55, '#fff6c4'); grd.addColorStop(1, '#ffc93b');
    g.fillStyle = grd; g.fillText('?', S / 2, S / 2 + 4);
  } else {
    // a cheeky grinning face (our own prank mascot: no glyph from any other game)
    const cx = S / 2, cy = S / 2 + 2, R = 50;
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.fillStyle = 'rgba(40, 14, 70, 0.95)';
    g.beginPath(); g.arc(cx + 2, cy + 4, R + 8, 0, Math.PI * 2); g.fill();
    const grd = g.createRadialGradient(cx - 14, cy - 18, 6, cx, cy, R);
    grd.addColorStop(0, '#fff7d0'); grd.addColorStop(0.6, '#ffd84a'); grd.addColorStop(1, '#ff9f1c');
    g.fillStyle = grd;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2a0f3c';
    // one winking eye, one mischievous raised eye
    g.save(); g.translate(cx - 19, cy - 13); g.rotate(-0.25); g.beginPath(); g.ellipse(0, 0, 7, 10, 0, 0, Math.PI * 2); g.fill(); g.restore();
    g.lineWidth = 6; g.strokeStyle = '#2a0f3c';
    g.beginPath(); g.moveTo(cx + 9, cy - 14); g.quadraticCurveTo(cx + 19, cy - 22, cx + 29, cy - 12); g.stroke();
    // eyebrows
    g.lineWidth = 5;
    g.beginPath(); g.moveTo(cx - 30, cy - 30); g.lineTo(cx - 10, cy - 26); g.stroke();
    g.beginPath(); g.moveTo(cx + 8, cy - 31); g.lineTo(cx + 30, cy - 36); g.stroke();
    // a wide toothy grin
    g.fillStyle = '#2a0f3c';
    g.beginPath(); g.moveTo(cx - 32, cy + 6); g.quadraticCurveTo(cx, cy + 46, cx + 32, cy + 4); g.quadraticCurveTo(cx, cy + 20, cx - 32, cy + 6); g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(cx - 24, cy + 11); g.quadraticCurveTo(cx, cy + 22, cx + 24, cy + 9); g.lineTo(cx + 20, cy + 17); g.quadraticCurveTo(cx, cy + 27, cx - 20, cy + 18); g.fill();
    g.fillStyle = '#ff5f8f';
    g.beginPath(); g.ellipse(cx + 6, cy + 30, 9, 6, 0.2, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

registerItem('prank_box', {
  init(ctx) { ctx.state.box = null; ctx.state.mark = null; },

  use(ctx, kart) {
    ctx.roadCap('prank', CAP);
    const at = ctx.behind(kart, BACK);
    at.y += ITEM5.prankHover;
    const e = ctx.spawn({
      kind: 'prank', role: 'hazard', owner: kart, position: at, radius: ITEM5.prankRadius, life: ITEM5.prankLife,
      ownerGrace: GRACE, data: { phase: ctx.rng(), drop: 0.6 },
    });
    ctx.sfx('prankDrop', kart);
    ctx.emit('item:prankDrop', { kart, entity: e });
    return true;
  },

  update(ctx) {
    const list = ctx.entities();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.active) continue;
      // keep it hovering over the road (the road can move under nothing, but a respawned track height can)
      for (const k of ctx.kartsTouching(e.position, e.radius, { dy: 2.4, yOff: 0.5, kartRadius: 0 })) {
        if (k === e.owner && e.age < e.ownerGrace) continue;
        if (ctx.immune(k)) { ctx.remove(e, 'smash'); break; }
        if (ctx.hit(k, 'tumble', { by: e.owner })) {
          ctx.sfx('prankPop', k);
          ctx.flash(k, 'PRANKED!', '#c040ff', { size: 'medium', duration: 1.1, vibrate: [70, 40, 70] });
          ctx.emit('item:prankPop', { kart: k, by: e.owner });
          ctx.remove(e, 'hit');
          break;
        }
      }
    }
  },

  // Only Hard CPUs see through a prank box (50 % per box, inside SEE_RANGE m): for everyone else it is
  // just another item box, so it is not listed as a threat.
  threats(ctx, kart, radius, push) {
    if (kart.isPlayer || ctx.difficulty() !== 'hard') return;
    const ki = ctx.karts.indexOf(kart);
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || (e.owner === kart)) continue;
      const dx = e.position.x - kart.position.x, dz = e.position.z - kart.position.z;
      const d = Math.hypot(dx, dz);
      if (d > Math.min(radius, SEE_RANGE) + e.radius || hash01(e.uid, ki) >= 0.5) continue;
      push(e, { radius: e.radius, clear: e.radius + 0.6, type: 'prank' });
    }
  },

  // ... and an empty-handed CPU that does not see through it goes for it like for an item box
  aiLure(ctx, kart, c) {
    if (kart.isPlayer || kart.item || kart.rolling) return null;
    const hard = ctx.difficulty() === 'hard', ki = ctx.karts.indexOf(kart);
    let best = null, bd = Infinity;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || e.owner === kart) continue;
      const ds = ctx.deltaS(c.s, e.s);
      if (ds < 6 || ds > 42 || ds >= bd) continue;
      if (hard && hash01(e.uid, ki) < 0.5 && ds < SEE_RANGE + 10) continue;     // seen through
      if (Math.abs(e.lateral - c.plannedLat(e.s)) > 4.5) continue;
      bd = ds; best = e;
    }
    return best ? { s: best.s, lateral: best.lateral, urgency: 0.3 * (c.skill || 0.7) } : null;
  },

  onEntityRemove(ctx, e, reason) {
    if (!ctx.effects || reason === 'clear' || reason === 'expire') return;
    _p.copy(e.position);
    ctx.effects.emit('confetti', _p, { count: reason === 'hit' ? 46 : 24, spread: 7, size: 0.18 });
    ctx.effects.emit('sparkle', _p, { count: 10, color: 0xff6bf0, spread: 3, radius: 0.6 });
  },

  aiUse(kart, c) {
    const rows = c.track.itemRows || [];
    for (const row of rows) {
      const ds = c.track.deltaS(row.s, c.s);
      if (ds > 1 && ds < 8) return true;                 // just past a box row: it blends in
    }
    if (c.rivalBehind(1.5, 15, 3.2)) return true;
    return c.hold > 8;
  },

  // ---------------------------------------------------------------- visuals
  initVisuals(ctx) {
    const T = THREE;
    const n = CAP + 2;
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) phase[i] = (i * 0.618034 + 0.31) % 1;
    const geo = ctx.own(new RoundedBoxGeometry(BOX, BOX, BOX, 3, 0.2));
    geo.setAttribute('aPhase', new T.InstancedBufferAttribute(phase, 1));
    const mat = new T.ShaderMaterial({
      uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, { uTime: { value: 0 }, uHalf: { value: BOX / 2 }, uTell: { value: ITEM5.prankTell }, uTint: { value: new T.Color(0xd21cff) } }]),
      vertexShader: BOX_VERT, fragmentShader: BOX_FRAG, transparent: true, depthWrite: false, fog: true, toneMapped: false,
    });
    ctx.state.box = ctx.instanced(geo, mat, n, 'prank-boxes', { shadow: true, order: 3 });
    ctx.state.boxU = mat.uniforms;
    const qgeo = ctx.own(new T.PlaneGeometry(0.98, 0.98));
    qgeo.setAttribute('aPhase', new T.InstancedBufferAttribute(phase.slice(), 1));
    const qmat = new T.ShaderMaterial({
      uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, { uTime: { value: 0 }, uTell: { value: ITEM5.prankTell }, mapQ: { value: null }, mapGrin: { value: null } }]),
      vertexShader: MARK_VERT, fragmentShader: MARK_FRAG, fog: true, toneMapped: false,
    });
    qmat.uniforms.mapQ.value = ctx.own(markTexture('q'));
    qmat.uniforms.mapGrin.value = ctx.own(markTexture('grin'));
    ctx.state.mark = ctx.instanced(qgeo, qmat, n, 'prank-marks', { shadow: false, order: 2 });
    ctx.state.markU = qmat.uniforms;
  },

  updateVisuals(ctx) {
    const box = ctx.state.box, mark = ctx.state.mark;
    if (!box) return;
    const t = ctx.vis && Number.isFinite(ctx.vis.time) ? ctx.vis.time : ctx.time;
    ctx.state.boxU.uTime.value = t;
    ctx.state.markU.uTime.value = t;
    let i = 0;
    const cap = box.instanceMatrix.count;
    for (const e of ctx.sys.entities) {
      if (e.plugin !== ctx || !e.active || i >= cap) continue;
      const pop = Math.min(1, e.age / 0.32);
      const left = e.life - e.age;
      const sc = (pop < 1 ? 0.3 + 0.7 * pop : 1) * (left < 0.5 ? Math.max(0.01, left / 0.5) : 1);
      const ph = e.data.phase * 6.283;
      _p.copy(e.position);
      _p.y += Math.sin(t * 2.1 + ph) * 0.12 + e.data.drop * (1 - pop) * (1 - pop);
      _e.set(0.42, t * 1.25 + ph, 0.42, 'YXZ');
      _q.setFromEuler(_e);
      _s.setScalar(sc);
      box.setMatrixAt(i, _m.compose(_p, _q, _s));
      _q.identity();
      mark.setMatrixAt(i, _m.compose(_p, _q, _s));
      i++;
    }
    box.count = mark.count = i;
    box.visible = mark.visible = i > 0;
    box.instanceMatrix.needsUpdate = true;
    mark.instanceMatrix.needsUpdate = true;
  },

  callout: 'PRANKED!',
});
