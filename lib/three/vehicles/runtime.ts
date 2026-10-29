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

/** Deterministic per-index flicker in 0..1 (no Math.random, so scrubbing is stable). */
export function flicker(t: number, i: number): number {
  return 0.5 + 0.25 * Math.sin(t * 23.1 + i * 2.39) + 0.25 * Math.sin(t * 37.7 + i * 5.13);
}
