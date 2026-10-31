'use client';

import { memo, useId, useMemo, useState, type KeyboardEvent } from 'react';
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

// Static compass marks: one path, shared by both dials, with no per-readout trigonometry.
const ATTITUDE_TICKS = Array.from({ length: 24 }, (_, i) => {
  const a = (i * Math.PI) / 12;
  const inner = i % 3 === 0 ? 15.7 : 16.7;
  return `M ${(Math.sin(a) * inner).toFixed(2)} ${(Math.cos(a) * inner).toFixed(2)} L ${(Math.sin(a) * 17.6).toFixed(2)} ${(Math.cos(a) * 17.6).toFixed(2)}`;
}).join(' ');

/** Pitch of the vehicle in the plane of the trajectory, with downrange to the right on both panels. */
export const AttitudeDial = memo(function AttitudeDial({ vehicle, pitch }: AttitudeProps) {
  const id = useId();
  const clipId = `${id}-clip`;
  const seaId = `${id}-sea`;
  const metalId = `${id}-metal`;
  const rot = 90 - pitch;
  return (
    <div className={styles.attitude}>
      <svg
        className={styles.attitudeDial}
        viewBox="-20 -20 40 40"
        role="img"
        aria-label={`${vehicle === 'booster' ? 'Super Heavy' : 'Starship'} pitch: ${pitch.toFixed(1)} degrees`}
      >
        <defs>
          <clipPath id={clipId}>
            <circle r={18} />
          </clipPath>
          <linearGradient id={seaId} x1="0" y1="0" x2="0" y2="18" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#294566" stopOpacity={0.85} />
            <stop offset="0.55" stopColor="#192c43" stopOpacity={0.85} />
            <stop offset="1" stopColor="#0c1420" stopOpacity={0.9} />
          </linearGradient>
          <linearGradient id={metalId} x1="-2" y1="0" x2="2" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#77818d" />
            <stop offset="0.3" stopColor="#d8dde2" />
            <stop offset="0.52" stopColor="#f4f5f6" />
            <stop offset="0.76" stopColor="#adb6c0" />
            <stop offset="1" stopColor="#626d7a" />
          </linearGradient>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <circle r={18} fill="#080d13" fillOpacity={0.65} />
          <rect x={-18} y={0} width={36} height={18} fill={`url(#${seaId})`} />
          <path d="M -18 0 H 18" stroke="#a9bed3" strokeOpacity={0.45} strokeWidth={0.55} />
          <path d={ATTITUDE_TICKS} fill="none" stroke="#b7c3cf" strokeOpacity={0.32} strokeWidth={0.45} />
        </g>
        <circle r={18} fill="none" stroke="#c2cbd4" strokeOpacity={0.36} strokeWidth={0.65} />
        <g transform={`rotate(${rot.toFixed(1)})`}>
          {vehicle === 'booster' ? (
            <>
              {/* Open hot-stage ring, cylindrical tanks, grid fins and the engine skirt. */}
              <path d="M -1.65 -12.5 H 1.65 V 11.5 L 1.85 12.8 H -1.85 L -1.65 11.5 Z" fill={`url(#${metalId})`} stroke="#d6dde3" strokeOpacity={0.45} strokeWidth={0.25} />
              <path d="M -1.6 -10.8 H 1.6 M -1.6 -7 H 1.6 M -1.6 1 H 1.6 M -1.6 8.8 H 1.6 M -1.7 11.7 H 1.7" stroke="#505c69" strokeOpacity={0.65} strokeWidth={0.35} />
              <path d="M -0.9 -12.2 V -11 M 0 -12.2 V -11 M 0.9 -12.2 V -11" stroke="#343f4c" strokeWidth={0.35} />
              <path d="M -1.7 -10 L -3.2 -9.5 V -8.2 L -1.7 -8.5 Z M 1.7 -10 L 3.2 -9.5 V -8.2 L 1.7 -8.5 Z" fill="#aab4bf" stroke="#dee3e8" strokeWidth={0.2} />
              <path d="M -0.9 -6.8 V 10.8" stroke="#f3f5f7" strokeOpacity={0.65} strokeWidth={0.3} />
              <path d="M -1.2 12.9 V 13.4 M 0 12.9 V 13.5 M 1.2 12.9 V 13.4" stroke="#8b96a3" strokeWidth={0.65} />
            </>
          ) : (
            <>
              {/* Two forward flaps and two larger aft flaps surround the ogive nose and tank body. */}
              <path d="M -1.5 -8 L -3.3 -6.2 L -3.3 -3.2 L -1.9 -4 Z M 1.5 -8 L 3.3 -6.2 L 3.3 -3.2 L 1.9 -4 Z M -1.9 4.6 L -4.2 8.8 V 12.1 L -1.9 11.1 Z M 1.9 4.6 L 4.2 8.8 V 12.1 L 1.9 11.1 Z" fill="#949faa" stroke="#dce2e8" strokeOpacity={0.65} strokeWidth={0.3} />
              <path d="M 0 -13.5 Q -1.9 -10.8 -1.9 -6 V 11.7 H 1.9 V -6 Q 1.9 -10.8 0 -13.5 Z" fill={`url(#${metalId})`} stroke="#d6dde3" strokeOpacity={0.55} strokeWidth={0.25} />
              <path d="M 0 -13.5 Q 1.9 -10.8 1.9 -6 V 11.7 H 0.9 V -7 Q 0.9 -11 0 -13.5 Z" fill="#36414f" fillOpacity={0.75} />
              <path d="M -1.8 -4 H 1.7 M -1.8 1.4 H 1.7 M -1.8 8.8 H 1.7 M -1.8 10.8 H 1.7" stroke="#566371" strokeOpacity={0.6} strokeWidth={0.3} />
              <path d="M -1.1 -5.5 V 10.7 M -3.7 9 L -2.3 6.5 M 3.7 9 L 2.3 6.5" stroke="#e5e9ed" strokeOpacity={0.6} strokeWidth={0.3} />
              <path d="M -1.1 11.8 L -1.4 12.7 H -0.3 L -0.5 11.8 M 0.5 11.8 L 0.3 12.7 H 1.4 L 1.1 11.8" fill="#a3aeba" />
            </>
          )}
        </g>
      </svg>
      <span className={styles.attitudeValue} aria-hidden="true">{Math.round(pitch)}°</span>
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
      <div className={`${styles.propBlock} ${styles.propSplit}`}>
        <div className={styles.propRow}>
          <span className={styles.propLabel}>Propellant</span>
        </div>
        {(
          [
            ['LOX', lox],
            ['CH4', ch4],
          ] as const
        ).map(([label, v]) => (
          <div key={label} className={styles.propTank}>
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
