import type { FlightResult, VehicleId } from '@/lib/sim/types';
import type { FollowMode } from '@/lib/store/replay';
// Relative so the director can be unit tested (vitest has no @/ alias).
import { Phase } from '../../sim/types';
import { firstPhaseTime } from './sample';

/**
 * 'separation' (a long lens on both vehicles as they part) and 'payload' (the ship's camera on its payload door)
 * are the director's own, not in the camera menu.
 */
export type ShotId = 'pad' | 'tracking' | 'booster-top' | 'booster-aft' | 'ship-aft' | 'ship-nose' | 'buoy' | 'tower' | 'separation' | 'payload';

export interface Shot {
  readonly id: ShotId;
  readonly vehicle: VehicleId;
}

const SHOT_IDS: readonly ShotId[] = ['pad', 'tracking', 'booster-top', 'booster-aft', 'ship-aft', 'ship-nose', 'buoy', 'tower', 'separation', 'payload'];

function shotTable(vehicle: VehicleId): Record<ShotId, Shot> {
  const table = {} as Record<ShotId, Shot>;
  for (const id of SHOT_IDS) table[id] = Object.freeze({ id, vehicle });
  return table;
}

/** One shared Shot per camera and vehicle: the director runs every frame and allocates nothing. */
const SHOTS: Record<VehicleId, Record<ShotId, Shot>> = { booster: shotTable('booster'), ship: shotTable('ship') };

function shot(id: ShotId, vehicle: VehicleId): Shot {
  return SHOTS[vehicle][id];
}

/**
 * The long-range tracker hands over from the ground telescope near the pad (which by then sees the climbing stack
 * end on, through its exhaust) to a chase aircraft alongside. The director's first cut to the booster's engine
 * camera (T+57 to T+68) hides the change.
 */
export const AERIAL_TRACKING_FROM = 62;

/** Times the director plans around, derived once per result. */
export interface DirectorPlan {
  sep: number | null;
  /** When the ship's engines light while it is still attached (hot staging), or null. */
  hotStage: number | null;
  boostbackEnd: number;
  boosterLanding: number;
  boosterEnd: number;
  boosterCatch: boolean;
  /** When each vehicle comes down in the water, or null: its onboard cameras are then at the waterline. */
  boosterTouchdown: number | null;
  shipSeco: number;
  /** Infinity for a ship that never comes back into the atmosphere. */
  shipEntry: number;
  shipLanding: number;
  shipTouchdown: number | null;
  /** When each satellite leaves the ship's payload door, in order. */
  releases: readonly number[];
  shipEnd: number;
  shipLands: boolean;
  boosterLands: boolean;
  /** The vehicle's flight ends in a breakup. */
  boosterBreaksUp: boolean;
  shipBreaksUp: boolean;
}

const BREAKUPS = new Set(['lost', 'termination', 'impact']);

export function planDirector(r: FlightResult): DirectorPlan {
  const ev = (key: string) => r.events.find((e) => e.key === key)?.t;
  const sep = r.separationT;
  const boosterLanding = firstPhaseTime(r.booster, Phase.LandingBurn, sep ?? 0) ?? r.booster.end - 20;
  const shipLanding = firstPhaseTime(r.ship, Phase.ShipFlip, sep ?? 0) ?? firstPhaseTime(r.ship, Phase.LandingBurn, (sep ?? 0) + 60) ?? r.ship.end - 25;
  const hotStage = sep !== null ? firstPhaseTime(r.ship, Phase.HotStage) : null;
  return {
    sep,
    hotStage: hotStage !== null && sep !== null && hotStage <= sep ? hotStage : null,
    boostbackEnd: ev('boostback-end') ?? (sep !== null ? sep + 50 : 0),
    boosterLanding,
    boosterEnd: r.booster.end,
    boosterCatch: r.booster.endKind === 'catch',
    boosterTouchdown: firstPhaseTime(r.booster, Phase.Splashed),
    shipSeco: ev('seco') ?? (sep !== null ? sep + 360 : r.ship.end),
    shipEntry: ev('entry') ?? firstPhaseTime(r.ship, Phase.Entry, sep ?? 0) ?? Infinity,
    shipLanding,
    shipTouchdown: firstPhaseTime(r.ship, Phase.Splashed),
    releases: r.payload.map((p) => p.t).sort((a, b) => a - b),
    shipEnd: r.ship.end,
    shipLands: r.ship.endKind === 'splashdown',
    boosterLands: r.booster.endKind === 'splashdown' || r.booster.endKind === 'catch',
    boosterBreaksUp: BREAKUPS.has(r.booster.endKind),
    shipBreaksUp: BREAKUPS.has(r.ship.endKind),
  };
}

/** The booster's landing (or its last moments, if it doesn't land) is shown from this long before its landing burn. */
const LANDING_LEAD = 12;
/**
 * How long the director stays on a vehicle after its flight ends: a landed one floating or held by the tower, or
 * the debris of one that broke up (gone within seconds in thin air), before the other vehicle takes over. A replay
 * runs on for 10 s after its last vehicle's end, so the other vehicle closes it rather than flashing up at the end.
 */
const LANDED_HOLD = 20;
const BREAKUP_HOLD = 5;

/**
 * Staging, as the broadcast shows it: the booster's camera looking up at the ship from a little before the ship's
 * engines light (STAGING_LEAD s) until the ship has just pulled clear (SEPARATION_FROM s after separation), when
 * the booster's flip starts turning that camera away from it; then a long lens alongside both vehicles as they
 * part, until SEPARATION_TO s after separation, when the booster's engine camera takes over for its boostback.
 */
const STAGING_LEAD = 2.5;
/** At most this long before separation, however long the ship's engines burn while attached. */
const STAGING_MAX = 8;
export const SEPARATION_FROM = 1.8;
export const SEPARATION_TO = 12;

/**
 * The launch steam billows round the tower camera from about this long after liftoff until it has thinned out
 * (see lib/three/effects/launchClouds.ts): a grey frame, so a tower camera picked then shows the director's shot.
 */
const TOWER_STEAM: readonly [number, number] = [25, 160];

/** A satellite leaving the payload door is shown from shortly before it starts to slide out until it has drifted off. */
const RELEASE_SHOT: readonly [number, number] = [3, 22];

/** A satellite is leaving the ship at t (see RELEASE_SHOT). */
function releasing(t: number, p: DirectorPlan): boolean {
  for (const r of p.releases) {
    if (r - RELEASE_SHOT[0] > t) return false;
    if (t <= r + RELEASE_SHOT[1]) return true;
  }
  return false;
}

/** When the booster's camera looking up at the ship comes on. */
function stagingFrom(p: DirectorPlan): number {
  if (p.sep === null) return Infinity;
  return Math.max(p.sep - STAGING_MAX, (p.hotStage ?? p.sep - 2) - STAGING_LEAD);
}

/** The booster's landing window: from just before its landing burn until shortly after it is down. */
function boosterLanding(t: number, p: DirectorPlan): boolean {
  return t >= p.boosterLanding - LANDING_LEAD && t <= p.boosterEnd + 12;
}

function boosterShot(t: number, p: DirectorPlan): Shot {
  if (p.boosterLands && t >= p.boosterLanding - LANDING_LEAD) return shot(p.boosterCatch ? 'tower' : 'buoy', 'booster');
  return shot('booster-aft', 'booster');
}

function shipShot(t: number, p: DirectorPlan): Shot {
  if (p.shipLands && t >= p.shipLanding - 25) return shot('buoy', 'ship');
  if (t >= p.shipEntry - 30) return shot('ship-nose', 'ship');
  if (releasing(t, p)) return shot('payload', 'ship');
  return shot('ship-aft', 'ship');
}

/**
 * The broadcast director: which camera is live at time t. Pure function of t, so scrubbing is stable.
 * Ascent alternates between the long-range tracker and the booster's engine camera; staging is seen from
 * the booster looking up, then from alongside as the two part; afterwards it follows whichever vehicle has
 * something happening, and watches each satellite the ship releases leave its payload door.
 */
export function autoShot(t: number, p: DirectorPlan, follow: FollowMode): Shot {
  if (t < 11) return shot('pad', 'booster');
  if (p.sep === null || t < stagingFrom(p)) {
    const cycle = (t - 11) % 64;
    // Not once the stack has broken up: the tracker stays on what is left of it.
    if (t > 40 && cycle > 46 && cycle < 57 && t <= p.boosterEnd && (p.sep === null || t < p.sep - 20)) return shot('booster-aft', 'booster');
    return shot('tracking', 'booster');
  }
  if (t < p.sep + SEPARATION_FROM) return shot('booster-top', 'booster');
  if (t < p.sep + SEPARATION_TO) return shot('separation', 'booster');

  const boosterAlive = t <= p.boosterEnd + (p.boosterBreaksUp ? BREAKUP_HOLD : LANDED_HOLD);
  const shipAlive = t <= p.shipEnd + (p.shipBreaksUp ? BREAKUP_HOLD : LANDED_HOLD);
  if (follow === 'booster') return boosterAlive || !shipAlive ? boosterShot(t, p) : shipShot(t, p);
  if (follow === 'ship') return shipAlive || !boosterAlive ? shipShot(t, p) : boosterShot(t, p);

  // Both: the booster during its flip and boostback, and through its landing (the ship carries on in the small
  // frame, as on the broadcast); the ship otherwise.
  if (boosterAlive && (t < p.boostbackEnd + 6 || boosterLanding(t, p))) return boosterShot(t, p);
  if (shipAlive) return shipShot(t, p);
  return boosterShot(t, p);
}

/** A shot the viewer picked; mapped onto the vehicle it belongs to, falling back when it no longer applies. */
export function pickedShot(id: ShotId, t: number, p: DirectorPlan, follow: FollowMode): Shot {
  switch (id) {
    case 'pad':
    case 'tracking':
      // Following both, they watch the vehicle the director would.
      return shot(id, follow === 'both' ? autoShot(t, p, follow).vehicle : follow);
    case 'booster-top':
    case 'booster-aft':
      // Once the booster is down in the water its cameras are at the waterline: the buoy shows it instead.
      if (p.boosterTouchdown !== null && t >= p.boosterTouchdown) return t <= p.boosterEnd + 20 ? shot('buoy', 'booster') : autoShot(t, p, follow);
      return t <= p.boosterEnd + 20 ? shot(id, 'booster') : autoShot(t, p, follow);
    case 'ship-aft':
    case 'ship-nose':
      if (p.shipTouchdown !== null && t >= p.shipTouchdown) return t <= p.shipEnd + 20 ? shot('buoy', 'ship') : autoShot(t, p, follow);
      return t <= p.shipEnd + 20 ? shot(id, 'ship') : autoShot(t, p, follow);
    case 'tower':
      // The tower watches the booster come home; it sees liftoff, but not through the launch steam.
      if (t > TOWER_STEAM[0] && t < TOWER_STEAM[1]) return autoShot(t, p, follow);
      return shot(id, 'booster');
    case 'buoy':
      // Following both, it watches whichever comes down next: the ship's buoy, half a world away, would show an
      // empty sea for hours while the booster climbs and lands.
      return shot(id, follow === 'booster' || (follow === 'both' && p.boosterLands && t <= p.boosterEnd + 20) ? 'booster' : 'ship');
    case 'separation':
    case 'payload':
      // The director's own; not offered in the camera menu.
      return autoShot(t, p, follow);
  }
}
