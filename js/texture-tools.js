// Texture editing panel: K-means color reduction and recoloring
// adjustments. Edits are written back into the extracted engine textures
// ({width, height, data} buffers) IN PLACE, so the conversion pipeline and
// preview overlay pick them up on the next Generate.
//
// Non-destructive model: original pixels are kept; the working image is
// recomputed as  adjust(original) -> quantize  whenever a control changes,
// so sliders never accumulate loss.
//
// Settings are PER TEXTURE: each texture keeps its own configuration, and
// selecting a different texture restores that texture's settings. With
// multiple textures, "Sync to All Textures" copies the current texture's
// settings to every other one.

import { t } from "./i18n.js";

const DEFAULT_SETTINGS = () => ({
  colors: 0,
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

    if (settings.colors > 0) kmeansQuantize(out, n, settings.colors);
  }

  function rebuildActive() {
    if (!active) return;
    applyPipeline(active);
    drawPreview();
    if (onTextureChange) onTextureChange(active.texture);
  }

  // ---------- K-means color quantization ----------

  // Weighted K-means in CIELAB with k-means++ seeding, run on the 5-bit
  // color histogram (≤ 32k items) rather than raw pixels. Strength 0..100
  // maps to the cluster count K (mild → ~48 colors, max → 2). Deterministic
  // (seeded PRNG), so the same texture + settings always produce the same
  // palette. Every pixel then snaps to its cluster's weighted-mean color.
  function kmeansQuantize(data, n, strength) {
    const K = Math.max(2, Math.round(2 + 46 * Math.pow(1 - strength / 100, 1.7)));

    // weighted histogram (5-bit buckets)
    const counts = new Map();
    for (let i = 0; i < n; i++) {
      if (data[i * 4 + 3] < 8) continue;
      const key = ((data[i * 4] >> 3) << 10) | ((data[i * 4 + 1] >> 3) << 5) | (data[i * 4 + 2] >> 3);
      const c = counts.get(key);
      if (c) {
        c.w++;
        c.r += data[i * 4]; c.g += data[i * 4 + 1]; c.b += data[i * 4 + 2];
      } else {
        counts.set(key, { w: 1, r: data[i * 4], g: data[i * 4 + 1], b: data[i * 4 + 2] });
      }
    }
    if (counts.size <= K) return; // already at or below the target

    const items = [];
    for (const [key, c] of counts) {
      const rgb = [c.r / c.w, c.g / c.w, c.b / c.w];
      items.push({ key, rgb, lab: rgbToLab(rgb), w: c.w });
    }

    // k-means++ seeding (weighted, deterministic)
    const rand = mulberry32(0x9e3779b9);
    const centroids = [];
    {
      // first: the heaviest color (dominant background/skin tone)
      let hi = 0;
      for (let i = 1; i < items.length; i++) if (items[i].w > items[hi].w) hi = i;
      centroids.push(items[hi].lab.slice());
      const d2 = new Float64Array(items.length).fill(Infinity);
      while (centroids.length < K) {
        const c = centroids[centroids.length - 1];
        let sum = 0;
        for (let i = 0; i < items.length; i++) {
          const d = labDist2(items[i].lab, c);
          if (d < d2[i]) d2[i] = d;
          sum += d2[i] * items[i].w;
        }
        if (sum <= 0) break;
        let r = rand() * sum;
        let pick = items.length - 1;
        for (let i = 0; i < items.length; i++) {
          r -= d2[i] * items[i].w;
          if (r <= 0) { pick = i; break; }
        }
        centroids.push(items[pick].lab.slice());
      }
    }

    // Lloyd iterations (assign -> weighted mean), until stable or 16 rounds
    const assign = new Int32Array(items.length);
    for (let iter = 0; iter < 16; iter++) {
      let moved = 0;
      for (let i = 0; i < items.length; i++) {
        let best = 0, bestD = Infinity;
        for (let k = 0; k < centroids.length; k++) {
          const d = labDist2(items[i].lab, centroids[k]);
          if (d < bestD) { bestD = d; best = k; }
        }
        if (assign[i] !== best) { assign[i] = best; moved++; }
      }
      // recompute centroids as weighted means (in Lab)
      const acc = centroids.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < items.length; i++) {
        const a = acc[assign[i]], it = items[i];
        a[0] += it.lab[0] * it.w; a[1] += it.lab[1] * it.w; a[2] += it.lab[2] * it.w;
        a[3] += it.w;
      }
      for (let k = 0; k < centroids.length; k++) {
        if (acc[k][3] > 0) {
          centroids[k][0] = acc[k][0] / acc[k][3];
          centroids[k][1] = acc[k][1] / acc[k][3];
          centroids[k][2] = acc[k][2] / acc[k][3];
        }
      }
      if (moved === 0) break;
    }

    // cluster palette = weighted mean RGB of its members (display-accurate)
    const pal = centroids.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < items.length; i++) {
      const p = pal[assign[i]], it = items[i];
      p[0] += it.rgb[0] * it.w; p[1] += it.rgb[1] * it.w; p[2] += it.rgb[2] * it.w;
      p[3] += it.w;
    }
    const palette = pal.map((p, k) =>
      p[3] > 0
        ? [Math.round(p[0] / p[3]), Math.round(p[1] / p[3]), Math.round(p[2] / p[3])]
        : [0, 0, 0]);

    // bucket -> palette index, then write every pixel
    const bucketPal = new Map();
    for (let i = 0; i < items.length; i++) bucketPal.set(items[i].key, palette[assign[i]]);
    for (let i = 0; i < n; i++) {
      if (data[i * 4 + 3] < 8) continue;
      const key = ((data[i * 4] >> 3) << 10) | ((data[i * 4 + 1] >> 3) << 5) | (data[i * 4 + 2] >> 3);
      const p = bucketPal.get(key);
      if (p) { data[i * 4] = p[0]; data[i * 4 + 1] = p[1]; data[i * 4 + 2] = p[2]; }
    }
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
    "tx-colors": ["v-txcolors", (v) => (String(v) === "0" ? t("val.off") : String(v))],
    "tx-hue": ["v-txhue", (v) => v + "°"],
    "tx-sat": ["v-txsat", (v) => v + "%"],
    "tx-bri": ["v-txbri", (v) => String(v)],
    "tx-con": ["v-txcon", (v) => String(v)],
  };
  const FIELDS = [
    ["tx-colors", "colors"],
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
    // opts.colorReduction: show the Color Reduction slider (default true).
    // 3D model imports pass false — reducing a model texture's palette
    // doesn't lower the decoration count, so the slider is hidden there.
    setTextures(list, opts = {}) {
      $("row-tx-colors").hidden = opts.colorReduction === false;
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

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let z = Math.imul(a ^ (a >>> 15), 1 | a);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// sRGB [0..255] -> CIELAB (D65)
function rgbToLab(rgb) {
  const f = (u) => {
    u /= 255;
    return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
  };
  const r = f(rgb[0]), g = f(rgb[1]), b = f(rgb[2]);
  let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const g3 = (t3) => (t3 > 0.008856 ? Math.cbrt(t3) : 7.787 * t3 + 16 / 116);
  x = g3(x); y = g3(y); z = g3(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function labDist2(a, b) {
  const d0 = a[0] - b[0], d1 = a[1] - b[1], d2 = a[2] - b[2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

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
