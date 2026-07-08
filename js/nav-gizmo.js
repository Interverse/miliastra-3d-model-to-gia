// Viewport camera navigation gizmo (the axis ball found in professional 3D
// editors): shows the current camera orientation, snaps to the six standard
// views when an axis knob is clicked, orbits the camera when dragged, and
// toggles Perspective / Orthographic projection via the button below it.
//
// Rendered with 2D canvas: the six axis directions are projected into
// camera space each frame and drawn as depth-sorted knobs.

import * as THREE from "three";

const AXES = [
  // display space mirrors X vs the game axes: the game's +X lies toward
  // display -X, so the "X / Right" knob points at display (-1, 0, 0)
  { dir: new THREE.Vector3(-1, 0, 0), label: "X", color: "#e5534b", view: "Right" },
  { dir: new THREE.Vector3(1, 0, 0), label: "-X", color: "#e5534b", view: "Left" },
  { dir: new THREE.Vector3(0, 1, 0), label: "Y", color: "#57ab5a", view: "Top" },
  { dir: new THREE.Vector3(0, -1, 0), label: "-Y", color: "#57ab5a", view: "Bottom" },
  // corrected axes: +Z is the model's forward, so the Front view looks
  // along +Z from the -Z side
  { dir: new THREE.Vector3(0, 0, 1), label: "Z", color: "#539bf5", view: "Back" },
  { dir: new THREE.Vector3(0, 0, -1), label: "-Z", color: "#539bf5", view: "Front" },
];

export function createNavGizmo(viewer) {
  const canvas = document.getElementById("nav-gizmo");
  const btn = document.getElementById("nav-proj");
  if (!canvas || !btn) return null;

  const SIZE = 96;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);

  const C = SIZE / 2;
  const R = SIZE / 2 - 14; // axis arm length
  const KNOB = 8.5;

  let hovered = -1; // AXES index
  let inside = false;
  let drag = null; // { x, y, moved }
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  let pts = AXES.map(() => ({ x: 0, y: 0, z: 0 }));

  function project() {
    q.copy(viewer.camera.quaternion).invert();
    for (let i = 0; i < AXES.length; i++) {
      v.copy(AXES[i].dir).applyQuaternion(q);
      pts[i].x = C + v.x * R;
      pts[i].y = C - v.y * R;
      pts[i].z = v.z; // -1 (far) .. 1 (near)
    }
  }

  function draw() {
    project();
    g.clearRect(0, 0, SIZE, SIZE);
    if (inside || drag) {
      g.beginPath();
      g.arc(C, C, SIZE / 2 - 2, 0, Math.PI * 2);
      g.fillStyle = "rgba(32, 36, 44, 0.55)";
      g.fill();
    }
    const order = AXES.map((_, i) => i).sort((a, b) => pts[a].z - pts[b].z);
    for (const i of order) {
      const p = pts[i];
      const positive = !AXES[i].label.startsWith("-");
      const near = (p.z + 1) / 2; // 0 far .. 1 near
      const r = KNOB * (0.75 + 0.25 * near);
      if (positive) {
        g.beginPath();
        g.moveTo(C, C);
        g.lineTo(p.x, p.y);
        g.strokeStyle = AXES[i].color;
        g.globalAlpha = 0.45 + 0.55 * near;
        g.lineWidth = 2;
        g.stroke();
      }
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (positive) {
        g.fillStyle = AXES[i].color;
        g.globalAlpha = 0.55 + 0.45 * near;
        g.fill();
      } else {
        g.fillStyle = "#1b1e24";
        g.globalAlpha = 0.85;
        g.fill();
        g.beginPath();
        g.arc(p.x, p.y, r - 1, 0, Math.PI * 2);
        g.strokeStyle = AXES[i].color;
        g.globalAlpha = 0.35 + 0.55 * near;
        g.lineWidth = 1.5;
        g.stroke();
      }
      if (i === hovered) {
        g.beginPath();
        g.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2);
        g.strokeStyle = "#ffffff";
        g.globalAlpha = 0.9;
        g.lineWidth = 1.5;
        g.stroke();
      }
      if (positive || i === hovered) {
        g.globalAlpha = 1;
        g.fillStyle = positive ? "#14161a" : AXES[i].color;
        g.font = "bold 9px system-ui, sans-serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(AXES[i].label.replace("-", "−"), p.x, p.y + 0.5);
      }
    }
    g.globalAlpha = 1;
  }

  function knobAt(x, y) {
    let best = -1;
    let bestD = 12;
    let bestZ = -2;
    for (let i = 0; i < AXES.length; i++) {
      const d = Math.hypot(pts[i].x - x, pts[i].y - y);
      if (d <= bestD + 0.001 && pts[i].z >= bestZ) {
        best = i;
        bestD = Math.min(bestD, d);
        bestZ = pts[i].z;
      }
    }
    return best;
  }

  const localXY = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * SIZE, y: ((ev.clientY - r.top) / r.height) * SIZE };
  };

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    drag = { x: ev.clientX, y: ev.clientY, moved: false };
    try { canvas.setPointerCapture(ev.pointerId); } catch {}
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (drag) {
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      viewer.orbitBy(dx * 0.012, dy * 0.012);
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      return;
    }
    const { x, y } = localXY(ev);
    const k = knobAt(x, y);
    if (k !== hovered) {
      hovered = k;
      canvas.title = k >= 0
        ? `${AXES[k].view} view`
        : "Camera orientation — click an axis to snap the view, drag to orbit";
    }
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!drag) return;
    const wasClick = !drag.moved;
    drag = null;
    if (wasClick) {
      const { x, y } = localXY(ev);
      const k = knobAt(x, y);
      if (k >= 0) viewer.snapToView(AXES[k].dir);
    }
  });
  canvas.addEventListener("pointerenter", () => { inside = true; });
  canvas.addEventListener("pointerleave", () => {
    inside = false;
    hovered = -1;
  });

  // projection toggle
  const syncBtn = () => {
    btn.textContent = viewer.projection === "ortho" ? "Ortho" : "Persp";
  };
  btn.addEventListener("click", () => {
    viewer.setProjection(viewer.projection === "ortho" ? "persp" : "ortho");
    syncBtn();
  });
  syncBtn();

  viewer.addTick(draw);
  draw();
  return { draw };
}
