/**
 * Effects factory (satisfies EffectsFactory in lib/three/contracts.ts).
 *
 * - createExplosion(): fireball / smoke / vapour / debris, deterministic in setAge(age).
 *   Buoyancy and gravity act along the object's local +Y (orient it with +Y = local up).
 * - createLaunchClouds(quality): liftoff exhaust and deluge steam in the pad frame, deterministic in t.
 * - createSplash(): water impact column, droplet crown, mist and foam ring; origin on the water, +Y up.
 * - createStarlinkSwarm(capacity, kind): instanced satellites, one draw call.
 *
 * Particles are lit by the scene's first DirectionalLight (sun) and HemisphereLight (sky), looked up
 * at render time, so they match the vehicles under any sun colour; without them a daylight default is used.
 */

export { createExplosion } from './explosion';
export { createLaunchClouds } from './launchClouds';
export { createSplash } from './splash';
export { createStarlinkSwarm } from './starlink';
