// App wiring: file loading, parameters, worker dispatch, stats, download.
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { TGALoader } from "three/addons/loaders/TGALoader.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { Viewer } from "./viewer.js";
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

  let currentObject = null; // three.js object
  let currentName = "model";
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
      alert("Failed to load model: " + err.message);
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
      used: "used by material",
      applied: "applied (no map)",
      staged: currentModelName ? "not referenced" : "waiting for model",
      sprite: "3D sprite source",
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

  function exitSpriteMode() {
    spriteImageName = null;
    spritePixels = null;
    $("sprite-params").hidden = true;
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
      viewer.setModel(plane);
      $("drop-hint").hidden = true;
      renderStats($("model-info"), {
        Sprite: file.name,
        Pixels: `${spritePixels.width} × ${spritePixels.height}`,
        "Size (m)": `${w.toFixed(2)} × ${h.toFixed(2)}`,
      });
      renderStats($("gen-stats"), {});
      updateTextureList();
    } catch (e) {
      console.error(e);
      alert("Could not read image: " + e.message);
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
    extracted = null;
    viewer.setModel(null);
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

  function setModel(object) {
    currentObject = object;
    // FBX files are often authored in cm
    viewer.setModel(object);
    clearReconstructions();
    $("drop-hint").hidden = true;
    extracted = extractMeshes(object);
    $("btn-generate").disabled = false;
    renderStats($("model-info"), {
      Meshes: extracted.meshCount,
      "Source triangles": extracted.triangleCount.toLocaleString(),
      Textured: extracted.meshes.some((m) => m.texture) ? "yes" : "no",
    });
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
    center: $("p-center"),
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
    $("v-decimate").textContent = v === 0 ? "off" : v + "%";
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
    $("direct-params").hidden = m !== "direct";
    $("voxel-params").hidden = m !== "voxel";
    $("pixel-params").hidden = m !== "pixel";
  });
  $("p-voxsurf").addEventListener("change", () => {
    $("sdf-params").hidden = $("p-voxsurf").value !== "mc";
  });

  // live user transform: mirror on the displayed model immediately
  const transformIds = ["t-px", "t-py", "t-pz", "t-rx", "t-ry", "t-rz"];
  function readUserTransform() {
    const n = (id) => parseFloat($(id).value) || 0;
    return {
      pivot: { x: n("t-px"), y: n("t-py"), z: n("t-pz") },
      rotateDeg: { x: n("t-rx"), y: n("t-ry"), z: n("t-rz") },
    };
  }
  for (const id of transformIds) {
    $(id).addEventListener("input", () => {
      const { pivot, rotateDeg } = readUserTransform();
      viewer.setUserTransform(pivot, rotateDeg);
    });
  }
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
    const { pivot, rotateDeg } = readUserTransform();
    return {
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
      center: paramInputs.center.checked,
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
    $("btn-generate").textContent = "Converting…";
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

  let reconstructions = []; // {id,label,msg,params,visible}
  let activeReconId = null;
  let reconSeq = 0;
  const MODE_LABELS = {
    direct: "Direct",
    voxel: "Voxel",
    pixel: "Pixel Perfect",
  };

  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.jobId !== jobId) return;
    busy = false;
    $("btn-generate").disabled = false;
    $("btn-generate").textContent = "Generate";
    $("progress").hidden = true;
    $("progress-bar").style.width = "0";
    if (!msg.ok) {
      alert("Conversion failed: " + msg.error);
      return;
    }
    const id = ++reconSeq;
    const p = lastParams ?? {};
    let label = MODE_LABELS[p.mode] ?? "Direct";
    if (spriteImageName) label = "Sprite";
    else if (p.mode === "voxel") label += ` ${p.voxelRes}${p.voxelSurface === "mc" ? " MC" : ""}`;
    else if (p.mode === "direct" && p.primitiveMode === "both") label += " +squares";
    // a new generation hides the previous reconstructions so only the fresh
    // result is visible (they can be re-enabled from the list)
    for (const r of reconstructions) r.visible = false;
    reconstructions.push({ id, label: `${label} #${id}`, msg, params: p, visible: true });
    if (reconstructions.length > 8) {
      const removed = reconstructions.shift();
      if (removed.id === activeReconId) activeReconId = null;
    }
    setActiveRecon(id);
    renderReconList();
    updateOverlays();
  };

  function setActiveRecon(id) {
    if (activeReconId !== id) editState.selection.clear();
    activeReconId = id;
    const e = reconstructions.find((r) => r.id === id);
    lastResult = e ? e.msg : null;
    lastParams = e ? e.params : lastParams;
    setOutputReady(!!e);
    if (e) renderGenStats(e.msg.stats, e.params);
    else renderStats($("gen-stats"), {});
    refreshEditUI();
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
      vis.title = "Show/hide this reconstruction in the viewport";
      vis.addEventListener("change", () => {
        e.visible = vis.checked;
        updateOverlays();
      });
      const act = document.createElement("input");
      act.type = "radio";
      act.name = "recon-active";
      act.checked = e.id === activeReconId;
      act.title = "Use this reconstruction for the output";
      act.addEventListener("change", () => {
        if (act.checked) setActiveRecon(e.id);
      });
      const label = document.createElement("span");
      label.className = "recon-label";
      label.textContent = e.label;
      const count = document.createElement("span");
      count.className = "recon-count";
      count.textContent = e.msg.decorations.length.toLocaleString();
      const del = document.createElement("button");
      del.className = "recon-del";
      del.textContent = "✕";
      del.title = "Remove this reconstruction";
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

  function renderGenStats(s, p) {
    const models = Math.ceil(s.placements / MAX_DECORATIONS_PER_MODEL);
    const KIND_LABELS = {
      triangle: "Triangles", square: "Cuboids", plane: "Planes",
      sphere: "Spheres", cylinder: "Cylinders", cone: "Cones", prism: "Prisms",
    };
    const kindRows = {};
    if (s.byKind && Object.keys(s.byKind).length > 1) {
      for (const [k, n] of Object.entries(s.byKind)) {
        kindRows[KIND_LABELS[k] ?? k] = n.toLocaleString();
      }
    }
    renderStats($("gen-stats"), {
      [s.spritePixels != null ? "Opaque pixels" : "Source triangles"]:
        s.sourceTriangles.toLocaleString(),
      ...(p?.decimate > 0
        ? { "After decimation": s.afterDecimation.toLocaleString() }
        : {}),
      ...(p?.mode === "voxel"
        ? {
            Voxels: (s.voxels ?? 0).toLocaleString(),
            ...(s.voxelsCulled
              ? { "Interior culled": s.voxelsCulled.toLocaleString() }
              : {}),
            ...(s.sdfCells
              ? { "MC cells": s.sdfCells.toLocaleString(),
                  "Surface triangles": s.afterSubdivision.toLocaleString() }
              : {}),
            "Voxel size (m)": s.voxelSize,
          }
        : p?.mode === "pixel"
          ? {
              Texels: (s.texels ?? 0).toLocaleString(),
              "After merge": s.afterMerge.toLocaleString(),
            }
          : {
              "After subdivision": s.afterSubdivision.toLocaleString(),
              "After merge": s.afterMerge.toLocaleString(),
            }),
      Decorations: s.placements.toLocaleString(),
      ...kindRows,
      ...(s.squareApprox
        ? {
            "Square approximations": {
              value: s.squareApprox.toLocaleString(),
              warn: true,
            },
          }
        : {}),
      "Unique colors": s.uniqueColors,
      "Models (≤999 each)": models,
      ...(s.capSplit
        ? { "Split for zoom ≤ 50": s.capSplit.toLocaleString() }
        : {}),
      ...(s.budgetMerged
        ? { "Merged for budget": s.budgetMerged.toLocaleString() }
        : {}),
      ...(s.transparentSkipped
        ? { "Transparent skipped": s.transparentSkipped.toLocaleString() }
        : {}),
      ...(s.dropped
        ? {
            "Dropped (budget)": {
              value: s.dropped.toLocaleString(),
              warn: true,
            },
          }
        : {}),
      ...(s.degenerate ? { "Degenerate skipped": s.degenerate } : {}),
      ...(s.bounds
        ? { "Size (m)": `${s.bounds.x} × ${s.bounds.y} × ${s.bounds.z}` }
        : {}),
    });
  }

  function overlayOffsetOf(e) {
    const off = e.msg.stats.centerOffset;
    const flip = (e.params?.flipZ ?? true) ? 1 : -1;
    return off ? { x: -off.x, y: -off.y, z: flip * off.z } : null;
  }

  let pickMesh = null; // invisible mesh of the ACTIVE reconstruction (picking)

  function updateOverlays() {
    const mode = $("p-overlay").value;
    const entries = reconstructions.map((e) => {
      let colors = e.msg.colors && new Float32Array(e.msg.colors);
      // highlight the edit selection on the active reconstruction
      if (e.id === activeReconId && editState.selection.size && e.msg.owners && colors) {
        for (let t = 0; t < e.msg.owners.length; t++) {
          if (!editState.selection.has(e.msg.owners[t])) continue;
          for (let k = 0; k < 9; k += 3) {
            colors[t * 9 + k] = 1.0;
            colors[t * 9 + k + 1] = 0.45;
            colors[t * 9 + k + 2] = 0.05;
          }
        }
      }
      return {
        visible: e.visible,
        positions: e.msg.positions && new Float32Array(e.msg.positions),
        colors,
        offset: overlayOffsetOf(e),
      };
    });
    viewer.setOverlays(entries, mode);
    // picking mesh for edit mode
    pickMesh = null;
    const active = reconstructions.find((r) => r.id === activeReconId);
    if (active && active.msg.positions) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(active.msg.positions), 3));
      pickMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      const off = overlayOffsetOf(active);
      if (off) pickMesh.position.set(off.x, off.y, off.z);
      pickMesh.updateMatrixWorld(true);
    }
    if (!currentObject) viewer.frame();
  }

  $("p-overlay").addEventListener("change", updateOverlays);
  $("p-showsrc").addEventListener("change", () =>
    viewer.setModelVisible($("p-showsrc").checked),
  );

  // ---------- viewport interaction: edit mode ----------

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  function ndcOf(clientX, clientY) {
    const rect = $("canvas").getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * 2 - 1,
      y: -((clientY - rect.top) / rect.height) * 2 + 1,
    };
  }

  function castAt(ev, target) {
    if (!target) return null;
    const n = ndcOf(ev.clientX, ev.clientY);
    pointerNdc.x = n.x;
    pointerNdc.y = n.y;
    raycaster.setFromCamera(pointerNdc, viewer.camera);
    const hits = raycaster.intersectObject(target, true);
    return hits[0] ?? null;
  }

  // marquee (drag) selection state
  let marquee = null; // { x0, y0, el }

  $("canvas").addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !editState.on || gizmoDragging) return;
    if ($("ed-tool").value === "select") {
      marquee = { x0: ev.clientX, y0: ev.clientY, el: null, moved: false };
    } else {
      handleEditClick(ev);
    }
  });
  window.addEventListener("pointermove", (ev) => {
    if (!marquee) return;
    const dx = ev.clientX - marquee.x0, dy = ev.clientY - marquee.y0;
    if (!marquee.moved && Math.hypot(dx, dy) < 5) return;
    marquee.moved = true;
    if (!marquee.el) {
      marquee.el = document.createElement("div");
      marquee.el.id = "marquee";
      document.body.appendChild(marquee.el);
    }
    const x = Math.min(marquee.x0, ev.clientX), y = Math.min(marquee.y0, ev.clientY);
    Object.assign(marquee.el.style, {
      left: x + "px", top: y + "px",
      width: Math.abs(dx) + "px", height: Math.abs(dy) + "px",
    });
  });
  window.addEventListener("pointerup", (ev) => {
    if (!marquee) return;
    const m = marquee;
    marquee = null;
    m.el?.remove();
    if (!editState.on) return;
    if (!m.moved) {
      handleEditClick(ev);
      return;
    }
    boxSelect(m.x0, m.y0, ev.clientX, ev.clientY, ev.shiftKey);
  });

  // Box selection: primitives whose display position projects inside the
  // rectangle AND is actually visible (not occluded by other geometry).
  function boxSelect(x0, y0, x1, y1, additive) {
    const e = activeRecon();
    if (!e || !pickMesh) return;
    const a = ndcOf(Math.min(x0, x1), Math.min(y0, y1));
    const b = ndcOf(Math.max(x0, x1), Math.max(y0, y1));
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    const off = overlayOffsetOf(e) ?? { x: 0, y: 0, z: 0 };
    const flip = (e.params?.flipZ ?? true) ? -1 : 1;
    const filterOn = $("ed-filteren").checked;
    const fc = $("ed-filtercolor").value;
    const fr = parseInt(fc.slice(1, 3), 16), fg = parseInt(fc.slice(3, 5), 16), fb = parseInt(fc.slice(5, 7), 16);
    const ftol = parseFloat($("ed-filtertol").value) || 40;
    if (!additive) editState.selection.clear();
    const v = new THREE.Vector3();
    const camPos = viewer.camera.position;
    for (let i = 0; i < e.msg.decorations.length; i++) {
      const d = e.msg.decorations[i];
      if (filterOn) {
        const dr = ((d.color >> 16) & 255) - fr, dg = ((d.color >> 8) & 255) - fg, db = (d.color & 255) - fb;
        if (Math.sqrt(dr * dr + dg * dg + db * db) > ftol) continue;
      }
      // display-space center of the primitive
      v.set(d.position.x / 10 + off.x, d.position.y / 10 + off.y, (d.position.z / 10) * flip + off.z);
      const world = v.clone();
      v.project(viewer.camera);
      if (v.z > 1 || v.x < minX || v.x > maxX || v.y < minY || v.y > maxY) continue;
      // occlusion: the first surface along the ray must belong to this
      // primitive (or lie at the same depth)
      const dir = world.clone().sub(camPos);
      const dist = dir.length();
      raycaster.set(camPos, dir.normalize());
      const hits = raycaster.intersectObject(pickMesh);
      if (hits.length) {
        const h = hits[0];
        const owner = e.msg.owners[h.faceIndex];
        if (owner !== i && h.distance < dist - Math.max(0.03, dist * 0.02)) continue;
      }
      editState.selection.add(i);
    }
    refreshEditUI();
    updateOverlays();
    syncGizmo();
  }

  // ---------- edit mode ----------

  const editState = { on: false, selection: new Set() };

  // undo stack (Ctrl+Z): decoration-array snapshots, capped
  const undoStack = [];
  function pushUndo() {
    const e = activeRecon();
    if (!e) return;
    undoStack.push({
      reconId: e.id,
      decorations: e.msg.decorations.map((d) => ({
        ...d,
        position: { ...d.position },
        rotationDeg: { ...d.rotationDeg },
        scale: { ...d.scale },
      })),
    });
    if (undoStack.length > 25) undoStack.shift();
  }
  function undo() {
    const e = activeRecon();
    const snap = undoStack.at(-1);
    if (!e || !snap || snap.reconId !== e.id) return;
    undoStack.pop();
    e.msg.decorations = snap.decorations;
    editState.selection.clear();
    rebuildActiveRecon();
    refreshEditUI();
    syncGizmo();
    showToast("Undone");
  }

  // keyboard: Delete removes selection, Ctrl+Z undoes
  window.addEventListener("keydown", (ev) => {
    if (!editState.on) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      $("ed-delete").click();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      undo();
    }
  });

  // ---------- transform gizmo (Move / Rotate / Scale) ----------

  const gizmoProxy = new THREE.Object3D();
  viewer.scene.add(gizmoProxy);
  const gizmo = new TransformControls(viewer.camera, $("canvas"));
  viewer.scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);
  gizmo.setMode("translate");
  gizmo.enabled = false;
  let gizmoDragging = false;
  gizmo.addEventListener("dragging-changed", (ev) => {
    gizmoDragging = ev.value;
    viewer.controls.enabled = !ev.value;
    if (ev.value) pushUndo(); // snapshot at drag start
  });
  let gizmoRaf = 0;
  gizmo.addEventListener("objectChange", () => {
    if (gizmoRaf) return;
    gizmoRaf = requestAnimationFrame(() => {
      gizmoRaf = 0;
      applyGizmoToSelection();
    });
  });

  const FLIP = new THREE.Matrix4().makeScale(1, 1, -1);

  // decoration -> display transform on the proxy
  function syncGizmo() {
    const e = activeRecon();
    const single = e && editState.selection.size === 1
      ? e.msg.decorations[[...editState.selection][0]]
      : null;
    if (!single || !editState.on) {
      gizmo.detach();
      gizmo.enabled = false;
      return;
    }
    const off = overlayOffsetOf(e) ?? { x: 0, y: 0, z: 0 };
    const flip = (e.params?.flipZ ?? true) ? -1 : 1;
    gizmoProxy.position.set(
      single.position.x / 10 + off.x,
      single.position.y / 10 + off.y,
      (single.position.z / 10) * flip + off.z,
    );
    const RAD = Math.PI / 180;
    const eul = new THREE.Euler(
      single.rotationDeg.x * RAD, single.rotationDeg.y * RAD, single.rotationDeg.z * RAD,
      e.params?.eulerOrder === "XYZ" ? "XYZ" : "YXZ",
    );
    const m = new THREE.Matrix4().makeRotationFromEuler(eul);
    if (flip === -1) m.premultiply(FLIP).multiply(FLIP); // F·R·F mirror conjugation
    gizmoProxy.quaternion.setFromRotationMatrix(m);
    gizmoProxy.scale.set(
      Math.max(0.01, single.scale.x),
      Math.max(0.01, single.scale.y),
      Math.max(0.01, single.scale.z),
    );
    gizmoProxy.updateMatrixWorld(true);
    gizmo.attach(gizmoProxy);
    gizmo.enabled = true;
    gizmo.setMode($("ed-gizmo").value);
  }

  // display transform on the proxy -> decoration values
  function applyGizmoToSelection() {
    const e = activeRecon();
    if (!e || editState.selection.size !== 1) return;
    const d = e.msg.decorations[[...editState.selection][0]];
    const off = overlayOffsetOf(e) ?? { x: 0, y: 0, z: 0 };
    const flip = (e.params?.flipZ ?? true) ? -1 : 1;
    const r4 = (v) => Math.round(v * 10000) / 10000;
    d.position.x = r4((gizmoProxy.position.x - off.x) * 10);
    d.position.y = r4((gizmoProxy.position.y - off.y) * 10);
    d.position.z = r4((gizmoProxy.position.z - off.z) * 10 * flip);
    const m = new THREE.Matrix4().makeRotationFromQuaternion(gizmoProxy.quaternion);
    if (flip === -1) m.premultiply(FLIP).multiply(FLIP);
    const eul = new THREE.Euler().setFromRotationMatrix(
      m, e.params?.eulerOrder === "XYZ" ? "XYZ" : "YXZ",
    );
    const DEG = 180 / Math.PI;
    const norm = (v) => { let x = r4(v * DEG) % 360; if (x < 0) x += 360; return x; };
    d.rotationDeg.x = norm(eul.x);
    d.rotationDeg.y = norm(eul.y);
    d.rotationDeg.z = norm(eul.z);
    d.scale.x = r4(Math.min(50, Math.max(0.01, gizmoProxy.scale.x)));
    d.scale.y = r4(Math.min(50, Math.max(0.01, gizmoProxy.scale.y)));
    d.scale.z = r4(Math.min(50, Math.max(0.01, gizmoProxy.scale.z)));
    rebuildActiveRecon();
    refreshEditUI();
  }

  $("ed-gizmo").addEventListener("change", () => {
    gizmo.setMode($("ed-gizmo").value);
  });

  // color picker for the current selection
  $("ed-selcolor").addEventListener("change", () => {
    const e = activeRecon();
    if (!e || !editState.selection.size) return;
    pushUndo();
    const color = parseInt($("ed-selcolor").value.slice(1), 16);
    for (const i of editState.selection) e.msg.decorations[i].color = color;
    rebuildActiveRecon();
  });

  function activeRecon() {
    return reconstructions.find((r) => r.id === activeReconId) ?? null;
  }

  function rebuildActiveRecon() {
    const e = activeRecon();
    if (!e) return;
    const { positions, colors, owners } = buildPreview(e.msg.decorations, e.params);
    e.msg.positions = positions;
    e.msg.colors = colors;
    e.msg.owners = owners;
    e.msg.stats.placements = e.msg.decorations.length;
    lastResult = e.msg;
    setOutputReady(true);
    renderGenStats(e.msg.stats, e.params);
    renderReconList();
    updateOverlays();
  }

  function refreshEditUI() {
    const e = activeRecon();
    $("edit-panel").hidden = !e;
    if (!e) { editState.on = false; $("ed-enable").checked = false; }
    $("edit-tools").hidden = !editState.on;
    $("ed-place").hidden = $("ed-tool").value !== "place";
    const n = editState.selection.size;
    let selText = "Nothing selected";
    if (n === 1 && e) {
      const idx = [...editState.selection][0];
      const d = e.msg.decorations[idx];
      selText = `Selected: ${MODEL_NAMES[d?.kind] ?? "Roof Component"} #${idx + 1}`;
    } else if (n > 1) {
      selText = `${n} primitives selected`;
    }
    $("ed-selinfo").textContent = selText;
    $("ed-delete").disabled = n === 0;
    $("ed-delete").textContent = n ? `Delete selected (${n})` : "Delete selected";
    $("ed-colorrow").hidden = n === 0;
    const single = n === 1 && e ? e.msg.decorations[[...editState.selection][0]] : null;
    $("ed-transform").hidden = !single;
    if (single) {
      $("ed-px").value = single.position.x; $("ed-py").value = single.position.y; $("ed-pz").value = single.position.z;
      $("ed-rx").value = single.rotationDeg.x; $("ed-ry").value = single.rotationDeg.y; $("ed-rz").value = single.rotationDeg.z;
      $("ed-zx").value = single.scale.x; $("ed-zy").value = single.scale.y; $("ed-zz").value = single.scale.z;
      $("ed-selcolor").value = "#" + single.color.toString(16).padStart(6, "0");
    }
  }

  function handleEditClick(ev) {
    const e = activeRecon();
    if (!e) return;
    if ($("ed-tool").value === "select") {
      const hit = castAt(ev, pickMesh);
      if (!hit) {
        if (!ev.shiftKey) {
          editState.selection.clear();
          refreshEditUI();
          updateOverlays();
          syncGizmo();
        }
        return;
      }
      const owner = e.msg.owners[hit.faceIndex];
      if (!ev.shiftKey) editState.selection.clear();
      if (editState.selection.has(owner)) editState.selection.delete(owner);
      else editState.selection.add(owner);
      refreshEditUI();
      updateOverlays();
      syncGizmo();
    } else {
      // place: hit the source model or the reconstruction
      const hit = castAt(ev, currentObject) ?? castAt(ev, pickMesh);
      if (!hit) return;
      const off = overlayOffsetOf(e) ?? { x: 0, y: 0, z: 0 };
      const flip = (e.params?.flipZ ?? true) ? -1 : 1;
      // display -> centered target space -> decoration units
      const tx = hit.point.x - off.x, ty = hit.point.y - off.y, tz = (hit.point.z - off.z) * flip;
      const s = Math.max(0.01, parseFloat($("ed-size").value) || 0.5);
      const kind = $("ed-kind").value;
      const hex = $("ed-color").value;
      const color = parseInt(hex.slice(1), 16);
      const scale =
        kind === "triangle" ? { x: 0.01, y: +(s * 7.7).toFixed(4), z: +(s * 3.704).toFixed(4) } :
        kind === "plane" ? { x: s * 10, y: 1, z: s * 10 } :
        kind === "prism" ? { x: +(s / 0.075).toFixed(4), y: s * 10, z: +(s / 0.075).toFixed(4) } :
        { x: s * 10, y: s * 10, z: s * 10 };
      pushUndo();
      e.msg.decorations.push({
        kind,
        position: { x: +(tx * 10).toFixed(4), y: +(ty * 10).toFixed(4), z: +(tz * 10).toFixed(4) },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale,
        color,
      });
      rebuildActiveRecon();
      refreshEditUI();
    }
  }

  let savedMouseButtons = null;
  $("ed-enable").addEventListener("change", () => {
    editState.on = $("ed-enable").checked;
    if (!editState.on) editState.selection.clear();
    // while editing, the left mouse button belongs to the edit tools; orbit
    // the camera with the right mouse button instead
    if (editState.on && !savedMouseButtons) {
      savedMouseButtons = { ...viewer.controls.mouseButtons };
      viewer.controls.mouseButtons.LEFT = null;
      viewer.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    } else if (!editState.on && savedMouseButtons) {
      Object.assign(viewer.controls.mouseButtons, savedMouseButtons);
      savedMouseButtons = null;
    }
    refreshEditUI();
    updateOverlays();
    syncGizmo();
  });
  $("ed-tool").addEventListener("change", () => {
    refreshEditUI();
    syncGizmo();
  });
  $("ed-delete").addEventListener("click", () => {
    const e = activeRecon();
    if (!e || !editState.selection.size) return;
    pushUndo();
    e.msg.decorations = e.msg.decorations.filter((_, i) => !editState.selection.has(i));
    editState.selection.clear();
    rebuildActiveRecon();
    refreshEditUI();
    syncGizmo();
  });
  for (const [id, apply] of [
    ["ed-px", (d, v) => (d.position.x = v)], ["ed-py", (d, v) => (d.position.y = v)], ["ed-pz", (d, v) => (d.position.z = v)],
    ["ed-rx", (d, v) => (d.rotationDeg.x = v)], ["ed-ry", (d, v) => (d.rotationDeg.y = v)], ["ed-rz", (d, v) => (d.rotationDeg.z = v)],
    ["ed-zx", (d, v) => (d.scale.x = v)], ["ed-zy", (d, v) => (d.scale.y = v)], ["ed-zz", (d, v) => (d.scale.z = v)],
  ]) {
    $(id).addEventListener("input", () => {
      const e = activeRecon();
      if (!e || editState.selection.size !== 1) return;
      const d = e.msg.decorations[[...editState.selection][0]];
      apply(d, parseFloat($(id).value) || 0);
      rebuildActiveRecon();
      syncGizmo();
    });
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
      label: `Edited #${id}`,
      msg: { decorations, stats, positions, colors, owners },
      params: e.params,
      visible: true,
    });
    editState.selection.clear();
    setActiveRecon(id);
    renderReconList();
    updateOverlays();
    refreshEditUI();
    syncGizmo();
    showToast("Saved as new model");
  });

  // clear all generated models (source model stays)
  $("btn-clear-recons").addEventListener("click", () => {
    editState.selection.clear();
    clearReconstructions();
    refreshEditUI();
  });

  // ---------- output: .gia download or primitive data ----------

  // Enables/disables whichever output the page provides.
  function setOutputReady(ready) {
    const dl = $("btn-download");
    if (dl) dl.disabled = !ready;
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
            ? `${lastResult.decorations.length} primitive(s) generated`
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

  // Model Name/ID of the primitive's base decoration model, as defined in the
  // provided base .gia files.
  const MODEL_NAMES = {
    triangle: "Roof Component",
    square: "Cuboid",
    plane: "Plane",
    sphere: "Sphere",
    cylinder: "Cylinder",
    cone: "Cone",
    prism: "Triangular Prism",
  };
  const modelName = (d) => MODEL_NAMES[d.kind] ?? MODEL_NAMES.triangle;
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
      cb.title = "Mark as manually processed";
      cb.addEventListener("change", () => {
        processed[i] = cb.checked;
        tr.classList.toggle("done", cb.checked);
      });
      tdCheck.appendChild(cb);
      tr.appendChild(tdCheck);

      // [text, groupStart?]
      const cells = [
        [String(i + 1)],
        [modelName(d)],
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
      more.textContent = `Show remaining ${decs.length - renderedRows} rows`;
  }

  // double-click any value cell to copy just that value
  $("prim-table")?.addEventListener("dblclick", async (e) => {
    const td = e.target.closest("td");
    if (!td || td.querySelector("input")) return;
    const value = td.dataset.copy ?? td.textContent.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast(`Copied ${value}`);
    } catch (err) {
      showToast("Clipboard unavailable");
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
    $("prim-count").textContent = `${lastResult.decorations.length} primitives`;
    $("prim-note").textContent =
      "In the game, create an Empty Model with an XYZ zoom of 0.1 and add these primitives to it. " +
      "Position and zoom are in units of 0.1 m; rotation is in degrees. " +
      "Double-click any value to copy it to the clipboard.";
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
      $("btn-copy-json").textContent = "Copied ✓";
      setTimeout(() => {
        $("btn-copy-json").textContent = "Copy JSON";
      }, 1500);
    } catch (e) {
      alert("Clipboard unavailable: " + e.message);
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
} // end initApp
