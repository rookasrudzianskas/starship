'use client';

import { useId, useState, useSyncExternalStore } from 'react';
import { SHIP_FLAP_NAMES } from '@/lib/sim/scenario';
import { createSurfaceReadout } from '@/lib/store/surfaceReadout';
import styles from './director.module.css';

/** Actual sampled motion, independent of the selected flap and the uncommitted slider draft. */
export function SurfaceReadout() {
  const [store] = useState(createSurfaceReadout);
  const reading = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const id = useId();
  const hasReading = reading.status === 'ready' || reading.status === 'ended';
  const rollText = reading.roll === null ? '—' : `${reading.roll > 0 ? '+' : reading.roll < 0 ? '−' : ''}${Math.abs(reading.roll).toFixed(1)}°`;
  return (
    <section className={styles.surfaceReadout} aria-label="Starship flight surfaces" aria-live="off">
      <div className={styles.surfaceHead}>
        <span>Flight surfaces</span>
        <span className={styles.surfaceStatus}>
          {reading.status === 'updating' ? 'Updating flight…' : reading.status === 'unavailable' ? 'Unavailable' : reading.status === 'ended' ? 'Flight over' : 'Readback'}
        </span>
      </div>
      <table className={styles.surfaceTable} aria-describedby={`${id}-flap-key`}>
        <caption className="visually-hidden">Starship flap angles in degrees. Actual is the simulated hinge position; commanded is the applied manual target or automatic control.</caption>
        <thead><tr><th scope="col">Flap</th><th scope="col">Actual</th><th scope="col">Commanded</th></tr></thead>
        <tbody>
          {SHIP_FLAP_NAMES.map((name, i) => {
            const actual = reading.actual[i], target = reading.commanded[i];
            return (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>
                  <span className={styles.surfaceActual}>{actual === null ? '—' : `${actual.toFixed(1)}°`}</span>
                  <div className={styles.surfaceBar} aria-hidden="true">
                    {actual !== null ? <span className={styles.surfaceFill} style={{ transform: `scaleX(${Math.min(90, Math.max(0, actual)) / 90})` }} /> : null}
                    {hasReading && target !== null ? <span className={styles.surfaceTarget} style={{ left: `${Math.min(90, Math.max(0, target)) / 90 * 100}%` }} /> : null}
                  </div>
                </td>
                <td className={target !== null ? styles.surfaceCommand : styles.surfaceAuto}>
                  {!hasReading ? '—' : target === null ? <span title="Automatic guidance controls this flap">Auto</span> : `${target}°`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p id={`${id}-flap-key`} className={styles.surfaceKey}>
        0° spread · 90° folded. Bars show actual angles; amber ticks show manual targets.
      </p>
      <dl className={styles.surfaceRoll}>
        <dt>Roll <span>relative to local down</span></dt>
        <dd aria-describedby={`${id}-roll-help`}>
          <span aria-label={reading.roll === null ? hasReading ? 'Roll undefined near vertical' : 'Roll unavailable' : `Roll ${rollText}`}>{rollText}</span>
        </dd>
      </dl>
      <p id={`${id}-roll-help`} className={styles.surfaceKey}>
        Heat shield: 0° down · ±90° side-on · 180° up. Roll is undefined (—) near vertical.
      </p>
    </section>
  );
}
