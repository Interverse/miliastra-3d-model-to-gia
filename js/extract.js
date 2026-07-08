// Extract engine-agnostic SourceMesh data from a loaded three.js object.
// Ignores animations, skeletons, cameras, lights — only mesh geometry,
// base color material, and base color texture are used.
import * as THREE from 'three';

// Full fidelity up to 2048 so texture-edit write-backs are lossless for
// typical textures (a lossy 512 cap blurred hard edges and made block
// textures bleed at UV-island borders). Larger sources downscale
// PROPORTIONALLY — clamping each axis independently squashed non-square
// textures.
const MAX_TEX_SIZE = 2048;

function textureToPixels(tex) {
  const img = tex?.image;
  if (!img) return null;
  try {
    const srcW = img.width || 0, srcH = img.height || 0;
    if (!srcW || !srcH) return null;
    const k = Math.min(1, MAX_TEX_SIZE / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * k));
    const h = Math.max(1, Math.round(srcH * k));
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
  const color = [
    Math.round(srgb.r * 255),
    Math.round(srgb.g * 255),
    Math.round(srgb.b * 255),
  ];
  // WYSIWYG: emissive contributes to the displayed color — fold it in so
  // glowing features (screens, eyes, neon) don't arrive black
  if (mat.emissive && (mat.emissive.r || mat.emissive.g || mat.emissive.b)) {
    const k = mat.emissiveIntensity ?? 1;
    const em = new THREE.Color(
      mat.emissive.r * k, mat.emissive.g * k, mat.emissive.b * k,
    ).convertLinearToSRGB();
    color[0] = Math.min(255, color[0] + Math.round(em.r * 255));
    color[1] = Math.min(255, color[1] + Math.round(em.g * 255));
    color[2] = Math.min(255, color[2] + Math.round(em.b * 255));
  }
  const info = {
    color,
    // an emissive-only material (no base map) still shows its emissiveMap
    texture: mat.map
      ? textureToPixels(mat.map)
      : mat.emissiveMap
        ? textureToPixels(mat.emissiveMap)
        : null,
  };
  cache.set(mat, info);
  return info;
}

// WYSIWYG: three renders vertex colors when material.vertexColors is set —
// extract them (converted to display sRGB 0..255, stride 3) so the
// converter sees the same colors the viewport shows.
function vertexColors(node, mat, geo) {
  const attr = geo.getAttribute('color');
  if (!attr || !mat?.vertexColors) return null;
  const n = attr.count;
  const out = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    c.setRGB(attr.getX(i), attr.getY(i), attr.getZ(i)).convertLinearToSRGB();
    out[i * 3] = c.r * 255;
    out[i * 3 + 1] = c.g * 255;
    out[i * 3 + 2] = c.b * 255;
  }
  return out;
}

// WYSIWYG: skinned meshes render with their current pose applied on the
// GPU; raw position attributes are the bind pose. Bake the displayed
// skinned positions so the conversion matches the viewport.
function bakedPositions(node, geo) {
  const pos = geo.getAttribute('position');
  if (!node.isSkinnedMesh || !node.skeleton) {
    return Float32Array.from(pos.array.slice(0, pos.count * 3));
  }
  try {
    node.skeleton.update();
    const out = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      node.boneTransform(i, v); // skinned position in mesh-local space
      out[i * 3] = v.x;
      out[i * 3 + 1] = v.y;
      out[i * 3 + 2] = v.z;
    }
    return out;
  } catch (e) {
    console.warn('skin baking failed, using bind pose', e);
    return Float32Array.from(pos.array.slice(0, pos.count * 3));
  }
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
        positions: bakedPositions(node, geo),
        indices,
        uvs: uvAttr ? Float32Array.from(uvAttr.array.slice(0, uvAttr.count * 2)) : null,
        colors: vertexColors(node, mat, geo),
        matrixWorld: node.matrixWorld.toArray(),
        color,
        texture,
      });
    }
  });
  return { meshes: out, triangleCount, meshCount: out.length, textures };
}
