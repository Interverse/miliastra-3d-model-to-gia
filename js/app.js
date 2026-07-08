// App wiring: file loading, parameters, worker dispatch, stats, download.
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { TGALoader } from "three/addons/loaders/TGALoader.js";
import { Viewer } from "./viewer.js";
import { createEditor } from "./editor/editor.js";
import { createNavGizmo } from "./nav-gizmo.js";
import { KIND_LABELS, formatBytes } from "./editor/stats.js";
import { extractMeshes } from "./extract.js";
import { setupTexturePanel } from "./texture-tools.js";
import { buildPreview } from "./preview-mesh.js";
import {
  buildGia,
  splitIntoModels,
  MAX_DECORATIONS_PER_MODEL,
  PRIMITIVE_MODEL_IDS,
} from "../engine/gia/gia-writer.js";
import { PRESETS } from "../engine/convert/converter.js";
import { decimateTriangles } from "../engine/convert/decimate.js";
import { t, num, onLangChange } from "./i18n.js";

// Initialize the app against an already-rendered shell (see ui-shell.js).
// mode: 'gia' (download button builds a .gia file) or 'primitives' (the
// generated primitive records are displayed instead; no download).
export function initApp({ mode = "gia" } = {}) {
  const $ = (id) => document.getElementById(id);
  const viewer = new Viewer($("canvas"));
  // texture edits sync straight onto the viewport materials
  const texPanel = setupTexturePanel($, (textureObj) => {
    for (const t of extracted?.textures ?? []) {
      if (t.texture !== textureObj || !t.material?.map) continue;
      const cv = document.createElement("canvas");
      cv.width = textureObj.width;
      cv.height = textureObj.height;
      cv.getContext("2d").putImageData(
        new ImageData(new Uint8ClampedArray(textureObj.data), textureObj.width, textureObj.height),
        0, 0,
      );
      t.material.map.image = cv;
      t.material.map.needsUpdate = true;
    }
  });
  const worker = new Worker(new URL("./convert-worker.js", import.meta.url), {
    type: "module",
  });

  // Interactive editor (tools, selection, gizmos, history, optimization) —
  // see js/editor/. It mutates the active reconstruction's decorations and
  // calls rebuildActiveRecon() through this context object.
  const editor = createEditor({
    viewer,
    ctx: {
      getRecon: () => activeRecon(),
      // decorations display at their true exported coordinates (the model
      // preview shifts instead) — see updateOverlays
      offsetOf: () => null,
      rebuild: (light) => rebuildActiveRecon(light),
      toast: (t) => showToast(t),
      budget: () => Math.max(1, parseInt($("p-max").value, 10) || 4995),
      getSourceObject: () => displayedObject,
      // base-model transform <-> gizmo sync
      getModelTransform: () => ({
        ...readUserTransform(),
        unitScale: parseFloat($("p-unit").value) || 1,
      }),
      setModelTransform: ({ pivot, rotateDeg, scale }) => {
        const set = (id, v) => {
          $(id).value = Math.round(v * 10000) / 10000;
        };
        if (pivot) {
          set("t-px", pivot.x);
          set("t-py", pivot.y);
          set("t-pz", pivot.z);
        }
        if (rotateDeg) {
          set("t-rx", rotateDeg.x);
          set("t-ry", rotateDeg.y);
          set("t-rz", rotateDeg.z);
        }
        if (scale != null) set("t-scale", scale);
        applyUserTransformPreview(false);
      },
      estimateSize: (decorations) => {
        try {
          if (!decorations.length) return null;
          return buildGia({
            models: splitIntoModels(currentName, decorations),
            exportName: currentName,
            collision: $("p-collision")?.checked ?? true,
            autoAssemble: $("p-autoasm")?.checked ?? false,
          }).length;
        } catch {
          return null;
        }
      },
    },
  });

  let currentObject = null; // three.js object
  let currentName = "model";
  let modelInfo = null; // raw data behind the "1. Model" stat grid
  let extracted = null; // { meshes, triangleCount }
  let lastResult = null; // worker result
  let lastParams = null; // params used for lastResult
  let jobId = 0;
  let busy = false;

  // ---------- file loading ----------

  const fileInput = $("file-input");
  const filedrop = $("filedrop");
  fileInput.addEventListener("change", () => loadFiles([...fileInput.files]));
  for (const evt of ["dragover", "dragleave", "drop"]) {
    document.body.addEventListener(evt, (e) => {
      e.preventDefault();
      filedrop.classList.toggle("dragover", evt === "dragover");
      if (evt === "drop") loadFiles([...e.dataTransfer.files]);
    });
  }

  // Persistent file library: models, .mtl, and textures accumulate across
  // uploads (keyed by lower-case basename), so textures can arrive before or
  // after the model. Every upload re-resolves the current model against it.
  const MODEL_RE = /\.(fbx|obj|glb|gltf|stl)$/i;
  const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tga)$/i;
  const PASTE_RE = /\.(fbx|obj|glb|gltf|stl|mtl|png|jpe?g|webp|bmp|gif|tga)$/i;

  // ---------- clipboard import (Ctrl+V anywhere on the page) ----------
  // Pasted files route through loadFiles(), which already dispatches to the
  // right workflow: models load, textures stage/apply, and a lone image
  // enables the 3D-sprite path.
  const isTextEntry = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT")
      return !["checkbox", "radio", "range", "color", "file", "button"].includes(el.type);
    return false;
  };

  window.addEventListener("paste", (ev) => {
    if (isTextEntry(ev.target) || isTextEntry(document.activeElement)) return;
    // the editor's internal primitive paste (copied primitives) takes
    // priority — its keydown handler flags the event just before this fires
    if (performance.now() - (window.__giaInternalPaste ?? -1e9) < 400) return;
    const dt = ev.clipboardData;
    if (!dt || !dt.files.length) return; // plain text etc. — ignore
    // raw image data (a copied screenshot) arrives with a generic name; give
    // each a unique one so repeated pastes don't overwrite library entries
    const files = [...dt.files].map((f, i) => {
      if (!f.name || /^image\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name)) {
        const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
        return new File([f], `clipboard-${Date.now()}-${i + 1}.${ext}`, { type: f.type });
      }
      return f;
    });
    const valid = files.filter((f) => PASTE_RE.test(f.name));
    if (!valid.length) {
      showToast(t("t.pastenone"));
      return;
    }
    ev.preventDefault();
    if (valid.length === 1) {
      loadFiles(valid);
      showToast(t("t.pasteimported", { n: 1 }));
    } else {
      showPasteChooser(valid);
    }
  });

  // Multiple valid files on the clipboard: let the user pick which to import.
  function showPasteChooser(files) {
    document.getElementById("paste-modal")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "paste-modal";
    const box = document.createElement("div");
    box.className = "paste-box";
    const h = document.createElement("h2");
    h.textContent = t("paste.title");
    const p = document.createElement("div");
    p.className = "hint2";
    p.textContent = t("paste.choose");
    box.append(h, p);
    const rows = files.map((f) => {
      const row = document.createElement("label");
      row.className = "paste-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      const name = document.createElement("span");
      name.className = "paste-name";
      name.textContent = f.name;
      const kind = document.createElement("span");
      kind.className = "paste-kind";
      kind.textContent =
        f.name.split(".").pop().toUpperCase() + (f.size ? " · " + formatBytes(f.size) : "");
      row.append(cb, name, kind);
      box.appendChild(row);
      return { cb, f };
    });
    const btns = document.createElement("div");
    btns.className = "btn-row";
    const ok = document.createElement("button");
    ok.textContent = t("paste.import");
    const cancel = document.createElement("button");
    cancel.className = "secondary";
    cancel.textContent = t("paste.cancel");
    btns.append(ok, cancel);
    box.appendChild(btns);
    overlay.appendChild(box);
    const close = () => {
      overlay.remove();
      window.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    cancel.addEventListener("click", close);
    ok.addEventListener("click", () => {
      const chosen = rows.filter((r) => r.cb.checked).map((r) => r.f);
      close();
      if (chosen.length) {
        loadFiles(chosen);
        showToast(t("t.pasteimported", { n: num(chosen.length) }));
      }
    });
    document.body.appendChild(overlay);
  }
  const fileLibrary = new Map(); // basename(lower) -> File
  let currentModelName = null; // basename(lower) of the active model
  let urlMap = new Map(); // basename(lower) -> blob URL (rebuilt per load)
  let texStatus = new Map(); // basename(lower) -> 'staged' | 'used' | 'applied' | 'sprite'
  let loadSeq = 0;
  let loadChain = Promise.resolve();
  let spriteImageName = null; // basename(lower) when in sprite mode
  let spritePixels = null; // { width, height, data } for the engine

  async function loadFiles(files) {
    if (!files.length) return;
    for (const f of files) fileLibrary.set(f.name.toLowerCase(), f);
    const mainFromSelection = files.find((f) => MODEL_RE.test(f.name));
    if (mainFromSelection) {
      currentModelName = mainFromSelection.name.toLowerCase();
      exitSpriteMode();
    }
    if (!currentModelName) {
      updateTextureList(); // textures staged, waiting for a model (or sprite use)
      return;
    }
    // serialize loads: a new upload waits for the in-flight one (which is
    // cancelled via loadSeq) instead of revoking blob URLs it still uses
    const seq = ++loadSeq;
    loadChain = loadChain.then(() => loadModel(seq)).catch(console.error);
    await loadChain;
  }

  async function loadModel(seq) {
    if (seq !== loadSeq) return; // superseded while queued
    const mainFile = fileLibrary.get(currentModelName);
    if (!mainFile) return;
    currentName = mainFile.name.replace(/\.[^.]+$/, "");

    // fresh blob URLs for the whole library
    for (const u of urlMap.values()) URL.revokeObjectURL(u);
    urlMap = new Map();
    for (const [name, f] of fileLibrary)
      urlMap.set(name, URL.createObjectURL(f));

    // resolve any URL a loader asks for (relative, absolute, windows paths)
    // against the library by basename
    const requested = new Set();
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (url.startsWith("data:")) return url;
      // Match by basename even for blob: URLs — loaders resolve relative
      // texture paths against the model's blob URL (e.g. "blob:…/C:\tex\a.png")
      const base = decodeURIComponent(
        url.split(/[\\/]/).pop().split("?")[0],
      ).toLowerCase();
      let hit = urlMap.get(base);
      let hitKey = base;
      if (!hit && /\.[a-z0-9]{2,5}$/.test(base)) {
        // extension-insensitive fallback: a model referencing "sword_dif.tga"
        // is satisfied by an uploaded "sword_dif.png"
        const stem = base.replace(/\.[^.]+$/, ".");
        for (const key of urlMap.keys()) {
          if (key.startsWith(stem) && IMAGE_RE.test(key)) {
            hit = urlMap.get(key);
            hitKey = key;
            break;
          }
        }
      }
      if (hit) {
        requested.add(hitKey);
        return hit;
      }
      return url;
    });
    // .tga references route to TGALoader only when a real .tga was uploaded;
    // otherwise a stem-matched png/jpg substitute is decoded by TextureLoader
    const tgaInLib = [...fileLibrary.keys()].some((n) => n.endsWith(".tga"));
    manager.addHandler(
      /\.tga$/i,
      tgaInLib ? new TGALoader(manager) : new THREE.TextureLoader(manager),
    );
    // track manager idleness — onLoad fires when every started item has
    // finished, including failed loads (e.g. textures the model references
    // but that weren't uploaded)
    let managerBusy = false;
    const idleResolvers = [];
    manager.onStart = () => {
      managerBusy = true;
    };
    manager.onLoad = () => {
      managerBusy = false;
      for (const r of idleResolvers.splice(0)) r();
    };

    try {
      const ext = mainFile.name.split(".").pop().toLowerCase();
      const url = urlMap.get(currentModelName);
      let object;
      if (ext === "fbx") {
        object = await new FBXLoader(manager).loadAsync(url);
      } else if (ext === "obj") {
        // use the MTL the OBJ references via `mtllib`; only fall back to a
        // sole library .mtl when the OBJ uses materials but names no file
        const objText = await mainFile.text();
        let mtlName = null;
        const mtlRef = objText.match(/^[ \t]*mtllib[ \t]+(.+?)[ \t\r]*$/m);
        if (mtlRef) {
          const base = mtlRef[1].trim().split(/[\\/]/).pop().toLowerCase();
          if (fileLibrary.has(base)) mtlName = base;
        }
        if (!mtlName && /^[ \t]*usemtl[ \t]/m.test(objText)) {
          const mtls = [...fileLibrary.keys()].filter((n) =>
            n.endsWith(".mtl"),
          );
          if (mtls.length === 1) mtlName = mtls[0];
        }
        const loader = new OBJLoader(manager);
        if (mtlName) {
          const mtl = await new MTLLoader(manager).loadAsync(
            urlMap.get(mtlName),
          );
          mtl.preload();
          loader.setMaterials(mtl);
        }
        object = await loader.loadAsync(url);
      } else if (ext === "glb" || ext === "gltf") {
        const gltf = await new GLTFLoader(manager).loadAsync(url);
        object = gltf.scene;
      } else if (ext === "stl") {
        const geo = await new STLLoader(manager).loadAsync(url);
        object = new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({ color: 0xcccccc }),
        );
      }
      // wait for pending textures (failed ones count as finished)
      if (managerBusy) {
        await Promise.race([
          new Promise((r) => idleResolvers.push(r)),
          new Promise((r) => setTimeout(r, 10000)),
        ]);
      }
      if (seq !== loadSeq) return; // superseded by a newer upload

      // texture statuses + fallback: if exactly one uploaded image was not
      // referenced by any material and some UV-mapped meshes have no base
      // color map, apply it to them (common for OBJ without MTL).
      texStatus = new Map();
      const images = [...fileLibrary.keys()].filter((n) => IMAGE_RE.test(n));
      for (const n of images)
        texStatus.set(n, requested.has(n) ? "used" : "staged");
      const unreferenced = images.filter((n) => !requested.has(n));
      if (
        unreferenced.length === 1 &&
        (await applyFallbackTexture(object, unreferenced[0], ext, manager))
      ) {
        texStatus.set(unreferenced[0], "applied");
      }
      if (seq !== loadSeq) return;
      setModel(object);
      updateTextureList();
    } catch (err) {
      console.error(err);
      alert(t("err.load", { msg: err.message }));
    }
  }

  // Apply a library image as base color map to UV-mapped meshes lacking one.
  // Returns true if applied to at least one mesh.
  async function applyFallbackTexture(object, texName, modelExt, manager) {
    const targets = [];
    object.traverse((n) => {
      if (!n.isMesh || !n.geometry?.getAttribute("uv")) return;
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      for (const m of mats) if (m && !m.map) targets.push(m);
    });
    if (!targets.length) return false;
    try {
      const isTga = /\.tga$/i.test(texName);
      const loader = isTga
        ? new TGALoader(manager)
        : new THREE.TextureLoader(manager);
      const tex = await loader.loadAsync(urlMap.get(texName));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      // glTF UVs expect flipY=false; other formats use flipY=true
      if (!isTga) tex.flipY = !(modelExt === "glb" || modelExt === "gltf");
      for (const m of targets) {
        m.map = tex;
        if (m.color) m.color.set(0xffffff); // don't tint the texture
        m.needsUpdate = true;
      }
      return true;
    } catch (e) {
      console.warn("fallback texture failed", e);
      return false;
    }
  }

  function updateTextureList() {
    const el = $("texture-list");
    el.innerHTML = "";
    const labels = {
      used: t("tex.used"),
      applied: t("tex.applied"),
      staged: currentModelName ? t("tex.staged") : t("tex.waiting"),
      sprite: t("tex.sprite"),
    };
    let stagedImages = 0;
    for (const [name] of fileLibrary) {
      if (!IMAGE_RE.test(name)) continue;
      const status =
        name === spriteImageName ? "sprite" : (texStatus.get(name) ?? "staged");
      if (status === "staged" && !currentModelName) stagedImages++;
      const row = document.createElement("div");
      row.className = "tex-row";
      const n = document.createElement("span");
      n.className = "tex-name";
      n.textContent = fileLibrary.get(name).name;
      const s = document.createElement("span");
      s.className = "tex-status " + status;
      s.textContent = labels[status];
      row.append(n, s);
      el.append(row);
    }
    $("btn-sprite").hidden = !(
      stagedImages > 0 &&
      !currentModelName &&
      !spriteImageName
    );
  }

  // ---------- 2D sprite -> 3D mode ----------

  async function imageFileToPixels(file, maxSize = 512) {
    const bmp = await createImageBitmap(file);
    const w = Math.min(bmp.width, maxSize),
      h = Math.min(bmp.height, maxSize);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingEnabled = w !== bmp.width;
    cx.drawImage(bmp, 0, 0, w, h);
    return { width: w, height: h, data: cx.getImageData(0, 0, w, h).data };
  }

  // Sprite conversion bypasses the mesh pipeline: mode, decimation, the
  // direct/voxel/pixel groups, and thickness scale (sprite boxes are
  // volumetric) have no effect. Only max decorations, flip Z, euler order,
  // and alpha cutoff remain relevant — hide everything else. Alpha cutoff
  // is a primary sprite control, so it is lifted out of Advanced.
  function setSpriteParamsUI(on) {
    $("sprite-param-note").hidden = !on;
    for (const id of ["row-decimate", "row-prevdec", "row-mode", "row-thin"]) {
      $(id).hidden = on;
    }
    const m = $("p-mode").value;
    $("direct-params").hidden = on || m !== "direct";
    $("voxel-params").hidden = on || m !== "voxel";
    $("pixel-params").hidden = on || m !== "pixel";
    if (on) $("adv-params").before($("row-alpha"));
    else $("adv-params").append($("row-alpha")); // restore as last Advanced row
  }

  function exitSpriteMode() {
    spriteImageName = null;
    spritePixels = null;
    $("sprite-params").hidden = true;
    setSpriteParamsUI(false);
  }

  $("btn-sprite").addEventListener("click", async () => {
    const images = [...fileLibrary.keys()].filter((n) => IMAGE_RE.test(n));
    if (!images.length) return;
    const name = images[images.length - 1];
    const file = fileLibrary.get(name);
    try {
      spritePixels = await imageFileToPixels(file);
      spriteImageName = name;
      currentName = file.name.replace(/\.[^.]+$/, "");
      $("sprite-params").hidden = false;
      setSpriteParamsUI(true);
      $("btn-generate").disabled = false;
      clearReconstructions();
      texPanel.setTextures([]);
      extracted = null;
      // display the sprite as a textured plane
      const tex = await new THREE.TextureLoader().loadAsync(
        URL.createObjectURL(file),
      );
      tex.magFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      const px = parseFloat($("p-sprite-px").value) || 0.05;
      const w = spritePixels.width * px,
        h = spritePixels.height * px;
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          alphaTest: 0.05,
          side: THREE.DoubleSide,
        }),
      );
      plane.position.y = h / 2;
      currentObject = plane;
      displayedObject = plane;
      viewer.setModel(plane);
      editor.refresh();
      $("drop-hint").hidden = true;
      modelInfo = {
        type: "sprite",
        name: file.name,
        w: spritePixels.width,
        h: spritePixels.height,
        wm: w,
        hm: h,
      };
      renderModelInfo();
      renderStats($("gen-stats"), {});
      updateTextureList();
    } catch (e) {
      console.error(e);
      alert(t("err.image", { msg: e.message }));
    }
  });

  // ---------- clear / reset ----------

  $("btn-clear").addEventListener("click", () => {
    loadSeq++; // cancels any in-flight load
    fileLibrary.clear();
    texStatus.clear();
    for (const u of urlMap.values()) URL.revokeObjectURL(u);
    urlMap = new Map();
    currentModelName = null;
    currentName = "model";
    exitSpriteMode();
    currentObject = null;
    displayedObject = null;
    extracted = null;
    modelInfo = null;
    viewer.setModel(null);
    editor.refresh();
    clearReconstructions();
    texPanel.setTextures([]);
    $("btn-generate").disabled = true;
    renderStats($("model-info"), {});
    renderStats($("gen-stats"), {});
    updateTextureList();
    $("file-input").value = "";
    $("drop-hint").hidden = false;
  });

  $("p-sprite-px").addEventListener("input", () => {
    // re-scale the preview plane
    if (!spriteImageName || !currentObject) return;
    const px = parseFloat($("p-sprite-px").value) || 0.05;
    const w = spritePixels.width * px,
      h = spritePixels.height * px;
    currentObject.geometry.dispose();
    currentObject.geometry = new THREE.PlaneGeometry(w, h);
    currentObject.position.y = h / 2;
  });

  // ---------- decimation preview ----------

  let displayedObject = null; // what the viewport shows (original or decimated)
  let decimTimer = 0;
  function scheduleDecimPreview() {
    clearTimeout(decimTimer);
    decimTimer = setTimeout(updateDecimPreview, 200);
  }
  function updateDecimPreview() {
    const strength = (parseInt($("p-decimate").value, 10) || 0) / 100;
    const want =
      $("p-prevdec").checked && strength > 0 && extracted && currentObject;
    if (!want) {
      if (displayedObject !== currentObject) {
        displayedObject = currentObject;
        viewer.setModel(currentObject, true);
      }
      return;
    }
    const group = new THREE.Group();
    // gather ALL meshes' world-space triangles and decimate them together —
    // the same global grid the converter uses (per-mesh grids would barely
    // collapse anything on multi-mesh models)
    const all = [];
    for (const m of extracted.meshes) {
      const pos = m.positions,
        idx = m.indices,
        uvs = m.uvs,
        mw = m.matrixWorld;
      const count = idx ? idx.length : pos.length / 3;
      const xf = (i) => {
        const x = pos[i * 3],
          y = pos[i * 3 + 1],
          z = pos[i * 3 + 2];
        if (!mw) return { x, y, z };
        return {
          x: mw[0] * x + mw[4] * y + mw[8] * z + mw[12],
          y: mw[1] * x + mw[5] * y + mw[9] * z + mw[13],
          z: mw[2] * x + mw[6] * y + mw[10] * z + mw[14],
        };
      };
      for (let i = 0; i + 2 < count; i += 3) {
        const ia = idx ? idx[i] : i,
          ib = idx ? idx[i + 1] : i + 1,
          ic = idx ? idx[i + 2] : i + 2;
        all.push({
          p: [xf(ia), xf(ib), xf(ic)],
          uv: uvs
            ? [
                [uvs[ia * 2], uvs[ia * 2 + 1]],
                [uvs[ib * 2], uvs[ib * 2 + 1]],
                [uvs[ic * 2], uvs[ic * 2 + 1]],
              ]
            : null,
          mesh: m,
        });
      }
    }
    const decAll = decimateTriangles(all, strength);
    const byMesh = new Map();
    for (const t of decAll) {
      let arr = byMesh.get(t.mesh);
      if (!arr) {
        arr = [];
        byMesh.set(t.mesh, arr);
      }
      arr.push(t);
    }
    for (const [m, dec] of byMesh) {
      const uvs = m.uvs;
      if (!dec.length) continue;
      const positions = new Float32Array(dec.length * 9);
      const uvArr = uvs ? new Float32Array(dec.length * 6) : null;
      let o = 0,
        uo = 0;
      for (const t of dec) {
        for (let k = 0; k < 3; k++) {
          positions[o++] = t.p[k].x;
          positions[o++] = t.p[k].y;
          positions[o++] = t.p[k].z;
          if (uvArr) {
            uvArr[uo++] = t.uv ? t.uv[k][0] : 0;
            uvArr[uo++] = t.uv ? t.uv[k][1] : 0;
          }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      if (uvArr) geo.setAttribute("uv", new THREE.BufferAttribute(uvArr, 2));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(
          m.color[0] / 255,
          m.color[1] / 255,
          m.color[2] / 255,
        ).convertSRGBToLinear(),
        side: THREE.DoubleSide,
      });
      if (m.texture) {
        const cv = document.createElement("canvas");
        cv.width = m.texture.width;
        cv.height = m.texture.height;
        cv.getContext("2d").putImageData(
          new ImageData(
            new Uint8ClampedArray(m.texture.data),
            m.texture.width,
            m.texture.height,
          ),
          0,
          0,
        );
        const tex = new THREE.CanvasTexture(cv);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = m.texture.flipY !== false;
        mat.map = tex;
        mat.color.set(0xffffff);
      }
      group.add(new THREE.Mesh(geo, mat));
    }
    displayedObject = group;
    viewer.setModel(group, true);
  }
  $("p-prevdec").addEventListener("change", updateDecimPreview);

  function setModel(object) {
    currentObject = object;
    displayedObject = object;
    // FBX files are often authored in cm
    viewer.setModel(object);
    clearReconstructions();
    $("drop-hint").hidden = true;
    extracted = extractMeshes(object);
    $("btn-generate").disabled = false;
    modelInfo = {
      type: "model",
      meshes: extracted.meshCount,
      tris: extracted.triangleCount,
      textured: extracted.meshes.some((m) => m.texture),
    };
    renderModelInfo();
    renderStats($("gen-stats"), {});
    // texture editing panel: unique textures of the extracted meshes
    const seen = new Set();
    const texList = [];
    for (const m of extracted.meshes) {
      if (m.texture && !seen.has(m.texture)) {
        seen.add(m.texture);
        texList.push({ texture: m.texture });
      }
    }
    texPanel.setTextures(texList);
    updateDecimPreview();
    editor.refresh(); // model gizmo tools become available
  }

  // ---------- parameters ----------

  const paramInputs = {
    unitScale: $("p-unit"),
    colorTolerance: $("p-tol"),
    maxSubdiv: $("p-subdiv"),
    snapDeg: $("p-snap"),
    maxDecorations: $("p-max"),
    merge: $("p-merge"),
    thinScale: $("p-thin"),
    planarAngleDeg: $("p-planar"),
    flipZ: $("p-flipz"),
    eulerOrder: $("p-euler"),
    primitiveMode: $("p-prim"),
    decimate: $("p-decimate"),
    alphaCutoff: $("p-alpha"),
  };

  const liveLabels = {
    colorTolerance: "v-tol",
    maxSubdiv: "v-subdiv",
    snapDeg: "v-snap",
  };
  $("p-decimate").addEventListener("input", () => {
    const v = parseInt($("p-decimate").value, 10);
    $("v-decimate").textContent = v === 0 ? t("val.off") : num(v) + "%";
    scheduleDecimPreview();
  });
  for (const [id, label] of [
    ["p-voxtol", "v-voxtol"],
    ["p-pxtol", "v-pxtol"],
    ["p-sdfiso", "v-sdfiso"],
    ["p-sdfsmooth", "v-sdfsmooth"],
  ]) {
    $(id).addEventListener("input", () => {
      $(label).textContent = $(id).value;
    });
  }
  // voxel resolution: slider and free numeric input stay in sync (the number
  // box may exceed the slider's range)
  $("p-voxres").addEventListener("input", () => {
    $("p-voxres-n").value = $("p-voxres").value;
  });
  $("p-voxres-n").addEventListener("input", () => {
    const v = parseInt($("p-voxres-n").value, 10);
    if (v >= 8 && v <= 256) $("p-voxres").value = v;
  });
  // show only the parameter group for the selected mode
  $("p-mode").addEventListener("change", () => {
    const m = $("p-mode").value;
    const sprite = !!spriteImageName;
    $("direct-params").hidden = sprite || m !== "direct";
    $("voxel-params").hidden = sprite || m !== "voxel";
    $("pixel-params").hidden = sprite || m !== "pixel";
  });
  $("p-voxsurf").addEventListener("change", () => {
    $("sdf-params").hidden = $("p-voxsurf").value !== "mc";
  });

  // live user transform: mirror on the displayed model immediately
  const transformIds = ["t-px", "t-py", "t-pz", "t-rx", "t-ry", "t-rz", "t-scale"];
  function readUserTransform() {
    const n = (id) => parseFloat($(id).value) || 0;
    const s = parseFloat($("t-scale").value);
    return {
      pivot: { x: n("t-px"), y: n("t-py"), z: n("t-pz") },
      rotateDeg: { x: n("t-rx"), y: n("t-ry"), z: n("t-rz") },
      scale: Number.isFinite(s) && s > 0 ? s : 1,
    };
  }
  // syncEditor=false when the change originates from the editor's own gizmo
  function applyUserTransformPreview(syncEditor = true) {
    const { pivot, rotateDeg, scale } = readUserTransform();
    const unit = parseFloat($("p-unit").value) || 1;
    viewer.setUserTransform(pivot, rotateDeg, scale, unit);
    if (syncEditor) editor.onModelTransformChanged();
  }
  for (const id of transformIds) {
    $(id).addEventListener("input", () => applyUserTransformPreview());
  }
  $("p-unit").addEventListener("input", () => applyUserTransformPreview());
  $("t-reset").addEventListener("click", () => {
    for (const id of ["t-px", "t-py", "t-pz", "t-rx", "t-ry", "t-rz"]) $(id).value = 0;
    $("t-scale").value = 1;
    $("p-unit").value = 1;
    applyUserTransformPreview();
    showToast(t("t.reset"));
  });
  for (const [key, el] of Object.entries(paramInputs)) {
    el.addEventListener("input", () => {
      if (liveLabels[key]) $(liveLabels[key]).textContent = el.value;
      if (
        ["colorTolerance", "maxSubdiv", "snapDeg", "planarAngleDeg"].includes(
          key,
        )
      ) {
        $("p-preset").value = "custom";
      }
    });
  }

  $("p-preset").addEventListener("change", () => {
    const preset = PRESETS[$("p-preset").value];
    if (!preset) return;
    paramInputs.colorTolerance.value = preset.colorTolerance;
    paramInputs.maxSubdiv.value = preset.maxSubdiv;
    paramInputs.snapDeg.value = preset.snapDeg;
    paramInputs.planarAngleDeg.value = preset.planarAngleDeg;
    $("v-tol").textContent = preset.colorTolerance;
    $("v-subdiv").textContent = preset.maxSubdiv;
    $("v-snap").textContent = preset.snapDeg;
  });

  function readParams() {
    const { pivot, rotateDeg, scale } = readUserTransform();
    return {
      userScale: scale,
      mode: $("p-mode").value,
      voxelRes: Math.max(2, parseInt($("p-voxres-n").value, 10) || 256),
      voxelColorTolerance: parseFloat($("p-voxtol").value) || 0,
      voxelSurface: $("p-voxsurf").value,
      sdfIso: parseFloat($("p-sdfiso").value) || 0,
      sdfSmooth: parseInt($("p-sdfsmooth").value, 10) || 0,
      pixelTolerance: parseFloat($("p-pxtol").value) || 0,
      pixelOverdraw: $("p-overdraw").checked,
      unitScale: parseFloat(paramInputs.unitScale.value) || 1,
      colorTolerance: parseFloat(paramInputs.colorTolerance.value),
      maxSubdiv: parseInt(paramInputs.maxSubdiv.value, 10),
      snapDeg: parseFloat(paramInputs.snapDeg.value),
      maxDecorations: Math.max(
        1,
        parseInt(paramInputs.maxDecorations.value, 10) || 4995,
      ),
      merge: paramInputs.merge.checked,
      thinScale: parseFloat(paramInputs.thinScale.value) || 0.01,
      planarAngleDeg: parseFloat(paramInputs.planarAngleDeg.value),
      flipZ: paramInputs.flipZ.checked,
      eulerOrder: paramInputs.eulerOrder.value,
      primitiveMode: paramInputs.primitiveMode.value,
      decimate: (parseInt(paramInputs.decimate.value, 10) || 0) / 100,
      alphaCutoff: Math.min(
        1,
        Math.max(0, parseFloat(paramInputs.alphaCutoff.value) || 0),
      ),
      pivot,
      rotateDeg,
    };
  }

  // ---------- generation ----------

  $("btn-generate").addEventListener("click", () => {
    if ((!extracted && !spriteImageName) || busy) return;
    busy = true;
    $("btn-generate").disabled = true;
    $("btn-generate").textContent = t("btn.converting");
    $("progress").hidden = false;
    $("progress-bar").style.width = "30%";
    const params = readParams();
    lastParams = params;
    const id = ++jobId;
    if (spriteImageName) {
      worker.postMessage({
        jobId: id,
        sprite: {
          texture: spritePixels,
          pixelSize: parseFloat($("p-sprite-px").value) || 0.05,
          thickness: parseFloat($("p-sprite-thick").value) || 0.1,
        },
        params,
      });
    } else {
      worker.postMessage({ jobId: id, meshes: extracted.meshes, params });
    }
  });

  // ---------- reconstructions (each generation kept + toggleable) ----------

  let reconstructions = []; // {id,kind,extra,msg,params,visible}
  let activeReconId = null;
  let reconSeq = 0;

  // Reconstruction labels are rebuilt from parts on every render so they
  // follow the active language.
  function reconLabel(e) {
    const base =
      e.kind === "sprite"
        ? t("recon.sprite")
        : e.kind === "edited"
          ? t("recon.edited")
          : t("mode." + e.kind);
    return `${base}${e.extra ?? ""} #${e.id}`;
  }

  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.jobId !== jobId) return;
    busy = false;
    $("btn-generate").disabled = false;
    $("btn-generate").textContent = t("btn.generate");
    $("progress").hidden = true;
    $("progress-bar").style.width = "0";
    if (!msg.ok) {
      alert(t("err.convert", { msg: msg.error }));
      return;
    }
    const id = ++reconSeq;
    const p = lastParams ?? {};
    let kind = ["direct", "voxel", "pixel"].includes(p.mode) ? p.mode : "direct";
    let extra = "";
    if (spriteImageName) kind = "sprite";
    else if (p.mode === "voxel") extra = ` ${p.voxelRes}${p.voxelSurface === "mc" ? " MC" : ""}`;
    else if (p.mode === "direct" && p.primitiveMode === "both") extra = " +squares";
    // a new generation hides the previous reconstructions so only the fresh
    // result is visible (they can be re-enabled from the list)
    for (const r of reconstructions) r.visible = false;
    reconstructions.push({ id, kind, extra, msg, params: p, visible: true });
    if (reconstructions.length > 8) {
      const removed = reconstructions.shift();
      if (removed.id === activeReconId) activeReconId = null;
    }
    setActiveRecon(id);
    renderReconList();
    updateOverlays();
    editor.onGenerated();
  };

  function setActiveRecon(id) {
    const changed = activeReconId !== id;
    activeReconId = id;
    const e = reconstructions.find((r) => r.id === id);
    lastResult = e ? e.msg : null;
    lastParams = e ? e.params : lastParams;
    setOutputReady(!!e);
    if (e) renderGenStats(e.msg.stats, e.params);
    else renderStats($("gen-stats"), {});
    if (changed) editor.onReconChanged();
    else editor.refresh();
  }

  function renderReconList() {
    const el = $("recon-list");
    if (!el) return;
    $("btn-clear-recons").hidden = reconstructions.length === 0;
    el.innerHTML = "";
    for (const e of reconstructions) {
      const row = document.createElement("div");
      row.className = "recon-row";
      const vis = document.createElement("input");
      vis.type = "checkbox";
      vis.checked = e.visible;
      vis.title = t("tip.recon.show");
      vis.addEventListener("change", () => {
        e.visible = vis.checked;
        updateOverlays();
      });
      const act = document.createElement("input");
      act.type = "radio";
      act.name = "recon-active";
      act.checked = e.id === activeReconId;
      act.title = t("tip.recon.use");
      act.addEventListener("change", () => {
        if (act.checked) setActiveRecon(e.id);
      });
      const label = document.createElement("span");
      label.className = "recon-label";
      label.textContent = reconLabel(e);
      const count = document.createElement("span");
      count.className = "recon-count";
      count.textContent = num(e.msg.decorations.length);
      const del = document.createElement("button");
      del.className = "recon-del";
      del.textContent = "✕";
      del.title = t("tip.recon.del");
      del.addEventListener("click", () => {
        reconstructions = reconstructions.filter((r) => r.id !== e.id);
        if (activeReconId === e.id) {
          setActiveRecon(reconstructions.at(-1)?.id ?? null);
        }
        renderReconList();
        updateOverlays();
      });
      row.append(vis, act, label, count, del);
      el.append(row);
    }
  }

  function clearReconstructions() {
    reconstructions = [];
    setActiveRecon(null);
    renderReconList();
    updateOverlays();
  }

  function renderModelInfo() {
    const el = $("model-info");
    if (!modelInfo) {
      renderStats(el, {});
      return;
    }
    if (modelInfo.type === "sprite") {
      renderStats(el, {
        [t("mi.sprite")]: modelInfo.name,
        [t("mi.pixels")]: `${num(modelInfo.w)} × ${num(modelInfo.h)}`,
        [t("mi.size")]: `${num(modelInfo.wm, { maximumFractionDigits: 2 })} × ${num(modelInfo.hm, { maximumFractionDigits: 2 })}`,
      });
    } else {
      renderStats(el, {
        [t("mi.meshes")]: num(modelInfo.meshes),
        [t("mi.tris")]: num(modelInfo.tris),
        [t("mi.textured")]: modelInfo.textured ? t("misc.yes") : t("misc.no"),
      });
    }
  }

  function renderGenStats(s, p) {
    const models = Math.ceil(s.placements / MAX_DECORATIONS_PER_MODEL);
    const kindRows = {};
    if (s.byKind && Object.keys(s.byKind).length > 1) {
      for (const [k, n] of Object.entries(s.byKind)) {
        kindRows[t("kp." + k)] = num(n);
      }
    }
    renderStats($("gen-stats"), {
      [t(s.spritePixels != null ? "gs.opaque" : "mi.tris")]:
        num(s.sourceTriangles),
      ...(p?.decimate > 0 ? { [t("gs.afterdec")]: num(s.afterDecimation) } : {}),
      ...(p?.mode === "voxel"
        ? {
            [t("gs.voxels")]: num(s.voxels ?? 0),
            ...(s.voxelsCulled ? { [t("gs.culled")]: num(s.voxelsCulled) } : {}),
            ...(s.sdfCells
              ? { [t("gs.mccells")]: num(s.sdfCells),
                  [t("gs.surftris")]: num(s.afterSubdivision) }
              : {}),
            [t("gs.voxsize")]: num(s.voxelSize, { maximumFractionDigits: 4 }),
          }
        : p?.mode === "pixel"
          ? {
              [t("gs.texels")]: num(s.texels ?? 0),
              [t("gs.aftermerge")]: num(s.afterMerge),
            }
          : {
              [t("gs.aftersub")]: num(s.afterSubdivision),
              [t("gs.aftermerge")]: num(s.afterMerge),
            }),
      [t("gs.decs")]: num(s.placements),
      ...kindRows,
      ...(s.squareApprox
        ? { [t("gs.sqapprox")]: { value: num(s.squareApprox), warn: true } }
        : {}),
      [t("gs.colors")]: num(s.uniqueColors),
      [t("gs.models")]: num(models),
      ...(s.capSplit ? { [t("gs.capsplit")]: num(s.capSplit) } : {}),
      ...(s.budgetMerged ? { [t("gs.budgetmerged")]: num(s.budgetMerged) } : {}),
      ...(s.transparentSkipped
        ? { [t("gs.transparent")]: num(s.transparentSkipped) }
        : {}),
      ...(s.dropped
        ? { [t("gs.dropped")]: { value: num(s.dropped), warn: true } }
        : {}),
      ...(s.degenerate ? { [t("gs.degenerate")]: num(s.degenerate) } : {}),
      ...(s.bounds
        ? { [t("mi.size")]: `${s.bounds.x} × ${s.bounds.y} × ${s.bounds.z}` }
        : {}),
    });
  }

  // The conversion never repositions output (the model origin is preserved),
  // so decorations always display at their exact exported coordinates.
  function updateOverlays() {
    const shown = $("tb-output").classList.contains("pressed");
    $("p-overlay").disabled = !shown;
    const mode = shown ? $("p-overlay").value : "off";
    const entries = reconstructions.map((e) => ({
      visible: e.visible,
      positions: e.msg.positions,
      colors: e.msg.colors,
      offset: null,
    }));
    viewer.setOverlays(entries, mode);
    if (!currentObject) viewer.frame();
  }

  $("p-overlay").addEventListener("change", updateOverlays);
  $("tb-output").addEventListener("click", () => {
    $("tb-output").classList.toggle("pressed");
    updateOverlays();
  });

  function activeRecon() {
    return reconstructions.find((r) => r.id === activeReconId) ?? null;
  }

  function rebuildActiveRecon(light = false) {
    const e = activeRecon();
    if (!e) return;
    const { positions, colors, owners } = buildPreview(e.msg.decorations, e.params);
    e.msg.positions = positions;
    e.msg.colors = colors;
    e.msg.owners = owners;
    e.msg.stats.placements = e.msg.decorations.length;
    lastResult = e.msg;
    updateOverlays();
    if (light) {
      // mid-drag: skip list/stats/output churn, the editor refreshes on end
      editor.onRebuilt(true);
      return;
    }
    setOutputReady(true);
    renderGenStats(e.msg.stats, e.params);
    renderReconList();
    editor.onRebuilt(false);
  }

  $("ed-save").addEventListener("click", () => {
    const e = activeRecon();
    if (!e) return;
    const id = ++reconSeq;
    const decorations = e.msg.decorations.map((d) => ({
      ...d,
      position: { ...d.position },
      rotationDeg: { ...d.rotationDeg },
      scale: { ...d.scale },
    }));
    const { positions, colors, owners } = buildPreview(decorations, e.params);
    const stats = { ...e.msg.stats, placements: decorations.length };
    for (const r of reconstructions) r.visible = false;
    reconstructions.push({
      id,
      kind: "edited",
      extra: "",
      msg: { decorations, stats, positions, colors, owners },
      params: e.params,
      visible: true,
    });
    setActiveRecon(id);
    renderReconList();
    updateOverlays();
    showToast(t("t.saved"));
  });

  // clear all generated models (source model stays)
  $("btn-clear-recons").addEventListener("click", () => {
    clearReconstructions();
  });

  // ---------- output: .gia download or primitive data ----------

  // Enables/disables whichever output the page provides.
  function setOutputReady(ready) {
    const dl = $("btn-download");
    if (dl) dl.disabled = !ready;
    $("ed-save").disabled = !ready;
    const view = $("btn-view-prims");
    if (view) {
      view.disabled = !ready;
      processed =
        ready && lastResult
          ? new Array(lastResult.decorations.length).fill(false)
          : [];
      renderedRows = 0;
      if ($("prim-table"))
        $("prim-table").querySelector("tbody").innerHTML = "";
      if ($("prim-modal")) $("prim-modal").hidden = true;
      if ($("output-summary")) {
        $("output-summary").textContent =
          ready && lastResult
            ? t("out.summary", { n: num(lastResult.decorations.length) })
            : "";
      }
    }
  }

  $("btn-download")?.addEventListener("click", () => {
    if (!lastResult) return;
    const models = splitIntoModels(currentName, lastResult.decorations);
    const bytes = buildGia({
      models,
      exportName: currentName,
      collision: $("p-collision").checked,
      autoAssemble: $("p-autoasm")?.checked ?? false,
    });
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = currentName + ".gia";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // Primitive-data view (main page): popup table of every generated primitive
  // with a per-row "processed" checkbox.
  let processed = [];
  let renderedRows = 0;
  const ROW_CHUNK = 1000;

  const fmtNum = (n) => {
    const r = Math.round(n * 10000) / 10000;
    return String(Object.is(r, -0) ? 0 : r);
  };

  // Model Name/ID of the primitive's base decoration model, as defined in
  // the provided base .gia files (single source of truth: editor/stats.js).
  const modelName = (d) => KIND_LABELS[d.kind] ?? KIND_LABELS.triangle;
  const modelId = (d) =>
    PRIMITIVE_MODEL_IDS[d.kind] ?? PRIMITIVE_MODEL_IDS.triangle;

  function appendRows() {
    if (!lastResult) return;
    const decs = lastResult.decorations;
    const tbody = $("prim-table").querySelector("tbody");
    const frag = document.createDocumentFragment();
    const end = Math.min(decs.length, renderedRows + ROW_CHUNK);
    for (let i = renderedRows; i < end; i++) {
      const d = decs[i];
      const tr = document.createElement("tr");
      if (processed[i]) tr.classList.add("done");

      const tdCheck = document.createElement("td");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!processed[i];
      cb.title = t("tip.processed");
      cb.addEventListener("change", () => {
        processed[i] = cb.checked;
        tr.classList.toggle("done", cb.checked);
      });
      tdCheck.appendChild(cb);
      tr.appendChild(tdCheck);

      // [text, groupStart?]
      const cells = [
        [String(i + 1)],
        [t("kind." + (d.kind ?? "triangle"))],
        [String(modelId(d))],
        [d.kind],
        [fmtNum(d.position.x), true],
        [fmtNum(d.position.y)],
        [fmtNum(d.position.z)],
        [fmtNum(d.rotationDeg.x), true],
        [fmtNum(d.rotationDeg.y)],
        [fmtNum(d.rotationDeg.z)],
        [fmtNum(d.scale.x), true],
        [fmtNum(d.scale.y)],
        [fmtNum(d.scale.z)],
      ];
      for (const [text, grp] of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        if (grp) td.className = "grp-start";
        tr.appendChild(td);
      }
      const tdColor = document.createElement("td");
      tdColor.className = "grp-start";
      const hex = "#" + d.color.toString(16).padStart(6, "0");
      tdColor.dataset.copy = hex.slice(1);
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = hex;
      tdColor.append(sw, " " + hex);
      tr.appendChild(tdColor);
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    renderedRows = end;
    const more = $("btn-more-rows");
    more.hidden = renderedRows >= decs.length;
    if (!more.hidden)
      more.textContent = t("modal.more", { n: num(decs.length - renderedRows) });
  }

  // double-click any value cell to copy just that value
  $("prim-table")?.addEventListener("dblclick", async (e) => {
    const td = e.target.closest("td");
    if (!td || td.querySelector("input")) return;
    const value = td.dataset.copy ?? td.textContent.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast(t("t.copiedval", { v: value }));
    } catch (err) {
      showToast(t("t.clipboard"));
    }
  });

  let toastTimer = null;
  function showToast(text) {
    let el = $("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1400);
  }

  $("btn-view-prims")?.addEventListener("click", () => {
    if (!lastResult) return;
    $("prim-count").textContent = t("modal.count", {
      n: num(lastResult.decorations.length),
    });
    $("prim-note").textContent = t("modal.note");
    if (renderedRows === 0) appendRows();
    $("prim-modal").hidden = false;
    // pin the X/Y/Z subheader row exactly below the group header row so no
    // gap shows scrolled values behind the sticky headers
    requestAnimationFrame(() => {
      const h = $("prim-table").tHead.rows[0].offsetHeight;
      for (const th of $("prim-table").querySelectorAll("thead th.sub")) {
        th.style.top = h + "px";
      }
    });
  });
  $("btn-close-modal")?.addEventListener("click", () => {
    $("prim-modal").hidden = true;
  });
  $("prim-modal")?.addEventListener("click", (e) => {
    if (e.target === $("prim-modal")) $("prim-modal").hidden = true;
  });
  $("btn-more-rows")?.addEventListener("click", appendRows);

  function primitivesJson() {
    return {
      name: currentName,
      units:
        "position/zoom in units of 0.1 m; rotation in degrees (YXZ unless configured otherwise)",
      primitives: lastResult.decorations.map((d, i) => ({
        modelName: modelName(d),
        modelId: modelId(d),
        kind: d.kind,
        position: d.position,
        rotationDeg: d.rotationDeg,
        zoom: d.scale,
        color: "#" + d.color.toString(16).padStart(6, "0"),
        processed: !!processed[i],
      })),
    };
  }

  $("btn-copy-json")?.addEventListener("click", async () => {
    if (!lastResult) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(primitivesJson(), null, 1),
      );
      $("btn-copy-json").textContent = t("modal.copied");
      setTimeout(() => {
        $("btn-copy-json").textContent = t("modal.copyjson");
      }, 1500);
    } catch (e) {
      alert(t("err.clipboard", { msg: e.message }));
    }
  });

  // ---------- stats ----------

  function renderStats(el, obj) {
    el.innerHTML = "";
    for (const [k, v] of Object.entries(obj)) {
      const kEl = document.createElement("div");
      kEl.className = "k";
      kEl.textContent = k;
      const vEl = document.createElement("div");
      const isObj = v && typeof v === "object";
      vEl.className = "v" + (isObj && v.warn ? " warn" : "");
      vEl.textContent = isObj ? v.value : v;
      el.append(kEl, vEl);
    }
  }

  // camera navigation gizmo + projection switching
  createNavGizmo(viewer);
  viewer.onProjectionChange = (cam) => editor.onCameraChanged(cam);

  // live language switching: re-render everything dynamic (the static shell
  // is re-applied by i18n itself via data-i18n bindings)
  onLangChange(() => {
    if (busy) $("btn-generate").textContent = t("btn.converting");
    const v = parseInt($("p-decimate").value, 10) || 0;
    $("v-decimate").textContent = v === 0 ? t("val.off") : num(v) + "%";
    renderModelInfo();
    updateTextureList();
    renderReconList();
    const e = activeRecon();
    if (e) renderGenStats(e.msg.stats, e.params);
    else renderStats($("gen-stats"), {});
    if ($("output-summary")) {
      $("output-summary").textContent =
        lastResult && !$("ed-save").disabled
          ? t("out.summary", { n: num(lastResult.decorations.length) })
          : "";
    }
    editor.refresh(); // selection info, statistics, warnings, status bar
  });

  editor.refresh(); // initial UI state (empty scene)
} // end initApp
