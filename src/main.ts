import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, fontURL, type Face, type FaceDetails, type GoogleCatalog, type GoogleFamily, type Library, type PluginActivity, type PluginApiStatus, type Scope, type Tag } from "./api";
import {
  categoryLabel,
  classOf,
  cssFamily,
  emptyGoogleFilter,
  folderName,
  GOOGLE_CLASSES,
  GOOGLE_SORTS,
  googleFilterCount,
  hasItalic,
  loadPreview,
  parseStyle,
  sortGoogle,
  styleLabel,
  type GoogleSort,
} from "./google";
import { hydrateIcons, icon } from "./icons";
import { matchesRule, parseRule, type Rule } from "./rules";
import { GLYPH_GROUPS, LANGUAGES, SPECIMEN } from "./samples";
import { editTag, TAG_COLORS, tagColor } from "./tags";

// ------------------------------------------------------------------ types & state

interface Family {
  key: string;
  name: string;
  /** Every face is a font installed in the OS folders (always active, read-only file). */
  system: boolean;
  /** At least one face is recorded in the library (favourite, tags, collections). */
  inLibrary: boolean;
  faces: Face[];
  rep: Face;
  paths: string[];
  starred: boolean;
  variable: boolean;
  classification: string;
}

type Activation = "inactive" | "temporary" | "persistent" | "mixed" | "system";
type Tab = "specimen" | "styles" | "glyphs" | "languages" | "features" | "axes" | "info";
type Sort = "name" | "name-desc" | "recent" | "styles";
type Theme = "auto" | "light" | "dark";
type View = "grid" | "rows";

const CLASSES: Record<string, string> = {
  sans: "Sans serif",
  serif: "Serif",
  slab: "Slab serif",
  mono: "Monospace",
  script: "Script",
  display: "Display",
  symbol: "Symboles & icônes",
  other: "Autres",
};

const SORTS: Record<Sort, string> = {
  name: "Nom (A → Z)",
  "name-desc": "Nom (Z → A)",
  recent: "Date d'ajout (récentes d'abord)",
  styles: "Nombre de styles",
};

const FEATURE_NAMES: Record<string, string> = {
  liga: "Ligatures standard",
  dlig: "Ligatures discrétionnaires",
  hlig: "Ligatures historiques",
  calt: "Formes contextuelles",
  kern: "Crénage",
  smcp: "Petites capitales",
  c2sc: "Capitales en petites capitales",
  pcap: "Petites capitales réduites",
  case: "Formes sensibles à la casse",
  onum: "Chiffres elzéviriens",
  lnum: "Chiffres alignés",
  tnum: "Chiffres tabulaires",
  pnum: "Chiffres proportionnels",
  zero: "Zéro barré",
  frac: "Fractions",
  sups: "Exposants",
  subs: "Indices",
  sinf: "Inférieurs scientifiques",
  ordn: "Ordinaux",
  swsh: "Paraphes",
  salt: "Variantes stylistiques",
  titl: "Formes de titrage",
  ccmp: "Composition de glyphes",
  locl: "Formes localisées",
  mark: "Positionnement des accents",
  mkmk: "Accents sur accents",
};
const DEFAULT_ON = new Set(["liga", "calt", "kern", "ccmp", "locl", "mark", "mkmk", "clig", "rlig"]);

const emptyFilter = () => ({
  status: "any" as "any" | "active" | "temporary" | "inactive",
  source: "any" as "any" | "system" | "library",
  classes: new Set<string>(),
  variable: false,
  mono: false,
  italic: false,
});

const state = {
  lib: null as Library | null,
  systemFaces: [] as Face[],
  systemPaths: new Set<string>(),
  systemLoading: true,
  families: [] as Family[],
  sidebar: "all",
  selected: null as string | null,
  search: "",
  filter: emptyFilter(),
  showFilters: false,
  sort: "name" as Sort,
  expanded: new Set<string>(),
  previewText: "",
  previewSize: 28,
  tab: "specimen" as Tab,
  faceId: null as string | null,
  details: new Map<string, FaceDetails>(),
  languages: new Map<string, boolean[]>(),
  languageFilter: "all" as "all" | "yes" | "no",
  glyphGroup: "all",
  glyphSearch: "",
  features: new Map<string, boolean>(),
  axes: new Map<string, number>(),
  selectedChar: null as number | null,
  tileColor: "blue",
  google: null as GoogleCatalog | null,
  googleLoading: false,
  googleError: null as string | null,
  googleBusy: new Set<string>(),
  googleSort: "popular" as GoogleSort,
  googleFilter: emptyGoogleFilter(),
  googleLimit: 120,
  googleQuery: "",
};

const GOOGLE_PAGE = 120;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** OpenType tags come from font files: keep them to safe characters before using them in CSS. */
const cssTag = (tag: string) => tag.replace(/[^A-Za-z0-9 _]/g, "");

const isSystemFace = (f: Face) => f.id.startsWith("sys-");
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

function stored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice lasts for this session only */
  }
}

const settings = {
  get copyOnImport() {
    return stored("copyOnImport", "true") !== "false";
  },
  set copyOnImport(v: boolean) {
    store("copyOnImport", String(v));
  },
  get theme(): Theme {
    const t = stored("theme", "dark");
    return t === "auto" || t === "light" ? t : "dark";
  },
  set theme(v: Theme) {
    store("theme", v);
  },
  get view(): View {
    return stored("view", "grid") === "rows" ? "rows" : "grid";
  },
  set view(v: View) {
    store("view", v);
  },
  get inspector() {
    return stored("inspector", "true") !== "false";
  },
  set inspector(v: boolean) {
    store("inspector", String(v));
  },
  get google() {
    return stored("google", "true") !== "false";
  },
  set google(v: boolean) {
    store("google", String(v));
  },
  get plugins() {
    return stored("plugins", "true") !== "false";
  },
  set plugins(v: boolean) {
    store("plugins", String(v));
  },
  get pluginsGoogle() {
    return stored("pluginsGoogle", "true") !== "false";
  },
  set pluginsGoogle(v: boolean) {
    store("pluginsGoogle", String(v));
  },
  get googleCjk() {
    return stored("googleCjk", "false") === "true";
  },
  set googleCjk(v: boolean) {
    store("googleCjk", String(v));
  },
};

const applyTheme = () => (document.documentElement.dataset.theme = settings.theme);

// ------------------------------------------------------------------ fonts in the web view

const fontSheet = (() => {
  const el = document.createElement("style");
  document.head.appendChild(el);
  return el.sheet!;
})();
const registered = new Set<string>();

/** Lazily declares an @font-face for a face and returns its CSS family name. */
function cssFont(face: Face): string {
  const name = `ts-${face.id}`;
  if (!registered.has(face.id)) {
    registered.add(face.id);
    fontSheet.insertRule(`@font-face { font-family: "${name}"; src: url("${fontURL(face.id)}"); font-display: swap; }`);
  }
  // Single quotes: this value is embedded in double-quoted style="" attributes.
  return `'${name}', sans-serif`;
}

// ------------------------------------------------------------------ derived data

/** Library faces plus installed fonts not yet recorded in the library, grouped by family. */
function rebuild() {
  const lib = state.lib?.faces ?? [];
  const known = new Set(lib.map((f) => f.psName));
  const faces = [...lib, ...state.systemFaces.filter((f) => !known.has(f.psName))];
  const groups = new Map<string, Face[]>();
  for (const face of faces) {
    const list = groups.get(face.family) ?? [];
    list.push(face);
    groups.set(face.family, list);
  }
  const score = (f: Face) =>
    Math.abs(f.weight - 400) + (f.italic ? 500 : 0) - (/^(regular|roman|book|normal)$/i.test(f.style) ? 1 : 0);
  state.families = [...groups.entries()]
    .map(([name, faces]) => {
      faces.sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic));
      const rep = faces.reduce((best, f) => (score(f) < score(best) ? f : best));
      return {
        key: name,
        name,
        system: faces.every((f) => state.systemPaths.has(f.path)),
        inLibrary: faces.some((f) => !isSystemFace(f)),
        faces,
        rep,
        paths: [...new Set(faces.map((f) => f.path))],
        starred: faces.some((f) => f.starred),
        variable: faces.some((f) => f.variable),
        classification: rep.classification,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  if (state.selected && !state.selected.startsWith("g:") && !familyByKey(state.selected)) state.selected = null;
}

function activation(family: Family): Activation {
  const own = family.paths.filter((p) => !state.systemPaths.has(p));
  if (!own.length) return "system";
  const scopes = own.map((p) => state.lib?.activation[p] ?? "none");
  if (scopes.every((s) => s === "none")) return "inactive";
  if (scopes.every((s) => s === "temporary")) return "temporary";
  if (scopes.every((s) => s === "persistent")) return "persistent";
  return "mixed";
}

const ACTIVATION_LABEL: Record<Activation, string> = {
  inactive: "Inactive",
  temporary: "Active jusqu'à la fermeture de Typeshelf",
  persistent: "Active",
  mixed: "Partiellement active",
  system: "Toujours active (installée sur le système)",
};

const isActive = (f: Family) => activation(f) !== "inactive";
const addedAt = (f: Family) => Math.max(...f.faces.map((x) => x.addedAt));

function matches(family: Family, key: string): boolean {
  switch (key) {
    case "all":
      return true;
    case "system":
      return family.system;
    case "library":
      return family.inLibrary && !family.system;
    case "active":
      return isActive(family);
    case "temporary":
      return activation(family) === "temporary";
    case "inactive":
      return activation(family) === "inactive";
    case "starred":
      return family.starred;
    case "recent":
      return !family.system && addedAt(family) > Date.now() / 1000 - 30 * 86400;
  }
  if (key.startsWith("class:")) return family.classification === key.slice(6);
  if (key.startsWith("col:")) {
    const members = new Set(state.lib?.membership[key.slice(4)] ?? []);
    return family.faces.some((f) => members.has(f.id));
  }
  if (key.startsWith("tag:")) return hasTag(family, key.slice(4));
  return true;
}

const facts = (family: Family) => ({ faces: family.faces, starred: family.starred, active: isActive(family) });

const ruleCache = new Map<string, Rule | null>();
const ruleOf = (json: string) => {
  if (!ruleCache.has(json)) ruleCache.set(json, parseRule(json));
  return ruleCache.get(json)!;
};

/** Manual tags check stored members; smart tags evaluate their rule (on system fonts too). */
function hasTag(family: Family, id: string): boolean {
  const tag = state.lib?.tags.find((t) => t.id === id);
  if (!tag) return false;
  if (tag.rule !== null) {
    const rule = ruleOf(tag.rule);
    return !!rule && matchesRule(rule, facts(family));
  }
  const members = state.lib?.tagMembership[id] ?? [];
  return family.faces.some((f) => members.includes(f.id));
}

const tagsOf = (family: Family) => (state.lib?.tags ?? []).filter((t) => hasTag(family, t.id));
const countRule = (rule: Rule) => state.families.filter((f) => matchesRule(rule, facts(f))).length;

const isGoogle = () => state.sidebar === "google";

function filterCount(): number {
  if (isGoogle()) return googleFilterCount(state.googleFilter);
  const f = state.filter;
  return (
    Number(f.status !== "any") + Number(f.source !== "any") + f.classes.size + Number(f.variable) + Number(f.mono) + Number(f.italic)
  );
}

function passesFilter(fam: Family): boolean {
  const f = state.filter;
  if (f.status !== "any" && !matches(fam, f.status)) return false;
  if (f.source === "system" && !fam.system) return false;
  if (f.source === "library" && fam.system) return false;
  if (f.classes.size && !f.classes.has(fam.classification)) return false;
  if (f.variable && !fam.variable) return false;
  if (f.mono && !fam.faces.some((x) => x.mono)) return false;
  if (f.italic && !fam.faces.some((x) => x.italic)) return false;
  return true;
}

function visibleFamilies(): Family[] {
  const q = state.search.trim().toLowerCase();
  const list = state.families.filter(
    (fam) =>
      matches(fam, state.sidebar) &&
      passesFilter(fam) &&
      (!q ||
        fam.faces.some((f) =>
          [f.family, f.style, f.psName, f.designer ?? "", f.manufacturer ?? ""].some((v) => v.toLowerCase().includes(q)),
        )),
  );
  if (state.sort === "name-desc") list.sort((a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: "base", numeric: true }));
  else if (state.sort === "recent") list.sort((a, b) => addedAt(b) - addedAt(a));
  else if (state.sort === "styles") list.sort((a, b) => b.faces.length - a.faces.length);
  return list;
}

const familyByKey = (key: string | null) => state.families.find((f) => f.key === key) ?? null;
const familiesInCollection = (id: string) => state.families.filter((f) => matches(f, `col:${id}`));
const familiesWithTag = (id: string) => state.families.filter((f) => hasTag(f, id));

// ------------------------------------------------------------------ Google Fonts data

/** Catalogue families offered in the app (CJK ones only on request: they are very large). */
const googleBase = () => (state.google?.families ?? []).filter((f) => settings.googleCjk || !f.cjk);
const googleByName = (name: string) => state.google?.families.find((f) => f.family === name) ?? null;

/** Lower-cased names of families already present: library, installed, or downloaded from Google. */
function installedNames(): Set<string> {
  const names = new Set(state.families.map((f) => f.name.toLowerCase()));
  for (const face of state.lib?.faces ?? []) {
    const m = face.path.match(/[\\/]Google Fonts[\\/]([^\\/]+)[\\/][^\\/]+$/);
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}
const isInstalled = (f: GoogleFamily, names = installedNames()) =>
  names.has(f.family.toLowerCase()) || names.has(folderName(f.family).toLowerCase());

/** Library family matching a Google family, by name or by download folder. */
function libraryFamilyFor(name: string): Family | null {
  const folder = folderName(name);
  return (
    state.families.find((f) => f.name.toLowerCase() === name.toLowerCase()) ??
    state.families.find((f) => f.paths.some((p) => p.includes(`Google Fonts/${folder}/`) || p.includes(`Google Fonts\\${folder}\\`))) ??
    null
  );
}

function visibleGoogle(): GoogleFamily[] {
  const q = state.search.trim().toLowerCase();
  const f = state.googleFilter;
  const installed = installedNames();
  const list = googleBase().filter(
    (g) =>
      (!f.classes.size || f.classes.has(classOf(g))) &&
      (!f.variable || g.axes.length > 0) &&
      (!f.italic || hasItalic(g)) &&
      (!f.hideInstalled || !isInstalled(g, installed)) &&
      (!q || g.family.toLowerCase().includes(q) || g.designers.some((d) => d.toLowerCase().includes(q))),
  );
  return sortGoogle(list, state.googleSort);
}

async function loadGoogle(refresh = false) {
  if (state.googleLoading) return;
  state.googleLoading = true;
  state.googleError = null;
  syncGoogleStatus();
  if (isGoogle()) render();
  try {
    state.google = await api.googleCatalog(refresh);
    if (refresh) toast(`Catalogue Google Fonts à jour : ${plural(state.google.families.length, "famille")}`);
  } catch (e) {
    state.googleError = String(e);
    if (refresh || !isGoogle()) toast(String(e), true);
  } finally {
    state.googleLoading = false;
    syncGoogleStatus();
    render();
  }
}

// ------------------------------------------------------------------ plugins (Photoshop, Illustrator…)

function showPluginStatus(status: PluginApiStatus | null) {
  const el = document.querySelector("#plugins-status");
  if (!el) return;
  el.textContent = !status
    ? "État inconnu."
    : !status.enabled
      ? "Connexion coupée : les plugins ne peuvent rien activer."
      : status.listening
        ? `En écoute sur 127.0.0.1:${status.port}.`
        : (status.error ?? "Démarrage…");
}

async function configurePlugins() {
  try {
    showPluginStatus(await api.pluginApiConfig(settings.plugins, settings.pluginsGoogle));
  } catch {
    showPluginStatus(null);
  }
}

/** A plugin activated fonts for a document: refresh the library and say so. */
function onPluginActivity(activity: PluginActivity) {
  const parts = [];
  if (activity.activated.length) parts.push(`${plural(activity.activated.length, "police")} activée${activity.activated.length > 1 ? "s" : ""}`);
  if (activity.missing.length) parts.push(`${activity.missing.length} introuvable${activity.missing.length > 1 ? "s" : ""} (${activity.missing.slice(0, 3).join(", ")}${activity.missing.length > 3 ? "…" : ""})`);
  toast(`${activity.client} : ${parts.join(" · ")}`, activity.activated.length === 0, 6000);
  reload();
}

function syncGoogleStatus() {
  const el = document.querySelector("#google-status");
  if (!el) return;
  el.textContent = state.googleLoading
    ? "Mise à jour…"
    : state.google
      ? `${plural(state.google.families.length, "famille")} · catalogue du ${dateOf(state.google.fetchedAt)}`
      : (state.googleError ?? "Le catalogue sera chargé à la première ouverture de la section.");
}

/** Downloads every style of a Google family into the library, optionally activating it. */
async function googleInstall(name: string, activate: boolean) {
  if (state.googleBusy.has(name)) return;
  state.googleBusy.add(name);
  render();
  toast(`Téléchargement de ${name}…`, false, 120_000);
  try {
    const { paths } = await api.googleDownload(name);
    const errors = activate && paths.length ? await api.setActivation(paths, "persistent") : [];
    if (errors.length) toast(errors.join("\n"), true);
    else toast(`${name} : ${plural(paths.length, "style")} ${activate ? "installé" : "téléchargé"}${paths.length > 1 ? "s" : ""}${activate ? " et actif" + (paths.length > 1 ? "s" : "") : ""}`);
  } catch (e) {
    toast(String(e), true);
  } finally {
    state.googleBusy.delete(name);
    await reload();
  }
}

/** Leaves the Google section for the matching library family. */
function showInLibrary(name: string) {
  const fam = libraryFamilyFor(name);
  if (!fam) return toast("Famille introuvable dans la bibliothèque.", true);
  state.sidebar = "all";
  state.search = "";
  $<HTMLInputElement>("#search").value = "";
  render();
  selectFamily(fam.key);
  $("#family-list").querySelector<HTMLElement>(".selected")?.scrollIntoView({ block: "center" });
}

function sidebarTitle(): string {
  const key = state.sidebar;
  const fixed: Record<string, string> = {
    all: "Toutes les polices",
    starred: "Favoris",
    system: "Polices système",
    library: "Importées",
    active: "Actives",
    temporary: "Actives temporairement",
    inactive: "Inactives",
    recent: "Ajoutées récemment",
    google: "Google Fonts",
  };
  if (fixed[key]) return fixed[key];
  if (key.startsWith("class:")) return CLASSES[key.slice(6)] ?? "Classification";
  if (key.startsWith("tag:")) return state.lib?.tags.find((t) => t.id === key.slice(4))?.name ?? "Tag";
  return state.lib?.collections.find((c) => c.id === key.slice(4))?.name ?? "Collection";
}

function formatOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "otf" ? "OpenType (CFF)" : ext === "ttc" ? "Collection TrueType" : ext === "otc" ? "Collection OpenType" : "TrueType";
}

const dateOf = (seconds: number) =>
  seconds > 0 ? new Date(seconds * 1000).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "-";

const sizeOf = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`;

// ------------------------------------------------------------------ data refresh & actions

async function reload() {
  try {
    state.lib = await api.loadLibrary();
  } catch (e) {
    toast(String(e), true);
    return;
  }
  ruleCache.clear();
  rebuild();
  const lib = state.lib;
  const gone =
    (state.sidebar.startsWith("col:") && !lib.collections.some((c) => `col:${c.id}` === state.sidebar)) ||
    (state.sidebar.startsWith("tag:") && !lib.tags.some((t) => `tag:${t.id}` === state.sidebar));
  if (gone) state.sidebar = "all";
  render();
}

/** System fonts are scanned by the backend in the background; they arrive after the library. */
async function loadSystemFonts() {
  try {
    state.systemFaces = await api.systemFonts();
    state.systemPaths = new Set(state.systemFaces.map((f) => f.path));
  } catch (e) {
    toast(`Polices système : ${e}`, true);
  } finally {
    state.systemLoading = false;
    rebuild();
    render();
  }
}

async function run<T>(action: Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await action;
    if (Array.isArray(result) && result.length && typeof result[0] === "string") {
      toast((result as string[]).join("\n"), true);
    } else if (success) {
      toast(success);
    }
    return result;
  } catch (e) {
    toast(String(e), true);
    return undefined;
  } finally {
    await reload();
  }
}

/**
 * Favourites, tags and collections are stored in the library. Installed fonts are recorded
 * there on first use, by reference: their files stay where the OS put them.
 */
async function libraryAction(families: Family[], action: () => Promise<unknown>, success?: string) {
  const paths = [...new Set(families.flatMap((f) => f.faces.filter(isSystemFace).map((x) => x.path)))];
  if (paths.length) {
    try {
      await api.importPaths(paths, false);
    } catch (e) {
      toast(String(e), true);
      return;
    }
  }
  await run(action(), success);
}

const setScope = (families: Family[], scope: Scope) => {
  const paths = families.flatMap((f) => f.paths).filter((p) => !state.systemPaths.has(p));
  if (!paths.length) return toast("Les polices système sont toujours actives.");
  return run(api.setActivation(paths, scope));
};

const setStarred = (fam: Family, starred: boolean) => libraryAction([fam], () => api.setStarred(fam.name, starred));

async function importPaths(paths: string[]) {
  if (!paths.length) return;
  toast("Import en cours…", false, 60_000);
  const summary = await run(api.importPaths(paths, settings.copyOnImport));
  if (!summary) return;
  const parts = [`${plural(summary.imported, "style")} importé${summary.imported > 1 ? "s" : ""}`];
  if (summary.skipped) parts.push(`${summary.skipped} déjà présent(s)`);
  if (summary.failures.length) parts.push(`${summary.failures.length} illisible(s)`);
  toast(parts.join(" · "), summary.imported === 0 && summary.failures.length > 0);
}

/** Copies installed font files into the library folder. */
function copyToLibrary(families: Family[]) {
  toast("Copie en cours…", false, 60_000);
  run(api.importPaths([...new Set(families.flatMap((f) => f.paths))], true), "Copiée dans la bibliothèque");
}

async function removeFamilies(families: Family[]) {
  const names = families.map((f) => f.name).join(", ");
  const system = families.every((f) => f.system);
  const ok = await ask(
    system
      ? `Oublier le favori, les tags et les collections de ${names} ? La police reste installée sur le système.`
      : `Retirer ${names} de la bibliothèque ? Les fichiers copiés par Typeshelf iront à la corbeille.`,
    {
      title: system ? "Oublier" : "Retirer de la bibliothèque",
      kind: "warning",
      okLabel: system ? "Oublier" : "Retirer",
      cancelLabel: "Annuler",
    },
  );
  if (ok) await run(api.removeFamilies(families.map((f) => f.name)));
}

async function promptText(title: string, value = ""): Promise<string | null> {
  const dialog = $<HTMLDialogElement>("#prompt-dialog");
  $("#prompt-title").textContent = title;
  const input = $<HTMLInputElement>("#prompt-input");
  input.value = value;
  dialog.returnValue = ""; // otherwise Escape would reuse the previous answer
  dialog.showModal();
  input.select();
  return new Promise((resolve) => {
    dialog.onclose = () => {
      dialog.onclose = null;
      resolve(dialog.returnValue === "ok" && input.value.trim() ? input.value.trim() : null);
    };
  });
}

async function newCollection(families: Family[] = []) {
  const name = await promptText("Nouvelle collection");
  if (!name) return;
  const id = await run(api.createCollection(name));
  if (id && families.length) await libraryAction(families, () => api.addToCollection(id, families.map((f) => f.name)));
  if (id) {
    state.sidebar = `col:${id}`;
    render();
  }
}

async function newTag(smart: boolean, families: Family[] = []) {
  const draft = await editTag(
    smart ? "Nouveau tag intelligent" : "Nouveau tag",
    { name: "", color: "blue", rule: smart ? { match: "all", conditions: [] } : null },
    countRule,
    CLASSES,
  );
  if (!draft) return;
  const id = await run(api.createTag(draft.name, draft.color, draft.rule && JSON.stringify(draft.rule)));
  if (!id) return;
  if (!smart && families.length) await libraryAction(families, () => api.setTagged(id, families.map((f) => f.name), true));
  if (!families.length) {
    state.sidebar = `tag:${id}`;
    render();
  }
}

async function editExistingTag(tag: Tag) {
  const draft = await editTag(
    tag.rule !== null ? "Modifier le tag intelligent" : "Modifier le tag",
    { name: tag.name, color: tag.color, rule: tag.rule !== null ? (parseRule(tag.rule) ?? { match: "all", conditions: [] }) : null },
    countRule,
    CLASSES,
  );
  if (draft) await run(api.updateTag(tag.id, draft.name, draft.color, draft.rule && JSON.stringify(draft.rule)));
}

function tagChip(tag: Tag) {
  return `<span class="chip" style="--c:${tagColor(tag.color)}" title="${esc(tag.name)}">${esc(tag.name)}</span>`;
}

// ------------------------------------------------------------------ rendering: sidebar

function render() {
  renderSidebar();
  renderList();
  renderDetail();
}

function renderSidebar() {
  const count = (key: string): number | string => {
    if (key === "google") return state.google ? googleBase().length : state.googleLoading ? "…" : "";
    return state.systemLoading && (key === "system" || key === "all") ? "…" : state.families.filter((f) => matches(f, key)).length;
  };
  const item = (key: string, label: string, glyph: string, extra = "") =>
    `<button class="nav-item${state.sidebar === key ? " selected" : ""}" data-nav="${esc(key)}" ${extra}>
       ${glyph}<span class="nav-label">${esc(label)}</span>
       <span class="badge">${count(key)}</span>
     </button>`;
  const section = (label: string, action = "") => `<div class="nav-section"><span>${label}</span>${action}</div>`;

  const classes = Object.entries(CLASSES)
    .filter(([k]) => state.families.some((f) => matches(f, `class:${k}`)))
    .map(([k, label]) => item(`class:${k}`, label, icon("shapes")))
    .join("");

  const collections = (state.lib?.collections ?? [])
    .map((c) => item(`col:${c.id}`, c.name, icon("folder"), `data-collection="${esc(c.id)}"`))
    .join("");

  const tags = (state.lib?.tags ?? [])
    .map((t) =>
      item(
        `tag:${t.id}`,
        t.name,
        `<span class="nav-swatch"><span class="tag-dot${t.rule !== null ? " smart" : ""}" style="background:${tagColor(t.color)};--c:${tagColor(t.color)}"></span></span>`,
        `data-tag="${esc(t.id)}"${t.rule !== null ? ' title="Tag intelligent : se remplit selon ses règles"' : ""}`,
      ),
    )
    .join("");

  $("#sidebar-nav").innerHTML = `
    ${item("all", "Toutes les polices", icon("all"))}
    ${item("starred", "Favoris", icon("star"))}
    ${item("system", "Polices système", icon("system"))}
    ${item("library", "Importées", icon("imported"))}
    ${item("recent", "Ajoutées récemment", icon("recent"))}
    ${section("État")}
    ${item("active", "Actives", icon("active"))}
    ${item("temporary", "Temporaires", icon("temporary"))}
    ${item("inactive", "Inactives", icon("inactive"))}
    ${settings.google ? section("En ligne") + item("google", "Google Fonts", icon("globe")) : ""}
    ${classes ? section("Classification") + classes : ""}
    ${section("Collections", `<button id="new-collection" title="Nouvelle collection" aria-label="Nouvelle collection">${icon("plus", 14)}</button>`)}
    ${collections || `<p class="muted small nav-empty">Créez une collection, puis glissez-y des cartes.</p>`}
    ${section("Tags", `<button id="new-tag" title="Nouveau tag" aria-label="Nouveau tag">${icon("plus", 14)}</button>`)}
    ${tags || `<p class="muted small nav-empty">Les tags intelligents se remplissent seuls selon vos règles.</p>`}
  `;
}

// ------------------------------------------------------------------ rendering: filters

function renderFilterBar() {
  const bar = $("#filter-bar");
  bar.hidden = !state.showFilters;
  const n = filterCount();
  const button = $("#filter-button");
  button.classList.toggle("on", state.showFilters || n > 0);
  button.dataset.count = n ? String(n) : "";
  if (bar.hidden) return;
  if (isGoogle()) return renderGoogleFilterBar(bar, n);
  const f = state.filter;
  const seg = (name: string, value: string, options: [string, string][]) =>
    `<div class="segmented small-seg">${options
      .map(([v, l]) => `<button type="button" data-filter="${name}" data-value="${v}" class="${value === v ? "on" : ""}">${l}</button>`)
      .join("")}</div>`;
  const chip = (name: string, value: string, label: string, on: boolean) =>
    `<button type="button" class="filter-chip${on ? " on" : ""}" data-filter="${name}" data-value="${value}">${esc(label)}</button>`;
  bar.innerHTML = `
    <div class="filter-group"><span class="filter-label">État</span>${seg("status", f.status, [
      ["any", "Toutes"],
      ["active", "Actives"],
      ["temporary", "Temporaires"],
      ["inactive", "Inactives"],
    ])}</div>
    <div class="filter-group"><span class="filter-label">Source</span>${seg("source", f.source, [
      ["any", "Toutes"],
      ["system", "Système"],
      ["library", "Importées"],
    ])}</div>
    <div class="filter-group"><span class="filter-label">Classification</span>
      ${Object.entries(CLASSES)
        .filter(([k]) => state.families.some((fam) => fam.classification === k))
        .map(([k, l]) => chip("class", k, l, f.classes.has(k)))
        .join("")}
    </div>
    <div class="filter-group"><span class="filter-label">Caractéristiques</span>
      ${chip("variable", "1", "Variables", f.variable)}
      ${chip("mono", "1", "Chasse fixe", f.mono)}
      ${chip("italic", "1", "Avec italique", f.italic)}
    </div>
    ${n ? `<button type="button" class="link" data-filter="reset">Réinitialiser</button>` : ""}`;
}

function renderGoogleFilterBar(bar: HTMLElement, n: number) {
  const f = state.googleFilter;
  const chip = (name: string, value: string, label: string, on: boolean) =>
    `<button type="button" class="filter-chip${on ? " on" : ""}" data-gfilter="${name}" data-value="${value}">${esc(label)}</button>`;
  bar.innerHTML = `
    <div class="filter-group"><span class="filter-label">Catégorie</span>
      ${Object.entries(GOOGLE_CLASSES)
        .map(([k, l]) => chip("class", k, l, f.classes.has(k)))
        .join("")}
    </div>
    <div class="filter-group"><span class="filter-label">Caractéristiques</span>
      ${chip("variable", "1", "Variables", f.variable)}
      ${chip("italic", "1", "Avec italique", f.italic)}
      ${chip("hideInstalled", "1", "Masquer celles déjà présentes", f.hideInstalled)}
    </div>
    ${n ? `<button type="button" class="link" data-gfilter="reset">Réinitialiser</button>` : ""}`;
}

// ------------------------------------------------------------------ rendering: family list

function renderList() {
  renderFilterBar();
  if (isGoogle()) return renderGoogleList();
  const families = visibleFamilies();
  $("#list-title").textContent = sidebarTitle();
  $("#list-subtitle").textContent =
    state.systemLoading && (state.sidebar === "all" || state.sidebar === "system")
      ? "lecture des polices installées…"
      : `${plural(families.length, "famille")}${filterCount() ? " (filtrées)" : ""}`;
  const list = $("#family-list");
  list.style.setProperty("--preview-size", `${state.previewSize}px`);
  list.classList.toggle("rows", settings.view === "rows");
  const empty = (html: string) => {
    list.classList.add("is-empty");
    list.innerHTML = `<div class="empty">${html}</div>`;
  };

  if (!families.length) {
    if (state.systemLoading && state.sidebar === "system") return empty(`<p>Lecture des polices installées…</p>`);
    if (state.sidebar === "library" && !state.families.some((f) => f.inLibrary && !f.system)) {
      return empty(`<div class="empty-icon">${icon("drop", 44)}</div>
        <h2>Aucune police importée pour l'instant</h2>
        <p>Glissez des fichiers ou des dossiers dans la fenêtre. Les polices déjà installées sont dans « Polices système ».</p>
        <button class="primary" data-action="import">Importer des polices…</button>`);
    }
    return empty(`<div class="empty-icon">${icon("search", 40)}</div><h2>Aucun résultat</h2>
      <p>Aucune famille ne correspond${filterCount() || state.search ? " à la recherche ou aux filtres" : ""}.</p>
      ${filterCount() ? `<button data-filter="reset">Réinitialiser les filtres</button>` : ""}`);
  }

  list.classList.remove("is-empty");
  list.innerHTML = settings.view === "rows" ? renderTable(families) : families.map(renderCard).join("");
}

const previewObserver =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target as HTMLElement;
            previewObserver?.unobserve(el);
            if (el.dataset.action === "gf-more") {
              state.googleLimit += GOOGLE_PAGE;
              renderList();
              continue;
            }
            const g = googleByName(el.dataset.gfamily ?? "");
            if (g) loadPreview(g);
          }
        },
        { root: document.querySelector("#family-list"), rootMargin: "600px 0px" },
      )
    : null;

function renderGoogleList() {
  const list = $("#family-list");
  list.style.setProperty("--preview-size", `${state.previewSize}px`);
  list.classList.toggle("rows", settings.view === "rows");
  previewObserver?.disconnect();
  const f = state.googleFilter;
  const query = [state.search, state.googleSort, settings.googleCjk, [...f.classes].join(), f.variable, f.italic, f.hideInstalled].join("|");
  if (query !== state.googleQuery) {
    state.googleQuery = query;
    state.googleLimit = GOOGLE_PAGE;
  }
  const families = state.google ? visibleGoogle() : [];
  $("#list-title").textContent = "Google Fonts";
  $("#list-subtitle").textContent = state.google
    ? `${plural(families.length, "famille")}${filterCount() || state.search ? " (filtrées)" : ""} · gratuites et libres`
    : "";
  const empty = (html: string) => {
    list.classList.add("is-empty");
    list.innerHTML = `<div class="empty">${html}</div>`;
  };
  if (!state.google) {
    if (state.googleError)
      return empty(`<div class="empty-icon">${icon("cloud", 44)}</div><h2>Catalogue indisponible</h2>
        <p>${esc(state.googleError)}</p><button class="primary" data-action="gf-retry">Réessayer</button>`);
    return empty(`<div class="empty-icon">${icon("globe", 44)}</div><h2>Chargement du catalogue Google Fonts…</h2>
      <p>Plus de 1 800 familles libres, à télécharger et activer en un clic.</p>`);
  }
  if (!families.length)
    return empty(`<div class="empty-icon">${icon("search", 40)}</div><h2>Aucun résultat</h2>
      <p>Aucune famille Google Fonts ne correspond à la recherche ou aux filtres.</p>
      ${filterCount() ? `<button data-gfilter="reset">Réinitialiser les filtres</button>` : ""}`);

  list.classList.remove("is-empty");
  const installed = installedNames();
  const shown = families.slice(0, state.googleLimit);
  const rest = families.length - shown.length;
  list.innerHTML =
    shown.map((g) => renderGoogleCard(g, isInstalled(g, installed))).join("") +
    (rest > 0 ? `<button class="more-button" data-action="gf-more">Afficher plus (${rest} restantes)</button>` : "");
  list.querySelectorAll<HTMLElement>("[data-gfamily], [data-action='gf-more']").forEach((el) => previewObserver?.observe(el));
  if (!previewObserver) shown.forEach((g) => loadPreview(g));
}

function googleAction(g: GoogleFamily, installed: boolean, big = false): string {
  if (state.googleBusy.has(g.family)) return `<span class="gf-busy"><span class="spinner"></span>Téléchargement…</span>`;
  if (installed)
    return `<button class="gf-installed" data-action="gf-show" title="Afficher dans la bibliothèque">${icon("active", 13)}Dans la bibliothèque</button>`;
  return `<button class="gf-get${big ? " primary" : ""}" data-action="gf-install" title="Télécharger tous les styles et les activer">${icon("cloud", 14)}${big ? "Installer et activer" : "Installer"}</button>`;
}

function renderGoogleCard(g: GoogleFamily, installed: boolean): string {
  return `<div class="font-card gf-card${state.selected === `g:${g.family}` ? " selected" : ""}" data-family="g:${esc(g.family)}" data-gfamily="${esc(g.family)}">
    <div class="card-head">
      <span class="card-name">${esc(g.family)}</span>
      <span class="card-meta">· ${plural(g.styles.length, "style")} · ${esc(categoryLabel(g))}</span>
      ${g.axes.length ? `<span class="pill">VAR</span>` : ""}
      <span class="card-actions">${googleAction(g, installed)}</span>
    </div>
    <div class="preview" style="font-family:${cssFamily(g)}">${esc(state.previewText || g.family)}</div>
  </div>`;
}

function renderGoogleDetail(pane: HTMLElement, g: GoogleFamily) {
  loadPreview(g, true);
  const installed = isInstalled(g);
  const font = cssFamily(g);
  const text = esc(state.previewText || g.family);
  const rank = g.popularity < 4_000_000_000 ? `n° ${g.popularity} sur ${state.google?.families.length ?? "?"}` : null;
  const rows: [string, string | null][] = [
    ["Catégorie", categoryLabel(g)],
    ["Créateurs", g.designers.join(", ") || null],
    ["Styles", String(g.styles.length)],
    ["Axes variables", g.axes.map((a) => `${a.tag} ${a.min}–${a.max}`).join(", ") || null],
    ["Écritures", g.subsets.join(", ") || null],
    ["Publiée le", g.dateAdded ? new Date(g.dateAdded).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : null],
    ["Popularité", rank],
    ["Licence", "Libre (Open Font License ou Apache)"],
  ];
  pane.innerHTML = `
    <header class="detail-head">
      <div class="detail-top" data-tauri-drag-region>
        <div class="detail-name">
          <strong>${esc(g.family)}</strong>
          <span class="muted">Google Fonts</span>
        </div>
        <button class="tool" data-action="close" title="Fermer le détail" aria-label="Fermer le détail">${icon("close")}</button>
      </div>
      <div class="hero" style="font-family:${font}">Aa</div>
      <div class="status-line">
        ${googleAction(g, installed, true)}
        ${installed || state.googleBusy.has(g.family) ? "" : `<button data-action="gf-download" title="Ajouter à la bibliothèque sans activer">Télécharger seulement</button>`}
      </div>
    </header>
    <div class="detail-body">
      <div class="styles">
        ${g.styles
          .map((key) => {
            const s = parseStyle(key);
            return `<div class="style-row gf-style"><div class="muted small">${esc(styleLabel(key))} · ${s.weight}${s.italic ? " · italique" : ""}</div>
              <div class="style-preview" style="font-family:${font};font-weight:${s.weight};font-style:${s.italic ? "italic" : "normal"};font-size:${state.previewSize}px">${text}</div></div>`;
          })
          .join("")}
      </div>
      <h3>Spécimen</h3>
      <p class="gf-specimen" style="font-family:${font}">${esc(SPECIMEN.paragraphs[0])}</p>
      <dl class="info">${rows
        .filter(([, v]) => v)
        .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`)
        .join("")}</dl>
      <p class="muted small">L'aperçu est servi par Google. Une fois installée, la famille rejoint votre bibliothèque (dossier « Google Fonts ») et fonctionne hors ligne.</p>
    </div>`;
}

function statusControl(fam: Family, act = activation(fam)) {
  return act === "system"
    ? `<span class="lock" title="${esc(ACTIVATION_LABEL.system)}">${icon("lock", 13)}</span>`
    : `<button class="switch${act !== "inactive" ? " on" : ""} ${act}" data-action="toggle" role="switch" aria-checked="${act !== "inactive"}" title="${esc(ACTIVATION_LABEL[act])}"><span></span></button>`;
}

function starButton(fam: Family) {
  return `<button class="star${fam.starred ? " on" : ""}" data-action="star" title="${fam.starred ? "Retirer des favoris" : "Ajouter aux favoris"}">${fam.starred ? "★" : "☆"}</button>`;
}

function renderCard(fam: Family): string {
  const act = activation(fam);
  return `<div class="font-card${fam.key === state.selected ? " selected" : ""}" data-family="${esc(fam.key)}" draggable="true">
    <div class="card-head">
      <span class="dot ${act}" title="${esc(ACTIVATION_LABEL[act])}"></span>
      <span class="card-name">${esc(fam.name)}</span>
      <span class="card-meta">· ${plural(fam.faces.length, "style")}</span>
      ${fam.variable ? `<span class="pill">VAR</span>` : ""}
      ${chips(fam)}
      <span class="card-actions">${starButton(fam)}${statusControl(fam, act)}</span>
    </div>
    <div class="preview" style="font-family:${cssFont(fam.rep)}">${esc(state.previewText || fam.name)}</div>
  </div>`;
}

function renderTable(families: Family[]): string {
  const arrow = (sort: Sort, desc?: Sort) => (state.sort === sort ? " ↑" : desc && state.sort === desc ? " ↓" : "");
  const head = `<div class="t-head">
    <span></span><span></span>
    <span>Aperçu</span>
    <button type="button" data-sort="name">Nom${arrow("name", "name-desc")}</button>
    <span class="t-center">★</span>
    <span>Format</span>
    <button type="button" data-sort="recent">Ajoutée${arrow("recent")}</button>
    <span></span>
  </div>`;
  const rows = families.map((fam) => {
    const act = activation(fam);
    const open = state.expanded.has(fam.key);
    const many = fam.faces.length > 1;
    const row = `<div class="t-row${fam.key === state.selected ? " selected" : ""}" data-family="${esc(fam.key)}" draggable="true">
      <span>${many ? `<button class="chevron${open ? " open" : ""}" data-action="expand" aria-label="Afficher les styles">${icon("chevron", 14)}</button>` : ""}</span>
      <span class="dot ${act}" title="${esc(ACTIVATION_LABEL[act])}"></span>
      <span class="t-preview" style="font-family:${cssFont(fam.rep)}">${esc(state.previewText || fam.name)}</span>
      <span class="t-name">${esc(fam.name)}${many ? ` <span class="muted">(${fam.faces.length})</span>` : ""} ${chips(fam)}</span>
      <span class="t-center">${starButton(fam)}</span>
      <span class="muted">${formatOf(fam.rep.path)}</span>
      <span class="muted">${dateOf(addedAt(fam))}</span>
      <span class="t-center">${statusControl(fam, act)}</span>
    </div>`;
    if (!open) return row;
    return (
      row +
      fam.faces
        .map(
          (f) => `<div class="t-row t-face" data-family="${esc(fam.key)}" data-face="${esc(f.id)}">
        <span></span><span></span>
        <span class="t-preview" style="font-family:${cssFont(f)}">${esc(state.previewText || f.fullName)}</span>
        <span class="t-name">${esc(f.style)} <span class="muted">· ${f.weight}${f.italic ? " · italique" : ""}</span></span>
        <span></span>
        <span class="muted">${formatOf(f.path)}</span>
        <span class="muted">${dateOf(f.addedAt)}</span>
        <span></span>
      </div>`,
        )
        .join("")
    );
  });
  return `<div class="table">${head}${rows.join("")}</div>`;
}

function chips(fam: Family): string {
  const tags = tagsOf(fam);
  const shown = tags.slice(0, 2).map(tagChip).join("");
  return shown + (tags.length > 2 ? `<span class="muted small">+${tags.length - 2}</span>` : "");
}

/** Cheap update used while typing in the preview field or moving the slider. */
function refreshPreviews() {
  const list = $("#family-list");
  list.style.setProperty("--preview-size", `${state.previewSize}px`);
  list.querySelectorAll<HTMLElement>(".preview, .t-preview").forEach((el) => {
    const row = el.closest<HTMLElement>("[data-family]")!;
    if (row.dataset.gfamily) return void (el.textContent = state.previewText || row.dataset.gfamily);
    const fam = familyByKey(row.dataset.family!);
    const face = row.dataset.face ? fam?.faces.find((f) => f.id === row.dataset.face) : null;
    el.textContent = state.previewText || face?.fullName || fam?.name || "";
  });
  $("#preview-size-label").textContent = String(state.previewSize);
  if (state.selected?.startsWith("g:") || state.tab === "styles" || state.tab === "features" || state.tab === "axes") renderDetail();
}

// ------------------------------------------------------------------ rendering: detail

function currentFace(fam: Family): Face {
  return fam.faces.find((f) => f.id === state.faceId) ?? fam.rep;
}

function renderDetail() {
  const pane = $("#detail");
  $("#inspector-button").classList.toggle("on", settings.inspector);
  if (state.selected?.startsWith("g:")) {
    const g = googleByName(state.selected.slice(2));
    pane.hidden = !g || !settings.inspector;
    if (g && !pane.hidden) renderGoogleDetail(pane, g);
    else pane.innerHTML = "";
    return;
  }
  const fam = familyByKey(state.selected);
  pane.hidden = !fam || !settings.inspector;
  if (!fam || pane.hidden) {
    pane.innerHTML = "";
    return;
  }
  if (state.tab === "axes" && !fam.variable) state.tab = "specimen";
  const face = currentFace(fam);
  const act = activation(fam);
  const tabs: [Tab, string][] = [
    ["specimen", "Spécimen"],
    ["styles", "Styles"],
    ["glyphs", "Glyphes"],
    ["languages", "Langues"],
    ["features", "OpenType"],
  ];
  if (fam.variable) tabs.push(["axes", "Variable"]);
  tabs.push(["info", "Infos"]);

  const scopeButton = (scope: Scope, label: string, on: boolean) =>
    `<button data-scope="${scope}" class="${on ? "on" : ""}">${label}</button>`;

  pane.innerHTML = `
    <header class="detail-head">
      <div class="detail-top" data-tauri-drag-region>
        <div class="detail-name">
          <strong>${esc(fam.name)}</strong>
          ${
            fam.faces.length > 1
              ? `<select id="face-select" title="Style affiché">${fam.faces
                  .map((f) => `<option value="${esc(f.id)}"${f.id === face.id ? " selected" : ""}>${esc(f.style)}</option>`)
                  .join("")}</select>`
              : `<span class="muted">${esc(face.style)}</span>`
          }
        </div>
        <button class="tool" data-action="more" title="Plus d'actions" aria-label="Plus d'actions">${icon("more")}</button>
        <button class="tool" data-action="close" title="Fermer le détail" aria-label="Fermer le détail">${icon("close")}</button>
      </div>
      <div class="hero" style="font-family:${cssFont(face)}">Aa</div>
      <div class="status-line">
        ${
          act === "system"
            ? `<span class="dot system"></span><span>${ACTIVATION_LABEL.system}</span>`
            : `<div class="segmented" title="${esc(ACTIVATION_LABEL[act])}">
                ${scopeButton("none", "Inactive", act === "inactive")}
                ${scopeButton("temporary", "Temporaire", act === "temporary")}
                ${scopeButton("persistent", "Active", act === "persistent")}
              </div>`
        }
        <span class="spacer"></span>
        <button class="star${fam.starred ? " on" : ""}" data-action="star" title="${fam.starred ? "Retirer des favoris" : "Ajouter aux favoris"}">${fam.starred ? "★" : "☆"}</button>
      </div>
      <div class="detail-tags">
        ${tagsOf(fam).map(tagChip).join("")}
        <button class="chip-add" data-action="tags">＋ Tag</button>
      </div>
      <nav class="tabs">
        ${tabs.map(([t, l]) => `<button data-tab="${t}" class="${state.tab === t ? "on" : ""}">${l}</button>`).join("")}
      </nav>
    </header>
    <div class="detail-body">${renderTab(fam, face)}</div>`;

  const needsDetails = state.tab === "glyphs" || state.tab === "features" || state.tab === "axes" || state.tab === "info";
  if (needsDetails && !state.details.has(face.id)) loadDetails(face.id);
  if (state.tab === "languages" && !state.languages.has(face.id)) loadLanguages(face.id);
}

async function loadDetails(id: string) {
  try {
    state.details.set(id, await api.faceDetails(id));
  } catch (e) {
    toast(String(e), true);
    return;
  }
  renderDetail();
}

async function loadLanguages(id: string) {
  try {
    state.languages.set(id, await api.languageSupport(id, LANGUAGES.map((l) => l.sample)));
  } catch (e) {
    toast(String(e), true);
    return;
  }
  renderDetail();
}

const LOADING = `<p class="muted">Lecture de la police…</p>`;

function emptyNote(glyph: string, title: string, text: string) {
  return `<div class="empty small-empty"><div class="empty-glyph">${glyph}</div><h2>${title}</h2><p>${text}</p></div>`;
}

function renderTab(fam: Family, face: Face): string {
  const text = esc(state.previewText || fam.name);
  const details = state.details.get(face.id);
  const font = cssFont(face);

  switch (state.tab) {
    case "specimen": {
      const [p1, p2, p3] = SPECIMEN.paragraphs.map(esc);
      return `<div class="specimen" style="font-family:${font}">
        <div class="sp-title">${esc(state.previewText || SPECIMEN.title)}</div>
        <div class="sp-alpha">${esc(SPECIMEN.alphabet)}</div>
        <div class="sp-label">24 pt</div><p class="sp-24">${p1}</p>
        <div class="sp-label">16 pt</div><p class="sp-16">${p2}</p>
        <div class="sp-label">12 pt</div><p class="sp-12">${p3}</p>
        <div class="sp-label">Chiffres</div><p class="sp-16">${esc(SPECIMEN.figures)}</p>
        <div class="sp-label sp-row">Sur fond
          <span class="sp-swatches">${["blue", "red", "green", "purple", "orange", "gray"]
            .map(
              (c) =>
                `<button type="button" class="swatch mini${c === state.tileColor ? " on" : ""}" data-tile-color="${c}" style="background:${TAG_COLORS[c]}" title="${c}"></button>`,
            )
            .join("")}</span>
        </div>
        <div class="sp-tiles">
          <div class="sp-tile paper"><div class="sp-tile-title">${esc(SPECIMEN.title)}</div><p>${p1}</p></div>
          <div class="sp-tile" style="background:${tagColor(state.tileColor)}"><p>${esc(fam.name)}</p><div class="sp-tile-title">Aa Bb Cc 123</div></div>
        </div>
      </div>`;
    }

    case "styles": {
      const sizes = [12, 16, 24, 36, 48, 72];
      return `
        <div class="styles">
          ${fam.faces
            .map(
              (f) => `<div class="style-row${f.id === face.id ? " selected" : ""}" data-face="${esc(f.id)}">
                <div class="muted small">${esc(f.style)} · ${f.weight}${f.italic ? " · italique" : ""}</div>
                <div class="style-preview" style="font-family:${cssFont(f)};font-size:${state.previewSize}px">${text}</div>
              </div>`,
            )
            .join("")}
        </div>
        <h3>Cascade · ${esc(face.style)}</h3>
        <div class="waterfall" style="font-family:${font}">
          ${sizes.map((s) => `<div><span class="muted mono small">${s}</span><span style="font-size:${s}px">${text}</span></div>`).join("")}
        </div>`;
    }

    case "glyphs": {
      if (!details) return LOADING;
      const test = GLYPH_GROUPS.find(([k]) => k === state.glyphGroup)?.[2] ?? (() => true);
      const q = state.glyphSearch.trim();
      const hexQuery = q.replace(/^u\+/i, "");
      const shown = details.characters.filter(
        (c) =>
          test(c) &&
          (!q ||
            String.fromCodePoint(c) === q ||
            (/^[0-9a-f]{2,6}$/i.test(hexQuery) && c.toString(16).toUpperCase().includes(hexQuery.toUpperCase()))),
      );
      const cp = state.selectedChar ?? shown.find((c) => c > 0x40) ?? shown[0];
      const hex = (c: number) => c.toString(16).toUpperCase().padStart(4, "0");
      return `
        <div class="glyph-tools">
          <label class="search-field small-search">${icon("search")}
            <input id="glyph-search" type="search" placeholder="Caractère ou code (U+00E9)" value="${esc(state.glyphSearch)}" spellcheck="false" />
          </label>
          <div class="chip-row">${GLYPH_GROUPS.filter(([k, , t]) => k === "all" || details.characters.some(t))
            .map(([k, l]) => `<button type="button" class="filter-chip${state.glyphGroup === k ? " on" : ""}" data-glyph-group="${k}">${l}</button>`)
            .join("")}</div>
        </div>
        ${
          cp !== undefined
            ? `<div class="char-hero" style="font-family:${font}">
          <div class="char-big">${esc(String.fromCodePoint(cp))}</div>
          <div class="char-meta">
            <div class="mono">U+${hex(cp)}</div>
            <div class="muted small">${shown.length} sur ${details.characters.length}${details.charactersTruncated ? "+" : ""} caractères · ${face.glyphCount} glyphes</div>
            <button data-action="copy-char" data-cp="${cp}">Copier</button>
          </div>
        </div>`
            : ""
        }
        <div class="char-grid" style="font-family:${font}">
          ${shown
            .map(
              (c) =>
                `<button class="char${c === cp ? " on" : ""}" data-cp="${c}" title="U+${hex(c)}, double-clic pour copier"><span>${esc(String.fromCodePoint(c))}</span><small>${hex(c)}</small></button>`,
            )
            .join("")}
        </div>
        ${shown.length ? "" : `<p class="muted">Aucun caractère ne correspond.</p>`}`;
    }

    case "languages": {
      const support = state.languages.get(face.id);
      if (!support) return LOADING;
      const yes = support.filter(Boolean).length;
      const rows = LANGUAGES.map((l, i) => ({ ...l, ok: support[i] })).filter(
        (l) => state.languageFilter === "all" || (state.languageFilter === "yes") === l.ok,
      );
      const seg = (v: string, label: string, n: number) =>
        `<button type="button" data-language-filter="${v}" class="${state.languageFilter === v ? "on" : ""}">${label} <span class="count">${n}</span></button>`;
      return `<div class="segmented small-seg lang-seg">
          ${seg("all", "Toutes", LANGUAGES.length)}${seg("yes", "Prises en charge", yes)}${seg("no", "Manquantes", LANGUAGES.length - yes)}
        </div>
        <div class="languages">
          ${rows
            .map(
              (l) => `<div class="lang${l.ok ? "" : " missing"}">
                <div class="lang-name">${esc(l.name)}${l.ok ? "" : ` <span class="miss">caractères manquants</span>`}</div>
                <div class="lang-sample" style="font-family:${font}"${l.rtl ? ' dir="rtl"' : ""}>${esc(l.sample)}</div>
              </div>`,
            )
            .join("")}
        </div>`;
    }

    case "info": {
      const folder = face.path.replace(/[\\/][^\\/]*$/, "");
      const file = face.path.slice(folder.length + 1);
      const rows: [string, string | number | null | undefined][] = [
        ["Famille", face.family],
        ["Style", face.style],
        ["Nom complet", face.fullName],
        ["PostScript", face.psName],
        ["Classification", CLASSES[face.classification]],
        ["Format", details?.format ?? formatOf(face.path)],
        ["Taille", details ? sizeOf(details.fileSize) : null],
        ["Graisse", face.weight],
        ["Italique", face.italic ? "Oui" : "Non"],
        ["Chasse fixe", face.mono ? "Oui" : "Non"],
        ["Glyphes", face.glyphCount],
        ["Version", face.version],
        ["Créateur", face.designer],
        ["Fonderie", face.manufacturer],
        ["Licence", face.license],
        ["Copyright", face.copyright],
        [fam.system ? "Date du fichier" : "Ajoutée le", dateOf(face.addedAt)],
      ];
      return `<dl class="info">
        ${rows
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`)
          .join("")}
          <dt>Fichier</dt><dd><div class="file-row"><div>${esc(file)}<div class="muted small">${esc(folder)}</div></div>
            <button class="tool" data-action="reveal" data-path="${esc(face.path)}" title="Afficher dans le dossier">${icon("folder")}</button></div></dd>
        </dl>`;
    }

    case "features": {
      if (!details) return LOADING;
      if (!details.features.length)
        return emptyNote(`<span style="font-family:${font}">fi</span>`, "Aucune fonctionnalité OpenType", `${esc(fam.name)} n'en déclare aucune.`);
      const settingsCSS = [...state.features.entries()].map(([t, on]) => `'${cssTag(t)}' ${on ? 1 : 0}`).join(", ");
      return `
        <div class="feature-preview" style="font-family:${font};font-size:${Math.max(state.previewSize, 28)}px;font-feature-settings:${settingsCSS || "normal"}" contenteditable="plaintext-only" spellcheck="false">${text} 0123456789 1/2 fi fl</div>
        <div class="muted small">${plural(details.features.length, "fonctionnalité")}. Cliquez pour l'activer ou la désactiver dans l'aperçu</div>
        <div class="features">
          ${details.features
            .map((tag) => {
              const on = state.features.get(tag) ?? DEFAULT_ON.has(tag);
              const label =
                FEATURE_NAMES[tag] ??
                (/^ss\d\d$/.test(tag) ? `Jeu stylistique ${+tag.slice(2)}` : /^cv\d\d$/.test(tag) ? `Variante de caractère ${+tag.slice(2)}` : tag);
              return `<div class="feature"><button type="button" class="switch${on ? " on" : ""}" data-feature="${esc(tag)}" role="switch" aria-checked="${on}" aria-label="${esc(label)}"><span></span></button>
                <span>${esc(label)}</span><span class="mono muted">${esc(tag)}</span></div>`;
            })
            .join("")}
        </div>`;
    }

    case "axes": {
      if (!details) return LOADING;
      const settingsCSS = details.axes.map((a) => `'${cssTag(a.tag)}' ${state.axes.get(a.tag) ?? a.default}`).join(", ");
      return `
        <div class="feature-preview" style="font-family:${font};font-size:${Math.max(state.previewSize, 36)}px;font-variation-settings:${settingsCSS}">${text}</div>
        <div class="axes">
          ${details.axes
            .map((a) => {
              const v = state.axes.get(a.tag) ?? a.default;
              return `<label class="axis"><span>${esc(a.name)} <span class="muted mono">${esc(a.tag)}</span></span>
                <input type="range" data-axis="${esc(a.tag)}" min="${a.min}" max="${a.max}" step="${a.max - a.min > 20 ? 1 : 0.1}" value="${v}"/>
                <span class="mono small">${Math.round(v * 10) / 10}</span></label>`;
            })
            .join("")}
          <button data-action="reset-axes">Valeurs par défaut</button>
        </div>`;
    }
  }
}

// ------------------------------------------------------------------ context menu & toast

interface MenuItem {
  label: string;
  action?: () => void;
  danger?: boolean;
  header?: boolean;
}

function showMenu(x: number, y: number, items: (MenuItem | "-")[]) {
  const menu = $("#menu");
  menu.innerHTML = items
    .map((it, i) =>
      it === "-"
        ? `<hr/>`
        : it.header
          ? `<div class="menu-header">${esc(it.label)}</div>`
          : `<button data-index="${i}" class="${it.danger ? "danger" : ""}">${esc(it.label)}</button>`,
    )
    .join("");
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.min(y, innerHeight - rect.height - 8)}px`;
  menu.onclick = (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("button[data-index]");
    if (!btn) return;
    hideMenu();
    (items[+btn.dataset.index!] as MenuItem).action?.();
  };
}

const hideMenu = () => ($("#menu").hidden = true);
const menuBelow = (el: HTMLElement, items: (MenuItem | "-")[]) => {
  const r = el.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, items);
};

function familyMenu(families: Family[]): (MenuItem | "-")[] {
  const first = families[0];
  const names = families.map((f) => f.name);
  const items: (MenuItem | "-")[] = [];
  if (!first.system) {
    items.push(
      { label: "Activer", action: () => setScope(families, "persistent") },
      { label: "Activer temporairement", action: () => setScope(families, "temporary") },
      { label: "Désactiver", action: () => setScope(families, "none") },
      "-",
    );
  }
  items.push(
    { label: first.starred ? "Retirer des favoris" : "Ajouter aux favoris", action: () => setStarred(first, !first.starred) },
    "-",
    { label: "Ajouter à une collection", header: true },
    ...(state.lib?.collections ?? []).map((c) => ({
      label: `  ${c.name}`,
      action: () => libraryAction(families, () => api.addToCollection(c.id, names), `Ajoutée à « ${c.name} »`),
    })),
    { label: "  Nouvelle collection…", action: () => newCollection(families) },
    "-",
    ...tagItems(families),
  );
  if (state.sidebar.startsWith("col:")) {
    const id = state.sidebar.slice(4);
    items.push({ label: "Retirer de cette collection", action: () => run(api.removeFromCollection(id, names)) });
  }
  items.push("-");
  if (first.system) items.push({ label: "Copier le fichier dans la bibliothèque", action: () => copyToLibrary(families) });
  items.push({ label: "Afficher dans le dossier", action: () => revealItemInDir(first.rep.path).catch((e) => toast(String(e), true)) });
  if (first.inLibrary) {
    items.push(
      first.system
        ? { label: "Oublier favori, tags et collections…", danger: true, action: () => removeFamilies(families) }
        : { label: "Retirer de la bibliothèque…", danger: true, action: () => removeFamilies(families) },
    );
  }
  return items;
}

/** Toggle entries for manual tags (smart tags fill themselves). */
function tagItems(families: Family[]): (MenuItem | "-")[] {
  const names = families.map((f) => f.name);
  const manual = (state.lib?.tags ?? []).filter((t) => t.rule === null);
  return [
    { label: "Tags", header: true },
    ...manual.map((t) => {
      const on = families.every((f) => hasTag(f, t.id));
      return { label: `${on ? "✓" : "  "} ${t.name}`, action: () => libraryAction(families, () => api.setTagged(t.id, names, !on)) };
    }),
    { label: "  Nouveau tag…", action: () => newTag(false, families) },
  ];
}

function tagMenu(id: string): (MenuItem | "-")[] {
  const tag = state.lib?.tags.find((t) => t.id === id);
  if (!tag) return [];
  return [
    { label: "Activer les polices du tag", action: () => setScope(familiesWithTag(id), "persistent") },
    { label: "Activer temporairement", action: () => setScope(familiesWithTag(id), "temporary") },
    { label: "Désactiver les polices du tag", action: () => setScope(familiesWithTag(id), "none") },
    "-",
    { label: tag.rule !== null ? "Modifier les règles…" : "Modifier…", action: () => editExistingTag(tag) },
    {
      label: "Supprimer le tag…",
      danger: true,
      action: async () => {
        const ok = await ask(`Supprimer le tag « ${tag.name} » ? Les polices ne sont pas supprimées.`, {
          title: "Supprimer le tag",
          kind: "warning",
          okLabel: "Supprimer",
          cancelLabel: "Annuler",
        });
        if (ok) run(api.deleteTag(id));
      },
    },
  ];
}

function collectionMenu(id: string): (MenuItem | "-")[] {
  const collection = state.lib?.collections.find((c) => c.id === id);
  if (!collection) return [];
  return [
    { label: "Activer la collection", action: () => setScope(familiesInCollection(id), "persistent") },
    { label: "Activer temporairement", action: () => setScope(familiesInCollection(id), "temporary") },
    { label: "Désactiver la collection", action: () => setScope(familiesInCollection(id), "none") },
    "-",
    {
      label: "Renommer…",
      action: async () => {
        const name = await promptText("Renommer la collection", collection.name);
        if (name) run(api.renameCollection(id, name));
      },
    },
    { label: "Supprimer la collection", danger: true, action: () => run(api.deleteCollection(id)) },
  ];
}

let toastTimer: number | undefined;
function toast(message: string, error = false, duration = error ? 6000 : 3000) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), duration);
}

// ------------------------------------------------------------------ events

function selectFamily(key: string | null, faceId: string | null = null) {
  if (state.selected !== key) {
    state.selected = key;
    state.features.clear();
    state.axes.clear();
    state.selectedChar = null;
    state.faceId = null;
  }
  if (faceId) state.faceId = faceId;
  $("#family-list")
    .querySelectorAll<HTMLElement>(".font-card, .t-row:not(.t-face)")
    .forEach((row) => row.classList.toggle("selected", row.dataset.family === key));
  renderDetail();
}

function applyFilter(name: string, value: string) {
  const f = state.filter;
  if (name === "reset") state.filter = emptyFilter();
  else if (name === "status") f.status = value as typeof f.status;
  else if (name === "source") f.source = value as typeof f.source;
  else if (name === "class") f.classes.has(value) ? f.classes.delete(value) : f.classes.add(value);
  else if (name === "variable" || name === "mono" || name === "italic") f[name] = !f[name];
  renderList();
}

function applyGoogleFilter(name: string, value: string) {
  const f = state.googleFilter;
  if (name === "reset") state.googleFilter = emptyGoogleFilter();
  else if (name === "class") f.classes.has(value) ? f.classes.delete(value) : f.classes.add(value);
  else if (name === "variable" || name === "italic" || name === "hideInstalled") f[name] = !f[name];
  renderList();
}

function wire() {
  const sidebar = $("#sidebar");
  sidebar.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("#new-collection")) return void newCollection();
    const addTag = target.closest<HTMLElement>("#new-tag");
    if (addTag)
      return menuBelow(addTag, [
        { label: "Nouveau tag…", action: () => newTag(false) },
        { label: "Nouveau tag intelligent…", action: () => newTag(true) },
      ]);
    const nav = target.closest<HTMLElement>("[data-nav]");
    if (nav) {
      state.sidebar = nav.dataset.nav!;
      if (state.sidebar === "google" && !state.google) loadGoogle();
      render();
      $("#family-list").scrollTop = 0;
    }
  });
  sidebar.addEventListener("contextmenu", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-collection], [data-tag]");
    if (!el) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, el.dataset.collection ? collectionMenu(el.dataset.collection) : tagMenu(el.dataset.tag!));
  });
  // Drag a family from the list onto a collection or a manual tag.
  const dropTarget = (e: Event) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-collection], [data-tag]");
    if (el?.dataset.tag && state.lib?.tags.find((t) => t.id === el.dataset.tag)?.rule !== null) return null;
    return el;
  };
  sidebar.addEventListener("dragover", (e) => {
    const el = dropTarget(e);
    if (el && e.dataTransfer?.types.includes("application/x-typeshelf-family")) {
      e.preventDefault();
      el.classList.add("drop-target");
    }
  });
  sidebar.addEventListener("dragleave", (e) =>
    (e.target as HTMLElement).closest("[data-collection], [data-tag]")?.classList.remove("drop-target"),
  );
  sidebar.addEventListener("drop", (e) => {
    const el = dropTarget(e);
    const fam = familyByKey(e.dataTransfer?.getData("application/x-typeshelf-family") ?? null);
    if (!el || !fam) return;
    e.preventDefault();
    el.classList.remove("drop-target");
    if (el.dataset.tag) {
      const tag = state.lib?.tags.find((t) => t.id === el.dataset.tag);
      return void libraryAction([fam], () => api.setTagged(el.dataset.tag!, [fam.name], true), `Tag « ${tag?.name ?? ""} » ajouté`);
    }
    const collection = state.lib?.collections.find((c) => c.id === el.dataset.collection);
    libraryAction([fam], () => api.addToCollection(el.dataset.collection!, [fam.name]), `Ajoutée à « ${collection?.name ?? ""} »`);
  });

  const list = $("#family-list");
  list.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-action="import"]')) return void importDialog();
    const filter = target.closest<HTMLElement>("[data-filter]");
    if (filter) return applyFilter(filter.dataset.filter!, filter.dataset.value ?? "");
    const gfilter = target.closest<HTMLElement>("[data-gfilter]");
    if (gfilter) return applyGoogleFilter(gfilter.dataset.gfilter!, gfilter.dataset.value ?? "");
    if (isGoogle()) {
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action === "gf-retry") return void loadGoogle();
      if (action === "gf-more") {
        state.googleLimit += GOOGLE_PAGE;
        return renderList();
      }
      const name = target.closest<HTMLElement>("[data-gfamily]")?.dataset.gfamily;
      if (!name) return;
      if (action === "gf-install") return void googleInstall(name, true);
      if (action === "gf-show") return showInLibrary(name);
      return selectFamily(`g:${name}`);
    }
    const sort = target.closest<HTMLElement>("[data-sort]");
    if (sort) {
      const key = sort.dataset.sort as Sort;
      state.sort = key === "name" && state.sort === "name" ? "name-desc" : key;
      return renderList();
    }
    const row = target.closest<HTMLElement>("[data-family]");
    const fam = row && familyByKey(row.dataset.family!);
    if (!row || !fam) return;
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action === "star") return void setStarred(fam, !fam.starred);
    if (action === "toggle") return void setScope([fam], activation(fam) === "inactive" ? "persistent" : "none");
    if (action === "expand") {
      state.expanded.has(fam.key) ? state.expanded.delete(fam.key) : state.expanded.add(fam.key);
      return renderList();
    }
    selectFamily(fam.key, row.dataset.face ?? null);
  });
  list.addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-family]");
    if (!row || (e.target as HTMLElement).closest("button")) return;
    settings.inspector = true;
    selectFamily(row.dataset.family!);
  });
  list.addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-family]");
    const fam = row && familyByKey(row.dataset.family!);
    if (!fam) return;
    e.preventDefault();
    selectFamily(fam.key);
    showMenu(e.clientX, e.clientY, familyMenu([fam]));
  });
  list.addEventListener("dragstart", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-family]");
    if (row && e.dataTransfer) {
      e.dataTransfer.setData("application/x-typeshelf-family", row.dataset.family!);
      e.dataTransfer.effectAllowed = "copy";
    }
  });
  list.addEventListener("keydown", (e) => {
    const columns = settings.view === "rows" ? 1 : getComputedStyle(list).gridTemplateColumns.split(" ").length;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[e.key];
    if (!step) return;
    e.preventDefault();
    const keys = isGoogle()
      ? visibleGoogle()
          .slice(0, state.googleLimit)
          .map((g) => `g:${g.family}`)
      : visibleFamilies().map((f) => f.key);
    const i = state.selected ? keys.indexOf(state.selected) : -1;
    const next = keys[i < 0 ? 0 : Math.max(0, Math.min(keys.length - 1, i + step))];
    if (next) {
      selectFamily(next);
      list.querySelector<HTMLElement>(".selected")?.scrollIntoView({ block: "nearest" });
    }
  });

  $("#filter-bar").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const g = target.closest<HTMLElement>("[data-gfilter]");
    if (g) return applyGoogleFilter(g.dataset.gfilter!, g.dataset.value ?? "");
    const el = target.closest<HTMLElement>("[data-filter]");
    if (el) applyFilter(el.dataset.filter!, el.dataset.value ?? "");
  });
  $("#filter-button").addEventListener("click", () => {
    state.showFilters = !state.showFilters;
    renderList();
  });
  $("#sort-button").addEventListener("click", (e) =>
    menuBelow(
      e.currentTarget as HTMLElement,
      isGoogle()
        ? (Object.entries(GOOGLE_SORTS) as [GoogleSort, string][]).map(([key, label]) => ({
            label: `${state.googleSort === key ? "✓" : "  "} ${label}`,
            action: () => {
              state.googleSort = key;
              renderList();
            },
          }))
        : (Object.entries(SORTS) as [Sort, string][]).map(([key, label]) => ({
        label: `${state.sort === key ? "✓" : "  "} ${label}`,
        action: () => {
          state.sort = key;
          renderList();
        },
      })),
    ),
  );

  const detail = $("#detail");
  detail.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (state.selected?.startsWith("g:")) {
      const name = state.selected.slice(2);
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action === "close") return selectFamily(null);
      if (action === "gf-install") return void googleInstall(name, true);
      if (action === "gf-download") return void googleInstall(name, false);
      if (action === "gf-show") return showInLibrary(name);
      return;
    }
    const fam = familyByKey(state.selected);
    if (!fam) return;
    const scope = target.closest<HTMLElement>("[data-scope]")?.dataset.scope as Scope | undefined;
    if (scope) return void setScope([fam], scope);
    const tab = target.closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
    if (tab) {
      state.tab = tab;
      return renderDetail();
    }
    const faceRow = target.closest<HTMLElement>("[data-face]");
    if (faceRow) {
      state.faceId = faceRow.dataset.face!;
      return renderDetail();
    }
    const char = target.closest<HTMLElement>(".char[data-cp]");
    if (char) {
      state.selectedChar = +char.dataset.cp!;
      return renderDetail();
    }
    const group = target.closest<HTMLElement>("[data-glyph-group]");
    if (group) {
      state.glyphGroup = group.dataset.glyphGroup!;
      state.selectedChar = null;
      return renderDetail();
    }
    const languageFilter = target.closest<HTMLElement>("[data-language-filter]");
    if (languageFilter) {
      state.languageFilter = languageFilter.dataset.languageFilter as typeof state.languageFilter;
      return renderDetail();
    }
    const tile = target.closest<HTMLElement>("[data-tile-color]");
    if (tile) {
      state.tileColor = tile.dataset.tileColor!;
      return renderDetail();
    }
    const feature = target.closest<HTMLElement>("[data-feature]");
    if (feature) {
      const tag = feature.dataset.feature!;
      state.features.set(tag, !(state.features.get(tag) ?? DEFAULT_ON.has(tag)));
      return renderDetail();
    }
    const actionEl = target.closest<HTMLElement>("[data-action]");
    switch (actionEl?.dataset.action) {
      case "star":
        return void setStarred(fam, !fam.starred);
      case "more":
        return menuBelow(actionEl, familyMenu([fam]));
      case "close":
        return selectFamily(null);
      case "tags":
        return menuBelow(actionEl, tagItems([fam]));
      case "reveal":
        return void revealItemInDir(actionEl.dataset.path!).catch((err) => toast(String(err), true));
      case "copy-char":
        return copyChar(actionEl.dataset.cp);
      case "reset-axes":
        state.axes.clear();
        return renderDetail();
    }
  });
  detail.addEventListener("dblclick", (e) => {
    const char = (e.target as HTMLElement).closest<HTMLElement>(".char[data-cp]");
    if (char) copyChar(char.dataset.cp);
  });
  detail.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    if (target.id === "face-select") {
      state.faceId = target.value;
      state.selectedChar = null;
      renderDetail();
    }
  });
  detail.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    if (target.id === "glyph-search") {
      state.glyphSearch = target.value;
      state.selectedChar = null;
      renderDetail();
      const input = $<HTMLInputElement>("#glyph-search");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (!target.dataset.axis) return;
    state.axes.set(target.dataset.axis, +target.value);
    const fam = familyByKey(state.selected);
    const details = fam && state.details.get(currentFace(fam).id);
    if (!details) return;
    // Update in place so the slider keeps focus while dragging.
    const css = details.axes.map((a) => `'${cssTag(a.tag)}' ${state.axes.get(a.tag) ?? a.default}`).join(", ");
    detail.querySelector<HTMLElement>(".feature-preview")!.style.fontVariationSettings = css;
    target.nextElementSibling!.textContent = String(Math.round(+target.value * 10) / 10);
  });

  $<HTMLInputElement>("#search").addEventListener("input", (e) => {
    state.search = (e.target as HTMLInputElement).value;
    renderList();
  });
  $<HTMLInputElement>("#preview-text").addEventListener("input", (e) => {
    state.previewText = (e.target as HTMLInputElement).value;
    refreshPreviews();
  });
  $<HTMLInputElement>("#preview-size").addEventListener("input", (e) => {
    state.previewSize = +(e.target as HTMLInputElement).value;
    refreshPreviews();
  });

  $("#import-button").addEventListener("click", (e) =>
    menuBelow(e.currentTarget as HTMLElement, [
      { label: "Fichiers de polices…", action: () => importDialog() },
      { label: "Dossier…", action: () => importDialog(true) },
    ]),
  );

  // View and inspector toggles in the toolbar.
  const syncToolbar = () =>
    document.querySelectorAll<HTMLElement>("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === settings.view));
  syncToolbar();
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((b) =>
    b.addEventListener("click", () => {
      settings.view = b.dataset.view === "rows" ? "rows" : "grid";
      syncToolbar();
      renderList();
    }),
  );
  $("#inspector-button").addEventListener("click", () => {
    settings.inspector = !settings.inspector;
    renderDetail();
  });

  const settingsDialog = $<HTMLDialogElement>("#settings-dialog");
  const showSettingsTab = (tab: string) => {
    settingsDialog.querySelectorAll<HTMLElement>("[data-settings-tab]").forEach((b) => {
      b.classList.toggle("on", b.dataset.settingsTab === tab);
      if (b.dataset.settingsTab === tab) $("#settings-title").textContent = b.textContent!.trim();
    });
    settingsDialog.querySelectorAll<HTMLElement>("[data-settings-page]").forEach((page) => (page.hidden = page.dataset.settingsPage !== tab));
  };
  const syncSettings = () => {
    $<HTMLInputElement>("#setting-copy").checked = settings.copyOnImport;
    $<HTMLInputElement>("#setting-inspector").checked = settings.inspector;
    $("#library-path").textContent = state.lib?.fontsDir ?? "";
    $<HTMLInputElement>("#setting-google").checked = settings.google;
    $<HTMLInputElement>("#setting-google-cjk").checked = settings.googleCjk;
    $<HTMLInputElement>("#setting-plugins").checked = settings.plugins;
    $<HTMLInputElement>("#setting-plugins-google").checked = settings.pluginsGoogle;
    $<HTMLInputElement>("#setting-plugins-google").disabled = !settings.plugins;
    api.pluginApiStatus().then(showPluginStatus, () => showPluginStatus(null));
    syncGoogleStatus();
    settingsDialog
      .querySelectorAll<HTMLElement>("[data-theme-choice]")
      .forEach((b) => b.classList.toggle("on", b.dataset.themeChoice === settings.theme));
  };
  $("#settings-button").addEventListener("click", () => {
    syncSettings();
    showSettingsTab("general");
    settingsDialog.showModal();
  });
  settingsDialog.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const tab = target.closest<HTMLElement>("[data-settings-tab]");
    if (tab) return showSettingsTab(tab.dataset.settingsTab!);
    const theme = target.closest<HTMLElement>("[data-theme-choice]");
    if (theme) {
      settings.theme = theme.dataset.themeChoice as Theme;
      applyTheme();
      syncSettings();
    }
  });
  $<HTMLInputElement>("#setting-copy").addEventListener("change", (e) => {
    settings.copyOnImport = (e.target as HTMLInputElement).checked;
  });
  $<HTMLInputElement>("#setting-inspector").addEventListener("change", (e) => {
    settings.inspector = (e.target as HTMLInputElement).checked;
    renderDetail();
  });
  $<HTMLInputElement>("#setting-google").addEventListener("change", (e) => {
    settings.google = (e.target as HTMLInputElement).checked;
    if (!settings.google && isGoogle()) state.sidebar = "all";
    if (!settings.google && state.selected?.startsWith("g:")) state.selected = null;
    render();
  });
  $<HTMLInputElement>("#setting-google-cjk").addEventListener("change", (e) => {
    settings.googleCjk = (e.target as HTMLInputElement).checked;
    render();
  });
  $("#google-refresh").addEventListener("click", () => loadGoogle(true));
  $<HTMLInputElement>("#setting-plugins").addEventListener("change", (e) => {
    settings.plugins = (e.target as HTMLInputElement).checked;
    $<HTMLInputElement>("#setting-plugins-google").disabled = !settings.plugins;
    configurePlugins();
  });
  $<HTMLInputElement>("#setting-plugins-google").addEventListener("change", (e) => {
    settings.pluginsGoogle = (e.target as HTMLInputElement).checked;
    configurePlugins();
  });
  $("#reveal-library").addEventListener("click", () => {
    if (state.lib) revealItemInDir(state.lib.fontsDir).catch((e) => toast(String(e), true));
  });
  $("#deactivate-all").addEventListener("click", () => {
    settingsDialog.close();
    setScope(state.families, "none");
  });

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    target.closest("[data-close]")?.closest("dialog")?.close("cancel");
    if (!target.closest("#menu, #import-button, #sort-button, #new-tag, [data-action='more'], [data-action='tags']")) hideMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const typing = (e.target as HTMLElement).closest("input, select, textarea, [contenteditable], dialog");
      if (!$("#menu").hidden) hideMenu();
      else if (!typing && state.selected) selectFamily(null);
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      $<HTMLInputElement>("#search").focus();
    }
  });

  // Files dropped from the OS file manager.
  const overlay = $("#drop-overlay");
  Promise.resolve()
    .then(() =>
      getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter") overlay.hidden = !p.paths.length;
        else if (p.type === "leave") overlay.hidden = true;
        else if (p.type === "drop") {
          overlay.hidden = true;
          importPaths(p.paths);
        }
      }),
    )
    .catch(() => {
      /* not running inside Tauri */
    });
}

function copyChar(cp: string | undefined) {
  if (!cp) return;
  navigator.clipboard.writeText(String.fromCodePoint(+cp)).then(
    () => toast("Caractère copié"),
    () => toast("Copie impossible", true),
  );
}

async function importDialog(directory = false) {
  const picked = await open({
    multiple: true,
    directory,
    title: directory ? "Importer un dossier de polices" : "Importer des polices",
    filters: directory ? undefined : [{ name: "Polices", extensions: ["ttf", "otf", "ttc", "otc"] }],
  });
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
  importPaths(paths);
}

async function start() {
  // `npm run dev` opened in a plain browser: use demo data instead of the Rust backend.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) await import("./dev/mock");
  applyTheme();
  // Room for the macOS window buttons drawn over the sidebar (overlay title bar).
  if (/Mac/.test(navigator.userAgent)) document.documentElement.classList.add("mac");
  hydrateIcons();
  wire();
  await reload();
  loadSystemFonts();
  configurePlugins();
  listen<PluginActivity>("plugin-activity", (e) => onPluginActivity(e.payload)).catch(() => {
    /* not running inside Tauri */
  });
}

start();
