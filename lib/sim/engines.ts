import {
  ENGINE_FAILED,
  ENGINE_OFF,
  G0,
  type EngineRing,
  type EngineSlot,
  type EngineTimeline,
  type Generation,
  type VehicleId,
} from './types';

/** Raptor performance. Thrust per engine = throttle * (fVac - ambient pressure * exitArea). */
export interface EngineSpec {
  fVac: number; // N
  ispVac: number; // s
  exitArea: number; // m^2
  mdot: number; // kg/s at full throttle
}

const P0 = 101_325;
const SL_EXIT_RADIUS = 0.65;
const VAC_EXIT_RADIUS = 1.15;
export const MIN_THROTTLE = 0.4;
/** Fuel split by mass, O/F = 3.6. */
export const LOX_FRACTION = 3.6 / 4.6;

function spec(fVac: number, ispVac: number, exitRadius: number): EngineSpec {
  return { fVac, ispVac, exitArea: Math.PI * exitRadius * exitRadius, mdot: fVac / (ispVac * G0) };
}

/** Sea-level Raptors are specified by their sea-level thrust; vacuum thrust adds back the exit-plane pressure term. */
function slSpec(fSeaLevel: number, ispVac: number): EngineSpec {
  return spec(fSeaLevel + P0 * Math.PI * SL_EXIT_RADIUS * SL_EXIT_RADIUS, ispVac, SL_EXIT_RADIUS);
}

export const RAPTOR = {
  r2: slSpec(2.26e6, 347),
  r2vac: spec(2.53e6, 380, VAC_EXIT_RADIUS),
  r3: slSpec(2.75e6, 350),
  r3vac: spec(3.0e6, 380, VAC_EXIT_RADIUS),
};

export function engineSpecFor(gen: Generation, vacuum: boolean): EngineSpec {
  if (gen === 'v3') return vacuum ? RAPTOR.r3vac : RAPTOR.r3;
  return vacuum ? RAPTOR.r2vac : RAPTOR.r2;
}

function ring(count: number, radius: number, theta0Deg: number, exitRadius: number, kind: EngineRing, vacuum: boolean): EngineSlot[] {
  const out: EngineSlot[] = [];
  for (let k = 0; k < count; k++) {
    const th = ((theta0Deg + (k * 360) / count) * Math.PI) / 180;
    out.push({ x: radius * Math.cos(th), z: radius * Math.sin(th), exitRadius, ring: kind, vacuum });
  }
  return out;
}

const layouts = new Map<string, EngineSlot[]>();

/**
 * Engine positions in the body frame. Booster: 0-2 centre, 3-12 inner ring, 13-32 outer ring.
 * Ship: 0-2 sea-level Raptors, 3-5 Raptor Vacuum. All generations currently share these positions;
 * layouts are built once per vehicle and generation, and each call returns fresh copies.
 */
export function engineLayout(vehicle: VehicleId, gen: Generation): EngineSlot[] {
  const key = `${vehicle}:${gen}`;
  let slots = layouts.get(key);
  if (!slots) {
    slots =
      vehicle === 'booster'
        ? [
            ...ring(3, 0.95, 90, SL_EXIT_RADIUS, 'center', false),
            ...ring(10, 2.65, 90, SL_EXIT_RADIUS, 'inner', false),
            ...ring(20, 4.05, 90, SL_EXIT_RADIUS, 'outer', false),
          ]
        : [...ring(3, 1.25, 90, SL_EXIT_RADIUS, 'center', false), ...ring(3, 3.05, 30, VAC_EXIT_RADIUS, 'rvac', true)];
    layouts.set(key, slots);
  }
  return slots.map((s) => ({ ...s }));
}

/** Engine states at time t (every engine OFF before its first change). Writes into `out`, no allocation. */
export function engineStatesAt(timeline: EngineTimeline, t: number, out: Uint8Array): Uint8Array {
  out.fill(ENGINE_OFF);
  const ch = timeline.changes;
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i];
    if (c.t > t) break;
    if (c.engine < out.length) out[c.engine] = c.state;
  }
  return out;
}

/** Indices of `m` engines spread evenly around a ring of `n` (first index `base`). */
function evenlySpaced(base: number, n: number, m: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < m; i++) out.push(base + (Math.round((i * n) / m) % n));
  return out;
}

const BOOSTER_RINGS: Array<[number, number]> = [
  [0, 3],
  [3, 10],
  [13, 20],
];

/**
 * Picks `count` booster engines for a burn: centre first, then the inner and outer rings, spread
 * symmetrically. Engines that cannot fire are replaced by their nearest usable neighbour in the
 * same ring, or by an engine from the next ring.
 */
export function selectBoosterEngines(count: number, usable: (i: number) => boolean): number[] {
  const chosen = new Set<number>();
  let remaining = Math.min(33, Math.max(0, Math.round(count)));
  for (const [base, n] of BOOSTER_RINGS) {
    if (remaining <= 0) break;
    const m = Math.min(n, remaining);
    for (const idx of evenlySpaced(base, n, m)) {
      let pick = -1;
      for (let d = 0; d < n && pick < 0; d++) {
        for (const s of d === 0 ? [0] : [d, -d]) {
          const j = base + ((((idx - base + s) % n) + n) % n);
          if (!chosen.has(j) && usable(j)) {
            pick = j;
            break;
          }
        }
      }
      if (pick >= 0) {
        chosen.add(pick);
        remaining--;
      }
    }
  }
  // Fill any shortfall from whatever is still usable, inside out.
  for (let i = 0; i < 33 && remaining > 0; i++) {
    if (!chosen.has(i) && usable(i)) {
      chosen.add(i);
      remaining--;
    }
  }
  return [...chosen].sort((a, b) => a - b);
}

/**
 * Engines an anomaly with only a count shuts down: lit engines first (or any healthy ones when none
 * are lit), booster outer ring first, ship Raptor Vacuum first, shuffled within a ring by `rng`.
 */
export function pickFailingEngines(
  vehicle: VehicleId,
  states: ArrayLike<number>,
  lit: (i: number) => boolean,
  count: number,
  rng: () => number,
): number[] {
  const order: number[][] =
    vehicle === 'booster'
      ? [range(13, 33), range(3, 13), range(0, 3)]
      : [range(3, 6), range(0, 3)];
  const anyLit = order.some((g) => g.some((i) => lit(i)));
  const out: number[] = [];
  for (const group of order) {
    const cand = group.filter((i) => states[i] !== ENGINE_FAILED && (!anyLit || lit(i)));
    // Fisher-Yates with the seeded generator.
    for (let i = cand.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = cand[i];
      cand[i] = cand[j];
      cand[j] = tmp;
    }
    for (const i of cand) {
      if (out.length >= count) return out;
      out.push(i);
    }
  }
  return out;
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}

/** Human readable engine name for event notes. */
export function engineName(vehicle: VehicleId, i: number): string {
  if (vehicle === 'booster') {
    if (i < 3) return `Centre engine ${i + 1}`;
    if (i < 13) return `Inner ring engine ${i - 2}`;
    return `Outer ring engine ${i - 12}`;
  }
  return i < 3 ? `Sea-level Raptor ${i + 1}` : `Raptor Vacuum ${i - 2}`;
}
