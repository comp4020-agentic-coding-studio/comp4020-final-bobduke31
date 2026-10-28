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

## What the app must never do

These follow from `README.md`'s definition of good. The first two are held
by the checks in `spec/`, so a change that breaks one fails `pnpm check`.
The third is checked in part: writes are read back from the database, and
versions round-trip exactly. Surviving a redeploy is checked by comparing
production data before and after each deploy (ROADMAP.md). The last two
can't be tested, so they are rules of conduct.

- **A view link never writes.** Every write route refuses the view link
  and the wrong map (`spec/rooms.test.ts`).
- **Undo is yours alone.** It reverses only the caller's own changes, and
  never a collaborator's newer edit (`spec/activity.test.ts`,
  `spec/versions.test.ts`, `spec/paths.test.ts`).
- **Nothing is lost by accident.** Data survives restarts and redeploys.
  A restore checkpoints the map first. A schema change adds new tables.
  The one migration that changed existing tables (rooms, in phase 1) was
  first rehearsed on a copy of production data, with content hashes
  checked (`src/rooms-schema.ts`, ADR.md).
- **Deploy safely.** Deploy only through a push to `main` and CI, after a
  volume snapshot has been seen listed as created. Never deploy from a
  local machine (ROADMAP.md, 928e90f).
- **Report only what was observed.** A check that wasn't run is reported
  as not run. A deploy record once stated a backup that did not exist.

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

**The `/world/` Oblique view is now a real Three.js (vendored, MIT) WebGL2
heightfield mesh**, not a 2D canvas column-extrusion trick --- see
`terrain-renderer-3d.js` and `CREDITS.md`'s "Vendored code" section for what
was adopted (Three.js itself) versus considered and passed over
(`THREE.Terrain` is a procedural *generator*, not a fit for an authoritative
heightfield; `@interverse/three-terrain-lod`'s slope-based-blending *idea*
was reused, its TSL/WebGPU package was not, to avoid a second dependency
axis in a no-bundler repo). The forest canopy billboards are a small
authored texture, not sourced art --- every CC0/CC-BY pack found was either
ink/line-art style (the direction this file already steers away from) or a
pixel-art register that reads as a retro tile game, not painted cartography.
Kenney's Nature Kit (CC0, real 3D tree models) remains on record as the
option if the project wants to replace the billboards with real meshes
later.

**Both views are one renderer** (validated 2026-10-20 on
`final-redesign-prototype`, see ROADMAP.md "Terrain & visual overhaul"):
with WebGL2, Top-down is the same Three.js scene as Oblique, seen from an
overhead orthographic camera. Don't reintroduce a separate Top-down
renderer - two implementations is what made the views look like two
products. Everything derived from the stored grids (smooth B-spline
surface, synthesised ridges, material boundaries, coast distance field)
lives once in `terrain-fields.js`, with a GLSL twin that must stay
identical to the JS; the displayed surface is baked on the CPU so picking,
tree placement and geometry agree by construction. Fix shape problems at
their layer - seed data, brush, or derived fields - not with more noise or
texture on top: the circular mountains and rectangular forests were data
and brush problems, not shading ones. `terrain-renderer.js` (canvas) is
only the no-WebGL2 fallback.

## Verify the rendered result, not a description of it

A passing check or a plausible description is not evidence. Before calling
any visual or interaction change done: render it for real (a local
screenshot, Playwright, or `agent-browser`) and look at it next to the
reference material in `research/`, not a memory of it --- that's the only
reason either failure above was caught in the first place. The same applies
to delegated or background work: read the real diff and rerun the checks
yourself before calling it complete.
