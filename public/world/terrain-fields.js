// Derived terrain fields: everything the renderer needs that is *computed
// from* the authoritative grids (terrain-model.js) rather than stored. One
// module, used by the GPU renderer (as GLSL - see TERRAIN_FIELDS_GLSL below,
// which mirrors every function here line for line), tree placement and
// picking (CPU), so both views and both sides of the CPU/GPU boundary agree
// on exactly where a coastline, a ridge or a forest edge is.
//
// Why these fields exist (ROADMAP.md, "Terrain & visual overhaul"):
//
//  - The stored grid is 256x256 cells. Reading it bilinearly (the old
//    approach) is only C0-continuous, so every contour of it - the coastline,
//    a material boundary - is a chain of straight segments that kink at cell
//    edges: the "polygon edges and grid steps" complaint. A uniform cubic
//    B-spline (bsplineSample) is C2-continuous: contours of it are smooth
//    curves at any zoom, with no extra stored data.
//  - Painted data is low-frequency intent (a brush is a soft disc). Natural
//    detail - ridgelines, valleys, organic forest edges - is synthesised at
//    render time from deterministic, world-anchored noise, the split Red Blob
//    Games' mapgen4 uses (painted elevation + render-time "mountain folds").
//    Because the noise is a fixed function of position, every client renders
//    the same detail with nothing extra sent over the network, and repainting
//    one area never changes the detail anywhere else.
import { GRID_SIZE, SEA_LEVEL, TERRAIN_TYPES } from "./terrain-model.js";

// --- Simplex noise ------------------------------------------------------
// Port of the standard GLSL 2D simplex noise by Ian McEwan and Stefan
// Gustavson (Ashima Arts, "webgl-noise", MIT - see CREDITS.md). Arithmetic
// only (no permutation table), which is what lets the JS and GLSL versions
// produce the same value for the same input - the property tree placement
// relies on to put trees exactly where the GPU draws forest floor.
function mod289(x) {
  return x - Math.floor(x * (1 / 289)) * 289;
}
function permute(x) {
  return mod289((x * 34 + 10) * x);
}
function fract(x) {
  return x - Math.floor(x);
}

const C0 = 0.211324865405187; // (3 - sqrt(3)) / 6
const C1 = 0.366025403784439; // (sqrt(3) - 1) / 2
const C2 = -0.577350269189626; // -1 + 2 * C0
const C3 = 0.024390243902439; // 1 / 41

export function snoise(vx, vy) {
  const s = (vx + vy) * C1;
  let ix = Math.floor(vx + s);
  let iy = Math.floor(vy + s);
  const t = (ix + iy) * C0;
  const x0x = vx - ix + t;
  const x0y = vy - iy + t;
  const i1x = x0x > x0y ? 1 : 0;
  const i1y = 1 - i1x;
  const x1x = x0x + C0 - i1x;
  const x1y = x0y + C0 - i1y;
  const x2x = x0x + C2;
  const x2y = x0y + C2;
  ix = mod289(ix);
  iy = mod289(iy);
  const p0 = permute(permute(iy) + ix);
  const p1 = permute(permute(iy + i1y) + ix + i1x);
  const p2 = permute(permute(iy + 1) + ix + 1);
  let m0 = Math.max(0.5 - (x0x * x0x + x0y * x0y), 0);
  let m1 = Math.max(0.5 - (x1x * x1x + x1y * x1y), 0);
  let m2 = Math.max(0.5 - (x2x * x2x + x2y * x2y), 0);
  m0 *= m0 * m0 * m0;
  m1 *= m1 * m1 * m1;
  m2 *= m2 * m2 * m2;
  const gx0 = 2 * fract(p0 * C3) - 1;
  const gx1 = 2 * fract(p1 * C3) - 1;
  const gx2 = 2 * fract(p2 * C3) - 1;
  const h0 = Math.abs(gx0) - 0.5;
  const h1 = Math.abs(gx1) - 0.5;
  const h2 = Math.abs(gx2) - 0.5;
  const a0 = gx0 - Math.floor(gx0 + 0.5);
  const a1 = gx1 - Math.floor(gx1 + 0.5);
  const a2 = gx2 - Math.floor(gx2 + 0.5);
  m0 *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h0 * h0);
  m1 *= 1.79284291400159 - 0.85373472095314 * (a1 * a1 + h1 * h1);
  m2 *= 1.79284291400159 - 0.85373472095314 * (a2 * a2 + h2 * h2);
  const g0 = a0 * x0x + h0 * x0y;
  const g1 = a1 * x1x + h1 * x1y;
  const g2 = a2 * x2x + h2 * x2y;
  return 130 * (m0 * g0 + m1 * g1 + m2 * g2);
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// --- Smooth reconstruction of the stored grid --------------------------
// Uniform cubic B-spline over the 4x4 cells around (x, y), in cell
// coordinates (cell i's centre is at exactly i - the same convention the 3D
// renderer's world space and picking already use). The GLSL version gets
// the same result from 4 hardware-bilinear taps (Sigg & Hadwiger, "Fast
// Third-Order Texture Filtering", GPU Gems 2), which is why it's cheap
// enough to evaluate per vertex and per pixel.
function bsplineWeights(t) {
  const it = 1 - t;
  const t2 = t * t;
  const t3 = t2 * t;
  return [(it * it * it) / 6, (3 * t3 - 6 * t2 + 4) / 6, (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, t3 / 6];
}

function cellIndex(i) {
  return i < 0 ? 0 : i >= GRID_SIZE ? GRID_SIZE - 1 : i;
}

export function bsplineSample(grid, x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const wx = bsplineWeights(x - ix);
  const wy = bsplineWeights(y - iy);
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    const row = cellIndex(iy - 1 + j) * GRID_SIZE;
    let rowSum = 0;
    for (let i = 0; i < 4; i++) rowSum += grid[row + cellIndex(ix - 1 + i)] * wx[i];
    sum += rowSum * wy[j];
  }
  return sum;
}

// --- Display height: painted elevation + synthesised relief -------------
// HEIGHT_SCALE is the world-unit height of elevation 1.0 in the 3D scene.
// Lowered from the old 46: with broad, connected ranges the old value made
// every summit a needle (ROADMAP.md, "3D peaks too sharp and isolated").
export const HEIGHT_SCALE = 30;

// Gentle rolling variation on all land, faded out at the shoreline so the
// coast itself never wobbles, and out again where mountains take over.
function hillNoise(x, y) {
  return snoise(x * 0.09, y * 0.09) * 0.6 + snoise(x * 0.21 + 5.2, y * 0.21 + 1.3) * 0.4;
}

// Domain-warped, weighted ridged multifractal (Musgrave's ridged noise,
// as used by mapgen4's "mountain folds" and most heightfield generators):
// the warp bends straight noise creases into branching ridgelines, and each
// octave is weighted by the one before it so fine detail concentrates on
// ridge crests instead of filling valleys. Roughly 0..1.
function ridgeNoise(x, y) {
  const wx = x + 9 * snoise(x * 0.025 + 3.1, y * 0.025 + 7.7);
  const wy = y + 9 * snoise(x * 0.025 + 11.4, y * 0.025 + 2.9);
  let sum = 0;
  let amp = 0.55;
  let freq = 0.05;
  let weight = 1;
  for (let i = 0; i < 4; i++) {
    let n = 1 - Math.abs(snoise(wx * freq, wy * freq));
    n *= n;
    n *= weight;
    weight = Math.min(1, Math.max(0, n * 1.8));
    sum += n * amp;
    freq *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

// How "mountainous" painted elevation e is - 0 on plains, 1 on high ground.
// Everything mountain-specific (fold displacement, auto-rock, treeline,
// snow) keys off this one curve.
//
// The band is set by the data that actually exists, not just by the new
// tools: the live map was painted with the earlier tools, whose Create
// Land put plains at ~0.35 (median of ~24k production grassland cells)
// and whose Mountain/Peak targeted 0.6/0.95. A band starting at 0.1 read
// that whole map as foothills - rippled folds over every plain. Starting
// at 0.42 reads both conventions (new plains ~0.06, old ~0.35) as lowland,
// and both generations of mountains (new Mountain ceiling 0.72, old
// 0.6-1.0) as mountains, with no change to anyone's stored data.
export const MOUNTAIN_BAND_START = 0.42;
export const MOUNTAIN_BAND_END = 0.85;
export function mountainMask(e) {
  return smoothstep(MOUNTAIN_BAND_START, MOUNTAIN_BAND_END, e);
}

const RIDGE_AMPLITUDE = 0.22;
const RIDGE_BIAS = 0.3;

// Lowland (everything below the mountain band) is drawn compressed into a
// gentle 0..LOWLAND_TOP rise: plains read as plains whether they were
// painted at 0.06 or 0.35, and an old 0.35-high strip of land beside the
// sea becomes a shore rather than a 10-unit cliff. The mountain band then
// climbs from LOWLAND_TOP back up to the full painted value, so peaks keep
// their real height. Monotone in e, so painting stays predictable: raising
// land always raises what's drawn.
const LOWLAND_TOP = 0.12;
function lowlandHeight(e) {
  const t = Math.min(1, e / MOUNTAIN_BAND_START);
  // ease-out: the first few hundredths of elevation carry the most rise,
  // so a shoreline climbs naturally, then plains level off
  return LOWLAND_TOP * (1 - (1 - t) * (1 - t));
}

// Elevation as the 3D renderer actually draws it (before HEIGHT_SCALE and
// before the sea is flattened to SEA_LEVEL), baked by bakeSurface.
export function displayHeight(e, x, y) {
  if (e <= SEA_LEVEL) return e;
  const m = mountainMask(e);
  const base = lowlandHeight(e) * (1 - m) + e * m;
  let h = base + 0.012 * hillNoise(x, y) * smoothstep(0, 0.06, e) * (1 - m);
  h += m * (ridgeNoise(x, y) - RIDGE_BIAS) * RIDGE_AMPLITUDE * (0.35 + 0.65 * m);
  return h;
}

export function displayHeightAt(elevationGrid, x, y) {
  return displayHeight(bsplineSample(elevationGrid, x, y), x, y);
}

// --- Baked display surface ----------------------------------------------
// The displayed height (sea flattened to SEA_LEVEL) baked into a
// SURFACE_RES^2 float grid, texel (i, j) at cell position (i, j) * step.
// The renderer's vertex shader just reads this - evaluating the ridged
// fBm per vertex (x5 for the normal) made the shader slow to compile and
// heavy to run, and two separate implementations (JS for picking/trees,
// GLSL for drawing) could drift apart by float precision. Baking it once,
// here, makes geometry, picking and tree placement provably identical.
// Full bake ~70ms; a brush-sized region ~1ms, so edits rebake just that.
export const SURFACE_RES = 512;
export const SURFACE_STEP = (GRID_SIZE - 1) / (SURFACE_RES - 1);

export function bakeSurface(elevationGrid, out, region) {
  const toTexel = (c) => c / SURFACE_STEP;
  // B-spline support (2 cells) + the sea-flatten has no reach of its own.
  const pad = 3;
  const i0 = region ? Math.max(0, Math.floor(toTexel(region.minX - pad))) : 0;
  const i1 = region ? Math.min(SURFACE_RES - 1, Math.ceil(toTexel(region.maxX + pad))) : SURFACE_RES - 1;
  const j0 = region ? Math.max(0, Math.floor(toTexel(region.minY - pad))) : 0;
  const j1 = region ? Math.min(SURFACE_RES - 1, Math.ceil(toTexel(region.maxY + pad))) : SURFACE_RES - 1;
  for (let j = j0; j <= j1; j++) {
    const y = j * SURFACE_STEP;
    for (let i = i0; i <= i1; i++) {
      const x = i * SURFACE_STEP;
      out[j * SURFACE_RES + i] = Math.max(SEA_LEVEL, displayHeightAt(elevationGrid, x, y));
    }
  }
  return { i0, i1, j0, j1 };
}

// Bilinear read of a baked surface at cell position (x, y) - what the GPU's
// linear filter does, so picking against this matches the drawn mesh.
export function sampleSurface(surface, x, y) {
  const fx = Math.min(SURFACE_RES - 1.0001, Math.max(0, x / SURFACE_STEP));
  const fy = Math.min(SURFACE_RES - 1.0001, Math.max(0, y / SURFACE_STEP));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const a = surface[j * SURFACE_RES + i];
  const b = surface[j * SURFACE_RES + i + 1];
  const c = surface[(j + 1) * SURFACE_RES + i];
  const d = surface[(j + 1) * SURFACE_RES + i + 1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

// --- Building foundations ----------------------------------------------
// A building can't stand on a slope: anywhere it sits, the displayed
// surface is levelled to a flat pad under its footprint and eased back into
// the natural ground over FOUNDATION_MARGIN cells, the way a cut-and-fill
// terrace looks. Applied to the baked surface itself, so the mesh, picking,
// tree placement and the building's own seat all read one height - fixing
// "floating on the downhill side, buried on the uphill side" at the data
// layer rather than by hiding it. Footprints are rotated rectangles in cell
// units: { x, y, hx, hz, rot, level }.
export const FOUNDATION_MARGIN = 1.6;

// 1 inside the footprint, easing to 0 at FOUNDATION_MARGIN outside it;
// `grow` widens the footprint (tree clearance uses it).
export function footprintWeight(f, x, y, grow = 0) {
  const dx = x - f.x;
  const dy = y - f.y;
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  const ex = Math.max(0, Math.abs(dx * c + dy * s) - f.hx - grow);
  const ez = Math.max(0, Math.abs(-dx * s + dy * c) - f.hz - grow);
  const d = Math.hypot(ex, ez);
  return 1 - smoothstep(0, FOUNDATION_MARGIN, d);
}

// Axis-aligned cell bounds a footprint (and its easing) can touch.
export function footprintBounds(f, pad = FOUNDATION_MARGIN) {
  const r = Math.hypot(f.hx, f.hz) + pad;
  return { minX: f.x - r, minY: f.y - r, maxX: f.x + r, maxY: f.y + r };
}

// The pad's height: the mean of the natural surface under the footprint,
// never below the sea (a quay or a bridgehead still sits at the waterline).
export function foundationLevel(raw, f) {
  let sum = 0;
  let n = 0;
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  for (let a = -2; a <= 2; a++) {
    for (let b = -2; b <= 2; b++) {
      const lx = (a / 2) * f.hx;
      const lz = (b / 2) * f.hz;
      sum += sampleSurface(raw, f.x + lx * c - lz * s, f.y + lx * s + lz * c);
      n++;
    }
  }
  return Math.max(SEA_LEVEL, sum / n);
}

// Sets every footprint's `level`. Places whose pads touch share one level,
// a single terrace, or the later pad would cut into its neighbour where
// their easings overlap (a windmill beside its field, a wall against a
// castle). Area-weighted: a castle sets the terrace more than its well.
export function setFoundationLevels(raw, list) {
  for (const f of list) f.level = foundationLevel(raw, f);
  const parent = list.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const touches = (a, b) => {
    const c = Math.cos(b.rot);
    const s = Math.sin(b.rot);
    for (const [u, v] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const lx = u * b.hx;
      const lz = v * b.hz;
      if (footprintWeight(a, b.x + lx * c - lz * s, b.y + lx * s + lz * c) > 0) return true;
    }
    return false;
  };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y) > 14) continue;
      if (touches(list[i], list[j]) || touches(list[j], list[i])) parent[root(i)] = root(j);
    }
  }
  const sums = new Map();
  list.forEach((f, i) => {
    const acc = sums.get(root(i)) ?? { level: 0, area: 0 };
    acc.level += f.level * f.hx * f.hz;
    acc.area += f.hx * f.hz;
    sums.set(root(i), acc);
  });
  list.forEach((f, i) => {
    const acc = sums.get(root(i));
    f.level = acc.level / acc.area;
  });
}

// out = raw with every footprint's pad blended in, over the texel range
// given (inclusive), so an edit only redoes what it touched.
export function levelFootprints(raw, out, footprints, { i0, i1, j0, j1 }) {
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) out[j * SURFACE_RES + i] = raw[j * SURFACE_RES + i];
  }
  for (const f of footprints) {
    const b = footprintBounds(f);
    const fi0 = Math.max(i0, Math.floor(b.minX / SURFACE_STEP));
    const fi1 = Math.min(i1, Math.ceil(b.maxX / SURFACE_STEP));
    const fj0 = Math.max(j0, Math.floor(b.minY / SURFACE_STEP));
    const fj1 = Math.min(j1, Math.ceil(b.maxY / SURFACE_STEP));
    for (let j = fj0; j <= fj1; j++) {
      for (let i = fi0; i <= fi1; i++) {
        const w = footprintWeight(f, i * SURFACE_STEP, j * SURFACE_STEP);
        if (w <= 0) continue;
        const k = j * SURFACE_RES + i;
        out[k] += (f.level - out[k]) * w;
      }
    }
  }
}

// --- Material boundaries -------------------------------------------------
// Painted terrain type is a per-cell category. To draw it as organic
// regions rather than cell-shaped blocks: (1) each type becomes its own
// weight channel, B-spline-sampled (smooth), (2) at a *domain-warped*
// position - the boundary wanders up to ~2 cells either way along a smooth
// noise field, so a straight painted edge reads as a natural, irregular one,
// while a small painted patch still exists (shifted, never erased), and
// (3) the channels compete by height-based blending (Mishkinis, "Advanced
// Terrain Texture Splatting", 2013 - the same technique as Unreal's Layer
// Blend height mode and Terrain3D): each material has its own procedural
// "height", and near a boundary the taller one wins, giving crisp, clumpy
// edges (tree clumps, rock outcrops) instead of a soft colour fade.
export function materialWarp(x, y) {
  return [
    1.7 * snoise(x * 0.07 + 1.7, y * 0.07 + 9.2) + 0.5 * snoise(x * 0.31 + 4.1, y * 0.31 + 0.6),
    1.7 * snoise(x * 0.07 + 8.3, y * 0.07 + 2.8) + 0.5 * snoise(x * 0.31 + 7.9, y * 0.31 + 3.3),
  ];
}

// Per-material procedural heights, each 0..1: grass even, sand smooth,
// forest in tree-sized clumps, rock in jagged outcrops.
export function materialHeights(x, y) {
  return [
    0.5 + 0.2 * snoise(x * 0.23 + 2.0, y * 0.23 + 6.0),
    0.42 + 0.18 * snoise(x * 0.11 + 9.0, y * 0.11 + 1.0),
    0.5 + 0.42 * snoise(x * 0.19 + 4.0, y * 0.19 + 4.0),
    0.5 + 0.4 * (1 - Math.abs(snoise(x * 0.17 + 7.0, y * 0.17 + 3.0))) - 0.2,
  ];
}

export const BLEND_HEIGHT_INFLUENCE = 0.55;
export const BLEND_WIDTH = 0.14;

// Height-based blend of N weights: score_i = w_i + k*(h_i - 0.5); everything
// within BLEND_WIDTH of the best score shares in the result. Mirrored by the
// GLSL heightBlend.
export function heightBlend(weights, heights) {
  const scores = weights.map((w, i) => (w > 0 ? w + BLEND_HEIGHT_INFLUENCE * (heights[i] - 0.5) : -1));
  const best = Math.max(...scores);
  const out = scores.map((s) => Math.max(0, s - (best - BLEND_WIDTH)));
  const sum = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((v) => v / sum);
}

// One-hot weight per terrain type for every land cell (sea cells are all
// zero, so they never pull a coastal material toward anything). This is
// exactly what the GPU's type texture holds, one channel per type.
export function buildTypeWeights(elevationGrid, typeGrid) {
  const weights = TERRAIN_TYPES.map(() => new Float32Array(GRID_SIZE * GRID_SIZE));
  for (let i = 0; i < elevationGrid.length; i++) {
    if (elevationGrid[i] <= SEA_LEVEL) continue;
    weights[typeGrid[i]][i] = 1;
  }
  return weights;
}

// Fraction of the ground at (x, y) that renders as each painted material
// (before automatic rock/snow/beach, which only the GPU adds). Used for
// tree placement so trees grow exactly on the forest floor the shader draws.
export function paintedMaterialAt(typeWeights, x, y) {
  const [dx, dy] = materialWarp(x, y);
  const raw = typeWeights.map((grid) => bsplineSample(grid, x + dx, y + dy));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum < 1e-3) return [1, 0, 0, 0];
  return heightBlend(
    raw.map((w) => w / sum),
    materialHeights(x, y),
  );
}

// --- Coast distance field ------------------------------------------------
// Signed distance to the coastline, in cells (positive on land), sampled at
// COAST_SDF_RES^2. Drives everything "relative to the shore": the shallow
// water band, Wonderdraft-style ripple lines, automatic beaches. Computed
// from the same B-spline surface the renderer draws, so the ripples run
// parallel to the coast the user actually sees.
//
// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher,
// "Distance Transforms of Sampled Functions", 2012), seeded with sub-pixel
// crossing distances instead of a binary mask: the algorithm accepts any
// sampled function, and seeding each boundary pixel with its own linear
// distance to the zero crossing removes the staircase a binary-mask
// transform leaves behind (which would otherwise reappear as stepped
// ripple lines - the very artefact this overhaul is removing).
export const COAST_SDF_RES = 512;
const SDF_INF = 1e20;

function edt1d(f, n, out, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -SDF_INF;
  z[1] = SDF_INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = SDF_INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    out[q] = d * d + f[v[k]];
  }
}

export function computeCoastSDF(elevationGrid, out = new Float32Array(COAST_SDF_RES * COAST_SDF_RES)) {
  const n = COAST_SDF_RES;
  const pxPerCell = n / GRID_SIZE;
  const surface = new Float32Array(n * n);
  for (let py = 0; py < n; py++) {
    const y = (py + 0.5) / pxPerCell - 0.5;
    for (let px = 0; px < n; px++) {
      surface[py * n + px] = bsplineSample(elevationGrid, (px + 0.5) / pxPerCell - 0.5, y) - SEA_LEVEL;
    }
  }

  const f = new Float64Array(n * n).fill(SDF_INF);
  const seed = (i, d) => {
    const d2 = d * d;
    if (d2 < f[i]) f[i] = d2;
  };
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const i = py * n + px;
      const a = surface[i];
      if (px + 1 < n) {
        const b = surface[i + 1];
        if (a > 0 !== b > 0) {
          const t = a / (a - b);
          seed(i, t);
          seed(i + 1, 1 - t);
        }
      }
      if (py + 1 < n) {
        const b = surface[i + n];
        if (a > 0 !== b > 0) {
          const t = a / (a - b);
          seed(i, t);
          seed(i + n, 1 - t);
        }
      }
    }
  }

  const line = new Float64Array(n);
  const lineOut = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let px = 0; px < n; px++) {
    for (let py = 0; py < n; py++) line[py] = f[py * n + px];
    edt1d(line, n, lineOut, v, z);
    for (let py = 0; py < n; py++) f[py * n + px] = lineOut[py];
  }
  for (let py = 0; py < n; py++) {
    const row = py * n;
    for (let px = 0; px < n; px++) line[px] = f[row + px];
    edt1d(line, n, lineOut, v, z);
    for (let px = 0; px < n; px++) {
      const d = Math.min(64, Math.sqrt(lineOut[px]) / pxPerCell);
      out[row + px] = surface[row + px] > 0 ? d : -d;
    }
  }
  return out;
}

// --- GLSL twins ------------------------------------------------------------
// Every function above that the GPU also needs, in the same order with the
// same constants. `uHeight` (elevation) and `uType` (one channel per terrain
// type) are 256x256 linear-filtered textures; texel i's centre is cell i.
const SURFACE_STEP_GLSL = SURFACE_STEP.toFixed(8);

export const TERRAIN_FIELDS_GLSL = /* glsl */ `
  uniform sampler2D uHeight;
  uniform sampler2D uType;
  uniform float uGridSize;

  vec3 tf_mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 tf_mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 tf_permute(vec3 x) { return tf_mod289(((x * 34.0) + 10.0) * x); }
  float snoise(vec2 v) {
    const vec4 C = vec4(${C0}, ${C1}, ${C2}, ${C3});
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = tf_mod289(i);
    vec3 p = tf_permute(tf_permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  vec4 bsplineSample(sampler2D tex, vec2 cell) {
    vec2 i = floor(cell);
    vec2 t = cell - i;
    vec2 it = 1.0 - t;
    vec2 w0 = it * it * it / 6.0;
    vec2 w1 = (3.0 * t * t * t - 6.0 * t * t + 4.0) / 6.0;
    vec2 w2 = (-3.0 * t * t * t + 3.0 * t * t + 3.0 * t + 1.0) / 6.0;
    vec2 w3 = t * t * t / 6.0;
    vec2 g0 = w0 + w1;
    vec2 g1 = w2 + w3;
    vec2 p0 = (i - 1.0 + w1 / g0 + 0.5) / uGridSize;
    vec2 p1 = (i + 1.0 + w3 / g1 + 0.5) / uGridSize;
    return g0.y * (g0.x * texture2D(tex, p0) + g1.x * texture2D(tex, vec2(p1.x, p0.y)))
         + g1.y * (g0.x * texture2D(tex, vec2(p0.x, p1.y)) + g1.x * texture2D(tex, p1));
  }

  float tf_smooth(float e0, float e1, float x) { return smoothstep(e0, e1, x); }

  float mountainMask(float e) { return smoothstep(${MOUNTAIN_BAND_START.toFixed(4)}, ${MOUNTAIN_BAND_END.toFixed(4)}, e); }

  float smoothElevation(vec2 cell) { return bsplineSample(uHeight, cell).r; }

  // The baked display surface (bakeSurface above) - the only place the GPU
  // learns the synthesised relief, so it can never disagree with the CPU.
  uniform sampler2D uSurface;
  float surfaceHeight(vec2 cell) {
    return texture2D(uSurface, (cell / ${SURFACE_STEP_GLSL} + 0.5) / ${SURFACE_RES.toFixed(1)}).r;
  }

  vec2 materialWarp(vec2 p) {
    return vec2(
      1.7 * snoise(p * 0.07 + vec2(1.7, 9.2)) + 0.5 * snoise(p * 0.31 + vec2(4.1, 0.6)),
      1.7 * snoise(p * 0.07 + vec2(8.3, 2.8)) + 0.5 * snoise(p * 0.31 + vec2(7.9, 3.3))
    );
  }

  vec4 materialHeights(vec2 p) {
    return vec4(
      0.5 + 0.2 * snoise(p * 0.23 + vec2(2.0, 6.0)),
      0.42 + 0.18 * snoise(p * 0.11 + vec2(9.0, 1.0)),
      0.5 + 0.42 * snoise(p * 0.19 + vec2(4.0, 4.0)),
      0.5 + 0.4 * (1.0 - abs(snoise(p * 0.17 + vec2(7.0, 3.0)))) - 0.2
    );
  }

  vec4 heightBlend(vec4 w, vec4 h) {
    vec4 s = mix(vec4(-1.0), w + ${BLEND_HEIGHT_INFLUENCE.toFixed(4)} * (h - 0.5), step(1e-6, w));
    float best = max(max(s.x, s.y), max(s.z, s.w));
    vec4 o = max(vec4(0.0), s - (best - ${BLEND_WIDTH.toFixed(4)}));
    return o / max(1e-5, dot(o, vec4(1.0)));
  }

  // Raw painted-type weights at the warped position, normalised (or pure
  // grass where no land is near - only reached in the sea, where it's unused).
  vec4 paintedWeights(vec2 cell) {
    vec4 raw = bsplineSample(uType, cell + materialWarp(cell));
    float sum = dot(raw, vec4(1.0));
    return sum < 1e-3 ? vec4(1.0, 0.0, 0.0, 0.0) : raw / sum;
  }
`;
