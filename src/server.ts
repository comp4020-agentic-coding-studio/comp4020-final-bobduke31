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
} from "./terrain.ts";
import type { TerrainCell, TerrainTypeCell } from "./terrain.ts";
import { subscribe, broadcast } from "./realtime.ts";
import { log as logActivity, recentActivity } from "./activity.ts";
import { captureStroke, undoLastStroke } from "./undo.ts";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
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
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
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
function cellsSummary(cells: { x: number; y: number }[]): string {
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  const bbox = `(${Math.min(...xs)},${Math.min(...ys)})-(${Math.max(...xs)},${Math.max(...ys)})`;
  return `${cells.length} cell${cells.length === 1 ? "" : "s"}, bbox ${bbox}`;
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
    logActivity(sessionId, "mark:create", `${kind} at (${x}, ${y})`);
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
      logActivity(sessionId, "mark:delete", `DENIED mark #${id} (not this session's)`);
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "you can only remove marks you placed yourself" }));
      return;
    }
    logActivity(sessionId, "mark:delete", `mark #${id}`);
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
  if (
    (url.pathname === "/" || url.pathname === "/world" || url.pathname === "/world/") &&
    req.method === "GET"
  ) {
    const file = await serveStatic("/world/index.html");
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

  if (url.pathname === "/api/terrain" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(listCells()));
    return;
  }

  if (url.pathname === "/api/terrain/cells" && req.method === "POST") {
    let payload: unknown;
    try {
      payload = await readJsonBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
    const { cells } = (payload ?? {}) as Record<string, unknown>;
    if (!Array.isArray(cells) || cells.length === 0 || !cells.every(isValidCell)) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: "cells must be a non-empty array of {x, y, elevation} within grid bounds",
        }),
      );
      return;
    }
    const validCells = cells as TerrainCell[];
    // Snapshotted here, server-side, before the write lands - this is what
    // /api/terrain/undo later restores for this session, and only this
    // session (see src/undo.ts).
    captureStroke(sessionId, validCells, []);
    const submerged = applyCells(validCells);
    broadcast("terrain:update", { cells: validCells });
    // Elevation is the one source of truth for land vs sea (ADR.md): any
    // cell pushed underwater here loses its terrain type server-side, and
    // every connected client - including the one that just painted it -
    // is told so, rather than trusting each client to clear it themselves.
    if (submerged.length > 0) {
      broadcast("terrain-type:clear", { cells: submerged.map(({ x, y }) => ({ x, y })) });
    }
    logActivity(sessionId, "terrain:paint", cellsSummary(validCells));
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/api/terrain/undo" && req.method === "POST") {
    // No body to validate: the session id from the request's own cookie is
    // the entire input. There is no field here a client could set to
    // address another session's stroke - that's the server-side check C10
    // asks for, not an `if` that compares two ids a request could lie about.
    const result = undoLastStroke(sessionId);
    if (!result.ok) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "nothing to undo for this session" }));
      return;
    }
    // Broadcast exactly like a fresh paint: an undo must be just as visible
    // to every other connected client as the original stroke was.
    broadcast("terrain:update", { cells: result.elevationCells });
    if (result.restoredTypeCells.length > 0) {
      broadcast("terrain-type:update", { cells: result.restoredTypeCells });
    }
    if (result.clearedTypeCells.length > 0) {
      broadcast("terrain-type:clear", { cells: result.clearedTypeCells });
    }
    logActivity(sessionId, "terrain:undo", cellsSummary(result.elevationCells));
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/api/terrain-types" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(listTerrainTypes()));
    return;
  }

  if (url.pathname === "/api/terrain/types" && req.method === "POST") {
    let payload: unknown;
    try {
      payload = await readJsonBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
    const { cells } = (payload ?? {}) as Record<string, unknown>;
    if (!Array.isArray(cells) || cells.length === 0 || !cells.every(isValidTerrainTypeCell)) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: `cells must be a non-empty array of {x, y, terrain}, terrain one of grassland/sand/forest/rock`,
        }),
      );
      return;
    }
    // Painting a terrain type over sea is a silent no-op rather than an
    // error: a brush stroke straddling a coastline is the normal case, not
    // a malformed request.
    const onLand = (cells as TerrainTypeCell[]).filter((cell) => isLand(cell.x, cell.y));
    if (onLand.length > 0) {
      captureStroke(sessionId, [], onLand);
      applyTerrainTypes(onLand);
      broadcast("terrain-type:update", { cells: onLand });
      logActivity(sessionId, "terrain-type:paint", cellsSummary(onLand));
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/api/events" && req.method === "GET") {
    subscribe(res);
    return;
  }

  if (url.pathname === "/api/activity" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(recentActivity()));
    return;
  }

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
