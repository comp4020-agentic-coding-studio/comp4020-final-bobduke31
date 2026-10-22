import { describe, expect, inject, it } from "vitest";

// Versions, restore, export, import and copy (Atlas Table stage B), over
// HTTP against the running app. Forged maps store tens of thousands of
// cells, so like forge.test.ts this runs only against a throwaway database
// (spec/README.md).
const baseUrl = inject("baseUrl");
const url = (path: string) => new URL(path, baseUrl);

function cookieOf(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected the server to assign a session cookie");
  return setCookie.split(";")[0];
}
const newVisitor = async () => cookieOf(await fetch(url("/api/me")));

const post = (path: string, cookie: string, body: unknown) =>
  fetch(url(path), { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });

async function createMap(cookie: string, name: string, extra: Record<string, unknown> = { forge: { seed: "Versions spec", template: "coast", settings: {} } }) {
  const res = await post("/api/rooms", cookie, { name, ...extra });
  expect(res.status).toBe(201);
  return (await res.json()) as { editToken: string; viewToken: string };
}
const terrain = async (token: string) => (await fetch(url(`/api/r/${token}/terrain`))).text();
const types = async (token: string) => (await fetch(url(`/api/r/${token}/terrain-types`))).text();

describe("versions", () => {
  it("restores a saved version exactly, after checkpointing the current map", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Restore me");
    const original = [await terrain(map.editToken), await types(map.editToken)];
    const saved = await post(`/api/r/${map.editToken}/room/versions`, cookie, { name: "Original" });
    expect(saved.status).toBe(201);
    const { id } = await saved.json();

    await post(`/api/r/${map.editToken}/terrain/cells`, cookie, { cells: [{ x: 1, y: 1, elevation: 0.8 }, { x: 2, y: 1, elevation: 0.8 }] });
    const edited = await terrain(map.editToken);
    expect(edited).not.toBe(original[0]);

    const restored = await post(`/api/r/${map.editToken}/room/versions/restore`, cookie, { id });
    expect(restored.status).toBe(200);
    expect([await terrain(map.editToken), await types(map.editToken)]).toEqual(original);

    // The edited state was kept as a checkpoint, and restoring it undoes the restore.
    const list = (await (await fetch(url(`/api/r/${map.viewToken}/room/versions`))).json()) as { id: number; kind: string }[];
    const checkpoint = list.find((v) => v.kind === "checkpoint")!;
    expect(checkpoint).toBeTruthy();
    await post(`/api/r/${map.editToken}/room/versions/restore`, cookie, { id: checkpoint.id });
    expect(await terrain(map.editToken)).toBe(edited);
  });

  it("refuses the view link, the shared world, and other maps' versions", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Guarded");
    const other = await createMap(cookie, "Other");
    const { id } = await (await post(`/api/r/${map.editToken}/room/versions`, cookie, { name: "Mine" })).json();
    expect((await post(`/api/r/${map.viewToken}/room/versions`, cookie, { name: "Nope" })).status).toBe(403);
    expect((await post(`/api/r/${map.viewToken}/room/versions/restore`, cookie, { id })).status).toBe(403);
    expect((await post(`/api/r/${map.viewToken}/room/versions/delete`, cookie, { id })).status).toBe(403);
    expect((await post("/api/room/versions", cookie, { name: "Shared" })).status).toBe(404);
    // A version id from one map can't be restored into another.
    expect((await post(`/api/r/${other.editToken}/room/versions/restore`, cookie, { id })).status).toBe(404);
    expect((await post(`/api/r/${map.editToken}/room/versions`, cookie, { name: "" })).status).toBe(400);
  });

  it("deletes a version without touching the map", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Prune");
    const before = await terrain(map.editToken);
    const { id } = await (await post(`/api/r/${map.editToken}/room/versions`, cookie, { name: "Gone soon" })).json();
    expect((await post(`/api/r/${map.editToken}/room/versions/delete`, cookie, { id })).status).toBe(204);
    expect(await (await fetch(url(`/api/r/${map.editToken}/room/versions`))).json()).toEqual([]);
    expect(await terrain(map.editToken)).toBe(before);
  });
});

describe("export, import and copy", () => {
  it("round-trips a map through its exported file", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Exported");
    const file = await (await fetch(url(`/api/r/${map.viewToken}/room/export.json`))).json();
    expect(file).toMatchObject({ format: "atlas-table-map", version: 1, name: "Exported" });
    const copy = await createMap(cookie, "Imported", { import: file });
    expect(await terrain(copy.editToken)).toBe(await terrain(map.editToken));
    expect(await types(copy.editToken)).toBe(await types(map.editToken));
  });

  it("rejects a file with cells outside the map or the wrong format", async () => {
    const cookie = await newVisitor();
    for (const bad of [
      { format: "atlas-table-map", version: 1, elevation: [{ x: 300, y: 0, elevation: 0.5 }], types: [] },
      { format: "atlas-table-map", version: 1, elevation: [{ x: 1, y: 1, elevation: 9 }], types: [] },
      { format: "something-else", version: 1, elevation: [], types: [] },
      "not an object",
    ]) {
      expect((await post("/api/rooms", cookie, { name: "Bad file", import: bad })).status).toBe(400);
    }
  });

  it("copies a map from its view link into a new map the copier can edit", async () => {
    const owner = await newVisitor();
    const map = await createMap(owner, "Original world");
    const copier = await newVisitor();
    const copy = await createMap(copier, "My copy", { copyFrom: map.viewToken });
    expect(await terrain(copy.editToken)).toBe(await terrain(map.editToken));
    expect(copy.editToken).not.toBe(map.editToken);
    // Editing the copy leaves the original alone.
    await post(`/api/r/${copy.editToken}/terrain/cells`, copier, { cells: [{ x: 0, y: 0, elevation: 0.9 }] });
    expect(await terrain(copy.editToken)).not.toBe(await terrain(map.editToken));
    expect((await post("/api/rooms", copier, { name: "Nothing", copyFrom: "A".repeat(22) })).status).toBe(404);
  });
});

describe("withdrawing a link", () => {
  it("makes a new view link and the old one stops working at once", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Withdraw view", { forge: { seed: "W", template: "blank", settings: {} } });
    const res = await post(`/api/r/${map.editToken}/room/links/reissue`, cookie, { role: "view" });
    expect(res.status).toBe(200);
    const fresh = (await res.json()) as { editToken: string; viewToken: string };
    expect(fresh.viewToken).not.toBe(map.viewToken);
    expect(fresh.editToken).toBe(map.editToken);
    expect((await fetch(url(`/api/r/${map.viewToken}/room`))).status).toBe(404);
    expect((await fetch(url(`/api/r/${fresh.viewToken}/room`))).status).toBe(200);
  });

  it("makes a new edit link that only its issuer receives", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Withdraw edit", { forge: { seed: "W", template: "blank", settings: {} } });
    const fresh = (await (await post(`/api/r/${map.editToken}/room/links/reissue`, cookie, { role: "edit" })).json()) as { editToken: string };
    expect((await post(`/api/r/${map.editToken}/terrain/cells`, cookie, { cells: [{ x: 1, y: 1, elevation: 0.5 }] })).status).toBe(404);
    expect((await post(`/api/r/${fresh.editToken}/terrain/cells`, cookie, { cells: [{ x: 1, y: 1, elevation: 0.5 }] })).status).toBe(204);
    // The view link is untouched and still never reveals the edit link.
    const asViewer = await (await fetch(url(`/api/r/${map.viewToken}/room`))).json();
    expect(asViewer.role).toBe("view");
    expect(JSON.stringify(asViewer)).not.toContain(fresh.editToken);
  });

  it("refuses a view link and the shared world", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "No withdraw", { forge: { seed: "W", template: "blank", settings: {} } });
    expect((await post(`/api/r/${map.viewToken}/room/links/reissue`, cookie, { role: "view" })).status).toBe(403);
    expect((await post("/api/room/links/reissue", cookie, { role: "view" })).status).toBe(404);
    expect((await post(`/api/r/${map.editToken}/room/links/reissue`, cookie, { role: "owner" })).status).toBe(400);
  });
});

describe("places on the map", () => {
  const objects = async (token: string) => (await (await fetch(url(`/api/r/${token}/objects`))).json()) as { id: number; kind: string; x: number; y: number; rotation: number; scale: number }[];

  it("places, moves, turns and removes a place, edit link only", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Village", { forge: { seed: "V", template: "blank", settings: {} } });
    const res = await post(`/api/r/${map.editToken}/objects`, cookie, { kind: "castle", x: 40.5, y: 60.25 });
    expect(res.status).toBe(201);
    const castle = await res.json();
    expect(castle).toMatchObject({ kind: "castle", x: 40.5, y: 60.25, rotation: 0, scale: 1 });

    const moved = await post(`/api/r/${map.editToken}/objects/update`, cookie, { id: castle.id, x: 41, y: 61, rotation: Math.PI / 2, scale: 1.5 });
    expect(moved.status).toBe(200);
    expect((await objects(map.viewToken))[0]).toMatchObject({ x: 41, y: 61, scale: 1.5 });

    // A move can't change what the place is.
    expect((await post(`/api/r/${map.editToken}/objects/update`, cookie, { id: castle.id, kind: "well" })).status).toBe(400);
    expect((await post(`/api/r/${map.viewToken}/objects`, cookie, { kind: "house", x: 1, y: 1 })).status).toBe(403);
    expect((await post(`/api/r/${map.viewToken}/objects/delete`, cookie, { id: castle.id })).status).toBe(403);

    expect((await post(`/api/r/${map.editToken}/objects/delete`, cookie, { id: castle.id })).status).toBe(204);
    expect(await objects(map.viewToken)).toEqual([]);
  });

  it("refuses unknown kinds, positions off the map and silly sizes", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Strict", { forge: { seed: "V", template: "blank", settings: {} } });
    for (const bad of [
      { kind: "dragon", x: 1, y: 1 },
      { kind: "house", x: -1, y: 1 },
      { kind: "house", x: 1, y: 256 },
      { kind: "house", x: 1, y: 1, scale: 40 },
      { kind: "house", x: "1", y: 1 },
    ]) {
      expect((await post(`/api/r/${map.editToken}/objects`, cookie, bad)).status).toBe(400);
    }
  });

  it("keeps places with each version and in exported files", async () => {
    const cookie = await newVisitor();
    const map = await createMap(cookie, "Kept places", { forge: { seed: "V", template: "blank", settings: {} } });
    await post(`/api/r/${map.editToken}/objects`, cookie, { kind: "house", x: 10, y: 10 });
    const { id } = await (await post(`/api/r/${map.editToken}/room/versions`, cookie, { name: "One house" })).json();
    await post(`/api/r/${map.editToken}/objects`, cookie, { kind: "tower", x: 20, y: 20 });
    expect((await objects(map.editToken)).length).toBe(2);

    await post(`/api/r/${map.editToken}/room/versions/restore`, cookie, { id });
    expect((await objects(map.editToken)).map((o) => o.kind)).toEqual(["house"]);

    const file = await (await fetch(url(`/api/r/${map.viewToken}/room/export.json`))).json();
    expect(file.objects).toEqual([{ kind: "house", x: 10, y: 10, rotation: 0, scale: 1 }]);
    const copy = await createMap(cookie, "Imported places", { import: file });
    expect((await objects(copy.editToken)).map((o) => o.kind)).toEqual(["house"]);
  });
});
