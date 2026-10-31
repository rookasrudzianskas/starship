import { ANOMALY_PHASE_TARGET, GULF_SPLASHDOWN, PADS, type Anomaly, type AnomalyPhase, type Flight, type PadSite } from '../flights/catalog';
import { atmosphereInto, type AtmosphereState } from './atmosphere';
import { makeEvent, type EventState } from './events';
import { latLonAltToEcef, localEnuBasis } from './geo';
import type { FlightParams } from './params';
import { jetStream } from './physics';
import { emptySample, TrackBuilder, type RawSample } from './recorder';
import type { Body, VehicleRt } from './runtime';
import { createRng, hashString, sortInterventions } from './scenario';
import {
  EARTH_OMEGA,
  EARTH_RADIUS,
  type BoosterRecovery,
  type EndKind,
  type EventKey,
  type FlightEvent,
  type Intervention,
  type PayloadRelease,
  type PhaseCode,
  type Scenario,
  type ShipMission,
  type VehicleId,
} from './types';
import { PAYLOAD_MASS } from './vehicles';
import { cross3, normalize3, qAxis, qMul, qRotZ, v3 } from './vec';

export interface PayloadPlan {
  kind: 'starlink-sim' | 'starlink-v3';
  count: number;
  unitMass: number;
  start: number;
  end: number;
}

export interface Action {
  t: number;
  vehicle: 'stack' | VehicleId;
  iv?: Intervention;
  anomaly?: Anomaly;
}

const NORTH_PACIFIC = { name: 'North Pacific, north of Hawaii', lat: 24.5, lon: -157.5 };
const INDIAN_OCEAN = { name: 'Indian Ocean', lat: -20.5, lon: 110.5 };

/** Everything a run needs that is fixed for its duration. */
export class SimContext {
  readonly flight: Flight;
  readonly scenario: Scenario;
  readonly p: FlightParams;
  readonly pad: PadSite;
  readonly mountEcef: Float64Array; // mount centre at ground level
  readonly padUp = v3();
  readonly padEast = v3();
  readonly padNorth = v3();
  readonly downrange = v3(); // launch azimuth direction at the pad (ECEF)
  /** Normal of the target orbital plane (inertial): through the pad at T+0, heading along the launch azimuth. */
  readonly planeNormal = v3();
  readonly windPeak: number;
  readonly boosterLoad: number;
  readonly recovery: BoosterRecovery;
  readonly mission: ShipMission;
  readonly shipLanding: { lat: number; lon: number };
  readonly payload: PayloadPlan | null;
  /** Interventions and clock-timed anomalies, sorted by time; phase-tied anomalies join when armed. */
  readonly actions: Action[];
  /** As-flown anomalies tied to a phase, waiting for the run to reach it (delay after the phase starts, s). */
  private readonly phased: Array<{ anomaly: Anomaly; delay: number }> = [];
  readonly events: FlightEvent[] = [];
  readonly releases: PayloadRelease[] = [];
  readonly boosterTrack = new TrackBuilder(8192);
  readonly shipTrack = new TrackBuilder(16384);
  readonly asFlown: boolean;
  /** Super Heavy carries the vented hot-staging ring from Flight 2 on (Flight 1 staged cold, or would have). */
  readonly hotStageRing: boolean;
  /** Anomaly flags known from the start of an as-flown run. */
  readonly noSeparation: boolean;
  readonly payloadDoorFail: boolean;
  readonly relightSkip: boolean;
  readonly boosterLandingFail: boolean;
  readonly shipLandingFail: boolean;
  separationT: number | null = null;
  boosterEnd: { kind: EndKind; t: number } | null = null;
  shipEnd: { kind: EndKind; t: number } | null = null;
  shipPitchBias = 0;
  boosterPitchBias = 0;
  boosterSkips = 0;
  shipSkips = 0;
  private rngs = new Map<number, () => number>();

  constructor(flight: Flight, scenario: Scenario, params: FlightParams) {
    this.flight = flight;
    this.scenario = scenario;
    this.p = params;
    this.asFlown = scenario.asFlown;
    this.hotStageRing = flight.date >= '2023-11-18';
    this.pad = PADS[flight.pad];
    this.mountEcef = Float64Array.from(latLonAltToEcef(this.pad.lat, this.pad.lon, this.pad.groundAlt));
    const enu = localEnuBasis(this.pad.lat, this.pad.lon);
    this.padUp.set(enu.up);
    this.padEast.set(enu.east);
    this.padNorth.set(enu.north);
    const az = (params.azimuth * Math.PI) / 180;
    for (let i = 0; i < 3; i++) this.downrange[i] = Math.sin(az) * enu.east[i] + Math.cos(az) * enu.north[i];
    cross3(this.planeNormal, this.padUp, this.downrange);
    normalize3(this.planeNormal, this.planeNormal);
    this.windPeak = Math.max(0, scenario.wind ?? 0);
    this.boosterLoad = Math.min(1, Math.max(0.5, scenario.boosterLoad ?? 1));
    this.recovery = scenario.boosterRecovery ?? flight.plan.booster.recovery;
    this.mission = scenario.shipMission ?? flight.plan.ship.mission;
    const planOrbital = flight.plan.ship.mission === 'orbital';
    if (this.mission === 'orbital') this.shipLanding = planOrbital ? flight.plan.ship.landing : NORTH_PACIFIC;
    else this.shipLanding = planOrbital ? INDIAN_OCEAN : flight.plan.ship.landing;
    this.payload = resolvePayload(flight, scenario);
    const anomalies = scenario.asFlown ? flight.anomalies : [];
    const has = (k: Anomaly['kind'], v?: Anomaly['vehicle']) => anomalies.some((a) => a.kind === k && (!v || a.vehicle === v));
    this.noSeparation = has('no-separation');
    this.payloadDoorFail = has('payload-door-fail');
    this.relightSkip = has('relight-skip') || has('roll', 'ship');
    this.boosterLandingFail = has('landing-burn-fail', 'booster');
    this.shipLandingFail = has('landing-burn-fail', 'ship');
    const acts: Action[] = [];
    for (const iv of sortInterventions(scenario.interventions)) {
      if (!Number.isFinite(iv.t)) continue;
      acts.push({ t: Math.max(-10, iv.t), vehicle: iv.kind === 'stage-now' ? 'stack' : iv.vehicle, iv });
    }
    for (const a of anomalies) {
      if (a.phase) {
        const start = flight.targets[ANOMALY_PHASE_TARGET[a.phase]];
        this.phased.push({ anomaly: a, delay: start === undefined ? 0 : Math.max(0, a.t - start) });
      } else acts.push({ t: a.t, vehicle: a.vehicle, anomaly: a });
    }
    this.actions = acts.map((a, i) => ({ a, i })).sort((x, y) => x.a.t - y.a.t || x.i - y.i).map((x) => x.a);
  }

  /**
   * The run reached `phase` at time t: its anomalies join the action list, timed from now. They are inserted
   * after every action at or before their time, so a runner's read position stays valid.
   */
  armPhase(phase: AnomalyPhase, t: number): void {
    for (let k = 0; k < this.phased.length; k++) {
      const x = this.phased[k];
      if (x.anomaly.phase !== phase) continue;
      this.phased.splice(k--, 1);
      const at = t + x.delay;
      let i = this.actions.length;
      while (i > 0 && this.actions[i - 1].t > at) i--;
      this.actions.splice(i, 0, { t: at, vehicle: x.anomaly.vehicle, anomaly: x.anomaly });
    }
  }

  /** Deterministic generator for one anomaly (stable when other parts of the scenario change). */
  rng(slot: number): () => number {
    let r = this.rngs.get(slot);
    if (!r) {
      r = createRng(hashString(`${this.flight.n}:${this.asFlown ? 1 : 0}:${slot}`));
      this.rngs.set(slot, r);
    }
    return r;
  }

  /** Recovery target for the booster: catch point above the mount, or the Gulf splashdown point. */
  boosterTarget(recovery: BoosterRecovery, out: Float64Array): Float64Array {
    if (recovery === 'catch') {
      out.set(this.mountEcef);
      return out;
    }
    out.set(latLonAltToEcef(GULF_SPLASHDOWN.lat, GULF_SPLASHDOWN.lon, 0));
    return out;
  }

  addEvent(key: Exclude<EventKey, 'booster-end' | 'ship-end' | 'intervention'>, vehicle: 'stack' | VehicleId, t: number, s: EventState, note?: string): void {
    this.events.push(makeEvent(key, vehicle, t, s, note));
  }
}

function resolvePayload(flight: Flight, scenario: Scenario): PayloadPlan | null {
  const plan = flight.plan.ship;
  const count = Math.max(0, Math.min(60, Math.round(scenario.payloadCount ?? plan.payloadCount)));
  if (count === 0) return null;
  const kind = plan.payloadKind === 'none' ? 'starlink-v3' : plan.payloadKind;
  let start = flight.targets.payloadStart ?? 1020;
  let end = flight.targets.payloadEnd ?? start + 50 * Math.max(1, count - 1) + 60;
  if (end <= start + 30) end = start + 30;
  if (flight.targets.payloadStart === undefined) start = 1020;
  return { kind, count, unitMass: PAYLOAD_MASS[kind], start, end };
}

// ---------------------------------------------------------------------------
// Sampling: converts a body (or one vehicle inside the stack) to a Track sample.
// ---------------------------------------------------------------------------

const OMEGA = EARTH_OMEGA;
const RE = EARTH_RADIUS;
const atmInto = atmosphereInto;
const axis = qAxis;
const windAt = jetStream;
const atm: AtmosphereState = { pressure: 0, density: 0, temperature: 0, speedOfSound: 0 };
const yAx = v3(), rI = v3(), vI = v3(), rE = v3(), vE = v3(), aE = v3(), up = v3(), vAir = v3(), hd = v3(), tmp = v3();
const qz = new Float64Array(4), qe = new Float64Array(4);

/** Same arithmetic order as inertialToEcef, reusing one rotation across a sample's vectors. */
function toEcef(out: Float64Array, a: Float64Array, c: number, s: number): void {
  const x = c * a[0] + s * a[1];
  const y = -s * a[0] + c * a[1];
  out[0] = x;
  out[1] = y;
  out[2] = a[2];
}

export interface SampleExtras {
  phase: PhaseCode;
  heating: number;
  aero: ArrayLike<number>;
  /** Freeze the acceleration readout (on the pad / held in the arms). */
  still?: boolean;
}

/** ECEF position/velocity of a point `offset` metres along the body +Y axis from the body's CoM. */
export function bodyPointEcef(body: Body, offset: number, t: number, outR: Float64Array, outV: Float64Array): void {
  const th = OMEGA * t;
  bodyPointEcefWithRotation(body, offset, Math.cos(th), Math.sin(th), outR, outV);
}

/** Also leaves the body's inertial +Y axis in yAx for recordSample. */
function bodyPointEcefWithRotation(body: Body, offset: number, c: number, s: number, outR: Float64Array, outV: Float64Array): void {
  axis(yAx, body.q, 1);
  for (let i = 0; i < 3; i++) rI[i] = body.r[i] + yAx[i] * offset;
  // v = v_cm + w × (y * offset)
  const ox = yAx[0] * offset, oy = yAx[1] * offset, oz = yAx[2] * offset;
  const w = body.w;
  vI[0] = body.v[0] + (w[1] * oz - w[2] * oy);
  vI[1] = body.v[1] + (w[2] * ox - w[0] * oz);
  vI[2] = body.v[2] + (w[0] * oy - w[1] * ox);
  // ECEF velocity = R(v_i − ω × r_i)
  vI[0] += OMEGA * rI[1];
  vI[1] -= OMEGA * rI[0];
  toEcef(outR, rI, c, s);
  toEcef(outV, vI, c, s);
}

const evR = v3(), evV = v3();
export function eventState(body: Body, offset: number, t: number): EventState {
  bodyPointEcef(body, offset, t, evR, evV);
  return {
    speed: Math.sqrt(evV[0] * evV[0] + evV[1] * evV[1] + evV[2] * evV[2]),
    alt: Math.sqrt(evR[0] * evR[0] + evR[1] * evR[1] + evR[2] * evR[2]) - RE,
    pos: [evR[0], evR[1], evR[2]],
  };
}

export function recordSample(
  ctx: SimContext,
  tb: TrackBuilder,
  s: RawSample,
  t: number,
  body: Body,
  part: VehicleRt,
  offset: number,
  ex: SampleExtras,
): void {
  const th = OMEGA * t;
  const cos = Math.cos(th), sin = Math.sin(th);
  bodyPointEcefWithRotation(body, offset, cos, sin, rE, vE);
  qRotZ(qz, -OMEGA * t);
  qMul(qe, qz, body.q);
  const r = Math.sqrt(rE[0] * rE[0] + rE[1] * rE[1] + rE[2] * rE[2]);
  const alt = r - RE;
  up[0] = rE[0] / r;
  up[1] = rE[1] / r;
  up[2] = rE[2] / r;
  const speed = Math.sqrt(vE[0] * vE[0] + vE[1] * vE[1] + vE[2] * vE[2]);
  const vs = vE[0] * up[0] + vE[1] * up[1] + vE[2] * up[2];
  // d|v|/dt in the rotating frame: a_e = R a_i − 2ω×v_e − ω×(ω×r_e)
  let accel = 0;
  if (!ex.still) {
    toEcef(aE, body.acc, cos, sin);
    aE[0] += 2 * OMEGA * vE[1] + OMEGA * OMEGA * rE[0];
    aE[1] += -2 * OMEGA * vE[0] + OMEGA * OMEGA * rE[1];
    accel = speed > 0.5 ? (aE[0] * vE[0] + aE[1] * vE[1] + aE[2] * vE[2]) / speed : Math.sqrt(aE[0] * aE[0] + aE[1] * aE[1] + aE[2] * aE[2]);
  }
  atmInto(alt, atm);
  // Air-relative velocity (ECEF): Earth-relative velocity minus the eastward jet stream.
  const wind = windAt(alt, ctx.windPeak);
  const hxy = Math.sqrt(rE[0] * rE[0] + rE[1] * rE[1]) || 1;
  vAir[0] = vE[0] + (wind * rE[1]) / hxy;
  vAir[1] = vE[1] - (wind * rE[0]) / hxy;
  vAir[2] = vE[2];
  const va = Math.sqrt(vAir[0] * vAir[0] + vAir[1] * vAir[1] + vAir[2] * vAir[2]);
  toEcef(tmp, yAx, cos, sin);
  let aoa = 0;
  if (va > 0.5) {
    const c = (tmp[0] * vAir[0] + tmp[1] * vAir[1] + tmp[2] * vAir[2]) / va;
    aoa = (Math.acos(c > 1 ? 1 : c < -1 ? -1 : c) * 180) / Math.PI;
  }
  // Pitch in the vertical plane of the trajectory (ECEF).
  hd[0] = vE[0] - vs * up[0];
  hd[1] = vE[1] - vs * up[1];
  hd[2] = vE[2] - vs * up[2];
  let hl = Math.sqrt(hd[0] * hd[0] + hd[1] * hd[1] + hd[2] * hd[2]);
  if (hl < 1) {
    const d = ctx.downrange;
    const k = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
    hd[0] = d[0] - k * up[0];
    hd[1] = d[1] - k * up[1];
    hd[2] = d[2] - k * up[2];
    hl = Math.sqrt(hd[0] * hd[0] + hd[1] * hd[1] + hd[2] * hd[2]) || 1;
  }
  const yu = tmp[0] * up[0] + tmp[1] * up[1] + tmp[2] * up[2];
  const yh = (tmp[0] * hd[0] + tmp[1] * hd[1] + tmp[2] * hd[2]) / hl;
  let pitch = (Math.atan2(yu, yh) * 180) / Math.PI;
  if (pitch <= -180) pitch += 360;

  s.t = t;
  s.px = rE[0]; s.py = rE[1]; s.pz = rE[2];
  s.vx = vE[0]; s.vy = vE[1]; s.vz = vE[2];
  s.qx = qe[0]; s.qy = qe[1]; s.qz = qe[2]; s.qw = qe[3];
  s.com = part.com();
  s.alt = alt;
  s.speed = speed;
  s.vspeed = vs;
  s.accel = accel;
  s.mach = va / atm.speedOfSound;
  s.q = 0.5 * atm.density * va * va;
  s.pitch = pitch;
  s.aoa = aoa;
  s.throttle = part.meanThrottle();
  s.lox = part.lox / part.loxFull;
  s.ch4 = part.ch4 / part.ch4Full;
  s.heating = ex.heating;
  s.a0 = ex.aero[0]; s.a1 = ex.aero[1]; s.a2 = ex.aero[2]; s.a3 = ex.aero[3];
  s.phase = ex.phase;
  tb.push(s);
}

export const scratchSample = emptySample();


export function landingTargetEcef(lat: number, lon: number): Float64Array {
  return Float64Array.from(latLonAltToEcef(lat, lon, 0));
}
