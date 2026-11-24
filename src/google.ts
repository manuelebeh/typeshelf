/** Google Fonts catalogue helpers: categories, sorting and on-demand web previews. */
import type { GoogleFamily } from "./api";
import { t } from "./i18n";

/** Google categories mapped to Typeshelf classifications. */
const CLASS_OF: Record<string, string> = {
  "Sans Serif": "sans",
  Serif: "serif",
  Display: "display",
  Handwriting: "script",
  Monospace: "mono",
};

export const googleClassLabels = (): Record<string, string> => ({
  sans: t("Sans serif"),
  serif: t("Serif"),
  display: t("Display"),
  script: t("Handwriting"),
  mono: t("Monospace"),
});

export const classOf = (f: GoogleFamily) => CLASS_OF[f.category] ?? "other";
export const categoryLabel = (f: GoogleFamily) => googleClassLabels()[classOf(f)] ?? f.category;

export type GoogleSort = "popular" | "name" | "name-desc" | "recent" | "styles";

export const googleSortLabels = (): Record<GoogleSort, string> => ({
  popular: t("Popularity"),
  name: t("Name (A → Z)"),
  "name-desc": t("Name (Z → A)"),
  recent: t("Date published (newest first)"),
  styles: t("Number of styles"),
});

export interface GoogleFilter {
  classes: Set<string>;
  variable: boolean;
  italic: boolean;
  hideInstalled: boolean;
}

export const emptyGoogleFilter = (): GoogleFilter => ({ classes: new Set(), variable: false, italic: false, hideInstalled: false });

export const googleFilterCount = (f: GoogleFilter) => f.classes.size + Number(f.variable) + Number(f.italic) + Number(f.hideInstalled);

/** "700i" → { italic: true, weight: 700 } */
export function parseStyle(key: string) {
  const italic = key.endsWith("i");
  return { italic, weight: Number(italic ? key.slice(0, -1) : key) };
}

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

export function styleLabel(key: string): string {
  const { italic, weight } = parseStyle(key);
  const name = WEIGHT_NAMES[weight] ?? String(weight);
  return italic ? (weight === 400 ? "Italic" : `${name} Italic`) : name;
}

export const hasItalic = (f: GoogleFamily) => f.styles.some((s) => s.endsWith("i"));

/** The style shown on cards: Regular when there is one. */
export const repStyle = (f: GoogleFamily) => (f.styles.includes("400") ? "400" : (f.styles[0] ?? "400"));

/** CSS font-family value; catalogue names are plain words, keep it that way inside style="". */
export const cssFamily = (f: GoogleFamily) => `'${f.family.replace(/[^\p{L}\p{N} -]/gu, "")}', var(--fallback-font, sans-serif)`;

function cssURL(f: GoogleFamily, styles: string[]): string {
  const tuples = styles
    .map(parseStyle)
    .sort((a, b) => Number(a.italic) - Number(b.italic) || a.weight - b.weight)
    .map((s) => `${s.italic ? 1 : 0},${s.weight}`)
    .join(";");
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.family).replace(/%20/g, "+")}:ital,wght@${tuples}&display=swap`;
}

const loaded = new Set<string>();

/** Adds the Google stylesheet for a family (one style for cards, all styles for the detail). */
export function loadPreview(f: GoogleFamily, allStyles = false) {
  const url = cssURL(f, allStyles ? f.styles : [repStyle(f)]);
  if (loaded.has(url)) return;
  loaded.add(url);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  document.head.appendChild(link);
}

export function sortGoogle(list: GoogleFamily[], sort: GoogleSort): GoogleFamily[] {
  const byName = (a: GoogleFamily, b: GoogleFamily) => a.family.localeCompare(b.family, undefined, { sensitivity: "base" });
  const compare: Record<GoogleSort, (a: GoogleFamily, b: GoogleFamily) => number> = {
    popular: (a, b) => a.popularity - b.popularity || byName(a, b),
    name: byName,
    "name-desc": (a, b) => byName(b, a),
    recent: (a, b) => b.dateAdded.localeCompare(a.dateAdded) || byName(a, b),
    styles: (a, b) => b.styles.length - a.styles.length || byName(a, b),
  };
  return [...list].sort(compare[sort]);
}

/** Folder name the backend uses for a downloaded family (same rule as `google::safe_name`). */
export const folderName = (family: string) => family.replace(/[/\\:*?"<>|\p{Cc}]/gu, "-");
