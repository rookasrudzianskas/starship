'use client';

import { useEffect, useRef } from 'react';
import { IconChevronDown } from '@/components/icons';
import { FLIGHTS, GENERATIONS, getFlight, type Flight } from '@/lib/flights/catalog';
import { formatDate, formatDateLong } from '@/lib/format';
import { useReplay } from '@/lib/store/replay';
import type { EndKind, Generation } from '@/lib/sim/types';
import styles from './picker.module.css';

const GEN_ORDER: Generation[] = ['v3', 'b2', 'b1'];

function vehicles(f: Flight): string {
  return [f.boosterId, f.shipId].filter(Boolean).join(' / ') || '—';
}

function outcomeClass(end: EndKind): string {
  return end === 'catch' || end === 'splashdown' || end === 'orbit' ? styles.good : styles.bad;
}

interface Props {
  onSelect(n: number): void;
}

export function FlightPicker({ onSelect }: Props) {
  const flightN = useReplay((s) => s.flight);
  const open = useReplay((s) => s.panel === 'picker');
  const setPanel = useReplay((s) => s.setPanel);
  const wrapRef = useRef<HTMLDivElement>(null);
  const flight = getFlight(flightN);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPanel('none');
    };
    window.addEventListener('pointerdown', onDown);
    const current = wrapRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    current?.scrollIntoView({ block: 'nearest' });
    current?.focus();
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open, setPanel]);

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.button}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${flight.name}, ${formatDateLong(flight.date)}. Choose another flight`}
        onClick={() => setPanel(open ? 'none' : 'picker')}
      >
        <span className={styles.name}>{flight.name}</span>
        <span className={styles.date}>{formatDate(flight.date)}</span>
        <span className={styles.vehicles}>{vehicles(flight)}</span>
        <IconChevronDown size={14} className={styles.chevron} />
      </button>
      {open ? (
        <div className={styles.popover} role="listbox" aria-label="Flights">
          {GEN_ORDER.map((gen) => {
            const list = FLIGHTS.filter((f) => f.generation === gen).sort((a, b) => b.n - a.n);
            return (
              <div key={gen} className={styles.group}>
                <div className={styles.groupLabel}>
                  {GENERATIONS[gen].label}
                  <span>{GENERATIONS[gen].blurb}</span>
                </div>
                {list.map((f) => (
                  <button
                    key={f.n}
                    type="button"
                    role="option"
                    aria-selected={f.n === flightN}
                    aria-current={f.n === flightN ? 'true' : undefined}
                    className={styles.option}
                    onClick={() => {
                      setPanel('none');
                      onSelect(f.n);
                    }}
                  >
                    <span className={styles.optName}>{f.name}</span>
                    <span className={styles.optDate}>{formatDate(f.date)}</span>
                    <span className={styles.optVehicles}>{vehicles(f)}</span>
                    <span className={styles.optOutcome} aria-hidden="true">
                      <i className={outcomeClass(f.boosterEnd)} title={`Super Heavy: ${f.boosterEnd}`} />
                      <i className={outcomeClass(f.shipEnd)} title={`Starship: ${f.shipEnd}`} />
                    </span>
                    <span className={styles.optHeadline}>{f.headline}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
