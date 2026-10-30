import { EARTH_J2, EARTH_J2_RADIUS, EARTH_MU, EARTH_OMEGA, EARTH_RADIUS } from '../../sim/types';

/** Engines-off coast path from one state, written into reusable storage (no allocation per prediction). */
export interface CoastPrediction {
  /** ECEF points (x, y, z interleaved), starting at the vehicle; the first `n` are valid. */
  readonly points: Float64Array;
  n: number;
  /** Where the path meets the ground (also its last point), or null if it stays up for the whole horizon. */
  impact: [number, number, number] | null;
  readonly impactPoint: [number, number, number];
}

export function createCoastPrediction(maxPoints: number): CoastPrediction {
  return { points: new Float64Array(Math.max(2, maxPoints) * 3), n: 0, impact: null, impactPoint: [0, 0, 0] };
}

/**
 * Integration steps grow from FIRST_STEP by STEP_GROWTH per step up to MAX_STEP, so a short low arc (a booster
 * just off the ground) gets many points while an orbit settles at the longest step. A step that crosses the
 * ground is redone in quarters down to IMPACT_STEP before the crossing is interpolated.
 */
const FIRST_STEP = 0.25;
const STEP_GROWTH = 1.12;
const MAX_STEP = 15;
const IMPACT_STEP = 0.5;

function gravity(x: number, y: number, z: number, out: Float64Array): void {
  const r2 = x * x + y * y + z * z;
  const r = Math.sqrt(r2);
  const mu_r3 = EARTH_MU / (r2 * r);
  const k = 1.5 * EARTH_J2 * (EARTH_J2_RADIUS * EARTH_J2_RADIUS) / r2;
  const zr2 = (z * z) / r2;
  out[0] = -mu_r3 * x * (1 + k * (1 - 5 * zr2));
  out[1] = -mu_r3 * y * (1 + k * (1 - 5 * zr2));
  out[2] = -mu_r3 * z * (1 + k * (3 - 5 * zr2));
}

// Integrator scratch (the predictor runs a few times a second on the main thread).
const s = new Float64Array(6);
const prev = new Float64Array(6);
const k1 = new Float64Array(6);
const k2 = new Float64Array(6);
const k3 = new Float64Array(6);
const k4 = new Float64Array(6);
const tmp = new Float64Array(6);
const acc = new Float64Array(3);

function deriv(st: Float64Array, out: Float64Array): void {
  gravity(st[0], st[1], st[2], acc);
  out[0] = st[3];
  out[1] = st[4];
  out[2] = st[5];
  out[3] = acc[0];
  out[4] = acc[1];
  out[5] = acc[2];
}

function stage(k: Float64Array, h: number): Float64Array {
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + k[i] * h;
  return tmp;
}

function rk4(h: number): void {
  deriv(s, k1);
  deriv(stage(k1, h / 2), k2);
  deriv(stage(k2, h / 2), k3);
  deriv(stage(k3, h), k4);
  for (let i = 0; i < 6; i++) s[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
}

/**
 * Engines-off coast from an ECEF state, ignoring drag: RK4 with J2 in the inertial frame that coincides with
 * ECEF at the start, each point rotated back into ECEF by the Earth's turn at its own time. Fills `out` with up
 * to its capacity of points covering at most `maxSeconds`, and the impact point if the path reaches the ground.
 */
export function predictCoast(pos: ArrayLike<number>, vel: ArrayLike<number>, maxSeconds: number, out: CoastPrediction): CoastPrediction {
  const w = EARTH_OMEGA;
  const pts = out.points;
  const cap = Math.floor(pts.length / 3);
  s[0] = pos[0];
  s[1] = pos[1];
  s[2] = pos[2];
  s[3] = vel[0] - w * pos[1];
  s[4] = vel[1] + w * pos[0];
  s[5] = vel[2];
  pts[0] = pos[0];
  pts[1] = pos[1];
  pts[2] = pos[2];
  let n = 1;
  out.impact = null;

  let tau = 0;
  let h = FIRST_STEP;
  let refining = false;
  while (n < cap && tau < maxSeconds - 1e-9) {
    h = Math.min(h, maxSeconds - tau);
    prev.set(s);
    rk4(h);
    const r = Math.hypot(s[0], s[1], s[2]);
    if (r <= EARTH_RADIUS) {
      if (h > IMPACT_STEP) {
        // Redo the step in smaller pieces so the crossing is found on a nearly straight chord.
        s.set(prev);
        h /= 4;
        refining = true;
        continue;
      }
      const pr = Math.hypot(prev[0], prev[1], prev[2]);
      const f = Math.min(1, Math.max(0, (pr - EARTH_RADIUS) / Math.max(1e-6, pr - r)));
      const ix = prev[0] + (s[0] - prev[0]) * f;
      const iy = prev[1] + (s[1] - prev[1]) * f;
      const iz = prev[2] + (s[2] - prev[2]) * f;
      const a = -w * (tau + f * h);
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const imp = out.impactPoint;
      imp[0] = ix * c - iy * sn;
      imp[1] = ix * sn + iy * c;
      imp[2] = iz;
      pts[n * 3] = imp[0];
      pts[n * 3 + 1] = imp[1];
      pts[n * 3 + 2] = imp[2];
      n++;
      out.impact = imp;
      break;
    }
    tau += h;
    // Back to ECEF: rotate by −ωτ about Z.
    const c = Math.cos(-w * tau);
    const sn = Math.sin(-w * tau);
    pts[n * 3] = s[0] * c - s[1] * sn;
    pts[n * 3 + 1] = s[0] * sn + s[1] * c;
    pts[n * 3 + 2] = s[2];
    n++;
    if (!refining) h = Math.min(MAX_STEP, h * STEP_GROWTH);
  }
  out.n = n;
  return out;
}
