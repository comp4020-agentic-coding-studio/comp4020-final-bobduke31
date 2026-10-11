// Contract: grids in, pixels out - nothing else in this app knows how an
// elevation and a terrain type become a colour. The coastline is a genuine
// vector contour (d3-contour, vendored in vendor/, ISC licence) extracted
// from the real grid data at sub-cell precision. Terrain shading adds
// deterministic ridged noise ("mountain folds", see below) on top of plain
// hillshading, following the same technique Red Blob Games' mapgen4 uses
// (a `mountain_folds` parameter that deepens folds at higher elevations -
// https://www.redblobgames.com/x/2524-mapgen4-renderer/) to make painted
// mountains read as ridges and creases instead of one smooth lit blob.
// Swap the fill technique for real textures later without touching this
// boundary logic, the model, or the network code.
import { GRID_SIZE, SEA_LEVEL, ELEVATION_MAX, TERRAIN_TYPES } from "./terrain-model.js";
import { createNoise2D } from "./vendor/simplex-noise.js";

const COASTLINE_COLOR = "#3c2f20";
const COASTLINE_HIGHLIGHT = "#e9dfc4";

const SEA_DEEP = [18, 38, 66];
const SEA_SHALLOW = [66, 120, 158];

const TYPE_COLORS = {
  grassland: [107, 142, 68],
  sand: [222, 201, 148],
  forest: [45, 86, 54],
};

// Rock isn't one flat colour: bare rock lightens with height, and the
// highest ground is snow - the same altitude-tinting real relief maps use,
// so a peak reads as a peak (bright cap, darker base) even before
// hillshading is added on top.
const ROCK_BARE = [118, 109, 98];
const ROCK_HIGH = [168, 160, 150];
const SNOW = [240, 242, 246];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerpColor(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

const ELEVATION_FLOOR = -1;

function rockColor(elevation) {
  const toHighRock = smoothstep(0.35, 0.65, elevation);
  const base = lerpColor(ROCK_BARE, ROCK_HIGH, toHighRock);
  const toSnow = smoothstep(0.78, 0.95, elevation);
  return lerpColor(base, SNOW, toSnow);
}

// --- Mountain folds --------------------------------------------------
//
// Plain gradient hillshading (one normal per cell, from the painted
// elevation alone) is what the previous version of this file did, and it
// looks flat: a brush stroke is a smooth, rounded blob, so its gradient is
// smooth too, and a single soft light/dark gradient over a smooth blob
// reads as a rounded hill, not a mountain. Real relief maps (and mapgen4's
// own renderer) get ridges and creases from detail *finer* than anything a
// brush paints - mapgen4 adds this as "mountain_folds", explicitly only at
// higher elevations, via its own fine mesh/shader detail. This does the
// same thing on a plain elevation grid: a deterministic, multi-octave
// *ridged* noise field (`1 - |simplex noise|`, which produces creases at
// its zero-crossings instead of smooth bumps - a standard fractal-terrain
// technique, not specific to mapgen4) is added to elevation, gated to
// fade in only on higher land, and used ONLY when computing shading - the
// actual stored/painted elevation grid, and therefore the data model, the
// persistence, and the sync protocol, are completely unchanged.
//
// Deterministic and seeded with a fixed constant (not Math.random): the
// same (x, y) always gets the same fold detail, on every client, with no
// extra network traffic, and never flickers as the surrounding terrain is
// repainted - the exact failure mode Red Blob Games documented and fixed
// away from in mapgen4's own elevation-painting revisit
// (https://simblob.blogspot.com/2018/09/mapgen4-elevation-painting-revisited.html),
// which is why this doesn't use a hash-of-current-elevation approach.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const foldNoise2D = createNoise2D(mulberry32(1337));

function ridged(nx, ny) {
  return 1 - Math.abs(foldNoise2D(nx, ny));
}

// Four octaves of ridged noise, each finer and fainter than the last - the
// standard fractal/fBm construction, just with a ridged base instead of a
// plain one, which is what turns smooth noise into crease-like terrain
// detail. Returns roughly 0..1.
function fractalFold(x, y) {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let freq = 0.045;
  for (let i = 0; i < 4; i++) {
    sum += ridged(x * freq, y * freq) * amp;
    norm += amp;
    freq *= 2.17;
    amp *= 0.5;
  }
  return sum / norm;
}

// How strongly folds perturb the shading elevation, and the fixed amount
// of painted elevation range they're gated to appear within - mirroring
// mapgen4's "only apply at higher elevations" rule for its own folds
// parameter, so flat painted land (grassland, sand) stays smooth and only
// raised, mountain-tier land gets the ridged treatment.
const FOLD_AMPLITUDE = 0.17;
const FOLD_FADE_IN_START = 0.42;
const FOLD_FADE_IN_END = 0.75;

function foldOffset(x, y, elevation) {
  const strength = smoothstep(FOLD_FADE_IN_START, FOLD_FADE_IN_END, elevation);
  if (strength <= 0) return 0;
  return (fractalFold(x, y) - 0.5) * 2 * FOLD_AMPLITUDE * strength;
}

// Light from the upper-left, mostly overhead - the standard cartographic
// convention (NW azimuth), so slopes facing the light are bright and
// slopes facing away are dark, exactly like a raised-relief map.
const LIGHT = (() => {
  const v = [-0.55, -0.55, 0.75];
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
})();
const RELIEF_EXAGGERATION = 9; // amplifies the gradient - elevation deltas between brush strokes are small fractions

// Builds a small shading-elevation buffer covering [minX-1, maxX+1] x
// [minY-1, maxY+1] (clamped to the real grid) - painted elevation plus the
// fold perturbation above, on land only. Computed once per render call and
// shared between every cell's hillshade/crease lookup in that call, rather
// than recomputing the (somewhat heavier, 4-octave) fold noise once per
// neighbour sample per cell - this is what keeps a single small brush
// stroke's partial redraw cheap, the same reason renderTerrain only shades
// the dirtied region to begin with.
function buildShadingBuffer(elevationGrid, minX, minY, maxX, maxY) {
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const buf = new Float32Array(w * h);
  for (let y = minY; y <= maxY; y++) {
    const gy = Math.min(GRID_SIZE - 1, Math.max(0, y));
    for (let x = minX; x <= maxX; x++) {
      const gx = Math.min(GRID_SIZE - 1, Math.max(0, x));
      const elevation = elevationGrid[gy * GRID_SIZE + gx];
      buf[(y - minY) * w + (x - minX)] = elevation > SEA_LEVEL ? elevation + foldOffset(gx, gy, elevation) : elevation;
    }
  }
  return { buf, minX, minY, w };
}

// Reads the shading buffer around (x, y) and returns both the hillshade
// light term (plain directional lighting against the folded surface's
// normal) and a curvature term: positive on convex ridge crests, negative
// in concave creases between them. The curvature-based darkening below is
// a simplified stand-in for mapgen4's dedicated outline/ambient-occlusion
// render pass - the thing that actually makes a ridge line read as a
// ridge line instead of just a smoothly-lit slope.
function reliefAt(shading, x, y) {
  const { buf, minX, minY, w } = shading;
  const lx = x - minX;
  const ly = y - minY;
  const center = buf[ly * w + lx];
  const left = buf[ly * w + lx - 1];
  const right = buf[ly * w + lx + 1];
  const up = buf[(ly - 1) * w + lx];
  const down = buf[(ly + 1) * w + lx];

  const dzdx = (right - left) * RELIEF_EXAGGERATION;
  const dzdy = (down - up) * RELIEF_EXAGGERATION;
  const len = Math.hypot(dzdx, dzdy, 1);
  const nx = -dzdx / len;
  const ny = -dzdy / len;
  const nz = 1 / len;
  const light = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];

  const curvature = (left + right + up + down - 4 * center) * RELIEF_EXAGGERATION;
  return { light, curvature };
}

function colorFor(elevation, typeIndex, light, curvature) {
  if (elevation <= SEA_LEVEL) {
    // Deeper water is darker; right at the coastline it's at its lightest.
    const t = smoothstep(ELEVATION_FLOOR, SEA_LEVEL, elevation);
    return lerpColor(SEA_DEEP, SEA_SHALLOW, t);
  }
  const typeName = TERRAIN_TYPES[typeIndex];
  const base = typeName === "rock" ? rockColor(elevation) : (TYPE_COLORS[typeName] ?? TYPE_COLORS.grassland);
  // Wider contrast than plain hillshading alone, plus crease darkening /
  // ridge brightening from curvature - together these are what make folded
  // mountains read as distinct ridges and gullies instead of one soft
  // gradient from light to dark.
  const crease = Math.max(0, -curvature) * 0.4;
  const ridgeBoost = Math.max(0, curvature) * 0.12;
  const brightness = clamp(0.55 + 0.95 * light + ridgeBoost - crease, 0.16, 1.75);
  return [
    Math.min(255, base[0] * brightness),
    Math.min(255, base[1] * brightness),
    Math.min(255, base[2] * brightness),
  ];
}

// d3.contours() wants one threshold and returns the polygon(s) enclosing
// cells above it, at the exact fractional point along each cell edge where
// the real elevation values cross that threshold - this is what makes the
// boundary follow the data smoothly instead of snapping to whole cells.
// .smooth(true) (the default) additionally relaxes vertex placement using
// the surrounding values, rounding off the sharpest marching-squares
// corners. Computed from the full grid every call - the generator needs
// the whole array regardless of which region is being redrawn, so the
// coastline is always current even when only a small area repainted.
// Padded by one sea cell on every side before computing the contour: if
// land ever reaches the literal edge of the array, d3-contour traces the
// boundary running along that edge (there's no further data to say the
// coastline curves away) - a full straight stroke along the map's edge.
// A one-cell sea margin guarantees every real coastline closes within the
// padded area instead, however close painted land comes to the true edge.
function buildPaddedGrid(elevationGrid) {
  const paddedSize = GRID_SIZE + 2;
  const padded = new Float32Array(paddedSize * paddedSize).fill(ELEVATION_FLOOR);
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      padded[(y + 1) * paddedSize + (x + 1)] = elevationGrid[y * GRID_SIZE + x];
    }
  }
  return { padded, paddedSize };
}

// d3-contour's marching-squares output is piecewise-linear: at low vertex
// density the straight segments between points read as faceted/jagged
// rather than winding. Rather than adding more points, drawing each
// segment as a quadratic curve through the midpoints of consecutive
// vertices (using each real vertex as the curve's control point) turns the
// same data into a continuously-curving line - a standard smoothed-polyline
// technique, not an approximation of the data, since the curve still
// passes directly through every original vertex, it just doesn't corner
// sharply between them.
function addSmoothedRing(path, ring, cellPx, offset) {
  const points = ring.map(([x, y]) => [(x - offset) * cellPx, (y - offset) * cellPx]);
  const n = points.length;
  if (n < 3) return;
  const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = midpoint(points[n - 1], points[0]);
  path.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const next = points[(i + 1) % n];
    const m = midpoint(points[i], next);
    path.quadraticCurveTo(points[i][0], points[i][1], m[0], m[1]);
  }
  path.closePath();
}

function buildCoastlinePath(elevationGrid, cellPx) {
  const { padded, paddedSize } = buildPaddedGrid(elevationGrid);
  // d3-contour's threshold is inclusive (value >= threshold counts as
  // "inside"), but this app's own rule everywhere else is strictly greater
  // than SEA_LEVEL (terrain-model.js isLand, this file's colorFor). An
  // untouched cell defaults to exactly 0 - at threshold SEA_LEVEL exactly,
  // d3-contour would count every untouched cell as land too, tracing a
  // contour around nearly the whole grid instead of just what's painted.
  // Nudging the threshold a hair above SEA_LEVEL makes the two agree.
  const contour = d3.contours().size([paddedSize, paddedSize]).smooth(true).contour(padded, SEA_LEVEL + 1e-6);
  const path = new Path2D();
  for (const polygon of contour.coordinates) {
    // 1 undoes the one-cell padding, back to real grid coordinates.
    for (const ring of polygon) addSmoothedRing(path, ring, cellPx, 1);
  }
  return path;
}

// `region` ({minX, minY, maxX, maxY}, inclusive) redraws just that
// rectangle of cell fill instead of the full grid - same "grids in, pixels
// out" contract and identical output per cell either way, just cheaper
// when only a small area actually changed. The coastline stroke is always
// recomputed in full (see buildCoastlinePath). Omit `region` to redraw
// everything (the initial load).
export function renderTerrain(ctx, elevationGrid, typeGrid, cellPx, region) {
  const minX = region ? Math.max(0, region.minX) : 0;
  const minY = region ? Math.max(0, region.minY) : 0;
  const maxX = region ? Math.min(GRID_SIZE - 1, region.maxX) : GRID_SIZE - 1;
  const maxY = region ? Math.min(GRID_SIZE - 1, region.maxY) : GRID_SIZE - 1;

  // Padded by 1 on every side so every cell in [minX, maxX] x [minY, maxY]
  // has real neighbour data to compute a normal/curvature from, even at
  // the edge of the redrawn region.
  const shading = buildShadingBuffer(elevationGrid, minX - 1, minY - 1, maxX + 1, maxY + 1);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const index = y * GRID_SIZE + x;
      const elevation = elevationGrid[index];
      const { light, curvature } = elevation > SEA_LEVEL ? reliefAt(shading, x, y) : { light: 0, curvature: 0 };
      const [r, g, b] = colorFor(elevation, typeGrid[index], light, curvature);
      ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
      ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
    }
  }

  // A single thick opaque line reads as a border drawn on top of the map,
  // not an edge of it. Two thinner passes - a soft dark line, then a
  // slimmer pale "foam" highlight just inside it - is the same two-tone
  // ink technique the reference maps use for coastlines, and reads as part
  // of the terrain rather than an outline over it.
  const coastline = buildCoastlinePath(elevationGrid, cellPx);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.strokeStyle = COASTLINE_COLOR;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = Math.max(1, cellPx * 0.9);
  ctx.stroke(coastline);
  ctx.strokeStyle = COASTLINE_HIGHLIGHT;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = Math.max(0.6, cellPx * 0.4);
  ctx.stroke(coastline);
  ctx.restore();
}

// --- Oblique projection -----------------------------------------------
//
// renderTerrain above is a pure top-down map: x and y are the only inputs
// to screen position, and elevation only ever changes a cell's *colour*.
// That's the actual reason mountains still read as flat no matter how good
// the shading gets - a relief map with no relief in its geometry. Red Blob
// Games' mapgen4 solves this with a shear, not a rotation or a full 3D
// camera: "preserve x and y... and transfer z to y"
// (https://simblob.blogspot.com/2018/09/mapgen4-oblique-projection.html).
// Flat ground (z = 0) still projects exactly as a top-down map would -
// coastlines and rivers stay geometrically accurate - but a cell's screen
// position shifts *upward* in proportion to its elevation, the same way a
// hand-drawn fantasy map (their own example: Lord of the Rings style)
// draws rivers and coastlines from above but mountains from the side.
//
// On a plain 2D canvas (no mesh, no WebGL) the cheapest faithful way to
// build that is to stop drawing each cell as a single pixel block and draw
// it as a *column*: a flat, lit "cap" at its shifted-up height, and a
// darker "side" face filling the gap down to where the cell would sit in
// the ordinary top-down layout. Because the data is still a plain grid and
// nothing moves in x, this is drawn with a simple painter's algorithm -
// rows are filled back-to-front (y ascending, same order the grid is
// already stored in), so a nearer, taller column naturally overdraws
// whatever shorter, farther terrain is behind it, exactly reproducing what
// mapgen4's outline/compositing post describes as mountains occluding the
// terrain behind them (https://simblob.blogspot.com/2018/10/mapgen4-outlines.html).
// This is one concrete technique chosen over two others: a real tilted
// orthographic camera (would need an actual 3D mesh - a rewrite, not an
// addition) and CSS transforms on the flat canvas (satisfies none of
// "actual elevation must influence projected geometry" - it would just be
// skewing the existing flat picture, not changing what's drawn).
export const OBLIQUE_HEIGHT_SCALE = 70; // px of screen rise per full unit of elevation above sea level
const OBLIQUE_SIDE_SHADE = 0.45; // darkens the lit cap colour for the self-shadowed cliff face below it

// Exported so world-client.js can size the canvas's extra top margin (a
// peak near elevation 1 needs this many px of headroom above the flat
// layout to avoid being clipped) and do its own hit-testing against the
// same geometry the renderer actually draws (see the module doc comment
// at the top of world-client.js's canvasToGrid for why that can't just
// reuse buildCoastlinePath's math).
export function obliqueRise(elevation) {
  return Math.max(0, elevation - SEA_LEVEL) * OBLIQUE_HEIGHT_SCALE;
}

export const OBLIQUE_MAX_RISE = Math.ceil(OBLIQUE_HEIGHT_SCALE * (ELEVATION_MAX - SEA_LEVEL));

// Full-grid only (no partial `region`, unlike renderTerrain): raising or
// lowering one cell can change what it occludes several rows *above* it on
// screen (rows with smaller y, i.e. farther away), so a correct partial
// redraw would need to recompute a region that grows with how tall terrain
// is allowed to get, not just the cells actually touched. Simpler and
// provably correct to always repaint the whole grid here; `marginTop`
// shifts every draw down by that many px so a tall peak has headroom
// instead of being clipped at the canvas's top edge.
export function renderTerrainOblique(ctx, elevationGrid, typeGrid, cellPx, marginTop) {
  const shading = buildShadingBuffer(elevationGrid, -1, -1, GRID_SIZE, GRID_SIZE);

  ctx.save();
  ctx.translate(0, marginTop);
  for (let y = 0; y < GRID_SIZE; y++) {
    const baseY = y * cellPx;
    for (let x = 0; x < GRID_SIZE; x++) {
      const index = y * GRID_SIZE + x;
      const elevation = elevationGrid[index];
      if (elevation <= SEA_LEVEL) {
        const [r, g, b] = colorFor(elevation, typeGrid[index], 0, 0);
        ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
        ctx.fillRect(x * cellPx, baseY, cellPx, cellPx);
        continue;
      }
      const { light, curvature } = reliefAt(shading, x, y);
      const [r, g, b] = colorFor(elevation, typeGrid[index], light, curvature);
      const topY = baseY - obliqueRise(elevation);
      const capBottom = topY + cellPx;
      const baseBottom = baseY + cellPx;
      if (capBottom < baseBottom) {
        ctx.fillStyle = `rgb(${(r * OBLIQUE_SIDE_SHADE) | 0}, ${(g * OBLIQUE_SIDE_SHADE) | 0}, ${(b * OBLIQUE_SIDE_SHADE) | 0})`;
        ctx.fillRect(x * cellPx, capBottom, cellPx, baseBottom - capBottom);
      }
      ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
      ctx.fillRect(x * cellPx, topY, cellPx, cellPx);
    }
  }

  const coastline = buildCoastlinePath(elevationGrid, cellPx);
  ctx.lineJoin = "round";
  ctx.strokeStyle = COASTLINE_COLOR;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = Math.max(1, cellPx * 0.9);
  ctx.stroke(coastline);
  ctx.strokeStyle = COASTLINE_HIGHLIGHT;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = Math.max(0.6, cellPx * 0.4);
  ctx.stroke(coastline);
  ctx.restore();
}
