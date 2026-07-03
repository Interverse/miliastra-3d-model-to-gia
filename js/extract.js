// Extract engine-agnostic SourceMesh data from a loaded three.js object.
// Ignores animations, skeletons, cameras, lights — only mesh geometry,
// base color material, and base color texture are used.
import * as THREE from 'three';

const MAX_TEX_SIZE = 512;

function textureToPixels(tex) {
  const img = tex?.image;
  if (!img) return null;
  try {
    const srcW = img.width || 0, srcH = img.height || 0;
    if (!srcW || !srcH) return null;
    const w = Math.min(srcW, MAX_TEX_SIZE);
    const h = Math.min(srcH, MAX_TEX_SIZE);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let flippedRows = false;
    // flipY handling: three.js textures default flipY=true for most loaders;
    // UVs assume v=0 at bottom. drawImage puts row 0 at top, which matches
    // sampleTexture's (1 - v) lookup.
    if (typeof img.data !== 'undefined') {
      // DataTexture (e.g. TGALoader): raw RGBA pixels, row 0 at the BOTTOM
      // (no flipY applied to data textures) — flip while copying so the
      // sampler's (1 - v) convention holds.
      const src = img.data instanceof Uint8ClampedArray
        ? img.data
        : new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
      const flipped = new Uint8ClampedArray(srcW * srcH * 4);
      for (let y = 0; y < srcH; y++) {
        flipped.set(src.subarray(y * srcW * 4, (y + 1) * srcW * 4), (srcH - 1 - y) * srcW * 4);
      }
      const full = new ImageData(flipped, srcW, srcH);
      // rows were flipped to top-down order, so sample with the flipY=true
      // convention regardless of the texture's own flag
      flippedRows = true;
      if (srcW === w && srcH === h) return { width: w, height: h, data: flipped, flipY: true };
      // downscale via a temp canvas
      const tmp = document.createElement('canvas');
      tmp.width = srcW; tmp.height = srcH;
      tmp.getContext('2d').putImageData(full, 0, 0);
      ctx.drawImage(tmp, 0, 0, w, h);
    } else {
      ctx.drawImage(img, 0, 0, w, h);
    }
    const data = ctx.getImageData(0, 0, w, h);
    // flipY: three.js convention (true) = UV v=0 at image bottom;
    // glTF textures use flipY=false = UV v=0 at image top (row 0)
    return { width: w, height: h, data: data.data, flipY: flippedRows ? true : tex.flipY !== false };
  } catch (e) {
    console.warn('texture read failed', e);
    return null;
  }
}

function materialInfo(mat, cache) {
  if (!mat) return { color: [255, 255, 255], texture: null };
  if (cache.has(mat)) return cache.get(mat);
  const c = mat.color ? mat.color : { r: 1, g: 1, b: 1 };
  // three's Color is linear after loaders convert sRGB; convertLinearToSRGB
  // for display-accurate color matching
  const srgb = new THREE.Color(c.r, c.g, c.b).convertLinearToSRGB();
  const info = {
    color: [
      Math.round(srgb.r * 255),
      Math.round(srgb.g * 255),
      Math.round(srgb.b * 255),
    ],
    texture: mat.map ? textureToPixels(mat.map) : null,
  };
  cache.set(mat, info);
  return info;
}

// Returns { meshes: SourceMesh[], triangleCount, meshCount,
//           textures: [{ texture, material }] }  — textures pair each
// extracted pixel buffer with the three.js material that uses it, so the
// app can sync texture edits back onto the viewport model.
export function extractMeshes(root) {
  root.updateMatrixWorld(true);
  const out = [];
  let triangleCount = 0;
  const matCache = new Map();
  const textures = [];

  root.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    const geo = node.geometry;
    const posAttr = geo.getAttribute('position');
    if (!posAttr) return;
    const uvAttr = geo.getAttribute('uv');
    const index = geo.getIndex();
    const groups = (geo.groups && geo.groups.length && Array.isArray(node.material))
      ? geo.groups
      : [{ start: 0, count: index ? index.count : posAttr.count, materialIndex: 0 }];

    for (const g of groups) {
      const mat = Array.isArray(node.material) ? node.material[g.materialIndex] : node.material;
      const cached = matCache.has(mat);
      const { color, texture } = materialInfo(mat, matCache);
      if (!cached && texture) textures.push({ texture, material: mat });
      let indices;
      const end = Math.min(g.start + g.count, index ? index.count : posAttr.count);
      if (index) {
        indices = new Uint32Array(end - g.start);
        for (let i = g.start; i < end; i++) indices[i - g.start] = index.getX(i);
      } else {
        indices = new Uint32Array(end - g.start);
        for (let i = g.start; i < end; i++) indices[i - g.start] = i;
      }
      triangleCount += indices.length / 3;
      out.push({
        positions: Float32Array.from(posAttr.array.slice(0, posAttr.count * 3)),
        indices,
        uvs: uvAttr ? Float32Array.from(uvAttr.array.slice(0, uvAttr.count * 2)) : null,
        matrixWorld: node.matrixWorld.toArray(),
        color,
        texture,
      });
    }
  });
  return { meshes: out, triangleCount, meshCount: out.length, textures };
}
