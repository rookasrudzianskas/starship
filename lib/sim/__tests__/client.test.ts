import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scenarioKey } from '../scenario';
import type { Scenario } from '../types';

// No Worker in this environment: the client runs simulations in this thread, through the same queue.
const NOMINAL: Scenario = { asFlown: true, interventions: [] };
const windy = (wind: number): Scenario => ({ ...NOMINAL, wind });

let client: typeof import('../client');

beforeEach(async () => {
  vi.resetModules();
  client = await import('../client');
});

describe('runSimulation', () => {
  it('runs only the newest modified scenario; the ones it replaced reject with an AbortError', async () => {
    const { runSimulation } = client;
    const running = runSimulation(9, windy(5)); // starts at once
    const a = runSimulation(9, windy(10));
    const b = runSimulation(9, windy(20));
    const c = runSimulation(9, windy(30));
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    const [r0, r3] = await Promise.all([running, c]);
    expect(r0.scenarioKey).toBe(scenarioKey(windy(5)));
    expect(r3.scenarioKey).toBe(scenarioKey(windy(30)));
  });

  it('never drops a nominal run, and shares identical requests', async () => {
    const { runSimulation } = client;
    const first = runSimulation(9, windy(5));
    const nominal = runSimulation(2, NOMINAL);
    const again = runSimulation(2, { asFlown: true, interventions: [] });
    expect(again).toBe(nominal);
    const later = runSimulation(9, windy(40));
    const [, n, l] = await Promise.all([first, nominal, later]);
    expect(n.flight).toBe(2);
    expect(l.scenarioKey).toBe(scenarioKey(windy(40)));
    // Served from the cache afterwards.
    expect(await runSimulation(2, NOMINAL)).toBe(n);
  });
});
