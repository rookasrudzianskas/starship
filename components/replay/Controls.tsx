'use client';

import { useEffect, useRef, useState } from 'react';
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
import { coastAt, PLAYBACK_RATES, useReplay, type CameraMode, type FollowMode } from '@/lib/store/replay';
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
  const playing = useReplay((s) => s.playing);
  const rate = useReplay((s) => s.rate);
  const t = useReplay((s) => s.t);
  const result = useReplay((s) => s.result);
  const skipping = useReplay((s) => s.skipUntil !== null);
  const panel = useReplay((s) => s.panel);
  const live = useReplay((s) => s.liveLiftoffMs !== null);
  const { toggle, seek, setRate, skipCoast, togglePanel } = useReplay.getState();
  const [isFullscreen, setFullscreen] = useState(false);
  const [directorSeen, setDirectorSeen] = useLocalFlag('starship-telemetry:director-seen', true);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const canSkip = Boolean(result && (coastAt(result, t) || result.coasts.some((c) => c[0] > t)));
  const rates = PLAYBACK_RATES as readonly number[];

  const openDirector = () => {
    togglePanel('director');
    if (!directorSeen) setDirectorSeen(true);
  };

  return (
    <div className={styles.controls}>
      <button
        type="button"
        className={styles.ctl}
        aria-label="Previous event ([)"
        title="Previous event ([)"
        disabled={!result}
        onClick={() => {
          const p = previousEventTime(result, t);
          if (p !== null) seek(p);
        }}
      >
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
      <button
        type="button"
        className={styles.ctl}
        aria-label="Next event (])"
        title="Next event (])"
        disabled={!result || nextEventTime(result, t) === null}
        onClick={() => {
          const n = nextEventTime(result, t);
          if (n !== null) seek(n);
        }}
      >
        <IconNextEvent size={14} />
      </button>
      <button
        type="button"
        className={`${styles.ctl} ${styles.ctlRate}`}
        aria-label="Playback speed (↑ ↓)"
        title="Playback speed (↑ ↓)"
        onClick={() => setRate(rates[(rates.indexOf(rate) + 1) % rates.length])}
      >
        {rate}×
      </button>
      <button
        type="button"
        className={`${styles.ctl} ${styles.ctlText}`}
        aria-label="Fast-forward through long coasts"
        title="Fast-forward through long coasts"
        aria-pressed={skipping}
        disabled={!canSkip}
        onClick={skipCoast}
      >
        Skip coast
      </button>
      <button
        type="button"
        className={`${styles.ctl} ${styles.ctlDirector}`}
        aria-label="Flight director: take control of the simulation (K)"
        title="Flight director: take control of the simulation (K)"
        aria-pressed={panel === 'director'}
        onClick={openDirector}
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
      <button
        type="button"
        className={styles.ctl}
        aria-label="Keyboard shortcuts (?)"
        title="Keyboard shortcuts (?)"
        aria-pressed={panel === 'help'}
        onClick={() => togglePanel('help')}
      >
        <IconHelp size={15} />
      </button>
      <button
        type="button"
        className={styles.ctl}
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

export const WEBCAST_SHOTS: WebcastShot[] = [
  { id: 'auto', label: 'Director', detail: 'Cuts between cameras like the broadcast' },
  { id: 'pad', label: 'Pad camera', detail: 'Low on the launch site, looking up' },
  { id: 'tracking', label: 'Long-range tracker', detail: 'Ground telescope following the climb' },
  { id: 'booster-top', label: 'Booster onboard', detail: 'Super Heavy, looking up at the ship' },
  { id: 'booster-aft', label: 'Booster engines', detail: 'Super Heavy, looking down past the grid fins' },
  { id: 'ship-aft', label: 'Ship aft skirt', detail: 'Starship, looking back along the flap' },
  { id: 'ship-nose', label: 'Ship forward flap', detail: 'Starship, nose camera for entry and landing' },
  { id: 'tower', label: 'Tower camera', detail: 'On the launch tower, for catches' },
  { id: 'buoy', label: 'Splashdown buoy', detail: 'At sea level next to the landing zone' },
];

const CAMERAS: { id: CameraMode; label: string; title: string }[] = [
  { id: 'chase', label: 'Chase', title: 'Behind the vehicle (C)' },
  { id: 'free', label: 'Free', title: 'Free camera: drag to turn, right-drag to pan, scroll or pinch to zoom, double-click to recentre (R resets)' },
  { id: 'globe', label: 'Globe', title: 'The whole Earth (G): drag to turn it, scroll to zoom' },
];

const FOLLOW: { id: FollowMode; label: string; title: string }[] = [
  { id: 'both', label: 'Both', title: 'Both vehicles, side by side after separation (V)' },
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
  const shotLabel = WEBCAST_SHOTS.find((s) => s.id === shot)?.label ?? 'Director';

  useEffect(() => {
    if (!shotsOpen) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setPanel('none');
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [shotsOpen, setPanel]);

  return (
    <div className={styles.cameraBar} role="group" aria-label="Camera and view">
      <div className={styles.camGroup} ref={menuRef}>
        <button
          type="button"
          className={styles.camButton}
          aria-pressed={camera === 'webcast'}
          aria-haspopup="menu"
          aria-expanded={shotsOpen}
          title={`The webcast's cameras: the director cuts between them, or pick one (W). Now: ${shotLabel.toLowerCase()}`}
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
          <div className={styles.shotMenu} role="menu" aria-label="Webcast cameras">
            {WEBCAST_SHOTS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="menuitemradio"
                aria-checked={shot === s.id}
                className={styles.shotItem}
                onClick={() => {
                  setWebcastShot(s.id);
                  setPanel('none');
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
        <button type="button" className={styles.camButton} aria-pressed={pip} title="Picture in picture (P)" onClick={() => setPip(!pip)}>
          PiP
        </button>
      </div>
    </div>
  );
}
