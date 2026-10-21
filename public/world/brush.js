// Brush maths for the editor, kept free of DOM and grid state so it can be
// checked in Node (spec/brush.test.ts) and reasoned about on its own.
//
// What it fixes (Step II, "terrain height changes can be too abrupt"):
//  - Strength used to be added on every stamp of a drag, so one stroke's
//    height depended on how long you dragged and how big the brush was
//    (15% gave about 0.36 in a single pass). A stroke now carries a
//    per-cell high-water mark (the "max" accumulation mode of Krita and
//    Photoshop brushes): however long you drag, one stroke changes a cell
//    by at most Strength x falloff. Stroke again to build further.
//  - Strength was a linear 1-30% slider, so the useful low end was a
//    couple of notches. It's now perceptual (exponential), 0.5% to 50%,
//    the curve image editors use for flow and opacity: equal slider steps
//    are equal ratios, so fine work and dramatic strokes both have room.
//  - Hardness: smoothstep falloff with an adjustable solid core, as in
//    Photoshop, Krita and Unreal's landscape brushes. 0 is the old soft
//    dome; higher keeps a flat top for terraces and cliffs.

export const STRENGTH_MIN = 0.005;
export const STRENGTH_MAX = 0.5;
export const SLIDER_STEPS = 100;

// Slider position (0..SLIDER_STEPS) to strength, and back.
export function strengthFromSlider(v) {
  const t = Math.min(1, Math.max(0, v / SLIDER_STEPS));
  return STRENGTH_MIN * Math.pow(STRENGTH_MAX / STRENGTH_MIN, t);
}

export function sliderFromStrength(s) {
  const t = Math.log(s / STRENGTH_MIN) / Math.log(STRENGTH_MAX / STRENGTH_MIN);
  return Math.round(Math.min(1, Math.max(0, t)) * SLIDER_STEPS);
}

// Strength as a share of full mountain height, with a decimal place where
// the steps are fine enough to need one.
export function formatStrength(s) {
  const pct = s * 100;
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

// 1 inside the hard core, easing (smoothstep) to 0 at the rim.
export function brushFalloff(dist, radius, hardness) {
  if (dist > radius) return 0;
  const d = radius > 0 ? dist / radius : 0;
  const h = Math.min(0.95, Math.max(0, hardness));
  if (d <= h) return 1;
  const t = 1 - (d - h) / (1 - h);
  return t * t * (3 - 2 * t);
}

// Raise `base` by `rise`, easing in under `ceiling` instead of clipping at
// it: nearly linear while there's plenty of room, so small strokes do what
// Strength says, but a summit approaches the cap smoothly rather than
// flattening into a table where it hits it.
export function softRaise(base, rise, ceiling) {
  const room = ceiling - base;
  if (room <= 0 || rise <= 0) return base;
  return ceiling - room * Math.exp(-rise / room);
}

// Coverage for material brushes: whether a cell takes the paint, from a
// clumpy noise field anchored to the world (so overlapping dabs agree, and
// a sparse stroke leaves stands and glades rather than salt-and-pepper).
// `noise` is in -1..1. At coverage 1 every cell in the circle is painted,
// as before; lower values thin it, raggedly toward the rim.
export function coverageAccepts(noise, coverage, falloff) {
  if (coverage >= 1) return true;
  const n = 0.5 + 0.5 * noise;
  return n < coverage * (0.75 + 0.25 * falloff) + 0.12 * (coverage - 0.5);
}

// Mountain/Peak: each cell's ceiling follows the brush falloff, so the
// spine can reach the full ceiling but the flanks top out lower. However
// many strokes go over the same ground, a range keeps a graded cross
// section - repeated strokes used to converge every cell in the brush on
// the same cap, which is what made a flat-topped wall.
//
// The profile is a square root of the falloff: broad shoulders, then the
// spine. The renderer draws everything under its mountain band (0.42) as
// flattened lowland, so a narrower profile showed only its inner third as
// relief - a thin wall. Measured on the drawn height at 50% strength, the
// visible range is about twice as wide this way.
export function mountainRaise(base, falloff, lift, ceiling, floor) {
  const g = Math.sqrt(Math.min(1, falloff * 1.1));
  const cap = floor + (ceiling - floor) * g;
  return cap > base ? softRaise(base, lift * g, cap) : base;
}
