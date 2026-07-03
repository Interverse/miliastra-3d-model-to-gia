// Voxel reconstruction: rasterize triangles into a voxel grid with
// per-sample texture colors, cluster voxel colors within a tolerance, and
// greedy-merge same-color voxels into boxes (cuboid decorations).
//
// Produces accurate voxel-style geometry/colors (each voxel's color is the
// average of all texture samples that fall inside it), unlike the old
// square-pairing workflow which could overlap and mis-color texels.
//
// tris: [{ p: [v0,v1,v2], color?, uv?, mesh? }] — if uv+mesh.texture are
//   present the texture is sampled directly; otherwise tri.color / material
//   color is used.
// opts: { voxelSize (m), colorTolerance, maxBoxEdge (m), alphaCutoff }
//
// Returns { boxes: [{center, size, color}], voxels, filledVoxels }

import { sampleTexture, colorDistance } from './color.js';

export function voxelizeTriangles(tris, opts = {}) {
  const vs = Math.max(1e-4, opts.voxelSize ?? 0.1);
  const tol = opts.colorTolerance ?? 20;
  const maxRun = Math.max(1, Math.floor((opts.maxBoxEdge ?? 5) / vs));
  const alphaCutoff = Math.max(0.004, opts.alphaCutoff ?? 0.5);

  // accumulate color per voxel
  const acc = new Map(); // "x,y,z" -> {r,g,b,n}
  const key = (x, y, z) => x + ',' + y + ',' + z;

  for (const t of tris) {
    const [A, B, C] = t.p;
    const tex = t.mesh?.texture;
    const base = t.mesh?.color ?? [255, 255, 255];
    const flat = t.color ?? base;
    // sample density: cover the triangle at ~half-voxel spacing
    const e1 = { x: B.x - A.x, y: B.y - A.y, z: B.z - A.z };
    const e2 = { x: C.x - A.x, y: C.y - A.y, z: C.z - A.z };
    const l1 = Math.hypot(e1.x, e1.y, e1.z);
    const l2 = Math.hypot(e2.x, e2.y, e2.z);
    const n = Math.max(1, Math.min(400, Math.ceil(Math.max(l1, l2) / (vs * 0.5))));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n;
        const px = A.x + e1.x * u + e2.x * v;
        const py = A.y + e1.y * u + e2.y * v;
        const pz = A.z + e1.z * u + e2.z * v;
        let col = flat;
        if (tex && t.uv) {
          const w0 = 1 - u - v;
          const tu = t.uv[0][0] * w0 + t.uv[1][0] * u + t.uv[2][0] * v;
          const tv = t.uv[0][1] * w0 + t.uv[1][1] * u + t.uv[2][1] * v;
          const s = sampleTexture(tex, tu, tv);
          if (((s[3] ?? 255) / 255) < alphaCutoff) continue; // transparent
          col = [s[0] * base[0] / 255, s[1] * base[1] / 255, s[2] * base[2] / 255];
        }
        const k = key(Math.floor(px / vs), Math.floor(py / vs), Math.floor(pz / vs));
        let a = acc.get(k);
        if (!a) { a = { r: 0, g: 0, b: 0, n: 0 }; acc.set(k, a); }
        a.r += col[0]; a.g += col[1]; a.b += col[2]; a.n++;
      }
    }
  }

  // visibility cull: flood-fill the OUTSIDE space from the grid border and
  // keep only voxels that touch it. Everything else (fully enclosed voxels,
  // and even the walls of sealed interior cavities) can never be seen from
  // outside and is dropped before merging.
  let culled = 0;
  {
    let minX = 1/0, minY = 1/0, minZ = 1/0, maxX = -1/0, maxY = -1/0, maxZ = -1/0;
    for (const k of acc.keys()) {
      const [x, y, z] = k.split(',').map(Number);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    // pad by 1 so the outside wraps the model
    minX--; minY--; minZ--; maxX++; maxY++; maxZ++;
    const outside = new Set();
    const queue = [[minX, minY, minZ]];
    outside.add(minX + ',' + minY + ',' + minZ);
    const inBounds = (x, y, z) =>
      x >= minX && y >= minY && z >= minZ && x <= maxX && y <= maxY && z <= maxZ;
    while (queue.length) {
      const [x, y, z] = queue.pop();
      for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const xx = x + dx, yy = y + dy, zz = z + dz;
        if (!inBounds(xx, yy, zz)) continue;
        const k = xx + ',' + yy + ',' + zz;
        if (outside.has(k) || acc.has(k)) continue;
        outside.add(k);
        queue.push([xx, yy, zz]);
      }
    }
    const toCull = [];
    for (const k of acc.keys()) {
      const [x, y, z] = k.split(',').map(Number);
      let visible = false;
      for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        if (outside.has((x + dx) + ',' + (y + dy) + ',' + (z + dz))) { visible = true; break; }
      }
      if (!visible) toCull.push(k);
    }
    for (const k of toCull) acc.delete(k);
    culled = toCull.length;
  }

  // voxel colors + tolerance clustering (first-seen representative)
  const clusters = []; // [r,g,b]
  const voxels = new Map(); // key -> clusterIndex
  for (const [k, a] of acc) {
    const c = [a.r / a.n, a.g / a.n, a.b / a.n];
    let ci = -1;
    for (let i = 0; i < clusters.length; i++) {
      if (colorDistance(c, clusters[i]) <= tol) { ci = i; break; }
    }
    if (ci < 0) { ci = clusters.length; clusters.push(c); }
    voxels.set(k, ci);
  }

  // greedy 3D box merge per cluster
  const remaining = new Set(voxels.keys());
  const boxes = [];
  const has = (x, y, z, ci) => {
    const k = key(x, y, z);
    return remaining.has(k) && voxels.get(k) === ci;
  };
  for (const k0 of voxels.keys()) {
    if (!remaining.has(k0)) continue;
    const [x0, y0, z0] = k0.split(',').map(Number);
    const ci = voxels.get(k0);
    // grow x
    let x1 = x0;
    while (x1 - x0 + 1 < maxRun && has(x1 + 1, y0, z0, ci)) x1++;
    // grow y while full rows exist
    let y1 = y0;
    outerY: while (y1 - y0 + 1 < maxRun) {
      for (let x = x0; x <= x1; x++) if (!has(x, y1 + 1, z0, ci)) break outerY;
      y1++;
    }
    // grow z while full slabs exist
    let z1 = z0;
    outerZ: while (z1 - z0 + 1 < maxRun) {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          if (!has(x, y, z1 + 1, ci)) break outerZ;
      z1++;
    }
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) remaining.delete(key(x, y, z));
    boxes.push({
      center: {
        x: (x0 + x1 + 1) / 2 * vs,
        y: (y0 + y1 + 1) / 2 * vs,
        z: (z0 + z1 + 1) / 2 * vs,
      },
      size: {
        x: (x1 - x0 + 1) * vs,
        y: (y1 - y0 + 1) * vs,
        z: (z1 - z0 + 1) * vs,
      },
      color: clusters[ci],
    });
  }
  return { boxes, voxels: voxels.size, clusters: clusters.length, culled };
}
