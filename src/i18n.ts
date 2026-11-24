import { fr } from "./locales/fr";

/** "auto" follows the system language; the others force one. */
export type Language = "auto" | "en" | "fr";
export type Locale = "en" | "fr";

const DICTIONARIES: Record<Locale, Record<string, string>> = { en: {}, fr };

let current: Locale = "en";

/** Resolves a preference to a supported locale, falling back to English. */
export function resolveLocale(pref: Language, system = typeof navigator === "undefined" ? "en" : navigator.language): Locale {
  if (pref === "en" || pref === "fr") return pref;
  return system.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function setLanguage(pref: Language) {
  current = resolveLocale(pref);
  if (typeof document !== "undefined") document.documentElement.lang = current;
}

export const locale = () => current;

/** BCP 47 tag for dates and number formatting. */
export const dateLocale = () => (current === "fr" ? "fr-FR" : "en-US");

/**
 * Translates an English text. The English text is the key, so a missing translation shows English.
 * `{name}` placeholders are filled from `vars`.
 */
export function t(text: string, vars?: Record<string, string | number>): string {
  const translated = DICTIONARIES[current][text] ?? text;
  return vars ? translated.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : translated;
}

/** Picks the singular or plural text for `n` (0 and 1 are singular in French) and fills `{n}`. */
export function tn(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  const singular = current === "fr" ? n < 2 : n === 1;
  return t(singular ? one : other, { n, ...vars });
}

/** Marks a text for translation where it is declared; translate it with `t()` where it is shown. */
export const N_ = (text: string) => text;

/** Translates the static markup of index.html: data-i18n (text), data-i18n-html, data-i18n-attr="title,placeholder". */
export function translateStatic(root: ParentNode = document) {
  const original = (el: Element, name: string, value: string) => {
    const key = `i18n${name}`;
    const dataset = (el as HTMLElement).dataset;
    dataset[key] ??= value;
    return dataset[key]!;
  };
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(original(el, "Text", el.textContent ?? ""));
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(original(el, "Html", el.innerHTML.trim()));
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-attr]").forEach((el) => {
    for (const attr of el.dataset.i18nAttr!.split(",").map((a) => a.trim())) {
      el.setAttribute(attr, t(original(el, `Attr_${attr.trim().replace(/\W/g, "_")}`, el.getAttribute(attr) ?? "")));
    }
  });
}
