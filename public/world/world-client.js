import {
  GRID_SIZE,
  ELEVATION_MIN,
  ELEVATION_MAX,
  SEA_LEVEL,
  TERRAIN_TYPES,
  clamp,
  createElevationGrid,
  createTypeGrid,
  isLand,
  applyElevationCells,
  setElevationFromList,
  applyTypeCells,
  clearTypeCells,
  setTypesFromList,
} from "./terrain-model.js";
import { renderTerrain, renderTerrainOblique, obliqueRise, OBLIQUE_MAX_RISE } from "./terrain-renderer.js";
import { createTerrainScene3D, isWebGL2Available } from "./terrain-renderer-3d.js";

// Canvas footprint stays the same (256 * 3 = 768, same as the old 128 * 6)
// - resolution doubles by making cells smaller, not the map physically
// bigger, which is what actually makes individual cells less noticeable.
const CELL_PX = 3;
const FLUSH_INTERVAL_MS = 100;
const LAND_PUSH = 0.35; // how far "create land" / "paint sea" push past sea level

// The oblique view (see terrain-renderer.js) shifts elevated cells upward
// on screen, so a tall peak near the top of the grid needs real headroom
// above the ordinary top-down layout or it gets clipped at the canvas
// edge. +4 is just slack past the theoretical maximum rise.
const OBLIQUE_MARGIN = OBLIQUE_MAX_RISE + 4;
let viewMode = "top"; // "top" | "oblique" - see wireViewToggle

// Raise/Lower/Smooth/Mountain/Peak all sculpt existing land and must never
// cross into the sea - only Create Land / Paint Sea are allowed to change
// the land/water boundary (see ADR.md and the tool semantics below). This
// floor is the one place that rule is enforced, so every land-sculpting
// tool shares it rather than each clamping its own way.
const LAND_FLOOR = SEA_LEVEL + 0.02;
const MOUNTAIN_TARGET = 0.6;
const PEAK_TARGET = 0.95;

const canvas = document.getElementById("stage");
canvas.width = GRID_SIZE * CELL_PX;
canvas.height = GRID_SIZE * CELL_PX;
const ctx = canvas.getContext("2d");

const elevationGrid = createElevationGrid();
const typeGrid = createTypeGrid();

// The WebGL2 heightfield renderer (terrain-renderer-3d.js) needs its own
// canvas - a canvas can only ever hand out one kind of rendering context in
// its lifetime, so it can't share #stage with the 2D top-down renderer.
// `scene3d` stays null (the existing column-extrusion oblique renderer on
// `canvas`/`ctx` keeps working unchanged) on any browser without WebGL2.
const canvas3d = document.getElementById("stage-3d");
canvas3d.width = GRID_SIZE * CELL_PX;
canvas3d.height = GRID_SIZE * CELL_PX;
const scene3d = isWebGL2Available() ? createTerrainScene3D(canvas3d, elevationGrid, typeGrid) : null;

function activeCanvas() {
  return viewMode === "oblique" && scene3d ? canvas3d : canvas;
}

let currentTool = "raise";
// Doubled from the 128-grid default (5) so the brush covers the same
// physical/screen area now that cells are half the size.
let brushRadius = 10;
let brushStrength = 0.15;

const pendingElevation = new Map();
const pendingTypes = new Map();
let flushHandle = null;
let painting = false;
let lastStampPos = null;

function smoothstep(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

// --- Rendering: batched to one redraw per animation frame, of only the
// cells that actually changed, instead of the previous "redraw the full
// 128x128 grid synchronously on every pointer event" (profiled at ~19ms
// per redraw, and a single 60-step drag triggered 75 of them - over a
// second of blocked input). Input and model updates below stay fully
// synchronous and cheap (plain array writes); only painting to the canvas
// is deferred and coalesced here. ---
let renderScheduled = false;
let dirty = null; // {minX, minY, maxX, maxY} - the union of cells touched since the last paint

function markDirty(x, y) {
  if (!dirty) {
    dirty = { minX: x, minY: y, maxX: x, maxY: y };
    return;
  }
  if (x < dirty.minX) dirty.minX = x;
  if (y < dirty.minY) dirty.minY = y;
  if (x > dirty.maxX) dirty.maxX = x;
  if (y > dirty.maxY) dirty.maxY = y;
}

// Pushes the current grids into the 3D renderer and draws one frame. Both
// texture uploads are of the whole 256x256 grid (a few hundred KB total) -
// cheap enough to redo in full on every batched update rather than tracking
// a sub-rectangle, the same "small enough that simple is fine" call
// terrain-renderer.js already makes for its own coastline recompute.
function render3D() {
  scene3d.updateHeight(elevationGrid);
  scene3d.updateType(elevationGrid, typeGrid);
  scene3d.render();
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (!dirty) return;
    if (viewMode === "oblique" && scene3d) {
      dirty = null;
      render3D();
      return;
    }
    // The canvas-column oblique fallback has no safe "just the changed
    // cells" shortcut: a column's height can newly cover (or uncover) rows
    // several steps farther away on screen, not just the cells a brush
    // stroke actually touched - see renderTerrainOblique's doc comment. So
    // it always repaints the whole grid, batched to one redraw per
    // animation frame the same way the partial redraw below is, rather
    // than once per pointer event.
    if (viewMode === "oblique") {
      dirty = null;
      renderTerrainOblique(ctx, elevationGrid, typeGrid, CELL_PX, OBLIQUE_MARGIN);
      return;
    }
    // Padded by 1: the coastline stroke has width, so it can cover a
    // sliver of a cell just outside the cells that actually changed.
    const region = { minX: dirty.minX - 1, minY: dirty.minY - 1, maxX: dirty.maxX + 1, maxY: dirty.maxY + 1 };
    dirty = null;
    renderTerrain(ctx, elevationGrid, typeGrid, CELL_PX, region);
  });
}

function redrawAll() {
  dirty = null;
  if (viewMode === "oblique" && scene3d) {
    render3D();
    return;
  }
  if (viewMode === "oblique") renderTerrainOblique(ctx, elevationGrid, typeGrid, CELL_PX, OBLIQUE_MARGIN);
  else renderTerrain(ctx, elevationGrid, typeGrid, CELL_PX);
}

function queueElevation(x, y, elevation) {
  pendingElevation.set(`${x},${y}`, { x, y, elevation });
}

function queueType(x, y, terrain) {
  pendingTypes.set(`${x},${y}`, { x, y, terrain });
}

let flushing = false;

function scheduleFlush() {
  // Guards the pending *timer*, but a slow network response could still
  // leave a flush in flight when the next one fires - `flushing` below
  // guards that case, which this alone does not.
  if (flushHandle) return;
  flushHandle = setTimeout(flush, FLUSH_INTERVAL_MS);
}

async function flush() {
  flushHandle = null;
  // If a previous flush's request is still in flight (e.g. a slow
  // connection outlasting the 100ms interval), wait for it rather than
  // sending a second, overlapping request for the same cells - two
  // in-flight requests racing could let the server apply them out of
  // send-order, which would silently undo the newer edit. `flush()` is
  // called again once the in-flight one finishes if anything is still
  // pending (see below), so nothing queued here is lost.
  if (flushing) return;
  if (pendingElevation.size === 0 && pendingTypes.size === 0) return;
  flushing = true;
  const elevationCells = [...pendingElevation.values()];
  const typeCells = [...pendingTypes.values()];
  pendingElevation.clear();
  pendingTypes.clear();
  try {
    if (elevationCells.length > 0) {
      await fetch("/api/terrain/cells", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cells: elevationCells }),
      });
    }
    if (typeCells.length > 0) {
      await fetch("/api/terrain/types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cells: typeCells }),
      });
    }
  } catch {
    // Best-effort for this pass: a dropped batch is visible again next
    // time someone repaints the same spot - see ADR.md.
  }
  flushing = false;
  // Anything painted while that request was in flight needs its own
  // flush - this is what makes the early return above safe rather than
  // silently losing a batch.
  if (pendingElevation.size > 0 || pendingTypes.size > 0) scheduleFlush();
}

// Visits every cell within brushRadius of (cx, cy), with a smooth
// (smoothstep, not linear) falloff from the centre - a brush stroke reads
// as a soft bump rather than a sharp cone.
function forEachBrushCell(cx, cy, apply) {
  const r = brushRadius;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r) continue;
      const falloff = smoothstep(1 - dist / r);
      apply(x, y, falloff);
    }
  }
}

function lerpTowards(current, target, t) {
  return current + (target - current) * t;
}

function neighborAverage(x, y) {
  let sum = 0;
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      sum += elevationGrid[ny * GRID_SIZE + nx];
      count++;
    }
  }
  return sum / count;
}

// Every elevation tool goes through here, so "becomes sea -> loses its
// terrain type" (the server's own rule, src/terrain.ts applyCells) holds
// optimistically on the client too, for every tool, in one place. This is
// the ONLY path that may write elevation at or below SEA_LEVEL - every
// land-sculpting tool below goes through setLandElevation instead, which
// cannot.
function setElevation(x, y, elevation) {
  const clamped = clamp(elevation, ELEVATION_MIN, ELEVATION_MAX);
  elevationGrid[y * GRID_SIZE + x] = clamped;
  queueElevation(x, y, clamped);
  markDirty(x, y);
  if (clamped <= SEA_LEVEL) clearTypeCells(typeGrid, [{ x, y }]);
}

// Raise, Lower, Smooth, Mountain and Peak all go through here: they sculpt
// existing land and must never cross into the sea by accident (this was a
// real bug - Lower or Smooth near a coast, or just repeated use, could push
// a land cell below SEA_LEVEL with nothing stopping it, scattering stray
// "ocean" cells through what should stay land). Two rules enforce that:
// a cell that's currently sea is left alone (these tools don't create
// land - Create Land does), and the result is always clamped above
// LAND_FLOOR, so no amount of lowering/smoothing can tip it into the sea.
function setLandElevation(x, y, elevation) {
  const index = y * GRID_SIZE + x;
  if (elevationGrid[index] <= SEA_LEVEL) return;
  const clamped = clamp(elevation, LAND_FLOOR, ELEVATION_MAX);
  elevationGrid[index] = clamped;
  queueElevation(x, y, clamped);
  markDirty(x, y);
}

function setRockType(x, y) {
  typeGrid[y * GRID_SIZE + x] = TERRAIN_TYPES.indexOf("rock");
  queueType(x, y, "rock");
}

function paintAt(cx, cy) {
  switch (currentTool) {
    case "raise":
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        setLandElevation(x, y, elevationGrid[y * GRID_SIZE + x] + brushStrength * falloff);
      });
      break;
    case "lower":
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        setLandElevation(x, y, elevationGrid[y * GRID_SIZE + x] - brushStrength * falloff);
      });
      break;
    case "smooth":
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        const current = elevationGrid[y * GRID_SIZE + x];
        setLandElevation(x, y, lerpTowards(current, neighborAverage(x, y), brushStrength * 2 * falloff));
      });
      break;
    case "mountain":
      // Raises land toward a high ridge band and marks it rocky - a
      // mountain is height and material together, not a grey tint on flat
      // ground (see ADR.md / CLAUDE.md on not faking elevation with colour).
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        const current = elevationGrid[y * GRID_SIZE + x];
        if (current <= SEA_LEVEL) return;
        setLandElevation(x, y, lerpTowards(current, MOUNTAIN_TARGET, falloff));
        setRockType(x, y);
        markDirty(x, y);
      });
      break;
    case "peak":
      // Same idea, pushed toward the elevation ceiling for a prominent
      // summit; the renderer tints the highest rock as snow, so a peak
      // reads as a peak even with colour turned off (hillshading alone).
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        const current = elevationGrid[y * GRID_SIZE + x];
        if (current <= SEA_LEVEL) return;
        setLandElevation(x, y, lerpTowards(current, PEAK_TARGET, falloff));
        setRockType(x, y);
        markDirty(x, y);
      });
      break;
    case "land":
      // Blends toward "comfortably land", stronger at the brush centre -
      // repeated strokes still make progress on reluctant deep water. The
      // one elevation tool (with "sea" below) allowed to cross SEA_LEVEL.
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        const current = elevationGrid[y * GRID_SIZE + x];
        setElevation(x, y, lerpTowards(current, SEA_LEVEL + LAND_PUSH, falloff));
      });
      break;
    case "sea":
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        const current = elevationGrid[y * GRID_SIZE + x];
        setElevation(x, y, lerpTowards(current, SEA_LEVEL - LAND_PUSH, falloff));
      });
      break;
    default:
      // One of TERRAIN_TYPES: painting a type only ever touches land - a
      // brush straddling a coastline simply has no effect on its sea half,
      // the same rule the server enforces independently.
      forEachBrushCell(cx, cy, (x, y) => {
        if (!isLand(elevationGrid, x, y)) return;
        typeGrid[y * GRID_SIZE + x] = TERRAIN_TYPES.indexOf(currentTool);
        queueType(x, y, currentTool);
        markDirty(x, y);
      });
      break;
  }
  scheduleRender();
  scheduleFlush();
}

// How far the pointer must actually travel (in grid cells) before the next
// stamp is placed, regardless of how many pointermove events fire along the
// way. This - not the falloff shape - is what makes a stroke's total effect
// depend on distance travelled, not on event frequency: a slow drag can fire
// pointermove dozens of times over a few cells, and without a minimum
// spacing each of those was its own full-strength stamp, so the same
// physical gesture could apply 1 stamp or 30 depending only on mouse
// polling rate. Scales with brush radius (a tiny brush needs tight spacing
// to paint a continuous line at all) but never below a hard floor.
function stampSpacing() {
  return Math.max(0.4, brushRadius * 0.5);
}

// Walks the segment from (x0, y0) - the last cell a stamp actually landed
// on - to (x1, y1) - where the pointer is now - placing a stamp every
// stampSpacing() cells. Returns the exact fractional position just past the
// last stamp placed, not (x1, y1) itself: the caller carries that forward as
// the new "last stamp" origin, so leftover sub-spacing distance accumulates
// across calls instead of being discarded. Without that carry-over, a slow
// drag - many pointermove events, each covering less than one spacing unit
// - would place its first stamp and then never place another, since every
// individual call would see "not far enough yet" and reset to zero.
function stampAlong(x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const spacing = stampSpacing();
  const steps = Math.floor(dist / spacing);
  for (let i = 1; i <= steps; i++) {
    const t = (i * spacing) / dist;
    paintAt(Math.round(x0 + dx * t), Math.round(y0 + dy * t));
  }
  if (steps === 0) return { x: x0, y: y0 };
  const consumedT = (steps * spacing) / dist;
  return { x: x0 + dx * consumedT, y: y0 + dy * consumedT };
}

// In the oblique view, a screen point doesn't map to one grid cell by
// simple division any more - what's drawn at (px, py) might be the lit cap
// of a tall, *farther* mountain column that happens to reach forward over
// closer, flatter ground (exactly the occlusion the projection is for).
// This walks the same column geometry renderTerrainOblique draws, from the
// nearest row backward, and returns the first (so: frontmost, topmost-drawn)
// cell whose column actually covers that point - i.e. whatever the user is
// really looking at under their cursor, not just whatever row the y pixel
// would land on in a flat top-down reading.
function obliqueScreenToGrid(px, py) {
  const gx = Math.floor(px / CELL_PX);
  if (gx < 0 || gx >= GRID_SIZE) return { x: -1, y: -1 };
  for (let gy = GRID_SIZE - 1; gy >= 0; gy--) {
    const baseY = gy * CELL_PX;
    const top = baseY - obliqueRise(elevationGrid[gy * GRID_SIZE + gx]);
    if (py >= top && py <= baseY + CELL_PX) return { x: gx, y: gy };
  }
  return { x: -1, y: -1 };
}

function canvasToGrid(event) {
  const el = activeCanvas();
  const rect = el.getBoundingClientRect();
  const px = ((event.clientX - rect.left) / rect.width) * el.width;
  const py = ((event.clientY - rect.top) / rect.height) * el.height;
  if (viewMode === "oblique" && scene3d) {
    // The 3D renderer's own ray-heightfield march (against the same
    // elevationGrid this file paints into) is the single source of truth
    // for picking in that view - see terrain-renderer-3d.js.
    const hit = scene3d.pick(px, py, elevationGrid);
    return hit ?? { x: -1, y: -1 };
  }
  if (viewMode === "oblique") return obliqueScreenToGrid(px, py - OBLIQUE_MARGIN);
  return { x: Math.floor(px / CELL_PX), y: Math.floor(py / CELL_PX) };
}

// -1,-1 means the pointer isn't over any drawn terrain column at all - only
// reachable in the oblique view, by pointing at empty space above every
// column within that screen x (e.g. the sky above a low-lying map). Just
// doesn't paint, the same way clicking outside the canvas entirely already
// does nothing.
function isOffTerrain(pos) {
  return pos.x < 0 || pos.y < 0;
}

function handlePointerDown(event) {
  painting = true;
  event.currentTarget.setPointerCapture(event.pointerId);
  const pos = canvasToGrid(event);
  // lastStampPos is fractional (the exact point stampAlong last walked to),
  // not the integer cell paintAt was actually called with - see stampAlong.
  lastStampPos = isOffTerrain(pos) ? null : pos;
  if (!isOffTerrain(pos)) paintAt(pos.x, pos.y);
}

function handlePointerMove(event) {
  if (!painting) return;
  const pos = canvasToGrid(event);
  if (isOffTerrain(pos)) return;
  if (lastStampPos) lastStampPos = stampAlong(lastStampPos.x, lastStampPos.y, pos.x, pos.y);
  else {
    paintAt(pos.x, pos.y);
    lastStampPos = pos;
  }
}

function stopPainting() {
  if (!painting) return;
  painting = false;
  lastStampPos = null;
  flush();
}

// Listeners are on both canvases - only the one `activeCanvas()` has made
// visible ever receives pointer events (a `display: none` element is never
// hit-tested), so `event.currentTarget` in the handlers above is always the
// right one to capture the pointer on.
for (const el of [canvas, canvas3d]) {
  el.addEventListener("pointerdown", handlePointerDown);
  el.addEventListener("pointermove", handlePointerMove);
  el.addEventListener("pointerup", stopPainting);
  el.addEventListener("pointercancel", stopPainting);
  el.addEventListener("contextmenu", (event) => event.preventDefault());
}

function wireToolbar() {
  const buttons = document.querySelectorAll("[data-tool]");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      for (const other of buttons) other.classList.remove("active");
      button.classList.add("active");
      currentTool = button.dataset.tool;
    });
  }

  const sizeInput = document.getElementById("brush-size");
  sizeInput.addEventListener("input", () => {
    brushRadius = Number(sizeInput.value);
  });

  const strengthInput = document.getElementById("brush-strength");
  strengthInput.addEventListener("input", () => {
    brushStrength = Number(strengthInput.value);
  });
}

function wireViewToggle() {
  const buttons = document.querySelectorAll("[data-view]");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const mode = button.dataset.view;
      if (mode === viewMode) return;
      viewMode = mode;
      for (const other of buttons) other.classList.remove("active");
      button.classList.add("active");
      const show3D = viewMode === "oblique" && scene3d;
      canvas3d.classList.toggle("hidden", !show3D);
      canvas.classList.toggle("hidden", show3D);
      if (!show3D) {
        // The canvas-column fallback oblique view needs extra canvas height
        // so a peak near row 0 has room to rise into without being clipped
        // (see OBLIQUE_MARGIN); top-down doesn't, so this only grows the
        // canvas when switching in, not permanently. world.css gives
        // #stage a fixed CSS height, which would otherwise squash this
        // taller backing store back down and throw off its aspect ratio -
        // overriding it inline keeps a 1:1 pixel mapping (and
        // canvasToGrid's px/py math correct) either way. The 3D canvas's
        // size is fixed (the camera frustum handles rise, not canvas
        // height), so it never needs this.
        canvas.height = GRID_SIZE * CELL_PX + (viewMode === "oblique" ? OBLIQUE_MARGIN : 0);
        canvas.style.height = `${canvas.height}px`;
      }
      redrawAll();
    });
  }
}

async function loadTerrain() {
  const [elevationRes, typesRes] = await Promise.all([
    fetch("/api/terrain"),
    fetch("/api/terrain-types"),
  ]);
  setElevationFromList(elevationGrid, await elevationRes.json());
  setTypesFromList(typeGrid, await typesRes.json());
  redrawAll();
}

// A cell still sitting in `pendingElevation`/`pendingTypes` has a local
// edit we haven't sent yet - it is, by definition, newer than whatever
// value this broadcast carries for that cell. Applying the broadcast
// anyway would briefly snap the display back to a stale value before our
// own next flush corrects it again a moment later. Skipping those cells
// here and trusting the in-flight/next flush to reconcile them avoids
// that visible regression, without needing any server-side versioning.
function withoutPendingOverrides(cells, pending) {
  return cells.filter((cell) => !pending.has(`${cell.x},${cell.y}`));
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
    const toApply = withoutPendingOverrides(cells, pendingElevation);
    applyElevationCells(elevationGrid, toApply);
    for (const { x, y } of toApply) markDirty(x, y);
    scheduleRender();
  });
  source.addEventListener("terrain-type:update", (event) => {
    const { cells } = JSON.parse(event.data);
    const toApply = withoutPendingOverrides(cells, pendingTypes);
    applyTypeCells(typeGrid, toApply);
    for (const { x, y } of toApply) markDirty(x, y);
    scheduleRender();
  });
  source.addEventListener("terrain-type:clear", (event) => {
    const { cells } = JSON.parse(event.data);
    const toApply = withoutPendingOverrides(cells, pendingTypes);
    clearTypeCells(typeGrid, toApply);
    for (const { x, y } of toApply) markDirty(x, y);
    scheduleRender();
  });
}

wireToolbar();
wireViewToggle();
loadTerrain();
connectEvents();
