// The first-use guide: a welcome dialog offering a short tour, and the tour
// itself, which points at the real controls one at a time. Built on
// driver.js (MIT, vendored; see CREDITS.md) rather than hand-rolled - it is
// the established open-source library for product tours, and the AGPL
// alternatives (Shepherd, Intro.js) would put licence terms on this repo.
//
// Two tours, one per page, each pointing at that page's own controls:
//  - home: how to make a world, private versus shared, edit versus view
//    links, ending on "Create this world";
//  - editor: shaping the land, views, undo, sharing.
// The welcome shows once per browser (localStorage); Help reopens either
// tour at any time.
import { driver } from "/world/vendor/driver/driver.js";

const SEEN_KEY = "atlas.guide.welcomed";

function seen() {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // storage blocked: don't nag on every visit
  }
}
function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {}
}

// The first element matching any of the selectors that is actually on
// screen: a step can name a desktop control and its phone stand-in.
const visible = (sel) => [...document.querySelectorAll(sel)].find((el) => el.getClientRects().length > 0) ?? null;

// Each step points at the first visible match; steps with none (hidden on
// a phone, or absent for a view link) are dropped, so the tour never
// points at nothing.
function run(steps, { onDone } = {}) {
  const live = steps.flatMap((s) => {
    if (!s.element) return [s];
    const el = visible(s.element);
    return el ? [{ ...s, element: el }] : [];
  });
  const tour = driver({
    steps: live,
    showProgress: true,
    progressText: "{{current}} of {{total}}",
    nextBtnText: "Next",
    prevBtnText: "Back",
    doneBtnText: "Done",
    allowClose: true,
    overlayOpacity: 0.62,
    stagePadding: 6,
    stageRadius: 8,
    popoverClass: "atlas-guide",
    smoothScroll: true,
    onDestroyed: () => onDone?.(),
  });
  tour.drive();
  return tour;
}

export const HOME_STEPS = [
  {
    popover: {
      title: "Welcome to Atlas Table",
      description: "Atlas Table is a table for fantasy maps. You make a world, shape its land, and share a link so friends can work on it with you, live. This takes about a minute.",
    },
  },
  {
    element: ".forge-frame",
    popover: {
      title: "A world, made just for you",
      description: "This map was generated when you opened the page. Press <b>Another world</b> for a new one. The seed underneath always makes the same world, so a good one is never lost.",
      side: "left",
    },
  },
  {
    element: ".forge-templates",
    popover: {
      title: "Choose its shape",
      description: "A continent, a coast or a scatter of islands. Under <b>Adjust land, mountains and forest</b> you can change how much of each it has.",
    },
  },
  {
    element: "#world-name",
    popover: {
      title: "Name it",
      description: "Give your world a name. You can rename it later.",
    },
  },
  {
    element: "#create-button",
    popover: {
      title: "Your own world is private",
      description: "Creating a world makes a <b>private map</b>. No one else can find it. Only people you send its link to can open it, and nothing needs an account.",
    },
  },
  {
    element: ".step-list li:nth-child(3)",
    popover: {
      title: "Edit links and view links",
      description: "Every private map has two links. An <b>edit link</b> lets someone paint with you, live. A <b>view link</b> lets them watch every change but not make any. You can withdraw either link at any time.",
      side: "top",
    },
  },
  {
    element: '.masthead-nav a[href="/world/"], .forge-alt a',
    popover: {
      title: "The shared world is different",
      description: "There's also one <b>shared world</b> that anyone can paint, with no link needed. It's a good place to try the tools. Your own maps are separate from it.",
    },
  },
  {
    element: "#gallery",
    popover: {
      title: "The gallery",
      description: "Maps their makers chose to show. Open one to watch it change live. Your maps only appear here if you choose to publish them.",
      side: "top",
    },
  },
  {
    element: "#create-button",
    popover: {
      title: "Ready? Create this world",
      description: "Press <b>Create this world</b> to make it yours. It opens in the editor, where you can raise mountains, paint forests and set down villages.",
      side: "top",
    },
  },
];

export const EDITOR_STEPS = [
  {
    element: ".category-rail",
    popover: {
      title: "Tools",
      description: "<b>Land</b> raises and lowers ground, <b>Terrain</b> paints forest, sand and rock, <b>Water</b> shapes the sea, and <b>Places</b> sets down buildings.",
      side: "right",
    },
  },
  {
    element: ".options-panel",
    popover: {
      title: "Pick a brush",
      description: "Choose a brush here, then drag on the map. Size and strength are at the bottom. On a keyboard, <b>[</b> and <b>]</b> change the size.",
      side: "left",
    },
  },
  {
    element: "#canvas-area",
    popover: {
      title: "Paint on the map",
      description: "Drag on the map to paint. Scroll to zoom, and right-drag or middle-drag to pan.",
    },
  },
  {
    element: ".view-switch",
    popover: {
      title: "Chart and Relief",
      description: "<b>Chart</b> is a flat map, best for precise work. <b>Relief</b> is the same map in 3D. You can edit in both.",
    },
  },
  {
    element: "#undo-button, #rail-undo",
    popover: {
      title: "Undo",
      description: "Undo takes back your own changes, one step at a time, strokes and buildings alike (<b>Ctrl+Z</b> or <b>Cmd+Z</b>). It never touches what other people have done.",
    },
  },
  {
    element: "#presence",
    popover: {
      title: "Who's here",
      description: "Everyone working on this map right now appears here under their own colour. Their changes show up live.",
    },
  },
  {
    element: "#share-button",
    popover: {
      title: "Share",
      description: "Send an <b>edit link</b> to paint together, or a <b>view link</b> to let people watch. Versions and export are here too.",
    },
  },
  {
    element: "#me-button",
    popover: {
      title: "You",
      description: "Your name and colour, as others see you. Click to change them.",
    },
  },
];

// The welcome dialog: a plain <dialog>, so Escape and the close button both
// work and focus is trapped. Shown once per browser on the home page.
export function offerWelcome(dialog, startTour) {
  if (seen()) return;
  markSeen();
  dialog.querySelector("[data-guide-start]").addEventListener("click", () => {
    dialog.close();
    startTour();
  });
  dialog.showModal();
}

export function startHomeTour() {
  return run(HOME_STEPS, { onDone: () => document.getElementById("world-name")?.focus({ preventScroll: true }) });
}

export function startEditorTour() {
  return run(EDITOR_STEPS);
}
