// Versions, restore, export and copy (Atlas Table stage B). The server
// checks every rule (src/versions.ts); this only reflects them: edit links
// see Save and Restore, everyone sees the list, the downloads and Copy.
import { apiPath, room, toast } from "./room-ui.js";

const $ = (id) => document.getElementById(id);

function relativeTime(sqliteUtc) {
  const then = new Date(`${sqliteUtc.replace(" ", "T")}Z`).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// The page's own confirm step: native confirm() is too easy to click
// through for something that replaces the whole map.
function confirmStep(title, body, ok) {
  const dialog = $("confirm-dialog");
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = body;
  $("confirm-ok").textContent = ok;
  return new Promise((resolve) => {
    const done = (value) => {
      dialog.close();
      $("confirm-ok").removeEventListener("click", yes);
      $("confirm-cancel").removeEventListener("click", no);
      dialog.removeEventListener("close", no);
      resolve(value);
    };
    const yes = () => done(true);
    const no = () => done(false);
    $("confirm-ok").addEventListener("click", yes);
    $("confirm-cancel").addEventListener("click", no);
    dialog.addEventListener("close", no, { once: true });
    dialog.showModal();
  });
}

function showError(message) {
  const el = $("history-error");
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

async function post(path, body) {
  const res = await fetch(apiPath(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "That didn't work. Try again.");
  return data;
}

function versionRow(v) {
  const li = document.createElement("li");
  li.className = `version-row ${v.kind}`;
  const text = document.createElement("div");
  const name = document.createElement("span");
  name.className = "version-name";
  name.textContent = v.name;
  const meta = document.createElement("span");
  meta.className = "version-meta";
  meta.textContent = `${v.kind === "checkpoint" ? "Automatic · " : ""}${relativeTime(v.createdAt)} · ${v.cells.toLocaleString()} cells`;
  text.append(name, meta);
  const actions = document.createElement("div");
  actions.className = "version-actions";
  const copy = Object.assign(document.createElement("button"), { type: "button", className: "ghost-button", textContent: "Copy" });
  copy.title = "Start a new world from this version";
  copy.addEventListener("click", () => copyToNewWorld(v));
  actions.append(copy);
  if (room.canEdit) {
    const restore = Object.assign(document.createElement("button"), { type: "button", className: "ghost-button", textContent: "Restore" });
    restore.addEventListener("click", () => restoreVersion(v));
    const del = Object.assign(document.createElement("button"), { type: "button", className: "icon-button", textContent: "×" });
    del.setAttribute("aria-label", `Delete version ${v.name}`);
    del.title = "Delete this version";
    del.addEventListener("click", () => deleteVersion(v));
    actions.append(restore, del);
  }
  li.append(text, actions);
  return li;
}

async function refresh() {
  if (room.isPublic) return;
  const res = await fetch(apiPath("/api/room/versions")).catch(() => null);
  const list = res?.ok ? await res.json() : [];
  const ul = $("version-list");
  ul.replaceChildren(...list.map(versionRow));
  $("version-empty").classList.toggle("hidden", list.length > 0);
}

async function restoreVersion(v) {
  const ok = await confirmStep(
    `Restore "${v.name}"?`,
    "The map changes for everyone who has it open. The map as it is now is saved first as an automatic version, so you can switch back.",
    "Restore",
  );
  if (!ok) return;
  try {
    showError("");
    await post("/api/room/versions/restore", { id: v.id });
    toast(`Restored "${v.name}". The previous state is saved in History.`);
  } catch (err) {
    showError(err.message);
  }
}

async function deleteVersion(v) {
  const ok = await confirmStep(`Delete "${v.name}"?`, "This version will be gone for everyone. The map itself is not changed.", "Delete");
  if (!ok) return;
  try {
    showError("");
    await post("/api/room/versions/delete", { id: v.id });
  } catch (err) {
    showError(err.message);
  }
}

// Copy: a new private world, yours, starting from this map (or a version).
async function copyToNewWorld(v) {
  const token = location.pathname.split("/")[2];
  try {
    showError("");
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `${room.name} (copy)`.slice(0, 60), copyFrom: token, ...(v ? { version: v.id } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Couldn't make the copy.");
    location.href = `/m/${body.editToken}#share`;
  } catch (err) {
    showError(err.message);
  }
}

async function importFile(file) {
  const error = $("new-map-error");
  error.classList.add("hidden");
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error("That file is too big to be an Atlas Table map.");
    const data = JSON.parse(await file.text());
    const name = (typeof data.name === "string" && data.name.trim()) || file.name.replace(/\.atlas\.json$|\.json$/i, "") || "Imported world";
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.slice(0, 60), import: data }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Couldn't open that file.");
    location.href = `/m/${body.editToken}#share`;
  } catch (err) {
    error.textContent = err instanceof SyntaxError ? "That file isn't valid JSON." : err.message;
    error.classList.remove("hidden");
  }
}

function open() {
  for (const d of [$("share-dialog"), $("maps-dialog")]) if (d.open) d.close();
  $("history-map-name").textContent = room.name;
  $("export-png").href = apiPath("/api/room/thumbnail.png") + "?size=full";
  $("export-png").download = `${room.name}.png`;
  $("export-json").href = apiPath("/api/room/export.json");
  showError("");
  $("history-dialog").showModal();
  refresh();
}

export function wireHistory() {
  $("open-history").addEventListener("click", open);
  $("open-history-maps").addEventListener("click", open);
  $("copy-map").addEventListener("click", () => copyToNewWorld(null));
  $("import-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) importFile(file);
    e.target.value = "";
  });
  $("save-version-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("version-name");
    try {
      showError("");
      await post("/api/room/versions", { name: input.value });
      input.value = "";
      toast("Saved. Anyone with the edit link can restore it.");
    } catch (err) {
      showError(err.message);
    }
  });
  $("history-dialog").addEventListener("click", (event) => {
    if (event.target === $("history-dialog")) $("history-dialog").close();
  });
}

// After loadRoom: the Maps-sheet entry exists only for private maps.
export function showHistoryEntry() {
  $("open-history-maps").classList.toggle("hidden", room.isPublic);
}

export function wireHistoryEvents(source, reloadTerrain) {
  source.addEventListener("versions:update", () => {
    if ($("history-dialog").open) refresh();
  });
  source.addEventListener("terrain:reload", () => reloadTerrain());
}
