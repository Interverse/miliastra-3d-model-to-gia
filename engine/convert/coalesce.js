// Greedy coalescing of square placements into larger rectangles.
//
// Groups squares that lie on the same plane with the same color, size, and
// orientation, snaps their centers onto a regular grid, and greedy-meshes
// occupied cells into maximal rectangles. This collapses per-texel squares
// on voxel models (e.g. a uniform 16x16 face becomes one placement).

import { v3, add, mul, dot, cross } from './vec3.js';
import { colorToRgbInt, colorDistance } from './color.js';

const q = (x, s = 1e4) => Math.round(x * s) / s;

// opts.colorTolerance > 0 groups near-equal colors together (used when the
// decoration budget forces extra merging); 0/absent requires exact colors.
export function coalesceSquares(squares, opts = {}) {
  if (squares.length < 2) return squares;
  const colorTol = opts.colorTolerance ?? 0;
  const clusterReps = [];
  const colorKeyOf = (c) => {
    if (colorTol <= 0) return String(colorToRgbInt(c));
    for (let i = 0; i < clusterReps.length; i++) {
      if (colorDistance(c, clusterReps[i]) <= colorTol) return 'c' + i;
    }
    clusterReps.push(c);
    return 'c' + (clusterReps.length - 1);
  };

  // group by (normal, plane offset, color, size, edge direction)
  const groups = new Map();
  const passthrough = [];
  for (const sq of squares) {
    const u = v3(sq.rotation[0][0], sq.rotation[1][0], sq.rotation[2][0]);
    const n = v3(sq.rotation[0][1], sq.rotation[1][1], sq.rotation[2][1]);
    const w = v3(sq.rotation[0][2], sq.rotation[1][2], sq.rotation[2][2]);
    const off = dot(sq.position, n);
    const key = [
      q(n.x, 100), q(n.y, 100), q(n.z, 100),
      q(off, 1e3),
      colorKeyOf(sq.color),
      q(sq.scale.x, 1e3), q(sq.scale.z, 1e3),
      q(u.x, 100), q(u.y, 100), q(u.z, 100),
    ].join('|');
    let g = groups.get(key);
    if (!g) { g = { u, w, n, off, sx: sq.scale.x, sz: sq.scale.z, items: [] }; groups.set(key, g); }
    g.items.push(sq);
  }

  const out = [];
  for (const g of groups.values()) {
    if (g.items.length === 1) { out.push(g.items[0]); continue; }
    const { u, w, n, sx, sz } = g;
    // grid coordinates of centers in the (u,w) basis
    let minA = 1/0, minB = 1/0;
    const coords = g.items.map((sq) => {
      const a = dot(sq.position, u), b = dot(sq.position, w);
      if (a < minA) minA = a;
      if (b < minB) minB = b;
      return { a, b, sq };
    });
    const cellMap = new Map(); // "a,b" -> sq
    let ok = true;
    for (const c of coords) {
      const ai = Math.round((c.a - minA) / sx);
      const bi = Math.round((c.b - minB) / sz);
      if (Math.abs(c.a - minA - ai * sx) > sx * 0.2 ||
          Math.abs(c.b - minB - bi * sz) > sz * 0.2) { ok = false; break; }
      const k = ai + ',' + bi;
      if (cellMap.has(k)) { ok = false; break; } // overlapping — bail out
      cellMap.set(k, { ai, bi, sq: c.sq });
    }
    if (!ok) { for (const it of g.items) out.push(it); continue; }

    // greedy meshing over occupied cells
    const cells = new Set(cellMap.keys());
    const offN = dot(g.items[0].position, n);
    while (cells.size) {
      const first = cells.values().next().value;
      let [a0, b0] = first.split(',').map(Number);
      // grow along +a
      let a1 = a0;
      while (cells.has((a1 + 1) + ',' + b0)) a1++;
      // grow along +b while the full row is present
      let b1 = b0;
      for (;;) {
        let full = true;
        for (let a = a0; a <= a1; a++) if (!cells.has(a + ',' + (b1 + 1))) { full = false; break; }
        if (!full) break;
        b1++;
      }
      for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) cells.delete(a + ',' + b);

      const nx = a1 - a0 + 1, nz = b1 - b0 + 1;
      const cu = minA + (a0 + a1) / 2 * sx;
      const cw = minB + (b0 + b1) / 2 * sz;
      const rep = cellMap.get(first).sq;
      if (nx === 1 && nz === 1) { out.push(rep); continue; }
      const center = add(add(mul(u, cu), mul(w, cw)), mul(n, offN));
      out.push({
        kind: 'square',
        position: center,
        rotation: rep.rotation,
        scale: v3(sx * nx, 1, sz * nz),
        color: rep.color,
        area: sx * nx * sz * nz,
      });
    }
  }
  return out;
}
