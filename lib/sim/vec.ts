/**
 * Small allocation-free vector and quaternion helpers for the simulator's hot paths.
 * Vectors are `number[]`/`Float64Array` triples; quaternions are x, y, z, w quadruples.
 */

export type V3 = Float64Array | number[];
export type Q4 = Float64Array | number[];

/** Public-facing 3-vector: either an {x,y,z} object or an indexable triple. */
export type Vec3Like = { x: number; y: number; z: number } | ArrayLike<number>;

export function v3(): Float64Array {
  return new Float64Array(3);
}

export function readVec3(p: Vec3Like, out: V3): V3 {
  if ('x' in p) {
    out[0] = p.x;
    out[1] = p.y;
    out[2] = p.z;
  } else {
    out[0] = p[0];
    out[1] = p[1];
    out[2] = p[2];
  }
  return out;
}

export function set3(out: V3, x: number, y: number, z: number): V3 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function copy3(out: V3, a: V3): V3 {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

export function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function len3(a: V3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

export function cross3(out: V3, a: V3, b: V3): V3 {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/** Normalises in place-safe fashion; leaves `fallback` (or zero) when the input is degenerate. */
export function normalize3(out: V3, a: V3, fallback?: V3): V3 {
  const l = len3(a);
  if (l < 1e-12) {
    if (fallback) return copy3(out, fallback);
    return set3(out, 0, 0, 0);
  }
  out[0] = a[0] / l;
  out[1] = a[1] / l;
  out[2] = a[2] / l;
  return out;
}

export function scale3(out: V3, a: V3, s: number): V3 {
  out[0] = a[0] * s;
  out[1] = a[1] * s;
  out[2] = a[2] * s;
  return out;
}

export function add3(out: V3, a: V3, b: V3): V3 {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

export function sub3(out: V3, a: V3, b: V3): V3 {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

/** out = a + b * s */
export function addScaled3(out: V3, a: V3, b: V3, s: number): V3 {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  out[2] = a[2] + b[2] * s;
  return out;
}

/** Component of `a` perpendicular to unit vector `n`. */
export function reject3(out: V3, a: V3, n: V3): V3 {
  const d = dot3(a, n);
  out[0] = a[0] - n[0] * d;
  out[1] = a[1] - n[1] * d;
  out[2] = a[2] - n[2] * d;
  return out;
}

export function angleBetween3(a: V3, b: V3): number {
  const la = len3(a);
  const lb = len3(b);
  if (la < 1e-12 || lb < 1e-12) return 0;
  const c = dot3(a, b) / (la * lb);
  return Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
}

// ---------------------------------------------------------------------------
// Quaternions (x, y, z, w), Hamilton convention, rotating body vectors into the parent frame.
// ---------------------------------------------------------------------------

export function q4(): Float64Array {
  const q = new Float64Array(4);
  q[3] = 1;
  return q;
}

export function copyQ(out: Q4, a: Q4): Q4 {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  out[3] = a[3];
  return out;
}

export function qMul(out: Q4, a: Q4, b: Q4): Q4 {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function qNormalize(out: Q4, a: Q4): Q4 {
  const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]) || 1;
  out[0] = a[0] / l;
  out[1] = a[1] / l;
  out[2] = a[2] / l;
  out[3] = a[3] / l;
  return out;
}

/** Rotates vector `v` by unit quaternion `q`. */
export function qRotate(out: V3, q: Q4, v: V3): V3 {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const vx = v[0], vy = v[1], vz = v[2];
  // t = 2 * (q.xyz × v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** Body axis k (0 = X, 1 = Y, 2 = Z) of attitude `q`, expressed in the parent frame. */
export function qAxis(out: V3, q: Q4, k: 0 | 1 | 2): V3 {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  if (k === 0) return set3(out, 1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w));
  if (k === 1) return set3(out, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w));
  return set3(out, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y));
}

/** Quaternion whose rotation matrix has columns X, Y, Z (orthonormal, right-handed). */
export function qFromBasis(out: Q4, X: V3, Y: V3, Z: V3): Q4 {
  const m00 = X[0], m10 = X[1], m20 = X[2];
  const m01 = Y[0], m11 = Y[1], m21 = Y[2];
  const m02 = Z[0], m12 = Z[1], m22 = Z[2];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    out[3] = 0.25 / s;
    out[0] = (m21 - m12) * s;
    out[1] = (m02 - m20) * s;
    out[2] = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out[3] = (m21 - m12) / s;
    out[0] = 0.25 * s;
    out[1] = (m01 + m10) / s;
    out[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out[3] = (m02 - m20) / s;
    out[0] = (m01 + m10) / s;
    out[1] = 0.25 * s;
    out[2] = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out[3] = (m10 - m01) / s;
    out[0] = (m02 + m20) / s;
    out[1] = (m12 + m21) / s;
    out[2] = 0.25 * s;
  }
  return qNormalize(out, out);
}

const tmpX = v3();
const tmpY = v3();
const tmpZ = v3();

/**
 * Attitude whose +Y points along `yDir` and whose +Z lies as close as possible to `zRef`.
 * Falls back to an arbitrary perpendicular when `zRef` is parallel to `yDir`.
 */
export function qLook(out: Q4, yDir: V3, zRef: V3): Q4 {
  normalize3(tmpY, yDir);
  reject3(tmpZ, zRef, tmpY);
  if (len3(tmpZ) < 1e-6) {
    // Any perpendicular will do; pick the axis least aligned with Y.
    const ax = Math.abs(tmpY[0]), ay = Math.abs(tmpY[1]), az = Math.abs(tmpY[2]);
    if (ax <= ay && ax <= az) set3(tmpZ, 1, 0, 0);
    else if (ay <= az) set3(tmpZ, 0, 1, 0);
    else set3(tmpZ, 0, 0, 1);
    reject3(tmpZ, tmpZ, tmpY);
  }
  normalize3(tmpZ, tmpZ);
  cross3(tmpX, tmpY, tmpZ);
  return qFromBasis(out, tmpX, tmpY, tmpZ);
}

/** Rotation by angle (rad) about +Z. */
export function qRotZ(out: Q4, angle: number): Q4 {
  out[0] = 0;
  out[1] = 0;
  out[2] = Math.sin(angle / 2);
  out[3] = Math.cos(angle / 2);
  return out;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export const DEG = Math.PI / 180;
