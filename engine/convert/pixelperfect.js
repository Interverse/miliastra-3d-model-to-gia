// Pixel Perfect reconstruction for voxel-style models.
//
// Pairs the source triangles into rectangular faces, maps each face's texel
// grid exactly (nearest texel colors — no averaging, no misalignment), and
// emits one thin square per maximal same-color texel rectangle (2D greedy
// meshing per face). Geometry and per-pixel texture colors are reproduced
// exactly; only texels whose colors are equal (within mergeTolerance,
// default 0 = exact) are combined.
//
// Faces whose UVs aren't texel-grid aligned (or triangles that pair into no
// rectangle) are returned in `rest` for the standard pipeline.
//
// Overdraw mode (opts.overdraw): each face first gets ONE background square
// in its dominant color, then only the differing texel regions are layered
// on top, offset by 0.001 m along the face normal (no z-fighting, far fewer
// decorations, same final appearance). Faces with transparent texels keep
// the exact per-texel layout.
//
// rawTris: [{ p:[v0,v1,v2], uv, mesh }]
// opts: { alphaCutoff, mergeTolerance, maxTexelsPerFace, overdraw }

import { v3, sub, add, mul, dot, cross, len, norm, matFromCols } from './vec3.js';
import { sampleTexture, colorDistance } from './color.js';
import { weldTriangles } from './mesh-ops.js';

const EPS_INT = 0.02; // how close a UV span must be to an integer texel count

export function pixelPerfect(rawTris, opts = {}) {
  const alphaCutoff = Math.max(0.004, opts.alphaCutoff ?? 0.5);
  const mergeTol = opts.mergeTolerance ?? 0;
  const maxTexels = opts.maxTexelsPerFace ?? 16384;
  const overdraw = !!opts.overdraw;
  const LAYER = 0.001; // m offset along the face normal per overdraw layer

  const { ids } = weldTriangles(rawTris, opts.weldEps ?? 1e-4);
  const placements = [];
  const used = new Array(rawTris.length).fill(false);
  let texels = 0, transparent = 0;

  // right-angle corner info per triangle (needed for rectangle pairing)
  const corners = new Array(rawTris.length).fill(null);
  const byHyp = new Map();
  for (let t = 0; t < rawTris.length; t++) {
    const tri = rawTris[t];
    for (let i = 0; i < 3; i++) {
      const a = tri.p[i], b = tri.p[(i + 1) % 3], c = tri.p[(i + 2) % 3];
      const u = norm(sub(b, a)), w = norm(sub(c, a));
      if (Math.abs(dot(u, w)) <= 0.02) {
        corners[t] = { ai: i, bi: (i + 1) % 3, ci: (i + 2) % 3 };
        const idB = ids[t * 3 + (i + 1) % 3], idC = ids[t * 3 + (i + 2) % 3];
        const key = idB < idC ? idB + '_' + idC : idC + '_' + idB;
        let list = byHyp.get(key);
        if (!list) { list = []; byHyp.set(key, list); }
        list.push(t);
        break;
      }
    }
  }

  const normals = rawTris.map((t) => norm(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]))));

  for (const list of byHyp.values()) {
    for (let i = 0; i < list.length; i++) {
      const t1 = list[i];
      if (used[t1]) continue;
      for (let j = i + 1; j < list.length; j++) {
        const t2 = list[j];
        if (used[t2] || rawTris[t1].mesh !== rawTris[t2].mesh) continue;
        if (dot(normals[t1], normals[t2]) < 0.999) continue;
        const c1 = corners[t1], c2 = corners[t2];
        const A = rawTris[t1].p[c1.ai], B = rawTris[t1].p[c1.bi], C = rawTris[t1].p[c1.ci];
        const D = rawTris[t2].p[c2.ai];
        const expect = sub(add(B, C), A);
        const scale = Math.max(len(sub(B, A)), len(sub(C, A)));
        if (len(sub(expect, D)) > Math.max(1e-4, scale * 0.02)) continue;
        // rectangle found — emit texel squares
        if (emitFace(rawTris[t1], c1, normals[t1])) {
          used[t1] = used[t2] = true;
        }
        break;
      }
    }
  }

  function emitFace(tri, ci, n) {
    const A = tri.p[ci.ai], B = tri.p[ci.bi], C = tri.p[ci.ci];
    const mesh = tri.mesh;
    const tex = mesh?.texture;
    const base = mesh?.color ?? [255, 255, 255];
    const eB = sub(B, A), eC = sub(C, A);
    const lenB = len(eB), lenC = len(eC);

    // no texture: single solid square covering the face
    if (!tex || !tri.uv) {
      pushRect(A, eB, eC, 0, 0, 1, 1, 1, 1, base, n);
      return true;
    }

    const uvA = tri.uv[ci.ai], uvB = tri.uv[ci.bi], uvC = tri.uv[ci.ci];
    // texel-space edge vectors
    const du = [(uvB[0] - uvA[0]) * tex.width, (uvB[1] - uvA[1]) * tex.height];
    const dv = [(uvC[0] - uvA[0]) * tex.width, (uvC[1] - uvA[1]) * tex.height];
    // require each UV edge to be texel-axis aligned (voxel-style UVs)
    const axisSpan = (d) => {
      const ax = Math.abs(d[0]), ay = Math.abs(d[1]);
      if (ay < EPS_INT && ax >= 1 - EPS_INT) return ax;
      if (ax < EPS_INT && ay >= 1 - EPS_INT) return ay;
      return -1;
    };
    const spanU = axisSpan(du), spanV = axisSpan(dv);
    if (spanU < 0 || spanV < 0) return false;
    const nU = Math.round(spanU), nV = Math.round(spanV);
    if (Math.abs(spanU - nU) > EPS_INT * Math.max(1, nU) ||
        Math.abs(spanV - nV) > EPS_INT * Math.max(1, nV)) return false;
    if (nU < 1 || nV < 1 || nU * nV > maxTexels) return false;

    // sample the texel grid (nearest, exact texel centers)
    const grid = new Int32Array(nU * nV); // -1 transparent, else color int (or cluster)
    const clusters = [];
    for (let jv = 0; jv < nV; jv++) {
      for (let iu = 0; iu < nU; iu++) {
        const u = uvA[0] + (uvB[0] - uvA[0]) * ((iu + 0.5) / nU) + (uvC[0] - uvA[0]) * ((jv + 0.5) / nV);
        const v = uvA[1] + (uvB[1] - uvA[1]) * ((iu + 0.5) / nU) + (uvC[1] - uvA[1]) * ((jv + 0.5) / nV);
        const s = sampleTexture(tex, u, v);
        texels++;
        if (((s[3] ?? 255) / 255) < alphaCutoff) {
          grid[jv * nU + iu] = -1;
          transparent++;
          continue;
        }
        const col = [s[0] * base[0] / 255, s[1] * base[1] / 255, s[2] * base[2] / 255];
        let idx = -1;
        if (mergeTol > 0) {
          for (let k = 0; k < clusters.length; k++) {
            if (colorDistance(col, clusters[k]) <= mergeTol) { idx = k; break; }
          }
        } else {
          const key = (Math.round(col[0]) << 16) | (Math.round(col[1]) << 8) | Math.round(col[2]);
          idx = clusters.findIndex((c) => ((Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])) === key);
        }
        if (idx < 0) { idx = clusters.length; clusters.push(col); }
        grid[jv * nU + iu] = idx;
      }
    }

    // overdraw layering: one dominant-color background square + only the
    // differing regions on top (offset LAYER along the normal). Requires a
    // fully opaque face, otherwise the background would fill holes.
    let skipIdx = -2; // cluster index handled by the background (none)
    let fgOffset = null;
    if (overdraw && clusters.length > 1) {
      let hasTransparent = false;
      const counts = new Array(clusters.length).fill(0);
      for (let k = 0; k < grid.length; k++) {
        if (grid[k] < 0) { hasTransparent = true; break; }
        counts[grid[k]]++;
      }
      if (!hasTransparent) {
        let dom = 0;
        for (let k = 1; k < counts.length; k++) if (counts[k] > counts[dom]) dom = k;
        pushRect(A, eB, eC, 0, 0, 1, 1, nU, nV, clusters[dom], n, null);
        skipIdx = dom;
        fgOffset = mul(n, LAYER);
      }
    }

    // 2D greedy meshing over equal clusters
    const usedCell = new Uint8Array(nU * nV);
    for (let jv = 0; jv < nV; jv++) {
      for (let iu = 0; iu < nU; iu++) {
        if (usedCell[jv * nU + iu] || grid[jv * nU + iu] < 0 || grid[jv * nU + iu] === skipIdx) continue;
        const cIdx = grid[jv * nU + iu];
        let i1 = iu;
        while (i1 + 1 < nU && !usedCell[jv * nU + i1 + 1] && grid[jv * nU + i1 + 1] === cIdx) i1++;
        let j1 = jv;
        outer: while (j1 + 1 < nV) {
          for (let x = iu; x <= i1; x++) {
            if (usedCell[(j1 + 1) * nU + x] || grid[(j1 + 1) * nU + x] !== cIdx) break outer;
          }
          j1++;
        }
        for (let y = jv; y <= j1; y++)
          for (let x = iu; x <= i1; x++) usedCell[y * nU + x] = 1;
        pushRect(A, eB, eC, iu / nU, jv / nV, (i1 + 1) / nU, (j1 + 1) / nV, nU, nV, clusters[cIdx], n, fgOffset);
      }
    }
    return true;
  }

  // rectangle sub-region [u0,u1]x[v0,v1] (edge fractions) of face A + eB,eC;
  // layerOff shifts the rect along the face normal (overdraw layering)
  function pushRect(A, eB, eC, u0, v0, u1, v1, nU, nV, color, n, layerOff) {
    if (layerOff) A = add(A, layerOff);
    const P0 = add(A, add(mul(eB, u0), mul(eC, v0)));
    const wu = mul(eB, u1 - u0), wv = mul(eC, v1 - v0);
    const lu = len(wu), lv = len(wv);
    if (lu < 1e-9 || lv < 1e-9) return;
    const x = mul(wu, 1 / lu);
    const z = mul(wv, 1 / lv);
    let y = cross(z, x); // det[x,y,z] = +1
    if (n && dot(y, n) < 0) {
      // flip to match the face normal: swap edge roles
      const pl = {
        kind: 'square',
        position: add(P0, mul(add(wu, wv), 0.5)),
        rotation: matFromCols(z, cross(x, z), x),
        scale: v3(lv, 1, lu),
        color,
        area: lu * lv,
      };
      placements.push(pl);
      return;
    }
    placements.push({
      kind: 'square',
      position: add(P0, mul(add(wu, wv), 0.5)),
      rotation: matFromCols(x, y, z),
      scale: v3(lu, 1, lv),
      color,
      area: lu * lv,
    });
  }

  const rest = [];
  for (let t = 0; t < rawTris.length; t++) if (!used[t]) rest.push(rawTris[t]);
  return { placements, rest, texels, transparent };
}
