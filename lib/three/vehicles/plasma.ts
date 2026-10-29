import * as THREE from 'three';
import { PlumeVolume, newVolumeShape, type VolumeShape } from './plumes';

/**
 * Entry plasma: a glowing shock-layer sheath hugging the windward side plus a long ray-marched wake
 * trailing downstream. Both scale with `heating` and disappear at 0.
 * - Sheath: a closed hull of revolution inflated along its normals; the stand-off grows on the windward
 *   side (bow shock). Additive, brightest at grazing angles (fresnel) and where the flow hits head-on,
 *   orange-white near the stagnation region shading to pink.
 * - Wake: PlumeVolume oriented along the airflow, magenta to purple, turbulent.
 */

const SHEATH_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uFlow;
uniform float uStand;
varying vec3 vN;
varying vec3 vW;
varying float vWind;
varying vec3 vLoc;
void main() {
  vec3 n = normalize(normal);
  float w = dot(n, -uFlow);
  vec3 p = position + n * (0.12 + uStand * max(w, 0.0));
  vWind = w;
  vLoc = p;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const SHEATH_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uHeat;
uniform float uTime;
uniform sampler2D uNoise;
varying vec3 vN;
varying vec3 vW;
varying float vWind;
varying vec3 vLoc;
void main() {
  #include <logdepthbuf_fragment>
  vec3 V = normalize(cameraPosition - vW);
  float ndv = abs(dot(normalize(vN), V));
  // Thin shock layer: faint over the windward face, strong only where it is seen edge-on.
  float fres = pow(1.0 - ndv, 3.0);
  float wind = smoothstep(-0.2, 0.9, vWind);
  float a = atan(vLoc.x, vLoc.z) * 0.3183;
  float n = texture2D(uNoise, vec2(vLoc.y * 0.021 - uTime * 0.45, a + uTime * 0.03)).r;
  float n2 = texture2D(uNoise, vec2(vLoc.y * 0.07 + uTime * 0.9, a * 3.0)).g;
  float I = uHeat * pow(wind, 1.5) * (0.07 + 0.95 * fres) * (0.55 + 0.6 * n + 0.3 * n2);
  vec3 c = mix(vec3(0.95, 0.24, 0.72), vec3(1.0, 0.5, 0.32), smoothstep(0.45, 0.95, vWind));
  gl_FragColor = vec4(c * I * 1.5, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface PlasmaOptions {
  /** Hull silhouette (y, r), bottom to top. */
  profile: Array<{ y: number; r: number }>;
  length: number;
  radius: number;
  noise: THREE.Texture;
  steps: number;
}

export class Plasma {
  readonly group = new THREE.Group();
  private readonly sheath: THREE.Mesh;
  private readonly sheathGeo: THREE.BufferGeometry;
  private readonly sheathMat: THREE.ShaderMaterial;
  private readonly sheathU: {
    uFlow: { value: THREE.Vector3 };
    uStand: { value: number };
    uHeat: { value: number };
    uTime: { value: number };
    uNoise: { value: THREE.Texture };
  };
  private readonly wakePivot = new THREE.Group();
  private readonly wake: PlumeVolume;
  private readonly shape: VolumeShape = newVolumeShape();
  private readonly length: number;
  private readonly radius: number;
  private readonly flow = new THREE.Vector3();

  constructor(o: PlasmaOptions) {
    this.length = o.length;
    this.radius = o.radius;
    // Closed hull: cap the bottom, profile, round the top.
    const pts: THREE.Vector2[] = [new THREE.Vector2(0.001, o.profile[0].y - 0.4)];
    for (const p of o.profile) pts.push(new THREE.Vector2(p.r + 0.15, p.y));
    const last = o.profile[o.profile.length - 1];
    pts.push(new THREE.Vector2(0.001, last.y + 0.6));
    this.sheathGeo = new THREE.LatheGeometry(pts, 48);
    this.sheathGeo.computeVertexNormals();
    this.sheathU = {
      uFlow: { value: new THREE.Vector3(0, 0, -1) },
      uStand: { value: 1.6 },
      uHeat: { value: 0 },
      uTime: { value: 0 },
      uNoise: { value: o.noise },
    };
    this.sheathMat = new THREE.ShaderMaterial({
      uniforms: this.sheathU,
      vertexShader: SHEATH_VERT,
      fragmentShader: SHEATH_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    });
    this.sheath = new THREE.Mesh(this.sheathGeo, this.sheathMat);
    this.sheath.frustumCulled = false;
    this.sheath.renderOrder = 12;
    this.wake = new PlumeVolume(o.noise, o.steps);
    this.wakePivot.add(this.wake.mesh);
    this.group.add(this.sheath, this.wakePivot);
    this.group.visible = false;
  }

  setSteps(steps: number): void {
    this.wake.setSteps(steps);
  }

  /** Re-aims the camera-dependent part (the wake's ray march) at another view of the same frame. */
  setCamera(camera: THREE.Camera): void {
    if (this.group.visible) this.wake.updateCamera(camera);
  }

  update(heating: number, airflowBody: THREE.Vector3, t: number, camera: THREE.Camera): void {
    const h = Math.max(0, Math.min(1, heating));
    this.group.visible = h > 0.002;
    if (!this.group.visible) return;
    this.flow.copy(airflowBody);
    if (this.flow.lengthSq() < 1e-8) this.flow.set(0, -1, 0);
    this.flow.normalize();
    this.sheathU.uFlow.value.copy(this.flow);
    this.sheathU.uHeat.value = h;
    this.sheathU.uTime.value = t;
    this.sheathU.uStand.value = 0.5 + 0.6 * h;

    // Wake: from the body centre downstream; its width follows the cross-section the flow sees.
    const across = Math.sqrt(Math.max(0, 1 - this.flow.y * this.flow.y));
    this.wakePivot.position.set(0, this.length * 0.5, 0);
    this.wakePivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), this.flow);
    const s = this.shape;
    s.y0 = this.radius * 0.6;
    s.r0 = THREE.MathUtils.lerp(this.radius * 0.9, this.length * 0.24, across);
    s.tanA = 0.06;
    s.decay = 30 + this.length * 0.7;
    s.intensity = h * h * 0.16;
    s.saturation = 1.0;
    s.falloff = 1.6;
    s.fadeIn = this.radius;
    s.noise = 0.65;
    s.flicker = 2.4;
    s.sharp = 3.4;
    s.col0.setRGB(1.0, 0.42, 0.72);
    s.col1.setRGB(0.72, 0.24, 1.0);
    s.col2.setRGB(0.45, 0.16, 0.95);
    this.wake.setShape(s);
    this.wake.uniforms.uTime.value = t;
    this.wake.updateCamera(camera);
  }

  dispose(): void {
    this.sheathGeo.dispose();
    this.sheathMat.dispose();
    this.wake.dispose();
  }
}
