# Your harness

## What we're building

A real-time, multiplayer fantasy world-building site: people shape terrain,
roads and settlements together, on one shared persistent map. The visual bar
is Inkarnate/Wonderdraft-style cartography --- blended natural terrain, ink
coastlines, forests and mountains built from dense scattered detail --- not a
hex/tile grid and not icons pasted on a static image (that was C8's mistake,
and C8 is not a direction to return to).

Reference images and disposable rendering spikes live locally under
`research/` (gitignored --- dev material, not shipped; ask if it's missing
and needs re-adding). A regional-scale map is the near-term fidelity target;
continent scale is the same engine at a later, larger scope; an isometric
city view is out of scope for now.

## Reuse before you build

C8's abandoned terrain brush and this prototype's ink-sketch renderer both
happened because hand-rolling a plausible approximation felt faster than
searching for something closer to the target already built. Before writing a
new renderer, interaction, or art asset: search for an existing open-source
implementation, library, or CC0/CC-BY asset pack close to the target style,
and record what was found (or why nothing usable existed) --- the same
discipline `CREDITS.md` already applies to every art asset. Hand-build only
what genuinely has no off-the-shelf equivalent; confirmed so far that's the
multiplayer sync layer, not the visuals.

## Verify the rendered result, not a description of it

A passing check or a plausible description is not evidence. Before calling
any visual or interaction change done: render it for real (a local
screenshot, Playwright, or `agent-browser`) and look at it next to the
reference material in `research/`, not a memory of it --- that's the only
reason either failure above was caught in the first place. The same applies
to delegated or background work: read the real diff and rerun the checks
yourself before calling it complete.
