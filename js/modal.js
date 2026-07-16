// Small site-styled replacement for the native browser prompt().
//
//   textPrompt({ title, label, value }) -> Promise<string|null>
//
// Renders a compact modal <dialog> that matches the app's panel design.
// Resolves with the trimmed input on OK/Enter, or null on Cancel/Esc.
import { t } from './i18n.js';

const T = (key, fb) => { const s = t(key); return s && s !== key ? s : fb; };

let dlg = null;
let resolver = null;

function ensureDialog() {
  if (dlg) return;
  dlg = document.createElement('dialog');
  dlg.className = 'app-prompt';
  dlg.innerHTML = `
    <div class="ap-head"><strong class="ap-title"></strong></div>
    <label class="ap-body">
      <span class="ap-label"></span>
      <input class="ap-input" type="text">
    </label>
    <div class="ap-foot">
      <button class="ap-cancel secondary"></button>
      <button class="ap-ok"></button>
    </div>`;
  document.body.appendChild(dlg);
  const input = dlg.querySelector('.ap-input');
  const finish = (value) => {
    const r = resolver;
    resolver = null;
    dlg.close();
    r?.(value);
  };
  dlg.querySelector('.ap-ok').addEventListener('click', () => finish(input.value.trim() || null));
  dlg.querySelector('.ap-cancel').addEventListener('click', () => finish(null));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || null); }
  });
  // Esc closes natively — treat it as cancel
  dlg.addEventListener('cancel', () => { const r = resolver; resolver = null; r?.(null); });
  // click on the backdrop cancels
  dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(null); });
}

export function textPrompt({ title, label = '', value = '' } = {}) {
  ensureDialog();
  return new Promise((resolve) => {
    resolver = resolve;
    dlg.querySelector('.ap-title').textContent = title ?? '';
    const lab = dlg.querySelector('.ap-label');
    lab.textContent = label;
    lab.hidden = !label;
    dlg.querySelector('.ap-cancel').textContent = T('btn.cancel', 'Cancel');
    dlg.querySelector('.ap-ok').textContent = T('btn.ok', 'OK');
    const input = dlg.querySelector('.ap-input');
    input.value = value;
    dlg.showModal();
    input.focus();
    input.select();
  });
}
