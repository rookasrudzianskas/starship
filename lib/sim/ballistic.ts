import { atmosphereInto, type AtmosphereState } from './atmosphere';
import { inertialToEcef } from './geo';
import { gravityAccel, jetStream } from './physics';
import { EARTH_OMEGA, EARTH_RADIUS } from './types';
import { machLookup, type MachTable } from './vehicles';
import { readVec3, type Vec3Like } from './vec';

export interface BallisticOptions {
  /** Ballistic coefficient m/(Cd·A), kg/m². Omit (or 0) for a drag-free coast. */
  ballisticCoeff?: number;
  /** Include J2 (default true). */
  j2?: boolean;
  /** Maximum number of output points (default 300). */
  maxPoints?: number;
  /** Altitude of the impact surface, m (default 0). */
  groundAlt?: number;
}

export interface BallisticResult {
  /** ECEF xyz triples (m), first point = the start state. */
  points: Float64Array;
  impact: [number, number, number] | null;
  impactT: number | null;
}

const OMEGA = EARTH_OMEGA;
const RE = EARTH_RADIUS;
const gravity = gravityAccel;
const atmInto = atmosphereInto;
const mach = machLookup;
const toEcef = inertialToEcef;
const atm: AtmosphereState = { pressure: 0, density: 0, temperature: 0, speedOfSound: 0 };
const g = new Float64Array(3);
const st = new Float64Array(6);
const k1 = new Float64Array(6), k2 = new Float64Array(6), k3 = new Float64Array(6), k4 = new Float64Array(6);
const tmp = new Float64Array(6);
const e = new Float64Array(3);

/** Optional Mach-dependent drag: coefficient table (scaled by `scale`) times reference area over mass. */
export interface DragTable {
  table: MachTable;
  scale: number;
  areaOverMass: number;
  /** Peak of the jet stream the drag sees (see jetStream), m/s; 0 or omitted for still air. */
  windPeak?: number;
}

let dragTable: DragTable | null = null;

function deriv(s: Float64Array, out: Float64Array, beta: number, j2: boolean): void {
  gravity(s[0], s[1], s[2], g, j2);
  out[0] = s[3];
  out[1] = s[4];
  out[2] = s[5];
  out[3] = g[0];
  out[4] = g[1];
  out[5] = g[2];
  if (beta > 0) {
    const alt = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]) - RE;
    if (alt < 150_000) {
      const rho = atmInto(alt, atm).density;
      // Air co-rotates with the Earth, less the eastward jet stream (as airVelocity in physics.ts).
      let ax = s[3] + EARTH_OMEGA * s[1], ay = s[4] - EARTH_OMEGA * s[0];
      const az = s[5];
      const w = dragTable?.windPeak ? jetStream(alt, dragTable.windPeak) : 0;
      const h = w !== 0 ? Math.sqrt(s[0] * s[0] + s[1] * s[1]) : 0;
      if (h > 1) {
        ax += (w * s[1]) / h;
        ay -= (w * s[0]) / h;
      }
      const V = Math.sqrt(ax * ax + ay * ay + az * az);
      const k = dragTable
        ? -0.5 * rho * V * mach(dragTable.table, V / atm.speedOfSound) * dragTable.scale * dragTable.areaOverMass
        : (-0.5 * rho * V) / beta;
      out[3] += k * ax;
      out[4] += k * ay;
      out[5] += k * az;
    }
  }
}

function rk4Step(dt: number, beta: number, j2: boolean): void {
  deriv(st, k1, beta, j2);
  for (let i = 0; i < 6; i++) tmp[i] = st[i] + 0.5 * dt * k1[i];
  deriv(tmp, k2, beta, j2);
  for (let i = 0; i < 6; i++) tmp[i] = st[i] + 0.5 * dt * k2[i];
  deriv(tmp, k3, beta, j2);
  for (let i = 0; i < 6; i++) tmp[i] = st[i] + dt * k3[i];
  deriv(tmp, k4, beta, j2);
  for (let i = 0; i < 6; i++) st[i] += (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
}

export interface FlightOut {
  /** ECEF impact point (at the impact time) and the time of impact (absolute, same clock as t0). */
  impact: Float64Array;
  /** Earth-relative (ECEF) velocity at the impact point, m/s. */
  impactVel: Float64Array;
  impactT: number;
  hit: boolean;
  /** Highest altitude reached, m. */
  apoAlt: number;
}

/**
 * Unpowered flight from an inertial state at time t0 until the surface (or maxT seconds).
 * `onPoint` receives ECEF positions at roughly `outDt` spacing.
 */
export function flyBallistic(
  r: ArrayLike<number>,
  v: ArrayLike<number>,
  t0: number,
  maxT: number,
  beta: number,
  groundAlt: number,
  j2: boolean,
  out: FlightOut,
  outDt = 0,
  onPoint?: (x: number, y: number, z: number) => void,
  drag: DragTable | null = null,
): FlightOut {
  dragTable = drag;
  st[0] = r[0]; st[1] = r[1]; st[2] = r[2];
  st[3] = v[0]; st[4] = v[1]; st[5] = v[2];
  let t = 0;
  let nextOut = 0;
  let prevAlt = Math.sqrt(st[0] * st[0] + st[1] * st[1] + st[2] * st[2]) - RE;
  let apo = prevAlt;
  out.hit = false;
  const emit = () => {
    if (!onPoint) return;
    e[0] = st[0]; e[1] = st[1]; e[2] = st[2];
    toEcef(e, e, t0 + t);
    onPoint(e[0], e[1], e[2]);
  };
  emit();
  nextOut = outDt;
  let px = 0, py = 0, pz = 0;
  while (t < maxT) {
    const rr = Math.sqrt(st[0] * st[0] + st[1] * st[1] + st[2] * st[2]);
    const alt = rr - RE;
    const vr = (st[0] * st[3] + st[1] * st[4] + st[2] * st[5]) / rr;
    const inAir = beta > 0 && alt < 120_000;
    const dtMax = inAir ? (alt < 30_000 ? 1 : 2) : alt > 200_000 ? 20 : 5;
    let dt = vr < 0 ? Math.min(dtMax, Math.max(0.05, (0.4 * (alt - groundAlt)) / -vr)) : dtMax;
    if (t + dt > maxT) dt = maxT - t;
    px = st[0]; py = st[1]; pz = st[2];
    rk4Step(dt, beta, j2);
    t += dt;
    const a2 = Math.sqrt(st[0] * st[0] + st[1] * st[1] + st[2] * st[2]) - RE;
    if (a2 > apo) apo = a2;
    if (a2 <= groundAlt) {
      // Interpolate the crossing inside the last step.
      const f = (prevAlt - groundAlt) / Math.max(1e-9, prevAlt - a2);
      const tx = px + f * (st[0] - px), ty = py + f * (st[1] - py), tz = pz + f * (st[2] - pz);
      const ti = t - dt + f * dt;
      e[0] = tx; e[1] = ty; e[2] = tz;
      toEcef(out.impact, e, t0 + ti);
      out.impactT = t0 + ti;
      e[0] = st[3] + OMEGA * ty;
      e[1] = st[4] - OMEGA * tx;
      e[2] = st[5];
      toEcef(out.impactVel, e, t0 + ti);
      out.hit = true;
      if (onPoint) onPoint(out.impact[0], out.impact[1], out.impact[2]);
      out.apoAlt = apo;
      return out;
    }
    prevAlt = a2;
    if (onPoint && t >= nextOut) {
      emit();
      nextOut += outDt;
    }
  }
  e[0] = st[0]; e[1] = st[1]; e[2] = st[2];
  toEcef(out.impact, e, t0 + t);
  out.impactT = t0 + t;
  out.apoAlt = apo;
  return out;
}

const vr0 = new Float64Array(3), vv0 = new Float64Array(3);

/**
 * Engines-off coast prediction from an ECEF state (gravity + J2 + Earth rotation, optional drag),
 * for the "coast and impact point" display. Returns up to `maxPoints` ECEF points.
 */
export function propagateBallistic(pos: Vec3Like, vel: Vec3Like, maxSeconds: number, opts: BallisticOptions = {}): BallisticResult {
  readVec3(pos, vr0);
  readVec3(vel, vv0);
  // ECEF -> inertial at t = 0: same position, velocity plus ω × r.
  vv0[0] -= EARTH_OMEGA * vr0[1];
  vv0[1] += EARTH_OMEGA * vr0[0];
  const maxPoints = Math.max(2, opts.maxPoints ?? 300);
  const span = Math.max(1, maxSeconds);
  const buf = new Float64Array(3 * (maxPoints + 2));
  let n = 0;
  const res: FlightOut = { impact: new Float64Array(3), impactVel: new Float64Array(3), impactT: 0, hit: false, apoAlt: 0 };
  flyBallistic(vr0, vv0, 0, span, opts.ballisticCoeff ?? 0, opts.groundAlt ?? 0, opts.j2 ?? true, res, span / (maxPoints - 1), (x, y, z) => {
    if (n >= maxPoints + 2) return;
    buf[3 * n] = x;
    buf[3 * n + 1] = y;
    buf[3 * n + 2] = z;
    n++;
  });
  return {
    points: buf.slice(0, 3 * n),
    impact: res.hit ? [res.impact[0], res.impact[1], res.impact[2]] : null,
    impactT: res.hit ? res.impactT : null,
  };
}
