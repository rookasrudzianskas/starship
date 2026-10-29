'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { getFlight } from '@/lib/flights/catalog';
import { formatAltitude, formatEventTime, formatSpeed, formatVerticalSpeed } from '@/lib/format';
import { G0, type EndKind, type VehicleId } from '@/lib/sim/types';
import { isModified, useReplay } from '@/lib/store/replay';
import { countLit, emptyReading, engineChangesBy, engineStatesAfter, isStacked, readVehicle } from '@/lib/telemetry';
import { AttitudeDial, EngineMap, PropellantGauge } from './instruments';
import styles from './replay.module.css';

const NAMES: Record<VehicleId, string> = { booster: 'Super Heavy', ship: 'Starship' };

export const END_LABEL: Record<EndKind, string> = {
  catch: 'Caught',
  splashdown: 'Splashdown',
  impact: 'Impact',
  lost: 'Lost',
  termination: 'Terminated',
  orbit: 'In orbit',
};

const OUTCOME_TITLE: Record<VehicleId, Record<EndKind, string>> = {
  booster: {
    catch: 'Booster catch',
    splashdown: 'Booster splashdown',
    impact: 'Booster impact',
    lost: 'Booster lost',
    termination: 'Flight termination',
    orbit: 'Booster in orbit',
  },
  ship: {
    catch: 'Ship catch',
    splashdown: 'Splashdown',
    impact: 'Ship impact',
    lost: 'Ship lost',
    termination: 'Flight termination',
    orbit: 'Still in orbit',
  },
};

const NO_ENGINES = new Uint8Array(0);

/** How often the panels follow the clock while it runs: live enough, legible, and cheap for React. */
const READOUT_HZ = 15;

/**
 * The replay clock as the panels show it. It follows the store's `t` at most READOUT_HZ times a second: the first
 * change after a pause shows at once and the last one always lands, so a seek is exact. A new result (another
 * flight, a re-simulation) shows at once too, so a panel never reads one flight at another flight's time. Both
 * panels share it and re-render together, instead of on every animation frame.
 */
const readoutClock = (() => {
  let t = useReplay.getInitialState().t;
  let shownAt = -Infinity;
  let timer = 0;
  let unsubscribe: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const show = () => {
    window.clearTimeout(timer);
    timer = 0;
    shownAt = performance.now();
    t = useReplay.getState().t;
    listeners.forEach((l) => l());
  };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (!unsubscribe) {
        t = useReplay.getState().t;
        unsubscribe = useReplay.subscribe((s, prev) => {
          if (s.result !== prev.result) {
            show();
            return;
          }
          if (s.t === prev.t || timer) return;
          const wait = shownAt + 1000 / READOUT_HZ - performance.now();
          if (wait <= 0) show();
          else timer = window.setTimeout(show, wait);
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || !unsubscribe) return;
        unsubscribe();
        unsubscribe = null;
        window.clearTimeout(timer);
        timer = 0;
      };
    },
    get: () => t,
    getServer: () => useReplay.getInitialState().t,
  };
})();

interface Props {
  vehicle: VehicleId;
  className?: string;
}

export function VehiclePanel({ vehicle, className }: Props) {
  const t = useSyncExternalStore(readoutClock.subscribe, readoutClock.get, readoutClock.getServer);
  const result = useReplay((s) => s.result);
  const baseline = useReplay((s) => s.baseline);
  const scenario = useReplay((s) => s.scenario);
  const settings = useReplay((s) => s.settings);
  const flightN = useReplay((s) => s.flight);
  const directorOpen = useReplay((s) => s.panel === 'director');
  const flight = getFlight(flightN);
  const right = vehicle === 'ship';
  const id = vehicle === 'booster' ? flight.boosterId : flight.shipId;

  const reading = result ? readVehicle(result, vehicle, t, emptyReading()) : emptyReading();
  const timeline = result ? (vehicle === 'booster' ? result.boosterEngines : result.shipEngines) : null;
  const engineChanges = timeline ? engineChangesBy(timeline, t) : 0;
  // A new array only when an engine changes state, so the memoised map skips every update in between.
  const states = useMemo(
    () => (timeline ? engineStatesAfter(timeline, engineChanges, new Uint8Array(timeline.slots.length)) : NO_ENGINES),
    [timeline, engineChanges],
  );
  const lit = countLit(states);
  const track = result ? (vehicle === 'booster' ? result.booster : result.ship) : null;
  const endKind = track?.endKind ?? (vehicle === 'booster' ? flight.boosterEnd : flight.shipEnd);
  const ended = reading.ended;
  const stackedShip = vehicle === 'ship' && result !== null && isStacked(result, t);
  const launched = result !== null && t >= 0;

  // Reads the clock when clicked, so the engine fails at the exact time on screen.
  const failEngine = useCallback(
    (engine: number) => {
      const s = useReplay.getState();
      s.addIntervention({ t: s.t, kind: 'engine-out', vehicle, engine });
    },
    [vehicle],
  );

  let modified = false;
  if (result && baseline && isModified(scenario)) {
    const b = readVehicle(baseline, vehicle, t, emptyReading());
    modified = b.ended !== reading.ended || Math.abs(b.alt - reading.alt) > 150 || Math.abs(b.speed - reading.speed) > 3;
  }

  const speed = formatSpeed(reading.speed, settings.speedUnit);
  const alt = formatAltitude(reading.alt, settings.altUnit);
  const dim = stackedShip || ended || !result;
  const canFail = directorOpen && result !== null && !ended && t < (track?.end ?? 0);

  const outcomeText =
    !isModified(scenario) || !track
      ? vehicle === 'booster'
        ? flight.boosterSummary
        : flight.shipSummary
      : `In this run: ${END_LABEL[endKind].toLowerCase()} at ${formatEventTime(track.end)}.`;

  const readouts = (
    <div className={`${styles.readouts} ${dim ? styles.dim : ''}`}>
      <div className={styles.readout}>
        <span className={styles.readoutLabel}>Speed</span>
        <span className={styles.readoutValue}>
          {speed.value}
          <span className={styles.readoutUnit}>{speed.unit}</span>
        </span>
      </div>
      <div className={styles.readout}>
        <span className={styles.readoutLabel}>Altitude</span>
        <span className={styles.readoutValue}>
          {alt.value}
          <span className={styles.readoutUnit}>{alt.unit}</span>
        </span>
      </div>
    </div>
  );

  return (
    <section
      className={`${styles.panel} ${right ? styles.panelRight : ''} ${className ?? ''}`}
      aria-label={NAMES[vehicle]}
    >
      <div className={styles.panelHead}>
        <span className={styles.vehicleName}>
          {right ? (
            <>
              {id ? <span className={styles.vehicleId}>{id}</span> : null}
              {NAMES[vehicle]}
            </>
          ) : (
            <>
              {NAMES[vehicle]}
              {id ? <span className={styles.vehicleId}>{id}</span> : null}
            </>
          )}
        </span>
        {modified ? (
          <span className={`${styles.badge} ${styles.badgeMod}`} title="Flying differently from the real flight because of your changes">
            Mod
          </span>
        ) : null}
        {ended ? <span className={`${styles.badge} ${styles.badgeEnd}`}>{END_LABEL[endKind]}</span> : null}
      </div>
      {readouts}
      <div className={`${styles.instruments} ${dim ? styles.dim : ''}`}>
        <div className={styles.engineBlock}>
          {timeline ? (
            <EngineMap vehicle={vehicle} slots={timeline.slots} states={states} onEngineClick={canFail ? failEngine : undefined} />
          ) : (
            <svg className={styles.engineMap} viewBox="-5 -5 10 10" aria-hidden="true">
              <circle r={4.7} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.3)" strokeWidth={0.12} />
            </svg>
          )}
          <span className={styles.engineCount}>
            {lit} / {timeline?.slots.length ?? (vehicle === 'booster' ? 33 : 6)}
          </span>
        </div>
        {/* Rounded to what the gauges can show, so the memoised instruments skip updates that would change nothing. */}
        <PropellantGauge
          split={flightN <= 8}
          lox={Math.round(reading.lox * 1000) / 1000}
          ch4={Math.round(reading.ch4 * 1000) / 1000}
          known={launched && !stackedShip}
        />
        <AttitudeDial vehicle={vehicle} pitch={Math.round(reading.pitch * 10) / 10} />
      </div>
      {/* Hidden rather than removed before liftoff, so the panel keeps its height when it appears. */}
      <div className={styles.derived} style={launched ? undefined : { visibility: 'hidden' }}>
        Mach {reading.mach.toFixed(2)} · {(reading.accel / G0).toFixed(2)} G · {formatVerticalSpeed(reading.vspeed, settings.speedUnit)}
      </div>
      <div className={styles.outcome}>
        <div className={styles.outcomeTitle}>{OUTCOME_TITLE[vehicle][endKind]}</div>
        <p className={styles.outcomeText}>{outcomeText}</p>
      </div>
    </section>
  );
}
