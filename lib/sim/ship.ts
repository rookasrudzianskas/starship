import { spin as spinFn } from './attitude';
import { airDensity as airDensityFn } from './atmosphere';
import { shipRollReference, steerFlight as slewFn } from './guidance/roll';
import { bodyPointEcef, eventState, landingTargetEcef, recordSample as recordSampleFn, scratchSample, type Action, type SampleExtras, type SimContext } from './context';
import { engineName, MIN_THROTTLE as MIN_THROTTLE_VALUE, pickFailingEngines } from './engines';
import { makeEndEvent, makeEngineOutEvent, makeInterventionEvent } from './events';
import { flapNormalPressures as flapNormalPressuresFn } from './flap-aero';
import { radialUp as radialUpFn, inertialToEcef } from './geo';
import { entryAoA, predictEntry, type EntryPrediction } from './guidance/entry';
import { landingThrust, landingTiltCap } from './guidance/landing';
import { newFlaps, commandFlaps as commandFlapsFn, advanceFlaps as advanceFlapsFn, flapFeedback, type FlapPhase } from './guidance/flaps';
import { newPeg, pegStep } from './guidance/peg';
import { planeHeading } from './guidance/plane';
import { isLand } from './land';
import { lossKind } from './outcome';
import { SPOOL_DOWN as SPOOL_DOWN_VALUE, type Body, type VehicleRt } from './runtime';
import { coastBody, newAirData, stepBody as stepBodyFn } from './step';
import { newTipState, startTip, tipOver, type TipState } from './surface';
import { EARTH_MU, EARTH_OMEGA, EARTH_RADIUS, G0, Phase as PhaseCodes, type EndKind, type PhaseCode } from './types';
import { clamp, DEG, qAxis as qAxisFn, v3 } from './vec';

const OMEGA = EARTH_OMEGA;
const RE = EARTH_RADIUS;
const MU = EARTH_MU;
const GEE = G0;
const D = DEG;
const Phase = PhaseCodes;
const MIN_THROTTLE = MIN_THROTTLE_VALUE;
const SPOOL_DOWN = SPOOL_DOWN_VALUE;
const slew = slewFn;
const commandFlaps = commandFlapsFn, advanceFlaps = advanceFlapsFn;
const flapNormalPressures = flapNormalPressuresFn;
const airDensity = airDensityFn;
const spin = spinFn;
const stepBody = stepBodyFn;
const recordSample = recordSampleFn;
const radialUp = radialUpFn;
const qAxis = qAxisFn;

/** Planned net deceleration of the ship's landing burn after the flip, m/s². */
const SHIP_LANDING_DECEL = 4;
/** Landing flip: angular rate and acceleration limits, deg/s and deg/s² (a quarter turn in about 3.3 s). */
const FLIP_RATE = 40;
const FLIP_ACCEL = 40;
/**
 * The flip's engines idle at minimum throttle until the ship is within this angle of the vertical, rad: their push,
 * towards the nose while the ship is still flat, would otherwise throw it sideways.
 */
const FLIP_IDLE_TILT = 20 * DEG;
/** Throttle of the landing engines for the rest of the flip. */
const FLIP_THROTTLE = 0.7;
/**
 * Lean the landing burn may use to stop the drift the flip leaves: up to SHIP_LANDING_TILT, closing smoothly to
 * SHIP_LANDING_TILT_FINAL at the water over the last SHIP_LANDING_TILT_SPAN metres (the ship comes down upright).
 */
const SHIP_LANDING_TILT = 25 * DEG;
const SHIP_LANDING_TILT_FINAL = 3 * DEG;
const SHIP_LANDING_TILT_SPAN = 400;
/** Rate at which the landing burn takes out the horizontal drift, 1/s. */
const SHIP_DRIFT_GAIN = 0.4;
/** Satellites only leave the bay above this altitude, coasting, before entry, m. */
const DEPLOY_ALT = 150_000;
/** Closest spacing between two satellite releases when a larger load has to fit a shorter coast, s. */
const DEPLOY_MIN_SPACING = 15;
/** Altitude where entry begins (the entry interface), m. */
const ENTRY_ALT = 120_000;
/**
 * From the entry interface to splashdown on the calibrated Flight 14: the arc flown (rad, inertial) and the time
 * it takes (s). With the coast from the deorbit burn worked out from the orbit, it places the splashdown of orbits
 * a flight was not planned for.
 */
const ENTRY_ARC = 86.9 * DEG;
const ENTRY_SPAN = 1695;
/**
 * Entry dynamic pressure where the bank guidance starts to trade range control for lift, and where it flies full
 * lift up, Pa (nominal entries peak near 9 kPa): a ship short of or beyond its target never dives into thick air.
 */
const ENTRY_Q_SOFT = 12_000;
const ENTRY_Q_HARD = 20_000;
/**
 * Dynamic pressure at which the ship breaks up, Pa: nose first (the attached stack's limit, more than twice any
 * flight's max Q), or belly first and sideways (over three times the peak of a nominal entry, some 8 g).
 */
const Q_BREAKUP_NOSE = 80_000;
const Q_BREAKUP_BELLY = 30_000;
/** Angle of attack below which the ship flies nose first, rad. */
const NOSE_FIRST = 30 * DEG;

type Mode = 'hotstage' | 'ascent' | 'coast' | 'burn' | 'entry' | 'flip' | 'landing' | 'free' | 'splashed' | 'done';
type BurnKind = 'relight' | 'insertion' | 'deorbit';

interface Burn {
  kind: BurnKind;
  t: number;
  duration: number; // s (relight) or a cap (insertion/deorbit)
  done: boolean;
}

/** Starship after separation until splashdown, loss or the end of the simulated window. */
export function runShip(ctx: SimContext, body: Body, part: VehicleRt, tSep: number): void {
  const p = ctx.p;
  const plan = ctx.flight.plan.ship;
  const air = newAirData();
  const tb = ctx.shipTrack;
  const flaps = newFlaps(), aero = flaps.angles;
  const automaticFlaps = flaps.targets.slice();
  const flapPressures = new Float64Array(4), flapAirAngularVelocity = v3();
  const flapOverride: Array<number | null> = [null, null, null, null];
  let flapPhase: FlapPhase = 'stow';
  let flapRoll = 0, flapPitch = 0;
  let lastFlapPhase: FlapPhase | null = null, lastFlapRoll = NaN, lastFlapPitch = NaN;
  const ex: SampleExtras = { phase: Phase.HotStage, heating: 0, aero, still: false };
  const orbital = ctx.mission === 'orbital';
  const tCap = orbital ? 14_400 : 7_200;
  const landing = landingTargetEcef(ctx.shipLanding.lat, ctx.shipLanding.lon);

  let t = tSep;
  let mode: Mode = 'hotstage';
  // Closures change `mode`; read it through a function so control-flow narrowing does not go stale.
  const modeIs = (m: Mode): boolean => mode === m;
  let phase: PhaseCode = Phase.HotStage;
  let ended = false;
  let lastRec = -Infinity;
  let lastPhase = -1;
  let actIdx = 0;
  const acts = ctx.actions;
  while (actIdx < acts.length && acts[actIdx].t < tSep - 1e-9) actIdx++;

  // Ascent
  const peg = newPeg();
  const rT = RE + p.cutAlt;
  const pegTarget = { r: rT, rdot: p.cutSpeed * Math.sin(p.cutGamma * D), vt: p.cutSpeed * Math.cos(p.cutGamma * D) };
  const energyT = (p.cutSpeed * p.cutSpeed) / 2 - MU / rT;
  let frCmd = 0;
  let attAcc = 0;
  let lastPeg = -Infinity;
  let rvacLit = false;
  const rvacT = tSep + p.rvacDelay;
  let secoT = -1;

  // Coast and burns
  const burns: Burn[] = [];
  if (plan.relight && !orbital) burns.push({ kind: 'relight', t: plan.relight.t, duration: plan.relight.duration, done: false });
  // Deorbit: at the planned time on a flight planned for orbit; otherwise chosen once the orbit is reached.
  const deorbitBurn: Burn = { kind: 'deorbit', t: plan.mission === 'orbital' && plan.deorbit ? plan.deorbit.t : Infinity, duration: 120, done: false };
  if (orbital) {
    burns.push({ kind: 'insertion', t: plan.insertion?.t ?? NaN, duration: 120, done: false });
    burns.push(deorbitBurn);
  }
  let burn: Burn | null = null;
  let burnEnd = Infinity;
  /** Apogee altitude when the current burn began, m. */
  let burnApo0 = 0;
  let uncontrolled = false;
  let tumbleBuild = false;
  let apogeeDone = false;
  let prevVr = 1;
  let entryDone = false;
  let peakHeat = 0;
  let peakHeatT = 0;
  /** Lowest heating since the peak: the peak is only called out once heating has clearly fallen from it. */
  let heatAfterPeak = 0;
  const peakR = v3(), peakV = v3();
  // Payload deploy: one satellite every paySpacing seconds, only while coasting above DEPLOY_ALT; the
  // window is fitted to the coast at SECO, once the path is known.
  const pay = ctx.payload;
  const payOn = !!pay && !ctx.payloadDoorFail;
  let payIdx = 0;
  let payFitted = false;
  let payStarted = false;
  let payEnded = false;
  let payStartT = Infinity;
  let payNext = Infinity;
  let paySpacing = 0;
  let payLatest = Infinity;

  // Entry guidance (predictor–corrector on cos(bank))
  let cosBank = 0.5;
  let bankSign = 1;
  let dMiss = 0;
  let lastNpc = -Infinity;
  let npcCount = 0;
  const predOut: EntryPrediction = { end: new Float64Array(3), t: 0 };

  // Landing
  let landingStarted = false;
  let landingSet: number[] = [];
  let landingSetReady = false;
  let cutT = Infinity;
  let splashT = 0;
  let destroyT = Infinity;
  let landingFailT = Infinity;
  const tip: TipState = newTipState();

  const up = v3(), xAx = v3(), yAx = v3(), zAx = v3(), hd = v3(), thr = v3(), zr = v3();
  const hp = v3();
  const vn = v3(), tmp = v3(), tmp2 = v3(), rE = v3(), vE = v3(), latA = v3();
  const stepOpts = { extra: null, flaps: { angles: aero, rates: flaps.rates, automatic: automaticFlaps, gen: ctx.flight.generation } };

  const surfacesMoving = () => {
    for (let i = 0; i < 4; i++) if (flaps.rates[i] !== 0 || flaps.angles[i] !== flaps.targets[i]) return true;
    return false;
  };
  const ev = () => eventState(body, 0, t);
  const record = (force: boolean) => {
    const fine = mode === 'hotstage' || mode === 'flip' || mode === 'landing' || mode === 'splashed' || mode === 'free' || t - tSep < 10 || (air.alt > 100_000 && surfacesMoving());
    // Sparse only once the engines have stopped producing thrust (not while they tail off).
    const vac = air.alt > 100_000 && !part.producingThrust();
    const interval = fine ? 0.05 : vac ? 2 : 0.1;
    if (!force && t - lastRec < interval - 1e-9) return;
    ex.phase = phase;
    ex.heating = air.heating;
    ex.still = mode === 'splashed';
    recordSample(ctx, tb, scratchSample, t, body, part, 0, ex);
    lastRec = t;
    lastPhase = phase;
  };

  const finish = (kind: EndKind, at: number, destroyed: boolean, note?: string) => {
    ended = true;
    part.shutdownAll(at);
    ctx.events.push(makeEndEvent('ship', kind, at, ev(), note));
    ctx.shipEnd = { kind, t: at };
    if (destroyed) {
      phase = Phase.Destroyed;
      record(true);
      mode = 'done';
    }
  };

  const failEngines = (list: number[], at: number) => {
    for (const i of list) if (i >= 0 && i < part.n && part.fail(i, at)) ctx.events.push(makeEngineOutEvent('ship', i, at, ev()));
  };

  const consumeSkip = (): boolean => {
    if (ctx.shipSkips <= 0) return false;
    ctx.shipSkips--;
    return true;
  };

  const loseControl = (kind: 'roll' | 'tumble') => {
    uncontrolled = true;
    qAxis(xAx, body.q, 0);
    qAxis(yAx, body.q, 1);
    if (kind === 'roll') {
      // Slow roll about the long axis with a little coupling into pitch.
      for (let i = 0; i < 3; i++) body.w[i] = yAx[i] * 4 * D + xAx[i] * 0.6 * D;
    } else {
      // Spin up about the long axis while the nose slowly wanders off the flight path.
      tumbleBuild = true;
      for (let i = 0; i < 3; i++) body.w[i] = xAx[i] * 0.5 * D;
    }
  };

  const applyAction = (a: Action) => {
    const at = a.t;
    // Once its flight is over (in the water) the ship takes no more commands or failures.
    if (ended) return;
    if (a.iv) {
      const iv = a.iv;
      if (iv.kind === 'stage-now' || iv.vehicle !== 'ship') return;
      switch (iv.kind) {
        case 'engine-out':
          if (iv.engine >= 0 && iv.engine < part.n && part.fail(iv.engine, at)) {
            ctx.events.push(makeInterventionEvent('ship', at, ev(), `Engine shut down: ${engineName('ship', iv.engine)}`, 'ENGINE OUT'));
          }
          break;
        case 'throttle':
          part.ceiling = clamp(iv.value, 0.4, 1);
          ctx.events.push(makeInterventionEvent('ship', at, ev(), `Throttle limited to ${Math.round(part.ceiling * 100)}%`, 'THROTTLE'));
          break;
        case 'terminate':
          ctx.events.push(makeInterventionEvent('ship', at, ev(), 'Flight termination commanded', 'TERMINATE'));
          finish('termination', at, true);
          break;
        case 'pitch':
          ctx.shipPitchBias = iv.deg;
          ctx.events.push(makeInterventionEvent('ship', at, ev(), `Steering bias ${iv.deg >= 0 ? '+' : ''}${iv.deg.toFixed(1)}°`, 'PITCH'));
          break;
        case 'flap': {
          if (!Number.isInteger(iv.flap) || iv.flap < 0 || iv.flap > 3 || (iv.deg !== null && !Number.isFinite(iv.deg))) break;
          // Fence the command instant so interpolation cannot make a flap move before it is issued.
          record(true);
          flapOverride[iv.flap] = iv.deg === null ? null : clamp(iv.deg, 0, 90);
          flaps.targets[iv.flap] = flapOverride[iv.flap] ?? automaticFlaps[iv.flap];
          const name = ['Forward left', 'Forward right', 'Aft left', 'Aft right'][iv.flap];
          ctx.events.push(makeInterventionEvent('ship', at, ev(), `${name} flap ${iv.deg === null ? 'returned to automatic' : `commanded to ${flapOverride[iv.flap]}°`}`, 'FLAP'));
          break;
        }
        case 'skip-burn':
          ctx.shipSkips++;
          ctx.events.push(makeInterventionEvent('ship', at, ev(), 'Next ship burn cancelled', 'SKIP BURN'));
          if (modeIs('burn') && consumeSkip()) burnEnd = at;
          break;
      }
      return;
    }
    const an = a.anomaly;
    if (!an || an.vehicle !== 'ship') return;
    const idx = ctx.flight.anomalies.indexOf(an);
    switch (an.kind) {
      case 'engine-out': {
        const list = an.engines ?? pickFailingEngines('ship', part.state, (i) => part.isLit(i), an.count ?? 1, ctx.rng(idx));
        ctx.addEvent('anomaly', 'ship', at, ev(), an.note);
        failEngines(list, at);
        break;
      }
      case 'roll':
      case 'tumble':
        ctx.addEvent('anomaly', 'ship', at, ev(), an.note);
        loseControl(an.kind);
        break;
      case 'payload-door-fail':
        if (pay) ctx.addEvent('anomaly', 'ship', at, ev(), an.note);
        break;
      case 'relight-skip':
        // Only news when this run plans a relight (an orbital mission does not).
        if (burns.some((b) => b.kind === 'relight')) ctx.addEvent('anomaly', 'ship', at, ev(), an.note);
        break;
      case 'breakup':
        ctx.addEvent('anomaly', 'ship', at, ev(), an.note);
        finish(lossKind(ctx, 'ship', 'breakup'), at, true);
        break;
      case 'fts': {
        const later = ctx.flight.anomalies.some((b) => b.kind === 'breakup' && b.vehicle === 'ship' && b.t > an.t);
        ctx.addEvent('anomaly', 'ship', at, ev(), an.note);
        if (later) part.shutdownAll(at);
        else finish(lossKind(ctx, 'ship', 'fts'), at, true);
        break;
      }
      default:
        break;
    }
  };

  /** Perigee (or apogee) altitude of the current osculating orbit, m. */
  const apsisAlt = (apo: boolean) => {
    const r = body.r, v = body.v;
    const rl = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
    const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    const hx = r[1] * v[2] - r[2] * v[1], hy = r[2] * v[0] - r[0] * v[2], hz = r[0] * v[1] - r[1] * v[0];
    const h2 = hx * hx + hy * hy + hz * hz;
    const eps = v2 / 2 - MU / rl;
    if (eps >= 0) return Infinity;
    const a = -MU / (2 * eps);
    const e = Math.sqrt(Math.max(0, 1 + (2 * eps * h2) / (MU * MU)));
    return a * (apo ? 1 + e : 1 - e) - RE;
  };

  const startBurn = (b: Burn) => {
    b.done = true;
    if (uncontrolled || ctx.shipSkips > 0) {
      consumeSkip();
      return;
    }
    if (b.kind === 'relight' && ctx.relightSkip) return;
    // In-space burns never dip into the landing reserve.
    if (part.prop <= p.shipReserve) return;
    const sl = [0, 1, 2].filter((i) => part.usable(i));
    const vac = [3, 4, 5].filter((i) => part.usable(i));
    const set = b.kind === 'relight' ? sl.slice(0, 1) : vac.length > 0 ? vac : sl;
    if (set.length === 0) return;
    part.setEngines(set, t);
    if (!part.anyLit()) return;
    part.throttle = b.kind === 'relight' ? p.relightThrottle : 0.6;
    burn = b;
    burnEnd = t + b.duration;
    burnApo0 = apsisAlt(true);
    mode = 'burn';
    phase = Phase.OrbitBurn;
    ctx.addEvent(b.kind === 'relight' ? 'relight' : b.kind === 'insertion' ? 'orbit-insertion' : 'deorbit', 'ship', t, ev());
  };

  const endBurn = () => {
    part.shutdownAll(t);
    burn = null;
    burnEnd = Infinity;
    mode = 'coast';
    phase = Phase.Coast;
  };

  const nextBurn = (): Burn | null => {
    for (const b of burns) if (!b.done) return b;
    return null;
  };

  /**
   * Fits the deploy window into the coast: the planned cadence, squeezed (down to a limit) to end in time. A burn
   * changes the path, so the window is fitted again after each one (only its end, once the deploy has begun).
   */
  const fitDeploy = () => {
    if (!pay) return;
    // Last moment for a release: before the path drops below DEPLOY_ALT, and before the deorbit burn.
    payLatest = Math.min(t + timeToDescend(body.r, body.v, RE + DEPLOY_ALT) - 30, (orbital ? Math.min(tCap, deorbitBurn.t) : tCap) - 120);
    if (payStarted) return;
    // The planned start, brought forward (to a minute after the burn) when the coast is too short for every
    // release after it at the closest spacing.
    payStartT = Math.max(t + 60, Math.min(pay.start, payLatest - (pay.count + 1) * DEPLOY_MIN_SPACING));
    paySpacing = (pay.end - pay.start) / (pay.count + 1);
    const room = (payLatest - payStartT) / (pay.count + 1);
    if (room < paySpacing) paySpacing = Math.max(DEPLOY_MIN_SPACING, room);
    payNext = payStartT + paySpacing;
  };

  /** Ends the deploy, noting how many satellites left the bay when it had to stop early. */
  const endDeploy = () => {
    if (!pay || !payStarted || payEnded) return;
    payEnded = true;
    ctx.addEvent('payload-end', 'ship', t, ev(), payIdx < pay.count ? `${payIdx} of ${pay.count} satellites deployed` : undefined);
  };

  /**
   * Deorbit time for an orbit the flight was not planned for: the pass that brings the splashdown closest to the
   * landing zone. Each candidate burn point comes from the current orbit (Kepler); the burn turns it into the
   * apoapsis of an orbit with its periapsis at the deorbit perigee, which sets the coast to the entry interface;
   * entry then flies Flight 14's range (ENTRY_ARC, ENTRY_SPAN) while the Earth turns underneath.
   */
  const chooseDeorbit = (): number => {
    const r = body.r, v = body.v;
    const rl = Math.sqrt(r[0] ** 2 + r[1] ** 2 + r[2] ** 2);
    const v2 = v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
    const hx = r[1] * v[2] - r[2] * v[1], hy = r[2] * v[0] - r[0] * v[2], hz = r[0] * v[1] - r[1] * v[0];
    const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
    const a = -MU / (2 * (v2 / 2 - MU / rl));
    if (!(a > 0) || hl <= 0) return Infinity;
    const n = Math.sqrt(MU / (a * a * a));
    // Eccentricity vector (v × h)/μ − r/|r|; perifocal basis P (periapsis, or here when circular), Q = h × P.
    let px = (v[1] * hz - v[2] * hy) / MU - r[0] / rl, py = (v[2] * hx - v[0] * hz) / MU - r[1] / rl, pz = (v[0] * hy - v[1] * hx) / MU - r[2] / rl;
    let e = Math.sqrt(px * px + py * py + pz * pz);
    if (e < 1e-6) {
      px = r[0] / rl;
      py = r[1] / rl;
      pz = r[2] / rl;
      e = 0;
    } else {
      px /= e;
      py /= e;
      pz /= e;
    }
    e = Math.min(e, 0.9);
    const qx = (hy * pz - hz * py) / hl, qy = (hz * px - hx * pz) / hl, qz = (hx * py - hy * px) / hl;
    const nu0 = Math.atan2(r[0] * qx + r[1] * qy + r[2] * qz, r[0] * px + r[1] * py + r[2] * pz);
    const ecc0 = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu0 / 2));
    const m0 = ecc0 - e * Math.sin(ecc0);
    const rp = RE + p.deorbitPerigee, re = RE + ENTRY_ALT;
    if (rp >= re) return Infinity;
    const ll = Math.sqrt(landing[0] ** 2 + landing[1] ** 2 + landing[2] ** 2);
    let best = -2;
    let bestT = Infinity;
    for (let td = t + 120; td <= tCap; td += 15) {
      // Burn point: mean anomaly forward, Kepler's equation by Newton steps.
      const m = m0 + n * (td - t);
      let ea = m;
      for (let k = 0; k < 5; k++) ea -= (ea - e * Math.sin(ea) - m) / (1 - e * Math.cos(ea));
      const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(ea / 2), Math.sqrt(1 - e) * Math.cos(ea / 2));
      const rb = a * (1 - e * Math.cos(ea));
      if (rb <= re) continue;
      // After the burn: apoapsis rb, periapsis rp; the coast runs from the apoapsis down to the entry interface.
      const a2 = (rb + rp) / 2, e2 = (rb - rp) / (rb + rp);
      const nuE = Math.acos(clamp((a2 * (1 - e2 * e2) / re - 1) / e2, -1, 1));
      const eaE = 2 * Math.atan(Math.sqrt((1 - e2) / (1 + e2)) * Math.tan(nuE / 2));
      const coast = (Math.PI - eaE + e2 * Math.sin(eaE)) / Math.sqrt(MU / (a2 * a2 * a2));
      const ts = td + coast + ENTRY_SPAN;
      if (ts > tCap - 300) break;
      const ang = nu + (Math.PI - nuE) + ENTRY_ARC;
      const c = Math.cos(ang), sn = Math.sin(ang);
      const ix = c * px + sn * qx, iy = c * py + sn * qy, iz = c * pz + sn * qz;
      // Into the Earth-fixed frame at splashdown.
      const th = OMEGA * ts;
      const ex = Math.cos(th) * ix + Math.sin(th) * iy, ey = -Math.sin(th) * ix + Math.cos(th) * iy;
      const cosD = (ex * landing[0] + ey * landing[1] + iz * landing[2]) / ll;
      if (cosD > best) {
        best = cosD;
        bestT = td;
      }
    }
    return bestT;
  };

  part.throttle = 1;
  for (let guard = 0; guard < 2_000_000 && !modeIs('done'); guard++) {
    while (actIdx < acts.length && acts[actIdx].t <= t + 1e-9 && !modeIs('done')) applyAction(acts[actIdx++]);
    if (modeIs('done')) break;

    const rl = radialUp(body.r, up);
    const vr = body.v[0] * up[0] + body.v[1] * up[1] + body.v[2] * up[2];

    // --- Scheduled transitions ----------------------------------------------------------------
    if (t >= destroyT) {
      finish('lost', t, true);
      break;
    }
    if (t >= landingFailT) {
      failEngines(part.litEngines(), t);
      landingFailT = Infinity;
    }
    if (mode === 'hotstage' && t >= tSep + 1) {
      mode = 'ascent';
    }
    if ((mode === 'ascent' || mode === 'hotstage') && !rvacLit && t >= rvacT && air.alt > 40_000) {
      rvacLit = true;
      for (let i = 3; i < 6; i++) if (part.usable(i)) part.ignite(i, t);
    }
    if (mode === 'ascent' && phase === Phase.HotStage && (rvacLit || t > tSep + 4)) phase = Phase.Ascent;
    const active = burn as Burn | null;
    if (modeIs('burn') && active) {
      let done = t >= burnEnd - 1e-9 || !part.anyLit() || part.prop <= p.shipReserve;
      // Insertion stops at the target perigee, capped just below the burn altitude (a prograde burn
      // cannot lift the perigee above the point where it is made), or once it mostly raises the far side of
      // the orbit (a burn made while falling away from the top); deorbit at the target perigee.
      if (active.kind === 'insertion') {
        const apo = apsisAlt(true);
        if (apsisAlt(false) >= Math.min(p.insertionPerigee, air.alt - 3_000, apo - 15_000) || apo > Math.max(burnApo0, p.insertionPerigee) + 30_000) done = true;
      }
      if (active.kind === 'deorbit' && apsisAlt(false) <= p.deorbitPerigee) done = true;
      if (done) {
        endBurn();
        if (active.kind === 'insertion' && deorbitBurn.t === Infinity) deorbitBurn.t = chooseDeorbit();
        if (payFitted && !payEnded) fitDeploy();
      }
    }
    if (mode === 'coast' && !uncontrolled) {
      const b = nextBurn();
      if (b) {
        // Untimed (an insertion the flight did not plan): at the top of the climb, where a prograde burn
        // raises the far side of the path without lifting the top.
        const bt = Number.isNaN(b.t) ? (vr < 2 && t > secoT + 120 ? t : Infinity) : b.t;
        if (t >= bt - 1e-9) startBurn(b);
      }
    }
    if (payOn && pay && secoT > 0 && !payEnded && !ended) {
      if (!payFitted) {
        payFitted = true;
        fitDeploy();
      }
      // Coasting in space (not during a burn, never once the air thickens or entry has begun).
      const canRelease = mode === 'coast' && !entryDone && air.alt > DEPLOY_ALT;
      // The deploy begins only if its first release still fits before the deadline.
      if (!payStarted && t >= payStartT - 1e-9 && Math.max(t, payNext) <= payLatest && canRelease) {
        payStarted = true;
        ctx.addEvent('payload-start', 'ship', t, ev());
      }
      if (payStarted && payIdx < pay.count && t >= payNext - 1e-9 && t <= payLatest && canRelease) {
        // Released from the payload bay, pushed out at ~0.75 m/s through the door (−Z side).
        bodyPointEcef(body, 0, t, rE, vE);
        qAxis(zAx, body.q, 2);
        qAxis(yAx, body.q, 1);
        inertialToEcef(tmp, zAx, t);
        inertialToEcef(tmp2, yAx, t);
        const off = part.spec.payloadCom - part.com();
        ctx.releases.push({
          t,
          index: payIdx,
          pos: [rE[0] + tmp2[0] * off - tmp[0] * 4.6, rE[1] + tmp2[1] * off - tmp[1] * 4.6, rE[2] + tmp2[2] * off - tmp[2] * 4.6],
          vel: [vE[0] - tmp[0] * 0.75, vE[1] - tmp[1] * 0.75, vE[2] - tmp[2] * 0.75],
        });
        part.payload = Math.max(0, part.payload - pay.unitMass);
        payIdx++;
        // On schedule, or catching up at twice the pace after a pause (a burn).
        payNext = Math.max(payNext + paySpacing, t + 0.5 * paySpacing);
      }
      if (payStarted && payIdx >= pay.count && t >= payNext - 1e-9) endDeploy();
      else if (payStarted && (t > payLatest || entryDone || (air.alt <= DEPLOY_ALT && vr < 0))) endDeploy();
    }
    if (!apogeeDone && secoT > 0 && prevVr > 0 && vr <= 0) {
      apogeeDone = true;
      ctx.addEvent('ship-apogee', 'ship', t, ev());
    }
    prevVr = vr;
    if (!entryDone && secoT > 0 && apogeeDone && vr < 0 && air.alt < 120_000 && (mode === 'coast' || modeIs('burn'))) {
      entryDone = true;
      if (modeIs('burn')) endBurn();
      mode = 'entry';
      phase = Phase.Entry;
      ctx.addEvent('entry', 'ship', t, ev());
      ctx.armPhase('entry', t);
    }
    if (mode === 'entry' && air.mach < 1 && air.alt < 30_000) phase = Phase.BellyFlop;
    if (t >= cutT) {
      part.shutdownAll(t);
      cutT = Infinity;
      mode = 'free';
    }
    if (mode === 'splashed' && t - splashT >= 8) {
      record(true);
      break;
    }
    if (t > tCap) {
      finish(air.alt > 100_000 ? 'orbit' : 'lost', t, false);
      record(true);
      break;
    }

    if (phase !== lastPhase) record(true);
    else record(false);

    // --- Time step --------------------------------------------------------------------------------
    const powered = part.producingThrust();
    let dt = 0.02;
    if (!powered && mode === 'coast') dt = air.alt > 140_000 ? 2 : air.alt > 100_000 ? 0.2 : 0.02;
    else if (!powered && mode === 'entry' && air.alt > 95_000) dt = 0.1;
    else if (mode === 'ascent' && !uncontrolled) {
      // Land the last ascent step exactly on the cut-off energy (thrust is the only source of energy
      // change in vacuum), so SECO does not jitter by a step: near-circular orbits amplify that.
      const v2 = body.v[0] ** 2 + body.v[1] ** 2 + body.v[2] ** 2;
      const thrustAcc = part.thrust(air.pressure) / body.mass;
      const eps = v2 / 2 - MU / rl + Math.sqrt(v2) * 0.5 * SPOOL_DOWN * thrustAcc;
      const rate = Math.sqrt(v2) * thrustAcc;
      if (rate > 0 && energyT > eps && (energyT - eps) / rate < dt) dt = Math.max(1e-4, (energyT - eps) / rate);
    }
    if (surfacesMoving()) dt = Math.min(dt, 0.05);
    let tNext = Math.min(burnEnd, cutT, destroyT, landingFailT);
    if (actIdx < acts.length) tNext = Math.min(tNext, acts[actIdx].t);
    const nb = mode === 'coast' ? nextBurn() : null;
    if (nb && !Number.isNaN(nb.t)) tNext = Math.min(tNext, nb.t);
    if (nb && !Number.isNaN(nb.t) && nb.t - t < 90 && nb.t > t) dt = Math.min(dt, 0.5);
    if (payOn && pay && payFitted && !payEnded) tNext = Math.min(tNext, payStarted ? payNext : payStartT);
    if (tNext > t + 1e-9 && tNext - t < dt) dt = tNext - t;

    if (mode === 'splashed') {
      t += dt;
      tipOver(body, tip, t);
      continue;
    }

    // --- Guidance and attitude ---------------------------------------------------------------------
    // Attitude and steering run at 10 Hz (every step in flips, landings, burns and hot staging);
    // cut-off and ignition checks run every step.
    const fine = uncontrolled || mode === 'hotstage' || mode === 'flip' || mode === 'landing' || modeIs('burn') || mode === 'free' || dt > 0.09 || (mode === 'ascent' && peg.frozen);
    attAcc += dt;
    const attDue = fine || attAcc >= 0.1 - 1e-9;
    const adt = attAcc;
    if (attDue) {
      attAcc = 0;
      qAxis(zAx, body.q, 2);
      if (mode === 'ascent' || mode === 'hotstage' || mode === 'coast' || modeIs('burn')) flapPhase = 'stow';
      flapRoll = flapPitch = 0;
      // Entry and landing derive their own target frame; only ascent/coast/burn consume this one.
      if (!uncontrolled && (mode === 'ascent' || mode === 'coast' || modeIs('burn'))) {
        for (let i = 0; i < 3; i++) hd[i] = body.v[i] - vr * up[i];
        const hl = Math.sqrt(hd[0] * hd[0] + hd[1] * hd[1] + hd[2] * hd[2]) || 1;
        for (let i = 0; i < 3; i++) hd[i] /= hl;
        shipRollReference(zr, up, hd, ctx.flight.n, t);
      }
    }

    if (uncontrolled) {
      if (tumbleBuild) {
        qAxis(yAx, body.q, 1);
        const spinRate = body.w[0] * yAx[0] + body.w[1] * yAx[1] + body.w[2] * yAx[2];
        if (spinRate < p.tumbleRate * D) for (let i = 0; i < 3; i++) body.w[i] += yAx[i] * 3 * D * dt;
      }
      spin(body, dt);
      if (mode === 'ascent' && secoT < 0 && (part.prop <= p.shipReserve || !part.anyLit())) {
        part.shutdownAll(t);
        mode = 'coast';
        phase = Phase.Coast;
        secoT = t;
        // Already falling: the top of the path was passed under power, so the coast goes straight on to entry.
        if (vr <= 0) apogeeDone = true;
      }
    } else if (mode === 'hotstage') {
      spin(body, dt);
    } else if (mode === 'ascent') {
      if (t - lastPeg >= (peg.frozen ? 0 : 0.1)) {
        lastPeg = t;
        const vt = Math.sqrt(Math.max(0, body.v[0] ** 2 + body.v[1] ** 2 + body.v[2] ** 2 - vr * vr));
        const f = part.thrust(air.pressure);
        const md = part.massFlow();
        frCmd = pegStep(peg, t, rl, vr, vt, Math.max(f / body.mass, 0.5), md > 0 ? f / md : 3500, pegTarget);
      }
      if (attDue) {
        // In-plane direction of the target orbit, yawed to null the out-of-plane velocity.
        planeHeading(hp, ctx.planeNormal, up, body.v);
        const pitch = Math.asin(frCmd) + ctx.shipPitchBias * D;
        for (let i = 0; i < 3; i++) thr[i] = Math.sin(pitch) * up[i] + Math.cos(pitch) * hp[i];
        slew(body, thr, zr, 4 * D, 2 * D, adt);
      }
      // Throttle: hold the acceleration limit (any user ceiling caps the command).
      const fmax = part.fullThrust(air.pressure);
      part.throttle = fmax > 0 ? (p.shipGLimit * GEE * body.mass) / fmax : 1;
      // Cut-off: orbital energy reached (allowing for the speed the engines still add while they spool
      // down), or the ascent propellant is gone.
      const v2 = body.v[0] ** 2 + body.v[1] ** 2 + body.v[2] ** 2;
      const tailDv = (0.5 * SPOOL_DOWN * part.thrust(air.pressure)) / body.mass;
      const eps = v2 / 2 - MU / rl + Math.sqrt(v2) * tailDv;
      if (eps >= energyT || part.prop <= p.shipReserve || !part.anyLit()) {
        const healthy = part.anyLit();
        part.shutdownAll(t);
        mode = 'coast';
        phase = Phase.Coast;
        secoT = t;
        if (healthy) ctx.addEvent('seco', 'ship', t, ev());
        // Already falling: the top of the path was passed under power, so the coast goes straight on to entry.
        if (vr <= 0) apogeeDone = true;
      }
    } else if (mode === 'coast' || modeIs('burn')) {
      if (attDue) {
        let rate = 1.5 * D;
        const b0 = burn as Burn | null;
        if (modeIs('burn') && b0) {
          // Relight and deorbit retrograde, insertion prograde.
          const sgn = b0.kind === 'insertion' ? 1 : -1;
          const vl = Math.sqrt(body.v[0] ** 2 + body.v[1] ** 2 + body.v[2] ** 2) || 1;
          for (let i = 0; i < 3; i++) thr[i] = (sgn * body.v[i]) / vl;
          rate = 3 * D;
        } else {
          const b = nextBurn();
          const prep = b && !Number.isNaN(b.t) && b.t - t < 80 && !(b.kind === 'relight' && ctx.relightSkip);
          if (prep && b) {
            const sgn = b.kind === 'insertion' ? 1 : -1;
            const vl = Math.sqrt(body.v[0] ** 2 + body.v[1] ** 2 + body.v[2] ** 2) || 1;
            for (let i = 0; i < 3; i++) thr[i] = (sgn * body.v[i]) / vl;
            rate = 4 * D;
          } else if (apogeeDone && air.alt < 170_000 && vr < 0) {
            // Line up for entry: belly into the flow at the entry angle of attack.
            entryAttitude(thr, zr, air.vAir, up, p.entryAoA * D, 1);
            flapPhase = 'entry';
            rate = 2 * D;
          } else for (let i = 0; i < 3; i++) thr[i] = hd[i];
        }
        slew(body, thr, zr, rate, rate * 0.5, adt);
      }
    } else if (mode === 'entry') {
      const mach = air.mach;
      if (mach > 2.5 && air.alt < 115_000 && t - lastNpc >= 20) {
        lastNpc = t;
        npcCount++;
        // Predictor–corrector: Newton step on cos(bank) to null the along-track miss.
        const m0 = missAlong(body, t, part.spec.aero, p.entryAoA, cosBank, bankSign, landing, p.entryAim, predOut, tmp, ctx.windPeak);
        if (npcCount === 1 || npcCount % 4 === 0 || dMiss <= 1000) {
          const dx = cosBank > 0.85 ? -0.15 : 0.15;
          const m1 = missAlong(body, t, part.spec.aero, p.entryAoA, cosBank + dx, bankSign, landing, p.entryAim, predOut, tmp, ctx.windPeak);
          dMiss = Math.max(1000, (m1 - m0) / dx);
        }
        cosBank = clamp(cosBank - clamp(m0 / dMiss, -0.35, 0.35), -0.4, 1);
      }
      if (attDue) {
        // Bank reversals keep the cross-range error inside a speed-dependent corridor.
        bodyPointEcef(body, 0, t, rE, vE);
        const xr = crossRangeAngle(rE, vE, landing);
        const corridor = (2 + 8 * clamp(air.airspeed / 7500, 0, 1)) * D;
        if (xr > corridor && bankSign < 0) bankSign = 1;
        else if (xr < -corridor && bankSign > 0) bankSign = -1;
        // Wings level once slow; lift turned up as the dynamic pressure climbs past the entry corridor.
        const cb = mach > 2 ? Math.max(cosBank, Math.min(1, (air.q - ENTRY_Q_SOFT) / (ENTRY_Q_HARD - ENTRY_Q_SOFT))) : 1;
        entryAttitude(thr, zr, air.vAir, up, entryAoA(p.entryAoA, mach), cb, bankSign);
        slew(body, thr, zr, 6 * D, 4 * D, adt);
        // The differential responds to attitude error and angular rate, not held bank angle.
        // A bank is a lift-plane rotation; resolve the quaternion error into body axes first.
        qAxis(xAx, body.q, 0);
        qAxis(yAx, body.q, 1);
        qAxis(zAx, body.q, 2);
        const rollError = Math.atan2(
          yAx[0] * (zAx[1] * zr[2] - zAx[2] * zr[1]) + yAx[1] * (zAx[2] * zr[0] - zAx[0] * zr[2]) + yAx[2] * (zAx[0] * zr[1] - zAx[1] * zr[0]),
          zAx[0] * zr[0] + zAx[1] * zr[1] + zAx[2] * zr[2]);
        const pitchError = Math.atan2(thr[0] * zAx[0] + thr[1] * zAx[1] + thr[2] * zAx[2], thr[0] * yAx[0] + thr[1] * yAx[1] + thr[2] * yAx[2]);
        const rollRate = body.w[0] * yAx[0] + body.w[1] * yAx[1] + body.w[2] * yAx[2];
        const pitchRate = body.w[0] * xAx[0] + body.w[1] * xAx[1] + body.w[2] * xAx[2];
        flapRoll = flapFeedback(rollError / D, rollRate / D);
        flapPitch = flapFeedback(pitchError / D, pitchRate / D);
        flapPhase = phase === Phase.BellyFlop ? 'belly' : 'entry';
      }
      if (phase === Phase.BellyFlop) {
        // Flip and landing-burn ignition when the stopping height is reached.
        if (!landingSetReady) {
          landingSet = [0, 1, 2].filter((i) => part.usable(i)).slice(0, plan.landingEngines);
          landingSetReady = true;
        }
        const sl = landingSet;
        const vd = -vr;
        if (sl.length > 0 && vd > 20) {
          const s0 = part.spec.specs[0];
          const fSl = sl.length * (s0.fVac - air.pressure * s0.exitArea);
          const aDec = Math.max(2, 0.55 * (fSl / body.mass - GEE));
          const hIgn = p.flipMargin * (vd * 4.5 + (vd * vd) / (2 * aDec));
          if (air.alt - part.com() <= hIgn) {
            if (consumeSkip()) {
              mode = 'free';
              phase = Phase.BellyFlop;
            } else {
              part.setEngines(sl, t);
              if (part.anyLit()) {
                // Failures of the ignition itself (an engine that does not relight) strike before the callout.
                ctx.armPhase('ship-landing-burn', t);
                while (actIdx < acts.length && acts[actIdx].t <= t + 1e-9 && !modeIs('done')) applyAction(acts[actIdx++]);
                if (modeIs('done')) break;
              }
              if (!part.anyLit()) {
                // Nothing left to light (tanks dry, engines out): no landing burn, the belly flop goes all the way down.
                landingSet = [];
              } else {
                part.throttle = 0.7;
                landingStarted = true;
                mode = 'flip';
                phase = Phase.ShipFlip;
                ctx.addEvent('ship-flip', 'ship', t, ev());
                ctx.addEvent('ship-landing-burn', 'ship', t, ev());
                if (ctx.shipLandingFail) {
                  landingFailT = t + 0.5;
                  destroyT = t + 1.5;
                }
              }
            }
          }
        }
      }
    } else if (mode === 'flip' || mode === 'landing') {
      const h = Math.max(0.1, air.alt - part.com());
      const vd = -vr;
      vn[0] = body.v[0] + OMEGA * body.r[1] - vr * up[0];
      vn[1] = body.v[1] - OMEGA * body.r[0] - vr * up[1];
      vn[2] = body.v[2] - vr * up[2];
      // Track a constant-braking descent to the surface (feed-forward scaled by the actual descent rate, so a ship
      // that slows early keeps coming down instead of hovering), and lean back against the horizontal drift as far
      // as the height allows, so the last stretch comes down upright.
      const vDes = Math.sqrt(2 * SHIP_LANDING_DECEL * h) + 1;
      const aReq = SHIP_LANDING_DECEL * clamp(vd / vDes, 0, 1.5) + 1.2 * (vd - vDes);
      const m = body.mass;
      const fUp = air.aero[0] * up[0] + air.aero[1] * up[1] + air.aero[2] * up[2];
      const tV = Math.max(0.05 * m * GEE, m * (GEE + aReq) - fUp);
      for (let i = 0; i < 3; i++) latA[i] = -SHIP_DRIFT_GAIN * vn[i];
      const pot = part.litThrustPotential(air.pressure);
      const cap = landingTiltCap(h, SHIP_LANDING_TILT, SHIP_LANDING_TILT_FINAL, SHIP_LANDING_TILT_SPAN);
      const need = landingThrust(thr, up, latA, m, tV, MIN_THROTTLE * pot, pot * Math.min(1, part.ceiling), cap);
      if (mode === 'flip') {
        // The engines swing the ship upright, idling until it is nearly there.
        for (let i = 0; i < 3; i++) thr[i] = up[i];
        qAxis(yAx, body.q, 1);
        part.throttle = yAx[0] * up[0] + yAx[1] * up[1] + yAx[2] * up[2] < Math.cos(FLIP_IDLE_TILT) ? MIN_THROTTLE : FLIP_THROTTLE;
      } else part.throttleTo(need, air.pressure, t, landingSet, vd < 3);
      const err = mode === 'flip' ? slew(body, thr, zAx, FLIP_RATE * D, FLIP_ACCEL * D, dt) : slew(body, thr, zAx, 25 * D, 20 * D, dt);
      if (mode === 'flip' && err < 12 * D) {
        mode = 'landing';
        phase = Phase.LandingBurn;
      }
      // Landing flip: forward flaps fold away, aft flaps stay out.
      flapPhase = 'flip';
      flapRoll = flapPitch = 0;
      if (mode === 'landing' && (h < 1 || (vd < 1 && h < 4))) cutT = t;
    } else if (mode === 'free' && landingStarted) {
      // Engines cut just above the water: the ship drops the last metres upright.
      slew(body, up, zAx, 8 * D, 4 * D, dt);
    } else if (mode === 'free') {
      spin(body, dt);
    }

    // Keep actual surfaces persistent across phase changes, commanded overrides and playback seeks.
    // Lost guidance holds its last automatic command; actuators can still finish an in-flight movement.
    if (!uncontrolled && (flapPhase !== lastFlapPhase || flapRoll !== lastFlapRoll || flapPitch !== lastFlapPitch)) {
      commandFlaps(flaps, flapPhase, flapRoll, flapPitch);
      automaticFlaps.set(flaps.targets);
      lastFlapPhase = flapPhase; lastFlapRoll = flapRoll; lastFlapPitch = flapPitch;
      for (let i = 0; i < 4; i++) if (flapOverride[i] !== null) flaps.targets[i] = flapOverride[i]!;
    }
    if (surfacesMoving()) {
      // Keep the existing explicit step scheme: prior AirData, current actual attitude/rates.
      // Gravity-only coasts do not refresh AirData density. Refresh just this actuator input
      // while moving above 140 km, without changing the coast's translation model.
      // Co-rotating air has angular velocity [0, 0, OMEGA] in inertial axes.
      if (air.alt < 180_000 && air.density > 0) {
        flapAirAngularVelocity[0] = body.w[0];
        flapAirAngularVelocity[1] = body.w[1];
        flapAirAngularVelocity[2] = body.w[2] - OMEGA;
        const density = mode === 'coast' && air.alt > 140_000 ? airDensity(air.alt) : air.density;
        flapNormalPressures(flapPressures, ctx.flight.generation, aero, body.q, air.vAir,
          density, part.com(), flapAirAngularVelocity, flaps.rates);
      } else flapPressures.fill(0);
      advanceFlaps(flaps, dt, flapPressures);
    }

    if (!powered && mode === 'coast' && air.alt > 140_000) {
      coastBody(body, dt, air);
      air.vAir[0] = body.v[0] + OMEGA * body.r[1];
      air.vAir[1] = body.v[1] - OMEGA * body.r[0];
      air.vAir[2] = body.v[2];
    } else stepBody(body, dt, ctx.windPeak, air, stepOpts);
    t += dt;
    if (air.depleted) part.shutdownAll(t);
    // Structural limit: a ship driven through thick air too fast (a dive, a climb kept low) breaks up.
    if (air.q > (air.aoa < NOSE_FIRST ? Q_BREAKUP_NOSE : Q_BREAKUP_BELLY)) {
      ctx.addEvent('anomaly', 'ship', t, ev(), 'Aerodynamic loads exceed what the structure can take; the ship breaks up.');
      finish('lost', t, true);
      break;
    }
    if (mode === 'entry' && air.heating > peakHeat) {
      peakHeat = air.heating;
      peakHeatT = t;
      peakR.set(body.r);
      peakV.set(body.v);
      heatAfterPeak = peakHeat;
    } else if (air.heating < heatAfterPeak) heatAfterPeak = air.heating;

    // Contact with the sea.
    if (air.alt < 2_000) {
      qAxis(yAx, body.q, 1);
      const com = part.com();
      for (let i = 0; i < 3; i++) tmp[i] = body.r[i] - yAx[i] * com;
      const baseAlt = Math.sqrt(tmp[0] ** 2 + tmp[1] ** 2 + tmp[2] ** 2) - RE;
      const nose = Math.sqrt((body.r[0] + yAx[0] * (part.spec.length - com)) ** 2 + (body.r[1] + yAx[1] * (part.spec.length - com)) ** 2 + (body.r[2] + yAx[2] * (part.spec.length - com)) ** 2) - RE;
      if (Math.min(baseAlt, nose) <= 0) {
        qAxis(zAx, body.q, 2);
        const vRel = Math.sqrt((body.v[0] + OMEGA * body.r[1]) ** 2 + (body.v[1] - OMEGA * body.r[0]) ** 2 + body.v[2] ** 2);
        inertialToEcef(tmp2, tmp, t);
        const r2 = Math.sqrt(tmp2[0] ** 2 + tmp2[1] ** 2 + tmp2[2] ** 2);
        const onLand = isLand((Math.asin(tmp2[2] / r2) * 180) / Math.PI, (Math.atan2(tmp2[1], tmp2[0]) * 180) / Math.PI);
        if (vRel < 15 && baseAlt <= nose && !onLand) {
          radialUp(body.r, up);
          splashT = t;
          finish('splashdown', t, false);
          mode = 'splashed';
          phase = Phase.Splashed;
          startTip(tip, body, up, tmp, com, t);
          record(true);
        } else if (onLand) finish('impact', t, true, 'Came down on land.');
        else finish(landingStarted ? 'lost' : 'impact', t, true);
      }
    }
  }
  if (peakHeat > 0.05 && heatAfterPeak < 0.9 * peakHeat) {
    body.r.set(peakR);
    body.v.set(peakV);
    ctx.addEvent('peak-heating', 'ship', peakHeatT, eventState(body, 0, peakHeatT));
  }
  if (!ended) ctx.shipEnd = { kind: 'lost', t };
}

/**
 * Seconds until a coasting path (two-body, inertial r and v) next descends through radius rd: 0 when it never
 * rises above rd or is already below it and falling, Infinity when it never comes down that far.
 */
function timeToDescend(r: Float64Array, v: Float64Array, rd: number): number {
  const rl = Math.sqrt(r[0] ** 2 + r[1] ** 2 + r[2] ** 2);
  const eps = (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) / 2 - MU / rl;
  if (eps >= 0) return Infinity;
  const a = -MU / (2 * eps);
  const eCos = 1 - rl / a; // e cos E
  const eSin = (r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) / Math.sqrt(MU * a); // e sin E
  const e = Math.sqrt(eCos * eCos + eSin * eSin);
  if (a * (1 + e) <= rd) return 0;
  if (a * (1 - e) >= rd) return Infinity;
  let e0 = Math.atan2(eSin, eCos);
  if (e0 < 0) e0 += 2 * Math.PI;
  const ed = 2 * Math.PI - Math.acos(clamp((1 - rd / a) / e, -1, 1));
  if (e0 >= ed) return 0;
  return (ed - e * Math.sin(ed) - (e0 - e * Math.sin(e0))) / Math.sqrt(MU / (a * a * a));
}

const eu = v3(), es = v3(), el = v3();

/**
 * Belly-first attitude for angle of attack `aoa` and bank (cos given, sign): the nose is pitched from
 * the airflow towards the lift vector; the belly (+Z) faces the oncoming air.
 */
function entryAttitude(yOut: Float64Array, zOut: Float64Array, vAir: Float64Array, up: Float64Array, aoa: number, cosBank: number, sign = 1): void {
  const V = Math.sqrt(vAir[0] ** 2 + vAir[1] ** 2 + vAir[2] ** 2);
  if (V < 1) {
    yOut.set(up);
    return;
  }
  const ux = vAir[0] / V, uy = vAir[1] / V, uz = vAir[2] / V;
  const d = up[0] * ux + up[1] * uy + up[2] * uz;
  for (let i = 0; i < 3; i++) eu[i] = up[i] - d * (i === 0 ? ux : i === 1 ? uy : uz);
  const l = Math.sqrt(eu[0] ** 2 + eu[1] ** 2 + eu[2] ** 2) || 1;
  for (let i = 0; i < 3; i++) eu[i] /= l;
  es[0] = uy * eu[2] - uz * eu[1];
  es[1] = uz * eu[0] - ux * eu[2];
  es[2] = ux * eu[1] - uy * eu[0];
  const cb = clamp(cosBank, -1, 1);
  const sb = sign * Math.sqrt(1 - cb * cb);
  for (let i = 0; i < 3; i++) el[i] = cb * eu[i] + sb * es[i];
  const ca = Math.cos(aoa), sa = Math.sin(aoa);
  yOut[0] = ca * ux + sa * el[0];
  yOut[1] = ca * uy + sa * el[1];
  yOut[2] = ca * uz + sa * el[2];
  zOut[0] = sa * ux - ca * el[0];
  zOut[1] = sa * uy - ca * el[1];
  zOut[2] = sa * uz - ca * el[2];
}

const mr = v3(), mv = v3();

/**
 * Predicted along-track overshoot (m, + = beyond the target) for a constant bank: arc lengths along the great
 * circle from the current ground point through the predicted end point. The target always counts as ahead (up
 * to a full turn of the globe), so a ship that cannot reach it sees an undershoot and flies for range.
 */
function missAlong(body: Body, t: number, cfg: Body['aero'], aoa: number, cosBank: number, sign: number, target: Float64Array, aim: number, out: EntryPrediction, tmp: Float64Array, windPeak: number): number {
  mr.set(body.r);
  mv.set(body.v);
  predictEntry(mr, mv, t, body.mass, cfg, aoa, cosBank, sign, out, windPeak);
  inertialToEcef(tmp, body.r, t);
  const e = out.end;
  const r0 = Math.sqrt(tmp[0] * tmp[0] + tmp[1] * tmp[1] + tmp[2] * tmp[2]);
  const ux = tmp[0] / r0, uy = tmp[1] / r0, uz = tmp[2] / r0;
  // Forward direction at the current point, in the plane of the current point and the end point.
  const nx = uy * e[2] - uz * e[1], ny = uz * e[0] - ux * e[2], nz = ux * e[1] - uy * e[0];
  let wx = ny * uz - nz * uy, wy = nz * ux - nx * uz, wz = nx * uy - ny * ux;
  const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (wl < 1e-12) return aim;
  wx /= wl;
  wy /= wl;
  wz /= wl;
  const thE = Math.atan2(e[0] * wx + e[1] * wy + e[2] * wz, e[0] * ux + e[1] * uy + e[2] * uz);
  let thT = Math.atan2(target[0] * wx + target[1] * wy + target[2] * wz, target[0] * ux + target[1] * uy + target[2] * uz);
  if (thT < 0) thT += 2 * Math.PI;
  return RE * (thE - thT) + aim;
}

/** Signed angle (rad) between the ground track direction and the bearing to the target; + = target to the right. */
function crossRangeAngle(rE: Float64Array, vE: Float64Array, target: Float64Array): number {
  const r = Math.sqrt(rE[0] ** 2 + rE[1] ** 2 + rE[2] ** 2);
  const ux = rE[0] / r, uy = rE[1] / r, uz = rE[2] / r;
  const vd = vE[0] * ux + vE[1] * uy + vE[2] * uz;
  const hx = vE[0] - vd * ux, hy = vE[1] - vd * uy, hz = vE[2] - vd * uz;
  const td = target[0] * ux + target[1] * uy + target[2] * uz;
  const bx = target[0] - td * ux, by = target[1] - td * uy, bz = target[2] - td * uz;
  // sin of angle from h to b about up
  const cx = hy * bz - hz * by, cy = hz * bx - hx * bz, cz = hx * by - hy * bx;
  const sinA = cx * ux + cy * uy + cz * uz;
  const cosA = hx * bx + hy * by + hz * bz;
  return -Math.atan2(sinA, cosA);
}

