// Places on the map (Atlas Table stage B): the first tabletop tool. Pick a
// place from the palette and click the map to set it down; click a place
// to select it, drag to move, and turn or remove it from the panel. Every
// change goes to the server, which broadcasts it, so all open maps update
// live. Needs the WebGL2 renderer; the canvas fallback hides the tab.
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

export function createPlaces(scene3d, canvas3d) {
  const objects = new Map(); // id -> data
  let active = false; // is the Places tool showing?
  let armedKind = null; // the palette choice; null = select/move mode
  let selected = null;
  let drag = null;

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

  function arm(kind) {
    armedKind = armedKind === kind ? null : kind;
    for (const b of document.querySelectorAll("[data-place]")) b.classList.toggle("active", b.dataset.place === armedKind);
    canvas3d.classList.toggle("placing", !!armedKind);
    if (armedKind) select(null);
  }

  async function load() {
    const res = await fetch(apiPath("/api/objects")).catch(() => null);
    const list = res?.ok ? await res.json() : [];
    objects.clear();
    for (const o of list) objects.set(o.id, o);
    scene3d.objects.setAll(list);
    if (selected !== null && !objects.has(selected)) select(null);
  }

  // Returns true when it handled the event (so painting doesn't).
  function pointerDown(event) {
    if (!active || event.button !== 0) return false;
    // Only the first finger places or drags; a second one is a pinch
    // (world-client.js's touch gestures), never a second building.
    if (event.pointerType === "touch" && !event.isPrimary) return true;
    const [px, py] = toCanvas(event);
    if (!room.canEdit) return true;
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
    if (id !== null) {
      const o = objects.get(id);
      drag = { id, startX: o.x, startY: o.y, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    return true;
  }

  function pointerMove(event) {
    if (!active) return false;
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
    window.addEventListener("keydown", (event) => {
      if (!active || event.target instanceof HTMLInputElement) return;
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
      select(null);
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
    // A restore swaps the whole map, places included.
    source.addEventListener("terrain:reload", load);
    source.addEventListener("open", load);
  }

  wire();
  // A second finger turned the drag into a pinch: put the place back where
  // the drag started, without sending anything.
  function cancelDrag() {
    if (!drag) return;
    const o = objects.get(drag.id);
    if (o) apply({ ...o, x: drag.startX, y: drag.startY });
    drag = null;
  }

  return { pointerDown, pointerMove, pointerUp, setActive, wireEvents, load, settle, cancelDrag };
}
