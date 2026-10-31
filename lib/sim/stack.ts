import { slew as slewFn, spin as spinFn } from './attitude';
import { eventState, recordSample as recordSampleFn, scratchSample, type Action, type SampleExtras, type SimContext } from './context';
import { engineName, pickFailingEngines } from './engines';
import { makeEndEvent, makeEngineOutEvent, makeInterventionEvent } from './events';
import { ecefToInertial, enuAt as enuAtFn, latLonAltToEcef } from './geo';
import { Body, VehicleRt } from './runtime';
import { lossKind } from './outcome';
import { newAirData, stepBody as stepBodyFn } from './step';
import { EARTH_OMEGA, EARTH_RADIUS, G0, Phase, type EndKind, type PhaseCode } from './types';
import { planeHeading } from './guidance/plane';
import { FLAPS_STOWED, stackAero, vehicleSpec } from './vehicles';
import { clamp, DEG, qAxis as qAxisFn, qLook as qLookFn, qMul, qRotZ, v3 } from './vec';

export interface StackOutcome {
  booster: VehicleRt;
  ship: VehicleRt;
  boosterBody: Body | null;
  shipBody: Body | null;
  /** Separation time, or the time the stack was lost. */
  t: number;
  end: { kind: EndKind; t: number } | null;
  boosterLoad: number;
}

// Bind the frequently called helpers once, matching the post-separation guidance loops.
const slew = slewFn;
const spin = spinFn;
const recordSample = recordSampleFn;
const enuAt = enuAtFn;
const stepBody = stepBodyFn;
const qAxis = qAxisFn;
const qLook = qLookFn;

const ZERO4 = [0, 0, 0, 0];
const SHIP_FLAPS = [FLAPS_STOWED, FLAPS_STOWED, FLAPS_STOWED, FLAPS_STOWED];
/** Speed (m/s) at which the scheduled flight-path angle reaches its final value. */
const TURN_SPEED = 1500;
/** Exponent of the pitch-over reduction with the thrust shortfall (engine-out lofting). */
const LOFT = 3;
/** Dynamic pressure at which the attached stack breaks up, Pa (more than twice any flight's max Q). */
const Q_BREAKUP = 80_000;
/** Angle of attack times dynamic pressure the ascent accepts from winds, Pa·rad (150 kPa·deg). */
const QALPHA_MAX = 150_000 * DEG;
const OMEGA = EARTH_OMEGA;
const RE = EARTH_RADIUS;
const D = DEG;
const GEE = G0;
const PH_PAD = Phase.Pad;
const PH_ASCENT = Phase.Ascent;
const PH_HOTSTAGE = Phase.HotStage;
const PH_DESTROYED = Phase.Destroyed;

/** Pad, ascent and hot staging of the attached stack, up to physical separation (or loss). */
export function runStack(ctx: SimContext): StackOutcome {
  const p = ctx.p;
  const gen = ctx.flight.generation;
  const bSpec = vehicleSpec('booster', gen, ctx.hotStageRing);
  const sSpec = vehicleSpec('ship', gen);
  const bFull = Math.min(bSpec.propMass * 1.03, p.boosterProp);
  const bLoad = bFull * ctx.boosterLoad;
  const booster = new VehicleRt(bSpec, p.boosterDry, bLoad, 0, bFull);
  const payloadMass = ctx.payload ? ctx.payload.count * ctx.payload.unitMass : 0;
  const ship = new VehicleRt(sSpec, p.shipDry, Math.min(p.shipProp, sSpec.propMass * 1.05), payloadMass);
  const L = bSpec.length + sSpec.length;
  const body = new Body([booster, ship], stackAero(L), L);
  const air = newAirData();
  const pad = ctx.pad;

  const stackCom = () => (booster.mass * booster.com() + ship.mass * (bSpec.length + ship.com())) / (booster.mass + ship.mass);
  const offsets = () => {
    const h = stackCom();
    return [booster.com() - h, bSpec.length + ship.com() - h];
  };

  // Pad geometry: booster +Z faces the tower.
  const baseE = Float64Array.from(latLonAltToEcef(pad.lat, pad.lon, pad.groundAlt + pad.mountHeight));
  const towerE = v3();
  for (let i = 0; i < 3; i++) towerE[i] = pad.tower.east * ctx.padEast[i] + pad.tower.north * ctx.padNorth[i];
  const qPadE = new Float64Array(4);
  qLook(qPadE, ctx.padUp, towerE);
  const qz = new Float64Array(4);
  const rE = v3();
  const holdOnPad = (t: number) => {
    const h = stackCom();
    for (let i = 0; i < 3; i++) rE[i] = baseE[i] + ctx.padUp[i] * h;
    ecefToInertial(body.r, rE, t);
    body.v[0] = -OMEGA * body.r[1];
    body.v[1] = OMEGA * body.r[0];
    body.v[2] = 0;
    qMul(body.q, qRotZ(qz, OMEGA * t), qPadE);
    body.w[0] = 0;
    body.w[1] = 0;
    body.w[2] = OMEGA;
    body.acc[0] = -OMEGA * OMEGA * body.r[0];
    body.acc[1] = -OMEGA * OMEGA * body.r[1];
    body.acc[2] = 0;
  };

  // Raptor startup: centre, inner, outer, all at full thrust by T−0.5.
  const startup: Array<[number, number]> = [];
  for (let k = 0; k < 3; k++) startup.push([-3.5 + 0.05 * k, k]);
  for (let k = 0; k < 10; k++) startup.push([-3.0 + 0.05 * k, 3 + k]);
  for (let k = 0; k < 20; k++) startup.push([-2.5 + 0.025 * k, 13 + k]);
  const neverLit = new Set<number>();
  ctx.flight.anomalies.forEach((a, idx) => {
    if (!ctx.asFlown || a.kind !== 'no-ignition') return;
    const picks = a.engines ?? pickFailingEngines('booster', booster.state, () => true, a.count ?? 1, ctx.rng(idx));
    for (const i of picks) neverLit.add(i);
  });
  let startIdx = 0;

  let t = -10;
  let released = false;
  let hsStart: number | null = null;
  let shipIgnT = Infinity;
  let sepT = Infinity;
  let tumbling = false;
  let ftsFired = false;
  let end: { kind: EndKind; t: number } | null = null;
  let phase: PhaseCode = PH_PAD;
  let lastRec = -Infinity;
  let lastPhase = -1;
  let qMax = 0;
  let qMaxT = 0;
  const qMaxR = v3(), qMaxV = v3(), qMaxQ = new Float64Array(4), qMaxW = v3();
  let actIdx = 0;
  let attAcc = 0;
  const acts = ctx.actions;
  const stepOpts = { thrustScale: [1, 0.5], extra: null };
  const hP = v3();
  const zRef = v3(), thrDir = v3(), up = v3(), east = v3(), north = v3(), hA = v3(), hV = v3(), hW = v3(), tw = v3();
  const qT = new Float64Array(4);
  const xAx = v3();
  holdOnPad(t);

  const ex: SampleExtras = { phase, heating: 0, aero: ZERO4, still: true };
  const record = (force: boolean) => {
    const interval = phase === PH_HOTSTAGE || (t > sepT - 3 && t < sepT) ? 0.05 : 0.1;
    if (!force && t - lastRec < interval - 1e-9) return;
    const [bo, so] = offsets();
    ex.phase = phase;
    ex.heating = air.heating;
    ex.still = !released;
    recordSample(ctx, ctx.boosterTrack, scratchSample, t, body, booster, bo, ex);
    ex.aero = SHIP_FLAPS;
    recordSample(ctx, ctx.shipTrack, scratchSample, t, body, ship, so, ex);
    ex.aero = ZERO4;
    lastRec = t;
    lastPhase = phase;
  };

  const stackEvent = () => eventState(body, 0, t);

  const failEngines = (v: VehicleRt, list: number[], at: number) => {
    for (const i of list) {
      if (i >= 0 && i < v.n && v.fail(i, at)) ctx.events.push(makeEngineOutEvent(v.id, i, at, stackEvent()));
    }
  };

  const startHotStaging = (at: number) => {
    if (hsStart !== null) return;
    hsStart = at;
    for (let i = 3; i < booster.n; i++) booster.shutdown(i, at);
    booster.throttle = p.hsCentreThrottle;
    if (!p.mecoCentre) ctx.addEvent('meco', 'stack', at, stackEvent());
    shipIgnT = at + 1;
    sepT = at + Math.max(1.5, p.hsLead);
    phase = PH_HOTSTAGE;
  };

  /** Thrust the lit engines can deliver (user ceiling included) over the thrust the ascent plans, at most 1. */
  const thrustRatio = () => {
    const s0 = booster.spec.specs[0];
    const planned = Math.min(p.boosterThrottle * booster.n * (s0.fVac - air.pressure * s0.exitArea), p.stackGLimit * GEE * body.mass);
    const avail = booster.litThrustPotential(air.pressure) * Math.min(1, booster.ceiling);
    return planned > 0 && avail < planned ? avail / planned : 1;
  };

  const endStack = (kind: EndKind, at: number) => {
    end = { kind, t: at };
    phase = PH_DESTROYED;
    booster.shutdownAll(at);
    ship.shutdownAll(at);
  };

  const applyAction = (a: Action) => {
    const at = a.t;
    if (a.iv) {
      const iv = a.iv;
      const s = stackEvent();
      switch (iv.kind) {
        case 'engine-out': {
          const v = iv.vehicle === 'booster' ? booster : ship;
          // The intervention event is the callout; no separate engine-out event.
          if (iv.engine >= 0 && iv.engine < v.n && v.fail(iv.engine, at)) {
            ctx.events.push(makeInterventionEvent(iv.vehicle, at, s, `Engine shut down: ${engineName(iv.vehicle, iv.engine)}`, 'ENGINE OUT'));
          }
          break;
        }
        case 'throttle': {
          const v = iv.vehicle === 'booster' ? booster : ship;
          v.ceiling = clamp(iv.value, 0.4, 1);
          ctx.events.push(makeInterventionEvent(iv.vehicle, at, s, `Throttle limited to ${Math.round(v.ceiling * 100)}%`, 'THROTTLE'));
          break;
        }
        case 'terminate':
          ctx.events.push(makeInterventionEvent('stack', at, s, 'Flight termination commanded', 'TERMINATE'));
          endStack('termination', at);
          break;
        case 'stage-now':
          if (at > 0 && hsStart === null) {
            ctx.events.push(makeInterventionEvent('stack', at, s, 'Hot staging commanded', 'STAGE NOW'));
            startHotStaging(at);
          }
          break;
        case 'pitch':
          if (iv.vehicle === 'booster') ctx.boosterPitchBias = iv.deg;
          else ctx.shipPitchBias = iv.deg;
          ctx.events.push(makeInterventionEvent(iv.vehicle, at, s, `Steering bias ${iv.deg >= 0 ? '+' : ''}${iv.deg.toFixed(1)}°`, 'PITCH'));
          break;
        case 'skip-burn':
          if (iv.vehicle === 'booster') ctx.boosterSkips++;
          else ctx.shipSkips++;
          ctx.events.push(makeInterventionEvent(iv.vehicle, at, s, iv.vehicle === 'booster' ? 'Next booster burn cancelled' : 'Next ship burn cancelled', 'SKIP BURN'));
          break;
      }
      return;
    }
    const an = a.anomaly;
    if (!an) return;
    const idx = ctx.flight.anomalies.indexOf(an);
    const s = stackEvent();
    const evVehicle = an.vehicle;
    switch (an.kind) {
      case 'no-ignition':
        ctx.addEvent('anomaly', 'booster', at, s, an.note);
        break;
      case 'engine-out': {
        const v = an.vehicle === 'ship' ? ship : booster;
        const list = an.engines ?? pickFailingEngines(v.id, v.state, (i) => v.isLit(i), an.count ?? 1, ctx.rng(idx));
        ctx.addEvent('anomaly', evVehicle, at, s, an.note);
        failEngines(v, list, at);
        break;
      }
      case 'no-separation':
        ctx.addEvent('anomaly', 'stack', at, s, an.note);
        break;
      case 'tumble':
        ctx.addEvent('anomaly', evVehicle, at, s, an.note);
        tumbling = true;
        break;
      case 'fts': {
        const later = ctx.flight.anomalies.some((b) => b.kind === 'breakup' && b.t > an.t && (b.vehicle === an.vehicle || b.vehicle === 'stack' || an.vehicle === 'stack'));
        ctx.addEvent('anomaly', evVehicle, at, s, an.note);
        if (later) {
          ftsFired = true;
          booster.shutdownAll(at);
          ship.shutdownAll(at);
        } else endStack(lossKind(ctx, 'booster', 'fts'), at);
        break;
      }
      case 'breakup':
        ctx.addEvent('anomaly', evVehicle, at, s, an.note);
        endStack(lossKind(ctx, 'booster', 'breakup'), at);
        break;
      default:
        // Anomalies of later phases are handled by the booster and ship loops.
        break;
    }
  };

  for (let guard = 0; guard < 200_000; guard++) {
    // Actions due now (stack-phase actions: everything before separation).
    while (actIdx < acts.length && acts[actIdx].t <= t + 1e-9 && acts[actIdx].t < sepT) applyAction(acts[actIdx++]);
    if (end) break;
    while (startIdx < startup.length && startup[startIdx][0] <= t + 1e-9) {
      const [ts, i] = startup[startIdx++];
      if (neverLit.has(i)) failEngines(booster, [i], ts);
      else if (booster.usable(i)) booster.ignite(i, ts);
    }
    if (t >= shipIgnT - 1e-9) {
      for (let i = 0; i < 3; i++) if (ship.usable(i)) ship.ignite(i, shipIgnT);
      ship.throttle = 1;
      shipIgnT = Infinity;
    }
    if (t >= sepT - 1e-9) break;
    if (phase !== lastPhase) record(true);
    else record(false);

    // Time step: land exactly on scheduled times.
    let dt = t < 0 ? 0.025 : 0.02;
    let tNext = Math.min(sepT, shipIgnT, actIdx < acts.length ? acts[actIdx].t : Infinity);
    if (t < 0) tNext = Math.min(tNext, 0, startIdx < startup.length ? startup[startIdx][0] : Infinity);
    if (tNext - t < dt && tNext > t + 1e-9) dt = tNext - t;

    if (!released) {
      // Held down on the mount until T+0 and until thrust exceeds weight.
      booster.burn(dt);
      booster.spoolStep(dt);
      ship.spoolStep(dt);
      const thrust = booster.thrust(air.pressure);
      if (t >= -1e-9 && thrust > body.mass * GEE * 1.02) {
        released = true;
        phase = PH_ASCENT;
        ctx.addEvent('liftoff', 'stack', t, stackEvent());
      } else {
        t += dt;
        if (Math.abs(t) < 1e-9) t = 0;
        holdOnPad(t);
        if (t > 30) {
          endStack('lost', t);
          break;
        }
        continue;
      }
    }

    // Guidance (attitude at 10 Hz, throttle every step).
    attAcc += dt;
    const attDue = attAcc >= 0.1 - 1e-9 || hsStart !== null;
    const adt = attAcc;
    if (attDue) attAcc = 0;
    if (!tumbling && attDue) {
      enuAt(body.r, east, north, up);
      const az = p.azimuth * D;
      for (let i = 0; i < 3; i++) hA[i] = Math.sin(az) * east[i] + Math.cos(az) * north[i];
      // The schedule flies the Earth-relative velocity (the ground track); the air-relative velocity only
      // sets the angle-of-attack limit, so a jet stream changes the loads rather than the whole ascent.
      const vg = air.vGround;
      const vUp = vg[0] * up[0] + vg[1] * up[1] + vg[2] * up[2];
      for (let i = 0; i < 3; i++) hV[i] = vg[i] - vUp * up[i];
      const vh = Math.sqrt(hV[0] * hV[0] + hV[1] * hV[1] + hV[2] * hV[2]);
      // Steering plane: launch azimuth until the horizontal velocity is established, then the velocity
      // azimuth; once fast, the target orbital plane, with yaw nulling the inertial out-of-plane velocity
      // (otherwise the Coriolis drift of a pure gravity turn tilts the orbit).
      const w = clamp((vh - 5) / 25, 0, 1);
      for (let i = 0; i < 3; i++) hV[i] = vh > 1e-6 ? hV[i] / vh : hA[i];
      for (let i = 0; i < 3; i++) hA[i] = (1 - w) * hA[i] + w * hV[i];
      const wp = clamp((Math.sqrt(vh * vh + vUp * vUp) - 350) / 400, 0, 1);
      if (wp > 0) {
        const n = ctx.planeNormal;
        planeHeading(hP, n, up, body.v);
        for (let i = 0; i < 3; i++) hA[i] = (1 - wp) * hA[i] + wp * hP[i];
      }
      const hl = Math.sqrt(hA[0] * hA[0] + hA[1] * hA[1] + hA[2] * hA[2]) || 1;
      for (let i = 0; i < 3; i++) hA[i] /= hl;
      // Flight-path angle scheduled against speed (90° → gammaEnd at TURN_SPEED), tracked by steering
      // the thrust off the velocity vector within an angle-of-attack limit that tightens with q.
      let el = 90 * D;
      const V = Math.sqrt(vh * vh + vUp * vUp);
      if (t >= p.tPitch && V > 20) {
        const gam = Math.atan2(vUp, vh);
        const sp = Math.min(1, V / TURN_SPEED);
        const bias = hsStart === null ? ctx.boosterPitchBias : 0;
        // Short of planned thrust (more engines out than the rest can make up for, or a throttle limit),
        // the pitch-over is held back: the same schedule would bend a slower stack down into thick air.
        const loft = hsStart === null ? thrustRatio() ** LOFT : 1;
        const gRef = (90 - (90 - p.gammaEnd) * Math.pow(sp, p.turnShape) * loft + bias) * D;
        const aMax = (air.q >= 20_000 ? 3 : air.q <= 2_000 ? 10 : 10 - (7 * (air.q - 2_000)) / 18_000) * D;
        el = clamp(gam - 2.5 * (gam - gRef), gam - aMax, gam + aMax);
        // Against the actual airflow a wind may add angle of attack, up to the structure's q·α limit.
        const va = air.vAir;
        const vaUp = va[0] * up[0] + va[1] * up[1] + va[2] * up[2];
        for (let i = 0; i < 3; i++) hW[i] = va[i] - vaUp * up[i];
        const gAir = Math.atan2(vaUp, Math.sqrt(hW[0] * hW[0] + hW[1] * hW[1] + hW[2] * hW[2]));
        const aAir = Math.max(aMax, Math.min(10 * D, QALPHA_MAX / Math.max(air.q, 1)));
        el = clamp(clamp(el, gAir - aAir, gAir + aAir), -10 * D, 90 * D);
      }
      for (let i = 0; i < 3; i++) thrDir[i] = Math.sin(el) * up[i] + Math.cos(el) * hA[i];
      // Roll: from facing the tower to belly-down (+Z opposite the downrange direction).
      ecefToInertial(tw, towerE, t);
      const rs = clamp((t - 2) / 10, 0, 1);
      const rb = rs * rs * (3 - 2 * rs);
      const twl = Math.sqrt(tw[0] * tw[0] + tw[1] * tw[1] + tw[2] * tw[2]) || 1;
      for (let i = 0; i < 3; i++) zRef[i] = (1 - rb) * (tw[i] / twl) - rb * hA[i];
      if (hsStart === null) {
        qLook(qT, thrDir, zRef);
        slew(body, qT, 5 * D, 2 * D, adt);
      } else spin(body, adt);
    } else if (tumbling) {
      // Thrust vector control lost: the stack cartwheels about its pitch axis.
      qAxis(xAx, body.q, 0);
      const wl = Math.sqrt(body.w[0] * body.w[0] + body.w[1] * body.w[1] + body.w[2] * body.w[2]);
      if (wl < p.tumbleRate * D) for (let i = 0; i < 3; i++) body.w[i] += xAx[i] * 3 * D * dt;
      spin(body, dt);
    }
    if (hsStart === null) {
      let thr = p.boosterThrottle;
      const d = Math.abs(t - p.bucketT);
      if (d < p.bucketWidth) thr *= 1 - p.bucketDepth * 0.5 * (1 + Math.cos((Math.PI * d) / p.bucketWidth));
      // Engine-out compensation: the engines still running throttle up to restore the planned thrust.
      const lit = booster.litTotal();
      if (lit > 0 && lit < booster.n) thr *= booster.n / lit;
      const fmax = booster.fullThrust(air.pressure);
      if (fmax > 0) thr = Math.min(thr, (p.stackGLimit * GEE * body.mass) / fmax);
      booster.throttle = thr;
    }
    // The attached ship's plume mostly hits the hot-staging ring (thrustScale 0.5).
    stepBody(body, dt, ctx.windPeak, air, stepOpts);
    t += dt;
    if (air.q > qMax && hsStart === null) {
      qMax = air.q;
      qMaxT = t;
      qMaxR.set(body.r);
      qMaxV.set(body.v);
      qMaxQ.set(body.q);
      qMaxW.set(body.w);
    }
    if (air.depleted) booster.shutdownAll(t);
    if (air.q > Q_BREAKUP) {
      ctx.addEvent('anomaly', 'stack', t, stackEvent(), 'Aerodynamic loads exceed what the structure can take; the stack breaks up.');
      endStack('lost', t);
      break;
    }

    // Staging trigger: booster propellant down to its return reserve.
    if (hsStart === null && !ctx.noSeparation && !ftsFired && booster.prop <= p.stageReserve * bLoad) startHotStaging(t);

    // Ground contact.
    qAxis(xAx, body.q, 1);
    const h = stackCom();
    const bx = body.r[0] - xAx[0] * h, by = body.r[1] - xAx[1] * h, bz = body.r[2] - xAx[2] * h;
    const baseAlt = Math.sqrt(bx * bx + by * by + bz * bz) - RE;
    if (t > 3 && (baseAlt < 0 || Math.sqrt(body.r[0] * body.r[0] + body.r[1] * body.r[1] + body.r[2] * body.r[2]) - RE < 0)) {
      endStack('impact', t);
      break;
    }
    if (t > 900) {
      endStack('lost', t);
      break;
    }
  }

  if (qMax > 1000) {
    const snap = new Body([], body.aero, L);
    snap.r.set(qMaxR);
    snap.v.set(qMaxV);
    snap.q.set(qMaxQ);
    snap.w.set(qMaxW);
    ctx.addEvent('maxq', 'stack', qMaxT, eventState(snap, 0, qMaxT));
  }

  if (end) {
    record(true);
    const e = end as { kind: EndKind; t: number };
    const [bo, so] = offsets();
    ctx.events.push(makeEndEvent('booster', e.kind, e.t, eventState(body, bo, e.t)));
    ctx.events.push(makeEndEvent('ship', e.kind, e.t, eventState(body, so, e.t)));
    return { booster, ship, boosterBody: null, shipBody: null, t: e.t, end: e, boosterLoad: bLoad };
  }

  // Physical separation: each vehicle continues from its own CoM with the stack's motion.
  phase = PH_HOTSTAGE;
  record(true);
  ctx.separationT = t;
  ctx.addEvent('staging', 'stack', t, stackEvent());
  const [bo, so] = offsets();
  const make = (part: VehicleRt, off: number, len: number) => {
    const b = new Body([part], part.spec.aero, len);
    const y = v3();
    qAxis(y, body.q, 1);
    for (let i = 0; i < 3; i++) b.r[i] = body.r[i] + y[i] * off;
    const ox = y[0] * off, oy = y[1] * off, oz = y[2] * off;
    const w = body.w;
    b.v[0] = body.v[0] + (w[1] * oz - w[2] * oy);
    b.v[1] = body.v[1] + (w[2] * ox - w[0] * oz);
    b.v[2] = body.v[2] + (w[0] * oy - w[1] * ox);
    b.q.set(body.q);
    b.w.set(body.w);
    b.acc.set(body.acc);
    return b;
  };
  return {
    booster,
    ship,
    boosterBody: make(booster, bo, bSpec.length),
    shipBody: make(ship, so, sSpec.length),
    t,
    end: null,
    boosterLoad: bLoad,
  };
}
