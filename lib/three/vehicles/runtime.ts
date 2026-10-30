import * as THREE from 'three';
// Relative so the smoother can be unit tested (vitest has no @/ alias).
import { ENGINE_LIT } from '../../sim/types';

/** Heat assumed for a lit engine whose burn history is unknown (first frame, or after a backwards seek). */
const HEAT_UNKNOWN_LIT = 0.7;

/**
 * Per-engine smoothing shared by both vehicles, in simulation time: plume intensity eases in over ~0.4 s
 * at startup and out over ~0.15 s at shutdown; `heat` follows the burn with a 14 s rise and a 30 s cool-down
 * (RVac extension glow), so the bells stop glowing half a minute after shutdown however the replay got there.
 * Steps that are not ordinary playback (dt <= 0: paused or a backwards seek; dt > 0.5 s: a forward seek or
 * fast playback) snap the intensity to its target. Heat integrates any forward step exactly (the engine
 * state is taken as constant over the step), holds while paused and restarts from a typical value when the
 * history is unknown.
 */
export class EngineSmoother {
  readonly intensity: Float32Array;
  readonly heat: Float32Array;
  private primed = false;

  constructor(n: number) {
    this.intensity = new Float32Array(n);
    this.heat = new Float32Array(n);
  }

  /**
   * Intensity-weighted RMS distance of the lit nozzles from the axis (m), for sizing the merged plume
   * (13 inner engines make a narrower column than all 33). Returns `fallback` when nothing is lit.
   */
  litRadius(radii: ArrayLike<number>, fallback: number): number {
    let w = 0;
    let r2 = 0;
    for (let i = 0; i < this.intensity.length; i++) {
      const k = this.intensity[i];
      w += k;
      r2 += k * radii[i] * radii[i];
    }
    return w > 1e-4 ? Math.sqrt(r2 / w) : fallback;
  }

  /** `dt` = simulation seconds since the previous update. Returns the mean intensity (0..1) over all slots. */
  update(engines: ArrayLike<number>, throttle: number, dt: number): number {
    const n = this.intensity.length;
    const step = Number.isFinite(dt) ? dt : 0;
    const snap = !(step > 0) || step > 0.5;
    const unknown = !this.primed || step < 0;
    this.primed = true;
    const thr = 0.38 + 0.62 * Math.max(0, Math.min(1, throttle));
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const lit = (engines[i] ?? 0) === ENGINE_LIT;
      const target = lit ? thr : 0;
      const cur = this.intensity[i];
      if (snap) this.intensity[i] = target;
      else this.intensity[i] = cur + (target - cur) * (1 - Math.exp(-step / (target > cur ? 0.4 : 0.15)));
      if (unknown) this.heat[i] = lit ? HEAT_UNKNOWN_LIT : 0;
      else if (step > 0) this.heat[i] += ((lit ? 1 : 0) - this.heat[i]) * (1 - Math.exp(-step / (lit ? 14 : 30)));
      sum += this.intensity[i];
    }
    return n > 0 ? sum / n : 0;
  }
}

/**
 * Metal renders black without an environment map. When the scene has none, give our materials a small
 * generated sky so they stay readable; as soon as scene.environment is set they use that instead.
 */
export function applyEnvFallback(root: THREE.Object3D, mats: THREE.MeshStandardMaterial[], fallback: THREE.Texture): void {
  let o: THREE.Object3D = root;
  while (o.parent) o = o.parent;
  const scene = o as THREE.Scene;
  const want = scene.isScene && scene.environment ? null : fallback;
  for (const m of mats) {
    if (m.envMap !== want) {
      m.envMap = want;
      m.needsUpdate = true;
    }
  }
}

const PLUME_LIGHT_DECL = /* glsl */ `
uniform vec3 uPlumeLight;
uniform vec3 uPlumeLightColor;
`;

const PLUME_LIGHT_TERM = /* glsl */ `
{
  // Exhaust glow below the nozzles: a soft warm source about as large as the glowing exhaust (8 m radius),
  // which also keeps the falloff finite on the bells and the skirt right next to it.
  vec3 plumeLv = (viewMatrix * vec4(uPlumeLight, 1.0)).xyz - geometryPosition;
  float plumeD2 = dot(plumeLv, plumeLv);
  IncidentLight plumeLight;
  plumeLight.direction = plumeLv * inversesqrt(max(plumeD2, 1e-4));
  plumeLight.color = uPlumeLightColor / (plumeD2 + 64.0);
  plumeLight.visible = true;
  RE_Direct(plumeLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
}
`;

const PLUME_LIGHT_COLOR = new THREE.Color(1.0, 0.62, 0.32);

/**
 * The light a vehicle's own exhaust casts on it (aft skirt, flaps, engine bells): a warm source a few
 * metres below the nozzles, lost in daylight but what lights a night landing burn. It is added to the
 * vehicle's lit materials in the shader rather than as a three.js light, so the scene's light count, and
 * with it every program, stays the same whether the engines burn or not.
 */
export class PlumeLight {
  readonly uniforms = {
    uPlumeLight: { value: new THREE.Vector3() },
    uPlumeLightColor: { value: new THREE.Color(0, 0, 0) },
  };
  private readonly local = new THREE.Vector3();

  /** `y`: height of the source in the vehicle frame (below the nozzle exits, which are at 0). */
  constructor(
    private readonly root: THREE.Object3D,
    y: number,
  ) {
    this.local.set(0, y, 0);
  }

  /** Adds the term to a lit material (call once, before its first render). */
  apply(m: THREE.MeshStandardMaterial): void {
    const prev = m.onBeforeCompile;
    const key = m.customProgramCacheKey();
    m.onBeforeCompile = (shader, renderer) => {
      prev.call(m, shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${PLUME_LIGHT_DECL}`)
        .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>\n${PLUME_LIGHT_TERM}`);
    };
    m.customProgramCacheKey = () => `${key}|plume-light`;
  }

  /**
   * `power`: mean engine intensity over all slots (0..1); `alt`: altitude factor (the vacuum exhaust barely
   * glows). Brightness grows less than linearly with the number of engines, so a landing burn on one or
   * three engines still lights the skirt and flaps.
   */
  set(power: number, alt: number): void {
    const k = 280 * Math.pow(Math.max(0, power), 0.6) * (1 - 0.8 * Math.min(1, Math.max(0, (alt - 0.2) / 0.7)));
    this.uniforms.uPlumeLightColor.value.copy(PLUME_LIGHT_COLOR).multiplyScalar(k);
  }

  /** Places the source for the view being drawn (the stage moves objects per view, camera-relative). */
  place(): void {
    this.root.updateWorldMatrix(true, false);
    this.uniforms.uPlumeLight.value.copy(this.local).applyMatrix4(this.root.matrixWorld);
  }
}

/** Deterministic per-index flicker in 0..1 (no Math.random, so scrubbing is stable). */
export function flicker(t: number, i: number): number {
  return 0.5 + 0.25 * Math.sin(t * 23.1 + i * 2.39) + 0.25 * Math.sin(t * 37.7 + i * 5.13);
}
