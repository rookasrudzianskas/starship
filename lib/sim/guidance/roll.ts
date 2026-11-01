import { spin as spinFn } from '../attitude';
import type { Body } from '../runtime';
import { clamp, qAxis as qAxisFn, type Q4, type V3 } from '../vec';

const spin = spinFn, qAxis = qAxisFn;

const nose = new Float64Array(3), belly = new Float64Array(3);

/** Independent nose steering and roll control: a roll command cannot consume the pitch/yaw rate budget. */
export function slewNoseAndRoll(body: Body, targetNose: V3, rollReference: V3, maxRate: number, maxAcc: number, dt: number): number {
  if (dt <= 0) return 0;
  const targetLength = Math.sqrt(targetNose[0] ** 2 + targetNose[1] ** 2 + targetNose[2] ** 2) || 1;
  const tx = targetNose[0] / targetLength, ty = targetNose[1] / targetLength, tz = targetNose[2] / targetLength;
  const referenceLength2 = rollReference[0] ** 2 + rollReference[1] ** 2 + rollReference[2] ** 2;
  // Vacuum coasts use 2 s translation steps; attitude remains at 10 Hz so a long coast step
  // cannot bypass acceleration limits or jump through the target.
  if (dt > 0.100001) {
    const steps = Math.ceil(dt / 0.1), h = dt / steps;
    const q = body.q, w = body.w;
    let error = 0;
    for (let i = 0; i < steps; i++) {
      const qx = q[0], qy = q[1], qz = q[2], qw = q[3], wx = w[0], wy = w[1], wz = w[2];
      error = slewStep(body, tx, ty, tz, rollReference, referenceLength2, maxRate, maxAcc, h);
      // The held target makes this an exact fixed point: all remaining identical steps
      // would return the same attitude, rate and error. Do not use an angular tolerance here.
      if (q[0] === qx && q[1] === qy && q[2] === qz && q[3] === qw && w[0] === wx && w[1] === wy && w[2] === wz) break;
    }
    return error;
  }
  return slewStep(body, tx, ty, tz, rollReference, referenceLength2, maxRate, maxAcc, dt);
}

/** One unchanged attitude substep; target normalization is shared by a held-target coast interval. */
function slewStep(body: Body, tx: number, ty: number, tz: number, rollReference: V3, referenceLength2: number, maxRate: number, maxAcc: number, dt: number): number {
  qAxis(nose, body.q, 1);
  const w = body.w;
  const rollRate = w[0] * nose[0] + w[1] * nose[1] + w[2] * nose[2];
  let wx = w[0] - rollRate * nose[0], wy = w[1] - rollRate * nose[1], wz = w[2] - rollRate * nose[2];
  let ax = nose[1] * tz - nose[2] * ty, ay = nose[2] * tx - nose[0] * tz, az = nose[0] * ty - nose[1] * tx;
  let sinAngle = Math.sqrt(ax * ax + ay * ay + az * az);
  const cosAngle = Math.max(-1, Math.min(1, nose[0] * tx + nose[1] * ty + nose[2] * tz));
  const angle = Math.atan2(sinAngle, cosAngle);
  if (sinAngle < 1e-12 && cosAngle < 0) {
    // An exactly antipodal nose target has no unique turn plane. Continue the existing swing
    // when possible; otherwise choose a world-frame perpendicular independent of vehicle roll.
    sinAngle = Math.hypot(wx, wy, wz);
    if (sinAngle > 1e-10) { ax = wx; ay = wy; az = wz; }
    else {
      const k = Math.abs(nose[0]) < 0.8 ? 0 : 1;
      ax = k === 0 ? 0 : -nose[2];
      ay = k === 0 ? nose[2] : 0;
      az = k === 0 ? -nose[1] : nose[0];
      sinAngle = Math.hypot(ax, ay, az);
    }
  }
  const speed = sinAngle > 1e-12 ? Math.min(maxRate, Math.sqrt(2 * maxAcc * angle), angle / dt) / sinAngle : 0;
  let dx = ax * speed - wx, dy = ay * speed - wy, dz = az * speed - wz;
  const change = Math.sqrt(dx * dx + dy * dy + dz * dz), limit = maxAcc * dt;
  if (change > limit) { const scale = limit / change; dx *= scale; dy *= scale; dz *= scale; }
  wx += dx; wy += dy; wz += dz;
  w[0] = wx; w[1] = wy; w[2] = wz;
  spin(body, dt);

  qAxis(nose, body.q, 1);
  qAxis(belly, body.q, 2);
  const cx = belly[1] * rollReference[2] - belly[2] * rollReference[1];
  const cy = belly[2] * rollReference[0] - belly[0] * rollReference[2];
  const cz = belly[0] * rollReference[1] - belly[1] * rollReference[0];
  const projection = nose[0] * rollReference[0] + nose[1] * rollReference[1] + nose[2] * rollReference[2];
  // A reference on the nose axis has no roll information: brake the axial rate, retain orientation.
  const error = referenceLength2 - projection * projection <= 1e-12 * referenceLength2 ? 0 : Math.atan2(nose[0] * cx + nose[1] * cy + nose[2] * cz,
    belly[0] * rollReference[0] + belly[1] * rollReference[1] + belly[2] * rollReference[2]);
  const desired = Math.sign(error) * Math.min(maxRate, Math.sqrt(2 * maxAcc * Math.abs(error)), Math.abs(error) / dt);
  const nextRoll = rollRate + Math.max(-limit, Math.min(limit, desired - rollRate));
  w[0] = nose[0] * nextRoll; w[1] = nose[1] * nextRoll; w[2] = nose[2] * nextRoll;
  spin(body, dt);
  w[0] += wx; w[1] += wy; w[2] += wz;
  return angle;
}

/** Ship mounting: qShip = qStack · Ry(π). Leaves the shared +Y axis and inertial angular velocity unchanged. */
export function mountedShipAttitude(out: Q4, stack: Q4): Q4 {
  const x = stack[0], y = stack[1], z = stack[2], w = stack[3];
  out[0] = -z;
  out[1] = w;
  out[2] = x;
  out[3] = -y;
  return out;
}

/** Unit cross-track roll reference: +1 is left (up × heading), −1 is right (heading × up). */
export function crossTrackReference(out: V3, up: V3, heading: V3, side: 1 | -1): V3 {
  let x = up[1] * heading[2] - up[2] * heading[1];
  let y = up[2] * heading[0] - up[0] * heading[2];
  let z = up[0] * heading[1] - up[1] * heading[0];
  let length = Math.sqrt(x * x + y * y + z * z);
  if (length < 1e-12) {
    // No horizontal heading: choose a deterministic perpendicular rather than divide by zero.
    if (Math.abs(up[0]) <= Math.abs(up[1]) && Math.abs(up[0]) <= Math.abs(up[2])) {
      x = 0; y = up[2]; z = -up[1];
    } else if (Math.abs(up[1]) <= Math.abs(up[2])) {
      x = -up[2]; y = 0; z = up[0];
    } else {
      x = up[1]; y = -up[0]; z = 0;
    }
    length = Math.sqrt(x * x + y * y + z * z);
    if (length < 1e-12) { x = 1; y = 0; z = 0; length = 1; }
  }
  out[0] = side * x / length;
  out[1] = side * y / length;
  out[2] = side * z / length;
  return out;
}

/** A right-facing heat shield through ascent/coast, except Flight 14's separation roll.
 * The camera-supported hold is T+100..315; the approach begins earlier because roll is rate limited.
 * Transition timing/rates are reconstructed, not measured control telemetry.
 */
export function shipRollReference(out: V3, up: V3, heading: V3, flight: number, t: number): V3 {
  crossTrackReference(out, up, heading, -1);
  if (flight === 14) {
    const rise = clamp((t - 70) / 20, 0, 1), fall = clamp((t - 315) / 20, 0, 1);
    const weight = rise * rise * (3 - 2 * rise) * (1 - fall * fall * (3 - 2 * fall));
    const angle = weight * Math.PI / 2;
    for (let i = 0; i < 3; i++) out[i] = Math.cos(angle) * out[i] + Math.sin(angle) * up[i];
  }
  return out;
}

const targetY = new Float64Array(3), targetZ = new Float64Array(3);
/** Independent nose and axial-roll control, using the same quaternion target contract as slew(). */
export function slewFlight(body: Body, target: Q4, maxRate: number, maxAcc: number, dt: number): number {
  qAxis(targetY, target, 1);
  qAxis(targetZ, target, 2);
  return slewNoseAndRoll(body, targetY, targetZ, maxRate, maxAcc, dt);
}

const projectedReference = new Float64Array(3);
/** Guidance target without inventing an arbitrary roll when its reference is parallel to the nose.
 * Projection otherwise matches qLook's orthogonal frame, avoiding a quaternion conversion round trip.
 */
export function steerFlight(body: Body, targetNose: V3, rollReference: V3, maxRate: number, maxAcc: number, dt: number): number {
  const length2 = targetNose[0] ** 2 + targetNose[1] ** 2 + targetNose[2] ** 2;
  const along = length2 > 0 ? (targetNose[0] * rollReference[0] + targetNose[1] * rollReference[1] + targetNose[2] * rollReference[2]) / length2 : 0;
  for (let i = 0; i < 3; i++) projectedReference[i] = rollReference[i] - along * targetNose[i];
  const p2 = projectedReference[0] ** 2 + projectedReference[1] ** 2 + projectedReference[2] ** 2;
  const r2 = rollReference[0] ** 2 + rollReference[1] ** 2 + rollReference[2] ** 2;
  if (p2 <= 1e-12 * r2) projectedReference.fill(0);
  return slewNoseAndRoll(body, targetNose, projectedReference, maxRate, maxAcc, dt);
}
