/**
 * Calibrates per-flight simulator parameters so the nominal as-flown run of every flight reproduces
 * its catalog milestones, then writes lib/sim/data/calibration.json.
 *
 *   npx tsx scripts/calibrate.ts            calibrate all flights and print the table
 *   npx tsx scripts/calibrate.ts 5 10       calibrate only these flights (others keep their values)
 *   npx tsx scripts/calibrate.ts --report   print the table for the current calibration only
 *
 * Plans that went elsewhere than the flight did (PLAN_LANDING) also get the cut-off of their plan fitted,
 * stored under `plans` and used by runs with asFlown = false.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { FLIGHTS, getFlight, type Flight, type FlightTargets } from '../lib/flights/catalog';
import calibrationData from '../lib/sim/data/calibration.json';
import { latLonAltToEcef, surfaceDistance } from '../lib/sim/geo';
import { defaultParams, type CalibrationFile, type FlightParamOverrides, type FlightParams } from '../lib/sim/params';
import { simulateWithOptions, type SimOptions } from '../lib/sim/simulate';
import type { EventKey, FlightResult, Scenario } from '../lib/sim/types';
import { vehicleSpec } from '../lib/sim/vehicles';

const OUT = new URL('../lib/sim/data/calibration.json', import.meta.url);
const NOMINAL: Scenario = { asFlown: true, interventions: [] };
const PLAN: Scenario = { asFlown: false, interventions: [] };
/**
 * Planned splashdown time (s) of plans whose ship was to fly further than any flight did: Flights 1 and 2
 * were to cross the Indian Ocean and the Pacific to a splashdown off Kauai about 90 minutes after launch.
 */
const PLAN_LANDING: Record<number, number> = { 2: 5400 };
const calibration = calibrationData as unknown as CalibrationFile;
/** Reference flight of each generation (calibrated first; seeds the others). */
const REFERENCE: Record<string, number> = { b1: 5, b2: 10, v3: 13 };

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

type TimeKey = Exclude<keyof FlightTargets, 'boosterTopSpeedKmh' | 'boosterApogeeKm' | 'shipTopSpeedKmh' | 'shipApogeeKm'>;

const TIME_EVENTS: Record<TimeKey, EventKey | 'separation'> = {
  maxQ: 'maxq',
  meco: 'meco',
  staging: 'separation',
  boostbackStart: 'boostback',
  boostbackEnd: 'boostback-end',
  boosterApogee: 'booster-apogee',
  boosterLandingBurn: 'booster-landing-burn',
  boosterEnd: 'booster-end',
  seco: 'seco',
  shipApogee: 'ship-apogee',
  payloadStart: 'payload-start',
  payloadEnd: 'payload-end',
  relight: 'relight',
  orbitInsertion: 'orbit-insertion',
  deorbit: 'deorbit',
  entry: 'entry',
  shipLandingBurn: 'ship-landing-burn',
  shipEnd: 'ship-end',
};

/** Tolerances from the brief: seconds for times, fraction for apogees and speeds. */
const TOL: Record<keyof FlightTargets, number> = {
  maxQ: 5,
  meco: 3,
  staging: 3,
  boostbackStart: 6,
  boostbackEnd: 6,
  boosterApogee: 6,
  boosterLandingBurn: 3,
  boosterEnd: 6,
  seco: 3,
  shipApogee: 30,
  payloadStart: 30,
  payloadEnd: 30,
  relight: 30,
  orbitInsertion: 30,
  deorbit: 30,
  entry: 30,
  shipLandingBurn: 30,
  shipEnd: 30,
  boosterTopSpeedKmh: 0.015,
  boosterApogeeKm: 0.03,
  shipTopSpeedKmh: 0.015,
  shipApogeeKm: 0.03,
};

export interface Metrics {
  values: Partial<Record<keyof FlightTargets, number>>;
  stagingAltKm: number | null;
  stagingVz: number | null;
  shipLandingKm: number | null;
  boosterLandingKm: number | null;
  boosterEndKind: string;
  shipEndKind: string;
  /** LOX left just after SECO, as a fraction of the ship's full load. */
  shipPropAtSeco: number | null;
}

export function eventTime(r: FlightResult, key: EventKey | 'separation'): number | undefined {
  if (key === 'separation') return r.separationT ?? undefined;
  return r.events.find((e) => e.key === key)?.t;
}

export function metrics(f: Flight, r: FlightResult): Metrics {
  const values: Metrics['values'] = {};
  for (const k of Object.keys(TIME_EVENTS) as TimeKey[]) {
    const t = eventTime(r, TIME_EVENTS[k]);
    if (t !== undefined) values[k] = t;
  }
  values.boosterTopSpeedKmh = r.records.boosterTopSpeed * 3.6;
  values.boosterApogeeKm = r.records.boosterApogee / 1000;
  values.shipTopSpeedKmh = r.records.shipTopSpeed * 3.6;
  values.shipApogeeKm = r.records.shipApogee / 1000;
  const sep = r.separationT;
  let stagingAltKm: number | null = null;
  let stagingVz: number | null = null;
  if (sep !== null) {
    const tr = r.booster;
    let i = 0;
    while (i < tr.n - 1 && tr.t[i] < sep) i++;
    stagingAltKm = tr.alt[i] / 1000;
    stagingVz = tr.vspeed[i];
  }
  const end = (track: FlightResult['ship']) => [track.pos[3 * (track.n - 1)], track.pos[3 * (track.n - 1) + 1], track.pos[3 * (track.n - 1) + 2]];
  const zone = Float64Array.from(latLonAltToEcef(f.plan.ship.landing.lat, f.plan.ship.landing.lon, 0));
  const shipLandingKm = r.ship.endKind === 'splashdown' ? surfaceDistance(Float64Array.from(end(r.ship)), zone) / 1000 : null;
  let shipPropAtSeco: number | null = null;
  const seco = eventTime(r, 'seco');
  if (seco !== undefined) {
    const tr = r.ship;
    let i = 0;
    while (i < tr.n - 1 && tr.t[i] < seco + 0.5) i++;
    shipPropAtSeco = tr.lox[i];
  }
  return {
    values,
    stagingAltKm,
    stagingVz,
    shipLandingKm,
    boosterLandingKm: null,
    boosterEndKind: r.booster.endKind,
    shipEndKind: r.ship.endKind,
    shipPropAtSeco,
  };
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

function fmt(k: keyof FlightTargets, v: number | undefined): string {
  if (v === undefined) return '—';
  if (k.endsWith('Kmh')) return v.toFixed(0);
  if (k.endsWith('Km')) return v.toFixed(1);
  return v.toFixed(1);
}

/** Targets outside tolerance (plus 'boosterEndKind' / 'shipEndKind' when the end kind differs). */
export function missedTargets(f: Flight, r: FlightResult): string[] {
  const m = metrics(f, r);
  const out: string[] = [];
  for (const k of Object.keys(f.targets) as Array<keyof FlightTargets>) {
    const target = f.targets[k];
    if (target === undefined) continue;
    const got = m.values[k];
    const isFrac = k.endsWith('Kmh') || k.endsWith('Km');
    const err = got === undefined ? Infinity : isFrac ? (got - target) / target : got - target;
    if (!(Math.abs(err) <= TOL[k])) out.push(k);
  }
  if (m.boosterEndKind !== f.boosterEnd) out.push('boosterEndKind');
  if (m.shipEndKind !== f.shipEnd) out.push('shipEndKind');
  return out;
}

export function report(f: Flight, r: FlightResult): { lines: string[]; misses: number } {
  const m = metrics(f, r);
  const lines: string[] = [];
  let misses = 0;
  for (const k of Object.keys(f.targets) as Array<keyof FlightTargets>) {
    const target = f.targets[k];
    if (target === undefined) continue;
    const got = m.values[k];
    const tol = TOL[k];
    const isFrac = k.endsWith('Kmh') || k.endsWith('Km');
    const err = got === undefined ? Infinity : isFrac ? (got - target) / target : got - target;
    const ok = Math.abs(err) <= tol;
    if (!ok) misses++;
    const errText = got === undefined ? 'missing' : isFrac ? `${(err * 100).toFixed(2)}%` : `${err >= 0 ? '+' : ''}${err.toFixed(1)}s`;
    lines.push(`  ${k.padEnd(20)} ${String(target).padStart(8)} ${fmt(k, got).padStart(9)}  ${errText.padStart(9)} ${ok ? 'ok' : 'MISS'}`);
  }
  const kinds = `boosterEnd ${m.boosterEndKind} (catalog ${f.boosterEnd}), shipEnd ${m.shipEndKind} (catalog ${f.shipEnd})`;
  if (m.boosterEndKind !== f.boosterEnd || m.shipEndKind !== f.shipEnd) misses++;
  lines.push(`  ${kinds}`);
  if (m.shipLandingKm !== null) lines.push(`  ship splashdown ${m.shipLandingKm.toFixed(0)} km from ${f.plan.ship.landing.name}`);
  if (m.stagingAltKm !== null) lines.push(`  staging altitude ${m.stagingAltKm.toFixed(1)} km`);
  return { lines, misses };
}

export function run(f: Flight, params: FlightParamOverrides, opts: Omit<SimOptions, 'params'> = {}, scenario = NOMINAL): FlightResult {
  return simulateWithOptions(f.n, scenario, { ...opts, params });
}

// ---------------------------------------------------------------------------------------------
// Optimiser: box-constrained Levenberg–Marquardt with forward-difference Jacobians.
// ---------------------------------------------------------------------------------------------

type NumKey = { [K in keyof FlightParams]: FlightParams[K] extends number ? K : never }[keyof FlightParams];

interface ParamSpec {
  key: NumKey;
  min: number;
  max: number;
  /** Finite-difference step and natural scale. */
  h: number;
  /** Prior: residual (x - prior) / sigma keeps under-determined parameters near sensible values. */
  sigma?: number;
}

type ResidualFn = (r: FlightResult, m: Metrics, params: FlightParamOverrides) => number[];

const MISSING = 25;

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / d;
      for (let k2 = c; k2 <= n; k2++) M[r][k2] -= k * M[c][k2];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

function optimise(
  f: Flight,
  base: FlightParamOverrides,
  specs: ParamSpec[],
  residuals: ResidualFn,
  opts: Omit<SimOptions, 'params'>,
  maxIter = 12,
  scenario = NOMINAL,
): FlightParamOverrides {
  const prior = specs.map((s) => clampTo(s, numberOf(base, s.key, f)));
  const evalAt = (x: number[]): number[] => {
    const params: FlightParamOverrides = { ...base };
    specs.forEach((s, j) => ((params as Record<string, number>)[s.key] = x[j]));
    const r = run(f, params, opts, scenario);
    const res = residuals(r, metrics(f, r), params).map((v) => (Number.isFinite(v) ? v : MISSING));
    specs.forEach((s, j) => {
      if (s.sigma) res.push((x[j] - prior[j]) / s.sigma);
    });
    return res;
  };
  const cost = (r: number[]) => r.reduce((a, v) => a + v * v, 0);
  let x = prior.slice();
  let r0 = evalAt(x);
  let c0 = cost(r0);
  let lambda = 1e-2;
  for (let it = 0; it < maxIter && c0 > 1e-4; it++) {
    const J = specs.map((s, j) => {
      const xp = x.slice();
      const h = xp[j] + s.h > s.max ? -s.h : s.h;
      xp[j] += h;
      const rp = evalAt(xp);
      return rp.map((v, i) => (v - r0[i]) / h);
    });
    const n = specs.length;
    const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J[a].reduce((acc, v, i) => acc + v * J[b][i], 0)));
    const Jtr = Array.from({ length: n }, (_, a) => J[a].reduce((acc, v, i) => acc + v * r0[i], 0));
    let improved = false;
    for (let tries = 0; tries < 5; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => v + (a === b ? lambda * (v + 1e-6) : 0)));
      const d = solve(A, Jtr.map((v) => -v));
      // Trust region: at most 15% of each parameter's range per step.
      const xn = x.map((v, j) => {
        const lim = 0.15 * (specs[j].max - specs[j].min);
        return clampTo(specs[j], v + Math.max(-lim, Math.min(lim, d[j])));
      });
      const rn = evalAt(xn);
      const cn = cost(rn);
      if (cn < c0) {
        x = xn;
        r0 = rn;
        c0 = cn;
        lambda = Math.max(1e-6, lambda / 3);
        improved = true;
        break;
      }
      lambda *= 5;
    }
    if (!improved) {
      // Pattern search: the objective has kinks (engine switching, event thresholds) that can stall LM.
      for (const mult of [2, 6, 0.5]) {
        for (let j = 0; j < specs.length && !improved; j++) {
          for (const sg of [1, -1]) {
            const xn = x.slice();
            xn[j] = clampTo(specs[j], xn[j] + sg * mult * specs[j].h);
            const rn = evalAt(xn);
            const cn = cost(rn);
            if (cn < c0) {
              x = xn;
              r0 = rn;
              c0 = cn;
              improved = true;
              break;
            }
          }
        }
        if (improved) break;
      }
    }
    if (process.env.CALDBG) console.log(`  it ${it} cost ${c0.toFixed(3)} ${improved ? '' : '(stuck)'}`, x.map((v) => +v.toFixed(4)).join(' '));
    if (!improved) break;
  }
  const out: FlightParamOverrides = { ...base };
  specs.forEach((s, j) => ((out as Record<string, number>)[s.key] = round(x[j])));
  return out;
}

function clampTo(s: ParamSpec, v: number): number {
  return Math.min(s.max, Math.max(s.min, v));
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

function numberOf(p: FlightParamOverrides, k: NumKey, f: Flight): number {
  const v = p[k];
  return typeof v === 'number' ? v : (defaultParams(f)[k] as number);
}

/** Normalised time residual (target tolerance = 1). */
function rt(got: number | undefined, target: number | undefined, tol: number): number[] {
  if (target === undefined) return [];
  if (got === undefined) return [MISSING];
  return [(got - target) / tol];
}

/** Normalised relative residual. */
function rf(got: number | undefined, target: number | undefined, tol: number): number[] {
  if (target === undefined) return [];
  if (got === undefined) return [MISSING];
  return [(got - target) / (target * tol)];
}

export { optimise, rt, rf, type ParamSpec, type ResidualFn };

// ---------------------------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------------------------

const STAGING_ALT_KM = 68; // typical staging altitude seen on the webcasts (soft target)

function stageStack(f: Flight, p: FlightParamOverrides): FlightParamOverrides {
  const tg = f.targets;
  const v3 = f.generation === 'v3';
  const specs: ParamSpec[] = [
    { key: 'boosterThrottle', min: 0.7, max: 1, h: 0.02 },
    { key: 'stackGLimit', min: 1.5, max: 3.5, h: 0.05 },
    { key: 'stageReserve', min: 0.08, max: 0.22, h: 0.005, sigma: 0.05 },
    { key: 'boosterProp', min: v3 ? 3_300_000 : 3_000_000, max: v3 ? 3_750_000 : 3_500_000, h: 20_000, sigma: 250_000 },
    { key: 'gammaEnd', min: 10, max: 65, h: 1 },
    { key: 'turnShape', min: 0.4, max: 2.5, h: 0.05 },
    { key: 'bucketDepth', min: 0, max: 0.4, h: 0.02, sigma: 0.2 },
    { key: 'boosterDry', min: v3 ? 220_000 : 200_000, max: v3 ? 290_000 : 260_000, h: 4000, sigma: 25_000 },
  ];
  // The booster's coast after staging should reach the observed apogee with a near-horizontal boostback:
  // apogee ≈ staging altitude + vz²/2g at staging + vz/g.
  const g = 9.6;
  const res: ResidualFn = (_r, m) => {
    const out = [
      ...rt(m.values.staging, tg.staging, 0.7),
      ...rf(m.values.boosterTopSpeedKmh, tg.boosterTopSpeedKmh, 0.004),
      ...rt(m.values.maxQ, tg.maxQ, 2),
    ];
    if (m.stagingAltKm === null || m.stagingVz === null) return [...out, MISSING];
    const vz = Math.max(0, m.stagingVz);
    let soft = 0;
    if (tg.boosterApogeeKm !== undefined) {
      out.push((m.stagingAltKm + (vz * vz) / (2 * g) / 1000 - tg.boosterApogeeKm) / 4);
      soft++;
    }
    if (tg.boosterApogee !== undefined && tg.staging !== undefined) {
      out.push((tg.staging + vz / g - tg.boosterApogee) / 6);
      soft++;
    }
    if (soft === 0) out.push((m.stagingAltKm - STAGING_ALT_KM) / 5);
    return out;
  };
  return optimise(f, p, specs, res, { skipBooster: true, skipShip: true }, 14);
}

function stageBooster(f: Flight, p: FlightParamOverrides): FlightParamOverrides {
  const tg = f.targets;
  const specs: ParamSpec[] = [
    { key: 'bbPitch', min: -20, max: 35, h: 1 },
    { key: 'flipRate', min: 10, max: 20, h: 0.5, sigma: 4 },
    { key: 'descentDrag', min: 0.8, max: 3.2, h: 0.05, sigma: 0.8 },
    { key: 'bbThrottle', min: 0.4, max: 1, h: 0.02 },
    { key: 'lbSwitch', min: 15, max: 160, h: 3, sigma: 60 },
    { key: 'lbFinalAccel', min: 0.8, max: 15, h: 0.25, sigma: 6 },
  ];
  const res: ResidualFn = (r, m) => [
    ...rt(m.values.boostbackEnd, tg.boostbackEnd, 1.5),
    ...rt(m.values.boosterApogee, tg.boosterApogee, 3),
    ...rf(m.values.boosterApogeeKm, tg.boosterApogeeKm, 0.01),
    ...rt(m.values.boosterLandingBurn, tg.boosterLandingBurn, 1),
    ...rt(m.values.boosterEnd, tg.boosterEnd, 2),
    r.booster.endKind === f.boosterEnd ? 0 : 8,
  ];
  return optimise(f, p, specs, res, { skipShip: true }, 14);
}

// ---------------------------------------------------------------------------------------------
// Two-body orbit from the observed milestones
// ---------------------------------------------------------------------------------------------

const MU = 3.986004418e14;
const RE = 6_371_000;

/** Time since periapsis (s) at true anomaly nu (rad, 0..2π) on an ellipse (a, e). */
function timeSincePeri(a: number, e: number, nu: number): number {
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  const Ep = E < 0 ? E + 2 * Math.PI : E;
  return (Ep - e * Math.sin(Ep)) / Math.sqrt(MU / (a * a * a));
}

/**
 * Cut-off state (radius, flight-path angle, inertial speed) of the two-body orbit that peaks at the
 * observed apogee altitude and time and crosses 120 km descending at the observed entry time.
 */
export function cutoffFromTargets(tSeco: number, apoKm: number, tApo: number, tEntry: number): { alt: number; gamma: number; speed: number } | null {
  const ra = RE + apoKm * 1000;
  const rEntry = RE + 120_000;
  // Time from apogee down to 120 km for eccentricity e (a follows from the apogee radius).
  const descent = (e: number) => {
    const a = ra / (1 + e);
    const cosNu = (a * (1 - e * e) / rEntry - 1) / e;
    if (cosNu < -1 || cosNu > 1) return Infinity;
    const nu = 2 * Math.PI - Math.acos(cosNu); // descending leg
    return timeSincePeri(a, e, nu) - timeSincePeri(a, e, Math.PI);
  };
  let lo = 1e-4, hi = 0.2;
  const want = tEntry - tApo;
  if (!(descent(lo) > want) || !(descent(hi) < want)) return null;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (descent(mid) > want) lo = mid;
    else hi = mid;
  }
  const e = (lo + hi) / 2;
  const a = ra / (1 + e);
  // True anomaly at cut-off: apogee is (tApo - tSeco) seconds later.
  const n = Math.sqrt(MU / (a * a * a));
  const M = Math.PI - n * (tApo - tSeco);
  let E = M;
  for (let k = 0; k < 50; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const r = a * (1 - e * Math.cos(E));
  const gamma = Math.atan2(e * Math.sin(nu), 1 + e * Math.cos(nu));
  const speed = Math.sqrt(MU * (2 / r - 1 / a));
  return { alt: r - RE, gamma: (gamma * 180) / Math.PI, speed };
}

/** Cut-off state for an orbit with a given perigee altitude that peaks at the observed apogee and time. */
export function cutoffFromApogee(tSeco: number, apoKm: number, tApo: number, periKm: number): { alt: number; gamma: number; speed: number } {
  const ra = RE + apoKm * 1000;
  const rp = RE + periKm * 1000;
  const a = (ra + rp) / 2;
  const e = (ra - rp) / (ra + rp);
  const n = Math.sqrt(MU / (a * a * a));
  const M = Math.PI - n * (tApo - tSeco);
  let E = M;
  for (let k = 0; k < 50; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const r = a * (1 - e * Math.cos(E));
  return { alt: r - RE, gamma: (Math.atan2(e * Math.sin(nu), 1 + e * Math.cos(nu)) * 180) / Math.PI, speed: Math.sqrt(MU * (2 / r - 1 / a)) };
}

/** Signed miss of the ship's end point from a zone (km): along its final ground track, and to its left. */
function landingMiss(r: FlightResult, zone: Float64Array): [number, number] {
  const tr = r.ship;
  const i = tr.n - 1;
  let j = i;
  while (j > 0 && tr.t[j] > tr.t[i] - 400) j--;
  const e = [tr.pos[3 * i], tr.pos[3 * i + 1], tr.pos[3 * i + 2]];
  const b = [tr.pos[3 * j], tr.pos[3 * j + 1], tr.pos[3 * j + 2]];
  const rl = Math.hypot(e[0], e[1], e[2]);
  const up = e.map((x) => x / rl);
  let h = e.map((x, k) => x - b[k]);
  const hu = h[0] * up[0] + h[1] * up[1] + h[2] * up[2];
  h = h.map((x, k) => x - hu * up[k]);
  const hl = Math.hypot(h[0], h[1], h[2]) || 1;
  h = h.map((x) => x / hl);
  const left = [up[1] * h[2] - up[2] * h[1], up[2] * h[0] - up[0] * h[2], up[0] * h[1] - up[1] * h[0]];
  const d = [zone[0] - e[0], zone[1] - e[1], zone[2] - e[2]];
  return [(d[0] * h[0] + d[1] * h[1] + d[2] * h[2]) / 1000, (d[0] * left[0] + d[1] * left[1] + d[2] * left[2]) / 1000];
}

function stageShip(f: Flight, p: FlightParamOverrides): FlightParamOverrides {
  const tg = f.targets;
  const cap = vehicleSpec('ship', f.generation).propMass;
  const orbital = f.plan.ship.mission === 'orbital';
  // Cut-off state straight from the observed orbit (two-body); the optimiser only adds the small
  // corrections for J2 and the real burn. These near-circular orbits are very sensitive (a few m/s
  // move apogee and entry by a minute), hence the fine steps and tight bounds around the seed.
  const seed =
    tg.seco !== undefined && tg.shipApogee !== undefined
      ? orbital
        ? cutoffFromApogee(tg.seco, tg.shipApogeeKm, tg.shipApogee, 0)
        : tg.entry !== undefined
          ? cutoffFromTargets(tg.seco, tg.shipApogeeKm, tg.shipApogee, tg.entry)
          : null
      : null;
  if (seed && p.cutSpeed === undefined) p = { ...p, cutAlt: seed.alt, cutGamma: seed.gamma, cutSpeed: seed.speed };
  const reachesSeco = tg.seco !== undefined;
  if (!reachesSeco) {
    // Lost before SECO: keep the planned cut-off of the generation's reference flight, so the plan
    // (asFlown = false) still reaches its orbit; only the burn profile is fitted to the loss point.
    const rt0 = getFlight(REFERENCE[f.generation]).targets;
    const planned = cutoffFromTargets(rt0.seco ?? 0, rt0.shipApogeeKm, rt0.shipApogee ?? 0, rt0.entry ?? 0);
    if (planned) p = { ...p, cutGamma: planned.gamma, cutSpeed: planned.speed, cutAlt: p.cutAlt ?? planned.alt };
  }
  const c0 = seed ?? { speed: numberOf(p, 'cutSpeed', f), gamma: numberOf(p, 'cutGamma', f) };
  const specs: ParamSpec[] = reachesSeco
    ? [
        { key: 'shipGLimit', min: 1.2, max: 4.5, h: 0.05 },
        { key: 'shipProp', min: cap * 0.8, max: cap * 1.04, h: 5_000, sigma: cap * 0.15 },
        { key: 'cutSpeed', min: c0.speed - 20, max: c0.speed + 20, h: 0.25, sigma: 15 },
        { key: 'cutGamma', min: c0.gamma - 0.3, max: c0.gamma + 0.3, h: 0.004, sigma: 0.2 },
      ]
    : [
        { key: 'shipGLimit', min: 1.2, max: 4.5, h: 0.05 },
        { key: 'cutAlt', min: 130_000, max: 180_000, h: 1_000, sigma: 30_000 },
      ];
  if (orbital) {
    specs.push({ key: 'insertionPerigee', min: 120_000, max: 270_000, h: 2_000, sigma: 60_000 });
    specs.push({ key: 'deorbitPerigee', min: -60_000, max: 110_000, h: 2_000, sigma: 50_000 });
  }
  // A ship that reaches SECO should keep only its landing reserve plus a small margin. Gauges read
  // fractions of the full load, which is what the run loaded (see runStack).
  const reserve = numberOf(p, 'shipReserve', f) + 15_000;
  const load = (q: FlightParamOverrides) => Math.min(numberOf(q, 'shipProp', f), cap * 1.05);
  const res: ResidualFn = (_r, m, q) => [
    ...(reachesSeco && m.shipPropAtSeco !== null ? [(m.shipPropAtSeco * load(q) - reserve) / 6_000] : []),
    ...rt(m.values.seco, tg.seco, 0.7),
    ...rf(m.values.shipTopSpeedKmh, tg.shipTopSpeedKmh, 0.004),
    ...rf(m.values.shipApogeeKm, tg.shipApogeeKm, 0.006),
    ...rt(m.values.shipApogee, tg.shipApogee, 10),
    ...rt(m.values.entry, tg.entry, 8),
  ];
  let out = optimise(f, p, specs, res, { skipBooster: true }, 14);
  if (reachesSeco) {
    // The load is set by what the ascent needs: trim the excess left at SECO directly, then refit.
    const m = metrics(f, run(f, out, { skipBooster: true }));
    if (m.shipPropAtSeco !== null) {
      const excess = m.shipPropAtSeco * load(out) - reserve;
      const prop = Math.min(cap * 1.04, Math.max(cap * 0.8, numberOf(out, 'shipProp', f) - 0.9 * excess));
      out = optimise(f, { ...out, shipProp: prop }, specs, res, { skipBooster: true }, 10);
    }
  }
  return out;
}

/** Launch azimuth (cross-range), entry trim, aim offset and flip timing for the ship's landing. */
function stageLanding(f: Flight, p: FlightParamOverrides): FlightParamOverrides {
  const tg = f.targets;
  if (f.shipEnd !== 'splashdown' && tg.shipLandingBurn === undefined) return p;
  const zone = Float64Array.from(latLonAltToEcef(f.plan.ship.landing.lat, f.plan.ship.landing.lon, 0));
  const specs: ParamSpec[] = [
    { key: 'azimuth', min: 92, max: 106, h: 0.05, sigma: 4 },
    { key: 'entryAoA', min: 52, max: 75, h: 0.5, sigma: 8 },
    { key: 'entryAim', min: -400_000, max: 400_000, h: 5_000, sigma: 300_000 },
    { key: 'flipMargin', min: 0.7, max: 1.15, h: 0.02, sigma: 0.3 },
  ];
  const res: ResidualFn = (r, m) => {
    const [along, cross] = landingMiss(r, zone);
    return [
      ...rt(m.values.shipLandingBurn, tg.shipLandingBurn, 4),
      ...rt(m.values.shipEnd, tg.shipEnd, 4),
      ...rt(m.values.entry, tg.entry, 10),
      along / 30,
      cross / 30,
      r.ship.endKind === f.shipEnd ? 0 : 6,
    ];
  };
  return optimise(f, p, specs, res, { skipBooster: true }, 12);
}

/** Flight 1: the stack never staged; fit its climb to max-Q, top speed and apogee. */
function stageNoStaging(f: Flight, start: FlightParamOverrides): FlightParamOverrides {
  const tg = f.targets;
  // A slow, steep climb: the real stack was short of thrust and lost steering.
  const p = { boosterThrottle: 0.77, stackGLimit: 1.35, gammaEnd: 65, turnShape: 1.5, ...start };
  const specs: ParamSpec[] = [
    { key: 'boosterThrottle', min: 0.6, max: 1, h: 0.01 },
    { key: 'stackGLimit', min: 1.22, max: 2.5, h: 0.02 },
    { key: 'gammaEnd', min: 10, max: 85, h: 1 },
    { key: 'turnShape', min: 0.3, max: 3, h: 0.05 },
    { key: 'tumbleRate', min: 5, max: 60, h: 1, sigma: 20 },
  ];
  const res: ResidualFn = (_r, m) => [
    ...rt(m.values.maxQ, tg.maxQ, 2),
    ...rf(m.values.boosterTopSpeedKmh, tg.boosterTopSpeedKmh, 0.005),
    ...rf(m.values.boosterApogeeKm, tg.boosterApogeeKm, 0.01),
    ...rf(m.values.shipTopSpeedKmh, tg.shipTopSpeedKmh, 0.01),
  ];
  return optimise(f, p, specs, res, {}, 16);
}

/**
 * The plan's cut-off speed for a ship that was to fly further than the flight did (see PLAN_LANDING): the
 * plan run should splash down at the plan's landing zone at the planned time. `flight` is the flight's
 * calibration; returns the plan's overrides.
 */
function stagePlan(f: Flight, flight: FlightParamOverrides, plan: FlightParamOverrides): FlightParamOverrides {
  const tLand = PLAN_LANDING[f.n];
  const zone = Float64Array.from(latLonAltToEcef(f.plan.ship.landing.lat, f.plan.ship.landing.lon, 0));
  const base = { ...flight, ...plan };
  const res: ResidualFn = (r) => {
    const [along, cross] = landingMiss(r, zone);
    const end = r.events.find((e) => e.key === 'ship-end')?.t;
    return [along / 30, cross / 30, ...rt(end, tLand, 300), r.ship.endKind === 'splashdown' ? 0 : 6];
  };
  // The splashdown point sweeps around the globe with the cut-off speed: scan for the right pass, then refine.
  const flightSpeed = numberOf(flight, 'cutSpeed', f);
  let c0 = flightSpeed;
  let best = Infinity;
  for (let v = flightSpeed - 20; v <= flightSpeed + 100; v += 4) {
    const r = run(f, { ...base, cutSpeed: v }, { skipBooster: true }, PLAN);
    const cost = res(r, metrics(f, r), base).reduce((a, x) => a + x * x, 0);
    if (cost < best) {
      best = cost;
      c0 = v;
    }
  }
  const specs: ParamSpec[] = [{ key: 'cutSpeed', min: c0 - 6, max: c0 + 6, h: 0.5 }];
  const out = optimise(f, { ...base, cutSpeed: c0 }, specs, res, { skipBooster: true }, 12, PLAN);
  return { ...plan, cutSpeed: out.cutSpeed };
}

export function planReport(f: Flight): string[] {
  const r = run(f, {}, {}, PLAN);
  const zone = Float64Array.from(latLonAltToEcef(f.plan.ship.landing.lat, f.plan.ship.landing.lon, 0));
  const end = r.ship.n - 1;
  const at = Float64Array.from([r.ship.pos[3 * end], r.ship.pos[3 * end + 1], r.ship.pos[3 * end + 2]]);
  const t = r.events.find((e) => e.key === 'ship-end')?.t ?? NaN;
  return [`  plan: ship ${r.ship.endKind} at T+${t.toFixed(0)} (planned ~${PLAN_LANDING[f.n]}), ${(surfaceDistance(at, zone) / 1000).toFixed(0)} km from ${f.plan.ship.landing.name}`];
}

function hasBoosterReturn(f: Flight): boolean {
  const t = f.targets;
  return t.staging !== undefined && f.plan.booster.recovery !== 'expend';
}

function shipLands(f: Flight): boolean {
  return f.shipEnd === 'splashdown';
}

export function calibrateFlight(f: Flight, start: FlightParamOverrides): FlightParamOverrides {
  let p = { ...start };
  if (f.targets.staging === undefined) return stageNoStaging(f, p);
  for (let pass = 0; pass < 3; pass++) {
    p = stageStack(f, p);
    if (hasBoosterReturn(f)) p = stageBooster(f, p);
    p = stageShip(f, p);
    if (shipLands(f)) p = stageLanding(f, p);
  }
  return p;
}

export { stageStack, stageBooster, stageShip, stageLanding };

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isMain && process.argv.includes('--report')) {
  const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  for (const f of FLIGHTS) {
    if (only.length && !only.includes(f.n)) continue;
    const r = run(f, {});
    const { lines, misses } = report(f, r);
    console.log(`Flight ${f.n} (${r.computeMs.toFixed(0)} ms) — ${misses} outside tolerance`);
    console.log(lines.join('\n'));
    if (PLAN_LANDING[f.n] !== undefined) console.log(planReport(f).join('\n'));
  }
}

if (isMain && process.argv.includes('--stage')) {
  const which = process.argv[process.argv.indexOf('--stage') + 1];
  const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  for (const n of only) {
    const f = getFlight(n);
    const base = { ...(calibration.flights[String(n)] ?? {}) };
    const t0 = performance.now();
    const stages: Record<string, (f: Flight, p: FlightParamOverrides) => FlightParamOverrides> = {
      stack: stageStack,
      booster: stageBooster,
      ship: stageShip,
      landing: stageLanding,
    };
    let out = base;
    for (const name of which.split(',')) out = stages[name](f, out);
    console.log(`Flight ${n} stage ${which} ${(performance.now() - t0).toFixed(0)} ms`, JSON.stringify(out));
    const r = run(f, out);
    console.log(report(f, r).lines.join('\n'));
  }
}

/** Parameters that carry over from a generation's reference flight as a starting point. */
const TRANSFERABLE: Array<keyof FlightParams> = [
  'boosterThrottle', 'stackGLimit', 'stageReserve', 'boosterProp', 'gammaEnd', 'turnShape', 'bucketDepth', 'boosterDry',
  'bbPitch', 'flipRate', 'descentDrag', 'bbThrottle', 'lbSwitch', 'lbFinalAccel', 'shipGLimit', 'shipProp', 'azimuth',
  'entryAoA', 'entryAim', 'flipMargin',
];

function pick(p: FlightParamOverrides, keys: Array<keyof FlightParams>): FlightParamOverrides {
  const out: FlightParamOverrides = {};
  for (const k of keys) if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  return out;
}

function writeCalibration(file: CalibrationFile): void {
  const ordered: CalibrationFile = { flights: {} };
  for (const k of Object.keys(file.flights).sort((a, b) => Number(a) - Number(b))) ordered.flights[k] = file.flights[k];
  if (file.plans) {
    ordered.plans = {};
    for (const k of Object.keys(file.plans).sort((a, b) => Number(a) - Number(b))) ordered.plans[k] = file.plans[k];
  }
  writeFileSync(OUT, JSON.stringify(ordered, null, 2) + '\n');
}

if (isMain && !process.argv.includes('--report') && !process.argv.includes('--stage')) {
  const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const file: CalibrationFile = { flights: { ...calibration.flights }, ...(calibration.plans ? { plans: { ...calibration.plans } } : {}) };
  const fresh = process.argv.includes('--fresh');
  let total = 0;
  // Reference flights of each generation first; their values seed the others.
  const order = [5, 4, 6, 3, 2, 1, 10, 11, 9, 8, 7, 13, 12, 14].map((n) => getFlight(n));
  const reference = REFERENCE;
  for (const f of order) {
    if (only.length && !only.includes(f.n)) continue;
    const t0 = performance.now();
    const ref = file.flights[String(reference[f.generation])];
    const seed = ref && reference[f.generation] !== f.n ? pick(ref, TRANSFERABLE) : {};
    // --fresh restarts the other flights from their reference; --fresh-all restarts everything.
    const isRef = reference[f.generation] === f.n;
    const restart = process.argv.includes('--fresh-all') || (fresh && !isRef);
    const start = restart ? seed : { ...seed, ...(file.flights[String(f.n)] ?? {}) };
    file.flights[String(f.n)] = calibrateFlight(f, start);
    writeCalibration(file);
    if (PLAN_LANDING[f.n] !== undefined) {
      file.plans = { ...(file.plans ?? {}), [String(f.n)]: stagePlan(f, file.flights[String(f.n)], file.plans?.[String(f.n)] ?? {}) };
      writeCalibration(file);
    }
    const r = run(f, file.flights[String(f.n)]);
    const { lines, misses } = report(f, r);
    total += misses;
    console.log(`Flight ${f.n}: calibrated in ${((performance.now() - t0) / 1000).toFixed(1)} s, ${misses} outside tolerance`);
    console.log(lines.join('\n'));
  }
  console.log(`Done: ${total} targets outside tolerance.`);
}
