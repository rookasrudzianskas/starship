import * as THREE from 'three';
import type { SharedScope } from '@/lib/three/vehicles/procedural';
import {
  CAST_KEY,
  CLADDING_KEY,
  CONCRETE_KEY,
  makeCastConcreteTexture,
  makeCladdingTexture,
  makeConcreteTexture,
  makePlateTexture,
  makeRingSteelTexture,
  PLATE_KEY,
  RING_STEEL_KEY,
} from './textures';

/**
 * Physically based materials for the pad. Builder meshes carry their tint in vertex colours (so one
 * material serves many differently coloured parts); instanced lattices use per-instance colours.
 */
export interface PadMaterials {
  /** Painted structural steel (tower, carriage, arms, mount steelwork). Vertex colours. */
  paint: THREE.MeshStandardMaterial;
  /** Same paint for instanced lattice members (instance colours). */
  paintInst: THREE.MeshStandardMaterial;
  /** Bare / galvanised steel: rails, clamps, pipes, poles. Vertex colours. */
  steel: THREE.MeshStandardMaterial;
  /** Bare steel for instanced tubes (instance colours). */
  steelInst: THREE.MeshStandardMaterial;
  /** Stainless tank shells with ring welds. Vertex colours. */
  tank: THREE.MeshStandardMaterial;
  /** Apron concrete with slab joints. Vertex colours carry soot, vertex alpha the feathered edge. */
  concrete: THREE.MeshStandardMaterial;
  /** Cast-in-place concrete (legs, walls, footings). Vertex colours carry soot. */
  cast: THREE.MeshStandardMaterial;
  /** White painted tanks, roofs and fittings. Vertex colours. */
  white: THREE.MeshStandardMaterial;
  /** Painted sheet-metal walls of buildings and containers. Vertex colours. */
  cladding: THREE.MeshStandardMaterial;
  /** Perforated water-cooled deflector steel. Vertex colours carry soot. */
  plate: THREE.MeshStandardMaterial;
  /** Red aviation obstruction lights. */
  lights: THREE.MeshBasicMaterial;
  list(): THREE.Material[];
}

export function createPadMaterials(scope: SharedScope): PadMaterials {
  const concreteMap = scope.get(CONCRETE_KEY, makeConcreteTexture);
  const plateMap = scope.get(PLATE_KEY, makePlateTexture);
  const ringMap = scope.get(RING_STEEL_KEY, makeRingSteelTexture);
  const castMap = scope.get(CAST_KEY, makeCastConcreteTexture);
  const claddingMap = scope.get(CLADDING_KEY, makeCladdingTexture);

  const paint = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.62, metalness: 0.12 });
  paint.name = 'pad-paint';
  const paintInst = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.12 });
  paintInst.name = 'pad-paint-instanced';
  const steel = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0.85 });
  steel.name = 'pad-steel';
  const steelInst = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.8 });
  steelInst.name = 'pad-steel-instanced';
  const tank = new THREE.MeshStandardMaterial({ color: 0xffffff, map: ringMap, vertexColors: true, roughness: 0.34, metalness: 0.92 });
  tank.name = 'pad-tank';
  const concrete = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: concreteMap,
    vertexColors: true,
    roughness: 0.93,
    metalness: 0,
    transparent: true,
  });
  concrete.name = 'pad-concrete';
  const cast = new THREE.MeshStandardMaterial({ color: 0xffffff, map: castMap, vertexColors: true, roughness: 0.9, metalness: 0 });
  cast.name = 'pad-cast-concrete';
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.55, metalness: 0 });
  white.name = 'pad-white';
  const cladding = new THREE.MeshStandardMaterial({ color: 0xffffff, map: claddingMap, vertexColors: true, roughness: 0.6, metalness: 0.1 });
  cladding.name = 'pad-cladding';
  const plate = new THREE.MeshStandardMaterial({ color: 0xffffff, map: plateMap, vertexColors: true, roughness: 0.62, metalness: 0.45 });
  plate.name = 'pad-plate';
  const lights = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.025, 0.012), toneMapped: true });
  lights.name = 'pad-lights';

  const all = [paint, paintInst, steel, steelInst, tank, concrete, cast, white, cladding, plate, lights];
  return { paint, paintInst, steel, steelInst, tank, concrete, cast, white, cladding, plate, lights, list: () => all };
}

/** Painted-steel palette (sRGB hex). */
export const PAINT = {
  tower: 0x434446,
  towerDark: 0x313234,
  towerLight: 0x5a5b5e,
  rail: 0x939597,
  carriage: 0x3c3d3f,
  arm: 0x38393b,
  mountSteel: 0x88898a,
  mountDark: 0x58595b,
  clamp: 0x4b4c4e,
  yellow: 0xc9a227,
} as const;
