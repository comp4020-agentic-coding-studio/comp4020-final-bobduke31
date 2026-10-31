import { describe, expect, inject, it } from "vitest";

// The cap on maps (src/rooms.ts) protects the 1 GB volume, so it counts
// maps that hold something. On 31 Oct production refused every new map:
// 136 of its 150 were untouched maps left by spec runs, holding 34 cells
// between them, while the volume was 90% free (ROADMAP.md, v19). This
// creates more empty maps than the cap, so it runs only against a
// throwaway database (spec/README.md).
const baseUrl = inject("baseUrl");
const url = (path: string) => new URL(path, baseUrl);

const CAP = 150;

async function newVisitor(): Promise<string> {
  const setCookie = (await fetch(url("/api/me"))).headers.get("set-cookie");
  if (!setCookie) throw new Error("expected the server to assign a session cookie");
  return setCookie.split(";")[0];
}

const createMap = (cookie: string, name: string) =>
  fetch(url("/api/rooms"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name }),
  });

describe("the cap on maps", () => {
  it("doesn't let empty maps fill it", { timeout: 120_000 }, async () => {
    // Fewer than the per-visitor daily limit each, so only the total cap
    // could refuse one.
    let made = 0;
    while (made < CAP + 10) {
      const visitor = await newVisitor();
      for (let i = 0; i < 5 && made < CAP + 10; i++, made++) {
        const res = await createMap(visitor, `Empty ${made}`);
        expect(res.status, `map ${made + 1}: ${await res.clone().text()}`).toBe(201);
      }
    }
  });

  it("still lets a visitor make a map and draw on it afterwards", async () => {
    const visitor = await newVisitor();
    const res = await createMap(visitor, "Drawn on");
    expect(res.status).toBe(201);
    const { editToken } = (await res.json()) as { editToken: string };
    const painted = await fetch(url(`/api/r/${editToken}/terrain/cells`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: visitor },
      body: JSON.stringify({ cells: [{ x: 5, y: 5, elevation: 0.3 }], strokeId: "capacity" }),
    });
    expect(painted.status).toBe(204);
  });
});
