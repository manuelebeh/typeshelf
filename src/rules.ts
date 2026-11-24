import type { Face } from "./api";

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
  family: { label: "Famille", kind: "text" },
  style: { label: "Style", kind: "text" },
  designer: { label: "Créateur", kind: "text" },
  manufacturer: { label: "Fonderie", kind: "text" },
  classification: { label: "Classification", kind: "enum" },
  weight: { label: "Graisse", kind: "number" },
  glyphs: { label: "Nombre de glyphes", kind: "number" },
  italic: { label: "Italique", kind: "bool" },
  mono: { label: "Chasse fixe", kind: "bool" },
  variable: { label: "Variable", kind: "bool" },
  starred: { label: "Favori", kind: "bool" },
  active: { label: "Active", kind: "bool" },
  addedDays: { label: "Ajoutée", kind: "days" },
};

export const OPS: Record<Kind, { op: Op; label: string }[]> = {
  text: [
    { op: "contains", label: "contient" },
    { op: "notContains", label: "ne contient pas" },
    { op: "is", label: "est" },
    { op: "isNot", label: "n'est pas" },
  ],
  enum: [
    { op: "is", label: "est" },
    { op: "isNot", label: "n'est pas" },
  ],
  number: [
    { op: "gte", label: "≥" },
    { op: "lte", label: "≤" },
    { op: "is", label: "=" },
  ],
  bool: [
    { op: "isTrue", label: "oui" },
    { op: "isFalse", label: "non" },
  ],
  days: [{ op: "within", label: "dans les derniers (jours)" }],
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
