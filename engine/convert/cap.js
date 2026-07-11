// Scale-cap enforcement: no decoration may exceed a zoom of 50 on any axis.
// Oversized flat/box placements are split into grids; oversized triangles
// are split into 4 similar right triangles recursively. Curved primitives
// (sphere/cylinder/cone/prism) are size-checked at fit time instead.

import { v3, add, mul } from './vec3.js';
import { TRI_SCALE_Y_PER_M, TRI_SCALE_Z_PER_M } from './converter.js';

export const MAX_ZOOM = 50;

const col = (m, i) => v3(m[0][i], m[1][i], m[2][i]);

export function capPlacements(placements, thinOk = true) {
  const out = [];
  const maxLeg1 = MAX_ZOOM / TRI_SCALE_Y_PER_M;   // triangle leg on +Y
  const maxLeg2 = MAX_ZOOM / TRI_SCALE_Z_PER_M;   // triangle leg on -Z (written)
  const maxEdge = MAX_ZOOM / 10;                  // 0.1 m-per-unit primitives

  for (const pl of placements) {
    if (pl.kind === 'triangle' || !pl.kind) {
      splitTriangle(pl, maxLeg1, maxLeg2, out);
    } else if (pl.kind === 'square' || pl.kind === 'plane') {
      splitBox(pl, maxEdge, out);
    } else {
      out.push(pl); // curved primitives are capped at creation
    }
  }
  return out;
}

function splitTriangle(pl, maxA, maxB, out, depth = 0) {
  if ((pl.scale.y <= maxA && pl.scale.z <= maxB) || depth > 6) {
    out.push(pl);
    return;
  }
  // split the right triangle at the leg midpoints into 4 similar halves
  const A = pl.position;
  const u = col(pl.rotation, 1), w = col(pl.rotation, 2);
  const a = pl.scale.y, b = pl.scale.z;
  // in-plane 180°: u' = -u, w' = -w, n' = n  →  columns (n, -u, -w)
  const rot180 = [
    [pl.rotation[0][0], -pl.rotation[0][1], -pl.rotation[0][2]],
    [pl.rotation[1][0], -pl.rotation[1][1], -pl.rotation[1][2]],
    [pl.rotation[2][0], -pl.rotation[2][1], -pl.rotation[2][2]],
  ];
  const half = { y: a / 2, z: b / 2 };
  const subs = [
    { position: A, rotation: pl.rotation },
    { position: add(A, mul(u, a / 2)), rotation: pl.rotation },
    { position: add(A, mul(w, b / 2)), rotation: pl.rotation },
    { position: add(add(A, mul(u, a / 2)), mul(w, b / 2)), rotation: rot180 },
  ];
  for (const s of subs) {
    splitTriangle({
      ...pl,
      position: s.position,
      rotation: s.rotation,
      scale: v3(pl.scale.x, half.y, half.z),
      area: (pl.area ?? 0) / 4,
    }, maxA, maxB, out, depth + 1);
  }
}

function splitBox(pl, maxEdge, out) {
  const n = [
    Math.max(1, Math.ceil(pl.scale.x / maxEdge)),
    Math.max(1, Math.ceil((pl.fullY ? pl.scale.y : 0) / maxEdge) || 1),
    Math.max(1, Math.ceil(pl.scale.z / maxEdge)),
  ];
  if (n[0] === 1 && n[1] === 1 && n[2] === 1) { out.push(pl); return; }
  const sx = pl.scale.x / n[0], sy = pl.scale.y / n[1], sz = pl.scale.z / n[2];
  // Overlap the cut planes slightly so no hairline seam can open between
  // sibling pieces (same color and depth: the overlap itself is invisible).
  // Each piece grows by 2*SEAM per split axis (one zoom quantum), but all of
  // it goes toward the CUT sides — edge pieces keep the box's outer faces
  // exactly, so the outer wall planes (already separated per box upstream)
  // never drift onto another decoration's wall plane.
  const SEAM = 0.0005; // m per side
  const ex = n[0] > 1 ? Math.min(SEAM, (maxEdge - sx) / 2) : 0;
  const ey = n[1] > 1 ? Math.min(SEAM, (maxEdge - sy) / 2) : 0;
  const ez = n[2] > 1 ? Math.min(SEAM, (maxEdge - sz) / 2) : 0;
  // per-axis expansion toward the low/high side: interior pieces grow e per
  // side; edge pieces put both quanta on their single cut side (the center
  // shifts by (hi-lo)/2, keeping the outer face in place)
  const grow = (idx, count, e) => count === 1 ? [0, 0]
    : idx === 0 ? [0, 2 * e] : idx === count - 1 ? [2 * e, 0] : [e, e];
  const X = col(pl.rotation, 0), Y = col(pl.rotation, 1), Z = col(pl.rotation, 2);
  for (let i = 0; i < n[0]; i++) {
    for (let j = 0; j < n[1]; j++) {
      for (let k = 0; k < n[2]; k++) {
        const gx = grow(i, n[0], ex), gy = grow(j, n[1], ey), gz = grow(k, n[2], ez);
        const off = add(
          add(
            mul(X, (i + 0.5 - n[0] / 2) * sx + (gx[1] - gx[0]) / 2),
            mul(Y, pl.fullY ? (j + 0.5 - n[1] / 2) * sy + (gy[1] - gy[0]) / 2 : 0),
          ),
          mul(Z, (k + 0.5 - n[2] / 2) * sz + (gz[1] - gz[0]) / 2),
        );
        out.push({
          ...pl,
          position: add(pl.position, off),
          scale: v3(
            sx + gx[0] + gx[1],
            pl.fullY ? sy + gy[0] + gy[1] : pl.scale.y,
            sz + gz[0] + gz[1],
          ),
          area: (pl.area ?? 0) / (n[0] * n[1] * n[2]),
        });
      }
    }
  }
}
