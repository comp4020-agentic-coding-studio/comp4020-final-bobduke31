# Credits

Third-party art used in this app, kept here so licence terms are easy to
check. "Modified" means recoloured or re-exported, not redrawn.

## Island background

- **Asset**: `public/assets/island.png` (one sprite, `isle_24.png`, from a
  25-sprite set)
- **Pack**: [25 CC0 Top Down Islands](https://opengameart.org/content/25-cc0-top-down-islands)
- **Author**: Wisedawn (<https://wisedawn.itch.io/>)
- **Licence**: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) — public domain, no attribution required
- **Modified**: no (used as downloaded)

## Mark icons

All from [game-icons.net](https://game-icons.net), licensed
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) — free to use,
attribution required. Downloaded as raw SVGs; the black background square
each icon ships with was removed and the glyph's fill was changed to
`currentColor` so it can be styled from CSS. The glyph shapes are unmodified.

| Mark kind | Icon name      | Author     | Source                                                                 |
| --------- | -------------- | ---------- | ----------------------------------------------------------------------- |
| flag      | Flying flag    | Lorc       | <https://game-icons.net/1x1/lorc/flying-flag.html>                      |
| campfire  | Campfire       | Lorc       | <https://game-icons.net/1x1/lorc/campfire.html>                         |
| tent      | Camping tent   | Delapouite | <https://game-icons.net/1x1/delapouite/camping-tent.html>               |
| boat      | Sailboat       | Delapouite | <https://game-icons.net/1x1/delapouite/sailboat.html>                   |
| tree      | Pine tree      | Lorc       | <https://game-icons.net/1x1/lorc/pine-tree.html>                        |
| ruin      | Ancient ruins  | Delapouite | <https://game-icons.net/1x1/delapouite/ancient-ruins.html>              |

A short form of this attribution ("Icons by Lorc & Delapouite, game-icons.net,
CC BY 3.0") is also shown in the app's footer, since CC BY requires the credit
to travel with the work, not just sit in the repo.

## Vendored code (terrain renderer)

Not art assets, but the same "record what was reused" discipline applies.
All vendored as plain files under `public/world/vendor/`, loaded directly by
the browser with no build step, no attribution required by either licence.

| Library | Version | Licence | Used for |
| --- | --- | --- | --- |
| [d3-array](https://github.com/d3/d3-array) | 3.x | ISC | dependency of d3-contour |
| [d3-contour](https://github.com/d3/d3-contour) | 4.x | ISC | marching-squares coastline extraction from the elevation grid |
| [simplex-noise](https://github.com/jwagner/simplex-noise.js) by Jonas Wagner | 4.0.3 | MIT | deterministic ridged-noise mountain folds in the terrain shading (see `terrain-renderer.js`) |
| [three.js](https://github.com/mrdoob/three.js) | r169 (`three.module.js`) | MIT | the WebGL2 heightfield mesh renderer behind the Oblique view (see `terrain-renderer-3d.js`); vendored unminified (current three.js releases ship no minified build) |

### Fonts and identity (Atlas Table)

| Asset | Licence | Used for |
| --- | --- | --- |
| [Figtree](https://fonts.google.com/specimen/Figtree) by Erik Kennedy, latin variable subset (`vendor/fonts/figtree-latin-var.woff2`) | SIL OFL 1.1 | all controls and running text |
| [IM Fell English SC](https://fonts.google.com/specimen/IM+Fell+English+SC) by Igino Marini, latin subset (`vendor/fonts/im-fell-english-sc-latin.woff2`) | SIL OFL 1.1 | map names and people's names only |

Both are the woff2 files Google Fonts serves, self-hosted so the editor
makes no third-party request and the fonts work offline. Cartographer
names (`src/people.ts`) follow the approach of
[fantasy-name-generator](https://github.com/fentech/fantasy-name-generator)
(ISC, v2.0.0 inspected): names picked from curated tables rather than
free-form syllable soup. No code was copied; the tables are our own, shaped
as "given name + cartographic epithet". The package itself was passed over
because its output (orcs, elves, "Drizzt"-style names) is a different
register from people drawing a map together.

### Ported code and published techniques (terrain & visual overhaul)

Adopted on `final-redesign-prototype` for the shared terrain pipeline in
`public/world/terrain-fields.js` / `terrain-renderer-3d.js`. Searched for
first per `CLAUDE.md`; each is a proven, published technique rather than a
hand-rolled approximation:

| Source | Licence | Used for |
| --- | --- | --- |
| [webgl-noise](https://github.com/ashima/webgl-noise) 2D simplex noise, Ian McEwan & Stefan Gustavson (Ashima Arts) | MIT | ported line-for-line to JS *and* kept as GLSL, so the CPU (tree placement) and GPU (material boundaries) evaluate bit-compatible noise - a permutation-table library like simplex-noise.js can't be run in a shader |
| Sigg & Hadwiger, "Fast Third-Order Texture Filtering", *GPU Gems 2* ch. 20 | technique | C2-smooth cubic B-spline reconstruction of the 256x256 grids from 4 bilinear taps - the fix for polygonal coastlines and cell-shaped material edges |
| Mishkinis, ["Advanced Terrain Texture Splatting"](https://gamedev.net/tutorials/programming/graphics/advanced-terrain-texture-splatting-r3287) (2013) - same idea as Unreal's Layer Blend height mode / Terrain3D | technique | height-based material blending: clumpy forest edges and rock outcrops instead of a soft colour fade |
| Felzenszwalb & Huttenlocher, "Distance Transforms of Sampled Functions" (2012) | technique | exact Euclidean coast distance field (seeded with sub-pixel crossings), driving shallow water, ripple lines and beaches |
| Musgrave ridged multifractal, as used by Red Blob Games' [mapgen4](https://github.com/redblobgames/mapgen4) "mountain folds" (Apache-2.0; technique only, no code copied) | technique | render-time ridgelines synthesised from painted elevation, so a brush stroke becomes a range rather than a dome |

### The Forge generator and the brushes (Atlas Table step II)

`public/world/forge.js` (seeded world generator, run by both the browser
preview and the server) and `public/world/brush.js` (brush maths). Searched
first, per `CLAUDE.md`; nothing was vendored, because every generator found
either targets a different mesh (Voronoi cells) or produces a whole planet
rather than a heightfield in this app's units. These are the techniques
adapted, with no code copied unless stated:

| Source | Licence | Used for |
| --- | --- | --- |
| [Azgaar's Fantasy Map Generator](https://github.com/Azgaar/Fantasy-Map-Generator) heightmap templates ("Hill", "Range") | MIT | composing land from hill masses and ridges walked between two points. His front-by-front growth was replaced by true distances: on a square grid it showed as diagonal banding and slivers of land |
| Red Blob Games, ["Making maps with noise"](https://www.redblobgames.com/maps/terrain-from-noise/) | technique | fBm octaves, the square-bump edge mask, domain-warped coastlines |
| Olsen, "Realtime Procedural Terrain Generation" (2004) | technique | thermal (talus) erosion passes, so slopes settle to plausible angles |
| [sfc32](https://github.com/bryc/code/blob/master/jshash/PRNGs.md) PRNG and cyrb128-style seed hash, collected by bryc | public domain | deterministic, integer-only random numbers, identical in Node and every browser |
| Krita / Photoshop brush "flow" and max-accumulation modes; Unreal Landscape Flatten; World Machine / Gaea modifier keys | technique | one stroke moves a cell by at most Strength; perceptual strength curve; Level tool; Shift inverts, Alt smooths, `[ ]` size and `- =` strength |

Passed over: Azgaar's generator as a dependency (Voronoi mesh, a
whole-planet model, a large app rather than a library); mapgen4 (Apache-2.0,
also a Voronoi mesh, and its renderer would compete with this one);
Sebastian Lague's hydraulic erosion (MIT) as too slow to run per preview at
256x256 in the browser without a worker, kept as an option for a later
"weathering" pass.

### Places: buildings and map objects (Atlas Table stage B)

- **Asset**: `public/world/assets/kaykit-medieval/` (11 models as glTF +
  .bin, one shared 15 KB colour atlas `hexagons_medieval.png`, and the
  pack's own `LICENSE.txt`)
- **Pack**: [KayKit Medieval Hexagon Pack 1.0](https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0)
- **Author**: Kay Lousberg (<https://www.kaylousberg.com>), the same author
  as the KayKit trees already in the renderer
- **Licence**: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/),
  quoted from the pack's `LICENSE.txt`: "free to use in personal,
  educational and commercial projects". Credit is not required, but is given
  here and in the Places panel.
- **Modified**: no. The files are as downloaded; the app scales and seats
  them at load time.
- **Chosen by rendering, not by description.** Candidates were rendered in
  the app's own Three.js, under the renderer's sun and sky lights, next to
  the existing KayKit tree. The red-roofed buildings and the yellow thatched
  cottage read as one family with the trees.
- **Passed over:**
  - The pack's tavern: its giant barrel reads as a joke at map scale.
  - The blue, green and yellow team colours: they look like a strategy game.
  - The hex road tiles: they only work on a hex grid, so roads need a
    painted-path tool instead. That is not built yet.
  - Kenney's Castle Kit and Fantasy Town Kit (CC0) were the runners-up. They
    were not used because KayKit already matched the trees in the scene.
- **Known limit**: in the overhead Chart view, 3D buildings show mostly as
  roofs. Relief shows them best. Painted top-down symbols, as Inkarnate
  uses, would be the fix if Chart needs to show places better.

### The Atlas home and gallery (Atlas Table stage A)

`public/atlas/` (the home page at `/`), `src/gallery.ts`, `src/thumbnail.ts`
and `public/world/thumbnail.js`. Searched first, per `CLAUDE.md`. No code or
art was taken: these are patterns from how similar products greet a
newcomer and publish work, each checked on the page cited.

| Source | Pattern adopted |
| --- | --- |
| [Excalidraw](https://docs.excalidraw.com/docs/), and [an onboarding teardown of it](https://onboardingoptimization.com/guides/excalidraw-first-value-before-signup/) | value before sign-up: the home page opens on a real world generated for you, and one click makes it yours |
| [Owlbear Rodeo rooms](https://docs.owlbear.rodeo/docs/rooms/) and [dev log 7](https://blog.owlbear.rodeo/owlbear-rodeo-dev-log-7/) | a returning visitor sees their own maps first, as pictures |
| [Figma Community: publish](https://help.figma.com/hc/en-us/articles/360040035974-Publish-files-to-the-Figma-Community), [unpublish](https://help.figma.com/hc/en-us/articles/1500007575382-Remove-or-unpublish-Community-files) | only edit access can publish; unpublishing takes effect at once |
| Figma's [thumbnail complaints](https://forum.figma.com/suggest-a-feature-11/auto-update-thumbnails-29386) | pictures are drawn from the stored map, so they can't go stale or be swapped |
| [Inkarnate feedback: cloneable maps](https://feedback.inkarnate.com/p/make-all-published-maps-cloneable), [search all maps](https://feedback.inkarnate.com/feature-requests/p/be-able-to-search-all-maps) | the gallery shows the view link, leaving copying to the versions work in stage B |
| [Dungeon Scrawl showcase](https://www.dungeonscrawl.com/showcase), [Canva templates](https://www.canva.com/templates/) | starter worlds shown alongside the gallery while it is sparse |
| [Azgaar's Fantasy Map Generator](https://github.com/Azgaar/Fantasy-Map-Generator), [Watabou's city generator](https://watabou.itch.io/medieval-fantasy-city-generator) | seed in view and a reroll button: the same seed always makes the same world |

Passed over: a client-uploaded screenshot as the map picture (Figma's
stale-thumbnail problem); an image library such as `sharp` or `pngjs` for
the PNG (node:zlib is all a PNG needs, and this repo avoids dependencies);
search and tags in the gallery (not needed until there are more maps than a
page holds). The picture palette mirrors the renderer's ground and sea
colours, so if those change, `thumbnail.js` should change with them.

### Considered and not used, for the 3D renderer

- **[THREE.Terrain](https://github.com/IceCreamYou/THREE.Terrain)** (npm
  `three.terrain.js`) — a *procedural* terrain generator (diamond-square,
  Perlin heightmaps). This app already has an authoritative heightfield from
  SQLite; there's nothing for a generator to generate.
- **[@interverse/three-terrain-lod](https://www.npmjs.com/package/@interverse/three-terrain-lod)**
  — does almost exactly what the ground shader below does (slope-based
  grass/rock/snow blending, on-the-fly normals from a heightmap), but on
  Three.js's newer TSL/WebGPU shading path - a second, less-mature dependency
  axis on top of adopting Three.js itself in a repo with no bundler. The
  *technique* is reused (hand-written against a standard `ShaderMaterial`
  instead); the package is not.
- **Kenney's Nature Kit** (CC0, real low-poly 3D tree/rock models, GLB-ready)
  — trialled on the `final-redesign-prototype` branch (not merged to `main`):
  `GLTFLoader` (vendored under `public/world/vendor/three/`, same MIT three.js
  release as the rest of the app) loads `tree_pineRoundC.glb` and `tree_oak.glb`
  in place of the billboard sprites below. Real screenshots at a near-horizontal
  camera tilt (82°) show individual tree silhouettes reading clearly, which a
  flat billboard cannot do edge-on - a genuine improvement over the billboard
  approach at that camera angle. One integration cost found and fixed: Kenney's
  glTF export authors materials as `metalness: 1, roughness: 1` (meant for a
  scene with a real environment map); without one they render almost black
  under this scene's plain directional+ambient lighting, so the loader forces
  `metalness: 0` on load. Not yet a final decision - see ROADMAP.md's
  prototype-plan section.
- CC0/CC-BY forest-stamp icon packs on OpenGameArt/itch.io (e.g. "Fantasy
  Icons Ink", and the same eysselia "Brush and element for drawing a map"
  pack `research/prototypes/README.md` already used and moved away from) —
  all ink/line-art style, which CLAUDE.md already steers away from
  ("not another ink-sketch renderer"); pixel-art tree tile packs read as a
  retro tile game, not painted cartography.

### Grassland ground texture

- **Asset**: `public/world/assets/textures/grass-cethiel.png`
- **Pack**: [Tileable Grass Textures - Set 1](https://opengameart.org/content/tileable-grass-textures-set-1) (`Grass_01.png`, one of four 512x512 variants; the pack's normal maps are unused)
- **Author**: Cethiel
- **Licence**: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) — public domain, no attribution required
- **Modified**: no (used as downloaded)
- Trialled on `final-redesign-prototype` as the shared painted grass fill for
  grassland cells in both the Top-down (Canvas2D, `terrain-renderer.js`) and
  Oblique (WebGL shader, `terrain-renderer-3d.js`) renderers, tiled at the
  same physical scale in both (`GRASS_TEXTURE_TILE_SIZE`,
  `terrain-model.js`). Replaces an earlier trial of an AI-generated texture
  from `research/c10-ai-assets/` that was used as a convenience placeholder
  before real alternatives were actually pushed through - that texture has
  been removed.
- **Considered and not used**: [Watercolor Terrain Textures](https://voxelcorelab.itch.io/watercolor-terrain-textures)
  by Voxel Core Lab (Jonas Voland), CC0, all 4 grass variants downloaded and
  inspected directly. Genuinely real and CC0, but each variant is a blurred
  colour-wash with no distinct painted detail (no grass blades, no texture
  variation) - tiled across terrain it reads as a flat green smear, not
  painted cartography. [Hand Painted Grass](https://opengameart.org/content/hand-painted-grass)
  by PamNawi (CC0) was also inspected and passed over for the same reason,
  plus an over-saturated sci-fi-slime colour. [Hand Painted Grass Texture](https://opengameart.org/content/hand-painted-grass-texture-1)
  by Kiira was passed over on licence grounds (OGA-BY 3.0, attribution
  required) given a CC0 alternative of comparable quality was available.

### Forest canopy texture

`public/world/assets/tree-{deciduous,conifer}.png` are not sourced art —
they're small painted textures authored directly for this renderer (soft
overlapping gradient canopy blobs over a tapered trunk, generated with
Canvas2D, the same category of procedural-colour work `terrain-renderer.js`
already does for terrain shading), used as alpha-tested billboard sprites
in `terrain-renderer-3d.js`. No licence to record; no asset pack fit the
target style closely enough to be worth the integration cost over authoring
these directly (see "Considered and not used" above).
