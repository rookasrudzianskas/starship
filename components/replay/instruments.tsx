'use client';

import { memo, useMemo, useState, type KeyboardEvent } from 'react';
import { ENGINE_FAILED, ENGINE_LIT, type EngineSlot, type VehicleId } from '@/lib/sim/types';
import styles from './replay.module.css';

interface EngineMapProps {
  vehicle: VehicleId;
  slots: EngineSlot[];
  /** Pass a new array only when the states change: the map is memoised on it. */
  states: Uint8Array;
  /** When set, engines are buttons (flight director): click one, or pick one with the arrow keys and press Enter. */
  onEngineClick?: (index: number) => void;
}

const COLOR_LIT = '#ffffff';
const COLOR_OFF = 'rgba(255,255,255,0.16)';
const COLOR_FAILED = 'rgba(255,90,78,0.85)';

/** Drawn radius of an engine's nozzle, in map units (metres). */
function nozzleRadius(s: EngineSlot): number {
  return s.exitRadius * (s.vacuum ? 0.94 : 0.9);
}

/** Click target per engine: up to 1.6× the nozzle, without reaching into a neighbour's target. */
function targetRadii(slots: EngineSlot[]): number[] {
  return slots.map((s, i) => {
    let room = Infinity;
    for (let j = 0; j < slots.length; j++) {
      if (j !== i) room = Math.min(room, Math.hypot(slots[j].x - s.x, slots[j].z - s.z) / 2);
    }
    return Math.max(nozzleRadius(s), Math.min(room, nozzleRadius(s) * 1.6));
  });
}

/** Engine layout seen from below; lit engines white, failed engines red. */
export const EngineMap = memo(function EngineMap({ vehicle, slots, states, onEngineClick }: EngineMapProps) {
  const hull = vehicle === 'booster' ? 4.78 : 4.55;
  const targets = useMemo(() => targetRadii(slots), [slots]);
  // Roving focus: the map is one Tab stop and the arrow keys move between engines.
  const [focused, setFocused] = useState(0);
  const tabStop = Math.min(focused, slots.length - 1);

  const onKeyDown = (e: KeyboardEvent<SVGGElement>, i: number) => {
    let next = -1;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (i + 1) % slots.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (i - 1 + slots.length) % slots.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = slots.length - 1;
        break;
      case 'Enter':
      case ' ':
        if (states[i] !== ENGINE_FAILED) onEngineClick?.(i);
        break;
      default:
        return;
    }
    // Handled here: keep the replay's global shortcuts (seek, speed, play/pause) out of it.
    e.preventDefault();
    e.stopPropagation();
    if (next >= 0) e.currentTarget.parentElement?.querySelector<SVGGElement>(`[data-engine="${next}"]`)?.focus();
  };

  return (
    <svg
      className={styles.engineMap}
      viewBox="-5 -5 10 10"
      data-interactive={onEngineClick ? '' : undefined}
      role={onEngineClick ? 'group' : 'img'}
      aria-label={onEngineClick ? 'Engines: choose one to shut it down' : 'Engines'}
    >
      <circle r={hull} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.32)" strokeWidth={0.12} />
      {slots.map((s, i) => {
        const st = states[i];
        const fill = st === ENGINE_LIT ? COLOR_LIT : st === ENGINE_FAILED ? COLOR_FAILED : COLOR_OFF;
        if (!onEngineClick) return <circle key={i} cx={s.x} cy={s.z} r={nozzleRadius(s)} fill={fill} />;
        const failed = st === ENGINE_FAILED;
        return (
          <g
            key={i}
            data-engine={i}
            role="button"
            tabIndex={i === tabStop ? 0 : -1}
            aria-disabled={failed || undefined}
            onClick={failed ? undefined : () => onEngineClick(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
            onFocus={() => setFocused(i)}
          >
            <title>{`Engine ${i + 1}${failed ? ' (failed)' : ''}`}</title>
            <circle cx={s.x} cy={s.z} r={targets[i]} fill="transparent" />
            <circle className={styles.nozzle} cx={s.x} cy={s.z} r={nozzleRadius(s)} fill={fill} />
          </g>
        );
      })}
    </svg>
  );
});

interface AttitudeProps {
  vehicle: VehicleId;
  /** Degrees, as in Track.pitch: 90 nose up, 0 nose downrange, 180 nose uprange. */
  pitch: number;
}

/** Pitch of the vehicle in the plane of the trajectory, with downrange to the right on both panels. */
export const AttitudeDial = memo(function AttitudeDial({ vehicle, pitch }: AttitudeProps) {
  const rot = 90 - pitch;
  return (
    <div className={styles.attitude}>
      <svg className={styles.attitudeDial} viewBox="-20 -20 40 40" aria-hidden="true">
        <defs>
          <clipPath id={`dial-${vehicle}`}>
            <circle r={18} />
          </clipPath>
        </defs>
        <g clipPath={`url(#dial-${vehicle})`}>
          <rect x={-20} y={0} width={40} height={20} fill="rgba(255,255,255,0.08)" />
        </g>
        <circle r={18} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={1} />
        <line x1={-18} x2={18} y1={0} y2={0} stroke="rgba(255,255,255,0.25)" strokeWidth={0.8} />
        <g transform={`rotate(${rot.toFixed(1)})`}>
          {vehicle === 'booster' ? (
            <path d="M -1.6 11 L -1.6 -9 L 0 -12.5 L 1.6 -9 L 1.6 11 Z" fill="#fff" />
          ) : (
            <path d="M -1.7 10 L -1.7 -6 Q -1.7 -11 0 -13 Q 1.7 -11 1.7 -6 L 1.7 10 Z M -1.7 9.5 L -4 10.5 L -4 6 L -1.7 5 Z M 1.7 9.5 L 4 10.5 L 4 6 L 1.7 5 Z" fill="#fff" />
          )}
        </g>
      </svg>
      <span className={styles.attitudeValue}>{Math.round(pitch)}°</span>
    </div>
  );
});

interface PropellantProps {
  split: boolean;
  lox: number;
  ch4: number;
  /** False shows '–' and an empty bar, as before liftoff and while the ship rides on the booster. */
  known: boolean;
}

function pct(f: number): string {
  return `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;
}

/** Propellant remaining: one gauge, or separate LOX/CH4 bars like the early webcasts. */
export const PropellantGauge = memo(function PropellantGauge({ split, lox, ch4, known }: PropellantProps) {
  if (split) {
    return (
      <div className={styles.propBlock}>
        <div className={styles.propRow}>
          <span className={styles.propLabel}>Propellant</span>
        </div>
        {(
          [
            ['LOX', lox],
            ['CH4', ch4],
          ] as const
        ).map(([label, v]) => (
          <div key={label}>
            <div className={styles.bar}>
              <div className={styles.barFill} style={{ width: known ? pct(v) : '0%' }} />
            </div>
            <div className={styles.barSub}>
              <span>{label}</span>
              <span>{known ? pct(v) : '–'}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }
  const total = (lox * 3.6 + ch4) / 4.6;
  return (
    <div className={styles.propBlock}>
      <div className={styles.propRow}>
        <span className={styles.propLabel}>Propellant</span>
        <span className={styles.propValue}>{known ? pct(total) : '–'}</span>
      </div>
      <div className={styles.bar}>
        <div className={styles.barFill} style={{ width: known ? pct(total) : '0%' }} />
      </div>
    </div>
  );
});
