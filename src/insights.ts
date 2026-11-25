/** Rules that pick which duplicate files to remove. No DOM here: the interface is in main.ts. */
import type { DuplicateCopy, DuplicateGroup } from "./api";

export type SelectRule = "inactive" | "namedCopy" | "older" | "smaller";

/** "Version 2.001;PS 1.0" → 2.001; 0 when the font states none. */
export const versionNumber = (version: string | null) => Number(version?.match(/\d+(\.\d+)?/)?.[0] ?? 0);

export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** "Inter copy.ttf", "Inter - Copie.ttf", "Inter 2.ttf" (how Typeshelf and Finder rename), "Inter (1).ttf". */
const looksLikeCopy = (path: string) => /\bcop(y|ie)\b| \d+$|\(\d+\)$/i.test(fileName(path).replace(/\.[^.]+$/, ""));

const byAge = (a: DuplicateCopy, b: DuplicateCopy) => versionNumber(a.version) - versionNumber(b.version) || a.modified - b.modified;

/** Higher is more worth keeping. */
const byWorth = (a: DuplicateCopy, b: DuplicateCopy) =>
  Number(a.active) - Number(b.active) || Number(!a.trashable) - Number(!b.trashable) || byAge(a, b) || a.fileSize - b.fileSize;

const RULES: Record<SelectRule, (copy: DuplicateCopy, group: DuplicateGroup) => boolean> = {
  inactive: (copy) => !copy.active,
  namedCopy: (copy) => looksLikeCopy(copy.path),
  older: (copy, group) => group.copies.some((other) => byAge(other, copy) > 0),
  smaller: (copy, group) => group.copies.some((other) => other.fileSize > copy.fileSize),
};

/**
 * Adds to `selected` the files of `shown` that match `rule`. A rule never picks a protected
 * file, nor one holding a font found nowhere else, and always leaves one copy of every font.
 */
export function selectByRule(rule: SelectRule, shown: DuplicateGroup[], all: DuplicateGroup[], selected: Set<string>): Set<string> {
  const next = new Set(selected);
  for (const group of shown) {
    for (const copy of group.copies) {
      if (copy.trashable && copy.otherFacesRedundant && RULES[rule](copy, group)) next.add(copy.path);
    }
  }
  for (const group of all) {
    if (group.copies.every((c) => next.has(c.path))) next.delete(group.copies.reduce((best, c) => (byWorth(c, best) > 0 ? c : best)).path);
  }
  return next;
}

/** What removing `selected` would cost, for the confirmation. */
export function selectionImpact(groups: DuplicateGroup[], selected: Set<string>) {
  const files = new Map(groups.flatMap((g) => g.copies).filter((c) => selected.has(c.path)).map((c) => [c.path, c]));
  return {
    files: files.size,
    bytes: [...files.values()].reduce((sum, c) => sum + c.fileSize, 0),
    /** Fonts with no copy left. */
    lost: groups.filter((g) => g.copies.every((c) => selected.has(c.path))).length,
    /** Files that also hold fonts found in no other file. */
    exclusive: [...files.values()].filter((c) => !c.otherFacesRedundant).length,
  };
}
