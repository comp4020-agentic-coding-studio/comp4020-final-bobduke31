import { db } from "./db.ts";

// A regional-scale grid for now; a bigger world later is chunking
// (x, y) into (chunk, x, y), not resizing this one - see ADR.md.
export const GRID_SIZE = 256;
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

db.exec(`
  CREATE TABLE IF NOT EXISTS terrain_cells (
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    elevation REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (x, y)
  )
`);

// Elevation decides height and the land/water boundary (SEA_LEVEL above);
// terrain type is a separate, independently-painted layer that only means
// anything on land - a grassland cell that's painted sea becomes plain
// water, not "submerged grassland". Kept as its own table, not a column
// on terrain_cells, so roads/settlements can get their own tables the
// same way later without this one needing to change shape again.
db.exec(`
  CREATE TABLE IF NOT EXISTS terrain_type_cells (
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    terrain TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (x, y)
  )
`);

// Tracks which grid resolution the persisted data was written at, so a
// resolution change (128 -> 256 happened once already) can never be applied
// silently: old-resolution coordinates are also valid, differently-wrong
// coordinates at the new resolution, so running the new code against
// unmigrated data would corrupt it quietly rather than failing loudly.
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

function readSchemaGridSize(): number | null {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'grid_size'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : null;
}

function assertSchemaVersion(): void {
  const stored = readSchemaGridSize();
  const hasData = (db.prepare("SELECT 1 FROM terrain_cells LIMIT 1").get() as unknown) !== undefined;

  if (stored === null) {
    if (hasData) {
      throw new Error(
        `terrain_cells has data but no schema_meta.grid_size record - this looks like ` +
          `pre-migration data. Run 'node scripts/migrate-terrain-grid.ts <db-path>' before ` +
          `starting the server, or 'DB_PATH=${process.env.DB_PATH ?? "/data/app.db"}' points at the wrong file.`,
      );
    }
    // A genuinely fresh database: nothing to migrate, just record the
    // resolution it's starting at.
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('grid_size', ?)").run(String(GRID_SIZE));
    return;
  }

  if (stored !== GRID_SIZE) {
    throw new Error(
      `database is at grid_size=${stored} but the code expects GRID_SIZE=${GRID_SIZE}. ` +
        `Run 'node scripts/migrate-terrain-grid.ts <db-path>' to upgrade it first.`,
    );
  }
}

assertSchemaVersion();

interface CellRow {
  x: number;
  y: number;
  elevation: number;
}

interface TypeRow {
  x: number;
  y: number;
  terrain: string;
}

const listStmt = db.prepare("SELECT x, y, elevation FROM terrain_cells");
const getElevationStmt = db.prepare("SELECT elevation FROM terrain_cells WHERE x = ? AND y = ?");

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

function elevationAt(x: number, y: number): number {
  const row = getElevationStmt.get(x, y) as unknown as { elevation: number } | undefined;
  return row?.elevation ?? 0;
}

export function isLand(x: number, y: number): boolean {
  return elevationAt(x, y) > SEA_LEVEL;
}

// The elevation each of these cells holds right now, before any write - used
// by src/undo.ts to capture "what this stroke is about to overwrite" at the
// moment a batch arrives, server-side, not trusted from the client. An
// unpainted cell correctly reads as SEA_LEVEL (0), the same default
// elevationAt and the client's own blank-grid default already agree on.
export function elevationsFor(cells: { x: number; y: number }[]): TerrainCell[] {
  return cells.map(({ x, y }) => ({ x, y, elevation: elevationAt(x, y) }));
}

const upsertStmt = db.prepare(`
  INSERT INTO terrain_cells (x, y, elevation, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT (x, y) DO UPDATE SET elevation = excluded.elevation, updated_at = excluded.updated_at
`);

const deleteTypeStmt = db.prepare("DELETE FROM terrain_type_cells WHERE x = ? AND y = ?");

// Applied synchronously, one statement per cell, with no `await` between
// read and write anywhere in the request - node:sqlite's API is
// synchronous and Node is single-threaded, so a batch from one request
// can't interleave with another request's batch.
//
// Wrapped in one transaction: without it, every cell is its own implicit
// commit (its own fsync), and at 256x256 a single generous brush stroke
// can touch several hundred cells per flush - one transaction per batch
// instead of one per cell is what keeps that from becoming the bottleneck.
//
// Returns any cells that are now underwater, so the caller can clear their
// terrain type too: a cell's type and its land status must never disagree,
// and the server is where that invariant is actually enforced, not just
// hoped for on the client.
export function applyCells(cells: TerrainCell[]): TerrainCell[] {
  const submerged: TerrainCell[] = [];
  db.exec("BEGIN");
  try {
    for (const cell of cells) {
      upsertStmt.run(cell.x, cell.y, cell.elevation);
      if (cell.elevation <= SEA_LEVEL) {
        deleteTypeStmt.run(cell.x, cell.y);
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

const listTypesStmt = db.prepare("SELECT x, y, terrain FROM terrain_type_cells");

export function listTerrainTypes(): TerrainTypeCell[] {
  return (listTypesStmt.all() as unknown as TypeRow[]).map((row) => ({
    x: row.x,
    y: row.y,
    terrain: row.terrain as TerrainType,
  }));
}

const getTypeStmt = db.prepare("SELECT terrain FROM terrain_type_cells WHERE x = ? AND y = ?");

// The terrain type each of these cells holds right now (or `null` if
// untyped/sea) - the type-layer counterpart to elevationsFor, used the same
// way by src/undo.ts to capture a pre-write snapshot server-side.
export function terrainTypesFor(
  cells: { x: number; y: number }[],
): { x: number; y: number; terrain: TerrainType | null }[] {
  return cells.map(({ x, y }) => {
    const row = getTypeStmt.get(x, y) as unknown as { terrain: string } | undefined;
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
  INSERT INTO terrain_type_cells (x, y, terrain, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT (x, y) DO UPDATE SET terrain = excluded.terrain, updated_at = excluded.updated_at
`);

// Only ever called with cells already filtered to land (see the route
// handler) - painting a terrain type onto sea is a silent no-op, not an
// error, since a brush stroke straddling a coastline is the normal case.
// One transaction for the same reason as applyCells above.
export function applyTerrainTypes(cells: TerrainTypeCell[]): void {
  db.exec("BEGIN");
  try {
    for (const cell of cells) upsertTypeStmt.run(cell.x, cell.y, cell.terrain);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// src/undo.ts's own counterpart to applyTerrainTypes: a snapshot it's
// restoring may record a cell as untyped (terrain: null, from
// terrainTypesFor above) rather than one of TERRAIN_TYPES - upsertTypeStmt
// can't write that (its column is NOT NULL), so this is the explicit path
// back to "no type" rather than silently coercing null into a string.
export function clearTerrainTypes(cells: { x: number; y: number }[]): void {
  db.exec("BEGIN");
  try {
    for (const cell of cells) deleteTypeStmt.run(cell.x, cell.y);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
