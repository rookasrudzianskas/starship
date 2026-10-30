import * as THREE from 'three';
import { EARTH_RADIUS, type PadId } from '@/lib/sim/types';
import { PADS } from '@/lib/flights/catalog';
import type { Earth, EarthFrame, EarthOptions, Quality } from '@/lib/three/contracts';
import { ATMOSPHERE_HEIGHT, AtmosphereModel, type AtmosphereParams, DEFAULT_ATMOSPHERE, miePhase, rayleighPhase } from './atmosphere';
import { greenwichSiderealTime } from './ephemeris';
import { latLonToEcef, enuToEcefRotation } from './geo';
import { buildPatchGeometry, createGlobeMesh, createPatchMaterial, createStars, GLOBE_RENDER_ORDER, PATCH_LAYOUT } from './layers';
import {
  type DayLevel,
  dayImage,
  type EarthManifest,
  loadImage,
  loadManifest,
  type PatchId,
  releaseImage,
} from './imagery';
import { EnvironmentProbe, ViewLut } from './passes';
import { computeTablesGpu } from './precompute';
import { createAtmosphereTextures, type ImageTextureOptions, placeholderTexture, TextureStreamer } from './resources';
import { toneMapColour } from './tonemap';
import { applyAtmosphereParams, createSharedUniforms } from './uniforms';
import { makeWaves, wavePhases } from './waves';
import { dataTexture, generatedOnce, NOISE_KEY, prefetchGenerated } from '@/lib/three/vehicles/procedural';
import { noisePixels } from '@/lib/three/vehicles/pixels';

export { sunDirectionEcef, greenwichSiderealTime } from './ephemeris';
export { latLonToEcef, ecefToLatLon, enuBasis, enuToEcefRotation } from './geo';
export { DEFAULT_ATMOSPHERE, type AtmosphereParams } from './atmosphere';
export type { EarthManifest } from './imagery';

type RGB = [number, number, number];

/** Distance of sunLight from its target along the Sun direction (m). Only the direction matters. */
export const SUN_LIGHT_DISTANCE = 1000;

/** The Starbase patch fades out between these camera distances from the pad (m). */
const PATCH_FADE: [number, number] = [1_500_000, 2_500_000];

const QUALITY = {
  high: { lutSteps: 40, envWidth: 256, envInterval: 250 },
  low: { lutSteps: 20, envWidth: 128, envInterval: 1000 },
} as const;

const VIEW_LUT_SIZE: [number, number] = [48, 160];
/** Weight of direct sunlight in the exposure meter: a 5.7° sun at sea level meters about 1.3×, not 3.8×. */
const SUN_METER_WEIGHT = 0.03;
/** From this camera altitude the globe imagery fills much of the view: worth the 8K day texture where affordable. */
const DETAIL_ALTITUDE = 50_000;
/** Wind waves on the water fade out between these camera altitudes (m): above, no pixel resolves them. */
const WAVE_ALTITUDE: [number, number] = [4000, 9000];

/** Component of uPatchTexel for each ground patch. */
const PATCH_INDEX: Record<PatchId, number> = { pad: 0, mid: 1, wide: 2 };

/** Sharpness order of the day textures. */
const DAY_RANK: Record<DayLevel, number> = { preview: 0, low: 1, high: 2 };

/**
 * The 8K day texture takes 170 MB of video memory with its mips (the 4K 43 MB), so only desktops get it: never
 * with a coarse (touch) primary pointer, 4 GB of memory or less, or a texture size limit below 8192.
 */
function affords8k(renderer: THREE.WebGLRenderer): boolean {
  if (renderer.capabilities.maxTextureSize < 8192) return false;
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return false;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return memory === undefined || memory > 4;
}

/** Run in a task of its own once the main thread is idle (requestIdleCallback is missing in Safari). */
function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 200 });
  else setTimeout(fn, 0);
}

export interface EarthDebug {
  readonly params: AtmosphereParams;
  /** Change atmosphere parameters (recomputes the tables: a few ms on the GPU). */
  setAtmosphere(p: Partial<AtmosphereParams>): void;
  /** Shader knobs: x albedo scale, y water slope variance, z city lights, w night ambient. */
  readonly surface: THREE.Vector4;
  /** Sun glint strength (1 = physical). */
  readonly glint: { value: number };
  /** Strength of the sub-texel detail on the ground around the pad (0 = off). */
  readonly groundDetail: { value: number };
  readonly stats: { updateMs: number; envRefreshes: number; envMs: number; lastEnvAt: number };
  readonly manifest: () => EarthManifest | null;
  /** Which imagery is on the GPU: the day texture's level, and whether the city lights and water mask are in. */
  readonly imagery: () => { day: DayLevel | null; night: boolean; water: boolean; patches: number };
  /** Force an environment-map refresh on the next update. */
  refreshEnvironment(): void;
  /** The CPU-side atmosphere model (tables shared with the shaders). */
  readonly model: () => AtmosphereModel;
}

export interface EarthHandle extends Earth {
  /**
   * Suggested renderer.toneMappingExposure for the light level around the camera (1 in daylight, up to 16 in
   * twilight and night) — optional eye adaptation for the stage; smooth it over ~1 s. Updated a few times a second.
   */
  readonly exposureHint: number;
  readonly debug: EarthDebug;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Earth, atmosphere, sky, Sun, stars and lighting for the camera-relative stage.
 *
 * - `object` holds a full-screen globe/sky pass (analytic sphere, renders first and writes log depth), the
 *   Starbase ground patch (local-origin mesh, faded with distance) and the star field.
 * - `sunLight`: colour × intensity = solar irradiance after the atmosphere at the camera (0 in the Earth's
 *   shadow). Its target is a child of the light, so after `update()` the stage may translate
 *   `sunLight.position` by the focused vehicle's camera-relative position (and set up shadows) without
 *   changing the light direction.
 * - `skyLight`: hemisphere irradiance from the sky above and the ground below the camera. Note that
 *   `scene.environment` (PMREM of the same sky) also lights PBR materials diffusely; see the report.
 * - `update()` also drives `scene.fog` (FogExp2 matched to the local extinction and haze colour) and
 *   `scene.environment`. Call it before each render with a different camera (e.g. a picture-in-picture view).
 */
export function createEarth(options: EarthOptions): EarthHandle {
  const { renderer, scene } = options;
  let quality: Quality = options.quality;
  let pad = PADS[options.pad];
  const params: AtmosphereParams = { ...DEFAULT_ATMOSPHERE };
  // Tables on the GPU (read back for the CPU-side lighting), or on the CPU without float render targets.
  let model = new AtmosphereModel(params, computeTablesGpu(renderer, params) ?? undefined);

  const placeholder = placeholderTexture([0, 0, 0, 255]);
  let luts = createAtmosphereTextures(model);
  const shared = createSharedUniforms(params, luts, placeholder);
  const waves = makeWaves();
  shared.uWaveK.value.set(waves.k);
  shared.uWaveParams.value.y = waves.slopeVariance;
  const viewLut = new ViewLut(shared, VIEW_LUT_SIZE[0], VIEW_LUT_SIZE[1]);
  viewLut.uniforms.uSteps.value = QUALITY[quality].lutSteps;
  const env = new EnvironmentProbe(renderer, shared, QUALITY[quality].envWidth);

  const object = new THREE.Group();
  object.name = 'earth';
  const globe = createGlobeMesh(shared);
  object.add(globe.mesh);
  const stars = createStars(shared);
  object.add(stars.points);
  const detailGrey = placeholderTexture([128, 128, 128, 128]);
  const patch = createPatchMaterial(shared, placeholder, detailGrey);
  let detailTex: THREE.Texture | null = null;
  let patchMesh: THREE.Mesh | null = null;
  let padEcef = latLonToEcef(pad.lat, pad.lon, 0);
  const padRotation = new THREE.Quaternion().setFromRotationMatrix(enuToEcefRotation(pad.lat, pad.lon));

  // Lights ----------------------------------------------------------------------------------------------
  const sunLight = new THREE.DirectionalLight(0xffffff, params.sunIlluminance);
  sunLight.name = 'earth-sun';
  sunLight.add(sunLight.target);
  const skyLight = new THREE.HemisphereLight(0x8fb4e8, 0x40382e, 1);
  skyLight.name = 'earth-sky';

  // Fog ---------------------------------------------------------------------------------------------------
  const fog = new THREE.FogExp2(0xa0b8d0, 0);
  scene.fog = fog;
  const fogLinear: RGB = [0.5, 0.6, 0.7];
  const fogDisplay: RGB = [0.5, 0.6, 0.7];
  // three mixes fog after tone mapping when drawing straight to the canvas, and in linear HDR when drawing to a
  // render target (post-processing). The globe pass is the first opaque draw, so pick the right variant there.
  globe.mesh.onBeforeRender = (r) => {
    if (scene.fog !== fog) return;
    const c = r.getRenderTarget() === null ? toneMapColour(r, fogLinear, fogDisplay) : fogLinear;
    fog.color.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  };

  // State ---------------------------------------------------------------------------------------------------
  const tmp: { sunT: RGB; meterT: RGB; up: RGB; down: RGB; dens: RGB; ext: RGB; ms: RGB } = {
    sunT: [1, 1, 1],
    meterT: [1, 1, 1],
    ms: [0, 0, 0],
    up: [0, 0, 0],
    down: [0, 0, 0],
    dens: [0, 0, 0],
    ext: [0, 0, 0],
  };
  const hemi = { up: [0.3, 0.4, 0.6] as RGB, down: [0.1, 0.1, 0.1] as RGB };
  const sunVec = new THREE.Vector3(1, 0, 0);
  const upVec = new THREE.Vector3(1, 0, 0);
  const forward = new THREE.Vector3();
  const starRot = new THREE.Matrix3();
  const envState = { last: -Infinity, h: NaN, sun: new THREE.Vector3(), up: new THREE.Vector3(), force: true };
  const stats = { updateMs: 0, envRefreshes: 0, envMs: 0, lastEnvAt: 0 };
  let manifest: EarthManifest | null = null;
  let exposureHint = 1;
  let disposed = false;
  const abort = new AbortController();
  const textures: {
    day: { level: DayLevel; texture: THREE.Texture } | null;
    night: THREE.Texture | null;
    water: THREE.Texture | null;
    patches: Partial<Record<PatchId | 'water', THREE.Texture>>;
  } = { day: null, night: null, water: null, patches: {} };

  // Imagery -------------------------------------------------------------------------------------------------
  // The opening view (ground patches around the pad and a small globe) gates `ready`. The full-resolution globe
  // streams in straight after, and the 8K day texture only once the camera is high enough to see the difference.
  // Every texture is uploaded in bands under a per-frame budget (TextureStreamer), so loading never stalls a frame.
  const streamer = new TextureStreamer(renderer);
  const aniso = Math.min(renderer.capabilities.getMaxAnisotropy(), 16);
  const DAY: ImageTextureOptions = { srgb: true, repeatS: true, anisotropy: aniso };
  const MASK: ImageTextureOptions = { srgb: false, single: true, repeatS: true, anisotropy: aniso };
  const PATCH: ImageTextureOptions = { srgb: true, anisotropy: aniso };
  const PATCH_MASK: ImageTextureOptions = { srgb: false, anisotropy: aniso };
  const can8k = affords8k(renderer);

  // Ground detail around the pad: the shared tiling noise, made in the procedural-texture worker (on the main thread
  // only if that is unavailable), uploaded here with mipmaps and anisotropic filtering of its own.
  prefetchGenerated().then(() => {
    if (disposed) return;
    const pixels = generatedOnce(NOISE_KEY, noisePixels);
    const mean = [0, 0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 4; c++) mean[c] += pixels[i + c];
    const texels = (pixels.length / 4) * 255;
    patch.uniforms.uDetailMean.value.set(mean[0] / texels, mean[1] / texels, mean[2] / texels, mean[3] / texels);
    detailTex = dataTexture(pixels, 256, 256, { srgb: false, repeat: true, mipmaps: true, anisotropy: aniso });
    detailTex.name = 'earth-ground-detail';
    patch.uniforms.uDetailTex.value = detailTex;
  });
  /** The opening imagery has settled: the full-resolution globe may follow. */
  let opened = false;
  /** The camera has been above DETAIL_ALTITUDE (the 8K then stays, wherever it goes). */
  let detailWanted = false;
  let dayLoading = false;
  const dayFailed = new Set<DayLevel>();

  /** Download, decode and stream one image to the GPU; null if the Earth is disposed meanwhile. */
  const loadTexture = async (file: string, opts: ImageTextureOptions): Promise<THREE.Texture | null> => {
    const image = await loadImage(file, abort.signal);
    if (disposed) {
      releaseImage(image);
      return null;
    }
    const tex = await streamer.upload(image, opts);
    if (tex && disposed) {
      tex.dispose();
      return null;
    }
    return tex;
  };

  /** The day texture for the quality and the view (the manifest's best match). */
  const dayGoal = (m: EarthManifest): DayLevel =>
    dayImage(m, quality === 'high' && can8k && detailWanted ? 'high' : 'low').quality;

  const bindDay = (level: DayLevel, texture: THREE.Texture) => {
    const old = textures.day;
    textures.day = { level, texture };
    shared.uDayTex.value = texture;
    shared.uTexReady.value = 1;
    envState.force = true;
    // Only one day texture stays on the GPU (the 8K replaces the 4K, and the other way round).
    old?.texture.dispose();
  };

  /** Load the day texture the quality and view call for (one at a time), then drop the one it replaces. */
  const syncDay = () => {
    const m = manifest;
    if (disposed || !m || !opened || dayLoading) return;
    const level = dayGoal(m);
    if (textures.day?.level === level || dayFailed.has(level)) return;
    const { file } = dayImage(m, level);
    dayLoading = true;
    loadTexture(file, DAY).then(
      (tex) => {
        dayLoading = false;
        if (!tex) return;
        // Keep it if it is still the goal, or at least a step towards it from what is bound now.
        const goal = dayGoal(m);
        const bound = textures.day ? DAY_RANK[textures.day.level] : -1;
        if (level === goal || (DAY_RANK[level] > bound && DAY_RANK[level] < DAY_RANK[goal])) bindDay(level, tex);
        else tex.dispose();
        syncDay();
      },
      (err: unknown) => {
        dayLoading = false;
        if (disposed) return;
        dayFailed.add(level);
        console.warn(`Earth: ${file} failed to load`, err);
        syncDay();
      },
    );
  };

  /** City lights or the water mask (one channel each), after the opening view. */
  const loadMask = (file: string, key: 'night' | 'water') => {
    loadTexture(file, MASK).then(
      (tex) => {
        if (!tex) return;
        textures[key] = tex;
        (key === 'night' ? shared.uNightTex : shared.uWaterTex).value = tex;
        envState.force = true;
      },
      (err: unknown) => {
        if (!disposed) console.warn(`Earth: ${file} failed to load`, err);
      },
    );
  };

  /** The ground patch mesh. It stays hidden until its imagery is in (see update), and the globe draws that ground. */
  const buildPatch = (m: EarthManifest) => {
    const texel = patch.uniforms.uPatchTexel.value;
    for (const p of m.patches) texel.setComponent(PATCH_INDEX[p.id], p.groundMetresPerPixel);
    const geometry = buildPatchGeometry(pad.lat, pad.lon, pad.groundAlt, m.patches, PATCH_LAYOUT);
    patchMesh = new THREE.Mesh(geometry, patch.material);
    patchMesh.name = 'earth-starbase-ground';
    patchMesh.renderOrder = GLOBE_RENDER_ORDER + 1;
    patchMesh.quaternion.copy(padRotation);
    patchMesh.visible = false;
    object.add(patchMesh);
  };

  const ready: Promise<void> = (async () => {
    const m = await loadManifest();
    if (disposed) return;
    manifest = m;
    // Its geometry takes from a few to tens of milliseconds: build it in a task of its own while the imagery
    // streams in, rather than in the caller's frame or the one the imagery completes in.
    whenIdle(() => {
      if (!disposed && !patchMesh) buildPatch(m);
    });
    const preview = dayImage(m, 'preview');
    const settled = await Promise.allSettled([
      loadTexture(preview.file, DAY),
      m.patchWater ? loadTexture(m.patchWater.file, PATCH_MASK) : Promise.resolve(null),
      ...m.patches.map((p) => loadTexture(p.file, PATCH)),
    ]);
    const [day, water, ...patches] = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
    if (disposed) {
      [day, water, ...patches].forEach((t) => t?.dispose());
      return;
    }
    if (day) bindDay(preview.quality, day);

    // Ground patch imagery around the pad.
    if (!patchMesh) buildPatch(m);
    const tp = textures.patches;
    m.patches.forEach((p, i) => {
      const t = patches[i];
      if (t) tp[p.id] = t;
    });
    if (water) tp.water = water;
    patch.uniforms.uPatchPad.value = tp.pad ?? placeholder;
    patch.uniforms.uPatchMid.value = tp.mid ?? placeholder;
    patch.uniforms.uPatchWide.value = tp.wide ?? placeholder;
    patch.uniforms.uPatchWater.value = tp.water ?? placeholder;
    patch.uniforms.uPatchParams.value.w = tp.pad && tp.mid && tp.wide ? 1 : 0;
    envState.force = true;
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  })();
  ready.catch((err: unknown) => {
    if (!disposed) console.error('Earth: imagery failed to load; showing the globe without it.', err);
  });
  // Then the full-resolution globe, whatever became of the opening imagery.
  ready
    .catch(() => {})
    .then(() => {
      if (disposed || !manifest) return;
      opened = true;
      syncDay();
      loadMask(manifest.globe.water.file, 'water');
      loadMask(manifest.globe.night.file, 'night');
    });

  // Per-frame update ------------------------------------------------------------------------------------------
  const refreshLighting = (h: number, mus: number) => {
    // Hemisphere light: irradiance from the sky above and the ground below (average albedo ~0.1).
    model.cameraIrradiance(h, mus, [0.09, 0.1, 0.09], tmp.up, tmp.down);
    for (let c = 0; c < 3; c++) {
      hemi.up[c] = tmp.up[c] * params.sunIlluminance;
      hemi.down[c] = tmp.down[c] * params.sunIlluminance;
    }
    skyLight.color.setRGB(hemi.up[0], hemi.up[1], hemi.up[2], THREE.LinearSRGBColorSpace);
    skyLight.groundColor.setRGB(hemi.down[0], hemi.down[1], hemi.down[2], THREE.LinearSRGBColorSpace);
    skyLight.intensity = 1;
    // Mean radiance of the surroundings, (E↑ + E↓) / 2π; daylight ≈ 0.2 scene units.
    const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const mean = (lum(hemi.up) + lum(hemi.down)) / (2 * Math.PI);
    // Plus the direct sunlight at the camera: anything in the frame that faces the Sun is lit by it, so a low
    // Sun or the black sky of space must not brighten the view. Only twilight and night do.
    model.sunTransmittanceAt(h, mus, tmp.meterT);
    const direct = SUN_METER_WEIGHT * params.sunIlluminance * lum(tmp.meterT);
    exposureHint = Math.min(Math.max(0.2 / Math.max(mean + direct, 1e-6), 1), 16);
  };

  const updateFog = (h: number, nu: number, mus: number) => {
    // Haze colour: radiance of an optically thick layer of the local air in the view direction,
    // L∞ = (sunlight scattered towards the camera + ambient sky/ground light scattered isotropically) / σt.
    model.density(h, tmp.dens);
    model.extinction(tmp.dens, tmp.ext);
    const pr = rayleighPhase(nu);
    const pm = Math.min(miePhase(nu, params.mieG), 1.5);
    model.multipleScatteringAt(h, mus, tmp.ms);
    for (let c = 0; c < 3; c++) {
      const sR = params.rayleighScattering[c] * tmp.dens[0];
      const sM = params.mieScattering * tmp.dens[1];
      const sun = tmp.sunT[c] * (sR * pr + sM * pm);
      fogLinear[c] = (params.sunIlluminance * (sun + (sR + sM) * tmp.ms[c])) / Math.max(tmp.ext[c], 1e-12);
    }
    // FogExp2 is 1 − exp(−(ρd)²); match the physical 1 − exp(−σd) at its half-way distance: ρ = σ / √ln 2.
    fog.density = tmp.ext[1] / Math.sqrt(Math.LN2);
    const c = renderer.getRenderTarget() === null ? toneMapColour(renderer, fogLinear, fogDisplay) : fogLinear;
    fog.color.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  };

  const update = (frame: EarthFrame) => {
    if (disposed) return;
    const t0 = performance.now();
    const cam = frame.cameraEcef;
    const r = Math.hypot(cam[0], cam[1], cam[2]);
    const h = Math.max(r - EARTH_RADIUS, 0.5);
    const rc = EARTH_RADIUS + h;
    const rho2 = h * (2 * EARTH_RADIUS + h);
    upVec.set(cam[0] / r, cam[1] / r, cam[2] / r);
    sunVec.copy(frame.sunDir).normalize();
    const mus = sunVec.dot(upVec);

    if (!detailWanted && h > DETAIL_ALTITUDE) {
      detailWanted = true;
      syncDay();
    }

    // Waves: phases at the camera (float64 here, see waves.ts), only while it is low enough to resolve them.
    wavePhases(waves, cam, frame.time, shared.uWavePhase.value);
    shared.uWaveParams.value.x = 1 - smoothstep(WAVE_ALTITUDE[0], WAVE_ALTITUDE[1], h);

    shared.uCam.value.set(rc, h, rho2, -Math.sqrt(rho2) / rc);
    shared.uCamInside.value = h < ATMOSPHERE_HEIGHT ? 1 : 0;
    shared.uCamUp.value.copy(upVec);
    shared.uSun.value.set(sunVec.x, sunVec.y, sunVec.z, params.sunIlluminance);
    shared.uEarthCenter.value.set(-cam[0], -cam[1], -cam[2]);

    viewLut.uniforms.uMusCam.value = mus;
    viewLut.render(renderer);

    // Sunlight at the camera.
    model.sunTransmittanceAt(h, mus, tmp.sunT);
    globe.uniforms.uSunTransmittanceCam.value.set(tmp.sunT[0], tmp.sunT[1], tmp.sunT[2]);
    const tMax = Math.max(tmp.sunT[0], tmp.sunT[1], tmp.sunT[2]);
    if (tMax > 1e-6) sunLight.color.setRGB(tmp.sunT[0] / tMax, tmp.sunT[1] / tMax, tmp.sunT[2] / tMax, THREE.LinearSRGBColorSpace);
    sunLight.intensity = params.sunIlluminance * tMax;
    sunLight.position.copy(sunVec).multiplyScalar(SUN_LIGHT_DISTANCE);
    sunLight.target.position.copy(sunVec).multiplyScalar(-SUN_LIGHT_DISTANCE);
    skyLight.position.copy(upVec);

    // Ground patch: camera-relative placement in float64, faded out far from the pad.
    if (patchMesh) {
      const dx = padEcef[0] - cam[0];
      const dy = padEcef[1] - cam[1];
      const dz = padEcef[2] - cam[2];
      const fade = 1 - smoothstep(PATCH_FADE[0], PATCH_FADE[1], Math.hypot(dx, dy, dz));
      // Only once its imagery is in: until then the globe draws the ground there.
      const shown = fade > 0 && patch.uniforms.uPatchParams.value.w > 0;
      patchMesh.visible = shown;
      patchMesh.position.set(dx, dy, dz);
      patch.uniforms.uPatchParams.value.x = fade;
      globe.uniforms.uPatchDiscard.value.set(dx, dy, dz, shown ? PATCH_LAYOUT.discardRadius : -1);
      globe.uniforms.uPatchBiasRadius.value = shown ? PATCH_LAYOUT.biasRadius : -1;
    }

    // Stars: the celestial sphere turns with the sidereal angle. Exact from the UTC time when the stage
    // passes it; otherwise estimated from the Sun (its right ascension from its declination on the ecliptic,
    // northern-spring branch): exact rotation rate, arbitrary epoch.
    let theta: number;
    if (frame.utcMs !== undefined) {
      theta = greenwichSiderealTime(frame.utcMs);
    } else {
      const eps = (23.439 * Math.PI) / 180;
      const dec = Math.asin(Math.min(Math.max(sunVec.z, -1), 1));
      const lam = Math.asin(Math.min(Math.max(Math.sin(dec) / Math.sin(eps), -1), 1));
      const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
      theta = ra - Math.atan2(sunVec.y, sunVec.x);
    }
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    starRot.set(ct, st, 0, -st, ct, 0, 0, 0, 1);
    stars.uniforms.uStarRotation.value.copy(starRot);
    stars.uniforms.uStarParams.value.y = renderer.getPixelRatio();

    // Environment map + hemisphere light, rate-limited.
    const now = performance.now();
    const moved =
      envState.force ||
      !(Math.abs(h - envState.h) <= Math.max(25, 0.04 * h)) ||
      envState.sun.angleTo(sunVec) > 0.004 ||
      envState.up.angleTo(upVec) > 0.008;
    if (moved && now - envState.last >= QUALITY[quality].envInterval) {
      const e0 = performance.now();
      refreshLighting(h, mus);
      scene.environment = env.update(renderer);
      envState.last = now;
      envState.h = h;
      envState.sun.copy(sunVec);
      envState.up.copy(upVec);
      envState.force = false;
      stats.envRefreshes++;
      stats.envMs = performance.now() - e0;
      stats.lastEnvAt = now;
    }

    frame.camera.getWorldDirection(forward);
    updateFog(h, forward.dot(sunVec), mus);
    stats.updateMs = performance.now() - t0;
  };

  const setQuality = (q: Quality) => {
    if (q === quality) return;
    quality = q;
    viewLut.uniforms.uSteps.value = QUALITY[q].lutSteps;
    env.setResolution(QUALITY[q].envWidth);
    envState.force = true;
    syncDay();
  };

  const setAtmosphere = (p: Partial<AtmosphereParams>) => {
    Object.assign(params, p);
    model = new AtmosphereModel(params, computeTablesGpu(renderer, params) ?? undefined);
    const old = luts;
    luts = createAtmosphereTextures(model);
    shared.uTransmittanceLut.value = luts.transmittance;
    shared.uMsLut.value = luts.multipleScattering;
    shared.uGroundIrradiance.value = luts.groundIrradiance;
    Object.values(old).forEach((t) => t.dispose());
    applyAtmosphereParams(shared, params);
    envState.force = true;
  };

  // Both pads share the imagery; only the patch mesh is centred on the pad.
  const setPad = (id: PadId) => {
    const next = PADS[id];
    if (next === pad) return;
    pad = next;
    padEcef = latLonToEcef(pad.lat, pad.lon, 0);
    padRotation.setFromRotationMatrix(enuToEcefRotation(pad.lat, pad.lon));
    if (patchMesh && manifest) {
      patchMesh.geometry.dispose();
      patchMesh.geometry = buildPatchGeometry(pad.lat, pad.lon, pad.groundAlt, manifest.patches, PATCH_LAYOUT);
      patchMesh.quaternion.copy(padRotation);
    }
    envState.force = true;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    streamer.dispose();
    object.removeFromParent();
    sunLight.removeFromParent();
    skyLight.removeFromParent();
    sunLight.dispose();
    skyLight.dispose();
    globe.mesh.geometry.dispose();
    globe.mesh.material.dispose();
    stars.points.geometry.dispose();
    stars.points.material.dispose();
    patchMesh?.geometry.dispose();
    patch.material.dispose();
    viewLut.dispose();
    if (scene.environment === env.texture) scene.environment = null;
    env.dispose();
    if (scene.fog === fog) scene.fog = null;
    Object.values(luts).forEach((t) => t.dispose());
    placeholder.dispose();
    detailGrey.dispose();
    detailTex?.dispose();
    textures.day?.texture.dispose();
    textures.night?.dispose();
    textures.water?.dispose();
    Object.values(textures.patches).forEach((t) => t?.dispose());
  };

  return {
    object,
    sunLight,
    skyLight,
    ready,
    update,
    setQuality,
    setPad,
    dispose,
    get exposureHint() {
      return exposureHint;
    },
    debug: {
      params,
      setAtmosphere,
      surface: shared.uSurface.value,
      glint: shared.uGlintStrength,
      groundDetail: patch.uniforms.uGroundDetail,
      stats,
      manifest: () => manifest,
      imagery: () => ({
        day: textures.day?.level ?? null,
        night: textures.night !== null,
        water: textures.water !== null,
        patches: Object.keys(textures.patches).length,
      }),
      refreshEnvironment: () => {
        envState.force = true;
      },
      model: () => model,
    },
  };
}
