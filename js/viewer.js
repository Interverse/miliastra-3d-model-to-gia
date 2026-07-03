// Three.js scene: source model display + generated-triangle overlay.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14161a);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 5000);
    this.camera.position.set(3, 2.5, 4);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x777777, 1.1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(5, 10, 6);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dir2.position.set(-6, 4, -8);
    this.scene.add(dir2);

    this.grid = new THREE.GridHelper(10, 20, 0x3a4150, 0x262a32);
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(1);
    this.scene.add(this.axes);

    this.modelGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();
    this.scene.add(this.modelGroup, this.overlayGroup);

    this._resize();
    window.addEventListener('resize', () => this._resize());
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    }
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  _resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth, h = parent.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setModel(object3d) {
    this.modelGroup.clear();
    if (object3d) this.modelGroup.add(object3d);
    this.frame();
  }

  frame() {
    const box = new THREE.Box3().setFromObject(this.modelGroup.children.length ? this.modelGroup : this.overlayGroup);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.1);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(radius * 0.9, radius * 0.7, radius * 1.2));
    this.camera.near = radius / 1000;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
    const gridSize = Math.pow(10, Math.ceil(Math.log10(radius * 2)));
    this.grid.scale.setScalar(gridSize / 10);
  }

  // triangles: Float32Array of xyz triplets (9 per triangle), colors:
  // Float32Array rgb per vertex (0..1). Displayed as wireframe + optional fill.
  // Rebuild all reconstruction overlays.
  // entries: [{ positions: Float32Array, colors: Float32Array|null,
  //             offset: {x,y,z}|null, visible: boolean }]
  // offset = display-space shift so a recentered conversion still overlays
  // the original (uncentered) source model.
  setOverlays(entries, mode) {
    this.overlayGroup.clear();
    if (mode === 'off' || !entries) return;
    for (const e of entries) {
      if (!e.visible || !e.positions || e.positions.length === 0) continue;
      const group = new THREE.Group();
      if (e.offset) group.position.set(e.offset.x, e.offset.y, e.offset.z);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(e.positions, 3));
      if (e.colors) geo.setAttribute('color', new THREE.BufferAttribute(e.colors, 3));
      geo.computeVertexNormals();

      if (mode === 'solid' || mode === 'both') {
        // unlit material: preview colors match the .gia values exactly
        const mat = new THREE.MeshBasicMaterial({
          vertexColors: !!e.colors,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        group.add(new THREE.Mesh(geo, mat));
      }
      if (mode === 'wireframe' || mode === 'both') {
        const wireGeo = new THREE.WireframeGeometry(geo);
        const wireMat = new THREE.LineBasicMaterial({
          color: mode === 'both' ? 0x101114 : 0x36d47e,
          transparent: true,
          opacity: 0.85,
          depthTest: true,
        });
        group.add(new THREE.LineSegments(wireGeo, wireMat));
      }
      this.overlayGroup.add(group);
    }
  }

  // legacy single-overlay API (clears everything when called with null)
  setOverlay(positions, colors, mode, offset) {
    this.setOverlays(positions ? [{ positions, colors, offset, visible: true }] : [], mode ?? 'off');
  }

  setModelVisible(v) { this.modelGroup.visible = v; }

  // Mirror the engine's user pre-transform on the displayed source model:
  // p' = R * (p - pivot), rotation Euler YXZ degrees, source/display space.
  setUserTransform(pivot, rotateDeg) {
    const e = new THREE.Euler(
      (rotateDeg?.x ?? 0) * Math.PI / 180,
      (rotateDeg?.y ?? 0) * Math.PI / 180,
      (rotateDeg?.z ?? 0) * Math.PI / 180,
      'YXZ',
    );
    this.modelGroup.rotation.copy(e);
    const p = new THREE.Vector3(-(pivot?.x ?? 0), -(pivot?.y ?? 0), -(pivot?.z ?? 0));
    p.applyEuler(e);
    this.modelGroup.position.copy(p);
  }
}
