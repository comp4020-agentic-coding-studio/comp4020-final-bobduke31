import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// --- The world: vector features for routes/objects, a brush-painted raster
// layer for terrain ---
//
// Roads/paths and buildings/ruins are plain GeoJSON features (lines/points),
// drawn, edited, dragged and deleted by Leaflet-Geoman, a mature open-source
// editing toolkit - that part works well and isn't changed here.
//
// Terrain (grass/sand/rock/water/forest) is not a GeoJSON geometry at all.
// Geoman's filled polygons rendered as a flat-coloured, semi-transparent
// vector layer floating visually above the base island image - readable as
// a separate overlay, not as the map itself changing. Terrain is instead a
// continuous drag brush: each stroke is stored as a stream of small "dabs"
// (`terrain_dabs`), replayed in order onto one raster canvas (the base
// island image, repainted with patches sampled from that same image) so a
// paint looks like the map's own art was changed in place, not stickered
// over.
export const LINE_KINDS = ["road", "path"] as const;
export const MARKER_KINDS = ["building", "ruin"] as const;
export const TERRAIN_KINDS = ["grass", "sand", "rock", "water", "forest"] as const;
// The eraser is a brush like any terrain kind (same dab shape, same table)
// but isn't itself a terrain - it restores the original map instead of
// stamping a texture, so it's kept out of TERRAIN_KINDS (the client's
// painted-texture palette) and only added for dab-kind validation.
export const DAB_KINDS = [...TERRAIN_KINDS, "eraser"] as const;

export type LineKind = (typeof LINE_KINDS)[number];
export type MarkerKind = (typeof MARKER_KINDS)[number];
export type FeatureKind = LineKind | MarkerKind;
export type TerrainKind = (typeof TERRAIN_KINDS)[number];
export type DabKind = (typeof DAB_KINDS)[number];

export type GeometryType = "LineString" | "Point";

const KINDS_BY_GEOMETRY: Record<GeometryType, readonly string[]> = {
  LineString: LINE_KINDS,
  Point: MARKER_KINDS,
};

export function isValidKindForGeometry(geometryType: string, kind: unknown): kind is FeatureKind {
  const allowed = KINDS_BY_GEOMETRY[geometryType as GeometryType];
  return Boolean(allowed) && typeof kind === "string" && allowed.includes(kind);
}

export interface GeoJsonGeometry {
  type: GeometryType;
  coordinates: unknown;
}

export interface GeoJsonFeature {
  type: "Feature";
  id?: number;
  geometry: GeoJsonGeometry;
  properties: { kind: FeatureKind; sessionId?: string; createdAt?: string; updatedAt?: string };
}

// A geometry is "well-formed enough" if it's the right JSON shape for its
// type - not a full GeoJSON validator, just enough to reject garbage before
// it hits SQLite. Leaflet/Geoman only ever send well-formed geometry, so
// this is a defensive boundary check, not a feature.
function isWellFormedGeometry(geometry: unknown): geometry is GeoJsonGeometry {
  if (!geometry || typeof geometry !== "object") return false;
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (typeof g.type !== "string" || !(g.type in KINDS_BY_GEOMETRY)) return false;
  if (!Array.isArray(g.coordinates)) return false;
  if (g.type === "Point") return g.coordinates.length === 2 && g.coordinates.every((n) => typeof n === "number");
  return g.coordinates.length >= 2;
}

const dbPath = process.env.DB_PATH ?? "/data/app.db";
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    geojson TEXT NOT NULL,
    kind TEXT NOT NULL,
    geometry_type TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS terrain_dabs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    x REAL NOT NULL,
    y REAL NOT NULL,
    radius REAL NOT NULL,
    kind TEXT NOT NULL,
    seed INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// `seed` was added after some databases (local dev, earlier deploys) already
// had a `terrain_dabs` table without it - CREATE TABLE IF NOT EXISTS is a
// no-op against that existing table, so an explicit migration is needed here
// too, or every old row's INSERT/SELECT breaks with "no column named seed".
// A default of 0 is a valid (if plain-looking) seed, not data loss - every
// existing dab stays exactly where and what kind it was.
const terrainDabsColumns = db.prepare("PRAGMA table_info(terrain_dabs)").all() as unknown as { name: string }[];
if (!terrainDabsColumns.some((col) => col.name === "seed")) {
  db.exec("ALTER TABLE terrain_dabs ADD COLUMN seed INTEGER NOT NULL DEFAULT 0");
}

interface FeatureRow {
  id: number;
  geojson: string;
  kind: string;
  geometry_type: string;
  session_id: string;
  created_at: string;
  updated_at: string;
}

function rowToFeature(row: FeatureRow): GeoJsonFeature {
  const stored = JSON.parse(row.geojson) as GeoJsonFeature;
  return {
    ...stored,
    id: row.id,
    properties: { ...stored.properties, sessionId: row.session_id, createdAt: row.created_at, updatedAt: row.updated_at },
  };
}

const listFeaturesStmt = db.prepare("SELECT * FROM features ORDER BY id ASC");
export function listFeatures(): { type: "FeatureCollection"; features: GeoJsonFeature[] } {
  const features = (listFeaturesStmt.all() as unknown as FeatureRow[]).map(rowToFeature);
  return { type: "FeatureCollection", features };
}

const insertFeatureStmt = db.prepare(`
  INSERT INTO features (geojson, kind, geometry_type, session_id)
  VALUES (?, ?, ?, ?)
  RETURNING *
`);

export class InvalidFeatureError extends Error {}

// Accepts a GeoJSON Feature (geometry + properties.kind), validates the kind
// against the fixed palette for that geometry's type, and stores the whole
// feature as one JSON blob so round-tripping it back to the client (and
// back into a Leaflet layer) needs no reconstruction.
export function insertFeature(feature: unknown, sessionId: string): GeoJsonFeature {
  const f = (feature ?? {}) as Record<string, unknown>;
  const geometry = f.geometry;
  const properties = (f.properties ?? {}) as Record<string, unknown>;
  if (!isWellFormedGeometry(geometry)) throw new InvalidFeatureError("malformed geometry");
  if (!isValidKindForGeometry(geometry.type, properties.kind)) {
    throw new InvalidFeatureError(
      `kind "${String(properties.kind)}" is not valid for a ${geometry.type} (expected one of ${KINDS_BY_GEOMETRY[geometry.type].join(", ")})`,
    );
  }
  const stored: GeoJsonFeature = { type: "Feature", geometry, properties: { kind: properties.kind } };
  const row = insertFeatureStmt.get(
    JSON.stringify(stored),
    properties.kind,
    geometry.type,
    sessionId,
  ) as unknown as FeatureRow;
  return rowToFeature(row);
}

const getFeatureStmt = db.prepare("SELECT * FROM features WHERE id = ?");
const updateGeometryStmt = db.prepare(`
  UPDATE features SET geojson = ?, updated_at = datetime('now') WHERE id = ?
`);

// Geoman's edit/drag modes only ever change a layer's coordinates, never its
// kind - so this only accepts a replacement geometry, re-validated against
// the feature's own existing kind (its type can't change either: Geoman
// never turns a polygon into a line mid-edit).
export function updateFeatureGeometry(id: number, geometry: unknown): GeoJsonFeature | null {
  const existing = getFeatureStmt.get(id) as unknown as FeatureRow | undefined;
  if (!existing) return null;
  if (!isWellFormedGeometry(geometry)) throw new InvalidFeatureError("malformed geometry");
  if (geometry.type !== existing.geometry_type) {
    throw new InvalidFeatureError(`cannot change geometry type (feature ${id} is a ${existing.geometry_type})`);
  }
  const stored = JSON.parse(existing.geojson) as GeoJsonFeature;
  stored.geometry = geometry;
  updateGeometryStmt.run(JSON.stringify(stored), id);
  return rowToFeature({ ...existing, geojson: JSON.stringify(stored) });
}

const deleteFeatureStmt = db.prepare("DELETE FROM features WHERE id = ?");
export function deleteFeature(id: number): boolean {
  return deleteFeatureStmt.run(id).changes > 0;
}

export interface TerrainDab {
  id: number;
  x: number;
  y: number;
  radius: number;
  kind: DabKind;
  seed: number;
  createdAt: string;
}

interface TerrainDabRow {
  id: number;
  x: number;
  y: number;
  radius: number;
  kind: string;
  seed: number;
  session_id: string;
  created_at: string;
}

function rowToDab(row: TerrainDabRow): TerrainDab {
  return {
    id: row.id,
    x: row.x,
    y: row.y,
    radius: row.radius,
    kind: row.kind as DabKind,
    seed: row.seed,
    createdAt: row.created_at,
  };
}

// Creation order is the whole render contract: the client replays this list
// from scratch (base image, then every dab in order) to reconstruct the
// painted terrain, so nothing but this ordering is ever persisted.
const listTerrainDabsStmt = db.prepare("SELECT * FROM terrain_dabs ORDER BY id ASC");
export function listTerrainDabs(): TerrainDab[] {
  return (listTerrainDabsStmt.all() as unknown as TerrainDabRow[]).map(rowToDab);
}

export interface TerrainDabInput {
  x: number;
  y: number;
  radius: number;
  kind: string;
  seed: number;
}

function isWellFormedDab(dab: unknown): dab is TerrainDabInput {
  if (!dab || typeof dab !== "object") return false;
  const d = dab as Record<string, unknown>;
  return (
    typeof d.x === "number" &&
    Number.isFinite(d.x) &&
    typeof d.y === "number" &&
    Number.isFinite(d.y) &&
    typeof d.radius === "number" &&
    Number.isFinite(d.radius) &&
    d.radius > 0 &&
    typeof d.kind === "string" &&
    typeof d.seed === "number" &&
    Number.isFinite(d.seed)
  );
}

const insertDabStmt = db.prepare(`
  INSERT INTO terrain_dabs (x, y, radius, kind, seed, session_id)
  VALUES (?, ?, ?, ?, ?, ?)
  RETURNING *
`);

// One brush stroke (a drag gesture) arrives as a batch, inserted in one
// transaction - the project already hit the per-row-transaction request
// storm problem once before with the old splat-map brush, so this batches
// from the start rather than one request per dab.
export function insertTerrainDabs(dabs: unknown, sessionId: string): TerrainDab[] {
  if (!Array.isArray(dabs) || dabs.length === 0) {
    throw new InvalidFeatureError("expected a non-empty array of dabs");
  }
  for (const dab of dabs) {
    if (!isWellFormedDab(dab)) throw new InvalidFeatureError("malformed dab");
    if (!DAB_KINDS.includes(dab.kind as DabKind)) {
      throw new InvalidFeatureError(`kind "${dab.kind}" is not a valid brush kind (expected one of ${DAB_KINDS.join(", ")})`);
    }
  }
  const inserted: TerrainDab[] = [];
  db.exec("BEGIN");
  try {
    for (const dab of dabs as TerrainDabInput[]) {
      const row = insertDabStmt.get(dab.x, dab.y, dab.radius, dab.kind, dab.seed, sessionId) as unknown as TerrainDabRow;
      inserted.push(rowToDab(row));
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return inserted;
}
