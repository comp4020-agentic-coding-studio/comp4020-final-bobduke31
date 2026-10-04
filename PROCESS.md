# Process overview

## What this crit shipped

The Isle: a shared, fictional island where a visitor clicks or taps a spot
and drops one of six fixed marks (flag, campfire, tent, boat, tree, ruin).
Marks are saved to SQLite on the Fly volume, so they survive a reload, a
restart, or a redeploy. There's no login — an anonymous per-visitor cookie
tags each mark, which also sets up the "distinguish users" requirement the
final project will need. On top of that, a visitor can now remove a mark
they placed themselves, but not anyone else's — the server checks the
cookie against who actually placed the mark before it deletes anything.
`README.md` carries the first draft of what "good" means for this app.

## Stack decision record

**Chosen**: plain Node 24 + the built-in `node:http` and `node:sqlite`
modules, no framework, no bundler, no build step. The repo's `tsconfig.json`
already expects `.ts` files to run directly (the `allowImportingTsExtensions`
comment says as much), and Node 24 does exactly that via its built-in
type-stripping — `node src/server.ts` runs with no compile step. That keeps
`Dockerfile` to a plain `FROM node:24-alpine`, a `pnpm install --prod`, and a
copy of `src/`/`public/`.

**Why not a framework** (Express/Fastify/etc.): the whole app is a handful of
routes (`/`, `/readme/`, `/credits/`, and `GET`/`POST`/`DELETE` on
`/api/marks`) plus static files. A framework would add a dependency and a
layer of routing abstraction over something `node:http` already does in
about 100 lines. Not worth it at this size.

**Why not `better-sqlite3`**: it's the more mature library, but it's a native
addon that needs a compiled binary per platform, which complicates the
Docker build (a toolchain stage, or trusting a prebuilt binary matches
Alpine's musl libc). `node:sqlite` ships inside Node itself — confirmed
working unflagged on Node 24.21 before committing to it — so there's nothing
to compile and nothing that can mismatch between the dev machine and the
container.

**Why one dependency (`marked`)**: README.md and CREDITS.md need to render as
HTML at `/readme/` and `/credits/`. Hand-rolling a markdown parser is exactly
the kind of reinventing-the-wheel the brief doesn't need solved from
scratch, and `marked` has no native dependencies of its own.

This is a first choice, made for a small prototype. If the app outgrows
plain `node:http` — more routes, real-time fan-out to many open
connections, auth — the plan is to swap and write a new decision record
here, not to wedge a framework in after the fact.

## What actually happened this week

Short version: the simple version worked first, I spent too long trying to
make something fancier instead, it didn't actually look good once
I sat down and used it, and I ended up back where I started, plus one small,
real feature.

The longer version: the simple island from Crit 8
([37a6cc1](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/37a6cc1ed026b4c2cc032141e4eca4d6a39e82af) — "Ship first working version of The Isle
for Crit 8") already did the one thing it needed to do: place a mark, see it
still there later. That should have been enough for this round. Instead I
got it into my head that terrain should be editable too — visitors painting
grass, sand, rock, water, and forest onto the island itself, not just
dropping icons on top of it. I tried several approaches before giving up on
the direction: map shapes you draw and edit with a real map-editing library,
and later a brush that paints texture straight onto the island image so it
would blend into the original art, among others.

Every one of them technically worked. The code was fine, the automated
tests passed, and a script could click around a running page, paint,
reload, and confirm everything saved and came back correctly. But none of
that told me whether it was actually good. When I opened the page myself and
used it the way a visitor would, rather than just reading code or test
output, I didn't like what I saw. The shape-based attempt read as decoration
floating over the map, not the map itself changing. The brush attempt fixed
that, but by the time it also handled zooming, panning, erasing, and
painting past the island's edge, it had turned into a lot of fiddly
machinery for a feature that didn't make the app more fun — it made it more
complicated. It was more impressive to describe than it was good to
actually sit with.

So I stopped. I committed the experiment as its own commit
([a65b339](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/a65b33928093e22c4d9984ae594519bc8789d1fe) — "Experiment with editable terrain for The
Isle") so the attempt is on the record instead of just disappearing, and
then reverted it straight away ([f040c99](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/f040c9949353d52b003e734d1543607eea8874cb) — "Revert
'Experiment with editable terrain for The Isle'") to get back to the simple
island that already worked. Nothing from that detour made it into what's
shipped here; the app in this repo is the Crit 8 version, plus one addition.

That addition — the one real feature in this update — is letting a visitor
remove a mark they placed themselves. The server already tagged every mark
with an anonymous session cookie, so most of the work was reusing that:
checking the cookie on delete, the same way it's already checked on create,
rather than inventing anything new. In the interface, a mark you placed
carries a small red × in its corner; clicking it removes that mark from the
page and from the database. Marks that aren't yours never grow that button,
and the server refuses to delete them even if someone tried to force it
through the API directly — ownership is enforced on the server, not just
hidden in the UI.

The main thing I'm taking from this week isn't the feature itself. It's that
I let that detour continue for too long on green tests and a script that clicked around
and said "yes, it saved and reloaded," without looking at the actual result
often enough along the way. Tests are good at telling you the plumbing
works. They can't tell you whether the thing you built is worth having.

## Assets

Island art and mark icons were sourced from CC0/CC BY game-art projects
rather than hand-drawn, to get a more visually finished first version in the
time available. Full attribution and licence terms are in `CREDITS.md`.

## Known gaps

Named in `README.md`'s "Known gaps" section rather than repeated here: no
rate limiting yet, no real-time layer yet (out of scope for this crit per
its own spec), and one fixed island with no growth yet.
