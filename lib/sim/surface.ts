import { spin } from './attitude';
import type { Body } from './runtime';
import { EARTH_OMEGA } from './types';
import { qLook, v3 } from './vec';

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

/** A vehicle tipping over after a vertical splashdown (inertial vectors at the splash time t0). */
export interface TipState {
  up: Float64Array; // local vertical
  dir: Float64Array; // horizontal direction it falls towards
  base: Float64Array; // base position at the waterline
  comH: number; // CoM height above the base
  t0: number;
}

const yAx = v3(), zAx = v3();
const qT = new Float64Array(4);
const TIP_TIME = 7;

/** Falls over onto the water within ~7 s, rotating about its base, while riding with the Earth. */
export function tipOver(body: Body, tip: TipState, t: number): void {
  const age = t - tip.t0;
  const f = Math.min(1, age / TIP_TIME);
  const th = (Math.PI / 2) * f * f; // accelerating fall
  const thDot = age < TIP_TIME ? (Math.PI * f) / TIP_TIME : 0;
  const c = Math.cos(OMEGA * age), s = Math.sin(OMEGA * age);
  const ct = Math.cos(th), st = Math.sin(th);
  const u = tip.up, d = tip.dir;
  // Earth-fixed directions rotated to the current inertial frame.
  const rot = (out: Float64Array, x: number, y: number, z: number) => {
    out[0] = c * x - s * y;
    out[1] = s * x + c * y;
    out[2] = z;
  };
  rot(yAx, ct * u[0] + st * d[0], ct * u[1] + st * d[1], ct * u[2] + st * d[2]);
  rot(zAx, ct * d[0] - st * u[0], ct * d[1] - st * u[1], ct * d[2] - st * u[2]);
  const bx = c * tip.base[0] - s * tip.base[1], by = s * tip.base[0] + c * tip.base[1], bz = tip.base[2];
  body.r[0] = bx + yAx[0] * tip.comH;
  body.r[1] = by + yAx[1] * tip.comH;
  body.r[2] = bz + yAx[2] * tip.comH;
  qLook(qT, yAx, zAx);
  body.q.set(qT);
  // CoM velocity: Earth rotation plus the swing about the base.
  const sw = tip.comH * thDot;
  body.v[0] = -OMEGA * body.r[1] + sw * (c * (-st * u[0] + ct * d[0]) - s * (-st * u[1] + ct * d[1]));
  body.v[1] = OMEGA * body.r[0] + sw * (s * (-st * u[0] + ct * d[0]) + c * (-st * u[1] + ct * d[1]));
  body.v[2] = sw * (-st * u[2] + ct * d[2]);
  body.w[0] = body.w[1] = 0;
  body.w[2] = OMEGA;
  body.acc[0] = body.acc[1] = body.acc[2] = 0;
}
