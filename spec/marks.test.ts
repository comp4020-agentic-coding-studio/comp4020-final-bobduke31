import { expect, inject, it } from "vitest";

// Ours to write, per spec/README.md: the app's own behaviour, against the
// same running instance spec/invariants.test.ts checks.
const baseUrl = inject("baseUrl");

// Each real visitor is distinguished by the session cookie the server assigns
// on their first request; a fresh fetch with no Cookie header is a fresh
// visitor, and capturing Set-Cookie lets a test act as a specific one again.
function sessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected the server to assign a session cookie");
  return setCookie.split(";")[0];
}

async function createMarkAs(cookie: string | undefined, kind = "flag") {
  return fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ x: 10, y: 10, kind }),
  });
}

it("creates a mark and persists it for a later GET", async () => {
  const create = await fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: 12.5, y: 87, kind: "campfire" }),
  });
  expect(create.status).toBe(201);
  const created = await create.json();
  expect(created).toMatchObject({ x: 12.5, y: 87, kind: "campfire", mine: true });
  expect(created.id).toEqual(expect.any(Number));
  expect(created.sessionId).toBeUndefined();

  const list = await fetch(new URL("/api/marks", baseUrl));
  const marks = await list.json();
  expect(marks.some((m: { id: number }) => m.id === created.id)).toBe(true);
});

it("lets a visitor remove a mark they placed themselves", async () => {
  const create = await createMarkAs(undefined);
  const cookie = sessionCookie(create);
  const created = await create.json();

  const del = await fetch(new URL(`/api/marks/${created.id}`, baseUrl), {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  expect(del.status).toBe(204);

  const list = await fetch(new URL("/api/marks", baseUrl));
  const marks = await list.json();
  expect(marks.some((m: { id: number }) => m.id === created.id)).toBe(false);
});

it("refuses to let one visitor remove another visitor's mark", async () => {
  const createAsOwner = await createMarkAs(undefined);
  const created = await createAsOwner.json();

  // A second request with no Cookie header is a different, fresh visitor.
  const del = await fetch(new URL(`/api/marks/${created.id}`, baseUrl), { method: "DELETE" });
  expect(del.status).toBe(403);

  const list = await fetch(new URL("/api/marks", baseUrl));
  const marks = await list.json();
  expect(marks.some((m: { id: number }) => m.id === created.id)).toBe(true);
});

it("404s removing a mark that doesn't exist", async () => {
  const del = await fetch(new URL("/api/marks/999999", baseUrl), { method: "DELETE" });
  expect(del.status).toBe(404);
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
