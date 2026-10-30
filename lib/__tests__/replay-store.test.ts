import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlightResult, Scenario } from '../sim/types';
import { AS_FLOWN, COAST_EXIT, COAST_RATE, coastAt, isSkipping, useReplay } from '../store/replay';

// The store only reads the time range and the coasts of a result.
function fakeResult(coasts: Array<[number, number]> = [[500, 1500], [3000, 8000]], tEnd = 10_000): FlightResult {
  return { flight: 14, scenarioKey: 'k', tStart: -10, tEnd, coasts, events: [] } as unknown as FlightResult;
}

const initial = useReplay.getState();

function loaded(t: number, extra: Partial<ReturnType<typeof useReplay.getState>> = {}) {
  const result = fakeResult();
  useReplay.setState({ result, baseline: result, loading: false, t, playing: true, rate: 1, ...extra });
}

/** Advance in 1/60 s frames for `seconds` of wall time. */
function play(seconds: number) {
  for (let i = 0; i < Math.round(seconds * 60); i++) useReplay.getState().advance(1 / 60);
}

beforeEach(() => useReplay.setState(initial, true));
afterEach(() => vi.restoreAllMocks());

describe('coasts', () => {
  it('fast-forwards from a coast start until COAST_EXIT s before its end', () => {
    const r = fakeResult();
    expect(coastAt(r, 499.9)).toBeNull();
    expect(coastAt(r, 500)).toEqual([500, 1500]);
    expect(coastAt(r, 1500 - COAST_EXIT - 0.01)).toEqual([500, 1500]);
    // The last seconds of a coast are inside it, with nothing left to skip.
    expect(coastAt(r, 1500 - COAST_EXIT)).toBeNull();
    expect(coastAt(null, 600)).toBeNull();
  });

  it('plays the ascent at the chosen rate even though later coasts exist', () => {
    loaded(60);
    play(1);
    expect(useReplay.getState().t).toBeCloseTo(61, 6);
  });

  it('runs a coast at COAST_RATE and lands exactly on its exit point', () => {
    loaded(600);
    useReplay.getState().advance(0.1);
    expect(useReplay.getState().t).toBeCloseTo(600 + 0.1 * COAST_RATE, 6);
    play(20);
    expect(useReplay.getState().t).toBeCloseTo(1500 - COAST_EXIT + (20 - (1500 - COAST_EXIT - 612) / COAST_RATE), 0);
    // Never past the exit within one step, however long the frame.
    useReplay.setState({ t: 1490 });
    useReplay.getState().advance(0.1);
    expect(useReplay.getState().t).toBe(1500 - COAST_EXIT);
    useReplay.getState().advance(0.1);
    expect(useReplay.getState().t).toBeCloseTo(1500 - COAST_EXIT + 0.1, 6);
  });

  it('keeps a faster chosen rate inside a coast, and the toggle turns skipping off', () => {
    loaded(600, { rate: 100 });
    useReplay.getState().advance(0.1);
    expect(useReplay.getState().t).toBeCloseTo(600 + 0.1 * Math.max(COAST_RATE, 100), 6);
    useReplay.getState().setSkipCoasts(false);
    useReplay.getState().advance(0.1);
    expect(useReplay.getState().t).toBeCloseTo(612 + 10, 6);
  });

  it('reports skipping only while playing through a coast', () => {
    loaded(600);
    expect(isSkipping(useReplay.getState())).toBe(true);
    useReplay.getState().pause();
    expect(isSkipping(useReplay.getState())).toBe(false);
    useReplay.getState().play();
    useReplay.getState().setSkipCoasts(false);
    expect(isSkipping(useReplay.getState())).toBe(false);
    loaded(60);
    expect(isSkipping(useReplay.getState())).toBe(false);
  });

  it('pausing and seeking never move the clock on their own', () => {
    loaded(600);
    useReplay.getState().pause();
    useReplay.getState().advance(0.1);
    expect(useReplay.getState().t).toBe(600);
    useReplay.getState().seek(100);
    expect(useReplay.getState().t).toBe(100);
  });
});

describe('end of the flight', () => {
  it('stops at the end, and play starts over', () => {
    loaded(9999.99);
    useReplay.getState().advance(0.1);
    expect(useReplay.getState()).toMatchObject({ t: 10_000, playing: false });
    useReplay.getState().play();
    expect(useReplay.getState()).toMatchObject({ t: -10, playing: true });
  });
});

describe('live sync', () => {
  it('shows the webcast clock while the replay waits at its start', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    loaded(-10);
    useReplay.getState().setLive(now + 300_000); // T−5:00
    useReplay.getState().advance(1 / 60);
    expect(useReplay.getState()).toMatchObject({ t: -10, liveCountdown: -300 });
    vi.spyOn(Date, 'now').mockReturnValue(now + 295_000); // T−0:05
    useReplay.getState().advance(1 / 60);
    expect(useReplay.getState()).toMatchObject({ t: -5, liveCountdown: null });
  });

  it('ends when the live flight passes the end of the replay', () => {
    vi.spyOn(Date, 'now').mockReturnValue(20_000_000);
    loaded(9000);
    useReplay.getState().setLive(20_000_000 - 10_500_000);
    useReplay.getState().advance(1 / 60);
    expect(useReplay.getState()).toMatchObject({ t: 10_000, playing: false, liveLiftoffMs: null, liveCountdown: null });
  });

  it('ends on a seek, a speed change or another flight', () => {
    loaded(100);
    useReplay.getState().setLive(Date.now());
    useReplay.getState().seek(50);
    expect(useReplay.getState().liveLiftoffMs).toBeNull();
    useReplay.getState().setLive(Date.now());
    useReplay.getState().stepRate(1);
    expect(useReplay.getState().liveLiftoffMs).toBeNull();
    useReplay.getState().setLive(Date.now());
    useReplay.getState().setFlight(5);
    expect(useReplay.getState()).toMatchObject({ flight: 5, liveLiftoffMs: null, liveCountdown: null });
  });
});

describe('opening runs', () => {
  const modified: Scenario = { asFlown: false, wind: 40, interventions: [] };

  it('setFlight ignores the flight already shown, unless a time is given', () => {
    loaded(300, { scenario: modified });
    useReplay.getState().setFlight(useReplay.getState().flight);
    expect(useReplay.getState()).toMatchObject({ t: 300, scenario: modified });
    useReplay.getState().setFlight(useReplay.getState().flight, 20);
    expect(useReplay.getState()).toMatchObject({ t: 20, playing: true, scenario: AS_FLOWN, result: null, loading: true });
  });

  it('openRun starts over as flown, paused when a time is given', () => {
    loaded(300, { scenario: modified });
    useReplay.getState().openRun({ flight: 3, t: 120 });
    expect(useReplay.getState()).toMatchObject({ flight: 3, scenario: AS_FLOWN, t: 120, playing: false, result: null, loading: true, callout: null });
    useReplay.getState().openRun({ flight: 4 });
    expect(useReplay.getState()).toMatchObject({ flight: 4, t: -10, playing: true });
  });

  it('openRun of the run already shown keeps its result and only moves the clock', () => {
    loaded(300);
    const { result, scenario, flight } = useReplay.getState();
    useReplay.getState().openRun({ flight, scenario, t: 50_000 });
    // Clamped to the loaded flight, nothing reloads (the replay would not re-request an unchanged run).
    expect(useReplay.getState()).toMatchObject({ result, loading: false, t: 10_000, playing: false });
  });
});

describe('commands', () => {
  it('are kept in time order with whole-millisecond times', () => {
    useReplay.getState().addIntervention({ t: 80.123456, kind: 'stage-now' });
    useReplay.getState().addIntervention({ t: 60.4183, kind: 'engine-out', vehicle: 'booster', engine: 4 });
    const [a, b] = useReplay.getState().scenario.interventions;
    expect([a.t, b.t]).toEqual([60.418, 80.123]);
    expect(a.id).not.toBe(b.id);
  });
});

describe('settings', () => {
  let stored: Record<string, string>;
  beforeEach(() => {
    stored = {};
    vi.stubGlobal('window', {
      matchMedia: (q: string) => ({ matches: q.includes('reduce') }),
      localStorage: {
        getItem: (k: string) => stored[k] ?? null,
        setItem: (k: string, v: string) => {
          stored[k] = v;
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reduce motion follows the system preference until chosen', () => {
    useReplay.getState().hydrateSettings();
    expect(useReplay.getState().settings.reduceMotion).toBe(true);
  });

  it('starts phones on the low-quality 3D view, and keeps a saved choice', () => {
    vi.stubGlobal('window', { ...window, screen: { width: 390, height: 844 } });
    useReplay.getState().hydrateSettings();
    expect(useReplay.getState().settings.quality).toBe('low');
    useReplay.getState().updateSettings({ quality: 'high' });
    expect(JSON.parse(stored['starship-telemetry:settings'])).toEqual({ quality: 'high' });
    useReplay.setState({ settingsLoaded: false });
    useReplay.getState().hydrateSettings();
    expect(useReplay.getState().settings.quality).toBe('high');
  });

  it('keeps the high-quality 3D view on tablets and computers', () => {
    vi.stubGlobal('window', { ...window, screen: { width: 768, height: 1024 } });
    useReplay.getState().hydrateSettings();
    expect(useReplay.getState().settings.quality).toBe('high');
  });

  it('saves only the choices that differ from the defaults', () => {
    useReplay.getState().hydrateSettings();
    useReplay.getState().updateSettings({ speedUnit: 'mph' });
    expect(JSON.parse(stored['starship-telemetry:settings'])).toEqual({ speedUnit: 'mph' });
    useReplay.getState().updateSettings({ reduceMotion: false });
    expect(JSON.parse(stored['starship-telemetry:settings'])).toEqual({ speedUnit: 'mph', reduceMotion: false });
  });
});
