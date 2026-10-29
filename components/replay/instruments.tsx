'use client';

import { memo } from 'react';
import { ENGINE_FAILED, ENGINE_LIT, type EngineSlot, type VehicleId } from '@/lib/sim/types';
import styles from './replay.module.css';

interface EngineMapProps {
  vehicle: VehicleId;
  slots: EngineSlot[];
  states: Uint8Array;
  /** When set, engines are clickable (flight director). */
  onEngineClick?: (index: number) => void;
}

const COLOR_LIT = '#ffffff';
const COLOR_OFF = 'rgba(255,255,255,0.16)';
const COLOR_FAILED = 'rgba(255,90,78,0.85)';

/** Engine layout seen from below; lit engines white, failed engines red. */
export function EngineMap({ vehicle, slots, states, onEngineClick }: EngineMapProps) {
  const hull = vehicle === 'booster' ? 4.78 : 4.55;
  return (
    <svg
      className={styles.engineMap}
      viewBox="-5 -5 10 10"
      data-interactive={onEngineClick ? '' : undefined}
      role={onEngineClick ? 'group' : 'img'}
      aria-label={onEngineClick ? 'Engines: click one to shut it down' : 'Engines'}
    >
      <circle r={hull} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.32)" strokeWidth={0.12} />
      {slots.map((s, i) => {
        const st = states[i];
        const fill = st === ENGINE_LIT ? COLOR_LIT : st === ENGINE_FAILED ? COLOR_FAILED : COLOR_OFF;
        const r = s.exitRadius * (s.vacuum ? 0.94 : 0.9);
        return (
          <circle
            key={i}
            data-engine={i}
            cx={s.x}
            cy={s.z}
            r={r}
            fill={fill}
            onClick={onEngineClick && st !== ENGINE_FAILED ? () => onEngineClick(i) : undefined}
          >
            {onEngineClick ? <title>{`Engine ${i + 1}${st === ENGINE_FAILED ? ' (failed)' : ''}`}</title> : null}
          </circle>
        );
      })}
    </svg>
  );
}

interface AttitudeProps {
  vehicle: VehicleId;
  pitch: number;
  /** Mirror for the right-hand (ship) panel so "downrange" points the same way on screen. */
  mirrored?: boolean;
}

/** Pitch of the vehicle in the plane of the trajectory: 90° nose up, 0° nose downrange. */
export const AttitudeDial = memo(function AttitudeDial({ vehicle, pitch, mirrored }: AttitudeProps) {
  const rot = mirrored ? pitch - 90 : 90 - pitch;
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
  known: boolean;
}

function pct(f: number): string {
  return `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;
}

/** Propellant remaining: one gauge, or separate LOX/CH4 bars like the early webcasts. */
export function PropellantGauge({ split, lox, ch4, known }: PropellantProps) {
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
}
