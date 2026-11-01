/**
 * Replay links: the query string that describes what the replay shows (flight, your changes to it,
 * the moment, and the view), read on arrival and written to the address bar and to shared links.
 *
 *   /?f=14&t=140&cam=chase&shot=pad&follow=ship&pip=0&run=P_Bs_W40_60.25eb12_141.5ps-2
 *
 * Everything is optional: no `f` is the latest flight, no `t` plays from the start, no `run` is the
 * flight as flown. `run` lists your changes as tokens joined by "_": first the run-wide settings
 * (P fly the plan, B<c|s|e> booster recovery, M<s|o> ship mission, N payload count, W wind m/s,
 * L booster propellant %), then each command as <time><kind><b|s><value>:
 * e engine out (engine index), h throttle limit (%), x terminate, g stage now, p steering bias (deg),
 * k skip the next burn. Flaps use <time>fs<index>d<degrees>, or <time>fs<index>a for automatic.
 */
import type { BoosterRecovery, Intervention, Scenario, ShipMission, VehicleId } from '@/lib/sim/types';
import { FLIGHTS, getFlight, LATEST_FLIGHT } from '../flights/catalog';
import { engineLayout } from '../sim/engines';
import { normalizeFlapCommand } from '../sim/scenario';
import { AS_FLOWN, isModified, MAX_STEERING_BIAS, newInterventionId, type CameraMode, type FollowMode, type ReplayState } from './replay';

export interface RunLink {
  flight: number;
  scenario: Scenario;
  /** Whole seconds. A link with a time opens paused at that moment. */
  t?: number;
  camera: CameraMode;
  /** Webcast camera id ('auto' for the director's cuts); the caller checks it names a real camera. */
  shot: string;
  follow: FollowMode;
  pip: boolean;
}

const CAMERAS: CameraMode[] = ['webcast', 'chase', 'free', 'globe'];
const FOLLOWS: FollowMode[] = ['both', 'booster', 'ship'];
const RECOVERY_CODE: Record<BoosterRecovery, string> = { catch: 'c', splashdown: 's', expend: 'e' };
const MISSION_CODE: Record<ShipMission, string> = { suborbital: 's', orbital: 'o' };
const VEHICLE_CODE: Record<VehicleId, string> = { booster: 'b', ship: 's' };

/** Number text without float noise or exponents (inputs are times and settings well inside ±1e6). */
function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function keyOf<T extends string>(map: Record<T, string>, code: string): T | undefined {
  return (Object.keys(map) as T[]).find((k) => map[k] === code);
}

function commandCode(i: Intervention): string {
  const at = num(i.t);
  switch (i.kind) {
    case 'engine-out':
      return `${at}e${VEHICLE_CODE[i.vehicle]}${i.engine}`;
    case 'throttle':
      return `${at}h${VEHICLE_CODE[i.vehicle]}${num(i.value * 100)}`;
    case 'terminate':
      return `${at}x${VEHICLE_CODE[i.vehicle]}`;
    case 'stage-now':
      return `${at}g`;
    case 'pitch':
      return `${at}p${VEHICLE_CODE[i.vehicle]}${num(i.deg)}`;
    case 'flap': {
      const command = normalizeFlapCommand(i);
      if (!command || !Number.isFinite(i.t) || i.t < 0 || i.t > 1e5) return '';
      return `${at}fs${command.flap}${command.deg === null ? 'a' : `d${num(command.deg)}`}`;
    }
    case 'skip-burn':
      return `${at}k${VEHICLE_CODE[i.vehicle]}`;
  }
}

/** The `run` code for a scenario, or '' for the flight as flown. */
export function encodeScenario(s: Scenario): string {
  if (!isModified(s)) return '';
  const tokens: string[] = [];
  if (!s.asFlown) tokens.push('P');
  if (s.boosterRecovery) tokens.push(`B${RECOVERY_CODE[s.boosterRecovery]}`);
  if (s.shipMission) tokens.push(`M${MISSION_CODE[s.shipMission]}`);
  if (s.payloadCount !== undefined) tokens.push(`N${Math.round(s.payloadCount)}`);
  if ((s.wind ?? 0) !== 0) tokens.push(`W${num(s.wind ?? 0)}`);
  if ((s.boosterLoad ?? 1) !== 1) tokens.push(`L${num((s.boosterLoad ?? 1) * 100)}`);
  for (const i of s.interventions) {
    const code = commandCode(i);
    if (code) tokens.push(code);
  }
  return tokens.join('_');
}

const COMMAND = /^(-?\d+(?:\.\d+)?)([ehxgpk])([bs]?)(-?\d+(?:\.\d+)?)?$/;
const FLAP_COMMAND = /^(\d+(?:\.\d+)?)fs([0-3])(?:d(-?\d+(?:\.\d+)?)|(a))$/;
const SETTING = /^([PBMNWL])([a-z]|\d+(?:\.\d+)?)?$/;

/**
 * The scenario in a `run` code, for `flight`. Tokens that are malformed or out of range (an engine
 * the vehicle does not have, a time outside the flight) are left out; nothing valid gives as flown.
 */
export function decodeScenario(code: string, flight: number): Scenario {
  const { generation, plan } = getFlight(flight);
  const s: Scenario = { asFlown: true, interventions: [] };
  for (const token of code.split('_')) {
    const flap = FLAP_COMMAND.exec(token);
    if (flap) {
      const rawTime = Number(flap[1]);
      const t = Math.round(rawTime * 1000) / 1000;
      const command = normalizeFlapCommand({ vehicle: 'ship', flap: Number(flap[2]), deg: flap[4] ? null : Number(flap[3]) });
      // Separation and end-of-flight availability depend on the resulting run, not the URL parser.
      if (command && Number.isFinite(rawTime) && rawTime >= 0 && rawTime <= 1e5) s.interventions.push({ id: newInterventionId(), t, kind: 'flap', ...command });
      continue;
    }
    const set = SETTING.exec(token);
    if (set) {
      const [, key, arg = ''] = set;
      const n = Number(arg);
      if (key === 'P' && arg === '') s.asFlown = false;
      else if (key === 'B') s.boosterRecovery = keyOf(RECOVERY_CODE, arg) ?? s.boosterRecovery;
      else if (key === 'M') s.shipMission = keyOf(MISSION_CODE, arg) ?? s.shipMission;
      else if (key === 'N' && Number.isInteger(n) && n >= 0 && n <= 60 && n !== plan.ship.payloadCount) s.payloadCount = n;
      else if (key === 'W' && n > 0 && n <= 150) s.wind = n;
      else if (key === 'L' && n >= 50 && n < 100) s.boosterLoad = n / 100;
      continue;
    }
    const cmd = COMMAND.exec(token);
    if (!cmd) continue;
    const [, at, kind, v, arg] = cmd;
    const t = Number(at);
    // The same limits as the flight director: staging from T+20 s, steering and termination after liftoff.
    const earliest = kind === 'g' ? 20 : kind === 'x' || kind === 'p' ? 0 : -10;
    if (!(t >= earliest && t <= 1e5)) continue;
    const vehicle = keyOf(VEHICLE_CODE, v);
    const value = arg === undefined ? NaN : Number(arg);
    const id = newInterventionId();
    if (kind === 'g') {
      if (v === '' && arg === undefined) s.interventions.push({ id, t, kind: 'stage-now' });
      continue;
    }
    if (!vehicle) continue;
    if (kind === 'e') {
      if (Number.isInteger(value) && value >= 0 && value < engineLayout(vehicle, generation).length) s.interventions.push({ id, t, kind: 'engine-out', vehicle, engine: value });
    } else if (kind === 'h') {
      if (value >= 40 && value <= 100) s.interventions.push({ id, t, kind: 'throttle', vehicle, value: value / 100 });
    } else if (kind === 'p') {
      if (Math.abs(value) <= MAX_STEERING_BIAS) s.interventions.push({ id, t, kind: 'pitch', vehicle, deg: value });
    } else if (arg === undefined) {
      s.interventions.push({ id, t, kind: kind === 'x' ? 'terminate' : 'skip-burn', vehicle });
    }
  }
  s.interventions.sort((a, b) => a.t - b.t);
  return isModified(s) ? s : AS_FLOWN;
}

/** The replay a query string asks for (anything missing or invalid falls back to the default). */
export function readRunLink(search: string): RunLink {
  const p = new URLSearchParams(search);
  const f = Number(p.get('f'));
  const flight = FLIGHTS.some((x) => x.n === f) ? f : LATEST_FLIGHT;
  const t = Number(p.get('t') ?? NaN);
  const cam = p.get('cam') as CameraMode | null;
  const follow = p.get('follow') as FollowMode | null;
  const shot = p.get('shot');
  const run = p.get('run');
  return {
    flight,
    scenario: run ? decodeScenario(run, flight) : AS_FLOWN,
    t: p.get('t') && Number.isFinite(t) ? Math.round(t) : undefined,
    camera: cam && CAMERAS.includes(cam) ? cam : 'webcast',
    shot: shot && /^[a-z][a-z-]{0,31}$/.test(shot) ? shot : 'auto',
    follow: follow && FOLLOWS.includes(follow) ? follow : 'both',
    pip: p.get('pip') !== '0',
  };
}

/** The link to what the replay shows now. The moment is included when `withTime` is set. */
export function linkOf(s: Pick<ReplayState, 'flight' | 'scenario' | 't' | 'camera' | 'webcastShot' | 'follow' | 'pip'>, withTime: boolean): RunLink {
  return {
    flight: s.flight,
    scenario: s.scenario,
    t: withTime ? Math.round(s.t) : undefined,
    camera: s.camera,
    shot: s.webcastShot,
    follow: s.follow,
    pip: s.pip,
  };
}

/**
 * Query string for a link ('' or '?…'). `explicitFlight` keeps `f` even for the latest flight, for
 * links that must still open the same flight after a newer one is added.
 */
export function runLinkSearch(link: RunLink, explicitFlight: boolean): string {
  const p = new URLSearchParams();
  if (explicitFlight || link.flight !== LATEST_FLIGHT) p.set('f', String(link.flight));
  const run = encodeScenario(link.scenario);
  if (run) p.set('run', run);
  if (link.t !== undefined) p.set('t', String(link.t));
  if (link.camera !== 'webcast') p.set('cam', link.camera);
  if (link.shot !== 'auto') p.set('shot', link.shot);
  if (link.follow !== 'both') p.set('follow', link.follow);
  if (!link.pip) p.set('pip', '0');
  const q = p.toString();
  return q ? `?${q}` : '';
}
