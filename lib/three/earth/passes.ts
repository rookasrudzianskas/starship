import * as THREE from 'three';
import { ENV_FRAGMENT, FULLSCREEN_VERTEX, VIEW_LUT_FRAGMENT } from './shaders/passes';
import type { SharedUniforms } from './uniforms';

/** A full-screen triangle (clip space) — shared by all passes. */
export function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}

/** Renders a GLSL3 RawShaderMaterial over a whole render target, preserving the renderer's state. */
export class FullscreenPass {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.RawShaderMaterial>;

  constructor(material: THREE.RawShaderMaterial) {
    this.mesh = new THREE.Mesh(fullscreenTriangle(), material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): void {
    const prevTarget = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget, prevFace, prevMip);
    renderer.xr.enabled = prevXr;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/**
 * The per-frame view table (see VIEW_LUT_PARAM_GLSL): three half-float colour attachments
 * (Rayleigh, Mie, transmittance; alphas carry multiple scattering).
 */
export class ViewLut {
  readonly target: THREE.WebGLRenderTarget;
  private readonly pass: FullscreenPass;
  readonly uniforms: { uMusCam: { value: number }; uSteps: { value: number } };

  constructor(shared: SharedUniforms, width: number, height: number) {
    this.target = new THREE.WebGLRenderTarget(width, height, {
      count: 3,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.uniforms = { uMusCam: { value: 0 }, uSteps: { value: 48 } };
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: VIEW_LUT_FRAGMENT,
      uniforms: {
        uAtmoRadii: shared.uAtmoRadii,
        uAtmoScale: shared.uAtmoScale,
        uRayleigh: shared.uRayleigh,
        uMie: shared.uMie,
        uOzone: shared.uOzone,
        uSun: shared.uSun,
        uSunShape: shared.uSunShape,
        uTransmittanceLut: shared.uTransmittanceLut,
        uTransmittanceSize: shared.uTransmittanceSize,
        uMsLut: shared.uMsLut,
        uMsSize: shared.uMsSize,
        uCam: shared.uCam,
        uCamInside: shared.uCamInside,
        uViewLutSize: shared.uViewLutSize,
        ...this.uniforms,
      },
      depthTest: false,
      depthWrite: false,
    });
    this.pass = new FullscreenPass(material);
    shared.uViewLutSize.value.set(width, height);
    shared.uViewLutR.value = this.target.textures[0];
    shared.uViewLutM.value = this.target.textures[1];
    shared.uViewLutT.value = this.target.textures[2];
  }

  render(renderer: THREE.WebGLRenderer): void {
    this.pass.render(renderer, this.target);
  }

  dispose(): void {
    this.pass.dispose();
    this.target.dispose();
  }
}

/**
 * Sky + ground radiance around the camera rendered into a small equirectangular map, prefiltered with
 * PMREMGenerator for scene.environment.
 */
export class EnvironmentProbe {
  private target: THREE.WebGLRenderTarget;
  private readonly pass: FullscreenPass;
  private readonly pmrem: THREE.PMREMGenerator;
  private pmremTarget: THREE.WebGLRenderTarget | null = null;
  private width: number;

  constructor(
    renderer: THREE.WebGLRenderer,
    shared: SharedUniforms,
    width: number,
  ) {
    this.width = width;
    this.target = EnvironmentProbe.makeTarget(width);
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: ENV_FRAGMENT,
      uniforms: { ...shared, uAlbedoLod: { value: 5 } },
      depthTest: false,
      depthWrite: false,
    });
    this.pass = new FullscreenPass(material);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
  }

  private static makeTarget(width: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(width, width / 2, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
      depthBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
  }

  setResolution(width: number): void {
    if (width === this.width) return;
    this.width = width;
    this.target.dispose();
    this.target = EnvironmentProbe.makeTarget(width);
    this.pmremTarget?.dispose();
    this.pmremTarget = null;
  }

  /** Re-render the probe; returns the prefiltered environment texture. */
  update(renderer: THREE.WebGLRenderer): THREE.Texture {
    this.pass.render(renderer, this.target);
    this.pmremTarget = this.pmrem.fromEquirectangular(this.target.texture, this.pmremTarget);
    return this.pmremTarget.texture;
  }

  get texture(): THREE.Texture | null {
    return this.pmremTarget?.texture ?? null;
  }

  dispose(): void {
    this.pass.dispose();
    this.target.dispose();
    this.pmremTarget?.dispose();
    this.pmrem.dispose();
  }
}
