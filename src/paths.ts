// Map paths (Atlas Table, after stage B): town walls, palisades and roads,
// drawn as a line of points rather than placed piece by piece. This is how
// the established map editors do it - Dungeondraft's Wall and Path tools and
// Wonderdraft's paths are click-a-point-at-a-time polylines whose points can
// be moved afterwards - and it is what lets walls join up: the renderer fits
// straight runs, towers at corners and ends, and a gatehouse wherever a road
// crosses a wall, from the line itself (terrain-renderer-3d.js).
//
// A shared canvas like places and terrain: anyone with the edit link may
// change any path, and the last write wins (ADR.md). Points are in cell
// units, fractional, like places.
import { db, GRID_SIZE } from "./db.ts";
import { isLand } from "./terrain.ts";

export const PATH_KINDS = ["wall", "palisade", "road"] as const;
export type PathKind = (typeof PATH_KINDS)[number];

export const MAX_PATHS_PER_ROOM = 200;
export const MAX_POINTS = 64;
// A point closer than this to the previous one adds nothing but noise.
const MIN_SEGMENT = 0.75;

export interface MapPath {
  id: number;
  kind: PathKind;
  points: [number, number][];
  closed: boolean;
}

export const PATHS_DDL = `
  CREATE TABLE IF NOT EXISTS room_paths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    kind TEXT NOT NULL,
    points TEXT NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS room_paths_room ON room_paths (room_id)
`;
db.exec(PATHS_DDL);

interface PathRow {
  id: number;
  kind: PathKind;
  points: string;
  closed: number;
}
const fromRow = (r: PathRow): MapPath => ({ id: r.id, kind: r.kind, points: JSON.parse(r.points), closed: r.closed === 1 });

const listStmt = db.prepare("SELECT id, kind, points, closed FROM room_paths WHERE room_id = ? ORDER BY id");
const countStmt = db.prepare("SELECT count(*) c FROM room_paths WHERE room_id = ?");
const insertStmt = db.prepare("INSERT INTO room_paths (room_id, kind, points, closed, created_by) VALUES (?, ?, ?, ?, ?)");
const getStmt = db.prepare("SELECT id, kind, points, closed FROM room_paths WHERE room_id = ? AND id = ?");
const updateStmt = db.prepare("UPDATE room_paths SET points = ?, closed = ?, updated_at = datetime('now') WHERE room_id = ? AND id = ?");
const deleteStmt = db.prepare("DELETE FROM room_paths WHERE room_id = ? AND id = ?");
const deleteRoomStmt = db.prepare("DELETE FROM room_paths WHERE room_id = ?");

export function listPaths(roomId: string): MapPath[] {
  return (listStmt.all(roomId) as unknown as PathRow[]).map(fromRow);
}

export function getPath(roomId: string, id: number): MapPath | undefined {
  const row = getStmt.get(roomId, id) as unknown as PathRow | undefined;
  return row && fromRow(row);
}

const inMap = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= GRID_SIZE - 1;

// Fields a client may set, checked here; anything else is ignored. Points
// are rounded to 1/100 cell and near-duplicates dropped, so a file or a
// scripted client can't store anything a pointer couldn't draw.
export function parsePath(value: unknown, partial = false): Partial<Omit<MapPath, "id">> | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const out: Partial<Omit<MapPath, "id">> = {};
  if (!partial || v.kind !== undefined) {
    if (!PATH_KINDS.includes(v.kind as PathKind)) return null;
    out.kind = v.kind as PathKind;
  }
  if (!partial || v.points !== undefined) {
    if (!Array.isArray(v.points) || v.points.length > MAX_POINTS) return null;
    const points: [number, number][] = [];
    for (const p of v.points) {
      if (!Array.isArray(p) || p.length !== 2 || !inMap(p[0]) || !inMap(p[1])) return null;
      const q: [number, number] = [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
      const last = points.at(-1);
      if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < MIN_SEGMENT) continue;
      points.push(q);
    }
    if (points.length < 2) return null;
    out.points = points;
  }
  if (v.closed !== undefined) {
    if (typeof v.closed !== "boolean") return null;
    out.closed = v.closed;
  }
  if (out.closed && out.points && out.points.length < 3) return null;
  return out;
}

// A wall or palisade is built on land, so every point must be; it may
// cross a narrow inlet between them (a wall across a stream is fine). A
// road may also cross water - the renderer draws a bridge or ford there.
export function pathOnLand(roomId: string, p: Partial<Omit<MapPath, "id">>): boolean {
  if (!p.points) return true;
  return p.points.every(([x, y]) => isLand(roomId, Math.round(x), Math.round(y)));
}

export type PathResult = { ok: true; path: MapPath } | { ok: false; status: number; error: string };

export function createPath(roomId: string, sessionId: string, p: Partial<Omit<MapPath, "id">>): PathResult {
  if ((countStmt.get(roomId) as { c: number }).c >= MAX_PATHS_PER_ROOM) {
    return { ok: false, status: 409, error: `a map can hold up to ${MAX_PATHS_PER_ROOM} walls and roads` };
  }
  const row = insertStmt.run(roomId, p.kind!, JSON.stringify(p.points), p.closed ? 1 : 0, sessionId);
  return { ok: true, path: getPath(roomId, Number(row.lastInsertRowid))! };
}

export function updatePath(roomId: string, id: number, p: Partial<Omit<MapPath, "id">>): PathResult {
  const current = getPath(roomId, id);
  if (!current) return { ok: false, status: 404, error: "that wall or road is no longer on the map" };
  const next = { ...current, ...p, kind: current.kind };
  if (next.closed && next.points.length < 3) return { ok: false, status: 400, error: "a closed ring needs at least three points" };
  updateStmt.run(JSON.stringify(next.points), next.closed ? 1 : 0, roomId, id);
  return { ok: true, path: next };
}

export function deletePath(roomId: string, id: number): boolean {
  return deleteStmt.run(roomId, id).changes > 0;
}

// For versions: a map's paths travel with its terrain and places.
export function replacePaths(roomId: string, paths: Omit<MapPath, "id">[], sessionId: string): void {
  deleteRoomStmt.run(roomId);
  for (const p of paths.slice(0, MAX_PATHS_PER_ROOM)) {
    insertStmt.run(roomId, p.kind, JSON.stringify(p.points), p.closed ? 1 : 0, sessionId);
  }
}
