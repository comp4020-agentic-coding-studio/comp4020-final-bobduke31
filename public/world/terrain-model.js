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
