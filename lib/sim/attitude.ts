import type { Body } from './runtime';
import { qMul as qMulFn, qNormalize as qNormalizeFn, type Q4 } from './vec';

const qMul = qMulFn;
const qNormalize = qNormalizeFn;

const err = new Float64Array(4);
const dq = new Float64Array(4);
const conj = new Float64Array(4);

/** Integrates the attitude with the body's current angular velocity for dt seconds. */
export function spin(body: Body, dt: number): void {
  const w = body.w;
  const wl = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
  if (wl < 1e-12) return;
  const half = 0.5 * wl * dt;
  const s = Math.sin(half) / wl;
  dq[0] = w[0] * s;
  dq[1] = w[1] * s;
  dq[2] = w[2] * s;
  dq[3] = Math.cos(half);
  qMul(body.q, dq, body.q);
  qNormalize(body.q, body.q);
}

/**
 * Kinematic attitude control: rotates towards `target` along the shortest path with an angular-rate
 * limit and an angular-acceleration limit (a smooth bang-coast-bang slew that settles without overshoot).
 * Returns the remaining error angle, rad.
 */
export function slew(body: Body, target: Q4, maxRate: number, maxAcc: number, dt: number): number {
  const q = body.q;
  conj[0] = -q[0];
  conj[1] = -q[1];
  conj[2] = -q[2];
  conj[3] = q[3];
  qMul(err, target, conj);
  if (err[3] < 0) {
    err[0] = -err[0];
    err[1] = -err[1];
    err[2] = -err[2];
    err[3] = -err[3];
  }
  const sh = Math.sqrt(err[0] * err[0] + err[1] * err[1] + err[2] * err[2]);
  const angle = 2 * Math.atan2(sh, err[3]);
  const w = body.w;
  let wdx = 0, wdy = 0, wdz = 0;
  if (sh > 1e-12) {
    let mag = Math.min(maxRate, Math.sqrt(2 * maxAcc * angle));
    if (mag * dt > angle) mag = angle / dt;
    wdx = (err[0] / sh) * mag;
    wdy = (err[1] / sh) * mag;
    wdz = (err[2] / sh) * mag;
  }
  let ex = wdx - w[0], ey = wdy - w[1], ez = wdz - w[2];
  const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const lim = maxAcc * dt;
  if (el > lim) {
    ex *= lim / el;
    ey *= lim / el;
    ez *= lim / el;
  }
  w[0] += ex;
  w[1] += ey;
  w[2] += ez;
  spin(body, dt);
  return angle;
}

/** Angle between two attitudes, rad. */
export function attitudeError(a: Q4, b: Q4): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(d > 1 ? 1 : d);
}
