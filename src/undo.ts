import {
  applyCells,
  applyTerrainTypes,
  clearTerrainTypes,
  elevationsFor,
  terrainTypesFor,
  type TerrainCell,
  type TerrainType,
  type TerrainTypeCell,
} from "./terrain.ts";
import { createObject, deleteObject, getObject, updateObject, type MapObject } from "./objects.ts";

// Undo, per person and per map. Terrain cells and places stay the shared,
// ownerless canvas ADR.md decided on: anyone with the edit link may change
// anything. What undo adds is a permission that needs a server-side check:
// "undo *my own* last change." A session can only undo entries kept under
// its own session id - the key is the caller's cookie-derived sessionId
// (src/session.ts), never a client-supplied id, so there is no request shape
// that reaches another person's history.
//
// Multi-level (up to UNDO_DEPTH steps), and covering both terrain strokes
// and places. Kept in memory: a server restart loses pending undos, an
// accepted and named limit. Versions (src/versions.ts) are the durable way
// back; the activity log records what happened either way.
//
// Collaboration rule: undo never overwrites someone else's newer work. Each
// entry remembers what this person's change *left* in every cell or place
// (the "after"); undo only restores those still holding that value. Cells a
// collaborator has since repainted, or a place they have since moved, are
// left alone and reported as skipped.

export const UNDO_DEPTH = 30;

type TypeValue = TerrainType | null;
interface CellState {
  x: number;
  y: number;
  elevation: number;
  terrain: TypeValue;
}

interface StrokeEntry {
  kind: "stroke";
  strokeId: string;
  before: Map<string, CellState>; // first reading per cell this stroke
  after: Map<string, CellState>; // last value this stroke wrote per cell
}
interface PlaceEntry {
  kind: "place";
  before: MapObject | null; // null: the change created it
  after: MapObject | null; // null: the change removed it
}
type Entry = StrokeEntry | PlaceEntry;

const histories = new Map<string, Entry[]>();
const keyFor = (roomId: string, sessionId: string) => `${roomId}\u0000${sessionId}`;

function history(roomId: string, sessionId: string): Entry[] {
  const key = keyFor(roomId, sessionId);
  let list = histories.get(key);
  if (!list) histories.set(key, (list = []));
  return list;
}

function push(list: Entry[], entry: Entry) {
  list.push(entry);
  if (list.length > UNDO_DEPTH) list.shift();
}

// Called right before a terrain write lands. `strokeId` comes from the
// client and names one gesture (pointer down to up); every batch of that
// gesture - elevation and type POSTs alike, however long the pause between
// them - joins one entry. It only groups this session's own writes, so it
// grants nothing. A missing id (an older client) falls back to one entry
// per request.
export function captureStroke(
  roomId: string,
  sessionId: string,
  strokeId: string | undefined,
  elevationCells: TerrainCell[],
  typeCells: TerrainTypeCell[],
): void {
  const list = history(roomId, sessionId);
  const top = list.at(-1);
  let entry: StrokeEntry;
  if (strokeId && top?.kind === "stroke" && top.strokeId === strokeId) entry = top;
  else {
    entry = { kind: "stroke", strokeId: strokeId ?? `req-${Date.now()}-${Math.random()}`, before: new Map(), after: new Map() };
    push(list, entry);
  }

  const touched = new Map<string, { x: number; y: number }>();
  for (const c of elevationCells) touched.set(`${c.x},${c.y}`, c);
  for (const c of typeCells) touched.set(`${c.x},${c.y}`, c);
  // A cell touched twice in one stroke keeps its value from before the
  // stroke started, not from between its own two dabs.
  const fresh = [...touched.values()].filter((c) => !entry.before.has(`${c.x},${c.y}`));
  if (fresh.length > 0) {
    const elev = elevationsFor(roomId, fresh);
    const types = terrainTypesFor(roomId, fresh);
    fresh.forEach((c, i) => entry.before.set(`${c.x},${c.y}`, { x: c.x, y: c.y, elevation: elev[i].elevation, terrain: types[i].terrain }));
  }
}

// Called right after the write, to record what it left behind. Read back
// from the database rather than taken from the request, so side effects
// (a cell pushed under the sea loses its type) are part of the "after".
export function recordStrokeResult(roomId: string, sessionId: string, strokeId: string | undefined, cells: { x: number; y: number }[]): void {
  const top = history(roomId, sessionId).at(-1);
  if (top?.kind !== "stroke" || (strokeId && top.strokeId !== strokeId)) return;
  const elev = elevationsFor(roomId, cells);
  const types = terrainTypesFor(roomId, cells);
  cells.forEach((c, i) => top.after.set(`${c.x},${c.y}`, { x: c.x, y: c.y, elevation: elev[i].elevation, terrain: types[i].terrain }));
}

export function recordPlaceChange(roomId: string, sessionId: string, before: MapObject | null, after: MapObject | null): void {
  push(history(roomId, sessionId), { kind: "place", before, after });
}

export function undoDepth(roomId: string, sessionId: string): number {
  return histories.get(keyFor(roomId, sessionId))?.length ?? 0;
}

// A version restore replaces the whole map, so every pending undo in that
// room would point at cells and places that no longer exist as recorded.
export function forgetRoom(roomId: string): void {
  for (const key of histories.keys()) if (key.startsWith(`${roomId}\u0000`)) histories.delete(key);
}

export type UndoResult =
  | {
      ok: true;
      what: "stroke";
      elevationCells: TerrainCell[];
      restoredTypeCells: TerrainTypeCell[];
      clearedTypeCells: { x: number; y: number }[];
      skipped: number;
      remaining: number;
    }
  | { ok: true; what: "place"; upserted: MapObject | null; deletedId: number | null; skipped: number; remaining: number }
  | { ok: false; reason: "nothing-to-undo" };

const sameObject = (a: MapObject | undefined, b: MapObject) =>
  !!a && a.x === b.x && a.y === b.y && a.rotation === b.rotation && a.scale === b.scale && a.kind === b.kind;

// Pops this session's most recent change and reverses it, skipping whatever
// a collaborator has changed since. Returns what changed, so the caller can
// broadcast it exactly like a live edit.
export function undoLast(roomId: string, sessionId: string): UndoResult {
  const list = histories.get(keyFor(roomId, sessionId));
  const entry = list?.pop();
  if (!list || !entry) return { ok: false, reason: "nothing-to-undo" };
  const remaining = list.length;

  if (entry.kind === "place") return undoPlace(roomId, sessionId, entry, remaining);

  const cells = [...entry.after.values()];
  const nowElev = elevationsFor(roomId, cells);
  const nowTypes = terrainTypesFor(roomId, cells);
  const elevationCells: TerrainCell[] = [];
  const typeTargets: { x: number; y: number; terrain: TypeValue }[] = [];
  let skipped = 0;
  cells.forEach((after, i) => {
    const before = entry.before.get(`${after.x},${after.y}`);
    if (!before) return;
    // Someone else's paint since: leave the cell as they left it.
    if (nowElev[i].elevation !== after.elevation || nowTypes[i].terrain !== after.terrain) {
      skipped++;
      return;
    }
    if (before.elevation !== after.elevation) elevationCells.push({ x: before.x, y: before.y, elevation: before.elevation });
    if (before.terrain !== after.terrain) typeTargets.push({ x: before.x, y: before.y, terrain: before.terrain });
  });

  if (elevationCells.length > 0) applyCells(roomId, elevationCells);
  const restoredTypeCells = typeTargets.filter((c): c is TerrainTypeCell => c.terrain !== null);
  const clearedTypeCells = typeTargets.filter((c) => c.terrain === null).map(({ x, y }) => ({ x, y }));
  if (restoredTypeCells.length > 0) applyTerrainTypes(roomId, restoredTypeCells);
  if (clearedTypeCells.length > 0) clearTerrainTypes(roomId, clearedTypeCells);
  return { ok: true, what: "stroke", elevationCells, restoredTypeCells, clearedTypeCells, skipped, remaining };
}

function undoPlace(roomId: string, sessionId: string, entry: PlaceEntry, remaining: number): UndoResult {
  const { before, after } = entry;
  const current = after ? getObject(roomId, after.id) : undefined;
  if (after && !sameObject(current, after)) {
    // Moved, turned or removed by someone else since: theirs stands.
    return { ok: true, what: "place", upserted: null, deletedId: null, skipped: 1, remaining };
  }
  if (!before) {
    // Undo a placement: remove it.
    deleteObject(roomId, after!.id);
    return { ok: true, what: "place", upserted: null, deletedId: after!.id, skipped: 0, remaining };
  }
  if (!after) {
    // Undo a removal: put it back (as a new row; ids aren't reused).
    const res = createObject(roomId, sessionId, before);
    if (!res.ok) return { ok: true, what: "place", upserted: null, deletedId: null, skipped: 1, remaining };
    // Any older entry of this person's that names the removed id now means
    // the restored one, so undoing further back still works.
    for (const e of histories.get(keyFor(roomId, sessionId)) ?? []) {
      if (e.kind !== "place") continue;
      if (e.before?.id === before.id) e.before = { ...e.before, id: res.object.id };
      if (e.after?.id === before.id) e.after = { ...e.after, id: res.object.id };
    }
    return { ok: true, what: "place", upserted: res.object, deletedId: null, skipped: 0, remaining };
  }
  const res = updateObject(roomId, after.id, { x: before.x, y: before.y, rotation: before.rotation, scale: before.scale });
  return res.ok
    ? { ok: true, what: "place", upserted: res.object, deletedId: null, skipped: 0, remaining }
    : { ok: true, what: "place", upserted: null, deletedId: null, skipped: 1, remaining };
}
