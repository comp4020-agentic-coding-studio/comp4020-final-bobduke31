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

**Status:** ⬜ Not started. Scope expanded 2026-10-12 (originally just the
four directions) - see below.

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

Will be scored (2-3 approaches per control, per this file's usual format)
when this task is reached in order; recorded here now so the clipping bug
and the full scope aren't lost before then.

## 4. Overall rendering resolution, pixelation and anti-aliasing

**Status:** ⬜ Not started.

Scope: top-down is deliberately pixelated (`image-rendering: pixelated`,
`CELL_PX=3`) for precise editing; oblique is a 384-segment antialiased
WebGL mesh. Whether these should visually match, and what resolution/AA
settings actually read as "crisp fantasy map" vs. "blocky" at each zoom
level, needs a dedicated look once tasks 1-2 stop changing the geometry
underneath it.

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
