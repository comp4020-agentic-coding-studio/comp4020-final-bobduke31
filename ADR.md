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
