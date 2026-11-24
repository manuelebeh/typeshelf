/**
 * Browser-only stand-in for the Tauri backend, used by `npm run dev` when the page
 * is opened in a regular browser. It never ships: main.ts loads it only in dev mode
 * outside Tauri. Previews use fonts bundled with macOS.
 */
import type { Collection, Face, FaceDetails, GoogleFamily, Library, Scope, Tag } from "../api";

const SUP = "/System/Library/Fonts/Supplemental";
let n = 0;
const face = (path: string, family: string, style: string, extra: Partial<Face> = {}): Face => ({
  id: `demo-${++n}`,
  path,
  faceIndex: 0,
  psName: `${family}-${style}`.replace(/\s/g, ""),
  family,
  style,
  fullName: `${family} ${style}`,
  weight: 400,
  italic: false,
  mono: false,
  classification: "serif",
  version: "Version 1.0",
  designer: null,
  manufacturer: null,
  license: null,
  copyright: null,
  glyphCount: 600,
  variable: false,
  starred: false,
  addedAt: Date.now() / 1000 - 3600,
  ...extra,
});

const faces: Face[] = [
  face(`${SUP}/Georgia.ttf`, "Georgia", "Regular", { designer: "Matthew Carter" }),
  face(`${SUP}/Georgia Italic.ttf`, "Georgia", "Italic", { italic: true }),
  face(`${SUP}/Georgia Bold.ttf`, "Georgia", "Bold", { weight: 700 }),
  face(`${SUP}/Courier New.ttf`, "Courier New", "Regular", { mono: true, classification: "mono" }),
  face(`${SUP}/Skia.ttf`, "Skia", "Regular", { variable: true, classification: "sans", starred: true }),
  face(`${SUP}/Trebuchet MS.ttf`, "Trebuchet MS", "Regular", { classification: "sans" }),
  face(`${SUP}/Zapfino.ttf`, "Zapfino", "Regular", { classification: "script", addedAt: 0 }),
];

const systemFaces: Face[] = [
  face(`${SUP}/Arial.ttf`, "Arial", "Regular", { classification: "sans" }),
  face(`${SUP}/Arial Bold.ttf`, "Arial", "Bold", { classification: "sans", weight: 700 }),
  face(`${SUP}/Arial Italic.ttf`, "Arial", "Italic", { classification: "sans", italic: true }),
  face(`${SUP}/Verdana.ttf`, "Verdana", "Regular", { classification: "sans" }),
  face(`${SUP}/Times New Roman.ttf`, "Times New Roman", "Regular"),
  face(`${SUP}/Impact.ttf`, "Impact", "Regular", { classification: "display", weight: 900 }),
  face(`${SUP}/Andale Mono.ttf`, "Andale Mono", "Regular", { classification: "mono", mono: true }),
  face(`${SUP}/Apple Chancery.ttf`, "Apple Chancery", "Chancery", { classification: "script" }),
].map((f, i) => ({ ...f, id: `sys-demo-${i}`, addedAt: 1_700_000_000 + i * 86400 }));

const collections: Collection[] = ["Projects", "Brand identity", "Web & screens", "To try"].map((name, i) => ({
  id: `default-col-${i}`,
  name,
  createdAt: i,
}));
const membership: Record<string, string[]> = { "default-col-0": [faces[0].id, faces[1].id, faces[2].id] };
const rule = (field: string, op: string, value = "") => JSON.stringify({ match: "all", conditions: [{ field, op, value }] });
const tags: Tag[] = [
  { id: "default-tag-0", name: "Headings", color: "red", rule: null, createdAt: 0 },
  { id: "default-tag-1", name: "Body text", color: "blue", rule: null, createdAt: 1 },
  { id: "default-tag-2", name: "Handwritten", color: "purple", rule: null, createdAt: 2 },
  { id: "default-tag-3", name: "Fancy", color: "orange", rule: null, createdAt: 3 },
  { id: "default-tag-4", name: "Variable", color: "teal", rule: rule("variable", "isTrue"), createdAt: 4 },
  { id: "default-tag-5", name: "Monospace", color: "gray", rule: rule("mono", "isTrue"), createdAt: 5 },
  { id: "default-tag-6", name: "Script & calligraphy", color: "pink", rule: rule("classification", "is", "script"), createdAt: 6 },
];
const tagMembership: Record<string, string[]> = { "default-tag-0": [faces[6].id] };
const activation: Record<string, Scope> = { [faces[3].path]: "persistent", [faces[4].path]: "temporary" };

const familyFaces = (families: string[]) => faces.filter((f) => families.includes(f.family));

function details(id: string): FaceDetails {
  const f = [...faces, ...systemFaces].find((x) => x.id === id)!;
  const chars: number[] = [];
  for (let c = 0x21; c < 0x7f; c++) chars.push(c);
  for (let c = 0xc0; c < 0x180; c++) chars.push(c);
  return {
    characters: chars,
    charactersTruncated: false,
    features: ["kern", "liga", "onum", "smcp", "ss01", "tnum"],
    axes: f.variable
      ? [
          { tag: "wght", name: "Weight", min: 0.48, default: 1, max: 3.2 },
          { tag: "wdth", name: "Width", min: 0.62, default: 1, max: 1.3 },
        ]
      : [],
    format: "TrueType",
    fileSize: 120_000,
  };
}

// A small slice of the Google Fonts catalogue; the previews still come from Google.
const gf = (family: string, category: string, styles: string[], popularity: number, dateAdded: string, extra: Partial<GoogleFamily> = {}): GoogleFamily => ({
  family,
  category,
  styles,
  axes: [],
  designers: ["Demo Studio"],
  subsets: ["latin", "latin-ext"],
  popularity,
  dateAdded,
  cjk: false,
  ...extra,
});
const weights = (from: number, to: number, italic = false) =>
  Array.from({ length: (to - from) / 100 + 1 }, (_, i) => String(from + i * 100)).flatMap((w) => (italic ? [w, `${w}i`] : [w]));
const googleFamilies: GoogleFamily[] = [
  gf("Inter", "Sans Serif", weights(100, 900, true), 3, "2017-01-26", { axes: [{ tag: "wght", min: 100, max: 900 }] }),
  gf("Roboto", "Sans Serif", weights(100, 900, true), 1, "2013-01-09", { axes: [{ tag: "wght", min: 100, max: 900 }] }),
  gf("Lora", "Serif", weights(400, 700, true), 40, "2011-10-26", { axes: [{ tag: "wght", min: 400, max: 700 }] }),
  gf("Playfair Display", "Serif", weights(400, 900, true), 25, "2012-02-15"),
  gf("Merriweather", "Serif", ["300", "300i", "400", "400i", "700", "700i", "900", "900i"], 18, "2011-04-27"),
  gf("Space Grotesk", "Sans Serif", weights(300, 700), 90, "2020-07-24"),
  gf("Fira Code", "Monospace", weights(300, 700), 120, "2019-12-12"),
  gf("JetBrains Mono", "Monospace", weights(100, 800, true), 110, "2020-11-18"),
  gf("Caveat", "Handwriting", weights(400, 700), 95, "2015-07-08"),
  gf("Dancing Script", "Handwriting", weights(400, 700), 70, "2010-12-08"),
  gf("Bebas Neue", "Display", ["400"], 50, "2019-10-04"),
  gf("Abril Fatface", "Display", ["400"], 200, "2011-12-07"),
  gf("Noto Sans JP", "Sans Serif", weights(100, 900), 15, "2018-03-01", { subsets: ["japanese", "latin"], cjk: true }),
];

const commands: Record<string, (a: any) => unknown> = {
  plugin_api_status: () => ({ port: 47391, enabled: true, listening: true, error: null }),
  plugin_api_config: ({ enabled }: { enabled: boolean }) => ({ port: 47391, enabled, listening: true, error: null }),
  google_catalog: () => ({ fetchedAt: Date.now() / 1000, families: googleFamilies }),
  google_download: async ({ family }: { family: string }) => {
    await new Promise((r) => setTimeout(r, 900));
    const g = googleFamilies.find((x) => x.family === family)!;
    const dir = `/Users/demo/Typeshelf/Fonts/Google Fonts/${family}`;
    const added = g.styles.map((key) => {
      const italic = key.endsWith("i");
      const weight = Number(italic ? key.slice(0, -1) : key);
      return face(`${dir}/${family}-${weight}${italic ? "Italic" : ""}.ttf`, family, `${weight}${italic ? " Italic" : ""}`, {
        weight,
        italic,
        classification: g.category === "Serif" ? "serif" : g.category === "Monospace" ? "mono" : g.category === "Handwriting" ? "script" : g.category === "Display" ? "display" : "sans",
        designer: g.designers[0],
        addedAt: Date.now() / 1000,
      });
    });
    faces.push(...added);
    return { summary: { imported: added.length, skipped: 0, failures: [] }, paths: added.map((f) => f.path) };
  },
  load_library: (): Library => ({ faces, collections, membership, tags, tagMembership, activation, fontsDir: "~/Typeshelf/Fonts" }),
  system_fonts: () => systemFaces,
  // Referencing installed fonts (favourite, tag, collection) records them in the library.
  import_paths: ({ paths }: { paths: string[] }) => {
    const known = new Set(faces.map((f) => f.psName));
    const added = systemFaces.filter((f) => paths.includes(f.path) && !known.has(f.psName));
    faces.push(...added.map((f) => ({ ...f, id: `demo-${++n}`, addedAt: Date.now() / 1000 })));
    return { imported: added.length, skipped: paths.length - added.length, failures: [] };
  },
  remove_families: ({ families }: { families: string[] }) => {
    for (let i = faces.length - 1; i >= 0; i--) if (families.includes(faces[i].family)) faces.splice(i, 1);
    return [];
  },
  set_activation: ({ paths, scope }: { paths: string[]; scope: Scope }) => {
    for (const p of paths) scope === "none" ? delete activation[p] : (activation[p] = scope);
    return [];
  },
  set_starred: ({ family, starred }: { family: string; starred: boolean }) =>
    familyFaces([family]).forEach((f) => (f.starred = starred)),
  create_collection: ({ name }: { name: string }) => {
    const id = `c${collections.length + 1}`;
    collections.push({ id, name, createdAt: 0 });
    return id;
  },
  rename_collection: ({ id, name }: { id: string; name: string }) =>
    collections.filter((c) => c.id === id).forEach((c) => (c.name = name)),
  delete_collection: ({ id }: { id: string }) => collections.splice(collections.findIndex((c) => c.id === id), 1),
  add_to_collection: ({ id, families }: { id: string; families: string[] }) => {
    membership[id] = [...new Set([...(membership[id] ?? []), ...familyFaces(families).map((f) => f.id)])];
  },
  remove_from_collection: ({ id, families }: { id: string; families: string[] }) => {
    const ids = new Set(familyFaces(families).map((f) => f.id));
    membership[id] = (membership[id] ?? []).filter((x) => !ids.has(x));
  },
  create_tag: ({ name, color, rule }: { name: string; color: string; rule: string | null }) => {
    const id = `t${tags.length + 1}`;
    tags.push({ id, name, color, rule, createdAt: 0 });
    return id;
  },
  update_tag: ({ id, name, color, rule }: { id: string; name: string; color: string; rule: string | null }) =>
    tags.filter((t) => t.id === id).forEach((t) => Object.assign(t, { name, color, rule })),
  delete_tag: ({ id }: { id: string }) => tags.splice(tags.findIndex((t) => t.id === id), 1),
  set_tagged: ({ id, families, tagged }: { id: string; families: string[]; tagged: boolean }) => {
    const ids = familyFaces(families).map((f) => f.id);
    const current = new Set(tagMembership[id] ?? []);
    ids.forEach((x) => (tagged ? current.add(x) : current.delete(x)));
    tagMembership[id] = [...current];
  },
  face_details: ({ id }: { id: string }) => details(id),
  // Demo heuristic: Latin-script samples are supported, other scripts are not.
  language_support: ({ samples }: { samples: string[] }) =>
    samples.map((t) => [...t].every((c) => !/\p{L}/u.test(c) || /\p{Script=Latin}/u.test(c))),
};

let callbackId = 0;
(window as any).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  transformCallback: () => ++callbackId,
  convertFileSrc: (id: string) => `/@fs${[...faces, ...systemFaces].find((f) => f.id === id)?.path ?? ""}`,
  invoke: async (cmd: string, args: unknown) => {
    if (cmd.startsWith("plugin:")) return ++callbackId;
    const handler = commands[cmd];
    if (!handler) throw new Error(`Unknown command in demo mode: ${cmd}`);
    return structuredClone(await handler(args));
  },
};
