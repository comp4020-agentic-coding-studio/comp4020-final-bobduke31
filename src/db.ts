import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const MARK_KINDS = ["flag", "campfire", "tent", "boat", "tree", "ruin"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export interface Mark {
  id: number;
  x: number;
  y: number;
  kind: MarkKind;
  sessionId: string;
  createdAt: string;
}

const dbPath = process.env.DB_PATH ?? "/data/app.db";
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    x REAL NOT NULL,
    y REAL NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

interface MarkRow {
  id: number;
  x: number;
  y: number;
  kind: string;
  session_id: string;
  created_at: string;
}

const rowToMark = (row: MarkRow): Mark => ({
  id: row.id,
  x: row.x,
  y: row.y,
  kind: row.kind as MarkKind,
  sessionId: row.session_id,
  createdAt: row.created_at,
});

const listStmt = db.prepare("SELECT * FROM marks ORDER BY id ASC");

export function listMarks(): Mark[] {
  return (listStmt.all() as unknown as MarkRow[]).map(rowToMark);
}

const insertStmt = db.prepare(
  "INSERT INTO marks (x, y, kind, session_id) VALUES (?, ?, ?, ?) RETURNING *",
);

export function insertMark(x: number, y: number, kind: MarkKind, sessionId: string): Mark {
  const row = insertStmt.get(x, y, kind, sessionId) as unknown as MarkRow;
  return rowToMark(row);
}

const getStmt = db.prepare("SELECT * FROM marks WHERE id = ?");
const deleteStmt = db.prepare("DELETE FROM marks WHERE id = ?");

export type DeleteMarkResult = "deleted" | "not-found" | "forbidden";

// A visitor may only remove marks their own session placed - checked here,
// next to session_id, rather than trusting the caller to have already filtered.
export function deleteMarkOwnedBy(id: number, sessionId: string): DeleteMarkResult {
  const row = getStmt.get(id) as unknown as MarkRow | undefined;
  if (!row) return "not-found";
  if (row.session_id !== sessionId) return "forbidden";
  deleteStmt.run(id);
  return "deleted";
}
