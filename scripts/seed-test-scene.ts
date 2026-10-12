// Seeds a deterministic test scene - coastline, plains, hills, a mountain
// range with one dominant peak, and a forest patch - into a fresh SQLite dev
// database, for repeatable visual QA of the terrain renderers. Mirrors
// migrate-terrain-grid.ts as a small, single-purpose dev script. Always
// overwrites the target file with a brand-new scene; never touches the
// production database (it takes a path argument, not a fixed location).
//
// Usage:
//   node scripts/seed-test-scene.ts <path-to-dev.db>
import { DatabaseSync } from "node:sqlite";
import { existsSync, unlinkSync } from "node:fs";

const GRID_SIZE = 256;

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: node scripts/seed-test-scene.ts <path-to-dev.db>");
  process.exit(1);
}
if (existsSync(dbPath)) unlinkSync(dbPath);

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE terrain_cells (
    x INTEGER NOT NULL, y INTEGER NOT NULL, elevation REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (x, y)
  )
`);
db.exec(`
  CREATE TABLE terrain_type_cells (
    x INTEGER NOT NULL, y INTEGER NOT NULL, terrain TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (x, y)
  )
`);
db.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
db.exec(`INSERT INTO schema_meta (key, value) VALUES ('grid_size', '${GRID_SIZE}')`);
// The Isle's own table, so the full server (not just /world/) runs cleanly
// against this dev DB too.
db.exec(`
  CREATE TABLE marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, x REAL NOT NULL, y REAL NOT NULL,
    kind TEXT NOT NULL, session_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// A wavy coastline rather than a straight line - sea below it (toward
// y=255), land above.
function coastY(x: number): number {
  return 185 + 18 * Math.sin(x / 34) + 8 * Math.sin(x / 11 + 2);
}

// Mountain range: a chain of overlapping radial bumps, plus one dominant
// peak reaching near the elevation ceiling.
const ridgePoints = [
  { x: 60, y: 70, r: 38, h: 0.55 },
  { x: 95, y: 55, r: 34, h: 0.62 },
  { x: 130, y: 60, r: 42, h: 0.78 },
  { x: 150, y: 45, r: 30, h: 0.6 },
  { x: 170, y: 65, r: 36, h: 0.58 },
];
const dominantPeak = { x: 128, y: 58, r: 22, h: 0.97 };

function smoothstep01(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

function ridgeHeight(x: number, y: number): number {
  let h = 0;
  for (const p of [...ridgePoints, dominantPeak]) {
    const d = Math.hypot(x - p.x, y - p.y);
    const bump = smoothstep01(1 - d / p.r) * p.h;
    h = Math.max(h, bump);
  }
  return h;
}

// Gentle rolling hills across a mid-band of the map.
function hillHeight(x: number, y: number): number {
  const n = Math.sin(x / 28) * Math.cos(y / 31) * 0.5 + Math.sin(x / 13 + y / 19) * 0.25;
  return 0.16 + 0.1 * n;
}

const insertCell = db.prepare("INSERT INTO terrain_cells (x, y, elevation) VALUES (?, ?, ?)");
const insertType = db.prepare("INSERT INTO terrain_type_cells (x, y, terrain) VALUES (?, ?, ?)");

db.exec("BEGIN");
for (let y = 0; y < GRID_SIZE; y++) {
  for (let x = 0; x < GRID_SIZE; x++) {
    const cy = coastY(x);
    let elevation: number;
    if (y > cy + 6) {
      const depth = clamp((y - cy) / 70, 0, 1);
      elevation = -0.08 - 0.5 * depth;
    } else {
      const mountain = ridgeHeight(x, y);
      const hill = hillHeight(x, y);
      const plain = 0.06;
      const base = Math.max(plain, hill, mountain);
      const shoreFade = clamp((cy - y) / 10, 0, 1);
      elevation = base * (0.15 + 0.85 * shoreFade);
      if (y > cy - 4) elevation = Math.min(elevation, 0.05); // a flat beach strip
    }
    elevation = clamp(elevation, -1, 1);
    insertCell.run(x, y, elevation);

    if (elevation > 0) {
      let terrain = "grassland";
      if (ridgeHeight(x, y) > 0.3) terrain = "rock";
      else if (y > cy - 10 && y <= cy + 2) terrain = "sand";
      else if (x > 150 && x < 220 && y > 90 && y < 160) terrain = "forest";
      insertType.run(x, y, terrain);
    }
  }
}
db.exec("COMMIT");

console.log(
  `seeded test scene into ${dbPath}: coastline, plains, hills, a mountain range ` +
    `(dominant peak at ${dominantPeak.x},${dominantPeak.y}), and a forest patch.`,
);
db.close();
