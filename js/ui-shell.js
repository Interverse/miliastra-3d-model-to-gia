// Shared UI shell for both pages (single source of truth for the markup).
//
//   renderShell(rootElement, { primitives, primitivesHref, docsHref })
//
// primitives: false (the MAIN page) — .gia download button, collision +
//   auto-assemble toggles, and format documentation links.
// primitives: true (the /gia page) — outputs only primitive data in a popup
//   table; contains no .gia references.
// primitivesHref / docsHref: footer link targets, relative to the page.
//
// Layout (professional-editor style):
//   [left sidebar: import + conversion]  [viewport + toolbar + status bar]
//   [right sidebar: scene / selection / statistics / optimization]
// Both sidebars are resizable (drag the inner edge) and every panel is
// collapsible.

export function renderShell(root, {
  primitives = true,
  primitivesHref = 'gia/index.html',
  docsHref = 'docs/gia-format.md',
} = {}) {
  root.innerHTML = `
<div id="app">
  <aside id="sidebar">
    <h1>${primitives ? "3D → Primitives" : '3D → GIA <span class="badge">.gia export</span>'}</h1>
    <div class="sidebar-scroll">

    <details class="panel" open>
      <summary>1. Model</summary>
      <label class="filedrop" id="filedrop">
        <input type="file" id="file-input" multiple
          accept=".fbx,.obj,.glb,.gltf,.stl,.mtl,.png,.jpg,.jpeg,.webp,.bmp,.gif,.tga">
        <span>Drop .fbx / .obj / .glb / .stl here<br>or click to browse</span>
        <span class="hint">Textures (.png .jpg .webp .tga …) and .mtl can be added in the
          same selection or uploaded separately at any time — the model reloads
          automatically.<br>
          A standalone image (no model) can also be converted into an extruded
          3D sprite — upload it alone and click “Use image as 3D sprite”.</span>
      </label>
      <div id="model-info" class="stat-grid"></div>
      <div id="texture-list"></div>
      <button id="btn-sprite" hidden>Use image as 3D sprite</button>
      <div id="sprite-params" hidden>
        <label class="row" title="Extrusion depth of the generated 3D sprite, in meters — how deep the sprite volume is from front to back">
          <span>Sprite thickness (m)</span>
          <input type="number" id="p-sprite-thick" value="0.1" min="0.001" max="10" step="0.05">
        </label>
        <label class="row" title="World size of one sprite pixel, in meters — a 16-pixel-wide image at 0.05 becomes 0.8 m wide">
          <span>Pixel size (m/px)</span>
          <input type="number" id="p-sprite-px" value="0.05" min="0.001" max="1" step="0.01">
        </label>
      </div>
      <button id="btn-clear" class="secondary"
        title="Remove the loaded model, all uploaded images/textures, and materials, and reset the viewport">↻ Clear model &amp; textures</button>
    </details>

    <details class="panel" open>
      <summary>2. Transform</summary>
      <label class="row" title="Multiplier from the model's units to meters — e.g. use 0.01 for a model authored in centimeters (common for FBX)">
        <span>Input unit scale</span>
        <input type="number" id="p-unit" value="1" min="0.0001" step="0.1">
      </label>
      <label class="row" title="Uniform scale applied to the model (after unit scaling) — previewed live and baked into the generated output">
        <span>Scale</span>
        <input type="number" id="t-scale" value="1" min="0.0001" step="0.1">
      </label>
      <div class="row-triple" title="Point in the model (meters, X/Y/Z) that is moved to the origin before conversion — use it to reposition the pivot">
        <span>Pivot (m)</span>
        <input type="number" id="t-px" value="0" step="0.1" title="Pivot X (m)">
        <input type="number" id="t-py" value="0" step="0.1" title="Pivot Y (m)">
        <input type="number" id="t-pz" value="0" step="0.1" title="Pivot Z (m)">
      </div>
      <div class="row-triple" title="Rotation in degrees (X/Y/Z, applied in YXZ order) around the pivot before conversion — previewed live in the viewport">
        <span>Rotation (°)</span>
        <input type="number" id="t-rx" value="0" step="15" title="Rotation around X (°)">
        <input type="number" id="t-ry" value="0" step="15" title="Rotation around Y (°)">
        <input type="number" id="t-rz" value="0" step="15" title="Rotation around Z (°)">
      </div>
      <button id="t-reset" class="secondary"
        title="Restore pivot, rotation, scale, and input unit scale to their defaults">↺ Reset Transform</button>
      <div class="hint2">Pivot moves to the origin; scale and rotation apply around it. The
        viewport updates live — or grab the model with the Move / Rotate / Scale
        gizmos when nothing is selected.</div>
    </details>

    <details class="panel" open>
      <summary>3. Parameters</summary>

      <div class="hint2" id="sprite-param-note" hidden>3D sprite mode — only the
        settings that affect the sprite output are shown.</div>

      <label class="row" id="row-decimate" title="Simplifies the source mesh before conversion by snapping vertices to a grid — use on high-poly models to cut primitive count and speed things up. 0 = off, higher = coarser">
        <span>Decimation <em id="v-decimate">off</em></span>
        <input type="range" id="p-decimate" min="0" max="90" value="0" step="5">
      </label>

      <label class="row" id="row-prevdec" title="Show the decimated mesh in the viewport while adjusting the slider (the original model is restored when disabled)">
        <span>Preview decimation</span>
        <input type="checkbox" id="p-prevdec">
      </label>

      <label class="row" title="Hard cap on generated primitives — the smallest ones are dropped first when exceeded. Output is split into models of at most 999 each">
        <span>Max decorations <em id="v-max">4995</em></span>
        <input type="number" id="p-max" value="4995" min="1" max="99900" step="1">
      </label>

      <label class="row" id="row-mode" title="Reconstruction mode: Direct converts mesh faces as-is; Voxel rebuilds from colored voxels (boxes or a marching-cubes surface); Pixel Perfect reproduces voxel-style models exactly, per texture pixel">
        <span>Mode</span>
        <select id="p-mode">
          <option value="direct" selected>Direct</option>
          <option value="voxel">Voxel</option>
          <option value="pixel">Pixel Perfect</option>
        </select>
      </label>

      <div id="direct-params" class="mode-group">
        <label class="row" title="Quick bundles of the Direct-mode settings: Visual fidelity keeps more color detail and primitives; Minimal trades detail for the lowest primitive count; Balanced sits in between">
          <span>Priority preset</span>
          <select id="p-preset">
            <option value="balanced" selected>Balanced</option>
            <option value="fidelity">Visual fidelity</option>
            <option value="minimal">Minimal triangles</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label class="row" title="Which primitive shapes to generate: Triangles only, or Triangles + Squares (squares are used wherever they fit exactly — no holes, no fidelity loss)">
          <span>Primitives</span>
          <select id="p-prim">
            <option value="triangles" selected>Triangles</option>
            <option value="both">Triangles + Squares</option>
          </select>
        </label>
        <label class="row" title="How different two colors may be (RGB distance, 0–441) while still being treated as the same color when merging faces and deciding texture subdivision — higher = fewer primitives, flatter colors">
          <span>Color tolerance <em id="v-tol">30</em></span>
          <input type="range" id="p-tol" min="0" max="150" value="30" step="1">
        </label>
        <label class="row" title="How many times a triangle may be split (into 4 each level) to capture texture detail — higher captures finer texture patterns but multiplies primitive count">
          <span>Texture subdivision depth <em id="v-subdiv">3</em></span>
          <input type="range" id="p-subdiv" min="0" max="5" value="3" step="1">
        </label>
        <label class="row" title="Triangles whose largest angle is within this many degrees of 90° are treated as right triangles and need only one primitive instead of two (slightly distorts their shape)">
          <span>Right-angle snap (°) <em id="v-snap">1</em></span>
          <input type="range" id="p-snap" min="0" max="15" value="1" step="0.5">
        </label>
        <label class="row" title="Dissolves adjacent flat faces with similar colors and rebuilds them with fewer, larger primitives — the main primitive-count reducer for flat surfaces">
          <span>Merge coplanar faces</span>
          <input type="checkbox" id="p-merge" checked>
        </label>
        <label class="row" title="How far two face normals may deviate (in degrees) while still counting as coplanar for merging — raise it to flatten gently curved surfaces">
          <span>Coplanar angle (°)</span>
          <input type="number" id="p-planar" value="1" min="0" max="30" step="0.25">
        </label>
      </div>

      <div id="voxel-params" class="mode-group" hidden>
        <div class="row" title="Voxel grid resolution across the model's largest dimension — higher reproduces finer detail but multiplies decoration count. Type any value in the box to exceed the slider range">
          <span>Voxel resolution</span>
          <input type="range" id="p-voxres" min="8" max="256" value="256" step="8">
          <input type="number" id="p-voxres-n" value="256" min="2" step="1">
        </div>
        <label class="row" title="Boxes keeps the blocky voxel look; Marching cubes reconstructs a smooth surface from the voxels (output uses squares and right triangles)">
          <span>Surface</span>
          <select id="p-voxsurf">
            <option value="boxes" selected>Boxes (blocky)</option>
            <option value="mc">Marching cubes (smooth)</option>
          </select>
        </label>
        <label class="row" title="How similar voxel colors (sampled from the textures) must be to merge into larger boxes — higher = fewer decorations, flatter colors">
          <span>Voxel color tolerance <em id="v-voxtol">20</em></span>
          <input type="range" id="p-voxtol" min="0" max="150" value="20" step="1">
        </label>
        <div id="sdf-params" hidden>
          <label class="row" title="Shifts the reconstructed surface: positive inflates the model outward, negative erodes it inward (in voxel units)">
            <span>Iso offset <em id="v-sdfiso">0</em></span>
            <input type="range" id="p-sdfiso" min="-2" max="2" value="0" step="0.25">
          </label>
          <label class="row" title="Smoothing passes over the voxel field — more passes give a softer, rounder surface">
            <span>Surface smoothing <em id="v-sdfsmooth">1</em></span>
            <input type="range" id="p-sdfsmooth" min="0" max="4" value="1" step="1">
          </label>
        </div>
        <div class="hint2">Fully enclosed voxels are culled automatically.</div>
      </div>

      <div id="pixel-params" class="mode-group" hidden>
        <label class="row" title="How different two texture pixels may be and still merge into one square — 0 (default) combines only exactly equal colors, keeping the model pixel-perfect">
          <span>Texel merge tolerance <em id="v-pxtol">0</em></span>
          <input type="range" id="p-pxtol" min="0" max="60" value="0" step="1">
        </label>
        <label class="row" title="Each fully opaque face gets one background square in its dominant color; only the differing pixel regions are layered 0.001 m above it — same appearance, far fewer decorations">
          <span>Overdraw layering</span>
          <input type="checkbox" id="p-overdraw" checked>
        </label>
        <div class="hint2">Reproduces voxel-style models exactly: each rectangular face is
          mapped to its texture pixels and identical colors are greedy-merged into
          squares.</div>
      </div>

      <details id="adv-params">
        <summary>Advanced</summary>
        <label class="row" id="row-thin" title="Scale of each primitive's thin axis — how thick the generated triangles/squares are (0.01 ≈ paper thin)">
          <span>Thickness scale</span>
          <input type="number" id="p-thin" value="0.01" min="0.01" max="10" step="0.05">
        </label>
        <label class="row" title="Mirrors the model across the Z axis — the game uses the same Z convention as the source model, so leave this off unless your model imports front-to-back flipped">
          <span>Flip Z (mirror)</span>
          <input type="checkbox" id="p-flipz">
        </label>
        <label class="row" title="Order in which rotation angles are applied when reconstructing orientations — switch to XYZ if rotated primitives look skewed in the target engine">
          <span>Euler order</span>
          <select id="p-euler">
            <option value="YXZ" selected>YXZ (Unity-style)</option>
            <option value="XYZ">XYZ</option>
          </select>
        </label>
        <label class="row" id="row-alpha" title="Texture areas with alpha below this value (0–1) produce no geometry; fully transparent pixels are always skipped">
          <span>Alpha cutoff</span>
          <input type="number" id="p-alpha" value="0.5" min="0" max="1" step="0.05">
        </label>
      </details>
    </details>

    <details class="panel" id="texture-panel" open hidden>
      <summary>Texture</summary>
      <select id="tx-select" hidden title="Which of the model's textures to edit"></select>
      <canvas id="tx-canvas" title="Texture preview"></canvas>
      <label class="row" title="Merges similar colors into fewer representative colors (weighted by how often they appear) — higher values significantly reduce the palette while preserving the overall appearance. 0 = off">
        <span>Color reduction <em id="v-txcolors">off</em></span>
        <input type="range" id="tx-colors" min="0" max="100" value="0" step="1">
      </label>
      <label class="row" title="Rotates all hues around the color wheel">
        <span>Hue shift <em id="v-txhue">0</em></span>
        <input type="range" id="tx-hue" min="-180" max="180" value="0" step="5">
      </label>
      <label class="row" title="0% = grayscale, 100% = original colors, 200% = oversaturated">
        <span>Saturation <em id="v-txsat">100</em></span>
        <input type="range" id="tx-sat" min="0" max="200" value="100" step="5">
      </label>
      <label class="row" title="Lightens or darkens the whole texture">
        <span>Brightness <em id="v-txbri">0</em></span>
        <input type="range" id="tx-bri" min="-100" max="100" value="0" step="5">
      </label>
      <label class="row" title="Increases or decreases contrast">
        <span>Contrast <em id="v-txcon">0</em></span>
        <input type="range" id="tx-con" min="-100" max="100" value="0" step="5">
      </label>
      <label class="row" title="Inverts all colors (negative)">
        <span>Invert</span>
        <input type="checkbox" id="tx-invert">
      </label>
      <button id="tx-reset" class="secondary">Reset texture</button>
      <div class="hint2">Edits apply to the conversion (colors are sampled from the edited
        texture) — Generate to see the result. The viewport model keeps its
        original texture.</div>
    </details>

    <details class="panel" open>
      <summary>4. Conversion result</summary>
      <div id="gen-stats" class="stat-grid"></div>
    </details>

    <footer>
      Runs fully in your browser
    </footer>
    </div><!-- /sidebar-scroll -->

    <div id="action-bar">
      <button id="btn-generate" disabled>Generate</button>
      <div id="progress" hidden><div id="progress-bar"></div></div>
    </div>
    <div class="resize-handle" id="resize-left" title="Drag to resize"></div>
  </aside>

  <main id="viewport">
    <canvas id="canvas"></canvas>
    <div id="drop-hint">Load a model to begin</div>

    <div id="vp-topbars">
    <div id="vp-toolbar">
      <div class="tb-group" id="tb-tools" role="toolbar" aria-label="Tools">
        <button class="tb-btn" data-tool="orbit" title="Orbit — left mouse rotates the camera (Esc)">Orbit</button>
        <button class="tb-btn" data-tool="select" title="Select (Q) — click or drag-box; Shift adds, Ctrl toggles/subtracts">Select</button>
        <button class="tb-btn" data-tool="move" title="Move (W) — select + translate gizmo">Move</button>
        <button class="tb-btn" data-tool="rotate" title="Rotate (E) — select + rotate gizmo">Rotate</button>
        <button class="tb-btn" data-tool="scale" title="Scale (R) — select + scale gizmo">Scale</button>
        <button class="tb-btn" data-tool="place" title="Place primitive (T) — click a surface to add a primitive">Place</button>
      </div>
      <div class="tb-group">
        <button class="tb-btn" id="tb-space" title="Gizmo axes: World or Local (X)">World</button>
        <button class="tb-btn tb-toggle" id="tb-snap" title="Grid snapping — hold Ctrl during a drag to invert temporarily">Snap</button>
        <input type="number" id="tb-snapstep" value="1" min="0.01" step="0.5"
          title="Snap step in decoration units (1 = 0.1 m). Rotation snaps to 15°, scale to 0.1">
      </div>
      <div class="tb-group">
        <button class="tb-btn" id="tb-focus" title="Focus the camera on the selection, or the whole model (F)">Focus</button>
      </div>
      <div class="tb-group">
        <button class="tb-btn tb-toggle pressed" id="tb-model" title="Show/hide the source model">Model</button>
        <button class="tb-btn tb-toggle pressed" id="tb-grid" title="Show/hide the ground grid (G)">Grid</button>
        <button class="tb-btn tb-toggle pressed" id="tb-axes" title="Show/hide the origin axes">Axes</button>
        <select id="p-overlay" class="tb-select" title="How reconstructions are drawn: green wireframe over the model, solid color-accurate preview, both, or hidden">
          <option value="wireframe" selected>Wireframe</option>
          <option value="solid">Solid</option>
          <option value="both">Both</option>
          <option value="off">Hidden</option>
        </select>
      </div>
    </div>

    <div id="tb-place" hidden>
      <span class="tb-label">Place:</span>
      <select id="ed-kind" title="Primitive type to place">
        <option value="square" selected>Cuboid</option>
        <option value="plane">Plane</option>
        <option value="sphere">Sphere</option>
        <option value="cylinder">Cylinder</option>
        <option value="cone">Cone</option>
        <option value="prism">Triangular Prism</option>
        <option value="triangle">Roof Component</option>
      </select>
      <input type="color" id="ed-color" value="#ffffff" title="Color of placed primitives">
      <input type="number" id="ed-size" value="0.5" min="0.01" step="0.1" title="Size of placed primitives (meters)">
    </div>
    </div><!-- /vp-topbars -->

    <div id="nav-widget">
      <canvas id="nav-gizmo" width="96" height="96"
        title="Camera orientation — click an axis to snap the view, drag to orbit"></canvas>
      <button id="nav-proj" title="Toggle Perspective / Orthographic projection">Persp</button>
    </div>

    <div id="vp-status">
      <span id="st-decs" title="Decorations in the active reconstruction"></span>
      <span id="st-sel" title="Selected primitives"></span>
      <span id="st-models" title="How the output splits into models of ≤999 decorations"></span>
      <span id="st-size" title="Estimated output size"></span>
      <span id="st-warn" class="warn" title="Warnings"></span>
    </div>
  </main>

  <aside id="rightbar">
    <div class="resize-handle" id="resize-right" title="Drag to resize"></div>
    <div class="rb-scroll">

    <details class="panel" open>
      <summary>Scene</summary>
      <div id="recon-list" title="Each generation is kept as a reconstruction — toggle visibility to compare them; the selected (radio) one is used for the output and for editing"></div>
      <div class="hint2" id="scene-empty">Generate a reconstruction to populate the scene.</div>
      <button id="btn-clear-recons" class="secondary" hidden
        title="Remove all generated models (the loaded source model is kept)">✕ Clear all generated models</button>
    </details>

    <details class="panel" open>
      <summary>Selection</summary>
      <div id="ed-selinfo" class="hint2">Nothing selected</div>
      <div class="btn-row">
        <button class="mini" id="sel-all" title="Select every primitive (Ctrl+A)">All</button>
        <button class="mini" id="sel-none" title="Deselect everything (Alt+A / Esc)">None</button>
        <button class="mini" id="sel-invert" title="Invert the selection (Ctrl+I)">Invert</button>
      </div>
      <label class="row" title="When enabled, drag-box selection also picks primitives hidden behind others; when off, only primitives actually visible in the viewport are selected">
        <span>Select through</span>
        <input type="checkbox" id="ed-through">
      </label>
      <div class="subhead">Filter</div>
      <label class="row" title="Restrict selection actions to one primitive type">
        <span>Type</span>
        <select id="ed-filterkind">
          <option value="" selected>Any type</option>
          <option value="square">Cuboid</option>
          <option value="plane">Plane</option>
          <option value="sphere">Sphere</option>
          <option value="cylinder">Cylinder</option>
          <option value="cone">Cone</option>
          <option value="prism">Triangular Prism</option>
          <option value="triangle">Roof Component</option>
        </select>
      </label>
      <div class="row" title="Restrict selection actions to primitives close to this color">
        <span>Color</span>
        <input type="checkbox" id="ed-filteren">
        <input type="color" id="ed-filtercolor" value="#ffffff">
        <input type="number" id="ed-filtertol" value="40" min="0" max="200" step="10" title="Color distance tolerance">
      </div>
      <div class="btn-row">
        <button class="mini" id="sel-filter-select" title="Select all primitives matching the filter">Select</button>
        <button class="mini" id="sel-filter-add" title="Add matching primitives to the selection">Add</button>
        <button class="mini" id="sel-filter-sub" title="Remove matching primitives from the selection">Remove</button>
      </div>
      <div class="subhead">Edit</div>
      <div class="row" id="ed-colorrow" hidden title="Change the color of the selected primitive(s)">
        <span>Color</span>
        <input type="color" id="ed-selcolor" value="#ffffff">
      </div>
      <div id="ed-transform" hidden>
        <div class="row-triple" title="Position of the selection (units of 0.1 m); for multiple primitives this is the selection center — editing moves the whole selection">
          <span>Position</span>
          <input type="number" id="ed-px" step="0.5"><input type="number" id="ed-py" step="0.5"><input type="number" id="ed-pz" step="0.5">
        </div>
        <div class="row-triple" title="Rotation of the selected primitive (degrees) — single selection only">
          <span>Rotation</span>
          <input type="number" id="ed-rx" step="15"><input type="number" id="ed-ry" step="15"><input type="number" id="ed-rz" step="15">
        </div>
        <div class="row-triple" title="Zoom of the selected primitive — single selection only">
          <span>Zoom</span>
          <input type="number" id="ed-zx" step="0.5"><input type="number" id="ed-zy" step="0.5"><input type="number" id="ed-zz" step="0.5">
        </div>
      </div>
      <div class="btn-row">
        <button class="mini" id="ed-dup" disabled title="Duplicate the selection in place (Ctrl+D); use the Move gizmo to offset the copies">Duplicate</button>
        <button class="mini danger" id="ed-delete" disabled title="Delete the selection (Del)">Delete</button>
      </div>
      <div class="hint2">Click selects · Shift adds · Ctrl toggles · drag for box select ·
        Ctrl+C/V copy &amp; paste · Ctrl+Z/Y undo &amp; redo · Space cycles
        Move/Rotate/Scale · RMB orbits, MMB pans.</div>
    </details>

    <details class="panel" open>
      <summary>Statistics</summary>
      <div id="edit-stats" class="stat-grid"></div>
      <div id="stat-warnings"></div>
    </details>

    <details class="panel" open>
      <summary>Optimize</summary>
      <label class="row" title="Color tolerance used when merging — 0 merges only identical colors">
        <span>Merge tolerance <em id="v-opttol">0</em></span>
        <input type="range" id="opt-tol" min="0" max="100" value="0" step="1">
      </label>
      <button id="opt-merge" class="secondary"
        title="Merge adjacent coplanar cuboids/planes of equal size and matching color into larger ones — same appearance, fewer decorations">Merge adjacent primitives</button>
      <button id="opt-hidden" class="secondary"
        title="Remove primitives that are not visible from any direction (checked by rendering the model from 26 viewpoints)">Remove hidden primitives</button>
      <div class="row" title="Reduce the reconstruction to at most this many decorations: merges with escalating tolerance first, then drops the smallest primitives">
        <span>Target count</span>
        <input type="number" id="opt-target" value="999" min="1" step="1">
      </div>
      <button id="opt-reduce" class="secondary">Reduce to target</button>
    </details>

    </div><!-- /rb-scroll -->

    <div id="rb-actions">
      <button id="ed-save" disabled
        title="Store the edited reconstruction as its own entry in the scene">Save edits as new model</button>
      ${
        primitives
          ? `
      <button id="btn-view-prims" disabled>View primitives</button>
      <div id="output-summary" class="hint2"></div>`
          : `
      <label class="row" title="Toggling this checkbox will toggle the collision of the model">
        <span>Collision</span>
        <input type="checkbox" id="p-collision" checked>
      </label>
      <label class="row" title="Export dynamic unit prefabs instead of static ones: the first object becomes the Main object and its node graph spawns every other object at runtime (Create Prefab) and makes it follow the Main object (Follow Motion Device). Load optimization is disabled on all objects">
        <span>Auto-Assemble On Runtime</span>
        <input type="checkbox" id="p-autoasm">
      </label>
      <button id="btn-download" disabled>Download .gia</button>`
      }
    </div>
  </aside>

  ${
    primitives
      ? `
  <div id="prim-modal" hidden>
    <div class="modal-box">
      <div class="modal-head">
        <h2>Generated primitives</h2>
        <span id="prim-count" class="hint2"></span>
        <span class="modal-spacer"></span>
        <button id="btn-copy-json" class="small">Copy JSON</button>
        <button id="btn-close-modal" class="small" title="Close">✕</button>
      </div>
      <div class="modal-sub" id="prim-note"></div>
      <div class="modal-body">
        <table id="prim-table">
          <thead>
            <tr>
              <th rowspan="2">✓</th>
              <th rowspan="2">#</th>
              <th rowspan="2">Model Name</th>
              <th rowspan="2">ID</th>
              <th rowspan="2">Kind</th>
              <th colspan="3" class="grp-start grp-head">Position</th>
              <th colspan="3" class="grp-start grp-head">Rotation</th>
              <th colspan="3" class="grp-start grp-head">Zoom</th>
              <th rowspan="2" class="grp-start">Color</th>
            </tr>
            <tr>
              <th class="grp-start sub">X</th><th class="sub">Y</th><th class="sub">Z</th>
              <th class="grp-start sub">X</th><th class="sub">Y</th><th class="sub">Z</th>
              <th class="grp-start sub">X</th><th class="sub">Y</th><th class="sub">Z</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        <button id="btn-more-rows" hidden>Show remaining rows</button>
      </div>
    </div>
  </div>`
      : ""
  }
</div>`;

  // ----- resizable sidebars (persisted) -----
  setupResize("sidebar", "resize-left", +1, 240, 480);
  setupResize("rightbar", "resize-right", -1, 220, 460);
}

function setupResize(asideId, handleId, dir, min, max) {
  const aside = document.getElementById(asideId);
  const handle = document.getElementById(handleId);
  if (!aside || !handle) return;
  const key = "panel-width:" + asideId;
  try {
    const saved = parseInt(localStorage.getItem(key), 10);
    if (saved >= min && saved <= max)
      aside.style.width = aside.style.minWidth = saved + "px";
  } catch {}
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const startW = aside.getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.round(
        Math.min(max, Math.max(min, startW + dir * (ev.clientX - startX))),
      );
      aside.style.width = aside.style.minWidth = w + "px";
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(key, parseInt(aside.style.width, 10));
      } catch {}
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}
