import { describe, expect, it } from 'vitest';
import { simulateFlight } from '../simulate';
import type { FlightResult, Scenario } from '../types';

/** Everything except the wall-clock diagnostics, with typed arrays as plain arrays. */
function canonical(r: FlightResult): string {
  return JSON.stringify({ ...r, computeMs: 0 }, (_k, v: unknown) =>
    ArrayBuffer.isView(v) && !(v instanceof DataView) ? Array.from(v as unknown as ArrayLike<number>) : v,
  );
}

describe('determinism', () => {
  it('produces byte-identical results for the same input', () => {
    const s: Scenario = {
      asFlown: true,
      wind: 35,
      interventions: [
        { id: 'a', t: 45, kind: 'engine-out', vehicle: 'booster', engine: 20 },
        { id: 'b', t: 300, kind: 'throttle', vehicle: 'ship', value: 0.7 },
      ],
    };
    const a = canonical(simulateFlight(12, s));
    const b = canonical(simulateFlight(12, { ...s, interventions: [...s.interventions].reverse() }));
    expect(a).toBe(b);
    expect(canonical(simulateFlight(3, { asFlown: true, interventions: [] }))).toBe(
      canonical(simulateFlight(3, { asFlown: true, interventions: [] })),
    );
  });
});
