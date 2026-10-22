// Types for the server's import of thumbnail.js (plain JS, no bundler).
export interface Grids {
  elevation: Float32Array;
  types: Uint8Array;
}
export function gridsFromRows(
  cells: { x: number; y: number; elevation: number }[],
  typeCells: { x: number; y: number; terrain: string }[],
): Grids;
export function thumbnailPixels(grids: Grids, width: number, height?: number): Uint8ClampedArray;
