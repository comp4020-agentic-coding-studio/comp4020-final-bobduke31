// The map renderer for BOTH views: one real heightfield mesh (Three.js,
// vendored MIT, vendor/three/), drawn by an orthographic camera that is
// either straight overhead ("Top-down") or inclined and rotatable
// ("Oblique"). See CLAUDE.md's "Reuse before you build" and ROADMAP.md's
// "Terrain & visual overhaul" for why the two views now share one pipeline:
// the old Top-down was a separate CPU canvas renderer with its own palette,
// its own noise, its own light direction and no cast shadows, so the two
// views could never look like the same map no matter how either was tuned.
// The CPU canvas renderer (terrain-renderer.js) remains only as the fallback
// for browsers without WebGL2.
//
// Everything *derived* from the stored grids - the smooth surface, the
// synthesised ridges, the material boundaries, the coast distance field - is
// defined once in terrain-fields.js (JS + an identical GLSL twin), so tree
// placement and picking on the CPU agree exactly with what the GPU draws.
import * as THREE from "./vendor/three/three.module.js";
import { GLTFLoader } from "./vendor/three/GLTFLoader.js";
import { GRID_SIZE, ELEVATION_MIN, ELEVATION_MAX, SEA_LEVEL, TERRAIN_TYPES } from "./terrain-model.js";
import {
  HEIGHT_SCALE,
  TERRAIN_FIELDS_GLSL,
  COAST_SDF_RES,
  SURFACE_RES,
  bsplineSample,
  bakeSurface,
  sampleSurface,
  mountainMask,
  snoise,
  buildTypeWeights,
  paintedMaterialAt,
  computeCoastSDF,
  footprintWeight,
  footprintBounds,
  setFoundationLevels,
  levelFootprints,
  SURFACE_STEP,
} from "./terrain-fields.js";

export { HEIGHT_SCALE };

// Visual-mesh density: two vertices per authoritative cell, so the
// synthesised ridges (finest octave ~2.3 cells) read as real geometry.
const MESH_SEGMENTS = 510;

export function isWebGL2Available() {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2");
  } catch {
    return false;
  }
}

// --- Ground shader -------------------------------------------------------
// Patched into Three's own MeshLambertMaterial (onBeforeCompile) rather than
// a from-scratch ShaderMaterial, so the ground gets Three's real lights and
// shadow maps - the previous ShaderMaterial did its own lighting and never
// received a shadow, which is half of why mountains read as flat cut-outs.

const GROUND_VERTEX_PARS = /* glsl */ `
  ${TERRAIN_FIELDS_GLSL}
  varying vec2 vCell;
  varying float vDisplayHeight;
  varying vec3 vTerrainNormal;

  float displayedHeightAt(vec2 cell) { return surfaceHeight(cell); }
`;

// Runs in place of <beginnormal_vertex>, which Three's chunk order puts
// before <begin_vertex> - the normal must exist before the position does.
// Positions are flattened to SEA_LEVEL over the sea: water is drawn by the
// ground shader itself (colour from depth and coast distance), not by a
// second transparent plane, so there is no coastal cliff, no z-fighting and
// no seam between the two.
const GROUND_BEGIN_VERTEX = /* glsl */ `
  vec2 cellPos = vec2(position.x, position.z);
  float hC = displayedHeightAt(cellPos);
  float nEps = 0.5;
  float hL = displayedHeightAt(cellPos - vec2(nEps, 0.0));
  float hR = displayedHeightAt(cellPos + vec2(nEps, 0.0));
  float hD = displayedHeightAt(cellPos - vec2(0.0, nEps));
  float hU = displayedHeightAt(cellPos + vec2(0.0, nEps));
  vTerrainNormal = normalize(vec3(-(hR - hL) * ${HEIGHT_SCALE.toFixed(2)}, 2.0 * nEps, -(hU - hD) * ${HEIGHT_SCALE.toFixed(2)}));
  vCell = cellPos;
  vDisplayHeight = hC;
  vec3 objectNormal = vTerrainNormal;
`;

const DEPTH_VERTEX_PARS = /* glsl */ `
  ${TERRAIN_FIELDS_GLSL}
  float displayedHeightAt(vec2 cell) { return surfaceHeight(cell); }
`;

const DEPTH_BEGIN_VERTEX = /* glsl */ `
  vec3 transformed = vec3(position.x, displayedHeightAt(vec2(position.x, position.z)) * ${HEIGHT_SCALE.toFixed(2)}, position.z);
`;

// Palette: warm, saturated painted-cartography colours picked against
// research/roadmap/references/reference-painted-mountains-clouds.png (sRGB
// hex, converted to linear for lighting).
function srgb(hex) {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
}

const GROUND_FRAGMENT_PARS = /* glsl */ `
  ${TERRAIN_FIELDS_GLSL}
  uniform sampler2D uCoastSDF;
  uniform sampler2D uGrassDetail;
  uniform float uDetailReady;
  varying vec2 vCell;
  varying float vDisplayHeight;
  varying vec3 vTerrainNormal;

  float coastDistance(vec2 cell) {
    return texture2D(uCoastSDF, (cell + 0.5) / uGridSize).r;
  }

  // Thin anti-aliased line at signed distance d == at, ~widthPx screen
  // pixels wide regardless of zoom (fwidth keeps it resolution-independent).
  float isoLine(float d, float at, float widthPx) {
    float px = abs(d - at) / max(fwidth(d), 1e-4);
    return 1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, px);
  }

  // Colour-variation noise comes from a small tileable noise texture (one
  // tap) rather than procedural simplex (~30 ALU ops per call): standard in
  // game terrain shaders, and it cut this shader's first-compile and
  // per-pixel cost by most of its weight (measured - ROADMAP.md). Only the
  // noise that decides *where* things are (material warp/heights, shared
  // with tree placement) stays procedural, so the CPU and GPU still agree.
  // Channels are four independent noise fields.
  uniform sampler2D uNoise;
  vec4 nz(vec2 p) { return texture2D(uNoise, p) * 2.0 - 1.0; }
  float fbm2(vec2 p) { vec4 a = nz(p * 0.25); return a.x * 0.65 + nz(p * 0.53 + 0.37).y * 0.35; }

  vec3 waterColor(vec2 cell, float seabed, float d) {
    float depth = clamp(-seabed / 0.6, 0.0, 1.0);
    float off = clamp(-d / 14.0, 0.0, 1.0);
    vec3 shallow = ${srgb("#6ec3c6")};
    vec3 mid = ${srgb("#2f8fae")};
    vec3 deep = ${srgb("#1c5c86")};
    float t = max(off * off * (3.0 - 2.0 * off), depth * 0.85);
    vec3 c = mix(shallow, mid, smoothstep(0.0, 0.35, t));
    c = mix(c, deep, smoothstep(0.3, 1.0, t));
    if (d < -9.0) return c * (0.93 + 0.07 * nz(cell * 0.009).z);
    // Soft painted "stains" in open water, like a watercolour wash.
    c *= 0.93 + 0.07 * nz(cell * 0.009).z;
    // Wonderdraft-style ripple lines parallel to the coast: the distance is
    // wobbled by noise so lines meander and occasionally merge, and each
    // line is broken into dashes that fade with distance - hand-drawn
    // strokes, not three rigid contour rings.
    // Wobble at a low frequency (long, gently meandering strokes); a
    // higher one read as scribbled squiggles once zoomed in.
    vec4 r = nz(cell * 0.018 + 0.3);
    float dw = d + 0.35 * r.x + 0.12 * nz(cell * 0.07).y;
    float ripples = 0.0;
    ripples += isoLine(dw, -1.5, 1.0) * 0.5 * smoothstep(-0.35, 0.15, r.y);
    ripples += isoLine(dw, -3.3, 0.9) * 0.32 * smoothstep(-0.1, 0.35, r.z);
    c = mix(c, ${srgb("#d6f0ea")}, ripples);
    // Pale foam where the water meets the shore.
    c = mix(c, ${srgb("#cfe9df")}, (1.0 - smoothstep(0.0, 0.9, -d)) * 0.55);
    return c;
  }

  vec3 grassColor(vec2 cell, vec4 broad, vec4 fine) {
    float meadow = smoothstep(0.15, 0.7, broad.y);
    vec3 c = mix(${srgb("#6f9a3f")}, ${srgb("#94b24f")}, 0.5 + 0.5 * broad.x);
    c = mix(c, ${srgb("#b5b85e")}, meadow * 0.45);
    c *= 0.94 + 0.06 * fine.x;
    if (uDetailReady > 0.5) {
      // Two scales of the painted texture, rotated against each other, so
      // its tile repeat doesn't show as a grid from far away.
      float lumA = dot(texture2D(uGrassDetail, cell / 5.0).rgb, vec3(0.33));
      float lumB = dot(texture2D(uGrassDetail, mat2(0.8, -0.6, 0.6, 0.8) * cell / 13.0).rgb, vec3(0.33));
      c *= 0.8 + 0.28 * lumA + 0.18 * lumB;
    }
    return c;
  }

  vec3 forestFloorColor(vec4 mid, vec4 fine) {
    vec3 c = mix(${srgb("#1f3a1c")}, ${srgb("#355a26")}, 0.5 + 0.5 * mid.x);
    return c * (0.9 + 0.1 * fine.y);
  }

  vec3 sandColor(vec4 mid, vec4 fine) {
    vec3 c = mix(${srgb("#d9c08a")}, ${srgb("#ecdcae")}, 0.5 + 0.5 * mid.z);
    return c * (0.96 + 0.04 * fine.z);
  }

  vec3 rockColor(vec2 cell, vec4 broad, vec4 fine, float h, float slope) {
    // Weathered rock: broad tonal patches plus fine streaks running
    // downhill. (Strata keyed to height alone drew concentric rings around
    // every summit - read as topographic contour lines, not rock.)
    float streaks = nz(vec2(cell.x * 0.22 + broad.w * 0.5, cell.y * 0.045)).w;
    vec3 c = mix(${srgb("#857462")}, ${srgb("#b8a48a")}, 0.5 + 0.35 * broad.z + 0.15 * streaks);
    c = mix(c, ${srgb("#d4c7b0")}, smoothstep(0.35, 0.8, h) * 0.5);
    c = mix(c, ${srgb("#6a5c4d")}, smoothstep(0.55, 0.95, slope) * 0.45);
    return c * (0.92 + 0.08 * fine.w);
  }

  vec3 terrainColor() {
    vec2 cell = vCell;
    float e = smoothElevation(cell);
    float d = coastDistance(cell);
    if (e <= ${SEA_LEVEL.toFixed(6)}) return waterColor(cell, e, d);

    vec3 n = normalize(vTerrainNormal);
    float slope = 1.0 - n.y;
    float h = vDisplayHeight;
    float m = mountainMask(e);
    vec4 heights = materialHeights(cell);
    vec4 w = heightBlend(paintedWeights(cell), heights);
    vec4 broad = nz(cell * 0.008);
    vec4 mid = nz(cell * 0.04 + 0.5);
    vec4 fine = nz(cell * 0.6 + 0.25);

    // Treeline: forest floor gives way on high ground.
    float treeline = smoothstep(0.35, 0.7, m);
    w.x += w.z * treeline;
    w.z *= 1.0 - treeline;

    // Automatic materials, keyed to the *shape* of the land rather than to
    // painted cells - the reason a mountain's rock and a beach's sand
    // follow the terrain instead of the brush's circular footprint. Folded
    // into the weights so each material's colour is computed at most once.
    float rockNoise = heights.w - 0.5;
    float autoRock = clamp(smoothstep(0.18, 0.42, slope + rockNoise * 0.25) * smoothstep(0.08, 0.3, m + rockNoise * 0.2)
                   + smoothstep(0.45, 0.85, m + rockNoise * 0.35), 0.0, 1.0);
    w = mix(w, vec4(0.0, 0.0, 0.0, 1.0), autoRock);
    float beachWidth = 1.3 + 1.1 * (0.5 + 0.5 * mid.w);
    float beach = (1.0 - smoothstep(beachWidth * 0.6, beachWidth, d)) * (1.0 - smoothstep(0.1, 0.16, h)) * (1.0 - smoothstep(0.2, 0.45, slope));
    w = mix(w, vec4(0.0, 1.0, 0.0, 0.0), beach);

    vec3 c = vec3(0.0);
    if (w.x > 0.001) c += grassColor(cell, broad, fine) * w.x;
    if (w.y > 0.001) c += sandColor(mid, fine) * w.y;
    if (w.z > 0.001) c += forestFloorColor(mid, fine) * w.z;
    if (w.w > 0.001) c += rockColor(cell, broad, fine, h, slope) * w.w;

    float snowLine = 0.62 + 0.08 * broad.w;
    float snow = smoothstep(snowLine, snowLine + 0.1, h) * (1.0 - smoothstep(0.5, 0.8, slope));
    c = mix(c, ${srgb("#f3f1ea")}, snow);

    // Ink coastline, hand-drawn weight variation.
    if (d < 3.0) c = mix(c, ${srgb("#3b2f24")}, isoLine(d, 0.0, 1.4 + 0.5 * mid.y) * 0.85);
    return c;
  }
`;

function patchGroundMaterial(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${GROUND_VERTEX_PARS}`)
      .replace("#include <beginnormal_vertex>", GROUND_BEGIN_VERTEX)
      .replace("#include <begin_vertex>", `vec3 transformed = vec3(position.x, vDisplayHeight * ${HEIGHT_SCALE.toFixed(2)}, position.z);`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GROUND_FRAGMENT_PARS}`)
      .replace("#include <color_fragment>", "diffuseColor.rgb = terrainColor();");
  };
}

function patchDepthMaterial(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${DEPTH_VERTEX_PARS}`)
      .replace("#include <begin_vertex>", DEPTH_BEGIN_VERTEX);
  };
}

function buildGroundGeometry() {
  const geometry = new THREE.PlaneGeometry(GRID_SIZE - 1, GRID_SIZE - 1, MESH_SEGMENTS, MESH_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  // Cell (0,0) at world (0,0), cell (N-1,N-1) at world (N-1,N-1) - the same
  // coordinate space as the authoritative grid, so picking needs no offset.
  geometry.translate((GRID_SIZE - 1) / 2, 0, (GRID_SIZE - 1) / 2);
  return geometry;
}

// Half-float (not full 32-bit float): a *filterable* (LINEAR) R32F texture
// needs `OES_texture_float_linear`, which iOS Safari/WebKit has never
// reliably supported on iPhone (inconsistent across iOS versions, and
// reported non-functional even when advertised) - sampling a non-filterable
// format with LINEAR filtering makes the texture "incomplete" per the WebGL2
// spec, so every `texture2D` read silently returns zero. That reads every
// cell as sea level, which is exactly the "terrain and water vanish, only
// trees remain" failure (trees are placed from the CPU's own Float32Array
// data, never through these textures). R16F is filterable in core WebGL2
// with no extension (MDN: `OES_texture_half_float_linear`'s functionality is
// built into WebGL2 by default), and its ~0.05% relative precision is far
// finer than the 8-bit quantization bug this renderer already fixed once
// (ROADMAP.md, "land/sea misclassification") - see `floatToHalf` below for
// the conversion from the CPU's full-precision Float32Array data.
function floatToHalf(src, dst) {
  for (let i = 0; i < src.length; i++) dst[i] = THREE.DataUtils.toHalfFloat(src[i]);
}

function createHeightTexture() {
  const texture = new THREE.DataTexture(
    new Uint16Array(GRID_SIZE * GRID_SIZE),
    GRID_SIZE,
    GRID_SIZE,
    THREE.RedFormat,
    THREE.HalfFloatType,
  );
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// One channel per terrain type (one-hot, 0 over the sea), linearly filtered:
// unlike a single type-index texture, weights *can* be meaningfully
// interpolated, which is what lets the shader B-spline-sample them into
// smooth boundaries instead of cell-shaped blocks.
function createTypeTexture() {
  const texture = new THREE.DataTexture(
    new Uint8Array(GRID_SIZE * GRID_SIZE * 4),
    GRID_SIZE,
    GRID_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// Takes its own half-float backing buffer, separate from the full-precision
// Float32Array (`surfaceData`) picking and tree placement read on the CPU -
// see `floatToHalf` above for why the GPU copy is downconverted.
function createSurfaceTexture() {
  const texture = new THREE.DataTexture(
    new Uint16Array(SURFACE_RES * SURFACE_RES),
    SURFACE_RES,
    SURFACE_RES,
    THREE.RedFormat,
    THREE.HalfFloatType,
  );
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// 256^2 RGBA tileable value noise (four independent channels), generated
// once at startup - no asset to ship. Tileable by wrapping the lattice.
function createNoiseTexture() {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  for (let c = 0; c < 4; c++) {
    const G = 32; // lattice cells per tile
    const lattice = new Float32Array(G * G);
    for (let i = 0; i < lattice.length; i++) lattice[i] = hashCell(i % G, Math.floor(i / G), 101 + c);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * G;
        const fy = (y / N) * G;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const ux = tx * tx * (3 - 2 * tx);
        const uy = ty * ty * (3 - 2 * ty);
        const at = (i, j) => lattice[(j % G) * G + (i % G)];
        const v = at(ix, iy) * (1 - ux) * (1 - uy) + at(ix + 1, iy) * ux * (1 - uy) + at(ix, iy + 1) * (1 - ux) * uy + at(ix + 1, iy + 1) * ux * uy;
        data[(y * N + x) * 4 + c] = Math.round(v * 255);
      }
    }
  }
  const texture = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// Same split as the surface texture: `data` (the coast SDF, in cells, range
// roughly ±64) is the full-precision CPU copy; the GPU gets its own
// half-float conversion.
function createCoastTexture() {
  const texture = new THREE.DataTexture(
    new Uint16Array(COAST_SDF_RES * COAST_SDF_RES),
    COAST_SDF_RES,
    COAST_SDF_RES,
    THREE.RedFormat,
    THREE.HalfFloatType,
  );
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function fillHeightTexture(texture, elevationGrid) {
  floatToHalf(elevationGrid, texture.image.data);
  texture.needsUpdate = true;
}

// `region` (cells, inclusive) limits the rewrite to what changed - a brush
// stroke touches a few hundred cells, not all 65k.
function fillTypeTexture(texture, elevationGrid, typeGrid, region) {
  const data = texture.image.data;
  const x0 = region ? Math.max(0, region.minX) : 0;
  const x1 = region ? Math.min(GRID_SIZE - 1, region.maxX) : GRID_SIZE - 1;
  const y0 = region ? Math.max(0, region.minY) : 0;
  const y1 = region ? Math.min(GRID_SIZE - 1, region.maxY) : GRID_SIZE - 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * GRID_SIZE + x;
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = data[i * 4 + 3] = 0;
      if (elevationGrid[i] > SEA_LEVEL) data[i * 4 + typeGrid[i]] = 255;
    }
  }
  texture.needsUpdate = true;
}

// Same one-hot weights as buildTypeWeights, updated in place for a region.
function updateTypeWeights(weights, elevationGrid, typeGrid, region) {
  for (let y = Math.max(0, region.minY); y <= Math.min(GRID_SIZE - 1, region.maxY); y++) {
    for (let x = Math.max(0, region.minX); x <= Math.min(GRID_SIZE - 1, region.maxX); x++) {
      const i = y * GRID_SIZE + x;
      for (let t = 0; t < weights.length; t++) weights[t][i] = 0;
      if (elevationGrid[i] > SEA_LEVEL) weights[typeGrid[i]][i] = 1;
    }
  }
}

// --- Trees --------------------------------------------------------------
// Real glTF meshes (KayKit Forest Nature Pack, CC0 - CREDITS.md), instanced.
// Placement is a deterministic function of the cell (hash-seeded, never
// Math.random), so every client grows the same trees with nothing sent over
// the network. Density follows the *rendered* forest-floor weight from
// terrain-fields.js, not the raw painted cells: trees thin out across the
// same organic boundary the shader draws, form clumps and glades from a
// clump-noise field, give way to grass at the treeline and the beach, and a
// few lone trees dot open grassland - instead of a uniform 22%-per-cell
// carpet clipped to the painted rectangle.
const TREE_MODEL_PATHS = [
  "/world/assets/kaykit-forest/Tree_1_A_Color1.gltf",
  "/world/assets/kaykit-forest/Tree_3_A_Color1.gltf",
];

const TREE_CHUNK = 16;
// Cells kept clear of trees around a place's footprint (a crown is ~1 cell
// in radius, so this keeps crowns off walls and roofs).
const TREE_CLEARANCE = 0.9;
const TREE_CHUNKS = GRID_SIZE / TREE_CHUNK;

function hashCell(x, y, salt) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(salt, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function sampleCoast(sdf, x, y) {
  const s = COAST_SDF_RES / GRID_SIZE;
  const px = Math.min(COAST_SDF_RES - 1, Math.max(0, Math.round((x + 0.5) * s - 0.5)));
  const py = Math.min(COAST_SDF_RES - 1, Math.max(0, Math.round((y + 0.5) * s - 0.5)));
  return sdf[py * COAST_SDF_RES + px];
}

function placeTreesInChunk(cx, cy, fields) {
  const { elevationGrid, typeWeights, coastSDF, surface, footprints = [] } = fields;
  const placements = [];
  // Places standing in or near this chunk: no tree grows through a house.
  const x0 = cx * TREE_CHUNK - 1;
  const y0 = cy * TREE_CHUNK - 1;
  const near = footprints.filter((f) => {
    const b = footprintBounds(f, TREE_CLEARANCE);
    return b.maxX >= x0 && b.minX <= x0 + TREE_CHUNK + 1 && b.maxY >= y0 && b.minY <= y0 + TREE_CHUNK + 1;
  });
  for (let y = cy * TREE_CHUNK; y < (cy + 1) * TREE_CHUNK; y++) {
    for (let x = cx * TREE_CHUNK; x < (cx + 1) * TREE_CHUNK; x++) {
      for (let k = 0; k < 2; k++) {
        const px = x + hashCell(x, y, 11 + k) - 0.5;
        const py = y + hashCell(x, y, 23 + k) - 0.5;
        const e = bsplineSample(elevationGrid, px, py);
        if (e <= 0.012) continue;
        const coast = sampleCoast(coastSDF, px, py);
        if (coast < 1.2) continue;
        const m = mountainMask(e);
        if (m > 0.55) continue;
        if (near.some((f) => footprintWeight(f, px, py, TREE_CLEARANCE) >= 1)) continue;
        // The hash roll is fixed per candidate, so test it against the best
        // chance this spot could possibly get before paying for the (much
        // costlier) material-field sample - most candidates stop here.
        const roll = hashCell(x, y, 37 + k);
        if (roll > 0.82) continue;
        const material = paintedMaterialAt(typeWeights, px, py);
        const clump = 0.5 + 0.5 * snoise(px * 0.11 + 31, py * 0.11 + 17);
        const forest = material[2] * (1 - m / 0.55);
        let chance = forest > 0.25 ? (0.32 + 0.5 * clump) * Math.min(1, (forest - 0.25) / 0.35) : 0;
        // Lone trees and copses in open grassland.
        const copse = snoise(px * 0.23 + 71, py * 0.23 + 5);
        chance += material[0] * (1 - m) * (copse > 0.72 ? 0.35 : 0.004);
        if (roll > chance) continue;
        const h = sampleSurface(surface, px, py);
        const edge = Math.min(1, Math.max(0.35, forest + 0.2));
        placements.push({
          x: px,
          y: h * HEIGHT_SCALE,
          z: py,
          // Conifers in stands, more of them uphill.
          variant: snoise(px * 0.05 + 3, py * 0.05 + 9) + m * 2.2 > 0.35 ? 1 : 0,
          scale: (0.42 + 0.2 * hashCell(x, y, 41 + k)) * (0.75 + 0.25 * edge),
          rotY: hashCell(x, y, 53 + k) * Math.PI * 2,
          tint: Math.pow(hashCell(x, y, 67 + k), 1.6) * (0.55 + 0.45 * clump),
        });
      }
    }
  }
  return placements;
}

function buildTreeLayer(scene, onLoaded) {
  const gltfLoader = new GLTFLoader();
  const meshes = TREE_MODEL_PATHS.map(() => null);
  const chunks = new Array(TREE_CHUNKS * TREE_CHUNKS).fill(null).map(() => []);
  const MAX_TREES = 24000;

  TREE_MODEL_PATHS.forEach((path, v) => {
    gltfLoader.load(path, (gltf) => {
      let geometry = null;
      let material = null;
      gltf.scene.traverse((obj) => {
        if (obj.isMesh && !geometry) {
          geometry = obj.geometry;
          material = obj.material;
          material.metalness = 0;
          material.roughness = 1;
        }
      });
      if (!geometry) return;
      const mesh = new THREE.InstancedMesh(geometry, material, MAX_TREES);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
      meshes[v] = mesh;
      writeInstances();
      onLoaded();
    });
  });

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scaleVec = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  // Multiplies the model's own green: dark blue-greens through olive to a
  // few autumn-tinged crowns, so a forest reads as many trees, not one
  // repeated sprite. Conifers (variant 1) are pushed darker below.
  const greens = [
    new THREE.Color("#7f9c6a"),
    new THREE.Color("#a9c27d"),
    new THREE.Color("#d4d98e"),
    new THREE.Color("#e3c27a"),
  ];

  function writeInstances() {
    const counts = [0, 0];
    for (const list of chunks) {
      for (const p of list) {
        const mesh = meshes[p.variant];
        if (!mesh || counts[p.variant] >= MAX_TREES) continue;
        const i = counts[p.variant]++;
        quaternion.setFromAxisAngle(up, p.rotY);
        position.set(p.x, p.y, p.z);
        scaleVec.setScalar(p.scale);
        matrix.compose(position, quaternion, scaleVec);
        mesh.setMatrixAt(i, matrix);
        const t = p.tint * (greens.length - 1);
        const j = Math.min(greens.length - 2, Math.floor(t));
        color.copy(greens[j]).lerp(greens[j + 1], t - j).multiplyScalar(p.variant === 1 ? 0.62 : 0.82);
        mesh.setColorAt(i, color);
      }
    }
    meshes.forEach((mesh, v) => {
      if (!mesh) return;
      mesh.count = counts[v];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }

  // region (cells, inclusive) limits the rebuild to chunks it can affect:
  // the material warp (~2.2 cells) + B-spline support (2 cells) + a margin.
  function rebuild(fields, region) {
    const pad = 5;
    const minCx = region ? Math.max(0, Math.floor((region.minX - pad) / TREE_CHUNK)) : 0;
    const maxCx = region ? Math.min(TREE_CHUNKS - 1, Math.floor((region.maxX + pad) / TREE_CHUNK)) : TREE_CHUNKS - 1;
    const minCy = region ? Math.max(0, Math.floor((region.minY - pad) / TREE_CHUNK)) : 0;
    const maxCy = region ? Math.min(TREE_CHUNKS - 1, Math.floor((region.maxY + pad) / TREE_CHUNK)) : TREE_CHUNKS - 1;
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) chunks[cy * TREE_CHUNKS + cx] = placeTreesInChunk(cx, cy, fields);
    }
    writeInstances();
  }

  return { rebuild, count: () => chunks.reduce((n, list) => n + list.length, 0) };
}

// --- Places (map objects, stage B) ----------------------------------------
// Cottages, castles and the rest, from the CC0 KayKit Medieval Hexagon Pack
// (CREDITS.md) - the same family and lighting as the trees. Each place
// stands on a levelled foundation (terrain-fields.js levelFootprints): the
// ground under its footprint is flattened into the displayed surface, so it
// never floats on a slope or sinks into a hillside, and trees grow around
// it, not through it. Models load on first use, so a map with no places
// costs nothing and draws exactly as before.
export const OBJECT_MODELS = {
  // `size` is the model's widest footprint in cells, set against the trees
  // (a crown is ~2 cells): a cottage a little over a tree, a castle the
  // heart of a village rather than a district of its own. `foot` is the
  // half-extent of the ground it stands on, [across, along] at rotation 0,
  // measured from the model. `pad: false` places (a bridge) span water or a
  // gap and don't level the ground. `flat` places (a field, a bridge) lie
  // on the ground in Chart view rather than standing up as a symbol.
  cottage: { file: "building_home_A_yellow", size: 2.6, foot: [1.21, 1.3] },
  house: { file: "building_home_B_red", size: 3.0, foot: [1.2, 1.5] },
  church: { file: "building_church_red", size: 3.6, foot: [1.58, 1.8] },
  windmill: { file: "building_windmill_red", size: 3.4, foot: [1.7, 1.19] },
  well: { file: "building_well_red", size: 1.5, foot: [0.64, 0.75] },
  farm: { field: true, size: 5.0, foot: [2.5, 1.75], flat: true },
  tower: { file: "building_tower_A_red", size: 3.0, foot: [1.24, 1.5] },
  castle: { file: "building_castle_red", size: 6.0, foot: [2.63, 3.0] },
  wall: { file: "wall_straight", size: 4.0, foot: [2.0, 0.6] },
  // The bridge's piers reach 1 model unit below its deck (to stand in a
  // hex river tile): sink them, so the deck sits at the ground it spans.
  bridge: { file: "building_bridge_A", size: 4.5, foot: [1.57, 2.25], pad: false, sink: 0.9, flat: true },
  ruins: { file: "building_destroyed", size: 3.0, foot: [1.5, 1.27] },
};
const OBJECT_DIR = "/world/assets/kaykit-medieval/";

// The farm field. The pack's only field (building_grain) is a hexagonal
// board-game tile, which read as a hex grid pasted on the map - the look
// this project steers away from. No CC0 square field in a matching style
// was found (Kenney's Nature Kit crops are single plants on dirt strips at
// a different scale), so this is built from the pack's own palette: tilled
// earth with rows of ripe wheat, in the same flat-shaded low-poly register,
// sampled from hexagons_medieval.png (#e2b052 wheat; the earth, #9a6a3a,
// is darkened from its #af692d).
function buildFieldModel(size, foot) {
  const group = new THREE.Group();
  const w = foot[0] * 2;
  const d = foot[1] * 2;
  const flat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, flatShading: true });
  const earth = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), flat("#9a6a3a"));
  earth.position.y = 0.06;
  group.add(earth);
  const rows = Math.max(3, Math.round(d / 0.55));
  const rowDepth = (d / rows) * 0.62;
  const wheat = [flat("#e2b052"), flat("#d9a44a"), flat("#eabb58")];
  for (let r = 0; r < rows; r++) {
    // Slightly uneven ridges, so the field isn't a ruled pattern.
    const h = 0.26 + 0.06 * Math.sin(r * 2.3 + 1.1);
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, h, rowDepth), wheat[r % wheat.length]);
    ridge.position.set(0, 0.12 + h / 2, -d / 2 + (r + 0.5) * (d / rows));
    group.add(ridge);
  }
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return group;
}

// The ground a place stands on, in the shape levelFootprints() reads.
function footprintOf(data) {
  const model = OBJECT_MODELS[data.kind];
  if (!model || model.pad === false) return null;
  return {
    x: data.x,
    y: data.y,
    hx: model.foot[0] * data.scale,
    hz: model.foot[1] * data.scale,
    // Three.js turns the node by -rotation about +y; in map (x, y) that is
    // a turn by +rotation.
    rot: data.rotation,
    level: 0,
  };
}

function buildObjectLayer(scene, onChange, onFootprints) {
  const loader = new GLTFLoader();
  const templates = new Map(); // kind -> Promise<{ object, radius }>
  const live = new Map(); // id -> { data, node, footprint }
  let surface = null; // the levelled surface the scene draws
  let selected = null;
  // Chart view looks straight down, where a building is only its roof.
  // Hand-drawn maps solve this with elevation symbols: each building is
  // drawn standing up, seen from the front, on its ground position. Chart
  // view does the same - every place leans back towards the viewer about
  // its own base - while Relief shows true 3D.
  let lean = 0;
  const selectRing = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1.05, 48),
    new THREE.MeshBasicMaterial({ color: 0xe0b55a, transparent: true, opacity: 0.9, depthTest: false }),
  );
  selectRing.rotation.x = -Math.PI / 2;
  selectRing.renderOrder = 10;
  selectRing.visible = false;
  scene.add(selectRing);

  function finish(object, model, resolve) {
    // Normalise: the model's widest footprint becomes `size` cells; its
    // base sits at y = 0, less `sink` (model units) for a model whose feet
    // belong below the ground it's seated on.
    const box = new THREE.Box3().setFromObject(object);
    const width = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) || 1;
    const holder = new THREE.Group();
    object.position.set(-(box.min.x + box.max.x) / 2, -box.min.y - (model.sink ?? 0), -(box.min.z + box.max.z) / 2);
    holder.add(object);
    holder.scale.setScalar(model.size / width);
    resolve({ object: holder, radius: Math.hypot(model.foot[0], model.foot[1]) });
  }

  function template(kind) {
    if (!templates.has(kind)) {
      templates.set(
        kind,
        new Promise((resolve) => {
          const model = OBJECT_MODELS[kind];
          if (model.field) {
            finish(buildFieldModel(model.size, model.foot), model, resolve);
            return;
          }
          loader.load(OBJECT_DIR + model.file + ".gltf", (gltf) => {
            gltf.scene.traverse((o) => {
              if (o.isMesh) {
                o.castShadow = true;
                o.receiveShadow = true;
                o.material.metalness = 0;
                o.material.roughness = 1;
              }
            });
            finish(gltf.scene, model, resolve);
          }, undefined, () => resolve(null));
        }),
      );
    }
    return templates.get(kind);
  }

  function seat(entry) {
    const { data, node } = entry;
    // On a levelled pad this is the pad's own height; a bridge reads the
    // ground (or the water surface) at its centre.
    const h = surface ? sampleSurface(surface, data.x, data.y) * HEIGHT_SCALE : 0;
    node.position.set(data.x, Math.max(h, 0), data.y);
    node.rotation.x = OBJECT_MODELS[data.kind].flat ? 0 : -lean;
    entry.yaw.rotation.y = -data.rotation;
    entry.yaw.scale.setScalar(data.scale);
    if (selected === data.id) placeRing(entry);
  }

  function placeRing(entry) {
    const r = (entry.radius ?? 1.5) * entry.data.scale * 1.05;
    selectRing.scale.set(r, r, r);
    selectRing.position.set(entry.node.position.x, entry.node.position.y + 0.05, entry.node.position.z);
    selectRing.visible = true;
  }

  // The footprint list changed: the scene re-levels the ground (old and
  // new footprint areas), then calls setSurface, which re-seats everything.
  function footprintsChanged(...regions) {
    onFootprints(regions.filter(Boolean));
  }

  function setData(entry, data) {
    const before = entry.footprint;
    entry.data = { ...data };
    entry.footprint = footprintOf(entry.data);
    const same =
      before && entry.footprint &&
      before.x === entry.footprint.x && before.y === entry.footprint.y &&
      before.hx === entry.footprint.hx && before.hz === entry.footprint.hz && before.rot === entry.footprint.rot;
    if (same || (!before && !entry.footprint)) {
      entry.footprint && (entry.footprint.level = before.level);
      seat(entry);
      return;
    }
    footprintsChanged(before && footprintBounds(before), entry.footprint && footprintBounds(entry.footprint));
  }

  async function upsert(data) {
    let entry = live.get(data.id);
    if (entry && entry.kind === data.kind) {
      setData(entry, data);
      onChange();
      return;
    }
    if (entry) remove(data.id);
    const t = await template(data.kind);
    if (!t) return;
    if (live.has(data.id)) return; // a newer upsert raced ahead
    // wrapper: position and the Chart-view lean (world axes); yaw: the
    // place's own turn and size.
    const yaw = new THREE.Group();
    yaw.add(t.object.clone(true));
    const wrapper = new THREE.Group();
    wrapper.add(yaw);
    wrapper.userData.objectId = data.id;
    scene.add(wrapper);
    entry = { data: null, node: wrapper, yaw, kind: data.kind, radius: t.radius, footprint: null };
    live.set(data.id, entry);
    setData(entry, data);
    seat(entry);
    onChange();
  }

  function remove(id) {
    const entry = live.get(id);
    if (!entry) return;
    scene.remove(entry.node);
    live.delete(id);
    if (selected === id) select(null);
    if (entry.footprint) footprintsChanged(footprintBounds(entry.footprint));
    onChange();
  }

  function setAll(list) {
    for (const id of [...live.keys()]) if (!list.some((o) => o.id === id)) remove(id);
    for (const o of list) upsert(o);
  }

  function select(id) {
    selected = id;
    const entry = id === null ? null : live.get(id);
    if (entry) placeRing(entry);
    else selectRing.visible = false;
    onChange();
  }

  function setLean(radians) {
    lean = radians;
    for (const entry of live.values()) seat(entry);
    onChange();
  }

  // Pad levels are measured on the *natural* (unlevelled) surface; places
  // whose pads touch share one terrace (terrain-fields.js).
  function footprints(raw) {
    const list = [];
    for (const entry of live.values()) if (entry.footprint) list.push(entry.footprint);
    setFoundationLevels(raw, list);
    return list;
  }

  // Re-seat on the new (levelled) surface; a few hundred objects at most,
  // so a full pass is cheap.
  function setSurface(s) {
    surface = s;
    for (const entry of live.values()) seat(entry);
  }

  const raycaster = new THREE.Raycaster();
  function pickObject(ray) {
    if (live.size === 0) return null;
    raycaster.ray.copy(ray);
    const hits = raycaster.intersectObjects([...live.values()].map((e) => e.node), true);
    for (const hit of hits) {
      let o = hit.object;
      while (o && o.userData.objectId === undefined) o = o.parent;
      if (o) return o.userData.objectId;
    }
    return null;
  }

  return { upsert, remove, setAll, select, setSurface, setLean, footprints, pickObject, count: () => live.size };
}

// --- Picking --------------------------------------------------------------
// A ray march against the *displayed* surface (the same displayHeight the
// vertex shader draws, flattened at sea level), so a stroke lands on the
// ridge actually under the cursor, not on the smoother painted value below
// it. Returns the nearest authoritative cell.
function displayedHeightCPU(surface, x, z) {
  return sampleSurface(surface, x, z) * HEIGHT_SCALE;
}

function pickAgainstHeightfield(origin, direction, surface, exact = false) {
  const maxHeight = HEIGHT_SCALE * (ELEVATION_MAX + 0.4);
  const minHeight = HEIGHT_SCALE * SEA_LEVEL - 1;
  let tMin = 0;
  let tMax = 2000;
  const bounds = [
    [0, GRID_SIZE - 1, origin.x, direction.x],
    [0, GRID_SIZE - 1, origin.z, direction.z],
    [minHeight, maxHeight, origin.y, direction.y],
  ];
  for (const [lo, hi, o, d] of bounds) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t0 = (lo - o) / d;
    let t1 = (hi - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tMin = Math.max(tMin, t0);
    tMax = Math.min(tMax, t1);
  }
  if (tMin > tMax) return null;

  const STEPS = 320;
  const step = (tMax - tMin) / STEPS;
  let prevT = tMin;
  let prevDiff = null;
  for (let i = 0; i <= STEPS; i++) {
    const t = tMin + i * step;
    const x = origin.x + direction.x * t;
    const y = origin.y + direction.y * t;
    const z = origin.z + direction.z * t;
    const diff = y - displayedHeightCPU(surface, x, z);
    if (prevDiff !== null && prevDiff > 0 && diff <= 0) {
      let lo = prevT;
      let hi = t;
      for (let b = 0; b < 10; b++) {
        const mid = (lo + hi) / 2;
        const my = origin.y + direction.y * mid;
        if (my - displayedHeightCPU(surface, origin.x + direction.x * mid, origin.z + direction.z * mid) > 0) lo = mid;
        else hi = mid;
      }
      const fx = origin.x + direction.x * hi;
      const fz = origin.z + direction.z * hi;
      const gx = Math.round(fx);
      const gz = Math.round(fz);
      if (gx < 0 || gx >= GRID_SIZE || gz < 0 || gz >= GRID_SIZE) return null;
      // `exact`: the fractional point, for placing objects off the grid.
      return exact ? { x: Math.min(GRID_SIZE - 1, Math.max(0, fx)), y: Math.min(GRID_SIZE - 1, Math.max(0, fz)) } : { x: gx, y: gz };
    }
    prevT = t;
    prevDiff = diff;
  }
  return null;
}

// How far places lean back in Chart view (see buildObjectLayer): enough to
// show a front and a roof, as a hand-drawn map symbol does.
const CHART_LEAN = (52 * Math.PI) / 180;

// Capped device-pixel-ratio rendering (ROADMAP.md task 4).
export const MAX_DEVICE_PIXEL_RATIO = 2;

// Coast distance field recompute is ~30-60ms at 512^2, so while a stroke is
// being painted it's throttled to at most once per this interval; the last
// change always gets a trailing recompute, so it's never left stale.
const COAST_RECOMPUTE_MS = 140;

export function createTerrainScene3D(canvas, elevationGrid, typeGrid, logicalSize) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, context: canvas.getContext("webgl2") });
  } catch {
    return null;
  }
  if (!renderer) return null;

  const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(logicalSize, logicalSize, false);
  renderer.setClearColor(0x11161b, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // The sun never moves and the shadow camera covers the whole map, so the
  // shadow map only changes when terrain or trees do - not on every camera
  // move. Re-rendering it (a 4096^2 pass over the full displaced mesh and
  // every tree) is the single heaviest GPU cost per frame.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  const invalidateShadows = () => {
    renderer.shadowMap.needsUpdate = true;
  };

  const scene = new THREE.Scene();

  const heightTexture = createHeightTexture();
  const typeTexture = createTypeTexture();
  // Full-precision CPU copies (picking, tree placement); the textures above
  // hold their own half-float conversion, written by fillHeightTexture /
  // the coast/surface updates below.
  const coastData = new Float32Array(COAST_SDF_RES * COAST_SDF_RES);
  const coastTexture = createCoastTexture();
  // The natural surface baked from the grid, and the one actually drawn:
  // the same, with each place's foundation levelled in. Everything that
  // must agree with the drawn mesh (picking, trees, seats) reads
  // surfaceData; pad heights are measured on rawSurface.
  const rawSurface = new Float32Array(SURFACE_RES * SURFACE_RES);
  bakeSurface(elevationGrid, rawSurface);
  const surfaceData = Float32Array.from(rawSurface);
  const surfaceTexture = createSurfaceTexture();
  floatToHalf(surfaceData, surfaceTexture.image.data);
  let typeWeights = buildTypeWeights(elevationGrid, typeGrid);

  const uniforms = {
    uHeight: { value: heightTexture },
    uType: { value: typeTexture },
    uGridSize: { value: GRID_SIZE },
    uCoastSDF: { value: coastTexture },
    uSurface: { value: surfaceTexture },
    uNoise: { value: createNoiseTexture() },
    uGrassDetail: { value: null },
    uDetailReady: { value: 0 },
  };
  // A real CC0 hand-painted grass texture (CREDITS.md) used only as a
  // low-contrast luminance grain under the procedural colour, so grass has
  // brush texture up close without the photo-turf look it had as a fill.
  new THREE.TextureLoader().load("/world/assets/textures/grass-cethiel.png", (tex) => {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    uniforms.uGrassDetail.value = tex;
    uniforms.uDetailReady.value = 1;
  });

  const groundMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  patchGroundMaterial(groundMaterial, uniforms);
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patchDepthMaterial(depthMaterial, uniforms);

  const groundGeometry = buildGroundGeometry();
  const groundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
  groundMesh.customDepthMaterial = depthMaterial;
  groundMesh.castShadow = true;
  groundMesh.receiveShadow = true;
  groundMesh.frustumCulled = false; // vertices move in the shader
  scene.add(groundMesh);

  // Cartographic convention: light from the north-west (upper-left in the
  // default north-up view), fairly low so relief casts readable shadows.
  const GRID_CENTER = new THREE.Vector3((GRID_SIZE - 1) / 2, 0, (GRID_SIZE - 1) / 2);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.1);
  sun.position.copy(GRID_CENTER).add(new THREE.Vector3(-150, 150, -110));
  sun.target.position.copy(GRID_CENTER);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.35;
  sun.shadow.radius = 2;
  const shadowCam = sun.shadow.camera;
  shadowCam.left = -200;
  shadowCam.right = 200;
  shadowCam.top = 200;
  shadowCam.bottom = -200;
  shadowCam.near = 1;
  shadowCam.far = 520;
  scene.add(sun, sun.target);
  // Warm sky / cool ground fill keeps shadowed slopes painterly rather than
  // black, the way the reference maps tint their shade sides.
  scene.add(new THREE.HemisphereLight(0xe8eefc, 0x6b5a45, 1.05));

  // Declared before the tree layer so a model finishing its load can mark
  // shadows stale and ask for a redraw.
  let onAsyncChange = () => {};
  const trees = buildTreeLayer(scene, () => {
    invalidateShadows();
    onAsyncChange();
  });

  const objects = buildObjectLayer(
    scene,
    () => {
      invalidateShadows();
      onAsyncChange();
    },
    (regions) => {
      for (const r of regions) relevel(r);
      objects.setSurface(surfaceData);
      for (const r of regions) scheduleTrees(r);
      invalidateShadows();
      onAsyncChange();
    },
  );
  let footprintList = [];

  // Re-apply foundations over a cell region (or everything) and upload
  // just the texels that changed.
  function relevel(region) {
    footprintList = objects.footprints(rawSurface);
    const toTexel = (c) => c / SURFACE_STEP;
    const range = region
      ? {
          i0: Math.max(0, Math.floor(toTexel(region.minX))),
          i1: Math.min(SURFACE_RES - 1, Math.ceil(toTexel(region.maxX))),
          j0: Math.max(0, Math.floor(toTexel(region.minY))),
          j1: Math.min(SURFACE_RES - 1, Math.ceil(toTexel(region.maxY))),
        }
      : { i0: 0, i1: SURFACE_RES - 1, j0: 0, j1: SURFACE_RES - 1 };
    levelFootprints(rawSurface, surfaceData, footprintList, range);
    const halfData = surfaceTexture.image.data;
    for (let j = range.j0; j <= range.j1; j++) {
      const row = j * SURFACE_RES;
      for (let i = range.i0; i <= range.i1; i++) halfData[row + i] = THREE.DataUtils.toHalfFloat(surfaceData[row + i]);
    }
    surfaceTexture.needsUpdate = true;
  }

  function currentFields() {
    return { elevationGrid: currentElevationGridRef, typeWeights, coastSDF: coastData, surface: surfaceData, footprints: footprintList };
  }

  let currentElevationGridRef = elevationGrid;
  let currentTypeGridRef = typeGrid;
  // Tree re-placement is the costliest per-edit CPU work (~6ms per 16x16
  // chunk, measured), so it's never done inside a paint frame: changed
  // regions accumulate and are re-placed on a short trailing throttle.
  let treeRegion = null;
  let treeTimer = null;
  const TREE_REBUILD_MS = 120;
  function flushTrees() {
    treeTimer = null;
    const region = treeRegion;
    treeRegion = null;
    trees.rebuild(currentFields(), region === "all" ? undefined : region);
    invalidateShadows();
    onAsyncChange();
  }
  function scheduleTrees(region) {
    if (!region || treeRegion === "all") treeRegion = "all";
    else if (!treeRegion) treeRegion = { ...region };
    else {
      treeRegion.minX = Math.min(treeRegion.minX, region.minX);
      treeRegion.minY = Math.min(treeRegion.minY, region.minY);
      treeRegion.maxX = Math.max(treeRegion.maxX, region.maxX);
      treeRegion.maxY = Math.max(treeRegion.maxY, region.maxY);
    }
    if (!treeTimer && !strokeActive) treeTimer = setTimeout(flushTrees, TREE_REBUILD_MS);
  }
  let coastTimer = null;
  let lastCoastAt = 0;

  function recomputeCoast() {
    coastTimer = null;
    lastCoastAt = performance.now();
    computeCoastSDF(currentElevationGridRef, coastData);
    floatToHalf(coastData, coastTexture.image.data);
    coastTexture.needsUpdate = true;
    invalidateShadows();
    // Trees near the shore depend on the coast distance; a full re-place
    // after a coastline move keeps beaches clear of trees.
    scheduleTrees(lastCoastRegion === "all" ? null : lastCoastRegion);
    lastCoastRegion = null;
    onAsyncChange();
  }

  let lastCoastRegion = null;
  // While the user is mid-stroke, the two expensive derived updates (coast
  // distance field ~50ms, tree re-placement up to ~100ms) are held back and
  // run once on pointerup: firing them mid-stroke on a throttle is what made
  // painting hitch. The terrain itself (height, surface, materials) still
  // updates every frame, so the stroke is never visually behind the cursor;
  // only foam/ripples and trees catch up when the stroke ends.
  let strokeActive = false;
  let coastPending = false;
  function setStrokeActive(active) {
    strokeActive = active;
    if (active) return;
    if (coastPending) {
      coastPending = false;
      scheduleCoast(null);
    }
    if (treeRegion && !treeTimer) treeTimer = setTimeout(flushTrees, 0);
  }
  function scheduleCoast(region) {
    if (region && lastCoastRegion !== "all") {
      lastCoastRegion = lastCoastRegion
        ? {
            minX: Math.min(lastCoastRegion.minX, region.minX),
            minY: Math.min(lastCoastRegion.minY, region.minY),
            maxX: Math.max(lastCoastRegion.maxX, region.maxX),
            maxY: Math.max(lastCoastRegion.maxY, region.maxY),
          }
        : { ...region };
    } else lastCoastRegion = "all";
    if (coastTimer) return;
    const wait = Math.max(0, COAST_RECOMPUTE_MS - (performance.now() - lastCoastAt));
    if (strokeActive) {
      coastTimer = null;
      coastPending = true;
      return;
    }
    coastTimer = setTimeout(recomputeCoast, wait);
  }

  fillHeightTexture(heightTexture, elevationGrid);
  fillTypeTexture(typeTexture, elevationGrid, typeGrid);
  computeCoastSDF(elevationGrid, coastData);
  floatToHalf(coastData, coastTexture.image.data);
  coastTexture.needsUpdate = true;
  trees.rebuild(currentFields());

  // --- Camera ---------------------------------------------------------------
  // Two independent camera states, one per view: switching views never
  // loses the other view's zoom/pan/rotation. Top-down is the same scene
  // seen from straight overhead, north up - so both views are literally the
  // same rendered terrain, not two renderers kept in visual agreement.
  const DISTANCE = 340;
  const MIN_TILT_DEG = 12;
  const MAX_TILT_DEG = 82;
  const DEFAULT_TILT_DEG = 55;
  const MIN_ZOOM = 0.4;
  const MAX_ZOOM = 8;
  const FIT_MARGIN = 1.08;
  const AZIMUTH_PRESETS = [
    { id: "n-s", label: "N→S", angleDeg: 180 },
    { id: "s-n", label: "S→N", angleDeg: 0 },
    { id: "e-w", label: "E→W", angleDeg: 90 },
    { id: "w-e", label: "W→E", angleDeg: 270 },
  ];

  const views = {
    top: { azimuthDeg: 0, tiltDeg: 0, zoom: 1, panOffset: new THREE.Vector3(), baseViewSize: GRID_SIZE },
    oblique: {
      azimuthDeg: 0,
      tiltDeg: DEFAULT_TILT_DEG,
      zoom: 1,
      panOffset: new THREE.Vector3(),
      baseViewSize: GRID_SIZE * 0.62,
    },
  };
  let mode = "top";
  let camView = views[mode];

  const aspect = canvas.width / canvas.height || 1;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 900);

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function applyCameraState() {
    const angleRad = (camView.azimuthDeg * Math.PI) / 180;
    const tiltRad = (camView.tiltDeg * Math.PI) / 180;
    const horizontal = DISTANCE * Math.sin(tiltRad);
    const vertical = DISTANCE * Math.cos(tiltRad);
    const center = GRID_CENTER.clone().add(camView.panOffset);
    camera.position.set(
      center.x + horizontal * Math.sin(angleRad),
      center.y + vertical,
      center.z + horizontal * Math.cos(angleRad),
    );
    // "Up" is the horizontal direction the camera faces: identical to
    // world-up for any tilt, but still well-defined when looking straight
    // down (tilt 0), where world-up would be parallel to the view ray.
    camera.up.set(-Math.sin(angleRad), 0, -Math.cos(angleRad));
    camera.lookAt(center);
    camera.updateMatrixWorld();

    const halfH = camView.baseViewSize / camView.zoom / 2;
    camera.left = -halfH * aspect;
    camera.right = halfH * aspect;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
  }

  function fitView() {
    camView.zoom = 1;
    camView.panOffset.set(0, 0, 0);
    if (mode === "top") {
      camView.baseViewSize = GRID_SIZE * 1.002;
      applyCameraState();
      return;
    }
    let maxE = SEA_LEVEL;
    for (let i = 0; i < currentElevationGridRef.length; i++) maxE = Math.max(maxE, currentElevationGridRef[i]);
    const minY = SEA_LEVEL * HEIGHT_SCALE;
    const maxY = (maxE + 0.25) * HEIGHT_SCALE;
    applyCameraState();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    let minR = Infinity;
    let maxR = -Infinity;
    let minU = Infinity;
    let maxU = -Infinity;
    const corner = new THREE.Vector3();
    for (const x of [0, GRID_SIZE - 1]) {
      for (const y of [minY, maxY]) {
        for (const z of [0, GRID_SIZE - 1]) {
          corner.set(x, y, z).sub(GRID_CENTER);
          const r = corner.dot(right);
          const u = corner.dot(up);
          minR = Math.min(minR, r);
          maxR = Math.max(maxR, r);
          minU = Math.min(minU, u);
          maxU = Math.max(maxU, u);
        }
      }
    }
    camView.baseViewSize = Math.max((maxU - minU) * FIT_MARGIN, ((maxR - minR) * FIT_MARGIN) / aspect, GRID_SIZE * 0.1);
    applyCameraState();
  }

  function setMode(next) {
    mode = next === "top" ? "top" : "oblique";
    camView = views[mode];
    objects.setLean(mode === "top" ? CHART_LEAN : 0);
    applyCameraState();
  }

  function wrapDeg(deg) {
    return ((deg % 360) + 360) % 360;
  }

  function setAzimuth(deg) {
    if (mode === "top") return;
    camView.azimuthDeg = wrapDeg(deg);
    applyCameraState();
  }

  function setAzimuthPreset(index) {
    setAzimuth(AZIMUTH_PRESETS[clamp(index, 0, AZIMUTH_PRESETS.length - 1)].angleDeg);
  }

  function setTilt(deg) {
    if (mode === "top") return;
    camView.tiltDeg = clamp(deg, MIN_TILT_DEG, MAX_TILT_DEG);
    applyCameraState();
  }

  function setZoom(factor) {
    camView.zoom = clamp(factor, MIN_ZOOM, MAX_ZOOM);
    applyCameraState();
  }

  // Cursor-centred zoom: keeps the world point under the pointer fixed.
  function zoomAtCursor(zoomDeltaFactor, ndcX, ndcY) {
    const oldZoom = camView.zoom;
    const newZoom = clamp(oldZoom * zoomDeltaFactor, MIN_ZOOM, MAX_ZOOM);
    if (newZoom === oldZoom) return;
    const viewSize = camView.baseViewSize / oldZoom;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const ratio = 1 - oldZoom / newZoom;
    camView.panOffset.addScaledVector(right, ndcX * ((viewSize * aspect) / 2) * ratio);
    camView.panOffset.addScaledVector(up, ndcY * (viewSize / 2) * ratio);
    camView.zoom = newZoom;
    applyCameraState();
  }

  // dRight/dUp are fractions of the current view size along the camera's
  // own screen axes, so a pan means the same thing at any azimuth/tilt.
  function panBy(dRight, dUp) {
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const step = camView.baseViewSize / camView.zoom;
    camView.panOffset.addScaledVector(right, dRight * step);
    camView.panOffset.addScaledVector(up, dUp * step);
    applyCameraState();
  }

  function getCameraState() {
    return {
      mode,
      azimuthDeg: camView.azimuthDeg,
      azimuthPresets: AZIMUTH_PRESETS.map((p) => ({ id: p.id, label: p.label, angleDeg: p.angleDeg })),
      tiltDeg: camView.tiltDeg,
      minTiltDeg: MIN_TILT_DEG,
      maxTiltDeg: MAX_TILT_DEG,
      zoom: camView.zoom,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
    };
  }

  // Both views start framed; the oblique state is fitted once up front so
  // its first appearance is already framed for whatever data is loaded.
  function fitAll() {
    const was = mode;
    setMode("oblique");
    fitView();
    setMode("top");
    fitView();
    setMode(was);
  }
  fitAll();

  function render() {
    renderer.render(scene, camera);
  }

  function setAspect() {}

  // `region` (cells, inclusive) bounds what changed, so only nearby tree
  // chunks are re-placed; omit it for a full reload.
  function update(currentElevationGrid, currentTypeGrid, { elevationChanged = true, typeChanged = true, region } = {}) {
    currentElevationGridRef = currentElevationGrid;
    currentTypeGridRef = currentTypeGrid;
    if (elevationChanged) {
      fillHeightTexture(heightTexture, currentElevationGrid);
      const baked = bakeSurface(currentElevationGrid, rawSurface, region);
      // A pad's level depends on the ground under its whole footprint, so
      // re-level the baked range widened by the largest place's reach.
      const reach = 8 / SURFACE_STEP;
      relevel(
        region && {
          minX: (baked.i0 - reach) * SURFACE_STEP,
          maxX: (baked.i1 + reach) * SURFACE_STEP,
          minY: (baked.j0 - reach) * SURFACE_STEP,
          maxY: (baked.j1 + reach) * SURFACE_STEP,
        },
      );
      invalidateShadows();
      objects.setSurface(surfaceData);
    }
    if (elevationChanged || typeChanged) {
      // +1: a cell crossing sea level changes its own type weight only, but
      // pad anyway so the region is never off by one at a brush edge.
      const r = region && { minX: region.minX - 1, minY: region.minY - 1, maxX: region.maxX + 1, maxY: region.maxY + 1 };
      fillTypeTexture(typeTexture, currentElevationGrid, currentTypeGrid, r);
      if (r) updateTypeWeights(typeWeights, currentElevationGrid, currentTypeGrid, r);
      else typeWeights = buildTypeWeights(currentElevationGrid, currentTypeGrid);
      scheduleTrees(region);
    }
    if (elevationChanged) scheduleCoast(region);
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function pick(px, py) {
    ndc.x = (px / canvas.width) * 2 - 1;
    ndc.y = -(py / canvas.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return pickAgainstHeightfield(raycaster.ray.origin, raycaster.ray.direction, surfaceData);
  }

  // A place under the cursor, checked before the ground (stage B).
  function pickObject(px, py) {
    ndc.x = (px / canvas.width) * 2 - 1;
    ndc.y = -(py / canvas.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return objects.pickObject(raycaster.ray);
  }

  // The exact (fractional) map point under the cursor, for placing and
  // dragging places off the cell grid.
  function pickPoint(px, py) {
    ndc.x = (px / canvas.width) * 2 - 1;
    ndc.y = -(py / canvas.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return pickAgainstHeightfield(raycaster.ray.origin, raycaster.ray.direction, surfaceData, true);
  }

  function dispose() {
    groundGeometry.dispose();
    groundMaterial.dispose();
    depthMaterial.dispose();
    heightTexture.dispose();
    typeTexture.dispose();
    coastTexture.dispose();
    surfaceTexture.dispose();
    renderer.dispose();
  }

  return {
    render,
    update,
    // Kept for callers of the old two-call API.
    updateHeight: (g) => update(g, currentTypeGridRef, { typeChanged: false }),
    updateType: (g, t) => update(g, t, { elevationChanged: false }),
    setStrokeActive,
    pick,
    pickObject,
    pickPoint,
    objects: {
      setAll: (list) => objects.setAll(list),
      upsert: (o) => objects.upsert(o),
      remove: (id) => objects.remove(id),
      select: (id) => objects.select(id),
      count: () => objects.count(),
    },
    setAspect,
    dispose,
    setMode,
    setAzimuth,
    setAzimuthPreset,
    setTilt,
    setZoom,
    zoomAtCursor,
    panBy,
    fitView: () => fitView(),
    fitAll,
    getCameraState,
    treeCount: () => trees.count(),
    // Called after work that finishes outside a render request (the
    // throttled coast recompute), so the caller can redraw.
    onAsyncChange: (fn) => {
      onAsyncChange = fn;
    },
  };
}
