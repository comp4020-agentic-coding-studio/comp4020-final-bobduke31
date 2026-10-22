import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

// The single-world -> rooms migration (ADR 3). Shared by the server, which
// runs it at boot, and scripts/migrate-rooms.ts, which runs it by hand
// against a copy. Pre-rooms code crashes on a migrated database (its
// ON CONFLICT (x, y) no longer matches a key), so this must ship in the same
// deploy as the code that reads the new layout, never ahead of it.

export const PUBLIC_ROOM_ID = "public";
export const PUBLIC_ROOM_NAME = "The shared world";
const ROOMS_VERSION = "1";

export type MigrationResult =
  | { status: "fresh" }
  | { status: "current" }
  | { status: "migrated"; counts: Counts; elapsedMs: number };

interface Counts {
  terrain_cells: number;
  terrain_type_cells: number;
  activity_log: number;
}

const ROOMS_DDL = `
  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    edit_token TEXT UNIQUE,
    view_token TEXT UNIQUE,
    created_by TEXT,
    seed INTEGER,
    params TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;
const TERRAIN_DDL = (name: string) => `
  CREATE TABLE ${name} (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    x INTEGER NOT NULL, y INTEGER NOT NULL, elevation REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, x, y)
  ) WITHOUT ROWID
`;
const TYPE_DDL = (name: string) => `
  CREATE TABLE ${name} (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    x INTEGER NOT NULL, y INTEGER NOT NULL, terrain TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, x, y)
  ) WITHOUT ROWID
`;
const MEMBERS_DDL = `
  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, room_id)
  ) WITHOUT ROWID
`;

// Additive and idempotent: a new table only, so it needs no version bump and
// rewrites no existing row (Atlas Table step I).
const PEOPLE_DDL = `
  CREATE TABLE IF NOT EXISTS people (
    session_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tincture TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) WITHOUT ROWID
`;

// The gallery (Atlas Table stage A): a map is listed only while a row here
// says so. Additive, like people: a new table, no existing row touched, and
// older code simply never reads it.
const LISTINGS_DDL = `
  CREATE TABLE IF NOT EXISTS room_listings (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    listed_by TEXT NOT NULL,
    listed_at TEXT NOT NULL DEFAULT (datetime('now')),
    hidden INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID
`;

// Versions (Atlas Table stage B): a saved copy of a map's two grids, gzipped
// JSON. Additive like the tables above; older code never reads it.
const VERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS room_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    cells INTEGER NOT NULL,
    data BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS room_versions_room ON room_versions (room_id, id)
`;

const ACTIVITY_DDL = `
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;
const ADD_ACTIVITY_ROOM = `ALTER TABLE activity_log ADD COLUMN room_id TEXT NOT NULL DEFAULT '${PUBLIC_ROOM_ID}'`;

function get<T>(db: DatabaseSync, sql: string, ...args: string[]): T | undefined {
  return db.prepare(sql).get(...args) as T | undefined;
}
const tableExists = (db: DatabaseSync, name: string) =>
  get<{ c: number }>(db, "SELECT count(*) c FROM sqlite_master WHERE type = 'table' AND name = ?", name)!.c > 0;
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const count = (db: DatabaseSync, table: string) => get<{ c: number }>(db, `SELECT count(*) c FROM ${table}`)!.c;

// Every cell's coordinates, value and timestamp in a fixed order: "same
// data" means byte-for-byte the same, not "same row count".
function contentHash(db: DatabaseSync, table: string, valueCol: string, where = ""): string {
  const h = createHash("sha256");
  const rows = db
    .prepare(`SELECT x, y, ${valueCol} v, updated_at u FROM ${table} ${where} ORDER BY x, y`)
    .all() as { x: number; y: number; v: number | string; u: string }[];
  for (const r of rows) h.update(`${r.x},${r.y},${r.v},${r.u}\n`);
  return h.digest("hex");
}

export function needsRoomsMigration(db: DatabaseSync): boolean {
  if (!tableExists(db, "terrain_cells") || !tableExists(db, "schema_meta")) return false;
  return get(db, "SELECT value FROM schema_meta WHERE key = 'rooms_version'") === undefined;
}

// Brings any database this app has ever written up to the rooms schema:
// a brand-new file gets it directly, a pre-rooms file is migrated (one
// transaction, validated by content hash, rolled back on any mismatch), a
// current one is left alone. Throws on any state it doesn't recognise
// rather than guessing. Callers back the file up first when it holds data.
export function ensureRoomsSchema(db: DatabaseSync, opts: { failBeforeCommit?: boolean } = {}): MigrationResult {
  db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const meta = (key: string) => get<{ value: string }>(db, "SELECT value FROM schema_meta WHERE key = ?", key)?.value;
  const version = meta("rooms_version");

  if (version === ROOMS_VERSION) {
    db.exec(MEMBERS_DDL);
    db.exec(PEOPLE_DDL);
    db.exec(LISTINGS_DDL);
    db.exec(VERSIONS_DDL);
    return { status: "current" };
  }
  if (version !== undefined) throw new Error(`unexpected schema_meta.rooms_version=${version} - refusing to guess`);

  const hasTerrain = tableExists(db, "terrain_cells");
  if (tableExists(db, "rooms") || (hasTerrain && columns(db, "terrain_cells").includes("room_id"))) {
    throw new Error("rooms tables exist without a rooms_version record - refusing to guess");
  }

  if (!hasTerrain) {
    db.exec("BEGIN");
    try {
      db.exec(ROOMS_DDL);
      db.exec(TERRAIN_DDL("terrain_cells"));
      db.exec(TYPE_DDL("terrain_type_cells"));
      db.exec(MEMBERS_DDL);
      db.exec(PEOPLE_DDL);
      db.exec(LISTINGS_DDL);
      db.exec(VERSIONS_DDL);
      db.exec(ACTIVITY_DDL);
      if (!columns(db, "activity_log").includes("room_id")) db.exec(ADD_ACTIVITY_ROOM);
      db.prepare("INSERT INTO rooms (id, name) VALUES (?, ?)").run(PUBLIC_ROOM_ID, PUBLIC_ROOM_NAME);
      db.prepare("INSERT INTO schema_meta (key, value) VALUES ('rooms_version', ?)").run(ROOMS_VERSION);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { status: "fresh" };
  }

  if (!tableExists(db, "terrain_type_cells")) throw new Error("terrain_cells exists without terrain_type_cells - refusing to guess");
  db.exec(ACTIVITY_DDL);

  const before = {
    terrain_cells: count(db, "terrain_cells"),
    terrain_type_cells: count(db, "terrain_type_cells"),
    activity_log: count(db, "activity_log"),
    elevationHash: contentHash(db, "terrain_cells", "elevation"),
    typeHash: contentHash(db, "terrain_type_cells", "terrain"),
  };

  const started = performance.now();
  db.exec("BEGIN");
  try {
    db.exec(ROOMS_DDL);
    // The public room has no tokens: anyone may edit it, by decision (ADR 3).
    db.prepare("INSERT INTO rooms (id, name) VALUES (?, ?)").run(PUBLIC_ROOM_ID, PUBLIC_ROOM_NAME);
    db.exec(TERRAIN_DDL("terrain_cells_new"));
    db.exec(TYPE_DDL("terrain_type_cells_new"));
    db.prepare(
      "INSERT INTO terrain_cells_new (room_id, x, y, elevation, updated_at) SELECT ?, x, y, elevation, updated_at FROM terrain_cells",
    ).run(PUBLIC_ROOM_ID);
    db.prepare(
      "INSERT INTO terrain_type_cells_new (room_id, x, y, terrain, updated_at) SELECT ?, x, y, terrain, updated_at FROM terrain_type_cells",
    ).run(PUBLIC_ROOM_ID);
    db.exec("DROP TABLE terrain_cells");
    db.exec("DROP TABLE terrain_type_cells");
    db.exec("ALTER TABLE terrain_cells_new RENAME TO terrain_cells");
    db.exec("ALTER TABLE terrain_type_cells_new RENAME TO terrain_type_cells");
    if (!columns(db, "activity_log").includes("room_id")) db.exec(ADD_ACTIVITY_ROOM);
    db.exec(MEMBERS_DDL);
    db.exec(PEOPLE_DDL);
    db.exec(LISTINGS_DDL);
    db.exec(VERSIONS_DDL);

    const pub = `WHERE room_id = '${PUBLIC_ROOM_ID}'`;
    const after = {
      terrain_cells: count(db, "terrain_cells"),
      terrain_type_cells: count(db, "terrain_type_cells"),
      activity_log: count(db, "activity_log"),
      elevationHash: contentHash(db, "terrain_cells", "elevation", pub),
      typeHash: contentHash(db, "terrain_type_cells", "terrain", pub),
    };
    const mismatched = (Object.keys(before) as (keyof typeof before)[]).filter((k) => before[k] !== after[k]);
    if (mismatched.length > 0) throw new Error(`validation failed, mismatched: ${mismatched.join(", ")}`);
    if (opts.failBeforeCommit) throw new Error("injected failure (test only)");

    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('rooms_version', ?)").run(ROOMS_VERSION);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const elapsedMs = performance.now() - started;
  const integrity = get<{ integrity_check: string }>(db, "PRAGMA integrity_check")!.integrity_check;
  if (integrity !== "ok") throw new Error(`integrity_check after migration: ${integrity}`);
  // Rebuilding two tables leaves their old pages free, roughly doubling the
  // file (measured on a production copy: 4.96 MB -> 9.0 MB, 4.2 MB after).
  db.exec("VACUUM");
  const { elevationHash: _e, typeHash: _t, ...counts } = before;
  return { status: "migrated", counts, elapsedMs };
}
