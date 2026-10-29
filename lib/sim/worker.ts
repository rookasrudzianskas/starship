/**
 * Module worker: runs simulations off the main thread. Request `{ id, flight, scenario }`, response
 * `{ id, result }` with every Track column transferred (not copied), or `{ id, error }`.
 */
import { simulateFlight } from './simulate';
import type { FlightResult, Scenario, Track } from './types';

export interface SimRequest {
  id: number;
  flight: number;
  scenario: Scenario;
}

export type SimResponse = { id: number; result: FlightResult } | { id: number; error: string };

/** The parts of the dedicated-worker global scope we use (avoids pulling in the webworker lib types). */
interface WorkerScope {
  onmessage: ((e: MessageEvent<SimRequest>) => void) | null;
  postMessage(message: SimResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

function collectBuffers(track: Track, out: Transferable[]): void {
  for (const a of [track.t, track.pos, track.vel, track.quat, track.com, track.alt, track.speed, track.vspeed, track.accel, track.mach, track.q, track.pitch, track.aoa, track.throttle, track.lox, track.ch4, track.heating, track.aero, track.phase]) {
    out.push(a.buffer as ArrayBuffer);
  }
}

scope.onmessage = (e: MessageEvent<SimRequest>) => {
  const { id, flight, scenario } = e.data;
  try {
    const result = simulateFlight(flight, scenario);
    const transfer: Transferable[] = [];
    collectBuffers(result.booster, transfer);
    collectBuffers(result.ship, transfer);
    scope.postMessage({ id, result }, transfer);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }, []);
  }
};
