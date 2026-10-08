#!/usr/bin/env python3
"""Make a browser-friendly copy of a GLB exported from Blender.

Only the embedded textures change: they are resized (default 1024 px) and re-encoded as JPEG.
Geometry, UVs, normals, tangents, materials and node data are copied byte for byte.
Why: ten models with three 2048x2048 textures each need ~600 MB of GPU memory; at 1024 px it is ~150 MB.

Usage:  python scripts/optimize_glb.py <input.glb> <output.glb> [--size 1024] [--quality 88]
Requires Python 3 and Pillow (pip install pillow). The village itself never needs Python.
"""
import argparse
import io
import json
import struct

from PIL import Image

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


def read_glb(path):
    data = open(path, 'rb').read()
    magic, version, _length = struct.unpack_from('<III', data, 0)
    if magic != GLB_MAGIC or version != 2:
        raise ValueError(f'{path} is not a glTF 2.0 binary')
    json_len, json_type = struct.unpack_from('<II', data, 12)
    assert json_type == CHUNK_JSON
    doc = json.loads(data[20:20 + json_len])
    off = 20 + json_len
    bin_len, bin_type = struct.unpack_from('<II', data, off)
    assert bin_type == CHUNK_BIN
    return doc, data[off + 8: off + 8 + bin_len]


def pad4(b, fill=b'\x00'):
    return b + fill * ((4 - len(b) % 4) % 4)


def optimize(src, dst, size, quality):
    doc, binary = read_glb(src)
    image_views = {img['bufferView']: i for i, img in enumerate(doc.get('images', [])) if 'bufferView' in img}
    new_bin = bytearray()
    before = after = 0
    for vi, view in enumerate(doc['bufferViews']):
        start = view.get('byteOffset', 0)
        chunk = binary[start:start + view['byteLength']]
        if vi in image_views:
            img = Image.open(io.BytesIO(chunk))
            before += len(chunk)
            has_alpha = img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info)
            if max(img.size) > size:
                img = img.resize((size, size) if img.size[0] == img.size[1] else (max(1, img.size[0] * size // max(img.size)), max(1, img.size[1] * size // max(img.size))), Image.LANCZOS)
            out = io.BytesIO()
            if has_alpha:
                img.save(out, 'PNG', optimize=True)
                mime = 'image/png'
            else:
                img.convert('RGB').save(out, 'JPEG', quality=quality, optimize=True, progressive=True, subsampling=0)
                mime = 'image/jpeg'
            chunk = out.getvalue()
            after += len(chunk)
            doc['images'][image_views[vi]]['mimeType'] = mime
        while len(new_bin) % 4:
            new_bin.append(0)
        view['byteOffset'] = len(new_bin)
        view['byteLength'] = len(chunk)
        view['buffer'] = 0
        new_bin.extend(chunk)
    new_bin = pad4(bytes(new_bin))
    doc['buffers'] = [{'byteLength': len(new_bin)}]
    doc.setdefault('asset', {})['extras'] = {**doc['asset'].get('extras', {}), 'virelune': f'textures resized to {size}px by scripts/optimize_glb.py'}
    json_bytes = pad4(json.dumps(doc, separators=(',', ':')).encode(), b' ')
    total = 12 + 8 + len(json_bytes) + 8 + len(new_bin)
    with open(dst, 'wb') as f:
        f.write(struct.pack('<III', GLB_MAGIC, 2, total))
        f.write(struct.pack('<II', len(json_bytes), CHUNK_JSON))
        f.write(json_bytes)
        f.write(struct.pack('<II', len(new_bin), CHUNK_BIN))
        f.write(new_bin)
    return before, after, total


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('src')
    p.add_argument('dst')
    p.add_argument('--size', type=int, default=1024)
    p.add_argument('--quality', type=int, default=88)
    a = p.parse_args()
    before, after, total = optimize(a.src, a.dst, a.size, a.quality)
    print(f'{a.dst}: textures {before / 1048576:.1f} MB -> {after / 1048576:.1f} MB, file {total / 1048576:.1f} MB')
