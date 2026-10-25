// Places on the map (Atlas Table stage B): the first tabletop tool. Pick a
// place from the palette and click the map to set it down; click a place
// to select it, drag to move, and turn or remove it from the panel. Every
// change goes to the server, which broadcasts it, so all open maps update
// live. Needs the WebGL2 renderer; the canvas fallback hides the tab.
//
// Walls, palisades and roads are drawn the way Dungeondraft and
// Wonderdraft draw them: click point by point, click the first point again
// to close a ring, double-click or Enter to finish. A new point snaps to
// the end or corner of an existing wall or road, and to a tower or castle
// set down as a place, so runs join up instead of nearly meeting.
import { apiPath, room, toast } from "./room-ui.js";

const $ = (id) => document.getElementById(id);

export const PLACE_KINDS = [
  { kind: "cottage", label: "Cottage" },
  { kind: "house", label: "House" },
  { kind: "church", label: "Church" },
  { kind: "windmill", label: "Windmill" },
  { kind: "well", label: "Well" },
  { kind: "farm", label: "Farm field" },
  { kind: "tower", label: "Tower" },
  { kind: "castle", label: "Castle" },
  { kind: "wall", label: "Wall" },
  { kind: "bridge", label: "Bridge" },
  { kind: "ruins", label: "Ruins" },
];

const TURN = Math.PI / 8;
const PATH_LABEL = { wall: "Stone wall", palisade: "Palisade", road: "Road" };
// Snap reach, in cells: about a fingertip at a typical zoom.
const SNAP = 1.6;
const DOUBLE_CLICK_MS = 350;

export function createPlaces(scene3d, canvas3d) {
  const objects = new Map(); // id -> data
  let active = false; // is the Places tool showing?
  let armedKind = null; // the palette choice; null = select/move mode
  let selected = null;
  let drag = null;
  // Walls and roads.
  let drawKind = null; // armed path kind
  let drawing = null; // { kind, points, closed } being drawn
  let pathSelected = null;
  let pathDrag = null; // { id, handle, start }
  let lastClick = 0;

  const toCanvas = (event) => {
    const rect = canvas3d.getBoundingClientRect();
    return [((event.clientX - rect.left) / rect.width) * canvas3d.width, ((event.clientY - rect.top) / rect.height) * canvas3d.height];
  };

  // Requests still on their way; undo waits for them (world-client.js),
  // so it never reverses the change before the one just made.
  const inFlight = new Set();
  function send(path, body) {
    const p = post(path, body);
    inFlight.add(p);
    p.finally(() => inFlight.delete(p)).catch(() => {});
    return p;
  }
  const settle = () => Promise.allSettled([...inFlight]);

  async function post(path, body) {
    const res = await fetch(apiPath(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "That didn't work. Try again.");
    return data;
  }

  function apply(o) {
    objects.set(o.id, o);
    scene3d.objects.upsert(o);
  }

  function drop(id) {
    objects.delete(id);
    scene3d.objects.remove(id);
    if (selected === id) select(null);
  }

  function select(id) {
    selected = id;
    scene3d.objects.select(id);
    const o = id === null ? null : objects.get(id);
    $("place-selected").classList.toggle("hidden", !o);
    if (o) $("place-selected-name").textContent = PLACE_KINDS.find((k) => k.kind === o.kind)?.label ?? o.kind;
  }

  // --- Walls and roads ---------------------------------------------------
  // Snap a point to the nearest path end or corner, or tower/castle.
  function snap(at, skip) {
    let best = null;
    let bestD = SNAP;
    const consider = (x, y) => {
      const d = Math.hypot(x - at.x, y - at.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    };
    for (const p of scene3d.paths.all()) {
      p.points.forEach(([x, y], i) => {
        if (skip && skip.id === p.id && skip.handle === i) return;
        consider(x, y);
      });
    }
    for (const a of scene3d.objects.anchors()) consider(a.x, a.y);
    return best ?? at;
  }

  function showDrawing() {
    $("path-drawing").classList.toggle("hidden", !drawing);
    document.body.classList.toggle("path-drawing", !!drawing);
    if (drawing) {
      $("path-drawing-name").textContent = PATH_LABEL[drawing.kind];
      $("path-drawing-count").textContent = String(drawing.points.length);
    }
    scene3d.paths.setDraft(drawing && drawing.points.length > 0 ? drawing : null);
  }

  // Pick a wall, palisade or road to draw; picking the same one again puts
  // it down (finishing a line already started).
  function armPath(kind) {
    const same = drawKind === kind;
    if (drawing) finishDrawing();
    else stopDrawing();
    if (same) return;
    disarmPlace();
    select(null);
    selectPath(null);
    drawKind = kind;
    drawing = { kind, points: [], closed: false };
    for (const b of document.querySelectorAll("[data-path]")) b.classList.toggle("active", b.dataset.path === kind);
    canvas3d.classList.add("placing");
    showDrawing();
  }

  // Put the path tool down without saving anything.
  function stopDrawing() {
    drawing = null;
    drawKind = null;
    for (const b of document.querySelectorAll("[data-path]")) b.classList.remove("active");
    canvas3d.classList.toggle("placing", !!armedKind);
    showDrawing();
  }

  function cancelDrawing() {
    stopDrawing();
  }

  function finishDrawing() {
    const d = drawing;
    drawing = null;
    const kind = drawKind;
    drawKind = null;
    for (const b of document.querySelectorAll("[data-path]")) b.classList.remove("active");
    canvas3d.classList.remove("placing");
    if (d && d.points.length >= 2) {
      send("/api/paths", { kind: d.kind, points: d.points, closed: d.closed })
        .then((p) => {
          scene3d.paths.setDraft(null);
          scene3d.paths.upsert(p);
          selectPath(p.id);
        })
        .catch((err) => {
          scene3d.paths.setDraft(null);
          toast(err.message);
        });
      showDrawingPanelOnly();
      return;
    }
    if (d && d.points.length > 0) toast(`A ${PATH_LABEL[kind].toLowerCase()} needs at least two points.`);
    showDrawing();
  }
  // The draft stays drawn until the server's answer replaces it.
  function showDrawingPanelOnly() {
    $("path-drawing").classList.add("hidden");
    document.body.classList.remove("path-drawing");
  }

  function addPoint(at) {
    const p = snap(at);
    const pts = drawing.points;
    // Clicking the first point again closes a wall into a ring.
    if (pts.length >= 3 && drawing.kind !== "road" && Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) < SNAP) {
      drawing.closed = true;
      finishDrawing();
      return;
    }
    const last = pts.at(-1);
    if (last && Math.hypot(p.x - last[0], p.y - last[1]) < 0.75) return;
    if (pts.length >= 64) return toast("That's as long as one line can be. Finish it and start another.");
    pts.push([+p.x.toFixed(2), +p.y.toFixed(2)]);
    showDrawing();
  }

  function selectPath(id) {
    pathSelected = id;
    scene3d.paths.select(id);
    const p = id === null ? null : scene3d.paths.get(id);
    $("path-selected").classList.toggle("hidden", !p);
    if (p) $("path-selected-name").textContent = PATH_LABEL[p.kind] + (p.closed ? " (ring)" : "");
  }

  function removeSelectedPath() {
    const id = pathSelected;
    if (id === null) return;
    const p = scene3d.paths.get(id);
    selectPath(null);
    scene3d.paths.remove(id);
    send("/api/paths/delete", { id }).catch((err) => {
      if (p) scene3d.paths.upsert(p);
      toast(err.message);
    });
  }

  function arm(kind) {
    const next = armedKind === kind ? null : kind;
    if (next && drawKind) {
      if (drawing?.points.length >= 2) finishDrawing();
      else stopDrawing();
    }
    armedKind = next;
    for (const b of document.querySelectorAll("[data-place]")) b.classList.toggle("active", b.dataset.place === armedKind);
    canvas3d.classList.toggle("placing", !!armedKind);
    if (armedKind) {
      select(null);
      selectPath(null);
    }
  }

  function disarmPlace() {
    if (armedKind) arm(armedKind);
  }

  async function load() {
    const [res, pres] = await Promise.all([fetch(apiPath("/api/objects")).catch(() => null), fetch(apiPath("/api/paths")).catch(() => null)]);
    const list = res?.ok ? await res.json() : [];
    objects.clear();
    for (const o of list) objects.set(o.id, o);
    scene3d.objects.setAll(list);
    if (selected !== null && !objects.has(selected)) select(null);
    scene3d.paths.setAll(pres?.ok ? await pres.json() : []);
    if (pathSelected !== null && !scene3d.paths.get(pathSelected)) selectPath(null);
  }

  // Returns true when it handled the event (so painting doesn't).
  function pointerDown(event) {
    if (!active || event.button !== 0) return false;
    // Only the first finger places or drags; a second one is a pinch
    // (world-client.js's touch gestures), never a second building.
    if (event.pointerType === "touch" && !event.isPrimary) return true;
    const [px, py] = toCanvas(event);
    if (!room.canEdit) return true;
    if (drawing) {
      const now = performance.now();
      const at = scene3d.pickPoint(px, py);
      const last = drawing.points.at(-1);
      // A double-click on the last point finishes; two quick taps in
      // different places are just two points.
      const double = now - lastClick < DOUBLE_CLICK_MS && at && last && Math.hypot(at.x - last[0], at.y - last[1]) < SNAP;
      lastClick = now;
      if (double) finishDrawing();
      else if (at) addPoint(at);
      return true;
    }
    // A handle on the selected wall or road, then any wall or road.
    const hitPath = scene3d.pickPath(px, py);
    if (hitPath && hitPath.handle !== undefined && !armedKind) {
      const p = scene3d.paths.get(hitPath.id);
      pathDrag = { id: hitPath.id, handle: hitPath.handle, start: p, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
      return true;
    }
    if (armedKind) {
      const at = scene3d.pickPoint(px, py);
      if (!at) return true;
      const kind = armedKind;
      send("/api/objects", { kind, x: at.x, y: at.y, rotation: 0, scale: 1 })
        .then((o) => {
          apply(o);
          select(o.id);
        })
        .catch((err) => toast(err.message));
      // Shift keeps the place armed for setting down a row of cottages.
      if (!event.shiftKey) arm(armedKind);
      return true;
    }
    const id = scene3d.pickObject(px, py);
    select(id);
    if (id === null) selectPath(hitPath ? hitPath.id : null);
    else selectPath(null);
    if (id !== null) {
      const o = objects.get(id);
      drag = { id, startX: o.x, startY: o.y, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    return true;
  }

  function pointerMove(event) {
    if (!active) return false;
    if (pathDrag) {
      const [px, py] = toCanvas(event);
      const at = scene3d.pickPoint(px, py);
      const p = scene3d.paths.get(pathDrag.id);
      if (!at || !p) return true;
      const q = snap(at, pathDrag);
      const points = p.points.map((pt, i) => (i === pathDrag.handle ? [+q.x.toFixed(2), +q.y.toFixed(2)] : pt));
      pathDrag.moved = true;
      scene3d.paths.upsert({ ...p, points });
      return true;
    }
    if (!drag) return true;
    const [px, py] = toCanvas(event);
    const at = scene3d.pickPoint(px, py);
    if (!at) return true;
    const o = objects.get(drag.id);
    if (!o) {
      drag = null;
      return true;
    }
    drag.moved = true;
    apply({ ...o, x: at.x, y: at.y });
    return true;
  }

  function pointerUp() {
    if (!active) return false;
    if (pathDrag) {
      const { id, moved, start } = pathDrag;
      pathDrag = null;
      const p = scene3d.paths.get(id);
      if (moved && p) {
        send("/api/paths/update", { id, points: p.points }).catch((err) => {
          scene3d.paths.upsert(start);
          toast(err.message);
        });
      }
      return true;
    }
    if (!drag) return true;
    const { id, moved, startX, startY } = drag;
    drag = null;
    const o = objects.get(id);
    if (moved && o) {
      // One request per drag, sent when it ends.
      send("/api/objects/update", { id, x: o.x, y: o.y }).catch((err) => {
        apply({ ...o, x: startX, y: startY });
        toast(err.message);
      });
    }
    return true;
  }

  function change(fields) {
    const o = selected === null ? null : objects.get(selected);
    if (!o) return;
    const next = { ...o, ...fields };
    apply(next);
    send("/api/objects/update", { id: o.id, ...fields }).catch((err) => {
      apply(o);
      toast(err.message);
    });
  }

  function removeSelected() {
    const id = selected;
    if (id === null) return;
    const o = objects.get(id);
    drop(id);
    send("/api/objects/delete", { id }).catch((err) => {
      if (o) apply(o);
      toast(err.message);
    });
  }

  function wire() {
    const palette = $("place-palette");
    for (const { kind, label } of PLACE_KINDS) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.place = kind;
      b.textContent = label;
      b.addEventListener("click", () => arm(kind));
      palette.append(b);
    }
    $("place-turn-left").addEventListener("click", () => change({ rotation: (objects.get(selected)?.rotation ?? 0) - TURN }));
    $("place-turn-right").addEventListener("click", () => change({ rotation: (objects.get(selected)?.rotation ?? 0) + TURN }));
    $("place-smaller").addEventListener("click", () => change({ scale: Math.max(0.5, +((objects.get(selected)?.scale ?? 1) - 0.25).toFixed(2)) }));
    $("place-bigger").addEventListener("click", () => change({ scale: Math.min(2.5, +((objects.get(selected)?.scale ?? 1) + 0.25).toFixed(2)) }));
    $("place-remove").addEventListener("click", removeSelected);
    for (const b of document.querySelectorAll("[data-path]")) b.addEventListener("click", () => armPath(b.dataset.path));
    $("path-finish").addEventListener("click", finishDrawing);
    $("path-cancel").addEventListener("click", cancelDrawing);
    $("path-back").addEventListener("click", () => {
      drawing?.points.pop();
      showDrawing();
    });
    $("path-remove").addEventListener("click", removeSelectedPath);
    window.addEventListener("keydown", (event) => {
      if (!active || event.target instanceof HTMLInputElement) return;
      if (drawing) {
        if (event.key === "Escape") cancelDrawing();
        else if (event.key === "Enter") finishDrawing();
        else if (event.key === "Backspace") {
          event.preventDefault();
          drawing.points.pop();
          showDrawing();
        }
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && pathSelected !== null && room.canEdit) {
        event.preventDefault();
        removeSelectedPath();
        return;
      }
      if (event.key === "Escape" && pathSelected !== null) {
        selectPath(null);
        return;
      }
      if (event.key === "Escape") {
        if (armedKind) arm(armedKind);
        else select(null);
      } else if ((event.key === "Delete" || event.key === "Backspace") && selected !== null && room.canEdit) {
        event.preventDefault();
        removeSelected();
      } else if ((event.key === "q" || event.key === "e") && selected !== null && room.canEdit) {
        change({ rotation: (objects.get(selected)?.rotation ?? 0) + (event.key === "e" ? TURN : -TURN) });
      }
    });
  }

  function setActive(on) {
    active = on;
    if (!on) {
      if (armedKind) arm(armedKind);
      if (drawKind) stopDrawing();
      select(null);
      selectPath(null);
    }
  }

  function wireEvents(source) {
    source.addEventListener("objects:upsert", (event) => {
      const o = JSON.parse(event.data);
      // Don't yank a place out from under the person dragging it.
      if (drag?.id === o.id) return;
      apply(o);
    });
    source.addEventListener("objects:delete", (event) => drop(JSON.parse(event.data).id));
    source.addEventListener("paths:upsert", (event) => {
      const p = JSON.parse(event.data);
      if (pathDrag?.id === p.id) return;
      scene3d.paths.upsert(p);
      if (pathSelected === p.id) selectPath(p.id);
    });
    source.addEventListener("paths:delete", (event) => {
      const { id } = JSON.parse(event.data);
      scene3d.paths.remove(id);
      if (pathSelected === id) selectPath(null);
    });
    // A restore swaps the whole map, places included.
    source.addEventListener("terrain:reload", load);
    source.addEventListener("open", load);
  }

  wire();
  // A second finger turned the drag into a pinch: put the place back where
  // the drag started, without sending anything.
  function cancelDrag() {
    if (pathDrag) {
      scene3d.paths.upsert(pathDrag.start);
      pathDrag = null;
    }
    if (!drag) return;
    const o = objects.get(drag.id);
    if (o) apply({ ...o, x: drag.startX, y: drag.startY });
    drag = null;
  }

  return { pointerDown, pointerMove, pointerUp, setActive, wireEvents, load, settle, cancelDrag };
}
