// Server side of the Forge (public/world/forge.js): builds a new map's
// terrain from a seed, a template and three sliders. The client sends only
// those few values, never cells, and the server runs the same pure module
// the preview ran - so the stored map is exactly what was previewed, and a
// request can't smuggle arbitrary terrain in through it.
import { forgeWorld, normaliseSettings, TEMPLATES, FORGE_SIZE } from "../public/world/forge.js";
import { applyCells, applyTerrainTypes, TERRAIN_TYPES, GRID_SIZE, type TerrainCell, type TerrainTypeCell } from "./terrain.ts";

export type ForgeRequest = {
  seed: string;
  template: string;
  settings: { land: number; mountains: number; forest: number };
};

export const SEED_MAX = 40;

// Rows stored past the coast. The renderer draws water deeper than this as
// open sea whatever its stored depth (terrain-renderer-3d.js waterColor),
// and an unstored cell already reads as sea, so open ocean costs nothing -
// the same sparse model the shared world has always used. Measured: a
// continent at default settings stores about half its grid this way.
const SHELF_CELLS = 10;

// Checks and normalises a request body's `forge` field, or null if it
// isn't a usable one. Sliders are clamped by normaliseSettings.
export function parseForge(value: unknown): ForgeRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const { seed, template, settings } = value as Record<string, unknown>;
  if (typeof seed !== "string" || typeof template !== "string") return null;
  const cleanSeed = seed.trim().slice(0, SEED_MAX);
  if (!cleanSeed || !TEMPLATES.includes(template)) return null;
  return { seed: cleanSeed, template, settings: normaliseSettings(settings as Record<string, unknown>) };
}

// Writes the generated world into a freshly created (empty) room.
export function forgeIntoRoom(roomId: string, request: ForgeRequest): { cells: number } {
  if (FORGE_SIZE !== GRID_SIZE) throw new Error("forge size does not match the grid");
  const { elevation, types } = forgeWorld(request.seed, request.template, request.settings);
  const N = GRID_SIZE;
  const keep = new Uint8Array(N * N);
  // Every land cell, plus sea within SHELF_CELLS of land.
  for (let i = 0; i < N * N; i++) {
    if (elevation[i] <= 0) continue;
    const x = i % N, y = (i / N) | 0;
    for (let dy = -SHELF_CELLS; dy <= SHELF_CELLS; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= N) continue;
      for (let dx = -SHELF_CELLS; dx <= SHELF_CELLS; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < N && dx * dx + dy * dy <= SHELF_CELLS * SHELF_CELLS) keep[yy * N + xx] = 1;
      }
    }
  }
  // The "blank" template has no land, so nothing is stored: the same empty
  // sea a plain new map has always started as.
  const cells: TerrainCell[] = [];
  const typed: TerrainTypeCell[] = [];
  for (let i = 0; i < N * N; i++) {
    if (!keep[i]) continue;
    const x = i % N, y = (i / N) | 0;
    // Four decimals, as the brush API stores; never exactly 0 (sea level),
    // which would read as an unstored cell.
    const e = Math.round(elevation[i] * 1e4) / 1e4 || -0.0001;
    cells.push({ x, y, elevation: e });
    if (e > 0 && types[i]) typed.push({ x, y, terrain: TERRAIN_TYPES[types[i]] });
  }
  if (cells.length) applyCells(roomId, cells);
  if (typed.length) applyTerrainTypes(roomId, typed);
  return { cells: cells.length };
}
