'use client';

import { useEffect, useRef, useState } from 'react';
import { useWebgl2 } from '@/lib/clientState';
import { getFlight } from '@/lib/flights/catalog';
import { useReplay } from '@/lib/store/replay';
import type { StageHandle } from '@/lib/three/stage';
import { LineArt } from './LineArt';
import styles from './replay.module.css';

/** The live 3D stage, if one is running. The replay clock calls `render` every frame. */
export const stageHandle: { current: StageHandle | null } = { current: null };

export function Stage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const quality = useReplay((s) => s.settings.quality);
  const settingsLoaded = useReplay((s) => s.settingsLoaded);
  const flightN = useReplay((s) => s.flight);
  const loading = useReplay((s) => s.loading);
  const error = useReplay((s) => s.error);
  const [ready, setReady] = useState(false);
  const [loadError, setFailed] = useState<string | null>(null);
  const webgl = useWebgl2();
  const enabled = settingsLoaded && quality !== 'off' && webgl;
  const failed = !webgl ? 'WebGL 2 is not available, showing the outline instead' : loadError;
  const flight = getFlight(flightN);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let handle: StageHandle | null = null;
    import('@/lib/three/stage')
      .then((m) => {
        if (disposed || !canvasRef.current) return;
        handle = m.createStage(canvasRef.current, {
          onReady: () => !disposed && setReady(true),
          onError: (e) => !disposed && setFailed(e instanceof Error ? e.message : String(e)),
        });
        stageHandle.current = handle;
      })
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      disposed = true;
      if (stageHandle.current === handle) stageHandle.current = null;
      handle?.dispose();
      setReady(false);
    };
  }, [enabled]);

  const showOutline = !enabled || !ready || failed !== null;
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

  return (
    <>
      <canvas ref={canvasRef} className={styles.stageCanvas} style={{ visibility: enabled && !failed ? 'visible' : 'hidden' }} />
      {showOutline ? (
        <div className={styles.lineArtWrap}>
          <LineArt className={styles.lineArt} generation={flight.generation} hotStageRing={flight.n !== 1} />
        </div>
      ) : null}
      {note && showOutline ? <div className={styles.loadingNote}>{note}</div> : null}
    </>
  );
}
