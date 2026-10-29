'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconArrowRight, IconClose, IconDownload } from '@/components/icons';
import { FLIGHTS, getFlight } from '@/lib/flights/catalog';
import { formatAltitude, formatDateLong, formatEventTime, formatSpeed } from '@/lib/format';
import { useLocalFlag } from '@/lib/clientState';
import { downloadCsv } from '@/lib/csv';
import type { FlightEvent } from '@/lib/sim/types';
import { isModified, useReplay, type Settings } from '@/lib/store/replay';
import { END_LABEL } from './VehiclePanel';
import styles from './replay.module.css';

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange(v: T): void; label: string }) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, children }: { checked: boolean; onChange(v: boolean): void; children: ReactNode }) {
  return (
    <label className={styles.toggleRow}>
      <span>{children}</span>
      <button type="button" role="switch" aria-checked={checked} className={styles.switch} onClick={() => onChange(!checked)} />
    </label>
  );
}

/** Close a popover on outside pointer-down (ignoring the button that opened it). */
function useDismiss(open: boolean, onClose: () => void, ignoreSelector: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element;
      if (ref.current?.contains(target) || target.closest(ignoreSelector)) return;
      onClose();
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open, onClose, ignoreSelector]);
  return ref;
}

export function SettingsPanel() {
  const open = useReplay((s) => s.panel === 'settings');
  const settings = useReplay((s) => s.settings);
  const update = useReplay((s) => s.updateSettings);
  const setPanel = useReplay((s) => s.setPanel);
  const ref = useDismiss(open, () => setPanel('none'), '[aria-label="Settings"]');
  if (!open) return null;
  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => update({ [k]: v } as Partial<Settings>);
  return (
    <div className={styles.popover} ref={ref} role="dialog" aria-label="Settings">
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Speed</div>
        <Segmented label="Speed unit" value={settings.speedUnit} onChange={set('speedUnit')} options={[['kmh', 'km/h'], ['mph', 'mph'], ['ms', 'm/s']]} />
      </div>
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Altitude</div>
        <Segmented label="Altitude unit" value={settings.altUnit} onChange={set('altUnit')} options={[['km', 'km'], ['mi', 'mi'], ['ft', 'ft']]} />
      </div>
      <div className={styles.section}>
        <div className={styles.sectionLabel}>3D view</div>
        <Segmented label="3D quality" value={settings.quality} onChange={set('quality')} options={[['high', 'High'], ['low', 'Low'], ['off', 'Off']]} />
      </div>
      <div className={styles.section}>
        <Toggle checked={settings.callouts} onChange={set('callouts')}>
          Event callouts
        </Toggle>
        <Toggle checked={settings.reduceMotion} onChange={set('reduceMotion')}>
          Reduce motion (no camera shake or cuts)
        </Toggle>
      </div>
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Show in 3D</div>
        <Toggle checked={settings.showFlown} onChange={set('showFlown')}>
          Flown path
        </Toggle>
        <Toggle checked={settings.showPlanned} onChange={set('showPlanned')}>
          Real flight’s path when you change the run (white)
        </Toggle>
        <Toggle checked={settings.showCoast} onChange={set('showCoast')}>
          Engines-off coast and impact point
        </Toggle>
        <Toggle checked={settings.showGates} onChange={set('showGates')}>
          Event markers
        </Toggle>
        <Toggle checked={settings.showLabels} onChange={set('showLabels')}>
          Vehicle labels from afar
        </Toggle>
      </div>
      <div className={styles.version}>Starship Telemetry · physics replay v1.0</div>
    </div>
  );
}

const SHORTCUTS: [string[], string][] = [
  [['Space'], 'Play or pause'],
  [['←', '→'], 'Back or forward 1 s (with Shift: 10 s)'],
  [['↑', '↓'], 'Playback speed'],
  [['[', ']'], 'Previous or next event'],
  [['Home', 'End'], 'Start or end of the flight'],
  [['C'], 'Next camera'],
  [['W'], 'Next webcast camera'],
  [['G'], 'Globe view on or off'],
  [['V'], 'Follow both, the booster or the ship'],
  [['P'], 'Small frame on or off'],
  [['R'], 'Reset the free camera (or the globe)'],
  [['K'], 'Flight director: take control'],
  [['F'], 'Full screen'],
  [['S'], 'Copy a link to this moment'],
  [['?'], 'This list'],
];

export function HelpDialog() {
  const open = useReplay((s) => s.panel === 'help');
  const setPanel = useReplay((s) => s.setPanel);
  if (!open) return null;
  return (
    <div className={styles.dialogBackdrop} onPointerDown={(e) => e.target === e.currentTarget && setPanel('none')}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="help-title">
        <h2 className={styles.dialogTitle} id="help-title">
          Keyboard
        </h2>
        <dl className={styles.keys}>
          {SHORTCUTS.map(([keys, text]) => (
            <div key={text} style={{ display: 'contents' }}>
              <dt>
                {keys.map((k) => (
                  <kbd key={k} className={styles.key}>
                    {k}
                  </kbd>
                ))}
              </dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
        <button type="button" className={styles.dialogClose} onClick={() => setPanel('none')} autoFocus>
          Close
        </button>
      </div>
    </div>
  );
}

function parseClock(input: string): number | null {
  const m = input.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function LivePanel() {
  const open = useReplay((s) => s.panel === 'live');
  const live = useReplay((s) => s.liveLiftoffMs);
  const { setLive, setPanel } = useReplay.getState();
  const [sign, setSign] = useState<'-' | '+'>('-');
  const [clock, setClock] = useState('00:05:00');
  const ref = useDismiss(open, () => setPanel('none'), '[aria-label="Sync to a live webcast"]');
  if (!open) return null;
  const seconds = parseClock(clock);
  return (
    <div className={styles.popover} ref={ref} role="dialog" aria-label="Sync to a live webcast">
      <div className={styles.sectionLabel}>Sync to a live webcast</div>
      <p className={styles.cardLineText} style={{ marginTop: 0 }}>
        Type the clock the webcast shows right now. The replay then runs on the same mission clock, so the simulated
        flight plays alongside the real one.
      </p>
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <Segmented<'-' | '+'> label="Before or after liftoff" value={sign} onChange={setSign} options={[['-', 'T−'], ['+', 'T+']]} />
        <input
          aria-label="Webcast clock (hh:mm:ss)"
          value={clock}
          onChange={(e) => setClock(e.target.value)}
          inputMode="numeric"
          style={{
            flex: 1,
            height: 32,
            padding: '0 10px',
            background: 'transparent',
            border: '1px solid var(--line-strong)',
            borderRadius: 2,
            color: 'var(--text)',
            font: 'inherit',
            fontSize: 14,
            letterSpacing: '0.08em',
          }}
        />
      </div>
      <div className={styles.cardActions}>
        <button
          type="button"
          className={`${styles.ctl} ${styles.ctlText}`}
          disabled={seconds === null}
          onClick={() => {
            if (seconds === null) return;
            const nowT = sign === '-' ? -seconds : seconds;
            setLive(Date.now() - nowT * 1000);
            setPanel('none');
          }}
        >
          Sync now
        </button>
        {live !== null ? (
          <button type="button" className={`${styles.ctl} ${styles.ctlText}`} onClick={() => setLive(null)}>
            Stop sync
          </button>
        ) : null}
      </div>
    </div>
  );
}

function calloutTitle(e: FlightEvent): string {
  return e.label;
}

/** Big centred title when playback crosses a major event. */
export function EventCallout() {
  const callout = useReplay((s) => s.callout);
  const settings = useReplay((s) => s.settings);
  if (!callout || !settings.callouts) return null;
  const who = callout.vehicle === 'booster' ? 'Super Heavy' : callout.vehicle === 'ship' ? 'Starship' : 'Stack';
  const speed = formatSpeed(callout.speed, settings.speedUnit);
  const alt = formatAltitude(callout.alt, settings.altUnit);
  return (
    <div className={styles.callout} key={`${callout.key}-${callout.t}`} aria-live="polite">
      <h2 className={styles.calloutTitle}>{calloutTitle(callout)}</h2>
      <div className={styles.calloutSub}>
        {formatEventTime(callout.t)} · {who} {speed.value} {speed.unit} · {alt.value} {alt.unit}
        {callout.note ? ` · ${callout.note}` : ''}
      </div>
    </div>
  );
}

const HINT_KEY = 'starship-telemetry:hint-dismissed';

export function DirectorHint() {
  const [dismissed, setDismissed] = useLocalFlag(HINT_KEY, true);
  const togglePanel = useReplay((s) => s.togglePanel);
  if (dismissed) return null;
  const dismiss = () => setDismissed(true);
  return (
    <div className={styles.hint} role="note">
      <span>
        <strong>Fly it yourself.</strong> Fail engines, throttle, stage early or change the landing.{' '}
        <button
          type="button"
          className={styles.hintAction}
          style={{ width: 'auto', height: 'auto', display: 'inline' }}
          onClick={() => {
            togglePanel('director');
            dismiss();
          }}
        >
          Open the flight director (K)
        </button>
      </span>
      <button type="button" aria-label="Hide this note" onClick={dismiss}>
        <IconClose size={14} />
      </button>
    </div>
  );
}

/** Summary card shown when playback reaches the end of the flight. */
export function FlightCard({ onSelectFlight }: { onSelectFlight(n: number): void }) {
  const t = useReplay((s) => s.t);
  const result = useReplay((s) => s.result);
  const playing = useReplay((s) => s.playing);
  const scenario = useReplay((s) => s.scenario);
  const flightN = useReplay((s) => s.flight);
  const seek = useReplay((s) => s.seek);
  const play = useReplay((s) => s.play);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  if (!result || playing || t < result.tEnd - 0.05) return null;
  const cardKey = `${result.flight}-${result.scenarioKey}`;
  if (dismissedAt === cardKey) return null;
  const flight = getFlight(flightN);
  const modified = isModified(scenario);
  const other = FLIGHTS.find((f) => f.n === flightN - 1) ?? FLIGHTS.find((f) => f.n === flightN + 1) ?? null;
  const boosterLine = modified
    ? `${END_LABEL[result.booster.endKind]} at ${formatEventTime(result.booster.end)} in this run.`
    : flight.boosterSummary;
  const shipLine = modified ? `${END_LABEL[result.ship.endKind]} at ${formatEventTime(result.ship.end)} in this run.` : flight.shipSummary;
  return (
    <div className={styles.card} role="dialog" aria-labelledby="flight-card-title">
      <button type="button" className={styles.cardClose} aria-label="Close" onClick={() => setDismissedAt(cardKey)}>
        <IconClose size={16} />
      </button>
      <div className={styles.cardMeta}>
        {formatDateLong(flight.date)} · {flight.generationLabel}
        {modified ? ' · your run' : ''}
      </div>
      <h2 className={styles.cardTitle} id="flight-card-title">
        {flight.name}
      </h2>
      <div className={styles.cardLine}>
        <div className={styles.cardLineHead}>
          Super Heavy {flight.boosterId} · {END_LABEL[result.booster.endKind]}
        </div>
        <p className={styles.cardLineText}>{boosterLine}</p>
      </div>
      <div className={styles.cardLine}>
        <div className={styles.cardLineHead}>
          Starship {flight.shipId} · {END_LABEL[result.ship.endKind]}
        </div>
        <p className={styles.cardLineText}>{shipLine}</p>
      </div>
      <div className={styles.cardActions}>
        <button
          type="button"
          className={`${styles.ctl} ${styles.ctlText}`}
          onClick={() => {
            seek(result.tStart);
            play();
          }}
        >
          Replay
        </button>
        <Link className={`${styles.ctl} ${styles.ctlText}`} href={`/compare?f=${flight.n}`}>
          Compare
        </Link>
        {other ? (
          <button type="button" className={`${styles.ctl} ${styles.ctlText}`} onClick={() => onSelectFlight(other.n)}>
            {other.name} <IconArrowRight size={12} style={{ marginLeft: 6, verticalAlign: '-2px' }} />
          </button>
        ) : null}
        <button type="button" className={`${styles.ctl} ${styles.ctlText}`} onClick={() => downloadCsv(result, flight.name)}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <IconDownload size={13} /> CSV
          </span>
        </button>
      </div>
    </div>
  );
}
