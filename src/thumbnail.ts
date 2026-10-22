// Map pictures for the Atlas home, the gallery and link previews (Atlas
// Table stage A). Drawn here from the stored grids by the same pure module
// the browser could use (public/world/thumbnail.js), so a card always shows
// the map as it is now: no client-uploaded image that goes stale (the
// Figma complaint) or can be swapped for something else.
//
// PNG is encoded with node:zlib, the only compression a PNG needs, so this
// adds no dependency. Cached per room and size until the room's terrain
// revision changes (src/terrain.ts); a 320 px picture takes ~100 ms to draw.
import { deflateSync, crc32 } from "node:zlib";
import { gridsFromRows, thumbnailPixels } from "../public/world/thumbnail.js";
import { listCells, listTerrainTypes, terrainRevision } from "./terrain.ts";

export const THUMB_SIZES = {
  card: [480, 300],
  og: [1200, 630],
} as const;
export type ThumbSize = keyof typeof THUMB_SIZES;

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

// RGBA in, PNG out. Alpha is always 255 here, so it's written as RGB:
// a quarter smaller for nothing.
export function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    let o = y * stride + 1; // first byte of each row: filter type 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[o++] = rgba[i];
      raw[o++] = rgba[i + 1];
      raw[o++] = rgba[i + 2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type Cached = { revision: number; png: Buffer; etag: string };
// Part of every ETag: a new deploy may draw differently, so pictures cached
// by browsers under the old code must not be reused.
const BOOT = Date.now().toString(36);
const cache = new Map<string, Cached>();
// Enough for every card on a busy Atlas page and a handful of previews.
const CACHE_MAX = 200;

export function thumbnailFor(roomId: string, size: ThumbSize): Cached {
  const key = `${roomId}:${size}`;
  const revision = terrainRevision(roomId);
  const hit = cache.get(key);
  if (hit && hit.revision === revision) {
    cache.delete(key); // re-insert: Map order doubles as least-recently-used
    cache.set(key, hit);
    return hit;
  }
  const [w, h] = THUMB_SIZES[size];
  const png = encodePng(thumbnailPixels(gridsFromRows(listCells(roomId), listTerrainTypes(roomId)), w, h), w, h);
  const fresh = { revision, png, etag: `"${BOOT}-${roomId.slice(0, 8)}-${size}-${revision}"` };
  cache.set(key, fresh);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return fresh;
}
