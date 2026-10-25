import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { renderReadmePage, renderCreditsPage } from "./render-readme.ts";
import { listMarks, insertMark, deleteMarkOwnedBy, MARK_KINDS } from "./db.ts";
import type { Mark, MarkKind } from "./db.ts";
import { resolveSession } from "./session.ts";
import {
  listCells,
  applyCells,
  isValidCell,
  listTerrainTypes,
  applyTerrainTypes,
  isValidTerrainTypeCell,
  isLand,
  replaceTerrain,
} from "./terrain.ts";
import type { TerrainCell, TerrainTypeCell } from "./terrain.ts";
import { subscribe, broadcast, closeTagged } from "./realtime.ts";
import { log as logActivity, recentActivity, roomsWithActivityBy } from "./activity.ts";
import type { ActivityAction } from "./activity.ts";
import { recordPathChange, captureStroke, forgetRoom, recordPlaceChange, recordStrokeResult, undoDepth, undoLast } from "./undo.ts";
import { parseForge, forgeIntoRoom } from "./forge.ts";
import { thumbnailFor, type ThumbSize } from "./thumbnail.ts";
import { isListed, listGallery, listedRoomByViewToken, setListed } from "./gallery.ts";
import {
  cleanVersionName,
  deleteVersion,
  listVersions,
  mapDataFor,
  MAX_NAME as VERSION_NAME_MAX,
  parseMapData,
  restoreVersion,
  saveVersion,
  versionData,
  applySnapshot,
  type Snapshot,
} from "./versions.ts";
import { createObject, deleteObject, getObject, listObjects, parsePlacement, standsOnLand, updateObject } from "./objects.ts";
import { createPath, deletePath, getPath, listPaths, parsePath, pathOnLand, updatePath } from "./paths.ts";
import {
  PUBLIC_ACCESS,
  PUBLIC_ROOM_ID,
  ROOM_NAME_MAX,
  MAX_ROOMS_PER_SESSION_PER_DAY,
  cleanRoomName,
  createRoom,
  rememberRoom,
  renameRoom,
  reissueToken,
  resolveToken,
  roomsForSession,
  shareTokensFor,
} from "./rooms.ts";
import type { RoomAccess } from "./rooms.ts";
import { join as joinPresence, presenceFor, refreshPresenceFor, roomsOpenBy } from "./presence.ts";
import { ensurePerson, cleanName, isTincture, updatePerson, suggestion, TINCTURES, NAME_MAX } from "./people.ts";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  // PROTOTYPE TRIAL (final-redesign-prototype branch): needed to serve
  // vendored glTF assets (.gltf JSON + its sibling .bin buffer) for the
  // Oblique view's real mesh trial - see terrain-renderer-3d.js.
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

interface StaticFile {
  body: Buffer;
  type: string;
}

async function serveStatic(urlPath: string): Promise<StaticFile | null> {
  const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return null;
  try {
    const body = await readFile(filePath);
    const type = MIME[extname(filePath)] ?? "application/octet-stream";
    return { body, type };
  } catch {
    return null;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  // Well above any real client flush (a few hundred cells); caps what a
  // malicious client can make the small production machine buffer.
  const MAX_BODY_BYTES = 4 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new Error("request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length ? JSON.parse(raw) : {};
}

function isMarkKind(value: unknown): value is MarkKind {
  return typeof value === "string" && (MARK_KINDS as readonly string[]).includes(value);
}

function isPercentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

// A short, bounded summary for the activity log - a count and bounding box,
// not the raw cell array, so a several-hundred-cell brush stroke logs as one
// legible line instead of flooding `flyctl logs` with per-cell noise. See
// src/activity.ts's own comment on why detail is a summary, not a dump.
// One grid's worth: a real flush is far smaller, and this bounds the
// per-request DB transaction, undo snapshot and SSE broadcast size.
const MAX_CELLS_PER_BATCH = 256 * 256;

// Names one brush gesture so all its batches undo together (src/undo.ts).
// Optional and free-form: it only groups the caller's own writes.
function strokeIdOf(payload: Record<string, unknown>): string | undefined {
  const id = payload.strokeId;
  return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : undefined;
}

function cellsSummary(cells: { x: number; y: number }[]): string {
  // A loop, not Math.min(...xs): spreading a large array overflows the stack.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cells) {
    x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x); y1 = Math.max(y1, c.y);
  }
  const bbox = `(${x0},${y0})-(${x1},${y1})`;
  return `${cells.length} cell${cells.length === 1 ? "" : "s"}, bbox ${bbox}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonOr400(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  try {
    const payload = await readJsonBody(req);
    return (payload ?? {}) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return null;
  }
}

const PUBLIC_ROOM_PATHS = new Set([
  "/api/room",
  "/api/room/name",
  "/api/room/thumbnail.png",
  "/api/terrain",
  "/api/terrain-types",
  "/api/terrain/cells",
  "/api/terrain/types",
  "/api/terrain/undo",
  "/api/events",
  "/api/activity",
  "/api/objects",
  "/api/objects/update",
  "/api/objects/delete",
  "/api/paths",
  "/api/paths/update",
  "/api/paths/delete",
]);

const DENIED_ACTION = {
  "/api/terrain/cells": "terrain:paint",
  "/api/terrain/types": "terrain-type:paint",
  "/api/terrain/undo": "terrain:undo",
  "/api/room/name": "room:rename",
  "/api/room/listing": "room:publish",
  "/api/room/versions": "room:version-save",
  "/api/room/versions/restore": "room:version-restore",
  "/api/room/versions/delete": "room:version-delete",
  "/api/room/links/reissue": "room:link-reissue",
  "/api/objects": "object:place",
  "/api/objects/update": "object:move",
  "/api/objects/delete": "object:remove",
  "/api/paths": "path:draw",
  "/api/paths/update": "path:edit",
  "/api/paths/delete": "path:remove",
} as const satisfies Record<string, ActivityAction>;
const WRITE_PATHS = new Set(Object.keys(DENIED_ACTION));

// Fixed-window per-session limit on room creation and renames, on top of
// the stored per-day cap in rooms.ts: those actions write rows that persist.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 8;
const rateHits = new Map<string, { start: number; n: number }>();
// Placing and moving objects is ordinary editing, not row creation like a
// new map: a much higher ceiling, still bounded.
const OBJECT_RATE_MAX = 240;

function rateLimited(sessionId: string, max = RATE_MAX): boolean {
  const now = Date.now();
  const hit = rateHits.get(sessionId);
  if (!hit || now - hit.start > RATE_WINDOW_MS) {
    rateHits.set(sessionId, { start: now, n: 1 });
    if (rateHits.size > 10_000) rateHits.clear();
    return false;
  }
  return ++hit.n > max;
}

// Where a rename gets logged: rooms the person has open now or has
// activity in. Someone who has never touched the shared world doesn't
// appear in its public log just for renaming themselves.
function roomsForRename(sessionId: string): string[] {
  return [...new Set([...roomsOpenBy(sessionId), ...roomsWithActivityBy(sessionId)])];
}

// The two non-Forge ways to start a map. `copyFrom` is any link to an
// existing map (edit or view - seeing a map is enough to copy it, as in
// Figma's "duplicate"); `version` picks a stored version of it. `import` is
// an uploaded map file, validated cell by cell (src/versions.ts).
type Start =
  | { ok: true; data: Snapshot; action: "room:copy" | "room:import"; detail: string }
  | { ok: false; status: number; error: string };
function startingTerrain(payload: Record<string, unknown>): Start | null {
  if (payload.copyFrom !== undefined) {
    const source = typeof payload.copyFrom === "string" ? resolveToken(payload.copyFrom) : null;
    if (!source) return { ok: false, status: 404, error: "no map at that link to copy" };
    const id = payload.version === undefined ? null : Number(payload.version);
    if (id !== null && !Number.isInteger(id)) return { ok: false, status: 400, error: "version must be a version id" };
    const data = versionData(source.roomId, id);
    if (!data) return { ok: false, status: 404, error: "no such version of that map" };
    return { ok: true, data, action: "room:copy", detail: `copied from "${source.name}"${id === null ? "" : ` (version ${id})`}` };
  }
  if (payload.import !== undefined) {
    const data = parseMapData(payload.import);
    if (!data) return { ok: false, status: 400, error: "that isn't an Atlas Table map file, or it has cells outside the map" };
    return { ok: true, data, action: "room:import", detail: `imported from a map file (${data.elevation.length} cells)` };
  }
  return null;
}

async function handleCreateRoom(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
  const payload = await readJsonOr400(req, res);
  if (!payload) return;
  const name = cleanRoomName(payload.name);
  if (!name) {
    sendJson(res, 400, { error: `a map name is 1-${ROOM_NAME_MAX} characters` });
    return;
  }
  // Optional: start from the Forge instead of an empty sea. Only the seed,
  // template and sliders are accepted; the server generates the cells.
  const forge = payload.forge === undefined ? null : parseForge(payload.forge);
  if (payload.forge !== undefined && !forge) {
    sendJson(res, 400, { error: "forge needs a seed and one of the templates" });
    return;
  }
  // Or start from an existing map (stage B): a copy of any map the caller
  // can see, at a stored version or as it is now, or an uploaded map file.
  const start = startingTerrain(payload);
  if (start && !start.ok) {
    sendJson(res, start.status, { error: start.error });
    return;
  }
  if (rateLimited(sessionId)) {
    sendJson(res, 429, { error: "too many maps created just now - try again in a minute" });
    return;
  }
  const result = createRoom(name, sessionId);
  if (!result.ok) {
    const error =
      result.reason === "server-full"
        ? "this server has reached its map limit"
        : `you can create up to ${MAX_ROOMS_PER_SESSION_PER_DAY} maps a day`;
    sendJson(res, 429, { error });
    return;
  }
  logActivity(result.access.roomId, sessionId, "room:create", `"${name}"`);
  if (start?.ok) {
    applySnapshot(result.access.roomId, start.data, sessionId);
    logActivity(result.access.roomId, sessionId, start.action, start.detail);
  } else if (forge && forge.template !== "blank") {
    forgeIntoRoom(result.access.roomId, forge);
    logActivity(result.access.roomId, sessionId, "room:forge", `${forge.template} from seed "${forge.seed}"`);
  }
  sendJson(res, 201, { name, editToken: result.editToken, viewToken: result.viewToken });
}

// Every room-scoped API route, public or private. Returns false for a path
// it doesn't own so the caller can fall through to a 404. Writes are
// checked here, once, against the role the server resolved from the URL
// token - there is no request field that can raise it.
function thumbSizeOf(req: IncomingMessage): ThumbSize {
  const size = new URL(req.url ?? "/", "http://x").searchParams.get("size");
  return size === "og" || size === "full" ? size : "card";
}

// Map pictures change only when the terrain does; the ETag carries the
// terrain revision, so a revisit costs a 304 and an edit shows next load.
function sendThumbnail(req: IncomingMessage, res: ServerResponse, roomId: string, size: ThumbSize): void {
  const thumb = thumbnailFor(roomId, size);
  const headers = { ETag: thumb.etag, "Cache-Control": "no-cache" };
  if (req.headers["if-none-match"] === thumb.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "Content-Type": "image/png", "Content-Length": thumb.png.length });
  res.end(thumb.png);
}

async function handleRoomApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  access: RoomAccess,
  sessionId: string,
): Promise<boolean> {
  const { roomId } = access;
  const isWrite = req.method === "POST" && WRITE_PATHS.has(path);
  if (isWrite && access.role !== "edit") {
    // Logged, but rate-limited: a scripted view link mustn't be able to
    // grow the persisted log without bound by hammering refused writes.
    if (!rateLimited(`denied:${sessionId}`)) {
      logActivity(roomId, sessionId, DENIED_ACTION[path as keyof typeof DENIED_ACTION], `DENIED ${path} (view-only link)`);
    }
    sendJson(res, 403, { error: "this is a view-only link - ask for the edit link to make changes" });
    return true;
  }

  if (path === "/api/room" && req.method === "GET") {
    if (!access.isPublic) rememberRoom(sessionId, roomId, access.role);
    const share = shareTokensFor(access);
    sendJson(res, 200, {
      name: access.name,
      role: access.role,
      isPublic: access.isPublic,
      ...(share ?? {}),
      ...(access.isPublic ? {} : { listed: isListed(roomId) }),
      present: presenceFor(roomId),
    });
    return true;
  }

  if (path === "/api/room/name" && req.method === "POST") {
    const payload = await readJsonOr400(req, res);
    if (!payload) return true;
    const name = cleanRoomName(payload.name);
    if (!name || access.isPublic) {
      sendJson(res, 400, { error: access.isPublic ? "the shared world can't be renamed" : `a map name is 1-${ROOM_NAME_MAX} characters` });
      return true;
    }
    if (rateLimited(sessionId)) {
      sendJson(res, 429, { error: "too many renames just now - try again in a minute" });
      return true;
    }
    renameRoom(access, name);
    broadcast(roomId, "room:update", { name });
    logActivity(roomId, sessionId, "room:rename", `"${name}"`);
    res.writeHead(204);
    res.end();
    return true;
  }

  if (path === "/api/room/thumbnail.png" && req.method === "GET") {
    sendThumbnail(req, res, roomId, thumbSizeOf(req));
    return true;
  }

  if (path === "/api/room/listing" && req.method === "POST") {
    const payload = await readJsonOr400(req, res);
    if (!payload) return true;
    if (typeof payload.listed !== "boolean") {
      sendJson(res, 400, { error: "listed must be true or false" });
      return true;
    }
    if (rateLimited(sessionId)) {
      sendJson(res, 429, { error: "too many changes just now - try again in a minute" });
      return true;
    }
    const result = setListed(access, sessionId, payload.listed);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    logActivity(roomId, sessionId, "room:publish", result.listed ? "listed in the gallery" : "taken out of the gallery");
    sendJson(res, 200, { listed: result.listed });
    return true;
  }

  // Withdraw a link (stage B): a fresh token for one role; streams on the
  // old one are closed and their holders lose access at once.
  if (path === "/api/room/links/reissue" && req.method === "POST") {
    const payload = await readJsonOr400(req, res);
    if (!payload) return true;
    if (payload.role !== "edit" && payload.role !== "view") {
      sendJson(res, 400, { error: "role must be edit or view" });
      return true;
    }
    if (access.isPublic) {
      sendJson(res, 400, { error: "the shared world has no links to withdraw" });
      return true;
    }
    if (rateLimited(sessionId)) {
      sendJson(res, 429, { error: "too many changes just now - try again in a minute" });
      return true;
    }
    const tokens = reissueToken(access, payload.role);
    if (!tokens) {
      sendJson(res, 403, { error: "only the edit link can withdraw links" });
      return true;
    }
    logActivity(roomId, sessionId, "room:link-reissue", `new ${payload.role} link; the old one no longer works`);
    closeTagged(roomId, payload.role, "link:withdrawn", { role: payload.role });
    sendJson(res, 200, tokens);
    return true;
  }

  if (path === "/api/room/versions" && req.method === "GET") {
    sendJson(res, 200, access.isPublic ? [] : listVersions(roomId));
    return true;
  }

  if (path === "/api/room/versions" && req.method === "POST") {
    const payload = await readJsonOr400(req, res);
    if (!payload) return true;
    const name = cleanVersionName(payload.name);
    if (!name) {
      sendJson(res, 400, { error: `a version name is 1-${VERSION_NAME_MAX} characters` });
      return true;
    }
    if (rateLimited(sessionId)) {
      sendJson(res, 429, { error: "too many saves just now - try again in a minute" });
      return true;
    }
    const result = saveVersion(access, sessionId, name);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    logActivity(roomId, sessionId, "room:version-save", `"${name}"`);
    broadcast(roomId, "versions:update", {});
    sendJson(res, 201, { id: result.value });
    return true;
  }

  if ((path === "/api/room/versions/restore" || path === "/api/room/versions/delete") && req.method === "POST") {
    const payload = await readJsonOr400(req, res);
    if (!payload) return true;
    const id = Number(payload.id);
    if (!Number.isInteger(id)) {
      sendJson(res, 400, { error: "id must be a version id" });
      return true;
    }
    if (rateLimited(sessionId)) {
      sendJson(res, 429, { error: "too many changes just now - try again in a minute" });
      return true;
    }
    if (path.endsWith("/delete")) {
      const result = deleteVersion(access, id);
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return true;
      }
      logActivity(roomId, sessionId, "room:version-delete", `version ${id}`);
      broadcast(roomId, "versions:update", {});
      res.writeHead(204);
      res.end();
      return true;
    }
    const result = restoreVersion(access, sessionId, id);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    logActivity(roomId, sessionId, "room:version-restore", `version ${id} (checkpoint ${result.value.checkpoint} saved first)`);
    // Everyone with the map open reloads it; per-cell events would be
    // tens of thousands of cells.
    forgetRoom(roomId);
    broadcast(roomId, "terrain:reload", {});
    broadcast(roomId, "versions:update", {});
    sendJson(res, 200, { checkpoint: result.value.checkpoint });
    return true;
  }

  // Export (stage B): the map's data as a file that can be imported again.
  if (path === "/api/room/export.json" && req.method === "GET") {
    const body = JSON.stringify(mapDataFor(roomId, access.name));
    const file = access.name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "map";
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${file}.atlas.json"`,
    });
    res.end(body);
    return true;
  }

  // Places on the map (stage B). Writes are edit-only through WRITE_PATHS
  // above; every change is broadcast so all open maps update live.
  if (path === "/api/objects" && req.method === "GET") {
    sendJson(res, 200, listObjects(roomId));
    return true;
  }

  if ((path === "/api/objects" || path === "/api/objects/update" || path === "/api/objects/delete") && req.method === "POST") {
    const payload = await readJsonOr400(req, res);
    if (!payload) return true;
    if (rateLimited(`objects:${sessionId}`, OBJECT_RATE_MAX)) {
      sendJson(res, 429, { error: "too many changes just now - try again in a moment" });
      return true;
    }
    if (path === "/api/objects") {
      const placement = parsePlacement(payload);
      if (!placement) {
        sendJson(res, 400, { error: "a place needs a known kind and a position on the map" });
        return true;
      }
      if (!standsOnLand(roomId, placement)) {
        sendJson(res, 400, { error: "that's water - places stand on land (a bridge can cross water)" });
        return true;
      }
      const result = createObject(roomId, sessionId, placement);
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return true;
      }
      recordPlaceChange(roomId, sessionId, null, result.object);
      broadcast(roomId, "objects:upsert", result.object);
      logActivity(roomId, sessionId, "object:place", `${result.object.kind} at ${result.object.x.toFixed(1)},${result.object.y.toFixed(1)}`);
      sendJson(res, 201, result.object);
      return true;
    }
    const id = Number(payload.id);
    if (!Number.isInteger(id)) {
      sendJson(res, 400, { error: "id must be a place id" });
      return true;
    }
    if (path === "/api/objects/delete") {
      const removed = getObject(roomId, id);
      if (!removed || !deleteObject(roomId, id)) {
        sendJson(res, 404, { error: "that place is no longer on the map" });
        return true;
      }
      recordPlaceChange(roomId, sessionId, removed, null);
      broadcast(roomId, "objects:delete", { id });
      logActivity(roomId, sessionId, "object:remove", `place ${id}`);
      res.writeHead(204);
      res.end();
      return true;
    }
    const changes = parsePlacement(payload, true);
    if (!changes || changes.kind !== undefined) {
      sendJson(res, 400, { error: "a move needs a position on the map, a rotation or a scale" });
      return true;
    }
    const previous = getObject(roomId, id);
    const kind = previous?.kind;
    if (kind && changes.x !== undefined && !standsOnLand(roomId, { ...changes, kind })) {
      sendJson(res, 400, { error: "that's water - places stand on land (a bridge can cross water)" });
      return true;
    }
    const result = updateObject(roomId, id, changes);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    if (previous) recordPlaceChange(roomId, sessionId, previous, result.object);
    broadcast(roomId, "objects:upsert", result.object);
    // Moves are frequent; the log records them without flooding it.
    if (!rateLimited(`objlog:${sessionId}`)) logActivity(roomId, sessionId, "object:move", `${result.object.kind} ${id}`);
    sendJson(res, 200, result.object);
    return true;
  }

  // Walls, palisades and roads: drawn as a line of points (src/paths.ts).
  // Same rules as places - edit-only through WRITE_PATHS, every change
  // broadcast, each one undoable by the person who made it.
  if (path === "/api/paths" && req.method === "GET") {
    sendJson(res, 200, listPaths(roomId));
    return true;
  }

  if ((path === "/api/paths" || path === "/api/paths/update" || path === "/api/paths/delete") && req.method === "POST") {
    const payload = await readJsonOr400(req, res);
    if (!payload) return true;
    if (rateLimited(`objects:${sessionId}`, OBJECT_RATE_MAX)) {
      sendJson(res, 429, { error: "too many changes just now - try again in a moment" });
      return true;
    }
    if (path === "/api/paths") {
      const drawn = parsePath(payload);
      if (!drawn) {
        sendJson(res, 400, { error: "a wall or road needs a known kind and at least two points on the map" });
        return true;
      }
      if (drawn.kind !== "road" && !pathOnLand(roomId, drawn)) {
        sendJson(res, 400, { error: "walls stand on land - every corner needs to be on land" });
        return true;
      }
      const result = createPath(roomId, sessionId, drawn);
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return true;
      }
      recordPathChange(roomId, sessionId, null, result.path);
      broadcast(roomId, "paths:upsert", result.path);
      logActivity(roomId, sessionId, "path:draw", `${result.path.kind}, ${result.path.points.length} points`);
      sendJson(res, 201, result.path);
      return true;
    }
    const id = Number(payload.id);
    if (!Number.isInteger(id)) {
      sendJson(res, 400, { error: "id must be a wall or road id" });
      return true;
    }
    const previous = getPath(roomId, id);
    if (!previous) {
      sendJson(res, 404, { error: "that wall or road is no longer on the map" });
      return true;
    }
    if (path === "/api/paths/delete") {
      deletePath(roomId, id);
      recordPathChange(roomId, sessionId, previous, null);
      broadcast(roomId, "paths:delete", { id });
      logActivity(roomId, sessionId, "path:remove", `${previous.kind} ${id}`);
      res.writeHead(204);
      res.end();
      return true;
    }
    const changes = parsePath(payload, true);
    if (!changes || changes.kind !== undefined) {
      sendJson(res, 400, { error: "an edit needs the points (at least two, on the map) or whether it's closed" });
      return true;
    }
    if (previous.kind !== "road" && !pathOnLand(roomId, changes)) {
      sendJson(res, 400, { error: "walls stand on land - every corner needs to be on land" });
      return true;
    }
    const result = updatePath(roomId, id, changes);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    recordPathChange(roomId, sessionId, previous, result.path);
    broadcast(roomId, "paths:upsert", result.path);
    if (!rateLimited(`objlog:${sessionId}`)) logActivity(roomId, sessionId, "path:edit", `${result.path.kind} ${id}`);
    sendJson(res, 200, result.path);
    return true;
  }

  if (path === "/api/terrain" && req.method === "GET") {
    sendJson(res, 200, listCells(roomId));
    return true;
  }

  if (path === "/api/terrain-types" && req.method === "GET") {
    sendJson(res, 200, listTerrainTypes(roomId));
    return true;
  }

  if (path === "/api/terrain/cells" && req.method === "POST") {
    const payload = await readJsonOr400(req, res);
    if (!payload) return true;
    const { cells } = payload;
    const strokeId = strokeIdOf(payload);
    if (!Array.isArray(cells) || cells.length === 0 || cells.length > MAX_CELLS_PER_BATCH || !cells.every(isValidCell)) {
      sendJson(res, 400, { error: "cells must be a non-empty array of {x, y, elevation} within grid bounds" });
      return true;
    }
    const validCells = cells as TerrainCell[];
    // Snapshotted server-side before the write lands - what undo later
    // restores for this session in this room, and only that (src/undo.ts).
    captureStroke(roomId, sessionId, strokeId, validCells, []);
    const submerged = applyCells(roomId, validCells);
    recordStrokeResult(roomId, sessionId, strokeId, validCells);
    broadcast(roomId, "terrain:update", { cells: validCells });
    // Elevation is the one source of truth for land vs sea (ADR.md): any
    // cell pushed underwater loses its terrain type server-side, and every
    // client in the room is told so.
    if (submerged.length > 0) {
      broadcast(roomId, "terrain-type:clear", { cells: submerged.map(({ x, y }) => ({ x, y })) });
    }
    logActivity(roomId, sessionId, "terrain:paint", cellsSummary(validCells));
    res.writeHead(204);
    res.end();
    return true;
  }

  if (path === "/api/terrain/types" && req.method === "POST") {
    const payload = await readJsonOr400(req, res);
    if (!payload) return true;
    const { cells } = payload;
    const strokeId = strokeIdOf(payload);
    if (!Array.isArray(cells) || cells.length === 0 || cells.length > MAX_CELLS_PER_BATCH || !cells.every(isValidTerrainTypeCell)) {
      sendJson(res, 400, {
        error: "cells must be a non-empty array of {x, y, terrain}, terrain one of grassland/sand/forest/rock",
      });
      return true;
    }
    // A type painted over sea is a silent no-op: a stroke straddling a
    // coastline is the normal case, not a malformed request.
    const onLand = (cells as TerrainTypeCell[]).filter((cell) => isLand(roomId, cell.x, cell.y));
    if (onLand.length > 0) {
      captureStroke(roomId, sessionId, strokeId, [], onLand);
      applyTerrainTypes(roomId, onLand);
      recordStrokeResult(roomId, sessionId, strokeId, onLand);
      broadcast(roomId, "terrain-type:update", { cells: onLand });
      logActivity(roomId, sessionId, "terrain-type:paint", cellsSummary(onLand));
    }
    res.writeHead(204);
    res.end();
    return true;
  }

  if (path === "/api/terrain/undo" && req.method === "POST") {
    // The session id from the request's own cookie and the room from the
    // URL token are the entire input: nothing here can name another
    // session's history (ADR 2). Undoes this person's latest change, a
    // terrain stroke or a place, whichever came last (src/undo.ts).
    const result = undoLast(roomId, sessionId);
    if (!result.ok) {
      sendJson(res, 409, { error: "nothing to undo for this session" });
      return true;
    }
    if (result.what === "stroke") {
      if (result.elevationCells.length > 0) broadcast(roomId, "terrain:update", { cells: result.elevationCells });
      if (result.restoredTypeCells.length > 0) broadcast(roomId, "terrain-type:update", { cells: result.restoredTypeCells });
      if (result.clearedTypeCells.length > 0) broadcast(roomId, "terrain-type:clear", { cells: result.clearedTypeCells });
      logActivity(roomId, sessionId, "terrain:undo", cellsSummary(result.elevationCells));
    } else if (result.what === "path") {
      if (result.upserted) broadcast(roomId, "paths:upsert", result.upserted);
      if (result.deletedId !== null) broadcast(roomId, "paths:delete", { id: result.deletedId });
      logActivity(roomId, sessionId, "terrain:undo", result.upserted ? `${result.upserted.kind} ${result.upserted.id} restored` : result.deletedId !== null ? `path ${result.deletedId} removed` : "path left as a collaborator changed it");
    } else {
      if (result.upserted) broadcast(roomId, "objects:upsert", result.upserted);
      if (result.deletedId !== null) broadcast(roomId, "objects:delete", { id: result.deletedId });
      logActivity(roomId, sessionId, "terrain:undo", result.upserted ? `place ${result.upserted.id} restored` : result.deletedId !== null ? `place ${result.deletedId} removed` : "place left as a collaborator changed it");
    }
    sendJson(res, 200, { what: result.what, skipped: result.skipped, remaining: result.remaining });
    return true;
  }

  if (path === "/api/terrain/undo" && req.method === "GET") {
    sendJson(res, 200, { remaining: undoDepth(roomId, sessionId) });
    return true;
  }

  if (path === "/api/events" && req.method === "GET") {
    let leave: (() => void) | undefined;
    const ok = subscribe(roomId, res, () => leave?.(), access.role);
    if (!ok) {
      sendJson(res, 503, { error: "too many open connections - try again shortly" });
      return true;
    }
    // The activity log page listens without "being here": a log reader
    // isn't someone at the map.
    if (new URL(req.url ?? "/", "http://localhost").searchParams.get("watch") === "log") return true;
    const joined = joinPresence(roomId, sessionId, access.role);
    leave = joined.leave;
    // To this stream only: which presence entry is the viewer's own.
    res.write(`event: presence:you\ndata: ${JSON.stringify({ key: joined.key })}\n\n`);
    return true;
  }

  if (path === "/api/activity" && req.method === "GET") {
    sendJson(res, 200, recentActivity(roomId));
    return true;
  }

  return false;
}

// Never hand another visitor's session id to the client - just whether this
// mark is theirs to remove.
function toClientMark(mark: Mark, sessionId: string) {
  const { sessionId: owner, ...rest } = mark;
  return { ...rest, mine: owner === sessionId };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { sessionId, setCookieHeader } = resolveSession(req);
  if (setCookieHeader) res.setHeader("Set-Cookie", setCookieHeader);
  // Share tokens live in URL paths: never send them to another site in a
  // Referer header (ADR 3).
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");

  if (url.pathname === "/readme/" && req.method === "GET") {
    const html = renderReadmePage();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/credits/" && req.method === "GET") {
    const html = renderCreditsPage();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/api/marks" && req.method === "GET") {
    const body = JSON.stringify(listMarks().map((mark) => toClientMark(mark, sessionId)));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
    return;
  }

  if (url.pathname === "/api/marks" && req.method === "POST") {
    let payload: unknown;
    try {
      payload = await readJsonBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
    const { x, y, kind } = (payload ?? {}) as Record<string, unknown>;
    if (!isPercentage(x) || !isPercentage(y) || !isMarkKind(kind)) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: `a mark needs x and y in [0,100] and kind one of ${MARK_KINDS.join(", ")}`,
        }),
      );
      return;
    }
    const mark = insertMark(x, y, kind, sessionId);
    logActivity(PUBLIC_ROOM_ID, sessionId, "mark:create", `${kind} at (${x}, ${y})`);
    const body = JSON.stringify(toClientMark(mark, sessionId));
    res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
    return;
  }

  const markIdMatch = /^\/api\/marks\/(\d+)$/.exec(url.pathname);
  if (markIdMatch && req.method === "DELETE") {
    const id = Number(markIdMatch[1]);
    const result = deleteMarkOwnedBy(id, sessionId);
    if (result === "not-found") {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "mark not found" }));
      return;
    }
    if (result === "forbidden") {
      // Logged as its own line, not silently 403'd: this is exactly what
      // C10's crit demo reads from the logs - a session attempting an
      // action scoped to a *different* session, and the server refusing it.
      logActivity(PUBLIC_ROOM_ID, sessionId, "mark:delete", `DENIED mark #${id} (not this session's)`);
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "you can only remove marks you placed yourself" }));
      return;
    }
    logActivity(PUBLIC_ROOM_ID, sessionId, "mark:delete", `mark #${id}`);
    res.writeHead(204);
    res.end();
    return;
  }

  // The multiplayer map editor is now the official homepage (per C10's
  // brief and the project's actual direction, CLAUDE.md): `/` serves the
  // exact same file `/world/` does, directly - not a redirect, so the
  // browser's address bar stays at `/`. `/world/` is kept working
  // unchanged as a compatibility alias (every link anyone already has to
  // it keeps working), not removed in favour of `/`. The file's own asset
  // references are all absolute (`/world/world.css`, etc.), so serving its
  // bytes at a different path needs no rewriting.
  //
  // The Isle (Crit 8's shipped app - marks, `/api/marks`) is unchanged and
  // still fully functional; its own page moved to `/isle/` rather than
  // being deleted, so existing marks data and that whole experience stay
  // reachable, just no longer at `/`. See README.md and CLAUDE.md.
  // A private map's page (/m/<token>) is the same editor file; the client
  // reads the token from its own URL and asks /api/r/<token>/room for its
  // role. Unknown tokens still get the page, which shows "no map at this
  // link" from that API call rather than a bare 404.
  const isMapPage = /^\/m\/[A-Za-z0-9_-]{1,64}\/?$/.test(url.pathname);
  if (
    (url.pathname === "/world" || url.pathname === "/world/" || isMapPage) &&
    req.method === "GET"
  ) {
    const file = await serveStatic("/world/index.html");
    if (file) {
      res.writeHead(200, { "Content-Type": file.type });
      res.end(file.body);
      return;
    }
  }

  // The Atlas home page (stage A): the front door. The shared world's
  // editor, which used to be served here too, keeps its own /world/ address.
  if (url.pathname === "/" && req.method === "GET") {
    const file = await serveStatic("/atlas/index.html");
    if (file) {
      res.writeHead(200, { "Content-Type": file.type });
      res.end(file.body);
      return;
    }
  }

  if ((url.pathname === "/isle" || url.pathname === "/isle/") && req.method === "GET") {
    const file = await serveStatic("/index.html");
    if (file) {
      res.writeHead(200, { "Content-Type": file.type });
      res.end(file.body);
      return;
    }
  }

  // Rooms (ADR 3). The unprefixed routes are the public room, kept
  // byte-compatible with every client and test that already uses them;
  // /api/r/<token>/... is the same API for one private room, with the role
  // the token grants.
  if (url.pathname === "/api/gallery" && req.method === "GET") {
    sendJson(res, 200, listGallery());
    return;
  }
  const galleryThumb = /^\/api\/gallery\/([A-Za-z0-9_-]{22})\/thumbnail\.png$/.exec(url.pathname);
  if (galleryThumb && req.method === "GET") {
    const roomId = listedRoomByViewToken(galleryThumb[1]);
    if (!roomId) {
      sendJson(res, 404, { error: "not in the gallery" });
      return;
    }
    sendThumbnail(req, res, roomId, thumbSizeOf(req));
    return;
  }

  if (url.pathname === "/api/rooms" && req.method === "POST") {
    await handleCreateRoom(req, res, sessionId);
    return;
  }
  // Who you are, as others see you (src/people.ts). GET creates your
  // generated name on first visit; POST changes name and/or tincture.
  if (url.pathname === "/api/me" && req.method === "GET") {
    sendJson(res, 200, { ...ensurePerson(sessionId), tinctures: TINCTURES });
    return;
  }
  if (url.pathname === "/api/me/suggestion" && req.method === "GET") {
    sendJson(res, 200, suggestion());
    return;
  }
  if (url.pathname === "/api/me" && req.method === "POST") {
    const payload = await readJsonOr400(req, res);
    if (!payload) return;
    const current = ensurePerson(sessionId);
    const name = payload.name === undefined ? current.name : cleanName(payload.name);
    const tincture = payload.tincture === undefined ? current.tincture : payload.tincture;
    if (!name || !isTincture(tincture)) {
      sendJson(res, 400, { error: `a name is 1-${NAME_MAX} characters, and the colour must be one of ${TINCTURES.join(", ")}` });
      return;
    }
    if (rateLimited(sessionId)) {
      sendJson(res, 429, { error: "too many changes just now - try again in a minute" });
      return;
    }
    const updated = updatePerson(sessionId, { name, tincture });
    // Logged where it's relevant - the rooms this person has open or has
    // worked in - never by default in the shared world, which would show a
    // private-map-only visitor in the public log.
    if (name !== current.name) {
      for (const roomId of roomsForRename(sessionId)) {
        logActivity(roomId, sessionId, "person:rename", `"${current.name}" is now "${name}"`);
      }
    }
    refreshPresenceFor(sessionId);
    sendJson(res, 200, updated);
    return;
  }

  if (url.pathname === "/api/rooms/mine" && req.method === "GET") {
    sendJson(res, 200, roomsForSession(sessionId));
    return;
  }

  let access: RoomAccess | null = null;
  let apiPath = url.pathname;
  const roomApi = /^\/api\/r\/([^/]+)(\/.*)$/.exec(url.pathname);
  if (roomApi) {
    access = resolveToken(roomApi[1]);
    if (!access) {
      sendJson(res, 404, { error: "no map at this link" });
      return;
    }
    apiPath = `/api${roomApi[2]}`;
  } else if (PUBLIC_ROOM_PATHS.has(url.pathname)) {
    access = PUBLIC_ACCESS;
  }
  if (access && (await handleRoomApi(req, res, apiPath, access, sessionId))) return;

  // In-app real-time log viewer (C10): the crit's own demo format is
  // narrating from `flyctl logs` in a terminal, which stays the primary
  // path (every entry here is also a stdout line - see src/activity.ts).
  // This page is this app's own tool for the same logs, available without
  // flyctl/shell access, matching the brief's "what you and your agent read
  // when the deployed app misbehaves."
  if ((url.pathname === "/logs" || url.pathname === "/logs/") && req.method === "GET") {
    const file = await serveStatic("/logs/index.html");
    if (file) {
      res.writeHead(200, { "Content-Type": file.type });
      res.end(file.body);
      return;
    }
  }

  // "/" is handled above (now the map editor); this is every other static
  // asset (CSS, JS, images) under public/, addressed by its own real path.
  const file = await serveStatic(url.pathname);
  if (file) {
    res.writeHead(200, { "Content-Type": file.type });
    res.end(file.body);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("internal error");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
});
