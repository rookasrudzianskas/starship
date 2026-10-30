'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { IconShare } from '@/components/icons';
import { SiteHeader } from '@/components/shell/SiteHeader';
import { useWebgl2 } from '@/lib/clientState';
import { getFlight } from '@/lib/flights/catalog';
import { formatDate } from '@/lib/format';
import { runSimulation } from '@/lib/sim/client';
import type { FlightEvent } from '@/lib/sim/types';
import { AS_FLOWN, isModified, isSkipping, useReplay, type CameraMode } from '@/lib/store/replay';
import { replayAddress, setReplayAddress } from '@/lib/store/replayAddress';
import { encodeScenario, linkOf, readRunLink, runLinkSearch } from '@/lib/store/runLink';
import { sideBySide } from '@/lib/telemetry';
import { CameraBar, nextEventTime, PlaybackControls, previousEventTime, toggleFullscreen, WEBCAST_SHOTS } from './Controls';
import { DirectorPanel } from './DirectorPanel';
import { FlightPicker } from './FlightPicker';
import { DirectorHint, EventCallout, FlightCard, HelpDialog, LivePanel, SettingsPanel, ShareLinkDialog } from './Panels';
import { Stage, stageHandle } from './Stage';
import { MissionClock, Timeline } from './Timeline';
import { VehiclePanel } from './VehiclePanel';
import styles from './replay.module.css';

const CAMERA_ORDER: CameraMode[] = ['webcast', 'chase', 'free', 'globe'];
const CALLOUT_MS = 4200;
/** Address-bar updates are batched: browsers limit history.replaceState (Safari: 100 calls per 30 s). */
const URL_WRITE_MS = 400;
/** Keys a focused range input uses itself. */
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

/** The page the replay is on: the address bar is only ever written there. */
let replayPath = '/';

function currentUrl(): string {
  return window.location.pathname + window.location.search;
}

/** An old single-page link (/?view=compare): the page of its own is opened instead. */
function redirecting(): boolean {
  return new URLSearchParams(window.location.search).has('view');
}

/** A link to this moment, for sharing: always names the flight, and includes your changes. */
function shareUrl(): string {
  const s = useReplay.getState();
  return window.location.origin + window.location.pathname + runLinkSearch(linkOf(s, true), true);
}

/** Bring the address bar in line with the replay: what it shows, plus the moment while paused. */
function writeUrl(): void {
  // A batched write that lands while leaving for another page must not touch that page's URL.
  if (window.location.pathname !== replayPath) return;
  const s = useReplay.getState();
  const next = replayPath + runLinkSearch(linkOf(s, !s.playing), false);
  setReplayAddress(next);
  if (next !== currentUrl()) window.history.replaceState(null, '', next);
}

/** Show what the address bar asks for. The run already shown keeps playing where it is; another one starts over. */
function applyUrl(): void {
  setReplayAddress(currentUrl());
  const link = readRunLink(window.location.search);
  const st = useReplay.getState();
  const sameRun = link.flight === st.flight && encodeScenario(link.scenario) === encodeScenario(st.scenario);
  const sameMoment = link.t === undefined ? st.playing : !st.playing && Math.abs(link.t - st.t) < 1;
  if (!sameRun || !sameMoment) st.openRun({ flight: link.flight, scenario: sameRun ? st.scenario : link.scenario, t: link.t });
  const shot = WEBCAST_SHOTS.some((s) => s.id === link.shot) ? link.shot : 'auto';
  if (shot !== st.webcastShot) st.setWebcastShot(shot);
  if (link.camera !== useReplay.getState().camera) st.setCamera(link.camera);
  if (link.follow !== st.follow) st.setFollow(link.follow);
  if (link.pip !== st.pip) st.setPip(link.pip);
}

/** Follows navigations that stay on this page: the brand and Replay links, Back and Forward. */
function UrlSync() {
  const search = useSearchParams().toString();
  useEffect(() => {
    if (currentUrl() === replayAddress() || redirecting()) return;
    applyUrl();
  }, [search]);
  return null;
}

export function ReplayApp() {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const flightN = useReplay((s) => s.flight);
  const scenario = useReplay((s) => s.scenario);
  const camera = useReplay((s) => s.camera);
  const reduceMotion = useReplay((s) => s.settings.reduceMotion);
  // The 3D view is split between the vehicles, and titles each half itself.
  const webgl = useWebgl2();
  const split = useReplay(
    (s) => webgl && s.settings.quality !== 'off' && (s.camera === 'chase' || s.camera === 'free') && s.follow === 'both' && s.result !== null && sideBySide(s.result, s.t),
  );
  const [toast, setToast] = useState<string | null>(null);
  const [linkToCopy, setLinkToCopy] = useState<string | null>(null);
  const flight = getFlight(flightN);

  // Arrival, and every return to this page: a URL the replay did not write itself decides what is shown
  // (coming Back to the address the replay last wrote resumes exactly where it was).
  useEffect(() => {
    // Development handle for driving the replay from the console or automated checks.
    if (process.env.NODE_ENV !== 'production') (window as unknown as { __replay?: typeof useReplay }).__replay = useReplay;
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    if (view !== null) {
      params.delete('view');
      const rest = params.toString();
      if (view === 'compare' || view === 'flights' || view === 'about') {
        router.replace(`/${view}${rest ? `?${rest}` : ''}`);
        return;
      }
      window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    }
    replayPath = window.location.pathname;
    useReplay.getState().hydrateSettings();
    if (currentUrl() !== replayAddress()) applyUrl();
  }, [router]);

  // The tab shows the flight. Next's metadata resets the title on every navigation, also within this
  // page (the brand link), so it is put back whenever it changes while the address bar is on the replay.
  useEffect(() => {
    const apply = () => {
      const title = `${getFlight(useReplay.getState().flight).name} · Starship Telemetry`;
      if (window.location.pathname === replayPath && document.title !== title) document.title = title;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    const unsubscribe = useReplay.subscribe((s, p) => {
      if (s.flight !== p.flight) apply();
    });
    return () => {
      observer.disconnect();
      unsubscribe();
    };
  }, []);

  // Keep the address bar in step with the replay; rapid changes (scrubbing while paused) are batched.
  useEffect(() => {
    let timer = 0;
    const flush = () => {
      timer = 0;
      // Writing during a ?view= redirect would cancel that navigation.
      if (!redirecting()) writeUrl();
    };
    const unsubscribe = useReplay.subscribe((s, p) => {
      const changed =
        s.flight !== p.flight ||
        s.scenario !== p.scenario ||
        s.playing !== p.playing ||
        (!s.playing && Math.round(s.t) !== Math.round(p.t)) ||
        s.camera !== p.camera ||
        s.webcastShot !== p.webcastShot ||
        s.follow !== p.follow ||
        s.pip !== p.pip;
      if (changed && !timer) timer = window.setTimeout(flush, URL_WRITE_MS);
    });
    flush();
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, []);

  // Side panels (the flight director) end just above the HUD's vehicle panels, whose height varies with
  // the viewport: publish the distance from the bottom of the replay to the top of the ship panel.
  useEffect(() => {
    const root = rootRef.current;
    const ship = root?.querySelector(`.${CSS.escape(styles.hudShip)}`);
    if (!root || !ship) return;
    const ro = new ResizeObserver(() => {
      const clear = root.getBoundingClientRect().bottom - ship.getBoundingClientRect().top;
      root.style.setProperty('--hud-clear', `${Math.round(clear)}px`);
    });
    ro.observe(root);
    ro.observe(ship);
    return () => ro.disconnect();
  }, []);

  // Run the simulation whenever the flight or the scenario changes.
  useEffect(() => {
    let cancelled = false;
    // Read the store rather than this render: the URL may have changed the run in an effect above.
    const { flight: n, scenario: sc, setLoading } = useReplay.getState();
    setLoading(true);
    Promise.all([runSimulation(n, sc), isModified(sc) ? runSimulation(n, AS_FLOWN) : Promise.resolve(null)])
      .then(([result, base]) => {
        if (cancelled) return;
        useReplay.getState().setResult(result, base ?? result);
      })
      .catch((err: unknown) => {
        // A run superseded by a newer scenario (lib/sim/client.ts rejects it with an AbortError) is not a failure.
        if (cancelled || (err as { name?: unknown } | null)?.name === 'AbortError') return;
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
      useReplay.getState().advance(dt);
      const s = useReplay.getState();
      const t = s.t;
      const forward = t > prevT && t - prevT < 2.5;
      if (s.result && s.playing && forward && s.rate <= 20 && !isSkipping(s)) {
        let crossed: FlightEvent | null = null;
        for (const e of s.result.events) {
          if (e.major && e.t > prevT && e.t <= t) crossed = e;
        }
        if (crossed) {
          s.setCallout(crossed);
          window.clearTimeout(calloutTimer);
          calloutTimer = window.setTimeout(() => useReplay.getState().setCallout(null), CALLOUT_MS);
        }
      } else if (!forward && s.callout && Math.abs(t - prevT) > 2.5) {
        s.setCallout(null);
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
    const url = shareUrl();
    const modified = isModified(useReplay.getState().scenario);
    try {
      if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: `${getFlight(useReplay.getState().flight).name} · Starship Telemetry`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      showToast(modified ? 'Link to your run at this moment copied' : 'Link to this moment copied');
    } catch (err) {
      // Closing the share sheet is not a failure; anything else (no clipboard access) offers the link to copy by hand.
      if ((err as { name?: unknown } | null)?.name === 'AbortError') return;
      setLinkToCopy(url);
    }
  }, [showToast]);

  const selectFlight = useCallback((n: number) => {
    useReplay.getState().setFlight(n);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    /** The button last pressed with the mouse or a finger, until the keyboard moves focus on. */
    let clickedButton: Element | null = null;
    const onPointerDown = (e: PointerEvent) => {
      clickedButton = e.target instanceof Element ? e.target.closest('button') : null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') clickedButton = null;
      // A key a control has already used (the timeline, the engine map) is not a shortcut as well.
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      const key = e.key;
      // Menus and lists handle their own keys. Text fields keep every key but Escape, which closes their
      // panel; sliders keep the keys that move them.
      if (target?.closest('[role="menu"], [role="listbox"]')) return;
      const field = target?.closest('input, textarea, select, [contenteditable="true"]');
      if (field && key !== 'Escape' && !(field instanceof HTMLInputElement && field.type === 'range' && !SLIDER_KEYS.has(key))) return;
      const st = useReplay.getState();
      // The keyboard help is modal: only closing it works while it is open.
      if (st.panel === 'help' && key !== 'Escape' && key !== '?') return;
      let handled = true;
      switch (key) {
        case ' ': {
          // Space presses a button reached with the keyboard. A button just clicked is not pressed again (another
          // engine out, the next speed): Space plays or pauses, as it does in Safari, which does not focus it.
          const button = target?.closest('button');
          if (button && button !== clickedButton) {
            handled = false;
            break;
          }
          st.toggle();
          break;
        }
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
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [share]);

  const vehicles = [flight.boosterId ? `Super Heavy ${flight.boosterId}` : 'Super Heavy', flight.shipId ? `Starship ${flight.shipId}` : 'Starship'];
  // The vehicle names over the view would repeat the split view's own titles. Hidden rather than removed, so the
  // controls keep their places and the shots their framing (Stage.tsx measures these labels).
  const namesStyle: React.CSSProperties | undefined = split ? { visibility: 'hidden' } : undefined;

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
      <Suspense fallback={null}>
        <UrlSync />
      </Suspense>
      <main className={styles.replay} ref={rootRef} aria-label="Flight replay" data-reduce-motion={reduceMotion || undefined}>
        <div className={styles.stage}>
          <Stage />
          <div className={styles.stageLabels} aria-hidden="true" style={namesStyle}>
            <span>{vehicles[0]}</span>
            <span>{vehicles[1]}</span>
          </div>
          {/* A client-side link: coming back finds the 3D view and the replay as they were left. */}
          <Link className={styles.credits} href="/about#credits">
            Imagery NASA · Sentinel-2 cloudless 2016 by EOX (CC BY 4.0)
          </Link>
          {/* Inside the stage: on phones the bar sits at the bottom of the 3D view, above the HUD. */}
          <div className={styles.topBar}>
            <div className={styles.topLabel} style={namesStyle}>
              <span>{vehicles[0]}</span> · <span>{vehicles[1]}</span>
            </div>
            <CameraBar />
            <div className={`${styles.topLabel} ${styles.topRight}`}>
              <span>
                {flight.name} · {formatDate(flight.date)}
              </span>
              {camera === 'globe' ? (
                <>
                  {' · '}
                  <span>Trajectories</span>
                </>
              ) : null}
            </div>
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
        {linkToCopy ? <ShareLinkDialog key={linkToCopy} url={linkToCopy} onClose={() => setLinkToCopy(null)} /> : null}
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
