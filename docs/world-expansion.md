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
