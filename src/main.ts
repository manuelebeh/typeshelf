import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, fontURL, type Face, type FaceDetails, type GoogleCatalog, type GoogleFamily, type DuplicateCopy, type DuplicateGroup, type Insights, type Library, type PluginActivity, type PluginApiStatus, type PluginInstallState, type Scope, type Tag } from "./api";
import {
  categoryLabel,
  classOf,
  cssFamily,
  emptyGoogleFilter,
  folderName,
  googleClassLabels,
  googleSortLabels,
  googleFilterCount,
  hasItalic,
  loadPreview,
  parseStyle,
  sortGoogle,
  styleLabel,
  type GoogleSort,
} from "./google";
import {
  emptyFilter,
  filterCount as countFilters,
  matchesSearch,
  passesFilter,
  sameRange,
  WEIGHT_PRESETS,
  WEIGHT_SCALE,
  WIDTH_PRESETS,
  WIDTH_SCALE,
  type Filter,
  type Range,
} from "./filters";
import { hydrateIcons, icon } from "./icons";
import { dateLocale, N_, setLanguage, t, tn, translateStatic, type Language } from "./i18n";
import { fileName, selectByRule, selectionImpact, versionNumber, type SelectRule } from "./insights";
import { matchesRule, parseRule, type Rule } from "./rules";
import { GLYPH_GROUPS, LANGUAGES, specimen } from "./samples";
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

const classLabels = (): Record<string, string> => ({
  sans: t("Sans serif"),
  serif: t("Serif"),
  slab: t("Slab serif"),
  mono: t("Monospace"),
  script: t("Script"),
  display: t("Display"),
  symbol: t("Symbols & icons"),
  other: t("Other"),
});

const sortLabels = (): Record<Sort, string> => ({
  name: t("Name (A → Z)"),
  "name-desc": t("Name (Z → A)"),
  recent: t("Date added (newest first)"),
  styles: t("Number of styles"),
});

const featureNames = (): Record<string, string> => ({
  liga: t("Standard ligatures"),
  dlig: t("Discretionary ligatures"),
  hlig: t("Historical ligatures"),
  calt: t("Contextual alternates"),
  kern: t("Kerning"),
  smcp: t("Small capitals"),
  c2sc: t("Capitals to small capitals"),
  pcap: t("Petite capitals"),
  case: t("Case-sensitive forms"),
  onum: t("Oldstyle figures"),
  lnum: t("Lining figures"),
  tnum: t("Tabular figures"),
  pnum: t("Proportional figures"),
  zero: t("Slashed zero"),
  frac: t("Fractions"),
  sups: t("Superscript"),
  subs: t("Subscript"),
  sinf: t("Scientific inferiors"),
  ordn: t("Ordinals"),
  swsh: t("Swashes"),
  salt: t("Stylistic alternates"),
  titl: t("Titling forms"),
  ccmp: t("Glyph composition"),
  locl: t("Localized forms"),
  mark: t("Mark positioning"),
  mkmk: t("Mark to mark positioning"),
});
const featureLabel = (tag: string): string =>
  featureNames()[tag] ??
  (/^ss\d\d$/.test(tag)
    ? t("Stylistic set {n}", { n: +tag.slice(2) })
    : /^cv\d\d$/.test(tag)
      ? t("Character variant {n}", { n: +tag.slice(2) })
      : tag);

/** Share of each OS/2 width class, in percent of the normal width. */
const WIDTH_PERCENT = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];

const DEFAULT_ON = new Set(["liga", "calt", "kern", "ccmp", "locl", "mark", "mkmk", "clig", "rlig"]);

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
  /** Every OpenType tag found, with the number of families offering it. */
  featureCounts: new Map<string, number>(),
  allFeatures: false,
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
  insights: null as Insights | null,
  insightsError: null as string | null,
  insightsView: "overview" as "overview" | "conflicts" | "duplicates",
  /** Files ticked for the Trash. */
  insightsSelected: new Set<string>(),
  insightsLimit: 100,
};

const INSIGHTS_PAGE = 100;

const GOOGLE_PAGE = 120;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** OpenType tags come from font files: keep them to safe characters before using them in CSS. */
const cssTag = (tag: string) => tag.replace(/[^A-Za-z0-9 _]/g, "");

const isSystemFace = (f: Face) => f.id.startsWith("sys-");

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
  get language(): Language {
    const v = stored("language", "auto");
    return v === "en" || v === "fr" ? v : "auto";
  },
  set language(v: Language) {
    store("language", v);
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

/** Sets the language of the interface and redraws what is already on screen. */
function applyLanguage() {
  setLanguage(settings.language);
  translateStatic();
  document.title = "Typeshelf";
}

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
  state.featureCounts = new Map();
  for (const fam of state.families) {
    for (const tag of new Set(fam.faces.flatMap((f) => f.features))) {
      state.featureCounts.set(tag, (state.featureCounts.get(tag) ?? 0) + 1);
    }
  }
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

const activationLabels = (): Record<Activation, string> => ({
  inactive: t("Not active"),
  temporary: t("Active until Typeshelf quits"),
  persistent: t("Active (permanent)"),
  mixed: t("Partially active"),
  system: t("Always active (installed on the system)"),
});

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

const filterCount = (): number => (isGoogle() ? googleFilterCount(state.googleFilter) : countFilters(state.filter));

const passes = (fam: Family, filter: Filter) => passesFilter(filter, fam, (status) => matches(fam, status));

function visibleFamilies(): Family[] {
  const list = state.families.filter(
    (fam) => matches(fam, state.sidebar) && passes(fam, state.filter) && matchesSearch(fam.faces, state.search),
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
    if (refresh) toast(tn(state.google.families.length, "Google Fonts catalog up to date: {n} family", "Google Fonts catalog up to date: {n} families"));
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
    ? t("Unknown status.")
    : !status.enabled
      ? t("Connection off: plugins cannot activate anything.")
      : status.listening
        ? t("Listening on 127.0.0.1:{port}.", { port: status.port })
        : (status.error ?? t("Starting…"));
}

async function configurePlugins() {
  try {
    showPluginStatus(await api.pluginApiConfig(settings.plugins, settings.pluginsGoogle));
  } catch {
    showPluginStatus(null);
  }
}

/** Where each plugin appears in its application. */
const pluginMenus: Record<string, string> = {
  photoshop: N_("Plugins ▸ Typeshelf"),
  illustrator: N_("Window ▸ Extensions ▸ Typeshelf"),
  "after-effects": N_("Window ▸ Extensions ▸ Typeshelf"),
  indesign: N_("Window ▸ Extensions ▸ Typeshelf"),
  sketch: N_("Plugins ▸ Typeshelf"),
  figma: N_("Plugins ▸ Development ▸ Typeshelf"),
};

/** A small badge in each host app's colours (Adobe-style monograms, the Sketch gem). */
function pluginBadge(id: string): string {
  const mono: Record<string, [string, string, string]> = {
    photoshop: ["Ps", "#001e36", "#31a8ff"],
    illustrator: ["Ai", "#330000", "#ff9a00"],
    "after-effects": ["Ae", "#00005b", "#9999ff"],
    indesign: ["Id", "#49021f", "#ff3366"],
  };
  const m = mono[id];
  if (m) return `<span class="plugin-badge" style="background:${m[1]};color:${m[2]};border-color:${m[2]}" aria-hidden="true">${m[0]}</span>`;
  if (id === "figma")
    return `<span class="plugin-badge figma" aria-hidden="true"><svg viewBox="2 -2 20 28" width="16" height="22"><path d="M8 24a4 4 0 0 0 4-4v-4H8a4 4 0 0 0 0 8z" fill="#0acf83"/><path d="M4 12a4 4 0 0 1 4-4h4v8H8a4 4 0 0 1-4-4z" fill="#a259ff"/><path d="M4 4a4 4 0 0 1 4-4h4v8H8a4 4 0 0 1-4-4z" fill="#f24e1e"/><path d="M12 0h4a4 4 0 0 1 0 8h-4z" fill="#ff7262"/><path d="M20 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z" fill="#1abcfe"/></svg></span>`;
  if (id === "sketch")
    return `<span class="plugin-badge sketch" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 3h10l5 6-10 12L2 9z" fill="#fdad00"/><path d="M12 21 7 9h10z" fill="#ea6c00"/><path d="M7 3 2 9h5zM17 3l5 6h-5z" fill="#fdd231"/><path d="M7 3h10l-2 6H9z" fill="#fdad00"/></svg></span>`;
  return "";
}

async function renderPluginList() {
  const list = document.querySelector<HTMLElement>("#plugin-list");
  if (!list) return;
  let plugins: PluginInstallState[];
  try {
    plugins = await api.pluginsList();
  } catch (e) {
    list.innerHTML = `<p class="hint">${esc(String(e))}</p>`;
    return;
  }
  $("#plugin-cep-hint").hidden = !plugins.some((p) => p.id === "illustrator" || p.id === "after-effects");
  if (!plugins.length) {
    list.innerHTML = `<p class="hint">${esc(t("The plugins are for macOS and Windows."))}</p>`;
    return;
  }
  list.innerHTML = plugins
    .map((p) => {
      const status =
        p.state === "installed" ? t("Installed") : p.state === "outdated" ? t("Update available") : t("Not installed");
      const details = [t(pluginMenus[p.id] ?? "")];
      if (!p.appFound && p.state === "absent") details.push(t("{name} not found on this computer", { name: p.name }));
      const install = p.state === "installed" ? "" : `<button type="button" data-plugin-install="${p.id}">${esc(p.state === "outdated" ? t("Install update") : t("Install"))}</button>`;
      const remove = p.state === "absent" ? "" : `<button type="button" data-plugin-remove="${p.id}">${esc(t("Remove"))}</button>`;
      return `<div class="plugin-item">
        ${pluginBadge(p.id)}
        <div class="plugin-text"><strong>${esc(p.name)}</strong><span class="hint"><span class="plugin-state ${p.state}">${esc(status)}</span> · ${esc(details.join(" · "))}</span></div>
        <div class="plugin-actions">${install}${remove}</div>
      </div>`;
    })
    .join("");
}

/** Settings is a modal dialog, above the toasts: plugin results are shown under the list. */
function pluginMessage(text: string, error = false) {
  const el = $("#plugin-message");
  el.textContent = text;
  el.classList.toggle("error", error);
  el.hidden = !text;
}

async function installPlugin(id: string, button: HTMLButtonElement) {
  button.disabled = true;
  try {
    const outcome = await api.pluginInstall(id);
    const { name } = outcome.plugin;
    const parts = [t("{name} plugin installed.", { name })];
    if (id === "figma") {
      // Figma has no folder to drop a plugin into: it is imported once from the manifest.
      parts.push(t("In Figma, choose Plugins ▸ Development ▸ Import plugin from manifest…, then select manifest.json in {path}.", { path: outcome.path }));
      const sep = outcome.path.includes("\\") ? "\\" : "/";
      revealItemInDir(`${outcome.path}${sep}manifest.json`).catch(() => {});
    } else {
      parts.push(
        outcome.restart
          ? t("Restart {name} to load it.", { name })
          : t("Open {name}, then {menu}.", { name, menu: t(pluginMenus[id] ?? "") }),
      );
    }
    if (outcome.debugMode) parts.push(t("Adobe's debug mode for unsigned extensions is now on."));
    pluginMessage(parts.join(" "));
  } catch (e) {
    pluginMessage(String(e), true);
  }
  renderPluginList();
}

async function removePlugin(id: string, button: HTMLButtonElement) {
  button.disabled = true;
  try {
    const plugin = await api.pluginUninstall(id);
    pluginMessage(
      plugin.appRunning
        ? t("{name} plugin removed. Restart {name} to unload it.", { name: plugin.name })
        : t("{name} plugin removed.", { name: plugin.name }),
    );
  } catch (e) {
    pluginMessage(String(e), true);
  }
  renderPluginList();
}

/** A plugin activated fonts for a document: refresh the library and say so. */
function onPluginActivity(activity: PluginActivity) {
  const parts = [];
  if (activity.activated.length) parts.push(tn(activity.activated.length, "{n} font activated", "{n} fonts activated"));
  if (activity.missing.length) {
    const names = activity.missing.slice(0, 3).join(", ") + (activity.missing.length > 3 ? "…" : "");
    parts.push(tn(activity.missing.length, "{n} font not found ({names})", "{n} fonts not found ({names})", { names }));
  }
  toast(`${activity.client} : ${parts.join(" · ")}`, activity.activated.length === 0, 6000);
  reload();
}

function syncGoogleStatus() {
  const el = document.querySelector("#google-status");
  if (!el) return;
  el.textContent = state.googleLoading
    ? t("Updating…")
    : state.google
      ? t("{count} · catalog of {date}", { count: tn(state.google.families.length, "{n} family", "{n} families"), date: dateOf(state.google.fetchedAt) })
      : (state.googleError ?? t("The catalog loads the first time you open the section."));
}

/** Downloads every style of a Google family into the library, optionally activating it. */
async function googleInstall(name: string, activate: boolean) {
  if (state.googleBusy.has(name)) return;
  state.googleBusy.add(name);
  render();
  toast(t("Downloading {name}…", { name }), false, 120_000);
  try {
    const { paths } = await api.googleDownload(name);
    const errors = activate && paths.length ? await api.setActivation(paths, "persistent") : [];
    if (errors.length) toast(errors.join("\n"), true);
    else if (activate) toast(tn(paths.length, "{name}: {n} style installed and active", "{name}: {n} styles installed and active", { name }));
    else toast(tn(paths.length, "{name}: {n} style downloaded", "{name}: {n} styles downloaded", { name }));
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
  if (!fam) return toast(t("Family not found in the library."), true);
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
    all: t("All fonts"),
    starred: t("Favorites"),
    system: t("System fonts"),
    library: t("Imported"),
    active: t("Active"),
    temporary: t("Temporarily active"),
    inactive: t("Inactive"),
    recent: t("Recently added"),
    google: "Google Fonts",
    insights: t("Insights"),
  };
  if (fixed[key]) return fixed[key];
  if (key.startsWith("class:")) return classLabels()[key.slice(6)] ?? t("Classification");
  if (key.startsWith("tag:")) return state.lib?.tags.find((t) => t.id === key.slice(4))?.name ?? t("Tag");
  return state.lib?.collections.find((c) => c.id === key.slice(4))?.name ?? t("Collection");
}

function formatOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "otf" ? "OpenType (CFF)" : ext === "ttc" ? t("TrueType Collection") : ext === "otc" ? t("OpenType Collection") : "TrueType";
}

const dateOf = (seconds: number) =>
  seconds > 0 ? new Date(seconds * 1000).toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" }) : "-";

const sizeOf = (bytes: number) =>
  bytes > 1024 * 1024 ? t("{n} MB", { n: (bytes / 1024 / 1024).toFixed(1) }) : t("{n} KB", { n: Math.max(1, Math.round(bytes / 1024)) });

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
  if (state.insights) loadInsights(false);
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
    toast(t("System fonts: {error}", { error: String(e) }), true);
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
  if (!paths.length) return toast(t("System fonts are always active."));
  return run(api.setActivation(paths, scope));
};

const setStarred = (fam: Family, starred: boolean) => libraryAction([fam], () => api.setStarred(fam.name, starred));

async function importPaths(paths: string[]) {
  if (!paths.length) return;
  toast(t("Importing…"), false, 60_000);
  const summary = await run(api.importPaths(paths, settings.copyOnImport));
  if (!summary) return;
  const parts = [tn(summary.imported, "{n} style imported", "{n} styles imported")];
  if (summary.skipped) parts.push(t("{n} already present", { n: summary.skipped }));
  if (summary.failures.length) parts.push(t("{n} unreadable", { n: summary.failures.length }));
  toast(parts.join(" · "), summary.imported === 0 && summary.failures.length > 0);
}

/** Copies installed font files into the library folder. */
function copyToLibrary(families: Family[]) {
  toast(t("Copying…"), false, 60_000);
  run(api.importPaths([...new Set(families.flatMap((f) => f.paths))], true), t("Copied to the library"));
}

async function removeFamilies(families: Family[]) {
  const names = families.map((f) => f.name).join(", ");
  const system = families.every((f) => f.system);
  const ok = await ask(
    system
      ? t("Forget the favorite, tags and collections of {names}? The font stays installed on the system.", { names })
      : t("Remove {names} from the library? The files copied by Typeshelf will go to the Trash.", { names }),
    {
      title: system ? t("Forget") : t("Remove from library"),
      kind: "warning",
      okLabel: system ? t("Forget") : t("Remove"),
      cancelLabel: t("Cancel"),
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
  const name = await promptText(t("New collection"));
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
    smart ? t("New smart tag") : t("New tag"),
    { name: "", color: "blue", rule: smart ? { match: "all", conditions: [] } : null },
    countRule,
    classLabels(),
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
    tag.rule !== null ? t("Edit smart tag") : t("Edit tag"),
    { name: tag.name, color: tag.color, rule: tag.rule !== null ? (parseRule(tag.rule) ?? { match: "all", conditions: [] }) : null },
    countRule,
    classLabels(),
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
    if (key === "insights") return state.insights?.groups.length || "";
    if (key === "google") return state.google ? googleBase().length : state.googleLoading ? "…" : "";
    return state.systemLoading && (key === "system" || key === "all") ? "…" : state.families.filter((f) => matches(f, key)).length;
  };
  const item = (key: string, label: string, glyph: string, extra = "") =>
    `<button class="nav-item${state.sidebar === key ? " selected" : ""}" data-nav="${esc(key)}" ${extra}>
       ${glyph}<span class="nav-label">${esc(label)}</span>
       <span class="badge">${count(key)}</span>
     </button>`;
  const section = (label: string, action = "") => `<div class="nav-section"><span>${esc(label)}</span>${action}</div>`;

  const classes = Object.entries(classLabels())
    .filter(([k]) => state.families.some((f) => matches(f, `class:${k}`)))
    .map(([k, label]) => item(`class:${k}`, label, icon("shapes")))
    .join("");

  const collections = (state.lib?.collections ?? [])
    .map((c) => item(`col:${c.id}`, c.name, icon("folder"), `data-collection="${esc(c.id)}"`))
    .join("");

  const tags = (state.lib?.tags ?? [])
    .map((tg) =>
      item(
        `tag:${tg.id}`,
        tg.name,
        `<span class="nav-swatch"><span class="tag-dot${tg.rule !== null ? " smart" : ""}" style="background:${tagColor(tg.color)};--c:${tagColor(tg.color)}"></span></span>`,
        `data-tag="${esc(tg.id)}"${tg.rule !== null ? ` title="${esc(t("Smart tag: fills itself according to its rules"))}"` : ""}`,
      ),
    )
    .join("");

  $("#sidebar-nav").innerHTML = `
    ${item("all", t("All fonts"), icon("all"))}
    ${item("starred", t("Favorites"), icon("star"))}
    ${item("system", t("System fonts"), icon("system"))}
    ${item("library", t("Imported"), icon("imported"))}
    ${item("recent", t("Recently added"), icon("recent"))}
    ${item("insights", t("Insights"), icon("insights"))}
    ${section(t("Status"))}
    ${item("active", t("Active"), icon("active"))}
    ${item("temporary", t("Temporary"), icon("temporary"))}
    ${item("inactive", t("Inactive"), icon("inactive"))}
    ${settings.google ? section(t("Online")) + item("google", "Google Fonts", icon("globe")) : ""}
    ${classes ? section(t("Classification")) + classes : ""}
    ${section(t("Collections"), `<button id="new-collection" title="${esc(t("New collection"))}" aria-label="${esc(t("New collection"))}">${icon("plus", 14)}</button>`)}
    ${collections || `<p class="muted small nav-empty">${t("Create a collection, then drag cards into it.")}</p>`}
    ${section(t("Tags"), `<button id="new-tag" title="${esc(t("New tag"))}" aria-label="${esc(t("New tag"))}">${icon("plus", 14)}</button>`)}
    ${tags || `<p class="muted small nav-empty">${t("Smart tags fill themselves according to your rules.")}</p>`}
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
  const chip = (name: string, value: string, label: string, on: boolean, title = "") =>
    `<button type="button" class="filter-chip${on ? " on" : ""}" data-filter="${name}" data-value="${esc(value)}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</button>`;
  bar.innerHTML = `
    <div class="filter-group"><span class="filter-label">${t("Status")}</span>${seg("status", f.status, [
      ["any", t("All")],
      ["active", t("Active")],
      ["temporary", t("Temporary")],
      ["inactive", t("Inactive")],
    ])}</div>
    <div class="filter-group"><span class="filter-label">${t("Source")}</span>${seg("source", f.source, [
      ["any", t("All")],
      ["system", t("System")],
      ["library", t("Imported")],
    ])}</div>
    <div class="filter-group"><span class="filter-label">${t("Classification")}</span>
      ${Object.entries(classLabels())
        .filter(([k]) => state.families.some((fam) => fam.classification === k))
        .map(([k, l]) => chip("class", k, l, f.classes.has(k)))
        .join("")}
    </div>
    <div class="filter-group"><span class="filter-label">${t("Properties")}</span>
      ${chip("variable", "1", t("Variable fonts"), f.variable)}
      ${chip("mono", "1", t("Monospaced"), f.mono)}
      ${chip("italic", "1", t("With italic"), f.italic)}
    </div>
    ${rangeGroup("weight", t("Weight"), f.weight, WEIGHT_SCALE, 100, [
      ["light", t("Light")],
      ["regular", t("Regular")],
      ["bold", t("Bold")],
    ])}
    ${rangeGroup("width", t("Width"), f.width, WIDTH_SCALE, 1, [
      ["narrow", t("Narrow")],
      ["normal", t("Normal")],
      ["wide", t("Wide")],
    ])}
    ${featureGroup(chip)}
    ${n ? `<button type="button" class="link" data-filter="reset">${t("Reset")}</button>` : ""}`;
}

type RangeName = "weight" | "width";

const rangePresets: Record<RangeName, Record<string, Range>> = { weight: WEIGHT_PRESETS, width: WIDTH_PRESETS };

function rangeText(name: RangeName, value: Range): string {
  if (sameRange(value, name === "weight" ? WEIGHT_SCALE : WIDTH_SCALE)) return t("All");
  const [from, to] = value.map((v) => (name === "width" ? `${WIDTH_PERCENT[v - 1]}%` : String(v)));
  return from === to ? from : `${from} – ${to}`;
}

function rangeGroup(name: RangeName, label: string, value: Range, scale: Range, step: number, presets: [string, string][]) {
  const input = (end: 0 | 1, hint: string) =>
    `<input type="range" data-range="${name}" data-end="${end}" min="${scale[0]}" max="${scale[1]}" step="${step}" value="${value[end]}" aria-label="${esc(`${label}: ${hint}`)}">`;
  return `<div class="filter-group"><span class="filter-label">${esc(label)}</span>
    <div class="range-dual" style="${rangeStyle(value, scale)}">${input(0, t("minimum"))}${input(1, t("maximum"))}</div>
    <span class="range-value" data-range-value="${name}">${esc(rangeText(name, value))}</span>
    ${presets
      .map(
        ([key, text]) =>
          `<button type="button" class="filter-chip${sameRange(value, rangePresets[name][key]) ? " on" : ""}" data-filter="${name}" data-value="${key}">${esc(text)}</button>`,
      )
      .join("")}
  </div>`;
}

const rangeStyle = (value: Range, [min, max]: Range) =>
  `--from:${((value[0] - min) / (max - min)) * 100}%;--to:${((value[1] - min) / (max - min)) * 100}%`;

const FEATURES_SHOWN = 12;

/** Features a designer picks come first; the layout plumbing most fonts carry comes last. */
function featureGroup(chip: (name: string, value: string, label: string, on: boolean, title?: string) => string) {
  const selected = state.filter.features;
  const rank = (tag: string) => (DEFAULT_ON.has(tag) ? 2 : featureNames()[tag] ? 0 : 1);
  const tags = [...new Set([...state.featureCounts.keys(), ...selected])].sort(
    (a, b) => rank(a) - rank(b) || (state.featureCounts.get(b) ?? 0) - (state.featureCounts.get(a) ?? 0) || a.localeCompare(b),
  );
  if (!tags.length) return "";
  const shown = state.allFeatures ? tags : tags.filter((tag, i) => i < FEATURES_SHOWN || selected.has(tag));
  return `<div class="filter-group filter-features"><span class="filter-label">OpenType</span>
    ${shown
      .map((tag) => {
        const name = featureLabel(tag);
        const count = state.featureCounts.get(tag) ?? 0;
        return chip("feature", tag, name === tag ? tag : `${name} · ${tag}`, selected.has(tag), tn(count, "{n} family", "{n} families"));
      })
      .join("")}
    ${tags.length > FEATURES_SHOWN ? `<button type="button" class="link" data-filter="allFeatures">${state.allFeatures ? t("Fewer") : t("More…")}</button>` : ""}
  </div>`;
}

/** Sliders update in place while they move: redrawing the bar would drop the drag. */
function applyRange(input: HTMLInputElement) {
  const name = input.dataset.range as RangeName;
  const end = Number(input.dataset.end) as 0 | 1;
  const value = state.filter[name];
  value[end] = Number(input.value);
  // The two thumbs push each other instead of crossing.
  const other = end === 0 ? 1 : 0;
  value[other] = end === 0 ? Math.max(value[0], value[1]) : Math.min(value[0], value[1]);
  const group = input.parentElement!;
  group.querySelector<HTMLInputElement>(`[data-end="${other}"]`)!.value = String(value[other]);
  group.setAttribute("style", rangeStyle(value, name === "weight" ? WEIGHT_SCALE : WIDTH_SCALE));
  $(`[data-range-value="${name}"]`).textContent = rangeText(name, value);
}

function renderGoogleFilterBar(bar: HTMLElement, n: number) {
  const f = state.googleFilter;
  const chip = (name: string, value: string, label: string, on: boolean) =>
    `<button type="button" class="filter-chip${on ? " on" : ""}" data-gfilter="${name}" data-value="${value}">${esc(label)}</button>`;
  bar.innerHTML = `
    <div class="filter-group"><span class="filter-label">${t("Category")}</span>
      ${Object.entries(googleClassLabels())
        .map(([k, l]) => chip("class", k, l, f.classes.has(k)))
        .join("")}
    </div>
    <div class="filter-group"><span class="filter-label">${t("Features")}</span>
      ${chip("variable", "1", t("Variable fonts"), f.variable)}
      ${chip("italic", "1", t("With italic"), f.italic)}
      ${chip("hideInstalled", "1", t("Hide the ones already present"), f.hideInstalled)}
    </div>
    ${n ? `<button type="button" class="link" data-gfilter="reset">${t("Reset")}</button>` : ""}`;
}

// ------------------------------------------------------------------ rendering: family list

function renderList() {
  $(".list-pane").classList.toggle("is-insights", isInsights());
  $("#family-list").classList.toggle("insights", isInsights());
  if (isInsights()) return renderInsights();
  renderFilterBar();
  if (isGoogle()) return renderGoogleList();
  const families = visibleFamilies();
  $("#list-title").textContent = sidebarTitle();
  $("#list-subtitle").textContent =
    state.systemLoading && (state.sidebar === "all" || state.sidebar === "system")
      ? t("reading installed fonts…")
      : tn(families.length, "{n} family", "{n} families") + (filterCount() ? ` ${t("(filtered)")}` : "");
  const list = $("#family-list");
  list.style.setProperty("--preview-size", `${state.previewSize}px`);
  list.classList.toggle("rows", settings.view === "rows");
  const empty = (html: string) => {
    list.classList.add("is-empty");
    list.innerHTML = `<div class="empty">${html}</div>`;
  };

  if (!families.length) {
    if (state.systemLoading && state.sidebar === "system") return empty(`<p>${t("Reading installed fonts…")}</p>`);
    if (state.sidebar === "library" && !state.families.some((f) => f.inLibrary && !f.system)) {
      return empty(`<div class="empty-icon">${icon("drop", 44)}</div>
        <h2>${t("No imported fonts yet")}</h2>
        <p>${t("Drag files or folders into the window. Fonts that are already installed are under “System fonts”.")}</p>
        <button class="primary" data-action="import">${t("Import fonts…")}</button>`);
    }
    return empty(`<div class="empty-icon">${icon("search", 40)}</div><h2>${t("No results")}</h2>
      <p>${filterCount() || state.search ? t("No family matches the search or the filters.") : t("No family matches.")}</p>
      ${filterCount() ? `<button data-filter="reset">${t("Reset the filters")}</button>` : ""}`);
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
    ? `${tn(families.length, "{n} family", "{n} families")}${filterCount() || state.search ? ` ${t("(filtered)")}` : ""} · ${t("free and open source")}`
    : "";
  const empty = (html: string) => {
    list.classList.add("is-empty");
    list.innerHTML = `<div class="empty">${html}</div>`;
  };
  if (!state.google) {
    if (state.googleError)
      return empty(`<div class="empty-icon">${icon("cloud", 44)}</div><h2>${t("Catalog unavailable")}</h2>
        <p>${esc(state.googleError)}</p><button class="primary" data-action="gf-retry">${t("Try again")}</button>`);
    return empty(`<div class="empty-icon">${icon("globe", 44)}</div><h2>${t("Loading the Google Fonts catalog…")}</h2>
      <p>${t("Over 1,800 open source families, to download and activate in one click.")}</p>`);
  }
  if (!families.length)
    return empty(`<div class="empty-icon">${icon("search", 40)}</div><h2>${t("No results")}</h2>
      <p>${t("No Google Fonts family matches the search or the filters.")}</p>
      ${filterCount() ? `<button data-gfilter="reset">${t("Reset the filters")}</button>` : ""}`);

  list.classList.remove("is-empty");
  const installed = installedNames();
  const shown = families.slice(0, state.googleLimit);
  const rest = families.length - shown.length;
  list.innerHTML =
    shown.map((g) => renderGoogleCard(g, isInstalled(g, installed))).join("") +
    (rest > 0 ? `<button class="more-button" data-action="gf-more">${t("Show more ({n} left)", { n: rest })}</button>` : "");
  list.querySelectorAll<HTMLElement>("[data-gfamily], [data-action='gf-more']").forEach((el) => previewObserver?.observe(el));
  if (!previewObserver) shown.forEach((g) => loadPreview(g));
}

function googleAction(g: GoogleFamily, installed: boolean, big = false): string {
  if (state.googleBusy.has(g.family)) return `<span class="gf-busy"><span class="spinner"></span>${t("Downloading…")}</span>`;
  if (installed)
    return `<button class="gf-installed" data-action="gf-show" title="${esc(t("Show in the library"))}">${icon("active", 13)}${t("In the library")}</button>`;
  return `<button class="gf-get${big ? " primary" : ""}" data-action="gf-install" title="${esc(t("Download every style and activate them"))}">${icon("cloud", 14)}${big ? t("Install and activate") : t("Install")}</button>`;
}

function renderGoogleCard(g: GoogleFamily, installed: boolean): string {
  return `<div class="font-card gf-card${state.selected === `g:${g.family}` ? " selected" : ""}" data-family="g:${esc(g.family)}" data-gfamily="${esc(g.family)}">
    <div class="card-head">
      <span class="card-name">${esc(g.family)}</span>
      <span class="card-meta">· ${tn(g.styles.length, "{n} style", "{n} styles")} · ${esc(categoryLabel(g))}</span>
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
  const rank = g.popularity < 4_000_000_000 ? t("No. {rank} of {total}", { rank: g.popularity, total: state.google?.families.length ?? "?" }) : null;
  const rows: [string, string | null][] = [
    [t("Category"), categoryLabel(g)],
    [t("Designers"), g.designers.join(", ") || null],
    [t("Styles"), String(g.styles.length)],
    [t("Variable axes"), g.axes.map((a) => `${a.tag} ${a.min}–${a.max}`).join(", ") || null],
    [t("Scripts"), g.subsets.join(", ") || null],
    [t("Published"), g.dateAdded ? new Date(g.dateAdded).toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" }) : null],
    [t("Popularity"), rank],
    [t("License"), t("Open source (Open Font License or Apache)")],
  ];
  pane.innerHTML = `
    <header class="detail-head">
      <div class="detail-top" data-tauri-drag-region>
        <div class="detail-name">
          <strong>${esc(g.family)}</strong>
          <span class="muted">Google Fonts</span>
        </div>
        <button class="tool" data-action="close" title="${esc(t("Close the details"))}" aria-label="${esc(t("Close the details"))}">${icon("close")}</button>
      </div>
      <div class="hero" style="font-family:${font}">Aa</div>
      <div class="status-line">
        ${googleAction(g, installed, true)}
        ${installed || state.googleBusy.has(g.family) ? "" : `<button data-action="gf-download" title="${esc(t("Add to the library without activating"))}">${t("Download only")}</button>`}
      </div>
    </header>
    <div class="detail-body">
      <div class="styles">
        ${g.styles
          .map((key) => {
            const s = parseStyle(key);
            return `<div class="style-row gf-style"><div class="muted small">${esc(styleLabel(key))} · ${s.weight}${s.italic ? ` · ${t("italic")}` : ""}</div>
              <div class="style-preview" style="font-family:${font};font-weight:${s.weight};font-style:${s.italic ? "italic" : "normal"};font-size:${state.previewSize}px">${text}</div></div>`;
          })
          .join("")}
      </div>
      <h3>${t("Specimen")}</h3>
      <p class="gf-specimen" style="font-family:${font}">${esc(specimen().paragraphs[0])}</p>
      <dl class="info">${rows
        .filter(([, v]) => v)
        .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`)
        .join("")}</dl>
      <p class="muted small">${t("The preview is served by Google. Once installed, the family joins your library (the “Google Fonts” folder) and works offline.")}</p>
    </div>`;
}

// ------------------------------------------------------------------ insights: duplicates & conflicts

const isInsights = () => state.sidebar === "insights";

let insightsRequest = 0;

async function loadInsights(refresh: boolean) {
  const request = ++insightsRequest;
  try {
    const found = await api.insights(refresh);
    if (request !== insightsRequest) return;
    state.insights = found;
    state.insightsError = null;
    // Forget ticked files that are no longer listed.
    const listed = new Set(found.groups.flatMap((g) => g.copies.map((c) => c.path)));
    state.insightsSelected = new Set([...state.insightsSelected].filter((p) => listed.has(p)));
  } catch (e) {
    if (request !== insightsRequest) return;
    state.insightsError = String(e);
  }
  renderSidebar();
  if (isInsights()) renderList();
}

const insightsGroups = () => (state.insights?.groups ?? []).filter((g) => state.insightsView !== "conflicts" || g.conflict);

const locationLabels = (): Record<DuplicateCopy["location"], string> => ({
  library: t("Library"),
  imported: t("Imported file"),
  user: t("User folder"),
  system: t("System"),
});

function renderInsights() {
  $("#filter-bar").hidden = true;
  previewObserver?.disconnect();
  const list = $("#family-list");
  list.classList.remove("rows");
  const data = state.insights;
  const view = state.insightsView;
  $("#list-title").textContent = view === "conflicts" ? t("Conflicts") : view === "duplicates" ? t("Duplicates") : t("Insights");
  const groups = insightsGroups();
  $("#list-subtitle").textContent = data && view !== "overview" ? tn(groups.length, "{n} font", "{n} fonts") : "";
  list.classList.toggle("is-empty", !data);
  if (!data) {
    list.innerHTML = state.insightsError
      ? `<div class="empty"><p>${esc(state.insightsError)}</p><button data-insights="retry">${t("Try again")}</button></div>`
      : `<div class="empty"><p>${t("Looking for duplicates…")}</p></div>`;
    return;
  }
  list.innerHTML = view === "overview" ? renderInsightsOverview(data) : renderInsightsDetail(groups);
}

function renderInsightsOverview(data: Insights): string {
  const conflicts = data.groups.filter((g) => g.conflict).length;
  const number = (n: number) => n.toLocaleString(dateLocale());
  const stat = (label: string, value: number, note = "") =>
    `<div class="stat"><span class="stat-label">${esc(label)}</span><span class="stat-value">${number(value)}</span><span class="stat-note">${esc(note)}</span></div>`;
  const card = (view: "conflicts" | "duplicates", label: string, value: number, note: string) =>
    `<button class="stat look ${view}" data-insights="open" data-view-name="${view}" ${value ? "" : "disabled"}>
       <span class="stat-label">${esc(label)}</span><span class="stat-value">${number(value)}</span><span class="stat-note">${esc(note)}</span>
     </button>`;
  return `<div class="stats">
      ${stat(t("Fonts"), data.faces)}
      ${stat(t("Active now"), data.activeFaces)}
      ${stat(t("Extra copies"), data.extraCopies, data.extraCopies ? t("about {size}", { size: sizeOf(data.extraBytes) }) : "")}
    </div>
    <h2 class="insights-heading">${t("Needs a look")}</h2>
    ${
      data.groups.length
        ? `<div class="stats">
            ${card("conflicts", t("Conflicts"), conflicts, t("fonts that apps may mix up"))}
            ${card("duplicates", t("Duplicates"), data.groups.length, t("fonts present in several files"))}
          </div>`
        : `<p class="muted">${t("No duplicates: every font comes from a single file.")}</p>`
    }`;
}

function renderInsightsDetail(groups: DuplicateGroup[]): string {
  const selected = selectionImpact(state.insights!.groups, state.insightsSelected).files;
  const locations = locationLabels();
  const row = (copy: DuplicateCopy) => {
    const folder = copy.path.slice(0, -fileName(copy.path).length - 1);
    const protectedHint = copy.trashable ? "" : t("Protected system folder: this file cannot be removed here.");
    return `<div class="copy-row" title="${esc(protectedHint)}">
      <input type="checkbox" data-path="${esc(copy.path)}" aria-label="${esc(copy.path)}" ${state.insightsSelected.has(copy.path) ? "checked" : ""} ${copy.trashable ? "" : "disabled"} />
      <span class="copy-dot${copy.active ? " on" : ""}" title="${esc(copy.active ? t("Active now") : t("Not active"))}"></span>
      <span class="copy-file">
        <span class="copy-name">${esc(fileName(copy.path))}</span>
        <button class="link copy-folder" data-insights="reveal" data-file="${esc(copy.path)}" title="${esc(t("Show in the folder"))}">${esc(folder)}</button>
        ${copy.otherFacesRedundant ? "" : `<span class="copy-warning">${t("Also holds fonts found in no other file")}</span>`}
      </span>
      <span class="copy-meta mono">${copy.version ? `v${versionNumber(copy.version).toFixed(3)}` : "-"}</span>
      <span class="copy-meta">${sizeOf(copy.fileSize)}</span>
      <span class="copy-meta">${dateOf(copy.modified)}</span>
      <span class="chip">${esc(locations[copy.location])}</span>
    </div>`;
  };
  const shown = groups.slice(0, state.insightsLimit);
  return `<div class="insights-bar">
      <button data-insights="back">‹ ${t("Insights")}</button>
      <span class="spacer"></span>
      <button data-insights="select">${t("Select")} ▾</button>
      <button class="danger" data-insights="trash" ${selected ? "" : "disabled"}>${t("Move to Trash")}${selected ? ` (${selected})` : ""}</button>
    </div>
    ${shown
      .map(
        (g) => `<section class="dup-group">
          <h3>${esc(g.family)} <span class="muted">${esc(g.style)}</span>${g.conflict ? ` <span class="chip conflict">${t("Conflict")}</span>` : ""}
            <span class="mono muted small">${esc(g.psName)}</span></h3>
          ${g.copies.map(row).join("")}
        </section>`,
      )
      .join("")}
    ${groups.length ? "" : `<p class="muted">${t("Nothing left to review here.")}</p>`}
    ${groups.length > shown.length ? `<button class="more-button" data-insights="more">${t("Show more")}</button>` : ""}`;
}

function selectMenu(): (MenuItem | "-")[] {
  const apply = (rule: SelectRule) => () => {
    state.insightsSelected = selectByRule(rule, insightsGroups(), state.insights!.groups, state.insightsSelected);
    renderList();
  };
  return [
    { label: t("Inactive copies"), action: apply("inactive") },
    { label: t("Files named like copies"), action: apply("namedCopy") },
    { label: t("Older versions"), action: apply("older") },
    { label: t("Smaller files"), action: apply("smaller") },
    "-",
    {
      label: t("Clear the selection"),
      action: () => {
        state.insightsSelected.clear();
        renderList();
      },
    },
  ];
}

async function trashSelected() {
  const impact = selectionImpact(state.insights!.groups, state.insightsSelected);
  if (!impact.files) return;
  const message = [
    tn(impact.files, "Move {n} file ({size}) to the Trash?", "Move {n} files ({size}) to the Trash?", { size: sizeOf(impact.bytes) }),
    impact.lost ? tn(impact.lost, "Warning: {n} font will have no copy left.", "Warning: {n} fonts will have no copy left.") : "",
    impact.exclusive
      ? tn(impact.exclusive, "Warning: {n} file also holds fonts found nowhere else.", "Warning: {n} files also hold fonts found nowhere else.")
      : "",
  ];
  const ok = await ask(message.filter(Boolean).join("\n\n"), {
    title: t("Move to Trash"),
    kind: "warning",
    okLabel: t("Move to Trash"),
    cancelLabel: t("Cancel"),
  });
  if (!ok) return;
  const paths = [...state.insightsSelected];
  state.insightsSelected.clear();
  await run(api.trashCopies(paths), tn(paths.length, "{n} file moved to the Trash", "{n} files moved to the Trash"));
  loadSystemFonts();
}

function insightsClick(target: HTMLElement) {
  const el = target.closest<HTMLElement>("[data-insights]");
  if (!el) return;
  const action = el.dataset.insights;
  if (action === "select") return menuBelow(el, selectMenu());
  if (action === "trash") return void trashSelected();
  if (action === "reveal") return void revealItemInDir(el.dataset.file!).catch((e) => toast(String(e), true));
  if (action === "retry") {
    state.insightsError = null;
    loadInsights(true);
  } else if (action === "more") state.insightsLimit += INSIGHTS_PAGE;
  else if (action === "back" || action === "open") {
    state.insightsView = action === "back" ? "overview" : (el.dataset.viewName as "conflicts" | "duplicates");
    state.insightsSelected.clear();
    state.insightsLimit = INSIGHTS_PAGE;
    $("#family-list").scrollTop = 0;
  }
  renderList();
}

function statusControl(fam: Family, act = activation(fam)) {
  return act === "system"
    ? `<span class="lock" title="${esc(activationLabels().system)}">${icon("lock", 13)}</span>`
    : `<button class="switch${act !== "inactive" ? " on" : ""} ${act}" data-action="toggle" role="switch" aria-checked="${act !== "inactive"}" title="${esc(activationLabels()[act])}"><span></span></button>`;
}

function starButton(fam: Family) {
  return `<button class="star${fam.starred ? " on" : ""}" data-action="star" title="${esc(fam.starred ? t("Remove from favorites") : t("Add to favorites"))}">${fam.starred ? "★" : "☆"}</button>`;
}

function renderCard(fam: Family): string {
  const act = activation(fam);
  return `<div class="font-card${fam.key === state.selected ? " selected" : ""}" data-family="${esc(fam.key)}" draggable="true">
    <div class="card-head">
      <span class="dot ${act}" title="${esc(activationLabels()[act])}"></span>
      <span class="card-name">${esc(fam.name)}</span>
      <span class="card-meta">· ${tn(fam.faces.length, "{n} style", "{n} styles")}</span>
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
    <span>${t("Preview")}</span>
    <button type="button" data-sort="name">${t("Name")}${arrow("name", "name-desc")}</button>
    <span class="t-center">★</span>
    <span>${t("Format")}</span>
    <button type="button" data-sort="recent">${t("Added")}${arrow("recent")}</button>
    <span></span>
  </div>`;
  const rows = families.map((fam) => {
    const act = activation(fam);
    const open = state.expanded.has(fam.key);
    const many = fam.faces.length > 1;
    const row = `<div class="t-row${fam.key === state.selected ? " selected" : ""}" data-family="${esc(fam.key)}" draggable="true">
      <span>${many ? `<button class="chevron${open ? " open" : ""}" data-action="expand" aria-label="${esc(t("Show the styles"))}">${icon("chevron", 14)}</button>` : ""}</span>
      <span class="dot ${act}" title="${esc(activationLabels()[act])}"></span>
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
        <span class="t-name">${esc(f.style)} <span class="muted">· ${f.weight}${f.italic ? ` · ${t("italic")}` : ""}</span></span>
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
  if (isInsights()) {
    pane.hidden = true;
    pane.innerHTML = "";
    return;
  }
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
    ["specimen", t("Specimen")],
    ["styles", t("Styles")],
    ["glyphs", t("Glyphs")],
    ["languages", t("Languages")],
    ["features", "OpenType"],
  ];
  if (fam.variable) tabs.push(["axes", t("Variable")]);
  tabs.push(["info", t("Info")]);

  const scopeButton = (scope: Scope, label: string, on: boolean) =>
    `<button data-scope="${scope}" class="${on ? "on" : ""}">${label}</button>`;

  pane.innerHTML = `
    <header class="detail-head">
      <div class="detail-top" data-tauri-drag-region>
        <div class="detail-name">
          <strong>${esc(fam.name)}</strong>
          ${
            fam.faces.length > 1
              ? `<select id="face-select" title="${esc(t("Displayed style"))}">${fam.faces
                  .map((f) => `<option value="${esc(f.id)}"${f.id === face.id ? " selected" : ""}>${esc(f.style)}</option>`)
                  .join("")}</select>`
              : `<span class="muted">${esc(face.style)}</span>`
          }
        </div>
        <button class="tool" data-action="more" title="${esc(t("More actions"))}" aria-label="${esc(t("More actions"))}">${icon("more")}</button>
        <button class="tool" data-action="close" title="${esc(t("Close the details"))}" aria-label="${esc(t("Close the details"))}">${icon("close")}</button>
      </div>
      <div class="hero" style="font-family:${cssFont(face)}">Aa</div>
      <div class="status-line">
        ${
          act === "system"
            ? `<span class="dot system"></span><span>${activationLabels().system}</span>`
            : `<div class="segmented" title="${esc(activationLabels()[act])}">
                ${scopeButton("none", t("Off"), act === "inactive")}
                ${scopeButton("temporary", t("Session"), act === "temporary")}
                ${scopeButton("persistent", t("On"), act === "persistent")}
              </div>`
        }
        <span class="spacer"></span>
        <button class="star${fam.starred ? " on" : ""}" data-action="star" title="${esc(fam.starred ? t("Remove from favorites") : t("Add to favorites"))}">${fam.starred ? "★" : "☆"}</button>
      </div>
      <div class="detail-tags">
        ${tagsOf(fam).map(tagChip).join("")}
        <button class="chip-add" data-action="tags">＋ ${t("Tag")}</button>
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

const loading = () => `<p class="muted">${t("Reading the font…")}</p>`;

function emptyNote(glyph: string, title: string, text: string) {
  return `<div class="empty small-empty"><div class="empty-glyph">${glyph}</div><h2>${title}</h2><p>${text}</p></div>`;
}

function renderTab(fam: Family, face: Face): string {
  const text = esc(state.previewText || fam.name);
  const details = state.details.get(face.id);
  const font = cssFont(face);

  switch (state.tab) {
    case "specimen": {
      const [p1, p2, p3] = specimen().paragraphs.map(esc);
      return `<div class="specimen" style="font-family:${font}">
        <div class="sp-title">${esc(state.previewText || specimen().title)}</div>
        <div class="sp-alpha">${esc(specimen().alphabet)}</div>
        <div class="sp-label">24 pt</div><p class="sp-24">${p1}</p>
        <div class="sp-label">16 pt</div><p class="sp-16">${p2}</p>
        <div class="sp-label">12 pt</div><p class="sp-12">${p3}</p>
        <div class="sp-label">${t("Figures")}</div><p class="sp-16">${esc(specimen().figures)}</p>
        <div class="sp-label sp-row">${t("On a background")}
          <span class="sp-swatches">${["blue", "red", "green", "purple", "orange", "gray"]
            .map(
              (c) =>
                `<button type="button" class="swatch mini${c === state.tileColor ? " on" : ""}" data-tile-color="${c}" style="background:${TAG_COLORS[c]}" title="${c}"></button>`,
            )
            .join("")}</span>
        </div>
        <div class="sp-tiles">
          <div class="sp-tile paper"><div class="sp-tile-title">${esc(specimen().title)}</div><p>${p1}</p></div>
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
                <div class="muted small">${esc(f.style)} · ${f.weight}${f.italic ? ` · ${t("italic")}` : ""}</div>
                <div class="style-preview" style="font-family:${cssFont(f)};font-size:${state.previewSize}px">${text}</div>
              </div>`,
            )
            .join("")}
        </div>
        <h3>${t("Waterfall · {style}", { style: face.style })}</h3>
        <div class="waterfall" style="font-family:${font}">
          ${sizes.map((s) => `<div><span class="muted mono small">${s}</span><span style="font-size:${s}px">${text}</span></div>`).join("")}
        </div>`;
    }

    case "glyphs": {
      if (!details) return loading();
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
            <input id="glyph-search" type="search" placeholder="${esc(t("Character or code (U+00E9)"))}" value="${esc(state.glyphSearch)}" spellcheck="false" />
          </label>
          <div class="chip-row">${GLYPH_GROUPS.filter(([k, , t]) => k === "all" || details.characters.some(t))
            .map(([k, l]) => `<button type="button" class="filter-chip${state.glyphGroup === k ? " on" : ""}" data-glyph-group="${k}">${esc(t(l))}</button>`)
            .join("")}</div>
        </div>
        ${
          cp !== undefined
            ? `<div class="char-hero" style="font-family:${font}">
          <div class="char-big">${esc(String.fromCodePoint(cp))}</div>
          <div class="char-meta">
            <div class="mono">U+${hex(cp)}</div>
            <div class="muted small">${t("{shown} of {total} characters · {glyphs} glyphs", { shown: shown.length, total: `${details.characters.length}${details.charactersTruncated ? "+" : ""}`, glyphs: face.glyphCount })}</div>
            <button data-action="copy-char" data-cp="${cp}">${t("Copy")}</button>
          </div>
        </div>`
            : ""
        }
        <div class="char-grid" style="font-family:${font}">
          ${shown
            .map(
              (c) =>
                `<button class="char${c === cp ? " on" : ""}" data-cp="${c}" title="${esc(t("U+{hex}, double-click to copy", { hex: hex(c) }))}"><span>${esc(String.fromCodePoint(c))}</span><small>${hex(c)}</small></button>`,
            )
            .join("")}
        </div>
        ${shown.length ? "" : `<p class="muted">${t("No characters match.")}</p>`}`;
    }

    case "languages": {
      const support = state.languages.get(face.id);
      if (!support) return loading();
      const yes = support.filter(Boolean).length;
      const rows = LANGUAGES.map((l, i) => ({ ...l, ok: support[i] })).filter(
        (l) => state.languageFilter === "all" || (state.languageFilter === "yes") === l.ok,
      );
      const seg = (v: string, label: string, n: number) =>
        `<button type="button" data-language-filter="${v}" class="${state.languageFilter === v ? "on" : ""}">${label} <span class="count">${n}</span></button>`;
      return `<div class="segmented small-seg lang-seg">
          ${seg("all", t("All"), LANGUAGES.length)}${seg("yes", t("Supported"), yes)}${seg("no", t("Missing"), LANGUAGES.length - yes)}
        </div>
        <div class="languages">
          ${rows
            .map(
              (l) => `<div class="lang${l.ok ? "" : " missing"}">
                <div class="lang-name">${esc(t(l.name))}${l.ok ? "" : ` <span class="miss">${t("missing characters")}</span>`}</div>
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
        [t("Family"), face.family],
        [t("Style"), face.style],
        [t("Full name"), face.fullName],
        ["PostScript", face.psName],
        [t("Classification"), classLabels()[face.classification]],
        [t("Format"), details?.format ?? formatOf(face.path)],
        [t("Size"), details ? sizeOf(details.fileSize) : null],
        [t("Weight"), face.weight],
        [t("Italic"), face.italic ? t("Yes") : t("No")],
        [t("Monospaced"), face.mono ? t("Yes") : t("No")],
        [t("Glyphs"), face.glyphCount],
        [t("Version"), face.version],
        [t("Designer"), face.designer],
        [t("Foundry"), face.manufacturer],
        [t("License"), face.license],
        ["Copyright", face.copyright],
        [fam.system ? t("File date") : t("Added on"), dateOf(face.addedAt)],
      ];
      return `<dl class="info">
        ${rows
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`)
          .join("")}
          <dt>${t("File")}</dt><dd><div class="file-row"><div>${esc(file)}<div class="muted small">${esc(folder)}</div></div>
            <button class="tool" data-action="reveal" data-path="${esc(face.path)}" title="${esc(t("Show in folder"))}">${icon("folder")}</button></div></dd>
        </dl>`;
    }

    case "features": {
      if (!details) return loading();
      if (!details.features.length)
        return emptyNote(`<span style="font-family:${font}">fi</span>`, t("No OpenType features"), esc(t("{name} declares none.", { name: fam.name })));
      const settingsCSS = [...state.features.entries()].map(([t, on]) => `'${cssTag(t)}' ${on ? 1 : 0}`).join(", ");
      return `
        <div class="feature-preview" style="font-family:${font};font-size:${Math.max(state.previewSize, 28)}px;font-feature-settings:${settingsCSS || "normal"}" contenteditable="plaintext-only" spellcheck="false">${text} 0123456789 1/2 fi fl</div>
        <div class="muted small">${t("{count}. Click to turn it on or off in the preview", { count: tn(details.features.length, "{n} feature", "{n} features") })}</div>
        <div class="features">
          ${details.features
            .map((tag) => {
              const on = state.features.get(tag) ?? DEFAULT_ON.has(tag);
              const label = featureLabel(tag);
              return `<div class="feature"><button type="button" class="switch${on ? " on" : ""}" data-feature="${esc(tag)}" role="switch" aria-checked="${on}" aria-label="${esc(label)}"><span></span></button>
                <span>${esc(label)}</span><span class="mono muted">${esc(tag)}</span></div>`;
            })
            .join("")}
        </div>`;
    }

    case "axes": {
      if (!details) return loading();
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
          <button data-action="reset-axes">${t("Default values")}</button>
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
      { label: t("Activate"), action: () => setScope(families, "persistent") },
      { label: t("Activate temporarily"), action: () => setScope(families, "temporary") },
      { label: t("Deactivate"), action: () => setScope(families, "none") },
      "-",
    );
  }
  items.push(
    { label: first.starred ? t("Remove from favorites") : t("Add to favorites"), action: () => setStarred(first, !first.starred) },
    "-",
    { label: t("Add to a collection"), header: true },
    ...(state.lib?.collections ?? []).map((c) => ({
      label: `  ${c.name}`,
      action: () => libraryAction(families, () => api.addToCollection(c.id, names), t("Added to “{name}”", { name: c.name })),
    })),
    { label: `  ${t("New collection…")}`, action: () => newCollection(families) },
    "-",
    ...tagItems(families),
  );
  if (state.sidebar.startsWith("col:")) {
    const id = state.sidebar.slice(4);
    items.push({ label: t("Remove from this collection"), action: () => run(api.removeFromCollection(id, names)) });
  }
  items.push("-");
  if (first.system) items.push({ label: t("Copy the file into the library"), action: () => copyToLibrary(families) });
  items.push({ label: t("Show in folder"), action: () => revealItemInDir(first.rep.path).catch((e) => toast(String(e), true)) });
  if (first.inLibrary) {
    items.push(
      first.system
        ? { label: t("Forget favorite, tags and collections…"), danger: true, action: () => removeFamilies(families) }
        : { label: t("Remove from library…"), danger: true, action: () => removeFamilies(families) },
    );
  }
  return items;
}

/** Toggle entries for manual tags (smart tags fill themselves). */
function tagItems(families: Family[]): (MenuItem | "-")[] {
  const names = families.map((f) => f.name);
  const manual = (state.lib?.tags ?? []).filter((t) => t.rule === null);
  return [
    { label: t("Tags"), header: true },
    ...manual.map((t) => {
      const on = families.every((f) => hasTag(f, t.id));
      return { label: `${on ? "✓" : "  "} ${t.name}`, action: () => libraryAction(families, () => api.setTagged(t.id, names, !on)) };
    }),
    { label: `  ${t("New tag…")}`, action: () => newTag(false, families) },
  ];
}

function tagMenu(id: string): (MenuItem | "-")[] {
  const tag = state.lib?.tags.find((t) => t.id === id);
  if (!tag) return [];
  return [
    { label: t("Activate the tag's fonts"), action: () => setScope(familiesWithTag(id), "persistent") },
    { label: t("Activate temporarily"), action: () => setScope(familiesWithTag(id), "temporary") },
    { label: t("Deactivate the tag's fonts"), action: () => setScope(familiesWithTag(id), "none") },
    "-",
    { label: tag.rule !== null ? t("Edit the rules…") : t("Edit…"), action: () => editExistingTag(tag) },
    {
      label: t("Delete the tag…"),
      danger: true,
      action: async () => {
        const ok = await ask(t("Delete the tag “{name}”? The fonts are not deleted.", { name: tag.name }), {
          title: t("Delete the tag"),
          kind: "warning",
          okLabel: t("Delete"),
          cancelLabel: t("Cancel"),
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
    { label: t("Activate the collection"), action: () => setScope(familiesInCollection(id), "persistent") },
    { label: t("Activate temporarily"), action: () => setScope(familiesInCollection(id), "temporary") },
    { label: t("Deactivate the collection"), action: () => setScope(familiesInCollection(id), "none") },
    "-",
    {
      label: t("Rename…"),
      action: async () => {
        const name = await promptText(t("Rename the collection"), collection.name);
        if (name) run(api.renameCollection(id, name));
      },
    },
    { label: t("Delete the collection"), danger: true, action: () => run(api.deleteCollection(id)) },
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
  else if (name === "weight" || name === "width") {
    // A preset clicked again goes back to the whole scale.
    const preset = rangePresets[name][value];
    f[name] = sameRange(f[name], preset) ? [...(name === "weight" ? WEIGHT_SCALE : WIDTH_SCALE)] : [...preset];
  } else if (name === "feature") f.features.has(value) ? f.features.delete(value) : f.features.add(value);
  else if (name === "allFeatures") state.allFeatures = !state.allFeatures;
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
        { label: t("New tag…"), action: () => newTag(false) },
        { label: t("New smart tag…"), action: () => newTag(true) },
      ]);
    const nav = target.closest<HTMLElement>("[data-nav]");
    if (nav) {
      state.sidebar = nav.dataset.nav!;
      if (isInsights()) {
        state.insightsView = "overview";
        state.insightsSelected.clear();
        loadInsights(true);
      }
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
      return void libraryAction([fam], () => api.setTagged(el.dataset.tag!, [fam.name], true), t("Tag “{name}” added", { name: tag?.name ?? "" }));
    }
    const collection = state.lib?.collections.find((c) => c.id === el.dataset.collection);
    libraryAction([fam], () => api.addToCollection(el.dataset.collection!, [fam.name]), t("Added to “{name}”", { name: collection?.name ?? "" }));
  });

  const list = $("#family-list");
  list.addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (!box.dataset.path) return;
    box.checked ? state.insightsSelected.add(box.dataset.path) : state.insightsSelected.delete(box.dataset.path);
    const scroll = list.scrollTop;
    renderList();
    list.scrollTop = scroll;
  });
  list.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (isInsights()) return insightsClick(target);
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
    if (isInsights()) return;
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
  $("#filter-bar").addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.dataset.range) applyRange(input);
  });
  $("#filter-bar").addEventListener("change", (e) => {
    const { range, end } = (e.target as HTMLInputElement).dataset;
    if (!range) return;
    renderList();
    $(`#filter-bar [data-range="${range}"][data-end="${end}"]`).focus(); // keep the arrow keys working
  });
  $("#filter-button").addEventListener("click", () => {
    state.showFilters = !state.showFilters;
    renderList();
  });
  $("#sort-button").addEventListener("click", (e) =>
    menuBelow(
      e.currentTarget as HTMLElement,
      isGoogle()
        ? (Object.entries(googleSortLabels()) as [GoogleSort, string][]).map(([key, label]) => ({
            label: `${state.googleSort === key ? "✓" : "  "} ${label}`,
            action: () => {
              state.googleSort = key;
              renderList();
            },
          }))
        : (Object.entries(sortLabels()) as [Sort, string][]).map(([key, label]) => ({
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
      { label: t("Font files…"), action: () => importDialog() },
      { label: t("Folder…"), action: () => importDialog(true) },
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
    // The pane needs something to show: with no selection, open the first family.
    if (settings.inspector && !state.selected) {
      const first = visibleFamilies()[0];
      if (first) return selectFamily(first.key);
    }
    renderDetail();
  });

  // Resizable sidebar and detail pane, remembered between launches.
  const appEl = document.querySelector<HTMLElement>(".app")!;
  const bounds = { sidebar: [180, 420], detail: [320, 900] } as const;
  const setWidth = (which: "sidebar" | "detail", px: number) => {
    const [lo, hi] = bounds[which];
    const max = which === "detail" ? Math.min(hi, window.innerWidth - 236 - 300) : hi;
    const w = Math.round(Math.max(lo, Math.min(max, px)));
    appEl.style.setProperty(`--${which}-w`, `${w}px`);
    return w;
  };
  for (const which of ["sidebar", "detail"] as const) {
    const saved = Number(stored(`${which}Width`, ""));
    if (saved) setWidth(which, saved);
    const handle = $(`#resize-${which}`);
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      document.body.classList.add("resizing");
      let width = 0;
      const move = (ev: PointerEvent) => {
        width = setWidth(which, which === "sidebar" ? ev.clientX : window.innerWidth - ev.clientX);
      };
      const up = () => {
        handle.classList.remove("dragging");
        document.body.classList.remove("resizing");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        if (width) store(`${which}Width`, String(width));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", () => {
      appEl.style.removeProperty(`--${which}-w`);
      store(`${which}Width`, "");
    });
  }

  const settingsDialog = $<HTMLDialogElement>("#settings-dialog");
  const showSettingsTab = (tab: string) => {
    settingsDialog.querySelectorAll<HTMLElement>("[data-settings-tab]").forEach((b) => {
      b.classList.toggle("on", b.dataset.settingsTab === tab);
      if (b.dataset.settingsTab === tab) $("#settings-title").textContent = b.textContent!.trim();
    });
    settingsDialog.querySelectorAll<HTMLElement>("[data-settings-page]").forEach((page) => (page.hidden = page.dataset.settingsPage !== tab));
  };
  const syncSettings = () => {
    $<HTMLSelectElement>("#setting-language").value = settings.language;
    $<HTMLInputElement>("#setting-copy").checked = settings.copyOnImport;
    $<HTMLInputElement>("#setting-inspector").checked = settings.inspector;
    $("#library-path").textContent = state.lib?.fontsDir ?? "";
    $<HTMLInputElement>("#setting-google").checked = settings.google;
    $<HTMLInputElement>("#setting-google-cjk").checked = settings.googleCjk;
    $<HTMLInputElement>("#setting-plugins").checked = settings.plugins;
    $<HTMLInputElement>("#setting-plugins-google").checked = settings.pluginsGoogle;
    $<HTMLInputElement>("#setting-plugins-google").disabled = !settings.plugins;
    api.pluginApiStatus().then(showPluginStatus, () => showPluginStatus(null));
    renderPluginList();
    pluginMessage("");
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
  $<HTMLSelectElement>("#setting-language").addEventListener("change", (e) => {
    settings.language = (e.target as HTMLSelectElement).value as Language;
    applyLanguage();
    syncSettings();
    showSettingsTab(settingsDialog.querySelector<HTMLElement>("[data-settings-tab].on")?.dataset.settingsTab ?? "general");
    syncGoogleStatus();
    render();
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
  $("#plugin-list").addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (button?.dataset.pluginInstall) installPlugin(button.dataset.pluginInstall, button);
    else if (button?.dataset.pluginRemove) removePlugin(button.dataset.pluginRemove, button);
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
    if (!target.closest("#menu, #import-button, #sort-button, #new-tag, [data-action='more'], [data-action='tags'], [data-insights='select']")) hideMenu();
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
    () => toast(t("Character copied")),
    () => toast(t("Copy failed"), true),
  );
}

async function importDialog(directory = false) {
  const picked = await open({
    multiple: true,
    directory,
    title: directory ? t("Import a folder of fonts") : t("Import fonts"),
    filters: directory ? undefined : [{ name: t("Fonts"), extensions: ["ttf", "otf", "ttc", "otc"] }],
  });
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
  importPaths(paths);
}

async function start() {
  // `npm run dev` opened in a plain browser: use demo data instead of the Rust backend.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) await import("./dev/mock");
  applyTheme();
  applyLanguage();
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
