'use client';

import { create } from 'zustand';
import type { AltUnit, SpeedUnit } from '@/lib/format';
import type { FlightEvent, FlightResult, Intervention, Scenario } from '@/lib/sim/types';
import { LATEST_FLIGHT } from '../flights/catalog';

export type CameraMode = 'webcast' | 'chase' | 'free' | 'globe';
export type FollowMode = 'both' | 'booster' | 'ship';
export type Quality3D = 'high' | 'low' | 'off';
export type Panel = 'none' | 'settings' | 'help' | 'director' | 'live' | 'menu' | 'picker' | 'shots';

export interface Settings {
  speedUnit: SpeedUnit;
  altUnit: AltUnit;
  quality: Quality3D;
  callouts: boolean;
  reduceMotion: boolean;
  showFlown: boolean;
  showPlanned: boolean;
  showCoast: boolean;
  showGates: boolean;
  showLabels: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  speedUnit: 'kmh',
  altUnit: 'km',
  quality: 'high',
  callouts: true,
  reduceMotion: false,
  showFlown: true,
  showPlanned: true,
  showCoast: true,
  showGates: true,
  showLabels: true,
};

/** An intervention as issued by the UI, before it gets an id. */
export type NewIntervention = Intervention extends infer I ? (I extends Intervention ? Omit<I, 'id'> : never) : never;

export const PLAYBACK_RATES = [1, 2, 5, 10, 20, 50, 100] as const;
/** Playback speed while fast-forwarding through a long coast. */
export const COAST_RATE = 120;
/** Normal playback resumes this many seconds before a long coast ends. */
export const COAST_EXIT = 5;

/** The real flight: no changes. */
export const AS_FLOWN: Scenario = { asFlown: true, interventions: [] };

const SETTINGS_KEY = 'starship-telemetry:settings';

/** Defaults for this browser: reduced motion follows the system preference until the viewer chooses. */
function browserDefaults(): Settings {
  let reduceMotion = DEFAULT_SETTINGS.reduceMotion;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // No matchMedia (old browsers, tests): keep the default.
  }
  return { ...DEFAULT_SETTINGS, reduceMotion };
}

function loadSettings(): Settings {
  const defaults = browserDefaults();
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // Storage can be unavailable (private mode); defaults are fine.
  }
  return defaults;
}

function saveSettings(s: Settings): void {
  // Only the choices that differ from this browser's defaults, so a later change of the system
  // preference still applies to everything the viewer never set.
  const defaults = browserDefaults();
  const changed: Partial<Record<keyof Settings, unknown>> = {};
  for (const k of Object.keys(s) as (keyof Settings)[]) if (s[k] !== defaults[k]) changed[k] = s[k];
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(changed));
  } catch {
    // ignore
  }
}

export interface ReplayState {
  flight: number;
  scenario: Scenario;
  /** Result being shown (matches `scenario` once loaded). */
  result: FlightResult | null;
  /** The as-flown run of the same flight, for the planned path and "modified" badges. */
  baseline: FlightResult | null;
  loading: boolean;
  error: string | null;

  t: number;
  playing: boolean;
  rate: number;
  /** Fast-forward through long coasts at COAST_RATE (the "Skip coast" toggle). */
  skipCoasts: boolean;
  /** Wall-clock sync to a live webcast: T+0 as epoch ms. */
  liveLiftoffMs: number | null;
  /**
   * Live sync while the webcast's clock is still before the replay's first moment: that clock, in
   * seconds (the replay holds at its start meanwhile). Null otherwise.
   */
  liveCountdown: number | null;

  camera: CameraMode;
  webcastShot: string;
  follow: FollowMode;
  pip: boolean;
  panel: Panel;
  settings: Settings;
  settingsLoaded: boolean;
  /** Event callout currently shown. */
  callout: FlightEvent | null;

  /** Show flight `n` as flown, from `t` (default: the start). Choosing the flight already shown without a time changes nothing. */
  setFlight(n: number, t?: number): void;
  /** Open a run from a link: always starts over with that flight and scenario, paused at `t` if one is given. */
  openRun(run: { flight: number; scenario?: Scenario; t?: number }): void;
  setResult(result: FlightResult, baseline: FlightResult | null): void;
  setLoading(loading: boolean, error?: string | null): void;
  seek(t: number): void;
  advance(dtSeconds: number): void;
  /** Play; from the start again when at the end. */
  play(): void;
  pause(): void;
  toggle(): void;
  setRate(rate: number): void;
  stepRate(dir: 1 | -1): void;
  setSkipCoasts(on: boolean): void;
  setLive(liftoffMs: number | null): void;
  setCamera(c: CameraMode): void;
  setWebcastShot(id: string): void;
  setFollow(f: FollowMode): void;
  cycleFollow(): void;
  setPip(pip: boolean): void;
  setPanel(p: Panel): void;
  togglePanel(p: Panel): void;
  updateSettings(patch: Partial<Settings>): void;
  hydrateSettings(): void;
  setCallout(e: FlightEvent | null): void;

  addIntervention(i: NewIntervention): void;
  removeIntervention(id: string): void;
  updateScenario(patch: Partial<Omit<Scenario, 'interventions'>>): void;
  resetScenario(): void;
}

let interventionCounter = 0;

/** A fresh id for a command issued in this page. */
export function newInterventionId(): string {
  interventionCounter += 1;
  return `i${Date.now().toString(36)}${interventionCounter}`;
}

const NOT_LIVE = { liveLiftoffMs: null, liveCountdown: null } as const;

function clampTime(t: number, r: FlightResult | null): number {
  if (!r) return Math.max(-10, t);
  return Math.min(Math.max(t, r.tStart), r.tEnd);
}

/**
 * State for starting `flight` under `scenario` at `t`. The same run (same flight and scenario object)
 * keeps its result or pending simulation; any other run reloads, and then the flight or the scenario
 * object differs, which is what makes the replay request the new simulation.
 */
function startRun(s: ReplayState, flight: number, scenario: Scenario, t: number, playing: boolean): Partial<ReplayState> {
  const same = flight === s.flight && scenario === s.scenario;
  return {
    flight,
    scenario,
    ...(same ? { t: clampTime(t, s.result) } : { result: null, baseline: null, loading: true, error: null, t }),
    playing,
    ...NOT_LIVE,
    callout: null,
  };
}

/** The long coast whose fast-forward part contains t: from its start until COAST_EXIT s before its end. */
export function coastAt(r: FlightResult | null, t: number): [number, number] | null {
  if (!r) return null;
  for (const c of r.coasts) if (t >= c[0] && t < c[1] - COAST_EXIT) return c;
  return null;
}

/** True while playback is fast-forwarding through a long coast. */
export function isSkipping(s: Pick<ReplayState, 'playing' | 'skipCoasts' | 'liveLiftoffMs' | 'result' | 't'>): boolean {
  return s.playing && s.skipCoasts && s.liveLiftoffMs === null && coastAt(s.result, s.t) !== null;
}

export const useReplay = create<ReplayState>()((set, get) => ({
  flight: LATEST_FLIGHT,
  scenario: AS_FLOWN,
  result: null,
  baseline: null,
  loading: true,
  error: null,

  t: -10,
  playing: true,
  rate: 1,
  skipCoasts: true,
  liveLiftoffMs: null,
  liveCountdown: null,

  camera: 'webcast',
  webcastShot: 'auto',
  follow: 'both',
  pip: true,
  panel: 'none',
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,
  callout: null,

  setFlight(n, t) {
    if (n === get().flight && t === undefined) return;
    set(startRun(get(), n, AS_FLOWN, t ?? -10, true));
  },

  openRun({ flight, scenario = AS_FLOWN, t }) {
    set(startRun(get(), flight, scenario, t ?? -10, t === undefined));
  },

  setResult(result, baseline) {
    set((s) => ({ result, baseline, loading: false, error: null, t: clampTime(s.t, result) }));
  },

  setLoading(loading, error = null) {
    set({ loading, error });
  },

  seek(t) {
    set((s) => ({ t: clampTime(t, s.result), ...NOT_LIVE }));
  },

  advance(dt) {
    const s = get();
    if (!s.playing || !s.result) return;
    const { tStart, tEnd } = s.result;
    if (s.liveLiftoffMs !== null) {
      const live = (Date.now() - s.liveLiftoffMs) / 1000;
      // The live flight has run past the end of the replay: the sync is over.
      if (live >= tEnd) set({ t: tEnd, playing: false, ...NOT_LIVE });
      else set({ t: Math.max(live, tStart), liveCountdown: live < tStart ? live : null });
      return;
    }
    let t = s.t + dt * s.rate;
    const coast = s.skipCoasts ? coastAt(s.result, s.t) : null;
    // Never past the coast's exit point, so its last seconds and the next event play at the chosen rate.
    if (coast) t = Math.min(s.t + dt * Math.max(COAST_RATE, s.rate), coast[1] - COAST_EXIT);
    if (t >= tEnd) {
      set({ t: tEnd, playing: false });
      return;
    }
    set({ t });
  },

  play() {
    const s = get();
    if (s.result && s.t >= s.result.tEnd - 0.01) set({ t: s.result.tStart, playing: true });
    else set({ playing: true });
  },
  pause() {
    set({ playing: false });
  },
  toggle() {
    if (get().playing) get().pause();
    else get().play();
  },
  setRate(rate) {
    set({ rate, ...NOT_LIVE });
  },
  stepRate(dir) {
    const rates = PLAYBACK_RATES as readonly number[];
    const i = rates.indexOf(get().rate);
    const next = rates[Math.min(rates.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
    set({ rate: next, ...NOT_LIVE });
  },
  setSkipCoasts(skipCoasts) {
    set({ skipCoasts });
  },
  setLive(liftoffMs) {
    set({ liveLiftoffMs: liftoffMs, liveCountdown: null, playing: true, rate: 1 });
  },

  setCamera(camera) {
    set({ camera });
  },
  setWebcastShot(webcastShot) {
    set({ webcastShot, camera: 'webcast' });
  },
  setFollow(follow) {
    set({ follow });
  },
  cycleFollow() {
    const order: FollowMode[] = ['both', 'booster', 'ship'];
    set({ follow: order[(order.indexOf(get().follow) + 1) % order.length] });
  },
  setPip(pip) {
    set({ pip });
  },
  setPanel(panel) {
    set({ panel });
  },
  togglePanel(p) {
    set({ panel: get().panel === p ? 'none' : p });
  },
  updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    saveSettings(settings);
    set({ settings });
  },
  hydrateSettings() {
    if (get().settingsLoaded) return;
    set({ settings: loadSettings(), settingsLoaded: true });
  },
  setCallout(callout) {
    set({ callout });
  },

  addIntervention(i) {
    // Whole milliseconds, so a link to the run (lib/store/runLink.ts) reproduces it exactly.
    const intervention = { ...i, t: Math.round(i.t * 1000) / 1000, id: newInterventionId() } as Intervention;
    const s = get();
    set({
      scenario: { ...s.scenario, interventions: [...s.scenario.interventions, intervention].sort((a, b) => a.t - b.t) },
    });
  },
  removeIntervention(id) {
    const s = get();
    set({ scenario: { ...s.scenario, interventions: s.scenario.interventions.filter((i) => i.id !== id) } });
  },
  updateScenario(patch) {
    const s = get();
    set({ scenario: { ...s.scenario, ...patch } });
  },
  resetScenario() {
    set({ scenario: AS_FLOWN });
  },
}));

export function isModified(s: Scenario): boolean {
  return (
    !s.asFlown ||
    s.interventions.length > 0 ||
    s.boosterRecovery !== undefined ||
    s.shipMission !== undefined ||
    s.payloadCount !== undefined ||
    (s.wind ?? 0) !== 0 ||
    (s.boosterLoad ?? 1) !== 1
  );
}
