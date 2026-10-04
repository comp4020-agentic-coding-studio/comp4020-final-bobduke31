# Crit 8 reflection

## What was the breakthrough that moved the work forward?

The breakthrough was deciding to stop. I spent too long this week trying
more complicated ideas for editable terrain — first as map shapes you draw,
then as a brush that paints texture onto the island image. Both versions
technically worked: the code was fine and the automated tests passed. But
when I actually opened the page and used it like a visitor would, it didn't
look good. The shapes read as stickers on top of the map, not part of it,
and the brush version turned into a lot of fiddly machinery for something
that didn't really make the app better. Once I actually looked at it
properly instead of trusting the green tests, it was obvious I'd gone down
the wrong path. I committed that attempt so it's on the record, reverted it,
and went back to the simple island that already worked, then added one
small real feature on top: you can remove a mark you placed yourself.

## What did this work change about who I want to be as a software developer?

I want to check the actual page much earlier next time, not just trust that
passing tests mean a feature is good. Tests told me the terrain brush saved
and reloaded correctly; they couldn't tell me it looked bad or wasn't fun to
use. I let that direction continue for too long because the numbers kept
saying everything was fine. Next time I'll look at the real thing after the
first small change, not after the whole idea is built, so a bad direction
costs an hour instead of much longer.
