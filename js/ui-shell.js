// Shared UI shell for both pages (single source of truth for the markup).
//
//   renderShell(rootElement, { primitives: true })
//
// primitives: true (the main landing page) — outputs only primitive data in
//   a popup table; contains no .gia references.
// primitives: false (the /gia page) — .gia download button, collision
//   toggle, and format documentation links.

export function renderShell(root, { primitives = true } = {}) {
  root.innerHTML = `
<div id="app">
  <aside id="sidebar">
    <h1>${primitives ? '3D → Primitives' : '3D → GIA <span class="badge">.gia export</span>'}</h1>
    <div class="sidebar-scroll">

    <section class="panel">
      <h2>1. Model</h2>
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
    </section>

    <section class="panel">
      <h2>2. Parameters</h2>

      <label class="row" title="Multiplier from the model's units to meters — e.g. use 0.01 for a model authored in centimeters (common for FBX)">
        <span>Input unit scale</span>
        <input type="number" id="p-unit" value="1" min="0.0001" step="0.1">
      </label>

      <label class="row" title="Simplifies the source mesh before conversion by snapping vertices to a grid — use on high-poly models to cut primitive count and speed things up. 0 = off, higher = coarser">
        <span>Decimation <em id="v-decimate">off</em></span>
        <input type="range" id="p-decimate" min="0" max="90" value="0" step="5">
      </label>

      <label class="row" title="Hard cap on generated primitives — the smallest ones are dropped first when exceeded. Output is split into models of at most 999 each">
        <span>Max decorations <em id="v-max">4995</em></span>
        <input type="number" id="p-max" value="4995" min="1" max="99900" step="1">
      </label>

      <label class="row" title="Reconstruction mode: Direct converts mesh faces as-is; Voxel rebuilds from colored voxels (boxes or a marching-cubes surface); Pixel Perfect reproduces voxel-style models exactly, per texture pixel">
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
        <label class="row" title="Boxes keeps the blocky voxel look; Marching cubes builds a signed distance field and reconstructs a smooth surface from it (output uses squares and right triangles)">
          <span>Surface</span>
          <select id="p-voxsurf">
            <option value="boxes" selected>Boxes (blocky)</option>
            <option value="mc">Marching cubes (SDF)</option>
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
          <label class="row" title="Smoothing passes over the distance field — more passes give a softer, rounder surface">
            <span>SDF smoothing <em id="v-sdfsmooth">1</em></span>
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

      <details>
        <summary>Advanced</summary>
        <label class="row" title="Scale of each primitive's thin axis — how thick the generated triangles/squares are (0.01 ≈ paper thin)">
          <span>Thickness scale</span>
          <input type="number" id="p-thin" value="0.01" min="0.01" max="10" step="0.05">
        </label>
        <label class="row" title="Converts from the right-handed -Z-forward convention (glTF/three.js) to the target's Y-up +Z-forward — leave on unless your model imports mirrored">
          <span>Flip Z (to Z-forward)</span>
          <input type="checkbox" id="p-flipz" checked>
        </label>
        <label class="row" title="Order in which rotation angles are applied when reconstructing orientations — switch to XYZ if rotated primitives look skewed in the target engine">
          <span>Euler order</span>
          <select id="p-euler">
            <option value="YXZ" selected>YXZ (Unity-style)</option>
            <option value="XYZ">XYZ</option>
          </select>
        </label>
        <label class="row" title="Recenters the result so it is centered on X/Z and rests on the ground (Y=0)">
          <span>Recenter on origin</span>
          <input type="checkbox" id="p-center" checked>
        </label>
        <label class="row" title="Texture areas with alpha below this value (0–1) produce no geometry; fully transparent pixels are always skipped">
          <span>Alpha cutoff</span>
          <input type="number" id="p-alpha" value="0.5" min="0" max="1" step="0.05">
        </label>
      </details>
    </section>

    <section class="panel" id="texture-panel" hidden>
      <h2>Texture</h2>
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
    </section>

    <section class="panel">
      <h2>Transform</h2>
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
      <div class="hint2">Pivot moves to the origin; rotation applies around it (YXZ order). The viewport updates live.</div>
    </section>

    <section class="panel">
      <h2>3. Output</h2>
      <div id="gen-stats" class="stat-grid"></div>
      <label class="row" title="How the generated primitives are drawn: green wireframe over the model, solid color-accurate preview, both, or hidden">
        <span>Overlay</span>
        <select id="p-overlay">
          <option value="wireframe" selected>Wireframe on model</option>
          <option value="solid">Solid preview</option>
          <option value="both">Both</option>
          <option value="off">Hidden</option>
        </select>
      </label>
      <label class="row" title="Show or hide the imported source model in the viewport (hide it to inspect the generated previews alone)">
        <span>Show source model</span>
        <input type="checkbox" id="p-showsrc" checked>
      </label>
      <div id="recon-list" title="Each generation is kept as a reconstruction — toggle visibility to compare them; the selected (radio) one is used for the output"></div>
      <button id="btn-clear-recons" class="secondary" hidden
        title="Remove all generated models (the loaded source model is kept)">✕ Clear all generated models</button>
      ${primitives ? `
      <button id="btn-view-prims" disabled>View primitives</button>
      <div id="output-summary" class="hint2"></div>` : `
      <label class="row">
        <span>Collision</span>
        <input type="checkbox" id="p-collision" checked
          title="Whether the exported models collide with players/objects">
      </label>
      <button id="btn-download" disabled>Download .gia</button>`}
    </section>

    <section class="panel" id="edit-panel" hidden>
      <h2>Edit model</h2>
      <label class="row" title="Enables manual editing of the selected reconstruction: click primitives in the viewport to select them, or place new ones">
        <span>Edit mode</span>
        <input type="checkbox" id="ed-enable">
      </label>
      <div id="edit-tools" hidden>
        <label class="row" title="Select: click primitives (Shift-click adds), or drag a box to select all visible primitives inside it. Place: click any surface to add a new primitive there">
          <span>Tool</span>
          <select id="ed-tool">
            <option value="select" selected>Select / delete</option>
            <option value="place">Place primitive</option>
          </select>
        </label>
        <label class="row" title="3D manipulation gizmo for the selected primitive: drag the arrows/rings/handles in the viewport to move, rotate, or scale it">
          <span>Gizmo</span>
          <select id="ed-gizmo">
            <option value="translate" selected>Move</option>
            <option value="rotate">Rotate</option>
            <option value="scale">Scale</option>
          </select>
        </label>
        <div class="row" title="Restrict drag/box selection to primitives close to this color">
          <span>Filter by color</span>
          <input type="checkbox" id="ed-filteren">
          <input type="color" id="ed-filtercolor" value="#ffffff">
          <input type="number" id="ed-filtertol" value="40" min="0" max="200" step="10" title="Color distance tolerance">
        </div>
        <div id="ed-place" hidden>
          <label class="row" title="Primitive type to place">
            <span>Primitive</span>
            <select id="ed-kind">
              <option value="square" selected>Cuboid</option>
              <option value="plane">Plane</option>
              <option value="sphere">Sphere</option>
              <option value="cylinder">Cylinder</option>
              <option value="cone">Cone</option>
              <option value="prism">Triangular Prism</option>
              <option value="triangle">Roof Component</option>
            </select>
          </label>
          <div class="row" title="Color and size (meters) for placed primitives">
            <span>Color / size</span>
            <input type="color" id="ed-color" value="#ffffff">
            <input type="number" id="ed-size" value="0.5" min="0.01" step="0.1">
          </div>
        </div>
        <div id="ed-selinfo" class="hint2">Nothing selected</div>
        <div class="row" id="ed-colorrow" hidden title="Change the color of the selected primitive(s)">
          <span>Color</span>
          <input type="color" id="ed-selcolor" value="#ffffff">
        </div>
        <div id="ed-transform" hidden>
          <div class="row-triple" title="Position of the selected primitive (units of 0.1 m)">
            <span>Position</span>
            <input type="number" id="ed-px" step="0.5"><input type="number" id="ed-py" step="0.5"><input type="number" id="ed-pz" step="0.5">
          </div>
          <div class="row-triple" title="Rotation of the selected primitive (degrees)">
            <span>Rotation</span>
            <input type="number" id="ed-rx" step="15"><input type="number" id="ed-ry" step="15"><input type="number" id="ed-rz" step="15">
          </div>
          <div class="row-triple" title="Zoom of the selected primitive">
            <span>Zoom</span>
            <input type="number" id="ed-zx" step="0.5"><input type="number" id="ed-zy" step="0.5"><input type="number" id="ed-zz" step="0.5">
          </div>
        </div>
        <button id="ed-delete" class="secondary" disabled>Delete selected</button>
        <button id="ed-save">Save edits as new model</button>
        <div class="hint2">Drag in the viewport to box-select visible primitives (occluded ones
          are skipped). <b>Delete</b> removes the selection, <b>Ctrl+Z</b> undoes the
          last edit. While Edit mode is on, orbit the camera with the right mouse
          button.</div>
      </div>
    </section>

    <footer>
      Runs fully in your browser${primitives ? '' : ` ·
      <a href="../index.html">primitive data page</a> ·
      <a href="../docs/gia-format.md" target="_blank">format notes</a>`}
    </footer>
    </div><!-- /sidebar-scroll -->

    <div id="action-bar">
      <button id="btn-generate" disabled>Generate</button>
      <div id="progress" hidden><div id="progress-bar"></div></div>
    </div>
  </aside>

  <main id="viewport">
    <canvas id="canvas"></canvas>
    <div id="drop-hint">Load a model to begin</div>
  </main>

  ${primitives ? `
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
  </div>` : ''}
</div>`;
}
