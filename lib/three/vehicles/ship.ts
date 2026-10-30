import * as THREE from 'three';
import type { Quality, ShipModel, VehicleVisualState } from '@/lib/three/contracts';
import type { Generation } from '@/lib/sim/types';
import { NOISE_KEY, SharedScope, disposeObjectTree, makeNoiseTexture, smoothstep } from './procedural';
import { FALLBACK_ENV_KEY, makeFallbackEnv, makeSteelMaps, steelMapsKey } from './textures';
import { createDarkMaterial, createSkinMaterial } from './skin';
import { cylinderPatch, ensureSkinAttributes, hullStrip, lathe, merge, onlyAttributes, skinBox, type ProfilePoint } from './geometry';
import { createEngineMaterial, engineGeometry, type EngineKind } from './engines';
import { engineSlots } from './engines-layout';
import { flapGeometry, flapPivot, type FlapPlanform } from './parts';
import { PlumeCores, PlumeGlow, PlumeVolume, altitudeFactor, clusterShape, newVolumeShape } from './plumes';
import { Plasma } from './plasma';
import { EngineSmoother, PlumeLight, applyEnvFallback } from './runtime';

/**
 * Starship (upper stage).
 * b1 (Block 1, 50.3 m): large forward flaps on the sides of the nose.
 * b2 (Block 2, 52.1 m) and v3 (52.1 m): smaller forward flaps moved up and towards the leeward side;
 *   v3 carries Raptor 3 / RVac 3.
 * Windward half (+Z) covered in black hexagonal tiles that wrap round the nose tip; flaps tiled on their
 * windward faces; Starlink "Pez" slot on the leeward side.
 *
 * Flap angles (aero = [fwdLeft, fwdRight, aftLeft, aftRight], degrees): 0 = flap spread flat, its plane
 * perpendicular to the belly axis (belly-flop position); positive folds the flap towards the leeward side
 * (+90 = folded back against the body); negative tips it windward. Left = +X side.
 * Frame: origin at the nozzle-exit plane on the axis, +Y nose, +Z heat-shield side.
 * userData: setFrost(0..1), setPlumeBrightness(k).
 */

const R = 4.5;
const DEG = Math.PI / 180;
/** Brightness of the merged plume while the camera is deep inside it (see PlumeVolume). */
const PLUME_INSIDE_GAIN = 0.15;

interface FlapSpec {
  az: number;
  /** Hinge from height h0 to h1 on the hull surface (forward flaps: above the nose base). */
  h0: number;
  h1: number;
  plan: Omit<FlapPlanform, 'root'>;
}

interface ShipSpec {
  length: number;
  noseBase: number;
  fwd: FlapSpec;
  aft: FlapSpec;
  door: { y: number; width: number; height: number };
  sl: EngineKind;
  vac: EngineKind;
  wrapStart: number;
  frost: [number, number, number, number];
}

function spec(gen: Generation): ShipSpec {
  const aft: FlapSpec = {
    az: 90 * DEG,
    h0: 1.25,
    h1: 11.9,
    plan: { span: 4.15, tipY0: 0.35, tipY1: 7.4, tRoot: 0.46, tTip: 0.14, curve: 0.12 },
  };
  if (gen === 'b1') {
    return {
      length: 50.3,
      noseBase: 33.0,
      fwd: { az: 90 * DEG, h0: 1.5, h1: 8.6, plan: { span: 3.35, tipY0: 1.1, tipY1: 4.1, tRoot: 0.38, tTip: 0.11, curve: 0.55 } },
      aft,
      door: { y: 30.4, width: 3.4, height: 0.8 },
      sl: 'r2',
      vac: 'rvac2',
      wrapStart: 9.4,
      frost: [3.8, 18.6, 20.4, 29.6],
    };
  }
  const v3 = gen === 'v3';
  return {
    length: 52.1,
    noseBase: 34.8,
    fwd: {
      az: (v3 ? 120 : 116) * DEG,
      h0: v3 ? 4.6 : 4.2,
      h1: v3 ? 9.6 : 9.5,
      plan: { span: v3 ? 2.55 : 2.7, tipY0: 0.8, tipY1: 3.0, tRoot: 0.33, tTip: 0.1, curve: 0.6 },
    },
    aft: { ...aft, h1: 12.3 },
    door: { y: v3 ? 32.5 : 32.2, width: 4.6, height: 1.0 },
    sl: v3 ? 'r3' : 'r2',
    vac: v3 ? 'rvac3' : 'rvac2',
    wrapStart: 2.4,
    frost: [3.8, 19.9, 21.6, 31.2],
  };
}

/** Nose radius at height h above the nose base (power-ellipse ogive with a rounded tip). */
function noseRadius(h: number, len: number): number {
  const t = Math.min(1, Math.max(0, h / len));
  return R * Math.pow(Math.max(0, 1 - Math.pow(t, 1.38)), 1 / 1.62);
}

export function createShip(gen: Generation, quality: Quality): ShipModel {
  const sp = spec(gen);
  const scope = new SharedScope();
  const maps = scope.get(steelMapsKey(quality), () => makeSteelMaps(quality));
  const noise = scope.get(NOISE_KEY, makeNoiseTexture);
  const fallbackEnv = scope.get(FALLBACK_ENV_KEY, makeFallbackEnv);
  const seg = quality === 'high' ? 112 : 64;
  const noseLen = sp.length - sp.noseBase;
  const hullR = (y: number) => (y <= sp.noseBase ? R : noseRadius(y - sp.noseBase, noseLen));

  const object = new THREE.Group();
  object.name = `starship-${gen}`;

  // ---------------------------------------------------------------- materials
  const skin = createSkinMaterial({ maps, noise, tiles: true, frost: true });
  skin.uniforms.uFrostBands.value.set(...sp.frost);
  skin.uniforms.uSoot.value.set(0.55, 1.0, 4.2, 0);
  skin.uniforms.uRingSeed.value = gen === 'b1' ? 3 : gen === 'b2' ? 41 : 59;
  const flapSkin = createSkinMaterial({ maps, noise, tiles: true, frost: false });
  const dark = createDarkMaterial(0x1d1c1b, 0.8, 0.3);
  const engineMat = createEngineMaterial();
  const envMats: THREE.MeshStandardMaterial[] = [skin.material, flapSkin.material, dark, engineMat];
  const plumeLight = new PlumeLight(object, -6);
  for (const m of envMats) plumeLight.apply(m);

  // ---------------------------------------------------------------- hull profile
  // Payload slot (the "Pez" door) on the leeward side: a real opening, cut on whole hull segments.
  const segAngle = (Math.PI * 2) / seg;
  const dw = Math.max(1, Math.round(sp.door.width / R / 2 / segAngle)) * segAngle;
  const dh = sp.door.height;
  const slotY0 = sp.door.y - dh / 2;
  const slotY1 = sp.door.y + dh / 2;
  const profile: ProfilePoint[] = [
    { y: 0, r: 4.36, crease: true },
    { y: 0.12, r: R, crease: true },
  ];
  const barrel = [slotY0, slotY1];
  for (let y = 8; y < sp.noseBase - 1; y += 8) barrel.push(y);
  for (const y of [...new Set(barrel)].sort((a, b) => a - b)) profile.push({ y, r: R });
  profile.push({ y: sp.noseBase, r: R });
  const nn = quality === 'high' ? 30 : 18;
  for (let i = 1; i <= nn; i++) {
    const u = i / nn;
    const t = 1 - Math.pow(1 - u, 1.7);
    const h = t * noseLen;
    profile.push({ y: sp.noseBase + h, r: i === nn ? 0 : noseRadius(h, noseLen) });
  }
  // Arc length to the nose base and the tip (for the tile boundary).
  let sNose = 0;
  let sTip = 0;
  for (let i = 1; i < profile.length; i++) {
    const d = Math.hypot(profile[i].y - profile[i - 1].y, profile[i].r - profile[i - 1].r);
    sTip += d;
    if (profile[i].y <= sp.noseBase + 1e-6) sNose = sTip;
  }
  skin.uniforms.uTileEdge.value.set(1.63, sNose + sp.wrapStart, sTip - 1.1, 0);

  const bodyParts: THREE.BufferGeometry[] = [];
  bodyParts.push(lathe(profile, { segments: seg, tileKind: 1, hole: { y0: slotY0, y1: slotY1, theta: Math.PI, halfAngle: dw } }));

  // Aft heat-shield plate between the engines (tiled) and the skirt interior (dark).
  const plateY = 3.3;
  {
    const plate = new THREE.CircleGeometry(4.36, seg);
    plate.rotateX(Math.PI / 2);
    plate.translate(0, plateY, 0);
    const pos = plate.getAttribute('position') as THREE.BufferAttribute;
    const tiles = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      tiles[i * 4] = pos.getX(i);
      tiles[i * 4 + 1] = pos.getZ(i);
      tiles[i * 4 + 3] = 2;
    }
    plate.setAttribute('aTile', new THREE.BufferAttribute(tiles, 4));
    bodyParts.push(plate);
  }

  // Raceway along the leeward side of the right-hand tile line.
  bodyParts.push(hullStrip({ theta: -1.95, r: R, y0: 3.6, y1: sp.noseBase + 0.6, width: 0.5, height: 0.3, taper: 0.6 }));
  // Aft flap hinge fairings ("aerocovers") on the leeward side of each hinge.
  for (const side of [1, -1]) {
    const az = sp.aft.az * side;
    bodyParts.push(hullStrip({ theta: az + side * 0.24, r: R, y0: sp.aft.h0 - 0.2, y1: sp.aft.h1 + 0.8, width: 1.5, height: 0.75, taper: 1.2, steps: 10 }));
  }

  // ---------------------------------------------------------------- flaps
  const flapGeos: THREE.BufferGeometry[] = [];
  const flaps: THREE.Mesh[] = [];
  const makeFlap = (f: FlapSpec, side: 1 | -1, fairing: boolean, base: number) => {
    const az = f.az * side;
    const off = 0.16;
    const h0 = base + f.h0;
    const h1 = base + f.h1;
    const p0 = new THREE.Vector3(Math.sin(az) * (hullR(h0) + off), h0, Math.cos(az) * (hullR(h0) + off));
    const p1 = new THREE.Vector3(Math.sin(az) * (hullR(h1) + off), h1, Math.cos(az) * (hullR(h1) + off));
    const pivot = flapPivot(p0, p1, side < 0);
    const root = p0.distanceTo(p1);
    const geo = flapGeometry({ root, ...f.plan }, side < 0, quality === 'high' ? 7 : 4, quality === 'high' ? 10 : 6);
    flapGeos.push(geo);
    const mesh = new THREE.Mesh(geo, flapSkin.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pivot.add(mesh);
    object.add(pivot);
    flaps.push(mesh);
    if (fairing) {
      // Hinge fairing on the nose, aligned with the hinge and pushed to the leeward side.
      const g = skinBox(0.62, root + 0.8, 0.95);
      const mid = p0.clone().add(p1).multiplyScalar(0.5);
      const outward = new THREE.Vector3(Math.sin(az), 0, Math.cos(az));
      const lee = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az)).multiplyScalar(side);
      mid.addScaledVector(lee, 0.55).addScaledVector(outward, -0.12);
      const m = new THREE.Matrix4().makeRotationFromQuaternion(pivot.quaternion);
      m.setPosition(mid);
      g.applyMatrix4(m);
      bodyParts.push(g);
    }
  };
  makeFlap(sp.fwd, 1, true, sp.noseBase);
  makeFlap(sp.fwd, -1, true, sp.noseBase);
  makeFlap(sp.aft, 1, false, 0);
  makeFlap(sp.aft, -1, false, 0);

  const body = new THREE.Mesh(merge(bodyParts.map((g) => ensureSkinAttributes(g))), skin.material);
  body.name = 'ship-body';
  body.castShadow = true;
  body.receiveShadow = true;
  object.add(body);

  // ---------------------------------------------------------------- payload door (leeward)
  // Flush with the skin when closed; it pulls in and slides up inside the hull to open the slot.
  const doorSteps = Math.round((2 * dw) / segAngle);
  const doorGeo = ensureSkinAttributes(cylinderPatch(R, Math.PI - dw, Math.PI + dw, slotY0, slotY1, doorSteps));
  const door = new THREE.Mesh(doorGeo, skin.material);
  door.name = 'payload-door';
  door.castShadow = true;
  object.add(door);
  const slotParts = [slotRecess(R, 1.0, slotY0, slotY1, dw, doorSteps)];

  // ---------------------------------------------------------------- dark parts: skirt interior + slot
  {
    const wall = lathe(
      [
        { y: 0.02, r: 4.34 },
        { y: plateY, r: 4.34 },
      ],
      { segments: seg, inward: true },
    );
    const parts = [onlyAttributes(wall, ['position', 'normal']), ...slotParts];
    const darkMesh = new THREE.Mesh(merge(parts), dark);
    darkMesh.receiveShadow = true;
    object.add(darkMesh);
  }

  // ---------------------------------------------------------------- engines
  const slots = engineSlots('ship');
  const SL_Y = 1.35;
  const glowSL = new THREE.InstancedBufferAttribute(new Float32Array(6), 2);
  const glowVac = new THREE.InstancedBufferAttribute(new Float32Array(6), 2);
  glowSL.setUsage(THREE.DynamicDrawUsage);
  glowVac.setUsage(THREE.DynamicDrawUsage);
  const slGeo = engineGeometry(sp.sl, quality, false);
  slGeo.setAttribute('aGlow', glowSL);
  const vacGeo = engineGeometry(sp.vac, quality, false);
  vacGeo.setAttribute('aGlow', glowVac);
  const slEngines = new THREE.InstancedMesh(slGeo, engineMat, 3);
  const vacEngines = new THREE.InstancedMesh(vacGeo, engineMat, 3);
  {
    const m = new THREE.Matrix4();
    for (let i = 0; i < 3; i++) {
      m.makeTranslation(slots[i].x, SL_Y, slots[i].z);
      slEngines.setMatrixAt(i, m);
      m.makeTranslation(slots[i + 3].x, 0, slots[i + 3].z);
      vacEngines.setMatrixAt(i, m);
    }
  }
  for (const e of [slEngines, vacEngines]) {
    e.instanceMatrix.needsUpdate = true;
    e.castShadow = true;
    e.receiveShadow = true;
    object.add(e);
  }

  // ---------------------------------------------------------------- plumes
  const cores = new PlumeCores(
    slots.map((s, i) => ({ x: s.x, y: i < 3 ? SL_Y : 0, z: s.z, exitR: s.exitRadius, kind: s.vacuum ? 1 : 0 })),
    noise,
  );
  cores.mesh.name = 'plume-cores';
  object.add(cores.mesh);
  const volume = new PlumeVolume(noise, quality === 'high' ? 12 : 6, PLUME_INSIDE_GAIN);
  volume.mesh.name = 'plume-volume';
  object.add(volume.mesh);
  const glow = new PlumeGlow();
  glow.mesh.name = 'plume-glow';
  object.add(glow.mesh);
  const shape = newVolumeShape();

  // ---------------------------------------------------------------- plasma
  const plasma = new Plasma({
    profile: profile.filter((p, i) => i > 1 && p.r > 0.3).map((p) => ({ y: p.y, r: p.r })),
    length: sp.length,
    radius: R,
    noise,
    steps: quality === 'high' ? 10 : 5,
  });
  object.add(plasma.group);

  // ---------------------------------------------------------------- state
  const smoother = new EngineSmoother(6);
  const slotRadii = slots.map((s) => Math.hypot(s.x, s.z));
  let plumeBrightness = 1;
  let doorOpen = 0;
  const flapAngles = [NaN, NaN, NaN, NaN];
  const setDoor = (v: number) => {
    doorOpen = Math.max(0, Math.min(1, v));
    // Pull in behind the skin (towards the axis is +Z on the leeward side), then slide up out of sight.
    door.position.set(0, smoothstep(0.15, 1, doorOpen) * (dh + 0.2), smoothstep(0, 0.15, doorOpen) * 0.12);
  };

  const model: ShipModel = {
    object,
    length: sp.length,
    radius: R,
    update(state: VehicleVisualState, camera: THREE.Camera, dt: number) {
      applyEnvFallback(object, envMats, fallbackEnv);
      const t = state.t;
      const power = smoother.update(state.engines, state.throttle, dt);
      const alt = altitudeFactor(state.ambientPressure);
      const hs = Math.max(0, Math.min(1, state.hotStage));
      for (let i = 0; i < 6; i++) {
        const v = smoother.intensity[i];
        cores.setIntensity(i, v);
        const g = i < 3 ? glowSL : glowVac;
        const k = i % 3;
        g.array[k * 2] = v;
        g.array[k * 2 + 1] = i >= 3 ? smoother.heat[i] * smoother.heat[i] : 0;
      }
      cores.commit();
      glowSL.needsUpdate = true;
      glowVac.needsUpdate = true;
      // While hot staging the exhaust splashes on the booster's dome a few metres below.
      cores.uniforms.uShape.value.set(alt, 1 - 0.86 * hs, 1, 0);
      cores.uniforms.uTime.value = t;
      // In vacuum the exhaust is faint next to the glowing nozzles.
      cores.uniforms.uBright.value = (2.2 - 1.6 * smoothstep(0.35, 0.9, alt)) * plumeBrightness * (1 + 0.6 * hs);

      const r0 = Math.min(3.9, smoother.litRadius(slotRadii, 3) + 1.0);
      clusterShape(shape, alt, r0, -0.05, power * (1 - hs), 0.85);
      shape.intensity *= plumeBrightness;
      volume.setShape(shape);
      volume.uniforms.uTime.value = t;
      volume.updateCamera(camera);

      glow.uniforms.uPos.value.set(0, -1.0 - 0.8 * (1 - hs), 0);
      // In vacuum the bloom is that of the glowing nozzles, not of the (faint) exhaust: small and dim, so a
      // camera behind the ship still sees the engines.
      glow.uniforms.uIntensity.value = power * (0.8 - 0.45 * alt + 0.5 * hs) * plumeBrightness;
      plumeLight.set(power * plumeBrightness, alt);
      plumeLight.place();
      glow.uniforms.uSize.value = R * (1.5 + 0.15 * alt) * Math.sqrt(Math.max(power, 0.05));
      glow.uniforms.uColor.value.setRGB(1.0, 0.9 - 0.12 * alt - 0.1 * hs, 0.78 + 0.22 * alt - 0.3 * hs);
      glow.mesh.visible = power > 0.002;

      // Flaps.
      for (let i = 0; i < 4; i++) {
        const d = Math.max(-30, Math.min(95, Number(state.aero[i] ?? 0))) * DEG;
        if (flapAngles[i] === d) continue;
        flapAngles[i] = d;
        const right = i === 1 || i === 3;
        flaps[i].rotation.y = right ? -d : d;
      }

      // Entry heating: plasma plus a faint glow of the windward tiles.
      skin.uniforms.uHeat.value = state.heating;
      flapSkin.uniforms.uHeat.value = state.heating;
      skin.uniforms.uAirflow.value.copy(state.airflowBody);
      flapSkin.uniforms.uAirflow.value.copy(state.airflowBody);
      plasma.update(state.heating, state.airflowBody, t, camera);
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
    setPayloadDoor(open: number) {
      setDoor(open);
    },
    dispose() {
      object.removeFromParent();
      object.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
      disposeObjectTree(object);
      scope.releaseAll();
    },
  };
  setDoor(0);

  const ud = object.userData as { setFrost?: (v: number) => void; setPlumeBrightness?: (k: number) => void };
  ud.setFrost = (v: number) => {
    skin.uniforms.uFrost.value = Math.max(0, Math.min(1, v));
  };
  ud.setPlumeBrightness = (k: number) => {
    plumeBrightness = Math.max(0, k);
  };
  return model;
}

/**
 * Inside of the payload slot behind the hull opening (position and normal only): ceiling, floor, side
 * walls and the dark back of the payload bay, `depth` metres in from the skin at radius r.
 */
function slotRecess(r: number, depth: number, y0: number, y1: number, dw: number, steps: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const at = (rr: number, th: number, y: number) => new THREE.Vector3(rr * Math.sin(th), y, rr * Math.cos(th));
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  // Two triangles facing `n` (the winding is chosen from the normal, so corners may come in either order).
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, n: THREE.Vector3) => {
    const flip = e1.subVectors(b, a).cross(e2.subVectors(c, a)).dot(n) < 0;
    const tri = flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
    for (const p of tri) {
      pos.push(p.x, p.y, p.z);
      nrm.push(n.x, n.y, n.z);
    }
  };
  const ri = r - depth;
  const up = new THREE.Vector3(0, 1, 0);
  const down = new THREE.Vector3(0, -1, 0);
  for (let k = 0; k < steps; k++) {
    const ta = Math.PI - dw + (2 * dw * k) / steps;
    const tb = Math.PI - dw + (2 * dw * (k + 1)) / steps;
    const tm = (ta + tb) / 2;
    quad(at(r, ta, y1), at(r, tb, y1), at(ri, tb, y1), at(ri, ta, y1), down);
    quad(at(r, ta, y0), at(r, tb, y0), at(ri, tb, y0), at(ri, ta, y0), up);
    quad(at(ri, ta, y0), at(ri, tb, y0), at(ri, tb, y1), at(ri, ta, y1), new THREE.Vector3(Math.sin(tm), 0, Math.cos(tm)));
  }
  for (const side of [-1, 1]) {
    const th = Math.PI + side * dw;
    // Tangent of increasing azimuth; each side wall faces the middle of the slot.
    const n = new THREE.Vector3(Math.cos(th), 0, -Math.sin(th)).multiplyScalar(-side);
    quad(at(r, th, y0), at(ri, th, y0), at(ri, th, y1), at(r, th, y1), n);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return onlyAttributes(g, ['position', 'normal']);
}
