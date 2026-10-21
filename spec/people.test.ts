import { describe, expect, inject, it } from "vitest";

// Identity (Atlas Table step I): every visitor gets a generated, editable
// cartographer's name and heraldic tincture, keyed by their anonymous
// session, and that identity is what other people see.
const baseUrl = inject("baseUrl");
const url = (path: string) => new URL(path, baseUrl);

function cookieOf(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a session cookie");
  return setCookie.split(";")[0];
}

const getMe = async (cookie?: string) => {
  const res = await fetch(url("/api/me"), { headers: cookie ? { Cookie: cookie } : {} });
  return { res, body: (await res.json()) as { name: string; tincture: string; isNew: boolean; tinctures: string[] } };
};

const postMe = (cookie: string, body: unknown) =>
  fetch(url("/api/me"), { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });

describe("your identity", () => {
  it("is generated on first visit and stays the same afterwards", async () => {
    const first = await getMe();
    const cookie = cookieOf(first.res);
    expect(first.body.isNew).toBe(true);
    expect(first.body.name).toMatch(/^\p{L}+ \S/u);
    expect(first.body.tinctures).toContain(first.body.tincture);

    const again = await getMe(cookie);
    expect(again.body).toMatchObject({ name: first.body.name, tincture: first.body.tincture, isNew: false });
  });

  it("can be renamed and recoloured, and the change persists", async () => {
    const cookie = cookieOf((await getMe()).res);
    const res = await postMe(cookie, { name: "  Tamsin   Greywater ", tincture: "or" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Tamsin Greywater", tincture: "or" });
    expect((await getMe(cookie)).body).toMatchObject({ name: "Tamsin Greywater", tincture: "or" });
  });

  it("changes only what was sent", async () => {
    const cookie = cookieOf((await getMe()).res);
    const { name } = (await getMe(cookie)).body;
    await postMe(cookie, { tincture: "vert" });
    expect((await getMe(cookie)).body).toMatchObject({ name, tincture: "vert" });
  });

  it("rejects an empty or overlong name and an unknown colour", async () => {
    const cookie = cookieOf((await getMe()).res);
    for (const body of [{ name: "" }, { name: "   " }, { name: "x".repeat(33) }, { name: 7 }, { tincture: "pink" }]) {
      expect((await postMe(cookie, body)).status).toBe(400);
    }
  });

  it("is one person's alone: another visitor can't change it", async () => {
    const alice = cookieOf((await getMe()).res);
    await postMe(alice, { name: "Alice of the Vale" });
    const bob = cookieOf((await getMe()).res);
    await postMe(bob, { name: "Bob Hale" });
    expect((await getMe(alice)).body.name).toBe("Alice of the Vale");
  });
});

describe("what others see", () => {
  it("shows your chosen name and colour in presence, never your session id", async () => {
    const owner = cookieOf((await getMe()).res);
    const map = (await (
      await fetch(url("/api/rooms"), { method: "POST", headers: { "Content-Type": "application/json", Cookie: owner }, body: JSON.stringify({ name: "Presence test" }) })
    ).json()) as { editToken: string; viewToken: string };
    const viewer = cookieOf((await getMe()).res);
    await postMe(viewer, { name: "Marrow", tincture: "purpure" });

    const stream = await fetch(url(`/api/r/${map.viewToken}/events`), { headers: { Cookie: viewer } });
    const room = (await (await fetch(url(`/api/r/${map.editToken}/room`), { headers: { Cookie: owner } })).json()) as {
      present: { name: string; tincture: string; editing: boolean }[];
    };
    await stream.body?.cancel();
    expect(room.present).toContainEqual({ name: "Marrow", tincture: "purpure", editing: false });
    expect(JSON.stringify(room.present)).not.toContain(viewer.split("=")[1]);
  });

  it("shows your current name on your activity, including after a rename", async () => {
    const cookie = cookieOf((await getMe()).res);
    const map = (await (
      await fetch(url("/api/rooms"), { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: "Log test" }) })
    ).json()) as { editToken: string };
    await postMe(cookie, { name: "Before Rename", tincture: "azure" });
    await fetch(url(`/api/r/${map.editToken}/terrain/cells`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ cells: [{ x: 4, y: 4, elevation: 0.3 }] }),
    });
    await postMe(cookie, { name: "After Rename" });
    const log = (await (await fetch(url(`/api/r/${map.editToken}/activity`))).json()) as { displayName: string; tincture: string; action: string }[];
    const paint = log.find((e) => e.action === "terrain:paint");
    expect(paint).toMatchObject({ displayName: "After Rename", tincture: "azure" });
  });
});
