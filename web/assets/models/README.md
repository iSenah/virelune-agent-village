# Village models

Custom GLB models for Virelune Agent Village. `manifest.json` maps each building id and resident lineage to a file and a target size; the village scales every model to that size, stands it on the ground, and faces its front (+Z, Blender's default glTF export) toward the plaza.

| Village id | File | Original export |
| --- | --- | --- |
| town-hall (Echo) | `buildings/town-hall.glb` | `Echo_Building.glb` |
| library (Claude) | `buildings/library.glb` | `Blue_Building.glb` |
| engineering-forge (Codex) | `buildings/engineering-forge.glb` | `Codex_Building.glb` |
| unreal-workshop (Aura) | `buildings/unreal-workshop.glb` | `Aura_Building.glb` |
| blender-house | `buildings/blender-house.glb` | `Claude_Building.glb` (the orange-roofed model) |
| post-office (Scribe) | `buildings/post-office.glb` | `Scribe_Building.glb` |
| echo, claude, codex, aura, scribe | `characters/<name>.glb` | `<Name>.glb` |

Combination residents (Codex · Blender, Claude · Unreal, ...) reuse their runtime's character model and carry a small specialty emblem.

## Browser versions

These files are browser copies made with `scripts/optimize_glb.py`: textures resized from 2048 px to 1024 px and stored as JPEG. Geometry, UVs, normals and tangents are byte-for-byte identical to the export. That cuts GPU texture memory for the village from about 600 MB to about 150 MB. Keep the full-resolution originals in your art folder; they are not stored in this repo.

## Replacing or adding a model

1. Export a GLB from Blender (front facing -Y in Blender, which becomes +Z in glTF).
2. Make a browser copy: `python scripts/optimize_glb.py MyModel.glb web/assets/models/buildings/<id>.glb` (needs Python and Pillow).
3. Add or update the entry in `manifest.json` (`width` for buildings, `height` for characters).
4. Run `npm test`: it checks every model is valid, at most 1024 px textures and 100k triangles, and that the manifest matches the registries.

If a model is missing or fails to load, the village keeps the procedural placeholder for it and the top bar shows how many models are using placeholders.
