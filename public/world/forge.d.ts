// Types for forge.js, which the server imports (src/forge.ts). The module
// itself stays plain JS so the browser loads it with no build step.
export const FORGE_SIZE: number;
export const TEMPLATES: string[];
export type ForgeSettings = { land: number; mountains: number; forest: number };
export const DEFAULT_SETTINGS: ForgeSettings;
export function normaliseSettings(settings?: Partial<Record<keyof ForgeSettings, unknown>>): ForgeSettings;
export function forgeWorld(
  seed: string,
  template: string,
  settings?: Partial<ForgeSettings>,
): { elevation: Float32Array; types: Uint8Array };
export function previewPixels(world: { elevation: Float32Array; types: Uint8Array }, size: number): Uint8ClampedArray;
