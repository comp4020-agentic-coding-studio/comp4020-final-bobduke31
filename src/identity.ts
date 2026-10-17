// A short, human-legible, stable label for a session id - purely a function
// of the id (no storage, no new table), so every server module that wants to
// show "who did this" (the activity log, its log viewer) gets the same label
// for the same visitor without a lookup. Never derived from or reversible to
// anything secret: it's a deterministic hash of the already-public-to-the-
// visitor-themselves session id, same privacy posture as toClientMark's
// "never hand another visitor's raw session id to a client" in server.ts.
const ADJECTIVES = [
  "Quiet",
  "Swift",
  "Bold",
  "Calm",
  "Keen",
  "Lone",
  "Wry",
  "Deft",
  "Grey",
  "Pale",
  "Stern",
  "Mild",
  "Brave",
  "Sly",
  "Sharp",
  "Faint",
] as const;

const NOUNS = [
  "Heron",
  "Falcon",
  "Otter",
  "Lynx",
  "Raven",
  "Badger",
  "Wren",
  "Fox",
  "Hare",
  "Owl",
  "Stag",
  "Mole",
  "Crane",
  "Wolf",
  "Finch",
  "Newt",
] as const;

// FNV-1a: small, fast, good-enough avalanche for a cosmetic label - not a
// security boundary, just enough spread that adjacent UUIDs don't collide
// into the same name.
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A 3-character suffix (from the session id itself, not the hash) so two
// visitors who land on the same adjective+noun pair are still told apart at
// a glance in the log - this is cosmetic disambiguation, not the actual
// permission check (which is keyed on the full session id server-side).
export function displayNameFor(sessionId: string): string {
  const h = hash32(sessionId);
  const adjective = ADJECTIVES[h % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length];
  const suffix = sessionId.replace(/-/g, "").slice(0, 3);
  return `${adjective} ${noun} #${suffix}`;
}
