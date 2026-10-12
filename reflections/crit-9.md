# Crit 9 reflection

## What was the breakthrough that moved the work forward?

The breakthrough was applying last week's lesson instead of just writing it
down. Crit 8's reflection said I needed to look at the real page earlier,
not trust green tests alone. This week, building the real-time terrain
layer, I kept to that: before calling the SSE sync "done," I opened two
actually separate browser sessions — not two tabs sharing one cookie — and
watched a paint stroke in one show up in the other with no reload. The
other breakthrough was scope discipline on the concurrency question C9
asks for. It would have been easy to reach for a CRDT because that's the
"correct" answer for shared editing. Writing the ADR forced me to notice
this app has one always-on server and no offline editing, so a CRDT would
solve a problem I don't have. Server-authoritative, last-write-wins, is
enough, and saying so in writing is what let me stop there instead of
over-building.

## What did this work change about who I want to be as a software developer?

I want to keep treating a reflection's advice as something to act on next
time, not just a record of what went wrong once. It would have been easy
to read "check the real thing earlier" as a lesson about last week's
specific terrain brush, rather than a general habit. Checking two
real, independent sessions tonight — instead of trusting the architecture
diagram in my head — is what actually caught that the sync works, rather
than assuming it does because the code looks right.
