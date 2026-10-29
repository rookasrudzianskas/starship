import * as THREE from 'three';
import { getFlight, PADS } from '@/lib/flights/catalog';
import { ENGINE_OFF, Phase, type FlightResult, type Generation, type PadId, type Track, type VehicleId } from '@/lib/sim/types';
import { useReplay } from '@/lib/store/replay';
import { ambientPressureApprox, engineStates, isStacked } from '@/lib/telemetry';
import { createEarth, sunDirectionEcef, type EarthHandle } from '@/lib/three/earth';
import { createExplosion, createLaunchClouds, createSplash, createStarlinkSwarm } from '@/lib/three/effects';
import { createPad } from '@/lib/three/pad';
import { createBooster, createShip } from '@/lib/three/vehicles';
import type { Explosion, LaunchClouds, PadModel, Quality, ShipModel, Splash, StarlinkSwarm, VehicleModel, VehicleVisualState } from '@/lib/three/contracts';
import { blendPose, ChaseCamera, copyPose, createPose, FreeCamera, GlobeCamera, onboardPose, trackerPose, type CameraPose, type DragInput, type Focus } from './cameras';
import { autoShot, pickedShot, planDirector, type DirectorPlan, type Shot, type ShotId } from './director';
import { copy3, damp, dist3, enuQuaternion, latLonToEcef, offsetEnu, type V3 } from './geo';
import { Overlay } from './overlay';
import { createGates, disposeGates, predictCoast, TrajectoryLines, type Gate } from './paths';
import { createSample, firstPhaseTime, sampleTrack, type StageSample } from './sample';

export interface StageOptions {
  onReady(): void;
  onError(error: unknown): void;
}

export interface StageHandle {
  render(t: number, dt: number): void;
  resetCamera(): void;
  dispose(): void;
}

interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
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
  explosion: Explosion | null;
  splash: Splash | null;
  touchdown: number | null;
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
    explosion: null,
    splash: null,
    touchdown: null,
  };
}

const LENGTH: Record<Generation, { booster: number; ship: number }> = {
  b1: { booster: 71, ship: 50.3 },
  b2: { booster: 71, ship: 52.1 },
  v3: { booster: 72.3, ship: 52.1 },
};

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const qInv = new THREE.Quaternion();

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

export function createStage(canvas: HTMLCanvasElement, options: StageOptions): StageHandle {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    logarithmicDepthBuffer: true,
    powerPreference: 'high-performance',
    alpha: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.3, 4e8);
  const sideCamera = new THREE.PerspectiveCamera(40, 1, 0.3, 4e8);

  const parent = canvas.parentElement ?? document.body;
  const overlay = new Overlay(parent);

  let quality: Quality = useReplay.getState().settings.quality === 'low' ? 'low' : 'high';
  let width = 1;
  let height = 1;

  const applySize = () => {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, quality === 'high' ? 2 : 1);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
  };
  applySize();
  const ro = new ResizeObserver(applySize);
  ro.observe(canvas);

  // ------------------------------------------------------------ scene graph
  let earth: EarthHandle | null = null;
  let exposure = 1;
  let earthPad: PadId | null = null;
  let earthReady = false;
  let pad: PadModel | null = null;
  let padId: PadId | null = null;
  let padEcef: V3 = [0, 0, 0];
  const padQuat = new THREE.Quaternion();
  let clouds: LaunchClouds | null = null;
  let swarm: StarlinkSwarm | null = null;
  let swarmKind: 'starlink-sim' | 'starlink-v3' | null = null;
  let generation: Generation | null = null;
  const booster = makeRig('booster');
  const ship = makeRig('ship');
  let lines: TrajectoryLines | null = null;
  let gates: Gate[] = [];
  let plan: DirectorPlan | null = null;
  let current: FlightResult | null = null;
  let currentBaseline: FlightResult | null = null;
  let catchTime: number | null = null;
  let sats: { t: number; index: number; offset: V3; drift: V3 }[] = [];
  let flightN = 0;
  let readyFired = false;
  let disposed = false;

  const sunDir = new THREE.Vector3(1, 0, 0);

  function ensureEarth(p: PadId) {
    if (earth && earthPad === p) return;
    if (earth) {
      scene.remove(earth.object, earth.sunLight);
      earth.dispose();
    }
    earth = createEarth({ renderer, scene, quality, pad: p });
    earthPad = p;
    earthReady = false;
    // The sun light carries its own target as a child. Sky light comes from scene.environment (set by the
    // Earth), so the hemisphere light is left out to avoid lighting PBR materials twice.
    scene.add(earth.object, earth.sunLight);
    earth.ready.then(() => {
      earthReady = true;
    }, options.onError);
  }

  function ensureVehicles(gen: Generation) {
    if (generation === gen && booster.model && ship.model) return;
    for (const rig of [booster, ship]) {
      if (rig.model) {
        scene.remove(rig.model.object);
        rig.model.dispose();
      }
    }
    booster.model = createBooster(gen, quality);
    ship.model = createShip(gen, quality);
    scene.add(booster.model.object, ship.model.object);
    generation = gen;
  }

  function ensurePad(p: PadId) {
    if (pad && padId === p) return;
    if (pad) {
      scene.remove(pad.object);
      pad.dispose();
    }
    if (clouds) {
      scene.remove(clouds.object);
      clouds.dispose();
    }
    pad = createPad(p, quality);
    clouds = createLaunchClouds(quality);
    padId = p;
    const site = PADS[p];
    padEcef = latLonToEcef(site.lat, site.lon, site.groundAlt);
    enuQuaternion(padEcef, padQuat);
    scene.add(pad.object, clouds.object);
  }

  function rebuild(result: FlightResult, baseline: FlightResult | null) {
    const flight = getFlight(result.flight);
    const newFlight = flightN !== result.flight;
    flightN = result.flight;
    ensureEarth(flight.pad);
    ensurePad(flight.pad);
    ensureVehicles(flight.generation);
    booster.model?.object.userData.setHotStageRing?.(flight.n !== 1);

    if (!lines) {
      lines = new TrajectoryLines(padEcef);
      scene.add(lines.group);
    }
    lines.setResult(result, baseline);

    for (const g of gates) scene.remove(g.mesh);
    disposeGates(gates);
    overlay.clearGates();
    gates = createGates(result);
    for (const g of gates) scene.add(g.mesh);

    plan = planDirector(result);
    catchTime = result.booster.endKind === 'catch' ? firstPhaseTime(result.booster, Phase.Caught) ?? result.booster.end : null;

    for (const rig of [booster, ship]) {
      const track = rig.id === 'booster' ? result.booster : result.ship;
      rig.engines = new Uint8Array((rig.id === 'booster' ? result.boosterEngines : result.shipEngines).slots.length);
      rig.visual.engines = new Uint8Array(rig.engines.length);
      const ends = track.endKind === 'lost' || track.endKind === 'termination' || track.endKind === 'impact';
      if (ends) {
        if (!rig.explosion) {
          rig.explosion = createExplosion();
          scene.add(rig.explosion.object);
        }
        const alt = track.alt[track.n - 1];
        rig.explosion.trigger(rig.id === 'booster' ? 70 : 50, Math.exp(-Math.max(0, alt) / 8500));
      }
      rig.touchdown = firstPhaseTime(track, Phase.Splashed);
      if (rig.touchdown !== null && !rig.splash) {
        rig.splash = createSplash();
        scene.add(rig.splash.object);
      }
    }

    const kind = flight.plan.ship.payloadKind === 'none' ? 'starlink-v3' : flight.plan.ship.payloadKind;
    if (result.payload.length > 0 && (!swarm || swarmKind !== kind)) {
      if (swarm) {
        scene.remove(swarm.object);
        swarm.dispose();
      }
      swarm = createStarlinkSwarm(48, kind);
      swarmKind = kind;
      scene.add(swarm.object);
    }
    // Each satellite drifts away from the ship at its small separation velocity.
    const probe = createSample();
    sats = result.payload.slice(0, 48).map((p) => {
      sampleTrack(result.ship, p.t, probe);
      return {
        t: p.t,
        index: p.index,
        offset: [p.pos[0] - probe.pos[0], p.pos[1] - probe.pos[1], p.pos[2] - probe.pos[2]] as V3,
        drift: [p.vel[0] - probe.vel[0], p.vel[1] - probe.vel[1], p.vel[2] - probe.vel[2]] as V3,
      };
    });
    if (newFlight) {
      globe.reset();
      free.reset();
    }
    current = result;
    currentBaseline = baseline;
  }

  // ------------------------------------------------------------- cameras
  const chase = new ChaseCamera();
  const chasePip = new ChaseCamera();
  const chaseLeft = new ChaseCamera();
  const chaseRight = new ChaseCamera();
  const free = new FreeCamera();
  const globe = new GlobeCamera();
  const pose = createPose();
  const pipPose = createPose();
  const leftPose = createPose();
  const rightPose = createPose();
  const lastPose = createPose();
  const fromPose = createPose();
  const target = createPose();
  let blendT = 1;
  let blendDur = 1;
  let viewKey = '';
  let lastShot: Shot | null = null;

  // Pointer input drives the free, chase and globe cameras.
  let drag: { x: number; y: number; button: number; id: number } | null = null;
  const onPointerDown = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY, button: e.button, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag || drag.id !== e.pointerId) return;
    const d: DragInput = { dx: e.clientX - drag.x, dy: e.clientY - drag.y, button: drag.button };
    drag.x = e.clientX;
    drag.y = e.clientY;
    const st = useReplay.getState();
    const size = focusSize(st.follow);
    if (st.camera === 'globe') globe.drag(d);
    else if (st.camera === 'free') free.drag(d, size);
    else if (st.camera === 'chase') chase.drag(d);
    else {
      // Dragging the webcast hands over to the free camera, starting from where the view is.
      st.setCamera('free');
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    if (drag?.id === e.pointerId) drag = null;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const st = useReplay.getState();
    const size = focusSize(st.follow);
    if (st.camera === 'globe') globe.wheel(e.deltaY);
    else if (st.camera === 'free') free.wheel(e.deltaY, size);
    else if (st.camera === 'chase') chase.wheel(e.deltaY);
  };
  const onDblClick = () => {
    const st = useReplay.getState();
    if (st.camera === 'free') free.recentre();
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

  const onLost = (e: Event) => {
    e.preventDefault();
    options.onError(new Error('The 3D view lost its graphics context'));
  };
  canvas.addEventListener('webglcontextlost', onLost);

  function lengths(): { booster: number; ship: number } {
    return LENGTH[generation ?? 'v3'];
  }

  function focusSize(follow: string): number {
    const L = lengths();
    if (current && isStacked(current, useReplay.getState().t)) return L.booster + L.ship;
    return follow === 'ship' ? L.ship : L.booster;
  }

  const focusB: Focus = { pos: [0, 0, 0], vel: [0, 0, 0], quat: new THREE.Quaternion(), size: 70 };
  const focusS: Focus = { pos: [0, 0, 0], vel: [0, 0, 0], quat: new THREE.Quaternion(), size: 50 };
  const focusStack: Focus = { pos: [0, 0, 0], vel: [0, 0, 0], quat: new THREE.Quaternion(), size: 121 };
  const focusBoth: Focus = { pos: [0, 0, 0], vel: [0, 0, 0], quat: new THREE.Quaternion(), size: 121 };

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
    vis.ambientPressure = ambientPressureApprox(s.alt);
    vis.mach = s.mach;
    vis.aero = s.aero;
    vis.heating = after ? 0 : s.heating;
    qInv.copy(s.quat).invert();
    v2.set(-s.vel[0], -s.vel[1], -s.vel[2]);
    if (v2.lengthSq() > 1) vis.airflowBody.copy(v2.normalize().applyQuaternion(qInv));
    else vis.airflowBody.set(0, 1, 0);
    vis.hotStage = !after && s.phase === Phase.HotStage ? 1 : 0;
    vis.phase = s.phase;
    vis.sunBody.copy(sunDir).applyQuaternion(qInv);
  }

  function setFocus(f: Focus, rig: Rig, size: number) {
    copy3(rig.center, f.pos);
    copy3(rig.sample.vel, f.vel);
    f.quat.copy(rig.sample.quat);
    f.size = size;
  }

  // ------------------------------------------------------------- shots
  const LOCAL = new THREE.Vector3();
  const DIR = new THREE.Vector3();
  const UP = new THREE.Vector3();

  function shotPose(shot: Shot, t: number, out: CameraPose): boolean {
    const L = lengths();
    switch (shot.id) {
      case 'pad': {
        const site = offsetEnu(padEcef, 330, -260, 3, [0, 0, 0]);
        const f = isStacked(current as FlightResult, t) ? focusStack : shot.vehicle === 'ship' ? focusS : focusB;
        trackerPose(site, f, 0.78, 3, 62, out);
        return true;
      }
      case 'tower': {
        const site = offsetEnu(padEcef, -60, -120, 40, [0, 0, 0]);
        trackerPose(site, focusB, 0.7, 4, 70, out);
        return true;
      }
      case 'tracking': {
        const site = offsetEnu(padEcef, 2600, 8800, 18, [0, 0, 0]);
        const f = current && isStacked(current, t) ? focusStack : shot.vehicle === 'ship' ? focusS : focusB;
        trackerPose(site, f, 0.62, 0.12, 30, out);
        return true;
      }
      case 'buoy': {
        const rig = shot.vehicle === 'booster' ? booster : ship;
        const track = shot.vehicle === 'booster' ? current?.booster : current?.ship;
        if (!track) return false;
        const i = track.n - 1;
        const end: V3 = [track.pos[i * 3], track.pos[i * 3 + 1], track.pos[i * 3 + 2]];
        const r = Math.hypot(end[0], end[1], end[2]);
        const sea: V3 = [(end[0] / r) * 6_371_000, (end[1] / r) * 6_371_000, (end[2] / r) * 6_371_000];
        const site = offsetEnu(sea, 420, -300, 4, [0, 0, 0]);
        trackerPose(site, shot.vehicle === 'booster' ? focusB : focusS, 0.7, 1.5, 55, out);
        return rig.visible || t < track.end + 45;
      }
      case 'booster-top': {
        if (!booster.visible) return false;
        LOCAL.set(0, L.booster + 0.4, 3.6);
        DIR.set(0, 1, -0.08).normalize();
        UP.set(0, 0, -1);
        onboardPose(booster.base, booster.sample.quat, LOCAL, DIR, UP, 92, out);
        return true;
      }
      case 'booster-aft': {
        if (!booster.visible) return false;
        LOCAL.set(4.95, L.booster - 7, 0);
        DIR.set(0.12, -1, 0).normalize();
        UP.set(1, 0, 0);
        onboardPose(booster.base, booster.sample.quat, LOCAL, DIR, UP, 78, out);
        return true;
      }
      case 'ship-aft': {
        if (!ship.visible) return false;
        LOCAL.set(4.9, 9, -0.6);
        DIR.set(0.18, -1, 0.05).normalize();
        UP.set(1, 0, 0);
        onboardPose(ship.base, ship.sample.quat, LOCAL, DIR, UP, 80, out);
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
    }
  }

  // ------------------------------------------------------------- render
  const show = { flown: true, planned: true, coast: true };
  let coastAt = -1e9;
  let coastKey = '';

  const satPos = new THREE.Vector3();
  const satQuat = new THREE.Quaternion();
  const satSpin = new THREE.Quaternion();
  const AXIS_Y = new THREE.Vector3(0, 1, 0);

  function placeSatellites(cameraEcef: V3, t: number) {
    if (!swarm) return;
    let n = 0;
    if (current && t <= current.ship.end) {
      for (const s of sats) {
        if (s.t > t) break;
        const age = t - s.t;
        const x = ship.sample.pos[0] + s.offset[0] + s.drift[0] * age;
        const y = ship.sample.pos[1] + s.offset[1] + s.drift[1] * age;
        const z = ship.sample.pos[2] + s.offset[2] + s.drift[2] * age;
        satPos.set(x - cameraEcef[0], y - cameraEcef[1], z - cameraEcef[2]);
        if (satPos.lengthSq() > 4e8) continue; // farther than 20 km: not worth drawing
        satSpin.setFromAxisAngle(AXIS_Y, s.index * 0.41 + age * 0.015);
        satQuat.copy(ship.sample.quat).multiply(satSpin);
        swarm.setSatellite(n++, satPos, satQuat);
      }
    }
    swarm.setCount(n);
    swarm.commit();
  }

  function placeAll(cameraEcef: V3, t: number) {
    placeSatellites(cameraEcef, t);
    for (const rig of [booster, ship]) {
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
    for (const rig of [booster, ship]) {
      const track = rig.id === 'booster' ? current?.booster : current?.ship;
      if (!track) continue;
      const i = track.n - 1;
      if (rig.explosion) {
        rig.explosion.object.position.set(track.pos[i * 3] - cameraEcef[0], track.pos[i * 3 + 1] - cameraEcef[1], track.pos[i * 3 + 2] - cameraEcef[2]);
      }
      if (rig.splash && rig.touchdown !== null) {
        rig.splash.object.position.set(rig.base[0] - cameraEcef[0], rig.base[1] - cameraEcef[1], rig.base[2] - cameraEcef[2]);
        enuQuaternion(rig.base, rig.splash.object.quaternion);
      }
    }
    for (const g of gates) {
      g.mesh.position.set(g.pos[0] - cameraEcef[0], g.pos[1] - cameraEcef[1], g.pos[2] - cameraEcef[2]);
      const d = dist3(g.pos, cameraEcef);
      g.mesh.scale.setScalar(Math.max(60, d * 0.022));
    }
  }

  function renderView(p: CameraPose, cam: THREE.PerspectiveCamera, vp: Viewport, t: number, dt: number) {
    cam.position.set(0, 0, 0);
    cam.quaternion.copy(p.quat);
    cam.fov = p.fov;
    cam.aspect = vp.w / Math.max(1, vp.h);
    cam.near = 0.3;
    cam.far = 4e8;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    placeAll(p.pos, t);
    earth?.update({ cameraEcef: p.pos, camera: cam, sunDir, time: t });
    lines?.update(t, p.pos, show, vp.w, vp.h);
    booster.model?.update(booster.visual, cam, dt);
    ship.model?.update(ship.visual, cam, dt);

    renderer.setViewport(vp.x, height - vp.y - vp.h, vp.w, vp.h);
    renderer.setScissor(vp.x, height - vp.y - vp.h, vp.w, vp.h);
    renderer.setScissorTest(true);
    renderer.clear();
    renderer.render(scene, cam);
  }

  function project(p: V3, cameraEcef: V3, cam: THREE.PerspectiveCamera, vp: Viewport): { x: number; y: number } | null {
    v1.set(p[0] - cameraEcef[0], p[1] - cameraEcef[1], p[2] - cameraEcef[2]);
    v2.copy(v1).applyQuaternion(qInv.copy(cam.quaternion).invert());
    if (v2.z > -1) return null;
    v1.project(cam);
    if (v1.x < -1.05 || v1.x > 1.05 || v1.y < -1.05 || v1.y > 1.05) return null;
    return { x: vp.x + ((v1.x + 1) / 2) * vp.w, y: vp.y + ((1 - v1.y) / 2) * vp.h };
  }

  function labels(cameraEcef: V3, cam: THREE.PerspectiveCamera, vp: Viewport, t: number, settingsLabels: boolean, settingsGates: boolean) {
    const flight = getFlight(flightN);
    if (settingsLabels) {
      for (const rig of [booster, ship]) {
        if (!rig.visible) continue;
        if (current && rig.id === 'ship' && isStacked(current, t)) continue;
        const d = dist3(rig.center, cameraEcef);
        const L = rig.id === 'booster' ? lengths().booster : lengths().ship;
        const pixels = (L / d) * (vp.h / (2 * Math.tan((cam.fov * Math.PI) / 360)));
        if (pixels > 26) continue;
        if (hiddenByEarth(cameraEcef, rig.center)) continue;
        const pt = project(rig.center, cameraEcef, cam, vp);
        if (!pt) continue;
        const stacked = current !== null && isStacked(current, t);
        const name = stacked ? 'Starship' : rig.id === 'booster' ? 'Super Heavy' : 'Starship';
        const id = stacked ? '' : rig.id === 'booster' ? flight.boosterId : flight.shipId;
        overlay.label(`veh:${rig.id}`, pt.x, pt.y, name, id, rig.id === 'booster' && !stacked ? '#ff7a66' : '#7ab4ff', 'vehicle');
      }
    }
    if (settingsGates) {
      for (const g of gates) {
        if (!g.mesh.visible) continue;
        if (hiddenByEarth(cameraEcef, g.pos)) continue;
        const pt = project(g.pos, cameraEcef, cam, vp);
        if (!pt) continue;
        const color = g.event.vehicle === 'booster' ? '#ff8a78' : g.event.vehicle === 'ship' ? '#8cc0ff' : '#ffffff';
        const m = Math.round(Math.abs(g.event.t));
        const time = m >= 3600 ? `T+${Math.floor(m / 3600)}:${String(Math.floor((m % 3600) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` : `T+${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
        overlay.label(`gate:${g.event.key}:${g.event.t}`, pt.x, pt.y, g.event.short, time, color, 'gate');
      }
    }
  }

  function updateCoast(result: FlightResult, t: number) {
    // Engines-off coast prediction for both vehicles, refreshed twice per simulated second.
    const key = `${result.scenarioKey}:${Math.floor(t * 2)}`;
    if (key === coastKey && Math.abs(t - coastAt) < 0.6) return;
    coastKey = key;
    coastAt = t;
    for (const rig of [booster, ship]) {
      const track = rig.id === 'booster' ? result.booster : result.ship;
      const alive = t > 1 && t < track.end && rig.sample.alt > 50 && !(rig.id === 'ship' && isStacked(result, t));
      if (!alive) {
        lines?.setCoast(rig.id, null, null);
        continue;
      }
      const { points, impact } = predictCoast(rig.sample.pos, rig.sample.vel, 7200, 480);
      lines?.setCoast(rig.id, points, impact);
    }
  }

  function render(t: number, dt: number) {
    if (disposed) return;
    const st = useReplay.getState();
    const result = st.result;
    try {
      if (!result) {
        renderer.setScissorTest(false);
        renderer.clear();
        return;
      }
      if (result !== current || st.baseline !== currentBaseline) rebuild(result, st.baseline);
      const q: Quality = st.settings.quality === 'low' ? 'low' : 'high';
      if (q !== quality) {
        quality = q;
        applySize();
        earth?.setQuality(q);
        booster.model?.setQuality(q);
        ship.model?.setQuality(q);
        pad?.setQuality(q);
      }
      show.flown = st.settings.showFlown;
      show.planned = st.settings.showPlanned;
      show.coast = st.settings.showCoast;

      sunDirectionEcef(result.launchUtc + t * 1000, sunDir);
      updateRig(booster, result, t);
      updateRig(ship, result, t);
      const L = lengths();
      const stacked = isStacked(result, t);
      setFocus(focusB, booster, L.booster);
      setFocus(focusS, ship, L.ship);
      // The stack's middle is the top of the booster.
      v1.set(0, 1, 0).applyQuaternion(booster.sample.quat);
      focusStack.pos[0] = booster.base[0] + v1.x * (L.booster + L.ship) * 0.5;
      focusStack.pos[1] = booster.base[1] + v1.y * (L.booster + L.ship) * 0.5;
      focusStack.pos[2] = booster.base[2] + v1.z * (L.booster + L.ship) * 0.5;
      copy3(booster.sample.vel, focusStack.vel);
      focusStack.quat.copy(booster.sample.quat);
      focusStack.size = L.booster + L.ship;
      const apart = dist3(booster.center, ship.center);
      focusBoth.pos[0] = (booster.center[0] + ship.center[0]) / 2;
      focusBoth.pos[1] = (booster.center[1] + ship.center[1]) / 2;
      focusBoth.pos[2] = (booster.center[2] + ship.center[2]) / 2;
      copy3(ship.sample.vel, focusBoth.vel);
      focusBoth.size = Math.max(L.booster + L.ship, apart + L.booster);

      // Pad, effects and satellites (independent of the view).
      if (pad) {
        const site = PADS[padId ?? 'pad1'];
        const holding = catchTime !== null && t >= catchTime;
        const approaching = catchTime !== null && t >= catchTime - 30 && t < catchTime;
        const catchHeight = site.catchBaseHeight + L.booster - 6;
        pad.update(
          {
            t,
            armsHeight: holding || approaching ? catchHeight : site.tower.height * 0.62,
            armsOpen: holding ? 0 : 1,
            deluge: t > -4 && t < 20 ? 1 - Math.max(0, t - 8) / 12 : 0,
          },
          dt,
        );
      }
      if (clouds) {
        const near = booster.sample.alt < 2500 && t < 60;
        let lit = 0;
        for (let i = 0; i < booster.engines.length; i++) if (booster.engines[i] === 1) lit++;
        clouds.update(t, near ? (lit / Math.max(1, booster.engines.length)) * Math.max(0.2, booster.sample.throttle) : 0, camera);
      }
      for (const rig of [booster, ship]) {
        const track = rig.id === 'booster' ? result.booster : result.ship;
        rig.explosion?.setAge(track.endKind === 'lost' || track.endKind === 'termination' || track.endKind === 'impact' ? t - track.end : -1);
        if (rig.splash) rig.splash.setAge(rig.touchdown !== null ? t - rig.touchdown : -1, rig.id === 'booster' ? 72 : 52);
      }
      if (st.settings.showCoast) updateCoast(result, t);
      for (const g of gates) g.mesh.visible = st.settings.showGates && st.camera === 'globe';

      // ---- choose the views
      const follow = st.follow;
      const sep = !stacked;
      const mainFocus = !sep ? focusStack : follow === 'ship' ? focusS : follow === 'booster' ? focusB : apart < 3000 ? focusBoth : focusS;
      const split = sep && follow === 'both' && apart >= 3000 && (st.camera === 'chase' || st.camera === 'free') && booster.visible && ship.visible;

      let key: string = st.camera;
      if (st.camera === 'globe') {
        globe.centreOn(mainFocus.pos);
        globe.pose(target);
      } else if (st.camera === 'free') {
        free.pose(mainFocus, target);
      } else if (st.camera === 'chase') {
        chase.pose(mainFocus, dt, target);
        key += follow;
      } else {
        const shot: Shot = plan
          ? st.webcastShot === 'auto'
            ? autoShot(t, plan, follow)
            : pickedShot(st.webcastShot as ShotId, t, plan, follow)
          : { id: 'pad', vehicle: 'booster' };
        if (!shotPose(shot, t, target)) chase.pose(mainFocus, dt, target);
        key += `${shot.id}:${shot.vehicle}`;
        if (st.settings.reduceMotion === false && (shot.id === 'pad' || shot.id === 'tower') && t > -1 && t < 14) {
          // Ground shake from the engines near liftoff.
          const amp = 0.0016 * Math.max(0, 1 - Math.abs(t - 3) / 11);
          const e = new THREE.Euler(Math.sin(t * 61) * amp, Math.sin(t * 47 + 1) * amp, 0);
          target.quat.multiply(new THREE.Quaternion().setFromEuler(e));
        }
        lastShot = shot;
      }

      // Smooth transitions between camera modes; webcast cuts are instant like the broadcast.
      if (key !== viewKey) {
        const isCut = key.startsWith('webcast') && viewKey.startsWith('webcast');
        if (viewKey && !isCut && !st.settings.reduceMotion) {
          copyPose(lastPose, fromPose);
          blendT = 0;
          blendDur = key === 'globe' || viewKey === 'globe' ? 1.6 : 0.9;
        } else blendT = 1;
        viewKey = key;
      }
      if (blendT < 1) {
        blendT = Math.min(1, blendT + dt / blendDur);
        blendPose(fromPose, target, blendT, pose);
      } else copyPose(target, pose);
      copyPose(pose, lastPose);

      // Eye adaptation: brighten towards the Earth's suggestion in twilight and at night, capped so the
      // plumes don't blow out.
      if (earth) {
        const goal = Math.min(4, Math.max(1, earth.exposureHint));
        exposure += (goal - exposure) * damp(1, dt);
        renderer.toneMappingExposure = exposure;
      }

      // ---- render
      renderer.setScissorTest(false);
      renderer.clear();
      overlay.begin();
      if (split) {
        const half = Math.floor(width / 2);
        chaseLeft.pose(focusB, dt, leftPose);
        chaseRight.pose(focusS, dt, rightPose);
        const left: Viewport = { x: 0, y: 0, w: half, h: height };
        const right: Viewport = { x: half, y: 0, w: width - half, h: height };
        renderView(leftPose, camera, left, t, dt);
        labels(leftPose.pos, camera, left, t, st.settings.showLabels, false);
        renderView(rightPose, sideCamera, right, t, 0);
        labels(rightPose.pos, sideCamera, right, t, st.settings.showLabels, false);
        const fl = getFlight(flightN);
        overlay.frame('split-left', 0, 0, half, height, `Super Heavy ${fl.boosterId}`.trim());
        overlay.frame('split-right', half, 0, width - half, height, `Starship ${fl.shipId}`);
      } else {
        const full: Viewport = { x: 0, y: 0, w: width, h: height };
        renderView(pose, camera, full, t, dt);
        labels(pose.pos, camera, full, t, st.settings.showLabels, st.settings.showGates && st.camera === 'globe');
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
      if (pipTarget && pipTarget.visible && width > 520) {
        const w = Math.round(Math.min(320, width * 0.28));
        const h = Math.round(w * 0.62);
        const vp: Viewport = { x: width - w - 16, y: 52, w, h };
        const f = st.camera === 'globe' && !sep ? focusStack : pipTarget.id === 'booster' ? focusB : focusS;
        chasePip.pose(f, dt, pipPose);
        renderView(pipPose, sideCamera, vp, t, 0);
        const fl = getFlight(flightN);
        const title = !sep ? 'Super Heavy · Starship' : pipTarget.id === 'booster' ? `Super Heavy ${fl.boosterId}`.trim() : `Starship ${fl.shipId}`;
        overlay.frame('pip', vp.x, vp.y, vp.w, vp.h, title, () => useReplay.getState().setPip(false));
      }
      overlay.end();

      if (!readyFired && earthReady) {
        readyFired = true;
        options.onReady();
      }
    } catch (err) {
      disposed = true;
      options.onError(err);
    }
  }

  function dispose() {
    disposed = true;
    ro.disconnect();
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', onDblClick);
    canvas.removeEventListener('contextmenu', onContext);
    canvas.removeEventListener('webglcontextlost', onLost);
    for (const rig of [booster, ship]) {
      rig.model?.dispose();
      rig.explosion?.dispose();
      rig.splash?.dispose();
    }
    pad?.dispose();
    clouds?.dispose();
    swarm?.dispose();
    lines?.dispose();
    disposeGates(gates);
    earth?.dispose();
    overlay.dispose();
    renderer.dispose();
  }

  return {
    render,
    resetCamera() {
      free.reset();
      globe.reset();
      chase.reset();
    },
    dispose,
  };
}
