// Contract: grid in, pixels out - nothing else in this app knows how an
// elevation becomes a colour. This is a placeholder (flat colour bands,
// no contours or shading): the C9 bar is the real-time loop, not the
// visuals. Swap this one file for the real contour/hachure renderer later
// without touching the model or the network code.
import { GRID_SIZE } from "./terrain-model.js";

const BANDS = [
  [-1, -0.2, "#2c5f8a"],
  [-0.2, 0, "#4a86ad"],
  [0, 0.25, "#c7b889"],
  [0.25, 0.55, "#6f9c57"],
  [0.55, 0.8, "#7d7568"],
  [0.8, 1, "#ebebf0"],
];

function colorFor(elevation) {
  for (const [min, max, color] of BANDS) {
    if (elevation >= min && elevation <= max) return color;
  }
  return BANDS[BANDS.length - 1][2];
}

export function renderTerrain(ctx, grid, cellPx) {
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      ctx.fillStyle = colorFor(grid[y * GRID_SIZE + x]);
      ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
    }
  }
}
