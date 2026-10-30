'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatClock, formatEventTime } from '@/lib/format';
import type { FlightEvent, FlightResult, Track } from '@/lib/sim/types';
import { useReplay } from '@/lib/store/replay';
import { buildTimeAxis, quietGaps, type TimeAxis } from '@/lib/timeAxis';
import { sampleIndex } from '@/lib/telemetry';
import styles from './replay.module.css';

const PROFILE_TOP = 2;
const PROFILE_BOTTOM = 30;
const BASE_Y = 33;
const LABEL_PRIORITY: Record<string, number> = {
  liftoff: 0,
  'ship-end': 1,
  'booster-end': 2,
  entry: 3,
  seco: 4,
  'booster-landing-burn': 5,
  deorbit: 6,
  'ship-landing-burn': 7,
  'orbit-insertion': 8,
  maxq: 9,
  staging: 10,
  'ship-apogee': 11,
  'payload-start': 12,
  relight: 13,
  meco: 14,
  boostback: 15,
  intervention: 16,
};

/** The next major event after t, for the clock's "Next" line. */
export function nextEvent(result: FlightResult | null, t: number): FlightEvent | null {
  if (!result) return null;
  for (const e of result.events) if (e.major && e.t > t + 0.05) return e;
  return null;
}

function altitudeAt(track: Track, t: number): number | null {
  if (t < track.start || t > track.end) return null;
  const i = sampleIndex(track.t, track.n, t);
  const t0 = track.t[i];
  const t1 = track.t[i + 1] ?? t0;
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  return track.alt[i] + ((track.alt[i + 1] ?? track.alt[i]) - track.alt[i]) * f;
}

function profilePath(track: Track, axis: TimeAxis, width: number, maxAlt: number, xFrom = 0, xTo = 1): string {
  const steps = Math.max(60, Math.round(width / 1.5));
  let d = '';
  let pen = false;
  for (let k = 0; k <= steps; k++) {
    const x01 = xFrom + ((xTo - xFrom) * k) / steps;
    const alt = altitudeAt(track, axis.toT(x01));
    if (alt === null) {
      pen = false;
      continue;
    }
    const x = x01 * width;
    const y = PROFILE_BOTTOM - (Math.max(0, alt) / maxAlt) * (PROFILE_BOTTOM - PROFILE_TOP);
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

interface PlacedLabel {
  /** Index of the event in result.events. */
  i: number;
  x: number;
  row: 0 | 1;
  text: string;
  t: number;
  user: boolean;
  align: 'center' | 'left' | 'right';
}

function placeLabels(events: FlightEvent[], axis: TimeAxis, width: number): PlacedLabel[] {
  // 8.5 px uppercase with 0.14em tracking is about 6.6 px per character; keep a gap between labels.
  const charW = 6.6;
  const candidates = events
    .map((e, i) => ({ e, i, x: axis.toX(e.t) * width, w: e.short.length * charW + 14 }))
    .filter((c) => c.e.major)
    .sort((a, b) => (LABEL_PRIORITY[a.e.key] ?? 50) - (LABEL_PRIORITY[b.e.key] ?? 50) || a.e.t - b.e.t);
  const rows: Array<Array<[number, number]>> = [[], []];
  const placed: PlacedLabel[] = [];
  for (const c of candidates) {
    // One label for simultaneous twins (both vehicles terminated together on Flight 1: "FTS" once).
    if (placed.some((p) => p.text === c.e.short && Math.abs(p.t - c.e.t) < 5)) continue;
    let left = c.x - c.w / 2;
    let align: PlacedLabel['align'] = 'center';
    if (left < 0) {
      left = 0;
      align = 'left';
    } else if (left + c.w > width) {
      left = width - c.w;
      align = 'right';
    }
    const right = left + c.w;
    for (const row of [0, 1] as const) {
      if (rows[row].every(([a, b]) => right < a || left > b)) {
        rows[row].push([left, right]);
        placed.push({ i: c.i, x: c.x, row, text: c.e.short, t: c.e.t, user: c.e.key === 'intervention', align });
        break;
      }
    }
  }
  return placed;
}

/** How many events lie at or before t (events are sorted by time). */
function eventsPassed(events: FlightEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function MissionClock() {
  // Display-level values only: the clock re-renders once a second and the next line at each event.
  const second = useReplay((s) => Math.floor(s.liveCountdown ?? s.t));
  const next = useReplay((s) => nextEvent(s.result, s.t));
  const hasResult = useReplay((s) => s.result !== null);
  const tStart = useReplay((s) => s.result?.tStart ?? -10);
  const live = useReplay((s) => s.liveLiftoffMs !== null);
  const waiting = useReplay((s) => s.liveCountdown !== null);
  const loading = useReplay((s) => s.loading);
  const error = useReplay((s) => s.error);
  const { sign, hms } = formatClock(second);
  let line = '';
  if (error && !loading) line = 'Simulation failed';
  else if (loading && !hasResult) line = 'Simulating flight…';
  // Synced to a webcast whose countdown has not reached the replay yet: its clock runs, the replay waits.
  else if (waiting) line = `Replay starts at ${formatEventTime(tStart)}`;
  else if (next) line = `Next · ${next.short} · ${formatEventTime(next.t)}`;
  else if (hasResult) line = 'End of flight';
  return (
    <div>
      <div className={styles.clock} aria-label="Mission clock">
        <span className={styles.clockSign}>{sign}</span>
        <span className={styles.clockTime}>{hms}</span>
      </div>
      <div className={styles.next} aria-live="off" title={error && !loading ? error : undefined} data-error={(error && !loading) || undefined}>
        {live ? <span className={styles.live}>● Live · </span> : null}
        {line}
      </div>
    </div>
  );
}

export function Timeline() {
  const result = useReplay((s) => s.result);
  // How many events the playhead has passed: ticks and labels change colour only when this does.
  const passed = useReplay((s) => (s.result ? eventsPassed(s.result.events, s.t) : 0));
  const seek = useReplay((s) => s.seek);
  const ref = useRef<HTMLDivElement>(null);
  const clipRef = useRef<SVGRectElement>(null);
  const progressRef = useRef<SVGLineElement>(null);
  const headRef = useRef<SVGLineElement>(null);
  const knobRef = useRef<SVGCircleElement>(null);
  const [width, setWidth] = useState(400);
  const [hoverX, setHoverX] = useState<number | null>(null);
  /** The pointer scrubbing the timeline, and whether playback resumes when it lets go. */
  const drag = useRef<{ pointer: number; resume: boolean } | null>(null);
  // React sets the slider's value once; from then on it is written with the playhead below.
  const [firstSecond] = useState(() => Math.floor(useReplay.getState().t));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(120, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const axis = useMemo(
    () =>
      result
        ? buildTimeAxis(result.tStart, result.tEnd, quietGaps(result.events.map((e) => e.t), result.tStart, result.tEnd))
        : buildTimeAxis(-10, 600, []),
    [result],
  );

  const drawing = useMemo(() => {
    if (!result) return null;
    const maxAlt = Math.max(result.records.shipApogee, result.records.boosterApogee, 1000) * 1.05;
    return {
      ship: profilePath(result.ship, axis, width, maxAlt),
      booster: profilePath(result.booster, axis, width, maxAlt),
      labels: placeLabels(result.events, axis, width),
      ticks: result.events.map((e) => ({ x: axis.toX(e.t) * width, major: e.major, user: e.key === 'intervention' })),
    };
  }, [result, axis, width]);

  // The playhead moves every frame, so it is written straight to the SVG instead of re-rendering.
  useLayoutEffect(() => {
    let lastX = NaN;
    let lastSecond = NaN;
    const place = (t: number) => {
      const x = Math.round(axis.toX(t) * width * 10) / 10;
      if (x !== lastX) {
        lastX = x;
        const sx = String(x);
        clipRef.current?.setAttribute('width', sx);
        progressRef.current?.setAttribute('x2', sx);
        headRef.current?.setAttribute('x1', sx);
        headRef.current?.setAttribute('x2', sx);
        knobRef.current?.setAttribute('cx', sx);
      }
      const second = Math.floor(t);
      if (second !== lastSecond && ref.current) {
        lastSecond = second;
        const c = formatClock(second);
        ref.current.setAttribute('aria-valuenow', String(second));
        ref.current.setAttribute('aria-valuetext', `${c.sign}${c.hms}`);
      }
    };
    place(useReplay.getState().t);
    return useReplay.subscribe((s) => place(s.t));
  }, [axis, width]);

  const seekFromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seek(axis.toT((e.clientX - rect.left) / rect.width));
  };

  const endDrag = (pointer: number) => {
    const d = drag.current;
    if (!d || d.pointer !== pointer) return;
    drag.current = null;
    const st = useReplay.getState();
    // Playback paused for the scrub picks up again from where it was let go (unless that is the end).
    if (d.resume && st.result && st.t < st.result.tEnd - 0.01) st.play();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = useReplay.getState().t;
    const step = e.shiftKey ? 10 : 1;
    let handled = true;
    if (e.key === 'ArrowLeft') seek(t - step);
    else if (e.key === 'ArrowRight') seek(t + step);
    else if (e.key === 'PageDown') seek(t - 60);
    else if (e.key === 'PageUp') seek(t + 60);
    else if (e.key === 'Home') seek(axis.tStart);
    else if (e.key === 'End') seek(axis.tEnd);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const hoverT = hoverX !== null ? axis.toT(hoverX / width) : null;

  return (
    <div
      ref={ref}
      className={styles.timeline}
      role="slider"
      tabIndex={0}
      aria-label="Mission timeline"
      aria-valuemin={Math.round(axis.tStart)}
      aria-valuemax={Math.round(axis.tEnd)}
      aria-valuenow={firstSecond}
      aria-valuetext={`${formatClock(firstSecond).sign}${formatClock(firstSecond).hms}`}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        // Main button (or a touch/pen contact) only; a second pointer does not take over.
        if (e.button !== 0 || drag.current) return;
        const st = useReplay.getState();
        drag.current = { pointer: e.pointerId, resume: st.playing };
        if (st.playing) st.pause();
        e.currentTarget.setPointerCapture(e.pointerId);
        seekFromPointer(e);
      }}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setHoverX(Math.min(width, Math.max(0, e.clientX - rect.left)));
        if (drag.current?.pointer === e.pointerId) seekFromPointer(e);
      }}
      onPointerUp={(e) => endDrag(e.pointerId)}
      onPointerCancel={(e) => endDrag(e.pointerId)}
      onLostPointerCapture={(e) => endDrag(e.pointerId)}
      onPointerLeave={() => setHoverX(null)}
    >
      {/* BASE_Y + 1 user units tall and as wide as the element, so one unit is one pixel both ways. */}
      <svg className={styles.timelineSvg} viewBox={`0 0 ${width} ${BASE_Y + 1}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <clipPath id="tl-past">
            <rect ref={clipRef} x={0} y={0} height={BASE_Y + 2} />
          </clipPath>
        </defs>
        {drawing ? (
          <>
            <path d={drawing.ship} fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth={1} />
            <path d={drawing.booster} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
            <g clipPath="url(#tl-past)">
              <path d={drawing.ship} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth={1.2} />
              <path d={drawing.booster} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={1.2} />
            </g>
          </>
        ) : null}
        <line x1={0} x2={width} y1={BASE_Y} y2={BASE_Y} stroke="rgba(255,255,255,0.3)" strokeWidth={1} />
        <line ref={progressRef} x1={0} y1={BASE_Y} y2={BASE_Y} stroke="#fff" strokeWidth={1.5} />
        {drawing?.ticks.map((k, i) => (
          <line
            key={i}
            x1={k.x}
            x2={k.x}
            y1={k.major ? BASE_Y - 7 : BASE_Y - 4}
            y2={BASE_Y}
            stroke={k.user ? 'var(--mod)' : i < passed ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)'}
            strokeWidth={1}
          />
        ))}
        {axis.breaks.map((b) => (
          <g key={b} transform={`translate(${b * width} ${BASE_Y})`}>
            <rect x={-4} y={-5} width={8} height={10} fill="#000" />
            <line x1={-2.5} x2={-2.5} y1={-4} y2={4} stroke="rgba(255,255,255,0.6)" />
            <line x1={2.5} x2={2.5} y1={-4} y2={4} stroke="rgba(255,255,255,0.6)" />
          </g>
        ))}
        <line ref={headRef} y1={0} y2={BASE_Y} stroke="#fff" strokeWidth={1.2} />
        <circle ref={knobRef} cy={BASE_Y} r={4.5} fill="#fff" />
      </svg>
      <div className={styles.timelineLabels}>
        {drawing?.labels.map((l) => (
          <span
            key={l.i}
            className={styles.timelineLabel}
            data-row={l.row}
            data-past={l.i < passed ? '' : undefined}
            data-user={l.user ? '' : undefined}
            style={{
              left: l.align === 'left' ? 0 : l.align === 'right' ? undefined : l.x,
              right: l.align === 'right' ? 0 : undefined,
              transform: l.align === 'center' ? undefined : 'none',
            }}
          >
            {l.text}
          </span>
        ))}
      </div>
      {hoverX !== null && hoverT !== null ? (
        <div className={styles.hoverTip} style={{ left: hoverX }}>
          {formatEventTime(hoverT)}
        </div>
      ) : null}
    </div>
  );
}
