// 26-canonical-view camera helpers for the similarity test harness (see
// docs/decoration-reduction-plan.md, "Phase 1.5 — Similarity test suite").
//
// VIEW_DIRS below is the same 26-direction set used by the editor's
// visibility pass (js/editor/picking.js), but that copy is a module-private
// const (not exported) and tightly coupled to IdPicker's render-target
// bookkeeping — so per the harness spec it is duplicated here rather than
// imported. Keep the two in sync if the direction set ever changes.
import * as THREE from "three";

export const VIEW_DIRS = (() => {
  const dirs = [];
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        dirs.push(new THREE.Vector3(x, y, z).normalize());
      }
  return dirs; // 26 directions: 6 faces, 12 edges, 8 corners
})();

// The 6 axis-aligned entries of VIEW_DIRS (exactly one nonzero component) —
// used for the ΔE color-comparison pass.
export const FACE_VIEW_INDEXES = VIEW_DIRS.reduce((acc, d, i) => {
  const nonZero = [d.x, d.y, d.z].filter((v) => Math.abs(v) > 1e-6).length;
  if (nonZero === 1) acc.push(i);
  return acc;
}, []);

// Orthographic camera looking at `box`'s center from along `dir`, framing
// the box with a 5% margin on both axes. `dir` need not be normalized.
export function buildOrthoCamera(dir, box, aspect = 1) {
  const d = dir.clone().normalize();
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1e-6);
  const halfH = radius * 1.05; // 5% margin
  const halfW = halfH * aspect;
  const dist = radius * 4;
  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.001, dist * 2);
  cam.position.copy(center).addScaledVector(d, dist);
  cam.up.set(0, 1, 0);
  if (Math.abs(d.y) > 0.999) cam.up.set(0, 0, 1); // avoid degenerate lookAt
  cam.lookAt(center);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

// Perspective camera approximating a gameplay viewing distance: positioned
// ~3x the model's height away, with a FOV chosen so the model's largest
// dimension fills ~70% of the frame.
export function buildGameplayCamera(dir, box, aspect = 1) {
  const d = dir.clone().normalize();
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const height = Math.max(size.y, 1e-6);
  const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
  const dist = height * 3;
  const fovY = THREE.MathUtils.radToDeg(2 * Math.atan(maxDim / (1.4 * dist)));
  const cam = new THREE.PerspectiveCamera(
    Math.min(100, Math.max(10, fovY || 50)),
    aspect,
    Math.max(dist / 1000, 0.001),
    dist * 20,
  );
  cam.position.copy(center).addScaledVector(d, dist);
  cam.up.set(0, 1, 0);
  if (Math.abs(d.y) > 0.999) cam.up.set(0, 0, 1);
  cam.lookAt(center);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

// Render `scene` from `camera` into an offscreen size×size target and read
// the pixels back (RGBA, bottom-up rows — same convention WebGL always
// uses). Caller is responsible for scene.overrideMaterial / lighting setup.
//
// srgb: WebGLRenderTargets read back RAW LINEAR values by default (three
// only applies the linear->sRGB display encode for the canvas swap chain —
// the same reason IdPicker's exact-integer ID colors survive a render-
// target round trip in js/editor/picking.js). Pass srgb:true for any pass
// whose bytes will be compared/displayed as color (ΔE, thumbnails) so the
// GPU applies the same encode the on-screen viewport gets; leave it false
// for silhouette/ID passes where raw values are exactly what's wanted.
export function renderToPixels(renderer, scene, camera, size = 512, { srgb = false } = {}) {
  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType });
  if (srgb) rt.texture.colorSpace = THREE.SRGBColorSpace;
  const prevRt = renderer.getRenderTarget();
  const prevClearColor = new THREE.Color();
  renderer.getClearColor(prevClearColor);
  const prevClearAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(scene, camera);
  const buf = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
  renderer.setRenderTarget(prevRt);
  renderer.setClearColor(prevClearColor, prevClearAlpha);
  rt.dispose();
  return buf;
}

// Foreground mask from a white-on-black silhouette render: one boolean per
// pixel (length = pixels, not bytes).
export function maskFromSilhouette(rgba, threshold = 16) {
  const n = rgba.length / 4;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = rgba[i * 4] > threshold ? 1 : 0;
  return mask;
}

// Union of two Box3 (helper for readability at call sites).
export function unionBox(a, b) {
  return a.clone().union(b);
}
