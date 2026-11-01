import type { Quat, Vec3 } from './sim/sample';

/**
 * Signed roll about body +Y, measured from local down to body +Z (the ship's heat shield).
 * Zero is belly down, ±90° is side-on and 180° is belly up. This is an attitude angle,
 * not an angular velocity or a commanded bank. Position and quaternion share the ECEF frame.
 * Within one milliradian of a vertical nose, local down cannot define a stable roll reference.
 */
export function rollFromPose(position: Vec3, quaternion: Quat): number | null {
  const { x: px, y: py, z: pz } = position;
  const r2 = px * px + py * py + pz * pz;
  const { x, y, z, w } = quaternion;
  const q2 = x * x + y * y + z * z + w * w;
  if (!(r2 > 0) || !(q2 > 1e-24) || !Number.isFinite(r2) || !Number.isFinite(q2)) return null;
  // Normalize the rotation matrix directly; recorded quaternions are float32.
  const k = 2 / q2;
  const xx = 1 - k * (y * y + z * z), xy = k * (x * y + z * w), xz = k * (x * z - y * w);
  const zx = k * (x * z + y * w), zy = k * (y * z - x * w), zz = 1 - k * (x * x + y * y);
  const sine = px * xx + py * xy + pz * xz;
  const cosine = -(px * zx + py * zy + pz * zz);
  if (sine * sine + cosine * cosine <= 1e-6 * r2) return null;
  const angle = Math.atan2(sine, cosine) * 180 / Math.PI;
  return Math.abs(angle) < 1e-10 ? 0 : angle <= -180 ? 180 : angle;
}

/**
 * Earth-relative angular velocity about body +Y (nose), deg/s, from adjacent packed x/y/z/w
 * samples. `index` is the first sample index, `fraction` is 0..1 and `dt` is their separation.
 * Differentiates the same shortest-sign normalized lerp as sampleTrack, including float32
 * endpoint norm differences. This is a replay interpolation estimate, not a gyro measurement
 * or the derivative of rollFromPose. It remains defined when the nose is vertical.
 * Invalid/missing quaternions or a nonpositive interval return null. Allocates nothing.
 */
export function axialRollRateFromSamples(quat: ArrayLike<number>, index: number, fraction: number, dt: number): number | null {
  if (!Number.isInteger(index) || index < 0 || !(fraction >= 0 && fraction <= 1) || !(dt > 0) || !Number.isFinite(dt)) return null;
  const i = index * 4, j = i + 4;
  const ax = quat[i], ay = quat[i + 1], az = quat[i + 2], aw = quat[i + 3];
  const bx = quat[j], by = quat[j + 1], bz = quat[j + 2], bw = quat[j + 3];
  const a2 = ax * ax + ay * ay + az * az + aw * aw;
  const b2 = bx * bx + by * by + bz * bz + bw * bw;
  if (!(a2 > 1e-24) || !(b2 > 1e-24) || !Number.isFinite(a2) || !Number.isFinite(b2)) return null;
  const sign = ax * bx + ay * by + az * bz + aw * bw < 0 ? -1 : 1;
  const dx = sign * bx - ax, dy = sign * by - ay, dz = sign * bz - az, dw = sign * bw - aw;
  const x = ax + fraction * dx, y = ay + fraction * dy, z = az + fraction * dz, w = aw + fraction * dw;
  const norm2 = x * x + y * y + z * z + w * w;
  if (!(norm2 > 1e-24) || !Number.isFinite(norm2)) return null;
  // For q = u/|u|, the radial part of qdot contributes only to the scalar component of
  // conj(q)*qdot. Its body-Y component is therefore (w*dy - y*dw + x*dz - z*dx)/|u|²/dt.
  const rate = (360 / Math.PI) * ((w * dy - y * dw + x * dz - z * dx) / norm2) / dt;
  return Number.isFinite(rate) ? Math.abs(rate) < 1e-10 ? 0 : rate : null;
}
