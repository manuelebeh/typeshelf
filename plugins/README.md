# Typeshelf plugins

Panels that, when a document opens, list the fonts it uses and ask Typeshelf to activate the
missing ones: from the library, or downloaded from Google Fonts when the family exists there.
Typeshelf must be running.

The panels follow the system language (English, or French on a French system).

| Folder           | Application                       | Technology                    |
| ---------------- | --------------------------------- | ----------------------------- |
| `photoshop/`     | Photoshop 2023 (24.2) and later   | UXP (manifest v5)             |
| `illustrator/`   | Illustrator 2021 (25) and later   | CEP + ExtendScript            |
| `after-effects/` | After Effects 2024 (24) and later | CEP + ExtendScript            |
| `indesign/`      | InDesign 2019 (14) and later      | CEP + ExtendScript            |
| `sketch/`        | Sketch (tried in 2026.1)          | Sketch plugin (JavaScript)    |
| `figma/`         | Figma desktop app                 | Figma plugin (sandbox + panel)|
| `shared/`        | Common panel (`panel-core.js`, `panel.css`), CEP plumbing (`cep.js`), the Figma panel's adapter and build script, and a preview page | - |

`panel-core.js` and `panel.css` (and `cep.js` for the CEP plugins) are copied into each folder, because
every plugin must be self-contained: after changing `shared/`, run `npm run plugins:sync`. It also
rebuilds `figma/ui.html`, which inlines the panel (Figma loads one HTML file).
`npm run dev`, then open `/plugins/shared/preview.html` to see the panel with sample data.

## Installing from Typeshelf

**Settings ▸ Plugins** lists the plugins bundled with the app, with an *Install*, *Install update* or
*Remove* button for each one (macOS and Windows; Sketch is macOS only):

| Plugin | Copied to (`~/Library/Application Support/` on macOS, `%APPDATA%\` on Windows) |
| --- | --- |
| Photoshop | `Adobe/UXP/Plugins/External/dev.typeshelf.photoshop`, registered in `Adobe/UXP/PluginsInfo/v1/PS.json` |
| Illustrator | `Adobe/CEP/extensions/dev.typeshelf.illustrator` |
| After Effects | `Adobe/CEP/extensions/dev.typeshelf.aftereffects` |
| InDesign | `Adobe/CEP/extensions/dev.typeshelf.indesign` |
| Sketch | `com.bohemiancoding.sketch3/Plugins/Typeshelf.sketchplugin` |
| Figma | `figma-plugin` in Typeshelf's data folder (macOS: `~/Library/Application Support/dev.typeshelf.app`) |

- Photoshop must be closed while its plugin is installed or removed, because it rewrites `PS.json`
  when it quits. Other entries of `PS.json` are kept as they are.
- Figma has no folder to drop a plugin into. Installing copies it, then you import it once: **Plugins ▸
  Development ▸ Import plugin from manifest…** and choose `manifest.json` in that folder (Typeshelf
  shows it). The copy carries a secret token (`figma-token` in the data folder, written into
  `ui.html`); removing the plugin deletes the token, installing again makes a new one.
- Illustrator, After Effects and InDesign only load unsigned CEP extensions in debug mode. When the bundled
  extension has no signature (`META-INF/signatures.xml`), installing it sets `PlayerDebugMode` to `1`
  for CSXS 9 to 13 where it was off, and removing the last Typeshelf extension removes the keys
  Typeshelf set (recorded in `plugins.json` in the app's data folder).
- An application that is open loads a newly installed plugin after a restart.
- Hidden files such as `.debug` are not copied.

## Installing for development

### Photoshop

1. Install **UXP Developer Tool** from the Creative Cloud app.
2. *Add Plugin*, choose `plugins/photoshop/manifest.json`, then *Load*.
3. The panel is in **Plugins ▸ Typeshelf**.

To distribute it, *Package* in UXP Developer Tool produces a `.ccx` that installs with a double-click.

### Illustrator, After Effects and InDesign

Unsigned CEP extensions only load in debug mode:

```bash
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```

```bash
ln -s "$PWD/plugins/illustrator" ~/Library/Application\ Support/Adobe/CEP/extensions/typeshelf
```

```bash
ln -s "$PWD/plugins/after-effects" ~/Library/Application\ Support/Adobe/CEP/extensions/typeshelf-aftereffects
```

```bash
ln -s "$PWD/plugins/indesign" ~/Library/Application\ Support/Adobe/CEP/extensions/typeshelf-indesign
```

Restart the application: **Window ▸ Extensions ▸ Typeshelf**. The extension also loads in the
background at startup, to check documents even when the panel is closed.
To distribute it without debug mode, it must be signed with `ZXPSignCmd`.

In debug mode, the `.debug` file opens the panel's developer tools at
`http://localhost:8088` (Illustrator), `http://localhost:8089` (After Effects) or `http://localhost:8090` (InDesign). It is only
meant for development.

### Sketch

```bash
ln -s "$PWD/plugins/sketch/Typeshelf.sketchplugin" ~/Library/Application\ Support/com.bohemiancoding.sketch3/Plugins/
```

(or double-click `Typeshelf.sketchplugin`, which copies it). Without a webview library, Sketch has
no permanent panel: the plugin acts on its own when a document opens and answers with a message at
the bottom of the window. **Plugins ▸ Typeshelf** offers *Activate Missing Fonts* and *Settings…*
(automatic activation, Google Fonts, duration).

### Figma

Installing from Typeshelf is the simplest way, because it writes the token the panel needs. By hand,
run `npm run plugins:sync`, replace `__TYPESHELF_TOKEN__` in a copy of `figma/ui.html` with the
content of `figma-token` in Typeshelf's data folder, and import that copy's `manifest.json` in Figma
(**Plugins ▸ Development ▸ Import plugin from manifest…**). The panel is in **Plugins ▸ Development ▸ Typeshelf**.

## Local API

Typeshelf listens on `http://localhost:47391` (it can be turned off in Settings ▸ Plugins).

```http
GET  /v1/status
POST /v1/fonts/status      { "fonts": [...] }  → available? in the library? (read-only)
POST /v1/fonts/activate
X-Typeshelf-Client: Photoshop
Content-Type: application/json

{ "fonts": ["Lora-Bold", "ClientBrand-Black"], "scope": "temporary", "google": true }
```

Answer: `{ "results": [{ "name", "status", "family?", "source?", "message?" }] }` where `status` is one
of `system` (installed on the system), `active` (already active), `activated` (activated by this
request, `source` = `library` or `google`), `missing`, `error`. `scope` is `temporary` (until
Typeshelf quits, the default) or `persistent`.

Figma's panel uses the same three calls under `/v1/figma/…` (`status`, `fonts/status`,
`fonts/activate`): its iframe has no origin (`Origin: null`), so these routes answer the CORS preflight
for that origin only, and every other request must carry `X-Typeshelf-Token`, the token written into
the installed plugin. Wrong or missing token: `401`.

Safeguards: it listens on the loopback interface only (`127.0.0.1` and `[::1]`); the `Host` header
must be `127.0.0.1:47391`, `localhost:47391` or `[::1]:47391` (against DNS rebinding); any request
carrying a web `Origin` is refused; activation requires the `X-Typeshelf-Client` header, which a
browser only sends after a CORS preflight that Typeshelf always refuses.

## Known limits

- Illustrator (tried in Illustrator 2026): its scripting API throws an error (`GFKU`) when reading
  the font of a text whose font is missing, and adds a fake record carrying its name to
  `app.textFonts`. The panel therefore reads the font list from the file's XMP metadata
  (`xmpTPg:Fonts`), completed with the font of each readable text frame, and asks Typeshelf
  (`/v1/fonts/status`, CoreText on macOS) which ones are really available. The metadata dates from
  the last save, which is the right moment, since fonts are missing when a file opens.
- Photoshop (tried in Photoshop 2026): the manifest's network permission only works with a host
  name without a port (`http://localhost`), not with `127.0.0.1`; Typeshelf therefore also listens
  on `[::1]`. `loadEvent: "startup"` loads the plugin when Photoshop launches, with the panel
  closed. Photoshop keeps a deactivated font in `app.fonts`: the panel lets Typeshelf decide.
- Photoshop without UXP Developer Tool: the plugin can be registered in
  `~/Library/Application Support/Adobe/UXP/PluginsInfo/v1/PS.json` (with Photoshop closed), with a
  link to this folder in `…/UXP/Plugins/External/`. Photoshop only reloads it on restart.
- A font missing from the library is only found on Google Fonts if the start of its PostScript
  name matches the family name (`PlayfairDisplay-Bold` finds "Playfair Display").
- After Effects (tried in After Effects 2026): it sends CEP no event when a project opens; the
  panel therefore watches the project file every 2 s. `project.usedFonts` (24.5 and later) gives
  the fonts and `isSubstitute` the missing ones; before 24.5, the panel reads the font of each
  text layer and Typeshelf decides. Once the font is activated, After Effects puts the real one back
  in place of its substitute by itself (within a few seconds) and marks the project as modified.
- Sketch (tried in Sketch 2026.1): a missing font that is not embedded in the file is replaced in
  memory by a system font, and only the document data keeps its name (`fontNames`, outside the
  documented API; failing that, the plugin reads the fonts of the text). Fonts embedded in the file
  are loaded by Sketch and are not missing. Sketch does not redraw a text with a font activated
  after opening: the plugin therefore reopens the document, only if it has no unsaved changes
  (Sketch saves when closing), at most once a minute. Otherwise it asks to reopen it. Never call
  `replaceMissingFontsIfNecessary`: it permanently replaces the missing font.
- InDesign: written from the scripting reference and not tried in InDesign (it was not installed
  where the plugin was written). `Document.fonts` lists every font of the document with a
  `FontStatus` (installed, not available, substituted), which gives the missing ones directly. The panel
  watches the active document every 2 s instead of relying on CEP events.
- Figma: written from Figma's documentation and not tried in Figma. The plugin reads the fonts of the
  current page (`getStyledTextSegments`, up to 5000 text nodes) and compares them with
  `figma.listAvailableFontsAsync()`. Figma gives a family and a style, not a PostScript name, so the
  panel sends `Family-Style` without spaces (`Playfair Display` + `Bold Italic` →
  `PlayfairDisplay-BoldItalic`), which matches most fonts. Figma reads the font list when it starts:
  after Typeshelf activates a font, restart Figma (or reload fonts) before it can use it. Network access
  to `localhost` is only granted to plugins imported from a manifest (`devAllowedDomains`), not to
  published ones, which is why the plugin is not on the Figma Community.
