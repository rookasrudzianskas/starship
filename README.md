# Starship Telemetry

Every Starship flight test, rebuilt as a physics simulation you can watch in 3D, compare, and fly yourself.

Built with **Next.js 16**, React 19, three.js and Zustand.

## What it does

- **Replay** each of the 14 integrated flight tests (Flight 1 in April 2023 to Flight 14, the first orbital flight, in September 2026) in a photoreal 3D scene: Starbase, the stack, hot staging, boostback, catches and splashdowns, entry plasma, Starlink deployment.
- **Live telemetry for both stages**: speed, altitude, engines lit (engine maps), propellant, pitch, Mach, g-load and vertical speed, plus a compressed mission timeline with every event.
- **Optional audio**: synthesized engine and airflow sound, enabled with the speaker button or `M`. Sound starts muted on each visit and is silent while paused, when the tab is hidden, during coast skipping, or above 5× playback speed.
- **Cameras**: a webcast-style director that cuts between ground trackers and onboard views (or pick one), chase, free, and a whole-Earth globe view with trajectories and event markers. Follow either vehicle, view both side by side, or use the small picture-in-picture frame.
- **Flight director**: change the flight while it plays. You can shut down any engine, cap the throttle, nudge the steering, stage early, cancel burns, trigger flight termination, send the booster to the tower, the Gulf or nowhere, aim the ship for orbit, change the payload, add wind, or replay a flight "as planned" without its real failures. The flight is re-simulated in a Web Worker in milliseconds, and your changes show on the timeline.
- **Undo and redo experiments**: the director keeps the last 50 scenario changes, including resets and removed commands. Use the buttons or, while the director is open, Ctrl/⌘ Z and Ctrl/⌘ Shift Z (also Ctrl Y). History stays in the current session and resets when you open another flight or shared run.
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

Use Node.js 22 (minimum 22.12). With nvm installed:

```bash
nvm install
nvm use
npm ci
npm run dev
```

Without nvm, install Node.js 22.12 or newer before running the npm commands.

Other scripts:

- `npm run build`: production build.
- `npm start`: serve the production build.
- `npm run lint`: ESLint checks.
- `npm run typecheck`: generate Next.js route types and check TypeScript.
- `npm test`: run all Vitest tests serially, including the simulator performance checks with their existing limits.
- `npm run check`: run lint, type checking, tests and the production build in sequence. CI runs these checks on Node.js 22 after `npm ci`.
- `node scripts/fetch-imagery.mjs`: rebuilds the Earth textures in `public/earth`.

## Limitations

The flights and telemetry are reconstructed from public information and simplified physics, not measured vehicle telemetry. This is an educational and visual simulation, not an engineering-grade model or a tool for operational flight decisions. Calibration to selected milestones does not validate every trajectory, intervention or failure scenario. Passing automated checks does not guarantee zero bugs, physical accuracy or consistent rendering and performance on every device.

## Credits

- Daytime Earth: NASA Blue Marble Next Generation (public domain).
- Night lights: NASA Black Marble 2016 (public domain).
- Ground imagery around Starbase: Sentinel-2 cloudless 2016 by EOX IT Services GmbH ([s2maps.eu](https://s2maps.eu)), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Contains modified Copernicus Sentinel data 2016.
- Type: D-DIN by Datto, [SIL Open Font License 1.1](app/fonts/OFL.txt).

An independent fan project, not affiliated with SpaceX. Starship, Super Heavy, Raptor and Starlink are names used by Space Exploration Technologies Corp. and appear here only to identify the vehicles. All numbers are simulated reconstructions.
