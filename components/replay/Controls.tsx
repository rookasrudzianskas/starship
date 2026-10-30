'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  IconCaret,
  IconDirector,
  IconExitFullscreen,
  IconFullscreen,
  IconGear,
  IconHelp,
  IconLive,
  IconNextEvent,
  IconPause,
  IconPlay,
  IconPrevEvent,
} from '@/components/icons';
import { useLocalFlag } from '@/lib/clientState';
import type { FlightResult } from '@/lib/sim/types';
import { COAST_RATE, isSkipping, PLAYBACK_RATES, useReplay, type CameraMode, type FollowMode } from '@/lib/store/replay';
import { rovingFocus } from './a11y';
import styles from './replay.module.css';

/** Seconds before an event that the event buttons jump to. */
const LEAD = 3;

export function previousEventTime(result: FlightResult | null, t: number): number | null {
  if (!result) return null;
  let best: number | null = null;
  for (const e of result.events) {
    if (!e.major) continue;
    const target = Math.max(result.tStart, e.t - LEAD);
    if (target < t - 1) best = target;
  }
  return best ?? result.tStart;
}

export function nextEventTime(result: FlightResult | null, t: number): number | null {
  if (!result) return null;
  for (const e of result.events) {
    if (!e.major) continue;
    const target = Math.max(result.tStart, e.t - LEAD);
    if (target > t + 0.5) return target;
  }
  return null;
}

export function toggleFullscreen(el: HTMLElement | null): void {
  if (!el) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.requestFullscreen?.().catch(() => undefined);
}

export function PlaybackControls({ fullscreenTarget }: { fullscreenTarget: () => HTMLElement | null }) {
  // Display-level selections only, so the controls re-render when what they show changes, not every frame.
  const playing = useReplay((s) => s.playing);
  const rate = useReplay((s) => s.rate);
  const hasResult = useReplay((s) => s.result !== null);
  const hasNext = useReplay((s) => nextEventTime(s.result, s.t) !== null);
  const noCoasts = useReplay((s) => s.result !== null && s.result.coasts.length === 0);
  const skipCoasts = useReplay((s) => s.skipCoasts);
  const skipping = useReplay(isSkipping);
  const panel = useReplay((s) => s.panel);
  const live = useReplay((s) => s.liveLiftoffMs !== null);
  const { toggle, seek, setRate, setSkipCoasts, togglePanel } = useReplay.getState();
  const [isFullscreen, setFullscreen] = useState(false);
  const [directorSeen, setDirectorSeen] = useLocalFlag('starship-telemetry:director-seen', true);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Opening the director any way (this button, K or the hint) counts as having seen it.
  useEffect(() => {
    if (panel === 'director' && !directorSeen) setDirectorSeen(true);
  }, [panel, directorSeen, setDirectorSeen]);

  const rates = PLAYBACK_RATES as readonly number[];
  const jump = (to: (result: FlightResult | null, t: number) => number | null) => {
    const st = useReplay.getState();
    const target = to(st.result, st.t);
    if (target !== null) seek(target);
  };

  return (
    <div className={styles.controls}>
      <button type="button" className={styles.ctl} aria-label="Previous event ([)" title="Previous event ([)" disabled={!hasResult} onClick={() => jump(previousEventTime)}>
        <IconPrevEvent size={14} />
      </button>
      <button
        type="button"
        className={`${styles.ctl} ${styles.ctlPlay}`}
        aria-label={playing ? 'Pause (space)' : 'Play (space)'}
        title={playing ? 'Pause (space)' : 'Play (space)'}
        onClick={toggle}
      >
        {playing ? <IconPause size={14} /> : <IconPlay size={15} />}
      </button>
      <button type="button" className={styles.ctl} aria-label="Next event (])" title="Next event (])" disabled={!hasNext} onClick={() => jump(nextEventTime)}>
        <IconNextEvent size={14} />
      </button>
      <button
        type="button"
        className={`${styles.ctl} ${styles.ctlRate}`}
        aria-label={`Playback speed ${rate}×`}
        title="Playback speed (↑ ↓)"
        onClick={() => setRate(rates[(rates.indexOf(rate) + 1) % rates.length])}
      >
        {rate}×
      </button>
      <button
        type="button"
        className={`${styles.ctl} ${styles.ctlText}`}
        aria-pressed={skipCoasts}
        data-active={skipping || undefined}
        title={noCoasts ? 'This flight has no long coasts' : `Fast-forward through long coasts at ${COAST_RATE}× (${skipCoasts ? 'on' : 'off'})`}
        disabled={noCoasts}
        onClick={() => setSkipCoasts(!skipCoasts)}
      >
        Skip coast
      </button>
      <button
        type="button"
        className={`${styles.ctl} ${styles.ctlDirector}`}
        aria-label="Flight director: take control of the simulation (K)"
        title="Flight director: take control of the simulation (K)"
        aria-pressed={panel === 'director'}
        onClick={() => togglePanel('director')}
      >
        <IconDirector size={15} />
        {!directorSeen ? <span className={styles.pulse} aria-hidden="true" /> : null}
      </button>
      <button
        type="button"
        className={styles.ctl}
        aria-label="Sync to a live webcast"
        title="Sync to a live webcast"
        aria-pressed={panel === 'live' || live}
        onClick={() => togglePanel('live')}
      >
        <IconLive size={15} />
      </button>
      <button
        type="button"
        className={styles.ctl}
        aria-label="Settings"
        title="Settings"
        aria-pressed={panel === 'settings'}
        onClick={() => togglePanel('settings')}
      >
        <IconGear size={15} />
      </button>
      {/* Keyboard help and full screen are left out on phones (no keyboard, no element full screen on iPhone). */}
      <button
        type="button"
        className={`${styles.ctl} ${styles.ctlDesk}`}
        aria-label="Keyboard and mouse (?)"
        title="Keyboard and mouse (?)"
        aria-pressed={panel === 'help'}
        onClick={() => togglePanel('help')}
      >
        <IconHelp size={15} />
      </button>
      <button
        type="button"
        className={`${styles.ctl} ${styles.ctlDesk}`}
        aria-label="Full screen (F)"
        title="Full screen (F)"
        onClick={() => toggleFullscreen(fullscreenTarget())}
      >
        {isFullscreen ? <IconExitFullscreen size={15} /> : <IconFullscreen size={15} />}
      </button>
    </div>
  );
}

export interface WebcastShot {
  id: string;
  label: string;
  detail: string;
}

// What each camera does is set in lib/three/stage (cameras.ts, director.ts and the shots in index.ts): keep these
// descriptions in step with it.
export const WEBCAST_SHOTS: WebcastShot[] = [
  { id: 'auto', label: 'Director', detail: 'Cuts between cameras like the broadcast' },
  { id: 'pad', label: 'Pad camera', detail: 'Low on the launch site, looking up' },
  { id: 'tracking', label: 'Long-range tracker', detail: 'Ground telescope, then a chase plane alongside' },
  { id: 'booster-top', label: 'Booster top', detail: 'Super Heavy, looking up between two grid fins' },
  { id: 'booster-aft', label: 'Booster engines', detail: 'Super Heavy, looking down the hull at the engines' },
  { id: 'ship-aft', label: 'Ship aft flap', detail: 'Starship, looking back along the flap' },
  { id: 'ship-nose', label: 'Ship forward flap', detail: 'Starship, looking back from a forward flap' },
  { id: 'tower', label: 'Catch camera', detail: 'Raised beside the pad, facing the tower' },
  { id: 'buoy', label: 'Splashdown buoy', detail: 'At sea level next to the landing zone' },
];

const CAMERAS: { id: CameraMode; label: string; title: string }[] = [
  { id: 'chase', label: 'Chase', title: 'Chase: beside the vehicle; drag to turn round it, scroll or pinch to zoom (R resets)' },
  {
    id: 'free',
    label: 'Free',
    title: 'Free camera: drag to turn, right-drag or two fingers to pan, scroll or pinch to zoom, double-click to recentre (R resets)',
  },
  { id: 'globe', label: 'Globe', title: 'The whole Earth (G): drag to turn it, right-drag or two fingers to tilt, scroll or pinch to zoom, double-click to reset' },
];

const FOLLOW: { id: FollowMode; label: string; title: string }[] = [
  { id: 'both', label: 'Both', title: 'Both vehicles: side by side in the chase and free cameras once they are apart (V)' },
  { id: 'booster', label: 'Booster', title: 'Follow Super Heavy only, the other in a small frame (V)' },
  { id: 'ship', label: 'Ship', title: 'Follow Starship only, the other in a small frame (V)' },
];

export function CameraBar() {
  const camera = useReplay((s) => s.camera);
  const shot = useReplay((s) => s.webcastShot);
  const follow = useReplay((s) => s.follow);
  const pip = useReplay((s) => s.pip);
  const shotsOpen = useReplay((s) => s.panel === 'shots');
  const { setCamera, setWebcastShot, setFollow, setPip, setPanel } = useReplay.getState();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const shotLabel = WEBCAST_SHOTS.find((s) => s.id === shot)?.label ?? 'Director';

  useEffect(() => {
    if (!shotsOpen) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setPanel('none');
    };
    window.addEventListener('pointerdown', onDown);
    menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    return () => window.removeEventListener('pointerdown', onDown);
  }, [shotsOpen, setPanel]);

  const closeMenu = () => {
    setPanel('none');
    triggerRef.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (rovingFocus(e, '[role="menuitemradio"]')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'Tab') {
      setPanel('none');
    }
  };

  return (
    <div className={styles.cameraBar} role="group" aria-label="Camera and view">
      <div className={styles.camGroup} ref={menuRef}>
        <button
          ref={triggerRef}
          type="button"
          className={styles.camButton}
          aria-pressed={camera === 'webcast'}
          aria-haspopup="menu"
          aria-expanded={shotsOpen}
          title={`The webcast's cameras: the director cuts between them, or pick one (W). Drag, scroll or pinch the view to take over with the free camera. Now: ${shotLabel.toLowerCase()}`}
          onClick={() => {
            if (camera !== 'webcast') setCamera('webcast');
            else setPanel(shotsOpen ? 'none' : 'shots');
          }}
        >
          Webcast <IconCaret />
        </button>
        {CAMERAS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={styles.camButton}
            aria-pressed={camera === c.id}
            title={c.title}
            onClick={() => setCamera(c.id)}
          >
            {c.label}
          </button>
        ))}
        {shotsOpen ? (
          <div className={styles.shotMenu} role="menu" aria-label="Webcast cameras" onKeyDown={onMenuKey}>
            {WEBCAST_SHOTS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="menuitemradio"
                aria-checked={shot === s.id}
                tabIndex={shot === s.id ? 0 : -1}
                className={styles.shotItem}
                onClick={() => {
                  setWebcastShot(s.id);
                  closeMenu();
                }}
              >
                {s.label}
                <small>{s.detail}</small>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className={styles.camGroup}>
        {FOLLOW.map((f) => (
          <button
            key={f.id}
            type="button"
            className={styles.camButton}
            aria-pressed={follow === f.id}
            title={f.title}
            onClick={() => setFollow(f.id)}
          >
            {f.label}
          </button>
        ))}
        <button type="button" className={styles.camButton} aria-pressed={pip} title="Picture in picture: a small chase view (P)" onClick={() => setPip(!pip)}>
          PiP
        </button>
      </div>
    </div>
  );
}
