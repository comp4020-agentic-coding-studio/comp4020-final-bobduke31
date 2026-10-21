import { randomInt } from "node:crypto";
import { db } from "./db.ts";
import { displayNameFor } from "./identity.ts";

// Who a visitor is, as everyone else sees them: a cartographer's name and a
// heraldic tincture, generated on first visit and editable. Keyed by the
// anonymous session id (src/session.ts) - still no accounts. A session with
// no row yet falls back to the hashed label from identity.ts, so log rows
// written before this table existed still read sensibly.
//
// Naming approach follows fantasy-name-generator (ISC: names picked from
// curated tables), with our own tables shaped as "given name + cartographic
// epithet" so names sound like the people who'd draw a map. No code copied;
// see CREDITS.md.

export const TINCTURES = ["gules", "azure", "vert", "or", "purpure", "argent", "tenne", "celeste"] as const;
export type Tincture = (typeof TINCTURES)[number];

export const NAME_MAX = 32;

const GIVEN = [
  "Wren", "Brannoc", "Marrow", "Tamsin", "Aldric", "Isolde", "Corin", "Elowen", "Garrick", "Linnet",
  "Osric", "Rowan", "Sabine", "Tobin", "Una", "Bram", "Calla", "Dunstan", "Edda", "Fenn",
  "Hesper", "Ivo", "Jory", "Kestrel", "Lark", "Merrin", "Nell", "Perrin", "Quill", "Rook",
  "Sorrel", "Thane", "Vesna", "Wystan", "Yarrow", "Alder", "Briar", "Cadoc", "Delphine", "Emrys",
] as const;

const EPITHET = [
  "of the Vale", "of Saltmere", "of the Fells", "of Highmoor", "of the Reaches", "of Thornwick",
  "Greywater", "Hale", "Ashford", "Blackmere", "Stonebridge", "Fairwind", "Holloway", "Marchbank",
  "the Surveyor", "the Wanderer", "of the Isles", "Larkspur", "Coldharbour", "Windmere",
] as const;

export interface Person {
  name: string;
  tincture: Tincture;
}

const getStmt = db.prepare("SELECT name, tincture FROM people WHERE session_id = ?");
const insertStmt = db.prepare("INSERT OR IGNORE INTO people (session_id, name, tincture) VALUES (?, ?, ?)");
const updateStmt = db.prepare(
  "UPDATE people SET name = ?, tincture = ?, updated_at = datetime('now') WHERE session_id = ?",
);

function generate(): Person {
  return {
    name: `${GIVEN[randomInt(GIVEN.length)]} ${EPITHET[randomInt(EPITHET.length)]}`,
    tincture: TINCTURES[randomInt(TINCTURES.length)],
  };
}

// Read-only: never creates a row. Used for display (activity log, presence)
// where the session may predate this table.
export function personFor(sessionId: string): Person {
  const row = getStmt.get(sessionId) as Person | undefined;
  if (row) return row;
  // Deterministic fallback so the same old session always shows the same
  // label and colour, without writing anything.
  const label = displayNameFor(sessionId);
  let h = 0;
  for (const ch of sessionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { name: label, tincture: TINCTURES[h % TINCTURES.length] };
}

// Creates the row on first need (the editor's first load), then returns it.
export function ensurePerson(sessionId: string): Person & { isNew: boolean } {
  const existing = getStmt.get(sessionId) as Person | undefined;
  if (existing) return { ...existing, isNew: false };
  const fresh = generate();
  insertStmt.run(sessionId, fresh.name, fresh.tincture);
  // INSERT OR IGNORE: a concurrent first request may have won; read back.
  const row = getStmt.get(sessionId) as unknown as Person;
  return { ...row, isNew: true };
}

export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > NAME_MAX) return null;
  return name;
}

export function isTincture(value: unknown): value is Tincture {
  return typeof value === "string" && (TINCTURES as readonly string[]).includes(value);
}

export function updatePerson(sessionId: string, person: Person): Person {
  ensurePerson(sessionId);
  updateStmt.run(person.name, person.tincture, sessionId);
  return getStmt.get(sessionId) as unknown as Person;
}

export function suggestion(): Person {
  return generate();
}
