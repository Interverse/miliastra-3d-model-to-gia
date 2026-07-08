// In-app "Score current model" action (js/ui-shell.js Result panel).
//
// Runs the same 26-view silhouette-IoU + 6-face ΔE2000 pass the standalone
// test harness uses (test/metrics.js + test/views26.js — see
// docs/decoration-reduction-plan.md, "Phase 1.5 — Similarity test suite")
// against whatever is currently loaded and converted. This is how the three
// reference models too large for test/similarity-harness.html (amber,
// higokumaru, stylized_emerald_sword — over the 10 MB harness limit) still
// get a FaithScore: scored manually, in-app, one at a time.
import * as THREE from "three";
import { silhouetteIoU, meanDeltaE, faithScore } from "../test/metrics.js";
import {
  VIEW_DIRS, FACE_VIEW_INDEXES, buildOrthoCamera, renderToPixels,
  maskFromSilhouette, unionBox,
} from "../test/views26.js";

const RENDER_SIZE = 512;
const WHITE_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });

// viewer: the app's live Viewer (js/viewer.js) — rendered as-is (its own
// renderer, its own lights, the model's live user transform), with the
// helper grid/axes/overlay/selection temporarily hidden so they don't
// pollute the silhouette. reconPositions/reconColors: the active
// reconstruction's buildPreview() output (js/preview-mesh.js) — already in
// the same display space the viewer's own overlay uses, so no re-alignment
// is needed.
export function scoreCurrentModel(viewer, { reconPositions, reconColors }) {
  const { renderer, scene, modelGroup } = viewer;

  const reconGeo = new THREE.BufferGeometry();
  reconGeo.setAttribute("position", new THREE.BufferAttribute(reconPositions, 3));
  reconGeo.setAttribute("color", new THREE.BufferAttribute(reconColors, 3));
  const reconMesh = new THREE.Mesh(
    reconGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  );
  const reconScene = new THREE.Scene();
  reconScene.background = new THREE.Color(0);
  reconScene.add(reconMesh);

  const boxSrc = new THREE.Box3().setFromObject(modelGroup);
  const boxRecon = new THREE.Box3().setFromBufferAttribute(reconGeo.attributes.position);
  const box = unionBox(boxSrc, boxRecon);

  // Borrow the live scene for the source pass — hide everything except the
  // model itself so the grid/axes/overlay/selection helpers don't leak into
  // the silhouette or the union bounding box.
  const hidden = [viewer.grid, viewer.axes, viewer.ref1m, viewer.overlayGroup, viewer.selGroup];
  const prevVisible = hidden.map((o) => o.visible);
  for (const o of hidden) o.visible = false;
  const prevModelVisible = modelGroup.visible;
  modelGroup.visible = true;

  let iouSum = 0, minIoU = Infinity;
  const faceDEs = [];

  try {
    for (let i = 0; i < VIEW_DIRS.length; i++) {
      const dir = VIEW_DIRS[i];
      const cam = buildOrthoCamera(dir, box, 1);

      scene.overrideMaterial = WHITE_MAT;
      reconScene.overrideMaterial = WHITE_MAT;
      const maskA = maskFromSilhouette(renderToPixels(renderer, scene, cam, RENDER_SIZE));
      const maskB = maskFromSilhouette(renderToPixels(renderer, reconScene, cam, RENDER_SIZE));
      const iou = silhouetteIoU(maskA, maskB);
      iouSum += iou;
      if (iou < minIoU) minIoU = iou;

      if (FACE_VIEW_INDEXES.includes(i)) {
        scene.overrideMaterial = null;
        reconScene.overrideMaterial = null;
        // srgb:true: offscreen render targets read back raw linear values —
        // encode to display sRGB before feeding the Lab-based ΔE (see
        // test/views26.js renderToPixels for the full explanation).
        const colA = renderToPixels(renderer, scene, cam, RENDER_SIZE, { srgb: true });
        const colB = renderToPixels(renderer, reconScene, cam, RENDER_SIZE, { srgb: true });
        const intersection = new Uint8Array(maskA.length);
        for (let p = 0; p < intersection.length; p++) intersection[p] = maskA[p] && maskB[p] ? 1 : 0;
        faceDEs.push(meanDeltaE(colA, colB, intersection));
      }
    }
  } finally {
    scene.overrideMaterial = null;
    hidden.forEach((o, idx) => { o.visible = prevVisible[idx]; });
    modelGroup.visible = prevModelVisible;
    reconGeo.dispose();
    reconMesh.material.dispose();
  }

  const meanIoU = iouSum / VIEW_DIRS.length;
  const meanDE = faceDEs.reduce((a, b) => a + b, 0) / faceDEs.length;
  return { faithScore: faithScore(meanIoU, meanDE), meanIoU, minIoU, meanDeltaE: meanDE };
}
