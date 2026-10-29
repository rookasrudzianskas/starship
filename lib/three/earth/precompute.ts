import * as THREE from 'three';
import {
  type AtmosphereParams,
  type AtmosphereTables,
  H_TOP,
  IRRADIANCE_MU_RANGE,
  IRRADIANCE_SIZE,
  MS_SIZE,
  R_GROUND,
  R_TOP,
  SHADOW_SOFTNESS,
  SUN_ANGULAR_RADIUS,
  TRANSMITTANCE_SIZE,
} from './atmosphere';
import { FullscreenPass } from './passes';
import { lutTexture } from './resources';
import { FULLSCREEN_VERTEX } from './shaders/passes';
import { IRRADIANCE_FRAGMENT, MS_FRAGMENT, TRANSMITTANCE_FRAGMENT } from './shaders/precompute';

function rgbaToRgb(rgba: Float32Array): Float32Array {
  const n = rgba.length / 4;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = rgba[i * 4];
    out[i * 3 + 1] = rgba[i * 4 + 1];
    out[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return out;
}

/**
 * Compute the atmosphere tables on the GPU (a few ms) and read them back, so the CPU and the shaders share
 * them. Returns null when float render targets are unavailable (the caller falls back to the CPU).
 */
export function computeTablesGpu(renderer: THREE.WebGLRenderer, params: AtmosphereParams): AtmosphereTables | null {
  if (!renderer.extensions.has('EXT_color_buffer_float')) return null;
  const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  blank.needsUpdate = true;
  const uniforms = {
    uAtmoRadii: { value: new THREE.Vector4(R_GROUND, R_TOP, H_TOP, H_TOP * H_TOP) },
    uAtmoScale: {
      value: new THREE.Vector4(params.rayleighScaleHeight, params.mieScaleHeight, params.ozoneCenter, params.ozoneHalfWidth),
    },
    uRayleigh: { value: new THREE.Vector3(...params.rayleighScattering) },
    uMie: { value: new THREE.Vector4(params.mieScattering, params.mieExtinction, params.mieG, params.groundAlbedo) },
    uOzone: { value: new THREE.Vector3(...params.ozoneAbsorption) },
    uSun: { value: new THREE.Vector4(0, 0, 1, params.sunIlluminance) },
    uSunShape: { value: new THREE.Vector2(SUN_ANGULAR_RADIUS, SHADOW_SOFTNESS) },
    uTransmittanceLut: { value: blank as THREE.Texture },
    uTransmittanceSize: { value: new THREE.Vector2(...TRANSMITTANCE_SIZE) },
    uMsLut: { value: blank as THREE.Texture },
    uMsSize: { value: new THREE.Vector2(...MS_SIZE) },
    uIrradianceRange: { value: new THREE.Vector3(IRRADIANCE_MU_RANGE[0], IRRADIANCE_MU_RANGE[1], IRRADIANCE_SIZE) },
  };
  const run = (fragment: string, w: number, h: number): Float32Array => {
    const target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
    });
    const pass = new FullscreenPass(
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: fragment,
        uniforms,
        depthTest: false,
        depthWrite: false,
      }),
    );
    pass.render(renderer, target);
    const rgba = new Float32Array(w * h * 4);
    renderer.readRenderTargetPixels(target, 0, 0, w, h, rgba);
    pass.dispose();
    target.dispose();
    return rgbaToRgb(rgba);
  };

  const transmittance = run(TRANSMITTANCE_FRAGMENT, ...TRANSMITTANCE_SIZE);
  const tTex = lutTexture(transmittance, ...TRANSMITTANCE_SIZE);
  uniforms.uTransmittanceLut.value = tTex;
  const multipleScattering = run(MS_FRAGMENT, ...MS_SIZE);
  const mTex = lutTexture(multipleScattering, ...MS_SIZE);
  uniforms.uMsLut.value = mTex;
  const groundIrradiance = run(IRRADIANCE_FRAGMENT, IRRADIANCE_SIZE, 1);
  tTex.dispose();
  mTex.dispose();
  blank.dispose();

  // A failed pass reads back zeros or NaNs; let the caller fall back to the CPU tables.
  const ok = Number.isFinite(transmittance[0]) && transmittance[0] > 0 && Number.isFinite(multipleScattering[3]);
  return ok ? { transmittance, multipleScattering, groundIrradiance } : null;
}
