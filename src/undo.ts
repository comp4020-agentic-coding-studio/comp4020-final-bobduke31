import {
  applyCells,
  applyTerrainTypes,
  clearTerrainTypes,
  elevationsFor,
  terrainTypesFor,
  type TerrainCell,
  type TerrainTypeCell,
} from "./terrain.ts";

// C10's server-side permission requirement, applied to this app: terrain
// cells stay the shared, ownerless canvas ADR.md already decided on (anyone
// may paint any cell - that decision isn't revisited here). What's new is a
// permission that genuinely needs a server-side check: "undo *my own* last
// stroke." A session can only ever undo the snapshot keyed under its own
// session id - there is no request shape that lets session A address
// session B's stroke, because the key is the caller's own cookie-derived
// sessionId (src/session.ts), never a client-supplied id. That's the check,
// and it's structural rather than an `if` a developer could forget: there is
// no code path from an incoming request to any other session's entry in
// this map.
//
// In-memory and single-level, by design: this is "undo my last click," not
// a version history (that's ROADMAP.md task 10's job, a real persisted
// feature). A server restart losing pending undos is an acceptable, named
// limitation for that scope - the durable record of what happened either
// way is the activity log (src/activity.ts), which is unaffected by this.
interface StrokeSnapshot {
  elevationBefore: Map<string, TerrainCell>;
  typesBefore: Map<string, { x: number; y: number; terrain: TerrainTypeCell["terrain"] | null }>;
  capturedAt: number;
}

// Keyed by room *and* session: undo in one map must never reach into a
// stroke the same person made in another map.
const lastStroke = new Map<string, StrokeSnapshot>();
const keyFor = (roomId: string, sessionId: string) => `${roomId}\u0000${sessionId}`;

// One brush stroke (ROADMAP.md: Mountain/Peak set elevation *and* rock type
// together) reaches the server as two separate, sequential POSTs from the
// client's own flush() - cells, then types - typically milliseconds apart.
// Capturing them as two independent snapshots would let the second call
// silently discard the first half of the same stroke's "before" state, so
// undo would only restore half of what the user actually undid. Mirrors the
// client's FLUSH_INTERVAL_MS=100 batching idea on the server side: captures
// within this window of each other are treated as the same stroke and
// merged (first write per cell wins, since that's the real "before" value);
// anything after the window starts a fresh stroke, discarding the old one -
// "undo my last stroke" means the most recent one, not an ever-growing
// history.
const STROKE_MERGE_WINDOW_MS = 400;

// Called right before a terrain write is applied, capturing what those
// cells held immediately beforehand - this is the only place "before" is
// ever read, so the snapshot always reflects the real prior state, not a
// value trusted from the client that painted it.
export function captureStroke(
  roomId: string,
  sessionId: string,
  elevationCells: TerrainCell[],
  typeCells: TerrainTypeCell[],
): void {
  const touched = new Map<string, { x: number; y: number }>();
  for (const c of elevationCells) touched.set(`${c.x},${c.y}`, c);
  for (const c of typeCells) touched.set(`${c.x},${c.y}`, c);
  const cells = [...touched.values()];

  const now = Date.now();
  const key = keyFor(roomId, sessionId);
  const existing = lastStroke.get(key);
  const sameStroke = existing && now - existing.capturedAt <= STROKE_MERGE_WINDOW_MS;
  const snapshot: StrokeSnapshot = sameStroke
    ? existing
    : { elevationBefore: new Map(), typesBefore: new Map(), capturedAt: now };
  snapshot.capturedAt = now;

  // Only cells not already captured this stroke get a "before" reading -
  // a cell touched twice within one stroke (e.g. overlapping brush dabs)
  // must keep its value from *before the stroke started*, not from between
  // its own two dabs.
  const newCells = cells.filter((c) => !snapshot.elevationBefore.has(`${c.x},${c.y}`));
  if (newCells.length > 0) {
    for (const c of elevationsFor(roomId, newCells)) snapshot.elevationBefore.set(`${c.x},${c.y}`, c);
    for (const c of terrainTypesFor(roomId, newCells)) snapshot.typesBefore.set(`${c.x},${c.y}`, c);
  }
  lastStroke.set(key, snapshot);
}

export type UndoResult =
  | {
      ok: true;
      elevationCells: TerrainCell[];
      restoredTypeCells: TerrainTypeCell[];
      clearedTypeCells: { x: number; y: number }[];
    }
  | { ok: false; reason: "nothing-to-undo" };

// Restores exactly the cells captureStroke last snapshotted for this
// session, then forgets that snapshot - undo is one level deep, matching
// "undo my last stroke," not a full history stack. Returns what changed,
// split the same way applyTerrainTypes/clearTerrainTypes split their own
// input, so the caller can broadcast terrain-type:update /
// terrain-type:clear exactly like a live paint would - an undone stroke
// must be just as visible to every other connected client as the original.
export function undoLastStroke(roomId: string, sessionId: string): UndoResult {
  const key = keyFor(roomId, sessionId);
  const snapshot = lastStroke.get(key);
  if (!snapshot) return { ok: false, reason: "nothing-to-undo" };
  lastStroke.delete(key);

  const elevationCells = [...snapshot.elevationBefore.values()];
  const typesBefore = [...snapshot.typesBefore.values()];

  applyCells(roomId, elevationCells);

  const restoredTypeCells = typesBefore.filter((c): c is TerrainTypeCell => c.terrain !== null);
  const clearedTypeCells = typesBefore.filter((c) => c.terrain === null);
  if (restoredTypeCells.length > 0) applyTerrainTypes(roomId, restoredTypeCells);
  if (clearedTypeCells.length > 0) clearTerrainTypes(roomId, clearedTypeCells);

  return { ok: true, elevationCells, restoredTypeCells, clearedTypeCells };
}
