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
  starred: boolean;
  addedAt: number;
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

export interface Library {
  faces: Face[];
  collections: Collection[];
  membership: Record<string, string[]>;
  tags: Tag[];
  tagMembership: Record<string, string[]>;
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
  debugMode: boolean;
}

export interface PluginActivity {
  client: string;
  activated: string[];
  missing: string[];
}

export const api = {
  loadLibrary: () => invoke<Library>("load_library"),
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
  faceDetails: (id: string) => invoke<FaceDetails>("face_details", { id }),
  googleCatalog: (refresh: boolean) => invoke<GoogleCatalog>("google_catalog", { refresh }),
  googleDownload: (family: string) =>
    invoke<{ summary: ImportSummary; paths: string[] }>("google_download", { family }),
  pluginApiStatus: () => invoke<PluginApiStatus>("plugin_api_status"),
  pluginApiConfig: (enabled: boolean, google: boolean) => invoke<PluginApiStatus>("plugin_api_config", { enabled, google }),
  pluginsList: () => invoke<PluginInstallState[]>("plugins_list"),
  pluginInstall: (id: string) => invoke<PluginInstallOutcome>("plugin_install", { id }),
  pluginUninstall: (id: string) => invoke<PluginInstallState>("plugin_uninstall", { id }),
  languageSupport: (id: string, samples: string[]) => invoke<boolean[]>("language_support", { id, samples }),
};

/** URL served by the Rust `tsfont` protocol for one face. */
export const fontURL = (faceId: string) => convertFileSrc(faceId, "tsfont");
