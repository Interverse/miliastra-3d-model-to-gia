// Live editing statistics + .gia limit warnings for the Statistics panel
// and the viewport status bar.
//
// Warnings are returned as { key, params } descriptors and rendered through
// i18n by the caller. KIND_LABELS stays English — it is the canonical
// in-game model name used in the JSON export (UI display uses t("kind.*")).

import { num } from "../i18n.js";

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
    warnings.push({ key: "w.budget", params: { n: num(count - budget), b: num(budget) } });
  }
  if (overZoom > 0) {
    warnings.push({ key: "w.zoom", params: { n: num(overZoom) } });
  }
  if (models > 1) {
    warnings.push({ key: "w.split", params: { n: num(models) } });
  }
  return { count, byKind, uniqueColors: colors.size, models, perModel, overZoom, warnings };
}

export function formatBytes(n) {
  if (n == null) return "";
  if (n < 1024) return num(n) + " B";
  if (n < 1024 * 1024)
    return num(n / 1024, { maximumFractionDigits: 1 }) + " KB";
  return num(n / (1024 * 1024), { maximumFractionDigits: 2 }) + " MB";
}
