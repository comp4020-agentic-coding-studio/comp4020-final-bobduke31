# Process overview

## What this crit shipped

The Isle: a shared, fictional island where a visitor clicks or taps a spot and
drops one of six fixed marks (flag, campfire, tent, boat, tree, ruin). Marks
are saved to SQLite on the Fly volume, so they survive a reload, a restart, or
a redeploy. There's no login — an anonymous per-visitor cookie tags each mark,
which also sets up the "distinguish users" requirement the final project will
need. `README.md` carries the first draft of what "good" means for this app.

## Stack decision record

**Chosen**: plain Node 24 + the built-in `node:http` and `node:sqlite`
modules, no framework, no bundler, no build step. The repo's `tsconfig.json`
already expects `.ts` files to run directly (the `allowImportingTsExtensions`
comment says as much), and Node 24 does exactly that via its built-in
type-stripping — `node src/server.ts` runs with no compile step. That keeps
`Dockerfile` to a plain `FROM node:24-alpine`, a `pnpm install --prod`, and a
copy of `src/`/`public/`.

**Why not a framework** (Express/Fastify/etc.): the whole app is four routes
(`/`, `/readme/`, `/credits/`, `GET`/`POST /api/marks`) plus static files.
A framework would add a dependency and a layer of routing abstraction over
something `node:http` already does in about 100 lines. Not worth it at this
size.

**Why not `better-sqlite3`**: it's the more mature library, but it's a native
addon that needs a compiled binary per platform, which complicates the Docker
build (a toolchain stage, or trusting a prebuilt binary matches Alpine's musl
libc). `node:sqlite` ships inside Node itself — confirmed working unflagged
on Node 24.21 before committing to it — so there's nothing to compile and
nothing that can mismatch between the dev machine and the container.

**Why one dependency (`marked`)**: README.md and CREDITS.md need to render as
HTML at `/readme/` and `/credits/`. Hand-rolling a markdown parser is exactly
the kind of reinventing-the-wheel the brief doesn't need solved from scratch,
and `marked` has no native dependencies of its own.

This is a first choice, made for a four-route prototype. If the app outgrows
plain `node:http` — more routes, real-time fan-out to many open connections,
auth — the plan is to swap and write a new decision record here, not to wedge
a framework in after the fact.

## Assets

Island art and mark icons were sourced from CC0/CC BY game-art projects
rather than hand-drawn, to get a more visually finished first version in the
time available. Full attribution and licence terms are in `CREDITS.md`.

## Known gaps

Named in `README.md`'s "Known gaps" section rather than repeated here: no
rate limiting yet, no real-time layer yet (out of scope for this crit per its
own spec), and one fixed island with no growth yet.
