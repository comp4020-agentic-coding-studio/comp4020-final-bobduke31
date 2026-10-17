# Crit 10 reflection

## What was the breakthrough that moved the work forward?

The breakthrough was realizing C10's permission requirement didn't need a
new identity system to be real. I started by assuming "server-side
permissions" meant adding accounts or roles — the bigger, more obviously
"permission-shaped" feature. Rereading the brief closely ("what counts as a
person is your call") and rereading my own ADR from C9 was what stopped me:
this app already has the one piece of identity it actually needs (the
session cookie), and the per-mark ownership check from Crit 8 already
proves the *pattern* works end-to-end. The real work wasn't inventing
identity — it was finding one more place that pattern genuinely applied
(undo, scoped strictly to a session) and extending it there, instead of
building something bigger just because "permissions" sounds like it should
require more machinery than a `Map` keyed by a cookie value.

The second breakthrough was catching a bug by tracing the client's actual
behaviour instead of assuming a clean mental model. I designed the undo
snapshot assuming one POST per brush stroke. Before writing a single test,
I went back and reread `world-client.js`'s own `flush()` function and
realized Mountain/Peak strokes send *two* sequential POSTs — elevation,
then terrain type. My first snapshot design would have silently thrown away
half of what a Mountain stroke needed to undo, and I wouldn't have found
that from a passing test; I'd have found it from a Mountain-undo looking
subtly wrong in a screenshot, if I'd even thought to check that specific
case. Catching it by reading the code I was integrating with, before
testing, instead of after, is the version of "verify the real thing" that
costs the least.

## What did this work change about who I want to be as a software developer?

I want to keep treating "does this feature need a bigger solution than it
looks like" as a real question to ask, not a reflex to answer with "yes,
build the general thing." It's tempting to read a crit brief's language
("permissions," "access control") and reach for the industry-standard shape
of that feature — accounts, roles — because that's what the words usually
mean elsewhere. The discipline I want to keep is: read what the brief
*actually* asks for, check what the app *actually* already has, and only
build the gap, even when the gap is a narrower, less impressive-sounding
feature than the one the vocabulary suggests. Undo-your-own-last-stroke is
a smaller feature than role-based access control, and it's also the right
amount of engineering for what this app and this week actually needed.

I also want to keep checking a design against the system's real behaviour
*before* writing the first version, not treating "well, the tests will
catch it" as a safety net for assumptions I could have checked directly by
reading five more lines of code. The tests did eventually catch a *second*,
unrelated bug this week (a real race in an existing test's event-matching
logic, exposed by adding a concurrent test file) — but that one I found
because the test suite is honest enough to fail loudly when something's
actually wrong, which is its own small confirmation that keeping the
automated checks real, not just green, pays off exactly when it matters.
