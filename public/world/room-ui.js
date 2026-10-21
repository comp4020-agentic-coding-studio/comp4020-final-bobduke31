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
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

function setName(name) {
  room.name = name;
  els.name.textContent = name;
  els.name.title = name;
  document.title = `${name} — Shared terrain`;
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
  if (!room.canEdit) {
    $("category-hint").textContent = "You're viewing this map: every change anyone makes appears here live. Ask for the edit link to make changes yourself.";
    $("camera-hint").textContent = "Mouse wheel or the Zoom slider zooms; drag the map (or the pad) to pan.";
  }
  els.badge.classList.toggle("hidden", room.canEdit);
  els.rename.classList.toggle("hidden", !room.canEdit || room.isPublic);
  els.share.classList.toggle("hidden", room.isPublic || !data.editToken);
  if (data.editToken) {
    $("share-edit").value = linkFor(data.editToken);
    $("share-view").value = linkFor(data.viewToken);
  }
  if (token) $("activity-link").classList.add("hidden");
  renderPresence(data.present ?? []);
  return true;
}

// Stable colour per display name, from a small palette that reads on the
// dark chrome.
const CHIP_COLOURS = ["#e5a86b", "#8fc98a", "#8fc3e8", "#d9a0d6", "#e6d278", "#f19a8e", "#7fd1c2", "#b8a6f0"];
function colourFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CHIP_COLOURS[h % CHIP_COLOURS.length];
}

export function renderPresence(people) {
  els.presence.textContent = "";
  const shown = people.slice(0, 5);
  for (const person of shown) {
    const chip = document.createElement("span");
    chip.className = person.editing ? "presence-chip" : "presence-chip viewer";
    chip.style.background = colourFor(person.name);
    chip.textContent = person.name.split(" ").slice(0, 2).map((w) => w[0]).join("");
    chip.title = `${person.name}${person.editing ? "" : " (viewing)"}`;
    els.presence.append(chip);
  }
  if (people.length > shown.length) {
    const more = document.createElement("span");
    more.className = "presence-chip more";
    more.textContent = `+${people.length - shown.length}`;
    more.title = people.slice(5).map((p) => p.name).join(", ");
    els.presence.append(more);
  }
  els.presence.setAttribute("aria-label", `${people.length} ${people.length === 1 ? "person" : "people"} here`);
}

export function wireRoomEvents(source) {
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
    toast("Press Ctrl+C (or long-press) to copy");
    return;
  }
  const label = button.textContent;
  button.textContent = "Copied";
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
    name.textContent = map.name;
    const meta = document.createElement("span");
    meta.className = "map-meta";
    meta.textContent = `${map.role === "edit" ? "Can edit" : "View only"} · ${relativeTime(map.lastSeenAt)}`;
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

export function wireRoomUi() {
  els.share.addEventListener("click", () => els.shareDialog.showModal());
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", () => copyField(button.dataset.copy, button));
  }

  $("maps-button").addEventListener("click", () => {
    els.mapsDialog.showModal();
    refreshMyMaps();
  });

  wireForm("new-map-form", "new-map-name", "new-map-error", async (name) => {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
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
  for (const dialog of [els.shareDialog, els.mapsDialog, els.renameDialog]) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
}

export function openShareIfRequested() {
  if (location.hash === "#share" && !els.share.classList.contains("hidden")) {
    history.replaceState(null, "", location.pathname);
    els.shareDialog.showModal();
  }
}
