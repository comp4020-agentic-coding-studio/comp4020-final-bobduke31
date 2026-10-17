import { expect, inject, it } from "vitest";

// C10's own requirement, tested the same way marks.test.ts already tests
// per-session ownership: a fresh fetch with no Cookie header is a distinct
// visitor, and a captured Set-Cookie lets a test act as that visitor again.
const baseUrl = inject("baseUrl");

function sessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected the server to assign a session cookie");
  return setCookie.split(";")[0];
}

async function paintAs(cookie: string | undefined, cell: { x: number; y: number; elevation: number }) {
  return fetch(new URL("/api/terrain/cells", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ cells: [cell] }),
  });
}

async function undoAs(cookie: string | undefined) {
  return fetch(new URL("/api/terrain/undo", baseUrl), {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
  });
}

it("logs a terrain paint with a session-derived display name distinguishing visitors", async () => {
  const paint = await paintAs(undefined, { x: 200, y: 10, elevation: 0.3 });
  const cookie = sessionCookie(paint);

  const log = await fetch(new URL("/api/activity", baseUrl));
  const entries = (await log.json()) as { action: string; displayName: string; sessionId: string }[];
  const entry = entries.find((e) => e.action === "terrain:paint");
  expect(entry).toBeDefined();
  expect(entry!.displayName).toEqual(expect.any(String));
  expect(entry!.displayName.length).toBeGreaterThan(0);
  // The raw session id is logged server-side (for an operator reading the
  // DB directly) but a *different* cookie must get a *different* name -
  // this is the part the crit's demo actually looks at.
  const other = await paintAs(undefined, { x: 201, y: 10, elevation: 0.3 });
  const otherCookie = sessionCookie(other);
  expect(otherCookie).not.toEqual(cookie);

  const log2 = await fetch(new URL("/api/activity", baseUrl));
  const entries2 = (await log2.json()) as { displayName: string; sessionId: string }[];
  const names = new Set(entries2.map((e) => e.displayName));
  expect(names.size).toBeGreaterThan(1);
});

it("lets a visitor undo their own last terrain stroke", async () => {
  // A cell with no prior paint in this test run - "before" is whatever
  // elevationAt's own default is, confirmed by reading it back after undo
  // rather than assumed.
  const before = await fetch(new URL("/api/terrain", baseUrl));
  const beforeCells = (await before.json()) as { x: number; y: number; elevation: number }[];
  const priorElevation = beforeCells.find((c) => c.x === 210 && c.y === 10)?.elevation ?? 0;

  const paint = await paintAs(undefined, { x: 210, y: 10, elevation: 0.42 });
  const cookie = sessionCookie(paint);

  const undo = await undoAs(cookie);
  expect(undo.status).toBe(204);

  const after = await fetch(new URL("/api/terrain", baseUrl));
  const afterCells = (await after.json()) as { x: number; y: number; elevation: number }[];
  const restored = afterCells.find((c) => c.x === 210 && c.y === 10)?.elevation ?? 0;
  expect(restored).toBeCloseTo(priorElevation, 10);
});

it("refuses to undo when the requesting session has nothing to undo", async () => {
  const res = await undoAs(undefined); // a fresh session, never painted
  expect(res.status).toBe(409);
});

it("never lets one session's undo touch a different session's stroke (the C10 server-side check)", async () => {
  const paintA = await paintAs(undefined, { x: 220, y: 10, elevation: 0.55 });
  const cookieA = sessionCookie(paintA);

  // Session B undoes with its own (different) cookie - it has nothing of
  // its own to undo, so this must fail, and crucially must leave A's cell
  // completely untouched rather than accidentally restoring A's snapshot.
  const undoB = await undoAs(undefined);
  expect(undoB.status).toBe(409);

  const list = await fetch(new URL("/api/terrain", baseUrl));
  const cells = (await list.json()) as { x: number; y: number; elevation: number }[];
  expect(cells).toContainEqual({ x: 220, y: 10, elevation: 0.55 });

  // Session A can still undo its own stroke afterwards - B's failed attempt
  // didn't consume or corrupt A's snapshot.
  const undoA = await undoAs(cookieA);
  expect(undoA.status).toBe(204);
});

it("publishes the live activity log page", async () => {
  const res = await fetch(new URL("/logs/", baseUrl));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Activity log");
});
