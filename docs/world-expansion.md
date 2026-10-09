# World expansion

The expanded village follows the "Expanded Layout" concept: Founders' Square in the middle, Creative Workshops to the east, the Artisan Quarter to the west, Scholars' Heights on the cliffs to the north, and the Forgotten Woods to the southeast.

## Decisions (October 2026)

| Question | Decision |
| --- | --- |
| Blender House and UE Studio | Move east to a Creative Workshops district across the river, as in the concept image |
| Codex·Blender, Claude·Blender, Codex·Unreal, Claude·Unreal | Become **execution profiles** of the one Claude and the one Codex (`config/profiles/`). No figures or chats of their own. Old variant conversations stay in the database, read-only (Profile tab). |
| Paid use for Claude's profiles | Follows Claude's single **Allow paid use** switch |
| Gemini, Copilot, DeepSeek | Registered as **planned** residents: home reserved, no provider, never connected, no messages, no figure until models arrive |

## Milestone 2: layout data and resident architecture (done)

- `config/layout/world.json` holds districts, the 12 building slots (position, the point the door faces, footprint, ground height, task-indicator height, a note about the final model), named waypoints, river crossings, roads (cobble, dirt, stairs, bridge) and the Scholars' Heights plateau.
- `web/src/village/worldModel.ts` (shared by server and browser) computes entrances, indicator anchors, the walk graph and shortest routes, and validates the layout:
  - no overlaps, nothing on the river or plaza;
  - raised buildings stand on their plateau, and nothing else does;
  - roads connect known points and do not cut through buildings;
  - every building can be reached on foot from the plaza;
  - every resident home and profile workplace exists.
- Village Hall loads and checks the layout at startup (problems appear in the activity feed) and serves it at `GET /api/world`. Each building comes with its entrance, indicator anchor, residents, and the profiles that work there. Each resident comes with its home and workplaces, taken from the registry.
- Routes for V3: for example, Claude walks Library → plaza → east bridge → Creative Workshops → Blender House (81 m). DeepSeek's cottage is reached only by the dirt road, and the Heights by stairs.

## Milestone 3: terrain, roads, crossings and landscaping (done)

The 3D village is now built from the layout that Village Hall sends (`GET /api/world`). Moving a building in `config/layout/world.json` moves its plinth, road, lamps and sign. If the layout cannot be read, the browser falls back to Founders' Square alone.

- **Roads** (`web/src/village/roads.ts`): every cobble road in the village is one batched set of three draw calls (mortar, stones, curbs). Dirt roads are one textured ribbon, and the Heights stairs are one merged mesh with low side walls. Roads stop at the edge of the plaza and of the district squares.
- **River crossings**: one arched bridge per crossing in the layout (five now; a new one at the west leads to the Artisan Quarter). Lamp ids for the four original bridges are unchanged, so saved lamp rotations still apply.
- **Scholars' Heights** (`web/src/village/terrain.ts`): an 8 m plateau from the layout outline, with a grass top and layered rock sides. Boulders gather at the foot of the cliff, a stone railing runs along the edge facing the village, and two waterfalls (angles set in the layout) drop into creeks that feed the river.
- **District squares**: flagstone squares at the Creative Workshops, the Artisan Quarter and the Scholars' court (`squares` in the layout). Each has two lamp posts placed away from the roads.
- **Artisan Quarter**: hay bales, crates and barrels beside the two workshop slots.
- **Forgotten Woods**: darker forest floor, about 150 tightly packed dark pines, mossy rocks and three faint mist sprites. There are no lights and no particles.
- **Landscape** reaches about 120 m from the fountain. It keeps off roads, squares, building lots, the river and the cliff edge, and plants on the Heights stand on the plateau.
- **Camera**: wider overview, zoom out to 260 m, panning limited to the village area (mouse and keyboard). The sun's shadow now follows where you look and widens when you zoom out, so the larger village keeps sharp shadows up close with the same 2048 px map.
- **Signs** state only registry facts:
  - workplaces name who works there;
  - planned homes say "Planned resident · not connected";
  - the two service slots say "Not connected · model coming".
- **New slots get no stand-in house.** Until their models arrive they show only a plinth and sign (a development marker follows in milestone 4).

Cost (overview, all models loaded): High 221 draws / 973k triangles, Medium 937k, Low 901k (Low also has no shadows and 44% fewer pixels). Before the expansion it was 205 draws / 857k. The 36 lamp posts (12k triangles each) are now the largest item at 434k; milestone 6 looks at them.

## Milestone 4: building slots and future residents (done)

Five slots wait for their models: Tripo Stable, Runway Cinema, Gemini Observatory, Copilot Commandery and DeepSeek Gothic Cottage. None of them gets a stand-in house.

- **Development marker**: each slot shows the following, coloured by kind (blue for homes, gold for workplaces, purple for services):
  - a see-through volume of roughly the final size, with a dashed outline;
  - an arrow at the entrance;
  - a label on the plinth naming what will stand there, from `modelNote` in the layout.

  **Graphics → Show building slots** hides all markers. A slot's marker also hides by itself once its model loads.
- **Layout guides** (**Graphics → Show layout guides**, or `?guides`; off by default) draw, straight from the layout data:
  - the walkable paths (cyan);
  - every entrance (rings);
  - the anchor above each building kept for future task indicators (gold).
- **Place card**: clicking a building nobody lives in (Blender House, UE Studio, Tripo Stable, Runway Cinema) opens a card instead of doing nothing. It shows:
  - the district;
  - who works there, through which profiles, with buttons to open those residents;
  - the connection state, in plain words (service slots: "Not connected. No integration exists for this building yet");
  - the coming model, which way the entrance faces, the walking distance from the fountain, and the space reserved above.
- The resident list shows service buildings under their district as "Service building · not connected · model coming".
- Future residents (Gemini, Copilot, DeepSeek) were registered as planned in milestone 2: homes reserved, no provider, no figure, chat closed with an explanation.

### When a final model arrives

1. Put the file at `web/assets/models/buildings/<building id>.glb` (optionally a lighter copy under `lod/`, as for the others).
2. Add it to `web/assets/models/manifest.json` under `buildings` with its `width`.
3. If its footprint or door differs, adjust `x`, `z`, `w`, `d` or `face` for that building in `config/layout/world.json` and run `npm test`. The layout checks catch overlaps, unreachable entrances, and buildings hanging off the Heights.

The marker disappears on its own; the plinth, sign, lamps and road stay.

## Milestone 5: camera, navigation and selection (done)

- **Go to** in the top bar flies the camera to the whole village, to one of the five districts, or to any building, grouped by district. It only moves the camera.
- Keyboard:
  - **Home** or **0**: whole village;
  - **1** to **5**: the districts in layout order (1 is Founders' Square, with the classic view of the square);
  - WASD or the arrows pan, Q and E turn, + and − zoom, as before.
- District views keep the side the camera is already on, so the picture does not spin. The plaza is always one key away.
- Panning is limited to the village area, and the camera can zoom out to 260 m.
- Selection works across the whole village:
  - clicking a building with residents opens their window (Gemini's explains it is planned);
  - clicking a shared workplace or service slot opens its place card;
  - lamp posts in the new districts can be selected and turned like the others.
