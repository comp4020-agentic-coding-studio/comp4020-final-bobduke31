import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ensureRoomsSchema, needsRoomsMigration } from "./rooms-schema.ts";

export const MARK_KINDS = ["flag", "campfire", "tent", "boat", "tree", "ruin"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export interface Mark {
  id: number;
  x: number;
  y: number;
  kind: MarkKind;
  sessionId: string;
  createdAt: string;
}

export const dbPath = process.env.DB_PATH ?? "/data/app.db";
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

// The grid resolution persisted data was written at. Old-resolution
// coordinates are also valid, differently-wrong coordinates at a new
// resolution, so a mismatch must fail loudly, never be applied silently.
export const GRID_SIZE = 256;

function assertGridSize(): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const stored = (db.prepare("SELECT value FROM schema_meta WHERE key = 'grid_size'").get() as { value: string } | undefined)
    ?.value;
  const hasTerrain =
    (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type = 'table' AND name = 'terrain_cells'").get() as { c: number })
      .c > 0;
  const hasData = hasTerrain && db.prepare("SELECT 1 FROM terrain_cells LIMIT 1").get() !== undefined;
  if (stored === undefined) {
    if (hasData) {
      throw new Error(
        "terrain_cells has data but no schema_meta.grid_size record - this looks like pre-migration data. " +
          `Run 'node scripts/migrate-terrain-grid.ts <db-path>' first, or DB_PATH=${dbPath} is the wrong file.`,
      );
    }
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('grid_size', ?)").run(String(GRID_SIZE));
  } else if (Number(stored) !== GRID_SIZE) {
    throw new Error(
      `database is at grid_size=${stored} but the code expects ${GRID_SIZE}. ` +
        "Run 'node scripts/migrate-terrain-grid.ts <db-path>' to upgrade it first.",
    );
  }
}

assertGridSize();
// Pre-rooms data is backed up beside the database before the one-way
// rooms migration (ADR 3); the copy stays on the volume as the recovery path.
if (needsRoomsMigration(db)) {
  const backupPath = `${dbPath}.pre-rooms-${Date.now()}.bak`;
  copyFileSync(dbPath, backupPath);
  console.log(`[schema] backed up pre-rooms database to ${backupPath}`);
}
const migration = ensureRoomsSchema(db);
if (migration.status === "migrated") {
  console.log(
    `[schema] migrated to rooms in ${migration.elapsedMs.toFixed(0)} ms, content hashes verified: ${JSON.stringify(migration.counts)}`,
  );
}

db.exec(`
  CREATE TABLE IF NOT EXISTS marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    x REAL NOT NULL,
    y REAL NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

interface MarkRow {
  id: number;
  x: number;
  y: number;
  kind: string;
  session_id: string;
  created_at: string;
}

const rowToMark = (row: MarkRow): Mark => ({
  id: row.id,
  x: row.x,
  y: row.y,
  kind: row.kind as MarkKind,
  sessionId: row.session_id,
  createdAt: row.created_at,
});

const listStmt = db.prepare("SELECT * FROM marks ORDER BY id ASC");

export function listMarks(): Mark[] {
  return (listStmt.all() as unknown as MarkRow[]).map(rowToMark);
}

const insertStmt = db.prepare(
  "INSERT INTO marks (x, y, kind, session_id) VALUES (?, ?, ?, ?) RETURNING *",
);

export function insertMark(x: number, y: number, kind: MarkKind, sessionId: string): Mark {
  const row = insertStmt.get(x, y, kind, sessionId) as unknown as MarkRow;
  return rowToMark(row);
}

const getStmt = db.prepare("SELECT * FROM marks WHERE id = ?");
const deleteStmt = db.prepare("DELETE FROM marks WHERE id = ?");

export type DeleteMarkResult = "deleted" | "not-found" | "forbidden";

// A visitor may only remove marks their own session placed - checked here,
// next to session_id, rather than trusting the caller to have already filtered.
export function deleteMarkOwnedBy(id: number, sessionId: string): DeleteMarkResult {
  const row = getStmt.get(id) as unknown as MarkRow | undefined;
  if (!row) return "not-found";
  if (row.session_id !== sessionId) return "forbidden";
  deleteStmt.run(id);
  return "deleted";
}
