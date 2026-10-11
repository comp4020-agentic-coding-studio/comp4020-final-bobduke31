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
