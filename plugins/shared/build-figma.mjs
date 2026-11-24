// Builds plugins/figma/ui.html: Figma loads a single HTML file for the panel, so the shared panel
// (panel-core.js, panel.css) and the Figma adapter (figma-host.js) are inlined. Run by `npm run plugins:sync`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const shared = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(shared, name), "utf8");
const parts = { PANEL_CSS: read("panel.css"), PANEL_CORE: read("panel-core.js"), HOST: read("figma-host.js") };
for (const [name, text] of Object.entries(parts)) {
  if (/<\/(script|style)/i.test(text)) throw new Error(`${name} contains a closing tag and cannot be inlined`);
}
let html = read("figma-ui.template.html");
for (const [name, text] of Object.entries(parts)) html = html.replace(`/*${name}*/`, () => text);
writeFileSync(join(shared, "../figma/ui.html"), html);
