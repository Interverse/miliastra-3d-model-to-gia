# 3D Model → GIA Converter

A static web app that converts 3D models (`.fbx`, `.obj`, `.glb`/`.gltf`, `.stl`)
into the proprietary `.gia` decoration format. Everything — rendering,
conversion, and file generation — runs in the browser. No backend.

## Running

The app uses ES modules, so it needs to be served over HTTP (any static host):

- **GitHub Pages**: push this folder to a repo, enable Pages. Done.
- **Locally**: `python -m http.server` (or `npx serve`) in this folder, then
  open `http://localhost:8000`.

Three.js is loaded from the jsDelivr CDN via an import map (see `index.html`);
no build step or `npm install` is required.

## Pages

Both pages share one implementation (`js/app.js` + `js/ui-shell.js`) — same
pipeline, viewer, and parameters.

- `index.html` — the main landing page. Outputs only the generated primitive
  data: **View primitives** opens a popup table listing each primitive's
  Position, Rotation, Zoom (scale), and Color, with a per-row checkbox to
  mark primitives as manually processed (plus a Copy JSON button). Positions
  and zoom are in units of 0.1 m; rotations in degrees.
- `gia/index.html` — the `.gia` export page: **Download .gia**, the collision
  toggle, and format documentation links live here.

## Textures

Many formats reference external texture files. Upload them together with the
model **or separately at any time** (drag-drop or file picker) — the app keeps
a file library and reloads the model whenever new files arrive:

- References are resolved by file name (case-insensitive, ignoring folders),
  so absolute paths baked into FBX/OBJ files still match.
- Supported: `.png` `.jpg` `.jpeg` `.webp` `.bmp` `.gif` `.tga`.
- If exactly one uploaded image is not referenced by any material and the
  model has UV-mapped meshes without a base color map, it is applied to them
  automatically (handy for OBJ files without an MTL).
- The Model panel lists each texture with its status: *used by material*,
  *applied (no map)*, *not referenced*, or *waiting for model*.

Uploaded textures are used everywhere: viewport rendering, per-triangle color
sampling, subdivision decisions, preview overlay, and the generated `.gia`.

## How it works

Each source triangle is reproduced by placing a canonical right-triangle
decoration model (1×1 m legs at scale 2, thin X axis, right-angle corner at
the origin) with a position, per-axis scale, and Euler rotation:

1. **Extract** mesh geometry (world-transformed, triangulated). Animations,
   skeletons, cameras, and lights are ignored.
2. **Color** each triangle from the material base color and base color
   texture. Triangles spanning multiple texture colors are recursively
   subdivided (configurable depth) until each piece is within the color
   tolerance.
3. **Merge** adjacent coplanar triangles whose colors are within tolerance,
   re-triangulating the merged region with fewer triangles (removes grid
   tessellation on flat surfaces).
4. **Decompose** every triangle into 1–2 right triangles. Triangles whose
   largest angle is within the snap threshold of 90° map to a single
   decoration; others are split by the altitude from the largest angle.
5. **Write** `.gia`: one object model per 999 decorations (auto-split), plus
   one decoration entity per triangle. Output is byte-level compatible with
   editor exports (verified against all sample files).

## Parameters

| Parameter | Effect |
|---|---|
| Priority preset | Fidelity / Balanced / Minimal bundles of the below |
| Input unit scale | Source units → meters multiplier (e.g. 0.01 for cm FBX) |
| Primitives | Triangles / Squares / Both (see below) |
| Decimation | Vertex-clustering simplification of the source mesh (UV-preserving) before conversion — for high-poly models |
| Color tolerance | RGB distance treated as "same color" (merge + subdivision) |
| Texture subdivision depth | Max recursion for texture detail (4ⁿ growth) |
| Right-angle snap | Near-right triangles become one decoration instead of two |
| Max decorations | Hard cap; smallest triangles dropped first |
| Merge coplanar faces | Toggle the reduction pass |
| Thickness scale | Decoration thin-axis scale |
| Flip Z | Convert -Z-forward sources to the target's Y-up +Z-forward |
| Euler order | Rotation convention used by the target engine (default YXZ) |
| Alpha cutoff | Texture regions below this alpha generate no geometry (fully transparent pixels are always skipped) |
| Transform | Pivot (moved to the origin) and rotation applied before conversion; previewed live in the viewport |
| Collision | Whether exported models collide (object component 5) |

### Square primitives

Besides the right triangle (model 20002125), the converter can emit the
square decoration (model 10009001, 1×1 m at scale 10, thin Y, centered).

- **Triangles** — original behavior.
- **Both** — right-triangle pairs forming exact rectangles become squares;
  equal-size aligned squares are then greedy-coalesced into maximal
  rectangles (a uniform voxel face collapses to one decoration). No holes or
  fidelity loss; leftovers stay triangles. Recommended for voxel models.
- **Squares** — like Both, but leftover triangles are covered by squares
  spanning their legs (overdraws the mirror half; fine for voxel content,
  visible on irregular geometry).

### Sprite mode (2D → 3D)

Upload an image with no model loaded and click **Use image as 3D sprite**:
the sprite is extruded to a configurable thickness (m) at a configurable
pixel size (m/px). Only pixels above the alpha cutoff generate geometry.
Opaque pixels are greedy-meshed into maximal same-color rectangles and each
rectangle becomes ONE elongated square primitive — the square decoration is
a unit cube, so a single stretched instance covers the front face, back
face, and all edges (far fewer decorations than per-face geometry).

### Texture matching

Model-referenced textures resolve against uploaded files by basename,
case-insensitively, ignoring folders, and — when the exact name is missing —
by stem with any image extension (an FBX referencing
`C:\...\sword_dif.tga` is satisfied by an uploaded `sword_dif.png`).

## Reusable engine

`engine/` is dependency-free and usable outside the website (Node, CLI, other
apps):

```js
import { convert, buildGia, splitIntoModels } from './engine/index.js';

const meshes = [{
  positions: Float32Array,  // xyz triplets
  indices: Uint32Array | null,
  uvs: Float32Array | null, // for texture sampling
  matrixWorld: number[16] | null,
  color: [r, g, b],         // 0..255 material base color
  texture: { width, height, data } | null, // RGBA pixels
}];

const { decorations, stats } = convert(meshes, { colorTolerance: 30 });
const bytes = buildGia({
  models: splitIntoModels('My Model', decorations),
  exportName: 'My Model',
});
```

- `engine/gia/gia-writer.js` — binary `.gia` writer (byte-exact vs samples)
- `engine/gia/gia-decoration.proto` — completed protobuf schema
- `engine/convert/` — geometry/color pipeline
- `docs/gia-format.md` — reverse-engineered format documentation

## Format notes

See [docs/gia-format.md](docs/gia-format.md). One caveat: the samples only
demonstrate axis-aligned rotations (90°/180°), so the engine's Euler
application order is assumed to be Unity-style YXZ. If arbitrary rotations
appear skewed in-game, switch **Euler order** to XYZ and regenerate.

## Layout

```
index.html          primitive-data landing page (thin skeleton)
gia/index.html      .gia export page (same shell + app, adds download)
css/style.css
js/ui-shell.js      shared UI markup for both pages
js/app.js           shared app logic (initApp), loaders, outputs
js/viewer.js        three.js scene + overlay
js/extract.js       three.js → engine mesh data
js/convert-worker.js  conversion Web Worker
engine/             reusable conversion engine (no dependencies)
tools/analyzer.html protobuf analyzer used to reverse-engineer .gia
docs/gia-format.md  format specification
```
