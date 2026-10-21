import { displayNameFor } from "./identity.ts";
import { broadcast } from "./realtime.ts";

// Who has a room open right now, derived from its open event streams - no
// new transport, no writes. A session with several tabs counts once, as an
// editor if any of its tabs can edit. Display names only: raw session ids
// never leave the server (ADR 2).
interface Tabs {
  edit: number;
  view: number;
}
const present = new Map<string, Map<string, Tabs>>();

function snapshot(roomId: string): { name: string; editing: boolean }[] {
  const sessions = present.get(roomId);
  if (!sessions) return [];
  return [...sessions.entries()]
    .map(([sessionId, tabs]) => ({ name: displayNameFor(sessionId), editing: tabs.edit > 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function join(roomId: string, sessionId: string, role: "edit" | "view"): () => void {
  let sessions = present.get(roomId);
  if (!sessions) present.set(roomId, (sessions = new Map()));
  const tabs = sessions.get(sessionId) ?? { edit: 0, view: 0 };
  tabs[role]++;
  sessions.set(sessionId, tabs);
  broadcast(roomId, "presence", snapshot(roomId));
  return () => {
    tabs[role]--;
    if (tabs.edit + tabs.view === 0) sessions.delete(sessionId);
    if (sessions.size === 0) present.delete(roomId);
    broadcast(roomId, "presence", snapshot(roomId));
  };
}

export function presenceFor(roomId: string) {
  return snapshot(roomId);
}
