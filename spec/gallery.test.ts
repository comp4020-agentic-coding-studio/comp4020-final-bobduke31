import { describe, expect, inject, it } from "vitest";

// The Atlas home, the gallery and map pictures (Atlas Table stage A), over
// HTTP against the running app. Publishing puts test maps in the gallery,
// and forged maps store tens of thousands of cells, so like forge.test.ts
// this runs only against a throwaway database (spec/README.md).
const baseUrl = inject("baseUrl");
const url = (path: string) => new URL(path, baseUrl);

function cookieOf(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected the server to assign a session cookie");
  return setCookie.split(";")[0];
}

const newVisitor = async () => cookieOf(await fetch(url("/api/me")));

const post = (path: string, cookie: string, body: unknown) =>
  fetch(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });

async function createMap(cookie: string, name: string, template = "continent") {
  const res = await post("/api/rooms", cookie, { name, forge: { seed: "Gallery spec", template, settings: {} } });
  expect(res.status).toBe(201);
  return (await res.json()) as { editToken: string; viewToken: string };
}

const publish = (token: string, cookie: string, listed: boolean) => post(`/api/r/${token}/room/listing`, cookie, { listed });
const gallery = async () => (await (await fetch(url("/api/gallery"))).json()) as Record<string, unknown>[];

describe("the Atlas home", () => {
  it("serves the home page at / and the editor at /world/ and /m/<token>", async () => {
    const home = await (await fetch(url("/"))).text();
    expect(home).toContain('id="forge-form"');
    expect(home).toContain('id="gallery"');
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Routes", "blank");
    for (const path of ["/world", "/world/", `/m/${map.editToken}`, `/m/${map.viewToken}`]) {
      const res = await fetch(url(path));
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('id="share-dialog"');
    }
  });
});

describe("publishing to the gallery", () => {
  it("lists a map published by its edit link, exposing only the view link", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Published realm");
    const res = await publish(map.editToken, cookie, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listed: true });
    const room = await (await fetch(url(`/api/r/${map.editToken}/room`), { headers: { Cookie: cookie } })).json();
    expect(room.listed).toBe(true);

    const entry = (await gallery()).find((m) => m.viewToken === map.viewToken);
    expect(entry).toMatchObject({ name: "Published realm" });
    // Nothing in the whole listing may carry an edit token.
    expect(JSON.stringify(await gallery())).not.toContain(map.editToken);
  });

  it("takes a map off at once when its edit link unpublishes it", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Briefly shown");
    await publish(map.editToken, cookie, true);
    const res = await publish(map.editToken, cookie, false);
    expect(await res.json()).toEqual({ listed: false });
    expect((await gallery()).some((m) => m.viewToken === map.viewToken)).toBe(false);
    expect((await fetch(url(`/api/gallery/${map.viewToken}/thumbnail.png`))).status).toBe(404);
  });

  it("refuses the view link, an empty map and the shared world", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Watched only");
    expect((await publish(map.viewToken, await newVisitor(), true)).status).toBe(403);
    const empty = await createMap(cookie, "Empty sea", "blank");
    expect((await publish(empty.editToken, cookie, true)).status).toBe(400);
    // The shared world is always on the home page and has no listing route.
    expect((await post("/api/room/listing", cookie, { listed: true })).status).toBe(404);
    expect((await publish(map.editToken, cookie, "yes" as unknown as boolean)).status).toBe(400);
    expect((await gallery()).some((m) => m.viewToken === map.viewToken || m.viewToken === empty.viewToken)).toBe(false);
  });
});

describe("map pictures", () => {
  const isPng = (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  it("draws a map as a PNG, revalidates by ETag and redraws after an edit", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Pictured");
    const path = `/api/r/${map.viewToken}/room/thumbnail.png`;
    const first = await fetch(url(path));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(isPng(Buffer.from(await first.arrayBuffer()))).toBe(true);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    expect((await fetch(url(path), { headers: { "If-None-Match": etag } })).status).toBe(304);

    await post(`/api/r/${map.editToken}/terrain/cells`, cookie, { cells: [{ x: 10, y: 10, elevation: 0.9 }] });
    const after = await fetch(url(path), { headers: { "If-None-Match": etag } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
  });

  it("draws link-preview size, and gallery pictures only for listed maps", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Previewed");
    const og = Buffer.from(await (await fetch(url(`/api/r/${map.viewToken}/room/thumbnail.png?size=og`))).arrayBuffer());
    expect(og.readUInt32BE(16)).toBe(1200);
    expect(og.readUInt32BE(20)).toBe(630);
    expect((await fetch(url(`/api/gallery/${map.viewToken}/thumbnail.png`))).status).toBe(404);
    await publish(map.editToken, cookie, true);
    const listed = await fetch(url(`/api/gallery/${map.viewToken}/thumbnail.png`));
    expect(listed.status).toBe(200);
    expect(isPng(Buffer.from(await listed.arrayBuffer()))).toBe(true);
    // The edit token is not a gallery key.
    expect((await fetch(url(`/api/gallery/${map.editToken}/thumbnail.png`))).status).toBe(404);
  });

  it("draws the shared world without a token", async () => {
    const res = await fetch(url("/api/room/thumbnail.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});
