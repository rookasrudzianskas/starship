import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySample, TrackBuilder } from '../sim/recorder';
import { scenarioKey } from '../sim/scenario';
import { EARTH_RADIUS, Phase, type FlightResult, type Intervention, type Scenario, type ShipFlap } from '../sim/types';
import { useReplay } from '../store/replay';
import { createSurfaceReadout } from '../store/surfaceReadout';

const initial = useReplay.getInitialState();
const baseline: Scenario = { asFlown: true, interventions: [] };
const cleanups: (() => void)[] = [];
const command = (flap: ShipFlap, deg: number | null, t: number): Intervention =>
  ({ id: `${flap}-${deg}-${t}`, kind: 'flap', vehicle: 'ship', flap, deg, t });

/** Small real tracks exercise sampling/command integration without running the flight simulator. */
function flight(scenario = baseline, number = 5, offset = 0): FlightResult {
  const builder = new TrackBuilder(2);
  for (const t of [0, 120]) builder.push({
    ...emptySample(), t, pz: -EARTH_RADIUS, phase: Phase.Entry,
    a0: 5 + offset + t / 2, a1: 10 + offset + t / 2,
    a2: 15 + offset + t / 2, a3: 20 + offset + t / 2,
  });
  const ship = builder.finish('ship', 'splashdown');
  return {
    flight: number, scenarioKey: scenarioKey(scenario), launchUtc: 0, tStart: 0, tEnd: 120,
    separationT: 20, ship, booster: { ...ship, vehicle: 'booster' },
    boosterEngines: { slots: [], changes: [] }, shipEngines: { slots: [], changes: [] },
    events: [{ key: 'ship-end', t: 100, vehicle: 'ship', label: 'Splashdown', short: 'END', major: true, speed: 0, alt: 0, pos: [0, 0, -EARTH_RADIUS] }],
    payload: [], coasts: [], computeMs: 0,
    records: { boosterTopSpeed: 0, boosterApogee: 0, shipTopSpeed: 0, shipApogee: 0 },
  };
}

function watch() {
  const store = createSurfaceReadout(), listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  cleanups.push(unsubscribe);
  return { store, listener, unsubscribe };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  useReplay.setState({ ...initial, flight: 5, scenario: baseline, result: flight(), t: 20, loading: false, error: null }, true);
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  useReplay.setState(initial, true);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('surface readout subscription', () => {
  it('is safe without a browser and stays inactive until subscribed, with a stable server placeholder', () => {
    const subscribe = vi.spyOn(useReplay, 'subscribe');
    const store = createSurfaceReadout(), server = store.getServerSnapshot();
    expect(typeof window).toBe('undefined');
    expect(subscribe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    useReplay.setState({ t: 30 });
    expect(store.getSnapshot()).toBe(server);
    const unsubscribe = store.subscribe(vi.fn());
    cleanups.push(unsubscribe);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', actual: [20, 25, 30, 35], roll: 0 });
    expect(store.getServerSnapshot()).toBe(server);
    expect(server.actual).toEqual([null, null, null, null]);
  });

  it('limits clock-driven notifications to 10 Hz during frequent playback updates', () => {
    const { store, listener } = watch();
    const times: number[] = [];
    listener.mockClear();
    listener.mockImplementation(() => times.push(performance.now()));
    for (let i = 1; i <= 50; i++) {
      useReplay.setState({ t: 20 + i });
      vi.advanceTimersByTime(10);
    }
    expect(times).toEqual([100, 200, 300, 400, 500]);
    expect(store.getSnapshot().actual[0]).toBe(40);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the first seek after idle immediately and delivers the final seek after a pause', () => {
    const { store, listener } = watch();
    vi.advanceTimersByTime(200);
    useReplay.getState().seek(40);
    expect(store.getSnapshot().actual[0]).toBe(25);
    listener.mockClear();
    useReplay.getState().seek(50);
    vi.advanceTimersByTime(50);
    useReplay.getState().seek(60);
    useReplay.getState().pause();
    expect(vi.getTimerCount()).toBe(1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(49);
    expect(store.getSnapshot().actual[0]).toBe(25);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot().actual[0]).toBe(35);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores unrelated state and preserves snapshot identity when rounded values do not change', () => {
    const { store, listener } = watch();
    const before = store.getSnapshot();
    listener.mockClear();
    useReplay.setState({ camera: 'free', pip: false });
    expect(vi.getTimerCount()).toBe(0);
    useReplay.setState({ t: 20.02 });
    vi.advanceTimersByTime(100);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
    useReplay.setState({ t: 20.22 });
    vi.advanceTimersByTime(100);
    expect(store.getSnapshot().actual[0]).toBe(15.1);
    expect(before.actual).toEqual([15, 20, 25, 30]);
  });

  it('clears pending timers and unsubscribes on unmount, then catches up on remount', () => {
    const { store, listener, unsubscribe } = watch();
    useReplay.setState({ t: 40 });
    expect(vi.getTimerCount()).toBe(1);
    const before = store.getSnapshot();
    unsubscribe();
    listener.mockClear();
    expect(vi.getTimerCount()).toBe(0);
    useReplay.setState({ t: 50, loading: true });
    vi.advanceTimersByTime(1000);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
    cleanups.push(store.subscribe(listener));
    expect(store.getSnapshot().status).toBe('updating');
    expect(store.getSnapshot().actual).toEqual([null, null, null, null]);
  });

  it('shares one upstream subscription/timer and notifies every active subscriber', () => {
    const upstream = vi.spyOn(useReplay, 'subscribe');
    const { store, listener: first, unsubscribe } = watch();
    const second = vi.fn(), stopSecond = store.subscribe(second);
    cleanups.push(stopSecond);
    first.mockClear();
    useReplay.setState({ t: 40 });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    useReplay.setState({ t: 50 });
    unsubscribe();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    useReplay.setState({ t: 60 });
    stopSecond();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('immediate surface readout validity', () => {
  it('invalidates a changed scenario before loading starts and immediately accepts the matching result', () => {
    const { store } = watch();
    useReplay.setState({ t: 30 });
    expect(vi.getTimerCount()).toBe(1);
    useReplay.getState().addIntervention({ t: 30, kind: 'flap', vehicle: 'ship', flap: 0, deg: 45 });
    expect(useReplay.getState().loading).toBe(false);
    expect(store.getSnapshot()).toEqual({ status: 'updating', actual: [null, null, null, null], commanded: [null, null, null, null], roll: null });
    expect(vi.getTimerCount()).toBe(0);
    const scenario = useReplay.getState().scenario;
    useReplay.setState({ result: flight(scenario) });
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', actual: [20, 25, 30, 35], commanded: [45, null, null, null] });
    expect(performance.now()).toBe(0);
  });

  it('rejects a retained/late result from the old flight even if its scenario key matches', () => {
    const { store } = watch();
    useReplay.setState({ t: 30 });
    useReplay.setState({ flight: 6 });
    expect(store.getSnapshot().status).toBe('updating');
    expect(store.getSnapshot().actual).toEqual([null, null, null, null]);
    expect(vi.getTimerCount()).toBe(0);
    useReplay.setState({ result: flight(baseline, 5, 10) });
    expect(store.getSnapshot().status).toBe('updating');
    useReplay.setState({ result: flight(baseline, 6, 10) });
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', actual: [30, 35, 40, 45] });
  });

  it('flushes loading/error changes and their clearing immediately, cancelling pending clock samples', () => {
    const { store } = watch();
    useReplay.setState({ t: 40 });
    useReplay.getState().setLoading(true);
    expect(store.getSnapshot().status).toBe('updating');
    expect(store.getSnapshot().roll).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    useReplay.getState().setLoading(false);
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', actual: [25, 30, 35, 40] });
    useReplay.setState({ error: 'Simulation failed' });
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', actual: [null, null, null, null], roll: null });
    useReplay.setState({ error: null });
    expect(store.getSnapshot().status).toBe('ready');
    expect(store.getSnapshot().actual[0]).toBe(25);
    expect(performance.now()).toBe(0);
  });

  it('flushes a replacement result at the current time even with the same flight and scenario', () => {
    const { store } = watch();
    useReplay.setState({ t: 40 });
    useReplay.setState({ result: flight(baseline, 5, 10) });
    expect(store.getSnapshot().actual).toEqual([35, 40, 45, 50]);
    expect(vi.getTimerCount()).toBe(0);
    useReplay.setState({ result: null });
    expect(store.getSnapshot()).toMatchObject({ status: 'updating', actual: [null, null, null, null], roll: null });
  });
});

describe('applied surface targets', () => {
  it('separates actual motion from sorted manual targets, automatic releases and time boundaries', () => {
    const scenario: Scenario = { asFlown: true, interventions: [
      command(2, 90, 99.98), command(0, null, 60), command(1, 50, 50),
      command(0, 90, 19), command(0, 40, 20), command(2, 25, 99.979),
      command(3, null, 30), command(3, 10, 30), command(3, 20, 30), command(1, 90, 105),
    ] };
    useReplay.setState({ scenario, result: flight(scenario), t: 19 });
    const { store } = watch();
    const seek = (t: number) => { useReplay.getState().seek(t); vi.advanceTimersByTime(100); return store.getSnapshot(); };
    expect(store.getSnapshot().commanded).toEqual([null, null, null, null]);
    expect(seek(20).commanded).toEqual([40, null, null, null]);
    expect(store.getSnapshot().actual[0]).toBe(15);
    expect(seek(30).commanded).toEqual([40, null, null, null]); // Canonical simultaneous Auto wins.
    expect(seek(49.9994).commanded[1]).toBeNull();
    expect(seek(49.9996).commanded[1]).toBe(50); // Same millisecond rounding as issued commands.
    expect(seek(60).commanded).toEqual([null, 50, null, null]);
    expect(seek(99.979).commanded).toEqual([null, 50, 25, null]);
    expect(seek(99.98)).toMatchObject({ status: 'ended', commanded: [null, 50, 25, null] });
    expect(seek(110).commanded).toEqual([null, 50, 25, null]); // Post-flight target is ignored.
  });

  it('refreshes separation/cutoff bounds with a new result and suppresses commands on an unseparated ship', () => {
    const scenario: Scenario = { asFlown: true, interventions: [command(0, 40, 35), command(1, 60, 55)] };
    useReplay.setState({ scenario, result: flight(scenario), t: 70 });
    const { store } = watch();
    expect(store.getSnapshot().commanded).toEqual([40, 60, null, null]);
    const laterSeparation = { ...flight(scenario), separationT: 50 };
    useReplay.setState({ result: laterSeparation });
    expect(store.getSnapshot().commanded).toEqual([null, 60, null, null]);
    const earlierEnd = { ...laterSeparation, events: laterSeparation.events.map((e) => ({ ...e, t: 55 })) };
    useReplay.setState({ result: earlierEnd });
    expect(store.getSnapshot()).toMatchObject({ status: 'ended', commanded: [null, null, null, null] });
    useReplay.setState({ result: { ...flight(scenario), separationT: null } });
    expect(store.getSnapshot().commanded).toEqual([null, null, null, null]);
  });

  it('keeps valid readback when a new scenario object has equivalent content', () => {
    const scenario: Scenario = { asFlown: true, interventions: [command(0, 40, 20), command(1, 60, 20)] };
    useReplay.setState({ scenario, result: flight(scenario) });
    const { store, listener } = watch();
    const before = store.getSnapshot();
    listener.mockClear();
    useReplay.setState({ scenario: { ...scenario, interventions: scenario.interventions.toReversed().map((i) => ({ ...i, id: `new-${i.id}` })) } });
    expect(store.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot().commanded).toEqual([40, 60, null, null]);
  });
});
