// Pure similarity metrics for the visual-quality test suite (see
// docs/decoration-reduction-plan.md, "Phase 1.5 — Similarity test suite").
//
// No three.js (or any DOM) imports here on purpose: the harness feeds these
// functions plain typed arrays it read back from WebGL render targets, and
// the app's future in-app "Score current model" action reuses the exact
// same functions — keeping the acceptance test identical everywhere it runs.

// ---------- silhouette IoU ----------

// maskA/maskB: same-length arrays (typed or plain) of truthy/falsy values —
// one entry per pixel, true = foreground (part of the silhouette).
export function silhouetteIoU(maskA, maskB) {
  let inter = 0, union = 0;
  const n = Math.min(maskA.length, maskB.length);
  for (let i = 0; i < n; i++) {
    const a = !!maskA[i], b = !!maskB[i];
    if (a || b) union++;
    if (a && b) inter++;
  }
  return union === 0 ? 1 : inter / union; // both empty = perfect agreement
}

// ---------- sRGB -> CIELAB ----------

function srgb255ToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

// sRGB (D65) primaries -> CIE XYZ, linear-light input 0..1
function linearRgbToXyz(r, g, b) {
  return [
    r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
    r * 0.0193339 + g * 0.1191920 + b * 0.9503041,
  ];
}

// D65 reference white
const XN = 0.95047, YN = 1.0, ZN = 1.08883;
function xyzToLab(x, y, z) {
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / XN), fy = f(y / YN), fz = f(z / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// r,g,b: 0..255 sRGB-encoded bytes (as read straight off a canvas/render
// target) -> [L, a, b]
export function rgbToLab(r, g, b) {
  const rl = srgb255ToLinear(r), gl = srgb255ToLinear(g), bl = srgb255ToLinear(b);
  const [x, y, z] = linearRgbToXyz(rl, gl, bl);
  return xyzToLab(x, y, z);
}

// ---------- CIEDE2000 ----------
// Standard formula (Sharma, Wu, Dalal 2005) — deliberately NOT ΔE76: the
// palette builder (engine/convert/color.js) optimizes construction with
// ΔE76; this harness judges perceived similarity with the more accurate
// (and much fiddlier) ΔE2000.
export function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const rad = Math.PI / 180, deg = 180 / Math.PI;

  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);
  const h1p = C1p === 0 ? 0 : (Math.atan2(b1, a1p) * deg + 360) % 360;
  const h2p = C2p === 0 ? 0 : (Math.atan2(b2, a2p) * deg + 360) % 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    const diff = h2p - h1p;
    if (diff > 180) dhp = diff - 360;
    else if (diff < -180) dhp = diff + 360;
    else dhp = diff;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp;
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hbarp = (h1p + h2p + 360) / 2;
  } else {
    hbarp = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;

  const kL = 1, kC = 1, kH = 1;
  const termL = dLp / (kL * SL);
  const termC = dCp / (kC * SC);
  const termH = dHp / (kH * SH);
  return Math.sqrt(termL * termL + termC * termC + termH * termH + RT * termC * termH);
}

// ---------- mean ΔE2000 over shared-foreground pixels ----------

// rgbA/rgbB: flat pixel buffers (Uint8Array/Uint8ClampedArray), stride 4
// (RGBA) by default. intersectionMask: one entry per pixel, true where the
// pixel is foreground in BOTH renders (XOR pixels are IoU's job, not this
// metric's — see spec).
export function meanDeltaE(rgbA, rgbB, intersectionMask, stride = 4) {
  let sum = 0, n = 0;
  for (let i = 0; i < intersectionMask.length; i++) {
    if (!intersectionMask[i]) continue;
    const o = i * stride;
    const labA = rgbToLab(rgbA[o], rgbA[o + 1], rgbA[o + 2]);
    const labB = rgbToLab(rgbB[o], rgbB[o + 1], rgbB[o + 2]);
    sum += deltaE2000(labA, labB);
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

// ---------- headline score ----------

export function faithScore(meanIoU, meanDE) {
  return 100 * (0.6 * meanIoU + 0.4 * Math.max(0, 1 - meanDE / 20));
}
