# Process overview

Atlas Table is a shared fantasy-map table. This account covers how it got
from the brief to the harness behind it, and why I chose the stack and
the way of working with agents.

## From The Isle to a map people make together

The brief put multi-user interaction at the centre, and I wanted that to
mean something more than many people touching one page. My goal was a
collaborative fantasy map editor that is actually useful: people building
and shaping a world together in real time, not decorating a fixed picture.

Crit 8 shipped The Isle: visitors dropped marks on a fixed island picture
([37a6cc1](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/37a6cc1)).
I tried making the terrain editable as a brush painting onto that picture.
The tests passed, but it looked like stickers on a photo. I kept the
attempt in the history and reverted it
([a65b339...f040c99](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/compare/a65b339...f040c99)).
That failure set the direction: the map itself has to be the shared,
editable thing. Crit 9 built real-time terrain painting at `/world/`
([056225a](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/056225a)),
and Crit 10 added server-checked, per-person undo and an activity log
([2f6e757](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/2f6e757)).

From 21 October the product grew into Atlas Table:
- private maps with edit and view links
  ([f609d27](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/f609d27));
- a home page that generates a world for you
  ([48b6d34](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/48b6d34));
- versions, export and buildings
  ([2f838aa](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/2f838aa),
  [ab8593a](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/ab8593a));
- multi-step undo, a first-use tour and a usable phone editor
  ([0821846](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/0821846),
  [434d2c3](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/434d2c3));
- town walls and roads
  ([1f0c3c4](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/1f0c3c4)).

Each of these served one of four things I came to see as inseparable:
collaboration, a result that looks good, freedom to shape the world, and
controls that feel intuitive. Real-time sync with ugly output, or a
beautiful map nobody else can touch, would each miss the point. Success,
for me, is collaborative world-building that both works and is fun.

## Stack: the case, and what it cost

Plain Node 24 with `node:http` and `node:sqlite`, server-sent events, no
framework and no bundler.
- **Node runs TypeScript directly**, so there is no build step.
- **SQLite is built into Node**, so the Docker image has nothing to
  compile ([37a6cc1](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/37a6cc1)).
- **SSE rather than WebSockets.** Changes flow one way, from server to
  browser, and edits are ordinary POSTs that the server can check. SSE
  does that over plain HTTP, with reconnection built in.
- **Server-authoritative, last write wins, not CRDTs.** There is one
  always-on server and no offline editing, so a CRDT would solve a problem
  the app doesn't have ([`ADR.md`](ADR.md), first entry).

The cost:
- **Hand-written routes.** Every route checks permissions by hand, so the
  checks live in `spec/` instead: 98 tests, including "a view link refuses
  every write" and "undo never touches another person's stroke".
- **Hand-vendored libraries.** Three.js and driver.js are copied into the
  repo, because there is no bundler.

For the visuals, the rule in `CLAUDE.md` is "reuse before you build":
search for an open-source library or a CC0 asset pack before writing a
renderer or art. That gave Three.js and the KayKit models, each recorded
in [`CREDITS.md`](CREDITS.md) with what was passed over.

## Agent workflow

- **Claude Code** did all the implementation. I directed it and judged
  the results.
- **ROADMAP.md is the working memory.** Each piece of work is assessed
  (root cause, options compared) before it is built, then the verification
  is recorded, including the failures.
- **Prototypes are built on branches**, and are merged and deployed only
  after I have looked at them.
- **Deploys** go only through a push to `main` and CI, after a volume
  snapshot.

**Two models.** Commit trailers show Sonnet from 4 to 20 October and
mostly Opus after that. On the terrain's look, Sonnet went through several
rejected approaches over two weeks. During that time I kept changing the
prompts, the instructions in `CLAUDE.md` and the workflow, but the
pictures weren't getting much better. Sonnet identified some of the
problems but repeatedly failed to solve them. So I changed a different
variable: the model. Opus then fixed the two worst problems, circular mountains and
rectangular forests, at their source in one session
([3dc0491](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/3dc0491)).
The fix was in the data and the brush, not in more texture on top, and
that lesson went into `CLAUDE.md`. I took from this that model capability
really matters, but it wasn't a fair test: Opus started with Sonnet's
earlier analysis and the improved project context.

## Corrections that landed in the harness

- **Green tests, bad page (Crit 8).** This produced `CLAUDE.md`'s rule
  that a visual change isn't done until it has been rendered and compared
  with the reference maps
  ([5160426](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/5160426)).
  The rule went on to catch several bugs that passed every test:
  - the two views disagreeing about where the sea was
    ([e84403f](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/e84403f));
  - an iPhone showing a flat plane where the terrain should be
    ([79ca78d](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/79ca78d));
  - buildings floating on slopes
    ([12b13f3](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/12b13f3));
  - a phone map crushed to 2 px
    ([434d2c3](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/434d2c3)).
- **Hand-built visuals.** An abandoned terrain brush and an ink-sketch
  renderer led to the "reuse before you build" rule in `CLAUDE.md`
  ([056225a](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/056225a)).
- **A fabricated check.** During a deploy, the agent reported a backup
  snapshot that did not exist, and deployed from this machine before the
  code reached GitHub. I recorded it plainly
  ([928e90f](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/928e90f)).
  Since then, deploys go only through CI, after a snapshot that is shown
  as listed.
- **Undo that didn't undo.** Using the app showed that undo was
  one step deep and split long strokes. It was rebuilt per person and
  covered by five new tests
  ([0821846](https://github.com/comp4020-agentic-coding-studio/comp4020-final-bobduke31/commit/0821846)).

## What the tests can't see

The `spec/` suite checks data, permissions and real-time delivery well. It
never caught a rendering fault: every one above was found by looking. So I
treat the screenshots in `ROADMAP.md`, and the rule that produces them, as
part of the checks.

If I started again, I would study established map editors and fix a clear
visual target first, then build a small working prototype and use it
myself before expanding. Automated tests are worth having, but passing
them never told me the product was good.
