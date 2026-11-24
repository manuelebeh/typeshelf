// Fails when a string passed to t(), tn() or N_(), or a data-i18n text in index.html,
// has no French entry in src/locales/fr.ts.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dictionary = readFileSync(join(root, "src/locales/fr.ts"), "utf8");
const known = new Set();
for (const m of dictionary.matchAll(/^\s*("(?:[^"\\]|\\.)*"):/gm)) known.add(JSON.parse(m[1]));

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "locales" ? [] : sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const used = new Map();
const note = (text, where) => used.has(text) || used.set(text, where);
const literal = '("(?:[^"\\\\]|\\\\.)*")';
const calls = [
  new RegExp(`\\b(?:t|N_)\\(\\s*${literal}`, "g"),
  new RegExp(`\\btn\\(\\s*[^,]+,\\s*${literal}\\s*,\\s*${literal}`, "g"),
];
for (const file of sources(join(root, "src"))) {
  const text = readFileSync(file, "utf8");
  for (const re of calls) {
    for (const m of text.matchAll(re)) for (const g of m.slice(1)) note(JSON.parse(g), file);
  }
}

const html = readFileSync(join(root, "index.html"), "utf8");
for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*\bdata-i18n(?:-html)?(?=[\s>])[^>]*>([\s\S]*?)<\/\1>/g)) {
  note(m[2].replace(/\s+/g, " ").trim(), "index.html");
}
for (const m of html.matchAll(/<[^>]*\bdata-i18n-attr="([^"]+)"[^>]*>/g)) {
  for (const attr of m[1].split(",")) {
    const value = m[0].match(new RegExp(`\\b${attr.trim()}="([^"]*)"`));
    if (value) note(value[1], "index.html");
  }
}

const missing = [...used].filter(([text]) => text && !known.has(text));
if (missing.length) {
  for (const [text, where] of missing) console.error(`missing French entry: ${JSON.stringify(text)} (${where.replace(root, "")})`);
  process.exit(1);
}
console.log(`i18n: ${used.size} strings, all translated`);
