// Upgrades a single-world database to the multi-room schema: every existing
// terrain row moves into the room "public", unchanged.
//
// SQLite can't alter a primary key, so terrain_cells and terrain_type_cells
// are rebuilt with (room_id, x, y) keys inside one transaction. activity_log
// gains a room_id column. marks (The Isle) is not room-scoped and is untouched.
//
// Like migrate-terrain-grid.ts, this doesn't import src/ modules: it has to
// understand the old layout, which the app code no longer will.
//
// Usage:
//   node scripts/migrate-rooms.ts <path-to-app.db>
//
// Backs the file up first, is safe to run twice, and refuses any state it
// doesn't recognise. Validation compares a content hash of every cell before
// and after, not just row counts. Run against a copy before the real volume.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

export const PUBLIC_ROOM_ID = "public";
const ROOMS_VERSION = "1";

const dbPath = process.argv[2];
if (!dbPath || !existsSync(dbPath)) {
  console.error("usage: node scripts/migrate-rooms.ts <path-to-existing-app.db>");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const one = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as T | undefined;
const count = (table: string) => one<{ c: number }>(`SELECT count(*) c FROM ${table}`)!.c;
const tableExists = (name: string) =>
  one<{ c: number }>("SELECT count(*) c FROM sqlite_master WHERE type = 'table' AND name = ?", name)!.c > 0;
const columns = (table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

const meta = (key: string) => one<{ value: string }>("SELECT value FROM schema_meta WHERE key = ?", key)?.value;

if (!tableExists("schema_meta") || meta("grid_size") !== "256") {
  console.error("expected schema_meta.grid_size=256 - run migrate-terrain-grid.ts first, or check the path");
  process.exit(1);
}
if (meta("rooms_version") === ROOMS_VERSION) {
  console.log(`already at rooms_version=${ROOMS_VERSION} - nothing to do (idempotent, this is not an error)`);
  process.exit(0);
}
if (meta("rooms_version") !== undefined) {
  console.error(`unexpected rooms_version=${meta("rooms_version")} - refusing to guess`);
  process.exit(1);
}
for (const t of ["terrain_cells", "terrain_type_cells", "activity_log"]) {
  if (!tableExists(t)) {
    console.error(`missing table ${t} - not a database this app wrote; not modifying anything`);
    process.exit(1);
  }
}
if (columns("terrain_cells").includes("room_id") || tableExists("rooms")) {
  console.error("room columns or a rooms table exist without a rooms_version record - refusing to guess");
  process.exit(1);
}

// A hash of every cell's coordinates and value (updated_at included), in a
// fixed order - so "same data" means byte-for-byte the same, not "same count".
function contentHash(table: string, valueCol: string, where = ""): string {
  const h = createHash("sha256");
  const rows = db
    .prepare(`SELECT x, y, ${valueCol} v, updated_at u FROM ${table} ${where} ORDER BY x, y`)
    .all() as { x: number; y: number; v: number | string; u: string }[];
  for (const r of rows) h.update(`${r.x},${r.y},${r.v},${r.u}\n`);
  return h.digest("hex");
}

const before = {
  terrain_cells: count("terrain_cells"),
  terrain_type_cells: count("terrain_type_cells"),
  activity_log: count("activity_log"),
  marks: tableExists("marks") ? count("marks") : 0,
  elevationHash: contentHash("terrain_cells", "elevation"),
  typeHash: contentHash("terrain_type_cells", "terrain"),
};

const backupPath = `${dbPath}.pre-rooms-${Date.now()}.bak`;
copyFileSync(dbPath, backupPath);
console.log(`backed up ${dbPath} -> ${backupPath}`);
console.log(`migrating ${JSON.stringify({ ...before, elevationHash: undefined, typeHash: undefined })}`);

const started = performance.now();
db.exec("BEGIN");
try {
  db.exec(`
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
  `);
  // The public room has no tokens: anyone may edit it, by decision.
  db.prepare("INSERT INTO rooms (id, name) VALUES (?, ?)").run(PUBLIC_ROOM_ID, "The shared world");

  db.exec(`
    CREATE TABLE terrain_cells_new (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      x INTEGER NOT NULL, y INTEGER NOT NULL, elevation REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (room_id, x, y)
    ) WITHOUT ROWID
  `);
  db.exec(`
    CREATE TABLE terrain_type_cells_new (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      x INTEGER NOT NULL, y INTEGER NOT NULL, terrain TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (room_id, x, y)
    ) WITHOUT ROWID
  `);
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

  db.prepare(`ALTER TABLE activity_log ADD COLUMN room_id TEXT NOT NULL DEFAULT '${PUBLIC_ROOM_ID}'`).run();

  if (process.env.MIGRATE_ROOMS_FAIL_BEFORE_COMMIT === "1") throw new Error("injected failure (test only)");

  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('rooms_version', ?)").run(ROOMS_VERSION);
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  console.error("migration failed, rolled back - the database is unchanged; the backup is also still there:", err);
  process.exit(1);
}
const elapsedMs = performance.now() - started;

const pub = `WHERE room_id = '${PUBLIC_ROOM_ID}'`;
const after = {
  terrain_cells: count("terrain_cells"),
  terrain_type_cells: count("terrain_type_cells"),
  activity_log: count("activity_log"),
  marks: tableExists("marks") ? count("marks") : 0,
  elevationHash: contentHash("terrain_cells", "elevation", pub),
  typeHash: contentHash("terrain_type_cells", "terrain", pub),
};
const integrity = one<{ integrity_check: string }>("PRAGMA integrity_check")!.integrity_check;
const nonPublic = one<{ c: number }>(`SELECT count(*) c FROM terrain_cells WHERE room_id <> ?`, PUBLIC_ROOM_ID)!.c;

const failures = (Object.keys(before) as (keyof typeof before)[]).filter((k) => before[k] !== after[k]);
if (integrity !== "ok") failures.push(`integrity_check=${integrity}` as never);
if (nonPublic !== 0) failures.push(`${nonPublic} rows outside the public room` as never);
if (meta("rooms_version") !== ROOMS_VERSION) failures.push("rooms_version not recorded" as never);

if (failures.length > 0) {
  console.error(
    `validation FAILED (${failures.join(", ")}). before=${JSON.stringify(before)} after=${JSON.stringify(after)}. ` +
      `Restore from ${backupPath} rather than trusting this database.`,
  );
  process.exit(1);
}

// Rebuilding two tables leaves their old pages on the freelist, which would
// roughly double the file (measured: 4.96 MB -> 9.0 MB on a production copy).
db.exec("VACUUM");

console.log(
  `done in ${elapsedMs.toFixed(0)} ms:${after.terrain_cells} elevation cells, ${after.terrain_type_cells} type cells, ` +
    `${after.activity_log} activity rows, ${after.marks} marks - counts and content hashes match, integrity ok. ` +
    `Backup kept at ${backupPath}.`,
);
db.close();
