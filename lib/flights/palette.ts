/** One distinct line colour per flight, readable on black. */
export const FLIGHT_COLORS: Record<number, string> = {
  1: '#e8789a',
  2: '#a9c25b',
  3: '#5aa9e6',
  4: '#e0675a',
  5: '#58c48c',
  6: '#9b86e8',
  7: '#e8a052',
  8: '#4fc6c6',
  9: '#d77fe0',
  10: '#c9b45a',
  11: '#6f8ff0',
  12: '#e6739f',
  13: '#e3c14f',
  14: '#5fb7ff',
};

export function flightColor(n: number): string {
  return FLIGHT_COLORS[n] ?? '#ffffff';
}
