import * as THREE from 'three';
import {
  ATMOSPHERE_HEIGHT,
  type AtmosphereParams,
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
import type { AtmosphereTextures } from './resources';
import { WAVE_COUNT } from './waves';

/**
 * Uniform objects shared by every Earth material. Materials reference the same `{ value }` objects, so one
 * update per frame reaches all of them.
 */
export function createSharedUniforms(params: AtmosphereParams, luts: AtmosphereTextures, placeholder: THREE.Texture) {
  return {
    // Atmosphere (ATMOSPHERE_GLSL)
    uAtmoRadii: { value: new THREE.Vector4(R_GROUND, R_TOP, H_TOP, H_TOP * H_TOP) },
    uAtmoScale: {
      value: new THREE.Vector4(params.rayleighScaleHeight, params.mieScaleHeight, params.ozoneCenter, params.ozoneHalfWidth),
    },
    uRayleigh: { value: new THREE.Vector3(...params.rayleighScattering) },
    uMie: { value: new THREE.Vector4(params.mieScattering, params.mieExtinction, params.mieG, params.groundAlbedo) },
    uOzone: { value: new THREE.Vector3(...params.ozoneAbsorption) },
    uSun: { value: new THREE.Vector4(1, 0, 0, params.sunIlluminance) },
    uSunShape: { value: new THREE.Vector2(SUN_ANGULAR_RADIUS, SHADOW_SOFTNESS) },
    uTransmittanceLut: { value: luts.transmittance as THREE.Texture },
    uTransmittanceSize: { value: new THREE.Vector2(...TRANSMITTANCE_SIZE) },
    uMsLut: { value: luts.multipleScattering as THREE.Texture },
    uMsSize: { value: new THREE.Vector2(...MS_SIZE) },
    // Camera (VIEW_LUT_PARAM_GLSL / VIEW_LOOKUP_GLSL)
    uCam: { value: new THREE.Vector4(R_GROUND + 2, 2, 2 * (2 * R_GROUND + 2), 0) },
    uCamInside: { value: 1 },
    uCamUp: { value: new THREE.Vector3(1, 0, 0) },
    uViewLutSize: { value: new THREE.Vector2(32, 128) },
    uViewLutR: { value: placeholder as THREE.Texture },
    uViewLutM: { value: placeholder as THREE.Texture },
    uViewLutT: { value: placeholder as THREE.Texture },
    uEarthCenter: { value: new THREE.Vector3(-R_GROUND, 0, 0) },
    // Surface (SURFACE_GLSL)
    uDayTex: { value: placeholder as THREE.Texture },
    uNightTex: { value: placeholder as THREE.Texture },
    uWaterTex: { value: placeholder as THREE.Texture },
    uTexReady: { value: 0 },
    uGroundIrradiance: { value: luts.groundIrradiance as THREE.Texture },
    uGroundIrradianceRange: { value: new THREE.Vector3(IRRADIANCE_MU_RANGE[0], IRRADIANCE_MU_RANGE[1], IRRADIANCE_SIZE) },
    // x: albedo scale, y: water slope variance (Cox–Munk: 0.003 + 0.00512·wind, ≈ 3.5 m/s), z: city lights,
    // w: night ambient (fraction of the solar irradiance)
    uSurface: { value: new THREE.Vector4(1.0, 0.02, 0.8, 2e-5) },
    uGlintStrength: { value: 0.2 },
    uWaterAlbedo: { value: new THREE.Vector3(0.004, 0.012, 0.022) },
    uCityColour: { value: new THREE.Vector3(1.0, 0.72, 0.42) },
    // Wind waves (WAVES_GLSL, waves.ts): wave vectors and amplitudes, phases at the camera, and
    // x: strength (fades out with the camera's altitude), y: slope variance of the set
    uWaveK: { value: new Float32Array(WAVE_COUNT * 4) },
    uWavePhase: { value: new Float32Array(WAVE_COUNT) },
    uWaveParams: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
}

export type SharedUniforms = ReturnType<typeof createSharedUniforms>;

export function applyAtmosphereParams(u: SharedUniforms, params: AtmosphereParams): void {
  u.uAtmoScale.value.set(params.rayleighScaleHeight, params.mieScaleHeight, params.ozoneCenter, params.ozoneHalfWidth);
  u.uRayleigh.value.set(...params.rayleighScattering);
  u.uMie.value.set(params.mieScattering, params.mieExtinction, params.mieG, params.groundAlbedo);
  u.uOzone.value.set(...params.ozoneAbsorption);
  u.uSun.value.w = params.sunIlluminance;
}

export { ATMOSPHERE_HEIGHT };
