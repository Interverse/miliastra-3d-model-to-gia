# Decoration Reduction Plan

Goal: convert arbitrary meshes — including 1M+ polygon scans and sculpts —
into game assets that use **< 999 decorations ideally, ~1998 on average,
2997 absolute max**, while staying recognizable at gameplay viewing
distances.

> **Budget revision (2026-07-08, user):** target band raised to
> **4995–10000 decorations** (5–10 game models at 999 each). Spend the
> extra budget on visual quality, not just headroom. Testing protocol:
> models are normalized to **2 m height** in the harness (imported models
> at native scale were hitting the zoom≤50 cap and exploding via
> cap-splitting); japanese_bridge_garden is **excluded** from the suite
> until the specular-glossiness loader fix lands (its textures load
> all-white). Historic 999/1998/2997 references below predate this
> revision.

Budget reality check: 999 decorations ≈ 10,000 free parameters (position,
rotation, per-axis zoom, color × 999). That is *tiny* as triangle soup but
*large* as a set of oriented volumetric primitives — a single rotated cuboid
carries 6 faces, a cylinder or sphere carries hundreds of effective faces.
The entire plan follows from one reframing:

> **This is not mesh simplification. It is shape abstraction** — inverse-CSG
> fitting of a compact primitive set to the *visible, colored surface*,
> under a knapsack budget.

The plan is organized in three levels: what everyone does, what the
structure of the problem demands, and the non-obvious leverage points that
decide whether the result looks like an asset or like soup.

---

## Level 1 — The baseline everyone reaches for (and why it fails at 1M)

The obvious pipeline: decimate the mesh → convert triangles → merge coplanar
faces → drop the smallest until under budget. We already do all of this. At
1M polygons it breaks down for four predictable reasons:

1. **Decimation to a triangle budget destroys appearance long before 999.**
   A 999-triangle model of a character is unrecognizable; 999 *volumetric*
   primitives of the same character can look great. Triangles are the
   weakest primitive in the set and must be the *last resort*, not the
   medium.
2. **Color fragments geometry.** Texture detail forces subdivision, so the
   budget is spent on color boundaries, not shape. Geometry and color are
   fighting over the same 999 slots.
3. **"Drop smallest first" is semantically blind.** Small ≠ unimportant: it
   deletes eyes, fingers, antenna tips — precisely the features that carry
   identity — while keeping redundant interior faces.
4. **Everything is exact-partition thinking.** Tiling surfaces exactly
   (no overlaps) is the expensive way to cover a shape. This medium allows
   interpenetration for free.

Level 1 work items (still worth doing, as preprocessing):
- Robust ingestion of 1M+ meshes in the worker: typed-array pipelines,
  spatial hash grids, no per-triangle objects. Target: analysis + reduction
  of 1M triangles in seconds, not minutes.
- Weld + degenerate cull + **visibility cull first** (we already have
  26-view GPU visibility): interior and never-visible geometry is deleted
  before anything else runs. On scans and CSG exports this alone removes
  20–60% of triangles.
- QEM decimation to an *intermediate* working mesh (~30–60k triangles) that
  preserves color-region boundaries and silhouette edges (constraint edges),
  used only as the fitting substrate — never as the output.

---

## Level 2 — What the problem structure demands: a primitive-abstraction pipeline

### 2.1 Color before geometry
Hard constraint driving this whole section: **every decoration carries
exactly one flat color.** A primitive can never span a color boundary, so
color structure dictates the minimum decoration count before any geometry
is considered.

Reduce the palette *first*, in a perceptual space (CIELAB, area-weighted),
to ≤ 24–48 flat colors. Then segment the surface into connected
same-color regions. Every downstream fitting step operates per region, so
**geometry boundaries automatically align with color boundaries** — the
single largest source of wasted primitives disappears. (The in-game result
is flat-colored anyway; killing texture gradients early costs nothing
visually and collapses subdivision pressure.)

Two consequences of the one-color rule that must be explicit in the fitter:

- **Split vs. overlay — price both.** Splitting geometry at every color
  boundary over-fragments when color regions are small relative to the
  shape (a striped pole becomes N stacked cylinders; a wall with a logo
  becomes a mosaic). Since overlap is free (§3.2), the alternative is one
  primitive in the *dominant* color plus thin overlay patches for the
  minority colors — and this works on curved surfaces too (a stripe on a
  pole is a slightly-larger-radius thin cylinder band). For every
  multi-color region cluster, the fitter computes the decoration cost of
  both strategies and takes the cheaper one; neither is universally right.
- **Budget-coupled palette size.** Each palette color buys visual accuracy
  but costs decorations (more regions or more overlay patches). Palette
  size is therefore not a fixed constant: colors enter the same
  marginal-gain knapsack queue as geometry (§2.4), and the palette stops
  growing when the next color's ΔE improvement per decoration falls below
  the current geometric candidates.

### 2.2 Curvature-classed fitting, not one-primitive-fits-all
Classify each region by its curvature signature (local PCA / principal
curvatures on the intermediate mesh):
- **Planar** → greedy maximal-rectangle cover with cuboids/planes
  (extension of the existing coalesce mesher).
- **Single-curved** (κ₁≈0, κ₂>0) → RANSAC cylinder/cone axis fit.
- **Double-curved** (κ₁,κ₂>0) → least-squares sphere/ellipsoid fit
  (per-axis zoom gives us ellipsoids for free).
- **Residual** (fails all fits within tolerance) → calibrated right
  triangles, last.

A cylinder that replaces 400 shaft triangles for 1 decoration is where the
1M→999 compression actually comes from. Most converters never dispatch by
curvature class; they pay triangle prices for curved surfaces.

### 2.3 Volumetric fitting against an SDF, not the triangle list
Build a signed distance field from the visible surface (sparse, adaptive
resolution: fine near thin features, coarse in bulk). Primitives are fitted
and scored against the SDF: a candidate's error is the integral of |SDF|
over its surface, and "inside the model" queries become O(1). This is what
makes greedy volumetric fitting (à la Marching-Primitives / cuboid
abstraction literature) tractable at scale, and it is inherently resolution-
independent — the 1M-triangle input and a 5k-triangle input converge to the
same field.

### 2.4 Budget as a global knapsack
Fit greedily largest-visual-gain-first into a priority queue (submodular
greedy with lazy re-evaluation): every candidate primitive is scored by
**marginal visual error reduction per decoration spent**. Generation stops
at the knee of the error curve or at the tier cap. There is no post-hoc
"drop smallest" — the budget shapes the construction, so a 999 cut is
always a *coherent* model, not a mutilated one.

---

## Level 3 — What most people miss

These are the items that separate "technically under budget" from "looks
like a real asset". Each is cheap relative to its payoff.

### 3.1 Optimize the error the player actually sees
Replace geometric error (Hausdorff/RMS) with a **visibility-weighted,
silhouette-heavy screen-space metric**: render source vs. reconstruction
from the 26 canonical views at gameplay distance, compare silhouette IoU +
per-region ΔE color error. Consequences:
- Interior, under-floor, and occluded surfaces get weight ≈ 0 (they cost
  budget today).
- Silhouette-touching features get weight ≫ volume-proportional — a 2 cm
  antenna outranks a 1 m² hidden wall.
- The metric doubles as the acceptance test (§3.8).

### 3.2 Overlap is free — cover, don't partition
One large base cuboid through the torso + smaller primitives layered on top
beats an exact tiling by 3–10×. Games tolerate interpenetration; where
z-fighting could occur on coplanar faces, offset by 1 mm (the pixel-perfect
mode already proves this "overdraw layering" trick). Switching the planar
coverer from *partition* to *cover with overlaps* is probably the single
biggest budget win on architectural/hard-surface models.

### 3.3 Symmetry and repetition halve (or better) the spend
- **Bilateral symmetry** (most characters, vehicles, furniture): detect via
  PCA + mirrored-ICP; fit one half, mirror the primitive set. ~2× budget.
- **Repeated substructure** (wheels, windows, legs, fence posts): geometric-
  hash clustering of similar regions; fit the archetype once, re-instance
  with per-copy transforms. Railings and stairs collapse from hundreds of
  primitives to dozens.

### 3.4 Thin features are a separate species — extract them first
Voxel/SDF stages silently delete swords, antennas, cables, and cloth (their
volume is ~0). Detect thin sheets and rods up front via local-thickness /
medial-axis analysis, fit them *parametrically* (plane strips, thin
cylinders, triangle fans) at full priority, and exempt them from volumetric
processing and from budget-pressure eviction. Their silhouette contribution
per decoration is the highest in the entire model.

### 3.5 Quantization-aware fitting and ε-inflation
Output values get rounded (positions to 1e-6 ×0.1 m, our calibrated
triangle zooms, game-side snapping). Fit **with quantized parameters inside
the loop** — evaluate the candidate at its rounded pose, not its ideal pose
— and inflate every primitive by ~0.5–1 mm. Hairline cracks between
primitives, not polygon count, are what make converted assets read as
broken. (The triangle-calibration incident — 7.7 vs 100/13 — was exactly
this class of bug; make crack-freedom a fitted property, not an accident.)

### 3.6 The zoom ≤ 50 cap should steer the fitter, not truncate it
Surfaces longer than 5 m must split regardless. Feed the cap into the
rectangle coverer so splits land **on color-region or symmetry boundaries**
and do double duty. Cap-splitting after fitting (what we do today in
`capPlacements`) always costs extra decorations; cap-aware fitting is free.

### 3.7 One run, three tiers — nested LODs
Because construction is greedy by marginal visual gain, emitting primitives
in acquisition order makes **every prefix a valid LOD**: the first ≤999 are
the "ideal" asset, ≤1998 the standard one, ≤2997 the maximum-quality one.
The three targets come from a single pipeline run, and the 999-cut is
guaranteed coherent (torso before buttons, silhouette before interior).
Multi-model partitioning (999/model) groups primitives spatially so each
in-game model is a contiguous chunk, not a random shuffle.

### 3.8 Closed-loop acceptance, not open-loop hope
After generation: render reconstruction vs. source from the 26 views;
compute silhouette IoU and ΔE. If below threshold at 999, automatically
continue to 1998; then 2997; if still failing, *report which regions carry
the error* so the user can spot-fix with the editor instead of regenerating
blind. The pipeline never silently ships a bad asset — the same metric that
guided fitting certifies the output.

---

## Detail preservation & edge cases — three levels

Deep-dive (two independent Opus analyses, synthesized): how the pipeline
handles color edges, facial features like eyebrows, aliased lines — and the
input classes that break the plan entirely.

### Level 1 — Where detail dies by default

All four fine-detail classes are **flat, near-zero-relief surface-color
phenomena**, and a volumetric shape-abstraction pipeline erases them early:

- **Palette reduction kills them first.** Area-weighted Lab clustering
  gives an eyebrow (tiny area, huge identity weight) ~zero weight and
  merges it into skin. AA halo pixels along sharp color edges waste palette
  slots and make segmentation boundaries ragged.
- **The SDF never sees them.** Painted-on features have no geometric
  relief; nothing exists for the volumetric fitter to fit.
- **The knapsack de-prioritizes them.** Silhouette IoU + mean-ΔE scoring is
  structurally blind to *interior painted structure*: deleting an eyebrow
  barely moves the parent's mean color — the damage is structural, not
  chromatic, so the metric can't feel it.
- **Thin strokes are the worst case for rect-cover**: a 1×N-pixel seam
  becomes dozens of tiny cuboids, then gets dropped by area. (The current
  10-point barycentric sampler almost never even lands on a 1 px line.)
- **Entry-point data loss (upstream of the plan!):** `extract.js` reads
  only `mat.color` + `mat.map`. Vertex-color-only models (sculpts, voxel
  exports) arrive monochrome; emissive features (glowing eyes, screens)
  arrive **black**; inward-normal meshes can be deleted whole by a
  backface-culling visibility pass. No fitter can recover data that never
  arrives.

### Level 2 — The mechanisms that save it

1. **A parallel surface-decal track, running on the RAW texture before
   palette reduction** (`engine/convert/texture-analyze.js`), feeding an
   ε-laddered layer stack (`engine/convert/decals.js`) that generalizes the
   proven pixel-perfect overdraw trick: layer 0 = base primitive, +1 mm =
   features/strokes, +2 mm = ink-over-ground (pupil over iris), +3 mm =
   highlights. Position quantum is 0.1 µm, so 1 mm layers never collide.
2. **Halo-clean palette:** build palette centroids from *flat-interior
   texels only* (exclude high-gradient texels, Lab-Sobel ΔE > ~4), then
   assign all texels to that clean palette. Kills spurious halo colors and
   de-jags every hard edge at the source. Cluster in Lab/linear — the
   current gamma-space RGB mean muddies colors.
3. **Vectorize boundaries and strokes — never rasterize them.** Region
   boundary → Douglas-Peucker polyline (ε ≈ 0.75 texel): a straight texture
   edge collapses to one clean primitive edge. Thin strokes: ridge/Hessian
   filter (1–3 px scale) → skeleton → DP polyline → one rotated thin cuboid
   strip per straight run, color sampled *at the skeleton* (recovering the
   true stroke color that AA averaging destroys). 5–50× cheaper than patch
   grids, and continuous instead of stair-stepped. Ring/helix strokes
   around a fitted cylinder become a single larger-radius thin band.
4. **Facial features as protected decals.** Non-ML saliency
   `S = local_contrast × texel_density × symmetry_bonus`: texel density
   (UV Jacobian) is the artist-intent signal — faces get outsized UV area;
   bilateral pairs of small high-contrast blobs on a smooth high-density
   region *is* the face-likelihood proxy. Extract before palette reduction,
   inject feature colors (pupil black, lip red) as protected palette
   entries, emit as decals (mouth = thin strip, eye = flattened ellipsoid,
   pupil = smaller sphere at +1 mm). A whole face ≈ 4–10 decorations. Fit
   one side, mirror the other.
5. **Text/logos as one budgeted object with a fidelity dial** (MSER
   detection, baseline grouping): Tier A ≈ 1–3 decorations (bounding patch
   in ink color — "a mark exists here", never a blank), Tier B = 2–4-color
   maximal-rect cover capped at ~12 rects/layer, Tier C = full stroke
   vectorization. The tiers feed the nested-LOD ordering naturally.
6. **Robust foundations (fix before Level-2 stages run):** scale-relative
   welding (weldEps as fraction of bbox, not fixed 1e-4 m); connected-
   component splitting for scene-as-one-mesh inputs; **unsigned** distance
   field with inside/outside from the visibility pass or winding numbers
   (the culled surface is open — a signed SDF's sign is undefined);
   **global** palette across material silos; double-sided visibility
   rendering with majority-inward-normal flip; read vertex colors and fold
   emissive into base color in `extract.js`.

### Level 3 — What even the fixes miss

1. **The knapsack is the true bottleneck, not extraction.** Every rescued
   feature is re-dropped at budget time unless the error metric gains a
   structural term: `E = w_sil·(1−IoU) + w_mean·ΔE + w_struct·ΔE_edges`
   (edge-filtered 26-view comparison), plus never-evict flags and a
   saliency multiplier (~×20–50) for identity features. Fix the metric
   first; validate on doll face.fbx before trusting anything else.
2. **Perceptual asymmetry — thicken, don't drop.** A mouth line thickened
   to the 1 mm zoom floor is a caricature; a missing one destroys identity.
   Sub-floor features clamp *up*; only genuinely sub-perceptual detail (at
   gameplay viewing distance) is dropped. Guard against adjacent thickened
   features visually merging.
3. **Noise must collapse, not fragment.** Grass/gravel/camo textures defeat
   region segmentation (thousands of speckles → budget blowout). Add an
   entropy/spatial-frequency gate that collapses structureless variance to
   its area mean *before* segmentation, and a minimum-region-area merge.
4. **Baked lighting: keep by default (WYSIWYG), de-light as opt-in.**
   Industry PBR pipelines de-light scans because assets must relight under
   arbitrary engine lighting — that rationale does not apply to a
   flat-color medium whose contract is "match the viewport". The texture
   as displayed (baked shading included) is what gets sampled. A
   luminance-band de-light remains available as an opt-in Texture-panel
   tool for users who want game-light-neutral colors; the entropy gate
   (item 3) still applies to *structureless* shading noise either way.
5. **Unrepresentable-class guard.** Alpha-cutout foliage/hair/fences,
   semi-transparency, billboards, and thin-only models (chain-link fence)
   have a *structural* error floor: auto-escalation would burn to 2997 and
   still "fail". Detect these classes up front (bimodal alpha, flat-card
   geometry, all-thin medial analysis), collapse to coarse opaque proxies,
   skip tier escalation when Δerror/tier is below threshold, and use
   per-class acceptance thresholds (organic ≠ hard-surface).
6. **Dynamic-range ceiling.** zoom ∈ [0.01, 50] means a ~5000:1 ratio
   between the largest span and the smallest representable feature.
   Models exceeding it (sub-mm gem facets on a building) cannot be faithful
   at both scales — warn and let the user pick the scale anchor.
7. **Decal integrity details:** decals must carry a host-primitive
   dependency in the greedy queue (no orphaned floating eyebrows when the
   host is evicted); constant-normal offsets drift on tight curvature
   (use cylinder bands or tessellated strips there); features split across
   UV islands must be re-joined by 3D-surface proximity, not UV proximity;
   symmetry mirroring needs a per-side residual pass so one-sided details
   (scar, logo, holster) aren't erased or duplicated.

### Policy decisions — governed by one principle

**WYSIWYG: the exported asset must match what the viewport shows.** The
viewport preview is the single source of truth; the converter consumes
exactly the geometry and colors being rendered. (Preview/output identity is
already verified to 0.0000 for transforms — these decisions extend the same
contract to color, pose, scale, and unrepresentable materials.)

- **De-lighting: OFF by default.** The viewport displays the texture with
  its baked shading, so conversion samples it as-is. Industry de-lighting
  practice (Unity photogrammetry workflow, Agisoft De-Lighter) exists to
  make assets relightable under arbitrary PBR lighting — irrelevant to a
  flat-color medium. Offered later as an opt-in Texture-panel tool.
- **Pose: convert the displayed pose.** For skinned meshes, extract bakes
  the rendered vertex positions (`SkinnedMesh.boneTransform`) instead of
  raw bind-pose attributes, so a model shown posed converts posed. Rule:
  extraction reads what the renderer draws, never the raw file. (P1 item —
  today skinned meshes extract bind-pose while potentially displaying
  otherwise, a WYSIWYG violation.)
- **Unit-less inputs: no auto-rescale guessing.** Importers that guess
  units cause the classic 100× FBX cm/m errors; there is no universal
  convention. The loaders apply whatever unit metadata the file carries,
  the 1 m ruler and Input-unit-scale control make the displayed size
  explicit, and the size the user sees against the ruler is the size
  exported. The 5000:1 dynamic-range check WARNS (never blocks), alongside
  a sanity hint when the model is absurdly small/large vs the ruler.
- **Foliage/hair/glass: reproduce the viewport appearance, judged
  per-class.** Alpha-cutout converts what the viewport shows (alpha ≥
  cutoff = solid), with distant-canopy clustering into opaque proxies —
  from gameplay distance foliage reads as opaque mass (the alpha-to-
  coverage literature's observation), which is also what the flat-color
  medium can honestly deliver. Semi-transparency flattens to its displayed
  blended color. These classes get their own acceptance thresholds and
  never trigger tier auto-escalation past a structural error floor.

## Pipeline summary

```
0. ANALYZE    stats, symmetry, repetition, thin features, curvature classes,
              color complexity → per-model strategy dispatch
1. REDUCE     26-view visibility cull → interior removal → Lab palette
              reduction (≤24–48 colors) → constrained QEM to ~30–60k
              working mesh (color/silhouette edges locked)
2. EXTRACT    thin sheets/rods → parametric primitives (protected)
3. FIT        sparse SDF → per color×curvature region: rect-cover with
              overlaps (cap-aware) / RANSAC cylinder-cone / LSQ ellipsoid /
              residual triangles — all candidates into one global
              marginal-gain priority queue
4. OPTIMIZE   symmetry mirroring + instancing, local search (merge/split/
              recolor swaps), quantization-aware snap + ε-inflation
5. EMIT       greedy acquisition order = nested 999/1998/2997 LODs,
              spatially-grouped 999-per-model partition
6. VERIFY     26-view silhouette IoU + ΔE acceptance; auto-escalate tier;
              per-region error report on failure
```

## Phase 1 status — SHIPPED, but VISUAL QUALITY REJECTED (diagnosed — see Phase 1.5)

> **User verdict (2026-07-08):** decoration counts hit the targets, but the
> visual results "look awful". Diagnosis completed 2026-07-08 via two
> independent deep-reasoner analyses (forensic code audit + design-first
> review), synthesized in **Phase 1.5** below: root cause, revised fix
> order, and the quantitative similarity test suite spec. Reference
> models: shiba, matilda, stylized_sword, just_a_girl,
> japanese_bridge_garden, shattered_crystal_sword (+ amber, higokumaru,
> stylized_emerald_sword — over the 10 MB harness limit, test in-app).

## Phase 1 implementation record — "Hyper Optimized" mode

Implemented (engine/convert/preprocess.js + converter.js `mode:'hyper'`,
gated behind the new Mode selector entry): voxel-flood interior culling,
connected-component stats, CIELAB area-weighted palette reduction with
adaptive tolerance, neighbor-majority palette smoothing (kills the
gradient-patchwork that otherwise blocks merging), budget-realistic
working-mesh reduction (extended coarse ladder), palette-exact merging with
generous snap/planar tolerances through the shared direct tail. WYSIWYG
extract fixes shipped globally: vertex colors (+ subdivision on their
gradients), emissive fold-in, posed-skin baking via boneTransform.

Measured on the reference suite (models normalized to game scale;
Direct at defaults vs Hyper Optimized at defaults):

| Model | Source tris | Direct | Hyper | Reduction |
|---|---|---|---|---|
| matilda.glb | 56,822 | 99,900 (capped) | **733** | >136× |
| stylized_sword.glb | 2,864 | 49,235 | **1,122** | 44× |
| shiba.glb | 4,316 | 19,910 | **1,143** | 17× |
| just_a_girl.glb | 77,725 | 99,900 (capped) | **1,501** | >66× |
| japanese_bridge_garden.glb | 21,883 | 37,570 | **1,632** | 23× |
| shattered_crystal_sword.glb | 2,219 | 69,330 | **1,861** | 37× |

All six land inside the target band (<999 ideal / 1998 avg / 2997 max):
median 1,388, mean 1,332, max 1,861. **Correction (2026-07-08, found by the
harness):** this table reports *pre-cap-split* counts (`stats.afterMerge`).
At default `unitScale=1`, matilda (~186 m) and just_a_girl (~145 m) trigger
massive zoom≤50 cap-splitting — their true default-settings totals are
**3,256** and **13,527** decorations, i.e. over cap. See the Phase 1.5
baseline table. Visual checks (shiba, matilda):
silhouette, proportions, and key colors preserved; output is intentionally
faceted. Tuning constants: leaf target = 0.45 × goal (measured ~2.2×
decomposition expansion), goal 2400 default or Max Decorations when
lowered, hyper snap 6°, planar 6°, palette ≤ hyperColors (default 32,
UI slider 4–64).

Known Phase-1 limits (addressed by later phases): no curved-primitive
fitting yet (spheres/cylinders would halve organic counts), no marginal-
gain knapsack, no decal/detail track — small high-contrast features
(collar edges) can blotch at coarse reduction levels.

## Phase 1.5 — Visual-quality revision (2026-07-08)

Synthesis of two independent deep-reasoner analyses (a forensic code audit
and a design-first review). Both converge: the plan is not wrong — Phase 1
shipped a shortcut that deviates from the plan's own P1 spec, and the
deviation is the damage.

### Root cause

**Cumulative uniform vertex-clustering used as the output.**
`reduceLeaves`/`clusterAt` (engine/convert/preprocess.js) snap every vertex
to a global 8–24-cell bbox grid, repeatedly re-clustering already-clustered
output, and the result is emitted nearly 1:1 as paper-thin flat triangles.
This is the crudest decimator in the literature: it averages surfaces
toward the interior ("melted"), welds limbs and separate objects that share
a cell, erodes protrusions, and manufactures slivers, holes, and
T-junctions ("shattered"). P1 specified **constrained QEM to a working
substrate — never the output**; grid clustering was substituted and the
error-metric harness was skipped. On organic output the 6° merge tail
barely fires (no coplanar neighbors), so no abstraction happens at all —
just a melted low-poly shell.

### Amplifiers (ranked)

1. **Over-decimation below available budget** — `hyperReduce` targets
   0.45 × 2400 leaves regardless of tier headroom; matilda lands at 733
   decorations with 2997 available. Silhouette resolution the budget
   already paid for is thrown away. Cheapest fix, immediately visible.
2. **Palette smoothing erases identity features** — 2-pass
   neighbor-majority flip (bestN ≥ 2) on the ~1k-triangle coarse mesh
   outvotes any 1–3-triangle eye/mouth/marking; the area-weighted palette
   build can also merge small high-identity colors before they ever get a
   slot.
3. **Sliver-soup on hard surfaces** — subdivideForColor + gradient
   patchwork + clustering on thin near-planar geometry: the swords spend
   1,122–1,861 decorations to look worse than ~100–250 crisp quads would.
4. **No component splitting** — the 95-object bridge garden welds across
   objects sharing a grid cell (railing posts fuse, lanterns sink into the
   deck).
5. **Hairline seams / z-fighting** — clustering T-junctions + paper-thin
   plates; the §3.5 ε-inflation was never implemented.

GLB survey facts: none of the nine reference models use vertex colors
(the Phase-1 vertex-color path is idle on this suite); higokumaru is
emissive-only (verify extract fold-in actually lands its colors, else it
converts near-black); amber is 1.0M tris / 32 materials; all three swords
are extremely thin on one axis.

### Revised fix order (all at equal decoration counts)

1. **Measurement harness first** (spec below). Every later step is judged
   by FaithScore, not eyeballing. Baseline current hyper output on the six
   in-harness models.
2. **Cheap interims in the existing pipeline:**
   - Budget-feedback leaf target: target ≈ tierCap / measured expansion,
     re-run reduction when the final count lands far under tier (adaptive
     per model; watch the swords, already near cap, and the blind
     drop-smallest fallback in `finishPlacements`).
   - Non-cumulative decimation: one clustering pass on the *original*
     leaves at a binary-searched resolution — never re-cluster output,
     never sub-16 grids.
   - Feature-protective palette smoothing: skip flips for high-ΔE leaves
     (real feature edges), require bestN ≥ 3 and >60% of neighbors, one
     pass only; reserve palette slots for locally high-contrast small-area
     colors before the area-weighted merge.
   - ε-inflation ~0.5–1 mm on every emitted plate + lift the thin axis off
     the paper-thin floor (kills z-fighting shimmer and T-junction cracks).
3. **Finish P1 as written:** constrained QEM edge-collapse (lock
   color-boundary edges + open/high-dihedral silhouette edges) producing a
   fitting substrate, and connected-component splitting before reduction.
   These must land together — QEM on welded components inherits the weld.
4. **Re-ranked build order after that** (visual-gain-per-effort):
   P2 planar rect-cover-with-overlaps first (fixes swords + scene, frees
   budget) → thin-feature extraction pulled ahead of P3 (railings, blade
   edges) → P3 curvature fitting (what makes organics genuinely round) →
   decal/saliency track (only after the metric gains the structural edge
   term, else decals get re-dropped) → remainder of P5.

### Similarity test suite (spec)

Files: `test/similarity-harness.html` + `test/metrics.js` +
`test/views26.js`, models in `test/models/` (the six ≤ 10 MB GLBs).
Reuses `VIEW_DIRS` + offscreen render-target reads (js/editor/picking.js)
and `buildPreview` (js/preview-mesh.js); conversion goes through the real
extract → convert path with the app's own normalization so framing matches
the app.

- **Silhouette IoU:** 26 orthographic views, *identical camera* for source
  and reconstruction (union bbox + 5% margin), 512², white-on-black binary
  masks. Report meanIoU + minIoU (worst view catches a catastrophic
  direction).
- **Color ΔE:** 6 face views, viewport materials/lighting (WYSIWYG),
  CIEDE2000 over pixels foreground in *both* masks (XOR pixels are IoU's
  job — keep the axes separate).
- **Structural edge term** (added with the decal phase): ΔE on
  Sobel-edge-filtered renders — the only metric that feels a missing
  eyebrow. Report, don't gate initially.
- **Headline:** `FaithScore = 100·(0.6·meanIoU + 0.4·max(0, 1−meanΔE/20))`
  per model, printed beside raw meanIoU / minIoU / meanΔE and PASS/FAIL,
  plus a gameplay-distance perspective thumbnail pair (source vs
  converted) for human diagnosis of *why* a score is low.
- **Run modes:** one-click Run All (models lazy-loaded one at a time);
  `?auto=1` auto-runs, sets `window.__RESULTS__`, offers JSON download for
  regression diffing. Over-limit models (amber, higokumaru,
  stylized_emerald_sword): an in-app "Score current model" action runs the
  same metrics module on the loaded source vs its converted output.
- **Initial per-class thresholds** (looser than the eventual 0.92 / 6
  targets):

| Class | meanIoU | meanΔE | FaithScore |
|---|---|---|---|
| Organic (shiba, matilda, just_a_girl, amber, higokumaru) | ≥ 0.90 | ≤ 8 | ≥ 82 |
| Hard-surface (3 swords) | ≥ 0.93 | ≤ 10 | ≥ 85 |
| Scene (japanese_bridge_garden) | ≥ 0.85 | ≤ 8 | ≥ 78 |

Caveats: confirm whether in-game decorations are lit (changes whether
faceting is even a defect and how the ΔE pass must render); verify
source/converted origin alignment once with a 1-view overlay before
trusting IoU; ΔE76 (palette build) vs ΔE2000 (harness) differ
intentionally — the palette optimizes construction, the harness judges
perception.

### Harness SHIPPED + baseline (2026-07-08)

Implemented as specced: `test/similarity-harness.html` + `test/metrics.js`
+ `test/views26.js` + `test/models/` (six GLBs, 0.7–4.75 MB each), plus an
in-app "Score current model" button (`js/score-current.js`, wired into
ui-shell/app, i18n keys in all 15 locales) for the over-limit models. The
in-app path reproduces the standalone harness numbers exactly (shiba:
identical FaithScore to 3 significant figures on both paths). Alignment
overlay confirms source/reconstruction framing matches. meanΔE is the
arithmetic mean of the 6 per-view means.

Baseline, `mode:'hyper'` at defaults — the "looks awful" verdict,
quantified:

| Model | Class | FaithScore | meanIoU | minIoU | meanΔE | Decorations | Result |
|---|---|---|---|---|---|---|---|
| shiba | organic | 83.2 | 0.933 | 0.919 | 6.38 | 1,143 | **PASS** |
| matilda | organic | 65.7 | 0.670 | 0.614 | 7.28 | 3,256 | FAIL |
| just_a_girl | organic | 61.5 | 0.832 | 0.677 | 14.20 | 13,527 | FAIL |
| stylized_sword | hard-surface | 37.4 | 0.623 | 0.343 | 27.57 | 1,121 | FAIL |
| shattered_crystal_sword | hard-surface | 41.0 | 0.596 | 0.545 | 17.40 | 1,861 | FAIL |
| japanese_bridge_garden | scene | 46.0 | 0.767 | 0.446 | 66.29 | 1,632 | FAIL |

### Iteration log

**Round 1 (2026-07-08) — the four cheap interims, at the revised
4995–10000 budget, 2 m harness normalization, bridge garden skipped.**
Shipped: budget-feedback leaf target (expansion divisor measured at 1.7×,
not the assumed 2.2×; feedback aims at the upper quarter of the band, max
3 attempts), single-pass binary-searched clustering (grid floor 16),
feature-protective palette smoothing (bestN ≥ 3 AND >60%, ΔE>12 edge
guard, 1 pass), ε-inflation 0.75 mm (hyper-gated; direct mode verified
byte-identical thin axis). Scores (control at new settings → after fixes):

| Model | FaithScore | meanIoU | meanΔE | Decorations | Result |
|---|---|---|---|---|---|
| shiba | 92.98 → **94.61** | 0.992 → 0.997 | 3.27 → 2.61 | 9,408 | PASS |
| matilda | 87.18 → **89.14** | 0.932 → 0.957 | 4.38 → 4.12 | 9,787 | PASS |
| just_a_girl | 66.33 → **71.22** | 0.891 → 0.936 | 13.57 → 12.48 | 9,674 | FAIL (ΔE) |
| stylized_sword | 56.13 → **58.02** | 0.935 → 0.967 | 25.73 → 25.82 | 9,104 | FAIL (ΔE) |
| shattered_crystal_sword | 50.49 → **55.22** | 0.798 → 0.832 | 18.71 → 17.35 | 9,806 | FAIL (IoU+ΔE) |

Remaining-failure hypotheses feeding round 2: (a) sword ΔE is likely a
**harness lighting mismatch** — source rendered lit, reconstruction
rendered unlit MeshBasicMaterial; fix measurement parity before trusting
sword ΔE. (b) crystal-sword IoU needs component splitting + better
decimation (43 shards fusing). (c) just_a_girl ΔE is fine-detail color
loss; palette only uses 17/32 slots by default but 36/64 when allowed —
budget-coupled palette expansion is the cheap lever, decal track the real
one.

**Round 2 (2026-07-08) — lighting parity + constrained QEM/component
splitting.** Two parallel tracks:

- *Harness ΔE parity:* the app's viewer renders reconstructions unlit by
  design (raw .gia colors, no normals emitted by buildPreview), so the
  harness now renders **both** sides unlit. Organic ΔE moved 0.00 (never
  contaminated); stylized_sword ΔE 25.8 → 9.3 (was measuring specular
  highlights, i.e. artifact); shattered_crystal_sword unchanged (real
  conversion error: crystal shading washed to flat magenta + thin tendrils
  lost).
- *Pipeline:* new `engine/convert/qem.js` — constrained QEM edge-collapse
  (area-weighted quadrics; boundary/seam/crease **penalty** quadrics at
  120·faceArea — hard locks floored the swords; palette index rides
  through collapses; subset placement picks the cheapest *valid* of
  {u,v,mid} — picking cheapest-then-rejecting floored thin geometry).
  Scale-relative weld (2e-5·bbox) + union-find component split with
  area-proportional budgets (≤12-face passthrough, debris guard @4000
  components) — shard fusion eliminated. Palette default now
  budget-coupled 32→48. Feedback loop measures **pre-clamp** counts and
  retries on drops (was accepting 50%-dropped results as in-band).

| Model | meanIoU | meanΔE | Decorations | Per-metric result |
|---|---|---|---|---|
| shiba | 0.993 | 2.47 | 9,182 | PASS |
| matilda | 0.971 | 3.44 | 10,000 | PASS (but drop-clamps ~1,900) |
| just_a_girl | 0.924 | 11.55 | 7,918 | FAIL (ΔE ≤8; underspends) |
| stylized_sword | 0.971 | 9.53 | 8,476 | PASS |
| shattered_crystal_sword | 0.846 | 16.89 | 8,805 | FAIL (IoU ≥0.93, ΔE ≤10) |

Gate correction: the FaithScore pass bars are stricter than the per-metric
bars combined (IoU 0.93 + ΔE 10 can only yield FS ≈ 76 < 85), so
**per-metric thresholds are the pass/fail gate from round 3 on**;
FaithScore stays as the headline trend number. Round-3 levers identified:
low-poly-source bypass (shattered's source is only 2,219 tris — don't
round-trip crisp shards through subdivide→QEM for shape; subdivide for
color only), thin-feature extraction (§3.4: tendrils, ribbons), firmer
band targeting, matilda drop-clamp diagnosis. Also noted: harness ES-module
cache-busting requires full page navigation, `?v=` misses transitive deps.

Two pipeline bugs found while wiring the harness (not yet fixed):

1. **Phase-1 counts were pre-cap-split.** matilda / just_a_girl read as
   ~186 m / ~145 m at default unitScale, so zoom≤50 cap-splitting adds
   2,523 / 12,026 decorations after the merge stats were recorded. The
   real default totals (3,256 / 13,527) blow the 2,997 cap. Cap-aware
   fitting (§3.6) and/or scale sanity handling just moved up in priority.
2. **japanese_bridge_garden loads all-white**: its colors live in the
   legacy `KHR_materials_pbrSpecularGlossiness` glTF extension, which
   GLTFLoader doesn't handle and the model carries no fallback
   baseColor — all 95 materials arrive as [1,1,1]. Explains its ΔE of
   66.3; needs a specular-glossiness fallback in the loader path (this is
   a WYSIWYG entry-point data-loss bug of the same class as the
   vertex-color/emissive fixes).

## Implementation phases

| Phase | Scope | Builds on |
|---|---|---|
| P1 | **extract.js fixes (vertex colors, emissive fold-in, double-sided cull)**; scale-relative welding + component splitting; visibility cull + halo-clean Lab palette (global, entropy-gated) + constrained QEM; error-metric harness (26-view IoU/ΔE **+ structural edge term**) | IdPicker, texture tools |
| P2 | Sparse **unsigned** SDF (sign from visibility/winding) + planar region cover **with overlaps** + cap-aware splitting | voxelize.js, coalesce.js, capPlacements |
| P3 | Curvature classing (on smoothed working mesh) + cylinder/cone/ellipsoid RANSAC fitters; residual triangles; global marginal-gain queue with saliency multipliers + never-evict flags | right-triangles.js, fit.js |
| P4 | Thin-feature extraction; **texture-analyze.js (saliency, ridge/stroke vectorization, MSER text) + decals.js (ε-ladder layer stacks, host dependencies)**; symmetry + instancing with per-side residual pass | pixelperfect.js overdraw |
| P5 | Quantization-aware snapping + ε-inflation; nested-LOD emission; closed-loop acceptance with **per-class thresholds + unrepresentable-class guard** | gia-writer, stats |

Regression targets: doll face.fbx, matilda.glb, shiba.glb, creeper.glb, a
1M+ scan (to be added). Success criteria per model: median tier ≤ 999
decorations at silhouette IoU ≥ 0.92 and mean ΔE ≤ 6 from the 26 views;
mean across the suite ≤ 1998; hard stop 2997 with the error report.

## Performance notes (1M+ inputs in the browser)

- Everything in the worker on typed arrays; uniform-grid spatial hashing;
  no per-triangle allocation. Visibility cull and SDF sampling are the only
  O(input) passes — after Stage 1, cost depends on the ~50k working mesh,
  not the input size.
- SDF is sparse (narrow band + coarse interior), built from the working
  mesh, refined near thin features only.
- RANSAC iterations bounded per region; global queue uses lazy re-scoring.
- Budget: ≤ 30 s wall-clock for 1M triangles on a mid-range machine, with
  progress reporting per stage.
