import type * as THREE from 'three';

const DEG = Math.PI / 180;
const MS_PER_DAY = 86_400_000;
/** Julian date of the Unix epoch, and of J2000.0. */
const JD_UNIX_EPOCH = 2440587.5;
const JD_J2000 = 2451545.0;

/** Days since J2000.0 (UT; the TT − UT offset of ~69 s moves the Sun by < 0.001°). */
function daysSinceJ2000(utcMs: number): number {
  return utcMs / MS_PER_DAY + JD_UNIX_EPOCH - JD_J2000;
}

/** Greenwich mean sidereal time in radians (IAU 1982 expression, ample for ~0.01°). */
export function greenwichSiderealTime(utcMs: number): number {
  const d = daysSinceJ2000(utcMs);
  const t = d / 36525;
  const deg = 280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38710000;
  return (((deg % 360) + 360) % 360) * DEG;
}

/**
 * Unit vector from the Earth's centre towards the Sun in ECEF axes (+X lat 0/lon 0, +Z north pole).
 *
 * Low-precision solar coordinates (Astronomical Almanac): mean longitude L and anomaly g, ecliptic longitude
 * λ = L + 1.915° sin g + 0.020° sin 2g, obliquity ε; the equatorial direction (equinox of date) is rotated into
 * the Earth-fixed frame by the sidereal angle. Accurate to ~0.01–0.02° for 1950–2050, well inside 0.1°.
 */
export function sunDirectionEcef(utcMs: number, out: THREE.Vector3): THREE.Vector3 {
  const d = daysSinceJ2000(utcMs);
  const L = (280.46 + 0.9856474 * d) * DEG;
  const g = (357.528 + 0.9856003 * d) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * d) * DEG;
  // Equatorial (inertial) unit vector.
  const xi = Math.cos(lambda);
  const yi = Math.cos(eps) * Math.sin(lambda);
  const zi = Math.sin(eps) * Math.sin(lambda);
  // Earth-fixed = Rz(−θ) · inertial.
  const theta = greenwichSiderealTime(utcMs);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return out.set(c * xi + s * yi, -s * xi + c * yi, zi);
}
