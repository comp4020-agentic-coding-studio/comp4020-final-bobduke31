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
