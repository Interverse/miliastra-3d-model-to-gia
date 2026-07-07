// Decoration-space <-> display-space transform conversions.
//
// Decorations store position in 0.1 m units, Euler rotation in degrees
// (YXZ or XYZ order), and per-axis zoom. The viewport displays them in
// meters, optionally mirrored across Z (flipZ) and shifted by the
// reconstruction's centering offset. Rotations survive the mirror via
// F·R·F conjugation (F = diag(1, 1, -1)).

import * as THREE from "three";

const FLIP = new THREE.Matrix4().makeScale(1, 1, -1);
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export const r4 = (v) => Math.round(v * 10000) / 10000;

export function displayContext(recon, offsetOf) {
  const off = offsetOf(recon) ?? { x: 0, y: 0, z: 0 };
  const flip = (recon.params?.flipZ ?? true) ? -1 : 1;
  const order = recon.params?.eulerOrder === "XYZ" ? "XYZ" : "YXZ";
  return { off, flip, order };
}

// decoration -> display position (meters, viewer space)
export function decPosToDisplay(d, ctx, out = new THREE.Vector3()) {
  return out.set(
    d.position.x / 10 + ctx.off.x,
    d.position.y / 10 + ctx.off.y,
    (d.position.z / 10) * ctx.flip + ctx.off.z,
  );
}

// display position -> decoration units
export function displayPosToDec(v, ctx) {
  return {
    x: r4((v.x - ctx.off.x) * 10),
    y: r4((v.y - ctx.off.y) * 10),
    z: r4((v.z - ctx.off.z) * 10 * ctx.flip),
  };
}

// decoration Euler -> display quaternion (mirror-conjugated when flipped)
export function decQuatToDisplay(d, ctx, out = new THREE.Quaternion()) {
  const eul = new THREE.Euler(
    d.rotationDeg.x * RAD,
    d.rotationDeg.y * RAD,
    d.rotationDeg.z * RAD,
    ctx.order,
  );
  const m = new THREE.Matrix4().makeRotationFromEuler(eul);
  if (ctx.flip === -1) m.premultiply(FLIP).multiply(FLIP);
  return out.setFromRotationMatrix(m);
}

// display quaternion -> decoration Euler degrees, normalized to [0, 360)
export function displayQuatToDec(q, ctx) {
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  if (ctx.flip === -1) m.premultiply(FLIP).multiply(FLIP);
  const eul = new THREE.Euler().setFromRotationMatrix(m, ctx.order);
  const norm = (v) => {
    let x = r4(v * DEG) % 360;
    if (x < 0) x += 360;
    return x;
  };
  return { x: norm(eul.x), y: norm(eul.y), z: norm(eul.z) };
}

export const clampZoom = (v) => r4(Math.min(50, Math.max(0.01, v)));

// Approximate display-space bounding radius of one decoration (meters).
export function decRadius(d) {
  const m = Math.max(d.scale.x, d.scale.y, d.scale.z) * 0.05;
  return Math.max(0.05, m * Math.sqrt(3));
}
