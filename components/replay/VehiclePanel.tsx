'use client';

import { getFlight } from '@/lib/flights/catalog';
import { formatAltitude, formatEventTime, formatSpeed, formatVerticalSpeed } from '@/lib/format';
import { G0, type EndKind, type VehicleId } from '@/lib/sim/types';
import { isModified, useReplay } from '@/lib/store/replay';
import { countLit, emptyReading, engineStates, isStacked, readVehicle } from '@/lib/telemetry';
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

interface Props {
  vehicle: VehicleId;
  className?: string;
}

export function VehiclePanel({ vehicle, className }: Props) {
  const t = useReplay((s) => s.t);
  const result = useReplay((s) => s.result);
  const baseline = useReplay((s) => s.baseline);
  const scenario = useReplay((s) => s.scenario);
  const settings = useReplay((s) => s.settings);
  const flightN = useReplay((s) => s.flight);
  const directorOpen = useReplay((s) => s.panel === 'director');
  const addIntervention = useReplay((s) => s.addIntervention);
  const flight = getFlight(flightN);
  const right = vehicle === 'ship';
  const id = vehicle === 'booster' ? flight.boosterId : flight.shipId;

  const reading = result ? readVehicle(result, vehicle, t, emptyReading()) : emptyReading();
  const timeline = result ? (vehicle === 'booster' ? result.boosterEngines : result.shipEngines) : null;
  const states = timeline ? engineStates(timeline, t, new Uint8Array(timeline.slots.length)) : new Uint8Array(0);
  const lit = countLit(states);
  const track = result ? (vehicle === 'booster' ? result.booster : result.ship) : null;
  const endKind = track?.endKind ?? (vehicle === 'booster' ? flight.boosterEnd : flight.shipEnd);
  const ended = reading.ended;
  const stackedShip = vehicle === 'ship' && result !== null && isStacked(result, t);

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
      <div className={styles.instruments}>
        <div className={styles.engineBlock}>
          {timeline ? (
            <EngineMap
              vehicle={vehicle}
              slots={timeline.slots}
              states={states}
              onEngineClick={canFail ? (engine) => addIntervention({ t, kind: 'engine-out', vehicle, engine }) : undefined}
            />
          ) : (
            <svg className={styles.engineMap} viewBox="-5 -5 10 10" aria-hidden="true">
              <circle r={4.7} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.3)" strokeWidth={0.12} />
            </svg>
          )}
          <span className={styles.engineCount}>
            {lit} / {timeline?.slots.length ?? (vehicle === 'booster' ? 33 : 6)}
          </span>
        </div>
        <PropellantGauge split={flightN <= 8} lox={reading.lox} ch4={reading.ch4} known={result !== null && t >= -10} />
        <AttitudeDial vehicle={vehicle} pitch={reading.pitch} mirrored={right} />
      </div>
      <div className={styles.derived}>
        Mach {reading.mach.toFixed(2)} · {(reading.accel / G0).toFixed(2)} G · {formatVerticalSpeed(reading.vspeed, settings.speedUnit)}
      </div>
      <div className={styles.outcome}>
        <div className={styles.outcomeTitle}>{OUTCOME_TITLE[vehicle][endKind]}</div>
        <p className={styles.outcomeText}>{outcomeText}</p>
      </div>
    </section>
  );
}
