# Shared terrain

A real-time, multiplayer fantasy map: anyone who opens it paints shared
terrain — raise mountains, carve coastlines, plant forests — and sees
everyone else's changes arrive live, with no reload. There's no login; an
anonymous session distinguishes one visitor from another, and the server
checks who did what before it acts.

This started as **The Isle** (Crit 8): a fictional island where visitors
dropped fixed marks. That app still runs, unchanged, at [`/isle/`](/isle/)
— it isn't deleted, just no longer the homepage, now that the project's
actual direction (a real-time, multiplayer map editor, not marks on a
static image) has a working prototype of its own.

## The core interaction

1. Open the map.
2. Pick a tool — Raise, Lower, Mountain, Forest, and more line the toolbar.
3. Drag on the map. The stroke appears instantly for you, and within about a
   second for everyone else who has the page open.
4. Made a mistake? **Undo my last stroke** reverts your own most recent
   edit — never anyone else's, even if someone paints over the same spot
   right after you.
5. Switch between a flat Top-down view (precise editing) and a 3D Oblique
   view (a real lit, shaded heightfield) at any time — both stay in sync
   with the same shared data.

Everything anyone paints is saved to the server immediately; reload, or
come back tomorrow, and it's still there.

## Multi-user, checked on the server

Two people, each in their own browser with no shared cookies, act on the
same map and are told apart. What's shared and what's per-person is a
deliberate choice, not an accident:

- **Terrain itself stays a shared, ownerless canvas.** Anyone can paint any
  cell — there's no claim or lock on a piece of land. This was decided for
  Crit 9 and hasn't changed; see `ADR.md`'s first entry for why.
- **Undo is strictly per-session, checked server-side.** A request can only
  ever undo whatever *that same session* last painted — there's no way to
  address someone else's edit, by construction, not just by convention. See
  `ADR.md`'s second entry for the full reasoning.
- **Every edit is logged, server-side, with who did it** — including
  attempts that get refused. [`/logs/`](/logs/) shows this live; the same
  information is also in this app's own process output
  (`flyctl logs -a <repo>`), so it's there whether or not anyone's looking
  at the page.

## Known gaps — named now, not hidden

- **Visual quality is a work in progress.** `ROADMAP.md` tracks this
  honestly: some terrain (mountains, in particular) still reads as
  obviously stamped rather than hand-sculpted, named as a real,
  not-yet-fixed limitation rather than hidden behind a nicer screenshot.
- **Undo is one level deep, in memory.** It reverts your very last stroke,
  not a history you can step back through further — that's deliberately
  left to a later, properly persisted version-history feature, not
  conflated with this narrower permission feature.
- **No rate limiting.** A visitor can paint as fast as they like.
- **One shared map, no growth or multiple maps yet.**

## Credits

Terrain rendering reuses Three.js (vendored, MIT) and techniques adapted
from published work — see [the credits page](/credits/) (also
[`CREDITS.md`](CREDITS.md) in the repo) for the full licence and
attribution record, including what was built from scratch versus adapted
from an existing source.
