// GPU ID-buffer picking — the approach used by professional editors.
//
// The reconstruction's triangles are rendered into an offscreen render
// target with each triangle flat-colored by its owning decoration's index
// (encoded as 24-bit RGB). The depth buffer then resolves occlusion
// naturally, which gives:
//   - pixel-exact click picking (pickAt),
//   - "visible only" box selection (ownersInRect),
//   - global visibility analysis for the remove-hidden tool
//     (visibleFromAround renders the scene from 26 viewpoints).

import * as THREE from "three";

const VIEW_DIRS = (() => {
  const dirs = [];
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        dirs.push(new THREE.Vector3(x, y, z).normalize());
      }
  return dirs; // 26 directions: faces, edges, corners
})();

export class IdPicker {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0);
    this.mesh = null;
    this.rt1 = new THREE.WebGLRenderTarget(1, 1);
    this.rt = null;
    this.rtW = 0;
    this.rtH = 0;
  }

  // positions: Float32Array xyz triplets (9 per triangle);
  // owners: Int32Array decoration index per triangle;
  // offset: display-space shift of the reconstruction.
  setGeometry(positions, owners, offset) {
    this.clearGeometry();
    if (!positions || !owners || owners.length === 0) return;
    const n = owners.length;
    const colors = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) {
      const id = owners[t] + 1; // 0 = background
      const r = ((id >> 16) & 255) / 255;
      const g = ((id >> 8) & 255) / 255;
      const b = (id & 255) / 255;
      for (let k = 0; k < 3; k++) {
        colors[t * 9 + k * 3] = r;
        colors[t * 9 + k * 3 + 1] = g;
        colors[t * 9 + k * 3 + 2] = b;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(
        positions instanceof Float32Array ? positions : new Float32Array(positions),
        3,
      ),
    );
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    );
    if (offset) this.mesh.position.set(offset.x, offset.y, offset.z);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  clearGeometry() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
  }

  get hasGeometry() {
    return !!this.mesh;
  }

  _render(camera, rt) {
    const prevRt = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.clear();
    this.renderer.render(this.scene, camera);
    this.renderer.setRenderTarget(prevRt);
  }

  // Decoration index under a canvas-CSS-pixel coordinate, or -1.
  pickAt(camera, x, y, w, h) {
    if (!this.mesh) return -1;
    camera.setViewOffset(w, h, Math.max(0, Math.min(w - 1, x)), Math.max(0, Math.min(h - 1, y)), 1, 1);
    this._render(camera, this.rt1);
    camera.clearViewOffset();
    const px = new Uint8Array(4);
    this.renderer.readRenderTargetPixels(this.rt1, 0, 0, 1, 1, px);
    return ((px[0] << 16) | (px[1] << 8) | px[2]) - 1;
  }

  _sizedRt(w, h) {
    if (!this.rt || this.rtW !== w || this.rtH !== h) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(w, h);
      this.rtW = w;
      this.rtH = h;
    }
    return this.rt;
  }

  // Set of decoration indexes VISIBLE inside a canvas-CSS-pixel rectangle.
  ownersInRect(camera, x0, y0, x1, y1, w, h, maxDim = 1536) {
    const out = new Set();
    if (!this.mesh) return out;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const rw = Math.max(1, Math.round(w * scale));
    const rh = Math.max(1, Math.round(h * scale));
    const rt = this._sizedRt(rw, rh);
    this._render(camera, rt);
    const rx0 = Math.max(0, Math.floor(Math.min(x0, x1) * scale));
    const rx1 = Math.min(rw - 1, Math.ceil(Math.max(x0, x1) * scale));
    // render-target rows are bottom-up
    const ryTop = Math.max(0, Math.floor(Math.min(y0, y1) * scale));
    const ryBot = Math.min(rh - 1, Math.ceil(Math.max(y0, y1) * scale));
    const gy0 = rh - 1 - ryBot;
    const gw = rx1 - rx0 + 1;
    const gh = ryBot - ryTop + 1;
    if (gw <= 0 || gh <= 0) return out;
    const buf = new Uint8Array(gw * gh * 4);
    this.renderer.readRenderTargetPixels(rt, rx0, gy0, gw, gh, buf);
    for (let i = 0; i < buf.length; i += 4) {
      const id = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
      if (id > 0) out.add(id - 1);
    }
    return out;
  }

  // Set of decoration indexes visible from ANY of 26 viewpoints around the
  // given bounds — used by "remove hidden primitives".
  visibleFromAround(center, radius, dim = 512) {
    const out = new Set();
    if (!this.mesh) return out;
    const cam = new THREE.PerspectiveCamera(40, 1, radius / 100, radius * 20);
    const dist = radius * 3.0;
    const rt = this._sizedRt(dim, dim);
    const buf = new Uint8Array(dim * dim * 4);
    for (const dir of VIEW_DIRS) {
      cam.position.copy(center).addScaledVector(dir, dist);
      cam.lookAt(center);
      cam.updateMatrixWorld(true);
      this._render(cam, rt);
      this.renderer.readRenderTargetPixels(rt, 0, 0, dim, dim, buf);
      for (let i = 0; i < buf.length; i += 4) {
        const id = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
        if (id > 0) out.add(id - 1);
      }
    }
    return out;
  }

  dispose() {
    this.clearGeometry();
    this.rt1.dispose();
    this.rt?.dispose();
  }
}
