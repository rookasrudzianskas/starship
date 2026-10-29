# Starship Telemetry

Every Starship flight test, rebuilt as a physics simulation you can watch in 3D, compare, and fly yourself.

Built with **Next.js 16**, React 19, three.js and Zustand.

## What it does

- **Replay** each of the 14 integrated flight tests (Flight 1 in April 2023 to Flight 14, the first orbital flight, in September 2026) in a photoreal 3D scene: Starbase, the stack, hot staging, boostback, catches and splashdowns, entry plasma, Starlink deployment.
- **Live telemetry for both stages**: speed, altitude, engines lit (engine maps), propellant, pitch, Mach, g-load and vertical speed, plus a compressed mission timeline with every event.
- **Cameras**: a webcast-style director that cuts between ground trackers and onboard views (or pick one), chase, free, and a whole-Earth globe view with trajectories and event markers. Follow either vehicle, view both side by side, or use the small picture-in-picture frame.
- **Flight director**: change the flight while it plays. You can shut down any engine, cap the throttle, nudge the steering, stage early, cancel burns, trigger flight termination, send the booster to the tower, the Gulf or nowhere, aim the ship for orbit, change the payload, add wind, or replay a flight "as planned" without its real failures. The flight is re-simulated in a Web Worker in milliseconds, and your changes show on the timeline.
- **Compare** all flights on shared axes: speed, altitude, engines, propellant, vertical speed, acceleration, Mach, dynamic pressure and pitch.
- **Flights** list with outcomes, records and event times, and a CSV download of each simulated flight.

## How the simulation works

Each vehicle is a point mass with a rate-limited attitude, flying over a spherical, rotating Earth:

- **Gravity and air**: gravity includes J2, and the air follows the US Standard Atmosphere 1976.
- **Aerodynamics**: drag and lift depend on Mach number and angle of attack.
- **Engines**: Raptor thrust varies with ambient pressure, and propellant drains as LOX and methane.
- **Guidance**: the ascent is a gravity turn with a max-Q throttle bucket. Hot staging and a boostback to the tower or the Gulf follow. The ship climbs on closed-loop guidance, then flies a belly-first entry with a flip and a landing burn.
- **Calibration**: every flight is tuned against public milestones, and the real anomalies are scripted from the public record.

`npx tsx scripts/calibrate.ts` re-runs the calibration.

## Development

Requires Node.js 20.9 or newer.

```bash
npm install
npm run dev
```

Other scripts:

- `npm run build`: production build.
- `npx vitest run`: simulator tests.
- `node scripts/fetch-imagery.mjs`: rebuilds the Earth textures in `public/earth`.

## Credits

- Daytime Earth: NASA Blue Marble Next Generation (public domain).
- Night lights: NASA Black Marble 2016 (public domain).
- Ground imagery around Starbase: Sentinel-2 cloudless 2016 by EOX IT Services GmbH ([s2maps.eu](https://s2maps.eu)), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Contains modified Copernicus Sentinel data 2016.
- Type: D-DIN by Datto, [SIL Open Font License 1.1](app/fonts/OFL.txt).

An independent fan project, not affiliated with SpaceX. Starship, Super Heavy, Raptor and Starlink are names used by Space Exploration Technologies Corp. and appear here only to identify the vehicles. All numbers are simulated reconstructions.
