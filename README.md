# Atlas Table

A table for fantasy maps that a small group shapes together, live. Make a
world, raise its mountains, paint its forests, set down villages, draw town
walls and roads, and send a link: everyone with it sees each change arrive
within a second. No account is needed.

## Try it

- **Home** ([`/`](/)): a world is generated for you; press **Create this
  world** to make it yours. **Help** replays a one-minute tour.
- **Editor**: Land, Terrain and Water shape the map, and Places sets down
  buildings, walls, palisades and roads. **Chart** is a flat map;
  **Relief** is the same map in 3D. **Share** gives an edit link and a view
  link.
- **The shared world** ([`/world/`](/world/)) is open to anyone, so two
  browsers can try it together straight away.

## What "good" means here

Good means a handful of people can make one convincing map together, and
trust it. Three parts:

1. **It looks like a map worth keeping.** Painted cartography, in the style
   of Inkarnate and Wonderdraft, not a tile grid or icons on a picture. My
   first version put marks on a fixed island picture; I threw it away
   because nobody would want to keep what it made.
2. **Other people make it better, not riskier.** You see who is here and
   what they change, live. Undo only ever takes back your own work, and it
   never overwrites a collaborator's newer edit.
3. **Nothing is lost by accident.** Maps survive restarts and redeploys.
   Named versions can be restored, with a checkpoint taken first, and maps
   can be exported and imported.

It is built for a small, known group rather than a crowd. Clay Shirky calls
this "software designed in and for a particular social situation"
([*Situated Software*](https://gwern.net/doc/technology/2004-03-30-shirky-situatedsoftware.html),
2004), and Robin Sloan describes making an app "for, and with, my family"
([*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/),
2020). The design borrows from tools people already trust:
- Excalidraw and tldraw: rooms joined by a link, not an account, and the
  work before any sign-up;
- Owlbear Rodeo: your own maps first, as pictures;
- Figma and Google Docs: named versions;
- Dungeondraft: walls drawn point by point.

The full list is in [`CREDITS.md`](CREDITS.md).

## What is enforced, and what is judged

**Enforced by the checks in [`spec/`](spec/)**, run on every push:
- A view link can never write.
- Each map's cells, events and activity stay inside that map.
- A change reaches everyone else within a second.
- Undo touches only your own changes, and never a collaborator's newer
  edit.
- A version restores the map exactly.
- Places and walls stay on land.

**Judged by looking**, under the rule in [`CLAUDE.md`](CLAUDE.md): a visual
change isn't done until it has been rendered, in the browser, beside
reference maps. This covers how the terrain, buildings and walls look, and
whether the phone layout is usable. `ROADMAP.md` records those judgements,
including the failures.

## What I chose not to build

- **Accounts.** A link is the permission, as in Excalidraw and tldraw.
- **Locking land to one person.** The map is a shared canvas, and
  last-write-wins is enough for one server ([`ADR.md`](ADR.md)).
- **A city-scale isometric view.**
- **Unlimited undo.** It is 30 steps; versions are the durable way back.

## Known limits

- Undo history is lost on a server restart, and there is no redo.
- The server holds at most 150 private maps.
- Walls are small in Chart view until you zoom in.
- The ground inside a walled town keeps its painted forest colour.

The first prototype, The Isle, still runs at [`/isle/`](/isle/), and a live
log of who did what is at [`/logs/`](/logs/).
