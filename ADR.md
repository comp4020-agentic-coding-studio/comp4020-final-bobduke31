# ADR 1: concurrent terrain edits

## Context

C9 requires deciding, and writing down, what happens when several people
use the app at once. The first real-time feature is shared terrain
painting: a 128×128 grid of elevation cells, painted with a brush, visible
to everyone within about a second.

## Decision

Terrain cells are **shared and ownerless**. Anyone can raise or lower any
cell, with no claim, lock, or per-cell permission. A write is
**server-authoritative**: the server applies updates in the order it
receives them (`INSERT ... ON CONFLICT DO UPDATE` per cell in
`src/terrain.ts`), and that's simply what the cell is now. The server
never merges two people's values for the same cell — the later write wins
outright.

On load, and on every reconnect, a client fetches the full current state
(`GET /api/terrain`) before trusting the live stream (`GET /api/events`,
Server-Sent Events). There's no event replay or sequence numbers: a missed
event just means the next full fetch picks up the correct end state anyway.

## Alternatives considered

- **A CRDT** (Yjs/Automerge-style merge). Solves conflicting edits made
  offline or out of order across replicas. This app has one always-on
  server and no offline editing, so there's no divergent state to
  reconcile — a CRDT would add real complexity for a problem this app
  doesn't have.
- **Per-cell locking or claims** (e.g. "someone else is painting here").
  Gives clearer feedback during a collision, but adds real machinery
  (what happens to a lock when a tab closes mid-stroke?) for a brush tool
  where an overwritten cell is low-stakes and immediately repaintable. A
  visible "who's painting where" presence indicator is a reasonable later
  addition, not required for this first pass.

## Cost

Two people painting the same spot at the same moment can clobber each
other with no warning — one stroke silently wins. This is acceptable for a
shared, ownerless canvas where nothing is destroyed permanently (it can
always be repainted), but it is a real, named limitation, not a hidden one.

# ADR 2: C10 permissions and activity logging

## Context

C10 requires a real, server-checked permission boundary between users —
"what each person may see and change is checked on the server, and that
decision is written down in the repo with why" — plus a persistent
server-side activity log distinguishing who did what.

Identity in this app has always been lightweight: an anonymous session
cookie (`src/session.ts`), not an account. C10 doesn't require accounts —
"what counts as a person is your call" — so this ADR keeps that identity
model rather than adding login, and asks a narrower question: given
session-based identity, what permission boundary is both genuinely useful
and genuinely checkable server-side?

## Decision

Two things, kept deliberately separate:

**1. Terrain cells stay shared and ownerless (ADR 1 unchanged).** C10 does
not ask every feature to gain per-user restriction — it asks for *a*
server-checked permission that's real and documented. Revisiting ADR 1's
"anyone may paint any cell" to add per-cell ownership would be a much
larger change (a schema migration, a new conflict model) solving a problem
C9's own crit didn't flag, and would contradict ADR 1's own reasoning
without new evidence that reasoning was wrong. That decision stands.

**2. A new permission *is* added: undo is strictly per-session.**
`POST /api/terrain/undo` restores whatever the *requesting session* last
painted, and only that. The check isn't an `if (ownerId === requesterId)`
a future edit could accidentally remove — there is no code path from an
incoming request to any other session's data at all. The server keeps an
in-memory `Map<sessionId, snapshot>` (`src/undo.ts`) keyed by the id read
from the request's own cookie; a request simply has no field that could
name a different session's entry. This is the shape of permission check
C10 is actually asking for demonstrated live: two pod members, two
sessions, one can never affect the other's undo state, and the log shows
it.

Existing per-session checks (marks: `deleteMarkOwnedBy`, already
server-side and already covered by `spec/marks.test.ts`'s "refuses to let
one visitor remove another visitor's mark") are the same pattern — this
ADR just gives the pattern a name and extends it to terrain.

**3. A persistent activity log** (`activity_log` table, `src/activity.ts`)
records every terrain paint, terrain undo, terrain-type paint, mark
creation, and mark deletion (including *denied* ones — a 403 is logged as
"DENIED", not silently dropped), each tagged with the acting session id.
It lives in the same SQLite file as every other table, on the one volume
that survives a restart or redeploy (`fly.toml`) — it outlives the crit, as
required, not just the demo session. Every entry is also printed to
stdout, so `mise exec -- flyctl logs -a <repo>` tailed live — the crit's
own prescribed demo method — shows the same information without needing
the app's own UI at all. The in-app `/logs/` viewer (SSE-fed from the same
broadcast channel terrain updates already use) is this app's *own* tool for
reading that log later, matching the brief's stated purpose: "what you and
your agent read when the deployed app misbehaves," not a feature built only
to pass a crit.

A session is shown as a short, deterministic display name
(`src/identity.ts`, e.g. "Lone Finch #9f2"), derived from the session id by
a plain hash — not reversible to anything secret, same privacy posture as
`toClientMark`'s existing "never hand another visitor's raw session id to a
client." The raw session id is still logged server-side (visible to
whoever can read the DB or process logs, i.e. the developer), which is what
`flyctl logs` narration and DB inspection actually need — the display name
is for the in-app viewer and for a presenter reading entries aloud.

## Alternatives considered

- **Per-cell terrain ownership** (only the painter, or an assigned role,
  may edit a given cell). Rejected for the reason in Decision §1: C9's own
  design question already answered this for terrain specifically, nothing
  since has shown that answer wrong, and reopening it risks exactly the
  "two separately-maintained conflict models" trap this repo's own
  commenting style warns against elsewhere.
- **Role-based access (e.g. "editor" vs "viewer") via a shared invite
  link.** A reasonable direction for ROADMAP.md's "group-based
  collaboration" (final-project scope), but adding real roles needs a
  decision about who assigns them that has no natural answer yet without
  accounts — premature for C10's one-week scope, and not what the brief
  asks for ("what counts as a permission is your call," not "you must add
  roles").
- **No new permission at all, just the log.** Considered and rejected: the
  brief's two requirements are linked ("what each may see and change ...
  checked on the server" *and* "logs who did what") — a log with nothing
  for it to usefully report on a 403 would satisfy the letter of "logging"
  while missing the point of why the course wants it demonstrated live.

## Cost

Undo is one level deep and in-memory, not a version history — a server
restart (or a second stroke before undoing the first) loses the ability to
undo an earlier stroke. This is a real, named limitation, not a persisted
feature: ROADMAP.md task 10 (map version history) is the actual, durable
answer to "I want to go back further," tracked separately as final-project
scope, not conflated with this narrower, demo-week permission feature.

# ADR 3: rooms, share links and roles (draft, 2026-10-21)

*Draft written in phase 0 of the platform plan (ROADMAP.md, "Platform:
create, edit together, save, reload, share"). Not implemented yet.*

## Context

The app has one shared world. The Final plan adds separate maps, which
people create, edit together, save, reload and share. That needs an answer
to: who may see or change which map, without accounts?

## Decision

- **A room is one map.** Terrain rows gain a `room_id`, and every query,
  SSE topic, undo snapshot and activity entry is scoped to one room. ADR 1's
  model (ownerless cells, last write wins) is unchanged *inside* a room.
- **The existing world becomes the room `public`**, and stays editable by
  anyone at `/`. The unprefixed `/api/terrain*` routes keep serving it.
- **Every other room has two unguessable links**: an edit link and a
  view-only link (128-bit random tokens). The token in the URL is the
  credential. The server resolves it to a room plus a role on every
  request. A write with a view token gets 403 and is logged as `DENIED`.
  This is ADR 2's pattern again: the decision is made from what the server
  resolved, not from anything the client claims.
- **No accounts.** People are the existing anonymous session cookie, shown
  by display name. "My maps" lists rooms by session on this browser. On
  another device, the link itself is the way back.

## Alternatives considered

- **Accounts.** They give cross-device lists and revocable access, at the
  cost of password storage, resets and account takeover, none of which the
  brief requires. Links are the standard for casual real-time tools
  (Excalidraw, tldraw).
- **One link with a password for editing.** A password is a second secret
  to share and forget, and it adds nothing the two-link split doesn't.
- **Owner-only editing, others view.** This contradicts the "edit together"
  goal.

## Cost

- Links can't be revoked. A leaked edit link means anyone holding it can
  edit until the room is forked. Token rotation is a possible later
  addition.
- Losing the edit link means losing edit access, unless "My maps" on the
  same browser still has it.
- Tokens in URLs can leak through history and screenshots.
  `Referrer-Policy: no-referrer` stops them leaking to other sites through
  the Referer header.

## Migration (dry run done, phase 0)

`scripts/migrate-rooms.ts` rebuilds the terrain tables with
`(room_id, x, y)` keys in one transaction, with content-hash validation.
Today's code crashes on startup against a migrated database (its
`ON CONFLICT (x, y)` no longer matches a key), so the migration must run
inside the new code at boot, never ahead of the deploy that understands it.
