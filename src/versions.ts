// Map versions (Atlas Table stage B): named saves of a map's two grids, a
// checkpoint taken automatically before every restore, and "copy to a new
// world". Patterns from the stage B research (ROADMAP.md): Figma and Google
// Docs keep named versions next to automatic ones, and a restore is itself
// undoable because it first saves what it replaces.
//
// A version is the whole map, gzipped JSON in one row, never a diff: a
// 256x256 map is at most ~65k cells, which compresses to a few hundred KB at
// worst, and a self-contained row can be restored or copied without
// replaying anything.
import { gunzipSync, gzipSync } from "node:zlib";
import { db } from "./db.ts";
import { PUBLIC_ROOM_ID } from "./rooms-schema.ts";
import type { RoomAccess } from "./rooms.ts";
import {
  isValidCell,
  isValidTerrainTypeCell,
  listCells,
  listTerrainTypes,
  replaceTerrain,
  SEA_LEVEL,
  type TerrainCell,
  type TerrainTypeCell,
} from "./terrain.ts";

// Per map. When full, saving drops the oldest automatic checkpoint; named
// saves are only ever removed by a person.
export const MAX_VERSIONS = 30;
export const MAX_NAME = 60;

export type VersionKind = "named" | "checkpoint";
export interface VersionSummary {
  id: number;
  name: string;
  kind: VersionKind;
  createdAt: string;
  createdBy: string;
  cells: number;
}
export interface MapData {
  format: "atlas-table-map";
  version: 1;
  name?: string;
  elevation: TerrainCell[];
  types: TerrainTypeCell[];
}

const insertStmt = db.prepare(
  "INSERT INTO room_versions (room_id, name, kind, created_by, cells, data) VALUES (?, ?, ?, ?, ?, ?)",
);
const listStmt = db.prepare(
  "SELECT id, name, kind, created_by, created_at, cells FROM room_versions WHERE room_id = ? ORDER BY id DESC",
);
const getStmt = db.prepare("SELECT data FROM room_versions WHERE room_id = ? AND id = ?");
const countStmt = db.prepare("SELECT count(*) c FROM room_versions WHERE room_id = ?");
const oldestCheckpointStmt = db.prepare(
  "SELECT id FROM room_versions WHERE room_id = ? AND kind = 'checkpoint' ORDER BY id ASC LIMIT 1",
);
const deleteStmt = db.prepare("DELETE FROM room_versions WHERE room_id = ? AND id = ?");

export function mapDataFor(roomId: string, name?: string): MapData {
  return { format: "atlas-table-map", version: 1, name, elevation: listCells(roomId), types: listTerrainTypes(roomId) };
}

export function cleanVersionName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  return name && name.length <= MAX_NAME ? name : null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function canChange(access: RoomAccess): Result<null> {
  if (access.isPublic || access.roomId === PUBLIC_ROOM_ID) {
    return { ok: false, status: 400, error: "the shared world belongs to everyone, so it has no versions to save or restore" };
  }
  if (access.role !== "edit") return { ok: false, status: 403, error: "only the edit link can save or restore versions" };
  return { ok: true, value: null };
}

function insertVersion(roomId: string, name: string, kind: VersionKind, sessionId: string): Result<number> {
  if ((countStmt.get(roomId) as { c: number }).c >= MAX_VERSIONS) {
    const oldest = oldestCheckpointStmt.get(roomId) as { id: number } | undefined;
    if (!oldest) {
      return { ok: false, status: 409, error: `this map already has ${MAX_VERSIONS} named versions; delete one first` };
    }
    deleteStmt.run(roomId, oldest.id);
  }
  const data = mapDataFor(roomId);
  const blob = gzipSync(JSON.stringify({ elevation: data.elevation, types: data.types }));
  const row = insertStmt.run(roomId, name, kind, sessionId, data.elevation.length, blob);
  return { ok: true, value: Number(row.lastInsertRowid) };
}

export function saveVersion(access: RoomAccess, sessionId: string, name: string): Result<number> {
  const allowed = canChange(access);
  if (!allowed.ok) return allowed;
  return insertVersion(access.roomId, name, "named", sessionId);
}

export function listVersions(roomId: string): VersionSummary[] {
  return (listStmt.all(roomId) as { id: number; name: string; kind: VersionKind; created_by: string; created_at: string; cells: number }[]).map(
    (r) => ({ id: r.id, name: r.name, kind: r.kind, createdBy: r.created_by, createdAt: r.created_at, cells: r.cells }),
  );
}

function readVersion(roomId: string, id: number): { elevation: TerrainCell[]; types: TerrainTypeCell[] } | null {
  const row = getStmt.get(roomId, id) as { data: Uint8Array } | undefined;
  if (!row) return null;
  return JSON.parse(gunzipSync(row.data).toString("utf8"));
}

const nameStmt = db.prepare("SELECT name FROM room_versions WHERE room_id = ? AND id = ?");
function restoredName(roomId: string, id: number): string {
  return (nameStmt.get(roomId, id) as { name: string } | undefined)?.name ?? `version ${id}`;
}

// Restore: checkpoint what's there now (so the restore can be undone by
// restoring the checkpoint), then replace the map in one transaction.
export function restoreVersion(access: RoomAccess, sessionId: string, id: number): Result<{ checkpoint: number }> {
  const allowed = canChange(access);
  if (!allowed.ok) return allowed;
  const snapshot = readVersion(access.roomId, id);
  if (!snapshot) return { ok: false, status: 404, error: "no such version of this map" };
  // Short: the list shows when it was taken, so the name only says why.
  const checkpoint = insertVersion(access.roomId, `Before restoring "${restoredName(access.roomId, id)}"`.slice(0, MAX_NAME), "checkpoint", sessionId);
  if (!checkpoint.ok) return checkpoint;
  replaceTerrain(access.roomId, snapshot.elevation, snapshot.types);
  return { ok: true, value: { checkpoint: checkpoint.value } };
}

export function deleteVersion(access: RoomAccess, id: number): Result<null> {
  const allowed = canChange(access);
  if (!allowed.ok) return allowed;
  const row = getStmt.get(access.roomId, id);
  if (!row) return { ok: false, status: 404, error: "no such version of this map" };
  deleteStmt.run(access.roomId, id);
  return { ok: true, value: null };
}

// The data a "copy to a new world" starts from: a stored version, or the
// map as it is now when no version is given. Anyone who can see a map may
// copy it; the copy is theirs.
export function versionData(roomId: string, id: number | null): { elevation: TerrainCell[]; types: TerrainTypeCell[] } | null {
  return id === null ? mapDataFor(roomId) : readVersion(roomId, id);
}

// An uploaded map file, checked cell by cell exactly as painting is: a file
// can never put anything into the database a brush couldn't. Types on sea
// cells are dropped, as the paint route does.
export function parseMapData(value: unknown): { elevation: TerrainCell[]; types: TerrainTypeCell[] } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<MapData>;
  if (v.format !== "atlas-table-map" || v.version !== 1) return null;
  if (!Array.isArray(v.elevation) || !Array.isArray(v.types)) return null;
  if (!v.elevation.every(isValidCell) || !v.types.every(isValidTerrainTypeCell)) return null;
  const land = new Set(v.elevation.filter((c) => c.elevation > SEA_LEVEL).map((c) => `${c.x},${c.y}`));
  const dedupe = <T extends { x: number; y: number }>(list: T[]) => [...new Map(list.map((c) => [`${c.x},${c.y}`, c])).values()];
  return {
    elevation: dedupe(v.elevation.map(({ x, y, elevation }) => ({ x, y, elevation }))),
    types: dedupe(v.types.filter((t) => land.has(`${t.x},${t.y}`)).map(({ x, y, terrain }) => ({ x, y, terrain }))),
  };
}
