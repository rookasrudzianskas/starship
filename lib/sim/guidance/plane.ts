/**
 * Horizontal steering direction that keeps an ascent in a target orbital plane (unit normal `n`, inertial):
 * the in-plane horizontal direction, yawed against any out-of-plane inertial velocity so it is nulled
 * gradually. Writes a unit vector into `out`.
 */
export function planeHeading(out: Float64Array, n: Float64Array, up: Float64Array, v: Float64Array): Float64Array {
  // In-plane horizontal: n × up points along the direction of motion for a prograde (eastward) plane.
  let hx = n[1] * up[2] - n[2] * up[1];
  let hy = n[2] * up[0] - n[0] * up[2];
  let hz = n[0] * up[1] - n[1] * up[0];
  let l = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
  hx /= l;
  hy /= l;
  hz /= l;
  const vh = Math.sqrt(Math.max(1, v[0] * v[0] + v[1] * v[1] + v[2] * v[2]));
  const vOut = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  // Yaw by up to ~10° against the out-of-plane velocity.
  const k = Math.max(-0.18, Math.min(0.18, (-2.5 * vOut) / vh));
  hx += k * n[0];
  hy += k * n[1];
  hz += k * n[2];
  l = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
  out[0] = hx / l;
  out[1] = hy / l;
  out[2] = hz / l;
  return out;
}
