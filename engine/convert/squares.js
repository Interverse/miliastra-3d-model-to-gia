// Square-primitive support: pair right triangles that form rectangles into
// square decoration placements.
//
// Canonical square model (from White Square.gia): 1x1 m at scale (10, y, 10),
// i.e. 0.1 m edges at scale 1, centered at the local origin, flat (thin) on
// the local Y axis. Edges run along local X and Z.
//
// A square placement is:
//   { kind: 'square', position: center {x,y,z} (m), rotation: mat3,
//     scale: {x: edgeU_m, y: thin, z: edgeW_m}, color }

import { v3, sub, add, mul, dot, cross, len, norm, matFromCols } from './vec3.js';
import { colorDistance } from './color.js';
import { weldTriangles } from './mesh-ops.js';

// Build a square placement from rectangle corners: A + edge vectors
// eU = B-A, eW = C-A (perpendicular), D = B+C-A implied.
// srcNormal orients the local +Y axis.
export function squarePlacement(A, B, C, srcNormal) {
  const eU = sub(B, A);
  const eW = sub(C, A);
  const lu = len(eU), lw = len(eW);
  if (lu < 1e-12 || lw < 1e-12) return null;
  let u = mul(eU, 1 / lu);
  let w = norm(sub(mul(eW, 1 / lw), mul(u, dot(u, mul(eW, 1 / lw)))));
  if (len(w) < 1e-9) return null;
  let n = cross(w, u); // det[u,n,w] = +1
  if (srcNormal && dot(n, srcNormal) < 0) {
    // flip: swap edge roles so the local +Y matches the source normal
    const tu = u; u = w; w = tu;
    const tl = lu; // swap lengths too
    n = cross(w, u);
    return {
      kind: 'square',
      position: add(A, mul(add(sub(B, A), sub(C, A)), 0.5)),
      rotation: matFromCols(u, n, w),
      scale: v3(lw, 1, tl),
    };
  }
  return {
    kind: 'square',
    position: add(A, mul(add(sub(B, A), sub(C, A)), 0.5)), // center = A + (eU+eW)/2
    rotation: matFromCols(u, n, w), // local X->u, Y->n, Z->w
    scale: v3(lu, 1, lw),
  };
}

// Find the right-angle vertex of a triangle (within snap tolerance).
// Returns { A, B, C } with the right angle at A, or null.
function rightAngleCorner(t, snapCos) {
  for (let i = 0; i < 3; i++) {
    const a = t.p[i], b = t.p[(i + 1) % 3], c = t.p[(i + 2) % 3];
    const u = norm(sub(b, a)), v = norm(sub(c, a));
    if (Math.abs(dot(u, v)) <= snapCos) return { A: a, B: b, C: c, ai: i };
  }
  return null;
}

// Pair coplanar, same-color right triangles sharing their hypotenuse into
// rectangles. Returns { squares: [placement], rest: [triangle] }.
// opts: { snapDeg, colorTolerance, weldEps, planarAngleDeg }
export function pairIntoSquares(tris, opts = {}) {
  const snapDeg = opts.snapDeg ?? 1;
  const snapCos = Math.sin(snapDeg * Math.PI / 180); // |cos(90°±snap)| ≈ sin(snap)
  const tol = opts.colorTolerance ?? 0;
  const weldEps = opts.weldEps ?? 1e-4;
  const cosPlanar = Math.cos((opts.planarAngleDeg ?? 1) * Math.PI / 180);

  const { ids } = weldTriangles(tris, weldEps);
  const squares = [];
  const used = new Array(tris.length).fill(false);
  const rest = [];

  // group candidates by hypotenuse edge key
  const byHyp = new Map();
  const corners = new Array(tris.length).fill(null);
  for (let t = 0; t < tris.length; t++) {
    const rc = rightAngleCorner(tris[t], snapCos);
    if (!rc) continue;
    corners[t] = rc;
    // hypotenuse = edge B-C = the edge not touching A
    const bi = (rc.ai + 1) % 3, ci = (rc.ai + 2) % 3;
    const idB = ids[t * 3 + bi], idC = ids[t * 3 + ci];
    const key = idB < idC ? idB + '_' + idC : idC + '_' + idB;
    let list = byHyp.get(key);
    if (!list) { list = []; byHyp.set(key, list); }
    list.push(t);
  }

  const normals = tris.map((t) => norm(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]))));

  for (const list of byHyp.values()) {
    for (let i = 0; i < list.length; i++) {
      const t1 = list[i];
      if (used[t1]) continue;
      for (let j = i + 1; j < list.length; j++) {
        const t2 = list[j];
        if (used[t2]) continue;
        if (dot(normals[t1], normals[t2]) < cosPlanar) continue;
        if (colorDistance(tris[t1].color, tris[t2].color) > tol) continue;
        const c1 = corners[t1], c2 = corners[t2];
        // rectangle test: the two right-angle corners must be opposite:
        // c2.A ≈ c1.B + c1.C - c1.A
        const expect = sub(add(c1.B, c1.C), c1.A);
        const d = len(sub(expect, c2.A));
        const scale = Math.max(len(sub(c1.B, c1.A)), len(sub(c1.C, c1.A)));
        if (d > Math.max(weldEps * 4, scale * 0.02)) continue;
        const pl = squarePlacement(c1.A, c1.B, c1.C, normals[t1]);
        if (!pl) continue;
        pl.color = tris[t1].color;
        pl.area = pl.scale.x * pl.scale.z;
        squares.push(pl);
        used[t1] = used[t2] = true;
        break;
      }
    }
  }

  for (let t = 0; t < tris.length; t++) if (!used[t]) rest.push(tris[t]);
  return { squares, rest };
}

// Cover a lone right triangle with a square spanning its legs (used in
// squares-only mode; overdraws the triangle's mirror half).
export function squareCoveringTriangle(t, snapDeg = 45) {
  const snapCos = Math.sin(Math.min(89, snapDeg) * Math.PI / 180);
  const rc = rightAngleCorner(t, snapCos) ?? { A: t.p[0], B: t.p[1], C: t.p[2] };
  const n = norm(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0])));
  const pl = squarePlacement(rc.A, rc.B, rc.C, n);
  if (pl) {
    pl.color = t.color;
    pl.area = pl.scale.x * pl.scale.z;
  }
  return pl;
}
