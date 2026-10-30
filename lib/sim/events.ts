import { engineName } from './engines';
import type { EndKind, EventKey, FlightEvent, VehicleId } from './types';

type Label = [label: string, short: string, major: boolean];

const LABELS: Record<Exclude<EventKey, 'booster-end' | 'ship-end' | 'intervention'>, Label> = {
  liftoff: ['Liftoff', 'LIFTOFF', true],
  maxq: ['Max Q', 'MAX Q', true],
  meco: ['Booster engine cutoff', 'MECO', true],
  staging: ['Stage separation', 'STAGE SEP', true],
  boostback: ['Boostback burn', 'BOOSTBACK', true],
  'boostback-end': ['Boostback shutdown', 'BOOSTBACK END', false],
  'booster-apogee': ['Booster apogee', 'BOOSTER APOGEE', false],
  'booster-landing-burn': ['Booster landing burn', 'BOOSTER LANDING BURN', true],
  seco: ['Ship engine cutoff', 'SECO', true],
  'ship-apogee': ['Apogee', 'APOGEE', true],
  'payload-start': ['Payload deploy', 'PAYLOAD DEPLOY', true],
  'payload-end': ['Payload deploy complete', 'DEPLOY END', false],
  relight: ['Raptor relight', 'RELIGHT', true],
  'orbit-insertion': ['Orbit insertion', 'ORBIT INSERTION', true],
  deorbit: ['Deorbit burn', 'DEORBIT BURN', true],
  entry: ['Entry', 'ENTRY', true],
  'peak-heating': ['Peak heating', 'PEAK HEATING', false],
  'ship-flip': ['Landing flip', 'FLIP', false],
  'ship-landing-burn': ['Landing burn', 'LANDING BURN', true],
  'engine-out': ['Engine out', 'ENGINE OUT', false],
  anomaly: ['Anomaly', 'ANOMALY', false],
};

function endLabel(vehicle: VehicleId, kind: EndKind): Label {
  if (kind === 'termination') return ['Flight termination', 'FTS', true];
  if (vehicle === 'booster') {
    switch (kind) {
      case 'catch':
        return ['Booster catch', 'BOOSTER CATCH', true];
      case 'splashdown':
        return ['Booster splashdown', 'BOOSTER SPLASHDOWN', true];
      case 'impact':
        return ['Booster impact', 'BOOSTER IMPACT', true];
      case 'orbit':
        return ['Booster in orbit', 'BOOSTER IN ORBIT', true];
      default:
        return ['Booster lost', 'BOOSTER LOST', true];
    }
  }
  switch (kind) {
    case 'splashdown':
      return ['Splashdown', 'SPLASHDOWN', true];
    case 'impact':
      return ['Ship impact', 'SHIP IMPACT', true];
    case 'orbit':
      // The simulated window ends with the ship still flying: nothing was lost.
      return ['Still in orbit', 'IN ORBIT', true];
    default:
      return ['Ship lost', 'SHIP LOST', true];
  }
}

export interface EventState {
  speed: number;
  alt: number;
  pos: [number, number, number];
}

export function makeEvent(
  key: Exclude<EventKey, 'booster-end' | 'ship-end' | 'intervention'>,
  vehicle: 'stack' | VehicleId,
  t: number,
  s: EventState,
  note?: string,
): FlightEvent {
  const [label, short, major] = LABELS[key];
  const e: FlightEvent = { t, key, vehicle, label, short, major, speed: s.speed, alt: s.alt, pos: s.pos };
  if (note) e.note = note;
  return e;
}

export function makeEndEvent(vehicle: VehicleId, kind: EndKind, t: number, s: EventState, note?: string): FlightEvent {
  const [label, short, major] = endLabel(vehicle, kind);
  const e: FlightEvent = { t, key: vehicle === 'booster' ? 'booster-end' : 'ship-end', vehicle, label, short, major, speed: s.speed, alt: s.alt, pos: s.pos };
  if (note) e.note = note;
  return e;
}

export function makeInterventionEvent(vehicle: 'stack' | VehicleId, t: number, s: EventState, label: string, short: string): FlightEvent {
  return { t, key: 'intervention', vehicle, label, short, major: true, speed: s.speed, alt: s.alt, pos: s.pos };
}

/** Stable sort by time (events created at the same time keep their creation order). */
export function sortEvents(events: FlightEvent[]): FlightEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.t - b.e.t || a.i - b.i)
    .map((x) => x.e);
}

export function makeEngineOutEvent(vehicle: VehicleId, engine: number, t: number, s: EventState): FlightEvent {
  return {
    t, key: 'engine-out', vehicle, label: 'Engine out', short: 'ENGINE OUT', major: false,
    speed: s.speed, alt: s.alt, pos: s.pos, note: engineName(vehicle, engine),
  };
}
