// Seeds a deterministic test scene - a natural-looking region with a
// fractal coast, a connected mountain range, plains and forests - into a fresh SQLite dev
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

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Deterministic value noise + fBm, so the scene is identical every run.
// Self-contained (scripts/ can't import the browser modules) - only the
// *shape* of this data matters, not matching the renderer's own noise.
function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  return (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy) * 2 - 1;
}

function fbm(x: number, y: number, seed: number, octaves = 5): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 17) * amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

// Distance from point p to segment ab.
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function polylineDist(px: number, py: number, pts: number[][]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    best = Math.min(best, segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  return best;
}

// A regional map, laid out the way a cartographer would sketch one: a
// landmass filling the north and west with a fractal coast, a deep bay and
// a headland to the south-east, an offshore island; one connected mountain
// spine curving across the north with a spur and foothills (not separate
// round bumps); plains and low rolling hills between the range and the
// sea; a forest band hugging the range's southern foothills plus a coastal
// wood - all shaped by the land, not by a box.
//
// The previous scene was the source of three of the reported artefacts,
// independent of any renderer: mountains were `max()` of six radial bumps
// (literal circles), the forest was an axis-aligned rectangle, and the
// beach was a hard elevation clamp with land continuing past it.
const SPINE = [
  [10, 70],
  [44, 48],
  [84, 40],
  [122, 50],
  [156, 40],
  [188, 56],
  [206, 86],
];
const SPUR = [
  [122, 50],
  [112, 82],
  [94, 104],
];
const ISLAND = { x: 212, y: 206, r: 16 };

// Signed "landness": > 0 is land. A base shape plus large-scale fBm, then
// fine fBm for the fractal coastline; the bay is carved out of the base.
function landness(x: number, y: number): number {
  const nx = x / 256;
  const ny = y / 256;
  // Land fills the north-west; the sea wraps the south and east.
  let base = 0.5 - ny * 0.95 - Math.max(0, nx - 0.78) * 1.4 + (0.5 - nx) * 0.12;
  base += 0.34 * Math.exp(-((nx - 0.14) ** 2 + (ny - 0.74) ** 2) / 0.018); // western headland
  base -= 0.42 * Math.exp(-((nx - 0.56) ** 2 + (ny - 0.6) ** 2) / 0.011); // the bay
  base += 0.26 * Math.exp(-((nx - 0.82) ** 2 + (ny - 0.44) ** 2) / 0.006); // eastern cape
  // Irregular island: radius modulated by angle-free noise, not a disc.
  const islandR = ISLAND.r * (1 + 0.45 * fbm(x / 9, y / 9, 3));
  const island = 0.45 * (1 - Math.hypot((x - ISLAND.x) * 0.8, y - ISLAND.y) / islandR);
  return Math.max(base + 0.2 * fbm(nx * 3, ny * 3, 7) + 0.08 * fbm(nx * 11, ny * 11, 9), island);
}

// Mountain mass: a ridge profile along the spine/spur, width and height
// modulated along its length so it reads as one range with saddles and
// summits, not as a row of identical domes.
function mountainHeight(x: number, y: number): number {
  const wobble = 7 * fbm(x / 40, y / 40, 21);
  const dSpine = polylineDist(x + wobble, y - wobble * 0.6, SPINE);
  const dSpur = polylineDist(x - wobble * 0.5, y + wobble, SPUR);
  // Wide: a massif with foothills, not a single wall. The profile is a
  // broad shoulder (sqrt-ish) so the range has body before the summit.
  const width = 40 + 14 * fbm(x / 60, y / 60, 31);
  const along = 0.62 + 0.3 * fbm(x / 45, y / 45, 41);
  const spine = Math.max(0, 1 - dSpine / width);
  const spur = Math.max(0, 1 - dSpur / (width * 0.65)) * 0.72;
  const profile = Math.max(spine, spur);
  return Math.pow(profile, 1.5) * along;
}

const insertCell = db.prepare("INSERT INTO terrain_cells (x, y, elevation) VALUES (?, ?, ?)");
const insertType = db.prepare("INSERT INTO terrain_type_cells (x, y, terrain) VALUES (?, ?, ?)");

let peak = { x: 0, y: 0, e: 0 };
db.exec("BEGIN");
for (let y = 0; y < GRID_SIZE; y++) {
  for (let x = 0; x < GRID_SIZE; x++) {
    const l = landness(x, y);
    let elevation: number;
    if (l <= 0) {
      // Seabed: shelves off with distance from shore, with some relief.
      elevation = clamp(-0.04 + l * 1.4 + 0.04 * fbm(x / 30, y / 30, 51), -0.85, -0.02);
    } else {
      const shore = smoothstep(0, 0.12, l); // low coastal plain near the sea
      const hills = 0.05 + 0.06 * (0.5 + 0.5 * fbm(x / 34, y / 34, 61));
      const mountain = mountainHeight(x, y);
      elevation = clamp(0.02 + shore * (hills + mountain * 0.82), 0.02, 0.98);
    }
    if (elevation > peak.e) peak = { x, y, e: elevation };
    insertCell.run(x, y, elevation);

    if (elevation > 0) {
      // Forest: a band along the range's southern foothills plus a coastal
      // wood in the west, edges from noise - no rectangles. Rock/snow/beach
      // are left to the renderer, which derives them from the terrain's
      // shape (slope, height, distance to the coast).
      // The range's southern skirt is where the foothill forest grows:
      // sample the mountain mass a little *north* (smaller y) of here.
      const m = mountainHeight(x, y);
      const foothills = smoothstep(0.05, 0.18, mountainHeight(x, y - 14)) * (1 - smoothstep(0.18, 0.36, m));
      const westWood = 1 - smoothstep(14, 34, Math.hypot(x - 44, y - 152) + 16 * fbm(x / 16, y / 16, 71));
      const eastWood = 1 - smoothstep(10, 26, Math.hypot(x - 200, y - 128) + 14 * fbm(x / 14, y / 14, 73));
      const forest = Math.max(foothills, westWood, eastWood) + 0.45 * fbm(x / 11, y / 11, 81);
      let terrain = "grassland";
      if (forest > 0.5) terrain = "forest";
      insertType.run(x, y, terrain);
    }
  }
}
db.exec("COMMIT");

console.log(
  `seeded test scene into ${dbPath}: fractal coast with a bay and island, a connected ` +
    `mountain range (highest point ${peak.x},${peak.y} at ${peak.e.toFixed(2)}), foothill and coastal forests.`,
);
db.close();
