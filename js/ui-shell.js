// Shared UI shell for both pages (single source of truth for the markup).
//
//   renderShell(rootElement, { primitives, primitivesHref, docsHref })
//
// primitives: false (the MAIN page) — .gia download button, collision +
//   auto-assemble toggles, and format documentation links.
// primitives: true (the /gia page) — outputs only primitive data in a popup
//   table; contains no .gia references.
//
// All user-facing text is bound through data-i18n / data-i18n-title keys and
// filled in by applyI18n() (js/i18n.js) — the markup itself contains no
// hardcoded English. renderShell() applies the active language and wires the
// language selector.

import { applyI18n, setLanguage, currentLang, LANGS, t } from "./i18n.js";

export function renderShell(root, {
  primitives = true,
} = {}) {
  root.innerHTML = `
<div id="app">
  <aside id="sidebar">
    <h1>${primitives
      ? '<span data-i18n="app.title.prims"></span>'
      : '<span data-i18n="app.title.gia"></span> <span class="badge" data-i18n="app.badge"></span>'}</h1>
    <label class="row" id="lang-row">
      <span>🌐 <span data-i18n="lang.label"></span></span>
      <select id="lang-select"></select>
    </label>
    <div class="sidebar-scroll">

    <details class="panel" id="panel-model" open>
      <summary data-i18n="panel.model"></summary>
      <label class="filedrop" id="filedrop">
        <input type="file" id="file-input" multiple
          accept=".fbx,.obj,.glb,.gltf,.stl,.mtl,.png,.jpg,.jpeg,.webp,.bmp,.gif,.tga">
        <span><span data-i18n="drop.line1"></span><br><span data-i18n="drop.line2"></span></span>
        <span class="hint"><span data-i18n="drop.hint1"></span><br>
          <span data-i18n="drop.hint2"></span></span>
      </label>
      <div id="model-info" class="stat-grid"></div>
      <div id="texture-list"></div>
      <button id="btn-sprite" hidden data-i18n="sprite.use"></button>
      <div id="sprite-params" hidden>
        <label class="row" data-i18n-title="tip.sprite.thick">
          <span data-i18n="sprite.thick"></span>
          <input type="number" id="p-sprite-thick" value="0.1" min="0.05" max="10" step="0.05">
        </label>
        <label class="row" data-i18n-title="tip.sprite.px">
          <span data-i18n="sprite.px"></span>
          <input type="number" id="p-sprite-px" value="0.05" min="0.01" max="1" step="0.01">
        </label>
        <label class="row" data-i18n-title="tip.sprite.od">
          <span data-i18n="sprite.od"></span>
          <input type="checkbox" id="p-sprite-od" checked>
        </label>
      </div>
      <button id="btn-clear" class="secondary" data-i18n="btn.clear" data-i18n-title="tip.btn.clear"></button>
    </details>

    <details class="panel" id="panel-transform" open>
      <summary data-i18n="panel.transform"></summary>
      <label class="row" id="row-unit" data-i18n-title="tip.tf.unit">
        <span data-i18n="tf.unit"></span>
        <input type="number" id="p-unit" value="1" min="0.1" step="0.1">
      </label>
      <div class="row-triple" data-i18n-title="tip.tf.scale">
        <span data-i18n="tf.scale"></span>
        <input type="number" id="t-sx" value="1" min="0.1" step="0.1">
        <input type="number" id="t-sy" value="1" min="0.1" step="0.1">
        <input type="number" id="t-sz" value="1" min="0.1" step="0.1">
      </div>
      <div class="row-triple" data-i18n-title="tip.tf.pivot">
        <span data-i18n="tf.pivot"></span>
        <input type="number" id="t-px" value="0" step="0.1">
        <input type="number" id="t-py" value="0" step="0.1">
        <input type="number" id="t-pz" value="0" step="0.1">
      </div>
      <div class="row-triple" data-i18n-title="tip.tf.rot">
        <span data-i18n="tf.rot"></span>
        <input type="number" id="t-rx" value="0" step="15">
        <input type="number" id="t-ry" value="0" step="15">
        <input type="number" id="t-rz" value="0" step="15">
      </div>
      <button id="t-reset" class="secondary" data-i18n="tf.reset" data-i18n-title="tip.tf.reset"></button>
      <div class="hint2" data-i18n="tf.hint"></div>
    </details>

    <details class="panel" id="panel-params" open>
      <summary data-i18n="panel.params"></summary>

      <div class="hint2" id="sprite-param-note" hidden data-i18n="note.spriteparams"></div>

      <label class="row" id="row-decimate" data-i18n-title="tip.param.decimate">
        <span><span data-i18n="param.decimate"></span> <em id="v-decimate"></em></span>
        <input type="range" id="p-decimate" min="0" max="90" value="0" step="5">
      </label>

      <label class="row" id="row-prevdec" data-i18n-title="tip.param.prevdec">
        <span data-i18n="param.prevdec"></span>
        <input type="checkbox" id="p-prevdec">
      </label>

      <label class="row" data-i18n-title="tip.param.max">
        <span><span data-i18n="param.max"></span> <em id="v-max">99900</em></span>
        <input type="number" id="p-max" value="99900" min="1" max="99900" step="1">
      </label>

      <label class="row" id="row-mode" data-i18n-title="tip.param.mode">
        <span data-i18n="param.mode"></span>
        <select id="p-mode">
          <option value="direct" selected data-i18n="mode.direct"></option>
          <option value="voxel" data-i18n="mode.voxel"></option>
          <option value="pixel" data-i18n="mode.pixel"></option>
        </select>
      </label>

      <div id="direct-params" class="mode-group">
        <label class="row" data-i18n-title="tip.param.preset">
          <span data-i18n="param.preset"></span>
          <select id="p-preset">
            <option value="balanced" selected data-i18n="preset.balanced"></option>
            <option value="fidelity" data-i18n="preset.fidelity"></option>
            <option value="minimal" data-i18n="preset.minimal"></option>
            <option value="custom" data-i18n="preset.custom"></option>
          </select>
        </label>
        <label class="row" data-i18n-title="tip.param.prim">
          <span data-i18n="param.prim"></span>
          <select id="p-prim">
            <option value="triangles" selected data-i18n="prim.triangles"></option>
            <option value="both" data-i18n="prim.both"></option>
          </select>
        </label>
        <label class="row" data-i18n-title="tip.param.tol">
          <span><span data-i18n="param.tol"></span> <em id="v-tol">30</em></span>
          <input type="range" id="p-tol" min="0" max="150" value="30" step="1">
        </label>
        <label class="row" data-i18n-title="tip.param.subdiv">
          <span><span data-i18n="param.subdiv"></span> <em id="v-subdiv">3</em></span>
          <input type="range" id="p-subdiv" min="0" max="5" value="3" step="1">
        </label>
        <label class="row" data-i18n-title="tip.param.smartedge">
          <span data-i18n="param.smartedge"></span>
          <input type="checkbox" id="p-smartedge">
        </label>
        <label class="row" data-i18n-title="tip.param.snap">
          <span><span data-i18n="param.snap"></span> <em id="v-snap">1</em></span>
          <input type="range" id="p-snap" min="0" max="15" value="1" step="0.5">
        </label>
        <label class="row" data-i18n-title="tip.param.merge">
          <span data-i18n="param.merge"></span>
          <input type="checkbox" id="p-merge" checked>
        </label>
        <label class="row" data-i18n-title="tip.param.planar">
          <span data-i18n="param.planar"></span>
          <input type="number" id="p-planar" value="1" min="0" max="30" step="0.25">
        </label>
      </div>

      <div id="voxel-params" class="mode-group" hidden>
        <div class="row" data-i18n-title="tip.voxel.res">
          <span data-i18n="voxel.res"></span>
          <input type="range" id="p-voxres" min="8" max="256" value="256" step="8">
          <input type="number" id="p-voxres-n" value="256" min="2" step="1">
        </div>
        <label class="row" data-i18n-title="tip.voxel.surface">
          <span data-i18n="voxel.surface"></span>
          <select id="p-voxsurf">
            <option value="boxes" selected data-i18n="voxel.boxes"></option>
            <option value="mc" data-i18n="voxel.mc"></option>
          </select>
        </label>
        <label class="row" data-i18n-title="tip.voxel.tol">
          <span><span data-i18n="voxel.tol"></span> <em id="v-voxtol">20</em></span>
          <input type="range" id="p-voxtol" min="0" max="150" value="20" step="1">
        </label>
        <div id="sdf-params" hidden>
          <label class="row" data-i18n-title="tip.sdf.iso">
            <span><span data-i18n="sdf.iso"></span> <em id="v-sdfiso">0</em></span>
            <input type="range" id="p-sdfiso" min="-2" max="2" value="0" step="0.25">
          </label>
          <label class="row" data-i18n-title="tip.sdf.smooth">
            <span><span data-i18n="sdf.smooth"></span> <em id="v-sdfsmooth">1</em></span>
            <input type="range" id="p-sdfsmooth" min="0" max="4" value="1" step="1">
          </label>
        </div>
        <div class="hint2" data-i18n="voxel.hint"></div>
      </div>

      <div id="pixel-params" class="mode-group" hidden>
        <label class="row" data-i18n-title="tip.pixel.tol">
          <span><span data-i18n="pixel.tol"></span> <em id="v-pxtol">0</em></span>
          <input type="range" id="p-pxtol" min="0" max="60" value="0" step="1">
        </label>
        <label class="row" data-i18n-title="tip.pixel.overdraw">
          <span data-i18n="pixel.overdraw"></span>
          <input type="checkbox" id="p-overdraw" checked>
        </label>
        <div class="hint2" data-i18n="pixel.hint"></div>
      </div>

      <details id="adv-params">
        <summary data-i18n="adv.title"></summary>
        <label class="row" id="row-thin" data-i18n-title="tip.adv.thin">
          <span data-i18n="adv.thin"></span>
          <input type="number" id="p-thin" value="0.01" min="0.01" max="10" step="0.01">
        </label>
        <label class="row" data-i18n-title="tip.adv.flipz">
          <span data-i18n="adv.flipz"></span>
          <input type="checkbox" id="p-flipz">
        </label>
        <label class="row" data-i18n-title="tip.adv.euler">
          <span data-i18n="adv.euler"></span>
          <select id="p-euler">
            <option value="YXZ" selected data-i18n="euler.yxz"></option>
            <option value="XYZ" data-i18n="euler.xyz"></option>
          </select>
        </label>
        <label class="row" id="row-alpha" data-i18n-title="tip.adv.alpha">
          <span data-i18n="adv.alpha"></span>
          <input type="number" id="p-alpha" value="0.5" min="0" max="1" step="0.05">
        </label>
      </details>
    </details>

    <details class="panel" id="texture-panel" open hidden>
      <summary data-i18n="panel.texture"></summary>
      <select id="tx-select" hidden data-i18n-title="tip.tx.select"></select>
      <canvas id="tx-canvas" data-i18n-title="tip.tx.canvas"></canvas>
      <label class="row" data-i18n-title="tip.tx.hue">
        <span><span data-i18n="tx.hue"></span> <em id="v-txhue">0</em></span>
        <input type="range" id="tx-hue" min="-180" max="180" value="0" step="5">
      </label>
      <label class="row" data-i18n-title="tip.tx.sat">
        <span><span data-i18n="tx.sat"></span> <em id="v-txsat">100</em></span>
        <input type="range" id="tx-sat" min="0" max="200" value="100" step="5">
      </label>
      <label class="row" data-i18n-title="tip.tx.bri">
        <span><span data-i18n="tx.bri"></span> <em id="v-txbri">0</em></span>
        <input type="range" id="tx-bri" min="-100" max="100" value="0" step="5">
      </label>
      <label class="row" data-i18n-title="tip.tx.con">
        <span><span data-i18n="tx.con"></span> <em id="v-txcon">0</em></span>
        <input type="range" id="tx-con" min="-100" max="100" value="0" step="5">
      </label>
      <label class="row" data-i18n-title="tip.tx.invert">
        <span data-i18n="tx.invert"></span>
        <input type="checkbox" id="tx-invert">
      </label>
      <button id="tx-reset" class="secondary" data-i18n="tx.reset"></button>
      <button id="tx-sync" class="secondary" hidden data-i18n="tx.sync" data-i18n-title="tip.tx.sync"></button>
      <div class="hint2" data-i18n="tx.hint"></div>
    </details>

    <details class="panel" open>
      <summary data-i18n="panel.result"></summary>
      <div id="gen-stats" class="stat-grid"></div>
      <div id="gen-warnings"></div>
    </details>

    <footer>
      <span data-i18n="footer.local"></span>
    </footer>
    </div><!-- /sidebar-scroll -->

    <div id="action-bar">
      <button id="btn-generate" disabled data-i18n="btn.generate"></button>
      <div id="progress" hidden><div id="progress-bar"></div></div>
    </div>
    <div class="resize-handle" id="resize-left"></div>
  </aside>

  <main id="viewport">
    <canvas id="canvas"></canvas>
    <div id="drop-hint" data-i18n="app.drophint"></div>

    <div id="vp-topbars">
    <div id="vp-toolbar">
      <div class="tb-group" id="tb-tools" role="toolbar">
        <button class="tb-btn" data-tool="orbit" data-i18n="tool.orbit" data-i18n-title="tip.tool.orbit"></button>
        <button class="tb-btn" data-tool="select" data-i18n="tool.select" data-i18n-title="tip.tool.select"></button>
        <button class="tb-btn" data-tool="move" data-i18n="tool.move" data-i18n-title="tip.tool.move"></button>
        <button class="tb-btn" data-tool="rotate" data-i18n="tool.rotate" data-i18n-title="tip.tool.rotate"></button>
        <button class="tb-btn" data-tool="scale" data-i18n="tool.scale" data-i18n-title="tip.tool.scale"></button>
        <button class="tb-btn" data-tool="place" data-i18n="tool.place" data-i18n-title="tip.tool.place"></button>
      </div>
      <div class="tb-group">
        <button class="tb-btn" id="tb-space" data-i18n="tb.world" data-i18n-title="tip.tb.space"></button>
        <button class="tb-btn tb-toggle" id="tb-snap" data-i18n="tb.snap" data-i18n-title="tip.tb.snap"></button>
        <input type="number" id="tb-snapstep" value="1" min="0.5" step="0.5" data-i18n-title="tip.tb.snapstep">
      </div>
      <div class="tb-group">
        <button class="tb-btn" id="tb-focus" data-i18n="tb.focus" data-i18n-title="tip.tb.focus"></button>
      </div>
      <div class="tb-group">
        <button class="tb-btn tb-toggle pressed" id="tb-model" data-i18n="tb.model" data-i18n-title="tip.tb.model"></button>
        <button class="tb-btn tb-toggle pressed" id="tb-grid" data-i18n="tb.grid" data-i18n-title="tip.tb.grid"></button>
        <button class="tb-btn tb-toggle pressed" id="tb-axes" data-i18n="tb.axes" data-i18n-title="tip.tb.axes"></button>
      </div>
      <div class="tb-group">
        <button class="tb-btn tb-toggle pressed" id="tb-output" data-i18n="tb.output" data-i18n-title="tip.tb.output"></button>
        <select id="p-overlay" class="tb-select" data-i18n-title="tip.overlay">
          <option value="wireframe" selected data-i18n="overlay.wire"></option>
          <option value="solid" data-i18n="overlay.solid"></option>
          <option value="both" data-i18n="overlay.both"></option>
        </select>
      </div>
    </div>

    <div id="tb-place" hidden>
      <span class="tb-label" data-i18n="place.label"></span>
      <select id="ed-kind" data-i18n-title="tip.place.kind">
        <option value="square" selected data-i18n="kind.square"></option>
        <option value="plane" data-i18n="kind.plane"></option>
        <option value="sphere" data-i18n="kind.sphere"></option>
        <option value="cylinder" data-i18n="kind.cylinder"></option>
        <option value="cone" data-i18n="kind.cone"></option>
        <option value="prism" data-i18n="kind.prism"></option>
        <option value="triangle" data-i18n="kind.triangle"></option>
      </select>
      <input type="color" id="ed-color" value="#ffffff" data-i18n-title="tip.place.color">
      <input type="number" id="ed-size" value="0.5" min="0.1" step="0.1" data-i18n-title="tip.place.size">
    </div>
    </div><!-- /vp-topbars -->

    <div id="nav-widget">
      <canvas id="nav-gizmo" width="96" height="96" data-i18n-title="tip.nav"></canvas>
      <button id="nav-proj" data-i18n="nav.persp" data-i18n-title="tip.nav.proj"></button>
    </div>

    <button id="btn-tutorial" data-i18n-title="tip.tut">❓ <span data-i18n="tut.btn"></span></button>

    <div id="vp-status">
      <span id="st-decs" data-i18n-title="tip.st.decs"></span>
      <span id="st-sel" data-i18n-title="tip.st.sel"></span>
      <span id="st-models" data-i18n-title="tip.st.models"></span>
      <span id="st-size" data-i18n-title="tip.st.size"></span>
      <span id="st-warn" class="warn" data-i18n-title="tip.st.warn"></span>
    </div>
  </main>

  <aside id="rightbar">
    <div class="resize-handle" id="resize-right"></div>
    <div class="rb-scroll">

    <details class="panel" id="panel-scene" open>
      <summary data-i18n="panel.scene"></summary>
      <div id="recon-list" data-i18n-title="tip.recon.list"></div>
      <div class="hint2" id="scene-empty" data-i18n="scene.empty"></div>
      <button id="btn-clear-recons" class="secondary" hidden data-i18n="scene.clear" data-i18n-title="tip.scene.clear"></button>
    </details>

    <details class="panel" id="panel-selection" open>
      <summary data-i18n="panel.selection"></summary>
      <div id="ed-selinfo" class="hint2"></div>
      <div class="btn-row">
        <button class="mini" id="sel-all" data-i18n="sel.all" data-i18n-title="tip.sel.all"></button>
        <button class="mini" id="sel-none" data-i18n="sel.nonebtn" data-i18n-title="tip.sel.nonebtn"></button>
        <button class="mini" id="sel-invert" data-i18n="sel.invert" data-i18n-title="tip.sel.invert"></button>
      </div>
      <label class="row" data-i18n-title="tip.sel.through">
        <span data-i18n="sel.through"></span>
        <input type="checkbox" id="ed-through">
      </label>
      <div class="subhead" data-i18n="sel.filter"></div>
      <label class="row" data-i18n-title="tip.sel.type">
        <span data-i18n="sel.type"></span>
        <select id="ed-filterkind">
          <option value="" selected data-i18n="sel.anytype"></option>
          <option value="square" data-i18n="kind.square"></option>
          <option value="plane" data-i18n="kind.plane"></option>
          <option value="sphere" data-i18n="kind.sphere"></option>
          <option value="cylinder" data-i18n="kind.cylinder"></option>
          <option value="cone" data-i18n="kind.cone"></option>
          <option value="prism" data-i18n="kind.prism"></option>
          <option value="triangle" data-i18n="kind.triangle"></option>
        </select>
      </label>
      <div class="row" data-i18n-title="tip.sel.color">
        <span data-i18n="sel.color"></span>
        <input type="checkbox" id="ed-filteren">
        <input type="color" id="ed-filtercolor" value="#ffffff">
        <input type="number" id="ed-filtertol" value="40" min="0" max="200" step="10" data-i18n-title="tip.sel.tolerance">
      </div>
      <div class="btn-row">
        <button class="mini" id="sel-filter-select" data-i18n="sel.select" data-i18n-title="tip.sel.select"></button>
        <button class="mini" id="sel-filter-add" data-i18n="sel.add" data-i18n-title="tip.sel.add"></button>
        <button class="mini" id="sel-filter-sub" data-i18n="sel.remove" data-i18n-title="tip.sel.remove"></button>
      </div>
      <div class="subhead" data-i18n="sel.edit"></div>
      <div class="row" id="ed-colorrow" hidden data-i18n-title="tip.sel.editcolor">
        <span data-i18n="sel.color"></span>
        <input type="color" id="ed-selcolor" value="#ffffff">
      </div>
      <div id="ed-transform" hidden>
        <div class="row-triple" data-i18n-title="tip.sel.pos">
          <span data-i18n="sel.pos"></span>
          <input type="number" id="ed-px" step="0.5"><input type="number" id="ed-py" step="0.5"><input type="number" id="ed-pz" step="0.5">
        </div>
        <div class="row-triple" data-i18n-title="tip.sel.rot">
          <span data-i18n="sel.rot"></span>
          <input type="number" id="ed-rx" step="15"><input type="number" id="ed-ry" step="15"><input type="number" id="ed-rz" step="15">
        </div>
        <div class="row-triple" data-i18n-title="tip.sel.zoom">
          <span data-i18n="sel.zoom"></span>
          <input type="number" id="ed-zx" step="0.5"><input type="number" id="ed-zy" step="0.5"><input type="number" id="ed-zz" step="0.5">
        </div>
      </div>
      <div class="btn-row">
        <button class="mini" id="ed-dup" disabled data-i18n="sel.dup" data-i18n-title="tip.sel.dup"></button>
        <button class="mini danger" id="ed-delete" disabled data-i18n="sel.del" data-i18n-title="tip.sel.del"></button>
      </div>
      <div class="hint2" data-i18n="sel.hintshortcuts"></div>
    </details>

    <details class="panel" id="panel-stats" open>
      <summary data-i18n="panel.stats"></summary>
      <div id="edit-stats" class="stat-grid"></div>
      <div id="stat-warnings"></div>
    </details>

    <details class="panel" id="panel-optimize" open>
      <summary data-i18n="panel.optimize"></summary>
      <label class="row" data-i18n-title="tip.opt.tol">
        <span><span data-i18n="opt.tol"></span> <em id="v-opttol">0</em></span>
        <input type="range" id="opt-tol" min="0" max="100" value="0" step="1">
      </label>
      <button id="opt-merge" class="secondary" data-i18n="opt.merge" data-i18n-title="tip.opt.merge"></button>
      <button id="opt-hidden" class="secondary" data-i18n="opt.hidden" data-i18n-title="tip.opt.hidden"></button>
      <button id="opt-zfight" class="secondary" data-i18n="opt.zfight" data-i18n-title="tip.opt.zfight"></button>
      <div class="row" data-i18n-title="tip.opt.target">
        <span data-i18n="opt.target"></span>
        <input type="number" id="opt-target" value="999" min="1" step="1">
      </div>
      <button id="opt-reduce" class="secondary" data-i18n="opt.reduce"></button>
    </details>

    </div><!-- /rb-scroll -->

    <div id="rb-actions">
      <button id="ed-save" disabled data-i18n="save.edits" data-i18n-title="tip.save.edits"></button>
      ${
        primitives
          ? `
      <button id="btn-view-prims" disabled data-i18n="btn.viewprims"></button>
      <div id="output-summary" class="hint2"></div>`
          : `
      <label class="row" data-i18n-title="tip.out.collision">
        <span data-i18n="out.collision"></span>
        <input type="checkbox" id="p-collision" checked>
      </label>
      <label class="row" data-i18n-title="tip.out.autoasm">
        <span data-i18n="out.autoasm"></span>
        <input type="checkbox" id="p-autoasm">
      </label>
      <button id="btn-download" disabled data-i18n="btn.download"></button>`
      }
    </div>
  </aside>

  ${
    primitives
      ? `
  <div id="prim-modal" hidden>
    <div class="modal-box">
      <div class="modal-head">
        <h2 data-i18n="modal.title"></h2>
        <span id="prim-count" class="hint2"></span>
        <span class="modal-spacer"></span>
        <button id="btn-copy-json" class="small" data-i18n="modal.copyjson"></button>
        <button id="btn-close-modal" class="small" data-i18n-title="tip.modal.close">✕</button>
      </div>
      <div class="modal-sub" id="prim-note"></div>
      <div class="modal-body">
        <table id="prim-table">
          <thead>
            <tr>
              <th rowspan="2">✓</th>
              <th rowspan="2">#</th>
              <th rowspan="2" data-i18n="th.model"></th>
              <th rowspan="2" data-i18n="th.id"></th>
              <th rowspan="2" data-i18n="th.kind"></th>
              <th colspan="3" class="grp-start grp-head" data-i18n="th.pos"></th>
              <th colspan="3" class="grp-start grp-head" data-i18n="th.rot"></th>
              <th colspan="3" class="grp-start grp-head" data-i18n="th.zoom"></th>
              <th rowspan="2" class="grp-start" data-i18n="th.color"></th>
            </tr>
            <tr>
              <th class="grp-start sub">X</th><th class="sub">Y</th><th class="sub">Z</th>
              <th class="grp-start sub">X</th><th class="sub">Y</th><th class="sub">Z</th>
              <th class="grp-start sub">X</th><th class="sub">Y</th><th class="sub">Z</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        <button id="btn-more-rows" hidden></button>
      </div>
    </div>
  </div>`
      : ""
  }
</div>`;

  // ----- language selector -----
  const langSel = root.querySelector("#lang-select");
  if (langSel) {
    for (const l of LANGS) {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = l.name; // native names — never translated
      langSel.appendChild(o);
    }
    langSel.value = currentLang();
    langSel.addEventListener("change", () => setLanguage(langSel.value));
  }

  // fill in the active language (en renders synchronously)
  applyI18n(root);
  // dynamic bits that applyI18n cannot know the state of
  const vdec = root.querySelector("#v-decimate");
  if (vdec) vdec.textContent = t("val.off");
  const selinfo = root.querySelector("#ed-selinfo");
  if (selinfo) selinfo.textContent = t("sel.none");

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
