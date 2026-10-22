import { db, GRID_SIZE } from "./db.ts";

// A regional-scale grid for now; a bigger world later is chunking
// (x, y) into (chunk, x, y), not resizing this one - see ADR.md.
export { GRID_SIZE };
export const ELEVATION_MIN = -1;
export const ELEVATION_MAX = 1;

// A cell is land if its elevation is above this; at or below, it's sea.
// A blank world (elevation 0 everywhere) is therefore entirely sea -
// land is something you paint into existence, not the default.
export const SEA_LEVEL = 0;

export const TERRAIN_TYPES = ["grassland", "sand", "forest", "rock"] as const;
export type TerrainType = (typeof TERRAIN_TYPES)[number];

export interface TerrainCell {
  x: number;
  y: number;
  elevation: number;
}

export interface TerrainTypeCell {
  x: number;
  y: number;
  terrain: TerrainType;
}

// Every table here is keyed (room_id, x, y) - see src/rooms-schema.ts.
// Elevation decides height and the land/water boundary (SEA_LEVEL above);
// terrain type is a separate, independently-painted layer that only means
// anything on land - a grassland cell that's painted sea becomes plain
// water, not "submerged grassland".

// Bumped by every write below, per room. Lets derived things (the map
// thumbnails in src/thumbnail.ts) know when they're stale without querying.
// In memory only: after a restart everything is simply regenerated once.
const revisions = new Map<string, number>();
export function terrainRevision(roomId: string): number {
  return revisions.get(roomId) ?? 0;
}
function touch(roomId: string): void {
  revisions.set(roomId, terrainRevision(roomId) + 1);
}

const listStmt = db.prepare("SELECT x, y, elevation FROM terrain_cells WHERE room_id = ?");
const getElevationStmt = db.prepare("SELECT elevation FROM terrain_cells WHERE room_id = ? AND x = ? AND y = ?");

// Sparse on purpose: an unpainted cell is never stored and defaults to sea
// level (0) on the client, so this list starts empty and only grows with
// what's actually been painted.
export function listCells(roomId: string): TerrainCell[] {
  return listStmt.all(roomId) as unknown as TerrainCell[];
}

export function isValidCell(value: unknown): value is TerrainCell {
  if (typeof value !== "object" || value === null) return false;
  const { x, y, elevation } = value as Record<string, unknown>;
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    (x as number) >= 0 &&
    (x as number) < GRID_SIZE &&
    (y as number) >= 0 &&
    (y as number) < GRID_SIZE &&
    typeof elevation === "number" &&
    Number.isFinite(elevation) &&
    elevation >= ELEVATION_MIN &&
    elevation <= ELEVATION_MAX
  );
}

function elevationAt(roomId: string, x: number, y: number): number {
  const row = getElevationStmt.get(roomId, x, y) as unknown as { elevation: number } | undefined;
  return row?.elevation ?? 0;
}

export function isLand(roomId: string, x: number, y: number): boolean {
  return elevationAt(roomId, x, y) > SEA_LEVEL;
}

// The elevation each of these cells holds right now, before any write - used
// by src/undo.ts to capture "what this stroke is about to overwrite" at the
// moment a batch arrives, server-side, not trusted from the client.
export function elevationsFor(roomId: string, cells: { x: number; y: number }[]): TerrainCell[] {
  return cells.map(({ x, y }) => ({ x, y, elevation: elevationAt(roomId, x, y) }));
}

const upsertStmt = db.prepare(`
  INSERT INTO terrain_cells (room_id, x, y, elevation, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT (room_id, x, y) DO UPDATE SET elevation = excluded.elevation, updated_at = excluded.updated_at
`);

const deleteTypeStmt = db.prepare("DELETE FROM terrain_type_cells WHERE room_id = ? AND x = ? AND y = ?");

// Applied synchronously with no `await` between read and write - node:sqlite
// is synchronous and Node single-threaded, so batches can't interleave. One
// transaction per batch, not per cell, so a big stroke is one fsync.
//
// Returns any cells that are now underwater, so the caller can clear their
// terrain type too: a cell's type and its land status must never disagree,
// and the server is where that invariant is actually enforced.
export function applyCells(roomId: string, cells: TerrainCell[]): TerrainCell[] {
  touch(roomId);
  const submerged: TerrainCell[] = [];
  db.exec("BEGIN");
  try {
    for (const cell of cells) {
      upsertStmt.run(roomId, cell.x, cell.y, cell.elevation);
      if (cell.elevation <= SEA_LEVEL) {
        deleteTypeStmt.run(roomId, cell.x, cell.y);
        submerged.push(cell);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return submerged;
}

const listTypesStmt = db.prepare("SELECT x, y, terrain FROM terrain_type_cells WHERE room_id = ?");

export function listTerrainTypes(roomId: string): TerrainTypeCell[] {
  return listTypesStmt.all(roomId) as unknown as TerrainTypeCell[];
}

const getTypeStmt = db.prepare("SELECT terrain FROM terrain_type_cells WHERE room_id = ? AND x = ? AND y = ?");

// The terrain type each of these cells holds right now (or `null` if
// untyped/sea) - the type-layer counterpart to elevationsFor.
export function terrainTypesFor(
  roomId: string,
  cells: { x: number; y: number }[],
): { x: number; y: number; terrain: TerrainType | null }[] {
  return cells.map(({ x, y }) => {
    const row = getTypeStmt.get(roomId, x, y) as unknown as { terrain: string } | undefined;
    return { x, y, terrain: (row?.terrain as TerrainType | undefined) ?? null };
  });
}

export function isValidTerrainTypeCell(value: unknown): value is TerrainTypeCell {
  if (typeof value !== "object" || value === null) return false;
  const { x, y, terrain } = value as Record<string, unknown>;
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    (x as number) >= 0 &&
    (x as number) < GRID_SIZE &&
    (y as number) >= 0 &&
    (y as number) < GRID_SIZE &&
    typeof terrain === "string" &&
    (TERRAIN_TYPES as readonly string[]).includes(terrain)
  );
}

const upsertTypeStmt = db.prepare(`
  INSERT INTO terrain_type_cells (room_id, x, y, terrain, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT (room_id, x, y) DO UPDATE SET terrain = excluded.terrain, updated_at = excluded.updated_at
`);

// Only ever called with cells already filtered to land (see the route
// handler) - painting a terrain type onto sea is a silent no-op, not an
// error, since a brush stroke straddling a coastline is the normal case.
export function applyTerrainTypes(roomId: string, cells: TerrainTypeCell[]): void {
  touch(roomId);
  db.exec("BEGIN");
  try {
    for (const cell of cells) upsertTypeStmt.run(roomId, cell.x, cell.y, cell.terrain);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// src/undo.ts's path back to "no type": a snapshot may record a cell as
// untyped (terrain: null), which upsertTypeStmt can't write (NOT NULL).
export function clearTerrainTypes(roomId: string, cells: { x: number; y: number }[]): void {
  touch(roomId);
  db.exec("BEGIN");
  try {
    for (const cell of cells) deleteTypeStmt.run(roomId, cell.x, cell.y);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
