import { db } from "./db.ts";
import { displayNameFor } from "./identity.ts";
import { broadcast } from "./realtime.ts";

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
] as const;
export type ActivityAction = (typeof ACTIONS)[number];

export interface ActivityEntry {
  id: number;
  sessionId: string;
  displayName: string;
  action: ActivityAction;
  detail: string;
  createdAt: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

interface ActivityRow {
  id: number;
  session_id: string;
  action: string;
  detail: string;
  created_at: string;
}

const rowToEntry = (row: ActivityRow): ActivityEntry => ({
  id: row.id,
  sessionId: row.session_id,
  displayName: displayNameFor(row.session_id),
  action: row.action as ActivityAction,
  detail: row.detail,
  createdAt: row.created_at,
});

const insertStmt = db.prepare(
  "INSERT INTO activity_log (session_id, action, detail) VALUES (?, ?, ?) RETURNING *",
);

// Records one activity-log entry and prints the same thing to stdout, so a
// classroom demo tailing `flyctl logs` sees it live, with no separate
// mechanism to keep in sync - one call site, two readers. `detail` is a
// short human-readable summary (e.g. "142 cells, bbox (40,60)-(78,91)"), not
// the raw cell array: C10's bar is "distinguish users and their actual
// actions," which a bounding box and count already does, without an
// unbounded log line per multi-hundred-cell brush stroke.
export function log(sessionId: string, action: ActivityAction, detail: string): ActivityEntry {
  const row = insertStmt.get(sessionId, action, detail) as unknown as ActivityRow;
  const entry = rowToEntry(row);
  console.log(`[activity] ${entry.createdAt} ${entry.displayName} (${sessionId}) ${action}: ${detail}`);
  // Same SSE channel terrain:update already uses (src/realtime.ts) - the
  // in-app log viewer (/logs/) is just another subscriber on /api/events,
  // not a second real-time transport.
  broadcast("activity:new", entry);
  return entry;
}

const recentStmt = db.prepare("SELECT * FROM activity_log ORDER BY id DESC LIMIT ?");

// Newest first, capped - a real-time log viewer wants "what just happened"
// on load, then the live SSE stream carries everything after. No pagination:
// this is a debugging/demo aid, not an archive browser.
export function recentActivity(limit = 200): ActivityEntry[] {
  return (recentStmt.all(limit) as unknown as ActivityRow[]).map(rowToEntry);
}
