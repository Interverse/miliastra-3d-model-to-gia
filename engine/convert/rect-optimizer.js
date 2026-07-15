// Rectangle-plan optimizer for pixel images — direct port of the
// miliastra-image-to-gia optimizer (src/lib/optimizer.ts), which reduces
// shape counts far below plain greedy meshing while reproducing the image
// EXACTLY via painter's-order overdraw:
//
// - exact non-overlapping cover (best-area rectangle expansion)
// - heap-driven pairwise merging of same-color rects into their bounding
//   box (overdrawing other colors), each merge validated by re-rendering
//   the affected region against the target
// - per-component "underpaint" (paint a component's whole bbox in its
//   color, then correction rects on top), candidates selected greedily or
//   by beam search
// - a portfolio runner ("safe-overdraw") that tries all strategies within
//   a time budget and keeps the smallest plan
// - back-to-front ordering + full-image validation, with exact-cover
//   fallback if ordering ever fails
//
// Grid: { width, height, rows: Uint32Array[] } with 0 = transparent,
// otherwise 0xAARRGGBB (alpha included so distinct alphas stay distinct).

export const DEFAULT_OPTIMIZER_CONFIG = {
  maxMergePasses: 200,
  maxOverdrawRatio: 2.5,
  safeTimeSeconds: 10,
  underpaintMaxBBoxRatio: 6,
  underpaintMinComponentPixels: 8,
  underpaintMinSavings: 2,
  underpaintBeamWidth: 64,
  underpaintBeamCandidates: 256,
  stage1Passes: 1200,
  stage1Ratio: 3,
  stage2Passes: 2000,
  stage2Ratio: 10,
};

const nowMs = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export function makeGrid(width, height) {
  return {
    width,
    height,
    rows: Array.from({ length: height }, () => new Uint32Array(width)),
  };
}

// texture {width,height,data RGBA} -> grid; pixels below cutoff are
// transparent, opaque pixels normalize alpha to 255 (the medium has no
// partial transparency, so equal-RGB pixels must merge)
export function gridFromTexture(texture, alphaCutoff = 0.5) {
  const { width, height, data } = texture;
  const cutoff = Math.max(1, Math.round(alphaCutoff * 255));
  const grid = makeGrid(width, height);
  for (let y = 0; y < height; y++) {
    const row = grid.rows[y];
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < cutoff) continue;
      row[x] =
        ((0xff << 24) | ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8) | (data[i + 2] & 0xff)) >>> 0;
    }
  }
  return grid;
}

function subGridWithRemovedColor(grid, bbox, removeColor) {
  const width = bbox.x1 - bbox.x0;
  const height = bbox.y1 - bbox.y0;
  const out = makeGrid(width, height);
  for (let y = bbox.y0; y < bbox.y1; y++) {
    const outRow = out.rows[y - bbox.y0];
    const srcRow = grid.rows[y];
    for (let x = bbox.x0; x < bbox.x1; x++) {
      const color = srcRow[x];
      outRow[x - bbox.x0] = color !== 0 && color !== removeColor ? color : 0;
    }
  }
  return out;
}

const offsetRects = (rects, dx, dy) =>
  rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
const rectArea = (r) => r.w * r.h;
const rectBBox = (a, b) => ({
  x0: Math.min(a.x, b.x),
  y0: Math.min(a.y, b.y),
  x1: Math.max(a.x + a.w, b.x + b.w),
  y1: Math.max(a.y + a.h, b.y + b.h),
});
const rectIntersectsBBox = (rect, bbox) =>
  !(rect.x + rect.w <= bbox.x0 || rect.x >= bbox.x1 ||
    rect.y + rect.h <= bbox.y0 || rect.y >= bbox.y1);
const bboxesOverlap = (a, b) =>
  !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0);

function buildTransparencyPrefix(grid) {
  const prefix = Array.from({ length: grid.height + 1 }, () =>
    new Array(grid.width + 1).fill(0));
  for (let y = 0; y < grid.height; y++) {
    let rowSum = 0;
    for (let x = 0; x < grid.width; x++) {
      rowSum += grid.rows[y][x] === 0 ? 1 : 0;
      prefix[y + 1][x + 1] = prefix[y][x + 1] + rowSum;
    }
  }
  return prefix;
}

const bboxHasTransparencyFast = (prefix, bbox) =>
  prefix[bbox.y1][bbox.x1] - prefix[bbox.y0][bbox.x1] -
    prefix[bbox.y1][bbox.x0] + prefix[bbox.y0][bbox.x0] > 0;

export function exactNonoverlapRects(grid) {
  const used = Array.from({ length: grid.height }, () => new Uint8Array(grid.width));
  const rects = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (used[y][x]) continue;
      const color = grid.rows[y][x];
      if (color === 0) { used[y][x] = 1; continue; }

      const widths = [];
      let yy = y;
      while (yy < grid.height && !used[yy][x] && grid.rows[yy][x] === color) {
        let runW = 0;
        while (x + runW < grid.width && !used[yy][x + runW] && grid.rows[yy][x + runW] === color) {
          runW += 1;
        }
        widths.push(runW);
        yy += 1;
      }

      let bestW = 1, bestH = 1, bestArea = 1;
      let minW = null;
      for (let i = 0; i < widths.length; i++) {
        const rowW = widths[i];
        minW = minW == null ? rowW : Math.min(minW, rowW);
        const h = i + 1;
        const area = minW * h;
        if (area > bestArea || (area === bestArea && (h > bestH || (h === bestH && minW > bestW)))) {
          bestArea = area;
          bestW = minW;
          bestH = h;
        }
      }
      for (let yy2 = y; yy2 < y + bestH; yy2++)
        for (let xx2 = x; xx2 < x + bestW; xx2++) used[yy2][xx2] = 1;
      rects.push({ x, y, w: bestW, h: bestH, color });
    }
  }
  return { rects, width: grid.width, height: grid.height };
}

export function greedyMeshingRects(grid) {
  const covered = Array.from({ length: grid.height }, () => new Uint8Array(grid.width));
  const rects = [];
  for (let y = 0; y < grid.height; y++) {
    let x = 0;
    while (x < grid.width) {
      const color = grid.rows[y][x];
      if (color === 0 || covered[y][x]) { x += 1; continue; }
      let w = 1;
      while (x + w < grid.width) {
        const c = grid.rows[y][x + w];
        if (c === 0 || covered[y][x + w] || c !== color) break;
        w += 1;
      }
      let h = 1;
      while (y + h < grid.height) {
        let ok = true;
        for (let xx = x; xx < x + w; xx++) {
          const c = grid.rows[y + h][xx];
          if (c === 0 || covered[y + h][xx] || c !== color) { ok = false; break; }
        }
        if (!ok) break;
        h += 1;
      }
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++) covered[yy][xx] = 1;
      rects.push({ x, y, w, h, color });
      x += w;
    }
  }
  return { rects, width: grid.width, height: grid.height };
}

function renderBBox(rects, bbox) {
  const bw = bbox.x1 - bbox.x0;
  const bh = bbox.y1 - bbox.y0;
  const canvas = Array.from({ length: bh }, () => new Uint32Array(bw));
  for (const rect of rects) {
    const ox0 = Math.max(bbox.x0, rect.x);
    const oy0 = Math.max(bbox.y0, rect.y);
    const ox1 = Math.min(bbox.x1, rect.x + rect.w);
    const oy1 = Math.min(bbox.y1, rect.y + rect.h);
    if (ox0 >= ox1 || oy0 >= oy1) continue;
    for (let y = oy0; y < oy1; y++) {
      const row = canvas[y - bbox.y0];
      for (let x = ox0; x < ox1; x++) row[x - bbox.x0] = rect.color;
    }
  }
  return canvas;
}

function targetBBox(grid, bbox) {
  const out = [];
  for (let y = bbox.y0; y < bbox.y1; y++) out.push(grid.rows[y].slice(bbox.x0, bbox.x1));
  return out;
}

function gridsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y++) {
    if (a[y].length !== b[y].length) return false;
    for (let x = 0; x < a[y].length; x++) if (a[y][x] !== b[y][x]) return false;
  }
  return true;
}

const candidatePreservesBBox = (rects, grid, bbox) =>
  gridsEqual(renderBBox(rects, bbox), targetBBox(grid, bbox));

class MinHeap {
  constructor(less) {
    this.data = [];
    this.less = less;
  }
  get length() { return this.data.length; }
  push(item) {
    const data = this.data;
    data.push(item);
    let i = data.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(data[i], data[p])) break;
      [data[i], data[p]] = [data[p], data[i]];
      i = p;
    }
  }
  pop() {
    const data = this.data;
    if (data.length === 0) return undefined;
    const root = data[0];
    const last = data.pop();
    if (data.length > 0) {
      data[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < data.length && this.less(data[l], data[best])) best = l;
        if (r < data.length && this.less(data[r], data[best])) best = r;
        if (best === i) break;
        [data[i], data[best]] = [data[best], data[i]];
        i = best;
      }
    }
    return root;
  }
}

function fastMergeOverdrawFromSeed(grid, seedRects, maxPasses = 200, maxOverdrawRatio = 2.5) {
  const prefix = buildTransparencyPrefix(grid);
  const rectsById = new Map();
  seedRects.forEach((r, i) => rectsById.set(i, r));
  const active = new Set(rectsById.keys());
  let order = Array.from(active);
  let nextId = seedRects.length;
  let counter = 0;

  const heap = new MinHeap((a, b) => {
    if (a.extraArea !== b.extraArea) return a.extraArea < b.extraArea;
    if (a.negMergedArea !== b.negMergedArea) return a.negMergedArea < b.negMergedArea;
    return a.counter < b.counter;
  });

  function pushCandidate(i, j) {
    if (i === j || !active.has(i) || !active.has(j)) return;
    const a = rectsById.get(i);
    const b = rectsById.get(j);
    if (a.color !== b.color) return;
    const bbox = rectBBox(a, b);
    if (bboxHasTransparencyFast(prefix, bbox)) return;
    const mergedArea = (bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0);
    const oldArea = rectArea(a) + rectArea(b);
    if (maxOverdrawRatio != null && mergedArea > oldArea * maxOverdrawRatio) return;
    counter += 1;
    heap.push({ extraArea: mergedArea - oldArea, negMergedArea: -mergedArea, counter, i, j });
  }

  const byColor = new Map();
  for (const [id, rect] of rectsById) {
    if (!byColor.has(rect.color)) byColor.set(rect.color, []);
    byColor.get(rect.color).push(id);
  }
  for (const ids of byColor.values()) {
    for (let a = 0; a < ids.length; a++)
      for (let b = a + 1; b < ids.length; b++) pushCandidate(ids[a], ids[b]);
  }

  let accepted = 0;
  while (heap.length && accepted < maxPasses) {
    const cand = heap.pop();
    const { i, j } = cand;
    if (!active.has(i) || !active.has(j)) continue;
    const a = rectsById.get(i);
    const b = rectsById.get(j);
    if (a.color !== b.color) continue;
    const bbox = rectBBox(a, b);
    if (bboxHasTransparencyFast(prefix, bbox)) continue;
    const merged = {
      x: bbox.x0,
      y: bbox.y0,
      w: bbox.x1 - bbox.x0,
      h: bbox.y1 - bbox.y0,
      color: a.color,
    };
    const oldArea = rectArea(a) + rectArea(b);
    const newArea = rectArea(merged);
    if (maxOverdrawRatio != null && newArea > oldArea * maxOverdrawRatio) continue;

    const candidateOrder = order.filter((rid) => rid !== i && rid !== j);
    const intersections = [];
    for (let pos = 0; pos < candidateOrder.length; pos++) {
      const rid = candidateOrder[pos];
      if (rectIntersectsBBox(rectsById.get(rid), bbox)) intersections.push(pos);
    }
    const insertAt = intersections.length ? Math.min(...intersections) : 0;
    const mergedId = nextId;
    rectsById.set(mergedId, merged);
    candidateOrder.splice(insertAt, 0, mergedId);
    const candidateRects = candidateOrder.map((rid) => rectsById.get(rid));
    if (!candidatePreservesBBox(candidateRects, grid, bbox)) {
      rectsById.delete(mergedId);
      continue;
    }

    nextId += 1;
    active.delete(i);
    active.delete(j);
    active.add(mergedId);
    order = candidateOrder;
    accepted += 1;
    for (const rid of Array.from(active))
      if (rid !== mergedId && rectsById.get(rid).color === merged.color)
        pushCandidate(mergedId, rid);
  }

  return {
    rects: order.map((rid) => rectsById.get(rid)),
    width: grid.width,
    height: grid.height,
  };
}

const fastMergeOverdrawRects = (grid, maxPasses = 200, maxOverdrawRatio = 2.5) =>
  fastMergeOverdrawFromSeed(grid, exactNonoverlapRects(grid).rects, maxPasses, maxOverdrawRatio);

function colorComponents(grid) {
  const visited = Array.from({ length: grid.height }, () => new Uint8Array(grid.width));
  const comps = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (visited[y][x]) continue;
      const color = grid.rows[y][x];
      visited[y][x] = 1;
      if (color === 0) continue;
      const stack = [[x, y]];
      let count = 0;
      let minX = x, maxX = x, minY = y, maxY = y;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        count += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
          if (nx < 0 || nx >= grid.width || ny < 0 || ny >= grid.height || visited[ny][nx]) continue;
          if (grid.rows[ny][nx] === color) {
            visited[ny][nx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      comps.push({ color, count, bbox: { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 } });
    }
  }
  return comps;
}

function collectUnderpaintCandidates(grid, maxBBoxRatio = 6.0, minComponentPixels = 8, minSavings = 2) {
  const prefix = buildTransparencyPrefix(grid);
  const comps = colorComponents(grid);
  const candidates = [];
  for (const { color, count, bbox } of comps) {
    const bw = bbox.x1 - bbox.x0;
    const bh = bbox.y1 - bbox.y0;
    const area = bw * bh;
    if (count < minComponentPixels || area <= 1 || area / Math.max(count, 1) > maxBBoxRatio) continue;
    if (bboxHasTransparencyFast(prefix, bbox)) continue;

    const patchFull = subGridWithRemovedColor(grid, bbox);
    const baseline = greedyMeshingRects(patchFull).rects.length;
    const patchResidual = subGridWithRemovedColor(grid, bbox, color);
    const corrections = greedyMeshingRects(patchResidual).rects;
    const underpaintN = 1 + corrections.length;
    const savings = baseline - underpaintN;
    if (savings >= minSavings)
      candidates.push({ color, bbox, savings, count, area, corrections });
  }
  candidates.sort((a, b) => b.savings - a.savings || b.count - a.count || a.area - b.area);
  return candidates;
}

function selectUnderpaintCandidatesGreedy(candidates, width, height) {
  const occupied = Array.from({ length: height }, () => new Uint8Array(width));
  const accepted = [];
  const clear = (bbox) => {
    for (let y = bbox.y0; y < bbox.y1; y++)
      for (let x = bbox.x0; x < bbox.x1; x++) if (occupied[y][x]) return false;
    return true;
  };
  const mark = (bbox) => {
    for (let y = bbox.y0; y < bbox.y1; y++)
      for (let x = bbox.x0; x < bbox.x1; x++) occupied[y][x] = 1;
  };
  for (const cand of candidates)
    if (clear(cand.bbox)) {
      accepted.push(cand);
      mark(cand.bbox);
    }
  return accepted;
}

function bitCount(v) {
  let n = 0;
  while (v) {
    n += Number(v & 1n);
    v >>= 1n;
  }
  return n;
}

function selectUnderpaintCandidatesBeam(candidates, beamWidth = 64, maxCandidates = 256) {
  const cand = candidates.slice(0, maxCandidates);
  const n = cand.length;
  if (!n) return [];
  const conflict = new Array(n).fill(0n);
  for (let i = 0; i < n; i++) {
    let mask = 1n << BigInt(i);
    for (let j = i + 1; j < n; j++) {
      if (bboxesOverlap(cand[i].bbox, cand[j].bbox)) {
        mask |= 1n << BigInt(j);
        conflict[j] |= 1n << BigInt(i);
      }
    }
    conflict[i] |= mask;
  }
  let states = [{ score: 0, selected: 0n, forbidden: 0n }];
  for (let i = 0; i < n; i++) {
    const bit = 1n << BigInt(i);
    const next = [];
    for (const state of states) {
      next.push(state);
      if ((state.forbidden & bit) === 0n)
        next.push({
          score: state.score + cand[i].savings,
          selected: state.selected | bit,
          forbidden: state.forbidden | conflict[i],
        });
    }
    const best = new Map();
    for (const state of next) {
      const key = state.selected.toString();
      const prev = best.get(key);
      if (!prev || state.score > prev.score) best.set(key, state);
    }
    states = Array.from(best.values())
      .sort((a, b) => b.score - a.score || bitCount(b.selected) - bitCount(a.selected))
      .slice(0, beamWidth);
  }
  const best = states.reduce((a, b) => (b.score > a.score ? b : a), states[0]);
  const accepted = [];
  for (let i = 0; i < n; i++) if (best.selected & (1n << BigInt(i))) accepted.push(cand[i]);
  return accepted;
}

function assembleUnderpaintSolution(grid, accepted) {
  const occupied = Array.from({ length: grid.height }, () => new Uint8Array(grid.width));
  const mark = (bbox) => {
    for (let y = bbox.y0; y < bbox.y1; y++)
      for (let x = bbox.x0; x < bbox.x1; x++) occupied[y][x] = 1;
  };
  accepted.forEach((c) => mark(c.bbox));
  const rects = [];
  for (const c of accepted)
    rects.push({ x: c.bbox.x0, y: c.bbox.y0, w: c.bbox.x1 - c.bbox.x0, h: c.bbox.y1 - c.bbox.y0, color: c.color });
  for (const c of accepted) {
    for (const r of offsetRects(c.corrections, c.bbox.x0, c.bbox.y0)) rects.push(r);
  }

  const residual = makeGrid(grid.width, grid.height);
  for (let y = 0; y < grid.height; y++)
    for (let x = 0; x < grid.width; x++)
      if (!occupied[y][x]) residual.rows[y][x] = grid.rows[y][x];
  for (const r of greedyMeshingRects(residual).rects) rects.push(r);
  return { rects, width: grid.width, height: grid.height };
}

const componentUnderpaintRects = (grid, maxBBoxRatio, minComponentPixels, minSavings) =>
  assembleUnderpaintSolution(
    grid,
    selectUnderpaintCandidatesGreedy(
      collectUnderpaintCandidates(grid, maxBBoxRatio, minComponentPixels, minSavings),
      grid.width,
      grid.height,
    ),
  );

const componentUnderpaintBeamRects = (
  grid, maxBBoxRatio, minComponentPixels, minSavings, beamWidth, maxCandidates,
) =>
  assembleUnderpaintSolution(
    grid,
    selectUnderpaintCandidatesBeam(
      collectUnderpaintCandidates(grid, maxBBoxRatio, minComponentPixels, minSavings),
      beamWidth,
      maxCandidates,
    ),
  );

function twoStageOverdrawRects(grid, stage1Passes = 1200, stage1Ratio = 3.0, stage2Passes = 2000, stage2Ratio = 10.0) {
  const seed = fastMergeOverdrawRects(grid, stage1Passes, stage1Ratio);
  return fastMergeOverdrawFromSeed(grid, seed.rects, stage2Passes, stage2Ratio);
}

function bestFastRects(grid, config) {
  const start = nowMs();
  const candidates = [];
  let beamSeed = null;
  const maxOverdrawRatio = config.maxOverdrawRatio ?? 2.5;
  const withinBudget = () => nowMs() - start < config.safeTimeSeconds * 1000;
  const record = (name, result) => candidates.push({ name, result });

  record('greedy-meshing', greedyMeshingRects(grid));
  if (withinBudget())
    record('component-underpaint', componentUnderpaintRects(
      grid, config.underpaintMaxBBoxRatio, config.underpaintMinComponentPixels, config.underpaintMinSavings));
  if (withinBudget()) {
    const result = componentUnderpaintBeamRects(
      grid, config.underpaintMaxBBoxRatio, config.underpaintMinComponentPixels,
      config.underpaintMinSavings, config.underpaintBeamWidth, config.underpaintBeamCandidates);
    beamSeed = result.rects;
    record('component-underpaint-beam', result);
  }

  const ladder = [
    [Math.min(config.maxMergePasses, 400), maxOverdrawRatio],
    [Math.max(config.maxMergePasses, 800), Math.max(2.5, maxOverdrawRatio)],
    [Math.max(config.maxMergePasses, 1200), Math.max(3.0, maxOverdrawRatio)],
  ];
  const seen = new Set();
  for (const [passes, ratio] of ladder) {
    const key = `${passes}/${ratio}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!withinBudget()) break;
    record(`fast-overdraw(${passes},${ratio})`, fastMergeOverdrawRects(grid, passes, ratio));
  }

  if (beamSeed && withinBudget()) {
    const passes = Math.max(config.maxMergePasses, 800);
    const ratio = Math.max(3.0, maxOverdrawRatio);
    record(`fast-overdraw-seeded(${passes},${ratio})`,
      fastMergeOverdrawFromSeed(grid, beamSeed, passes, ratio));
  }

  if (withinBudget()) {
    record('two-stage-overdraw', twoStageOverdrawRects(
      grid, config.stage1Passes, config.stage1Ratio, config.stage2Passes, config.stage2Ratio));
  }

  candidates.sort((a, b) => a.result.rects.length - b.result.rects.length);
  return candidates[0].result;
}

function orderRectsBackToFront(rects, grid) {
  const remaining = rects.map((_, i) => i);
  const frontCovered = Array.from({ length: grid.height }, () => new Uint8Array(grid.width));
  const frontToBack = [];

  const canBeNextFront = (rect) => {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (frontCovered[y][x]) continue;
        if (grid.rows[y][x] !== rect.color) return false;
      }
    }
    return true;
  };
  const markFront = (rect) => {
    for (let y = rect.y; y < rect.y + rect.h; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++) frontCovered[y][x] = 1;
  };

  while (remaining.length) {
    let pickedPos = -1;
    remaining
      .map((idx, pos) => ({ idx, pos, area: rectArea(rects[idx]) }))
      .sort((a, b) => a.area - b.area || a.idx - b.idx)
      .some(({ idx, pos }) => {
        if (canBeNextFront(rects[idx])) {
          pickedPos = pos;
          return true;
        }
        return false;
      });
    if (pickedPos < 0) return null;
    const [idx] = remaining.splice(pickedPos, 1);
    frontToBack.push(rects[idx]);
    markFront(rects[idx]);
  }
  return frontToBack.reverse();
}

function renderRectsToGrid(rects, width, height) {
  const canvas = Array.from({ length: height }, () => new Uint32Array(width));
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++) canvas[y][x] = rect.color;
  }
  return canvas;
}

const rectOrderMatchesTarget = (rectsBackToFront, grid) =>
  gridsEqual(renderRectsToGrid(rectsBackToFront, grid.width, grid.height), grid.rows);

// Main entry: returns rects in validated BACK-TO-FRONT paint order.
// mode: 'exact' | 'fast-overdraw' | 'safe-overdraw' (default)
export function optimizeRects(grid, mode = 'safe-overdraw', config = DEFAULT_OPTIMIZER_CONFIG) {
  let result;
  if (mode === 'exact') {
    result = exactNonoverlapRects(grid);
  } else if (mode === 'fast-overdraw') {
    result = fastMergeOverdrawRects(grid, config.maxMergePasses, config.maxOverdrawRatio ?? 2.5);
  } else {
    result = bestFastRects(grid, config);
  }

  let ordered = orderRectsBackToFront(result.rects, grid);
  if (!ordered || !rectOrderMatchesTarget(ordered, grid)) {
    // layer order invalid — fall back to the exact cover (always orderable)
    result = exactNonoverlapRects(grid);
    ordered = orderRectsBackToFront(result.rects, grid);
  }
  if (!ordered) throw new Error('Could not produce a valid rectangle plan');
  return ordered;
}
