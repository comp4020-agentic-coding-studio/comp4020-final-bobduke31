// The Forge: a seeded world generator. One pure module, used by the browser
// for the live preview and by the server (src/forge.ts) to build the stored
// map - so what you previewed is what you get, and the server never has to
// trust cells sent by a client. No DOM, no Math.random: everything comes
// from the seed, so the same (seed, settings) is the same world, bit for bit,
// in Node 24 and in any browser.
//
// Techniques, adapted rather than copied (see CREDITS.md):
//  - Azgaar's Fantasy Map Generator (MIT): a heightmap composed from
//    "Hill" masses and "Range" ridges walked between two points with some
//    wandering. His blob/front growth is replaced by true distances here:
//    it suits his jittered Voronoi mesh, but bands visibly on a grid.
//  - Red Blob Games, "Making maps with noise": fBm octaves, an edge mask
//    that keeps land off the map border, and domain warping for coasts.
//  - Olsen 2004, "Realtime procedural terrain generation": thermal (talus)
//    erosion, a few cheap passes so slopes settle to plausible angles.
//
// Output is in the stored model's units: elevation -1..1, sea level 0, and
// heights calibrated to what the renderer draws (terrain-fields.js): plains
// sit around 0.04-0.30 (drawn as gentle lowland), hills climb into the
// mountain band at 0.42, and ranges reach 0.6-0.9 (rock, then snow).
import { createNoise2D } from "./vendor/simplex-noise.js";

export const FORGE_SIZE = 256;
export const TEMPLATES = ["continent", "archipelago", "coast", "blank"];

// Plain-language ranges for the sliders, each 0..1. The server clamps
// whatever it's sent into these, so a request can't ask for anything the
// sliders couldn't.
export const DEFAULT_SETTINGS = { land: 0.5, mountains: 0.5, forest: 0.5 };

const SEA_FLOOR = -0.55;

// sfc32 (public domain, bryc/code PRNGs.md): small, fast, well-distributed,
// and pure integer maths, so it's identical in every JS engine.
function sfc32(a, b, c, d) {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

// A seed is any string ("Saltmere", "41227"); hashed to four 32-bit words.
function rngFor(seed, salt) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  const s = `${seed}\u0000${salt}`;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  const rng = sfc32(h1, h2, h3, h4);
  for (let i = 0; i < 12; i++) rng(); // warm up
  return rng;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

function fbm(noise, x, y, octaves, freq) {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// --- Azgaar-style features -------------------------------------------------
// Heights here are 0..1 "uplift" added to a base, before calibration.

// A hill: Azgaar's blob idea - a raised mass that fades outward - but as a
// smooth radial bump with a noise-warped radius rather than his grown
// front. His growth works on a jittered Voronoi mesh; on a square grid the
// front's shape shows through as diagonal banding and slivers of land.
function addHill(h, noise, cx, cy, height, radius) {
  const N = FORGE_SIZE;
  const r = Math.ceil(radius * 1.6);
  for (let y = Math.max(0, cy - r); y < Math.min(N, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x < Math.min(N, cx + r); x++) {
      const dx = x - cx, dy = y - cy;
      const a = Math.atan2(dy, dx);
      // The radius varies with direction, so outlines are lobed, not round.
      const wobble = 1 + 0.35 * noise(Math.cos(a) * 1.3 + cx * 0.05, Math.sin(a) * 1.3 + cy * 0.05);
      const d = Math.hypot(dx, dy) / (radius * wobble);
      if (d >= 1) continue;
      const t = 1 - d * d;
      h[y * N + x] += height * t * t;
    }
  }
}

// A range: a ridge walked from start to end with some wandering, then
// height spread outward from the ridge front by front, falling with each
// step - so a range has a spine and flanks rather than being a chain of
// bumps. Spurs run downhill from the spine every few cells.
function addRange(h, rng, ridgeNoise, x0, y0, x1, y1, height, width) {
  const N = FORGE_SIZE;
  const ridge = [];
  let x = x0, y = y0;
  const seen = new Set();
  for (let guard = 0; guard < N * 4; guard++) {
    ridge.push(y * N + x);
    seen.add(y * N + x);
    if (Math.abs(x - x1) <= 1 && Math.abs(y - y1) <= 1) break;
    let best = -1, bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 1 || ny < 1 || nx >= N - 1 || ny >= N - 1 || seen.has(ny * N + nx)) continue;
        let d = (nx - x1) ** 2 + (ny - y1) ** 2;
        if (rng() < 0.22) d /= 2; // wander
        if (d < bestD) { bestD = d; best = ny * N + nx; }
      }
    }
    if (best < 0) break;
    x = best % N; y = (best / N) | 0;
  }
  // Height falls off with distance from the ridge line (Azgaar spreads it
  // front by front; on a square grid that bands, so this measures true
  // distance instead), cross-cut by ridged noise so the flanks break into
  // spurs and valleys rather than a smooth tent.
  const level = new Float32Array(N * N);
  const reach = Math.ceil(width * 2.2);
  const step = Math.max(1, Math.floor(ridge.length / 120));
  for (let k = 0; k < ridge.length; k += step) {
    const rx = ridge[k] % N, ry = (ridge[k] / N) | 0;
    // Each ridge point has its own height: summits and saddles along the spine.
    const crest = height * (0.7 + 0.45 * (0.5 + 0.5 * ridgeNoise(rx * 0.05, ry * 0.05)));
    for (let y = Math.max(0, ry - reach); y < Math.min(N, ry + reach); y++) {
      for (let x = Math.max(0, rx - reach); x < Math.min(N, rx + reach); x++) {
        const d = Math.hypot(x - rx, y - ry) / width;
        if (d >= 2.2) continue;
        const v = crest * Math.exp(-d * d * 0.9);
        const i = y * N + x;
        if (v > level[i]) level[i] = v;
      }
    }
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (!level[i]) continue;
      const r = 1 - Math.abs(ridgeNoise(x * 0.07, y * 0.07));
      level[i] *= 0.62 + 0.5 * r * r;
    }
  }
  // Max, not sum: where ranges cross they meet at a knot of peaks rather
  // than stacking into a plateau.
  for (let i = 0; i < h.length; i++) if (level[i] > h[i]) h[i] = level[i];
  return ridge;
}

// --- Erosion -----------------------------------------------------------------
// Thermal (talus) erosion, Olsen 2004: wherever a cell is higher than its
// lowest neighbour by more than `talus`, move part of the excess down. A
// few passes settle needle peaks and cliffs into slopes that read as rock.
function thermalErode(h, passes, talus, rate) {
  const N = FORGE_SIZE;
  for (let p = 0; p < passes; p++) {
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        let low = i, lowH = h[i];
        for (const n of [i - 1, i + 1, i - N, i + N]) if (h[n] < lowH) { lowH = h[n]; low = n; }
        const d = h[i] - lowH;
        if (d > talus) {
          const move = rate * (d - talus) * 0.5;
          h[i] -= move;
          h[low] += move;
        }
      }
    }
  }
}

function blur(h, passes) {
  const N = FORGE_SIZE;
  const tmp = new Float32Array(N * N);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= N) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= N) continue;
            s += h[yy * N + xx];
            c++;
          }
        }
        tmp[y * N + x] = s / c;
      }
    }
    h.set(tmp);
  }
}

// Small enclosed patches of "sea" inside land are pits in the noise, not
// lakes anyone drew: raise them to just above sea level. Patches connected
// to the map edge are real sea; large enclosed ones are kept as lakes.
function fillPits(h, sea) {
  const N = FORGE_SIZE;
  const label = new Int32Array(N * N).fill(-1);
  const LAKE_MIN = 220;
  for (let start = 0; start < N * N; start++) {
    if (label[start] !== -1 || h[start] > sea) continue;
    const stack = [start], cells = [];
    label[start] = start;
    let edge = false;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const x = c % N, y = (c / N) | 0;
      if (x === 0 || y === 0 || x === N - 1 || y === N - 1) edge = true;
      for (const n of [x > 0 ? c - 1 : -1, x < N - 1 ? c + 1 : -1, y > 0 ? c - N : -1, y < N - 1 ? c + N : -1]) {
        if (n >= 0 && label[n] === -1 && h[n] <= sea) { label[n] = start; stack.push(n); }
      }
    }
    if (!edge && cells.length < LAKE_MIN) for (const c of cells) h[c] = sea + 0.004;
  }
}

// Distance in cells from every cell to the nearest cell where `isSource`
// (two-pass chamfer, 1 / sqrt 2 weights: within a few percent of true
// Euclidean distance, which is plenty for placing ranges and shelves).
function distanceField(isSource) {
  const N = FORGE_SIZE;
  const d = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) d[i] = isSource(i) ? 0 : 1e9;
  const D = Math.SQRT2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
    if (y > 0) d[i] = Math.min(d[i], d[i - N] + 1);
    if (x > 0 && y > 0) d[i] = Math.min(d[i], d[i - N - 1] + D);
    if (x < N - 1 && y > 0) d[i] = Math.min(d[i], d[i - N + 1] + D);
  }
  for (let y = N - 1; y >= 0; y--) for (let x = N - 1; x >= 0; x--) {
    const i = y * N + x;
    if (x < N - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
    if (y < N - 1) d[i] = Math.min(d[i], d[i + N] + 1);
    if (x < N - 1 && y < N - 1) d[i] = Math.min(d[i], d[i + N + 1] + D);
    if (x > 0 && y < N - 1) d[i] = Math.min(d[i], d[i + N - 1] + D);
  }
  return d;
}

// The level such that `fraction` of cells are above it.
function quantile(h, fraction) {
  const sorted = Float32Array.from(h).sort();
  return sorted[clamp(Math.floor((1 - fraction) * (sorted.length - 1)), 0, sorted.length - 1)];
}

// --- Templates ------------------------------------------------------------------
// Each returns raw uplift (any scale); land is chosen afterwards by quantile,
// so the Land slider means "this share of the map is land" for every
// template, rather than a threshold that behaves differently per shape.

function landShape(template, seed, s) {
  const N = FORGE_SIZE;
  const rng = rngFor(seed, "shape");
  const noise = createNoise2D(rngFor(seed, "noise"));
  const warpN = createNoise2D(rngFor(seed, "warp"));
  const h = new Float32Array(N * N);

  // Large-scale form from overlapping hills.
  const hills = { continent: 9, archipelago: 26, coast: 8 }[template];
  for (let k = 0; k < hills; k++) {
    let cx, cy;
    if (template === "coast") {
      cx = Math.floor(N * (0.05 + 0.32 * rng()));
      cy = Math.floor(N * (0.05 + 0.9 * rng()));
    } else if (template === "continent") {
      cx = Math.floor(N * (0.25 + 0.5 * rng()));
      cy = Math.floor(N * (0.25 + 0.5 * rng()));
    } else {
      cx = Math.floor(N * (0.12 + 0.76 * rng()));
      cy = Math.floor(N * (0.12 + 0.76 * rng()));
    }
    const radius = N * (template === "archipelago" ? 0.05 + 0.07 * rng() : 0.14 + 0.12 * rng());
    addHill(h, noise, cx, cy, 0.7 + 0.3 * rng(), radius);
  }
  if (template === "coast") {
    // A broad westward rise, so the coast runs roughly north-south.
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) h[y * N + x] += 1.6 * (1 - smoothstep(0.2, 0.7, x / N));
  }

  // Warped fBm detail: what turns a smooth blob outline into bays,
  // headlands and islets.
  let max = 0;
  for (const v of h) max = Math.max(max, v);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const wx = x + 18 * fbm(warpN, x, y, 3, 0.01);
      const wy = y + 18 * fbm(warpN, x + 97, y + 31, 3, 0.01);
      const detail = fbm(noise, wx, wy, 5, 0.016);
      h[y * N + x] = h[y * N + x] / max + (template === "archipelago" ? 0.34 : 0.24) * detail;
    }
  }

  // Edge mask (Red Blob's square bump): land fades out before the border,
  // except on the coast template's land side.
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const nx = (2 * x) / N - 1, ny = (2 * y) / N - 1;
      let edge = (1 - nx * nx) * (1 - ny * ny);
      if (template === "coast") edge = 1 - ny ** 8 - Math.max(0, nx) ** 6;
      h[y * N + x] -= 0.9 * (1 - smoothstep(0, 0.35, edge));
    }
  }
  blur(h, 1);
  return { h, rng, noise };
}

// --- Main entry ------------------------------------------------------------------

export function normaliseSettings(settings = {}) {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const v = Number(settings[k]);
    out[k] = Number.isFinite(v) ? clamp(v, 0, 1) : DEFAULT_SETTINGS[k];
  }
  return out;
}

// Returns { elevation: Float32Array(N*N), types: Uint8Array(N*N) } where
// types index TERRAIN_TYPES (0 grassland, 1 sand, 2 forest, 3 rock).
export function forgeWorld(seed, template, rawSettings) {
  const N = FORGE_SIZE;
  const settings = normaliseSettings(rawSettings);
  const elevation = new Float32Array(N * N);
  const types = new Uint8Array(N * N);
  if (template === "blank" || !TEMPLATES.includes(template)) {
    elevation.fill(-0.3);
    return { elevation, types };
  }

  const { h, rng, noise } = landShape(template, String(seed), settings);
  const landShare = { continent: 0.3, archipelago: 0.18, coast: 0.32 }[template] + 0.3 * (settings.land - 0.5);
  let sea = quantile(h, clamp(landShare, 0.06, 0.7));
  // Coastal detail: finer warped noise that only acts near the shoreline,
  // so the outline breaks into headlands, coves and islets while the
  // interior keeps its broad shape.
  const coastN = createNoise2D(rngFor(seed, "coast"));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const near = 1 - smoothstep(0, 0.16, Math.abs(h[i] - sea));
      if (near > 0) h[i] += near * 0.11 * fbm(coastN, x, y, 4, 0.05);
    }
  }
  sea = quantile(h, clamp(landShare, 0.06, 0.7));
  fillPits(h, sea);
  let top = 0;
  for (const v of h) top = Math.max(top, v);

  // Distance to the sea (for land) and to land (for sea), in cells.
  const inland = distanceField((i) => h[i] <= sea);
  const offshore = distanceField((i) => h[i] > sea);

  // Land: a gentle lowland ramp from the coast inland - most land stays
  // below the mountain band, so plains read as plains. Sea: a shallow shelf
  // along every coast that falls away to deep water, rather than depth
  // following the raw noise (which left a square halo of shallows where the
  // edge mask flattened it).
  const shelfN = createNoise2D(rngFor(seed, "shelf"));
  for (let i = 0; i < N * N; i++) {
    const v = h[i] - sea;
    if (v > 0) {
      elevation[i] = 0.035 + 0.22 * Math.pow(v / (top - sea), 0.9);
    } else {
      const x = i % N, y = (i / N) | 0;
      const shelf = 10 + 8 * shelfN(x * 0.02, y * 0.02);
      elevation[i] = -0.02 - (-SEA_FLOOR - 0.02) * smoothstep(0, shelf * 2.4, offshore[i]) + 0.4 * Math.min(0, v);
      elevation[i] = Math.max(SEA_FLOOR, elevation[i]);
    }
  }

  let deepest = 0;
  for (const v of inland) if (v < 1e9) deepest = Math.max(deepest, v);

  // Mountain ranges. Each one runs between two well-inland points, so it
  // follows the land rather than walking out to sea. Count and height
  // follow the Mountains slider: 0 gives rolling hills, 1 alpine ranges.
  const uplift = new Float32Array(N * N);
  const ridgeN = createNoise2D(rngFor(seed, "ridge"));
  const interior = [];
  const minInland = Math.max(2.5, deepest * (template === "archipelago" ? 0.3 : 0.18));
  for (let i = 0; i < N * N; i++) if (inland[i] >= minInland) interior.push(i);
  const ranges = interior.length > 20 ? Math.round(1 + settings.mountains * ({ continent: 6, archipelago: 7, coast: 5 }[template])) : 0;
  const rangeHeight = 0.1 + 0.8 * settings.mountains;
  // Ranges spread across the land (farthest-point sampling over their
  // spines), rather than all piling into the single most-inland spot.
  const spines = [];
  const pick = (score) => {
    let best = -1, bestScore = -Infinity;
    for (let t = 0; t < 32; t++) {
      const c = interior[Math.floor(rng() * interior.length)];
      const sc = score(c);
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
    return best;
  };
  const awayFromSpines = (c) => {
    let m = N;
    const cx = c % N, cy = (c / N) | 0;
    for (let k = 0; k < spines.length; k += 3) m = Math.min(m, Math.hypot((spines[k] % N) - cx, ((spines[k] / N) | 0) - cy));
    return m;
  };
  for (let k = 0; k < ranges; k++) {
    const a = pick((c) => awayFromSpines(c) + 0.25 * inland[c]);
    const ax = a % N, ay = (a / N) | 0;
    const want = N * (template === "archipelago" ? 0.07 : 0.22) * (0.7 + 0.6 * rng());
    // The far end: long enough to be a range, short enough to stay on land.
    const best = pick((c) => {
      const d = Math.hypot((c % N) - ax, ((c / N) | 0) - ay);
      return d > 5 ? -Math.abs(d - want) + 0.3 * inland[c] + 0.3 * Math.min(awayFromSpines(c), 30) : -Infinity;
    });
    if (best < 0) continue;
    const width = (template === "archipelago" ? 3 : 4.5) + 4 * rng();
    spines.push(...addRange(uplift, rng, ridgeN, ax, ay, best % N, (best / N) | 0, rangeHeight * (0.75 + 0.5 * rng()), width));
  }
  // Islands too small to hold an interior range still get a summit: a peak
  // on each island's most inland point, sized to the island.
  if (template === "archipelago") {
    const done = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) {
      if (done[i] || h[i] <= sea) continue;
      const stack = [i];
      let top = i, size = 0;
      done[i] = 1;
      while (stack.length) {
        const c = stack.pop();
        size++;
        if (inland[c] > inland[top]) top = c;
        const x = c % N;
        for (const n of [x > 0 ? c - 1 : -1, x < N - 1 ? c + 1 : -1, c - N, c + N]) {
          if (n >= 0 && n < N * N && !done[n] && h[n] > sea) { done[n] = 1; stack.push(n); }
        }
      }
      if (size < 120) continue;
      const r = Math.min(inland[top] * 1.3, 16);
      const tx = top % N, ty = (top / N) | 0;
      addRange(uplift, rng, ridgeN, tx, ty, clamp(tx + Math.round((rng() - 0.5) * r), 1, N - 2), clamp(ty + Math.round((rng() - 0.5) * r), 1, N - 2),
        rangeHeight * Math.min(1, size / 1500) * (0.8 + 0.3 * rng()), Math.max(2.5, r * 0.35));
    }
  }
  // Foothills and uplands: ridged noise rising with distance inland and with
  // the Mountains slider, so the ground between ranges rolls rather than
  // lying flat, and ranges have shoulders to stand on.
  const hillN = createNoise2D(rngFor(seed, "hills"));
  for (let i = 0; i < N * N; i++) {
    if (h[i] <= sea) continue;
    const x = i % N, y = (i / N) | 0;
    const r = 1 - Math.abs(fbm(hillN, x, y, 4, 0.03));
    uplift[i] += (0.04 + 0.16 * settings.mountains) * r * r * smoothstep(2, 22, inland[i]);
  }
  blur(uplift, 1);
  // Ranges fade out toward the coast so mountains don't stand in the sea.
  for (let i = 0; i < N * N; i++) {
    if (elevation[i] <= 0) continue;
    let e = elevation[i] + uplift[i] * smoothstep(1, 9, inland[i]);
    // Summits ease toward the cap instead of being cut off at it, so high
    // ranges keep their peaks and saddles rather than flat white tables.
    if (e > 0.62) e = 0.62 + 0.3 * Math.tanh((e - 0.62) / 0.22);
    elevation[i] = e;
  }
  thermalErode(elevation, 10, 0.03, 0.5);
  for (let i = 0; i < N * N; i++) {
    // Keep land land and sea sea through erosion (it moves material across
    // the coast otherwise), and cap at the renderer's snow line.
    elevation[i] = h[i] > sea ? clamp(elevation[i], 0.02, 0.92) : clamp(elevation[i], SEA_FLOOR, -0.02);
  }

  // Materials. Moisture is its own noise field; forests take the wetter
  // lowland and lower slopes (thinning with the Forest slider), sand the
  // dry low coast, rock the steep high ground the renderer doesn't already
  // turn rocky by height.
  const moistN = createNoise2D(rngFor(seed, "moisture"));
  const forestCut = 0.62 - 0.5 * (settings.forest - 0.5);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const e = elevation[i];
      if (e <= 0) continue;
      // Broad wet and dry regions, broken up at a finer scale so forests
      // come as stands and woods with clearings, not one solid mass.
      const moist = 0.5 + 0.5 * (0.6 * fbm(moistN, x, y, 3, 0.012) + 0.4 * fbm(moistN, x + 311, y - 173, 3, 0.05));
      const nearSea =
        (x > 0 && elevation[i - 1] <= 0) || (x < N - 1 && elevation[i + 1] <= 0) ||
        (y > 0 && elevation[i - N] <= 0) || (y < N - 1 && elevation[i + N] <= 0);
      if (e < 0.07 && moist < 0.42 && (nearSea || noise(x * 0.09, y * 0.09) > 0.35)) types[i] = 1;
      else if (e < 0.6 && moist > forestCut - 0.25 * smoothstep(0.1, 0.45, e)) types[i] = 2;
    }
  }
  return { elevation, types };
}

// A small colour preview (RGBA, size x size), for the dialog: the same
// palette family as the renderer, flat-shaded with a simple hillshade so
// relief reads. Only a preview - the editor's own renderer draws the map.
export function previewPixels({ elevation, types }, size) {
  const N = FORGE_SIZE;
  const out = new Uint8ClampedArray(size * size * 4);
  const lerp3 = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
  const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  // Base colours from terrain-renderer-3d.js's ground shader.
  const SHALLOW = hex("#6ec3c6"), MID = hex("#2f8fae"), DEEP = hex("#1c5c86");
  const GRASS = hex("#86a848"), SAND = hex("#e0cc9a"), FOREST = hex("#2a4a21");
  const ROCK = hex("#9e8c76"), SNOW = hex("#f3f1ea"), INK = hex("#3b2f24");
  // Bilinear sample, so the preview isn't blocky when drawn larger than
  // FORGE_SIZE / size.
  const at = (fx, fy) => {
    const x0 = clamp(Math.floor(fx), 0, N - 1), y0 = clamp(Math.floor(fy), 0, N - 1);
    const x1 = Math.min(N - 1, x0 + 1), y1 = Math.min(N - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const e = (x, y) => elevation[y * N + x];
    return (e(x0, y0) * (1 - tx) + e(x1, y0) * tx) * (1 - ty) + (e(x0, y1) * (1 - tx) + e(x1, y1) * tx) * ty;
  };
  const k = N / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const fx = (px + 0.5) * k - 0.5, fy = (py + 0.5) * k - 0.5;
      const e = at(fx, fy);
      const i = clamp(Math.round(fy), 0, N - 1) * N + clamp(Math.round(fx), 0, N - 1);
      let c;
      if (e <= 0) {
        const t = clamp(-e / 0.5, 0, 1);
        c = t < 0.35 ? lerp3(SHALLOW, MID, t / 0.35) : lerp3(MID, DEEP, (t - 0.35) / 0.65);
      } else {
        const t = types[i];
        c = t === 1 ? SAND : t === 2 ? FOREST : t === 3 ? ROCK : GRASS;
        c = lerp3(c, ROCK, smoothstep(0.4, 0.6, e));
        c = lerp3(c, SNOW, smoothstep(0.7, 0.82, e));
        // Hillshade lit from the north-west, as the renderer's sun.
        const ex = at(fx + k, fy) - at(fx - k, fy);
        const ey = at(fx, fy + k) - at(fx, fy - k);
        const shade = clamp(1 - (3.2 / k) * (ex + ey), 0.62, 1.3);
        c = c.map((v) => v * shade);
        // The ink coastline.
        if (at(fx + k, fy) <= 0 || at(fx - k, fy) <= 0 || at(fx, fy + k) <= 0 || at(fx, fy - k) <= 0) c = lerp3(c, INK, 0.7);
      }
      const o = (py * size + px) * 4;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
    }
  }
  return out;
}
