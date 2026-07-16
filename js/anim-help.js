// "How to Use Animations" help dialog: a paged image viewer over the
// tutorial screenshots in assets/help/. Pages are data-driven — add an
// entry to PAGES to extend the tutorial without touching the UI.
import { t } from './i18n.js';

const PAGES = [
  { img: 'assets/help/PauseAnim.webp', key: 'animhelp.pause', fallback: 'How to Pause Animation' },
  { img: 'assets/help/ChangeAnim.webp', key: 'animhelp.change', fallback: 'How to Change Animations' },
  { img: 'assets/help/OneTimeAnimationFinished.webp', key: 'animhelp.oneshot', fallback: 'Run Code When One-Time Animation Finished' },
  { img: 'assets/help/WhenFrameStarts.webp', key: 'animhelp.frame', fallback: 'Run Code When Animation Frame Starts' },
];

let dlg = null;
let page = 0;
let zoomed = false;

const T = (key, fb) => { const s = t(key); return s && s !== key ? s : fb; };

function title(p) {
  return T(p.key, p.fallback);
}

function render() {
  const p = PAGES[page];
  // fixed window title; the per-page caption sits right below the image
  dlg.querySelector('.ah-title').textContent = T('animhelp.title', 'Node Graph Tutorial');
  dlg.querySelector('.ah-caption').textContent = title(p);
  // dynamic dialog: applyI18n never runs here, fill texts directly
  dlg.querySelector('.ah-prev').innerHTML = `◀ ${T('animhelp.prev', 'Previous')}`;
  dlg.querySelector('.ah-next').innerHTML = `${T('animhelp.next', 'Next')} ▶`;
  dlg.querySelector('.ah-zoom').title = T('animhelp.zoom', 'Toggle zoom');
  dlg.querySelector('.ah-close').title = T('animhelp.close', 'Close');
  dlg.querySelector('.ah-count').textContent = `${page + 1} / ${PAGES.length}`;
  const img = dlg.querySelector('.ah-img');
  img.src = p.img;
  img.classList.toggle('zoomed', zoomed);
  dlg.querySelector('.ah-prev').disabled = page === 0;
  dlg.querySelector('.ah-next').disabled = page === PAGES.length - 1;
  // lazy-preload neighbours for snappy paging
  for (const n of [page - 1, page + 1]) {
    if (PAGES[n]) { const pre = new Image(); pre.src = PAGES[n].img; }
  }
}

export function openAnimHelp() {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'anim-help';
    dlg.innerHTML = `
      <div class="ah-head">
        <strong class="ah-title"></strong>
        <span class="ah-count"></span>
        <button class="ah-close secondary">✕</button>
      </div>
      <div class="ah-body"><img class="ah-img" alt=""></div>
      <div class="ah-caption"></div>
      <div class="ah-nav">
        <button class="ah-prev secondary"></button>
        <button class="ah-zoom secondary">🔍</button>
        <button class="ah-next secondary"></button>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('.ah-close').addEventListener('click', () => dlg.close());
    dlg.querySelector('.ah-prev').addEventListener('click', () => { page = Math.max(0, page - 1); zoomed = false; render(); });
    dlg.querySelector('.ah-next').addEventListener('click', () => { page = Math.min(PAGES.length - 1, page + 1); zoomed = false; render(); });
    const toggleZoom = () => { zoomed = !zoomed; render(); };
    dlg.querySelector('.ah-zoom').addEventListener('click', toggleZoom);
    dlg.querySelector('.ah-img').addEventListener('click', toggleZoom);
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') dlg.querySelector('.ah-prev').click();
      if (e.key === 'ArrowRight') dlg.querySelector('.ah-next').click();
    });
    // clicking the backdrop closes the dialog
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  }
  page = 0;
  zoomed = false;
  render();
  dlg.showModal();
}
