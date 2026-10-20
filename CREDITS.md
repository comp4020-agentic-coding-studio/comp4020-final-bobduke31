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
