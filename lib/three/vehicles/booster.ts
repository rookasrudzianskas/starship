import * as THREE from 'three';
import type { Quality, VehicleModel, VehicleVisualState } from '@/lib/three/contracts';
import type { Generation } from '@/lib/sim/types';
import { NOISE_KEY, SharedScope, disposeObjectTree, makeNoiseTexture } from './procedural';
import { FALLBACK_ENV_KEY, makeFallbackEnv, makeSteelMaps, steelMapsKey } from './textures';
import { createDarkMaterial, createSkinMaterial } from './skin';
import { ensureSkinAttributes, hullStrip, lathe, merge, onlyAttributes, radialYaw, skinBox, type ProfilePoint } from './geometry';
import { createEngineMaterial, engineGeometry } from './engines';
import { engineSlots } from './engines-layout';
import { gridFinGeometry } from './parts';
import { PlumeCores, PlumeGlow, PlumeVolume, altitudeFactor, clusterShape, newVolumeShape } from './plumes';
import { Plasma, plasmaGlow } from './plasma';
import { EngineSmoother, PlumeLight, applyEnvFallback, flicker } from './runtime';

/**
 * Super Heavy.
 * b1 / b2 (Block 1): 69 m body + separate 1.8 m vented hot-staging ring, four grid fins near the top,
 *   two raceways, flared aft skirt, 33 Raptor 2 under an aft heat shield.
 * v3: 72 m with an integrated, taller vented interstage, three larger grid fins (120° apart, lower),
 *   Raptor 3 (clean engines), one raceway.
 * Frame: origin at the nozzle-exit plane on the axis, +Y nose, +Z the side facing the tower.
 * userData: setHotStageRing(visible), setFrost(0..1), setPlumeBrightness(k).
 */

const R = 4.5;
const DEG = Math.PI / 180;
/** Brightness of the merged plume while the camera is deep inside it (see PlumeVolume). */
const PLUME_INSIDE_GAIN = 0.15;

interface BoosterSpec {
  bodyTop: number;
  ringTop: number;
  separateRing: boolean;
  ringBottom: number;
  vents: number;
  finAz: number[];
  finY: number;
  fin: { span: number; width: number; chord: number; cell: number };
  raceways: Array<{ theta: number; width: number; height: number; y0: number; y1: number }>;
  catchPins: boolean;
  engine: 'r2' | 'r3';
  plateY: number;
  frost: [number, number, number, number];
}

function spec(gen: Generation): BoosterSpec {
  if (gen === 'v3') {
    return {
      bodyTop: 67.5,
      ringTop: 72.0,
      separateRing: false,
      ringBottom: 67.5,
      vents: 20,
      finAz: [60 * DEG, 180 * DEG, 300 * DEG],
      finY: 64.2,
      fin: { span: 4.4, width: 3.6, chord: 1.05, cell: 0.38 },
      raceways: [{ theta: 1.2, width: 0.5, height: 0.28, y0: 3.4, y1: 61.6 }],
      catchPins: false,
      engine: 'r3',
      plateY: 2.12,
      frost: [4.4, 38.4, 41.0, 61.0],
    };
  }
  return {
    bodyTop: 69.0,
    ringTop: 70.8,
    separateRing: true,
    ringBottom: 69.0,
    vents: 24,
    finAz: [50 * DEG, 130 * DEG, 230 * DEG, 310 * DEG],
    finY: 66.3,
    fin: { span: 3.9, width: 3.0, chord: 0.9, cell: 0.33 },
    raceways: [
      { theta: 1.2, width: 0.56, height: 0.33, y0: 3.4, y1: 64.6 },
      { theta: -1.94, width: 0.42, height: 0.26, y0: 3.4, y1: 63.4 },
    ],
    catchPins: true,
    engine: 'r2',
    plateY: 2.05,
    frost: [4.4, 36.2, 38.8, 58.4],
  };
}

/**
 * Height above the booster base (m) of the undersides of the catch fittings that land on the chopstick
 * rails: the catch pins under the grid fins (b1/b2) or the grid-fin hinge housings (v3).
 */
export function boosterCatchHeight(gen: Generation): number {
  const sp = spec(gen);
  return sp.catchPins ? sp.finY - 2.6 - 0.45 : sp.finY - 1.15;
}

export function createBooster(gen: Generation, quality: Quality): VehicleModel {
  const sp = spec(gen);
  const scope = new SharedScope();
  const maps = scope.get(steelMapsKey(quality), () => makeSteelMaps(quality));
  const noise = scope.get(NOISE_KEY, makeNoiseTexture);
  const fallbackEnv = scope.get(FALLBACK_ENV_KEY, makeFallbackEnv);
  const seg = quality === 'high' ? 96 : 56;

  const object = new THREE.Group();
  object.name = `super-heavy-${gen}`;

  // ---------------------------------------------------------------- materials
  const skin = createSkinMaterial({ maps, noise, tiles: false, frost: true });
  skin.uniforms.uFrostBands.value.set(...sp.frost);
  skin.uniforms.uSoot.value.set(0.9, 3.6, 8.5, 0);
  skin.uniforms.uRingSeed.value = gen === 'v3' ? 31 : gen === 'b2' ? 17 : 5;
  const ringSkin = createSkinMaterial({ maps, noise, tiles: false, frost: false });
  ringSkin.uniforms.uSoot.value.set(0, 0, 1, 0);
  ringSkin.uniforms.uScorch.value.set(0.75, sp.ringBottom - 0.5, sp.ringTop, 0);
  ringSkin.uniforms.uRingSeed.value = 77;
  const dark = createDarkMaterial(0x2a2826, 0.78, 0.35);
  const interior = new THREE.MeshStandardMaterial({ color: 0x1b1918, roughness: 0.85, metalness: 0.2, emissive: 0xff7a2a, emissiveIntensity: 0 });
  const finMat = new THREE.MeshStandardMaterial({ color: 0x8f8e8b, roughness: 0.48, metalness: 0.88 });
  const engineMat = createEngineMaterial();
  const envMats: THREE.MeshStandardMaterial[] = [skin.material, ringSkin.material, dark, interior, finMat, engineMat];
  const plumeLight = new PlumeLight(object, -7);
  for (const m of envMats) plumeLight.apply(m);

  // ---------------------------------------------------------------- body
  const bodyParts: THREE.BufferGeometry[] = [];
  const profile: ProfilePoint[] = [
    { y: 0.32, r: 4.6, crease: true },
    { y: 0.52, r: 4.73, crease: true },
    { y: 0.86, r: 4.73, crease: true },
    { y: 1.0, r: 4.715 },
    { y: 3.2, r: R, crease: true },
  ];
  for (let y = 9; y < sp.bodyTop - 2; y += 9) profile.push({ y, r: R });
  profile.push({ y: sp.bodyTop, r: R, crease: true });
  profile.push({ y: sp.bodyTop, r: 4.28 });
  bodyParts.push(lathe(profile, { segments: seg }));

  for (const rw of sp.raceways) {
    bodyParts.push(hullStrip({ theta: rw.theta, r: R, y0: rw.y0, y1: rw.y1, width: rw.width, height: rw.height, taper: 0.5 }));
  }
  // Grid fin actuator housings.
  for (const az of sp.finAz) {
    const h = skinBox(1.9, 2.3, 0.7);
    h.rotateY(radialYaw(az) + Math.PI / 2);
    h.translate(Math.sin(az) * (R + 0.25), sp.finY, Math.cos(az) * (R + 0.25));
    bodyParts.push(h);
    const cap = skinBox(1.2, 0.5, 0.95);
    cap.rotateY(radialYaw(az) + Math.PI / 2);
    cap.translate(Math.sin(az) * (R + 0.35), sp.finY - 1.35, Math.cos(az) * (R + 0.35));
    bodyParts.push(cap);
  }
  if (sp.catchPins) {
    for (const az of [90 * DEG, -90 * DEG]) {
      const pin = skinBox(0.8, 0.9, 0.75);
      pin.rotateY(radialYaw(az) + Math.PI / 2);
      pin.translate(Math.sin(az) * (R + 0.3), sp.finY - 2.6, Math.cos(az) * (R + 0.3));
      bodyParts.push(pin);
    }
  }
  // Booster quick-disconnect plate (tower side) and a few aft fittings.
  {
    const qd = skinBox(2.2, 1.7, 0.16);
    qd.translate(0, 2.5, 4.66);
    bodyParts.push(qd);
    for (let k = 0; k < 4; k++) {
      const az = (45 + k * 90) * DEG;
      const f = skinBox(0.9, 0.6, 0.3);
      f.rotateY(radialYaw(az) + Math.PI / 2);
      f.translate(Math.sin(az) * 4.78, 1.4, Math.cos(az) * 4.78);
      bodyParts.push(f);
    }
  }
  if (!sp.separateRing) {
    // V3 integrated interstage is part of the body.
    bodyParts.push(...ventedRingSkin(sp, seg));
  }
  const body = new THREE.Mesh(merge(bodyParts.map((g) => ensureSkinAttributes(g))), skin.material);
  body.castShadow = true;
  body.receiveShadow = true;
  body.name = 'booster-body';
  object.add(body);

  // ---------------------------------------------------------------- hot-staging ring (b1/b2)
  const ringGroup = new THREE.Group();
  ringGroup.name = 'hot-stage-ring';
  if (sp.separateRing) {
    const ringMesh = new THREE.Mesh(merge(ventedRingSkin(sp, seg).map((g) => ensureSkinAttributes(g))), ringSkin.material);
    ringMesh.castShadow = true;
    ringMesh.receiveShadow = true;
    ringGroup.add(ringMesh);
  }
  const interiorMesh = new THREE.Mesh(merge(ventedRingInterior(sp, seg)), interior);
  interiorMesh.receiveShadow = true;
  if (sp.separateRing) ringGroup.add(interiorMesh);
  else object.add(interiorMesh);
  object.add(ringGroup);

  // ---------------------------------------------------------------- aft: heat shield and skirt interior
  {
    const parts: THREE.BufferGeometry[] = [];
    const plate = new THREE.CircleGeometry(4.58, seg);
    plate.rotateX(Math.PI / 2);
    plate.translate(0, sp.plateY, 0);
    parts.push(onlyAttributes(plate, ['position', 'normal']));
    const wall = lathe(
      [
        { y: 0.33, r: 4.58 },
        { y: sp.plateY, r: 4.58 },
      ],
      { segments: seg, inward: true },
    );
    parts.push(onlyAttributes(wall, ['position', 'normal']));
    // Inner-engine gimbal boots: short dark collars around the 13 steerable engines.
    const slots = engineSlots('booster');
    for (let i = 0; i < 13; i++) {
      const boot = new THREE.CylinderGeometry(0.42, 0.62, 0.32, 16, 1, true);
      boot.translate(slots[i].x, sp.plateY - 0.15, slots[i].z);
      parts.push(onlyAttributes(boot, ['position', 'normal']));
    }
    const aft = new THREE.Mesh(merge(parts), dark);
    aft.receiveShadow = true;
    object.add(aft);
  }

  // ---------------------------------------------------------------- engines
  const slots = engineSlots('booster');
  const engGeo = engineGeometry(sp.engine, quality, false);
  const engGlow = new THREE.InstancedBufferAttribute(new Float32Array(slots.length * 2), 2);
  engGlow.setUsage(THREE.DynamicDrawUsage);
  engGeo.setAttribute('aGlow', engGlow);
  const engines = new THREE.InstancedMesh(engGeo, engineMat, slots.length);
  engines.name = 'raptors';
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    slots.forEach((s, i) => {
      // Outer-ring bells are packed tight: shrink them slightly so they do not interpenetrate.
      const k = s.ring === 'outer' ? 0.955 : 1;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ((i * 47) % 360) * DEG);
      m.compose(new THREE.Vector3(s.x, 0, s.z), q, new THREE.Vector3(k, 1, k));
      engines.setMatrixAt(i, m);
    });
    engines.instanceMatrix.needsUpdate = true;
  }
  engines.castShadow = true;
  engines.receiveShadow = true;
  object.add(engines);

  // ---------------------------------------------------------------- grid fins
  const finGeo = gridFinGeometry(sp.fin.span, sp.fin.width, sp.fin.chord, sp.fin.cell, 0.75);
  const fins = new THREE.InstancedMesh(finGeo, finMat, sp.finAz.length);
  fins.name = 'grid-fins';
  fins.castShadow = true;
  fins.receiveShadow = true;
  object.add(fins);
  const finMatrix = new THREE.Matrix4();
  const finQ = new THREE.Quaternion();
  const finQ2 = new THREE.Quaternion();
  const finPos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const X = new THREE.Vector3(1, 0, 0);
  const Y = new THREE.Vector3(0, 1, 0);
  const finAngles = new Float32Array(sp.finAz.length).fill(NaN);
  const setFins = (aero: ArrayLike<number>) => {
    let dirty = false;
    sp.finAz.forEach((az, i) => {
      const d = Math.max(-45, Math.min(45, Number(aero[i] ?? 0))) * DEG;
      if (finAngles[i] === d) return;
      finAngles[i] = d;
      dirty = true;
      finQ.setFromAxisAngle(Y, radialYaw(az));
      finQ2.setFromAxisAngle(X, d);
      finQ.multiply(finQ2);
      finPos.set(Math.sin(az) * (R + 0.75), sp.finY, Math.cos(az) * (R + 0.75));
      finMatrix.compose(finPos, finQ, one);
      fins.setMatrixAt(i, finMatrix);
    });
    if (dirty) fins.instanceMatrix.needsUpdate = true;
  };
  setFins([]);

  // ---------------------------------------------------------------- plumes
  const cores = new PlumeCores(
    slots.map((s) => ({ x: s.x, y: 0, z: s.z, exitR: s.ring === 'outer' ? 0.62 : 0.65, kind: 0 })),
    noise,
  );
  cores.mesh.name = 'plume-cores';
  object.add(cores.mesh);
  const volume = new PlumeVolume(noise, quality === 'high' ? 12 : 6, PLUME_INSIDE_GAIN);
  volume.mesh.name = 'plume-volume';
  object.add(volume.mesh);
  const glow = new PlumeGlow();
  glow.mesh.name = 'plume-glow';
  glow.uniforms.uPos.value.set(0, -1.6, 0);
  object.add(glow.mesh);
  const shape = newVolumeShape();

  // Hot-staging jets out of each vent.
  const ventMid = sp.separateRing ? (sp.ringBottom + sp.ringTop) / 2 : sp.ringBottom + (sp.ringTop - sp.ringBottom) * 0.48;
  const jets = new PlumeCores(
    Array.from({ length: sp.vents }, (_, k) => {
      const az = ((k + 0.5) / sp.vents) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.sin(az) * Math.cos(18 * DEG), -Math.sin(18 * DEG), Math.cos(az) * Math.cos(18 * DEG));
      return { x: Math.sin(az) * 4.3, y: ventMid, z: Math.cos(az) * 4.3, exitR: sp.separateRing ? 0.55 : 0.7, kind: 2, dir };
    }),
    noise,
  );
  // Bright but not blinding: a camera on the interstage looks along them from a few metres away.
  jets.uniforms.uBright.value = 1.8;
  jets.mesh.name = 'vent-jets';
  object.add(jets.mesh);

  // ---------------------------------------------------------------- plasma
  const plasma = new Plasma({
    profile: [
      { y: 0.3, r: 4.7 },
      { y: 3.2, r: R },
      { y: sp.ringTop, r: R },
    ],
    length: sp.ringTop,
    radius: R,
    noise,
    steps: quality === 'high' ? 10 : 5,
  });
  object.add(plasma.group);
  for (const m of envMats) plasma.light.apply(m);
  const worldQuat = new THREE.Quaternion();

  // ---------------------------------------------------------------- state
  const smoother = new EngineSmoother(slots.length);
  const slotRadii = slots.map((s) => Math.hypot(s.x, s.z));
  let plumeBrightness = 1;
  let ringVisible = true;
  const model: VehicleModel = {
    object,
    length: sp.ringTop,
    radius: R,
    update(state: VehicleVisualState, camera: THREE.Camera, dt: number) {
      applyEnvFallback(object, envMats, fallbackEnv);
      const t = state.t;
      const power = smoother.update(state.engines, state.throttle, dt);
      const alt = altitudeFactor(state.ambientPressure);
      for (let i = 0; i < slots.length; i++) {
        const v = smoother.intensity[i];
        cores.setIntensity(i, v);
        engGlow.array[i * 2] = v;
        engGlow.array[i * 2 + 1] = 0;
      }
      cores.commit();
      engGlow.needsUpdate = true;
      cores.uniforms.uShape.value.set(alt, 1, 1, 0);
      cores.uniforms.uTime.value = t;
      // Many overlapping cores add up: keep each one moderate in thick air.
      cores.uniforms.uBright.value = (1.2 + 0.5 * alt) * plumeBrightness;

      // Merged plume sized by the lit engines (plus about one nozzle radius of spill).
      const r0 = Math.min(4.6, smoother.litRadius(slotRadii, 3.5) + 0.9);
      clusterShape(shape, alt, r0, -0.05, power, 1);
      shape.intensity *= plumeBrightness;
      volume.setShape(shape);
      volume.uniforms.uTime.value = t;
      volume.updateCamera(camera);

      glow.uniforms.uIntensity.value = power * (0.7 + 1.4 * alt) * plumeBrightness;
      plumeLight.set(power * plumeBrightness, alt);
      plumeLight.place();
      glow.uniforms.uSize.value = R * (1.9 + 1.6 * alt) * Math.sqrt(Math.max(power, 0.05));
      glow.uniforms.uColor.value.setRGB(1.0, 0.9 - 0.12 * alt, 0.76 + 0.24 * alt);
      glow.mesh.visible = power > 0.002;

      // Hot staging: flame out of every vent and a glowing interior.
      const hs = Math.max(0, Math.min(1, state.hotStage)) * (ringVisible || !sp.separateRing ? 1 : 0);
      for (let k = 0; k < sp.vents; k++) jets.setIntensity(k, hs * (0.75 + 0.5 * flicker(t, k)));
      jets.commit();
      jets.uniforms.uShape.value.set(alt, 1, 1, 0);
      jets.uniforms.uTime.value = t;
      jets.mesh.visible = hs > 0.002;
      interior.emissiveIntensity = hs * 3.5;

      setFins(state.aero);
      plasma.update(plasmaGlow(state.heating * 0.6, state.mach), state.airflowBody, object.getWorldQuaternion(worldQuat), t, camera);
    },
    setCamera(camera: THREE.Camera) {
      volume.updateCamera(camera);
      plasma.setCamera(camera);
      plumeLight.place();
    },
    setQuality(q: Quality) {
      volume.setSteps(q === 'high' ? 12 : 6);
      plasma.setSteps(q === 'high' ? 10 : 5);
    },
    dispose() {
      object.removeFromParent();
      // Every geometry and material in the tree is owned by this model; textures are shared (scope).
      object.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
      disposeObjectTree(object);
      scope.releaseAll();
    },
  };

  const ud = object.userData as {
    setHotStageRing?: (v: boolean) => void;
    setFrost?: (v: number) => void;
    setPlumeBrightness?: (k: number) => void;
  };
  ud.setHotStageRing = (v: boolean) => {
    if (!sp.separateRing || v === ringVisible) return;
    ringVisible = v;
    ringGroup.visible = v;
    model.length = v ? sp.ringTop : sp.bodyTop;
    skin.uniforms.uScorch.value.set(v ? 0.35 : 0, sp.bodyTop - 3.5, sp.bodyTop, 0);
  };
  ud.setFrost = (v: number) => {
    skin.uniforms.uFrost.value = Math.max(0, Math.min(1, v));
  };
  ud.setPlumeBrightness = (k: number) => {
    plumeBrightness = Math.max(0, k);
  };
  skin.uniforms.uScorch.value.set(sp.separateRing ? 0.35 : 0.5, sp.bodyTop - 3.5, sp.bodyTop, 0);
  return model;
}

/** Vented ring / interstage: bottom and top bands, posts between the vents, lips facing the openings. */
function ventedRingSkin(sp: BoosterSpec, seg: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const y0 = sp.ringBottom;
  const y1 = sp.ringTop;
  const tall = y1 - y0;
  const band = sp.separateRing ? 0.27 : 0.38;
  const inner = 4.24;
  // Bottom band with its upper lip, top band with its lower lip and top rim.
  parts.push(
    lathe(
      [
        { y: y0, r: R, crease: true },
        { y: y0 + band, r: R, crease: true },
        { y: y0 + band, r: inner },
      ],
      { segments: seg },
    ),
  );
  parts.push(
    lathe(
      [
        { y: y1 - band, r: inner, crease: true },
        { y: y1 - band, r: R, crease: true },
        { y: y1, r: R, crease: true },
        { y: y1, r: inner },
      ],
      { segments: seg },
    ),
  );
  if (!sp.separateRing) {
    // V3: a mid-height stiffening band.
    const ym = y0 + tall * 0.52;
    parts.push(
      lathe(
        [
          { y: ym - 0.16, r: inner, crease: true },
          { y: ym - 0.16, r: R - 0.04, crease: true },
          { y: ym + 0.16, r: R - 0.04, crease: true },
          { y: ym + 0.16, r: inner },
        ],
        { segments: seg },
      ),
    );
  }
  // Posts.
  const postW = sp.separateRing ? 0.3 : 0.4;
  const postD = R - inner;
  const postH = tall - band * 2;
  for (let k = 0; k < sp.vents; k++) {
    const az = (k / sp.vents) * Math.PI * 2;
    const p = skinBox(postD, postH, postW);
    p.rotateY(radialYaw(az));
    const rc = (R + inner) / 2;
    p.translate(Math.sin(az) * rc, y0 + tall / 2, Math.cos(az) * rc);
    parts.push(p);
  }
  return parts;
}

/** Dark, sooty interior seen through the vents (and the domed bulkhead cover below it). */
function ventedRingInterior(sp: BoosterSpec, seg: number): THREE.BufferGeometry[] {
  const y0 = sp.ringBottom;
  const y1 = sp.ringTop;
  const wall = lathe(
    [
      { y: y0, r: 4.22 },
      { y: y1, r: 4.22 },
    ],
    { segments: seg, inward: true },
  );
  const domeProfile: ProfilePoint[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2);
    domeProfile.push({ y: y0 + 0.05 + Math.sin(a) * 1.25, r: Math.max(0.01, 4.22 * Math.cos(a)) });
  }
  const dome = lathe(domeProfile, { segments: seg });
  return [onlyAttributes(wall, ['position', 'normal']), onlyAttributes(dome, ['position', 'normal'])];
}
