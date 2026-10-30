/**
 * Wind waves for close views of open water (splashdowns, the buoy camera): a fixed set of sine waves anchored to
 * the Earth, which the globe and ground-patch shaders add to the water's normal (WAVES_GLSL in shaders/common.ts).
 *
 * Each wave has a wave vector in world (ECEF) axes and travels at its deep-water phase speed. The shaders see
 * camera-relative positions only, so the phase at the camera, k·camera − ωt + φ₀, is worked out here in float64 and
 * the shader adds k·p for its pixel: the pattern stays put on the sea wherever the camera goes, at no loss of
 * precision. The wave vectors cluster around the polar axis, so at all but polar latitudes the crests run roughly
 * east–west, with a spread of directions and a few crossing waves (a lone, perfectly regular swell looks fake).
 *
 * Free of three.js, for unit tests.
 */

export const WAVE_COUNT = 16;

/** Mean square slope of the waves the shaders draw; the rest of the sea's (Cox–Munk) roughness stays sub-pixel. */
export const WAVE_SLOPE_VARIANCE = 0.014;

const GRAVITY = 9.81;
const TAU = 2 * Math.PI;
/** Shortest and longest wavelengths, m. */
const SHORTEST = 0.9;
const LONGEST = 60;
/** Half-angle of the cone of wave directions around the polar axis, rad. */
const SPREAD = 0.95;

export interface WaveSet {
  /** Per wave: wave vector x, y, z (rad/m, ECEF, float32-exact) and height amplitude (m): the shader's uniform. */
  readonly k: Float32Array;
  /** Angular frequency (rad/s), from deep-water dispersion ω² = g|k|. */
  readonly omega: Float64Array;
  /** Phase at the Earth's centre at T+0 (rad). */
  readonly phase0: Float64Array;
  /** Mean square slope of the whole set (where every wave is resolved). */
  readonly slopeVariance: number;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The wave set: wavelengths spaced evenly in log from SHORTEST to LONGEST, every wave with the same slope (the
 * equilibrium range of a wind sea), so the long waves are the tall ones and the short ones add the fine texture.
 */
export function makeWaves(seed = 20240610): WaveSet {
  const rnd = rng(seed);
  const k = new Float32Array(WAVE_COUNT * 4);
  const omega = new Float64Array(WAVE_COUNT);
  const phase0 = new Float64Array(WAVE_COUNT);
  const slope = Math.sqrt((2 * WAVE_SLOPE_VARIANCE) / WAVE_COUNT);
  let variance = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const lambda = SHORTEST * Math.pow(LONGEST / SHORTEST, i / (WAVE_COUNT - 1));
    const kmag = TAU / lambda;
    // Every fourth wave crosses the others at any angle; the rest stay within SPREAD of the polar axis.
    const beta = (rnd() * 2 - 1) * (i % 4 === 3 ? Math.PI / 2 : SPREAD);
    const gamma = rnd() * TAU;
    const sign = rnd() < 0.5 ? -1 : 1;
    const dx = Math.sin(beta) * Math.cos(gamma) * sign;
    const dy = Math.sin(beta) * Math.sin(gamma) * sign;
    const dz = Math.cos(beta) * sign;
    k[i * 4] = Math.fround(dx * kmag);
    k[i * 4 + 1] = Math.fround(dy * kmag);
    k[i * 4 + 2] = Math.fround(dz * kmag);
    k[i * 4 + 3] = Math.fround(slope / kmag);
    omega[i] = Math.sqrt(GRAVITY * kmag);
    phase0[i] = rnd() * TAU;
    variance += 0.5 * slope * slope;
  }
  return { k, omega, phase0, slopeVariance: variance };
}

/**
 * Phase of every wave at the camera (rad, in [0, 2π)) for its ECEF position and the simulation time, into `out`.
 * The shader's sin(k·p + phase) at camera-relative p then equals sin(k·x − ωt + φ₀) at the absolute position x.
 */
export function wavePhases(w: WaveSet, camera: ArrayLike<number>, time: number, out: Float32Array): Float32Array {
  for (let i = 0; i < WAVE_COUNT; i++) {
    const ph = w.k[i * 4] * camera[0] + w.k[i * 4 + 1] * camera[1] + w.k[i * 4 + 2] * camera[2] - w.omega[i] * time + w.phase0[i];
    out[i] = ph - TAU * Math.floor(ph / TAU);
  }
  return out;
}
