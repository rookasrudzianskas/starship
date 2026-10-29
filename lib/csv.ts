import { G0, type FlightResult } from '@/lib/sim/types';
import { countLit, emptyReading, engineStates, readTrack } from '@/lib/telemetry';

/** Build a CSV of both vehicles at 1 s resolution from a simulation result. */
export function buildCsv(result: FlightResult): string {
  const header = [
    'time_s',
    'booster_speed_kmh',
    'booster_altitude_km',
    'booster_vertical_speed_ms',
    'booster_accel_g',
    'booster_mach',
    'booster_q_kpa',
    'booster_pitch_deg',
    'booster_engines_lit',
    'booster_lox_pct',
    'booster_ch4_pct',
    'ship_speed_kmh',
    'ship_altitude_km',
    'ship_vertical_speed_ms',
    'ship_accel_g',
    'ship_mach',
    'ship_q_kpa',
    'ship_pitch_deg',
    'ship_engines_lit',
    'ship_lox_pct',
    'ship_ch4_pct',
  ];
  const rows = [header.join(',')];
  const b = emptyReading();
  const s = emptyReading();
  const be = new Uint8Array(result.boosterEngines.slots.length);
  const se = new Uint8Array(result.shipEngines.slots.length);
  const start = Math.ceil(result.tStart);
  const end = Math.floor(result.tEnd);
  const cell = (alive: boolean, v: number, digits: number) => (alive ? v.toFixed(digits) : '');
  for (let t = start; t <= end; t++) {
    const bAlive = t <= result.booster.end;
    const sAlive = t <= result.ship.end;
    readTrack(result.booster, t, b);
    readTrack(result.ship, t, s);
    engineStates(result.boosterEngines, t, be);
    engineStates(result.shipEngines, t, se);
    rows.push(
      [
        t,
        cell(bAlive, b.speed * 3.6, 0),
        cell(bAlive, b.alt / 1000, 3),
        cell(bAlive, b.vspeed, 1),
        cell(bAlive, b.accel / G0, 3),
        cell(bAlive, b.mach, 2),
        cell(bAlive, b.q / 1000, 2),
        cell(bAlive, b.pitch, 1),
        bAlive ? countLit(be) : '',
        cell(bAlive, b.lox * 100, 1),
        cell(bAlive, b.ch4 * 100, 1),
        cell(sAlive, s.speed * 3.6, 0),
        cell(sAlive, s.alt / 1000, 3),
        cell(sAlive, s.vspeed, 1),
        cell(sAlive, s.accel / G0, 3),
        cell(sAlive, s.mach, 2),
        cell(sAlive, s.q / 1000, 2),
        cell(sAlive, s.pitch, 1),
        sAlive ? countLit(se) : '',
        cell(sAlive, s.lox * 100, 1),
        cell(sAlive, s.ch4 * 100, 1),
      ].join(','),
    );
  }
  return rows.join('\n');
}

export function downloadCsv(result: FlightResult, name: string): void {
  const blob = new Blob([buildCsv(result)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/\s+/g, '_')}_simulated.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
