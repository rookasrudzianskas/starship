export type SpeedUnit = 'kmh' | 'mph' | 'ms';
export type AltUnit = 'km' | 'mi' | 'ft';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export interface Reading {
  value: string;
  unit: string;
}

export function formatSpeed(metresPerSecond: number, unit: SpeedUnit): Reading {
  const v = Math.max(0, metresPerSecond);
  if (unit === 'mph') return { value: intFormat.format(v * 2.2369363), unit: 'mph' };
  if (unit === 'ms') return { value: intFormat.format(v), unit: 'm/s' };
  return { value: intFormat.format(v * 3.6), unit: 'km/h' };
}

export function formatAltitude(metres: number, unit: AltUnit): Reading {
  const m = Math.max(0, metres);
  if (unit === 'mi') return { value: oneDecimal.format(m / 1609.344), unit: 'mi' };
  if (unit === 'ft') return { value: intFormat.format(m * 3.28084), unit: 'ft' };
  return { value: oneDecimal.format(m / 1000), unit: 'km' };
}

export function formatVerticalSpeed(metresPerSecond: number, unit: SpeedUnit): string {
  const arrow = metresPerSecond >= 0 ? '↑' : '↓';
  const r = formatSpeed(Math.abs(metresPerSecond), unit === 'kmh' ? 'ms' : unit);
  return `${arrow} ${r.value} ${r.unit}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Mission clock: sign and HH:MM:SS. T−0 counts as T+. */
export function formatClock(t: number): { sign: 'T−' | 'T+'; hms: string } {
  const sign = t < 0 ? 'T−' : 'T+';
  const s = t < 0 ? Math.ceil(-t) : Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return { sign, hms: `${pad2(h)}:${pad2(m)}:${pad2(s % 60)}` };
}

/** Compact event time: T+1:09, T+3:08:12, T−0:10. */
export function formatEventTime(t: number): string {
  const sign = t < 0 ? 'T−' : 'T+';
  const s = Math.round(Math.abs(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = pad2(s % 60);
  return h > 0 ? `${sign}${h}:${pad2(m)}:${sec}` : `${sign}${m}:${sec}`;
}

/** Duration like 8 min 28 s, 1 h 06 min. */
export function formatDuration(seconds: number): string {
  const s = Math.round(Math.abs(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${pad2(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${pad2(Math.floor((s % 3600) / 60))} min`;
}

function parseDate(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`);
}

/** 28 Sept 2026 */
export function formatDate(iso: string): string {
  const d = parseDate(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** 28 September 2026 */
export function formatDateLong(iso: string): string {
  const d = parseDate(iso);
  return `${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Sept 2026 */
export function formatMonthYear(iso: string): string {
  const d = parseDate(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatNumber(n: number, digits = 0): string {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}
