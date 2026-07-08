// Constrained QEM edge-collapse decimation + connected-component splitting.
//
// Hyper-mode working-mesh reducer (Phase 1 of docs/decoration-reduction-plan.md).
// Replaces the vertex-clustering pass in preprocess.js — clustering snapped
// every vertex to a global grid, which averaged surfaces toward the interior
// ("melted"), fused separate objects that shared a cell, and manufactured
// slivers/T-junctions. This is the plan's specified reducer: quadric error
// metrics with constraint handling, run per connected component so distinct
// objects (e.g. the 43 shards of shattered_crystal_sword) can never fuse.
//
// Input:  leaves        — [{ p:[{x,y,z},{x,y,z},{x,y,z}], color }]  (triangle soup)
//         idxOf         — Int-per-leaf palette index (parallel to leaves)
//         target        — desired output face count
//         paletteColors — [[r,g,b], ...] indexed by idxOf
// Output: [{ p, color }]  reduced triangles (color === paletteColors[idx],
//         shared references preserved), OR null to signal the caller to fall
//         back to clustering (input welded into near-pure triangle soup — no
//         connectivity for QEM to exploit).
//
// Constraints (see plan P1 row):
//  (a) palette-index-boundary edges are LOCKED (never collapsed) + penalised.
//  (b) open/boundary + high-dihedral (crease/silhouette) edges get penalty
//      quadrics so their vertices don't erode inward.
//  (c) per-face palette index rides through every collapse untouched.
//  (d) collapses that flip a triangle normal or make a degenerate/sliver face
//      are rejected.
// Robustness: adjacency is built from scale-relative welded positions;
// non-manifold edges (>2 incident faces) are treated conservatively as locked.
// Performance: typed arrays + a binary heap, no per-triangle object allocation
// in the collapse loop.

const MIN_AREA = 1e-14; // squared-length scale guard for degenerate faces

// ---- tiny growable binary min-heap over (cost, u, v, versionU, versionV) ----
// pop() writes the winner into scratch fields (oCost/oU/oV/oVU/oVV) so the hot
// loop never allocates.
class MinHeap {
  constructor(cap = 4096) {
    this.cost = new Float64Array(cap);
    this.u = new Int32Array(cap);
    this.v = new Int32Array(cap);
    this.vu = new Int32Array(cap);
    this.vv = new Int32Array(cap);
    this.size = 0;
  }
  _grow() {
    const n = this.cost.length * 2;
    const g = (a, T) => { const b = new T(n); b.set(a); return b; };
    this.cost = g(this.cost, Float64Array);
    this.u = g(this.u, Int32Array);
    this.v = g(this.v, Int32Array);
    this.vu = g(this.vu, Int32Array);
    this.vv = g(this.vv, Int32Array);
  }
  _swap(i, j) {
    const c = this.cost, u = this.u, v = this.v, vu = this.vu, vv = this.vv;
    let t = c[i]; c[i] = c[j]; c[j] = t;
    t = u[i]; u[i] = u[j]; u[j] = t;
    t = v[i]; v[i] = v[j]; v[j] = t;
    t = vu[i]; vu[i] = vu[j]; vu[j] = t;
    t = vv[i]; vv[i] = vv[j]; vv[j] = t;
  }
  push(cost, u, v, vu, vv) {
    if (this.size >= this.cost.length) this._grow();
    let i = this.size++;
    this.cost[i] = cost; this.u[i] = u; this.v[i] = v; this.vu[i] = vu; this.vv[i] = vv;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p] <= this.cost[i]) break;
      this._swap(i, p); i = p;
    }
  }
  pop() {
    const c = this.cost;
    this.oCost = c[0]; this.oU = this.u[0]; this.oV = this.v[0];
    this.oVU = this.vu[0]; this.oVV = this.vv[0];
    const last = --this.size;
    if (last > 0) {
      c[0] = c[last]; this.u[0] = this.u[last]; this.v[0] = this.v[last];
      this.vu[0] = this.vu[last]; this.vv[0] = this.vv[last];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < last && c[l] < c[s]) s = l;
        if (r < last && c[r] < c[s]) s = r;
        if (s === i) break;
        this._swap(i, s); i = s;
      }
    }
  }
}

export function qemReduce(leaves, idxOf, target, paletteColors, opts = {}) {
  const n = leaves.length;
  if (n <= target) return null; // nothing to do — caller keeps original leaves
  const weldFrac = opts.weldFrac ?? 2e-5;
  const creaseCos = opts.creaseCos ?? 0.5;   // dihedral(normals) below this = crease
  const penaltyK = opts.penaltyK ?? 120;     // constraint-plane weight (× face area)
  const floorFaces = opts.floorFaces ?? 12;  // min faces kept per visible component
  const maxKeep = opts.maxKeepComponents ?? 4000;
  const flipDot = opts.flipDot ?? 0.1;       // reject collapse if normal·newNormal below

  // ---------------- 1. weld positions (scale-relative epsilon) ----------------
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const t of leaves) for (const q of t.p) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    if (q.z < minZ) minZ = q.z; if (q.z > maxZ) maxZ = q.z;
  }
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!(maxDim > 0)) return null;
  const eps = maxDim * weldFrac;
  const nx = Math.floor((maxX - minX) / eps) + 3;
  const ny = Math.floor((maxY - minY) / eps) + 3;
  const keyOf = (q) => {
    const qx = Math.round((q.x - minX) / eps);
    const qy = Math.round((q.y - minY) / eps);
    const qz = Math.round((q.z - minZ) / eps);
    return (qz * ny + qy) * nx + qx;
  };
  const vmap = new Map();
  const vxa = [], vya = [], vza = [];
  const vidOf = (q) => {
    const k = keyOf(q);
    let id = vmap.get(k);
    if (id === undefined) { id = vxa.length; vmap.set(k, id); vxa.push(q.x); vya.push(q.y); vza.push(q.z); }
    return id;
  };
  const fa = [], fb = [], fc = [], fpal = [], fprot = [];
  for (let i = 0; i < n; i++) {
    const t = leaves[i];
    const a = vidOf(t.p[0]), b = vidOf(t.p[1]), c = vidOf(t.p[2]);
    if (a === b || b === c || a === c) continue; // welded-degenerate, drop
    fa.push(a); fb.push(b); fc.push(c); fpal.push(idxOf[i]); fprot.push(t.protect ? 1 : 0);
  }
  const V = vxa.length;
  const F = fa.length;
  if (F === 0) return null;
  const vx = Float64Array.from(vxa), vy = Float64Array.from(vya), vz = Float64Array.from(vza);
  const FA = Int32Array.from(fa), FB = Int32Array.from(fb), FC = Int32Array.from(fc);
  const FP = Int32Array.from(fpal);
  const FPROT = Uint8Array.from(fprot);

  // ---------------- 2. connected components (union-find on welded verts) ------
  const parent = new Int32Array(V);
  for (let i = 0; i < V; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (let f = 0; f < F; f++) { uni(FA[f], FB[f]); uni(FB[f], FC[f]); }
  const compId = new Int32Array(V).fill(-1);
  let C = 0;
  for (let i = 0; i < V; i++) { const r = find(i); if (compId[r] === -1) compId[r] = C++; }
  // Poorly-connected soup (no shared verts): QEM has nothing to collapse — bail
  // so the caller can use the clustering fallback instead.
  if (C > F * 0.5) return null;
  const vcomp = new Int32Array(V);
  for (let i = 0; i < V; i++) vcomp[i] = compId[find(i)];
  const fcomp = new Int32Array(F);
  for (let f = 0; f < F; f++) fcomp[f] = vcomp[FA[f]];

  // face normals (unit) + areas
  const fnx = new Float64Array(F), fny = new Float64Array(F), fnz = new Float64Array(F);
  const farea = new Float64Array(F);
  const computeFace = (f) => {
    const a = FA[f], b = FB[f], c = FC[f];
    const ux = vx[b] - vx[a], uy = vy[b] - vy[a], uz = vz[b] - vz[a];
    const wx = vx[c] - vx[a], wy = vy[c] - vy[a], wz = vz[c] - vz[a];
    let cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    const len = Math.hypot(cx, cy, cz);
    farea[f] = len * 0.5;
    if (len > 1e-20) { fnx[f] = cx / len; fny[f] = cy / len; fnz[f] = cz / len; }
    else { fnx[f] = 0; fny[f] = 0; fnz[f] = 0; }
  };
  for (let f = 0; f < F; f++) computeFace(f);

  const faceAlive = new Uint8Array(F).fill(1);
  const compFaces = new Int32Array(C), compArea = new Float64Array(C);
  for (let f = 0; f < F; f++) { compFaces[fcomp[f]]++; compArea[fcomp[f]] += farea[f]; }
  const aliveComp = Int32Array.from(compFaces);

  // ---------------- 3. debris guard + per-component budget allocation ---------
  if (C > maxKeep) {
    const order = Array.from({ length: C }, (_, i) => i).sort((a, b) => compArea[b] - compArea[a]);
    const keep = new Uint8Array(C);
    for (let i = 0; i < maxKeep; i++) keep[order[i]] = 1;
    for (let f = 0; f < F; f++) if (!keep[fcomp[f]]) { faceAlive[f] = 0; aliveComp[fcomp[f]]--; }
  }
  const compTarget = new Int32Array(C);
  let passthrough = 0, bigArea = 0;
  const big = [];
  for (let c = 0; c < C; c++) {
    const cf = aliveComp[c];
    if (cf <= 0) { compTarget[c] = 0; continue; }
    if (cf <= floorFaces) { compTarget[c] = cf; passthrough += cf; }
    else { big.push(c); bigArea += compArea[c]; }
  }
  const R = Math.max(0, target - passthrough);
  for (const c of big) {
    const cf = aliveComp[c];
    let al = bigArea > 0 ? Math.round(R * (compArea[c] / bigArea)) : Math.round(R / big.length);
    if (al < floorFaces) al = floorFaces;
    if (al > cf) al = cf;
    compTarget[c] = al;
  }

  // ---------------- 4. quadrics (face planes) --------------------------------
  const Q = new Float64Array(V * 10);
  const addPlane = (vtx, a, b, c, d, w) => {
    const o = vtx * 10;
    Q[o] += w * a * a; Q[o + 1] += w * a * b; Q[o + 2] += w * a * c; Q[o + 3] += w * a * d;
    Q[o + 4] += w * b * b; Q[o + 5] += w * b * c; Q[o + 6] += w * b * d;
    Q[o + 7] += w * c * c; Q[o + 8] += w * c * d;
    Q[o + 9] += w * d * d;
  };
  const addFaceQuadric = (f) => {
    if (farea[f] <= 0) return;
    const a = fnx[f], b = fny[f], c = fnz[f];
    const p = FA[f];
    const d = -(a * vx[p] + b * vy[p] + c * vz[p]);
    const w = farea[f];
    addPlane(FA[f], a, b, c, d, w);
    addPlane(FB[f], a, b, c, d, w);
    addPlane(FC[f], a, b, c, d, w);
  };
  for (let f = 0; f < F; f++) if (faceAlive[f]) addFaceQuadric(f);

  // ---------------- 5. edge map, penalties, collapsibility -------------------
  const ekey = (u, v) => (u < v ? u * V + v : v * V + u);
  const emap = new Map();
  const addEdge = (u, v, f) => {
    const k = ekey(u, v);
    let r = emap.get(k);
    if (!r) { r = { c: 0, f0: -1, f1: -1 }; emap.set(k, r); }
    r.c++;
    if (r.c === 1) r.f0 = f; else if (r.c === 2) r.f1 = f;
  };
  for (let f = 0; f < F; f++) {
    if (!faceAlive[f]) continue;
    addEdge(FA[f], FB[f], f); addEdge(FB[f], FC[f], f); addEdge(FA[f], FC[f], f);
  }
  // penalty (constraint) plane: through the edge, perpendicular to the incident
  // face — pins the endpoint against eroding across the boundary/crease.
  const addPenalty = (u, v, f) => {
    const ex = vx[v] - vx[u], ey = vy[v] - vy[u], ez = vz[v] - vz[u];
    // m = edgeDir × faceNormal
    let mx = ey * fnz[f] - ez * fny[f];
    let my = ez * fnx[f] - ex * fnz[f];
    let mz = ex * fny[f] - ey * fnx[f];
    const ml = Math.hypot(mx, my, mz);
    if (ml < 1e-20) return;
    mx /= ml; my /= ml; mz /= ml;
    const d = -(mx * vx[u] + my * vy[u] + mz * vz[u]);
    const w = penaltyK * farea[f];
    addPlane(u, mx, my, mz, d, w);
    addPlane(v, mx, my, mz, d, w);
  };
  const isSeam = (r) => FP[r.f0] !== FP[r.f1];
  const isCrease = (r) =>
    fnx[r.f0] * fnx[r.f1] + fny[r.f0] * fny[r.f1] + fnz[r.f0] * fnz[r.f1] < creaseCos;
  for (const [k, r] of emap) {
    const u = Math.floor(k / V), v = k % V;
    if (r.c === 1) addPenalty(u, v, r.f0);
    else if (r.c > 2) { addPenalty(u, v, r.f0); addPenalty(u, v, r.f1); }
    else if (isSeam(r) || isCrease(r)) { addPenalty(u, v, r.f0); addPenalty(u, v, r.f1); }
  }

  // ---------------- 6. adjacency + collapse machinery ------------------------
  const vf = new Array(V);
  for (let i = 0; i < V; i++) vf[i] = [];
  for (let f = 0; f < F; f++) {
    if (!faceAlive[f]) continue;
    vf[FA[f]].push(f); vf[FB[f]].push(f); vf[FC[f]].push(f);
  }
  const version = new Int32Array(V);
  const dead = new Uint8Array(V);

  const err = (vtx, x, y, z) => {
    const o = vtx * 10;
    return Q[o] * x * x + 2 * Q[o + 1] * x * y + 2 * Q[o + 2] * x * z + 2 * Q[o + 3] * x
      + Q[o + 4] * y * y + 2 * Q[o + 5] * y * z + 2 * Q[o + 6] * y
      + Q[o + 7] * z * z + 2 * Q[o + 8] * z + Q[o + 9];
  };
  // Subset placement over {u, v, midpoint} — robust on the near-planar,
  // rank-deficient quadrics that thin hard-surface meshes (the swords) produce.
  let bpx = 0, bpy = 0, bpz = 0;
  // heap-ordering cost = cheapest of the three candidates (best case).
  const bestCost = (u, v) => {
    const ax = vx[u], ay = vy[u], az = vz[u], bx = vx[v], by = vy[v], bz = vz[v];
    const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;
    let best = Math.max(0, err(u, ax, ay, az) + err(v, ax, ay, az));
    let e = Math.max(0, err(u, bx, by, bz) + err(v, bx, by, bz));
    if (e < best) best = e;
    e = Math.max(0, err(u, mx, my, mz) + err(v, mx, my, mz));
    if (e < best) best = e;
    return best;
  };
  // Pick the LOWEST-cost candidate that survives the flip/sliver test and set
  // bpx/bpy/bpz to it. Critically, we do not reject the collapse just because
  // the cheapest position flips a face — a thin blade's cheapest position is
  // often the far endpoint, which squashes back-side faces; the endpoint on the
  // same side or the midpoint is usually valid. Only skip when ALL three fail.
  const _cx = [0, 0, 0], _cy = [0, 0, 0], _cz = [0, 0, 0], _cc = [0, 0, 0], _co = [0, 1, 2];
  const chooseValid = (u, v) => {
    const ax = vx[u], ay = vy[u], az = vz[u], bx = vx[v], by = vy[v], bz = vz[v];
    _cx[0] = ax; _cy[0] = ay; _cz[0] = az;
    _cx[1] = bx; _cy[1] = by; _cz[1] = bz;
    _cx[2] = (ax + bx) * 0.5; _cy[2] = (ay + by) * 0.5; _cz[2] = (az + bz) * 0.5;
    for (let i = 0; i < 3; i++) _cc[i] = Math.max(0, err(u, _cx[i], _cy[i], _cz[i]) + err(v, _cx[i], _cy[i], _cz[i]));
    // order the 3 indices by ascending cost (no allocation)
    _co[0] = 0; _co[1] = 1; _co[2] = 2;
    if (_cc[_co[0]] > _cc[_co[1]]) { const t = _co[0]; _co[0] = _co[1]; _co[1] = t; }
    if (_cc[_co[1]] > _cc[_co[2]]) { const t = _co[1]; _co[1] = _co[2]; _co[2] = t; }
    if (_cc[_co[0]] > _cc[_co[1]]) { const t = _co[0]; _co[0] = _co[1]; _co[1] = t; }
    for (let k = 0; k < 3; k++) {
      const i = _co[k];
      bpx = _cx[i]; bpy = _cy[i]; bpz = _cz[i];
      if (validCollapse(u, v)) return true;
    }
    return false;
  };

  // live info for a (possibly post-collapse) edge: incident live-face count,
  // palette agreement, crease — recomputed from current adjacency.
  let leCount = 0, leCollapsible = false;
  const liveEdge = (u, v) => {
    let cnt = 0, g0 = -1, g1 = -1;
    const fs = vf[u];
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (!faceAlive[f]) continue;
      if (FA[f] === v || FB[f] === v || FC[f] === v) { cnt++; if (cnt === 1) g0 = f; else if (cnt === 2) g1 = f; }
    }
    leCount = cnt;
    // seams + creases are collapsible but PENALISED (constraint quadrics added
    // once at setup) — they get collapsed only when free edges are exhausted,
    // so meshes that reach target on flat interiors never touch them, while
    // seam-dense meshes (the swords' 55-colour crystal gradients) can still
    // reduce to budget instead of flooring high and being drop-clamped. Only
    // non-manifold edges (>2 faces) stay locked (conservative).
    if (cnt === 1 || cnt === 2) leCollapsible = true;
    else leCollapsible = false; // 0 (not an edge) or non-manifold
    return cnt;
  };

  const substX = (vtx, i) => (i === vtx ? bpx : vx[i]);
  const substY = (vtx, i) => (i === vtx ? bpy : vy[i]);
  const substZ = (vtx, i) => (i === vtx ? bpz : vz[i]);
  // Reject collapse if any surviving incident face flips its normal or slivers.
  const validCollapse = (u, v) => {
    for (let pass = 0; pass < 2; pass++) {
      const pivot = pass === 0 ? u : v;
      const other = pass === 0 ? v : u;
      const fs = vf[pivot];
      for (let i = 0; i < fs.length; i++) {
        const f = fs[i];
        if (!faceAlive[f]) continue;
        const a = FA[f], b = FB[f], c = FC[f];
        if (a === other || b === other || c === other) continue; // dies in the collapse
        // new positions with both u and v mapped to the target point
        const ax = (a === u || a === v) ? bpx : vx[a];
        const ay = (a === u || a === v) ? bpy : vy[a];
        const az = (a === u || a === v) ? bpz : vz[a];
        const bx = (b === u || b === v) ? bpx : vx[b];
        const by = (b === u || b === v) ? bpy : vy[b];
        const bz = (b === u || b === v) ? bpz : vz[b];
        const cx = (c === u || c === v) ? bpx : vx[c];
        const cy = (c === u || c === v) ? bpy : vy[c];
        const cz = (c === u || c === v) ? bpz : vz[c];
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        let nX = e1y * e2z - e1z * e2y, nY = e1z * e2x - e1x * e2z, nZ = e1x * e2y - e1y * e2x;
        const nl = Math.hypot(nX, nY, nZ);
        if (nl < MIN_AREA) return false; // degenerate/sliver
        nX /= nl; nY /= nl; nZ /= nl;
        if (nX * fnx[f] + nY * fny[f] + nZ * fnz[f] < flipDot) return false; // flipped
      }
    }
    return true;
  };

  const heap = new MinHeap(Math.max(4096, F));
  const pushEdge = (u, v) => heap.push(bestCost(u, v), u, v, version[u], version[v]);
  for (const [k, r] of emap) {
    const u = Math.floor(k / V), v = k % V;
    // boundary + manifold-interior (seam/crease/free) collapsible; only
    // non-manifold locked. Seam/crease already carry penalty quadrics.
    if (r.c === 1 || r.c === 2) pushEdge(u, v);
  }

  const neigh = new Set();
  const pushAround = (u) => {
    neigh.clear();
    const fs = vf[u];
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (!faceAlive[f]) continue;
      const a = FA[f], b = FB[f], c = FC[f];
      if (a !== u) neigh.add(a); if (b !== u) neigh.add(b); if (c !== u) neigh.add(c);
    }
    for (const w of neigh) { liveEdge(u, w); if (leCollapsible) pushEdge(u, w); }
  };

  // ---------------- 7. collapse loop -----------------------------------------
  while (heap.size > 0) {
    heap.pop();
    const u = heap.oU, v = heap.oV;
    if (dead[u] || dead[v]) continue;
    const comp = vcomp[u];
    if (aliveComp[comp] <= compTarget[comp]) continue; // component reached its budget
    if (version[u] !== heap.oVU || version[v] !== heap.oVV) {
      liveEdge(u, v);
      if (leCount >= 1 && leCollapsible) pushEdge(u, v); // refresh stale entry
      continue;
    }
    liveEdge(u, v);
    if (leCount < 1 || !leCollapsible) continue; // no longer a collapsible edge
    if (!chooseValid(u, v)) continue; // no non-flipping position — skip permanently

    // commit: move u to target, fold v's quadric in, redirect v's faces to u
    vx[u] = bpx; vy[u] = bpy; vz[u] = bpz;
    const ou = u * 10, ov = v * 10;
    for (let k = 0; k < 10; k++) Q[ou + k] += Q[ov + k];
    const fs = vf[v];
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (!faceAlive[f]) continue;
      if (FA[f] === v) FA[f] = u; else if (FB[f] === v) FB[f] = u; else if (FC[f] === v) FC[f] = u;
      if (FA[f] === FB[f] || FB[f] === FC[f] || FA[f] === FC[f]) { faceAlive[f] = 0; aliveComp[comp]--; }
      else vf[u].push(f);
    }
    vf[v] = null; dead[v] = 1; version[u]++;
    // refresh normals/areas of u's surviving faces
    const uf = vf[u];
    for (let i = 0; i < uf.length; i++) { const f = uf[i]; if (faceAlive[f]) computeFace(f); }
    pushAround(u);
  }

  // ---------------- 8. emit surviving faces ----------------------------------
  const out = [];
  for (let f = 0; f < F; f++) {
    if (!faceAlive[f]) continue;
    const a = FA[f], b = FB[f], c = FC[f];
    out.push({
      p: [
        { x: vx[a], y: vy[a], z: vz[a] },
        { x: vx[b], y: vy[b], z: vz[b] },
        { x: vx[c], y: vy[c], z: vz[c] },
      ],
      color: paletteColors[FP[f]],
    });
  }
  return out;
}
