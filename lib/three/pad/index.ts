import * as THREE from 'three';
import type { PadModel, PadState, Quality } from '@/lib/three/contracts';
import type { PadId } from '@/lib/sim/types';
import { PADS } from '@/lib/flights/catalog';
import {
  disposeObjectTree,
  makeNoiseTexture,
  makeSoftSprite,
  NOISE_KEY,
  SharedScope,
  SOFT_SPRITE_KEY,
} from '@/lib/three/vehicles/procedural';
import { MeshBuilder } from './builder';
import { createDeluge } from './deluge';
import { createPadMaterials } from './materials';
import { buildMountPad1, buildMountPad2 } from './mount';
import { buildSite } from './site';
import { buildTower, type StaticBuilders } from './tower';

export { CHOPSTICKS, CHOPSTICK_RAIL_TOP } from './tower';

/**
 * Starbase-style launch site (satisfies PadModel). Frame (right-handed): origin on the ground at the
 * launch-mount centre, +X east, +Y up, +Z SOUTH. The site is authored in (east, up, north) coordinates
 * and mirrored into this frame by an inner group with scale.z = -1 (three.js flips the face winding for
 * mirrored transforms, so shading and shadows are unaffected). The integration tower stands north of the
 * mount, i.e. at (PADS[pad].tower.east, -PADS[pad].tower.north);
 * its chopstick arms are driven by PadState.armsHeight (arms' underside above the ground) and
 * PadState.armsOpen (0 closed around a 9 m booster, 1 swung fully open). PadState.deluge drives water
 * spray and steam at the mount base. Static structures are merged per material; lattice members are
 * instanced (about 17 draw calls on 'high', 14 on 'low', plus the deluge sprites while active).
 */
export function createPad(pad: PadId, quality: Quality): PadModel {
  const site = PADS[pad];
  const scope = new SharedScope();
  const mats = createPadMaterials(scope);
  const object = new THREE.Group();
  object.name = `pad-${pad}`;
  // Everything below is built with +Z = north; this group maps it onto the contract's +Z = south.
  const content = new THREE.Group();
  content.name = 'pad-content';
  content.scale.set(1, 1, -1);
  object.add(content);

  const B: StaticBuilders = {
    paint: new MeshBuilder(),
    steel: new MeshBuilder(),
    concrete: new MeshBuilder(),
    cast: new MeshBuilder(),
    white: new MeshBuilder(),
    plate: new MeshBuilder(),
    tank: new MeshBuilder(),
    lights: new MeshBuilder(),
    paintDetail: new MeshBuilder(),
    steelDetail: new MeshBuilder(),
    whiteDetail: new MeshBuilder(),
  };

  const tower = buildTower(
    {
      x: site.tower.east,
      z: site.tower.north,
      height: site.tower.height,
      width: 12,
      // Ship QD arm level: a few metres above the ship's base when stacked on the booster.
      shipQdHeight: site.mountHeight + (pad === 'pad1' ? 77 : 78),
      seed: pad === 'pad1' ? 1 : 2,
    },
    B,
    mats,
  );
  if (pad === 'pad1') buildMountPad1(B, site.mountHeight);
  else buildMountPad2(B, site.mountHeight);
  buildSite(pad, B);

  const detail: THREE.Object3D[] = [...tower.detail];
  const addStatic = (b: MeshBuilder, mat: THREE.Material, name: string, isDetail: boolean, shadows = true) => {
    if (b.isEmpty) return;
    const mesh = new THREE.Mesh(b.build(), mat);
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    content.add(mesh);
    if (isDetail) detail.push(mesh);
  };
  addStatic(B.concrete, mats.concrete, 'pad-concrete', false);
  addStatic(B.cast, mats.cast, 'pad-cast-concrete', false);
  addStatic(B.paint, mats.paint, 'pad-steelwork', false);
  addStatic(B.steel, mats.steel, 'pad-bare-steel', false);
  addStatic(B.plate, mats.plate, 'pad-deflector', false);
  addStatic(B.tank, mats.tank, 'pad-tanks', false);
  addStatic(B.white, mats.white, 'pad-white', false);
  addStatic(B.lights, mats.lights, 'pad-aviation-lights', false, false);
  addStatic(B.paintDetail, mats.paint, 'pad-steelwork-detail', true);
  addStatic(B.steelDetail, mats.steel, 'pad-steel-detail', true);
  addStatic(B.whiteDetail, mats.white, 'pad-white-detail', true);
  for (const o of tower.objects) content.add(o);

  const sprite = scope.get(SOFT_SPRITE_KEY, makeSoftSprite);
  const noise = scope.get(NOISE_KEY, makeNoiseTexture);
  const DELUGE_HIGH = 260;
  const DELUGE_LOW = 100;
  const deluge = createDeluge(pad, DELUGE_HIGH, sprite, noise);
  content.add(deluge.mesh);

  const setQuality = (q: Quality) => {
    for (const o of detail) o.visible = q === 'high';
    deluge.setCount(q === 'high' ? DELUGE_HIGH : DELUGE_LOW);
  };
  setQuality(quality);

  return {
    object,
    mountHeight: site.mountHeight,
    tower: { x: site.tower.east, z: -site.tower.north, height: site.tower.height },
    update(state: PadState, dt: number) {
      void dt;
      tower.setArms(state.armsHeight, state.armsOpen);
      deluge.update(state.t, state.deluge);
    },
    setQuality,
    dispose() {
      object.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
      content.remove(deluge.mesh);
      deluge.dispose();
      disposeObjectTree(object);
      for (const m of mats.list()) m.dispose();
      scope.releaseAll();
    },
  };
}
