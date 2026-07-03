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
  const X = col(pl.rotation, 0), Y = col(pl.rotation, 1), Z = col(pl.rotation, 2);
  for (let i = 0; i < n[0]; i++) {
    for (let j = 0; j < n[1]; j++) {
      for (let k = 0; k < n[2]; k++) {
        const off = add(
          add(mul(X, (i + 0.5 - n[0] / 2) * sx), mul(Y, pl.fullY ? (j + 0.5 - n[1] / 2) * sy : 0)),
          mul(Z, (k + 0.5 - n[2] / 2) * sz),
        );
        out.push({
          ...pl,
          position: add(pl.position, off),
          scale: v3(sx, pl.fullY ? sy : pl.scale.y, sz),
          area: (pl.area ?? 0) / (n[0] * n[1] * n[2]),
        });
      }
    }
  }
}
