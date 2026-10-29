'use client';

import { useEffect, useState } from 'react';
import { IconClose, IconUndo } from '@/components/icons';
import { getFlight } from '@/lib/flights/catalog';
import { formatEventTime } from '@/lib/format';
import { ENGINE_LIT, type BoosterRecovery, type Intervention, type ShipMission, type VehicleId } from '@/lib/sim/types';
import { isModified, useReplay } from '@/lib/store/replay';
import { engineStates, isStacked } from '@/lib/telemetry';
import styles from './director.module.css';

const VEHICLE_NAME: Record<VehicleId, string> = { booster: 'Super Heavy', ship: 'Starship' };

function describe(i: Intervention, engineCount: (v: VehicleId) => number): string {
  switch (i.kind) {
    case 'engine-out':
      return `${VEHICLE_NAME[i.vehicle]}: engine ${i.engine + 1} of ${engineCount(i.vehicle)} shut down`;
    case 'throttle':
      return `${VEHICLE_NAME[i.vehicle]}: throttle limit ${Math.round(i.value * 100)}%`;
    case 'terminate':
      return `${VEHICLE_NAME[i.vehicle]}: flight termination`;
    case 'stage-now':
      return 'Hot staging commanded';
    case 'pitch':
      return `${VEHICLE_NAME[i.vehicle]}: steering bias ${i.deg > 0 ? '+' : ''}${i.deg}°`;
    case 'skip-burn':
      return `${VEHICLE_NAME[i.vehicle]}: next burn cancelled`;
  }
}

function currentBias(list: Intervention[], vehicle: VehicleId, t: number): number {
  let bias = 0;
  for (const i of list) if (i.kind === 'pitch' && i.vehicle === vehicle && i.t <= t + 1e-6) bias = i.deg;
  return bias;
}

function ConfirmButton({ label, confirmLabel, onConfirm, disabled }: { label: string; confirmLabel: string; onConfirm(): void; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      className={`${styles.action} ${styles.danger}`}
      data-armed={armed || undefined}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange(v: T): void; label: string }) {
  return (
    <div className={styles.choice} role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function VehicleControls({ vehicle }: { vehicle: VehicleId }) {
  const t = useReplay((s) => s.t);
  const result = useReplay((s) => s.result);
  const scenario = useReplay((s) => s.scenario);
  const flightN = useReplay((s) => s.flight);
  const { addIntervention, updateScenario } = useReplay.getState();
  const [throttle, setThrottle] = useState(100);
  const flight = getFlight(flightN);
  const track = result ? (vehicle === 'booster' ? result.booster : result.ship) : null;
  const alive = track !== null && t <= track.end;
  const stacked = result !== null && isStacked(result, t);
  const bias = currentBias(scenario.interventions, vehicle, t);
  const now = Math.max(t, result?.tStart ?? -10);

  const randomEngineOut = () => {
    if (!result) return;
    const timeline = vehicle === 'booster' ? result.boosterEngines : result.shipEngines;
    const states = engineStates(timeline, now, new Uint8Array(timeline.slots.length));
    const lit: number[] = [];
    states.forEach((s, i) => s === ENGINE_LIT && lit.push(i));
    const pool = lit.length > 0 ? lit : timeline.slots.map((_, i) => i).filter((i) => !scenario.interventions.some((x) => x.kind === 'engine-out' && x.vehicle === vehicle && x.engine === i));
    if (pool.length === 0) return;
    addIntervention({ t: now, kind: 'engine-out', vehicle, engine: pool[Math.floor(Math.random() * pool.length)] });
  };

  return (
    <section className={styles.block} aria-label={VEHICLE_NAME[vehicle]}>
      <div className={styles.blockHead}>
        <span>{VEHICLE_NAME[vehicle]}</span>
        <span className={styles.blockSub}>{vehicle === 'booster' ? flight.boosterId : flight.shipId}</span>
        {!alive && track ? <span className={styles.blockState}>Flight over</span> : null}
      </div>

      <div className={styles.row}>
        <label className={styles.sliderLabel} htmlFor={`thr-${vehicle}`}>
          Throttle limit <b>{throttle}%</b>
        </label>
        <div className={styles.sliderRow}>
          <input
            id={`thr-${vehicle}`}
            type="range"
            min={40}
            max={100}
            step={5}
            value={throttle}
            onChange={(e) => setThrottle(Number(e.target.value))}
            className={styles.slider}
          />
          <button
            type="button"
            className={styles.action}
            disabled={!alive}
            onClick={() => addIntervention({ t: now, kind: 'throttle', vehicle, value: throttle / 100 })}
          >
            Apply
          </button>
        </div>
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.action} disabled={!alive} onClick={randomEngineOut} title="Shut down a random running engine (or click one on the engine map)">
          Engine out
        </button>
        {vehicle === 'booster' ? (
          <button type="button" className={styles.action} disabled={!alive || !stacked || t < 20} onClick={() => addIntervention({ t: now, kind: 'stage-now' })}>
            Stage now
          </button>
        ) : null}
        <button type="button" className={styles.action} disabled={!alive} onClick={() => addIntervention({ t: now, kind: 'skip-burn', vehicle })} title="Cancel this vehicle's next planned burn">
          Skip next burn
        </button>
        <ConfirmButton
          label="Terminate"
          confirmLabel="Confirm FTS"
          disabled={!alive || t < 0}
          onConfirm={() => addIntervention({ t: now, kind: 'terminate', vehicle })}
        />
      </div>

      <div className={styles.row}>
        <span className={styles.sliderLabel}>
          Steering bias <b>{bias > 0 ? '+' : ''}{bias}°</b>
        </span>
        <div className={styles.actions}>
          <button type="button" className={styles.action} disabled={!alive || t < 0} onClick={() => addIntervention({ t: now, kind: 'pitch', vehicle, deg: bias - 2 })}>
            Nose down 2°
          </button>
          <button type="button" className={styles.action} disabled={!alive || t < 0} onClick={() => addIntervention({ t: now, kind: 'pitch', vehicle, deg: bias + 2 })}>
            Nose up 2°
          </button>
          <button type="button" className={styles.action} disabled={!alive || bias === 0} onClick={() => addIntervention({ t: now, kind: 'pitch', vehicle, deg: 0 })}>
            Centre
          </button>
        </div>
      </div>

      {vehicle === 'booster' ? (
        <div className={styles.row}>
          <span className={styles.sliderLabel}>After staging</span>
          <Choice<BoosterRecovery | 'plan'>
            label="Booster recovery"
            value={scenario.boosterRecovery ?? 'plan'}
            onChange={(v) => updateScenario({ boosterRecovery: v === 'plan' ? undefined : v })}
            options={[
              ['plan', 'Real plan'],
              ['catch', 'Catch'],
              ['splashdown', 'Gulf'],
              ['expend', 'Expend'],
            ]}
          />
        </div>
      ) : (
        <>
          <div className={styles.row}>
            <span className={styles.sliderLabel}>Ascent target</span>
            <Choice<ShipMission | 'plan'>
              label="Ship mission"
              value={scenario.shipMission ?? 'plan'}
              onChange={(v) => updateScenario({ shipMission: v === 'plan' ? undefined : v })}
              options={[
                ['plan', 'Real plan'],
                ['suborbital', 'Suborbital'],
                ['orbital', 'Orbit'],
              ]}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.sliderLabel} htmlFor="payload">
              Starlink satellites aboard <b>{scenario.payloadCount ?? flight.plan.ship.payloadCount}</b>
              {scenario.payloadCount === undefined ? ' (real load)' : ''}
            </label>
            <input
              id="payload"
              type="range"
              min={0}
              max={40}
              step={1}
              value={scenario.payloadCount ?? flight.plan.ship.payloadCount}
              onChange={(e) => updateScenario({ payloadCount: Number(e.target.value) })}
              className={styles.slider}
            />
          </div>
        </>
      )}
    </section>
  );
}

export function DirectorPanel() {
  const open = useReplay((s) => s.panel === 'director');
  const t = useReplay((s) => s.t);
  const result = useReplay((s) => s.result);
  const scenario = useReplay((s) => s.scenario);
  const loading = useReplay((s) => s.loading);
  const { setPanel, updateScenario, removeIntervention, resetScenario } = useReplay.getState();
  if (!open) return null;
  const modified = isModified(scenario);
  const engineCount = (v: VehicleId) => (result ? (v === 'booster' ? result.boosterEngines.slots.length : result.shipEngines.slots.length) : v === 'booster' ? 33 : 6);

  return (
    <aside className={styles.panel} aria-label="Flight director">
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>Flight director</h2>
          <p className={styles.sub}>Commands take effect at {formatEventTime(Math.max(t, result?.tStart ?? -10))}. The whole flight is re-simulated from your changes.</p>
        </div>
        <button type="button" className={styles.close} aria-label="Close the flight director" onClick={() => setPanel('none')}>
          <IconClose size={16} />
        </button>
      </header>

      <div className={styles.scroll}>
        <section className={styles.block}>
          <div className={styles.blockHead}>
            <span>Run</span>
          </div>
          <Choice<'flown' | 'planned'>
            label="Run mode"
            value={scenario.asFlown ? 'flown' : 'planned'}
            onChange={(v) => updateScenario({ asFlown: v === 'flown' })}
            options={[
              ['flown', 'As flown (with real failures)'],
              ['planned', 'As planned (no failures)'],
            ]}
          />
          <p className={styles.note}>Tip: open this panel and click an engine on either engine map to shut it down at the current time.</p>
        </section>

        <VehicleControls vehicle="booster" />
        <VehicleControls vehicle="ship" />

        <section className={styles.block} aria-label="Environment">
          <div className={styles.blockHead}>
            <span>Environment</span>
          </div>
          <div className={styles.row}>
            <label className={styles.sliderLabel} htmlFor="wind">
              Upper-level wind <b>{scenario.wind ?? 0} m/s</b>
            </label>
            <input
              id="wind"
              type="range"
              min={0}
              max={90}
              step={5}
              value={scenario.wind ?? 0}
              onChange={(e) => updateScenario({ wind: Number(e.target.value) || undefined })}
              className={styles.slider}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.sliderLabel} htmlFor="load">
              Booster propellant load <b>{Math.round((scenario.boosterLoad ?? 1) * 100)}%</b>
            </label>
            <input
              id="load"
              type="range"
              min={85}
              max={100}
              step={1}
              value={Math.round((scenario.boosterLoad ?? 1) * 100)}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                updateScenario({ boosterLoad: v >= 1 ? undefined : v });
              }}
              className={styles.slider}
            />
          </div>
        </section>

        <section className={styles.block} aria-label="Your changes">
          <div className={styles.blockHead}>
            <span>Your changes</span>
            <span className={styles.blockSub}>{scenario.interventions.length}</span>
          </div>
          {scenario.interventions.length === 0 ? (
            <p className={styles.note}>No commands yet. Everything you do appears here and on the timeline.</p>
          ) : (
            <ul className={styles.log}>
              {scenario.interventions.map((i) => (
                <li key={i.id}>
                  <span className={styles.logTime}>{formatEventTime(i.t)}</span>
                  <span className={styles.logText}>{describe(i, engineCount)}</span>
                  <button type="button" aria-label="Remove this command" onClick={() => removeIntervention(i.id)}>
                    <IconClose size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className={styles.reset} disabled={!modified} onClick={resetScenario}>
            <IconUndo size={13} /> Back to the real flight
          </button>
        </section>
      </div>

      <footer className={styles.status} aria-live="polite">
        {loading ? 'Re-simulating…' : result ? `Simulated in ${Math.round(result.computeMs)} ms${modified ? ' · modified run' : ' · as flown'}` : ''}
      </footer>
    </aside>
  );
}
