# Final development roadmap

A persistent, ordered list of the remaining work toward the Final project's
visual and functional bar (Inkarnate/Wonderdraft-style cartography, per
`CLAUDE.md`), tracked here so status, chosen approaches, and open problems
survive across sessions instead of living only in chat history. Work happens
on a local development branch (currently `final-redesign-prototype`); nothing here
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

## Product phases (how the numbered tasks below add up to a whole product)

The list below reads as 12 (now 13) separate feature tickets, but it's
actually working through four phases of one product - stated here so the
ordering reads as a plan toward "a real multiplayer map editor," not a grab
bag:

1. **Make the one shared map itself correct and good-looking** (tasks 1, 2,
   4, 5, 6, 7) - fixed sea level, natural slopes, rendering resolution, and
   both views' art quality. Everything here is about the *terrain data and
   its rendering*, independent of how a person interacts with it. This phase
   is mostly done; tasks 6 and 7 remain.
2. **Make editing and navigating that map not fight the user** (task 3,
   task 13) - camera controls and, as of this entry, the whole editor
   workspace (canvas space, tool organization, panel layout). This phase
   exists because phase 1's fidelity is wasted if the UI around it is a
   cramped fixed-size canvas with every tool visible at once - task 13 was
   pulled forward out of numeric order for exactly this reason, at explicit
   user request, rather than waiting for tasks 6-12.
3. **Grow what can be depicted on one map** (tasks 8, 9) - real vegetation,
   rivers and lakes - content breadth within the existing single-map,
   single-scale model.
4. **Grow the product beyond one fixed map** (tasks 10, 11, 12) - multiple/
   larger maps, procedural starting terrain, and placeable objects (roads,
   buildings, walls). Per `CLAUDE.md`, a regional-scale map is the near-term
   fidelity target and continent-scale is "the same engine at a later,
   larger scope" via task 10/11, not a separate system; an isometric city
   view is explicitly out of scope for now, not a deferred task.
   **Update 2026-10-21:** tasks 10-11 are now one plan, "Platform: create,
   edit together, save, reload, share" (below task 9). It's the priority for
   the rest of the Final. Task 12 is deferred.

Phases are sequential in intent (no point hand-placing buildings on a map
whose terrain still looks wrong), but, as task 13 shows, a phase-2 problem
severe enough to undermine everything else can jump the queue - the numbered
list is a priority order within a phase, not a rule that blocks reordering
across phases.

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

### Regression found and fixed after shipping: Top-down/Oblique land-sea mismatch

Reported directly by the user comparing the two views side by side on a
real map: Top-down showed small islands in open ocean; Oblique showed a
near-solid green landmass with a tiny water patch - the same underlying
data rendering as two contradictory maps, not a styling difference.

**Root cause, confirmed by direct calculation, not assumed:** the Oblique
renderer's height data was carried through an 8-bit `DataTexture`
(`elevationToTexel`/`texelToElevationRange` in `terrain-renderer-3d.js`),
quantizing every elevation to 1 of 256 steps (~0.0078 wide at this app's
`[-1, 1]` range) before the GPU shader's own `vElevation <= uSeaLevel`
land/sea test ever ran. An *unpainted* cell's elevation is exactly `0`
(`SEA_LEVEL`) - the default for the overwhelming majority of cells on any
real map, not a rare edge case - which quantizes to texel 128 and decodes
back to `+0.00392`: just barely *above* `SEA_LEVEL`. Every unpainted cell
was therefore misclassified as land in Oblique, while Top-down (plain JS
floats, `terrain-model.js`'s `isLand`, no texture, no quantization)
correctly read the identical cells as sea. Two different land/sea tests,
silently disagreeing at the one elevation value nearly every cell actually
has - confirmed numerically (`elevation=0` round-trips to `0.00392`, a
documented `elevationToTexel` comment now records the exact calculation)
and reproduced visually with a deliberately sparse test scene (two small
painted islands, the rest of the 256×256 grid left entirely unpainted) -
chosen because it isolates the bug cleanly, unlike the regular seed scene
where most of the frame actually is land already.

**Fix:** the height texture is now `Float32Array`/`THREE.FloatType` (this
renderer already requires WebGL2 via `isWebGL2Available`, which guarantees
float-texture support), carrying the real elevation value through with no
lossy round-trip at all - the same precision Top-down always had.
`texelToElevationRange` is now the identity (the normalize-from-8-bit-
integer step it used to do no longer applies). A `SEA_LEVEL + epsilon`
comparison nudge (the pattern `computeCoastlineRings` already uses for an
unrelated d3-contour precision issue) was considered and rejected: it would
only have patched the classification symptom, not the lossy quantization
itself, which also subtly distorted every land cell's actual displayed
height near sea level, not just its land/sea classification.

**A second bug this fix exposed, not introduced:** once sea rendered
correctly instead of as misclassified land, the water plane showed visible
horizontal banding - classic z-fighting, because the plane sits at exactly
`y = SEA_LEVEL * HEIGHT_SCALE` and an unpainted cell's ground-mesh vertex
displaces to the exact same y (`detailedHeight`'s own early return for
`aboveSea <= 0.0001`). This was always latent; the land-sea bug had been
hiding it almost everywhere by rendering sea as solid land, leaving the
water plane mostly occluded rather than exposed and coplanar with real
seabed. Fixed with the same `+0.05` epsilon offset the coastline ink-line
already uses for an identical reason - confirmed safe against the smallest
real elevation margins in this app (`LAND_FLOOR`/`SEABED_CEILING`, ±0.02 →
±0.92 world units at `HEIGHT_SCALE=46`), 18× larger than the 0.05 offset,
so it can't visually expose seabed above water or submerge shallow land.

**Verification:** real Playwright screenshots, not a description of the
diff. The sparse two-island scene: before the fix, Oblique showed a solid
green landmass with the islands barely distinguishable; after, Oblique
shows exactly two islands in open water, matching Top-down's layout
feature-for-feature. The standard mountain/forest/coastline seed scene was
re-screenshotted too, confirming zero regression: coastline shape, water
depth gradient, mountain geometry, and forest billboards all render
identically to before this fix. Oblique-view picking (ray-heightfield
picking against the authoritative `elevationGrid`, unaffected by this
texture-only fix) was re-confirmed by clicking Peak through the Oblique
canvas and reading back `/api/terrain` - elevation rose exactly as
expected. `pnpm typecheck`, all 23 tests (against a genuinely fresh dev
DB, not the seeded scene used for screenshots - rerun after an initial
mistaken run against the seeded scene produced an expected, unrelated
failure), and `pnpm check:evidence` pass; no server, schema, or API
change - this was a renderer-only bug and fix.

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
Approach A. Revisited 2026-10-13 (free 360° rotation, cursor-centred wheel
zoom, precise drag panning, no auto-reset on direction/tilt changes) - see
"Revisit: free rotation, wheel zoom, precise panning" near the end of this
section. Revisit commit
[`8893e71`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/8893e7129ebf66a60621ff036ae6844c5742311a).

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

### Revisit: free rotation, wheel zoom, precise panning (2026-10-13)

The user asked to revisit this task's controls directly: smooth 360°
rotation, mouse-wheel zoom, and free panning while zoomed in, "without
unexpected camera resets or scene reloads," and camera navigation must not
conflict with terrain painting. Two things from the original
implementation didn't meet this: the four azimuth presets were the *only*
way to rotate (no continuous 360° rotation at all), and - the concrete
"unexpected reset" this revisit fixes - `setAzimuth()`/`setTilt()` called
`fitView()` internally, so changing direction or tilt silently discarded
any zoom/pan the user had set up, which is itself an unexpected camera
reset even though it was never triggered by painting.

**Interaction-design detour, before implementing:** an initial plan (mouse-
only: right-drag rotate, middle-drag pan, wheel zoom, left-drag paints) was
proposed and then explicitly paused by the user to reconsider - button
semantics like right/middle-drag read as unintuitive, and the request
specifically named avoiding painting conflicts as a priority, not just an
implementation detail. Three concrete alternatives were compared instead,
all built on the existing `#camera-toolbar`/`camView` architecture (no new
dependency, no new rendering layer):

| | A. Toolbar compass dial + pan trackpad | B. On-canvas corner gizmo (view-cube style) | C. Continuous azimuth slider, pan buttons unchanged |
|---|---|---|---|
| Intuitiveness | 8 | 9 | 5 |
| Painting-safety | 10 (new controls never touch the canvas) | 6 (needs its own hit-testing on the same canvas painting uses) | 10 |
| Reuses existing code | 9 (`panBy`/`setZoom`/azimuth state already there) | 6 | 9 |
| Impl. cost (10=cheap) | 6 | 4 | 9 |

B's on-canvas gizmo is the most visually "native" to a 3D viewer, but it's
a second interaction surface layered on the same canvas `pointerdown` /
`pointermove` painting already owns - exactly the class of conflict this
revisit was asked to avoid, and it would need its own careful hit-test
boundary to guarantee a drag starting on the gizmo never falls through to
a paint stroke. C is cheap but a linear slider is a poor fit for a
wrapping, 360°-continuous value (no good way to drag smoothly past
359°→0°) and isn't the "draggable compass" feel asked for.

**Approved: Approach A**, with three explicit corrections from the user on
top of the comparison above:

1. Rotation, tilt, zoom and panning must preserve each other's state -
   nothing resets the camera except an explicit Reset/Fit View click.
2. Panning must support precise positioning while zoomed in, not just
   coarse nudging.
3. Wheel zoom must be cursor-centred, not centre-of-view-centred.

### Implementation

- **`terrain-renderer-3d.js`**: `camView.azimuthIndex` (0-3) became
  `camView.azimuthDeg`, a continuous value wrapped into `[0, 360)` by
  `wrapDeg()`. `setAzimuth(deg)` sets it directly; `setAzimuthPreset(index)`
  (what the four direction buttons now call) is a thin wrapper that looks
  up a preset's angle and calls `setAzimuth` - the presets are named
  shortcuts onto the same continuous value the dial drives, not a separate
  discrete mode. `camView.panX`/`panZ` became one `THREE.Vector3
  panOffset`, added directly to `GRID_CENTER` for the look-at centre -
  needed because `panBy()`'s "pan along the camera's own screen-up axis"
  now has a real world-Y component once the camera is tilted, which the
  old two-scalar (X/Z-only) representation silently couldn't represent.
- **The actual "unexpected reset" fix**: `setAzimuth()` and `setTilt()` no
  longer call `fitView()` at all - they call `applyCameraState()` only,
  exactly like `setZoom()` and `panBy()` already did. `fitView()` is now
  reachable from exactly two places (initial load, the explicit Reset/Fit
  View button), down from three - satisfying requirement 1 above by
  removing the auto-refit entirely, not by special-casing when it does or
  doesn't fire.
- **Cursor-centred wheel zoom** (`zoomAtCursor(factor, ndcX, ndcY)`,
  new): derived from the orthographic frustum's own geometry - the world
  point under a given clip-space offset from the view centre is
  `center + right*ndcX*halfWidth + up*ndcY*halfHeight`, with half-width/
  height scaling as `1/zoom`. Solving for the `panOffset` shift that keeps
  that same world point under the same `ndcX`/`ndcY` after a zoom change
  reduces to a shift of `(right*offsetR + up*offsetU) * (1 - oldZoom/newZoom)`
  - only the *ratio* of old to new zoom matters. `world-client.js` wires
  this to a `wheel` listener on `#stage-3d` only (never on the painting
  canvas's other event types, and only live while Oblique is the visible
  view), converts the pointer's canvas-space position to NDC the same way
  `canvasToGrid`'s picking path already does, and uses an exponential
  `Math.exp(-deltaY * 0.0015)` factor so a steady scroll feels like a
  steady zoom *rate* in either direction.
- **Precise panning while zoomed in** (requirement 2): the old pan control
  was four fixed-step buttons (`PAN_STEP = 0.18` of view size per click) -
  coarse by construction, not adjustable. Replaced with a drag "trackpad"
  (`#camera-pan-trackpad`, a small bounded rectangle in the toolbar): each
  `pointermove`'s screen-pixel delta converts to a *fraction* of the
  trackpad's own size and feeds `panBy()` directly, continuously, while
  the pointer is down. Because `panBy()`'s own step already scales by
  `baseViewSize / zoom`, the same small trackpad drag produces a
  correspondingly small, exact pan at any zoom level - a 2% drag of the
  pad is a 2% pan of whatever is currently on screen, not a fixed physical
  speed that overshoots once zoomed in.
- **The compass dial** (`#camera-compass`, an inline SVG with a rotating
  needle): dragging anywhere on it computes the pointer's absolute angle
  around the dial's centre (`Math.atan2`) and calls `setAzimuth()`
  directly with that angle every `pointermove` - true continuous 360°
  rotation, not a discrete step per drag distance. `azimuthToDialDeg()` /
  `dialDegToAzimuth()` convert between the camera's own azimuth convention
  (tied to the camera's world position, from the existing
  `applyCameraState()` formula) and the dial's visual convention (needle
  angle clockwise from N), derived directly from that formula and checked
  against all four presets (azimuth 0/90/180/270 → dial 0/270/180/90,
  i.e. the needle always points the direction the camera is actually
  looking - the intuitive reading of a compass). The four preset buttons
  stay as-is, now driving `setAzimuthPreset()`, and a shared `syncCompass()`
  keeps the needle rotation and each preset button's `active` class
  current after *any* azimuth change, whichever control caused it.
- **Painting-conflict avoidance, by construction**: every new drag surface
  (the compass dial, the pan trackpad) is its own DOM element inside
  `#camera-toolbar`, physically separate from `#stage-3d` - never an
  overlay or hit-test region on the canvas the painting `pointerdown`/
  `pointermove`/`pointerup` handlers already own. Only the new `wheel`
  listener touches the canvas itself, and painting has no wheel-based
  gesture to collide with, so there is no shared event type to
  disambiguate either. This is the same reasoning the original task 3 used
  for the pan *buttons* (now trackpad) living off-canvas - extended here to
  the dial and to wheel-zoom, rather than revisited per control.
- **HTML/CSS**: `index.html`'s `#camera-toolbar` direction group gained the
  compass SVG and kept the four preset buttons alongside it (now
  `data-azimuth-preset`, not `data-azimuth`); the old `.pan-pad` 4-button
  grid was replaced by `#camera-pan-trackpad`, a single bounded div.
  `world.css` added `.compass*`/`.pan-trackpad*` rules and removed the now
  -unused `.pan-pad` rules. A new `#camera-hint` line (shown only in
  Oblique, alongside the existing tool-hint) documents the wheel-zoom
  gesture and restates that dragging the map always paints.

### Verification (real browser, Playwright, against localhost:8800, seeded scene)

- **Continuous rotation**: dragged the compass dial through a ~350°
  sweep in 8 steps; the needle rotated smoothly through every
  intermediate angle (not snapping between four fixed positions), and the
  rendered terrain screenshot at each stage showed a correspondingly
  rotated view - including angles with no preset anywhere near them,
  confirming rotation is genuinely continuous, not an animated transition
  between the old four presets.
- **Cursor-centred wheel zoom**: scrolled the wheel while hovering a point
  two-thirds across and 40% down the canvas (over the mountain range, not
  the view centre); the resulting frame zoomed in on exactly that region
  rather than the geometric centre of the view, confirmed by screenshot.
  Reversing the scroll direction zoomed back out symmetrically. A
  dedicated check confirmed the zoom value clamps correctly at both ends
  of `[0.4, 3]` under a sustained 40-/60-notch scroll burst in each
  direction, and that scrolling over the canvas does not scroll the page
  itself (`event.preventDefault()` actually suppresses the native
  behaviour, not just in theory).
- **Precise panning while zoomed in**: zoomed in to 3x, then made three
  small (~8px) trackpad drags; the screenshot after showed a correspondingly
  small, exact shift in the framed content (a previously off-screen
  snow-capped peak came into view at the top edge) - not the large jump a
  fixed-step button would have produced, confirming the fine-control
  requirement.
- **State preservation across every control, tested as a single
  sequence, not independently**: rotated ~350° via the dial, zoomed to 3x
  via the wheel at a specific cursor point, panned slightly via the
  trackpad, zoomed back out to 0.4x, then clicked the E→W preset - at each
  step the *other* controls' values (read back from the zoom slider, tilt
  slider, and compass needle/active-preset state) were confirmed
  unaffected by the control just used, directly exercising requirement 1
  (nothing resets anything except the explicit fit button).
- **Painting still works correctly from the Oblique view with the new
  controls live**: after the rotate/zoom/pan/preset sequence above,
  painted a Peak stroke directly on the canvas; the POST to
  `/api/terrain/cells` carried real elevation deltas centred on the
  clicked cell, the subsequent `GET /api/terrain` elevation sum changed
  accordingly, and the screenshot showed a new peak exactly where clicked
  - confirming painting is unaffected by (and doesn't trigger) any of the
  new camera machinery.
- **No painting/camera conflict, decisively tested**: camera state (zoom,
  tilt, compass needle angle, active preset) was read before and after a
  paint stroke on the Oblique canvas and found byte-identical - painting
  never moves the camera, and (separately) a wheel scroll over the canvas
  never paints, since painting only listens for pointer events and the new
  zoom handler only listens for `wheel`.
- **View-mode round-trip**: switched Oblique → Top-down → Oblique after
  the rotate/zoom/pan sequence; the camera state and rendered frame were
  identical before and after, confirming the camera is still never reset
  by a view-mode switch (unaffected by this revisit, re-confirmed since
  `fitView()`'s call sites changed).
- **Reset/Fit View remains the only reset**: after the full
  rotate/zoom/pan/preset sequence, clicking Reset/Fit View correctly
  reframed to the full scene at the *current* azimuth/tilt (E→W, 58°) -
  zoom and pan reset to the fitted default, azimuth and tilt did not,
  matching the fact that only `fitView()` still touches zoom/pan and it
  was never changed to touch azimuth/tilt.
- `pnpm typecheck`, `pnpm test` (18/18, against a fresh dev DB - the
  seeded scene used for the screenshots above has its own cells
  pre-painted and is intentionally not what the test suite runs against),
  and `pnpm check:evidence` all pass unmodified - no server/API contract
  changes.

### Remaining limitations (this revisit)

- The compass dial and pan trackpad are mouse/pointer-drag controls with
  no keyboard-accessible equivalent beyond the four preset buttons and the
  tilt/zoom sliders (which already were keyboard-operable range inputs) -
  a pre-existing gap for the whole camera toolbar, not introduced here,
  but not closed either.
- Wheel-zoom only listens on the 3D canvas itself; a trackpad's two-finger
  "pinch" gesture (as opposed to a wheel/scroll event) is not separately
  handled, though most browsers synthesize a `wheel` event for pinch
  already, so this is believed to work in practice but wasn't verified on
  physical trackpad hardware in this session.
- Camera state is still view-local/in-memory only, unchanged from the
  original task 3 limitation list above.

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

## Terrain & visual overhaul (2026-10-20) - supersedes the approach planned in tasks 5-8

**Status:** 🔨 Prototyped on `final-redesign-prototype` (not merged, not
deployed). Integrated, editable, verified in a real browser - awaiting the
user's own hands-on judgement before tasks 5-8 are closed against it.

The user's hands-on review named four problems: polygonal/stepped
coastlines with unnatural beaches; mountains as separate circular stamps in
Top-down and needle peaks in Oblique; rectangular, repetitive forests with
poor transitions; and no shared art style between the two views - with an
explicit instruction not to treat them as unrelated small fixes or hide
them under more noise.

### Root causes (verified in code and screenshots, separated by layer)

Baseline screenshots: `research/roadmap/screenshots/terrain-overhaul/before-*.png`.

| Symptom | Test-map data | Generation / brush | Rendering |
| --- | --- | --- | --- |
| Polygonal, stepped coast; green fringe past the beach | beach was a hard elevation clamp + a per-row `y > cy-10` sand rule, with land continuing past it | - | elevation read *bilinearly* (C0): every contour is straight segments kinking at cell edges; grass texture swapped on `floor(gx)` = cell-shaped blocks |
| Circular mountain stamps / needle peaks | range was `max()` of six radial bumps - literal circles | Mountain/Peak converged a disc to one fixed target (plateau + rim) and stamped `rock` on the whole disc | 3D ridge noise only on high ground, at `HEIGHT_SCALE` 46, so summits became isolated spikes |
| Rectangular, repetitive forest | hardcoded `x>150&&x<220&&y>90&&y<160` box | - | trees at a flat 22% per forest cell, 2 models, one tint, clipped to painted cells |
| Two art styles | - | - | **two separate renderers**: CPU canvas hillshade (own palette, own noise, NW light, no cast shadows) vs. GPU shader (different palette, different noise, a light from a different direction, ground received no shadows) - they could never match by tuning |

The last row is the structural one: as long as Top-down and Oblique were
two implementations, "consistent style" meant keeping two codebases in
visual agreement forever.

### Approaches compared

| | A. Patch both renderers (texture/noise per complaint) | B. Unify on the GPU renderer + shared derived-field model | C. Pre-render painted tiles (Inkarnate-style raster stamps) |
| --- | --- | --- | --- |
| Summary | Keep both renderers; add smoothing, textures and noise to each, per symptom | One Three.js pipeline draws both views (Top-down = the same scene from an overhead orthographic camera); a shared module derives smooth surface, ridges, material boundaries and coast distance from the grids, in JS *and* an identical GLSL twin | Composite authored raster stamps (mountain/tree sprites) on a 2D canvas, Wonderdraft-style |
| Fixes the structural style split | 2 (two codebases still drift) | 10 | 6 (2D only; Oblique would need its own) |
| Fixes data-shape causes (circles, boxes) | 3 (hides them) | 9 (fixed at source: seed + brush) | 5 |
| Stays fully editable / real-time synced | 9 | 9 | 6 (stamp placement per edit) |
| Reuses proven techniques | 5 | 9 (see CREDITS.md "Ported code and published techniques") | 7 |
| Implementation cost (10 = cheap) | 7 | 5 | 3 (needs an art pipeline that doesn't exist yet) |

**Chosen: B.** It is the only option that removes the style split instead
of managing it, and it fixes the data/brush causes at their source rather
than disguising them - which is exactly what the user ruled out.

### Implementation

- **`public/world/terrain-fields.js` (new) - one definition of every
  derived field**, mirrored line-for-line in GLSL:
  - C2 cubic B-spline reconstruction of the 256x256 grids (GPU: 4 bilinear
    taps, Sigg & Hadwiger) - smooth coastlines and material edges at any zoom
    with no extra stored data.
  - Display height = painted elevation + mapgen4-style render-time relief:
    gentle hill noise on lowland, a domain-warped, weighted ridged
    multifractal on high ground. A brush stroke becomes a branching range.
    **Baked** into a 512^2 float surface texture on the CPU (full ~70ms on
    load, ~1ms per brush-sized region on edit, measured), which the vertex
    shader, picking and tree placement all read - so geometry, picking and
    tree heights are identical by construction.
  - Material boundaries: per-type weight channels, B-spline sampled at a
    domain-warped position, then height-based blending (Mishkinis 2013)
    with per-material procedural heights - clumpy forest edges and rock
    outcrops instead of cell blocks or a soft fade.
  - Coast signed distance field (exact EDT, Felzenszwalb & Huttenlocher,
    seeded with sub-pixel crossings so it has no staircase), 512^2, ~35-50ms,
    throttled during strokes.
- **`terrain-renderer-3d.js` - draws both views.** Ground is Three's own
  `MeshLambertMaterial` patched via `onBeforeCompile` (so it receives real
  shadows - the old `ShaderMaterial` never did), one warm painted palette
  picked against `reference-painted-mountains-clouds.png`, automatic rock on
  steep/high ground and beaches by coast distance (so materials follow the
  land's shape, not the brush's), snow line, ink coastline, foam, and broken
  Wonderdraft-style ripple strokes. Water is drawn by the ground shader
  (seabed flattened to sea level), removing the separate transparent plane
  and its coastal cliff/z-fighting. Trees: KayKit meshes placed
  deterministically (hash-seeded) by the *rendered* forest weight, with
  clump/glade noise, treeline, beach exclusion, conifers uphill, per-tree
  tint and scale, lone copses on grassland; re-placed per 16x16 chunk.
  Two independent camera states (Top-down / Oblique) so switching never
  loses either view's zoom/pan/rotation; wheel zoom and right/middle-drag
  pan now work in Top-down too.
- **Brush (`world-client.js`)**: Mountain/Peak are now an additive uplift
  toward a ceiling with a world-anchored, noise-perturbed footprint (never
  beyond the brush circle), and no longer stamp rock. Create Land targets
  low coastal ground (0.06, was 0.35 - which, under the new renderer, turned
  every new strip of land into a rocky dome; found by painting it for real).
- **Seed scene (`scripts/seed-test-scene.ts`)**: rewritten as a believable
  region - fractal coast with a bay, headland, cape and an irregular island;
  one connected spine range with a spur; foothill and coastal forests from
  noise, not boxes; rock/snow/beach left to the renderer.
- **Fallback**: `terrain-renderer.js` (canvas) now runs only without
  WebGL2, with its palette aligned to the GPU one.

### Performance - measured, and fixed where it was real

A first painting test in headless Chromium hung. Profiling (CDP CPU
profile, then bisecting shader features by request interception) showed:
JS ~0.5s total; the rest was SwiftShader (software GL) compiling/running
the shaders - fragment colour ~19s, trees under shadow ~15s, shadows ~5s.
Much of that is the test environment (no GPU in WSL headless), but the
underlying shader was genuinely over-heavy, so it was reduced at the source:
each material's colour computed at most once and only where its weight is
non-zero; colour-variation noise from a generated tileable noise texture (1
tap) instead of procedural simplex (~30 ALU ops/call) - positional noise
that the CPU must match stays procedural; the per-vertex fBm replaced by the
baked surface; the shadow map re-rendered only on terrain/tree changes, not
camera moves; tree re-placement taken out of paint frames onto a 120ms
trailing throttle with cheap rejection before the costly material sample.
Result in the same software-GL harness: fragment cost ~19s -> ~3s over a
flat colour; camera/paint frames ~14/19ms once loaded. Not yet measured on
real GPU hardware - the user's own run is the real check.

### Verification (real browser, Playwright + SwiftShader WebGL2, 1600x1000)

Iterated v1 -> v7 against the reference images, each round looked at, not
just run - `research/roadmap/screenshots/terrain-overhaul/v*-*.png`:

- v1: unified views confirmed, but too much land, a thin "T" wall of a
  range, foothill forest on the wrong (north) side - an offset sign error -
  rigid three-ring ripples ("target" look), rock strata keyed to height that
  drew topographic contour rings round every summit. All fixed.
- v2-v4: massif widened with foothills both sides; forests darker and
  varied (floor colour, tints, conifers uphill); ripples broken into
  hand-drawn strokes; organic island. `v4-oblique-lowangle`: the range reads
  as one skyline with saddles, no isolated spikes.
- v5: a real painting session's strokes (Mountain across open plain, Peak,
  Forest, Create Land) - the Mountain stroke produced a ragged ridge with
  rock following its slopes, **not** a circle. It also exposed the Create
  Land pillar-island bug above.
- v6: after the Create Land fix, a new strip of land is a low sandbar that
  sits at sea level in both views; at high zoom the coastline is a smooth
  curve with ink line, foam and ripples - no steps, no polygon facets.
  Picking in Oblique after wheel-zoom landed on the right spot.
- **Picking bug found in diff review, fixed and verified numerically**:
  `canvasToGrid` only used the 3D ray-march in Oblique; with Top-down now
  being the same zoomable scene, Top-down strokes were computed as
  `px / PIXEL_SCALE` - correct only at zoom 1 with no pan. Fixed to pick
  through the scene in both views. Verified by intercepting the POSTed cell
  batch for a 1-cell Raise click (`.localdata/pickcheck.mjs`): zoom 1 ->
  (76.0, 76.0) vs expected (76.5, 76.5); after cursor-centred wheel zoom x2
  -> (140.0, 44.0) vs (140.3, 44.6); after a right-drag pan -> (153.0, 44.0)
  vs (153.0, 44.6). All within one cell.
- Behaviour change to note: right/middle-drag on the map now pans (both
  views) instead of painting; left-drag still paints.
- v8 (final code, real strokes): two passes of the Mountain brush across
  open plain gave an irregular ridge with rock on its slopes and a cast
  shadow, plus an organic Forest stand - `v8-plain-before/after.png`,
  `v8-oblique-after.png`.
- **Server-side functional checks** (`.localdata/func.mjs`, two clients with
  separate session cookies, scratch DB): painting elevation and type
  persists (204); client B receives `terrain:update`,
  `terrain-type:update` and `activity:new` over SSE; B's undo of A's
  stroke is refused (409); A's undo restores elevation 0.500 -> 0.507 and
  type forest -> grassland; the activity log records paint and undo.
- `pnpm check` (typecheck + 23 tests) passes. (One run showed 9 failures -
  traced to a stale scratch server from an earlier run still bound to the
  test port with its DB file deleted; rerun on a clean server: 23/23.)
- **Not completed under software rendering, by decision**: long multi-step
  Playwright painting sessions. In headless WSL Chromium (SwiftShader, no
  GPU) each stroke took 1-2 minutes, so the full scripted session (wheel-
  zoom + 1-cell brush + Oblique stroke + undo in-browser) was stopped rather
  than retried. Covered instead by the numeric picking check, the v5/v6/v8
  real-stroke screenshots, the HTTP checks above, and the user's own manual
  testing at `localhost:8802`.

### Remaining limitations (not hidden)

- Freshly painted *narrow* mountains (a ~9-cell brush) get needle-like
  summits in a close Oblique view (`v8-oblique-after.png`): the ridge noise
  amplitude is tuned for broad massifs. Needs the amplitude to scale with
  local ridge width, not just height.

- Not yet measured on real GPU hardware; SwiftShader numbers are a
  pessimistic proxy. First load still compiles a substantial shader.
- The 512^2 surface texture is re-uploaded in full per paint frame (~1MB;
  Three r169 has no sub-rect DataTexture upload) - fine on a GPU, a known
  cost.
- Material warp/height noise is evaluated in both JS (float64) and GLSL
  (float32); they agree to well under a cell, but a tree can occasionally
  sit a hair outside the drawn forest edge.
- Forest uses only two KayKit models; variety comes from tint, scale and
  stands. More models from the same CC0 pack would help.
- Rivers/lakes, roads and settlements are still task 9/12 - the reference
  maps have them and this map doesn't yet.
- The CPU fallback renderer only shares the palette, not the new material
  model.

### Release audit before merging to main (2026-10-20)

User-reported, both fixed:

- **Lag while painting.** Each paint frame rebuilt the whole type-weight
  texture, the coast distance field and every tree instance. Fixed by
  updating type weights only inside the dirty region, and deferring the
  coast SDF and tree rebuild to stroke end (`setStrokeActive` in
  `terrain-renderer-3d.js`). Elevation and type edits now each trigger only
  their own work.
- **Navigation controls missing in Top-down.** The camera panel was being
  hidden outright. It now always shows. Compass, direction presets and tilt
  are hidden only in Top-down, where they don't apply. Zoom, the pan pad and
  Reset stay visible in both views.

Production-data compatibility. The live map was painted with the old tools
(plains around 0.35, Mountain 0.6, Peak 0.95). Rendered from a read-only
copy, those plains came out as rocky, snowy foothills with coastal cliffs. The
fix recalibrated the renderer only: mountain band 0.42-0.85, lowland heights
compressed, beaches gated on displayed height. Stored data is untouched.
Before/after screenshots: `prodcopy-v2-*.png`. Side effect: the local demo
seed's ranges now read as low hills (`seed-v2-*.png`). The seed should be
re-tuned to the new band. That's a follow-up, since only the live map ships.

Independent code audit (server, client, deploy). Fixed:

- Activity entries (API and SSE) carried raw session ids. The session cookie
  is the only credential behind undo and mark-delete ownership, so anyone
  could impersonate anyone. Ids were removed from client-facing entries; they
  remain in the DB and server stdout.
- Session cookies now must be UUID-shaped, so arbitrary strings can't grow
  the per-session undo map. A malformed `%` escape no longer 500s the request.
- Request bodies are capped at 4MB, and batches at one grid's worth of cells.
  `cellsSummary` no longer spreads a huge array into `Math.min`, which could
  throw after the write had already applied.
- Client: a lost `pointerup` (alt-tab mid-drag) could leave a stroke active
  forever, which painted on hover and deferred coast/tree rebuilds. Fixed by
  ending the stroke on `lostpointercapture` and when `buttons === 0`.
- An SSE reconnect reloads the snapshot. It now re-applies pending local
  edits, so they no longer snap back.
- `.dockerignore` now excludes `research/`, `.localdata/` and `*.db`.

Audit items left open (low severity for a class-sized deployment):

- No per-session rate limit and no SSE connection cap or backpressure.
- No CSP or security headers. Runs as root in the container. No SIGTERM
  handler; SQLite's journal makes a SIGKILL safe.
- Tree instances are capped at 24k per model, so a very densely forested map
  loses trees in its last chunks.

Verified: `pnpm check` (typecheck plus 23/23 tests against a fresh scratch
server) and `pnpm check:evidence`. A two-session HTTP run confirmed paint, SSE
fan-out to the other session, cross-session undo refused (409), own undo
restored, and both activity entries logged. Also probed: a forged cookie gets
a fresh id, an oversized body is cut off, an over-cap batch gets 400, a
60k-cell batch is accepted, and a static path-traversal attempt gets 404.
`/`, `/world/`, `/readme/`, `/credits/` and `/logs/` all return 200.

## 5. Top-down fantasy-map art quality

**Status:** 🔍 Assessed - superseded by "Terrain & visual overhaul"
above, which fixes findings 1-4 at the data/brush/renderer level instead of
the texture-only approach compared below. Kept for the history of the
investigation.

The user's own framing of this task named four complaints: isolated
circular mountains, severe dark streaks toward the coast, rectangular
forests, and flat/repetitive grassland - plus "unnatural terrain
transitions" generally. Rather than treat these as one "looks artificial"
problem, each was investigated separately against the real renderer and
real painted data (not assumed), with an explicit instruction to
distinguish terrain-data causes from rendering causes from art-direction
gaps, and to not defer an obvious defect without a real reason. Findings,
in the order the user listed the complaints:

### 1. Circular mountain blobs - a brush/data shape problem, not rendering

Confirmed directly, not inferred from the one screenshot already on file:
a fresh dev DB was painted with two adjacent Mountain-tool strokes placed
close enough that a user would expect one ridge, using the real browser
UI via Playwright. Result: two distinct, fused circles - a "figure-8"
silhouette
(`research/roadmap/screenshots/2026-10-13-two-mountains-circular-blob.png`,
captured this session). This traces to `forEachBrushCell`
(`world-client.js`): every stamp is a radially-symmetric `smoothstep`
falloff from a centre point, and Mountain/Peak both converge every cell in
range toward one fixed target (`MOUNTAIN_TARGET`/`PEAK_TARGET`) - so the
*only* shape a stamp (or several overlapping ones) can ever produce is a
circle or a smooth union of circles. Task 2's relaxation pass softens the
*step* between adjacent cells that differ too steeply; it does not and
cannot change the underlying silhouette, which is circular by construction
before relaxation ever runs. **This is a brush/data-shape problem, not a
top-down-only rendering bug** - the same circular stamps would look
circular in the Oblique view too (task 6's problem as much as this one).
A full fix (irregular, noise-perturbed stamp footprints, or a different
brush-accumulation model entirely) is a data/authoring-tool change outside
a "renderer" task's scope as this file defines it, and risks reopening the
brush-precision and relaxation work already locked in by tasks 2 and the
"Already completed" brush-precision fix. What *is* fair game for a
rendering-only fix, and genuinely helps: visually breaking up a silhouette
with noise-perturbed edges at the type/slope boundary (detailed below)
makes a circular outline read as a rougher, hand-painted range rather than
a geometric circle, the same trick a hand-drawn map uses to disguise a
simple underlying shape - a real improvement, but explicitly **not** a fix
for the underlying circularity, which is named here as a limitation for
this task rather than silently left unaddressed.

### 2. Dark streaks toward the coast - a real rendering bug, confirmed quantitatively

This is **not** a style complaint - it's a bug, and a cheap one to pin
down. Directly evaluating `terrain-renderer.js`'s own shading formula
against the seeded scene's real elevation data (not by eye): two
horizontally-adjacent cells at `(97, 120)`/`(98, 120)`, whose real painted
elevations differ by only **0.014** (0.678 vs. 0.664 - a gentle, unremarkable
hillside slope, not a cliff), produce a hillshade brightness swing of
**0.70** (1.24x vs. 0.54x multiplier) - visually, a near-black streak
sitting right next to full-brightness grass with nothing resembling that
contrast in the actual terrain shape. Root cause: `reliefAt`/
`continuousReliefAt`'s curvature term (`(left + right + up + down - 4 *
center) * RELIEF_EXAGGERATION`, `RELIEF_EXAGGERATION = 9`) is fed the
*fold-noise-perturbed* elevation, not the raw painted elevation - and
`fractalFold`'s ridged noise has its own local second-derivative spikes
wherever two octaves' zero-crossings happen to land close together,
independent of how gentle the real underlying slope is. `extremeDamping`
in the 3D shader (`terrain-renderer-3d.js`) already exists to cap exactly
this failure mode for the oblique view (ROADMAP.md task 2's own account of
that fix); **the 2D top-down path (`terrain-renderer.js`'s `reliefAt`/
`continuousReliefAt`) never got the equivalent clamp**, which is why the
two views disagree so badly here. This is squarely this task's to fix, not
deferred: it is a rendering bug, confirmed by direct computation against
real data, with a precedent fix already shipped on the other renderer.

### 3. Rectangular forests - confirmed NOT a renderer defect; no top-down code change needed

Checked directly rather than assumed from the one screenshot on file: the
rectangular forest patch in `research/roadmap/screenshots/2026-10-12-top-down-current-state.png`
traces to `scripts/seed-test-scene.ts`'s own hardcoded test-data condition
(`x > 150 && x < 220 && y > 90 && y < 160`) - a literal axis-aligned box in
the *dev seed script used for QA screenshots*, not anything the renderer
or the terrain-type brush does. Painting forest with the real brush tool
in a live browser session (several overlapping dabs, not a filled
rectangle) produces an organic, lumpy, rounded patch
(`research/roadmap/screenshots/2026-10-13-forest-dabs-organic-shape.png`,
captured this session) - confirming the brush itself already produces
natural-looking footprints for terrain *type* painting (unlike Mountain's
circular *elevation* stamps above, type-only tools have no fixed-target
convergence problem to begin with). **No top-down rendering or brush
change is needed for forest shape.** What forest painting still lacks is
texture (addressed below) - the shape complaint and the texture complaint
are two different things that happened to be visible in the same
screenshot.

### 4. Flat, repetitive grassland - confirmed, and the type-boundary part of this is already half-fixed

Zoomed screenshots of real painted grass
(`research/roadmap/screenshots/2026-10-13-flat-grass-zoom.png`) confirm
the complaint directly: `TYPE_COLORS.grassland` is one flat RGB triple,
varied only by hillshading brightness - no texture, speckle, or colour
variation of any kind within a type. This is a real, in-scope gap for this
task. One genuinely surprising finding worth stating plainly (the user
asked not to defer things without justification, so this cuts the other
way too - not deferring a fix that already landed): this task's original
scope line called out "hard-edged type boundaries" as a defect, but
re-reading `continuousColorAt`/`continuousTypeBlend` shows this was
**already fixed as a side effect of Task 4's per-pixel rewrite** -
`continuousTypeBlend` bilinearly blends four real neighbouring cell
colours at every output pixel, and Task 4's own checkpoint already
verified a real intermediate colour exists at a forest/grass boundary, not
an instant jump. Re-confirmed visually this session (the forest-dabs
screenshot above shows a soft, not hard, edge). So the remaining "flat"
problem is purely the *lack of texture within* a type, not the boundary
between types - which narrows this task's real work to "add texture," not
"also re-solve blending Task 4 already solved."

### What stays out of this task, and why (not silently deferred)

- **Geological-scale material blending** (grass fading to scree fading to
  bare rock on a real slope, not just a colour-interpolated pixel boundary
  between two painted types) stays Task 7's, because it needs a designed
  blend *rule per terrain-type pair* (what does sand-to-rock look like vs.
  grass-to-rock), not a texture swap - solving it properly once in Task 7
  avoids building two different ad-hoc blend rules in top-down now and
  oblique later, which is exactly the "two separately-maintained copies"
  trap `terrain-renderer.js`'s own module comment already warns against.
- **3D tree geometry / real mesh vegetation** stays Task 8's - this task's
  texture work covers the flat 2D top-down canvas only; the Oblique view's
  billboard trees are a separate, already-scoped comparison (hand-rolled
  billboards vs. Kenney's Nature Kit meshes).
- **Rivers/lakes and the vector coastline's own shape** stay Task 9's -
  the coastline contour itself (`computeCoastlineRings`, real
  marching-squares extraction) is not named as broken by any of the four
  complaints investigated here, and ROADMAP.md already records it as "a
  relative strength of this renderer." What *does* belong to this task is
  the sand band's flat, textureless fill right along that coastline -
  covered under "flat, repetitive" above, not a coastline-shape problem.

### Research: existing techniques, before building anything new (`CLAUDE.md`'s reuse discipline)

- **Red Blob Games' mapgen4** (already partially adopted - see
  `terrain-renderer.js`'s own credit comments for `mountain_folds` and the
  oblique shear projection): its public write-ups describe the oblique
  projection and ridged-fold techniques already reused here, but do not
  document a specific top-down ground-texture technique beyond colour
  ramps - nothing further to adopt from this source for *this* task.
- **Azgaar's Fantasy Map Generator** (open source, Apache-2.0/MIT mixed,
  `github.com/Azgaar/Fantasy-Map-Generator`): its "satellite" render mode
  layers real-looking terrain colour/texture over a Voronoi-cell biome
  model, confirming the general approach (texture/noise over a categorical
  base, not per-cell flat fill) rather than offering a drop-in asset or
  code module for a square-grid renderer like this one's.
- **CC0/CC-BY painterly terrain texture packs** (OpenGameArt/itch.io):
  checked again for this task specifically (not just re-citing
  `CREDITS.md`'s prior search for *ink-stamp* packs, a different asset
  class) - the same gap found before holds here: available free packs are
  either seamless-but-generic (not keyed to this renderer's specific
  palette/style) or low-resolution pixel-art tile sets that read as a
  retro tile game, the exact style `CLAUDE.md` already steers away from.
  Nothing found closely matched enough to adopt directly.
- **The ANU course image-generation API** (`strproxy`'s
  `/api/images/generations`, `$30` course budget, separate from the Claude
  token budget): queried live - `recraft-v3` is the one allowlisted model
  with a dedicated seamless-pattern generation mode, a closer fit to
  "tileable ground texture" than a generic text-to-image call. This is a
  genuinely new option (not available when `CREDITS.md`'s original texture
  search ran) and is being evaluated as part of this task via a small,
  separately-approved, reversible experiment (see below) rather than
  assumed to work.

### Approaches compared

| | A. Procedural texture (hand-rolled noise/speckle, no new assets) | B. AI-generated seamless textures (course image API) | C. Source free CC0/CC-BY texture packs |
|---|---|---|---|
| **Summary** | Extend the existing `fractalFold`/value-noise machinery (already computed per-pixel for hillshading) into a second, finer-grained noise layer that perturbs each type's base colour - speckle/mottling for grass, grain for sand, fine cracks for rock - plus a noise-displaced silhouette edge at steep slopes/type boundaries to visually break up the circular-blob outline named in finding 1. Zero new assets, zero cost, fully deterministic/synced like the existing fold noise. | Generate a small set of seamless ground textures (grass/sand/rock) and tree/canopy billboard sprites via `recraft-v3`'s seamless-pattern mode, downloaded and committed as static assets (same model `CREDITS.md` already uses for the hand-authored tree PNGs), tiled as a `CanvasPattern` in top-down and a repeating `THREE.Texture` in the oblique ground shader/tree billboards. | Search OpenGameArt/itch.io again, this time specifically for *painted* (not ink-line) seamless terrain textures and tree sprites at this map's regional scale, reusing per `CLAUDE.md`'s discipline if a genuinely close match exists. |
| Visual quality | 6 | 9 | 7 (if a match exists; untested) |
| Feasibility | 10 | 7 | 5 |
| Style consistency | 7 | 8 (style is directed by prompt, tunable) | 4 (whatever the pack's own style is, not this app's) |
| Impl. cost (10=cheap) | 9 | 6 | 5 |
| Performance | 10 | 9 (one extra texture sample per pixel/fragment) | 9 |

**Risks:** Approach A's noise-perturbed silhouette is the only piece of
this task that touches the circular-mountain complaint at all, and it is
explicitly a visual disguise, not a fix (see finding 1) - must be reported
as a named limitation, not oversold as "fixed," whichever approach is
chosen for texture. Approach B is genuinely new since `CREDITS.md`'s last
asset search (the API itself didn't exist then) and carries real
unknowns: whether `recraft-v3`'s "seamless" style setting actually tiles
losslessly at this map's cell size, whether a billboard sprite's style
matches the hand-authored tree PNGs closely enough to sit side by side,
and real dollar cost - all reasons a small, cheap ($0.60), explicitly
reversible experiment is being run before committing to this approach
over A, rather than assumed to work from the model's marketing copy.
Approach C's risk is the same one `CREDITS.md` already recorded for ink
packs: free packs tend to be either off-style or off-resolution, and a
second search isn't guaranteed to find something new.

**Recommendation (provisional, pending the approved experiment's
results):** Approach B, *if* the small experiment confirms real seamless
tiling and a style that sits comfortably next to this renderer's existing
hillshading and the hand-authored tree PNGs - otherwise fall back to
Approach A, which is strictly worse on visual quality but has no
unknowns and no per-image cost. Approach A's noise-perturbation technique
(silhouette disguise, finer colour-noise layers) is recommended regardless
of which texture source wins, since it's cheap, reuses code already in the
file, and is the only concrete mitigation available for the
circular-silhouette complaint within this task's actual scope.

### What this task will and will not visibly change for users

- **Visible, if approved**: textured (not flat) grass/sand/rock fill in
  Top-down; the dark-streak artifact (finding 2) gone, confirmed by
  re-running the same brightness-delta check against the same data and
  expecting a bounded result; mountain/forest silhouettes reading as
  rougher and less perfectly circular (a visual disguise, not a shape
  fix - see finding 1's limitation).
  reads reasonably close to the hand-authored tree PNGs (if Approach B).
- **Not visibly changed by this task**: the underlying circular shape of
  Mountain/Peak brush strokes (still circular data, just less obviously so
  on screen); any grass-to-rock geological transition beyond today's
  colour-interpolated pixel boundary (Task 7); the Oblique view's own
  shading/texture quality, except that any new textures generated here are
  built with that reuse already in mind (Task 6, separately scoped and
  separately approved before any Oblique-specific rendering change).

### Small experiment (approved, in progress - see below for results)

Approved: up to 6 images / $0.60 from the course image budget, prioritizing
3 seamless ground textures (grass, sand, rock) and 3 tree/forest assets
over decorative UI chrome. Results, actual cost, provenance, and before/
after screenshots in both Top-down and Oblique will be recorded here once
the experiment runs, ahead of any final implementation decision or further
approval request.

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

## Platform: create, edit together, save, reload, share (2026-10-21) - supersedes tasks 10-11

**Status:** 🔍 Assessed and agreed with the user (2026-10-21). Not
implemented yet; implementation waits for the user to say go.

### Goal

One complete experience, not a feature list: **create a map, edit it
together, save it, come back to it, share it.** Every item below either
serves one of those five steps or is cut. The Final brief
(`assessments/final-project`, due 2026-11-09 noon) explicitly does not
require accounts, rooms or history. It marks process legibility at 50% and
penalises "features with no reason to exist". So scope is judged by whether
the loop is complete and the visuals are no worse, not by feature count.

### Decisions already made (user, 2026-10-21)

- **The existing world stays a public room** at `/`, editable by anyone, with
  its production data preserved (57,432 elevation cells, 18,581 type cells,
  9 marks at the 2026-10-20 deploy).
- **Every other room gets two links: edit and view-only.** View-only is
  enforced on the server on every write route, extending ADR 2's pattern.
- **Contributors are shown by anonymous display names** (`src/identity.ts`).
  No accounts.
- **Visual quality must not drop to make room for features.** See the
  parity gate under "Development order".
- The iPhone rendering fix (`da9bc2e`) has been confirmed on the user's real
  device, so mobile is no longer a release risk.

### Constraints measured, not assumed

- Production is one `shared-cpu-1x` machine with **256 MB RAM** and a
  **1 GB volume** (`fly.toml`).
- A copy of the live world's database is **4.1 MB** as rows
  (`.localdata/prodcopy.db`). A fully painted or fully generated room
  therefore costs about 4-5 MB, so the volume holds roughly 200 such rooms.
  Room creation needs a cap.
- A whole-map snapshot (elevation float32 plus type byte per cell) is
  **151 KB gzipped**, or 75 KB with int16 elevation. Measured on the
  production copy. Snapshots are cheap enough to keep.
- `terrain-fields.js` has no DOM dependencies. A generator in the same
  shared JS can run in the browser for preview and in Node for the stored
  result.
- The existing tests and client call unprefixed routes (`/api/terrain`,
  `/api/terrain/cells`, `/api/events`, etc.). These stay as aliases for the
  public room, so the current checks keep passing unchanged.

### History and saving: three options compared

The replay and full-history idea was compared against simpler options
before choosing.

| | A. Always-on autosave + file export | B. Named snapshots + restore/fork + file export | C. Full edit log (event sourcing) + replay + deep undo |
|---|---|---|---|
| **Summary** | What exists now, per room: every stroke is saved instantly. Add download/upload of a map file. No way back in time. | A: plus "Save version" with a name, an automatic snapshot before any restore, and periodic autosnapshots. Any version can be restored (private rooms) or forked into a new room. | Every stroke's before/after cells appended to a log, with checkpoints. Enables timelapse replay, browsing history at any point, and multi-level persistent undo. |
| Completes the create/save/reload/share loop | 6 | 9 | 9 |
| Protects users from mistakes (incl. other people's) | 3 | 8 | 9 |
| Risk to the existing write path | 10 | 8 | 4 |
| Storage predictability on a 1 GB volume | 10 | 8 | 5 |
| Impl. cost (10=cheap) | 9 | 7 | 3 |

**Why not C now:** it changes every write path (paint, type paint, undo,
restore), its storage grows with activity rather than with user intent, and
replay needs its own UI and playback renderer. Those costs sit squarely on
the loop the user named as the priority. Its unique payoffs (timelapse,
fine-grained history) are showcase features, not loop features. One design
choice matters if C is ever built: log **cell changes, not brush commands**.
Brush maths lives only in `world-client.js`, so replaying commands would
silently change old history whenever a brush is retuned.

**Recommendation: B.** It's the smallest option that makes "save" and
"reload" mean something beyond "it's always saved", and the snapshot before
each restore makes restores reversible. It also leaves C open: periodic
autosnapshots can be played back as a coarse timelapse later at almost no
cost (a stretch item below). Undo stays as it is today, one level per
session, now scoped per room. Deeper undo is C's job and is not attempted.

### Rooms: data model, three options compared

| | A. `room_id` column on existing tables | B. One SQLite file per room | C. Each room's grid stored as one compressed blob |
|---|---|---|---|
| **Summary** | Composite keys `(room_id, x, y)` on `terrain_cells`/`terrain_type_cells`; every query gains a room filter. | Open a `DatabaseSync` per room on demand. | Keep grids in memory per active room, flush as a ~150 KB blob. |
| Reuses existing code paths | 9 | 6 | 3 |
| Migration risk for production data | 7 | 6 | 4 |
| Memory on 256 MB | 9 | 7 | 5 |
| Write cost per stroke | 9 | 9 | 4 (rewrites the whole blob) |
| Impl. cost (10=cheap) | 8 | 5 | 4 |

**Recommendation: A.** SQLite can't change a primary key in place, so the
migration rebuilds both tables (create new, `INSERT ... SELECT` with the
public room's id, swap) in one transaction. It's guarded by a `schema_meta`
version, exactly like the existing `grid_size` check. Snapshots (option B
above) are gzip blobs in their own table, which is the one place C's idea
is used.

### Scope

**In, in order:**

1. **Rooms + links.** `rooms(id, name, edit_token, view_token, created_by,
   seed, params, created_at)`. Both tokens are 128-bit random and base64url.
   `/m/<token>` serves the editor, and the server resolves the token to a
   room plus a role. Per-room routes, SSE topics, undo maps and activity
   entries. Writes with a view token get 403 and are logged as `DENIED`.
   Edit-link holders can see both links in a Share panel. View-only visitors
   never receive the edit token and see the editor with tools hidden.
   Responses send `Referrer-Policy: no-referrer` so tokens in URLs don't leak
   to other sites.
2. **Create.** A "New map" dialog: choose blank or generated. Generated maps
   have a seed, a few sliders (land amount, mountains, forest) and reroll,
   with a live preview made by the shared generator in the browser. The
   server regenerates from `(seed, params)` and never trusts client cells.
3. **My maps.** A list of rooms this browser created or edited, keyed by
   session (`room_members`). Cross-device access is by the link itself, which
   is the stated substitute for accounts.
4. **Presence.** Who is in this room now, by anonymous name. This comes from
   per-room SSE connections, so it needs no new transport. It's the
   cheapest feature that makes co-presence visible.
5. **Save versions / restore / fork.** Named snapshots plus periodic
   autosnapshots, capped per room. Restore is available in private rooms
   only. It takes an automatic snapshot first, broadcasts a full reload to
   everyone, and is logged. **The public room cannot be restored**, only
   forked, because anyone can edit it and a restore would let one visitor
   wipe everyone's work.
6. **Export / import.** Download a map file (gzip grid plus metadata) and
   upload one into a new room. PNG export of the current view.

**Stretch, only if phases 1-4 are done early, in this order:**
live cursors (needs a client-to-server position channel at ~10 Hz);
a coarse timelapse played from autosnapshots; and visual follow-ups from
the overhaul's open list (narrow-mountain needle summits first).

**Deferred or not built, and said so in the README:** accounts, the full
edit log and replay (option C), multi-level undo, task 12 (buildings, roads,
objects), continent-scale maps, and a room member cap.

### Visual quality: how it's protected

- **The renderer is not modified for platform work.** Rooms change where
  data comes from, not how it's drawn. A **parity gate** runs at the end of
  every phase. The public room, loaded from the same production-copy DB, is
  screenshotted in Top-down and Oblique at fixed cameras before phase 1 and
  after each phase. Any visible difference blocks the phase until it's
  explained or fixed.
- **The generator is visual work and is judged as such.** Generated maps
  are what new users see first. They're screenshotted next to the reference
  images in `research/roadmap/references/`, not just checked for valid
  cells. They must produce connected ranges and organic forests, not the
  circular mountains and rectangular forests `CLAUDE.md` warns about. That
  means fixing shape at the data layer (falloff, ridged ranges, moisture),
  with heights calibrated to the renderer's 0.42-0.85 mountain band. This
  also replaces the open follow-up to retune `seed-test-scene.ts`.
- **Reuse before build:** the generator adapts published techniques already
  credited in `CREDITS.md` (mapgen4's ridged multifractal, simplex noise
  shared with `terrain-fields.js`). Before writing it, check Azgaar (MIT) and
  mapgen4 (Apache-2.0) for heightmap and moisture approaches. Both are
  mesh-based, so the expectation is to adopt techniques, not code. Record
  what was found in `CREDITS.md`.

### Main risks

| Risk | Impact | Mitigation |
|---|---|---|
| Production data migration (the one irreversible step) | Losing the live world | Dry run done (phase 0). Take a Fly volume snapshot before deploying. The migration backs the file up, checks counts *and* per-cell content hashes, and rolls back on any mismatch. Expected counts are read live at deploy time, because production keeps growing. Deploy at the end of phase 1, so there's time to recover. |
| Storage on 1 GB | Volume fills, writes fail | Caps on rooms (total and per session per day) and on snapshots per room, chosen from the measured 4-5 MB/room and 150 KB/snapshot. A check asserts the caps are enforced. |
| View-only bypass | A viewer edits | Every write route (paint, types, undo, snapshot, restore) resolves the role from the token server-side. A test sends each write with a view token and expects 403. |
| Restore in a shared room | One user wipes others' work | Private rooms only. Automatic snapshot first, so a restore is itself reversible. Logged with the actor. |
| Visual regression | The map looks worse | Parity gate every phase. Renderer files untouched outside the generator's calibration. |
| Generated maps look procedural or blobby | Poor first impression | Visual gate against references. Budget two iterations in phase 2. Blank map stays available. |
| Abuse with no rate limit (open from the release audit) | Room or snapshot spam | Per-session limits on create/snapshot/import, added in phase 1 alongside the routes they protect. |
| Schedule (19 days) | Loop incomplete at the deadline | Strict phase order. Each phase ends usable and deployable. Feature freeze 2026-11-07. |

### Development order

Each phase ends with `pnpm check`, the parity gate, and a two-profile
browser test. Deploys still need the user's approval each time.

| Phase | Dates | Delivers | Exit gate |
|---|---|---|---|
| 0. Baseline | 21-22 Oct | ✅ Done 2026-10-21, see "Phase 0 results". Parity screenshots of the public room. ADR 3 draft (rooms, links, roles). Migration script dry-run on a production copy. | Row counts preserved in the dry run. |
| 1. Rooms + links | 22-27 Oct | ✅ Deployed 2026-10-21 (release v10), verified live. See "Phase 1 deploy". Migration run at boot inside the new code. Token routing and roles. Phone layout overflow fix. Per-room SSE/undo/activity. Unprefixed routes alias the public room. Share panel and view-only UI. Rate limits on new routes. | Existing 23 tests green. New tests: room isolation, view-only 403 on every write, data survives restart. Parity gate. **Proposed deploy.** |
| 2. Create | 28 Oct - 1 Nov | Shared generator with preview. New-map dialog. My maps. Presence. | Generated maps reviewed against references. Generator is deterministic for a given seed (test). Parity gate. |
| 3. Save, reload, share | 1-4 Nov | Snapshots, autosnapshots, restore (private only), fork, file export/import, PNG export. ADR 4 (history model: B over C). | Restore round-trip test. Public-room restore refused. Import of a corrupt file rejected. Parity gate. |
| 4. Harden | 5-7 Nov | Caps, headers, both marking viewports, next-day return test after a restart. **Feature freeze 7 Nov.** | Full manual walkthrough of the loop on desktop and phone. |
| 5. Write-up | 7-9 Nov | README argued around the loop, with a "not built" list. `CLAUDE.md` and `spec/` aligned with it. `PROCESS.md` rewritten with real commits. Final reflection. Research note finalised. | `pnpm check` and `pnpm check:evidence` green on the deployed build. All writing within its word guidance. |

### Writing track (runs alongside the phases, not only at the end)

Figures from `topics/assessment` and `assessments/final-project`, checked
2026-10-21. There's no word-limit penalty, but badly overshooting can cost
marks under the response criterion.

| Deliverable | Guidance | Current state | Schedule |
|---|---|---|---|
| `research-note.md` (COMP8020, repo root) | 600-800 words. A cited *position* on good agentic development practice or where the field is heading. Sources weighed against each other, counter-case met. Worth 10% of the course. No crit covers it. | Doesn't exist. The brief said to start reading by week 10, so this is behind. | Reading list and one-sentence position by 24 Oct. Outline by 28 Oct. Full draft by 2 Nov. Revision 6-8 Nov. Use this project's own record as evidence (e.g. C8's tests passing on a bad result, ROADMAP's measure-first discipline), but argue from the literature rather than summarise it. |
| Final reflection, `reflections/final.md` | The two standing prompts, 150-300 words. **The brief doesn't define a Final reflection**: reflections are one per crit and the sweep reads only `crit-N.md`. Written as a user-requested addition, not a required file. | Doesn't exist. | Notes collected at each phase's end. Written 8 Nov. |
| `PROCESS.md` | 900-1100 words, *rewritten* (not appended), covering brief → harness → workflow, stack and workflow trade-offs, and claims backed by commit links. | **6,778 words**, mostly per-crit history. | Plan the cut by 2 Nov (what moves to ROADMAP or reflections). Rewrite 7-8 Nov. |
| `README.md` | 400-600 words. The argued definition of "good", influences, "not built" list. | 552 words, but it describes the single-map app. | Rewrite 7 Nov, once the loop is real. |
| `reflections/crit-10.md` | 150-300 words. | 546 words. | Already submitted for its crit. Left as is. |

### Phase 0 results (2026-10-21, branch `final-platform`)

No production data was modified. Production was only read through its
public GET endpoints. An SSH-based copy of the real database file was
blocked by the permission classifier, so the copy below is built from public
data.

**Database copy.** The real schema comes from the app's own code (an empty
database initialised by `src/server.ts`). The data comes from production's
public API on 2026-10-21. It holds **58,370 elevation cells, 22,259 type
cells and 9 marks**. Production has grown since the 2026-10-20 deploy
(57,432 / 18,581), so the migration's expected counts must be read from the
live database at deploy time, not from this file. Mark owners and the full
activity log aren't public, so those are stand-ins (9 marks under one
placeholder session, 5,000 synthetic activity rows at a realistic volume).
File: 4.96 MB, kept with a sha256 checksum that still verified after every
step below.

**Parity baseline.** Seven fixed captures: desktop 1600x1000 (Top-down,
Oblique default, zoom, low angle, high E→W) and phone 390x844 (Top-down,
Oblique). There were no console or page errors.
- **Noise floor:** two identical runs are **pixel-identical (0.000%, max
  channel difference 0)**. Rendering is deterministic for the same data, so
  the gate can require zero difference rather than a tolerance.
- **Sensitivity:** one 5x5-cell stroke (0.04% of the map) was detected in
  all seven images (0.04-0.24% of pixels changed), and the diff image marks
  exactly that spot.
- Tools: `.localdata/phase0/parity-shoot.mjs` and `parity-diff.mjs` (dev-only).
- Images: `.localdata/phase0/shots/baseline-run1/` (gitignored, like
  `research/`).

**Migration dry run** (`scripts/migrate-rooms.ts`, each case on a fresh copy):

| Case | Result |
|---|---|
| Normal run | 53 ms. Counts unchanged (58,370 / 22,259 / 9 marks / 5,000 activity). **Content hashes of every cell identical.** `integrity_check` ok. |
| Second run | No-op ("already at rooms_version=1"). |
| Failure injected just before commit | Rolled back. Schema, counts and hashes identical to the original. |
| Half-migrated state (`rooms` table, no version) | Refused, nothing modified. |
| Missing file | Refused. |
| File size | 4.96 MB grew to 9.0 MB from free pages left by the dropped tables. With `VACUUM` added: **4.2 MB**, hashes unchanged. |
| Current `main` code started on a migrated database | **Crashes on startup** (`ON CONFLICT clause does not match any PRIMARY KEY`). This fails loudly rather than corrupting anything, but it fixes the deploy order: the migration runs inside the phase 1 code at boot, not as a step before deploying. |

The existing 23 tests pass on a fresh database. `ADR.md` has an ADR 3 draft
(rooms, links, roles).

**Found during the baseline, not caused by it:** at phone width the layout
is a fixed **474 px wide**. At 360, 390 and 430 px the top bar, category
rail and canvas run off the right edge. The page doesn't scroll sideways, so
"Oblique" and "Activity log" are clipped and can't be reached. This is in
production today. The phone is a marking viewport, so this is **added to
phase 1**. It's a layout fix and touches no renderer code, but it will
change the phone parity images. Those get re-baselined once, deliberately,
after the user approves the new phone layout.

### Phase 1 results (2026-10-21, branch `final-platform`, not deployed)

**Built.** Server:
- `src/rooms-schema.ts` holds the one copy of the migration, run at startup
  by `src/db.ts` after a file backup, and by `scripts/migrate-rooms.ts` for
  rehearsals.
- `src/rooms.ts` handles tokens, roles, limits and "My maps".
- `src/presence.ts` handles who's here.
- Live-update streams, undo and activity are scoped per room.
- Every write is checked once in `handleRoomApi`.

Client:
- `public/world/room-ui.js`: Maps menu, Share sheet, Rename, presence
  chips, view-only mode, and a "No map at this link" page.
- `world-client.js` changed only its fetch paths and the paint and pan
  gating. **No renderer file was touched.**

The phone overflow is fixed: `minmax(0, 1fr)` on the grid, a two-row top
bar and a wrapping camera strip.

**Decisions made while building.**
- **Private activity stays out of the public `/logs/`**, because otherwise
  anyone could watch private maps being edited.
- **Viewers pan with a plain left-drag**, since they have nothing to paint.
- **Basic presence (who's here) was pulled forward from phase 2.** It cost
  one small module on top of per-room streams, and it makes "edit together"
  visible.
- **Refused writes are logged but rate-limited**, so a view link can't flood
  the persisted log.
- **Limits:** 150 maps total, 10 per session per day, 8 creates or renames
  per minute, and 400 open live connections. Sized from the measured
  4 MB/map and the 256 MB machine.

**Verified.**

| Check | Result |
|---|---|
| `pnpm check` on an empty data directory (as CI runs it) | typecheck clean, **41/41** tests (23 existing unchanged, 18 new in `spec/rooms.test.ts`), stable over repeated runs. `check:evidence` passes. |
| Startup migration on the production copy | Backup written, then migrated in ~130 ms with hashes verified. The public room's API output is **identical cell-for-cell** to production's public API (58,370 / 22,259), and all 9 marks are intact. |
| Restart | A private map's cells, name and "My maps" entry survive. The second startup runs no migration and writes no backup. |
| Real multi-user browser run (`.localdata/phase0/multiuser.mjs`, 3-4 isolated browser contexts) | **30/30.** Share sheet, Copy, Esc. Bob's stroke reached Alice in **140 ms**. Viewer: no tools, never receives the edit token, drag pans instead of painting, a forced API write gets 403, sees edits and renames live. Presence joins and leaves correctly. "My maps" lists the map. A bad link shows a clear message. Phone: nothing past the edge in editor, viewer or public room, and a tap creates land. No page errors. |
| Parity gate, desktop | **0 pixels changed inside the map** in all five views. All differences are in rows 9-37 (the new top bar). |
| Parity gate, phone | Layout changed by design: the canvas is 364 px, fully visible, versus 448 px before (58 px clipped off-screen). The map itself was checked by eye. **The phone baseline needs re-capturing once the user approves this layout.** |
| Load | 96 MB idle, rising to 116 MB with 400 open streams across 10 maps. The 401st stream gets a clean 503, and the server keeps serving. |

**Found and fixed during testing:** the public room's rename route returned
404 instead of a clear refusal. The read-only view still showed painting
hints. Presence chips overlapped and clipped their initials. Refused writes
used one log label regardless of action.

**Testing limits, stated honestly.**
- Headless WebGL runs on SwiftShader (CPU). Each tab spends ~6-7 s busy on
  first load compiling shaders and building trees. That's the same on `main`
  for the public room (measured), so it's existing renderer cost, not caused
  by rooms. It is not representative of a real GPU.
- Docker isn't running on this machine, so the CI image itself wasn't built
  locally. Same Node 24.21, same empty-data start instead. The Dockerfile
  copies `src/` and `public/` whole, so the new files ship.
- Mark owners and the full activity log in the production copy are
  stand-ins (see phase 0).

### Phase 1 deploy (2026-10-21, user-approved, Fly release v10)

**Backups taken before the deploy.**
1. Fly volume snapshot `vs_k4NM7w0wvzGheyqkP2Pa`, created 09:01:01 UTC, 35 s
   before the release was recorded and 50 s before the new machine started.
   It's a genuine pre-migration image.
2. The startup backup `/data/app.db.pre-rooms-1792573314153.bak` on the
   volume, written by the new code just before migrating.
3. A checksummed local export of the public API (`.localdata/deploy1/pre-*.json`).

The SSH-based on-machine copy stayed blocked by the permission check and
wasn't retried.

**Migration (production logs).** 315 ms, content hashes verified inside the
transaction. 58,370 elevation cells, 22,259 type cells and 1,871 real
activity rows. No errors.

**Verified live.**
- The public API's elevation, type and mark data match their pre-deploy
  content hashes exactly, both straight after deploy and again after all
  testing. The marks JSON is byte-identical.
- `/`, `/world/`, `/readme/`, `/credits/`, `/logs/` and `/isle/` all return
  200, with the new security headers.
- `spec/rooms.test.ts` and `spec/invariants.test.ts` pass against
  production: 20/20.
- The real multi-user browser run against production passes 30/30. Live
  edits arrived in 211 ms over the internet. View-only was refused, the
  phone layout fit at 390 px, and a phone tap painted.
- The production logs show 0 errors.

The other spec files write test cells into the shared world, so they were
deliberately **not** run against production.

**Process slip, recorded honestly.** I moved on to the deploy before the
snapshot had appeared in the snapshot list, having misread my own pending
wait as a result. The timestamps above show the snapshot completed before
the migration ran, so nothing was exposed. From now on the rule is to deploy
only after the snapshot is listed.

**Test maps created on production:** about 17 private maps from the room
tests and the browser run (names like "Test map", "Map A", "The Reaches,
revised"). They count toward the 150-map cap and could be cleared later.

**Rollback, if ever needed.**
1. Redeploy `da9bc2e`.
2. Restore `/data/app.db` from the `.pre-rooms-*.bak` file, or from volume
   snapshot `vs_k4NM7w0wvzGheyqkP2Pa`. The old code can't run on the
   migrated file.
3. Any edits made since the deploy would be lost.

Phase 1 comes first because everything else needs rooms, and because it
carries the only irreversible step. Doing it earliest leaves the most time
to recover. Creation comes before saving because a user needs a second room
before versions and forks mean anything.

## 10. Map expansion, multiple maps, saving and loading

**Status:** Superseded by "Platform: create, edit together, save, reload,
share" above. Multiple maps are rooms, and saving and loading are snapshots
and export/import. *Growing* a map's area (chunking, continent scale) is
deferred and not part of that plan.

## 11. Procedural/random map generation

**Status:** Superseded by "Platform: create, edit together, save, reload,
share" above (scope item 2, "Create"). The generator replaces the follow-up
to retune `scripts/seed-test-scene.ts`.

## 12. D&D-style buildings, walls, roads and draggable objects

**Status:** ⬜ Not started.

Scope: a new category of placeable, likely-draggable objects distinct from
terrain painting - closer in spirit to C8's marks (owned, placed, moved)
than to the terrain grid. Likely needs its own data model decision (a
third SQLite table alongside `marks` and `terrain_cells`) and its own
concurrency note in `ADR.md` once scoped.

## 13. Editor workspace UI/UX redesign

**Status:** ✅ Prototyped on `final-redesign-prototype` (branched from
`main` at `bf0a08e`, not merged - built and shown for a decision, not shipped
yet). Pulled forward out of numeric order (see "Product phases" above) at
explicit user request: "Prioritise UI/UX now, rather than more isolated
asset experiments."

### Root cause (verified against the running app, not assumed)

Every prior task in this file improved the *rendered map itself*; none
touched the chrome around it. Direct inspection of the pre-redesign app
(`research/roadmap/screenshots/2026-10-17-uiux-before-{topdown,oblique}.png`)
showed one dominant, structural problem shared by every tool and both map
views, not a cosmetic one: `#stage`/`#stage-3d` were hardcoded to a fixed
768×768px box (`CELL_PX = 3` constant × `GRID_SIZE = 256`) regardless of
actual window size, so on any wide monitor the map - the entire point of the
product - occupied a small fraction of the viewport, surrounded by empty
dark background. On top of that, all 13 tools (5 `tool-group`s: Elevation,
Relief, Terrain, Land, Water) were shown simultaneously in one wrapping
toolbar, and the camera controls (direction/tilt/zoom/pan, relevant only in
Oblique view) lived in a second toolbar permanently reserving vertical space
even in Top-down.

### Approaches compared

Three complete, real HTML/CSS mockups were built (not described) using an
actual captured map screenshot as content rather than placeholder boxes, so
canvas-to-chrome proportions could be judged honestly - rendered via
Playwright for side-by-side comparison, not eyeballed as markup:

| | A. Fixed left sidebar, flat tool list | B. Category rail + right "Tool Options" panel (Wonderdraft-style) | C. Canvas-first, floating panels over the map |
|---|---|---|---|
| **Summary** | Keep one always-visible sidebar listing every tool (grouped, not tabbed); canvas fills the remaining space. | Left icon rail selects a tool *category* (Land/Terrain/Water); a right panel shows only that category's tools and options - mirrors Wonderdraft's documented tabs + Tool Options split and Inkarnate's icon-rail + contextual-options pattern (researched via WebSearch, since `CLAUDE.md` names both as the visual target). | No fixed chrome at all - all panels float, semi-transparent, directly over a full-bleed canvas; closest to a "canvas is the whole app" feel. |
| Reuses target apps' real patterns | 4 | 9 | 5 |
| Canvas space at rest | 7 | 8 | 10 |
| Tool discoverability (new user) | 6 | 8 | 5 |
| Scales to more tools later (tasks 8-12 add vegetation density, rivers, buildings...) | 5 | 9 | 4 |
| Implementation cost (10=cheap) | 8 | 7 | 6 |
| Screenshot | `research/roadmap/screenshots/2026-10-17-uiux-direction-a-sidebar-mockup.png` | `research/roadmap/screenshots/2026-10-17-uiux-direction-b-wonderdraft-mockup.png` | `research/roadmap/screenshots/2026-10-17-uiux-direction-c-floating-mockup.png` |

**Risks:** Direction C's floating-everything look is the most visually
striking in a single screenshot, but a map editor needs tools to stay
discoverable and fitted to a long editing session, not just look good in a
marketing shot - panels drifting over live terrain also risks occluding the
exact area being edited, with no fixed-chrome alternative to glance at.
Direction A's flat always-visible list doesn't scale: tasks 8-12 (real
vegetation controls, rivers/lakes, procedural generation, buildings/roads)
each add more tools, and a flat sidebar grows linearly with no grouping
mechanism beyond what already exists today.

**Recommendation:** Direction B. It's the one option backed by a real,
documented precedent from the project's own named visual target (Wonderdraft
specifically ships left category tabs + a right Tool Options panel), it
scales to future tool growth via categories rather than list length, and it
devotes the most space to the canvas of any option that keeps tools
persistently discoverable (C only wins on raw canvas space by hiding tools
behind floating panels, which trades discoverability for it).

### Implementation

Direction B, implemented as:

- **Root cause fix (applies regardless of chosen direction):** `index.html`
  and `world.css` rewritten around a CSS Grid app shell
  (`grid-template-columns: 76px 1fr 230px`) with the canvas column as the
  only `1fr` track. `#stage`/`#stage-3d` changed from a fixed 768×768px box
  to `max-width/max-height: 100%` + `aspect-ratio: 1/1` inside a
  flex-centered `.canvas-area`, so the square grid's *absolute* size now
  responds to real available viewport space. `world-client.js`'s hardcoded
  `CELL_PX = 3` replaced with `computeCellPx()`, which measures
  `#canvas-area`'s actual bounding box once at load and derives a backing-
  store resolution from it (clamped 2-6px/cell), rather than assuming a
  fixed window size.
- **Category rail + options panel:** the old 5 `tool-group`s consolidated
  into 3 categories - Land (Elevation + Relief), Terrain (material), Water
  (Coastline + Seabed) - as a left icon rail (`wireCategoryRail()` in
  `world-client.js`) toggling which `<section data-panel="...">` is visible
  in a right `.options-panel`. Switching category also selects that
  category's first tool as the active one (`CATEGORY_FIRST_TOOL`), so the
  active brush is never a tool hidden in a panel that just closed. Icons are
  hand-authored inline SVG, not emoji - emoji was tried first in the mockups
  and rendered as empty "tofu" boxes under headless Chromium, a concrete bug
  avoided in the real implementation.
- **Camera controls demoted to a floating overlay:** `#camera-toolbar`
  moved from a second permanent toolbar to `.camera-float`, an absolutely-
  positioned panel inside `.canvas-area` itself, shown only in Oblique view.
  Justification: camera direction/tilt/zoom/pan is view-*navigation*, not a
  terrain-*editing* tool category, so it doesn't belong beside Raise/Lower/
  etc. in the rail/panel split, and keeping it permanently docked in
  Top-down (where it has nothing to control) was pure wasted space.
- **Shared brush controls:** one Brush size / Strength footer pinned to the
  bottom of the options panel, used by every category (an earlier draft
  duplicated these per-category; removed as unnecessary per this task's own
  "do not add unnecessary features" constraint - it was the same two
  sliders three times, not three different concerns).
- **Per-category hint text:** found and fixed during this task's own final
  art/usability pass (not part of the original three-direction comparison):
  the bottom hint paragraph was still showing fixed land/water-specific copy
  ("Raise / Lower / Smooth / Mountain / Peak only ever reshape existing
  land...") while the Terrain panel was active, describing tools that
  weren't even visible. Replaced the single static hint with
  `CATEGORY_HINT`, a per-category sentence swapped in `wireCategoryRail()`.
- **Responsive breakpoint:** below 900px width, the grid collapses to a
  single column (rail becomes a horizontal strip, options panel moves below
  the canvas, page becomes scrollable) rather than clipping the canvas.

### Verification (real browser, Playwright, against `localhost:8099`, seeded scene)

- **Canvas space:** `research/roadmap/screenshots/2026-10-17-uiux-before-topdown.png`
  vs. `.../2026-10-17-uiux-after-topdown.png` - the map now fills nearly the
  entire viewport at 1600×1000 instead of a ~768px box in a sea of empty
  background.
- **Both map views carry the new chrome correctly:**
  `.../2026-10-17-uiux-after-topdown.png` and `.../2026-10-17-uiux-after-oblique.png`.
- **Category switching works and updates the right state:** verified via
  precise `[data-category="..."]` locators (an earlier ambiguous
  `text=Terrain` selector falsely suggested switching was broken - it was
  matching 3 different elements, not a real bug; re-verified with
  `.evaluate(el => el.classList.contains("hidden"))` against both panels
  directly). Screenshots:
  `.../2026-10-17-uiux-after-terrain-panel.png`,
  `.../2026-10-17-uiux-after-water-panel.png`.
- **Actual editing workflow still works:** a real paint stroke was driven
  through Playwright and confirmed to fire a `POST /api/terrain/cells`
  request and visibly change the rendered terrain -
  `.../2026-10-17-uiux-after-paint-workflow.png`.
- **Camera controls still work after being moved into the floating panel:**
  dragging the compass dial rotated the view (needle moved, `W→E` preset
  activated) and the Tilt slider produced a visibly flatter viewing angle -
  `.../2026-10-17-uiux-after-camera-rotated.png`,
  `.../2026-10-17-uiux-after-camera-tilted.png`. Confirmed by actually
  viewing both renders, not just checking for a thrown error.
- **Responsive breakpoint:** `.../2026-10-17-uiux-after-narrow-viewport.png`
  at <900px width shows the stacked, scrollable layout working as designed.
- **Per-category hint-text fix:** `.../2026-10-17-uiux-category-hint-fix-terrain.png`
  confirms the Terrain panel now shows terrain-specific copy instead of the
  stale land/water text.
- `pnpm typecheck` passes clean after every change in this task.

### Remaining limitations (not fixed by this change, not hidden)

- `computeCellPx()` measures available layout space once at load, not on
  window resize (no `ResizeObserver`) - the CSS layout itself still scales
  visually on resize via `max-width`/`max-height`, but the canvas's backing-
  store resolution (and therefore paint-brush pixel precision) stays fixed
  to whatever size the window was at load. Not needed for this prototype's
  purpose (proving the layout direction), but a real follow-up before this
  is adopted as the final UI.
- No automated test coverage added for the new category-rail/panel wiring
  (`wireCategoryRail`, `CATEGORY_HINT`) - verified manually via Playwright
  in this session only, the same gap every other UI-only task in this file
  currently has.
- A full fresh art-consistency pass was done (new UI chrome's dark palette,
  spacing, and icon style against the terrain rendering, KayKit trees, and
  the CC0 grass texture) but did not surface changes beyond the hint-text
  fix above - recorded here as a pass that was actually performed, not
  skipped, per this task's own "check art consistency... and fix obvious
  problems yourself" instruction.
- This is a prototype on `final-redesign-prototype`, not yet adopted,
  merged, or deployed - the next step is the user's decision on whether to
  adopt it, per their own instruction ("Show me the working result before
  we decide whether to adopt it").

### End-of-session note (2026-10-17): known art-quality issues, not fixed tonight

Stopping for the day after the UI/UX redesign above - these four issues were
named explicitly and confirmed by re-screenshotting the live app (not
assumed from memory), but intentionally **not** investigated or fixed
tonight, per instruction. Each already has a home in an existing task below;
listed here as a single pointer so tomorrow's session can pick up without
re-discovering them:

- **Stair-stepped coastline.** Confirmed in a fresh zoomed screenshot of the
  sand/grass and sand/water edges
  (`research/roadmap/screenshots/2026-10-17-eod-coastline-zoom.png`): both
  boundaries are visibly blocky/grid-aligned, even though the ink coastline
  stroke itself is a smoothed vector curve (`d3-contour`, see task 1/9
  notes) - the blockiness is in the cell-fill boundary, not the stroke.
  Belongs to **task 5** (top-down art quality, already 🔍 assessed - see
  finding 2's sibling problem, the dark-streak bug) and **task 7** (natural
  terrain material blending, "grass/sand/forest/rock currently blend
  nowhere - a cell is one type, full stop").
- **Rectangular forest boundaries.** Already root-caused in task 5, finding
  3: confirmed **not** a renderer defect - the rectangular shape in prior
  screenshots traces to the dev seed script's own hardcoded box, and a
  live-painted forest patch is already organic. Still visible in tonight's
  screenshots because the seeded demo scene itself hasn't changed. No new
  investigation needed before tomorrow; re-check against a live-painted
  patch, not the seed scene, before treating this as still open.
- **Unnatural terrain transitions.** Covered by **task 7** (no blending
  between painted terrain types) and the brush-shape limitation named in
  task 5 finding 1 (Mountain/Peak strokes are circular by construction,
  acknowledged as a disguised-not-fixed limitation even after task 5's
  planned noise-perturbation mitigation).
- **Inconsistent 2D/3D art styles.** Confirmed side-by-side tonight
  (`.../2026-10-17-uiux-after-topdown.png` vs. `.../eod-oblique-full.png`):
  Top-down's flat, noisy grass fill and Oblique's lit, shaded mesh read as
  two different rendering styles for the same data, beyond the geometry
  work tasks 1-2 already did. This is **task 6**'s scope (Oblique fantasy-
  map art quality, ⬜ not started), which already names the same gap against
  `research/roadmap/references/reference-painted-mountains-clouds.png` - a
  warmer, more saturated, ink-outlined target style neither view currently
  matches, rather than the two views needing to match each other.

No code changes were made for any of these tonight - they're carried
forward as-is into tasks 5, 6, and 7, in that priority order per phase 1 of
the "Product phases" section above.

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
- **2026-10-13** - Task 3 revisited at the user's direct request: free
  360° rotation, cursor-centred wheel zoom, precise panning while zoomed
  in, no unexpected camera resets, and no conflict with terrain painting.
  Found and fixed a real bug behind the "unexpected reset" complaint
  (`setAzimuth`/`setTilt` used to call `fitView()` internally, silently
  discarding any zoom/pan on a direction/tilt change); paused mid-session
  on an initial mouse-only interaction plan at the user's request to
  properly compare toolbar-based alternatives instead, then implemented
  the approved one (draggable compass dial + pan trackpad, both off-canvas
  so they can never conflict with painting) with the three corrections the
  user named (state preservation, precise panning, cursor-centred zoom) -
  see "Revisit: free rotation, wheel zoom, precise panning" in task 3
  above for the full comparison, implementation, and verification trail.
  Commit
  [`8893e71`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/8893e7129ebf66a60621ff036ae6844c5742311a).
- **2026-10-13** - Task 5 assessed (this file), with an explicit
  instruction to separate terrain-data causes, rendering causes, and
  art-direction gaps rather than treat "looks artificial" as one problem.
  Confirmed directly against real painted data (not assumed from the one
  screenshot already on file): circular mountain blobs are a brush/data
  shape problem (two adjacent live Mountain strokes fuse into a literal
  figure-eight), not a rendering bug; the dark coastal streaks are a real
  rendering bug, pinned to a specific formula and confirmed quantitatively
  (two adjacent cells differing by 0.014 in real elevation produce a 0.70
  hillshade-brightness swing); the rectangular forest in the reference
  screenshot traces to the dev seed script's own hardcoded box, not the
  renderer or the brush (a live-painted forest patch is already organic);
  and the hard type-boundary complaint named in this task's original scope
  line was found to already be fixed as a side effect of Task 4's
  per-pixel rewrite. Also evaluated the ANU course image-generation API
  ($30 budget, `recraft-v3`'s seamless-pattern mode) as a new option for
  ground textures, queried live rather than assumed from docs, and scoped
  a small ($0.60, 6-image) reversible experiment to test it before
  committing to it over a hand-rolled procedural-texture fallback. Not yet
  implemented; the image-generation experiment and final approach choice
  are still pending.
- **2026-10-16/17** - On `final-redesign-prototype` (branched from `main` at
  `bf0a08e`, test data, not merged): real art-asset trials for task 8
  (Kenney Nature Kit glTF tree meshes vs. billboards, KayKit Forest Nature
  Pack, and a real CC0 grass texture replacing an AI-generated placeholder
  the user flagged as exactly the "fall back to self-generated assets"
  pattern they'd forbidden) - see `CREDITS.md` for the sourcing trail.
  Commits
  [`f6c391d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/f6c391d939b17601ff58152caad46cfc3a896399)
  and
  [`4c18d5f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/4c18d5fac32d3d977c38cb2553bda45a39383875).
- **2026-10-17** - Task 13 (editor workspace UI/UX redesign) assessed,
  implemented, and verified in the same session on `final-redesign-prototype`,
  pulled forward out of numeric order at the user's explicit request to
  prioritize UI/UX over further isolated asset experiments. Three complete
  design directions built as real, Playwright-rendered mockups and compared
  before writing any application code; Direction B (Wonderdraft-style
  category rail + right tool-options panel) implemented, along with the
  underlying root-cause fix both other directions would have needed too (the
  canvas's fixed 768px size, independent of which chrome surrounds it). A
  real content bug (stale, category-irrelevant hint text) was found and
  fixed during this task's own closing art/usability pass. See task 13
  section above for the full comparison, implementation, and verification
  trail with screenshot citations. Committed as
  [`9e198aa`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/9e198aa) -
  pending the user's review of the working prototype before deciding
  whether to adopt it, per their own "Show me the working result before we
  decide" request.
- **2026-10-17** - End of session: the user ran the redesigned prototype
  themselves locally (`localhost:8099`, a separate test DB) and named four
  remaining art-quality issues to carry into tomorrow without investigating
  or fixing tonight - stair-stepped coastline, rectangular forest
  boundaries, unnatural terrain transitions, and inconsistent 2D/3D art
  styles. Each was confirmed against the live app (fresh zoomed screenshots,
  not assumed) and mapped to its existing home in tasks 5, 6, and 7 rather
  than treated as new, undiscovered problems - see "End-of-session note" at
  the end of task 13 above for the evidence and task pointers. `.gitignore`
  updated to exclude `.localdata/` (local test databases), which had been
  showing as untracked without actually being ignored.
- **2026-10-21** - Platform plan assessed and agreed with the user: one
  complete loop (create, edit together, save, reload, share) instead of
  separate tasks 10-11. Recorded in "Platform: create, edit together, save,
  reload, share". Decided: the existing world stays a public room, other
  rooms get edit and view-only links, contributors get anonymous display
  names, there are no accounts, and history uses named snapshots (option B).
  A full edit log with replay (option C) was compared and deferred. Storage
  figures were measured on `.localdata/prodcopy.db`: 4.1 MB per fully painted
  room, 151 KB per gzipped snapshot. The iPhone fix (`da9bc2e`) was confirmed
  on the user's real device. No implementation yet.
- **2026-10-21** - Platform phase 0 done on `final-platform`. Production was
  read only through public GET endpoints, and no production data was
  modified. Results are in "Phase 0 results". The parity baseline is
  pixel-identical between runs and catches a 5x5-cell change.
  `scripts/migrate-rooms.ts` passed normal, repeat, injected-failure,
  half-migrated and missing-file cases with per-cell content hashes
  unchanged. Current `main` crashes on a migrated database, so the migration
  runs at boot in phase 1. Found a pre-existing phone layout overflow
  (474 px fixed width) and added it to phase 1. ADR 3 drafted.
- **2026-10-21** - Platform phase 1 built and verified on `final-platform`
  (not deployed, production untouched): rooms, edit and view-only links,
  Share and Maps UI, presence, per-room streams/undo/activity, and the phone
  layout fix. 41/41 tests. 30/30 real multi-user browser checks. Desktop
  parity: 0 changed pixels inside the map. The startup migration on a
  production copy serves cell-for-cell identical data. Awaiting the user's
  approval to deploy. See "Phase 1 results".
- **2026-10-21** - Platform phase 1 deployed with user approval (Fly
  release v10). Backups were taken first (volume snapshot
  `vs_k4NM7w0wvzGheyqkP2Pa`, the startup `.bak` file, and a local API
  export). The production migration verified 58,370 / 22,259 cells by
  content hash, and the public data is identical to pre-deploy. 20/20 room
  tests and 30/30 browser checks pass against production. See "Phase 1
  deploy".
