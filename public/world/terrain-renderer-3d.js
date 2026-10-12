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
import { GRID_SIZE, ELEVATION_MIN, ELEVATION_MAX, SEA_LEVEL, TERRAIN_TYPES } from "./terrain-model.js";
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

function elevationToTexel(elevation) {
  const t = (elevation - ELEVATION_MIN) / (ELEVATION_MAX - ELEVATION_MIN);
  return Math.round(Math.min(1, Math.max(0, t)) * 255);
}

// texture2D(...).r on an 8-bit UnsignedByteType texture already comes back
// hardware-normalized to [0, 1] - NOT the raw 0-255 integer - so this must
// not divide by 255 again (an earlier version of this did, which collapsed
// every sampled height to ~ELEVATION_MIN regardless of the real data: the
// bug that first made the whole mesh render as flat deep sea).
function texelToElevationRange() {
  return `t * ${(ELEVATION_MAX - ELEVATION_MIN).toFixed(6)} + ${ELEVATION_MIN.toFixed(6)}`;
}

// Bilinearly samples the authoritative (un-detailed) grid directly - used by
// both tree placement and picking, which must agree with what's actually
// stored, not the GPU-only ridge detail.
function sampleElevationBilinear(elevationGrid, x, y) {
  const cx = Math.min(GRID_SIZE - 1.001, Math.max(0, x));
  const cy = Math.min(GRID_SIZE - 1.001, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(GRID_SIZE - 1, x0 + 1);
  const y1 = Math.min(GRID_SIZE - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = elevationGrid[y0 * GRID_SIZE + x0];
  const b = elevationGrid[y0 * GRID_SIZE + x1];
  const c = elevationGrid[y1 * GRID_SIZE + x0];
  const d = elevationGrid[y1 * GRID_SIZE + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
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
  // elevation: ridged noise at sub-cell frequency, scaled by slope and
  // elevation-above-sea-level so plains/sea stay smooth and only
  // slopes/peaks get real jagged relief (correction: this perturbs actual
  // geometry, not just a lighting term).
  float detailedHeight(vec2 cell, float base) {
    float aboveSea = max(0.0, base - ${SEA_LEVEL.toFixed(6)});
    if (aboveSea <= 0.0001) return base;
    float slopeGate = smoothstep(0.02, 0.18, aboveSea);
    float amplitude = 0.05 + 0.22 * smoothstep(0.1, 0.9, aboveSea);
    float n = (fractalFold(cell * 1.0) - 0.5) * 2.0;
    return base + n * amplitude * slopeGate;
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
  const data = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const texture = new THREE.DataTexture(data, GRID_SIZE, GRID_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
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
    scene.add(mesh);
    return mesh;
  });

  function rebuild(elevationGrid, typeGrid) {
    const forestIndex = TERRAIN_TYPES.indexOf("forest");
    const placements = [[], []];
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

    const matrix = new THREE.Matrix4();
    for (let v = 0; v < meshes.length; v++) {
      const mesh = meshes[v];
      const list = placements[v];
      if (list.length > mesh.instanceMatrix.count) {
        mesh.dispose?.();
        meshes[v] = new THREE.InstancedMesh(mesh.geometry, mesh.material, Math.max(1, list.length));
        scene.remove(mesh);
        scene.add(meshes[v]);
      }
      const active = meshes[v];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        matrix.makeScale(p.scale, p.scale, p.scale);
        matrix.setPosition(p.x, p.y, p.z);
        active.setMatrixAt(i, matrix);
      }
      active.count = list.length;
      active.instanceMatrix.needsUpdate = true;
    }
  }

  return { meshes, rebuild };
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

export function createTerrainScene3D(canvas, elevationGrid, typeGrid) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, context: canvas.getContext("webgl2") });
  } catch {
    return null;
  }
  if (!renderer) return null;

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
  waterMesh.position.y = SEA_LEVEL * HEIGHT_SCALE;
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
  for (const mesh of trees.meshes) {
    mesh.castShadow = true;
  }

  const coastline = buildCoastlineLine(scene);
  coastline.rebuild(elevationGrid);

  // Fixed orthographic camera: a genuinely inclined 3D view, not a shear.
  // Angle/distance tuned empirically against research/visual-references/.
  const center = new THREE.Vector3((GRID_SIZE - 1) / 2, 0, (GRID_SIZE - 1) / 2);
  const aspect = canvas.width / canvas.height || 1;
  const viewSize = GRID_SIZE * 0.62;
  const camera = new THREE.OrthographicCamera(
    (-viewSize * aspect) / 2,
    (viewSize * aspect) / 2,
    viewSize / 2,
    -viewSize / 2,
    0.1,
    800,
  );
  const distance = 260;
  const tiltFromVertical = (58 * Math.PI) / 180;
  camera.position.set(
    center.x,
    center.y + distance * Math.cos(tiltFromVertical),
    center.z + distance * Math.sin(tiltFromVertical),
  );
  camera.lookAt(center);
  camera.updateMatrixWorld();

  function setAspect(width, height) {
    const a = width / height;
    const halfH = viewSize / 2;
    camera.left = -halfH * a;
    camera.right = halfH * a;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
  }

  function render() {
    renderer.render(scene, camera);
  }

  function updateHeight(currentElevationGrid) {
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
  // already uses for the top-down/old-oblique pick functions).
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

  return { render, updateHeight, updateType, pick, setAspect, dispose };
}
