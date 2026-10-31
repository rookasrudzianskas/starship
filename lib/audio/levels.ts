/** Synthesized onboard/broadcast sound, driven by the current simulation rather than a recording. */
export interface SoundInput {
  throttle: number;
  lit: number;
  engines: number;
  altitude: number;
  dynamicPressure: number;
  ended: boolean;
}

export function soundLevels(input: SoundInput): { rumble: number; air: number; frequency: number } {
  if (input.ended) return { rumble: 0, air: 0, frequency: 40 };
  const thrust = Math.min(1, Math.max(0, input.throttle)) * Math.min(1, Math.max(0, input.lit / Math.max(1, input.engines)));
  const atmosphere = Math.exp(-Math.max(0, input.altitude) / 24_000);
  return {
    // In vacuum only the low vibration conducted through the vehicle remains.
    rumble: Math.sqrt(thrust) * (0.045 + 0.13 * atmosphere),
    air: Math.sqrt(thrust) * atmosphere * 0.065 + Math.min(1, Math.max(0, input.dynamicPressure) / 60_000) * 0.04,
    frequency: 36 + 22 * thrust,
  };
}
