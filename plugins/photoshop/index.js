/*
 * Typeshelf for Photoshop (UXP). Lists the fonts used by the text layers of the active
 * document and asks Typeshelf, running on this computer, to activate the missing ones. It also
 * applies a font chosen in Typeshelf to the selected text layers, and sends their text there.
 */
const { app, action, constants, core } = require("photoshop");
const createPanel = require("./panel-core.js");

// Photoshop only allows host names declared in the manifest ("http://localhost"), not IPs.
const BASE = "http://localhost:47391";

function withTimeout(promise, ms) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(createPanel.t("Typeshelf is not responding"))), ms);
  });
  // Cleared: the panel polls every second, and long timers would pile up.
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function call(method, path, body) {
  let res;
  try {
    res = await withTimeout(
      fetch(BASE + path, {
        method,
        headers: { "Content-Type": "application/json", "X-Typeshelf-Client": "Photoshop" },
        body: body ? JSON.stringify(body) : undefined,
      }),
      // Downloads from Google Fonts can take a while.
      method === "GET" ? 3000 : 120000,
    );
  } catch (e) {
    throw new Error(`${createPanel.t("Typeshelf is not open or does not accept plugins.")} (${e && e.message ? e.message : e})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || createPanel.t("Error {status}", { status: res.status }));
  return data;
}

function textLayers(layers, out = []) {
  for (const layer of layers) {
    if (layer.layers && layer.layers.length) textLayers(layer.layers, out);
    if (layer.kind === constants.LayerKind.TEXT) out.push(layer);
  }
  return out;
}

/** PostScript names of every font run in the document's text layers. */
async function usedFonts(doc) {
  const layers = textLayers(doc.layers);
  if (!layers.length) return [];
  const descriptors = await action.batchPlay(
    layers.map((layer) => ({
      _obj: "get",
      _target: [{ _property: "textKey" }, { _ref: "layer", _id: layer.id }, { _ref: "document", _id: doc.id }],
    })),
    {},
  );
  const names = new Set();
  for (const d of descriptors) {
    const ranges = (d && d.textKey && d.textKey.textStyleRange) || [];
    for (const r of ranges) {
      const name = r.textStyle && r.textStyle.fontPostScriptName;
      if (name) names.add(name);
    }
  }
  return [...names];
}

/**
 * PostScript names of the fonts Photoshop lists. Read in one call: going through `app.fonts` takes
 * several seconds with a thousand fonts, during which the panel cannot answer Typeshelf.
 */
async function installedFonts() {
  const [result] = await action.batchPlay(
    [{ _obj: "get", _target: [{ _property: "fontList" }, { _ref: "application", _enum: "ordinal", _value: "targetEnum" }] }],
    {},
  );
  return new Set(result.fontList.fontPostScriptName);
}

/** The text layers selected in the Layers panel; or why there are none. */
function selectedText() {
  if (!app.documents.length) return { error: "no_document" };
  const doc = app.activeDocument;
  const layers = Array.from(doc.activeLayers).filter((layer) => layer.kind === constants.LayerKind.TEXT);
  return layers.length ? { doc, layers } : { error: "no_selection" };
}

/** `#rrggbb`, or null for a colour Photoshop cannot express that way. */
function hexColor(color) {
  try {
    return `#${color.rgb.hexValue}`;
  } catch (e) {
    return null;
  }
}

const host = {
  name: "Photoshop",
  call,
  async documentFonts() {
    const doc = app.activeDocument;
    if (!doc) return null;
    const used = await usedFonts(doc);
    const installed = await installedFonts();
    // Photoshop keeps deactivated fonts in app.fonts: a listed font may still be missing.
    return {
      name: doc.title,
      fonts: used.map((name) => (installed.has(name) ? { name, installed: null, appLists: true } : { name, installed: false })),
    };
  },
  async selection() {
    const { error, layers } = selectedText();
    if (error) return { error };
    const item = layers[0].textItem;
    const style = item.characterStyle;
    return {
      text: item.contents,
      font: style.font,
      size: style.size,
      color: hexColor(style.color),
      tracking: style.tracking,
      count: layers.length,
    };
  },
  /** Sets the font of whole layers, as a single history step. */
  async applyFont(name) {
    const { error, doc, layers } = selectedText();
    if (error) return { error };
    if (!(await installedFonts()).has(name)) return { retry: true };
    let refused = false;
    await core.executeAsModal(
      async (context) => {
        const history = await context.hostControl.suspendHistory({ documentID: doc.id, name: "Typeshelf" });
        for (const layer of layers) {
          const style = layer.textItem.characterStyle;
          style.font = name;
          // Photoshop ignores some of the fonts it lists, without an error.
          if (style.font !== name) refused = true;
        }
        // false: puts the layers back as they were.
        await context.hostControl.resumeHistory(history, !refused);
      },
      { commandName: "Typeshelf" },
    );
    return refused ? { error: "font_refused" } : { count: layers.length };
  },
  onDocumentChange(cb) {
    action.addNotificationListener(["open", "select"], (event, descriptor) => {
      // "select" also fires for layers and tools: only react to documents.
      const target = descriptor && descriptor._target && descriptor._target[0];
      if (event === "open" || (target && target._ref === "document")) cb();
    });
  },
};

createPanel(host, document.getElementById("app"));
