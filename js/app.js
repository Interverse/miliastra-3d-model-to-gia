// App wiring: file loading, parameters, worker dispatch, stats, download.
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { Viewer } from './viewer.js';
import { extractMeshes } from './extract.js';
import { buildGia, splitIntoModels, MAX_DECORATIONS_PER_MODEL, TRIANGLE_MODEL_ID, SQUARE_MODEL_ID } from '../engine/gia/gia-writer.js';
import { PRESETS } from '../engine/convert/converter.js';

// Initialize the app against an already-rendered shell (see ui-shell.js).
// mode: 'gia' (download button builds a .gia file) or 'primitives' (the
// generated primitive records are displayed instead; no download).
export function initApp({ mode = 'gia' } = {}) {

const $ = (id) => document.getElementById(id);
const viewer = new Viewer($('canvas'));
const worker = new Worker(new URL('./convert-worker.js', import.meta.url), { type: 'module' });

let currentObject = null;     // three.js object
let currentName = 'model';
let extracted = null;         // { meshes, triangleCount }
let lastResult = null;        // worker result
let lastParams = null;        // params used for lastResult
let jobId = 0;
let busy = false;

// ---------- file loading ----------

const fileInput = $('file-input');
const filedrop = $('filedrop');
fileInput.addEventListener('change', () => loadFiles([...fileInput.files]));
for (const evt of ['dragover', 'dragleave', 'drop']) {
  document.body.addEventListener(evt, (e) => {
    e.preventDefault();
    filedrop.classList.toggle('dragover', evt === 'dragover');
    if (evt === 'drop') loadFiles([...e.dataTransfer.files]);
  });
}

// Persistent file library: models, .mtl, and textures accumulate across
// uploads (keyed by lower-case basename), so textures can arrive before or
// after the model. Every upload re-resolves the current model against it.
const MODEL_RE = /\.(fbx|obj|glb|gltf|stl)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tga)$/i;
const fileLibrary = new Map();   // basename(lower) -> File
let currentModelName = null;     // basename(lower) of the active model
let urlMap = new Map();          // basename(lower) -> blob URL (rebuilt per load)
let texStatus = new Map();       // basename(lower) -> 'staged' | 'used' | 'applied' | 'sprite'
let loadSeq = 0;
let loadChain = Promise.resolve();
let spriteImageName = null;      // basename(lower) when in sprite mode
let spritePixels = null;         // { width, height, data } for the engine

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
  currentName = mainFile.name.replace(/\.[^.]+$/, '');

  // fresh blob URLs for the whole library
  for (const u of urlMap.values()) URL.revokeObjectURL(u);
  urlMap = new Map();
  for (const [name, f] of fileLibrary) urlMap.set(name, URL.createObjectURL(f));

  // resolve any URL a loader asks for (relative, absolute, windows paths)
  // against the library by basename
  const requested = new Set();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:')) return url;
    // Match by basename even for blob: URLs — loaders resolve relative
    // texture paths against the model's blob URL (e.g. "blob:…/C:\tex\a.png")
    const base = decodeURIComponent(url.split(/[\\/]/).pop().split('?')[0]).toLowerCase();
    let hit = urlMap.get(base);
    let hitKey = base;
    if (!hit && /\.[a-z0-9]{2,5}$/.test(base)) {
      // extension-insensitive fallback: a model referencing "sword_dif.tga"
      // is satisfied by an uploaded "sword_dif.png"
      const stem = base.replace(/\.[^.]+$/, '.');
      for (const key of urlMap.keys()) {
        if (key.startsWith(stem) && IMAGE_RE.test(key)) { hit = urlMap.get(key); hitKey = key; break; }
      }
    }
    if (hit) { requested.add(hitKey); return hit; }
    return url;
  });
  // .tga references route to TGALoader only when a real .tga was uploaded;
  // otherwise a stem-matched png/jpg substitute is decoded by TextureLoader
  const tgaInLib = [...fileLibrary.keys()].some((n) => n.endsWith('.tga'));
  manager.addHandler(/\.tga$/i, tgaInLib ? new TGALoader(manager) : new THREE.TextureLoader(manager));
  // track manager idleness — onLoad fires when every started item has
  // finished, including failed loads (e.g. textures the model references
  // but that weren't uploaded)
  let managerBusy = false;
  const idleResolvers = [];
  manager.onStart = () => { managerBusy = true; };
  manager.onLoad = () => {
    managerBusy = false;
    for (const r of idleResolvers.splice(0)) r();
  };

  try {
    const ext = mainFile.name.split('.').pop().toLowerCase();
    const url = urlMap.get(currentModelName);
    let object;
    if (ext === 'fbx') {
      object = await new FBXLoader(manager).loadAsync(url);
    } else if (ext === 'obj') {
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
        const mtls = [...fileLibrary.keys()].filter((n) => n.endsWith('.mtl'));
        if (mtls.length === 1) mtlName = mtls[0];
      }
      const loader = new OBJLoader(manager);
      if (mtlName) {
        const mtl = await new MTLLoader(manager).loadAsync(urlMap.get(mtlName));
        mtl.preload();
        loader.setMaterials(mtl);
      }
      object = await loader.loadAsync(url);
    } else if (ext === 'glb' || ext === 'gltf') {
      const gltf = await new GLTFLoader(manager).loadAsync(url);
      object = gltf.scene;
    } else if (ext === 'stl') {
      const geo = await new STLLoader(manager).loadAsync(url);
      object = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcccccc }));
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
    for (const n of images) texStatus.set(n, requested.has(n) ? 'used' : 'staged');
    const unreferenced = images.filter((n) => !requested.has(n));
    if (unreferenced.length === 1 && await applyFallbackTexture(object, unreferenced[0], ext, manager)) {
      texStatus.set(unreferenced[0], 'applied');
    }
    if (seq !== loadSeq) return;
    setModel(object);
    updateTextureList();
  } catch (err) {
    console.error(err);
    alert('Failed to load model: ' + err.message);
  }
}

// Apply a library image as base color map to UV-mapped meshes lacking one.
// Returns true if applied to at least one mesh.
async function applyFallbackTexture(object, texName, modelExt, manager) {
  const targets = [];
  object.traverse((n) => {
    if (!n.isMesh || !n.geometry?.getAttribute('uv')) return;
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    for (const m of mats) if (m && !m.map) targets.push(m);
  });
  if (!targets.length) return false;
  try {
    const isTga = /\.tga$/i.test(texName);
    const loader = isTga ? new TGALoader(manager) : new THREE.TextureLoader(manager);
    const tex = await loader.loadAsync(urlMap.get(texName));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    // glTF UVs expect flipY=false; other formats use flipY=true
    if (!isTga) tex.flipY = !(modelExt === 'glb' || modelExt === 'gltf');
    for (const m of targets) {
      m.map = tex;
      if (m.color) m.color.set(0xffffff); // don't tint the texture
      m.needsUpdate = true;
    }
    return true;
  } catch (e) {
    console.warn('fallback texture failed', e);
    return false;
  }
}

function updateTextureList() {
  const el = $('texture-list');
  el.innerHTML = '';
  const labels = {
    used: 'used by material',
    applied: 'applied (no map)',
    staged: currentModelName ? 'not referenced' : 'waiting for model',
    sprite: '3D sprite source',
  };
  let stagedImages = 0;
  for (const [name] of fileLibrary) {
    if (!IMAGE_RE.test(name)) continue;
    const status = name === spriteImageName ? 'sprite' : (texStatus.get(name) ?? 'staged');
    if (status === 'staged' && !currentModelName) stagedImages++;
    const row = document.createElement('div');
    row.className = 'tex-row';
    const n = document.createElement('span');
    n.className = 'tex-name';
    n.textContent = fileLibrary.get(name).name;
    const s = document.createElement('span');
    s.className = 'tex-status ' + status;
    s.textContent = labels[status];
    row.append(n, s);
    el.append(row);
  }
  $('btn-sprite').hidden = !(stagedImages > 0 && !currentModelName && !spriteImageName);
}

// ---------- 2D sprite -> 3D mode ----------

async function imageFileToPixels(file, maxSize = 512) {
  const bmp = await createImageBitmap(file);
  const w = Math.min(bmp.width, maxSize), h = Math.min(bmp.height, maxSize);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingEnabled = w !== bmp.width;
  cx.drawImage(bmp, 0, 0, w, h);
  return { width: w, height: h, data: cx.getImageData(0, 0, w, h).data };
}

function exitSpriteMode() {
  spriteImageName = null;
  spritePixels = null;
  $('sprite-params').hidden = true;
}

$('btn-sprite').addEventListener('click', async () => {
  const images = [...fileLibrary.keys()].filter((n) => IMAGE_RE.test(n));
  if (!images.length) return;
  const name = images[images.length - 1];
  const file = fileLibrary.get(name);
  try {
    spritePixels = await imageFileToPixels(file);
    spriteImageName = name;
    currentName = file.name.replace(/\.[^.]+$/, '');
    $('sprite-params').hidden = false;
    $('btn-generate').disabled = false;
    setOutputReady(false);
    lastResult = null;
    extracted = null;
    // display the sprite as a textured plane
    const tex = await new THREE.TextureLoader().loadAsync(URL.createObjectURL(file));
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    const px = parseFloat($('p-sprite-px').value) || 0.05;
    const w = spritePixels.width * px, h = spritePixels.height * px;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.05, side: THREE.DoubleSide }),
    );
    plane.position.y = h / 2;
    currentObject = plane;
    viewer.setModel(plane);
    viewer.setOverlay(null);
    $('drop-hint').hidden = true;
    renderStats($('model-info'), {
      'Sprite': file.name,
      'Pixels': `${spritePixels.width} × ${spritePixels.height}`,
      'Size (m)': `${(w).toFixed(2)} × ${(h).toFixed(2)}`,
    });
    renderStats($('gen-stats'), {});
    updateTextureList();
  } catch (e) {
    console.error(e);
    alert('Could not read image: ' + e.message);
  }
});

// ---------- clear / reset ----------

$('btn-clear').addEventListener('click', () => {
  loadSeq++; // cancels any in-flight load
  fileLibrary.clear();
  texStatus.clear();
  for (const u of urlMap.values()) URL.revokeObjectURL(u);
  urlMap = new Map();
  currentModelName = null;
  currentName = 'model';
  exitSpriteMode();
  currentObject = null;
  extracted = null;
  lastResult = null;
  viewer.setModel(null);
  viewer.setOverlay(null);
  $('btn-generate').disabled = true;
  setOutputReady(false);
  renderStats($('model-info'), {});
  renderStats($('gen-stats'), {});
  updateTextureList();
  $('file-input').value = '';
  $('drop-hint').hidden = false;
});

$('p-sprite-px').addEventListener('input', () => {
  // re-scale the preview plane
  if (!spriteImageName || !currentObject) return;
  const px = parseFloat($('p-sprite-px').value) || 0.05;
  const w = spritePixels.width * px, h = spritePixels.height * px;
  currentObject.geometry.dispose();
  currentObject.geometry = new THREE.PlaneGeometry(w, h);
  currentObject.position.y = h / 2;
});

function setModel(object) {
  currentObject = object;
  // FBX files are often authored in cm
  viewer.setModel(object);
  viewer.setOverlay(null);
  $('drop-hint').hidden = true;
  extracted = extractMeshes(object);
  lastResult = null;
  $('btn-generate').disabled = false;
  setOutputReady(false);
  renderStats($('model-info'), {
    'Meshes': extracted.meshCount,
    'Source triangles': extracted.triangleCount.toLocaleString(),
    'Textured': extracted.meshes.some((m) => m.texture) ? 'yes' : 'no',
  });
  renderStats($('gen-stats'), {});
}

// ---------- parameters ----------

const paramInputs = {
  unitScale: $('p-unit'),
  colorTolerance: $('p-tol'),
  maxSubdiv: $('p-subdiv'),
  snapDeg: $('p-snap'),
  maxDecorations: $('p-max'),
  merge: $('p-merge'),
  thinScale: $('p-thin'),
  planarAngleDeg: $('p-planar'),
  flipZ: $('p-flipz'),
  eulerOrder: $('p-euler'),
  center: $('p-center'),
  primitiveMode: $('p-prim'),
  decimate: $('p-decimate'),
  alphaCutoff: $('p-alpha'),
};

const liveLabels = { colorTolerance: 'v-tol', maxSubdiv: 'v-subdiv', snapDeg: 'v-snap' };
$('p-decimate').addEventListener('input', () => {
  const v = parseInt($('p-decimate').value, 10);
  $('v-decimate').textContent = v === 0 ? 'off' : v + '%';
});

// live user transform: mirror on the displayed model immediately
const transformIds = ['t-px', 't-py', 't-pz', 't-rx', 't-ry', 't-rz'];
function readUserTransform() {
  const n = (id) => parseFloat($(id).value) || 0;
  return {
    pivot: { x: n('t-px'), y: n('t-py'), z: n('t-pz') },
    rotateDeg: { x: n('t-rx'), y: n('t-ry'), z: n('t-rz') },
  };
}
for (const id of transformIds) {
  $(id).addEventListener('input', () => {
    const { pivot, rotateDeg } = readUserTransform();
    viewer.setUserTransform(pivot, rotateDeg);
  });
}
for (const [key, el] of Object.entries(paramInputs)) {
  el.addEventListener('input', () => {
    if (liveLabels[key]) $(liveLabels[key]).textContent = el.value;
    if (['colorTolerance', 'maxSubdiv', 'snapDeg', 'planarAngleDeg'].includes(key)) {
      $('p-preset').value = 'custom';
    }
  });
}

$('p-preset').addEventListener('change', () => {
  const preset = PRESETS[$('p-preset').value];
  if (!preset) return;
  paramInputs.colorTolerance.value = preset.colorTolerance;
  paramInputs.maxSubdiv.value = preset.maxSubdiv;
  paramInputs.snapDeg.value = preset.snapDeg;
  paramInputs.planarAngleDeg.value = preset.planarAngleDeg;
  $('v-tol').textContent = preset.colorTolerance;
  $('v-subdiv').textContent = preset.maxSubdiv;
  $('v-snap').textContent = preset.snapDeg;
});

function readParams() {
  const { pivot, rotateDeg } = readUserTransform();
  return {
    unitScale: parseFloat(paramInputs.unitScale.value) || 1,
    colorTolerance: parseFloat(paramInputs.colorTolerance.value),
    maxSubdiv: parseInt(paramInputs.maxSubdiv.value, 10),
    snapDeg: parseFloat(paramInputs.snapDeg.value),
    maxDecorations: Math.max(1, parseInt(paramInputs.maxDecorations.value, 10) || 4995),
    merge: paramInputs.merge.checked,
    thinScale: parseFloat(paramInputs.thinScale.value) || 0.01,
    planarAngleDeg: parseFloat(paramInputs.planarAngleDeg.value),
    flipZ: paramInputs.flipZ.checked,
    eulerOrder: paramInputs.eulerOrder.value,
    center: paramInputs.center.checked,
    primitiveMode: paramInputs.primitiveMode.value,
    decimate: (parseInt(paramInputs.decimate.value, 10) || 0) / 100,
    alphaCutoff: Math.min(1, Math.max(0, parseFloat(paramInputs.alphaCutoff.value) || 0)),
    pivot,
    rotateDeg,
  };
}

// ---------- generation ----------

$('btn-generate').addEventListener('click', () => {
  if ((!extracted && !spriteImageName) || busy) return;
  busy = true;
  $('btn-generate').disabled = true;
  $('btn-generate').textContent = 'Converting…';
  $('progress').hidden = false;
  $('progress-bar').style.width = '30%';
  const params = readParams();
  lastParams = params;
  const id = ++jobId;
  if (spriteImageName) {
    worker.postMessage({
      jobId: id,
      sprite: {
        texture: spritePixels,
        pixelSize: parseFloat($('p-sprite-px').value) || 0.05,
        thickness: parseFloat($('p-sprite-thick').value) || 0.1,
      },
      params,
    });
  } else {
    worker.postMessage({ jobId: id, meshes: extracted.meshes, params });
  }
});

worker.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.jobId !== jobId) return;
  busy = false;
  $('btn-generate').disabled = false;
  $('btn-generate').textContent = 'Generate';
  $('progress').hidden = true;
  $('progress-bar').style.width = '0';
  if (!msg.ok) {
    alert('Conversion failed: ' + msg.error);
    return;
  }
  lastResult = msg;
  setOutputReady(true);
  updateOverlay();
  const s = msg.stats;
  const models = Math.ceil(msg.decorations.length / MAX_DECORATIONS_PER_MODEL);
  renderStats($('gen-stats'), {
    [s.spritePixels != null ? 'Opaque pixels' : 'Source triangles']: s.sourceTriangles.toLocaleString(),
    ...(lastParams?.decimate > 0 ? { 'After decimation': s.afterDecimation.toLocaleString() } : {}),
    'After subdivision': s.afterSubdivision.toLocaleString(),
    'After merge': s.afterMerge.toLocaleString(),
    'Decorations': s.placements.toLocaleString(),
    ...(lastParams?.primitiveMode !== 'triangles' ? {
      'Squares': s.squares.toLocaleString(),
      'Triangles': s.triangles.toLocaleString(),
      ...(s.squareApprox ? { 'Square approximations': { value: s.squareApprox.toLocaleString(), warn: true } } : {}),
    } : {}),
    'Unique colors': s.uniqueColors,
    'Models (≤999 each)': models,
    ...(s.transparentSkipped ? { 'Transparent skipped': s.transparentSkipped.toLocaleString() } : {}),
    ...(s.dropped ? { 'Dropped (budget)': { value: s.dropped.toLocaleString(), warn: true } } : {}),
    ...(s.degenerate ? { 'Degenerate skipped': s.degenerate } : {}),
    ...(s.bounds ? { 'Size (m)': `${s.bounds.x} × ${s.bounds.y} × ${s.bounds.z}` } : {}),
  });
};

function updateOverlay() {
  if (!lastResult) return;
  const mode = $('p-overlay').value;
  // undo engine recentering (in display space) so the overlay sits on the model
  const off = lastResult.stats.centerOffset;
  const flip = (lastParams?.flipZ ?? true) ? 1 : -1;
  const offset = off ? { x: -off.x, y: -off.y, z: flip * off.z } : null;
  viewer.setOverlay(
    lastResult.positions && new Float32Array(lastResult.positions),
    lastResult.colors && new Float32Array(lastResult.colors),
    mode,
    offset,
  );
  if (!currentObject) viewer.frame();
}

$('p-overlay').addEventListener('change', updateOverlay);
$('p-showsrc').addEventListener('change', () => viewer.setModelVisible($('p-showsrc').checked));

// ---------- output: .gia download or primitive data ----------

// Enables/disables whichever output the page provides.
function setOutputReady(ready) {
  const dl = $('btn-download');
  if (dl) dl.disabled = !ready;
  const view = $('btn-view-prims');
  if (view) {
    view.disabled = !ready;
    processed = ready && lastResult ? new Array(lastResult.decorations.length).fill(false) : [];
    renderedRows = 0;
    if ($('prim-table')) $('prim-table').querySelector('tbody').innerHTML = '';
    if ($('prim-modal')) $('prim-modal').hidden = true;
    if ($('output-summary')) {
      $('output-summary').textContent = ready && lastResult
        ? `${lastResult.decorations.length} primitive(s) generated`
        : '';
    }
  }
}

$('btn-download')?.addEventListener('click', () => {
  if (!lastResult) return;
  const models = splitIntoModels(currentName, lastResult.decorations);
  const bytes = buildGia({
    models,
    exportName: currentName,
    collision: $('p-collision').checked,
  });
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = currentName + '.gia';
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
// provided base .gia files: square -> Cuboid (10009001), triangle -> Wall
// (20002125).
const modelName = (d) => d.kind === 'square' ? 'Cuboid' : 'Wall';
const modelId = (d) => d.kind === 'square' ? SQUARE_MODEL_ID : TRIANGLE_MODEL_ID;

function appendRows() {
  if (!lastResult) return;
  const decs = lastResult.decorations;
  const tbody = $('prim-table').querySelector('tbody');
  const frag = document.createDocumentFragment();
  const end = Math.min(decs.length, renderedRows + ROW_CHUNK);
  for (let i = renderedRows; i < end; i++) {
    const d = decs[i];
    const tr = document.createElement('tr');
    if (processed[i]) tr.classList.add('done');

    const tdCheck = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!processed[i];
    cb.title = 'Mark as manually processed';
    cb.addEventListener('change', () => {
      processed[i] = cb.checked;
      tr.classList.toggle('done', cb.checked);
    });
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);

    // [text, groupStart?]
    const cells = [
      [String(i + 1)],
      [modelName(d)],
      [String(modelId(d))],
      [d.kind],
      [fmtNum(d.position.x), true], [fmtNum(d.position.y)], [fmtNum(d.position.z)],
      [fmtNum(d.rotationDeg.x), true], [fmtNum(d.rotationDeg.y)], [fmtNum(d.rotationDeg.z)],
      [fmtNum(d.scale.x), true], [fmtNum(d.scale.y)], [fmtNum(d.scale.z)],
    ];
    for (const [text, grp] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      if (grp) td.className = 'grp-start';
      tr.appendChild(td);
    }
    const tdColor = document.createElement('td');
    tdColor.className = 'grp-start';
    const hex = '#' + d.color.toString(16).padStart(6, '0');
    tdColor.dataset.copy = hex;
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = hex;
    tdColor.append(sw, ' ' + hex);
    tr.appendChild(tdColor);
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  renderedRows = end;
  const more = $('btn-more-rows');
  more.hidden = renderedRows >= decs.length;
  if (!more.hidden) more.textContent = `Show remaining ${decs.length - renderedRows} rows`;
}

// double-click any value cell to copy just that value
$('prim-table')?.addEventListener('dblclick', async (e) => {
  const td = e.target.closest('td');
  if (!td || td.querySelector('input')) return;
  const value = td.dataset.copy ?? td.textContent.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showToast(`Copied ${value}`);
  } catch (err) {
    showToast('Clipboard unavailable');
  }
});

let toastTimer = null;
function showToast(text) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

$('btn-view-prims')?.addEventListener('click', () => {
  if (!lastResult) return;
  $('prim-count').textContent = `${lastResult.decorations.length} primitives`;
  $('prim-note').textContent =
    'In the game, create an Empty Model with an XYZ zoom of 0.1 and add these primitives to it. ' +
    'Position and zoom are in units of 0.1 m; rotation is in degrees. ' +
    'Double-click any value to copy it to the clipboard.';
  if (renderedRows === 0) appendRows();
  $('prim-modal').hidden = false;
  // pin the X/Y/Z subheader row exactly below the group header row so no
  // gap shows scrolled values behind the sticky headers
  requestAnimationFrame(() => {
    const h = $('prim-table').tHead.rows[0].offsetHeight;
    for (const th of $('prim-table').querySelectorAll('thead th.sub')) {
      th.style.top = h + 'px';
    }
  });
});
$('btn-close-modal')?.addEventListener('click', () => { $('prim-modal').hidden = true; });
$('prim-modal')?.addEventListener('click', (e) => {
  if (e.target === $('prim-modal')) $('prim-modal').hidden = true;
});
$('btn-more-rows')?.addEventListener('click', appendRows);

function primitivesJson() {
  return {
    name: currentName,
    units: 'position/zoom in units of 0.1 m; rotation in degrees (YXZ unless configured otherwise)',
    primitives: lastResult.decorations.map((d, i) => ({
      modelName: modelName(d),
      modelId: modelId(d),
      kind: d.kind,
      position: d.position,
      rotationDeg: d.rotationDeg,
      zoom: d.scale,
      color: '#' + d.color.toString(16).padStart(6, '0'),
      processed: !!processed[i],
    })),
  };
}

$('btn-copy-json')?.addEventListener('click', async () => {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(primitivesJson(), null, 1));
    $('btn-copy-json').textContent = 'Copied ✓';
    setTimeout(() => { $('btn-copy-json').textContent = 'Copy JSON'; }, 1500);
  } catch (e) {
    alert('Clipboard unavailable: ' + e.message);
  }
});

// ---------- stats ----------

function renderStats(el, obj) {
  el.innerHTML = '';
  for (const [k, v] of Object.entries(obj)) {
    const kEl = document.createElement('div');
    kEl.className = 'k';
    kEl.textContent = k;
    const vEl = document.createElement('div');
    const isObj = v && typeof v === 'object';
    vEl.className = 'v' + (isObj && v.warn ? ' warn' : '');
    vEl.textContent = isObj ? v.value : v;
    el.append(kEl, vEl);
  }
}

} // end initApp
