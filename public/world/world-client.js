import { GRID_SIZE, ELEVATION_MIN, ELEVATION_MAX, createGrid, clamp, applyCells, setFromList } from "./terrain-model.js";
import { renderTerrain } from "./terrain-renderer.js";

const CELL_PX = 6;
const BRUSH_RADIUS = 5;
const STRENGTH = 0.15;
const FLUSH_INTERVAL_MS = 100;

const canvas = document.getElementById("stage");
canvas.width = GRID_SIZE * CELL_PX;
canvas.height = GRID_SIZE * CELL_PX;
const ctx = canvas.getContext("2d");

const grid = createGrid();
const pending = new Map();
let painting = false;
let lowering = false;
let flushHandle = null;

function redraw() {
  renderTerrain(ctx, grid, CELL_PX);
}

function paintAt(centerX, centerY) {
  const sign = lowering ? -1 : 1;
  for (let dy = -BRUSH_RADIUS; dy <= BRUSH_RADIUS; dy++) {
    for (let dx = -BRUSH_RADIUS; dx <= BRUSH_RADIUS; dx++) {
      const x = centerX + dx;
      const y = centerY + dy;
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > BRUSH_RADIUS) continue;
      const falloff = 1 - dist / BRUSH_RADIUS;
      const index = y * GRID_SIZE + x;
      // Clamped client-side so the brush can never even attempt an
      // out-of-range value; the server clamps/rejects independently too
      // (src/terrain.ts isValidCell), since the client's word is never
      // trusted on its own.
      const elevation = clamp(grid[index] + sign * STRENGTH * falloff, ELEVATION_MIN, ELEVATION_MAX);
      grid[index] = elevation;
      pending.set(`${x},${y}`, { x, y, elevation });
    }
  }
  redraw();
  scheduleFlush();
}

function scheduleFlush() {
  if (flushHandle) return;
  flushHandle = setTimeout(flush, FLUSH_INTERVAL_MS);
}

async function flush() {
  flushHandle = null;
  if (pending.size === 0) return;
  const cells = [...pending.values()];
  pending.clear();
  try {
    await fetch("/api/terrain/cells", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cells }),
    });
  } catch {
    // Best-effort for this first pass: a dropped batch is visible again
    // next time someone repaints the same spot, an acceptable cost for a
    // shared, ownerless canvas - see ADR.md.
  }
}

function canvasToGrid(event) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * GRID_SIZE);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * GRID_SIZE);
  return { x, y };
}

canvas.addEventListener("pointerdown", (event) => {
  painting = true;
  lowering = event.shiftKey;
  canvas.setPointerCapture(event.pointerId);
  const { x, y } = canvasToGrid(event);
  paintAt(x, y);
});

canvas.addEventListener("pointermove", (event) => {
  if (!painting) return;
  const { x, y } = canvasToGrid(event);
  paintAt(x, y);
});

function stopPainting() {
  if (!painting) return;
  painting = false;
  flush();
}

canvas.addEventListener("pointerup", stopPainting);
canvas.addEventListener("pointercancel", stopPainting);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

async function loadTerrain() {
  const res = await fetch("/api/terrain");
  const cells = await res.json();
  setFromList(grid, cells);
  redraw();
}

function connectEvents() {
  const source = new EventSource("/api/events");
  // Fires on the first connect AND on every automatic reconnect after a
  // drop, so a client that missed events while disconnected always
  // recovers by re-fetching the authoritative state, rather than trusting
  // the stream to have replayed what it missed.
  source.addEventListener("open", loadTerrain);
  source.addEventListener("terrain:update", (event) => {
    const { cells } = JSON.parse(event.data);
    applyCells(grid, cells);
    redraw();
  });
}

loadTerrain();
connectEvents();
