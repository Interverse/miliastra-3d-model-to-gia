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

- `index.html` — the MAIN page: the `.gia` export site with **Download
  .gia**, the collision toggle, **Auto-Assemble On Runtime**, and format
  documentation links.
- `gia/index.html` — the primitive-data page. Outputs only the generated
  primitive data: **View primitives** opens a popup table listing each
  primitive's Position, Rotation, Zoom (scale), and Color, with a per-row
  checkbox to mark primitives as manually processed (plus a Copy JSON
  button). Positions and zoom are in units of 0.1 m; rotations in degrees.
  Contains no `.gia` references.

### Auto-Assemble On Runtime

Normally every generated object is exported as a STATIC unit prefab. With
**Auto-Assemble On Runtime** enabled, the export instead produces
dynamically assembled prefabs:

- every object becomes a **Dynamic Unit Prefab** with load optimization
  disabled ("Run If Out Of Range");
- the **first object is the Main object** (its name is prefixed with
  **"(Main)"**); every other object carries a **Follow Motion Device**
  ("Completely Follow");
- the Main object always owns a **node graph** that starts at *When Entity
  Is Created* and chains a *Create Prefab* node (referencing each follower's
  prefab ID inside the same file) into a *Switch Follow Motion Device Target
  by Entity* node, so every spawned part follows the Main object at runtime
  (with a single object the graph contains no Create Prefab chains).

## Textures

Many formats reference external texture files. Upload them together with the
model **or separately at any time** (drag-drop or file picker) — the app keeps
a file library and reloads the model whenever new files arrive:

- Files can also be pasted from the clipboard (Ctrl+V) anywhere on the page
  (except while typing in a text field): models, textures, .mtl, and raw
  copied images (e.g. screenshots, which enter the 3D-sprite path when no
  model is loaded) are detected and routed to the right workflow
  automatically. When several valid files are on the clipboard, a chooser
  lets you pick which to import.
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

## Localization

The site is fully localized (UI, tooltips, dialogs, statistics, warnings,
toasts, and the primitives table) into 15 languages: English, 简体中文,
繁體中文, 日本語, 한국어, Español, Français, Русский, ไทย, Tiếng Việt,
Deutsch, Bahasa Indonesia, Português, Türkçe, and Italiano. The language
selector in the sidebar footer switches instantly without a reload; the
choice persists, and the browser language is auto-detected on first visit.
Numbers format per locale via `Intl.NumberFormat`.

Translations live in `js/locales/<code>.js` — one flat dictionary per
language keyed identically to `js/locales/en.js` (the canonical set).
Adding a language = adding one file plus one row to `LANGS` in `js/i18n.js`;
no application code changes. Any key missing from a locale silently falls
back to English, never to blank text or raw keys. Static markup binds via
`data-i18n` / `data-i18n-title` attributes; dynamic strings go through
`t(key, params)` and re-render on language change, so future UI components
localize the same way.

## How it works

Each source triangle is reproduced by placing the canonical right-triangle
decoration model (v2 reference, model 20001925: legs of exactly 0.13 m along
local +Y and 0.27 m along local -Z at scale 1 — zoom = meters × 100/13 and
× 100/27, calibrated so two triangles tile a 1×1 m square seam-free; the
published 7.7/3.704 are roundings that leave ~1 mm/m gaps — thin X axis,
right-angle corner at the origin) with a position, per-axis scale, and Euler
rotation:

1. **Extract** mesh geometry (world-transformed, triangulated). The model's
   CURRENT pose is baked in: skinned meshes are CPU-skinned with the
   imported skeleton pose and active morph target influences are applied,
   so the output matches the viewport exactly rather than resetting to the
   bind/rest pose. Animations, cameras, and lights are ignored.
2. **Color** each triangle from the material base color and base color
   texture. By default, triangles spanning multiple texture colors are
   recursively subdivided (4-way midpoint, up to the configured depth)
   until each piece is within the color tolerance.

   **Smart edge detection (experimental, Direct mode)** replaces the
   recursive subdivision with region-based segmentation
   (`engine/convert/color-regions.js`): the texture is segmented once into
   simplified color regions (perceptual
   clustering with Lloyd refinement, negligible-difference merging, and
   insignificant-region absorption — dither and noise collapse into flat
   regions while small high-contrast details survive), then each triangle is
   split along fitted straight lines between regions (texel-axis cuts
   preferred, guillotine slices for enclosed regions). A straight color
   boundary costs a handful of well-shaped polygons instead of 4ⁿ recursive
   midpoint fragments; midpoint subdivision remains only as a fallback for
   genuinely non-linear boundaries (capped by the subdivision depth).
   Cuts are guided by globally consistent boundary polylines: region
   contours are traced on the label grid, simplified (Douglas–Peucker) and
   least-squares refit, so a straight edge reconstructs as ONE exactly
   straight line and a curve as one smooth polyline of balanced secants —
   every piece in every triangle cuts along the same shared lines, so
   boundaries can never zigzag from independently fitted chords. The curve
   tolerance adapts to boundary contrast (faint edges take coarser secants;
   sharp feature lines and silhouettes stay tight), anti-aliased organic
   edges are recognized and collapsed to a single boundary (a thin region
   whose color is the mix of its two neighbors is a soft-edge clustering
   artifact, absorbed — while thin dark features like mouth and eye lines
   are colorimetrically distinct and always kept), and every cut must keep
   the majority of each color class on its own side within a bounded
   absolute residue, so small details can never be sacrificed by a
   "cheap" cut.
   Refinement is perceptual-error driven: every straight cut tolerates a
   bounded boundary displacement (~0.6 texel per texel of cut length, half
   that on alpha edges), so smooth curves refine adaptively exactly where
   curvature exceeds the bound — no stair-stepping — while low-detail
   regions stay coarse; minorities count as significant only when their
   excess area × contrast is visible, so isolated noise specks vanish but
   small high-contrast details (eyes, outlines, thin stripes) are always
   resolved. Leaf colors come from the shared region palette, so neighbors
   merge and pair cleanly downstream. Colors are perceptually faithful
   within the color tolerance rather than texel-exact.
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
| Primitives | Triangles / Both (see below) |
| Decimation | Vertex-clustering simplification of the source mesh (UV-preserving) before conversion — for high-poly models. **Preview decimation** shows the simplified mesh in the viewport while adjusting |
| Color tolerance | RGB distance treated as "same color" (merge + subdivision; with smart edges also region clustering) |
| Texture subdivision depth | Max recursion for texture detail (4ⁿ growth); with smart edges it only caps the fallback splitting for non-linear boundaries |
| Smart edge detection (experimental) | Region-based edge detection: traces color boundaries and cuts along smooth, globally consistent lines — cleaner curves and fewer primitives, especially on organic textures |
| Right-angle snap | Near-right triangles become one decoration instead of two |
| Max decorations | Hard cap; smallest triangles dropped first |
| Merge coplanar faces | Toggle the reduction pass |
| Thickness scale | Decoration thin-axis scale |
| Flip Z | Mirror across Z — off by default (the game shares the source Z convention); enable if a model imports front-to-back flipped |
| Euler order | Rotation convention used by the target engine (default YXZ) |
| Alpha cutoff | Texture regions below this alpha generate no geometry (fully transparent pixels are always skipped) |
| Transform | Input unit scale (source units → meters), per-axis Scale (X/Y/Z), Pivot (moved to the origin), and Rotation — applied before conversion as p' = R·s∘(p·unit − pivot). All of it previews live in the viewport, and when no primitives are selected the Move/Rotate/Scale gizmos grab the source model directly (two-way sync with the numeric fields) |
| Collision | Whether exported models collide (object component 5) |

The exported `.gia` uses the game's coordinate system: Y up, +Z forward,
and X mirrored relative to the three.js display convention (the viewport
axes helper and navigation gizmo show the game axes, so the red X arm
points toward the game's +X). The model origin is preserved as-is
(geometry may extend above or below it — nothing is recentered or snapped
to the ground), so in-game placement and orientation relative to the
model's origin match the viewport 1:1. **Reset
Transform** restores pivot, rotation, scale, and input unit scale to their
defaults, and a yellow **1 m reference ruler** at the origin (toggled with
the grid) helps judge scale.

### Conversion modes

- **Direct** — converts mesh faces as-is (Triangles, or Triangles + Squares).
- **Voxel** — rebuilds the model from colored voxels: triangles are rasterized
  into a grid (resolution slider), voxel colors are sampled straight from the
  textures, similar colors merge (Voxel color tolerance), fully enclosed
  voxels are culled automatically. Two surface styles:
  - **Boxes** — greedy-merged cuboids (blocky voxel look).
  - **Marching cubes** — standard marching cubes (classic 256-case tables)
    run directly on the voxel occupancy (inside/outside classified by a
    border flood fill; optional smoothing passes round the surface, the Iso
    offset inflates or erodes it). Face colors interpolate the connected
    voxel colors at each edge crossing, giving smooth color transitions.
    The resulting triangles go through the normal squares/right-triangle
    pipeline.

  The resolution slider defaults to 256 and the numeric box next to it
  accepts any value beyond the slider range. Interior voxels invisible from
  the outside (including sealed cavity walls) are culled by a visibility
  flood fill.
- **Pixel Perfect** — reproduces voxel-style models exactly: each rectangular
  face is mapped onto its texture pixels (nearest texel, no averaging or
  misalignment) and only identical colors (within the Texel merge tolerance,
  default 0) are greedy-merged into squares. **Overdraw layering** (on by
  default, toggleable) gives each opaque face one background square in its
  dominant color and layers only the differing pixel regions above it along
  the face normal — same appearance, significantly fewer decorations.
  All emitted squares are inflated 0.5 mm per side in-plane so adjacent
  squares overlap instead of meeting at hairline seams, and squares on the
  same 3D plane whose inflated footprints overlap are placed on distinct
  depth levels (1 mm apart along the face normal, smallest level first) —
  no seams and no coplanar z-fighting, even between squares emitted by
  different faces of the same flat surface or by double-sided geometry.
### Texture editing

A **Texture** panel appears for textured models (a dropdown selects between
multiple textures). All edits feed the conversion directly:

- **Recoloring** — hue shift, saturation, brightness, contrast, invert.
- **Per-texture settings** — every texture keeps its own configuration;
  selecting another texture restores that texture's settings. With multiple
  textures, **Sync to All Textures** copies the current texture's settings
  to every other one.
- Everything is non-destructive until Reset; adjustments recompute from the
  original pixels so sliders never accumulate loss.

### The editor

The interface is a three-pane editor: import/conversion parameters on the
left (collapsible panels, resizable), the viewport in the middle with a
toolbar and status bar, and the scene/editing panels on the right
(resizable). Generating a reconstruction switches to the Select tool
automatically; while any editing tool is active the left mouse button drives
the tool, the right button orbits, and the middle button pans.

**Viewport toolbar** — tools (Orbit, Select **Q**, Move **W**, Rotate **E**,
Scale **R**, Place **T**; **Space** cycles Move → Rotate → Scale),
World/Local gizmo axes (**X**), grid snapping (hold **Ctrl** to invert
temporarily; snap step configurable), Focus on selection (**F**), and
visibility toggles for the source model, grid (**G**), and axes. A separate
Output group toggles the generated output — all reconstructions in the
scene — on and off (**O**) and picks its draw style (wireframe / solid /
both); the style selector is disabled while the output is hidden.
Individual reconstructions can still be shown/hidden per row in the Scene
panel. The status bar shows live
decoration/selection/model counts, the estimated .gia size, and any
warnings. With no primitives selected, Move/Rotate/Scale manipulate the
source model itself (pivot/rotation/scale, synced with the Transform
panel).

**Navigation gizmo** — the axis ball in the top-right corner mirrors the
camera orientation. Click an axis knob to snap to the standard views
(±X = Right/Left, ±Y = Top/Bottom, −Z = Front / +Z = Back, animated), or drag the
ball to free-orbit. The button underneath toggles between **Perspective**
and **Orthographic** projection; switching keeps the view visually stable,
and every editor feature (picking, marquee, gizmos) works in both
projections.

**Selection** — click (Shift adds, Ctrl toggles), drag a box for marquee
selection, All / None / Invert (**Ctrl+A**, **Alt+A** or **Esc**,
**Ctrl+I**). Box selection is *visible-only* by default: a GPU ID buffer
resolves occlusion pixel-exactly, so hidden primitives are skipped — enable
**Select through** to grab everything in the rectangle. A filter (primitive
type and/or color with tolerance) constrains box selection and powers the
Select / Add / Remove buttons for select-by-type and select-by-color.
Selection is indicated non-destructively: primitives keep their true colors
and get an orange outline (plus a faint x-ray outline where occluded).

**Editing** — Move/Rotate/Scale gizmos work on any selection size (multi-
object transforms pivot on the selection center; world or local axes);
numeric position/rotation/zoom editing (multi-selection edits move the
group); an RGB color picker; Duplicate (**Ctrl+D**, or **Alt-drag** the Move
gizmo to duplicate in place and drag the copy while the originals stay
put — one undo step removes the copies); Copy/Paste
(**Ctrl+C/V**), Delete (**Del**), and full undo/**redo** (**Ctrl+Z** /
**Ctrl+Y** or **Ctrl+Shift+Z**) covering placements, deletions, transforms,
recolors, and optimization passes. The Place tool (contextual toolbar: type,
color, size) drops primitives onto any surface and selects them. **Save
edits as a new model** stores the result as its own reconstruction.

**Statistics panel** — decoration count, distribution across ≤999-decoration
models, per-type counts, unique colors, and the estimated .gia output size
(computed with the real writer), plus warnings when the decoration budget,
the zoom-50 limit, or the per-model split threshold is exceeded.

**Optimize panel** —
- *Merge adjacent primitives*: coalesces same-plane, same-size
  cuboids/planes with matching colors (tolerance slider) into larger ones,
  splitting any merge that would exceed zoom 50;
- *Remove hidden primitives*: renders the reconstruction from 26 viewpoints
  into a GPU ID buffer and deletes primitives visible from none of them;
- *Fix Z-Fighting*: detects coplanar (±0.8 mm) overlapping thin primitives
  and stops the flickering — redundant same-color duplicates (e.g. from
  double-sided sheets) are removed outright, remaining overlaps get a
  minimal 1.2 mm outward offset per layer, iterated to convergence.
  Applies to the selection, or the whole model when nothing is selected;
  volumetric primitives never fight and are skipped;
- *Reduce to target*: escalating-tolerance merging first, then drops the
  smallest primitives until the target count is met.

All edits rebuild previews in place (attribute updates, no geometry
reallocation) so gizmo drags stay smooth on large scenes; reconstructions
render as merged geometry (one draw call each).

When the decoration budget is exceeded, adjacent same-plane squares are
merged with progressively relaxed color tolerance before anything is
dropped; any remaining excess drops the smallest pieces first.

Each Generate hides the previous reconstructions and shows only the new one;
older results stay in the reconstruction list and can be re-enabled for
comparison. Parameters are grouped per mode (Direct presets/color settings no
longer apply to Voxel/Pixel/Fit, which have their own controls).

### Primitive models (from the base .gia files)

| Kind | Model | ID | Canonical (scale 10) |
|---|---|---|---|
| Triangle | Roof Component | 20001925 | 1×1 m legs (+Y / −Z), thin X |
| Square/Box | Cuboid | 10009001 | 1 m cube |
| Plane | Plane | 10009003 | 1×1 m on XZ |
| Sphere | Sphere | 10009002 | 1 m diameter |
| Cylinder | Cylinder | 10009008 | 1 m dia × 1 m h |
| Cone | Cone | 10009009 | 0.5 m radius × 1 m h |
| Prism | Triangular Prism | 10009004 | 1 m tall, 0.75 m side |

No generated decoration ever exceeds a zoom of 50 on any axis — oversized
flat pieces and boxes are split automatically, and curved fits are rejected
above the limit.

### Comparing reconstructions

Every Generate keeps its result as an entry in the reconstruction list with
its own visibility toggle (plus the source-model toggle), so different modes
and settings can be compared side by side; the radio selection picks which
reconstruction feeds the primitive table / .gia download.

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

**Overdraw optimization** (on by default) runs the miliastra-image-to-gia
rectangle optimizer (`engine/convert/rect-optimizer.js`, a faithful port
of that project's `optimizer.ts`): a portfolio of
overdraw strategies — validated pairwise rectangle merging, per-component
underpainting (greedy + beam search), and two-stage merging — produces a
rectangle plan in a validated back-to-front paint order that reproduces
the image pixel-for-pixel with far fewer shapes than an exact partition
(the reference dragon sprite drops from 2672 exact rectangles to 1695).
In 3D the paint order maps to minimal thickness levels: a rectangle
painted over another gets a strictly thicker box (0.5 mm per level per
side — one in-game zoom quantum), so its faces render in front on both
sides. Boxes are never shrunk and interior seams need no inflation —
touching boxes always land on different thickness levels, so the thicker
front face overlaps every shared boundary in depth and the seam renders
watertight. Where different-color walls would share the same grid plane
with a visibly overlapping region (above all overdraw stacks whose boxes
end on the same outline segment: underpaint + foreground rects), each
wall takes a slot and steps outward 1 mm per slot (+0.01 zoom per side)
in PAINT order: a later-painted wall sits strictly outside every earlier
wall it conflicts with, so border primitives slightly overlap outward,
fully cover the shared boundary, and the outermost wall at any point of
the rim is the topmost paint there — it always shows that border pixel's
true color, and an interior-colored box can never poke past the border
boxes painted over it. The earliest wall covering each stretch of
outline keeps the exact grid line wherever paint order allows; the rest
bumps outward by at most a quarter pixel, in the correct color, and the
decoration count always equals the optimizer plan exactly. Conflicts use
exact effective geometry (including the 1 mm corner tips the outsets
themselves create) and only count regions actually exposed to empty
pixels; outsets can never reach an empty pixel's center. Appearance is preserved exactly: at every opaque
pixel, the frontmost box carries that pixel's color. Exact (non-overdraw)
partitions have no overlapping walls and get zero in-plane adjustment.

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
index.html          .gia export page — the main site (thin skeleton)
gia/index.html      primitive-data page (same shell + app, no .gia refs)
css/style.css
js/ui-shell.js      shared UI markup for both pages (toolbar, panels, resize)
js/app.js           shared app logic (initApp), loaders, outputs
js/viewer.js        three.js scene: model, overlays, selection, focus
js/extract.js       three.js → engine mesh data
js/convert-worker.js  conversion Web Worker
js/editor/          interactive editor systems
  editor.js           tools, gizmos, shortcuts, panels (wires the rest)
  picking.js          GPU ID-buffer picking / visibility analysis
  history.js          undo/redo snapshots
  dec-transform.js    decoration <-> display transform math
  stats.js            live statistics + .gia limit warnings
  optimize.js         merge-adjacent / reduce-count tools
engine/             reusable conversion engine (no dependencies)
tools/analyzer.html protobuf analyzer used to reverse-engineer .gia
docs/gia-format.md  format specification
```

## Disclaimer

This is an unofficial, fan-made tool. HoYoverse is not affiliated with it and takes no responsibility for it or for anything created using it. I (the creator) also take no responsibility for any content, builds, or outcomes created with this tool - use it at your own discretion and please follow the game's Terms of Service. Stages containing content that harm the HoYoverse brand may be removed at any time.
