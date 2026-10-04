// The world has two layers, edited very differently:
//
// - Terrain (grass/sand/rock/water/forest) is a continuous drag brush,
//   painted straight onto one raster canvas that already holds the base
//   island image - so a paint stroke looks like that part of the map's own
//   art changed, not like a shape floating on top of it. Each dab (a small
//   stamp of a texture patch sampled from the base map itself, blended
//   through a soft round mask) is persisted; the canvas is always rebuilt by
//   replaying every stored dab in order over the base image, never by
//   storing a baked image.
// - Roads/paths and buildings/ruins are GeoJSON features (lines/points),
//   drawn/edited/dragged/deleted by Leaflet-Geoman - that interaction already
//   works well and is unchanged.

const LINE_KINDS = ["road", "path"];
const MARKER_KINDS = ["building", "ruin"];
const TERRAIN_KINDS = ["grass", "sand", "rock", "water", "forest"];

const KIND_COLOR = {
  road: "#6b5842",
  path: "#c2a877",
};

const MARKER_ICONS = {
  building: L.icon({ iconUrl: "/assets/tiles/object-building.png", iconSize: [32, 32], iconAnchor: [16, 28] }),
  ruin: L.icon({ iconUrl: "/assets/tiles/object-ruin.png", iconSize: [32, 32], iconAnchor: [16, 28] }),
};

// A handful of patches cropped directly from base-map.png's own grass/sand/
// rock/water-coloured regions (see CREDITS.md) - the brush's texture is
// literally the base map's own art, so a dab matches its sharpness and
// detail by construction rather than by trying to imitate it.
const PATCH_VARIANT_COUNT = { grass: 2, sand: 1, rock: 2, water: 1, forest: 2 };
const PATCH_VARIANTS = Object.fromEntries(
  Object.entries(PATCH_VARIANT_COUNT).map(([kind, count]) => [
    kind,
    Array.from({ length: count }, (_, i) => `/assets/terrain-patches/${kind}-${i + 1}.png`),
  ]),
);

// Brush radius, in image pixels - the same units the dab is stored and
// replayed in, so brush size is a real width on the map, not a cosmetic
// cursor size.
const BRUSH_SIZES = { small: 12, medium: 22, large: 36 };
const ERASER_KIND = "eraser";

function geometryTypeForFeatureKind(kind) {
  return LINE_KINDS.includes(kind) ? "LineString" : "Point";
}

function styleFor(kind) {
  const color = KIND_COLOR[kind] ?? "#888888";
  return { color, weight: kind === "road" ? 6 : 3, opacity: 0.9, lineCap: "round" };
}

// Base map + terrain: a single sourced island image (see CREDITS.md) at its
// native resolution, placed with Leaflet's documented CRS.Simple recipe for
// non-geographic maps - bounds are the image's own pixel dimensions, and the
// painting canvas below shares that exact same pixel grid, so nothing in the
// pipeline ever upscales/downscales it (no added blur relative to the source art).
const BASE_MAP_SIZE = 1024;
const bounds = [
  [0, 0],
  [BASE_MAP_SIZE, BASE_MAP_SIZE],
];

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Deterministic pseudo-randomness. Salt lets the same base key produce
// several independent values (which variant, which rotation, which crop
// window, ...).
function hash32(key, salt) {
  let h = Math.imul(key ^ salt, 374761393);
  h = Math.imul(h ^ (h >>> 13), 2246822519);
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

const patchImages = {};
let baseImgRef = null;

function paintDab(ctx, dab) {
  const R = dab.radius;
  const size = R * 2;
  const temp = document.createElement("canvas");
  temp.width = size;
  temp.height = size;
  const tctx = temp.getContext("2d");

  if (dab.kind === ERASER_KIND) {
    // An eraser doesn't stamp a texture - it restores the real base-map
    // pixels at this exact spot, unrotated, so it always lines up with the
    // surrounding, still-original map.
    tctx.drawImage(baseImgRef, dab.x - R, dab.y - R, size, size, 0, 0, size, size);
  } else {
    const variants = PATCH_VARIANTS[dab.kind];
    if (!variants || variants.length === 0) return;
    // Which source patch, and which quarter-turn, are picked once per
    // *stroke* (from its shared seed) so one continuous drag always shows
    // one consistent grain direction, never several different orientations
    // meeting at a hard edge partway through the same stroke.
    const img = patchImages[variants[hash32(dab.seed, 1) % variants.length]];
    if (!img) return;
    const rotation = (hash32(dab.seed, 2) % 4) * (Math.PI / 2);

    tctx.save();
    tctx.translate(R, R);
    tctx.rotate(rotation);
    if (img.naturalWidth >= size && img.naturalHeight >= size) {
      // The source patch is bigger than this dab's footprint: crop a fresh
      // window out of it (no scaling, no repeating) rather than tiling, so
      // there is never a regular seam to see - just one natural-looking
      // slice of the base map's own texture. The window slides with the
      // dab's own position, so a dragged stroke shows continuously varying
      // texture instead of a single repeated stamp.
      const maxOx = img.naturalWidth - size;
      const maxOy = img.naturalHeight - size;
      const posKey = (Math.floor(dab.x * 3) << 16) ^ Math.floor(dab.y * 7);
      const ox = hash32(posKey, 11) % (maxOx + 1);
      const oy = hash32(posKey, 13) % (maxOy + 1);
      tctx.drawImage(img, ox, oy, size, size, -R, -R, size, size);
    } else {
      // This brush is bigger than any available source patch for this kind
      // (the base map's own colour regions are only so big) - fall back to
      // tiling it. Only the largest brush sizes hit this path.
      const pattern = tctx.createPattern(img, "repeat");
      tctx.fillStyle = pattern;
      tctx.fillRect(-size * 2, -size * 2, size * 4, size * 4);
    }
    tctx.restore();
  }

  // Flat full-strength core with only a thin soft rim (not one gradient
  // spanning the whole radius) - heavily-overlapping dabs along a stroke
  // would otherwise stack many partial-opacity edges on top of each other,
  // averaging the texture into a blur instead of keeping it crisp like the
  // base map. Only the stroke's outer boundary should read as soft.
  tctx.globalCompositeOperation = "destination-in";
  const gradient = tctx.createRadialGradient(R, R, R * 0.82, R, R, R);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  tctx.fillStyle = gradient;
  tctx.beginPath();
  tctx.arc(R, R, R, 0, Math.PI * 2);
  tctx.fill();

  // No clipping to the island's own silhouette: painting is free to extend
  // land out into the sea, paint water over existing land to redraw the
  // coastline, and so on - the brush can change the map's shape, not just
  // its surface kind. The one exception is the eraser: restoring the
  // original map sometimes means restoring *transparency* (e.g. undoing
  // land painted into open sea), which plain alpha blending (source-over)
  // can never do - a transparent source pixel blended over an opaque one
  // leaves the opaque one unchanged. Clipping to the dab's own circle and
  // using "copy" there replaces exactly those pixels with the original
  // map's, transparency included, without touching anything outside it.
  ctx.save();
  ctx.beginPath();
  ctx.arc(dab.x, dab.y, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalCompositeOperation = dab.kind === ERASER_KIND ? "copy" : "source-over";
  ctx.drawImage(temp, dab.x - R, dab.y - R);
  ctx.restore();
}

async function main() {
  const allPatchUrls = Object.values(PATCH_VARIANTS).flat();
  const [baseImg, ...patches] = await Promise.all([
    loadImage("/assets/base-map.png"),
    ...allPatchUrls.map((url) => loadImage(url)),
  ]);
  allPatchUrls.forEach((url, i) => (patchImages[url] = patches[i]));
  baseImgRef = baseImg;

  const paintCanvas = document.createElement("canvas");
  paintCanvas.width = BASE_MAP_SIZE;
  paintCanvas.height = BASE_MAP_SIZE;
  const ctx = paintCanvas.getContext("2d");

  function redrawAll(dabs) {
    ctx.clearRect(0, 0, BASE_MAP_SIZE, BASE_MAP_SIZE);
    ctx.drawImage(baseImg, 0, 0, BASE_MAP_SIZE, BASE_MAP_SIZE);
    for (const dab of dabs) paintDab(ctx, dab);
  }

  const dabsRes = await fetch("/api/terrain-dabs");
  const { dabs: storedDabs } = await dabsRes.json();
  redrawAll(storedDabs);

  // zoomAnimation off: with it on, there's a brief window during a zoom
  // transition where the visual scale and Leaflet's own coordinate mapping
  // are momentarily out of step, which is exactly when a paint click can
  // land a dab in the wrong spot relative to the cursor.
  const map = L.map("map", { crs: L.CRS.Simple, minZoom: -2, maxZoom: 2, zoomAnimation: false });
  const terrainOverlay = L.imageOverlay(paintCanvas.toDataURL(), bounds).addTo(map);
  map.fitBounds(bounds);

  // Only the tools that don't depend on which kind is selected get their own
  // permanent toolbar button (edit, drag, remove) - those apply to the
  // road/path/building/ruin vector layer only. Terrain has no Geoman button
  // at all: it's painted directly by dragging on the map.
  map.pm.addControls({
    position: "topleft",
    drawMarker: false,
    drawCircleMarker: false,
    drawPolyline: false,
    drawRectangle: false,
    drawPolygon: false,
    drawCircle: false,
    drawText: false,
    cutPolygon: false,
    rotateMode: false,
    editMode: true,
    dragMode: true,
    removalMode: true,
  });

  function layerFromFeature(feature) {
    const { kind } = feature.properties;
    const { type, coordinates } = feature.geometry;
    if (type === "Point") {
      const [x, y] = coordinates;
      return L.marker([y, x], { icon: MARKER_ICONS[kind] });
    }
    const latlngs = coordinates.map(([x, y]) => [y, x]);
    return L.polyline(latlngs, styleFor(kind));
  }

  function applyKindAppearance(layer, kind) {
    if (layer instanceof L.Marker) {
      const icon = MARKER_ICONS[kind];
      if (icon) layer.setIcon(icon);
    } else if (layer.setStyle) {
      layer.setStyle(styleFor(kind));
    }
  }

  function wireLayerEvents(layer, id) {
    layer._isleId = id;
    const persistGeometry = async () => {
      const { geometry } = layer.toGeoJSON();
      await fetch(`/api/features/${layer._isleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geometry }),
      });
    };
    layer.on("pm:edit", persistGeometry);
    layer.on("pm:update", persistGeometry);
    layer.on("pm:dragend", persistGeometry);
    layer.on("pm:remove", () => {
      fetch(`/api/features/${layer._isleId}`, { method: "DELETE" });
    });
  }

  async function loadFeatures() {
    const res = await fetch("/api/features");
    const data = await res.json();
    for (const feature of data.features) {
      const layer = layerFromFeature(feature).addTo(map);
      wireLayerEvents(layer, feature.id);
    }
  }

  // --- Kind picker: a persistent toolbar (click once, draw/paint many), not
  // a popup-per-click. Terrain kinds arm our own drag brush; line/marker
  // kinds arm the matching Geoman draw tool instead. ---
  const BRUSH_KINDS = [...TERRAIN_KINDS, ERASER_KIND];
  const GEOMAN_SHAPE_FOR_GEOMETRY = { LineString: "Line", Point: "Marker" };
  const kindButtons = document.querySelectorAll(".kind-choice");
  let currentKind = "grass";
  let currentMode = "terrain"; // "terrain" | "vector"

  function selectKind(button) {
    for (const b of kindButtons) b.classList.remove("is-active");
    button.classList.add("is-active");
    currentKind = button.dataset.kind;
    const isBrush = BRUSH_KINDS.includes(currentKind);
    currentMode = isBrush ? "terrain" : "vector";
    document.getElementById("map").classList.toggle("is-painting", isBrush);
    map.pm.disableDraw();
    if (isBrush) {
      map.dragging.disable();
    } else {
      map.dragging.enable();
      map.pm.enableDraw(GEOMAN_SHAPE_FOR_GEOMETRY[geometryTypeForFeatureKind(currentKind)]);
    }
  }

  for (const button of kindButtons) {
    button.addEventListener("click", () => selectKind(button));
  }

  // --- Brush size: a real width on the map (the dab's own radius), not a
  // cosmetic cursor setting. ---
  let currentBrushRadius = BRUSH_SIZES.medium;
  const sizeButtons = document.querySelectorAll(".size-choice");
  for (const button of sizeButtons) {
    button.addEventListener("click", () => {
      for (const b of sizeButtons) b.classList.remove("is-active");
      button.classList.add("is-active");
      currentBrushRadius = BRUSH_SIZES[button.dataset.size] ?? BRUSH_SIZES.medium;
    });
  }

  map.on("pm:create", async (e) => {
    const { layer } = e;
    const kind = currentKind;
    applyKindAppearance(layer, kind);
    try {
      const res = await fetch("/api/features", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "Feature", geometry: layer.toGeoJSON().geometry, properties: { kind } }),
      });
      if (!res.ok) throw new Error(await res.text());
      const feature = await res.json();
      wireLayerEvents(layer, feature.id);
    } catch (err) {
      console.error("failed to save feature", err);
      map.removeLayer(layer);
    }
  });

  // --- Terrain brush: drag directly on the map to paint. Dabs are sampled
  // at a fixed spacing along the pointer path (not one per mousemove event),
  // so the stroke stays continuous even if the browser reports movement in
  // large jumps. ---
  const mapContainer = map.getContainer();
  let painting = false;
  let lastPt = null;
  let strokeDabs = [];
  let strokeSeed = 0;
  let refreshQueued = false;

  function queueOverlayRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      terrainOverlay.setUrl(paintCanvas.toDataURL());
    });
  }

  function addDab(x, y) {
    const dab = { x, y, radius: currentBrushRadius, kind: currentKind, seed: strokeSeed };
    paintDab(ctx, dab);
    strokeDabs.push(dab);
    queueOverlayRefresh();
  }

  function paintAt(clientX, clientY) {
    const rect = mapContainer.getBoundingClientRect();
    const { lat: y, lng: x } = map.containerPointToLatLng(L.point(clientX - rect.left, clientY - rect.top));
    if (x < 0 || x > BASE_MAP_SIZE || y < 0 || y > BASE_MAP_SIZE) return;
    // Spacing scales with brush size, so a small brush still lays dabs
    // close enough together for a continuous line, and a large brush isn't
    // wastefully over-painting the same spot many times per pixel moved.
    const spacing = Math.max(4, currentBrushRadius / 3);
    if (lastPt) {
      const dist = Math.hypot(x - lastPt.x, y - lastPt.y);
      const steps = Math.max(1, Math.round(dist / spacing));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        addDab(lastPt.x + (x - lastPt.x) * t, lastPt.y + (y - lastPt.y) * t);
      }
    } else {
      addDab(x, y);
    }
    lastPt = { x, y };
  }

  async function flushStroke() {
    if (strokeDabs.length === 0) return;
    const toSend = strokeDabs;
    strokeDabs = [];
    try {
      const res = await fetch("/api/terrain-dabs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dabs: toSend }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      console.error("failed to save terrain stroke", err);
    }
  }

  mapContainer.addEventListener("mousedown", (e) => {
    if (currentMode !== "terrain") return;
    e.preventDefault();
    painting = true;
    lastPt = null;
    strokeSeed = Math.floor(Math.random() * 2 ** 31);
    paintAt(e.clientX, e.clientY);
  });
  window.addEventListener("mousemove", (e) => {
    if (!painting) return;
    paintAt(e.clientX, e.clientY);
  });
  window.addEventListener("mouseup", () => {
    if (!painting) return;
    painting = false;
    flushStroke();
  });

  mapContainer.addEventListener(
    "touchstart",
    (e) => {
      if (currentMode !== "terrain") return;
      e.preventDefault();
      painting = true;
      lastPt = null;
      strokeSeed = Math.floor(Math.random() * 2 ** 31);
      const t = e.touches[0];
      paintAt(t.clientX, t.clientY);
    },
    { passive: false },
  );
  mapContainer.addEventListener(
    "touchmove",
    (e) => {
      if (!painting) return;
      e.preventDefault();
      const t = e.touches[0];
      paintAt(t.clientX, t.clientY);
    },
    { passive: false },
  );
  window.addEventListener("touchend", () => {
    if (!painting) return;
    painting = false;
    flushStroke();
  });

  // The first kind button already renders as selected, so the matching mode
  // (brush or Geoman draw) must actually be armed from first load.
  selectKind(document.querySelector(".kind-choice.is-active"));

  loadFeatures();
}

main();
