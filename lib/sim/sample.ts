import { Phase, type PhaseCode, type Track } from './types';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * One vehicle at one instant, interpolated from its Track. `pos`/`vel` are ECEF metres and m/s as
 * {x, y, z} objects and `quat` is the body→ECEF attitude as {x, y, z, w}, so they copy straight into
 * THREE.Vector3 / THREE.Quaternion. Other fields mirror the Track columns (see lib/sim/types.ts).
 */
export interface TrackSample {
  t: number;
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  com: number;
  alt: number;
  speed: number;
  vspeed: number;
  accel: number;
  mach: number;
  q: number;
  pitch: number;
  aoa: number;
  throttle: number;
  lox: number;
  ch4: number;
  heating: number;
  aero: [number, number, number, number];
  phase: PhaseCode;
  /** False before the track starts, after it ends, and on the final sample of a destroyed vehicle. */
  alive: boolean;
}

export function createTrackSample(): TrackSample {
  return {
    t: 0,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    com: 0,
    alt: 0,
    speed: 0,
    vspeed: 0,
    accel: 0,
    mach: 0,
    q: 0,
    pitch: 0,
    aoa: 0,
    throttle: 0,
    lox: 0,
    ch4: 0,
    heating: 0,
    aero: [0, 0, 0, 0],
    phase: Phase.Pad,
    alive: false,
  };
}

function lerp(arr: Float32Array, i: number, j: number, s: number): number {
  return arr[i] + s * (arr[j] - arr[i]);
}

/** Index i with t[i] <= time < t[i + 1] (time already clamped to the track). */
function bracket(t: Float64Array, n: number, time: number): number {
  let lo = 0;
  let hi = n - 1;
  if (time >= t[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= time) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Interpolates a track at time t (clamped to [start, end]) into `out` without allocating:
 * cubic Hermite position (using the stored velocities) and its derivative for velocity, linear scalars,
 * normalised lerp for the attitude, and the phase of the earlier sample.
 */
export function sampleTrack(track: Track, t: number, out: TrackSample): TrackSample {
  const n = track.n;
  out.alive = n > 0 && t >= track.start && t <= track.end;
  if (n === 0) return out;
  const time = t < track.start ? track.start : t > track.end ? track.end : t;
  const i = bracket(track.t, n, time);
  const j = i < n - 1 ? i + 1 : i;
  const t0 = track.t[i];
  const h = track.t[j] - t0;
  const s = h > 0 ? (time - t0) / h : 0;
  out.t = time;

  // Position / velocity: cubic Hermite.
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const d00 = 6 * s2 - 6 * s;
  const d10 = 3 * s2 - 4 * s + 1;
  const d01 = -6 * s2 + 6 * s;
  const d11 = 3 * s2 - 2 * s;
  const P = track.pos;
  const V = track.vel;
  const a = 3 * i;
  const b = 3 * j;
  if (h > 0) {
    const inv = 1 / h;
    out.pos.x = h00 * P[a] + h10 * h * V[a] + h01 * P[b] + h11 * h * V[b];
    out.pos.y = h00 * P[a + 1] + h10 * h * V[a + 1] + h01 * P[b + 1] + h11 * h * V[b + 1];
    out.pos.z = h00 * P[a + 2] + h10 * h * V[a + 2] + h01 * P[b + 2] + h11 * h * V[b + 2];
    out.vel.x = (d00 * P[a] + d01 * P[b]) * inv + d10 * V[a] + d11 * V[b];
    out.vel.y = (d00 * P[a + 1] + d01 * P[b + 1]) * inv + d10 * V[a + 1] + d11 * V[b + 1];
    out.vel.z = (d00 * P[a + 2] + d01 * P[b + 2]) * inv + d10 * V[a + 2] + d11 * V[b + 2];
  } else {
    out.pos.x = P[a];
    out.pos.y = P[a + 1];
    out.pos.z = P[a + 2];
    out.vel.x = V[a];
    out.vel.y = V[a + 1];
    out.vel.z = V[a + 2];
  }

  // Attitude: normalised lerp along the shorter arc.
  const Q = track.quat;
  const qa = 4 * i;
  const qb = 4 * j;
  const dot = Q[qa] * Q[qb] + Q[qa + 1] * Q[qb + 1] + Q[qa + 2] * Q[qb + 2] + Q[qa + 3] * Q[qb + 3];
  const sb = dot < 0 ? -s : s;
  const sa = 1 - s;
  const qx = sa * Q[qa] + sb * Q[qb];
  const qy = sa * Q[qa + 1] + sb * Q[qb + 1];
  const qz = sa * Q[qa + 2] + sb * Q[qb + 2];
  const qw = sa * Q[qa + 3] + sb * Q[qb + 3];
  const ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
  out.quat.x = qx / ql;
  out.quat.y = qy / ql;
  out.quat.z = qz / ql;
  out.quat.w = qw / ql;

  // Scalars: linear.
  out.com = lerp(track.com, i, j, s);
  out.alt = lerp(track.alt, i, j, s);
  out.speed = lerp(track.speed, i, j, s);
  out.vspeed = lerp(track.vspeed, i, j, s);
  out.accel = lerp(track.accel, i, j, s);
  out.mach = lerp(track.mach, i, j, s);
  out.q = lerp(track.q, i, j, s);
  out.aoa = lerp(track.aoa, i, j, s);
  out.throttle = lerp(track.throttle, i, j, s);
  out.lox = lerp(track.lox, i, j, s);
  out.ch4 = lerp(track.ch4, i, j, s);
  out.heating = lerp(track.heating, i, j, s);
  // Pitch wraps at ±180°: interpolate along the shorter way round.
  let dp = track.pitch[j] - track.pitch[i];
  if (dp > 180) dp -= 360;
  else if (dp < -180) dp += 360;
  let pitch = track.pitch[i] + s * dp;
  if (pitch > 180) pitch -= 360;
  else if (pitch <= -180) pitch += 360;
  out.pitch = pitch;
  const A = track.aero;
  for (let k = 0; k < 4; k++) out.aero[k] = A[4 * i + k] + s * (A[4 * j + k] - A[4 * i + k]);
  out.phase = track.phase[i] as PhaseCode;
  if (out.phase === Phase.Destroyed) out.alive = false;
  return out;
}
