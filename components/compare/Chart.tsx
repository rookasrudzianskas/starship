'use client';

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { IconDrag, IconMaximize } from '@/components/icons';
import { formatEventTime } from '@/lib/format';
import type { Metric, Series } from './series';
import styles from './compare.module.css';

export interface Line {
  series: Series;
  color: string;
  dashed: boolean;
  label: string;
  /** Write the event names next to this line's event markers (the other lines get the markers only). */
  labelEvents?: boolean;
}

interface Props {
  metric: Metric;
  lines: Line[];
  window: [number, number];
  /** Full extent for the window brush. */
  extent: [number, number];
  alignEnd: boolean;
  fadeUnpowered: boolean;
  /** Mark each line's major events. */
  showEvents: boolean;
  cursorT: number | null;
  maximized: boolean;
  onWindow(w: [number, number]): void;
  onToggleMax(): void;
  onDragStart(e: DragEvent): void;
  onDragEnd(e: DragEvent): void;
  onDragOver(e: DragEvent): void;
  onDrop(e: DragEvent): void;
}

const PAD = { left: 52, right: 14, top: 14, bottom: 24 };

/** Tooltip metrics, matching compare.module.css: row height (11 px text at line-height 1.7) and everything else. */
const TIP_ROW = 19;
const TIP_CHROME = 52;

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  const nice = r < 1.5 ? 1 : r < 2.25 ? 2 : r < 3.5 ? 2.5 : r < 7.5 ? 5 : 10;
  return nice * mag;
}

const TIME_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

function timeStep(range: number, target: number): number {
  for (const s of TIME_STEPS) if (range / s <= target) return s;
  return TIME_STEPS[TIME_STEPS.length - 1];
}

/** x value of sample i of a series (aligned to the series end when requested). */
function sampleX(s: Series, i: number, alignEnd: boolean): number {
  return s.t0 + i * s.dt - (alignEnd ? s.end : 0);
}

function valueAt(s: Series, metric: Metric, x: number, alignEnd: boolean): number | null {
  const t = x + (alignEnd ? s.end : 0);
  const f = (t - s.t0) / s.dt;
  if (f < 0 || f > s.n - 1) return null;
  const i = Math.floor(f);
  const a = s.values[metric.id][i];
  const b = s.values[metric.id][Math.min(s.n - 1, i + 1)];
  return a + (b - a) * (f - i);
}

export function Chart(props: Props) {
  const { metric, lines, window: win, extent, alignEnd, fadeUnpowered, showEvents, cursorT, maximized } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 220 });
  const [hoverX, setHoverX] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(200, e.contentRect.width), h: Math.max(120, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const yRange = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const l of lines) {
      const s = l.series;
      const v = s.values[metric.id];
      const i0 = Math.max(0, Math.floor((win[0] + (alignEnd ? s.end : 0) - s.t0) / s.dt));
      const i1 = Math.min(s.n - 1, Math.ceil((win[1] + (alignEnd ? s.end : 0) - s.t0) / s.dt));
      for (let i = i0; i <= i1; i++) {
        if (v[i] < lo) lo = v[i];
        if (v[i] > hi) hi = v[i];
      }
    }
    if (!Number.isFinite(lo)) return [0, 1] as const;
    if (metric.min !== undefined) lo = Math.min(lo, metric.min);
    if (hi - lo < 1e-6) hi = lo + 1;
    const pad = (hi - lo) * 0.06;
    return [metric.min !== undefined && lo >= metric.min ? lo : lo - pad, hi + pad] as const;
  }, [lines, metric, win, alignEnd]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { w, h } = size;
    // Resizing the backing store reallocates it, so only when the size or the pixel ratio changed.
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // The page's own typeface (next/font gives it a generated family name).
    const family = getComputedStyle(canvas).fontFamily;
    const pw = w - PAD.left - PAD.right;
    const ph = h - PAD.top - PAD.bottom;
    const X = (x: number) => PAD.left + ((x - win[0]) / (win[1] - win[0])) * pw;
    const Y = (y: number) => PAD.top + (1 - (y - yRange[0]) / (yRange[1] - yRange[0])) * ph;

    // Grid and axes.
    ctx.font = `10px ${family}`;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    const ys = niceStep(yRange[1] - yRange[0], Math.max(3, Math.round(ph / 42)));
    ctx.textAlign = 'right';
    for (let y = Math.ceil(yRange[0] / ys) * ys; y <= yRange[1] + 1e-9; y += ys) {
      const py = Math.round(Y(y)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(w - PAD.right, py);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(Math.abs(y) >= 1000 ? `${(y / 1000).toFixed(y % 1000 === 0 ? 0 : 1)}k` : metric.format(y), PAD.left - 8, py);
    }
    const xs = timeStep(win[1] - win[0], Math.max(3, Math.round(pw / 90)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let x = Math.ceil(win[0] / xs) * xs; x <= win[1] + 1e-9; x += xs) {
      const px = Math.round(X(x)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, h - PAD.bottom);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(alignEnd ? (x === 0 ? 'End' : formatEventTime(x).replace('T', 'E')) : formatEventTime(x), px, h - PAD.bottom + 7);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(PAD.left, h - PAD.bottom + 0.5);
    ctx.lineTo(w - PAD.right, h - PAD.bottom + 0.5);
    ctx.stroke();

    // Lines.
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top - 2, pw, ph + 4);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const l of lines) {
      const s = l.series;
      const v = s.values[metric.id];
      const off = alignEnd ? s.end : 0;
      const i0 = Math.max(0, Math.floor((win[0] + off - s.t0) / s.dt) - 1);
      const i1 = Math.min(s.n - 1, Math.ceil((win[1] + off - s.t0) / s.dt) + 1);
      if (i1 <= i0) continue;
      const step = Math.max(1, Math.floor((i1 - i0) / (pw * 1.5)));
      ctx.setLineDash(l.dashed ? [5, 4] : []);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = l.color;
      // Draw in runs of equal powered state so unpowered stretches can be faded.
      let i = i0;
      while (i <= i1) {
        const powered = !fadeUnpowered || s.powered[i] === 1;
        ctx.globalAlpha = powered ? 1 : 0.32;
        ctx.beginPath();
        ctx.moveTo(X(sampleX(s, i, alignEnd)), Y(v[i]));
        let j = i;
        while (j < i1) {
          const nj = Math.min(i1, j + step);
          ctx.lineTo(X(sampleX(s, nj, alignEnd)), Y(v[nj]));
          j = nj;
          if (fadeUnpowered && (s.powered[j] === 1) !== powered) break;
        }
        ctx.stroke();
        if (j === i) break;
        i = j;
      }
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    // Event markers: a dot on every line, then names on the emphasised lines wherever they don't collide.
    if (showEvents) {
      const marks: { l: Line; label: string; x: number; y: number }[] = [];
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 1.5;
      for (const l of lines) {
        for (const e of l.series.events) {
          const x = alignEnd ? e.t - l.series.end : e.t;
          if (x < win[0] || x > win[1]) continue;
          const v = valueAt(l.series, metric, x, alignEnd);
          if (v === null) continue;
          ctx.fillStyle = l.color;
          ctx.beginPath();
          ctx.arc(X(x), Y(v), 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          if (l.labelEvents) marks.push({ l, label: e.label, x: X(x), y: Y(v) });
        }
      }
      ctx.font = `9px ${family}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      const taken: [number, number, number, number][] = [];
      for (const m of marks) {
        const tw = ctx.measureText(m.label).width + 6;
        // Above the dot, or below it near the top of the plot.
        const cy = m.y - 13 < PAD.top + 6 ? m.y + 13 : m.y - 13;
        const box: [number, number, number, number] = [m.x - tw / 2, cy - 7, m.x + tw / 2, cy + 7];
        if (taken.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        taken.push(box);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(m.label, m.x, cy);
        ctx.fillStyle = m.l.color;
        ctx.fillText(m.label, m.x, cy);
      }
    }

    // Race cursor or hover line with dots.
    const markX = cursorT ?? (hoverX !== null ? win[0] + ((hoverX - PAD.left) / pw) * (win[1] - win[0]) : null);
    if (markX !== null && markX >= win[0] && markX <= win[1]) {
      const px = X(markX);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, h - PAD.bottom);
      ctx.stroke();
      for (const l of lines) {
        const val = valueAt(l.series, metric, markX, alignEnd);
        if (val === null) continue;
        ctx.fillStyle = l.color;
        ctx.beginPath();
        ctx.arc(px, Y(val), 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }, [size, lines, metric, win, yRange, alignEnd, fadeUnpowered, showEvents, cursorT, hoverX]);

  const hoverValues = useMemo(() => {
    const markX = cursorT ?? (hoverX !== null ? win[0] + ((hoverX - PAD.left) / (size.w - PAD.left - PAD.right)) * (win[1] - win[0]) : null);
    if (markX === null || markX < win[0] || markX > win[1]) return null;
    const rows = lines
      .map((l) => ({ l, v: valueAt(l.series, metric, markX, alignEnd) }))
      .filter((r): r is { l: Line; v: number } => r.v !== null)
      .sort((a, b) => b.v - a.v);
    return { x: markX, rows };
  }, [cursorT, hoverX, lines, metric, win, alignEnd, size.w]);

  // As many rows as the plot's height allows, in two columns on a wide chart, then a count of the rest.
  let tooltip: ReactNode = null;
  if (hoverValues && hoverValues.rows.length > 0) {
    const all = hoverValues.rows;
    const perColumn = Math.max(3, Math.floor((size.h - TIP_CHROME) / TIP_ROW));
    const columns = all.length > perColumn && size.w >= 560 ? 2 : 1;
    const rows = all.length > perColumn * columns ? all.slice(0, perColumn * columns - 1) : all;
    const px = PAD.left + ((hoverValues.x - win[0]) / (win[1] - win[0])) * (size.w - PAD.left - PAD.right);
    tooltip = (
      // Beside the cursor line, on the side with more room.
      <div className={styles.tooltip} style={px > size.w / 2 ? { right: size.w - px + 12 } : { left: px + 12 }}>
        <div className={styles.tooltipTime}>{alignEnd ? `${formatEventTime(hoverValues.x).replace('T', 'E')}` : formatEventTime(hoverValues.x)}</div>
        <div className={styles.tooltipRows} style={{ gridTemplateRows: `repeat(${Math.ceil(rows.length / columns)}, auto)` }}>
          {rows.map(({ l, v }) => (
            <div key={`${l.series.flight}-${l.series.vehicle}`} className={styles.tooltipRow}>
              <i style={{ background: l.color }} />
              <span>{l.label}</span>
              <b>
                {metric.format(v)}
                {metric.unit && metric.unit !== '°' ? ` ${metric.unit}` : metric.unit}
              </b>
            </div>
          ))}
        </div>
        {all.length > rows.length ? <div className={styles.tooltipMore}>+{all.length - rows.length} more</div> : null}
      </div>
    );
  }

  return (
    <section className={styles.chart} data-max={maximized || undefined} onDragOver={props.onDragOver} onDrop={props.onDrop} aria-label={metric.title}>
      <header className={styles.chartHead}>
        <span className={styles.dragHandle} draggable onDragStart={props.onDragStart} onDragEnd={props.onDragEnd} title="Drag to reorder" aria-hidden="true">
          <IconDrag size={14} />
        </span>
        <h3 className={styles.chartTitle}>{metric.title}</h3>
        {metric.unit ? <span className={styles.chartUnit}>{metric.unit}</span> : null}
        <button type="button" className={styles.maxButton} aria-pressed={maximized} aria-label={maximized ? 'Restore chart size' : 'Maximize chart'} onClick={props.onToggleMax}>
          <IconMaximize size={14} />
        </button>
      </header>
      <div
        className={styles.plot}
        ref={wrapRef}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHoverX(e.clientX - rect.left);
        }}
        onPointerLeave={() => setHoverX(null)}
        onDoubleClick={() => props.onWindow(extent)}
      >
        <canvas ref={canvasRef} className={styles.canvas} style={{ width: size.w, height: size.h }} />
        {tooltip}
      </div>
      <WindowBrush window={win} extent={extent} onWindow={props.onWindow} alignEnd={alignEnd} />
    </section>
  );
}

function WindowBrush({ window: win, extent, onWindow, alignEnd }: { window: [number, number]; extent: [number, number]; onWindow(w: [number, number]): void; alignEnd: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'move' | 'l' | 'r'; x0: number; w0: [number, number] } | null>(null);
  const span = extent[1] - extent[0] || 1;
  const left = ((win[0] - extent[0]) / span) * 100;
  const width = ((win[1] - win[0]) / span) * 100;
  const fmt = (x: number) => (alignEnd ? (Math.abs(x) < 0.5 ? 'End' : formatEventTime(x).replace('T', 'E')) : formatEventTime(x));

  /** Main button (or a touch or pen contact) only: a right-click's release goes to the context menu instead. */
  const startDrag = (e: React.PointerEvent, mode: 'move' | 'l' | 'r') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    ref.current?.setPointerCapture(e.pointerId);
    drag.current = { mode, x0: e.clientX, w0: win };
  };
  const endDrag = () => {
    drag.current = null;
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    const dx = ((e.clientX - d.x0) / el.getBoundingClientRect().width) * span;
    let [a, b] = d.w0;
    if (d.mode === 'move') {
      const w = b - a;
      a = Math.min(Math.max(extent[0], a + dx), extent[1] - w);
      b = a + w;
    } else if (d.mode === 'l') a = Math.min(Math.max(extent[0], a + dx), b - 10);
    else b = Math.max(Math.min(extent[1], b + dx), a + 10);
    onWindow([a, b]);
  };

  return (
    <div className={styles.brushRow}>
      <span className={styles.brushLabel}>Window</span>
      <span className={styles.brushTime}>{fmt(win[0])}</span>
      <div className={styles.brush} ref={ref} onPointerMove={onMove} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
        <div className={styles.brushWin} style={{ left: `${left}%`, width: `${width}%` }} onPointerDown={(e) => startDrag(e, 'move')}>
          <span className={styles.brushHandle} data-side="l" onPointerDown={(e) => startDrag(e, 'l')} />
          <span className={styles.brushHandle} data-side="r" onPointerDown={(e) => startDrag(e, 'r')} />
        </div>
      </div>
      <span className={styles.brushTime}>{fmt(win[1])}</span>
    </div>
  );
}
