// Map objects (Atlas Table stage B, the first step towards the tabletop
// editor): cottages, houses, castles and other places, set on the map and
// moved, turned or removed live. Models are the CC0 KayKit Medieval Hexagon
// Pack (CREDITS.md), the same family as the trees.
//
// Like terrain, objects are a shared canvas: anyone with the edit link may
// change any object, and the last write wins (ADR.md). Position is in cell
// units, fractional, so an object isn't snapped to the grid.
import { db, GRID_SIZE } from "./db.ts";

export const OBJECT_KINDS = [
  "cottage",
  "house",
  "church",
  "windmill",
  "well",
  "farm",
  "tower",
  "castle",
  "wall",
  "bridge",
  "ruins",
] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

// Enough for a busy regional map; bounds the row count a scripted edit
// link can create.
export const MAX_OBJECTS_PER_ROOM = 600;

export interface MapObject {
  id: number;
  kind: ObjectKind;
  x: number;
  y: number;
  rotation: number;
  scale: number;
}

export const OBJECTS_DDL = `
  CREATE TABLE IF NOT EXISTS room_objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    kind TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    rotation REAL NOT NULL DEFAULT 0,
    scale REAL NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS room_objects_room ON room_objects (room_id)
`;
db.exec(OBJECTS_DDL);

const listStmt = db.prepare("SELECT id, kind, x, y, rotation, scale FROM room_objects WHERE room_id = ? ORDER BY id");
const countStmt = db.prepare("SELECT count(*) c FROM room_objects WHERE room_id = ?");
const insertStmt = db.prepare("INSERT INTO room_objects (room_id, kind, x, y, rotation, scale, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)");
const getStmt = db.prepare("SELECT id, kind, x, y, rotation, scale FROM room_objects WHERE room_id = ? AND id = ?");
const updateStmt = db.prepare(
  "UPDATE room_objects SET x = ?, y = ?, rotation = ?, scale = ?, updated_at = datetime('now') WHERE room_id = ? AND id = ?",
);
const deleteStmt = db.prepare("DELETE FROM room_objects WHERE room_id = ? AND id = ?");
const deleteRoomStmt = db.prepare("DELETE FROM room_objects WHERE room_id = ?");

export function listObjects(roomId: string): MapObject[] {
  return listStmt.all(roomId) as unknown as MapObject[];
}

const SCALE_MIN = 0.5;
const SCALE_MAX = 2.5;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const inMap = (v: unknown) => finite(v) && v >= 0 && v <= GRID_SIZE - 1;
const normAngle = (r: number) => ((r % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

// Fields a client may set, checked here; anything else is ignored.
export function parsePlacement(value: unknown, partial = false): Partial<Omit<MapObject, "id">> | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const out: Partial<Omit<MapObject, "id">> = {};
  if (!partial || v.kind !== undefined) {
    if (!OBJECT_KINDS.includes(v.kind as ObjectKind)) return null;
    out.kind = v.kind as ObjectKind;
  }
  for (const k of ["x", "y"] as const) {
    if (!partial || v[k] !== undefined) {
      if (!inMap(v[k])) return null;
      out[k] = v[k] as number;
    }
  }
  if (v.rotation !== undefined) {
    if (!finite(v.rotation)) return null;
    out.rotation = normAngle(v.rotation);
  }
  if (v.scale !== undefined) {
    if (!finite(v.scale) || v.scale < SCALE_MIN || v.scale > SCALE_MAX) return null;
    out.scale = v.scale;
  }
  return out;
}

export type ObjResult = { ok: true; object: MapObject } | { ok: false; status: number; error: string };

export function createObject(roomId: string, sessionId: string, p: Partial<Omit<MapObject, "id">>): ObjResult {
  if ((countStmt.get(roomId) as { c: number }).c >= MAX_OBJECTS_PER_ROOM) {
    return { ok: false, status: 409, error: `a map can hold up to ${MAX_OBJECTS_PER_ROOM} places` };
  }
  const row = insertStmt.run(roomId, p.kind!, p.x!, p.y!, p.rotation ?? 0, p.scale ?? 1, sessionId);
  return { ok: true, object: getStmt.get(roomId, Number(row.lastInsertRowid)) as unknown as MapObject };
}

export function updateObject(roomId: string, id: number, p: Partial<Omit<MapObject, "id">>): ObjResult {
  const current = getStmt.get(roomId, id) as unknown as MapObject | undefined;
  if (!current) return { ok: false, status: 404, error: "that place is no longer on the map" };
  const next = { ...current, ...p, kind: current.kind };
  updateStmt.run(next.x, next.y, next.rotation, next.scale, roomId, id);
  return { ok: true, object: next };
}

export function deleteObject(roomId: string, id: number): boolean {
  return deleteStmt.run(roomId, id).changes > 0;
}

// For versions: a map's objects travel with its terrain.
export function replaceObjects(roomId: string, objects: Omit<MapObject, "id">[], sessionId: string): void {
  deleteRoomStmt.run(roomId);
  for (const o of objects.slice(0, MAX_OBJECTS_PER_ROOM)) {
    insertStmt.run(roomId, o.kind, o.x, o.y, o.rotation, o.scale, sessionId);
  }
}
