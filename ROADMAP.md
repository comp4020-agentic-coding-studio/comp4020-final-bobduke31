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

**Status:** 🔍 Assessed - awaiting approval to implement.

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

**Waiting for approval before implementing**, per your instruction.

---

## 2. Natural elevation and slope transitions

**Status:** ⬜ Not started.

Scope: mountains/hills should read as naturally-formed landforms (broad
bases, gradual slopes, occasional sharp ridgelines where geologically
plausible) rather than narrow spikes. Root cause already identified in the
prior combined assessment: Peak/Mountain push a *small-radius* area to a
high target, and the GPU ridge-detail noise (gated by raw elevation, not by
the painted data's own local slope) exaggerates whatever steepness is
already there. Depends partly on task 1's seabed work being settled first
(both touch the same displacement/detail shader path) - sequenced to
address the slope-gating logic once that shader area is stable rather than
twice.

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
