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
import {
  renderTerrain,
  renderTerrainOblique,
  obliqueRise,
  OBLIQUE_MAX_RISE,
  loadGrassTexture,
} from "./terrain-renderer.js";
import { createTerrainScene3D, isWebGL2Available, MAX_DEVICE_PIXEL_RATIO } from "./terrain-renderer-3d.js";
import { snoise } from "./terrain-fields.js";
import { strengthFromSlider, sliderFromStrength, formatStrength, brushFalloff, softRaise, mountainRaise, coverageAccepts } from "./brush.js";
import { apiPath, room, loadRoom, loadMe, wireRoomUi, wireRoomEvents, openShareIfRequested, toast } from "./room-ui.js";
import { wireHistory, wireHistoryEvents, showHistoryEntry } from "./history-ui.js";

const canvasArea = document.getElementById("canvas-area");

// PROTOTYPE (final-redesign-prototype branch, UI/UX redesign): CELL_PX used
// to be a hardcoded constant (a fixed 768px square canvas regardless of the
// browser window) - the single biggest usability problem found comparing
// UI directions for this redesign: on any wide monitor the map sat in a
// small square surrounded by wasted dark background, while world.css's
// toolbar/panel chrome took a fixed slice off the top. world.css now gives
// the canvas a flexible box (grid/flex layout, no fixed pixel size) that
// fills whatever space is actually available; this derives CELL_PX from
// that real, measured space once at load, so the backing-store resolution
// matches the box the CSS layout actually gives it instead of a guessed
// constant. Not re-derived on every window resize (no ResizeObserver) - the
// CSS layout itself still responds live to a resize (the canvas visually
// scales like any image/video element), only the backing-store resolution
// stays fixed at whatever it was on load. A live re-render-at-full-
// resolution-on-every-resize pipeline is a real future refinement (noted in
// ROADMAP.md), not something this layout-focused prototype needs to solve.
function computeCellPx() {
  const rect = canvasArea.getBoundingClientRect();
  const available = Math.max(200, Math.min(rect.width, rect.height) - 40);
  return clamp(available / GRID_SIZE, 2, 6);
}

// PIXEL_SCALE is what the top-down canvas's backing store, renderer, and
// pixel<->grid picking math actually use - CELL_PX scaled up by the device
// pixel ratio (Task 4, ROADMAP.md) so the canvas's own pixel buffer matches
// the screen's real pixel density instead of being upscaled and softened by
// the browser. Capped the same way the 3D renderer caps it, for the same
// reason (bound the cost of a much denser backing store on a 3x+ display).
const CELL_PX = computeCellPx();
const DEVICE_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
const PIXEL_SCALE = CELL_PX * DEVICE_PIXEL_RATIO;
const FLUSH_INTERVAL_MS = 100;
// How far "create land" / "paint sea" push past sea level. Create Land
// targets low coastal ground, not hill height: the renderer now reads
// elevation as terrain *shape* (mountainMask starts at 0.1 - ridges, rock),
// so the old 0.35 turned every new strip of land into a rocky dome. Raise /
// Mountain are for height; Create Land is for coastline.
const LAND_PUSH = 0.06;
const SEA_PUSH = 0.25;

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
// Mountain/Peak raise land toward a ceiling, but additively and with a
// noise-perturbed footprint (see mountainFalloff) - not by converging every
// cell in a disc to one fixed target, which is what made every stroke a
// flat-topped circle with a rim, and two strokes a "figure 8" (ROADMAP.md
// task 5, finding 1). Ridgelines and rock are no longer painted at all: the
// renderer synthesises ridges from elevation and draws rock where the land
// is steep or high (terrain-fields.js), so they follow the terrain's shape
// instead of the brush's.
const MOUNTAIN_CEILING = 0.72;
const PEAK_CEILING = 0.98;
// Where a Mountain/Peak stroke's flank ceiling bottoms out: lowland height,
// so a range's outer slopes meet the plains (see brush.js mountainRaise).
const MOUNTAIN_FLOOR = 0.12;

// Mirrors LAND_FLOOR on the other side of the coastline (Task 1, ROADMAP.md):
// Deepen/Shallow sculpt existing sea and must never cross into land, the
// same invariant Raise/Lower/etc. enforce for land. Create Land / Paint Sea
// remain the only tools that move the coastline itself.
const SEABED_CEILING = SEA_LEVEL - 0.02;

const canvas = document.getElementById("stage");
canvas.width = GRID_SIZE * PIXEL_SCALE;
canvas.height = GRID_SIZE * PIXEL_SCALE;
const ctx = canvas.getContext("2d");

const elevationGrid = createElevationGrid();
const typeGrid = createTypeGrid();

// The WebGL2 heightfield renderer (terrain-renderer-3d.js) needs its own
// canvas - a canvas can only ever hand out one kind of rendering context in
// its lifetime, so it can't share #stage with the 2D top-down renderer.
// `scene3d` stays null (the existing column-extrusion oblique renderer on
// `canvas`/`ctx` keeps working unchanged) on any browser without WebGL2.
// Its backing-store sizing is handled internally by createTerrainScene3D
// (renderer.setPixelRatio/setSize), not set directly here, since Three.js
// owns that relationship between logical size and device pixel ratio.
//
// With WebGL2, BOTH views render through this one scene (Top-down is the
// same terrain from a straight-overhead camera - see terrain-renderer-3d.js),
// which is what makes the two views one consistent art style rather than two
// renderers kept in rough agreement. The canvas renderers on #stage are only
// the fallback for browsers without WebGL2.
const canvas3d = document.getElementById("stage-3d");
const scene3d = isWebGL2Available()
  ? createTerrainScene3D(canvas3d, elevationGrid, typeGrid, GRID_SIZE * CELL_PX)
  : null;
if (scene3d) {
  canvas.classList.add("hidden");
  canvas3d.classList.remove("hidden");
  scene3d.onAsyncChange(() => scene3d.render());
} else {
  loadGrassTexture("/world/assets/textures/grass-cethiel.png");
}

function activeCanvas() {
  return scene3d ? canvas3d : canvas;
}

let currentTool = "raise";
// Doubled from the 128-grid default (5) so the brush covers the same
// physical/screen area now that cells are half the size.
let brushRadius = 10;
// Strength is how far one stroke can move a cell (see brush.js); 4% is a
// gentle, controllable default that a few strokes build into hills.
let brushStrength = 0.04;
let brushHardness = 0;
// Share of cells a material brush paints (1 = solid, as before).
let brushCoverage = 1;
// A modifier held at stroke start swaps the tool for that stroke only:
// Shift inverts (raise <-> lower, deepen <-> shallow), Alt smooths.
let strokeTool = null;

const pendingElevation = new Map();
const pendingTypes = new Map();
let flushHandle = null;
let painting = false;
let lastStampPos = null;

// --- Rendering: batched to one redraw per animation frame, of only the
// cells that actually changed, instead of the previous "redraw the full
// 128x128 grid synchronously on every pointer event" (profiled at ~19ms
// per redraw, and a single 60-step drag triggered 75 of them - over a
// second of blocked input). Input and model updates below stay fully
// synchronous and cheap (plain array writes); only painting to the canvas
// is deferred and coalesced here. ---
let renderScheduled = false;
let dirty = null; // {minX, minY, maxX, maxY} - the union of cells touched since the last paint
// What kind of data changed since the last paint, so a terrain-type stroke
// doesn't rebake the surface or recompute the coastline (both elevation-only).
let dirtyElevation = false;
let dirtyType = false;

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
function render3D(region) {
  const elevationChanged = !region || dirtyElevation;
  const typeChanged = !region || dirtyType || dirtyElevation;
  dirtyElevation = dirtyType = false;
  scene3d.update(elevationGrid, typeGrid, { region, elevationChanged, typeChanged });
  scene3d.render();
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (!dirty) return;
    if (scene3d) {
      const region = dirty;
      dirty = null;
      render3D(region);
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
      renderTerrainOblique(ctx, elevationGrid, typeGrid, PIXEL_SCALE, OBLIQUE_MARGIN * DEVICE_PIXEL_RATIO);
      return;
    }
    // Padded by 1: the coastline stroke has width, so it can cover a
    // sliver of a cell just outside the cells that actually changed.
    const region = { minX: dirty.minX - 1, minY: dirty.minY - 1, maxX: dirty.maxX + 1, maxY: dirty.maxY + 1 };
    dirty = null;
    renderTerrain(ctx, elevationGrid, typeGrid, PIXEL_SCALE, region);
  });
}

function redrawAll() {
  dirty = null;
  if (scene3d) {
    render3D();
    return;
  }
  if (viewMode === "oblique") renderTerrainOblique(ctx, elevationGrid, typeGrid, PIXEL_SCALE, OBLIQUE_MARGIN * DEVICE_PIXEL_RATIO);
  else renderTerrain(ctx, elevationGrid, typeGrid, PIXEL_SCALE);
}

function queueElevation(x, y, elevation) {
  dirtyElevation = true;
  pendingElevation.set(`${x},${y}`, { x, y, elevation });
}

function queueType(x, y, terrain) {
  dirtyType = true;
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

// A 403 means this link lost edit rights (or never had them); stop
// pretending the stroke landed and re-sync from the server.
async function postBatch(path, cells) {
  const res = await fetch(apiPath(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cells }),
  });
  if (res.status === 403) {
    toast("This is a view-only link - changes aren't saved.");
    loadTerrain();
  }
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
      await postBatch("/api/terrain/cells", elevationCells);
    }
    if (typeCells.length > 0) {
      await postBatch("/api/terrain/types", typeCells);
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
// as a soft bump rather than a sharp cone. Hardness widens a solid core.
function forEachBrushCell(cx, cy, apply) {
  const r = brushRadius;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r) continue;
      const falloff = brushFalloff(dist, r, brushHardness);
      if (falloff > 0) apply(x, y, falloff);
    }
  }
}

// Brush falloff with its edge pushed in and out by world-anchored noise, so
// a dab's footprint is an irregular blob and a drag leaves a ragged-edged
// range rather than a tube of perfect circles. The perturbation is a
// function of absolute position (not of the stamp), so overlapping dabs
// agree about where the edge is and build one coherent shape. Only ever
// scales the existing falloff (zero outside the radius stays zero), so the
// brush never reaches farther than its circle shows (the brush-precision
// constraint from task 2).
function mountainFalloff(x, y, falloff) {
  const n = 0.6 * snoise(x * 0.11 + 13.1, y * 0.11 + 5.7) + 0.4 * snoise(x * 0.27 + 2.3, y * 0.27 + 9.1);
  return clamp(falloff * (1 + 0.55 * n) - 0.08 * Math.max(0, -n), 0, 1);
}

function lerpTowards(current, target, t) {
  return current + (target - current) * t;
}

// Weighted 5x5 average (binomial 1-4-6-4-1, a close Gaussian): wide
// enough that Smooth evens out a lumpy slope in a few dabs, where the old
// 3x3 box only shaved single-cell spikes.
const SMOOTH_KERNEL = [1, 4, 6, 4, 1];
function neighborAverage(x, y) {
  let sum = 0;
  let weight = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      const h = elevationGrid[ny * GRID_SIZE + nx];
      // Land smooths against land only, sea against sea: averaging across
      // the coast would drag beaches underwater and seabed up into it.
      if ((h > SEA_LEVEL) !== (elevationGrid[y * GRID_SIZE + x] > SEA_LEVEL)) continue;
      const w = SMOOTH_KERNEL[dx + 2] * SMOOTH_KERNEL[dy + 2];
      sum += h * w;
      weight += w;
    }
  }
  return weight ? sum / weight : elevationGrid[y * GRID_SIZE + x];
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

// The mirror image of setLandElevation, for Deepen/Shallow (ROADMAP.md
// Task 1): sculpts existing sea and must never cross into land by accident,
// the same invariant for the same reason - a cell that's currently land is
// left alone (these tools don't create sea - Paint Sea does), and the
// result is always clamped below SEABED_CEILING, so no amount of shallowing
// can tip it into land. The rendered water *surface* stays flat regardless
// of how deep this makes a cell - see terrain-renderer-3d.js's water plane;
// this only ever changes the seabed, never anything above it.
function setSeabedElevation(x, y, elevation) {
  const index = y * GRID_SIZE + x;
  if (elevationGrid[index] > SEA_LEVEL) return;
  const clamped = clamp(elevation, ELEVATION_MIN, SEABED_CEILING);
  elevationGrid[index] = clamped;
  queueElevation(x, y, clamped);
  markDirty(x, y);
}

// ROADMAP.md task 2: the root cause of "mountains read as narrow spikes with
// a cliff at the edge" was traced to the brush/data layer, not just
// rendering - Mountain/Peak converge every cell in their radius toward the
// same fixed target, so a sustained stroke saturates to a near-uniform
// plateau with a step right where the brush's influence hits zero, and two
// separately-painted features simply meet at whatever step their two target
// elevations happen to leave. This softens exactly that: a per-stamp pass,
// scoped tightly to the stamp's own footprint, that nudges only the pairs of
// adjacent cells that differ by more than a geologically-implausible amount
// - everything within that amount (an intentional steep ridge or peak side)
// is read as deliberate and left untouched.
//
// Deliberately NOT a wider/softer brush falloff: the correction that
// prompted this ("keep the smallest brushes precise - natural falloff must
// not significantly expand the selected brush radius") rules that out, so
// RELAX_PADDING stays a small fixed amount rather than scaling with brush
// size, and the brush's own falloff shape (forEachBrushCell) is untouched.
// 0.15 was steeper than any slope the renderer draws well (a generated
// range's steepest step is under 0.1), so small brushes left visible
// cliff-steps; 0.1 keeps a sharp ridge sharp but rounds those off.
const MAX_NATURAL_SLOPE = 0.1; // max "natural" per-adjacent-cell elevation step before this pass acts
const RELAX_ITERATIONS = 2;
const RELAX_FACTOR = 0.25; // fraction of the excess difference moved between a pair, per iteration
const RELAX_PADDING = 1; // cells beyond the brush radius considered, so a stroke's edge can
// blend with whatever (painted or not) already sits just outside it

// Moves a fraction of the excess (beyond MAX_NATURAL_SLOPE) between one
// adjacent pair of cells. Never touches a pair straddling the coastline
// (one land, one sea) - that boundary is the one intentionally sharp edge
// in this model (only Create Land / Paint Sea may move it, per ADR.md), not
// an artifact for this pass to smooth over. Reuses the same LAND_FLOOR/
// SEABED_CEILING bounds every other land/sea tool already respects, so this
// can never itself push a cell across the coastline either.
function relaxPair(x0, y0, x1, y1) {
  const i0 = y0 * GRID_SIZE + x0;
  const i1 = y1 * GRID_SIZE + x1;
  const h0 = elevationGrid[i0];
  const h1 = elevationGrid[i1];
  const bothLand = h0 > SEA_LEVEL && h1 > SEA_LEVEL;
  const bothSea = h0 <= SEA_LEVEL && h1 <= SEA_LEVEL;
  if (!bothLand && !bothSea) return;
  const diff = h1 - h0;
  const excess = Math.abs(diff) - MAX_NATURAL_SLOPE;
  if (excess <= 0) return;
  const move = Math.sign(diff) * excess * RELAX_FACTOR;
  const floor = bothLand ? LAND_FLOOR : ELEVATION_MIN;
  const ceiling = bothLand ? ELEVATION_MAX : SEABED_CEILING;
  const newH0 = clamp(h0 + move, floor, ceiling);
  const newH1 = clamp(h1 - move, floor, ceiling);
  if (newH0 === h0 && newH1 === h1) return;
  elevationGrid[i0] = newH0;
  elevationGrid[i1] = newH1;
  queueElevation(x0, y0, newH0);
  queueElevation(x1, y1, newH1);
  markDirty(x0, y0);
  markDirty(x1, y1);
}

// Runs the pass above over one stamp's own footprint (+ RELAX_PADDING),
// a handful of bounded iterations - cheap because it's scoped to the brush,
// not the whole grid, the same "local, not global" shape as every other
// per-stamp operation here.
function relaxRegion(cx, cy, radius) {
  const minX = Math.max(0, cx - radius - RELAX_PADDING);
  const maxX = Math.min(GRID_SIZE - 1, cx + radius + RELAX_PADDING);
  const minY = Math.max(0, cy - radius - RELAX_PADDING);
  const maxY = Math.min(GRID_SIZE - 1, cy + radius + RELAX_PADDING);
  for (let iter = 0; iter < RELAX_ITERATIONS; iter++) {
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (x + 1 <= maxX) relaxPair(x, y, x + 1, y);
        if (y + 1 <= maxY) relaxPair(x, y, x, y + 1);
      }
    }
  }
}

// Every tool that can change elevation runs the relaxation pass above after
// painting - terrain-type-only tools (grassland/sand/forest/rock) don't
// touch elevationGrid at all, so they're excluded rather than running a
// pass that would always find nothing to do.
const ELEVATION_TOOLS = new Set(["raise", "lower", "smooth", "level", "mountain", "peak", "land", "sea", "deepen", "shallow"]);

// --- Strokes ------------------------------------------------------------
// One stroke (pointer down to up) remembers, per cell, the elevation it
// started from and the most influence any of its stamps has had there.
// Raise/Lower/Mountain/Peak/Deepen/Shallow then set the cell from that
// start value, rather than adding on every stamp - so a stroke moves a cell
// by at most Strength (x falloff) however long or slowly you drag, and the
// same gesture gives the same result whatever the brush size or mouse
// rate. That compounding was the cause of mountains rising too sharply.
let strokeStart = null; // Map cell index -> elevation before this stroke
let strokeReach = null; // Map cell index -> max falloff reached this stroke
let levelTarget = null; // Level: the height under the first dab
let peakFloor = null; // Peak: the lowest land under the first dab

function beginStroke() {
  strokeStart = new Map();
  strokeReach = new Map();
  levelTarget = null;
  peakFloor = null;
}

function endStroke() {
  strokeStart = strokeReach = levelTarget = peakFloor = null;
}

// The falloff this stamp adds over what the stroke already applied at this
// cell, and the cell's elevation from before the stroke; null if this
// stamp adds nothing new there.
function strokeAt(index, falloff) {
  if (!strokeStart) beginStroke();
  if (!strokeStart.has(index)) strokeStart.set(index, elevationGrid[index]);
  const prev = strokeReach.get(index) ?? 0;
  if (falloff <= prev) return null;
  strokeReach.set(index, falloff);
  return strokeStart.get(index);
}

// Strength is a share of the mountain band, so 100% would lift lowland to
// a summit; the renderer's band is 0.42-0.85 of ELEVATION_MAX.
const STRENGTH_SCALE = 0.9;

function paintAt(cx, cy) {
  const tool = strokeTool ?? currentTool;
  const amount = brushStrength * STRENGTH_SCALE;
  switch (tool) {
    case "raise":
    case "lower": {
      const sign = tool === "raise" ? 1 : -1;
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        const i = y * GRID_SIZE + x;
        const start = strokeAt(i, falloff);
        if (start === null) return;
        // Raising eases in under the summit cap; lowering eases toward the
        // coast floor, so neither ever slams into a hard limit.
        const next = sign > 0 ? softRaise(start, amount * falloff, ELEVATION_MAX) : LAND_FLOOR + (start - LAND_FLOOR) * Math.exp((-amount * falloff) / Math.max(0.05, start - LAND_FLOOR));
        setLandElevation(x, y, next);
      });
      break;
    }
    case "smooth":
      // Repeated dabs keep working (smoothing toward a moving average can't
      // overshoot), so this one stays per-stamp; Strength sets how much of
      // the way each dab goes.
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        const i = y * GRID_SIZE + x;
        const current = elevationGrid[i];
        const t = Math.min(1, 1.5 * Math.sqrt(brushStrength) * falloff);
        const avg = neighborAverage(x, y);
        if (current > SEA_LEVEL) setLandElevation(x, y, lerpTowards(current, avg, t));
        else setSeabedElevation(x, y, lerpTowards(current, avg, t));
      });
      break;
    case "level": {
      // Flatten toward the height under the first dab (Unreal's Flatten,
      // Wonderdraft's Level): terraces, plateaus, a flat valley floor.
      if (levelTarget === null) levelTarget = elevationGrid[cy * GRID_SIZE + cx];
      const target = levelTarget;
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        const i = y * GRID_SIZE + x;
        const current = elevationGrid[i];
        const t = Math.min(1, 2 * Math.sqrt(brushStrength) * falloff);
        if (current > SEA_LEVEL && target > SEA_LEVEL) setLandElevation(x, y, lerpTowards(current, target, t));
        else if (current <= SEA_LEVEL && target <= SEA_LEVEL) setSeabedElevation(x, y, lerpTowards(current, target, t));
      });
      break;
    }
    case "mountain":
    case "peak": {
      // A ragged-edged uplift (mountainFalloff) under a ceiling that falls
      // away from the spine (brush.js mountainRaise), so ranges keep sloping
      // flanks. Peak is the same gesture, higher and tighter (falloff
      // squared), for a dominant summit. Like Raise, one stroke lifts a
      // cell at most once; stroke again to go higher.
      const ceiling = tool === "peak" ? PEAK_CEILING : MOUNTAIN_CEILING;
      const lift = amount * (tool === "peak" ? 2.2 : 1.6);
      // Mountain's flanks bottom out at lowland height. Peak is meant to go
      // on top of a range, so its flanks bottom out at the lowest ground
      // under the brush when the stroke began: its cap is then above the
      // spine at the centre, and still meets the slope at the rim. (With
      // the lowland floor, a Peak dab on a 0.72 spine had a centre cap
      // below 0.72 and did nothing.)
      if (tool === "peak" && peakFloor === null) {
        peakFloor = ceiling;
        forEachBrushCell(cx, cy, (x, y) => {
          const h = elevationGrid[y * GRID_SIZE + x];
          if (h > SEA_LEVEL) peakFloor = Math.min(peakFloor, h);
        });
        peakFloor = Math.max(MOUNTAIN_FLOOR, peakFloor);
      }
      const floor = tool === "peak" ? peakFloor : MOUNTAIN_FLOOR;
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        const i = y * GRID_SIZE + x;
        if (elevationGrid[i] <= SEA_LEVEL) return;
        let f = mountainFalloff(x, y, falloff);
        if (tool === "peak") f *= f;
        const start = strokeAt(i, f);
        if (start === null) return;
        setLandElevation(x, y, mountainRaise(start, f, lift, ceiling, floor));
      });
      break;
    }
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
        setElevation(x, y, lerpTowards(current, SEA_LEVEL - SEA_PUSH, falloff));
      });
      break;
    case "deepen":
    case "shallow": {
      const sign = tool === "deepen" ? -1 : 1;
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        const i = y * GRID_SIZE + x;
        if (elevationGrid[i] > SEA_LEVEL) return;
        const start = strokeAt(i, falloff);
        if (start === null) return;
        setSeabedElevation(x, y, start + sign * amount * falloff);
      });
      break;
    }
    default:
      // One of TERRAIN_TYPES: painting a type only ever touches land - a
      // brush straddling a coastline simply has no effect on its sea half,
      // the same rule the server enforces independently.
      // Coverage below 100% paints clumps rather than every cell, so a
      // Forest stroke can lay down open woodland or scattered stands.
      forEachBrushCell(cx, cy, (x, y, falloff) => {
        if (!isLand(elevationGrid, x, y)) return;
        const n = 0.65 * snoise(x * 0.16 + 41.3, y * 0.16 + 7.9) + 0.35 * snoise(x * 0.45 + 3.1, y * 0.45 + 19.7);
        if (!coverageAccepts(n, brushCoverage, falloff)) return;
        typeGrid[y * GRID_SIZE + x] = TERRAIN_TYPES.indexOf(tool);
        queueType(x, y, tool);
        markDirty(x, y);
      });
      break;
  }
  if (ELEVATION_TOOLS.has(tool)) relaxRegion(cx, cy, brushRadius);
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
  // With per-stroke accumulation (see strokeAt) spacing no longer changes
  // how high a stroke builds, only how evenly it covers, so it can be
  // tighter than the old 0.5 x radius without making strokes stronger.
  return Math.max(0.4, brushRadius * 0.3);
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
  // px/py arrive in the canvas's own backing-store pixel space (see
  // canvasToGrid), which is PIXEL_SCALE per cell now, not CELL_PX - must
  // match whatever renderTerrainOblique was actually called with above.
  const gx = Math.floor(px / PIXEL_SCALE);
  if (gx < 0 || gx >= GRID_SIZE) return { x: -1, y: -1 };
  for (let gy = GRID_SIZE - 1; gy >= 0; gy--) {
    const baseY = gy * PIXEL_SCALE;
    // obliqueRise's result is NOT itself DPR-scaled (OBLIQUE_HEIGHT_SCALE is
    // a fixed constant in terrain-renderer.js, independent of cellPx) -
    // matching renderTerrainOblique's own unscaled call exactly, so picking
    // agrees with whatever was actually drawn. A pre-existing, documented
    // limitation of this WebGL2-less fallback path only (ROADMAP.md task 4):
    // its mountain-rise-to-cell-width proportion isn't DPR-invariant the way
    // the primary WebGL oblique renderer now is.
    const top = baseY - obliqueRise(elevationGrid[gy * GRID_SIZE + gx]);
    if (py >= top && py <= baseY + PIXEL_SCALE) return { x: gx, y: gy };
  }
  return { x: -1, y: -1 };
}

function canvasToGrid(event) {
  const el = activeCanvas();
  const rect = el.getBoundingClientRect();
  const px = ((event.clientX - rect.left) / rect.width) * el.width;
  const py = ((event.clientY - rect.top) / rect.height) * el.height;
  if (scene3d) {
    // The 3D renderer's own ray march against the displayed surface is the
    // single source of truth for picking in BOTH views - Top-down is the
    // same scene from an overhead camera, and once it's wheel-zoomed or
    // panned, dividing by PIXEL_SCALE would paint the wrong cells. See
    // terrain-renderer-3d.js. Its own
    // canvas.width/height already reflect the device pixel ratio (see
    // createTerrainScene3D), and px/py above are already computed in that
    // same backing-store space via the el.width/el.height ratio, so no
    // extra scaling is needed here.
    const hit = scene3d.pick(px, py);
    return hit ?? { x: -1, y: -1 };
  }
  if (viewMode === "oblique") return obliqueScreenToGrid(px, py - OBLIQUE_MARGIN * DEVICE_PIXEL_RATIO);
  return { x: Math.floor(px / PIXEL_SCALE), y: Math.floor(py / PIXEL_SCALE) };
}

// -1,-1 means the pointer isn't over any drawn terrain column at all - only
// reachable in the oblique view, by pointing at empty space above every
// column within that screen x (e.g. the sky above a low-lying map). Just
// doesn't paint, the same way clicking outside the canvas entirely already
// does nothing.
function isOffTerrain(pos) {
  return pos.x < 0 || pos.y < 0;
}

const INVERSE_TOOL = { raise: "lower", lower: "raise", deepen: "shallow", shallow: "deepen", land: "sea", sea: "land" };

// Shift inverts the current tool for this stroke, Alt smooths (the Unreal
// / World Machine / Gaea convention), so shaping a slope doesn't mean
// trips back to the tool panel.
function strokeToolFor(event) {
  if (event.altKey && ELEVATION_TOOLS.has(currentTool)) return "smooth";
  if (event.shiftKey && INVERSE_TOOL[currentTool]) return INVERSE_TOOL[currentTool];
  return null;
}

function handlePointerDown(event) {
  // View-only: left-drag does nothing (the server would refuse it anyway);
  // pan and zoom are wired separately and still work.
  if (!room.canEdit || event.button !== 0) return;
  painting = true;
  beginStroke();
  strokeTool = strokeToolFor(event);
  scene3d?.setStrokeActive(true);
  event.currentTarget.setPointerCapture(event.pointerId);
  const pos = canvasToGrid(event);
  // lastStampPos is fractional (the exact point stampAlong last walked to),
  // not the integer cell paintAt was actually called with - see stampAlong.
  lastStampPos = isOffTerrain(pos) ? null : pos;
  if (!isOffTerrain(pos)) paintAt(pos.x, pos.y);
}

function handlePointerMove(event) {
  if (!painting) return;
  // A pointerup lost to alt-tab or a system dialog: end the stroke instead
  // of painting on hover and leaving coast/tree rebuilds deferred forever.
  if (event.buttons === 0) return stopPainting();
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
  endStroke();
  strokeTool = null;
  scene3d?.setStrokeActive(false);
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
  el.addEventListener("lostpointercapture", stopPainting);
  el.addEventListener("contextmenu", (event) => event.preventDefault());
}

function wireToolbar() {
  // One shared "active" tool across all three category panels (`data-tool`
  // buttons live in all of them, but only one panel is visible at a time -
  // see wireCategoryRail) - clearing every button's `.active` class, not
  // just the clicked button's own panel, so switching categories can never
  // leave a stale active button highlighted in a panel that's about to be
  // hidden.
  const buttons = document.querySelectorAll("[data-tool]");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      for (const other of buttons) other.classList.remove("active");
      button.classList.add("active");
      currentTool = button.dataset.tool;
    });
  }

  const sizeInput = document.getElementById("brush-size");
  const sizeOut = document.getElementById("brush-size-out");
  const setSize = (v) => {
    brushRadius = clamp(Math.round(v), Number(sizeInput.min), Number(sizeInput.max));
    sizeInput.value = String(brushRadius);
    sizeOut.textContent = String(brushRadius);
  };
  sizeInput.addEventListener("input", () => setSize(Number(sizeInput.value)));

  // The slider is a position on brush.js's perceptual curve, not a raw
  // amount: each step is the same ratio, from 0.5% to 50%.
  const strengthInput = document.getElementById("brush-strength");
  const strengthOut = document.getElementById("brush-strength-out");
  const setStrengthStep = (v) => {
    const step = clamp(Math.round(v), 0, 100);
    strengthInput.value = String(step);
    brushStrength = strengthFromSlider(step);
    strengthOut.textContent = formatStrength(brushStrength);
  };
  strengthInput.addEventListener("input", () => setStrengthStep(Number(strengthInput.value)));
  setStrengthStep(sliderFromStrength(brushStrength));

  const hardnessInput = document.getElementById("brush-hardness");
  const hardnessOut = document.getElementById("brush-hardness-out");
  hardnessInput.addEventListener("input", () => {
    brushHardness = Number(hardnessInput.value);
    hardnessOut.textContent = brushHardness === 0 ? "Soft" : `${Math.round(brushHardness * 100)}%`;
  });

  const coverageInput = document.getElementById("brush-coverage");
  const coverageOut = document.getElementById("brush-coverage-out");
  coverageInput.addEventListener("input", () => {
    brushCoverage = Number(coverageInput.value);
    coverageOut.textContent = brushCoverage >= 1 ? "Solid" : `${Math.round(brushCoverage * 100)}%`;
  });

  // [ ] size, - = strength: the shortcuts Photoshop, Krita and most map
  // tools share. Ignored while typing in a field or with a dialog open.
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) && target.type !== "range") return;
    if (document.querySelector("dialog[open]")) return;
    const big = event.shiftKey ? 5 : 1;
    if (event.key === "[" || event.key === "{") setSize(brushRadius - big);
    else if (event.key === "]" || event.key === "}") setSize(brushRadius + big);
    else if (event.key === "-" || event.key === "_") setStrengthStep(Number(strengthInput.value) - 5 * big);
    else if (event.key === "=" || event.key === "+") setStrengthStep(Number(strengthInput.value) + 5 * big);
    else return;
    event.preventDefault();
  });

  document.getElementById("undo-button").addEventListener("click", undoLastStroke);
  document.getElementById("rail-undo").addEventListener("click", undoLastStroke);
}

// PROTOTYPE (final-redesign-prototype branch, UI/UX redesign): the left
// icon rail picks which category's <section> is visible in the right
// options panel (Wonderdraft/Inkarnate-style category tabs + tool-options
// panel, replacing the old single flat toolbar of every tool at once - see
// CLAUDE.md's named visual bar and CREDITS.md). Switching category also
// selects that category's first tool as the active one, so the current
// brush is always one of the tools actually visible on screen - without
// this, switching to "Terrain" while "Raise" was still the active tool
// would leave the user painting an invisible, unselected tool with no
// feedback as to which panel it belongs to.
const CATEGORY_FIRST_TOOL = {
  land: "raise",
  terrain: "grassland",
  water: "land",
};

// Each category's tools behave differently enough (land tools only ever
// reshape height, terrain tools only ever repaint material at whatever
// height is already there, water tools are the only ones that can turn
// land into sea or back) that one hint sentence can't honestly describe
// all three - the old copy was land/water-specific but stayed on screen
// unchanged while Terrain was selected, describing tools that weren't
// even visible.
const CATEGORY_HINT = {
  land: "One stroke moves the land by at most Strength - stroke again to build higher. Shift lowers, Alt smooths. [ ] size, - = strength.",
  terrain: "Paint grassland, sand, forest or rock onto land. Lower Coverage for open woods and scattered stands.",
  water: "Create land and Paint sea move the coastline. Deepen and Shallow shape the seabed.",
};

function wireCategoryRail() {
  const railButtons = document.querySelectorAll("[data-category]");
  const sections = document.querySelectorAll("[data-panel]");
  const toolButtons = document.querySelectorAll("[data-tool]");
  const categoryHint = document.getElementById("category-hint");
  for (const railButton of railButtons) {
    railButton.addEventListener("click", () => {
      const category = railButton.dataset.category;
      for (const other of railButtons) other.classList.remove("active");
      railButton.classList.add("active");
      for (const section of sections) section.classList.toggle("hidden", section.dataset.panel !== category);
      currentTool = CATEGORY_FIRST_TOOL[category];
      for (const toolButton of toolButtons) {
        toolButton.classList.toggle("active", toolButton.dataset.tool === currentTool);
      }
      categoryHint.textContent = CATEGORY_HINT[category];
      // Coverage only means something for material brushes; Hardness only
      // for height brushes.
      document.getElementById("coverage-row").classList.toggle("hidden", category !== "terrain");
      document.getElementById("hardness-row").classList.toggle("hidden", category === "terrain");
    });
  }
}

// Server-checked by construction (src/undo.ts): the server restores whatever
// it snapshotted for *this request's own session cookie*, so there is no
// field here to set that could undo someone else's stroke. Flushes any
// still-pending local edits first - otherwise "undo" could race a paint that
// hasn't even reached the server yet, undoing a stale snapshot instead of
// what the user actually just drew.
async function undoLastStroke() {
  if (flushHandle) clearTimeout(flushHandle);
  flushHandle = null;
  await flush();
  const res = await fetch(apiPath("/api/terrain/undo"), { method: "POST" });
  if (!res.ok) return; // 409 "nothing to undo" - nothing to show for it locally
  // The server already broadcasts the restored cells over SSE, which this
  // same tab also receives - rather than apply the change twice (once from
  // the fetch, once from our own echoed broadcast), just let loadTerrain's
  // connectEvents path pick it up the normal way, same as any other
  // client's edit would arrive here.
}

function wireViewToggle() {
  const buttons = document.querySelectorAll("[data-view]");
  const cameraToolbar = document.getElementById("camera-toolbar");
  const cameraHint = document.getElementById("camera-hint");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const mode = button.dataset.view;
      if (mode === viewMode) return;
      viewMode = mode;
      for (const other of buttons) other.classList.remove("active");
      button.classList.add("active");
      // With WebGL2 both views are the same 3D scene - switching just swaps
      // its camera; the camera panel (rotation/tilt) only means anything in
      // Oblique, but wheel zoom/pan works in both.
      if (scene3d) {
        scene3d.setMode(viewMode);
        // Zoom, pan and reset apply to both views (Top-down is zoomable
        // too); only the compass and tilt are Oblique-specific.
        cameraToolbar.classList.toggle("top-mode", viewMode === "top");
        syncCameraUI();
        scene3d.render();
        return;
      }
      const show3D = false;
      // The canvas-COLUMN fallback (no WebGL2) is the only mode that ever
      // reuses #stage itself for Oblique - distinct from `show3D`, which is
      // about which <canvas> ELEMENT is visible. Only this path needs the
      // extra-height/non-square treatment below; ordinary top-down (with or
      // without a scene3d) and the WebGL2 Oblique scene3d path (on
      // #stage-3d, sized independently by createTerrainScene3D) both just
      // use world.css's own responsive `aspect-ratio: 1/1` box unmodified.
      const obliqueFallback = viewMode === "oblique" && !scene3d;
      canvas3d.classList.toggle("hidden", !show3D);
      canvas.classList.toggle("hidden", show3D);
      cameraToolbar.classList.toggle("hidden", !show3D);
      cameraHint.classList.toggle("hidden", !show3D);
      if (obliqueFallback) {
        // Needs extra canvas height so a peak near row 0 has room to rise
        // into without being clipped (see OBLIQUE_MARGIN); top-down doesn't,
        // so this only grows the canvas when switching in, not permanently.
        // world.css's `aspect-ratio: 1/1` on #stage (the responsive-canvas
        // redesign) would otherwise force this taller backing store back to
        // square - overriding both width and height inline (clearing the
        // aspect-ratio's effect by giving the browser an explicit size to
        // use instead) keeps a 1:1 pixel mapping (and canvasToGrid's px/py
        // math correct). The backing-store attributes (canvas.width/height)
        // are in PIXEL_SCALE units (device-pixel-ratio aware, Task 4); the
        // CSS override must stay in logical/CELL_PX units, or the display
        // box itself would grow with the device pixel ratio instead of just
        // the resolution behind it.
        canvas.width = GRID_SIZE * PIXEL_SCALE;
        canvas.height = GRID_SIZE * PIXEL_SCALE + OBLIQUE_MARGIN * DEVICE_PIXEL_RATIO;
        canvas.style.aspectRatio = "auto";
        canvas.style.width = `${GRID_SIZE * CELL_PX}px`;
        canvas.style.height = `${GRID_SIZE * CELL_PX + OBLIQUE_MARGIN}px`;
      } else if (!show3D) {
        // Plain top-down: undo any inline override the fallback branch made
        // last time it ran, so #stage goes back to world.css's own
        // responsive aspect-ratio/height rules rather than staying pinned
        // at a stale fixed size from a previous Oblique-fallback visit.
        canvas.width = GRID_SIZE * PIXEL_SCALE;
        canvas.height = GRID_SIZE * PIXEL_SCALE;
        canvas.style.aspectRatio = "";
        canvas.style.width = "";
        canvas.style.height = "";
      }
      redrawAll();
    });
  }
}

// ROADMAP.md task 3 (camera controls), revisited: wires the compass dial,
// direction-preset shortcuts, tilt/zoom sliders, pan trackpad, wheel-zoom
// and fit-view controls to the 3D renderer's camera. Every handler here
// calls `renderOnce()` directly rather than going through
// `scheduleRender()`/`markDirty()` - a camera move isn't a terrain edit, so
// it has nothing to do with the dirty-rect tracking those use, and a UI
// click/drag is already a single discrete event with no need for
// rAF-batching the way a flood of pointermove events does.
//
// Every new drag surface here (the compass dial, the pan trackpad) lives in
// `#camera-toolbar`, never on `#stage-3d` itself - the canvas's own
// pointerdown/pointermove/pointerup listeners (above) are already fully
// committed to painting, and keeping the new gestures on physically
// separate elements means they can never be confused with a paint stroke,
// by construction rather than by button/key-modifier convention. Only wheel
// events are attached to the canvas (zoom has no existing canvas gesture to
// conflict with - painting is pointer-drag-based, not wheel-based).
let syncCameraUI = () => {};

function wireCameraControls() {
  if (!scene3d) {
    // No WebGL2: nothing drives these controls, so don't show them.
    document.getElementById("camera-toolbar").classList.add("hidden");
    document.getElementById("camera-hint").classList.add("hidden");
    return;
  }

  function renderOnce() {
    scene3d.render();
  }

  function angularDiff(a, b) {
    return Math.abs((((a - b + 540) % 360) + 360) % 360 - 180);
  }

  const zoomInput = document.getElementById("camera-zoom");
  const tiltInput = document.getElementById("camera-tilt");
  const compass = document.getElementById("camera-compass");
  const needleGroup = document.getElementById("compass-needle-group");
  const presetButtons = document.querySelectorAll("[data-azimuth-preset]");
  const PRESET_MATCH_EPS_DEG = 0.5; // a free drag rarely lands exactly on a preset

  // The dial's own visual angle (clockwise from N/top, matching the SVG's
  // N/E/S/W label positions) is a different convention from azimuthDeg
  // itself (which tracks the camera's own position in world space, not
  // which way it's facing) - this converts between them. Derived directly
  // from the camera-position formula in terrain-renderer-3d.js
  // (`position = center + horizontal*(sin(angleRad), _, cos(angleRad))`,
  // with +X = east and +Z = south): the view direction (opposite the
  // camera's own position from center) works out to bearing-from-north
  // `(360 - azimuthDeg) mod 360`, which both conversions below share since
  // the map is self-inverse mod 360. Verified against all four presets:
  // azimuthDeg 0 (S->N, looking north) maps to dial angle 0 (needle at N);
  // 90 (E->W, looking west) to 270 (needle at W); 180 (N->S, looking south)
  // to 180 (needle at S); 270 (W->E, looking east) to 90 (needle at E) -
  // the needle always points the way the camera is actually looking, the
  // intuitive reading of "which way is this compass facing".
  function azimuthToDialDeg(azimuthDeg) {
    return (360 - ((azimuthDeg % 360) + 360) % 360) % 360;
  }
  function dialDegToAzimuth(dialDeg) {
    return azimuthToDialDeg(dialDeg);
  }

  function syncZoomSlider() {
    zoomInput.value = String(scene3d.getCameraState().zoom);
  }

  function syncCompass() {
    const state = scene3d.getCameraState();
    needleGroup.setAttribute("transform", `rotate(${azimuthToDialDeg(state.azimuthDeg)} 50 50)`);
    for (const button of presetButtons) {
      const preset = state.azimuthPresets[Number(button.dataset.azimuthPreset)];
      button.classList.toggle("active", angularDiff(preset.angleDeg, state.azimuthDeg) < PRESET_MATCH_EPS_DEG);
    }
  }

  for (const button of presetButtons) {
    button.addEventListener("click", () => {
      scene3d.setAzimuthPreset(Number(button.dataset.azimuthPreset));
      syncCompass();
      renderOnce();
    });
  }

  // Dragging the compass dial: continuous 360 deg rotation read directly
  // from the pointer's own angle around the dial's centre, not a discrete
  // set of steps - and never resets tilt/zoom/pan, since setAzimuth only
  // ever calls applyCameraState() (see terrain-renderer-3d.js; this is the
  // explicit "preserve each other's state" requirement for this revisit).
  let compassDragging = false;
  function dialDegFromPointer(event) {
    const rect = compass.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    return (((Math.atan2(dx, -dy) * 180) / Math.PI) + 360) % 360;
  }
  function rotateToPointer(event) {
    scene3d.setAzimuth(dialDegToAzimuth(dialDegFromPointer(event)));
    syncCompass();
    renderOnce();
  }
  compass.addEventListener("pointerdown", (event) => {
    compassDragging = true;
    compass.setPointerCapture(event.pointerId);
    rotateToPointer(event);
  });
  compass.addEventListener("pointermove", (event) => {
    if (compassDragging) rotateToPointer(event);
  });
  function stopCompassDrag() {
    compassDragging = false;
  }
  compass.addEventListener("pointerup", stopCompassDrag);
  compass.addEventListener("pointercancel", stopCompassDrag);

  tiltInput.addEventListener("input", () => {
    scene3d.setTilt(Number(tiltInput.value));
    renderOnce();
  });

  zoomInput.addEventListener("input", () => {
    scene3d.setZoom(Number(zoomInput.value));
    renderOnce();
  });

  // Trackpad-style panning (replaces the old fixed-step pan-pad buttons):
  // each pointermove's own screen-pixel delta maps directly to a fraction
  // of the trackpad's own size, so a small drag is a small, exact move -
  // precise at any zoom level (panBy's own step already scales by the
  // current view size/zoom), not a fixed-speed nudge per click. Sign
  // convention makes the rendered scene follow the drag directly (the
  // direct-manipulation feel the trackpad metaphor implies): moving the
  // camera+look-at-centre together along its own screen-right axis shifts
  // the *content* the opposite way on screen (right => content left),
  // hence the negated X term below; moving along its own screen-up axis
  // shifts content the opposite way too (up => content down), which for Y
  // already matches "drag down (positive dyFrac) => content follows,
  // moving down" with no extra negation needed.
  const trackpad = document.getElementById("camera-pan-trackpad");
  let trackpadDragging = false;
  let lastTrackpadX = 0;
  let lastTrackpadY = 0;
  trackpad.addEventListener("pointerdown", (event) => {
    trackpadDragging = true;
    lastTrackpadX = event.clientX;
    lastTrackpadY = event.clientY;
    trackpad.setPointerCapture(event.pointerId);
  });
  trackpad.addEventListener("pointermove", (event) => {
    if (!trackpadDragging) return;
    const rect = trackpad.getBoundingClientRect();
    const dxFrac = (event.clientX - lastTrackpadX) / rect.width;
    const dyFrac = (event.clientY - lastTrackpadY) / rect.height;
    lastTrackpadX = event.clientX;
    lastTrackpadY = event.clientY;
    scene3d.panBy(-dxFrac, dyFrac);
    renderOnce();
  });
  function stopTrackpadDrag() {
    trackpadDragging = false;
  }
  trackpad.addEventListener("pointerup", stopTrackpadDrag);
  trackpad.addEventListener("pointercancel", stopTrackpadDrag);

  // Cursor-centred wheel zoom: only wired to the 3D canvas (the painting
  // pointer handlers above are unaffected - wheel is a separate event type
  // they never listen for), and only acts while Oblique is actually the
  // visible view, the same guard renderOnce() uses, so a wheel scroll over
  // a hidden canvas can never silently move a camera the user can't see.
  canvas3d.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = canvas3d.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * canvas3d.width;
      const py = ((event.clientY - rect.top) / rect.height) * canvas3d.height;
      const ndcX = (px / canvas3d.width) * 2 - 1;
      const ndcY = -(py / canvas3d.height) * 2 + 1;
      // Exponential so a steady scroll feels like a steady zoom *rate*
      // (each wheel notch multiplies, rather than adds to, the zoom level) -
      // the standard feel for scroll-to-zoom, and symmetric between
      // zooming in and back out by the same notch count.
      const factor = Math.exp(-event.deltaY * 0.0015);
      scene3d.zoomAtCursor(factor, ndcX, ndcY);
      syncZoomSlider();
      renderOnce();
    },
    { passive: false },
  );

  document.getElementById("camera-fit").addEventListener("click", () => {
    scene3d.fitView();
    syncZoomSlider();
    syncCompass();
    renderOnce();
  });

  syncCameraUI = () => {
    syncCompass();
    syncZoomSlider();
    tiltInput.value = String(scene3d.getCameraState().tiltDeg);
  };
  syncCompass();
  document.getElementById("camera-toolbar").classList.toggle("top-mode", viewMode === "top");

  // Middle- or right-button drag pans in either view (left drag paints).
  // Kept on the canvas because Top-down has no camera panel at all, and a
  // zoomed-in Top-down view with no way to pan would be unusable.
  let panDrag = null;
  // View-only visitors have nothing to paint, so a plain left-drag (or a
  // one-finger drag on a phone) pans too.
  canvas3d.addEventListener("pointerdown", (event) => {
    const pans = event.button === 1 || event.button === 2 || (!room.canEdit && event.button === 0);
    if (!pans) return;
    event.stopImmediatePropagation();
    panDrag = { x: event.clientX, y: event.clientY };
    canvas3d.setPointerCapture(event.pointerId);
  }, true);
  canvas3d.addEventListener("pointermove", (event) => {
    if (!panDrag) return;
    event.stopImmediatePropagation();
    const rect = canvas3d.getBoundingClientRect();
    scene3d.panBy(-(event.clientX - panDrag.x) / rect.width, (event.clientY - panDrag.y) / rect.height);
    panDrag = { x: event.clientX, y: event.clientY };
    renderOnce();
  }, true);
  const endPan = (event) => {
    if (!panDrag) return;
    event.stopImmediatePropagation();
    panDrag = null;
  };
  canvas3d.addEventListener("pointerup", endPan, true);
  canvas3d.addEventListener("pointercancel", endPan, true);
}

async function loadTerrain() {
  const [elevationRes, typesRes] = await Promise.all([
    fetch(apiPath("/api/terrain")),
    fetch(apiPath("/api/terrain-types")),
  ]);
  setElevationFromList(elevationGrid, await elevationRes.json());
  setTypesFromList(typeGrid, await typesRes.json());
  // The snapshot can predate local edits still waiting to flush (e.g. an
  // SSE reconnect mid-stroke) - re-apply them so they don't snap back.
  applyElevationCells(elevationGrid, [...pendingElevation.values()]);
  applyTypeCells(typeGrid, [...pendingTypes.values()]);
  dirtyElevation = dirtyType = true;
  // The 3D scene auto-fit once already at construction time, against the
  // locally-created blank starting grid (before this real data arrived) -
  // redone here so the first Oblique view is framed for the actual loaded
  // terrain, not an empty map.
  if (scene3d) {
    scene3d.fitAll();
    syncCameraUI();
  }
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
  const source = new EventSource(apiPath("/api/events"));
  wireRoomEvents(source);
  // A restore replaced the whole map: fetch it again, as on reconnect.
  wireHistoryEvents(source, loadTerrain);
  // Fires on the first connect AND on every automatic reconnect after a
  // drop, so a client that missed events while disconnected always
  // recovers by re-fetching the authoritative state, rather than trusting
  // the stream to have replayed what it missed.
  source.addEventListener("open", loadTerrain);
  source.addEventListener("terrain:update", (event) => {
    const { cells } = JSON.parse(event.data);
    const toApply = withoutPendingOverrides(cells, pendingElevation);
    applyElevationCells(elevationGrid, toApply);
    if (toApply.length) dirtyElevation = true;
    for (const { x, y } of toApply) markDirty(x, y);
    scheduleRender();
  });
  source.addEventListener("terrain-type:update", (event) => {
    const { cells } = JSON.parse(event.data);
    const toApply = withoutPendingOverrides(cells, pendingTypes);
    applyTypeCells(typeGrid, toApply);
    if (toApply.length) dirtyType = true;
    for (const { x, y } of toApply) markDirty(x, y);
    scheduleRender();
  });
  source.addEventListener("terrain-type:clear", (event) => {
    const { cells } = JSON.parse(event.data);
    const toApply = withoutPendingOverrides(cells, pendingTypes);
    clearTypeCells(typeGrid, toApply);
    if (toApply.length) dirtyType = true;
    for (const { x, y } of toApply) markDirty(x, y);
    scheduleRender();
  });
}

wireToolbar();
wireCategoryRail();
wireViewToggle();
wireCameraControls();
wireRoomUi();
wireHistory();
loadMe();
if (await loadRoom()) {
  showHistoryEntry();
  openShareIfRequested();
  loadTerrain();
  connectEvents();
}
