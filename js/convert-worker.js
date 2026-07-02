// Web Worker: runs the conversion pipeline off the main thread.
import { convert } from '../engine/convert/converter.js';

self.onmessage = (ev) => {
  const { meshes, sprite, params, jobId } = ev.data;
  try {
    const result = convert(sprite ? { sprite } : { meshes }, params);
    // Build preview geometry from the QUANTIZED decoration records so the
    // overlay shows exactly what the .gia file will contain.
    const { positions, colors } = buildPreview(result.decorations, result.params);
    self.postMessage({
      jobId,
      ok: true,
      decorations: result.decorations,
      stats: result.stats,
      positions,
      colors,
    }, [positions.buffer, colors.buffer]);
  } catch (err) {
    self.postMessage({ jobId, ok: false, error: String(err && err.stack || err) });
  }
};

// sRGB (0..255) -> linear (0..1). three.js interprets vertex colors as
// linear; feeding sRGB directly washes colors out after output encoding.
function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

// Reconstruct triangles from decoration records (position units, Euler
// degrees, scale) — same math the game engine applies. Squares become two
// display triangles.
function buildPreview(decorations, params) {
  const RADIANS = Math.PI / 180;
  let triCount = 0;
  for (const d of decorations) triCount += d.kind === 'square' ? 12 : 1;
  const positions = new Float32Array(triCount * 9);
  const colors = new Float32Array(triCount * 9);
  const flip = params.flipZ ? -1 : 1;
  let o = 0, co = 0;

  const pushTri = (verts, r, g, b) => {
    for (const v of verts) {
      positions[o++] = v[0]; positions[o++] = v[1]; positions[o++] = v[2] * flip;
    }
    for (let k = 0; k < 3; k++) { colors[co++] = r; colors[co++] = g; colors[co++] = b; }
  };

  for (const d of decorations) {
    const px = d.position.x / 10, py = d.position.y / 10, pz = d.position.z / 10;
    const m = eulerToMat(d.rotationDeg.x * RADIANS, d.rotationDeg.y * RADIANS, d.rotationDeg.z * RADIANS, params.eulerOrder);
    const col = (ci, s) => [m[0][ci] * s, m[1][ci] * s, m[2][ci] * s];
    const r = srgbToLinear((d.color >> 16) & 255);
    const g = srgbToLinear((d.color >> 8) & 255);
    const b = srgbToLinear(d.color & 255);

    if (d.kind === 'square') {
      // the square primitive is a unit cube: 0.1 m per axis at scale 1,
      // centered — render the full box (also covers elongated sprite boxes)
      const hu = col(0, d.scale.x * 0.05);
      const hv = col(1, d.scale.y * 0.05);
      const hw = col(2, d.scale.z * 0.05);
      const corner = (sx, sy, sz) => [
        px + sx * hu[0] + sy * hv[0] + sz * hw[0],
        py + sx * hu[1] + sy * hv[1] + sz * hw[1],
        pz + sx * hu[2] + sy * hv[2] + sz * hw[2],
      ];
      // 8 corners: bit0=x, bit1=y, bit2=z (- / +)
      const c = [];
      for (let i = 0; i < 8; i++) c.push(corner(i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1));
      const quads = [
        [0, 1, 3, 2], // -z
        [5, 4, 6, 7], // +z
        [4, 0, 2, 6], // -x
        [1, 5, 7, 3], // +x
        [4, 5, 1, 0], // -y
        [2, 3, 7, 6], // +y
      ];
      for (const [a, bq, cq, dq] of quads) {
        pushTri([c[a], c[bq], c[cq]], r, g, b);
        pushTri([c[a], c[cq], c[dq]], r, g, b);
      }
    } else {
      // canonical 0.5 m legs at scale 1, corner at origin, legs on local Y/Z
      const a = d.scale.y * 0.5, bb = d.scale.z * 0.5;
      const uy = col(1, a), wz = col(2, bb);
      pushTri([
        [px, py, pz],
        [px + uy[0], py + uy[1], pz + uy[2]],
        [px + wz[0], py + wz[1], pz + wz[2]],
      ], r, g, b);
    }
  }
  return { positions, colors };
}

function eulerToMat(x, y, z, order) {
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const mul = (A, B) => {
    const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      r[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    return r;
  };
  return order === 'XYZ' ? mul(Rx, mul(Ry, Rz)) : mul(Ry, mul(Rx, Rz));
}
