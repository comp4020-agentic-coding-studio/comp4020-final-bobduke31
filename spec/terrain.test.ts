import { expect, inject, it } from "vitest";

// Ours to write, per spec/README.md: the app's own behaviour, against the
// same running instance spec/invariants.test.ts checks.
const baseUrl = inject("baseUrl");

async function postCells(cells: unknown): Promise<Response> {
  return fetch(new URL("/api/terrain/cells", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cells }),
  });
}

// Reads Server-Sent Events frames off a fetch response body until one
// matching `eventType` arrives *and* passes `matches`, or `timeoutMs`
// elapses - the real test of "a change reaches every other open session",
// not just that the create endpoint returns 2xx. The broadcast channel is
// shared by the whole running app (src/realtime.ts), and vitest runs spec
// files concurrently against that one instance, so another spec file's own
// terrain write can legitimately arrive on this same stream first - without
// a content filter, this helper could resolve on someone else's event
// instead of the one this test just caused.
async function waitForEvent(
  stream: ReadableStream<Uint8Array>,
  eventType: string,
  matches: (data: unknown) => boolean,
  timeoutMs = 2000,
): Promise<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`no matching "${eventType}" event within ${timeoutMs}ms`)), timeoutMs),
  );

  const read = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("event stream closed before the expected event arrived");
      buffer += decoder.decode(value, { stream: true });

      let frameEnd: number;
      while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const type = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (type === eventType && data) {
          const parsed = JSON.parse(data);
          if (matches(parsed)) return parsed;
        }
      }
    }
  })();

  try {
    return await Promise.race([read, timeout]);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

it("persists a painted cell and lists it back", async () => {
  const cell = { x: 10, y: 20, elevation: 0.4 };
  const res = await postCells([cell]);
  expect(res.status).toBe(204);

  const list = await fetch(new URL("/api/terrain", baseUrl));
  const cells = await list.json();
  expect(cells).toContainEqual(cell);
});

it("broadcasts a painted cell to an open event stream within a second", async () => {
  const events = await fetch(new URL("/api/events", baseUrl));
  expect(events.headers.get("content-type")).toContain("text/event-stream");
  expect(events.body).not.toBeNull();

  const cell = { x: 55, y: 60, elevation: -0.3 };
  const waiting = waitForEvent(
    events.body as ReadableStream<Uint8Array>,
    "terrain:update",
    (data) => (data as { cells: typeof cell[] }).cells.some((c) => c.x === cell.x && c.y === cell.y),
  );
  await postCells([cell]);

  const payload = (await waiting) as { cells: typeof cell[] };
  expect(payload.cells).toContainEqual(cell);
});

it("rejects a cell outside the grid", async () => {
  const res = await postCells([{ x: 999, y: 0, elevation: 0 }]);
  expect(res.status).toBe(400);
});

it("rejects an elevation outside the allowed range", async () => {
  const res = await postCells([{ x: 1, y: 1, elevation: 5 }]);
  expect(res.status).toBe(400);
});

it("rejects an empty batch", async () => {
  const res = await postCells([]);
  expect(res.status).toBe(400);
});

async function postTypes(cells: unknown): Promise<Response> {
  return fetch(new URL("/api/terrain/types", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cells }),
  });
}

it("paints a terrain type onto land and lists it back", async () => {
  await postCells([{ x: 70, y: 10, elevation: 0.5 }]); // make it land first
  const res = await postTypes([{ x: 70, y: 10, terrain: "forest" }]);
  expect(res.status).toBe(204);

  const list = await fetch(new URL("/api/terrain-types", baseUrl));
  const types = await list.json();
  expect(types).toContainEqual({ x: 70, y: 10, terrain: "forest" });
});

it("silently ignores a terrain type painted onto sea", async () => {
  // (71, 10) has never been painted, so it defaults to sea.
  const res = await postTypes([{ x: 71, y: 10, terrain: "forest" }]);
  expect(res.status).toBe(204);

  const list = await fetch(new URL("/api/terrain-types", baseUrl));
  const types = await list.json();
  expect(types).not.toContainEqual(expect.objectContaining({ x: 71, y: 10 }));
});

it("clears a cell's terrain type when it's painted back to sea, and broadcasts the clear", async () => {
  await postCells([{ x: 72, y: 10, elevation: 0.5 }]);
  await postTypes([{ x: 72, y: 10, terrain: "rock" }]);

  const events = await fetch(new URL("/api/events", baseUrl));
  const waiting = waitForEvent(
    events.body as ReadableStream<Uint8Array>,
    "terrain-type:clear",
    (data) => (data as { cells: { x: number; y: number }[] }).cells.some((c) => c.x === 72 && c.y === 10),
  );
  await postCells([{ x: 72, y: 10, elevation: -0.5 }]); // paint it back to sea

  const payload = (await waiting) as { cells: { x: number; y: number }[] };
  expect(payload.cells).toContainEqual({ x: 72, y: 10 });

  const list = await fetch(new URL("/api/terrain-types", baseUrl));
  const types = await list.json();
  expect(types).not.toContainEqual(expect.objectContaining({ x: 72, y: 10 }));
});

it("rejects an unknown terrain type", async () => {
  const res = await postTypes([{ x: 1, y: 1, terrain: "lava" }]);
  expect(res.status).toBe(400);
});
