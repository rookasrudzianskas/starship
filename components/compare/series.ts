import { G0, type FlightResult, type VehicleId } from '@/lib/sim/types';
import { countLit, emptyReading, engineStates, readVehicle } from '@/lib/telemetry';

export type MetricId = 'speed' | 'alt' | 'engines' | 'prop' | 'vspeed' | 'accel' | 'mach' | 'q' | 'pitch';

export interface Metric {
  id: MetricId;
  title: string;
  unit: string;
  /** Fixed lower bound of the y axis, if any. */
  min?: number;
  format(v: number): string;
}

const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const METRICS: Metric[] = [
  { id: 'speed', title: 'Speed', unit: 'km/h', min: 0, format: (v) => int.format(v) },
  { id: 'alt', title: 'Altitude', unit: 'km', min: 0, format: (v) => v.toFixed(v < 10 ? 1 : 0) },
  { id: 'engines', title: 'Engines lit', unit: '', min: 0, format: (v) => String(Math.round(v)) },
  { id: 'prop', title: 'Propellant', unit: '%', min: 0, format: (v) => `${Math.round(v)}` },
  { id: 'vspeed', title: 'Vertical speed', unit: 'm/s', format: (v) => int.format(v) },
  { id: 'accel', title: 'Acceleration along the path', unit: 'g', format: (v) => v.toFixed(2) },
  { id: 'mach', title: 'Mach number', unit: '', min: 0, format: (v) => v.toFixed(1) },
  { id: 'q', title: 'Dynamic pressure', unit: 'kPa', min: 0, format: (v) => v.toFixed(1) },
  { id: 'pitch', title: 'Pitch', unit: '°', format: (v) => `${Math.round(v)}` },
];

/** A moment marked on a line: one of the flight's major events. */
export interface SeriesEvent {
  t: number;
  /** Short upper-case label, as on the replay timeline. */
  label: string;
}

/** One vehicle's history at a fixed step, ready to plot. */
export interface Series {
  flight: number;
  vehicle: VehicleId;
  t0: number;
  dt: number;
  n: number;
  end: number;
  values: Record<MetricId, Float32Array>;
  /** 1 when any engine is lit. */
  powered: Uint8Array;
  /** The vehicle's major events after liftoff (stack events included), in time order. */
  events: SeriesEvent[];
}

export function buildSeries(result: FlightResult, vehicle: VehicleId, dt = 1): Series {
  const track = vehicle === 'booster' ? result.booster : result.ship;
  const timeline = vehicle === 'booster' ? result.boosterEngines : result.shipEngines;
  const t0 = Math.ceil(result.tStart);
  const n = Math.max(2, Math.floor((track.end - t0) / dt) + 1);
  const values = Object.fromEntries(METRICS.map((m) => [m.id, new Float32Array(n)])) as Record<MetricId, Float32Array>;
  const powered = new Uint8Array(n);
  const r = emptyReading();
  const states = new Uint8Array(timeline.slots.length);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dt;
    readVehicle(result, vehicle, t, r);
    engineStates(timeline, t, states);
    const lit = countLit(states);
    values.speed[i] = r.speed * 3.6;
    values.alt[i] = r.alt / 1000;
    values.engines[i] = lit;
    values.prop[i] = ((r.lox * 3.6 + r.ch4) / 4.6) * 100;
    values.vspeed[i] = r.vspeed;
    values.accel[i] = r.accel / G0;
    values.mach[i] = r.mach;
    values.q[i] = r.q / 1000;
    values.pitch[i] = r.pitch;
    powered[i] = lit > 0 ? 1 : 0;
  }
  const events = result.events
    .filter((e) => e.major && e.key !== 'liftoff' && (e.vehicle === 'stack' || e.vehicle === vehicle) && e.t <= track.end)
    .map((e) => ({ t: e.t, label: e.short }));
  return { flight: result.flight, vehicle, t0, dt, n, end: track.end, values, powered, events };
}
