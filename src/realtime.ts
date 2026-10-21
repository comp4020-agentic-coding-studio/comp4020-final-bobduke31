import type { ServerResponse } from "node:http";

// One in-memory topic per room, plus a global one for the activity log
// viewer. Correct for exactly one Fly machine (the course's own fixed
// deployment shape): a broadcast reaches every subscriber on this machine,
// and there's only ever one.
const topics = new Map<string, Set<ServerResponse>>();

// A bounded number of open streams: each costs a socket and a little
// memory on a 256 MB machine. Far above a class-sized crowd.
export const MAX_SUBSCRIBERS = 400;
let subscriberCount = 0;

// Keeps Fly's proxy from treating a quiet connection as dead. SSE comment
// lines (":...") are ignored by EventSource, so this never reaches
// onmessage.
const PING_INTERVAL_MS = 20_000;
let pingTimer: NodeJS.Timeout | undefined;

function ensurePing(): void {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const set of topics.values()) for (const res of set) res.write(": ping\n\n");
  }, PING_INTERVAL_MS);
  pingTimer.unref();
}

export function subscribe(topic: string, res: ServerResponse, onClose?: () => void): boolean {
  if (subscriberCount >= MAX_SUBSCRIBERS) return false;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  let set = topics.get(topic);
  if (!set) topics.set(topic, (set = new Set()));
  set.add(res);
  subscriberCount++;
  ensurePing();
  res.on("close", () => {
    set.delete(res);
    subscriberCount--;
    if (set.size === 0) topics.delete(topic);
    onClose?.();
  });
  return true;
}

// Every event carries a type, so a reconnecting client's first GET (the
// real source of truth) and this live stream never need to agree on
// ordering or replay - the client re-fetches full state on every
// (re)connect instead of trusting the stream to have missed nothing.
export function broadcast(topic: string, type: string, data: unknown): void {
  const set = topics.get(topic);
  if (!set) return;
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(frame);
}
