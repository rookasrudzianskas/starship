import { EARTH_J2, EARTH_J2_RADIUS, EARTH_MU, EARTH_OMEGA, EARTH_RADIUS } from './types';
import { machLookup as machLookupFn, type AeroConfig } from './vehicles';
import type { V3 } from './vec';

// Module-local copies: imported bindings can compile to getter calls under some loaders.
const MU = EARTH_MU;
const J2K = 1.5 * EARTH_J2 * EARTH_J2_RADIUS * EARTH_J2_RADIUS;
const OMEGA = EARTH_OMEGA;
const RE = EARTH_RADIUS;
const machLookup = machLookupFn;

/** Point-mass gravity plus the J2 oblateness term (inertial or ECEF: J2 is symmetric about +Z). */
export function gravityAccel(x: number, y: number, z: number, out: V3, j2 = true): V3 {
  const r2 = x * x + y * y + z * z;
  const r = Math.sqrt(r2);
  const k = -MU / (r2 * r);
  if (!j2) {
    out[0] = k * x;
    out[1] = k * y;
    out[2] = k * z;
    return out;
  }
  const f = J2K / r2;
  const zr = (z * z) / r2;
  out[0] = k * x * (1 + f * (1 - 5 * zr));
  out[1] = k * y * (1 + f * (1 - 5 * zr));
  out[2] = k * z * (1 + f * (3 - 5 * zr));
  return out;
}

const ga = new Float64Array(3);

/**
 * One RK4 step of r'' = g(r) + aNg in an inertial frame, in place. The non-gravitational acceleration
 * is held constant across the step (steps are ≤ 0.02 s whenever it is non-zero).
 */
export function rk4(r: V3, v: V3, aNg: V3 | null, dt: number, j2 = true): void {
  const ax = aNg ? aNg[0] : 0, ay = aNg ? aNg[1] : 0, az = aNg ? aNg[2] : 0;
  const h2 = dt / 2;
  // Keep the RK stages in local scalars so V8 can retain them in registers. The arithmetic order
  // is unchanged; repeatedly loading/storing shared typed-array scratch added cost at every step.
  const rx = r[0], ry = r[1], rz = r[2];
  const vx = v[0], vy = v[1], vz = v[2];
  gravityAccel(rx, ry, rz, ga, j2);
  const k1vx = ga[0] + ax, k1vy = ga[1] + ay, k1vz = ga[2] + az;

  gravityAccel(rx + h2 * vx, ry + h2 * vy, rz + h2 * vz, ga, j2);
  const k2vx = ga[0] + ax, k2vy = ga[1] + ay, k2vz = ga[2] + az;
  const k2rx = vx + h2 * k1vx, k2ry = vy + h2 * k1vy, k2rz = vz + h2 * k1vz;

  gravityAccel(rx + h2 * k2rx, ry + h2 * k2ry, rz + h2 * k2rz, ga, j2);
  const k3vx = ga[0] + ax, k3vy = ga[1] + ay, k3vz = ga[2] + az;
  const k3rx = vx + h2 * k2vx, k3ry = vy + h2 * k2vy, k3rz = vz + h2 * k2vz;

  gravityAccel(rx + dt * k3rx, ry + dt * k3ry, rz + dt * k3rz, ga, j2);
  const k4vx = ga[0] + ax, k4vy = ga[1] + ay, k4vz = ga[2] + az;
  const k4rx = vx + dt * k3vx, k4ry = vy + dt * k3vy, k4rz = vz + dt * k3vz;

  const s = dt / 6;
  r[0] = rx + s * (vx + 2 * k2rx + 2 * k3rx + k4rx);
  r[1] = ry + s * (vy + 2 * k2ry + 2 * k3ry + k4ry);
  r[2] = rz + s * (vz + 2 * k2rz + 2 * k3rz + k4rz);
  v[0] = vx + s * (k1vx + 2 * k2vx + 2 * k3vx + k4vx);
  v[1] = vy + s * (k1vy + 2 * k2vy + 2 * k3vy + k4vy);
  v[2] = vz + s * (k1vz + 2 * k2vz + 2 * k3vz + k4vz);
}

/** Jet-stream profile: westerly wind peaking at 11.5 km, fading by ~20 km. Returns m/s toward the east. */
export function jetStream(alt: number, peak: number): number {
  if (peak === 0 || alt > 30_000) return 0;
  const d = alt - 11_500;
  const s = d < 0 ? 6_000 : 4_500;
  return peak * Math.exp(-(d * d) / (s * s));
}

/** Air-relative velocity in the inertial frame: v − ω×r − wind (the atmosphere co-rotates with Earth). */
export function airVelocity(out: V3, r: V3, v: V3, alt: number, windPeak: number): V3 {
  out[0] = v[0] + OMEGA * r[1];
  out[1] = v[1] - OMEGA * r[0];
  out[2] = v[2];
  const w = jetStream(alt, windPeak);
  if (w !== 0) {
    const h = Math.sqrt(r[0] * r[0] + r[1] * r[1]);
    if (h > 1) {
      out[0] -= (w * -r[1]) / h;
      out[1] -= (w * r[0]) / h;
    }
  }
  return out;
}

export function altitudeOf(r: V3): number {
  return Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]) - RE;
}

export interface AeroResult {
  q: number; // dynamic pressure, Pa
  mach: number;
  aoa: number; // total angle of attack, rad
  airspeed: number;
}

/**
 * Body aerodynamics of a cylinder at any angle of attack, from its actual attitude:
 * an axial force along ∓Y (nose-first or tail-first coefficients) and a normal force opposing the
 * crossflow (slender-body term + Newtonian/crossflow-drag term that dominates belly-first flight).
 */
export function aeroForce(
  out: V3,
  res: AeroResult,
  yAxis: V3,
  vAir: V3,
  rho: number,
  soundSpeed: number,
  cfg: AeroConfig,
): V3 {
  const V = Math.sqrt(vAir[0] * vAir[0] + vAir[1] * vAir[1] + vAir[2] * vAir[2]);
  res.airspeed = V;
  if (V < 0.05 || rho <= 0) {
    out[0] = out[1] = out[2] = 0;
    res.q = 0;
    res.mach = 0;
    res.aoa = 0;
    return out;
  }
  const ux = vAir[0] / V, uy = vAir[1] / V, uz = vAir[2] / V;
  let ca = yAxis[0] * ux + yAxis[1] * uy + yAxis[2] * uz;
  ca = ca > 1 ? 1 : ca < -1 ? -1 : ca;
  const q = 0.5 * rho * V * V;
  const mach = V / soundSpeed;
  res.q = q;
  res.mach = mach;
  res.aoa = Math.acos(ca);
  const qs = q * cfg.refArea;
  // Axial
  const cA = (ca >= 0 ? machLookup(cfg.caNose, mach) : -machLookup(cfg.caTail, mach)) * ca * ca;
  out[0] = -qs * cA * yAxis[0];
  out[1] = -qs * cA * yAxis[1];
  out[2] = -qs * cA * yAxis[2];
  // Normal: crossflow direction n = (u - (u·y) y) / sin(alpha)
  let nx = ux - ca * yAxis[0], ny = uy - ca * yAxis[1], nz = uz - ca * yAxis[2];
  const sa = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (sa > 1e-9) {
    nx /= sa;
    ny /= sa;
    nz /= sa;
    const cN = cfg.cnLinear * sa * Math.abs(ca) + machLookup(cfg.cnCross, mach) * cfg.planformRatio * sa * sa;
    out[0] -= qs * cN * nx;
    out[1] -= qs * cN * ny;
    out[2] -= qs * cN * nz;
  }
  return out;
}

/** Sutton–Graves style stagnation heating, normalised so a typical Starship entry peaks near 1. */
export const HEATING_NORM = 4.0e9;
export function heatingIndex(rho: number, airspeed: number): number {
  const h = (Math.sqrt(rho) * airspeed * airspeed * airspeed) / HEATING_NORM;
  return h > 1 ? 1 : h;
}
