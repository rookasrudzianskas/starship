import * as THREE from 'three';
import { FbmLattice, dataTexture, generatedOnce, seededRandom } from '@/lib/three/vehicles/procedural';

/**
 * Shared billboard particle machinery for the effects: lumpy "puff" sprites (fire, smoke, steam, spray)
 * and axis-aligned "streaks" (glowing debris, smoke-trail segments, water jets), drawn together in one
 * instanced, depth-sorted batch so they layer correctly against each other. Particle state is computed
 * on the CPU every frame from pure functions of time.
 *
 * Shading: premultiplied-alpha blending (ONE, ONE_MINUS_SRC_ALPHA) so a single draw can mix occluding
 * smoke (rgb·a, a) with additive incandescence (rgb, 0). Smoke is lit like a MeshStandardMaterial
 * would be by the scene's DirectionalLight (sun) and HemisphereLight (sky/ground), found in the scene
 * at render time, so it matches the vehicles under any sun colour.
 */

// ---------------------------------------------------------------------------
// Puff atlas: 2×2 billowy puff variants, 256² each.
// R = density, G/B = view-plane normal x/y (encoded 0..1), A = turbulent detail (fire tongues, erosion).
// ---------------------------------------------------------------------------

export const PUFF_ATLAS_KEY = 'fx:puffAtlas';

function puffAtlasPixels(): Uint8Array {
  const cell = 256;
  const size = cell * 2;
  const data = new Uint8Array(size * size * 4);
  const field = new Float32Array(cell * cell);
  for (let v = 0; v < 4; v++) {
    const rnd = seededRandom(9001 + v * 131);
    // Gaussian metaballs around a dense core; their sum is a smooth, lumpy "cauliflower" field.
    const blobs: Array<{ x: number; y: number; k: number }> = [{ x: 0, y: 0, k: 1 / (0.36 * 0.36) }];
    const nb = 14 + Math.floor(rnd() * 6);
    for (let k = 0; k < nb; k++) {
      const r = 0.12 + rnd() * 0.2;
      const ang = rnd() * Math.PI * 2;
      const off = Math.sqrt(rnd()) * Math.min(0.78 - r, 0.5);
      blobs.push({ x: Math.cos(ang) * off, y: Math.sin(ang) * off, k: 1 / (r * r) });
    }
    // Noise lattices over exactly the coordinate ranges sampled below (same values as tileFbm).
    const warpX = new FbmLattice(-3 + v * 5.1, -3, 3 + v * 5.1, 3, 64, 64, 3, 100 + v);
    const warpY = new FbmLattice(-3, -3 + v * 2.3, 3, 3 + v * 2.3, 64, 64, 3, 200 + v);
    const fineN = new FbmLattice(-7 + v * 1.7, -7 - v * 2.9, 7 + v * 1.7, 7 - v * 2.9, 64, 64, 4, 500 + v);
    const turbN = new FbmLattice(-5 + v * 4.1, -5 + v * 6.7, 5 + v * 4.1, 5 + v * 6.7, 64, 64, 5, 700 + v);
    for (let j = 0; j < cell; j++) {
      for (let i = 0; i < cell; i++) {
        const x0 = ((i + 0.5) / cell) * 2 - 1;
        const y0 = ((j + 0.5) / cell) * 2 - 1;
        // Domain warp so outlines are ragged rather than circular.
        const x = x0 + (warpX.sample(x0 * 3 + v * 5.1, y0 * 3) - 0.5) * 0.16;
        const y = y0 + (warpY.sample(x0 * 3, y0 * 3 + v * 2.3) - 0.5) * 0.16;
        let f = 0;
        for (const b of blobs) {
          const dx = x - b.x;
          const dy = y - b.y;
          const e = (dx * dx + dy * dy) * b.k;
          // Beyond e = 14 a blob adds less than 1e-6: skip the exp.
          if (e < 14) f += Math.exp(-e);
        }
        field[j * cell + i] = f;
      }
    }
    const ox = (v % 2) * cell;
    const oy = Math.floor(v / 2) * cell;
    const pix = 2 / cell;
    for (let j = 0; j < cell; j++) {
      for (let i = 0; i < cell; i++) {
        const x = ((i + 0.5) / cell) * 2 - 1;
        const y = ((j + 0.5) / cell) * 2 - 1;
        const r = Math.sqrt(x * x + y * y);
        const f = field[j * cell + i];
        const fx0 = field[j * cell + Math.max(i - 2, 0)];
        const fx1 = field[j * cell + Math.min(i + 2, cell - 1)];
        const fy0 = field[Math.max(j - 2, 0) * cell + i];
        const fy1 = field[Math.min(j + 2, cell - 1) * cell + i];
        // Normal of the field treated as a height map (bumps face outwards at the rim).
        const k = 0.22;
        let gx = ((fx1 - fx0) / (4 * pix)) * k;
        let gy = ((fy1 - fy0) / (4 * pix)) * k;
        // Add a radial bulge so the whole puff reads as a rounded volume.
        gx -= x * 1.1;
        gy -= y * 1.1;
        const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        const nx = -gx * inv;
        const ny = -gy * inv;
        const fine = fineN.sample(x * 7 + v * 1.7, y * 7 - v * 2.9);
        const window = 1 - Math.min(Math.max((r - 0.8) / 0.18, 0), 1);
        const t = Math.min(Math.max((f - 0.16) / 1.25, 0), 1);
        const dens = t * t * (3 - 2 * t) * (0.55 + 0.45 * fine) * window;
        // Ridged turbulence for fire tongues and wispy erosion.
        const turb = turbN.sample(x * 5 + v * 4.1, y * 5 + v * 6.7);
        const ridged = 1 - Math.abs(turb * 2 - 1);
        const detail = Math.min(Math.max(0.1 + ridged * 0.85 + (fine - 0.5) * 0.5, 0), 1);
        const o = ((oy + j) * size + ox + i) * 4;
        data[o] = Math.round(Math.min(Math.max(dens, 0), 1) * 255);
        data[o + 1] = Math.round((Math.min(Math.max(nx, -1), 1) * 0.5 + 0.5) * 255);
        data[o + 2] = Math.round((Math.min(Math.max(ny, -1), 1) * 0.5 + 0.5) * 255);
        data[o + 3] = Math.round(detail * 255);
      }
    }
  }
  return data;
}

export function makePuffAtlas(): THREE.DataTexture {
  const tex = dataTexture(generatedOnce(PUFF_ATLAS_KEY, puffAtlasPixels), 512, 512, { srgb: false, repeat: false, mipmaps: true, anisotropy: 1 });
  tex.name = 'fx-puff-atlas';
  return tex;
}

// ---------------------------------------------------------------------------
// Scene lighting lookup
// ---------------------------------------------------------------------------

/**
 * Finds the scene's sun (first DirectionalLight) and sky light (first HemisphereLight). The stage lights
 * PBR materials with the sun plus scene.environment only, so without a HemisphereLight the sky/ground
 * ambient is a daylight default scaled by the sun's intensity (dark at night), and `up` is left to the
 * caller (ParticleBatch uses its object's +Y; orient effects with +Y = local up).
 */
export class EffectLights {
  readonly sunDir = new THREE.Vector3(0.45, 0.75, 0.48).normalize();
  readonly sunColor = new THREE.Color(3.1, 3.0, 2.85);
  readonly skyColor = new THREE.Color(0.23, 0.38, 0.7);
  readonly groundColor = new THREE.Color(0.06, 0.055, 0.045);
  readonly up = new THREE.Vector3(0, 1, 0);
  /** True when a HemisphereLight was found (then `up` and the ambient colours come from it). */
  hasSky = false;
  private scene: THREE.Object3D | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private hemi: THREE.HemisphereLight | null = null;
  private frames = 0;
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();

  update(scene: THREE.Object3D): void {
    this.frames++;
    const stale = (this.sun && !this.sun.parent) || (this.hemi && !this.hemi.parent);
    if (scene !== this.scene || stale || this.frames % 120 === 0) {
      this.scene = scene;
      this.sun = null;
      this.hemi = null;
      const visit = (o: THREE.Object3D) => {
        if (!this.sun && (o as THREE.DirectionalLight).isDirectionalLight) this.sun = o as THREE.DirectionalLight;
        if (!this.hemi && (o as THREE.HemisphereLight).isHemisphereLight) this.hemi = o as THREE.HemisphereLight;
      };
      for (const c of scene.children) visit(c);
      if (!this.sun || !this.hemi) scene.traverse(visit);
    }
    if (this.sun) {
      this.a.setFromMatrixPosition(this.sun.matrixWorld);
      this.b.setFromMatrixPosition(this.sun.target.matrixWorld);
      const d = this.a.sub(this.b);
      if (d.lengthSq() > 1e-12) this.sunDir.copy(d).normalize();
      this.sunColor.copy(this.sun.color).multiplyScalar(this.sun.visible ? this.sun.intensity : 0);
    }
    this.hasSky = this.hemi !== null;
    if (this.hemi) {
      const k = this.hemi.visible ? this.hemi.intensity : 0;
      this.skyColor.copy(this.hemi.color).multiplyScalar(k);
      this.groundColor.copy(this.hemi.groundColor).multiplyScalar(k);
      this.a.setFromMatrixPosition(this.hemi.matrixWorld);
      if (this.a.lengthSq() > 1e-12) this.up.copy(this.a).normalize();
    } else {
      // Daylight sky ambient scaled by how bright the sun is (~3 at noon in the stage).
      const k = this.sun ? Math.min(1.4, Math.max(0.04, (this.sun.visible ? this.sun.intensity : 0) / 3)) : 1;
      this.skyColor.setRGB(0.23 * k, 0.38 * k, 0.7 * k);
      this.groundColor.setRGB(0.06 * k, 0.055 * k, 0.045 * k);
    }
  }
}

// ---------------------------------------------------------------------------
// Shader (puffs and streaks in one program, selected per instance)
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute vec4 a0; // puff centre / streak head (object space, m), size (puff diameter / streak width, m)
attribute vec4 a1; // albedo rgb (linear), opacity
attribute vec4 a2; // emission rgb (HDR multiplier), temperature (puffs: drives the fire ramp)
attribute vec4 a3; // puff: rotation, atlas cell (4 = smooth glow), erosion, glow weight | streak: unit dir xyz, length
attribute vec4 a4; // mode (0 puff, 1 streak), taper (streak: 1 fades to the tail, 0 uniform segment), seed, unused
uniform vec3 uSunDir;
uniform vec3 uUp;
uniform vec3 uGlowPos;
uniform vec3 uSunLocal;
uniform vec4 uShadow; // xyz bulk centre (object space), w radius (0 = off)
uniform float uAoHeight; // > 0: particles near the ground (object y) are occluded by the cloud above
uniform float uFade; // whole-batch opacity (dims a cloud the camera has flown into)
varying vec2 vUv;
varying vec2 vRot;
varying vec4 vColor;
varying vec4 vEmit;
varying vec4 vMisc; // puff: cell, erosion, glow | streak: cap fraction, aspect (length/width), seed, taper
varying float vMode;
varying vec3 vSunV;
varying vec3 vUpV;
varying vec3 vGlowV;
varying vec3 vSideV;
varying float vHeight;
varying float vNear;
varying float vExposure;
varying float vAo;
void main() {
  vMode = a4.x;
  vColor = a1;
  vEmit = a2;
  vSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  vUpV = normalize((viewMatrix * vec4(uUp, 0.0)).xyz);
  vec3 p;
  vec3 centre;
  if (a4.x < 0.5) {
    // Camera-facing sprite, rotated in the view plane.
    float c = cos(a3.x);
    float s = sin(a3.x);
    vec2 corner = position.xy;
    vec2 rc = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * a0.w;
    vec4 mv = modelViewMatrix * vec4(a0.xyz, 1.0);
    // Fade sprites the camera is inside of instead of letting them pop through the near plane.
    vNear = smoothstep(0.15 * a0.w, 0.6 * a0.w, -mv.z) * uFade;
    p = mv.xyz + vec3(rc, 0.0);
    vUv = corner + 0.5;
    vRot = vec2(c, s);
    vMisc = vec4(a3.yzw, 0.0);
    vSideV = vec3(1.0, 0.0, 0.0);
    // Object-space height of this corner (the inverse of a rigid modelView is its transpose).
    vHeight = a0.y + (vec3(rc, 0.0) * mat3(modelViewMatrix)).y;
    centre = a0.xyz;
  } else {
    // Axial billboard from tail to head, widened across the view ray, with half-width caps.
    vec3 tailL = a0.xyz - a3.xyz * a3.w;
    vec3 hv = (modelViewMatrix * vec4(a0.xyz, 1.0)).xyz;
    vec3 tv = (modelViewMatrix * vec4(tailL, 1.0)).xyz;
    vec3 axis = hv - tv;
    float len = length(axis);
    vec3 ax = len > 1e-4 ? axis / len : vec3(0.0, 1.0, 0.0);
    float along = position.y + 0.5;
    p = mix(tv, hv, along);
    vec3 side = cross(normalize(p), ax);
    float sl = length(side);
    side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
    p += side * position.x * a0.w + ax * position.y * a0.w;
    vNear = smoothstep(0.1 * a0.w, 0.5 * a0.w, -p.z) * uFade;
    vUv = vec2(position.x * 2.0, along);
    vRot = vec2(1.0, 0.0);
    float total = a3.w + a0.w;
    vMisc = vec4(a0.w / max(total, 1e-3), total / max(a0.w, 1e-3), a4.z, a4.y);
    vSideV = side;
    vHeight = mix(tailL, a0.xyz, along).y;
    centre = mix(tailL, a0.xyz, 0.5);
  }
  gl_Position = projectionMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
  vec4 mvPosition = vec4(p, 1.0);
  #include <fog_vertex>
  vec3 g = (modelViewMatrix * vec4(uGlowPos - centre, 0.0)).xyz;
  vGlowV = g / max(length(g), 1e-3);
  // Crude self-shadowing of the whole cloud: particles on the far side from the sun get less direct light.
  vExposure = 1.0;
  if (uShadow.w > 0.0) {
    float k = dot(centre - uShadow.xyz, uSunLocal) / uShadow.w;
    vExposure = mix(0.3, 1.0, smoothstep(-0.95, 0.55, k));
  }
  vAo = uAoHeight > 0.0 ? mix(0.5, 1.0, smoothstep(0.0, uAoHeight, centre.y)) : 1.0;
}`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uAtlas;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uGlowColor;
uniform float uGroundFade;
varying vec2 vUv;
varying vec2 vRot;
varying vec4 vColor;
varying vec4 vEmit;
varying vec4 vMisc;
varying float vMode;
varying vec3 vSunV;
varying vec3 vUpV;
varying vec3 vGlowV;
varying vec3 vSideV;
varying float vHeight;
varying float vNear;
varying float vExposure;
varying float vAo;

vec3 toOutput(vec3 c) {
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
// Black-body-ish ramp for incandescent gas: T 0 = cold, 1 = white hot. HDR brightness rises steeply with T.
vec3 fireRamp(float T) {
  T = clamp(T, 0.0, 1.3);
  vec3 c = mix(vec3(0.0), vec3(0.50, 0.045, 0.006), smoothstep(0.24, 0.42, T));
  c = mix(c, vec3(1.0, 0.30, 0.04), smoothstep(0.38, 0.6, T));
  c = mix(c, vec3(1.0, 0.66, 0.22), smoothstep(0.56, 0.82, T));
  c = mix(c, vec3(1.0, 0.93, 0.80), smoothstep(0.8, 1.1, T));
  return c * (0.25 + 4.5 * T * T * T);
}
vec3 fogColor0() {
  #ifdef USE_FOG
    return fogColor;
  #else
    return vec3(0.0);
  #endif
}
float hash11(float x) {
  x = fract(x * 0.1031);
  x *= x + 33.33;
  x *= x + x;
  return fract(x);
}
float vnoise(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}

void main() {
  #include <logdepthbuf_fragment>
  float a;
  float dens;
  float detail;
  float r2;
  vec3 n;
  if (vMode < 0.5) {
    vec2 q = vUv * 2.0 - 1.0;
    r2 = dot(q, q);
    float cell = vMisc.x;
    vec2 nt;
    if (cell > 3.5) {
      // Smooth radial glow (flashes, halos).
      dens = max(exp(-5.0 * r2) - 0.0067, 0.0);
      detail = 0.6;
      nt = q * 0.6;
    } else {
      vec2 origin = vec2(mod(cell, 2.0), floor(cell * 0.5)) * 0.5;
      vec4 tex = texture2D(uAtlas, origin + clamp(vUv, 0.004, 0.996) * 0.5);
      dens = tex.r;
      detail = tex.a;
      nt = tex.gb * 2.0 - 1.0;
    }
    // Erosion: as a puff dissipates its thin, turbulent parts vanish first (wispy edges).
    float er = vMisc.y;
    float shape = dens * (0.7 + 0.6 * detail);
    a = smoothstep(er, er + 0.5, shape) * clamp(dens * 2.0, 0.0, 1.0) * vColor.a * vNear;
    // Softened normal: scattering media show gentle, not rock-hard, shading.
    vec2 n2 = vec2(vRot.x * nt.x - vRot.y * nt.y, vRot.y * nt.x + vRot.x * nt.y) * 0.42;
    n = vec3(n2, sqrt(max(1.0 - dot(n2, n2), 0.0)));
  } else {
    float cap = vMisc.x;
    float aspect = vMisc.y;
    float seed = vMisc.z;
    float taper = vMisc.w;
    float y = vUv.y;
    // Smoke-trail segments get an irregular width and density along their length.
    float nz = vnoise(seed * 13.7 + y * aspect * 0.8);
    float wid = mix(0.6 + 0.5 * nz, 1.0, taper);
    float x = vUv.x / wid;
    float across = 1.0 - smoothstep(0.2, 1.0, abs(x));
    float tapered = smoothstep(0.0, 0.75, y) * (1.0 - smoothstep(0.93, 1.0, y) * 0.5);
    // Segment ends fade over exactly the overlap with the neighbouring segment, so joints stay seamless.
    float segment = sqrt(smoothstep(0.0, cap, y) * (1.0 - smoothstep(1.0 - cap, 1.0, y)));
    dens = across * mix(segment * (0.55 + 0.45 * nz), tapered, taper);
    detail = 0.6;
    r2 = 0.0;
    a = dens * vColor.a * vNear;
    float xs = clamp(x, -1.0, 1.0);
    n = normalize(vSideV * xs * 0.8 + vec3(0.0, 0.0, 1.0) * sqrt(1.0 - xs * xs * 0.64));
  }
  if (uGroundFade > 0.0) a *= smoothstep(0.0, uGroundFade, vHeight);

  float ndl = dot(n, vSunV);
  // Wrapped diffuse plus a multiple-scattering floor: dense steam and smoke are never pitch black on the
  // shadow side. Forward scattering makes thin parts glow when the sun is behind them (silver lining).
  float diffuse = clamp((ndl + 0.5) / 1.5, 0.0, 1.0);
  float fwd = pow(clamp(-vSunV.z, 0.0, 1.0), 5.0);
  float sunTerm = diffuse * 0.72 + 0.28 + fwd * (0.35 + 1.8 * (1.0 - smoothstep(0.05, 0.6, dens)));
  float hemi = dot(n, vUpV) * 0.5 + 0.5;
  vec3 irr = uSunColor * sunTerm * vExposure * mix(0.75, 1.0, vAo)
    + mix(uGroundColor, uSkyColor, hemi) * 1.5 * mix(0.7, 1.0, vExposure) * vAo;
  irr += uGlowColor * vMisc.z * step(vMode, 0.5) * clamp(dot(n, vGlowV) * 0.65 + 0.45, 0.0, 1.0);
  vec3 lit = vColor.rgb * irr * RECIPROCAL_PI;

  vec3 emission;
  if (vMode < 0.5) {
    // Incandescence: hotter in the core and in the turbulent tongues of the texture.
    float T = vEmit.a * (0.5 + 0.75 * detail) * (1.2 - 0.55 * r2);
    emission = vEmit.rgb * fireRamp(T) * smoothstep(0.02, 0.4, dens) * vNear;
  } else {
    emission = vEmit.rgb * dens * (0.35 + 0.65 * vUv.y) * vNear;
  }

  // Fog is mixed in display space like three's built-in materials (the Earth module supplies a matching
  // colour): it replaces the lit colour of the occluding part and dims the additive glow.
  float fogF = 0.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  vec3 rgb = mix(toOutput(lit), fogColor0(), fogF) * a + toOutput(emission) * (1.0 - fogF);
  if (a < 0.002 && rgb.r + rgb.g + rgb.b < 0.004) discard;
  gl_FragColor = vec4(rgb, a);
}`;

// ---------------------------------------------------------------------------
// Particle batch
// ---------------------------------------------------------------------------

const STRIDE = 20;

export const MODE_PUFF = 0;
export const MODE_STREAK = 1;

/** One particle record (reused by callers to avoid allocations). */
export interface ParticleRecord {
  x: number;
  y: number;
  z: number;
  /** Puff diameter or streak width, m. */
  size: number;
  r: number;
  g: number;
  b: number;
  opacity: number;
  er: number;
  eg: number;
  eb: number;
  /** Puff temperature (0..1.3) for the fire ramp. */
  temp: number;
  /** Puff: rotation, atlas cell, erosion, glow weight. Streak: direction xyz (unit), length. */
  m0: number;
  m1: number;
  m2: number;
  m3: number;
  /** MODE_PUFF or MODE_STREAK. */
  mode: number;
  /** Streaks: 1 = fades towards the tail (sparks, jets), 0 = uniform segment (trails). */
  taper: number;
  /** Streaks: noise seed for irregular trails. */
  seed: number;
}

export function newRecord(): ParticleRecord {
  return { x: 0, y: 0, z: 0, size: 1, r: 1, g: 1, b: 1, opacity: 1, er: 0, eg: 0, eb: 0, temp: 0, m0: 0, m1: 0, m2: 0, m3: 0, mode: 0, taper: 1, seed: 0 };
}

export interface BillboardUniforms {
  [name: string]: THREE.IUniform;
  uAtlas: THREE.IUniform<THREE.Texture | null>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSkyColor: THREE.IUniform<THREE.Color>;
  uGroundColor: THREE.IUniform<THREE.Color>;
  uUp: THREE.IUniform<THREE.Vector3>;
  uGlowPos: THREE.IUniform<THREE.Vector3>;
  uGlowColor: THREE.IUniform<THREE.Color>;
  uGroundFade: THREE.IUniform<number>;
  uSunLocal: THREE.IUniform<THREE.Vector3>;
  uShadow: THREE.IUniform<THREE.Vector4>;
  uAoHeight: THREE.IUniform<number>;
  uFade: THREE.IUniform<number>;
}

/** Render order of the part of an axis-split batch that lies behind the vehicle (see Billboards). */
export const BEHIND_AXIS_ORDER = -20;

interface InstanceBuffers {
  geo: THREE.InstancedBufferGeometry;
  attrs: THREE.InstancedBufferAttribute[];
}

function instanceBuffers(capacity: number): InstanceBuffers {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const attrs: THREE.InstancedBufferAttribute[] = [];
  for (let k = 0; k < 5; k++) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(`a${k}`, a);
    attrs.push(a);
  }
  geo.instanceCount = 0;
  return { geo, attrs };
}

/**
 * A batch of instanced particles drawn in one call. Fill it each frame with begin()/add()/finish();
 * finish() depth-sorts for the main camera (setCamera, or else the first view drawn after the last
 * refill). If the batch is not refilled, the next render re-sorts on camera motion (uploaded one frame
 * later, which is invisible).
 *
 * `splitAtAxis`: for clouds a rocket stands or rises in (liftoff steam, a landing burn into the sea), the
 * batch is split in two draws around the local +Y axis. Particles farther from the camera than the axis
 * go into a child mesh drawn before the engine plumes (BEHIND_AXIS_ORDER); the rest draw after them, so
 * steam in front of the exhaust hides it while steam behind it does not.
 */
export class Billboards {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly uniforms: BillboardUniforms;
  readonly lights = new EffectLights();
  /**
   * Opacity left when the camera is deep inside the cloud's bulk (uShadow): a camera that ends up inside a
   * splash or a fireball would otherwise see nothing but a wall of overlapping sprites. 1 = never dim.
   */
  insideFade = 1;
  private readonly front: InstanceBuffers;
  private readonly back: InstanceBuffers | null;
  private readonly stage: Float32Array;
  private readonly sortPos: Float32Array;
  private readonly keys: Float32Array;
  private order: number[] = [];
  private n = 0;
  /** Camera of the view being drawn, and the one finish() sorts for (object space). */
  private readonly cam = new THREE.Vector3(0, 0, 1e9);
  private readonly sortCam = new THREE.Vector3(0, 0, 1e9);
  private readonly lastSortCam = new THREE.Vector3(1e9, 1e9, 1e9);
  private refilled = false;
  private readonly tmpM = new THREE.Matrix4();

  constructor(
    readonly capacity: number,
    atlas: THREE.Texture | null,
    splitAtAxis = false,
  ) {
    this.front = instanceBuffers(capacity);
    this.back = splitAtAxis ? instanceBuffers(capacity) : null;
    this.stage = new Float32Array(capacity * STRIDE);
    this.sortPos = new Float32Array(capacity * 3);
    this.keys = new Float32Array(capacity);

    this.uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uAtlas: { value: atlas },
      uSunDir: { value: this.lights.sunDir },
      uSunColor: { value: this.lights.sunColor },
      uSkyColor: { value: this.lights.skyColor },
      uGroundColor: { value: this.lights.groundColor },
      uUp: { value: this.lights.up },
      uGlowPos: { value: new THREE.Vector3() },
      uGlowColor: { value: new THREE.Color(0, 0, 0) },
      uGroundFade: { value: 0 },
      uSunLocal: { value: new THREE.Vector3(0, 1, 0) },
      uShadow: { value: new THREE.Vector4(0, 0, 0, 0) },
      uAoHeight: { value: 0 },
      uFade: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Premultiplied alpha: smoke occludes (rgb·a, a), incandescence adds (rgb, 0).
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const onBeforeRender = (_renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => {
      this.lights.update(scene);
      // No sky light to tell us where up is: use this effect's own +Y (the stage orients it).
      if (!this.lights.hasSky) this.lights.up.set(0, 1, 0).transformDirection(this.mesh.matrixWorld);
      // Sun direction in object space for the cloud self-shadowing term.
      this.tmpM.copy(this.mesh.matrixWorld).invert();
      this.uniforms.uSunLocal.value.copy(this.lights.sunDir).transformDirection(this.tmpM);
      this.cam.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.tmpM);
      // The first view drawn after a refill is the main one; later views this frame are extra views.
      if (this.refilled) this.sortCam.copy(this.cam);
      const bulk = this.uniforms.uShadow.value;
      let fade = 1;
      if (this.insideFade < 1 && bulk.w > 0) {
        const d = Math.hypot(this.cam.x - bulk.x, this.cam.y - bulk.y, this.cam.z - bulk.z);
        fade = mix(this.insideFade, 1, smooth(0.6 * bulk.w, 1.15 * bulk.w, d));
      }
      this.uniforms.uFade.value = fade;
      // A split batch keeps the main view's split (its two draw counts must match the uploaded data).
      if (!this.back && !this.refilled && this.n > 1 && this.cam.distanceToSquared(this.lastSortCam) > 1) {
        this.writeSorted(this.cam);
      }
      this.refilled = false;
    };
    this.mesh = new THREE.Mesh(this.front.geo, material);
    this.mesh.onBeforeRender = onBeforeRender;
    const meshes = [this.mesh];
    if (this.back) {
      // A child with an identity transform: same frame, shown whenever the batch is.
      const backMesh = new THREE.Mesh(this.back.geo, material);
      backMesh.name = 'billboards-behind-axis';
      backMesh.renderOrder = BEHIND_AXIS_ORDER;
      backMesh.onBeforeRender = onBeforeRender;
      this.mesh.add(backMesh);
      meshes.push(backMesh);
    }
    for (const m of meshes) {
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
    }
    this.mesh.visible = false;
  }

  /** Sets the camera finish() sorts for, from a world-space camera (updates this mesh's world matrix first). */
  setCamera(camera: THREE.Camera): void {
    this.mesh.updateWorldMatrix(true, false);
    this.tmpM.copy(this.mesh.matrixWorld).invert();
    this.sortCam.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.tmpM);
  }

  begin(): void {
    this.n = 0;
  }

  get count(): number {
    return this.n;
  }

  add(p: ParticleRecord): void {
    if (this.n >= this.capacity) return;
    const s = this.stage;
    const o = this.n * STRIDE;
    s[o] = p.x;
    s[o + 1] = p.y;
    s[o + 2] = p.z;
    s[o + 3] = p.size;
    s[o + 4] = p.r;
    s[o + 5] = p.g;
    s[o + 6] = p.b;
    s[o + 7] = p.opacity;
    s[o + 8] = p.er;
    s[o + 9] = p.eg;
    s[o + 10] = p.eb;
    s[o + 11] = p.temp;
    s[o + 12] = p.m0;
    s[o + 13] = p.m1;
    s[o + 14] = p.m2;
    s[o + 15] = p.m3;
    s[o + 16] = p.mode;
    s[o + 17] = p.taper;
    s[o + 18] = p.seed;
    s[o + 19] = 0;
    // Sort streaks by their midpoint.
    const sp = this.n * 3;
    const half = p.mode > 0.5 ? p.m3 * 0.5 : 0;
    this.sortPos[sp] = p.x - (p.mode > 0.5 ? p.m0 * half : 0);
    this.sortPos[sp + 1] = p.y - (p.mode > 0.5 ? p.m1 * half : 0);
    this.sortPos[sp + 2] = p.z - (p.mode > 0.5 ? p.m2 * half : 0);
    this.n++;
  }

  /** Sorts back to front for the main camera and uploads. */
  finish(): void {
    this.writeSorted(this.sortCam);
    this.refilled = true;
    this.mesh.visible = this.n > 0;
  }

  /** Opacity-and-size weighted centre and RMS radius of the staged puffs (for the self-shadow uniform). */
  bulk(target: THREE.Vector4, minOpacity = 0.05): THREE.Vector4 {
    const s = this.stage;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const o = i * STRIDE;
      const k = s[o + 16] < 0.5 && s[o + 7] > minOpacity ? s[o + 3] * s[o + 7] : 0;
      sx += s[o] * k;
      sy += s[o + 1] * k;
      sz += s[o + 2] * k;
      w += k;
    }
    if (w <= 0) return target.set(0, 0, 0, 0);
    sx /= w;
    sy /= w;
    sz /= w;
    let r2 = 0;
    for (let i = 0; i < this.n; i++) {
      const o = i * STRIDE;
      const k = s[o + 16] < 0.5 && s[o + 7] > minOpacity ? s[o + 3] * s[o + 7] : 0;
      const dx = s[o] - sx;
      const dy = s[o + 1] - sy;
      const dz = s[o + 2] - sz;
      const rr = Math.sqrt(dx * dx + dy * dy + dz * dz) + s[o + 3] * 0.35;
      r2 += rr * rr * k;
    }
    return target.set(sx, sy, sz, Math.sqrt(r2 / w));
  }

  private writeSorted(c: THREE.Vector3): void {
    const n = this.n;
    const s = this.stage;
    const sp = this.sortPos;
    const order = this.order;
    order.length = n;
    for (let i = 0; i < n; i++) {
      const dx = sp[i * 3] - c.x;
      const dy = sp[i * 3 + 1] - c.y;
      const dz = sp[i * 3 + 2] - c.z;
      this.keys[i] = dx * dx + dy * dy + dz * dz;
      order[i] = i;
    }
    const keys = this.keys;
    order.sort((a, b) => keys[b] - keys[a]);
    const frontArrays = this.front.attrs.map((a) => a.array as Float32Array);
    const backArrays = this.back ? this.back.attrs.map((a) => a.array as Float32Array) : frontArrays;
    let nf = 0;
    let nb = 0;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      // Behind the axis: farther from the camera than the axis point at the same height.
      const dy = sp[i * 3 + 1] - c.y;
      const behind = this.back !== null && keys[i] > c.x * c.x + c.z * c.z + dy * dy;
      const arrays = behind ? backArrays : frontArrays;
      const d = (behind ? nb++ : nf++) * 4;
      const o = i * STRIDE;
      for (let j = 0; j < 5; j++) {
        const dst = arrays[j];
        const src = o + j * 4;
        dst[d] = s[src];
        dst[d + 1] = s[src + 1];
        dst[d + 2] = s[src + 2];
        dst[d + 3] = s[src + 3];
      }
    }
    for (const [buf, count] of [[this.front, nf], [this.back, nb]] as const) {
      if (!buf) continue;
      for (const a of buf.attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, Math.max(count, 1) * 4);
        a.needsUpdate = true;
      }
      buf.geo.instanceCount = count;
    }
    this.lastSortCam.copy(c);
  }

  dispose(): void {
    this.front.geo.dispose();
    this.back?.geo.dispose();
    this.mesh.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Small math helpers shared by the effects
// ---------------------------------------------------------------------------

export function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Random unit vector from two uniforms. */
export function sphereDir(u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const z = u * 2 - 1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = v * Math.PI * 2;
  return out.set(r * Math.cos(phi), z, r * Math.sin(phi));
}
