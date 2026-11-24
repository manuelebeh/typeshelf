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
| `sketch/`        | Sketch (tried in 2026.1)          | Sketch plugin (JavaScript)    |
| `shared/`        | Common panel (`panel-core.js`, `panel.css`), CEP plumbing (`cep.js`) and a preview page | - |

`panel-core.js` and `panel.css` (and `cep.js` for the CEP plugins) are copied into each folder, because
every plugin must be self-contained: after changing `shared/`, run `npm run plugins:sync`.
`npm run dev`, then open `/plugins/shared/preview.html` to see the panel with sample data.

## Installing for development

### Photoshop

1. Install **UXP Developer Tool** from the Creative Cloud app.
2. *Add Plugin*, choose `plugins/photoshop/manifest.json`, then *Load*.
3. The panel is in **Plugins ▸ Typeshelf**.

To distribute it, *Package* in UXP Developer Tool produces a `.ccx` that installs with a double-click.

### Illustrator and After Effects

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

Restart the application: **Window ▸ Extensions ▸ Typeshelf**. The extension also loads in the
background at startup, to check documents even when the panel is closed.
To distribute it without debug mode, it must be signed with `ZXPSignCmd`.

In debug mode, the `.debug` file opens the panel's developer tools at
`http://localhost:8088` (Illustrator) or `http://localhost:8089` (After Effects). It is only
meant for development.

### Sketch

```bash
ln -s "$PWD/plugins/sketch/Typeshelf.sketchplugin" ~/Library/Application\ Support/com.bohemiancoding.sketch3/Plugins/
```

(or double-click `Typeshelf.sketchplugin`, which copies it). Without a webview library, Sketch has
no permanent panel: the plugin acts on its own when a document opens and answers with a message at
the bottom of the window. **Plugins ▸ Typeshelf** offers *Activate Missing Fonts* and *Settings…*
(automatic activation, Google Fonts, duration).

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
- InDesign is not covered yet.
