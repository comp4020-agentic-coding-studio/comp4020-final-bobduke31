const rows = document.getElementById("log-rows");

// A private map's log is opened as /logs/#map=<token>, from inside that map.
// The token stays in the fragment, so it isn't sent in the page request,
// and the same token gives the same access it does in the editor.
const token = new URLSearchParams(location.hash.slice(1)).get("map");
const api = (path) => (token ? `/api/r/${encodeURIComponent(token)}${path.slice(4)}` : path);
const emptyState = document.getElementById("empty-state");

function formatTime(isoLike) {
  // created_at is SQLite's datetime('now') - UTC, space-separated, no "Z".
  // Append it so `new Date` parses as UTC instead of (incorrectly) local time.
  const date = new Date(`${isoLike.replace(" ", "T")}Z`);
  return date.toLocaleTimeString(undefined, { hour12: false });
}

function renderRow(entry, { fresh = false } = {}) {
  const tr = document.createElement("tr");
  if (fresh) tr.className = "fresh";

  const time = document.createElement("td");
  time.className = "timestamp";
  time.textContent = formatTime(entry.createdAt);

  const visitor = document.createElement("td");
  visitor.className = "visitor";
  visitor.textContent = entry.displayName;

  const action = document.createElement("td");
  const badge = document.createElement("span");
  const denied = entry.detail.startsWith("DENIED");
  badge.className = denied ? "action-badge denied" : "action-badge";
  badge.textContent = entry.action;
  action.appendChild(badge);

  const detail = document.createElement("td");
  detail.textContent = entry.detail;

  tr.append(time, visitor, action, detail);
  return tr;
}

function updateEmptyState() {
  emptyState.classList.toggle("hidden", rows.children.length > 0);
}

async function loadRecent() {
  const res = await fetch(api("/api/activity"));
  if (!res.ok) {
    rows.textContent = "";
    emptyState.textContent = "No map at this link. Open the activity log from inside the map instead.";
    updateEmptyState();
    return;
  }
  const entries = await res.json();
  rows.textContent = "";
  // The API returns newest-first; keep that order here too, so the most
  // recent action is always the first row a presenter's eye lands on.
  for (const entry of entries) rows.appendChild(renderRow(entry));
  updateEmptyState();
}

function connectLive() {
  const source = new EventSource(api("/api/events?watch=log"));
  source.addEventListener("activity:new", (event) => {
    const entry = JSON.parse(event.data);
    rows.insertBefore(renderRow(entry, { fresh: true }), rows.firstChild);
    updateEmptyState();
  });
  // Same reconnect-means-refetch discipline as world-client.js's
  // connectEvents: a dropped connection could miss entries, and the next
  // "open" is exactly when to recover the authoritative recent list.
  source.addEventListener("open", loadRecent);
}

async function showMapName() {
  if (!token) return;
  const res = await fetch(api("/api/room"));
  if (!res.ok) return;
  const { name } = await res.json();
  document.getElementById("log-title").textContent = `Activity: ${name}`;
  document.getElementById("log-intro").textContent =
    "Every edit and undo on this map, with who did it. New entries appear live. Only people with this map's link can see it.";
  const back = document.getElementById("back-link");
  back.href = `/m/${encodeURIComponent(token)}`;
  back.textContent = `Back to ${name}`;
  document.title = `Activity: ${name}`;
}

showMapName();
loadRecent();
connectLive();
