// A regional-scale grid for now; a bigger world later is chunking (x, y)
// into (chunk, x, y), not resizing this one - must match src/terrain.ts.
export const GRID_SIZE = 128;
export const ELEVATION_MIN = -1;
export const ELEVATION_MAX = 1;

export function createGrid() {
  return new Float32Array(GRID_SIZE * GRID_SIZE);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function applyCells(grid, cells) {
  for (const { x, y, elevation } of cells) {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
    grid[y * GRID_SIZE + x] = elevation;
  }
}

export function setFromList(grid, cells) {
  grid.fill(0);
  applyCells(grid, cells);
}
