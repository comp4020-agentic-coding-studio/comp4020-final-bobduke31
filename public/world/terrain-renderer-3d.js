// A second renderer for the "Oblique" view: a real heightfield mesh (Three.js,
// vendored MIT, vendor/three/) with an inclined orthographic camera, real
// lighting/shadows, and GPU-computed ridge detail - replacing the column-
// extrusion technique in terrain-renderer.js's renderTerrainOblique for any
// browser with WebGL2. See CLAUDE.md's "Reuse before you build" section and
// PROCESS.md for why (THREE.Terrain and @interverse/three-terrain-lod were
// both considered and not adopted directly - see there).
//
// Two separate representations, each with one job, so visual-only detail
// never affects what painting actually hits:
//
//  - Picking is a direct ray-heightfield march against the authoritative
//    `elevationGrid` Float32Array itself (see pick() below) - the same array
//    world-client.js paints into and the SSE handlers update. No second mesh
//    to keep in sync.
//  - The visual mesh is a denser grid (MESH_SEGMENTS, finer than the 256
//    authoritative cells) whose vertex shader adds ridged-noise detail to
//    height, scaled by slope and elevation, so mountains get real jagged
//    geometry instead of a smoothed-out mesh version of the same blob. This
//    is GPU-computed from two small DataTextures (height, terrain type) -
//    an elevation edit only has to re-upload those textures (a few hundred
//    KB covering the whole 256x256 grid, re-uploaded in full since that's
//    already cheap at this size), not touch any CPU-side vertex buffer.
import * as THREE from "./vendor/three/three.module.js";
import { GRID_SIZE, ELEVATION_MIN, ELEVATION_MAX, SEA_LEVEL, TERRAIN_TYPES, sampleBilinear } from "./terrain-model.js";
import { computeCoastlineRings } from "./terrain-renderer.js";

// World units: one grid cell = one unit in X/Z, so picking math and the
// authoritative grid share the same coordinate space with no scale factor
// to get wrong. Elevation (range [-1, 1]) is scaled up into world Y - purely
// a visual exaggeration, the same role OBLIQUE_HEIGHT_SCALE plays in the 2D
// renderer, tuned empirically against research/visual-references/.
export const HEIGHT_SCALE = 46;

// Visual-mesh density: finer than the 256 authoritative cells so ridge noise
// has room to read as real geometric detail rather than being smoothed away
// between sparse vertices. 384 keeps triangle count (384*384*2 ~= 295k)
// comfortably cheap for any GPU from the last decade while still giving ~1.5
// visual vertices per authoritative cell edge.
const MESH_SEGMENTS = 384;

export function isWebGL2Available() {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2");
  } catch {
    return false;
  }
}

// BUG (found comparing Top-down against Oblique side by side on a sparse
// map - large stretches of unpainted grid rendered as solid land in Oblique
// while Top-down correctly showed open sea): the height DataTexture used to
// be 8-bit (Uint8Array/UnsignedByteType), round-tripping every elevation
// through elevationToTexel's quantization to 1 of 256 steps (~0.0078 wide
// at this app's [-1, 1] range) and back via texelToElevationRange in the
// shader. An untouched cell's elevation is exactly 0 (SEA_LEVEL) - the
// *default* for the overwhelming majority of cells on any real map, not an
// edge case - which quantizes to texel 128, decoding back to +0.00392: just
// barely *above* SEA_LEVEL. Every unpainted cell in the Oblique view's
// land/sea test (`vElevation <= uSeaLevel`) was therefore misclassified as
// land, while the Top-down renderer (plain JS floats, no texture, no
// quantization) correctly read the same cells as sea - two different
// land/sea tests silently disagreeing at the one elevation value (exactly
// 0) nearly every cell on a map actually has. A `SEA_LEVEL + epsilon`
// comparison nudge (the fix terrain-renderer.js's own computeCoastlineRings
// already needed for an unrelated d3-contour precision issue) would only
// patch the symptom here, not the cause - this app's WebGL2 requirement
// (isWebGL2Available) already guarantees float textures are available, so
// the real fix is carrying the actual float elevation through with no
// lossy round-trip at all, the same precision Top-down always had.
function elevationToTexel(elevation) {
  return Math.min(ELEVATION_MAX, Math.max(ELEVATION_MIN, elevation));
}

// The height texture is now FloatType (see createHeightTexture/
// elevationToTexel) - texture2D(...).r returns the actual stored elevation
// value directly, with none of the [0, 1]-normalized-integer remapping an
// 8-bit UnsignedByteType texture needs. This is now the identity; kept as
// its own named function (rather than inlined as plain `t`) so every call
// site stays self-documenting about going through "the height texture's
// decode step," in case a future change (e.g. HalfFloatType for memory)
// reintroduces one.
function texelToElevationRange() {
  return `t`;
}

// Bilinearly samples the authoritative (un-detailed) grid directly - used by
// both tree placement and picking, which must agree with what's actually
// stored, not the GPU-only ridge detail. Shared with the top-down renderer
// via terrain-model.js's sampleBilinear - both views interpolate the stored
// data the same way.
function sampleElevationBilinear(elevationGrid, x, y) {
  return sampleBilinear(elevationGrid, x, y);
}

// --- GLSL noise -------------------------------------------------------
// A standard, self-contained hash-based value noise (the common "fract(sin(
// dot(...)))" idiom used throughout shader tutorials/Shadertoy - not a port
// of vendor/simplex-noise.js's gradient-noise algorithm, which is a JS
// module and can't be called from a shader). Used the same way
// terrain-renderer.js's fractalFold uses real simplex noise: ridged
// (1 - |noise*2-1|) and summed over a few octaves for crease-like detail.
// The qualitative effect (ridges, not bumps) is what's being reused, not a
// specific library.
const NOISE_GLSL = `
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float ridged(vec2 p) {
    return 1.0 - abs(valueNoise(p) * 2.0 - 1.0);
  }
  // Four octaves, each finer and fainter - mirrors fractalFold's fBm
  // construction in terrain-renderer.js.
  float fractalFold(vec2 p) {
    float sum = 0.0;
    float norm = 0.0;
    float amp = 1.0;
    float freq = 0.11;
    for (int i = 0; i < 4; i++) {
      sum += ridged(p * freq) * amp;
      norm += amp;
      freq *= 2.17;
      amp *= 0.5;
    }
    return sum / norm;
  }
`;

const HEIGHT_SAMPLE_GLSL = `
  uniform sampler2D uHeight;
  uniform float uGridSize;

  float rawElevation(vec2 cell) {
    vec2 uv = (cell + 0.5) / uGridSize;
    float t = texture2D(uHeight, uv).r;
    return ${texelToElevationRange()};
  }

  // Detail displacement added on top of the painted (authoritative)
  // elevation: ridged noise at sub-cell frequency, scaled by elevation-
  // above-sea-level - this envelope (slopeGate/amplitude below) is the
  // ORIGINAL formula, kept as-is: it already produces smooth, well-tapered,
  // good-looking mountains (verified against research/ and this app's own
  // seed scene - see ROADMAP.md task 2), varying smoothly and monotonically
  // from a mountain's summit down to its base, which a from-scratch slope-
  // based envelope could not reproduce (tried and reverted here - a pure
  // local-slope gate is zero at a dome's flat summit and peaks partway down
  // the flank instead, a "halo ring" shape that let the noise function's own
  // occasional sharp crests show through as isolated new spikes partway down
  // otherwise-smooth hillsides - confirmed via a direct before/after
  // screenshot comparison against the unmodified formula on the same seed
  // data, visible proof this was a regression and not pre-existing).
  //
  // What this task's correction actually needs is narrower than a full
  // re-gate: don't let this noise pile extra jaggedness onto a slope that's
  // *already* extreme (a leftover narrow spike/cliff the relaxation pass in
  // world-client.js hasn't caught, or data painted before that pass
  // existed) - not a reason to change how normal terrain is textured.
  // extremeDamping below is a ceiling only: 1.0 (no change at all) for any
  // slope at or under what the relaxation pass already keeps painted
  // terrain within, confirmed to cover this seed scene's steepest natural
  // feature (the dominant peak, ~0.066) and the coastline itself (~0.05 at
  // this sampling width) with room to spare - it only engages above that,
  // on genuinely pathological terrain.
  float detailedHeight(vec2 cell, float base) {
    float aboveSea = max(0.0, base - ${SEA_LEVEL.toFixed(6)});
    if (aboveSea <= 0.0001) return base;
    float slopeGate = smoothstep(0.02, 0.18, aboveSea);
    float amplitude = 0.05 + 0.22 * smoothstep(0.1, 0.9, aboveSea);
    // Wider than the vertex shader's own eps=0.6 (used for visual normals,
    // a different job): a narrow sampling window reads the *pointwise*
    // gradient, which spikes at any sharp kink in the data - not just a
    // genuinely steep face, but also the seam where two overlapping
    // terrain features meet (this app's own seed data combines bumps with
    // max(), the same shape repeated overlapping brush strokes leave
    // behind). Widened so this reads *regional* steepness instead.
    float slopeEps = 2.2;
    float hl = rawElevation(cell + vec2(-slopeEps, 0.0));
    float hr = rawElevation(cell + vec2(slopeEps, 0.0));
    float hd = rawElevation(cell + vec2(0.0, -slopeEps));
    float hu = rawElevation(cell + vec2(0.0, slopeEps));
    float slope = length(vec2(hr - hl, hu - hd)) / (2.0 * slopeEps);
    float extremeDamping = 1.0 - 0.7 * smoothstep(0.15, 0.35, slope);
    float n = (fractalFold(cell * 1.0) - 0.5) * 2.0;
    return base + n * amplitude * slopeGate * extremeDamping;
  }

  float heightAt(vec2 cell) {
    return detailedHeight(cell, rawElevation(cell));
  }
`;

const VERTEX_SHADER = `
  ${NOISE_GLSL}
  ${HEIGHT_SAMPLE_GLSL}
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vElevation;

  void main() {
    vec2 cell = vec2(position.x, position.z);
    float h = heightAt(cell);
    vElevation = h;
    vec3 displaced = vec3(position.x, h * ${HEIGHT_SCALE.toFixed(2)}, position.z);

    // Finite-difference normal from the same height function, computed
    // on-the-fly in-shader - no CPU normal buffer, ever, regardless of
    // how often the authoritative grid changes.
    float eps = 0.6;
    float hl = heightAt(cell + vec2(-eps, 0.0));
    float hr = heightAt(cell + vec2(eps, 0.0));
    float hd = heightAt(cell + vec2(0.0, -eps));
    float hu = heightAt(cell + vec2(0.0, eps));
    vec3 dx = vec3(2.0 * eps, (hr - hl) * ${HEIGHT_SCALE.toFixed(2)}, 0.0);
    vec3 dz = vec3(0.0, (hu - hd) * ${HEIGHT_SCALE.toFixed(2)}, 2.0 * eps);
    vNormal = normalize(cross(dz, dx));

    // vWorldPos.xz doubles as the cell coordinate downstream (ground mesh
    // has no rotation/scale beyond buildGroundGeometry's own translate) -
    // the terrain-type lookup happens per-FRAGMENT, not here, so it stays a
    // crisp nearest-neighbour lookup (terrain type 1.5 isn't meaningful)
    // regardless of how coarse MESH_SEGMENTS is relative to GRID_SIZE.
    vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

// Mirrors terrain-renderer.js's colorFor: sea depth gradient, grass/sand/
// forest base colours, altitude-tinted rock (bare -> high -> snow), with
// slope-based rock bleed-through on top so a steep slope reads as rock
// scree even where the player painted grass - the
// @interverse/three-terrain-lod *idea* (slope/height-based material
// blending), hand-written against a standard ShaderMaterial instead of its
// TSL/WebGPU package (see CLAUDE.md).
const FRAGMENT_SHADER = `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vElevation;

  uniform sampler2D uHeight;
  uniform sampler2D uType;
  uniform float uGridSize;
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uAmbient;
  uniform float uSeaLevel;

  vec3 lerp3(vec3 a, vec3 b, float t) { return a + (b - a) * clamp(t, 0.0, 1.0); }

  vec3 rockColor(float elevation) {
    vec3 bare = vec3(118.0, 109.0, 98.0) / 255.0;
    vec3 high = vec3(168.0, 160.0, 150.0) / 255.0;
    vec3 snow = vec3(240.0, 242.0, 246.0) / 255.0;
    float toHigh = smoothstep(0.35, 0.65, elevation);
    vec3 base = lerp3(bare, high, toHigh);
    float toSnow = smoothstep(0.78, 0.95, elevation);
    return lerp3(base, snow, toSnow);
  }

  float rawElevationFS(vec2 cell) {
    vec2 uv = (cell + 0.5) / uGridSize;
    float t = texture2D(uHeight, uv).r;
    return ${texelToElevationRange()};
  }

  // Task 4 (ROADMAP.md): the raw per-cell type lookup below is a crisp,
  // deliberately un-interpolated index (texture2D on uType uses
  // NearestFilter - an interpolated index like 1.5 isn't a real type), which
  // is why the terrain-type boundary used to read as a hard, axis-aligned
  // blocky edge regardless of mesh density. This blends four whole, already-
  // resolved CORNER COLOURS instead of the raw index - standard bilinear
  // filtering applied one level up, after the categorical lookup rather than
  // before it, so it only ever produces a colour that's a real mix of real
  // neighbouring colours, never a meaningless fractional type. "fallback" is
  // always this fragment's own already-land-side colour (computed by the
  // caller before this runs): any corner that turns out to be sea-side is
  // replaced by it rather than contributing its own colour, so a coastal
  // fragment's blend degrades to fallback-only (today's exact behaviour) and
  // never actually mixes a land colour with a sea colour.
  vec3 paintColorForCell(vec2 cell, vec3 fallback) {
    float e = rawElevationFS(cell);
    if (e <= uSeaLevel) return fallback;
    vec2 uv = (cell + 0.5) / uGridSize;
    float typeRaw = texture2D(uType, uv).r;
    int ti = int(typeRaw * 255.0 + 0.5);
    vec3 grass = vec3(107.0, 142.0, 68.0) / 255.0;
    vec3 sand = vec3(222.0, 201.0, 148.0) / 255.0;
    vec3 forest = vec3(45.0, 86.0, 54.0) / 255.0;
    if (ti == 1) return sand;
    if (ti == 2) return forest;
    if (ti == 3) return rockColor(e);
    return grass;
  }

  vec3 blendedTypeColor(vec3 selfColor) {
    vec2 p = vec2(vWorldPos.x, vWorldPos.z);
    vec2 q = p - 0.5;
    vec2 c0 = floor(q);
    vec2 f = clamp(q - c0, 0.0, 1.0);
    vec3 c00 = paintColorForCell(c0, selfColor);
    vec3 c10 = paintColorForCell(c0 + vec2(1.0, 0.0), selfColor);
    vec3 c01 = paintColorForCell(c0 + vec2(0.0, 1.0), selfColor);
    vec3 c11 = paintColorForCell(c0 + vec2(1.0, 1.0), selfColor);
    return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
  }

  void main() {
    vec3 color;
    if (vElevation <= uSeaLevel) {
      vec3 deep = vec3(18.0, 38.0, 66.0) / 255.0;
      vec3 shallow = vec3(66.0, 120.0, 158.0) / 255.0;
      float t = smoothstep(-1.0, uSeaLevel, vElevation);
      color = lerp3(deep, shallow, t);
    } else {
      vec2 cellUv = (vec2(vWorldPos.x, vWorldPos.z) + 0.5) / uGridSize;
      float typeRaw = texture2D(uType, cellUv).r;
      int typeIndex = int(typeRaw * 255.0 + 0.5);
      vec3 grass = vec3(107.0, 142.0, 68.0) / 255.0;
      vec3 sand = vec3(222.0, 201.0, 148.0) / 255.0;
      vec3 forest = vec3(45.0, 86.0, 54.0) / 255.0;
      vec3 base = grass;
      if (typeIndex == 1) base = sand;
      else if (typeIndex == 2) base = forest;
      else if (typeIndex == 3) base = rockColor(vElevation);

      // Soften the raw per-cell type edge into a blended boundary (Task 4,
      // ROADMAP.md) - "base" above is also this blend's domain-safe
      // fallback, so a fragment right at the coastline degrades to exactly
      // today's crisp self-colour rather than pulling in a sea-side sample.
      base = blendedTypeColor(base);

      // Slope-based rock bleed-through: steep ground reads as scree/rock
      // regardless of painted type, the way a real relief map doesn't let
      // grass cling to a cliff face.
      float slope = 1.0 - clamp(normalize(vNormal).y, 0.0, 1.0);
      float rockBleed = smoothstep(0.35, 0.75, slope);
      base = lerp3(base, rockColor(vElevation), rockBleed);

      // Snow cap above a height threshold, independent of painted type.
      float snowLine = smoothstep(0.72, 0.95, vElevation);
      base = lerp3(base, vec3(240.0, 242.0, 246.0) / 255.0, snowLine * 0.85);

      color = base;
    }

    vec3 n = normalize(vNormal);
    float diffuse = max(0.0, dot(n, normalize(uLightDir)));
    // A hard floor()-quantized "toon band" was tried here for a more
    // painted look, but it quantizes any smoothly-varying surface into
    // visible parallel step-lines wherever the banding crosses an integer
    // boundary - starkly visible on the (intentionally smooth) sea, masked
    // only by coincidence on the already-noisy mountain detail. Smooth
    // Lambertian diffuse avoids the artifact; the painted look comes from
    // the colour ramps and slope-based material blending above instead.
    vec3 lit = color * (uAmbient + uLightColor * diffuse);
    gl_FragColor = vec4(lit, 1.0);
  }
`;

// A flat, static plane at sea level (Task 1, ROADMAP.md) - fixing the root
// cause of both "lowering the seabed lowers the water" and "coastlines form
// cliffs": there was no surface distinct from the seabed mesh itself. This
// plane never moves and never needs updating when elevation changes (that's
// the whole point); the seabed underneath can now be sculpted to any depth
// by Deepen/Shallow without the visible "water" ever dropping; the actual
// depth still reads visually through its transparency and the ground
// shader's own existing depth-based colour gradient. A real sunk coastline
// cliff is now simply occluded by this plane rather than exposed as bare
// mesh wall - standard depth-tested transparency, no special-casing needed
// since every land cell's displayed height is by definition above sea level
// and every sea cell's is at or below it.
function buildWaterPlaneGeometry() {
  const geometry = new THREE.PlaneGeometry(GRID_SIZE - 1, GRID_SIZE - 1, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate((GRID_SIZE - 1) / 2, 0, (GRID_SIZE - 1) / 2);
  return geometry;
}

function buildGroundGeometry() {
  const geometry = new THREE.PlaneGeometry(
    GRID_SIZE - 1,
    GRID_SIZE - 1,
    MESH_SEGMENTS,
    MESH_SEGMENTS,
  );
  geometry.rotateX(-Math.PI / 2);
  // PlaneGeometry is centered on the origin; shift so grid cell (0,0) sits
  // at world (0,0) and cell (GRID_SIZE-1, GRID_SIZE-1) at world
  // (GRID_SIZE-1, GRID_SIZE-1) - the same coordinate space the authoritative
  // elevationGrid uses, so picking needs no extra offset bookkeeping.
  geometry.translate((GRID_SIZE - 1) / 2, 0, (GRID_SIZE - 1) / 2);
  return geometry;
}

function createHeightTexture() {
  // Float32, not the 8-bit texture this used to be - see elevationToTexel's
  // own comment for the bug that caused (same-precision, no quantization
  // round-trip, matching the exact-float comparison Top-down always used).
  // WebGL2 (already required for this renderer - isWebGL2Available) always
  // supports FloatType textures with linear filtering, unlike WebGL1 where
  // that combination needs an extension.
  const data = new Float32Array(GRID_SIZE * GRID_SIZE);
  const texture = new THREE.DataTexture(data, GRID_SIZE, GRID_SIZE, THREE.RedFormat, THREE.FloatType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function createTypeTexture() {
  const data = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const texture = new THREE.DataTexture(data, GRID_SIZE, GRID_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  // Nearest: a terrain-type index must never be hardware-interpolated
  // between neighbours (index 1.5 isn't a type) - the shader does its own
  // slope/elevation blending on top of a crisp per-cell type lookup.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function fillHeightTexture(texture, elevationGrid) {
  const data = texture.image.data;
  for (let i = 0; i < elevationGrid.length; i++) data[i] = elevationToTexel(elevationGrid[i]);
  texture.needsUpdate = true;
}

function fillTypeTexture(texture, typeGrid) {
  texture.image.data.set(typeGrid);
  texture.needsUpdate = true;
}

// --- Trees --------------------------------------------------------------
// Forest cells get 1-2 instanced billboard trees each (two textures -
// deciduous/conifer - for variety), placed with a deterministic seeded
// jitter so positions are stable across redraws/clients without
// transmitting per-tree data. Rebuilt in full whenever any terrain-type
// edit lands (bounded by forest-cell count, not grid size - see PROCESS.md
// for why this is a simplification of the original dirty-rect-only plan).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TREE_TEXTURE_PATHS = ["/world/assets/tree-deciduous.png", "/world/assets/tree-conifer.png"];
const TREE_WORLD_HEIGHT = 2.6;
const TREE_WORLD_WIDTH = 2.0;

function buildTreeLayer(scene, textureLoader) {
  const geometry = new THREE.PlaneGeometry(TREE_WORLD_WIDTH, TREE_WORLD_HEIGHT);
  geometry.translate(0, TREE_WORLD_HEIGHT / 2, 0);

  const meshes = TREE_TEXTURE_PATHS.map((path) => {
    const texture = textureLoader.load(path);
    texture.colorSpace = THREE.SRGBColorSpace;
    // MeshLambertMaterial was tried first (the plan's original intent: tint
    // trees by the scene's real directional light so they sit in the same
    // lighting as the terrain). In practice the billboard's single fixed
    // face normal doesn't reliably face the light, so most instances came
    // out nearly black - unreadable, worse than the flat green fill this is
    // supposed to improve on. A flat, fixed daylight tint on an unlit
    // material keeps the authored canopy colours legible; it doesn't darken
    // in a mountain's shadow the way the ground does - a real limitation,
    // not a hidden one (see PROCESS.md).
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      color: new THREE.Color(0.95, 0.97, 0.88),
      transparent: true,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, 1);
    mesh.count = 0;
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  });

  // Placement data (world position/scale) is kept here, outside rebuild(),
  // so updateFacing() below can re-orient every instance toward a moving
  // camera without recomputing the (expensive, seeded-random) placement
  // pass itself - placement only changes on a terrain-type edit, facing
  // changes on every camera move, and they're deliberately decoupled.
  let placements = [[], []];

  function rebuild(elevationGrid, typeGrid) {
    const forestIndex = TERRAIN_TYPES.indexOf("forest");
    placements = [[], []];
    const rand = mulberry32(90125);
    // A tree per forest cell would crowd them into a solid dark mass at
    // TREE_WORLD_WIDTH's footprint (cells are 1 world unit apart, trees are
    // 2 wide) - skipping most cells spaces individual trees out enough to
    // actually read as scattered detail rather than a flat dark texture.
    const PLACEMENT_CHANCE = 0.22;
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (typeGrid[y * GRID_SIZE + x] !== forestIndex) continue;
        if (elevationGrid[y * GRID_SIZE + x] <= SEA_LEVEL) continue;
        if (rand() > PLACEMENT_CHANCE) continue;
        const jx = x + rand() * 0.8 - 0.4 + 0.5;
        const jz = y + rand() * 0.8 - 0.4 + 0.5;
        const h = sampleElevationBilinear(elevationGrid, jx, jz);
        const variant = rand() < 0.65 ? 0 : 1;
        const scale = 1.1 + rand() * 0.6;
        placements[variant].push({ x: jx, y: h * HEIGHT_SCALE, z: jz, scale });
      }
    }

    for (let v = 0; v < meshes.length; v++) {
      const mesh = meshes[v];
      const list = placements[v];
      if (list.length > mesh.instanceMatrix.count) {
        mesh.dispose?.();
        meshes[v] = new THREE.InstancedMesh(mesh.geometry, mesh.material, Math.max(1, list.length));
        scene.remove(mesh);
        scene.add(meshes[v]);
        meshes[v].castShadow = true;
      }
      meshes[v].count = list.length;
    }
  }

  // ROADMAP.md task 3: these were never real billboards (see the comment on
  // the material above) - each instance kept one fixed world orientation,
  // which only ever happened to face the camera because there used to be
  // exactly one fixed camera position. Now that the camera can sit at any
  // of 4 azimuths (or anywhere continuously via tilt), every instance's
  // rotation is recomputed here, each time the camera moves - a real
  // (Y-axis-only, so trees stay upright) billboard rotation, cheap enough
  // to redo in full every call since tree counts are bounded by forest-cell
  // count, same reasoning as the full-grid texture re-uploads elsewhere.
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scaleVec = new THREE.Vector3();
  const euler = new THREE.Euler();
  function updateFacing(camera) {
    for (let v = 0; v < meshes.length; v++) {
      const active = meshes[v];
      const list = placements[v];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const rotY = Math.atan2(camera.position.x - p.x, camera.position.z - p.z);
        euler.set(0, rotY, 0);
        quaternion.setFromEuler(euler);
        position.set(p.x, p.y, p.z);
        scaleVec.set(p.scale, p.scale, p.scale);
        matrix.compose(position, quaternion, scaleVec);
        active.setMatrixAt(i, matrix);
      }
      if (list.length > 0) active.instanceMatrix.needsUpdate = true;
    }
  }

  return { meshes, rebuild, updateFacing };
}

// --- Coastline ------------------------------------------------------------
function buildCoastlineLine(scene) {
  const material = new THREE.LineBasicMaterial({ color: 0x3c2f20, linewidth: 2, transparent: true, opacity: 0.85 });
  const group = new THREE.Group();
  scene.add(group);

  function rebuild(elevationGrid) {
    while (group.children.length) {
      const child = group.children.pop();
      child.geometry.dispose();
    }
    for (const ring of computeCoastlineRings(elevationGrid)) {
      const points = ring.map(([x, y]) => {
        const h = Math.max(SEA_LEVEL, sampleElevationBilinear(elevationGrid, x, y));
        return new THREE.Vector3(x, h * HEIGHT_SCALE + 0.05, y);
      });
      if (points.length < 2) continue;
      points.push(points[0]);
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      group.add(new THREE.Line(geometry, material));
    }
  }

  return { rebuild };
}

// --- Picking --------------------------------------------------------------
// A direct ray-heightfield march against the authoritative elevationGrid -
// not a raycast against the (detailed, GPU-only) visual mesh, so a paint
// stroke always lands on exactly the cell the stored data says is there.
function pickAgainstHeightfield(origin, direction, elevationGrid) {
  const maxHeight = HEIGHT_SCALE * ELEVATION_MAX + 1;
  const minHeight = HEIGHT_SCALE * ELEVATION_MIN - 1;
  // Intersect the ray with the grid's bounding box first, so the march only
  // covers the volume that could possibly contain the surface.
  let tMin = 0;
  let tMax = 1000;
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

  const STEPS = 256;
  const step = (tMax - tMin) / STEPS;
  let prevT = tMin;
  let prevDiff = null;
  for (let i = 0; i <= STEPS; i++) {
    const t = tMin + i * step;
    const x = origin.x + direction.x * t;
    const y = origin.y + direction.y * t;
    const z = origin.z + direction.z * t;
    if (x < 0 || x > GRID_SIZE - 1 || z < 0 || z > GRID_SIZE - 1) {
      prevT = t;
      prevDiff = null;
      continue;
    }
    const surfaceY = sampleElevationBilinear(elevationGrid, x, z) * HEIGHT_SCALE;
    const diff = y - surfaceY;
    if (prevDiff !== null && prevDiff > 0 && diff <= 0) {
      // Bisect between prevT and t for a tighter crossing estimate.
      let lo = prevT;
      let hi = t;
      for (let b = 0; b < 8; b++) {
        const mid = (lo + hi) / 2;
        const mx = origin.x + direction.x * mid;
        const mz = origin.z + direction.z * mid;
        const my = origin.y + direction.y * mid;
        const sy = sampleElevationBilinear(elevationGrid, mx, mz) * HEIGHT_SCALE;
        if (my - sy > 0) lo = mid;
        else hi = mid;
      }
      const hitX = origin.x + direction.x * hi;
      const hitZ = origin.z + direction.z * hi;
      const gx = Math.round(hitX);
      const gz = Math.round(hitZ);
      if (gx < 0 || gx >= GRID_SIZE || gz < 0 || gz >= GRID_SIZE) return null;
      return { x: gx, y: gz };
    }
    prevT = t;
    prevDiff = diff;
  }
  return null;
}

// Task 4 (ROADMAP.md): capped device-pixel-ratio rendering. Without this,
// the renderer's drawing buffer stayed at `logicalSize` physical pixels
// regardless of the display, so on any HiDPI screen (devicePixelRatio > 1,
// most laptops/phones) the browser had to upscale the rendered frame to
// fill the CSS box - producing a soft/blurry oblique view. `antialias: true`
// alone doesn't fix this: that's MSAA smoothing triangle edges *within* the
// undersized buffer, a different concern from the buffer itself being too
// small for the screen. Capped at 2x (not raw devicePixelRatio, which can be
// 3+) to bound the fill-rate/shader cost of a much denser backing store.
export const MAX_DEVICE_PIXEL_RATIO = 2;

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
  // `false` = don't touch canvas.style - world.css already fixes the CSS
  // display size; only the backing-store resolution (canvas.width/height)
  // should change with pixelRatio.
  renderer.setSize(logicalSize, logicalSize, false);

  renderer.setClearColor(0x11161b, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();

  const heightTexture = createHeightTexture();
  const typeTexture = createTypeTexture();
  fillHeightTexture(heightTexture, elevationGrid);
  fillTypeTexture(typeTexture, typeGrid);

  const groundMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uHeight: { value: heightTexture },
      uType: { value: typeTexture },
      uGridSize: { value: GRID_SIZE },
      uLightDir: { value: new THREE.Vector3(-0.5, 0.85, 0.35).normalize() },
      uLightColor: { value: new THREE.Color(1, 0.98, 0.92) },
      uAmbient: { value: new THREE.Color(0.38, 0.42, 0.48) },
      uSeaLevel: { value: SEA_LEVEL },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: THREE.DoubleSide,
  });
  const groundGeometry = buildGroundGeometry();
  const groundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
  scene.add(groundMesh);

  const waterGeometry = buildWaterPlaneGeometry();
  const waterMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.16, 0.34, 0.52),
    transparent: true,
    opacity: 0.82,
    roughness: 0.4,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  const waterMesh = new THREE.Mesh(waterGeometry, waterMaterial);
  // +0.05, matching the coastline ink-line's own epsilon just below - an
  // unpainted cell's ground-mesh vertex sits at exactly `base * HEIGHT_SCALE`
  // with no detail added (detailedHeight's own early return for
  // aboveSea <= 0.0001), which for an untouched cell is exactly 0, the same
  // y this plane used to sit at with zero offset. Two coplanar triangles at
  // an identical depth is a textbook z-fighting setup - GPU-dependent, but
  // reliably visible as horizontal banding across the water on the hardware
  // this was caught on (found immediately after fixing the Top-down/Oblique
  // land-sea mismatch above: that bug had been hiding this one, since sea
  // used to render as misclassified land almost everywhere, leaving this
  // plane mostly occluded rather than exposed and coplanar).
  waterMesh.position.y = SEA_LEVEL * HEIGHT_SCALE + 0.05;
  waterMesh.receiveShadow = true;
  scene.add(waterMesh);

  // A real DirectionalLight (not baked into the ground shader's own light
  // term) exists purely to cast shadows - the ground shader computes its own
  // diffuse term from uLightDir for consistent shading, but shadow-casting
  // needs an actual light/shadow-camera pair in the scene.
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.1);
  sun.position.set(-80, 160, 60);
  sun.target.position.set((GRID_SIZE - 1) / 2, 0, (GRID_SIZE - 1) / 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // Without a bias, a surface self-shadows in stripes following its own
  // triangle diagonals ("shadow acne") - most visible on the near-flat sea,
  // which should never show it at all.
  sun.shadow.bias = -0.0015;
  sun.shadow.normalBias = 0.6;
  const shadowCam = sun.shadow.camera;
  shadowCam.left = -160;
  shadowCam.right = 160;
  shadowCam.top = 160;
  shadowCam.bottom = -160;
  shadowCam.near = 1;
  shadowCam.far = 400;
  scene.add(sun);
  scene.add(sun.target);
  groundMesh.castShadow = true;
  groundMesh.receiveShadow = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  const textureLoader = new THREE.TextureLoader();
  const trees = buildTreeLayer(scene, textureLoader);
  trees.rebuild(elevationGrid, typeGrid);

  const coastline = buildCoastlineLine(scene);
  coastline.rebuild(elevationGrid);

  // --- Camera (ROADMAP.md task 3) -----------------------------------------
  // A parametric orthographic camera - azimuth (4 fixed presets), tilt
  // (continuous), zoom and pan - replacing what used to be a handful of
  // fixed constants. `azimuthIndex 1` ("s-n", angleDeg 0) reproduces the
  // exact camera position this renderer always had, so nothing about the
  // default look changes unless a control is touched.
  const GRID_CENTER = new THREE.Vector3((GRID_SIZE - 1) / 2, 0, (GRID_SIZE - 1) / 2);
  // Orthographic - distance only matters for near/far planes and shadow
  // setup, never apparent size (that's viewSize/zoom below), so this stays
  // a fixed constant generous enough for any zoom level.
  const DISTANCE = 260;
  // Degrees from vertical (0 = directly overhead/top-down, 90 = fully
  // horizontal/grazing) - matches the original fixed camera's own
  // convention exactly, just made continuous. Kept off exactly 0/90 so the
  // ray-march's bounding-box math never degenerates.
  const MIN_TILT_DEG = 12; // near-top-down
  const MAX_TILT_DEG = 82; // near-horizontal, a low dramatic side view
  const DEFAULT_TILT_DEG = 58; // matches the original fixed camera's angle
  const MIN_ZOOM = 0.4;
  const MAX_ZOOM = 3;
  const FIT_MARGIN = 1.12; // breathing room beyond the tightest possible fit
  const AZIMUTH_PRESETS = [
    { id: "n-s", label: "N→S", angleDeg: 180 },
    { id: "s-n", label: "S→N", angleDeg: 0 },
    { id: "e-w", label: "E→W", angleDeg: 90 },
    { id: "w-e", label: "W→E", angleDeg: 270 },
  ];
  const DEFAULT_AZIMUTH_INDEX = 1; // "s-n" - today's unchanged default

  const camView = {
    // Continuous now (ROADMAP.md task 3 revisit: free 360 deg rotation, not
    // just 4 snapped presets) - degrees, wrapped into [0, 360). The 4 preset
    // buttons remain as shortcuts (setAzimuthPreset below), not the only way
    // to set this.
    azimuthDeg: AZIMUTH_PRESETS[DEFAULT_AZIMUTH_INDEX].angleDeg,
    tiltDeg: DEFAULT_TILT_DEG,
    zoom: 1,
    // A full 3D offset (not two scalars decomposed back onto world X/Z) so
    // panning along the camera's own "up" screen axis is exact at any tilt:
    // that axis has a real world-Y component once the camera is tilted, and
    // the previous panX/panZ-only representation silently dropped it. Kept
    // as the camera's look-at center's offset from GRID_CENTER.
    panOffset: new THREE.Vector3(0, 0, 0),
    baseViewSize: GRID_SIZE * 0.62, // overwritten by fitView() before first render
  };

  const aspect = canvas.width / canvas.height || 1;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 800);

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // Recomputes camera position/orientation/frustum from camView - the one
  // function every control below goes through, so "the camera" is always
  // fully determined by that one small state object.
  function applyCameraState() {
    const angleRad = (camView.azimuthDeg * Math.PI) / 180;
    const tiltRad = (camView.tiltDeg * Math.PI) / 180;
    // Degrees-from-vertical convention (see MIN_TILT_DEG above): vertical
    // offset shrinks and horizontal offset grows as tilt increases from 0
    // (overhead) toward 90 (grazing) - cos/sin, not swapped.
    const horizontal = DISTANCE * Math.sin(tiltRad);
    const vertical = DISTANCE * Math.cos(tiltRad);
    const center = GRID_CENTER.clone().add(camView.panOffset);
    camera.position.set(
      center.x + horizontal * Math.sin(angleRad),
      center.y + vertical,
      center.z + horizontal * Math.cos(angleRad),
    );
    camera.lookAt(center);
    camera.updateMatrixWorld();

    const viewSize = camView.baseViewSize / camView.zoom;
    const halfH = viewSize / 2;
    camera.left = -halfH * aspect;
    camera.right = halfH * aspect;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
  }

  // Sizes baseViewSize so the *actually painted* elevation range (not the
  // theoretical min/max) fits the current azimuth/tilt with margin, fixing
  // the known clipping bug as a side effect of always framing correctly
  // rather than as a one-off constant tweak. Projects the data's bounding
  // box into the camera's own right/up axes (read directly off its world
  // matrix, which applyCameraState() above already keeps current) - the
  // standard way to size an orthographic frustum around a 3D box, not
  // guessed from the grid footprint alone, since a low tilt needs much more
  // vertical frustum room for the same mountain than a near-top-down one
  // does.
  // Only ever called from three places (see createTerrainScene3D's return
  // value and world-client.js's wireCameraControls): initial load and the
  // explicit "Reset / Fit view" button. Revisited camera-controls task: an
  // azimuth/tilt change used to call this too (auto-refit on every
  // direction/tilt change), which the user explicitly asked to stop -
  // rotating, tilting, zooming and panning must now preserve each other's
  // state and never silently reset the camera. fitView() itself still needs
  // to zero zoom/pan while it measures the fit, since "fit" means exactly
  // "forget the current zoom/pan and reframe" - that's what the button is
  // for.
  function fitView(currentElevationGrid) {
    let minE = Infinity;
    let maxE = -Infinity;
    for (let i = 0; i < currentElevationGrid.length; i++) {
      const e = currentElevationGrid[i];
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
    }
    if (!Number.isFinite(minE)) {
      minE = ELEVATION_MIN;
      maxE = ELEVATION_MAX;
    }
    const minY = minE * HEIGHT_SCALE;
    const maxY = maxE * HEIGHT_SCALE;

    camView.zoom = 1;
    camView.panOffset.set(0, 0, 0);
    applyCameraState(); // so the right/up axes below reflect the current azimuth/tilt

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
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (u < minU) minU = u;
          if (u > maxU) maxU = u;
        }
      }
    }
    const neededHeight = (maxU - minU) * FIT_MARGIN;
    const neededWidth = (maxR - minR) * FIT_MARGIN;
    camView.baseViewSize = Math.max(neededHeight, neededWidth / aspect, GRID_SIZE * 0.1);
    applyCameraState();
  }

  function wrapDeg(deg) {
    return ((deg % 360) + 360) % 360;
  }

  // Free, continuous rotation (360 deg) - the compass dial in the toolbar
  // drives this directly with the pointer's absolute angle around the dial.
  // Deliberately does NOT call fitView(): see the comment on fitView above.
  function setAzimuth(deg) {
    camView.azimuthDeg = wrapDeg(deg);
    applyCameraState();
  }

  // The four direction buttons remain as named shortcuts onto the same
  // continuous azimuth the dial controls - not a separate discrete mode.
  function setAzimuthPreset(index) {
    setAzimuth(AZIMUTH_PRESETS[clamp(index, 0, AZIMUTH_PRESETS.length - 1)].angleDeg);
  }

  function setTilt(deg) {
    camView.tiltDeg = clamp(deg, MIN_TILT_DEG, MAX_TILT_DEG);
    applyCameraState();
  }

  function setZoom(factor) {
    camView.zoom = clamp(factor, MIN_ZOOM, MAX_ZOOM);
    applyCameraState();
  }

  // Cursor-centred zoom (wheel): keeps the world point under the pointer
  // fixed on screen, rather than zooming about the view center the way the
  // slider does. ndcX/ndcY are in [-1, 1] clip-space, the same convention
  // THREE.Raycaster.setFromCamera uses. Derivation: for an orthographic
  // camera, the world point under a clip-space offset (ndcX, ndcY) from the
  // look-at center is `center + right*ndcX*halfWidth + up*ndcY*halfHeight`,
  // where half-width/height scale linearly with viewSize (1/zoom). Solving
  // for the new panOffset that keeps that same world point under the same
  // ndcX/ndcY after zoom changes from `oldZoom` to `newZoom` reduces to
  // shifting panOffset by `(right*offsetR + up*offsetU) * (1 - oldZoom/newZoom)`
  // - i.e. only the *ratio* of old to new zoom matters, not the absolute
  // view size.
  function zoomAtCursor(zoomDeltaFactor, ndcX, ndcY) {
    const oldZoom = camView.zoom;
    const newZoom = clamp(oldZoom * zoomDeltaFactor, MIN_ZOOM, MAX_ZOOM);
    if (newZoom === oldZoom) return;
    const viewSize = camView.baseViewSize / oldZoom;
    const halfWidth = (viewSize * aspect) / 2;
    const halfHeight = viewSize / 2;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const offsetR = ndcX * halfWidth;
    const offsetU = ndcY * halfHeight;
    const ratio = 1 - oldZoom / newZoom;
    camView.panOffset.addScaledVector(right, offsetR * ratio);
    camView.panOffset.addScaledVector(up, offsetU * ratio);
    camView.zoom = newZoom;
    applyCameraState();
  }

  // dRight/dUp are fractions of the current view size, in the camera's own
  // screen-aligned right/up directions (not raw world axes), so "pan right"
  // means the same thing on screen regardless of which azimuth/tilt is
  // currently active. Using the full 3D up vector (not just its X/Z, which
  // an earlier version of this silently dropped) matters once the camera is
  // tilted: screen-"up" then has a real world-Y component. Called
  // continuously with small per-pointermove fractions by the toolbar's drag
  // trackpad, which is what makes panning precise while zoomed in (the
  // fraction is always relative to what's actually on screen right now)
  // rather than a fixed-size nudge per click.
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

  // fitView() needs the current elevationGrid but is also called from
  // setAzimuth/setTilt, which don't otherwise receive it - updateHeight()
  // below keeps this reference current the same way it already does for
  // the coastline rebuild.
  let currentElevationGridRef = elevationGrid;
  fitView(currentElevationGridRef);

  function render() {
    trees.updateFacing(camera);
    renderer.render(scene, camera);
  }

  function setAspect() {
    // Canvas is always square (GRID_SIZE * CELL_PX on each side) in
    // practice, so `aspect` above never actually changes after creation;
    // kept as a no-op entry point (rather than removed) in case that
    // changes later - re-deriving it would need re-running fitView() too.
  }

  function updateHeight(currentElevationGrid) {
    currentElevationGridRef = currentElevationGrid;
    fillHeightTexture(heightTexture, currentElevationGrid);
    coastline.rebuild(currentElevationGrid);
  }

  function updateType(currentElevationGrid, currentTypeGrid) {
    fillTypeTexture(typeTexture, currentTypeGrid);
    trees.rebuild(currentElevationGrid, currentTypeGrid);
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  // px, py in canvas backing-store pixels (same convention world-client.js
  // already uses for the top-down/old-oblique pick functions). Needs no
  // change for any camera state: it reads whatever `camera`'s current
  // position/orientation actually is, the same object every control above
  // mutates in place.
  function pick(px, py, currentElevationGrid) {
    ndc.x = (px / canvas.width) * 2 - 1;
    ndc.y = -(py / canvas.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return pickAgainstHeightfield(raycaster.ray.origin, raycaster.ray.direction, currentElevationGrid);
  }

  function dispose() {
    groundGeometry.dispose();
    groundMaterial.dispose();
    waterGeometry.dispose();
    waterMaterial.dispose();
    heightTexture.dispose();
    typeTexture.dispose();
    renderer.dispose();
  }

  return {
    render,
    updateHeight,
    updateType,
    pick,
    setAspect,
    dispose,
    setAzimuth,
    setAzimuthPreset,
    setTilt,
    setZoom,
    zoomAtCursor,
    panBy,
    fitView: () => fitView(currentElevationGridRef),
    getCameraState,
  };
}
