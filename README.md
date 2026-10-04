# The Isle

A fictional island, shared by whoever visits it. There's no login and no
feed — just one map. Click or tap a spot on the coast or inland, drop a flag,
a campfire, a tent, a boat, a tree, or a ruin, and it stays there for the next
person who visits.

This is the first version, shipped for Crit 8 ("It's alive!"). It does one
thing: a stranger visits, leaves a mark, and finds it still there when they
come back. The real-time layer (seeing other people's marks appear live) and
a bigger world (more islands, more room) are deliberately left for later.

## The core interaction

1. Open the island.
2. Click or tap anywhere on it.
3. Pick one of six icons from the small palette that appears.
4. The mark is saved. Reload the page, or come back tomorrow — it's still there.

That's the whole app, on purpose. Everything else is in service of making that
one loop feel good, not in adding more to do.

## What "good" means for this app (first draft)

Good, for a small shared space like this, isn't the same as good for a product
with a feed and a login. The brief points at the small web, games made for a
handful of friends rather than a mass audience, and tools built for one
workshop rather than everyone — places that are legible and calm because only
a few people shaped them, not because a moderation team is watching. I want
The Isle to feel closer to that than to a public comment section.

Concretely, a first attempt at what that means here:

- **It reads as a place, not a grid.** A mark should feel like it was left
  *somewhere* — on the hill, by the lake, out on the point — not at
  coordinates. The island's own terrain (coastline, forest, hills, an inland
  lake) is what gives marks that sense of location, instead of a blank canvas
  where every pixel is interchangeable.
- **It stays legible as it fills up.** A handful of marks should look like
  visitors; a few hundred shouldn't look like vandalism. I don't think a fixed
  grid of icons can survive unlimited growth forever — this is the main open
  problem, not something I've solved yet (see Known gaps, below).
- **It can't be used to write anything.** There's no text field, on purpose —
  only six fixed icons. That's a real constraint on expression, and I'm
  choosing it deliberately: a world map that anyone can scrawl free text onto
  is a world map that gets defaced on day one. Icons-only is a narrower, safer
  first answer.
- **A trace is enough.** The bar for "alive" this week is small: someone did
  something, and it's still there. I'm treating persistence itself as part of
  what's good about the app, not just a technical checkbox — a place that
  forgets you doesn't feel shared.

What I looked at while deciding this: the brief's own pointers toward the
small web and games built for a handful of people rather than a crowd;
shared, persistent pixel-canvas projects as an example of what a completely
open, textless, mark-by-mark shared space can turn into at scale (both the
good parts — collective creativity — and the bad parts — it also becomes a
territorial, defaced mess once anyone can edit anything); and early-web
guestbook pages, which solved a much smaller version of the same
problem (a visitor leaves a trace, the next visitor sees it) with almost no
moderation machinery at all.

## Known gaps — named now, not hidden

- **No rate limiting yet.** A visitor can currently place marks as fast as
  they like. This is the most obvious hole in "stays legible as it fills up,"
  and I expect it to be the first thing that changes.
- **No real-time layer yet.** Marks only appear for a visitor when they load
  or reload the page. The final project needs this; the crit spec says it can
  wait, so it has.
- **One fixed island, no growth yet.** The world doesn't get bigger as more
  people visit. I'd like new regions to unlock over the coming weeks, both as
  a way to manage crowding and as visible evidence of the project growing
  alongside the semester.

## Credits

Island art and mark icons are sourced, not hand-drawn — see
[the credits page](/credits/) (also [`CREDITS.md`](CREDITS.md) in the repo)
for the full licence and attribution record for each asset.
