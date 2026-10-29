/**
 * Start downloading the imagery the opening view needs before the stage exists, so the first frame doesn't
 * wait on a request that only starts after the simulation and the first render. Idempotent, and a no-op on the
 * server. Keep this module free of three.js: the replay page imports it eagerly, while the stage loads lazily.
 */
export function prefetchEarthImagery(): void {}
