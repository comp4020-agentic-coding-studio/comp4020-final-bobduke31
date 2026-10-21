import { describe, expect, inject, it } from "vitest";

// Rooms, share links and roles (ADR 3), checked over HTTP against the
// running app like every other spec file. Each fetch without a Cookie is a
// distinct visitor; a captured Set-Cookie lets a test act as one again.
const baseUrl = inject("baseUrl");
const url = (path: string) => new URL(path, baseUrl);

function cookieOf(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected the server to assign a session cookie");
  return setCookie.split(";")[0];
}

async function newVisitor(): Promise<string> {
  return cookieOf(await fetch(url("/api/room")));
}

async function createMap(cookie: string, name = "Test map") {
  const res = await fetch(url("/api/rooms"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { name: string; editToken: string; viewToken: string };
}

const post = (path: string, cookie: string, body?: unknown) =>
  fetch(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const getJson = async (path: string, cookie?: string) =>
  (await fetch(url(path), { headers: cookie ? { Cookie: cookie } : {} })).json();

// Reads SSE frames until one of `type` passes `matches`, or times out.
async function nextEvent(
  res: Response,
  type: string,
  matches: (data: any) => boolean,
  timeoutMs = 2000,
): Promise<any> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no "${type}" event`)), deadline - Date.now())),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const t = /^event: (.+)$/m.exec(frame)?.[1];
        const d = /^data: (.+)$/m.exec(frame)?.[1];
        if (t === type && d && matches(JSON.parse(d))) return JSON.parse(d);
      }
    }
    throw new Error(`no matching "${type}" event within ${timeoutMs}ms`);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

describe("public room", () => {
  it("is the shared world: open to anyone, no share tokens", async () => {
    const room = await getJson("/api/room");
    expect(room).toMatchObject({ name: "The shared world", role: "edit", isPublic: true });
    expect(room.editToken).toBeUndefined();
    expect(room.viewToken).toBeUndefined();
  });

  it("can't be renamed", async () => {
    const res = await post("/api/room/name", await newVisitor(), { name: "Mine now" });
    expect(res.status).toBe(400);
  });
});

describe("creating a map", () => {
  it("returns two distinct, unguessable tokens and a working edit role", async () => {
    const owner = await newVisitor();
    const map = await createMap(owner, "  Northern   Reaches  ");
    expect(map.name).toBe("Northern Reaches");
    expect(map.editToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(map.viewToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(map.editToken).not.toBe(map.viewToken);

    const room = await getJson(`/api/r/${map.editToken}/room`, owner);
    expect(room).toMatchObject({ name: "Northern Reaches", role: "edit", isPublic: false });
    expect(room.editToken).toBe(map.editToken);
    expect(room.viewToken).toBe(map.viewToken);
  });

  it("rejects an empty or overlong name", async () => {
    const v = await newVisitor();
    for (const name of ["", "   ", "x".repeat(61), 42]) {
      expect((await post("/api/rooms", v, { name })).status).toBe(400);
    }
  });

  it("starts as a blank map, independent of the shared world", async () => {
    const map = await createMap(await newVisitor());
    expect(await getJson(`/api/r/${map.editToken}/terrain`)).toEqual([]);
    expect(await getJson(`/api/r/${map.editToken}/terrain-types`)).toEqual([]);
  });

  it("answers 404 for a token that isn't a map", async () => {
    const res = await fetch(url("/api/r/AAAAAAAAAAAAAAAAAAAAAA/room"));
    expect(res.status).toBe(404);
    const malformed = await fetch(url("/api/r/not-a-token/terrain"));
    expect(malformed.status).toBe(404);
  });
});

describe("view-only links", () => {
  it("can read the map but never learn the edit token", async () => {
    const map = await createMap(await newVisitor());
    const viewer = await newVisitor();
    const room = await getJson(`/api/r/${map.viewToken}/room`, viewer);
    expect(room).toMatchObject({ role: "view", isPublic: false });
    expect(room.editToken).toBeUndefined();
    expect(room.viewToken).toBeUndefined();
    expect(JSON.stringify(room)).not.toContain(map.editToken);
  });

  it("refuses every write with 403, and changes nothing", async () => {
    const owner = await newVisitor();
    const map = await createMap(owner);
    expect((await post(`/api/r/${map.editToken}/terrain/cells`, owner, { cells: [{ x: 3, y: 3, elevation: 0.4 }] })).status).toBe(204);

    const viewer = await newVisitor();
    const v = map.viewToken;
    const attempts = [
      post(`/api/r/${v}/terrain/cells`, viewer, { cells: [{ x: 3, y: 3, elevation: -0.5 }] }),
      post(`/api/r/${v}/terrain/types`, viewer, { cells: [{ x: 3, y: 3, terrain: "forest" }] }),
      post(`/api/r/${v}/terrain/undo`, viewer),
      post(`/api/r/${v}/room/name`, viewer, { name: "Hijacked" }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);

    expect(await getJson(`/api/r/${v}/terrain`)).toEqual([{ x: 3, y: 3, elevation: 0.4 }]);
    expect(await getJson(`/api/r/${v}/terrain-types`)).toEqual([]);
    expect((await getJson(`/api/r/${v}/room`)).name).toBe("Test map");
  });

  it("logs a flood of refused writes only a bounded number of times", async () => {
    const map = await createMap(await newVisitor());
    const viewer = await newVisitor();
    const attempts = Array.from({ length: 40 }, () =>
      post(`/api/r/${map.viewToken}/terrain/cells`, viewer, { cells: [{ x: 2, y: 2, elevation: 0.2 }] }),
    );
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
    const log = (await getJson(`/api/r/${map.editToken}/activity`)) as { detail: string }[];
    const denied = log.filter((e) => e.detail.startsWith("DENIED")).length;
    expect(denied).toBeGreaterThan(0);
    expect(denied).toBeLessThanOrEqual(8);
  });

  it("logs a refused write as DENIED in that map's own activity log", async () => {
    const map = await createMap(await newVisitor());
    await post(`/api/r/${map.viewToken}/terrain/cells`, await newVisitor(), { cells: [{ x: 1, y: 1, elevation: 0.2 }] });
    const log = (await getJson(`/api/r/${map.editToken}/activity`)) as { detail: string }[];
    expect(log.some((e) => e.detail.startsWith("DENIED"))).toBe(true);
  });
});

describe("isolation between maps", () => {
  it("keeps each map's cells, events and activity to itself", async () => {
    const a = await createMap(await newVisitor(), "Map A");
    const b = await createMap(await newVisitor(), "Map B");
    const painter = await newVisitor();

    const streamB = await fetch(url(`/api/r/${b.viewToken}/events`));
    const publicStream = await fetch(url("/api/events"));
    const cell = { x: 77, y: 88, elevation: 0.55 };
    const nothingOnB = nextEvent(streamB, "terrain:update", (d) => d.cells.some((c: any) => c.x === 77 && c.y === 88), 800);
    const nothingOnPublic = nextEvent(publicStream, "terrain:update", (d) => d.cells.some((c: any) => c.x === 77 && c.y === 88 && c.elevation === 0.55), 800);
    expect((await post(`/api/r/${a.editToken}/terrain/cells`, painter, { cells: [cell] })).status).toBe(204);
    // Settled together: both time out at about the same moment, and awaiting
    // one first left the other's rejection briefly unhandled on a slow runner.
    const settled = await Promise.allSettled([nothingOnB, nothingOnPublic]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);

    expect(await getJson(`/api/r/${a.editToken}/terrain`)).toContainEqual(cell);
    expect(await getJson(`/api/r/${b.editToken}/terrain`)).toEqual([]);
    const publicCells = (await getJson("/api/terrain")) as typeof cell[];
    expect(publicCells).not.toContainEqual(cell);

    const publicLog = (await getJson("/api/activity")) as { detail: string }[];
    expect(publicLog.some((e) => e.detail.includes("bbox (77,88)-(77,88)"))).toBe(false);
  });

  it("delivers a write to everyone else in the same map within a second", async () => {
    const map = await createMap(await newVisitor());
    const viewerStream = await fetch(url(`/api/r/${map.viewToken}/events`));
    const cell = { x: 12, y: 34, elevation: 0.21 };
    const arrived = nextEvent(viewerStream, "terrain:update", (d) => d.cells.some((c: any) => c.x === 12 && c.y === 34), 1000);
    await post(`/api/r/${map.editToken}/terrain/cells`, await newVisitor(), { cells: [cell] });
    expect((await arrived).cells).toContainEqual(cell);
  });

  it("scopes undo to the map: undo in one map can't touch a stroke in another", async () => {
    const painter = await newVisitor();
    const a = await createMap(painter, "Undo A");
    const b = await createMap(painter, "Undo B");
    await post(`/api/r/${a.editToken}/terrain/cells`, painter, { cells: [{ x: 5, y: 5, elevation: 0.3 }] });
    // Nothing painted in B yet, so undo there has nothing to do...
    expect((await post(`/api/r/${b.editToken}/terrain/undo`, painter)).status).toBe(409);
    // ...and A's stroke is still there to undo.
    expect((await post(`/api/r/${a.editToken}/terrain/undo`, painter)).status).toBe(204);
    expect(await getJson(`/api/r/${a.editToken}/terrain`)).toEqual([{ x: 5, y: 5, elevation: 0 }]);
  });
});

describe("renaming and my maps", () => {
  it("lets an editor rename the map and tells everyone in it", async () => {
    const owner = await newVisitor();
    const map = await createMap(owner, "Old name");
    const stream = await fetch(url(`/api/r/${map.viewToken}/events`));
    const renamed = nextEvent(stream, "room:update", (d) => d.name === "New name");
    expect((await post(`/api/r/${map.editToken}/room/name`, owner, { name: "New name" })).status).toBe(204);
    await renamed;
    expect((await getJson(`/api/r/${map.viewToken}/room`)).name).toBe("New name");
  });

  it("lists maps this browser opened, with only the token its role allows", async () => {
    const owner = await newVisitor();
    const map = await createMap(owner, "Listed map");
    const viewer = await newVisitor();
    await getJson(`/api/r/${map.viewToken}/room`, viewer);

    const ownerList = (await getJson("/api/rooms/mine", owner)) as { name: string; role: string; token: string }[];
    expect(ownerList).toContainEqual(expect.objectContaining({ name: "Listed map", role: "edit", token: map.editToken }));

    const viewerList = (await getJson("/api/rooms/mine", viewer)) as { name: string; role: string; token: string }[];
    expect(viewerList).toContainEqual(expect.objectContaining({ name: "Listed map", role: "view", token: map.viewToken }));
    expect(JSON.stringify(viewerList)).not.toContain(map.editToken);
  });

  it("never downgrades an editor who later opens the view link", async () => {
    const owner = await newVisitor();
    const map = await createMap(owner, "Own map");
    await getJson(`/api/r/${map.viewToken}/room`, owner);
    const list = (await getJson("/api/rooms/mine", owner)) as { name: string; role: string; token: string }[];
    expect(list.find((r) => r.name === "Own map")).toMatchObject({ role: "edit", token: map.editToken });
  });
});

describe("presence", () => {
  it("shows who has the map open, by display name, with no session ids", async () => {
    const map = await createMap(await newVisitor());
    const viewer = await newVisitor();
    const watcher = await fetch(url(`/api/r/${map.editToken}/events`));
    const seen = nextEvent(watcher, "presence", (d) => d.some((p: any) => p.editing === false));
    const viewerStream = await fetch(url(`/api/r/${map.viewToken}/events`), { headers: { Cookie: viewer } });
    const present = await seen;
    const me = (await (await fetch(url("/api/me"), { headers: { Cookie: viewer } })).json()) as { name: string };
    expect(present.find((p: any) => p.editing === false).name).toBe(me.name);
    expect(JSON.stringify(present)).not.toContain(viewer.split("=")[1]);
    await viewerStream.body?.cancel();
  });
});

describe("pages and headers", () => {
  it("serves the editor at a map link and keeps tokens out of Referer headers", async () => {
    const map = await createMap(await newVisitor());
    const page = await fetch(url(`/m/${map.viewToken}`));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("world-client.js");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
