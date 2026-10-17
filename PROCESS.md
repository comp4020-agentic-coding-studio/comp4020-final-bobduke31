# Process overview

## Crit 8: The Isle (shipped 2026-10-04)

*Historical — this section describes the state of the app as of Crit 8. Where
it says something doesn't exist yet ("no real-time layer"), that was true
then; see **Crit 9**, below, for what's changed since.*

### What this crit shipped

The Isle: a shared, fictional island where a visitor clicks or taps a spot
and drops one of six fixed marks (flag, campfire, tent, boat, tree, ruin).
Marks are saved to SQLite on the Fly volume, so they survive a reload, a
restart, or a redeploy. There's no login — an anonymous per-visitor cookie
tags each mark, which also sets up the "distinguish users" requirement the
final project will need. On top of that, a visitor can now remove a mark
they placed themselves, but not anyone else's — the server checks the
cookie against who actually placed the mark before it deletes anything.
`README.md` carries the first draft of what "good" means for this app.

### Stack decision record

**Chosen**: plain Node 24 + the built-in `node:http` and `node:sqlite`
modules, no framework, no bundler, no build step. The repo's `tsconfig.json`
already expects `.ts` files to run directly (the `allowImportingTsExtensions`
comment says as much), and Node 24 does exactly that via its built-in
type-stripping — `node src/server.ts` runs with no compile step. That keeps
`Dockerfile` to a plain `FROM node:24-alpine`, a `pnpm install --prod`, and a
copy of `src/`/`public/`.

**Why not a framework** (Express/Fastify/etc.): the whole app is a handful of
routes (`/`, `/readme/`, `/credits/`, and `GET`/`POST`/`DELETE` on
`/api/marks`) plus static files. A framework would add a dependency and a
layer of routing abstraction over something `node:http` already does in
about 100 lines. Not worth it at this size.

**Why not `better-sqlite3`**: it's the more mature library, but it's a native
addon that needs a compiled binary per platform, which complicates the
Docker build (a toolchain stage, or trusting a prebuilt binary matches
Alpine's musl libc). `node:sqlite` ships inside Node itself — confirmed
working unflagged on Node 24.21 before committing to it — so there's nothing
to compile and nothing that can mismatch between the dev machine and the
container.

**Why one dependency (`marked`)**: README.md and CREDITS.md need to render as
HTML at `/readme/` and `/credits/`. Hand-rolling a markdown parser is exactly
the kind of reinventing-the-wheel the brief doesn't need solved from
scratch, and `marked` has no native dependencies of its own.

This was a first choice, made for a small prototype. The stack held up
through Crit 9 (below) without needing to be revisited — the real-time
layer was added on top of plain `node:http`, not by replacing it.

### What actually happened this week (Crit 8)

Short version: the simple version worked first, I spent too long trying to
make something fancier instead, it didn't actually look good once
I sat down and used it, and I ended up back where I started, plus one small,
real feature.

The longer version: the simple island from Crit 8
([37a6cc1](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/37a6cc1ed026b4c2cc032141e4eca4d6a39e82af) — "Ship first working version of The Isle
for Crit 8") already did the one thing it needed to do: place a mark, see it
still there later. That should have been enough for this round. Instead I
got it into my head that terrain should be editable too — visitors painting
grass, sand, rock, water, and forest onto the island itself, not just
dropping icons on top of it. I tried several approaches before giving up on
the direction: map shapes you draw and edit with a real map-editing library,
and later a brush that paints texture straight onto the island image so it
would blend into the original art, among others.

Every one of them technically worked. The code was fine, the automated
tests passed, and a script could click around a running page, paint,
reload, and confirm everything saved and came back correctly. But none of
that told me whether it was actually good. When I opened the page myself and
used it the way a visitor would, rather than just reading code or test
output, I didn't like what I saw. The shape-based attempt read as decoration
floating over the map, not the map itself changing. The brush attempt fixed
that, but by the time it also handled zooming, panning, erasing, and
painting past the island's edge, it had turned into a lot of fiddly
machinery for a feature that didn't make the app more fun — it made it more
complicated. It was more impressive to describe than it was good to
actually sit with.

So I stopped. I committed the experiment as its own commit
([a65b339](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/a65b33928093e22c4d9984ae594519bc8789d1fe) — "Experiment with editable terrain for The
Isle") so the attempt is on the record instead of just disappearing, and
then reverted it straight away ([f040c99](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/f040c9949353d52b003e734d1543607eea8874cb) — "Revert
'Experiment with editable terrain for The Isle'") to get back to the simple
island that already worked. Nothing from that detour made it into what
shipped for Crit 8; that app was the Crit 8 version, plus one addition.

That addition — the one real feature in that update — was letting a visitor
remove a mark they placed themselves. The server already tagged every mark
with an anonymous session cookie, so most of the work was reusing that:
checking the cookie on delete, the same way it's already checked on create,
rather than inventing anything new. In the interface, a mark you placed
carries a small red × in its corner; clicking it removes that mark from the
page and from the database. Marks that aren't yours never grow that button,
and the server refuses to delete them even if someone tried to force it
through the API directly — ownership is enforced on the server, not just
hidden in the UI.

The main thing I took from that week wasn't the feature itself. It was that
I let that detour continue for too long on green tests and a script that
clicked around and said "yes, it saved and reloaded," without looking at
the actual result often enough along the way. Tests are good at telling you
the plumbing works. They can't tell you whether the thing you built is
worth having. (Crit 9, below, is largely this lesson applied.)

### Assets (Crit 8)

Island art and mark icons were sourced from CC0/CC BY game-art projects
rather than hand-drawn, to get a more visually finished first version in the
time available. Full attribution and licence terms are in `CREDITS.md`.

### Known gaps as of Crit 8

Named in `README.md`'s "Known gaps" section rather than repeated here: no
rate limiting yet, no real-time layer yet, and one fixed island with no
growth yet. The real-time gap is what Crit 9 (below) addresses, for a new
`/world/` surface — The Isle itself is untouched and these gaps still apply
to it specifically.

## Crit 9: real-time terrain painting at /world/

The project's goal changed after Crit 8: `CLAUDE.md` was rewritten to point
at a real-time, multiplayer fantasy map — people shaping shared terrain —
not a static island with marks pinned on top. The first decision was *where*
to put real-time first: on the existing marks, or on a new terrain layer.
I chose terrain, because that's the actual target in `CLAUDE.md`, and because
building it as a second surface at `/world/` meant The Isle at `/` could be
left running, untouched, as a fallback — nothing here risks the thing that
already worked.

**Checkpoint 1 ([`056225a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/056225a1130813559dca093299b4abf6168e8bc9)):**
deliberately built the real-time loop *before* anything about how it looks —
a 128×128 elevation grid, a brush, writes going to SQLite and broadcast over
Server-Sent Events, with flat placeholder colour bands for rendering. This
was a direct reaction to the Crit 8 detour: last time, visual judgment and
feature-building got tangled together and a styling problem turned into
weeks of machinery. Separating "does the sync actually work" from "does it
look good" meant the first thing to verify was the real-time contract
itself. The automated test for this (`spec/terrain.test.ts`) doesn't just
check that a POST returns success — `waitForEvent()` opens the real SSE
stream and waits for the actual broadcast frame, because a 2xx response
proves the write landed, not that anyone else was told about it.

**Checkpoint 2 ([`83420a8`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/83420a8ee695e050cbc158410d649b0ce636cb21)):**
raised the grid from 128×128 to 256×256 for finer painting, mountain relief
with hillshading, a d3-contour vector coastline, and a toggleable oblique
projection alongside the existing top-down view. Two things in this
checkpoint came from hitting real problems, not from a plan:

- *The resolution change needed a real migration path.* By this point the
  schema could already hold real 128×128 data, so bumping `GRID_SIZE` to 256
  outright would have silently reinterpreted old coordinates at the new
  resolution — wrong, not just stale. `scripts/migrate-terrain-grid.ts` does
  the conversion explicitly (each old cell becomes a 2×2 block), always
  backs up the file first, is idempotent, and validates the row counts
  afterward before declaring success. `src/terrain.ts`'s `assertSchemaVersion()`
  refuses to start at all against data it doesn't recognise, rather than
  running and quietly corrupting it.

- *A real painting bug, found by hand, not by the test suite.* Dragging
  Lower or Smooth near a coastline (or just using them repeatedly) could
  push a land cell's elevation to or below sea level with nothing stopping
  it, scattering stray "ocean" cells through what should have stayed land.
  The existing tests passed the whole time — they checked that a posted
  elevation value persisted and synced, not that repeated strokes kept a
  coastline sane, which is exactly the kind of thing you only notice by
  actually painting for a while. The fix, in `setLandElevation()`
  (`public/world/world-client.js`): a cell that's already sea is left alone
  by every sculpting tool (only Create Land / Paint Sea may cross that
  boundary), and the result is clamped above a `LAND_FLOOR` constant, so no
  amount of lowering or smoothing can tip land into sea by accident.

**Where tests pass and the result still isn't good enough.** The oblique
view is the clearest case: it renders, it stays in sync in both directions,
`tsc --noEmit` and all 18 tests pass — and opening it next to the
Inkarnate/Wonderdraft reference material in `research/` still shows real
shortfalls. Visual depth falls well short of that target, dense terrain
reads as noise under the oblique shear, and every edit redraws the full
grid (~49ms) rather than just the changed cells — a cost that will only
grow with a bigger map. None of this shows up in a green test run; it only
shows up from actually looking at it, which is the same gap Crit 8's
reflection named. It's recorded here rather than smoothed over, and it's
explicitly not something this release tries to fix — see Known limitations.

`ADR.md` has the authoritative account of the concurrency decision this
feature needed (terrain is shared and ownerless; writes are
server-authoritative and last-write-wins per cell; a reconnecting client
always re-fetches full state rather than trusting the stream) and the
alternatives rejected there (a CRDT, per-cell locking) — not repeated here.

**Verification before this release:** ran the app locally against a fresh
database, drove it with two independently-cookied Playwright browser
sessions — not two tabs sharing state — confirmed a terrain edit in one
reached the other within ~1.2 seconds with no reload, and that the edit
survived a reload of the editing session. The production database was
inspected read-only beforehand: it holds only the Isle's 9 `marks` rows, no
`terrain_cells` table at all, so there was no legacy 128×128 data to
migrate — the new tables initialise fresh on first deploy without touching
`marks`.

**Known limitations, named rather than hidden:** the real-time layer
assumes exactly one Fly machine (true of this course's fixed deploy shape —
see the comment in `src/realtime.ts` — but not a general solution); the
oblique view's visual depth and redraw cost, above; forest, grassland and
sand remain flat colour with no texture pass; and two people painting the
same cell at the same instant silently clobber each other, per the accepted
cost in `ADR.md`. None of this is a C9 blocker — C9's bar is the real-time
loop and a documented concurrency decision, both in place — but all of it
is real, outstanding work for C10 and the Final visual pass.

## Final: visual development on `c10-3d-terrain` (merged to `main`)

C9 shipped deliberately behind on visuals (above). This work happened on a
local branch, reviewed and merged via
[PR #1](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/pull/1)
once independently re-verified in a real browser (not just re-reporting the
branch's own prior claims — see that PR's description for what was
specifically re-checked before merging: smooth top-down shading, a working
Oblique heightfield, camera controls with no state-reset regression, and
two-independent-browser-context real-time sync). See `ROADMAP.md`, which
tracks this as an ordered, scored list of twelve remaining tasks rather than
as freeform chat history, and is the authoritative live status for this
phase; this section records the actual decisions and findings behind
entries there, not a duplicate of it.

**3D heightfield renderer.** The oblique view's original column-extrusion
canvas renderer — flat-shaded rectangles shifted up by `elevation * 70px`,
no real geometry — was replaced with a Three.js/WebGL2 heightfield
(`terrain-renderer-3d.js`): real vertex displacement, GPU ridged-noise detail
added to actual geometry (not just lighting), slope/elevation-based material
blending, and ray-heightfield picking against the authoritative elevation
grid rather than the visual mesh. The first version of this plan proposed
primitive cone/cylinder trees and noise-only-in-lighting mountains; both were
rejected on review before implementation (noise needed to reach real
geometry, not just shading; trees needed an authored billboard texture, not
primitives) and the revised plan was what got built. Top-down is unchanged;
WebGL2-unavailable browsers fall back to the original canvas renderer
unmodified.

**Checkpoint ([`0164a74`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/0164a746584e6130ec66f44e396523737d586dd4)):**
ROADMAP.md task 1, a fixed water surface and independently editable seabed.
The actual bug, traced in code rather than assumed: this app has no water
surface at all, only a single elevation scalar per cell — a "sea" cell is
just one whose elevation is `<= SEA_LEVEL`. `detailedHeight()` passes sea
cells' elevation straight through, and the vertex shader displaces the mesh
to `elevation * HEIGHT_SCALE` with no floor underneath, so **the geometry
rendered as "water" was the seabed itself**. That one fact explained two
complaints at once: deepening a seabed cell visibly dropped "the water,"
and a beach next to a trench was a real ~25-unit vertical wall in the mesh —
not two separate problems needing two separate fixes.

Three approaches were compared in `ROADMAP.md` (a static flat water plane
decoupled from the seabed mesh; a visual-only depth-compression curve with
no new tool; a full per-water-body hydrology model with waves and foam).
The middle option was the easy patch but left "can't control shallow vs.
deep" completely unaddressed; the hydrology model is the right *eventual*
answer for rivers and lakes (deferred to task 9) but far out of proportion
to this task. The flat-plane approach was implemented: a static mesh at
`y = SEA_LEVEL * HEIGHT_SCALE`, decoupled from the seabed, plus a
`setSeabedElevation()` mirroring the existing `setLandElevation()` — same
shape, opposite direction, same reason: a cell that's already land is left
alone, and the result is clamped below a new `SEABED_CEILING` so no amount
of sculpting tips sea into land (only Create Land / Paint Sea still cross
that boundary). This reuses the exact pattern the Crit 9 coastline-erosion
fix established, deliberately, rather than inventing a new clamp shape.

Verified in-browser, not assumed from the diff: Playwright screenshots of
the oblique view before and after Deepen/Shallow strokes at the same
coastline spot that previously showed a cliff confirm the water stays flat
and level, with depth now reading as a colour change rather than a drop in
the surface; a `Create Land` stroke mid-sea now correctly pokes a new
island up *through* the still-flat water, which is only possible if the two
surfaces are genuinely independent. Top-down needed no changes and was
re-tested to confirm that empirically rather than by assumption. A second
browser session was instrumented to capture raw SSE frames rather than just
compared by screenshot: it received live `terrain:update` batches for both
tools with elevation values clamped exactly as designed (strictly negative,
several pinned at precisely `-0.02`, the `SEABED_CEILING` value, never at or
above `SEA_LEVEL`). Each batch arrived paired with a `terrain-type:clear`
event; traced to `src/terrain.ts`'s existing, unrelated rule that any cell at
or below sea level loses its terrain type — a no-op here, not a new
interaction this task introduced. `pnpm typecheck`, all 18 tests, and
`pnpm check:evidence` pass unmodified; no server, schema, or API change was
needed or made.

**Known limitations, named rather than hidden:** the water plane is a
single flat, static surface — no waves, no shoreline foam, and a lake looks
identical to the ocean; depth is communicated only through the seabed's own
colour showing through the semi-transparent plane, with no dedicated depth
colour ramp yet. Both are deliberately deferred to task 9
(coastlines/rivers/lakes) rather than folded into this task's scope. None of
this is a C10/Final blocker on its own — it is exactly the kind of gap
`ROADMAP.md` exists to keep visible rather than let quietly slide.

**Checkpoint ([`693f475`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/693f475e6fbf5600a04f5d885f0b97b7177ff4c2)):**
ROADMAP.md task 2, natural elevation and slope transitions. Two real,
visually-caught failures happened while implementing this, not just a clean
path to the final design, and both are worth recording because they were
only caught by actually rendering the result next to an unmodified baseline
— exactly the discipline `CLAUDE.md` names and the earlier oblique-view
section above already illustrates once.

The task had two parts: a brush/data-side fix (a bounded relaxation pass
that softens abrupt adjacent-cell jumps, scoped tightly to each stroke's own
footprint so it can't expand a deliberately small brush or erase an
intentional feature — the user's own correction before implementation), and
a render-side fix (don't let the GPU ridge-detail noise pile extra
jaggedness onto a slope that's already extreme — the user's second
correction). The brush-side fix went cleanly. The render-side fix did not:

- **First attempt** replaced the existing elevation-based noise gate
  outright with a local-slope gate (steeper terrain = more detail, flatter
  = less). Screenshotting the oblique view immediately showed the coastline
  itself — an intentional, by-design discontinuity, not an artefact, per
  `ADR.md` — rendered as a jagged, spiky line. A slope-only gate has no way
  to distinguish "a real mountain face" from "the coastline," since both
  are steep in the same way.
- **Second attempt** narrowed the slope band and widened the sampling
  radius to try to exclude coastline-level slopes specifically (calculated
  against the actual seed-data profile, not guessed). This mostly fixed the
  coastline, but a *new*, different artefact appeared: isolated spikes
  partway down otherwise-smooth hillsides that hadn't been there before.
  Tracing it (by computing the actual slope profile of an isolated seed
  bump in plain Node, not just reasoning about the shader) found the cause:
  a pure local-slope gate is zero at a dome's flat summit and *peaks in a
  ring partway down the flank* instead — a shape the original elevation-
  based gate never had — and the ridged-noise function's own occasional
  sharp crests showed through as visible pokes wherever that ring happened
  to cross one.
- **What shipped instead:** keep the original, already-good elevation-based
  envelope completely unchanged (confirmed via a direct screenshot
  comparison against the pre-task-2 formula on identical seed data — pixel-
  equivalent), and add a *damping ceiling only* — ordinary terrain is
  untouched, and only a local slope beyond what the relaxation pass ever
  leaves in the data gets its noise amplitude reduced. This is the version
  that matched the untouched baseline exactly while still measurably
  protecting against a genuinely pathological slope.

A separate, real bug surfaced during this same work, unrelated to the
shader: Mountain and Peak had never been wired to the Strength slider at
all — a single click at the brush centre jumped straight to
`MOUNTAIN_TARGET`/`PEAK_TARGET` regardless of Strength. This was the actual
reason a small, modest-radius stroke still read as an instant narrow cone
even with the relaxation pass in place: there was no gradual build-up for
the relaxation pass to smooth between. Fixed by multiplying the lerp factor
by `brushStrength`, the same integration every other elevation tool already
had.

**Verification:** direct A/B screenshot comparisons against the unmodified
baseline (zero regression confirmed, not assumed); new Mountain/Peak
features built up over several strokes read as rounded domes, not cones;
the actual post-relaxation elevation data queried directly from SQLite to
confirm a quantitative bound (max adjacent-cell difference 0.143, under the
0.15 threshold); a tiny radius-1 brush stroke confirmed still precise; a
second session's raw SSE frames captured to confirm the relaxation pass's
extra cells sync live; a reload confirmed persistence. `pnpm typecheck`,
all 18 tests, and `pnpm check:evidence` pass; no server, schema, or API
change. Full detail, scoring, and the stated remaining limitations are in
`ROADMAP.md`, not duplicated here.

**Checkpoint ([`e07061b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/e07061b30b84ceea0051c569353e02d67009ec4c)):**
ROADMAP.md task 3, camera controls. The user's approval added two concrete
constraints beyond the original four-direction/tilt/zoom/pan/auto-fit scope:
auto-framing must never surprise-reset the camera mid-edit (a dedicated
Reset/Fit View button instead), and picking/tree billboards must keep
working at low, dramatic camera angles specifically, not just at the one
tilt the renderer happened to ship with originally.

The fixed `center`/`viewSize`/`distance`/`tiltFromVertical` constants became
a live `camView` state object, with `fitView()` doing real work: it scans
the actual painted elevation range, then projects that bounding box's 8
corners onto the camera's own right/up axes to size the frustum — this
directly fixed the tall-mountain clipping bug the task 3 assessment named,
for any direction, not just whichever one the old constants were tuned
against. `fitView()` is wired to run from exactly three places (initial
load, the explicit fit button, and an azimuth/tilt change) and nowhere
else, so the "don't reset while editing" requirement holds by construction
rather than by coincidence of test ordering.

One genuine bug was caught during verification, not before it: the first
tilt implementation had `sin`/`cos` swapped (and the corresponding min/max
tilt comments inverted to match), so the slider's two extremes rendered
backwards from their intended meaning — tilt=80° showed a near-top-down
view, tilt=14° showed the dramatic low angle. Caught by actually looking at
the rendered screenshots against what the slider was supposed to mean, not
by reading the formula and assuming it was right; fixed and re-verified at
both extremes.

A second, pre-existing bug named in the task 3 assessment itself (not a
regression from this work) was fixed as planned: tree billboards had never
actually been billboards — each instance's matrix set position and scale
only, never rotation, so the planes kept one fixed world-space orientation
that only looked right because the original fixed camera happened to sit on
the one side that orientation faced. They now recompute a full camera-facing
transform every frame from the live camera position.

**Verification:** all four azimuth presets, both tilt extremes, both zoom
directions, and the pan pad were each screenshotted and visually confirmed
correct in the browser against `localhost:8800`. Two of the approval's
specific requirements were tested in a way designed to actually
discriminate a pass from a false positive, not just re-confirm the happy
path: the "must not reset while editing" requirement was tested by setting
a deliberately unusual camera state (non-default azimuth, zoom, pan),
reading back the exact slider values, painting on an unrelated part of the
map from a different view, and confirming the state and the rendered frame
were pixel-identical afterward — not by relying on the coincidence that an
earlier fit-view click would have left the same framing either way. The
"picking at low angles" requirement was tested by painting a Peak stroke at
a known screen coordinate at a 78° tilt and a non-default W→E azimuth, with
an on-screen crosshair overlaid on the click point in the verification
screenshot confirming the resulting peak rose up exactly there, not at a
neighbouring cell. `pnpm typecheck`, all 18 tests (against a fresh dev DB),
and `pnpm check:evidence` pass unmodified; no server, schema, or API
change. Full detail, scoring, and the stated remaining limitations (the sun
stays fixed in world space; manual zoom/pan resets on an azimuth/tilt
change by design; camera state is per-tab, not synced between editors) are
in `ROADMAP.md`, not duplicated here.

**Checkpoint ([`5d519da`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/5d519da7be0f503598f5b8f957d98728813ec614)):**
ROADMAP.md task 4, rendering resolution, pixelation and anti-aliasing. The
assessment traced "looks rough" in both views to four separate causes
rather than one, and the approval added a real correction to the
recommended approach: Top-down's pixelated look was not to be kept as an
intentional style choice - "precise editing does not require visibly
blocky graphics" - so both views needed genuine smoothing, not just a
higher-resolution version of the same flat fill.

The fix that actually mattered for top-down wasn't the device-pixel-ratio
sizing alone (that only stops the browser *upscaling* an already-blocky
image) - it was replacing the renderer's per-cell flat `fillRect` with a
true per-pixel continuous evaluation: bilinear elevation, finite-difference
relief, and terrain-type colour bilinearly blended between neighbouring
cells. The one constraint the correction named explicitly - don't blend
incorrectly across coastlines or between terrain types - shaped the
design directly rather than being bolted on afterward: the land/sea
boundary is never colour-blended at all (a hard formula switch keyed off
the same continuous elevation field the vector coastline itself reads),
and any terrain-type blend that would otherwise reach across that boundary
falls back to the pixel's own land-side colour instead of pulling in a
sea-side sample. The oblique WebGL shader's analogous fix (blending
already-resolved corner colours rather than a raw type index, which would
be meaningless as a fraction) uses the identical technique for the
identical reason, not a second ad hoc solution.

Two things were checked rather than assumed, and the numbers didn't match
the first guess in both directions - worth recording as real process
evidence, not just a clean result. First, the mountain-fold noise needed a
precomputed lookup table to stay fast at per-pixel-continuous sampling
rates; a numerical check (20,000 random fractional positions against
direct calls) confirmed the table's bilinear resampling error (~0.005 mean,
~0.054 worst case) was small enough to be invisible, and exact at integer
grid coordinates - so existing per-cell callers got the swap for free with
no behaviour change. Second, an initial assumption that a full-canvas
redraw would cost "low tens of ms" was wrong: measured directly, it costs
~330-415ms at the default 2x-capped pixel ratio - slower than expected,
though the case that actually matters for painting responsiveness
(interactive per-stroke partial redraws) measured at ~4ms, unaffected. The
higher number was corrected in the code comment and reported honestly in
ROADMAP.md as a named limitation rather than left as the original
optimistic guess.

**Verification:** terrain-type boundary blending was checked
quantitatively, not just by eye, in top-down - decoding the actual
screenshot PNG's pixel data across the seed scene's known forest-patch
boundary (`x=150`) shows a real intermediate colour between pure grass and
pure forest, not an instant jump. The oblique view's blend was confirmed
by zooming the live WebGL view 3x directly onto the same forest patch's
edges, after an automated `gl.readPixels`-based pixel scan was tried and
abandoned - correctly locating a known grid cell's exact screen position
through the oblique camera's projection math for an automated assertion
turned out to add more risk of a false result than the direct zoomed
screenshot already resolved by inspection. Coastline domain-safety was
checked the same way: a pixel scan straight across a real coastline
crossing showed sand, a short genuine strip of grassland (confirmed
against the seed script's own type-painting rule, not a rendering
artefact), the vector coastline's ink stroke, then sea - never a muddy
intermediate colour. Picking accuracy was re-verified after the pixel-scale
change specifically because that change touches the exact pixel<->grid
conversion math it depends on: a Peak stroke landed within 1 cell at
`devicePixelRatio: 1` and exactly on target at `devicePixelRatio: 2`,
confirmed via `/api/terrain` diffing, not by eye. SSE sync to a second
browser context and reload persistence were both re-confirmed rendering
identically with the new renderer. `pnpm typecheck`, all 18 tests, and
`pnpm check:evidence` pass unmodified; no server, schema, or API change.
Full detail, scoring, and the stated remaining limitations (the ~330-415ms
full-redraw cost; the WebGL2-less 2D oblique fallback not getting a
DPR-consistent shear) are in `ROADMAP.md`, not duplicated here.

**Checkpoint ([`8893e71`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/8893e7129ebf66a60621ff036ae6844c5742311a)):**
ROADMAP.md task 3, revisited. The user asked to revisit the
already-"done" camera controls directly against a concrete usability bar:
smooth 360° rotation, wheel zoom, free panning while zoomed in, no
unexpected camera resets or scene reloads, and no conflict with terrain
painting. Reading the existing implementation surfaced a real, previously
unflagged bug matching that complaint: `setAzimuth()`/`setTilt()` called
`fitView()` internally, so simply changing direction or tilt silently
discarded any zoom/pan the user had already set up - an unexpected camera
reset, just not the specific one (painting-triggered) the original task 3
had been tested against.

A first implementation plan (mouse-only: right-drag rotate, middle-drag
pan, wheel zoom) was proposed and then explicitly paused by the user before
being built - button/modifier-based gestures were flagged as unintuitive,
and the user asked for a visual navigation design (a compass/orbit
control, pan control, zoom control) to be compared properly first rather
than assumed. Three toolbar-based alternatives were compared (a draggable
compass dial + pan trackpad; an on-canvas view-cube-style gizmo; a plain
continuous azimuth slider) - the on-canvas gizmo scored well on
discoverability but was flagged as carrying real risk of exactly the
painting-conflict the user was trying to avoid, since it would be a second
drag surface on the same canvas the paint handlers already own. The
toolbar-dial approach was chosen for keeping every new drag gesture
physically off the canvas by construction, and approved with three
corrections: all camera controls must preserve each other's state (nothing
resets except the explicit Reset/Fit View button), panning must support
precise fine control while zoomed in (not just coarse nudging), and wheel
zoom must be cursor-centred.

The implementation fixed the root cause directly: `setAzimuth`/`setTilt`
no longer call `fitView()` at all (matching `setZoom`/`panBy`, which never
did), so `fitView()` is now reachable only from initial load and the
explicit fit button. `camView.azimuthIndex` (4 discrete values) became a
continuous `azimuthDeg`, driven either by the four preset buttons
(unchanged as shortcuts) or by dragging a new SVG compass dial
(`Math.atan2` of the pointer's position around the dial centre, mapped
through a dial-angle/azimuth-angle conversion derived from and checked
against the camera's own existing position formula). The two-scalar
`panX`/`panZ` became one `THREE.Vector3 panOffset` (needed because a
tilted camera's own "up" has a real world-Y component the old
representation couldn't hold), driven by a new drag "trackpad" whose
pointer-delta-as-fraction-of-pad-size feeds `panBy()` continuously -
precise at any zoom because `panBy`'s own step already scales with the
current view size. Cursor-centred wheel zoom (`zoomAtCursor`) was derived
from the orthographic frustum's own geometry (the world point under a
given clip-space offset from view-centre, solved for the `panOffset` shift
that keeps it fixed as zoom changes) and wired to a `wheel` listener on the
3D canvas only, never colliding with the canvas's existing
pointerdown/pointermove-based painting handlers, which don't listen for
`wheel` at all.

**Verification:** a Playwright session against the seeded test scene
exercised rotation (an 8-step ~350° compass drag, confirmed continuous via
screenshots at angles with no preset nearby), cursor-centred zoom
(confirmed the frame zoomed toward the actual cursor position, not the
view centre, and clamps correctly under a 40-/60-notch scroll burst in
each direction without scrolling the page), and precise panning (a small
~8px trackpad drag produced a correspondingly small, exact shift, bringing
a previously off-screen peak into view at the top edge rather than
overshooting). State preservation was tested as one continuous sequence
across all controls (rotate, zoom, pan, zoom again, preset click), reading
back zoom/tilt/compass state after each step to confirm the others were
untouched - directly exercising the "nothing resets except the explicit
button" requirement, the same discipline the original task 3 checkpoint
used for its own reset-on-painting test. Painting was then confirmed to
still work correctly through the new controls (a Peak stroke after the
full sequence produced a real `/api/terrain/cells` POST, a changed
elevation sum, and a new peak exactly where clicked) and, separately, that
painting and camera state are mutually inert - camera state read
byte-identical before/after a paint stroke, and a view-mode round trip
(Oblique → Top-down → Oblique) still reproduces an identical frame, as
before. Reset/Fit View was confirmed to remain the only control that
resets zoom/pan, correctly reframing at whatever azimuth/tilt was active
rather than snapping back to the original default direction. `pnpm
typecheck`, all 18 tests (against a genuinely fresh dev DB - the seeded
scene used for screenshots has its own cells pre-painted and is not what
the suite runs against), and `pnpm check:evidence` pass unmodified; no
server, schema, or API change. Full detail, the interaction-design
comparison table, and the stated remaining limitations (no keyboard
equivalent for the dial/trackpad beyond the existing preset buttons and
sliders; pinch-to-zoom on physical trackpad hardware not separately
verified) are in `ROADMAP.md`, not duplicated here.

## Crit 10: multi-user permissions, activity logging, and the homepage swap

C10's brief asks for something narrower and more concrete than the visual
work above: two or more people, each in their own browser, acting on
shared state, with the app able to tell them apart — a permission checked
server-side, written down with why, plus a persistent server-side activity
log. The existing session cookie (`src/session.ts`, shipped for Crit 8) and
the existing per-mark ownership check (`deleteMarkOwnedBy`) already proved
this app has the right identity model; what C10 added was extending that
same pattern to terrain, and giving it a durable, demo-ready log.

**Checkpoints:**
[`879f109`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/879f1097fa275abdb78021a94ed86fa1d7446432)
(activity-log table and stdout logging),
[`2f6e757`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/2f6e7570d2aa02c208ee7cb45d53459290a3ae55)
(per-session undo snapshot/restore),
[`25c6b22`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/25c6b22a301e2621a1415df99a4430f31b9f0d10)
(server wiring: undo endpoint, log endpoints, the homepage/`/isle/` route
swap),
[`53871ac`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/53871ac0d8543b36d279f709f369cf85bb1d935d)
(client undo button),
[`9ab156b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/9ab156b4859a8856bb36f1f5d2719662e303531e)
(automated tests, and the `waitForEvent` race fix).

**The permission chosen, and why not a bigger one.** Terrain itself stays
the shared, ownerless canvas `ADR.md`'s first entry already decided for C9
— nothing in C10's brief asks every feature to gain per-user restriction,
only that *a* real one exist and be checked server-side. Reopening that
decision now, with no new evidence it was wrong, would be exactly the kind
of unnecessary scope creep `CLAUDE.md` warns against. Instead, a new,
genuinely useful permission was added: **undo is strictly per-session.**
`POST /api/terrain/undo` restores whatever *the requesting session itself*
last painted. The check isn't a comparison a future edit could remove by
accident — the server holds an in-memory snapshot keyed by the session id
read from the request's own cookie (`src/undo.ts`), and there is no field
in the request that could name a different session's snapshot at all. Full
reasoning and the alternatives considered (per-cell terrain ownership,
invite-link roles, logging with no new permission) are in `ADR.md`'s second
entry, not repeated here.

**A real bug found while building the snapshot, before it shipped.** A
single brush stroke that sets both elevation and terrain type (Mountain,
Peak) reaches the server as *two separate sequential POSTs* from the
client's existing batching (`flush()` in `world-client.js`) — not one. A
first version of `captureStroke` simply overwrote the previous snapshot on
each call, which would have silently discarded the first POST's "before"
state the moment the second POST arrived milliseconds later: undoing a
Mountain stroke would have only reverted the rock-type paint, leaving the
elevation change in place. Caught and fixed before any manual testing, by
re-reading the client's own flush timing rather than assuming one POST per
stroke — `captureStroke` now merges writes into the same snapshot within a
400ms window (mirroring the client's own `FLUSH_INTERVAL_MS=100`, with
slack), keeping the *first* reading per cell (the real pre-stroke value),
not the most recent. Verified directly afterward: a live Mountain stroke in
a real browser produced two distinct activity-log entries
(`terrain:paint`, `terrain-type:paint`) but one `terrain:undo` that
reverted all 317 touched cells in a single pass — confirmed both
numerically (`/api/terrain` diff) and visually (an Oblique-view screenshot
after the undo cycle shows the exact pre-stroke baseline terrain, not a
half-reverted mountain).

**The activity log** (`activity_log` table, `src/activity.ts`) records
every terrain paint, terrain undo, terrain-type paint, mark creation, and
mark deletion — including denied ones, logged as `DENIED ...`, not silently
dropped, since a refused cross-session action is exactly the finding the
crit's demo format is built to surface. It lives in the same SQLite file as
every other table, on the one volume that survives a restart or redeploy,
so it outlives the crit as required. Every entry is also printed to stdout,
so `flyctl logs -a <repo>` tailed live — the brief's own prescribed demo
method — shows the same thing with no UI involved. A visitor is shown as a
short deterministic display name (`src/identity.ts`, e.g. "Lone Finch
#9f2") rather than their raw session id, for the same reason
`toClientMark` already never hands a client another visitor's raw id.

**The in-app log viewer** (`/logs/`) is this app's own tool for reading
that same log, SSE-fed off the identical broadcast channel `terrain:update`
already uses — not a second real-time mechanism. Its purpose, per the
brief's own framing, is "what you and your agent read when the deployed
app misbehaves," not something built only to pass the crit; `flyctl logs`
stays the primary demo path regardless.

**Verification, in a real browser, not assumed from the diff.** Two fully
independent browser contexts (separate cookie jars, no shared storage —
not two tabs) were driven with curl and Playwright together: session A
painted a cell and created a mark; session B's attempt to delete A's mark
correctly returned 403 *and* produced a `DENIED` activity-log line naming
A's mark by id; session B's own attempt to call `/api/terrain/undo` with
nothing of its own to undo correctly returned 409 and left A's cell
completely unchanged (confirmed via `/api/terrain`, not assumed from the
409 alone) — the actual property C10 asks to see demonstrated, not just a
passing status code. A's own undo then correctly reverted its own stroke.
The `/logs/` page was opened in a separate browser context from the one
painting, confirming new entries appear there live with no reload. All of
this is also covered by `spec/activity.test.ts`'s own automated checks
(session-distinguishing display names, successful self-undo, a 409 for
nothing-to-undo, and the specific "B's failed undo attempt doesn't touch
A's data" property), run against a fresh dev DB.

**A real, pre-existing test race, exposed and fixed.** Adding
`activity.test.ts` (which also posts terrain cells, concurrently with
`terrain.test.ts` against the same running app and the same global SSE
broadcast channel) turned a latent flakiness in
`terrain.test.ts`'s own `waitForEvent` helper into a reliable failure: it
resolved on *the next* event of a given type, not necessarily *its own*
event, so another test file's concurrent write could resolve it first with
the wrong payload. Fixed by adding a content-matching predicate to
`waitForEvent` (now takes a `matches(data)` filter, not just an event-type
string) — confirmed fixed by running the full suite three times in a row
clean, where it had failed on the very first run after the new test file
was added. `pnpm typecheck`, all 23 tests, and `pnpm check:evidence` pass.

**The homepage swap.** `/` now serves the exact same file `/world/` does —
a direct serve, not a redirect, so the browser's address bar stays at `/`
throughout (confirmed via Playwright: `page.url()` read back as `/` after
load, after painting, and after a reload). `/world/` keeps working
unchanged as a compatibility alias. The Isle (Crit 8's shipped app) is
unchanged and fully functional, moved to `/isle/` rather than deleted, so
its existing `marks` data and the whole experience it shipped stay
reachable. `README.md` was rewritten from describing The Isle to describing
the actual current app, since it had gone stale the moment `/world/`
became the project's real direction back at Crit 9 — this was overdue
independent of C10, and C10's own requirement to "update outdated homepage
references" was the forcing function to finally do it. Verified live in a
real browser at the deployed URL post-deploy (see below), not just locally.

**Known limitations, named rather than hidden:** undo is one level deep,
in-memory — a server restart or a second stroke before undoing the first
loses the ability to undo an earlier one; this is a real, accepted
limitation for "undo my last click," not a version-history feature (that's
`ROADMAP.md` task 10, tracked separately as Final-project scope, not
conflated with this narrower permission feature). The activity log has no
pagination — it caps at the 200 most recent entries on load, relying on
the live stream for everything after; fine for a debugging/demo aid, not
an archive browser. Terrain itself remains ownerless by deliberate,
documented choice (`ADR.md`), not an oversight — C10 doesn't ask for every
feature to gain per-user restriction, only that a real one exist.
