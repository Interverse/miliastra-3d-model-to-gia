// Live editing statistics + .gia limit warnings for the Statistics panel
// and the viewport status bar.

export const KIND_LABELS = {
  triangle: "Roof Component",
  square: "Cuboid",
  plane: "Plane",
  sphere: "Sphere",
  cylinder: "Cylinder",
  cone: "Cone",
  prism: "Triangular Prism",
};

const PER_MODEL = 999;

export function computeEditorStats(decorations, { budget = Infinity } = {}) {
  const byKind = {};
  const colors = new Set();
  let overZoom = 0;
  for (const d of decorations) {
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
    colors.add(d.color);
    if (
      Math.abs(d.scale.x) > 50.0001 ||
      Math.abs(d.scale.y) > 50.0001 ||
      Math.abs(d.scale.z) > 50.0001
    ) {
      overZoom++;
    }
  }
  const count = decorations.length;
  const models = Math.max(1, Math.ceil(count / PER_MODEL));
  const full = Math.floor(count / PER_MODEL);
  const rest = count % PER_MODEL;
  const perModel =
    count <= PER_MODEL
      ? String(count)
      : rest === 0
        ? `${full} × ${PER_MODEL}`
        : `${full} × ${PER_MODEL} + ${rest}`;

  const warnings = [];
  if (count > budget) {
    warnings.push(
      `${(count - budget).toLocaleString()} decoration(s) over the ${budget.toLocaleString()} budget`,
    );
  }
  if (overZoom > 0) {
    warnings.push(`${overZoom} primitive(s) exceed the zoom limit of 50`);
  }
  if (models > 1) {
    warnings.push(`Output splits into ${models} models (max ${PER_MODEL} decorations each)`);
  }
  return { count, byKind, uniqueColors: colors.size, models, perModel, overZoom, warnings };
}

export function formatBytes(n) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}
