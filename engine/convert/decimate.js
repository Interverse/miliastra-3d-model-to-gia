// Vertex-clustering mesh decimation.
//
// Snaps vertex positions to a uniform grid and collapses triangles whose
// corners land in fewer than 3 distinct cells. Cheap, dependency-free, and
// preserves per-corner UVs (positions move slightly; UVs are untouched),
// so texture color sampling keeps working after decimation.
//
// Operates on raw triangles: { p: [v0,v1,v2], uv: [..]|null }.

const key = (p, cell) =>
  Math.round(p.x / cell) + ',' + Math.round(p.y / cell) + ',' + Math.round(p.z / cell);

// strength: 0 = off, 0..1 = increasingly aggressive.
// Grid resolution across the largest bbox dimension: 256 (fine) → ~16 (coarse).
export function decimateTriangles(tris, strength) {
  if (!strength || strength <= 0 || tris.length === 0) return tris;
  const s = Math.min(1, strength);

  let minX = 1/0, minY = 1/0, minZ = 1/0, maxX = -1/0, maxY = -1/0, maxZ = -1/0;
  for (const t of tris) for (const q of t.p) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    if (q.z < minZ) minZ = q.z; if (q.z > maxZ) maxZ = q.z;
  }
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (maxDim <= 0) return tris;
  const gridRes = Math.max(8, Math.round(256 * Math.pow(1 - s, 1.5) + 16));
  const cell = maxDim / gridRes;

  // representative position per cell = average of member vertices
  const cells = new Map(); // key -> {x,y,z,n}
  for (const t of tris) for (const q of t.p) {
    const k = key(q, cell);
    let c = cells.get(k);
    if (!c) { c = { x: 0, y: 0, z: 0, n: 0 }; cells.set(k, c); }
    c.x += q.x; c.y += q.y; c.z += q.z; c.n++;
  }

  const out = [];
  for (const t of tris) {
    const ks = t.p.map((q) => key(q, cell));
    if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue; // collapsed
    const p = ks.map((k) => {
      const c = cells.get(k);
      return { x: c.x / c.n, y: c.y / c.n, z: c.z / c.n };
    });
    out.push({ ...t, p });
  }
  return out;
}
