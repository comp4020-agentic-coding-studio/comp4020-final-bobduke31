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

## Crit 10 / Final: visual development on `c10-3d-terrain` (in progress)

C9 shipped deliberately behind on visuals (above). This work happens on a
local branch, never pushed or deployed without separate approval — see
`ROADMAP.md`, which now tracks it as an ordered, scored list of twelve
remaining tasks rather than as freeform chat history, and is the
authoritative live status for this phase; this section records the actual
decisions and findings behind entries there, not a duplicate of it.

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
