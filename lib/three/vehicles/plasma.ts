import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PlumeGlow, PlumeVolume, newVolumeShape, type VolumeShape } from './plumes';

/**
 * Entry plasma: a glowing shock layer hugging the windward side of the hull and of any surface added to it
 * (the ship's flaps), a long ray-marched wake trailing downstream, and the light both cast on the vehicle
 * itself (PlasmaLight). Everything scales with the visible glow, plasmaGlow(heating), and disappears at 0.
 * - Sheath: a closed hull inflated along its normals; the stand-off grows on the windward side (bow shock).
 *   Additive and optically thin: faint where seen face-on, brightest where seen edge-on, hottest (orange-white)
 *   round the stagnation region, pink over the rest of the windward side and violet where the flow leaves it.
 * - Wake: PlumeVolume oriented along the airflow, pink to violet, turbulent.
 * Self-luminous, so a camera meters partly for it: its brightness is divided by the square root of the
 * renderer's exposure. A night view (exposure up to 4) then shows it twice, not four times, as bright as a
 * daylight one, which keeps its colours instead of washing it out to white.
 */

/**
 * Visible strength of the entry glow, 0..~1.2, for the stage's heating index (Sutton-Graves stagnation heating,
 * about 1 at a typical peak) and the Mach number. The light of the shock layer rises much more steeply with speed
 * and density than the heating, but a camera adapts to it: in an entry the glow shows from about 110 km (heating
 * ~0.03) and is strong from 85 km on (heating ~0.3). Only orbital-class speeds make the gas glow: a climbing vehicle
 * at Mach 3 heats up as much as an entering one at 110 km but shows nothing, and the glow dies out below Mach 10.
 */
export function plasmaGlow(heating: number, mach: number): number {
  const fast = Math.min(Math.max((mach - 7) / 7, 0), 1);
  return Math.pow(Math.min(Math.max(heating, 0) / 0.6, 1.4), 0.65) * fast * fast * (3 - 2 * fast);
}

/** GLSL: brightness factor of the entry glow for the view being drawn (see the module comment). */
const METER_GLSL = /* glsl */ `
float plasmaMeter() {
  #ifdef TONE_MAPPING
    return inversesqrt(max(toneMappingExposure, 1e-3));
  #else
    return 1.0;
  #endif
}
`;

const SHEATH_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uFlowW;
uniform float uStand;
varying vec3 vN;
varying vec3 vW;
varying float vWind;
varying vec3 vLoc;
void main() {
  vec3 n = normalize(normal);
  // Windward-ness from the world-space flow, so the same material wraps the hull and the flaps (own frames).
  vec3 nW = normalize(mat3(modelMatrix) * n);
  float w = dot(nW, -uFlowW);
  vec3 p = position + n * (0.12 + uStand * max(w, 0.0));
  vWind = w;
  vLoc = p;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vW = wp.xyz;
  vN = nW;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const SHEATH_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uHeat;
uniform float uTime;
uniform sampler2D uNoise;
varying vec3 vN;
varying vec3 vW;
varying float vWind;
varying vec3 vLoc;
${METER_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 V = normalize(cameraPosition - vW);
  float ndv = abs(dot(normalize(vN), V));
  // An optically thin glowing layer: a sight line crosses more of it the more edge-on it is seen.
  float fres = pow(1.0 - ndv, 2.0);
  // Only where the flow meets the surface: the layer thins out to nothing along the sides.
  float wind = smoothstep(-0.05, 0.85, vWind);
  // Streaks blown along the surface by the flow, shimmering.
  float a = atan(vLoc.x, vLoc.z) * 0.3183;
  float n = texture2D(uNoise, vec2(vLoc.y * 0.021 - uTime * 0.45, a + uTime * 0.03)).r;
  float n2 = texture2D(uNoise, vec2(vLoc.y * 0.07 + uTime * 0.9, a * 3.0 + vLoc.y * 0.013)).g;
  float I = uHeat * pow(wind, 1.4) * (0.16 + 0.84 * fres) * (0.6 + 0.55 * n + 0.25 * n2);
  // Hottest (orange-white) where the flow hits head-on, pink over the windward side, violet where it leaves it.
  vec3 c = mix(vec3(0.62, 0.24, 1.0), vec3(1.0, 0.3, 0.66), smoothstep(0.0, 0.45, vWind));
  c = mix(c, vec3(1.0, 0.6, 0.4), smoothstep(0.6, 0.98, vWind));
  gl_FragColor = vec4(c * I * plasmaMeter(), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface PlasmaOptions {
  /** Hull silhouette (y, r), bottom to top. */
  profile: Array<{ y: number; r: number }>;
  length: number;
  radius: number;
  noise: THREE.Texture;
  steps: number;
}

/** Sheath glow per unit of plasmaGlow, the wake's intensity and that of the halo round the windward side. */
const SHEATH_GAIN = 1.1;
const WAKE_GAIN = 0.2;
const HALO_GAIN = 0.13;

export class Plasma {
  readonly group = new THREE.Group();
  private readonly sheath: THREE.Mesh;
  private readonly sheathGeo: THREE.BufferGeometry;
  private readonly sheathMat: THREE.ShaderMaterial;
  private readonly sheathU: {
    uFlowW: { value: THREE.Vector3 };
    uStand: { value: number };
    uHeat: { value: number };
    uTime: { value: number };
    uNoise: { value: THREE.Texture };
  };
  /** Sheaths of the surfaces added with wrap() (children of those surfaces, so they follow them). */
  private readonly wraps: THREE.Mesh[] = [];
  private readonly wakePivot = new THREE.Group();
  private readonly wake: PlumeVolume;
  /** Bloom round the glowing windward side, seen from outside (it fades out for a camera on the hull). */
  private readonly halo = new PlumeGlow();
  private readonly shape: VolumeShape = newVolumeShape();
  private readonly length: number;
  private readonly radius: number;
  private readonly flow = new THREE.Vector3();
  private readonly down = new THREE.Vector3(0, -1, 0);
  private readonly q = new THREE.Quaternion();
  /** The plasma's light on the vehicle: apply it to the vehicle's lit materials. */
  readonly light = new PlasmaLight();

  constructor(o: PlasmaOptions) {
    this.length = o.length;
    this.radius = o.radius;
    // Closed hull: cap the bottom, profile, round the top.
    const pts: THREE.Vector2[] = [new THREE.Vector2(0.001, o.profile[0].y - 0.4)];
    for (const p of o.profile) pts.push(new THREE.Vector2(p.r + 0.15, p.y));
    const last = o.profile[o.profile.length - 1];
    pts.push(new THREE.Vector2(0.001, last.y + 0.6));
    this.sheathGeo = new THREE.LatheGeometry(pts, 48);
    this.sheathGeo.computeVertexNormals();
    this.sheathU = {
      uFlowW: { value: new THREE.Vector3(0, -1, 0) },
      uStand: { value: 1.6 },
      uHeat: { value: 0 },
      uTime: { value: 0 },
      uNoise: { value: o.noise },
    };
    this.sheathMat = new THREE.ShaderMaterial({
      uniforms: this.sheathU,
      vertexShader: SHEATH_VERT,
      fragmentShader: SHEATH_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    });
    this.sheath = new THREE.Mesh(this.sheathGeo, this.sheathMat);
    this.sheath.frustumCulled = false;
    this.sheath.renderOrder = 12;
    this.wake = new PlumeVolume(o.noise, o.steps);
    this.wake.uniforms.uMeter.value = 1;
    this.wakePivot.add(this.wake.mesh);
    this.halo.mesh.name = 'plasma-halo';
    this.halo.uniforms.uMeter.value = 1;
    // In front of the whole body (bloom lies over the image, the hull does not hide it).
    this.halo.uniforms.uPull.value = 1;
    this.halo.uniforms.uColor.value.setRGB(1.0, 0.36, 0.58);
    this.group.add(this.sheath, this.wakePivot, this.halo.mesh);
    this.group.visible = false;
  }

  /**
   * Wraps a moving surface of the vehicle (a flap) in a sheath of its own: a smoothed copy of its geometry, added
   * as its child so it follows the surface. Call before the first render.
   */
  wrap(mesh: THREE.Mesh): void {
    const src = new THREE.BufferGeometry();
    src.setAttribute('position', mesh.geometry.getAttribute('position'));
    src.setIndex(mesh.geometry.getIndex());
    // Shared corners merged so the normals round off the edges and the inflated copy stays closed.
    const geo = mergeVertices(src, 1e-4);
    geo.computeVertexNormals();
    const s = new THREE.Mesh(geo, this.sheathMat);
    s.name = 'plasma-sheath';
    s.frustumCulled = false;
    s.renderOrder = 12;
    s.visible = false;
    mesh.add(s);
    this.wraps.push(s);
  }

  setSteps(steps: number): void {
    this.wake.setSteps(steps);
  }

  /** Re-aims the camera-dependent part (the wake's ray march) at another view of the same frame. */
  setCamera(camera: THREE.Camera): void {
    if (this.group.visible) this.wake.updateCamera(camera);
  }

  /**
   * `glow`: plasmaGlow of the heating; `airflowBody`: direction the air moves past the vehicle, body frame;
   * `bodyQuat`: the vehicle's world orientation (for the sheaths, which work in world space).
   */
  update(glow: number, airflowBody: THREE.Vector3, bodyQuat: THREE.Quaternion, t: number, camera: THREE.Camera): void {
    const h = Math.max(0, glow);
    const on = h > 0.01;
    this.group.visible = on;
    for (const s of this.wraps) s.visible = on;
    this.flow.copy(airflowBody);
    if (this.flow.lengthSq() < 1e-8) this.flow.set(0, -1, 0);
    this.flow.normalize();
    this.sheathU.uFlowW.value.copy(this.flow).applyQuaternion(bodyQuat);
    this.light.set(on ? h : 0, this.sheathU.uFlowW.value);
    if (!on) return;
    this.sheathU.uHeat.value = h * SHEATH_GAIN;
    this.sheathU.uTime.value = t;
    this.sheathU.uStand.value = 0.4 + 0.7 * Math.min(h, 1);

    // Wake: from the body centre downstream; its width follows the cross-section the flow sees.
    const across = Math.sqrt(Math.max(0, 1 - this.flow.y * this.flow.y));
    this.wakePivot.position.set(0, this.length * 0.5, 0);
    this.wakePivot.quaternion.copy(this.q.setFromUnitVectors(this.down, this.flow));
    const s = this.shape;
    s.y0 = this.radius * 0.6;
    s.r0 = THREE.MathUtils.lerp(this.radius * 0.9, this.length * 0.24, across);
    s.tanA = 0.07;
    s.decay = 40 + this.length * 0.9;
    s.intensity = h * WAKE_GAIN;
    s.saturation = 1.0;
    s.falloff = 1.6;
    s.fadeIn = this.radius * 0.6;
    s.noise = 0.65;
    s.flicker = 2.4;
    s.sharp = 2.6;
    s.near = 0;
    s.col0.setRGB(1.0, 0.36, 0.72);
    s.col1.setRGB(0.72, 0.24, 1.0);
    s.col2.setRGB(0.45, 0.16, 0.95);
    this.wake.setShape(s);
    this.wake.uniforms.uTime.value = t;
    this.wake.updateCamera(camera);

    // Halo: centred a little off the windward side of the middle of the body, as large as the glowing side.
    const off = this.radius * 1.1;
    this.halo.uniforms.uPos.value.set(-this.flow.x * off, this.length * 0.5 - this.flow.y * off, -this.flow.z * off);
    this.halo.uniforms.uSize.value = THREE.MathUtils.lerp(this.radius * 2.2, this.length * 0.62, across);
    this.halo.uniforms.uIntensity.value = h * HALO_GAIN;
  }

  dispose(): void {
    this.sheathGeo.dispose();
    for (const s of this.wraps) {
      s.removeFromParent();
      s.geometry.dispose();
    }
    this.sheathMat.dispose();
    this.wake.dispose();
    this.halo.dispose();
  }
}

const PLASMA_LIGHT_DECL = /* glsl */ `
uniform vec3 uPlasmaFlow;
uniform vec3 uPlasmaSheath;
uniform vec3 uPlasmaWake;
${METER_GLSL}
`;

const PLASMA_LIGHT_TERM = /* glsl */ `
{
  // Entry plasma round the vehicle as a light: the shock layer lies on the windward side, so only surfaces that face
  // the oncoming flow (or are near the edge of the windward side) see it, the rest of the hull hiding it; the wake
  // trailing downstream lights the lee side. Diffuse light for the dielectric parts, reflections for the steel.
  vec3 plasmaFlow = normalize((viewMatrix * vec4(uPlasmaFlow, 0.0)).xyz);
  float plasmaK = plasmaMeter();
  float plasmaWn = dot(geometryNormal, -plasmaFlow);
  float plasmaSheath = smoothstep(-0.2, 0.6, plasmaWn);
  #if defined( RE_IndirectDiffuse )
    irradiance += (uPlasmaSheath * plasmaSheath + uPlasmaWake * (0.5 - 0.5 * plasmaWn)) * (PI * plasmaK);
  #endif
  #if defined( RE_IndirectSpecular )
    vec3 plasmaR = reflect(-geometryViewDir, geometryNormal);
    radiance += (uPlasmaSheath * plasmaSheath * smoothstep(-0.2, 0.6, dot(plasmaR, -plasmaFlow))
      + uPlasmaWake * smoothstep(-0.5, 0.7, dot(plasmaR, plasmaFlow))) * plasmaK;
  #endif
}
`;

/** Radiance of the plasma as seen from the hull per unit of plasmaGlow: the shock layer, and the wake. */
const SHEATH_LIGHT = new THREE.Color(1.0, 0.5, 0.45).multiplyScalar(0.5);
const WAKE_LIGHT = new THREE.Color(0.75, 0.3, 1.0).multiplyScalar(0.06);

/**
 * The light the entry plasma casts on the vehicle: added to its lit materials in the shader (like PlumeLight), so
 * no three.js light and no program changes with it. Pink-orange from the windward side, violet from the wake.
 */
export class PlasmaLight {
  readonly uniforms = {
    uPlasmaFlow: { value: new THREE.Vector3(0, -1, 0) },
    uPlasmaSheath: { value: new THREE.Color(0, 0, 0) },
    uPlasmaWake: { value: new THREE.Color(0, 0, 0) },
  };

  /** Adds the term to a lit material (call once, before its first render). */
  apply(m: THREE.MeshStandardMaterial): void {
    const prev = m.onBeforeCompile;
    const key = m.customProgramCacheKey();
    m.onBeforeCompile = (shader, renderer) => {
      prev.call(m, shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${PLASMA_LIGHT_DECL}`)
        .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${PLASMA_LIGHT_TERM}`);
    };
    m.customProgramCacheKey = () => `${key}|plasma-light`;
  }

  /** `glow`: plasmaGlow of the heating; `flowWorld`: world-space direction the air moves past the vehicle. */
  set(glow: number, flowWorld: THREE.Vector3): void {
    const k = Math.max(0, glow);
    this.uniforms.uPlasmaFlow.value.copy(flowWorld);
    this.uniforms.uPlasmaSheath.value.copy(SHEATH_LIGHT).multiplyScalar(k);
    this.uniforms.uPlasmaWake.value.copy(WAKE_LIGHT).multiplyScalar(k);
  }
}
