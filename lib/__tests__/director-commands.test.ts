import { describe, expect, it } from 'vitest';
import { simulateFlight } from '../sim/simulate';
import type { FlightResult, VehicleId } from '../sim/types';
import { AS_FLOWN, commandTimeOf, takesCommands } from '../store/replay';
import { commandsUntil } from '../telemetry';

const endEvent = (r: FlightResult, vehicle: VehicleId) => r.events.find((e) => e.key === `${vehicle}-end`)?.t ?? NaN;

/** The last whole millisecond at which the flight director still sends a command to the vehicle. */
function lastCommand(r: FlightResult, vehicle: VehicleId): number {
  let t = commandTimeOf(commandsUntil(r, vehicle));
  while (!takesCommands(r, vehicle, t)) t = commandTimeOf(t - 0.001);
  return t;
}

describe('flight director commands', () => {
  // Flight 5: the booster is caught, the ship splashes down. Flight 13: the booster splashes down.
  const flight5 = simulateFlight(5, AS_FLOWN);
  const flight13 = simulateFlight(13, AS_FLOWN);
  const cases: [FlightResult, VehicleId][] = [
    [flight5, 'booster'],
    [flight5, 'ship'],
    [flight13, 'booster'],
  ];

  it('stop when the vehicle comes down, not when its track ends', () => {
    for (const [r, vehicle] of cases) {
      const end = endEvent(r, vehicle);
      // In the arms or tipping over in the water the track goes on for a few seconds.
      expect(r[vehicle].end).toBeGreaterThan(end + 4);
      expect(takesCommands(r, vehicle, end - 1)).toBe(true);
      expect(takesCommands(r, vehicle, end)).toBe(false);
      expect(takesCommands(r, vehicle, (end + r[vehicle].end) / 2)).toBe(false);
      expect(end - lastCommand(r, vehicle)).toBeLessThan(0.05);
    }
  });

  it('reach the vehicle up to the last moment they can be given', () => {
    // A splashdown is found at the end of a simulation step, up to a step after the water was reached (Flight 13's
    // booster: between 0.01 and 0.02 s), and a command in between would come too late.
    const t = lastCommand(flight13, 'booster');
    const run = simulateFlight(13, { asFlown: true, interventions: [{ id: 'x', t, kind: 'throttle', vehicle: 'booster', value: 0.9 }] });
    expect(run.events.some((e) => e.key === 'intervention' && e.vehicle === 'booster')).toBe(true);
  });

  it('start from the beginning of the replay before it', () => {
    expect(takesCommands(flight5, 'booster', flight5.tStart - 30)).toBe(true);
    expect(commandTimeOf(12.3456)).toBe(12.346);
  });
});
