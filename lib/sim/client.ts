/**
 * Main-thread entry point: runs simulations in a module worker, one at a time, caches recent results
 * (LRU) and shares in-flight requests. Falls back to running in the calling thread when workers are
 * unavailable.
 *
 * Latest wins: the Flight director re-simulates on every change, so while the worker is busy only the
 * newest modified scenario waits for it. A modified scenario still waiting when a newer one arrives is
 * dropped and its promise rejects with an AbortError (the page that asked for it has moved on).
 * Nominal (as-flown, unmodified) runs are shared by every page and are always computed.
 */
import { NOMINAL_SCENARIO, type FlightResult, type Scenario } from './types';
import { scenarioKey } from './scenario';
import type { SimRequest, SimResponse } from './worker';

/** Results kept: room for every flight's nominal run (the Compare page) plus a few modified ones. */
const CACHE_SIZE = 20;
const NOMINAL_KEY = scenarioKey(NOMINAL_SCENARIO);

interface Job {
  key: string;
  flight: number;
  scenario: Scenario;
  nominal: boolean;
  /** A newer modified scenario replaced this one: its result is not worth caching. */
  superseded: boolean;
  resolve: (r: FlightResult) => void;
  reject: (e: unknown) => void;
}

const cache = new Map<string, FlightResult>(); // insertion order = least recently used first
const inflight = new Map<string, Promise<FlightResult>>();
const queue: Job[] = [];
let running: Job | null = null;
let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
/** Id of the request the worker is computing (its reply settles `running`). */
let runningId = 0;

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<SimResponse>) => {
      const msg = e.data;
      const job = running;
      if (!job || msg.id !== runningId) return;
      if ('result' in msg) settle(job, msg.result, null);
      else settle(job, null, new Error(msg.error));
    };
    w.onerror = () => {
      // The worker failed to load or crashed: run everything in this thread from now on.
      workerBroken = true;
      worker = null;
      w.terminate();
      const job = running;
      if (job) {
        running = null;
        queue.unshift(job);
      }
      pump();
    };
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

function settle(job: Job, result: FlightResult | null, err: unknown): void {
  running = null;
  inflight.delete(job.key);
  if (result) {
    if (!job.superseded) remember(job.key, result);
    job.resolve(result);
  } else job.reject(err);
  pump();
}

/** Starts the next waiting job when nothing is running. */
function pump(): void {
  if (running || queue.length === 0) return;
  const job = queue.shift() as Job;
  running = job;
  const w = getWorker();
  if (w) {
    runningId = nextId++;
    const req: SimRequest = { id: runningId, flight: job.flight, scenario: job.scenario };
    w.postMessage(req);
    return;
  }
  import('./simulate')
    .then(({ simulateFlight }) => settle(job, simulateFlight(job.flight, job.scenario), null))
    .catch((err: unknown) => settle(job, null, err));
}

function remember(key: string, result: FlightResult): void {
  cache.delete(key);
  cache.set(key, result);
  if (cache.size <= CACHE_SIZE) return;
  // Evict the least recently used modified result first: nominal runs are the ones every page asks for.
  let victim: string | undefined;
  for (const k of cache.keys()) {
    if (!k.endsWith(`:${NOMINAL_KEY}`)) {
      victim = k;
      break;
    }
  }
  cache.delete(victim ?? (cache.keys().next().value as string));
}

function abortError(): Error {
  return typeof DOMException !== 'undefined' ? new DOMException('Superseded by a newer scenario', 'AbortError') : Object.assign(new Error('Superseded by a newer scenario'), { name: 'AbortError' });
}

/**
 * Simulates `flight` under `scenario`. Identical requests share one computation, and recent results
 * are served from the cache. The returned result is shared: treat it as read-only. A modified scenario
 * may reject with an AbortError when a newer modified scenario replaces it before it starts.
 */
export function runSimulation(flight: number, scenario: Scenario): Promise<FlightResult> {
  const sKey = scenarioKey(scenario);
  const key = `${flight}:${sKey}`;
  const nominal = sKey === NOMINAL_KEY;
  const hit = cache.get(key);
  if (hit) {
    remember(key, hit);
    return Promise.resolve(hit);
  }
  const shared = inflight.get(key);
  if (shared) {
    if (running?.key === key) running.superseded = false; // wanted again after all
    return shared;
  }
  if (!nominal) {
    // Latest wins: drop modified scenarios still waiting, and do not cache the one running.
    for (let i = queue.length - 1; i >= 0; i--) {
      const old = queue[i];
      if (old.nominal) continue;
      queue.splice(i, 1);
      inflight.delete(old.key);
      old.reject(abortError());
    }
    if (running && !running.nominal) running.superseded = true;
  }
  const p = new Promise<FlightResult>((resolve, reject) => {
    queue.push({ key, flight, scenario, nominal, superseded: false, resolve, reject });
  });
  inflight.set(key, p);
  pump();
  return p;
}
