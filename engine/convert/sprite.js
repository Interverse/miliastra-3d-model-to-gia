// 2D sprite -> extruded 3D volume.
//
// spriteToBoxes (primary): greedy-meshes opaque pixels into maximal
// same-color rectangles and emits ONE box per rectangle — the square
// decoration primitive is a unit cube, so a single elongated square covers
// the front face, back face, and all edges at once (huge decoration-count
// savings vs. per-face geometry).
//
// spriteToTriangles (legacy): face + wall triangle soup; kept for reuse.
//
// Output space (source/display convention): X right, Y up, Z toward the
// viewer; the sprite plane is XY, extruded symmetrically along Z. The normal
// conversion pipeline (flipZ etc.) applies afterwards.
//
// texture: { width, height, data: Uint8ClampedArray RGBA } (row 0 = image top)
// opts: { pixelSize (m/pixel), thickness (m), alphaCutoff (0..1) }

// Returns { boxes: [{ center:{x,y,z}, size:{x,y,z}, color:[r,g,b] }],
//           pixels: <opaque pixel count> }
export function spriteToBoxes(texture, opts = {}) {
  const { width: w, height: h, data } = texture;
  const px = opts.pixelSize ?? 0.1;
  const th = Math.max(1e-4, opts.thickness ?? 0.1);
  const cutoff = Math.max(1, Math.round((opts.alphaCutoff ?? 0.5) * 255));

  // collect opaque cells keyed by color
  const cells = new Map(); // "x,y" -> colorInt
  let pixels = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < cutoff) continue;
      pixels++;
      cells.set(x + ',' + y, (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
  }

  const offX = -w * px / 2;
  const boxes = [];
  // greedy meshing: grow runs rightward, then downward while rows match
  const remaining = new Set(cells.keys());
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k0 = x + ',' + y;
      if (!remaining.has(k0)) continue;
      const color = cells.get(k0);
      let x1 = x;
      while (x1 + 1 < w) {
        const k = (x1 + 1) + ',' + y;
        if (!remaining.has(k) || cells.get(k) !== color) break;
        x1++;
      }
      let y1 = y;
      outer: while (y1 + 1 < h) {
        for (let xi = x; xi <= x1; xi++) {
          const k = xi + ',' + (y1 + 1);
          if (!remaining.has(k) || cells.get(k) !== color) break outer;
        }
        y1++;
      }
      for (let yi = y; yi <= y1; yi++)
        for (let xi = x; xi <= x1; xi++) remaining.delete(xi + ',' + yi);

      // world coords: pixel row y spans Y [(h-1-y)*px, (h-y)*px]
      const cx = offX + (x + x1 + 1) / 2 * px;
      const cy = ((h - y) + (h - 1 - y1)) / 2 * px;
      boxes.push({
        center: { x: cx, y: cy, z: 0 },
        size: { x: (x1 - x + 1) * px, y: (y1 - y + 1) * px, z: th },
        color: [(color >> 16) & 255, (color >> 8) & 255, color & 255],
      });
    }
  }
  return { boxes, pixels };
}

export function spriteToTriangles(texture, opts = {}) {
  const { width: w, height: h, data } = texture;
  const px = opts.pixelSize ?? 0.1;
  const th = Math.max(1e-4, opts.thickness ?? 0.1);
  const cutoff = Math.round((opts.alphaCutoff ?? 0.5) * 255);

  const alphaAt = (x, y) =>
    (x < 0 || y < 0 || x >= w || y >= h) ? 0 : data[(y * w + x) * 4 + 3];
  const solid = (x, y) => alphaAt(x, y) >= Math.max(1, cutoff);
  const colorAt = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const sameColor = (x1, x2, y) => {
    const a = colorAt(x1, y), b = colorAt(x2, y);
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  };

  // world coords: pixel (x, y) spans X [x*px, (x+1)*px], Y [(h-1-y)*px, (h-y)*px]
  // (centered on X at the end via offset)
  const offX = -w * px / 2;
  const zf = th / 2, zb = -th / 2;
  const tris = [];
  const quad = (a, b, c, d, color) => {
    // a,b,c,d counter-clockwise as seen from the face normal
    tris.push({ p: [a, b, c], color, uv: null });
    tris.push({ p: [a, c, d], color, uv: null });
  };
  const P = (x, y, z) => ({ x: x * px + offX, y: y * px, z });

  for (let y = 0; y < h; y++) {
    const wy0 = h - 1 - y, wy1 = h - y; // world Y range (pixel rows count down)
    let x = 0;
    while (x < w) {
      if (!solid(x, y)) { x++; continue; }
      // horizontal run of same color
      let x2 = x + 1;
      while (x2 < w && solid(x2, y) && sameColor(x, x2, y)) x2++;
      const color = colorAt(x, y);
      // front face (+Z): CCW seen from +Z
      quad(P(x, wy0, zf), P(x2, wy0, zf), P(x2, wy1, zf), P(x, wy1, zf), color);
      // back face (-Z): CCW seen from -Z
      quad(P(x2, wy0, zb), P(x, wy0, zb), P(x, wy1, zb), P(x2, wy1, zb), color);
      // walls where neighbors are transparent
      // top (+Y) neighbors: pixel row y-1
      for (let xi = x; xi < x2; xi++) {
        if (!solid(xi, y - 1)) {
          quad(P(xi, wy1, zf), P(xi + 1, wy1, zf), P(xi + 1, wy1, zb), P(xi, wy1, zb), color);
        }
        if (!solid(xi, y + 1)) { // bottom (-Y)
          quad(P(xi + 1, wy0, zf), P(xi, wy0, zf), P(xi, wy0, zb), P(xi + 1, wy0, zb), color);
        }
      }
      if (!solid(x - 1, y)) { // left wall (-X)
        quad(P(x, wy0, zb), P(x, wy0, zf), P(x, wy1, zf), P(x, wy1, zb), color);
      }
      if (!solid(x2, y)) { // right wall (+X)
        quad(P(x2, wy0, zf), P(x2, wy0, zb), P(x2, wy1, zb), P(x2, wy1, zf), color);
      }
      x = x2;
    }
  }
  return tris;
}
