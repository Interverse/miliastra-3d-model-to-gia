// Sprite sheet slicing popup: automatic grid slicing driven by editable
// parameters, plus full manual override of every frame rectangle. Opens as
// a modal <dialog>; resolves with an ordered list of frame rects (sheet
// pixel coordinates) or null when cancelled.
//
// openSheetEditor(image: {width, height, data|canvas}, initial?, opts?) ->
//   Promise<{ frames: [{x, y, w, h}], params } | null>
//
// opts.onSaveAnimation(frames) — when provided, a "Save as new animation"
// button lets the caller consume the CURRENT slices as a new animation
// without closing the editor (sheets often hold several animations).
import { t } from './i18n.js';

const T = (key, fb) => { const s = t(key); return s && s !== key ? s : fb; };

export function openSheetEditor(bitmap, initial, opts = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet-editor';
    dlg.innerHTML = `
      <div class="se-head">
        <strong>${T('sheet.title', 'Sprite Sheet Slicing')}</strong>
        <span class="se-hint">${T('sheet.hint', 'Wheel = zoom · drag empty space = pan · drag frame = move · drag corner = resize')}</span>
        <button class="se-close secondary">✕</button>
      </div>
      <div class="se-main">
        <div class="se-side">
          <fieldset class="se-params">
            <legend>${T('sheet.auto', 'Automatic slicing')}</legend>
            ${[['cellW', 'Cell Width'], ['cellH', 'Cell Height'], ['padX', 'Horizontal Padding'],
               ['padY', 'Vertical Padding'], ['startX', 'Start X'], ['startY', 'Start Y'],
               ['cols', 'Columns'], ['rows', 'Rows'], ['count', 'Frame Count']]
              .map(([k, label]) => `<label><span>${T('sheet.' + k, label)}</span>
                 <input type="number" data-p="${k}" min="0" step="1"></label>`).join('')}
            <button class="se-reset secondary">${T('sheet.reset', 'Reset to automatic slicing')}</button>
          </fieldset>
          <fieldset class="se-frames">
            <legend>${T('sheet.frames', 'Frames')}</legend>
            <div class="se-list"></div>
            <div class="se-frame-btns">
              <button class="se-add secondary" title="${T('sheet.add', 'Add frame')}">＋</button>
              <button class="se-del secondary" title="${T('sheet.del', 'Delete frame')}">－</button>
              <button class="se-dup secondary" title="${T('sheet.dup', 'Duplicate frame')}">⧉</button>
              <button class="se-up secondary" title="${T('sheet.up', 'Move earlier')}">↑</button>
              <button class="se-down secondary" title="${T('sheet.down', 'Move later')}">↓</button>
            </div>
          </fieldset>
          <div class="se-preview">
            <span>${T('sheet.preview', 'Preview')}</span>
            <canvas class="se-pv" width="96" height="96"></canvas>
          </div>
          <div class="se-error"></div>
        </div>
        <canvas class="se-canvas"></canvas>
      </div>
      <div class="se-foot">
        ${opts.onSaveAnimation
          ? `<button class="se-anim secondary">${T('sheet.saveanim', 'Save slices as new animation')}</button>`
          : ''}
        <span class="se-foot-spacer"></span>
        <button class="se-cancel secondary">${T('btn.cancel', 'Cancel')}</button>
        <button class="se-ok">${T('btn.apply', 'Apply')}</button>
      </div>`;
    document.body.appendChild(dlg);

    const W = bitmap.width, H = bitmap.height;
    // draw source once to an offscreen canvas
    const src = document.createElement('canvas');
    src.width = W; src.height = H;
    src.getContext('2d').drawImage(bitmap, 0, 0);

    // ---------- state ----------
    const params = Object.assign({
      cellW: Math.max(1, Math.round(W / 4)), cellH: Math.max(1, Math.round(H / 4)),
      padX: 0, padY: 0, startX: 0, startY: 0, cols: 4, rows: 4, count: 16,
    }, initial?.params);
    let frames = initial?.frames?.map((f) => ({ ...f })) ?? [];
    let manual = !!initial?.frames?.length; // manual edits present?
    let sel = 0;
    let zoom = Math.min(560 / W, 560 / H, 8);
    let panX = 0, panY = 0;
    let playT = 0;

    const cv = dlg.querySelector('.se-canvas');
    cv.width = 620; cv.height = 560;
    const ctx = cv.getContext('2d');
    const pv = dlg.querySelector('.se-pv').getContext('2d');

    const autoSlice = () => {
      const out = [];
      let n = 0;
      for (let r = 0; r < params.rows && n < params.count; r++) {
        for (let c = 0; c < params.cols && n < params.count; c++) {
          const x = params.startX + c * (params.cellW + params.padX);
          const y = params.startY + r * (params.cellH + params.padY);
          out.push({ x, y, w: params.cellW, h: params.cellH });
          n++;
        }
      }
      return out;
    };
    if (!frames.length) frames = autoSlice();

    // ---------- validation ----------
    const validate = () => {
      const errs = [];
      if (params.cellW < 1 || params.cellH < 1) errs.push(T('sheet.err.cell', 'Cell size must be at least 1 pixel'));
      if (params.cols < 1 || params.rows < 1) errs.push(T('sheet.err.grid', 'Rows and columns must be at least 1'));
      if (params.count < 1) errs.push(T('sheet.err.count', 'Frame count must be at least 1'));
      if (!frames.length) errs.push(T('sheet.err.none', 'No frames defined'));
      frames.forEach((f, i) => {
        if (f.w < 1 || f.h < 1) errs.push(`${T('sheet.err.rect', 'Invalid rectangle for frame')} ${i + 1}`);
        else if (f.x < 0 || f.y < 0 || f.x + f.w > W || f.y + f.h > H) {
          errs.push(`${T('sheet.err.bounds', 'Frame outside the sheet:')} ${i + 1}`);
        }
      });
      dlg.querySelector('.se-error').textContent = errs.slice(0, 2).join(' · ');
      dlg.querySelector('.se-ok').disabled = errs.length > 0;
      return errs.length === 0;
    };

    // ---------- rendering ----------
    const toScreen = (x, y) => [x * zoom + panX, y * zoom + panY];
    const draw = () => {
      ctx.fillStyle = '#14161a';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.imageSmoothingEnabled = zoom < 1;
      ctx.drawImage(src, panX, panY, W * zoom, H * zoom);
      frames.forEach((f, i) => {
        const [sx, sy] = toScreen(f.x, f.y);
        ctx.strokeStyle = i === sel ? '#2d6cdf' : 'rgba(154,163,176,0.75)';
        ctx.lineWidth = i === sel ? 2 : 1;
        ctx.strokeRect(sx, sy, f.w * zoom, f.h * zoom);
        ctx.fillStyle = i === sel ? '#2d6cdf' : 'rgba(154,163,176,0.75)';
        ctx.font = '11px sans-serif';
        ctx.fillText(String(i + 1), sx + 3, sy + 12);
        if (i === sel) { // resize handle
          ctx.fillRect(sx + f.w * zoom - 5, sy + f.h * zoom - 5, 6, 6);
        }
      });
      // live preview: animate through the frames
      const f = frames[Math.floor(playT) % Math.max(1, frames.length)];
      pv.clearRect(0, 0, 96, 96);
      if (f && f.w > 0 && f.h > 0) {
        const k = Math.min(96 / f.w, 96 / f.h);
        pv.imageSmoothingEnabled = false;
        try {
          pv.drawImage(src, f.x, f.y, f.w, f.h,
            (96 - f.w * k) / 2, (96 - f.h * k) / 2, f.w * k, f.h * k);
        } catch { /* out-of-range rects */ }
      }
    };
    const timer = setInterval(() => { playT += 0.35; draw(); }, 120);

    const list = dlg.querySelector('.se-list');
    const renderList = () => {
      list.innerHTML = '';
      frames.forEach((f, i) => {
        const b = document.createElement('button');
        b.className = 'se-item' + (i === sel ? ' sel' : '');
        b.textContent = `${i + 1}: ${f.x},${f.y} ${f.w}×${f.h}`;
        b.addEventListener('click', () => { sel = i; renderAll(); });
        list.appendChild(b);
      });
    };
    const renderParams = () => {
      for (const inp of dlg.querySelectorAll('[data-p]')) inp.value = params[inp.dataset.p];
    };
    const renderAll = () => { renderList(); validate(); draw(); };

    // ---------- interactions ----------
    for (const inp of dlg.querySelectorAll('[data-p]')) {
      inp.addEventListener('input', () => {
        params[inp.dataset.p] = Math.max(0, parseInt(inp.value, 10) || 0);
        if (!manual) frames = autoSlice(); // auto stays live until edited
        renderAll();
      });
    }
    dlg.querySelector('.se-reset').addEventListener('click', () => {
      manual = false;
      frames = autoSlice();
      sel = 0;
      renderAll();
    });
    dlg.querySelector('.se-add').addEventListener('click', () => {
      manual = true;
      frames.push({ x: params.startX, y: params.startY, w: params.cellW, h: params.cellH });
      sel = frames.length - 1;
      renderAll();
    });
    dlg.querySelector('.se-del').addEventListener('click', () => {
      if (!frames.length) return;
      manual = true;
      frames.splice(sel, 1);
      sel = Math.max(0, sel - 1);
      renderAll();
    });
    dlg.querySelector('.se-dup').addEventListener('click', () => {
      if (!frames[sel]) return;
      manual = true;
      frames.splice(sel + 1, 0, { ...frames[sel] });
      sel++;
      renderAll();
    });
    dlg.querySelector('.se-up').addEventListener('click', () => {
      if (sel <= 0) return;
      manual = true;
      [frames[sel - 1], frames[sel]] = [frames[sel], frames[sel - 1]];
      sel--; renderAll();
    });
    dlg.querySelector('.se-down').addEventListener('click', () => {
      if (sel >= frames.length - 1) return;
      manual = true;
      [frames[sel + 1], frames[sel]] = [frames[sel], frames[sel + 1]];
      sel++; renderAll();
    });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const mx = e.offsetX, my = e.offsetY;
      panX = mx - (mx - panX) * k;
      panY = my - (my - panY) * k;
      zoom = Math.min(32, Math.max(0.05, zoom * k));
      draw();
    }, { passive: false });

    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      const px = (e.offsetX - panX) / zoom, py = (e.offsetY - panY) / zoom;
      // hit-test: resize handle of selection, then frames (topmost last)
      const s = frames[sel];
      if (s && Math.abs(px - (s.x + s.w)) < 6 / zoom && Math.abs(py - (s.y + s.h)) < 6 / zoom) {
        drag = { kind: 'resize', f: s };
      } else {
        let hit = -1;
        for (let i = frames.length - 1; i >= 0; i--) {
          const f = frames[i];
          if (px >= f.x && px < f.x + f.w && py >= f.y && py < f.y + f.h) { hit = i; break; }
        }
        if (hit >= 0) {
          sel = hit;
          drag = { kind: 'move', f: frames[hit], ox: px - frames[hit].x, oy: py - frames[hit].y };
          renderList();
        } else {
          drag = { kind: 'pan', sx: e.offsetX - panX, sy: e.offsetY - panY };
        }
      }
      cv.setPointerCapture(e.pointerId);
      draw();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const px = (e.offsetX - panX) / zoom, py = (e.offsetY - panY) / zoom;
      if (drag.kind === 'pan') { panX = e.offsetX - drag.sx; panY = e.offsetY - drag.sy; }
      else if (drag.kind === 'move') {
        manual = true;
        drag.f.x = Math.round(px - drag.ox);
        drag.f.y = Math.round(py - drag.oy);
      } else if (drag.kind === 'resize') {
        manual = true;
        drag.f.w = Math.max(1, Math.round(px - drag.f.x));
        drag.f.h = Math.max(1, Math.round(py - drag.f.y));
      }
      renderList(); validate(); draw();
    });
    cv.addEventListener('pointerup', () => { drag = null; });

    const close = (result) => {
      clearInterval(timer);
      dlg.close();
      dlg.remove();
      resolve(result);
    };
    dlg.querySelector('.se-close').addEventListener('click', () => close(null));
    dlg.querySelector('.se-cancel').addEventListener('click', () => close(null));
    // clicking the backdrop cancels
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(null); });
    // hand the current slices to the caller as a new animation; the editor
    // stays open so further animations can be sliced from the same sheet
    dlg.querySelector('.se-anim')?.addEventListener('click', async () => {
      if (!validate()) return;
      await opts.onSaveAnimation(frames.map((f) => ({ ...f })));
    });
    dlg.querySelector('.se-ok').addEventListener('click', () => {
      if (!validate()) return;
      close({ frames: frames.map((f) => ({ ...f })), params: { ...params } });
    });

    renderParams();
    renderAll();
    dlg.showModal();
  });
}
