// A regional-scale grid for now; a bigger world later is chunking (x, y)
// into (chunk, x, y), not resizing this one - must match src/terrain.ts.
export const GRID_SIZE = 256;
export const ELEVATION_MIN = -1;
export const ELEVATION_MAX = 1;

// A cell is land if its elevation is above this; at or below, it's sea.
// A blank world is therefore entirely sea - land is painted into
// existence, not the default - must match src/terrain.ts.
export const SEA_LEVEL = 0;

export const TERRAIN_TYPES = ["grassland", "sand", "forest", "rock"];

// PROTOTYPE TRIAL (final-redesign-prototype branch): grid units per repeat
// of the painted grass texture (assets/textures/grass-cethiel.png, a real
// CC0 hand-painted texture - see CREDITS.md) - shared by both
// terrain-renderer.js (Top-down, Canvas2D) and terrain-renderer-3d.js
// (Oblique, WebGL shader) so the same texture tiles at the same physical
// scale in both views, rather than each view picking its own tiling
// frequency and visually disagreeing about how big a grass tuft is.
export const GRASS_TEXTURE_TILE_SIZE = 10;
const DEFAULT_TYPE_INDEX = 0; // grassland, for any land with no explicit type yet

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createElevationGrid() {
  return new Float32Array(GRID_SIZE * GRID_SIZE);
}

// Index into TERRAIN_TYPES, not the string, so the grid is a compact
// typed array like the elevation one. Defaults to grassland everywhere,
// which only matters once a cell becomes land.
export function createTypeGrid() {
  return new Uint8Array(GRID_SIZE * GRID_SIZE).fill(DEFAULT_TYPE_INDEX);
}

export function isLand(elevationGrid, x, y) {
  return elevationGrid[y * GRID_SIZE + x] > SEA_LEVEL;
}

// Bilinearly samples the authoritative grid at any real-valued (x, y) -
// shared by the oblique renderer's picking/tree placement and the top-down
// renderer's continuous (per-pixel, not per-cell) shading, so both views
// read the exact same smooth interpretation of the stored data rather than
// each hand-rolling a slightly different interpolation.
export function sampleBilinear(grid, x, y) {
  const cx = Math.min(GRID_SIZE - 1.001, Math.max(0, x));
  const cy = Math.min(GRID_SIZE - 1.001, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(GRID_SIZE - 1, x0 + 1);
  const y1 = Math.min(GRID_SIZE - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = grid[y0 * GRID_SIZE + x0];
  const b = grid[y0 * GRID_SIZE + x1];
  const c = grid[y1 * GRID_SIZE + x0];
  const d = grid[y1 * GRID_SIZE + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

export function applyElevationCells(grid, cells) {
  for (const { x, y, elevation } of cells) {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
    grid[y * GRID_SIZE + x] = elevation;
  }
}

export function setElevationFromList(grid, cells) {
  grid.fill(0);
  applyElevationCells(grid, cells);
}

export function applyTypeCells(grid, cells) {
  for (const { x, y, terrain } of cells) {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
    const index = TERRAIN_TYPES.indexOf(terrain);
    if (index === -1) continue;
    grid[y * GRID_SIZE + x] = index;
  }
}

// A cell that's been painted back to sea has no terrain type any more -
// reset it to the default so a later "create land" here starts fresh
// rather than silently reusing whatever it used to be.
export function clearTypeCells(grid, cells) {
  for (const { x, y } of cells) {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
    grid[y * GRID_SIZE + x] = DEFAULT_TYPE_INDEX;
  }
}

export function setTypesFromList(grid, cells) {
  grid.fill(DEFAULT_TYPE_INDEX);
  applyTypeCells(grid, cells);
}
