/**
 * Main-thread entry point: runs simulations in a module worker, caches the last few results (LRU) and
 * shares in-flight requests. Falls back to running in the calling thread when workers are unavailable.
 */
import { scenarioKey } from './scenario';
import type { FlightResult, Scenario } from './types';
import type { SimRequest, SimResponse } from './worker';

const CACHE_SIZE = 8;
const cache = new Map<string, FlightResult>(); // insertion order = least recently used first
const inflight = new Map<string, Promise<FlightResult>>();
const waiting = new Map<number, { resolve: (r: FlightResult) => void; reject: (e: Error) => void }>();
let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;

class WorkerUnavailable extends Error {}

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<SimResponse>) => {
      const msg = e.data;
      const cb = waiting.get(msg.id);
      if (!cb) return;
      waiting.delete(msg.id);
      if ('result' in msg) cb.resolve(msg.result);
      else cb.reject(new Error(msg.error));
    };
    w.onerror = () => {
      // The worker failed to load or crashed: run everything in this thread from now on.
      workerBroken = true;
      worker = null;
      w.terminate();
      for (const cb of waiting.values()) cb.reject(new WorkerUnavailable('simulation worker failed'));
      waiting.clear();
    };
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

function viaWorker(w: Worker, flight: number, scenario: Scenario): Promise<FlightResult> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    const req: SimRequest = { id, flight, scenario };
    w.postMessage(req);
  });
}

async function compute(flight: number, scenario: Scenario): Promise<FlightResult> {
  const w = getWorker();
  if (w) {
    try {
      return await viaWorker(w, flight, scenario);
    } catch (err) {
      if (!(err instanceof WorkerUnavailable)) throw err;
    }
  }
  const { simulateFlight } = await import('./simulate');
  return simulateFlight(flight, scenario);
}

function remember(key: string, result: FlightResult): void {
  cache.delete(key);
  cache.set(key, result);
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Simulates `flight` under `scenario`. Identical requests share one computation, and recent results
 * are served from the cache. The returned result is shared: treat it as read-only.
 */
export function runSimulation(flight: number, scenario: Scenario): Promise<FlightResult> {
  const key = `${flight}:${scenarioKey(scenario)}`;
  const hit = cache.get(key);
  if (hit) {
    remember(key, hit);
    return Promise.resolve(hit);
  }
  const running = inflight.get(key);
  if (running) return running;
  const p = compute(flight, scenario).then(
    (result) => {
      inflight.delete(key);
      remember(key, result);
      return result;
    },
    (err: unknown) => {
      inflight.delete(key);
      throw err;
    },
  );
  inflight.set(key, p);
  return p;
}
