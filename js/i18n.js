// Lightweight i18n system (no dependencies, no page reload).
//
// - English (en) ships in the bundle and is the fallback for every key, so
//   missing translations degrade to English, never to raw keys or blanks.
// - Other locales live in js/locales/<code>.js and are loaded on demand
//   (dynamic import). Adding a language = adding one file + one LANGS row;
//   no application code changes.
// - Static DOM text binds via data-i18n / data-i18n-title /
//   data-i18n-placeholder attributes; applyI18n() (re)applies the active
//   dictionary. Dynamic strings use t(key, params).
// - Numbers/percentages format through Intl.NumberFormat for the active
//   locale via num()/pct().
//
// Language codes follow the project's convention (zhs/zht for Simplified /
// Traditional Chinese); bcp47 supplies the tag used for Intl, the <html>
// lang attribute, and font selection in CSS.

import en from "./locales/en.js";

export const LANGS = [
  { code: "en", name: "English", bcp47: "en" },
  { code: "zhs", name: "简体中文", bcp47: "zh-Hans" },
  { code: "zht", name: "繁體中文", bcp47: "zh-Hant" },
  { code: "ja", name: "日本語", bcp47: "ja" },
  { code: "ko", name: "한국어", bcp47: "ko" },
  { code: "es", name: "Español", bcp47: "es" },
  { code: "fr", name: "Français", bcp47: "fr" },
  { code: "ru", name: "Русский", bcp47: "ru" },
  { code: "th", name: "ไทย", bcp47: "th" },
  { code: "vi", name: "Tiếng Việt", bcp47: "vi" },
  { code: "de", name: "Deutsch", bcp47: "de" },
  { code: "id", name: "Bahasa Indonesia", bcp47: "id" },
  { code: "pt", name: "Português", bcp47: "pt" },
  { code: "tr", name: "Türkçe", bcp47: "tr" },
  { code: "it", name: "Italiano", bcp47: "it" },
];

// Cross-site language sync (docs/language-sync.md): every Miliastra Toolkit
// site on the interverse.github.io origin shares one localStorage entry.
// Our internal codes are already the canonical 15, so no mapping is needed.
// STORE_KEY's old per-site value is migrated once, then never touched again.
const SHARED_KEY = "miliastra-lang";
const LEGACY_KEY = "gia-lang";
const dicts = { en };
let current = "en";
let dict = en;
const listeners = new Set();

export function currentLang() {
  return current;
}

function bcp47Of(code) {
  return LANGS.find((l) => l.code === code)?.bcp47 ?? "en";
}

// t("key", { n: 5 }) — interpolates {n}; falls back key-by-key to English.
export function t(key, params) {
  let s = dict[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split("{" + k + "}").join(String(v));
    }
  }
  return s;
}

// locale-aware number formatting
let nf = new Intl.NumberFormat("en");
export function num(v, opts) {
  if (v == null || v === "") return "";
  if (typeof v !== "number") return String(v);
  return opts ? new Intl.NumberFormat(bcp47Of(current), opts).format(v) : nf.format(v);
}
export function pct(v) {
  return num(v) + "%";
}

// Apply the active dictionary to every bound element under root.
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}

// Subscribe to language changes (for re-rendering dynamic UI).
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// persist=false applies the language without touching localStorage — used on
// load and for cross-tab sync, where only an explicit user choice may be saved.
export async function setLanguage(code, persist = true) {
  if (!LANGS.some((l) => l.code === code)) code = "en";
  if (!dicts[code]) {
    try {
      dicts[code] = (await import(`./locales/${code}.js`)).default;
    } catch (e) {
      console.warn("i18n: failed to load locale", code, e);
      dicts[code] = {};
    }
  }
  current = code;
  dict = dicts[code];
  nf = new Intl.NumberFormat(bcp47Of(code));
  if (persist) {
    try {
      localStorage.setItem(SHARED_KEY, code);
    } catch {}
  }
  document.documentElement.lang = bcp47Of(code);
  applyI18n(document);
  for (const fn of listeners) fn(code);
}

// Pick the saved language, or the closest match to the browser language.
// An invalid stored value is ignored (another site may understand it).
export function detectLanguage() {
  try {
    const saved = localStorage.getItem(SHARED_KEY);
    if (saved && LANGS.some((l) => l.code === saved)) return saved;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && LANGS.some((l) => l.code === legacy)) {
      localStorage.setItem(SHARED_KEY, legacy);
      localStorage.removeItem(LEGACY_KEY);
      return legacy;
    }
  } catch {}
  const cands = navigator.languages || [navigator.language || "en"];
  for (const cand of cands) {
    const nav = String(cand).toLowerCase();
    if (nav.startsWith("zh")) {
      return /tw|hk|mo|hant/.test(nav) ? "zht" : "zhs";
    }
    const two = nav.slice(0, 2);
    if (LANGS.some((l) => l.code === two)) return two;
  }
  return "en";
}

// Initialize: apply saved/detected language (async for non-English).
// Never persists — only an explicit user choice writes the shared key.
export function initI18n() {
  // Live sync: a language picked on another toolkit site (or tab) applies
  // here without a reload. Must not write back — that could ping-pong.
  window.addEventListener("storage", (e) => {
    if (e.key !== SHARED_KEY || !e.newValue) return;
    if (LANGS.some((l) => l.code === e.newValue) && e.newValue !== current) {
      setLanguage(e.newValue, false);
    }
  });
  const lang = detectLanguage();
  if (lang === "en") {
    document.documentElement.lang = "en";
    applyI18n(document);
    return Promise.resolve();
  }
  return setLanguage(lang, false);
}
