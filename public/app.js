const map = document.getElementById("map");
const marksLayer = document.getElementById("marks");
const palette = document.getElementById("palette");

let pendingSpot = null;

function renderMark(mark) {
  const el = document.createElement("div");
  el.className = "mark";
  el.style.left = `${mark.x}%`;
  el.style.top = `${mark.y}%`;
  const img = document.createElement("img");
  img.src = `/assets/icons/${mark.kind}.svg`;
  img.alt = mark.kind;
  el.appendChild(img);
  marksLayer.appendChild(el);
}

async function loadMarks() {
  const res = await fetch("/api/marks");
  const marks = await res.json();
  for (const mark of marks) renderMark(mark);
}

function hidePalette() {
  palette.hidden = true;
  pendingSpot = null;
}

function showPaletteAt(clientX, clientY) {
  palette.hidden = false;
  // Measure after un-hiding so offsetWidth/Height are correct, then clamp to viewport.
  const { innerWidth, innerHeight } = window;
  const width = palette.offsetWidth;
  const height = palette.offsetHeight;
  const left = Math.min(Math.max(8, clientX - width / 2), innerWidth - width - 8);
  const top = Math.min(Math.max(8, clientY - height - 16), innerHeight - height - 8);
  palette.style.left = `${left}px`;
  palette.style.top = `${top}px`;
}

map.addEventListener("click", (event) => {
  const rect = map.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * 100;
  const y = ((event.clientY - rect.top) / rect.height) * 100;
  pendingSpot = { x, y };
  showPaletteAt(event.clientX, event.clientY);
});

palette.addEventListener("click", async (event) => {
  const button = event.target.closest(".palette-choice");
  if (!button || !pendingSpot) return;
  const kind = button.dataset.kind;
  const spot = pendingSpot;
  hidePalette();

  const res = await fetch("/api/marks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: spot.x, y: spot.y, kind }),
  });
  if (res.ok) {
    renderMark(await res.json());
  }
});

document.addEventListener("click", (event) => {
  if (palette.hidden) return;
  if (!palette.contains(event.target) && !map.contains(event.target)) hidePalette();
});

loadMarks();
