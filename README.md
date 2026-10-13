# Rock Stack

A mobile-first 3D physics game about balancing natural river stones. Place
irregular stones on a boulder in a shallow stream and build the tallest tower
you dare: edges, overhangs and knife-edge balances score more — if they hold.

Built with **TypeScript + Vite**, **Three.js** (rendering), **Rapier 3D**
(rigid-body physics) and the **Web Audio API**. No backend, no accounts, no
paid services, no downloaded assets — everything visual and audible is
generated procedurally at runtime.

Optimised for **iPhone and iPad** (Safari and home-screen app), works on
Android and desktop browsers too.

---

## Quick start

Requirements: Node.js 20+ (22 recommended).

```bash
npm ci            # install exact dependency versions from package-lock.json
npm run dev       # dev server on http://localhost:5173 (also exposed on your LAN)
npm run build     # type-check + production build into dist/
npm run preview   # serve the production build (also on your LAN)
npm test          # unit + physics tests (Vitest)
npm run test:e2e  # end-to-end smoke test of dist/ in emulated iPhone/iPad (Playwright, Chromium)
```

The end-to-end test needs a Playwright Chromium once: `npx playwright install chromium`.
It uses software WebGL (SwiftShader), so expect a few minutes per device.

### Playing on an iPhone / iPad

* **Same Wi-Fi:** run `npm run dev` (or `npm run build && npm run preview`) and
  open the printed `Network:` URL in Safari on the device.
* **Hosted:** the included workflow `.github/workflows/deploy.yml` tests, builds
  and publishes `dist/` to GitHub Pages on every push to `main`/`master`
  (enable it once under *Settings → Pages → Source: GitHub Actions*). The build
  uses relative paths, so any static host or sub-path works.
* **Full screen:** in Safari tap *Share → Add to Home Screen*. The game then
  runs as a full-screen app (status bar overlay, safe areas respected) and is
  cached for offline play by a small service worker (HTTPS only).

### Controls

| Action | Touch | Mouse / keyboard |
| --- | --- | --- |
| Move stone | drag with one finger (relative, finger never covers the stone; slow drags are finer) | left-drag · arrows/WASD |
| Rotate | two-finger twist · ⟲ ⟳ buttons (tap = 15°, hold = continuous) | wheel · Q / E |
| Turn stone over | **Flip** button (cycles the stone's stable resting faces) | F |
| Drop | **Drop** button | Space / Enter |
| Orbit camera | two-finger sideways pan | right-drag · Z / X |
| Zoom | pinch | ctrl/⌘/shift + wheel |
| Pause | ⏸ button | Esc / P |
| Debug overlay | three-finger tap or *Settings → Debug overlay* | ` (backtick) · `?debug` |

Two-finger gestures lock to whichever component (twist / pinch / pan) clearly
dominates first, so twisting never accidentally zooms or orbits.

A translucent outline shows exactly where the stone will land (computed with a
Rapier shape cast of the real collider), a marker shows the first contact
point, and the outline turns red if the stone would miss the tower.

---

## How it plays

1. A stone is generated and hovers above the tower.
2. Position and rotate it; the landing preview follows.
3. **Drop** releases it into the simulation from a few centimetres above its
   landing point.
4. Rapier simulates impacts, sliding, rocking and settling.
5. Once the whole tower is at rest, the placement is **measured from the real
   contact points** and scored.
6. The next stone spawns (generated in a Web Worker while you aimed).
7. If any stone touches the riverbed/terrain, drops below the base rock or
   leaves the play area, the tower has collapsed — the collapse plays out in
   (briefly slowed) physics, then the results screen appears.
8. *Stack again* restarts instantly (no reload).

### Scoring

After every placement the game reads the stone's actual contact manifold from
Rapier and computes (`src/game/Stability.ts`):

* **support polygon** — 2D convex hull of all weight-carrying contact points,
* **stability margin** — signed distance of the stone's centre of mass to the
  edge of that polygon, normalised by the stone's footprint radius,
* **overhang** — horizontal offset from the centre of mass of the supporting
  stone(s),
* **contact slope** — tilt of the supporting contact normals.

These combine into a **risk** value in [0, 1] (`src/game/Scoring.ts`, weights
in `src/config.ts`):

| Tier | Risk | Multiplier |
| --- | --- | --- |
| Steady | < 0.30 | ×1.0 – ×1.5 |
| Bold | 0.30 – 0.55 | up to ×2.2 |
| Daring | 0.55 – 0.80 | up to ×3.1 |
| Knife-edge | ≥ 0.80 | up to ×4 |

`points = (10 + 2·level) · (1 + 3·risk^1.5) · combo + closeCall`

* **Combo:** consecutive placements with risk ≥ 0.5 build a combo
  (×1.25, ×1.5 … capped at ×3); a safe placement ends it.
* **Close call:** if the new stone rocks more than 9° away from where it finally
  rests, or an older stone sways > 3.5° and recovers, you get a bonus. A big
  wobble also triggers a short slow-motion moment — the physics is still the
  fixed-step simulation, it just runs fewer steps per real second.

There is **no fake stability**: every stone stays a dynamic rigid body for the
whole game, nothing is frozen, welded or scripted. Bodies only sleep through
Rapier's normal sleeping mechanism and wake up when touched.

---

## Implemented features

**Physics (Rapier 3D, `src/physics`, `src/game/Simulation.ts`)**
* Fixed 120 Hz step with accumulator, max 8 steps per frame, render
  interpolation (smooth at 60 Hz and on 120 Hz ProMotion displays).
* All physics and gameplay parameters in `src/config.ts` (gravity, damping,
  solver iterations, contact skin, CCD sub-steps, friction, settle thresholds…).
* Per-rock friction, restitution and density (granite, sandstone, basalt,
  slate, quartzite, limestone).
* Exact mass properties: volume, centre of mass and full inertia tensor are
  integrated from the visual mesh and diagonalised (Jacobi) — Rapier receives
  the stone's true principal inertia and frame.
* Convex-hull colliders fitted to the visual mesh: the visual surface never
  pokes through its collider and hides at most a few millimetres inside it
  (enforced by tests).
* Contact-force events → impact sounds, dust, shake, haptics; collision events
  → failure detection; water drag for stones that fall into the stream.

**Stones (`src/stones`)**
* Procedural, deterministic stones: lumpy superellipsoid intersected with flat
  cleavage planes, weathered by Taubin smoothing, with ~1 mm relief.
* Archetypes: slab, disc, wedge, cobble, block, pebble (+ boulder for the base);
  difficulty ramps with height (more cobbles, wedges and pebbles, smaller stones).
* Stable resting poses computed from the hull (tipping angle per face) — the
  **Flip** button cycles them.
* Per-stone colouring: mineral palettes, mottling, sedimentary banding, quartz
  veins, lichen spots, cavity darkening.
* Generated in a Web Worker and prefetched one stone ahead.

**Rendering (`src/render`)**
* Physically based materials (MeshStandardMaterial + custom shader chunks),
  ACES tone mapping, sRGB output.
* Procedural tileable PBR textures rendered on the GPU at start-up (stone
  grain/pits/speckles, sand ripples, pebble beds, moss, water normals/caustics).
* Triplanar, UV-free stone shading in object space (textures stick to moving
  stones), wet darkening and underwater light absorption.
* Riverbank: meandering stream, sand/gravel/moss/earth splat terrain, animated
  water with fresnel reflections, depth-based transparency, foam and
  caustics; pebble and boulder scatter, wind-animated grass and reeds, bushes,
  a distant tree line, analytic sky with clouds, image-based lighting and
  exponential fog for atmospheric depth.
* Warm late-afternoon sun with soft PCF shadows that follow the tower
  (texel-snapped against shimmering).
* Ambient occlusion via baked cavity terms (vertex + texture), no SSAO pass.

**Game feel**
* Subtle input smoothing (45 ms), speed-dependent drag gain for precision.
* Synthesised, material-specific impact sounds (modal synthesis tuned by rock
  type, stone size and real impact speed), scraping/grinding driven by sliding
  speed, splashes with bubbles, stream ambience, birds, UI chimes.
* Dust puffs, stone chips, water droplets and ripples.
* Trauma-based camera shake (disabled with *Reduce Motion*), dynamic framing
  that grows with the tower, follows a leaning tower and pulls back for the
  collapse; slow orbit on the results screen.
* Haptics: Vibration API on Android; on iOS 18+ the system haptic of a hidden
  `<input switch>` is used as a best-effort fallback.
* Score popups with risk tier, combo badge, close-call bonus, count-up score.

**Engineering**
* Module layout: `physics/`, `stones/`, `game/` (state machine, scoring,
  stability, simulation, orchestration), `render/`, `input/`, `audio/`, `ui/`,
  `platform/`, `storage/`, `world/`.
* Pure, tested state machine (`GameStateMachine.ts`) and scoring
  (`Scoring.ts`).
* Deterministic seeds: `?seed=1234` fixes the stone sequence; the debug overlay
  exports a replay link (`?replay=…`) that re-runs the exact placements.
* Debug overlay: FPS, frame/physics timings, draw calls, resolution scale,
  bodies awake, held-stone mass/friction/hull, settle tracking, last stability
  analysis (margin, contacts, slope, overhang, risk breakdown), Rapier collider
  wireframes, support polygon + centre-of-mass markers, 0.25× slow motion.
* Local high scores, history and settings in `localStorage`
  (versioned, corruption tolerant, works without storage).
* Errors never degrade silently: missing WebGL, a failed start or a lost GPU
  context show an explicit message with a reload button.

### iPhone & iPad optimisation

* `viewport-fit=cover` + `env(safe-area-inset-*)` everywhere (notch / Dynamic
  Island / home indicator, portrait and landscape).
* Home-screen web app: manifest, apple-touch-icon, black-translucent status bar,
  standalone detection with an *Add to Home Screen* tip, offline service worker.
* No page scrolling, rubber-banding, pinch-zoom, double-tap zoom, text
  selection or long-press callouts (`touch-action`, non-passive `touchmove`,
  `gesturestart` handling, `user-select`/`touch-callout`).
* Thumb-friendly controls: centred bottom bar on iPhone portrait; split
  two-handed layout (rotate/flip left, drop right) in landscape and on iPad;
  larger buttons on iPad; glass buttons only where they don't cost much.
* Canvas sized from `visualViewport`, re-measured after orientation changes
  (iOS reports the new size late).
* Device pixel ratio capped (iPhone renders at DPR 2 instead of 3) and an
  adaptive resolution controller that lowers/raises render scale based on
  measured frame times; if fewer pixels don't help (the 30 fps cap of Low Power
  Mode), it restores full resolution instead of degrading needlessly.
* Quality tiers (auto: iPad → *Quality*, iPhone → *Balanced*, low-end Android →
  *Performance*; overridable in Settings or with `?quality=`).
* Audio: AudioContext created/resumed inside a user gesture, silent-buffer
  unlock for older iOS, `navigator.audioSession.type = 'ambient'` (respects the
  silent switch and mixes with music), suspended in the background.
* Pauses automatically when the app is backgrounded; handles WebGL context
  loss (iOS can reclaim GPU memory).
* Physics runs in WASM; stone generation in a module Web Worker (iOS 15+).

---

## Assets and licences

All textures, meshes, sounds and icons are **generated procedurally by this
project's own code** (`src/render/TextureFactory.ts`, `src/stones/*`,
`src/render/Environment.ts`, `src/audio/AudioEngine.ts`,
`scripts/make-icons.mjs`). No third-party art or audio is bundled, so there are
no asset licences to track.

CC0 texture libraries (Poly Haven, ambientCG) were the first choice but were
not reachable from the build environment; per the brief, procedural
alternatives were generated instead. Swapping in real CC0 PBR scans later is
straightforward: the stone shader expects a tileable normal/grain map pair
(`tStoneA`/`tStoneB`), the terrain one sand/pebble/moss maps.

Third-party code (npm): three.js (MIT), @dimforge/rapier3d-compat (Apache-2.0),
Vite (MIT), TypeScript (Apache-2.0), Vitest (MIT).

---

## Tests

* `tests/scoring.test.ts` — risk computation, tiers, multipliers, combos,
  close-call bonus, purity.
* `tests/stateMachine.test.ts` — the full transition table, invalid events,
  listeners, restart from every phase.
* `tests/geometry.test.ts` — convex hulls, signed polygon distances, the
  stability analysis.
* `tests/stoneShape.test.ts` — deterministic generation, mass properties for all
  archetypes, collider/visual alignment, Rapier contact-feature limits.
* `tests/physics.test.ts` — real Rapier simulations: a centred stone settles
  and measures as stable, a stone over the edge falls and is detected, offset
  stones measure as riskier, identical inputs are deterministic, a 6-stone stack
  stands without any fake support.
* `tests/storage.test.ts` — persistence, history limit, settings, corrupt data,
  private mode.
* `scripts/e2e.mjs` — production build in emulated *iPhone 15 Pro* and *iPad Pro
  11 landscape*: boot, real CDP touch drag / two-finger twist, buttons, three
  placements, pause/resume, deliberate failure, results screen, instant restart,
  persisted best score, no scrolling, no runtime errors.

### Latest results

* `npm run build` — type-check clean; bundle ≈ 1.0 MB gzip (Rapier WASM 830 kB,
  three.js 132 kB, game 50 kB, stone worker 21 kB).
* `npm test` — **46/46** tests passed (6 files).
* `npm run test:e2e` — **30/30** checks passed on *iPhone 15 Pro* and
  *iPad Pro 11 landscape* emulation.
* Physics budget: a 12-stone tower with every body awake costs ≈ 0.4 ms per
  120 Hz step on a desktop CPU (≈ 0.8 ms per 60 Hz frame).
* A sweep over 150 random stones generated without errors; every collision
  hull respects the 4-vertex face limit.

---

## Project layout

```
index.html               app shell, HUD and screens (static markup)
public/                  manifest, service worker, generated icons
scripts/                 e2e test, screenshot helper, icon generator
src/config.ts            every tunable parameter
src/core/                rng (sfc32), noise, maths, 2D geometry, quaternions
src/physics/             Rapier loader + fixed-step world
src/stones/              stone recipes, generator, hulls, mass properties, worker
src/world/               terrain height field, base rock
src/game/                state machine, scoring, stability, simulation, Game
src/render/              renderer context, textures, materials, environment, camera, effects
src/input/               touch/mouse/keyboard placement input, page-gesture lock
src/audio/               procedural Web Audio engine
src/ui/                  HUD, debug overlay, styles
src/platform/            device detection, haptics
src/storage/             scores & settings
tests/                   Vitest suites
```

---

## Known limitations

* **Not verified on physical iOS hardware.** Development and automated tests ran
  in Chromium with iPhone/iPad emulation and software WebGL. Safari-specific
  behaviour (audio session, the iOS 18 haptic fallback, ProMotion frame pacing,
  real GPU performance) is implemented per documentation but not measured on a
  device.
* **Rapier contact quirk:** Rapier/Parry merges nearly coplanar hull triangles
  into polygon faces but only uses the first four vertices of a face for
  contact generation (a TODO in Parry). Large flat stone faces then produce a
  single contact point and deep interpenetration. The generator works around
  it (`limitFaceVertices` in `src/stones/hull3d.ts`, guarded by a test): each
  large face keeps its largest inscribed quad and the remaining rim vertices
  are lowered by 3 mm, which the rounded visual edges already cover.
* Hull colliders are convex; concave details of the visual surface (≈1–3 mm)
  are bridged.
* No screen-space ambient occlusion or post-processing; AO is baked.
* Vegetation and trees are stylised procedural geometry hidden by distance fog;
  close up they read as low-poly.
* The replay system is deterministic only within the same build and browser
  engine (WASM float determinism is not guaranteed across engines).
* Changing the graphics preset reloads the page.

## Recommended next improvements

1. Profile on real iPhones/iPads (Safari Web Inspector) and tune tier defaults.
2. Replace procedural textures with scanned CC0 PBR sets (Poly Haven) and add
   photogrammetry-style hero stones.
3. Optional SSAO/GTAO pass on the *Quality* tier; contact shadows for small
   stones.
4. Daily-seed challenge mode with shareable replays and an online leaderboard.
5. More stone types (long standing stones, river-polished spheres) and wind
   gusts as an optional hazard.
6. Accessibility: colour-blind safe risk colours, larger UI option, VoiceOver
   labels for the results screen.
