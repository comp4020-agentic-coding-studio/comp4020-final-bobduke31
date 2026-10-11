import type { ServerResponse } from "node:http";

// One in-memory topic for the whole process. Correct for exactly one Fly
// machine (the course's own fixed deployment shape): a broadcast reaches
// every subscriber on this machine, and there's only ever one.
const subscribers = new Set<ServerResponse>();

// Keeps Fly's proxy from treating a quiet connection as dead. SSE comment
// lines (":...") are ignored by EventSource, so this never reaches
// onmessage.
const PING_INTERVAL_MS = 20_000;
let pingTimer: NodeJS.Timeout | undefined;

function ensurePing(): void {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const res of subscribers) res.write(": ping\n\n");
  }, PING_INTERVAL_MS);
  pingTimer.unref();
}

export function subscribe(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  subscribers.add(res);
  ensurePing();
  res.on("close", () => subscribers.delete(res));
}

// Every event carries a type, so a reconnecting client's first GET (the
// real source of truth) and this live stream never need to agree on
// ordering or replay - the client re-fetches full state on every
// (re)connect instead of trusting the stream to have missed nothing.
export function broadcast(type: string, data: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) res.write(frame);
}
