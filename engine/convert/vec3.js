// Minimal dependency-free 3D math used by the conversion engine.
// Column-major not needed; we use simple object/array helpers.

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const mul = (a, s) => v3(a.x * s, a.y * s, a.z * s);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => v3(
  a.y * b.z - a.z * b.y,
  a.z * b.x - a.x * b.z,
  a.x * b.y - a.y * b.x
);
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const norm = (a) => {
  const l = len(a);
  return l > 1e-20 ? mul(a, 1 / l) : v3(0, 0, 0);
};
export const lerp = (a, b, t) => v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

// 3x3 rotation matrix helpers (rows are arrays [r0, r1, r2], each [x,y,z])
export function matFromCols(cx, cy, cz) {
  // columns are the images of the basis vectors
  return [
    [cx.x, cy.x, cz.x],
    [cx.y, cy.y, cz.y],
    [cx.z, cy.z, cz.z],
  ];
}

export function matMulVec(m, v) {
  return v3(
    m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
    m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
    m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z
  );
}

export function matMul(a, b) {
  const r = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i][j] = a[i][0]*b[0][j] + a[i][1]*b[1][j] + a[i][2]*b[2][j];
  return r;
}

export function matTranspose(m) {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

// Rotation matrix -> Euler angles. Order is configurable because the target
// engine's convention is confirmed against sample files (see gia-format).
// Returns radians.
export function matToEulerYXZ(m) {
  // R = Ry * Rx * Rz (Unity-style, common for game engines)
  // m[1][2] = -sin(x)
  const sx = -m[1][2];
  const x = Math.asin(Math.max(-1, Math.min(1, sx)));
  let y, z;
  if (Math.abs(sx) < 0.9999999) {
    y = Math.atan2(m[0][2], m[2][2]);
    z = Math.atan2(m[1][0], m[1][1]);
  } else {
    y = Math.atan2(-m[2][0], m[0][0]);
    z = 0;
  }
  return { x, y, z };
}

export function matToEulerXYZ(m) {
  // R = Rx * Ry * Rz
  const sy = m[0][2];
  const y = Math.asin(Math.max(-1, Math.min(1, sy)));
  let x, z;
  if (Math.abs(sy) < 0.9999999) {
    x = Math.atan2(-m[1][2], m[2][2]);
    z = Math.atan2(-m[0][1], m[0][0]);
  } else {
    x = Math.atan2(m[2][1], m[1][1]);
    z = 0;
  }
  return { x, y, z };
}

export function eulerYXZToMat(e) {
  const cx = Math.cos(e.x), sx = Math.sin(e.x);
  const cy = Math.cos(e.y), sy = Math.sin(e.y);
  const cz = Math.cos(e.z), sz = Math.sin(e.z);
  const Rx = [[1,0,0],[0,cx,-sx],[0,sx,cx]];
  const Ry = [[cy,0,sy],[0,1,0],[-sy,0,cy]];
  const Rz = [[cz,-sz,0],[sz,cz,0],[0,0,1]];
  return matMul(Ry, matMul(Rx, Rz));
}

export function eulerXYZToMat(e) {
  const cx = Math.cos(e.x), sx = Math.sin(e.x);
  const cy = Math.cos(e.y), sy = Math.sin(e.y);
  const cz = Math.cos(e.z), sz = Math.sin(e.z);
  const Rx = [[1,0,0],[0,cx,-sx],[0,sx,cx]];
  const Ry = [[cy,0,sy],[0,1,0],[-sy,0,cy]];
  const Rz = [[cz,-sz,0],[sz,cz,0],[0,0,1]];
  return matMul(Rx, matMul(Ry, Rz));
}

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;
