// Main conversion pipeline: source meshes (or a 2D sprite) -> .gia
// decoration placements.
//
// Engine-agnostic: input is plain data (no three.js dependency), so the module
// is reusable in Node, workers, or other tools.
//
// Mesh input: [{
//   positions: Float32Array | number[]   // xyz triplets, LOCAL space
//   indices:   Uint32Array | number[] | null
//   uvs:       Float32Array | number[] | null
//   matrixWorld: number[16] | null       // column-major, applied to positions
//   color:     [r,g,b] 0..255            // material base color (default white)
//   texture:   { width, height, data, flipY? } | null  // RGBA base color map
// }]
//
// Sprite input: { sprite: { texture, pixelSize, thickness } } — see sprite.js.
//
// Params (all optional): see DEFAULT_PARAMS.

import { v3, sub, add, mul, dot, cross, len, norm, matToEulerYXZ, matToEulerXYZ, eulerYXZToMat, matMulVec, DEG, RAD } from './vec3.js';
import { decomposeTriangle, placementFromRightTriangle, triangleArea, DEFAULT_CANONICAL } from './right-triangles.js';
import { sampleTriangleColor, colorDistance, colorToRgbInt } from './color.js';
import { buildRegionMap, segmentTriangle } from './color-regions.js';
import { mergeCoplanarTriangles } from './mesh-ops.js';
import { pairIntoSquares, squarePlacement } from './squares.js';
import { coalesceSquares } from './coalesce.js';
import { decimateTriangles } from './decimate.js';
import { spriteToBoxes } from './sprite.js';
import { voxelizeTriangles } from './voxelize.js';
import { marchingCubesSurface } from './marchingcubes.js';
import { pixelPerfect } from './pixelperfect.js';
import { capPlacements, MAX_ZOOM } from './cap.js';

export const DEFAULT_PARAMS = {
  unitScale: 1,          // multiply source units to get meters
  flipZ: false,          // mirror across Z (game shares the source Z convention;
                         // enable only if a model imports front-to-back flipped)
  snapDeg: 1,            // treat angles within this of 90° as right angles
  colorTolerance: 30,    // 0..441 RGB euclidean; merge threshold
  maxSubdiv: 3,          // max texture-driven subdivision depth (4^d growth)
  subdivideThreshold: null, // color spread that triggers subdivision (default: colorTolerance)
  smartEdges: false,     // experimental region-based edge detection (Direct mode)
  merge: true,           // coplanar same-color merge pass
  planarAngleDeg: 1,     // coplanarity tolerance for merging
  weldEps: 1e-4,         // vertex weld distance (meters)
  maxDecorations: 99900, // hard cap (100 models x 999); excess dropped smallest-first
  thinScale: 0.01,       // decoration thin-axis scale (X for triangles, Y for squares)
  eulerOrder: 'YXZ',     // rotation decomposition order (engine convention)
  minTriangleArea: 1e-8, // m^2, drop degenerates
  mode: 'direct',        // 'direct' | 'voxel' | 'pixel'
  primitiveMode: 'triangles', // direct mode: 'triangles' | 'both'
  decimate: 0,           // 0..1 vertex-clustering decimation strength
  alphaCutoff: 0.5,      // texture regions with max alpha below this are skipped
  pivot: null,           // {x,y,z} source-space pivot moved to the origin (m)
  rotateDeg: null,       // {x,y,z} source-space pre-rotation (degrees, YXZ)
  userScale: 1,          // uniform user scale applied around the pivot
  // --- voxel mode ---
  voxelRes: 48,          // voxels across the largest dimension
  voxelSize: null,       // explicit voxel size (m); overrides voxelRes
  voxelColorTolerance: null, // color merge for voxels (null -> colorTolerance)
  voxelSurface: 'boxes', // 'boxes' | 'mc' (SDF + marching cubes)
  sdfIso: 0,             // iso offset in voxel units (+ inflates, - erodes)
  sdfSmooth: 1,          // SDF smoothing passes (0..4)
  // --- pixel-perfect mode ---
  pixelTolerance: 0,     // texel color merge (0 = only exactly equal colors)
  pixelOverdraw: true,   // background square per face + layered differences
                         // (0.001 m normal offset) to cut decoration count
  maxTexelsPerFace: 16384,
};

// Presets for the fidelity/count trade-off.
export const PRESETS = {
  fidelity: { colorTolerance: 12, maxSubdiv: 4, snapDeg: 0.5, planarAngleDeg: 0.25 },
  balanced: { colorTolerance: 30, maxSubdiv: 3, snapDeg: 1, planarAngleDeg: 1 },
  minimal:  { colorTolerance: 60, maxSubdiv: 2, snapDeg: 3, planarAngleDeg: 2 },
};

function applyMatrix(p, m) {
  // column-major 4x4
  return v3(
    m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
  );
}

// ---------- step 1: extract world-space triangles ----------

function* iterateTriangles(mesh) {
  const pos = mesh.positions;
  const idx = mesh.indices;
  const uvs = mesh.uvs;
  const count = idx ? idx.length : pos.length / 3;
  for (let i = 0; i + 2 < count; i += 3) {
    const ia = idx ? idx[i] : i, ib = idx ? idx[i + 1] : i + 1, ic = idx ? idx[i + 2] : i + 2;
    yield {
      p: [
        v3(pos[ia * 3], pos[ia * 3 + 1], pos[ia * 3 + 2]),
        v3(pos[ib * 3], pos[ib * 3 + 1], pos[ib * 3 + 2]),
        v3(pos[ic * 3], pos[ic * 3 + 1], pos[ic * 3 + 2]),
      ],
      uv: uvs ? [
        [uvs[ia * 2], uvs[ia * 2 + 1]],
        [uvs[ib * 2], uvs[ib * 2 + 1]],
        [uvs[ic * 2], uvs[ic * 2 + 1]],
      ] : null,
    };
  }
}

// ---------- step 2: color-aware subdivision + alpha skipping ----------
//
// Default: spread-driven recursive 4-way midpoint subdivision (classic).
//
// params.smartEdges (experimental, Direct mode): region-based segmentation
// (engine/convert/color-regions.js) — the texture is segmented ONCE into
// simplified color regions and each triangle is split along globally
// consistent fitted boundary polylines. Straight boundaries cost a handful
// of well-shaped polygons instead of 4^depth midpoint fragments; curves
// reconstruct as smooth secant polylines.

function subdivideForColor(tri, mesh, params, depth, out, budget, stats) {
  const base = mesh.color ?? [255, 255, 255];

  if (params.smartEdges && mesh.texture && tri.uv) {
    const tolerance = Math.max(1, params.subdivideThreshold ?? params.colorTolerance);
    const alphaCutoff = Math.max(0.004, params.alphaCutoff);
    const map = buildRegionMap(mesh.texture, tolerance, alphaCutoff);
    segmentTriangle(tri, mesh.texture, map, {
      base,
      budget,
      minArea: params.minTriangleArea,
      maxSubdiv: params.maxSubdiv,
      tolerance,
    }, out, stats);
    return;
  }

  const { color, spread, alphaMax } = sampleTriangleColor(
    mesh.texture, tri.uv?.[0], tri.uv?.[1], tri.uv?.[2], base);
  const threshold = params.subdivideThreshold ?? params.colorTolerance;
  const area = triangleArea(tri.p[0], tri.p[1], tri.p[2]);
  const canSubdivide = depth < params.maxSubdiv && tri.uv && mesh.texture &&
    area >= params.minTriangleArea * 4 && out.length + 4 <= budget;
  if (spread <= threshold || !canSubdivide) {
    // leaf: skip fully/mostly transparent texture regions
    if (mesh.texture && tri.uv && alphaMax < Math.max(0.004, params.alphaCutoff)) {
      stats.transparentSkipped++;
      return;
    }
    out.push({ p: tri.p, color });
    return;
  }
  // 4-way midpoint subdivision
  const m01 = mul(add(tri.p[0], tri.p[1]), 0.5);
  const m12 = mul(add(tri.p[1], tri.p[2]), 0.5);
  const m20 = mul(add(tri.p[2], tri.p[0]), 0.5);
  const uv01 = [(tri.uv[0][0] + tri.uv[1][0]) / 2, (tri.uv[0][1] + tri.uv[1][1]) / 2];
  const uv12 = [(tri.uv[1][0] + tri.uv[2][0]) / 2, (tri.uv[1][1] + tri.uv[2][1]) / 2];
  const uv20 = [(tri.uv[2][0] + tri.uv[0][0]) / 2, (tri.uv[2][1] + tri.uv[0][1]) / 2];
  const children = [
    { p: [tri.p[0], m01, m20], uv: [tri.uv[0], uv01, uv20] },
    { p: [m01, tri.p[1], m12], uv: [uv01, tri.uv[1], uv12] },
    { p: [m20, m12, tri.p[2]], uv: [uv20, uv12, tri.uv[2]] },
    { p: [m01, m12, m20], uv: [uv01, uv12, uv20] },
  ];
  for (const c of children) subdivideForColor(c, mesh, params, depth + 1, out, budget, stats);
}

// ---------- placements -> decoration records ----------

// Triangle reference model (White Triangle v2, model 20001925):
// right-angle corner at the local origin, legs along local +Y and -Z, thin
// on local X. CALIBRATED true leg lengths at zoom 1: exactly 0.13 m (+Y)
// and 0.27 m (-Z) — the historically published zooms 7.7 and 3.704 are
// roundings of 100/13 and 100/27 at 1 and 3 decimals and leave a ~1 mm
// seam per meter when two triangles tile a square. The exact fractions
// close the assembled square with zero gap/overlap.
export const TRI_SCALE_Y_PER_M = 100 / 13; // 7.692307...
export const TRI_SCALE_Z_PER_M = 100 / 27; // 3.703703...

export function placementToDecoration(pl, params) {
  let rot = pl.rotation;
  if (!pl.kind || pl.kind === 'triangle') {
    // Internal placements put legs on local +Y/+Z. The v2 model's second leg
    // points along local -Z, so right-multiply by Ry(180) = diag(-1,1,-1):
    // columns become (-n, u, -w). (The canonical sample encodes exactly this
    // as rotation (0,180,0).)
    const R = pl.rotation;
    rot = [
      [-R[0][0], R[0][1], -R[0][2]],
      [-R[1][0], R[1][1], -R[1][2]],
      [-R[2][0], R[2][1], -R[2][2]],
    ];
  }
  const euler = (params.eulerOrder === 'XYZ' ? matToEulerXYZ : matToEulerYXZ)(rot);
  const clean = (v) => {
    let d = v * DEG;
    d = Math.round(d * 10000) / 10000;
    if (Object.is(d, -0)) d = 0;
    d %= 360;
    if (d < 0) d += 360;
    return d;
  };
  const base = {
    kind: pl.kind ?? 'triangle',
    position: {
      x: round6(pl.position.x * 10),
      y: round6(pl.position.y * 10),
      z: round6(pl.position.z * 10),
    },
    rotationDeg: { x: clean(euler.x), y: clean(euler.y), z: clean(euler.z) },
    color: colorToRgbInt(pl.color),
  };
  switch (base.kind) {
    case 'square':
      // canonical square: a unit cube, 0.1 m per axis at scale 1 (thin uses
      // set Y to thinScale; volumetric uses set fullY with a real extent)
      base.scale = {
        x: round6(pl.scale.x * 10),
        y: pl.fullY ? round6(pl.scale.y * 10) : params.thinScale,
        z: round6(pl.scale.z * 10),
      };
      break;
    case 'plane':
      // 1×1 m on local XZ at scale 10; sample uses y scale 1
      base.scale = { x: round6(pl.scale.x * 10), y: 1, z: round6(pl.scale.z * 10) };
      break;
    case 'sphere':
      // 1 m diameter at scale 10 (pl.scale = diameters in m)
      base.scale = {
        x: round6(pl.scale.x * 10), y: round6(pl.scale.y * 10), z: round6(pl.scale.z * 10),
      };
      break;
    case 'cylinder':
    case 'cone':
      // 1 m diameter × 1 m height at scale 10 (pl.scale = {diaX, height, diaZ})
      base.scale = {
        x: round6(pl.scale.x * 10), y: round6(pl.scale.y * 10), z: round6(pl.scale.z * 10),
      };
      break;
    case 'prism':
      // equilateral cross-section, 0.75 m side and 1 m height at scale 10
      // (pl.scale = {side, height, side} in m)
      base.scale = {
        x: round6(pl.scale.x / 0.075),
        y: round6(pl.scale.y * 10),
        z: round6(pl.scale.z / 0.075),
      };
      break;
    default:
      // calibrated triangle: zoom = leg1_m * 100/13, leg2_m * 100/27
      base.scale = {
        x: params.thinScale,
        y: round6(pl.scale.y * TRI_SCALE_Y_PER_M),
        z: round6(pl.scale.z * TRI_SCALE_Z_PER_M),
      };
  }
  return base;
}

function round6(v) {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

// push(...src) overflows the call stack for large arrays (every element
// becomes a call argument) — always append big arrays with a loop
function pushAll(dst, src) {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
  return dst;
}

// ---------- main entry ----------

// input: meshes array, { meshes }, or { sprite: { texture, pixelSize, thickness } }
export function convert(input, userParams = {}) {
  const params = { ...DEFAULT_PARAMS, ...userParams };
  const meshes = Array.isArray(input) ? input : (input.meshes ?? []);
  const sprite = Array.isArray(input) ? null : input.sprite;
  const stats = {
    sourceTriangles: 0,
    afterDecimation: 0,
    afterSubdivision: 0,
    afterMerge: 0,
    placements: 0,
    squares: 0,
    triangles: 0,
    squareApprox: 0,
    transparentSkipped: 0,
    dropped: 0,
    degenerate: 0,
    uniqueColors: 0,
    bounds: null,
  };

  // user pre-transform (source space, meters): p' = R * s∘(p - pivot)
  // userScale: number (uniform) or {x,y,z} (independent per-axis scaling)
  const hasPivot = params.pivot && (params.pivot.x || params.pivot.y || params.pivot.z);
  const hasRot = params.rotateDeg && (params.rotateDeg.x || params.rotateDeg.y || params.rotateDeg.z);
  const us = params.userScale;
  const userS = typeof us === 'object' && us
    ? { x: us.x > 0 ? us.x : 1, y: us.y > 0 ? us.y : 1, z: us.z > 0 ? us.z : 1 }
    : { x: us > 0 ? us : 1, y: us > 0 ? us : 1, z: us > 0 ? us : 1 };
  const hasScale = userS.x !== 1 || userS.y !== 1 || userS.z !== 1;
  const userR = hasRot ? eulerYXZToMat({
    x: params.rotateDeg.x * RAD, y: params.rotateDeg.y * RAD, z: params.rotateDeg.z * RAD,
  }) : null;
  const userXform = (q) => {
    if (hasPivot) q = sub(q, params.pivot);
    if (hasScale) q = v3(q.x * userS.x, q.y * userS.y, q.z * userS.z);
    if (userR) q = matMulVec(userR, q);
    return q;
  };
  // Decoration space is the source mirrored across X (game convention);
  // the optional flipZ mirrors across Z on top of it. Exactly one mirror
  // flips the triangle winding; two mirrors (= a 180° Y rotation) cancel.
  const flipTri = (p, uv) => {
    const zs = params.flipZ ? -1 : 1;
    const q = p.map((v) => v3(-v.x, v.y, v.z * zs));
    return zs === 1
      ? { p: [q[0], q[2], q[1]], uv: uv ? [uv[0], uv[2], uv[1]] : null }
      : { p: q, uv };
  };

  // 1. gather raw world-space triangles
  const colored = [];
  const budget = Math.max(params.maxDecorations * 4, 40000);

  if (sprite) {
    // One box (elongated square/unit-cube primitive) per maximal same-color
    // pixel rectangle: covers front, back, and edges with a single
    // decoration. Skips the triangle pipeline entirely.
    return convertSpriteBoxes(sprite, params, stats, { userR, userXform, hasPivot, userS });
  }

  let raw = [];
  for (const mesh of meshes) {
    for (const tri of iterateTriangles(mesh)) {
      stats.sourceTriangles++;
      let p = tri.p;
      if (mesh.matrixWorld) p = p.map((q) => applyMatrix(q, mesh.matrixWorld));
      if (params.unitScale !== 1) p = p.map((q) => mul(q, params.unitScale));
      p = p.map(userXform);
      const f = flipTri(p, tri.uv);
      if (triangleArea(f.p[0], f.p[1], f.p[2]) < params.minTriangleArea) {
        stats.degenerate++;
        continue;
      }
      raw.push({ p: f.p, uv: f.uv, mesh });
    }
  }

  // 2. optional decimation (before color sampling; preserves UVs)
  if (params.decimate > 0) raw = decimateTriangles(raw, params.decimate);
  stats.afterDecimation = raw.length;

  // --- VOXEL MODE: rasterize raw triangles (texture-accurate per-voxel
  // colors) into boxes, OR reconstruct the SDF zero level set with marching
  // cubes and continue through the squares/right-triangle pipeline ---
  let skipColoring = false;
  if (params.mode === 'voxel') {
    let minX = 1/0, minY = 1/0, minZ = 1/0, maxX = -1/0, maxY = -1/0, maxZ = -1/0;
    for (const t of raw) for (const q of t.p) {
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
      minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z);
    }
    const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
    const vs = params.voxelSize ?? maxDim / Math.max(2, params.voxelRes);
    if (params.voxelSurface === 'mc') {
      // standard marching cubes directly on the voxel occupancy; the
      // resulting colored triangles continue through the pairing pipeline
      const res = marchingCubesSurface(raw, {
        voxelSize: vs,
        isoOffset: params.sdfIso,
        smooth: params.sdfSmooth,
        alphaCutoff: params.alphaCutoff,
      });
      stats.voxels = res.voxels;
      stats.sdfCells = res.cells;
      stats.voxelSize = Math.round(vs * 1e4) / 1e4;
      pushAll(colored, res.tris);
      stats.afterSubdivision = colored.length;
      skipColoring = true;
    } else {
      const { boxes, voxels, clusters, culled } = voxelizeTriangles(raw, {
        voxelSize: vs,
        colorTolerance: params.voxelColorTolerance ?? params.colorTolerance,
        maxBoxEdge: MAX_ZOOM / 10,
        alphaCutoff: params.alphaCutoff,
      });
      stats.voxels = voxels;
      stats.voxelsCulled = culled;
      stats.voxelSize = Math.round(vs * 1e4) / 1e4;
      stats.uniqueColors = clusters;
      stats.afterSubdivision = voxels;
      stats.afterMerge = boxes.length;
      let placements = boxes.map((b) => ({
        kind: 'square',
        fullY: true,
        position: v3(b.center.x, b.center.y, b.center.z),
        rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        scale: v3(b.size.x, b.size.y, b.size.z),
        color: b.color,
        area: Math.max(b.size.x * b.size.y, b.size.x * b.size.z, b.size.y * b.size.z),
      }));
      measurePlacements(placements, stats);
      return finishPlacements(placements, params, stats);
    }
  }

  // --- PIXEL PERFECT MODE: exact per-texel squares on rectangular faces,
  // greedy-merged where colors are identical (within pixelTolerance) ---
  if (params.mode === 'pixel') {
    const pp = pixelPerfect(raw, {
      alphaCutoff: params.alphaCutoff,
      mergeTolerance: params.pixelTolerance,
      maxTexelsPerFace: params.maxTexelsPerFace,
      overdraw: params.pixelOverdraw,
      weldEps: params.weldEps,
    });
    stats.texels = pp.texels;
    stats.transparentSkipped = pp.transparent;
    let placements = pp.placements;
    // non-rectangular remainder: near-exact colors via deep subdivision
    const local = {
      ...params,
      colorTolerance: Math.max(2, params.pixelTolerance),
      subdivideThreshold: Math.max(2, params.pixelTolerance),
      maxSubdiv: Math.max(params.maxSubdiv, 4),
    };
    const restColored = [];
    for (const t of pp.rest) {
      subdivideForColor(t, t.mesh, local, 0, restColored, budget, stats);
    }
    stats.afterSubdivision = placements.length + restColored.length;
    // bounds for stats only — the model origin is preserved as-is
    if (placements.length + restColored.length) {
      let minX = 1/0, minY = 1/0, minZ = 1/0, maxX = -1/0, maxY = -1/0, maxZ = -1/0;
      for (const p of placements) {
        const R = p.rotation, h = [p.scale.x / 2, 0.001, p.scale.z / 2];
        const ext = [0, 1, 2].map((i) =>
          Math.abs(R[i][0]) * h[0] + Math.abs(R[i][1]) * h[1] + Math.abs(R[i][2]) * h[2]);
        minX = Math.min(minX, p.position.x - ext[0]); maxX = Math.max(maxX, p.position.x + ext[0]);
        minY = Math.min(minY, p.position.y - ext[1]); maxY = Math.max(maxY, p.position.y + ext[1]);
        minZ = Math.min(minZ, p.position.z - ext[2]); maxZ = Math.max(maxZ, p.position.z + ext[2]);
      }
      for (const t of restColored) for (const q of t.p) {
        minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
        minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
        minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z);
      }
      stats.bounds = { x: round6(maxX - minX), y: round6(maxY - minY), z: round6(maxZ - minZ) };
    }
    // remaining triangles: pair what forms rectangles, decompose the rest
    const canonicalPx = { ...DEFAULT_CANONICAL, thinScale: params.thinScale };
    const p0 = pairIntoSquares(restColored, {
      snapDeg: params.snapDeg,
      colorTolerance: local.colorTolerance,
      weldEps: params.weldEps,
      planarAngleDeg: params.planarAngleDeg,
    });
    pushAll(placements, p0.squares);
    for (const t of p0.rest) {
      for (const pl of decomposeTriangle(t.p[0], t.p[1], t.p[2], { snapDeg: params.snapDeg, canonical: canonicalPx })) {
        pl.color = t.color;
        pl.kind = 'triangle';
        pl.area = pl.scale.y * pl.scale.z / 2;
        placements.push(pl);
      }
    }
    // coalesce same-color equal-size squares across adjacent faces
    const sq = placements.filter((p) => p.kind === 'square');
    const nonSq = placements.filter((p) => p.kind !== 'square');
    placements = [...coalesceSquares(sq), ...nonSq];
    stats.afterMerge = placements.length;
    return finishPlacements(placements, params, stats);
  }

  // 3. color sampling + texture subdivision + alpha skipping
  if (!skipColoring) {
    for (const t of raw) {
      subdivideForColor(t, t.mesh, params, 0, colored, budget, stats);
    }
    stats.afterSubdivision = colored.length;
  }

  // 4. bounds for stats — the model origin is preserved (no recentering)
  if (colored.length) {
    let minX = 1/0, minY = 1/0, minZ = 1/0, maxX = -1/0, maxY = -1/0, maxZ = -1/0;
    for (const t of colored) for (const q of t.p) {
      if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
      if (q.z < minZ) minZ = q.z; if (q.z > maxZ) maxZ = q.z;
    }
    stats.bounds = {
      x: round6(maxX - minX), y: round6(maxY - minY), z: round6(maxZ - minZ),
    };
  }

  // 5. + 6. merge & primitives
  const canonical = { ...DEFAULT_CANONICAL, thinScale: params.thinScale };
  const mergeOpts = {
    colorTolerance: params.colorTolerance,
    planarAngleDeg: params.planarAngleDeg,
    weldEps: params.weldEps,
  };
  const pairOpts = {
    snapDeg: params.snapDeg,
    colorTolerance: params.colorTolerance,
    weldEps: params.weldEps,
    planarAngleDeg: params.planarAngleDeg,
  };
  const doMerge = (tris) =>
    (params.merge && tris.length > 1) ? mergeCoplanarTriangles(tris, mergeOpts) : tris;

  let placements = [];
  let leftovers;

  const workColored = colored;
  // marching-cubes output pairs into squares + right triangles
  const effectiveMode = params.mode === 'voxel' ? 'both' : params.primitiveMode;

  if (effectiveMode === 'squares' || effectiveMode === 'both') {
    // pass 1: pair rectangles in the raw colored soup FIRST — texel grids
    // from subdivision pair exactly, before merging distorts them
    const p0 = pairIntoSquares(workColored, pairOpts);
    const squares = [...p0.squares];
    // pass 2: merge the unpaired remainder, then pair again
    const mergedRest = doMerge(p0.rest);
    const p1 = pairIntoSquares(mergedRest, pairOpts);
    pushAll(squares, p1.squares);
    // pass 3: decompose whatever is left into right triangles and pair once
    // more — decomposition often recreates the two halves of a quad
    const rightTris = [];
    for (const t of p1.rest) {
      const pls = decomposeTriangle(t.p[0], t.p[1], t.p[2], { snapDeg: params.snapDeg, canonical });
      for (const pl of pls) {
        const A = pl.position;
        const B = add(A, mul(v3(pl.rotation[0][1], pl.rotation[1][1], pl.rotation[2][1]), pl.scale.y));
        const C = add(A, mul(v3(pl.rotation[0][2], pl.rotation[1][2], pl.rotation[2][2]), pl.scale.z));
        rightTris.push({ p: [A, B, C], color: t.color });
      }
    }
    const p2 = pairIntoSquares(rightTris, pairOpts);
    pushAll(squares, p2.squares);
    leftovers = p2.rest;
    // pass 4: greedy-coalesce equal-size aligned squares into maximal
    // rectangles (voxel/texel grids collapse dramatically)
    placements = [...placements, ...coalesceSquares(squares)];
    stats.afterMerge = placements.length + leftovers.length;
  } else {
    const merged = doMerge(workColored);
    stats.afterMerge = merged.length + placements.length;
    leftovers = merged;
  }

  for (const t of leftovers) {
    const pls = decomposeTriangle(t.p[0], t.p[1], t.p[2], { snapDeg: params.snapDeg, canonical });
    for (const pl of pls) {
      pl.color = t.color;
      if (params.primitiveMode === 'squares') {
        // squares-only: cover each right triangle with a square spanning its
        // legs (overdraws the mirror half — intended for voxel-style models
        // where leftovers are rare)
        const A = pl.position;
        const B = add(A, mul(v3(pl.rotation[0][1], pl.rotation[1][1], pl.rotation[2][1]), pl.scale.y));
        const C = add(A, mul(v3(pl.rotation[0][2], pl.rotation[1][2], pl.rotation[2][2]), pl.scale.z));
        const n = cross(sub(B, A), sub(C, A));
        const sq = squarePlacement(A, B, C, n);
        if (sq) {
          sq.color = t.color;
          sq.area = sq.scale.x * sq.scale.z;
          placements.push(sq);
          stats.squareApprox++;
          continue;
        }
      }
      pl.kind = 'triangle';
      pl.area = pl.scale.y * pl.scale.z / 2;
      placements.push(pl);
    }
  }

  return finishPlacements(placements, params, stats);
}

// ---------- shared tail: scale cap -> budget -> stats -> decorations ----------

// Bounds for stats only — placements are never repositioned, so the model
// origin the user set up in the editor is preserved exactly.
function measurePlacements(placements, stats) {
  if (!placements.length) return;
  let minX = 1/0, minY = 1/0, minZ = 1/0, maxX = -1/0, maxY = -1/0, maxZ = -1/0;
  for (const p of placements) {
    const R = p.rotation;
    const h = [p.scale.x / 2, p.scale.y / 2, p.scale.z / 2];
    const ext = [0, 1, 2].map((i) =>
      Math.abs(R[i][0]) * h[0] + Math.abs(R[i][1]) * h[1] + Math.abs(R[i][2]) * h[2]);
    minX = Math.min(minX, p.position.x - ext[0]); maxX = Math.max(maxX, p.position.x + ext[0]);
    minY = Math.min(minY, p.position.y - ext[1]); maxY = Math.max(maxY, p.position.y + ext[1]);
    minZ = Math.min(minZ, p.position.z - ext[2]); maxZ = Math.max(maxZ, p.position.z + ext[2]);
  }
  stats.bounds = {
    x: round6(maxX - minX), y: round6(maxY - minY), z: round6(maxZ - minZ),
  };
}

function finishPlacements(placements, params, stats) {
  // no decoration may exceed zoom 50 on any axis: split oversized pieces
  const before = placements.length;
  placements = capPlacements(placements);
  if (placements.length !== before) stats.capSplit = placements.length - before;

  // consistent surface-area estimate for every placement (drop ordering and
  // budget decisions must never compare undefined areas)
  const areaOf = (p) => {
    switch (p.kind) {
      case 'square':
      case 'plane':
        return Math.max(
          p.scale.x * p.scale.z,
          p.scale.x * (p.fullY ? p.scale.y : 0),
          (p.fullY ? p.scale.y : 0) * p.scale.z,
        );
      case 'sphere': case 'cylinder': case 'cone': case 'prism':
        return Math.max(p.scale.x * p.scale.y, p.scale.x * p.scale.z, p.scale.y * p.scale.z);
      default:
        return p.scale.y * p.scale.z / 2; // triangle legs
    }
  };
  for (const p of placements) p.area = areaOf(p);

  // over budget? merge adjacent same-plane squares with progressively more
  // generous color tolerance before resorting to dropping anything
  if (placements.length > params.maxDecorations) {
    let mergeTol = 12;
    while (placements.length > params.maxDecorations && mergeTol <= 100) {
      const sq = placements.filter((p) => p.kind === 'square');
      if (sq.length < 2) break;
      const rest = placements.filter((p) => p.kind !== 'square');
      const merged = coalesceSquares(sq, { colorTolerance: mergeTol });
      if (merged.length < sq.length) {
        stats.budgetMerged = (stats.budgetMerged ?? 0) + (sq.length - merged.length);
        placements = [...merged, ...rest];
        for (const p of placements) if (p.area == null) p.area = areaOf(p);
      }
      mergeTol *= 2;
    }
  }

  if (placements.length > params.maxDecorations) {
    placements.sort((a, b) => (b.area ?? 0) - (a.area ?? 0));
    stats.dropped = placements.length - params.maxDecorations;
    placements = placements.slice(0, params.maxDecorations);
  }
  stats.placements = placements.length;
  const byKind = {};
  for (const p of placements) {
    const k = p.kind ?? 'triangle';
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  stats.byKind = byKind;
  stats.squares = byKind.square ?? 0;
  stats.triangles = byKind.triangle ?? 0;
  if (!stats.uniqueColors) {
    stats.uniqueColors = new Set(placements.map((p) => colorToRgbInt(p.color))).size;
  }
  const decorations = placements.map((pl) => placementToDecoration(pl, params));
  return { placements, decorations, stats, params };
}

// ---------- sprite -> box decorations ----------
// The square decoration is a unit cube (0.1 m per axis at scale 1), so each
// maximal same-color pixel rectangle becomes ONE elongated box covering the
// front face, back face, and edges.
function convertSpriteBoxes(sprite, params, stats, ctx) {
  const { boxes, pixels } = spriteToBoxes(sprite.texture, {
    pixelSize: sprite.pixelSize,
    thickness: sprite.thickness,
    alphaCutoff: params.alphaCutoff,
    overdraw: sprite.overdraw,
  });
  stats.sourceTriangles = pixels;
  stats.spritePixels = pixels;

  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let R = ctx.userR ?? I;
  // decoration space mirrors X (game convention), plus optional Z mirror:
  // conjugate the user rotation by M = diag(-1, 1, ±1)
  const zs = params.flipZ ? -1 : 1;
  const sgn = [-1, 1, zs];
  R = R.map((row, i) => row.map((v, j) => v * sgn[i] * sgn[j]));

  const s = ctx.userS ?? { x: 1, y: 1, z: 1 };
  let placements = boxes.map((b) => {
    let c = ctx.userXform(b.center);
    c = v3(-c.x, c.y, c.z * zs);
    const sx = b.size.x * s.x, sy = b.size.y * s.y, sz = b.size.z * s.z;
    return {
      kind: 'square',
      fullY: true,
      position: c,
      rotation: R,
      scale: v3(sx, sy, sz),
      color: b.color,
      area: Math.max(sx * sy, sx * sz, sy * sz),
    };
  });
  stats.afterDecimation = placements.length;
  stats.afterSubdivision = placements.length;
  stats.afterMerge = placements.length;

  measurePlacements(placements, stats);

  return finishPlacements(placements, params, stats);
}
