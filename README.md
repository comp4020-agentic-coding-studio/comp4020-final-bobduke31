# The Isle

A fictional island, shared by whoever visits it. There's no login and no
feed — just one map. Pick a kind (grass, sand, rock, water, forest for
areas; road, path for routes; building, ruin for objects), then draw it
onto the island with the map's own editing toolbar — polygons for areas,
lines for routes, markers for objects. Edit, drag, or delete any shape
afterward. The change stays, for the next person who visits.

This is the first version, shipped for Crit 8 ("It's alive!"). It does one
thing: a stranger visits, changes the island, and finds it still changed
when they come back. The real-time layer (seeing other people's edits
appear live) and a bigger world (more islands, more room) are deliberately
left for later.

## The core interaction

1. Open the island.
2. Pick a kind from the bar above the map (an area, a line, or an object).
3. Draw it with the map's toolbar — click points for a polygon or line,
   click once for a marker.
4. Use the same toolbar to edit a shape's points, drag it, or delete it.
5. The change is saved. Reload the page, or come back tomorrow — it's still
   there.

That's the whole app, on purpose. Everything else is in service of making
that one loop feel good, not in adding more to do.

## How this ended up looking the way it does

This went through more visual iterations than any other part of the app, and
it's worth being honest about why, since getting the island itself right
turned out to matter more than any one interaction detail.

1. **A static island image with flat icon pins.** This read as stickers on a
   photo — a visitor's mark sat *on top of* the island rather than *as part
   of* it.
2. **A generated tile grid**, with the island's coastline computed from a
   formula and every mark changing the actual ground tiles (water, sand,
   rock, forest, and so on), with neighbour-aware blending between tile
   types to smooth the seams. This fixed the "sticker" problem — a mark
   really did change the terrain — but introduced a worse one: a coastline
   assembled from square tiles never reads as a *complete* island, no matter
   how well the edges are blended. It also, at one point, rendered as a
   stretched rectangle instead of a square, a real layout bug that made the
   problem obvious rather than subtle.
3. **A static island image with freeform patches.** Marks became small,
   soft-edged patches placed anywhere (not snapped to a visible grid) on top
   of one complete, hand-painted island image. This fixed "looks like a tile
   editor," but not the original problem from version 1 — a patch still sat
   *on top of* the island rather than *as part of* it, the art style of a
   painterly photo and pixel-art patches never quite matched, and there was
   no way to actually erase or replace terrain, only add another patch over
   it.
4. **This version: real terrain painting, not a static image underneath.**
   Before building this, I looked at how existing map/terrain tools actually
   solve painting, erasing, and blending — Unity's terrain system (a
   *splat map*: each cell holds a blend weight per terrain type, painted
   terrain nudges those weights rather than stamping a sprite), Tiled and
   Wonderdraft (a hard split between a continuous terrain/ground layer and a
   separate layer of discrete placed objects), and how all three treat
   "erase" as just painting a different value, not a delete operation.
   The island is now a fine grid (192×192) of cells, each holding how much of
   grass/sand/path/rock/water is present (summing to 1), initialised from a
   formula so every visitor starts from the same coastline. Painting nudges
   the chosen terrain's weight up at the clicked spot (with a soft radial
   falloff) and proportionally nudges every other terrain down to
   compensate — so painting is also how you erase or replace: paint grass
   over a rock patch and the rock genuinely recedes. Rendering blends all
   five terrain layers by smoothly upscaling that low-resolution weight grid
   into a full-size alpha mask per layer (the standard cheap way to turn a
   coarse data grid into something that reads as painted, not tiled) and
   compositing a seamless texture swatch through each mask — so there is no
   longer a separate "default image" at all, just one continuous surface.
   Objects (forest/building/ruin) are a second, separate layer placed on top,
   the same role objects play in Tiled/Wonderdraft; an eraser removes the
   nearest one.
5. **Sharpened, not blurred.** The first cut of the splat map above actually
   looked worse than intended in practice: 48×48 cells wasn't fine enough for
   the browser's upscale-to-smooth trick to stay convincing — the blur it
   takes to hide 48 blocky cells is wide enough to haze the whole island, and
   flat 16×16 colour textures gave the renderer no detail to stay crisp in
   between. Fixed by separating "how blurry" from "how big": the grid went to
   192×192 (so the same small, fixed blur width now covers a much smaller
   fraction of the island) and the brush switched from one smoothstep spanning
   its whole radius to a flat full-strength core with only a thin soft rim, so
   a dab reads as a dab, not a gradient blob. Textures were regenerated at
   64×64 with visible speckle so flat-coloured regions still look textured
   up close. See `PROCESS.md` for the full breakdown, including a real
   performance bug this surfaced (a bigger brush now touches ~750 cells per
   stroke, and those writes weren't batched into one database transaction —
   a single paint click took ~800ms before that was fixed).

6. **This version: a real editing library, not a hand-built renderer.** The
   splat-map renderer above (step 4/5) solved "edits read as part of the
   island," but review surfaced a second problem no amount of further tuning
   fixed: the *editing interaction* itself — one discrete click-and-pick-a-
   popup per dab, no drag-to-paint, no real eraser, no undo — stayed awkward
   no matter how good the pixels looked. Rather than keep hand-rolling brush
   falloff and an eraser, I looked at how mature map/terrain editors (Tiled,
   Wonderdraft, Unity/Godot's own terrain tools) and, after that, mature
   open-source *editing libraries* (OpenLayers, Leaflet+Geoman, Azgaar's
   Fantasy Map Generator) actually handle select/draw/edit/drag/delete, and
   decided it wasn't worth re-deriving that interaction model by hand a
   second time. The island is now a set of GeoJSON vector features — polygons
   for terrain areas, lines for roads/paths, markers for objects — drawn,
   edited, dragged and deleted by **Leaflet** (pan/zoom over a plain image, via
   its own `CRS.Simple` non-geographic-map mode) and **Leaflet-Geoman**
   (free/MIT tier), both vendored as static files with no new build step. The
   continuous per-cell weight grid, the brush falloff math, and the canvas
   compositing pipeline are gone entirely — this is a simplification of the
   data model, not just a UI swap. The backdrop is a single static image
   again, the same CC0 `isle_24.png` sprite used right back in version 1/4 —
   restored rather than re-sourced, and deliberately *not* a snapshot of the
   splat-rendered terrain, since the splat render's visual quality was the
   problem being fixed, not something to preserve as the new background. See
   `PROCESS.md` for the full redesign writeup.

The lesson across the first four: the island's *completeness*, the ability to
really change it (not just decorate it), and the *integration* of edits with
the base map looked like three separate problems, but they're one problem —
representing the whole island as one continuous, blendable data layer
instead of a fixed image plus overlays. Every version that kept a static
"default" image around, however it was dressed up, hit a wall; the version
that dropped that image entirely is the first one that didn't — and the
final version's lesson sits one level up from that: once the "look like part
of the island" problem was solved, the *editing interaction* turned out to be
a separate problem with its own mature prior art, not something further
tuning of a from-scratch renderer was going to solve.

## What "good" means for this app (first draft)

Good, for a small shared space like this, isn't the same as good for a
product with a feed and a login. The brief points at the small web, games
made for a handful of friends rather than a mass audience, and tools built
for one workshop rather than everyone — places that are legible and calm
because only a few people shaped them, not because a moderation team is
watching. I want The Isle to feel closer to that than to a public comment
section.

Concretely, a first attempt at what that means here:

- **It reads as a place, not a UI.** The island should look like somewhere,
  not like a canvas waiting to be edited. Edits blend into the terrain
  itself rather than sitting on top of it, and placement isn't snapped to
  anything visible, so the result keeps the organic feel of the island.
- **It stays legible as it fills up.** A handful of edits should look like
  visitors; a few hundred shouldn't look like noise. I don't think this is
  solved for unlimited growth yet (see Known gaps).
- **It can't be used to write anything.** There's no text field, on
  purpose — only a fixed palette of terrain and objects. A world map anyone
  can scrawl free text onto is a world map that gets defaced on day one.
- **A trace is enough.** The bar for "alive" this week is small: someone did
  something, and it's still there. Persistence is itself part of what's good
  about the app, not just a technical checkbox — a place that forgets you
  doesn't feel shared.

What I looked at while deciding this: the brief's own pointers toward the
small web and games built for a handful of people rather than a crowd;
shared, persistent pixel-canvas projects as an example of what a completely
open, mark-by-mark shared space can turn into at scale (both the good part —
collective creativity — and the bad part — it also becomes a territorial,
defaced mess once anyone can edit anything); and early-web guestbook pages,
which solved a much smaller version of the same problem (a visitor leaves a
trace, the next visitor sees it) with almost no moderation machinery at all.

## Known gaps — named now, not hidden

- **No rate limiting yet.** A visitor can currently draw or delete shapes as
  fast as they like. This is the most obvious hole in "stays legible as it
  fills up," and I expect it to be the first thing that changes.
- **Crisp edges, not blended ones.** Terrain areas are now vector polygons
  with a hard boundary, not a continuously-blended weight field — an
  intentional style trade-off for a much better editing interaction, not an
  oversight. There's also no explicit "undo" beyond selecting a shape and
  deleting it; last write wins if two edits to the same shape race.
- **No real-time layer yet.** Edits only appear for a visitor when they load
  or reload the page. The final project needs this; the crit spec says it
  can wait, so it has.
- **One fixed island, no growth yet.** The world doesn't get bigger as more
  people visit. I'd like new regions to unlock over the coming weeks, both
  as a way to manage crowding and as visible evidence of the project
  growing alongside the semester.
- **The base map is one sourced CC0 image** (see `CREDITS.md`), not
  purpose-made for this project. The two marker icons (building, ruin) are
  also sourced CC0 art.
- **Overlapping shapes can occlude each other.** Geoman doesn't attempt to
  merge or auto-arrange overlapping polygons, so a dense cluster of edits can
  visually stack rather than blend.

## Credits

Every terrain texture and object is sourced, not hand-drawn — see
[the credits page](/credits/) (also [`CREDITS.md`](CREDITS.md) in the repo)
for the full licence and attribution record for each asset.
