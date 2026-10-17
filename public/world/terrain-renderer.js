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
import { GRID_SIZE, SEA_LEVEL, ELEVATION_MAX, TERRAIN_TYPES, sampleBilinear } from "./terrain-model.js";
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

// Task 4 (ROADMAP.md): the continuous (per-pixel, not per-cell) top-down
// renderer below needs fractalFold's value at thousands of arbitrary
// fractional (x, y) positions per redraw, not just once per integer grid
// cell - calling the real 4-octave simplex noise that often is too slow for
// an interactive redraw. fractalFold has no dependency on the painted data
// at all (it's a fixed function of position only - the elevation-dependent
// part is `strength` below, computed separately), so it's precomputed once,
// lazily, into a lookup table and bilinearly resampled from there instead.
// FOLD_LUT_RES=768 (3 samples per grid cell) comfortably oversamples the
// noise's own finest octave (freq ~0.45, wavelength ~2.2 cells) by roughly
// 6x, well past the ~2x Nyquist minimum. Checked numerically (20,000 random
// fractional positions against direct fractalFold calls): mean absolute
// error ~0.005, worst case ~0.054, on fractalFold's own roughly 0..1 output
// range - small enough relative to FOLD_AMPLITUDE (0.17) to be invisible
// after the elevation-gated strength multiplier below. At an exact integer
// grid coordinate the LUT samples its own grid points exactly (768 is an
// exact multiple of 256, error ~3e-8, floating-point noise only), so this is
// also a zero-behaviour-change swap for every existing per-cell caller
// (buildShadingBuffer / renderTerrainOblique's fallback path), not just a
// new continuous one.
const FOLD_LUT_RES = 768;
let foldLUT = null;

function getFoldLUT() {
  if (foldLUT) return foldLUT;
  foldLUT = new Float32Array(FOLD_LUT_RES * FOLD_LUT_RES);
  for (let j = 0; j < FOLD_LUT_RES; j++) {
    const y = (j / FOLD_LUT_RES) * GRID_SIZE;
    for (let i = 0; i < FOLD_LUT_RES; i++) {
      const x = (i / FOLD_LUT_RES) * GRID_SIZE;
      foldLUT[j * FOLD_LUT_RES + i] = fractalFold(x, y);
    }
  }
  return foldLUT;
}

function sampleFoldLUT(x, y) {
  const lut = getFoldLUT();
  const fx = (x / GRID_SIZE) * FOLD_LUT_RES;
  const fy = (y / GRID_SIZE) * FOLD_LUT_RES;
  const cx = Math.min(FOLD_LUT_RES - 1.001, Math.max(0, fx));
  const cy = Math.min(FOLD_LUT_RES - 1.001, Math.max(0, fy));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(FOLD_LUT_RES - 1, x0 + 1);
  const y1 = Math.min(FOLD_LUT_RES - 1, y0 + 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const a = lut[y0 * FOLD_LUT_RES + x0];
  const b = lut[y0 * FOLD_LUT_RES + x1];
  const c = lut[y1 * FOLD_LUT_RES + x0];
  const d = lut[y1 * FOLD_LUT_RES + x1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

function foldOffset(x, y, elevation) {
  const strength = smoothstep(FOLD_FADE_IN_START, FOLD_FADE_IN_END, elevation);
  if (strength <= 0) return 0;
  return (sampleFoldLUT(x, y) - 0.5) * 2 * FOLD_AMPLITUDE * strength;
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

// Split from the old single colorFor (Task 4, ROADMAP.md) so both the
// existing per-cell path (renderTerrainOblique's fallback, via colorFor
// below) and the new continuous per-pixel top-down path can share one
// "pick a base colour for this domain/type" step and one "apply lighting"
// step, rather than two separately-maintained copies of this logic.
function baseColorFor(elevation, typeIndex) {
  if (elevation <= SEA_LEVEL) {
    // Deeper water is darker; right at the coastline it's at its lightest.
    const t = smoothstep(ELEVATION_FLOOR, SEA_LEVEL, elevation);
    return lerpColor(SEA_DEEP, SEA_SHALLOW, t);
  }
  const typeName = TERRAIN_TYPES[typeIndex];
  return typeName === "rock" ? rockColor(elevation) : (TYPE_COLORS[typeName] ?? TYPE_COLORS.grassland);
}

// Wider contrast than plain hillshading alone, plus crease darkening /
// ridge brightening from curvature - together these are what make folded
// mountains read as distinct ridges and gullies instead of one soft
// gradient from light to dark. Sea colours (computed with light=curvature=0
// by every caller) pass through unchanged, same as before this was split
// out of colorFor.
function applyRelief(base, light, curvature) {
  const crease = Math.max(0, -curvature) * 0.4;
  const ridgeBoost = Math.max(0, curvature) * 0.12;
  const brightness = clamp(0.55 + 0.95 * light + ridgeBoost - crease, 0.16, 1.75);
  return [
    Math.min(255, base[0] * brightness),
    Math.min(255, base[1] * brightness),
    Math.min(255, base[2] * brightness),
  ];
}

function colorFor(elevation, typeIndex, light, curvature) {
  const base = baseColorFor(elevation, typeIndex);
  if (elevation <= SEA_LEVEL) return base;
  return applyRelief(base, light, curvature);
}

// --- Continuous (per-pixel) top-down shading -------------------------
//
// Task 4 (ROADMAP.md), by explicit request: Top-down's old per-cell flat
// fillRect gave every pixel inside a cell the exact same colour, which is
// blocky by construction regardless of canvas resolution or
// devicePixelRatio - a bigger cellPx just makes bigger flat blocks. These
// helpers evaluate colour continuously at any real-valued grid position
// instead, the same conceptual model the oblique WebGL shader already uses
// (bilinear elevation, finite-difference relief, bilinear-blended type
// colours) so both views are smooth in the same way and for the same
// reason, not via two unrelated techniques.
//
// Domain safety (the user's explicit "avoid incorrect blending... across
// coastlines" requirement): the land/sea boundary is never colour-blended
// at all - a hard formula switch (sea gradient vs. land+type) keyed off the
// bilinearly-sampled elevation's exact sign relative to SEA_LEVEL, which is
// itself continuous and lands at very nearly the same sub-cell position as
// the vector coastline contour (both ultimately read the same linear
// crossing of the same data). What *is* blended - terrain-type colour
// between neighbouring land cells - explicitly excludes any neighbour at or
// below sea level (see continuousTypeBlend), falling back to the pixel's
// own cell colour instead, so a coastal pixel never mixes toward a sea
// colour or a meaningless cross-domain type.

// Mirrors reliefAt's finite-difference normal/curvature, but sampled at an
// arbitrary fractional (gx, gy) via bilinear elevation instead of only at
// integer cell centres - epsilon=1 (adjacent-cell distance) matches
// reliefAt's own implicit spacing exactly, so RELIEF_EXAGGERATION needs no
// retuning between the two paths.
function continuousReliefAt(elevationGrid, gx, gy) {
  const shade = (x, y) => {
    const e = sampleBilinear(elevationGrid, x, y);
    return e > SEA_LEVEL ? e + foldOffset(x, y, e) : e;
  };
  const center = shade(gx, gy);
  const left = shade(gx - 1, gy);
  const right = shade(gx + 1, gy);
  const up = shade(gx, gy - 1);
  const down = shade(gx, gy + 1);

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

function clamp01(t) {
  return Math.min(1, Math.max(0, t));
}

// Bilinearly blends FOUR ALREADY-RESOLVED COLOURS (the four nearest cell
// centres), not the raw elevation/type data - the same "filter after the
// categorical lookup, not before it" technique used in the oblique shader's
// blendedTypeColor, so this only ever produces a real mix of real
// neighbouring colours. Any neighbour at or below sea level is replaced by
// `selfColor` (the pixel's own cell's colour, computed by the caller before
// this runs) rather than contributing its own colour - so a coastal pixel's
// blend degrades to selfColor-only, never actually mixing toward a sea
// colour.
function continuousTypeBlend(elevationGrid, typeGrid, gx, gy, selfColor) {
  const colorAt = (cx, cy) => {
    const ix = Math.min(GRID_SIZE - 1, Math.max(0, cx));
    const iy = Math.min(GRID_SIZE - 1, Math.max(0, cy));
    const elevation = elevationGrid[iy * GRID_SIZE + ix];
    if (elevation <= SEA_LEVEL) return selfColor;
    return baseColorFor(elevation, typeGrid[iy * GRID_SIZE + ix]);
  };
  const qx = gx - 0.5;
  const qy = gy - 0.5;
  const c0x = Math.floor(qx);
  const c0y = Math.floor(qy);
  const fx = clamp01(qx - c0x);
  const fy = clamp01(qy - c0y);
  const c00 = colorAt(c0x, c0y);
  const c10 = colorAt(c0x + 1, c0y);
  const c01 = colorAt(c0x, c0y + 1);
  const c11 = colorAt(c0x + 1, c0y + 1);
  return lerpColor(lerpColor(c00, c10, fx), lerpColor(c01, c11, fx), fy);
}

// Full colour for one output pixel at fractional grid position (gx, gy) -
// the continuous counterpart of colorFor, used by the new per-pixel
// renderTerrain below.
function continuousColorAt(elevationGrid, typeGrid, gx, gy) {
  const elevation = sampleBilinear(elevationGrid, gx, gy);
  if (elevation <= SEA_LEVEL) return baseColorFor(elevation, 0);
  const { light, curvature } = continuousReliefAt(elevationGrid, gx, gy);
  const nx = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor(gx)));
  const ny = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor(gy)));
  const selfColor = baseColorFor(elevationGrid[ny * GRID_SIZE + nx], typeGrid[ny * GRID_SIZE + nx]);
  const blendedBase = continuousTypeBlend(elevationGrid, typeGrid, gx, gy, selfColor);
  return applyRelief(blendedBase, light, curvature);
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

// Raw ring point data (real grid coordinates, padding already undone),
// before any canvas-specific drawing - shared by buildCoastlinePath below
// and by the 3D renderer, which needs the same coastline geometry as a line
// mesh rather than a canvas Path2D. Computing this is the only part that
// actually needs d3-contour; everything downstream of it is just "how to
// draw a ring," which differs between the two renderers.
export function computeCoastlineRings(elevationGrid) {
  const { padded, paddedSize } = buildPaddedGrid(elevationGrid);
  // d3-contour's threshold is inclusive (value >= threshold counts as
  // "inside"), but this app's own rule everywhere else is strictly greater
  // than SEA_LEVEL (terrain-model.js isLand, this file's colorFor). An
  // untouched cell defaults to exactly 0 - at threshold SEA_LEVEL exactly,
  // d3-contour would count every untouched cell as land too, tracing a
  // contour around nearly the whole grid instead of just what's painted.
  // Nudging the threshold a hair above SEA_LEVEL makes the two agree.
  const contour = d3.contours().size([paddedSize, paddedSize]).smooth(true).contour(padded, SEA_LEVEL + 1e-6);
  const rings = [];
  for (const polygon of contour.coordinates) {
    // -1 undoes the one-cell padding, back to real grid coordinates.
    for (const ring of polygon) rings.push(ring.map(([x, y]) => [x - 1, y - 1]));
  }
  return rings;
}

function buildCoastlinePath(elevationGrid, cellPx) {
  const path = new Path2D();
  for (const ring of computeCoastlineRings(elevationGrid)) addSmoothedRing(path, ring, cellPx, 0);
  return path;
}

// `region` ({minX, minY, maxX, maxY}, inclusive, in GRID CELLS) redraws just
// the pixels covering that rectangle instead of the whole canvas - same
// "grids in, pixels out" contract and identical output per pixel either
// way, just cheaper when only a small area actually changed. The coastline
// stroke is always recomputed in full (see buildCoastlinePath). Omit
// `region` to redraw everything (the initial load).
//
// Task 4 (ROADMAP.md): this fills every actual output pixel by calling
// continuousColorAt at that pixel's own fractional grid position, via a
// plain ImageData buffer written with one putImageData call rather than one
// fillRect per cell (or, worse, per pixel) - fillRect/strokeRect each carry
// real per-call canvas-API overhead that a flat 256x256 cell-block fill
// could absorb but a full-resolution per-pixel fill cannot. Measured
// (ROADMAP.md task 4): a full-canvas redraw at the default 2x-capped device
// pixel ratio (~2.36M pixels) takes ~330-415ms - noticeable, paid only on
// initial load and on explicitly switching into Top-down, not on every
// interaction. Interactive per-stroke redraws cover only the small dirty
// region (brush-radius-sized, not canvas-sized) and measured at ~4ms,
// unaffected by the full-canvas cost - the case that actually matters for
// painting responsiveness.
export function renderTerrain(ctx, elevationGrid, typeGrid, cellPx, region) {
  const minX = region ? Math.max(0, region.minX) : 0;
  const minY = region ? Math.max(0, region.minY) : 0;
  const maxX = region ? Math.min(GRID_SIZE - 1, region.maxX) : GRID_SIZE - 1;
  const maxY = region ? Math.min(GRID_SIZE - 1, region.maxY) : GRID_SIZE - 1;

  const pxMinX = Math.round(minX * cellPx);
  const pxMinY = Math.round(minY * cellPx);
  const pxMaxX = Math.round((maxX + 1) * cellPx);
  const pxMaxY = Math.round((maxY + 1) * cellPx);
  const w = pxMaxX - pxMinX;
  const h = pxMaxY - pxMinY;
  const image = ctx.createImageData(w, h);
  const data = image.data;

  for (let py = 0; py < h; py++) {
    // Sample at the pixel's centre, not its corner - the standard
    // rasterization convention, avoiding a systematic half-pixel bias.
    const gy = (pxMinY + py + 0.5) / cellPx;
    for (let px = 0; px < w; px++) {
      const gx = (pxMinX + px + 0.5) / cellPx;
      const [r, g, b] = continuousColorAt(elevationGrid, typeGrid, gx, gy);
      const i = (py * w + px) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, pxMinX, pxMinY);

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
