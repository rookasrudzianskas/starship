import type { EngineRing, EngineSlot, VehicleId } from '@/lib/sim/types';

/**
 * Engine slot layout, index-aligned with the simulator's EngineTimeline.slots and
 * VehicleVisualState.engines. Slot k of a ring sits at x = r·cosθ, z = r·sinθ with
 * θ = θ0 + k·360°/count (θ0 = 90°, 30° for the Raptor Vacuum ring).
 */

interface RingSpec {
  ring: EngineRing;
  count: number;
  radius: number;
  theta0Deg: number;
  exitRadius: number;
  vacuum: boolean;
}

const BOOSTER_RINGS: RingSpec[] = [
  { ring: 'center', count: 3, radius: 0.95, theta0Deg: 90, exitRadius: 0.65, vacuum: false },
  { ring: 'inner', count: 10, radius: 2.65, theta0Deg: 90, exitRadius: 0.65, vacuum: false },
  { ring: 'outer', count: 20, radius: 4.05, theta0Deg: 90, exitRadius: 0.65, vacuum: false },
];

const SHIP_RINGS: RingSpec[] = [
  { ring: 'center', count: 3, radius: 1.25, theta0Deg: 90, exitRadius: 0.65, vacuum: false },
  { ring: 'rvac', count: 3, radius: 3.05, theta0Deg: 30, exitRadius: 1.15, vacuum: true },
];

function buildSlots(rings: RingSpec[]): EngineSlot[] {
  const out: EngineSlot[] = [];
  for (const r of rings) {
    for (let k = 0; k < r.count; k++) {
      const th = ((r.theta0Deg + (k * 360) / r.count) * Math.PI) / 180;
      out.push({
        x: r.radius * Math.cos(th),
        z: r.radius * Math.sin(th),
        exitRadius: r.exitRadius,
        ring: r.ring,
        vacuum: r.vacuum,
      });
    }
  }
  return out;
}

const SLOTS: Record<VehicleId, EngineSlot[]> = {
  booster: buildSlots(BOOSTER_RINGS),
  ship: buildSlots(SHIP_RINGS),
};

/** All engine slots of a vehicle (33 for the booster, 6 for the ship). Do not mutate. */
export function engineSlots(vehicle: VehicleId): readonly EngineSlot[] {
  return SLOTS[vehicle];
}

/** Nozzle centre of engine `index` in the body frame's engine plane (metres). */
export function engineSlotPosition(vehicle: VehicleId, index: number): { x: number; z: number } {
  const s = SLOTS[vehicle][index];
  if (!s) throw new RangeError(`No engine ${index} on the ${vehicle}`);
  return { x: s.x, z: s.z };
}

export const BOOSTER_ENGINE_COUNT = 33;
export const SHIP_ENGINE_COUNT = 6;
