// Texture editing panel: color reduction, recoloring adjustments, and brush
// painting. Edits are written back into the extracted engine textures
// ({width, height, data} buffers) IN PLACE, so the conversion pipeline and
// preview overlay pick them up on the next Generate.
//
// Non-destructive model: original pixels are kept; the working image is
// recomputed as  adjust(original) -> quantize -> composite(paint overlay)
// whenever a control changes, so sliders never accumulate loss.

// onTextureChange(textureObj) is called after every edit so the app can
// refresh the 3D viewport materials that use this texture.
export function setupTexturePanel(getEl, onTextureChange) {
  const $ = getEl;
  let entries = []; // { texture, original, name }
  let active = null;

  const canvas = () => $("tx-canvas");

  // ---------- pipeline ----------

  function rebuild() {
    if (!active) return;
    const { texture, original } = active;
    const n = texture.width * texture.height;
    const out = texture.data;
    const hue = parseFloat($("tx-hue").value) || 0;
    const sat = (parseFloat($("tx-sat").value) || 100) / 100;
    const bri = (parseFloat($("tx-bri").value) || 0) * 1.275;
    const con = (parseFloat($("tx-con").value) || 0) / 100;
    const cf = con >= 0 ? 1 + con * 2 : 1 + con; // 0..3 multiplier
    const invert = $("tx-invert").checked;

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

    const strength = parseInt($("tx-colors").value, 10) || 0;
    if (strength > 0) quantize(out, n, strength);

    drawPreview();
    if (onTextureChange && active) onTextureChange(active.texture);
  }

  // True color quantization: agglomerative merging of similar colors.
  // strength 0..100 maps to an RGB merge distance; unique colors are
  // clustered (most frequent colors become the representatives, so the
  // overall appearance is preserved) and every pixel maps to its cluster's
  // weighted mean.
  function quantize(data, n, strength) {
    const tol = strength * 2.2; // 0..220 RGB distance
    // count unique colors (coarse 5-bit buckets keep the list manageable)
    const counts = new Map();
    for (let i = 0; i < n; i++) {
      if (data[i * 4 + 3] < 8) continue;
      const key = ((data[i * 4] >> 3) << 10) | ((data[i * 4 + 1] >> 3) << 5) | (data[i * 4 + 2] >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // most frequent first -> cluster representatives
    const uniq = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, cnt]) => ({
      r: ((key >> 10) & 31) << 3, g: ((key >> 5) & 31) << 3, b: (key & 31) << 3, cnt,
    }));
    const reps = []; // {r,g,b,wr,wg,wb,w}
    const assign = new Map(); // bucketKey -> rep index
    for (const u of uniq) {
      let ri = -1;
      for (let i = 0; i < reps.length; i++) {
        const d = Math.hypot(u.r - reps[i].r, u.g - reps[i].g, u.b - reps[i].b);
        if (d <= tol) { ri = i; break; }
      }
      if (ri < 0) {
        ri = reps.length;
        reps.push({ r: u.r, g: u.g, b: u.b, wr: 0, wg: 0, wb: 0, w: 0 });
      }
      reps[ri].wr += u.r * u.cnt; reps[ri].wg += u.g * u.cnt; reps[ri].wb += u.b * u.cnt;
      reps[ri].w += u.cnt;
      assign.set(((u.r >> 3) << 10) | ((u.g >> 3) << 5) | (u.b >> 3), ri);
    }
    const palette = reps.map((c) => [
      Math.round(c.wr / c.w), Math.round(c.wg / c.w), Math.round(c.wb / c.w),
    ]);
    for (let i = 0; i < n; i++) {
      if (data[i * 4 + 3] < 8) continue;
      const key = ((data[i * 4] >> 3) << 10) | ((data[i * 4 + 1] >> 3) << 5) | (data[i * 4 + 2] >> 3);
      const p = palette[assign.get(key) ?? 0];
      data[i * 4] = p[0]; data[i * 4 + 1] = p[1]; data[i * 4 + 2] = p[2];
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

  // ---------- wiring ----------

  function bind() {
    for (const id of ["tx-colors", "tx-hue", "tx-sat", "tx-bri", "tx-con"]) {
      $(id).addEventListener("input", () => {
        const labels = {
          "tx-colors": ["v-txcolors", (v) => (v === "0" ? "off" : v)],
          "tx-hue": ["v-txhue", (v) => v + "°"],
          "tx-sat": ["v-txsat", (v) => v + "%"],
          "tx-bri": ["v-txbri", (v) => v],
          "tx-con": ["v-txcon", (v) => v],
        };
        const [lab, fmt] = labels[id];
        $(lab).textContent = fmt($(id).value);
        rebuild();
      });
    }
    $("tx-invert").addEventListener("change", rebuild);
    $("tx-reset").addEventListener("click", () => {
      if (!active) return;
      for (const [id, val] of [["tx-colors", 0], ["tx-hue", 0], ["tx-sat", 100], ["tx-bri", 0], ["tx-con", 0]]) {
        $(id).value = val;
        $(id).dispatchEvent(new Event("input"));
      }
      $("tx-invert").checked = false;
      rebuild();
    });
    $("tx-select").addEventListener("change", () => {
      active = entries[parseInt($("tx-select").value, 10)] ?? null;
      rebuild();
    });
  }
  bind();

  return {
    // textures: [{ texture: {width,height,data,...}, name }]
    setTextures(list) {
      entries = list.map((t, i) => ({
        texture: t.texture,
        name: t.name ?? `Texture ${i + 1}`,
        original: new Uint8ClampedArray(t.texture.data),
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
      active = entries[0] ?? null;
      $("texture-panel").hidden = entries.length === 0;
      if (active) drawPreview();
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
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
