/**
 * Data contract shared by the flight simulator (lib/sim), the 3D stage (lib/three)
 * and the UI (components/). Keep this file dependency-free.
 *
 * Conventions
 * - Time `t` is seconds from liftoff (T+0). Negative values are the terminal count.
 * - Positions are ECEF metres on a spherical Earth of radius EARTH_RADIUS:
 *   +X through latitude 0 / longitude 0, +Y through latitude 0 / longitude 90°E, +Z the north pole.
 * - Velocities are ECEF (relative to the rotating Earth), metres per second. This is the speed
 *   the SpaceX webcast HUD shows.
 * - Vehicle body frame: origin at the centre of the base (the engine gimbal plane / bottom of the skirt),
 *   +Y along the long axis towards the nose, +Z towards the "belly" (the Ship's heat-shield side;
 *   for Super Heavy the side that faces the tower chopsticks on the pad), +X = Y × Z.
 * - Attitude quaternions rotate body-frame vectors into ECEF and are stored as x, y, z, w.
 */

export const EARTH_RADIUS = 6_371_000; // m, spherical model used everywhere (sim, 3D, UI)
export const EARTH_MU = 3.986004418e14; // m^3/s^2
export const EARTH_J2 = 1.08262668e-3;
export const EARTH_J2_RADIUS = 6_378_137; // m, reference radius for the J2 term
export const EARTH_OMEGA = 7.2921159e-5; // rad/s, sidereal rotation rate
export const G0 = 9.80665; // m/s^2

export type VehicleId = 'booster' | 'ship';
/** b1 = Block 1 stack, b2 = Block 1 booster + Block 2 ship, v3 = Starship V3 (Raptor 3, Pad 2). */
export type Generation = 'b1' | 'b2' | 'v3';
export type PadId = 'pad1' | 'pad2';

/** How a vehicle's flight ended. */
export type EndKind =
  | 'catch' // caught by the tower arms
  | 'splashdown' // soft vertical splashdown (vehicle then tips over)
  | 'impact' // hit the water/ground at speed
  | 'lost' // broke up / exploded in flight
  | 'termination' // flight termination system (FTS) commanded
  | 'orbit'; // still flying when the simulation stops

export const ENGINE_OFF = 0;
export const ENGINE_LIT = 1;
export const ENGINE_FAILED = 2;
export type EngineState = typeof ENGINE_OFF | typeof ENGINE_LIT | typeof ENGINE_FAILED;

export type EngineRing = 'center' | 'inner' | 'outer' | 'rvac';

export interface EngineSlot {
  /** Nozzle centre in the engine plane, body frame metres (y = 0 plane). */
  x: number;
  z: number;
  /** Nozzle exit radius, metres. */
  exitRadius: number;
  ring: EngineRing;
  /** True for Raptor Vacuum engines. */
  vacuum: boolean;
}

export interface EngineChange {
  t: number;
  engine: number; // index into EngineTimeline.slots
  state: EngineState;
}

export interface EngineTimeline {
  slots: EngineSlot[];
  /** Sorted by t (stable). Every engine starts ENGINE_OFF before its first change. */
  changes: EngineChange[];
}

/**
 * Phase codes stored per sample so the 3D stage can pick visuals without re-deriving physics.
 * Plain numeric constants (not a TS enum) so they survive isolatedModules and structured cloning.
 */
export const Phase = {
  Pad: 0, // sitting on the launch mount
  Ascent: 1, // powered ascent (stack or ship)
  HotStage: 2, // ship engines lit while still attached / separating
  Flip: 3, // booster flip after separation
  Boostback: 4, // booster boostback burn
  Coast: 5, // unpowered, above the sensible atmosphere
  Descent: 6, // unpowered in the atmosphere (booster engines-first descent)
  LandingBurn: 7, // terminal burn (booster or ship)
  Caught: 8, // held by the tower arms
  Splashed: 9, // in the water
  Destroyed: 10, // broken up; vehicle no longer drawn
  OrbitBurn: 11, // in-space burn (relight, insertion, deorbit)
  Entry: 12, // hypersonic entry, belly first
  BellyFlop: 13, // subsonic belly-first fall
  ShipFlip: 14, // ship flip to vertical before its landing burn
} as const;
export type PhaseCode = (typeof Phase)[keyof typeof Phase];

/**
 * One vehicle's sampled flight. Samples are dense where things change quickly (≤ 0.1 s in powered
 * or atmospheric flight) and sparse in vacuum coasts (≤ 2 s). Interpolate between samples
 * (see lib/sim/sample.ts). Before separation both tracks describe the attached stack: each track still
 * holds its own vehicle's centre of mass and both share the same attitude.
 */
export interface Track {
  vehicle: VehicleId;
  n: number;
  t: Float64Array; // n
  pos: Float64Array; // 3n  ECEF centre of mass, m
  vel: Float64Array; // 3n  ECEF velocity, m/s
  quat: Float32Array; // 4n  body -> ECEF, x y z w
  com: Float32Array; // n   centre-of-mass height above the vehicle base along +Y, m
  alt: Float32Array; // n   altitude above the sphere, m
  speed: Float32Array; // n   |vel|, m/s
  vspeed: Float32Array; // n  vertical speed, m/s (+ up)
  accel: Float32Array; // n   d(speed)/dt, m/s^2 (HUD shows accel / G0 as "G")
  mach: Float32Array; // n
  q: Float32Array; // n   dynamic pressure, Pa
  pitch: Float32Array; // n  deg, attitude of +Y in the vertical plane of the trajectory:
  //                         90 nose up, 0 nose downrange, 180 nose uprange, negative nose down. Range (-180, 180].
  aoa: Float32Array; // n   total angle of attack, deg (0..180)
  throttle: Float32Array; // n mean throttle of lit engines 0..1 (0 when none lit)
  lox: Float32Array; // n   LOX remaining, fraction of the full load
  ch4: Float32Array; // n   CH4 remaining, fraction of the full load
  heating: Float32Array; // n 0..1 normalised entry heating (drives the plasma glow)
  aero: Float32Array; // 4n control surfaces, deg. Booster: grid fins 0..3 (V3 uses 0..2). Ship: fwdLeft, fwdRight, aftLeft, aftRight
  phase: Uint8Array; // n   PhaseCode
  start: number; // first sample time
  end: number; // last sample time (the vehicle's flight is over after this)
  endKind: EndKind;
}

export type EventKey =
  | 'liftoff'
  | 'maxq'
  | 'meco'
  | 'staging'
  | 'boostback'
  | 'boostback-end'
  | 'booster-apogee'
  | 'booster-landing-burn'
  | 'booster-end'
  | 'seco'
  | 'ship-apogee'
  | 'payload-start'
  | 'payload-end'
  | 'relight'
  | 'orbit-insertion'
  | 'deorbit'
  | 'entry'
  | 'peak-heating'
  | 'ship-flip'
  | 'ship-landing-burn'
  | 'ship-end'
  | 'engine-out'
  | 'anomaly'
  | 'intervention';

export interface FlightEvent {
  t: number;
  key: EventKey;
  vehicle: 'stack' | VehicleId;
  /** Callout title, sentence case, e.g. "Booster engine cutoff". */
  label: string;
  /** Short upper-case label for the timeline, e.g. "MECO". */
  short: string;
  /** Shown on the timeline's label row (minor events only get a tick). */
  major: boolean;
  /** Vehicle state at the event, for callouts and the globe's event gates. */
  speed: number; // m/s
  alt: number; // m
  pos: [number, number, number]; // ECEF m
  note?: string;
}

export interface PayloadRelease {
  t: number;
  index: number;
  /** ECEF position and velocity at release, so the 3D can propagate the satellite. */
  pos: [number, number, number];
  vel: [number, number, number];
}

export interface FlightRecords {
  boosterTopSpeed: number; // m/s
  boosterApogee: number; // m
  shipTopSpeed: number; // m/s
  shipApogee: number; // m
}

export interface FlightResult {
  flight: number;
  /** Stable hash of the scenario that produced this result. */
  scenarioKey: string;
  /** UTC epoch ms of T+0, used for the Sun position and Earth rotation. */
  launchUtc: number;
  tStart: number; // first time on the timeline (terminal count), e.g. -10
  tEnd: number; // last time on the timeline
  /** Physical separation time, or null if the stack never separated. */
  separationT: number | null;
  booster: Track;
  ship: Track;
  boosterEngines: EngineTimeline;
  shipEngines: EngineTimeline;
  events: FlightEvent[]; // sorted by t
  payload: PayloadRelease[];
  /** Intervals where nothing happens (both vehicles coasting in vacuum, or only one alive and coasting) longer than 4 minutes. */
  coasts: Array<[number, number]>;
  records: FlightRecords;
  /** Wall-clock milliseconds the simulation took (diagnostics). */
  computeMs: number;
}

// ---------------------------------------------------------------------------
// User controls ("Flight director")
// ---------------------------------------------------------------------------

export type BoosterRecovery = 'catch' | 'splashdown' | 'expend';
export type ShipMission = 'suborbital' | 'orbital';

/** Time-stamped commands the user issues while watching. Applied at `t` (seconds from liftoff). */
export type Intervention =
  | { id: string; t: number; kind: 'engine-out'; vehicle: VehicleId; engine: number }
  | { id: string; t: number; kind: 'throttle'; vehicle: VehicleId; value: number } // throttle ceiling 0.4..1
  | { id: string; t: number; kind: 'terminate'; vehicle: VehicleId } // flight termination (stack: either id)
  | { id: string; t: number; kind: 'stage-now' } // command hot staging now (no-op after staging)
  | { id: string; t: number; kind: 'pitch'; vehicle: VehicleId; deg: number } // steering bias, degrees (+ = nose up), held until another pitch command
  | { id: string; t: number; kind: 'skip-burn'; vehicle: VehicleId }; // cancel the next planned burn (boostback, relight, deorbit, …)

export interface Scenario {
  /** true: replay the flight as it happened, including its real anomalies. false: fly the plan. */
  asFlown: boolean;
  /** Override where Super Heavy goes after staging. undefined = the flight's real plan. */
  boosterRecovery?: BoosterRecovery;
  /** Override the Ship's ascent target. undefined = the flight's real plan. */
  shipMission?: ShipMission;
  /** Number of Starlink satellites aboard (mass and deploy count). undefined = the flight's real load. */
  payloadCount?: number;
  /** Upper-level wind (jet stream) speed in m/s, blowing from the west. 0 = calm. */
  wind?: number;
  /** Booster propellant load, fraction of full (0.85..1). undefined = 1. */
  boosterLoad?: number;
  interventions: Intervention[];
}

export const NOMINAL_SCENARIO: Scenario = { asFlown: true, interventions: [] };
