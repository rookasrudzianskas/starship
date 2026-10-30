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
  // Flights 5 and 10 bring their vehicles down in the water and in the tower's arms.
  const flights = [simulateFlight(5, AS_FLOWN), simulateFlight(10, AS_FLOWN)];
  const vehicles: [FlightResult, VehicleId][] = flights.flatMap((r) => [
    [r, 'booster'],
    [r, 'ship'],
  ]);

  it('stop when the vehicle comes down, not when its track ends', () => {
    let tails = 0;
    for (const [r, vehicle] of vehicles) {
      const end = endEvent(r, vehicle);
      expect(takesCommands(r, vehicle, end - 1)).toBe(true);
      expect(takesCommands(r, vehicle, end)).toBe(false);
      expect(takesCommands(r, vehicle, r[vehicle].end)).toBe(false);
      expect(end - lastCommand(r, vehicle)).toBeLessThan(0.05);
      // Tipping over in the water or held in the arms, the track goes on for a few seconds after the flight is over.
      if (r[vehicle].end > end + 1) {
        tails++;
        expect(takesCommands(r, vehicle, (end + r[vehicle].end) / 2)).toBe(false);
      }
    }
    expect(tails).toBeGreaterThan(0);
  });

  it('reach the vehicle up to the last moment they can be given', () => {
    // A touchdown is found at the end of a simulation step, up to a step after the vehicle came down, and a command
    // in between would come too late: the last one the director sends must still arrive.
    for (const [r, vehicle] of vehicles) {
      const t = lastCommand(r, vehicle);
      const run = simulateFlight(r.flight, { asFlown: true, interventions: [{ id: 'x', t, kind: 'throttle', vehicle, value: 0.9 }] });
      expect(run.events.some((e) => e.key === 'intervention' && e.vehicle === vehicle)).toBe(true);
    }
  });

  it('start from the beginning of the replay before it', () => {
    expect(takesCommands(flights[0], 'booster', flights[0].tStart - 30)).toBe(true);
    expect(commandTimeOf(12.3456)).toBe(12.346);
  });
});
