// Runs the rooms migration (src/rooms-schema.ts) by hand against a copy of
// a database, to rehearse what the server does at boot. The server runs the
// same function itself, so this is never a required deploy step - pre-rooms
// code crashes on a migrated file, so migrating ahead of the deploy that
// understands it would take the app down.
//
// Usage:
//   node scripts/migrate-rooms.ts <path-to-app.db>
//
// Backs the file up first, is safe to run twice, and refuses any state it
// doesn't recognise. MIGRATE_ROOMS_FAIL_BEFORE_COMMIT=1 injects a failure
// after validation, to prove the rollback leaves the file untouched.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { ensureRoomsSchema, needsRoomsMigration } from "../src/rooms-schema.ts";

const dbPath = process.argv[2];
if (!dbPath || !existsSync(dbPath)) {
  console.error("usage: node scripts/migrate-rooms.ts <path-to-existing-app.db>");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
let grid: string | undefined;
try {
  grid = (db.prepare("SELECT value FROM schema_meta WHERE key = 'grid_size'").get() as { value: string } | undefined)?.value;
} catch {
  grid = undefined;
}
if (grid !== "256") {
  console.error("expected schema_meta.grid_size=256 - run migrate-terrain-grid.ts first, or check the path");
  process.exit(1);
}

if (needsRoomsMigration(db)) {
  const backupPath = `${dbPath}.pre-rooms-${Date.now()}.bak`;
  copyFileSync(dbPath, backupPath);
  console.log(`backed up ${dbPath} -> ${backupPath}`);
}

try {
  const result = ensureRoomsSchema(db, { failBeforeCommit: process.env.MIGRATE_ROOMS_FAIL_BEFORE_COMMIT === "1" });
  if (result.status === "current") console.log("already at the rooms schema - nothing to do (idempotent, this is not an error)");
  else if (result.status === "fresh") console.log("empty database initialised at the rooms schema");
  else {
    console.log(
      `done in ${result.elapsedMs.toFixed(0)} ms: ${JSON.stringify(result.counts)} - counts and content hashes match, integrity ok.`,
    );
  }
} catch (err) {
  console.error("migration failed, rolled back - the database is unchanged:", err instanceof Error ? err.message : err);
  process.exit(1);
}
db.close();
