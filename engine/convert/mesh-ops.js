// Mesh operations for triangle-count reduction:
//   - vertex welding
//   - region growing over coplanar, color-similar adjacent triangles
//   - boundary extraction + collinear simplification + ear-clip retriangulation
//
// Works on "colored triangle soup": arrays of triangles
//   { p: [v0, v1, v2] ({x,y,z} in meters), color: [r,g,b] }

import { v3, sub, add, mul, dot, cross, len, norm } from './vec3.js';
import { colorDistance, averageColors } from './color.js';

// ---------- welding ----------

function keyOf(p, eps) {
  return `${Math.round(p.x / eps)},${Math.round(p.y / eps)},${Math.round(p.z / eps)}`;
}

// Assigns integer vertex ids to triangle corners (within eps).
// Returns { ids: Int32Array (3 per tri), verts: [{x,y,z}] }
export function weldTriangles(tris, eps = 1e-4) {
  const map = new Map();
  const verts = [];
  const ids = new Int32Array(tris.length * 3);
  for (let t = 0; t < tris.length; t++) {
    for (let k = 0; k < 3; k++) {
      const p = tris[t].p[k];
      const key = keyOf(p, eps);
      let id = map.get(key);
      if (id === undefined) {
        id = verts.length;
        verts.push(p);
        map.set(key, id);
      }
      ids[t * 3 + k] = id;
    }
  }
  return { ids, verts };
}

// ---------- region merge ----------

function triNormal(tri) {
  return norm(cross(sub(tri.p[1], tri.p[0]), sub(tri.p[2], tri.p[0])));
}

class UnionFind {
  constructor(n) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
  find(i) { while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i]; } return i; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[ra] = rb; }
}

// Merge coplanar adjacent triangles whose colors are within tolerance,
// re-triangulating each merged region with fewer triangles.
// opts: { colorTolerance, planarAngleDeg, weldEps }
// Returns new array of colored triangles.
export function mergeCoplanarTriangles(tris, opts = {}) {
  const tol = opts.colorTolerance ?? 0;
  const cosPlanar = Math.cos((opts.planarAngleDeg ?? 1) * Math.PI / 180);
  const weldEps = opts.weldEps ?? 1e-4;
  const n = tris.length;
  if (n === 0) return [];

  const { ids, verts } = weldTriangles(tris, weldEps);
  const normals = tris.map(triNormal);

  // edge map: "a_b" (a<b) -> list of tri indices
  const edgeMap = new Map();
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const a = ids[t * 3 + k], b = ids[t * 3 + (k + 1) % 3];
      if (a === b) continue;
      const key = a < b ? a + '_' + b : b + '_' + a;
      let list = edgeMap.get(key);
      if (!list) { list = []; edgeMap.set(key, list); }
      list.push(t);
    }
  }

  const uf = new UnionFind(n);
  for (const list of edgeMap.values()) {
    if (list.length !== 2) continue; // only manifold edges
    const [t1, t2] = list;
    if (dot(normals[t1], normals[t2]) < cosPlanar) continue;
    if (colorDistance(tris[t1].color, tris[t2].color) > tol) continue;
    uf.union(t1, t2);
  }

  // group by region
  const regions = new Map();
  for (let t = 0; t < n; t++) {
    const r = uf.find(t);
    let list = regions.get(r);
    if (!list) { list = []; regions.set(r, list); }
    list.push(t);
  }

  const out = [];
  for (const regionTris of regions.values()) {
    if (regionTris.length === 1) {
      out.push(tris[regionTris[0]]);
      continue;
    }
    const merged = retriangulateRegion(regionTris, tris, ids, verts, normals);
    if (merged) out.push(...merged);
    else for (const t of regionTris) out.push(tris[t]);
  }
  return out;
}

// Attempt to re-triangulate a planar region with fewer triangles.
// Returns array of colored triangles, or null on failure (caller keeps originals).
function retriangulateRegion(regionTris, tris, ids, verts, normals) {
  const inRegion = new Set(regionTris);

  // boundary edges: used exactly once within the region (directed)
  const edgeCount = new Map();
  for (const t of regionTris) {
    for (let k = 0; k < 3; k++) {
      const a = ids[t * 3 + k], b = ids[t * 3 + (k + 1) % 3];
      if (a === b) return null;
      const key = a < b ? a + '_' + b : b + '_' + a;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }
  // directed boundary edges preserve winding
  const next = new Map(); // vertex id -> next vertex id along boundary
  let boundaryEdges = 0;
  for (const t of regionTris) {
    for (let k = 0; k < 3; k++) {
      const a = ids[t * 3 + k], b = ids[t * 3 + (k + 1) % 3];
      const key = a < b ? a + '_' + b : b + '_' + a;
      if (edgeCount.get(key) === 1) {
        if (next.has(a)) return null; // non-manifold boundary
        next.set(a, b);
        boundaryEdges++;
      } else if (edgeCount.get(key) > 2) {
        return null;
      }
    }
  }
  if (boundaryEdges < 3) return null;

  // single loop?
  const start = next.keys().next().value;
  const loop = [start];
  let cur = next.get(start);
  while (cur !== start) {
    if (cur === undefined || loop.length > boundaryEdges) return null;
    loop.push(cur);
    cur = next.get(cur);
  }
  if (loop.length !== boundaryEdges) return null; // multiple loops (holes)

  // average plane normal (area-weighted) and color
  let nrm = v3(0, 0, 0);
  const colors = [], weights = [];
  for (const t of regionTris) {
    const e1 = sub(tris[t].p[1], tris[t].p[0]);
    const e2 = sub(tris[t].p[2], tris[t].p[0]);
    const c = cross(e1, e2); // 2*area weighted
    nrm = add(nrm, c);
    colors.push(tris[t].color);
    weights.push(len(c));
  }
  nrm = norm(nrm);
  if (len(nrm) < 0.5) return null;
  const color = averageColors(colors, weights);

  // project loop to 2D
  let uAxis = cross(nrm, Math.abs(nrm.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0));
  uAxis = norm(uAxis);
  const vAxis = cross(nrm, uAxis);
  const pts2 = loop.map((id) => {
    const p = verts[id];
    return { x: dot(p, uAxis), y: dot(p, vAxis), id };
  });

  // remove collinear / duplicate points
  const simplified = simplifyLoop(pts2);
  if (simplified.length < 3) return null;

  const triIdx = earClip(simplified);
  if (!triIdx) return null;

  const out = [];
  for (const [i0, i1, i2] of triIdx) {
    out.push({
      p: [verts[simplified[i0].id], verts[simplified[i1].id], verts[simplified[i2].id]],
      color,
    });
  }
  // sanity: don't return more triangles than we started with
  if (out.length >= regionTris.length) return null;
  // winding: ensure the produced triangles face the same way as the region
  for (const tr of out) {
    const c = cross(sub(tr.p[1], tr.p[0]), sub(tr.p[2], tr.p[0]));
    if (dot(c, nrm) < 0) { const tmp = tr.p[1]; tr.p[1] = tr.p[2]; tr.p[2] = tmp; }
  }
  return out;
}

function simplifyLoop(pts, eps = 1e-9, angleEps = 1e-4) {
  // remove consecutive duplicates and collinear vertices
  let out = pts.slice();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const abx = b.x - a.x, aby = b.y - a.y;
      const bcx = c.x - b.x, bcy = c.y - b.y;
      const crossZ = abx * bcy - aby * bcx;
      const lenAB = Math.hypot(abx, aby), lenBC = Math.hypot(bcx, bcy);
      if (lenAB < eps || Math.abs(crossZ) < angleEps * lenAB * lenBC) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

// Ear clipping for a simple polygon (array of {x,y}). Returns array of index
// triples, or null on failure.
export function earClip(pts) {
  const nPts = pts.length;
  if (nPts < 3) return null;
  // signed area for orientation
  let area = 0;
  for (let i = 0; i < nPts; i++) {
    const a = pts[i], b = pts[(i + 1) % nPts];
    area += a.x * b.y - b.x * a.y;
  }
  const ccw = area > 0;
  const idx = pts.map((_, i) => i);
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length];
      const i1 = idx[i];
      const i2 = idx[(i + 1) % idx.length];
      const a = pts[i0], b = pts[i1], c = pts[i2];
      const crossZ = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (ccw ? crossZ <= 1e-12 : crossZ >= -1e-12) continue; // reflex or degenerate
      // any other vertex inside?
      let inside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTriangle(pts[j], a, b, c)) { inside = true; break; }
      }
      if (inside) continue;
      tris.push([i0, i1, i2]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null; // degenerate polygon
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

function pointInTriangle(p, a, b, c) {
  const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
function sign(p1, p2, p3) {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}
