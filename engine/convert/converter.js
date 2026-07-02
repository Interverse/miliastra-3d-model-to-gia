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
import { mergeCoplanarTriangles } from './mesh-ops.js';
import { pairIntoSquares, squarePlacement } from './squares.js';
import { coalesceSquares } from './coalesce.js';
import { decimateTriangles } from './decimate.js';
import { spriteToBoxes } from './sprite.js';

export const DEFAULT_PARAMS = {
  unitScale: 1,          // multiply source units to get meters
  flipZ: true,           // three.js style (-Z forward) -> target Y-up +Z-forward
  snapDeg: 1,            // treat angles within this of 90° as right angles
  colorTolerance: 30,    // 0..441 RGB euclidean; merge threshold
  maxSubdiv: 3,          // max texture-driven subdivision depth (4^d growth)
  subdivideThreshold: null, // color spread that triggers subdivision (default: colorTolerance)
  merge: true,           // coplanar same-color merge pass
  planarAngleDeg: 1,     // coplanarity tolerance for merging
  weldEps: 1e-4,         // vertex weld distance (meters)
  maxDecorations: 4995,  // hard cap (5 models x 999); excess dropped smallest-first
  thinScale: 0.01,       // decoration thin-axis scale (X for triangles, Y for squares)
  eulerOrder: 'YXZ',     // rotation decomposition order (engine convention)
  minTriangleArea: 1e-8, // m^2, drop degenerates
  center: true,          // recenter model on origin (XZ) and rest on Y=0
  primitiveMode: 'triangles', // 'triangles' | 'squares' | 'both'
  decimate: 0,           // 0..1 vertex-clustering decimation strength
  alphaCutoff: 0.5,      // texture regions with max alpha below this are skipped
  pivot: null,           // {x,y,z} source-space pivot moved to the origin (m)
  rotateDeg: null,       // {x,y,z} source-space pre-rotation (degrees, YXZ)
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

// ---------- step 2: texture-driven subdivision + alpha skipping ----------

function subdivideForColor(tri, mesh, params, depth, out, budget, stats) {
  const base = mesh.color ?? [255, 255, 255];
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

export function placementToDecoration(pl, params) {
  const euler = (params.eulerOrder === 'XYZ' ? matToEulerXYZ : matToEulerYXZ)(pl.rotation);
  const clean = (v) => {
    let d = v * DEG;
    d = Math.round(d * 10000) / 10000;
    if (Object.is(d, -0)) d = 0;
    d %= 360;
    if (d < 0) d += 360;
    return d;
  };
  const base = {
    kind: pl.kind === 'square' ? 'square' : 'triangle',
    position: {
      x: round6(pl.position.x * 10),
      y: round6(pl.position.y * 10),
      z: round6(pl.position.z * 10),
    },
    rotationDeg: { x: clean(euler.x), y: clean(euler.y), z: clean(euler.z) },
    color: colorToRgbInt(pl.color),
  };
  if (base.kind === 'square') {
    // canonical square: a unit cube, 0.1 m per axis at scale 1 (thin uses of
    // it set Y to thinScale; volumetric uses set fullY with a real extent)
    base.scale = {
      x: round6(pl.scale.x * 10),
      y: pl.fullY ? round6(pl.scale.y * 10) : params.thinScale,
      z: round6(pl.scale.z * 10),
    };
  } else {
    // canonical triangle: 0.5 m legs at scale 1, thin on local X
    base.scale = {
      x: params.thinScale,
      y: round6(pl.scale.y * 2),
      z: round6(pl.scale.z * 2),
    };
  }
  return base;
}

function round6(v) {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
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

  // user pre-transform (source space): p' = R * (p - pivot)
  const hasPivot = params.pivot && (params.pivot.x || params.pivot.y || params.pivot.z);
  const hasRot = params.rotateDeg && (params.rotateDeg.x || params.rotateDeg.y || params.rotateDeg.z);
  const userR = hasRot ? eulerYXZToMat({
    x: params.rotateDeg.x * RAD, y: params.rotateDeg.y * RAD, z: params.rotateDeg.z * RAD,
  }) : null;
  const userXform = (q) => {
    if (hasPivot) q = sub(q, params.pivot);
    if (userR) q = matMulVec(userR, q);
    return q;
  };
  const flipTri = (p, uv) => params.flipZ
    ? {
        p: [v3(p[0].x, p[0].y, -p[0].z), v3(p[2].x, p[2].y, -p[2].z), v3(p[1].x, p[1].y, -p[1].z)],
        uv: uv ? [uv[0], uv[2], uv[1]] : null,
      }
    : { p, uv };

  // 1. gather raw world-space triangles
  const colored = [];
  const budget = Math.max(params.maxDecorations * 4, 40000);

  if (sprite) {
    // One box (elongated square/unit-cube primitive) per maximal same-color
    // pixel rectangle: covers front, back, and edges with a single
    // decoration. Skips the triangle pipeline entirely.
    return convertSpriteBoxes(sprite, params, stats, { userR, userXform, hasPivot });
  }
  {
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

    // 3. color sampling + texture subdivision + alpha skipping
    for (const t of raw) {
      subdivideForColor(t, t.mesh, params, 0, colored, budget, stats);
    }
    stats.afterSubdivision = colored.length;
  }

  // 4. recenter
  if (params.center && colored.length) {
    let minX = 1/0, minY = 1/0, minZ = 1/0, maxX = -1/0, maxY = -1/0, maxZ = -1/0;
    for (const t of colored) for (const q of t.p) {
      if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
      if (q.z < minZ) minZ = q.z; if (q.z > maxZ) maxZ = q.z;
    }
    const off = v3(-(minX + maxX) / 2, -minY, -(minZ + maxZ) / 2);
    for (const t of colored) t.p = t.p.map((q) => add(q, off));
    stats.bounds = {
      x: round6(maxX - minX), y: round6(maxY - minY), z: round6(maxZ - minZ),
    };
    stats.centerOffset = { x: off.x, y: off.y, z: off.z };
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

  if (params.primitiveMode === 'squares' || params.primitiveMode === 'both') {
    // pass 1: pair rectangles in the raw colored soup FIRST — texel grids
    // from subdivision pair exactly, before merging distorts them
    const p0 = pairIntoSquares(colored, pairOpts);
    const squares = [...p0.squares];
    // pass 2: merge the unpaired remainder, then pair again
    const mergedRest = doMerge(p0.rest);
    const p1 = pairIntoSquares(mergedRest, pairOpts);
    squares.push(...p1.squares);
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
    squares.push(...p2.squares);
    leftovers = p2.rest;
    // pass 4: greedy-coalesce equal-size aligned squares into maximal
    // rectangles (voxel/texel grids collapse dramatically)
    placements = coalesceSquares(squares);
    stats.afterMerge = placements.length + leftovers.length;
  } else {
    const merged = doMerge(colored);
    stats.afterMerge = merged.length;
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

  // 7. budget enforcement: drop smallest first
  if (placements.length > params.maxDecorations) {
    placements.sort((a, b) => b.area - a.area);
    stats.dropped = placements.length - params.maxDecorations;
    placements = placements.slice(0, params.maxDecorations);
  }
  stats.placements = placements.length;
  stats.squares = placements.filter((p) => p.kind === 'square').length;
  stats.triangles = placements.length - stats.squares;
  stats.uniqueColors = new Set(placements.map((p) => colorToRgbInt(p.color))).size;

  // 8. decoration records
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
  });
  stats.sourceTriangles = pixels;
  stats.spritePixels = pixels;

  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let R = ctx.userR ?? I;
  if (params.flipZ) {
    // mirror-conjugate the user rotation across Z: M·R·M, M = diag(1,1,-1)
    R = R.map((row, i) => row.map((v, j) => v * ((i === 2) !== (j === 2) ? -1 : 1)));
  }

  let placements = boxes.map((b) => {
    let c = ctx.userXform(b.center);
    if (params.flipZ) c = v3(c.x, c.y, -c.z);
    return {
      kind: 'square',
      fullY: true,
      position: c,
      rotation: R,
      scale: v3(b.size.x, b.size.y, b.size.z),
      color: b.color,
      area: Math.max(b.size.x * b.size.y, b.size.x * b.size.z, b.size.y * b.size.z),
    };
  });
  stats.afterDecimation = placements.length;
  stats.afterSubdivision = placements.length;
  stats.afterMerge = placements.length;

  if (params.center && placements.length) {
    let minX = 1/0, minY = 1/0, minZ = 1/0, maxX = -1/0, maxY = -1/0, maxZ = -1/0;
    for (const p of placements) {
      const h = [p.scale.x / 2, p.scale.y / 2, p.scale.z / 2];
      const ext = [0, 1, 2].map((i) =>
        Math.abs(R[i][0]) * h[0] + Math.abs(R[i][1]) * h[1] + Math.abs(R[i][2]) * h[2]);
      minX = Math.min(minX, p.position.x - ext[0]); maxX = Math.max(maxX, p.position.x + ext[0]);
      minY = Math.min(minY, p.position.y - ext[1]); maxY = Math.max(maxY, p.position.y + ext[1]);
      minZ = Math.min(minZ, p.position.z - ext[2]); maxZ = Math.max(maxZ, p.position.z + ext[2]);
    }
    const off = v3(-(minX + maxX) / 2, -minY, -(minZ + maxZ) / 2);
    for (const p of placements) p.position = add(p.position, off);
    stats.bounds = {
      x: round6(maxX - minX), y: round6(maxY - minY), z: round6(maxZ - minZ),
    };
    stats.centerOffset = { x: off.x, y: off.y, z: off.z };
  }

  if (placements.length > params.maxDecorations) {
    placements.sort((a, b) => b.area - a.area);
    stats.dropped = placements.length - params.maxDecorations;
    placements = placements.slice(0, params.maxDecorations);
  }
  stats.placements = placements.length;
  stats.squares = placements.length;
  stats.triangles = 0;
  stats.uniqueColors = new Set(placements.map((p) => colorToRgbInt(p.color))).size;

  const decorations = placements.map((pl) => placementToDecoration(pl, params));
  return { placements, decorations, stats, params };
}
