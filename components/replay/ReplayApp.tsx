'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconShare } from '@/components/icons';
import { SiteHeader } from '@/components/shell/SiteHeader';
import { FLIGHTS, getFlight, LATEST_FLIGHT } from '@/lib/flights/catalog';
import { formatDate } from '@/lib/format';
import { runSimulation } from '@/lib/sim/client';
import type { FlightEvent } from '@/lib/sim/types';
import { isModified, useReplay, type CameraMode, type FollowMode } from '@/lib/store/replay';
import { CameraBar, nextEventTime, PlaybackControls, previousEventTime, toggleFullscreen, WEBCAST_SHOTS } from './Controls';
import { DirectorPanel } from './DirectorPanel';
import { FlightPicker } from './FlightPicker';
import { DirectorHint, EventCallout, FlightCard, HelpDialog, LivePanel, SettingsPanel } from './Panels';
import { Stage, stageHandle } from './Stage';
import { MissionClock, Timeline } from './Timeline';
import { VehiclePanel } from './VehiclePanel';
import styles from './replay.module.css';

const CAMERA_ORDER: CameraMode[] = ['webcast', 'chase', 'free', 'globe'];
const CALLOUT_MS = 4200;

function shareUrl(withTime: boolean): string {
  const s = useReplay.getState();
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('f', String(s.flight));
  if (withTime) url.searchParams.set('t', String(Math.round(s.t)));
  if (s.camera !== 'webcast') url.searchParams.set('cam', s.camera);
  if (s.follow !== 'both') url.searchParams.set('follow', s.follow);
  return url.toString();
}

function readUrlState() {
  const p = new URLSearchParams(window.location.search);
  const f = Number(p.get('f'));
  const t = Number(p.get('t'));
  const cam = p.get('cam') as CameraMode | null;
  const follow = p.get('follow') as FollowMode | null;
  return {
    flight: FLIGHTS.some((x) => x.n === f) ? f : LATEST_FLIGHT,
    t: p.has('t') && Number.isFinite(t) ? t : undefined,
    camera: cam && CAMERA_ORDER.includes(cam) ? cam : null,
    follow: follow && ['both', 'booster', 'ship'].includes(follow) ? follow : null,
    pip: p.get('pip') === '0' ? false : null,
  };
}

function writeUrl() {
  const s = useReplay.getState();
  const url = new URL(window.location.href);
  url.search = '';
  if (s.flight !== LATEST_FLIGHT) url.searchParams.set('f', String(s.flight));
  if (s.camera !== 'webcast') url.searchParams.set('cam', s.camera);
  if (s.follow !== 'both') url.searchParams.set('follow', s.follow);
  if (!s.pip) url.searchParams.set('pip', '0');
  const next = url.pathname + url.search;
  if (next !== window.location.pathname + window.location.search) window.history.replaceState(null, '', next);
}

export function ReplayApp() {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const flightN = useReplay((s) => s.flight);
  const scenario = useReplay((s) => s.scenario);
  const camera = useReplay((s) => s.camera);
  const follow = useReplay((s) => s.follow);
  const pip = useReplay((s) => s.pip);
  const [toast, setToast] = useState<string | null>(null);
  const flight = getFlight(flightN);

  // Initial state from the URL and saved settings.
  useEffect(() => {
    // Development handle for driving the replay from the console or automated checks.
    if (process.env.NODE_ENV !== 'production') (window as unknown as { __replay?: typeof useReplay }).__replay = useReplay;
    const view = new URLSearchParams(window.location.search).get('view');
    if (view === 'compare' || view === 'flights' || view === 'about') {
      router.replace(`/${view}`);
      return;
    }
    const u = readUrlState();
    const st = useReplay.getState();
    st.hydrateSettings();
    st.setFlight(u.flight, u.t);
    if (u.camera) st.setCamera(u.camera);
    if (u.follow) st.setFollow(u.follow);
    if (u.pip !== null) st.setPip(u.pip);
  }, [router]);

  useEffect(() => {
    writeUrl();
    document.title = `${flight.name} · Starship Telemetry`;
  }, [flightN, camera, follow, pip, flight.name]);

  // Run the simulation whenever the flight or the scenario changes.
  useEffect(() => {
    let cancelled = false;
    const st = useReplay.getState();
    st.setLoading(true);
    const modified = isModified(scenario);
    Promise.all([runSimulation(flightN, scenario), modified ? runSimulation(flightN, { asFlown: true, interventions: [] }) : Promise.resolve(null)])
      .then(([result, base]) => {
        if (cancelled) return;
        useReplay.getState().setResult(result, base ?? result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        useReplay.getState().setLoading(false, err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [flightN, scenario]);

  // Clock: advance playback, raise event callouts and drive the 3D stage, once per animation frame.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let prevT = useReplay.getState().t;
    let calloutTimer = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const st = useReplay.getState();
      st.advance(dt);
      const s2 = useReplay.getState();
      const t = s2.t;
      const forward = t > prevT && t - prevT < 2.5;
      if (s2.result && s2.playing && forward && s2.skipUntil === null && s2.rate <= 20) {
        let crossed: FlightEvent | null = null;
        for (const e of s2.result.events) {
          if (e.major && e.t > prevT && e.t <= t) crossed = e;
        }
        if (crossed) {
          s2.setCallout(crossed);
          window.clearTimeout(calloutTimer);
          calloutTimer = window.setTimeout(() => useReplay.getState().setCallout(null), CALLOUT_MS);
        }
      } else if (!forward && s2.callout && Math.abs(t - prevT) > 2.5) {
        s2.setCallout(null);
      }
      prevT = t;
      stageHandle.current?.render(t, dt);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(calloutTimer);
    };
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((cur) => (cur === text ? null : cur)), 2200);
  }, []);

  const share = useCallback(async () => {
    const url = shareUrl(true);
    try {
      if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: `${getFlight(useReplay.getState().flight).name} · Starship Telemetry`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      showToast('Link to this moment copied');
    } catch {
      showToast(url);
    }
  }, [showToast]);

  const selectFlight = useCallback((n: number) => {
    useReplay.getState().setFlight(n);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.getAttribute('role') === 'slider')) return;
      const st = useReplay.getState();
      const key = e.key;
      let handled = true;
      switch (key) {
        case ' ':
          if (target?.closest('button')) {
            handled = false;
            break;
          }
          st.toggle();
          break;
        case 'ArrowLeft':
          st.seek(st.t - (e.shiftKey ? 10 : 1));
          break;
        case 'ArrowRight':
          st.seek(st.t + (e.shiftKey ? 10 : 1));
          break;
        case 'ArrowUp':
          st.stepRate(1);
          break;
        case 'ArrowDown':
          st.stepRate(-1);
          break;
        case '[': {
          const p = previousEventTime(st.result, st.t);
          if (p !== null) st.seek(p);
          break;
        }
        case ']': {
          const n = nextEventTime(st.result, st.t);
          if (n !== null) st.seek(n);
          break;
        }
        case 'Home':
          if (st.result) st.seek(st.result.tStart);
          break;
        case 'End':
          if (st.result) st.seek(st.result.tEnd);
          break;
        case 'c':
        case 'C':
          st.setCamera(CAMERA_ORDER[(CAMERA_ORDER.indexOf(st.camera) + 1) % CAMERA_ORDER.length]);
          break;
        case 'w':
        case 'W': {
          const i = WEBCAST_SHOTS.findIndex((s) => s.id === st.webcastShot);
          st.setWebcastShot(st.camera === 'webcast' ? WEBCAST_SHOTS[(i + 1) % WEBCAST_SHOTS.length].id : st.webcastShot);
          break;
        }
        case 'g':
        case 'G':
          st.setCamera(st.camera === 'globe' ? 'webcast' : 'globe');
          break;
        case 'v':
        case 'V':
          st.cycleFollow();
          break;
        case 'p':
        case 'P':
          st.setPip(!st.pip);
          break;
        case 'r':
        case 'R':
          stageHandle.current?.resetCamera();
          break;
        case 'k':
        case 'K':
          st.togglePanel('director');
          break;
        case 'f':
        case 'F':
          toggleFullscreen(rootRef.current);
          break;
        case 's':
        case 'S':
          void share();
          break;
        case '?':
          st.togglePanel('help');
          break;
        case 'Escape':
          if (st.panel !== 'none') st.setPanel('none');
          else handled = false;
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [share]);

  const globeSuffix = camera === 'globe' ? ' · Trajectories' : '';
  const vehicles = [flight.boosterId ? `Super Heavy ${flight.boosterId}` : 'Super Heavy', flight.shipId ? `Starship ${flight.shipId}` : 'Starship'].join(' · ');

  return (
    <>
      <SiteHeader
        active="replay"
        picker={<FlightPicker onSelect={selectFlight} />}
        actions={
          <button type="button" className="share-button" aria-label="Share this moment (S)" title="Share this moment (S)" onClick={() => void share()} style={shareStyle}>
            <IconShare size={16} />
          </button>
        }
      />
      <main className={styles.replay} ref={rootRef} aria-label="Flight replay">
        <div className={styles.stage}>
          <Stage />
          <div className={styles.stageLabels} aria-hidden="true">
            <span>{flight.boosterId ? `Super Heavy ${flight.boosterId}` : 'Super Heavy'}</span>
            <span>{flight.shipId ? `Starship ${flight.shipId}` : 'Starship'}</span>
          </div>
          <a className={styles.credits} href="/about#credits">
            Imagery NASA · Sentinel-2 cloudless 2016 by EOX (CC BY 4.0)
          </a>
        </div>
        <div className={styles.topBar}>
          <div className={styles.topLabel}>{vehicles}</div>
          <CameraBar />
          <div className={`${styles.topLabel} ${styles.topRight}`}>
            {flight.name} · {formatDate(flight.date)}
            {globeSuffix}
          </div>
        </div>
        <DirectorHint />
        <EventCallout />
        <div className={styles.hud}>
          <VehiclePanel vehicle="booster" className={styles.hudBooster} />
          <div className={styles.center}>
            <MissionClock />
            <Timeline />
            <PlaybackControls fullscreenTarget={() => rootRef.current} />
          </div>
          <VehiclePanel vehicle="ship" className={styles.hudShip} />
        </div>
        <SettingsPanel />
        <LivePanel />
        <HelpDialog />
        <DirectorPanel />
        <FlightCard onSelectFlight={selectFlight} />
        {toast ? (
          <div role="status" style={toastStyle}>
            {toast}
          </div>
        ) : null}
      </main>
    </>
  );
}

const shareStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  display: 'grid',
  placeItems: 'center',
  border: '1px solid var(--line-strong)',
  borderRadius: 'var(--radius)',
};

const toastStyle: React.CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 56,
  transform: 'translateX(-50%)',
  zIndex: 80,
  padding: '8px 14px',
  background: 'var(--panel-solid)',
  border: '1px solid var(--line-strong)',
  borderRadius: 'var(--radius)',
  fontSize: 11,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  maxWidth: 'calc(100% - 32px)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
