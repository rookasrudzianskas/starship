'use client';

import { create } from 'zustand';
import type { AltUnit, SpeedUnit } from '@/lib/format';
import type { FlightEvent, FlightResult, Intervention, Scenario } from '@/lib/sim/types';
import { LATEST_FLIGHT } from '@/lib/flights/catalog';

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
/** Playback speed used while skipping a long coast. */
export const COAST_RATE = 120;

const SETTINGS_KEY = 'starship-telemetry:settings';

function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // Storage can be unavailable (private mode); defaults are fine.
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
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
  /** Fast-forwarding through the coast that ends at this time. */
  skipUntil: number | null;
  /** Wall-clock sync to a live webcast: T+0 as epoch ms. */
  liveLiftoffMs: number | null;

  camera: CameraMode;
  webcastShot: string;
  follow: FollowMode;
  pip: boolean;
  panel: Panel;
  settings: Settings;
  settingsLoaded: boolean;
  /** Event callout currently shown. */
  callout: FlightEvent | null;

  setFlight(n: number, t?: number): void;
  setResult(result: FlightResult, baseline: FlightResult | null): void;
  setLoading(loading: boolean, error?: string | null): void;
  seek(t: number): void;
  advance(dtSeconds: number): void;
  play(): void;
  pause(): void;
  toggle(): void;
  setRate(rate: number): void;
  stepRate(dir: 1 | -1): void;
  skipCoast(): void;
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

function clampTime(t: number, r: FlightResult | null): number {
  if (!r) return Math.max(-10, t);
  return Math.min(Math.max(t, r.tStart), r.tEnd);
}

/** The quiet interval containing t (if any). */
export function coastAt(r: FlightResult | null, t: number): [number, number] | null {
  if (!r) return null;
  for (const c of r.coasts) if (t >= c[0] - 1 && t < c[1] - 5) return c;
  return null;
}

export const useReplay = create<ReplayState>()((set, get) => ({
  flight: LATEST_FLIGHT,
  scenario: { asFlown: true, interventions: [] },
  result: null,
  baseline: null,
  loading: true,
  error: null,

  t: -10,
  playing: true,
  rate: 1,
  skipUntil: null,
  liveLiftoffMs: null,

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
    set({
      flight: n,
      scenario: { asFlown: true, interventions: [] },
      result: null,
      baseline: null,
      loading: true,
      error: null,
      t: t ?? -10,
      playing: true,
      skipUntil: null,
      callout: null,
    });
  },

  setResult(result, baseline) {
    set((s) => ({ result, baseline, loading: false, error: null, t: clampTime(s.t, result) }));
  },

  setLoading(loading, error = null) {
    set({ loading, error });
  },

  seek(t) {
    set((s) => ({ t: clampTime(t, s.result), skipUntil: null, liveLiftoffMs: null }));
  },

  advance(dt) {
    const s = get();
    if (!s.playing || !s.result) return;
    if (s.liveLiftoffMs !== null) {
      set({ t: clampTime((Date.now() - s.liveLiftoffMs) / 1000, s.result) });
      return;
    }
    const rate = s.skipUntil !== null ? Math.max(COAST_RATE, s.rate) : s.rate;
    let t = s.t + dt * rate;
    let skipUntil = s.skipUntil;
    if (skipUntil !== null && t >= skipUntil) {
      t = skipUntil;
      skipUntil = null;
    }
    const end = s.result.tEnd;
    if (t >= end) {
      set({ t: end, playing: false, skipUntil: null });
      return;
    }
    set({ t, skipUntil });
  },

  play() {
    const s = get();
    if (s.result && s.t >= s.result.tEnd - 0.01) set({ t: s.result.tStart });
    set({ playing: true });
  },
  pause() {
    set({ playing: false, skipUntil: null });
  },
  toggle() {
    if (get().playing) get().pause();
    else get().play();
  },
  setRate(rate) {
    set({ rate, liveLiftoffMs: null });
  },
  stepRate(dir) {
    const rates = PLAYBACK_RATES as readonly number[];
    const i = rates.indexOf(get().rate);
    const next = rates[Math.min(rates.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
    set({ rate: next, liveLiftoffMs: null });
  },
  skipCoast() {
    const s = get();
    const c = coastAt(s.result, s.t);
    if (c) {
      set({ skipUntil: c[1] - 5, playing: true, liveLiftoffMs: null });
      return;
    }
    // Not in a coast: jump to the start of the next one.
    const next = s.result?.coasts.find((k) => k[0] > s.t);
    if (next) set({ t: next[0], skipUntil: next[1] - 5, playing: true, liveLiftoffMs: null });
  },
  setLive(liftoffMs) {
    set({ liveLiftoffMs: liftoffMs, playing: true, skipUntil: null, rate: 1 });
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
    interventionCounter += 1;
    const intervention = { ...i, id: `i${Date.now().toString(36)}${interventionCounter}` } as Intervention;
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
    set({ scenario: { asFlown: true, interventions: [] } });
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
