import { describe, expect, it } from 'vitest';
import { FLIGHTS } from '../../flights/catalog';
import { simulateFlight } from '../simulate';

const NOMINAL = { asFlown: true, interventions: [] };

/**
 * Best of five runs (the JIT is warmed up first, as in a long-lived worker). The minimum is the
 * least noisy estimate when other test files share the CPU.
 */
function timeIt(flight: number): number {
  let best = Infinity;
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    simulateFlight(flight, NOMINAL);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('performance', () => {
  it('runs Flight 14 in under 150 ms and every other flight in under 80 ms', () => {
    for (const f of FLIGHTS) simulateFlight(f.n, NOMINAL); // warm-up
    const times: Record<number, number> = {};
    for (const f of FLIGHTS) times[f.n] = timeIt(f.n);
    console.log('simulation ms', Object.entries(times).map(([n, ms]) => `F${n} ${ms.toFixed(0)}`).join(', '));
    for (const f of FLIGHTS) expect(times[f.n], `Flight ${f.n}`).toBeLessThan(f.n === 14 ? 150 : 80);
  }, 120_000);

  it('keeps the longest result well under 10 MB', () => {
    const r = simulateFlight(14, NOMINAL);
    let bytes = 0;
    for (const tr of [r.booster, r.ship]) for (const v of Object.values(tr)) if (ArrayBuffer.isView(v)) bytes += v.byteLength;
    expect(bytes).toBeLessThan(6_000_000);
  });
});
