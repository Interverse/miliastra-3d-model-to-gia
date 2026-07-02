// Color utilities: texture sampling, distances, averaging.
// Colors are [r, g, b] arrays in 0..255.

export function colorDistance(a, b) {
  // Euclidean distance in RGB space, range 0..441.7
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export function averageColors(colors, weights) {
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < colors.length; i++) {
    const wi = weights ? weights[i] : 1;
    r += colors[i][0] * wi; g += colors[i][1] * wi; b += colors[i][2] * wi; w += wi;
  }
  if (w === 0) return [255, 255, 255];
  return [r / w, g / w, b / w];
}

export function colorToRgbInt(c) {
  const r = Math.max(0, Math.min(255, Math.round(c[0])));
  const g = Math.max(0, Math.min(255, Math.round(c[1])));
  const b = Math.max(0, Math.min(255, Math.round(c[2])));
  return (r << 16) | (g << 8) | b;
}

// texture: { width, height, data: Uint8ClampedArray (RGBA), flipY?: boolean }
// Nearest-neighbor sample with repeat wrapping. Returns [r,g,b,a].
// flipY (default true, three.js convention): UV v=0 is the image BOTTOM.
// flipY=false (glTF): UV v=0 is the image TOP (pixel row 0).
export function sampleTexture(texture, u, v) {
  const { width, height, data } = texture;
  const flipY = texture.flipY !== false;
  let uu = u - Math.floor(u);
  let vv = v - Math.floor(v);
  const x = Math.min(width - 1, Math.floor(uu * width));
  const y = Math.min(height - 1, Math.floor((flipY ? 1 - vv : vv) * height));
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

// Sample a triangle's face color. Returns { color, spread, alphaMax,
// alphaMean } where spread is the max color distance between any sample and
// the mean (alpha discontinuities also raise it) — used to decide whether to
// subdivide for texture fidelity. Fully transparent samples don't contribute
// to the mean color.
// uv0..uv2: [u,v] arrays; baseColor: material color multiplier [r,g,b] 0..255.
const BARY_SAMPLES = [
  [1 / 3, 1 / 3, 1 / 3],
  [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6],
  [0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8],
  [0.45, 0.45, 0.1], [0.1, 0.45, 0.45], [0.45, 0.1, 0.45],
];

export function sampleTriangleColor(texture, uv0, uv1, uv2, baseColor) {
  if (!texture || !uv0) {
    return { color: baseColor.slice(), spread: 0, alphaMax: 1, alphaMean: 1 };
  }
  const opaque = [];
  const alphas = [];
  for (const [b0, b1, b2] of BARY_SAMPLES) {
    const u = uv0[0] * b0 + uv1[0] * b1 + uv2[0] * b2;
    const v = uv0[1] * b0 + uv1[1] * b1 + uv2[1] * b2;
    const c = sampleTexture(texture, u, v);
    const a = (c[3] ?? 255) / 255;
    alphas.push(a);
    if (a > 0.004) {
      opaque.push([
        c[0] * baseColor[0] / 255,
        c[1] * baseColor[1] / 255,
        c[2] * baseColor[2] / 255,
      ]);
    }
  }
  const alphaMax = Math.max(...alphas);
  const alphaMean = alphas.reduce((s, a) => s + a, 0) / alphas.length;
  if (opaque.length === 0) {
    return { color: baseColor.slice(), spread: 0, alphaMax, alphaMean };
  }
  const mean = averageColors(opaque);
  let spread = 0;
  for (const s of opaque) spread = Math.max(spread, colorDistance(s, mean));
  // alpha discontinuity forces subdivision just like a color edge
  const aMin = Math.min(...alphas);
  spread = Math.max(spread, (alphaMax - aMin) * 255);
  return { color: mean, spread, alphaMax, alphaMean };
}
