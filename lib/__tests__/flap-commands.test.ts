import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalScenario, interventionSignature, normalizeFlapCommand, scenarioKey, sortInterventions } from '../sim/scenario';
import type { FlightResult, Intervention, Scenario, ShipFlap } from '../sim/types';
import { AS_FLOWN, flapCommandAt, takesFlapCommands, useReplay, type NewIntervention } from '../store/replay';
import { decodeScenario, encodeScenario, linkOf, readRunLink, runLinkSearch } from '../store/runLink';

const initial = useReplay.getInitialState();
// Only the availability boundaries matter here; physics is tested by the simulation suite.
const result = {
  tStart: -10, separationT: 150.0004, ship: { end: 610 }, events: [{ key: 'ship-end', t: 600 }],
} as FlightResult;
const command = (flap: ShipFlap, deg: number | null, t = 200): Extract<Intervention, { kind: 'flap' }> => ({ id: `flap-${flap}-${t}`, kind: 'flap', vehicle: 'ship', flap, deg, t });
const scenario = (...interventions: Intervention[]): Scenario => ({ asFlown: true, interventions });

beforeEach(() => useReplay.setState({ ...initial, result, t: 200, loading: false }, true));
afterEach(() => useReplay.setState(initial, true));

describe('flap command validation', () => {
  it.each([0, 1, 2, 3] as const)('accepts flap %s, including automatic and both stops', (flap) => {
    for (const deg of [null, 0, 45.125, 90]) {
      expect(normalizeFlapCommand({ vehicle: 'ship', flap, deg })).toEqual({ vehicle: 'ship', flap, deg });
    }
  });

  it('clamps finite angles and normalizes them to link precision', () => {
    for (const [input, expected] of [[-90, 0], [180, 90], [24.123456, 24.123], [89.9999, 90]]) {
      expect(normalizeFlapCommand({ vehicle: 'ship', flap: 1, deg: input })?.deg).toBe(expected);
    }
  });

  it.each([
    { vehicle: 'booster' }, { vehicle: undefined },
    { flap: -1 }, { flap: 4 }, { flap: 1.5 }, { flap: NaN }, { flap: Infinity }, { flap: '0' }, { flap: null },
    { deg: NaN }, { deg: Infinity }, { deg: -Infinity }, { deg: '45' }, { deg: undefined },
  ])('rejects malformed fields %j without changing history', (patch) => {
    const input = { ...command(0, 45), ...patch };
    expect(normalizeFlapCommand(input)).toBeNull();
    const before = useReplay.getState();
    before.addIntervention(input as NewIntervention);
    expect(useReplay.getState()).toBe(before);
    expect(encodeScenario(scenario(input as Intervention))).toBe('');
  });

  it.each([NaN, Infinity, -Infinity, -1, 100000.0001])('rejects invalid time %s at store and serialization boundaries', (t) => {
    const before = useReplay.getState();
    before.addIntervention(command(0, 45, t));
    expect(useReplay.getState()).toBe(before);
    expect(encodeScenario(scenario(command(0, 45, t)))).toBe('');
  });
});

describe('flap command links and ordering', () => {
  it('round-trips all four flaps and releases, including the replay view', () => {
    const s = scenario(command(0, 0, 200.125), command(1, 90, 201), command(2, 44.875, 202), command(3, 30, 203), command(0, null, 210));
    expect(encodeScenario(s)).toBe('200.125fs0d0_201fs1d90_202fs2d44.875_203fs3d30_210fs0a');
    expect(new URLSearchParams({ run: encodeScenario(s) }).toString()).toBe(`run=${encodeScenario(s)}`);
    const view = { ...initial, flight: 5, scenario: s, t: 220, camera: 'chase' as const, follow: 'ship' as const, pip: false };
    const decoded = readRunLink(runLinkSearch(linkOf(view, true), true));
    expect(decoded).toMatchObject({ flight: 5, t: 220, camera: 'chase', follow: 'ship', pip: false });
    expect(canonicalScenario(decoded.scenario)).toBe(canonicalScenario(s));
    expect(new Set(decoded.scenario.interventions.map((i) => i.id)).size).toBe(5);
  });

  it('rejects malformed tokens and leaves valid commands usable', () => {
    const invalid = [
      '200fb0d45', '200fs4d45', '200fs-1d45', '200fs1.5d45', '200fsNaNd45',
      '200fs0dNaN', '200fs0dInfinity', '200fs0d', '200fs0', '200fs0auto', '200fs0dnull', '200fs0a45',
      '-1fs0d45', 'NaNfs0d45', 'Infinityfs0d45', '100000.0001fs0d45', `${'9'.repeat(400)}fs0d45`,
    ].join('_');
    expect(decodeScenario(invalid, 5)).toBe(AS_FLOWN);
    expect(decodeScenario(`${invalid}_200fs2d30`, 5).interventions).toEqual([expect.objectContaining({ kind: 'flap', vehicle: 'ship', flap: 2, deg: 30, t: 200 })]);
  });

  it('normalizes imported angles and times and produces a stable subsequent round trip', () => {
    const decoded = decodeScenario('202fs2d180_200.123456fs0d-45_201fs1d12.345678', 5);
    expect(encodeScenario(decoded)).toBe('200.123fs0d0_201fs1d12.346_202fs2d90');
    expect(canonicalScenario(decodeScenario(encodeScenario(decoded), 5))).toBe(canonicalScenario(decoded));
    expect(decodeScenario(`200fs0d${'9'.repeat(400)}`, 5)).toBe(AS_FLOWN);
  });

  it('keys commands independently of IDs/input order and distinguishes flap, angle, and automatic', () => {
    const inputs = [command(0, 45), command(1, 45), command(0, null)];
    expect(new Set(inputs.map(interventionSignature)).size).toBe(3);
    const s = scenario(...inputs);
    expect(scenarioKey(scenario(...inputs.toReversed().map((i) => ({ ...i, id: 'different' }))))).toBe(scenarioKey(s));
    expect(scenarioKey(scenario(command(0, 0)))).not.toBe(scenarioKey(scenario(command(0, null))));
    expect(scenarioKey(scenario(command(0, 45)))).not.toBe(scenarioKey(scenario(command(0, 46))));
    const ordered = sortInterventions(inputs);
    expect(ordered.map(interventionSignature)).toEqual(['200|flap|ship|0|45', '200|flap|ship|0|auto', '200|flap|ship|1|45']);
    const linked = decodeScenario(encodeScenario(scenario(...inputs.toReversed())), 5);
    expect(flapCommandAt(sortInterventions(linked.interventions), 0, 200)).toBeNull();
    expect(flapCommandAt(sortInterventions(linked.interventions), 1, 200)).toBe(45);
    expect(flapCommandAt(ordered, 1, 199.999)).toBeNull();
  });
});

describe('flap control availability and history', () => {
  it('does not show ignored imported pre-separation or post-flight commands as applied', () => {
    const list = sortInterventions([command(0, 90, 0), command(1, 20, 200), command(1, 0, 610)]);
    expect(flapCommandAt(list, 0, 500, 150, 600)).toBeNull();
    expect(flapCommandAt(list, 1, 620, 150, 600)).toBe(20);
  });
  it('enables commands only at a rounded time after separation and before the existing command cutoff', () => {
    expect(takesFlapCommands(null, 200)).toBe(false);
    expect(takesFlapCommands(result, NaN)).toBe(false);
    expect(takesFlapCommands({ ...result, separationT: null }, 200)).toBe(false);
    expect(takesFlapCommands(result, 150.0004)).toBe(false); // rounds to just before separation
    expect(takesFlapCommands(result, 150.0006)).toBe(true);
    expect(takesFlapCommands(result, 599.979)).toBe(true);
    expect(takesFlapCommands(result, 599.9796)).toBe(false); // rounds to the last excluded step
    expect(takesFlapCommands(result, 605)).toBe(false); // tip-over track still exists
    for (const t of [100, 150.0004, 599.98, 605]) {
      const before = useReplay.getState();
      before.addIntervention(command(0, 45, t));
      expect(useReplay.getState()).toBe(before);
    }
    useReplay.setState({ result: null });
    const before = useReplay.getState();
    before.addIntervention(command(0, 45));
    expect(useReplay.getState()).toBe(before);
  });

  it('replaces only the selected flap at the same rounded time, with exact undo and redo', () => {
    initial.addIntervention(command(0, 20, 200.1231));
    initial.addIntervention(command(1, 60, 200.1231));
    initial.addIntervention({ kind: 'pitch', vehicle: 'ship', deg: 2, t: 200.1231 });
    const first = useReplay.getState().scenario;
    initial.addIntervention(command(0, 80, 200.1234));
    const manual = useReplay.getState().scenario;
    expect(manual.interventions).toHaveLength(3);
    expect(manual.interventions.slice(0, 2)).toEqual(first.interventions.slice(1));
    expect(manual.interventions[2]).toMatchObject({ kind: 'flap', flap: 0, deg: 80, t: 200.123 });
    initial.addIntervention(command(0, null, 200.1234));
    const automatic = useReplay.getState().scenario;
    expect(automatic.interventions).toHaveLength(3);
    expect(flapCommandAt(sortInterventions(automatic.interventions), 0, 200.123)).toBeNull();
    initial.undoScenario();
    expect(useReplay.getState().scenario).toBe(manual);
    initial.undoScenario();
    expect(useReplay.getState().scenario).toBe(first);
    initial.redoScenario();
    initial.redoScenario();
    expect(useReplay.getState().scenario).toBe(automatic);
    expect(canonicalScenario(decodeScenario(encodeScenario(automatic), 5))).toBe(canonicalScenario(automatic));
  });

  it('keeps later commands separate and only releases the selected flap', () => {
    initial.addIntervention(command(0, 20, 200));
    initial.addIntervention(command(1, 60, 200));
    initial.addIntervention(command(0, null, 220));
    const ordered = sortInterventions(useReplay.getState().scenario.interventions);
    expect(ordered).toHaveLength(3);
    expect(flapCommandAt(ordered, 0, 219.999)).toBe(20);
    expect(flapCommandAt(ordered, 0, 220)).toBeNull();
    expect(flapCommandAt(ordered, 1, 220)).toBe(60);
    expect(flapCommandAt(ordered, 2, 220)).toBeNull();
  });

  it('normalizes before duplicate detection and preserves redo for an unchanged target', () => {
    initial.addIntervention(command(0, 100, 200.123456));
    expect(useReplay.getState().scenario.interventions[0]).toMatchObject({ t: 200.123, deg: 90 });
    initial.updateScenario({ wind: 20 });
    const future = useReplay.getState().scenario;
    initial.undoScenario();
    const before = useReplay.getState();
    before.addIntervention(command(0, 91, 200.1234));
    expect(useReplay.getState()).toBe(before);
    before.redoScenario();
    expect(useReplay.getState().scenario).toBe(future);
  });

  it('replaces all conflicting imported commands for the same flap without dropping other flaps', () => {
    const linked = decodeScenario('200fs0d90_200fs1d40_200fs0d20_200fs0a', 5);
    initial.openRun({ flight: 5, scenario: linked });
    useReplay.setState({ result });
    initial.addIntervention(command(0, 30));
    const updated = useReplay.getState().scenario;
    expect(updated.interventions).toHaveLength(2);
    expect(updated.interventions).toContain(linked.interventions[1]);
    expect(flapCommandAt(sortInterventions(updated.interventions), 0, 200)).toBe(30);
    initial.undoScenario();
    expect(useReplay.getState().scenario).toBe(linked);
  });
});
