import type { Intervention, Scenario, ShipFlap } from './types';

export const SHIP_FLAP_NAMES = ['Forward left', 'Forward right', 'Aft left', 'Aft right'] as const;

/** Validate at input boundaries; finite angles saturate at the stops and retain share-link precision. */
export function normalizeFlapCommand(input: { vehicle: unknown; flap: unknown; deg: unknown }): { vehicle: 'ship'; flap: ShipFlap; deg: number | null } | null {
  if (input.vehicle !== 'ship' || typeof input.flap !== 'number' || !Number.isInteger(input.flap) || input.flap < 0 || input.flap > 3) return null;
  if (input.deg !== null && (typeof input.deg !== 'number' || !Number.isFinite(input.deg))) return null;
  return {
    vehicle: 'ship',
    flap: input.flap as ShipFlap,
    deg: input.deg === null ? null : Math.round(Math.min(90, Math.max(0, input.deg)) * 1000) / 1000,
  };
}

/** 53-bit string hash (cyrb53), stable across platforms. */
export function hashString(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Mulberry32: small, fast, deterministic PRNG returning floats in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function num(x: number): string {
  // Round so that float noise from UI sliders does not change the key.
  return (Math.round(x * 1e6) / 1e6).toString();
}

/** Canonical text for one intervention, without its UI id (ids do not change the physics). */
export function interventionSignature(iv: Intervention): string {
  switch (iv.kind) {
    case 'engine-out':
      return `${num(iv.t)}|engine-out|${iv.vehicle}|${iv.engine}`;
    case 'throttle':
      return `${num(iv.t)}|throttle|${iv.vehicle}|${num(iv.value)}`;
    case 'terminate':
      return `${num(iv.t)}|terminate|${iv.vehicle}`;
    case 'stage-now':
      return `${num(iv.t)}|stage-now`;
    case 'pitch':
      return `${num(iv.t)}|pitch|${iv.vehicle}|${num(iv.deg)}`;
    case 'flap':
      return `${num(iv.t)}|flap|ship|${iv.flap}|${iv.deg === null ? 'auto' : num(iv.deg)}`;
    case 'skip-burn':
      return `${num(iv.t)}|skip-burn|${iv.vehicle}`;
  }
}

/** Interventions in a canonical order: by time, then by signature. */
export function sortInterventions(list: readonly Intervention[]): Intervention[] {
  return list
    .map((iv) => ({ iv, sig: interventionSignature(iv) }))
    .sort((a, b) => a.iv.t - b.iv.t || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0))
    .map((e) => e.iv);
}

/** Canonical text of a scenario: defaults filled in, interventions sorted, ids dropped. */
export function canonicalScenario(s: Scenario): string {
  const ivs = sortInterventions(s.interventions).map(interventionSignature);
  return [
    s.asFlown ? 'F' : 'P',
    s.boosterRecovery ?? '-',
    s.shipMission ?? '-',
    s.payloadCount === undefined ? '-' : String(Math.max(0, Math.round(s.payloadCount))),
    num(s.wind ?? 0),
    num(s.boosterLoad ?? 1),
    ivs.join(';'),
  ].join('/');
}

/** Stable key for a scenario: equal content (in any intervention order) gives the same key. */
export function scenarioKey(s: Scenario): string {
  return hashString(canonicalScenario(s)).toString(36);
}
