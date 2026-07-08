// Interactive editor: tools, selection, transform gizmos, history,
// clipboard, keyboard shortcuts, statistics, and optimization tools.
//
// The editor mutates the ACTIVE reconstruction's decoration array and asks
// the app to rebuild previews via ctx.rebuild(). It never touches file
// loading, conversion, or output — those stay in app.js; rendering stays in
// viewer.js; .gia writing stays in the engine.
//
// ctx = {
//   getRecon()            -> { id, msg, params } | null   (active reconstruction)
//   offsetOf(recon)       -> {x,y,z} | null               (display offset)
//   rebuild(light)        -> rebuild previews (light = during drags: skip
//                            heavyweight UI like stats/lists)
//   toast(text)
//   estimateSize(decs)    -> bytes | null                 (real .gia size)
//   budget()              -> max decoration budget (number)
//   getSourceObject()     -> THREE.Object3D | null        (for Place raycast)
// }

import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { History, cloneDecorations } from "./history.js";
import { IdPicker } from "./picking.js";
import {
  displayContext,
  decPosToDisplay,
  displayPosToDec,
  decQuatToDisplay,
  displayQuatToDec,
  clampZoom,
  r4,
  decRadius,
} from "./dec-transform.js";
import { computeEditorStats, formatBytes } from "./stats.js";
import { mergeAdjacent, reduceToTarget } from "./optimize.js";
import { buildPreview } from "../preview-mesh.js";
import { t, num } from "../i18n.js";

const GIZMO_MODES = { move: "translate", rotate: "rotate", scale: "scale" };

export function createEditor({ viewer, ctx }) {
  const $ = (id) => document.getElementById(id);
  const canvas = viewer.canvas;

  // ---------- state ----------
  let tool = "orbit";
  let space = "world";
  let snapOn = false;
  let ctrlHeld = false;
  const selection = new Set();
  const history = new History();
  let clipboard = [];
  const picker = new IdPicker(viewer.renderer);
  const raycaster = new THREE.Raycaster();
  let marquee = null;
  let gizmoDragging = false;
  let dragStart = null;
  let gizmoTarget = null; // "selection" | "model" | null
  let colorEditing = false;
  let focusPushedFor = null;
  let sizeTimer = 0;

  const recon = () => ctx.getRecon();
  const decs = () => recon()?.msg.decorations ?? [];
  const dctx = (e = recon()) => displayContext(e, ctx.offsetOf);
  const eulerOrder = (e = recon()) => (e?.params?.eulerOrder === "XYZ" ? "XYZ" : "YXZ");

  function pushHistory(label = "edit") {
    const e = recon();
    if (e) history.push(e.id, e.msg.decorations, label);
  }

  // ---------- gizmo ----------
  const gizmoProxy = new THREE.Object3D();
  viewer.scene.add(gizmoProxy);
  const gizmo = new TransformControls(viewer.camera, canvas);
  viewer.scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);
  gizmo.enabled = false;

  gizmo.addEventListener("dragging-changed", (ev) => {
    gizmoDragging = ev.value;
    viewer.controls.enabled = !ev.value;
    if (ev.value) beginGizmoDrag();
    else endGizmoDrag();
  });
  let gizmoRaf = 0;
  gizmo.addEventListener("objectChange", () => {
    if (!dragStart || gizmoRaf) return;
    gizmoRaf = requestAnimationFrame(() => {
      gizmoRaf = 0;
      applyGizmoDrag();
    });
  });

  function beginGizmoDrag() {
    if (gizmoTarget === "model") {
      dragStart = { model: true };
      return;
    }
    const e = recon();
    if (!e || !selection.size) return;
    pushHistory(tool);
    const c = dctx(e);
    dragStart = {
      pos: gizmoProxy.position.clone(),
      quat: gizmoProxy.quaternion.clone(),
      items: new Map(),
    };
    for (const i of selection) {
      const d = e.msg.decorations[i];
      dragStart.items.set(i, {
        pos: decPosToDisplay(d, c, new THREE.Vector3()),
        quat: decQuatToDisplay(d, c, new THREE.Quaternion()),
        zoom: { ...d.scale },
      });
    }
  }

  function endGizmoDrag() {
    if (!dragStart) return;
    const wasModel = dragStart.model;
    dragStart = null;
    if (wasModel) {
      syncGizmo();
      return;
    }
    ctx.rebuild(false);
    refreshSelectionUI();
    syncGizmo();
  }

  // gizmo drag on the BASE MODEL: write the display transform back into the
  // Transform section (pivot / rotation / scale), keeping both in sync
  function applyModelGizmoDrag() {
    // rotation: proxy quaternion -> YXZ Euler degrees
    const eul = new THREE.Euler().setFromQuaternion(gizmoProxy.quaternion, "YXZ");
    const DEG = 180 / Math.PI;
    const rotateDeg = {
      x: r4(eul.x * DEG),
      y: r4(eul.y * DEG),
      z: r4(eul.z * DEG),
    };
    // scale: keep uniform (average the axes, re-normalize the proxy)
    let s = (Math.abs(gizmoProxy.scale.x) + Math.abs(gizmoProxy.scale.y) + Math.abs(gizmoProxy.scale.z)) / 3;
    s = Math.min(10000, Math.max(0.0001, r4(s)));
    gizmoProxy.scale.setScalar(s);
    // pivot from the display position: pos = R * (-s * pivot)
    const v = gizmoProxy.position.clone();
    v.applyQuaternion(gizmoProxy.quaternion.clone().invert());
    const pivot = { x: r4(-v.x / s), y: r4(-v.y / s), z: r4(-v.z / s) };
    ctx.setModelTransform({ pivot, rotateDeg, scale: s });
  }

  function applyGizmoDrag() {
    if (dragStart?.model) {
      applyModelGizmoDrag();
      return;
    }
    const e = recon();
    if (!e || !dragStart) return;
    const c = dctx(e);
    const mode = GIZMO_MODES[tool];
    const v = new THREE.Vector3();
    if (mode === "translate") {
      const dp = gizmoProxy.position.clone().sub(dragStart.pos);
      for (const [i, s] of dragStart.items) {
        const d = e.msg.decorations[i];
        d.position = displayPosToDec(v.copy(s.pos).add(dp), c);
      }
    } else if (mode === "rotate") {
      const dq = gizmoProxy.quaternion.clone().multiply(dragStart.quat.clone().invert());
      const pivot = dragStart.pos;
      const q = new THREE.Quaternion();
      for (const [i, s] of dragStart.items) {
        const d = e.msg.decorations[i];
        v.copy(s.pos).sub(pivot).applyQuaternion(dq).add(pivot);
        d.position = displayPosToDec(v, c);
        d.rotationDeg = displayQuatToDec(q.copy(dq).multiply(s.quat), c);
      }
    } else if (mode === "scale") {
      // proxy scale started at (1,1,1): its value IS the factor, expressed
      // along the proxy's local axes
      const f = gizmoProxy.scale;
      const invProxy = dragStart.quat.clone().invert();
      const m = new THREE.Matrix4();
      const rel = new THREE.Quaternion();
      for (const [i, s] of dragStart.items) {
        const d = e.msg.decorations[i];
        // scale position about the pivot in the proxy frame
        v.copy(s.pos).sub(dragStart.pos).applyQuaternion(invProxy);
        v.set(v.x * f.x, v.y * f.y, v.z * f.z);
        v.applyQuaternion(dragStart.quat).add(dragStart.pos);
        d.position = displayPosToDec(v, c);
        // per-axis factor mapped into the decoration's local frame:
        // exact when the axes align (single selection / axis-aligned)
        rel.copy(invProxy).multiply(s.quat);
        m.makeRotationFromQuaternion(rel);
        const me = m.elements; // column-major
        const fl = [0, 0, 0];
        for (let j = 0; j < 3; j++) {
          const cx = me[j * 4] * f.x;
          const cy = me[j * 4 + 1] * f.y;
          const cz = me[j * 4 + 2] * f.z;
          fl[j] = Math.sqrt(cx * cx + cy * cy + cz * cz);
        }
        d.scale.x = clampZoom(s.zoom.x * fl[0]);
        d.scale.y = clampZoom(s.zoom.y * fl[1]);
        d.scale.z = clampZoom(s.zoom.z * fl[2]);
      }
    }
    ctx.rebuild(true);
    updateSelectionMesh();
    refreshTransformInputs();
  }

  const hasModel = () => !!ctx.getSourceObject?.();

  function syncGizmo() {
    if (gizmoDragging) return; // the drag owns the proxy
    const e = recon();
    const mode = GIZMO_MODES[tool];
    gizmoTarget = null;
    if (!mode || (selection.size === 0 && !hasModel()) || (!e && !hasModel())) {
      gizmo.detach();
      gizmo.enabled = false;
      return;
    }
    if (!e || selection.size === 0) {
      // no primitive selection: the gizmo manipulates the BASE MODEL and
      // stays in sync with the Transform section
      const mt = ctx.getModelTransform();
      const s = mt.scale || 1;
      const RAD = Math.PI / 180;
      const eul = new THREE.Euler(
        (mt.rotateDeg?.x ?? 0) * RAD,
        (mt.rotateDeg?.y ?? 0) * RAD,
        (mt.rotateDeg?.z ?? 0) * RAD,
        "YXZ",
      );
      gizmoProxy.quaternion.setFromEuler(eul);
      const p = new THREE.Vector3(
        -s * (mt.pivot?.x ?? 0),
        -s * (mt.pivot?.y ?? 0),
        -s * (mt.pivot?.z ?? 0),
      ).applyEuler(eul);
      gizmoProxy.position.copy(p);
      gizmoProxy.scale.setScalar(s);
      gizmoProxy.updateMatrixWorld(true);
      gizmo.attach(gizmoProxy);
      gizmo.enabled = true;
      gizmo.setMode(mode);
      gizmo.setSpace(space);
      applySnap();
      gizmoTarget = "model";
      return;
    }
    gizmoTarget = "selection";
    const c = dctx(e);
    const centroid = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (const i of selection) centroid.add(decPosToDisplay(e.msg.decorations[i], c, v));
    centroid.divideScalar(selection.size);
    gizmoProxy.position.copy(centroid);
    if (selection.size === 1) {
      const d = e.msg.decorations[[...selection][0]];
      decQuatToDisplay(d, c, gizmoProxy.quaternion);
    } else {
      gizmoProxy.quaternion.identity();
    }
    gizmoProxy.scale.set(1, 1, 1);
    gizmoProxy.updateMatrixWorld(true);
    gizmo.attach(gizmoProxy);
    gizmo.enabled = true;
    gizmo.setMode(mode);
    gizmo.setSpace(space);
    applySnap();
  }

  function applySnap() {
    const on = snapOn !== ctrlHeld; // Ctrl temporarily inverts
    const step = Math.max(0.01, parseFloat($("tb-snapstep").value) || 1);
    gizmo.setTranslationSnap(on ? step / 10 : null); // dec units -> meters
    gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
    gizmo.setScaleSnap(on ? 0.1 : null);
  }

  // ---------- tools ----------
  function setTool(t) {
    // Select/Place need a reconstruction; Move/Rotate/Scale also work on the
    // base model when nothing is generated yet
    const needsRecon = t === "select" || t === "place";
    if ((needsRecon && !recon()) || (t !== "orbit" && !recon() && !hasModel())) {
      t = "orbit";
    }
    tool = t;
    for (const b of document.querySelectorAll("#tb-tools .tb-btn")) {
      b.classList.toggle("active", b.dataset.tool === t);
    }
    $("tb-place").hidden = t !== "place";
    const editing = t !== "orbit";
    const mb = viewer.controls.mouseButtons;
    if (editing) {
      mb.LEFT = null;
      mb.MIDDLE = THREE.MOUSE.PAN;
      mb.RIGHT = THREE.MOUSE.ROTATE;
    } else {
      mb.LEFT = THREE.MOUSE.ROTATE;
      mb.MIDDLE = THREE.MOUSE.DOLLY;
      mb.RIGHT = THREE.MOUSE.PAN;
    }
    canvas.style.cursor = t === "place" ? "crosshair" : "";
    syncGizmo();
  }

  for (const b of document.querySelectorAll("#tb-tools .tb-btn")) {
    b.addEventListener("click", () => setTool(b.dataset.tool));
  }

  $("tb-space").addEventListener("click", () => {
    space = space === "world" ? "local" : "world";
    $("tb-space").textContent = t(space === "world" ? "tb.world" : "tb.local");
    gizmo.setSpace(space);
  });
  $("tb-snap").addEventListener("click", () => {
    snapOn = !snapOn;
    $("tb-snap").classList.toggle("pressed", snapOn);
    applySnap();
  });
  $("tb-snapstep").addEventListener("input", applySnap);
  $("tb-focus").addEventListener("click", focusSelection);

  const wireToggle = (id, fn) => {
    const b = $(id);
    b.addEventListener("click", () => {
      b.classList.toggle("pressed");
      fn(b.classList.contains("pressed"));
    });
  };
  wireToggle("tb-model", (v) => viewer.setModelVisible(v));
  wireToggle("tb-grid", (v) => viewer.setHelpers({ grid: v }));
  wireToggle("tb-axes", (v) => viewer.setHelpers({ axes: v }));

  function updateToolAvailability() {
    const hasRecon = !!recon();
    const model = hasModel();
    for (const b of document.querySelectorAll("#tb-tools .tb-btn")) {
      const t = b.dataset.tool;
      if (t === "orbit") continue;
      b.disabled = t === "select" || t === "place" ? !hasRecon : !hasRecon && !model;
    }
    const needsRecon = tool === "select" || tool === "place";
    if ((needsRecon && !hasRecon) || (tool !== "orbit" && !hasRecon && !model)) {
      setTool("orbit");
    }
  }

  // ---------- pointer interaction (click / marquee / place) ----------
  const canvasXY = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top, w: r.width, h: r.height };
  };

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || tool === "orbit" || gizmoDragging || !recon()) return;
    if (tool === "place") {
      placeAt(ev);
      return;
    }
    marquee = {
      x0: ev.clientX,
      y0: ev.clientY,
      el: null,
      moved: false,
      add: ev.shiftKey,
      sub: ev.ctrlKey || ev.metaKey,
    };
  });
  window.addEventListener("pointermove", (ev) => {
    if (!marquee) return;
    const dx = ev.clientX - marquee.x0;
    const dy = ev.clientY - marquee.y0;
    if (!marquee.moved && Math.hypot(dx, dy) < 5) return;
    marquee.moved = true;
    if (!marquee.el) {
      marquee.el = document.createElement("div");
      marquee.el.id = "marquee";
      document.body.appendChild(marquee.el);
    }
    Object.assign(marquee.el.style, {
      left: Math.min(marquee.x0, ev.clientX) + "px",
      top: Math.min(marquee.y0, ev.clientY) + "px",
      width: Math.abs(dx) + "px",
      height: Math.abs(dy) + "px",
    });
  });
  window.addEventListener("pointerup", (ev) => {
    if (!marquee) return;
    const m = marquee;
    marquee = null;
    m.el?.remove();
    if (!recon()) return;
    if (!m.moved) clickSelect(ev);
    else boxSelect(m, ev);
  });

  function clickSelect(ev) {
    const { x, y, w, h } = canvasXY(ev);
    const idx = picker.hasGeometry ? picker.pickAt(viewer.camera, x, y, w, h) : -1;
    if (ev.shiftKey) {
      if (idx >= 0) selection.add(idx);
    } else if (ev.ctrlKey || ev.metaKey) {
      if (idx >= 0) {
        if (selection.has(idx)) selection.delete(idx);
        else selection.add(idx);
      }
    } else {
      selection.clear();
      if (idx >= 0) selection.add(idx);
    }
    onSelectionChanged();
  }

  function filterActive() {
    return !!$("ed-filterkind").value || $("ed-filteren").checked;
  }

  function matchesFilter(d) {
    const kind = $("ed-filterkind").value;
    if (kind && d.kind !== kind) return false;
    if ($("ed-filteren").checked) {
      const fc = $("ed-filtercolor").value;
      const fr = parseInt(fc.slice(1, 3), 16);
      const fg = parseInt(fc.slice(3, 5), 16);
      const fb = parseInt(fc.slice(5, 7), 16);
      const tol = parseFloat($("ed-filtertol").value) || 40;
      const dr = ((d.color >> 16) & 255) - fr;
      const dg = ((d.color >> 8) & 255) - fg;
      const db = (d.color & 255) - fb;
      if (Math.sqrt(dr * dr + dg * dg + db * db) > tol) return false;
    }
    return true;
  }

  function boxSelect(m, ev) {
    const e = recon();
    if (!e) return;
    const r = canvas.getBoundingClientRect();
    const x0 = Math.min(m.x0, ev.clientX) - r.left;
    const y0 = Math.min(m.y0, ev.clientY) - r.top;
    const x1 = Math.max(m.x0, ev.clientX) - r.left;
    const y1 = Math.max(m.y0, ev.clientY) - r.top;

    let found;
    if ($("ed-through").checked || !picker.hasGeometry) {
      // select-through: primitives whose center projects into the rectangle
      found = new Set();
      const c = dctx(e);
      const v = new THREE.Vector3();
      const nx0 = (x0 / r.width) * 2 - 1;
      const nx1 = (x1 / r.width) * 2 - 1;
      const ny0 = -(y1 / r.height) * 2 + 1;
      const ny1 = -(y0 / r.height) * 2 + 1;
      for (let i = 0; i < e.msg.decorations.length; i++) {
        decPosToDisplay(e.msg.decorations[i], c, v).project(viewer.camera);
        if (v.z > 1 || v.x < nx0 || v.x > nx1 || v.y < ny0 || v.y > ny1) continue;
        found.add(i);
      }
    } else {
      // visible-only: GPU ID buffer resolves occlusion pixel-exactly
      found = picker.ownersInRect(viewer.camera, x0, y0, x1, y1, r.width, r.height);
    }
    if (filterActive()) {
      for (const i of [...found]) {
        if (!matchesFilter(e.msg.decorations[i])) found.delete(i);
      }
    }
    if (m.sub) for (const i of found) selection.delete(i);
    else {
      if (!m.add) selection.clear();
      for (const i of found) selection.add(i);
    }
    onSelectionChanged();
  }

  function placeAt(ev) {
    const e = recon();
    if (!e) return;
    const { x, y, w, h } = canvasXY(ev);
    raycaster.setFromCamera(
      new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1),
      viewer.camera,
    );
    const targets = [];
    const src = ctx.getSourceObject();
    if (src && viewer.modelGroup.visible) targets.push(src);
    if (picker.mesh) targets.push(picker.mesh);
    const hit = raycaster.intersectObjects(targets, true)[0];
    if (!hit) return;
    const c = dctx(e);
    const p = displayPosToDec(hit.point, c);
    const s = Math.max(0.01, parseFloat($("ed-size").value) || 0.5);
    const kind = $("ed-kind").value;
    const color = parseInt($("ed-color").value.slice(1), 16);
    const scale =
      kind === "triangle"
        ? {
            x: 0.01,
            y: Math.round((s * 100) / 13 * 1e6) / 1e6,
            z: Math.round((s * 100) / 27 * 1e6) / 1e6,
          }
        : kind === "plane"
          ? { x: s * 10, y: 1, z: s * 10 }
          : kind === "prism"
            ? { x: r4(s / 0.075), y: s * 10, z: r4(s / 0.075) }
            : { x: s * 10, y: s * 10, z: s * 10 };
    pushHistory("place");
    e.msg.decorations.push({
      kind,
      position: p,
      rotationDeg: { x: 0, y: 0, z: 0 },
      scale,
      color,
    });
    ctx.rebuild(false);
    setSelection([e.msg.decorations.length - 1]);
  }

  // ---------- selection management ----------
  function setSelection(iter) {
    selection.clear();
    for (const i of iter) selection.add(i);
    onSelectionChanged();
  }

  function onSelectionChanged() {
    refreshSelectionUI();
    updateSelectionMesh();
    syncGizmo();
  }

  function updateSelectionMesh() {
    const e = recon();
    if (!e || !selection.size) {
      viewer.setSelection(null);
      return;
    }
    const subset = [...selection]
      .filter((i) => i < e.msg.decorations.length)
      .map((i) => e.msg.decorations[i]);
    const { positions } = buildPreview(subset, e.params);
    viewer.setSelection(positions, ctx.offsetOf(e));
  }

  function selectAll() {
    const e = recon();
    if (!e) return;
    setSelection(e.msg.decorations.map((_, i) => i));
  }
  function deselectAll() {
    if (!selection.size) return;
    selection.clear();
    onSelectionChanged();
  }
  function invertSelection() {
    const e = recon();
    if (!e) return;
    const next = [];
    for (let i = 0; i < e.msg.decorations.length; i++) {
      if (!selection.has(i)) next.push(i);
    }
    setSelection(next);
  }
  function selectByFilter(op) {
    const e = recon();
    if (!e) return;
    for (let i = 0; i < e.msg.decorations.length; i++) {
      if (!matchesFilter(e.msg.decorations[i])) continue;
      if (op === "sub") selection.delete(i);
      else selection.add(i);
    }
    if (op === "select") {
      const keep = new Set(
        [...selection].filter((i) => matchesFilter(e.msg.decorations[i])),
      );
      selection.clear();
      for (const i of keep) selection.add(i);
    }
    onSelectionChanged();
  }

  $("sel-all").addEventListener("click", selectAll);
  $("sel-none").addEventListener("click", deselectAll);
  $("sel-invert").addEventListener("click", invertSelection);
  $("sel-filter-select").addEventListener("click", () => selectByFilter("select"));
  $("sel-filter-add").addEventListener("click", () => selectByFilter("add"));
  $("sel-filter-sub").addEventListener("click", () => selectByFilter("sub"));

  // ---------- editing actions ----------
  function deleteSelected() {
    const e = recon();
    if (!e || !selection.size) return;
    pushHistory("delete");
    const n = selection.size;
    e.msg.decorations = e.msg.decorations.filter((_, i) => !selection.has(i));
    selection.clear();
    ctx.rebuild(false);
    ctx.toast(t("t.deleted", { n: num(n) }));
  }

  function duplicateSelected(fromClipboard = false) {
    const e = recon();
    if (!e) return;
    const src = fromClipboard
      ? clipboard
      : [...selection].map((i) => e.msg.decorations[i]);
    if (!src.length) return;
    pushHistory(fromClipboard ? "paste" : "duplicate");
    const base = e.msg.decorations.length;
    e.msg.decorations.push(...cloneDecorations(src));
    ctx.rebuild(false);
    setSelection(src.map((_, k) => base + k));
    ctx.toast(t(fromClipboard ? "t.pasted" : "t.duplicated", { n: num(src.length) }));
  }

  function copySelection() {
    const e = recon();
    if (!e || !selection.size) return;
    clipboard = cloneDecorations([...selection].map((i) => e.msg.decorations[i]));
    ctx.toast(t("t.copiedn", { n: num(clipboard.length) }));
  }

  function undo() {
    const e = recon();
    if (!e) return;
    const restored = history.undo(e.id, e.msg.decorations);
    if (!restored) return;
    e.msg.decorations = restored;
    selection.clear();
    ctx.rebuild(false);
    ctx.toast(t("t.undone"));
  }
  function redo() {
    const e = recon();
    if (!e) return;
    const restored = history.redo(e.id, e.msg.decorations);
    if (!restored) return;
    e.msg.decorations = restored;
    selection.clear();
    ctx.rebuild(false);
    ctx.toast(t("t.redone"));
  }

  $("ed-delete").addEventListener("click", deleteSelected);
  $("ed-dup").addEventListener("click", () => duplicateSelected(false));

  // color picker: live preview while dragging, one history entry per edit
  $("ed-selcolor").addEventListener("input", () => {
    const e = recon();
    if (!e || !selection.size) return;
    if (!colorEditing) {
      pushHistory("color");
      colorEditing = true;
    }
    const color = parseInt($("ed-selcolor").value.slice(1), 16);
    for (const i of selection) e.msg.decorations[i].color = color;
    ctx.rebuild(true);
    updateSelectionMesh();
  });
  $("ed-selcolor").addEventListener("change", () => {
    colorEditing = false;
    if (recon() && selection.size) ctx.rebuild(false);
  });

  // ---------- numeric transform editing ----------
  const centroidDec = (e) => {
    const c = { x: 0, y: 0, z: 0 };
    for (const i of selection) {
      const p = e.msg.decorations[i].position;
      c.x += p.x;
      c.y += p.y;
      c.z += p.z;
    }
    const n = Math.max(1, selection.size);
    c.x = r4(c.x / n);
    c.y = r4(c.y / n);
    c.z = r4(c.z / n);
    return c;
  };

  const NUMERIC = [
    ["ed-px", "pos", "x"], ["ed-py", "pos", "y"], ["ed-pz", "pos", "z"],
    ["ed-rx", "rot", "x"], ["ed-ry", "rot", "y"], ["ed-rz", "rot", "z"],
    ["ed-zx", "zoom", "x"], ["ed-zy", "zoom", "y"], ["ed-zz", "zoom", "z"],
  ];
  for (const [id, group, axis] of NUMERIC) {
    const el = $(id);
    el.addEventListener("focus", () => {
      if (focusPushedFor !== id) {
        pushHistory("transform");
        focusPushedFor = id;
      }
    });
    el.addEventListener("blur", () => {
      if (focusPushedFor === id) focusPushedFor = null;
    });
    el.addEventListener("input", () => {
      const e = recon();
      if (!e || !selection.size) return;
      const val = parseFloat(el.value);
      if (!Number.isFinite(val)) return;
      if (group === "pos") {
        if (selection.size === 1) {
          e.msg.decorations[[...selection][0]].position[axis] = val;
        } else {
          const delta = val - centroidDec(e)[axis];
          for (const i of selection) {
            const p = e.msg.decorations[i].position;
            p[axis] = r4(p[axis] + delta);
          }
        }
      } else if (selection.size === 1) {
        const d = e.msg.decorations[[...selection][0]];
        if (group === "rot") d.rotationDeg[axis] = val;
        else d.scale[axis] = clampZoom(val);
      }
      ctx.rebuild(true);
      updateSelectionMesh();
      syncGizmo();
    });
    el.addEventListener("change", () => ctx.rebuild(false));
  }

  function refreshTransformInputs() {
    const e = recon();
    const n = selection.size;
    $("ed-transform").hidden = !e || n === 0;
    if (!e || n === 0) return;
    const single = n === 1 ? e.msg.decorations[[...selection][0]] : null;
    const set = (id, v) => {
      const el = $(id);
      if (document.activeElement !== el) el.value = v;
    };
    if (single) {
      set("ed-px", single.position.x); set("ed-py", single.position.y); set("ed-pz", single.position.z);
      set("ed-rx", single.rotationDeg.x); set("ed-ry", single.rotationDeg.y); set("ed-rz", single.rotationDeg.z);
      set("ed-zx", single.scale.x); set("ed-zy", single.scale.y); set("ed-zz", single.scale.z);
    } else {
      const c = centroidDec(e);
      set("ed-px", c.x); set("ed-py", c.y); set("ed-pz", c.z);
      for (const id of ["ed-rx", "ed-ry", "ed-rz", "ed-zx", "ed-zy", "ed-zz"]) set(id, "");
    }
    for (const id of ["ed-rx", "ed-ry", "ed-rz", "ed-zx", "ed-zy", "ed-zz"]) {
      $(id).disabled = !single;
    }
  }

  function refreshSelectionUI() {
    const e = recon();
    const n = selection.size;
    let text = t("sel.none");
    if (e && n === 1) {
      const idx = [...selection][0];
      const d = e.msg.decorations[idx];
      text = t("si.one", { kind: t("kind." + (d?.kind ?? "triangle")), n: idx + 1 });
    } else if (e && n > 1) {
      const kinds = new Set([...selection].map((i) => e.msg.decorations[i]?.kind));
      text = t("si.many", {
        n: num(n),
        kinds:
          kinds.size === 1
            ? t("kind." + [...kinds][0])
            : t("si.types", { n: num(kinds.size) }),
      });
    }
    $("ed-selinfo").textContent = text;
    $("ed-delete").disabled = n === 0;
    $("ed-delete").textContent = n ? t("sel.deln", { n: num(n) }) : t("sel.del");
    $("ed-dup").disabled = n === 0;
    $("ed-colorrow").hidden = n === 0;
    if (e && n) {
      const d = e.msg.decorations[[...selection][0]];
      if (document.activeElement !== $("ed-selcolor")) {
        $("ed-selcolor").value = "#" + d.color.toString(16).padStart(6, "0");
      }
    }
    refreshTransformInputs();
    $("st-sel").textContent = n ? t("st.sel", { n: num(n) }) : "";
  }

  // ---------- focus ----------
  function focusSelection() {
    const e = recon();
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    if (e && e.msg.decorations.length) {
      const c = dctx(e);
      const idxs = selection.size
        ? [...selection]
        : e.msg.decorations.map((_, i) => i);
      for (const i of idxs) {
        const d = e.msg.decorations[i];
        if (!d) continue;
        decPosToDisplay(d, c, v);
        const r = decRadius(d);
        box.expandByPoint(v.clone().addScalar(-r));
        box.expandByPoint(v.clone().addScalar(r));
      }
    } else if (viewer.modelGroup.children.length) {
      box.setFromObject(viewer.modelGroup);
    }
    viewer.focusOn(box);
  }

  // ---------- keyboard shortcuts ----------
  const isTyping = (ev) => {
    const t = ev.target;
    const a = document.activeElement;
    const like = (el) =>
      el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    return like(t) || like(a);
  };

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Control") {
      ctrlHeld = true;
      applySnap();
    }
    if (isTyping(ev)) return;
    const e = recon();
    const k = ev.key.toLowerCase();
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod) {
      if (!e) return;
      if (k === "z") {
        ev.preventDefault();
        ev.shiftKey ? redo() : undo();
      } else if (k === "y") {
        ev.preventDefault();
        redo();
      } else if (k === "a") {
        ev.preventDefault();
        selectAll();
      } else if (k === "i") {
        ev.preventDefault();
        invertSelection();
      } else if (k === "c") {
        ev.preventDefault();
        copySelection();
      } else if (k === "v") {
        ev.preventDefault();
        duplicateSelected(true);
      } else if (k === "d") {
        ev.preventDefault();
        duplicateSelected(false);
      }
      return;
    }
    if (ev.altKey) {
      if (k === "a") {
        ev.preventDefault();
        deselectAll();
      }
      return;
    }
    switch (k) {
      case "q": if (e) setTool("select"); break;
      case "w": if (e || hasModel()) setTool("move"); break;
      case "e": if (e || hasModel()) setTool("rotate"); break;
      case "r": if (e || hasModel()) setTool("scale"); break;
      case "t": if (e) setTool("place"); break;
      case " ": {
        // Space cycles the gizmo: Move -> Rotate -> Scale -> Move ...
        if (!e && !hasModel()) break;
        ev.preventDefault();
        const order = ["move", "rotate", "scale"];
        const idx = order.indexOf(tool);
        setTool(order[(idx + 1) % order.length]);
        break;
      }
      case "escape":
        if (marquee) {
          marquee.el?.remove();
          marquee = null;
        } else if (selection.size) deselectAll();
        else setTool("orbit");
        break;
      case "f": focusSelection(); break;
      case "g": $("tb-grid").click(); break;
      case "x": $("tb-space").click(); break;
      case "delete":
      case "backspace":
        if (e && selection.size) {
          ev.preventDefault();
          deleteSelected();
        }
        break;
    }
  });
  window.addEventListener("keyup", (ev) => {
    if (ev.key === "Control") {
      ctrlHeld = false;
      applySnap();
    }
  });

  // ---------- statistics ----------
  function refreshStats() {
    const e = recon();
    const grid = $("edit-stats");
    const warnEl = $("stat-warnings");
    $("scene-empty").hidden = !!e;
    if (!e) {
      grid.innerHTML = "";
      warnEl.innerHTML = "";
      for (const id of ["st-decs", "st-models", "st-size", "st-warn"]) $(id).textContent = "";
      return;
    }
    const s = computeEditorStats(e.msg.decorations, { budget: ctx.budget() });
    const warnings = s.warnings.map((w) => t(w.key, w.params));
    const rows = [[t("es.decs"), num(s.count)]];
    if (s.models > 1) rows.push([t("es.permodel"), s.perModel]);
    for (const [kind, n] of Object.entries(s.byKind).sort((a, b) => b[1] - a[1])) {
      rows.push([t("kind." + kind), num(n)]);
    }
    rows.push([t("es.colors"), num(s.uniqueColors)]);
    rows.push([t("es.models"), num(s.models)]);
    rows.push([t("es.size"), `<span id="stat-size-v">…</span>`]);
    grid.innerHTML = rows
      .map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`)
      .join("");
    warnEl.innerHTML = warnings
      .map((w) => `<div class="warn-row">⚠ <span>${w}</span></div>`)
      .join("");

    $("st-decs").textContent = t("st.decs", { n: num(s.count) });
    $("st-models").textContent = s.models > 1 ? t("st.models", { n: num(s.models) }) : "";
    $("st-warn").textContent = warnings.length
      ? `⚠ ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1})` : ""}`
      : "";

    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      const bytes = ctx.estimateSize(e.msg.decorations);
      const label = bytes != null ? "≈ " + formatBytes(bytes) : "—";
      const el = document.getElementById("stat-size-v");
      if (el) el.textContent = label;
      $("st-size").textContent = bytes != null ? "≈ " + formatBytes(bytes) : "";
    }, 250);
  }

  // ---------- optimization tools ----------
  $("opt-tol").addEventListener("input", () => {
    $("v-opttol").textContent = $("opt-tol").value;
  });
  $("opt-merge").addEventListener("click", () => {
    const e = recon();
    if (!e) return;
    pushHistory("merge");
    const res = mergeAdjacent(e.msg.decorations, {
      colorTolerance: parseFloat($("opt-tol").value) || 0,
      eulerOrder: eulerOrder(e),
    });
    e.msg.decorations = res.decorations;
    selection.clear();
    ctx.rebuild(false);
    ctx.toast(res.merged > 0 ? t("t.merged", { n: num(res.merged) }) : t("t.nomerge"));
  });
  $("opt-hidden").addEventListener("click", () => {
    const e = recon();
    if (!e || !picker.hasGeometry) return;
    picker.mesh.geometry.computeBoundingSphere();
    const bs = picker.mesh.geometry.boundingSphere;
    const center = bs.center.clone().add(picker.mesh.position);
    const visible = picker.visibleFromAround(center, Math.max(bs.radius, 0.1));
    const total = e.msg.decorations.length;
    if (visible.size >= total) {
      ctx.toast(t("t.nohidden"));
      return;
    }
    pushHistory("remove hidden");
    e.msg.decorations = e.msg.decorations.filter((_, i) => visible.has(i));
    selection.clear();
    ctx.rebuild(false);
    ctx.toast(t("t.removedhidden", { n: num(total - visible.size) }));
  });
  $("opt-reduce").addEventListener("click", () => {
    const e = recon();
    if (!e) return;
    const target = Math.max(1, parseInt($("opt-target").value, 10) || 999);
    if (e.msg.decorations.length <= target) {
      ctx.toast(t("t.attarget"));
      return;
    }
    pushHistory("reduce");
    const res = reduceToTarget(e.msg.decorations, target, { eulerOrder: eulerOrder(e) });
    e.msg.decorations = res.decorations;
    selection.clear();
    ctx.rebuild(false);
    ctx.toast(t("t.reduced", { m: num(res.merged), d: num(res.dropped) }));
  });

  // ---------- app-facing API ----------
  function refresh() {
    const e = recon();
    if (e && e.msg.positions) {
      picker.setGeometry(e.msg.positions, e.msg.owners, ctx.offsetOf(e));
    } else {
      picker.clearGeometry();
    }
    const n = e ? e.msg.decorations.length : 0;
    for (const i of [...selection]) if (i >= n) selection.delete(i);
    // language-dependent toolbar state (data-i18n would reset it to World)
    $("tb-space").textContent = t(space === "world" ? "tb.world" : "tb.local");
    updateToolAvailability();
    refreshSelectionUI();
    updateSelectionMesh();
    syncGizmo();
    refreshStats();
  }

  return {
    refresh,
    // light = mid-drag rebuild: geometry only, everything heavy deferred
    onRebuilt(light) {
      if (light) return;
      refresh();
    },
    onReconChanged() {
      selection.clear();
      refresh();
    },
    onGenerated() {
      if (tool === "orbit") setTool("select");
    },
    // Transform-section inputs changed: keep the model gizmo in sync
    onModelTransformChanged() {
      if (!gizmoDragging && gizmoTarget === "model") syncGizmo();
    },
    // the viewer switched between perspective and orthographic cameras
    onCameraChanged(cam) {
      gizmo.camera = cam;
      if (!gizmoDragging) syncGizmo();
    },
    setTool,
    focusSelection,
    get selectionSize() {
      return selection.size;
    },
  };
}
