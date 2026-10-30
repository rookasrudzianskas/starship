import { describe, expect, it } from 'vitest';
import { ResolutionGovernor } from '../resolution';

/** A WebGL2 context stand-in: optionally a timer extension whose queries report the next of `gpuMs`. */
function fakeGl(gpuMs: number[] | null): WebGL2RenderingContext {
  const ext = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
  const results = new Map<object, number>();
  const gl = {
    CURRENT_QUERY: 0x8865,
    QUERY_RESULT: 0x8866,
    QUERY_RESULT_AVAILABLE: 0x8867,
    getExtension: () => (gpuMs ? ext : null),
    getQuery: () => null,
    createQuery: () => ({}),
    deleteQuery: () => undefined,
    beginQuery: (_: number, q: object) => results.set(q, (gpuMs?.shift() ?? 0) * 1e6),
    endQuery: () => undefined,
    getQueryParameter: (q: object, p: number) => (p === gl.QUERY_RESULT_AVAILABLE ? true : results.get(q)),
    getParameter: () => false,
  };
  return gl as unknown as WebGL2RenderingContext;
}

/**
 * Run `n` frames whose cost (frame interval, or GPU time when `gpu` is given) is `ms` at a pixel ratio of 2 and
 * scales with the number of pixels, as a fill-bound scene's would. Returns the pixel ratios after each change.
 */
function frames(g: ResolutionGovernor, clock: { now: number }, n: number, ms: number, opts: { playing?: boolean; gpu?: number[]; fixed?: boolean } = {}): number[] {
  const changes: number[] = [];
  for (let i = 0; i < n; i++) {
    const cost = opts.fixed ? ms : ms * (g.ratio / 2) ** 2;
    if (opts.gpu) opts.gpu.push(cost);
    clock.now += opts.gpu ? 16.7 : Math.max(16.7, cost);
    g.begin();
    if (g.end(clock.now, opts.playing ?? true)) changes.push(g.ratio);
  }
  return changes;
}

describe('ResolutionGovernor without GPU timing', () => {
  it('steps down when playback frames are slow, and keeps the step that made them fast enough', () => {
    const g = new ResolutionGovernor(fakeGl(null));
    g.setBase(2);
    const clock = { now: 0 };
    expect(g.ratio).toBe(2);
    expect(frames(g, clock, 100, 16)).toEqual([]);
    // 30 ms at 2 is 17 ms at 1.5: one step and it stays there.
    expect(frames(g, clock, 300, 30)).toEqual([1.5]);
    expect(g.ratio).toBe(1.5);
  });

  it('undoes a step that did not help, and then leaves the resolution alone for a while', () => {
    const g = new ResolutionGovernor(fakeGl(null));
    g.setBase(2);
    const clock = { now: 0 };
    // Slow whatever the resolution (the time goes elsewhere): one try, undone, then nothing for 30 s.
    expect(frames(g, clock, 100, 30, { fixed: true })).toEqual([1.5, 2]);
    expect(frames(g, clock, 900, 30, { fixed: true })).toEqual([]);
    expect(frames(g, clock, 200, 30, { fixed: true })).toEqual([1.5, 2]);
  });

  it('ignores paused frames (redrawn on demand, so their spacing means nothing)', () => {
    const g = new ResolutionGovernor(fakeGl(null));
    g.setBase(2);
    const clock = { now: 0 };
    expect(frames(g, clock, 300, 40, { playing: false })).toEqual([]);
    expect(g.ratio).toBe(2);
  });

  it('tries the finer resolution again once frames are comfortably fast', () => {
    const g = new ResolutionGovernor(fakeGl(null));
    g.setBase(2);
    const clock = { now: 0 };
    expect(frames(g, clock, 100, 30)).toEqual([1.5]);
    // A lighter scene (12 ms at 2): after the hold a fast window steps back up, and stays.
    expect(frames(g, clock, 600, 12)).toEqual([2]);
    expect(g.ratio).toBe(2);
  });

  it('never goes below 0.75 device pixels per CSS pixel', () => {
    const g = new ResolutionGovernor(fakeGl(null));
    g.setBase(1);
    const clock = { now: 0 };
    expect(frames(g, clock, 300, 200)).toEqual([0.75]);
    expect(g.ratio).toBe(0.75);
  });
});

describe('ResolutionGovernor with GPU timing', () => {
  it('steps down when the GPU time stays over budget and back up with headroom', () => {
    const gpu: number[] = [];
    const g = new ResolutionGovernor(fakeGl(gpu));
    g.setBase(2);
    const clock = { now: 0 };
    expect(frames(g, clock, 100, 8, { gpu })).toEqual([]);
    // 15 ms at 2 is 8.4 ms at 1.5, too close to the budget to go back up.
    expect(frames(g, clock, 600, 15, { gpu })).toEqual([1.5]);
    // A lighter scene: back to full resolution after the hold.
    expect(frames(g, clock, 600, 5, { gpu })).toEqual([2]);
    // A very heavy one goes down two steps.
    expect(frames(g, clock, 600, 40, { gpu })).toEqual([1.5, 1]);
  });

  it('times frames during pauses too (GPU time does not depend on frame spacing)', () => {
    const gpu: number[] = [];
    const g = new ResolutionGovernor(fakeGl(gpu));
    g.setBase(2);
    const clock = { now: 0 };
    expect(frames(g, clock, 100, 20, { gpu, playing: false })).toEqual([1.5]);
  });
});
