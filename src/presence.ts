import { randomBytes } from "node:crypto";
import { ensurePerson, personFor } from "./people.ts";
import { broadcast } from "./realtime.ts";

// Who has a room open right now, derived from its open event streams - no
// new transport, no writes. A session with several tabs counts once, as an
// editor if any of its tabs can edit. Raw session ids never leave the
// server (ADR 2): each entry carries an opaque key, random per session per
// room, so a client can recognise its own entry (sent to it alone, on its
// own stream) without names having to be unique.
interface Tabs {
  edit: number;
  view: number;
  key: string;
}
const present = new Map<string, Map<string, Tabs>>();

export interface PresenceEntry {
  key: string;
  name: string;
  tincture: string;
  editing: boolean;
}

function snapshot(roomId: string): PresenceEntry[] {
  const sessions = present.get(roomId);
  if (!sessions) return [];
  return [...sessions.entries()]
    .map(([sessionId, tabs]) => ({ key: tabs.key, ...personFor(sessionId), editing: tabs.edit > 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// A rename or recolour shows up in every room this session has open.
export function refreshPresenceFor(sessionId: string): void {
  for (const [roomId, sessions] of present) {
    if (sessions.has(sessionId)) broadcast(roomId, "presence", snapshot(roomId));
  }
}

// Rooms this session has open right now.
export function roomsOpenBy(sessionId: string): string[] {
  return [...present].filter(([, sessions]) => sessions.has(sessionId)).map(([roomId]) => roomId);
}

// Returns this session's presence key in the room, and a leave function.
// The person row is created here if needed, so the name others see on
// arrival is the real one, not a fallback that changes a moment later.
export function join(roomId: string, sessionId: string, role: "edit" | "view"): { key: string; leave: () => void } {
  ensurePerson(sessionId);
  let sessions = present.get(roomId);
  if (!sessions) present.set(roomId, (sessions = new Map()));
  const tabs = sessions.get(sessionId) ?? { edit: 0, view: 0, key: randomBytes(9).toString("base64url") };
  tabs[role]++;
  sessions.set(sessionId, tabs);
  broadcast(roomId, "presence", snapshot(roomId));
  const leave = () => {
    tabs[role]--;
    if (tabs.edit + tabs.view === 0) sessions.delete(sessionId);
    if (sessions.size === 0) present.delete(roomId);
    broadcast(roomId, "presence", snapshot(roomId));
  };
  return { key: tabs.key, leave };
}

export function keyFor(roomId: string, sessionId: string): string | null {
  return present.get(roomId)?.get(sessionId)?.key ?? null;
}

export function presenceFor(roomId: string) {
  return snapshot(roomId);
}
