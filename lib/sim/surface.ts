import { spin } from './attitude';
import { ecefToInertial, inertialToEcef } from './geo';
import type { Body } from './runtime';
import { EARTH_OMEGA } from './types';
import { qAxis, qAxisAngle, qMul, qNlerp, qRotZ, v3 } from './vec';

const OMEGA = EARTH_OMEGA;

/** Riding along with the rotating Earth (held in the tower arms). */
export function holdOnEarth(body: Body, dt: number): void {
  const c = Math.cos(OMEGA * dt), s = Math.sin(OMEGA * dt);
  const x = body.r[0], y = body.r[1];
  body.r[0] = c * x - s * y;
  body.r[1] = s * x + c * y;
  body.v[0] = -OMEGA * body.r[1];
  body.v[1] = OMEGA * body.r[0];
  body.v[2] = 0;
  body.w[0] = 0;
  body.w[1] = 0;
  body.w[2] = OMEGA;
  spin(body, dt);
  body.acc[0] = -OMEGA * OMEGA * body.r[0];
  body.acc[1] = -OMEGA * OMEGA * body.r[1];
  body.acc[2] = 0;
}

/** A booster settling into the tower arms (Earth-fixed poses, so the hold rides with the Earth). */
export interface ArmsState {
  r0: Float64Array; // CoM at capture, ECEF
  q0: Float64Array; // attitude at capture, body -> ECEF
  r1: Float64Array; // CoM held in the arms, ECEF
  q1: Float64Array; // attitude held in the arms (upright), body -> ECEF
  t0: number;
}

/** Time the arms take to take the booster's weight and square it up, s. */
const SETTLE_TIME = 1;
const qz = new Float64Array(4), qe = new Float64Array(4), rE = v3(), vE = v3();

/** Captures the body's pose (inertial at time t) as the start of the settle into the arms. */
export function startArms(arms: ArmsState, body: Body, t: number): void {
  inertialToEcef(arms.r0, body.r, t);
  qMul(arms.q0, qRotZ(qz, -OMEGA * t), body.q);
  arms.t0 = t;
}

/** Eases the booster from its capture pose into the arms' pose over SETTLE_TIME, then holds it. */
export function holdInArms(body: Body, arms: ArmsState, t: number): void {
  const f = Math.min(1, Math.max(0, (t - arms.t0) / SETTLE_TIME));
  const s = f * f * (3 - 2 * f);
  const ds = (6 * f * (1 - f)) / SETTLE_TIME;
  for (let i = 0; i < 3; i++) {
    rE[i] = arms.r0[i] + (arms.r1[i] - arms.r0[i]) * s;
    vE[i] = (arms.r1[i] - arms.r0[i]) * ds;
  }
  ecefToInertial(body.r, rE, t);
  ecefToInertial(body.v, vE, t);
  body.v[0] -= OMEGA * body.r[1];
  body.v[1] += OMEGA * body.r[0];
  qNlerp(qe, arms.q0, arms.q1, s);
  qMul(body.q, qRotZ(qz, OMEGA * t), qe);
  body.w[0] = 0;
  body.w[1] = 0;
  body.w[2] = OMEGA;
  body.acc[0] = -OMEGA * OMEGA * body.r[0];
  body.acc[1] = -OMEGA * OMEGA * body.r[1];
  body.acc[2] = 0;
}

/** Time an upright vehicle takes to fall over onto the water, s. */
const TIP_TIME = 7;

/** A vehicle tipping over after a vertical splashdown (inertial vectors at the splash time t0). */
export interface TipState {
  up: Float64Array; // local vertical
  dir: Float64Array; // horizontal direction it falls towards
  base: Float64Array; // base position at the waterline
  comH: number; // CoM height above the base
  t0: number;
  /** Attitude at the splash (inertial at t0) and its lean from the vertical, rad. */
  q0: Float64Array;
  lean: number;
  /** Horizontal axis the fall turns about (up × dir) and the fall time, s. */
  axis: Float64Array;
  span: number;
}

export function newTipState(): TipState {
  return { up: v3(), dir: v3(), base: v3(), comH: 0, t0: 0, q0: new Float64Array(4), lean: 0, axis: v3(), span: TIP_TIME };
}

const yAx = v3(), zAx = v3();
const qa = new Float64Array(4), qt = new Float64Array(4);

/**
 * Starts the fall from the attitude the vehicle splashed down in: it keeps falling the way it already
 * leans (towards its belly when it is upright), so there is no snap back to the vertical.
 */
export function startTip(tip: TipState, body: Body, up: Float64Array, base: Float64Array, comH: number, t: number): void {
  qAxis(yAx, body.q, 1);
  qAxis(zAx, body.q, 2);
  const c = Math.max(-1, Math.min(1, yAx[0] * up[0] + yAx[1] * up[1] + yAx[2] * up[2]));
  tip.lean = Math.min(Math.acos(c), Math.PI / 2);
  // Lean direction once the tilt is clear of noise, else the belly.
  const src = tip.lean > 0.01 ? yAx : zAx;
  const k = src[0] * up[0] + src[1] * up[1] + src[2] * up[2];
  for (let i = 0; i < 3; i++) tip.dir[i] = src[i] - k * up[i];
  const dl = Math.sqrt(tip.dir[0] ** 2 + tip.dir[1] ** 2 + tip.dir[2] ** 2) || 1;
  for (let i = 0; i < 3; i++) tip.dir[i] /= dl;
  tip.axis[0] = up[1] * tip.dir[2] - up[2] * tip.dir[1];
  tip.axis[1] = up[2] * tip.dir[0] - up[0] * tip.dir[2];
  tip.axis[2] = up[0] * tip.dir[1] - up[1] * tip.dir[0];
  tip.up.set(up);
  tip.base.set(base);
  tip.comH = comH;
  tip.t0 = t;
  tip.q0.set(body.q);
  // An inverted pendulum that already leans has less far to fall.
  tip.span = TIP_TIME * Math.sqrt(1 - tip.lean / (Math.PI / 2));
}

/** Falls over onto the water from the splash attitude, rotating about its base, while riding with the Earth. */
export function tipOver(body: Body, tip: TipState, t: number): void {
  const age = t - tip.t0;
  const span = Math.max(0.5, tip.span);
  const f = Math.min(1, age / span);
  const fall = Math.PI / 2 - tip.lean;
  const th = fall * f * f; // accelerating fall, from rest
  const thDot = age < span ? (2 * fall * f) / span : 0;
  const c = Math.cos(OMEGA * age), s = Math.sin(OMEGA * age);
  // Fall about the Earth-fixed axis, then the Earth's rotation since the splash.
  qAxisAngle(qa, tip.axis, th);
  qMul(qt, qa, tip.q0);
  qMul(body.q, qRotZ(qa, OMEGA * age), qt);
  qAxis(yAx, body.q, 1);
  const bx = c * tip.base[0] - s * tip.base[1], by = s * tip.base[0] + c * tip.base[1], bz = tip.base[2];
  body.r[0] = bx + yAx[0] * tip.comH;
  body.r[1] = by + yAx[1] * tip.comH;
  body.r[2] = bz + yAx[2] * tip.comH;
  // CoM velocity: Earth rotation plus the swing about the base (axis × arm).
  const ax = c * tip.axis[0] - s * tip.axis[1], ay = s * tip.axis[0] + c * tip.axis[1], az = tip.axis[2];
  const sw = tip.comH * thDot;
  body.v[0] = -OMEGA * body.r[1] + sw * (ay * yAx[2] - az * yAx[1]);
  body.v[1] = OMEGA * body.r[0] + sw * (az * yAx[0] - ax * yAx[2]);
  body.v[2] = sw * (ax * yAx[1] - ay * yAx[0]);
  body.w[0] = body.w[1] = 0;
  body.w[2] = OMEGA;
  body.acc[0] = body.acc[1] = body.acc[2] = 0;
}
