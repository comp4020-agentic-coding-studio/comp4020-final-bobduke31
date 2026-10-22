// The Atlas home page (stage A). Three jobs, from the stage A research
// (ROADMAP.md):
//  - Show value in seconds: a real world is generated on arrival, by the
//    same forge.js the server runs, and "Create this world" makes it yours.
//  - A returning visitor sees their own maps first, with pictures.
//  - The gallery: the shared world plus maps their makers chose to show.
import { forgeWorld, previewPixels } from "/world/forge.js";

const $ = (id) => document.getElementById(id);

const SEED_WORDS = ["Saltmere", "Oakhollow", "Vey", "Thornwick", "Greymarch", "Ashfold", "Brindle", "Coldharbour", "Wrenfield", "Highcairn", "Morrow", "Selkie", "Duskwater", "Harrowgate", "Kestrel", "Lindqvist"];
const LAND_WORDS = { continent: "Reaches", coast: "Coast", archipelago: "Isles" };
const SLIDER_WORDS = {
  land: ["Little", "Some", "Much"],
  mountains: ["Hills", "Ranges", "Alpine"],
  forest: ["Sparse", "Woods", "Dense"],
};
// Starting points for an empty gallery: real seeds, chosen by looking at
// them, so the page never opens on a blank list.
const STARTERS = [
  { seed: "Highcairn 611", template: "continent", settings: { land: 0.5, mountains: 0.85, forest: 0.5 }, title: "Highcairn", note: "Alpine continent" },
  { seed: "Selkie 318", template: "archipelago", settings: { land: 0.5, mountains: 0.5, forest: 0.5 }, title: "The Selkie Isles", note: "Islands" },
  { seed: "Oakhollow", template: "coast", settings: { land: 0.5, mountains: 0.75, forest: 0.6 }, title: "Oakhollow Coast", note: "Forested coast" },
  { seed: "Saltmere", template: "continent", settings: { land: 0.5, mountains: 0.5, forest: 0.5 }, title: "Saltmere", note: "Continent" },
];

const form = $("forge-form");
const preview = $("preview");
const seedInput = $("seed");
const nameInput = $("world-name");
const sliders = Object.fromEntries(Object.keys(SLIDER_WORDS).map((k) => [k, $(k)]));
const template = () => form.querySelector('input[name="template"]:checked').value;
const settings = () => Object.fromEntries(Object.entries(sliders).map(([k, el]) => [k, Number(el.value)]));

// A name in the world's own voice, until the person types one.
let nameTouched = false;
function suggestName() {
  if (nameTouched) return;
  const word = seedInput.value.trim().split(/\s+/)[0] || "Atlas";
  nameInput.value = `The ${word} ${LAND_WORDS[template()]}`;
}

const KIND_WORDS = { continent: "continent", coast: "coast", archipelago: "scatter of islands" };
function describe() {
  $("lede-kind").textContent = KIND_WORDS[template()];
}

function randomSeed() {
  return `${SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)]} ${Math.floor(Math.random() * 900 + 100)}`;
}

// Slider drags fire faster than a world generates (~100-200 ms): only the
// latest request draws.
let ticket = 0;
async function draw() {
  const mine = ++ticket;
  preview.classList.add("busy");
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  if (mine !== ticket) return;
  const world = forgeWorld(seedInput.value.trim() || "Atlas", template(), settings());
  if (mine !== ticket) return;
  const size = preview.width;
  preview.getContext("2d").putImageData(new ImageData(previewPixels(world, size), size, size), 0, 0);
  preview.classList.remove("busy");
}

function useStarter(s) {
  seedInput.value = s.seed;
  form.querySelector(`input[name="template"][value="${s.template}"]`).checked = true;
  for (const [k, v] of Object.entries(s.settings)) {
    sliders[k].value = v;
    sliders[k].dispatchEvent(new Event("input"));
  }
  nameTouched = false;
  describe();
  suggestName();
  draw();
  $("forge").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function wireForge() {
  seedInput.value = randomSeed();
  suggestName();
  for (const [k, el] of Object.entries(sliders)) {
    const out = $(`${k}-out`);
    el.addEventListener("input", () => {
      const v = Number(el.value);
      out.textContent = SLIDER_WORDS[k][v < 0.34 ? 0 : v < 0.67 ? 1 : 2];
      draw();
    });
  }
  for (const r of form.querySelectorAll('input[name="template"]')) {
    r.addEventListener("change", () => {
      describe();
      suggestName();
      draw();
    });
  }
  seedInput.addEventListener("input", () => {
    suggestName();
    draw();
  });
  nameInput.addEventListener("input", () => (nameTouched = nameInput.value.trim() !== ""));
  $("reroll").addEventListener("click", () => {
    seedInput.value = randomSeed();
    suggestName();
    draw();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = $("forge-error");
    const button = $("create-button");
    error.classList.add("hidden");
    button.disabled = true;
    button.textContent = "Forging…";
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameInput.value.trim(),
          forge: { seed: seedInput.value.trim() || "Atlas", template: template(), settings: settings() },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Couldn't create the map.");
      // Straight into the new map, with its share sheet open: the next step
      // is shaping it, and the one after that is inviting people.
      location.href = `/m/${body.editToken}#share`;
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
      error.classList.remove("hidden");
      button.disabled = false;
      button.textContent = "Create this world";
    }
  });
  draw();
}

function relativeTime(sqliteUtc) {
  const then = new Date(`${sqliteUtc.replace(" ", "T")}Z`).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function initialOf(name) {
  const letter = [...name.trim()].find((ch) => /\p{L}/u.test(ch));
  return (letter ?? "?").toUpperCase();
}

function sigil(name, tincture) {
  const span = document.createElement("span");
  span.className = "sigil";
  span.dataset.tincture = tincture;
  span.innerHTML = '<svg viewBox="0 0 26 30" aria-hidden="true"><use href="#shield" /></svg>';
  const em = document.createElement("em");
  em.textContent = initialOf(name);
  span.append(em);
  return span;
}

// One map card. Everything user-written goes in through textContent.
function card({ href, img, title, meta, badge, badgeClass, person }) {
  const li = document.createElement("li");
  li.className = "card";
  const a = document.createElement("a");
  a.className = "card-link";
  a.href = href;
  const picture = img instanceof HTMLElement ? img : Object.assign(document.createElement("img"), { src: img, alt: "", width: 480, height: 300, loading: "lazy" });
  const body = document.createElement("span");
  body.className = "card-body";
  const t = document.createElement("span");
  t.className = "card-title place-name";
  t.textContent = title;
  const m = document.createElement("span");
  m.className = "card-meta";
  if (person) m.append(sigil(person.name, person.tincture));
  const mt = document.createElement("span");
  mt.textContent = meta;
  m.append(mt);
  body.append(t, m);
  a.append(picture, body);
  if (badge) {
    const b = document.createElement("span");
    b.className = `badge ${badgeClass ?? ""}`;
    b.textContent = badge;
    a.append(b);
  }
  li.append(a);
  return li;
}

async function loadMe() {
  const res = await fetch("/api/me").catch(() => null);
  if (!res?.ok) return;
  const me = await res.json();
  $("me-name").textContent = me.name;
  $("me-initial").textContent = initialOf(me.name);
  document.querySelector("#me .sigil").dataset.tincture = me.tincture;
  $("me").classList.remove("hidden");
}

async function loadYours() {
  const res = await fetch("/api/rooms/mine").catch(() => null);
  const maps = res?.ok ? await res.json() : [];
  if (!maps.length) return;
  const list = $("your-maps");
  for (const map of maps) {
    list.append(
      card({
        href: `/m/${map.token}`,
        img: `/api/r/${map.token}/room/thumbnail.png`,
        title: map.name,
        meta: `${map.role === "edit" ? "You can edit" : "You can watch"} · ${relativeTime(map.lastSeenAt)}`,
        badge: map.role === "edit" ? null : "View only",
        badgeClass: "view",
      }),
    );
  }
  const add = document.createElement("li");
  add.className = "card new";
  add.innerHTML = '<a class="card-link" href="#forge"><span class="plus" aria-hidden="true">+</span><span>Forge a new world</span></a>';
  list.append(add);
  // A returning visitor: their maps lead, the Forge follows.
  document.body.classList.add("returning");
  $("yours").classList.remove("hidden");
  $("nav-yours").classList.remove("hidden");
  $("forge").before($("yours"));
  $("forge-eyebrow").textContent = "Start another";
  $("forge-title").textContent = "Forge a new world";
}

async function loadGallery() {
  const res = await fetch("/api/gallery").catch(() => null);
  const maps = res?.ok ? await res.json() : [];
  const list = $("gallery-maps");
  for (const map of maps) {
    list.append(
      card({
        href: `/m/${map.viewToken}`,
        img: `/api/gallery/${map.viewToken}/thumbnail.png`,
        title: map.name,
        meta: `by ${map.by} · ${relativeTime(map.listedAt)}`,
        person: { name: map.by, tincture: map.tincture },
      }),
    );
  }
  // Fewer than a row of real maps: offer starting points too.
  if (maps.length < 3) {
    const starters = $("starter-list");
    for (const s of STARTERS) {
      const canvas = document.createElement("canvas");
      canvas.width = 240;
      canvas.height = 150;
      const li = card({ href: "#forge", img: canvas, title: s.title, meta: `${s.note} · seed ${s.seed}` });
      li.querySelector("a").addEventListener("click", (e) => {
        e.preventDefault();
        useStarter(s);
      });
      starters.append(li);
      // Drawn when idle, after the hero: four more worlds take ~0.5 s.
      (window.requestIdleCallback ?? ((f) => setTimeout(f, 200)))(() => {
        const px = previewPixels(forgeWorld(s.seed, s.template, s.settings), 240);
        // The square preview, cropped to the card's shape around its centre.
        const off = new OffscreenCanvas(240, 240);
        off.getContext("2d").putImageData(new ImageData(px, 240, 240), 0, 0);
        canvas.getContext("2d").drawImage(off, 0, 45, 240, 150, 0, 0, 240, 150);
      });
    }
    $("starters").classList.remove("hidden");
  }
}

// "Paste a map link": accepts a full link or a bare token, and goes there.
function wireOpenLink() {
  $("open-link").addEventListener("submit", (event) => {
    event.preventDefault();
    const raw = $("open-link-input").value.trim();
    const match = /(?:\/m\/)?([A-Za-z0-9_-]{22})\/?(?:[#?].*)?$/.exec(raw);
    const error = $("open-link-error");
    if (!match) {
      error.textContent = "That doesn't look like an Atlas Table map link (…/m/ followed by 22 letters and digits).";
      error.classList.remove("hidden");
      return;
    }
    location.href = `/m/${match[1]}`;
  });
}

wireForge();
wireOpenLink();
loadMe();
loadYours();
loadGallery();
