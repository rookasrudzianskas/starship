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
