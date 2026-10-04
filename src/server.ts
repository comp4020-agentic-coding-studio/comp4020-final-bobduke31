import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { renderReadmePage, renderCreditsPage } from "./render-readme.ts";
import {
  listFeatures,
  insertFeature,
  updateFeatureGeometry,
  deleteFeature,
  listTerrainDabs,
  insertTerrainDabs,
  InvalidFeatureError,
} from "./db.ts";
import { resolveSession } from "./session.ts";

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

  if (url.pathname === "/api/features" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(listFeatures()));
    return;
  }

  if (url.pathname === "/api/features" && req.method === "POST") {
    let payload: unknown;
    try {
      payload = await readJsonBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
    try {
      const feature = insertFeature(payload, sessionId);
      res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(feature));
    } catch (err) {
      if (err instanceof InvalidFeatureError) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      throw err;
    }
    return;
  }

  if (url.pathname === "/api/terrain-dabs" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ dabs: listTerrainDabs() }));
    return;
  }

  if (url.pathname === "/api/terrain-dabs" && req.method === "POST") {
    let payload: unknown;
    try {
      payload = await readJsonBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
    const { dabs } = (payload ?? {}) as Record<string, unknown>;
    try {
      const inserted = insertTerrainDabs(dabs, sessionId);
      res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ dabs: inserted }));
    } catch (err) {
      if (err instanceof InvalidFeatureError) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      throw err;
    }
    return;
  }

  const featureIdMatch = /^\/api\/features\/(\d+)$/.exec(url.pathname);
  if (featureIdMatch && req.method === "PUT") {
    const id = Number(featureIdMatch[1]);
    let payload: unknown;
    try {
      payload = await readJsonBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
    const { geometry } = (payload ?? {}) as Record<string, unknown>;
    try {
      const updated = updateFeatureGeometry(id, geometry);
      res.writeHead(updated ? 200 : 404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(updated ?? { error: "no such feature" }));
    } catch (err) {
      if (err instanceof InvalidFeatureError) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      throw err;
    }
    return;
  }

  if (featureIdMatch && req.method === "DELETE") {
    const id = Number(featureIdMatch[1]);
    const removed = deleteFeature(id);
    res.writeHead(removed ? 204 : 404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(removed ? undefined : JSON.stringify({ error: "no such feature" }));
    return;
  }

  const staticPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = await serveStatic(staticPath);
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
