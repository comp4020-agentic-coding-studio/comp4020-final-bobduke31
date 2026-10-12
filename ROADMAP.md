# Final development roadmap

A persistent, ordered list of the remaining work toward the Final project's
visual and functional bar (Inkarnate/Wonderdraft-style cartography, per
`CLAUDE.md`), tracked here so status, chosen approaches, and open problems
survive across sessions instead of living only in chat history. Work happens
on a local development branch (currently `c10-3d-terrain`); nothing here
touches the deployed C9 release or production data unless a task explicitly
says so and is approved first.

**How this file is used:** one task worked on at a time, in the order below.
Each task gets an assessment (2-3 approaches, scored) *before* any code is
written, approval is asked for before implementing, and the task's section
is updated with the chosen approach, real browser screenshots, and honestly-
stated remaining problems once implemented - not closed out until the
rendered result has actually been looked at.

**Screenshots and reference images** referenced from this file live under
`research/roadmap/` (`references/` for externally-provided target images,
`screenshots/` for dated progress captures). Like the rest of `research/`,
that directory is gitignored local dev material, not shipped - this file
cites them by relative path with a description, the same way `PROCESS.md`
cites commits as evidence rather than embedding diffs.

**Scoring convention:** every dimension is out of 10, higher is always
better (for "implementation cost," 10 = cheap/fast, 1 = expensive/slow).

## Status legend

- ⬜ Not started
- 🔍 Assessed - comparison written, awaiting approval to implement
- 🔨 In progress
- ✅ Done (remaining known limitations stated inline, not hidden)

## Already completed (context, not part of this ordered list)

- **C9 real-time sync** - shared terrain grid, SQLite persistence, SSE
  broadcast. See `PROCESS.md` and `ADR.md`.
- **3D heightfield renderer** - Three.js/WebGL2 Oblique view replacing the
  old column-extrusion canvas renderer, real lighting/shadow, ridged-noise
  geometric detail, instanced tree billboards, ray-heightfield picking. See
  `terrain-renderer-3d.js`. Known shortcomings feed directly into tasks 2, 3,
  6, and 8 below - this work is the baseline those tasks improve on, not a
  finished result.
- ✅ **Brush precision (stroke accumulation)** - `paintAlong` used to place a
  full-strength stamp on every `pointermove` event, so a slow drag (many
  move events over a short distance) could apply dozens of overlapping
  stamps where a fast drag over the identical path applied only a handful.
  Replaced with `stampAlong`: stamps are placed at a fixed minimum spacing
  along cumulative distance travelled, not event count. Verified: an
  identical path driven by 2 vs. 80 pointermove events now produces the
  exact same elevation change (ratio 1.000). Brush-size/strength slider
  floors also lowered (4→1 cell, 0.03→0.01) so a single click can make a
  genuinely small, subtle change.
  **Remaining limitations, not fixed by this change:** this only fixed *how
  much* a stroke changes per unit of distance - it did not touch *what*
  elevation values are reachable or *how* they're rendered. The brush still
  cannot touch sea cells at all (by design, until task 1 below), mountains
  painted with it can still produce steep, narrow forms the renderer then
  exaggerates (task 2), and there is still no gradual blending between
  painted terrain types (task 7). Those are open tasks below, not
  regressions from this fix.

---

## 1. Fixed sea level and editable shallow/deep seabed

**Status:** ✅ Done (remaining limitations stated below) - Approach A
implemented and verified.

### Root cause (verified in code, not assumed)

There is no water surface in this app - only a single elevation scalar per
cell. A "sea" cell is just a cell whose elevation is `<= SEA_LEVEL`, rendered
blue. Confirmed directly in `terrain-renderer-3d.js`: `detailedHeight`
returns `rawElevation(cell)` unchanged for any cell at or below sea level,
and the vertex shader displaces the mesh straight to `h * HEIGHT_SCALE` with
no floor. **The geometry you see as "water" is the seabed itself.** Two
visible symptoms follow directly from this, not from two separate bugs:

- Deepening a seabed cell visibly lowers the "water" at that point, because
  there is nothing else there to stay level.
- A beach at +0.05 next to a trench at −0.5 is a real ~25-unit vertical wall
  in the mesh at `HEIGHT_SCALE=46` - the "unnatural cliffs" at coastlines
  reported in the oblique view
  (`research/roadmap/screenshots/2026-10-12-oblique-pillar-cliff-issue.png`).

Separately, but compounding the same complaint: `setLandElevation` (used by
Raise/Lower/Smooth/Mountain/Peak) explicitly refuses to touch any cell
`<= SEA_LEVEL` - by design, this is what the Crit-9 coastline-erosion bug fix
enforces (see `PROCESS.md`, `ADR.md`). The *only* tools that can touch sea at
all are Create Land / Paint Sea, which push toward a **fixed** target
(`SEA_LEVEL ± 0.35`), not a continuously adjustable depth. There is
currently no way to gradually sculpt "shallow" vs. "deep" water at all.

### Approaches compared

| | A. Flat water plane + extend sculpting to seabed | B. Visual-only depth compression (no new tool) | C. Full hydrology model (per-body water mesh, waves, shoreline foam) |
|---|---|---|---|
| **Summary** | Add a static, semi-transparent flat plane at `y = SEA_LEVEL * HEIGHT_SCALE`. Compress how far the seabed mesh is allowed to visually drop beneath it (so a trench reads as "deep water" by colour, not as a hole in the world). Extend Raise/Lower to act on sea cells too, under a new `SEABED_CEILING` clamp mirroring `LAND_FLOOR` - sea can get shallower/deeper, but (like today) can't cross into land except via Create Land. | Keep one mesh, no new tool. Just clamp/soften how far underwater geometry can visually drop (e.g. a sqrt/log curve) so the cliff softens. | Flood-fill connected sea/lake regions into distinct water bodies, each with its own animated shader (waves, Fresnel-ish shading, shoreline foam, real depth-based transparency). |
| Visual quality | 9 | 5 | 10 |
| Feasibility | 7 | 9 | 3 |
| Style consistency | 9 | 4 | 10 |
| Impl. cost (10=cheap) | 6 | 9 | 2 |
| Performance | 9 | 10 | 6 |

**Risks:** Approach A touches the same elevation/sea boundary the
coastline-erosion bug lived in - the new sea-side clamp needs the same care
(`ADR.md` cross-referenced, a test mirroring the existing land-floor test)
or it risks reopening that class of bug from the other direction. Approach C
is a much larger, multi-week undertaking (region detection, new shader,
likely new geometry per water body) - worth keeping on record for task 9
(coastlines/rivers/lakes) rather than attempting here.

**Recommendation:** Approach A. It is the one option that fixes both
reported symptoms (dropping "water surface," unnatural cliffs) from their
actual shared cause, stays within the existing single-elevation-channel data
model (no schema change), and is a bounded, reviewable change. B is a
tempting quick patch but leaves the "can't control shallow/deep" complaint
completely unaddressed. C is the right *eventual* answer for real rivers/
lakes/shorelines but is out of proportion to this task - flagged for task 9.

### Implementation

Approach A, implemented as:

- `terrain-renderer-3d.js`: a new static `buildWaterPlaneGeometry()` mesh -
  a flat plane at `y = SEA_LEVEL * HEIGHT_SCALE`, independent of the seabed
  mesh - added to the scene as a semi-transparent `MeshStandardMaterial`
  (`THREE.DoubleSide`, opacity 0.82). The seabed mesh itself is unchanged:
  it still displaces straight to `elevation * HEIGHT_SCALE` with no floor,
  but is now rendered *underneath* a water surface that never moves, so a
  deepened trench reads as "water gets darker/deeper" rather than "the
  water surface drops."
- `world-client.js`: a `SEABED_CEILING = SEA_LEVEL - 0.02` clamp mirroring
  `LAND_FLOOR`, and a new `setSeabedElevation(x, y, elevation)` - the mirror
  of `setLandElevation` - which refuses any cell currently `> SEA_LEVEL`
  (so it can never create land) and clamps its result to
  `[ELEVATION_MIN, SEABED_CEILING]` (so it can never reach land either).
  Two new tools, **Deepen** and **Shallow**, call it through the existing
  `forEachBrushCell`/brush-strength/falloff pipeline, exactly like every
  other elevation tool - no new input or rendering path.
- `index.html`: a new "Water" tool group (Deepen/Shallow) and an updated
  tool-hint paragraph documenting the Raise/Lower-vs-Deepen/Shallow symmetry
  and the fixed water surface.

No change to `src/terrain.ts`, the SQLite schema, or the REST/SSE contract -
Deepen/Shallow send ordinary `terrain:update` cell batches, identical in
shape to every other elevation tool.

### Verification (real browser, both dev servers, Playwright)

Tested against the seeded reference scene
(`scripts/seed-test-scene.ts`) at `localhost:8800` and a fresh empty DB at
`localhost:8801` for `pnpm check`:

- **Oblique view**: screenshots before/after Deepen (near the coast, the
  exact spot that previously showed a cliff) and after Shallow confirm the
  water surface stays flat and level in both cases - no visible drop, no
  cliff. Deepening reads as a natural darker patch under the still-flat
  water; shallowing reads as a lighter patch nearby. Creating new land
  mid-sea (regression-testing the unrelated Create Land tool together with
  this change) now correctly pokes up *through* the flat water plane as a
  small island, confirming the two surfaces are genuinely independent.
- **Top-down view**: same Deepen/Shallow test repeated - darker/lighter
  patches appear in the sea at the painted location, coastline unmoved.
  Confirms the fix needed no top-down-specific changes, as expected (the
  2D renderer never drew a water surface to begin with).
- **Picking accuracy**: both tools' brush strokes landed on the intended
  sea cells in both views (ray-heightfield picking for oblique, direct
  grid mapping for top-down) - no off-by-cell drift observed.
- **Regression (existing tools)**: Raise, Mountain, and Create Land
  exercised in the same session after the Deepen/Shallow edits; all behaved
  as before (land-only elevation changes, coastline-only-via-Create-Land),
  confirming `setLandElevation`'s land-only invariant was not disturbed by
  the new seabed-only sibling function.
- **Real-time sync**: a second independent browser session, instrumented to
  capture raw SSE frames, received live `terrain:update` events for both
  the Deepen and Shallow edits made in the first session, with no reload.
  Elevation values in the captured payload are clamped exactly as designed
  - every value strictly negative, several pinned at precisely `-0.02`
  (`SEABED_CEILING`), none ever reaching `SEA_LEVEL` or above. Each batch is
  paired with a `terrain-type:clear` event; traced to the server's existing,
  pre-existing rule in `src/terrain.ts` ("any cell at/below `SEA_LEVEL` loses
  its terrain type") - a no-op here since sea cells carry no terrain type,
  not a new interaction introduced by this task.
- **Persistence**: verified via the same seeded dev DB surviving across the
  Playwright runs in this session (elevation writes round-tripped through
  SQLite and were present on reload, same persistence path every other
  elevation tool already uses).
- **Automated checks**: `pnpm typecheck` clean; `pnpm test` 18/18 passing
  against a fresh empty DB; `pnpm check:evidence` passing. No server-side
  or schema changes were needed, so none of this was expected to move, and
  it didn't.

### Remaining limitations (not fixed by this change, not hidden)

- The water plane is a single flat, static surface - no waves, no
  shoreline foam, no per-water-body distinction (a lake and the ocean look
  identical). That is Approach C from the comparison above, deliberately
  deferred to task 9 (coastlines, rivers and lakes).
- Depth is communicated only by the seabed mesh's own color/shading showing
  through the semi-transparent plane - there is no dedicated depth-based
  color ramp (e.g. a shallow turquoise vs. deep navy gradient) yet. That
  refinement is left for task 9 as well, rather than scope-creeping into
  this task's brush-mechanics fix.
- Deepen/Shallow use the same brush falloff as every other tool; task 2
  (natural elevation and slope transitions) still applies equally to the
  seabed as to land.

---

## 2. Natural elevation and slope transitions

**Status:** ✅ Done (remaining limitations stated below) - Approach B
implemented and verified.

Scope: mountains/hills should read as naturally-formed landforms (broad
bases, gradual slopes, occasional sharp ridgelines where geologically
plausible) rather than narrow spikes, cliffs, or abrupt height changes -
while fine brush control (small, predictable, subtle adjustments) stays
intact. This is deliberately sequenced after task 1, since both touch the
same displacement/detail shader path - the slope-gating logic below is
addressed once, now that the water-surface work has settled that area,
rather than twice.

### Root cause (verified in code, not assumed)

Two independent mechanisms both contribute, confirmed by reading the actual
brush and shader code rather than from the prior visual impression alone:

- **Brush mechanics (`world-client.js`):** `forEachBrushCell` (around line
  224) gives every stroke a hard circular cutoff - `if (dist > r) continue`
  - with a smoothstep falloff *inside* that radius but exactly zero
  influence the instant a cell is outside it. Mountain and Peak
  (`paintAt`, lines 329-352) don't add height proportional to brush
  strength the way Raise/Lower do; they `lerpTowards(current, TARGET,
  falloff)` toward a fixed target (`MOUNTAIN_TARGET = 0.6`,
  `PEAK_TARGET = 0.95`). Repeated stamps along a drag (already
  distance-paced since the brush-precision fix) keep pulling every cell in
  radius closer to that same fixed target, including cells near the edge
  where falloff is small but nonzero - so a sustained stroke doesn't
  converge to a soft dome, it converges to a near-uniform plateau at the
  target elevation, with a cliff exactly at the brush's radius where
  influence hits zero. This is a data problem, not a rendering problem:
  the authoritative `elevationGrid` itself ends up with the abrupt step,
  so every view (top-down and oblique) shows it.
- **Detail-shader gating (`terrain-renderer-3d.js`, `HEIGHT_SAMPLE_GLSL`,
  `detailedHeight()`):** the ridged-noise amplitude is gated by
  `aboveSea = base - SEA_LEVEL` - raw elevation above sea level - not by
  the terrain's actual local steepness. A broad, gently-rising plateau at
  high elevation gets just as much jagged ridge noise as a narrow, steep
  spike at the same elevation, because the shader has no way to tell them
  apart. This exaggerates whatever steepness the brush mechanics above
  already produced, rather than independently causing it - fixing the
  brush alone would still leave tall land looking jagged everywhere, and
  fixing only this would still leave the underlying plateau-with-a-cliff
  shape in the authoritative data.

### Approaches compared

| | A. Brush-mechanics rework + slope-based noise gating (no new data pass) | B. Local post-stroke relaxation pass + mechanics + noise gating | C. Full procedural erosion/weathering simulation |
|---|---|---|---|
| **Summary** | Replace Mountain/Peak's "lerp to fixed target" with an additive push scaled by brush strength and falloff, same model Raise/Lower already use (predictable, bounded per stamp, matches the brush-precision fix's philosophy). Extend `forEachBrushCell`'s falloff to taper smoothly to zero over a wider radius than the brush UI circle (a soft outer skirt) instead of a hard cutoff, so adjacent stamps and strokes blend at their edges. Separately, change `detailedHeight()`'s gate from raw elevation to an actual local-slope estimate (finite-difference gradient magnitude of the height texture, the same technique the vertex shader already uses for normals) so flat high ground stays smooth and only genuinely steep terrain gets jagged detail. | Everything in A, plus: after each stroke, run a small number of bounded diffusion/max-slope-limiting iterations restricted to the stroke's own dirty bounding box (already tracked by `markDirty`) plus a small padding ring - any two adjacent cells differing by more than a tunable max slope have some height redistributed between them. This directly reshapes the authoritative data so even two separately-painted, differently-targeted strokes next to each other get a graded transition, not just a single stroke's own edge. | A full terrain-simulation pass (simplified hydraulic/thermal erosion: simulate material transport downhill, talus-angle settling, iterative relaxation across the whole grid or large regions) run as a distinct, user-triggered "weathering" step, independent of individual brush strokes - closer to procedural terrain generation than a painting-tool fix. |
| Visual quality | 7 | 9 | 9 |
| Feasibility | 9 | 7 | 4 |
| Style consistency | 8 | 9 | 8 |
| Impl. cost (10=cheap) | 8 | 6 | 2 |
| Performance | 9 | 7 | 4 |

**Risks:** Approach A only fixes the shape of a *single* stroke's own
boundary - two separate strokes painted next to each other at very
different target elevations (e.g. a mountain stroke directly beside an
untouched plain) still meet at a real step in the data, just a softer one
than today. Approach B's relaxation pass needs the same care Task 1's
`SEABED_CEILING`/`LAND_FLOOR` clamps required: it must never pull a land
cell below `SEA_LEVEL` or a sea cell above it (reusing those existing
clamps when redistributing height, not inventing a new boundary rule), and
its iteration count must stay small and bounded to a local region or it
risks the same per-stroke performance problem the brush-precision fix was
about - a slow drag triggering expensive repeated full passes. Approach C
is a genuine terrain-generation feature in its own right (region selection,
convergence tuning, likely a progress/preview step since it could visibly
reshape a large area in one action) - worth recording here as the
"procedural generation" direction already scoped as task 11, not attempted
as part of a painting-tool fix.

**Recommendation:** Approach B. It fixes the actual root cause (the
authoritative data, not just how it's shaded) rather than Approach A's
partial fix, which would still show steps between independently-painted
features; it stays bounded and local by reusing the dirty-region tracking
`markDirty` already maintains, rather than Approach C's grid-wide
simulation, which is a far larger undertaking better scoped to task 11.
The slope-based noise-gating fix is shared across A and B regardless, since
it was already identified as part of this task's root cause in the
original combined assessment - B does not raise its cost further.

### Implementation

Approach B, implemented with two corrections from review before coding
(keep the smallest brushes precise - natural falloff must not expand the
selected radius; don't amplify already-extreme slopes with ridge noise)
folded in, as:

- **Relaxation pass (`world-client.js`)**: `relaxRegion`/`relaxPair`, run
  once per stamp, scoped to that stamp's own brush footprint plus a fixed
  1-cell `RELAX_PADDING` (not scaled with brush radius - the first
  correction above rules out anything that widens the effective brush).
  Only nudges adjacent-cell pairs whose difference exceeds
  `MAX_NATURAL_SLOPE = 0.15`, moving a fraction (`RELAX_FACTOR = 0.25`) of
  the excess between them per iteration (`RELAX_ITERATIONS = 2`). Never
  touches a pair straddling the coastline (one land, one sea) - that
  boundary stays the one intentionally sharp edge in this model, per
  `ADR.md` - and reuses the existing `LAND_FLOOR`/`SEABED_CEILING` bounds
  so it can never itself push a cell across that boundary either.
- **Mountain/Peak Strength fix (`world-client.js`)**: these two tools were
  found, while implementing, to ignore the Strength slider entirely -
  `lerpTowards(current, TARGET, falloff)` with no `brushStrength` factor at
  all, so a single click at the brush centre jumped straight to
  `MOUNTAIN_TARGET`/`PEAK_TARGET` regardless of Strength. This turned out
  to be the main reason a small, modest-radius stroke still read as an
  instant narrow cone even after the relaxation pass above: there was no
  "build up gradually" path for the relaxation pass to work with. Fixed by
  multiplying the lerp factor by `brushStrength`, the same integration
  every other elevation tool already has.
- **Renderer noise gating (`terrain-renderer-3d.js`, `detailedHeight()`)**:
  kept the original, already-good elevation-based envelope
  (`slopeGate`/`amplitude`) unchanged - verified by direct screenshot
  comparison that it already produces smooth, well-tapered mountains with
  no changes at all - and added `extremeDamping`, a ceiling that only
  reduces amplitude on local slopes beyond what the relaxation pass (or
  this scene's own natural terrain) ever produces. Local slope is measured
  at a wider sampling radius (`slopeEps = 2.2`, versus the vertex shader's
  own `eps = 0.6` used for normals) specifically because a narrow sampling
  window reads the *pointwise* gradient, which spikes at any sharp kink in
  the data - not just a genuinely steep face, but also the seam where this
  app's seed data (or repeated overlapping brush strokes) combine two
  bumps with `max()`.

**Two false starts along the way, kept in git history rather than erased**
(commit history on this branch shows the iteration; the final shader code
above is the only version shipped): a first attempt replaced the elevation
gate outright with a pure slope gate, which visibly turned the coastline -
an intentional, by-design discontinuity, not an artifact - into a jagged
line, since a slope-only gate has no way to tell a genuine mountain face
from the coastline at a similar local gradient. Narrowing the slope band
and widening the sampling `eps` reduced but didn't fix this, and introduced
a second, different regression: new isolated spikes appeared partway down
otherwise-smooth hillsides, traced to a pure slope gate being zero at a
dome's flat summit and peaking in a "halo ring" partway down the flank
instead - a shape the original elevation-based envelope never had, which
let the ridged-noise function's own occasional sharp crests show through
as visible pokes. Both were caught by rendering the actual result next to
the unmodified baseline on identical seed data, not assumed from the shader
code alone - the fix described above (keep the proven envelope, add only a
top-end damping ceiling) was the version that matched the baseline exactly
on unedited terrain while still measurably damping pathological slopes.

### Verification (real browser, Playwright, against the proven baseline)

- **No regression on existing terrain**: the seeded mountain range and
  coastline render pixel-for-pixel consistent with the unmodified pre-task-2
  formula (direct screenshot A/B comparison) - confirms the renderer change
  is a pure ceiling, inert for any terrain within normal bounds.
- **New Mountain/Peak features**: built up over several repeated strokes
  (not one click), both features read as rounded domes with a soft,
  gradient falloff in top-down - visually consistent with the existing
  seeded domes - rather than the narrow cone a single full-target click
  produced before the Strength fix.
- **Per-cell slope bound confirmed quantitatively**, not just visually:
  queried the actual post-relaxation elevation data directly from SQLite
  for a freshly-painted Peak feature - maximum adjacent-cell difference
  0.143, under the `MAX_NATURAL_SLOPE = 0.15` threshold, confirming no
  literal cliff survived relaxation.
- **Smallest-brush precision preserved**: a radius-1, strength-0.05 Raise
  click produced a single, barely-visible precise mark, confirming the
  fixed (not radius-scaled) `RELAX_PADDING` doesn't expand or blur a tiny,
  deliberate edit.
- **Real-time sync**: a second session, instrumented to capture raw SSE
  frames, received the relaxation pass's extra queued cells (226 cells
  across 2 batches for one Mountain feature, well beyond the brush's own
  footprint) live, with no reload.
- **Persistence**: reloaded the painting session and confirmed the new
  features and their relaxed surroundings survived exactly as painted.
- **Automated checks**: `pnpm typecheck` clean, 18/18 tests pass against a
  fresh DB, `pnpm check:evidence` passes. No server, schema, or API change.

### Remaining limitations (not fixed by this change, not hidden)

- A small-radius Peak/Mountain stroke pushed to full target still reads as
  a proportionally steep, spire-like landform in the oblique view (not a
  gentle rounded hill), even though its per-cell slope is now bounded and
  graded, not a cliff. This is an inherent consequence of a small footprint
  plus a high target elevation plus this renderer's strong vertical
  exaggeration (`HEIGHT_SCALE = 46`) - the same math that makes the seed
  scene's large dominant peak read as an appropriately sharp summit. Fixing
  it would require either widening the brush's effective footprint (ruled
  out by this task's own correction) or reducing the vertical exaggeration
  generally (a task 4 "overall rendering" concern affecting all terrain,
  out of scope here).
- Two strokes painted far enough apart that their relaxation regions
  (brush radius + 1 cell) never overlap still meet at whatever step their
  two target elevations leave - this pass only graduates transitions
  *within* a radius-plus-one-cell neighbourhood of where painting actually
  happened, by design (correction 1), not between arbitrarily distant
  features.
- `MAX_NATURAL_SLOPE`, `RELAX_FACTOR`, and `RELAX_ITERATIONS` were tuned
  against this app's own seed scene and the two corrections above, not
  derived from a general principle - they may need revisiting once task 7
  (material blending) or a larger, more varied map surfaces cases this
  scene didn't.

## 3. Camera controls: four viewing directions, adjustable tilt/zoom/pan, automatic framing

**Status:** ✅ Done. Scope expanded 2026-10-12 (originally just the four
directions) - see below. Implemented and verified 2026-10-13 using
Approach A.

**Known bug motivating this task:** the oblique camera's tilt, distance, and
orthographic frustum size are all fixed constants chosen for one test scene
(`terrain-renderer-3d.js`: `distance = 260`, `tiltFromVertical = 58°`,
`viewSize = GRID_SIZE * 0.62`). A tall enough mountain can rise outside that
fixed frustum and get clipped at the top of the canvas - the frustum doesn't
adapt to what's actually been painted. This needs fixing as part of this
task, not worked around by just picking different fixed constants, since any
fixed framing fails again on a different map.

Scope now covers four related controls, not just direction:

- **Four fixed azimuth presets** (N→S, S→N, E→W, W→E) - as originally
  scoped. Needs re-verification that ray-heightfield picking, shadow
  direction, and tree-billboard facing (currently assumes one fixed view
  direction - see "Already completed" above) all stay correct from each.
- **Adjustable tilt**, from near-top-down down to a low, more dramatic side
  perspective - a slider or similar, not just the azimuth presets. Picking
  (`pickAgainstHeightfield`) and billboard facing need to keep working
  continuously across the tilt range, not just at the current one fixed
  angle.
- **Zoom and panning** - currently the orthographic frustum is a fixed size
  centred on the map; needs real camera movement/zoom controls while
  preserving accurate click-to-cell picking at any zoom/pan state.
- **Automatic framing** - the frustum (and plausibly the camera distance)
  should size itself to what's actually painted (fixing the clipping bug
  above as a side effect of always framing correctly, rather than as a
  one-off constant tweak), and re-frame sensibly when terrain is edited
  rather than requiring a manual zoom-out.

### Root cause / preconditions (verified in code, not assumed)

- **Picking needs no new algorithm.** `pickAgainstHeightfield` (confirmed
  by reading it) is a pure ray-march in world space - it takes whatever
  `origin`/`direction` the camera's own `raycaster.setFromCamera` produces
  and has no assumption about viewing direction baked in anywhere. Every
  approach below gets accurate picking "for free" in any azimuth/tilt/zoom/
  pan state, *as long as the camera object's transform is correctly updated
  before `pick()` runs* - the real risk is wiring, not the picking math
  itself.
- **Tree billboards are NOT real billboards today.** Confirmed in
  `buildTreeLayer`: each instance's matrix sets only position and scale,
  never rotation - the planes keep one fixed world-space orientation
  (`PlaneGeometry`'s default +Z-facing normal), which happens to face
  roughly toward the camera only because today's camera sits on the +Z
  side of the map. Viewed from a different azimuth (or even just a very
  different tilt), these would render edge-on - nearly invisible 2D
  cutouts. This is a real, required fix bundled into this task (not a new
  one), already named in this file's scope above.
- **The sun is fixed in world space** (`sun.position.set(-80, 160, 60)`),
  independent of camera azimuth - physically correct (the sun doesn't move
  because the viewer turns around) but means some azimuths will look
  backlit/flatter than others, since the lit side of a ridge doesn't
  rotate with the camera. Named as a limitation below, not solved here -
  revisiting light direction per-azimuth is a material/lighting-quality
  question better scoped to task 6 (oblique art quality).

### Approaches compared

| | A. Unified parametric camera (hand-rolled) | B. Three.js `OrbitControls`/`MapControls` adapted to 4 snapped azimuths | C. Four independent fixed presets, no real auto-framing |
|---|---|---|---|
| **Summary** | Generalise the existing fixed camera math (`distance`, `tiltFromVertical`, `viewSize`, a fixed `center`) into live state: `azimuth` (snapped to 4 presets by the direction buttons), `tilt` (continuous, slider-driven), `zoomFactor` (scales `viewSize`, reusing `setAspect`'s existing frustum-resize code), and `panOffset` (added to `center`). One position/frustum formula serves every state. Auto-framing is a bespoke function (no library does this): project the painted elevation range's bounding box into the current camera's view space and size `viewSize`/`distance` to fit it, re-run on view-direction/tilt change and after significant edits. Also fixes tree billboards (rotate each instance to face the camera every frame, the real "billboard" technique) as part of this same work. | Vendor Three.js's official `OrbitControls` or `MapControls` addon (MIT, same family already vendored) for the zoom/pan/orbit mechanics, constrained to 4 snapped azimuths and a bounded tilt range via its own angle-limit options, instead of hand-rolling that math. Still needs the exact same bespoke auto-framing function as A (no library solves "fit this heightfield's painted extent"), and the same billboard fix. | Four separate, independently-tuned blocks of fixed camera constants (one per direction), a simple global zoom scalar and pan offset layered uniformly on top, and tilt as a shared slider. No real auto-fit: framing stays a tuned-by-hand constant per direction, same category of fix as today's single fixed `viewSize` - just four of them instead of one. |
| Visual quality | 9 | 8 | 4 |
| Feasibility | 8 | 6 | 9 |
| Style consistency | 9 | 5 | 6 |
| Impl. cost (10=cheap) | 6 | 5 | 9 |
| Performance | 9 | 7 | 9 |

**Risks:** Continuous tilt is a genuinely new kind of surface to verify (a
range of angles, not a fixed handful of presets) - picking, shadow
plausibility, and billboard facing all need checking across that range, not
just at the extremes, regardless of which approach is chosen. Approach A's
auto-framing function needs to project the *actual* painted bounding box
(not just the static grid footprint) through the current camera transform,
or it under/over-frames exactly the way today's single fixed constant does
for an unusual map - this is the one piece of real new geometry math in the
whole task. Approach B still carries this same risk unreduced (the library
doesn't help with it at all) while adding integration risk of its own:
`OrbitControls`/`MapControls` are built around continuous drag-to-orbit
input, not button-triggered snapping to four cardinal directions, so most
of the library's own input handling would need overriding or disabling to
match the UX this task actually asks for - the "reuse" benefit is real but
partial, and is recorded here per `CLAUDE.md`'s reuse discipline even
though it's not the pick. Approach C's core problem isn't risk, it's that
it doesn't do what was asked: "automatic framing" was explicit in this
task's scope, and four more fixed constants is the same category of fix
already identified as insufficient (that's *why* this task exists) - it's
included here as the cheap baseline that makes the cost/quality trade-off
concrete, not a serious contender.

**Recommendation:** Approach A. It's the only option that actually
implements automatic framing as asked (C doesn't, by its own design) and it
reuses this renderer's own existing camera-math shape rather than adopting
a drag-to-orbit library built for a different interaction model than the
button/slider UX this task calls for (B) - the library's real strength
(robust continuous orbit input) isn't what's needed here, and its one
missing piece (auto-framing) would have to be hand-built regardless,
meaning B pays an integration cost for less reuse benefit than it first
appears to offer.

**Approved 2026-10-13 using Approach A**, with two explicit requirements:
auto-framing must not unexpectedly reset the camera while the user is
editing terrain (a dedicated Reset/Fit View control instead), and terrain
picking and tree billboards must keep working correctly from all four
directions, especially at low camera (dramatic, near-horizontal) angles.

### Implementation

- **`camView` state object** (`terrain-renderer-3d.js`) replaces the old
  fixed `center`/`viewSize`/`distance`/`tiltFromVertical` constants:
  `azimuthIndex`, `tiltDeg`, `zoom`, `panX`/`panZ`, `baseViewSize`.
  `applyCameraState()` recomputes camera position/look-at/frustum from this
  state every time any control changes; `AZIMUTH_PRESETS` defines the four
  direction presets (N→S, S→N, E→W, W→E), `DEFAULT_AZIMUTH_INDEX = 1`
  (S→N) preserves the exact original camera look as the default.
- **Automatic framing** (`fitView()`): scans the actual painted elevation
  range (not just the static grid footprint), resets zoom/pan to defaults,
  then projects the 8 corners of that data's 3D bounding box onto the
  camera's own right/up axes (read from `camera.matrixWorld`) to compute
  the frustum size that fits it with a small margin. This directly fixes
  the clipping bug named in the assessment (a tall peak rising outside a
  fixed frustum) for any azimuth/tilt, not just the one direction the old
  fixed constants happened to be tuned for.
- **`fitView()` is called only from three places, by design**: initial
  terrain load, the explicit "Reset / Fit view" button, and
  `setAzimuth()`/`setTilt()` (an intentional auto-refit tied to changing
  the direction/tilt controls themselves). It is never called from
  `setZoom()`, `panBy()`, painting, or switching between Top-down/Oblique -
  satisfying the "must not unexpectedly reset while editing" requirement by
  construction, not just by accident of timing.
- **Zoom and pan**: `setZoom(factor)` scales `camView.baseViewSize` and
  reapplies the camera state without refitting. `panBy(dRight, dUp)` offsets
  `camView.panX`/`panZ` along the camera's own current right/up vectors
  (so panning direction is always screen-relative, correct at any
  azimuth/tilt), scaled by the current zoom.
- **Real tree billboarding** (fixing the pre-existing bug named in the
  assessment): `buildTreeLayer` now exposes `updateFacing(camera)`, called
  once per frame before render, which recomputes every tree instance's full
  transform matrix with a Y-rotation from `Math.atan2(camera.x - tree.x,
  camera.z - tree.z)`, via `THREE.Matrix4.compose`. Previously each
  instance's matrix only ever set position/scale, leaving a fixed
  world-space orientation that only looked correct by coincidence of the
  camera's original fixed position.
- **UI**: a second toolbar (`#camera-toolbar`, shown only in Oblique view)
  with four direction buttons (`[data-azimuth]`), a tilt slider (12°-82°),
  a zoom slider (0.4x-3x), a 4-button pan pad, and a "Reset / Fit view"
  button. Wired in `world-client.js`'s `wireCameraControls()`; every handler
  calls the renderer directly and re-renders once, bypassing the
  dirty-rect `scheduleRender()` system since camera moves aren't terrain
  edits.

### Verification (real browser, Playwright, against localhost:8800)

- All four azimuth presets (N→S, E→W, W→E, and back to S→N) screenshot-
  confirmed: each correctly rotates the view and auto-frames the rotated
  scene, confirming the bounding-box-projection fit math is not
  direction-specific (only two of the four were worked out analytically
  during implementation).
- Tilt slider screenshot-confirmed at both extremes: 80° (near-horizontal)
  renders a dramatic, mountains-above-a-horizon-strip silhouette view; 14°
  (near-top-down) renders a flattened plan-like view. **Caught and fixed
  during this verification**: the first implementation had `sin`/`cos`
  swapped in the tilt-to-camera-position formula (and the corresponding
  min/max comments inverted), so tilt=80 initially rendered near-top-down
  and tilt=14 rendered the dramatic low angle - exactly backwards from the
  intended slider semantics. Fixed and re-verified.
- Zoom slider screenshot-confirmed in both directions: zoomed-in fills the
  frame with terrain detail (individual tree billboards visible as distinct
  textured canopy shapes within the forest patch, not a flat green fill);
  zoomed-out shrinks the whole scene with black letterboxing, no clipping
  or distortion.
- Pan buttons screenshot-confirmed: four clicks left + two up moved the
  framed scene accordingly; "Reset / Fit view" correctly returned to the
  default full-scene framing.
- **Auto-framing-does-not-reset-while-editing, tested decisively** (the
  explicit approval requirement): rather than relying on the ambiguous
  case where a fit-view had *just* been clicked before painting, a
  dedicated test set the camera to a deliberately unusual state (E→W
  azimuth, zoom=2, panned right+down), read back the exact
  zoom/tilt/azimuth slider state, painted a Mountain stroke on an unrelated
  part of the map while on the Top-down view, switched back to Oblique, and
  re-read the state. Zoom/tilt/azimuth values and the rendered frame
  (pixel-for-pixel) were identical before and after the edit, confirming
  the camera is never silently refit by painting or by toggling between
  Top-down and Oblique.
- **Picking accuracy at a low, dramatic tilt, explicitly tested** (the
  requirement's specific emphasis): with tilt set to 78° and a non-default
  W→E azimuth, a Peak stroke was clicked at a known screen coordinate in
  open grassland near the coastline. The resulting peak rose up exactly at
  that screen location (confirmed with an on-screen crosshair marker
  overlaid on the click point in the verification screenshot), not drifted
  to a neighbouring cell - confirming `pickAgainstHeightfield`'s
  direction-agnostic ray-march holds up in practice at a grazing camera
  angle, not just in the code-reading argument made in the assessment.
- Tree billboard facing verified qualitatively across multiple azimuths and
  a close zoom: forest patches read as a textured block of overlapping
  canopy shapes from S→N, N→S, E→W, W→E, and the 78°-tilt/W→E picking test,
  with no edge-on/invisible-sliver appearance at any tested direction - the
  per-frame `Math.atan2` facing fix holds across the tested range.
- `pnpm typecheck`, `pnpm test` (18/18 passing, against a fresh dev DB),
  and `pnpm check:evidence` all pass unmodified - no server/API contract
  changes, consistent with the plan.

### Remaining limitations (not fixed by this change, not hidden)

- The sun remains fixed in world space (named in the assessment, not
  addressed here) - some azimuths render visibly more backlit/flatter than
  others, since the lit side of a ridge doesn't rotate with the camera.
  Scoped to task 6 (oblique art quality), not this task.
- `fitView()`'s auto-refit on every azimuth/tilt change is a deliberate
  design choice (re-frame when the direction/angle itself changes) but
  means a user who has manually zoomed/panned loses that adjustment the
  moment they switch direction or drag the tilt slider - only zoom/pan
  themselves, and editing, are guaranteed not to trigger a refit. Not
  reported as a bug by the approval requirement (which named editing
  specifically), but worth naming as a UX trade-off.
- Camera-state is view-local, in-memory only (not persisted per-user or
  synced between simultaneous editors) - each browser tab keeps its own
  camera independent of what other connected clients are looking at, which
  is consistent with how this prototype has not persisted any other
  client-local UI state either.

## 4. Overall rendering resolution, pixelation and anti-aliasing

**Status:** ✅ Done, using Approach A with one correction (see below).

Scope: top-down was deliberately pixelated (`image-rendering: pixelated`,
`CELL_PX=3`) for precise editing; oblique is a 384-segment antialiased
WebGL mesh. Whether these should visually match, and what resolution/AA
settings actually read as "crisp fantasy map" vs. "blocky" at each zoom
level, needed a dedicated look once tasks 1-2 stopped changing the
geometry underneath it.

### Root causes (verified in code, not assumed)

Four separate things are bundled under one "looks rough" complaint, and
they need separate fixes - conflating them would mean "fixing" one and
leaving the others exactly as visible as before.

1. **No `devicePixelRatio` handling anywhere, in either renderer.** Both
   canvases are sized in `world-client.js` as `canvas.width = canvas.height
   = GRID_SIZE * CELL_PX` (768 physical pixels) with no DPR multiplier, and
   `world.css` displays both at a fixed `768px` CSS size. On a non-retina
   (DPR=1) display these match exactly. On any HiDPI display (DPR 1.25-3,
   which is most laptops and phones sold in the last several years), the
   actual device pixel count behind that 768 CSS px box is `768 * DPR` -
   larger than the canvas's own backing store - so the browser upscales the
   rendered image to fill it. For the **top-down** canvas this upscale is
   forced to nearest-neighbour by `image-rendering: pixelated` (`world.css`
   line 116, applied only to `#stage`), so it reads as *chunkier*, not
   blurry - each already-coarse cell block gets stretched into an even
   bigger flat square. For the **oblique** canvas (`#stage-3d` has no such
   CSS rule, confirmed in `world.css`), the browser's default smooth
   upscaling applies, which is the direct cause of a soft/blurry oblique
   view on exactly the displays where top-down looks blocky instead - two
   different-looking symptoms from the same one root cause.
   `THREE.WebGLRenderer` is also constructed with no
   `renderer.setPixelRatio(...)` call (confirmed by reading
   `createTerrainScene3D`), so even the `antialias: true` MSAA setting that
   *is* already on only smooths triangle edges within that undersized
   backing store - it does nothing about the whole-image upscale on top of
   it. These are two genuinely different kinds of "anti-aliasing" that this
   task's own title conflates, and the codebase currently has one but not
   the other.
2. **The oblique terrain-type boundary is a hard-edged texture lookup,
   independent of mesh density.** `createTypeTexture()` deliberately uses
   `THREE.NearestFilter` (so a terrain-type index is never hardware-
   interpolated into a meaningless fractional value), and the fragment
   shader (`FRAGMENT_SHADER`) looks this up once per fragment with no
   blending logic of its own at the boundary itself. The renderer already
   does real material blending elsewhere (slope-based rock bleed-through,
   altitude-based snow) - but the raw grass/sand/forest/rock type edge is
   not one of them, so it renders as a sharp, axis-aligned, blocky line
   regardless of how dense the mesh is. This is a distinct artifact from
   (1): it would still look blocky at a perfectly DPR-correct resolution,
   since it comes from the 256x256 *data* texture's own cell boundaries,
   not from screen-pixel density.
3. **The top-down fill has no sub-cell shading or interpolation at all,
   independent of resolution.** `renderTerrain` (`terrain-renderer.js`)
   computes one `light`/`curvature` value per cell and draws it as one flat
   `ctx.fillRect` of solid colour at `cellPx` size - there is no per-pixel
   gradient or blending between a cell and its neighbours anywhere in this
   path (the coastline is the one exception: it's a true vector contour,
   already smoothed with quadratic curves and independently anti-aliased by
   the canvas 2D stroke). This means top-down's "blockiness" is not
   primarily a resolution problem that a bigger `CELL_PX` would fix on its
   own - two adjacent cells with different elevation/type will always meet
   at a hard, flat-coloured edge, just a differently-sized one. This is
   also genuinely intentional today (the Top-down tooltip says "accurate
   shapes - best for precise editing") and worth treating as a style
   decision to preserve or deliberately change, not an accident to quietly
   "fix away."
4. **Mesh density itself (the question's other named suspect) is NOT the
   dominant cause, checked rather than assumed.** `MESH_SEGMENTS = 384`
   over `GRID_SIZE - 1 = 255` world units is already finer than the 256
   authoritative data cells (confirmed by the file's own comment: "~1.5
   visual vertices per authoritative cell edge"), and at the canvas's
   default 768px size that's roughly 2 screen pixels per mesh vertex -
   dense enough that per-vertex geometric faceting isn't what's visible;
   the smooth `LinearFilter` height sampling and on-the-fly finite-
   difference normals already produce continuous-looking slopes between
   data cells. Named here explicitly because the task's prompt called out
   mesh density as a suspect - it was checked and ruled out as the primary
   cause, not skipped.
5. **The 8-bit single-channel height texture (`UnsignedByteType`) quantizes
   elevation to 256 discrete levels across the full `[-1, 1]` range** -
   checked as a plausible banding source, found low-risk in practice: the
   texture's own `LinearFilter` interpolates *between* those 256 stored
   values continuously in screen space, so the displacement a vertex
   actually receives still varies smoothly even though each stored texel is
   quantized. Noted as a minor latent precision ceiling worth keeping in
   mind if elevation range or `HEIGHT_SCALE` grow later, not a currently
   visible artifact - included for completeness since the task asked about
   texture quality specifically, not because it's driving today's
   complaints.

### Approaches compared

| | A. Targeted fixes per diagnosed cause | B. Unify top-down into the same continuous WebGL renderer | C. Brute-force resolution bump only |
|---|---|---|---|
| **Summary** | Fix each of the four causes above directly, independently: DPR-aware canvas sizing (`renderer.setPixelRatio`, matching backing-store resolution for both canvases, capped at 2x to bound cost) so neither view is ever upscaled by the browser; soften the oblique terrain-type edge with a small shader-side blend near cell boundaries (reusing the same hand-written blending technique already used for slope/altitude, not a new technique); leave the top-down flat-cell fill and its `image-rendering: pixelated` as-is by default (it's a named, intentional "precise editing" style, not a bug), but render it at native device resolution instead of an upscaled one so the *intended* crisp pixel-art look is actually crisp instead of smeared by interpolation. | Replace `terrain-renderer.js`'s 2D canvas top-down path entirely with the same Three.js heightfield scene already built for Oblique, just viewed from a steep/near-vertical camera angle (the camera system already supports this via `tiltDeg` near its `MIN_TILT_DEG`) - one continuous GPU-shaded pipeline for both views instead of two. | Leave every filter/DPR/shading choice exactly as-is; just raise the two existing resolution constants (`CELL_PX` and `MESH_SEGMENTS`) substantially and rely on sheer pixel/vertex density to mask the artifacts. |
| Visual quality | 9 | 9 | 4 |
| Feasibility | 9 | 6 | 9 |
| Style consistency | 9 | 6 | 6 |
| Impl. cost (10=cheap) | 8 | 4 | 10 |
| Performance | 8 | 6 | 4 |

**Risks:** Approach A's DPR cap (2x) is a deliberate trade-off - a 3x+
display will still see a small residual mismatch, chosen because
uncapped DPR scaling on a dense enough panel could meaningfully raise
fill-rate and shader cost per frame for a resolution gain past the point
of visible benefit; this is a tunable constant, not a hard limit, and can
be revisited if it reads as insufficient once actually tested. Approach
B's real risk is scope and regression surface, not an unknown: Top-down's
whole reason to exist is being "accurate shapes - best for precise
editing," and routing it through the same ridge-noise-displaced, GPU-
shaded mesh used for Oblique's painterly look means either disabling that
detail noise specifically at near-top-down tilt (more special-casing
layered onto an already-parametric camera) or accepting that precise
top-down editing now shows GPU-added micro-detail that isn't exactly the
stored data - a real tension with the view's stated purpose, not a
cosmetic concern. It would also mean deleting the entire, currently-
working 2D canvas renderer and its already-smoothed vector coastline path
as a side effect of a resolution-quality task, a much larger blast radius
than what was asked. Approach C is included as the cheap baseline that
makes the cost/quality trade-off concrete, per this file's established
practice (see tasks 1 and 3's rejected option C) - it doesn't touch
either of the two genuinely resolution-*independent* causes (2 and 3
above), so it would look marginally crisper at real cost (4x the top-down
canvas's pixel count and fill cost at `CELL_PX=6`, roughly 4x the oblique
triangle count at `MESH_SEGMENTS=768`) while leaving the oblique terrain-
type hard edge and the top-down flat-cell fill exactly as blocky as
today, relative to their own cell size.

**Recommendation:** Approach A. It is the only option that maps one fix
to each of the four causes actually found in the code, rather than either
leaving two of the four causes completely unaddressed (C) or taking on a
disproportionate rewrite - and a real tension with Top-down's own stated
purpose - to fix a resolution problem that doesn't need one (B). It also
directly supports the long-term fantasy map editor goal this file already
tracks: tasks 5 and 6 (top-down and oblique art quality) are the next
items in this list, and both depend on first having a rendering pipeline
that displays whatever art/shading work goes into them at the device's
actual resolution, with material boundaries that blend rather than snap -
otherwise any art-quality improvement made next would be judged against,
and partly undone by, the same DPR and boundary-hardness issues diagnosed
here. Approach A is corrective groundwork for those tasks, not a
competing alternative to them. At continent scale (this file's noted
later milestone) the same DPR-aware sizing and capped pixel ratio remain
the right approach unchanged - it scales with screen resolution, not with
map size, so nothing here needs revisiting when the map itself grows.

**Approved using Approach A, with one correction**: the assessment's
Approach A kept Top-down's blocky pixel-art look by default, treating it
as an intentional style choice ("precise editing doesn't need blocky
graphics" was the explicit pushback). The correction asked for genuine
resolution, anti-aliasing and terrain-boundary smoothness improvements in
*both* views, with the explicit caveat that any smoothing must not blend
incorrectly between terrain types or across coastlines.

### Implementation

- **Device-pixel-ratio-aware canvas sizing, both views.** `world-client.js`
  now computes `PIXEL_SCALE = CELL_PX * DEVICE_PIXEL_RATIO` (capped at 2x,
  exported as `MAX_DEVICE_PIXEL_RATIO` from `terrain-renderer-3d.js` so both
  renderers share one cap) and sizes the top-down canvas's backing store
  (and all pixel<->grid picking math) in that unit instead of the old
  fixed `CELL_PX`. The oblique canvas's sizing moved into
  `createTerrainScene3D` itself via `renderer.setPixelRatio`/`setSize`,
  the standard Three.js pattern, rather than world-client.js poking
  `canvas.width`/`height` directly. CSS display size is untouched in both
  cases (world.css's fixed `768px`) - only the resolution behind it changed.
  Verified directly: `canvas.width`/`height` read back as 1536 (768 x 2) at
  a simulated `devicePixelRatio: 2`, for both canvases.
- **Top-down's renderer was rewritten from flat per-cell fills to
  continuous per-pixel shading** (`terrain-renderer.js`), removing the
  blockiness at its source rather than just rendering the same flat blocks
  at a higher resolution. Each output pixel now calls `continuousColorAt`
  at its own fractional grid position: elevation is bilinearly sampled
  (reusing the existing `sampleBilinear`, lifted out of
  `terrain-renderer-3d.js` into the shared `terrain-model.js` so both
  renderers interpolate the stored data identically), relief/hillshading is
  computed via finite differences on that continuous field
  (`continuousReliefAt`, mirroring the existing `reliefAt`'s math exactly,
  just sampled at any real-valued position instead of only integer cells),
  and terrain-type colour is bilinearly blended between the four nearest
  cell centres' *already-resolved colours* (`continuousTypeBlend`) - not
  the raw type index, which would produce a meaningless fractional type.
  Written as one `ImageData` buffer and a single `putImageData` call per
  redraw rather than one `fillRect` per cell/pixel, which would carry real
  per-call canvas-API overhead at this resolution.
- **Coastline-safe blending, by construction, in both views.** The
  land/sea boundary is never colour-blended: a hard formula switch (sea
  gradient vs. land+type) keyed off the bilinearly-sampled elevation's
  exact sign relative to `SEA_LEVEL`, which lands at very nearly the same
  sub-cell position as the existing vector coastline contour (both read
  the same linear crossing of the same data) - so there is no "fade" at
  the coast to get wrong. Terrain-*type* blending (grass/sand/forest/rock)
  explicitly excludes any neighbouring cell at or below sea level,
  substituting the pixel's own cell colour instead
  (`continuousTypeBlend`'s `selfColor` fallback) - so a coastal pixel's
  blend degrades to exactly today's crisp self-colour rather than ever
  mixing toward a sea colour. The oblique WebGL shader's
  `blendedTypeColor`/`paintColorForCell` use the identical technique
  (bilinear blend of four *already-categorised* corner colours, each
  checked against its own sampled elevation first) for the same reason.
- **Oblique shader terrain-type boundary softened** (`terrain-renderer-3d.js`):
  the fragment shader's single `NearestFilter` type lookup (needed because
  an interpolated type *index* like 1.5 is meaningless) now blends four
  whole corner *colours* instead, after each has already been resolved to
  a real grass/sand/forest/rock colour - the same "filter after the
  categorical lookup" technique as the top-down path, so both views are
  smooth for the same reason rather than via two unrelated techniques.
- **Fold-noise lookup table** (`terrain-renderer.js`): the continuous
  top-down path needs the mountain-fold noise at thousands of arbitrary
  fractional positions per redraw, too slow via the real 4-octave simplex
  noise directly. `fractalFold` has no data dependency (a fixed function
  of position only), so it's precomputed once, lazily, into a 768x768
  lookup table and bilinearly resampled - checked numerically against
  direct calls (20,000 random fractional positions): mean absolute error
  ~0.005, worst case ~0.054 on fractalFold's own ~0..1 range, small
  against `FOLD_AMPLITUDE` (0.17); at exact integer grid coordinates the
  error is ~3e-8 (floating-point noise only), so this is also a
  zero-behaviour-change swap for the existing per-cell paths
  (`buildShadingBuffer`, the WebGL2-less oblique fallback) that already
  called `foldOffset` at integer coordinates, not just a new continuous
  one.
- **Top-down's pixelated look removed per the correction**:
  `image-rendering: pixelated` deleted from `world.css`'s `#stage` rule.
  Precise editing (brush-size/strength, cell-accurate picking) is
  completely unaffected - those operate on the authoritative grid, never
  on how a pixel is shaded for display.
- `renderTerrainOblique` (the WebGL2-less 2D column-extrusion fallback)
  and its underlying `buildShadingBuffer`/`reliefAt`/`colorFor` were left
  structurally as-is beyond the shared fold-LUT swap - `colorFor` itself
  was only split into `baseColorFor` + `applyRelief` so the continuous
  path could reuse both pieces without duplicating the lighting formula.
  Scoped out deliberately: this fallback only renders for browsers without
  WebGL2, and a correct DPR-consistent shear for it would need
  `OBLIQUE_HEIGHT_SCALE` itself to scale with the pixel ratio, a separate
  and much lower-value fix for an already-rare code path (see Limitations).

### Verification (real browser, Playwright, against localhost:8800, deviceScaleFactor simulating HiDPI)

- Canvas backing-store resolution confirmed directly (not inferred): both
  `#stage` and `#stage-3d` read back `width`/`height` of 1536 at a
  simulated `devicePixelRatio: 2`, matching `768 * 2` exactly.
- Top-down screenshotted at `deviceScaleFactor: 2`: mountains render as
  smoothly shaded, continuously-shaded domes with no visible per-cell
  blocking anywhere, including at a tight close-up crop - a direct, visual
  confirmation of the correction's explicit ask.
- **Terrain-type boundary blending verified quantitatively, not just by
  eye**, in both views:
  - Top-down: a pixel-by-pixel scan across the forest patch's known grid
    boundary (`x=150`, from `scripts/seed-test-scene.ts`) shows a real
    intermediate colour (`(80,127,71)`) between pure grass `(130,173,83)`
    and pure forest `(55,105,66)` at the crossing - a genuine blend, not an
    instant jump, confirmed by decoding the actual screenshot PNG's pixel
    data rather than reading the rendered image by eye.
  - Oblique: zoomed the WebGL view (3x) directly onto the forest patch's
    edges - a visibly soft transition band is present along the whole
    boundary, not a hard rectangle. A `gl.readPixels`-based automated scan
    was also attempted but abandoned in favour of this direct visual check
    once it became clear that reliably locating the exact screen
    coordinates of a known grid cell through the oblique camera projection
    (for an automated colour assertion) was adding risk without adding
    confidence beyond what the zoomed screenshot already shows plainly.
- **Coastline domain-safety checked, not just claimed**: a pixel scan
  straight across a coastline crossing (`x=50`) shows the expected,
  non-muddy sequence - sand, a short strip of plain grassland (confirmed
  against `seed-test-scene.ts`'s own type-painting rule, `y > cy-10 && y
  <= cy+2` for sand, grassland immediately past it - genuine seed data, not
  a rendering artefact), the dark vector coastline ink stroke, then sea
  blue - at no point an intermediate land/sea colour.
- **Picking/editing accuracy re-verified after the DPR change** (the
  change touches the exact pixel<->grid conversion math): a Peak stroke at
  a known screen fraction landed within 1 grid cell at `devicePixelRatio:
  1` and exactly on the target cell at `devicePixelRatio: 2`, confirmed by
  diffing `/api/terrain` before/after and finding the cell with the
  largest elevation rise, not by eye.
- **Real-time sync and reload persistence re-verified** with the new
  renderer: a second browser context received and rendered an identical
  mountain stroke via SSE with no reload, and a page reload rendered the
  same terrain identically - confirming the rewrite didn't change what's
  stored or synced, only how it's displayed.
- No console/page errors in any of the above runs.
- `pnpm typecheck`, all 18 tests (fresh dev DB), and `pnpm check:evidence`
  all pass unmodified - no server, schema, or API change.
- **Performance measured, not assumed**: interactive per-brush-stroke
  partial redraws (the case that matters for painting responsiveness)
  measured at ~3.6-4.4ms at `devicePixelRatio: 2` - unaffected by the
  rewrite, since they only touch the small dirty region. A full-canvas
  redraw (initial load, or switching into Top-down) at the same pixel
  ratio measured at ~330-415ms - a real, named cost (see Limitations), not
  hidden behind an optimistic estimate.

### Remaining limitations (not fixed by this change, not hidden)

- **Full-canvas top-down redraws cost ~330-415ms at the default 2x-capped
  pixel ratio** (measured above), noticeably slower than the old flat-fill
  renderer. This is paid on initial page load and every explicit
  Top-down<->Oblique toggle (via `redrawAll()`), not on every interactive
  brush stroke (those stay fast, ~4ms, via the existing dirty-rect partial
  redraw). Acceptable for this task's correctness-first scope, but a real,
  user-visible cost worth optimizing later if view-toggling turns out to
  happen often in practice - the likely next step would be decoupling the
  expensive relief/fold computation from final output resolution (compute
  once at a fixed moderate resolution, bilinearly upsample for display),
  the same pattern already used for the fold noise LUT itself, applied one
  level higher.
- **The WebGL2-less 2D oblique fallback did not get a DPR-consistent
  shear.** Its mountain-rise-to-cell-width proportion (`OBLIQUE_HEIGHT_SCALE`,
  a fixed pixel constant) isn't itself scaled by the device pixel ratio the
  way `PIXEL_SCALE` now is, so on a HiDPI display this rarely-used fallback
  (only reached without WebGL2) renders mountains proportionally less tall
  relative to the map than before. Deliberately out of scope: fixing it
  properly needs `OBLIQUE_HEIGHT_SCALE` itself parameterized by pixel
  ratio, a larger change for an already-rare code path.
- The oblique shader's type-boundary blend uses a fixed 2x2 corner sample
  (one cell-width blend radius) - matching the top-down renderer's own
  blend radius for consistency, but not independently tunable per view.
  Not reported as a problem by this task's verification, but a tuning
  knob a future art-quality pass (tasks 5/6) might want to touch.
- MSAA (`antialias: true`, already present) and the new DPR-aware backing
  store are two different kinds of anti-aliasing addressed together here;
  neither adds temporal/motion anti-aliasing or supersampling beyond the
  2x device-pixel cap, which remains the practical ceiling on a 3x+ display.

## 5. Top-down fantasy-map art quality

**Status:** ⬜ Not started.

Scope: flat per-cell fills (`TYPE_COLORS`), no forest stamps in 2D at all
(only the 3D view got trees), hard-edged type boundaries. See the prior
combined assessment's Issue 1 table for a first pass at approaches
(procedural texture/dither + stamped forest icons vs. deriving top-down from
the 3D scene vs. sourcing real painterly textures) - will be re-scored here
on its own once reached.

## 6. Oblique fantasy-map art quality

**Status:** ⬜ Not started.

Scope: beyond the geometry fixes in tasks 1-2, the oblique view's overall
palette/material look compared against
`research/roadmap/references/reference-painted-mountains-clouds.png` and
`reference-stylized-regional-colors.png` - both show a warmer, more
saturated, ink-outlined style than the current renderer's cooler, more
"realistic relief map" palette.

## 7. Natural terrain material blending

**Status:** ⬜ Not started.

Scope: grass/sand/forest/rock currently blend nowhere - a cell is one type,
full stop (see task 1/5 root-cause notes). Needs a graduated blending band
at painted-type boundaries, in both renderers, ideally from one shared
source of truth rather than two separate implementations drifting apart.

## 8. Forest and vegetation quality

**Status:** ⬜ Not started.

Scope: builds on the billboard-tree proof of concept already in
`terrain-renderer-3d.js` (flat unlit tint, single fixed facing, two texture
variants, fairly dense/uniform). Candidates already on record from
`CREDITS.md`: Kenney's Nature Kit (CC0, real 3D models, needs `GLTFLoader`)
vs. improving the current billboard approach (true camera-facing rotation,
more variants, density/clustering tuning, fake ground-contact shadow) vs. a
hybrid (billboards for distance, real meshes for close/dominant trees).

## 9. Coastlines, rivers and lakes

**Status:** ⬜ Not started.

Scope: the vector `d3-contour` coastline is already a relative strength of
this renderer (real marching-squares extraction, not noise) - this task is
about rivers and lakes, which don't exist as a concept in the data model at
all yet, plus the "full hydrology model" direction noted as Approach C in
task 1, revisited here once a simpler flat-water-plane baseline (task 1)
exists to build on.

## 10. Map expansion, multiple maps, saving and loading

**Status:** ⬜ Not started.

Scope: currently exactly one fixed 256×256 world, one SQLite file, no
concept of multiple saved maps or growing the map area. Likely the first
task in this list that touches the server/data model and the SQLite schema
rather than just the client renderer - needs its own design pass (chunking,
per-map tables, or separate DB files) before scoring approaches.

## 11. Procedural/random map generation

**Status:** ⬜ Not started.

Scope: generating a starting terrain (coastline, mountain ranges, forests)
rather than starting from a blank sea, as a seed/starting-point for
collaborative editing, not a replacement for it. The `scripts/seed-test-scene.ts`
dev script already does a hand-authored version of this for QA purposes -
this task is about a real in-app, likely parameterized/randomized version.

## 12. D&D-style buildings, walls, roads and draggable objects

**Status:** ⬜ Not started.

Scope: a new category of placeable, likely-draggable objects distinct from
terrain painting - closer in spirit to C8's marks (owned, placed, moved)
than to the terrain grid. Likely needs its own data model decision (a
third SQLite table alongside `marks` and `terrain_cells`) and its own
concurrency note in `ADR.md` once scoped.

---

## Completed work log

- **2026-10-12** - Brush precision fix (distance-based stamping) completed
  and verified; see "Already completed" above.
- **2026-10-12** - Task 1 assessed (this file); awaiting approval to
  implement.
- **2026-10-12** - Task 3 scope expanded (adjustable tilt/zoom/pan/automatic
  framing added to the original four-direction scope) and a known mountain-
  clipping bug recorded against it. Not started; task 1 remains the current
  priority.
- **2026-10-12** - Task 1 implemented and verified (flat water plane +
  Deepen/Shallow seabed tools under a `SEABED_CEILING` clamp); see task 1
  section above for full results. Commit
  [`0164a74`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/0164a746584e6130ec66f44e396523737d586dd4).
- **2026-10-13** - Task 2 assessed and implemented and verified in the same
  session (relaxation pass + Mountain/Peak Strength fix + a damping-only
  renderer change, after two tried-and-reverted shader approaches along the
  way - see task 2 section above for the full trail and evidence). Commit
  [`693f475`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/693f475e6fbf5600a04f5d885f0b97b7177ff4c2).
- **2026-10-13** - Task 3 assessed (this file); awaiting approval to
  implement. Confirmed in code that picking needs no changes for any new
  camera state, and that tree billboards (fixed-orientation planes, not
  true billboards) need a real fix as part of this task, not a separate one.
- **2026-10-13** - Task 3 implemented and verified in the same session
  (parametric camera with direction/tilt/zoom/pan/auto-fit, true per-frame
  tree billboarding, and a sin/cos tilt-direction bug caught and fixed
  during verification - see task 3 section above for the full trail and
  evidence). Commit
  [`e07061b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/e07061b30b84ceea0051c569353e02d67009ec4c).
- **2026-10-13** - Task 4 assessed (this file); awaiting approval to
  implement. Traced the "looks rough" complaint in both views to four
  separate, independently-confirmed causes rather than one: missing
  `devicePixelRatio` handling in both canvases (opposite symptoms in each
  view - chunkier top-down, blurrier oblique, from the same root cause),
  a hard-edged nearest-filter terrain-type texture boundary in the oblique
  shader, and top-down's flat per-cell fill having no sub-cell shading at
  all. Mesh density and 8-bit height-texture quantization were both
  checked and ruled out as the dominant cause, not skipped.
- **2026-10-13** - Task 4 implemented and verified in the same session,
  using Approach A with the explicit correction to drop Top-down's
  pixelated look rather than keep it: DPR-aware canvas sizing in both
  views, top-down rewritten to continuous per-pixel shading, and the
  oblique shader's terrain-type edge softened - all with domain-safe
  blending verified by decoding actual pixel data across a known
  coastline/forest boundary, not by eye. See task 4 section above for the
  full verification trail, the measured full-redraw performance cost, and
  the named limitations. Commit
  [`5d519da`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/5d519da7be0f503598f5b8f957d98728813ec614).
