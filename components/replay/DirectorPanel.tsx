'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconClose, IconRedo, IconUndo } from '@/components/icons';
import { getFlight } from '@/lib/flights/catalog';
import { formatEventTime } from '@/lib/format';
import { sortInterventions } from '@/lib/sim/scenario';
import { ENGINE_LIT, type BoosterRecovery, type Intervention, type Scenario, type ShipMission, type VehicleId } from '@/lib/sim/types';
import { commandTimeOf, isModified, MAX_STEERING_BIAS, takesCommands, useReplay } from '@/lib/store/replay';
import { engineStates, isStacked } from '@/lib/telemetry';
import styles from './director.module.css';

const VEHICLE_NAME: Record<VehicleId, string> = { booster: 'Super Heavy', ship: 'Starship' };
/** Degrees each steering button adds to the bias. */
const BIAS_STEP = 2;

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
  const at = commandTimeOf(t);
  for (const i of list) if (i.kind === 'pitch' && i.vehicle === vehicle && i.t <= at) bias = i.deg;
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

/**
 * A scenario slider. It shows its value live while dragged and commits it when let go (or per key
 * press), so a drag re-simulates the flight once instead of once per step.
 */
function ScenarioSlider({
  id,
  label,
  min,
  max,
  step,
  value,
  onCommit,
}: {
  id: string;
  label(v: number): ReactNode;
  min: number;
  max: number;
  step: number;
  value: number;
  onCommit(v: number): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<number | null>(null);

  // React's onChange follows every step; the native change event fires once the value is let go.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onRelease = () => {
      setDraft(null);
      const v = Number(el.value);
      if (v !== value) onCommit(v);
    };
    el.addEventListener('change', onRelease);
    return () => el.removeEventListener('change', onRelease);
  }, [value, onCommit]);

  const shown = draft ?? value;
  return (
    <div className={styles.row}>
      <label className={styles.sliderLabel} htmlFor={id}>
        {label(shown)}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => setDraft(Number(e.target.value))}
        className={styles.slider}
      />
    </div>
  );
}

/** The time a command issued now takes effect. */
function commandTime(): number {
  const s = useReplay.getState();
  return Math.max(s.t, s.result?.tStart ?? -10);
}

function currentThrottle(list: Intervention[], vehicle: VehicleId, t: number): number {
  let throttle = 100;
  const at = commandTimeOf(t);
  for (const i of list) if (i.kind === 'throttle' && i.vehicle === vehicle && i.t <= at) throttle = Math.round(i.value * 100);
  return throttle;
}

/** A pending choice is local; a different active limit or flight starts a fresh draft. */
function ThrottleControl({ vehicle, alive, applied }: { vehicle: VehicleId; alive: boolean; applied: number }) {
  const [throttle, setThrottle] = useState(applied);
  return (
    <div className={styles.row}>
      <label className={styles.sliderLabel} htmlFor={`thr-${vehicle}`}>
        Throttle limit <b>{throttle}%</b>
        {throttle !== applied ? <span className={styles.pending}> · {applied}% applied</span> : null}
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
          disabled={!alive || throttle === applied}
          onClick={() => useReplay.getState().addIntervention({ t: commandTime(), kind: 'throttle', vehicle, value: throttle / 100 })}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function VehicleControls({ vehicle }: { vehicle: VehicleId }) {
  const interventions = useReplay((s) => s.scenario.interventions);
  // Shared links can contain simultaneous commands. Display the same ordering the simulator applies,
  // and sort only when the commands change, never on each playback frame.
  const ordered = useMemo(() => sortInterventions(interventions), [interventions]);
  // Display-level selections: the block re-renders when an action becomes (un)available, not every frame.
  const hasResult = useReplay((s) => s.result !== null);
  // Until the vehicle's flight ends, not its track: a click is never taken and then ignored.
  const alive = useReplay((s) => s.result !== null && takesCommands(s.result, vehicle, s.t));
  const stacked = useReplay((s) => s.result !== null && isStacked(s.result, s.t));
  const flying = useReplay((s) => s.t >= 0);
  const canStage = useReplay((s) => s.t >= 20);
  const bias = useReplay((s) => currentBias(ordered, vehicle, s.t));
  const appliedThrottle = useReplay((s) => currentThrottle(ordered, vehicle, s.t));
  const boosterRecovery = useReplay((s) => s.scenario.boosterRecovery);
  const shipMission = useReplay((s) => s.scenario.shipMission);
  const payloadCount = useReplay((s) => s.scenario.payloadCount);
  const flightN = useReplay((s) => s.flight);
  const { addIntervention, updateScenario } = useReplay.getState();
  const flight = getFlight(flightN);
  const realLoad = flight.plan.ship.payloadCount;

  const randomEngineOut = () => {
    const { result, scenario } = useReplay.getState();
    if (!result) return;
    const now = commandTime();
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
        {!alive && hasResult ? <span className={styles.blockState}>Flight over</span> : null}
      </div>

      <ThrottleControl key={`${flightN}:${appliedThrottle}`} vehicle={vehicle} alive={alive} applied={appliedThrottle} />

      <div className={styles.actions}>
        <button type="button" className={styles.action} disabled={!alive} onClick={randomEngineOut} title="Shut down a random running engine (or click one on the engine map)">
          Engine out
        </button>
        {vehicle === 'booster' ? (
          <button type="button" className={styles.action} disabled={!alive || !stacked || !canStage} onClick={() => addIntervention({ t: commandTime(), kind: 'stage-now' })}>
            Stage now
          </button>
        ) : null}
        <button type="button" className={styles.action} disabled={!alive} onClick={() => addIntervention({ t: commandTime(), kind: 'skip-burn', vehicle })} title="Cancel this vehicle's next planned burn">
          Skip next burn
        </button>
        <ConfirmButton
          label="Terminate"
          confirmLabel="Confirm FTS"
          disabled={!alive || !flying}
          onConfirm={() => addIntervention({ t: commandTime(), kind: 'terminate', vehicle })}
        />
      </div>

      <div className={styles.row}>
        <span className={styles.sliderLabel}>
          Steering bias <b>{bias > 0 ? '+' : ''}{bias}°</b>
        </span>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            disabled={!alive || !flying || bias <= -MAX_STEERING_BIAS}
            title={`Steer ${BIAS_STEP}° further nose down, to −${MAX_STEERING_BIAS}° at most`}
            onClick={() => addIntervention({ t: commandTime(), kind: 'pitch', vehicle, deg: Math.max(-MAX_STEERING_BIAS, bias - BIAS_STEP) })}
          >
            Nose down {BIAS_STEP}°
          </button>
          <button
            type="button"
            className={styles.action}
            disabled={!alive || !flying || bias >= MAX_STEERING_BIAS}
            title={`Steer ${BIAS_STEP}° further nose up, to +${MAX_STEERING_BIAS}° at most`}
            onClick={() => addIntervention({ t: commandTime(), kind: 'pitch', vehicle, deg: Math.min(MAX_STEERING_BIAS, bias + BIAS_STEP) })}
          >
            Nose up {BIAS_STEP}°
          </button>
          <button type="button" className={styles.action} disabled={!alive || bias === 0} onClick={() => addIntervention({ t: commandTime(), kind: 'pitch', vehicle, deg: 0 })}>
            Centre
          </button>
        </div>
      </div>

      {vehicle === 'booster' ? (
        <div className={styles.row}>
          <span className={styles.sliderLabel}>After staging</span>
          <Choice<BoosterRecovery | 'plan'>
            label="Booster recovery"
            value={boosterRecovery ?? 'plan'}
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
              value={shipMission ?? 'plan'}
              onChange={(v) => updateScenario({ shipMission: v === 'plan' ? undefined : v })}
              options={[
                ['plan', 'Real plan'],
                ['suborbital', 'Suborbital'],
                ['orbital', 'Orbit'],
              ]}
            />
          </div>
          <ScenarioSlider
            id="payload"
            min={0}
            max={40}
            step={1}
            value={payloadCount ?? realLoad}
            // The real load is no change at all.
            onCommit={(v) => updateScenario({ payloadCount: v === realLoad ? undefined : v })}
            label={(v) => (
              <>
                Starlink satellites aboard <b>{v}</b>
                {v === realLoad ? ' (real load)' : ''}
              </>
            )}
          />
        </>
      )}
    </section>
  );
}

const RECOVERY_TEXT: Record<BoosterRecovery, string> = { catch: 'tower catch', splashdown: 'splashdown in the Gulf', expend: 'expended' };
const MISSION_TEXT: Record<ShipMission, string> = { suborbital: 'suborbital path', orbital: 'to orbit' };

/** The run-wide settings that differ from the real flight, each with the patch that undoes it. */
function settingChanges(s: Scenario, realLoad: number): { key: string; text: string; undo: Partial<Omit<Scenario, 'interventions'>> }[] {
  const list: { key: string; text: string; undo: Partial<Omit<Scenario, 'interventions'>> }[] = [];
  if (!s.asFlown) list.push({ key: 'asFlown', text: 'Flying the plan, without the real failures', undo: { asFlown: true } });
  if (s.boosterRecovery) list.push({ key: 'recovery', text: `Super Heavy: ${RECOVERY_TEXT[s.boosterRecovery]}`, undo: { boosterRecovery: undefined } });
  if (s.shipMission) list.push({ key: 'mission', text: `Starship: ${MISSION_TEXT[s.shipMission]}`, undo: { shipMission: undefined } });
  if (s.payloadCount !== undefined) list.push({ key: 'payload', text: `${s.payloadCount} Starlink satellites aboard (real load ${realLoad})`, undo: { payloadCount: undefined } });
  if ((s.wind ?? 0) !== 0) list.push({ key: 'wind', text: `Upper-level wind ${s.wind} m/s`, undo: { wind: undefined } });
  if ((s.boosterLoad ?? 1) !== 1) list.push({ key: 'load', text: `Booster propellant load ${Math.round((s.boosterLoad ?? 1) * 100)}%`, undo: { boosterLoad: undefined } });
  return list;
}

/** "Commands take effect at …": its own component, so only this line follows the clock (whole seconds, as the clock shows them). */
function CommandTime() {
  const text = useReplay((s) => formatEventTime(Math.floor(Math.max(s.t, s.result?.tStart ?? -10))));
  return <>{text}</>;
}

export function DirectorPanel() {
  const open = useReplay((s) => s.panel === 'director');
  return open ? <DirectorBody /> : null;
}

function DirectorBody() {
  const result = useReplay((s) => s.result);
  const scenario = useReplay((s) => s.scenario);
  const loading = useReplay((s) => s.loading);
  const error = useReplay((s) => s.error);
  const flightN = useReplay((s) => s.flight);
  const canUndo = useReplay((s) => s.scenarioPast.length > 0);
  const canRedo = useReplay((s) => s.scenarioFuture.length > 0);
  const { setPanel, updateScenario, removeIntervention, resetScenario, undoScenario, redoScenario } = useReplay.getState();
  const modified = isModified(scenario);
  const settings = settingChanges(scenario, getFlight(flightN).plan.ship.payloadCount);
  const changes = settings.length + scenario.interventions.length;
  const engineCount = (v: VehicleId) => (result ? (v === 'booster' ? result.boosterEngines.slots.length : result.shipEngines.slots.length) : v === 'booster' ? 33 : 6);

  return (
    <aside className={styles.panel} aria-label="Flight director">
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>Flight director</h2>
          <p className={styles.sub}>
            Commands take effect at <CommandTime />. The whole flight is re-simulated from your changes.
          </p>
        </div>
        <button type="button" className={styles.close} aria-label="Close the flight director" onClick={() => setPanel('none')}>
          <IconClose size={16} />
        </button>
      </header>

      <div className={styles.history} role="group" aria-label="Simulation history">
        <button type="button" className={styles.action} disabled={!canUndo} onClick={undoScenario}
          aria-label="Undo last simulation change" aria-keyshortcuts="Control+z Meta+z" title="Undo last change (Ctrl/⌘ Z)">
          <IconUndo size={13} /> Undo
        </button>
        <button type="button" className={styles.action} disabled={!canRedo} onClick={redoScenario}
          aria-label="Redo simulation change" aria-keyshortcuts="Control+Shift+z Meta+Shift+z Control+y" title="Redo (Ctrl/⌘ Shift Z or Ctrl Y)">
          <IconRedo size={13} /> Redo
        </button>
      </div>

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
          <ScenarioSlider
            id="wind"
            min={0}
            max={90}
            step={5}
            value={scenario.wind ?? 0}
            onCommit={(v) => updateScenario({ wind: v || undefined })}
            label={(v) => (
              <>
                Upper-level wind <b>{v} m/s</b>
              </>
            )}
          />
          <ScenarioSlider
            id="load"
            min={85}
            max={100}
            step={1}
            value={Math.round((scenario.boosterLoad ?? 1) * 100)}
            onCommit={(v) => updateScenario({ boosterLoad: v >= 100 ? undefined : v / 100 })}
            label={(v) => (
              <>
                Booster propellant load <b>{v}%</b>
              </>
            )}
          />
        </section>

        <section className={styles.block} aria-label="Your changes">
          <div className={styles.blockHead}>
            <span>Your changes</span>
            <span className={styles.blockSub}>{changes}</span>
          </div>
          {changes === 0 ? (
            <p className={styles.note}>Nothing changed yet. Your changes appear here, and timed commands also on the timeline.</p>
          ) : (
            <ul className={styles.log}>
              {settings.map((c) => (
                <li key={c.key} data-setting="">
                  <span className={styles.logTime}>Whole run</span>
                  <span className={styles.logText}>{c.text}</span>
                  <button type="button" aria-label="Undo this change" onClick={() => updateScenario(c.undo)}>
                    <IconClose size={12} />
                  </button>
                </li>
              ))}
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

      <footer className={styles.status} aria-live="polite" data-error={(error && !loading) || undefined}>
        {loading
          ? 'Re-simulating…'
          : error
            ? `Simulation failed: ${error}`
            : result
              ? `Simulated in ${Math.round(result.computeMs)} ms${modified ? ' · modified run' : ' · as flown'}`
              : ''}
      </footer>
    </aside>
  );
}
