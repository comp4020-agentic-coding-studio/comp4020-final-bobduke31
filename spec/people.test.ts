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
    expect(room.present).toContainEqual(expect.objectContaining({ name: "Marrow", tincture: "purpure", editing: false }));
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

  it("tells each person which entry is theirs, even when two share a name and colour", async () => {
    const owner = cookieOf((await getMe()).res);
    const map = (await (
      await fetch(url("/api/rooms"), { method: "POST", headers: { "Content-Type": "application/json", Cookie: owner }, body: JSON.stringify({ name: "Twins" }) })
    ).json()) as { editToken: string };
    const a = cookieOf((await getMe()).res);
    const b = cookieOf((await getMe()).res);
    for (const c of [a, b]) await postMe(c, { name: "Wren Hale", tincture: "or" });

    const yourKey = async (cookie: string) => {
      const res = await fetch(url(`/api/r/${map.editToken}/events`), { headers: { Cookie: cookie } });
      const reader = res.body!.getReader();
      let text = "";
      while (!text.includes("event: presence:you")) text += new TextDecoder().decode((await reader.read()).value);
      const key = /event: presence:you\ndata: (.*)\n/.exec(text)![1];
      return { key: JSON.parse(key).key as string, close: () => reader.cancel() };
    };
    const sa = await yourKey(a);
    const sb = await yourKey(b);
    const room = (await (await fetch(url(`/api/r/${map.editToken}/room`), { headers: { Cookie: owner } })).json()) as {
      present: { key: string; name: string }[];
    };
    await sa.close();
    await sb.close();
    const twins = room.present.filter((p) => p.name === "Wren Hale");
    expect(twins).toHaveLength(2);
    expect(sa.key).not.toBe(sb.key);
    expect(twins.map((p) => p.key).sort()).toEqual([sa.key, sb.key].sort());
    // The key is opaque: not the session id.
    for (const c of [a, b]) expect(JSON.stringify(room.present)).not.toContain(c.split("=")[1]);
  });

  it("shows a first-time visitor under their real name from the moment they arrive", async () => {
    const owner = cookieOf((await getMe()).res);
    const map = (await (
      await fetch(url("/api/rooms"), { method: "POST", headers: { "Content-Type": "application/json", Cookie: owner }, body: JSON.stringify({ name: "Arrival" }) })
    ).json()) as { viewToken: string; editToken: string };
    // A brand-new visitor opens the stream before ever calling /api/me.
    const first = await fetch(url(`/api/r/${map.viewToken}/events`));
    const cookie = cookieOf(first);
    const room = (await (await fetch(url(`/api/r/${map.editToken}/room`), { headers: { Cookie: owner } })).json()) as { present: { name: string }[] };
    const me = await getMe(cookie);
    await first.body?.cancel();
    expect(me.body.isNew).toBe(false);
    expect(room.present.map((p) => p.name)).toContain(me.body.name);
  });

  it("doesn't count someone reading the activity log as being at the map", async () => {
    const owner = cookieOf((await getMe()).res);
    const map = (await (
      await fetch(url("/api/rooms"), { method: "POST", headers: { "Content-Type": "application/json", Cookie: owner }, body: JSON.stringify({ name: "Log reader" }) })
    ).json()) as { viewToken: string; editToken: string };
    const reader = cookieOf((await getMe()).res);
    const stream = await fetch(url(`/api/r/${map.viewToken}/events?watch=log`), { headers: { Cookie: reader } });
    const room = (await (await fetch(url(`/api/r/${map.editToken}/room`), { headers: { Cookie: owner } })).json()) as { present: unknown[] };
    await stream.body?.cancel();
    expect(room.present).toHaveLength(0);
  });
});

describe("where a rename is logged", () => {
  const publicLog = async () =>
    (await (await fetch(url("/api/activity"))).json()) as { action: string; detail: string }[];

  it("in a private map you're working in, not in the shared world", async () => {
    const cookie = cookieOf((await getMe()).res);
    const map = (await (
      await fetch(url("/api/rooms"), { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: "Private rename" }) })
    ).json()) as { editToken: string };
    const stream = await fetch(url(`/api/r/${map.editToken}/events`), { headers: { Cookie: cookie } });
    const unique = `Private Person ${Date.now() % 100000}`;
    await postMe(cookie, { name: unique });
    await stream.body?.cancel();

    const privateLog = (await (await fetch(url(`/api/r/${map.editToken}/activity`))).json()) as { action: string; detail: string }[];
    expect(privateLog.some((e) => e.action === "person:rename" && e.detail.includes(unique))).toBe(true);
    expect((await publicLog()).some((e) => e.detail.includes(unique))).toBe(false);
  });

  it("in the shared world once you've edited there", async () => {
    const cookie = cookieOf((await getMe()).res);
    await fetch(url("/api/terrain/cells"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ cells: [{ x: 3, y: 3, elevation: 0.3 }] }),
    });
    const unique = `Public Person ${Date.now() % 100000}`;
    await postMe(cookie, { name: unique });
    expect((await publicLog()).some((e) => e.action === "person:rename" && e.detail.includes(unique))).toBe(true);
  });

  it("nowhere, for someone who hasn't opened or touched any map", async () => {
    const cookie = cookieOf((await getMe()).res);
    const unique = `Nobody ${Date.now() % 100000}`;
    await postMe(cookie, { name: unique });
    expect((await publicLog()).some((e) => e.detail.includes(unique))).toBe(false);
  });
});
