// Upgrades a terrain database from the 128x128 grid to the current 256x256
// one. Each old cell becomes a 2x2 block of identical new cells, so painted
// shapes keep their exact position and form at the finer resolution.
//
// Deliberately does NOT import src/terrain.ts: that module asserts its own
// schema version on load (see assertSchemaVersion there) and would refuse
// to touch exactly the unmigrated database this script exists to fix. This
// works directly against the raw schema instead, which is the normal shape
// for a migration tool - it has to understand both the old and new layout,
// not just the current one.
//
// Usage:
//   node scripts/migrate-terrain-grid.ts <path-to-app.db>
//
// Safe to run more than once: a database already at the target resolution
// is left untouched and reported as such. Always backs up the file before
// writing anything. Never touches the live Fly volume itself - point this
// at a local copy of it and verify the result before deciding whether (and
// when) to run it against the real one.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync } from "node:fs";

const OLD_GRID_SIZE = 128;
const NEW_GRID_SIZE = 256;

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: node scripts/migrate-terrain-grid.ts <path-to-app.db>");
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`no such file: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS terrain_cells (
    x INTEGER NOT NULL, y INTEGER NOT NULL, elevation REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (x, y)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS terrain_type_cells (
    x INTEGER NOT NULL, y INTEGER NOT NULL, terrain TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (x, y)
  )
`);

const currentVersion = (db.prepare("SELECT value FROM schema_meta WHERE key = 'grid_size'").get() as
  | { value: string }
  | undefined)?.value;

if (currentVersion === String(NEW_GRID_SIZE)) {
  console.log(`already at grid_size=${NEW_GRID_SIZE} - nothing to do (idempotent, this is not an error)`);
  process.exit(0);
}

if (currentVersion && currentVersion !== String(OLD_GRID_SIZE)) {
  console.error(`unexpected schema_meta.grid_size=${currentVersion} - this script only knows ${OLD_GRID_SIZE} -> ${NEW_GRID_SIZE}`);
  process.exit(1);
}

const oldCells = db.prepare("SELECT x, y, elevation FROM terrain_cells").all() as {
  x: number;
  y: number;
  elevation: number;
}[];
const oldTypes = db.prepare("SELECT x, y, terrain FROM terrain_type_cells").all() as {
  x: number;
  y: number;
  terrain: string;
}[];

for (const cell of oldCells) {
  if (cell.x >= OLD_GRID_SIZE || cell.y >= OLD_GRID_SIZE) {
    console.error(
      `cell (${cell.x}, ${cell.y}) is already outside the old ${OLD_GRID_SIZE}x${OLD_GRID_SIZE} grid - ` +
        `this database may already be at the new resolution without a schema_meta record. Refusing to guess; ` +
        `not modifying anything.`,
    );
    process.exit(1);
  }
}

const backupPath = `${dbPath}.pre-migration-${Date.now()}.bak`;
copyFileSync(dbPath, backupPath);
console.log(`backed up ${dbPath} -> ${backupPath}`);
console.log(`migrating ${oldCells.length} elevation cells and ${oldTypes.length} terrain-type cells`);

db.exec("BEGIN");
try {
  db.exec("DELETE FROM terrain_cells");
  db.exec("DELETE FROM terrain_type_cells");

  const insertCell = db.prepare("INSERT INTO terrain_cells (x, y, elevation) VALUES (?, ?, ?)");
  const insertType = db.prepare("INSERT INTO terrain_type_cells (x, y, terrain) VALUES (?, ?, ?)");
  const OFFSETS = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const;

  for (const { x, y, elevation } of oldCells) {
    for (const [dx, dy] of OFFSETS) insertCell.run(2 * x + dx, 2 * y + dy, elevation);
  }
  for (const { x, y, terrain } of oldTypes) {
    for (const [dx, dy] of OFFSETS) insertType.run(2 * x + dx, 2 * y + dy, terrain);
  }

  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('grid_size', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(String(NEW_GRID_SIZE));

  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  console.error("migration failed, rolled back - the database is unchanged; the backup is also still there:", err);
  process.exit(1);
}

// Validate: every old cell became exactly 4 new ones, nothing lost or
// duplicated, and the version record is what we expect.
const newCellCount = (db.prepare("SELECT COUNT(*) as c FROM terrain_cells").get() as { c: number }).c;
const newTypeCount = (db.prepare("SELECT COUNT(*) as c FROM terrain_type_cells").get() as { c: number }).c;
const finalVersion = (db.prepare("SELECT value FROM schema_meta WHERE key = 'grid_size'").get() as { value: string })
  .value;

const ok =
  newCellCount === oldCells.length * 4 && newTypeCount === oldTypes.length * 4 && finalVersion === String(NEW_GRID_SIZE);

if (!ok) {
  console.error(
    `validation FAILED: expected ${oldCells.length * 4} elevation cells, got ${newCellCount}; ` +
      `expected ${oldTypes.length * 4} type cells, got ${newTypeCount}; grid_size=${finalVersion}. ` +
      `The backup at ${backupPath} is untouched - restore from it rather than trusting this database.`,
  );
  process.exit(1);
}

console.log(
  `done: ${oldCells.length} -> ${newCellCount} elevation cells, ${oldTypes.length} -> ${newTypeCount} ` +
    `type cells, grid_size=${finalVersion}. Validated. Backup kept at ${backupPath}.`,
);
db.close();
