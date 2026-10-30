import { slew as slewFn, spin as spinFn } from './attitude';
import { airDensity } from './atmosphere';
import { flyBallistic, type DragTable, type FlightOut } from './ballistic';
import { eventState, recordSample as recordSampleFn, scratchSample, type Action, type SampleExtras, type SimContext } from './context';
import { engineName, pickFailingEngines, selectBoosterEngines } from './engines';
import { makeEndEvent, makeEngineOutEvent, makeInterventionEvent } from './events';
import { ecefToInertial as ecefToInertialFn, enuAt as enuAtFn, inertialToEcef } from './geo';
import { isLand } from './land';
import { lossKind } from './outcome';
import type { Body, VehicleRt } from './runtime';
import { newAirData, stepBody as stepBodyFn } from './step';
import { holdInArms, newTipState, startArms, startTip, tipOver, type ArmsState, type TipState } from './surface';
import { EARTH_OMEGA, EARTH_RADIUS, G0, Phase, type BoosterRecovery, type EndKind, type PhaseCode } from './types';
import { clamp, DEG, qAxis as qAxisFn, qLook as qLookFn, qMul, qRotZ, v3 } from './vec';
import { withTailDrag } from './vehicles';

const OMEGA = EARTH_OMEGA;
const RE = EARTH_RADIUS;
const GEE = G0;
const D = DEG;
const slew = slewFn;
const spin = spinFn;
const stepBody = stepBodyFn;
const recordSample = recordSampleFn;
const enuAt = enuAtFn;
const ecefToInertial = ecefToInertialFn;
const qAxis = qAxisFn;
const qLook = qLookFn;

/** Largest predicted miss (m) for which the booster still attempts a landing burn at its recovery zone. */
const LANDING_ZONE_RADIUS = 40_000;
/** Largest predicted miss (m) after boostback that the grid fins can still steer into the tower's arms. */
const CATCH_REACH = 10_000;
/**
 * Most propellant (in dry masses) a booster may carry at boostback ignition and still come back to the
 * tower arms (nominal returns carry 2.3-3.1).
 */
const CATCH_PROP_BOOSTBACK = 3.5;
/** Catch window: the booster is taken by the arms only this close to the catch point and this steady. */
const CATCH_LATERAL = 2; // m off the arms' centre line
const CATCH_SPEED_H = 1; // m/s horizontal
const CATCH_SPEED_V = 2.5; // m/s descent
const CATCH_TILT = 3 * DEG; // from the vertical
/** Height above the catch point where the descent pauses until the booster is lined up within 1.5 m, m. */
const CATCH_HOLD = 4;
/**
 * Below this height above the catch point the booster holds its position over the arms (a critically
 * damped 2 s position loop) while its tilt allowance closes to the catch limit, m.
 */
const CATCH_ALIGN = 15;
/** Longest boostback burn, s (a guard: the guidance normally cuts off on the predicted impact). */
const BOOSTBACK_MAX = 120;
/** Propellant kept for the landing burn, as a fraction of the dry mass: the boostback never burns into it. */
const LANDING_RESERVE = 0.3;
/** Typical landing-burn ignition height above the aim point, m (used to aim the descent). */
const LB_HEIGHT = 2_000;
/** Landing reference table: 10 m steps up to 25 km. */
const REF_DH = 10;
const REF_N = 2500;

type Mode = 'hotstage' | 'flip' | 'boostback' | 'coast' | 'landing' | 'free' | 'held' | 'splashed' | 'done';

/** Super Heavy after separation: flip, boostback, descent with grid-fin steering, landing burn, end. */
export function runBooster(ctx: SimContext, body: Body, part: VehicleRt, tSep: number): void {
  const p = ctx.p;
  const plan = ctx.flight.plan.booster;
  const air = newAirData();
  const tb = ctx.boosterTrack;
  // Grid-fin azimuths, deg from +Z towards +X.
  const finAz = ctx.flight.generation === 'v3' ? [60, 180, 300] : [50, 130, 230, 310];
  const aero = [0, 0, 0, 0];
  const ex: SampleExtras = { phase: Phase.HotStage, heating: 0, aero, still: false };
  let recovery: BoosterRecovery = ctx.recovery;
  body.aero = withTailDrag(part.spec.aero, p.descentDrag);
  const tailCd = 1.1 * p.descentDrag;
  const target = ctx.boosterTarget(recovery, new Float64Array(3));
  /** Height of the booster base above the recovery point at the end of the landing burn. */
  const baseH = () => (recovery === 'catch' ? ctx.pad.catchBaseHeight : p.lbTargetH);

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

  const expend = recovery === 'expend';
  // A plan without a return (none flown so far) still gets the usual centre-and-inner-ring boostback when
  // the user chooses a recovery.
  const bbEngines = plan.boostbackEngines > 0 ? plan.boostbackEngines : 13;
  // The steering bias of the ascent does not carry over into the boostback (a later pitch command does).
  ctx.boosterPitchBias = 0;
  let bbPending = !expend;
  const bbIgnT = tSep + Math.max(1, p.bbDelay);
  let centreOn = true;
  const centreCutT = p.mecoCentre ? tSep + Math.max(0.3, p.centreCut) : expend ? tSep + 2 : Infinity;
  let bbCutT = Infinity;
  let bbStartT = Infinity;
  let landingPlanned = false;
  let landingStarted = false;
  let landingFailT = Infinity;
  let destroyT = Infinity;
  /** A landing-burn failure destroys the booster at this altitude (or at destroyT, whichever comes first). */
  let destroyAlt = -Infinity;
  let apogeeDone = false;
  let prevVr = 0;
  let lastPred = -Infinity;
  let predE = NaN;
  let predT = 0;
  let descentPredT = -Infinity;
  let cutT = Infinity;
  let splashT = 0;
  let heldUntil = 0;
  let lbSeg = 0;
  let attAcc = 0;
  let finalSet: number[] = [];
  const segAcc: number[] = [];
  const segSwitch: number[] = [];
  /** Engines lit in each landing set (the plan's, or more for a heavy booster). */
  const segN: number[] = [];
  const seq = plan.landingEngines.length > 0 ? plan.landingEngines : [13, 3];

  const up = v3(), east = v3(), north = v3(), xAx = v3(), yAx = v3(), zAx = v3(), dirH = v3(), d0 = v3(), thr = v3();
  const tgtI = v3(), hv = v3(), lat = v3(), tmp = v3(), tmp2 = v3(), vAirN = v3(), extra = v3();
  const qT = new Float64Array(4), qz = new Float64Array(4);
  const tip: TipState = newTipState();
  const arms: ArmsState = { r0: v3(), q0: new Float64Array(4), r1: v3(), q1: new Float64Array(4), t0: 0 };
  const pred: FlightOut = { impact: new Float64Array(3), impactVel: new Float64Array(3), impactT: 0, hit: false, apoAlt: 0 };
  let haveDir = false;
  const finLift = v3();
  const predDrag: DragTable = { table: part.spec.aero.caTail, scale: p.descentDrag, areaOverMass: 0 };
  const stepOpts = { extra: extra as Float64Array | null };

  const ev = () => eventState(body, 0, t);
  const record = (force: boolean) => {
    const fine = mode === 'flip' || mode === 'landing' || mode === 'hotstage' || mode === 'held' || mode === 'splashed' || t - tSep < 15;
    // Sparse only once the engines have stopped producing thrust (not while they tail off).
    const interval = fine ? 0.05 : air.alt > 100_000 && !part.producingThrust() ? 1 : 0.1;
    if (!force && t - lastRec < interval - 1e-9) return;
    ex.phase = phase;
    ex.heating = air.heating;
    ex.still = mode === 'held' || mode === 'splashed';
    recordSample(ctx, tb, scratchSample, t, body, part, 0, ex);
    lastRec = t;
    lastPhase = phase;
  };

  const finish = (kind: EndKind, at: number, destroyed: boolean, note?: string) => {
    ended = true;
    part.shutdownAll(at);
    ctx.events.push(makeEndEvent('booster', kind, at, ev(), note));
    ctx.boosterEnd = { kind, t: at };
    if (destroyed) {
      phase = Phase.Destroyed;
      record(true);
      mode = 'done';
    }
  };

  const failEngines = (list: number[], at: number) => {
    for (const i of list) if (i >= 0 && i < part.n && part.fail(i, at)) ctx.events.push(makeEngineOutEvent('booster', i, at, ev()));
  };

  /** Landing aim point for the CoM (ECEF): above the arms, or a few metres above the water. */
  const aimEcef = () => {
    const tl = Math.sqrt(target[0] * target[0] + target[1] * target[1] + target[2] * target[2]);
    const h = baseH() + part.com();
    for (let i = 0; i < 3; i++) tmp2[i] = target[i] * (1 + h / tl);
    return tmp2;
  };

  /**
   * Engines-off prediction (with drag) of where the booster ends up: down to about the landing-burn
   * height, then a straight line to the aim height (the landing burn brakes along the velocity
   * vector, so the path stays straight while it slows).
   */
  const predict = () => {
    const beta = body.mass / (tailCd * part.spec.aero.refArea);
    const aimAlt = Math.sqrt(target[0] * target[0] + target[1] * target[1] + target[2] * target[2]) - RE + baseH() + part.com();
    const hTop = Math.min(LB_HEIGHT, Math.max(0, air.alt - aimAlt - 50));
    predDrag.areaOverMass = part.spec.aero.refArea / body.mass;
    flyBallistic(body.r, body.v, t, 900, beta, Math.max(0, aimAlt + hTop), true, pred, 0, undefined, predDrag);
    if (hTop > 0 && pred.hit) {
      const im = pred.impact, iv = pred.impactVel;
      const rl = Math.sqrt(im[0] * im[0] + im[1] * im[1] + im[2] * im[2]);
      const vdn = Math.max(30, -(iv[0] * im[0] + iv[1] * im[1] + iv[2] * im[2]) / rl);
      const hIgn = segAcc.length > 0 ? Math.min(hTop, heightForSpeed(vdn)) : hTop;
      const drift = hTop / vdn;
      for (let i = 0; i < 3; i++) im[i] += (iv[i] + (vdn * im[i]) / rl) * drift;
      const k = (aimAlt + RE) / Math.sqrt(im[0] * im[0] + im[1] * im[1] + im[2] * im[2]);
      for (let i = 0; i < 3; i++) im[i] *= k;
      pred.impactT += (hTop - hIgn) / vdn + (segAcc.length > 0 ? tRef(hIgn) : (2 * hIgn) / vdn);
    }
    return pred;
  };

  /**
   * Landing reference: descent speed against height above the aim point, integrated upwards from a
   * standstill with the planned thrust of each engine set plus aerodynamic drag (the booster brakes
   * hard in the thick air, so a thrust-only profile would light the engines far too high).
   */
  const planLanding = () => {
    const m = body.mass;
    const fEng = engineThrustSl();
    const aimAlt = Math.sqrt(target[0] * target[0] + target[1] * target[1] + target[2] * target[2]) - RE + baseH() + part.com();
    let usable = 0;
    for (let i = 0; i < part.n; i++) if (part.usable(i)) usable++;
    segAcc.length = 0;
    segSwitch.length = 0;
    segN.length = 0;
    for (let j = 0; j < seq.length; j++) {
      const last = j === seq.length - 1;
      // A heavy booster (staged early, propellant left) lights more engines: enough for at least half the
      // braking the set gives at the usual landing mass (about twice the dry mass). The last set is sized
      // when it takes over (see finalCount).
      const aWant = Math.max(3, 0.5 * ((seq[j] * fEng * p.lbThrottle) / (2 * part.dry) - GEE));
      const n = last ? seq[j] : Math.max(seq[j], Math.min(usable, Math.ceil((m * (GEE + aWant)) / (fEng * p.lbThrottle))));
      segN.push(n);
      segAcc.push(last ? p.lbFinalAccel : Math.max(3, (n * fEng * p.lbThrottle) / m - GEE));
      // Hand-over speeds: the last set takes over at lbSwitch, a middle set at 1.8 × lbSwitch.
      if (!last) segSwitch.push(j === seq.length - 2 ? p.lbSwitch : 1.8 * p.lbSwitch);
    }
    const cdS = 0.6 * tailCd * part.spec.aero.refArea; // engines firing into the flow shield the base
    let v2 = 0;
    for (let k = 0; k < REF_N; k++) {
      refV[k] = Math.sqrt(v2);
      const v = refV[k];
      let j = segAcc.length - 1;
      while (j > 0 && v >= segSwitch[j - 1]) j--;
      const drag = (0.5 * airDensity(aimAlt + k * REF_DH) * v2 * cdS) / m;
      v2 += 2 * (segAcc[j] + drag) * REF_DH;
    }
    // Time left along the reference from each height down to the aim point.
    refT[0] = 0;
    for (let k = 1; k < REF_N; k++) refT[k] = refT[k - 1] + REF_DH / Math.max(0.3, 0.5 * (refV[k] + refV[k - 1]));
  };

  /** Sea-level thrust of one booster engine at full throttle, N. */
  const engineThrustSl = () => {
    const s0 = part.spec.specs[0];
    return s0.fVac - 101_325 * s0.exitArea;
  };

  /** Engines for the last landing set: the plan's, or enough to hold the booster's current weight with margin. */
  const finalCount = () => Math.max(seq[seq.length - 1], Math.ceil((1.2 * body.mass * GEE) / engineThrustSl()));

  /** Time remaining along the landing reference from height h. */
  const tRef = (h: number) => {
    const x = Math.max(0, h) / REF_DH;
    const k = Math.floor(x);
    if (k >= REF_N - 1) return refT[REF_N - 1];
    return refT[k] + (x - k) * (refT[k + 1] - refT[k]);
  };

  /** Height at which the landing reference reaches descent speed v (where the burn starts). */
  const heightForSpeed = (v: number) => {
    let lo = 0, hi = REF_N - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (refV[mid] < v) lo = mid;
      else hi = mid;
    }
    return hi * REF_DH;
  };

  /** Reference descent speed at height h above the aim point. */
  const vRef = (h: number) => {
    const x = Math.max(0, h) / REF_DH;
    const k = Math.floor(x);
    if (k >= REF_N - 1) return refV[REF_N - 1];
    return refV[k] + (x - k) * (refV[k + 1] - refV[k]);
  };
  const refV = new Float64Array(REF_N);
  const refT = new Float64Array(REF_N);

  const consumeSkip = (): boolean => {
    if (ctx.boosterSkips <= 0) return false;
    ctx.boosterSkips--;
    return true;
  };

  const applyAction = (a: Action) => {
    const at = a.t;
    if (a.iv) {
      const iv = a.iv;
      if (iv.kind === 'stage-now' || iv.vehicle !== 'booster') return;
      switch (iv.kind) {
        case 'engine-out':
          if (iv.engine >= 0 && iv.engine < part.n && part.fail(iv.engine, at)) {
            ctx.events.push(makeInterventionEvent('booster', at, ev(), `Engine shut down: ${engineName('booster', iv.engine)}`, 'ENGINE OUT'));
          }
          break;
        case 'throttle':
          part.ceiling = clamp(iv.value, 0.4, 1);
          ctx.events.push(makeInterventionEvent('booster', at, ev(), `Throttle limited to ${Math.round(part.ceiling * 100)}%`, 'THROTTLE'));
          break;
        case 'terminate':
          ctx.events.push(makeInterventionEvent('booster', at, ev(), 'Flight termination commanded', 'TERMINATE'));
          finish('termination', at, true);
          break;
        case 'pitch':
          ctx.boosterPitchBias = iv.deg;
          ctx.events.push(makeInterventionEvent('booster', at, ev(), `Steering bias ${iv.deg >= 0 ? '+' : ''}${iv.deg.toFixed(1)}°`, 'PITCH'));
          break;
        case 'skip-burn':
          ctx.boosterSkips++;
          ctx.events.push(makeInterventionEvent('booster', at, ev(), 'Next booster burn cancelled', 'SKIP BURN'));
          break;
      }
      return;
    }
    const an = a.anomaly;
    if (!an || an.vehicle !== 'booster') return;
    const idx = ctx.flight.anomalies.indexOf(an);
    switch (an.kind) {
      case 'engine-out': {
        const list = an.engines ?? pickFailingEngines('booster', part.state, (i) => part.isLit(i), an.count ?? 1, ctx.rng(idx));
        ctx.addEvent('anomaly', 'booster', at, ev(), an.note);
        failEngines(list, at);
        break;
      }
      case 'boostback-cut':
        ctx.addEvent('anomaly', 'booster', at, ev(), an.note);
        if (mode === 'boostback') bbCutT = at;
        else bbPending = false;
        break;
      case 'catch-abort':
        ctx.addEvent('anomaly', 'booster', at, ev(), an.note);
        recovery = 'splashdown';
        ctx.boosterTarget('splashdown', target);
        haveDir = false;
        predE = NaN;
        break;
      case 'breakup':
        ctx.addEvent('anomaly', 'booster', at, ev(), an.note);
        finish(lossKind(ctx, 'booster', 'breakup'), at, true);
        break;
      case 'fts':
        ctx.addEvent('anomaly', 'booster', at, ev(), an.note);
        finish(lossKind(ctx, 'booster', 'fts'), at, true);
        break;
      default:
        break;
    }
  };

  /** Predicted miss of the recovery point (engines off, with drag), m; Infinity if it does not come down. */
  const predictedMiss = () => {
    const pr = predict();
    const dx = pr.impact[0] - target[0], dy = pr.impact[1] - target[1], dz = pr.impact[2] - target[2];
    return pr.hit ? Math.sqrt(dx * dx + dy * dy + dz * dz) : Infinity;
  };

  const endBoostback = () => {
    part.shutdownAll(t);
    mode = 'coast';
    phase = Phase.Coast;
    bbCutT = Infinity;
    let miss = predictedMiss();
    let note: string | undefined;
    if (recovery === 'catch' && miss > CATCH_REACH) {
      // Short of the tower (a weak or cut boostback): divert to the Gulf rather than fall in unpowered.
      recovery = 'splashdown';
      ctx.boosterTarget('splashdown', target);
      miss = predictedMiss();
      note = 'Out of reach of the tower: diverting to a splashdown in the Gulf.';
    }
    ctx.addEvent('boostback-end', 'booster', t, ev(), note);
    landingPlanned = recovery !== 'expend' && miss < LANDING_ZONE_RADIUS;
  };

  part.throttle = p.hsCentreThrottle;
  for (let guard = 0; guard < 500_000 && !modeIs('done'); guard++) {
    while (actIdx < acts.length && acts[actIdx].t <= t + 1e-9 && !modeIs('done')) applyAction(acts[actIdx++]);
    if (modeIs('done')) break;

    // --- Scheduled transitions --------------------------------------------------------------
    if (centreOn && t >= centreCutT - 1e-9 && mode !== 'boostback' && mode !== 'landing') {
      centreOn = false;
      for (let i = 0; i < 3; i++) part.shutdown(i, t);
      if (p.mecoCentre) ctx.addEvent('meco', 'booster', t, ev());
    }
    if (mode === 'hotstage' && t >= tSep + 0.6) {
      mode = expend ? 'coast' : 'flip';
      phase = expend ? Phase.Coast : Phase.Flip;
    }
    if (mode === 'flip' && t >= bbIgnT - 1e-9) {
      centreOn = false;
      if (!bbPending || consumeSkip()) {
        bbPending = false;
        part.shutdownAll(t);
        mode = 'coast';
        phase = Phase.Coast;
      } else {
        // Staged early with propellant to spare, the booster would come back far too heavy for the tower
        // arms: the boostback aims for the Gulf instead.
        let note: string | undefined;
        if (recovery === 'catch' && part.prop > CATCH_PROP_BOOSTBACK * part.dry) {
          recovery = 'splashdown';
          ctx.boosterTarget('splashdown', target);
          note = 'Too heavy for the tower arms: heading for a splashdown in the Gulf.';
        }
        part.setEngines(selectBoosterEngines(bbEngines, (i) => part.usable(i)), t);
        part.throttle = p.bbThrottle;
        mode = 'boostback';
        phase = Phase.Boostback;
        bbStartT = t;
        ctx.addEvent('boostback', 'booster', t, ev(), note);
        ctx.armPhase('boostback', t);
      }
    }
    if (mode === 'boostback') {
      if (ctx.boosterSkips > 0 && consumeSkip()) bbCutT = t;
      // Guards: the landing burn's propellant is never spent on the boostback, and the burn has a time limit.
      if (part.prop <= LANDING_RESERVE * part.dry || t - bbStartT >= BOOSTBACK_MAX) bbCutT = t;
      if (t >= bbCutT - 1e-9 || !part.anyLit()) endBoostback();
    }
    if (t >= landingFailT) {
      failEngines(part.litEngines(), t);
      landingFailT = Infinity;
    }
    if (t >= destroyT || air.alt <= destroyAlt) {
      finish('lost', t, true);
      break;
    }
    if (mode === 'splashed' && t - splashT >= 8) {
      record(true);
      break;
    }
    if (mode === 'held' && t >= heldUntil) {
      record(true);
      break;
    }
    if (t >= cutT) {
      part.shutdownAll(t);
      cutT = Infinity;
      mode = 'free';
    }

    if (phase !== lastPhase) record(true);
    else record(false);

    // --- Time step ----------------------------------------------------------------------------
    let dt = mode === 'coast' && air.alt > 100_000 && !part.producingThrust() ? 0.2 : 0.02;
    let tNext = Math.min(centreOn ? centreCutT : Infinity, mode === 'flip' ? bbIgnT : Infinity, bbCutT, landingFailT, destroyT, cutT);
    if (actIdx < acts.length) tNext = Math.min(tNext, acts[actIdx].t);
    if (tNext > t + 1e-9 && tNext - t < dt) dt = tNext - t;

    if (mode === 'held') {
      t += dt;
      holdInArms(body, arms, t);
      continue;
    }
    if (mode === 'splashed') {
      t += dt;
      tipOver(body, tip, t);
      continue;
    }

    // --- Guidance and attitude ------------------------------------------------------------------
    enuAt(body.r, east, north, up);
    const vr = body.v[0] * up[0] + body.v[1] * up[1] + body.v[2] * up[2];
    if (!apogeeDone && t > tSep + 2 && prevVr > 0 && vr <= 0) {
      apogeeDone = true;
      ctx.addEvent('booster-apogee', 'booster', t, ev());
    }
    prevVr = vr;
    qAxis(xAx, body.q, 0);
    qAxis(yAx, body.q, 1);
    qAxis(zAx, body.q, 2);
    const va = air.vAir;
    const vaL = Math.sqrt(va[0] * va[0] + va[1] * va[1] + va[2] * va[2]);
    for (let i = 0; i < 3; i++) vAirN[i] = vaL > 1 ? va[i] / vaL : -up[i];
    extra[0] = extra[1] = extra[2] = 0;
    if ((mode === 'coast' || mode === 'free') && landingPlanned) extra.set(finLift);
    else finLift.fill(0);
    if (mode !== 'coast' && mode !== 'free') aero[0] = aero[1] = aero[2] = aero[3] = 0;

    if (mode === 'hotstage') {
      // The ship's plume pushes the booster back as the stages part.
      const k = 3 * Math.max(0, 1 - (t - tSep) / 1.5);
      for (let i = 0; i < 3; i++) extra[i] = -yAx[i] * k;
      spin(body, dt);
    } else if (mode === 'flip' || mode === 'boostback') {
      if (mode === 'boostback' && t - lastPred >= 0.5) {
        lastPred = t;
        predict();
        // Horizontal direction from the predicted impact point to the target (inertial frame).
        for (let i = 0; i < 3; i++) tmp[i] = target[i] - pred.impact[i];
        ecefToInertial(tmp, tmp, t);
        const k = tmp[0] * up[0] + tmp[1] * up[1] + tmp[2] * up[2];
        for (let i = 0; i < 3; i++) tmp[i] -= k * up[i];
        const dist = Math.sqrt(tmp[0] * tmp[0] + tmp[1] * tmp[1] + tmp[2] * tmp[2]);
        if (!haveDir) {
          for (let i = 0; i < 3; i++) d0[i] = tmp[i] / Math.max(1, dist);
          haveDir = true;
        }
        if (dist > 15_000) for (let i = 0; i < 3; i++) dirH[i] = tmp[i] / dist;
        // Along-track miss; extrapolate between predictions to cut off on target, allowing for tail-off.
        const e = tmp[0] * d0[0] + tmp[1] * d0[1] + tmp[2] * d0[2] + p.bbAim;
        if (!Number.isNaN(predE)) {
          const rate = (e - predE) / (t - predT);
          if (rate < 0) {
            const tc = t + (e + rate * 0.35) / -rate;
            if (tc <= t + 0.6) bbCutT = Math.max(t, tc);
          }
        }
        predE = e;
        predT = t;
      }
      if (!haveDir) {
        // Before the first prediction: thrust back uprange.
        const k = va[0] * up[0] + va[1] * up[1] + va[2] * up[2];
        for (let i = 0; i < 3; i++) tmp[i] = -(va[i] - k * up[i]);
        const l = Math.sqrt(tmp[0] * tmp[0] + tmp[1] * tmp[1] + tmp[2] * tmp[2]) || 1;
        for (let i = 0; i < 3; i++) dirH[i] = tmp[i] / l;
      }
      const el = (p.bbPitch + ctx.boosterPitchBias) * D;
      for (let i = 0; i < 3; i++) thr[i] = Math.cos(el) * dirH[i] + Math.sin(el) * up[i];
      qLook(qT, thr, zAx);
      const rate = p.flipRate * D;
      const errAng = slew(body, qT, rate, rate * 0.6, dt);
      // Boostback engines idle at minimum throttle until the flip is nearly complete.
      if (mode === 'boostback') part.throttle = errAng > 25 * D ? 0.4 : p.bbThrottle;
    } else if ((mode === 'coast' || mode === 'free') && (attAcc += dt) >= 0.1 - 1e-9) {
      // Engines first for the descent; grid fins steer the impact point onto the target (10 Hz).
      const adt = attAcc;
      attAcc = 0;
      aero[0] = aero[1] = aero[2] = aero[3] = 0;
      let tilt = 0;
      if (landingPlanned && air.alt < 70_000 && air.q > 500) {
        if (segAcc.length === 0) planLanding();
        if (t - descentPredT >= 1) {
          descentPredT = t;
          predict();
          for (let i = 0; i < 3; i++) tmp[i] = pred.impact[i] - target[i];
          ecefToInertial(lat, tmp, t);
          const k = lat[0] * up[0] + lat[1] * up[1] + lat[2] * up[2];
          const tgo = Math.max(5, pred.impactT - t);
          for (let i = 0; i < 3; i++) lat[i] = (-4 * (lat[i] - k * up[i])) / (tgo * tgo);
        }
        // Grid-fin lift: a lateral force across the airflow, at most ~0.2 of the drag (L/D of the fins).
        const kv = lat[0] * vAirN[0] + lat[1] * vAirN[1] + lat[2] * vAirN[2];
        for (let i = 0; i < 3; i++) hv[i] = lat[i] - kv * vAirN[i];
        let aL = Math.sqrt(hv[0] * hv[0] + hv[1] * hv[1] + hv[2] * hv[2]);
        const aMax = (0.2 * Math.sqrt(air.aero[0] ** 2 + air.aero[1] ** 2 + air.aero[2] ** 2)) / body.mass;
        if (aL > aMax) {
          for (let i = 0; i < 3; i++) hv[i] *= aMax / aL;
          aL = aMax;
        }
        finLift.set(hv);
        // The body leans slightly into the turn (visual; the force above is the fins').
        tilt = aMax > 0 ? (aL / aMax) * 3 * D : 0;
        for (let i = 0; i < 3; i++) thr[i] = -vAirN[i] * Math.cos(tilt) - (aL > 1e-9 ? (hv[i] / aL) * Math.sin(tilt) : 0);
        if (tilt > 0 && aL > 1e-9) {
          const tx = (hv[0] * xAx[0] + hv[1] * xAx[1] + hv[2] * xAx[2]) / aL;
          const tz = (hv[0] * zAx[0] + hv[1] * zAx[1] + hv[2] * zAx[2]) / aL;
          // Each fin pivots on its radial hinge; its share of the lateral force is the component of
          // the commanded direction along the fin's tangent (cos φ x̂ − sin φ ẑ).
          const share = aMax > 0 ? aL / aMax : 0;
          for (let k = 0; k < finAz.length; k++) {
            const az = finAz[k] * D;
            aero[k] = clamp(30 * share * (tx * Math.cos(az) - tz * Math.sin(az)), -30, 30);
          }
        }
      } else if (vaL < 30 && air.alt > 60_000) for (let i = 0; i < 3; i++) thr[i] = yAx[i];
      else for (let i = 0; i < 3; i++) thr[i] = -vAirN[i];
      qLook(qT, thr, zAx);
      slew(body, qT, 8 * D, 4 * D, adt);
      phase = mode === 'free' ? Phase.Descent : air.alt < 80_000 && vr < 0 ? Phase.Descent : Phase.Coast;
      // Landing-burn ignition from the stopping profile.
      if (landingPlanned && mode === 'coast' && vr < -50 && air.alt < 24_000) {
        if (segAcc.length === 0) planLanding();
        const aim = aimEcef();
        const hAbove = air.alt - (Math.sqrt(aim[0] * aim[0] + aim[1] * aim[1] + aim[2] * aim[2]) - RE);
        const vd = -vr;
        if (vd >= vRef(Math.max(0, hAbove - vd * 0.9))) {
          if (consumeSkip()) landingPlanned = false;
          else {
            part.setEngines(selectBoosterEngines(segN[0], (i) => part.usable(i)), t);
            if (!part.anyLit()) landingPlanned = false; // tanks dry: nothing to light
            else {
              part.throttle = 1;
              lbSeg = 0;
              landingStarted = true;
              mode = 'landing';
              phase = Phase.LandingBurn;
              ctx.addEvent('booster-landing-burn', 'booster', t, ev());
              ctx.armPhase('booster-landing-burn', t);
              if (ctx.boosterLandingFail) {
                const an = ctx.flight.anomalies.find((x) => x.kind === 'landing-burn-fail' && x.vehicle === 'booster');
                ctx.addEvent('anomaly', 'booster', t, ev(), an?.note);
                landingFailT = t + 0.4;
                // Lost where the catalog says, or a second after the engines fail.
                if (an?.alt !== undefined) {
                  destroyAlt = an.alt;
                  destroyT = t + 10;
                } else destroyT = t + 1;
              }
            }
          }
        }
      }
    } else if (mode === 'landing') {
      ecefToInertial(tgtI, aimEcef(), t);
      const hAbove = air.alt - (Math.sqrt(tgtI[0] * tgtI[0] + tgtI[1] * tgtI[1] + tgtI[2] * tgtI[2]) - RE);
      const vd = -vr;
      while (lbSeg < segSwitch.length && vd < segSwitch[lbSeg]) {
        lbSeg++;
        const last = lbSeg === segSwitch.length;
        part.setEngines(selectBoosterEngines(last ? finalCount() : segN[lbSeg], (i) => part.usable(i)), t);
        if (last) finalSet = part.litEngines();
      }
      // Track the reference: feed-forward deceleration scaled by how fast we actually descend (so a booster
      // that stalls above the aim point keeps settling instead of hovering), plus velocity feedback.
      tmp[0] = tgtI[0] - body.r[0];
      tmp[1] = tgtI[1] - body.r[1];
      tmp[2] = tgtI[2] - body.r[2];
      hv[0] = body.v[0] + OMEGA * body.r[1];
      hv[1] = body.v[1] - OMEGA * body.r[0];
      hv[2] = body.v[2];
      const kt = tmp[0] * up[0] + tmp[1] * up[1] + tmp[2] * up[2];
      const lateral = Math.sqrt(Math.max(0, tmp[0] * tmp[0] + tmp[1] * tmp[1] + tmp[2] * tmp[2] - kt * kt));
      let vDes = vRef(Math.max(0, hAbove));
      // Never descend faster than the engines actually lit can stop (failed engines, low ceiling).
      if (lbSeg === segSwitch.length) {
        const aStop = Math.max(0.5, 0.6 * ((part.litThrustPotential(air.pressure) * Math.min(1, part.ceiling)) / body.mass - GEE));
        vDes = Math.min(vDes, Math.sqrt(2 * aStop * Math.max(0, hAbove)) + 0.5);
      }
      // Catch: outside a cone above the arms, slow the descent so it pauses a few metres above them until
      // lined up.
      const hHold = hAbove - CATCH_HOLD;
      if (recovery === 'catch' && lateral > 1.5 + 0.4 * Math.max(0, hHold)) vDes = Math.min(vDes, 0.15 * Math.max(0, hHold));
      const aCmd = (segAcc[lbSeg] ?? p.lbFinalAccel) * clamp(vd / Math.max(vDes, 0.5), 0, 1.5) + 1.2 * (vd - vDes);
      // Horizontal: zero-effort-miss / zero-effort-velocity guidance onto the aim point. The time-to-go
      // floor keeps the final approach a well-damped position/velocity loop.
      const tgo = Math.max(6, tRef(Math.max(0, hAbove)));
      const kv = hv[0] * up[0] + hv[1] * up[1] + hv[2] * up[2];
      // Splashdown: position error clamped to what the lateral authority can still cover, so an unreachable
      // aim point never stops the burn from nulling the horizontal velocity.
      const reach = Math.max(5, 0.3 * 0.25 * GEE * tgo * tgo);
      const posK = recovery !== 'catch' && lateral > reach ? reach / lateral : 1;
      // Vertical thrust after drag (never pointing down), then a lateral part bounded by it.
      const m = body.mass;
      const fa = air.aero;
      const fUp = fa[0] * up[0] + fa[1] * up[1] + fa[2] * up[2];
      const tV = Math.max(0.05 * m * GEE, m * (GEE + aCmd) - fUp);
      // Vertical first: the divert only gets the thrust left over (and at most a ~20° tilt).
      const tAvail = 0.95 * part.litThrustPotential(air.pressure) * Math.min(1, part.ceiling);
      const tLat = Math.min(0.35 * tV, Math.sqrt(Math.max(0, tAvail * tAvail - tV * tV)));
      // Into the arms upright: the tilt allowed for the divert closes to the catch limit over the last 15 m.
      const tiltMax = recovery === 'catch' ? clamp(CATCH_TILT + ((hAbove - 1) / (CATCH_ALIGN - 1)) * (20 * D - CATCH_TILT), CATCH_TILT, 20 * D) : 20 * D;
      const ahMax = Math.min(15, tLat / m, (Math.tan(tiltMax) * tV) / m);
      if (hAbove > 400) {
        for (let i = 0; i < 3; i++) lat[i] = (6 * posK * (tmp[i] - kt * up[i]) - 4 * (hv[i] - kv * up[i]) * tgo) / (tgo * tgo);
      } else if (recovery === 'catch' && hAbove < CATCH_ALIGN) {
        // Lining up over the arms: a well-damped position loop, gentle enough for the attitude to follow.
        for (let i = 0; i < 3; i++) lat[i] = 0.25 * (tmp[i] - kt * up[i]) - (hv[i] - kv * up[i]);
      } else {
        // Final approach: fly a lateral speed that brakes to a stop over the aim point (no overshoot).
        const vMax = recovery === 'catch' ? Math.min(15, Math.sqrt(2 * 0.5 * 2.5 * lateral)) : 0;
        for (let i = 0; i < 3; i++) {
          const dirI = lateral > 0.5 ? (tmp[i] - kt * up[i]) / lateral : 0;
          lat[i] = 0.8 * (vMax * dirI - (hv[i] - kv * up[i]));
        }
      }
      const ahL = Math.sqrt(lat[0] * lat[0] + lat[1] * lat[1] + lat[2] * lat[2]);
      if (ahL > ahMax) for (let i = 0; i < 3; i++) lat[i] *= ahMax / ahL;
      for (let i = 0; i < 3; i++) thr[i] = m * lat[i] + tV * up[i];
      const need = Math.sqrt(thr[0] * thr[0] + thr[1] * thr[1] + thr[2] * thr[2]);
      if (lbSeg === segSwitch.length) part.throttleTo(need, air.pressure, t, finalSet, vd < 6);
      else {
        const fmax = part.litThrustPotential(air.pressure) * Math.min(1, part.ceiling);
        part.throttle = fmax > 0 ? need / fmax : 1;
      }
      qLook(qT, thr, zAx);
      slew(body, qT, 15 * D, 15 * D, dt);
      if (recovery === 'catch') {
        const vH = Math.sqrt(Math.max(0, hv[0] * hv[0] + hv[1] * hv[1] + hv[2] * hv[2] - kv * kv));
        const tilt = Math.acos(clamp(yAx[0] * up[0] + yAx[1] * up[1] + yAx[2] * up[2], -1, 1));
        if (hAbove < 1.2 && vd < CATCH_SPEED_V && vH < CATCH_SPEED_H && lateral < CATCH_LATERAL && tilt < CATCH_TILT) {
          // In the arms: engines off, and the arms take the weight and square the booster up.
          part.shutdownAll(t);
          startArms(arms, body, t);
          arms.r1.set(aimEcef());
          qLook(qT, up, zAx);
          qMul(arms.q1, qRotZ(qz, -OMEGA * t), qT);
          mode = 'held';
          phase = Phase.Caught;
          heldUntil = t + 5;
          finish('catch', t, false);
          record(true);
          continue;
        }
        if (hAbove < -3) cutT = t; // missed the arms
      } else if (hAbove < 0.6 || (vd < 1.5 && hAbove < 3)) cutT = t;
    }

    stepBody(body, dt, ctx.windPeak, air, stepOpts);
    t += dt;
    if (air.depleted) part.shutdownAll(t);

    // Contact with the sea or the ground (the launch site stands a few metres above the sea).
    qAxis(yAx, body.q, 1);
    const com = part.com();
    for (let i = 0; i < 3; i++) tmp[i] = body.r[i] - yAx[i] * com;
    const baseAlt = Math.sqrt(tmp[0] * tmp[0] + tmp[1] * tmp[1] + tmp[2] * tmp[2]) - RE;
    inertialToEcef(tmp2, tmp, t);
    const dpx = tmp2[0] - ctx.mountEcef[0], dpy = tmp2[1] - ctx.mountEcef[1], dpz = tmp2[2] - ctx.mountEcef[2];
    const nearPad = dpx * dpx + dpy * dpy + dpz * dpz < 3_000 * 3_000;
    if (baseAlt <= (nearPad ? ctx.pad.groundAlt : 0)) {
      const rl = Math.sqrt(tmp2[0] * tmp2[0] + tmp2[1] * tmp2[1] + tmp2[2] * tmp2[2]);
      const ashore = !nearPad && isLand((Math.asin(tmp2[2] / rl) * 180) / Math.PI, (Math.atan2(tmp2[1], tmp2[0]) * 180) / Math.PI);
      enuAt(body.r, east, north, up);
      const vRel = Math.sqrt((body.v[0] + OMEGA * body.r[1]) ** 2 + (body.v[1] - OMEGA * body.r[0]) ** 2 + body.v[2] ** 2);
      if (vRel < 15 && !nearPad && !ashore) {
        splashT = t;
        finish('splashdown', t, false);
        mode = 'splashed';
        phase = Phase.Splashed;
        startTip(tip, body, up, tmp, com, t);
        record(true);
      } else finish(landingStarted ? 'lost' : 'impact', t, true, ashore ? 'Came down on land.' : undefined);
      continue;
    }
    if (t - tSep > 1500) finish('lost', t, true);
  }
  if (!ended) ctx.boosterEnd = { kind: 'lost', t };
}
