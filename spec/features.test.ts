import { expect, inject, it } from "vitest";

// Ours to write, per spec/README.md: the app's own behaviour, against the
// same running instance spec/invariants.test.ts checks.
const baseUrl = inject("baseUrl");

async function postFeature(geometry: unknown, kind: string) {
  return fetch(new URL("/api/features", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "Feature", geometry, properties: { kind } }),
  });
}

async function postDabs(dabs: unknown) {
  return fetch(new URL("/api/terrain-dabs", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dabs }),
  });
}

it("serves an empty-or-existing feature collection", async () => {
  const res = await fetch(new URL("/api/features", baseUrl));
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.type).toBe("FeatureCollection");
  expect(Array.isArray(data.features)).toBe(true);
});

it("creates, lists, and deletes a line feature", async () => {
  const line = { type: "LineString", coordinates: [[0, 0], [5, 5], [10, 0]] };
  const create = await postFeature(line, "road");
  expect(create.status).toBe(201);
  const created = await create.json();
  expect(created).toMatchObject({ properties: { kind: "road" } });
  expect(created.id).toEqual(expect.any(Number));

  const list = await fetch(new URL("/api/features", baseUrl));
  const { features } = await list.json();
  expect(features.some((f: { id: number }) => f.id === created.id)).toBe(true);

  const del = await fetch(new URL(`/api/features/${created.id}`, baseUrl), { method: "DELETE" });
  expect(del.status).toBe(204);

  const listAfter = await fetch(new URL("/api/features", baseUrl));
  const { features: after } = await listAfter.json();
  expect(after.some((f: { id: number }) => f.id === created.id)).toBe(false);
});

it("creates a marker feature", async () => {
  const point = { type: "Point", coordinates: [50, 50] };
  const markerRes = await postFeature(point, "building");
  expect(markerRes.status).toBe(201);
  expect((await markerRes.json()).geometry.type).toBe("Point");
});

it("rejects a kind that doesn't match its geometry type", async () => {
  const line = { type: "LineString", coordinates: [[0, 0], [1, 1]] };
  const res = await postFeature(line, "building"); // building is a marker kind, not a line kind
  expect(res.status).toBe(400);
});

it("rejects a terrain kind on /api/features - terrain isn't a GeoJSON feature anymore", async () => {
  const point = { type: "Point", coordinates: [1, 1] };
  const res = await postFeature(point, "grass");
  expect(res.status).toBe(400);
});

it("rejects a malformed geometry", async () => {
  const res = await postFeature({ type: "LineString", coordinates: "not-an-array" }, "road");
  expect(res.status).toBe(400);
});

it("updates a feature's geometry via PUT", async () => {
  const point = { type: "Point", coordinates: [30, 30] };
  const create = await postFeature(point, "ruin");
  const created = await create.json();

  const moved = { type: "Point", coordinates: [40, 42] };
  const put = await fetch(new URL(`/api/features/${created.id}`, baseUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geometry: moved }),
  });
  expect(put.status).toBe(200);
  const updated = await put.json();
  expect(updated.geometry.coordinates).toEqual([40, 42]);
});

it("404s updating or deleting a feature that doesn't exist", async () => {
  const put = await fetch(new URL("/api/features/999999", baseUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geometry: { type: "Point", coordinates: [1, 1] } }),
  });
  expect(put.status).toBe(404);

  const del = await fetch(new URL("/api/features/999999", baseUrl), { method: "DELETE" });
  expect(del.status).toBe(404);
});

it("serves an empty-or-existing terrain dab list", async () => {
  const res = await fetch(new URL("/api/terrain-dabs", baseUrl));
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(Array.isArray(data.dabs)).toBe(true);
});

it("creates a batch of terrain dabs in one request and lists them back in order", async () => {
  const dabs = [
    { x: 100, y: 100, radius: 34, kind: "grass", seed: 12345 },
    { x: 109, y: 103, radius: 34, kind: "grass", seed: 12345 },
    { x: 118, y: 106, radius: 34, kind: "sand", seed: 67890 },
  ];
  const res = await postDabs(dabs);
  expect(res.status).toBe(201);
  const { dabs: created } = await res.json();
  expect(created).toHaveLength(3);
  expect(created.map((d: { kind: string }) => d.kind)).toEqual(["grass", "grass", "sand"]);

  const list = await fetch(new URL("/api/terrain-dabs", baseUrl));
  const { dabs: all } = await list.json();
  const ids = created.map((d: { id: number }) => d.id);
  expect(ids.every((id: number, i: number) => i === 0 || id > ids[i - 1])).toBe(true);
  expect(all.some((d: { id: number }) => d.id === created[0].id)).toBe(true);
});

it("rejects a terrain dab batch with an unknown kind", async () => {
  const res = await postDabs([{ x: 1, y: 1, radius: 10, kind: "lava", seed: 1 }]);
  expect(res.status).toBe(400);
});

it("accepts an eraser dab - it's a valid brush kind, just not a terrain one", async () => {
  const res = await postDabs([{ x: 5, y: 5, radius: 10, kind: "eraser", seed: 1 }]);
  expect(res.status).toBe(201);
  const { dabs: created } = await res.json();
  expect(created[0].kind).toBe("eraser");
});

it("rejects an empty terrain dab batch", async () => {
  const res = await postDabs([]);
  expect(res.status).toBe(400);
});

it("rejects a malformed terrain dab", async () => {
  const res = await postDabs([{ x: "nope", y: 1, radius: 10, kind: "grass", seed: 1 }]);
  expect(res.status).toBe(400);
});

it("publishes the credits page", async () => {
  const res = await fetch(new URL("/credits/", baseUrl));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("CC0");
});
