# Village performance audit (V2, October 2026)

Measured with the new diagnostics display (`?diag`, or **Graphics → Show diagnostics**, or the **G** key) in a 1600×1000 window. The cloud workspace renders in software, so **frame rates there mean nothing**. Draw calls, triangles, textures, lights and shaders are exact and the same on any machine. Check frame rates on your own PC with the diagnostics display.

## What the village cost before

Overview camera, all 17 custom models loaded, at the default (High) setting:

| Part | Draw calls | Triangles | Notes |
| --- | --- | --- | --- |
| 9 residents | 22 | 721k | each character model is 80k triangles, drawn at full detail even when 2 cm tall on screen |
| 7 buildings | 84 | 569k | 80k triangles each; 28 of the draws were smoke puffs with opacity 0 |
| 33 lamp posts | 33 | 396k | one instanced mesh (12k triangles each) plus 33 glow sprites |
| Landscape | 7 | 90k | trees, pines, bushes, rocks, flowers, grass tufts, all instanced |
| Hub (fountain, river, bridges, cliffs) | 62 | 62k | |
| Roads, plaza, fences, ground | 32 | 53k | |
| **Total** | **240** | **1.89M** | 54 textures, 34 shaders, 1 sun with a 2048 px shadow map |

## Findings

1. **Full-detail models at any distance (largest cost).** The 12 building and character models are 80k triangles each, and the overview drew all of them at full detail. Together that was 1.3M of the 1.9M triangles.
2. **Invisible things still drawn.** Chimney smoke puffs (4 per building) were "hidden" with opacity 0 but still drawn every frame (28 draws). Status rings under residents were likewise drawn at opacity 0.
3. **Building night lights never worked with the custom models (bug).** Each building's window light was attached to the placeholder body, which is hidden once the custom model loads. A connected building's light at night was never visible.
4. **Shadows: already good.** The shadow map renders only when something moves or a model arrives, not every frame. Tiny ground detail does not cast shadows.
5. **Textures: reasonable.** All model textures were already reduced to 1024 px JPEG (3 per model, shared between residents that use the same model). About 150 MB of GPU memory in total.
6. **Repeated objects: already instanced.** Lamp posts, trees, rocks, cobbles, fences and balustrades each use one instanced mesh per kind.
7. **Picking and resolution: already handled.** Mouse picking uses invisible boxes, not the detailed models, and the render resolution already adapted to slow GPUs.
8. **Lamp glows (left as they are).** 33 separate sprites cost 33 draw calls. Merging them into one would change how they look up close (GPU point-size limits), so they stay.
9. **Lamp posts are now the biggest single item** (396k triangles in one draw). The lamp cannot be simplified further without breaking its textures (checked earlier at 4.6k triangles), so it stays. It is one draw call, which GPUs handle easily.

## What changed

| Change | Effect | Visual change |
| --- | --- | --- |
| **Distance detail** for every building and character: a light copy (12k triangles for characters, 17–25k for buildings, made with gltfpack and reusing the full model's textures) is shown when the model is far away; the full model is shown up close | Overview: residents 721k → 108k, buildings 569k → 148k triangles | None at the distances where the copy is used (compared side by side) |
| Smoke puffs and resident rings are **not drawn while hidden** | −28 or more draw calls | None |
| Building lights moved to the building and **only active while on** | Fixes the night-light bug; an unlit building costs no lighting time | Lit buildings now actually glow at night |
| **Graphics presets** Low / Medium / High, plus **Auto** | See below | Only at Low and Medium |
| **Diagnostics display** | Frame rate, frame time (average and worst), draw calls, triangles, textures, shaders, lights, shadows, resolution, GPU name, and the cost of each part of the village | None |

**Result (overview, High):** 240 → 205 draw calls, 1.89M → 857k triangles (−55%), with the same picture. Up close everything is still full detail.

## Presets

| | High | Medium | Low |
| --- | --- | --- | --- |
| Resolution | up to 1.5× on high-density screens (adapts down to 0.75×) | up to 1× | up to 0.75× (down to 0.5×) |
| Shadows | soft, 2048 px | sharper, 1024 px | off |
| Distant models use the light copy from | 70 m (buildings), 45 m (residents) | 60% of that distance | always |
| Grass tufts and flowers | all | half | none |
| Frame-rate cap | none | none | 30 fps (keeps laptops cool) |
| Overview cost (measured) | 205 draws, 857k triangles | 205 draws, 832k | 203 draws, 806k, plus 44% fewer pixels and no shadow pass |

**Auto** (the default) starts at High and lowers the resolution first. It drops one preset only after about 4 seconds of under 28 fps at the lowest resolution, and steps back up after 30 seconds of more than 58 fps at full resolution. Your choice and the diagnostics toggle are remembered in this browser only.

Presets never remove buildings, residents, lamps, trees, rocks, water or any other feature. Only grass tufts and flowers are thinned at Medium and Low.

## Worth checking on your PC

- Open **Graphics → Show diagnostics** and look at the frame rate in the overview and close to a building, at High and at Low. If High holds 55–60 fps, Auto stays at High.
- If the worst frame time spikes when you first fly to a building, that is the full-detail model being drawn for the first time. It should happen once.
- The night lights of connected buildings should now glow after dark (once a resident is really connected).

## Next candidates (not done)

- A second, lighter lamp model made in Blender (the automatic simplifier cannot keep its UVs below 12k triangles).
- Compressed textures (KTX2) would cut GPU memory further, but they need a texture encoder that is not available in the cloud workspace.
- A paged event log in the browser, once the log grows large (not a rendering cost).

## After the world expansion (October 2026)

The village grew from one square to five districts: 12 building slots, a raised plateau with cliffs and waterfalls, five bridges, three flagstone squares, and about twice the trees. Measured the same way (overview, all models loaded):

| | Before the expansion | Expanded, before tuning | Expanded, now |
| --- | --- | --- | --- |
| High | 205 draws, 857k triangles | 221 draws, 973k | 241 draws, **542k** |
| Medium | 832k | 937k | 506k |
| Low | 806k | 901k | 470k |

- **Lamp posts got distance detail.** Posts within 70 m of the camera (54 m at Medium, 30 m at Low) use the full model, one instanced draw. The rest share a second instanced draw of a light stand-in (about 100 triangles instead of 12k), with the same height, colours, lantern position and glow. In the overview the 36 posts cost 2k triangles instead of 434k. Up close nothing changes.
- **All cobble roads are batched** into three draw calls for the whole village, instead of three per road.
- **New scenery is instanced or merged:** cliff boulders, railings, flagstones, props, the woods' pines and rocks. The plateau is a single mesh.
- **Effects stay cheap.** There are no new lights. The woods' mist is three sprites, and the waterfalls reuse the animated water textures. The only shadow-casting light is still the sun. Its shadow now follows the camera and widens when zoomed out, and it is redrawn only when something moves.
- The extra draw calls come mostly from development markers and signboards on the five model-less slots. They go away as models arrive.

Close-up costs are unchanged: about 900k triangles at a building's door, because buildings and residents near the camera are drawn at full detail.
