import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlightResult, Scenario } from '../sim/types';
import { AS_FLOWN, SCENARIO_HISTORY_LIMIT, useReplay, type NewIntervention, type ReplayState } from '../store/replay';
import { linkOf, runLinkSearch } from '../store/runLink';

const initial = useReplay.getInitialState();

beforeEach(() => useReplay.setState(initial, true));
afterEach(() => {
  useReplay.setState(initial, true);
  vi.unstubAllGlobals();
});

function freezeScenario(scenario: Scenario): Scenario {
  for (const intervention of scenario.interventions) Object.freeze(intervention);
  Object.freeze(scenario.interventions);
  return Object.freeze(scenario);
}

/** A modified scenario with both undo and redo available. */
function withHistory(): ReplayState {
  const s = useReplay.getState();
  s.addIntervention({ kind: 'stage-now', t: 80.123456 });
  s.updateScenario({ wind: 20 });
  s.updateScenario({ wind: 40 });
  s.undoScenario();
  return useReplay.getState();
}

describe('scenario history', () => {
  it('starts empty and leaves the store untouched when undo or redo is unavailable', () => {
    expect(initial.scenarioPast).toEqual([]);
    expect(initial.scenarioFuture).toEqual([]);
    const listener = vi.fn();
    const unsubscribe = useReplay.subscribe(listener);
    initial.undoScenario();
    initial.redoScenario();
    unsubscribe();
    expect(useReplay.getState()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
  });

  it('restores exact immutable snapshots, including imported IDs and command times', () => {
    const linked = freezeScenario({
      asFlown: false,
      boosterRecovery: 'expend',
      shipMission: 'orbital',
      payloadCount: 12,
      wind: 0,
      boosterLoad: 1,
      interventions: [{ id: 'linked-command', kind: 'engine-out', t: 60.418312, vehicle: 'booster', engine: 4 }],
    });
    initial.openRun({ flight: initial.flight, scenario: linked });
    const snapshots = [linked];
    initial.addIntervention({ kind: 'stage-now', t: 80.123456 });
    snapshots.push(freezeScenario(useReplay.getState().scenario));
    initial.addIntervention({ kind: 'pitch', t: 20.123456, vehicle: 'ship', deg: -2 });
    snapshots.push(freezeScenario(useReplay.getState().scenario));
    const commands = snapshots[2].interventions;
    expect(commands.map((i) => i.t)).toEqual([20.123, 60.418312, 80.123]);
    expect(new Set(commands.map((i) => i.id)).size).toBe(3);
    initial.removeIntervention('linked-command');
    snapshots.push(freezeScenario(useReplay.getState().scenario));
    initial.updateScenario({ wind: 30, boosterLoad: 0.9 });
    snapshots.push(freezeScenario(useReplay.getState().scenario));

    expect(useReplay.getState().scenarioPast).toEqual(snapshots.slice(0, -1));
    for (let i = snapshots.length - 2; i >= 0; i--) {
      initial.undoScenario();
      expect(useReplay.getState().scenario).toBe(snapshots[i]);
    }
    expect(useReplay.getState().scenarioPast).toEqual([]);
    const oldest = useReplay.getState();
    oldest.undoScenario();
    expect(useReplay.getState()).toBe(oldest);
    for (let i = 1; i < snapshots.length; i++) {
      initial.redoScenario();
      expect(useReplay.getState().scenario).toBe(snapshots[i]);
    }
    expect(useReplay.getState().scenarioFuture).toEqual([]);
    const newest = useReplay.getState();
    newest.redoScenario();
    expect(useReplay.getState()).toBe(newest);
    expect(snapshots[2].interventions).toBe(commands);
    expect(linked.interventions[0]).toEqual({ id: 'linked-command', kind: 'engine-out', t: 60.418312, vehicle: 'booster', engine: 4 });
  });

  it('keeps identical commands separately undoable and removes only the requested ID', () => {
    initial.addIntervention({ kind: 'stage-now', t: 80 });
    const first = useReplay.getState().scenario;
    initial.addIntervention({ kind: 'stage-now', t: 80 });
    const second = useReplay.getState().scenario;
    expect(second.interventions).toHaveLength(2);
    expect(second.interventions[0].id).not.toBe(second.interventions[1].id);
    initial.undoScenario();
    expect(useReplay.getState().scenario).toBe(first);
    initial.redoScenario();
    expect(useReplay.getState().scenario).toBe(second);
    initial.removeIntervention(first.interventions[0].id);
    expect(useReplay.getState().scenario.interventions).toEqual([second.interventions[1]]);
    initial.undoScenario();
    expect(useReplay.getState().scenario).toBe(second);
  });

  it.each(['addIntervention', 'removeIntervention', 'updateScenario', 'resetScenario'] as const)(
    '%s records the old scenario and discards redo when branching',
    (action) => {
      const before = withHistory();
      Object.freeze(before.scenarioPast);
      Object.freeze(before.scenarioFuture);
      if (action === 'addIntervention') before.addIntervention({ kind: 'terminate', t: 120, vehicle: 'ship' });
      else if (action === 'removeIntervention') before.removeIntervention(before.scenario.interventions[0].id);
      else if (action === 'updateScenario') before.updateScenario({ wind: 60 });
      else before.resetScenario();
      const after = useReplay.getState();
      expect(after.scenario).not.toBe(before.scenario);
      expect(after.scenarioPast).toEqual([...before.scenarioPast, before.scenario]);
      expect(after.scenarioPast[after.scenarioPast.length - 1]).toBe(before.scenario);
      expect(after.scenarioFuture).toEqual([]);
      after.redoScenario();
      expect(useReplay.getState()).toBe(after);
      after.undoScenario();
      expect(useReplay.getState().scenario).toBe(before.scenario);
    },
  );

  it('retains exactly the most recent 50 changes across undo and redo', () => {
    expect(SCENARIO_HISTORY_LIMIT).toBe(50);
    const snapshots = [initial.scenario];
    const changes = SCENARIO_HISTORY_LIMIT + 7;
    for (let wind = 1; wind <= changes; wind++) {
      initial.updateScenario({ wind });
      snapshots.push(useReplay.getState().scenario);
      expect(useReplay.getState().scenarioPast.length).toBeLessThanOrEqual(SCENARIO_HISTORY_LIMIT);
    }
    expect(useReplay.getState().scenarioPast).toEqual(snapshots.slice(7, -1));
    for (let i = changes - 1; i >= 7; i--) {
      initial.undoScenario();
      expect(useReplay.getState().scenario).toBe(snapshots[i]);
      expect(useReplay.getState().scenarioFuture.length).toBeLessThanOrEqual(SCENARIO_HISTORY_LIMIT);
    }
    const oldest = useReplay.getState();
    expect(oldest.scenarioFuture).toHaveLength(SCENARIO_HISTORY_LIMIT);
    oldest.undoScenario();
    expect(useReplay.getState()).toBe(oldest);
    for (let i = 8; i <= changes; i++) {
      initial.redoScenario();
      expect(useReplay.getState().scenario).toBe(snapshots[i]);
    }
    expect(useReplay.getState().scenarioPast).toHaveLength(SCENARIO_HISTORY_LIMIT);
    expect(useReplay.getState().scenarioFuture).toEqual([]);
  });

  it('makes reset undoable and redoable without losing the modified scenario', () => {
    const modified = withHistory();
    modified.resetScenario();
    const reset = useReplay.getState();
    expect(reset.scenario).toBe(AS_FLOWN);
    expect(reset.scenarioPast).toEqual([...modified.scenarioPast, modified.scenario]);
    expect(reset.scenarioFuture).toEqual([]);
    reset.undoScenario();
    expect(useReplay.getState().scenario).toBe(modified.scenario);
    reset.redoScenario();
    expect(useReplay.getState().scenario).toBe(AS_FLOWN);
  });
});

describe('scenario history no-ops', () => {
  it.each([
    {},
    { asFlown: true },
    { wind: 0 },
    { boosterLoad: 1 },
    { wind: undefined, boosterLoad: undefined },
    { boosterRecovery: undefined, shipMission: undefined, payloadCount: undefined },
  ])('does not dirty implicit defaults or clear redo for %j', (patch) => {
    initial.updateScenario({ wind: 40 });
    const future = useReplay.getState().scenario;
    initial.undoScenario();
    const before = useReplay.getState();
    before.updateScenario(patch);
    expect(useReplay.getState()).toBe(before);
    before.redoScenario();
    expect(useReplay.getState().scenario).toBe(future);
  });

  it('treats explicit wind 0 and load 1 as defaults, including on reset', () => {
    const scenario: Scenario = { asFlown: true, wind: 0, boosterLoad: 1, interventions: [] };
    initial.openRun({ flight: initial.flight, scenario });
    initial.updateScenario({ wind: 40 });
    initial.undoScenario();
    const before = useReplay.getState();
    before.updateScenario({ wind: undefined, boosterLoad: undefined });
    expect(useReplay.getState()).toBe(before);
    before.resetScenario();
    expect(useReplay.getState()).toBe(before);
    expect(before.scenario).toBe(scenario);
    before.redoScenario();
    expect(useReplay.getState().scenario.wind).toBe(40);
  });

  it('keeps both stacks for unchanged settings and a nonexistent command ID', () => {
    initial.updateScenario({ asFlown: false, boosterRecovery: 'catch', shipMission: 'orbital', payloadCount: 12, boosterLoad: 0.9 });
    const before = withHistory();
    before.updateScenario({ asFlown: false, boosterRecovery: 'catch', shipMission: 'orbital', payloadCount: 12, boosterLoad: 0.9, wind: 20 });
    expect(useReplay.getState()).toBe(before);
    before.removeIntervention('nonexistent');
    expect(useReplay.getState()).toBe(before);
    before.redoScenario();
    expect(useReplay.getState().scenario.wind).toBe(40);
  });

  it('keeps redo when the scenario is already reset', () => {
    initial.updateScenario({ wind: 40 });
    initial.undoScenario();
    const before = useReplay.getState();
    before.resetScenario();
    expect(useReplay.getState()).toBe(before);
    before.redoScenario();
    expect(useReplay.getState().scenario.wind).toBe(40);
  });
});

describe('same-time control commands', () => {
  type ControlCommand = Extract<NewIntervention, { kind: 'throttle' | 'pitch' }>;

  it.each<{ name: string; first: ControlCommand; replacement: ControlCommand }>([
    {
      name: 'throttle from 80% to 60%',
      first: { kind: 'throttle', vehicle: 'booster', value: 0.8, t: 80.1231 },
      replacement: { kind: 'throttle', vehicle: 'booster', value: 0.6, t: 80.1234 },
    },
    {
      name: 'pitch from positive to negative',
      first: { kind: 'pitch', vehicle: 'booster', deg: 4, t: 80.1231 },
      replacement: { kind: 'pitch', vehicle: 'booster', deg: -4, t: 80.1234 },
    },
    {
      name: 'pitch from negative to positive',
      first: { kind: 'pitch', vehicle: 'booster', deg: -4, t: 80.1231 },
      replacement: { kind: 'pitch', vehicle: 'booster', deg: 4, t: 80.1234 },
    },
  ])('replaces $name at the same rounded time, with exact undo and redo', ({ first, replacement }) => {
    initial.addIntervention(first);
    const oldScenario = freezeScenario(useReplay.getState().scenario);
    initial.addIntervention(replacement);
    const newScenario = freezeScenario(useReplay.getState().scenario);
    expect(newScenario.interventions).toHaveLength(1);
    expect(newScenario.interventions[0]).toMatchObject({ ...replacement, t: 80.123 });
    expect(newScenario.interventions[0].id).not.toBe(oldScenario.interventions[0].id);
    initial.undoScenario();
    expect(useReplay.getState().scenario).toBe(oldScenario);
    initial.redoScenario();
    expect(useReplay.getState().scenario).toBe(newScenario);

    initial.addIntervention({ ...replacement, t: 80.124 });
    expect(useReplay.getState().scenario.interventions).toHaveLength(2);
    expect(useReplay.getState().scenario.interventions[0]).toBe(newScenario.interventions[0]);
    expect(useReplay.getState().scenario.interventions.map((i) => i.t)).toEqual([80.123, 80.124]);
    initial.addIntervention({ ...replacement, vehicle: 'ship' });
    expect(useReplay.getState().scenario.interventions).toHaveLength(3);
  });

  it.each<ControlCommand>([
    { kind: 'throttle', vehicle: 'booster', value: 0.6, t: 80.1231 },
    { kind: 'pitch', vehicle: 'ship', deg: -4, t: 80.1231 },
  ])('keeps history, redo and the existing ID for an identical $kind value', (command) => {
    initial.addIntervention(command);
    initial.updateScenario({ wind: 40 });
    const future = useReplay.getState().scenario;
    initial.undoScenario();
    const before = useReplay.getState();
    before.addIntervention({ ...command, t: 80.1234 });
    expect(useReplay.getState()).toBe(before);
    before.redoScenario();
    expect(useReplay.getState().scenario).toBe(future);
  });

  it('replaces all legacy matching commands while preserving other command kinds and vehicles', () => {
    const linked = freezeScenario({
      asFlown: true,
      interventions: [
        { id: 'old-low', kind: 'throttle', vehicle: 'booster', value: 0.4, t: 80.123 },
        { id: 'old-high', kind: 'throttle', vehicle: 'booster', value: 0.8, t: 80.1234 },
        { id: 'ship-throttle', kind: 'throttle', vehicle: 'ship', value: 0.8, t: 80.123 },
        { id: 'pitch', kind: 'pitch', vehicle: 'booster', deg: -4, t: 80.123 },
      ],
    });
    initial.openRun({ flight: initial.flight, scenario: linked });
    initial.addIntervention({ kind: 'throttle', vehicle: 'booster', value: 0.6, t: 80.123 });
    const replacement = useReplay.getState().scenario;
    expect(replacement.interventions).toHaveLength(3);
    expect(replacement.interventions).toEqual([
      linked.interventions[2],
      linked.interventions[3],
      expect.objectContaining({ kind: 'throttle', vehicle: 'booster', value: 0.6, t: 80.123 }),
    ]);
    initial.undoScenario();
    expect(useReplay.getState().scenario).toBe(linked);
    initial.redoScenario();
    expect(useReplay.getState().scenario).toBe(replacement);
  });
});

describe('scenario history run boundaries', () => {
  it('reselecting the same flight without a time preserves the complete state', () => {
    const before = withHistory();
    before.setFlight(before.flight);
    expect(useReplay.getState()).toBe(before);
  });

  it.each<{ name: string; start: (s: ReplayState) => void }>([
    { name: 'another flight', start: (s) => s.setFlight(6) },
    { name: 'an explicit restart at zero', start: (s) => s.setFlight(s.flight, 0) },
    { name: 'a linked flight', start: (s) => s.openRun({ flight: 6 }) },
    { name: 'a linked scenario on the same flight', start: (s) => s.openRun({ flight: s.flight, scenario: { asFlown: false, interventions: [] } }) },
    { name: 'the same linked run', start: (s) => s.openRun({ flight: s.flight, scenario: s.scenario, t: 50 }) },
  ])('clears both stacks when opening $name', ({ start }) => {
    initial.openRun({ flight: 5 });
    const before = withHistory();
    expect(before.scenarioPast.length).toBeGreaterThan(0);
    expect(before.scenarioFuture.length).toBeGreaterThan(0);
    start(before);
    const after = useReplay.getState();
    expect(after.scenarioPast).toEqual([]);
    expect(after.scenarioFuture).toEqual([]);
    after.undoScenario();
    after.redoScenario();
    expect(useReplay.getState()).toBe(after);
    after.updateScenario({ wind: 70 });
    after.undoScenario();
    expect(useReplay.getState().scenario).toBe(after.scenario);
  });

  it('clears redo on an explicit restart even when already as flown', () => {
    initial.updateScenario({ wind: 40 });
    initial.undoScenario();
    initial.setFlight(initial.flight, -10);
    expect(useReplay.getState().scenario).toBe(AS_FLOWN);
    expect(useReplay.getState().scenarioPast).toEqual([]);
    expect(useReplay.getState().scenarioFuture).toEqual([]);
  });
});

describe('scenario history isolation', () => {
  it.each([true, false])('preserves all replay context during undo and redo with playing=%s', (playing) => {
    const result = { flight: initial.flight, tStart: -10, tEnd: 1000, events: [], coasts: [] } as unknown as FlightResult;
    const baseline = { ...result, scenarioKey: 'baseline' };
    initial.setResult(result, baseline);
    const before = withHistory();
    useReplay.setState({
      t: 300.456,
      playing,
      rate: 20,
      skipCoasts: false,
      liveLiftoffMs: 123456,
      liveCountdown: -20,
      camera: 'chase',
      webcastShot: 'pad',
      follow: 'ship',
      pip: false,
      panel: 'director',
      soundEnabled: true,
      soundError: 'sound unavailable',
      error: 'previous simulation error',
      settings: { ...initial.settings, speedUnit: 'mph', quality: 'low' },
      settingsLoaded: true,
      callout: { t: 0, key: 'liftoff', vehicle: 'stack', label: 'Liftoff', short: 'LIFTOFF', major: true, speed: 0, alt: 0, pos: [0, 0, 0] },
    });
    const context = useReplay.getState();
    for (const action of [before.undoScenario, before.redoScenario]) {
      action();
      const after = useReplay.getState();
      for (const key of Object.keys(context) as (keyof ReplayState)[]) {
        if (key === 'scenario' || key === 'scenarioPast' || key === 'scenarioFuture') continue;
        expect(after[key], key).toBe(context[key]);
      }
    }
    expect(useReplay.getState().scenario).toBe(before.scenario);
  });

  it('supports rapid undo and redo while the simulation is loading', () => {
    const before = withHistory();
    before.setLoading(true);
    before.undoScenario();
    before.undoScenario();
    expect(useReplay.getState().scenario).toBe(AS_FLOWN);
    before.redoScenario();
    before.redoScenario();
    before.redoScenario();
    expect(useReplay.getState().scenario.wind).toBe(40);
    expect(useReplay.getState().scenario.interventions[0]).toBe(before.scenario.interventions[0]);
    expect(useReplay.getState().loading).toBe(true);
    before.undoScenario();
    expect(useReplay.getState().scenario).toBe(before.scenario);
  });

  it('excludes history from run links and saved settings', () => {
    const setItem = vi.fn();
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      localStorage: { setItem },
    });
    const before = withHistory();
    expect(setItem).not.toHaveBeenCalled();
    const link = linkOf(before, true);
    expect(Object.keys(link).sort()).toEqual(['camera', 'flight', 'follow', 'pip', 'scenario', 'shot', 't']);
    const search = runLinkSearch(link, true);
    before.openRun({ flight: before.flight, scenario: before.scenario, t: before.t });
    expect(runLinkSearch(linkOf(useReplay.getState(), true), true)).toBe(search);
    useReplay.getState().updateSettings({ speedUnit: 'mph' });
    expect(setItem).toHaveBeenCalledExactlyOnceWith('starship-telemetry:settings', JSON.stringify({ speedUnit: 'mph' }));
  });
});
