// The gallery (Atlas Table stage A): maps their owners chose to show on the
// Atlas home page. Patterns from the stage A research (ROADMAP.md):
//  - Opt-in, and only by someone holding the edit link - the same rule as
//    Figma Community, where only people with edit access can publish.
//  - Listing exposes the *view* link, never the edit link: anyone may open a
//    gallery map and watch it, and (later, with versions) copy it, but only
//    the people the owner sent the edit link to can change it.
//  - The edit link can unpublish at any time, effective immediately.
//  - `hidden` is the moderation switch (set by the operator, never by the
//    API), so a reported map can be pulled without deleting anyone's data.
import { db } from "./db.ts";
import { personFor } from "./people.ts";
import { PUBLIC_ROOM_ID } from "./rooms-schema.ts";
import type { RoomAccess } from "./rooms.ts";

export interface Listing {
  name: string;
  viewToken: string;
  by: string;
  tincture: string;
  listedAt: string;
  cells: number;
}

// A gallery card for an empty sea helps nobody.
export const MIN_LAND_CELLS = 500;
export const GALLERY_MAX = 48;

const landCountStmt = db.prepare("SELECT count(*) c FROM terrain_cells WHERE room_id = ? AND elevation > 0");
const getStmt = db.prepare("SELECT hidden FROM room_listings WHERE room_id = ?");
const insertStmt = db.prepare(
  "INSERT INTO room_listings (room_id, listed_by) VALUES (?, ?) ON CONFLICT (room_id) DO UPDATE SET listed_by = excluded.listed_by, listed_at = datetime('now')",
);
const deleteStmt = db.prepare("DELETE FROM room_listings WHERE room_id = ?");
const listStmt = db.prepare(`
  SELECT r.name, r.view_token, l.listed_by, l.listed_at,
         (SELECT count(*) FROM terrain_cells t WHERE t.room_id = r.id AND t.elevation > 0) AS cells
  FROM room_listings l JOIN rooms r ON r.id = l.room_id
  WHERE l.hidden = 0 AND r.view_token IS NOT NULL
  ORDER BY l.listed_at DESC
  LIMIT ${GALLERY_MAX}
`);
const byViewTokenStmt = db.prepare(`
  SELECT r.id FROM room_listings l JOIN rooms r ON r.id = l.room_id
  WHERE r.view_token = ? AND l.hidden = 0
`);

export function isListed(roomId: string): boolean {
  const row = getStmt.get(roomId) as { hidden: number } | undefined;
  return !!row && row.hidden === 0;
}

export type PublishResult = { ok: true; listed: boolean } | { ok: false; status: number; error: string };

export function setListed(access: RoomAccess, sessionId: string, listed: boolean): PublishResult {
  if (access.isPublic || access.roomId === PUBLIC_ROOM_ID) {
    return { ok: false, status: 400, error: "the shared world is always on the Atlas" };
  }
  if (access.role !== "edit") return { ok: false, status: 403, error: "only the edit link can publish or unpublish a map" };
  const row = getStmt.get(access.roomId) as { hidden: number } | undefined;
  if (!listed) {
    // Unpublishing always works, and also clears an operator's hide flag
    // along with the listing - there's nothing left to hide.
    deleteStmt.run(access.roomId);
    return { ok: true, listed: false };
  }
  if (row?.hidden) return { ok: false, status: 403, error: "this map was taken off the gallery and can't be republished" };
  const land = (landCountStmt.get(access.roomId) as { c: number }).c;
  if (land < MIN_LAND_CELLS) return { ok: false, status: 400, error: "add some land before putting this map in the gallery" };
  insertStmt.run(access.roomId, sessionId);
  return { ok: true, listed: true };
}

export function listGallery(): Listing[] {
  const rows = listStmt.all() as { name: string; view_token: string; listed_by: string; listed_at: string; cells: number }[];
  return rows.map((r) => {
    const person = personFor(r.listed_by);
    return { name: r.name, viewToken: r.view_token, by: person.name, tincture: person.tincture, listedAt: r.listed_at, cells: r.cells };
  });
}

// The room behind a gallery card's picture, only while it's listed.
export function listedRoomByViewToken(viewToken: string): string | null {
  const row = byViewTokenStmt.get(viewToken) as { id: string } | undefined;
  return row?.id ?? null;
}
