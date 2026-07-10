// Three.js scene: source model display + generated-primitive overlays +
// selection highlight. Overlays are merged geometry (one draw call per
// reconstruction per style), and repeated updates with an unchanged
// triangle count are applied in place (attribute copy, no geometry
// rebuild) so gizmo drags stay smooth on large scenes.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// all 3 edges of every triangle (18 floats per triangle)
function fillEdges(positions, out) {
  let o = 0;
  for (let t = 0; t < positions.length; t += 9) {
    for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) {
      out[o++] = positions[t + a];
      out[o++] = positions[t + a + 1];
      out[o++] = positions[t + a + 2];
      out[o++] = positions[t + b];
      out[o++] = positions[t + b + 1];
      out[o++] = positions[t + b + 2];
    }
  }
}

const offsetEq = (a, b) =>
  (a?.x ?? 0) === (b?.x ?? 0) && (a?.y ?? 0) === (b?.y ?? 0) && (a?.z ?? 0) === (b?.z ?? 0);

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14161a);

    // dual cameras: perspective (default) + orthographic, switched via
    // setProjection(); this.camera always points at the active one
    this.cameraPersp = new THREE.PerspectiveCamera(50, 1, 0.01, 5000);
    // default on the game (-X, -Z) side facing the corrected forward (+Z);
    // display x = -(game x), so game -X is display +3
    this.cameraPersp.position.set(3, 2.5, -4);
    this.cameraOrtho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 5000);
    this.camera = this.cameraPersp;
    this._orthoHalfH = 2;
    this._aspect = 1;
    this.onProjectionChange = null;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this._ticks = []; // per-frame callbacks (nav gizmo etc.)

    const hemi = new THREE.HemisphereLight(0xffffff, 0x777777, 1.1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(5, 10, -6); // key light on the default-camera side
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dir2.position.set(-6, 4, 8);
    this.scene.add(dir2);

    this.grid = new THREE.GridHelper(10, 20, 0x3a4150, 0x262a32);
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(1);
    // display space mirrors X vs the game/decoration axes — mirror the
    // helper so the red arm points toward the game's +X
    this.axes.scale.x = -1;
    this.scene.add(this.axes);
    // 1-meter reference: a vertical ruler at the origin with 0.25 m ticks and
    // a "1 m" label. Unlike the grid it never rescales with the model.
    this.ref1m = this._buildMeterRef();
    this.scene.add(this.ref1m);

    this.modelGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();
    this.selGroup = new THREE.Group();
    this.selGroup.renderOrder = 5;
    this.scene.add(this.modelGroup, this.overlayGroup, this.selGroup);

    this._ovlCache = null; // { mode, items: [{group, mesh?, lines?, len, offset}] }
    this._focusTween = null;

    this._resize();
    window.addEventListener('resize', () => this._resize());
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    }
    this.renderer.setAnimationLoop(() => {
      this._stepFocus();
      this.controls.update();
      for (const fn of this._ticks) fn();
      this.renderer.render(this.scene, this.camera);
    });
  }

  addTick(fn) { this._ticks.push(fn); }

  _buildMeterRef() {
    const group = new THREE.Group();
    const pts = [];
    // vertical bar 0..1 m, slightly outside the origin so axes stay readable
    const x = 0, z = 0;
    pts.push(x, 0, z, x, 1, z);
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const len = i % 4 === 0 ? 0.08 : 0.04;
      pts.push(x - len, t, z, x + len, t, z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pts), 3));
    group.add(new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0xf0b429, transparent: true, opacity: 0.9 }),
    ));
    // "1 m" label sprite
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 64;
    const cx = cv.getContext('2d');
    cx.font = 'bold 40px system-ui, sans-serif';
    cx.fillStyle = '#f0b429';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText('1 m', 64, 32);
    const tex = new THREE.CanvasTexture(cv);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false,
    }));
    sprite.scale.set(0.3, 0.15, 1);
    sprite.position.set(x + 0.22, 1, z);
    group.add(sprite);
    group.renderOrder = 4;
    return group;
  }

  _resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth, h = parent.clientHeight;
    this.renderer.setSize(w, h, false);
    this._aspect = w / Math.max(1, h);
    this.cameraPersp.aspect = this._aspect;
    this.cameraPersp.updateProjectionMatrix();
    this._applyOrthoFrustum();
  }

  _applyOrthoFrustum() {
    const o = this.cameraOrtho;
    const h = this._orthoHalfH;
    o.left = -h * this._aspect;
    o.right = h * this._aspect;
    o.top = h;
    o.bottom = -h;
    o.updateProjectionMatrix();
  }

  // Switch between 'persp' and 'ortho' keeping the view visually stable.
  setProjection(mode) {
    const want = mode === 'ortho' ? this.cameraOrtho : this.cameraPersp;
    if (this.camera === want) return;
    const t = this.controls.target;
    const halfFov = (this.cameraPersp.fov * Math.PI) / 360;
    if (want === this.cameraOrtho) {
      const d = this.camera.position.distanceTo(t);
      want.position.copy(this.camera.position);
      want.quaternion.copy(this.camera.quaternion);
      want.near = Math.min(this.cameraPersp.near, d / 1000);
      want.far = Math.max(this.cameraPersp.far, d * 100);
      want.zoom = 1;
      this._orthoHalfH = Math.tan(halfFov) * d;
      this._applyOrthoFrustum();
    } else {
      // match the ortho view height at the equivalent perspective distance
      const halfH = this._orthoHalfH / (this.cameraOrtho.zoom || 1);
      const nd = Math.max(0.05, halfH / Math.tan(halfFov));
      const dir = this.camera.position.clone().sub(t);
      if (dir.lengthSq() < 1e-9) dir.set(1, 0.7, -1);
      dir.normalize();
      want.position.copy(t).addScaledVector(dir, nd);
      want.quaternion.copy(this.camera.quaternion);
      want.near = Math.min(this.cameraPersp.near, nd / 1000);
      want.far = Math.max(this.cameraPersp.far, nd * 100);
    }
    want.updateProjectionMatrix();
    this.camera = want;
    this.controls.object = want;
    this.controls.update();
    this.onProjectionChange?.(want);
  }

  get projection() {
    return this.camera.isOrthographicCamera ? 'ortho' : 'persp';
  }

  // Rotate the camera around the orbit target (used by the nav gizmo drag).
  orbitBy(dTheta, dPhi) {
    const t = this.controls.target;
    const off = this.camera.position.clone().sub(t);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta -= dTheta;
    sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi - dPhi));
    off.setFromSpherical(sph);
    this.camera.position.copy(t).add(off);
    this.camera.lookAt(t);
    this.controls.update();
  }

  // Animate the camera to look along -dir at the current orbit target from
  // the current distance (axis snap: Front/Back/Left/Right/Top/Bottom).
  snapToView(dir) {
    const t = this.controls.target.clone();
    const d = Math.max(0.1, this.camera.position.distanceTo(t));
    const v = new THREE.Vector3(dir.x ?? dir[0], dir.y ?? dir[1], dir.z ?? dir[2]);
    if (Math.abs(v.y) > 0.999 * v.length()) v.z -= 0.02 * Math.sign(v.y) || 0.02;
    v.normalize();
    this._focusTween = {
      t0: performance.now(),
      dur: 300,
      fromPos: this.camera.position.clone(),
      toPos: t.clone().addScaledVector(v, d),
      fromTgt: this.controls.target.clone(),
      toTgt: t,
    };
  }

  setModel(object3d, keepView = false) {
    this.modelGroup.clear();
    if (object3d) this.modelGroup.add(object3d);
    if (!keepView) this.frame();
  }

  frame() {
    const box = new THREE.Box3().setFromObject(this.modelGroup.children.length ? this.modelGroup : this.overlayGroup);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.1);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(radius * 0.9, radius * 0.7, -radius * 1.2));
    this.camera.near = radius / 1000;
    this.camera.far = radius * 100;
    if (this.camera.isOrthographicCamera) {
      this._orthoHalfH = radius * 1.1;
      this.camera.zoom = 1;
      this._applyOrthoFrustum();
    }
    this.camera.updateProjectionMatrix();
    const gridSize = Math.pow(10, Math.ceil(Math.log10(radius * 2)));
    this.grid.scale.setScalar(gridSize / 10);
  }

  // Smoothly move the camera so the given Box3 fills the view (focus-on-
  // selection). Keeps the current viewing direction.
  focusOn(box) {
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.05) * 0.6;
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, 0.7, -1);
    dir.normalize();
    const dist = (radius / Math.tan((this.cameraPersp.fov * Math.PI) / 360)) * 1.35;
    this._focusTween = {
      t0: performance.now(),
      dur: 260,
      fromPos: this.camera.position.clone(),
      toPos: center.clone().addScaledVector(dir, dist),
      fromTgt: this.controls.target.clone(),
      toTgt: center,
    };
    this.camera.near = Math.max(dist / 1000, 0.0005);
    this.camera.far = Math.max(this.camera.far, dist * 100);
    if (this.camera.isOrthographicCamera) {
      this._orthoHalfH = radius * 1.2;
      this.camera.zoom = 1;
      this._applyOrthoFrustum();
    }
    this.camera.updateProjectionMatrix();
  }

  _stepFocus() {
    const t = this._focusTween;
    if (!t) return;
    const k = Math.min(1, (performance.now() - t.t0) / t.dur);
    const e = k * (2 - k); // ease-out
    this.camera.position.lerpVectors(t.fromPos, t.toPos, e);
    this.controls.target.lerpVectors(t.fromTgt, t.toTgt, e);
    if (k >= 1) this._focusTween = null;
  }

  setHelpers({ grid, axes } = {}) {
    if (grid !== undefined) {
      this.grid.visible = grid;
      this.ref1m.visible = grid; // the meter ruler follows the grid toggle
    }
    if (axes !== undefined) this.axes.visible = axes;
  }

  // Rebuild (or update in place) all reconstruction overlays.
  // entries: [{ positions: Float32Array, colors: Float32Array|null,
  //             offset: {x,y,z}|null, visible: boolean }]
  // offset = optional display-space shift for an entry (normally null; kept
  // for API completeness).
  setOverlays(entries, mode) {
    entries = entries ?? [];
    const cache = this._ovlCache;
    const compatible =
      cache &&
      cache.mode === mode &&
      mode !== 'off' &&
      cache.items.length === entries.length &&
      entries.every(
        (e, i) =>
          e.positions &&
          cache.items[i].len === e.positions.length &&
          offsetEq(e.offset, cache.items[i].offset),
      );

    if (compatible) {
      // fast path: copy attribute data in place, no geometry rebuild
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const it = cache.items[i];
        it.group.visible = !!e.visible;
        if (!e.visible) continue;
        if (it.mesh) {
          it.mesh.geometry.attributes.position.array.set(e.positions);
          it.mesh.geometry.attributes.position.needsUpdate = true;
          if (e.colors && it.mesh.geometry.attributes.color) {
            it.mesh.geometry.attributes.color.array.set(e.colors);
            it.mesh.geometry.attributes.color.needsUpdate = true;
          }
          it.mesh.geometry.computeBoundingSphere();
        }
        if (it.lines) {
          fillEdges(e.positions, it.lines.geometry.attributes.position.array);
          it.lines.geometry.attributes.position.needsUpdate = true;
          it.lines.geometry.computeBoundingSphere();
        }
      }
      return;
    }

    // full rebuild
    for (const child of this.overlayGroup.children) {
      child.traverse((n) => {
        n.geometry?.dispose();
        n.material?.dispose();
      });
    }
    this.overlayGroup.clear();
    this._ovlCache = null;
    if (mode === 'off' || !entries.length) return;

    const items = [];
    for (const e of entries) {
      if (!e.positions || e.positions.length === 0) {
        items.push({ len: -1 });
        continue;
      }
      const group = new THREE.Group();
      group.visible = !!e.visible;
      if (e.offset) group.position.set(e.offset.x, e.offset.y, e.offset.z);
      const it = { group, len: e.positions.length, offset: e.offset ?? null, mesh: null, lines: null };

      if (mode === 'solid' || mode === 'both') {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(e.positions, 3));
        if (e.colors) geo.setAttribute('color', new THREE.BufferAttribute(e.colors, 3));
        // unlit material: preview colors match the .gia values exactly
        const mat = new THREE.MeshBasicMaterial({
          vertexColors: !!e.colors,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        it.mesh = new THREE.Mesh(geo, mat);
        group.add(it.mesh);
      }
      if (mode === 'wireframe' || mode === 'both') {
        const edgePos = new Float32Array((e.positions.length / 9) * 18);
        fillEdges(e.positions, edgePos);
        const wireGeo = new THREE.BufferGeometry();
        wireGeo.setAttribute('position', new THREE.BufferAttribute(edgePos, 3));
        const wireMat = new THREE.LineBasicMaterial({
          color: mode === 'both' ? 0x101114 : 0x36d47e,
          transparent: true,
          opacity: 0.85,
          depthTest: true,
        });
        it.lines = new THREE.LineSegments(wireGeo, wireMat);
        group.add(it.lines);
      }
      this.overlayGroup.add(group);
      items.push(it);
    }
    this._ovlCache = { mode, items };
  }

  // Selection highlight: non-destructive OUTLINE only — the primitives keep
  // their true colors. Bright depth-tested edges mark the visible part; a
  // faint depth-ignoring pass keeps occluded selections readable.
  setSelection(positions, offset) {
    for (const child of this.selGroup.children) {
      child.traverse((n) => {
        n.geometry?.dispose();
        n.material?.dispose();
      });
    }
    this.selGroup.clear();
    if (!positions || positions.length === 0) return;

    const group = new THREE.Group();
    if (offset) group.position.set(offset.x, offset.y, offset.z);
    const edgePos = new Float32Array((positions.length / 9) * 18);
    fillEdges(positions, edgePos);
    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.BufferAttribute(edgePos, 3));
    const outline = new THREE.LineSegments(
      wireGeo,
      new THREE.LineBasicMaterial({ color: 0xff9526, transparent: true, opacity: 1 }),
    );
    const xrayOutline = new THREE.LineSegments(
      wireGeo,
      new THREE.LineBasicMaterial({
        color: 0xff9526,
        transparent: true,
        opacity: 0.18,
        depthTest: false,
        depthWrite: false,
      }),
    );
    group.add(outline, xrayOutline);
    this.selGroup.add(group);
  }

  setModelVisible(v) { this.modelGroup.visible = v; }

  // Mirror the engine's user pre-transform on the displayed source model:
  // p' = R * s∘(p_m - pivot), p_m = unitScale * p_src, rotation Euler YXZ
  // degrees. userScale may be a number (uniform) or {x,y,z} (per-axis).
  setUserTransform(pivot, rotateDeg, userScale = 1, unitScale = 1) {
    const s = typeof userScale === 'object' && userScale
      ? { x: userScale.x || 1, y: userScale.y || 1, z: userScale.z || 1 }
      : { x: userScale || 1, y: userScale || 1, z: userScale || 1 };
    const u = unitScale || 1;
    const e = new THREE.Euler(
      (rotateDeg?.x ?? 0) * Math.PI / 180,
      (rotateDeg?.y ?? 0) * Math.PI / 180,
      (rotateDeg?.z ?? 0) * Math.PI / 180,
      'YXZ',
    );
    this.modelGroup.rotation.copy(e);
    this.modelGroup.scale.set(s.x * u, s.y * u, s.z * u);
    const p = new THREE.Vector3(
      -s.x * (pivot?.x ?? 0),
      -s.y * (pivot?.y ?? 0),
      -s.z * (pivot?.z ?? 0),
    );
    p.applyEuler(e);
    this.modelGroup.position.copy(p);
  }
}
