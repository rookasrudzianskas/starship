'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { SiteHeader } from '@/components/shell/SiteHeader';
import { FLIGHTS, getFlight, LATEST_FLIGHT } from '@/lib/flights/catalog';
import { flightColor } from '@/lib/flights/palette';
import { formatMonthYear } from '@/lib/format';
import { useSearchParam } from '@/lib/clientState';
import { runSimulation } from '@/lib/sim/client';
import type { Generation, VehicleId } from '@/lib/sim/types';
import { Chart, type Line } from './Chart';
import { buildSeries, METRICS, type MetricId, type Series } from './series';
import styles from './compare.module.css';

type WindowPreset = 'ascent' | 'return' | 'full' | 'entry';

const PRESETS: { id: WindowPreset; label: string }[] = [
  { id: 'ascent', label: 'Ascent' },
  { id: 'return', label: 'Booster return' },
  { id: 'full', label: 'Full flight' },
  { id: 'entry', label: 'Entry & landing' },
];

const GEN_FILTERS: { id: Generation; label: string }[] = [
  { id: 'b1', label: 'Block 1' },
  { id: 'b2', label: 'Block 2' },
  { id: 'v3', label: 'V3' },
];

interface SeriesPair {
  booster: Series;
  ship: Series;
}

function presetWindow(preset: WindowPreset, vehicle: VehicleId, maxEnd: number): { win: [number, number]; alignEnd: boolean } {
  switch (preset) {
    case 'ascent':
      return { win: vehicle === 'booster' ? [-10, 200] : [-10, 560], alignEnd: false };
    case 'return':
      return { win: [130, 480], alignEnd: false };
    case 'entry':
      return { win: [-1500, 20], alignEnd: true };
    case 'full':
      return { win: [-10, maxEnd], alignEnd: false };
  }
}

export function ComparePage() {
  const router = useRouter();
  const [data, setData] = useState<Map<number, SeriesPair>>(new Map());
  const [progress, setProgress] = useState(0);
  const [vehicle, setVehicle] = useState<VehicleId>('ship');
  const [preset, setPreset] = useState<WindowPreset | null>('ascent');
  const [win, setWin] = useState<[number, number]>([-10, 560]);
  const [alignEnd, setAlignEnd] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(FLIGHTS.map((f) => f.n)));
  const urlFlight = Number(useSearchParam('f'));
  const [focusOverride, setFocus] = useState<number | null>(null);
  const focus = focusOverride ?? (FLIGHTS.some((x) => x.n === urlFlight) ? urlFlight : LATEST_FLIGHT);
  const [overlayOne, setOverlayOne] = useState(false);
  const [fade, setFade] = useState(false);
  const [order, setOrder] = useState<MetricId[]>(METRICS.map((m) => m.id));
  const [maximized, setMaximized] = useState<MetricId | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const dragId = useRef<MetricId | null>(null);
  const raceRef = useRef<number>(0);

  // Simulate every flight once, newest first, in the background worker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const order = [...FLIGHTS].sort((a, b) => b.n - a.n);
      for (const f of order) {
        const result = await runSimulation(f.n, { asFlown: true, interventions: [] });
        if (cancelled) return;
        const pair = { booster: buildSeries(result, 'booster'), ship: buildSeries(result, 'ship') };
        setData((prev) => new Map(prev).set(f.n, pair));
        setProgress((p) => p + 1);
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const maxEnd = useMemo(() => {
    let m = 600;
    for (const [n, pair] of data) if (selected.has(n)) m = Math.max(m, pair[vehicle].end);
    return Math.ceil(m / 60) * 60;
  }, [data, selected, vehicle]);

  const applyPreset = (p: WindowPreset, v: VehicleId = vehicle) => {
    const r = presetWindow(p, v, maxEnd);
    setPreset(p);
    setWin(r.win);
    setAlignEnd(r.alignEnd);
  };

  // "Full flight" follows the longest selected flight as results arrive.
  const shownWin: [number, number] = preset === 'full' ? [-10, maxEnd] : win;

  const extent: [number, number] = alignEnd ? [-6000, 60] : [-10, maxEnd];

  const lines: Line[] = useMemo(() => {
    const out: Line[] = [];
    if (overlayOne) {
      const pair = data.get(focus);
      if (pair) {
        const f = getFlight(focus);
        out.push({ series: pair.booster, color: '#ff8a6b', dashed: true, label: `Super Heavy ${f.boosterId}`.trim() });
        out.push({ series: pair.ship, color: '#7ab8ff', dashed: false, label: `Starship ${f.shipId}` });
      }
      return out;
    }
    const ordered = [...data.entries()].filter(([n]) => selected.has(n)).sort((a, b) => (a[0] === focus ? 1 : b[0] === focus ? -1 : a[0] - b[0]));
    for (const [n, pair] of ordered) {
      out.push({ series: pair[vehicle], color: flightColor(n), dashed: false, label: getFlight(n).name });
    }
    return out;
  }, [data, selected, vehicle, overlayOne, focus]);

  const race = () => {
    cancelAnimationFrame(raceRef.current);
    const [a, b] = shownWin;
    const duration = Math.min(14000, Math.max(5000, (b - a) * 12));
    const start = performance.now();
    const step = (now: number) => {
      const f = (now - start) / duration;
      if (f >= 1) {
        setCursor(null);
        return;
      }
      setCursor(a + (b - a) * f);
      raceRef.current = requestAnimationFrame(step);
    };
    raceRef.current = requestAnimationFrame(step);
  };

  useEffect(() => () => cancelAnimationFrame(raceRef.current), []);

  const toggleFlight = (n: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
    setFocus(n);
  };

  const onDrop = (target: MetricId) => (e: DragEvent) => {
    e.preventDefault();
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === target) return;
    setOrder((prev) => {
      const next = prev.filter((id) => id !== from);
      next.splice(next.indexOf(target), 0, from);
      return next;
    });
  };

  const loadingText = progress < FLIGHTS.length ? `Simulating flights · ${progress} of ${FLIGHTS.length}` : null;

  return (
    <>
      <SiteHeader active="compare" />
      <main className={styles.page}>
        <div className={styles.inner}>
          <h1 className={styles.h1}>Flight overlay</h1>
          <p className={styles.lead}>
            Every flight on the same axes, second by second. Pick flights, switch between Starship and Super Heavy, or overlay
            both vehicles of one flight. Drag the window under any chart to move them all, drag charts to reorder them, and
            double-click a chart to see the whole window.
          </p>

          <div className={styles.toolbar}>
            <span className={styles.toolLabel}>Vehicle</span>
            <div className={styles.group}>
              {(['ship', 'booster'] as VehicleId[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={styles.chip}
                  aria-pressed={vehicle === v && !overlayOne}
                  onClick={() => {
                    setVehicle(v);
                    setOverlayOne(false);
                    if (preset) applyPreset(preset, v);
                  }}
                >
                  {v === 'ship' ? 'Starship' : 'Super Heavy'}
                </button>
              ))}
            </div>
            <span className={styles.toolLabel}>Window</span>
            <div className={styles.group}>
              {PRESETS.map((p) => (
                <button key={p.id} type="button" className={styles.chip} aria-pressed={preset === p.id} onClick={() => applyPreset(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className={styles.group}>
              <button type="button" className={styles.chip} onClick={race} disabled={lines.length === 0}>
                Race the window
              </button>
              <button type="button" className={styles.chip} onClick={() => router.push(`/?f=${focus}&t=${Math.max(-10, Math.round(alignEnd ? -10 : shownWin[0]))}`)}>
                Open in replay
              </button>
            </div>
          </div>

          <div className={styles.options}>
            <label className={styles.check}>
              <input type="checkbox" checked={overlayOne} onChange={(e) => setOverlayOne(e.target.checked)} />
              Both vehicles of {getFlight(focus).name}
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={fade} onChange={(e) => setFade(e.target.checked)} />
              Fade lines while engines are off
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={alignEnd}
                onChange={(e) => {
                  setAlignEnd(e.target.checked);
                  setPreset(null);
                  setWin(e.target.checked ? [-1500, 20] : [-10, 560]);
                }}
              />
              Align to the end of each flight
            </label>
          </div>

          <div className={styles.flightsBar}>
            <span className={styles.toolLabel}>Flights</span>
            <div className={styles.group}>
              <button type="button" className={styles.chip} onClick={() => setSelected(new Set(FLIGHTS.map((f) => f.n)))}>
                All
              </button>
              <button type="button" className={styles.chip} onClick={() => setSelected(new Set())}>
                None
              </button>
              {GEN_FILTERS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={styles.chip}
                  onClick={() => setSelected(new Set(FLIGHTS.filter((f) => f.generation === g.id).map((f) => f.n)))}
                >
                  {g.label}
                </button>
              ))}
            </div>
            <span className={styles.hint}>{loadingText ?? `${selected.size} flights. Hover a chart to read values.`}</span>
          </div>
          <div className={styles.flightGrid}>
            {FLIGHTS.map((f) => (
              <button
                key={f.n}
                type="button"
                className={styles.flightChip}
                aria-pressed={selected.has(f.n)}
                data-focus={focus === f.n || undefined}
                data-loading={!data.has(f.n) || undefined}
                onClick={() => toggleFlight(f.n)}
              >
                <i style={{ background: flightColor(f.n) }} />
                <span className={styles.flightChipName}>{f.name}</span>
                <span className={styles.flightChipMeta}>
                  {[f.boosterId, f.shipId].filter(Boolean).join(' / ')} · {formatMonthYear(f.date)}
                </span>
              </button>
            ))}
          </div>

          <div className={styles.charts}>
            {order.map((id) => {
              const metric = METRICS.find((m) => m.id === id);
              if (!metric) return null;
              return (
                <Chart
                  key={id}
                  metric={metric}
                  lines={lines}
                  window={shownWin}
                  extent={extent}
                  alignEnd={alignEnd}
                  fadeUnpowered={fade}
                  cursorT={cursor}
                  maximized={maximized === id}
                  onWindow={(w) => {
                    setPreset(null);
                    setWin(w);
                  }}
                  onToggleMax={() => setMaximized((m) => (m === id ? null : id))}
                  onDragStart={(e) => {
                    dragId.current = id;
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(e) => {
                    if (dragId.current) e.preventDefault();
                  }}
                  onDrop={onDrop(id)}
                />
              );
            })}
          </div>
        </div>
      </main>
    </>
  );
}
