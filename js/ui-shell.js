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

      <label class="row" title="Quick bundles of the settings below: Visual fidelity keeps more color detail and primitives; Minimal trades detail for the lowest primitive count; Balanced sits in between">
        <span>Priority preset</span>
        <select id="p-preset">
          <option value="balanced" selected>Balanced</option>
          <option value="fidelity">Visual fidelity</option>
          <option value="minimal">Minimal triangles</option>
          <option value="custom">Custom</option>
        </select>
      </label>

      <label class="row" title="Multiplier from the model's units to meters — e.g. use 0.01 for a model authored in centimeters (common for FBX)">
        <span>Input unit scale</span>
        <input type="number" id="p-unit" value="1" min="0.0001" step="0.1">
      </label>

      <label class="row" title="Which primitive shapes to generate: Triangles (default), Squares (best for voxel-style models; leftovers are approximated), or Both (squares wherever they fit exactly, triangles elsewhere — no fidelity loss)">
        <span>Primitives</span>
        <select id="p-prim">
          <option value="triangles" selected>Triangles</option>
          <option value="squares">Squares</option>
          <option value="both">Both</option>
        </select>
      </label>

      <label class="row" title="Simplifies the source mesh before conversion by snapping vertices to a grid — use on high-poly models to cut primitive count and speed things up. 0 = off, higher = coarser">
        <span>Decimation <em id="v-decimate">off</em></span>
        <input type="range" id="p-decimate" min="0" max="90" value="0" step="5">
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

      <label class="row" title="Hard cap on generated primitives — the smallest ones are dropped first when exceeded. Output is split into models of at most 999 each">
        <span>Max decorations <em id="v-max">4995</em></span>
        <input type="number" id="p-max" value="4995" min="1" max="99900" step="1">
      </label>

      <label class="row" title="Dissolves adjacent flat faces with similar colors and rebuilds them with fewer, larger primitives — the main primitive-count reducer for flat surfaces">
        <span>Merge coplanar faces</span>
        <input type="checkbox" id="p-merge" checked>
      </label>

      <details>
        <summary>Advanced</summary>
        <label class="row" title="Scale of each primitive's thin axis — how thick the generated triangles/squares are (0.01 ≈ paper thin)">
          <span>Thickness scale</span>
          <input type="number" id="p-thin" value="0.01" min="0.01" max="10" step="0.05">
        </label>
        <label class="row" title="How far two face normals may deviate (in degrees) while still counting as coplanar for merging — raise it to flatten gently curved surfaces">
          <span>Coplanar angle (°)</span>
          <input type="number" id="p-planar" value="1" min="0" max="30" step="0.25">
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
      <h2>3. Generate</h2>
      <button id="btn-generate" disabled>Generate</button>
      <div id="progress" hidden><div id="progress-bar"></div></div>
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
      <label class="row" title="Show or hide the imported source model in the viewport (hide it to inspect the generated preview alone)">
        <span>Show source model</span>
        <input type="checkbox" id="p-showsrc" checked>
      </label>
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

    <footer>
      Runs fully in your browser${primitives ? '' : ` ·
      <a href="../index.html">primitive data page</a> ·
      <a href="../docs/gia-format.md" target="_blank">format notes</a>`}
    </footer>
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
      <div class="modal-body">
        <table id="prim-table">
          <thead>
            <tr><th>✓</th><th>#</th><th>Kind</th><th>Position</th><th>Rotation</th><th>Zoom</th><th>Color</th></tr>
          </thead>
          <tbody></tbody>
        </table>
        <button id="btn-more-rows" hidden>Show remaining rows</button>
      </div>
    </div>
  </div>` : ''}
</div>`;
}
