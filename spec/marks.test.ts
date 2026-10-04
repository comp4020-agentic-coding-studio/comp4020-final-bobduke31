import { expect, inject, it } from "vitest";

// Ours to write, per spec/README.md: the app's own behaviour, against the
// same running instance spec/invariants.test.ts checks.
const baseUrl = inject("baseUrl");

it("creates a mark and persists it for a later GET", async () => {
  const create = await fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: 12.5, y: 87, kind: "campfire" }),
  });
  expect(create.status).toBe(201);
  const created = await create.json();
  expect(created).toMatchObject({ x: 12.5, y: 87, kind: "campfire" });
  expect(created.id).toEqual(expect.any(Number));

  const list = await fetch(new URL("/api/marks", baseUrl));
  const marks = await list.json();
  expect(marks.some((m: { id: number }) => m.id === created.id)).toBe(true);
});

it("rejects a mark kind outside the fixed palette", async () => {
  const res = await fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: 10, y: 10, kind: "dragon" }),
  });
  expect(res.status).toBe(400);
});

it("rejects coordinates outside [0, 100]", async () => {
  const res = await fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: 101, y: 10, kind: "flag" }),
  });
  expect(res.status).toBe(400);
});

it("publishes the credits page", async () => {
  const res = await fetch(new URL("/credits/", baseUrl));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("CC0");
  expect(html).toContain("CC BY");
});
