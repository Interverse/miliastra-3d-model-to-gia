// Hyper-Optimized mode preprocessing (Phase 1 of the decoration-reduction
// plan): interior culling, connected-component stats, perceptual (CIELAB)
// palette reduction, and working-mesh reduction.
//
// Everything here runs BEFORE the shared direct-mode pipeline (subdivision,
// coplanar merge, square pairing, coalescing), which then operates on
// palette-exact colors — so merging collapses maximally without visible
// color drift.

import { qemReduce } from './qem.js';

// ---------- CIELAB ----------

// sRGB [0..255] -> CIELAB (D65). Perceptual distance ≈ deltaE76.
export function rgbToLab(rgb) {
  const f = (u) => {
    u /= 255;
    return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
  };
  const r = f(rgb[0]), g = f(rgb[1]), b = f(rgb[2]);
  let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const g3 = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = g3(x); y = g3(y); z = g3(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function labDist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ---------- palette reduction ----------

// Reduce arbitrary sampled colors to <= maxColors representatives.
// Weighted greedy clustering in Lab: colors are visited by descending
// weight (surface area), so dominant colors become the representatives and
// small-area colors merge into them — halo/AA blends never win a slot.
// The tolerance adapts upward until the palette fits.
//
// entries: [{ color: [r,g,b], w }]
// returns { colors: [[r,g,b]...], match(color) -> palette color }
export function buildPalette(entries, maxColors = 32) {
  // coarse-bucket first so the clustering pass is O(unique), not O(pixels)
  const buckets = new Map(); // 5-bit rgb key -> {sum lab-weighted rgb, w}
  for (const e of entries) {
    const k = ((e.color[0] >> 3) << 10) | ((e.color[1] >> 3) << 5) | (e.color[2] >> 3);
    let b = buckets.get(k);
    if (!b) { b = { r: 0, g: 0, b: 0, w: 0 }; buckets.set(k, b); }
    b.r += e.color[0] * e.w; b.g += e.color[1] * e.w; b.b += e.color[2] * e.w;
    b.w += e.w;
  }
  const uniq = [...buckets.values()]
    .map((b) => ({ rgb: [b.r / b.w, b.g / b.w, b.b / b.w], w: b.w }))
    .sort((a, b) => b.w - a.w);

  let tol = 6; // start near-lossless; adapt until the palette fits
  let reps = [];
  for (let iter = 0; iter < 12; iter++) {
    reps = [];
    for (const u of uniq) {
      const lab = rgbToLab(u.rgb);
      let best = -1, bestD = Infinity;
      for (let i = 0; i < reps.length; i++) {
        const d = labDist(lab, reps[i].lab);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0 && bestD <= tol) {
        const r = reps[best];
        r.r += u.rgb[0] * u.w; r.g += u.rgb[1] * u.w; r.b += u.rgb[2] * u.w;
        r.w += u.w;
        // keep the representative at the weighted mean
        r.rgb = [r.r / r.w, r.g / r.w, r.b / r.w];
        r.lab = rgbToLab(r.rgb);
      } else {
        reps.push({
          rgb: [...u.rgb], lab, w: u.w,
          r: u.rgb[0] * u.w, g: u.rgb[1] * u.w, b: u.rgb[2] * u.w,
        });
      }
    }
    if (reps.length <= maxColors) break;
    tol *= 1.6;
  }
  const colors = reps.map((r) => [
    Math.round(r.rgb[0]), Math.round(r.rgb[1]), Math.round(r.rgb[2]),
  ]);
  const labs = colors.map(rgbToLab);
  const cache = new Map();
  const match = (color) => {
    const k = ((color[0] >> 2) << 12) | ((color[1] >> 2) << 6) | (color[2] >> 2);
    let idx = cache.get(k);
    if (idx === undefined) {
      const lab = rgbToLab(color);
      let best = 0, bestD = Infinity;
      for (let i = 0; i < labs.length; i++) {
        const d = labDist(lab, labs[i]);
        if (d < bestD) { bestD = d; best = i; }
      }
      idx = best;
      cache.set(k, idx);
    }
    return colors[idx];
  };
  return { colors, match };
}

// ---------- interior culling ----------

// Voxel-occupancy exterior-reachability cull: rasterize triangle surfaces
// into a coarse grid, flood-fill the EMPTY space from the grid boundary,
// and keep only triangles whose surface touches outside-reachable space.
// Fully enclosed interior geometry (inner shells, double walls, mouth bags)
// is removed — the same effect as the editor's 26-view GPU cull, but
// deterministic and worker-friendly.
export function cullInterior(tris, res = 72) {
  if (tris.length < 200) return { tris, culled: 0 };
  let minX = 1/0, minY = 1/0, minZ = 1/0, maxX = -1/0, maxY = -1/0, maxZ = -1/0;
  for (const t of tris) for (const q of t.p) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    if (q.z < minZ) minZ = q.z; if (q.z > maxZ) maxZ = q.z;
  }
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!(maxDim > 0)) return { tris, culled: 0 };
  const cell = maxDim / res;
  const nx = Math.max(1, Math.min(180, Math.ceil((maxX - minX) / cell) + 2));
  const ny = Math.max(1, Math.min(180, Math.ceil((maxY - minY) / cell) + 2));
  const nz = Math.max(1, Math.min(180, Math.ceil((maxZ - minZ) / cell) + 2));
  const idx = (x, y, z) => (z * ny + y) * nx + x;
  const grid = new Uint8Array(nx * ny * nz); // 0 empty, 1 occupied, 2 outside
  const ix = (v, min, n) => {
    const i = Math.floor((v - min) / cell) + 1;
    return i < 0 ? 0 : i >= n ? n - 1 : i;
  };

  // sample each triangle's surface at ~cell pitch
  const eachSample = (t, fn) => {
    const [a, b, c] = t.p;
    const e1 = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const e2 = Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z);
    const n = Math.min(24, Math.max(1, Math.ceil(Math.max(e1, e2) / (cell * 0.7))));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        fn(
          ix(a.x * w + b.x * u + c.x * v, minX, nx),
          ix(a.y * w + b.y * u + c.y * v, minY, ny),
          ix(a.z * w + b.z * u + c.z * v, minZ, nz),
        );
      }
    }
  };
  for (const t of tris) eachSample(t, (x, y, z) => { grid[idx(x, y, z)] = 1; });

  // flood the empty space from the grid boundary (6-connected)
  const queue = new Int32Array(nx * ny * nz);
  let qh = 0, qt = 0;
  const push = (x, y, z) => {
    const i = idx(x, y, z);
    if (grid[i] === 0) { grid[i] = 2; queue[qt++] = i; }
  };
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) { push(x, y, 0); push(x, y, nz - 1); }
  for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) { push(x, 0, z); push(x, ny - 1, z); }
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) { push(0, y, z); push(nx - 1, y, z); }
  while (qh < qt) {
    const i = queue[qh++];
    const z = Math.floor(i / (nx * ny));
    const y = Math.floor((i - z * nx * ny) / nx);
    const x = i - (z * ny + y) * nx;
    if (x > 0) push(x - 1, y, z);
    if (x < nx - 1) push(x + 1, y, z);
    if (y > 0) push(x, y - 1, z);
    if (y < ny - 1) push(x, y + 1, z);
    if (z > 0) push(x, y, z - 1);
    if (z < nz - 1) push(x, y, z + 1);
  }

  // keep triangles whose surface touches outside-reachable space
  const touchesOutside = (x, y, z) => {
    if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) return true;
    return (
      grid[idx(x - 1, y, z)] === 2 || grid[idx(x + 1, y, z)] === 2 ||
      grid[idx(x, y - 1, z)] === 2 || grid[idx(x, y + 1, z)] === 2 ||
      grid[idx(x, y, z - 1)] === 2 || grid[idx(x, y, z + 1)] === 2
    );
  };
  const out = [];
  for (const t of tris) {
    let keep = false;
    eachSample(t, (x, y, z) => { if (!keep && touchesOutside(x, y, z)) keep = true; });
    if (keep) out.push(t);
  }
  // safety: never cull more than 90% — a degenerate grid (all-occupied thin
  // model) must not delete the mesh
  if (out.length < tris.length * 0.1) return { tris, culled: 0 };
  return { tris: out, culled: tris.length - out.length };
}

// ---------- connected components (stats) ----------

export function countComponents(tris, weldFrac = 1e-4) {
  if (tris.length === 0 || tris.length > 300000) return null; // stats only
  let minX = 1/0, minY = 1/0, minZ = 1/0, maxX = -1/0, maxY = -1/0, maxZ = -1/0;
  for (const t of tris) for (const q of t.p) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    if (q.z < minZ) minZ = q.z; if (q.z > maxZ) maxZ = q.z;
  }
  const eps = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * weldFrac || 1e-9;
  const vid = new Map();
  const parent = [];
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  };
  const vertId = (q) => {
    const k = Math.round(q.x / eps) + ',' + Math.round(q.y / eps) + ',' + Math.round(q.z / eps);
    let id = vid.get(k);
    if (id === undefined) { id = parent.length; parent.push(id); vid.set(k, id); }
    return id;
  };
  for (const t of tris) {
    const a = vertId(t.p[0]), b = vertId(t.p[1]), c = vertId(t.p[2]);
    union(a, b); union(b, c);
  }
  const roots = new Set();
  for (let i = 0; i < parent.length; i++) roots.add(find(i));
  return roots.size;
}

// ---------- working-mesh reduction ----------

// Reduce colored leaves toward the target count with a SINGLE vertex-
// clustering pass applied to the ORIGINAL leaves (never cumulative — the old
// ladder re-clustered its own already-clustered output through
// decimateTriangles then clusterAt, which compounds melting/erosion on every
// step). The grid resolution (cells across the bbox max dimension) is found
// by binary search so the result lands at or just under `target`; the floor
// is 16 cells — never coarser, "blocky" is the mode's contract, not mush.
// Cell representatives are GLOBAL (not per color), so boundary vertices of
// differently-colored triangles snap to the same position — no cracks along
// color borders.
export function reduceLeaves(leaves, target) {
  if (leaves.length <= target) return leaves;
  const FLOOR_RES = 16;
  let floor = clusterAt(leaves, FLOOR_RES);
  if (floor.length >= leaves.length) return leaves; // clustering had no effect
  if (floor.length > target) return floor; // can't hit target without going coarser than the floor

  let lo = FLOOR_RES, hi = 1024;
  let best = floor;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const out = clusterAt(leaves, mid);
    if (out.length <= target) { lo = mid; best = out; } else { hi = mid; }
  }
  return best;
}

// vertex clustering at an explicit grid resolution (mirror of decimate.js)
function clusterAt(tris, gridRes) {
  let minX = 1/0, minY = 1/0, minZ = 1/0, maxX = -1/0, maxY = -1/0, maxZ = -1/0;
  for (const t of tris) for (const q of t.p) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    if (q.z < minZ) minZ = q.z; if (q.z > maxZ) maxZ = q.z;
  }
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!(maxDim > 0)) return tris;
  const cell = maxDim / gridRes;
  const key = (p) =>
    Math.round(p.x / cell) + ',' + Math.round(p.y / cell) + ',' + Math.round(p.z / cell);
  const cells = new Map();
  for (const t of tris) for (const q of t.p) {
    const k = key(q);
    let c = cells.get(k);
    if (!c) { c = { x: 0, y: 0, z: 0, n: 0 }; cells.set(k, c); }
    c.x += q.x; c.y += q.y; c.z += q.z; c.n++;
  }
  const out = [];
  for (const t of tris) {
    const ks = t.p.map(key);
    if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
    const p = ks.map((k) => {
      const c = cells.get(k);
      return { x: c.x / c.n, y: c.y / c.n, z: c.z / c.n };
    });
    out.push({ ...t, p });
  }
  return out;
}

// ---------- hyper entry points ----------

// Before coloring: interior cull + component stats.
export function hyperPreprocess(raw, params, stats) {
  stats.components = countComponents(raw) ?? undefined;
  const res = cullInterior(raw, params.hyperCullRes ?? 72);
  if (res.culled) stats.culledInterior = res.culled;
  return res.tris;
}

// Majority-filter the palette assignment over mesh adjacency: gradients
// (fur, shading) otherwise quantize into a patchwork of alternating palette
// colors that blocks merging entirely. A leaf whose edge-neighbors agree on
// a different palette color adopts it — but ONLY when that agreement is a
// real majority (bestN >= 3 AND > 60% of its neighbors) and the flip isn't
// crossing a real feature edge: if the leaf's current palette color is far
// (Lab ΔE > ~12) from the proposed neighbor color, the difference is a real
// boundary (eye, marking, seam) rather than shading/quantization noise, and
// the flip is skipped. `paletteLabs` (palette color -> Lab, indexed same as
// idxOf's values) is required for the ΔE guard; pass null to disable it.
export function smoothPaletteAssignment(leaves, idxOf, passes = 2, paletteLabs = null) {
  if (leaves.length < 8) return;
  // bbox-relative vertex key
  let minX = 1/0, minY = 1/0, minZ = 1/0, maxD = 0;
  let maxX = -1/0, maxY = -1/0, maxZ = -1/0;
  for (const t of leaves) for (const q of t.p) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    if (q.z < minZ) minZ = q.z; if (q.z > maxZ) maxZ = q.z;
  }
  maxD = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const eps = maxD * 2e-5;
  const vk = (q) =>
    Math.round(q.x / eps) + ',' + Math.round(q.y / eps) + ',' + Math.round(q.z / eps);
  // edge -> adjacent leaf ids
  const edges = new Map();
  const edgeKeys = (t) => {
    const k = t.p.map(vk);
    return [
      k[0] < k[1] ? k[0] + '|' + k[1] : k[1] + '|' + k[0],
      k[1] < k[2] ? k[1] + '|' + k[2] : k[2] + '|' + k[1],
      k[0] < k[2] ? k[0] + '|' + k[2] : k[2] + '|' + k[0],
    ];
  };
  for (let i = 0; i < leaves.length; i++) {
    for (const ek of edgeKeys(leaves[i])) {
      let arr = edges.get(ek);
      if (!arr) { arr = []; edges.set(ek, arr); }
      arr.push(i);
    }
  }
  const neighbors = leaves.map(() => []);
  for (const arr of edges.values()) {
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        neighbors[arr[a]].push(arr[b]);
        neighbors[arr[b]].push(arr[a]);
      }
    }
  }
  for (let pass = 0; pass < passes; pass++) {
    let changed = 0;
    for (let i = 0; i < leaves.length; i++) {
      const own = idxOf[i];
      const counts = new Map();
      for (const n of neighbors[i]) {
        counts.set(idxOf[n], (counts.get(idxOf[n]) ?? 0) + 1);
      }
      let best = own, bestN = 0;
      for (const [idx, n] of counts) {
        if (n > bestN) { bestN = n; best = idx; }
      }
      const total = neighbors[i].length;
      const isMajority = bestN >= 3 && bestN > total * 0.6;
      if (best !== own && isMajority) {
        if (paletteLabs && labDist(paletteLabs[own], paletteLabs[best]) > 12) continue; // real feature edge
        idxOf[i] = best; changed++;
      }
    }
    if (!changed) break;
  }
}

// After coloring: snap every leaf color to a compact CIELAB palette, smooth
// the assignment over the surface, then reduce the working mesh toward a
// budget-realistic size. Palette-exact colors make the downstream merge and
// pairing passes collapse maximally (colorTolerance 0).
//
// leafTargetOverride: when given, used verbatim instead of the default
// cap/expansion guess — converter.js's hyper budget-feedback loop supplies
// this after MEASURING the actual leaf->decoration expansion of a prior
// attempt (the default guess below is only a first approximation).
export function hyperReduce(colored, params, stats, leafTargetOverride = null) {
  if (!colored.length) return colored;
  const area = (t) => {
    const ux = t.p[1].x - t.p[0].x, uy = t.p[1].y - t.p[0].y, uz = t.p[1].z - t.p[0].z;
    const vx = t.p[2].x - t.p[0].x, vy = t.p[2].y - t.p[0].y, vz = t.p[2].z - t.p[0].z;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    return Math.hypot(cx, cy, cz) / 2;
  };
  const entries = colored.map((t) => ({ color: t.color, w: area(t) + 1e-12 }));
  // Budget-coupled palette size (plan §2.1, cheap-lever round-2 item): more
  // decoration budget buys more flat colors. At the 4995-10000 band the default
  // palette scales 32 -> 64 with the cap (just_a_girl uses only 17/32 by
  // default but 36/64 when allowed, and fails on fine-detail ΔE). An explicit
  // hyperColors slider value (anything other than the 32 default) still wins.
  const capForColors = params.maxDecorations || 99900;
  let defColors = 32;
  if (capForColors < 99900) {
    const t = Math.max(0, Math.min(1, (capForColors - 4995) / (10000 - 4995)));
    // 32 -> 48 across the band. Capped below the 64 slider max: pushing to 64
    // over-fragments shading-gradient models (shiba's fur clusters to 53 flat
    // colors at ΔE6, none of them identity) for no ΔE win, while 48 still
    // clears the fine-detail models that actually use the slots (just_a_girl 36).
    defColors = Math.round(32 + 16 * t);
  }
  const chosenColors = (params.hyperColors && params.hyperColors !== 32)
    ? params.hyperColors : defColors;
  const maxColors = Math.max(4, Math.min(64, chosenColors));
  const palette = buildPalette(entries, maxColors);
  stats.paletteColors = palette.colors.length;

  // palette index per leaf (arrays shared per index so merge compares 0)
  const labs = palette.colors.map(rgbToLab);
  const nearest = (c) => {
    const lab = rgbToLab(c);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < labs.length; i++) {
      const d = labDist(lab, labs[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  let idxOf = colored.map((t) => nearest(t.color));
  smoothPaletteAssignment(colored, idxOf, 1, labs);
  for (let i = 0; i < colored.length; i++) colored[i].color = palette.colors[idxOf[i]];

  // Budget-realistic working size. Default goal is the actual decoration cap
  // (not a fixed sub-fraction of it — the pre-revision 0.45x goal is why
  // matilda/just_a_girl landed with budget left on the table): the unbounded
  // default keeps the plan's original tier-ladder aim (2400), an explicit Max
  // Decorations spends the whole cap. Divide by the measured leaf->decoration
  // expansion (tuned to 1.7x — the 5-model reference suite measured 1.6-1.7x
  // post-fix, notably lower than the original 2.2x assumption from the
  // pre-Phase-1.5 pipeline) for a first-pass leaf target that lands close to
  // the cap without a retry; converter.js's budget-feedback loop (hyper mode
  // + explicit cap) supplies leafTargetOverride with the ACTUAL measured
  // expansion on subsequent attempts for models whose ratio differs.
  const cap = params.maxDecorations || 99900;
  const goal = cap >= 99900 ? 2400 : Math.max(600, cap);
  const target = leafTargetOverride ?? Math.max(400, Math.round(goal / 1.85));
  // Constrained QEM edge-collapse + connected-component splitting (plan P1).
  // Reduces each welded component toward its own share of `target` so distinct
  // objects can never fuse (the clustering reducer averaged vertices across a
  // shared grid cell, fusing/slivering separate shards). Falls back to the
  // single-pass clustering reducer when QEM returns null (input welded into
  // near-pure triangle soup — no connectivity to exploit).
  let reduced = null;
  try {
    reduced = qemReduce(colored, idxOf, target, palette.colors);
  } catch (e) {
    reduced = null;
  }
  if (!reduced) reduced = reduceLeaves(colored, target);
  stats.leafTarget = target;

  // smooth again on the coarser mesh (decimation reshuffles boundaries);
  // single pass only here — the coarse mesh has few triangles per feature,
  // so a second pass was outvoting small identity features entirely.
  idxOf = reduced.map((t) => nearest(t.color));
  smoothPaletteAssignment(reduced, idxOf, 1, labs);
  for (let i = 0; i < reduced.length; i++) reduced[i].color = palette.colors[idxOf[i]];

  stats.afterReduce = reduced.length;
  return reduced;
}
