// Types for brush.js (checked from spec/forge.test.ts).
export const STRENGTH_MIN: number;
export const STRENGTH_MAX: number;
export const SLIDER_STEPS: number;
export function strengthFromSlider(v: number): number;
export function sliderFromStrength(s: number): number;
export function formatStrength(s: number): string;
export function brushFalloff(dist: number, radius: number, hardness: number): number;
export function softRaise(base: number, rise: number, ceiling: number): number;
export function coverageAccepts(noise: number, coverage: number, falloff: number): boolean;
export function mountainRaise(base: number, falloff: number, lift: number, ceiling: number, floor: number): number;
