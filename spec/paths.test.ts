import { describe, expect, inject, it } from "vitest";

// Walls, palisades and roads (src/paths.ts), over HTTP against the running
// app: drawing, the rules a drawn line has to meet, undo, and travelling
// with a map through versions, export and import. Every map here is forged
// fresh, so like versions.test.ts this runs only against a throwaway
// database (spec/README.md).
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

interface MapPath {
  id: number;
  kind: string;
  points: [number, number][];
  closed: boolean;
}

// A map whose land is known: forged blank (all sea), then a raised square
// of land from (20,20) to (60,60).
async function landMap(cookie: string, name: string) {
  const res = await post("/api/rooms", cookie, { name, forge: { seed: "Paths spec", template: "blank", settings: {} } });
  expect(res.status).toBe(201);
  const map = (await res.json()) as { editToken: string; viewToken: string };
  const cells = [];
  for (let y = 20; y <= 60; y++) for (let x = 20; x <= 60; x++) cells.push({ x, y, elevation: 0.2 });
  expect((await post(`/api/r/${map.editToken}/terrain/cells`, cookie, { cells, strokeId: "land" })).status).toBe(204);
  return map;
}
const paths = async (token: string) => (await (await fetch(url(`/api/r/${token}/paths`))).json()) as MapPath[];
const ring: [number, number][] = [[25, 25], [50, 25], [50, 50], [25, 50]];

describe("walls and roads", () => {
  it("draws a closed wall and an open road, and everyone can read them", async () => {
    const cookie = await newVisitor();
    const map = await landMap(cookie, "Walled town");
    const wall = await post(`/api/r/${map.editToken}/paths`, cookie, { kind: "wall", points: ring, closed: true });
    expect(wall.status).toBe(201);
    const road = await post(`/api/r/${map.editToken}/paths`, cookie, { kind: "road", points: [[22, 37], [55, 37]] });
    expect(road.status).toBe(201);
    const list = await paths(map.viewToken);
    expect(list.map((p) => [p.kind, p.points.length, p.closed])).toEqual([["wall", 4, true], ["road", 2, false]]);
  });

  it("refuses walls off the land, bad shapes, and the view link", async () => {
    const cookie = await newVisitor();
    const map = await landMap(cookie, "Rules");
    const draw = (body: unknown, token = map.editToken) => post(`/api/r/${token}/paths`, cookie, body);
    // A wall corner in the sea.
    expect((await draw({ kind: "wall", points: [[30, 30], [90, 30]] })).status).toBe(400);
    // A road may cross water: the renderer lays a causeway.
    expect((await draw({ kind: "road", points: [[30, 30], [90, 30]] })).status).toBe(201);
    expect((await draw({ kind: "moat", points: [[30, 30], [40, 30]] })).status).toBe(400);
    expect((await draw({ kind: "wall", points: [[30, 30]] })).status).toBe(400);
    expect((await draw({ kind: "wall", points: [[30, 30], [30.2, 30.1]] })).status).toBe(400); // collapses to one point
    expect((await draw({ kind: "wall", points: [[30, 30], [40, 30]], closed: true })).status).toBe(400); // a ring of two
    expect((await draw({ kind: "wall", points: [[30, 30], [400, 30]] })).status).toBe(400);
    expect((await draw({ kind: "wall", points: Array.from({ length: 65 }, (_, i) => [21 + (i % 30), 21 + Math.floor(i / 30)]) })).status).toBe(400);
    expect((await draw({ kind: "wall", points: [[30, 30], [40, 30]] }, map.viewToken)).status).toBe(403);
  });

  it("moves a point and removes a path, broadcast as one change each", async () => {
    const cookie = await newVisitor();
    const map = await landMap(cookie, "Edit");
    const wall = (await (await post(`/api/r/${map.editToken}/paths`, cookie, { kind: "wall", points: [[25, 25], [50, 25]] })).json()) as MapPath;
    const moved = await post(`/api/r/${map.editToken}/paths/update`, cookie, { id: wall.id, points: [[25, 25], [50, 40]] });
    expect(moved.status).toBe(200);
    expect((await paths(map.editToken))[0].points).toEqual([[25, 25], [50, 40]]);
    // A move into the sea is refused and leaves it as it was.
    expect((await post(`/api/r/${map.editToken}/paths/update`, cookie, { id: wall.id, points: [[25, 25], [90, 40]] })).status).toBe(400);
    expect((await post(`/api/r/${map.editToken}/paths/update`, cookie, { id: wall.id, kind: "road" })).status).toBe(400);
    expect((await post(`/api/r/${map.editToken}/paths/delete`, cookie, { id: wall.id })).status).toBe(204);
    expect(await paths(map.editToken)).toEqual([]);
    expect((await post(`/api/r/${map.editToken}/paths/delete`, cookie, { id: wall.id })).status).toBe(404);
  });

  it("undoes drawing, reshaping and removing, one step at a time", async () => {
    const cookie = await newVisitor();
    const map = await landMap(cookie, "Undo walls");
    const undo = () => post(`/api/r/${map.editToken}/terrain/undo`, cookie, {});
    const wall = (await (await post(`/api/r/${map.editToken}/paths`, cookie, { kind: "wall", points: ring, closed: true })).json()) as MapPath;
    await post(`/api/r/${map.editToken}/paths/update`, cookie, { id: wall.id, points: [[25, 25], [55, 25], [50, 50], [25, 50]] });
    await post(`/api/r/${map.editToken}/paths/delete`, cookie, { id: wall.id });
    expect(await paths(map.editToken)).toEqual([]);

    const first = await undo();
    expect(first.status).toBe(200);
    expect((await first.json()).what).toBe("path");
    expect((await paths(map.editToken))[0].points[1]).toEqual([55, 25]); // back, as reshaped
    await undo();
    expect((await paths(map.editToken))[0].points).toEqual(ring); // the reshape undone
    await undo();
    expect(await paths(map.editToken)).toEqual([]); // the drawing undone
  });

  it("leaves a wall someone else has reshaped since", async () => {
    const mine = await newVisitor();
    const theirs = await newVisitor();
    const map = await landMap(mine, "Shared walls");
    const wall = (await (await post(`/api/r/${map.editToken}/paths`, mine, { kind: "wall", points: ring, closed: true })).json()) as MapPath;
    await post(`/api/r/${map.editToken}/paths/update`, theirs, { id: wall.id, points: [[25, 25], [45, 25], [50, 50], [25, 50]] });
    const res = await post(`/api/r/${map.editToken}/terrain/undo`, mine, {});
    expect(await res.json()).toMatchObject({ what: "path", skipped: 1 });
    expect((await paths(map.editToken))[0].points[1]).toEqual([45, 25]);
  });

  it("travels with the map through versions, export and import", async () => {
    const cookie = await newVisitor();
    const map = await landMap(cookie, "Keeps its walls");
    await post(`/api/r/${map.editToken}/paths`, cookie, { kind: "palisade", points: ring, closed: true });
    const { id } = await (await post(`/api/r/${map.editToken}/room/versions`, cookie, { name: "With palisade" })).json();
    const drawn = await paths(map.editToken);
    await post(`/api/r/${map.editToken}/paths/delete`, cookie, { id: drawn[0].id });
    await post(`/api/r/${map.editToken}/room/versions/restore`, cookie, { id });
    const restored = await paths(map.editToken);
    expect(restored.map(({ kind, points, closed }) => ({ kind, points, closed }))).toEqual([{ kind: "palisade", points: ring, closed: true }]);

    const file = await (await fetch(url(`/api/r/${map.editToken}/room/export.json`))).json();
    expect(file.paths).toEqual([{ kind: "palisade", points: ring, closed: true }]);
    const copy = await post("/api/rooms", cookie, { name: "Imported", import: file });
    expect(copy.status).toBe(201);
    const imported = await paths((await copy.json()).editToken);
    expect(imported.map((p) => p.kind)).toEqual(["palisade"]);

    // A file with a malformed path is refused whole.
    const bad = await post("/api/rooms", cookie, { name: "Bad", import: { ...file, paths: [{ kind: "wall", points: [[1, 1]] }] } });
    expect(bad.status).toBe(400);
  });
});
