import * as THREE from 'three';

type RGB = [number, number, number];

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

/** CPU port of three's ACESFilmicToneMapping (tonemapping_pars_fragment), for colours mixed after tone mapping. */
function acesFilmic(c: RGB, exposure: number, out: RGB): RGB {
  const k = exposure / 0.6;
  const r = c[0] * k;
  const g = c[1] * k;
  const b = c[2] * k;
  const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const fr = fit(0.59719 * r + 0.35458 * g + 0.04823 * b);
  const fg = fit(0.076 * r + 0.90834 * g + 0.01566 * b);
  const fb = fit(0.0284 * r + 0.13383 * g + 0.83777 * b);
  out[0] = clamp01(1.60475 * fr - 0.53108 * fg - 0.07367 * fb);
  out[1] = clamp01(-0.10208 * fr + 1.10813 * fg - 0.00605 * fb);
  out[2] = clamp01(-0.00327 * fr - 0.07276 * fg + 1.07602 * fb);
  return out;
}

/**
 * Display-referred (tone-mapped, still linear) version of an HDR colour for the renderer's tone mapping.
 * three mixes fog after tone mapping when it renders straight to the canvas, so the fog colour must be given in
 * that space. ACES is exact; other operators use simple stand-ins.
 */
export function toneMapColour(renderer: THREE.WebGLRenderer, c: RGB, out: RGB): RGB {
  const e = renderer.toneMappingExposure;
  switch (renderer.toneMapping) {
    case THREE.NoToneMapping:
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      return out;
    case THREE.ACESFilmicToneMapping:
      return acesFilmic(c, e, out);
    case THREE.LinearToneMapping:
      out[0] = clamp01(c[0] * e);
      out[1] = clamp01(c[1] * e);
      out[2] = clamp01(c[2] * e);
      return out;
    default:
      // Reinhard-like stand-in for the remaining operators.
      for (let i = 0; i < 3; i++) out[i] = clamp01((c[i] * e) / (1 + c[i] * e));
      return out;
  }
}
