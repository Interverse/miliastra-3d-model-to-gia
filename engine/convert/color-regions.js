// Color-aware triangle segmentation (replaces recursive spread-driven
// midpoint subdivision).
//
// Two stages:
//
// 1. Region map (per texture, cached): texel colors are clustered with the
//    perceptual tolerance, connected components are labeled, adjacent
//    regions with negligible visual difference are merged (union-find), and
//    insignificant regions (importance = relative area × contrast below a
//    threshold) are absorbed into their dominant neighbor. The result is a
//    simplified label grid that follows the overall shape of color regions
//    instead of individual texel changes — dither, gradients and noise
//    collapse into large flat regions while small high-contrast details
//    (importance high despite small area) survive.
//
// 2. Triangle segmentation: each triangle's UV footprint is rasterized on
//    the label grid. Uniform footprints emit ONE leaf. Mixed footprints are
//    split along a fitted straight line between the two dominant regions
//    (LDA-style axis + optimal 1D threshold), so a straight color boundary
//    costs a handful of well-shaped polygons instead of 4^depth midpoint
//    fragments. Only when no line separates the regions cleanly does it
//    fall back to one 4-way midpoint split. Alpha boundaries are cut
//    exactly like color edges (transparent is a region), preserving the
//    perceived silhouette.
//
// Leaf colors come from the region palette, so neighboring triangles emit
// EXACTLY equal colors — downstream coplanar merging and square pairing see
// clean groups. Everything is deterministic (fixed scan orders, no RNG):
// identical inputs give identical outputs across models and resolutions.

import { colorDistance } from './color.js';

// segmentation tuning
const CUT_QUALITY = 0.06;        // max misclassified A/B fraction for a line cut
const CUT_MAX_DEPTH = 40;        // line-cut recursion cap (tree height; thin
                                 // features like outlines need many strips)
const SAMPLE_CAP = 16384;        // max footprint samples per triangle
const SNAP_FRAC = 0.02;          // corner snap distance (fraction of s-range)
const T_SNAP = 0.35;             // snap threshold to a texel boundary within this
// perceptual significance: a minority matters when its EXCESS texels (beyond
// the residue allowance inherited from the cut that created this piece) are
// visible and its area × contrast importance is above threshold
const MIN_DETAIL_TEXELS = 3;     // absolute visibility floor (texels)
const SIG_IMPORTANCE = 12;       // × tolerance → texels × RGB-distance floor
                                 // (matches ABS_IMPORTANCE: whatever survived
                                 // region absorption also gets resolved, even
                                 // when a cut slices a tiny feature apart)
const RESIDUE_DEPTH = 1.1;       // accepted boundary displacement (texels):
                                 // minority texels within this depth of the
                                 // piece boundary are treated as invisible
                                 // straight-cut residue; anything deeper
                                 // keeps refining — bounds poke depth
                                 // globally (alpha edges use 0.6× of it)
const DP_TOL = 1.0;              // Douglas–Peucker tolerance (texels) for the
                                 // simplified region-boundary polylines that
                                 // guide the cuts — must exceed the worst
                                 // rasterization staircase amplitude (~1
                                 // texel, intercept-dependent) so texel
                                 // stairs collapse into straight chords;
                                 // real corners deviate far more and are
                                 // always kept
const DP_CONTRAST_REF = 75;      // boundary contrast at which DP_TOL applies
                                 // unscaled; lower-contrast boundaries take
                                 // proportionally coarser curves (fewer
                                 // secants where the eye can't see the
                                 // boundary precisely), capped at:
const DP_TOL_MAX_SCALE = 2.5;
// transition-band absorption (anti-aliased organic edges): a thin region
// sandwiched between two others whose color sits on the RGB segment
// between them is a soft-edge artifact — absorbing it turns the doubled
// boundary back into ONE edge. Real thin features (mouth/eye lines) have
// colors far from the neighbor mix and are never absorbed.
const BAND_MAX_THICKNESS = 1.6;  // area / boundary-length below this = thin
const BAND_NEIGHBOR_FRAC = 0.65; // two dominant neighbors ≥ this much border
const BAND_BETWEEN_TOL = 0.8;    // × tolerance: max distance from the mix line
const SEG_CELL = 16;             // bucket size (texels) of the segment index
const EMPTY_ALLOW = new Map();   // shared empty residue-allowance map
// region-map tuning
const MERGE_FRAC = 1.0;          // merge adjacent regions within tol × this
const ABS_IMPORTANCE = 12;       // × tolerance → area × contrast below which a
                                 // region is absorbed (absolute texel units, so
                                 // small high-contrast details survive on large
                                 // textures too)
const KEEP_AREA_FRAC = 0.01;     // never absorb regions above 1% of the image

// ---------------------------------------------------------------------------
// stage 1: simplified region map per texture
// ---------------------------------------------------------------------------

const cache = new WeakMap(); // texture -> Map(key -> regionMap)

export function buildRegionMap(texture, tolerance, alphaCutoff) {
  const key = `${Math.round(tolerance * 10)}_${Math.round(alphaCutoff * 255)}`;
  let byKey = cache.get(texture);
  if (byKey?.has(key)) return byKey.get(key);

  const { width: W, height: H, data } = texture;
  const N = W * H;
  const aCut = Math.max(1, Math.round(alphaCutoff * 255));

  // --- cluster texel colors (deterministic first-fit on a compact palette)
  // exact palette when the texture has few unique colors, else binned
  const clusterOf = new Int32Array(N).fill(-1); // -1 = transparent
  const clusterColors = [];
  {
    const exact = new Map(); // rgb int -> count (bail out when too many)
    let exactOk = true;
    for (let i = 0; i < N; i++) {
      if (data[i * 4 + 3] < aCut) continue;
      const c = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
      exact.set(c, (exact.get(c) ?? 0) + 1);
      if (exact.size > 4096) { exactOk = false; break; }
    }
    let entries; // [repR, repG, repB, count, lookupKey]
    let lookup;  // Map lookupKey -> palette index
    if (exactOk) {
      entries = [...exact.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .map(([c, n]) => [(c >> 16) & 255, (c >> 8) & 255, c & 255, n, c]);
      lookup = (i) => {
        const o = i * 4;
        return (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
      };
    } else {
      // 5-bit bins for tight tolerances, 4-bit otherwise (≤7 / ≤14 error)
      const bits = tolerance < 24 ? 5 : 4, shift = 8 - bits;
      const bins = new Map(); // bin key -> [sumR,sumG,sumB,count]
      for (let i = 0; i < N; i++) {
        if (data[i * 4 + 3] < aCut) continue;
        const o = i * 4;
        const k = ((data[o] >> shift) << (2 * bits)) |
                  ((data[o + 1] >> shift) << bits) | (data[o + 2] >> shift);
        let b = bins.get(k);
        if (!b) bins.set(k, b = [0, 0, 0, 0]);
        b[0] += data[o]; b[1] += data[o + 1]; b[2] += data[o + 2]; b[3]++;
      }
      entries = [...bins.entries()]
        .sort((a, b) => b[1][3] - a[1][3] || a[0] - b[0])
        .map(([k, b]) => [b[0] / b[3], b[1] / b[3], b[2] / b[3], b[3], k]);
      lookup = (i) => {
        const o = i * 4;
        return ((data[o] >> shift) << (2 * bits)) |
               ((data[o + 1] >> shift) << bits) | (data[o + 2] >> shift);
      };
    }
    // first-fit clustering of palette entries (most frequent first, so
    // cluster representatives sit on the visually dominant colors)
    for (const [r, g, b] of entries) {
      let best = -1, bestD = tolerance;
      for (let c = 0; c < clusterColors.length; c++) {
        const d = colorDistance([r, g, b], clusterColors[c].color);
        if (d <= bestD) { best = c; bestD = d; }
      }
      if (best < 0) clusterColors.push({ color: [r, g, b] });
    }
    // Lloyd refinement (deterministic): reassign entries to the nearest
    // cluster MEAN and recompute means. First-fit alone leaves boundary
    // oscillation on smooth ramps (interleaved stripes); a few iterations
    // make each cluster a contiguous color range.
    const keyToCluster = new Map();
    for (let it = 0; it < 4; it++) {
      const sums = clusterColors.map(() => [0, 0, 0, 0]);
      for (const [r, g, b, n, k] of entries) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < clusterColors.length; c++) {
          const d = colorDistance([r, g, b], clusterColors[c].color);
          if (d < bd) { bd = d; best = c; }
        }
        const s = sums[best];
        s[0] += r * n; s[1] += g * n; s[2] += b * n; s[3] += n;
        if (it === 3) keyToCluster.set(k, best);
      }
      for (let c = 0; c < clusterColors.length; c++) {
        if (sums[c][3] > 0) {
          clusterColors[c].color = [
            sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3],
          ];
        }
      }
    }
    for (let i = 0; i < N; i++) {
      if (data[i * 4 + 3] >= aCut) clusterOf[i] = keyToCluster.get(lookup(i));
    }
  }

  // --- connected components (4-connectivity) of equal clusters
  const region = new Int32Array(N).fill(-1);
  const regions = []; // { cluster, area }
  {
    const stack = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      if (clusterOf[i] < 0 || region[i] >= 0) continue;
      const id = regions.length, cl = clusterOf[i];
      let area = 0, top = 0;
      stack[top++] = i; region[i] = id;
      while (top > 0) {
        const j = stack[--top];
        area++;
        const x = j % W, y = (j / W) | 0;
        if (x > 0 && region[j - 1] < 0 && clusterOf[j - 1] === cl) { region[j - 1] = id; stack[top++] = j - 1; }
        if (x + 1 < W && region[j + 1] < 0 && clusterOf[j + 1] === cl) { region[j + 1] = id; stack[top++] = j + 1; }
        if (y > 0 && region[j - W] < 0 && clusterOf[j - W] === cl) { region[j - W] = id; stack[top++] = j - W; }
        if (y + 1 < H && region[j + W] < 0 && clusterOf[j + W] === cl) { region[j + W] = id; stack[top++] = j + W; }
      }
      regions.push({ cluster: cl, area });
    }
  }

  // --- union-find over regions for merging / absorption; each root keeps a
  // running area-weighted mean color so chained merges compare against the
  // ACTUAL accumulated color, not a stale representative (a gradient merges
  // band by band until the mean drifts out of tolerance, then stops)
  const parent = new Int32Array(regions.length);
  const rSum = new Float64Array(regions.length * 3);
  const rN = new Float64Array(regions.length);
  for (let i = 0; i < parent.length; i++) {
    parent[i] = i;
    const c = clusterColors[regions[i].cluster].color;
    rSum[i * 3] = c[0] * regions[i].area;
    rSum[i * 3 + 1] = c[1] * regions[i].area;
    rSum[i * 3 + 2] = c[2] * regions[i].area;
    rN[i] = regions[i].area;
  }
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  const union = (a, b) => { // b into a (both roots)
    parent[b] = a;
    rSum[a * 3] += rSum[b * 3]; rSum[a * 3 + 1] += rSum[b * 3 + 1]; rSum[a * 3 + 2] += rSum[b * 3 + 2];
    rN[a] += rN[b];
  };
  const colorOfR = (r) => {
    const a = find(r);
    return [rSum[a * 3] / rN[a], rSum[a * 3 + 1] / rN[a], rSum[a * 3 + 2] / rN[a]];
  };

  // adjacency with shared-boundary lengths (rebuilt each pass over roots)
  const buildAdjacency = () => {
    const adj = new Map(); // root -> Map(otherRoot -> boundaryLen)
    const bump = (a, b) => {
      let m = adj.get(a);
      if (!m) adj.set(a, m = new Map());
      m.set(b, (m.get(b) ?? 0) + 1);
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (region[i] < 0) continue;
        const a = find(region[i]);
        if (x + 1 < W && region[i + 1] >= 0) {
          const b = find(region[i + 1]);
          if (a !== b) { bump(a, b); bump(b, a); }
        }
        if (y + 1 < H && region[i + W] >= 0) {
          const b = find(region[i + W]);
          if (a !== b) { bump(a, b); bump(b, a); }
        }
      }
    }
    return adj;
  };
  const rootArea = () => {
    const area = new Map();
    for (let r = 0; r < regions.length; r++) {
      const root = find(r);
      area.set(root, (area.get(root) ?? 0) + regions[r].area);
    }
    return area;
  };

  // pass A: merge adjacent regions whose colors differ negligibly (their
  // texels stayed in different clusters only through center drift)
  {
    let changed = true, guard = 0;
    while (changed && guard++ < 8) {
      changed = false;
      const adj = buildAdjacency();
      for (const [a, m] of adj) {
        for (const b of m.keys()) {
          const ra = find(a), rb = find(b);
          if (ra === rb) continue;
          if (colorDistance(colorOfR(ra), colorOfR(rb)) <= tolerance * MERGE_FRAC) {
            // merge smaller into larger (stable, order-independent-ish)
            if (rN[ra] >= rN[rb]) union(ra, rb); else union(rb, ra);
            changed = true;
          }
        }
      }
    }
  }

  // pass B: absorb insignificant regions into their dominant neighbor.
  // importance = (area / opaque texels) × contrast-to-closest-neighbor:
  // low-contrast specks and dither vanish, small high-contrast details stay.
  let opaqueTotal = 0;
  for (let i = 0; i < N; i++) if (clusterOf[i] >= 0) opaqueTotal++;
  if (opaqueTotal > 0) {
    let changed = true, guard = 0;
    while (changed && guard++ < 6) {
      changed = false;
      const adj = buildAdjacency();
      const area = rootArea();
      // smallest regions first — absorption is order-stable
      const roots = [...adj.keys()].sort((a, b) => area.get(a) - area.get(b) || a - b);
      for (const r of roots) {
        if (find(r) !== r) continue;
        const m = adj.get(r);
        if (!m || m.size === 0) continue;
        const rArea = area.get(r);
        if (rArea / opaqueTotal >= KEEP_AREA_FRAC) continue;
        // dominant neighbor = longest shared boundary (root-collapsed)
        const shared = new Map();
        let minDist = Infinity;
        for (const [b0, len] of m) {
          const b = find(b0);
          if (b === r) continue;
          shared.set(b, (shared.get(b) ?? 0) + len);
          minDist = Math.min(minDist, colorDistance(colorOfR(r), colorOfR(b)));
        }
        if (!shared.size) continue;
        // absolute importance: area × contrast (a tiny high-contrast eye on
        // a large texture stays; low-contrast specks and dither vanish)
        if (rArea * minDist >= ABS_IMPORTANCE * tolerance) continue;
        let best = -1, bestLen = -1;
        for (const [b, len] of shared) {
          if (len > bestLen || (len === bestLen && b < best)) { best = b; bestLen = len; }
        }
        union(best, r); // absorbed region tints the absorber's mean slightly
        changed = true;
      }
    }
  }

  // pass C: absorb anti-aliasing TRANSITION BANDS (organic textures). A
  // thin region squeezed between two dominant neighbors whose color lies
  // on the RGB segment between those neighbors' colors is a soft-edge
  // artifact of clustering an anti-aliased boundary; absorbing it into the
  // closer neighbor restores ONE boundary (instead of two parallel ones
  // with sliver geometry between them). Real thin features — mouth lines,
  // eye outlines — have colors far from the neighbor mix and are kept.
  {
    let changed = true, guard = 0;
    while (changed && guard++ < 4) {
      changed = false;
      const adj = buildAdjacency();
      const area = rootArea();
      // account image/transparent border in the boundary length
      const borderLen = new Map();
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (region[i] < 0) continue;
          const r = find(region[i]);
          let b = 0;
          if (x === 0 || region[i - 1] < 0) b++;
          if (x === W - 1 || region[i + 1] < 0) b++;
          if (y === 0 || region[i - W] < 0) b++;
          if (y === H - 1 || region[i + W] < 0) b++;
          if (b) borderLen.set(r, (borderLen.get(r) ?? 0) + b);
        }
      }
      const roots = [...adj.keys()].sort((a, b) => area.get(a) - area.get(b) || a - b);
      for (const r of roots) {
        if (find(r) !== r) continue;
        const m = adj.get(r);
        if (!m || m.size === 0) continue;
        const rArea = area.get(r);
        if (rArea / opaqueTotal >= KEEP_AREA_FRAC) continue;
        const shared = new Map();
        for (const [b0, len] of m) {
          const b = find(b0);
          if (b === r) continue;
          shared.set(b, (shared.get(b) ?? 0) + len);
        }
        if (!shared.size) continue;
        let totalLen = borderLen.get(r) ?? 0;
        for (const len of shared.values()) totalLen += len;
        if (rArea / Math.max(1, totalLen) >= BAND_MAX_THICKNESS) continue; // not thin
        // two dominant neighbors must own most of the border
        const top = [...shared.entries()].sort((p, q) => q[1] - p[1] || p[0] - q[0]);
        const n1 = top[0], n2 = top[1] ?? top[0];
        if ((n1[1] + (top[1]?.[1] ?? 0)) < totalLen * BAND_NEIGHBOR_FRAC) continue;
        // color must sit near the segment between the neighbors' colors
        const c = colorOfR(r), c1 = colorOfR(n1[0]), c2 = colorOfR(n2[0]);
        const vx = c2[0] - c1[0], vy = c2[1] - c1[1], vz = c2[2] - c1[2];
        const vv = vx * vx + vy * vy + vz * vz;
        let t = vv < 1e-9 ? 0 :
          ((c[0] - c1[0]) * vx + (c[1] - c1[1]) * vy + (c[2] - c1[2]) * vz) / vv;
        t = Math.max(0, Math.min(1, t));
        const mix = [c1[0] + vx * t, c1[1] + vy * t, c1[2] + vz * t];
        if (colorDistance(c, mix) > tolerance * BAND_BETWEEN_TOL) continue; // real feature
        const into = colorDistance(c, c1) <= colorDistance(c, c2) ? n1[0] : n2[0];
        union(into, r);
        changed = true;
      }
    }
  }

  // --- flatten: final label per texel + palette
  const rootToLabel = new Map();
  const colors = [];
  const labels = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (region[i] < 0) continue;
    const root = find(region[i]);
    let lb = rootToLabel.get(root);
    if (lb == null) {
      lb = colors.length;
      rootToLabel.set(root, lb);
      colors.push(colorOfR(root));
    }
    labels[i] = lb;
  }

  const map = {
    width: W, height: H, labels, colors,
    regionCount: colors.length, opaqueTexels: opaqueTotal,
  };
  // globally consistent smooth boundary polylines: every triangle cuts along
  // the SAME simplified segments, so curve approximations never zigzag
  const { segs, segIndex } = traceBoundarySegments(labels, W, H, colors, tolerance);
  map.segs = segs;
  map.segIndex = segIndex;
  if (!byKey) cache.set(texture, byKey = new Map());
  byKey.set(key, map);
  return map;
}

// ---------------------------------------------------------------------------
// boundary contours: exact label-grid boundary polylines per label pair,
// simplified with Douglas–Peucker — the shared "smooth curve" that guides
// all cuts consistently
// ---------------------------------------------------------------------------

function dpIndices(pts, tol) { // Douglas–Peucker: kept point INDICES
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 - i0 < 2) continue;
    const [x0, y0] = pts[i0], [x1, y1] = pts[i1];
    let dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    let worst = -1, worstD = tol;
    for (let i = i0 + 1; i < i1; i++) {
      const d = len < 1e-9
        ? Math.hypot(pts[i][0] - x0, pts[i][1] - y0)
        : Math.abs(dy * (pts[i][0] - x0) - dx * (pts[i][1] - y0)) / len;
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([i0, worst], [worst, i1]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
  return out;
}

// Least-squares refit of the DP spans: DP anchors sit ON the rasterization
// staircase (up to ±tol off the true edge), so raw DP chords wobble. Each
// span is refit by total least squares over ALL its boundary points, spans
// that stay collinear within tol are merged, and vertices are placed at the
// intersections of consecutive fitted lines — a straight texel staircase
// reconstructs as ONE exactly straight segment, curves as balanced secants.
function refitPolyline(pts, idxs, closed, tol) {
  const fit = (i0, i1) => { // TLS via PCA over pts[i0..i1]
    let mx = 0, my = 0;
    const n = i1 - i0 + 1;
    for (let i = i0; i <= i1; i++) { mx += pts[i][0]; my += pts[i][1]; }
    mx /= n; my /= n;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = i0; i <= i1; i++) {
      const ux = pts[i][0] - mx, uy = pts[i][1] - my;
      sxx += ux * ux; sxy += ux * uy; syy += uy * uy;
    }
    // principal direction of the 2x2 covariance
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
    let dx, dy;
    if (Math.abs(sxy) > 1e-12) { dx = l1 - syy; dy = sxy; }
    else if (sxx >= syy) { dx = 1; dy = 0; }
    else { dx = 0; dy = 1; }
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl; dy /= dl;
    let maxDev = 0;
    for (let i = i0; i <= i1; i++) {
      const d = Math.abs(dx * (pts[i][1] - my) - dy * (pts[i][0] - mx));
      if (d > maxDev) maxDev = d;
    }
    return { mx, my, dx, dy, maxDev };
  };
  // merge consecutive DP spans while a combined fit stays within tol
  const groups = [];
  let g0 = idxs[0], g1 = idxs[1];
  for (let k = 1; k + 1 < idxs.length; k++) {
    if (fit(g0, idxs[k + 1]).maxDev <= tol) { g1 = idxs[k + 1]; continue; }
    groups.push([g0, g1]);
    g0 = idxs[k]; g1 = idxs[k + 1];
  }
  groups.push([g0, g1]);
  const fits = groups.map(([a, b]) => fit(a, b));

  const project = (f, p) => {
    const t = (p[0] - f.mx) * f.dx + (p[1] - f.my) * f.dy;
    return [f.mx + t * f.dx, f.my + t * f.dy];
  };
  const intersect = (fa, fb, anchor) => {
    const cross = fa.dx * fb.dy - fa.dy * fb.dx;
    if (Math.abs(cross) < 0.05) return project(fa, anchor); // near-parallel
    const t = ((fb.mx - fa.mx) * fb.dy - (fb.my - fa.my) * fb.dx) / cross;
    const p = [fa.mx + t * fa.dx, fa.my + t * fa.dy];
    // reject wild intersections (very obtuse joins): fall back to anchor
    if (Math.hypot(p[0] - anchor[0], p[1] - anchor[1]) > 3 * tol + 1) {
      return project(fa, anchor);
    }
    return p;
  };

  const verts = [];
  if (closed && fits.length === 1) {
    // a tiny closed loop must never collapse onto a single fitted line
    // (that line cuts straight through the feature): keep the DP polygon
    return idxs.map((i) => pts[i]);
  }
  if (closed && fits.length > 1) {
    for (let k = 0; k < fits.length; k++) {
      const fa = fits[k], fb = fits[(k + 1) % fits.length];
      verts.push(intersect(fa, fb, pts[groups[k][1]]));
    }
    verts.unshift(verts[verts.length - 1]); // close the ring
  } else {
    verts.push(project(fits[0], pts[groups[0][0]]));
    for (let k = 0; k + 1 < fits.length; k++) {
      verts.push(intersect(fits[k], fits[k + 1], pts[groups[k][1]]));
    }
    verts.push(project(fits[fits.length - 1], pts[groups[groups.length - 1][1]]));
  }
  return verts;
}

export function traceBoundarySegments(labels, W, H, colors, tolerance) {
  // contrast-adaptive curve tolerance: sharp boundaries (organic feature
  // lines, silhouettes) keep DP_TOL; low-contrast boundaries take coarser
  // secants — the eye can't localize a faint edge to the texel anyway
  const pairTol = (la, lb) => {
    if (!colors || la < 0 || lb < 0) return DP_TOL; // alpha edges stay tight
    const d = colorDistance(colors[la], colors[lb]);
    return DP_TOL * Math.min(DP_TOL_MAX_SCALE, Math.max(1, DP_CONTRAST_REF / Math.max(1, d)));
  };
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? -1 : labels[y * W + x];
  const CW = W + 1; // corner lattice width
  // DIRECTED boundary edges per label pair, oriented so the SMALLER label
  // (la) is on the left of the walking direction (image coords, y down).
  // Directed orientation + a consistent saddle rule yields simple,
  // non-self-crossing loops — an undirected walk zigzags at 4-valent
  // saddle corners and defeats the simplification entirely.
  const edgesByPair = new Map(); // key -> { la, lb, edges: [[cFrom, cTo]], out: Map(corner -> [edgeIdx]) }
  const addEdge = (a, b, cA, cB, cAtoB_hasA_left) => {
    // cA→cB has texel `a` on the left when cAtoB_hasA_left
    if (a === b) return;
    const la = Math.min(a, b), lb = Math.max(a, b);
    const k = la + '|' + lb;
    let g = edgesByPair.get(k);
    if (!g) edgesByPair.set(k, g = { la, lb, edges: [], out: new Map(), inn: new Map() });
    // orient so la is on the left
    const laIsA = a === la;
    const from = (laIsA === cAtoB_hasA_left) ? cA : cB;
    const to = (laIsA === cAtoB_hasA_left) ? cB : cA;
    const idx = g.edges.length;
    g.edges.push([from, to]);
    let l = g.out.get(from);
    if (!l) g.out.set(from, l = []);
    l.push(idx);
    let li = g.inn.get(to);
    if (!li) g.inn.set(to, li = []);
    li.push(idx);
  };
  // vertical edge (x,y)→(x,y+1): direction (0,+1), left = +x side = texel (x,y)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x <= W; x++) {
      addEdge(at(x, y), at(x - 1, y), y * CW + x, (y + 1) * CW + x, true);
    }
  }
  // horizontal edge (x,y)→(x+1,y): direction (+1,0), left = −y side = texel (x,y−1)
  for (let y = 0; y <= H; y++) {
    for (let x = 0; x < W; x++) {
      addEdge(at(x, y - 1), at(x, y), y * CW + x, y * CW + x + 1, true);
    }
  }

  const segs = []; // { x0, y0, x1, y1, la, lb }
  const cx = (c) => c % CW, cy = (c) => (c / CW) | 0;
  for (const g of edgesByPair.values()) {
    const { la, lb, edges, out, inn } = g;
    const used = new Uint8Array(edges.length);
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      // walk forward from edge i (and, for open paths, backward from its
      // start): per-pair chains are OPEN wherever another pair takes over,
      // so a forward-only walk from a mid-path start fragments the rest
      const chain = [edges[i][0], edges[i][1]];
      used[i] = 1;
      let prevDx = cx(edges[i][1]) - cx(edges[i][0]);
      let prevDy = cy(edges[i][1]) - cy(edges[i][0]);
      let cur = edges[i][1];
      let loopClosed = false;
      for (;;) {
        const cands = (out.get(cur) || []).filter((e) => !used[e]);
        if (!cands.length) break;
        // saddle rule: consistent tightest-turn preference (non-crossing)
        let best = -1, bestScore = -Infinity;
        for (const e of cands) {
          const dx = cx(edges[e][1]) - cx(edges[e][0]);
          const dy = cy(edges[e][1]) - cy(edges[e][0]);
          const cross = prevDx * dy - prevDy * dx;
          const dot = prevDx * dx + prevDy * dy;
          const score = cross * 2 + dot; // turn preference dominates straight
          if (score > bestScore) { bestScore = score; best = e; }
        }
        used[best] = 1;
        cur = edges[best][1];
        chain.push(cur);
        prevDx = cx(edges[best][1]) - cx(edges[best][0]);
        prevDy = cy(edges[best][1]) - cy(edges[best][0]);
        if (cur === chain[0]) { loopClosed = true; break; }
      }
      if (!loopClosed) {
        // extend backward from the chain start
        let head = chain[0];
        for (;;) {
          const cands = (inn.get(head) || []).filter((e) => !used[e]);
          if (!cands.length) break;
          // mirror of the saddle rule, walking upstream: prefer the edge
          // whose direction turns tightest INTO the current head direction
          const hDx = cx(chain[1]) - cx(chain[0]);
          const hDy = cy(chain[1]) - cy(chain[0]);
          let best = -1, bestScore = -Infinity;
          for (const e of cands) {
            const dx = cx(edges[e][1]) - cx(edges[e][0]);
            const dy = cy(edges[e][1]) - cy(edges[e][0]);
            const cross = dx * hDy - dy * hDx;
            const dot = dx * hDx + dy * hDy;
            const score = cross * 2 + dot;
            if (score > bestScore) { bestScore = score; best = e; }
          }
          used[best] = 1;
          head = edges[best][0];
          chain.unshift(head);
        }
      }
      let pts = chain.map((c) => [cx(c), cy(c)]);
      const tol = pairTol(la, lb);
      // closed loop: split at the farthest point from pts[0] so DP anchors
      // are meaningful, simplify both halves
      const closed = pts.length > 3 &&
        pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
      let idxs;
      if (closed) {
        let far = 1, farD = -1;
        for (let j = 1; j < pts.length - 1; j++) {
          const d = (pts[j][0] - pts[0][0]) ** 2 + (pts[j][1] - pts[0][1]) ** 2;
          if (d > farD) { farD = d; far = j; }
        }
        idxs = [
          ...dpIndices(pts.slice(0, far + 1), tol),
          ...dpIndices(pts.slice(far), tol).slice(1).map((i) => i + far),
        ];
      } else {
        idxs = dpIndices(pts, tol);
      }
      const simp = pts.length >= 3
        ? refitPolyline(pts, idxs, closed, tol)
        : idxs.map((i) => pts[i]);
      for (let j = 0; j + 1 < simp.length; j++) {
        segs.push({
          x0: simp[j][0], y0: simp[j][1], x1: simp[j + 1][0], y1: simp[j + 1][1],
          la, lb, tol,
        });
      }
    }
  }

  // uniform bucket index over segment bounding boxes
  const segIndex = new Map();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const cx0 = Math.floor(Math.min(s.x0, s.x1) / SEG_CELL);
    const cx1 = Math.floor(Math.max(s.x0, s.x1) / SEG_CELL);
    const cy0 = Math.floor(Math.min(s.y0, s.y1) / SEG_CELL);
    const cy1 = Math.floor(Math.max(s.y0, s.y1) / SEG_CELL);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cx + ',' + cy;
        let l = segIndex.get(key);
        if (!l) segIndex.set(key, l = []);
        l.push(i);
      }
    }
  }
  return { segs, segIndex };
}

// ---------------------------------------------------------------------------
// stage 2: segment one triangle against the region map
// ---------------------------------------------------------------------------

// tri: { p: [v0,v1,v2], uv: [[u,v]×3] }; emits { p, color } leaves into out.
// base: material color multiplier. Returns leaves; respects budget.
export function segmentTriangle(tri, texture, map, opts, out, stats) {
  const { base, budget, minArea, maxSubdiv, tolerance } = opts;
  // visibility floor for minority details; a very tight tolerance signals
  // near-exact intent (pixel-perfect rest path): resolve single texels there
  const minDetail = tolerance < 8 ? 1 : MIN_DETAIL_TEXELS;
  const sigImportance = SIG_IMPORTANCE * tolerance;
  const W = map.width, H = map.height;
  const flipY = texture.flipY !== false;
  // affine texel space (no per-sample wrap): X = u·W, Y = (flipY ? 1−v : v)·H
  const toTexel = (uv) => [uv[0] * W, (flipY ? 1 - uv[1] : uv[1]) * H];
  // Translate the footprint by whole tiles so it sits near [0,W]×[0,H];
  // when it then fits a single tile (± half a texel of UV slop, common on
  // flat quad faces mapped exactly to [0,1]) sampling CLAMPS instead of
  // wrapping — wrapping would read texels from the opposite texture edge
  // and invent phantom boundaries that fragment perfectly flat faces.
  const rootT = tri.uv.map(toTexel);
  let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity;
  for (const [X, Y] of rootT) {
    rMinX = Math.min(rMinX, X); rMaxX = Math.max(rMaxX, X);
    rMinY = Math.min(rMinY, Y); rMaxY = Math.max(rMaxY, Y);
  }
  const shiftX = Math.floor(rMinX / W) * W;
  const shiftY = Math.floor(rMinY / H) * H;
  for (const T of rootT) { T[0] -= shiftX; T[1] -= shiftY; }
  const clampMode =
    rMaxX - shiftX <= W + 0.5 && rMinX - shiftX >= -0.5 &&
    rMaxY - shiftY <= H + 0.5 && rMinY - shiftY >= -0.5;
  const labelAt = (X, Y) => {
    let x = Math.floor(X), y = Math.floor(Y);
    if (clampMode) {
      x = x < 0 ? 0 : x >= W ? W - 1 : x;
      y = y < 0 ? 0 : y >= H ? H - 1 : y;
    } else {
      x = ((x % W) + W) % W; y = ((y % H) + H) % H;
    }
    return map.labels[y * W + x];
  };

  const area3 = (p) => {
    const ux = p[1].x - p[0].x, uy = p[1].y - p[0].y, uz = p[1].z - p[0].z;
    const vx = p[2].x - p[0].x, vy = p[2].y - p[0].y, vz = p[2].z - p[0].z;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
  };
  const lerpV = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  const lerpUV = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  // leaf: fan-triangulate the (convex) polygon node — triangulation happens
  // ONLY here, so interior cut lines never fragment later cuts.
  // When the footprint is mixed (insignificant residue or exhaustion), each
  // FAN TRIANGLE picks the label dominant within ITS OWN footprint — a
  // piece-wide dominant would spread one color over the whole polygon and
  // poke across the boundary wherever the piece has a differently-colored
  // tail. Returns the painted label (uniform), −1 for transparent-skip, or
  // null for mixed output — callers use this for sibling-merge collapsing.
  const emitLeaf = (node, label, hist, mixedPts) => {
    const K = node.p.length;
    const mixed = mixedPts && hist && hist.size > 1;
    if (label < 0 && !mixed) { stats.transparentSkipped++; return -1; }
    const meanColor = () => { // exhausted fallback: weighted mean of regions
      let r = 0, g = 0, b = 0, w = 0;
      for (const [lb, n] of hist) {
        if (lb < 0) continue;
        const c = map.colors[lb];
        r += c[0] * n; g += c[1] * n; b += c[2] * n; w += n;
      }
      return w === 0 ? null : [r / w, g / w, b / w];
    };
    // quads: fan across the SHORTER diagonal — rectangles then split into
    // two right triangles that pair back into ONE square downstream
    let o = 0;
    if (K === 4) {
      const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
      if (d2(node.p[1], node.p[3]) < d2(node.p[0], node.p[2])) o = 1;
    }
    // dominant label among the samples inside one fan triangle
    const fanLabel = (ti) => {
      const a = node.t[o], b = node.t[(o + ti) % K], c = node.t[(o + ti + 1) % K];
      const e1 = [b[1]-a[1], a[0]-b[0], b[0]*a[1]-a[0]*b[1]];
      const e2 = [c[1]-b[1], b[0]-c[0], c[0]*b[1]-b[0]*c[1]];
      const e3 = [a[1]-c[1], c[0]-a[0], a[0]*c[1]-c[0]*a[1]];
      const ref = e1[0]*c[0] + e1[1]*c[1] + e1[2];
      const sgn = ref >= 0 ? 1 : -1;
      const counts = new Map();
      for (const [X, Y, lb] of mixedPts) {
        if (sgn * (e1[0]*X + e1[1]*Y + e1[2]) < 0) continue;
        if (sgn * (e2[0]*X + e2[1]*Y + e2[2]) < 0) continue;
        if (sgn * (e3[0]*X + e3[1]*Y + e3[2]) < 0) continue;
        counts.set(lb, (counts.get(lb) ?? 0) + 1);
      }
      let best = null, bn = -1;
      for (const [lb, n] of counts) if (n > bn || (n === bn && lb < best)) { bn = n; best = lb; }
      return best; // may be null (no samples) or -1 (transparent)
    };
    let uni, first = true, emitted = false;
    for (let i = 1; i + 1 < K; i++) {
      const p = [node.p[o], node.p[(o + i) % K], node.p[(o + i + 1) % K]];
      if (area3(p) < 1e-12) continue;
      let lb = label;
      if (mixed) {
        const fl = fanLabel(i);
        if (fl !== null) lb = fl;
      }
      if (first) { uni = lb; first = false; }
      else if (lb !== uni) uni = null;
      if (lb < 0) { stats.transparentSkipped++; continue; }
      let color;
      if (lb < map.regionCount) color = map.colors[lb];
      else { color = meanColor(); if (!color) { stats.transparentSkipped++; continue; } }
      emitted = true;
      out.push({
        p,
        color: [color[0] * base[0] / 255, color[1] * base[1] / 255, color[2] * base[2] / 255],
      });
    }
    if (first) return -1; // nothing at all
    if (uni == null || uni === map.regionCount) return null;
    return uni; // uniform real label, or −1 when everything was transparent
  };

  // recursion works on CONVEX POLYGON nodes { p, uv, t } (3..8 vertices):
  // straight cuts stay straight across the whole polygon, and axis-aligned
  // cuts on rectangular regions produce rectangles whose two fan triangles
  // pair back into ONE square placement downstream.
  // allow: Map(label -> residue texels tolerated in this piece), granted by
  // the parent cut for band-limited misclassification only
  const recurse = (node, depth, midDepth, allow) => {
    const T = node.t; // texel-space corners [[X,Y]×k]
    const K = T.length;
    // texel-space signed area (shoelace): degenerate → single sample
    let sa2 = 0;
    for (let i = 0; i < K; i++) {
      const a = T[i], b = T[(i + 1) % K];
      sa2 += a[0] * b[1] - b[0] * a[1];
    }
    let ctx = 0, cty = 0;
    for (const [X, Y] of T) { ctx += X / K; cty += Y / K; }
    if (Math.abs(sa2) < 2e-9) {
      return emitLeaf(node, labelAt(ctx, cty), new Map());
    }
    // footprint sample lattice (bbox scan, stride keeps ≤ SAMPLE_CAP)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [X, Y] of T) {
      minX = Math.min(minX, X); maxX = Math.max(maxX, X);
      minY = Math.min(minY, Y); maxY = Math.max(maxY, Y);
    }
    const bw = Math.max(1, Math.ceil(maxX) - Math.floor(minX));
    const bh = Math.max(1, Math.ceil(maxY) - Math.floor(minY));
    const stride = Math.max(1, Math.ceil(Math.sqrt((bw * bh) / SAMPLE_CAP)));
    // edge functions for point-in-convex-polygon; orientation calibrated on
    // the centroid (interior of a convex polygon by construction)
    const e = [];
    for (let k = 0; k < K; k++) {
      const a = T[k], b = T[(k + 1) % K];
      e.push([b[1] - a[1], a[0] - b[0], b[0] * a[1] - a[0] * b[1]]); // sign of cross
    }
    const cVal = e[0][0] * ctx + e[0][1] * cty + e[0][2];
    const orient = cVal >= 0 ? 1 : -1;

    const hist = new Map(); // label -> count (−1 = transparent)
    const pts = []; // [X, Y, label]
    for (let Y = Math.floor(minY) + 0.5; Y <= maxY; Y += stride) {
      for (let X = Math.floor(minX) + 0.5; X <= maxX; X += stride) {
        let inside = true;
        for (let k = 0; k < K; k++) {
          if (orient * (e[k][0] * X + e[k][1] * Y + e[k][2]) < 0) { inside = false; break; }
        }
        if (!inside) continue;
        const lb = labelAt(X, Y);
        hist.set(lb, (hist.get(lb) ?? 0) + 1);
        pts.push([X, Y, lb]);
      }
    }

    // sub-texel footprint: single sample at the centroid
    if (pts.length === 0) {
      return emitLeaf(node, labelAt(ctx, cty), hist);
    }

    // perceptual significance test: a minority matters when its EXCESS
    // texels — beyond the residue allowance inherited from the straight cut
    // that created this piece — are visible (≥ minDetail) and its
    // area × contrast importance clears the threshold. The allowance is the
    // key to smooth curves WITHOUT over-refinement: every accepted cut
    // tolerates only ~RESIDUE_PER_EDGE texels of boundary displacement per
    // texel of cut length, so shallow chords of a smooth curve are accepted
    // as-is while anything that deviates further keeps refining exactly
    // where the curvature (or a real feature) is. Alpha edges use maximum
    // contrast — silhouettes resolve to the visibility floor.
    const texelsPer = stride * stride;
    let domLabel = -2, domN = -1;
    for (const [lb, n] of hist) {
      if (n > domN || (n === domN && lb < domLabel)) { domN = n; domLabel = lb; }
    }
    const domColor = domLabel >= 0 ? map.colors[domLabel] : null;
    // DEPTH-based residue: a straight-cut approximation legitimately leaves
    // a thin band of "wrong" texels hugging the piece boundary — those are
    // invisible. Only minority samples DEEPER than the residue depth from
    // every boundary edge count toward significance, so nothing can ever
    // poke more than ~RESIDUE_DEPTH past a boundary without triggering
    // further refinement. (This replaces cut-specific allowances: it is a
    // property of the piece geometry, immune to sloppy-cut accounting.)
    // depth analysis (lazy): samples farther than the residue band from
    // EVERY piece edge cannot be straight-cut residue
    let deepCount = null;
    const computeDeep = () => {
      deepCount = new Map();
      const band = RESIDUE_DEPTH + stride / 2;
      const bandAlpha = RESIDUE_DEPTH * 0.6 + stride / 2;
      for (const [X, Y, lb] of pts) {
        if (lb === domLabel) continue;
        let d = Infinity;
        for (let k = 0; k < K; k++) {
          const a = T[k], b = T[(k + 1) % K];
          const ex = b[0] - a[0], ey = b[1] - a[1];
          const L2 = ex * ex + ey * ey;
          let tt = L2 < 1e-12 ? 0 : ((X - a[0]) * ex + (Y - a[1]) * ey) / L2;
          tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
          const dd = Math.hypot(X - (a[0] + ex * tt), Y - (a[1] + ey * tt));
          if (dd < d) d = dd;
        }
        if (d > ((lb < 0 || domLabel < 0) ? bandAlpha : band)) {
          deepCount.set(lb, (deepCount.get(lb) ?? 0) + 1);
        }
      }
    };
    // significant iff visibly different AND either (a) its count beyond the
    // cut-granted residue allowance is visible (protects thin/long features
    // like rings and 1-px lines, which are never "deep"), or (b) it has
    // samples DEEPER than the residue band from every piece edge (catches
    // curve bulges whose area an allowance would wrongly swallow — bounds
    // poke depth globally)
    const isSignificant = (lb, n) => {
      if (lb === domLabel) return false;
      const dist = (lb < 0 || domLabel < 0)
        ? 255 // alpha edge
        : colorDistance(map.colors[lb], domColor);
      if (dist <= tolerance) return false;
      const total = n * texelsPer;
      if (total < minDetail || total * dist < sigImportance) return false;
      const effTexels = total - (allow.get(lb) ?? 0);
      if (effTexels >= minDetail && effTexels * dist >= sigImportance) return true;
      if (!deepCount) computeDeep();
      return (deepCount.get(lb) ?? 0) * texelsPer >= minDetail;
    };
    let sigLabel = -2, sigN = -1;
    for (const [lb, n] of hist) {
      if (isSignificant(lb, n) && n > sigN) { sigN = n; sigLabel = lb; }
    }
    if (sigN < 0) {
      // insignificant minorities: leaf, but let each fan triangle take its
      // locally dominant label (prevents piece-dominant color spreading
      // over a differently-colored thin tail)
      return emitLeaf(node, domLabel, hist, pts);
    }

    let worldArea = 0;
    for (let i = 1; i + 1 < node.p.length; i++) {
      worldArea += area3([node.p[0], node.p[i], node.p[i + 1]]);
    }
    const canCut = depth < CUT_MAX_DEPTH && out.length + 3 <= budget &&
      worldArea >= minArea * 2;
    const canMid = midDepth < maxSubdiv && out.length + 4 <= budget &&
      worldArea >= minArea * 4;

    // split the node by the line dot(q, d) = t into two convex polygons
    const trySplit = (dx, dy, lineT, useSnap) => {
      const s = node.t.map(([X, Y]) => X * dx + Y * dy - lineT);
      if (useSnap) {
        const snap = (Math.max(...s) - Math.min(...s)) * SNAP_FRAC;
        for (let k = 0; k < s.length; k++) if (Math.abs(s[k]) < snap) s[k] = 0;
      }
      const polyN = { p: [], uv: [], t: [] }, polyP = { p: [], uv: [], t: [] };
      const shared = []; // points on the cut line (both polygons)
      const pushTo = (poly, p, uv, t) => { poly.p.push(p); poly.uv.push(uv); poly.t.push(t); };
      for (let i = 0; i < K; i++) {
        const j = (i + 1) % K;
        if (s[i] <= 0) pushTo(polyN, node.p[i], node.uv[i], node.t[i]);
        if (s[i] >= 0) pushTo(polyP, node.p[i], node.uv[i], node.t[i]);
        if (s[i] === 0) shared.push(node.t[i]);
        if ((s[i] < 0 && s[j] > 0) || (s[i] > 0 && s[j] < 0)) {
          const t = s[i] / (s[i] - s[j]);
          const cp = lerpV(node.p[i], node.p[j], t);
          const cuv = lerpUV(node.uv[i], node.uv[j], t);
          const ct = [
            node.t[i][0] + (node.t[j][0] - node.t[i][0]) * t,
            node.t[i][1] + (node.t[j][1] - node.t[i][1]) * t,
          ];
          pushTo(polyN, cp, cuv, ct); pushTo(polyP, cp, cuv, ct);
          shared.push(ct);
        }
      }
      if (polyN.p.length < 3 || polyP.p.length < 3) return null;
      const cutLen = shared.length >= 2
        ? Math.hypot(shared[1][0] - shared[0][0], shared[1][1] - shared[0][1])
        : 0;
      // reject no-op splits (a side as large as the parent, texel space)
      const texArea = (poly) => {
        let s2 = 0;
        for (let i = 0; i < poly.t.length; i++) {
          const a = poly.t[i], b = poly.t[(i + 1) % poly.t.length];
          s2 += a[0] * b[1] - b[0] * a[1];
        }
        return Math.abs(s2);
      };
      const parentA = Math.abs(sa2);
      if (texArea(polyN) > parentA * 0.999 || texArea(polyP) > parentA * 0.999) return null;
      return { pieces: [polyN, polyP], cutLen };
    };

    const pieceWorldArea = (poly) => {
      let s = 0;
      for (let i = 1; i + 1 < poly.p.length; i++) {
        s += area3([poly.p[0], poly.p[i], poly.p[i + 1]]);
      }
      return s;
    };
    // recurse the pieces; when EVERY piece resolves to the same uniform
    // label, the cut was unnecessary here — un-emit the fragments and emit
    // the whole parent polygon as one leaf (sibling merge: extended cut
    // lines never fragment uniform interiors)
    const doPieces = (pieces, allows) => {
      const mark = out.length;
      let uni, first = true;
      for (let i = 0; i < pieces.length; i++) {
        const c = pieces[i];
        if (pieceWorldArea(c) < minArea) { stats.degenerate = (stats.degenerate ?? 0) + 1; continue; }
        const u = recurse(c, depth + 1, midDepth, allows?.[i] ?? EMPTY_ALLOW);
        if (first) { uni = u; first = false; }
        else if (u !== uni) uni = null;
      }
      if (first) return null;          // nothing recursed
      if (uni == null) return null;    // mixed subtree
      if (uni < 0) return -1;          // all transparent (nothing emitted)
      out.length = mark;               // collapse fragments → one parent leaf
      return emitLeaf(node, uni, hist);
    };

    if (canCut) {
      // cut between the dominant label and the biggest SIGNIFICANT minority
      // (never chase insignificant residue) → LDA axis + optimal threshold
      const A = domLabel, B = sigLabel;
      let cAx = 0, cAy = 0, cBx = 0, cBy = 0, cA = 0, cB = 0;
      for (const [X, Y, lb] of pts) {
        if (lb === A) { cAx += X; cAy += Y; cA++; }
        else if (lb === B) { cBx += X; cBy += Y; cB++; }
      }
      // fixed-line classification quality (for contour-guided candidates).
      // Gate: each class must keep its MAJORITY on its own side (a cut that
      // sacrifices a small feature entirely can never pass), rank by
      // absolute misclassified count; the caller additionally bounds the
      // absolute error by the cut's residue budget after splitting.
      const evalLine = (nx, ny, t) => {
        let aBelow = 0, aAbove = 0, bBelow = 0, bAbove = 0;
        for (const [X, Y, lb] of pts) {
          if (lb === A) { if (X * nx + Y * ny <= t) aBelow++; else aAbove++; }
          else if (lb === B) { if (X * nx + Y * ny <= t) bBelow++; else bAbove++; }
        }
        const aT = aBelow + aAbove, bT = bBelow + bAbove;
        if (aT === 0 || bT === 0) return null;
        if ((aBelow + bBelow === 0) || (aAbove + bAbove === 0)) return null;
        const fwdOk = bBelow / bT <= 0.5 && aAbove / aT <= 0.5; // below=A
        const revOk = aBelow / aT <= 0.5 && bAbove / bT <= 0.5; // below=B
        const absFwd = bBelow + aAbove, absRev = aBelow + bAbove;
        if (!fwdOk && !revOk) return null;
        const fwd = fwdOk && (!revOk || absFwd <= absRev);
        return { absErr: fwd ? absFwd : absRev, fwd };
      };

      // PRIMARY: cut along the texture's simplified boundary polylines.
      // Every piece (in every triangle) cuts along the SAME globally
      // consistent segments, so a curved boundary reconstructs as one
      // smooth polyline instead of independently fitted zigzag chords.
      if (map.segIndex) {
        const cands = [];
        const seen = new Set();
        for (let cy = Math.floor(minY / SEG_CELL); cy <= Math.floor(maxY / SEG_CELL); cy++) {
          for (let cx = Math.floor(minX / SEG_CELL); cx <= Math.floor(maxX / SEG_CELL); cx++) {
            const list = map.segIndex.get(cx + ',' + cy);
            if (!list) continue;
            for (const si of list) {
              if (seen.has(si)) continue;
              seen.add(si);
              const sg = map.segs[si];
              // the segment must involve the minority being resolved
              if (sg.la !== B && sg.lb !== B) continue;
              const sdx = sg.x1 - sg.x0, sdy = sg.y1 - sg.y0;
              const sl = Math.hypot(sdx, sdy);
              if (sl < 1e-9) continue;
              const nx = -sdy / sl, ny = sdx / sl; // line normal
              const t = nx * sg.x0 + ny * sg.y0;
              const f = evalLine(nx, ny, t);
              if (f) cands.push({ nx, ny, t, len: sl, tol: sg.tol ?? DP_TOL, ...f });
            }
          }
        }
        // fewest misclassified texels first; longer segments break ties
        cands.sort((p, q) => (p.absErr - q.absErr) || (q.len - p.len));
        for (const c of cands.slice(0, 12)) {
          // no corner snapping: the cut must stay exactly on the shared line
          const r = trySplit(c.nx, c.ny, c.t, false);
          if (!r) continue;
          // band-limited residue allowance: only misclassified samples
          // WITHIN the tolerance band of the cut line count — a deep bulge
          // past the chord stays significant in the child and re-refines
          const cap0 = c.tol * r.cutLen;
          const band0 = c.tol + stride / 2;
          let aN0 = 0, bN0 = 0, aP0 = 0, bP0 = 0;
          for (const [X, Y, lb] of pts) {
            if (lb !== A && lb !== B) continue;
            const s = X * c.nx + Y * c.ny - c.t;
            if (Math.abs(s) > band0) continue;
            if (lb === A) { if (s <= 0) aN0++; else aP0++; }
            else if (s <= 0) bN0++; else bP0++;
          }
          // allowances apply ONE level only: a numeric (non-spatial)
          // allowance inherited deeper can write off content far from the
          // granting cut (long sliver tails painted the wrong color)
          const mk0 = (resLb, resCnt) => {
            const m = new Map();
            m.set(resLb, Math.min(resCnt * texelsPer, cap0));
            return m;
          };
          return doPieces(r.pieces, c.fwd
            ? [mk0(B, bN0), mk0(A, aP0)]
            : [mk0(A, aN0), mk0(B, bP0)]);
        }
      }

      if (cA > 0 && cB > 0) {
        cAx /= cA; cAy /= cA; cBx /= cB; cBy /= cB;
        let dx0 = cBx - cAx, dy0 = cBy - cAy;
        const dl = Math.hypot(dx0, dy0);
        if (dl > 1e-9) {
          dx0 /= dl; dy0 /= dl;
          // candidate directions: both texel axes AND the LDA axis — all
          // evaluated, best classification wins, axes win ties (axis cuts
          // land on texel grid lines and pair into squares downstream)
          const cands = [[1, 0, true], [0, 1, true], [dx0, dy0, false]];

          // best threshold along a direction: fewest misclassified texels
          // among thresholds where BOTH classes keep their majority (see
          // evalLine — protects small features from sacrificial cuts)
          const bestCutAlong = (dx, dy, axis) => {
            const proj = [];
            for (const [X, Y, lb] of pts) {
              if (lb === A || lb === B) proj.push([X * dx + Y * dy, lb === A ? 0 : 1]);
            }
            proj.sort((p, q) => p[0] - q[0]);
            let bTotal = 0;
            for (const p of proj) bTotal += p[1];
            const aTotal = proj.length - bTotal;
            if (aTotal === 0 || bTotal === 0) return null;
            let bestT = null, bestErr = Infinity, bestFwd = true, aBelow = 0, bBelow = 0;
            for (let i = 0; i < proj.length - 1; i++) {
              if (proj[i][1] === 0) aBelow++; else bBelow++;
              const fwdOk = bBelow / bTotal <= 0.5 && (aTotal - aBelow) / aTotal <= 0.5;
              const revOk = aBelow / aTotal <= 0.5 && (bTotal - bBelow) / bTotal <= 0.5;
              if (!fwdOk && !revOk) continue;
              const absFwd = bBelow + (aTotal - aBelow);
              const absRev = aBelow + (bTotal - bBelow);
              const fwd = fwdOk && (!revOk || absFwd <= absRev);
              const err = fwd ? absFwd : absRev;
              if (err < bestErr && proj[i][0] < proj[i + 1][0]) {
                bestErr = err;
                bestFwd = fwd;
                bestT = (proj[i][0] + proj[i + 1][0]) / 2;
              }
            }
            if (bestT == null) return null;
            // axis-aligned cuts snap onto the texel grid line (block edges)
            if (axis) {
              const r = Math.round(bestT);
              if (Math.abs(r - bestT) <= Math.max(T_SNAP, stride / 2)) bestT = r;
            }
            return { t: bestT, absErr: bestErr, fwd: bestFwd };
          };

          // rank candidates by absolute error; axis wins ties (pairs better)
          const fits = [];
          for (const [dx, dy, axis] of cands) {
            const f = bestCutAlong(dx, dy, axis);
            if (f) fits.push({ dx, dy, axis, ...f });
          }
          fits.sort((p, q) => (p.absErr - q.absErr) || (q.axis ? 1 : 0) - (p.axis ? 1 : 0));
          for (const f of fits) {
            // corner-snapped split first (clean vertex cuts), raw as backup
            const r = trySplit(f.dx, f.dy, f.t, true) ??
                      trySplit(f.dx, f.dy, f.t, false);
            if (!r) continue;
            const alphaEdge = A < 0 || B < 0;
            const rd = RESIDUE_DEPTH * (alphaEdge ? 0.6 : 1);
            const cap = rd * r.cutLen;
            const band = rd + stride / 2;
            let aN = 0, bN = 0, aP = 0, bP = 0;
            for (const [X, Y, lb] of pts) {
              if (lb !== A && lb !== B) continue;
              const s = X * f.dx + Y * f.dy - f.t;
              if (Math.abs(s) > band) continue;
              if (lb === A) { if (s <= 0) aN++; else aP++; }
              else if (s <= 0) bN++; else bP++;
            }
            const mkAllow = (resLb, resCnt) => {
              const m = new Map(); // one level only — see mk0
              m.set(resLb, Math.min(resCnt * texelsPer, cap));
              return m;
            };
            return doPieces(r.pieces, f.fwd
              ? [mkAllow(B, bN), mkAllow(A, aP)]
              : [mkAllow(A, aN), mkAllow(B, bP)]);
          }

          // guillotine fallback: no line CLASSIFIES A vs B (e.g. B is fully
          // enclosed by A, or same-color blocks interleave). Slice tangent
          // to B's extent instead — the strip isolates B and recursion
          // finishes it. Axis-aligned directions first (texel-grid cuts).
          for (const [gx, gy, axis] of [[1, 0, true], [0, 1, true], [dx0, dy0, false]]) {
            let lo = Infinity, hi = -Infinity;
            for (const [X, Y, lb] of pts) {
              if (lb !== B) continue;
              const pr = X * gx + Y * gy;
              if (pr < lo) lo = pr;
              if (pr > hi) hi = pr;
            }
            if (lo > hi) continue;
            for (let t of [lo - stride / 2, hi + stride / 2]) {
              if (axis) t = Math.round(t);
              // both sides must contain samples (cut strictly inside)
              let below = 0, above = 0;
              for (const [X, Y] of pts) {
                if (X * gx + Y * gy < t) below++; else above++;
              }
              if (below === 0 || above === 0) continue;
              const r = trySplit(gx, gy, t, true) ?? trySplit(gx, gy, t, false);
              if (!r) continue;
              // tangent cut: no misclassification residue
              return doPieces(r.pieces);
            }
          }
        }
      }
    }

    if (canMid) {
      // fallback for genuinely non-linear boundaries. Polygons (k > 3) are
      // halved at the bbox center along the longer axis (guaranteed
      // progress); triangles use the classic 4-way midpoint split, gated by
      // maxSubdiv exactly like the previous algorithm.
      if (K > 3) {
        const r =
          (maxX - minX >= maxY - minY
            ? trySplit(1, 0, Math.round((minX + maxX) / 2), false)
            : trySplit(0, 1, Math.round((minY + maxY) / 2), false)) ??
          trySplit(1, 0, (minX + maxX) / 2, false) ??
          trySplit(0, 1, (minY + maxY) / 2, false);
        if (r) return doPieces(r.pieces);
        // last resort: triangulate and let each triangle decide
        {
          const mark = out.length;
          let uni, first = true;
          for (let i = 1; i + 1 < K; i++) {
            const u = recurse({
              p: [node.p[0], node.p[i], node.p[i + 1]],
              uv: [node.uv[0], node.uv[i], node.uv[i + 1]],
              t: [node.t[0], node.t[i], node.t[i + 1]],
            }, depth + 1, midDepth, EMPTY_ALLOW);
            if (first) { uni = u; first = false; }
            else if (u !== uni) uni = null;
          }
          if (!first && uni != null && uni >= 0) {
            out.length = mark;
            return emitLeaf(node, uni, hist);
          }
          return first || uni == null ? null : uni;
        }
      }
      const mid = (i, j) => ({
        p: lerpV(node.p[i], node.p[j], 0.5),
        uv: lerpUV(node.uv[i], node.uv[j], 0.5),
        t: [(node.t[i][0] + node.t[j][0]) / 2, (node.t[i][1] + node.t[j][1]) / 2],
      });
      const m01 = mid(0, 1), m12 = mid(1, 2), m20 = mid(2, 0);
      const corner = (i) => ({ p: node.p[i], uv: node.uv[i], t: node.t[i] });
      const kids = [
        { a: corner(0), b: m01, c: m20 },
        { a: m01, b: corner(1), c: m12 },
        { a: m20, b: m12, c: corner(2) },
        { a: m01, b: m12, c: m20 },
      ];
      {
        const mark = out.length;
        let uni, first = true;
        for (const k of kids) {
          const u = recurse(
            { p: [k.a.p, k.b.p, k.c.p], uv: [k.a.uv, k.b.uv, k.c.uv], t: [k.a.t, k.b.t, k.c.t] },
            depth + 1, midDepth + 1, EMPTY_ALLOW);
          if (first) { uni = u; first = false; }
          else if (u !== uni) uni = null;
        }
        if (!first && uni != null && uni >= 0) {
          out.length = mark;
          return emitLeaf(node, uni, hist);
        }
        return first || uni == null ? null : uni;
      }
    }

    // exhausted: per-fan-triangle dominant paint. Returns null — an
    // exhausted piece still contains a significant minority, so it must
    // NEVER count as a clean uniform for sibling merging.
    emitLeaf(node, domLabel >= 0 ? domLabel : map.regionCount, hist, pts);
    return null;
  };

  recurse({ p: tri.p, uv: tri.uv, t: rootT }, 0, 0, EMPTY_ALLOW);
}
