import { describe, expect, it } from 'vitest';
import { makeWaves, WAVE_COUNT, WAVE_SLOPE_VARIANCE, wavePhases } from '../waves';

const TAU = 2 * Math.PI;

/** Phase difference wrapped to (−π, π]. */
function wrap(a: number): number {
  return a - TAU * Math.round(a / TAU);
}

describe('wind waves', () => {
  const w = makeWaves();

  it('is deterministic, with the slope variance the shaders assume', () => {
    expect(makeWaves().k).toEqual(w.k);
    expect(w.slopeVariance).toBeCloseTo(WAVE_SLOPE_VARIANCE, 10);
    for (let i = 0; i < WAVE_COUNT; i++) {
      const k = Math.hypot(w.k[i * 4], w.k[i * 4 + 1], w.k[i * 4 + 2]);
      // Each wave's slope a·|k| is the same, and the wavelengths span 0.9–60 m.
      expect(w.k[i * 4 + 3] * k).toBeCloseTo(Math.sqrt((2 * WAVE_SLOPE_VARIANCE) / WAVE_COUNT), 6);
      expect(TAU / k).toBeGreaterThan(0.89);
      expect(TAU / k).toBeLessThan(60.1);
    }
  });

  it('stays anchored to the sea wherever the camera is', () => {
    // A point on the sea north of Hawaii, seen from two camera positions 1.7 km apart: the shader's
    // phase at the point, k·(x − camera) + phase(camera), must not depend on the camera.
    const x = [-5.39e6, -2.43e6, 2.63e6];
    const camA = [x[0] + 120, x[1] - 340, x[2] + 15];
    const camB = [x[0] - 1500, x[1] + 760, x[2] + 220];
    const a = wavePhases(w, camA, 11290.5, new Float32Array(WAVE_COUNT));
    const b = wavePhases(w, camB, 11290.5, new Float32Array(WAVE_COUNT));
    for (let i = 0; i < WAVE_COUNT; i++) {
      const k = [w.k[i * 4], w.k[i * 4 + 1], w.k[i * 4 + 2]];
      const atA = k[0] * (x[0] - camA[0]) + k[1] * (x[1] - camA[1]) + k[2] * (x[2] - camA[2]) + a[i];
      const atB = k[0] * (x[0] - camB[0]) + k[1] * (x[1] - camB[1]) + k[2] * (x[2] - camB[2]) + b[i];
      expect(Math.abs(wrap(atA - atB))).toBeLessThan(1e-4);
    }
  });

  it('travels at the deep-water phase speed', () => {
    const cam = [6.0e6, 1.0e6, -2.9e6];
    const t0 = wavePhases(w, cam, 100, new Float32Array(WAVE_COUNT));
    const t1 = wavePhases(w, cam, 101, new Float32Array(WAVE_COUNT));
    for (let i = 0; i < WAVE_COUNT; i++) {
      const k = Math.hypot(w.k[i * 4], w.k[i * 4 + 1], w.k[i * 4 + 2]);
      expect(t0[i]).toBeGreaterThanOrEqual(0);
      expect(t0[i]).toBeLessThan(TAU);
      // One second later the phase at a fixed point has dropped by ω = √(g|k|).
      expect(Math.abs(wrap(t0[i] - t1[i] - Math.sqrt(9.81 * k)))).toBeLessThan(1e-4);
    }
  });
});
