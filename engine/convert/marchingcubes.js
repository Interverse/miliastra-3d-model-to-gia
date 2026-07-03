// Standard Marching Cubes directly on the voxelized model (no SDF).
//
// The mesh surface is rasterized into a voxel grid with per-voxel colors;
// outside space is flood-filled from the border so enclosed volume counts as
// inside. The scalar field is simply -1 inside / +1 outside (optionally
// smoothed for a rounder surface), and the classic 256-case marching cubes
// tables triangulate the zero crossing.
//
// opts: { voxelSize, isoOffset (-1..1 shifts the threshold), smooth (0..4),
//         alphaCutoff }

import { sampleTexture } from './color.js';

// Paul Bourke's canonical tables. Corner order: v0..v7 =
// (0,0,0),(1,0,0),(1,1,0),(0,1,0),(0,0,1),(1,0,1),(1,1,1),(0,1,1)
// Edge order: 0:(0,1) 1:(1,2) 2:(2,3) 3:(3,0) 4:(4,5) 5:(5,6) 6:(6,7)
//             7:(7,4) 8:(0,4) 9:(1,5) 10:(2,6) 11:(3,7)
const EDGE_VERTS = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

const TRI_TABLE = [
[],[0,8,3],[0,1,9],[1,8,3,9,8,1],[1,2,10],[0,8,3,1,2,10],[9,2,10,0,2,9],[2,8,3,2,10,8,10,9,8],
[3,11,2],[0,11,2,8,11,0],[1,9,0,2,3,11],[1,11,2,1,9,11,9,8,11],[3,10,1,11,10,3],[0,10,1,0,8,10,8,11,10],
[3,9,0,3,11,9,11,10,9],[9,8,10,10,8,11],[4,7,8],[4,3,0,7,3,4],[0,1,9,8,4,7],[4,1,9,4,7,1,7,3,1],
[1,2,10,8,4,7],[3,4,7,3,0,4,1,2,10],[9,2,10,9,0,2,8,4,7],[2,10,9,2,9,7,2,7,3,7,9,4],
[8,4,7,3,11,2],[11,4,7,11,2,4,2,0,4],[9,0,1,8,4,7,2,3,11],[4,7,11,9,4,11,9,11,2,9,2,1],
[3,10,1,3,11,10,7,8,4],[1,11,10,1,4,11,1,0,4,7,11,4],[4,7,8,9,0,11,9,11,10,11,0,3],
[4,7,11,4,11,9,9,11,10],[9,5,4],[9,5,4,0,8,3],[0,5,4,1,5,0],[8,5,4,8,3,5,3,1,5],
[1,2,10,9,5,4],[3,0,8,1,2,10,4,9,5],[5,2,10,5,4,2,4,0,2],[2,10,5,3,2,5,3,5,4,3,4,8],
[9,5,4,2,3,11],[0,11,2,0,8,11,4,9,5],[0,5,4,0,1,5,2,3,11],[2,1,5,2,5,8,2,8,11,4,8,5],
[10,3,11,10,1,3,9,5,4],[4,9,5,0,8,1,8,10,1,8,11,10],[5,4,0,5,0,11,5,11,10,11,0,3],
[5,4,8,5,8,10,10,8,11],[9,7,8,5,7,9],[9,3,0,9,5,3,5,7,3],[0,7,8,0,1,7,1,5,7],
[1,5,3,3,5,7],[9,7,8,9,5,7,10,1,2],[10,1,2,9,5,0,5,3,0,5,7,3],[8,0,2,8,2,5,8,5,7,10,5,2],
[2,10,5,2,5,3,3,5,7],[7,9,5,7,8,9,3,11,2],[9,5,7,9,7,2,9,2,0,2,7,11],
[2,3,11,0,1,8,1,7,8,1,5,7],[11,2,1,11,1,7,7,1,5],[9,5,8,8,5,7,10,1,3,10,3,11],
[5,7,0,5,0,9,7,11,0,1,0,10,11,10,0],[11,10,0,11,0,3,10,5,0,8,0,7,5,7,0],
[11,10,5,7,11,5],[10,6,5],[0,8,3,5,10,6],[9,0,1,5,10,6],[1,8,3,1,9,8,5,10,6],
[1,6,5,2,6,1],[1,6,5,1,2,6,3,0,8],[9,6,5,9,0,6,0,2,6],[5,9,8,5,8,2,5,2,6,3,2,8],
[2,3,11,10,6,5],[11,0,8,11,2,0,10,6,5],[0,1,9,2,3,11,5,10,6],[5,10,6,1,9,2,9,11,2,9,8,11],
[6,3,11,6,5,3,5,1,3],[0,8,11,0,11,5,0,5,1,5,11,6],[3,11,6,0,3,6,0,6,5,0,5,9],
[6,5,9,6,9,11,11,9,8],[5,10,6,4,7,8],[4,3,0,4,7,3,6,5,10],[1,9,0,5,10,6,8,4,7],
[10,6,5,1,9,7,1,7,3,7,9,4],[6,1,2,6,5,1,4,7,8],[1,2,5,5,2,6,3,0,4,3,4,7],
[8,4,7,9,0,5,0,6,5,0,2,6],[7,3,9,7,9,4,3,2,9,5,9,6,2,6,9],[3,11,2,7,8,4,10,6,5],
[5,10,6,4,7,2,4,2,0,2,7,11],[0,1,9,4,7,8,2,3,11,5,10,6],[9,2,1,9,11,2,9,4,11,7,11,4,5,10,6],
[8,4,7,3,11,5,3,5,1,5,11,6],[5,1,11,5,11,6,1,0,11,7,11,4,0,4,11],
[0,5,9,0,6,5,0,3,6,11,6,3,8,4,7],[6,5,9,6,9,11,4,7,9,7,11,9],[10,4,9,6,4,10],
[4,10,6,4,9,10,0,8,3],[10,0,1,10,6,0,6,4,0],[8,3,1,8,1,6,8,6,4,6,1,10],
[1,4,9,1,2,4,2,6,4],[3,0,8,1,2,9,2,4,9,2,6,4],[0,2,4,4,2,6],[8,3,2,8,2,4,4,2,6],
[10,4,9,10,6,4,11,2,3],[0,8,2,2,8,11,4,9,10,4,10,6],[3,11,2,0,1,6,0,6,4,6,1,10],
[6,4,1,6,1,10,4,8,1,2,1,11,8,11,1],[9,6,4,9,3,6,9,1,3,11,6,3],
[8,11,1,8,1,0,11,6,1,9,1,4,6,4,1],[3,11,6,3,6,0,0,6,4],[6,4,8,11,6,8],
[7,10,6,7,8,10,8,9,10],[0,7,3,0,10,7,0,9,10,6,7,10],[10,6,7,1,10,7,1,7,8,1,8,0],
[10,6,7,10,7,1,1,7,3],[1,2,6,1,6,8,1,8,9,8,6,7],[2,6,9,2,9,1,6,7,9,0,9,3,7,3,9],
[7,8,0,7,0,6,6,0,2],[7,3,2,6,7,2],[2,3,11,10,6,8,10,8,9,8,6,7],
[2,0,7,2,7,11,0,9,7,6,7,10,9,10,7],[1,8,0,1,7,8,1,10,7,6,7,10,2,3,11],
[11,2,1,11,1,7,10,6,1,6,7,1],[8,9,6,8,6,7,9,1,6,11,6,3,1,3,6],
[0,9,1,11,6,7],[7,8,0,7,0,6,3,11,0,11,6,0],[7,11,6],[7,6,11],[3,0,8,11,7,6],
[0,1,9,11,7,6],[8,1,9,8,3,1,11,7,6],[10,1,2,6,11,7],[1,2,10,3,0,8,6,11,7],
[2,9,0,2,10,9,6,11,7],[6,11,7,2,10,3,10,8,3,10,9,8],[7,2,3,6,2,7],
[7,0,8,7,6,0,6,2,0],[2,7,6,2,3,7,0,1,9],[1,6,2,1,8,6,1,9,8,8,7,6],
[10,7,6,10,1,7,1,3,7],[10,7,6,1,7,10,1,8,7,1,0,8],[0,3,7,0,7,10,0,10,9,6,10,7],
[7,6,10,7,10,8,8,10,9],[6,8,4,11,8,6],[3,6,11,3,0,6,0,4,6],[8,6,11,8,4,6,9,0,1],
[9,4,6,9,6,3,9,3,1,11,3,6],[6,8,4,6,11,8,2,10,1],[1,2,10,3,0,11,0,6,11,0,4,6],
[4,11,8,4,6,11,0,2,9,2,10,9],[10,9,3,10,3,2,9,4,3,11,3,6,4,6,3],
[8,2,3,8,4,2,4,6,2],[0,4,2,4,6,2],[1,9,0,2,3,4,2,4,6,4,3,8],[1,9,4,1,4,2,2,4,6],
[8,1,3,8,6,1,8,4,6,6,10,1],[10,1,0,10,0,6,6,0,4],[4,6,3,4,3,8,6,10,3,0,3,9,10,9,3],
[10,9,4,6,10,4],[4,9,5,7,6,11],[0,8,3,4,9,5,11,7,6],[5,0,1,5,4,0,7,6,11],
[11,7,6,8,3,4,3,5,4,3,1,5],[9,5,4,10,1,2,7,6,11],[6,11,7,1,2,10,0,8,3,4,9,5],
[7,6,11,5,4,10,4,2,10,4,0,2],[3,4,8,3,5,4,3,2,5,10,5,2,11,7,6],
[7,2,3,7,6,2,5,4,9],[9,5,4,0,8,6,0,6,2,6,8,7],[3,6,2,3,7,6,1,5,0,5,4,0],
[6,2,8,6,8,7,2,1,8,4,8,5,1,5,8],[9,5,4,10,1,6,1,7,6,1,3,7],
[1,6,10,1,7,6,1,0,7,8,7,0,9,5,4],[4,0,10,4,10,5,0,3,10,6,10,7,3,7,10],
[7,6,10,7,10,8,5,4,10,4,8,10],[6,9,5,6,11,9,11,8,9],[3,6,11,0,6,3,0,5,6,0,9,5],
[0,11,8,0,5,11,0,1,5,5,6,11],[6,11,3,6,3,5,5,3,1],[1,2,10,9,5,11,9,11,8,11,5,6],
[0,11,3,0,6,11,0,9,6,5,6,9,1,2,10],[11,8,5,11,5,6,8,0,5,10,5,2,0,2,5],
[6,11,3,6,3,5,2,10,3,10,5,3],[5,8,9,5,2,8,5,6,2,3,8,2],[9,5,6,9,6,0,0,6,2],
[1,5,8,1,8,0,5,6,8,3,8,2,6,2,8],[1,5,6,2,1,6],[1,3,6,1,6,10,3,8,6,5,6,9,8,9,6],
[10,1,0,10,0,6,9,5,0,5,6,0],[0,3,8,5,6,10],[10,5,6],[11,5,10,7,5,11],
[11,5,10,11,7,5,8,3,0],[5,11,7,5,10,11,1,9,0],[10,7,5,10,11,7,9,8,1,8,3,1],
[11,1,2,11,7,1,7,5,1],[0,8,3,1,2,7,1,7,5,7,2,11],[9,7,5,9,2,7,9,0,2,2,11,7],
[7,5,2,7,2,11,5,9,2,3,2,8,9,8,2],[2,5,10,2,3,5,3,7,5],[8,2,0,8,5,2,8,7,5,10,2,5],
[9,0,1,5,10,3,5,3,7,3,10,2],[9,8,2,9,2,1,8,7,2,10,2,5,7,5,2],[1,3,5,3,7,5],
[0,8,7,0,7,1,1,7,5],[9,0,3,9,3,5,5,3,7],[9,8,7,5,9,7],[5,8,4,5,10,8,10,11,8],
[5,0,4,5,11,0,5,10,11,11,3,0],[0,1,9,8,4,10,8,10,11,10,4,5],
[10,11,4,10,4,5,11,3,4,9,4,1,3,1,4],[2,5,1,2,8,5,2,11,8,4,5,8],
[0,4,11,0,11,3,4,5,11,2,11,1,5,1,11],[0,2,5,0,5,9,2,11,5,4,5,8,11,8,5],
[9,4,5,2,11,3],[2,5,10,3,5,2,3,4,5,3,8,4],[5,10,2,5,2,4,4,2,0],
[3,10,2,3,5,10,3,8,5,4,5,8,0,1,9],[5,10,2,5,2,4,1,9,2,9,4,2],
[8,4,5,8,5,3,3,5,1],[0,4,5,1,0,5],[8,4,5,8,5,3,9,0,5,0,3,5],[9,4,5],
[4,11,7,4,9,11,9,10,11],[0,8,3,4,9,7,9,11,7,9,10,11],[1,10,11,1,11,4,1,4,0,7,4,11],
[3,1,4,3,4,8,1,10,4,7,4,11,10,11,4],[4,11,7,9,11,4,9,2,11,9,1,2],
[9,7,4,9,11,7,9,1,11,2,11,1,0,8,3],[11,7,4,11,4,2,2,4,0],
[11,7,4,11,4,2,8,3,4,3,2,4],[2,9,10,2,7,9,2,3,7,7,4,9],
[9,10,7,9,7,4,10,2,7,8,7,0,2,0,7],[3,7,10,3,10,2,7,4,10,1,10,0,4,0,10],
[1,10,2,8,7,4],[4,9,1,4,1,7,7,1,3],[4,9,1,4,1,7,0,8,1,8,7,1],[4,0,3,7,4,3],
[4,8,7],[9,10,8,10,11,8],[3,0,9,3,9,11,11,9,10],[0,1,10,0,10,8,8,10,11],
[3,1,10,11,3,10],[1,2,11,1,11,9,9,11,8],[3,0,9,3,9,11,1,2,9,2,11,9],
[0,2,11,8,0,11],[3,2,11],[2,3,8,2,8,10,10,8,9],[9,10,2,0,9,2],
[2,3,8,2,8,10,0,1,8,1,10,8],[1,10,2],[1,3,8,9,1,8],[0,9,1],[0,3,8],[]
];

export function marchingCubesSurface(tris, opts = {}) {
  const vs = Math.max(1e-4, opts.voxelSize ?? 0.1);
  const isoOffset = Math.max(-0.9, Math.min(0.9, opts.isoOffset ?? 0));
  const smooth = Math.max(0, Math.min(4, opts.smooth ?? 0));
  const alphaCutoff = Math.max(0.004, opts.alphaCutoff ?? 0.5);

  // ---- bbox & grid ----
  let minX = 1/0, minY = 1/0, minZ = 1/0, maxX = -1/0, maxY = -1/0, maxZ = -1/0;
  for (const t of tris) for (const q of t.p) {
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z);
  }
  if (!(maxX > -1/0)) return { tris: [], voxels: 0, cells: 0 };
  const PAD = 2;
  const ox = minX - PAD * vs, oy = minY - PAD * vs, oz = minZ - PAD * vs;
  const nx = Math.ceil((maxX - ox) / vs) + PAD + 1;
  const ny = Math.ceil((maxY - oy) / vs) + PAD + 1;
  const nz = Math.ceil((maxZ - oz) / vs) + PAD + 1;
  const total = nx * ny * nz;
  if (total > 24_000_000) throw new Error('Marching cubes grid too large — lower the voxel resolution');
  const idx = (x, y, z) => (z * ny + y) * nx + x;

  // ---- surface rasterization with colors (same sampler as voxelize) ----
  const occ = new Uint8Array(total);
  const colR = new Float32Array(total), colG = new Float32Array(total),
    colB = new Float32Array(total), colN = new Float32Array(total);
  for (const t of tris) {
    const [A, B, C] = t.p;
    const tex = t.mesh?.texture;
    const base = t.mesh?.color ?? [255, 255, 255];
    const flat = t.color ?? base;
    const e1 = { x: B.x - A.x, y: B.y - A.y, z: B.z - A.z };
    const e2 = { x: C.x - A.x, y: C.y - A.y, z: C.z - A.z };
    const l1 = Math.hypot(e1.x, e1.y, e1.z), l2 = Math.hypot(e2.x, e2.y, e2.z);
    const n = Math.max(1, Math.min(600, Math.ceil(Math.max(l1, l2) / (vs * 0.5))));
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
          if (((s[3] ?? 255) / 255) < alphaCutoff) continue;
          col = [s[0] * base[0] / 255, s[1] * base[1] / 255, s[2] * base[2] / 255];
        }
        const gx = Math.floor((px - ox) / vs), gy = Math.floor((py - oy) / vs), gz = Math.floor((pz - oz) / vs);
        if (gx < 0 || gy < 0 || gz < 0 || gx >= nx || gy >= ny || gz >= nz) continue;
        const k = idx(gx, gy, gz);
        occ[k] = 1;
        colR[k] += col[0]; colG[k] += col[1]; colB[k] += col[2]; colN[k]++;
      }
    }
  }
  let voxels = 0;
  for (let k = 0; k < total; k++) if (occ[k]) voxels++;
  if (!voxels) return { tris: [], voxels: 0, cells: 0 };

  // ---- inside/outside classification (border flood fill; NOT an SDF) ----
  const outside = new Uint8Array(total);
  {
    const queue = [];
    const pushIf = (x, y, z) => {
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
      const k = idx(x, y, z);
      if (outside[k] || occ[k]) return;
      outside[k] = 1;
      queue.push(x, y, z);
    };
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) { pushIf(x, y, 0); pushIf(x, y, nz - 1); }
    for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) { pushIf(x, 0, z); pushIf(x, ny - 1, z); }
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) { pushIf(0, y, z); pushIf(nx - 1, y, z); }
    let head = 0;
    while (head < queue.length) {
      const x = queue[head++], y = queue[head++], z = queue[head++];
      pushIf(x + 1, y, z); pushIf(x - 1, y, z);
      pushIf(x, y + 1, z); pushIf(x, y - 1, z);
      pushIf(x, y, z + 1); pushIf(x, y, z - 1);
    }
  }

  // binary field: -1 inside/surface, +1 outside (optionally smoothed)
  let field = new Float32Array(total);
  for (let k = 0; k < total; k++) field[k] = outside[k] ? 1 : -1;
  for (let pass = 0; pass < smooth; pass++) {
    const next = new Float32Array(total);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const k = idx(x, y, z);
      let sum = field[k] * 2, cnt = 2;
      if (x > 0) { sum += field[k - 1]; cnt++; }
      if (x < nx - 1) { sum += field[k + 1]; cnt++; }
      if (y > 0) { sum += field[idx(x, y - 1, z)]; cnt++; }
      if (y < ny - 1) { sum += field[idx(x, y + 1, z)]; cnt++; }
      if (z > 0) { sum += field[idx(x, y, z - 1)]; cnt++; }
      if (z < nz - 1) { sum += field[idx(x, y, z + 1)]; cnt++; }
      next[k] = sum / cnt;
    }
    field = next;
  }

  // ---- standard marching cubes ----
  const iso = isoOffset;
  const CORNER = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const outTris = [];
  let cells = 0;
  const cv = new Float64Array(8);
  const cp = new Array(8);
  const edgePoint = new Array(12);
  const edgeColor = new Array(12);

  // color at a grid corner: average of the colored voxels in its immediate
  // neighborhood (cached). Expanding rings are only used as a fallback.
  const cornerColorCache = new Map();
  const cornerColor = (x, y, z) => {
    const ck = idx(x, y, z);
    let c = cornerColorCache.get(ck);
    if (c) return c;
    for (let r = 0; r <= 3; r++) {
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        const xx = x + dx, yy = y + dy, zz = z + dz;
        if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
        const k = idx(xx, yy, zz);
        if (!colN[k]) continue;
        const w = 1 / (1 + dx * dx + dy * dy + dz * dz);
        sr += (colR[k] / colN[k]) * w;
        sg += (colG[k] / colN[k]) * w;
        sb += (colB[k] / colN[k]) * w;
        sw += w;
      }
      if (sw > 0) {
        c = [sr / sw, sg / sw, sb / sw];
        cornerColorCache.set(ck, c);
        return c;
      }
    }
    c = [200, 200, 200];
    cornerColorCache.set(ck, c);
    return c;
  };

  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        let cubeIndex = 0;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNER[c];
          const v = field[idx(x + dx, y + dy, z + dz)] - iso;
          cv[c] = v;
          if (v < 0) cubeIndex |= 1 << c;
        }
        const triList = TRI_TABLE[cubeIndex];
        if (!triList.length) continue;
        cells++;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNER[c];
          cp[c] = [
            ox + (x + dx + 0.5) * vs,
            oy + (y + dy + 0.5) * vs,
            oz + (z + dz + 0.5) * vs,
          ];
        }
        // interpolate the needed edge crossings; each crossing's color blends
        // the colors of the two connected grid corners by the same weight,
        // giving smooth transitions across the surface
        for (let e = 0; e < 12; e++) edgePoint[e] = null;
        for (let i = 0; i < triList.length; i++) {
          const e = triList[i];
          if (edgePoint[e]) continue;
          const [a, b] = EDGE_VERTS[e];
          const fa = cv[a], fb = cv[b];
          const t = Math.abs(fa - fb) < 1e-9 ? 0.5 : fa / (fa - fb);
          const A = cp[a], B = cp[b];
          edgePoint[e] = {
            x: A[0] + (B[0] - A[0]) * t,
            y: A[1] + (B[1] - A[1]) * t,
            z: A[2] + (B[2] - A[2]) * t,
          };
          const [ax, ay, az] = CORNER[a];
          const [bx, by, bz] = CORNER[b];
          const ca = cornerColor(x + ax, y + ay, z + az);
          const cb = cornerColor(x + bx, y + by, z + bz);
          edgeColor[e] = [
            ca[0] + (cb[0] - ca[0]) * t,
            ca[1] + (cb[1] - ca[1]) * t,
            ca[2] + (cb[2] - ca[2]) * t,
          ];
        }
        for (let i = 0; i + 2 < triList.length; i += 3) {
          const p0 = edgePoint[triList[i]], p1 = edgePoint[triList[i + 1]], p2 = edgePoint[triList[i + 2]];
          const c0 = edgeColor[triList[i]], c1 = edgeColor[triList[i + 1]], c2 = edgeColor[triList[i + 2]];
          outTris.push({
            p: [p0, p1, p2],
            color: [
              (c0[0] + c1[0] + c2[0]) / 3,
              (c0[1] + c1[1] + c2[1]) / 3,
              (c0[2] + c1[2] + c2[2]) / 3,
            ],
          });
        }
      }
    }
  }
  return { tris: outTris, voxels, cells };
}
