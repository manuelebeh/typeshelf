import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type Scope = "none" | "temporary" | "persistent";

export interface Face {
  id: string;
  path: string;
  faceIndex: number;
  psName: string;
  family: string;
  style: string;
  fullName: string;
  weight: number;
  /** usWidthClass, 1 to 9. */
  width: number;
  italic: boolean;
  mono: boolean;
  classification: string;
  version: string | null;
  designer: string | null;
  manufacturer: string | null;
  license: string | null;
  copyright: string | null;
  glyphCount: number;
  variable: boolean;
  /** GSUB and GPOS feature tags. */
  features: string[];
  starred: boolean;
  addedAt: number;
  /** The file can be found on this computer. */
  available: boolean;
  /** The other computer that imported a file kept outside the library. */
  importedOn: string | null;
  /** Interface only: the installed copy shown in place of a library file that is not here. */
  previewId?: string;
}

export interface Collection {
  id: string;
  name: string;
  createdAt: number;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  /** JSON rule for smart tags, null for manual tags. */
  rule: string | null;
  createdAt: number;
}

export interface SmartSet {
  id: string;
  name: string;
  /** JSON of the saved scope, search and filters (see filters.ts). */
  query: string;
  createdAt: number;
}

export interface LibraryInfo {
  id: string;
  name: string;
  /** The package folder. */
  path: string;
  current: boolean;
  /** The folder can be reached. */
  connected: boolean;
}

export interface OpenOutcome {
  /** Set when nothing was opened: the folder is a copy of the library at this path. */
  duplicateOf: string | null;
}

export interface Library {
  id: string;
  name: string;
  /** The package folder. */
  root: string;
  readOnly: boolean;
  /** The folder can be reached. Otherwise this is what was last seen. */
  connected: boolean;
  /** Part of the library has not arrived on this computer yet. */
  waiting: boolean;
  /** This computer chose to only read it. */
  viewOnlyChoice: boolean;
  /** The sync service sharing the folder, `"drive"` for an external or network drive, or null. */
  sharedBy: string | null;
  /** The latest change made on another computer. */
  lastChange: { device: string; at: number } | null;
  faces: Face[];
  collections: Collection[];
  membership: Record<string, string[]>;
  tags: Tag[];
  tagMembership: Record<string, string[]>;
  smartSets: SmartSet[];
  activation: Record<string, Scope>;
  fontsDir: string;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  failures: string[];
}

export interface Axis {
  tag: string;
  name: string;
  min: number;
  default: number;
  max: number;
}

export interface FaceDetails {
  characters: number[];
  charactersTruncated: boolean;
  features: string[];
  axes: Axis[];
  format: string;
  fileSize: number;
}

export interface DuplicateCopy {
  path: string;
  faceIndex: number;
  version: string | null;
  fileSize: number;
  modified: number;
  location: "library" | "imported" | "user" | "system";
  active: boolean;
  scope: Scope;
  trashable: boolean;
  facesInFile: number;
  /** Every font of the file also exists in another file. */
  otherFacesRedundant: boolean;
}

export interface DuplicateGroup {
  psName: string;
  family: string;
  style: string;
  copies: DuplicateCopy[];
  conflict: boolean;
}

export interface Insights {
  faces: number;
  activeFaces: number;
  groups: DuplicateGroup[];
  extraCopies: number;
  extraBytes: number;
}

export interface GoogleFamily {
  family: string;
  category: string;
  styles: string[];
  axes: { tag: string; min: number; max: number }[];
  designers: string[];
  subsets: string[];
  popularity: number;
  dateAdded: string;
  cjk: boolean;
}

export interface GoogleCatalog {
  fetchedAt: number;
  families: GoogleFamily[];
}

export interface PluginApiStatus {
  port: number;
  enabled: boolean;
  listening: boolean;
  error: string | null;
}

export interface PluginInstallState {
  id: string;
  name: string;
  state: "installed" | "outdated" | "absent";
  appFound: boolean;
  appRunning: boolean;
}

export interface PluginInstallOutcome {
  plugin: PluginInstallState;
  restart: boolean;
  /** Where the plugin was copied (Figma imports it from there). */
  path: string;
  debugMode: boolean;
}

export interface PluginActivity {
  client: string;
  activated: string[];
  missing: string[];
}

/** A design application whose Typeshelf plugin is running. */
export interface ConnectedApp {
  name: string;
  document: string | null;
  can: ("apply" | "selection")[];
}

/** The text selected in a design application, with the style of its first character. */
export interface DesignSelection {
  text: string;
  /** PostScript name. */
  font: string | null;
  size: number | null;
  /** `#rrggbb`. */
  color: string | null;
  /** Thousandths of an em. */
  tracking: number | null;
  count: number;
}

/** What a plugin answered, or a selection it sent on its own (`id` is then null). */
export interface BridgeResult {
  client: string;
  id: number | null;
  kind: "apply" | "selection";
  ok: boolean;
  error: string | null;
  count: number;
  selection: DesignSelection | null;
}

export const api = {
  insights: (refresh: boolean) => invoke<Insights>("insights", { refresh }),
  trashCopies: (paths: string[]) => invoke<string[]>("trash_copies", { paths }),
  loadLibrary: () => invoke<Library>("load_library"),
  listLibraries: () => invoke<LibraryInfo[]>("list_libraries"),
  createLibrary: (path: string) => invoke<void>("create_library", { path }),
  openLibrary: (path: string, asCopy: boolean) => invoke<OpenOutcome>("open_library", { path, asCopy }),
  switchLibrary: (id: string) => invoke<void>("switch_library", { id }),
  moveLibrary: (id: string, parent: string) => invoke<void>("move_library", { id, parent }),
  forgetLibrary: (id: string) => invoke<void>("forget_library", { id }),
  setViewOnly: (id: string, enabled: boolean) => invoke<void>("set_view_only", { id, enabled }),
  syncLibrary: () => invoke<boolean>("sync_library"),
  takePendingOpen: () => invoke<string[]>("take_pending_open"),
  deactivateAll: () => invoke<string[]>("deactivate_all"),
  systemFonts: () => invoke<Face[]>("system_fonts"),
  importPaths: (paths: string[], copy: boolean) => invoke<ImportSummary>("import_paths", { paths, copy }),
  removeFamilies: (families: string[]) => invoke<string[]>("remove_families", { families }),
  setActivation: (paths: string[], scope: Scope) => invoke<string[]>("set_activation", { paths, scope }),
  setStarred: (family: string, starred: boolean) => invoke<void>("set_starred", { family, starred }),
  createCollection: (name: string) => invoke<string>("create_collection", { name }),
  renameCollection: (id: string, name: string) => invoke<void>("rename_collection", { id, name }),
  deleteCollection: (id: string) => invoke<void>("delete_collection", { id }),
  addToCollection: (id: string, families: string[]) => invoke<void>("add_to_collection", { id, families }),
  removeFromCollection: (id: string, families: string[]) =>
    invoke<void>("remove_from_collection", { id, families }),
  createTag: (name: string, color: string, rule: string | null) => invoke<string>("create_tag", { name, color, rule }),
  updateTag: (id: string, name: string, color: string, rule: string | null) =>
    invoke<void>("update_tag", { id, name, color, rule }),
  deleteTag: (id: string) => invoke<void>("delete_tag", { id }),
  setTagged: (id: string, families: string[], tagged: boolean) => invoke<void>("set_tagged", { id, families, tagged }),
  createSmartSet: (name: string, query: string) => invoke<string>("create_smart_set", { name, query }),
  updateSmartSet: (id: string, name: string, query: string) => invoke<void>("update_smart_set", { id, name, query }),
  deleteSmartSet: (id: string) => invoke<void>("delete_smart_set", { id }),
  faceDetails: (id: string) => invoke<FaceDetails>("face_details", { id }),
  googleCatalog: (refresh: boolean) => invoke<GoogleCatalog>("google_catalog", { refresh }),
  googleDownload: (family: string) =>
    invoke<{ summary: ImportSummary; paths: string[] }>("google_download", { family }),
  pluginApiStatus: () => invoke<PluginApiStatus>("plugin_api_status"),
  pluginApiConfig: (enabled: boolean, google: boolean) => invoke<PluginApiStatus>("plugin_api_config", { enabled, google }),
  pluginsList: () => invoke<PluginInstallState[]>("plugins_list"),
  pluginInstall: (id: string) => invoke<PluginInstallOutcome>("plugin_install", { id }),
  pluginUninstall: (id: string) => invoke<PluginInstallState>("plugin_uninstall", { id }),
  bridgeApps: () => invoke<ConnectedApp[]>("bridge_apps"),
  bridgeApply: (client: string, psName: string) => invoke<number>("bridge_apply", { client, psName }),
  bridgeRequestSelection: (client: string) => invoke<number>("bridge_request_selection", { client }),
  languageSupport: (id: string, samples: string[]) => invoke<boolean[]>("language_support", { id, samples }),
};

/** URL served by the Rust `tsfont` protocol for one face of the open library or of the system. */
export const fontURL = (libraryId: string, faceId: string) => convertFileSrc(`${libraryId}~${faceId}`, "tsfont");
