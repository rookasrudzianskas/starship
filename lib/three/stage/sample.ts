import * as THREE from 'three';
import type { PhaseCode, Track } from '@/lib/sim/types';
// Relative so the director can be unit tested (vitest has no @/ alias).
import { sampleIndex } from '../../telemetry';

/** Everything the stage needs from one track at one instant. Reused between frames (no allocation). */
export interface StageSample {
  /** t is within [start, end]. */
  alive: boolean;
  /** Centre of mass, ECEF metres (float64). */
  pos: [number, number, number];
  vel: [number, number, number];
  quat: THREE.Quaternion;
  com: number;
  alt: number;
  speed: number;
  mach: number;
  q: number;
  aoa: number;
  throttle: number;
  heating: number;
  aero: [number, number, number, number];
  phase: PhaseCode;
}

export function createSample(): StageSample {
  return {
    alive: false,
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    quat: new THREE.Quaternion(),
    com: 0,
    alt: 0,
    speed: 0,
    mach: 0,
    q: 0,
    aoa: 0,
    throttle: 0,
    heating: 0,
    aero: [0, 0, 0, 0],
    phase: 0,
  };
}

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

/** Sample a track: cubic Hermite position (using velocity), slerped attitude, linear scalars. */
export function sampleTrack(track: Track, t: number, out: StageSample): StageSample {
  const n = track.n;
  out.alive = t >= track.start && t <= track.end;
  const tc = Math.min(Math.max(t, track.start), track.end);
  const i = sampleIndex(track.t, n, tc);
  const j = Math.min(n - 1, i + 1);
  const t0 = track.t[i];
  const t1 = track.t[j];
  const h = t1 - t0;
  const s = h > 0 ? Math.min(1, Math.max(0, (tc - t0) / h)) : 0;

  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const p = track.pos;
  const v = track.vel;
  for (let k = 0; k < 3; k++) {
    const p0 = p[i * 3 + k];
    const p1 = p[j * 3 + k];
    const v0 = v[i * 3 + k];
    const v1 = v[j * 3 + k];
    out.pos[k] = h00 * p0 + h10 * h * v0 + h01 * p1 + h11 * h * v1;
    out.vel[k] = v0 + (v1 - v0) * s;
  }

  const q = track.quat;
  qa.set(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]);
  qb.set(q[j * 4], q[j * 4 + 1], q[j * 4 + 2], q[j * 4 + 3]);
  out.quat.slerpQuaternions(qa, qb, s).normalize();

  const lerp = (arr: Float32Array) => arr[i] + (arr[j] - arr[i]) * s;
  out.com = lerp(track.com);
  out.alt = lerp(track.alt);
  out.speed = lerp(track.speed);
  out.mach = lerp(track.mach);
  out.q = lerp(track.q);
  out.aoa = lerp(track.aoa);
  out.throttle = lerp(track.throttle);
  out.heating = lerp(track.heating);
  for (let k = 0; k < 4; k++) out.aero[k] = track.aero[i * 4 + k] + (track.aero[j * 4 + k] - track.aero[i * 4 + k]) * s;
  out.phase = track.phase[s < 1 ? i : j] as PhaseCode;
  return out;
}

/** First time a track enters a phase, or null. */
export function firstPhaseTime(track: Track, phase: number, after = -Infinity): number | null {
  for (let i = 0; i < track.n; i++) if (track.phase[i] === phase && track.t[i] >= after) return track.t[i];
  return null;
}
