// Walls, palisades and roads (src/paths.ts), drawn from the line a person
// drew rather than placed piece by piece. Map editors that do this well -
// Dungeondraft's wall and path tools, Wonderdraft's paths, and the
// "spline + fitted segments" approach of game level editors - share one
// idea: the person draws the line, the editor fits the pieces. Here:
//
//  - A stone wall is fitted with the KayKit wall piece (CC0, the same pack
//    as the buildings): each run is cut into whole pieces, each piece
//    stretched a little to fit exactly and sheared to follow the slope, so
//    a wall climbs a hill instead of floating off it or stepping through it.
//  - Towers stand at the corners, the open ends, and every few pieces along
//    a long run - the rhythm of a real curtain wall.
//  - Wherever a road crosses a wall, the piece it crosses becomes a gate,
//    flanked by two towers. A gate is never placed by hand, so it can never
//    end up where no road goes.
//  - A palisade is the same line in sharpened timber stakes.
//  - A road is a ribbon of packed earth with wheel ruts, smoothed through
//    the drawn points and draped over the displayed surface. Over water it
//    becomes a timber causeway at the water line.
//
// Everything is rebuilt from the path list and the levelled surface, so it
// always agrees with the ground the scene draws.
import * as THREE from "./vendor/three/three.module.js";
import { GLTFLoader } from "./vendor/three/GLTFLoader.js";
import { sampleSurface, HEIGHT_SCALE } from "./terrain-fields.js";

const DIR = "/world/assets/kaykit-medieval/";
// Cells per model unit. A KayKit wall piece is 2 units long and 1.1 tall:
// 3.4 cells long and ~1.9 tall here - a little under a cottage's eaves.
const WALL_UNIT = 1.7;
const TOWER_UNIT = 2.0;
// How far a piece sits into the ground, so a dip under its middle never
// shows daylight.
const SINK = 0.35;
// A tower every this many pieces along a long straight run.
const TOWER_EVERY = 4;
// A turn sharper than this gets a tower.
const CORNER_DEG = 22;
const ROAD_HALF = 0.8;
const ROAD_STEP = 0.5;
const STAKE_GAP = 0.36;
const STAKE_HEIGHT = 1.35;

// Colours sampled from the pack's atlas (hexagons_medieval.png), so the
// timber and earth sit in the same family as the buildings.
const TIMBER = new THREE.Color("#8a5a32");
const TIMBER_TIP = new THREE.Color("#b07a45");
const EARTH = new THREE.Color("#b6915e");
const EARTH_RUT = new THREE.Color("#94714a");
const EARTH_CROWN = new THREE.Color("#c4a26e");
const PLANK = new THREE.Color("#7a5232");

const PIECES = {
  wall: { file: "wall_straight", unit: WALL_UNIT },
  gate: { file: "wall_straight_gate", unit: WALL_UNIT },
  tower: { file: "building_tower_A_red", unit: TOWER_UNIT },
};

// A loaded model as a list of (geometry, material, matrix): centred on its
// footprint, base at y = 0, its long side along +x. Instancing draws each
// part once for every piece on the map.
function partsOf(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const along = box.max.x - box.min.x >= box.max.z - box.min.z;
  const centre = new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const turn = along ? new THREE.Matrix4() : new THREE.Matrix4().makeRotationY(Math.PI / 2);
  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material.metalness = 0;
    o.material.roughness = 1;
    parts.push({ geometry: o.geometry, material: o.material, matrix: turn.clone().multiply(centre).multiply(o.matrixWorld) });
  });
  return parts;
}

// One sharpened stake: a hexagonal post with a pointed top, base at y = 0.
function stakeParts() {
  const post = new THREE.CylinderGeometry(0.2, 0.22, 1, 6);
  post.translate(0, 0.5, 0);
  const tip = new THREE.ConeGeometry(0.2, 0.36, 6);
  tip.translate(0, 1.16, 0);
  const flat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, flatShading: true });
  return [
    { geometry: post, material: flat(TIMBER), matrix: new THREE.Matrix4() },
    { geometry: tip, material: flat(TIMBER_TIP), matrix: new THREE.Matrix4() },
  ];
}

// A batch of instances of one model: grows as needed, and remembers which
// path each instance belongs to, so a click on any piece selects its path.
function instanceSet(scene, parts, onPick) {
  let capacity = 0;
  let meshes = [];
  let owners = [];
  const tmp = new THREE.Matrix4();
  function ensure(n) {
    if (n <= capacity) return;
    for (const m of meshes) {
      scene.remove(m);
      m.dispose();
    }
    capacity = Math.max(64, n * 2);
    meshes = parts.map((p) => {
      const m = new THREE.InstancedMesh(p.geometry, p.material, capacity);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.userData.pathPick = onPick;
      m.userData.owners = () => owners;
      scene.add(m);
      return m;
    });
  }
  function set(list) {
    ensure(list.length);
    owners = list.map((e) => e.id);
    meshes.forEach((m, k) => {
      list.forEach((e, i) => m.setMatrixAt(i, tmp.multiplyMatrices(e.matrix, parts[k].matrix)));
      m.count = list.length;
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    });
  }
  return { set, meshes: () => meshes };
}

// Centripetal-ish Catmull-Rom through the drawn points, sampled every
// `step` cells: a road reads as a road, not a chain of straight segments.
function smoothLine(points, closed, step) {
  const pts = points.map(([x, y]) => new THREE.Vector3(x, 0, y));
  if (pts.length < 2) return [];
  const curve = new THREE.CatmullRomCurve3(pts, closed, "centripetal");
  const n = Math.max(2, Math.ceil(curve.getLength() / step));
  return curve.getSpacedPoints(n).map((v) => [v.x, v.z]);
}

function segmentsCross(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

const segmentsOf = (p) => {
  const out = [];
  for (let i = 0; i + 1 < p.points.length; i++) out.push([p.points[i], p.points[i + 1]]);
  if (p.closed) out.push([p.points.at(-1), p.points[0]]);
  return out;
};

export function createPathLayer(scene, { onChange }) {
  const loader = new GLTFLoader();
  const paths = new Map(); // id -> path data
  let draft = null; // the line being drawn, as a path with id -1
  let surface = null;
  let selected = null;
  let anchors = []; // towers and castles placed as places: walls end on them
  // Chart view tilts places back towards the overhead camera, as map
  // symbols (terrain-renderer-3d.js CHART_LEAN). Towers do the same; wall
  // runs don't - a leaned run foreshortens unevenly with its direction and
  // breaks into separate slabs, while a crenellated band seen from above
  // is how hand-drawn town plans show a wall anyway.
  let lean = 0;
  const sets = {}; // piece kind -> instanceSet
  const roads = new Map(); // id -> mesh
  let clearance = [];

  const roadMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    roughness: 1,
    metalness: 0,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  // Handles on the selected path's points, and dots on the draft's.
  const handleGeo = new THREE.SphereGeometry(0.45, 12, 8);
  const handleMat = new THREE.MeshBasicMaterial({ color: 0xe0b55a, depthTest: false, transparent: true, opacity: 0.95 });
  const handles = new THREE.Group();
  handles.renderOrder = 11;
  scene.add(handles);
  const guideMat = new THREE.LineBasicMaterial({ color: 0xe0b55a, depthTest: false, transparent: true, opacity: 0.9 });
  let guide = null;

  const ready = Promise.all(
    Object.entries(PIECES).map(
      ([kind, def]) =>
        new Promise((resolve) => {
          loader.load(
            DIR + def.file + ".gltf",
            (gltf) => {
              sets[kind] = instanceSet(scene, partsOf(gltf.scene), kind);
              resolve();
            },
            undefined,
            () => resolve(),
          );
        }),
    ),
  ).then(() => {
    sets.stake = instanceSet(scene, stakeParts(), "stake");
    rebuild();
  });

  const groundAt = (x, y) => (surface ? Math.max(0, sampleSurface(surface, x, y) * HEIGHT_SCALE) : 0);

  // A piece from a to b (map cells), base following the ground at both
  // ends: stretched to length, sheared to the slope.
  function pieceMatrix(a, b, unit, modelLength) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1e-6;
    const ex = dx / len;
    const ez = dz / len;
    const ha = groundAt(a[0], a[1]);
    const hb = groundAt(b[0], b[1]);
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    const hm = groundAt(mx, mz);
    const base = Math.min(hm, (ha + hb) / 2) - SINK;
    const sx = len / modelLength;
    const kw = (hb - ha) / len;
    return new THREE.Matrix4().set(
      ex * sx, 0, -ez * unit, mx,
      kw * sx, unit, 0, base,
      ez * sx, 0, ex * unit, mz,
      0, 0, 0, 1,
    );
  }

  // Lean about the base, towards the viewer (+z in Chart view).
  const leaned = (m) => (lean ? m.multiply(new THREE.Matrix4().makeRotationX(-lean)) : m);

  const towerMatrix = ([x, y], unit = TOWER_UNIT) =>
    leaned(new THREE.Matrix4().makeTranslation(x, groundAt(x, y) - SINK, y)).multiply(new THREE.Matrix4().makeScale(unit, unit, unit));

  function nearAnchor([x, y], r) {
    return anchors.some((a) => Math.hypot(a.x - x, a.y - y) < r);
  }

  // Where every road crosses every wall: [path id, segment index, t].
  function gateCrossings(list) {
    const roadsList = list.filter((p) => p.kind === "road").map((p) => smoothLine(p.points, p.closed, ROAD_STEP));
    const out = [];
    for (const wall of list) {
      if (wall.kind === "road") continue;
      segmentsOf(wall).forEach(([a, b], si) => {
        for (const line of roadsList) {
          for (let k = 0; k + 1 < line.length; k++) {
            const t = segmentsCross(a, b, line[k], line[k + 1]);
            if (t !== null) out.push({ id: wall.id, si, t });
          }
        }
      });
    }
    return out;
  }

  function rebuild() {
    if (!sets.wall) return;
    const list = [...paths.values()];
    if (draft) list.push(draft);
    const crossings = gateCrossings(list);
    const batches = { wall: [], gate: [], tower: [], stake: [] };
    const towerSpots = [];
    const gateFlanks = [];
    const intervals = [];
    clearance = [];
    const addTower = (p, id, gateFlank = false) => {
      if (nearAnchor(p, 2.5)) return; // a placed tower or castle already stands here
      // Towers closer than a wall piece crowd each other; a gate's own pair
      // sits exactly one piece apart, so it's allowed.
      if (towerSpots.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < (gateFlank ? 1.6 : 2 * WALL_UNIT + 0.2))) return;
      towerSpots.push(p);
      batches.tower.push({ id, matrix: towerMatrix(p) });
    };

    for (const p of list) {
      if (p.kind === "road") continue;
      const segs = segmentsOf(p);
      segs.forEach(([a, b], si) => {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const rot = Math.atan2(b[1] - a[1], b[0] - a[0]);
        clearance.push({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, hx: len / 2, hz: 0.6, rot, level: 0 });
        if (p.kind === "palisade") {
          const n = Math.max(1, Math.round(len / STAKE_GAP));
          for (let i = 0; i <= n; i++) {
            if (i === n && (p.closed || si < segs.length - 1)) continue; // the next run starts here
            const t = i / n;
            const x = a[0] + (b[0] - a[0]) * t;
            const y = a[1] + (b[1] - a[1]) * t;
            // A little irregular, as split timber is.
            const h = STAKE_HEIGHT * (0.88 + 0.24 * Math.abs(Math.sin(x * 12.9898 + y * 78.233) % 1));
            const gateHere = crossings.some((c) => c.id === p.id && c.si === si && Math.abs(c.t - t) * len < 0.9);
            if (gateHere) continue; // an opening where the road goes through
            const m = leaned(new THREE.Matrix4().makeTranslation(x, groundAt(x, y) - 0.15, y));
            m.multiply(new THREE.Matrix4().makeRotationY(x * 3.1 + y));
            m.multiply(new THREE.Matrix4().makeScale(1, h, 1));
            batches.stake.push({ id: p.id, matrix: m });
          }
          return;
        }
        // Pieces along the run: a gate-length piece centred on each place
        // a road crosses, and whole wall pieces filling the stretches
        // between (each stretched a little to fit exactly).
        const pieceLen = 2 * WALL_UNIT;
        const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const gateTs = crossings
          .filter((c) => c.id === p.id && c.si === si)
          .map((c) => Math.min(1 - pieceLen / 2 / len, Math.max(pieceLen / 2 / len, c.t)))
          .sort((u, v) => u - v)
          .filter((t, k, all) => k === 0 || (t - all[k - 1]) * len >= pieceLen);
        if (len < pieceLen) gateTs.length = 0;
        let from = 0;
        const fill = (t0, t1) => {
          const n = Math.max(1, Math.round(((t1 - t0) * len) / pieceLen));
          if ((t1 - t0) * len < 0.4) return;
          for (let i = 0; i < n; i++) {
            const s0 = at(t0 + ((t1 - t0) * i) / n);
            const e0 = at(t0 + ((t1 - t0) * (i + 1)) / n);
            batches.wall.push({ id: p.id, matrix: pieceMatrix(s0, e0, WALL_UNIT, 2) });
            if (i > 0 && i % TOWER_EVERY === 0 && n - i >= 2) intervals.push(s0);
          }
        };
        for (const t of gateTs) {
          const h = pieceLen / 2 / len;
          fill(from, t - h);
          const s0 = at(t - h);
          const e0 = at(t + h);
          batches.gate.push({ id: p.id, matrix: pieceMatrix(s0, e0, WALL_UNIT, 2) });
          gateFlanks.push(s0, e0);
          from = t + h;
        }
        fill(from, 1);
      });
      // Gate towers first, so a corner beside a gate doesn't add a third.
      for (const f of gateFlanks.splice(0)) addTower(f, p.id, true);
      // Corners and open ends, then the towers along long runs.
      const pts = p.points;
      pts.forEach((pt, i) => {
        const open = !p.closed && (i === 0 || i === pts.length - 1);
        if (open) return addTower(pt, p.id);
        const prev = pts[(i - 1 + pts.length) % pts.length];
        const next = pts[(i + 1) % pts.length];
        const turn = Math.abs(
          Math.atan2(
            (pt[0] - prev[0]) * (next[1] - pt[1]) - (pt[1] - prev[1]) * (next[0] - pt[0]),
            (pt[0] - prev[0]) * (next[0] - pt[0]) + (pt[1] - prev[1]) * (next[1] - pt[1]),
          ),
        );
        if (p.kind === "wall" && turn > (CORNER_DEG * Math.PI) / 180) addTower(pt, p.id);
      });
      for (const t of intervals.splice(0)) addTower(t, p.id);
    }
    // Palisades get no stone towers; their stakes are batched above.
    for (const [kind, list2] of Object.entries(batches)) sets[kind]?.set(list2);

    // Roads.
    const live = new Set();
    for (const p of list) {
      if (p.kind !== "road") continue;
      live.add(p.id);
      const old = roads.get(p.id);
      if (old) {
        scene.remove(old);
        old.geometry.dispose();
      }
      const mesh = roadMesh(p);
      roads.set(p.id, mesh);
      scene.add(mesh);
      for (const [a, b] of segmentsOf(p)) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        clearance.push({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, hx: len / 2, hz: ROAD_HALF + 0.3, rot: Math.atan2(b[1] - a[1], b[0] - a[0]), level: 0 });
      }
    }
    for (const [id, mesh] of roads) {
      if (live.has(id)) continue;
      scene.remove(mesh);
      mesh.geometry.dispose();
      roads.delete(id);
    }
    drawHandles();
    onChange();
  }

  // Seven vertices across: a soft edge into the grass, two darker wheel
  // ruts, a paler crown. Over water: a plank causeway at the water line.
  const ACROSS = [-1.45, -1, -0.45, 0, 0.45, 1, 1.45];
  const ALPHA = [0, 0.92, 1, 1, 1, 0.92, 0];
  const SHADE = [EARTH, EARTH, EARTH_RUT, EARTH_CROWN, EARTH_RUT, EARTH, EARTH];
  function roadMesh(p) {
    const line = smoothLine(p.points, p.closed, ROAD_STEP);
    const pos = [];
    const col = [];
    const idx = [];
    const W = ACROSS.length;
    line.forEach(([x, y], i) => {
      const a = line[Math.max(0, i - 1)];
      const b = line[Math.min(line.length - 1, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / len;
      const ny = (b[0] - a[0]) / len;
      const wet = surface ? sampleSurface(surface, x, y) <= 0.004 : false;
      ACROSS.forEach((o, k) => {
        const px = x + nx * o * ROAD_HALF * (wet ? 0.8 : 1);
        const py = y + ny * o * ROAD_HALF * (wet ? 0.8 : 1);
        const h = wet ? 0.3 : groundAt(px, py) + 0.04;
        pos.push(px, h, py);
        const c = wet ? PLANK : SHADE[k];
        // Faint mottling along the way, so a long road isn't a printed stripe.
        const m = 0.94 + 0.06 * Math.sin(x * 1.7 + y * 2.3 + k);
        col.push(c.r * m, c.g * m, c.b * m, wet ? (k === 0 || k === W - 1 ? 0 : 1) : ALPHA[k]);
      });
      if (i > 0) {
        const r0 = (i - 1) * W;
        const r1 = i * W;
        // Wound to face up (+y), so the ground side is the culled one.
        for (let k = 0; k + 1 < W; k++) idx.push(r0 + k, r0 + k + 1, r1 + k, r0 + k + 1, r1 + k + 1, r1 + k);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, roadMaterial);
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    mesh.userData.pathId = p.id;
    return mesh;
  }

  function drawHandles() {
    handles.clear();
    if (guide) {
      scene.remove(guide);
      guide.geometry.dispose();
      guide = null;
    }
    const show = draft ?? (selected !== null ? paths.get(selected) : null);
    if (!show) return;
    show.points.forEach(([x, y], i) => {
      const h = new THREE.Mesh(handleGeo, handleMat);
      h.position.set(x, groundAt(x, y) + 0.6, y);
      h.userData.handle = i;
      h.renderOrder = 12;
      handles.add(h);
    });
    const line = show.points.map(([x, y]) => new THREE.Vector3(x, groundAt(x, y) + 0.6, y));
    if (show.closed && line.length > 2) line.push(line[0].clone());
    guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints(line), guideMat);
    guide.renderOrder = 11;
    scene.add(guide);
  }

  const raycaster = new THREE.Raycaster();
  // A handle of the selected path, else a piece of any path.
  function pick(ray) {
    raycaster.ray.copy(ray);
    const h = raycaster.intersectObjects(handles.children, false)[0];
    if (h && selected !== null) return { id: selected, handle: h.object.userData.handle };
    const targets = [...Object.values(sets).flatMap((s) => s.meshes()), ...roads.values()];
    for (const hit of raycaster.intersectObjects(targets, false)) {
      const o = hit.object;
      if (o.userData.pathId !== undefined && o.userData.pathId !== -1) return { id: o.userData.pathId };
      if (hit.instanceId !== undefined && o.userData.owners) {
        const id = o.userData.owners()[hit.instanceId];
        if (id !== undefined && id !== -1) return { id };
      }
    }
    return null;
  }

  return {
    ready,
    setAll(list) {
      paths.clear();
      for (const p of list) paths.set(p.id, p);
      if (selected !== null && !paths.has(selected)) selected = null;
      rebuild();
    },
    upsert(p) {
      paths.set(p.id, p);
      rebuild();
    },
    remove(id) {
      paths.delete(id);
      if (selected === id) selected = null;
      rebuild();
    },
    get: (id) => paths.get(id),
    all: () => [...paths.values()],
    setDraft(p) {
      draft = p && { ...p, id: -1 };
      rebuild();
    },
    select(id) {
      selected = id;
      drawHandles();
      onChange();
    },
    setSurface(s) {
      surface = s;
      rebuild();
    },
    setLean(radians) {
      lean = radians;
      rebuild();
    },
    setAnchors(list) {
      anchors = list;
      rebuild();
    },
    pick,
    clearance: () => clearance,
    // Closed walls and palisades, with their bounds: the tree layer clears
    // the forest inside them.
    enclosures: () =>
      [...paths.values()]
        .filter((p) => p.closed && p.kind !== "road")
        .map((p) => {
          const xs = p.points.map((q) => q[0]);
          const ys = p.points.map((q) => q[1]);
          return { points: p.points, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
        }),
    count: () => paths.size,
  };
}
