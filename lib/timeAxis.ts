/**
 * Piecewise-linear mapping between flight time and a 0..1 position on the timeline, giving each long
 * coast a fixed small width so the busy parts of a three-hour flight stay readable.
 */
export interface TimeAxis {
  tStart: number;
  tEnd: number;
  toX(t: number): number;
  toT(x: number): number;
  /** Centres (0..1) of compressed coasts, for break marks. */
  breaks: number[];
}

interface Segment {
  t0: number;
  t1: number;
  v0: number;
  v1: number;
}

export function buildTimeAxis(tStart: number, tEnd: number, coasts: Array<[number, number]>): TimeAxis {
  const quiet = coasts
    .map(([a, b]) => [Math.max(a, tStart), Math.min(b, tEnd)] as [number, number])
    .filter(([a, b]) => b - a > 60)
    .sort((p, q) => p[0] - q[0]);

  let busy = tEnd - tStart;
  for (const [a, b] of quiet) busy -= b - a;
  const coastWidth = Math.max(30, busy * 0.07);

  const segs: Segment[] = [];
  let v = 0;
  let cur = tStart;
  for (const [a, b] of quiet) {
    if (a > cur) {
      segs.push({ t0: cur, t1: a, v0: v, v1: v + (a - cur) });
      v += a - cur;
    }
    segs.push({ t0: a, t1: b, v0: v, v1: v + coastWidth });
    v += coastWidth;
    cur = b;
  }
  if (tEnd > cur || segs.length === 0) {
    segs.push({ t0: cur, t1: Math.max(tEnd, cur + 1), v0: v, v1: v + Math.max(tEnd - cur, 1) });
    v += Math.max(tEnd - cur, 1);
  }
  const total = v;
  const breaks = quiet.map(([a, b]) => {
    const s = segs.find((g) => g.t0 === a && g.t1 === b);
    return s ? (s.v0 + s.v1) / 2 / total : 0;
  });

  return {
    tStart,
    tEnd,
    breaks,
    toX(t) {
      if (t <= tStart) return 0;
      if (t >= tEnd) return 1;
      for (const s of segs) {
        if (t <= s.t1) return (s.v0 + ((t - s.t0) / (s.t1 - s.t0)) * (s.v1 - s.v0)) / total;
      }
      return 1;
    },
    toT(x) {
      const vv = Math.min(1, Math.max(0, x)) * total;
      for (const s of segs) {
        if (vv <= s.v1) return s.t0 + ((vv - s.v0) / (s.v1 - s.v0)) * (s.t1 - s.t0);
      }
      return tEnd;
    },
  };
}
