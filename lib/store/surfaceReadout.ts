import { scenarioKey, sortInterventions } from '../sim/scenario';
import type { FlightResult, Intervention, Scenario, ShipFlap } from '../sim/types';
import { commandsUntil, emptyReading, readVehicle } from '../telemetry';
import { flapCommandAt, useReplay } from './replay';

export type SurfaceAngles = readonly [number | null, number | null, number | null, number | null];

export interface SurfaceSnapshot {
  readonly actual: SurfaceAngles;
  readonly commanded: SurfaceAngles;
  readonly roll: number | null;
  readonly status: 'ready' | 'ended' | 'updating' | 'unavailable';
}

export interface SurfaceReadoutStore {
  getSnapshot(): SurfaceSnapshot;
  getServerSnapshot(): SurfaceSnapshot;
  subscribe(listener: () => void): () => void;
}

const EMPTY: SurfaceSnapshot = { actual: [null, null, null, null], commanded: [null, null, null, null], roll: null, status: 'updating' };
const READOUT_INTERVAL = 100;

/**
 * Persistent sampler for an isolated readout. Clock-only updates run at most 10 Hz, including
 * the trailing seek/pause position. Result/scenario/flight/loading/error changes flush immediately:
 * an old result must never appear to answer a new command. Snapshots only change with visible values.
 * Creation and server snapshots have no subscriptions or timers; the last unsubscribe cleans up both.
 */
export function createSurfaceReadout(): SurfaceReadoutStore {
  const reading = emptyReading();
  let snapshot = EMPTY;
  let scenario: Scenario | null = null;
  let key = '';
  let ordered: Intervention[] = [];
  let result: FlightResult | null = null;
  let from = Infinity, until = -Infinity;
  let shownAt = -Infinity;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let unsubscribe: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const show = () => {
    globalThis.clearTimeout(timer);
    timer = undefined;
    shownAt = globalThis.performance.now();
    const s = useReplay.getState();
    if (scenario !== s.scenario) {
      scenario = s.scenario;
      key = scenarioKey(scenario);
      ordered = sortInterventions(scenario.interventions);
    }
    if (result !== s.result) {
      result = s.result;
      from = result?.separationT ?? Infinity;
      until = result ? commandsUntil(result, 'ship') : -Infinity;
    }
    // Scenario edits precede the worker/loading effect; check identity as well as loading.
    const matches = result !== null && result.flight === s.flight && result.scenarioKey === key;
    const status = s.error ? 'unavailable' : s.loading || !matches ? 'updating' : s.t >= until ? 'ended' : 'ready';
    const hasReading = matches && !s.loading && !s.error;
    if (hasReading && result) readVehicle(result, 'ship', s.t, reading);
    const actual: [number | null, number | null, number | null, number | null] = [null, null, null, null];
    const commanded: [number | null, number | null, number | null, number | null] = [null, null, null, null];
    for (let i = 0; i < 4; i++) {
      if (hasReading) {
        actual[i] = Number.isFinite(reading.aero[i]) ? Math.round(reading.aero[i] * 10) / 10 : null;
        commanded[i] = flapCommandAt(ordered, i as ShipFlap, s.t, from, until);
      }
    }
    const roll = hasReading && reading.roll !== null && Number.isFinite(reading.roll) ? Math.round(reading.roll * 10) / 10 : null;
    if (status === snapshot.status && roll === snapshot.roll &&
      actual.every((angle, i) => angle === snapshot.actual[i]) &&
      commanded.every((angle, i) => angle === snapshot.commanded[i])) return;
    snapshot = { actual, commanded, roll, status };
    listeners.forEach((listener) => listener());
  };

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribe) {
        unsubscribe = useReplay.subscribe((s, previous) => {
          if (s.result !== previous.result || s.scenario !== previous.scenario || s.flight !== previous.flight ||
            s.loading !== previous.loading || s.error !== previous.error) {
            show();
            return;
          }
          if (s.t === previous.t || timer !== undefined) return;
          const wait = shownAt + READOUT_INTERVAL - globalThis.performance.now();
          if (wait <= 0) show();
          else timer = globalThis.setTimeout(show, wait);
        });
        show();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || !unsubscribe) return;
        unsubscribe();
        unsubscribe = null;
        globalThis.clearTimeout(timer);
        timer = undefined;
      };
    },
  };
}
