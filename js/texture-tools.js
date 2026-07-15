// Texture editing panel: recoloring adjustments. Edits are written back
// into the extracted engine textures ({width, height, data} buffers) IN
// PLACE, so the conversion pipeline and preview overlay pick them up on
// the next Generate.
//
// Non-destructive model: original pixels are kept; the working image is
// recomputed as adjust(original) whenever a control changes, so sliders
// never accumulate loss.
//
// Settings are PER TEXTURE: each texture keeps its own configuration, and
// selecting a different texture restores that texture's settings. With
// multiple textures, "Sync to All Textures" copies the current texture's
// settings to every other one.

import { t } from "./i18n.js";

const DEFAULT_SETTINGS = () => ({
  hue: 0,
  sat: 100,
  bri: 0,
  con: 0,
  invert: false,
});

// onTextureChange(textureObj) is called after every edit so the app can
// refresh the 3D viewport materials that use this texture.
export function setupTexturePanel(getEl, onTextureChange) {
  const $ = getEl;
  let entries = []; // { texture, original, name, settings }
  let active = null;

  const canvas = () => $("tx-canvas");

  // ---------- pipeline ----------

  // Full-resolution buffers (up to 2048²) make per-pixel rebuilds heavier,
  // so slider drags are debounced — one rebuild per pause, not per event.
  let rebuildTimer = 0;
  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuildActive, 80);
  }

  // recompute one texture's working pixels from its original + settings
  function applyPipeline(entry) {
    const { texture, original, settings } = entry;
    const n = texture.width * texture.height;
    const out = texture.data;
    const hue = settings.hue || 0;
    const sat = (settings.sat || 100) / 100;
    const bri = (settings.bri || 0) * 1.275;
    const con = (settings.con || 0) / 100;
    const cf = con >= 0 ? 1 + con * 2 : 1 + con; // 0..3 multiplier
    const invert = !!settings.invert;

    for (let i = 0; i < n; i++) {
      let r = original[i * 4], g = original[i * 4 + 1], b = original[i * 4 + 2];
      if (hue !== 0 || sat !== 1) {
        const [h, s, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb((h + hue / 360 + 1) % 1, Math.min(1, s * sat), l);
      }
      r = (r - 128) * cf + 128 + bri;
      g = (g - 128) * cf + 128 + bri;
      b = (b - 128) * cf + 128 + bri;
      if (invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
      out[i * 4] = r < 0 ? 0 : r > 255 ? 255 : r;
      out[i * 4 + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      out[i * 4 + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      out[i * 4 + 3] = original[i * 4 + 3];
    }
  }

  function rebuildActive() {
    if (!active) return;
    applyPipeline(active);
    drawPreview();
    if (onTextureChange) onTextureChange(active.texture);
  }

  function drawPreview() {
    if (!active) return;
    const cv = canvas();
    const { texture } = active;
    cv.width = texture.width;
    cv.height = texture.height;
    const ctx = cv.getContext("2d");
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(texture.data.buffer ?? texture.data, texture.data.byteOffset ?? 0, texture.width * texture.height * 4), texture.width, texture.height),
      0, 0,
    );
  }

  // ---------- controls <-> settings ----------

  const labelFmt = {
    "tx-hue": ["v-txhue", (v) => v + "°"],
    "tx-sat": ["v-txsat", (v) => v + "%"],
    "tx-bri": ["v-txbri", (v) => String(v)],
    "tx-con": ["v-txcon", (v) => String(v)],
  };
  const FIELDS = [
    ["tx-hue", "hue"],
    ["tx-sat", "sat"],
    ["tx-bri", "bri"],
    ["tx-con", "con"],
  ];

  // push a settings object into the controls + value labels
  function writeControls(s) {
    for (const [id, field] of FIELDS) {
      $(id).value = s[field];
      const [lab, fmt] = labelFmt[id];
      $(lab).textContent = fmt(s[field]);
    }
    $("tx-invert").checked = !!s.invert;
  }

  // ---------- wiring ----------

  function bind() {
    for (const [id, field] of FIELDS) {
      $(id).addEventListener("input", () => {
        const [lab, fmt] = labelFmt[id];
        $(lab).textContent = fmt($(id).value);
        if (active) {
          active.settings[field] = parseFloat($(id).value) || 0;
          if (field === "sat" && !$(id).value) active.settings.sat = 100;
          scheduleRebuild();
        }
      });
    }
    $("tx-invert").addEventListener("change", () => {
      if (!active) return;
      active.settings.invert = $("tx-invert").checked;
      scheduleRebuild();
    });
    $("tx-reset").addEventListener("click", () => {
      if (!active) return;
      active.settings = DEFAULT_SETTINGS();
      writeControls(active.settings);
      rebuildActive();
    });
    // selecting another texture restores ITS settings (no inheritance)
    $("tx-select").addEventListener("change", () => {
      active = entries[parseInt($("tx-select").value, 10)] ?? null;
      if (active) {
        writeControls(active.settings);
        drawPreview(); // its pixels already reflect its own settings
      }
    });
    // copy the current texture's settings to every other texture
    $("tx-sync")?.addEventListener("click", () => {
      if (!active || entries.length < 2) return;
      for (const e of entries) {
        if (e === active) continue;
        e.settings = { ...active.settings };
        applyPipeline(e);
        if (onTextureChange) onTextureChange(e.texture);
      }
    });
  }
  bind();

  return {
    // textures: [{ texture: {width,height,data,...}, name }]
    setTextures(list) {
      entries = list.map((e, i) => ({
        texture: e.texture,
        name: e.name ?? t("tx.item", { n: i + 1 }),
        original: new Uint8ClampedArray(e.texture.data),
        settings: DEFAULT_SETTINGS(),
      }));
      const sel = $("tx-select");
      sel.innerHTML = "";
      entries.forEach((e, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = `${e.name} (${e.texture.width}×${e.texture.height})`;
        sel.appendChild(o);
      });
      sel.hidden = entries.length < 2;
      const sync = $("tx-sync");
      if (sync) sync.hidden = entries.length < 2;
      active = entries[0] ?? null;
      $("texture-panel").hidden = entries.length === 0;
      if (active) {
        writeControls(active.settings);
        drawPreview();
      }
    },
  };
}

// ---------- color helpers ----------

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t2) => {
    if (t2 < 0) t2 += 1;
    if (t2 > 1) t2 -= 1;
    if (t2 < 1 / 6) return p + (q - p) * 6 * t2;
    if (t2 < 1 / 2) return q;
    if (t2 < 2 / 3) return p + (q - p) * (2 / 3 - t2) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
