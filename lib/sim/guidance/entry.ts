import { atmosphereInto, type AtmosphereState } from '../atmosphere';
import { inertialToEcef } from '../geo';
import { gravityAccel } from '../physics';
import { EARTH_OMEGA, EARTH_RADIUS } from '../types';
import { machLookup, type AeroConfig } from '../vehicles';
import { DEG } from '../vec';

/** Belly-first angle of attack schedule: hypersonic trim → broadside belly-flop below Mach 1. */
export function entryAoA(aoaHyp: number, mach: number): number {
  const sub = 82;
  if (mach >= 6) return aoaHyp * DEG;
  if (mach <= 1) return sub * DEG;
  return (sub + ((mach - 1) / 5) * (aoaHyp - sub)) * DEG;
}

/** Trimmed lift and drag coefficients (reference-area based) of the body model at angle of attack a. */
export function trimCoefficients(cfg: AeroConfig, a: number, mach: number, out: { cl: number; cd: number }): void {
  const sa = Math.sin(a), ca = Math.cos(a);
  const cN = cfg.cnLinear * sa * Math.abs(ca) + machLookup(cfg.cnCross, mach) * cfg.planformRatio * sa * sa;
  const cA = machLookup(cfg.caNose, mach) * ca * ca;
  out.cd = cN * sa + cA * ca;
  out.cl = cN * ca - cA * sa;
}

const OMEGA = EARTH_OMEGA;
const RE = EARTH_RADIUS;
const gravity = gravityAccel;
const atmInto = atmosphereInto;
const atm: AtmosphereState = { pressure: 0, density: 0, temperature: 0, speedOfSound: 0 };
const co = { cl: 0, cd: 0 };
const s = new Float64Array(6), k1 = new Float64Array(6), mid = new Float64Array(6), k2 = new Float64Array(6);
const g = new Float64Array(3);
const pe = new Float64Array(3);

function entryDeriv(st: Float64Array, out: Float64Array, mass: number, cfg: AeroConfig, aoaHyp: number, cosB: number, sinB: number): number {
  const x = st[0], y = st[1], z = st[2];
  const r = Math.sqrt(x * x + y * y + z * z);
  const alt = r - RE;
  gravity(x, y, z, g, false);
  out[0] = st[3];
  out[1] = st[4];
  out[2] = st[5];
  out[3] = g[0];
  out[4] = g[1];
  out[5] = g[2];
  atmInto(alt, atm);
  const vx = st[3] + OMEGA * y, vy = st[4] - OMEGA * x, vz = st[5];
  const V = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (V < 1 || atm.density < 1e-12) return V / atm.speedOfSound;
  const mach = V / atm.speedOfSound;
  trimCoefficients(cfg, entryAoA(aoaHyp, mach), mach, co);
  const qs = (0.5 * atm.density * V * V * cfg.refArea) / mass;
  const ux = vx / V, uy = vy / V, uz = vz / V;
  // Lift plane basis: "up" perpendicular to the airspeed, and the side vector u × up.
  const rx = x / r, ry = y / r, rz = z / r;
  const d = rx * ux + ry * uy + rz * uz;
  let px = rx - d * ux, py = ry - d * uy, pz = rz - d * uz;
  const pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
  px /= pl;
  py /= pl;
  pz /= pl;
  const sx = uy * pz - uz * py, sy = uz * px - ux * pz, sz = ux * py - uy * px;
  const L = qs * co.cl, D = qs * co.cd;
  out[3] += -D * ux + L * (cosB * px + sinB * sx);
  out[4] += -D * uy + L * (cosB * py + sinB * sy);
  out[5] += -D * uz + L * (cosB * pz + sinB * sz);
  return mach;
}

export interface EntryPrediction {
  /** ECEF end point (m) and time. */
  end: Float64Array;
  t: number;
}

/**
 * Fast entry predictor: integrates the lifting trajectory with a constant bank angle down to a few
 * kilometres (or subsonic speed). Used by the predictor–corrector bank-angle guidance.
 */
export function predictEntry(
  r: ArrayLike<number>,
  v: ArrayLike<number>,
  t0: number,
  mass: number,
  cfg: AeroConfig,
  aoaHyp: number,
  cosBank: number,
  sinSign: number,
  out: EntryPrediction,
): EntryPrediction {
  for (let i = 0; i < 3; i++) {
    s[i] = r[i];
    s[i + 3] = v[i];
  }
  const cb = Math.max(-1, Math.min(1, cosBank));
  const sb = sinSign * Math.sqrt(1 - cb * cb);
  let t = 0;
  for (let n = 0; n < 4000; n++) {
    const alt = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]) - RE;
    if (alt < 3000) break;
    const dt = alt > 100_000 ? 6 : alt > 40_000 ? 3 : 2;
    const mach = entryDeriv(s, k1, mass, cfg, aoaHyp, cb, sb);
    if (mach < 0.7 && alt < 15_000) break;
    for (let i = 0; i < 6; i++) mid[i] = s[i] + 0.5 * dt * k1[i];
    entryDeriv(mid, k2, mass, cfg, aoaHyp, cb, sb);
    for (let i = 0; i < 6; i++) s[i] += dt * k2[i];
    t += dt;
    if (t > 4000) break;
  }
  pe[0] = s[0];
  pe[1] = s[1];
  pe[2] = s[2];
  inertialToEcef(out.end, pe, t0 + t);
  out.t = t0 + t;
  return out;
}
