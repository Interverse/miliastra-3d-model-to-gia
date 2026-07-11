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
import { gridFromTexture, optimizeRects, exactNonoverlapRects } from './rect-optimizer.js';

// texture: { width, height, data: Uint8ClampedArray RGBA } (row 0 = image top)
// opts: { pixelSize (m/pixel), thickness (m), alphaCutoff (0..1),
//         overdraw (bool) }
//
// overdraw = the miliastra-image-to-gia optimizer (rect-optimizer.js):
// a portfolio of overdraw strategies (validated pairwise merging,
// component underpainting with beam search, two-stage merging) produces a
// rectangle plan in an exact back-to-front paint order that reproduces the
// image pixel-for-pixel while using far fewer shapes than an exact
// partition. In 3D the paint order maps to MINIMAL thickness levels: a
// rect painted over another gets a slightly thicker box, so its faces
// render in front on both sides — same appearance, no z-fighting (each
// level sits on its own plane).

// layer constants (meters)
const LEVEL_STEP = 0.0005; // thickness increase per depth level (per side) —
                           // one full in-game zoom quantum (0.01 = 1 mm total)
const SIDE_STEP = 0.001;   // in-plane adjustment per SIDE — a full zoom
                           // quantum, so each side can move independently
                           // and the total size stays quantization-safe

// In-plane overlap rules (all decisions derive from the final occupancy
// grid and the final rect set, so the result is order-independent):
//
// - Interior-facing sides never move: every interior side sits exactly on
//   its pixel grid line, and interior pixels get no in-plane adjustment at
//   all. Seams don't need inflation: abutting boxes are always on
//   different thickness levels, so at every shared boundary the thicker
//   front face overlaps the seam in depth and the boundary renders
//   watertight.
//
// - The remaining hazard is walls of different-color boxes sharing the
//   same grid plane with visibly overlapping regions — above all overdraw
//   paint stacks whose boxes END on the same silhouette line (underpaint +
//   foreground rects sharing an outline segment). Every wall therefore
//   gets a SLOT per (line, direction): conflicting walls take different
//   slots and move OUTWARD (in their facing direction) by one SIDE_STEP
//   per slot. The largest wall keeps slot 0 — the exact outline — and each
//   nested border-pixel wall pokes slightly out, so the boxes overlap the
//   shared boundary completely and the outermost wall carries the border
//   pixels' true color at the rim.
//
// - Conflicts use exact effective geometry, iterated to a fixed point: a
//   moved side extends its box's perpendicular wall spans past the
//   outline, and those 1 mm tips must not land on another wall's plane
//   either. Two walls conflict only where the shared region is actually
//   exposed (an empty pixel across the line); buried interior overlaps
//   render identically no matter which face wins, so they stay put.
//
// Outsets are capped at a quarter pixel, so they can never reach an empty
// pixel's center or cross to another grid line; exact (non-overdraw)
// partitions have no overlapping walls and come out with zero in-plane
// adjustment everywhere.

// Returns { boxes: [{ center:{x,y,z}, size:{x,y,z}, color:[r,g,b] }],
//           pixels: <opaque pixel count> }
export function spriteToBoxes(texture, opts = {}) {
  const { width: w, height: h } = texture;
  const px = opts.pixelSize ?? 0.1;
  const th = Math.max(1e-4, opts.thickness ?? 0.1);

  const grid = gridFromTexture(texture, opts.alphaCutoff ?? 0.5);
  let pixels = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (grid.rows[y][x] !== 0) pixels++;

  const offX = (-w * px) / 2;

  // exact non-overlapping cover, or the ported miliastra safe-overdraw
  // optimizer (rects in validated back-to-front paint order: painting them
  // in that order reproduces the image exactly)
  const rects = opts.overdraw
    ? optimizeRects(grid, 'safe-overdraw')
    : exactNonoverlapRects(grid).rects;

  const occ = (x, y) => x >= 0 && y >= 0 && x < w && y < h && grid.rows[y][x] !== 0;
  const step = Math.min(SIDE_STEP, px * 0.25); // never reach a pixel center

  // wall descriptor per rect and direction: line = the grid line the wall
  // sits on, [lo, hi) = span in perpendicular grid cells, beyond = the
  // row/col of pixels just across the line
  const dirs = [['x', 0], ['x', 1], ['y', 0], ['y', 1]];
  const walls = rects.map((r) => dirs.map(([ax, end]) => {
    const line = ax === 'x' ? r.x + (end ? r.w : 0) : r.y + (end ? r.h : 0);
    return {
      ax, line,
      beyond: end ? line : line - 1,
      lo: ax === 'x' ? r.y : r.x,
      hi: ax === 'x' ? r.y + r.h : r.x + r.w,
    };
  }));
  const occBeyond = (wl, t) => wl.ax === 'x' ? occ(wl.beyond, t) : occ(t, wl.beyond);

  // per-direction groups of walls on the same line, in fixed greedy order:
  // largest grid span first (the outline owner keeps slot 0 = the exact
  // line), then paint order
  const groups = dirs.map((_, d) => {
    const byLine = new Map();
    for (let i = 0; i < rects.length; i++) {
      const a = byLine.get(walls[i][d].line);
      a ? a.push(i) : byLine.set(walls[i][d].line, [i]);
    }
    for (const list of byLine.values()) {
      list.sort((p, q) =>
        (walls[q][d].hi - walls[q][d].lo) - (walls[p][d].hi - walls[p][d].lo) || p - q);
    }
    return byLine;
  });

  // Iterative slot assignment. A side's outset extends the box's
  // perpendicular wall spans, which can create new same-plane overlaps
  // (1 mm tips past a corner), so conflicts are re-derived from the
  // effective spans until nothing new appears. Conflicts accumulate, so
  // the loop is monotone and converges in a few rounds.
  const slots = rects.map(() => [0, 0, 0, 0]);
  const perp = (d) => (d < 2 ? [2, 3] : [0, 1]); // span ends -> side indices
  const extOf = (i, d, e) => Math.min(slots[i][perp(d)[e]] * step, px * 0.25);
  const wallConflicts = new Set(); // "d:line:i:j" with i, j in group order
  for (let round = 0; round < 8; round++) {
    let grew = false;
    dirs.forEach((_, d) => {
      for (const [line, list] of groups[d]) {
        for (let u = 0; u < list.length; u++) {
          for (let v = u + 1; v < list.length; v++) {
            const i = list[u], j = list[v];
            const key = `${d}:${line}:${i}:${j}`;
            if (wallConflicts.has(key) || rects[i].color === rects[j].color) continue;
            const A = walls[i][d], B = walls[j][d];
            const aLo = A.lo * px - extOf(i, d, 0), aHi = A.hi * px + extOf(i, d, 1);
            const bLo = B.lo * px - extOf(j, d, 0), bHi = B.hi * px + extOf(j, d, 1);
            const oLo = Math.max(aLo, bLo), oHi = Math.min(aHi, bHi);
            if (oHi - oLo <= 1e-9) continue; // no positive-area overlap
            // exposed anywhere along the shared region? (an empty pixel
            // across the line; buried overlaps render identically)
            const tLo = Math.floor(oLo / px + 1e-9), tHi = Math.ceil(oHi / px - 1e-9);
            let exposed = false;
            for (let t = tLo; t < tHi; t++) {
              if (!occBeyond(A, t)) { exposed = true; break; }
            }
            if (!exposed) continue;
            wallConflicts.add(key);
            grew = true;
          }
        }
      }
    });
    if (!grew) break;
    // reassign every slot from the accumulated conflict set
    dirs.forEach((_, d) => {
      for (const [line, list] of groups[d]) {
        for (let u = 0; u < list.length; u++) {
          const taken = new Set();
          for (let v = 0; v < u; v++) {
            const key = `${d}:${line}:${list[u]}:${list[v]}`;
            const key2 = `${d}:${line}:${list[v]}:${list[u]}`;
            if (wallConflicts.has(key) || wallConflicts.has(key2)) taken.add(slots[list[v]][d]);
          }
          let s = 0;
          while (taken.has(s)) s++;
          slots[list[u]][d] = s;
        }
      }
    });
  }

  // outward delta per rect side (in the wall's facing direction): slot 0 =
  // the exact grid line; conflicting walls step outward one SIDE_STEP per
  // slot. Interior-side outsets end up buried inside the neighbor's volume.
  const delta = (i, d) => Math.min(slots[i][d] * step, px * 0.25);

  // world coords: pixel row y spans Y [(h-1-y)*px, (h-y)*px]; grid-low Y is
  // the world TOP, so its outward delta raises the center
  const toBox = (r, i, thickness) => {
    const dxl = delta(i, 0), dxh = delta(i, 1);
    const dyl = delta(i, 2), dyh = delta(i, 3);
    return {
      center: {
        x: offX + (r.x + r.w / 2) * px + (dxh - dxl) / 2,
        y: (h - r.y - r.h / 2) * px + (dyl - dyh) / 2,
        z: 0,
      },
      size: { x: r.w * px + dxl + dxh, y: r.h * px + dyl + dyh, z: thickness },
      color: [(r.color >> 16) & 255, (r.color >> 8) & 255, r.color & 255],
    };
  };

  // Depth levels (conflict-aware, minimal): boxes that overlap or touch
  // (possibly via a border expansion) would share coplanar front/back
  // faces on the same level, so every conflicting pair sits on different
  // levels — which also closes abutting seams, since the thicker face
  // overlaps the seam in depth. Genuinely overlapping pairs additionally
  // keep paint order: the rect painted on top must be STRICTLY thicker so
  // its faces render in front on both sides. Each rect takes the smallest
  // level satisfying both — adjacent runs alternate 0/1 instead of
  // cascading, keeping total thickness growth to a few mm.
  const conflicts = (a, b) => // steps < ½ px ⇒ only touching rects can meet
    a.x + a.w >= b.x && b.x + b.w >= a.x && a.y + a.h >= b.y && b.y + b.h >= a.y;
  const overlaps = (a, b) => // original rects genuinely overlap
    a.x + a.w > b.x && b.x + b.w > a.x && a.y + a.h > b.y && b.y + b.h > a.y;
  const levels = new Array(rects.length).fill(0);
  for (let i = 0; i < rects.length; i++) {
    let min = 0;
    const taken = new Set();
    for (let j = 0; j < i; j++) {
      if (!conflicts(rects[i], rects[j])) continue;
      if (overlaps(rects[i], rects[j])) min = Math.max(min, levels[j] + 1);
      else taken.add(levels[j]);
    }
    let lv = min;
    while (taken.has(lv)) lv++;
    levels[i] = lv;
  }

  const boxes = rects.map((r, i) => toBox(r, i, th + 2 * levels[i] * LEVEL_STEP));
  return { boxes, pixels };
}

export function spriteToTriangles(texture, opts = {}) {
  const { width: w, height: h, data } = texture;
  const px = opts.pixelSize ?? 0.1;
  const th = Math.max(1e-4, opts.thickness ?? 0.1);
  const cutoff = Math.round((opts.alphaCutoff ?? 0.5) * 255);

  const alphaAt = (x, y) =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : data[(y * w + x) * 4 + 3];
  const solid = (x, y) => alphaAt(x, y) >= Math.max(1, cutoff);
  const colorAt = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const sameColor = (x1, x2, y) => {
    const a = colorAt(x1, y),
      b = colorAt(x2, y);
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  };

  // world coords: pixel (x, y) spans X [x*px, (x+1)*px], Y [(h-1-y)*px, (h-y)*px]
  // (centered on X at the end via offset)
  const offX = (-w * px) / 2;
  const zf = th / 2,
    zb = -th / 2;
  const tris = [];
  const quad = (a, b, c, d, color) => {
    // a,b,c,d counter-clockwise as seen from the face normal
    tris.push({ p: [a, b, c], color, uv: null });
    tris.push({ p: [a, c, d], color, uv: null });
  };
  const P = (x, y, z) => ({ x: x * px + offX, y: y * px, z });

  for (let y = 0; y < h; y++) {
    const wy0 = h - 1 - y,
      wy1 = h - y; // world Y range (pixel rows count down)
    let x = 0;
    while (x < w) {
      if (!solid(x, y)) {
        x++;
        continue;
      }
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
          quad(
            P(xi, wy1, zf),
            P(xi + 1, wy1, zf),
            P(xi + 1, wy1, zb),
            P(xi, wy1, zb),
            color,
          );
        }
        if (!solid(xi, y + 1)) {
          // bottom (-Y)
          quad(
            P(xi + 1, wy0, zf),
            P(xi, wy0, zf),
            P(xi, wy0, zb),
            P(xi + 1, wy0, zb),
            color,
          );
        }
      }
      if (!solid(x - 1, y)) {
        // left wall (-X)
        quad(P(x, wy0, zb), P(x, wy0, zf), P(x, wy1, zf), P(x, wy1, zb), color);
      }
      if (!solid(x2, y)) {
        // right wall (+X)
        quad(
          P(x2, wy0, zf),
          P(x2, wy0, zb),
          P(x2, wy1, zb),
          P(x2, wy1, zf),
          color,
        );
      }
      x = x2;
    }
  }
  return tris;
}
