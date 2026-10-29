import * as THREE from 'three';
import type { PadId } from '@/lib/sim/types';
import { seededRandom } from '@/lib/three/vehicles/procedural';

/**
 * Water deluge at the mount base: ballistic spray from the water-cooled plate (Pad 1) or from the trench
 * wedge out of both trench mouths (Pad 2), plus slow steam/mist. Instanced camera-facing sprites whose
 * motion is a pure function of `t`, so scrubbing works. Lit by the scene's sun and sky lights, which are
 * looked up at render time.
 */

const VERT = /* glsl */ `
attribute vec4 aSeed;
attribute float aType;
uniform float uTime;
uniform float uIntensity;
uniform float uMode;
varying vec2 vUv;
varying vec2 vNoiseUv;
varying float vAlpha;
varying float vShade;
#include <common>
#include <logdepthbuf_pars_vertex>

void main() {
  float spray = 1.0 - step(0.5, aType);
  float life = spray > 0.5 ? mix(1.3, 2.2, aSeed.w) : mix(4.0, 7.5, aSeed.w);
  float a01 = fract(uTime / life + aSeed.z);
  float age = a01 * life;
  float ang = aSeed.x * 6.2831853;
  vec3 p;
  float size;
  float side = aSeed.x < 0.5 ? -1.0 : 1.0;
  float zz = (fract(aSeed.x * 2.0) - 0.5) * 18.0;
  if (spray > 0.5) {
    vec3 base;
    vec3 vel;
    if (uMode < 0.5) {
      // Jets rising from the perforated plate, thrown slightly outward.
      float r = sqrt(aSeed.y) * 10.2;
      base = vec3(cos(ang) * r, 1.4, sin(ang) * r);
      vel = vec3(cos(ang), 0.0, sin(ang)) * mix(1.0, 5.0, aSeed.y) + vec3(0.0, mix(9.0, 17.5, fract(aSeed.w * 7.31)), 0.0);
    } else {
      // Water sheeting off the trench wedge toward the mouths.
      float xx = side * aSeed.y * 12.0;
      base = vec3(xx, 9.8 - abs(xx) * 0.37, zz);
      vel = vec3(side * mix(6.0, 15.0, fract(aSeed.w * 5.7)), mix(2.5, 8.0, fract(aSeed.w * 3.1)), (fract(aSeed.w * 9.7) - 0.5) * 3.0);
    }
    p = base + vel * age + vec3(0.0, -4.9, 0.0) * age * age;
    p.y = max(p.y, 0.6);
    size = mix(1.8, 6.5, a01) * mix(0.7, 1.3, aSeed.w);
    vAlpha = smoothstep(0.0, 0.1, a01) * (1.0 - smoothstep(0.45, 1.0, a01)) * 0.55;
  } else {
    if (uMode < 0.5) {
      float r = 7.0 + age * mix(2.5, 6.0, aSeed.y);
      p = vec3(cos(ang) * r, 1.2 + age * mix(0.8, 2.4, aSeed.y), sin(ang) * r);
    } else {
      p = vec3(side * (20.0 + age * mix(4.0, 9.0, aSeed.y)), 2.0 + age * mix(0.8, 2.2, aSeed.y), zz * (1.0 + age * 0.15));
    }
    size = mix(6.0, 19.0, a01) * mix(0.8, 1.25, aSeed.w);
    vAlpha = smoothstep(0.0, 0.2, a01) * (1.0 - smoothstep(0.4, 1.0, a01)) * 0.26;
  }
  vAlpha *= uIntensity;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float rot = aSeed.z * 6.2831853 + age * 0.4 * (aSeed.y - 0.5);
  vec2 c = position.xy;
  vec2 rc = vec2(c.x * cos(rot) - c.y * sin(rot), c.x * sin(rot) + c.y * cos(rot));
  mv.xy += rc * size;
  gl_Position = projectionMatrix * mv;
  vUv = c + 0.5;
  vNoiseUv = rc * 0.3 + aSeed.xy * 7.0;
  // Screen-space up is roughly toward the sky: brighter tops.
  vShade = clamp(0.5 + rc.y, 0.0, 1.0);
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
uniform sampler2D uSprite;
uniform sampler2D uNoise;
uniform vec3 uSun;
uniform vec3 uSky;
varying vec2 vUv;
varying vec2 vNoiseUv;
varying float vAlpha;
varying float vShade;
#include <common>
#include <logdepthbuf_pars_fragment>

void main() {
  #include <logdepthbuf_fragment>
  float a = texture2D(uSprite, vUv).a;
  float n = texture2D(uNoise, vNoiseUv * 0.25).r;
  a *= vAlpha * (0.35 + 0.9 * n);
  if (a < 0.004) discard;
  vec3 albedo = vec3(0.88, 0.9, 0.93);
  vec3 col = albedo * (uSky * 0.8 + uSun * (0.28 + 0.22 * vShade));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface Deluge {
  mesh: THREE.Mesh;
  update(t: number, intensity: number): void;
  setCount(n: number): void;
  dispose(): void;
}

export function createDeluge(pad: PadId, maxCount: number, sprite: THREE.Texture, noise: THREE.Texture): Deluge {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  const seeds = new Float32Array(maxCount * 4);
  const types = new Float32Array(maxCount);
  const rnd = seededRandom(pad === 'pad1' ? 4242 : 4343);
  for (let i = 0; i < maxCount; i++) {
    seeds[i * 4] = rnd();
    seeds[i * 4 + 1] = rnd();
    seeds[i * 4 + 2] = rnd();
    seeds[i * 4 + 3] = rnd();
    // Interleaved so a reduced instance count keeps the spray/mist ratio.
    types[i] = i % 10 < 7 ? 0 : 1;
  }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.setAttribute('aType', new THREE.InstancedBufferAttribute(types, 1));
  geo.instanceCount = maxCount;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 10, 0), pad === 'pad1' ? 55 : 80);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uMode: { value: pad === 'pad1' ? 0 : 1 },
      uSprite: { value: sprite },
      uNoise: { value: noise },
      uSun: { value: new THREE.Vector3(3, 3, 3) },
      uSky: { value: new THREE.Vector3(0.6, 0.65, 0.72) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    // View-space billboards under the pad's mirrored (scale.z = -1) group: render both windings.
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'deluge';
  mesh.visible = false;
  mesh.renderOrder = 2;

  // Pick up the scene's sun and sky lights when rendered (cached until they leave the scene).
  let sun: THREE.DirectionalLight | null = null;
  let sky: THREE.HemisphereLight | null = null;
  let framesUntilSearch = 0;
  const col = new THREE.Color();
  mesh.onBeforeRender = (_r, scene) => {
    const lost = !sun || !sun.parent || !sky || !sky.parent;
    // Re-scan the scene for lights only occasionally while one is missing.
    if (lost && framesUntilSearch-- <= 0) {
      framesUntilSearch = 60;
      sun = null;
      sky = null;
      scene.traverse((o) => {
        if (!sun && (o as THREE.DirectionalLight).isDirectionalLight) sun = o as THREE.DirectionalLight;
        if (!sky && (o as THREE.HemisphereLight).isHemisphereLight) sky = o as THREE.HemisphereLight;
      });
    }
    const u = mat.uniforms;
    const s = sun as THREE.DirectionalLight | null;
    const h = sky as THREE.HemisphereLight | null;
    if (s) {
      col.copy(s.color).multiplyScalar(s.intensity);
      (u.uSun.value as THREE.Vector3).set(col.r, col.g, col.b);
    }
    if (h) {
      col.copy(h.color).lerp(h.groundColor, 0.35).multiplyScalar(h.intensity);
      (u.uSky.value as THREE.Vector3).set(col.r, col.g, col.b);
    }
  };

  return {
    mesh,
    update(t: number, intensity: number) {
      mat.uniforms.uTime.value = t;
      mat.uniforms.uIntensity.value = THREE.MathUtils.clamp(intensity, 0, 1);
      mesh.visible = intensity > 0.002;
    },
    setCount(n: number) {
      geo.instanceCount = Math.max(0, Math.min(maxCount, Math.round(n)));
    },
    dispose() {
      quad.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}
