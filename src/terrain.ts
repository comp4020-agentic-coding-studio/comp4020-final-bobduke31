import { db } from "./db.ts";

// A regional-scale grid for now; a bigger world later is chunking
// (x, y) into (chunk, x, y), not resizing this one - see ADR.md.
export const GRID_SIZE = 128;
export const ELEVATION_MIN = -1;
export const ELEVATION_MAX = 1;

export interface TerrainCell {
  x: number;
  y: number;
  elevation: number;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS terrain_cells (
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    elevation REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (x, y)
  )
`);

interface CellRow {
  x: number;
  y: number;
  elevation: number;
}

const listStmt = db.prepare("SELECT x, y, elevation FROM terrain_cells");

// Sparse on purpose: an unpainted cell is never stored and defaults to sea
// level (0) on the client, so this list starts empty and only grows with
// what's actually been painted.
export function listCells(): TerrainCell[] {
  return listStmt.all() as unknown as CellRow[];
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

const upsertStmt = db.prepare(`
  INSERT INTO terrain_cells (x, y, elevation, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT (x, y) DO UPDATE SET elevation = excluded.elevation, updated_at = excluded.updated_at
`);

// Applied synchronously, one statement per cell, with no `await` between
// read and write anywhere in the request - node:sqlite's API is
// synchronous and Node is single-threaded, so a batch from one request
// can't interleave with another request's batch.
export function applyCells(cells: TerrainCell[]): void {
  for (const cell of cells) upsertStmt.run(cell.x, cell.y, cell.elevation);
}
