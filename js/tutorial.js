// Interactive step-by-step tutorial: spotlights each major section of the
// interface with a short localized explanation. Launched from the floating
// Tutorial button (#btn-tutorial); a one-time welcome bubble points new
// visitors at it. No dependencies — plain DOM + the i18n system.

import { t, onLangChange } from "./i18n.js";

const SEEN_KEY = "gia-tutorial-seen";

// Each step spotlights one element. `open` expands a collapsible panel
// first; steps whose target is missing or hidden are skipped automatically,
// so the same tour works on both pages and with optional panels.
const STEPS = [
  { id: "panel-model", key: "tut.model", open: true },
  { id: "panel-transform", key: "tut.transform", open: true },
  { id: "panel-params", key: "tut.params", open: true },
  { id: "btn-generate", key: "tut.generate" },
  { id: "vp-toolbar", key: "tut.toolbar" },
  { id: "nav-widget", key: "tut.nav" },
  { id: "panel-scene", key: "tut.scene", open: true },
  { id: "panel-selection", key: "tut.selection", open: true },
  { id: "panel-stats", key: "tut.stats", open: true },
  { id: "panel-optimize", key: "tut.optimize", open: true },
  { id: "rb-actions", key: "tut.output" },
  { id: "lang-row", key: "tut.lang" },
];

export function initTutorial() {
  const btn = document.getElementById("btn-tutorial");
  if (!btn) return;

  let overlay = null; // { root, hole, pop }
  let steps = [];
  let idx = 0;

  const seen = () => {
    try {
      return localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      return true;
    }
  };
  const markSeen = () => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {}
  };

  // ---------- welcome bubble (first visit only) ----------
  function showWelcome() {
    const bub = document.createElement("div");
    bub.id = "tut-welcome";
    const msg = document.createElement("span");
    msg.textContent = t("tut.welcome");
    const start = document.createElement("button");
    start.className = "mini";
    start.textContent = t("tut.start");
    start.addEventListener("click", () => {
      bub.remove();
      startTour();
    });
    const x = document.createElement("button");
    x.className = "mini tut-x";
    x.textContent = "✕";
    x.addEventListener("click", () => {
      markSeen();
      bub.remove();
    });
    bub.append(msg, start, x);
    document.getElementById("viewport").appendChild(bub);
  }

  // ---------- tour ----------
  const visible = (el) => el && el.offsetParent !== null;

  function startTour() {
    markSeen();
    endTour();
    steps = STEPS.filter((s) => visible(document.getElementById(s.id)));
    if (!steps.length) return;
    idx = 0;
    const root = document.createElement("div");
    root.id = "tut-overlay";
    const hole = document.createElement("div");
    hole.className = "tut-hole";
    const pop = document.createElement("div");
    pop.className = "tut-pop";
    root.append(hole, pop);
    document.body.appendChild(root);
    overlay = { root, hole, pop };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", position);
    renderStep();
  }

  function endTour() {
    overlay?.root.remove();
    overlay = null;
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", position);
  }

  function onKey(e) {
    if (!overlay) return;
    if (e.key === "Escape") endTour();
    else if (e.key === "ArrowRight" || e.key === "Enter") next();
    else if (e.key === "ArrowLeft") back();
  }

  const next = () => {
    if (idx >= steps.length - 1) endTour();
    else {
      idx++;
      renderStep();
    }
  };
  const back = () => {
    if (idx > 0) {
      idx--;
      renderStep();
    }
  };

  function renderStep() {
    if (!overlay) return;
    const s = steps[idx];
    const el = document.getElementById(s.id);
    if (!el) return next();
    if (s.open && el.tagName === "DETAILS") el.open = true;
    el.scrollIntoView({ block: "nearest" });

    const { pop } = overlay;
    pop.innerHTML = "";
    const h = document.createElement("h3");
    h.textContent = t(s.key + ".t");
    const body = document.createElement("div");
    body.className = "tut-body";
    body.textContent = t(s.key + ".b");
    const bar = document.createElement("div");
    bar.className = "tut-bar";
    const prog = document.createElement("span");
    prog.className = "tut-prog";
    prog.textContent = `${idx + 1} / ${steps.length}`;
    const bBack = document.createElement("button");
    bBack.className = "mini";
    bBack.textContent = t("tut.back");
    bBack.disabled = idx === 0;
    bBack.addEventListener("click", back);
    const bNext = document.createElement("button");
    bNext.className = "mini tut-next";
    bNext.textContent = t(idx === steps.length - 1 ? "tut.done" : "tut.next");
    bNext.addEventListener("click", next);
    const bSkip = document.createElement("button");
    bSkip.className = "mini tut-x";
    bSkip.textContent = t("tut.skip");
    bSkip.addEventListener("click", endTour);
    bar.append(prog, bBack, bNext, bSkip);
    pop.append(h, body, bar);
    // position after the panel has expanded/scrolled
    requestAnimationFrame(position);
  }

  function position() {
    if (!overlay) return;
    const s = steps[idx];
    const el = document.getElementById(s.id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    const { hole, pop } = overlay;
    hole.style.left = r.left - pad + "px";
    hole.style.top = r.top - pad + "px";
    hole.style.width = r.width + pad * 2 + "px";
    hole.style.height = r.height + pad * 2 + "px";

    // popover beside the target: right of left-half targets, left otherwise
    const pw = Math.min(340, window.innerWidth - 24);
    pop.style.width = pw + "px";
    const cx = r.left + r.width / 2;
    let left =
      cx < window.innerWidth / 2 ? r.right + 14 : r.left - pw - 14;
    left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
    let top = r.top;
    const ph = pop.offsetHeight || 160;
    top = Math.max(12, Math.min(top, window.innerHeight - ph - 12));
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  btn.addEventListener("click", () => {
    document.getElementById("tut-welcome")?.remove();
    startTour();
  });

  // language switch mid-tour: re-render the current step's texts
  onLangChange(() => {
    if (overlay) renderStep();
  });

  if (!seen()) showWelcome();
}
