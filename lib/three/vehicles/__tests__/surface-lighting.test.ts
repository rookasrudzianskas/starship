import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SHIP_GEOMETRY } from '../../../sim/ship-geometry';
import { Phase } from '../../../sim/types';
import type { VehicleVisualState } from '../../contracts';
import { flapGeometry } from '../parts';
import { createShip } from '../ship';

vi.mock('@/lib/sim/ship-geometry', () => import('../../../sim/ship-geometry'));

const names = ['forward-left', 'forward-right', 'aft-left', 'aft-right'];

function shaderFor(material: THREE.MeshStandardMaterial) {
  const shader = {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms),
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  } as Parameters<typeof material.onBeforeCompile>[0];
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe('articulated flap surface lighting', () => {
  it.each(['b1', 'b2', 'v3'] as const)('%s normals match the actual tapered triangles on both mirrored meshes', (gen) => {
    for (const spec of [SHIP_GEOMETRY[gen].fwd, SHIP_GEOMETRY[gen].aft]) for (const mirror of [false, true]) for (const [nx, ny] of [[4, 6], [7, 10]]) {
      const geometry = flapGeometry({ root: spec.h1 - spec.h0, ...spec.plan }, mirror, nx, ny);
      try {
        const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal'), idx = geometry.getIndex()!;
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
        const face = new THREE.Vector3(), edge = new THREE.Vector3(), normal = new THREE.Vector3();
        for (let i = 0; i < idx.count; i += 3) {
          const ia = idx.getX(i), ib = idx.getX(i + 1), ic = idx.getX(i + 2);
          a.fromBufferAttribute(p, ia); b.fromBufferAttribute(p, ib); c.fromBufferAttribute(p, ic);
          face.subVectors(b, a).cross(edge.subVectors(c, a)).normalize();
          for (const index of [ia, ib, ic]) {
            normal.fromBufferAttribute(n, index);
            expect(normal.length()).toBeCloseTo(1, 6);
            expect(normal.dot(face)).toBeGreaterThan(0.99999);
          }
        }
        // The tapered windward AND leeward faces lean towards the tip.
        expect(n.getX(0) * (mirror ? -1 : 1)).toBeGreaterThan(0);
        expect(n.getX((nx + 1) * (ny + 1)) * (mirror ? -1 : 1)).toBeGreaterThan(0);
      } finally { geometry.dispose(); }
    }
  });

  it.each(['b1', 'b2', 'v3'] as const)('%s keeps hull and articulated surfaces in one heating frame through roll, folds and seeks', (gen) => {
    const ship = createShip(gen, 'low'), parent = new THREE.Group();
    parent.rotation.set(0.3, -0.8, 0.9); parent.add(ship.object);
    const camera = new THREE.PerspectiveCamera(45, 1.5, 0.1, 1000);
    camera.position.set(70, 90, 150); camera.lookAt(0, 25, 0); camera.updateMatrixWorld(true);
    const state: VehicleVisualState = {
      t: 2500, engines: new Uint8Array(6), throttle: 0, ambientPressure: 10, mach: 18,
      aero: [0, 90, 45, 75], heating: 0.7, airflowBody: new THREE.Vector3(0, 0, -1),
      hotStage: 0, phase: Phase.Entry, sunBody: new THREE.Vector3(1, 0, 0),
    };
    try {
      const flaps = names.map(name => ship.object.getObjectByName(`ship-${name}-flap`) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>);
      expect(new Set(flaps.map(f => f.material)).size).toBe(1);
      const body = ship.object.getObjectByName('ship-body') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      const skin = shaderFor(flaps[0].material), hull = shaderFor(body.material);
      // Exercise the real shader hooks, including the chained plume/plasma injections.
      expect(skin.vertexShader).toContain('vHeatNormalWorld = inverseTransformDirection(transformedNormal, viewMatrix);');
      expect(skin.vertexShader.indexOf('#include <defaultnormal_vertex>')).toBeLessThan(skin.vertexShader.indexOf('vHeatNormalWorld ='));
      expect(skin.fragmentShader).toContain('dot(normalize(vHeatNormalWorld), -uAirflowWorld)');
      expect(skin.fragmentShader).not.toContain('normalize(vObjN)');
      expect(skin.fragmentShader).toContain('uPlasmaFlow');
      const uniform = skin.uniforms.uAirflowWorld.value as THREE.Vector3;
      const worldQ = new THREE.Quaternion(), expectedFlow = new THREE.Vector3();
      const worldNormal = new THREE.Vector3(), normalMatrix = new THREE.Matrix3();
      const firstIncidence: number[] = [];
      for (const roll of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        ship.object.quaternion.setFromEuler(new THREE.Euler(0.4, roll, -0.7));
        ship.update(state, camera, 1 / 60);
        ship.object.updateWorldMatrix(true, true);
        ship.object.getWorldQuaternion(worldQ);
        expectedFlow.copy(state.airflowBody).applyQuaternion(worldQ);
        expect(uniform.distanceTo(expectedFlow)).toBeLessThan(1e-12);
        expect((hull.uniforms.uAirflowWorld.value as THREE.Vector3).distanceTo(uniform)).toBe(0);
        expect(skin.uniforms.uHeat.value).toBe(0.7);
        for (let i = 0; i < 4; i++) {
          const flap = flaps[i];
          expect(flap.rotation.y).toBeCloseTo(state.aero[i] * Math.PI / 180 * (i % 2 ? -1 : 1), 12);
          worldNormal.fromBufferAttribute(flap.geometry.getAttribute('normal'), 0).applyMatrix3(normalMatrix.getNormalMatrix(flap.matrixWorld)).normalize();
          const incidence = -worldNormal.dot(uniform);
          if (roll === 0) firstIncidence.push(incidence);
          else expect(incidence).toBeCloseTo(firstIncidence[i], 12); // rigid roll of flow+body preserves incidence
        }
      }
      expect(firstIncidence[0]).toBeGreaterThan(0.95);
      expect(firstIncidence[1]).toBeLessThan(0); // folded wedge face points slightly leeward
      expect(firstIncidence[1]).toBeGreaterThan(-0.06);
      expect(firstIncidence[2]).toBeGreaterThan(0.6);
      expect(firstIncidence[2]).toBeLessThan(0.75);
      expect(firstIncidence[3]).toBeGreaterThan(0.2);
      expect(firstIncidence[3]).toBeLessThan(0.3);

      // A roll in a FIXED world flow changes which side is windward.
      const fixedFlow = uniform.clone(), beforeNormal = worldNormal.clone();
      ship.object.rotateY(Math.PI);
      ship.object.getWorldQuaternion(worldQ);
      state.airflowBody.copy(fixedFlow).applyQuaternion(worldQ.clone().invert());
      ship.update(state, camera, 1 / 60); ship.object.updateWorldMatrix(true, true);
      worldNormal.fromBufferAttribute(flaps[3].geometry.getAttribute('normal'), 0).applyMatrix3(normalMatrix.getNormalMatrix(flaps[3].matrixWorld)).normalize();
      expect(uniform.distanceTo(fixedFlow)).toBeLessThan(1e-12);
      expect(worldNormal.dot(uniform)).toBeCloseTo(-beforeNormal.dot(uniform), 12);

      // A second camera must not overwrite shared flow uniforms, including on a paused frame.
      const saved = uniform.clone(); camera.position.set(-80, 30, -120); camera.lookAt(0, 25, 0); camera.updateMatrixWorld(true);
      ship.setCamera?.(camera);
      expect(uniform.equals(saved)).toBe(true);
      state.aero = [0, 0, 0, 0]; state.heating = 0; state.t = 500;
      ship.update(state, camera, -2000);
      expect(skin.uniforms.uAirflowWorld.value).toBe(uniform);
      expect(skin.uniforms.uHeat.value).toBe(0);
      for (const flap of flaps) expect(Math.abs(flap.rotation.y)).toBe(0);
    } finally { ship.dispose(); }
  });
});
