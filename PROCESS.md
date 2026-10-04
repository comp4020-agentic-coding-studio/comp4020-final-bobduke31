# Process overview

## What this crit shipped

The Isle: a shared, fictional island where visitors paint terrain and place
objects on a single shared map. Edits are saved to SQLite on the Fly volume,
so they survive a reload, a restart, or a redeploy. There's no login — an
anonymous per-visitor cookie tags each edit, which also sets up the
"distinguish users" requirement the final project will need. `README.md`
carries the first draft of what "good" means for this app, and now also the
record of the redesigns below.

This went through six shapes before landing here, all within the same crit
cycle (the first shipped as a checkpoint commit, then redesigned five more
times before the cutoff — see commit history):

1. **First pass**: a static island image with six icon pins (flag, campfire,
   tent, boat, tree, ruin) a visitor could drop on top of it.
2. **Second pass**: a tile grid — water, sand, path, rock, forest, building,
   ruin — built from the same pixel art as the island itself, so an edit
   reshapes the map instead of sitting on top of it.
3. **Third pass**: the same tile grid, but with neighbour-aware autotiling,
   per-tile jitter, and canvas rendering, so the grid itself stops being
   visible.
4. **Fourth pass**: back to a static island image (the same one from the
   first pass), with marks placed freely on top of it rather than snapped to
   a visible grid — because the tile-grid approach, even with smooth edges,
   never looked like a *complete* island.
5. **Fifth pass**: the static image was gone entirely. The island became a
   continuous per-cell terrain-weight grid (a splat map) blended at render
   time, with a separate object layer on top — so painting genuinely
   changed the map, including erasing and replacing existing terrain. See
   "Redesign: terrain as data, not an image" below for why, and why that's
   not a contradiction of pass 4's work so much as the lesson it led to.
6. **This pass**: the custom splat-map renderer is retired in favour of
   **Leaflet + Leaflet-Geoman**, a mature open-source map-editing library, with
   the island back to being a single static backdrop image — the same CC0
   sprite from passes 1 and 4, restored rather than re-sourced. Terrain areas,
   roads/paths, and objects are now GeoJSON polygons/lines/markers that
   Geoman's own toolbar draws, edits, drags, and deletes, rather than a
   hand-rolled brush and canvas compositor. See "Redesign: vector features via
   Leaflet + Geoman" below.

## Stack decision record

**Chosen**: plain Node 24 + the built-in `node:http` and `node:sqlite`
modules, no framework, no bundler, no build step. The repo's `tsconfig.json`
already expects `.ts` files to run directly (the `allowImportingTsExtensions`
comment says as much), and Node 24 does exactly that via its built-in
type-stripping — `node src/server.ts` runs with no compile step. That keeps
`Dockerfile` to a plain `FROM node:24-alpine`, a `pnpm install --prod`, and a
copy of `src/`/`public/`.

**Why not a framework** (Express/Fastify/etc.): the whole app is four routes
(`/`, `/readme/`, `/credits/`, `GET`/`POST /api/marks`) plus static files.
A framework would add a dependency and a layer of routing abstraction over
something `node:http` already does in about 100 lines. Not worth it at this
size.

**Why not `better-sqlite3`**: it's the more mature library, but it's a native
addon that needs a compiled binary per platform, which complicates the Docker
build (a toolchain stage, or trusting a prebuilt binary matches Alpine's musl
libc). `node:sqlite` ships inside Node itself — confirmed working unflagged
on Node 24.21 before committing to it — so there's nothing to compile and
nothing that can mismatch between the dev machine and the container.

**Why one dependency (`marked`)**: README.md and CREDITS.md need to render as
HTML at `/readme/` and `/credits/`. Hand-rolling a markdown parser is exactly
the kind of reinventing-the-wheel the brief doesn't need solved from scratch,
and `marked` has no native dependencies of its own.

This is a first choice, made for a four-route prototype. If the app outgrows
plain `node:http` — more routes, real-time fan-out to many open connections,
auth — the plan is to swap and write a new decision record here, not to wedge
a framework in after the fact.

## Redesign: terrain as data, not an image

Pass 4 (a static island image with freeform patches) fixed "looks like a
tile editor," but review of the running app surfaced the problem it didn't
fix: edits still read as separate patches placed on top of the image, the
painterly-photo background and pixel-art patches never matched as one style,
and there was no way to actually erase or replace terrain — only ever add
another patch over it. The brief before redesigning again was explicit:
research how existing map/terrain editors solve this, then redesign around
that, rather than iterating on the patch idea again.

**What the research said.** Three reference points, each answering a
different part of the brief:

- **Unity's terrain system** paints with a *splat map* — every cell on the
  terrain holds a blend weight per texture type (grass/rock/sand/etc.),
  painting a brush raises the target weight and lowers the others at that
  spot, and the renderer blends textures by that weight field. There's no
  separate "edited" layer; the weights *are* the terrain.
- **Tiled and Wonderdraft** both hard-separate a continuous ground/terrain
  layer from a layer of discrete placed objects (trees, buildings, props).
  Terrain blending rules and object placement rules are unrelated to each
  other, which is why an object can sit on any terrain without the terrain
  needing to know about it.
- In all three tools, **"erase" is not a distinct operation** — it's just
  painting a different value (terrain) or deleting one entity (an object).
  There's no history to undo, only a data value to overwrite.

**The new model, directly from that.** `src/db.ts` now holds a 48×48 grid
of cells; each cell is five weights (grass/sand/path/rock/water, summing to
1), computed from a base formula (a wobbled radial coastline) and optionally
overridden by a `terrain` table row keyed by cell. `paintTerrain` is the
splat-map brush: for every cell within a soft falloff radius of the clicked
point, it nudges the chosen kind's weight up and scales the other four down
proportionally so they still sum to 1 — which is also exactly how painting a
different kind "erases" whatever was there before. Objects
(forest/building/ruin) moved to their own `objects` table — an
auto-incrementing list of `{x, y, kind}`, unrelated to the terrain grid,
mirroring Tiled/Wonderdraft's layer split; an eraser click removes the
nearest one. `GET /api/terrain` returns the whole blended grid pre-merged
(base + overrides), the same "client never computes the base rule" contract
the tile-grid passes used.

**Rendering**: `public/app.js` builds one full-size alpha mask per terrain
kind by rendering that kind's weights to a tiny (cols×rows) canvas, then
drawing it scaled up to full render resolution with image smoothing on —
letting the browser's own upscale blur a blocky data grid into a continuous
gradient, the same cheap trick as pass 3's autotiling but applied to a
continuous field instead of discrete tile choices. Each terrain layer is a
seamless texture swatch (`public/assets/textures/*.png`) clipped through its
mask with `destination-in` and composited in a fixed draw order (grass, then
sand/path/rock, then water last, so coastlines read clearly). Objects draw
on top afterward, with a hash-derived variant/flip/jitter per object (kept
from pass 3) so repeated objects don't look stamped.

**Caught by testing, not just by reasoning:**

- The first texture picked for "rock" was a stone-*wall* tile (visible
  mortar lines, designed to tile as brick) rather than a ground texture.
  Blended through the weight mask at partial opacity, it didn't fade — it
  showed up as a distinct grid of semi-transparent brick squares, reviving
  exactly the "looks like a tile editor" complaint pass 4 was meant to have
  solved, just at a different level. Caught by screenshotting a painted
  patch and zooming in, not by reading the code. Fixed by replacing it with
  a flat, lightly-flecked swatch matching the plain-fill style every other
  terrain texture already uses (no internal grid lines to begin with).
- The palette (nine buttons in a row) overflowed the viewport width on a
  phone-sized screen (390px), pushing it partly off-screen to the left.
  Caught by an actual mobile-viewport screenshot. Fixed with a small-screen
  media query that wraps the palette and shrinks the buttons, plus
  hardening the palette's own positioning math so it can never place itself
  off-screen even if its content changes again later.

## Redesign: back to a real island image

_(Superseded by the redesign above — kept as a record of what was tried and
why it wasn't enough on its own.)_

Pass 3 (autotiling, jitter, canvas) made the tile grid's *texture* look much
better — smooth edges, varied objects, no visible seams at the tile level.
It did not fix the thing that turned out to matter more: at the scale of the
whole island, a coastline assembled from a formula and rendered as square
tiles never reads as a complete, natural place, no matter how clean the
edges are. On top of that, a real layout bug shipped in that pass — the
canvas rendered as a stretched rectangle instead of a square, because its
intrinsic `width`/`height` attributes and the CSS `aspect-ratio` could
disagree. That bug was fixable; the underlying "generated tile coastline
doesn't look like a real island" problem was the actual signal to stop and
reconsider the approach, not patch it again.

**New model**: the island is a single, complete, pre-made image again (the
same `isle_24` sprite from pass 1 — see `CREDITS.md`), cropped tightly to
its own silhouette rather than the padded square it ships as, so it fills
the frame instead of floating in a lot of empty sea. `COLS`/`ROWS`,
`baseGround`/`baseObject`, and the whole `ground`/`object` split from passes
2–3 are gone; `src/db.ts` is back to an append-only `marks` table
(`id, x, y, kind, session_id, created_at`), the same shape as pass 1's, with
one addition: `x`/`y` are snapped to a 400-step grid before being stored
(`src/db.ts`'s `snap`). That grid exists only so two visitors clicking "the
same spot" agree on where that is — at 400 steps across the island's width
it's far finer than a click can aim, so nothing about it is visible, and
placement still feels freeform.

**Marks, not tiles**: a mark is still one of the same seven kinds (water,
sand, path, rock, forest, building, ruin), rendered as the same small
outlined patches built during pass 3 (`object-forest.png`,
`object-rock.png`, etc.) — those were already good art, the problem was
never the patches, it was the generated ground underneath them. Two new
patches (`object-water.png`, `object-sand.png`) were cut the same way, now
that "water" and "sand" are marks placed freely rather than ground tiles
assembled into a coastline. Rendering is still a single `<canvas>` (keeping
pass 3's fix for fractional-scale sprite distortion), but now it draws one
full-resolution island image plus a handful of small patches, instead of
hundreds of tiles.

**Finding the island's real bounds**: the source sprite's PNG is 16-bit
colour, which a hand-written 8-bit-only PNG decoder (built during pass 2 to
read tile sheets) decoded as garbage. Rather than extend that decoder,
cropping was done inside a real browser — load the image into a canvas,
read its pixels with `getImageData`, find the non-transparent bounding box,
redraw just that region to a new canvas, and export it — since the browser's
own image decoder handles any PNG correctly regardless of bit depth.

## Redesign: hiding the grid

_(Superseded by the redesign above — kept as a record of what was tried and
why it wasn't enough on its own.)_

The second pass fixed the "stickers on a photo" problem but introduced a new
one: it now obviously looked like a tile editor — flat, hard-edged squares
with every seam visible. Fixing this meant also reclassifying the data
model slightly: `rock` and `path` moved from being `ground` types to
`object` types (a rock is a prop sitting on grass, not a terrain region with
its own blend rules), leaving `ground` as just `water | sand | grass` — the
only two the source packs actually ship a full edge/corner set for. `COLS`
and `ROWS` also moved from 20 to 30, since a finer grid makes the now-smooth
coastline read as a curve rather than a staircase.

**Autotiling**: each of the two non-grass ground types has a 9-tile set
(4 corners, 4 edges, 1 fill), extracted from the same Kenney packs. At
render time (`public/app.js`'s `groundSpriteKey`), each tile checks its four
orthogonal neighbours and picks the piece whose edges/corners face the
neighbours that are grass; tiles neighbouring the *other* ground type just
abut it directly, which looks fine since those are flat, saturated colours
with no texture to clash. This is why a user-carved water tile in the
interior gets a proper sand-less, grass-blended edge, while the base
coastline (water meeting the sand ring) stays a clean flat line — the same
rule produces both, for free.

**Per-tile jitter**: forest/rock/path/building/ruin objects get a small
position offset, an occasional horizontal flip, and (forest only) a choice
of two sprites — all derived from a hash of the tile's own `(x, y)`, so it's
stable across reloads without being stored. This is what stops five placed
trees from reading as one stamp repeated five times.

**Canvas, not per-tile DOM images**: the first attempt at this (one `<img>`
per ground tile plus one per object, CSS-scaled and transformed) produced
visibly distorted sprites once actually screenshotted and zoomed into —
compositing many independently-positioned images at a non-integer CSS pixel
scale rounds each one slightly differently. Rendering the whole grid into
one `<canvas>` at native tile resolution (`cols*16 × rows*16`) and letting
the browser perform a single upscale of that one bitmap removed the
distortion outright. Caught by screenshotting the running app and zooming
in, not by reasoning about the code — worth noting as a case where "it
passed every automated check" and "it looks right" were different
questions.

One more issue surfaced the same way: a cluster of base-decoration forest
tiles placed on adjacent cells looked, at a glance, like a single corrupted
sprite — zooming into an isolated tree versus a clustered group showed it
was actually two separate, correctly-rendered problems compounding: the
pine tree's green is close enough to the grass colour to nearly disappear,
and tiles placed directly next to each other blur together once jittered.
Fixed by swapping the low-contrast pine for a second, differently-coloured
tree variant and spacing the fixed decoration cells further apart — not by
assuming the first zoomed-in screenshot meant the renderer was broken.

## Redesign: from icon pins to a tile grid

_(Also superseded — the data model it introduced was replaced in "back to a
real island image" above, though the lesson about matching art styles below
still held and shaped which patches survived into the current version.)_

The first checkpoint worked (it passed the spec, it persisted, it deployed)
but looked wrong: flat black line-art icons sitting on top of a painted
island image read as stickers on a photo, not as changes to the place
itself. The fix wasn't a styling pass on the old icons — it was a different
data model.

**Old model**: an append-only list of marks, each `{x, y, kind}` as a
percentage position on one static background image. Placing a mark could
only ever add a layer on top; it couldn't change the island.

**New model**: the island is a grid of tiles (`COLS × ROWS`, currently
30 × 30 — see the redesign note below for why that number changed). Each
cell has a `ground` (water/sand/grass) and an optional `object` sitting on
it (forest/rock/path/building/ruin). The base island
shape is a pure function of `(x, y)` — a wobbled radial coastline plus a
fixed handful of decorations — computed fresh every time, never stored, so
every visitor starts from the same island with zero rows in the database.
A visitor's edit is a single-cell upsert (`src/db.ts`'s `setTile`) that
overrides either the ground or the object at that cell; `GET /api/tiles`
returns the whole grid pre-merged (base + overrides) so the client never
needs to know the base-generation rule at all. This replaced the old
`marks` table and `/api/marks` routes outright — see `spec/tiles.test.ts`
for the new contract.

This also forced the asset question back open: the old icons (six
individual game-icons.net SVGs, flat black glyphs) could never look like
part of a painted island no matter how they were placed, because they were
drawn in a completely different visual language. The fix was sourcing
ground and object tiles from the *same* pack as each other (Kenney's "Tiny
Town" and "Tiny Battle" — same artist, same 16×16 scale, designed to be used
together) rather than matching six unrelated icons to one photorealistic
background. Picking tiles was done by rendering the actual packed tilesheet
and reading it by eye (a hand-written PNG decoder, since no image tooling
was available in this environment) rather than guessing from pack
descriptions, and the composed result was checked with a real headless
browser screenshot before calling it done, specifically to verify the thing
the first version failed at: do edits look like part of the map.

## Redesign: splat-map terrain blending

_(Supersedes the tile-grid/autotiling model above — `rock` and `path` moved
from discrete object tiles back to continuous terrain kinds, `ground` and
`object` rock/path are gone as concepts.)_

The tile-grid redesign fixed "stickers on a photo" but its coastline was
still, structurally, a grid of square tiles with blended edges — it could
never read as one continuous island because it wasn't one. Before rebuilding
this again, I looked at how real map/terrain editors solve painting, erasing,
and blending rather than guessing: Unity's terrain system paints a *splat
map* (each cell holds a blend weight per texture, summing to 1; painting
nudges weights rather than stamping a tile), and Tiled/Wonderdraft both keep
a hard split between one continuous ground layer and a separate layer of
discrete placed objects, treating "erase" as just painting a different value
rather than a delete operation.

**Data model** (`src/db.ts`): each cell is five weights — grass, sand, path,
rock, water — summing to 1, computed fresh from a formula for any cell with
no saved override. Painting nudges the chosen kind's weight up within a soft
radial brush and proportionally shrinks every other kind to compensate, so
painting, erasing, and replacing are all the same operation with no special
case for any of them.

**Rendering** (`public/app.js`): the coarse weight grid for one terrain kind
is rendered to a tiny canvas (one alpha byte per cell) and `drawImage`-scaled
up with image smoothing on — letting the browser's own upscale do the
blurring, rather than blurring the composed image — then a tileable texture
swatch is clipped through that mask with `destination-in`. Five layers
composite in a fixed order (grass, sand, path, rock, water last, so water
reads clearly even overlapping another kind), with a separate object layer
(forest/building/ruin) drawn on top, undisturbed by terrain edits.

**Bug found and fixed during this pass**: the first rock texture (a cropped
stone-wall tile) showed its brick/mortar lines as a visible grid wherever it
was blended at partial weight — fine as a solid fill, broken as a translucent
one. Caught by screenshotting a painted rock patch, not by reading the code.
Fixed by replacing it with a flat, lightly-flecked swatch with no internal
line structure to clash with partial alpha.

**Bug found and fixed during this pass**: the palette (9 buttons) overflowed
a 390px-wide mobile viewport, running off-screen. Fixed with a mobile media
query that wraps and shrinks the palette, plus hardening the placement math
(`showPaletteAt`) to clamp the palette on-screen regardless of its own width,
so it can't run off-screen again at any viewport size.

## Refinement: sharper resolution, without blurring the whole map

A later pass ("the current terrain is much too blurry — keep smooth blending,
but textures should stay crisp and only the transition edges should be
soft") found that the splat-map design above was structurally right but
tuned wrong: a 48×48 grid meant the upscale-blur trick had to smear a large
fraction of the island to hide 48 blocky cells, and flat 16×16 textures gave
the renderer nothing to look detailed with even where blending was correct.

Fixed by separating two things that had been conflated into one number:

- **Shape vs. edge softness.** The coastline formula and the brush falloff
  each used to be one smoothstep spanning the whole feature, so "soft" scaled
  with "big." Rewritten so edge softness is a small, fixed cell count
  (`EDGE_SOFTNESS`, `BRUSH_EDGE_SOFTNESS`) independent of how big the shape
  around it is — increasing grid resolution now makes edges *relatively*
  crisper, not just finer-grained. The brush itself changed from one
  smoothstep across its whole radius (a soft blob) to a flat full-strength
  core with only a thin soft rim (a dab with a crisp edge).
- **Resolution.** The grid went from 48×48 to 192×192 and the render canvas
  from 768 to 1920, so the same fixed edge-softness now covers a much smaller
  fraction of the visible island. All five texture swatches were regenerated
  from flat 16×16 colour to 64×64 with a scattered, seamlessly-tiling speckle
  pattern (`CREDITS.md` has the details), so flat-coloured regions read as
  textured instead of as a single flat blob even before any blending happens.

**Bug found and fixed during this pass**: rebuilding all five terrain layers
across the whole 1920×1920 canvas on every click measured at ~250–280ms per
paint (via a temporary `performance.now()` probe) — fine at the old
resolution, laggy at the new one. Fixed by caching the composited terrain on
its own offscreen canvas and only rebuilding the padded bounding box of
cells an edit actually touched, compositing that cached canvas plus the
(cheap, short) object list on every frame. Re-measured: a full-canvas blit is
~0.1ms, a realistic brush-stroke rebuild is ~13ms — imperceptible.

**Bug found and fixed during this pass**: scaling the brush radius up to
match the finer grid (so a dab still covers a similar fraction of the
island) made one paint stroke touch ~750 cells instead of ~55. Each cell was
its own `INSERT ... ON CONFLICT` statement with no surrounding transaction,
so SQLite committed (and fsynced) ~750 times per click — measured at ~800ms
for a single `POST /api/terrain`, a regression the client-side canvas
optimisation above didn't touch at all because it's server-side. Found by
rerunning the full Playwright interaction script against a clean database and
noticing placed objects silently failed to appear on-screen; tracing it
showed the object-placement requests weren't missing, just still in flight
when the test's fixed wait elapsed and the browser closed. Fixed by wrapping
each brush stroke's writes in a single `BEGIN`/`COMMIT` transaction in
`paintTerrain` — one commit per click instead of hundreds. Re-measured: the
same request that took ~800ms now takes ~10ms.

## Assets

The standalone island background image from passes 1 and 4 is gone — the
current redesign deliberately sources every terrain texture and every
object from the same two matching CC0 Kenney packs ("Tiny Town" and "Tiny
Battle"), rather than mixing in a separately-sourced background, specifically
so the terrain and the objects sitting on it read as one art style. Five
64×64 seamless, speckled swatches (`public/assets/textures/`) back the
terrain layer; three object sprites (`public/assets/tiles/`) back the object
layer. Two of the five terrain swatches are generated rather than cropped
directly: `path.png` is `sand.png` recoloured darker, and `rock.png` is a
flat, flecked swatch built to match the other textures' style, after the
first cropped candidate (a stone wall tile) turned out to look like a grid
once blended (see above). Full attribution and licence terms are in
`CREDITS.md`.

## Known gaps

Named in `README.md`'s "Known gaps" section rather than repeated here: no
rate limiting yet, terrain that can be repainted but not instantly reset, no
real-time layer yet (out of scope for this crit per its own spec), and one
fixed island with no growth yet.
