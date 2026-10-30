/**
 * Procedural Starship vehicles (no model files): Super Heavy and Starship for each generation
 * ('b1' Block 1, 'b2' Block 1 booster + Block 2 ship, 'v3'), with engine plumes, hot staging,
 * entry plasma, grid fins, flaps and the payload door. Satisfies VehicleFactory in
 * lib/three/contracts.ts.
 */
import { prefetchGenerated } from './procedural';

export { createBooster, boosterCatchHeight } from './booster';
export { createShip } from './ship';
export { engineSlotPosition, engineSlots, BOOSTER_ENGINE_COUNT, SHIP_ENGINE_COUNT } from './engines-layout';
export { altitudeFactor } from './plumes';
export { prefetchGenerated as prefetchProceduralTextures } from './procedural';

// Make the shared noise and smoke textures in a worker while the rest of the 3D view loads (the steel
// maps follow once the stage knows the quality: prefetchProceduralTextures).
if (typeof window !== 'undefined') void prefetchGenerated();
