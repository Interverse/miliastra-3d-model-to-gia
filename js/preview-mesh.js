// Shared preview-geometry builder: reconstructs display triangles from
// decoration records (the same math the game engine applies). Used by the
// conversion worker AND by the main thread when edit mode modifies a
// reconstruction. Also returns an owners array (decoration index per
// triangle) so viewport picking can map a clicked face back to its
// decoration.

export function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

const SEG = 12;
const SPH_LAT = 6, SPH_LON = 10;

export function triCountFor(kind) {
  switch (kind) {
    case 'square': case 'plane': return 12;
    case 'sphere': return SPH_LAT * SPH_LON * 2;
    case 'cylinder': return SEG * 4;
    case 'cone': return SEG * 2;
    case 'prism': return 8;
    default: return 1; // triangle
  }
}

export function buildPreview(decorations, params) {
  const RADIANS = Math.PI / 180;
  let triCount = 0;
  for (const d of decorations) triCount += triCountFor(d.kind);
  const positions = new Float32Array(triCount * 9);
  const colors = new Float32Array(triCount * 9);
  const owners = new Int32Array(triCount);
  const flip = params.flipZ ? -1 : 1;
  let o = 0, co = 0, tri = 0;

  for (let di = 0; di < decorations.length; di++) {
    const d = decorations[di];
    const P = [d.position.x / 10, d.position.y / 10, d.position.z / 10];
    const m = eulerToMat(d.rotationDeg.x * RADIANS, d.rotationDeg.y * RADIANS, d.rotationDeg.z * RADIANS, params.eulerOrder);
    const r = srgbToLinear((d.color >> 16) & 255);
    const g = srgbToLinear((d.color >> 8) & 255);
    const b = srgbToLinear(d.color & 255);
    const xf = (lx, ly, lz) => [
      P[0] + m[0][0] * lx + m[0][1] * ly + m[0][2] * lz,
      P[1] + m[1][0] * lx + m[1][1] * ly + m[1][2] * lz,
      P[2] + m[2][0] * lx + m[2][1] * ly + m[2][2] * lz,
    ];
    const pushTri = (a, bq, c) => {
      for (const v of [a, bq, c]) {
        // display mirrors X back (decoration space is X-mirrored vs display)
        positions[o++] = -v[0]; positions[o++] = v[1]; positions[o++] = v[2] * flip;
      }
      for (let k = 0; k < 3; k++) { colors[co++] = r; colors[co++] = g; colors[co++] = b; }
      owners[tri++] = di;
    };
    const pushQuad = (a, bq, c, dq) => { pushTri(a, bq, c); pushTri(a, c, dq); };
    const box = (hx, hy, hz) => {
      const c = [];
      for (let i = 0; i < 8; i++) {
        c.push(xf((i & 1 ? 1 : -1) * hx, (i & 2 ? 1 : -1) * hy, (i & 4 ? 1 : -1) * hz));
      }
      for (const [a, bq, cq, dq] of [
        [0, 1, 3, 2], [5, 4, 6, 7], [4, 0, 2, 6], [1, 5, 7, 3], [4, 5, 1, 0], [2, 3, 7, 6],
      ]) pushQuad(c[a], c[bq], c[cq], c[dq]);
    };

    switch (d.kind) {
      case 'square':
        box(d.scale.x * 0.05, d.scale.y * 0.05, d.scale.z * 0.05);
        break;
      case 'plane':
        box(d.scale.x * 0.05, 0.002, d.scale.z * 0.05);
        break;
      case 'sphere': {
        const rx = d.scale.x * 0.05, ry = d.scale.y * 0.05, rz = d.scale.z * 0.05;
        const pt = (la, lo) => {
          const th = la / SPH_LAT * Math.PI, ph = lo / SPH_LON * 2 * Math.PI;
          return xf(rx * Math.sin(th) * Math.cos(ph), ry * Math.cos(th), rz * Math.sin(th) * Math.sin(ph));
        };
        for (let la = 0; la < SPH_LAT; la++) {
          for (let lo = 0; lo < SPH_LON; lo++) {
            pushQuad(pt(la, lo), pt(la, lo + 1), pt(la + 1, lo + 1), pt(la + 1, lo));
          }
        }
        break;
      }
      case 'cylinder': {
        const rx = d.scale.x * 0.05, rz = d.scale.z * 0.05, hy = d.scale.y * 0.05;
        const ring = (y) => {
          const pts = [];
          for (let i = 0; i < SEG; i++) {
            const a = i / SEG * 2 * Math.PI;
            pts.push(xf(rx * Math.cos(a), y, rz * Math.sin(a)));
          }
          return pts;
        };
        const top = ring(hy), bot = ring(-hy);
        const cT = xf(0, hy, 0), cB = xf(0, -hy, 0);
        for (let i = 0; i < SEG; i++) {
          const j = (i + 1) % SEG;
          pushQuad(bot[i], bot[j], top[j], top[i]);
          pushTri(cT, top[i], top[j]);
          pushTri(cB, bot[j], bot[i]);
        }
        break;
      }
      case 'cone': {
        const rx = d.scale.x * 0.05, rz = d.scale.z * 0.05, hy = d.scale.y * 0.05;
        const apex = xf(0, hy, 0), cB = xf(0, -hy, 0);
        const bot = [];
        for (let i = 0; i < SEG; i++) {
          const a = i / SEG * 2 * Math.PI;
          bot.push(xf(rx * Math.cos(a), -hy, rz * Math.sin(a)));
        }
        for (let i = 0; i < SEG; i++) {
          const j = (i + 1) % SEG;
          pushTri(apex, bot[j], bot[i]);
          pushTri(cB, bot[i], bot[j]);
        }
        break;
      }
      case 'prism': {
        const side = d.scale.x * 0.075, hy = d.scale.y * 0.05;
        const R = side / Math.sqrt(3);
        const corners = [];
        for (let i = 0; i < 3; i++) {
          // -PI/2 start: the in-game prism faces the opposite way (180° on Y)
          const a = i / 3 * 2 * Math.PI - Math.PI / 2;
          corners.push([R * Math.cos(a), R * Math.sin(a)]);
        }
        const top = corners.map(([x, z]) => xf(x, hy, z));
        const bot = corners.map(([x, z]) => xf(x, -hy, z));
        pushTri(top[0], top[1], top[2]);
        pushTri(bot[2], bot[1], bot[0]);
        for (let i = 0; i < 3; i++) {
          const j = (i + 1) % 3;
          pushQuad(bot[i], bot[j], top[j], top[i]);
        }
        break;
      }
      default: {
        // calibrated legs: exactly 0.13 m / 0.27 m per zoom unit
        const a = d.scale.y * 0.13, bb = d.scale.z * 0.27;
        pushTri(xf(0, 0, 0), xf(0, a, 0), xf(0, 0, -bb));
      }
    }
  }
  return { positions, colors, owners };
}

export function eulerToMat(x, y, z, order) {
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
