import { slew as slewFn, spin as spinFn } from './attitude';
import { bodyPointEcef, eventState, landingTargetEcef, recordSample as recordSampleFn, scratchSample, type Action, type SampleExtras, type SimContext } from './context';
import { engineName, pickFailingEngines } from './engines';
import { makeEndEvent, makeEngineOutEvent, makeInterventionEvent } from './events';
import { enuAt as enuAtFn, inertialToEcef } from './geo';
import { entryAoA, predictEntry, type EntryPrediction } from './guidance/entry';
import { newPeg, pegStep } from './guidance/peg';
import { planeHeading } from './guidance/plane';
import { lossKind } from './outcome';
import { SPOOL_DOWN, type Body, type VehicleRt } from './runtime';
import { coastBody, newAirData, stepBody as stepBodyFn } from './step';
import { FLAPS_STOWED } from './vehicles';
import { tipOver, type TipState } from './surface';
import { EARTH_MU, EARTH_OMEGA, EARTH_RADIUS, G0, Phase, type EndKind, type PhaseCode } from './types';
import { clamp, DEG, qAxis as qAxisFn, qLook as qLookFn, v3 } from './vec';

const OMEGA = EARTH_OMEGA;
const RE = EARTH_RADIUS;
const MU = EARTH_MU;
const GEE = G0;
const D = DEG;
const slew = slewFn;
const spin = spinFn;
const stepBody = stepBodyFn;
const recordSample = recordSampleFn;
const enuAt = enuAtFn;
const qAxis = qAxisFn;
const qLook = qLookFn;

/** Planned net deceleration of the ship's landing burn after the flip, m/s². */
const SHIP_LANDING_DECEL = 4;

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
  const aero = [FLAPS_STOWED, FLAPS_STOWED, FLAPS_STOWED, FLAPS_STOWED];
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
  if (orbital) {
    burns.push({ kind: 'insertion', t: plan.insertion?.t ?? NaN, duration: 120, done: false });
    burns.push({ kind: 'deorbit', t: plan.deorbit?.t ?? 7938, duration: 120, done: false });
  }
  let burn: Burn | null = null;
  let burnEnd = Infinity;
  let uncontrolled = false;
  let tumbleBuild = false;
  let apogeeDone = false;
  let prevVr = 1;
  let entryDone = false;
  let peakHeat = 0;
  let peakHeatT = 0;
  const peakR = v3(), peakV = v3();
  const pay = ctx.payload;
  const payOn = !!pay && !ctx.payloadDoorFail;
  let payIdx = 0;
  let payStarted = false;
  let payEnded = false;

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
  const tip: TipState = { up: v3(), dir: v3(), base: v3(), comH: 0, t0: 0 };

  const up = v3(), east = v3(), north = v3(), xAx = v3(), yAx = v3(), zAx = v3(), hd = v3(), thr = v3(), zr = v3();
  const hp = v3();
  const vn = v3(), tmp = v3(), tmp2 = v3(), rE = v3(), vE = v3();
  const qT = new Float64Array(4);
  const stepOpts = { extra: null };

  const ev = () => eventState(body, 0, t);
  const record = (force: boolean) => {
    const fine = mode === 'hotstage' || mode === 'flip' || mode === 'landing' || mode === 'splashed' || mode === 'free' || t - tSep < 10;
    const vac = air.alt > 100_000 && !part.anyLit();
    const interval = fine ? 0.05 : vac ? 2 : 0.1;
    if (!force && t - lastRec < interval - 1e-9) return;
    ex.phase = phase;
    ex.heating = air.heating;
    ex.still = mode === 'splashed';
    recordSample(ctx, tb, scratchSample, t, body, part, 0, ex);
    lastRec = t;
    lastPhase = phase;
  };

  const finish = (kind: EndKind, at: number, destroyed: boolean) => {
    ended = true;
    part.shutdownAll(at);
    ctx.events.push(makeEndEvent('ship', kind, at, ev()));
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
    if (a.iv) {
      const iv = a.iv;
      if (iv.kind === 'stage-now' || iv.vehicle !== 'ship') return;
      switch (iv.kind) {
        case 'engine-out':
          if (iv.engine >= 0 && iv.engine < part.n && part.usable(iv.engine)) {
            ctx.events.push(makeInterventionEvent('ship', at, ev(), `Engine shut down: ${engineName('ship', iv.engine)}`, 'ENGINE OUT'));
            failEngines([iv.engine], at);
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
      case 'relight-skip':
        ctx.addEvent('anomaly', 'ship', at, ev(), an.note);
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
    const sl = [0, 1, 2].filter((i) => part.usable(i));
    const vac = [3, 4, 5].filter((i) => part.usable(i));
    const set = b.kind === 'relight' ? sl.slice(0, 1) : vac.length > 0 ? vac : sl;
    if (set.length === 0) return;
    part.setEngines(set, t);
    part.throttle = b.kind === 'relight' ? p.relightThrottle : 0.6;
    burn = b;
    burnEnd = t + b.duration;
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

  part.throttle = 1;
  for (let guard = 0; guard < 2_000_000 && !modeIs('done'); guard++) {
    while (actIdx < acts.length && acts[actIdx].t <= t + 1e-9 && !modeIs('done')) applyAction(acts[actIdx++]);
    if (modeIs('done')) break;

    enuAt(body.r, east, north, up);
    const rl = Math.sqrt(body.r[0] ** 2 + body.r[1] ** 2 + body.r[2] ** 2);
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
      let done = t >= burnEnd - 1e-9 || !part.anyLit();
      // Insertion stops at the target perigee, capped just below the burn altitude (a prograde burn
      // cannot lift the perigee above the point where it is made); deorbit at the target perigee.
      if (active.kind === 'insertion' && apsisAlt(false) >= Math.min(p.insertionPerigee, air.alt - 3_000, apsisAlt(true) - 15_000)) done = true;
      if (active.kind === 'deorbit' && apsisAlt(false) <= p.deorbitPerigee) done = true;
      if (done) endBurn();
    }
    if (mode === 'coast' && !uncontrolled) {
      const b = nextBurn();
      if (b) {
        const bt = Number.isNaN(b.t) ? (vr < 25 && t > secoT + 120 ? t : Infinity) : b.t;
        if (t >= bt - 1e-9) startBurn(b);
      }
    }
    if (payOn && pay && mode !== 'ascent' && mode !== 'hotstage' && secoT > 0) {
      if (!payStarted && t >= pay.start - 1e-9) {
        payStarted = true;
        ctx.addEvent('payload-start', 'ship', t, ev());
      }
      const spacing = (pay.end - pay.start) / (pay.count + 1);
      while (payStarted && payIdx < pay.count && t >= pay.start + spacing * (payIdx + 1) - 1e-9) {
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
      }
      if (payStarted && !payEnded && t >= pay.end - 1e-9) {
        payEnded = true;
        ctx.addEvent('payload-end', 'ship', t, ev());
      }
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
    let tNext = Math.min(burnEnd, cutT, destroyT, landingFailT);
    if (actIdx < acts.length) tNext = Math.min(tNext, acts[actIdx].t);
    const nb = mode === 'coast' ? nextBurn() : null;
    if (nb && !Number.isNaN(nb.t)) tNext = Math.min(tNext, nb.t);
    if (nb && !Number.isNaN(nb.t) && nb.t - t < 90 && nb.t > t) dt = Math.min(dt, 0.5);
    if (payOn && pay && secoT > 0) {
      if (!payStarted) tNext = Math.min(tNext, pay.start);
      else if (payIdx < pay.count) tNext = Math.min(tNext, pay.start + ((pay.end - pay.start) / (pay.count + 1)) * (payIdx + 1));
      else if (!payEnded) tNext = Math.min(tNext, pay.end);
    }
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
      qAxis(xAx, body.q, 0);
      qAxis(zAx, body.q, 2);
      aero[0] = aero[1] = aero[2] = aero[3] = FLAPS_STOWED;
      // Horizontal direction of motion (inertial), for prograde attitudes.
      for (let i = 0; i < 3; i++) hd[i] = body.v[i] - vr * up[i];
      const hl = Math.sqrt(hd[0] * hd[0] + hd[1] * hd[1] + hd[2] * hd[2]) || 1;
      for (let i = 0; i < 3; i++) hd[i] /= hl;
      for (let i = 0; i < 3; i++) zr[i] = -up[i];
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
        qLook(qT, thr, zr);
        slew(body, qT, 4 * D, 2 * D, adt);
      }
      // Throttle: hold the acceleration limit.
      const fmax = part.maxThrust(air.pressure);
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
            rate = 2 * D;
          } else for (let i = 0; i < 3; i++) thr[i] = hd[i];
        }
        qLook(qT, thr, zr);
        slew(body, qT, rate, rate * 0.5, adt);
      }
    } else if (mode === 'entry') {
      const mach = air.mach;
      if (mach > 2.5 && air.alt < 115_000 && t - lastNpc >= 20) {
        lastNpc = t;
        npcCount++;
        // Predictor–corrector: Newton step on cos(bank) to null the along-track miss.
        const m0 = missAlong(body, t, part.spec.aero, p.entryAoA, cosBank, bankSign, landing, p.entryAim, predOut, tmp);
        if (npcCount === 1 || npcCount % 4 === 0 || dMiss <= 1000) {
          const dx = cosBank > 0.85 ? -0.15 : 0.15;
          const m1 = missAlong(body, t, part.spec.aero, p.entryAoA, cosBank + dx, bankSign, landing, p.entryAim, predOut, tmp);
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
        const cb = mach > 2 ? cosBank : 1; // wings level once slow
        entryAttitude(thr, zr, air.vAir, up, entryAoA(p.entryAoA, mach), cb, bankSign);
        qLook(qT, thr, zr);
        slew(body, qT, 6 * D, 4 * D, adt);
        // Flaps (0 = spread, +90 = folded leeward): entry trim plus a roll differential towards the bank
        // (left = +X side); the belly-flop flies them further out of the flow with a little differential.
        const roll = bankSign * Math.sqrt(1 - cb * cb) * 8;
        const fwd = phase === Phase.BellyFlop ? 32 : 18;
        const aft = phase === Phase.BellyFlop ? 42 : 22;
        aero[0] = fwd - roll;
        aero[1] = fwd + roll;
        aero[2] = aft + roll;
        aero[3] = aft - roll;
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
    } else if (mode === 'flip' || mode === 'landing') {
      const h = Math.max(0.1, air.alt - part.com());
      const vd = -vr;
      vn[0] = body.v[0] + OMEGA * body.r[1] - vr * up[0];
      vn[1] = body.v[1] - OMEGA * body.r[0] - vr * up[1];
      vn[2] = body.v[2] - vr * up[2];
      // Kill horizontal drift with a small tilt; track a constant-braking descent to the surface (feed-forward
      // scaled by the actual descent rate, so a ship that slows early keeps coming down instead of hovering).
      const vDes = Math.sqrt(2 * SHIP_LANDING_DECEL * h) + 1;
      const aReq = SHIP_LANDING_DECEL * clamp(vd / vDes, 0, 1.5) + 1.2 * (vd - vDes);
      const m = body.mass;
      const fUp = air.aero[0] * up[0] + air.aero[1] * up[1] + air.aero[2] * up[2];
      const tV = Math.max(0.05 * m * GEE, m * (GEE + aReq) - fUp);
      // Drift damping, bounded by the vertical thrust (tilt ≤ ~17°) so it can never take over.
      const vnL = Math.sqrt(vn[0] * vn[0] + vn[1] * vn[1] + vn[2] * vn[2]);
      const kLat = vnL > 1e-6 ? Math.min(0.4 * m, (0.3 * tV) / vnL) : 0;
      for (let i = 0; i < 3; i++) thr[i] = -kLat * vn[i] + tV * up[i];
      if (mode === 'flip') {
        for (let i = 0; i < 3; i++) thr[i] = up[i];
        part.throttle = 0.7;
      } else part.throttleTo(Math.sqrt(thr[0] ** 2 + thr[1] ** 2 + thr[2] ** 2), air.pressure, t, landingSet, vd < 3);
      qLook(qT, thr, zAx);
      const err = slew(body, qT, 25 * D, 20 * D, dt);
      if (mode === 'flip' && err < 12 * D) {
        mode = 'landing';
        phase = Phase.LandingBurn;
      }
      // Landing flip: forward flaps fold away, aft flaps stay out.
      aero[0] = aero[1] = 80;
      aero[2] = aero[3] = 15;
      if (mode === 'landing' && (h < 1 || (vd < 1 && h < 4))) cutT = t;
    } else if (mode === 'free') {
      spin(body, dt);
    }

    if (!powered && mode === 'coast' && air.alt > 140_000) {
      coastBody(body, dt, air);
      air.vAir[0] = body.v[0] + OMEGA * body.r[1];
      air.vAir[1] = body.v[1] - OMEGA * body.r[0];
      air.vAir[2] = body.v[2];
    } else stepBody(body, dt, ctx.windPeak, air, stepOpts);
    t += dt;
    if (air.depleted) part.shutdownAll(t);
    if (mode === 'entry' && air.heating > peakHeat) {
      peakHeat = air.heating;
      peakHeatT = t;
      peakR.set(body.r);
      peakV.set(body.v);
    }

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
        if (vRel < 15 && baseAlt <= nose) {
          enuAt(body.r, east, north, up);
          splashT = t;
          finish('splashdown', t, false);
          mode = 'splashed';
          phase = Phase.Splashed;
          const k = zAx[0] * up[0] + zAx[1] * up[1] + zAx[2] * up[2];
          for (let i = 0; i < 3; i++) tip.dir[i] = zAx[i] - k * up[i];
          tip.up.set(up);
          tip.base.set(tmp);
          tip.comH = com;
          tip.t0 = t;
          record(true);
        } else finish(landingStarted ? 'lost' : 'impact', t, true);
      }
    }
  }
  if (peakHeat > 0.05) {
    body.r.set(peakR);
    body.v.set(peakV);
    ctx.addEvent('peak-heating', 'ship', peakHeatT, eventState(body, 0, peakHeatT));
  }
  if (!ended) ctx.shipEnd = { kind: 'lost', t };
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

/** Predicted along-track overshoot (m, + = beyond the target) for a constant bank. */
function missAlong(body: Body, t: number, cfg: Body['aero'], aoa: number, cosBank: number, sign: number, target: Float64Array, aim: number, out: EntryPrediction, tmp: Float64Array): number {
  mr.set(body.r);
  mv.set(body.v);
  predictEntry(mr, mv, t, body.mass, cfg, aoa, cosBank, sign, out);
  // Direction of travel near the end ≈ from the current ground point to the predicted end point.
  inertialToEcef(tmp, body.r, t);
  const e = out.end;
  const dx = e[0] - target[0], dy = e[1] - target[1], dz = e[2] - target[2];
  const fx = e[0] - tmp[0], fy = e[1] - tmp[1], fz = e[2] - tmp[2];
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
  return (dx * fx + dy * fy + dz * fz) / fl + aim;
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

