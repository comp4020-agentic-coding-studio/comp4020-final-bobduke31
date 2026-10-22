// A map's picture for cards: the Atlas home, the gallery and link previews
// (Atlas Table stage A). Pure - no DOM - so the server draws it straight
// from the stored grids, which means a card always shows the map as it is
// now (no client-uploaded image to go stale or be faked).
//
// It reads like the renderer's Chart view because it is built from the same
// pieces: terrain-fields.js's displayed surface for the shading (so lowland
// the renderer draws flat stays flat, and ranges carry the same synthesised
// ridges), the ground shader's base colours, depth by distance offshore,
// and an ink coastline. It is a small painted summary, not a pixel copy:
// no trees, paper grain or wave strokes.
import { displayHeightAt } from "./terrain-fields.js";
import { GRID_SIZE, TERRAIN_TYPES } from "./terrain-model.js";

const N = GRID_SIZE;
const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
const SHALLOW = hex("#6ec3c6"), MID = hex("#2f8fae"), DEEP = hex("#1c5c86");
const GRASS = hex("#86a848"), SAND = hex("#e0cc9a"), FOREST = hex("#2a4a21");
const ROCK = hex("#9e8c76"), SNOW = hex("#f3f1ea"), INK = hex("#3b2f24");
const MATERIAL = [GRASS, SAND, FOREST, ROCK];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Grids from the API's sparse rows. Unstored cells are sea level, as
// everywhere else in the app.
export function gridsFromRows(cells, typeCells) {
  const elevation = new Float32Array(N * N);
  const types = new Uint8Array(N * N);
  for (const c of cells) elevation[c.y * N + c.x] = c.elevation;
  for (const c of typeCells) {
    const k = TERRAIN_TYPES.indexOf(c.terrain);
    if (k > 0) types[c.y * N + c.x] = k;
  }
  return { elevation, types };
}

// Cells of open water between each sea cell and the nearest land (chamfer).
// The renderer shades water by this, not by stored depth, so an unstored
// ocean still reads deep.
function offshoreDistance(elevation) {
  const d = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) d[i] = elevation[i] > 0 ? 0 : 1e6;
  const pass = (forward) => {
    const s = forward ? -1 : 1;
    for (let k = 0; k < N; k++) {
      const y = forward ? k : N - 1 - k;
      for (let j = 0; j < N; j++) {
        const x = forward ? j : N - 1 - j;
        const i = y * N + x;
        let v = d[i];
        if (x + s >= 0 && x + s < N) v = Math.min(v, d[i + s] + 1);
        if (y + s >= 0 && y + s < N) {
          const r = (y + s) * N;
          v = Math.min(v, d[r + x] + 1);
          if (x + s >= 0 && x + s < N) v = Math.min(v, d[r + x + s] + 1.414);
          if (x - s >= 0 && x - s < N) v = Math.min(v, d[r + x - s] + 1.414);
        }
        d[i] = v;
      }
    }
  };
  pass(true);
  pass(false);
  return d;
}

// Material colour at a fractional cell position, blended bilinearly between
// the four nearest cells' materials, so forest and shore edges are soft
// rather than stair-stepped when a cell covers several pixels.
function materialAt(types, x, y) {
  const x0 = clamp(Math.floor(x), 0, N - 1), y0 = clamp(Math.floor(y), 0, N - 1);
  const x1 = Math.min(N - 1, x0 + 1), y1 = Math.min(N - 1, y0 + 1);
  const tx = clamp(x - x0, 0, 1), ty = clamp(y - y0, 0, 1);
  const c00 = MATERIAL[types[y0 * N + x0]] ?? GRASS, c10 = MATERIAL[types[y0 * N + x1]] ?? GRASS;
  const c01 = MATERIAL[types[y1 * N + x0]] ?? GRASS, c11 = MATERIAL[types[y1 * N + x1]] ?? GRASS;
  return mix(mix(c00, c10, tx), mix(c01, c11, tx), ty);
}

// The window of the map a picture shows: the land, with a margin, centred.
// Where that window runs past the map's edge (a square map on a 16:10 card)
// the picture carries on as open sea, deepening with distance like the sea
// inside - so the whole landmass always fits and nothing is letterboxed.
function frame(elevation, width, height) {
  let x0 = N, y0 = N, x1 = -1, y1 = -1;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (elevation[y * N + x] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const whole = N / Math.min(width, height); // the whole map fits
  if (x1 < 0) return { scale: whole, left: (N - width * whole) / 2, top: (N - height * whole) / 2 };
  const fit = Math.max(((x1 - x0 + 1) * 1.16) / width, ((y1 - y0 + 1) * 1.16) / height);
  const scale = clamp(fit, whole / 3, whole); // never more than 3x closer
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
  return { scale, left: cx - (width * scale) / 2, top: cy - (height * scale) / 2 };
}

// RGBA pixels, `width` by `height`, of the map.
export function thumbnailPixels({ elevation, types }, width, height = width) {
  const out = new Uint8ClampedArray(width * height * 4);
  const dist = offshoreDistance(elevation);
  const { scale, left, top } = frame(elevation, width, height);
  const step = Math.max(0.75, scale);
  const surface = (x, y) => displayHeightAt(elevation, clamp(x, 0, N - 1), clamp(y, 0, N - 1));
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const x = left + (px + 0.5) * scale - 0.5, y = top + (py + 0.5) * scale - 0.5;
      const cx = clamp(Math.round(x), 0, N - 1), cy = clamp(Math.round(y), 0, N - 1);
      const i = cy * N + cx;
      // How far past the map's edge this pixel is (0 inside the map).
      const beyond = Math.hypot(Math.max(0, -0.5 - x, x - (N - 0.5)), Math.max(0, -0.5 - y, y - (N - 0.5)));
      let c;
      if (beyond > 0 || elevation[i] <= 0) {
        // Shelf to deep sea over ~14 cells offshore, as the renderer does.
        const t = smoothstep(0, 14, dist[i] + beyond);
        c = t < 0.35 ? mix(SHALLOW, MID, t / 0.35) : mix(MID, DEEP, (t - 0.35) / 0.65);
      } else {
        const e = elevation[i];
        c = mix(materialAt(types, x, y), ROCK, smoothstep(0.42, 0.6, e));
        c = mix(c, SNOW, smoothstep(0.7, 0.82, e));
        // Hillshade on the drawn surface, lit from the north-west like the
        // renderer's sun.
        const gx = surface(x + step, y) - surface(x - step, y);
        const gy = surface(x, y + step) - surface(x, y - step);
        const shade = clamp(1 - (2.4 / step) * (gx + gy), 0.6, 1.3);
        c = [c[0] * shade, c[1] * shade, c[2] * shade];
        const sea = (dx, dy) => elevation[clamp(cy + dy, 0, N - 1) * N + clamp(cx + dx, 0, N - 1)] <= 0;
        const r = Math.max(1, Math.round(scale * 0.75));
        if (sea(r, 0) || sea(-r, 0) || sea(0, r) || sea(0, -r)) c = mix(c, INK, 0.65);
      }
      // The map's own edge, where the picture runs past it: a thin rule, so
      // land that reaches the border reads as the edge of the chart.
      if (beyond > 0 && beyond <= scale * 1.1) c = mix(c, INK, 0.55);
      const o = (py * width + px) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }
  return out;
}
