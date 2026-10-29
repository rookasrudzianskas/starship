import { engineLayout, engineSpecFor, type EngineSpec } from './engines';
import type { EngineSlot, Generation, VehicleId } from './types';

/** Mass, geometry and aerodynamic data for one vehicle of one generation. */
export interface VehicleSpec {
  id: VehicleId;
  gen: Generation;
  length: number; // m
  dryMass: number; // kg, default (calibration may override within bounds)
  propMass: number; // kg, full load
  dryCom: number; // m above the base
  lox: [number, number]; // tank bottom/top above the base, m
  ch4: [number, number];
  payloadCom: number; // m above the base
  slots: EngineSlot[];
  specs: EngineSpec[];
  aero: AeroConfig;
}

export interface AeroConfig {
  refArea: number; // m^2, π·4.5²
  /** Planform (length × diameter) over reference area, scales the crossflow term. */
  planformRatio: number;
  /** Axial force coefficient flying nose first / tail first, by Mach. */
  caNose: MachTable;
  caTail: MachTable;
  /** Crossflow normal-force coefficient (planform based), by Mach. */
  cnCross: MachTable;
  /** Slender-body normal-force slope, per radian, reference-area based. */
  cnLinear: number;
}

export interface MachTable {
  m: number[];
  c: number[];
}

export const DIAMETER = 9;
export const REF_AREA = Math.PI * 4.5 * 4.5;

/** Piecewise-linear lookup, clamped at the ends. */
export function machLookup(tab: MachTable, mach: number): number {
  const m = tab.m, c = tab.c;
  if (mach <= m[0]) return c[0];
  const n = m.length;
  if (mach >= m[n - 1]) return c[n - 1];
  let i = 0;
  while (mach > m[i + 1]) i++;
  return c[i] + ((mach - m[i]) / (m[i + 1] - m[i])) * (c[i + 1] - c[i]);
}

// Ogive-nosed cylinder with engines firing: transonic drag rise peaking just above Mach 1.
const NOSE_FIRST: MachTable = {
  m: [0, 0.6, 0.8, 0.95, 1.05, 1.2, 1.5, 2, 3, 5, 10],
  c: [0.3, 0.3, 0.34, 0.5, 0.62, 0.6, 0.52, 0.44, 0.34, 0.28, 0.26],
};
// Flat hot-staging ring leading: blunt body.
const BLUNT_FIRST: MachTable = { m: [0, 0.8, 1.1, 2, 5], c: [0.85, 0.95, 1.25, 1.2, 1.1] };
// Engines-first booster descent (engine skirt + grid fins), and the ship falling tail first.
const TAIL_FIRST: MachTable = { m: [0, 0.6, 0.9, 1.2, 2, 4, 8], c: [0.9, 0.92, 1.1, 1.3, 1.25, 1.15, 1.1] };
const CROSSFLOW_CYL: MachTable = { m: [0, 0.8, 1.2, 3, 6], c: [1.2, 1.25, 1.5, 1.35, 1.25] };
// Ship belly (flat heat shield + flaps): Newtonian flat-plate-like normal force at hypersonic speed
// (L/D ≈ cot(AoA)), and a subsonic value that gives a ~90 m/s belly-flop at sea level.
const CROSSFLOW_SHIP: MachTable = { m: [0, 0.8, 1.2, 2, 5, 10], c: [0.57, 0.62, 0.95, 1.35, 1.7, 1.8] };

function aero(length: number, caNose: MachTable, caTail: MachTable, cnCross: MachTable, cnLinear: number): AeroConfig {
  return { refArea: REF_AREA, planformRatio: (length * DIAMETER) / REF_AREA, caNose, caTail, cnCross, cnLinear };
}

interface Dims {
  length: number;
  dry: number;
  prop: number;
  dryComFrac: number;
  lox: [number, number];
  ch4: [number, number];
  payloadCom: number;
}

const BOOSTER_B1: Dims = { length: 70.8, dry: 230_000, prop: 3_400_000, dryComFrac: 0.36, lox: [3.5, 40], ch4: [41, 66], payloadCom: 0 };
const BOOSTER_V3: Dims = { length: 72.0, dry: 250_000, prop: 3_650_000, dryComFrac: 0.36, lox: [3.5, 42], ch4: [43, 68], payloadCom: 0 };
const SHIP_B1: Dims = { length: 50.3, dry: 110_000, prop: 1_200_000, dryComFrac: 0.4, lox: [3, 19.5], ch4: [20.5, 31], payloadCom: 36 };
const SHIP_B2: Dims = { length: 52.1, dry: 115_000, prop: 1_500_000, dryComFrac: 0.4, lox: [3, 22], ch4: [23, 34], payloadCom: 39 };
const SHIP_V3: Dims = { length: 52.1, dry: 120_000, prop: 1_600_000, dryComFrac: 0.4, lox: [3, 22.5], ch4: [23.5, 35], payloadCom: 40 };

/** Height of the vented hot-staging ring on top of Super Heavy, m. */
export const HOT_STAGE_RING = 1.8;

/**
 * Specs for one vehicle. Lengths run from the base (nozzle-exit plane, y = 0) to the top: Super Heavy
 * b1/b2 70.8 m and v3 72.0 m including the hot-staging ring (`hotStageRing: false` gives the 69.0 m
 * booster flown before hot staging); Starship 50.3 m (b1) and 52.1 m (b2, v3).
 */
export function vehicleSpec(id: VehicleId, gen: Generation, hotStageRing = true): VehicleSpec {
  const base = id === 'booster' ? (gen === 'v3' ? BOOSTER_V3 : BOOSTER_B1) : gen === 'v3' ? SHIP_V3 : gen === 'b2' ? SHIP_B2 : SHIP_B1;
  const d = id === 'booster' && !hotStageRing ? { ...base, length: base.length - HOT_STAGE_RING } : base;
  const slots = engineLayout(id, gen);
  return {
    id,
    gen,
    length: d.length,
    dryMass: d.dry,
    propMass: d.prop,
    dryCom: d.length * d.dryComFrac,
    lox: d.lox,
    ch4: d.ch4,
    payloadCom: d.payloadCom,
    slots,
    specs: slots.map((s) => engineSpecFor(gen, s.vacuum)),
    aero:
      id === 'booster'
        ? aero(d.length, BLUNT_FIRST, TAIL_FIRST, CROSSFLOW_CYL, 3)
        : aero(d.length, NOSE_FIRST, TAIL_FIRST, CROSSFLOW_SHIP, 2),
  };
}

/** Copy of an aero config with the tail-first axial drag scaled. */
export function withTailDrag(cfg: AeroConfig, k: number): AeroConfig {
  return { ...cfg, caTail: { m: cfg.caTail.m, c: cfg.caTail.c.map((c) => c * k) } };
}

/** Aerodynamics of the attached stack (ship nose leading). */
export function stackAero(totalLength: number): AeroConfig {
  return aero(totalLength, NOSE_FIRST, TAIL_FIRST, CROSSFLOW_CYL, 2);
}

/** Ship flap angle while folded towards the leeward side (ascent, coast), deg (0 = spread, 90 = folded). */
export const FLAPS_STOWED = 75;

/** Starlink masses, kg. */
export const PAYLOAD_MASS = { 'starlink-sim': 1_800, 'starlink-v3': 2_000 } as const;

/**
 * Centre-of-mass height above the vehicle base. Liquids settle at the bottom of their tanks, so the
 * CoM drops as LOX (aft tank) and CH4 (forward tank) drain.
 */
export function centreOfMass(spec: VehicleSpec, dry: number, lox: number, ch4: number, payload: number, loxFull: number, ch4Full: number): number {
  const fl = loxFull > 0 ? lox / loxFull : 0;
  const fc = ch4Full > 0 ? ch4 / ch4Full : 0;
  const yl = spec.lox[0] + 0.5 * fl * (spec.lox[1] - spec.lox[0]);
  const yc = spec.ch4[0] + 0.5 * fc * (spec.ch4[1] - spec.ch4[0]);
  const m = dry + lox + ch4 + payload;
  return (dry * spec.dryCom + lox * yl + ch4 * yc + payload * spec.payloadCom) / m;
}
