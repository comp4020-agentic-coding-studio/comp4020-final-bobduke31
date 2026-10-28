# Atlas Table

A table for fantasy maps that a small group shapes together, live. Raise
mountains, paint forests, set down villages, draw walls and roads, and send
a link: everyone with it sees each change within a second. No account is
needed.

## Try it

- **Home** ([`/`](/)): a world is generated for you; **Create this
  world** makes it yours.
- **Editor**: Land, Terrain and Water shape the map, and Places sets down
  buildings, walls, palisades and roads. **Chart** is a flat map;
  **Relief** is the same map in 3D. **Share** gives an edit link and a view
  link.
- **The shared world** ([`/world/`](/world/)) is open to anyone; try it
  in two browsers.

## What "good" means here

Good means a small group can build a world together in real time, and
enjoy doing it. That needs four things at once:

1. **Real collaboration.** You see who is here and each change as it
   lands. Undo only takes back your own work, and never overwrites a
   collaborator's newer edit.
2. **A result that looks like a map.** Painted cartography in the style of
   Inkarnate and Wonderdraft, not a tile grid or icons on a picture. My
   first version only let visitors drop marks on a fixed island picture,
   so I replaced it.
3. **Freedom to shape the world.** The map itself is what you edit:
   coastlines, seas, mountains, forests, towns and roads, not a fixed
   backdrop.
4. **Controls that stay out of the way.** A short tour, multi-step undo,
   walls that snap together, and an editor that also works on a phone.

Work should also be hard to lose: maps are kept across redeploys, and can
be saved as named versions or exported.

It is built for a small, known group rather than a crowd. Clay Shirky calls
this "software designed in and for a particular social situation"
([*Situated Software*](https://gwern.net/doc/technology/2004-03-30-shirky-situatedsoftware.html),
2004), and Robin Sloan describes making an app "for, and with, my family"
([*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/),
2020). The design borrows from tools people already trust:
- Excalidraw and tldraw: rooms joined by a link, not an account;
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
change isn't done until it has been rendered and compared with reference
maps. That covers how the map looks and whether the phone layout is usable.
`ROADMAP.md` records those judgements, including the failures.

## What I chose not to build

- **Accounts.** A link is the permission, as in Excalidraw and tldraw.
- **Locking land to one person.** The map is a shared canvas, and
  last-write-wins is enough for one server ([`ADR.md`](ADR.md)).
- **A city-scale isometric view.**
- **Unlimited undo.** It is 30 steps; versions are the longer-term way back.

## Known limits

- Undo history is lost on a server restart, and there is no redo.
- The server holds at most 150 private maps.
- Walls are small in Chart view until you zoom in.
- The ground inside a walled town keeps its painted forest colour.

The first prototype, The Isle, still runs at [`/isle/`](/isle/), and a live
log of who did what is at [`/logs/`](/logs/).
