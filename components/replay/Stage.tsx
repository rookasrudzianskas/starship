'use client';

import { useEffect, useRef, useState } from 'react';
import { useWebgl2 } from '@/lib/clientState';
import { getFlight } from '@/lib/flights/catalog';
import { useReplay } from '@/lib/store/replay';
import { prefetchEarthImagery } from '@/lib/three/earth/prefetch';
import type { StageHandle } from '@/lib/three/stage';
import { LineArt } from './LineArt';
import styles from './replay.module.css';

/** The live 3D stage, if one is attached. The replay clock calls `render` every frame. */
export const stageHandle: { current: StageHandle | null } = { current: null };

type CreateStage = typeof import('@/lib/three/stage').createStage;

/**
 * One stage for the whole visit. Leaving the replay (Compare, Flights, About) detaches it rather than throwing it
 * away, so coming back reuses the renderer, the imagery, the models and the compiled shaders. It is disposed when
 * the 3D view is turned off, and replaced when its code is (hot reload in development).
 */
let live: { stage: StageHandle; make: CreateStage } | null = null;

function stageFrom(make: CreateStage): StageHandle {
  if (live && live.make !== make) disposeStage();
  if (!live) live = { stage: make(), make };
  return live.stage;
}

function disposeStage(): void {
  if (!live) return;
  if (stageHandle.current === live.stage) stageHandle.current = null;
  live.stage.dispose();
  live = null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A note over the live view needs a backdrop to stay legible against the sky. */
const overViewStyle: React.CSSProperties = {
  padding: '7px 12px',
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
  color: 'var(--text-2)',
};

/** A flight that takes longer than this to load says so over the view. */
const SLOW_LOAD_MS = 400;

export function Stage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const quality = useReplay((s) => s.settings.quality);
  const settingsLoaded = useReplay((s) => s.settingsLoaded);
  const flightN = useReplay((s) => s.flight);
  const loading = useReplay((s) => s.loading);
  const error = useReplay((s) => s.error);
  const hasResult = useReplay((s) => s.result !== null);
  const [ready, setReady] = useState(false);
  const [loadError, setFailed] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const webgl = useWebgl2();
  const enabled = settingsLoaded && quality !== 'off' && webgl;
  const off = settingsLoaded && quality === 'off';
  const failed = !webgl ? 'WebGL 2 is not available, showing the outline instead' : loadError;
  const flight = getFlight(flightN);

  useEffect(() => {
    const host = hostRef.current;
    if (!enabled || !host) return;
    // The imagery starts downloading before the stage's code has even arrived.
    prefetchEarthImagery();
    let active = true;
    let stage: StageHandle | null = null;
    import('@/lib/three/stage')
      .then((m) => {
        if (!active) return;
        stage = stageFrom(m.createStage);
        stage.canvas.className = styles.stageCanvas;
        stage.attach(host, {
          // A good frame clears any earlier error (a later flight, or a restored graphics context).
          onReady: () => {
            if (!active) return;
            setReady(true);
            setFailed(null);
          },
          onError: (e) => {
            if (active) setFailed(message(e));
          },
        });
        stageHandle.current = stage;
      })
      .catch((e: unknown) => {
        if (active) setFailed(message(e));
      });
    return () => {
      active = false;
      if (stage) {
        if (stageHandle.current === stage) stageHandle.current = null;
        stage.detach(host);
      }
      // Turned off: the next stage starts from the outline. Leaving the page keeps the state for the way back.
      if (useReplay.getState().settings.quality === 'off') {
        setReady(false);
        setFailed(null);
      }
    };
  }, [enabled]);

  // Turning the 3D view off gives its memory back.
  useEffect(() => {
    if (off) disposeStage();
  }, [off]);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => {
      window.clearTimeout(timer);
      setSlow(false);
    };
  }, [loading]);

  // The outline stands in until the view is ready, and when there is nothing to draw (the simulation failed).
  const showOutline = !enabled || !ready || failed !== null || (error !== null && !hasResult);
  const note = !settingsLoaded
    ? ''
    : failed
      ? failed
      : !enabled
        ? '3D view is off'
        : error
          ? `Simulation failed: ${error}`
          : loading
            ? `Loading ${flight.name}`
            : !ready
              ? 'Preparing the 3D view'
              : '';
  // Over a working view only a simulation error, or a flight that is slow to load, is worth a note.
  const showNote = note !== '' && (showOutline || error !== null || (slow && !hasResult));

  return (
    <>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0, visibility: enabled && !failed ? 'visible' : 'hidden' }} />
      {showOutline ? (
        <div className={styles.lineArtWrap}>
          <LineArt className={styles.lineArt} generation={flight.generation} hotStageRing={flight.n !== 1} />
        </div>
      ) : null}
      {showNote ? (
        <div className={styles.loadingNote} style={showOutline ? undefined : overViewStyle}>
          {note}
        </div>
      ) : null}
    </>
  );
}
