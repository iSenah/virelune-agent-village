# Village models

Custom GLB models for Virelune Agent Village. `manifest.json` maps each building id and resident lineage to a file and a target size; the village scales every model to that size, stands it on the ground, and faces its front (+Z, Blender's default glTF export) toward the plaza.

| Village id | File | Original export |
| --- | --- | --- |
| town-hall (Echo) | `buildings/town-hall.glb` | `Echo_Building.glb` |
| library (Claude) | `buildings/library.glb` | `Claude_Building.glb` |
| engineering-forge (Codex) | `buildings/engineering-forge.glb` | `Codex_Building.glb` |
| unreal-workshop (Aura) | `buildings/unreal-workshop.glb` | `Aura_Building.glb` |
| blender-house (Codex · Blender, Claude · Blender) | `buildings/blender-house.glb` | `Blue_Building.glb` |
| unreal-studio (Codex · Unreal, Claude · Unreal) | `buildings/unreal-studio.glb` | `Unreal_Building.glb` |
| post-office (Scribe) | `buildings/post-office.glb` | `Scribe_Building.glb` |
| echo, claude, codex, aura, scribe | `characters/<name>.glb` | `<Name>.glb` |
| street-lamp (every lamp post) | `props/street-lamp.glb` | `Village_Street_Lamp.glb` |

Combination residents (Codex · Blender, Claude · Unreal, ...) reuse their runtime's character model and carry a small specialty emblem.

## Browser versions

These files are browser copies made with `scripts/optimize_glb.py`: textures resized from 2048 px to 1024 px and stored as JPEG, which cuts GPU texture memory for the village from about 600 MB to about 150 MB. Geometry, UVs, normals and tangents are byte-for-byte identical to the export, with one exception: the street lamp is repeated about 30 times, so it was also simplified from 80k to 12k triangles with [gltfpack](https://github.com/zeux/meshoptimizer) (`gltfpack -i Village_Street_Lamp.glb -o lamp.glb -si 0.08 -sp -se 0.03 -noq -kn -km`), which keeps its UVs and looks the same at village scale. All lamp posts share one instanced mesh. Keep the full-resolution originals in your art folder; they are not stored in this repo.

## Distance versions (lod/)

Each building and character has a lighter copy under `lod/` that the village shows when the model is far from the camera. It was made with gltfpack (`-si 0.15 -sp -se 0.02 -noq -kn -km`, which keeps UVs) and then `optimize_glb.py --size 16`: its own textures are tiny placeholders, because the village reuses the full model's textures. If you replace a model, regenerate its copy the same way, or remove the `lod` entry from `manifest.json` to always show the full model.

## Replacing or adding a model

1. Export a GLB from Blender (front facing -Y in Blender, which becomes +Z in glTF).
2. Make a browser copy: `python scripts/optimize_glb.py MyModel.glb web/assets/models/buildings/<id>.glb` (needs Python and Pillow).
3. Add or update the entry in `manifest.json` (`width` for buildings, `height` for characters).
4. Run `npm test`: it checks every model is valid, at most 1024 px textures and 100k triangles, and that the manifest matches the registries.

If a model is missing or fails to load, the village keeps the procedural placeholder for it and the top bar shows how many models are using placeholders.
