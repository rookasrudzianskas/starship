# Starship Telemetry

Every Starship flight test, rebuilt as a physics simulation you can watch in 3D, compare, and fly yourself.

Built with **Next.js 16**, React 19, three.js and Zustand.

## What it does

- **Replay** each of the 14 integrated flight tests (Flight 1 in April 2023 to Flight 14, the first orbital flight, in September 2026) in a photoreal 3D scene: Starbase, the stack, hot staging, boostback, catches and splashdowns, entry plasma, Starlink deployment.
- **Live telemetry for both stages**: speed, altitude, engines lit (engine maps), propellant, pitch, Mach, g-load and vertical speed, plus a compressed mission timeline with every event.
- **Optional audio**: synthesized engine and airflow sound, enabled with the speaker button or `M`. Sound starts muted on each visit and is silent while paused, when the tab is hidden, during coast skipping, or above 5× playback speed.
- **Cameras**: a webcast-style director that cuts between ground trackers and onboard views (or pick one), chase, free, and a whole-Earth globe view with trajectories and event markers. Follow either vehicle, view both side by side, or use the small picture-in-picture frame.
- **Flight director**: change the flight while it plays. You can shut down any engine, cap the throttle, nudge the steering, command each ship flap or return it to automatic, stage early, cancel burns, trigger flight termination, send the booster to the tower, the Gulf or nowhere, aim the ship for orbit, change the payload, add wind, or replay a flight "as planned" without its real failures. The flight is re-simulated in a Web Worker in milliseconds, and your changes show on the timeline.
- **Undo and redo experiments**: the director keeps the last 50 scenario changes, including resets and removed commands. Use the buttons or, while the director is open, Ctrl/⌘ Z and Ctrl/⌘ Shift Z (also Ctrl Y). History stays in the current session and resets when you open another flight or shared run.
- **Compare** all flights on shared axes: speed, altitude, engines, propellant, vertical speed, acceleration, Mach, dynamic pressure and pitch.
- **Flights** list with outcomes, records and event times, and a CSV download of each simulated flight.

## How the simulation works

Each vehicle uses a point-mass trajectory with bounded attitude control and flap-induced angular disturbances, flying over a spherical, rotating Earth:

- **Gravity and air**: gravity includes J2, and the air follows the US Standard Atmosphere 1976. The reentry predictor uses the same altitude-dependent wind field as the flight dynamics. Plume pressure and body-relative airflow also use those models, with wind kept in sync with the displayed simulation while a new run calculates.
- **Aerodynamics**: drag and lift depend on Mach number and angle of attack. Four flap plates use the same hinge locations, swept geometry and curved planforms as the rendered meshes. Forces and moments relative to automatic trim supplement the calibrated whole-ship model, avoiding double-counted flap drag while allowing manual overrides and actuator lag to affect the flight. Moments use the current center of mass and cylindrical inertia estimates.
- **Flap actuators**: each hinge retains its angle and rate through phase changes. Acceleration, braking, travel and pressure-dependent speed limits produce continuous deployment, entry trim and landing-flip motion. Fore/aft trim responds to pitch error; both left/right pairs contribute to roll with the same differential. A held bank does not force a permanent roll command. Individual manual targets, return-to-auto, undo/redo and shared runs use these same actuators.
- **Roll control**: nose steering and axial roll have independent rate and acceleration budgets. The ship holds its heat shield to the right of track through climb and coast, except Flight 14’s leeward-to-Earth separation attitude around T+100–315 s. Entry then takes priority; catching boosters return to tower-facing roll. The rigid ship mounting and inherited angular velocity stay continuous through staging.
- **Engines**: Raptor thrust varies with ambient pressure, and propellant drains as LOX and methane.
- **Vehicle mounting**: the attached ship faces its heat shield away from the tower, opposite the booster's tower-facing side. That mounting attitude carries continuously into separation, including the ship's onboard cameras and airflow shading.
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

Roll schedules, flap actuator limits, pressure centers and plate coefficients are reconstructed estimates. Attitude guidance remains a reduced kinematic controller with finite authority; it is not a full six-degree-of-freedom propulsion, hinge-load or structural model. The entry predictor assumes automatic trim, so a persistent manual flap override can prevent it from reaching the target.

The flights and telemetry are reconstructed from public information and simplified physics, not measured vehicle telemetry. This is an educational and visual simulation, not an engineering-grade model or a tool for operational flight decisions. Calibration to selected milestones does not validate every trajectory, intervention or failure scenario. Passing automated checks does not guarantee zero bugs, physical accuracy or consistent rendering and performance on every device.

## Credits

- Daytime Earth: NASA Blue Marble Next Generation (public domain).
- Night lights: NASA Black Marble 2016 (public domain).
- Ground imagery around Starbase: Sentinel-2 cloudless 2016 by EOX IT Services GmbH ([s2maps.eu](https://s2maps.eu)), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Contains modified Copernicus Sentinel data 2016.
- Type: D-DIN by Datto, [SIL Open Font License 1.1](app/fonts/OFL.txt).

An independent fan project, not affiliated with SpaceX. Starship, Super Heavy, Raptor and Starlink are names used by Space Exploration Technologies Corp. and appear here only to identify the vehicles. All numbers are simulated reconstructions.
