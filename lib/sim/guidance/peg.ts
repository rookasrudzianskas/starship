import { EARTH_MU } from '../types';

/**
 * Powered Explicit Guidance (planar, linear-tangent form as flown by the Shuttle and many upper stages).
 * The radial thrust component is steered as f_r(t) = A + B·t + C(t), where C cancels gravity minus
 * centrifugal acceleration, so the radial equations reach the cutoff radius and radial velocity exactly;
 * the time to go follows from the angular momentum still to be gained.
 */
export interface PegTarget {
  r: number; // cutoff radius, m
  rdot: number; // cutoff radial velocity, m/s
  vt: number; // cutoff horizontal (inertial) velocity, m/s
}

export interface PegState {
  A: number;
  B: number;
  T: number; // time to go, s
  tUpdate: number; // sim time of the last update
  valid: boolean;
  frozen: boolean; // terminal phase: coefficients held
}

export function newPeg(): PegState {
  return { A: 0, B: 0, T: 0, tUpdate: 0, valid: false, frozen: false };
}

/**
 * Updates the steering. `accel` is current thrust acceleration (m/s²), `ve` the effective exhaust
 * velocity (m/s). Returns the sine of the commanded pitch above the local horizon.
 */
export function pegStep(s: PegState, t: number, r: number, rdot: number, vt: number, accel: number, ve: number, tg: PegTarget): number {
  const omega = vt / r;
  const C = (EARTH_MU / (r * r) - omega * omega * r) / accel;
  if (!(accel > 1e-3) || !(ve > 100)) return clampFr(s.valid ? s.A + C : C);
  const tau = ve / accel;
  if (s.valid) {
    const elapsed = t - s.tUpdate;
    s.T -= elapsed;
    if (s.frozen) {
      // Terminal phase: steer the remaining radial-velocity error out directly over the time left.
      s.tUpdate = t;
      return clampFr(C + Math.max(-0.15, Math.min(0.15, (tg.rdot - rdot) / (accel * Math.max(s.T, 0.5)))));
    }
  } else {
    // Initial guess from the rocket equation on the remaining speed.
    const dv0 = Math.max(50, Math.hypot(tg.vt - vt, tg.rdot - rdot));
    s.T = Math.min(0.95 * tau, tau * (1 - Math.exp(-dv0 / ve)));
  }
  s.tUpdate = t;
  if (s.T < 8 && s.valid) {
    s.frozen = true;
    return clampFr(s.A + C);
  }
  for (let iter = 0; iter < 3; iter++) {
    const T = Math.min(Math.max(s.T, 1), 0.995 * tau);
    const b0 = -ve * Math.log(1 - T / tau);
    const b1 = b0 * tau - ve * T;
    const c0 = b0 * T - b1;
    const c1 = c0 * tau - (ve * T * T) / 2;
    const det = b0 * c1 - b1 * c0;
    if (!(Math.abs(det) > 1e-9)) break;
    const y1 = tg.rdot - rdot;
    const y2 = tg.r - r - rdot * T;
    const A = (c1 * y1 - b1 * y2) / det;
    const B = (b0 * y2 - c0 * y1) / det;
    // Time to go from the angular momentum still needed.
    const aT = accel / (1 - T / tau);
    const omegaT = tg.vt / tg.r;
    const CT = (EARTH_MU / (tg.r * tg.r) - omegaT * omegaT * tg.r) / aT;
    const fr = A + C;
    const frT = A + B * T + CT;
    const frDot = (frT - fr) / T;
    const fth = 1 - (fr * fr) / 2;
    const fthDot = -fr * frDot;
    const fthDdot = -(frDot * frDot) / 2;
    const dh = tg.r * tg.vt - r * vt;
    const rbar = (r + tg.r) / 2;
    let dv = dh / rbar + ve * T * (fthDot + fthDdot * tau) + (fthDdot * ve * T * T) / 2;
    dv /= fth + fthDot * tau + fthDdot * tau * tau;
    const Tn = tau * (1 - Math.exp(-dv / ve));
    if (!Number.isFinite(A) || !Number.isFinite(B) || !Number.isFinite(Tn)) break;
    s.A = A;
    s.B = B;
    s.T = Math.min(Math.max(Tn, 0), 0.995 * tau);
    s.valid = true;
  }
  return clampFr(s.A + C);
}

function clampFr(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x > 0.95 ? 0.95 : x < -0.6 ? -0.6 : x;
}
