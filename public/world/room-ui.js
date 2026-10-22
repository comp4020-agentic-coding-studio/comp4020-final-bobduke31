// Which map this page is showing, and everything around it that isn't the
// map itself: share links, the Maps menu, renaming, who's here, view-only
// mode. ADR 3: the token in the URL is the credential; the server decides
// the role, and this module only reflects it.

const match = /^\/m\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
const token = match ? match[1] : null;

// Every room-scoped API path goes through here: the public room keeps its
// original unprefixed routes, a private map gets /api/r/<token>/...
export function apiPath(path) {
  return token ? `/api/r/${token}${path.slice("/api".length)}` : path;
}

export const room = {
  name: "The shared world",
  role: "edit",
  isPublic: true,
  canEdit: true,
};

const $ = (id) => document.getElementById(id);
const els = {
  name: $("room-name"),
  rename: $("rename-button"),
  badge: $("role-badge"),
  share: $("share-button"),
  presence: $("presence"),
  error: $("room-error"),
  toast: $("toast"),
  shareDialog: $("share-dialog"),
  mapsDialog: $("maps-dialog"),
  renameDialog: $("rename-dialog"),
};

let toastTimer;
export function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  // Long enough to read: about a second per 15 characters, at least 2.6 s.
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), Math.max(2600, message.length * 65));
}

function setName(name) {
  room.name = name;
  els.name.textContent = name;
  els.name.title = name;
  document.title = `${name} · Atlas Table`;
  const shareName = document.getElementById("share-map-name");
  if (shareName) shareName.textContent = name;
  if (token) $("activity-link").textContent = `Activity on ${name}`;
}

const linkFor = (t) => `${location.origin}/m/${t}`;

// Fetches this page's room and role. Resolves false when the link names no
// map, after showing the "no map at this link" panel.
export async function loadRoom() {
  const res = await fetch(apiPath("/api/room"));
  if (res.status === 404) {
    els.error.classList.remove("hidden");
    document.body.classList.add("read-only");
    els.name.textContent = "Map not found";
    return false;
  }
  const data = await res.json();
  room.role = data.role;
  room.isPublic = data.isPublic;
  room.canEdit = data.role === "edit";
  setName(data.name);
  document.body.classList.toggle("read-only", !room.canEdit);
  $("public-badge").classList.toggle("hidden", !room.isPublic);
  if (!room.canEdit) {
    $("category-hint").textContent = "You're watching this map. Every change anyone makes appears here live. Ask for the edit link to make changes yourself.";
    $("camera-hint").textContent = "Scroll or use Zoom to zoom. Drag the map to pan.";
  }
  els.badge.classList.toggle("hidden", room.canEdit);
  els.rename.classList.toggle("hidden", !room.canEdit || room.isPublic);
  els.share.classList.toggle("hidden", room.isPublic || !data.editToken);
  if (data.editToken) {
    $("share-edit").value = linkFor(data.editToken);
    $("share-view").value = linkFor(data.viewToken);
    $("share-gallery").checked = !!data.listed;
  }
  if (token) {
    $("activity-link").href = `/logs/#map=${encodeURIComponent(token)}`;
  }
  renderPresence(data.present ?? []);
  return true;
}

// A person's sigil: their tincture on a shield, with their initial.
export function sigil(person, { size = "", viewer = false } = {}) {
  const span = document.createElement("span");
  span.className = ["sigil", size, viewer ? "viewer" : ""].filter(Boolean).join(" ");
  span.dataset.tincture = person.tincture;
  span.innerHTML = '<svg viewBox="0 0 26 30" aria-hidden="true"><use href="#shield"/></svg>';
  const em = document.createElement("em");
  em.textContent = initialOf(person.name);
  span.append(em);
  return span;
}

function initialOf(name) {
  const letter = [...name.trim()].find((ch) => /\p{L}/u.test(ch));
  return (letter ?? "?").toUpperCase();
}

let lastPresence = [];
// This viewer's own presence key, sent only on their own event stream.
let myPresenceKey = null;

export function renderPresence(everyone) {
  lastPresence = everyone;
  // Your own shield is already on the me-button, so leave your entry out.
  // Matched by the server's opaque key, not by name: two people may well
  // share a name and colour.
  const people = everyone.filter((p) => p.key !== myPresenceKey);
  // A rename made in another tab arrives here first: keep your own shield
  // in step with what everyone else sees.
  const mine = everyone.find((p) => p.key === myPresenceKey);
  if (mine && (mine.name !== me.name || mine.tincture !== me.tincture)) {
    me.name = mine.name;
    me.tincture = mine.tincture;
    renderMe();
  }
  els.presence.textContent = "";
  const shown = people.slice(0, 5);
  for (const person of shown) {
    const s = sigil(person, { viewer: !person.editing });
    s.title = `${person.name}${person.editing ? "" : " (watching)"}`;
    els.presence.append(s);
  }
  if (people.length > shown.length) {
    const more = document.createElement("span");
    more.className = "presence-more";
    more.textContent = `+${people.length - shown.length}`;
    more.title = people.slice(5).map((p) => p.name).join(", ");
    els.presence.append(more);
  }
  els.presence.setAttribute(
    "aria-label",
    people.length ? `Also here: ${people.map((p) => p.name).join(", ")}` : "Nobody else is here right now",
  );
}

export function wireRoomEvents(source) {
  source.addEventListener("presence:you", (event) => {
    myPresenceKey = JSON.parse(event.data).key;
    renderPresence(lastPresence);
  });
  source.addEventListener("presence", (event) => renderPresence(JSON.parse(event.data)));
  source.addEventListener("room:update", (event) => setName(JSON.parse(event.data).name));
}

async function copyField(id, button) {
  const input = $(id);
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    // Clipboard API unavailable (http, old browser): select it so the
    // person can copy it themselves.
    input.select();
    toast("Select the link and copy it (Ctrl+C, or long-press on a phone).");
    return;
  }
  const label = button.textContent;
  button.textContent = "Copied ✓";
  setTimeout(() => (button.textContent = label), 1500);
}

function relativeTime(sqliteUtc) {
  const then = new Date(`${sqliteUtc.replace(" ", "T")}Z`).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

async function refreshMyMaps() {
  const list = $("my-maps");
  const res = await fetch("/api/rooms/mine");
  const maps = res.ok ? await res.json() : [];
  list.textContent = "";
  for (const map of maps) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.className = map.token === token ? "map-link current" : "map-link";
    a.href = `/m/${map.token}`;
    const name = document.createElement("span");
    name.className = "place-name";
    name.textContent = map.name;
    const meta = document.createElement("span");
    meta.className = "map-meta";
    meta.textContent = `${map.role === "edit" ? "Can edit" : "Watching"} · ${relativeTime(map.lastSeenAt)}`;
    a.append(name, meta);
    li.append(a);
    list.append(li);
  }
  $("my-maps-empty").classList.toggle("hidden", maps.length > 0);
}

function wireForm(formId, inputId, errorId, submit) {
  const form = $(formId);
  const input = $(inputId);
  const error = $(errorId);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    error.classList.add("hidden");
    try {
      const message = await submit(input.value.trim());
      if (message) {
        error.textContent = message;
        error.classList.remove("hidden");
      }
    } catch {
      error.textContent = "Couldn't reach the server - check your connection and try again.";
      error.classList.remove("hidden");
    } finally {
      button.disabled = false;
    }
  });
}

// The Forge panel in "Start a new world": template, sliders and seed, with
// a live preview drawn by the same forge.js the server runs on Create - so
// the preview is the map you get. Loaded on first open, not with the page.
const SEED_WORDS = ["Saltmere", "Oakhollow", "Vey", "Thornwick", "Greymarch", "Ashfold", "Brindle", "Coldharbour", "Wrenfield", "Highcairn", "Morrow", "Selkie", "Duskwater", "Harrowgate", "Kestrel", "Lindqvist"];
const SLIDER_WORDS = {
  land: ["Little", "Some", "Much"],
  mountains: ["Hills", "Ranges", "Alpine"],
  forest: ["Sparse", "Woods", "Dense"],
};

function wireForge() {
  const templates = document.querySelectorAll('input[name="forge-template"]');
  const seedInput = $("forge-seed");
  const preview = $("forge-preview");
  const body = $("forge-body");
  const sliders = Object.fromEntries(Object.keys(SLIDER_WORDS).map((k) => [k, $(`forge-${k}`)]));
  let forgeModule = null;
  let pending = 0;

  const template = () => [...templates].find((r) => r.checked)?.value ?? "continent";
  const settings = () => Object.fromEntries(Object.entries(sliders).map(([k, el]) => [k, Number(el.value)]));
  const reroll = () => {
    const word = SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
    seedInput.value = `${word} ${Math.floor(Math.random() * 900 + 100)}`;
  };

  async function draw() {
    const ticket = ++pending;
    body.classList.toggle("hidden", template() === "blank");
    if (template() === "blank") return;
    forgeModule ??= await import("./forge.js");
    // Slider drags fire faster than a world generates (~100 ms); only the
    // latest request draws.
    await new Promise((r) => requestAnimationFrame(r));
    if (ticket !== pending) return;
    const world = forgeModule.forgeWorld(seedInput.value.trim() || "Atlas", template(), settings());
    const size = preview.width;
    const img = new ImageData(forgeModule.previewPixels(world, size), size, size);
    preview.getContext("2d").putImageData(img, 0, 0);
  }

  for (const [k, el] of Object.entries(sliders)) {
    const out = $(`forge-${k}-out`);
    el.addEventListener("input", () => {
      const v = Number(el.value);
      out.textContent = SLIDER_WORDS[k][v < 0.34 ? 0 : v < 0.67 ? 1 : 2];
      draw();
    });
  }
  for (const r of templates) r.addEventListener("change", draw);
  seedInput.addEventListener("input", draw);
  $("forge-reroll").addEventListener("click", () => {
    reroll();
    draw();
  });
  reroll();
  els.mapsDialog.addEventListener("toggle", () => {
    if (els.mapsDialog.open) draw();
  });

  return {
    request: () => (template() === "blank" ? undefined : { seed: seedInput.value.trim() || "Atlas", template: template(), settings: settings() }),
  };
}

export const me = { name: "", tincture: "argent" };
let tinctureList = [];

function renderMe() {
  $("me-name").textContent = me.name;
  $("me-initial").textContent = initialOf(me.name);
  document.querySelector("#me-button .sigil").dataset.tincture = me.tincture;
  $("me-button").title = `You appear as ${me.name}. Change your name or colour.`;
}

function renderMePreview(name, tincture) {
  $("me-preview-name").textContent = name || "…";
  $("me-preview-initial").textContent = initialOf(name || "?");
  $("me-preview-sigil").dataset.tincture = tincture;
}

export async function loadMe() {
  const res = await fetch("/api/me");
  if (!res.ok) return;
  const data = await res.json();
  me.name = data.name;
  me.tincture = data.tincture;
  tinctureList = data.tinctures;
  renderMe();
  buildTinctureOptions();
  if (data.isNew) toast(`Welcome. You'll appear to others as ${me.name}. Tap your shield to change it.`);
}

const TINCTURE_LABEL = {
  gules: "Red", azure: "Blue", vert: "Green", or: "Gold",
  purpure: "Purple", argent: "Silver", tenne: "Orange", celeste: "Sky",
};

function buildTinctureOptions() {
  const box = $("tincture-options");
  box.textContent = "";
  for (const t of tinctureList) {
    const label = document.createElement("label");
    label.title = TINCTURE_LABEL[t] ?? t;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "tincture";
    input.value = t;
    input.setAttribute("aria-label", TINCTURE_LABEL[t] ?? t);
    const dot = document.createElement("span");
    dot.className = "swatch-dot";
    dot.style.background = `var(--t-${t})`;
    label.append(input, dot);
    box.append(label);
  }
}

function openMeDialog() {
  $("me-name-input").value = me.name;
  const checked = document.querySelector(`#tincture-options input[value="${me.tincture}"]`);
  if (checked) checked.checked = true;
  renderMePreview(me.name, me.tincture);
  $("me-error").classList.add("hidden");
  $("me-dialog").showModal();
}

function selectedTincture() {
  return document.querySelector("#tincture-options input:checked")?.value ?? me.tincture;
}

export function wireRoomUi() {
  $("me-button").addEventListener("click", openMeDialog);
  $("me-name-input").addEventListener("input", () => renderMePreview($("me-name-input").value.trim(), selectedTincture()));
  $("tincture-options").addEventListener("change", () => renderMePreview($("me-name-input").value.trim(), selectedTincture()));
  $("me-suggest").addEventListener("click", async () => {
    const res = await fetch("/api/me/suggestion");
    if (!res.ok) return;
    const { name } = await res.json();
    $("me-name-input").value = name;
    renderMePreview(name, selectedTincture());
  });
  $("me-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = $("me-error");
    error.classList.add("hidden");
    try {
      const res = await fetch("/api/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: $("me-name-input").value.trim(), tincture: selectedTincture() }),
      });
      const body = await res.json();
      if (!res.ok) {
        error.textContent = body.error ?? "Couldn't save your name.";
        error.classList.remove("hidden");
        return;
      }
      me.name = body.name;
      me.tincture = body.tincture;
      renderMe();
      $("me-dialog").close();
      toast(`Others now see you as ${me.name}.`);
    } catch {
      error.textContent = "Couldn't reach the server. Check your connection and try again.";
      error.classList.remove("hidden");
    }
  });

  els.share.addEventListener("click", () => els.shareDialog.showModal());
  wireGalleryToggle();
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", () => copyField(button.dataset.copy, button));
  }

  $("maps-button").addEventListener("click", () => {
    els.mapsDialog.showModal();
    refreshMyMaps();
  });

  const forge = wireForge();
  wireForm("new-map-form", "new-map-name", "new-map-error", async (name) => {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, forge: forge.request() }),
    });
    const body = await res.json();
    if (!res.ok) return body.error ?? "Couldn't create the map.";
    // Open the share sheet on arrival: a new map's first job is usually
    // inviting someone.
    location.href = `/m/${body.editToken}#share`;
    return null;
  });

  els.rename.addEventListener("click", () => {
    $("rename-input").value = room.name;
    els.renameDialog.showModal();
    $("rename-input").select();
  });
  wireForm("rename-form", "rename-input", "rename-error", async (name) => {
    const res = await fetch(apiPath("/api/room/name"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return (await res.json()).error ?? "Couldn't rename the map.";
    setName(name);
    els.renameDialog.close();
    return null;
  });

  // Clicking the dimmed backdrop closes a sheet, as people expect.
  for (const dialog of [els.shareDialog, els.mapsDialog, els.renameDialog, $("me-dialog")]) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
}

// "Show in the gallery": only in the share sheet, which only edit-link
// holders see. The server re-checks the role and the land rule.
function wireGalleryToggle() {
  const box = $("share-gallery");
  const error = $("share-gallery-error");
  box.addEventListener("change", async () => {
    const wanted = box.checked;
    box.disabled = true;
    error.classList.add("hidden");
    try {
      const res = await fetch(apiPath("/api/room/listing"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listed: wanted }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Couldn't change the gallery setting.");
      box.checked = body.listed;
      toast(body.listed ? `${room.name} is in the gallery on the Atlas home.` : `${room.name} is out of the gallery.`);
    } catch (err) {
      box.checked = !wanted;
      error.textContent = err instanceof Error ? err.message : "Couldn't reach the server. Check your connection and try again.";
      error.classList.remove("hidden");
    } finally {
      box.disabled = false;
    }
  });
}

export function openShareIfRequested() {
  if (location.hash === "#share" && !els.share.classList.contains("hidden")) {
    history.replaceState(null, "", location.pathname);
    els.shareDialog.showModal();
    // #share only arrives from creating a map: once the sheet is closed,
    // say what to do first (stage A's first-time hint).
    els.shareDialog.addEventListener(
      "close",
      () => toast(matchMedia("(pointer: coarse)").matches ? "Your world is ready. Pick Raise or Lower and drag on the land to shape it." : "Your world is ready. Pick Raise or Lower, then drag on the land to shape it. Scroll to zoom."),
      { once: true },
    );
  }
}
