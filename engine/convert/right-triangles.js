// Decompose arbitrary 3D triangles into placements of the canonical
// right-triangle decoration model.
//
// Canonical model (confirmed against sample .gia files, see gia-format.js):
//   - 1m x 1m right triangle, right-angle corner at the local origin
//   - thin along local X (the triangle plane is the local YZ plane)
//   - leg U along +Y, leg V along +Z (axes verified from samples;
//     override via `canonical` option if needed)
//
// A decoration placement is:
//   { position: {x,y,z}, rotation: mat3 (local->world), scale: {x,y,z},
//     color: {r,g,b}, alpha }
//
// A right triangle with right angle at P0 and legs P0->P1 (len a), P0->P2
// (len b) maps exactly to one placement with per-axis scale (thin, a, b).
// A non-right triangle is split at its largest angle by the altitude into two
// right triangles. Triangles whose largest angle is within `snapDeg` of 90°
// are treated as right (small shape distortion, halves the count).

import { v3, sub, add, mul, dot, cross, len, norm, matFromCols } from './vec3.js';

export const DEFAULT_CANONICAL = {
  // local direction of leg 1 (unit leg) and leg 2 (unit leg)
  legU: v3(0, 1, 0),
  legV: v3(0, 0, 1),
  normal: v3(1, 0, 0), // thin axis
  thinScale: 1,        // scale on the thin axis
};

// Returns index of vertex with the largest interior angle and its cosine.
export function largestAngleVertex(p0, p1, p2) {
  const pts = [p0, p1, p2];
  let best = 0, bestCos = 2;
  for (let i = 0; i < 3; i++) {
    const a = pts[i], b = pts[(i + 1) % 3], c = pts[(i + 2) % 3];
    const u = norm(sub(b, a)), v = norm(sub(c, a));
    const cosA = dot(u, v);
    if (cosA < bestCos) { bestCos = cosA; best = i; }
  }
  return { index: best, cos: bestCos };
}

// Build one placement from a right triangle (right angle at p0).
export function placementFromRightTriangle(p0, p1, p2, canonical = DEFAULT_CANONICAL) {
  const e1 = sub(p1, p0);
  const e2 = sub(p2, p0);
  const a = len(e1), b = len(e2);
  if (a < 1e-12 || b < 1e-12) return null;
  const u = mul(e1, 1 / a);
  let w = mul(e2, 1 / b);
  // Re-orthogonalize w against u (numerical safety; inputs should be ~orthogonal)
  w = norm(sub(w, mul(u, dot(u, w))));
  if (len(w) < 1e-9) return null;
  const n = norm(cross(u, w));
  // rotation maps canonical axes -> world:
  //   canonical.normal -> n, canonical.legU -> u, canonical.legV -> w
  // With canonical = (X thin, Y legU, Z legV) the matrix columns are (n, u, w).
  const rot = matFromCols(n, u, w);
  return {
    position: { ...p0 },
    rotation: rot,
    scale: v3(canonical.thinScale, a, b),
  };
}

// Decompose an arbitrary triangle into 1 or 2 placements.
// opts: { snapDeg: number, canonical }
export function decomposeTriangle(p0, p1, p2, opts = {}) {
  const snapDeg = opts.snapDeg ?? 1.0;
  const canonical = opts.canonical ?? DEFAULT_CANONICAL;
  const pts = [p0, p1, p2];
  const { index, cos } = largestAngleVertex(p0, p1, p2);
  const angle = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;

  const A = pts[index];                 // vertex with largest angle
  const B = pts[(index + 1) % 3];
  const C = pts[(index + 2) % 3];

  if (Math.abs(angle - 90) <= snapDeg) {
    // Treat as right-angled at A. Preserve winding: order legs so the
    // generated face normal matches the source normal.
    const srcN = cross(sub(p1, p0), sub(p2, p0));
    let pl = placementFromRightTriangle(A, B, C, canonical);
    if (pl) {
      const genN = cross(sub(B, A), sub(C, A));
      if (dot(srcN, genN) < 0) pl = placementFromRightTriangle(A, C, B, canonical);
    }
    return pl ? [pl] : [];
  }

  // Split: drop altitude from A onto BC. Foot F is between B and C because
  // the largest angle is at A (>90 only guarantees foot inside for obtuse at A;
  // for the largest angle the foot from that vertex lies inside segment BC).
  const bc = sub(C, B);
  const t = dot(sub(A, B), bc) / dot(bc, bc);
  const tc = Math.max(0.0, Math.min(1.0, t));
  const F = add(B, mul(bc, tc));
  const out = [];
  const srcN = cross(sub(p1, p0), sub(p2, p0));
  for (const [q1, q2] of [[B, A], [C, A]]) {
    // right angle at F, legs F->q1 and F->q2
    let pl = placementFromRightTriangle(F, q1, q2, canonical);
    if (pl) {
      const genN = cross(sub(q1, F), sub(q2, F));
      if (dot(srcN, genN) < 0) pl = placementFromRightTriangle(F, q2, q1, canonical);
      if (pl) out.push(pl);
    }
  }
  return out;
}

// Degenerate-triangle test (zero area within epsilon).
export function triangleArea(p0, p1, p2) {
  return 0.5 * len(cross(sub(p1, p0), sub(p2, p0)));
}
