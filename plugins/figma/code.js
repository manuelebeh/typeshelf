/*
 * Typeshelf for Figma. This side runs in Figma's sandbox: it reads the fonts of the current page
 * and hands them to the panel (ui.html), which is the only part allowed to reach the network.
 */
figma.showUI(__html__, { width: 300, height: 400, themeColors: true });

const MAX_TEXT_NODES = 5000;

/** "Playfair Display" + "Bold Italic" → "PlayfairDisplay-BoldItalic", the PostScript name by convention. */
function postScriptGuess(font) {
  const squash = (s) => String(s).replace(/\s+/g, "");
  return squash(font.family) + "-" + squash(font.style || "Regular");
}

async function scan() {
  try {
    const page = figma.currentPage;
    await page.loadAsync();
    const used = new Map();
    const nodes = page.findAllWithCriteria({ types: ["TEXT"] }).slice(0, MAX_TEXT_NODES);
    for (const node of nodes) {
      let segments = [];
      try {
        segments = node.getStyledTextSegments(["fontName"]);
      } catch (e) {
        continue; // unreadable text node
      }
      for (const segment of segments) {
        const font = segment.fontName;
        if (font && font.family) used.set(font.family + "\u0000" + font.style, font);
      }
    }
    const available = new Set();
    for (const f of await figma.listAvailableFontsAsync()) available.add(f.fontName.family + "\u0000" + f.fontName.style);
    figma.ui.postMessage({
      type: "fonts",
      name: figma.root.name + " · " + page.name,
      fonts: [...used.entries()].map(([key, font]) => ({
        name: postScriptGuess(font),
        label: font.family + " " + font.style,
        installed: available.has(key),
      })),
    });
  } catch (e) {
    figma.ui.postMessage({ type: "error", message: String(e && e.message ? e.message : e) });
  }
}

figma.ui.onmessage = (message) => {
  if (message && message.type === "scan") scan();
};

// A page change is the closest thing to "a document was brought forward".
figma.on("currentpagechange", () => figma.ui.postMessage({ type: "changed" }));
