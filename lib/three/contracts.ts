import type * as THREE from 'three';
import type { Generation, PadId, PhaseCode } from '@/lib/sim/types';

/**
 * Interfaces between the stage orchestrator (lib/three/stage) and the visual modules
 * (lib/three/earth, lib/three/vehicles, lib/three/effects, lib/three/pad).
 *
 * Rendering model: camera-relative ("floating origin"). Every frame the stage takes the camera's ECEF
 * position in float64 as the render origin, keeps the camera at the world origin and places each object
 * at (objectEcef - cameraEcef). World axes are ECEF axes (see lib/sim/types.ts), in metres.
 * The renderer uses a logarithmic depth buffer, ACES filmic tone mapping and sRGB output.
 */

export type Quality = 'high' | 'low';
export type Vec3d = [number, number, number];

// ---------------------------------------------------------------------------
// Earth, sky, sun and lighting
// ---------------------------------------------------------------------------

export interface EarthFrame {
  /** Camera position, ECEF metres (float64). The render origin. */
  cameraEcef: Vec3d;
  /** The camera, positioned at the world origin and already oriented for this frame. */
  camera: THREE.PerspectiveCamera;
  /** Unit vector from Earth's centre towards the Sun, ECEF. */
  sunDir: THREE.Vector3;
  /** Seconds since T+0. */
  time: number;
  /** UTC epoch milliseconds of this frame, for the star field's sidereal orientation. */
  utcMs?: number;
}

export interface Earth {
  /** Everything Earth-related (globe, ground patches, sky, atmosphere, stars). Add once to the scene. */
  object: THREE.Object3D;
  /** Sun light and sky fill light. The stage adds these to the scene; Earth.update drives their colour and intensity. */
  sunLight: THREE.DirectionalLight;
  skyLight: THREE.HemisphereLight;
  /** Resolves when the textures needed for a good first frame have loaded. */
  ready: Promise<void>;
  /**
   * Update positions (camera-relative), shader uniforms, light colours, scene.fog and scene.environment
   * for this frame. Cheap enough to call every frame.
   */
  update(frame: EarthFrame): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

export interface EarthOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  quality: Quality;
  /** Launch pad, for the high resolution ground imagery around Starbase. */
  pad: PadId;
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export interface VehicleVisualState {
  /** Seconds since T+0 (drives flicker/noise). */
  t: number;
  /** Per-engine state, index-aligned with the vehicle's EngineTimeline.slots (ENGINE_OFF/LIT/FAILED). */
  engines: Uint8Array;
  /** Mean throttle of lit engines, 0..1. */
  throttle: number;
  /** Ambient static pressure at the vehicle, Pa (101325 at sea level, ~0 in space). Drives plume expansion. */
  ambientPressure: number;
  mach: number;
  /** Control surface deflections, degrees. Booster: grid fins. Ship: fwdLeft, fwdRight, aftLeft, aftRight. */
  aero: ArrayLike<number>;
  /** 0..1 entry heating: plasma glow intensity. */
  heating: number;
  /** Unit vector of the oncoming airflow in the body frame (direction the air moves relative to the vehicle). */
  airflowBody: THREE.Vector3;
  /** 0..1 hot staging: ship engines firing into the booster's vented ring. */
  hotStage: number;
  phase: PhaseCode;
  /** Unit vector towards the Sun in the body frame (for effects that need it). */
  sunBody: THREE.Vector3;
}

export interface VehicleModel {
  /** Origin at the centre of the base (engine gimbal plane), +Y towards the nose, +Z belly. Plumes extend along -Y. */
  object: THREE.Group;
  /** Overall length and radius, m. */
  length: number;
  radius: number;
  update(state: VehicleVisualState, camera: THREE.Camera, dt: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

export interface ShipModel extends VehicleModel {
  /** 0 closed .. 1 open (Starlink "Pez" dispenser door). */
  setPayloadDoor(open: number): void;
}

export interface VehicleFactory {
  createBooster(gen: Generation, quality: Quality): VehicleModel;
  createShip(gen: Generation, quality: Quality): ShipModel;
}

// ---------------------------------------------------------------------------
// Launch pad (tower, launch mount, chopsticks, tank farm)
// ---------------------------------------------------------------------------

export interface PadState {
  t: number;
  /** Height of the chopstick arms' underside above the ground, m. */
  armsHeight: number;
  /** 0 = arms closed (catch / holding), 1 = fully open. */
  armsOpen: number;
  /** 0..1 water deluge / exhaust intensity (first ~20 s after ignition). */
  deluge: number;
}

export interface PadModel {
  /** Origin on the ground at the launch mount centre, +X local east, +Y local up, +Z local south (right-handed). */
  object: THREE.Group;
  /** Height of the booster base above the ground while on the mount, m. */
  mountHeight: number;
  /** Tower position in the pad frame (metres) and its height. */
  tower: { x: number; z: number; height: number };
  update(state: PadState, dt: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export interface Explosion {
  object: THREE.Object3D;
  /** Start a fireball/debris burst. `scale` ~ vehicle size in m. `airDensityRatio` 1 at sea level, 0 in space. */
  trigger(scale: number, airDensityRatio: number): void;
  /** `age` = seconds since trigger (negative = not triggered). Deterministic so scrubbing works. */
  setAge(age: number): void;
  dispose(): void;
}

export interface LaunchClouds {
  /** Placed by the stage in the pad frame (same frame as PadModel.object). */
  object: THREE.Object3D;
  /** Deterministic in `t` (seconds since T+0) so scrubbing backwards works. `thrust` 0..1 of full liftoff thrust. */
  update(t: number, thrust: number, camera: THREE.Camera): void;
  dispose(): void;
}

export interface Splash {
  object: THREE.Object3D;
  /** `age` seconds since the vehicle touched the water. Deterministic. */
  setAge(age: number, scale: number): void;
  dispose(): void;
}

export interface StarlinkSwarm {
  object: THREE.Object3D;
  /** Up to `capacity` satellites. Positions are camera-relative metres; quaternions in world space. */
  setCount(n: number): void;
  setSatellite(i: number, position: THREE.Vector3, quaternion: THREE.Quaternion): void;
  commit(): void;
  dispose(): void;
}

export interface EffectsFactory {
  createExplosion(): Explosion;
  createLaunchClouds(quality: Quality): LaunchClouds;
  createSplash(): Splash;
  createStarlinkSwarm(capacity: number, kind: 'starlink-sim' | 'starlink-v3'): StarlinkSwarm;
}
