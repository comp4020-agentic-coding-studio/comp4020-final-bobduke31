# Your harness

## Depth over simplicity

Assignment 1 came back marked too simple, too linear, and not interactive
enough. That was a directing failure, not a scope failure: I let the agent
reach for whichever version was easiest to implement instead of holding out
for the version that was actually interesting. Rules to stop that happening
again:

- Never simplify an idea just because the simpler version is easier to build.
  A focused idea still needs enough depth, variation and room to explore ---
  "focused" means the central idea stays clear, not that everything around it
  gets stripped away.
- This is HCI and interactive design work. Don't default to static
  information pages, plain forms, or basic input-in/output-out interactions.
  The interaction itself should let someone explore, experiment, get feedback
  and come to understand the idea by using it, not by reading about it.
- Visual presentation and playfulness are part of the quality of the
  response, not decoration to bolt on if time allows. Treat them as
  load-bearing from the start of the build, not a pass at the end.
- When exploring a direction, start from something richer than feels
  comfortable and refine it down, rather than starting minimal and hoping to
  add richness back in later --- that's how last time ended up linear.

## Verify agent work before trusting it

A "done" report is a claim, not evidence. Passing checks are necessary but
not sufficient either --- a check only tests what it was written to test,
and something can pass every automated check while still being visibly wrong
in the actual rendered result.

- Read the real diff and rerun the checks yourself before calling any
  delegated or background work complete --- don't take a summary report on
  faith, even when it looks accurate.
- Look at the actual rendered artefact (the page, the screen, the output),
  not just green checks. A broken result can still pass every check that
  exists; only looking at the thing catches what the checks don't measure.

## Ground a redesign in the real reference system

When a project consolidates or redesigns an existing system, inspect the
real reference interface itself --- actual screenshots, rendered pages, or
primary documentation showing what it looks like and how it organises
information --- before restructuring the UI. Don't infer the product from
its branding, from a text description of what it does, or from generic
design patterns for "that kind of app": those get the vibe right and the
actual structure wrong.

## Validate a redesign before building on it

- When a redesign changes the core interaction, inspect the real rendered result early before building more on it. Passing automated tests does not prove that the visual or interaction result still matches the intended design; if an implementation is becoming an approximation of the original goal, stop and reconsider before adding more complexity.
