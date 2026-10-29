/**
 * Flight simulator public API. Everything here is pure and runs in Node, the main thread or a worker;
 * the main thread should normally go through `runSimulation` in ./client.
 */
export { simulateFlight } from './simulate';
export { scenarioKey } from './scenario';
export { sampleTrack, createTrackSample, type TrackSample, type Vec3, type Quat } from './sample';
export { engineStatesAt, engineLayout } from './engines';
export { atmosphere, type AtmosphereState } from './atmosphere';
export { latLonAltToEcef, ecefToLatLonAlt, localEnuBasis, type LatLonAlt, type EnuBasis } from './geo';
export { propagateBallistic, type BallisticOptions, type BallisticResult } from './ballistic';
export type { Vec3Like } from './vec';
