import * as THREE from 'three';

/**
 * Engine exhaust rendering. All parts are additive, unlit, depth-tested but not depth-writing, and
 * output HDR values that the ACES tone mapping rolls off to white.
 *
 * - PlumeCores: one instanced, camera-facing quad per nozzle (rotated about the engine axis towards the
 *   camera). The fragment shader reconstructs exact axial/radial coordinates from the world position,
 *   so the shape does not depend on the triangulation: Gaussian core whose radius follows the ambient
 *   pressure, Mach-disk "diamonds" and over-expanded pinching in thick air, flicker from a scrolling
 *   noise texture, blue-white core shading to orange (afterburning in air) or violet (at altitude).
 *   kind 0 = sea-level Raptor, 1 = Raptor Vacuum, 2 = hot-staging vent jet.
 * - PlumeVolume: the merged cluster plume beyond the nozzles, ray-marched through an analytic cone
 *   (Gaussian radial profile, widening and lengthening as the pressure falls, emission ∝ 1/area).
 *   Also used for the plasma wake behind an entering vehicle.
 * - PlumeGlow: a soft camera-facing sprite at the engine plane standing in for bloom.
 *
 * Close cameras (onboard views, a chase camera behind the engines) would otherwise look straight down a
 * long column of glowing gas or through a quad a metre away: the cores and the glow fade out near the
 * camera, and the volume drops samples next to the camera and dims while the camera is inside it.
 */

/**
 * Render order of the merged plume volume (the nozzle cores draw right after it): below the default 0 of the
 * effect particles, so steam and spray in front of the exhaust hide it (particles behind the vehicle draw
 * earlier still, see BEHIND_AXIS_ORDER in effects/particles.ts). The glow sprite draws after the particles:
 * it stands in for the light the flames scatter through the steam they stand in.
 */
export const PLUME_ORDER = -6;

/** 0 at sea level → 1 in vacuum (log of the pressure ratio). */
export function altitudeFactor(pressure: number): number {
  const a = Math.log10(101325 / Math.max(pressure, 0.001)) / 6.5;
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

// Raptor Vacuum's exhaust is nearly invisible in vacuum: a short bright core that spreads into a faint fan.
const COMMON_GLSL = /* glsl */ `
float plumeLenR(float kind, float alt) {
  return kind < 0.5 ? mix(16.0, 36.0, alt) : (kind < 1.5 ? mix(26.0, 44.0, alt) : 16.0);
}
float plumeSpread(float kind, float alt) {
  return kind < 0.5 ? mix(0.035, 0.6, alt * alt * (3.0 - 2.0 * alt)) : (kind < 1.5 ? mix(0.08, 0.3, alt) : 0.3);
}
`;

const CORE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aPlume;
uniform vec4 uShape;
varying vec3 vWorld;
varying vec3 vC;
varying vec3 vAxis;
varying vec3 vSide;
varying vec4 vP;
varying float vLenR;
${COMMON_GLSL}
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec3 c = (m * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 ax = (m * vec4(0.0, -1.0, 0.0, 0.0)).xyz;
  float sc = length(ax);
  ax /= sc;
  float R = aPlume.y * sc;
  vec3 toCam = normalize(cameraPosition - c);
  vec3 side = cross(ax, toCam);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : normalize(cross(ax, abs(ax.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  float kind = aPlume.z;
  float lenR = plumeLenR(kind, uShape.x) * (kind > 1.5 ? 1.0 : uShape.y);
  float spread = plumeSpread(kind, uShape.x);
  float s = position.y;
  float halfW = 1.3 + spread * s * lenR * 1.7 + 0.3;
  float on = step(0.002, aPlume.x);
  vec3 wp = c + (ax * (s * lenR * R) + side * (position.x * halfW * R)) * on;
  vWorld = wp;
  vC = c;
  vAxis = ax;
  vSide = side;
  // Fade the quad when it is seen end-on (the glow sprite and the volume cover that view).
  vP = vec4(aPlume.x * smoothstep(0.04, 0.35, sl), kind, aPlume.w, R);
  vLenR = lenR;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const CORE_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec4 uShape;
uniform float uTime;
uniform float uBright;
uniform vec2 uNear;
uniform sampler2D uNoise;
varying vec3 vWorld;
varying vec3 vC;
varying vec3 vAxis;
varying vec3 vSide;
varying vec4 vP;
varying float vLenR;
${COMMON_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  // A camera beside the nozzles (onboard views) sees the quad from a metre away: let it fade out there.
  float near = smoothstep(uNear.x, uNear.y, length(vWorld - cameraPosition));
  if (vP.x * near < 0.002) discard;
  vec3 d = vWorld - vC;
  float R = vP.w;
  float zr = dot(d, vAxis) / R;
  float xr = abs(dot(d, vSide)) / R;
  float kind = vP.y;
  float alt = uShape.x;
  float spread = plumeSpread(kind, alt);
  // Shock structure only exists in thick air (over-expanded sea-level nozzles).
  float sea = kind < 0.5 ? 1.0 - smoothstep(0.02, 0.2, alt) : 0.0;
  float lam = 3.3;
  float zc = max(zr - 0.8, 0.0);
  float cell = fract(zc / lam);
  // Shock train: strongest right at the nozzle, gone after five or six cells.
  float train = sea * smoothstep(0.4, 1.4, zr) * exp(-zr / 4.2) * (1.0 - smoothstep(2.5 * lam, 4.6 * lam, zr));
  float rc = 0.88 + zr * spread;
  rc *= 1.0 - 0.22 * train * sin(cell * 3.14159);
  float radial = exp(-2.3 * xr * xr / (rc * rc));
  float decayR = kind < 0.5 ? mix(5.0, 8.0, alt) : (kind < 1.5 ? mix(12.0, 9.0, alt) : 5.5);
  float envelope = smoothstep(-0.3, 0.4, zr) * (1.0 - smoothstep(vLenR * 0.35, vLenR, zr));
  float axial = exp(-zr / decayR) * envelope;
  // Mach disks: thin bright discs across the core at the end of each cell.
  float disk = exp(-pow((cell - 0.55) / 0.075, 2.0)) * exp(-4.0 * xr * xr / (rc * rc)) * train;
  float n = texture2D(uNoise, vec2(zr * 0.05 - uTime * 2.7 + vP.z, xr * 0.13 + vP.z * 3.7)).r;
  float n2 = texture2D(uNoise, vec2(zr * 0.017 - uTime * 1.3 + vP.z * 1.7, 0.37 + vP.z)).g;
  // In thick air the jet between the disks is translucent; the disks carry the brightness.
  float body = radial * axial * (0.62 + 0.5 * n + 0.3 * n2) / sqrt(max(rc, 1.0)) * mix(1.0, 0.42, sea);
  float eddy = 1.0;
  if (kind > 1.5) {
    // Hot-staging gas forced out through the vents is violently turbulent: billowing eddies, finer near the vent
    // and growing along the jet, carried outwards fast, with darker gaps between them and a ragged edge.
    float grow = 1.0 / (1.0 + zr * 0.08);
    float t1 = texture2D(uNoise, vec2(zr * 0.045 * grow - uTime * 1.6 + vP.z * 5.3, xr * 0.09 * grow + vP.z * 1.9)).b;
    float t2 = texture2D(uNoise, vec2(zr * 0.11 * grow - uTime * 2.9 + vP.z * 2.1, xr * 0.2 * grow - uTime * 0.4)).a;
    float turb = 0.65 * t1 + 0.35 * t2;
    float edge = exp(-2.3 * xr * xr / (rc * rc * (0.6 + 0.8 * turb)));
    eddy = smoothstep(0.3, 0.72, turb);
    body = edge * axial * (0.4 + 1.2 * eddy) / sqrt(max(rc, 1.0));
  }
  float I = vP.x * near * (body + disk * 3.6);
  vec3 hot = mix(vec3(0.9, 0.94, 1.0), vec3(0.86, 0.8, 1.0), sea);
  vec3 mid = mix(vec3(1.0, 0.56, 0.24), vec3(0.52, 0.38, 1.0), smoothstep(0.03, 0.28, alt));
  if (kind > 1.5) {
    // Yellow in the hot eddies, deep orange to red in the cooler gas round them.
    hot = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.85, 0.55), eddy);
    mid = mix(vec3(0.75, 0.2, 0.05), vec3(1.0, 0.42, 0.1), eddy);
  }
  float tcol = clamp(xr / rc * 0.6 + zr / (decayR * 2.0), 0.0, 1.0);
  vec3 col = mix(hot, mid, tcol);
  col = mix(col, vec3(1.0, 0.95, 0.88), clamp(disk * 2.0, 0.0, 1.0));
  gl_FragColor = vec4(col * I * uBright, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface CoreSlot {
  x: number;
  y: number;
  z: number;
  exitR: number;
  kind: number;
  /** Plume direction (default -Y). */
  dir?: THREE.Vector3;
}

export class PlumeCores {
  readonly mesh: THREE.InstancedMesh;
  readonly uniforms: {
    uShape: { value: THREE.Vector4 };
    uTime: { value: number };
    uBright: { value: number };
    /** Distance from the camera (m) inside which the cores are invisible, and beyond which they are whole. */
    uNear: { value: THREE.Vector2 };
    uNoise: { value: THREE.Texture };
  };
  private readonly attr: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;

  constructor(slots: CoreSlot[], noise: THREE.Texture) {
    this.geo = new THREE.PlaneGeometry(2, 1, 1, 1);
    this.geo.translate(0, 0.5, 0);
    const data = new Float32Array(slots.length * 4);
    slots.forEach((s, i) => {
      data[i * 4] = 0;
      data[i * 4 + 1] = s.exitR;
      data[i * 4 + 2] = s.kind;
      data[i * 4 + 3] = (i * 0.6180339) % 1;
    });
    this.attr = new THREE.InstancedBufferAttribute(data, 4);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aPlume', this.attr);
    this.uniforms = {
      uShape: { value: new THREE.Vector4(0, 1, 1, 0) },
      uTime: { value: 0 },
      uBright: { value: 2.2 },
      uNear: { value: new THREE.Vector2(1.5, 6) },
      uNoise: { value: noise },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      // Additive and order-independent: one pass is enough (three would otherwise draw back then front
      // faces and re-select the program before each of them).
      forceSinglePass: true,
    });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, slots.length);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = PLUME_ORDER + 1;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const down = new THREE.Vector3(0, -1, 0);
    slots.forEach((s, i) => {
      q.identity();
      if (s.dir) q.setFromUnitVectors(down, s.dir.clone().normalize());
      m.compose(new THREE.Vector3(s.x, s.y, s.z), q, new THREE.Vector3(1, 1, 1));
      this.mesh.setMatrixAt(i, m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setIntensity(i: number, v: number): void {
    this.attr.array[i * 4] = v;
  }

  commit(): void {
    this.attr.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------------------
// Ray-marched volume
// ---------------------------------------------------------------------------

const VOL_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec4 uCone;
varying vec3 vLocal;
void main() {
  // Unit cylinder (y in [-1, 0]) stretched into the proxy frustum.
  float s = -position.y * uCone.w;
  float rr = uCone.y + uCone.z * s;
  vec3 p = vec3(position.x * rr, uCone.x - s, position.z * rr);
  vLocal = p;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const VOL_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCam;
uniform vec4 uCone;   // y0, proxy radius at y0, proxy slope, proxy length
uniform vec4 uPlume;  // R0, tanA, decay length, intensity
uniform vec3 uCol0;
uniform vec3 uCol1;
uniform vec3 uCol2;
uniform vec4 uMisc;   // fade-in length, noise strength, flicker speed, radial sharpness
uniform float uTime;
uniform float uSat;
uniform vec2 uSpread;  // x: emission falloff exponent with the plume radius, y: brightness of the jet boundary
uniform int uSteps;
uniform float uGain;  // < 1 while the camera is inside the plume
uniform vec2 uNear;   // samples closer to the camera than x (m) are dropped, beyond y they count in full
uniform float uInside; // 1: the camera is inside the proxy, march from its back faces
uniform float uMeter;  // 1: self-luminous gas a camera meters for (the entry plasma): divided by sqrt(exposure)
uniform sampler2D uNoise;
varying vec3 vLocal;

// Interval of the ray o + t·d inside the frustum r <= a + b·(y0 - y), y0 - lmax <= y <= y0.
vec2 coneInterval(vec3 o, vec3 d, float y0, float a, float b, float lmax) {
  float tmin = -1e9;
  float tmax = 1e9;
  if (abs(d.y) > 1e-6) {
    float t1 = (y0 - o.y) / d.y;
    float t2 = (y0 - lmax - o.y) / d.y;
    tmin = min(t1, t2);
    tmax = max(t1, t2);
  } else if (o.y > y0 || o.y < y0 - lmax) {
    return vec2(1.0, 0.0);
  }
  float kb = a + b * (y0 - o.y);
  float A = d.x * d.x + d.z * d.z - b * b * d.y * d.y;
  float B = 2.0 * (o.x * d.x + o.z * d.z) + 2.0 * b * d.y * kb;
  float C = o.x * o.x + o.z * o.z - kb * kb;
  float disc = B * B - 4.0 * A * C;
  float c0 = -1e9;
  float c1 = 1e9;
  if (abs(A) < 1e-7) {
    if (abs(B) > 1e-7) {
      float t = -C / B;
      if (B > 0.0) c1 = t; else c0 = t;
    } else if (C > 0.0) {
      return vec2(1.0, 0.0);
    }
  } else if (A > 0.0) {
    if (disc < 0.0) return vec2(1.0, 0.0);
    float sq = sqrt(disc);
    c0 = (-B - sq) / (2.0 * A);
    c1 = (-B + sq) / (2.0 * A);
  } else if (disc >= 0.0) {
    // Ray steeper than the cone: inside on the lower nappe beyond the far root.
    float sq = sqrt(disc);
    float r0 = (-B + sq) / (2.0 * A);
    float r1 = (-B - sq) / (2.0 * A);
    if (d.y < 0.0) c0 = r1; else c1 = r0;
  }
  return vec2(max(tmin, c0), min(tmax, c1));
}

void main() {
  // The proxy is drawn double-sided in one pass: front faces from outside, back faces from inside, so
  // every covered pixel marches its ray exactly once (the interval comes from the analytic cone).
  if (gl_FrontFacing == (uInside > 0.5)) discard;
  #include <logdepthbuf_fragment>
  vec3 ro = uCam;
  vec3 rd = normalize(vLocal - uCam);
  vec2 iv = coneInterval(ro, rd, uCone.x, uCone.y, uCone.z, uCone.w);
  float t0 = max(iv.x, uNear.x);
  float t1 = iv.y;
  if (t1 <= t0) discard;
  // Long oblique chords (a plume seen at a slant, or from inside) get up to twice the base sample count.
  float len = t1 - t0;
  vec3 pm = ro + rd * (t0 + 0.5 * len);
  float Rm = uPlume.x + uPlume.y * max(uCone.x - pm.y, 0.0);
  int base = clamp(uSteps, 2, 32);
  int steps = min(clamp(int(ceil(len / (0.35 * Rm))), base, 2 * base), 32);
  // Interleaved gradient noise per pixel offsets the samples, trading step banding for fine grain; half
  // a step of jitter is enough to hide the banding and keeps the edges from speckling.
  float jitter = 0.25 + 0.5 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float dt = len / float(steps);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 32; i++) {
    if (i >= steps) break;
    float t = t0 + (float(i) + jitter) * dt;
    vec3 p = ro + rd * t;
    float s = uCone.x - p.y;
    float R = uPlume.x + uPlume.y * s;
    float rr = length(p.xz) / R;
    // Emission per volume falls as the exhaust spreads; uSpread.x < 2 keeps the far plume visible
    // as a large faint glow in near-vacuum. An under-expanded plume in thin air glows most along its
    // boundary (the barrel shock and the mixing layer round the core), which shows as a brighter rim.
    float rim = rr - 0.78;
    float dens = exp(-s / uPlume.z) * pow(uPlume.x / R, uSpread.x) * (exp(-uMisc.w * rr * rr) + uSpread.y * exp(-25.0 * rim * rim));
    dens *= smoothstep(0.0, uMisc.x, s) * smoothstep(uNear.x, uNear.y, t);
    float n = texture2D(uNoise, vec2(s * 0.019 - uTime * uMisc.z, atan(p.z, p.x) * 0.3183 + s * 0.004)).r;
    dens *= 1.0 - uMisc.y + uMisc.y * 2.0 * n;
    vec3 c = mix(uCol0, uCol1, smoothstep(0.1, 0.9, rr));
    c = mix(c, uCol2, smoothstep(0.15, 1.0, s / (uPlume.z * 1.6)));
    acc += c * dens;
  }
  vec3 col = acc * (dt / uPlume.x) * uPlume.w * uGain;
  // Hue-preserving soft saturation: long sight lines through the core approach uSat instead of
  // blowing out to flat white.
  float L = dot(col, vec3(0.3, 0.5, 0.2));
  float Lc = uSat * (1.0 - exp(-L / uSat));
  col *= Lc / max(L, 1e-4);
  #ifdef TONE_MAPPING
    col *= mix(1.0, inversesqrt(max(toneMappingExposure, 1e-3)), uMeter);
  #endif
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface VolumeShape {
  /** Exponent of the (R0/R) emission falloff with plume radius (2 = conserve flux per area). */
  falloff: number;
  /** Extra brightness of the jet boundary (0 = a plain Gaussian column; an under-expanded plume has a bright rim). */
  rim: number;
  /** Luminance the soft saturation approaches on long sight lines. */
  saturation: number;
  y0: number;
  r0: number;
  tanA: number;
  decay: number;
  intensity: number;
  fadeIn: number;
  noise: number;
  flicker: number;
  sharp: number;
  /** Distance from the camera (m) over which samples fade in, so a close camera is not inside a glare. */
  near: number;
  col0: THREE.Color;
  col1: THREE.Color;
  col2: THREE.Color;
}

export class PlumeVolume {
  readonly mesh: THREE.Mesh;
  readonly uniforms: {
    uCam: { value: THREE.Vector3 };
    uCone: { value: THREE.Vector4 };
    uPlume: { value: THREE.Vector4 };
    uCol0: { value: THREE.Color };
    uCol1: { value: THREE.Color };
    uCol2: { value: THREE.Color };
    uMisc: { value: THREE.Vector4 };
    uTime: { value: number };
    uSat: { value: number };
    uSpread: { value: THREE.Vector2 };
    uSteps: { value: number };
    uGain: { value: number };
    uNear: { value: THREE.Vector2 };
    uInside: { value: number };
    uMeter: { value: number };
    uNoise: { value: THREE.Texture };
  };
  private readonly geo: THREE.CylinderGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly tmp = new THREE.Vector3();
  private baseSteps: number;

  /**
   * `insideGain`: brightness of the whole volume while the camera is deep inside the plume. Looking down
   * the axis sums the entire column, so an engine plume would turn a camera behind the engines into a
   * full-frame glare; 1 keeps the volume as it is (the entry plasma wake seen from the nose camera).
   */
  constructor(
    noise: THREE.Texture,
    steps: number,
    private readonly insideGain = 1,
  ) {
    this.baseSteps = steps;
    this.geo = new THREE.CylinderGeometry(1, 1, 1, 40, 1, false);
    this.geo.translate(0, -0.5, 0);
    this.uniforms = {
      uCam: { value: new THREE.Vector3() },
      uCone: { value: new THREE.Vector4(0, 1, 0.1, 10) },
      uPlume: { value: new THREE.Vector4(1, 0.1, 10, 0) },
      uCol0: { value: new THREE.Color(1, 1, 1) },
      uCol1: { value: new THREE.Color(1, 0.5, 0.2) },
      uCol2: { value: new THREE.Color(1, 0.3, 0.1) },
      uMisc: { value: new THREE.Vector4(1, 0.3, 1, 2.2) },
      uTime: { value: 0 },
      uSat: { value: 2.4 },
      uSpread: { value: new THREE.Vector2(2, 0) },
      uSteps: { value: steps },
      uGain: { value: 1 },
      uNear: { value: new THREE.Vector2(0, 1e-3) },
      uInside: { value: 0 },
      uMeter: { value: 0 },
      uNoise: { value: noise },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VOL_VERT,
      fragmentShader: VOL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // Both faces in one pass; the shader keeps the front or the back ones (uInside), so moving the
      // camera into the plume never changes render state or the program.
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = PLUME_ORDER;
  }

  /** Base ray-march sample count (wide, faint plumes and long oblique sight lines get more). */
  setSteps(steps: number): void {
    this.baseSteps = steps;
  }

  setShape(s: VolumeShape): void {
    // Proxy frustum a bit wider than the plume so the Gaussian tail is not clipped.
    const lmax = s.decay * 3.2;
    this.uniforms.uCone.value.set(s.y0, s.r0 * 1.45 + 0.4, s.tanA * 1.45, lmax);
    this.uniforms.uPlume.value.set(s.r0, s.tanA, s.decay, s.intensity);
    this.uniforms.uMisc.value.set(s.fadeIn, s.noise, s.flicker, s.sharp);
    this.uniforms.uCol0.value.copy(s.col0);
    this.uniforms.uCol1.value.copy(s.col1);
    this.uniforms.uCol2.value.copy(s.col2);
    this.uniforms.uSpread.value.set(s.falloff, s.rim);
    this.uniforms.uSat.value = s.saturation;
    this.uniforms.uNear.value.set(0.2 * s.near, Math.max(s.near, 1e-3));
    // The shader adds samples on long sight lines through a narrow column (see the step count there); a wide fan is
    // smooth and faint, and covers much of the view, so it gets no more than the base count.
    this.uniforms.uSteps.value = this.baseSteps;
    this.mesh.visible = s.intensity > 0.001;
  }

  /**
   * Camera-dependent state, for each view: the camera in the mesh's frame, which faces to march from,
   * and the dimming while the camera is inside the plume (call after setShape).
   */
  updateCamera(camera: THREE.Camera): void {
    this.mesh.updateWorldMatrix(true, false);
    camera.getWorldPosition(this.tmp);
    this.mesh.worldToLocal(this.tmp);
    this.uniforms.uCam.value.copy(this.tmp);
    const c = this.uniforms.uCone.value;
    const p = this.uniforms.uPlume.value;
    const s = c.x - this.tmp.y;
    const r = Math.hypot(this.tmp.x, this.tmp.z);
    const inside = s > -0.5 && s < c.w + 0.5 && r < c.y + c.z * Math.max(s, 0) + 0.5;
    this.uniforms.uInside.value = inside ? 1 : 0;
    // How deep the camera is in the glowing gas: 1 on the axis along the bright length, 0 from the edge out.
    const R = p.x + p.y * Math.max(s, 0);
    const depth = smooth(-0.5 * p.x, 0.5 * p.x, s) * (1 - smooth(2 * p.z, 3.2 * p.z, s)) * (1 - smooth(0.6, 1.4, r / R));
    this.uniforms.uGain.value = 1 - (1 - this.insideGain) * depth;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// Glow sprite
// ---------------------------------------------------------------------------

const GLOW_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uPos;
uniform float uSize;
uniform float uPull;
varying vec2 vQ;
varying float vFade;
void main() {
  vec4 mv = modelViewMatrix * vec4(uPos, 1.0);
  // Bloom belongs to a view of the engines from outside: a camera at the nozzles would sit inside the sprite.
  vFade = smoothstep(0.6 * uSize, 2.2 * uSize, length(mv.xyz));
  // Pull the sprite towards the camera (by uPull sizes) so it is not swallowed by the geometry round its centre.
  mv.xyz += normalize(-mv.xyz) * uSize * uPull;
  mv.xy += position.xy * uSize;
  vQ = position.xy;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const GLOW_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uIntensity;
uniform float uMeter; // 1: the bloom of self-luminous gas a camera meters for (the entry plasma), / sqrt(exposure)
varying vec2 vQ;
varying float vFade;
void main() {
  #include <logdepthbuf_fragment>
  if (vFade < 0.001) discard;
  float r2 = dot(vQ, vQ);
  // Window so the quad's edges never show.
  float win = max(0.0, 1.0 - r2);
  float I = (exp(-r2 * 10.0) + 0.25 * exp(-r2 * 3.5)) * win * win;
  #ifdef TONE_MAPPING
    I *= mix(1.0, inversesqrt(max(toneMappingExposure, 1e-3)), uMeter);
  #endif
  gl_FragColor = vec4(uColor * I * uIntensity * vFade, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class PlumeGlow {
  readonly mesh: THREE.Mesh;
  readonly uniforms: {
    uPos: { value: THREE.Vector3 };
    uSize: { value: number };
    /** How far the sprite is pulled towards the camera, in sizes. */
    uPull: { value: number };
    uColor: { value: THREE.Color };
    uIntensity: { value: number };
    uMeter: { value: number };
  };
  private readonly geo: THREE.PlaneGeometry;
  private readonly mat: THREE.ShaderMaterial;

  constructor() {
    this.geo = new THREE.PlaneGeometry(2, 2);
    this.uniforms = {
      uPos: { value: new THREE.Vector3() },
      uSize: { value: 5 },
      uPull: { value: 0.15 },
      uColor: { value: new THREE.Color(1, 0.9, 0.8) },
      uIntensity: { value: 0 },
      uMeter: { value: 0 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// Shared shape logic
// ---------------------------------------------------------------------------

const C_SL_CORE = new THREE.Color(1.0, 0.84, 0.62);
const C_ALT_CORE = new THREE.Color(0.62, 0.68, 1.0);
const C_SL_OUTER = new THREE.Color(1.0, 0.5, 0.16);
const C_ALT_OUTER = new THREE.Color(0.5, 0.3, 1.0);
const C_SL_TAIL = new THREE.Color(1.0, 0.36, 0.08);
const C_ALT_TAIL = new THREE.Color(0.42, 0.22, 0.9);
const C_VAC_TAIL = new THREE.Color(0.34, 0.24, 0.85);

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Cluster plume shape for an engine cluster of radius r0 at the given altitude factor.
 * `power` = (lit fraction) × throttle response, 0..1.
 */
export function clusterShape(out: VolumeShape, alt: number, r0: number, y0: number, power: number, scale: number): VolumeShape {
  out.y0 = y0;
  out.r0 = r0;
  // Under-expansion: once the ambient pressure is well below the nozzles' exit pressure the exhaust turns outwards
  // round the lips of the nozzles (by some 40° at 30 km, more higher up), so the merged plume swells from a narrow
  // column at sea level to a translucent bell several times the vehicle's width by 40 km (alt 0.4), wider still in
  // near-vacuum.
  out.tanA = 0.04 + 0.75 * smooth(0.12, 0.6, alt) + 0.45 * smooth(0.5, 0.95, alt);
  out.rim = 0.55 * smooth(0.15, 0.5, alt) * (1 - 0.5 * smooth(0.7, 1.0, alt));
  // A falloff below 2 keeps some brightness out across the expanding vacuum fan, so it reads as a huge faint glow
  // rather than a blob at the nozzles; above 1, the wider the fan, the fainter it is (translucent, not a white wedge).
  out.falloff = 2 - 0.7 * smooth(0.3, 0.9, alt);
  out.decay = r0 * (6.5 + 42 * Math.pow(alt, 1.35)) * scale;
  // Near vacuum the exhaust glow is huge but faint. In thick air it is held back a little so the merged
  // column keeps its colour instead of saturating to a flat white block.
  out.intensity =
    power *
    (1.5 - 0.4 * alt - 0.35 * (1 - smooth(0.0, 0.25, alt))) *
    (1 - 0.35 * smooth(0.15, 0.45, alt)) *
    (1 - 0.72 * smooth(0.45, 1.0, alt));
  // In thick air the merged plume starts several metres down, so the individual engines and their shock
  // diamonds show first and the column has no hard top at the nozzles.
  out.fadeIn = 9 - 8 * smooth(0.0, 0.4, alt);
  // Low in thick air so the afterburning orange survives the tone mapping, highest for the bright expanded
  // plume at staging altitudes, low again for the faint vacuum exhaust.
  out.saturation = 1.3 + 0.5 * smooth(0.05, 0.4, alt) - 0.7 * smooth(0.55, 1.0, alt);
  out.noise = 0.32 - 0.18 * alt;
  out.flicker = 1.6 - 1.0 * alt;
  out.sharp = 1.8 + 0.4 * alt;
  out.near = 1.5 * r0;
  const a = smooth(0.02, 0.3, alt);
  out.col0.copy(C_SL_CORE).lerp(C_ALT_CORE, a);
  out.col1.copy(C_SL_OUTER).lerp(C_ALT_OUTER, smooth(0.04, 0.38, alt));
  out.col2.copy(C_SL_TAIL).lerp(C_ALT_TAIL, smooth(0.05, 0.4, alt)).lerp(C_VAC_TAIL, smooth(0.6, 1.0, alt));
  return out;
}

export function newVolumeShape(): VolumeShape {
  return {
    falloff: 2,
    rim: 0,
    saturation: 2.4,
    y0: 0,
    r0: 1,
    tanA: 0.1,
    decay: 10,
    intensity: 0,
    fadeIn: 1,
    noise: 0.3,
    flicker: 1,
    sharp: 2.2,
    near: 0,
    col0: new THREE.Color(),
    col1: new THREE.Color(),
    col2: new THREE.Color(),
  };
}
