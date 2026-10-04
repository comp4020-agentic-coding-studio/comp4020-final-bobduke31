# Credits

Third-party art and code used in this app, kept here so licence terms are
easy to check.

## Base map

`public/assets/base-map.png` — the single backdrop image the world is drawn
on top of (see `PROCESS.md` for how the editing layer works).

- **Pack**: [25 CC0 Top Down Islands](https://opengameart.org/content/25-cc0-top-down-islands)
  (sprite `isle_24.png`, one of 25)
- **Author**: Wisedawn (<https://wisedawn.itch.io/>)
- **Licence**: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) — public domain, no attribution required
- **Modified**: no (used as downloaded, just renamed)

This is also the asset used for the app's very first Crit 8 checkpoint —
dropped partway through earlier redesigns in favour of a hand-rendered
terrain, and brought back now that the editing model is vector shapes drawn
over a fixed backdrop rather than a painted/blended ground.

## Terrain brush patches

`public/assets/terrain-patches/` holds the small texture patches the terrain
brush tiles onto the map when painting grass/sand/rock/water/forest. Each one
is a direct pixel crop out of `base-map.png` itself (found by scanning the
image for small, high-purity regions whose colour matches that kind, via a
one-off script, not hand-picked or drawn) — so a painted area is tiled from
the exact same art, at its native resolution, as the island underneath it,
rather than a separately-styled overlay. No new licence: same CC0 source as
`base-map.png` above. Variant counts found: grass 3, rock 3, forest 2, sand 1,
water 1 (the brush rotates between a kind's variants, and varies per brush
stroke, so repeated strokes don't all look identical).

## Map objects

`public/assets/tiles/` holds the two marker icons placed on the map, from
Kenney's "Tiny Town" pack, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/):

| File                   | Original tile                                     |
| ---------------------- | -------------------------------------------------- |
| `object-building.png`  | roof/wall fragment, used as a building marker       |
| `object-ruin.png`      | stone wall/window fragment, used as a ruin marker   |

(Earlier passes also used two forest tree sprites from the same pack; forest
is now a polygon area kind rather than a point marker, so those two files are
no longer part of the app and were removed.)

## Libraries

The editing surface itself — drawing, editing, dragging, deleting shapes,
pan/zoom — is provided by two vendored, unmodified open-source libraries
(`public/vendor/`), not hand-written:

| Library                          | Version | Licence                                                                 |
| --------------------------------- | ------- | ------------------------------------------------------------------------ |
| [Leaflet](https://leafletjs.com/) | 1.9.4   | [BSD-2-Clause](https://github.com/Leaflet/Leaflet/blob/main/LICENSE)     |
| [Leaflet-Geoman (free/Community edition)](https://geoman.io/) | 2.20.2 | [MIT](https://github.com/geoman-io/leaflet-geoman/blob/master/LICENSE) |

Both ship as static, pre-built files loaded directly by `index.html` — no
bundler, no build step, consistent with the rest of the app.
