# The Isle

A fictional island, shared by whoever visits it. There's no login and no
feed — just one map. Click or tap a spot, drop a flag, a campfire, a tent, a
boat, a tree, or a ruin, and it stays there for the next person who visits.
If it's a mark you placed yourself, a small × lets you take it back.

This is the first version, shipped for Crit 8 ("It's alive!"). It does one
thing: a stranger visits, leaves a mark, and finds it still there when they
come back — and can remove their mark if they change their mind. The
real-time layer (seeing other people's marks appear live) and a bigger world
are deliberately left for later.

## The core interaction

1. Open the island.
2. Click or tap anywhere on it.
3. Pick one of six icons from the small palette that appears.
4. The mark is saved. Reload the page, or come back tomorrow — it's still
   there.
5. A mark you placed carries a small red × in its corner. Click it to remove
   that mark. Only yours carry one — you can't remove anyone else's.

That's the whole app, on purpose. Everything else is in service of making
that one loop feel good, not in adding more to do.

## What "good" means for this app (first draft)

Good, for a small shared space like this, isn't the same as good for a
product with a feed and a login. The brief points at the small web and games
made for a handful of friends — places that are legible and calm because
only a few people shaped them, not because a moderation team is watching. I
want The Isle to feel closer to that than to a public comment section.

A first attempt at what that means here:

- **It reads as a place, not a grid.** A mark should feel left *somewhere* —
  on the hill, by the lake, out on the point. The island's own terrain
  gives marks that sense of location.
- **It stays legible as it fills up.** A handful of marks should look like
  visitors; a few hundred shouldn't look like vandalism. Unlimited
  overlapping marks won't stay legible forever — this is the main open
  problem (see Known gaps).
- **It can't be used to write anything.** No text field — only six fixed
  icons. A map anyone can scrawl free text onto gets defaced on day one.
- **Mistakes aren't permanent.** Removing your own mark matters too — a
  place that only accumulates marks, with no way back, punishes a misclick
  as much as something you meant.

What I looked at while deciding this: the brief's own pointers toward the
small web and games built for a handful of people; shared pixel-canvas
projects, as an example of what an open, mark-by-mark space can become at
scale, good and bad; and early-web guestbooks, which solved a smaller
version of the same problem with almost no moderation at all.

## Known gaps — named now, not hidden

- **No rate limiting yet.** A visitor can place (or remove) marks as fast as
  they like.
- **No real-time layer yet.** Marks only appear on load or reload. The crit
  spec says this can wait, so it has.
- **One fixed island, no growth yet.** The world doesn't get bigger as more
  people visit.

## Credits

Island art and mark icons are sourced, not hand-drawn — see
[the credits page](/credits/) (also [`CREDITS.md`](CREDITS.md) in the repo)
for the full licence and attribution record for each asset.
