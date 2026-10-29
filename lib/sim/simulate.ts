import { getFlight } from '../flights/catalog';
import { runBooster } from './booster';
import { SimContext } from './context';
import { sortEvents } from './events';
import { flightParams, type FlightParamOverrides } from './params';
import type { VehicleRt } from './runtime';
import { scenarioKey } from './scenario';
import { runShip } from './ship';
import { runStack } from './stack';
import { Phase, type EngineTimeline, type FlightEvent, type FlightResult, type PayloadRelease, type Scenario, type Track } from './types';

const T_START = -10;

function timeline(v: VehicleRt): EngineTimeline {
  const changes = v.changes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.t - b.c.t || a.i - b.i)
    .map((x) => ({ t: x.c.t, engine: x.c.engine, state: x.c.state }));
  return { slots: v.spec.slots.map((s) => ({ ...s })), changes };
}

function maxOf(a: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
}

/** Quiet stretches (> 4 min) with nothing powered, nothing in the atmosphere and no events. */
function computeCoasts(tracks: Track[], events: FlightEvent[], payload: PayloadRelease[], tStart: number, tEnd: number): Array<[number, number]> {
  const busy: Array<[number, number]> = [];
  for (const tr of tracks) {
    let open = -1;
    for (let i = 0; i < tr.n; i++) {
      const b = tr.phase[i] !== Phase.Coast || tr.alt[i] < 100_000 || tr.throttle[i] > 0;
      if (b && open < 0) open = tr.t[i];
      if (!b && open >= 0) {
        busy.push([open, tr.t[i]]);
        open = -1;
      }
    }
    if (open >= 0) busy.push([open, tr.end]);
  }
  for (const e of events) busy.push([e.t - 15, e.t + 15]);
  if (payload.length > 0) busy.push([payload[0].t - 15, payload[payload.length - 1].t + 15]);
  busy.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  let cursor = tStart;
  for (const [a, b] of busy) {
    if (a - cursor > 240) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (tEnd - cursor > 240) out.push([cursor, tEnd]);
  return out;
}

export interface SimOptions {
  /** Parameter overrides on top of the calibrated values (used by scripts/calibrate.ts). */
  params?: FlightParamOverrides;
  /** Skip the post-separation flight of one vehicle (calibration speed-ups). */
  skipBooster?: boolean;
  skipShip?: boolean;
}

export function simulateWithOptions(flightNumber: number, scenario: Scenario, opts: SimOptions = {}): FlightResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const flight = getFlight(flightNumber);
  const ctx = new SimContext(flight, scenario, flightParams(flight, opts.params));
  const stack = runStack(ctx);
  if (stack.boosterBody && stack.shipBody) {
    if (!opts.skipBooster) runBooster(ctx, stack.boosterBody, stack.booster, stack.t);
    if (!opts.skipShip) runShip(ctx, stack.shipBody, stack.ship, stack.t);
  } else if (stack.end) {
    ctx.boosterEnd = stack.end;
    ctx.shipEnd = stack.end;
  }
  const booster = ctx.boosterTrack.finish('booster', ctx.boosterEnd?.kind ?? 'lost');
  const ship = ctx.shipTrack.finish('ship', ctx.shipEnd?.kind ?? 'lost');
  const events = sortEvents(ctx.events);
  const tEnd = Math.max(booster.end, ship.end) + 10;
  return {
    flight: flight.n,
    scenarioKey: scenarioKey(scenario),
    launchUtc: Date.parse(flight.liftoffUtc),
    tStart: T_START,
    tEnd,
    separationT: ctx.separationT,
    booster,
    ship,
    boosterEngines: timeline(stack.booster),
    shipEngines: timeline(stack.ship),
    events,
    payload: ctx.releases,
    coasts: computeCoasts([booster, ship], events, ctx.releases, T_START, tEnd),
    records: {
      boosterTopSpeed: maxOf(booster.speed),
      boosterApogee: maxOf(booster.alt),
      shipTopSpeed: maxOf(ship.speed),
      shipApogee: maxOf(ship.alt),
    },
    computeMs: typeof performance !== 'undefined' ? performance.now() - t0 : 0,
  };
}

/** Runs one flight under a scenario. Pure and deterministic (apart from `computeMs`). */
export function simulateFlight(flight: number, scenario: Scenario): FlightResult {
  return simulateWithOptions(flight, scenario);
}
