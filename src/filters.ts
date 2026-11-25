import type { Face } from "./api";

/** The list filters and the smart sets built from them. No DOM: the interface is in main.ts. */

export type Status = "any" | "active" | "temporary" | "inactive";
export type Source = "any" | "system" | "library";
export type Range = [number, number];

export interface Filter {
  status: Status;
  source: Source;
  classes: Set<string>;
  variable: boolean;
  mono: boolean;
  italic: boolean;
  /** usWeightClass; a bound sitting on the end of the scale is open (a 950 passes "up to 900"). */
  weight: Range;
  /** usWidthClass. */
  width: Range;
  /** OpenType tags the family must all offer. */
  features: Set<string>;
}

export const WEIGHT_SCALE: Range = [100, 900];
export const WIDTH_SCALE: Range = [1, 9];

export const WEIGHT_PRESETS = { light: [100, 300], regular: [400, 500], bold: [600, 900] } satisfies Record<string, Range>;
export const WIDTH_PRESETS = { narrow: [1, 4], normal: [5, 5], wide: [6, 9] } satisfies Record<string, Range>;

export const sameRange = (a: Range, b: Range) => a[0] === b[0] && a[1] === b[1];

export const emptyFilter = (): Filter => ({
  status: "any",
  source: "any",
  classes: new Set(),
  variable: false,
  mono: false,
  italic: false,
  weight: [...WEIGHT_SCALE],
  width: [...WIDTH_SCALE],
  features: new Set(),
});

export const filterCount = (f: Filter): number =>
  Number(f.status !== "any") +
  Number(f.source !== "any") +
  f.classes.size +
  Number(f.variable) +
  Number(f.mono) +
  Number(f.italic) +
  Number(!sameRange(f.weight, WEIGHT_SCALE)) +
  Number(!sameRange(f.width, WIDTH_SCALE)) +
  f.features.size;

const within = (value: number, [from, to]: Range, [min, max]: Range) =>
  (from <= min || value >= from) && (to >= max || value <= to);

export interface Filtered {
  faces: Face[];
  system: boolean;
  variable: boolean;
  classification: string;
}

/**
 * Weight and width must hold for the same style (so "bold + narrow" means a bold narrow one);
 * a variable font only counts with its default instance. `hasStatus` answers for activation.
 */
export function passesFilter(f: Filter, fam: Filtered, hasStatus: (status: Status) => boolean): boolean {
  if (f.status !== "any" && !hasStatus(f.status)) return false;
  if (f.source === "system" && !fam.system) return false;
  if (f.source === "library" && fam.system) return false;
  if (f.classes.size && !f.classes.has(fam.classification)) return false;
  if (f.variable && !fam.variable) return false;
  if (f.mono && !fam.faces.some((x) => x.mono)) return false;
  if (f.italic && !fam.faces.some((x) => x.italic)) return false;
  if (!fam.faces.some((x) => within(x.weight, f.weight, WEIGHT_SCALE) && within(x.width, f.width, WIDTH_SCALE))) return false;
  for (const tag of f.features) if (!fam.faces.some((x) => x.features.includes(tag))) return false;
  return true;
}

export function matchesSearch(faces: Face[], search: string): boolean {
  const q = search.trim().toLowerCase();
  return (
    !q ||
    faces.some((f) => [f.family, f.style, f.psName, f.designer ?? "", f.manufacturer ?? ""].some((v) => v.toLowerCase().includes(q)))
  );
}

/** What a smart set remembers: where one was looking, what was typed and which filters were on. */
export interface Query {
  /** Sidebar key ("all", "col:…", "tag:…"); never another smart set. */
  scope: string;
  search: string;
  filter: Filter;
}

export const serializeQuery = ({ scope, search, filter }: Query): string =>
  JSON.stringify({
    scope,
    search: search.trim(),
    filter: { ...filter, classes: [...filter.classes], features: [...filter.features] },
  });

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;
const strings = (value: unknown) => new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const range = (value: unknown, fallback: Range): Range =>
  Array.isArray(value) && value.length === 2 && value.every((v) => Number.isFinite(v)) ? [value[0], value[1]] : [...fallback];

/** Reads a stored query; anything missing or malformed falls back to "no condition". */
export function parseQuery(json: string): Query | null {
  try {
    const raw = JSON.parse(json);
    const f = raw?.filter ?? {};
    const scope = typeof raw?.scope === "string" && !raw.scope.startsWith("set:") ? raw.scope : "all";
    return {
      scope,
      search: typeof raw?.search === "string" ? raw.search : "",
      filter: {
        status: oneOf(f.status, ["any", "active", "temporary", "inactive"], "any"),
        source: oneOf(f.source, ["any", "system", "library"], "any"),
        classes: strings(f.classes),
        variable: f.variable === true,
        mono: f.mono === true,
        italic: f.italic === true,
        weight: range(f.weight, WEIGHT_SCALE),
        width: range(f.width, WIDTH_SCALE),
        features: strings(f.features),
      },
    };
  } catch {
    return null;
  }
}
