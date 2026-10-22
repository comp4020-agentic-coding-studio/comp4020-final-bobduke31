import { db } from "./db.ts";
import { personFor } from "./people.ts";
import { broadcast } from "./realtime.ts";
import { PUBLIC_ROOM_ID } from "./rooms-schema.ts";

// C10 requires server-side activity logs that distinguish users and their
// actual actions, and that "outlive the crit" - not something bolted on for
// demo day. This table is that persistent record: it lives in the same
// SQLite file as everything else (the only storage that survives a restart
// or redeploy, per fly.toml), so a log entry from last week is still here
// after a machine restart, not just for the duration of one process.
//
// Separately, every entry is also written to stdout (see `log` below) -
// that's what the crit's own demo format asks for directly: "narrate from
// the logs" via `mise exec -- flyctl logs -a <repo>` tailed live, no
// clicking through the UI. The SQLite table and the stdout line are the same
// event recorded twice, for two different readers: a human tailing
// `flyctl logs` during the crit, and the in-app real-time log viewer
// (`/logs/`, `GET /api/activity`, `terrain:update`'s sibling SSE event
// `activity:new` on the existing `/api/events` stream - see realtime.ts)
// that's this app's own tool for reading these logs later, per the brief's
// framing: "what you and your agent read when the deployed app misbehaves."
export const ACTIONS = [
  "terrain:paint",
  "terrain:undo",
  "terrain-type:paint",
  "mark:create",
  "mark:delete",
  "room:create",
  "room:rename",
  "room:forge",
  "room:publish",
  "room:version-save",
  "room:version-restore",
  "room:version-delete",
  "room:copy",
  "room:import",
  "room:link-reissue",
  "person:rename",
] as const;
export type ActivityAction = (typeof ACTIONS)[number];

// Deliberately no session id: entries go to every visitor (GET
// /api/activity and the SSE feed), and the session cookie is the only
// credential behind undo / mark-delete ownership. The raw id stays in the
// DB and the server's stdout log for operators.
export interface ActivityEntry {
  id: number;
  displayName: string;
  tincture: string;
  action: ActivityAction;
  detail: string;
  createdAt: string;
}

// Table created by src/rooms-schema.ts (keyed to a room since ADR 3).

interface ActivityRow {
  id: number;
  room_id: string;
  session_id: string;
  action: string;
  detail: string;
  created_at: string;
}

// The name shown is the person's *current* name, so a rename reads through
// their whole history - what you'd expect of a name, not a frozen label.
const rowToEntry = (row: ActivityRow): ActivityEntry => {
  const person = personFor(row.session_id);
  return {
    id: row.id,
    displayName: person.name,
    tincture: person.tincture,
    action: row.action as ActivityAction,
    detail: row.detail,
    createdAt: row.created_at,
  };
};

const insertStmt = db.prepare(
  "INSERT INTO activity_log (room_id, session_id, action, detail) VALUES (?, ?, ?, ?) RETURNING *",
);

// Records one activity-log entry and prints the same thing to stdout, so a
// classroom demo tailing `flyctl logs` sees it live, with no separate
// mechanism to keep in sync - one call site, two readers. `detail` is a
// short human-readable summary (e.g. "142 cells, bbox (40,60)-(78,91)"), not
// the raw cell array: C10's bar is "distinguish users and their actual
// actions," which a bounding box and count already does, without an
// unbounded log line per multi-hundred-cell brush stroke.
//
// Scoped to a room: an entry is broadcast only on that room's own stream,
// so a private map's activity never reaches the public /logs/ viewer (which
// subscribes to the public room's stream). stdout still carries everything,
// for the operator.
export function log(roomId: string, sessionId: string, action: ActivityAction, detail: string): ActivityEntry {
  const row = insertStmt.get(roomId, sessionId, action, detail) as unknown as ActivityRow;
  const entry = rowToEntry(row);
  const where = roomId === PUBLIC_ROOM_ID ? "" : ` [room ${roomId}]`;
  console.log(`[activity] ${entry.createdAt} ${entry.displayName} (${sessionId})${where} ${action}: ${detail}`);
  broadcast(roomId, "activity:new", entry);
  return entry;
}

const roomsActiveStmt = db.prepare("SELECT DISTINCT room_id FROM activity_log WHERE session_id = ?");

// Rooms where this session has left anything in the log - where a later
// rename of theirs is worth recording.
export function roomsWithActivityBy(sessionId: string): string[] {
  return (roomsActiveStmt.all(sessionId) as { room_id: string }[]).map((r) => r.room_id);
}

const recentStmt = db.prepare("SELECT * FROM activity_log WHERE room_id = ? ORDER BY id DESC LIMIT ?");

// Newest first, capped - a real-time log viewer wants "what just happened"
// on load, then the live SSE stream carries everything after. No pagination:
// this is a debugging/demo aid, not an archive browser.
export function recentActivity(roomId: string, limit = 200): ActivityEntry[] {
  return (recentStmt.all(roomId, limit) as unknown as ActivityRow[]).map(rowToEntry);
}
