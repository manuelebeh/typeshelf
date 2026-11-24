import type { Face } from "./api";
import { N_ } from "./i18n";

/** Smart tag rules: a family matches when one of its styles satisfies the conditions. */

export type Field =
  | "family"
  | "style"
  | "designer"
  | "manufacturer"
  | "classification"
  | "weight"
  | "glyphs"
  | "italic"
  | "mono"
  | "variable"
  | "starred"
  | "active"
  | "addedDays";

export type Op = "contains" | "notContains" | "is" | "isNot" | "gte" | "lte" | "isTrue" | "isFalse" | "within";

export interface Condition {
  field: Field;
  op: Op;
  value: string;
}

export interface Rule {
  match: "all" | "any";
  conditions: Condition[];
}

type Kind = "text" | "enum" | "number" | "bool" | "days";

export const FIELDS: Record<Field, { label: string; kind: Kind }> = {
  family: { label: N_("Family"), kind: "text" },
  style: { label: N_("Style"), kind: "text" },
  designer: { label: N_("Designer"), kind: "text" },
  manufacturer: { label: N_("Foundry"), kind: "text" },
  classification: { label: N_("Classification"), kind: "enum" },
  weight: { label: N_("Weight"), kind: "number" },
  glyphs: { label: N_("Glyph count"), kind: "number" },
  italic: { label: N_("Italic"), kind: "bool" },
  mono: { label: N_("Monospaced"), kind: "bool" },
  variable: { label: N_("Variable"), kind: "bool" },
  starred: { label: N_("Favorite"), kind: "bool" },
  active: { label: N_("Activated"), kind: "bool" },
  addedDays: { label: N_("Added"), kind: "days" },
};

export const OPS: Record<Kind, { op: Op; label: string }[]> = {
  text: [
    { op: "contains", label: N_("contains") },
    { op: "notContains", label: N_("does not contain") },
    { op: "is", label: N_("is") },
    { op: "isNot", label: N_("is not") },
  ],
  enum: [
    { op: "is", label: N_("is") },
    { op: "isNot", label: N_("is not") },
  ],
  number: [
    { op: "gte", label: "≥" },
    { op: "lte", label: "≤" },
    { op: "is", label: "=" },
  ],
  bool: [
    { op: "isTrue", label: N_("yes") },
    { op: "isFalse", label: N_("no") },
  ],
  days: [{ op: "within", label: N_("within the last (days)") }],
};

export const defaultCondition = (field: Field = "family"): Condition => {
  const kind = FIELDS[field].kind;
  return { field, op: OPS[kind][0].op, value: kind === "enum" ? "sans" : kind === "days" ? "30" : "" };
};

/** Parses a stored rule, dropping anything malformed. */
export function parseRule(json: string | null): Rule | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    const conditions = Array.isArray(raw?.conditions) ? raw.conditions : [];
    return {
      match: raw?.match === "any" ? "any" : "all",
      conditions: conditions.filter(
        (c: any): c is Condition =>
          c && c.field in FIELDS && OPS[FIELDS[c.field as Field].kind].some((o) => o.op === c.op) && typeof c.value === "string",
      ),
    };
  } catch {
    return null;
  }
}

export interface FamilyFacts {
  faces: Face[];
  starred: boolean;
  active: boolean;
}

function test(c: Condition, face: Face, fam: FamilyFacts, now: number): boolean {
  const kind = FIELDS[c.field].kind;
  if (kind === "bool") {
    const value =
      c.field === "starred" ? fam.starred : c.field === "active" ? fam.active : Boolean(face[c.field as "italic" | "mono" | "variable"]);
    return c.op === "isTrue" ? value : !value;
  }
  if (kind === "days") {
    const days = Number(c.value);
    return Number.isFinite(days) && face.addedAt >= now - days * 86400;
  }
  if (kind === "number") {
    const value = c.field === "weight" ? face.weight : face.glyphCount;
    const target = Number(c.value);
    if (!Number.isFinite(target)) return false;
    return c.op === "gte" ? value >= target : c.op === "lte" ? value <= target : value === target;
  }
  const actual = String((c.field === "classification" ? face.classification : face[c.field as "family"]) ?? "").toLowerCase();
  const expected = c.value.trim().toLowerCase();
  switch (c.op) {
    case "contains":
      return actual.includes(expected);
    case "notContains":
      return !actual.includes(expected);
    case "is":
      return actual === expected;
    case "isNot":
      return actual !== expected;
    default:
      return false;
  }
}

/** An empty rule matches nothing, so a freshly created smart tag starts empty. */
export function matchesRule(rule: Rule, fam: FamilyFacts, now = Date.now() / 1000): boolean {
  if (!rule.conditions.length) return false;
  return fam.faces.some((face) =>
    rule.match === "all"
      ? rule.conditions.every((c) => test(c, face, fam, now))
      : rule.conditions.some((c) => test(c, face, fam, now)),
  );
}
