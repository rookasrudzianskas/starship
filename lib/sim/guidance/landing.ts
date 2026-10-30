/**
 * Shared pieces of the landing burns (Super Heavy and Starship): how far the vehicle may lean from the vertical at
 * a given height, and the thrust vector that brakes the descent while it moves sideways.
 */

/**
 * Lean allowed from the vertical at height h above the aim point, rad: `high` well above it, closing smoothly
 * (smoothstep) to `low` at the aim over the last `span` metres, so the final stretch comes down nearly upright.
 */
export function landingTiltCap(h: number, high: number, low: number, span: number): number {
  const x = h <= 0 ? 0 : h >= span ? 1 : h / span;
  return low + (high - low) * x * x * (3 - 2 * x);
}

/**
 * Thrust vector of a landing burn (inertial, N, written to `out`; returns its magnitude): `fV` newtons upwards
 * (after drag) plus the sideways force for `latAcc` (m/s², horizontal), leaning at most `cap` from `up`. The engines
 * deliver between `tMin` (minimum throttle) and `tMax`, and the lean follows from what they will really give: a burn
 * held at minimum throttle leans only as far as its sideways push needs, and a burn short of thrust still gets its
 * sideways share (which costs the vertical at most 1 − cos(cap)).
 */
export function landingThrust(
  out: Float64Array,
  up: ArrayLike<number>,
  latAcc: ArrayLike<number>,
  m: number,
  fV: number,
  tMin: number,
  tMax: number,
  cap: number,
): number {
  const aL = Math.sqrt(latAcc[0] * latAcc[0] + latAcc[1] * latAcc[1] + latAcc[2] * latAcc[2]);
  const sCap = Math.sin(cap);
  // Thrust at the full lean that still gives the vertical force asked for, as the engines can deliver it.
  const tCap = Math.min(tMax, Math.max(tMin, fV / Math.cos(cap)));
  const fL = Math.min(m * aL, tCap * sCap);
  const need = Math.sqrt(fV * fV + fL * fL);
  const tAct = Math.min(tMax, Math.max(tMin, need));
  const s = tAct > 0 ? Math.min(sCap, fL / tAct) : 0;
  const c = Math.sqrt(1 - s * s);
  const k = aL > 1e-9 ? s / aL : 0;
  for (let i = 0; i < 3; i++) out[i] = need * (c * up[i] + k * latAcc[i]);
  return need;
}
