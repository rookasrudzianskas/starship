/**
 * Procedural Starship vehicles (no model files): Super Heavy and Starship for each generation
 * ('b1' Block 1, 'b2' Block 1 booster + Block 2 ship, 'v3'), with engine plumes, hot staging,
 * entry plasma, grid fins, flaps and the payload door. Satisfies VehicleFactory in
 * lib/three/contracts.ts.
 */
export { createBooster, boosterCatchHeight } from './booster';
export { createShip } from './ship';
export { engineSlotPosition, engineSlots, BOOSTER_ENGINE_COUNT, SHIP_ENGINE_COUNT } from './engines-layout';
export { altitudeFactor } from './plumes';
