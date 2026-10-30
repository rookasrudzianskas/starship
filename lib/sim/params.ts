import { getFlight, type Flight } from '../flights/catalog';
import calibrationData from './data/calibration.json';
import type { Scenario } from './types';

/**
 * Per-flight tunables. Defaults come from the vehicle generation and the flight's observed milestones;
 * scripts/calibrate.ts tunes them so the nominal as-flown run reproduces the catalog targets and writes
 * the results to data/calibration.json.
 */
export interface FlightParams {
  // Masses (kg)
  boosterDry: number;
  /** Booster propellant actually loaded, kg (a scenario's boosterLoad scales it). */
  boosterProp: number;
  shipDry: number;
  shipProp: number;
  /** Propellant (kg) the ship keeps for its landing; the ascent burn never dips into it. */
  shipReserve: number;

  // Stack ascent
  azimuth: number; // deg, launch azimuth
  tPitch: number; // s, end of the vertical rise
  gammaEnd: number; // deg, scheduled flight-path angle once the stack reaches 1.5 km/s
  turnShape: number; // exponent of the flight-path angle schedule against speed (< 1 turns early)
  bucketT: number; // s, centre of the max-Q throttle bucket
  bucketDepth: number; // throttle reduction at the bucket centre
  bucketWidth: number; // s, half width of the bucket
  boosterThrottle: number; // ascent throttle cap
  stackGLimit: number; // g, acceleration limit (throttle)
  stageReserve: number; // booster propellant fraction (of its load) left at MECO
  hsLead: number; // s, 30-engine shutdown -> physical separation
  hsCentreThrottle: number; // centre-engine throttle through hot staging and the flip
  mecoCentre: boolean; // MECO callout = centre-engine shutdown after separation (Flights 10+)
  centreCut: number; // s after separation when the centre engines stop (mecoCentre)

  // Booster return
  flipRate: number; // deg/s
  bbDelay: number; // s after separation to boostback ignition
  bbPitch: number; // deg, boostback thrust elevation above the horizon
  bbThrottle: number;
  bbAim: number; // m, along-track aim offset (+ = further uprange)
  descentDrag: number; // multiplier on the engines-first axial drag (grid fins, skirt, vented ring)
  lbSwitch: number; // m/s, descent speed where the first landing set hands over
  lbFinalAccel: number; // m/s^2, net deceleration planned for the last engine set
  lbThrottle: number; // planning throttle for the first landing set
  lbTargetH: number; // m, height of the base above the water where a splashdown hover ends

  // Ship
  shipGLimit: number; // g
  cutAlt: number; // m, SECO altitude target
  cutGamma: number; // deg, SECO flight-path angle target
  cutSpeed: number; // m/s, SECO inertial speed target
  rvacDelay: number; // s after separation
  entryAoA: number; // deg, hypersonic angle of attack
  entryAim: number; // m, along-track aim offset for the entry guidance
  flipMargin: number; // multiplier on the predicted flip/burn height
  relightThrottle: number;
  insertionPerigee: number; // m
  deorbitPerigee: number; // m
  tumbleRate: number; // deg/s, angular rate reached when attitude control is lost
}

type Partial2<T> = { [K in keyof T]?: T[K] };

export interface CalibrationFile {
  /** Fitted so the as-flown run reproduces each flight's milestones. */
  flights: Record<string, Partial2<FlightParams>>;
  /** Changes for a run of the plan (asFlown = false) where the plan went elsewhere than the flight did. */
  plans?: Record<string, Partial2<FlightParams>>;
}

const calibration = calibrationData as unknown as CalibrationFile;

export function defaultParams(f: Flight): FlightParams {
  const g = f.generation;
  const tg = f.targets;
  const centre = tg.meco !== undefined && tg.staging !== undefined && tg.meco > tg.staging;
  const hsLead = !centre && tg.meco !== undefined && tg.staging !== undefined ? tg.staging - tg.meco : 3.6;
  return {
    boosterDry: g === 'v3' ? 250_000 : 230_000,
    boosterProp: g === 'v3' ? 3_650_000 : 3_400_000,
    shipDry: g === 'v3' ? 120_000 : g === 'b2' ? 115_000 : 110_000,
    shipProp: g === 'v3' ? 1_600_000 : g === 'b2' ? 1_500_000 : 1_200_000,
    shipReserve: 30_000,
    azimuth: 97,
    tPitch: 9,
    gammaEnd: 35,
    turnShape: 0.8,
    bucketT: tg.maxQ ?? 60,
    bucketDepth: 0.15,
    bucketWidth: 16,
    boosterThrottle: 1,
    stackGLimit: 3.2,
    stageReserve: 0.12,
    hsLead,
    hsCentreThrottle: 0.5,
    mecoCentre: centre,
    centreCut: centre && tg.meco !== undefined && tg.staging !== undefined ? tg.meco - tg.staging : 0,
    flipRate: 14,
    bbDelay: tg.boostbackStart !== undefined && tg.staging !== undefined ? tg.boostbackStart - tg.staging : 5,
    bbPitch: 10,
    bbThrottle: 0.7,
    bbAim: 0,
    descentDrag: 1.3,
    lbSwitch: 60,
    lbFinalAccel: 5,
    lbThrottle: 0.75,
    lbTargetH: 4,
    shipGLimit: 3,
    cutAlt: 160_000,
    cutGamma: 0.6,
    cutSpeed: 7_800,
    rvacDelay: 1.5,
    entryAoA: 65,
    entryAim: 0,
    flipMargin: 1,
    relightThrottle: 0.4,
    insertionPerigee: 190_000,
    deorbitPerigee: 20_000,
    tumbleRate: 25,
  };
}

/**
 * Flights whose as-flown fit is shaped by their failures throughout, so it says little about the plan
 * (Flight 1 climbed on throttled-down engines and kept losing them): a run of the plan takes the
 * parameters of the flight named here, the same vehicle generation flying the same plan.
 */
export const PLAN_PARAMS_FROM: Record<number, number> = { 1: 2 };

/** The flight that went to orbit: a flight sent there by the director flies its orbit and deorbit. */
const ORBITAL_FLIGHT = 14;

/**
 * Defaults merged with the calibrated values for this flight (and any explicit overrides). A run of the
 * plan (`asFlown` false) also takes the plan's own adjustments (see CalibrationFile.plans).
 */
export function flightParams(f: Flight, overrides?: Partial2<FlightParams>, scenario: Pick<Scenario, 'asFlown' | 'shipMission'> = { asFlown: true }): FlightParams {
  const src = scenario.asFlown ? f : getFlight(PLAN_PARAMS_FROM[f.n] ?? f.n);
  const key = String(src.n);
  const plan = scenario.asFlown ? undefined : calibration.plans?.[key];
  const orbit: Partial2<FlightParams> = {};
  if (scenario.shipMission === 'orbital' && f.plan.ship.mission !== 'orbital') {
    const o = calibration.flights[String(ORBITAL_FLIGHT)] ?? {};
    if (o.insertionPerigee !== undefined) orbit.insertionPerigee = o.insertionPerigee;
    if (o.deorbitPerigee !== undefined) orbit.deorbitPerigee = o.deorbitPerigee;
  }
  return { ...defaultParams(src), ...(calibration.flights[key] ?? {}), ...(plan ?? {}), ...orbit, ...(overrides ?? {}) };
}

export type FlightParamOverrides = Partial2<FlightParams>;
