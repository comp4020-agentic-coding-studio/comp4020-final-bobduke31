import { randomBytes, randomUUID } from "node:crypto";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { db, dbPath } from "./db.ts";
// The cap counts maps with places or walls, so their tables must exist first.
import "./objects.ts";
import "./paths.ts";
import { PUBLIC_ROOM_ID, PUBLIC_ROOM_NAME } from "./rooms-schema.ts";

export { PUBLIC_ROOM_ID };

// ADR 3. A room is one map. The public room is editable by anyone and has
// no tokens. Every other room has two unguessable links: the token in the
// URL is the credential, resolved here to a room plus a role on every
// request. Nothing a client sends besides that token can raise its role.
export type Role = "edit" | "view";

export interface RoomAccess {
  roomId: string;
  name: string;
  role: Role;
  isPublic: boolean;
}

export const ROOM_NAME_MAX = 60;
// Measured: a fully painted room is ~4 MB on a 1 GB volume (ROADMAP.md,
// "Constraints measured"), so creation is capped in total and per session.
// The total counts only maps with something on them: an empty map is a few
// hundred bytes, and counting those let 136 untouched test maps fill the
// cap on production while the volume was 90% free (ROADMAP.md, v19).
export const MAX_ROOMS_TOTAL = 150;
export const MAX_ROOMS_PER_SESSION_PER_DAY = 10;
// And whatever the count, no new map once the volume is nearly full: the
// cap is a proxy for disk space, this checks the disk itself.
export const MIN_FREE_BYTES = 150 * 1024 * 1024;

// 128 bits, base64url: unguessable and safe in a URL path.
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const newToken = () => randomBytes(16).toString("base64url");

interface RoomRow {
  id: string;
  name: string;
  edit_token: string | null;
  view_token: string | null;
}

const byEditToken = db.prepare("SELECT id, name, edit_token, view_token FROM rooms WHERE edit_token = ?");
const byViewToken = db.prepare("SELECT id, name, edit_token, view_token FROM rooms WHERE view_token = ?");
const byId = db.prepare("SELECT id, name, edit_token, view_token FROM rooms WHERE id = ?");

export const PUBLIC_ACCESS: RoomAccess = { roomId: PUBLIC_ROOM_ID, name: PUBLIC_ROOM_NAME, role: "edit", isPublic: true };

export function resolveToken(token: string): RoomAccess | null {
  if (!TOKEN_RE.test(token)) return null;
  const edit = byEditToken.get(token) as RoomRow | undefined;
  if (edit) return { roomId: edit.id, name: edit.name, role: "edit", isPublic: false };
  const view = byViewToken.get(token) as RoomRow | undefined;
  if (view) return { roomId: view.id, name: view.name, role: "view", isPublic: false };
  return null;
}

// Share links are only ever handed to someone who already holds the edit
// token: a viewer must never learn it.
export function shareTokensFor(access: RoomAccess): { editToken: string; viewToken: string } | null {
  if (access.role !== "edit" || access.isPublic) return null;
  const row = byId.get(access.roomId) as RoomRow | undefined;
  if (!row?.edit_token || !row.view_token) return null;
  return { editToken: row.edit_token, viewToken: row.view_token };
}

export function cleanRoomName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters out, whitespace collapsed; rendered with textContent
  // on the client, so no HTML escaping is needed here.
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > ROOM_NAME_MAX) return null;
  return name;
}

const insertRoom = db.prepare(
  "INSERT INTO rooms (id, name, edit_token, view_token, created_by) VALUES (?, ?, ?, ?, ?)",
);
const countRooms = db.prepare(`
  SELECT count(*) c FROM rooms r WHERE r.id <> ? AND (
    EXISTS (SELECT 1 FROM terrain_cells WHERE room_id = r.id) OR
    EXISTS (SELECT 1 FROM terrain_type_cells WHERE room_id = r.id) OR
    EXISTS (SELECT 1 FROM room_objects WHERE room_id = r.id) OR
    EXISTS (SELECT 1 FROM room_paths WHERE room_id = r.id)
  )`);

function diskNearlyFull(): boolean {
  try {
    const fs = statfsSync(dirname(dbPath));
    return fs.bavail * fs.bsize < MIN_FREE_BYTES;
  } catch {
    return false; // can't tell (e.g. an unusual filesystem): fall back to the count
  }
}
const countRecentBySession = db.prepare(
  "SELECT count(*) c FROM rooms WHERE created_by = ? AND created_at > datetime('now', '-1 day')",
);

export type CreateResult =
  | { ok: true; access: RoomAccess; editToken: string; viewToken: string }
  | { ok: false; reason: "server-full" | "session-limit" };

export function createRoom(name: string, sessionId: string): CreateResult {
  if (diskNearlyFull() || (countRooms.get(PUBLIC_ROOM_ID) as { c: number }).c >= MAX_ROOMS_TOTAL) {
    return { ok: false, reason: "server-full" };
  }
  if ((countRecentBySession.get(sessionId) as { c: number }).c >= MAX_ROOMS_PER_SESSION_PER_DAY) {
    return { ok: false, reason: "session-limit" };
  }
  const id = randomUUID();
  const editToken = newToken();
  const viewToken = newToken();
  insertRoom.run(id, name, editToken, viewToken, sessionId);
  rememberRoom(sessionId, id, "edit");
  return { ok: true, access: { roomId: id, name, role: "edit", isPublic: false }, editToken, viewToken };
}

const renameStmt = db.prepare("UPDATE rooms SET name = ? WHERE id = ?");

export function renameRoom(access: RoomAccess, name: string): boolean {
  if (access.role !== "edit" || access.isPublic) return false;
  renameStmt.run(name, access.roomId);
  return true;
}

// "My maps": rooms this browser session has opened, with the strongest role
// it has held. Never lowers a role: opening your own map through its view
// link mustn't forget that you can edit it.
const rememberStmt = db.prepare(`
  INSERT INTO room_members (room_id, session_id, role, last_seen_at) VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT (session_id, room_id) DO UPDATE SET
    last_seen_at = excluded.last_seen_at,
    role = CASE WHEN room_members.role = 'edit' THEN 'edit' ELSE excluded.role END
`);

export function rememberRoom(sessionId: string, roomId: string, role: Role): void {
  if (roomId === PUBLIC_ROOM_ID) return;
  rememberStmt.run(roomId, sessionId, role);
}

const myRoomsStmt = db.prepare(`
  SELECT r.name, m.role, m.last_seen_at, r.edit_token, r.view_token,
         (SELECT count(*) FROM terrain_cells t WHERE t.room_id = r.id) AS cells
  FROM room_members m JOIN rooms r ON r.id = m.room_id
  WHERE m.session_id = ?
  ORDER BY m.last_seen_at DESC
  LIMIT 50
`);

export interface MyRoom {
  name: string;
  role: Role;
  lastSeenAt: string;
  token: string;
  cells: number;
}

// Each entry carries only the token this session is entitled to: the edit
// token if it has edited, else the view token.
export function roomsForSession(sessionId: string): MyRoom[] {
  const rows = myRoomsStmt.all(sessionId) as {
    name: string;
    role: Role;
    last_seen_at: string;
    edit_token: string;
    view_token: string;
    cells: number;
  }[];
  return rows.map((r) => ({
    name: r.name,
    role: r.role,
    lastSeenAt: r.last_seen_at,
    token: r.role === "edit" ? r.edit_token : r.view_token,
    cells: r.cells,
  }));
}

// Withdrawing a link (stage B): issue a fresh token for one role. The old
// token stops resolving immediately, so whoever held it is cut off; the
// other role's link keeps working. The caller must hold the edit link, and
// reissuing the edit link hands its new value back only to that caller.
// Like renaming, this updates the one column in place.
const reissueEditStmt = db.prepare("UPDATE rooms SET edit_token = ? WHERE id = ?");
const reissueViewStmt = db.prepare("UPDATE rooms SET view_token = ? WHERE id = ?");

export function reissueToken(access: RoomAccess, role: Role): { editToken: string; viewToken: string } | null {
  if (access.role !== "edit" || access.isPublic) return null;
  (role === "edit" ? reissueEditStmt : reissueViewStmt).run(newToken(), access.roomId);
  return shareTokensFor(access);
}
