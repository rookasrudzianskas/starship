import * as THREE from 'three';
import { getFlight, PADS, type Flight } from '@/lib/flights/catalog';
import type { AtmosphereState } from '@/lib/sim/atmosphere';
import { EARTH_RADIUS, ENGINE_LIT, ENGINE_OFF, Phase, type FlightResult, type Generation, type PadId, type Track, type VehicleId } from '@/lib/sim/types';
import { COAST_RATE, useReplay, type ReplayState } from '@/lib/store/replay';
import { engineStates, isStacked } from '@/lib/telemetry';
import { createEarth, sunDirectionEcef, type EarthHandle } from '@/lib/three/earth';
import { createExplosion, createLaunchClouds, createSplash, createStarlinkSwarm } from '@/lib/three/effects';
import { CHOPSTICK_RAIL_TOP, createPad } from '@/lib/three/pad';
import { boosterCatchHeight, createBooster, createShip, prefetchProceduralTextures } from '@/lib/three/vehicles';
import type { EarthFrame, Explosion, LaunchClouds, PadModel, Quality, ShipModel, Splash, StarlinkSwarm, VehicleModel, VehicleVisualState } from '@/lib/three/contracts';
import { alongsidePose, blendAround, blendPose, ChaseCamera, copyPose, createPose, fitPoints, FreeCamera, GlobeCamera, onboardPose, trackerPose, WHEEL_ZOOM, type CameraPose, type DragInput, type Focus } from './cameras';
import { createCoastPrediction, predictCoast, type CoastPrediction } from './coast';
import { computeCourse, courseAt } from './course';
import { AERIAL_TRACKING_FROM, autoShot, pickedShot, planDirector, type DirectorPlan, type Shot, type ShotId } from './director';
import { flightEnvironmentInto, resultWindPeak } from './flightEnvironment';
import { copy3, damp, dist3, enuQuaternion, latLonToEcef, offsetEnu, type V3 } from './geo';
import { Overlay } from './overlay';
import { EventGates, TrajectoryLines, type GateMark } from './paths';
import { ResolutionGovernor } from './resolution';
import { createSample, firstPhaseTime, sampleTrack, type StageSample } from './sample';

export interface StageCallbacks {
  /** The view shows a good frame: after the first load, after attach() and after recovering from an error. */
  onReady(): void;
  /** The view can't be drawn. The stage tries again when the flight, scenario or quality changes, or the graphics context comes back. */
  onError(error: unknown): void;
}

/**
 * One stage serves the whole session (see components/replay/Stage.tsx): it owns its canvas, which attach()
 * moves into the page and detach() takes out again, so leaving the replay and coming back keeps the renderer,
 * the imagery, the models and the compiled shaders.
 */
export interface StageHandle {
  readonly canvas: HTMLCanvasElement;
  /** Show the stage in `host` (the canvas and its label layer move there) and report to `callbacks`. */
  attach(host: HTMLElement, callbacks: StageCallbacks): void;
  /** Take the stage out of `host` and stop drawing and reporting; everything built stays for the next attach(). */
  detach(host: HTMLElement): void;
  /** Called every animation frame by the replay clock; draws only when something visible changed. */
  render(t: number, dt: number): void;
  /**
   * How far page controls reach over the top and bottom of the view (CSS px): shots frame their subject in the
   * height left between them.
   */
  setInsets(top: number, bottom: number): void;
  resetCamera(): void;
  dispose(): void;
}

interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A released satellite: where it left the ship and how it drifts away. */
interface Satellite {
  t: number;
  /** From the ship's centre of mass at release to the satellite's centre (ECEF, m), and its drift (m/s). */
  offset: V3;
  drift: V3;
  /** Attitude at release (the ship's), and the slow tumble that starts once it is out of the slot. */
  quat: THREE.Quaternion;
  spin: number;
  clear: number;
  /** Seconds after release before it is drawn (when it can't be started inside the slot). */
  hidden: number;
}

/** Per-vehicle render state. */
interface Rig {
  id: VehicleId;
  model: VehicleModel | ShipModel | null;
  sample: StageSample;
  engines: Uint8Array;
  base: V3;
  center: V3;
  visible: boolean;
  visual: VehicleVisualState;
  atmosphere: AtmosphereState;
  explosion: Explosion | null;
  splash: Splash | null;
  touchdown: number | null;
  coast: CoastPrediction;
  /** Where the vehicle is heading over the ground, per sample of its track (see course.ts). */
  course: Float32Array;
}

function makeRig(id: VehicleId): Rig {
  return {
    id,
    model: null,
    sample: createSample(),
    engines: new Uint8Array(id === 'booster' ? 33 : 6),
    base: [0, 0, 0],
    center: [0, 0, 0],
    visible: true,
    visual: {
      t: 0,
      engines: new Uint8Array(id === 'booster' ? 33 : 6),
      throttle: 0,
      ambientPressure: 101325,
      mach: 0,
      aero: [0, 0, 0, 0],
      heating: 0,
      airflowBody: new THREE.Vector3(0, 1, 0),
      hotStage: 0,
      phase: Phase.Pad,
      sunBody: new THREE.Vector3(0, 1, 0),
    },
    atmosphere: { pressure: 0, density: 0, temperature: 0, speedOfSound: 0 },
    explosion: null,
    splash: null,
    touchdown: null,
    coast: createCoastPrediction(COAST_POINTS),
    course: new Float32Array(0),
  };
}

/** Fallback lengths before the models exist (the models report their own, e.g. without Flight 1's ring). */
const LENGTH: Record<Generation, { booster: number; ship: number }> = {
  b1: { booster: 70.8, ship: 50.3 },
  b2: { booster: 70.8, ship: 52.1 },
  v3: { booster: 72, ship: 52.1 },
};

/** Coast prediction: horizon, point budget and refresh interval during playback (wall-clock ms). */
const COAST_SECONDS = 7200;
const COAST_POINTS = 560;
const COAST_REFRESH_MS = 100;
/** After a change that needs drawing, keep drawing this long: the Earth refreshes its lighting a few times a second. */
const SETTLE_MS = 1200;
/** While nothing changes, still redraw this often, for anything that arrives without telling the stage. */
const KEEPALIVE_MS = 1000;
/** A long build step is followed by the next one only in a later frame. */
const BUILD_BUDGET_MS = 8;
/** If shader compilation never reports back (a lost context), draw anyway after this long. */
const WARM_TIMEOUT_MS = 5000;
/** If the worker's textures haven't arrived after this long, build anyway (whatever is missing is made on the spot). */
const PIXELS_WAIT_MS = 2500;
/** The payload door opens over this many seconds, fully open DOOR_LEAD s before the first release. */
const DOOR_TRAVEL = 25;
const DOOR_LEAD = 5;
const SWARM_CAPACITY = 48;
/** Highest eye adaptation while a lit plume fills the view: it is the brightest thing there, even at night. */
const PLUME_EXPOSURE = 1.3;
/** How far the eye adaptation stops down right by the blazing hot-staging vents (a share of the exposure). */
const VENT_STOP = 0.4;
/**
 * After a jump in time (a seek) the eye adaptation follows the Earth's metering at once, for this long (wall-clock
 * ms, enough for the Earth to meter the new view at either quality): the view arrives already adapted.
 */
const ADAPTED_MS = 1200;
/**
 * Camera changes blend only between views this close (m) whose straight path stays above the ground; views farther
 * apart (another vehicle, half a world away) are cut to.
 */
const BLEND_REACH = 30_000;
/** Pixels per CSS pixel a context without MSAA renders at least, before the resolution governor steps down. */
const NO_MSAA_MIN_RATIO = 1.5;
/** Picture-in-picture frame: at most this wide (CSS px), with this aspect. */
const PIP_WIDTH = 320;
const PIP_ASPECT = 0.62;
const PIP_HEIGHT = Math.round(PIP_WIDTH * PIP_ASPECT);
/**
 * Where the booster's onboard cameras can sit: azimuths round its body (radians from +Z towards +X) halfway between
 * its grid fins, per generation (see lib/three/vehicles/booster.ts).
 */
const BOOSTER_MOUNTS: Record<Generation, readonly number[]> = {
  b1: [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2],
  b2: [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2],
  v3: [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3],
};
/**
 * How far below the booster's top its camera looking up at the ship sits (m): a couple of metres under the vented
 * interstage, which is taller on the V3 booster than the separate ring of the earlier ones.
 */
const BOOSTER_TOP_DROP: Record<Generation, number> = { b1: 4, b2: 4, v3: 6.5 };
/** Size of a vehicle's breakup (the explosion's scale, m): cameras widen out to its debris cloud. */
const BREAKUP_SCALE: Record<VehicleId, number> = { booster: 70, ship: 50 };
/** Size of the body making a splash (the effect's scale, m), and how much wider cameras frame while its spray is up. */
const SPLASH_SCALE: Record<VehicleId, number> = { booster: 72, ship: 52 };
const SPLASH_SPREAD: Record<VehicleId, number> = { booster: 140, ship: 120 };
/**
 * Free height (fraction of the frame) the chase distance is made for: frames with less, because page controls
 * cover more of them, stand further back.
 */
const CHASE_BAND = 0.6;

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const qInv = new THREE.Quaternion();
const shakeEuler = new THREE.Euler();
const shakeQuat = new THREE.Quaternion();
const satPos = new THREE.Vector3();
const satQuat = new THREE.Quaternion();
const satSpin = new THREE.Quaternion();
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const site: V3 = [0, 0, 0];
const endPos: V3 = [0, 0, 0];
/** Both ends of both vehicles, for the shot that frames the two of them. */
const ends: V3[] = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];
const pt = { x: 0, y: 0 };
/** The opening shot, for the moment before the director has a plan. */
const PAD_SHOT: Shot = { id: 'pad', vehicle: 'booster' };
/** Height of one row of labels over the view, CSS px. */
const LABEL_ROW = 15;

/** Average width of a letter in a label's title (vehicles, event gates) and in its second part, CSS px (overlay.ts). */
const LABEL_CHAR_VEHICLE = 8;
const LABEL_CHAR_GATE = 7.6;
const LABEL_CHAR_SUB = 7;

/**
 * About how wide a label is (CSS px), with a little room after it: worked out from its letters, not read back from
 * the page every frame.
 */
function labelWidth(title: string, sub: string, kind: 'vehicle' | 'gate'): number {
  const head = kind === 'vehicle' ? 15 + title.length * LABEL_CHAR_VEHICLE : title.length * LABEL_CHAR_GATE;
  return Math.ceil(head + (sub ? 8 + sub.length * LABEL_CHAR_SUB : 0)) + 6;
}

/** Ray from a to b passes through the Earth before reaching b. */
function hiddenByEarth(a: V3, b: V3): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1) return false;
  const tc = -(a[0] * dx + a[1] * dy + a[2] * dz) / len2;
  if (tc <= 0 || tc >= 1) return false;
  const cx = a[0] + dx * tc;
  const cy = a[1] + dy * tc;
  const cz = a[2] + dz * tc;
  return cx * cx + cy * cy + cz * cz < 6_368_000 * 6_368_000;
}

/** Lowest altitude (m above the sea) on the straight line from a to b. */
function segmentAltitude(a: V3, b: V3): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  const tc = len2 < 1 ? 0 : Math.min(1, Math.max(0, -(a[0] * dx + a[1] * dy + a[2] * dz) / len2));
  return Math.hypot(a[0] + dx * tc, a[1] + dy * tc, a[2] + dz * tc) - EARTH_RADIUS;
}

/** The track ends in a breakup (the explosion effect plays where it ends). */
function breaksUp(track: Track): boolean {
  return track.endKind === 'lost' || track.endKind === 'termination' || track.endKind === 'impact';
}

/**
 * About how wide the cloud of a breakup of size `scale` (m) is `age` s after it, at `alt` m (cameras widen out to
 * it): after lib/three/effects/explosion.ts, which blends a vacuum burst, whose vapour shells race out and slow
 * over a few seconds, with a fireball in air, which stays within a few times its size.
 */
function breakupSpread(scale: number, age: number, alt: number): number {
  const air = Math.pow(Math.exp(-Math.max(0, alt) / 8500), 0.3);
  const shells = 0.12 + 1.8 * 6 * (1 - Math.exp(-age / 6));
  return scale * (2.2 * shells * (1 - air) + 4 * air) * smoothstep(0, 2.5, age);
}

function smoothstep(a: number, b: number, x: number): number {
  const k = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return k * k * (3 - 2 * k);
}

/** How many of a vehicle's engines burn this frame. */
function litEngines(rig: Rig): number {
  let lit = 0;
  for (let i = 0; i < rig.visual.engines.length; i++) if (rig.visual.engines[i] === ENGINE_LIT) lit++;
  return lit;
}

/**
 * The same view to within a fifth of a pixel, for a frame `height` pixels tall whose subject is `range` metres
 * away (smoothed cameras creep towards their goal for seconds; a paused view need not follow every creep).
 */
function samePose(a: CameraPose, b: CameraPose, height: number, range: number): boolean {
  const tol = (0.2 * ((a.fov * Math.PI) / 180)) / Math.max(1, height);
  const dx = a.pos[0] - b.pos[0];
  const dy = a.pos[1] - b.pos[1];
  const dz = a.pos[2] - b.pos[2];
  const r = tol * Math.max(1, range);
  // For unit quaternions 1 - |dot| is about angle^2 / 8.
  return dx * dx + dy * dy + dz * dz < r * r && 1 - Math.abs(a.quat.dot(b.quat)) < (tol * tol) / 8 && Math.abs(a.fov - b.fov) < (0.2 * a.fov) / Math.max(1, height);
}

/**
 * Centre of the payload slot on the hull and its outward direction, in the ship's model frame, from the model's
 * door panel; null if the model has none.
 */
function payloadSlot(model: ShipModel): { pos: THREE.Vector3; out: THREE.Vector3 } | null {
  const door = model.object.getObjectByName('payload-door') as THREE.Mesh | undefined;
  if (!door?.isMesh || door.parent !== model.object) return null;
  if (!door.geometry.boundingBox) door.geometry.computeBoundingBox();
  const bb = door.geometry.boundingBox;
  if (!bb || bb.isEmpty()) return null;
  // Where the closed door sits (the geometry, not the panel's current position), on the hull's outer surface:
  // the box centre of a curved panel lies a little inside it.
  const pos = bb.getCenter(new THREE.Vector3());
  const out = new THREE.Vector3(pos.x, 0, pos.z);
  if (out.lengthSq() < 1) return null;
  out.normalize();
  const radius = Math.max(bb.min.x * out.x + bb.min.z * out.z, bb.max.x * out.x + bb.max.z * out.z, bb.min.x * out.x + bb.max.z * out.z, bb.max.x * out.x + bb.min.z * out.z);
  pos.set(out.x * radius, pos.y, out.z * radius);
  return { pos, out };
}

export function createStage(): StageHandle {
  const canvas = document.createElement('canvas');
  let quality: Quality = useReplay.getState().settings.quality === 'low' ? 'low' : 'high';
  const renderer = new THREE.WebGLRenderer({
    canvas,
    // Rendering at two or more pixels per CSS pixel the edges are fine without MSAA, which costs a fifth to two
    // fifths of the GPU time there. Low quality renders one pixel per CSS pixel, where MSAA is cheap and needed.
    antialias: (window.devicePixelRatio || 1) < 1.5 || quality === 'low',
    logarithmicDepthBuffer: true,
    powerPreference: 'high-performance',
    alpha: false,
  });
  // MSAA is fixed with the context. Without it (made for a high-density screen), one pixel per CSS pixel would
  // leave every edge jagged: low quality there, or the window moved to a standard-density screen, renders at
  // NO_MSAA_MIN_RATIO instead.
  const msaa = renderer.getContext().getContextAttributes()?.antialias ?? true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 1);
  const gl = renderer.getContext() as WebGL2RenderingContext;
  let governor = new ResolutionGovernor(gl);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.3, 4e8);
  const sideCamera = new THREE.PerspectiveCamera(40, 1, 0.3, 4e8);
  const overlay = new Overlay();

  let width = 1;
  let height = 1;
  let dprSeen = 0;
  /** How far page controls reach over the top and bottom of the view (CSS px; see setInsets). */
  const insets = { top: 0, bottom: 0 };

  // ------------------------------------------------------------ lifecycle
  let host: HTMLElement | null = null;
  let callbacks: StageCallbacks | null = null;
  let disposed = false;
  /** The graphics context is gone (until 'webglcontextrestored'). */
  let lost = false;
  /** The last error and what it happened with: nothing is retried until one of these changes. */
  let failure: { error: unknown; result: FlightResult | null; baseline: FlightResult | null; quality: Quality } | null = null;
  /** onReady has been sent since the last attach() or error. */
  let announced = false;

  // ---------------------------------------------------------- draw state
  /** Something changed that the checks below can't see: draw the next frame. */
  let dirty = true;
  /** The result on the canvas (null: it shows black). */
  let shown: FlightResult | null = null;
  let drawnT = NaN;
  let drawnAt = -Infinity;
  let changedAt = -Infinity;
  const drawnPose = createPose();
  const drawnLeft = createPose();
  const drawnPip = createPose();
  const drawnLayout = { split: false, pip: '', w: 0, h: 0 };
  const seen = { settings: null as unknown, camera: '', follow: '', shot: '', pip: false, textures: -1, geometries: -1 };
  /** Shader warm-up: compile on the next frame (after preparing it), and waiting for the compile to finish. */
  let warmQueued = false;
  let warming = false;
  let warmToken = 0;

  /**
   * The page scrolls (narrow or short windows put the HUD below the view): the webcast, which has no controls of its
   * own, then leaves the wheel and vertical drags to the page instead of handing over to the free camera.
   */
  let pageScrolls = false;
  let touchMode = '';
  const measurePage = () => {
    const se = document.scrollingElement;
    pageScrolls = se !== null && se.scrollHeight > se.clientHeight + 1;
    updateTouchAction(useReplay.getState().camera);
  };
  /** Over the webcast a vertical drag scrolls a page that scrolls; the cameras keep every gesture. */
  const updateTouchAction = (cameraMode: string) => {
    const mode = pageScrolls && cameraMode === 'webcast' ? 'pan-y' : '';
    if (mode === touchMode) return;
    touchMode = mode;
    canvas.style.touchAction = mode;
  };

  const applySize = () => {
    measurePage();
    dprSeen = window.devicePixelRatio || 1;
    const base = Math.min(dprSeen, quality === 'high' ? 2 : 1);
    governor.setBase(msaa ? base : Math.max(base, NO_MSAA_MIN_RATIO));
    const rect = canvas.getBoundingClientRect();
    // Hidden or out of the page: keep the drawing buffer (and the last frame in it) as it is.
    if (rect.width < 1 || rect.height < 1) return;
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    const ratio = governor.ratio;
    if (w === width && h === height && ratio === renderer.getPixelRatio()) return;
    width = w;
    height = h;
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    governor.reset();
    dirty = true;
  };
  const ro = new ResizeObserver(applySize);
  ro.observe(canvas);

  // ------------------------------------------------------------ scene graph
  // Everything built is kept for the session: one Earth for both pads, a model per pad and a booster and ship per
  // vehicle generation. Switching flights only swaps what is in the scene, so nothing is rebuilt or recompiled.
  let earth: EarthHandle | null = null;
  let exposure = 1;
  /** Simulation time of the last frame, and until when (wall clock) the exposure follows its goal at once. */
  let frameT = NaN;
  let adaptedUntil = -Infinity;
  let earthReady = false;
  const padModels = new Map<PadId, PadModel>();
  const boosterModels = new Map<Generation, VehicleModel>();
  const shipModels = new Map<Generation, ShipModel>();
  let pad: PadModel | null = null;
  let padId: PadId | null = null;
  let padEcef: V3 = [0, 0, 0];
  const padQuat = new THREE.Quaternion();
  let clouds: LaunchClouds | null = null;
  /** Satellite swarms by kind (kept, like the models), and the one in the scene. */
  const swarms = new Map<'starlink-sim' | 'starlink-v3', StarlinkSwarm>();
  let swarm: StarlinkSwarm | null = null;
  let generation: Generation | null = null;
  const booster = makeRig('booster');
  const ship = makeRig('ship');
  const rigs = [booster, ship];
  let lines: TrajectoryLines | null = null;
  let gates: EventGates | null = null;
  let plan: DirectorPlan | null = null;
  let current: FlightResult | null = null;
  let currentBaseline: FlightResult | null = null;
  /** Wind belongs to the displayed worker result, which may lag behind the director's scenario. */
  let environmentResult: FlightResult | null = null;
  let environmentScenario: ReplayState['scenario'] | null = null;
  let windPeak = 0;
  /** Side of the booster its onboard cameras are on (see sunlitMount). */
  let boosterMount = 0;
  let catchTime: number | null = null;
  let catchArmsHeight: number | null = null;
  let sats: Satellite[] = [];
  /** The payload door is fully open from door[0] to door[1]. */
  let door: [number, number] | null = null;
  /** The payload slot on the ship's hull (model frame), which the director's payload camera looks past. */
  let doorSlot: { pos: THREE.Vector3; out: THREE.Vector3 } | null = null;
  let flightN = 0;
  /** Simulation time of the last model and pad update, and whether the next model update must snap (new models or result). */
  let modelT = 0;
  let modelsFresh = true;
  let padT = 0;

  const sunDir = new THREE.Vector3(1, 0, 0);
  const earthFrame: EarthFrame = { cameraEcef: [0, 0, 0], camera, sunDir, time: 0 };
  /** Frame titles and gate labels for the current flight, made once per result rather than every frame. */
  const titles = { booster: '', ship: '', stack: 'Super Heavy · Starship' };
  const gateLabels = new WeakMap<GateMark, { id: string; time: string; color: string; width: number }>();

  function createEarthFor(p: PadId) {
    const e = createEarth({ renderer, scene, quality, pad: p });
    earth = e;
    earthReady = false;
    // The sun light carries its own target as a child. Sky light comes from scene.environment (set by the
    // Earth), so the hemisphere light is left out to avoid lighting PBR materials twice.
    scene.add(e.object, e.sunLight);
    // If the imagery fails the Earth logs it and shows a plain globe, which still beats no 3D view at all.
    const settle = () => {
      if (earth !== e || disposed) return;
      earthReady = true;
      // The imagery brings the ground patch: compile its shader before it is drawn.
      if (current) warm();
      dirty = true;
    };
    e.ready.then(settle, settle);
  }

  /**
   * The noise, smoke and steel textures of the pad, vehicles and clouds are made in a worker (see
   * lib/three/vehicles), asked for as soon as the quality is known and again when it changes. Those models are
   * built once the textures are in (the Earth's imagery takes longer anyway), rather than making them a second
   * time here, which would stall the page for a few hundred milliseconds.
   */
  let pixelsReady = false;
  let pixelsToken = 0;
  function prefetchPixels(q: Quality) {
    const token = ++pixelsToken;
    pixelsReady = false;
    const done = () => {
      if (token === pixelsToken) pixelsReady = true;
    };
    prefetchProceduralTextures(q).then(done, done);
    window.setTimeout(done, PIXELS_WAIT_MS);
  }
  prefetchPixels(quality);

  /**
   * Builds one missing piece for a flight. Each takes from a few to tens of milliseconds (geometry, generated
   * textures), so pieces are spread over frames instead of stalling one. Returns false when there is nothing to
   * build now: all pieces are there, or the rest waits for the worker's textures.
   */
  function buildStep(flight: Flight): boolean {
    if (!earth) createEarthFor(flight.pad);
    else if (!pixelsReady) return false;
    else if (!padModels.has(flight.pad)) padModels.set(flight.pad, createPad(flight.pad, quality));
    else if (!boosterModels.has(flight.generation)) boosterModels.set(flight.generation, createBooster(flight.generation, quality));
    else if (!shipModels.has(flight.generation)) shipModels.set(flight.generation, createShip(flight.generation, quality));
    else if (!clouds) clouds = createLaunchClouds(quality);
    else return false;
    return true;
  }

  function built(flight: Flight): boolean {
    return earth !== null && padModels.has(flight.pad) && boosterModels.has(flight.generation) && shipModels.has(flight.generation) && clouds !== null;
  }

  /** Put the pad's model in the scene. Returns true if something was added. */
  function activatePad(p: PadId): boolean {
    const next = padModels.get(p) ?? null;
    earth?.setPad(p);
    if (!next || pad === next) return false;
    if (pad) scene.remove(pad.object);
    pad = next;
    padId = p;
    const s = PADS[p];
    padEcef = latLonToEcef(s.lat, s.lon, s.groundAlt);
    enuQuaternion(padEcef, padQuat);
    scene.add(next.object);
    return true;
  }

  function activateVehicles(gen: Generation): boolean {
    const b = boosterModels.get(gen) ?? null;
    const s = shipModels.get(gen) ?? null;
    if (!b || !s || (booster.model === b && ship.model === s)) return false;
    if (booster.model) scene.remove(booster.model.object);
    if (ship.model) scene.remove(ship.model.object);
    booster.model = b;
    ship.model = s;
    scene.add(b.object, s.object);
    generation = gen;
    modelsFresh = true;
    return true;
  }

  /** Builds what depends on the result. Returns true if objects were added to the scene (compile them first). */
  function rebuild(result: FlightResult, baseline: FlightResult | null): boolean {
    const flight = getFlight(result.flight);
    const newFlight = flightN !== result.flight;
    flightN = result.flight;
    let added = activatePad(flight.pad);
    added = activateVehicles(flight.generation) || added;
    if (clouds && !clouds.object.parent) {
      scene.add(clouds.object);
      added = true;
    }
    booster.model?.object.userData.setHotStageRing?.(flight.n !== 1);

    if (!lines) {
      lines = new TrajectoryLines(padEcef);
      scene.add(lines.group);
      added = true;
    }
    lines.setResult(result, baseline);

    if (!gates) {
      gates = new EventGates();
      scene.add(gates.mesh);
      added = true;
    }
    overlay.clearGates();
    gates.setResult(result);

    boosterMount = sunlitMount(result, flight.generation);
    titles.booster = `Super Heavy ${flight.boosterId}`.trim();
    titles.ship = `Starship ${flight.shipId}`;
    plan = planDirector(result);
    // The payload camera has nothing to show in the Earth's shadow: the director watches only the sunlit releases.
    plan.releases = plan.releases.filter((t) => sunlit(result, t));
    catchTime = result.booster.endKind === 'catch' ? firstPhaseTime(result.booster, Phase.Caught) ?? result.booster.end : null;
    // Arms close just under the grid fins: base height above the pad at the catch + the catch point on the booster.
    catchArmsHeight = null;
    if (catchTime !== null) {
      const probe = createSample();
      sampleTrack(result.booster, catchTime, probe);
      v1.set(0, 1, 0).applyQuaternion(probe.quat);
      const base: V3 = [probe.pos[0] - v1.x * probe.com, probe.pos[1] - v1.y * probe.com, probe.pos[2] - v1.z * probe.com];
      v2.set(padEcef[0], padEcef[1], padEcef[2]).normalize();
      const baseHeight = (base[0] - padEcef[0]) * v2.x + (base[1] - padEcef[1]) * v2.y + (base[2] - padEcef[2]) * v2.z;
      catchArmsHeight = baseHeight + boosterCatchHeight(flight.generation) - CHOPSTICK_RAIL_TOP;
    }

    for (const rig of rigs) {
      const track = rig.id === 'booster' ? result.booster : result.ship;
      rig.course = computeCourse(track);
      rig.engines = new Uint8Array((rig.id === 'booster' ? result.boosterEngines : result.shipEngines).slots.length);
      rig.visual.engines = new Uint8Array(rig.engines.length);
      if (breaksUp(track)) {
        if (!rig.explosion) {
          rig.explosion = createExplosion();
          scene.add(rig.explosion.object);
          added = true;
        }
        const alt = track.alt[track.n - 1];
        rig.explosion.trigger(BREAKUP_SCALE[rig.id], Math.exp(-Math.max(0, alt) / 8500));
      }
      rig.touchdown = firstPhaseTime(track, Phase.Splashed);
      if (rig.touchdown !== null && !rig.splash) {
        rig.splash = createSplash();
        scene.add(rig.splash.object);
        added = true;
      }
    }

    const kind = flight.plan.ship.payloadKind === 'none' ? 'starlink-v3' : flight.plan.ship.payloadKind;
    if (result.payload.length > 0 && swarm !== swarms.get(kind)) {
      if (swarm) scene.remove(swarm.object);
      let next = swarms.get(kind);
      if (!next) {
        next = createStarlinkSwarm(SWARM_CAPACITY, kind);
        swarms.set(kind, next);
      }
      swarm = next;
      scene.add(swarm.object);
      added = true;
    }
    placePayload(result);
    if (newFlight) {
      globe.reset();
      free.reset();
      freeLeft.reset();
    }
    current = result;
    currentBaseline = baseline;
    coastFor = null;
    modelsFresh = true;
    dirty = true;
    return added;
  }

  /**
   * Satellites leave through the payload slot: each starts inside it, its long axis pointing out, and slides out
   * at its separation speed (so it emerges from the open door rather than appearing through the hull), then
   * tumbles slowly. The door opens before the first release and closes once the last one is clear.
   */
  function placePayload(result: FlightResult) {
    sats = [];
    door = null;
    doorSlot = null;
    if (result.payload.length === 0) return;
    const slot = ship.model ? payloadSlot(ship.model as ShipModel) : null;
    doorSlot = slot;
    let length = 0;
    swarm?.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || length > 0) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      // Satellite frame: X width, Y thickness, Z length.
      if (m.geometry.boundingBox) length = m.geometry.boundingBox.getSize(v1).z;
    });
    const probe = createSample();
    let clearBy = -Infinity;
    for (const p of result.payload.slice(0, SWARM_CAPACITY)) {
      sampleTrack(result.ship, p.t, probe);
      const drift: V3 = [p.vel[0] - probe.vel[0], p.vel[1] - probe.vel[1], p.vel[2] - probe.vel[2]];
      const speed = Math.max(0.05, Math.hypot(drift[0], drift[1], drift[2]));
      const quat = probe.quat.clone();
      let offset: V3;
      let clear = 0;
      let hidden = 0;
      if (slot && length > 0) {
        // Centre half a length inside the slot opening, relative to the centre of mass (model origin at the base).
        v1.copy(slot.pos).addScaledVector(slot.out, -length / 2);
        v1.y -= probe.com;
        v1.applyQuaternion(quat);
        offset = [v1.x, v1.y, v1.z];
        clear = length / speed;
      } else {
        // No slot to start from: the simulated release point, hidden until it has moved off the hull.
        offset = [p.pos[0] - probe.pos[0], p.pos[1] - probe.pos[1], p.pos[2] - probe.pos[2]];
        hidden = 0.5;
      }
      sats.push({ t: p.t, offset, drift, quat, spin: 0.01 + 0.012 * ((p.index * 0.618) % 1), clear, hidden });
      clearBy = Math.max(clearBy, p.t + clear);
    }
    const first = result.payload[0].t;
    const end = result.events.find((e) => e.key === 'payload-end')?.t ?? -Infinity;
    door = [first - DOOR_LEAD, Math.max(end, clearBy + DOOR_LEAD)];
  }

  /** The ship is in sunlight at t (outside the Earth's shadow, taken as a cylinder). */
  function sunlit(result: FlightResult, t: number): boolean {
    const probe = createSample();
    sampleTrack(result.ship, t, probe);
    sunDirectionEcef(result.launchUtc + t * 1000, v1);
    const along = probe.pos[0] * v1.x + probe.pos[1] * v1.y + probe.pos[2] * v1.z;
    const r2 = probe.pos[0] ** 2 + probe.pos[1] ** 2 + probe.pos[2] ** 2;
    return along > 0 || r2 - along * along > EARTH_RADIUS * EARTH_RADIUS;
  }

  /**
   * The booster's onboard cameras are mounted on a side the Sun lights at staging, when they are on most, so they
   * look along shaded, sunlit steel rather than a black silhouette: the side lit most nearly from 75 degrees off its
   * face (lit more squarely, the polished steel glares white, the more so as the cameras look up towards the Sun),
   * or failing that the least dark one. Azimuth round the body, radians.
   */
  function sunlitMount(result: FlightResult, gen: Generation): number {
    const t = (result.separationT ?? 63) - 3;
    const probe = createSample();
    sampleTrack(result.booster, t, probe);
    sunDirectionEcef(result.launchUtc + t * 1000, v1).applyQuaternion(qInv.copy(probe.quat).invert());
    let best = 0;
    let bestScore = -Infinity;
    for (const az of BOOSTER_MOUNTS[gen]) {
      // Cosine of the Sun's angle from the side's outward normal.
      const lit = Math.sin(az) * v1.x + Math.cos(az) * v1.z;
      const score = lit > 0.08 ? 2 - Math.abs(lit - 0.25) : lit;
      if (score > bestScore) {
        bestScore = score;
        best = az;
      }
    }
    return best;
  }

  /** Payload door opening at t: 0 closed .. 1 open. */
  function doorAt(t: number): number {
    if (!door) return 0;
    if (t < door[0]) return smoothstep(door[0] - DOOR_TRAVEL, door[0], t);
    if (t > door[1]) return 1 - smoothstep(door[1], door[1] + DOOR_TRAVEL, t);
    return 1;
  }

  // ------------------------------------------------------------ warm-up
  /**
   * three compiles a shader the first time something is drawn with it, which stalls that frame: effects that only
   * appear later in a flight (deluge, launch clouds, plumes, plasma, splashes) would freeze playback at their first
   * frame. So after anything new enters the scene, the next frame only prepares the scene (lights, fog and the
   * environment map are part of each shader) and compiles every material in it, hidden or not, in parallel where
   * KHR_parallel_shader_compile allows; drawing resumes once that has finished.
   */
  function warm() {
    warmQueued = true;
  }

  function compileScene(cam: THREE.Camera) {
    const token = ++warmToken;
    warming = true;
    const done = () => {
      if (token !== warmToken || !warming) return;
      warming = false;
      dirty = true;
    };
    renderer.compileAsync(scene, cam).then(done, done);
    window.setTimeout(done, WARM_TIMEOUT_MS);
  }

  // ------------------------------------------------------------- cameras
  const chase = new ChaseCamera();
  const chasePip = new ChaseCamera();
  const free = new FreeCamera();
  /** The split view's left half, on the booster; the right half is the main camera, on the ship. */
  const chaseLeft = new ChaseCamera();
  const freeLeft = new FreeCamera();
  const globe = new GlobeCamera();
  const pose = createPose();
  const pipPose = createPose();
  const leftPose = createPose();
  const lastPose = createPose();
  const fromPose = createPose();
  /** The pose a blend starts from, carried along with what that view was following. */
  const fromNow = createPose();
  const target = createPose();
  let blendT = 1;
  let blendDur = 1;
  /** The blend swings round the Earth (into or out of the globe) instead of cutting straight across. */
  let blendGlobe = false;
  /** What the view a blend starts from was following, and where that was when it was last posed. */
  let fromFocus: Focus | null = null;
  const fromAnchor: V3 = [0, 0, 0];
  /** Where the main view's subject was when the last pose was made (a blend starts from that pose). */
  const viewFocusAt: V3 = [0, 0, 0];
  let viewKey = '';
  let lastShot: Shot | null = null;
  /** What the main view follows (null for the globe), as of the last frame. */
  let viewFocus: Focus | null = null;
  /** The last frame could show the vehicles side by side: the split view, in the chase and free cameras. */
  let splitReady = false;
  /** Where the views were drawn last (CSS px), so pointer input goes to the camera under the pointer. */
  const shownViews = { split: false, half: 0, pip: false, pipX: 0, pipY: 0, pipW: 0, pipH: 0 };

  /** One camera's handle on pointer input; `pans`: two fingers moved together pan it (as a right-drag does). */
  interface Control {
    drag(d: DragInput): void;
    wheel(delta: number): void;
    readonly pans: boolean;
  }
  const mainSize = () => viewFocus?.size ?? focusB.size;
  const globeControl: Control = { drag: (d) => globe.drag(d), wheel: (delta) => globe.wheel(delta), pans: true };
  const freeControl: Control = { drag: (d) => free.drag(d, mainSize()), wheel: (delta) => free.wheel(delta, mainSize()), pans: true };
  const freeLeftControl: Control = { drag: (d) => freeLeft.drag(d, focusB.size), wheel: (delta) => freeLeft.wheel(delta, focusB.size), pans: true };
  const chaseControl: Control = { drag: (d) => chase.drag(d), wheel: (delta) => chase.wheel(delta), pans: false };
  const chaseLeftControl: Control = { drag: (d) => chaseLeft.drag(d), wheel: (delta) => chaseLeft.wheel(delta), pans: false };
  const pipControl: Control = { drag: (d) => chasePip.drag(d), wheel: (delta) => chasePip.wheel(delta), pans: false };

  /** The camera under a point of the canvas (CSS px); null over the webcast, which has no controls of its own. */
  function controlAt(x: number, y: number): Control | null {
    const v = shownViews;
    if (v.pip && x >= v.pipX && x < v.pipX + v.pipW && y >= v.pipY && y < v.pipY + v.pipH) return pipControl;
    const camera = useReplay.getState().camera;
    const left = v.split && x < v.half;
    if (camera === 'globe') return globeControl;
    if (camera === 'free') return left ? freeLeftControl : freeControl;
    if (camera === 'chase') return left ? chaseLeftControl : chaseControl;
    return null;
  }

  /**
   * Turning or zooming the webcast hands over to the free camera, starting from the view as it is: the same
   * direction onto the same vehicle, at the same size on screen. In the split view that vehicle may be the booster,
   * on the left.
   */
  function handOver(): Control {
    const f = viewFocus ?? focusB;
    const left = splitReady && f === focusB;
    (left ? freeLeft : free).takeOver(lastPose, f);
    useReplay.getState().setCamera('free');
    return left ? freeLeftControl : freeControl;
  }

  // Pointer input: one pointer (or the mouse) turns the camera under it, or pans it with the right button; two
  // pointers pinch to zoom and, moved together, pan. The gesture keeps the camera it started on.
  const pointers = new Map<number, { x: number; y: number }>();
  let control: Control | null = null;
  let button = 0;
  /**
   * How far a drag on the webcast has moved (px) in all and sideways: it takes over once that is clearly not a
   * click, or, on a touch screen where the page scrolls, once it is clearly not the page's vertical scroll.
   */
  let moved = 0;
  let sideways = 0;
  let upDown = 0;
  /** Distance between two pointers and their midpoint, as of the last move. */
  let pinch = 0;
  const mid = { x: 0, y: 0 };
  const measurePinch = (): number => {
    let n = 0;
    let ax = 0;
    let ay = 0;
    let bx = 0;
    let by = 0;
    for (const p of pointers.values()) {
      if (n === 0) {
        ax = p.x;
        ay = p.y;
      } else if (n === 1) {
        bx = p.x;
        by = p.y;
      }
      n++;
    }
    mid.x = (ax + bx) / 2;
    mid.y = (ay + by) / 2;
    return Math.hypot(bx - ax, by - ay);
  };
  const onPointerDown = (e: PointerEvent) => {
    if (pointers.size === 0) {
      const r = canvas.getBoundingClientRect();
      control = controlAt(e.clientX - r.left, e.clientY - r.top);
      button = e.button;
      moved = 0;
      sideways = 0;
      upDown = 0;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 2) pinch = measurePinch();
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 1) {
      if (!control) {
        moved += Math.abs(dx) + Math.abs(dy);
        sideways += dx;
        upDown += dy;
        // The browser scrolls the page with a vertical drag (touch-action: pan-y) and then cancels the pointer.
        const scrolling = touchMode === 'pan-y' && e.pointerType !== 'mouse';
        if (scrolling ? Math.abs(sideways) < 12 || Math.abs(sideways) < Math.abs(upDown) : moved < 4) return;
        control = handOver();
      }
      control.drag({ dx, dy, button });
    } else if (pointers.size === 2) {
      const mx = mid.x;
      const my = mid.y;
      const d = measurePinch();
      control ??= handOver();
      if (pinch > 0 && d > 0) control.wheel(Math.log(pinch / d) / WHEEL_ZOOM);
      if (control.pans) control.drag({ dx: mid.x - mx, dy: mid.y - my, button: 2 });
      pinch = d;
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    // Lifting one of two fingers leaves the other turning the view from where it is now.
    if (pointers.size === 0) control = null;
  };
  const onWheel = (e: WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    const under = controlAt(e.clientX - r.left, e.clientY - r.top);
    // Over the webcast the wheel scrolls a page that scrolls (a touchpad pinch, ctrl + wheel, still zooms); where
    // the page can't scroll it hands over to the free camera, as a drag does.
    if (!under && !e.ctrlKey) {
      measurePage();
      if (pageScrolls) return;
    }
    e.preventDefault();
    // Lines or pages (some mice in Firefox) count as about as far as the pixels of a touchpad.
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1);
    (under ?? handOver()).wheel(delta);
  };
  const onDblClick = (e: MouseEvent) => {
    const st = useReplay.getState();
    const r = canvas.getBoundingClientRect();
    if (st.camera === 'free') (shownViews.split && e.clientX - r.left < shownViews.half ? freeLeft : free).recentre();
    if (st.camera === 'globe') globe.reset();
  };
  const onContext = (e: Event) => e.preventDefault();
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('contextmenu', onContext);

  // A lost context takes every texture, buffer and shader with it (some imagery can't be uploaded again from
  // memory), so everything built is let go and built again, like a first load, once the browser restores it.
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    teardown();
    announced = false;
    callbacks?.onError(new Error('The 3D view lost its graphics context'));
  };
  const onRestored = () => {
    lost = false;
    failure = null;
    // The timer extension and its queries belong to the old context.
    governor = new ResolutionGovernor(gl);
    width = 0;
    applySize();
    dirty = true;
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  /** Vehicle lengths (m), asked for many times a frame: one object, refreshed on each call. */
  const vehicleLengths = { booster: 0, ship: 0 };
  function lengths(): { readonly booster: number; readonly ship: number } {
    const fallback = LENGTH[generation ?? 'v3'];
    vehicleLengths.booster = booster.model?.length ?? fallback.booster;
    vehicleLengths.ship = ship.model?.length ?? fallback.ship;
    return vehicleLengths;
  }

  const focusB: Focus = { pos: [0, 0, 0], course: [1, 0, 0], size: 70 };
  const focusS: Focus = { pos: [0, 0, 0], course: [1, 0, 0], size: 50 };
  const focusStack: Focus = { pos: [0, 0, 0], course: [1, 0, 0], size: 121 };
  const focusBoth: Focus = { pos: [0, 0, 0], course: [1, 0, 0], size: 121 };
  /** The pad camera's subject while the stack is near the ground: from the foot of the mount to the nose. */
  const focusPad: Focus = { pos: [0, 0, 0], course: [1, 0, 0], size: 150 };

  // ---------------------------------------------------------- vehicle state
  function updateRig(rig: Rig, result: FlightResult, t: number) {
    const track: Track = rig.id === 'booster' ? result.booster : result.ship;
    const timeline = rig.id === 'booster' ? result.boosterEngines : result.shipEngines;
    sampleTrack(track, t, rig.sample);
    if (rig.engines.length !== timeline.slots.length) rig.engines = new Uint8Array(timeline.slots.length);
    engineStates(timeline, Math.min(t, track.end), rig.engines);
    const s = rig.sample;
    const L = rig.id === 'booster' ? lengths().booster : lengths().ship;
    v1.set(0, 1, 0).applyQuaternion(s.quat);
    rig.base[0] = s.pos[0] - v1.x * s.com;
    rig.base[1] = s.pos[1] - v1.y * s.com;
    rig.base[2] = s.pos[2] - v1.z * s.com;
    rig.center[0] = rig.base[0] + v1.x * L * 0.5;
    rig.center[1] = rig.base[1] + v1.y * L * 0.5;
    rig.center[2] = rig.base[2] + v1.z * L * 0.5;

    const after = t > track.end;
    const k = track.endKind;
    rig.visible = !after || k === 'catch' || k === 'orbit' || (k === 'splashdown' && t < track.end + 45);

    const vis = rig.visual;
    vis.t = t;
    if (after) vis.engines.fill(ENGINE_OFF);
    else vis.engines.set(rig.engines);
    vis.throttle = after ? 0 : s.throttle;
    flightEnvironmentInto(s, windPeak, rig.atmosphere, vis);
    vis.mach = s.mach;
    vis.aero = s.aero;
    vis.heating = after ? 0 : s.heating;
    qInv.copy(s.quat).invert();
    vis.hotStage = !after && s.phase === Phase.HotStage ? 1 : 0;
    vis.phase = s.phase;
    vis.sunBody.copy(sunDir).applyQuaternion(qInv);
  }

  function setFocus(f: Focus, rig: Rig, track: Track, t: number, size: number) {
    copy3(rig.center, f.pos);
    if (rig.course.length === track.n * 3) courseAt(track, rig.course, t, f.pos, f.course);
    f.size = size;
  }

  /**
   * What cameras frame round a vehicle: its length, grown to take in its debris cloud once it has broken up, and
   * the spray of its splashdown while that is thick (so a camera stands back from it rather than in it).
   */
  function framedLength(rig: Rig, track: Track, t: number, length: number): number {
    if (breaksUp(track) && t > track.end) return length + breakupSpread(BREAKUP_SCALE[rig.id], t - track.end, track.alt[track.n - 1]);
    if (rig.splash && rig.touchdown !== null && t > rig.touchdown) {
      const age = t - rig.touchdown;
      return length + SPLASH_SPREAD[rig.id] * smoothstep(0, 2, age) * (1 - smoothstep(16, 30, age));
    }
    return length;
  }

  // ------------------------------------------------------------- shots
  const LOCAL = new THREE.Vector3();
  const DIR = new THREE.Vector3();
  const UP = new THREE.Vector3();
  const SIDE = new THREE.Vector3();

  /** What a shot of `vehicle` looks at: the stack until separation, and both vehicles for the director's staging shot. */
  function shotFocus(shot: Shot, t: number): Focus {
    if (current && isStacked(current, t)) return focusStack;
    if (shot.id === 'separation') return focusBoth;
    return shot.vehicle === 'ship' ? focusS : focusB;
  }

  /** A chase plane off the vehicle's right-hand side, keeping `f` side on with a long lens. */
  function aerialPose(f: Focus, band: number, out: CameraPose): CameraPose {
    return alongsidePose(f, 80, 3, f.size * 20, 0.72 * band, 0.12, 30, out);
  }

  /** A camera on the ground at `site` can see a vehicle it follows: still there, and above its horizon. */
  function inSight(vehicle: VehicleId, f: Focus): boolean {
    return (vehicle === 'booster' ? booster : ship).visible && !hiddenByEarth(site, f.pos);
  }

  /**
   * The pose of a webcast shot looking at `f`. Cameras that zoom fill a share of `band`, the part of the frame
   * height page controls leave free. False when the shot can't be shown: its vehicle is gone, or a camera on the
   * ground has lost it below the horizon.
   */
  function shotPose(shot: Shot, t: number, f: Focus, band: number, out: CameraPose): boolean {
    const L = lengths();
    switch (shot.id) {
      case 'pad': {
        offsetEnu(padEcef, 330, -260, 3, site);
        // Near the ground the mount stays in the picture.
        trackerPose(site, f === focusStack ? focusPad : f, 0.86 * band, 3, 62, out);
        return inSight(shot.vehicle, f);
      }
      case 'tower': {
        offsetEnu(padEcef, -60, -120, 40, site);
        // A long lens: the booster coming home is a few kilometres out when the shot comes up.
        trackerPose(site, f, 0.78 * band, 1.5, 70, out);
        return inSight(shot.vehicle, f);
      }
      case 'tracking': {
        if (t < AERIAL_TRACKING_FROM) {
          // A telescope on the ground north of the pad...
          offsetEnu(padEcef, 2600, 8800, 18, site);
          trackerPose(site, f, 0.8 * band, 0.12, 30, out);
        } else {
          // ...then a chase plane alongside.
          aerialPose(f, band, out);
        }
        return true;
      }
      case 'separation': {
        // The chase plane again, a little above them against the haze, framing both vehicles end to end as they
        // part: the ship pulling ahead, the booster turning back.
        alongsidePose(f, 80, 12, f.size * 20, 0.72 * band, 0.12, 30, out);
        let k = 0;
        for (const rig of rigs) {
          const length = rig.id === 'booster' ? L.booster : L.ship;
          v1.set(0, 1, 0).applyQuaternion(rig.sample.quat);
          copy3(rig.base, ends[k++]);
          for (let c = 0; c < 3; c++) ends[k][c] = rig.base[c] + v1.getComponent(c) * length;
          k++;
        }
        fitPoints(out, ends, 0.8, 0.74, band, width / Math.max(1, height), 0.12, 30);
        return true;
      }
      case 'buoy': {
        const track = shot.vehicle === 'booster' ? current?.booster : current?.ship;
        if (!track) return false;
        const i = track.n - 1;
        const r = Math.hypot(track.pos[i * 3], track.pos[i * 3 + 1], track.pos[i * 3 + 2]);
        site[0] = (track.pos[i * 3] / r) * EARTH_RADIUS;
        site[1] = (track.pos[i * 3 + 1] / r) * EARTH_RADIUS;
        site[2] = (track.pos[i * 3 + 2] / r) * EARTH_RADIUS;
        offsetEnu(site, 420, -300, 4, site);
        trackerPose(site, f, 0.78 * band, 1.5, 55, out);
        return inSight(shot.vehicle, f);
      }
      case 'booster-top': {
        if (!booster.visible) return false;
        // Off the hull between two grid fins, a couple of metres below the interstage: looking up at it and, through
        // its vents, at the ship's engines. At hot staging the vents blaze round the frame, then the ship's aft end
        // lifts away above the interstage.
        LOCAL.set(0, L.booster - BOOSTER_TOP_DROP[generation ?? 'v3'], 7.2).applyAxisAngle(AXIS_Y, boosterMount);
        DIR.set(0, 1, -0.5).normalize().applyAxisAngle(AXIS_Y, boosterMount);
        UP.set(0, 0, 1).applyAxisAngle(AXIS_Y, boosterMount);
        onboardPose(booster.base, booster.sample.quat, LOCAL, DIR, UP, 68, out);
        return true;
      }
      case 'booster-aft': {
        if (!booster.visible) return false;
        // Below the grid fins on the same side, looking down the hull at the engines.
        LOCAL.set(0, L.booster - 10, 5.1).applyAxisAngle(AXIS_Y, boosterMount);
        DIR.set(0, -1, 0.16).normalize().applyAxisAngle(AXIS_Y, boosterMount);
        UP.set(0, 0, 1).applyAxisAngle(AXIS_Y, boosterMount);
        onboardPose(booster.base, booster.sample.quat, LOCAL, DIR, UP, 74, out);
        return true;
      }
      case 'ship-aft': {
        if (!ship.visible) return false;
        // Over the aft flap, looking back along it: the hull on one side, the Earth below and space above, with
        // the exhaust at the edge of the frame rather than in the middle of it.
        LOCAL.set(4.9, 9, -0.6);
        DIR.set(0.25, -1, 0.1).normalize();
        UP.set(0, 0, -1);
        onboardPose(ship.base, ship.sample.quat, LOCAL, DIR, UP, 75, out);
        return true;
      }
      case 'ship-nose': {
        if (!ship.visible) return false;
        LOCAL.set(4.7, L.ship - 13, -1.2);
        DIR.set(0.1, -1, 0.35).normalize();
        UP.set(1, 0, 0);
        onboardPose(ship.base, ship.sample.quat, LOCAL, DIR, UP, 88, out);
        return true;
      }
      case 'payload': {
        if (!ship.visible || !doorSlot) return false;
        // On the hull a few metres aft of the payload door and to one side, looking forward past it: each satellite
        // slides out of the slot and drifts off into space above the hull.
        SIDE.crossVectors(AXIS_Y, doorSlot.out);
        LOCAL.copy(doorSlot.pos).addScaledVector(AXIS_Y, -9).addScaledVector(doorSlot.out, 1.2).addScaledVector(SIDE, 1.6);
        DIR.copy(doorSlot.pos).addScaledVector(doorSlot.out, 4).sub(LOCAL).normalize();
        UP.copy(doorSlot.out);
        onboardPose(ship.base, ship.sample.quat, LOCAL, DIR, UP, 62, out);
        return true;
      }
    }
  }

  // ------------------------------------------------------------- render
  const show = { flown: true, planned: true, coast: true };
  const tips: { booster: V3 | null; ship: V3 | null } = { booster: null, ship: null };
  /** Coast prediction: the result and time it was made for, and when (wall clock). */
  let coastFor: FlightResult | null = null;
  let coastAt = NaN;
  let coastWall = -Infinity;

  function placeSatellites(cameraEcef: V3, t: number) {
    if (!swarm) return;
    let n = 0;
    if (current && t <= current.ship.end) {
      for (const s of sats) {
        if (s.t > t) break;
        const age = t - s.t;
        if (age < s.hidden) continue;
        const x = ship.sample.pos[0] + s.offset[0] + s.drift[0] * age;
        const y = ship.sample.pos[1] + s.offset[1] + s.drift[1] * age;
        const z = ship.sample.pos[2] + s.offset[2] + s.drift[2] * age;
        satPos.set(x - cameraEcef[0], y - cameraEcef[1], z - cameraEcef[2]);
        if (satPos.lengthSq() > 4e8) continue; // farther than 20 km: not worth drawing
        satSpin.setFromAxisAngle(AXIS_Y, s.spin * Math.max(0, age - s.clear));
        satQuat.copy(s.quat).multiply(satSpin);
        swarm.setSatellite(n++, satPos, satQuat);
      }
    }
    swarm.setCount(n);
    swarm.commit();
  }

  function placeAll(cameraEcef: V3, t: number) {
    placeSatellites(cameraEcef, t);
    for (const rig of rigs) {
      const m = rig.model;
      if (!m) continue;
      m.object.visible = rig.visible;
      m.object.position.set(rig.base[0] - cameraEcef[0], rig.base[1] - cameraEcef[1], rig.base[2] - cameraEcef[2]);
      m.object.quaternion.copy(rig.sample.quat);
    }
    if (pad) {
      pad.object.position.set(padEcef[0] - cameraEcef[0], padEcef[1] - cameraEcef[1], padEcef[2] - cameraEcef[2]);
      pad.object.quaternion.copy(padQuat);
      // Far away the pad is invisible anyway; skip drawing it.
      pad.object.visible = dist3(padEcef, cameraEcef) < 250_000;
    }
    if (clouds) {
      clouds.object.position.copy(pad?.object.position ?? v1.set(0, 0, 0));
      clouds.object.quaternion.copy(padQuat);
      clouds.object.visible = pad?.object.visible ?? false;
    }
    for (const rig of rigs) {
      const track = rig.id === 'booster' ? current?.booster : current?.ship;
      if (!track) continue;
      const i = track.n - 1;
      if (rig.explosion) {
        endPos[0] = track.pos[i * 3];
        endPos[1] = track.pos[i * 3 + 1];
        endPos[2] = track.pos[i * 3 + 2];
        rig.explosion.object.position.set(endPos[0] - cameraEcef[0], endPos[1] - cameraEcef[1], endPos[2] - cameraEcef[2]);
        // Smoke rises along local up.
        enuQuaternion(endPos, rig.explosion.object.quaternion);
      }
      if (rig.splash && rig.touchdown !== null) {
        rig.splash.object.position.set(rig.base[0] - cameraEcef[0], rig.base[1] - cameraEcef[1], rig.base[2] - cameraEcef[2]);
        enuQuaternion(rig.base, rig.splash.object.quaternion);
      }
    }
    gates?.place(cameraEcef);
  }

  /**
   * Advance the vehicle models for the main view: once per frame, by the simulation time since the last update
   * (dt 0 snaps, for new models or results). With the time unchanged only the camera is new.
   */
  function updateModels(cam: THREE.Camera, t: number) {
    const fresh = modelsFresh;
    const dt = fresh ? 0 : t - modelT;
    for (const rig of rigs) {
      const m = rig.model;
      if (!m) continue;
      if (fresh || dt !== 0 || !m.setCamera) m.update(rig.visual, cam, dt);
      else m.setCamera(cam);
    }
    modelT = t;
    modelsFresh = false;
  }

  /** Another view of the same frame (split screen, picture-in-picture): camera-dependent parts only. */
  function viewModels(cam: THREE.Camera) {
    for (const rig of rigs) {
      const m = rig.model;
      if (!m) continue;
      if (m.setCamera) m.setCamera(cam);
      else m.update(rig.visual, cam, 0);
    }
  }

  /**
   * Point `cam` along a pose and bring the scene to it. The `primary` view (one per frame) advances the models and
   * sets the scene's lighting; the others only follow their own camera.
   */
  function prepareView(p: CameraPose, cam: THREE.PerspectiveCamera, vp: Viewport, t: number, primary: boolean, liftCentre = 0) {
    cam.position.set(0, 0, 0);
    cam.quaternion.copy(p.quat);
    cam.fov = p.fov;
    cam.aspect = vp.w / Math.max(1, vp.h);
    cam.near = 0.3;
    cam.far = 4e8;
    // Raise the optical centre so what the camera aims at sits above the HUD that overlays the bottom.
    if (liftCentre !== 0) cam.setViewOffset(vp.w, vp.h, 0, vp.h * liftCentre, vp.w, vp.h);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    placeAll(p.pos, t);
    if (earth) {
      earthFrame.cameraEcef = p.pos;
      earthFrame.camera = cam;
      earthFrame.time = t;
      earthFrame.utcMs = current ? current.launchUtc + t * 1000 : undefined;
      earthFrame.secondary = !primary;
      earth.update(earthFrame);
    }
    lines?.update(t, p.pos, show, tips);
    if (primary) updateModels(cam, t);
    else viewModels(cam);
  }

  const closePip = () => useReplay.getState().setPip(false);

  function drawView(cam: THREE.PerspectiveCamera, vp: Viewport) {
    renderer.setViewport(vp.x, height - vp.y - vp.h, vp.w, vp.h);
    renderer.setScissor(vp.x, height - vp.y - vp.h, vp.w, vp.h);
    renderer.setScissorTest(true);
    renderer.clear();
    renderer.render(scene, cam);
  }

  function project(p: V3, cameraEcef: V3, cam: THREE.PerspectiveCamera, vp: Viewport): boolean {
    v1.set(p[0] - cameraEcef[0], p[1] - cameraEcef[1], p[2] - cameraEcef[2]);
    v2.copy(v1).applyQuaternion(qInv.copy(cam.quaternion).invert());
    if (v2.z > -1) return false;
    v1.project(cam);
    if (v1.x < -1.05 || v1.x > 1.05 || v1.y < -1.05 || v1.y > 1.05) return false;
    pt.x = vp.x + ((v1.x + 1) / 2) * vp.w;
    pt.y = vp.y + ((1 - v1.y) / 2) * vp.h;
    return true;
  }

  /** Screen boxes of the labels placed so far in this frame (x0, y0, x1, y1 each), so that later ones keep clear. */
  const labelBoxes: number[] = [];

  /**
   * Find room for a label `w` px wide whose top left would be at (x, y): there, or a row or up to three rows lower
   * (labels of events at the same place stack into a short list), clear of the labels already placed and of the
   * page controls over the view. Returns the top, or NaN where there is no room (the label is left out).
   */
  function placeLabel(x: number, y: number, w: number, top: number, bottom: number): number {
    for (let row = 0; row < 4; row++) {
      const y0 = y + row * LABEL_ROW;
      if (y0 + LABEL_ROW > bottom) return NaN;
      if (y0 < top) continue;
      let clear = true;
      for (let i = 0; i < labelBoxes.length && clear; i += 4) {
        clear = x >= labelBoxes[i + 2] || x + w <= labelBoxes[i] || y0 >= labelBoxes[i + 3] || y0 + LABEL_ROW <= labelBoxes[i + 1];
      }
      if (clear) {
        labelBoxes.push(x, y0, x + w, y0 + LABEL_ROW);
        return y0;
      }
    }
    return NaN;
  }

  function labels(cameraEcef: V3, cam: THREE.PerspectiveCamera, vp: Viewport, t: number, settingsLabels: boolean, settingsGates: boolean, coverTop: number, coverBottom: number) {
    const flight = getFlight(flightN);
    const bottom = height - coverBottom;
    if (settingsLabels) {
      for (const rig of rigs) {
        if (!rig.visible) continue;
        if (current && rig.id === 'ship' && isStacked(current, t)) continue;
        const d = dist3(rig.center, cameraEcef);
        const L = rig.id === 'booster' ? lengths().booster : lengths().ship;
        const pixels = (L / d) * (vp.h / (2 * Math.tan((cam.fov * Math.PI) / 360)));
        if (pixels > 26) continue;
        if (hiddenByEarth(cameraEcef, rig.center)) continue;
        if (!project(rig.center, cameraEcef, cam, vp)) continue;
        const stacked = current !== null && isStacked(current, t);
        const name = stacked ? 'Starship' : rig.id === 'booster' ? 'Super Heavy' : 'Starship';
        const id = stacked ? '' : rig.id === 'booster' ? flight.boosterId : flight.shipId;
        // The dot sits on the vehicle.
        const x = Math.round(pt.x - 3);
        const y = placeLabel(x, Math.round(pt.y - 7), labelWidth(name, id, 'vehicle'), coverTop, bottom);
        if (Number.isNaN(y)) continue;
        overlay.label(rig.id === 'booster' ? 'veh:booster' : 'veh:ship', x, y, name, id, rig.id === 'booster' && !stacked ? '#ff7a66' : '#7ab4ff', 'vehicle');
      }
    }
    if (settingsGates && gates?.mesh.visible) {
      // Major events first: where several share a spot, they are the ones that keep their label.
      for (let pass = 0; pass < 2; pass++) {
        for (const g of gates.items) {
          if (g.event.major !== (pass === 0)) continue;
          if (hiddenByEarth(cameraEcef, g.pos)) continue;
          if (!project(g.pos, cameraEcef, cam, vp)) continue;
          let l = gateLabels.get(g);
          if (!l) {
            const m = Math.round(Math.abs(g.event.t));
            const time = m >= 3600 ? `T+${Math.floor(m / 3600)}:${String(Math.floor((m % 3600) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` : `T+${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
            l = {
              id: `gate:${g.event.key}:${g.event.t}`,
              time,
              color: g.event.vehicle === 'booster' ? '#ff8a78' : g.event.vehicle === 'ship' ? '#8cc0ff' : '#ffffff',
              width: labelWidth(g.event.short, time, 'gate'),
            };
            gateLabels.set(g, l);
          }
          const x = Math.round(pt.x + 10);
          const y = placeLabel(x, Math.round(pt.y - 7), l.width, coverTop, bottom);
          if (Number.isNaN(y)) continue;
          overlay.label(l.id, x, y, g.event.short, l.time, l.color, 'gate');
        }
      }
    }
  }

  /**
   * Engines-off coast prediction for both vehicles. During playback it is refreshed ten times a second (at high
   * rates that is many simulated seconds apart, never every frame); otherwise whenever t changes, so a paused view
   * always shows the prediction for exactly that moment.
   */
  function updateCoast(result: FlightResult, t: number, playing: boolean, now: number) {
    if (!show.coast) {
      // Hidden by the lines themselves; shown again (and recomputed) when switched back on.
      coastFor = null;
      return;
    }
    if (coastFor === result && (t === coastAt || (playing && now - coastWall < COAST_REFRESH_MS && Math.abs(t - coastAt) < 30))) return;
    coastFor = result;
    coastAt = t;
    coastWall = now;
    for (const rig of rigs) {
      const track = rig.id === 'booster' ? result.booster : result.ship;
      // Not once the vehicle is landing: an engines-off path would only mark the water under its landing burn.
      const phase = rig.sample.phase;
      const landing = phase === Phase.LandingBurn || phase === Phase.ShipFlip || phase === Phase.Caught || phase === Phase.Splashed;
      const alive = t > 1 && t < track.end && rig.sample.alt > 50 && !landing && !(rig.id === 'ship' && isStacked(result, t));
      lines?.setCoast(rig.id, alive ? predictCoast(rig.sample.pos, rig.sample.vel, COAST_SECONDS, rig.coast) : null);
    }
  }

  /** 0..1: how much a lit plume fills the main view, so the eye adaptation can meter for it at night. */
  function plumeInView(p: CameraPose): number {
    const k = 1 / (2 * Math.tan((p.fov * Math.PI) / 360));
    const L = lengths();
    let w = 0;
    for (const rig of rigs) {
      if (!rig.visible) continue;
      const lit = litEngines(rig);
      if (lit === 0) continue;
      // Measured at the engines: the plume starts there, and onboard cameras look at it from a few metres.
      const cover = ((rig.id === 'booster' ? L.booster : L.ship) / Math.max(1, dist3(rig.base, p.pos))) * k;
      w = Math.max(w, smoothstep(0.03, 0.2, cover) * Math.min(1, lit / 3));
    }
    return w;
  }

  /**
   * 0..1: how close the main view is to the hot-staging vents while they blaze (the ship's engines firing into the
   * interstage): from the booster's own cameras they outshine the daylight, so the eye adaptation stops down.
   */
  function ventsInView(p: CameraPose): number {
    if (!booster.visible || booster.visual.hotStage === 0) return 0;
    v1.set(0, 1, 0).applyQuaternion(booster.sample.quat);
    const L = lengths().booster;
    const d = Math.hypot(booster.base[0] + v1.x * L - p.pos[0], booster.base[1] + v1.y * L - p.pos[1], booster.base[2] + v1.z * L - p.pos[2]);
    return 1 - smoothstep(25, 90, d);
  }

  /** Nothing to show for the current flight yet (loading, or building it): black, without stale labels or frames. */
  function blank() {
    if (shown === null) return;
    renderer.setScissorTest(false);
    renderer.clear();
    overlay.clear();
    shown = null;
  }

  function render(t: number, dt: number) {
    if (disposed || lost || !host) return;
    const st = useReplay.getState();
    try {
      frame(st, t, dt);
    } catch (err) {
      fail(err, st);
    }
  }

  function fail(error: unknown, st: ReplayState) {
    failure = { error, result: st.result, baseline: st.baseline, quality };
    warming = false;
    warmQueued = false;
    announced = false;
    shown = null;
    console.error('3D view:', error);
    const reason = error instanceof Error ? error.message : String(error);
    callbacks?.onError(new Error(`The 3D view failed: ${reason}`, { cause: error }));
  }

  function frame(st: ReplayState, t: number, dt: number) {
    const now = performance.now();
    const result = st.result;
    const q: Quality = st.settings.quality === 'low' ? 'low' : 'high';
    if (failure) {
      if (failure.result === result && failure.baseline === st.baseline && failure.quality === q) return;
      failure = null;
    }
    if ((window.devicePixelRatio || 1) !== dprSeen) applySize();
    if (q !== quality) setQuality(q);

    // Build what the flight needs (it may still be loading: its pad and vehicles are known already).
    const want = getFlight(result?.flight ?? st.flight);
    if (!built(want)) {
      const start = performance.now();
      while (buildStep(want) && performance.now() - start < BUILD_BUDGET_MS);
      blank();
      return;
    }
    if (!result) {
      blank();
      return;
    }
    if (result !== environmentResult || st.scenario !== environmentScenario) {
      const matchedWind = resultWindPeak(result.scenarioKey, st.scenario, st.scenarioPast, st.scenarioFuture);
      // Retain a known wind while a replacement run loads. A new result with no matching snapshot
      // falls back to calm air rather than borrowing wind from an unrelated, possibly pending run.
      windPeak = matchedWind ?? (result === environmentResult ? windPeak : 0);
      environmentResult = result;
      environmentScenario = st.scenario;
    }
    if (result !== current || st.baseline !== currentBaseline) {
      if (rebuild(result, st.baseline)) warm();
    }
    if (st.settings !== seen.settings || st.camera !== seen.camera || st.follow !== seen.follow || st.webcastShot !== seen.shot || st.pip !== seen.pip) {
      seen.settings = st.settings;
      seen.camera = st.camera;
      seen.follow = st.follow;
      seen.shot = st.webcastShot;
      seen.pip = st.pip;
      updateTouchAction(st.camera);
      dirty = true;
    }
    show.flown = st.settings.showFlown;
    show.planned = st.settings.showPlanned;
    show.coast = st.settings.showCoast;

    sunDirectionEcef(result.launchUtc + t * 1000, sunDir);
    updateRig(booster, result, t);
    updateRig(ship, result, t);
    const L = lengths();
    const stacked = isStacked(result, t);
    setFocus(focusB, booster, result.booster, t, framedLength(booster, result.booster, t, L.booster));
    setFocus(focusS, ship, result.ship, t, framedLength(ship, result.ship, t, L.ship));
    // The stack's middle is the top of the booster.
    const stackLength = L.booster + L.ship;
    v1.set(0, 1, 0).applyQuaternion(booster.sample.quat);
    focusStack.pos[0] = booster.base[0] + v1.x * stackLength * 0.5;
    focusStack.pos[1] = booster.base[1] + v1.y * stackLength * 0.5;
    focusStack.pos[2] = booster.base[2] + v1.z * stackLength * 0.5;
    copy3(focusB.course, focusStack.course);
    focusStack.size = framedLength(booster, result.booster, t, stackLength);
    // The pad camera frames the stack from the ground under it to its nose until it is well clear of the mount.
    const clear = smoothstep(150, 600, dist3(booster.base, padEcef));
    let padSize = 0;
    for (let k = 0; k < 3; k++) {
      const nose = booster.base[k] + v1.getComponent(k) * stackLength;
      const foot = padEcef[k] + (booster.base[k] - padEcef[k]) * clear;
      focusPad.pos[k] = (nose + foot) / 2;
      padSize += (nose - foot) * (nose - foot);
    }
    focusPad.size = Math.sqrt(padSize);
    copy3(focusB.course, focusPad.course);
    const apart = dist3(booster.center, ship.center);
    focusBoth.pos[0] = (booster.center[0] + ship.center[0]) / 2;
    focusBoth.pos[1] = (booster.center[1] + ship.center[1]) / 2;
    focusBoth.pos[2] = (booster.center[2] + ship.center[2]) / 2;
    copy3(focusS.course, focusBoth.course);
    // The two start half a stack apart, centre to centre: the frame grows from the stack's as they draw apart.
    focusBoth.size = Math.max(stackLength, apart + stackLength / 2);

    // ---- choose the views
    const follow = st.follow;
    const sep = !stacked;
    const mainFocus = !sep ? focusStack : follow === 'ship' ? focusS : follow === 'booster' ? focusB : apart < 3000 ? focusBoth : focusS;
    // Both vehicles, far apart: the chase and free cameras split the view, the booster on the left and the ship
    // (the main camera) on the right.
    splitReady = sep && follow === 'both' && apart >= 3000 && booster.visible && ship.visible;
    const split = splitReady && (st.camera === 'chase' || st.camera === 'free');

    // The part of the frame page controls leave free (the camera bar over the top, the HUD over the bottom on wide
    // screens): what a camera aims at sits in its middle, and shots that zoom fit their subject into it.
    const coverTop = Math.min(insets.top, height * 0.4);
    const coverBottom = Math.min(insets.bottom, height * 0.5);
    const band = Math.max(0.3, (height - coverTop - coverBottom) / Math.max(1, height));
    const lift = (coverBottom - coverTop) / (2 * Math.max(1, height));
    const reach = CHASE_BAND / band;

    let key: string = st.camera;
    let followed: Focus | null = mainFocus;
    if (st.camera === 'globe') {
      if (viewKey !== 'globe') globe.enter();
      globe.centreOn(mainFocus.pos);
      globe.pose(target);
      followed = null;
    } else if (st.camera === 'free') {
      free.pose(mainFocus, target);
    } else if (st.camera === 'chase') {
      chase.pose(mainFocus, target, reach);
      key += follow;
    } else {
      const auto = plan ? autoShot(t, plan, follow) : PAD_SHOT;
      let shot: Shot = plan && st.webcastShot !== 'auto' ? pickedShot(st.webcastShot as ShotId, t, plan, follow) : auto;
      followed = shotFocus(shot, t);
      if (!shotPose(shot, t, followed, band, target)) {
        // A camera the viewer picked that can't show its vehicle (a ground camera that has lost it below the
        // horizon) gives way to the director's. Otherwise the chase plane takes over: it frames what is left of a
        // vehicle that has broken up from outside its debris.
        if (shot !== auto && shotPose(auto, t, shotFocus(auto, t), band, target)) {
          shot = auto;
          followed = shotFocus(shot, t);
        } else aerialPose(followed, band, target);
      }
      key += `${shot.id}:${shot.vehicle}`;
      if (st.settings.reduceMotion === false && (shot.id === 'pad' || shot.id === 'tower') && t > -1 && t < 14) {
        // Ground shake from the engines near liftoff.
        const amp = 0.0016 * Math.max(0, 1 - Math.abs(t - 3) / 11);
        shakeEuler.set(Math.sin(t * 61) * amp, Math.sin(t * 47 + 1) * amp, 0);
        target.quat.multiply(shakeQuat.setFromEuler(shakeEuler));
      }
      lastShot = shot;
    }

    // Smooth transitions between camera modes; webcast cuts are instant like the broadcast, and so is a change to a
    // view far away (another vehicle, half a world away), which a straight blend would cut through the Earth to reach.
    if (key !== viewKey) {
      const isCut = key.startsWith('webcast') && viewKey.startsWith('webcast');
      const toGlobe = key === 'globe' || viewKey === 'globe';
      const near = dist3(lastPose.pos, target.pos) < BLEND_REACH && segmentAltitude(lastPose.pos, target.pos) > 1;
      if (viewKey && !isCut && !st.settings.reduceMotion && (toGlobe || near)) {
        copyPose(lastPose, fromPose);
        // The view being left keeps moving with what it followed, so a blend never falls behind a fast vehicle.
        fromFocus = viewFocus;
        copy3(viewFocusAt, fromAnchor);
        blendGlobe = toGlobe;
        blendT = 0;
        blendDur = blendGlobe ? 1.6 : 0.9;
      } else blendT = 1;
      viewKey = key;
    }
    if (blendT < 1) {
      blendT = Math.min(1, blendT + dt / blendDur);
      copyPose(fromPose, fromNow);
      if (fromFocus) for (let k = 0; k < 3; k++) fromNow.pos[k] += fromFocus.pos[k] - fromAnchor[k];
      if (blendGlobe) blendAround(fromNow, target, blendT, pose);
      else blendPose(fromNow, target, blendT, pose);
    } else copyPose(target, pose);
    copyPose(pose, lastPose);
    viewFocus = followed;
    if (followed) copy3(followed.pos, viewFocusAt);

    const half = Math.floor(width / 2);
    if (split) {
      if (st.camera === 'free') freeLeft.pose(focusB, leftPose);
      else chaseLeft.pose(focusB, leftPose, reach);
    }

    // Small frame: the other vehicle (or the followed one when the main view is the globe).
    const pipTarget: Rig | null = !st.pip || split
      ? null
      : st.camera === 'globe'
        ? sep ? (follow === 'booster' ? booster : ship) : booster
        : sep && follow === 'booster'
          ? ship
          : sep && follow === 'ship'
            ? booster
            : sep && follow === 'both' && st.camera === 'webcast' && lastShot
              ? lastShot.vehicle === 'booster' ? ship : booster
              : null;
    const pip = pipTarget && pipTarget.visible && width > 520 ? pipTarget : null;
    const pipFocus = st.camera === 'globe' && !sep ? focusStack : pip?.id === 'booster' ? focusB : focusS;
    if (pip) chasePip.pose(pipFocus, pipPose);

    // A jump in time (a seek, or starting over) is not a cut: the view arrives adapted to its light, so a paused
    // view is drawn as it settles straight away instead of brightening or darkening for seconds.
    const playedOn = st.playing && t >= frameT && t - frameT <= dt * Math.max(st.rate, COAST_RATE) + 0.5;
    if (t !== frameT && !playedOn) adaptedUntil = now + ADAPTED_MS;
    frameT = t;

    // Eye adaptation: brighten towards the Earth's suggestion in twilight and at night, but meter for a lit plume
    // that fills the view (the brightest thing in it), so night launches and landings don't blow out.
    let adapting = false;
    if (earth) {
      const metered = Math.min(4, Math.max(1, earth.exposureHint));
      const goal = (metered + (Math.min(metered, PLUME_EXPOSURE) - metered) * plumeInView(pose)) * (1 - VENT_STOP * ventsInView(pose));
      exposure = now < adaptedUntil ? goal : exposure + (goal - exposure) * damp(1, dt);
      // The last percent is invisible; settling there lets a paused view stop redrawing.
      if (Math.abs(goal - exposure) < 0.01 * goal) exposure = goal;
      adapting = exposure !== renderer.toneMappingExposure;
      renderer.toneMappingExposure = exposure;
    }

    tips.booster = booster.sample.alive ? booster.sample.pos : null;
    tips.ship = ship.sample.alive ? ship.sample.pos : null;

    // ---- shader warm-up: prepare this frame without drawing it, compile everything, draw once that's done
    if (warmQueued) {
      warmQueued = false;
      updateScene(st, result, t, now);
      prepareView(pose, camera, { x: 0, y: 0, w: split ? half : width, h: height }, t, true, lift);
      compileScene(camera);
      return;
    }
    if (warming) {
      if (shown !== result) blank();
      return;
    }

    // ---- draw only when something visible changed (paused views cost nothing)
    const mem = renderer.info.memory;
    const changed =
      dirty ||
      shown !== result ||
      t !== drawnT ||
      adapting ||
      split !== drawnLayout.split ||
      (pip?.id ?? '') !== drawnLayout.pip ||
      width !== drawnLayout.w ||
      height !== drawnLayout.h ||
      mem.textures !== seen.textures ||
      mem.geometries !== seen.geometries ||
      !samePose(pose, drawnPose, height, dist3(pose.pos, mainFocus.pos)) ||
      (split && !samePose(leftPose, drawnLeft, height, dist3(leftPose.pos, focusB.pos))) ||
      (pip !== null && !samePose(pipPose, drawnPip, PIP_HEIGHT, dist3(pipPose.pos, pipFocus.pos)));
    if (changed) changedAt = now;
    // Until the imagery is in the outline covers the view: draw only what warms it up, not every frame.
    if (!earthReady && shown === result && !dirty) return;
    if (!changed && now - changedAt >= SETTLE_MS && now - drawnAt < KEEPALIVE_MS) return;

    // ---- draw
    updateScene(st, result, t, now);
    governor.begin();
    renderer.setScissorTest(false);
    renderer.clear();
    overlay.begin();
    labelBoxes.length = 0;
    if (split) {
      const left: Viewport = { x: 0, y: 0, w: half, h: height };
      const right: Viewport = { x: half, y: 0, w: width - half, h: height };
      prepareView(leftPose, camera, left, t, true, lift);
      drawView(camera, left);
      labels(leftPose.pos, camera, left, t, st.settings.showLabels, false, coverTop, coverBottom);
      prepareView(pose, sideCamera, right, t, false, lift);
      drawView(sideCamera, right);
      labels(pose.pos, sideCamera, right, t, st.settings.showLabels, false, coverTop, coverBottom);
      // Titles and the divider keep to the part of the view that page controls leave free.
      overlay.title('split-left', 9, coverTop + 7, titles.booster);
      overlay.title('split-right', half + 9, coverTop + 7, titles.ship);
      overlay.divider('split', half, coverTop, height - coverTop - coverBottom);
    } else {
      const full: Viewport = { x: 0, y: 0, w: width, h: height };
      prepareView(pose, camera, full, t, true, lift);
      drawView(camera, full);
      labels(pose.pos, camera, full, t, st.settings.showLabels, st.settings.showGates && st.camera === 'globe', coverTop, coverBottom);
    }
    const pipW = Math.round(Math.min(PIP_WIDTH, width * 0.28));
    const pipVp: Viewport = { x: width - pipW - 16, y: Math.max(12, coverTop + 8), w: pipW, h: Math.round(pipW * PIP_ASPECT) };
    if (pip) {
      prepareView(pipPose, sideCamera, pipVp, t, false);
      drawView(sideCamera, pipVp);
      overlay.frame('pip', pipVp.x, pipVp.y, pipVp.w, pipVp.h, !sep ? titles.stack : pip.id === 'booster' ? titles.booster : titles.ship, closePip);
    }
    shownViews.split = split;
    shownViews.half = half;
    shownViews.pip = pip !== null;
    shownViews.pipX = pipVp.x;
    shownViews.pipY = pipVp.y;
    shownViews.pipW = pipVp.w;
    shownViews.pipH = pipVp.h;
    overlay.end();
    if (governor.end(now, st.playing)) applySize();

    shown = result;
    dirty = false;
    drawnT = t;
    drawnAt = now;
    copyPose(pose, drawnPose);
    copyPose(leftPose, drawnLeft);
    copyPose(pipPose, drawnPip);
    drawnLayout.split = split;
    drawnLayout.pip = pip?.id ?? '';
    drawnLayout.w = width;
    drawnLayout.h = height;
    seen.textures = mem.textures;
    seen.geometries = mem.geometries;

    if (!announced && earthReady) {
      announced = true;
      callbacks?.onReady();
    }
  }

  /** Pad, effects, lines and satellites: everything that depends on t but not on the view. */
  function updateScene(st: ReplayState, result: FlightResult, t: number, now: number) {
    const L = lengths();
    if (pad) {
      const s = PADS[padId ?? 'pad1'];
      const holding = catchTime !== null && t >= catchTime;
      const approaching = catchTime !== null && t >= catchTime - 30 && t < catchTime;
      const catchHeight = catchArmsHeight ?? s.catchBaseHeight + L.booster - 8;
      pad.update(
        {
          t,
          armsHeight: holding || approaching ? catchHeight : s.tower.height * 0.62,
          armsOpen: holding ? 0 : 1,
          deluge: t > -4 && t < 20 ? 1 - Math.max(0, t - 8) / 12 : 0,
        },
        t - padT,
      );
      padT = t;
    }
    if (clouds) {
      const near = booster.sample.alt < 2500 && t < 60;
      let lit = 0;
      for (let i = 0; i < booster.engines.length; i++) if (booster.engines[i] === 1) lit++;
      clouds.update(t, near ? (lit / Math.max(1, booster.engines.length)) * Math.max(0.2, booster.sample.throttle) : 0, camera);
    }
    for (const rig of rigs) {
      const track = rig.id === 'booster' ? result.booster : result.ship;
      rig.explosion?.setAge(breaksUp(track) ? t - track.end : -1);
      if (rig.splash) {
        rig.splash.setAge(rig.touchdown !== null ? t - rig.touchdown : -1, SPLASH_SCALE[rig.id]);
        // A landing burn lights the water under the vehicle, which is what shows at night: the height of its base
        // above the sea, and its thrust in full-throttle engines.
        const height = Math.hypot(rig.base[0], rig.base[1], rig.base[2]) - EARTH_RADIUS;
        rig.splash.setApproach?.(height, rig.visible ? litEngines(rig) * rig.visual.throttle : 0);
      }
    }
    (ship.model as ShipModel | null)?.setPayloadDoor(doorAt(t));
    updateCoast(result, t, st.playing, now);
    if (gates) gates.mesh.visible = st.settings.showGates && st.camera === 'globe';
  }

  function setQuality(q: Quality) {
    quality = q;
    // Built models keep their textures; models built from now on use this quality's.
    prefetchPixels(q);
    governor.restart();
    applySize();
    earth?.setQuality(q);
    for (const m of boosterModels.values()) m.setQuality(q);
    for (const m of shipModels.values()) m.setQuality(q);
    for (const m of padModels.values()) m.setQuality(q);
    if (clouds) {
      // The particle budget is fixed at creation; the new set is built before the old one is let go, so their
      // shared textures stay alive.
      const old = clouds;
      clouds = createLaunchClouds(q);
      if (old.object.parent) {
        scene.remove(old.object);
        scene.add(clouds.object);
      }
      old.dispose();
    }
    modelsFresh = true;
    dirty = true;
    if (current) warm();
  }

  /** Let go of everything built (dispose, or a lost context); the next frames build it again. */
  function teardown() {
    warmToken++;
    warming = false;
    warmQueued = false;
    for (const rig of rigs) {
      rig.explosion?.dispose();
      rig.splash?.dispose();
      rig.explosion = null;
      rig.splash = null;
      rig.model = null;
    }
    for (const m of boosterModels.values()) m.dispose();
    for (const m of shipModels.values()) m.dispose();
    for (const m of padModels.values()) m.dispose();
    boosterModels.clear();
    shipModels.clear();
    padModels.clear();
    pad = null;
    padId = null;
    generation = null;
    clouds?.dispose();
    clouds = null;
    for (const w of swarms.values()) w.dispose();
    swarms.clear();
    swarm = null;
    lines?.dispose();
    lines = null;
    gates?.dispose();
    gates = null;
    earth?.dispose();
    earth = null;
    earthReady = false;
    scene.clear();
    overlay.clear();
    overlay.clearGates();
    current = null;
    currentBaseline = null;
    shown = null;
    sats = [];
    door = null;
    dirty = true;
  }

  function attach(el: HTMLElement, cb: StageCallbacks) {
    if (disposed) return;
    host = el;
    callbacks = cb;
    if (canvas.parentElement !== el) el.appendChild(canvas);
    overlay.mount(el);
    announced = false;
    failure = null;
    dirty = true;
    applySize();
    if (lost) cb.onError(new Error('The 3D view lost its graphics context'));
  }

  function detach(el: HTMLElement) {
    if (host !== el) return;
    host = null;
    callbacks = null;
    canvas.remove();
    overlay.root.remove();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    host = null;
    callbacks = null;
    ro.disconnect();
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', onDblClick);
    canvas.removeEventListener('contextmenu', onContext);
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    teardown();
    governor.dispose();
    overlay.dispose();
    renderer.dispose();
    // Give the GPU memory back now rather than whenever the canvas is collected.
    renderer.forceContextLoss();
    canvas.remove();
  }

  return {
    canvas,
    attach,
    detach,
    render,
    setInsets(top: number, bottom: number) {
      if (top === insets.top && bottom === insets.bottom) return;
      insets.top = top;
      insets.bottom = bottom;
      dirty = true;
    },
    resetCamera() {
      free.reset();
      freeLeft.reset();
      globe.reset();
      chase.reset();
      chaseLeft.reset();
      chasePip.reset();
      dirty = true;
    },
    dispose,
  };
}
