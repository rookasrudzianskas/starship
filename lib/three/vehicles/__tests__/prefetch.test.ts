import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quality } from '../../contracts';

type Listener = (e: { data?: unknown }) => void;

/** Stand-in for the pixel worker: records the requests it gets and answers them when told to. */
class FakeWorker {
  static made: FakeWorker[] = [];
  posted: Array<{ key: string }> = [];
  terminated = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor() {
    FakeWorker.made.push(this);
  }

  addEventListener(type: string, l: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }

  postMessage(m: { key: string }): void {
    this.posted.push(m);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, e: { data?: unknown } = {}): void {
    for (const l of this.listeners.get(type) ?? []) l(e);
  }

  /** Answers every request so far with a tiny image. */
  answerAll(): void {
    for (const m of this.posted) this.emit('message', { data: { key: m.key, pixels: new Uint8Array(4) } });
  }
}

/** Whether `p` has settled once pending callbacks have run. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 0));
  return done;
}

// The worker and the pixel cache are module state: every test starts from a fresh copy of the module.
async function load() {
  const procedural = await import('../procedural');
  const pixels = await import('../pixels');
  return { ...procedural, steelPixelsKey: pixels.steelPixelsKey, PUFF_ATLAS_KEY: pixels.PUFF_ATLAS_KEY };
}

beforeEach(() => {
  vi.resetModules();
  FakeWorker.made = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prefetchGenerated (procedural pixels made in a worker)', () => {
  it('requests each image once however often it is called, and resolves every call', async () => {
    const m = await load();
    const calls = [m.prefetchGenerated(), m.prefetchGenerated('high'), m.prefetchGenerated('high'), m.prefetchGenerated()];
    expect(FakeWorker.made).toHaveLength(1);
    const w = FakeWorker.made[0];
    expect(w.posted.map((p) => p.key).sort()).toEqual([m.NOISE_KEY, m.PUFF_ATLAS_KEY, m.steelPixelsKey('high')].sort());
    expect(await settled(calls[0])).toBe(false);
    w.answerAll();
    for (const c of calls) expect(await settled(c)).toBe(true);
    // Cached now: nothing more is requested, and models use the worker's pixels.
    expect(await settled(m.prefetchGenerated('high'))).toBe(true);
    expect(w.posted).toHaveLength(3);
    const make = vi.fn(() => new Uint8Array(1));
    expect(m.generatedOnce(m.NOISE_KEY, make)).toHaveLength(4);
    expect(make).not.toHaveBeenCalled();
  });

  it('adds only the steel maps for another quality, and ignores values no model is built with', async () => {
    const m = await load();
    void m.prefetchGenerated('off' as Quality);
    const w = FakeWorker.made[0];
    expect(w.posted).toHaveLength(2);
    w.answerAll();
    const low = m.prefetchGenerated('low');
    expect(w.posted.map((p) => p.key).slice(2)).toEqual([m.steelPixelsKey('low')]);
    w.answerAll();
    expect(await settled(low)).toBe(true);
  });

  it('keeps pixels a model made on the main thread while the worker was busy', async () => {
    const m = await load();
    const p = m.prefetchGenerated();
    const mine = m.generatedOnce(m.NOISE_KEY, () => new Uint8Array(9));
    FakeWorker.made[0].answerAll();
    expect(await settled(p)).toBe(true);
    expect(m.generatedOnce(m.NOISE_KEY, () => new Uint8Array(1))).toBe(mine);
  });

  it('settles every waiter when the worker fails, then makes the pixels on the main thread', async () => {
    const m = await load();
    const p = m.prefetchGenerated('low');
    const w = FakeWorker.made[0];
    w.emit('error');
    expect(await settled(p)).toBe(true);
    expect(w.terminated).toBe(true);
    // No second worker is started; later calls resolve at once.
    expect(await settled(m.prefetchGenerated('high'))).toBe(true);
    expect(FakeWorker.made).toHaveLength(1);
    const make = vi.fn(() => new Uint8Array(1));
    m.generatedOnce(m.NOISE_KEY, make);
    expect(make).toHaveBeenCalledOnce();
  });

  it('resolves at once where workers are unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    const m = await load();
    expect(await settled(m.prefetchGenerated('high'))).toBe(true);
    expect(await settled(m.prefetchGenerated())).toBe(true);
  });
});
