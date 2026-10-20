import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";

const COOKIE_NAME = "isle_session";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // malformed %-escape: ignore the cookie rather than 500 the request
    }
  }
  return cookies;
}

export interface SessionResult {
  sessionId: string;
  setCookieHeader?: string;
}

// Anonymous per-visitor id, not a login: lets us tag who left which mark now,
// and gives the final project's "distinguish users" requirement a hook later.
export function resolveSession(req: IncomingMessage): SessionResult {
  const cookies = parseCookies(req.headers.cookie);
  const existing = cookies[COOKIE_NAME];
  // Only accept ids this server could have minted, so arbitrary cookie
  // strings can't be used to grow per-session state without bound.
  if (existing && UUID_RE.test(existing)) return { sessionId: existing };

  const sessionId = randomUUID();
  const oneYear = 60 * 60 * 24 * 365;
  const setCookieHeader = `${COOKIE_NAME}=${sessionId}; Max-Age=${oneYear}; Path=/; HttpOnly; SameSite=Lax; Secure`;
  return { sessionId, setCookieHeader };
}
