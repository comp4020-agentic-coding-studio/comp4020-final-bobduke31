import { describe, expect, inject, it } from "vitest";
import { forgeWorld, previewPixels, TEMPLATES } from "../public/world/forge.js";
import { brushFalloff, softRaise, strengthFromSlider, sliderFromStrength, coverageAccepts } from "../public/world/brush.js";
import { createHash } from "node:crypto";

// The Forge (Atlas Table step II): a new map can start from generated
// terrain. The client sends a seed, a template and three sliders; the server
// runs the same generator the preview ran and stores the result.
const baseUrl = inject("baseUrl");
const url = (path: string) => new URL(path, baseUrl);
const N = 256;

const hash = (a: ArrayBufferView) => createHash("sha256").update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest("hex");

function cookieOf(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a session cookie");
  return setCookie.split(";")[0];
}

async function newSession(): Promise<string> {
  return cookieOf(await fetch(url("/api/me")));
}

const create = (cookie: string, body: unknown) =>
  fetch(url("/api/rooms"), { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });

describe("the generator", () => {
  it("is deterministic: the same seed and settings give the same world", () => {
    for (const t of TEMPLATES) {
      const a = forgeWorld("Saltmere 412", t, { land: 0.4, mountains: 0.8, forest: 0.3 });
      const b = forgeWorld("Saltmere 412", t, { land: 0.4, mountains: 0.8, forest: 0.3 });
      expect(hash(a.elevation)).toBe(hash(b.elevation));
      expect(hash(a.types)).toBe(hash(b.types));
    }
    expect(hash(forgeWorld("a", "continent").elevation)).not.toBe(hash(forgeWorld("b", "continent").elevation));
  });

  it("keeps heights in the stored range, with no cliff-steps on land", () => {
    for (const t of ["continent", "coast", "archipelago"]) {
      for (const mountains of [0, 0.5, 1]) {
        const { elevation, types } = forgeWorld("Vey", t, { mountains });
        let steepest = 0, lo = 0, hi = 0, typedSea = 0;
        for (let i = 0; i < N * N; i++) {
          lo = Math.min(lo, elevation[i]);
          hi = Math.max(hi, elevation[i]);
          if (elevation[i] <= 0 && types[i]) typedSea++;
          if (i % N && elevation[i] > 0 && elevation[i - 1] > 0) steepest = Math.max(steepest, Math.abs(elevation[i] - elevation[i - 1]));
        }
        expect(lo).toBeGreaterThanOrEqual(-1);
        expect(hi).toBeLessThanOrEqual(1);
        expect(typedSea).toBe(0);
        // The brush's natural-slope limit; a generated world stays inside it.
        expect(steepest).toBeLessThan(0.15);
      }
    }
  }, 20_000);

  it("follows its sliders: more land, taller mountains, more forest", () => {
    const share = (s: object, f: (e: number, t: number) => boolean) => {
      const { elevation, types } = forgeWorld("Oakhollow", "continent", s);
      let n = 0;
      for (let i = 0; i < N * N; i++) if (f(elevation[i], types[i])) n++;
      return n;
    };
    expect(share({ land: 0.9 }, (e) => e > 0)).toBeGreaterThan(share({ land: 0.1 }, (e) => e > 0) * 1.8);
    expect(share({ mountains: 1 }, (e) => e > 0.42)).toBeGreaterThan(share({ mountains: 0 }, (e) => e > 0.42) * 3);
    expect(share({ forest: 1 }, (_, t) => t === 2)).toBeGreaterThan(share({ forest: 0 }, (_, t) => t === 2) * 2);
  });

  it("draws a preview of the requested size", () => {
    const px = previewPixels(forgeWorld("Vey", "coast"), 64);
    expect(px.length).toBe(64 * 64 * 4);
    expect(px[3]).toBe(255);
  });
});

describe("the brush", () => {
  it("has a perceptual strength scale from 0.5% to 50% that round-trips", () => {
    expect(strengthFromSlider(0)).toBeCloseTo(0.005);
    expect(strengthFromSlider(100)).toBeCloseTo(0.5);
    for (const v of [0, 13, 45, 77, 100]) expect(sliderFromStrength(strengthFromSlider(v))).toBe(v);
    // Equal steps are equal ratios: fine control at the low end.
    expect(strengthFromSlider(20) / strengthFromSlider(10)).toBeCloseTo(strengthFromSlider(90) / strengthFromSlider(80));
  });

  it("falls off smoothly, with hardness widening a solid core", () => {
    expect(brushFalloff(0, 10, 0)).toBe(1);
    expect(brushFalloff(10, 10, 0)).toBe(0);
    expect(brushFalloff(11, 10, 0)).toBe(0);
    expect(brushFalloff(5, 10, 0)).toBeCloseTo(0.5);
    expect(brushFalloff(5, 10, 0.6)).toBe(1);
    expect(brushFalloff(9, 10, 0.6)).toBeGreaterThan(0);
  });

  it("raises nearly linearly when there's room, and never past the cap", () => {
    expect(softRaise(0.1, 0.02, 1)).toBeCloseTo(0.12, 3);
    let h = 0.1;
    for (let k = 0; k < 200; k++) h = softRaise(h, 0.2, 0.72);
    expect(h).toBeLessThanOrEqual(0.72);
    expect(h).toBeGreaterThan(0.71);
  });

  it("paints every cell at full coverage and fewer below it", () => {
    let full = 0, half = 0;
    for (let k = 0; k < 1000; k++) {
      const n = Math.sin(k * 12.9898) % 1;
      if (coverageAccepts(n, 1, 1)) full++;
      if (coverageAccepts(n, 0.4, 1)) half++;
    }
    expect(full).toBe(1000);
    expect(half).toBeGreaterThan(200);
    expect(half).toBeLessThan(600);
  });
});

describe("creating a map from the Forge", () => {
  it("stores the world the generator makes for that seed, sparsely", async () => {
    const cookie = await newSession();
    const forge = { seed: "Thornwick 207", template: "continent", settings: { land: 0.5, mountains: 0.6, forest: 0.5 } };
    const res = await create(cookie, { name: "Forge spec", forge });
    expect(res.status).toBe(201);
    const { editToken } = (await res.json()) as { editToken: string };

    const cells = (await (await fetch(url(`/api/r/${editToken}/terrain`))).json()) as { x: number; y: number; elevation: number }[];
    const types = (await (await fetch(url(`/api/r/${editToken}/terrain-types`))).json()) as { x: number; y: number; terrain: string }[];
    const expected = forgeWorld(forge.seed, forge.template, forge.settings);

    let land = 0;
    for (let i = 0; i < N * N; i++) if (expected.elevation[i] > 0) land++;
    const storedLand = cells.filter((c) => c.elevation > 0);
    expect(storedLand.length).toBe(land);
    // Open ocean isn't stored (it reads as sea anyway).
    expect(cells.length).toBeLessThan(N * N * 0.8);
    for (const c of cells.filter((_, k) => k % 97 === 0)) {
      expect(c.elevation).toBeCloseTo(expected.elevation[c.y * N + c.x], 3);
    }
    const forests = types.filter((t) => t.terrain === "forest").length;
    let expectedForests = 0;
    for (let i = 0; i < N * N; i++) if (expected.types[i] === 2 && expected.elevation[i] > 0) expectedForests++;
    expect(forests).toBe(expectedForests);
  });

  it("ignores any cells a client sends with the request", async () => {
    const cookie = await newSession();
    const res = await create(cookie, {
      name: "Smuggler",
      forge: { seed: "Vey", template: "archipelago", settings: {}, cells: [{ x: 0, y: 0, elevation: 1 }] },
      cells: [{ x: 1, y: 1, elevation: 1 }],
    });
    expect(res.status).toBe(201);
    const { editToken } = (await res.json()) as { editToken: string };
    const cells = (await (await fetch(url(`/api/r/${editToken}/terrain`))).json()) as { x: number; y: number; elevation: number }[];
    const at = (x: number, y: number) => cells.find((c) => c.x === x && c.y === y);
    expect(at(0, 0)?.elevation ?? 0).toBeLessThanOrEqual(0);
    expect(at(1, 1)?.elevation ?? 0).toBeLessThanOrEqual(0);
  });

  it("clamps sliders it's sent out of range rather than trusting them", async () => {
    const cookie = await newSession();
    const res = await create(cookie, { name: "Clamped", forge: { seed: "Vey", template: "coast", settings: { land: 99, mountains: -5, forest: "lots" } } });
    expect(res.status).toBe(201);
    const { editToken } = (await res.json()) as { editToken: string };
    const cells = (await (await fetch(url(`/api/r/${editToken}/terrain`))).json()) as { elevation: number }[];
    const expected = forgeWorld("Vey", "coast", { land: 1, mountains: 0, forest: 0.5 });
    let land = 0;
    for (const e of expected.elevation) if (e > 0) land++;
    expect(cells.filter((c) => c.elevation > 0).length).toBe(land);
  });

  it("rejects a forge request without a usable seed or template", async () => {
    const cookie = await newSession();
    for (const forge of [{ seed: "", template: "continent" }, { seed: "x", template: "volcano" }, { template: "coast" }, "continent"]) {
      expect((await create(cookie, { name: "Bad forge", forge })).status).toBe(400);
    }
  });

  it("an empty-sea start stores nothing, like a plain new map", async () => {
    const cookie = await newSession();
    const res = await create(cookie, { name: "Empty", forge: { seed: "x", template: "blank", settings: {} } });
    expect(res.status).toBe(201);
    const { editToken } = (await res.json()) as { editToken: string };
    expect(await (await fetch(url(`/api/r/${editToken}/terrain`))).json()).toEqual([]);
  });
});
